import { Store } from '../db/store.js';
import { rankedBehavior, BehaviorResult } from './behavior.js';
import type { SymbolRow } from '../types.js';

/**
 * Deterministic edit-risk profile for a symbol.
 *
 * Risk is decomposed: every signal that contributes is returned alongside
 * the score so an agent can see WHY the verdict is "high" instead of
 * trusting the number. The exit criteria for Track-E explicitly call this
 * out: "seer_risk returns decomposed deterministic signals, not unexplained
 * vibes."
 *
 * Signals (with deterministic weights):
 *   directCallers           +1 per caller up to 30
 *   transitiveCallers       +ln(1 + transitive) * 4   (bounded BFS, depth 3)
 *   routeExposed            +20 if symbol is a route handler
 *   directTests             -10 per direct test, capped at -30 (good coverage
 *                                                                 reduces risk)
 *   indirectTests           -2 per indirect test, capped at -8
 *   assertionCount          -2 per assertion across direct tests, capped at -10
 *   recentCommits           +ln(1 + history.length) * 4
 *   distinctAuthors         +3 per distinct author beyond 1, capped at +15
 *   cyclomatic              max(0, cyclomatic - 8) * 1
 *   cognitive               max(0, cognitive - 12) * 0.5
 *   configKeys              +3 per distinct config key, capped at +15
 *   moduleBoundaryCrossings +2 per distinct neighboring module, capped at +20
 *
 * The score is bucketed into `low` (<20), `medium` (<50), or `high` (>=50).
 * The thresholds are conservative — easy to bias toward "high" — so the
 * agent gets shown evidence even when the verdict is in doubt.
 */

export interface RiskSignals {
  directCallers: number;
  transitiveCallers: number;
  routeExposed: boolean;
  routes: Array<{ method: string; path: string; framework: string }>;
  directTests: number;
  indirectTests: number;
  assertionCount: number;
  recentCommits: number;
  distinctAuthors: number;
  cyclomatic: number | null;
  cognitive: number | null;
  configKeys: number;
  moduleBoundaryCrossings: number;
  /**
   * v8 Track-G — number of distinct outbound service calls this symbol makes
   * (e.g. fetch/axios.get calls). Higher = symbol depends on more external
   * services, which is a real risk surface for edits.
   */
  outboundServiceCalls: number;
  /**
   * v8 Track-G — number of inbound service_links pointing at this symbol as
   * the handler. Higher = changes here likely affect other services.
   */
  inboundServiceLinks: number;
  /**
   * v8 Track-G — number of service_links whose handler lives in a different
   * module than the caller. Cross-module client/handler dependency is a sign
   * of architectural distance and risk.
   */
  crossModuleServiceLinks: number;
  /**
   * v8 Track-G — service_links involving this symbol whose match_kind is
   * route_pattern (not literal_path). Pattern-only matches carry residual
   * ambiguity and are worth surfacing as a soft signal.
   */
  ambiguousServiceLinks: number;
  /**
   * v10 — number of distinct neighboring boundaries this symbol's call graph
   * reaches OUT of its own boundary. Advisory; never raises the verdict by
   * itself.
   */
  boundaryCrossings: number;
}

export interface RiskResult {
  symbol: {
    id: number;
    name: string;
    qualifiedName: string | null;
    kind: string;
    file: string;
    lineStart: number;
    lineEnd: number;
  };
  risk: 'low' | 'medium' | 'high';
  score: number;
  signals: RiskSignals;
  signalContributions: Array<{ signal: string; value: number; contribution: number }>;
  /** Module the symbol's file belongs to, when clustering has run. */
  module: { id: number; label: string } | null;
  /** v10 boundary the symbol's file belongs to. NULL when none detected. */
  boundary: { id: number; label: string; kind: string; rootRelPath: string } | null;
  source: 'tree-sitter';
}

interface RiskOptions {
  callerDepth?: number;
  /**
   * Disambiguates a bare name to one definition (absolute path, exact rel_path,
   * or trailing path fragment). Without it an ambiguous name resolved to the
   * highest-PageRank definition, so the risk profile could describe the wrong
   * symbol. Mirrors seer_context / seer_callers disambiguation.
   */
  filePath?: string;
}

