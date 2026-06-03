/**
 * Regression tests for the Godot-audit bugs (2026-06-02). Each section
 * reproduces the original failure against the fixed code so a regression trips
 * immediately.
 *
 *   1. C++/Rust `::` qualified-name lookup normalization: `Node::add_child`
 *      must resolve the stored `Node.add_child` across definition / search /
 *      callers / callees (Store + ftsQuery).
 *   2. seer_callees resolves a qualified caller via getDefinition→findCalleesById
 *      (the name-keyed `findCallees` matched only the short name, so a
 *      qualified `Node.add_child` returned nothing).
 *   3. seer_batch / seer_trace re-validate delegated args (a missing required
 *      field used to surface as an opaque SQLite binding error); seer_definition
 *      accepts `symbol` as an alias for `name`.
 *   4. Behavior surfaces clearly-labeled HEURISTIC name-call evidence for
 *      type-unresolved C++ member calls in tests (receiver type is unknowable
 *      from syntax, so the precise pass misses them).
 *   5. Status clarity: context / preflight expose historyIndex.built; behavior
 *      distinguishes graph-linked / tests-indexed-no-link / no-indexed-tests /
 *      test-indexing-unavailable.
 *
 * Run with: npx tsx tests/godot-fixes.ts   (build dist/ first for the MCP part)
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import { Store, symbolNameVariants, ftsQuery } from '../src/db/store';
import { Indexer } from '../src/indexer/index';
import { rankedBehavior } from '../src/indexer/behavior';
import { computeRisk } from '../src/indexer/risk';
import { buildContext } from '../src/indexer/context';
import { preflight } from '../src/indexer/preflight';

let passed = 0;
let failed = 0;
const assert = (cond: boolean, msg: string, extra?: unknown): void => {
  if (cond) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}` + (extra !== undefined ? `  ::  ${JSON.stringify(extra).slice(0, 240)}` : '')); failed++; }
};

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'dist/cli/index.js');

/**
 * A C++ workspace that reproduces the Godot scenario:
 *   - `Node::add_child` defined out-of-line in node.cpp, calling two helpers.
 *   - `Node::orphan_method` that no test references (for tests-indexed-no-link).
 *   - tests/test_node.cpp where `TestNode` calls `node->add_child(...)`. A LOCAL
 *     `Harness::add_child` in the same file means same-file edge resolution
 *     binds the call AWAY from Node.add_child — exactly the receiver-type gap
 *     that makes the precise pass miss it, leaving only the heuristic. (Plus a
 *     small TS pair so the heuristic's C/C++ gating can be checked.)
 */
