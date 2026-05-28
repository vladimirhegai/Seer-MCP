#!/usr/bin/env node
import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import { Indexer } from '../indexer/index.js';
import { Store } from '../db/store.js';

const VERSION = '0.1.0';

function resolveDb(repoPath: string, customDb?: string): string {
  if (customDb) return path.resolve(customDb);
  const strataDir = path.join(path.resolve(repoPath), '.strata');
  if (!fs.existsSync(strataDir)) fs.mkdirSync(strataDir, { recursive: true });
  return path.join(strataDir, 'graph.db');
}

function openStore(dbPath: string, mutable = false): Store {
  if (!fs.existsSync(dbPath)) {
    console.error(`No index found at ${dbPath}. Run "strata index <path>" first.`);
    process.exit(1);
  }
  return mutable ? new Store(dbPath) : Store.openReadOnly(dbPath);
}

// ── Program ────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('strata')
  .description('Local-first AI codebase explainer')
  .version(VERSION);

// ── strata index ───────────────────────────────────────────────────────────────

program
  .command('index <repo-path>')
  .description('Index a repository into a local SQLite graph')
  .option('--db <path>', 'Custom database path (default: <repo>/.strata/graph.db)')
  .option('-v, --verbose', 'Show per-file progress')
  .option('--reset', 'Delete existing index before re-indexing')
  .option('--max-file-kb <kb>', 'Skip files larger than this (KiB). 0 = no cap (default).', '0')
  .option('--include-vendor', 'Index vendor/ vendored/ thirdparty/ directories')
  .option('--include-generated', 'Index *.generated.* / *.pb.* / *.gen.* files')
  .option('--mode <mode>', 'Discovery mode: full | standard | fast (default: standard).', 'standard')
  .action(async (repoPath: string, opts: { db?: string; verbose?: boolean; reset?: boolean; maxFileKb: string; includeVendor?: boolean; includeGenerated?: boolean; mode?: string }) => {
    const absRepo = path.resolve(repoPath);
    if (!fs.existsSync(absRepo)) {
      console.error(`Path not found: ${absRepo}`);
      process.exit(1);
    }
    const dbPath = resolveDb(absRepo, opts.db);
    if (opts.reset && fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
      console.log(`  Removed existing index: ${dbPath}`);
    }
    console.log(`\nStrata Index`);
    console.log(`  Repo:  ${absRepo}`);
    console.log(`  DB:    ${dbPath}\n`);
    const store = new Store(dbPath);
    const indexer = new Indexer(store);
    try {
      const maxKb = parseInt(opts.maxFileKb, 10);
      const maxFileBytes = isNaN(maxKb) || maxKb <= 0 ? 0 : maxKb * 1024;
      const mode = parseMode(opts.mode);
      const result = await indexer.indexDirectory(absRepo, {
        verbose: opts.verbose,
        reset: opts.reset,
        maxFileBytes,
        includeVendor: opts.includeVendor,
        includeGenerated: opts.includeGenerated,
        mode,
      });
      console.log(`\n  ✓ Indexed ${result.filesIndexed.toLocaleString()} files`);
      if (result.filesReusedFromCache > 0) console.log(`    ${result.filesReusedFromCache.toLocaleString()} reused from cache`);
      if (result.filesSkipped > 0)         console.log(`    ${result.filesSkipped.toLocaleString()} skipped`);
      if (result.filesSkippedTooLarge > 0) console.log(`    ${result.filesSkippedTooLarge.toLocaleString()} skipped (too large)`);
      if (result.filesParseError > 0)      console.log(`    ${result.filesParseError.toLocaleString()} parse errors`);
      if (result.wasmResets > 0)           console.log(`    ${result.wasmResets} WASM reset(s)`);
      console.log(`  ✓ ${result.symbols.toLocaleString()} symbols`);
      console.log(`  ✓ ${result.edges.toLocaleString()} edges (${result.resolvedEdges.toLocaleString()} resolved)`);
      console.log(`  ✓ ${result.resolvedImports.toLocaleString()} imports resolved`);
      if ((result.routesResolved ?? 0) > 0)      console.log(`  ✓ ${result.routesResolved} routes linked to handlers`);
      if ((result.testEdgesAdded ?? 0) > 0)      console.log(`  ✓ ${result.testEdgesAdded} test edges synthesized`);
      if ((result.externalDependencies ?? 0) > 0)console.log(`  ✓ ${result.externalDependencies} external deps`);
      if (result.pagerankRecomputed) console.log(`  ✓ PageRank computed`);
      else                            console.log(`  ↻ PageRank reused (graph unchanged)`);
      console.log(`\n  Done in ${(result.elapsedMs / 1000).toFixed(1)}s`);
    } finally {
      store.close();
    }
  });

