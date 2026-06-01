import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * `seer init` — one command that wires Seer into whatever AI coding agents a
 * developer is running. The hard part of "install an MCP server" is never the
 * server; it is that every client invented its own config file, root key, and
 * location. This module knows them all and writes the right snippet to the
 * right place, idempotently.
 *
 * It also drops agent guidance files (AGENTS.md, plus client-native mirrors
 * like CLAUDE.md and GEMINI.md) so agents know Seer exists and how to use it
 * well, rather than ignoring a tool they were never told about.
 *
 * Everything here is deterministic and local. No network, no telemetry.
 */

export type ClientId =
  | 'claude'
  | 'cursor'
  | 'vscode'
  | 'codex'
  | 'gemini'
  | 'antigravity'
  | 'windsurf';

export interface InitOptions {
  workspace: string;
  clients?: ClientId[];   // explicit subset; default = the project-local set
  global?: boolean;       // write user-level config instead of project-local
  command?: string;       // override the launch command line entirely
  npx?: boolean;          // emit the portable `npx -y <pkg> mcp` launcher
  pkg?: string;           // npm package name for the npx launcher
  agents?: boolean;       // write agent guidance files (default true)
  print?: boolean;        // dry run: report the plan, write nothing
  force?: boolean;        // overwrite an existing seer entry / guidance block
  db?: string;            // custom db path passed through to the launcher
}

interface LaunchSpec {
  command: string;
  args: string[];
}

/** All clients we know how to configure, in display order. */
const ALL_CLIENTS: ClientId[] = ['claude', 'cursor', 'vscode', 'codex', 'gemini', 'antigravity', 'windsurf'];

/** The default set when the user does not name clients: everything that has a
 *  clean project-local config. User-level-only clients are opt-in. */
const DEFAULT_CLIENTS: ClientId[] = ['claude', 'cursor', 'vscode', 'codex', 'gemini'];

const DEFAULT_PKG = 'seer-mcp';
const AGENTS_BEGIN = '<!-- seer:begin -->';
const AGENTS_END = '<!-- seer:end -->';

interface PlanEntry {
  client: ClientId;
  label: string;
  file: string;
  action: 'wrote' | 'updated' | 'skipped' | 'manual';
  note?: string;
  snippet?: string;
}

interface ContextFileResult {
  file: string;
  action: 'wrote' | 'updated' | 'skipped';
  label: string;
}

export interface InitResult {
  launch: LaunchSpec;
  entries: PlanEntry[];
  agents?: ContextFileResult;
  /**
   * Extra agent-instruction files written for clients that load their own
   * convention rather than AGENTS.md (e.g. CLAUDE.md for Claude Code,
   * GEMINI.md for Gemini / Antigravity). Same idempotent markers.
   */
  contextFiles?: ContextFileResult[];
}

// ── Launcher resolution ─────────────────────────────────────────────────────

/**
 * Figure out how an agent should start the Seer MCP server. Two shapes:
 *   - npx form:  fully portable, no machine paths. Relies on the client
 *                launching the server with cwd = project root.
 *   - node form: an absolute path to the built CLI. Works today, before the
 *                package is published, but is machine-specific.
 */
function resolveLaunch(workspace: string, opts: InitOptions): LaunchSpec {
  if (opts.command && opts.command.trim()) {
    const parts = opts.command.trim().split(/\s+/);
    return { command: parts[0], args: parts.slice(1) };
  }

  // The compiled CLI entry. __dirname is dist/cli when built; map a src/.ts
  // path back to dist/.js so the snippet we emit always points at the thing
  // agents can actually run.
  let entry = path.join(__dirname, 'index.js');
  if (entry.includes(`${path.sep}src${path.sep}`) || entry.endsWith('.ts')) {
    entry = entry
      .replace(`${path.sep}src${path.sep}`, `${path.sep}dist${path.sep}`)
      .replace(/\.ts$/, '.js');
  }

  // When Seer is running from an npm install (global, local, or `npx`), the
  // entry lives inside a node_modules tree whose path is unstable across
  // machines and cache evictions. In that case the portable `npx` launcher is
  // the right default, which is what makes `npx seer-mcp init` produce
  // zero-tinkering, shareable config. From a source checkout we keep the
  // absolute node path so it works without publishing.
  const installed = entry.includes(`${path.sep}node_modules${path.sep}`);
  if (opts.npx || installed) {
    const args = ['-y', opts.pkg || DEFAULT_PKG, 'mcp'];
    if (opts.db) args.push('--db', opts.db);
    return { command: 'npx', args };
  }

  const args = [entry, 'mcp', '--workspace', workspace];
  if (opts.db) args.push('--db', opts.db);
  return { command: 'node', args };
}

