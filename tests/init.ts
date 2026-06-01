/**
 * Tests for `seer init` — the cross-agent MCP installer.
 *
 * Most cases exercise project-local clients (claude, cursor, vscode, codex,
 * gemini), which write inside a throwaway workspace. User-level-only clients
 * are covered through --print plans so the test cannot scribble on a real home
 * config.
 *
 * Run: npx tsx tests/init.ts
 */
import path from 'path';
import fs from 'fs';
import os from 'os';
import { runInit, runUpdate, ClientId } from '../src/cli/init';

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

    // gemini is in PROJECT_CLIENTS, so a GEMINI.md import shim must be written too.
    check(fs.existsSync(path.join(ws, 'GEMINI.md')), '1.GEMINI.md shim written for gemini client');
    const gem = fs.existsSync(path.join(ws, 'GEMINI.md')) ? fs.readFileSync(path.join(ws, 'GEMINI.md'), 'utf8') : '';
    check(gem.includes('<!-- seer:begin -->') && gem.includes('@AGENTS.md'),
      '1.GEMINI.md imports AGENTS.md inside managed block');

    check(fs.existsSync(path.join(ws, 'CLAUDE.md')), '1.CLAUDE.md written for claude client');
    const claudeMd = fs.existsSync(path.join(ws, 'CLAUDE.md')) ? fs.readFileSync(path.join(ws, 'CLAUDE.md'), 'utf8') : '';
    check(claudeMd.includes('@AGENTS.md') && claudeMd.includes('<!-- seer:begin -->'),
      '1.CLAUDE.md imports AGENTS.md inside managed block');

    fs.rmSync(ws, { recursive: true, force: true });
  }

  {
    const ws = freshWs('user-level-print');
    const r = runInit({ workspace: ws, clients: ['antigravity', 'windsurf'], print: true });
    const files = r.entries.map((e) => e.file.replace(/\\/g, '/'));
    check(files.some((f) => f.endsWith('/.gemini/antigravity/mcp_config.json')),
      '6b.antigravity current IDE config planned', files);
    check(files.some((f) => f.endsWith('/.gemini/antigravity-cli/mcp_config.json')),
      '6b.antigravity CLI config planned', files);
    check(files.some((f) => f.endsWith('/.agents/mcp_config.json')),
      '6b.antigravity workspace config planned', files);
    check(files.some((f) => f.endsWith('/.codeium/windsurf/mcp_config.json')),
      '6b.windsurf config planned', files);
    check(!fs.existsSync(path.join(ws, '.agents', 'mcp_config.json')),
      '6b.--print does not write antigravity workspace config');
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 1b. No Gemini-family client ⇒ no GEMINI.md ────────────────────────────
  {
    const ws = freshWs('nogemini');
    runInit({ workspace: ws, clients: ['claude', 'cursor'] });
    check(fs.existsSync(path.join(ws, 'AGENTS.md')), '1b.AGENTS.md still written');
    check(!fs.existsSync(path.join(ws, 'GEMINI.md')), '1b.no GEMINI.md when no gemini/antigravity client');
    check(fs.existsSync(path.join(ws, 'CLAUDE.md')), '1b.CLAUDE.md written when claude client is present');
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 1c. No Claude client ⇒ no CLAUDE.md ───────────────────────────────────
  {
    const ws = freshWs('noclaude');
    runInit({ workspace: ws, clients: ['cursor', 'gemini'] });
    check(fs.existsSync(path.join(ws, 'AGENTS.md')), '1c.AGENTS.md still written');
    check(!fs.existsSync(path.join(ws, 'CLAUDE.md')), '1c.no CLAUDE.md when no claude client');
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
    check(!fs.existsSync(path.join(ws, 'CLAUDE.md')), '6.--print does not write CLAUDE.md');
    check(!fs.existsSync(path.join(ws, 'GEMINI.md')), '6.--print does not write GEMINI.md');
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
    check(!fs.existsSync(path.join(ws, 'CLAUDE.md')), '7.--no-agents writes no CLAUDE.md');
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

  // 9. update refreshes existing MCP entries and converts GEMINI.md to a shim.
  {
    const ws = freshWs('update');
    runInit({ workspace: ws, clients: ['claude', 'gemini'], npx: true });
    fs.writeFileSync(path.join(ws, '.mcp.json'),
      JSON.stringify({ mcpServers: { seer: { command: 'bad', args: ['old'] } } }, null, 2));
    fs.writeFileSync(path.join(ws, 'GEMINI.md'), [
      '<!-- seer:begin -->',
      'old duplicated seer_preflight guidance',
      '<!-- seer:end -->',
      '',
    ].join('\n'));

    const r = runUpdate({ workspace: ws });
    const mcp = JSON.parse(fs.readFileSync(path.join(ws, '.mcp.json'), 'utf8'));
    const gem = fs.readFileSync(path.join(ws, 'GEMINI.md'), 'utf8');
    check(r.entries.some(e => e.client === 'claude' && e.action === 'updated'),
      '9.update refreshes existing MCP config entries', r.entries);
    check(mcp.mcpServers.seer.command === 'npx' && mcp.mcpServers.seer.args.join(' ') === '-y seer-mcp mcp',
      '9.update rewrites stale project launcher to current npx form', mcp.mcpServers.seer);
    check(gem.includes('@AGENTS.md') && !gem.includes('old duplicated'),
      '9.update converts GEMINI.md duplicate guidance to import shim', gem);
    fs.rmSync(ws, { recursive: true, force: true });
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