// ── strata callers / callees / symbols / stats / health ──────────────────────────

program
  .command('callers <symbol>')
  .description('Find all callers of a symbol')
  .option('--db <path>', 'Database path')
  .option('-n, --limit <n>', 'Max results', '40')
  .action((symbol: string, opts: { db?: string; limit: string }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const total = store.countCallers(symbol);
      if (total === 0) { console.log(`No callers found for "${symbol}"`); return; }
      const limit = Math.max(1, parseInt(opts.limit, 10) || 40);
      const callers = store.findCallers(symbol, limit);
      console.log(`\nCallers of '${symbol}'  (${total} found)\n`);
      for (const c of callers) {
        const loc = `${c.callerFile}:${c.callerLine + 1}`;
        console.log(`  ${c.callerName.padEnd(32)} ${c.callerKind.padEnd(12)} ${loc}`);
      }
      if (total > callers.length) console.log(`  … and ${total - callers.length} more`);
    } finally { store.close(); }
  });

program
  .command('callees <symbol>')
  .description('Find all symbols called by a symbol')
  .option('--db <path>', 'Database path')
  .option('-n, --limit <n>', 'Max results', '40')
  .action((symbol: string, opts: { db?: string; limit: string }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const callees = store.findCallees(symbol);
      if (callees.length === 0) { console.log(`No callees found for "${symbol}"`); return; }
      console.log(`\nCallees of '${symbol}'  (${callees.length} found)\n`);
      const limit = Math.min(parseInt(opts.limit, 10), callees.length);
      for (const c of callees.slice(0, limit)) {
        const loc = c.calleeFile ? `${c.calleeFile}:${(c.calleeLineStart ?? 0) + 1}` : '(unresolved)';
        const kind = c.calleeKind ?? '?';
        console.log(`  ${c.calleeName.padEnd(32)} ${kind.padEnd(12)} ${loc}`);
      }
      if (callees.length > limit) console.log(`  … and ${callees.length - limit} more`);
    } finally { store.close(); }
  });

program
  .command('symbols [query]')
  .description('Search symbols by name, or list top symbols by PageRank')
  .option('--db <path>', 'Database path')
  .option('--file <path>', 'Filter to symbols in a specific file')
  .option('-n, --top <n>', 'Show top N symbols by PageRank (default: 20)', '20')
  .action((query: string | undefined, opts: { db?: string; file?: string; top: string }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const limit = parseInt(opts.top, 10);
      let symbols;
      if (opts.file) { symbols = store.listSymbolsInFile(opts.file, limit); console.log(`\nSymbols in ${opts.file}\n`); }
      else if (query) { symbols = store.findSymbols(query); console.log(`\nSymbols matching '${query}'\n`); }
      else { symbols = store.getTopSymbols(limit); console.log(`\nTop ${limit} symbols by PageRank\n`); }
      if (symbols.length === 0) { console.log('  (none found)'); return; }
      console.log(`  ${'Name'.padEnd(32)} ${'Kind'.padEnd(12)} ${'Line'.padEnd(6)} ${'PageRank'.padEnd(10)} File`);
      console.log('  ' + '─'.repeat(90));
      for (const s of symbols) {
        const pr = s.pagerank.toFixed(4);
        const loc = String(s.lineStart + 1).padEnd(6);
        const relFile = s.filePath.replace(/\\/g, '/');
        console.log(`  ${s.name.padEnd(32)} ${s.kind.padEnd(12)} ${loc} ${pr.padEnd(10)} ${relFile}`);
      }
    } finally { store.close(); }
  });

