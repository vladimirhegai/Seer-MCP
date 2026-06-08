#!/usr/bin/env node
import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import { Indexer } from '../indexer/index.js';
import { Store } from '../db/store.js';
import { rankedBehavior } from '../indexer/behavior.js';
import { computeRisk } from '../indexer/risk.js';
import { buildContext } from '../indexer/context.js';
import { computeCoupling } from '../indexer/coupling.js';
import { attachCallSiteSnippets } from '../indexer/snippets.js';
import { runInit, runUpdate, runUninstall, detectAutoClients, detectActiveClient, detectConfiguredClients, ClientId } from './init.js';
import { runInitWizard, isInteractive } from './prompt.js';

// Read the version from package.json at runtime so it never drifts from the
// published release the way a hardcoded literal does. `__dirname` resolves to
// dist/cli (built) or src/cli (tsx/dev); `../../package.json` is the package
// root in both, and npm always ships package.json regardless of the `files`
// allowlist. Falls back to a literal if the file can't be read.
const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch { /* fall through to the literal below */ }
  return '0.1.15';
})();

const KNOWN_CLIENTS: ClientId[] = ['claude', 'cursor', 'vscode', 'codex', 'gemini', 'antigravity', 'windsurf'];

function parseClientList(raw: string | undefined): ClientId[] | undefined {
  if (!raw) return undefined;
  const names = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (names.includes('all')) return KNOWN_CLIENTS;
  const bad = names.filter((n) => !KNOWN_CLIENTS.includes(n as ClientId));
  if (bad.length) {
    console.error(`Unknown client(s): ${bad.join(', ')}. Known: ${KNOWN_CLIENTS.join(', ')}, all`);
    process.exit(1);
  }
  return names as ClientId[];
}

function resolveDb(repoPath: string, customDb?: string): string {
  if (customDb) {
    const resolved = path.resolve(customDb);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return resolved;
  }
  const seerDir = path.join(path.resolve(repoPath), '.seer');
  if (!fs.existsSync(seerDir)) fs.mkdirSync(seerDir, { recursive: true });
  return path.join(seerDir, 'graph.db');
}

function openStore(dbPath: string, mutable = false): Store {
  if (!fs.existsSync(dbPath)) {
    console.error(`No index found at ${dbPath}. Run "seer index <path>" first.`);
    process.exit(1);
  }
  return mutable ? new Store(dbPath) : Store.openReadOnly(dbPath);
}

//  Program

const program = new Command();

program
  .name('seer')
  .description('Pre-edit impact context for AI coding agents')
  .version(VERSION);

//  seer index

program
  .command('index <repo-path>')
  .description('Index a repository into a local SQLite graph')
  .option('--db <path>', 'Custom database path (default: <repo>/.seer/graph.db)')
  .option('-v, --verbose', 'Show per-file progress')
  .option('--reset', 'Delete existing index before re-indexing')
  .option('--max-file-kb <kb>', 'Skip files larger than this (KiB). 0 = no cap (default).', '0')
  .option('--include-vendor', 'Index vendor/ vendored/ thirdparty/ directories')
  .option('--include-generated', 'Index *.generated.* / *.pb.* / *.gen.* files')
  .option('--mode <mode>', 'Discovery mode: full | standard | fast (default: standard).', 'standard')
  .option('--parallel', 'Force worker-thread parsing even for tiny repositories')
  .option('--no-parallel', 'Disable worker-thread parsing; auto mode uses workers for normal/large repos')
  .option('--jobs <n>', 'Worker thread count when worker parsing is active (default: cores - 1, capped at 8)')
  .option('--no-history-refresh', 'Skip the incremental symbol-history refresh after indexing (only runs if history was already built)')
  .action(async (repoPath: string, opts: { db?: string; verbose?: boolean; reset?: boolean; maxFileKb: string; includeVendor?: boolean; includeGenerated?: boolean; mode?: string; parallel?: boolean; jobs?: string; historyRefresh?: boolean }) => {
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
    const maxKb = parseInt(opts.maxFileKb, 10);
    const jobsN = opts.jobs ? parseInt(opts.jobs, 10) : undefined;
    await performIndex(absRepo, dbPath, {
      verbose: opts.verbose,
      reset: opts.reset,
      maxFileBytes: isNaN(maxKb) || maxKb <= 0 ? 0 : maxKb * 1024,
      includeVendor: opts.includeVendor,
      includeGenerated: opts.includeGenerated,
      mode: parseMode(opts.mode),
      parallel: opts.parallel,
      jobs: jobsN != null && !isNaN(jobsN) && jobsN > 0 ? jobsN : undefined,
      historyRefresh: opts.historyRefresh,
    });
  });

interface PerformIndexOpts {
  verbose?: boolean;
  reset?: boolean;
  maxFileBytes?: number;
  includeVendor?: boolean;
  includeGenerated?: boolean;
  mode?: 'full' | 'standard' | 'fast';
  parallel?: boolean;
  jobs?: number;
  historyRefresh?: boolean;
}

/**
 * Index a repo into its SQLite graph and print a human report. Shared by the
 * `index` command and the interactive `init` wizard so both behave identically.
 */
async function performIndex(absRepo: string, dbPath: string, opts: PerformIndexOpts): Promise<void> {
  console.log(`\nSeer Index`);
  console.log(`  Repo:  ${absRepo}`);
  console.log(`  DB:    ${dbPath}\n`);
  const store = new Store(dbPath);
  const indexer = new Indexer(store);
  try {
    const result = await indexer.indexDirectory(absRepo, {
      verbose: opts.verbose,
      reset: opts.reset,
      maxFileBytes: opts.maxFileBytes ?? 0,
      includeVendor: opts.includeVendor,
      includeGenerated: opts.includeGenerated,
      mode: opts.mode,
      parallel: opts.parallel,
      jobs: opts.jobs,
    });
    console.log(`\n   Indexed ${result.filesIndexed.toLocaleString()} files`);
    if (result.filesReusedFromCache > 0) console.log(`    ${result.filesReusedFromCache.toLocaleString()} reused from cache`);
    if (result.filesSkipped > 0)         console.log(`    ${result.filesSkipped.toLocaleString()} skipped`);
    if (result.filesSkippedTooLarge > 0) console.log(`    ${result.filesSkippedTooLarge.toLocaleString()} skipped (too large)`);
    if (result.filesParseError > 0)      console.log(`    ${result.filesParseError.toLocaleString()} parse errors`);
    if (result.wasmResets > 0)           console.log(`    ${result.wasmResets} WASM reset(s)`);
    console.log(`   ${result.symbols.toLocaleString()} symbols`);
    console.log(`   ${result.edges.toLocaleString()} edges (${result.resolvedEdges.toLocaleString()} resolved)`);
    console.log(`   ${result.resolvedImports.toLocaleString()} imports resolved`);
    if ((result.routesResolved ?? 0) > 0)      console.log(`   ${result.routesResolved} routes linked to handlers`);
    if ((result.testEdgesAdded ?? 0) > 0)      console.log(`   ${result.testEdgesAdded} test edges synthesized`);
    if ((result.externalDependencies ?? 0) > 0)console.log(`   ${result.externalDependencies} external deps`);
    if (result.pagerankRecomputed) console.log(`   PageRank computed`);
    else                            console.log(`   PageRank reused (graph unchanged)`);
    console.log(`\n  Done in ${(result.elapsedMs / 1000).toFixed(1)}s`);

    // Auto-update symbol history: ONLY when a history index already exists
    // (the user opted in by building it before). Re-running buildSymbolHistory
    // is incremental — files whose content is unchanged are resume-skipped, so
    // after a `git pull` + index this just refreshes the handful of files that
    // actually changed (their old rows were already cascade-cleared when their
    // symbols were reindexed). Opt out with --no-history-refresh.
    const histState = store.getGitIndexState();
    if (opts.historyRefresh !== false && histState?.lastHistoryHeadSha) {
      try {
        const { buildSymbolHistory } = await import('../indexer/symbolhistory.js');
        // Replicate the --follow choice from the last full build. This is
        // stored authoritatively in git_index_state.last_history_follow (written
        // by setHistoryHeadSha at full-build completion). Watermarks are NOT used
        // here because scoped/partial builds can leave mixed follow=0/1 rows that
        // make watermark-scanning non-deterministic.
        const followFromState = histState.lastHistoryFollow ?? false;
        // Replicate the same horizon the last full build used (persisted in
        // last_history_since), so the per-file options fingerprint matches and
        // unchanged files stay resume-skipped instead of being reprocessed.
        const sinceFromState = histState.lastHistorySince ?? undefined;
        process.stdout.write(`\n  Refreshing symbol history (incremental)...`);
        const hr = await buildSymbolHistory(absRepo, store, {
          follow: followFromState,
          ...(sinceFromState !== undefined ? { since: sinceFromState } : {}),
          log: () => {},
        });
        if (hr.skipped) console.log(` up to date.`);
        else console.log(` ${hr.historyRowsInserted} rows across ${hr.filesProcessed} changed file(s).`);
      } catch (err) {
        console.log(`\n  (symbol-history refresh skipped: ${(err as Error).message})`);
      }
    }
  } finally {
    store.close();
  }
}