function writeCppFixture(dir: string, opts: { withTests: boolean }): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, '.seer'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node.h'), [
    '#pragma once',
    'class Node {',
    'public:',
    '  void add_child(Node *child);',
    '  void reparent(Node *child);',
    '  void orphan_method();',
    '};',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'node.cpp'), [
    '#include "node.h"',
    'static void validate_child(Node *child) { (void)child; }',
    'static void attach_internal(Node *child) { (void)child; }',
    'void Node::add_child(Node *child) {',
    '  validate_child(child);',
    '  attach_internal(child);',
    '}',
    '// Same-file caller: the bare `add_child(child)` resolves to Node::add_child',
    '// (edge to_id = the method, to_name = the SHORT `add_child`). The legacy name',
    '// path keyed on to_name=`Node.add_child` misses it; resolve-first finds it.',
    'void Node::reparent(Node *child) {',
    '  add_child(child);',
    '}',
    'void Node::orphan_method() {',
    '  validate_child(nullptr);',
    '}',
    '// A FREE function (no owner scope). The member-gate must keep the C/C++',
    '// heuristic from firing for it even though a test calls a same-named func.',
    'void shared_util(int x) { (void)x; }',
    '',
  ].join('\n'));
  // A SECOND non-test class that also defines `add_child`. This makes the bare
  // short name `add_child` genuinely ambiguous among NON-test definitions
  // (Node + Tree), which is what the nameAmbiguity hint warns about. Uncalled,
  // so it does not disturb the caller-count / heuristic assertions above.
  fs.writeFileSync(path.join(dir, 'tree.h'), [
    '#pragma once',
    'class Tree {',
    'public:',
    '  void add_child(int idx);',
    '};',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'tree.cpp'), [
    '#include "tree.h"',
    'void Tree::add_child(int idx) { (void)idx; }',
    '',
  ].join('\n'));
  if (opts.withTests) {
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tests', 'test_node.cpp'), [
      '#include "node.h"',
      '#include <cassert>',
      'struct Harness {',
      '  void add_child(int n) { (void)n; }',  // local same-file add_child
      '};',
      'void TestNode() {',
      '  Harness h;',
      '  Node *node = new Node();',
      '  node->add_child(node);',  // resolves same-file → Harness.add_child, NOT Node.add_child
      '  h.add_child(1);',
      '  assert(node != nullptr);',
      '}',
      '// Local free function named like node.cpp shared_util. Same-file resolution',
      '// binds the TestUtil call here (to_id != the node.cpp symbol), so a heuristic',
      '// candidate EXISTS for node.cpp shared_util — but the member-gate must reject',
      '// it because that target is a free function, not a method.',
      'static void shared_util() {}',
      'void TestUtil() {',
      '  shared_util();',
      '}',
      '',
    ].join('\n'));
    // TS pair: target lives in a .ts file, so the C/C++-only heuristic must NOT
    // fire even though a test calls a method of the same name.
    fs.writeFileSync(path.join(dir, 'widget.ts'), [
      'export class Widget {',
      '  redraw(): number { return 1; }',
      '}',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'widget.test.ts'), [
      "import { Widget } from './widget';",
      'export function testRedraw(): void {',
      '  const w = new Widget();',
      '  w.redraw();',
      '}',
      '',
    ].join('\n'));
  }
}

