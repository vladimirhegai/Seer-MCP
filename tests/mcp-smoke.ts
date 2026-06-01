/**
 * MCP smoke test: spawn `seer mcp` as a subprocess, drive it over stdio,
 * and verify each tool call returns sane JSON. The test acts as a minimal
 * JSON-RPC 2.0 client.
 *
 * Run with: npx tsx tests/mcp-smoke.ts
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'tests/fixtures');
const TMP_WS = path.join(os.tmpdir(), `seer-mcp-ws-${Date.now()}`);
const CLI = path.join(ROOT, 'dist/cli/index.js');

let passed = 0;
let failed = 0;
function ok(label: string): void { passed++; console.log(`  ✓ ${label}`); }
function bad(label: string, extra?: unknown): void {
  failed++;
  console.error(`  ✗ ${label}` + (extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''));
}

async function main(): Promise<void> {
  console.log('\nSeer MCP Smoke Test\n=====================\n');

  // Build a tiny workspace from fixtures.
  fs.mkdirSync(TMP_WS, { recursive: true });
  for (const f of fs.readdirSync(FIXTURES)) {
    fs.copyFileSync(path.join(FIXTURES, f), path.join(TMP_WS, f));
  }
  fs.writeFileSync(path.join(TMP_WS, 'alpha.ts'), [
    'export class Alpha {',
    '  run(): number { return 1; }',
    '}',
    'export function alphaOnly(): number {',
    '  const a = new Alpha();',
    '  return a.run();',
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(TMP_WS, 'beta.ts'), [
    'export class Beta {',
    '  run(): number { return 2; }',
    '}',
    'export function betaOnly(): number {',
    '  const b = new Beta();',
    '  return b.run();',
    '}',
    '',
  ].join('\n'));
  console.log(`  Workspace: ${TMP_WS}`);

  // Spawn the MCP server. Disable JIT/watcher for deterministic tests.
  const proc = spawn(process.execPath, [CLI, 'mcp', '--workspace', TMP_WS, '--no-watch', '--no-jit'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[mcp-stderr] ${d}`));

  // Buffer responses and dispatch by id.
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
  function call(method: string, params: any): Promise<any> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); }
      }, 30_000);
      pending.set(id, { resolve, timer });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      proc.stdin.write(msg);
    });
  }

  // Wait for the server to be ready by giving it a moment to spawn its
  // initial index. We poll initialize until it succeeds.
  let initOk = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await call('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mcp-smoke', version: '0.1.0' },
      });
      if (r.result) {
        initOk = true;
        if (r.result.instructions?.includes('seer_preflight') && r.result.instructions?.includes('stale/mispointed')) ok('initialize advertises Seer workflow instructions');
        else bad('initialize missing Seer workflow instructions', r.result);
        break;
      }
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 500));
  }
  if (initOk) ok('initialize handshake'); else bad('initialize handshake (server never responded)');

  // tools/list
  const list = await call('tools/list', {});
  const toolNames = (list.result?.tools ?? []).map((t: any) => t.name);
  const expected = [
    'seer_health', 'seer_stats', 'seer_symbols', 'seer_definition',
    'seer_file_symbols', 'seer_callers', 'seer_callees', 'seer_search', 'seer_reindex',
  ];
  for (const e of expected) {
    if (toolNames.includes(e)) ok(`tools/list includes ${e}`);
    else bad(`tools/list missing ${e}`, toolNames);
  }

  // seer_health
  const health = await call('tools/call', { name: 'seer_health', arguments: {} });
  const healthText = health.result?.content?.[0]?.text;
  if (!healthText) { bad('seer_health returned no content'); }
  else {
    const parsed = JSON.parse(healthText);
    if (parsed.schemaCurrent === true) ok('seer_health reports current schema');
    else bad('seer_health schema not current', parsed.schemaVersion);
    if (parsed.files > 0 && parsed.symbols > 0) ok(`seer_health files=${parsed.files} symbols=${parsed.symbols}`);
    else bad('seer_health empty index', parsed);
  }

  // seer_symbols (top)
  const top = await call('tools/call', { name: 'seer_symbols', arguments: { top: 5 } });
  const topText = top.result?.content?.[0]?.text;
  const topParsed = topText ? JSON.parse(topText) : null;
  if (topParsed && Array.isArray(topParsed.items) && topParsed.items.length > 0) {
    ok(`seer_symbols(top=5) returned ${topParsed.items.length} items`);
  } else {
    bad('seer_symbols(top=5) returned empty', topParsed);
  }

  // seer_symbols (query)
  const q = await call('tools/call', { name: 'seer_symbols', arguments: { query: 'AuthService' } });
  const qParsed = JSON.parse(q.result?.content?.[0]?.text ?? '{}');
  if (qParsed.items?.some((i: any) => i.name === 'AuthService')) ok('seer_symbols(query=AuthService) found it');
  else bad('seer_symbols(query=AuthService) did not find it', qParsed);

  // seer_definition (exact)
  const def = await call('tools/call', { name: 'seer_definition', arguments: { name: 'AuthService' } });
  const defParsed = JSON.parse(def.result?.content?.[0]?.text ?? '{}');
  if (defParsed.items?.length >= 1) ok(`seer_definition(AuthService) returned ${defParsed.items.length}`);
  else bad('seer_definition(AuthService) empty', defParsed);

  // seer_callers
  const callers = await call('tools/call', { name: 'seer_callers', arguments: { symbol: 'AuthService' } });
  const callersParsed = JSON.parse(callers.result?.content?.[0]?.text ?? '{}');
  if (callersParsed.total >= 1) ok(`seer_callers(AuthService) total=${callersParsed.total}`);
  else bad('seer_callers(AuthService) no callers', callersParsed);

  const exactCallers = await call('tools/call', {
    name: 'seer_callers',
    arguments: { symbol: 'Alpha.run', file: 'alpha.ts' },
  });
  const exactCallersParsed = JSON.parse(exactCallers.result?.content?.[0]?.text ?? '{}');
  const exactNames = (exactCallersParsed.items ?? []).map((i: any) => i.callerName);
  if (exactCallersParsed.total === 1 && exactNames.includes('alphaOnly') && !exactNames.includes('betaOnly')) {
    ok('seer_callers with file disambiguates qualified method names');
  } else bad('seer_callers with file leaked or missed callers', exactCallersParsed);

  const exactTrace = await call('tools/call', {
    name: 'seer_trace_callers',
    arguments: { symbol: 'Alpha.run', file: 'alpha.ts', maxDepth: 2 },
  });
  const exactTraceParsed = JSON.parse(exactTrace.result?.content?.[0]?.text ?? '{}');
  const traceNames = (exactTraceParsed.items ?? []).map((i: any) => i.name);
  if (exactTraceParsed.total === 1 && traceNames.includes('alphaOnly') && !traceNames.includes('betaOnly')) {
    ok('seer_trace_callers with file disambiguates qualified method names');
  } else bad('seer_trace_callers with file leaked or missed callers', exactTraceParsed);

  // seer_callees
  const callees = await call('tools/call', { name: 'seer_callees', arguments: { symbol: 'process_payment' } });
  const calleesParsed = JSON.parse(callees.result?.content?.[0]?.text ?? '{}');
  if (calleesParsed.total >= 1) ok(`seer_callees(process_payment) total=${calleesParsed.total}`);
  else bad('seer_callees(process_payment) no callees', calleesParsed);

  // seer_file_symbols
  const fileSyms = await call('tools/call', {
    name: 'seer_file_symbols',
    arguments: { file: 'sample.ts' },
  });
  const fsParsed = JSON.parse(fileSyms.result?.content?.[0]?.text ?? '{}');
  if (fsParsed.total >= 1) ok(`seer_file_symbols(sample.ts) total=${fsParsed.total}`);
  else bad('seer_file_symbols(sample.ts) empty', fsParsed);

  // seer_search
  const search = await call('tools/call', { name: 'seer_search', arguments: { query: 'auth' } });
  const sParsed = JSON.parse(search.result?.content?.[0]?.text ?? '{}');
  if (sParsed.symbolHits?.returned >= 1) ok(`seer_search(auth) symbolHits=${sParsed.symbolHits.returned}`);
  else bad('seer_search(auth) empty', sParsed);

  // seer_reindex
  const reindex = await call('tools/call', { name: 'seer_reindex', arguments: {} });
  const rParsed = JSON.parse(reindex.result?.content?.[0]?.text ?? '{}');
  if (typeof rParsed.elapsedMs === 'number') ok(`seer_reindex completed in ${rParsed.elapsedMs}ms`);
  else bad('seer_reindex did not return elapsedMs', rParsed);

  // seer_stats
  const stats = await call('tools/call', { name: 'seer_stats', arguments: {} });
  const statsParsed = JSON.parse(stats.result?.content?.[0]?.text ?? '{}');
  if (statsParsed.files >= 5 && statsParsed.roles) ok(`seer_stats files=${statsParsed.files} role-aware`);
  else bad('seer_stats missing role breakdown', statsParsed);

  proc.stdin.end();
  proc.kill();
  await new Promise(r => setTimeout(r, 200));

  // Cleanup
  try { fs.rmSync(TMP_WS, { recursive: true, force: true }); } catch { /* */ }

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  MCP results: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('MCP smoke crashed:', err);
  process.exit(1);
});