//  seer init

program
  .command('init [workspace]')
  .description('Set up Seer as an MCP server for your AI agents (interactive) and write guidance files')
  .option('--db <path>', 'Custom database path passed through to the MCP launcher')
  .option('--client <names>', 'Comma-separated clients: claude,cursor,vscode,codex,gemini,antigravity,windsurf,all (skips the wizard; "all" includes user-level clients)')
  .option('--auto', 'Workspace-local setup for supported clients; no user-level/global config')
  .option('--global', 'Write user-level config instead of project-local config')
  .option('--npx', 'Emit a portable "npx -y <pkg> mcp" launcher instead of an absolute node path')
  .option('--pkg <name>', 'npm package name used by the --npx launcher', 'seer-mcp')
  .option('--command <cmd>', 'Override the launch command entirely (advanced)')
  .option('--no-agents', 'Do not write agent guidance files')
  .option('--print', 'Print the plan without writing any files')
  .option('--force', 'Overwrite an existing seer entry / agents block')
  .option('-y, --yes', 'Skip the interactive wizard; accept detected defaults non-interactively')
  .action(async (workspace: string | undefined, opts: {
    db?: string; client?: string; auto?: boolean; global?: boolean; npx?: boolean; pkg?: string;
    command?: string; agents?: boolean; print?: boolean; force?: boolean; yes?: boolean;
  }) => {
    const ws = path.resolve(workspace ?? process.cwd());
    if (!fs.existsSync(ws)) { console.error(`Workspace not found: ${ws}`); process.exit(1); }

    let clients = parseClientList(opts.client);

    // Interactive wizard: when a human is at the keyboard and hasn't already
    // pinned the choice down with --client/--global/--print/--yes, ask which
    // agents to set up instead of guessing. Guessing is what wrote .cursor/ and
    // .vscode/ into Antigravity-only repos. The wizard also offers to index now.
    let runIndexAfter = false;
    const wizardEligible = !opts.client && !opts.global && !opts.print && !opts.yes
      && !opts.auto && !opts.command && isInteractive();
    if (wizardEligible) {
      const answers = await runInitWizard(detectActiveClient(ws));
      if (!answers) return; // user bailed out
      clients = answers.clients;
      runIndexAfter = answers.index;
    }

    const result = runInit({
      workspace: ws,
      // When the wizard ran it always returns a non-empty `clients`, so the
      // `auto`/default fallback below is only consulted in non-interactive runs.
      clients,
      auto: opts.auto,
      global: opts.global,
      npx: opts.npx,
      pkg: opts.pkg,
      command: opts.command,
      agents: opts.agents,
      print: opts.print,
      force: opts.force,
      db: opts.db,
    });

    console.log(`\nSeer Init  ${opts.print ? '(dry run - nothing written)' : ''}`);
    console.log(`  Workspace: ${ws}`);
    console.log(`  Launcher:  ${result.launch.command} ${result.launch.args.join(' ')}\n`);
    if (opts.auto && !opts.client) {
      console.log(`  Auto clients: ${detectAutoClients(ws).join(', ')}\n`);
    }

    const mark: Record<string, string> = opts.print
      ? { wrote: '+ would write ', updated: '~ would update', skipped: '. would skip ', manual: '! manual      ' }
      : { wrote: 'OK wrote ', updated: 'OK updated', skipped: '. skipped', manual: '! manual ' };
    for (const e of result.entries) {
      console.log(`  ${mark[e.action] ?? e.action}  ${e.label.padEnd(28)} ${e.file}`);
      if (e.note) console.log(`             ${e.note}`);
      if (e.snippet && (opts.print || e.action === 'manual')) {
        console.log(e.snippet.split('\n').map((l) => '             ' + l).join('\n'));
      }
    }
    if (result.agents) {
      console.log(`  ${mark[result.agents.action] ?? result.agents.action}  ${result.agents.label.padEnd(28)} ${result.agents.file}`);
    }
    for (const cf of result.contextFiles ?? []) {
      console.log(`  ${mark[cf.action] ?? cf.action}  ${cf.label.padEnd(28)} ${cf.file}`);
    }

    // Run the wizard's opt-in index/history now, after config is written.
    if (runIndexAfter && !opts.print) {
      const dbPath = resolveDb(ws, opts.db);
      try {
        await performIndex(ws, dbPath, {});
      } catch (err) {
        console.log(`\n  (indexing skipped: ${(err as Error).message})`);
      }
    }

    console.log(`\n  Next:`);
    let step = 1;
    if (!runIndexAfter) {
      console.log(`    ${step++}. From this repo, build the index now: npx seer-mcp index .`);
      console.log(`       If you skip this, Seer builds it on the first MCP query.`);
    }
    console.log(`    ${step++}. Reload / restart your agent so it picks up the new MCP server.`);
    console.log(`    ${step++}. Ask your agent to call seer_health to confirm it is connected.\n`);
  });

// seer update

program
  .command('update [workspace]')
  .description('Refresh existing Seer MCP entries and guidance files for this workspace')
  .option('--client <names>', 'Comma-separated clients to target (default: clients that already have seer configured)')
  .option('--global', 'Only refresh user-level configs')
  .option('--no-agents', 'Do not touch guidance files')
  .option('--force', 'Re-point global seer entries even if they are pinned to another workspace')
  .option('--print', 'Dry run: show what would change without writing anything')
  .action((workspace: string | undefined, opts: {
    client?: string; global?: boolean; agents?: boolean; force?: boolean; print?: boolean;
  }) => {
    const ws = path.resolve(workspace ?? process.cwd());
    if (!fs.existsSync(ws)) { console.error(`Workspace not found: ${ws}`); process.exit(1); }

    const clients = parseClientList(opts.client);
    const inferred = clients ?? detectConfiguredClients(ws, { global: opts.global, includePinnedOther: opts.force });
    const result = runUpdate({
      workspace: ws,
      clients: inferred,
      global: opts.global,
      agents: opts.agents,
      force: opts.force,
      print: opts.print,
    });

    console.log(`\nSeer Update  ${opts.print ? '(dry run - nothing written)' : ''}`);
    console.log(`  Workspace: ${ws}`);
    console.log(`  Clients:   ${inferred.length ? inferred.join(', ') : '(none found)'}\n`);

    const mark: Record<string, string> = opts.print
      ? { wrote: '+ would write ', updated: '~ would update', skipped: '. no change  ', manual: '! manual      ' }
      : { wrote: 'OK wrote ', updated: 'OK updated', skipped: '. no change ', manual: '! manual ' };

    for (const e of result.entries) {
      console.log(`  ${mark[e.action] ?? e.action}  ${e.label.padEnd(30)} ${e.file}`);
      if (e.note) console.log(`               ${e.note}`);
    }
    for (const cf of [result.agents, ...(result.contextFiles ?? [])].filter(Boolean) as Array<{ label: string; file: string; action: string }>) {
      console.log(`  ${mark[cf.action] ?? cf.action}  ${cf.label.padEnd(30)} ${cf.file}`);
    }

    if (inferred.length === 0 && !result.agents && !(result.contextFiles ?? []).length) {
      console.log(`  . No Seer install found here. Run "npx seer-mcp init" from the repo.`);
    }
    if (opts.print) {
      console.log(`\n  (Dry run - run without --print to apply)\n`);
    } else if (inferred.length > 0) {
      console.log(`\n  Updated. Restart your agent so it reloads the MCP server.\n`);
    } else {
      console.log('');
    }
  });

// seer uninstall
program
  .command('uninstall [workspace]')
  .description('Remove the Seer MCP entry from every agent config and strip the seer block from guidance files')
  .option('--client <names>', 'Comma-separated clients to target (default: all known clients)')
  .option('--global', 'Target user-level configs instead of project-local ones')
  .option('--no-agents', 'Do not touch guidance files (AGENTS.md, CLAUDE.md, GEMINI.md)')
  .option('--force', 'Remove global seer entries even if they are pinned to another workspace')
  .option('--print', 'Dry run  show what would change without writing anything')
  .option('--remove-db', 'Also delete the .seer/ index directory (irreversible)')
  .action((workspace: string | undefined, opts: {
    client?: string; global?: boolean; agents?: boolean; force?: boolean; print?: boolean; removeDb?: boolean;
  }) => {
    const ws = path.resolve(workspace ?? process.cwd());

    const clients = parseClientList(opts.client);

    const result = runUninstall({
      workspace: ws,
      clients,
      global: opts.global,
      agents: opts.agents,
      force: opts.force,
      print: opts.print,
      removeDb: opts.removeDb,
    });

    console.log(`\nSeer Uninstall  ${opts.print ? '(dry run - nothing written)' : ''}`);
    if (workspace) console.log(`  Workspace: ${ws}`);

    const mark: Record<string, string> = opts.print
      ? { removed: '- would remove', deleted: '- would delete', skipped: '. nothing to do', manual: '! manual      ' }
      : { removed: 'OK removed', deleted: 'OK deleted', skipped: '. nothing to do', manual: '! manual ' };

    const allEntries = [...result.entries, ...result.contextFiles];
    const acted = allEntries.filter((e) => e.action !== 'skipped');
    const skipped = allEntries.filter((e) => e.action === 'skipped');

    for (const e of acted) {
      console.log(`  ${mark[e.action] ?? e.action}  ${e.label.padEnd(30)} ${e.file}`);
      if (e.note) console.log(`               ${e.note}`);
    }
    if (acted.length === 0) {
      console.log(`  . Nothing to remove - no seer entries found.`);
    }
    if (skipped.length > 0 && acted.length > 0) {
      console.log(`   ${skipped.length} file(s) had nothing to remove (already clean or not present).`);
    }

    if (!opts.print && acted.length > 0) {
      console.log(`\n  Done. Restart your agent to deregister the seer MCP server.\n`);
    } else if (opts.print) {
      console.log(`\n  (Dry run - run without --print to apply)\n`);
    } else {
      console.log('');
    }
  });

