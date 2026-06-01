import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { discoverFiles, DiscoveredFile, DiscoveryMode } from './discovery.js';
import { parseFile, detectLanguage, wasmResetCount } from '../parser/index.js';
import { WorkerPool, WorkItem as PoolWorkItem, PoolResult } from '../parser/workerpool.js';
import { computePageRank } from '../graph/pagerank.js';
import { Store } from '../db/store.js';
import { classifyFile } from './classify.js';
import { buildModules } from './modules.js';
import { buildBoundaries } from './boundaries.js';
import { buildShapeHashes } from './shapehash.js';
import { normalizeHttpTarget, resolveServiceLinks } from './serviceLinks.js';
import { scanProtoFiles } from './protoScanner.js';
import { scanServiceHosts } from './serviceHostScanner.js';
import type { Language, FileExtraction } from '../types.js';

export interface IndexOptions {
  verbose?: boolean;
  reset?: boolean;
  /**
   * When true, suppress all progress / post-processing chatter to stdout.
   * `verbose` still wins if both are set. Useful for the scale-test runner
   * which prints its own one-line-per-codebase summary.
   */
  quiet?: boolean;
  /**
   * Skip files larger than this many bytes. Default is 0 (no cap) — we'd
   * rather index everything than create silent holes in the graph by
   * skipping hand-crafted files just because they're large. The combination
   * of `setTimeoutMicros(10s)` per parse + automatic WASM-runtime reset on
   * failure means a pathological file degrades to "this file is missing"
   * instead of "the indexer crashed."
   *
   * Setting a positive cap is purely an optimization for indexing speed in
   * codebases where you know certain files are huge generated boilerplate
   * (Vulkan headers, protobuf output, etc.) — those usually live in a
   * `thirdparty/` or `Generated/` dir which we already skip by default.
   */
  maxFileBytes?: number;
  /**
   * Max number of concurrent file reads issued by the async prefetcher.
   * Defaults to 8. Each in-flight read holds an open file descriptor and the
   * file's bytes in memory until the parser consumes it; the byte cap below
   * is the real safety net, this just protects against FD exhaustion.
   */
  ioConcurrency?: number;
  /**
   * Hard upper bound on total bytes held in the prefetch buffer at any time.
   * Defaults to 64 MiB. If a single file is larger than the cap it is still
   * read (we always allow at least one in-flight read so progress never
   * stalls) — the cap only governs how many *additional* prefetches we may
   * launch while bytes are outstanding.
   */
  ioPrefetchBytes?: number;
  /**
   * Include vendored directories (`vendor/`, `vendored/`, `thirdparty/`, …)
   * in discovery and indexing. By default these are skipped at discovery
   * time AND tagged as `role='vendor'` if they leak through, so they don't
   * dominate ranking. The flag exists for "I really do want to query into
   * vendored code" workflows.
   */
  includeVendor?: boolean;
  /**
   * Include generated files (`*.pb.*`, `*.generated.*`, `*.gen.*`, …) in
   * discovery and indexing. Off by default for the same reason as
   * `includeVendor`.
   */
  includeGenerated?: boolean;
  /**
   * Discovery aggressiveness. `'full'` indexes everything we can parse
   * (implicitly includes vendor + generated), `'standard'` (default) keeps
   * vendor/generated out by default, and `'fast'` adds docs/examples/static
   * skips on top of standard. See `DiscoveryMode` for the rationale.
   */
  mode?: DiscoveryMode;
  /**
   * Parse files in a pool of worker_threads instead of inline. Each worker
   * owns its own WASM heap so heavy parsing parallelizes across CPU cores.
   * DB writes still happen on the main thread in the same insertion order
   * as the serial path — symbol IDs stay deterministic.
   *
   * Default: on for normal/large workspaces, serial for tiny workspaces where
   * worker startup/teardown costs more than it saves. Set
   * `SEER_PARALLEL_PARSE=0` or pass `parallel:false` to force the serial
   * fallback. Pass `parallel:true` to force workers even below the tiny-repo
   * threshold (the parity tests do this). Scale parity verified the worker
   * path against representative large repos with row-identical DB output.
   */
  parallel?: boolean;
  /**
   * Worker thread count when `parallel` is on. Defaults to
   * `min(8, max(1, availableParallelism()-1))`.
   */
  jobs?: number;
}

const DEFAULT_MAX_FILE_BYTES = 0;       // no cap by default — completeness first
const DEFAULT_IO_CONCURRENCY = 8;       // matches the file-handle budget on most OSes comfortably
const DEFAULT_IO_PREFETCH_BYTES = 64 * 1024 * 1024; // 64 MiB
const PARALLEL_AUTO_MIN_FILES = 100;    // below this, default to serial unless explicitly forced

// Filenames that are almost always generated boilerplate (Unreal Header Tool
// produces *.generated.h; protobufs produce *.pb.h / *.pb.cc; etc.). We skip
// them at the per-file level so the discovery glob can stay simple.
const SKIP_FILENAME_PATTERNS = [
  /\.generated\.h$/i,
  /\.gen\.cpp$/i,
  /\.gen\.h$/i,
  /\.pb\.cc$/,
  /\.pb\.h$/,
];

function shouldSkipFilename(relativePath: string, includeGenerated: boolean): boolean {
  return !includeGenerated && SKIP_FILENAME_PATTERNS.some(re => re.test(relativePath));
}

