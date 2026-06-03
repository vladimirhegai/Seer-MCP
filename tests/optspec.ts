/**
 * MCP test for the AI-agent optimization features:
 *   §1 token-budget truncation envelope (deterministic prefix-trim)
 *   §2 did-you-mean fuzzy fallback (suggestion-only, never substitute)
 *   §3 seer_skeleton (deterministic source elision + focus expansion)
 *   §4 seer_batch (multi-tool fan-out in one call)
 *   §5a lazy lifecycle (build tools rebranded; dependents auto-build)
 *   §5b seer_trace umbrella (scope-dispatch over the seer_trace_* family)
 *
 * Spawns `seer mcp` against fixtures-tracke and drives it over stdio.
 * Run: npx tsx tests/optspec.ts
 */
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const ROOT = path.resolve(__dirname, '..');
const FIX = path.join(ROOT, 'tests/fixtures-tracke');
const TMP_WS = path.join(os.tmpdir(), `seer-optspec-${Date.now()}`);
const CLI = path.join(ROOT, 'dist/cli/index.js');

let passed = 0;
let failed = 0;
const ok = (m: string): void => { passed++; console.log(`  ✓ ${m}`); };
const bad = (m: string, x?: unknown): void => {
  failed++;
  console.error(`  ✗ ${m}` + (x !== undefined ? `  ::  ${JSON.stringify(x).slice(0, 240)}` : ''));
};
const check = (cond: boolean, m: string, x?: unknown): void => { cond ? ok(m) : bad(m, x); };

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
  console.log('\nSeer MCP Optimization-Spec Tests\n================================\n');
  copyRecursive(FIX, TMP_WS);

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
  const callTool = async (name: string, args: any = {}): Promise<any> => {
    const r = await call('tools/call', { name, arguments: args });
    return JSON.parse(r.result?.content?.[0]?.text ?? '{}');
  };

  // ── init ──
  let initOk = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
      if (r.result) { initOk = true; break; }
    } catch { /* */ }
    await new Promise(r => setTimeout(r, 500));
  }
  if (initOk) ok('initialize'); else { bad('initialize'); process.exit(1); }

  // ── tools/list advertises the new surface ──
  const list = await call('tools/list', {});
  const tools: Array<{ name: string; description: string; annotations?: any; _meta?: any }> = list.result?.tools ?? [];
  const names = tools.map(t => t.name);
  for (const n of ['seer_skeleton', 'seer_trace', 'seer_batch']) {
    check(names.includes(n), `tools/list advertises ${n}`, names);
  }
  for (const n of ['seer_context', 'seer_preflight', 'seer_trace', 'seer_batch']) {
    const t = tools.find(tool => tool.name === n);
    check(t?.annotations?.readOnlyHint === true && t?._meta?.['anthropic/alwaysLoad'] === true,
      `${n} advertises core read-only MCP hints`, t);
  }
  // §5a: build tools rebranded as advanced
  for (const n of ['seer_modules_build', 'seer_shape_hash_build']) {
    const d = tools.find(t => t.name === n)?.description ?? '';
    check(/advanced/i.test(d), `${n} description marked advanced/automatic`, d);
    check(tools.find(t => t.name === n)?.annotations?.readOnlyHint === false,
      `${n} is not advertised as read-only`, tools.find(t => t.name === n));
  }
  // seer_symbol_history_build: scoped path is now a sanctioned cheap agent build,
  // so the description signals it WRITES and distinguishes scoped vs full rather
  // than blanket "advanced". It must still be side-effecting (not read-only).
  {
    const d = tools.find(t => t.name === 'seer_symbol_history_build')?.description ?? '';
    check(/write/i.test(d) && /scoped/i.test(d),
      'seer_symbol_history_build description signals it writes and offers a scoped path', d);
    check(tools.find(t => t.name === 'seer_symbol_history_build')?.annotations?.readOnlyHint === false,
      'seer_symbol_history_build is not advertised as read-only', tools.find(t => t.name === 'seer_symbol_history_build'));
  }
  for (const n of ['seer_modules', 'seer_duplicates', 'seer_continuity']) {
    check(tools.find(t => t.name === n)?.annotations?.readOnlyHint === false,
      `${n} can auto-build derived indexes and is not advertised as read-only`, tools.find(t => t.name === n));
  }

  // ── §3 seer_skeleton ──────────────────────────────────────────────────
  const sk = await callTool('seer_skeleton', { file: 'auth/AuthService.ts' });
  check(sk.ok === true, 'seer_skeleton resolves file by rel_path fragment', sk);
  check(typeof sk.skeleton === 'string' && sk.skeleton.includes('AuthService'),
    'skeleton shows the class AuthService', sk.skeleton);
  check(/login/.test(sk.skeleton) && /logout/.test(sk.skeleton),
    'skeleton shows nested methods login/logout', sk.skeleton);
  check(/validateCredentials/.test(sk.skeleton), 'skeleton shows free function validateCredentials', sk.skeleton);
  check(/\{ … \d+ lines … \}/.test(sk.skeleton), 'skeleton collapses bodies with exact line-count fold markers', sk.skeleton);
  // Bodies must NOT appear verbatim (no focus): the literal call should be hidden.
  check(!sk.skeleton.includes('invalidateToken(token)'), 'skeleton elides body source (no focus)', sk.skeleton);

  // Determinism: identical render twice.
  const sk2 = await callTool('seer_skeleton', { file: 'auth/AuthService.ts' });
  check(sk2.skeleton === sk.skeleton, 'seer_skeleton is deterministic (byte-identical re-render)');

  // Focus expands a single body verbatim.
  const skf = await callTool('seer_skeleton', { file: 'auth/AuthService.ts', focusSymbol: 'login' });
  check(/◀ focus/.test(skf.skeleton) && skf.skeleton.includes('hashPassword(password)'),
    'seer_skeleton focusSymbol expands the target body verbatim', skf.skeleton);

  const skMiss = await callTool('seer_skeleton', { file: 'does/not/exist.ts' });
  check(skMiss.ok === false, 'seer_skeleton returns ok:false for an unknown file', skMiss);

  // ── §2 did-you-mean ───────────────────────────────────────────────────
  const exact = await callTool('seer_definition', { name: 'validateCredentials' });
  check((exact.items ?? []).length >= 1 && exact.didYouMean === undefined,
    'seer_definition exact hit carries NO didYouMean', exact);

  const typo = await callTool('seer_definition', { name: 'validateCredential' }); // missing trailing s
  check((typo.items ?? []).length === 0, 'seer_definition typo returns zero exact items', typo);
  check(Array.isArray(typo.didYouMean) && typo.didYouMean.some((d: any) => d.name === 'validateCredentials'),
    'seer_definition typo surfaces didYouMean → validateCredentials (suggestion-only)', typo.didYouMean);

  const riskMiss = await callTool('seer_risk', { symbol: 'validateCredential' });
  check(riskMiss.found === false && Array.isArray(riskMiss.didYouMean) && riskMiss.didYouMean.length > 0,
    'seer_risk on a missing symbol returns found:false + didYouMean (never computes on a guess)', riskMiss);

  // ── §1 token budget ───────────────────────────────────────────────────
  const full = await callTool('seer_symbols', { query: 'a', limit: 200 });
  const tiny = await callTool('seer_symbols', { query: 'a', limit: 200, tokenBudget: 60 });
  check(full.truncated === undefined, 'seer_symbols without tokenBudget is not flagged truncated', full.truncated);
  check(tiny.truncated === true && tiny.returned <= full.returned,
    'seer_symbols tokenBudget trims items and flags truncated', { full: full.returned, tiny: tiny.returned });
  check(tiny.returned >= 1, 'token budget always keeps at least one item', tiny.returned);
  check(JSON.stringify(tiny).length <= JSON.stringify(full).length,
    'budgeted payload is no larger than the full payload', { t: JSON.stringify(tiny).length, f: JSON.stringify(full).length });

  // ── §5b seer_trace umbrella ───────────────────────────────────────────
  const tr = await callTool('seer_trace', { scope: 'callers', args: { symbol: 'validateCredentials', maxDepth: 4 } });
  const trDirect = await callTool('seer_trace_callers', { symbol: 'validateCredentials', maxDepth: 4 });
  check((tr.total ?? -1) === (trDirect.total ?? -2),
    'seer_trace scope=callers matches seer_trace_callers directly', { umbrella: tr.total, direct: trDirect.total });
  const trFile = await callTool('seer_trace', { scope: 'file', args: { file: 'billing/Billing.ts', maxDepth: 3 } });
  check(trFile.from != null || trFile.found === false, 'seer_trace scope=file delegates to file-dependency trace', trFile);
  const trBad = await callTool('seer_trace', { scope: 'callers', args: {} });
  check(trBad.found === false || trBad.error != null, 'seer_trace passes through delegate errors', trBad);

  // ── §4 seer_batch ─────────────────────────────────────────────────────
  const batch = await callTool('seer_batch', { calls: [
    { tool: 'seer_definition', args: { name: 'validateCredentials' } },
    { tool: 'seer_callers', args: { symbol: 'validateCredentials' } },
    { tool: 'seer_skeleton', args: { file: 'auth/AuthService.ts' } },
    { tool: 'seer_definition', args: { name: '__nope__' } },
  ] });
  check(batch.batch === true && batch.count === 4, 'seer_batch returns all 4 results', batch.count);
  check(batch.results[0].ok === true && (batch.results[0].result.items ?? []).length >= 1,
    'seer_batch result[0] = definition hit', batch.results[0]);
  check(batch.results[2].ok === true && batch.results[2].result.ok === true,
    'seer_batch result[2] = skeleton ok', batch.results[2]);
  check(batch.results[3].ok === true && (batch.results[3].result.items ?? []).length === 0,
    'seer_batch tolerates a sub-call that finds nothing (still ok:true wrapper)', batch.results[3]);

  const batchNest = await callTool('seer_batch', { calls: [{ tool: 'seer_batch', args: {} }] });
  check(batchNest.results[0].ok === false && /nested|disallowed/i.test(batchNest.results[0].error),
    'seer_batch refuses to nest', batchNest.results[0]);
  const batchUnknown = await callTool('seer_batch', { calls: [{ tool: 'seer_nonexistent', args: {} }] });
  check(batchUnknown.results[0].ok === false && /unknown/i.test(batchUnknown.results[0].error),
    'seer_batch reports unknown tool without aborting', batchUnknown.results[0]);
  const batchMaintenance = await callTool('seer_batch', { calls: [{ tool: 'seer_symbol_history_build', args: { maxSeconds: 1 } }] });
  check(batchMaintenance.results[0].ok === false && /read-only|maintenance|derived-index/i.test(batchMaintenance.results[0].error),
    'seer_batch refuses maintenance/build tools', batchMaintenance.results[0]);
  const batchDerived = await callTool('seer_batch', { calls: [{ tool: 'seer_modules', args: {} }] });
  check(batchDerived.results[0].ok === false && /read-only|derived-index/i.test(batchDerived.results[0].error),
    'seer_batch refuses query tools that can auto-build derived indexes', batchDerived.results[0]);

  // ── §5a dependents still serve data (auto-build path doesn't break) ────
  const dup = await callTool('seer_duplicates', {});
  check(typeof dup.clusters === 'number', 'seer_duplicates serves after lazy shape-hash guard', dup);
  const mods = await callTool('seer_modules', {});
  check((mods.total ?? 0) >= 1, 'seer_modules serves after lazy modules guard', mods);

  proc.kill();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
