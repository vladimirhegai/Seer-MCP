/**
 * Tests for `seer uninstall`.
 *
 * Mirrors the structure of tests/init.ts: exercises project-local configs
 * only (no user-level home dirs touched), covering every writer path:
 * JSON removal, TOML removal, context-file stripping, dry-run, and the
 * "nothing to remove" no-op case.
 *
 * Run: npx tsx tests/uninstall.ts
 */
import path from 'path';
import fs from 'fs';
import os from 'os';
import { runInit, runUninstall, ClientId } from '../src/cli/init';

let passed = 0;
let failed = 0;
const ok  = (m: string): void => { passed++; console.log(`  ✓ ${m}`); };
const bad = (m: string, x?: unknown): void => {
  failed++;
  console.error(`  ✗ ${m}` + (x !== undefined ? `  ::  ${JSON.stringify(x).slice(0, 240)}` : ''));
};
const check = (c: boolean, m: string, x?: unknown): void => { c ? ok(m) : bad(m, x); };

function freshWs(tag: string): string {
  const ws = path.join(os.tmpdir(), `seer-uninstall-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(ws, { recursive: true });
  return ws;
}

const PROJECT_CLIENTS: ClientId[] = ['claude', 'cursor', 'vscode', 'codex', 'gemini'];

function main(): void {
  console.log('\nSeer Uninstall Tests\n====================\n');

  // ── 1. Basic removal: init then uninstall, all project-local clients ─────
  {
    const ws = freshWs('basic');
    runInit({ workspace: ws, clients: PROJECT_CLIENTS });

    const r = runUninstall({ workspace: ws, clients: PROJECT_CLIENTS });

    // All entries that had something written must report 'removed' or 'deleted'.
    const acted = r.entries.filter((e) => e.action !== 'skipped');
    check(acted.length > 0, '1.at least one config entry was removed');
    check(acted.every((e) => e.action === 'removed' || e.action === 'deleted'),
      '1.every acted entry is removed or deleted', acted.map((e) => e.action));

    // .mcp.json was seer-only ⇒ entire file deleted.
    check(!fs.existsSync(path.join(ws, '.mcp.json')), '1.claude .mcp.json deleted (was seer-only)');
    // .cursor/mcp.json same.
    check(!fs.existsSync(path.join(ws, '.cursor', 'mcp.json')), '1.cursor mcp.json deleted');
    // .vscode/mcp.json same.
    check(!fs.existsSync(path.join(ws, '.vscode', 'mcp.json')), '1.vscode mcp.json deleted');
    // .codex/config.toml same.
    check(!fs.existsSync(path.join(ws, '.codex', 'config.toml')), '1.codex config.toml deleted');
    // .gemini/settings.json same.
    check(!fs.existsSync(path.join(ws, '.gemini', 'settings.json')), '1.gemini settings.json deleted');
    check(!fs.existsSync(path.join(ws, '.cursor')), '1.empty .cursor directory pruned');
    check(!fs.existsSync(path.join(ws, '.vscode')), '1.empty .vscode directory pruned');
    check(!fs.existsSync(path.join(ws, '.codex')), '1.empty .codex directory pruned');
    check(!fs.existsSync(path.join(ws, '.gemini')), '1.empty .gemini directory pruned');

    // Context files: AGENTS.md, CLAUDE.md, GEMINI.md all stripped.
    const cfActed = r.contextFiles.filter((e) => e.action !== 'skipped');
    check(cfActed.length >= 3, '1.at least 3 context files acted on', cfActed.map((e) => e.label));
    check(!fs.existsSync(path.join(ws, 'AGENTS.md')), '1.AGENTS.md deleted (was seer-only)');
    check(!fs.existsSync(path.join(ws, 'CLAUDE.md')), '1.CLAUDE.md deleted (was seer-only)');
    check(!fs.existsSync(path.join(ws, 'GEMINI.md')), '1.GEMINI.md deleted (was seer-only)');

    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 2. Partial removal: other servers are preserved ───────────────────────
  {
    const ws = freshWs('partial');
    // Pre-populate configs with another server alongside seer.
    fs.writeFileSync(path.join(ws, '.mcp.json'),
      '\uFEFF' + JSON.stringify({ mcpServers: { other: { command: 'foo', args: [] }, seer: { command: 'node', args: [] } } }, null, 2));
    fs.mkdirSync(path.join(ws, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.codex', 'config.toml'),
      '[model]\nname = "gpt-5"\n\n[mcp_servers.other]\ncommand = "foo"\nargs = []\n\n[mcp_servers.seer]\ncommand = "node"\nargs = []\n');

    runUninstall({ workspace: ws, clients: ['claude', 'codex'], agents: false });

    // .mcp.json still exists, other server intact, seer gone.
    check(fs.existsSync(path.join(ws, '.mcp.json')), '2.claude .mcp.json still present (has other server)');
    const mcp = JSON.parse(fs.readFileSync(path.join(ws, '.mcp.json'), 'utf8'));
    check('other' in (mcp.mcpServers ?? {}), '2.BOM-tolerant JSON removal preserves other server in .mcp.json');
    check(!('seer' in (mcp.mcpServers ?? {})), '2.seer removed from .mcp.json');

    // config.toml: [model] and [mcp_servers.other] stay, [mcp_servers.seer] gone.
    const toml = fs.readFileSync(path.join(ws, '.codex', 'config.toml'), 'utf8');
    check(/\[model\]/.test(toml), '2.[model] section preserved in config.toml');
    check(/\[mcp_servers\.other\]/.test(toml), '2.[mcp_servers.other] preserved in config.toml');
    check(!/\[mcp_servers\.seer\]/.test(toml), '2.[mcp_servers.seer] removed from config.toml');

    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 3. Context files with user content above the seer block ──────────────
  {
    const ws = freshWs('ctx-preserve');
    const userContent = '# My Project\n\nDo not run migrations without asking.\n';
    // Simulate what init would produce: user content + seer block appended.
    runInit({ workspace: ws, clients: ['claude', 'gemini'] });
    // Now prepend user content manually (as if the user had existing content).
    const agents = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8');
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), userContent + '\n' + agents);

    runUninstall({ workspace: ws, clients: [], agents: true });

    // AGENTS.md must survive (has user content) with seer block stripped.
    check(fs.existsSync(path.join(ws, 'AGENTS.md')), '3.AGENTS.md survives (has user content)');
    const afterAgents = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8');
    check(afterAgents.includes('Do not run migrations'), '3.user content preserved in AGENTS.md');
    check(!afterAgents.includes('<!-- seer:begin -->'), '3.seer block stripped from AGENTS.md');

    // CLAUDE.md and GEMINI.md were seer-only → deleted.
    check(!fs.existsSync(path.join(ws, 'CLAUDE.md')), '3.CLAUDE.md deleted (was seer-only)');
    check(!fs.existsSync(path.join(ws, 'GEMINI.md')), '3.GEMINI.md deleted (was seer-only)');

    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 4. Dry run: --print reports actions but writes nothing ────────────────
  {
    const ws = freshWs('dryrun');
    runInit({ workspace: ws, clients: ['claude'] });
    const before = fs.readFileSync(path.join(ws, '.mcp.json'), 'utf8');

    const r = runUninstall({ workspace: ws, clients: ['claude'], print: true });

    // Files must be unchanged.
    check(fs.existsSync(path.join(ws, '.mcp.json')), '4.--print left .mcp.json intact');
    check(fs.readFileSync(path.join(ws, '.mcp.json'), 'utf8') === before,
      '4..mcp.json content unchanged after dry run');

    // But the result still reports what would happen.
    const wouldAct = r.entries.filter((e) => e.action !== 'skipped');
    check(wouldAct.length > 0, '4.dry run still reports planned removals');

    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 5. No-op: nothing installed → all entries are skipped ────────────────
  {
    const ws = freshWs('noop');
    const r = runUninstall({ workspace: ws, clients: PROJECT_CLIENTS });
    const allSkipped = [...r.entries, ...r.contextFiles].every((e) => e.action === 'skipped');
    check(allSkipped, '5.uninstall on clean workspace is a no-op (all skipped)');
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 6. Idempotency: second uninstall is a no-op ───────────────────────────
  {
    const ws = freshWs('idem');
    runInit({ workspace: ws, clients: PROJECT_CLIENTS });
    runUninstall({ workspace: ws, clients: PROJECT_CLIENTS });
    const r2 = runUninstall({ workspace: ws, clients: PROJECT_CLIENTS });
    const allSkipped = [...r2.entries, ...r2.contextFiles].every((e) => e.action === 'skipped');
    check(allSkipped, '6.second uninstall is a no-op (all skipped)', r2.entries.map((e) => e.action));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 7. Antigravity: project + extra global paths all targeted ─────────────
  {
    const ws = freshWs('antigravity');
    // Write a seer entry at the project-local extra path (.agents/mcp_config.json).
    const agentsDir = path.join(ws, '.agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'mcp_config.json'),
      JSON.stringify({ mcpServers: { seer: { command: 'node', args: [] } } }, null, 2));

    const r = runUninstall({ workspace: ws, clients: ['antigravity'], agents: false, global: false });

    // The extra project path should be acted on.
    const extraEntry = r.entries.find((e) => e.file.includes('.agents'));
    check(extraEntry !== undefined, '7.antigravity extra project path (.agents/mcp_config.json) targeted');
    check(extraEntry?.action === 'deleted', '7.antigravity extra project path deleted when seer-only',
      extraEntry?.action);
    check(!fs.existsSync(agentsDir), '7.empty .agents directory pruned');

    fs.rmSync(ws, { recursive: true, force: true });
  }

  // ── 8. --no-agents skips context files ────────────────────────────────────
  {
    const ws = freshWs('noagents');
    runInit({ workspace: ws, clients: ['claude'] });
    runUninstall({ workspace: ws, clients: ['claude'], agents: false });

    // MCP config removed but guidance files left alone.
    check(!fs.existsSync(path.join(ws, '.mcp.json')), '8.MCP config removed');
    check(fs.existsSync(path.join(ws, 'AGENTS.md')), '8.AGENTS.md left alone with --no-agents');
    check(fs.existsSync(path.join(ws, 'CLAUDE.md')), '8.CLAUDE.md left alone with --no-agents');

    fs.rmSync(ws, { recursive: true, force: true });
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