async function storeLevelTests(): Promise<string> {
  const ws = path.join(os.tmpdir(), `seer-godot-fixes-${Date.now()}`);
  writeCppFixture(ws, { withTests: true });
  const store = new Store(path.join(ws, '.seer', 'graph.db'));
  const indexer = new Indexer(store);
  await indexer.indexDirectory(ws, { quiet: true });

  // ── Fix 1: symbolNameVariants + `::` normalization ───────────────────────
  console.log('\n── Fix 1: `::` qualified-name lookup normalization ──');
  assert(JSON.stringify(symbolNameVariants('Node::add_child')) === JSON.stringify(['Node::add_child', 'Node.add_child']),
    'symbolNameVariants expands `::` to the stored `.` form', symbolNameVariants('Node::add_child'));
  assert(JSON.stringify(symbolNameVariants('plain_name')) === JSON.stringify(['plain_name']),
    'symbolNameVariants is a no-op for `::`-free names (byte-identical lookup path)');
  assert(JSON.stringify(symbolNameVariants('A::B::c')) === JSON.stringify(['A::B::c', 'A.B.c']),
    'symbolNameVariants normalizes every `::`');
  // Guard the empty-string edge: `[]` would build an invalid `IN ()` placeholder
  // list. The original is always kept, so '' yields [''] (valid, matches nothing).
  assert(JSON.stringify(symbolNameVariants('')) === JSON.stringify(['']),
    'symbolNameVariants(empty) returns [""] — never [] (no invalid IN () SQL)', symbolNameVariants(''));
  assert(store.countCallers('') === 0 && store.findCallers('').length === 0,
    'caller helpers tolerate an empty name without a SQL syntax error');

  const dotDef = store.getDefinition('Node.add_child');
  const colonDef = store.getDefinition('Node::add_child');
  assert(dotDef.length >= 1, 'getDefinition resolves the dot form (baseline)', dotDef.map(d => d.qualifiedName));
  assert(colonDef.length >= 1 && colonDef[0].id === dotDef[0].id,
    'getDefinition resolves `Node::add_child` to the same symbol as `Node.add_child`',
    { colon: colonDef.map(d => d.id), dot: dotDef.map(d => d.id) });

  const findColon = store.findSymbols('Node::add_child');
  assert(findColon.some(s => s.qualifiedName === 'Node.add_child'),
    'findSymbols (the `symbols` command path) matches the `::` form via LIKE variants', findColon.map(s => s.qualifiedName));

  const ftsHit = store.searchSymbolsFts('Node::add_child');
  assert(ftsHit.some(s => s.qualifiedName === 'Node.add_child'),
    'searchSymbolsFts finds the symbol for a `::` query', ftsHit.map(s => s.qualifiedName));
  const fq = ftsQuery('Node::add_child');
  assert(fq != null && !fq.includes(':'),
    'ftsQuery emits no colon-bearing token for a `::` query', fq);
  assert(fq != null && fq.includes('"node.add_child"'),
    'ftsQuery normalizes `::`→`.` so the precise dotted phrase is present', fq);

  assert(store.countSymbols('Node::add_child') === store.countSymbols('Node.add_child'),
    'countSymbols agrees across `::` and `.` spellings (search total never drifts)',
    { colon: store.countSymbols('Node::add_child'), dot: store.countSymbols('Node.add_child') });

  // ── Fix 2: callees for a qualified caller ────────────────────────────────
  console.log('\n── Fix 2: callees resolve for a qualified caller ──');
  const byId = store.findCalleesById(dotDef[0].id).map(c => c.calleeName);
  assert(byId.includes('validate_child') && byId.includes('attach_internal'),
    'findCalleesById(Node.add_child) returns the body callees', byId);
  const dotCallees = store.findCallees('Node.add_child').map(c => c.calleeName);
  assert(dotCallees.includes('validate_child') && dotCallees.includes('attach_internal'),
    'findCallees fallback now matches a qualified caller name', dotCallees);
  const colonCallees = store.findCallees('Node::add_child').map(c => c.calleeName);
  assert(colonCallees.includes('validate_child'),
    'findCallees fallback matches the `::` spelling too', colonCallees);
  const shortCallees = store.findCallees('add_child').map(c => c.calleeName);
  assert(shortCallees.includes('validate_child') && shortCallees.includes('attach_internal'),
    'findCallees(short name) still resolves via the broad s.name path (Node::add_child body callees present)', shortCallees);

  // ── Review High fix: callers resolve by id for a qualified symbol ─────────
  // `Node::reparent` calls `add_child(child)`, which resolves to Node::add_child
  // (edge to_id = the method, to_name = the SHORT `add_child`). Resolve-first +
  // findCallersById finds it; the legacy name path (to_name = `Node.add_child`)
  // misses it — the exact gap the review flagged for seer_callers.
  console.log('\n── Review High: callers resolve by id for a qualified symbol ──');
  const nodeAddId = dotDef[0].id;
  assert(store.findCallersById(nodeAddId).some(c => c.callerName === 'reparent'),
    'findCallersById(Node.add_child) returns the same-file caller reparent',
    store.findCallersById(nodeAddId).map(c => c.callerName));
  assert(store.countCallers('Node.add_child') === 0,
    'legacy name path misses it (edge to_name is the short `add_child`) — proves resolve-first is required',
    store.countCallers('Node.add_child'));
  // Gating contract: a BARE short name must stay broad (callers of EVERY
  // add_child: reparent via Node, TestNode via Harness), while the qualified
  // form narrows to one id. seer_callers/CLI therefore resolve-first only when
  // `file || qualified` — bare short names must not collapse to one definition
  // (the stability-regressions broad-callers contract).
  const broadCallers = store.findCallers('add_child').map(c => c.callerName);
  assert(broadCallers.includes('reparent') && broadCallers.includes('TestNode'),
    'short-name callers stay broad (reparent + TestNode), never narrowed to one id', broadCallers);
  assert(!store.findCallersById(nodeAddId).some(c => c.callerName === 'TestNode'),
    'the qualified/by-id path stays narrow (TestNode resolved to Harness, not Node)',
    store.findCallersById(nodeAddId).map(c => c.callerName));

  // ── Audit round 2: caller-count provenance + honest blast-radius bounds ──
  // The receiver-type gap means `node->add_child(...)` scatters across same-named
  // defs, so the id-resolved count is a LOWER bound. Surface both bounds + the
  // unique-vs-callsite distinction rather than a falsely-precise small number.
  console.log('\n── Audit2: caller provenance + ambiguity bounds ──');
  assert(store.countUniqueCallersById(nodeAddId) === store.findCallersById(nodeAddId).length,
    'countUniqueCallersById matches distinct id-resolved callers',
    { unique: store.countUniqueCallersById(nodeAddId), rows: store.findCallersById(nodeAddId).length });
  const addChildDefs = store.countDefinitionsByShortName('add_child');
  assert(addChildDefs >= 2,
    'countDefinitionsByShortName sees the multiple add_child definitions (excludes the header declaration)', addChildDefs);
  const nameCallsites = store.countCallers('add_child');
  assert(nameCallsites > store.countCallersById(nodeAddId),
    'more call sites use the bare short name than resolved to Node.add_child (the undercount)',
    { nameCallsites, resolved: store.countCallersById(nodeAddId) });
  const ctxAmb = buildContext(store, 'Node.add_child')!;
  assert(ctxAmb.blastRadius.directCallsites === store.countCallersById(nodeAddId),
    'context.blastRadius.directCallsites equals id-resolved call sites', ctxAmb.blastRadius.directCallsites);
  assert(ctxAmb.blastRadius.ambiguity != null
    && ctxAmb.blastRadius.ambiguity.reason === 'unresolved-receiver-type'
    && ctxAmb.blastRadius.ambiguity.nameCallsites === nameCallsites,
    'context.blastRadius.ambiguity reports the unresolved-receiver undercount with the name-level upper bound',
    ctxAmb.blastRadius.ambiguity);
  // A free function with a unique name must NOT get an ambiguity block.
  const orphanCtx = buildContext(store, 'orphan_method')!;
  assert(orphanCtx.blastRadius.ambiguity === undefined,
    'unambiguous symbol carries no ambiguity block', orphanCtx.blastRadius.ambiguity);
  // Behavior low-confidence flag mirrors the heuristic-only state.
  const behLow = rankedBehavior(store, 'Node.add_child', { includeNamingConvention: false, includeSameFile: false })!;
  assert(behLow.testCoverageState === 'heuristic-only' && behLow.lowConfidence === true,
    'behavior.lowConfidence is true exactly when evidence is heuristic-only', { state: behLow.testCoverageState, low: behLow.lowConfidence });
  const behHigh = rankedBehavior(store, 'Node.add_child')!;
  assert(behHigh.testCoverageState === 'graph-linked' && behHigh.lowConfidence === false,
    'behavior.lowConfidence is false when a precise link exists', { state: behHigh.testCoverageState, low: behHigh.lowConfidence });

  // ── Audit3: file disambiguation for seer_behavior / seer_risk ────────────
  // A bare ambiguous name (`add_child` is defined by Node AND the test's local
  // Harness) used to silently resolve to the highest-PageRank definition, so
  // behavior/risk could describe the WRONG symbol. `filePath` must pin it.
  console.log('\n── Audit3: behavior/risk file disambiguation ──');
  assert(store.countDefinitionsByShortName('add_child') >= 2,
    'fixture has an ambiguous add_child (precondition for the disambiguation test)');
  const behPinned = rankedBehavior(store, 'add_child', { filePath: 'node.cpp' })!;
  assert(behPinned != null && behPinned.symbol.id === nodeAddId,
    'rankedBehavior(add_child, file=node.cpp) pins Node.add_child instead of the highest-PageRank sibling',
    { got: behPinned?.symbol?.id, want: nodeAddId });
  const riskPinned = computeRisk(store, 'add_child', { filePath: 'node.cpp' })!;
  assert(riskPinned != null && riskPinned.symbol.id === nodeAddId,
    'computeRisk(add_child, file=node.cpp) pins Node.add_child instead of the highest-PageRank sibling',
    { got: riskPinned?.symbol?.id, want: nodeAddId });
  // The no-file path must still resolve *a* definition (no crash / regression).
  const behNoFile = rankedBehavior(store, 'add_child');
  assert(behNoFile != null && typeof behNoFile.symbol.id === 'number',
    'rankedBehavior(add_child) without file still resolves a definition', behNoFile?.symbol?.id);

  // ── Fix 4: heuristic name-call test evidence (C/C++) ─────────────────────
  console.log('\n── Fix 4: heuristic test evidence for unresolved C++ member calls ──');
  const beh = rankedBehavior(store, 'Node.add_child')!;
  assert(beh != null, 'rankedBehavior resolves Node.add_child');
  assert(beh.direct === 0,
    'precise DIRECT coverage is 0 (the test call resolved same-file to Harness.add_child)', { direct: beh.direct });
  const heur = beh.tests.find(t => t.relationship === 'heuristic-name-call');
  assert(beh.heuristicMatches >= 1 && heur != null,
    'behavior surfaces a heuristic-name-call test for Node.add_child', { heuristicMatches: beh.heuristicMatches });
  assert(heur != null && heur.heuristic === true,
    'heuristic evidence is flagged heuristic:true', heur);
  assert(heur != null && /test_node\.cpp$/.test(heur.testSymbol.file.replace(/\\/g, '/')),
    'heuristic points at the test file that calls add_child', heur?.testSymbol.file);
  assert(heur != null && heur.specificity < 40,
    'heuristic ranks below resolved signals (low specificity)', heur?.specificity);

  // Gating: a TS target must NOT get heuristic evidence even with a same-named test call.
  const tsDef = store.getDefinition('redraw');
  if (tsDef.length > 0) {
    const tsBeh = rankedBehavior(store, tsDef[0].id)!;
    assert(tsBeh.heuristicMatches === 0 && tsBeh.tests.every(t => t.relationship !== 'heuristic-name-call'),
      'heuristic is C/C++-gated: a TS symbol gets no heuristic-name-call rows', tsBeh.tests.map(t => t.relationship));
  } else {
    assert(false, 'TS fixture symbol `redraw` should index (gating test setup)');
  }

  // Member-gate (review Medium #2): a C/C++ FREE function (no owner scope) must
  // NOT get heuristic evidence even though a test calls a same-named function —
  // the receiver-type gap only applies to member calls. The fixture sets up a
  // real heuristic CANDIDATE (test_node.cpp's local shared_util diverts the
  // call), so this proves the gate rejects it rather than there being no hit.
  const freeDef = store.getDefinition('shared_util').find(d => /node\.cpp$/.test(d.filePath.replace(/\\/g, '/')));
  assert(freeDef != null, 'free function shared_util resolves in node.cpp',
    store.getDefinition('shared_util').map(d => `${d.qualifiedName ?? d.name}@${d.filePath}`));
  if (freeDef) {
    assert(freeDef.qualifiedName === 'shared_util',
      'shared_util has no owner scope (free function, not a method)', freeDef.qualifiedName);
    const freeBeh = rankedBehavior(store, freeDef.id)!;
    assert(freeBeh.heuristicMatches === 0 && freeBeh.tests.every(t => t.relationship !== 'heuristic-name-call'),
      'heuristic is member-gated: a C++ free function gets no heuristic-name-call rows', freeBeh.tests.map(t => t.relationship));
  }

  // ── Fix 5a: behavior test-coverage states ────────────────────────────────
  console.log('\n── Fix 5: behavior test-coverage state distinctions ──');
  assert(store.hasTestRoleClassification() === true, 'modern index supports test-role classification');
  assert(store.countTestFiles() >= 1, 'the C++ fixture indexed at least one test file', store.countTestFiles());
  // review Medium #1: a precise signal must beat heuristic. By default the
  // Harness::add_child decoy (a test-file method sharing the name) is a real
  // naming-convention link, so the state is correctly `graph-linked` — heuristic
  // does NOT downgrade a symbol that also has precise evidence.
  assert(beh.testCoverageState === 'graph-linked' && beh.namingMatches >= 1,
    'with a precise naming link present, state stays graph-linked (heuristic is additive)',
    { state: beh.testCoverageState, naming: beh.namingMatches, heuristic: beh.heuristicMatches });
  // Now isolate the heuristic-only path: disable the precise passes so the name
  // heuristic is the SOLE remaining signal. The state must be the weaker
  // `heuristic-only`, never the precise-sounding `graph-linked` (the bug the
  // review flagged: heuristic-only output that sounds precise).
  const heurOnly = rankedBehavior(store, 'Node.add_child', {
    includeNamingConvention: false, includeSameFile: false,
  })!;
  assert(heurOnly.total === heurOnly.heuristicMatches && heurOnly.heuristicMatches >= 1,
    'with precise passes off, Node.add_child has only heuristic evidence',
    { total: heurOnly.total, heuristic: heurOnly.heuristicMatches });
  assert(heurOnly.testCoverageState === 'heuristic-only',
    'heuristic-only state: heuristic evidence no longer masquerades as graph-linked', heurOnly.testCoverageState);

  const orphan = store.getDefinition('orphan_method');
  assert(orphan.length >= 1, 'orphan_method resolves');
  const orphanBeh = rankedBehavior(store, orphan[0].id)!;
  assert(orphanBeh.total === 0 && orphanBeh.testCoverageState === 'tests-indexed-no-link',
    'orphan_method → tests-indexed-no-link (tests exist, none link here)',
    { total: orphanBeh.total, state: orphanBeh.testCoverageState });

  // ── Fix 5b: historyIndex.built on a fresh (non-git) index ────────────────
  const hi = store.getHistoryIndexInfo();
  assert(hi.built === false && hi.rows === 0,
    'getHistoryIndexInfo().built is false on a fresh index', hi);
  const ctx = buildContext(store, 'Node.add_child')!;
  assert(ctx != null && ctx.historyIndex.built === false,
    'context packet exposes historyIndex.built=false (empty history ≠ no commits)', ctx?.historyIndex);
  const pf = await preflight(store, { symbol: 'Node.add_child' });
  assert(pf.ok === true && pf.historyIndex.built === false,
    'preflight packet exposes historyIndex.built=false', pf.historyIndex);

  store.close();
  return ws;
}