export function computeRisk(
  store: Store,
  nameOrId: string | number,
  options: RiskOptions = {},
): RiskResult | null {
  const callerDepth = options.callerDepth ?? 3;
  let target: SymbolRow | null = null;
  if (typeof nameOrId === 'number') {
    target = store.getSymbolById(nameOrId);
  } else {
    const defs = store.getDefinition(nameOrId, { filePath: options.filePath });
    if (defs.length === 0) return null;
    target = defs[0];
  }
  if (!target) return null;

  // Direct + transitive callers (call graph fan-in).
  // ID-based count so short-name siblings (Alpha.run vs Beta.run) don't
  // inflate this symbol's fan-in.
  const directCallers = store.countCallersById(target.id);
  const transitiveRows = store.reverseReachableWithDepth(target.id, callerDepth);
  // Exclude direct callers from the transitive count so we don't double-count.
  const transitiveCallers = transitiveRows.filter(r => r.depth > 1).length;

  // Route exposure.
  const routes = store.routesForHandler(target.id);
  const routeExposed = routes.length > 0;

  // Behavioral coverage — reuse the ranked behavior since it already does
  // direct vs indirect deduplication and assertion counting.
  const behavior = rankedBehavior(store, target.id, { limit: 200 });
  const directTests = behavior?.direct ?? 0;
  const indirectTests = behavior?.indirect ?? 0;
  const assertionCount = sumAssertions(behavior);

  // Symbol history.
  const historyRows = store.getSymbolHistory(target.id, { limit: 200 });
  const recentCommits = historyRows.length;
  const distinctAuthors = new Set(
    historyRows.map(h => (h.authorEmail ?? h.authorName ?? '').toLowerCase()).filter(s => s),
  ).size;

  // Complexity.
  const cyclomatic = target.cyclomatic ?? null;
  const cognitive = target.cognitive ?? null;

  // Config reads.
  const configKeys = store.configKeysForSymbol(target.id).length;

  // Module-boundary crossings: how many distinct neighbor modules this
  // symbol's call graph reaches OUT of its own module.
  const myFileModule = store.moduleForFile(target.fileId);
  let moduleBoundaryCrossings = 0;
  if (myFileModule) {
    const neighborModules = new Set(
      store.calleeModulesOf(target.id)
        .filter(m => m.moduleId !== myFileModule.id)
        .map(m => m.moduleId),
    );
    moduleBoundaryCrossings = neighborModules.size;
  }

  // v8 Track-G service-link signals.
  let outboundServiceCalls = 0;
  let inboundServiceLinks = 0;
  let crossModuleServiceLinks = 0;
  let ambiguousServiceLinks = 0;
  try {
    outboundServiceCalls = store.listServiceCalls({ callerSymbolId: target.id, limit: 1000 }).length;
  } catch { /* */ }
  try {
    const inbound = store.serviceLinksForHandler(target.id, { limit: 1000 });
    inboundServiceLinks = inbound.length;
    ambiguousServiceLinks += inbound.filter(l => l.matchKind === 'route_pattern').length;
    if (myFileModule) {
      for (const link of inbound) {
        if (link.callerSymbolId == null) continue;
        const callerSym = store.getSymbolById(link.callerSymbolId);
        if (!callerSym) continue;
        const callerMod = store.moduleForFile(callerSym.fileId);
        if (callerMod && callerMod.id !== myFileModule.id) crossModuleServiceLinks++;
      }
    }
  } catch { /* */ }
  try {
    const outbound = store.serviceLinksForCaller(target.id, { limit: 1000 });
    ambiguousServiceLinks += outbound.filter(l => l.matchKind === 'route_pattern').length;
    if (myFileModule) {
      for (const link of outbound) {
        if (link.handlerSymbolId == null) continue;
        const handlerSym = store.getSymbolById(link.handlerSymbolId);
        if (!handlerSym) continue;
        const handlerMod = store.moduleForFile(handlerSym.fileId);
        if (handlerMod && handlerMod.id !== myFileModule.id) crossModuleServiceLinks++;
      }
    }
  } catch { /* */ }

  // v10 — boundary crossings (calls into another package/service boundary).
  let boundaryCrossings = 0;
  const myBoundary = store.boundaryForFile(target.fileId);
  if (myBoundary) {
    const neighborBoundaries = new Set(
      store.calleeBoundariesOf(target.id)
        .filter(b => b.boundaryId !== myBoundary.id)
        .map(b => b.boundaryId),
    );
    boundaryCrossings = neighborBoundaries.size;
  }

  const signals: RiskSignals = {
    directCallers, transitiveCallers, routeExposed, routes,
    directTests, indirectTests, assertionCount,
    recentCommits, distinctAuthors,
    cyclomatic, cognitive,
    configKeys, moduleBoundaryCrossings,
    outboundServiceCalls, inboundServiceLinks,
    crossModuleServiceLinks, ambiguousServiceLinks,
    boundaryCrossings,
  };

  const contributions = scoreContributions(signals);
  const score = contributions.reduce((acc, c) => acc + c.contribution, 0);
  const risk: 'low' | 'medium' | 'high' =
    score >= 50 ? 'high' : score >= 20 ? 'medium' : 'low';

  return {
    symbol: {
      id: target.id,
      name: target.name,
      qualifiedName: target.qualifiedName,
      kind: target.kind,
      file: target.filePath,
      lineStart: target.lineStart,
      lineEnd: target.lineEnd,
    },
    risk, score, signals,
    signalContributions: contributions,
    module: myFileModule,
    boundary: myBoundary,
    source: 'tree-sitter',
  };
}

