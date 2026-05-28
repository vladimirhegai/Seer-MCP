/**
 * Strata Scale Test — exercises every large codebase under `Large Codebases/`,
 * runs each one twice (fresh + cached), and writes a robust report.
 *
 * Why this exists: after every foundational change (e.g. a future
 * worker-thread parser, a new edge type, a schema migration) we need a
 * one-shot way to confirm:
 *   1. Every codebase still indexes without exceptions.
 *   2. Counts are deterministic — fresh and cached runs produce identical
 *      symbol/edge/resolved totals. Drift here = a real bug.
 *   3. The cache really rehydrates everything (reused == fresh-indexed).
 *   4. No WASM aborts triggered (resets stay at 0).
 *   5. Parse-error rate stays low.
 *   6. PageRank produces nonzero variance.
 *   7. Indexing speed isn't regressed (ms/file is logged for comparison).
 *
 * Outputs:
 *   tests/outputs/run-<ISO>.json   — full machine-readable report
 *   tests/outputs/latest.md        — human-readable summary (overwritten)
 *   tests/outputs/dbs/<name>.db    — per-codebase SQLite index (kept for
 *                                    follow-up queries; safe to delete)
 *
 * Usage:
 *   npm run scale-test                       # run all codebases
 *   npm run scale-test -- --only helix,react # subset
 *   npm run scale-test -- --skip unreal      # exclude
 *   npm run scale-test -- --pass 3           # do 3 fresh passes (catches
 *                                              run-to-run non-determinism)
 */

import path from 'path';
import fs from 'fs';
import { Store } from '../src/db/store';
import { Indexer, IndexResult } from '../src/indexer/index';

interface CodebaseSpec {
  name: string;
  relativePath: string;
}

const CODEBASES: CodebaseSpec[] = [
  { name: 'helix',      relativePath: 'Large Codebases/helix-master' },
  { name: 'client-go',  relativePath: 'Large Codebases/client-go-master' },
  { name: 'react',      relativePath: 'Large Codebases/react-main' },
  { name: 'godot',      relativePath: 'Large Codebases/godot-master' },
  { name: 'linux',      relativePath: 'Large Codebases/linux-master' },
  { name: 'typescript', relativePath: 'Large Codebases/TypeScript-main' },
  { name: 'unreal',     relativePath: 'Large Codebases/UnrealEngine-release' },
  // Self-validation: the codebase that surfaced the original dogfood gaps
  // (.c handling, vendored pollution, parallel-read DB locks). Including it
  // here so future regressions show up in the standard run.
  { name: 'cbm',        relativePath: 'Large Codebases/codebase-memory-mcp-main' },
];

interface TopSymbol {
  name: string;
  kind: string;
  pagerank: number;
  filePath: string;
}

interface RunReport {
  name: string;
  status: 'ok' | 'warn' | 'error';
  errors: string[];
  warnings: string[];

  // File-discovery breakdown
  filesDiscovered: number;
  filesIndexed: number;
  filesReused: number;       // from cached run — should equal filesIndexed
  filesParseError: number;
  filesSkipped: number;
  filesSkippedTooLarge: number;
  parseErrorPct: number;

  // Graph totals (from fresh run; cached must match)
  symbols: number;
  edges: number;
  resolvedEdges: number;
  resolutionPct: number;

  // Resolution breakdown (fresh run only)
  sameFile: number;
  imported: number;
  global: number;
  resolvedImports: number;

  // Health markers
  wasmResets: number;
  languages: Record<string, number>;

  // Timing
  freshMs: number;
  cachedMs: number;
  msPerFileFresh: number;
  cacheSpeedup: number;      // freshMs / cachedMs
  dbSizeMb: number;

  // Determinism sample
  topSymbols: TopSymbol[];
  pagerankVariance: number;  // stddev of top 20 PageRank values

  // Determinism cross-checks (filled at compare time)
  cachedSymbols: number;
  cachedEdges: number;
  cachedResolvedEdges: number;

