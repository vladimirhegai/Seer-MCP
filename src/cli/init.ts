import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';

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
  auto?: boolean;          // workspace-local setup; user-level clients stay opt-in
  global?: boolean;       // write user-level config instead of project-local
  command?: string;       // override the launch command line entirely
  npx?: boolean;          // emit the portable `npx -y <pkg> mcp` launcher
  pkg?: string;           // npm package name for the npx launcher
  agents?: boolean;       // write agent guidance files (default true)
  print?: boolean;        // dry run: report the plan, write nothing
  force?: boolean;        // overwrite an existing seer entry / guidance block
  db?: string;            // custom db path passed through to the launcher
}

export interface UpdateOptions extends InitOptions {
  /**
   * When true, refresh only user-level files. By default update refreshes any
   * existing Seer entry it can find for the selected clients.
   */
  global?: boolean;
}

interface LaunchSpec {
  command: string;
  args: string[];
}

/** All clients we know how to configure, in display order. */
const ALL_CLIENTS: ClientId[] = ['claude', 'cursor', 'vscode', 'codex', 'gemini', 'antigravity', 'windsurf'];

/** The default set when the user does not name clients: everything that has a
 *  clean project/workspace-local config. User-level-only clients are opt-in. */
const DEFAULT_CLIENTS: ClientId[] = ['claude', 'cursor', 'vscode', 'codex', 'gemini', 'antigravity'];

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
function resolveLaunch(
  workspace: string,
  opts: InitOptions,
  includeWorkspaceForNpx = false,
): LaunchSpec {
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
  // zero-tinkering config. A few editor-hosted clients still need an explicit
  // --workspace because they launch MCP from the editor process directory.
  // From a source checkout we keep the absolute node path so it works without
  // publishing.
  const installed = entry.includes(`${path.sep}node_modules${path.sep}`);
  if (opts.npx || installed) {
    const args = ['-y', opts.pkg || DEFAULT_PKG, 'mcp'];
    if (includeWorkspaceForNpx) args.push('--workspace', workspace);
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
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
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
  /** Some workspace-local clients launch MCP from the editor process cwd. */
  projectWorkspaceArg?: boolean;
  /** Some clients cache MCP servers by id across workspaces; make Seer id repo-specific. */
  workspaceServerName?: boolean;
  /** Some clients support cwd and otherwise launch stdio servers from the editor install dir. */
  cwd?: boolean;
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
    projectPath: path.join('.agents', 'mcp_config.json'),
    globalPath: home('.gemini', 'antigravity', 'mcp_config.json'),
    extraGlobalPaths: [
      home('.gemini', 'antigravity-cli', 'mcp_config.json'),
      home('.gemini', 'config', 'mcp_config.json'),
      home('.gemini', 'antigravity-ide', 'mcp_config.json'),
    ],
    rootKey: 'mcpServers',
    projectWorkspaceArg: true,
    workspaceServerName: true,
    cwd: true,
  },
  windsurf: {
    label: 'Windsurf',
    projectPath: null,
    globalPath: home('.codeium', 'windsurf', 'mcp_config.json'),
    rootKey: 'mcpServers',
  },
};

const ANTIGRAVITY_ENV_KEYS = [
  'ANTIGRAVITY',
  'ANTIGRAVITY_IDE',
  'GOOGLE_ANTIGRAVITY',
  'VSCODE_CWD',
  'VSCODE_CODE_CACHE_PATH',
  'VSCODE_USER_DATA_DIR',
];

function envLooksLikeAntigravity(): boolean {
  return ANTIGRAVITY_ENV_KEYS.some((key) =>
    typeof process.env[key] === 'string' && /antigravity/i.test(process.env[key] ?? ''),
  );
}

function workspaceHasAntigravityConfig(workspace: string): boolean {
  const projectPath = CLIENTS.antigravity.projectPath;
  return projectPath ? fs.existsSync(targetPath(workspace, projectPath)) : false;
}

