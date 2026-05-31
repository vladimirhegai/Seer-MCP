/**
 * Tests for `seer init` — the cross-agent MCP installer.
 *
 * These exercise only the project-local clients (claude, cursor, vscode,
 * codex, gemini), which write inside a throwaway workspace. We never touch the
 * user-level clients (antigravity) here, so the test cannot scribble on a real
 * home config.
 *
 * Run: npx tsx tests/init.ts
 */
import path from 'path';
import fs from 'fs';
import os from 'os';
import { runInit, ClientId } from '../src/cli/init';

let passed = 0;
let failed = 0;
const ok = (m: string): void => { passed++; console.log(`  ✓ ${m}`); };
const bad = (m: string, x?: unknown): void => {
  failed++;
  console.error(`  ✗ ${m}` + (x !== undefined ? `  ::  ${JSON.stringify(x).slice(0, 240)}` : ''));
};
const check = (c: boolean, m: string, x?: unknown): void => { c ? ok(m) : bad(m, x); };

const PROJECT_CLIENTS: ClientId[] = ['claude', 'cursor', 'vscode', 'codex', 'gemini'];

function freshWs(tag: string): string {
  const ws = path.join(os.tmpdir(), `seer-init-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(ws, { recursive: true });
  return ws;
}

function main(): void {
  console.log('\nSeer Init Tests\n===============\n');

  // ── 1. Fresh write across all project-local clients ───────────────────────
  {
    const ws = freshWs('fresh');
    const r = runInit({ workspace: ws, clients: PROJECT_CLIENTS });

    check(r.launch.command === 'node', '1.launcher uses node by default', r.launch);
    check(r.launch.args.includes('mcp') && r.launch.args.includes('--workspace'),
      '1.launcher carries "mcp --workspace"', r.launch.args);

    const mcp = JSON.parse(fs.readFileSync(path.join(ws, '.mcp.json'), 'utf8'));
    check(!!mcp.mcpServers?.seer, '1.claude .mcp.json has mcpServers.seer');
    check(mcp.mcpServers.seer.command === 'node', '1.claude entry command is node');

    const cursor = JSON.parse(fs.readFileSync(path.join(ws, '.cursor', 'mcp.json'), 'utf8'));
    check(!!cursor.mcpServers?.seer, '1.cursor .cursor/mcp.json has mcpServers.seer');

    const vscode = JSON.parse(fs.readFileSync(path.join(ws, '.vscode', 'mcp.json'), 'utf8'));
    check(!!vscode.servers?.seer, '1.vscode uses the "servers" root key');
    check(vscode.servers.seer.type === 'stdio', '1.vscode entry carries type:stdio');

    const gemini = JSON.parse(fs.readFileSync(path.join(ws, '.gemini', 'settings.json'), 'utf8'));
    check(!!gemini.mcpServers?.seer, '1.gemini .gemini/settings.json has mcpServers.seer');

    const toml = fs.readFileSync(path.join(ws, '.codex', 'config.toml'), 'utf8');
    check(/\[mcp_servers\.seer\]/.test(toml), '1.codex config.toml has [mcp_servers.seer]');
    check(/command = "node"/.test(toml), '1.codex block has command = "node"');

    const agents = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8');
    check(agents.includes('<!-- seer:begin -->') && agents.includes('<!-- seer:end -->'),
      '1.AGENTS.md written with seer markers');
    check(agents.includes('seer_preflight'), '1.AGENTS.md mentions seer_preflight workflow');

    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 2. Idempotency: a second run skips, --force updates ────────────────────
  {
    const ws = freshWs('idem');
    runInit({ workspace: ws, clients: PROJECT_CLIENTS });
    const r2 = runInit({ workspace: ws, clients: PROJECT_CLIENTS });
    check(r2.entries.every((e) => e.action === 'skipped'), '2.re-run skips every client', r2.entries.map((e) => e.action));
    check(r2.agents?.action === 'skipped', '2.re-run skips AGENTS.md');

    const r3 = runInit({ workspace: ws, clients: PROJECT_CLIENTS, force: true });
    check(r3.entries.every((e) => e.action === 'updated'), '3.--force updates every client', r3.entries.map((e) => e.action));

    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 3. Merge: existing config keeps its other servers ─────────────────────
  {
    const ws = freshWs('merge');
    fs.writeFileSync(path.join(ws, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'foo', args: ['bar'] } } }, null, 2));
    fs.mkdirSync(path.join(ws, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.codex', 'config.toml'),
      '[model]\nname = "gpt-5.5"\n\n[mcp_servers.other]\ncommand = "foo"\nargs = []\n');

    runInit({ workspace: ws, clients: ['claude', 'codex'] });

    const mcp = JSON.parse(fs.readFileSync(path.join(ws, '.mcp.json'), 'utf8'));
    check(!!mcp.mcpServers.other && !!mcp.mcpServers.seer, '4.json merge keeps existing "other" server + adds seer', mcp.mcpServers);

    const toml = fs.readFileSync(path.join(ws, '.codex', 'config.toml'), 'utf8');
    check(/\[model\]/.test(toml) && /\[mcp_servers\.other\]/.test(toml) && /\[mcp_servers\.seer\]/.test(toml),
      '4.toml append keeps [model] + [mcp_servers.other] + adds seer');

    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 4. --npx launcher is portable (no machine paths, no --workspace) ───────
  {
    const ws = freshWs('npx');
    const r = runInit({ workspace: ws, clients: ['claude'], npx: true, pkg: 'seer-core' });
    check(r.launch.command === 'npx', '5.--npx launcher command is npx', r.launch);
    check(r.launch.args.join(' ') === '-y seer-core mcp', '5.--npx args are "-y seer-core mcp"', r.launch.args);
    const mcp = JSON.parse(fs.readFileSync(path.join(ws, '.mcp.json'), 'utf8'));
    check(JSON.stringify(mcp).indexOf(ws) === -1, '5.--npx config carries no absolute workspace path');
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 5. --print writes nothing ──────────────────────────────────────────────
  {
    const ws = freshWs('print');
    const r = runInit({ workspace: ws, clients: PROJECT_CLIENTS, print: true });
    check(!fs.existsSync(path.join(ws, '.mcp.json')), '6.--print does not write .mcp.json');
    check(!fs.existsSync(path.join(ws, 'AGENTS.md')), '6.--print does not write AGENTS.md');
    check(r.entries.length === PROJECT_CLIENTS.length, '6.--print still returns a full plan');
    check(r.entries.every((e) => !!e.snippet), '6.--print plan carries snippets to preview');
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 6. --no-agents skips the guide ─────────────────────────────────────────
  {
    const ws = freshWs('noagents');
    const r = runInit({ workspace: ws, clients: ['claude'], agents: false });
    check(r.agents === undefined, '7.--no-agents returns no agents plan');
    check(!fs.existsSync(path.join(ws, 'AGENTS.md')), '7.--no-agents writes no AGENTS.md');
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 7. An existing AGENTS.md is never clobbered ────────────────────────────
  {
    const ws = freshWs('agents-preserve');
    const userContent = '# My Project Agents\n\nDo not run migrations without asking.\nUse 2-space indent.\n';
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), userContent);

    runInit({ workspace: ws, clients: ['claude'] });
    let after = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8');
    check(after.startsWith(userContent), '8.existing AGENTS.md content preserved verbatim at the top');
    check(after.includes('Do not run migrations without asking.'), '8.user instructions still present');
    check(after.includes('<!-- seer:begin -->') && after.includes('seer_preflight'), '8.seer block appended below');

    // Re-running must not duplicate the block or touch the user content.
    runInit({ workspace: ws, clients: ['claude'] });
    after = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8');
    const occurrences = after.split('<!-- seer:begin -->').length - 1;
    check(occurrences === 1, '8.re-run does not duplicate the seer block', { occurrences });
    check(after.startsWith(userContent), '8.re-run still preserves user content');
    fs.rmSync(ws, { recursive: true, force: true });
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