//  seer callers / callees / symbols / stats / health

program
  .command('callers <symbol>')
  .description('Find all callers of a symbol')
  .option('--db <path>', 'Database path')
  .option('--file <path>', 'Disambiguate the target symbol by definition file')
  .option('-n, --limit <n>', 'Max results', '40')
  .option('--include-snippets', 'Show the real source at each call site (HOW the symbol is invoked); pair with a small --limit')
  .option('--snippet-context <n>', 'Lines of context around each call site with --include-snippets (default 2, max 6)', '2')
  // Callers query is keyed by `edges.to_name`, not by symbol_role / vendor /
  // test flags. The include-* options are accepted for surface consistency
  // with the rest of the CLI but don't currently change results.
  .action((symbol: string, opts: { db?: string; file?: string; limit: string; includeSnippets?: boolean; snippetContext: string }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      // Resolve a specific id when the input is disambiguating — a `--file` was
      // given, or the symbol is qualified (`Node.add_child` / `Node::add_child`)
      // — then read callers by id. A bare short name stays on the broad name
      // path so `callers run` still lists callers of every `run`.
      const qualified = symbol.includes('.') || symbol.includes('::');
      const target = (opts.file || qualified)
        ? store.getDefinition(symbol, { filePath: opts.file })[0] ?? null
        : null;
      if (opts.file && !target) {
        console.log(`No symbol "${symbol}" found in ${opts.file}`);
        return;
      }
      const total = target ? store.countCallersById(target.id) : store.countCallers(symbol);
      if (total === 0) { console.log(`No callers found for "${symbol}"`); return; }
      const limit = Math.max(1, parseInt(opts.limit, 10) || 40);
      const callers = target ? store.findCallersById(target.id, limit) : store.findCallers(symbol, limit);
      const label = target ? `${target.qualifiedName ?? target.name} in ${target.filePath}` : symbol;
      console.log(`\nCallers of '${label}'  (${total} found)\n`);
      if (opts.includeSnippets) {
        // Same shared slicer the MCP tool uses (indexer/snippets.ts) so the two
        // surfaces never diverge. callerLine is the 0-indexed call row.
        const ctx = parseInt(opts.snippetContext, 10);
        const withSnips = attachCallSiteSnippets(
          callers.map(c => ({ file: c.callerFile, line: c.callerLine, name: c.callerName, kind: c.callerKind })),
          Number.isFinite(ctx) ? ctx : 2,
        );
        for (const c of withSnips) {
          console.log(`  ${c.name}  (${c.kind})  ${c.file}:${c.line + 1}`);
          if (c.snippet) for (const ln of c.snippet.split('\n')) console.log(`      ${ln}`);
          console.log('');
        }
      } else {
        for (const c of callers) {
          const loc = `${c.callerFile}:${c.callerLine + 1}`;
          console.log(`  ${c.callerName.padEnd(32)} ${c.callerKind.padEnd(12)} ${loc}`);
        }
      }
      if (total > callers.length) console.log(`   and ${total - callers.length} more`);
    } finally { store.close(); }
  });

program
  .command('callees <symbol>')
  .description('Find all symbols called by a symbol')
  .option('--db <path>', 'Database path')
  .option('--file <path>', 'Disambiguate the caller symbol by definition file')
  .option('-n, --limit <n>', 'Max results', '40')
  .action((symbol: string, opts: { db?: string; file?: string; limit: string }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      // Resolve a specific id when disambiguating (mirrors `callers`): a `--file`
      // was given, or the caller is qualified (`Node.add_child` /
      // `Node::add_child`) — then read callees by id. A bare short name stays on
      // the broad name path. The name-keyed findCallees only matched the short
      // name, so qualified inputs used to return nothing.
      const qualified = symbol.includes('.') || symbol.includes('::');
      const target = (opts.file || qualified)
        ? store.getDefinition(symbol, { filePath: opts.file })[0] ?? null
        : null;
      if (opts.file && !target) { console.log(`No symbol "${symbol}" found in ${opts.file}`); return; }
      const callees = target ? store.findCalleesById(target.id) : store.findCallees(symbol);
      if (callees.length === 0) { console.log(`No callees found for "${symbol}"`); return; }
      const label = target ? `${target.qualifiedName ?? target.name}` : symbol;
      console.log(`\nCallees of '${label}'  (${callees.length} found)\n`);
      const limit = Math.min(parseInt(opts.limit, 10), callees.length);
      for (const c of callees.slice(0, limit)) {
        const loc = c.calleeFile ? `${c.calleeFile}:${(c.calleeLineStart ?? 0) + 1}` : '(unresolved)';
        const kind = c.calleeKind ?? '?';
        console.log(`  ${c.calleeName.padEnd(32)} ${kind.padEnd(12)} ${loc}`);
      }
      if (callees.length > limit) console.log(`   and ${callees.length - limit} more`);
    } finally { store.close(); }
  });

program
  .command('symbols [query]')
  .description('Search symbols by name, or list top symbols by PageRank')
  .option('--db <path>', 'Database path')
  .option('--file <path>', 'Filter to symbols in a specific file')
  .option('-n, --top <n>', 'Show top N symbols by PageRank (default: 20)', '20')
  .option('--include-vendor',       'Include vendored code (off by default)')
  .option('--include-generated',    'Include generated code (off by default)')
  .option('--include-tests',        'Include symbols from test files (off by default)')
  .option('--include-declarations', 'Include forward / class-body declarations (off by default)')
  .option('--include-type-refs',    'Include bare type-reference rows (off by default; not yet emitted)')
  .action((query: string | undefined, opts: { db?: string; file?: string; top: string; includeVendor?: boolean; includeGenerated?: boolean; includeTests?: boolean; includeDeclarations?: boolean; includeTypeRefs?: boolean }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const limit = parseInt(opts.top, 10);
      const includeOpts = {
        includeVendor: opts.includeVendor,
        includeGenerated: opts.includeGenerated,
        includeTests: opts.includeTests,
        includeDeclarations: opts.includeDeclarations,
        includeTypeRefs: opts.includeTypeRefs,
      };
      let symbols;
      if (opts.file) { symbols = store.listSymbolsInFile(opts.file, limit); console.log(`\nSymbols in ${opts.file}\n`); }
      else if (query) { symbols = store.findSymbols(query, includeOpts); console.log(`\nSymbols matching '${query}'\n`); }
      else { symbols = store.getTopSymbols(limit, includeOpts); console.log(`\nTop ${limit} symbols by PageRank\n`); }
      if (symbols.length === 0) { console.log('  (none found)'); return; }
      console.log(`  ${'Name'.padEnd(32)} ${'Kind'.padEnd(12)} ${'Line'.padEnd(6)} ${'PageRank'.padEnd(10)} ${'Role'.padEnd(11)} File`);
      console.log('  ' + ''.repeat(102));
      for (const s of symbols) {
        const pr = s.pagerank.toFixed(4);
        const loc = String(s.lineStart + 1).padEnd(6);
        const relFile = s.filePath.replace(/\\/g, '/');
        const role = (s.symbolRole ?? 'definition').padEnd(11);
        console.log(`  ${s.name.padEnd(32)} ${s.kind.padEnd(12)} ${loc} ${pr.padEnd(10)} ${role} ${relFile}`);
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
      console.log('\nSeer Index Stats');
      console.log('');
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
  .description('Show Seer index health')
  .option('--db <path>', 'Database path')
  .action((opts: { db?: string }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const schema = store.schemaInfo();
      const stats = store.getStats();
      console.log('\nSeer Health');
      console.log('');
      console.log(`  DB path:           ${dbPath}`);
      console.log(`  Read-only:         ${store.isReadOnly()}`);
      console.log(`  Schema version:    ${schema.dbVersion} (build expects ${schema.buildVersion})`);
      if (!schema.current) console.log(`    Schema is behind. Run \`seer index <path>\` to migrate.`);
      else                  console.log(`    Schema is up to date.`);
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

//  seer routes

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
        const h = r.handlerSymbol ? ` ${r.handlerSymbol}` : (r.handlerName ? ` ${r.handlerName} (unresolved)` : '');
        console.log(`  ${r.method.padEnd(6)} ${r.path.padEnd(40)} ${r.framework.padEnd(10)} ${h}`);
      }
    } finally { store.close(); }
  });

//  seer service-calls / service-links / trace-service

program
  .command('service-calls')
  .description('List outbound HTTP/service client calls detected in the codebase')
  .option('--db <path>', 'Database path')
  .option('--protocol <p>', 'Filter by protocol (http)')
  .option('--method <m>', 'Filter by HTTP method (GET/POST/...)')
  .option('--framework <f>', 'Filter by client framework (fetch/axios/requests/...)')
  .option('--path <substr>', 'Filter by normalized path substring')
  .option('--min-confidence <c>', 'Minimum confidence 0..1', '0')
  .option('-n, --limit <n>', 'Max results', '100')
  .option('--offset <n>', 'Skip first N results', '0')
  .action((opts: {
    db?: string; protocol?: string; method?: string; framework?: string;
    path?: string; minConfidence: string; limit: string; offset: string;
  }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const rows = store.listServiceCalls({
        protocol: opts.protocol,
        method: opts.method,
        framework: opts.framework,
        pathSubstr: opts.path,
        minConfidence: parseFloat(opts.minConfidence) || 0,
        limit: parseInt(opts.limit, 10) || 100,
        offset: parseInt(opts.offset, 10) || 0,
      });
      if (rows.length === 0) { console.log('No service calls found.'); return; }
      console.log(`\nService calls (${rows.length} shown)\n`);
      for (const r of rows) {
        const caller = r.callerQualifiedName ?? r.callerName ?? '(module-level)';
        const target = r.normalizedPath ?? r.rawTarget;
        const host = r.hostHint ? ` host=${r.hostHint}` : '';
        const env = r.envKey ? ` env=${r.envKey}` : '';
        console.log(`  ${(r.method ?? 'ANY').padEnd(6)} ${target.padEnd(40)} ` +
          `${r.framework.padEnd(12)} ${caller.padEnd(28)} ${r.filePath}:${r.line + 1}${host}${env}`);
      }
    } finally { store.close(); }
  });