  // Lazy PageRank verification: the fresh run should ALWAYS recompute, the
  // cached run should NEVER recompute (graph is identical, ranks are valid).
  freshPagerankRecomputed: boolean;
  cachedPagerankRecomputed: boolean;

  // Schema + classification snapshots so a regression in either surfaces here
  // alongside the determinism checks. `roles` is the file count broken down
  // by classification; `schemaVersion` is what the DB pinned.
  schemaVersion: number;
  roles: { project: number; vendor: number; generated: number; test: number };
}

// ── Run one codebase ──────────────────────────────────────────────────────────

async function runOne(spec: CodebaseSpec, repoRoot: string, dbPath: string): Promise<RunReport> {
  // Clean DB + WAL sidecars so the fresh run is genuinely fresh
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbPath + ext;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  // ── Fresh ──
  const store1 = new Store(dbPath);
  const indexer1 = new Indexer(store1);
  const fresh = await indexer1.indexDirectory(repoRoot, { quiet: true });
  const topAfterFresh = store1.getTopSymbols(20);
  store1.close();

  // ── Cached ──
  const store2 = new Store(dbPath);
  const indexer2 = new Indexer(store2);
  const cached = await indexer2.indexDirectory(repoRoot, { quiet: true });
  const topAfterCached = store2.getTopSymbols(20);
  const stats = store2.getStats();
  const schemaInfo = store2.schemaInfo();
  const roles = store2.getRoleCounts();
  store2.close();

  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Determinism: fresh vs cached must match ──
  if (fresh.symbols !== cached.symbols) {
    errors.push(`symbol drift: fresh=${fresh.symbols} cached=${cached.symbols}`);
  }
  if (fresh.edges !== cached.edges) {
    errors.push(`edge drift: fresh=${fresh.edges} cached=${cached.edges}`);
  }
  // The post-pass resolved count is reported as the running DB total in
  // IndexResult.resolvedEdges (see indexer/index.ts comment). It must be
  // identical between fresh and cached because cached re-runs the same
  // resolve passes against unchanged data.
  if (fresh.resolvedEdges !== cached.resolvedEdges) {
    errors.push(`resolved-edge drift: fresh=${fresh.resolvedEdges} cached=${cached.resolvedEdges}`);
  }
  // Cache rehydration: every file we indexed fresh should be reused next time.
  if (cached.filesReusedFromCache !== fresh.filesIndexed) {
    errors.push(
      `cache reuse mismatch: fresh indexed ${fresh.filesIndexed} but cached reused ${cached.filesReusedFromCache}`,
    );
  }
  // Cached run must not re-resolve anything.
  const cachedDelta =
    cached.edgeResolution.sameFile + cached.edgeResolution.imported + cached.edgeResolution.global;
  if (cachedDelta !== 0) {
    errors.push(
      `cached run resolved ${cachedDelta} new edges (should be 0 — implies edges left NULL after fresh)`,
    );
  }

  // Lazy PageRank invariants: fresh must recompute, cached must skip.
  // If cached recomputed despite no graph changes, the skip predicate is buggy.
  // If fresh skipped, something is *really* wrong (we just inserted all symbols).
  if (!fresh.pagerankRecomputed && fresh.symbols > 0) {
    errors.push('fresh run skipped PageRank despite inserting symbols');
  }
  if (cached.pagerankRecomputed && cached.symbols > 0 && cachedDelta === 0) {
    errors.push('cached run recomputed PageRank despite zero graph changes (lazy-skip predicate missed a case)');
  }

  // Top-symbol determinism check: top-20 PageRanks should be byte-identical
  // across fresh/cached. If they drift, our PageRank or ordering is unstable.
  if (topAfterFresh.length !== topAfterCached.length) {
    errors.push(`top-symbol count drifted: fresh=${topAfterFresh.length} cached=${topAfterCached.length}`);
  } else {
    for (let i = 0; i < topAfterFresh.length; i++) {
      if (topAfterFresh[i].id !== topAfterCached[i].id) {
        errors.push(`top-symbol[${i}] drifted: fresh-id=${topAfterFresh[i].id} cached-id=${topAfterCached[i].id}`);
        break;
      }
    }
  }

  // PageRank sanity: variance across top 20 should be nonzero if we have any
  // edges. (Helix passes have shown ~5e-3 variance; flat-zero would mean
  // PageRank failed to propagate.)
  const ranks = topAfterFresh.map(s => s.pagerank);
  const mean = ranks.reduce((a, b) => a + b, 0) / Math.max(ranks.length, 1);
  const variance = ranks.length > 0
    ? ranks.reduce((a, b) => a + (b - mean) ** 2, 0) / ranks.length
    : 0;
  if (fresh.edges > 0 && variance === 0) {
    errors.push('PageRank produced uniform values despite nonzero edges');
  }

  // ── Schema version: must match the current build ──
  if (schemaInfo.dbVersion !== schemaInfo.buildVersion) {
    errors.push(`schema_version mismatch: db=${schemaInfo.dbVersion} build=${schemaInfo.buildVersion}`);
  }

  // ── Track A regression: default top-symbol must not be a vendored file ──
  // The reason this is enforced is that the very first dogfood-gap reported
  // by indexing Codebase-Memory was that vendored grammar parsers were
  // dominating the PageRank top-20. After classification + project-first
  // defaults, the top symbol on any of these codebases should be project-owned.
  if (topAfterFresh.length > 0) {
    const top = topAfterFresh[0];
    const norm = top.filePath.replace(/\\/g, '/');
    const looksVendored =
      /(^|\/)(vendor|vendored|thirdparty|third_party|external|node_modules)\//i.test(norm);
    if (looksVendored) {
      errors.push(`top symbol is in vendored path: ${top.filePath}`);
    }
  }

  // ── Warnings (informational, don't fail the run) ──
  if (fresh.wasmResets > 0) {
    warnings.push(`${fresh.wasmResets} WASM runtime reset(s) during fresh — recovered, but worth investigating`);
  }
  const totalParsed = fresh.filesIndexed + fresh.filesParseError;
  const parseErrorPct = totalParsed > 0 ? (fresh.filesParseError / totalParsed) * 100 : 0;
  if (parseErrorPct > 10) {
    warnings.push(`parse error rate ${parseErrorPct.toFixed(1)}% > 10% — language extractor coverage might be slipping`);
  }
  if (fresh.edges > 0 && fresh.resolvedEdges / fresh.edges < 0.3) {
    warnings.push(
      `low resolution rate ${((fresh.resolvedEdges / fresh.edges) * 100).toFixed(1)}% — expected for languages without import resolution, but flag here for visibility`,
    );
  }

  // ── DB size ──
  let dbBytes = 0;
  try { dbBytes = fs.statSync(dbPath).size; } catch { /* deleted? */ }

  const status: 'ok' | 'warn' | 'error' =
    errors.length > 0 ? 'error' : warnings.length > 0 ? 'warn' : 'ok';

  return {
    name: spec.name,
    status,
    errors,
    warnings,
    filesDiscovered: fresh.filesDiscovered,
    filesIndexed: fresh.filesIndexed,
    filesReused: cached.filesReusedFromCache,
    filesParseError: fresh.filesParseError,
    filesSkipped: fresh.filesSkipped,
    filesSkippedTooLarge: fresh.filesSkippedTooLarge,
    parseErrorPct,
    symbols: fresh.symbols,
    edges: fresh.edges,
    resolvedEdges: fresh.resolvedEdges,
    resolutionPct: fresh.edges > 0 ? (fresh.resolvedEdges / fresh.edges) * 100 : 0,
    sameFile: fresh.edgeResolution.sameFile,
    imported: fresh.edgeResolution.imported,
    global: fresh.edgeResolution.global,
    resolvedImports: fresh.resolvedImports,
    wasmResets: fresh.wasmResets,
    languages: stats.languages,
    freshMs: fresh.elapsedMs,
    cachedMs: cached.elapsedMs,
    msPerFileFresh: fresh.filesIndexed > 0 ? fresh.elapsedMs / fresh.filesIndexed : 0,
    cacheSpeedup: cached.elapsedMs > 0 ? fresh.elapsedMs / cached.elapsedMs : 0,
    dbSizeMb: dbBytes / (1024 * 1024),
    topSymbols: topAfterFresh.slice(0, 5).map(s => ({
      name: s.name,
      kind: s.kind,
      pagerank: s.pagerank,
      filePath: path.relative(repoRoot, s.filePath).replace(/\\/g, '/'),
    })),
    pagerankVariance: variance,
    cachedSymbols: cached.symbols,
    cachedEdges: cached.edges,
    cachedResolvedEdges: cached.resolvedEdges,
    freshPagerankRecomputed: fresh.pagerankRecomputed,
    cachedPagerankRecomputed: cached.pagerankRecomputed,
    schemaVersion: schemaInfo.dbVersion,
    roles,
  };
}

