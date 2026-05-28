/**
 * Smoke test — run with: npm test  (or: npx tsx tests/smoke.ts)
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { Indexer } from '../src/indexer/index';
import { Store } from '../src/db/store';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const TMP_DB = path.join(os.tmpdir(), `strata-smoke-${Date.now()}.db`);

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

function assertGte(actual: number, min: number, label: string): void {
  assert(actual >= min, `${label}: ${actual} >= ${min}`);
}

async function run(): Promise<void> {
  console.log('\nStrata Smoke Test');
  console.log('=================\n');

  const store = new Store(TMP_DB);
  const indexer = new Indexer(store);

  console.log(`Indexing ${FIXTURES_DIR}...\n`);
  const result = await indexer.indexDirectory(FIXTURES_DIR, { verbose: true });

  console.log('\n── Indexing results ──────────────────────────────────────────\n');
  assertGte(result.filesIndexed, 5, 'indexed 5+ fixture files');
  assertGte(result.symbols, 20, 'extracted 20+ symbols');
  assertGte(result.edges, 5, 'found 5+ call edges');
  assertGte(result.resolvedEdges, 1, 'resolved 1+ edges');

  // ── Per-language checks ──────────────────────────────────────────────────────
  console.log('\n── Per-language checks ───────────────────────────────────────\n');
  const stats = store.getStats();
  assert('python'     in stats.languages, 'Python indexed');
  assert('typescript' in stats.languages, 'TypeScript indexed');
  assert('go'         in stats.languages, 'Go indexed');
  assert('java'       in stats.languages, 'Java indexed');
  assert('rust'       in stats.languages, 'Rust indexed');
  assert('c'          in stats.languages, 'C indexed');
  assert('cpp'        in stats.languages, 'C++ indexed');
  assert('csharp'     in stats.languages, 'C# indexed');

  // ── Symbol queries ───────────────────────────────────────────────────────────
  console.log('\n── Symbol queries ────────────────────────────────────────────\n');

  const pyClass = store.findSymbols('PaymentService');
  assert(pyClass.length >= 1, `findSymbols('PaymentService') → ${pyClass.length}`);

  const validateFn = store.findSymbols('validate_amount');
  assert(validateFn.length >= 1, `findSymbols('validate_amount') → ${validateFn.length}`);

  const authSvc = store.findSymbols('AuthService');
  assert(authSvc.length >= 1, `findSymbols('AuthService') → ${authSvc.length}`);

  const userRepo = store.findSymbols('UserRepository');
  assert(userRepo.length >= 1, `findSymbols('UserRepository') → ${userRepo.length}`);

  const orderProc = store.findSymbols('OrderProcessor');
  assert(orderProc.length >= 1, `findSymbols('OrderProcessor') → ${orderProc.length}`);

  // ── Caller / callee queries ──────────────────────────────────────────────────
  console.log('\n── Call-graph queries ────────────────────────────────────────\n');

  const callers = store.findCallers('validate_amount');
  console.log(`  findCallers('validate_amount'): ${callers.length} caller(s)`);
  for (const c of callers) {
    console.log(`    ${c.callerName} (${c.callerKind}) in ${path.basename(c.callerFile)}`);
  }
  assert(callers.length >= 1, 'validate_amount has ≥1 caller');

  const callees = store.findCallees('process_payment');
  console.log(`\n  findCallees('process_payment'): ${callees.length} callee(s)`);
  for (const c of callees) {
    const loc = c.calleeFile ? path.basename(c.calleeFile) : 'unresolved';
    console.log(`    → ${c.calleeName} (${loc})`);
  }
  assert(callees.length >= 1, 'process_payment has ≥1 callee');

  // ── Fix B: `new X()` constructor calls ───────────────────────────────────────
  console.log('\n── new_expression tracking ──────────────────────────────────\n');

  const authCtorCallers = store.findCallers('AuthService');
  console.log(`  findCallers('AuthService'): ${authCtorCallers.length} caller(s)`);
  for (const c of authCtorCallers) {
    console.log(`    ${c.callerName} (${c.callerKind}) in ${path.basename(c.callerFile)}`);
  }
  assert(
    authCtorCallers.some(c => c.callerName === 'createAuthService'),
    'createAuthService is recorded as caller of AuthService (new_expression tracked)',
  );

  // ── Fix C: qualified names disambiguate colliding method names ───────────────
  console.log('\n── Qualified names / method collisions ──────────────────────\n');

  const runSyms = store.findSymbols('run').filter(s => s.kind === 'method');
  console.log(`  findSymbols('run') methods: ${runSyms.length}`);
  for (const s of runSyms) {
    console.log(`    ${s.name}  qualified=${s.qualifiedName}  in ${path.basename(s.filePath)}`);
  }
  const collisionMethods = runSyms.filter(s => s.filePath.endsWith('collisions.ts'));
  assert(collisionMethods.length === 2, 'collisions.ts has exactly 2 `run` methods');

  const qualified = collisionMethods.map(s => s.qualifiedName).sort();
  assert(
    qualified[0] === 'Alpha.run' && qualified[1] === 'Beta.run',
    `qualified names are 'Alpha.run' and 'Beta.run' (got ${JSON.stringify(qualified)})`,
  );

  // Rust impl-block context should also be reflected in qualified names
  const loginSyms = store.findSymbols('login').filter(s => s.filePath.endsWith('sample.rs'));
  assert(
    loginSyms.some(s => s.qualifiedName === 'AuthService.login'),
    `Rust impl method qualified as 'AuthService.login' (got ${loginSyms.map(s => s.qualifiedName).join(', ')})`,
  );

  // Call-graph attribution: alphaOnly() must be attributed to Alpha.run, not Beta.run.
  // betaOnly() must be attributed to Beta.run, not Alpha.run.
  // Bug: walker used defStack.last (short name), so both 'run' methods shared one symbolIdMap entry.
  const alphaOnlyCallers = store.findCallers('alphaOnly');
  console.log(`  findCallers('alphaOnly'): ${alphaOnlyCallers.length}`);
  for (const c of alphaOnlyCallers) {
    console.log(`    ${c.callerQualifiedName ?? c.callerName} in ${path.basename(c.callerFile)}`);
  }
  assert(
    alphaOnlyCallers.some(c => c.callerQualifiedName === 'Alpha.run'),
    `alphaOnly() attributed to Alpha.run (got ${alphaOnlyCallers.map(c => c.callerQualifiedName).join(', ')})`,
  );
  assert(
    !alphaOnlyCallers.some(c => c.callerQualifiedName === 'Beta.run'),
    'alphaOnly() not attributed to Beta.run',
  );

  const betaOnlyCallers = store.findCallers('betaOnly');
  console.log(`  findCallers('betaOnly'): ${betaOnlyCallers.length}`);
  for (const c of betaOnlyCallers) {
    console.log(`    ${c.callerQualifiedName ?? c.callerName} in ${path.basename(c.callerFile)}`);
  }
  assert(
    betaOnlyCallers.some(c => c.callerQualifiedName === 'Beta.run'),
    `betaOnly() attributed to Beta.run (got ${betaOnlyCallers.map(c => c.callerQualifiedName).join(', ')})`,
  );
  assert(
    !betaOnlyCallers.some(c => c.callerQualifiedName === 'Alpha.run'),
    'betaOnly() not attributed to Alpha.run',
  );

  // ── Overload disambiguation ───────────────────────────────────────────────────
  console.log('\n── Overload disambiguation ──────────────────────────────────\n');

  // In overloads.java: Overload.run(int) calls javaOnly1, Overload.run(String) calls javaOnly2.
  // Both have qualified name Overload.run before the fix; the second becomes Overload.run#1 after.
  const javaOnly1Callers = store.findCallers('javaOnly1');
  console.log(`  findCallers('javaOnly1'): ${javaOnly1Callers.length}`);
  for (const c of javaOnly1Callers) {
    console.log(`    ${c.callerQualifiedName ?? c.callerName} in ${path.basename(c.callerFile)}`);
  }
  assert(
    javaOnly1Callers.some(c => c.callerQualifiedName === 'Overload.run'),
    `javaOnly1 attributed to Overload.run (first overload) (got ${javaOnly1Callers.map(c => c.callerQualifiedName).join(', ')})`,
  );
  assert(
    !javaOnly1Callers.some(c => c.callerQualifiedName === 'Overload.run#1'),
    'javaOnly1 not attributed to Overload.run#1',
  );

  const javaOnly2Callers = store.findCallers('javaOnly2');
  console.log(`  findCallers('javaOnly2'): ${javaOnly2Callers.length}`);
  for (const c of javaOnly2Callers) {
    console.log(`    ${c.callerQualifiedName ?? c.callerName} in ${path.basename(c.callerFile)}`);
  }
  assert(
    javaOnly2Callers.some(c => c.callerQualifiedName === 'Overload.run#1'),
    `javaOnly2 attributed to Overload.run#1 (second overload) (got ${javaOnly2Callers.map(c => c.callerQualifiedName).join(', ')})`,
  );
  assert(
    !javaOnly2Callers.some(c => c.callerQualifiedName === 'Overload.run'),
    'javaOnly2 not attributed to Overload.run',
  );

  // ── Fix A: scope-aware (import-based) resolution ─────────────────────────────
  console.log('\n── Scope-aware edge resolution ──────────────────────────────\n');

  const callCheckCallees = store.findCallees('callCheck');
  console.log(`  findCallees('callCheck'): ${callCheckCallees.length} callee(s)`);
  for (const c of callCheckCallees) {
    console.log(`    → ${c.calleeName}  in ${c.calleeFile ? path.basename(c.calleeFile) : 'unresolved'}`);
  }
  const checkCallee = callCheckCallees.find(c => c.calleeName === 'check');
  assert(checkCallee !== undefined, "callCheck has a 'check' callee");
  assert(
    checkCallee?.calleeFile?.endsWith('remote_helper.ts') ?? false,
    `'check' resolved to remote_helper.ts, not local_helper.ts (got ${checkCallee?.calleeFile})`,
  );

  // ── Resolution breakdown summary ─────────────────────────────────────────────
  console.log('\n  Edge resolution breakdown:');
  console.log(`    same-file: ${result.edgeResolution.sameFile}`);
  console.log(`    imported:  ${result.edgeResolution.imported}`);
  console.log(`    global:    ${result.edgeResolution.global}`);
  console.log(`    imports resolved to files: ${result.resolvedImports}`);
  assert(result.edgeResolution.imported >= 1, 'at least one edge resolved via import scope');
  assert(result.resolvedImports >= 1, 'at least one file_import resolved to a file');

  // ── C source files ──────────────────────────────────────────────────────────
  console.log('\n── C source files ───────────────────────────────────────\n');

  const cEntry = store.findSymbols('c_entrypoint');
  assert(
    cEntry.some(s => s.filePath.endsWith('sample.c')),
    'C .c file parsed — c_entrypoint symbol present',
  );

  const cHelperCallers = store.findCallers('c_helper');
  console.log(`  findCallers('c_helper'): ${cHelperCallers.length}`);
  for (const c of cHelperCallers) {
    console.log(`    ${c.callerName} in ${path.basename(c.callerFile)}`);
  }
  assert(
    cHelperCallers.some(c => c.callerName === 'c_entrypoint'),
    'C call c_helper() attributed to c_entrypoint',
  );

  // ── C++ (Unreal-style) ───────────────────────────────────────────────────────
  console.log('\n── C++ (Unreal-style) ───────────────────────────────────────\n');

  const pickupClass = store.findSymbols('APickupItem');
  assert(
    pickupClass.some(s => s.kind === 'class'),
    'C++ class APickupItem extracted',
  );

  // Out-of-line method definition `APickupItem::OnPickedUp` should be picked up
  const onPickedUp = store.findSymbols('OnPickedUp');
  assert(
    onPickedUp.length >= 1,
    `C++ out-of-line method 'OnPickedUp' extracted (got ${onPickedUp.length})`,
  );

  // PlayPickupSound is called twice (BeginPlay + OnPickedUp) — should have ≥2 callers
  const playSoundCallers = store.findCallers('PlayPickupSound');
  console.log(`  findCallers('PlayPickupSound'): ${playSoundCallers.length}`);
  for (const c of playSoundCallers) {
    console.log(`    ${c.callerName} (${c.callerKind})`);
  }
  assert(
    playSoundCallers.length >= 2,
    `PlayPickupSound has ≥2 callers (BeginPlay + OnPickedUp) — got ${playSoundCallers.length}`,
  );

  // qualified_identifier call: `UGameplayStatics::PlaySound2D` — the callee
  // name should be `PlaySound2D`, attributed to the enclosing method
  const playSound2DCallers = store.findCallers('PlaySound2D');
  assert(
    playSound2DCallers.some(c => c.callerName === 'PlayPickupSound'),
    'qualified call UGameplayStatics::PlaySound2D attributed to PlayPickupSound',
  );

  // ── C# (Godot-style) ─────────────────────────────────────────────────────────
  console.log('\n── C# (Godot-style) ─────────────────────────────────────────\n');

  const playerClass = store.findSymbols('Player').filter(s => s.kind === 'class');
  assert(playerClass.length >= 1, 'C# Player class extracted');

  // `new InventoryService()` inside _Ready should be tracked as a call edge
  const invSvcCallers = store.findCallers('InventoryService');
  console.log(`  findCallers('InventoryService'): ${invSvcCallers.length}`);
  for (const c of invSvcCallers) {
    console.log(`    ${c.callerName} (${c.callerKind})`);
  }
  assert(
    invSvcCallers.some(c => c.callerName === '_Ready'),
    'C# `new InventoryService()` recorded as caller from _Ready',
  );

  // Cross-class method call: ResetState calls inventory.Clear()
  const clearCallers = store.findCallers('Clear');
  assert(
    clearCallers.some(c => c.callerName === 'ResetState'),
    'C# member access call Clear() attributed to ResetState',
  );

  // ── React (TSX with JSX) — Counter.tsx ───────────────────────────────────────
  console.log('\n── React (TSX with JSX) ─────────────────────────────────────\n');

  // If TSX grammar routing is broken, the file silently fails to parse and
  // these symbols won't exist at all.
  const counterFn = store.findSymbols('Counter').filter(
    s => s.filePath.endsWith('Counter.tsx'),
  );
  assert(counterFn.length >= 1, 'TSX file parsed — Counter symbol present');

  const dashboardFn = store.findSymbols('Dashboard').filter(
    s => s.filePath.endsWith('Counter.tsx'),
  );
  assert(dashboardFn.length >= 1, 'TSX file parsed — Dashboard symbol present');

  // formatLabel called inside the JSX body — should still be tracked as a call
  const formatLabelCallers = store.findCallers('formatLabel');
  console.log(`  findCallers('formatLabel'): ${formatLabelCallers.length}`);
  for (const c of formatLabelCallers) {
    console.log(`    ${c.callerName} in ${path.basename(c.callerFile)}`);
  }
  assert(
    formatLabelCallers.some(c => c.callerName === 'Counter'),
    'formatLabel call inside JSX attributed to Counter',
  );

  // ── PageRank ─────────────────────────────────────────────────────────────────
  console.log('\n── PageRank ──────────────────────────────────────────────────\n');

  const topSyms = store.getTopSymbols(10);
  console.log('  Top 10 symbols by PageRank:');
  for (const s of topSyms) {
    console.log(`    ${s.pagerank.toFixed(5)}  ${s.name.padEnd(28)} (${s.kind})`);
  }

  const pagerankValues = topSyms.map(s => s.pagerank);
  const hasVariance = new Set(pagerankValues.map(v => v.toFixed(5))).size > 1;
  assert(hasVariance, 'PageRank values differ between symbols');
  assertGte(topSyms.length, 5, '5+ symbols ranked');

  // First-run pagerank MUST have been computed (we just built the graph).
  assert(result.pagerankRecomputed === true, 'fresh index recomputed PageRank');

  // ── findCallers limit + countCallers ─────────────────────────────────────────
  // Regression net for the perf fix: pushing LIMIT into SQL must produce a
  // strict subset of the unbounded result, and countCallers must agree with
  // the unbounded length. Fixtures don't have 100k-fan-in symbols, but the
  // semantic checks here catch the contract; the high-fan-in perf is verified
  // out-of-band against the scale-test DBs.
  console.log('\n── findCallers limit + countCallers ────────────────────────\n');

  const allClearCallers = store.findCallers('Clear');
  const clearCount = store.countCallers('Clear');
  console.log(`  countCallers('Clear') = ${clearCount}, findCallers length = ${allClearCallers.length}`);
  assert(
    clearCount === allClearCallers.length,
    `countCallers matches unbounded findCallers (${clearCount} vs ${allClearCallers.length})`,
  );
  if (allClearCallers.length >= 1) {
    const limited = store.findCallers('Clear', 1);
    assert(limited.length === 1, `findCallers respects LIMIT=1 (got ${limited.length})`);
  }

  // ── Cached re-index: PageRank must be skipped ────────────────────────────────
  // The CLI bug we just fixed printed "✓ PageRank computed" even when the
  // indexer correctly logged "Skipping PageRank (graph unchanged)". Lock in
  // the underlying signal: re-indexing the same tree with no changes must
  // report `pagerankRecomputed === false`.
  console.log('\n── Cached re-index PageRank reuse ───────────────────────────\n');
  const second = await indexer.indexDirectory(FIXTURES_DIR, { quiet: true });
  console.log(`  second-run filesReusedFromCache=${second.filesReusedFromCache}, pagerankRecomputed=${second.pagerankRecomputed}`);
  assert(
    second.filesReusedFromCache === result.filesIndexed,
    `second run reused every fresh-indexed file (${second.filesReusedFromCache} vs ${result.filesIndexed})`,
  );
  assert(
    second.pagerankRecomputed === false,
    'cached re-index skips PageRank (graph unchanged)',
  );

  // ── Cleanup ──────────────────────────────────────────────────────────────────
  store.close();
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB);

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.error('\n  SMOKE TEST FAILED\n');
    process.exit(1);
  } else {
    console.log('\n  All smoke tests passed! ✓\n');
  }
}

run().catch(err => {
  console.error('Smoke test threw:', err);
  process.exit(1);
});