program
  .command('service-links')
  .description('List deterministic service-link rendezvous between client calls and route handlers')
  .option('--db <path>', 'Database path')
  .option('--protocol <p>', 'Filter by protocol (http)')
  .option('--method <m>', 'Filter by HTTP method')
  .option('--path <substr>', 'Filter by call/route path substring')
  .option('--match-kind <k>', 'Filter by match_kind (literal_path/env_base/route_pattern)')
  .option('--min-confidence <c>', 'Minimum confidence 0..1', '0')
  .option('-n, --limit <n>', 'Max results', '100')
  .option('--offset <n>', 'Skip first N results', '0')
  .action((opts: {
    db?: string; protocol?: string; method?: string; path?: string;
    matchKind?: string; minConfidence: string; limit: string; offset: string;
  }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const rows = store.listServiceLinks({
        protocol: opts.protocol,
        method: opts.method,
        pathSubstr: opts.path,
        matchKind: opts.matchKind,
        minConfidence: parseFloat(opts.minConfidence) || 0,
        limit: parseInt(opts.limit, 10) || 100,
        offset: parseInt(opts.offset, 10) || 0,
      });
      if (rows.length === 0) { console.log('No service links found.'); return; }
      console.log(`\nService links (${rows.length} shown)\n`);
      for (const r of rows) {
        const caller = r.callerQualifiedName ?? r.callerName ?? '(module-level)';
        const handler = r.handlerQualifiedName ?? r.handlerName ?? '(no handler)';
        const route = r.routePath ?? r.callNormalizedPath ?? r.callRawTarget;
        console.log(
          `  ${(r.callMethod ?? 'ANY').padEnd(6)} ${(route ?? '').padEnd(36)} ` +
          `${caller.padEnd(22)}  ${handler.padEnd(22)} ` +
          `[${r.matchKind} ${r.confidence.toFixed(2)}]`,
        );
      }
    } finally { store.close(); }
  });

program
  .command('trace-service <from> <to>')
  .description('Find a shortest service-link path between two symbols (bounded BFS)')
  .option('--db <path>', 'Database path')
  .option('--depth <n>', 'Max BFS depth', '6')
  .action((from: string, to: string, opts: { db?: string; depth: string }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const fromRows = store.getDefinition(from);
      const toRows   = store.getDefinition(to);
      if (fromRows.length === 0) { console.log(`Source symbol "${from}" not found.`); return; }
      if (toRows.length === 0)   { console.log(`Target symbol "${to}" not found.`);   return; }
      const path = store.traceServicePath(
        fromRows[0].id, toRows[0].id,
        parseInt(opts.depth, 10) || 6,
      );
      if (path.length === 0) { console.log('No service-link path found.'); return; }
      console.log(`\nService path (${path.length} hops):\n`);
      for (const id of path) {
        const row = store.rawDb().prepare(
          `SELECT qualified_name, name FROM symbols WHERE id = ?`
        ).get(id) as { qualified_name: string | null; name: string } | undefined;
        const label = row?.qualified_name ?? row?.name ?? `#${id}`;
        console.log(`   ${label}`);
      }
    } finally { store.close(); }
  });

//  seer deps

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

//  seer config

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

//  seer churn (file-level git churn pass)

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
      console.log(`\nChurn pass: ${r.filesWithChurn}/${r.filesAnalyzed} files have history (HEAD ${r.headSha?.slice(0, 8) ?? ''}), ${r.elapsedMs}ms`);
    } finally { store.close(); }
  });

//  seer history (Track D)

program
  .command('history <symbol>')
  .description('Show per-symbol commit history (requires `seer symbol-history` to have run)')
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
        if (history.length === 0) { console.log(`  (no history  run \`seer symbol-history\` first)`); continue; }
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
  .description('Index per-symbol git history (opt-in; incremental on re-run)')
  .option('--db <path>', 'Database path')
  .option('--workspace <path>', 'Workspace path (defaults to cwd)')
  .option('--max-commits <n>', 'Max commits per file', '200')
  .option('--max-files <n>', 'Stop after this many files (partial build)')
  .option('--max-seconds <n>', 'Wall-clock budget; partial builds resume next run')
  .option('--since <horizon>', 'History horizon: a duration (e.g. 2y, 18mo, 90d), an ISO date, or unix seconds. Bounds each file\'s git-log walk so rarely-changed files don\'t force a full-DAG scan (~3x faster on big repos). 0/all = unbounded (default). Falls back to $SEER_HISTORY_SINCE.')
  .option('--paths <list>', 'Comma-separated files to build (scoped build of just these)')
  .option('--follow', 'Thread git --follow through file renames (slower; default off)')
  .option('--concurrency <n>', 'Parallel per-file git walks (default ~CPU count)')
  .option('--force', 'Re-run from scratch even if HEAD unchanged (ignores resume watermarks)')
  .option('--no-resume', 'Ignore per-file resume watermarks (reprocess every file)')
  .action(async (opts: {
    db?: string; workspace?: string; maxCommits: string;
    maxFiles?: string; maxSeconds?: string; since?: string; paths?: string; follow?: boolean;
    concurrency?: string; force?: boolean; resume?: boolean;
  }) => {
    const workspace = path.resolve(opts.workspace ?? process.cwd());
    const dbPath = opts.db ?? findDbFromCwd();
    if (!fs.existsSync(dbPath)) { console.error(`No index at ${dbPath}`); process.exit(1); }
    const store = new Store(dbPath);
    try {
      const { buildSymbolHistory, parseHistorySince } = await import('../indexer/symbolhistory.js');
      const { writeProgress, clearProgress } = await import('../indexer/progress.js');
      // commander sets `resume` to false only when --no-resume is passed.
      const useResume = opts.resume === false ? false : (opts.force ? false : undefined);
      const onlyPaths = opts.paths
        ? opts.paths.split(',').map(p => p.trim()).filter(Boolean)
        : undefined;
      // --since wins over $SEER_HISTORY_SINCE; either resolves to a unix-seconds
      // lower bound (or undefined = unbounded). A typo parses to null → hard error
      // rather than silently scanning all history.
      const sinceRaw = opts.since ?? process.env.SEER_HISTORY_SINCE;
      const since = parseHistorySince(sinceRaw);
      if (since === null) { console.error(`Invalid --since value: ${sinceRaw}`); process.exit(1); }
      let lastLog = 0;
      const r = await buildSymbolHistory(workspace, store, {
        maxCommitsPerFile: parseInt(opts.maxCommits, 10) || 200,
        maxFiles: opts.maxFiles ? parseInt(opts.maxFiles, 10) : undefined,
        deadlineMs: opts.maxSeconds ? (parseInt(opts.maxSeconds, 10) || 0) * 1000 : undefined,
        ...(since !== undefined ? { since } : {}),
        follow: opts.follow === true,
        concurrency: opts.concurrency ? parseInt(opts.concurrency, 10) || undefined : undefined,
        ...(onlyPaths ? { onlyPaths } : {}),
        skipIfHeadUnchanged: !opts.force,
        useResumeWatermarks: useResume,
        log: (m) => { clearProgress(); console.log(`  ${m}`); },
        onProgress: (p) => {
          if (process.stdout.isTTY) {
            writeProgress(p.filesHandled, p.filesTotal, p.currentFile || p.phase);
          } else {
            const now = Date.now();
            if (now - lastLog > 2000 || p.filesHandled >= p.filesTotal) {
              lastLog = now;
              console.log(`  [${p.phase}] ${p.filesHandled}/${p.filesTotal} files, ${p.rowsInserted} rows`);
            }
          }
        },
      });
      clearProgress();
      const skipNote = r.filesSkippedResume > 0 ? `, ${r.filesSkippedResume} resume-skipped` : '';
      const partial = r.completed ? '' : ` — PARTIAL (${r.reason ?? 'budget reached'}); rerun to resume`;
      console.log(`\nSymbol history: ${r.historyRowsInserted} rows across ${r.filesProcessed} files${skipNote} (${r.elapsedMs}ms)${partial}`);
    } finally { store.close(); }
  });