// ── Small file helpers ──────────────────────────────────────────────────────

function readJsonTolerant(file: string): { ok: true; data: any } | { ok: false } {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return { ok: true, data: {} };
    // Tolerate JSONC (// and /* */ comments, trailing commas) so we do not
    // choke on a hand-edited VS Code mcp.json.
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/,(\s*[}\]])/g, '$1');
    return { ok: true, data: JSON.parse(stripped) };
  } catch {
    return { ok: false };
  }
}

function ensureDir(file: string): void {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Per-client writers ──────────────────────────────────────────────────────

interface ClientSpec {
  label: string;
  /** Project-local config path, relative to workspace. Null = user-level only. */
  projectPath: string | null;
  /** User-level (global) config path. Null = project-only. */
  globalPath: string | null;
  /** Additional project-local paths for clients that read more than one file. */
  extraProjectPaths?: string[];
  /** Additional user-level paths for clients with split or legacy locations. */
  extraGlobalPaths?: string[];
  rootKey: 'mcpServers' | 'servers';
  /** VS Code wants an explicit `type: "stdio"` on each entry. */
  stdioType?: boolean;
  /** Codex is TOML, not JSON. */
  toml?: boolean;
}

function home(...p: string[]): string {
  return path.join(os.homedir(), ...p);
}

const CLIENTS: Record<ClientId, ClientSpec> = {
  claude: {
    label: 'Claude Code',
    projectPath: '.mcp.json',
    globalPath: home('.claude.json'),
    rootKey: 'mcpServers',
  },
  cursor: {
    label: 'Cursor',
    projectPath: path.join('.cursor', 'mcp.json'),
    globalPath: home('.cursor', 'mcp.json'),
    rootKey: 'mcpServers',
  },
  vscode: {
    label: 'VS Code (Copilot / native MCP)',
    projectPath: path.join('.vscode', 'mcp.json'),
    globalPath: null,
    rootKey: 'servers',
    stdioType: true,
  },
  codex: {
    label: 'OpenAI Codex',
    projectPath: path.join('.codex', 'config.toml'),
    globalPath: home('.codex', 'config.toml'),
    rootKey: 'mcpServers',
    toml: true,
  },
  gemini: {
    label: 'Gemini CLI',
    projectPath: path.join('.gemini', 'settings.json'),
    globalPath: home('.gemini', 'settings.json'),
    rootKey: 'mcpServers',
  },
  antigravity: {
    label: 'Google Antigravity',
    projectPath: null,
    globalPath: home('.gemini', 'antigravity', 'mcp_config.json'),
    extraProjectPaths: [path.join('.agents', 'mcp_config.json')],
    extraGlobalPaths: [
      home('.gemini', 'antigravity-cli', 'mcp_config.json'),
      home('.gemini', 'config', 'mcp_config.json'),
      home('.gemini', 'antigravity-ide', 'mcp_config.json'),
    ],
    rootKey: 'mcpServers',
  },
  windsurf: {
    label: 'Windsurf',
    projectPath: null,
    globalPath: home('.codeium', 'windsurf', 'mcp_config.json'),
    rootKey: 'mcpServers',
  },
};

function jsonEntry(launch: LaunchSpec, stdioType: boolean): Record<string, any> {
  const entry: Record<string, any> = {};
  if (stdioType) entry.type = 'stdio';
  entry.command = launch.command;
  entry.args = launch.args;
  return entry;
}

function tomlBlock(launch: LaunchSpec): string {
  const argList = launch.args.map((a) => JSON.stringify(a)).join(', ');
  return [
    '[mcp_servers.seer]',
    `command = ${JSON.stringify(launch.command)}`,
    `args = [${argList}]`,
    '',
  ].join('\n');
}

function writeJsonClient(
  spec: ClientSpec,
  file: string,
  launch: LaunchSpec,
  opts: InitOptions,
): PlanEntry {
  const base: PlanEntry = { client: 'claude', label: spec.label, file, action: 'wrote' };
  const entry = jsonEntry(launch, !!spec.stdioType);
  const snippet = JSON.stringify({ [spec.rootKey]: { seer: entry } }, null, 2);

  if (opts.print) {
    return { ...base, action: fs.existsSync(file) ? 'updated' : 'wrote', snippet, note: 'dry run' };
  }

  let data: any = {};
  let existed = false;
  if (fs.existsSync(file)) {
    existed = true;
    const parsed = readJsonTolerant(file);
    if (!parsed.ok) {
      return {
        ...base,
        action: 'manual',
        note: `could not parse existing ${path.basename(file)}; add the snippet by hand`,
        snippet,
      };
    }
    data = parsed.data || {};
  }

  if (!data[spec.rootKey] || typeof data[spec.rootKey] !== 'object') data[spec.rootKey] = {};
  if (data[spec.rootKey].seer && !opts.force) {
    return { ...base, action: 'skipped', note: 'seer entry already present (use --force to overwrite)' };
  }
  data[spec.rootKey].seer = entry;

  ensureDir(file);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return { ...base, action: existed ? 'updated' : 'wrote' };
}

function writeTomlClient(
  spec: ClientSpec,
  file: string,
  launch: LaunchSpec,
  opts: InitOptions,
): PlanEntry {
  const base: PlanEntry = { client: 'codex', label: spec.label, file, action: 'wrote' };
  const block = tomlBlock(launch);

  if (opts.print) {
    return { ...base, action: fs.existsSync(file) ? 'updated' : 'wrote', snippet: block, note: 'dry run' };
  }

  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    if (/^[ \t]*\[mcp_servers\.seer\]/m.test(raw)) {
      if (!opts.force) {
        return { ...base, action: 'skipped', note: 'mcp_servers.seer already present (use --force to overwrite)' };
      }
      // Replace the existing block: splice out from its header line to the
      // next TOML table header (or end of file), then drop the fresh block in.
      const lines = raw.split('\n');
      const start = lines.findIndex((l) => /^[ \t]*\[mcp_servers\.seer\]/.test(l));
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i++) {
        if (/^[ \t]*\[/.test(lines[i])) { end = i; break; }
      }
      const next = [...lines.slice(0, start), ...block.split('\n'), ...lines.slice(end)].join('\n');
      fs.writeFileSync(file, next, 'utf8');
      return { ...base, action: 'updated' };
    }
    const sep = raw.endsWith('\n') ? '\n' : '\n\n';
    fs.writeFileSync(file, raw + sep + block, 'utf8');
    return { ...base, action: 'updated' };
  }

  ensureDir(file);
  fs.writeFileSync(file, block, 'utf8');
  return { ...base, action: 'wrote' };
}