export interface IndexResult {
  filesDiscovered: number;
  filesIndexed: number;
  /**
   * Files whose content hash matched the existing index row — we kept their
   * symbols/edges/imports and skipped reparsing entirely. This is the single
   * biggest win on a re-index: parse cost goes to ~0 for unchanged files.
   */
  filesReusedFromCache: number;
  filesSkipped: number;
  filesSkippedTooLarge: number;
  filesParseError: number;
  wasmResets: number;
  symbols: number;
  edges: number;
  resolvedEdges: number;
  resolvedImports: number;
  edgeResolution: {
    sameFile: number;
    imported: number;
    global: number;
  };
  /**
   * True when the post-pass actually recomputed PageRank this run. False when
   * the resolved edge graph was unchanged (every file came from cache, nothing
   * was pruned, no new edge or import resolutions happened) — in that case
   * every stored PageRank value is still correct and we kept it as-is. This
   * is the "Lazy PageRank" optimization; the predicate lives at the bottom of
   * `indexDirectory()`.
   */
  pagerankRecomputed: boolean;
  /** Routes whose handler symbol id was filled in this run. */
  routesResolved?: number;
  /** Config-key rows whose enclosing symbol id was filled in this run. */
  configKeysResolved?: number;
  /** Tests edges synthesized this run. */
  testEdgesAdded?: number;
  /** External dependency rows in the DB after this run. */
  externalDependencies?: number;
  /** Number of modules in the clustering after this run (0 if not built). */
  modules?: number;
  /** True when module clustering was recomputed this run. */
  modulesRecomputed?: boolean;
  /** Number of new shape hashes computed this run (Track-F SimHash pass). */
  shapeHashesAdded?: number;
  /** v8 Track-G — service_links rows produced by the resolver this run. */
  serviceLinks?: number;
  /** v8 Track-G — service_link counts grouped by match_kind. */
  serviceLinksByKind?: Record<string, number>;
  elapsedMs: number;
}

// ── Async prefetch types ────────────────────────────────────────────────────────

/**
 * A file in the work queue, paired with its language. We pre-filter the
 * DiscoveredFile list once up-front: anything without a language match or
 * matching a SKIP_FILENAME_PATTERN never enters the prefetcher — those are
 * counted as plain `skipped` and the I/O budget isn't spent on them.
 */
interface WorkItem {
  file: DiscoveredFile;
  language: Language;
}

/** Result of a prefetch task: either ready-to-process content, or a skip reason. */
type PrefetchResult =
  | { kind: 'ok'; item: WorkItem; content: string; size: number }
  | { kind: 'too-large'; item: WorkItem; size: number }
  | { kind: 'io-error'; item: WorkItem };

// ── Byte-aware semaphore ────────────────────────────────────────────────────────
//
// Caps total bytes of file content held in the prefetch buffer. A waiter is
// admitted as soon as either (a) the new total fits within `capacity`, or
// (b) the budget is empty (so a single oversize file never deadlocks — we
// always allow at least one read in flight).
//
// The implementation is deliberately FIFO: we only wake the *head* waiter, so
// a flood of small reads can't perpetually starve a single large one queued
// behind them.

class ByteSemaphore {
  private bytes = 0;
  private readonly waiters: Array<{ bytes: number; resolve: () => void }> = [];

  constructor(private readonly capacity: number) {}

  async acquire(requested: number): Promise<void> {
    if (this.bytes === 0 || this.bytes + requested <= this.capacity) {
      this.bytes += requested;
      return;
    }
    await new Promise<void>(resolve => {
      this.waiters.push({ bytes: requested, resolve });
    });
    // `release` has already added `requested` to `this.bytes` on our behalf
    // before resolving — see `release()` below.
  }

  release(returned: number): void {
    this.bytes -= returned;
    if (this.bytes < 0) this.bytes = 0; // defensive: never go negative
    while (this.waiters.length > 0) {
      const next = this.waiters[0];
      if (this.bytes === 0 || this.bytes + next.bytes <= this.capacity) {
        this.bytes += next.bytes;
        this.waiters.shift();
        next.resolve();
      } else {
        break;
      }
    }
  }
}

export class Indexer {
  constructor(private store: Store) {}

  /**
   * Serializes index passes. The MCP server shares ONE Indexer (and one
   * SQLite connection) between the background watcher and the per-query JIT
   * freshness pass. If those two ever ran `indexDirectory` concurrently they
   * would interleave `BEGIN`/`COMMIT` on the same connection — node:sqlite
   * would throw "cannot start a transaction within a transaction", or worse,
   * one pass would commit the other's half-written batch. We funnel every
   * call through this promise chain so at most one index pass is ever in
   * flight; the second caller simply awaits the first, then runs.
   */
  private indexChain: Promise<unknown> = Promise.resolve();

  async indexDirectory(
    repoRoot: string,
    options: IndexOptions = {},
  ): Promise<IndexResult> {
    // Queue behind any in-flight pass (ignoring its outcome — each pass is
    // independent and reports its own errors), then become the in-flight pass.
    const run = this.indexChain
      .catch(() => { /* prior pass's failure is its own caller's problem */ })
      .then(() => this.indexDirectoryImpl(repoRoot, options));
    // Keep the chain alive even if this run rejects, so a failure doesn't wedge
    // every future pass.
    this.indexChain = run.catch(() => { /* swallow for the chain only */ });
    return run;
  }

