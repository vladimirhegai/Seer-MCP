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
 * It also drops an AGENTS.md block so the agent actually knows Seer exists and
 * how to use it well, rather than ignoring a tool it was never told about.
 *
 * Everything here is deterministic and local. No network, no telemetry.
 */

export type ClientId =
  | 'claude'
  | 'cursor'
  | 'vscode'
  | 'codex'
  | 'gemini'
  | 'antigravity';

export interface InitOptions {
  workspace: string;
  clients?: ClientId[];   // explicit subset; default = the project-local set
  global?: boolean;       // write user-level config instead of project-local
  command?: string;       // override the launch command line entirely
  npx?: boolean;          // emit the portable `npx -y <pkg> mcp` launcher
  pkg?: string;           // npm package name for the npx launcher
  agents?: boolean;       // write the AGENTS.md guidance block (default true)
  print?: boolean;        // dry run: report the plan, write nothing
  force?: boolean;        // overwrite an existing seer entry / agents block
  db?: string;            // custom db path passed through to the launcher
}

interface LaunchSpec {
  command: string;
  args: string[];
}

/** All clients we know how to configure, in display order. */
const ALL_CLIENTS: ClientId[] = ['claude', 'cursor', 'vscode', 'codex', 'gemini', 'antigravity'];

/** The default set when the user does not name clients: everything that has a
 *  clean project-local config. Antigravity is user-level only, so it is opt-in. */
const DEFAULT_CLIENTS: ClientId[] = ['claude', 'cursor', 'vscode', 'codex', 'gemini'];

const DEFAULT_PKG = 'seer-core';
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

export interface InitResult {
  launch: LaunchSpec;
  entries: PlanEntry[];
  agents?: { file: string; action: 'wrote' | 'updated' | 'skipped' };
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

  if (opts.npx) {
    const args = ['-y', opts.pkg || DEFAULT_PKG, 'mcp'];
    if (opts.db) args.push('--db', opts.db);
    return { command: 'npx', args };
  }

  // Default: an absolute path to the compiled CLI entry. __dirname is
  // dist/cli when built; map a src/.ts path back to dist/.js so the snippet we
  // emit always points at the thing agents can actually run.
  let entry = path.join(__dirname, 'index.js');
  if (entry.includes(`${path.sep}src${path.sep}`) || entry.endsWith('.ts')) {
    entry = entry
      .replace(`${path.sep}src${path.sep}`, `${path.sep}dist${path.sep}`)
      .replace(/\.ts$/, '.js');
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
    globalPath: home('.gemini', 'config', 'mcp_config.json'),
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
): PlanEntry {
  const spec = CLIENTS[client];
  const useGlobal = opts.global || spec.projectPath === null;
  const rel = useGlobal ? spec.globalPath : spec.projectPath;

  if (!rel) {
    // e.g. asked for project-local antigravity, which does not exist.
    return {
      client,
      label: spec.label,
      file: '(n/a)',
      action: 'manual',
      note: `${spec.label} has no ${useGlobal ? 'user-level' : 'project-local'} config; try the other scope`,
    };
  }

  const file = path.isAbsolute(rel) ? rel : path.join(opts.workspace, rel);
  const result = spec.toml
    ? writeTomlClient(spec, file, launch, opts)
    : writeJsonClient(spec, file, launch, opts);
  return { ...result, client };
}

// ── AGENTS.md ───────────────────────────────────────────────────────────────

function agentsBlock(): string {
  return [
    AGENTS_BEGIN,
    '## Seer — read this before navigating or editing code',
    '',
    'This repo is indexed by **Seer**, a local MCP server that gives you',
    'structural facts about the codebase: definitions, call graphs, routes,',
    'tests, edit-risk, monorepo boundaries, and per-symbol git history. It is',
    'deterministic and local. Prefer it over grep/file-reading for anything',
    'structural — it is faster and uses far fewer tokens.',
    '',
    '**Before you edit an unfamiliar symbol**, call `seer_preflight` with the',
    'symbol name. One call returns the definition, who calls it, the tests that',
    'cover it, its risk profile, and recent history — the context you would',
    'otherwise gather with ten searches.',
    '',
    'A good default workflow:',
    '',
    '1. `seer_health` — confirm the index is live.',
    '2. `seer_architecture` or `seer_boundaries` — orient in an unfamiliar repo.',
    '3. `seer_preflight { symbol }` — pull the full pre-edit packet for a target.',
    '4. `seer_preflight { fromRef: "main", toRef: "HEAD" }` — blast radius of a diff.',
    '5. `seer_behavior` / `seer_history` — tests and blame for a symbol.',
    '6. `seer_skeleton { file }` — read a large file as signatures only, cheaply.',
    '',
    'Use `seer_batch` to run several read-only lookups in one round-trip. Fall',
    'back to grep only for comments, string literals, and config values.',
    AGENTS_END,
  ].join('\n');
}

function writeAgents(opts: InitOptions): InitResult['agents'] {
  const file = path.join(opts.workspace, 'AGENTS.md');
  const block = agentsBlock();

  if (opts.print) {
    return { file, action: fs.existsSync(file) ? 'updated' : 'wrote' };
  }

  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.includes(AGENTS_BEGIN) && raw.includes(AGENTS_END)) {
      if (!opts.force) return { file, action: 'skipped' };
      const replaced = raw.replace(
        new RegExp(`${AGENTS_BEGIN}[\\s\\S]*?${AGENTS_END}`),
        block,
      );
      fs.writeFileSync(file, replaced, 'utf8');
      return { file, action: 'updated' };
    }
    const sep = raw.endsWith('\n') ? '\n' : '\n\n';
    fs.writeFileSync(file, raw + sep + block + '\n', 'utf8');
    return { file, action: 'updated' };
  }

  fs.writeFileSync(file, block + '\n', 'utf8');
  return { file, action: 'wrote' };
}

// ── Entry point ─────────────────────────────────────────────────────────────

export function runInit(opts: InitOptions): InitResult {
  const workspace = path.resolve(opts.workspace);
  const clients = (opts.clients && opts.clients.length ? opts.clients : DEFAULT_CLIENTS)
    .filter((c) => ALL_CLIENTS.includes(c));

  const launch = resolveLaunch(workspace, { ...opts, workspace });

  const entries = clients.map((c) => configureClient(c, launch, { ...opts, workspace }));
  const agents = opts.agents === false ? undefined : writeAgents({ ...opts, workspace });

  return { launch, entries, agents };
}