function isAntigravityInstall(workspace: string): boolean {
  return envLooksLikeAntigravity() || workspaceHasAntigravityConfig(workspace);
}

interface TargetSpec {
  file: string;
  isGlobal: boolean;
}

function targetPath(workspace: string, target: string): string {
  return path.isAbsolute(target) ? target : path.join(workspace, target);
}

function workspaceSlug(workspace: string): string {
  const base = path.basename(path.resolve(workspace)) || 'workspace';
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'workspace';
}

function workspaceHash(workspace: string): string {
  return crypto.createHash('sha1').update(path.resolve(workspace).toLowerCase()).digest('hex').slice(0, 8);
}

function serverNameFor(spec: ClientSpec, workspace: string): string {
  if (!spec.workspaceServerName) return 'seer';
  return `seer_${workspaceSlug(workspace)}_${workspaceHash(workspace)}`;
}

function isManagedSeerServerName(name: string): boolean {
  return name === 'seer' || /^seer[_-][a-z0-9][a-z0-9_-]*$/i.test(name);
}

function seerServerNames(spec: ClientSpec, root: any): string[] {
  if (!root || typeof root !== 'object') return [];
  if (!spec.workspaceServerName) return root.seer ? ['seer'] : [];
  return Object.keys(root).filter(isManagedSeerServerName);
}

