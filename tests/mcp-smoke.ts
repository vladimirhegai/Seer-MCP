/**
 * MCP smoke test: spawn `strata mcp` as a subprocess, drive it over stdio,
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
const TMP_WS = path.join(os.tmpdir(), `strata-mcp-ws-${Date.now()}`);
const CLI = path.join(ROOT, 'dist/cli/index.js');

let passed = 0;
let failed = 0;
function ok(label: string): void { passed++; console.log(`  ✓ ${label}`); }
function bad(label: string, extra?: unknown): void {
  failed++;
  console.error(`  ✗ ${label}` + (extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''));
}

async function main(): Promise<void> {
  console.log('\nStrata MCP Smoke Test\n=====================\n');

  // Build a tiny workspace from fixtures.
  fs.mkdirSync(TMP_WS, { recursive: true });
  for (const f of fs.readdirSync(FIXTURES)) {
    fs.copyFileSync(path.join(FIXTURES, f), path.join(TMP_WS, f));
  }
  console.log(`  Workspace: ${TMP_WS}`);

  // Spawn the MCP server. Disable JIT/watcher for deterministic tests.
  const proc = spawn(process.execPath, [CLI, 'mcp', '--workspace', TMP_WS, '--no-watch', '--no-jit'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[mcp-stderr] ${d}`));

  // Buffer responses and dispatch by id.
  let buf = '';
  const pending = new Map<number, (msg: any) => void>();
  proc.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    }
  });

  let nextId = 1;
  function call(method: string, params: any): Promise<any> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      proc.stdin.write(msg);
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); }
      }, 30_000);
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
      if (r.result) { initOk = true; break; }
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 500));
  }
  if (initOk) ok('initialize handshake'); else bad('initialize handshake (server never responded)');

  // tools/list
  const list = await call('tools/list', {});
  const toolNames = (list.result?.tools ?? []).map((t: any) => t.name);
  const expected = [
    'strata_health', 'strata_stats', 'strata_symbols', 'strata_definition',
    'strata_file_symbols', 'strata_callers', 'strata_callees', 'strata_search', 'strata_reindex',
  ];
  for (const e of expected) {
    if (toolNames.includes(e)) ok(`tools/list includes ${e}`);
    else bad(`tools/list missing ${e}`, toolNames);
  }

  // strata_health
  const health = await call('tools/call', { name: 'strata_health', arguments: {} });
  const healthText = health.result?.content?.[0]?.text;
  if (!healthText) { bad('strata_health returned no content'); }
  else {
    const parsed = JSON.parse(healthText);
    if (parsed.schemaCurrent === true) ok('strata_health reports current schema');
    else bad('strata_health schema not current', parsed.schemaVersion);
    if (parsed.files > 0 && parsed.symbols > 0) ok(`strata_health files=${parsed.files} symbols=${parsed.symbols}`);
    else bad('strata_health empty index', parsed);
  }

  // strata_symbols (top)
  const top = await call('tools/call', { name: 'strata_symbols', arguments: { top: 5 } });
  const topText = top.result?.content?.[0]?.text;
  const topParsed = topText ? JSON.parse(topText) : null;
  if (topParsed && Array.isArray(topParsed.items) && topParsed.items.length > 0) {
    ok(`strata_symbols(top=5) returned ${topParsed.items.length} items`);
  } else {
    bad('strata_symbols(top=5) returned empty', topParsed);
  }

  // strata_symbols (query)
  const q = await call('tools/call', { name: 'strata_symbols', arguments: { query: 'AuthService' } });
  const qParsed = JSON.parse(q.result?.content?.[0]?.text ?? '{}');
  if (qParsed.items?.some((i: any) => i.name === 'AuthService')) ok('strata_symbols(query=AuthService) found it');
  else bad('strata_symbols(query=AuthService) did not find it', qParsed);

  // strata_definition (exact)
  const def = await call('tools/call', { name: 'strata_definition', arguments: { name: 'AuthService' } });
  const defParsed = JSON.parse(def.result?.content?.[0]?.text ?? '{}');
  if (defParsed.items?.length >= 1) ok(`strata_definition(AuthService) returned ${defParsed.items.length}`);
  else bad('strata_definition(AuthService) empty', defParsed);

  // strata_callers
  const callers = await call('tools/call', { name: 'strata_callers', arguments: { symbol: 'AuthService' } });
  const callersParsed = JSON.parse(callers.result?.content?.[0]?.text ?? '{}');
  if (callersParsed.total >= 1) ok(`strata_callers(AuthService) total=${callersParsed.total}`);
  else bad('strata_callers(AuthService) no callers', callersParsed);

  // strata_callees
  const callees = await call('tools/call', { name: 'strata_callees', arguments: { symbol: 'process_payment' } });
  const calleesParsed = JSON.parse(callees.result?.content?.[0]?.text ?? '{}');
  if (calleesParsed.total >= 1) ok(`strata_callees(process_payment) total=${calleesParsed.total}`);
  else bad('strata_callees(process_payment) no callees', calleesParsed);

  // strata_file_symbols
  const fileSyms = await call('tools/call', {
    name: 'strata_file_symbols',
    arguments: { file: 'sample.ts' },
  });
  const fsParsed = JSON.parse(fileSyms.result?.content?.[0]?.text ?? '{}');
  if (fsParsed.total >= 1) ok(`strata_file_symbols(sample.ts) total=${fsParsed.total}`);
  else bad('strata_file_symbols(sample.ts) empty', fsParsed);

  // strata_search
  const search = await call('tools/call', { name: 'strata_search', arguments: { query: 'auth' } });
  const sParsed = JSON.parse(search.result?.content?.[0]?.text ?? '{}');
  if (sParsed.symbolHits?.returned >= 1) ok(`strata_search(auth) symbolHits=${sParsed.symbolHits.returned}`);
  else bad('strata_search(auth) empty', sParsed);

  // strata_reindex
  const reindex = await call('tools/call', { name: 'strata_reindex', arguments: {} });
  const rParsed = JSON.parse(reindex.result?.content?.[0]?.text ?? '{}');
  if (typeof rParsed.elapsedMs === 'number') ok(`strata_reindex completed in ${rParsed.elapsedMs}ms`);
  else bad('strata_reindex did not return elapsedMs', rParsed);

  // strata_stats
  const stats = await call('tools/call', { name: 'strata_stats', arguments: {} });
  const statsParsed = JSON.parse(stats.result?.content?.[0]?.text ?? '{}');
  if (statsParsed.files >= 5 && statsParsed.roles) ok(`strata_stats files=${statsParsed.files} role-aware`);
  else bad('strata_stats missing role breakdown', statsParsed);

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