//  seer continuity (rename/move continuity evidence)

program
  .command('continuity <symbol>')
  .description('v10  Show rename/move continuity evidence (advisory; confidence-labelled).')
  .option('--db <path>', 'Database path')
  .action(async (symbol: string, opts: { db?: string }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    // Continuity is built lazily (not during indexing). Open mutable so we can
    // build it on demand the first time it is asked for.
    const store = openStore(dbPath, true);
    try {
      const { getContinuityForSymbol, buildContinuity } = await import('../indexer/continuity.js');
      // Build the continuity table once if it is empty. Needs shape hashes,
      // which the index normally produces; if missing, compute them first.
      try {
        const hasRows = (store.rawDb().prepare('SELECT COUNT(*) AS c FROM symbol_history_continuity').get() as { c: number }).c > 0;
        if (!hasRows) {
          const hashed = (store.rawDb().prepare('SELECT COUNT(*) AS c FROM symbols WHERE shape_hash IS NOT NULL').get() as { c: number }).c;
          if (hashed === 0) {
            const { buildShapeHashes } = await import('../indexer/shapehash.js');
            buildShapeHashes(store, {});
          }
          buildContinuity(store, {});
        }
      } catch { /* advisory; fall through and show whatever exists */ }
      const defs = store.getDefinition(symbol);
      if (defs.length === 0) { console.log(`No symbol "${symbol}"`); return; }
      for (const d of defs.slice(0, 3)) {
        console.log(`\n${d.qualifiedName ?? d.name}  (${d.kind})  ${d.filePath}:${d.lineStart + 1}`);
        const rows = getContinuityForSymbol(store, d.id);
        if (rows.length === 0) {
          console.log(`  (no continuity candidates)`);
          continue;
        }
        for (const r of rows) {
          console.log(`   previous: ${r.previousName.padEnd(28)} conf=${r.confidence.toFixed(2)}  [${r.matchReasons.join(', ')}]`);
          console.log(`     in:       ${r.previousFile}`);
        }
      }
    } finally { store.close(); }
  });

//  seer changes-with (temporal/logical coupling)

program
  .command('changes-with <symbol>')
  .description('Symbols that historically change in the same commits (advisory coupling; needs `seer symbol-history`).')
  .option('--db <path>', 'Database path')
  .option('--file <path>', 'Disambiguate the target symbol by definition file')
  .option('-n, --limit <n>', 'Max partners', '20')
  .option('--min-support <n>', 'Minimum shared commits for a partner (default 2)', '2')
  .option('--max-commit-symbols <n>', 'Drop commits touching more than N distinct symbols as noise (default 50)', '50')
  .option('--cross-file-only', 'Exclude partners in the same file (proximity coupling)')
  .option('--since <when>', 'Lower bound on commit time: unix seconds or an ISO date (e.g. 2024-01-01)')
  .option('--json', 'Emit raw JSON instead of a table')
  .action((symbol: string, opts: {
    db?: string; file?: string; limit: string; minSupport: string;
    maxCommitSymbols: string; crossFileOnly?: boolean; since?: string; json?: boolean;
  }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const target = store.getDefinition(symbol, { filePath: opts.file })[0] ?? null;
      if (!target) { console.log(`No symbol "${symbol}"${opts.file ? ` in ${opts.file}` : ''}`); return; }

      // since accepts unix-seconds or an ISO date.
      let since: number | undefined;
      if (opts.since) {
        const raw = opts.since.trim();
        since = /^\d+$/.test(raw) ? parseInt(raw, 10) : Math.floor(Date.parse(raw) / 1000);
        if (!Number.isFinite(since)) { console.error(`Invalid --since value: ${opts.since}`); process.exit(1); }
      }

      const result = computeCoupling(store, target.id, {
        limit: parseInt(opts.limit, 10) || 20,
        minSupport: parseInt(opts.minSupport, 10) || 2,
        maxCommitSymbols: parseInt(opts.maxCommitSymbols, 10) || 50,
        includeSameFile: opts.crossFileOnly !== true,
        since,
      });

      // Mirror the MCP gate exactly: coupling is only trustworthy against the
      // FULL repo-wide history index (a partner's file must be indexed too). The
      // full build is what stamps lastHistoryHeadSha; a scoped/auto build leaves
      // it null, so warn rather than present partial data as authoritative.
      const fullyBuilt = store.getHistoryIndexInfo().lastHistoryHeadSha != null;

      if (opts.json) {
        console.log(JSON.stringify({ symbol, file: opts.file, historyComplete: fullyBuilt, ...result }, null, 2));
        return;
      }

      if (!fullyBuilt) {
        console.log(`\n⚠ Symbol history is not FULLY built, so coupling is unreliable here (partial or falsely empty).`);
        console.log(`  Coupling needs repo-wide history — run \`seer symbol-history\` first, then re-run.\n`);
      }
      console.log(`\nChanges-with '${target.qualifiedName ?? target.name}'  (${target.filePath}:${target.lineStart + 1})`);
      console.log(`  target commits: ${result.targetCommits}, used: ${result.effectiveCommits}, noisy dropped: ${result.noisyCommitsIgnored}`);
      if (result.partners.length === 0) { console.log(`  (no coupled partners)`); return; }
      console.log('');
      for (const p of result.partners) {
        const conf = `${Math.round(p.confidence * 100)}%`;
        const where = p.sameFile ? ' [same-file]' : '';
        console.log(`  ${(p.symbol.qualifiedName ?? p.symbol.name).padEnd(36)} shared=${String(p.sharedCommits).padStart(3)}  conf=${conf.padStart(4)}  base=${p.partnerCommits}${where}`);
        console.log(`      ${p.symbol.file}:${p.symbol.lineStart + 1}`);
      }
      console.log(`\n  Advisory: co-change is correlation, not causation. Verify a partner before trusting it.`);
    } finally { store.close(); }
  });

//  seer architecture

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
      console.log(``);
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

//  seer detect-changes

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
          console.log(`     ${(s.symbol.qualifiedName ?? s.symbol.name).padEnd(40)} ${s.symbol.kind}`);
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

//  Track-E: modules / behavior / risk / context

program
  .command('modules')
  .description('List clustered modules (Louvain) by centrality / size / label')
  .option('--db <path>', 'Database path')
  .option('-n, --limit <n>', 'Max results', '40')
  .option('--sort <by>', 'centrality | size | label', 'centrality')
  .action((opts: { db?: string; limit: string; sort: string }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const sortBy = opts.sort === 'size' || opts.sort === 'label' ? opts.sort : 'centrality';
      const rows = store.listModules({ limit: parseInt(opts.limit, 10) || 40, sortBy });
      if (rows.length === 0) { console.log('No modules  run `seer index` to build the clustering.'); return; }
      console.log(`\nModules (${rows.length} shown, sorted by ${sortBy})\n`);
      console.log(`  ${'Label'.padEnd(28)} ${'Files'.padStart(5)} ${'Symbols'.padStart(7)} ${'Lang'.padEnd(12)} ${'Cohesion'.padStart(8)} ${'Central'.padStart(8)}`);
      console.log('  ' + ''.repeat(80));
      for (const m of rows) {
        console.log(
          `  ${m.label.padEnd(28)} ${String(m.sizeFiles).padStart(5)} ${String(m.sizeSymbols).padStart(7)} ${(m.primaryLanguage ?? '').padEnd(12)} ${m.cohesion.toFixed(2).padStart(8)} ${m.centrality.toFixed(4).padStart(8)}`,
        );
      }
    } finally { store.close(); }
  });