program
  .command('stats')
  .description('Show index statistics')
  .option('--db <path>', 'Database path')
  .action((opts: { db?: string }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const stats = store.getStats();
      console.log('\nStrata Index Stats');
      console.log('──────────────────');
      console.log(`  Files:           ${stats.files.toLocaleString()}`);
      console.log(`  Symbols:         ${stats.symbols.toLocaleString()}`);
      console.log(`  Edges:           ${stats.edges.toLocaleString()}`);
      console.log(`  Resolved edges:  ${stats.resolvedEdges.toLocaleString()}`);
      if (stats.routes != null)                console.log(`  Routes:          ${stats.routes.toLocaleString()}`);
      if (stats.externalDependencies != null)  console.log(`  External deps:   ${stats.externalDependencies.toLocaleString()}`);
      if (stats.configKeys != null)            console.log(`  Config keys:     ${stats.configKeys.toLocaleString()}`);
      if (stats.symbolHistory != null)         console.log(`  Symbol history:  ${stats.symbolHistory.toLocaleString()}`);
      console.log(`  Languages:`);
      for (const [lang, count] of Object.entries(stats.languages).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${lang.padEnd(14)} ${count}`);
      }
      console.log(`\n  DB: ${dbPath}`);
    } finally { store.close(); }
  });

program
  .command('health')
  .description('Show Strata index health')
  .option('--db <path>', 'Database path')
  .action((opts: { db?: string }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const schema = store.schemaInfo();
      const stats = store.getStats();
      console.log('\nStrata Health');
      console.log('─────────────');
      console.log(`  DB path:           ${dbPath}`);
      console.log(`  Read-only:         ${store.isReadOnly()}`);
      console.log(`  Schema version:    ${schema.dbVersion} (build expects ${schema.buildVersion})`);
      if (!schema.current) console.log(`  ⚠  Schema is behind. Run \`strata index <path>\` to migrate.`);
      else                  console.log(`  ✓  Schema is up to date.`);
      console.log(`  Files:             ${stats.files.toLocaleString()}`);
      console.log(`  Symbols:           ${stats.symbols.toLocaleString()}`);
      console.log(`  Edges:             ${stats.edges.toLocaleString()} (${stats.resolvedEdges.toLocaleString()} resolved)`);
      if (stats.roles) {
        const t = stats.roles.project + stats.roles.vendor + stats.roles.generated + stats.roles.test;
        console.log(`  File roles:        project ${stats.roles.project}  vendor ${stats.roles.vendor}  generated ${stats.roles.generated}  test ${stats.roles.test}  (${t} total)`);
      }
      if (stats.routes != null && stats.routes > 0)               console.log(`  Routes:            ${stats.routes.toLocaleString()}`);
      if (stats.externalDependencies != null && stats.externalDependencies > 0) console.log(`  External deps:     ${stats.externalDependencies.toLocaleString()}`);
      if (stats.configKeys != null && stats.configKeys > 0)       console.log(`  Config keys:       ${stats.configKeys.toLocaleString()}`);
      if (stats.symbolHistory != null && stats.symbolHistory > 0) console.log(`  Symbol history:    ${stats.symbolHistory.toLocaleString()} rows`);
    } finally { store.close(); }
  });

// ── strata routes ──────────────────────────────────────────────────────────────

