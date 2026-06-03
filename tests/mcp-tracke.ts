/**
 * MCP smoke test for Track-E tools. Spawns `seer mcp` against the
 * fixtures-tracke workspace and exercises every new tool over stdio.
 *
 * Run: npx tsx tests/mcp-tracke.ts
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const ROOT = path.resolve(__dirname, '..');
const FIX = path.join(ROOT, 'tests/fixtures-tracke');
const TMP_WS = path.join(os.tmpdir(), `seer-mcp-e-${Date.now()}`);
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
  console.log('\nSeer MCP Track-E Smoke\n==========================\n');
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

  // tools/list — verify Track-E tools are advertised
  const list = await call('tools/list', {});
  const names: string[] = (list.result?.tools ?? []).map((t: any) => t.name);
  const trackeTools = [
    'seer_modules', 'seer_module_members', 'seer_symbol_module',
    'seer_module_dependencies', 'seer_modules_build',
    'seer_trace_file_dependencies', 'seer_trace_module_dependencies',
    'seer_trace_callers', 'seer_trace_callees',
    'seer_risk', 'seer_context',
  ];
  for (const n of trackeTools) {
    if (names.includes(n)) ok(`tools/list advertises ${n}`);
    else bad(`tools/list missing ${n}`, names);
  }

  const callTool = async (name: string, args: any = {}): Promise<any> => {
    const r = await call('tools/call', { name, arguments: args });
    return JSON.parse(r.result?.content?.[0]?.text ?? '{}');
  };

  // seer_modules
  const mods = await callTool('seer_modules', { limit: 10 });
  if (mods.total >= 2) ok(`seer_modules total=${mods.total}`); else bad('seer_modules empty', mods);
  if (mods.items?.some((m: any) => m.label === 'auth')) ok('seer_modules contains auth'); else bad('no auth module', mods);

  const authModule = mods.items?.find((m: any) => m.label === 'auth');
  const billingModule = mods.items?.find((m: any) => m.label === 'billing');
  if (!authModule || !billingModule) { bad('auth/billing modules not found'); process.exit(1); }

  // seer_module_members by id
  const members = await callTool('seer_module_members', { id: authModule.id });
  if (members.files?.total >= 2) ok(`seer_module_members(auth) files=${members.files.total}`);
  else bad('auth module has < 2 files', members);
  if (typeof members.files?.returned === 'number') ok('seer_module_members reports returned file count');
  else bad('seer_module_members missing returned file count', members.files);
  if (members.topSymbols?.items?.some((s: any) => s.name === 'AuthService'))
    ok('seer_module_members topSymbols includes AuthService');
  else bad('no AuthService in topSymbols', members.topSymbols);

  // seer_module_members by label
  const membersByLabel = await callTool('seer_module_members', { label: 'billing' });
  if (membersByLabel.module?.label === 'billing') ok('seer_module_members works by label');
  else bad('seer_module_members by label failed', membersByLabel);

  // seer_module_members for missing label
  const missingMember = await callTool('seer_module_members', { label: '__no_such_module__' });
  if (missingMember.found === false) ok('seer_module_members returns found=false for unknown label');
  else bad('seer_module_members did not surface missing label', missingMember);

  // seer_symbol_module
  const sm = await callTool('seer_symbol_module', { symbol: 'validateCredentials' });
  if (sm.matches?.some((m: any) => m.module?.label === 'auth'))
    ok('seer_symbol_module(validateCredentials) → auth');
  else bad('seer_symbol_module wrong module', sm);

  // seer_module_dependencies — billing → auth
  const deps = await callTool('seer_module_dependencies', { label: 'billing', direction: 'out' });
  if (deps.items?.some((d: any) => d.label === 'auth'))
    ok('seer_module_dependencies(billing, out) includes auth');
  else bad('billing→auth dep missing', deps);

  // seer_module_dependencies — direction=in
  const depsIn = await callTool('seer_module_dependencies', { label: 'auth', direction: 'in' });
  if (depsIn.items?.some((d: any) => d.label === 'billing'))
    ok('seer_module_dependencies(auth, in) includes billing');
  else bad('auth←billing dep missing (in)', depsIn);

  // seer_trace_file_dependencies — billing/Billing.ts → auth/AuthService.ts
  const fdep = await callTool('seer_trace_file_dependencies', { file: 'billing/Billing.ts', maxDepth: 3 });
  if (fdep.items?.some((c: any) => c.relPath?.includes('auth/AuthService')))
    ok('seer_trace_file_dependencies reaches auth/AuthService.ts');
  else bad('file closure missing auth', fdep);
  if ((fdep.returned ?? 0) <= (fdep.limit ?? 50)) ok('seer_trace_file_dependencies returns a bounded preview');
  else bad('seer_trace_file_dependencies preview exceeded limit', fdep);
  const fdepSummary = await callTool('seer_trace_file_dependencies', {
    file: 'billing/Billing.ts', maxDepth: 3, summaryOnly: true,
  });
  if (fdepSummary.totalReachable >= 1 && fdepSummary.items === undefined) ok('seer_trace_file_dependencies summaryOnly omits raw items');
  else bad('seer_trace_file_dependencies summaryOnly returned item payload', fdepSummary);

  // seer_trace_module_dependencies — billing → auth
  const mdep = await callTool('seer_trace_module_dependencies', { label: 'billing', direction: 'out' });
  if (mdep.items?.some((m: any) => m.label === 'auth'))
    ok('seer_trace_module_dependencies(billing, out) reaches auth');
  else bad('module trace missing auth', mdep);
  const mdepPaged = await callTool('seer_trace_module_dependencies', {
    label: 'billing', direction: 'out', limit: 1,
  });
  if ((mdepPaged.returned ?? 0) <= 1) ok('seer_trace_module_dependencies paginates with limit');
  else bad('seer_trace_module_dependencies ignored limit', mdepPaged);

  // seer_trace_callers — validateCredentials has transitive callers
  const trc = await callTool('seer_trace_callers', { symbol: 'validateCredentials', maxDepth: 4 });
  if ((trc.total ?? 0) >= 1) ok(`seer_trace_callers total=${trc.total}`);
  else bad('seer_trace_callers empty', trc);

  // seer_trace_callees — chargeCustomer reaches validateCredentials
  const trCe = await callTool('seer_trace_callees', { symbol: 'chargeCustomer', maxDepth: 5 });
  if (trCe.items?.some((i: any) => i.name === 'validateCredentials'))
    ok('seer_trace_callees(chargeCustomer) reaches validateCredentials');
  else bad('forward trace did not reach target', trCe);

  // seer_behavior 2.0 — direct + indirect counts
  const beh = await callTool('seer_behavior', { symbol: 'validateCredentials', limit: 20 });
  if ((beh.direct ?? 0) >= 1) ok(`seer_behavior direct=${beh.direct}`);
  else bad('seer_behavior no direct tests', beh);
  if ((beh.indirect ?? 0) >= 1) ok(`seer_behavior indirect=${beh.indirect}`);
  else bad('seer_behavior no indirect tests', beh);
  if (Array.isArray(beh.tests) && beh.tests[0]?.relationship === 'direct-call')
    ok('seer_behavior ranks direct tests first');
  else bad('seer_behavior ranking wrong', beh.tests);

  // seer_risk
  const risk = await callTool('seer_risk', { symbol: 'chargeCustomer' });
  if (risk.signals?.routeExposed) ok('seer_risk(chargeCustomer) routeExposed=true');
  else bad('seer_risk routeExposed false', risk.signals);
  if (Array.isArray(risk.signalContributions) && risk.signalContributions.length >= 10)
    ok(`seer_risk signalContributions=${risk.signalContributions.length}`);
  else bad('seer_risk signals incomplete', risk.signalContributions);
  if (['low', 'medium', 'high'].includes(risk.risk))
    ok(`seer_risk verdict=${risk.risk}`);
  else bad('seer_risk verdict invalid', risk);

  // seer_context — must include every Track-E section
  const ctx = await callTool('seer_context', { symbol: 'validateCredentials' });
  if (ctx.symbol?.name === 'validateCredentials') ok('seer_context symbol returned');
  else bad('seer_context missing symbol', ctx);
  if (ctx.module?.label === 'auth') ok('seer_context.module=auth');
  else bad('seer_context module wrong', ctx.module);
  if (ctx.callers?.total >= 1) ok('seer_context.callers.total ≥ 1');
  else bad('seer_context callers empty', ctx.callers);
  if (Array.isArray(ctx.behavior?.preview)) ok('seer_context.behavior present');
  else bad('seer_context behavior missing', ctx.behavior);
  if (typeof ctx.routesTotal === 'number' && Array.isArray(ctx.routes)) ok('seer_context exposes route total + preview');
  else bad('seer_context route preview metadata missing', ctx);
  if (typeof ctx.configKeysTotal === 'number' && Array.isArray(ctx.configKeys)) ok('seer_context exposes config-key total + preview');
  else bad('seer_context config-key preview metadata missing', ctx);
  if (Array.isArray(ctx.risk?.signalContributions)) ok('seer_context.risk.signalContributions present');
  else bad('seer_context risk missing', ctx.risk);
  if (Array.isArray(ctx.blastRadius?.topAffected)) ok('seer_context.blastRadius present');
  else bad('seer_context blastRadius missing', ctx.blastRadius);

  // seer_modules_build — idempotent
  const rebuild = await callTool('seer_modules_build', {});
  if (typeof rebuild.modules === 'number' && rebuild.modules === mods.total)
    ok(`seer_modules_build idempotent (${rebuild.modules} modules)`);
  else bad('seer_modules_build not idempotent', rebuild);

  // seer_health surfaces modules
  const health = await callTool('seer_health', {});
  if ((health.modules ?? 0) >= 2) ok(`seer_health modules=${health.modules}`);
  else bad('seer_health.modules low', health);

  proc.stdin.end(); proc.kill();
  await new Promise(r => setTimeout(r, 200));
  try { fs.rmSync(TMP_WS, { recursive: true, force: true }); } catch { /* */ }

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  MCP Track-E: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('mcp-tracke crashed:', err); process.exit(1); });