program
  .command('module <label>')
  .description('Show files and top symbols inside a module (by label or id)')
  .option('--db <path>', 'Database path')
  .option('-n, --files <n>', 'Max files', '50')
  .option('-s, --symbols <n>', 'Max symbols', '20')
  .action((label: string, opts: { db?: string; files: string; symbols: string }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const asId = parseInt(label, 10);
      const mod = !isNaN(asId) && String(asId) === label
        ? store.getModuleById(asId)
        : store.getModuleByLabel(label);
      if (!mod) { console.log(`No module "${label}"`); return; }
      console.log(`\nModule "${mod.label}"  id=${mod.id}  files=${mod.sizeFiles}  symbols=${mod.sizeSymbols}  cohesion=${mod.cohesion.toFixed(2)}  centrality=${mod.centrality.toFixed(4)}`);
      const files = store.listModuleMembers(mod.id, parseInt(opts.files, 10) || 50);
      console.log(`\n  Files (${files.length}):`);
      for (const f of files) console.log(`    ${f.language.padEnd(12)} ${f.role.padEnd(9)} ${f.relPath}`);
      const syms = store.listModuleTopSymbols(mod.id, parseInt(opts.symbols, 10) || 20);
      console.log(`\n  Top symbols (${syms.length}):`);
      for (const s of syms) console.log(`    ${s.pagerank.toFixed(4)}  ${(s.qualifiedName ?? s.name).padEnd(40)} ${s.kind}  ${s.filePath}`);
      const out = store.moduleDependencies(mod.id, { direction: 'out', limit: 10 });
      const inn = store.moduleDependencies(mod.id, { direction: 'in', limit: 10 });
      if (out.length > 0) {
        console.log(`\n  Depends on (out):`);
        for (const d of out) console.log(`    ${d.label.padEnd(28)} kind=${d.kind.padEnd(8)} weight=${d.weight}`);
      }
      if (inn.length > 0) {
        console.log(`\n  Depended on by (in):`);
        for (const d of inn) console.log(`    ${d.label.padEnd(28)} kind=${d.kind.padEnd(8)} weight=${d.weight}`);
      }
    } finally { store.close(); }
  });

program
  .command('behavior <symbol>')
  .description('Show ranked behavioral contract (tests) for a symbol')
  .option('--db <path>', 'Database path')
  .option('-n, --limit <n>', 'Max results', '20')
  .option('--depth <n>', 'BFS depth for indirect coverage', '2')
  .action((symbol: string, opts: { db?: string; limit: string; depth: string }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const r = rankedBehavior(store, symbol, {
        limit: parseInt(opts.limit, 10) || 20,
        indirectDepth: parseInt(opts.depth, 10) || 2,
      });
      if (!r) { console.log(`No symbol "${symbol}"`); return; }
      console.log(`\nBehavior for ${r.symbol.qualifiedName ?? r.symbol.name}  (${r.symbol.kind})  ${r.symbol.file}`);
      console.log(`  direct=${r.direct}  indirect=${r.indirect}  naming=${r.namingMatches}  same-file=${r.sameFileMatches}  heuristic=${r.heuristicMatches}`);
      console.log(`  coverage: ${r.testCoverageState} — ${r.testCoverageNote}\n`);
      for (const t of r.tests) {
        const dist = t.graphDistance == null ? '  ' : String(t.graphDistance).padStart(2);
        console.log(
          `  spec=${t.specificity.toString().padStart(4)} d=${dist} asserts=${String(t.assertionCount).padStart(2)} ${t.relationship.padEnd(18)} ${(t.testSymbol.qualifiedName ?? t.testSymbol.name).padEnd(40)} ${t.testSymbol.file}:${t.testSymbol.lineStart + 1}`,
        );
      }
    } finally { store.close(); }
  });

program
  .command('risk <symbol>')
  .description('Deterministic edit-risk profile for a symbol')
  .option('--db <path>', 'Database path')
  .option('--depth <n>', 'BFS depth for transitive callers', '3')
  .action((symbol: string, opts: { db?: string; depth: string }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const r = computeRisk(store, symbol, { callerDepth: parseInt(opts.depth, 10) || 3 });
      if (!r) { console.log(`No symbol "${symbol}"`); return; }
      console.log(`\nRisk: ${r.risk.toUpperCase()} (score ${r.score.toFixed(2)})`);
      console.log(`  ${r.symbol.qualifiedName ?? r.symbol.name}  (${r.symbol.kind})  ${r.symbol.file}:${r.symbol.lineStart + 1}`);
      if (r.module) console.log(`  module=${r.module.label}`);
      console.log(`\n  Signal contributions:`);
      for (const c of r.signalContributions) {
        const sign = c.contribution > 0 ? '+' : '';
        console.log(`    ${c.signal.padEnd(28)} value=${String(c.value).padEnd(8)} ${sign}${c.contribution.toFixed(2)}`);
      }
      if (r.signals.routes.length > 0) {
        console.log(`  Routes:`);
        for (const rt of r.signals.routes) console.log(`    ${rt.method} ${rt.path} (${rt.framework})`);
      }
    } finally { store.close(); }
  });

program
  .command('context <symbol>')
  .description('One compact pre-edit packet: definition, callers, callees, routes, config, behavior, history, complexity, module, blast radius, risk')
  .option('--db <path>', 'Database path')
  .option('--file <path>', 'Disambiguate by file')
  .action((symbol: string, opts: { db?: string; file?: string }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const c = buildContext(store, symbol, { filePath: opts.file });
      if (!c) { console.log(`No symbol "${symbol}"`); return; }
      console.log(`\nContext for ${c.symbol.qualifiedName ?? c.symbol.name}  (${c.symbol.kind})  ${c.symbol.file}:${c.symbol.lineStart + 1}`);
      if (c.module) console.log(`  Module: ${c.module.label}`);
      console.log(`  Complexity: loc=${c.complexity.loc ?? ''}  cyclomatic=${c.complexity.cyclomatic ?? ''}  cognitive=${c.complexity.cognitive ?? ''}`);
      console.log(`  Callers: ${c.callers.total} total; Callees: ${c.callees.total}; Blast radius (depth ${c.blastRadius.maxDepth}): direct=${c.blastRadius.directCallers}, transitive=${c.blastRadius.transitiveCallers}`);
      console.log(`  Behavior: direct=${c.behavior.direct}  indirect=${c.behavior.indirect}  naming=${c.behavior.namingMatches}  same-file=${c.behavior.sameFileMatches}`);
      const histNote = c.historyIndex.built ? '' : ' (history index not built)';
      const routesNote = c.routesTruncated ? ` (${c.routes.length} shown)` : '';
      const configNote = c.configKeysTruncated ? ` (${c.configKeys.length} shown)` : '';
      console.log(`  Routes: ${c.routesTotal}${routesNote}  Config: ${c.configKeysTotal}${configNote}  History: ${c.recentHistory.total}${histNote}`);
      console.log(`  Risk: ${c.risk.risk.toUpperCase()} (score ${c.risk.score.toFixed(2)})`);
      console.log(`\n  Signal contributions:`);
      for (const sc of c.risk.signalContributions) {
        const sign = sc.contribution > 0 ? '+' : '';
        console.log(`    ${sc.signal.padEnd(28)} ${sign}${sc.contribution.toFixed(2)}`);
      }
    } finally { store.close(); }
  });

//  Track-F: bundle export/import + CI pipeline

const bundleCmd = program
  .command('bundle')
  .description('Portable .seer index bundles (export, import, info)');

bundleCmd
  .command('export')
  .description('Export the current index as a portable .seerbundle file')
  .option('--workspace <path>', 'Workspace path (defaults to cwd)')
  .option('--db <path>', 'Database path')
  .option('--out <path>', 'Output bundle path (default: <workspace>/.seer/index.seerbundle)')
  .option('--level <n>', 'Gzip compression level 0-9 (default: 6)', '6')
  .option('--built-at <ms>', 'Pin manifest.builtAt to a fixed Unix-millis value for reproducible bundles')
  .action(async (opts: { workspace?: string; db?: string; out?: string; level: string; builtAt?: string }) => {
    const workspace = path.resolve(opts.workspace ?? process.cwd());
    const dbPath = opts.db ?? path.join(workspace, '.seer', 'graph.db');
    const { exportBundle } = await import('../bundle/export.js');
    const level = Math.max(0, Math.min(9, parseInt(opts.level, 10) || 6));
    const builtAt = opts.builtAt ? parseInt(opts.builtAt, 10) : undefined;
    const r = await exportBundle(dbPath, workspace, {
      out: opts.out, compressionLevel: level,
      builtAt: (builtAt != null && !isNaN(builtAt)) ? builtAt : undefined,
      log: (m) => console.log(`  ${m}`),
    });
    console.log(`\n   Bundle exported to ${r.bundlePath}`);
    console.log(`    ${r.bytes.toLocaleString()} bytes  schemaVersion=${r.manifest.schemaVersion}  symbols=${r.manifest.index.symbols}  edges=${r.manifest.index.edges}`);
    console.log(`    DB sha256=${r.manifest.dbSha256.slice(0, 16)}...  built in ${r.elapsedMs}ms`);
  });