program
  .command('routes')
  .description('List HTTP routes detected in the codebase')
  .option('--db <path>', 'Database path')
  .option('--method <m>', 'Filter by HTTP method (GET/POST/...)')
  .option('--framework <f>', 'Filter by framework (express/fastapi/flask/spring)')
  .option('--path <substr>', 'Filter by path substring')
  .option('-n, --limit <n>', 'Max results', '50')
  .action((opts: { db?: string; method?: string; framework?: string; path?: string; limit: string }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const rows = store.listRoutes({
        method: opts.method,
        framework: opts.framework,
        pathSubstr: opts.path,
        limit: parseInt(opts.limit, 10) || 50,
      });
      if (rows.length === 0) { console.log('No routes found.'); return; }
      console.log(`\nRoutes (${rows.length} shown)\n`);
      for (const r of rows) {
        const h = r.handlerSymbol ? `→ ${r.handlerSymbol}` : (r.handlerName ? `→ ${r.handlerName} (unresolved)` : '');
        console.log(`  ${r.method.padEnd(6)} ${r.path.padEnd(40)} ${r.framework.padEnd(10)} ${h}`);
      }
    } finally { store.close(); }
  });

// ── strata deps ────────────────────────────────────────────────────────────────

program
  .command('deps')
  .description('List external dependencies declared in manifests')
  .option('--db <path>', 'Database path')
  .option('--ecosystem <e>', 'Filter (npm/cargo/pypi/go)')
  .option('--name <substr>', 'Filter by name substring')
  .option('-n, --limit <n>', 'Max results', '100')
  .action((opts: { db?: string; ecosystem?: string; name?: string; limit: string }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const rows = store.listExternalDeps({
        ecosystem: opts.ecosystem, nameSubstr: opts.name,
        limit: parseInt(opts.limit, 10) || 100,
      });
      if (rows.length === 0) { console.log('No external dependencies indexed.'); return; }
      console.log(`\nExternal dependencies (${rows.length} shown)\n`);
      for (const r of rows) {
        console.log(`  ${r.ecosystem.padEnd(8)} ${r.name.padEnd(40)} ${r.versionRange ?? ''}${r.isDev ? ' (dev)' : ''}`);
      }
    } finally { store.close(); }
  });

// ── strata config ──────────────────────────────────────────────────────────────

program
  .command('config')
  .description('List config / env reads detected in the codebase')
  .option('--db <path>', 'Database path')
  .option('--key <substr>', 'Filter by key substring')
  .option('-n, --limit <n>', 'Max results', '50')
  .action((opts: { db?: string; key?: string; limit: string }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const rows = store.listConfigKeys({ key: opts.key, limit: parseInt(opts.limit, 10) || 50 });
      if (rows.length === 0) { console.log('No config keys indexed.'); return; }
      console.log(`\nConfig keys (${rows.length} shown)\n`);
      for (const r of rows) {
        console.log(`  ${r.source.padEnd(6)} ${r.key.padEnd(30)} ${r.filePath}:${r.line + 1} ${r.symbolName ?? ''}`);
      }
    } finally { store.close(); }
  });

// ── strata churn (file-level git churn pass) ──────────────────────────────────

program
  .command('churn')
  .description('Collect file-level git churn (commits, last commit, top authors)')
  .option('--db <path>', 'Database path')
  .option('--workspace <path>', 'Workspace path (defaults to cwd)')
  .action(async (opts: { db?: string; workspace?: string }) => {
    const workspace = path.resolve(opts.workspace ?? process.cwd());
    const dbPath = opts.db ?? findDbFromCwd();
    if (!fs.existsSync(dbPath)) { console.error(`No index at ${dbPath}`); process.exit(1); }
    const store = new Store(dbPath);
    try {
      const { collectChurn } = await import('../indexer/churn.js');
      const r = await collectChurn(workspace, store);
      console.log(`\nChurn pass: ${r.filesWithChurn}/${r.filesAnalyzed} files have history (HEAD ${r.headSha?.slice(0, 8) ?? '—'}), ${r.elapsedMs}ms`);
    } finally { store.close(); }
  });

// ── strata history (Track D) ──────────────────────────────────────────────────