function configureClient(
  client: ClientId,
  launch: LaunchSpec,
  opts: InitOptions,
): PlanEntry[] {
  const spec = CLIENTS[client];
  const useGlobal = opts.global || spec.projectPath === null;
  const rel = useGlobal ? spec.globalPath : spec.projectPath;

  const writeTarget = (target: string): PlanEntry => {
    const file = path.isAbsolute(target) ? target : path.join(opts.workspace, target);
    const result = spec.toml
      ? writeTomlClient(spec, file, launch, opts)
      : writeJsonClient(spec, file, launch, opts);
    return { ...result, client };
  };

  const results: PlanEntry[] = [];
  if (!rel) {
    // e.g. asked for project-local antigravity, which does not exist.
    results.push({
      client,
      label: spec.label,
      file: '(n/a)',
      action: 'manual',
      note: `${spec.label} has no ${useGlobal ? 'user-level' : 'project-local'} config; try the other scope`,
    });
  } else {
    results.push(writeTarget(rel));
  }

  if (!opts.global) {
    for (const extra of spec.extraProjectPaths ?? []) results.push(writeTarget(extra));
  }
  if (useGlobal || opts.global) {
    for (const extra of spec.extraGlobalPaths ?? []) results.push(writeTarget(extra));
  }
  return results;
}

// ── AGENTS.md ───────────────────────────────────────────────────────────────