bundleCmd
  .command('import <bundle>')
  .description('Import a .seerbundle into a workspace. Add --external to import additively as a peer-repo evidence layer (does not replace the local DB).')
  .option('--workspace <path>', 'Workspace path (defaults to cwd)')
  .option('--db <path>', 'Database path (default: <workspace>/.seer/graph.db)')
  .option('--overwrite', 'Allow overwriting an existing index')
  .option('--skip-integrity-check', 'Skip sha256 check (forensics only)')
  .option('--skip-schema-check', 'Skip schemaVersion compatibility check (use only if you KNOW the bundle is safe)')
  .option('--external', 'Additive external import  adds routes/service endpoints as a read-only external layer, never replaces local rows.')
  .option('--alias <name>', 'Optional alias for the external bundle (defaults to manifest.gitBranch or filename).')
  .option('--force', 'Force re-import even if the same hash is already present (external mode only).')
  .action(async (bundle: string, opts: { workspace?: string; db?: string; overwrite?: boolean; skipIntegrityCheck?: boolean; skipSchemaCheck?: boolean; external?: boolean; alias?: string; force?: boolean }) => {
    const workspace = path.resolve(opts.workspace ?? process.cwd());
    if (opts.external) {
      const dbPath = opts.db ?? path.join(workspace, '.seer', 'graph.db');
      if (!fs.existsSync(dbPath)) {
        console.error(`No index at ${dbPath}. Run "seer index <path>" first before importing an external bundle.`);
        process.exit(1);
      }
      const { importExternalBundle } = await import('../bundle/external.js');
      const store = new Store(dbPath);
      try {
        const r = await importExternalBundle(path.resolve(bundle), store, {
          alias: opts.alias, force: opts.force,
          log: (m) => console.log(`  ${m}`),
        });
        if (r.alreadyImported) {
          console.log(`\n   External bundle already imported (hash unchanged); no-op.`);
        } else {
          console.log(`\n   External bundle imported as layer #${r.bundleId} (${r.externalProject ?? 'unnamed'}).`);
          console.log(`    routes=${r.routesImported}  serviceEndpoints=${r.serviceEndpointsImported}  schemaVersion=${r.schemaVersion}`);
          console.log(`    hash=${r.externalHash.slice(0, 12)}...  took ${r.elapsedMs}ms`);
        }
      } catch (err) {
        console.error(`\n   External import failed: ${(err as Error).message}`);
        process.exit(1);
      } finally { store.close(); }
      return;
    }
    const { importBundle } = await import('../bundle/import.js');
    try {
      const r = await importBundle(path.resolve(bundle), {
        repoRoot: workspace,
        dbOut: opts.db,
        overwrite: opts.overwrite,
        skipIntegrityCheck: opts.skipIntegrityCheck,
        skipSchemaCheck: opts.skipSchemaCheck,
        log: (m) => console.log(`  ${m}`),
      });
      console.log(`\n   Bundle imported to ${r.dbPath}`);
      console.log(`    builtAt=${new Date(r.manifest.builtAt).toISOString()}  schemaVersion=${r.manifest.schemaVersion}`);
      console.log(`    symbols=${r.manifest.index.symbols}  edges=${r.manifest.index.edges}  modules=${r.manifest.index.modules}`);
      console.log(`    Took ${r.elapsedMs}ms`);
    } catch (err) {
      console.error(`\n   Import failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

//  seer boundaries (Feature 4: monorepo boundary detection)

program
  .command('boundaries')
  .description('List monorepo package/service boundaries detected at index time.')
  .option('--db <path>', 'Database path')
  .option('-n, --limit <n>', 'Max results', '50')
  .action((opts: { db?: string; limit: string }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const rows = store.listBoundaries(parseInt(opts.limit, 10) || 50);
      if (rows.length === 0) {
        console.log('No boundaries detected  workspace has no nested package manifests or convention dirs.');
        return;
      }
      console.log(`\nBoundaries (${rows.length} shown)\n`);
      for (const b of rows) {
        const eco = b.ecosystem ? `[${b.ecosystem}]` : '';
        console.log(`  ${b.kind.padEnd(16)} ${String(b.sizeFiles).padStart(5)}  ${b.label.padEnd(20)} ${eco}  ${b.rootRelPath || '.'}`);
      }
    } finally { store.close(); }
  });

//  seer preflight

program
  .command('preflight')
  .description('One compact "should I edit this?" evidence packet for an agent. Pass --symbol <X> for a single-symbol packet, or --from <ref> --to <ref> for a diff-range packet.')
  .option('--db <path>', 'Database path')
  .option('--workspace <path>', 'Workspace path (defaults to cwd)')
  .option('--symbol <name>', 'Build a packet for the named symbol.')
  .option('--file <path>', 'Optional file to disambiguate the symbol.')
  .option('--from <ref>', 'Build a range packet from this git ref.')
  .option('--to <ref>', 'Build a range packet to this git ref.')
  .option('--old-bundle <path>', 'Optional old .seerbundle to include contract changes.')
  .option('--new-bundle <path>', 'Optional new .seerbundle to include contract changes.')
  .option('--max-symbols <n>', 'Cap on touched symbols (default 12)', '12')
  .option('--max-tests <n>',   'Cap on likely tests (default 8)',   '8')
  .option('--max-history <n>', 'Cap on history rows (default 8)',   '8')
  .option('--json', 'Print machine-readable JSON.')
  .action(async (opts: {
    db?: string; workspace?: string;
    symbol?: string; file?: string;
    from?: string; to?: string;
    oldBundle?: string; newBundle?: string;
    maxSymbols: string; maxTests: string; maxHistory: string;
    json?: boolean;
  }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const workspace = path.resolve(opts.workspace ?? process.cwd());
    const store = openStore(dbPath);
    try {
      const { preflight } = await import('../indexer/preflight.js');
      const r = await preflight(store, {
        symbol: opts.symbol,
        filePath: opts.file,
        fromRef: opts.from,
        toRef: opts.to,
        workspace,
        oldBundle: opts.oldBundle,
        newBundle: opts.newBundle,
        maxSymbols: parseInt(opts.maxSymbols, 10) || 12,
        maxTests: parseInt(opts.maxTests, 10) || 8,
        maxHistory: parseInt(opts.maxHistory, 10) || 8,
      });
      if (opts.json) {
        process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      } else {
        printPreflight(r);
      }
      // Advisory: never raise non-zero exit when preflight finds risk.
      process.exit(r.ok ? 0 : 1);
    } finally { store.close(); }
  });

function printPreflight(r: import('../indexer/preflight.js').PreflightResult): void {
  if (!r.ok) {
    console.log(`\n   preflight failed: ${r.reason}`);
    return;
  }
  console.log(`\nPreflight (${r.mode})`);
  if (r.symbol) {
    console.log(`  Symbol:   ${r.symbol.qualifiedName ?? r.symbol.name}  ${r.symbol.file}:${r.symbol.lineStart + 1}`);
  }
  if (r.range) {
    console.log(`  Range:    ${r.range.fromRef ?? '(working tree)'}  ${r.range.toRef ?? 'HEAD'}`);
    console.log(`            ${r.range.changedFiles} file(s), ${r.range.directHunkCount} hunk(s)`);
  }
  console.log(`  Risk:     ${r.risk.overall.toUpperCase()}`);
  for (const r2 of r.risk.perSymbol.slice(0, 5)) {
    console.log(`    - ${r2.symbol.qualifiedName ?? r2.symbol.name}  score=${r2.score.toFixed(2)}  ${r2.risk}`);
  }
  if (r.likelyTests.length > 0) {
    console.log(`  Likely tests (${r.likelyTests.length}):`);
    for (const t of r.likelyTests.slice(0, 8)) {
      console.log(`     ${(t.testSymbol.qualifiedName ?? t.testSymbol.name).padEnd(40)} [${t.relationship}]  spec=${t.specificity}`);
    }
  }
  if (r.serviceImpact.inbound.length + r.serviceImpact.outbound.length > 0) {
    console.log(`  Service impact: in=${r.serviceImpact.inbound.length} out=${r.serviceImpact.outbound.length}`);
  }
  if (r.history.length > 0) {
    console.log(`  Recent commits (${r.history.length}):`);
    for (const h of r.history.slice(0, 5)) {
      const date = new Date(h.committedAt * 1000).toISOString().slice(0, 10);
      console.log(`    ${h.sha.slice(0, 8)}  ${date}  ${(h.author ?? '?').slice(0, 24).padEnd(24)} ${(h.message ?? '').split('\n')[0].slice(0, 60)}`);
    }
  }
  if (r.warnings.length > 0) {
    console.log(`  Warnings:`);
    for (const w of r.warnings) console.log(`      ${w}`);
  }
}

//  seer contract diff

const contractCmd = program
  .command('contract')
  .description('API/service contract diffing across exported .seerbundle files (advisory).');

contractCmd
  .command('diff <old-bundle> <new-bundle>')
  .description('Diff API/service contracts (routes, tRPC/GraphQL/gRPC ops, topics, queues) between two bundles. Exit 0 even when breaking changes appear  advisory only.')
  .option('--json', 'Emit machine-readable JSON instead of a compact table.')
  .option('--include-callers', 'Include affectedCallers using service-link evidence from both bundles.')
  .action(async (oldBundle: string, newBundle: string, opts: { json?: boolean; includeCallers?: boolean }) => {
    const { contractDiff, formatContractDiffTable } = await import('../bundle/contract.js');
    try {
      const diff = await contractDiff(
        path.resolve(oldBundle),
        path.resolve(newBundle),
        { includeAffectedCallers: opts.includeCallers },
      );
      if (opts.json) {
        process.stdout.write(JSON.stringify(diff, null, 2) + '\n');
      } else {
        process.stdout.write(formatContractDiffTable(diff));
      }
      // Advisory: always exit 0.
      process.exit(0);
    } catch (err) {
      console.error(`\n   contract diff failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

bundleCmd
  .command('external')
  .description('List external bundle layers imported into this workspace.')
  .option('--db <path>', 'Database path')
  .action((opts: { db?: string }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const rows = store.listExternalBundles();
      if (rows.length === 0) {
        console.log('No external bundles imported.');
        return;
      }
      console.log(`\nExternal bundle layers (${rows.length}):\n`);
      for (const r of rows) {
        console.log(`  #${r.id}  ${r.externalProject ?? '(unnamed)'}  routes=${r.routesImported}`);
        console.log(`     path=${r.bundlePath}`);
        console.log(`     hash=${(r.externalHash ?? '').slice(0, 12)}...  imported=${new Date(r.importedAt).toISOString()}`);
      }
    } finally { store.close(); }
  });

bundleCmd
  .command('info <bundle>')
  .description('Show a bundle\'s manifest without unpacking the DB')
  .action(async (bundle: string) => {
    const { readBundleManifest } = await import('../bundle/import.js');
    try {
      const manifest = readBundleManifest(path.resolve(bundle));
      console.log(JSON.stringify(manifest, null, 2));
    } catch (err) {
      console.error(`\n   ${(err as Error).message}`);
      process.exit(1);
    }
  });

const ciCmd = program
  .command('ci')
  .description('CI helpers: bundle generation, workflow templates');

ciCmd
  .command('bundle')
  .description('Fresh-index the repo and emit a portable bundle (designed for CI)')
  .option('--workspace <path>', 'Repo to index (defaults to cwd)')
  .option('--out <path>', 'Output path (default: <workspace>/.seer/index.seerbundle)')
  .option('--mode <mode>', 'Discovery mode: full | standard | fast (default: standard)', 'standard')
  .option('--no-reset', 'Keep existing DB before indexing (default: wipe)')
  .option('--no-parallel', 'Disable parallel parsing')
  .option('--git-head <sha>', 'Override gitHead in the manifest')
  .option('--git-branch <name>', 'Override gitBranch in the manifest')
  .option('--built-at <ms>', 'Pin manifest.builtAt to a fixed Unix-millis value for reproducible bundles')
  .action(async (opts: { workspace?: string; out?: string; mode?: string; reset?: boolean; parallel?: boolean; gitHead?: string; gitBranch?: string; builtAt?: string }) => {
    const workspace = path.resolve(opts.workspace ?? process.cwd());
    const { buildCiBundle } = await import('../bundle/ci.js');
    try {
      const builtAt = opts.builtAt ? parseInt(opts.builtAt, 10) : undefined;
      const r = await buildCiBundle({
        repoRoot: workspace, out: opts.out,
        mode: parseMode(opts.mode),
        reset: opts.reset, parallel: opts.parallel,
        gitHead: opts.gitHead, gitBranch: opts.gitBranch,
        builtAt: (builtAt != null && !isNaN(builtAt)) ? builtAt : undefined,
      });
      console.log(`\n   CI bundle: ${r.bundle.bundlePath}`);
      console.log(`    ${r.index.symbols.toLocaleString()} symbols / ${r.index.edges.toLocaleString()} edges in ${r.totalElapsedMs}ms`);
    } catch (err) {
      console.error(`\n   CI bundle failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

ciCmd
  .command('workflow')
  .description('Emit a ready-to-paste GitHub Actions workflow that builds a bundle on push')
  .action(async () => {
    const { workflowTemplate } = await import('../bundle/ci.js');
    process.stdout.write(workflowTemplate());
  });

//  Track-F: SCIP import

program
  .command('scip-import <scip-path>')
  .description('Import a SCIP precision index. Adds source-labelled precise edges over the tree-sitter baseline.')
  .option('--workspace <path>', 'Workspace path (defaults to cwd)')
  .option('--db <path>', 'Database path')
  .option('--require-file-in-index', 'Skip SCIP docs whose file isn\'t already indexed (default: on)')
  .option('--no-require-file-in-index', 'Accept SCIP docs for files outside the tree-sitter index')
  .action(async (scipPath: string, opts: { workspace?: string; db?: string; requireFileInIndex?: boolean }) => {
    const workspace = path.resolve(opts.workspace ?? process.cwd());
    const dbPath = opts.db ?? path.join(workspace, '.seer', 'graph.db');
    if (!fs.existsSync(dbPath)) {
      console.error(`No index at ${dbPath}. Run "seer index <path>" first.`);
      process.exit(1);
    }
    const { importScip } = await import('../scip/import.js');
    const store = new Store(dbPath);
    try {
      const r = await importScip(path.resolve(scipPath), store, {
        repoRoot: workspace,
        requireFileInIndex: opts.requireFileInIndex ?? true,
        log: (m) => console.log(`  ${m}`),
      });
      console.log(`\n   SCIP import done in ${r.elapsedMs}ms`);
      console.log(`    docs=${r.documentsProcessed}  symbols=${r.symbolsInserted} new, ${r.symbolsMerged} merged`);
      console.log(`    edges=${r.edgesInserted}  filesMissing=${r.filesMissing}`);
      console.log(`    tool=${r.tool ?? ''}  sha=${r.sha256.slice(0, 12)}...`);
    } finally { store.close(); }
  });

//  Track-F: duplicate detection

program
  .command('duplicates')
  .alias('dupes')
  .description('Find clusters of structurally-similar functions (SimHash)')
  .option('--db <path>', 'Database path')
  .option('--max-distance <n>', 'Max Hamming distance for two symbols to cluster (default: 6)', '6')
  .option('--min-loc <n>', 'Minimum lines-of-code to consider (default: 4)', '4')
  .option('--include-tests', 'Include test files (off by default)')
  .option('-n, --limit <n>', 'Max clusters to show', '40')
  .action(async (opts: { db?: string; maxDistance: string; minLoc: string; includeTests?: boolean; limit: string }) => {
    const dbPath = opts.db ?? findDbFromCwd();
    const store = openStore(dbPath);
    try {
      const { findDuplicates } = await import('../indexer/shapehash.js');
      const clusters = findDuplicates(store, {
        maxDistance: parseInt(opts.maxDistance, 10) || 6,
        minLoc: parseInt(opts.minLoc, 10) || 4,
        includeTests: opts.includeTests,
        maxClusters: parseInt(opts.limit, 10) || 40,
      });
      if (clusters.length === 0) {
        console.log('No duplicate clusters found (have you run `seer index`?  shape hashes are built during indexing).');
        return;
      }
      console.log(`\nFound ${clusters.length} duplicate cluster(s):\n`);
      for (const c of clusters) {
        console.log(`  Cluster (${c.symbols.length} symbols, fingerprint=${c.fingerprint.toString(16).slice(0, 8)}...)`);
        for (const s of c.symbols) {
          console.log(`    [d=${s.hammingFromAnchor.toString().padStart(2)}]  ${(s.qualifiedName ?? s.name).padEnd(40)} ${s.kind.padEnd(10)} loc=${(s.loc ?? '?').toString().padStart(3)}  ${s.file}:${s.lineStart + 1}`);
        }
        console.log();
      }
    } finally { store.close(); }
  });

//  seer mcp

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

//  DB auto-detection

function parseMode(input: string | undefined): 'full' | 'standard' | 'fast' | undefined {
  if (!input) return undefined;
  const v = input.toLowerCase();
  if (v === 'full' || v === 'standard' || v === 'fast') return v;
  console.error(`Invalid --mode: ${input}.`);
  process.exit(1);
}

function findDbFromCwd(): string {
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, '.seer', 'graph.db');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  console.error('Could not find .seer/graph.db. Run "seer index <path>" first.');
  process.exit(1);
}

program.parse(process.argv);
