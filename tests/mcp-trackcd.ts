/**
 * MCP smoke test for Track-C/D tools. Spawns `seer mcp` against the
 * fixtures-trackcd workspace and exercises every new tool over stdio.
 *
 * Run: npx tsx tests/mcp-trackcd.ts
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const ROOT = path.resolve(__dirname, '..');
const FIX = path.join(ROOT, 'tests/fixtures-trackcd');
const TMP_WS = path.join(os.tmpdir(), `seer-mcp-cd-${Date.now()}`);
const CLI = path.join(ROOT, 'dist/cli/index.js');

let passed = 0;
let failed = 0;
const ok = (m: string): void => { passed++; console.log(`  ✓ ${m}`); };
const bad = (m: string, x?: unknown): void => { failed++; console.error(`  ✗ ${m}` + (x !== undefined ? `  ::  ${JSON.stringify(x).slice(0, 200)}` : '')); };

function copyRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function main(): Promise<void> {
  console.log('\nSeer MCP Track-C/D Smoke\n==========================\n');
  copyRecursive(FIX, TMP_WS);
  console.log(`  Workspace: ${TMP_WS}`);

  const proc = spawn(process.execPath, [CLI, 'mcp', '--workspace', TMP_WS, '--no-watch', '--no-jit'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
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
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      const pendingCall = msg.id != null ? pending.get(msg.id) : undefined;
      if (pendingCall) {
        clearTimeout(pendingCall.timer);
        pending.delete(msg.id);
        pendingCall.resolve(msg);
      }
    }
  });

  let nextId = 1;
  const call = (method: string, params: any): Promise<any> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); }
      }, 30_000);
      pending.set(id, { resolve, timer });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };

  // Wait for ready
  let initOk = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await call('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' },
      });
      if (r.result) { initOk = true; break; }
    } catch { /* */ }
    await new Promise(r => setTimeout(r, 500));
  }
  if (initOk) ok('initialize'); else { bad('initialize'); process.exit(1); }

  // tools/list — verify the new tools are advertised
  const list = await call('tools/list', {});
  const names: string[] = (list.result?.tools ?? []).map((t: any) => t.name);
  const newTools = [
    'seer_routes', 'seer_dependencies', 'seer_config',
    'seer_complexity', 'seer_behavior', 'seer_trace_path',
    'seer_architecture', 'seer_detect_changes', 'seer_churn',
    'seer_history', 'seer_symbol_history_build',
  ];
  for (const n of newTools) {
    if (names.includes(n)) ok(`tools/list advertises ${n}`);
    else bad(`tools/list missing ${n}`, names);
  }

  const callTool = async (name: string, args: any = {}): Promise<any> => {
    const r = await call('tools/call', { name, arguments: args });
    return JSON.parse(r.result?.content?.[0]?.text ?? '{}');
  };

  // seer_routes
  const routes = await callTool('seer_routes', { limit: 100 });
  if (routes.total >= 10) ok(`seer_routes total=${routes.total}`); else bad('seer_routes empty', routes);
  if (routes.items?.some((r: any) => r.framework === 'fastapi')) ok('seer_routes includes fastapi'); else bad('no fastapi route', routes);

  // seer_dependencies
  const deps = await callTool('seer_dependencies', { limit: 100 });
  if (deps.total >= 8) ok(`seer_dependencies total=${deps.total}`); else bad('seer_dependencies low', deps);
  if (deps.items?.some((d: any) => d.name === 'express')) ok('seer_dependencies includes express'); else bad('no express dep', deps);

  // seer_config
  const cfg = await callTool('seer_config', { limit: 100 });
  if (cfg.total >= 4) ok(`seer_config total=${cfg.total}`); else bad('seer_config low', cfg);
  if (cfg.items?.some((c: any) => c.key === 'DATABASE_URL')) ok('seer_config has DATABASE_URL'); else bad('no DATABASE_URL', cfg);

  // seer_complexity
  const cmpx = await callTool('seer_complexity', { by: 'cyclomatic', minValue: 3, limit: 20 });
  if (cmpx.returned >= 1) ok(`seer_complexity returned=${cmpx.returned}`); else bad('seer_complexity empty', cmpx);
  if (cmpx.items?.[0]?.cyclomatic >= 3) ok(`seer_complexity sorted desc (top=${cmpx.items[0].cyclomatic})`); else bad('sort wrong', cmpx);

  // seer_behavior — login is exercised by the test
  const beh = await callTool('seer_behavior', { symbol: 'login' });
  if (beh.total >= 1) ok(`seer_behavior(login) total=${beh.total}`); else bad('seer_behavior empty', beh);

  // seer_trace_path
  const trace = await callTool('seer_trace_path', { from: 'login', to: 'validateCredentials' });
  if (trace.found && trace.depth >= 1) ok(`seer_trace_path login → validateCredentials depth=${trace.depth}`);
  else bad('seer_trace_path failed', trace);

  // seer_architecture
  const arch = await callTool('seer_architecture', {});
  if (arch.totals?.routes >= 10) ok(`seer_architecture routes=${arch.totals.routes}`); else bad('arch routes', arch.totals);
  if (arch.languages?.length >= 3) ok(`seer_architecture languages=${arch.languages.length}`); else bad('arch langs', arch.languages);

  // seer_symbols with FTS (the new code path)
  const sym = await callTool('seer_symbols', { query: 'validate', limit: 10 });
  if (sym.items?.some((s: any) => s.name === 'validateCredentials'))
    ok('seer_symbols FTS finds validateCredentials by "validate" (camelCase split)');
  else bad('seer_symbols FTS broken', sym);

  // seer_search
  const search = await callTool('seer_search', { query: 'auth' });
  if (search.symbolHits?.returned >= 1) ok(`seer_search(auth) symbolHits=${search.symbolHits.returned}`);
  else bad('seer_search empty', search);

  // seer_churn — not a git repo, should return zero (cleanly)
  const ch = await callTool('seer_churn', {});
  if (typeof ch.elapsedMs === 'number') ok(`seer_churn returned ms=${ch.elapsedMs}`);
  else bad('seer_churn broken', ch);

  // seer_health — should report routes, externalDeps, configKeys totals now
  const health = await callTool('seer_health', {});
  if (health.routes >= 10) ok(`seer_health routes=${health.routes}`); else bad('health routes', health);
  if (health.externalDependencies >= 8) ok(`seer_health deps=${health.externalDependencies}`); else bad('health deps', health);
  if (health.configKeys >= 4) ok(`seer_health configKeys=${health.configKeys}`); else bad('health configKeys', health);

  proc.stdin.end(); proc.kill();
  await new Promise(r => setTimeout(r, 200));
  try { fs.rmSync(TMP_WS, { recursive: true, force: true }); } catch { /* */ }

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  MCP Track-C/D: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('mcp-trackcd crashed:', err); process.exit(1); });