function pruneEmptyParents(file: string, stopDir: string): void {
  const stop = path.resolve(stopDir);
  let dir = path.resolve(path.dirname(file));
  while (dir !== stop && dir.startsWith(stop + path.sep)) {
    try {
      if (fs.readdirSync(dir).length !== 0) return;
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

function pruneStopDir(file: string, workspace: string, targetIsGlobal: boolean): string {
  if (!targetIsGlobal) return workspace;
  const homeDir = os.homedir();
  const relative = path.relative(homeDir, path.resolve(file));
  if (relative.startsWith('..') || path.isAbsolute(relative)) return path.dirname(file);
  return homeDir;
}

function clientTargets(client: ClientId, workspace: string, scope: 'init' | 'all' | 'global'): TargetSpec[] {
  const spec = CLIENTS[client];
  const targets: TargetSpec[] = [];
  if (scope !== 'global') {
    if (spec.projectPath) targets.push({ file: targetPath(workspace, spec.projectPath), isGlobal: false });
    for (const extra of spec.extraProjectPaths ?? []) {
      targets.push({ file: targetPath(workspace, extra), isGlobal: false });
    }
  }
  if (scope === 'global' || scope === 'all') {
    if (spec.globalPath) targets.push({ file: spec.globalPath, isGlobal: true });
    for (const extra of spec.extraGlobalPaths ?? []) {
      targets.push({ file: extra, isGlobal: true });
    }
  }
  return targets;
}

export function detectAutoClients(_workspace: string): ClientId[] {
  if (isAntigravityInstall(_workspace)) return ['antigravity'];
  const selected = new Set<ClientId>(DEFAULT_CLIENTS);
  // `--auto` is intentionally workspace-local. Do not add user-level-only
  // clients here; they can shadow other repos and need explicit opt-in.
  return ALL_CLIENTS.filter((c) => selected.has(c));
}

function jsonHasSeer(spec: ClientSpec, file: string): boolean | null {
  const parsed = readJsonTolerant(file);
  if (!parsed.ok) return null;
  const root = parsed.data?.[spec.rootKey];
  return seerServerNames(spec, root).length > 0;
}

function tomlHasSeer(file: string): boolean {
  try {
    return /^[ \t]*\[mcp_servers\.seer\]/m.test(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

function hasSeerEntry(client: ClientId, file: string): boolean | null {
  if (!fs.existsSync(file)) return false;
  const spec = CLIENTS[client];
  return spec.toml ? tomlHasSeer(file) : jsonHasSeer(spec, file);
}

export function detectConfiguredClients(
  workspace: string,
  opts: { global?: boolean; includePinnedOther?: boolean } = {},
): ClientId[] {
  const scope = opts.global ? 'global' : 'all';
  const resolvedWorkspace = path.resolve(workspace);
  return ALL_CLIENTS.filter((client) => {
    const spec = CLIENTS[client];
    return clientTargets(client, resolvedWorkspace, scope).some((target) => {
      if (hasSeerEntry(client, target.file) !== true) return false;
      if (!target.isGlobal || opts.includePinnedOther) return true;
      const pinnedWorkspace = entryWorkspace(spec, target.file, resolvedWorkspace);
      return pinnedWorkspace === undefined || pinnedWorkspace === null || sameResolvedPath(pinnedWorkspace, resolvedWorkspace);
    });
  });
}

function jsonEntry(launch: LaunchSpec, stdioType: boolean, cwd?: string): Record<string, any> {
  const entry: Record<string, any> = {};
  if (stdioType) entry.type = 'stdio';
  entry.command = launch.command;
  entry.args = launch.args;
  if (cwd) entry.cwd = cwd;
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

function workspaceFromArgs(args: unknown): string | undefined {
  if (!Array.isArray(args)) return undefined;
  const idx = args.findIndex((a) => a === '--workspace');
  const value = idx >= 0 ? args[idx + 1] : undefined;
  return typeof value === 'string' && value.trim() ? path.resolve(value) : undefined;
}

function workspaceFromJsonEntry(entry: any): string | undefined {
  return workspaceFromArgs(entry?.args) ??
    (typeof entry?.cwd === 'string' && entry.cwd.trim() ? path.resolve(entry.cwd) : undefined);
}

function sameResolvedPath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function jsonEntryWorkspace(spec: ClientSpec, file: string, workspace?: string): string | undefined | null {
  const parsed = readJsonTolerant(file);
  if (!parsed.ok) return null;
  const root = parsed.data?.[spec.rootKey];
  const names = seerServerNames(spec, root);
  if (names.length === 0) return undefined;
  if (workspace && spec.workspaceServerName) {
    const expected = serverNameFor(spec, workspace);
    const preferred = names.find((name) => name === expected) ??
      names.find((name) => {
        const pinned = workspaceFromJsonEntry(root[name]);
        return pinned ? sameResolvedPath(pinned, workspace) : false;
      });
    if (preferred) return workspaceFromJsonEntry(root[preferred]);
  }
  return workspaceFromJsonEntry(root[names[0]]);
}

function tomlEntryWorkspace(file: string): string | undefined | null {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return undefined; }
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => /^[ \t]*\[mcp_servers\.seer\]/.test(l));
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[ \t]*\[/.test(lines[i])) { end = i; break; }
  }
  const block = lines.slice(start, end).join('\n');
  const m = block.match(/^[ \t]*args[ \t]*=[ \t]*(\[[\s\S]*?\])/m);
  if (!m) return undefined;
  try { return workspaceFromArgs(JSON.parse(m[1])); }
  catch { return null; }
}

function entryWorkspace(spec: ClientSpec, file: string, workspace?: string): string | undefined | null {
  return spec.toml ? tomlEntryWorkspace(file) : jsonEntryWorkspace(spec, file, workspace);
}

function writeJsonClient(
  spec: ClientSpec,
  file: string,
  launch: LaunchSpec,
  opts: InitOptions,
  updateExisting = false,
): PlanEntry {
  const base: PlanEntry = { client: 'claude', label: spec.label, file, action: 'wrote' };
  const serverName = serverNameFor(spec, opts.workspace);
  const entry = jsonEntry(launch, !!spec.stdioType, spec.cwd ? opts.workspace : undefined);
  const snippet = JSON.stringify({ [spec.rootKey]: { [serverName]: entry } }, null, 2);

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
  const root = data[spec.rootKey];

  // Antigravity can keep MCP servers alive across workspaces by server id.
  // Migrate the old shared "seer" id into the deterministic workspace id so
  // Project A and Project B do not fight over one cached process.
  let migratedLegacy = false;
  if (spec.workspaceServerName && root.seer) {
    const legacyWorkspace = workspaceFromJsonEntry(root.seer) ?? opts.workspace;
    const legacyName = serverNameFor(spec, legacyWorkspace);
    if (!root[legacyName]) root[legacyName] = root.seer;
    delete root.seer;
    migratedLegacy = true;
  }

  if (root[serverName] && !opts.force) {
    if (!updateExisting) {
      if (!migratedLegacy) {
        return { ...base, action: 'skipped', note: 'seer entry already present (use --force to overwrite)' };
      }
    } else if (JSON.stringify(root[serverName]) === JSON.stringify(entry)) {
      if (!migratedLegacy) {
        return { ...base, action: 'skipped', note: 'seer entry already current' };
      }
    }
  }
  root[serverName] = entry;

  ensureDir(file);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return { ...base, action: existed ? 'updated' : 'wrote' };
}

function writeTomlClient(
  spec: ClientSpec,
  file: string,
  launch: LaunchSpec,
  opts: InitOptions,
  updateExisting = false,
): PlanEntry {
  const base: PlanEntry = { client: 'codex', label: spec.label, file, action: 'wrote' };
  const block = tomlBlock(launch);

  if (opts.print) {
    return { ...base, action: fs.existsSync(file) ? 'updated' : 'wrote', snippet: block, note: 'dry run' };
  }

  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    if (/^[ \t]*\[mcp_servers\.seer\]/m.test(raw)) {
      if (!opts.force && !updateExisting) {
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
  opts: InitOptions,
): PlanEntry[] {
  const spec = CLIENTS[client];
  const useGlobal = opts.global || spec.projectPath === null;
  const rel = useGlobal ? spec.globalPath : spec.projectPath;
  const projectLaunch = resolveLaunch(opts.workspace, opts, !!spec.projectWorkspaceArg);
  const globalLaunch = resolveLaunch(opts.workspace, opts, true);

  const writeTarget = (target: string, targetIsGlobal: boolean): PlanEntry => {
    const file = targetPath(opts.workspace, target);
    const launch = targetIsGlobal ? globalLaunch : projectLaunch;
    const result = spec.toml
      ? writeTomlClient(spec, file, launch, opts, targetIsGlobal)
      : writeJsonClient(spec, file, launch, opts, targetIsGlobal);
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
    results.push(writeTarget(rel, useGlobal));
  }

  if (!opts.global) {
    for (const extra of spec.extraProjectPaths ?? []) results.push(writeTarget(extra, false));
  }
  if (useGlobal || opts.global) {
    for (const extra of spec.extraGlobalPaths ?? []) results.push(writeTarget(extra, true));
  }
  return results;
}

// ── AGENTS.md ───────────────────────────────────────────────────────────────

function agentsBlock(): string {
  return [
    AGENTS_BEGIN,
    '## Seer',
    '',
    'Seer is the first stop for code structure in this repo. Use the `seer_*`',
    'MCP tools before `rg`, file reads, or broad manual search when the task',
    'involves symbols, callers, tests, dependencies, boundaries, risk, or git',
    'history.',
    '',
    'Core tools:',
    '- `seer_health`: confirm this Seer server is for this repo.',
    '- `seer_search`: find symbols or files when you do not know the exact target.',
    '- `seer_definition` / `seer_file_symbols`: resolve the best hit.',
    '- `seer_context` / `seer_preflight`: gather edit evidence before reading or changing code.',
    '- `seer_trace`, `seer_callers`, `seer_callees`: drill into impact paths.',
    '',
    'Required workflow before editing code:',
    '1. Call `seer_health` once and confirm `workspace` is this repo.',
    '2. If `seer_health.workspace` is not this repo, stop using Seer for this',
    '   task and tell the user to restart/reload the agent after running',
    '   `npx seer-mcp init --auto --force` in this repo.',
    '3. If `seer_health` is unavailable or times out, report that the MCP',
    '   session is stale/unavailable; do not inspect Seer config or use stale results.',
    '4. If you know the target symbol, call `seer_context { symbol }` or',
    '   `seer_preflight { symbol }` before reading files.',
    '5. If you do not know the symbol, call `seer_search` first, then',
    '   `seer_definition` or `seer_file_symbols` on the best hit.',
    '6. For common method names, pass `file` to `seer_context`, `seer_callers`,',
    '   or `seer_trace` callers so Seer uses the exact symbol definition.',
    '7. For changes already in the working tree, call `seer_preflight` with',
    '   `fromRef`/`toRef` or the target symbol before summarizing impact.',
    '',
    'Common follow-ups:',
    '- `seer_callers` / `seer_callees`: direct call graph.',
    '- `seer_trace`: transitive callers/callees, file, module, or service paths.',
    '  For large graphs, start with `mode: "summary"` or the default compact',
    '  preview. Page with `offset`/`limit`; use `mode: "full"` only when raw',
    '  rows are needed.',
    '- `seer_behavior`: tests that describe expected behavior.',
    '- `seer_history`: read-only commits that touched a symbol.',
    '  If `historyIndex.built` is false, say history is not built; only run',
    '  `seer_symbol_history_build` or `seer symbol-history` when the user asks.',
    '- `seer_skeleton { file }`: cheap file shape before a full read.',
    '- `seer_architecture` / `seer_modules` / `seer_boundaries`: repo orientation.',
    '',
    'Use `rg` or manual file reads after Seer for literal strings, comments,',
    'docs, config values, unsupported languages, or when Seer returns no',
    'useful hit from the correct workspace.',
    '',
    'Do not read `.agents/mcp_config.json`, `.mcp.json`, `.cursor/mcp.json`,',
    'or other MCP config files during normal code tasks. Only inspect or edit',
    'those files when the user asks to install, update, uninstall, or debug Seer.',
    'Do not run `npx seer-mcp` as a substitute for MCP tools when the MCP tools',
    'are available.',
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

function geminiImportBlock(): string {
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

// ── Uninstall ────────────────────────────────────────────────────────────────

export type UninstallAction =
  | 'removed'    // seer entry deleted; file still has other content
  | 'deleted'    // whole file removed (was seer-only or empty after removal)
  | 'skipped'    // file did not exist or had no seer entry
  | 'manual';    // file exists but could not be parsed / modified safely

export interface UninstallEntry {
  label: string;
  file: string;
  action: UninstallAction;
  note?: string;
}

export interface UninstallOptions {
  workspace: string;
  clients?: ClientId[];
  global?: boolean;
  agents?: boolean;   // also strip guidance files (default true)
  print?: boolean;    // dry run: report, do not write
  force?: boolean;    // remove global entries even when pinned elsewhere
}

export interface UninstallResult {
  entries: UninstallEntry[];
  contextFiles: UninstallEntry[];
}

/** Remove Seer MCP entries from a JSON config file. */
function removeJsonClient(
  spec: ClientSpec,
  file: string,
  opts: UninstallOptions,
  targetIsGlobal = false,
): UninstallEntry {
  const base: UninstallEntry = { label: spec.label, file, action: 'skipped' };

  if (!fs.existsSync(file)) return base;

  const parsed = readJsonTolerant(file);
  if (!parsed.ok) {
    return { ...base, action: 'manual', note: `could not parse ${path.basename(file)}; remove the seer entry by hand` };
  }

  const data = parsed.data ?? {};
  const root = data[spec.rootKey];
  const names = seerServerNames(spec, root);
  if (!root || typeof root !== 'object' || names.length === 0) {
    return base; // nothing to remove
  }

  const removable = names.filter((name) => {
    if (!targetIsGlobal || opts.force) return true;
    const pinnedWorkspace = workspaceFromJsonEntry(root[name]);
    return !pinnedWorkspace || sameResolvedPath(pinnedWorkspace, opts.workspace);
  });
  if (removable.length === 0) {
    const pinned = names
      .map((name) => workspaceFromJsonEntry(root[name]))
      .filter((value): value is string => !!value);
    return {
      ...base,
      action: 'skipped',
      note: pinned.length ? `seer entry is pinned to another workspace: ${pinned.join(', ')}` : undefined,
    };
  }

  if (opts.print) return { ...base, action: 'removed' };

  for (const name of removable) delete root[name];

  // If the root key is now empty, drop it too.
  if (Object.keys(root).length === 0) delete data[spec.rootKey];

  // If the whole file is now empty (only had seer), delete it.
  const remaining = Object.keys(data);
  if (remaining.length === 0) {
    fs.unlinkSync(file);
    pruneEmptyParents(file, pruneStopDir(file, opts.workspace, targetIsGlobal));
    return { ...base, action: 'deleted' };
  }

  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return { ...base, action: 'removed' };
}

/** Remove `[mcp_servers.seer]` block from a TOML config file. */
function removeTomlClient(
  spec: ClientSpec,
  file: string,
  opts: UninstallOptions,
  targetIsGlobal = false,
): UninstallEntry {
  const base: UninstallEntry = { label: spec.label, file, action: 'skipped' };

  if (!fs.existsSync(file)) return base;

  const raw = fs.readFileSync(file, 'utf8');
  if (!/^[ \t]*\[mcp_servers\.seer\]/m.test(raw)) return base;

  if (targetIsGlobal && !opts.force) {
    const pinnedWorkspace = tomlEntryWorkspace(file);
    if (pinnedWorkspace && !sameResolvedPath(pinnedWorkspace, opts.workspace)) {
      return {
        ...base,
        action: 'skipped',
        note: `seer entry is pinned to another workspace: ${pinnedWorkspace}`,
      };
    }
  }

  if (opts.print) return { ...base, action: 'removed' };

  const lines = raw.split('\n');
  const start = lines.findIndex((l) => /^[ \t]*\[mcp_servers\.seer\]/.test(l));
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[ \t]*\[/.test(lines[i])) { end = i; break; }
  }

  // Drop the block lines (and any trailing blank line immediately before the
  // next section so we don't leave a double blank).
  const kept = [...lines.slice(0, start), ...lines.slice(end)];
  // Trim a leading blank line that was the separator before the block.
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();

  const result = kept.join('\n').trimEnd();

  if (!result.trim()) {
    fs.unlinkSync(file);
    pruneEmptyParents(file, pruneStopDir(file, opts.workspace, targetIsGlobal));
    return { ...base, action: 'deleted' };
  }

  fs.writeFileSync(file, result + '\n', 'utf8');
  return { ...base, action: 'removed' };
}

function uninstallClient(client: ClientId, opts: UninstallOptions): UninstallEntry[] {
  const spec = CLIENTS[client];
  const useGlobal = opts.global || spec.projectPath === null;
  const rel = useGlobal ? spec.globalPath : spec.projectPath;

  const removeTarget = (target: string, targetIsGlobal: boolean): UninstallEntry => {
    const file = targetPath(opts.workspace, target);
    return spec.toml
      ? removeTomlClient(spec, file, opts, targetIsGlobal)
      : removeJsonClient(spec, file, opts, targetIsGlobal);
  };

  const results: UninstallEntry[] = [];
  if (rel) results.push(removeTarget(rel, useGlobal));

  if (!opts.global) {
    for (const extra of spec.extraProjectPaths ?? []) results.push(removeTarget(extra, false));
  }
  if (useGlobal || opts.global) {
    for (const extra of spec.extraGlobalPaths ?? []) results.push(removeTarget(extra, true));
  }
  return results;
}

/** Strip the managed seer block from a context file (AGENTS.md, CLAUDE.md, GEMINI.md). */
function removeContextFile(
  fileName: string,
  label: string,
  opts: UninstallOptions,
): UninstallEntry {
  const file = path.join(opts.workspace, fileName);
  const base: UninstallEntry = { label, file, action: 'skipped' };

  if (!fs.existsSync(file)) return base;

  const raw = fs.readFileSync(file, 'utf8');
  const beginIdx = raw.indexOf(AGENTS_BEGIN);
  const endIdx = raw.indexOf(AGENTS_END);
  if (beginIdx === -1 || endIdx === -1) return base;

  if (opts.print) return { ...base, action: 'removed' };

  // Splice out the block including both markers and any surrounding blank lines
  // we added as separators. We want to leave the file clean, not with orphan
  // blank lines where the block used to be.
  const before = raw.slice(0, beginIdx).replace(/\n{2,}$/, '\n').trimEnd();
  const after  = raw.slice(endIdx + AGENTS_END.length).replace(/^\n{1,2}/, '');
  const result = (before + (before && after ? '\n' : '') + after).trimEnd();

  if (!result.trim()) {
    fs.unlinkSync(file);
    pruneEmptyParents(file, opts.workspace);
    return { ...base, action: 'deleted' };
  }

  fs.writeFileSync(file, result + '\n', 'utf8');
  return { ...base, action: 'removed' };
}

export function runUninstall(opts: UninstallOptions): UninstallResult {
  const workspace = path.resolve(opts.workspace);
  const clients = (opts.clients && opts.clients.length ? opts.clients : [...ALL_CLIENTS])
    .filter((c) => ALL_CLIENTS.includes(c));

  const entries = clients.flatMap((c) => uninstallClient(c, { ...opts, workspace }));

  const contextFiles: UninstallEntry[] = [];
  if (opts.agents !== false && !opts.global) {
    contextFiles.push(removeContextFile('AGENTS.md', 'AGENTS.md (agent guide)', { ...opts, workspace }));
    contextFiles.push(removeContextFile('CLAUDE.md', 'CLAUDE.md (Claude guide)', { ...opts, workspace }));
    contextFiles.push(removeContextFile('GEMINI.md', 'GEMINI.md (Gemini guide)', { ...opts, workspace }));
  }

  return { entries, contextFiles };
}

// ── Entry point ─────────────────────────────────────────────────────────────

function refreshClient(client: ClientId, opts: UpdateOptions): PlanEntry[] {
  const spec = CLIENTS[client];
  const scope = opts.global ? 'global' : 'all';
  const projectLaunch = resolveLaunch(opts.workspace, { ...opts, npx: true }, !!spec.projectWorkspaceArg);
  const globalLaunch = resolveLaunch(opts.workspace, { ...opts, npx: true }, true);
  const results: PlanEntry[] = [];

  for (const target of clientTargets(client, opts.workspace, scope)) {
    const present = hasSeerEntry(client, target.file);
    if (present === false) {
      if (opts.clients && opts.clients.length) {
        results.push({
          client,
          label: spec.label,
          file: target.file,
          action: 'skipped',
          note: 'no existing seer entry',
        });
      }
      continue;
    }
    if (present === null) {
      results.push({
        client,
        label: spec.label,
        file: target.file,
        action: 'manual',
        note: `could not parse existing ${path.basename(target.file)}; update the seer entry by hand`,
      });
      continue;
    }

    if (target.isGlobal && !opts.force) {
      const pinnedWorkspace = entryWorkspace(spec, target.file, opts.workspace);
      if (pinnedWorkspace === null) {
        results.push({
          client,
          label: spec.label,
          file: target.file,
          action: 'manual',
          note: `could not read existing ${path.basename(target.file)} workspace; update the seer entry by hand`,
        });
        continue;
      }
      if (pinnedWorkspace && !sameResolvedPath(pinnedWorkspace, opts.workspace)) {
        results.push({
          client,
          label: spec.label,
          file: target.file,
          action: 'skipped',
          note: `seer entry is pinned to another workspace: ${pinnedWorkspace}`,
        });
        continue;
      }
    }

    const launch = target.isGlobal ? globalLaunch : projectLaunch;
    const result = spec.toml
      ? writeTomlClient(spec, target.file, launch, { ...opts, force: true }, true)
      : writeJsonClient(spec, target.file, launch, { ...opts, force: true }, true);
    results.push({ ...result, client });
  }

  return results;
}

export function runUpdate(opts: UpdateOptions): InitResult {
  const workspace = path.resolve(opts.workspace);
  const detected = detectConfiguredClients(workspace, {
    global: opts.global,
    includePinnedOther: opts.force,
  });
  const clients = (opts.clients && opts.clients.length ? opts.clients : detected)
    .filter((c) => ALL_CLIENTS.includes(c));

  const entries = clients.flatMap((c) => refreshClient(c, { ...opts, workspace }));
  const launch = resolveLaunch(
    workspace,
    { ...opts, workspace, npx: true },
    Boolean(opts.global) || clients.some((c) => CLIENTS[c].projectPath === null || CLIENTS[c].projectWorkspaceArg),
  );

  let agents: ContextFileResult | undefined;
  let contextFiles: ContextFileResult[] | undefined;
  if (opts.agents !== false) {
    const hasAction = entries.some((e) => e.action !== 'skipped');
    const shouldWriteAgents = fs.existsSync(path.join(workspace, 'AGENTS.md')) || hasAction || clients.length > 0;
    if (shouldWriteAgents) {
      agents = writeContextFile('AGENTS.md', 'AGENTS.md (agent guide)', { ...opts, workspace, force: true });
    }
    contextFiles = [];
    if (clients.includes('claude') || fs.existsSync(path.join(workspace, 'CLAUDE.md'))) {
      contextFiles.push(writeContextFile(
        'CLAUDE.md',
        'CLAUDE.md (Claude guide)',
        { ...opts, workspace, force: true },
        claudeImportBlock(),
      ));
    }
    if (clients.includes('gemini') || clients.includes('antigravity') || fs.existsSync(path.join(workspace, 'GEMINI.md'))) {
      contextFiles.push(writeContextFile(
        'GEMINI.md',
        'GEMINI.md (Gemini guide)',
        { ...opts, workspace, force: true },
        geminiImportBlock(),
      ));
    }
    if (contextFiles.length === 0) contextFiles = undefined;
  }

  return { launch, entries, agents, contextFiles };
}

export function runInit(opts: InitOptions): InitResult {
  const workspace = path.resolve(opts.workspace);
  const defaultClients = opts.auto ? detectAutoClients(workspace) : DEFAULT_CLIENTS;
  const clients = (opts.clients && opts.clients.length ? opts.clients : defaultClients)
    .filter((c) => ALL_CLIENTS.includes(c));

  const launch = resolveLaunch(
    workspace,
    { ...opts, workspace },
    Boolean(opts.global) || clients.some((c) => CLIENTS[c].projectPath === null || CLIENTS[c].projectWorkspaceArg),
  );

  const entries = clients.flatMap((c) => configureClient(c, { ...opts, workspace }));

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
      contextFiles.push(writeContextFile(
        'GEMINI.md',
        'GEMINI.md (Gemini guide)',
        { ...opts, workspace },
        geminiImportBlock(),
      ));
    }
    if (contextFiles.length === 0) contextFiles = undefined;
  }

  return { launch, entries, agents, contextFiles };
}
