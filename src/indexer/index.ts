import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { discoverFiles, DiscoveredFile, DiscoveryMode } from './discovery.js';
import { parseFile, detectLanguage, wasmResetCount } from '../parser/index.js';
import { computePageRank } from '../graph/pagerank.js';
import { Store } from '../db/store.js';
import { classifyFile } from './classify.js';
import type { Language } from '../types.js';

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
}

const DEFAULT_MAX_FILE_BYTES = 0;       // no cap by default — completeness first
const DEFAULT_IO_CONCURRENCY = 8;       // matches the file-handle budget on most OSes comfortably
const DEFAULT_IO_PREFETCH_BYTES = 64 * 1024 * 1024; // 64 MiB

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

function shouldSkipFilename(relativePath: string): boolean {
  return SKIP_FILENAME_PATTERNS.some(re => re.test(relativePath));
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

  async indexDirectory(
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

    // ── Pre-filter into a work queue ────────────────────────────────────────────
    // Pure CPU work (string ops on the path). Cheap to do all at once so the
    // async prefetcher's index space matches up cleanly with progress counters.
    const work: WorkItem[] = [];
    for (const file of files) {
      const language = detectLanguage(file.absolutePath) as Language | null;
      if (!language || shouldSkipFilename(file.relativePath)) {
        skipped++;
        continue;
      }
      work.push({ file, language });
    }

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

    // ── Bounded async prefetcher ────────────────────────────────────────────────
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
          const { fileId, unchanged } = this.store.upsertFileWithCache(
            file.absolutePath,
            file.relativePath,
            language,
            hash,
            lines,
            classification,
          );
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
              );
            }
          }
          if (extraction.configKeys) {
            for (const c of extraction.configKeys) {
              const enclosingId = c.callerName ? symbolIdMap.get(c.callerName) ?? null : null;
              this.store.insertConfigKey(c.key, c.source, fileId, enclosingId, c.line);
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

    // Top-level skip counter wasn't bumped for the pre-filter pass on the
    // hot path (we counted there directly into `skipped`). Account for the
    // pre-filter pass we already counted above; nothing more to do here.

    if (!options.verbose && !quiet) process.stdout.write('\n');

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

    // External dependency extraction from manifests/lockfiles. This is cheap
    // and idempotent — clear and re-insert every full pass so deletions are
    // reflected. We pass absRoot so the extractor finds package.json /
    // Cargo.toml / etc. at the repo root and walks down for monorepos.
    try {
      const { extractExternalDependencies } = await import('./externaldeps.js');
      await extractExternalDependencies(absRoot, this.store);
    } catch (err) {
      if (options.verbose) {
        process.stdout.write(`  ⚠  external dep extraction failed: ${err}\n`);
      }
    }

    // ── Lazy PageRank ───────────────────────────────────────────────────────────
    // PageRank values are a pure function of the resolved edge graph. If nothing
    // in that graph changed this run, every previously-stored rank is still
    // correct and we can skip the O(iterations × edges) recomputation.
    //
    // "Nothing changed" requires ALL of the following:
    //   - no file was newly indexed (no new symbols/edges/imports inserted)
    //   - no stale file was pruned (would have cascaded FK deletes,
    //     potentially NULLing inbound edge `to_id`s)
    //   - resolveEdges() promoted zero NULL `to_id`s to a real id
    //   - resolveImports() promoted zero NULL `resolved_file_id`s
    //
    // If any of those is nonzero, the symbol set OR the resolved-edge graph
    // could have shifted, so we recompute. This is the same correctness
    // contract that the scale-test's "top-symbol id stability" check enforces
    // — drift there means the predicate below missed a case.
    //
    // Why this is safe even on first run: when the DB is fresh, `indexed > 0`
    // (everything is new), so the predicate fires and PageRank is computed.
    const graphChanged =
      indexed > 0 ||
      prunedFiles > 0 ||
      resolution.sameFile + resolution.imported + resolution.global > 0 ||
      resolvedImports > 0;

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

    const stats = this.store.getStats();
    const elapsedMs = Date.now() - start;

    return {
      filesDiscovered: total,
      filesIndexed: indexed,
      filesReusedFromCache: reusedFromCache,
      filesSkipped: skipped,
      filesSkippedTooLarge: skippedTooLarge,
      filesParseError: parseErrors,
      wasmResets: wasmResetCount(),
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