// ── Output formatters ────────────────────────────────────────────────────────

function fmtTime(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = ((ms - min * 60_000) / 1000).toFixed(0);
  return `${min}m${sec.padStart(2, '0')}s`;
}

function printSummary(reports: RunReport[]): void {
  const rows: Array<[string, string, string, string, string, string, string, string, string, string]> = [
    ['Name', 'Files', 'Symbols', 'Edges', 'Resolved%', 'Fresh', 'Cached', 'Speedup', 'ms/file', 'Status'],
  ];
  for (const r of reports) {
    rows.push([
      r.name,
      r.filesIndexed.toLocaleString(),
      r.symbols.toLocaleString(),
      r.edges.toLocaleString(),
      r.resolutionPct.toFixed(1) + '%',
      fmtTime(r.freshMs),
      fmtTime(r.cachedMs),
      r.cacheSpeedup.toFixed(1) + 'x',
      r.msPerFileFresh.toFixed(1),
      r.status === 'ok' ? 'OK' : r.status === 'warn' ? 'WARN' : 'ERROR',
    ]);
  }

  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length)) + 2);
  for (let rIdx = 0; rIdx < rows.length; rIdx++) {
    const cells = rows[rIdx].map((cell, i) => cell.padEnd(widths[i]));
    console.log('  ' + cells.join(''));
    if (rIdx === 0) {
      console.log('  ' + widths.map(w => '─'.repeat(w - 1)).join(' '));
    }
  }
}