async function noTestsState(): Promise<void> {
  console.log('\n── Fix 5: no-indexed-tests state ──');
  const ws = path.join(os.tmpdir(), `seer-godot-notest-${Date.now()}`);
  writeCppFixture(ws, { withTests: false });
  const store = new Store(path.join(ws, '.seer', 'graph.db'));
  const indexer = new Indexer(store);
  await indexer.indexDirectory(ws, { quiet: true });
  assert(store.countTestFiles() === 0, 'workspace with no test files reports 0 indexed tests', store.countTestFiles());
  const beh = rankedBehavior(store, 'Node.add_child')!;
  assert(beh.testCoverageState === 'no-indexed-tests',
    'no test files → testCoverageState=no-indexed-tests', beh.testCoverageState);
  store.close();
  fs.rmSync(ws, { recursive: true, force: true });
}

// ── MCP harness (compact, mirrors optspec.ts) ──────────────────────────────
async function mcpLevelTests(ws: string): Promise<void> {
  console.log('\n── Fix 2 + Fix 3 + Fix 5 (MCP surface) ──');
  const proc = spawn(process.execPath, [CLI, 'mcp', '--workspace', ws, '--no-watch', '--no-jit'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stderr.on('data', (d) => { if (process.env.SEER_TEST_VERBOSE) process.stderr.write(`[mcp] ${d}`); });

  let buf = '';
  const pending = new Map<number, { resolve: (m: any) => void; timer: NodeJS.Timeout }>();
  proc.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: any; try { msg = JSON.parse(line); } catch { continue; }
      const p = msg.id != null ? pending.get(msg.id) : undefined;
      if (p) { clearTimeout(p.timer); pending.delete(msg.id); p.resolve(msg); }
    }
  });
  let nextId = 1;
  const call = (method: string, params: any): Promise<any> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 30_000);
      pending.set(id, { resolve, timer });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  const callTool = async (name: string, args: any = {}): Promise<any> => {
    const r = await call('tools/call', { name, arguments: args });
    return JSON.parse(r.result?.content?.[0]?.text ?? '{}');
  };

  try {
    let initOk = false;
    for (let i = 0; i < 30; i++) {
      try { const r = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } }); if (r.result) { initOk = true; break; } } catch { /* */ }
      await new Promise(r => setTimeout(r, 500));
    }
    assert(initOk, 'MCP server initializes against the C++ fixture');
    if (!initOk) return;

    // Fix 2: seer_callees resolves a qualified caller with NO file hint.
    const ce = await callTool('seer_callees', { symbol: 'Node.add_child' });
    assert((ce.total ?? 0) >= 2 && ce.target?.qualifiedName === 'Node.add_child',
      'seer_callees resolves a qualified caller via getDefinition→findCalleesById', { total: ce.total, target: ce.target?.qualifiedName });
    const ceColon = await callTool('seer_callees', { symbol: 'Node::add_child' });
    assert((ceColon.total ?? 0) === (ce.total ?? -1),
      'seer_callees `::` spelling matches the `.` spelling', { colon: ceColon.total, dot: ce.total });

    // Review High fix: seer_callers resolves a qualified symbol WITHOUT a file
    // hint and reads callers by id. Node.add_child's resolved caller is reparent
    // (same-file); the legacy name path returned no target and missed the edge.
    const cr = await callTool('seer_callers', { symbol: 'Node.add_child' });
    assert(cr.target?.qualifiedName === 'Node.add_child' && (cr.total ?? 0) >= 1
      && (cr.items ?? []).some((i: any) => i.callerName === 'reparent'),
      'seer_callers resolves a qualified symbol by id without --file (finds reparent)',
      { target: cr.target?.qualifiedName, total: cr.total });
    const crColon = await callTool('seer_callers', { symbol: 'Node::add_child' });
    assert(crColon.target?.qualifiedName === 'Node.add_child' && (crColon.total ?? 0) === (cr.total ?? -1),
      'seer_callers `::` spelling resolves to the same target and count', { colon: crColon.total, dot: cr.total });

    // Audit2: seer_callers reports uniqueCallers (functions) vs total (call sites)
    // and an ambiguity block for the type-unresolved undercount.
    assert(typeof cr.uniqueCallers === 'number',
      'seer_callers reports uniqueCallers (distinct caller functions) alongside total (call sites)', cr.uniqueCallers);
    assert(cr.ambiguity != null && cr.ambiguity.reason === 'unresolved-receiver-type'
      && cr.ambiguity.nameCallsites > (cr.total ?? 0),
      'seer_callers flags the C/C++ receiver-type undercount with a name-level upper bound', cr.ambiguity);
    const crNames = await callTool('seer_callers', { symbol: 'Node.add_child', includeNameMatches: true });
    assert(crNames.nameMatches != null && (crNames.nameMatches.items?.length ?? 0) >= 1
      && crNames.nameMatches.total >= (cr.total ?? 0),
      'seer_callers includeNameMatches returns the by-name caller upper bound', crNames.nameMatches?.total);

    // Audit2: trace summary mode no longer emits a bare `returned: 0` that reads
    // like "0 results" — it nests an explicit rows.omittedByMode marker instead.
    const trcSum = await callTool('seer_trace_callers', { symbol: 'add_child', mode: 'summary' });
    assert(trcSum.returned === undefined && trcSum.rows?.omittedByMode === true,
      'seer_trace_callers summary omits the misleading top-level returned:0 (uses rows.omittedByMode)', { returned: trcSum.returned, rows: trcSum.rows });

    // Audit3: a BARE ambiguous name must carry a nameAmbiguity hint so the agent
    // knows it got the highest-PageRank def (not necessarily the one it meant);
    // passing `file` resolves it and the hint disappears (no token waste).
    const ctxBare = await callTool('seer_context', { symbol: 'add_child' });
    assert(ctxBare.nameAmbiguity != null
      && /defined by \d+ symbols/.test(ctxBare.nameAmbiguity.note ?? '')
      && Array.isArray(ctxBare.nameAmbiguity.otherDefinitions),
      'seer_context on a bare ambiguous name surfaces a nameAmbiguity hint', ctxBare.nameAmbiguity);
    const ctxPinned = await callTool('seer_context', { symbol: 'add_child', file: 'node.cpp' });
    assert(ctxPinned.nameAmbiguity === undefined && ctxPinned.symbol?.qualifiedName === 'Node.add_child',
      'seer_context with file resolves the symbol and drops the nameAmbiguity hint', ctxPinned.symbol?.qualifiedName);
    const trcAmb = await callTool('seer_trace_callers', { symbol: 'add_child', mode: 'summary' });
    assert(trcAmb.nameAmbiguity != null,
      'seer_trace_callers on a bare ambiguous name also carries the nameAmbiguity hint', trcAmb.nameAmbiguity?.note);

    // Fix 3: seer_definition `symbol` alias.
    const defAlias = await callTool('seer_definition', { symbol: 'Node.add_child' });
    assert((defAlias.items ?? []).length >= 1, 'seer_definition accepts `symbol` as an alias for `name`', defAlias.total);
    const defNone = await callTool('seer_definition', {});
    assert(defNone.ok === false && /requires/.test(defNone.error ?? ''),
      'seer_definition with neither name nor symbol returns a clean error', defNone);

    // Fix 3: seer_batch re-validates delegated args against the zod schema. A
    // tool with a genuinely required field (seer_callers.symbol) used to reach
    // the store as `undefined` and throw a raw SQLite binding error.
    const batchBad = await callTool('seer_batch', { calls: [{ tool: 'seer_callers', args: {} }] });
    const bb = batchBad.results?.[0];
    assert(bb && bb.ok === false && /invalid args/i.test(bb.error ?? ''),
      'seer_batch re-validates a sub-call missing a required field (clean "invalid args")', bb);
    assert(bb && !/bound to SQLite|parameter 1/i.test(bb.error ?? ''),
      'seer_batch no longer leaks the raw SQLite binding error', bb?.error);
    // A required-field-less guard (seer_definition accepts name OR symbol) is
    // caught by the handler instead — still a clean message, never a raw throw.
    const batchGuard = await callTool('seer_batch', { calls: [{ tool: 'seer_definition', args: {} }] });
    const bg = batchGuard.results?.[0];
    assert(bg && bg.ok === false && !/bound to SQLite|parameter 1/i.test(bg.error ?? '') && /requires/i.test(bg.error ?? bg.result?.error ?? ''),
      'seer_batch sub-call with no name/symbol returns the clean handler guard, not a SQLite error', bg);
    const batchOk = await callTool('seer_batch', { calls: [{ tool: 'seer_definition', args: { symbol: 'Node.add_child' } }] });
    assert(batchOk.results?.[0]?.ok === true && (batchOk.results[0].result.items ?? []).length >= 1,
      'seer_batch runs a delegated seer_definition using the `symbol` alias', batchOk.results?.[0]);

    // Fix 3: seer_trace validates delegated args.
    const traceBad = await callTool('seer_trace', { scope: 'callers', args: {} });
    assert(traceBad.ok === false && /invalid args/i.test(traceBad.error ?? ''),
      'seer_trace re-validates the delegate schema (clean error for missing symbol)', traceBad);

    // Fix 4 + 5 over MCP: behavior carries the coverage state + heuristic. The
    // MCP tool runs the default passes, so the Harness::add_child naming link
    // makes this graph-linked WITH a heuristic match alongside it (the dedicated
    // heuristic-only path is asserted at the store level with passes disabled).
    const beh = await callTool('seer_behavior', { symbol: 'Node.add_child' });
    assert(beh.testCoverageState === 'graph-linked' && (beh.heuristicMatches ?? 0) >= 1,
      'seer_behavior surfaces coverage state + heuristicMatches (graph-linked + heuristic)', { state: beh.testCoverageState, heur: beh.heuristicMatches });

    // Fix 5: context + preflight expose historyIndex.built.
    const ctx = await callTool('seer_context', { symbol: 'Node.add_child' });
    assert(ctx.historyIndex && ctx.historyIndex.built === false,
      'seer_context exposes historyIndex.built=false', ctx.historyIndex);
    const pf = await callTool('seer_preflight', { symbol: 'Node.add_child' });
    assert(pf.historyIndex && pf.historyIndex.built === false,
      'seer_preflight exposes historyIndex.built=false', pf.historyIndex);
  } finally {
    proc.stdin.end();
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => { if (!done) { done = true; resolve(); } };
      proc.on('exit', finish);
      proc.kill();
      // Windows can keep the .db/-wal handle a moment after kill; give it time
      // so the caller's rmSync doesn't race the OS releasing the file.
      setTimeout(finish, 1500);
    });
  }
}

async function main(): Promise<void> {
  console.log('\nSeer Godot-Audit Regression Tests\n=================================');
  const ws = await storeLevelTests();
  await noTestsState();
  await mcpLevelTests(ws);
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }

  console.log(`\n${failed === 0 ? '✓' : '✗'} godot-fixes: ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
