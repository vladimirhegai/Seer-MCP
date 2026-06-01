/**
 * Watcher-mode MCP test. Runs `seer mcp` with watcher ENABLED and JIT
 * DISABLED, edits a file, then waits for the watcher to fire and queries
 * to see whether the new symbol shows up. This verifies the watcher path
 * works independently of JIT — they're two separate safety nets and the
 * tests should cover them separately.
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'tests/fixtures');
const TMP_WS = path.join(os.tmpdir(), `seer-mcp-watch-${Date.now()}`);
const CLI = path.join(ROOT, 'dist/cli/index.js');

let passed = 0;
let failed = 0;
const ok = (label: string) => { passed++; console.log(`  ✓ ${label}`); };
const bad = (label: string, extra?: unknown) => {
  failed++;
  console.error(`  ✗ ${label}` + (extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''));
};

async function main(): Promise<void> {
  console.log('\nSeer MCP Watcher Test\n=======================\n');
  fs.mkdirSync(TMP_WS, { recursive: true });
  for (const f of fs.readdirSync(FIXTURES)) {
    fs.copyFileSync(path.join(FIXTURES, f), path.join(TMP_WS, f));
  }
  console.log(`  Workspace: ${TMP_WS}\n`);

  const proc = spawn(process.execPath, [CLI, 'mcp', '--workspace', TMP_WS, '--no-jit'], {
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
      } catch { /* */ }
    }
  });

  let nextId = 1;
  const call = (method: string, params: any): Promise<any> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); }
      }, 30_000);
      pending.set(id, { resolve, timer });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };

  for (let i = 0; i < 30; i++) {
    try {
      const r = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'watch-smoke', version: '0.1.0' } });
      if (r.result) break;
    } catch { /* */ }
    await new Promise(r => setTimeout(r, 500));
  }
  ok('server initialized with watcher on');

  // Confirm watcher status is reported
  const h = JSON.parse((await call('tools/call', { name: 'seer_health', arguments: {} })).result.content[0].text);
  if (h.watcher && h.watcher.watching) ok('seer_health reports watcher=true');
  else bad('watcher not active', h.watcher);

  // Give chokidar a beat to finish its initial scan — even with
  // ignoreInitial:true it walks the tree before declaring "ready", and on
  // Windows the walk is noticeably slow for small workspaces.
  await new Promise(r => setTimeout(r, 1000));

  // Edit sample.ts and wait for the watcher to fire + reindex.
  const samplePath = path.join(TMP_WS, 'sample.ts');
  const original = fs.readFileSync(samplePath, 'utf8');
  fs.writeFileSync(samplePath, original + `\n\nexport function watcherInjected(): void {}\n`);
  process.stderr.write(`  (wrote new function to sample.ts)\n`);

  // Poll up to 15 seconds for the symbol to appear via the watcher (no JIT helping).
  // The watcher has debounceMs=250, awaitWriteFinish stabilityThreshold=100, plus
  // a full reindex of ~15 files (~200ms). So we'd expect detection in well under
  // a second, but Windows file-event latency can be unpredictable.
  let found = false;
  for (let i = 0; i < 75; i++) {
    await new Promise(r => setTimeout(r, 200));
    const q = JSON.parse((await call('tools/call', { name: 'seer_symbols', arguments: { query: 'watcherInjected' } })).result.content[0].text);
    if (q.items.some((it: any) => it.name === 'watcherInjected')) {
      found = true;
      ok(`watcher picked up new symbol after ${(i + 1) * 200}ms`);
      break;
    }
  }
  if (!found) bad('watcher never picked up new symbol within 15s');

  proc.stdin.end();
  proc.kill();
  await new Promise(r => setTimeout(r, 200));

  try { fs.rmSync(TMP_WS, { recursive: true, force: true }); } catch { /* */ }

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  Watcher results: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Watcher smoke crashed:', err);
  process.exit(1);
});
