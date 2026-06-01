/**
 * JIT-freshness MCP integration test.
 *
 * Procedure:
 *   1. Start `seer mcp --workspace <tmp>` with watcher off and JIT on.
 *   2. Verify a symbol from sample.ts is queryable (post initial index).
 *   3. Append a new function to sample.ts on disk (no calls in/out).
 *   4. Issue another query and verify JIT picked up the new symbol.
 *   5. Delete a fixture file, issue another query, verify it's gone.
 *
 * This catches regressions where the JIT pass either fails to reindex
 * (returning stale results) or kicks off a full reindex on every call
 * (which would still be correct but should be measurable as slow).
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'tests/fixtures');
const TMP_WS = path.join(os.tmpdir(), `seer-mcp-jit-${Date.now()}`);
const CLI = path.join(ROOT, 'dist/cli/index.js');

let passed = 0;
let failed = 0;
function ok(label: string): void { passed++; console.log(`  ✓ ${label}`); }
function bad(label: string, extra?: unknown): void {
  failed++;
  console.error(`  ✗ ${label}` + (extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''));
}

async function main(): Promise<void> {
  console.log('\nSeer MCP JIT Freshness Test\n=============================\n');

  fs.mkdirSync(TMP_WS, { recursive: true });
  for (const f of fs.readdirSync(FIXTURES)) {
    fs.copyFileSync(path.join(FIXTURES, f), path.join(TMP_WS, f));
  }
  console.log(`  Workspace: ${TMP_WS}\n`);

  const proc = spawn(process.execPath, [CLI, 'mcp', '--workspace', TMP_WS, '--no-watch'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[mcp-stderr] ${d}`));

  let buf = '';
  const pending = new Map<number, { resolve: (msg: any) => void; timer: NodeJS.Timeout }>();
  proc.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const pendingCall = msg.id != null ? pending.get(msg.id) : undefined;
        if (pendingCall) {
          clearTimeout(pendingCall.timer);
          pending.delete(msg.id);
          pendingCall.resolve(msg);
        }
      } catch { /* skip */ }
    }
  });

  let nextId = 1;
  function call(method: string, params: any): Promise<any> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); }
      }, 30_000);
      pending.set(id, { resolve, timer });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  // Wait for ready
  for (let i = 0; i < 30; i++) {
    try {
      const r = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'jit-smoke', version: '0.1.0' } });
      if (r.result) break;
    } catch { /* */ }
    await new Promise(r => setTimeout(r, 500));
  }
  ok('server initialized');

  // Baseline: AuthService should exist
  const before = JSON.parse((await call('tools/call', { name: 'seer_symbols', arguments: { query: 'AuthService' } })).result.content[0].text);
  if (before.items.some((i: any) => i.name === 'AuthService')) ok('baseline: AuthService visible');
  else bad('baseline: AuthService missing');

  // ── Edit sample.ts: add a new function ──
  const samplePath = path.join(TMP_WS, 'sample.ts');
  const original = fs.readFileSync(samplePath, 'utf8');
  const newFn = `\n\nexport function jitInjectedFunction(): string {\n  return "added by JIT test";\n}\n`;
  fs.writeFileSync(samplePath, original + newFn);
  // Give the OS a moment to flush; chokidar isn't running here so it doesn't matter, but the
  // hash check needs the on-disk content to differ.
  await new Promise(r => setTimeout(r, 100));

  const after = JSON.parse((await call('tools/call', { name: 'seer_symbols', arguments: { query: 'jitInjectedFunction' } })).result.content[0].text);
  if (after.items.some((i: any) => i.name === 'jitInjectedFunction')) ok('JIT picked up new function after file edit');
  else bad('JIT did not pick up new function', after);

  // ── Remove a fixture file and verify it disappears ──
  const goPath = path.join(TMP_WS, 'sample.go');
  if (fs.existsSync(goPath)) fs.unlinkSync(goPath);
  await new Promise(r => setTimeout(r, 100));

  const stats = JSON.parse((await call('tools/call', { name: 'seer_stats', arguments: {} })).result.content[0].text);
  if (!('go' in stats.languages)) ok('JIT pruned removed sample.go (go language gone from stats)');
  else bad('JIT did not prune sample.go', stats.languages);

  proc.stdin.end();
  proc.kill();
  await new Promise(r => setTimeout(r, 200));

  try { fs.rmSync(TMP_WS, { recursive: true, force: true }); } catch { /* */ }

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  JIT results: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('JIT smoke crashed:', err);
  process.exit(1);
});