  private async indexDirectoryImpl(
    repoRoot: string,
    options: IndexOptions = {},
  ): Promise<IndexResult> {
    const start = Date.now();
    const absRoot = path.resolve(repoRoot);

    const quiet = options.quiet && !options.verbose;

    if (options.verbose) {
      process.stdout.write(`\nDiscovering files in ${absRoot}...\n`);
    }

    const files = await discoverFiles(absRoot, {
      includeVendor: options.includeVendor,
      includeGenerated: options.includeGenerated,
      mode: options.mode,
    });
    const includeGenerated = options.includeGenerated ?? (options.mode === 'full');
    const total = files.length;
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const ioConcurrency = Math.max(1, options.ioConcurrency ?? DEFAULT_IO_CONCURRENCY);
    const ioPrefetchBytes = Math.max(1, options.ioPrefetchBytes ?? DEFAULT_IO_PREFETCH_BYTES);

    // Track every file_id we touch this run so we can prune ones left over
    // from a previous run (e.g. files now hidden by a new ignore rule).
    const touchedFileIds = new Set<number>();
    let indexed = 0;
    let reusedFromCache = 0;
    let skipped = 0;
    let skippedTooLarge = 0;
    let parseErrors = 0;
    let workerWasmResets = 0;

    // ── Pre-filter into a work queue ────────────────────────────────────────────
    // Pure CPU work (string ops on the path). Cheap to do all at once so the
    // async prefetcher's index space matches up cleanly with progress counters.
    const work: WorkItem[] = [];
    for (const file of files) {
      const language = detectLanguage(file.absolutePath) as Language | null;
      if (!language || shouldSkipFilename(file.relativePath, includeGenerated)) {
        skipped++;
        continue;
      }
      work.push({ file, language });
    }

    // Existing pre-v8 DBs can have all source hashes cached but no
    // service_calls rows yet. Force one full parse pass so Track-G evidence is
    // backfilled, then mark completion in finishIndex().
    const forceServiceCallBackfill = this.store.needsServiceCallBackfill();

    // ── Batched transactions ──────────────────────────────────────────────────
    // The Phase-1 design wrapped each file's inserts in its own SQLite
    // transaction. That works but every commit fsyncs the WAL, which adds
    // O(milliseconds) of overhead per file. For 40k+ file repos the commit
    // overhead dominates the per-file budget. Batching N files per transaction
    // amortizes the fsync cost N-fold.
    //
    // Trade-off: a fatal error mid-batch rolls back at most BATCH_SIZE files'
    // worth of inserts (which we'd just re-do on the next run). We never lose
    // user data — only re-do work — so a moderately large batch is safe.
    //
    // The hash-skip path participates in the batch too (its UPDATE indexed_at
    // and DELETE-old-symbols statements were previously running as
    // autocommitted singletons — now they share a transaction with the file's
    // inserts).
    const BATCH_SIZE = 200;
    let batchOpen = false;
    const openBatch = (): void => {
      if (!batchOpen) {
        this.store.begin();
        batchOpen = true;
      }
    };
    const closeBatch = (): void => {
      if (batchOpen) {
        this.store.commit();
        batchOpen = false;
      }
    };
    const rollbackBatch = (): void => {
      if (batchOpen) {
        try { this.store.rollback(); } catch { /* best effort */ }
        batchOpen = false;
      }
    };

    if (!options.verbose && !quiet) {
      writeProgress(0, total, '');
    }

    // ── Parallel-parsing branch (worker pool) ───────────────────────────────────
    //
    // When enabled, each file's read + hash + parse runs in a worker_threads
    // worker (its own WASM heap). The pool delivers results to the callback
    // STRICTLY in input order, so symbol-id insertion order — and therefore
    // every cross-run-stable scale-test invariant — is identical to the
    // serial path. DB writes still run single-writer on the main thread.
    //
    // Result-kind contract (matches the serial branch's semantics exactly):
    //   parsed     → upsertFileWithCache → touchedFileIds.add → insert all
    //   parse-error → upsertFileWithCache → touchedFileIds.add → no inserts
    //   cached     → upsertFileWithCache → touchedFileIds.add → no inserts
    //                  (worker confirmed hash === expectedHash; upsert sees
    //                   the same hash and returns unchanged=true)
    //   too-large  → counter only; file row NOT touched → pruned
    //   io-error   → counter only; file row NOT touched → pruned
    //
    // The cached/parse-error upsert calls are CRITICAL: without them
    // `touchedFileIds` would not contain those file ids and
    // `pruneFilesNotIn(touchedFileIds)` below would delete every unchanged
    // cached file from the DB.
    // Auto-enabled for normal/large workspaces. Tiny workspaces stay serial by
    // default to avoid worker startup/churn; force workers with `parallel: true`
    // or `SEER_PARALLEL_PARSE=1`. Opt out with `parallel: false` or
    // `SEER_PARALLEL_PARSE=0`.
    const envParallel: boolean | undefined =
      typeof process !== 'undefined' && process.env != null
        ? (process.env.SEER_PARALLEL_PARSE === '0' ? false
          : process.env.SEER_PARALLEL_PARSE === '1' ? true
          : undefined)
        : undefined;
    const parallelRequested = options.parallel ?? envParallel ?? true;
    const parallelForced = options.parallel === true || envParallel === true;
    const parallelEnabled =
      parallelRequested && (parallelForced || work.length >= PARALLEL_AUTO_MIN_FILES);

    if (parallelEnabled && work.length > 0) {
      // Snapshot known DB hashes so workers can skip parsing on cache hits.
      const cacheMap = new Map<string, string>();
      for (const f of this.store.listFiles()) cacheMap.set(f.path, f.hash);

      const poolItems: PoolWorkItem[] = work.map(w => ({
        abs: w.file.absolutePath,
        lang: w.language,
        expectedHash: forceServiceCallBackfill ? null : cacheMap.get(w.file.absolutePath) ?? null,
        maxFileBytes,
      }));

      const pool = new WorkerPool({ jobs: options.jobs });
      try {
        await pool.ready();
        let processed = 0;
        await pool.dispatch(poolItems, (seq, result) => {
          processed++;
          const w = work[seq];
          const rel = w.file.relativePath;

          // Counters-only branches (file row stays untouched → pruned).
          if (result.kind === 'too-large') {
            skippedTooLarge++;
            if (options.verbose) {
              process.stdout.write(`  ⤬  ${rel} (${(result.size / 1024).toFixed(0)} KiB > ${(maxFileBytes / 1024).toFixed(0)} KiB cap)\n`);
            } else if (!quiet) writeProgress(processed, total, rel);
            if (processed % BATCH_SIZE === 0) closeBatch();
            return;
          }
          if (result.kind === 'io-error') {
            skipped++;
            if (options.verbose) process.stdout.write(`  ⚠  ${rel} (read error: ${result.error})\n`);
            else if (!quiet) writeProgress(processed, total, rel);
            if (processed % BATCH_SIZE === 0) closeBatch();
            return;
          }

          // parsed / parse-error / cached all read the file successfully —
          // we have hash + lines. Always upsert so touchedFileIds is updated.
          const hash = result.hash;
          const lines = result.lines;
          openBatch();
          const classification = classifyFile(rel);
          const upserted = forceServiceCallBackfill
            ? { fileId: this.store.upsertFile(w.file.absolutePath, rel, w.language, hash, lines, classification), unchanged: false }
            : this.store.upsertFileWithCache(
                w.file.absolutePath, rel, w.language, hash, lines, classification,
              );
          const { fileId, unchanged } = upserted;
          touchedFileIds.add(fileId);

          // Cache hit (worker's hash matched the DB's stored hash). Prior
          // symbols/edges/imports/routes/configKeys stay as-is. Note: an
          // explicit `cached` result always falls into this branch; a `parsed`
          // result whose hash happens to match an in-flight DB update would
          // also land here defensively (we never re-insert when unchanged).
          if (unchanged) {
            reusedFromCache++;
            if (options.verbose) process.stdout.write(`  =  ${rel} (cached)\n`);
            else if (!quiet) writeProgress(processed, total, rel);
            if (processed % BATCH_SIZE === 0) closeBatch();
            return;
          }

          // Only `parsed` carries an extraction. `cached` lands in the
          // unchanged-branch above; `parse-error` and any defensive fall-
          // through here get treated as a parse error (file row exists,
          // no symbols/edges emitted).
          if (result.kind !== 'parsed') {
            parseErrors++;
            if (options.verbose) process.stdout.write(`  ⚠  ${rel} (parse error)\n`);
            else if (!quiet) writeProgress(processed, total, rel);
            if (processed % BATCH_SIZE === 0) closeBatch();
            return;
          }

          // parsed: insert all symbols, edges, imports, routes, configKeys.
          const extraction: FileExtraction = result.extraction;
          const symbolIdMap = new Map<string, number>();
          for (const def of extraction.definitions) {
            const symId = this.store.insertSymbol(fileId, def);
            const qname = def.qualifiedName ?? def.name;
            if (!symbolIdMap.has(qname)) symbolIdMap.set(qname, symId);
          }
          for (const ref of extraction.references) {
            const fromId = ref.callerName ? symbolIdMap.get(ref.callerName) : undefined;
            if (fromId !== undefined) {
              this.store.insertEdge(fromId, ref.calleeName, ref.kind, ref.line);
            }
          }
          for (const mod of extraction.importedModules) {
            this.store.insertFileImport(fileId, mod);
          }
          if (extraction.routes) {
            for (const r of extraction.routes) {
              this.store.insertRoute(
                fileId, r.method, r.path, r.framework,
                r.handlerName ?? null, r.line,
                {
                  protocol: r.protocol ?? 'http',
                  operation: r.operation ?? null,
                  topic: r.topic ?? null,
                  queue: r.queue ?? null,
                  exchange: r.exchange ?? null,
                  service: r.service ?? null,
                  broker: r.broker ?? null,
                  metadataJson: r.metadataJson ?? null,
                },
              );
            }
          }
          if (extraction.configKeys) {
            for (const c of extraction.configKeys) {
              const enclosingId = c.callerName ? symbolIdMap.get(c.callerName) ?? null : null;
              this.store.insertConfigKey(c.key, c.source, fileId, enclosingId, c.line);
            }
          }
          if (extraction.serviceCalls) {
            for (const sc of extraction.serviceCalls) {
              const enclosingId = sc.callerName ? symbolIdMap.get(sc.callerName) ?? null : null;
              // Only run HTTP-shaped normalization when the call is HTTP.
              const norm = sc.protocol === 'http'
                ? normalizeHttpTarget(sc.rawTarget)
                : { path: undefined, hostHint: undefined };
              this.store.insertServiceCall({
                fileId,
                symbolId: enclosingId,
                protocol: sc.protocol,
                method: sc.method ?? null,
                rawTarget: sc.rawTarget,
                normalizedPath: sc.normalizedPath ?? norm.path ?? null,
                hostHint: sc.hostHint ?? norm.hostHint ?? null,
                envKey: sc.envKey ?? null,
                framework: sc.framework,
                line: sc.line,
                confidence: sc.confidence,
                operation: sc.operation ?? null,
                topic: sc.topic ?? null,
                queue: sc.queue ?? null,
                exchange: sc.exchange ?? null,
                service: sc.service ?? null,
                broker: sc.broker ?? null,
                metadataJson: sc.metadataJson ?? null,
              });
            }
          }

          if (processed % BATCH_SIZE === 0) closeBatch();
          indexed++;

          if (options.verbose) {
            process.stdout.write(`  ✓  ${rel} (${extraction.definitions.length} symbols, ${extraction.references.length} refs)\n`);
          } else if (!quiet) {
            writeProgress(processed, total, rel);
          }
        });
        workerWasmResets = pool.wasmResetCount();
        closeBatch();
      } catch (err) {
        rollbackBatch();
        await pool.terminate().catch(() => { /* */ });
        throw err;
      }
      await pool.shutdown();

      if (!options.verbose && !quiet) process.stdout.write('\n');
      // Skip the serial prefetcher block below.
      return await this.finishIndex(
        absRoot, start, total, indexed, reusedFromCache, skipped,
        skippedTooLarge, parseErrors, touchedFileIds,
        { verbose: options.verbose, quiet: !!quiet, workerWasmResets },
      );
    }

    // ── Bounded async prefetcher (serial branch) ────────────────────────────────
    //
    // Producer side: a fixed sliding window of up to `ioConcurrency` in-flight
    // `prefetchOne()` calls, each one bounded by `byteSem` so cumulative
    // buffered content never exceeds `ioPrefetchBytes`.
    //
    // Consumer side: the main loop awaits prefetched results IN ORDER (so
    // batching/progress/determinism match the old sync loop exactly), parses
    // serially (single shared WASM module — see parser/index.ts), and writes
    // serially (single SQLite connection).
    //
    // The byte budget is released only AFTER parse completes, because parse
    // reads from the in-memory string. That means while a slow file parses we
    // hold its budget — which is intentional: backpressures the prefetcher
    // exactly when the parser falls behind.
    const byteSem = new ByteSemaphore(ioPrefetchBytes);

    const prefetchOne = async (idx: number): Promise<PrefetchResult> => {
      const item = work[idx];
      const abs = item.file.absolutePath;

      // Only stat when there's an actual size cap to enforce. Saves one
      // syscall per file in the (default) `maxFileBytes === 0` mode.
      if (maxFileBytes > 0) {
        let size: number;
        try {
          size = (await fs.promises.stat(abs)).size;
        } catch {
          return { kind: 'io-error', item };
        }
        if (size > maxFileBytes) {
          return { kind: 'too-large', item, size };
        }
        await byteSem.acquire(Math.max(size, 1));
        let content: string;
        try {
          content = await fs.promises.readFile(abs, 'utf8');
        } catch {
          byteSem.release(Math.max(size, 1));
          return { kind: 'io-error', item };
        }
        // Update the held budget if the on-disk size disagreed with the
        // decoded string length (Buffer length, after UTF-8 → UTF-16). We
        // re-anchor to the actual content length so future releases match.
        const actual = Buffer.byteLength(content, 'utf8');
        if (actual !== size) {
          byteSem.release(Math.max(size, 1));
          await byteSem.acquire(Math.max(actual, 1));
        }
        return { kind: 'ok', item, content, size: actual };
      }

      // No size cap → skip the stat entirely. We don't know the size up
      // front, so reserve a conservative slot (1 byte), read, then re-acquire
      // the true size. This keeps a single huge file from blocking us before
      // we even know it's huge.
      await byteSem.acquire(1);
      let content: string;
      try {
        content = await fs.promises.readFile(abs, 'utf8');
      } catch {
        byteSem.release(1);
        return { kind: 'io-error', item };
      }
      const size = Buffer.byteLength(content, 'utf8');
      // Re-anchor budget to actual size.
      byteSem.release(1);
      await byteSem.acquire(Math.max(size, 1));
      return { kind: 'ok', item, content, size };
    };

    // Sliding window of in-flight prefetches, indexed by their position in `work`.
    // We `slots.shift()` after awaiting so the array stays small (≤ ioConcurrency).
    const slots: Array<Promise<PrefetchResult>> = [];
    let nextToLaunch = 0;
    const launchUpTo = (window: number): void => {
      while (slots.length < window && nextToLaunch < work.length) {
        slots.push(prefetchOne(nextToLaunch));
        nextToLaunch++;
      }
    };

    // Prime the pipeline.
    launchUpTo(ioConcurrency);

    let processed = 0;

    try {
      while (slots.length > 0) {
        const prefetched = await slots.shift()!;
        processed++;

        // Whatever happens to this file, the moment we're done with the
        // string we MUST release its byte budget so the next prefetch can
        // start. We accumulate the released amount and release in `finally`
        // at the end of each iteration.
        const heldBytes = prefetched.kind === 'ok' ? Math.max(prefetched.size, 1) :
                          prefetched.kind === 'too-large' ? 0 : // never acquired
                          0; // io-error already released
        try {
          if (prefetched.kind === 'too-large') {
            skippedTooLarge++;
            if (options.verbose) {
              process.stdout.write(
                `  ⤬  ${prefetched.item.file.relativePath} (${(prefetched.size / 1024).toFixed(0)} KiB > ${(maxFileBytes / 1024).toFixed(0)} KiB cap)\n`,
              );
            } else if (!quiet) {
              writeProgress(processed, total, prefetched.item.file.relativePath);
            }
            if (processed % BATCH_SIZE === 0) closeBatch();
            continue;
          }

          if (prefetched.kind === 'io-error') {
            skipped++;
            if (options.verbose) {
              process.stdout.write(`  ⚠  ${prefetched.item.file.relativePath} (read error)\n`);
            } else if (!quiet) {
              writeProgress(processed, total, prefetched.item.file.relativePath);
            }
            if (processed % BATCH_SIZE === 0) closeBatch();
            continue;
          }

          const { item, content } = prefetched;
          const { file, language } = item;
          const hash = sha256(content);
          const lines = content.split('\n').length;

          openBatch();
          const classification = classifyFile(file.relativePath);
          const upserted = forceServiceCallBackfill
            ? { fileId: this.store.upsertFile(
                file.absolutePath,
                file.relativePath,
                language,
                hash,
                lines,
                classification,
              ), unchanged: false }
            : this.store.upsertFileWithCache(
                file.absolutePath,
                file.relativePath,
                language,
                hash,
                lines,
                classification,
              );
          const { fileId, unchanged } = upserted;
          touchedFileIds.add(fileId);

          // Hash-based cache hit: same content as last run → keep symbols, edges,
          // and file_imports as-is. Edge to_ids that point to symbols that have
          // since been deleted got NULLed by the FK cascade, so resolveEdges()
          // below will still re-link them.
          if (unchanged) {
            reusedFromCache++;
            if (options.verbose) {
              process.stdout.write(`  =  ${file.relativePath} (cached)\n`);
            } else if (!quiet) {
              writeProgress(processed, total, file.relativePath);
            }
            if (processed % BATCH_SIZE === 0) closeBatch();
            continue;
          }

          const extraction = await parseFile(content, file.absolutePath, language);
          if (!extraction) {
            parseErrors++;
            if (options.verbose) {
              process.stdout.write(`  ⚠  ${file.relativePath} (parse error)\n`);
            } else if (!quiet) {
              writeProgress(processed, total, file.relativePath);
            }
            if (processed % BATCH_SIZE === 0) closeBatch();
            continue;
          }

          const symbolIdMap = new Map<string, number>(); // qualifiedName → id
          for (const def of extraction.definitions) {
            const symId = this.store.insertSymbol(fileId, def);
            const qname = def.qualifiedName ?? def.name;
            if (!symbolIdMap.has(qname)) symbolIdMap.set(qname, symId);
          }
          for (const ref of extraction.references) {
            const fromId = ref.callerName ? symbolIdMap.get(ref.callerName) : undefined;
            if (fromId !== undefined) {
              this.store.insertEdge(fromId, ref.calleeName, ref.kind, ref.line);
            }
          }
          for (const mod of extraction.importedModules) {
            this.store.insertFileImport(fileId, mod);
          }
          if (extraction.routes) {
            for (const r of extraction.routes) {
              this.store.insertRoute(
                fileId, r.method, r.path, r.framework,
                r.handlerName ?? null, r.line,
                {
                  protocol: r.protocol ?? 'http',
                  operation: r.operation ?? null,
                  topic: r.topic ?? null,
                  queue: r.queue ?? null,
                  exchange: r.exchange ?? null,
                  service: r.service ?? null,
                  broker: r.broker ?? null,
                  metadataJson: r.metadataJson ?? null,
                },
              );
            }
          }
          if (extraction.configKeys) {
            for (const c of extraction.configKeys) {
              const enclosingId = c.callerName ? symbolIdMap.get(c.callerName) ?? null : null;
              this.store.insertConfigKey(c.key, c.source, fileId, enclosingId, c.line);
            }
          }
          if (extraction.serviceCalls) {
            for (const sc of extraction.serviceCalls) {
              const enclosingId = sc.callerName ? symbolIdMap.get(sc.callerName) ?? null : null;
              // Only run HTTP-shaped normalization when the call is HTTP.
              const norm = sc.protocol === 'http'
                ? normalizeHttpTarget(sc.rawTarget)
                : { path: undefined, hostHint: undefined };
              this.store.insertServiceCall({
                fileId,
                symbolId: enclosingId,
                protocol: sc.protocol,
                method: sc.method ?? null,
                rawTarget: sc.rawTarget,
                normalizedPath: sc.normalizedPath ?? norm.path ?? null,
                hostHint: sc.hostHint ?? norm.hostHint ?? null,
                envKey: sc.envKey ?? null,
                framework: sc.framework,
                line: sc.line,
                confidence: sc.confidence,
                operation: sc.operation ?? null,
                topic: sc.topic ?? null,
                queue: sc.queue ?? null,
                exchange: sc.exchange ?? null,
                service: sc.service ?? null,
                broker: sc.broker ?? null,
                metadataJson: sc.metadataJson ?? null,
              });
            }
          }

          if (processed % BATCH_SIZE === 0) closeBatch();

          indexed++;

          if (options.verbose) {
            const symCount = extraction.definitions.length;
            const refCount = extraction.references.length;
            process.stdout.write(
              `  ✓  ${file.relativePath} (${symCount} symbols, ${refCount} refs)\n`,
            );
          } else if (!quiet) {
            writeProgress(processed, total, file.relativePath);
          }
        } finally {
          // Return this file's bytes to the prefetcher budget BEFORE launching
          // the next slot, so the launch decision sees an up-to-date balance.
          if (heldBytes > 0) byteSem.release(heldBytes);
          // Refill the sliding window now that one slot drained.
          launchUpTo(ioConcurrency);
        }
      }

      // Close the last partial batch before kicking off post-processing
      // (resolveImports / resolveEdges / pruneFilesNotIn all start their own
      // transactions and would crash if one is already open).
      closeBatch();
    } catch (err) {
      // Don't leave a transaction dangling — post-processing's BEGIN would
      // throw and mask the original error.
      rollbackBatch();
      // Drain any in-flight prefetches so their byte budget is returned and
      // open FDs / promises don't leak as unhandled rejections.
      while (slots.length > 0) {
        try {
          const p = await slots.shift()!;
          if (p.kind === 'ok') byteSem.release(Math.max(p.size, 1));
        } catch { /* swallow */ }
      }
      throw err;
    }

    if (!options.verbose && !quiet) process.stdout.write('\n');

    return await this.finishIndex(
      absRoot, start, total, indexed, reusedFromCache, skipped,
      skippedTooLarge, parseErrors, touchedFileIds,
      { verbose: options.verbose, quiet: !!quiet },
    );
  }