program
  .command('history <symbol>')
  .description('Show per-symbol commit history (requires `strata symbol-history` to have run)')
  .option('--db <path>', 'Database path')
  .option('-n, --limit <n>', 'Max commits', '20')
  .action((symbol: string, opts: { db?: string; limit: string }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const matches = store.getDefinition(symbol);
      if (matches.length === 0) { console.log(`No symbol named "${symbol}"`); return; }
      const limit = parseInt(opts.limit, 10) || 20;
      for (const m of matches.slice(0, 3)) {
        const history = store.getSymbolHistory(m.id, { limit });
        const total = store.countSymbolHistory(m.id);
        console.log(`\n${m.qualifiedName ?? m.name}  (${m.kind})  ${m.filePath}:${m.lineStart + 1}`);
        if (history.length === 0) { console.log(`  (no history — run \`strata symbol-history\` first)`); continue; }
        console.log(`  ${total} commits in history${total > history.length ? ` (showing ${history.length})` : ''}`);
        for (const h of history) {
          const date = new Date(h.committedAt * 1000).toISOString().slice(0, 10);
          const author = h.authorName ?? '?';
          const pr = h.prNumber ? ` #${h.prNumber}` : '';
          const msg = (h.message ?? '').split('\n')[0].slice(0, 60);
          console.log(`    ${h.commitSha.slice(0, 8)}  ${date}  +${h.linesAdded}/-${h.linesRemoved}${pr}  ${author.padEnd(20)} ${msg}`);
        }
      }
    } finally { store.close(); }
  });

program
  .command('symbol-history')
  .description('Index per-symbol git history (opt-in; can take a few minutes)')
  .option('--db <path>', 'Database path')
  .option('--workspace <path>', 'Workspace path (defaults to cwd)')
  .option('--max-commits <n>', 'Max commits per file', '200')
  .option('--force', 'Re-run even if HEAD unchanged')
  .action(async (opts: { db?: string; workspace?: string; maxCommits: string; force?: boolean }) => {
    const workspace = path.resolve(opts.workspace ?? process.cwd());
    const dbPath = opts.db ?? findDbFromCwd();
    if (!fs.existsSync(dbPath)) { console.error(`No index at ${dbPath}`); process.exit(1); }
    const store = new Store(dbPath);
    try {
      const { buildSymbolHistory } = await import('../indexer/symbolhistory.js');
      const r = await buildSymbolHistory(workspace, store, {
        maxCommitsPerFile: parseInt(opts.maxCommits, 10) || 200,
        skipIfHeadUnchanged: !opts.force,
        log: (m) => console.log(`  ${m}`),
      });
      console.log(`\nSymbol history: ${r.historyRowsInserted} rows across ${r.filesProcessed} files (${r.elapsedMs}ms)`);
    } finally { store.close(); }
  });

// ── strata architecture ──────────────────────────────────────────────────────

program
  .command('architecture')
  .alias('arch')
  .description('Show a one-page architecture snapshot of the codebase')
  .option('--db <path>', 'Database path')
  .action(async (opts: { db?: string }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const { buildArchitecture } = await import('../indexer/architecture.js');
      const a = buildArchitecture(path.dirname(path.dirname(dbPath)), store);
      console.log(`\nArchitecture snapshot`);
      console.log(`─────────────────────`);
      console.log(`  Workspace: ${a.workspace}`);
      console.log(`  Totals:    files=${a.totals.files}  symbols=${a.totals.symbols}  edges=${a.totals.edges}  routes=${a.totals.routes}  deps=${a.totals.externalDependencies}  configKeys=${a.totals.configKeys}`);
      console.log(`\n  Languages:`);
      for (const l of a.languages) console.log(`    ${l.language.padEnd(14)} files=${l.files}  symbols=${l.symbols}`);
      console.log(`\n  Top modules:`);
      for (const m of a.topModules) console.log(`    ${m.name.padEnd(20)} files=${m.files}  symbols=${m.symbols}`);
      console.log(`\n  Top symbols:`);
      for (const s of a.topSymbols.slice(0, 10)) console.log(`    ${s.pagerank.toFixed(4)}  ${(s.qualifiedName ?? s.name).padEnd(40)} (${s.kind})`);
      if (a.entryPoints.length > 0) { console.log(`\n  Entry points:`); for (const e of a.entryPoints) console.log(`    ${(e.qualifiedName ?? e.name).padEnd(30)} ${e.file}`); }
      if (a.hotspots.length > 0)    { console.log(`\n  Hotspots:`);    for (const h of a.hotspots.slice(0, 10)) console.log(`    ${h.commits.toString().padStart(5)} commits  ${h.file}`); }
      if (a.routes.total > 0) console.log(`\n  Routes by framework: ${JSON.stringify(a.routes.byFramework)}`);
    } finally { store.close(); }
  });

