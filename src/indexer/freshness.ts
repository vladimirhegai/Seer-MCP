import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import glob from 'fast-glob';
import { Indexer } from './index.js';
import { Store } from '../db/store.js';
import { discoverFiles } from './discovery.js';

/**
 * Quick freshness check + targeted re-index for MCP/CLI queries.
 *
 * Design contract: the watcher (when running) keeps the index warm by marking
 * files dirty in the background. JIT sync runs before every query as the
 * correctness layer — it does the actual reindex of dirty files so a query
 * returning right now reflects the current workspace state.
 *
 * Implementation: discover the workspace, compare on-disk content hashes
 * against what the DB says, and only reindex files whose hash changed.
 * Unchanged files are skipped entirely; we don't touch the parser for them.
 *
 * The intentional bias here is correctness over latency: we re-discover the
 * full workspace each time so newly-added or newly-renamed files are not
 * missed. For very large repos this is still cheap (a glob + dir walk
 * over 10-100k files is sub-second) compared to a single tree-sitter parse,
 * and you only do it once per JIT call.
 */
export interface FreshnessReport {
  /** Files where the on-disk hash differed from the DB. Reindexed. */
  dirtyReindexed: number;
  /** Files that vanished from disk since the last index. Pruned. */
  removed: number;
  /** Files newly seen this run (not in the DB yet). Indexed. */
  added: number;
  /** Total wall time in ms. */
  elapsedMs: number;
}

/**
 * Cheap content hash matching what the indexer uses internally. Kept here as
 * a duplicate (not exported from indexer/index.ts) because the indexer's
 * version is in the hot loop and we don't want to widen its export surface.
 */
function sha256Short(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

async function discoverProtoFiles(absRoot: string): Promise<Array<{ absolutePath: string; relativePath: string }>> {
  const entries = await glob(['**/*.proto'], {
    cwd: absRoot,
    ignore: [
      'node_modules/**', '**/node_modules/**',
      '.git/**', '**/.git/**',
      'dist/**', '**/dist/**',
      'build/**', '**/build/**',
      'out/**', '**/out/**',
      'vendor/**', '**/vendor/**', '**/__pycache__/**',
      '.next/**', '**/.next/**',
    ],
    onlyFiles: true,
    followSymbolicLinks: false,
    dot: false,
  });
  return entries.sort().map(rel => ({
    absolutePath: path.join(absRoot, rel),
    relativePath: rel,
  }));
}

/**
 * Inspect a workspace for changes since the last index, then reindex only
 * the files that need it. Designed to run before every MCP query.
 *
 * @param store     a writable Store (NOT readonly — we may need to mutate)
 * @param indexer   an Indexer over the same store
 * @param repoRoot  the workspace path used at index time
 * @param options.maxDirty  cap reindex work per call. When the dirty set is
 *   larger than this, we still run a full `indexer.indexDirectory()` because
 *   a partial JIT pass would leave the index inconsistent (resolveEdges
 *   needs the full graph). Defaults to 200 — small enough to keep the
 *   "type a few characters and ask" workflow snappy.
 */
export async function jitSync(
  store: Store,
  indexer: Indexer,
  repoRoot: string,
  options: { maxDirty?: number; verbose?: boolean } = {},
): Promise<FreshnessReport> {
  const start = Date.now();
  const maxDirty = options.maxDirty ?? 200;

  const absRoot = path.resolve(repoRoot);

  // 1. Snapshot what the DB knows.
  const dbFiles = store.listFiles();
  const dbByPath = new Map(dbFiles.map(f => [normalizeForCompare(f.path), f]));

  // 2. Walk the workspace and find candidate files. discoverFiles() applies
  //    the same ignore rules the indexer uses, so freshness can't be
  //    misled by build artifacts or `vendor/` entries.
  const discovered = [
    ...await discoverFiles(absRoot),
    ...await discoverProtoFiles(absRoot),
  ];
  const discoveredByPath = new Map<string, string>();
  for (const d of discovered) {
    discoveredByPath.set(normalizeForCompare(d.absolutePath), d.relativePath);
  }

  // 3. Identify added / removed / candidate-dirty files.
  const added: string[] = [];
  const removed: number[] = [];
  const candidateDirty: typeof dbFiles = [];
  for (const f of dbFiles) {
    const key = normalizeForCompare(f.path);
    if (!discoveredByPath.has(key)) {
      removed.push(f.id);
      continue;
    }
    candidateDirty.push(f);
  }
  for (const [key, _rel] of discoveredByPath) {
    if (!dbByPath.has(key)) added.push(key);
  }

  // 4. Hash each candidate. Same trade-off as the indexer: read everything
  //    we'd parse anyway, but if the hash matches we never spend time on
  //    the parser. We stop early as soon as we cross `maxDirty` so a giant
  //    change like a git checkout falls back to a full reindex.
  const dirty: string[] = [];
  for (const f of candidateDirty) {
    if (dirty.length + added.length >= maxDirty) break;
    let content: string;
    try {
      content = await fs.promises.readFile(f.path, 'utf8');
    } catch {
      // File became unreadable mid-check (rename, permission flip). Treat
      // as removed so the next pass cleans it up.
      removed.push(f.id);
      continue;
    }
    const hash = sha256Short(content);
    if (hash !== f.hash) dirty.push(f.path);
  }

  const fullReindexNeeded =
    dirty.length + added.length >= maxDirty || removed.length > 0;

  if (dirty.length === 0 && added.length === 0 && removed.length === 0) {
    return { dirtyReindexed: 0, removed: 0, added: 0, elapsedMs: Date.now() - start };
  }

  if (fullReindexNeeded) {
    // Cheaper to invoke the full pipeline than to surgically remove files
    // and reconcile edge graphs. The indexer's cache means unchanged files
    // are still skipped at parse time, so this is O(dirty + added + |touched|)
    // not O(|workspace|).
    // JIT pins parallel:false. The dirty set is small (≤ maxDirty=200) and
    // worker spawn cost dominates the wins at this scale; serial is the
    // right default for the snappy "edit + ask" loop. MCP servers that want
    // parallel JIT can override later via an option.
    const result = await indexer.indexDirectory(absRoot, { quiet: !options.verbose, parallel: false });
    return {
      dirtyReindexed: dirty.length,
      removed: removed.length,
      added: added.length,
      elapsedMs: Date.now() - start + (result.elapsedMs ?? 0),
    };
  }

  // Targeted JIT path: dirty/added files only, no full re-discovery. Reuse
  // the indexer's machinery by calling indexDirectory — its cache skips
  // unchanged files. This is dominated by the discovery walk we already did,
  // so the marginal cost is small.
  await indexer.indexDirectory(absRoot, { quiet: !options.verbose, parallel: false });
  return {
    dirtyReindexed: dirty.length,
    removed: removed.length,
    added: added.length,
    elapsedMs: Date.now() - start,
  };
}

/**
 * Normalize a path for comparison across the OS-specific quirks we hit on
 * Windows. We index with backslashes; discovery resolves through `path.join`
 * which also produces backslashes. Read-only callers might pass a slash-form
 * path through the MCP layer; lowercase folds Windows case-insensitivity.
 */
function normalizeForCompare(p: string): string {
  const norm = p.replace(/\\/g, '/');
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}