function sumAssertions(b: BehaviorResult | null): number {
  if (!b) return 0;
  let n = 0;
  for (const t of b.tests) {
    if (t.relationship === 'direct-call') n += t.assertionCount;
  }
  return n;
}

function scoreContributions(s: RiskSignals): Array<{ signal: string; value: number; contribution: number }> {
  const out: Array<{ signal: string; value: number; contribution: number }> = [];
  out.push({ signal: 'directCallers', value: s.directCallers,
    contribution: Math.min(30, s.directCallers) });
  out.push({ signal: 'transitiveCallers', value: s.transitiveCallers,
    contribution: Math.log1p(s.transitiveCallers) * 4 });
  out.push({ signal: 'routeExposed', value: s.routeExposed ? 1 : 0,
    contribution: s.routeExposed ? 20 : 0 });
  // Coverage reduces risk (negative contribution).
  out.push({ signal: 'directTests', value: s.directTests,
    contribution: -Math.min(30, s.directTests * 10) });
  out.push({ signal: 'indirectTests', value: s.indirectTests,
    contribution: -Math.min(8, s.indirectTests * 2) });
  out.push({ signal: 'assertionCount', value: s.assertionCount,
    contribution: -Math.min(10, s.assertionCount * 2) });
  out.push({ signal: 'recentCommits', value: s.recentCommits,
    contribution: Math.log1p(s.recentCommits) * 4 });
  out.push({ signal: 'distinctAuthors', value: s.distinctAuthors,
    contribution: s.distinctAuthors <= 1 ? 0 : Math.min(15, (s.distinctAuthors - 1) * 3) });
  out.push({ signal: 'cyclomatic', value: s.cyclomatic ?? 0,
    contribution: s.cyclomatic == null ? 0 : Math.max(0, s.cyclomatic - 8) });
  out.push({ signal: 'cognitive', value: s.cognitive ?? 0,
    contribution: s.cognitive == null ? 0 : Math.max(0, s.cognitive - 12) * 0.5 });
  out.push({ signal: 'configKeys', value: s.configKeys,
    contribution: Math.min(15, s.configKeys * 3) });
  out.push({ signal: 'moduleBoundaryCrossings', value: s.moduleBoundaryCrossings,
    contribution: Math.min(20, s.moduleBoundaryCrossings * 2) });
  // v8 Track-G — service-link contributions. Conservative weights so they
  // surface as evidence without dominating the score on small fixtures.
  out.push({ signal: 'outboundServiceCalls', value: s.outboundServiceCalls,
    contribution: Math.min(10, s.outboundServiceCalls * 2) });
  out.push({ signal: 'inboundServiceLinks', value: s.inboundServiceLinks,
    contribution: Math.min(15, s.inboundServiceLinks * 3) });
  out.push({ signal: 'crossModuleServiceLinks', value: s.crossModuleServiceLinks,
    contribution: Math.min(10, s.crossModuleServiceLinks * 2) });
  out.push({ signal: 'ambiguousServiceLinks', value: s.ambiguousServiceLinks,
    contribution: Math.min(5, s.ambiguousServiceLinks * 1) });
  // v10 boundary crossings — advisory weight: 1.5 per crossing, capped at 12.
  out.push({ signal: 'boundaryCrossings', value: s.boundaryCrossings,
    contribution: Math.min(12, s.boundaryCrossings * 1.5) });
  // Round contributions for stable output.
  return out.map(c => ({ ...c, contribution: roundTo(c.contribution, 2) }));
}

function roundTo(n: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}