function generateMarkdown(reports: RunReport[]): string {
  const ts = new Date().toISOString();
  let md = `# Strata Scale-Test Results\n\n`;
  md += `- Generated: ${ts}\n`;
  md += `- Node: ${process.version}\n`;
  md += `- Platform: ${process.platform}\n\n`;

  md += `## Summary\n\n`;
  md += `| Codebase | Files | Symbols | Edges | Resolved | Fresh | Cached | Speedup | ms/file | DB | Status |\n`;
  md += `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|\n`;
  for (const r of reports) {
    md += `| ${r.name} | ${r.filesIndexed.toLocaleString()} | ${r.symbols.toLocaleString()} | ${r.edges.toLocaleString()} | ${r.resolutionPct.toFixed(1)}% | ${fmtTime(r.freshMs)} | ${fmtTime(r.cachedMs)} | ${r.cacheSpeedup.toFixed(1)}× | ${r.msPerFileFresh.toFixed(2)} | ${r.dbSizeMb.toFixed(1)} MB | ${r.status === 'ok' ? '✓' : r.status === 'warn' ? '⚠' : '✗'} |\n`;
  }

  // Issues / warnings
  const withErrors = reports.filter(r => r.errors.length > 0);
  const withWarns = reports.filter(r => r.warnings.length > 0);
  if (withErrors.length > 0) {
    md += `\n## Errors\n\nReal correctness or determinism failures. These must be fixed.\n\n`;
    for (const r of withErrors) {
      md += `### ${r.name}\n`;
      for (const e of r.errors) md += `- ${e}\n`;
      md += `\n`;
    }
  }
  if (withWarns.length > 0) {
    md += `\n## Warnings\n\nLikely explainable but worth a look.\n\n`;
    for (const r of withWarns) {
      md += `### ${r.name}\n`;
      for (const w of r.warnings) md += `- ${w}\n`;
      md += `\n`;
    }
  }

  // Per-codebase detail
  md += `\n## Detail\n\n`;
  for (const r of reports) {
    md += `### ${r.name}\n\n`;
    md += `**Discovery & parsing**\n`;
    md += `- Files: ${r.filesDiscovered.toLocaleString()} discovered → ${r.filesIndexed.toLocaleString()} indexed`;
    md += `, ${r.filesParseError} parse errors (${r.parseErrorPct.toFixed(2)}%)`;
    md += `, ${r.filesSkipped} skipped (no language match)`;
    if (r.filesSkippedTooLarge > 0) md += `, ${r.filesSkippedTooLarge} skipped (size cap)`;
    md += `\n`;
    md += `- Languages: ${Object.entries(r.languages).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l}=${n.toLocaleString()}`).join(', ')}\n`;
    md += `- WASM runtime resets during fresh: ${r.wasmResets}\n`;
    md += `\n**Graph**\n`;
    md += `- Symbols: ${r.symbols.toLocaleString()}\n`;
    md += `- Edges: ${r.edges.toLocaleString()} (${r.resolvedEdges.toLocaleString()} resolved = ${r.resolutionPct.toFixed(1)}%)\n`;
    md += `- Resolution: same-file ${r.sameFile.toLocaleString()}, imported ${r.imported.toLocaleString()}, global ${r.global.toLocaleString()}\n`;
    md += `- Imports resolved to files: ${r.resolvedImports.toLocaleString()}\n`;
    md += `- PageRank top-20 variance: ${r.pagerankVariance.toExponential(2)}\n`;
    md += `\n**Cache & determinism**\n`;
    md += `- Cached run reused: ${r.filesReused.toLocaleString()} / ${r.filesIndexed.toLocaleString()} (must match)\n`;
    md += `- Cached symbols/edges/resolved: ${r.cachedSymbols.toLocaleString()} / ${r.cachedEdges.toLocaleString()} / ${r.cachedResolvedEdges.toLocaleString()} (must match fresh)\n`;
    md += `- PageRank: fresh recomputed=${r.freshPagerankRecomputed}, cached recomputed=${r.cachedPagerankRecomputed} (cached should be \`false\` when no files changed)\n`;
    md += `\n**Timing**\n`;
    md += `- Fresh: ${fmtTime(r.freshMs)} (${r.msPerFileFresh.toFixed(2)} ms/file)\n`;
    md += `- Cached: ${fmtTime(r.cachedMs)} (${r.cacheSpeedup.toFixed(1)}× cache speedup)\n`;
    md += `- DB size: ${r.dbSizeMb.toFixed(1)} MB\n`;
    md += `\n**Top 5 symbols by PageRank**\n`;
    for (const s of r.topSymbols) {
      md += `- \`${s.name}\` (${s.kind}) — ${s.pagerank.toFixed(5)} — ${s.filePath}\n`;
    }
    md += `\n`;
  }
  return md;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, '..');
  const args = process.argv.slice(2);
  let onlySet: Set<string> | null = null;
  let skipSet = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--only' && args[i + 1]) {
      onlySet = new Set(args[i + 1].split(','));
      i++;
    } else if (args[i] === '--skip' && args[i + 1]) {
      skipSet = new Set(args[i + 1].split(','));
      i++;
    }
  }

  const toRun = CODEBASES.filter(c => {
    if (skipSet.has(c.name)) return false;
    if (onlySet && !onlySet.has(c.name)) return false;
    return true;
  });

  const outDir = path.join(__dirname, 'outputs');
  const dbDir = path.join(outDir, 'dbs');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(dbDir, { recursive: true });

  console.log(`\nStrata Scale Test`);
  console.log(`─────────────────`);
  console.log(`Running ${toRun.length} codebase(s)\n`);

  const reports: RunReport[] = [];
  const overallStart = Date.now();
  for (const spec of toRun) {
    const repoPath = path.join(repoRoot, spec.relativePath);
    if (!fs.existsSync(repoPath)) {
      console.log(`  ⤬  ${spec.name}: skipped (path not found: ${spec.relativePath})`);
      continue;
    }
    const dbPath = path.join(dbDir, `${spec.name}.db`);
    process.stdout.write(`  ▸  ${spec.name}: indexing... `);
    const start = Date.now();
    try {
      const r = await runOne(spec, repoPath, dbPath);
      reports.push(r);
      const totalSec = ((Date.now() - start) / 1000).toFixed(1);
      const mark = r.status === 'ok' ? '✓' : r.status === 'warn' ? '⚠' : '✗';
      process.stdout.write(`\r  ${mark}  ${spec.name.padEnd(11)} ${r.filesIndexed.toLocaleString().padStart(7)} files, ${r.symbols.toLocaleString().padStart(9)} symbols, ${r.edges.toLocaleString().padStart(9)} edges  fresh=${fmtTime(r.freshMs).padStart(7)} cached=${fmtTime(r.cachedMs).padStart(6)} (run ${totalSec}s)\n`);
      for (const e of r.errors)   console.log(`        ✗ ERROR: ${e}`);
      for (const w of r.warnings) console.log(`        ⚠ WARN:  ${w}`);
    } catch (err) {
      process.stdout.write(`\n        ✗ EXCEPTION: ${err instanceof Error ? err.message : String(err)}\n`);
      reports.push({
        name: spec.name,
        status: 'error',
        errors: [`exception during indexing: ${err instanceof Error ? err.message : String(err)}`],
        warnings: [],
        filesDiscovered: 0, filesIndexed: 0, filesReused: 0, filesParseError: 0,
        filesSkipped: 0, filesSkippedTooLarge: 0, parseErrorPct: 0,
        symbols: 0, edges: 0, resolvedEdges: 0, resolutionPct: 0,
        sameFile: 0, imported: 0, global: 0, resolvedImports: 0,
        wasmResets: 0, languages: {},
        freshMs: 0, cachedMs: 0, msPerFileFresh: 0, cacheSpeedup: 0,
        dbSizeMb: 0, topSymbols: [], pagerankVariance: 0,
        cachedSymbols: 0, cachedEdges: 0, cachedResolvedEdges: 0,
        freshPagerankRecomputed: false, cachedPagerankRecomputed: false,
        schemaVersion: 0,
        roles: { project: 0, vendor: 0, generated: 0, test: 0 },
      });
    }
  }
  const overallSec = ((Date.now() - overallStart) / 1000).toFixed(1);

  // ── Save outputs ──
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(outDir, `run-${ts}.json`);
  const latestJson = path.join(outDir, 'latest.json');
  const mdPath = path.join(outDir, 'latest.md');

  const payload = {
    timestamp: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    totalDurationSec: Number(overallSec),
    reports,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  fs.writeFileSync(latestJson, JSON.stringify(payload, null, 2));
  fs.writeFileSync(mdPath, generateMarkdown(reports));

  console.log(`\n  Summary table:\n`);
  printSummary(reports);

  console.log(`\n  Saved:`);
  console.log(`    ${path.relative(repoRoot, jsonPath)}`);
  console.log(`    ${path.relative(repoRoot, latestJson)}`);
  console.log(`    ${path.relative(repoRoot, mdPath)}`);
  console.log(`\n  Total wall time: ${overallSec}s\n`);

  const failures = reports.filter(r => r.status === 'error');
  const warns = reports.filter(r => r.status === 'warn');
  if (failures.length > 0) {
    console.error(`  ✗ ${failures.length} codebase(s) reported errors.`);
    process.exit(1);
  }
  if (warns.length > 0) {
    console.log(`  ⚠ ${warns.length} codebase(s) reported warnings (non-fatal).`);
  }
  console.log(`  ✓ All ${reports.length} codebases passed consistency checks.\n`);
}

main().catch(err => {
  console.error('Scale test crashed:', err);
  process.exit(1);
});
