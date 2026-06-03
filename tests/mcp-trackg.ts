/**
 * MCP smoke test for Track G — service-link tools.
 * Spawns `seer mcp` against the fixtures-service workspace and exercises
 * seer_service_calls, seer_service_links, seer_trace_service_path.
 *
 * Run: npx tsx tests/mcp-trackg.ts
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const ROOT = path.resolve(__dirname, '..');
const FIX = path.join(ROOT, 'tests/fixtures-service');
const TMP_WS = path.join(os.tmpdir(), `seer-mcp-g-${Date.now()}`);
const CLI = path.join(ROOT, 'dist/cli/index.js');

let passed = 0;
let failed = 0;
const ok  = (m: string): void => { passed++; console.log(`  ✓ ${m}`); };
const bad = (m: string, x?: unknown): void => {
  failed++;
  console.error(`  ✗ ${m}` + (x !== undefined ? `  ::  ${JSON.stringify(x).slice(0, 400)}` : ''));
};

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
  console.log('\nSeer MCP Track-G Smoke');
  console.log('======================\n');
  copyRecursive(FIX, TMP_WS);
  console.log(`  Workspace: ${TMP_WS}`);

  const proc = spawn(process.execPath,
    [CLI, 'mcp', '--workspace', TMP_WS, '--no-watch', '--no-jit'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stderr.on('data', d => process.stderr.write(`[mcp-stderr] ${d}`));

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

  const list = await call('tools/list', {});
  const names: string[] = (list.result?.tools ?? []).map((t: any) => t.name);
  for (const n of ['seer_service_calls', 'seer_service_links', 'seer_trace_service_path']) {
    if (names.includes(n)) ok(`tools/list advertises ${n}`);
    else bad(`tools/list missing ${n}`, names);
  }

  const callTool = async (name: string, args: any = {}): Promise<any> => {
    const r = await call('tools/call', { name, arguments: args });
    return JSON.parse(r.result?.content?.[0]?.text ?? '{}');
  };

  // seer_service_calls
  const sc = await callTool('seer_service_calls', { limit: 100 });
  if (sc.total > 0) ok(`seer_service_calls.total = ${sc.total}`);
  else bad('seer_service_calls.total is 0', sc);
  if (Array.isArray(sc.items) && sc.items.length > 0) ok('seer_service_calls.items non-empty');
  else bad('seer_service_calls.items empty', sc);
  const charge = sc.items?.find((r: any) => r.rawTarget === '/api/charge');
  if (charge) ok('seer_service_calls includes /api/charge');
  else bad('seer_service_calls missing /api/charge', sc.items);

  // pagination
  const page1 = await callTool('seer_service_calls', { limit: 2, offset: 0 });
  const page2 = await callTool('seer_service_calls', { limit: 2, offset: 2 });
  if ((page1.items?.[0]?.id ?? -1) !== (page2.items?.[0]?.id ?? -2)) ok('pagination paginates');
  else bad('pagination did not move offset', { page1, page2 });

  // filter by framework
  const fetched = await callTool('seer_service_calls', { framework: 'fetch' });
  if ((fetched.items ?? []).every((r: any) => r.framework === 'fetch'))
    ok('framework filter applied');
  else bad('framework filter not applied', fetched.items);

  // summaryOnly
  const summary = await callTool('seer_service_calls', { summaryOnly: true });
  if (typeof summary.total === 'number' && !summary.items) ok('summaryOnly returns counts only');
  else bad('summaryOnly returned items', summary);

  // seer_service_links
  const sl = await callTool('seer_service_links', { limit: 50 });
  if (sl.total >= 2) ok(`seer_service_links.total ≥ 2 (got ${sl.total})`);
  else bad('seer_service_links.total < 2', sl);
  const chargeLink = sl.items?.find((r: any) => r.routePath === '/api/charge');
  if (chargeLink) {
    ok('seer_service_links includes /api/charge link');
    if (chargeLink.callerQualifiedName === 'processPayment') ok('link caller = processPayment');
    else bad('link caller wrong', chargeLink);
    if (chargeLink.handlerQualifiedName === 'chargeHandler') ok('link handler = chargeHandler');
    else bad('link handler wrong', chargeLink);
    if (chargeLink.matchKind === 'literal_path') ok('link match_kind = literal_path');
    else bad('link match_kind wrong', chargeLink);
  } else bad('seer_service_links missing /api/charge', sl.items);

  // filter by matchKind
  const patterns = await callTool('seer_service_links', { matchKind: 'route_pattern' });
  if ((patterns.items ?? []).every((r: any) => r.matchKind === 'route_pattern'))
    ok('matchKind filter applied');
  else bad('matchKind filter not applied', patterns.items);

  // seer_trace_service_path
  const trace = await callTool('seer_trace_service_path', {
    from: 'processPayment', to: 'chargeHandler', maxDepth: 4,
  });
  if (trace.ok && trace.found) ok('trace_service_path found');
  else bad('trace_service_path did not find path', trace);
  if (trace.path?.length === 2) ok('trace path is 2 hops');
  else bad('trace path length unexpected', trace);

  const noTrace = await callTool('seer_trace_service_path', {
    from: 'processPayment', to: 'nonexistentSymbolXYZ', maxDepth: 4,
  });
  if (noTrace.ok === false) ok('trace_service_path returns ok=false on missing target');
  else bad('trace_service_path did not refuse missing target', noTrace);

  // v9 Track-H Step 8: seer_trace_service_dependencies
  const tools = await call('tools/list', {});
  const toolNames = (tools.result?.tools ?? []).map((t: any) => t.name);
  if (toolNames.includes('seer_trace_service_dependencies'))
    ok('tools/list advertises seer_trace_service_dependencies');
  else bad('seer_trace_service_dependencies missing from tools/list', toolNames);
  if (toolNames.includes('seer_trace_module_service_dependencies'))
    ok('tools/list advertises seer_trace_module_service_dependencies');
  else bad('seer_trace_module_service_dependencies missing from tools/list', toolNames);

  const deps = await callTool('seer_trace_service_dependencies', {
    from: 'processPayment', maxDepth: 4, maxNodes: 50,
  });
  if (deps.ok && Array.isArray(deps.items))
    ok(`seer_trace_service_dependencies returned ${deps.items.length} items`);
  else bad('seer_trace_service_dependencies failed', deps);
  if ((deps.items ?? []).some((i: any) => i.qualifiedName === 'chargeHandler'))
    ok('processPayment reaches chargeHandler');
  else bad('chargeHandler not in reached set', deps.items);
  if ((deps.returned ?? 0) <= (deps.limit ?? 25))
    ok('trace_service_dependencies returns a bounded preview');
  else bad('trace_service_dependencies preview exceeded limit', deps);

  const depsSummary = await callTool('seer_trace_service_dependencies', {
    from: 'processPayment', maxDepth: 4, maxNodes: 50, summaryOnly: true,
  });
  if (depsSummary.ok && depsSummary.items === undefined && depsSummary.returned === undefined
      && depsSummary.rows?.omittedByMode === true)
    ok('trace_service_dependencies summaryOnly omits raw items (rows.omittedByMode)');
  else bad('trace_service_dependencies summaryOnly returned item payload', depsSummary);

  const bounded = await callTool('seer_trace_service_dependencies', {
    from: 'processPayment', maxDepth: 4, maxNodes: 1,
  });
  if (bounded.ok && bounded.items.length <= 1)
    ok('trace_service_dependencies honours maxNodes cap (limit 1)');
  else bad('trace_service_dependencies did not cut off', bounded);

  const noFrom = await callTool('seer_trace_service_dependencies', {
    from: 'nonexistentSymbolXYZ',
  });
  if (noFrom.ok === false) ok('trace_service_dependencies returns ok=false on missing source');
  else bad('trace_service_dependencies did not refuse missing source', noFrom);

  const modDeps = await callTool('seer_trace_module_service_dependencies', {
    moduleId: 1, maxDepth: 2, maxNodes: 10,
  });
  if (modDeps.ok && Array.isArray(modDeps.items))
    ok(`trace_module_service_dependencies returned ${modDeps.items.length} items`);
  else bad('trace_module_service_dependencies failed', modDeps);
  const modDepsSummary = await callTool('seer_trace_module_service_dependencies', {
    moduleId: 1, maxDepth: 2, maxNodes: 10, summaryOnly: true,
  });
  if (modDepsSummary.ok && modDepsSummary.items === undefined && modDepsSummary.returned === undefined
      && modDepsSummary.rows?.omittedByMode === true)
    ok('trace_module_service_dependencies summaryOnly omits raw items (rows.omittedByMode)');
  else bad('trace_module_service_dependencies summaryOnly returned item payload', modDepsSummary);

  // seer_health surfaces v9 fields
  const health = await callTool('seer_health', {});
  if (health.schemaVersion === 11) ok('seer_health.schemaVersion = 11');
  else bad('seer_health.schemaVersion not 11', health);

  proc.stdin.end(); proc.kill();
  await new Promise(r => setTimeout(r, 200));
  try { fs.rmSync(TMP_WS, { recursive: true, force: true }); } catch { /* */ }

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  MCP Track-G: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('mcp-trackg crashed:', err); process.exit(1); });
