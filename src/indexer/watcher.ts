import path from 'path';
import { Store } from '../db/store.js';
import { Indexer } from './index.js';

/**
 * Background file watcher that keeps the index warm.
 *
 * Design split:
 *   - Watcher (this module) reacts to file events and marks files dirty in a
 *     shared in-memory set. Debounces bursts so a `git checkout` doesn't
 *     hammer the indexer.
 *   - JIT sync ([./freshness.ts]) does the actual correctness work — when an
 *     MCP query comes in, it consults the dirty set + on-disk hashes and
 *     reindexes just what needs it.
 *
 * Why both? The watcher alone is racy (filesystem events on Windows arrive
 * out of order, can be missed under load) and the JIT alone is slow on
 * burst-y workloads (every query re-walks the workspace). Together the
 * watcher absorbs steady-state edits so most JIT runs are no-ops, while JIT
 * provides the per-query correctness guarantee.
 *
 * We use chokidar because it abstracts the OS-level oddities (FSEvents on
 * macOS, ReadDirectoryChangesW on Windows, inotify on Linux) and provides
 * a uniform API. It's the same library Aider uses for its watch mode.
 */

import chokidar, { FSWatcher } from 'chokidar';

export interface WatcherOptions {
  /** Debounce window in ms before triggering a reindex pass. Default 250ms. */
  debounceMs?: number;
  /** Logger; default writes to stderr (so stdio MCP isn't polluted). */
  log?: (msg: string) => void;
  /**
   * Skip these paths. Defaults match the indexer's ignore list — we don't
   * want chokidar to fire on `node_modules/` updates that the index would
   * skip anyway. The list is intentionally narrower than the full glob; the
   * indexer's `discoverFiles()` re-applies all rules at reindex time.
   */
  ignored?: (string | RegExp)[];
}

export class StrataWatcher {
  private watcher: FSWatcher | null = null;
  private dirty = new Set<string>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private indexing = false;
  private indexingQueue = false;
  private lastSyncMs: number = 0;
  private lastSyncResult: { dirtyReindexed: number; added: number; removed: number; elapsedMs: number } | null = null;
  private logFn: (msg: string) => void;
  private debounceMs: number;

  constructor(
    private repoRoot: string,
    private store: Store,
    private indexer: Indexer,
    options: WatcherOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 250;
    this.logFn = options.log ?? ((m) => process.stderr.write(`[watcher] ${m}\n`));
  }

  /**
   * Start watching. Idempotent: calling twice is a no-op.
   */
  start(): void {
    if (this.watcher) return;
    const abs = path.resolve(this.repoRoot);
    this.watcher = chokidar.watch(abs, {
      ignored: [
        // chokidar accepts globs and functions. We use simple substring tests
        // because the chokidar glob engine is finicky on Windows paths.
        (p: string) => {
          const norm = p.replace(/\\/g, '/');
          return (
            norm.includes('/node_modules/') ||
            norm.includes('/.git/') ||
            norm.includes('/dist/') ||
            norm.includes('/build/') ||
            norm.includes('/.strata/') ||
            norm.includes('/target/') ||
            norm.includes('/obj/')
          );
        },
      ],
      persistent: true,
      ignoreInitial: true,  // Don't fire for files that already exist
      awaitWriteFinish: {
        // Some editors write through a tmp + rename dance. Wait for the file
        // to stop growing before considering it changed.
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    const onChange = (filePath: string): void => {
      this.dirty.add(filePath);
      this.scheduleSync();
    };
    this.watcher.on('add', onChange);
    this.watcher.on('change', onChange);
    this.watcher.on('unlink', onChange);
    this.watcher.on('error', (err: unknown) => this.logFn(`error: ${err}`));
    this.logFn(`watching ${abs}`);
  }

  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /** Whether anything is currently waiting to be reindexed. */
  isDirty(): boolean {
    return this.dirty.size > 0 || this.indexing || this.indexingQueue;
  }

  dirtyCount(): number { return this.dirty.size; }

  /**
   * Snapshot for `strata_health`: when did we last reconcile, how many files,
   * how long did it take. Lets agents tell whether the index they're querying
   * is "this happened just now" vs "we haven't run in 10 minutes."
   */
  syncStatus(): {
    watching: boolean;
    dirtyCount: number;
    indexing: boolean;
    lastSyncMs: number;
    lastSync: { dirtyReindexed: number; added: number; removed: number; elapsedMs: number } | null;
  } {
    return {
      watching: this.watcher !== null,
      dirtyCount: this.dirty.size,
      indexing: this.indexing,
      lastSyncMs: this.lastSyncMs,
      lastSync: this.lastSyncResult,
    };
  }

  /**
   * Force an immediate sync, bypassing the debounce. Used by `strata_reindex`
   * and JIT — both need the dirty set drained NOW, not when a timer fires.
   */
  async syncNow(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    await this.runSync();
  }

  private scheduleSync(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      // Fire-and-forget — uncaught rejection would just kill the process.
      // Errors are reported through the log function.
      this.runSync().catch(err => this.logFn(`sync failed: ${err.message ?? err}`));
    }, this.debounceMs);
  }

  /**
   * Reindex the workspace. Serialized — if a sync is already running, we
   * queue at most one follow-up and coalesce further requests into it. This
   * matches the indexer's contract that only one writer can be active.
   */
  private async runSync(): Promise<void> {
    if (this.indexing) {
      this.indexingQueue = true;
      return;
    }
    this.indexing = true;
    try {
      const dirtyCount = this.dirty.size;
      // Clear the dirty set BEFORE running the index so any events arriving
      // during the index are caught for the next pass instead of being lost.
      this.dirty.clear();
      const start = Date.now();
      const result = await this.indexer.indexDirectory(this.repoRoot, { quiet: true });
      this.lastSyncMs = Date.now();
      this.lastSyncResult = {
        dirtyReindexed: dirtyCount,
        added: result.filesIndexed,
        removed: 0, // indexer doesn't expose pruned count; OK for now
        elapsedMs: result.elapsedMs,
      };
      this.logFn(
        `sync: ${dirtyCount} dirty event(s), ${result.filesIndexed} reindexed, ` +
        `${result.filesReusedFromCache} reused, ${result.elapsedMs}ms`,
      );
    } finally {
      this.indexing = false;
      if (this.indexingQueue) {
        this.indexingQueue = false;
        this.runSync().catch(err => this.logFn(`requeued sync failed: ${err.message ?? err}`));
      }
    }
  }
}