function agentsBlock(): string {
  return [
    AGENTS_BEGIN,
    '## Seer — use it FIRST for any code navigation in this repo',
    '',
    'This repo is indexed by **Seer**, a local MCP server (tool prefix',
    '`seer_`) that returns deterministic structural facts about the code:',
    'definitions, call graphs, routes, tests, edit-risk, monorepo boundaries,',
    'and per-symbol git history. It is backed by a tree-sitter + SQLite index,',
    'is always in sync (a watcher + per-query freshness check keep it current),',
    'and answers in a fraction of the tokens a grep-and-read sweep would burn.',
    '',
    '### Hard rule',
    '',
    'For any **structural** question — "where is X defined", "what calls X",',
    '"what would break if I change X", "what tests cover X", "what are the',
    'routes / modules / dependencies" — **call a `seer_` tool first.** Reach for',
    '`grep`/`ripgrep`/`view_file` only when Seer returns nothing, or for things',
    'Seer does not index: comments, string literals, config values, and docs.',
    'Do not open files blindly to find a symbol — `seer_definition` jumps',
    'straight to it.',
    '',
    '### Which tool for which question',
    '',
    '| You want to… | Use | Instead of |',
    '| --- | --- | --- |',
    '| Find a symbol / file by name | `seer_search` | `grep -r`, fuzzy file open |',
    '| Jump to a definition | `seer_definition { name }` | grepping for `function X` |',
    '| See who calls something | `seer_callers { symbol }` | grepping the name |',
    '| See what something calls | `seer_callees { symbol }` | reading the body |',
    '| Everything before editing a symbol | `seer_preflight { symbol }` | 10 separate searches |',
    '| Blast radius of your diff | `seer_preflight { fromRef, toRef }` | guessing |',
    '| Tests that pin a behavior | `seer_behavior { symbol }` | scanning test dirs |',
    '| Per-symbol git history / blame | `seer_history { symbol }` | `git log -S` |',
    '| Read a big file cheaply | `seer_skeleton { file }` | reading 2000 lines |',
    '| Orient in an unfamiliar repo | `seer_architecture`, `seer_boundaries` | spelunking |',
    '',
    '### Default workflow',
    '',
    '1. `seer_health` — confirm the index is live (one cheap call).',
    '2. `seer_search` / `seer_definition` — locate the symbol or file.',
    '3. `seer_preflight { symbol }` — pull definition, callers, tests, risk, and',
    '   history in ONE call before you edit.',
    '4. `seer_preflight { fromRef: "main", toRef: "HEAD" }` — blast radius of a diff.',
    '',
    'Batch several read-only lookups into one round-trip with `seer_batch`. If a',
    'name is misspelled, Seer returns `didYouMean` suggestions — use them rather',
    'than falling back to grep.',
    AGENTS_END,
  ].join('\n');
}

function claudeImportBlock(): string {
  return [
    AGENTS_BEGIN,
    '@AGENTS.md',
    AGENTS_END,
  ].join('\n');
}

/**
 * Write (or idempotently update) the managed Seer guidance block into an
 * agent-instruction file. Used for AGENTS.md and client-native mirrors/imports
 * like CLAUDE.md and GEMINI.md. The block is fenced by stable markers so
 * re-runs never duplicate it and any surrounding user content is preserved.
 */
function writeContextFile(
  fileName: string,
  label: string,
  opts: InitOptions,
  block = agentsBlock(),
): ContextFileResult {
  const file = path.join(opts.workspace, fileName);

  if (opts.print) {
    return { file, label, action: fs.existsSync(file) ? 'updated' : 'wrote' };
  }

  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.includes(AGENTS_BEGIN) && raw.includes(AGENTS_END)) {
      if (!opts.force) return { file, label, action: 'skipped' };
      const replaced = raw.replace(
        new RegExp(`${AGENTS_BEGIN}[\\s\\S]*?${AGENTS_END}`),
        block,
      );
      fs.writeFileSync(file, replaced, 'utf8');
      return { file, label, action: 'updated' };
    }
    const sep = raw.endsWith('\n') ? '\n' : '\n\n';
    fs.writeFileSync(file, raw + sep + block + '\n', 'utf8');
    return { file, label, action: 'updated' };
  }

  fs.writeFileSync(file, block + '\n', 'utf8');
  return { file, label, action: 'wrote' };
}

// ── Entry point ─────────────────────────────────────────────────────────────

export function runInit(opts: InitOptions): InitResult {
  const workspace = path.resolve(opts.workspace);
  const clients = (opts.clients && opts.clients.length ? opts.clients : DEFAULT_CLIENTS)
    .filter((c) => ALL_CLIENTS.includes(c));

  const launch = resolveLaunch(workspace, { ...opts, workspace });

  const entries = clients.flatMap((c) => configureClient(c, launch, { ...opts, workspace }));

  let agents: ContextFileResult | undefined;
  let contextFiles: ContextFileResult[] | undefined;
  if (opts.agents !== false) {
    agents = writeContextFile('AGENTS.md', 'AGENTS.md (agent guide)', { ...opts, workspace });
    contextFiles = [];
    if (clients.includes('claude')) {
      contextFiles.push(writeContextFile(
        'CLAUDE.md',
        'CLAUDE.md (Claude guide)',
        { ...opts, workspace },
        claudeImportBlock(),
      ));
    }
    // The Gemini CLI and Google Antigravity load GEMINI.md as their native
    // context file and do not reliably read AGENTS.md. When either is being
    // configured, mirror the same managed block there so the agent is actually
    // told Seer exists — this is the difference between Gemini using Seer and
    // defaulting to grep.
    if (clients.includes('gemini') || clients.includes('antigravity')) {
      contextFiles.push(writeContextFile('GEMINI.md', 'GEMINI.md (Gemini guide)', { ...opts, workspace }));
    }
    if (contextFiles.length === 0) contextFiles = undefined;
  }

  return { launch, entries, agents, contextFiles };
}
