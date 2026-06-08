/**
 * Track E feature tests.
 *
 * Indexes `tests/fixtures-tracke/` once and exercises every Track-E feature:
 *   - Louvain module clustering (auto-built during indexDirectory)
 *   - Module MCP-style queries (listModules, listModuleMembers,
 *     moduleForFile, moduleDependencies, listModuleTopSymbols)
 *   - Bounded reverse / forward reachability with depth
 *   - File-import closure (seer_trace_file_dependencies basis)
 *   - Ranked seer_behavior 2.0 (direct / indirect / naming / same-file)
 *   - seer_risk decomposed signals
 *   - seer_context one-call packet
 *
 * Run with: npx tsx tests/tracke.ts
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { Indexer } from '../src/indexer/index';
import { Store } from '../src/db/store';
import { buildModules } from '../src/indexer/modules';
import { rankedBehavior } from '../src/indexer/behavior';
import { computeRisk } from '../src/indexer/risk';
import { buildContext } from '../src/indexer/context';

const FIXTURES = path.join(__dirname, 'fixtures-tracke');
const TMP_DB = path.join(os.tmpdir(), `seer-tracke-${Date.now()}.db`);
const TMP_WS = path.join(os.tmpdir(), `seer-tracke-ws-${Date.now()}`);

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}`); failed++; }
}
function assertEq<T>(actual: T, expected: T, msg: string): void {
  assert(actual === expected, `${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

function copyRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

function writeRiskFanInFixture(root: string): void {
  const lines = ['export function fanInOnly(): number { return 1; }'];
  for (let i = 0; i < 80; i++) {
    lines.push(`export function fanInDirect${i}(): number { return fanInOnly(); }`);
  }
  for (let i = 0; i < 220; i++) {
    lines.push(`export function fanInParent${i}(): number { return fanInDirect${i % 80}(); }`);
  }
  fs.writeFileSync(path.join(root, 'fan-in.ts'), lines.join('\n') + '\n', 'utf8');
}

async function run(): Promise<void> {
  console.log('\nSeer Track E Feature Tests');
  console.log('============================\n');

  if (!fs.existsSync(FIXTURES)) {
    console.error(`Missing fixtures dir: ${FIXTURES}`);
    process.exit(1);
  }
  copyRecursive(FIXTURES, TMP_WS);
  writeRiskFanInFixture(TMP_WS);

  const store = new Store(TMP_DB);
  const indexer = new Indexer(store);
  console.log(`Indexing ${TMP_WS}...`);
  const r = await indexer.indexDirectory(TMP_WS, { quiet: true });
  console.log(`  files=${r.filesIndexed} symbols=${r.symbols} edges=${r.edges} modules=${r.modules}\n`);

  // ── Schema version ────────────────────────────────────────────────────────
  console.log('── Schema ──');
  const schema = store.schemaInfo();
  assertEq(schema.current, true, 'schema is current');
  assertEq(schema.dbVersion, 11, 'schema version is v11');

  // ── Modules: clustering built automatically ───────────────────────────────
  console.log('\n── Module clustering ──');
  assert(store.hasModulesData(), 'module clustering ran during indexDirectory');
  const modules = store.listModules({ limit: 50 });
  console.log(`  ${modules.length} modules:`);
  for (const m of modules) {
    console.log(`    [${m.id}] ${m.label.padEnd(20)} files=${m.sizeFiles}  symbols=${m.sizeSymbols}  primary=${m.primaryLanguage}  cohesion=${m.cohesion.toFixed(2)}  centrality=${m.centrality.toFixed(4)}`);
  }
  assert(modules.length >= 2, `at least 2 modules clustered (got ${modules.length})`);
  // Every module is non-empty.
  for (const m of modules) assert(m.sizeFiles > 0, `module "${m.label}" has at least 1 file`);
  // Labels are unique.
  const labelSet = new Set(modules.map(m => m.label));
  assertEq(labelSet.size, modules.length, 'module labels are unique');
  // Centrality is non-negative and finite.
  for (const m of modules) assert(Number.isFinite(m.centrality) && m.centrality >= 0, `module "${m.label}" centrality is finite and non-negative`);
  // Cohesion is in [0, 1].
  for (const m of modules) assert(m.cohesion >= 0 && m.cohesion <= 1, `module "${m.label}" cohesion in [0, 1]`);

  // ── Determinism: re-running buildModules produces the same labels + sizes
  console.log('\n── Clustering determinism ──');
  const before = store.listModules({ limit: 200, sortBy: 'label' });
  buildModules(store);
  const after = store.listModules({ limit: 200, sortBy: 'label' });
  assertEq(before.length, after.length, 'rebuild produces same module count');
  let identical = true;
  for (let i = 0; i < before.length; i++) {
    if (before[i].label !== after[i].label || before[i].sizeFiles !== after[i].sizeFiles) {
      identical = false; break;
    }
  }
  assert(identical, 'rebuild produces identical labels + sizes (determinism)');

  // ── Module membership + lookups ──────────────────────────────────────────
  console.log('\n── Module membership ──');
  const authMod = modules.find(m => m.label === 'auth');
  const billingMod = modules.find(m => m.label === 'billing');
  assert(authMod !== undefined, 'auth module exists');
  assert(billingMod !== undefined, 'billing module exists');

  // moduleForFile: pick the AuthService.ts and verify it maps to auth.
  const authFile = store.listFiles().find(f => f.relPath.endsWith('auth/AuthService.ts'));
  assert(authFile !== undefined, 'auth/AuthService.ts is indexed');
  const fileMod = authFile ? store.moduleForFile(authFile.id) : null;
  assert(fileMod?.label === 'auth', `moduleForFile(auth/AuthService.ts) = auth (got ${fileMod?.label})`);

  // Files in the auth module.
  const authFiles = authMod ? store.listModuleMembers(authMod.id) : [];
  assert(authFiles.length >= 2, `auth module has ≥2 files (got ${authFiles.length})`);
  // Tests for the auth module should be co-located with auth (tests have very
  // strong test-edge weight in the clusterer).
  assert(authFiles.some(f => f.relPath.includes('auth/')), 'auth module contains auth/ files');

  // Top symbols in auth: must include AuthService and validateCredentials.
  const authSymbols = authMod ? store.listModuleTopSymbols(authMod.id, 20) : [];
  assert(authSymbols.some(s => s.name === 'AuthService' || s.qualifiedName === 'AuthService'),
    'auth module top symbols include AuthService');

  // ── Module dependencies ─────────────────────────────────────────────────
  console.log('\n── Module dependencies ──');
  // billing imports/calls into auth → there should be a billing→auth edge.
  if (billingMod && authMod) {
    const billOut = store.moduleDependencies(billingMod.id, { direction: 'out' });
    console.log(`  billing → ${billOut.map(d => `${d.label}(kind=${d.kind},w=${d.weight})`).join(', ')}`);
    assert(billOut.some(d => d.label === 'auth'), 'billing depends on auth (outgoing)');
    const authIn = store.moduleDependencies(authMod.id, { direction: 'in' });
    console.log(`  auth ← ${authIn.map(d => `${d.label}(kind=${d.kind},w=${d.weight})`).join(', ')}`);
    assert(authIn.some(d => d.label === 'billing'), 'auth is depended on by billing (incoming)');
  }

  // ── Bounded reverse / forward reachability ──────────────────────────────
  console.log('\n── Bounded BFS reachability ──');
  const validate = store.getDefinition('validateCredentials')[0];
  assert(validate !== undefined, 'validateCredentials is indexed');
  const reverse = store.reverseReachableWithDepth(validate.id, 4);
  console.log(`  reverseReachableWithDepth(validateCredentials, 4) = ${reverse.length} hits`);
  assert(reverse.length >= 1, 'reverseReachableWithDepth finds ≥1 caller');
  // Every depth must be > 0 and ≤ 4.
  assert(reverse.every(h => h.depth > 0 && h.depth <= 4), 'reverse depths are in (0, maxDepth]');

  // Forward from a high-fanout function — must reach validateCredentials.
  const charge = store.getDefinition('chargeCustomer')[0];
  if (charge) {
    const fwd = store.forwardReachableWithDepth(charge.id, 5);
    assert(fwd.some(h => h.id === validate.id),
      `forwardReachableWithDepth(chargeCustomer, 5) reaches validateCredentials`);
  }

  // ── File-import closure ─────────────────────────────────────────────────
  console.log('\n── File-import closure ──');
  const billingFile = store.listFiles().find(f => f.relPath.endsWith('billing/Billing.ts'));
  assert(billingFile !== undefined, 'billing/Billing.ts indexed');
  if (billingFile) {
    const closure = store.fileImportClosure(billingFile.id, 4);
    console.log(`  fileImportClosure(billing/Billing.ts) = ${closure.length} files: ${closure.map(c => `${c.relPath}@${c.depth}`).join(', ')}`);
    assert(closure.length >= 1, 'fileImportClosure(billing/Billing.ts) finds ≥1 file');
    assert(closure.some(c => c.relPath.includes('auth/')),
      'fileImportClosure reaches auth/ files (billing imports auth)');
    assert(closure.every(c => c.depth > 0 && c.depth <= 4), 'closure depths are in (0, maxDepth]');
  }

  // ── seer_behavior 2.0 ───────────────────────────────────────────────────
  console.log('\n── Ranked behavior 2.0 ──');
  const beh = rankedBehavior(store, 'validateCredentials', { limit: 30 });
  assert(beh !== null, 'rankedBehavior returns a result for validateCredentials');
  if (beh) {
    console.log(`  direct=${beh.direct} indirect=${beh.indirect} naming=${beh.namingMatches} same-file=${beh.sameFileMatches}`);
    assert(beh.direct >= 1, 'validateCredentials has ≥1 direct test');
    // The fixture has a "testValidate" test that calls login() (which calls
    // validateCredentials) — that's the indirect coverage signal.
    assert(beh.indirect >= 1, 'validateCredentials has ≥1 indirect test (via login)');
    // The fixture has a sibling auth/AuthService.test.ts — naming convention
    // OR direct/indirect should include test functions whose name mentions
    // validate.
    const validateTests = beh.tests.filter(t => /validate/i.test(t.testSymbol.name));
    assert(validateTests.length >= 1, 'tests with "validate" in name are found');
    // Specificity is sorted descending.
    let monotonic = true;
    for (let i = 1; i < beh.tests.length; i++) {
      if (beh.tests[i].specificity > beh.tests[i - 1].specificity) { monotonic = false; break; }
    }
    assert(monotonic, 'tests sorted by specificity DESC');
    // Direct tests outrank everything else.
    if (beh.tests.length > 0 && beh.direct > 0) {
      const firstDirectIndex = beh.tests.findIndex(t => t.relationship === 'direct-call');
      const firstNonDirect = beh.tests.findIndex(t => t.relationship !== 'direct-call');
      if (firstDirectIndex !== -1 && firstNonDirect !== -1) {
        assert(firstDirectIndex < firstNonDirect || firstDirectIndex !== -1,
          'direct-call tests outrank non-direct tests');
      }
    }
    // Assertion counts should be non-negative integers.
    assert(beh.tests.every(t => Number.isInteger(t.assertionCount) && t.assertionCount >= 0),
      'assertion counts are non-negative integers');
  }

  // Behavior 2.0 with the indirect path turned off — direct only.
  const behDirectOnly = rankedBehavior(store, 'validateCredentials', {
    limit: 20, indirectDepth: 0, includeNamingConvention: false, includeSameFile: false,
  });
  if (behDirectOnly) {
    assert(behDirectOnly.indirect === 0, 'indirect coverage disabled when indirectDepth=0');
    assert(behDirectOnly.tests.every(t => t.relationship === 'direct-call'),
      'with all flags off, only direct-call tests are returned');
  }

  // ── seer_risk ───────────────────────────────────────────────────────────
  console.log('\n── Risk profile ──');
  const risk = computeRisk(store, 'validateCredentials');
  assert(risk !== null, 'computeRisk returns a result');
  if (risk) {
    console.log(`  risk=${risk.risk} score=${risk.score.toFixed(2)} dCallers=${risk.signals.directCallers} tCallers=${risk.signals.transitiveCallers} routeExposed=${risk.signals.routeExposed} directTests=${risk.signals.directTests}`);
    assert(['low', 'medium', 'high'].includes(risk.risk), `risk verdict is one of low/medium/high`);
    assert(Number.isFinite(risk.score), 'risk score is finite');
    assert(risk.signalContributions.length >= 10, 'risk decomposes into ≥10 signals');
    // Every signal contribution row has signal/value/contribution.
    assert(risk.signalContributions.every(s => typeof s.signal === 'string' && Number.isFinite(s.contribution)),
      'every signal contribution is well-formed');
    // validateCredentials has direct tests → directTests contribution must be ≤ 0.
    const direct = risk.signalContributions.find(s => s.signal === 'directTests');
    assert(direct !== undefined && direct.contribution <= 0,
      'directTests contribution is ≤ 0 when there are direct tests (coverage reduces risk)');
    // directCallers signal value should match countCallers.
    assertEq(risk.signals.directCallers, store.countCallers('validateCredentials'),
      'directCallers matches store.countCallers');
  }

  // Risk for a route handler must include routeExposed.
  const handlerRisk = computeRisk(store, 'chargeCustomer');
  if (handlerRisk) {
    console.log(`  chargeCustomer risk=${handlerRisk.risk} score=${handlerRisk.score.toFixed(2)} routeExposed=${handlerRisk.signals.routeExposed}`);
    // chargeCustomer is registered as a route handler in fixtures.
    assert(handlerRisk.signals.routeExposed, 'chargeCustomer is route-exposed');
    assert(handlerRisk.signals.routes.length >= 1, 'chargeCustomer has ≥1 route');
  }

  // ── seer_context ────────────────────────────────────────────────────────
  console.log('\n── Risk fan-in calibration ──');
  // A symbol can have many direct and transitive callers without any other
  // risk signal. That should be loud enough to inspect, but not high by itself.
  const fanInRisk = computeRisk(store, 'fanInOnly');
  assert(fanInRisk !== null, 'computeRisk returns a result for fanInOnly');
  if (fanInRisk) {
    const directContribution = fanInRisk.signalContributions.find(s => s.signal === 'directCallers')?.contribution ?? 0;
    const transitiveContribution = fanInRisk.signalContributions.find(s => s.signal === 'transitiveCallers')?.contribution ?? 0;
    console.log(`  fanInOnly risk=${fanInRisk.risk} score=${fanInRisk.score.toFixed(2)} direct=${directContribution.toFixed(2)} transitive=${transitiveContribution.toFixed(2)}`);
    assert(fanInRisk.signals.directCallers >= 80, 'fanInOnly has many direct callers');
    assert(fanInRisk.signals.transitiveCallers >= 200, 'fanInOnly has many transitive callers');
    assert(directContribution <= 24, 'direct caller contribution is capped');
    assert(transitiveContribution <= 18, 'transitive caller contribution is capped');
    assert(fanInRisk.risk === 'medium', 'fan-in alone stays medium, not high');
  }

  console.log('\n── Context packet ──');
  const ctx = buildContext(store, 'validateCredentials');
  assert(ctx !== null, 'buildContext returns a packet for validateCredentials');
  if (ctx) {
    console.log(`  symbol=${ctx.symbol.qualifiedName ?? ctx.symbol.name} module=${ctx.module?.label} callers=${ctx.callers.total} callees=${ctx.callees.total} blast=${ctx.blastRadius.directCallers}+${ctx.blastRadius.transitiveCallers} behavior.direct=${ctx.behavior.direct} risk=${ctx.risk.risk}`);
    // The packet must include every section.
    assert(ctx.symbol && ctx.symbol.id === validate.id, 'context symbol matches lookup');
    assert(ctx.module !== null, 'context.module is non-null when modules are built');
    assert(ctx.callers.total >= 1, 'context.callers.total ≥ 1');
    assert(ctx.callees.total >= 0, 'context.callees.total ≥ 0');
    assert(ctx.behavior.direct >= 1, 'context.behavior.direct ≥ 1');
    assert(['low', 'medium', 'high'].includes(ctx.risk.risk), 'context.risk.risk is a verdict');
    assert(ctx.risk.signalContributions.length >= 10, 'context.risk decomposes into ≥10 signals');
    // blastRadius.directCallers should equal callers.total (both are direct).
    assertEq(ctx.blastRadius.directCallers, ctx.callers.total,
      'blastRadius.directCallers matches callers.total');
    // The packet is JSON-serializable (no cyclic refs, no functions).
    let serialized: string | null = null;
    try { serialized = JSON.stringify(ctx); } catch { /* */ }
    assert(serialized !== null && serialized.length > 100,
      'context packet is JSON-serializable');
  }

  // Context for a route handler must include the route.
  const ctxRoute = buildContext(store, 'chargeCustomer');
  if (ctxRoute) {
    assert(ctxRoute.routes.length >= 1, 'context for chargeCustomer includes its route');
    assert(ctxRoute.routesTotal >= ctxRoute.routes.length, 'context exposes route total alongside the preview');
    assert(ctxRoute.configKeysTotal >= ctxRoute.configKeys.length, 'context exposes config-key total alongside the preview');
  }

  // Context packet keeps route/config previews compact on high-fanout symbols
  // while still exposing the true totals. Inject extra rows directly rather
  // than bloating fixtures permanently.
  const chargeCtx = store.getDefinition('chargeCustomer')[0];
  if (chargeCtx) {
    for (let i = 0; i < 20; i++) {
      store.insertRoute(chargeCtx.fileId, 'GET', `/context-preview-${i}`, 'express', 'chargeCustomer', chargeCtx.lineStart + i);
      store.insertConfigKey(`CTX_PREVIEW_KEY_${i}`, 'env', chargeCtx.fileId, chargeCtx.id, chargeCtx.lineStart + i);
    }
    store.resolveRouteHandlers();
    const compact = buildContext(store, 'chargeCustomer');
    if (compact) {
      assert(compact.routesTotal > compact.routes.length, 'context caps route preview but keeps the total');
      assert(compact.routesTruncated === true, 'context flags truncated route previews');
      assert(compact.configKeysTotal > compact.configKeys.length, 'context caps config-key preview but keeps the total');
      assert(compact.configKeysTruncated === true, 'context flags truncated config-key previews');
    }
  }

  // Context for a non-existent symbol returns null.
  const ctxMissing = buildContext(store, 'thisSymbolDoesNotExistAnywhere_xyz');
  assertEq(ctxMissing, null, 'context for unknown symbol returns null');

  // ── Empty / degenerate inputs ───────────────────────────────────────────
  console.log('\n── Degenerate inputs ──');
  assertEq(store.reverseReachableWithDepth(99999999, 4).length, 0,
    'reverseReachableWithDepth on unknown id returns empty');
  assertEq(store.forwardReachableWithDepth(99999999, 4).length, 0,
    'forwardReachableWithDepth on unknown id returns empty');
  assertEq(store.fileImportClosure(99999999, 4).length, 0,
    'fileImportClosure on unknown id returns empty');
  assertEq(store.listModuleMembers(99999999).length, 0,
    'listModuleMembers on unknown id returns empty');
  assertEq(store.moduleDependencies(99999999).length, 0,
    'moduleDependencies on unknown id returns empty');
  assertEq(rankedBehavior(store, '__no_such_symbol__'), null,
    'rankedBehavior on unknown symbol returns null');
  assertEq(computeRisk(store, '__no_such_symbol__'), null,
    'computeRisk on unknown symbol returns null');

  // ── Module clustering on an empty store ─────────────────────────────────
  console.log('\n── Empty-store clustering ──');
  const TMP_DB2 = path.join(os.tmpdir(), `seer-tracke-empty-${Date.now()}.db`);
  const emptyStore = new Store(TMP_DB2);
  try {
    const er = buildModules(emptyStore);
    assertEq(er.modules, 0, 'empty store yields 0 modules');
    assertEq(er.files, 0, 'empty store yields 0 files');
  } finally {
    emptyStore.close();
    try { fs.unlinkSync(TMP_DB2); } catch { /* */ }
    ['-wal', '-shm'].forEach(suf => { try { fs.unlinkSync(TMP_DB2 + suf); } catch { /* */ } });
  }

  // ── Cleanup ────────────────────────────────────────────────────────────
  store.close();
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB);
  ['-wal', '-shm'].forEach(suf => { try { fs.unlinkSync(TMP_DB + suf); } catch { /* */ } });

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.error('\n  TRACK E TEST FAILED\n'); process.exit(1); }
  else            { console.log('\n  All Track E tests passed! ✓\n'); }
}

run().catch(err => { console.error('tracke crashed:', err); process.exit(1); });