  /**
   * Post-parse pipeline shared by the serial and parallel branches: prune
   * stale files, resolve imports/edges/routes/config-keys, synthesize test
   * edges, refresh external dependencies, lazily recompute PageRank, and
   * assemble the `IndexResult`.
   */
  private async finishIndex(
    absRoot: string,
    start: number,
    total: number,
    indexed: number,
    reusedFromCache: number,
    skipped: number,
    skippedTooLarge: number,
    parseErrors: number,
    touchedFileIds: Set<number>,
    opts: { verbose?: boolean; quiet: boolean; workerWasmResets?: number },
  ): Promise<IndexResult> {
    const { verbose, quiet } = opts;

    // v9 Track-H: scan .proto files for gRPC service definitions BEFORE the
    // stale-file prune and service-link resolver run. .proto files are not
    // part of normal tree-sitter discovery, so they must be added to
    // touchedFileIds here; otherwise cached re-indexes would prune and
    // recreate proto rows every time.
    try {
      const protoScan = await scanProtoFiles(absRoot, this.store);
      for (const fileId of protoScan.fileIds) touchedFileIds.add(fileId);
    } catch (err) {
      if (verbose) process.stdout.write(`  ⚠  proto scanner failed: ${err}\n`);
    }

    // Drop files that existed in a prior run but didn't show up this time
    // (e.g. user added a new ignore rule, or files were removed from disk).
    // FK cascades remove their symbols, edges, and file_imports too.
    const prunedFiles = this.store.pruneFilesNotIn(touchedFileIds);
    if (prunedFiles > 0 && !quiet) {
      process.stdout.write(`  Pruned ${prunedFiles.toLocaleString()} stale file(s) from prior run\n`);
    }

    // Post-processing passes
    if (!quiet) process.stdout.write('  Resolving imports...\n');
    const resolvedImports = this.store.resolveImports();

    if (!quiet) process.stdout.write('  Resolving call edges...\n');
    const resolution = this.store.resolveEdges();

    // Track-C: link routes to handlers, config_keys to enclosing symbol,
    // synthesize tests edges from test-file → non-test-file calls.
    const routesResolved = this.store.resolveRouteHandlers();
    const configKeysResolved = this.store.resolveConfigKeySymbols();
    const testEdgesAdded = this.store.synthesizeTestEdges();

    // ── Graph-changed predicate ─────────────────────────────────────────────
    // All the inputs it needs are now available. Hoisted here so the external-
    // dep extraction and PageRank/modules/boundaries/shape-hash passes can all
    // share the same gate.
    const graphChanged =
      indexed > 0 ||
      prunedFiles > 0 ||
      resolution.sameFile + resolution.imported + resolution.global > 0 ||
      resolvedImports > 0;

    // v9 Track-H: scan k8s manifests + Docker Compose for service hostnames.
    // Passed to the resolver as evidence — host_hint hits get a confidence
    // boost and may be classified as `service_host` link matches.
    let hostMap: import('./serviceHostScanner.js').ServiceHostMap | undefined;
    try {
      hostMap = await scanServiceHosts(absRoot);
    } catch (err) {
      if (verbose) process.stdout.write(`  ⚠  service-host scanner failed: ${err}\n`);
    }

    // Track-G: deterministic service-link resolution. Runs every time, since
    // any change in service_calls OR routes can shift link membership. The
    // resolver itself wipes service_links before rebuilding so it's
    // idempotent.
    let serviceLinks = 0;
    let serviceLinksByKind: Record<string, number> = {};
    try {
      const sr = resolveServiceLinks(this.store, { hostMap });
      serviceLinks = sr.linksInserted;
      serviceLinksByKind = sr.byKind as Record<string, number>;
      this.store.markServiceCallsBackfilled();
    } catch (err) {
      if (verbose) process.stdout.write(`  ⚠  service-link resolution failed: ${err}\n`);
    }

    // Metadata-only edits (package.json/Cargo.toml/etc.) do not change the
    // source graph, but they do change dependency facts. Keep cached re-indexes
    // truthful by refreshing the manifest-derived table even when graphChanged
    // is false; the existing graphChanged branch below handles changed graphs.
    if (!graphChanged) {
      try {
        const { extractExternalDependencies } = await import('./externaldeps.js');
        await extractExternalDependencies(absRoot, this.store);
      } catch (err) {
        if (verbose) {
          process.stdout.write(`  !  external dep extraction failed: ${err}\n`);
        }
      }
    }

    // Changed source graphs take this branch; cached source graphs refresh
    // dependency facts through the metadata-only branch above.
    if (graphChanged) {
      try {
        const { extractExternalDependencies } = await import('./externaldeps.js');
        await extractExternalDependencies(absRoot, this.store);
      } catch (err) {
        if (verbose) {
          process.stdout.write(`  ⚠  external dep extraction failed: ${err}\n`);
        }
      }
    }

    // ── Lazy PageRank ───────────────────────────────────────────────────────────
    // PageRank values are a pure function of the resolved edge graph. If nothing
    // in that graph changed this run, every previously-stored rank is still
    // correct and we can skip the O(iterations × edges) recomputation.
    // `graphChanged` was computed above (after synthesizeTestEdges) and is shared
    // by all the lazy post-pass gates below.

    let pagerankRecomputed = false;
    if (graphChanged) {
      if (!quiet) process.stdout.write('  Computing PageRank...\n');
      const symbolIds = this.store.getAllSymbolIds();
      const edges = this.store.getAllEdges();
      const ranks = computePageRank(symbolIds, edges);
      this.store.updatePageRanks(ranks);
      pagerankRecomputed = true;
    } else if (!quiet) {
      process.stdout.write('  Skipping PageRank (graph unchanged)\n');
    }

    // ── Lazy module clustering ──────────────────────────────────────────────
    // Same skip predicate as PageRank: the cluster is a function of the file
    // graph + symbol PageRank, both of which stay stable when nothing changed.
    // Always build when modules table is empty so the first opt-in to v6 runs
    // it once, even when the index itself was a no-op.
    let modulesRecomputed = false;
    if (graphChanged || !this.store.hasModulesData()) {
      if (!quiet) process.stdout.write('  Clustering modules...\n');
      try {
        buildModules(this.store);
        modulesRecomputed = true;
      } catch (err) {
        if (verbose) process.stdout.write(`  ⚠  module clustering failed: ${err}\n`);
      }
    } else if (!quiet) {
      process.stdout.write('  Skipping module clustering (graph unchanged)\n');
    }

    // ── v10 boundary detection ──────────────────────────────────────────────
    // Always run when graphChanged (new files / pruned files / new edges)
    // OR when the boundaries table is empty (first opt-in after migrating
    // an existing DB to v10).
    let boundariesRecomputed = false;
    try {
      if (!graphChanged && this.store.hasBoundariesData()) {
        if (!quiet) process.stdout.write('  Detecting boundaries...\n');
        const r = buildBoundaries(absRoot, this.store);
        this.store.replaceBoundaries(r.boundaries, r.edges);
        boundariesRecomputed = true;
      }
      if (graphChanged || !this.store.hasBoundariesData()) {
        if (!quiet) process.stdout.write('  Detecting boundaries...\n');
        const r = buildBoundaries(absRoot, this.store);
        this.store.replaceBoundaries(r.boundaries, r.edges);
        boundariesRecomputed = true;
      }
    } catch (err) {
      if (verbose) process.stdout.write(`  ⚠  boundary detection failed: ${err}\n`);
    }
    void boundariesRecomputed;

    // ── Lazy shape-hash pass (Track-F structural SimHash) ──────────────────
    // Re-indexed files delete their old symbols (no shape_hash on the new
    // rows yet) so graphChanged covers normal updates. We ALSO run when any
    // eligible symbol is missing a hash even on a cached/no-op run — this is
    // the case after a pre-v7 → v7 migration where every existing file is
    // "cached" (content hash unchanged) but the new shape_hash column starts
    // NULL on every row. Without this second predicate the backfill would
    // never run and `seer_duplicates` would silently return nothing.
    let shapeHashesAdded = 0;
    const needsHashBackfill = this.store.hasMissingShapeHashes();
    if (graphChanged || needsHashBackfill) {
      if (!quiet) {
        process.stdout.write(graphChanged
          ? '  Computing shape hashes...\n'
          : '  Backfilling shape hashes...\n');
      }
      try {
        const r = buildShapeHashes(this.store);
        shapeHashesAdded = r.symbolsHashed;
      } catch (err) {
        if (verbose) process.stdout.write(`  ⚠  shape-hash pass failed: ${err}\n`);
      }
    } else if (!quiet) {
      process.stdout.write('  Skipping shape hashes (graph unchanged, no backfill needed)\n');
    }

    // v10 — rename/move continuity is NOT built here. It is a quadratic
    // shape-comparison pass and, crucially, it only produces meaningful results
    // once per-symbol git history exists (which is a separate opt-in pass, not
    // part of indexing). Running it inline used to dominate index time on every
    // repo and made large ones (godot, Unreal) effectively never finish.
    // Continuity now builds lazily on first `seer continuity` / preflight query,
    // alongside the other heavy derived passes (modules, shape hashes, history).

    const stats = this.store.getStats();
    const elapsedMs = Date.now() - start;

    return {
      filesDiscovered: total,
      filesIndexed: indexed,
      filesReusedFromCache: reusedFromCache,
      filesSkipped: skipped,
      filesSkippedTooLarge: skippedTooLarge,
      filesParseError: parseErrors,
      wasmResets: wasmResetCount() + (opts.workerWasmResets ?? 0),
      symbols: stats.symbols,
      edges: stats.edges,
      // stats.resolvedEdges is the running DB total; resolution.{sameFile,
      // imported, global} below reports only the *delta* — what this run
      // newly resolved (mostly nonzero on first run, near-zero on a cached
      // re-run where everything was already resolved).
      resolvedEdges: stats.resolvedEdges,
      resolvedImports,
      edgeResolution: {
        sameFile: resolution.sameFile,
        imported: resolution.imported,
        global: resolution.global,
      },
      pagerankRecomputed,
      routesResolved,
      configKeysResolved,
      testEdgesAdded,
      externalDependencies: stats.externalDependencies,
      modules: stats.modules,
      modulesRecomputed,
      shapeHashesAdded,
      serviceLinks,
      serviceLinksByKind,
      elapsedMs,
    };
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

function writeProgress(current: number, total: number, label: string): void {
  if (!process.stdout.isTTY) return;
  const width = 28;
  const pct = total > 0 ? current / total : 0;
  const filled = Math.round(pct * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const pctStr = Math.round(pct * 100).toString().padStart(3);
  const short = label.length > 35 ? '…' + label.slice(-34) : label.padEnd(35);
  process.stdout.write(`\r  [${bar}] ${pctStr}% (${current}/${total}) ${short}`);
}