// ── strata detect-changes ────────────────────────────────────────────────────

program
  .command('detect-changes')
  .description('Show blast radius of an uncommitted (or between-refs) diff')
  .option('--db <path>', 'Database path')
  .option('--workspace <path>', 'Workspace path (defaults to cwd)')
  .option('--from <ref>', 'From ref (default: working tree)')
  .option('--to <ref>', 'To ref')
  .option('--depth <n>', 'Reverse-caller depth', '2')
  .action(async (opts: { db?: string; workspace?: string; from?: string; to?: string; depth: string }) => {
    const workspace = path.resolve(opts.workspace ?? process.cwd());
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const { detectChanges } = await import('../indexer/detectchanges.js');
      const r = detectChanges(workspace, store, {
        fromRef: opts.from, toRef: opts.to,
        callerDepth: parseInt(opts.depth, 10) || 2,
      });
      console.log(`\nDetected ${r.changedFiles.length} changed file(s), ${r.directlyChanged.length} directly-changed symbol(s)`);
      for (const f of r.changedFiles) {
        console.log(`\n  ${f.path}  (${f.hunks} hunk(s))`);
        for (const s of f.symbols) {
          console.log(`    → ${(s.symbol.qualifiedName ?? s.symbol.name).padEnd(40)} ${s.symbol.kind}`);
        }
      }
      if (r.transitivelyAffected.length > 0) {
        console.log(`\n  Transitively-affected (top 15 by PageRank):`);
        for (const s of r.transitivelyAffected.slice(0, 15)) {
          console.log(`    ${s.pagerank.toFixed(4)}  ${(s.qualifiedName ?? s.name).padEnd(40)} ${s.kind}  ${s.filePath}`);
        }
      }
      console.log(`\n  ${r.elapsedMs}ms`);
    } finally { store.close(); }
  });

// ── strata mcp ─────────────────────────────────────────────────────────────────

program
  .command('mcp')
  .description('Run an MCP server (stdio JSON-RPC) over the index.')
  .option('--workspace <path>', 'Workspace path (defaults to current directory)')
  .option('--db <path>', 'Custom database path')
  .option('--no-watch', 'Disable the background file watcher')
  .option('--no-jit', 'Disable JIT freshness checks before each query')
  .action(async (opts: { workspace?: string; db?: string; watch?: boolean; jit?: boolean }) => {
    const workspace = path.resolve(opts.workspace ?? process.cwd());
    if (!fs.existsSync(workspace)) { console.error(`Workspace not found: ${workspace}`); process.exit(1); }
    const { runMcp } = await import('../mcp/server.js');
    await runMcp({
      workspace,
      dbPath: opts.db,
      watch: opts.watch !== false,
      jit: opts.jit !== false,
    });
  });

// ── DB auto-detection ──────────────────────────────────────────────────────────

function parseMode(input: string | undefined): 'full' | 'standard' | 'fast' | undefined {
  if (!input) return undefined;
  const v = input.toLowerCase();
  if (v === 'full' || v === 'standard' || v === 'fast') return v;
  console.error(`Invalid --mode: ${input}.`);
  process.exit(1);
}

function findDbFromCwd(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, '.strata', 'graph.db');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  console.error('Could not find .strata/graph.db. Run "strata index <path>" first.');
  process.exit(1);
}

program.parse(process.argv);
