import { Store } from '../db/store.js';
import { rankedBehavior } from './behavior.js';
import { computeRisk, RiskResult } from './risk.js';
import type { SymbolRow, CallerRow, CalleeRow } from '../types.js';

/**
 * One compact, structured pre-edit packet for a symbol.
 *
 * The aim is workflow compression: an agent that's about to edit a symbol
 * should be able to call ONE tool and get back the deterministic evidence
 * it needs — definition, callers, callees, routes, config reads, behavioral
 * tests, recent history, complexity, module, blast radius, and the
 * decomposed risk score. The agent then decides which slices to expand
 * (`seer_history` for full chain, `seer_callers` for everyone, etc.).
 *
 * This is intentionally NOT an explanation layer. Seer-Core stays
 * deterministic facts only; any narrative about "why this matters" belongs
 * outside Core.
 */

export interface ContextPacket {
  symbol: {
    id: number;
    name: string;
    qualifiedName: string | null;
    kind: string;
    file: string;
    lineStart: number;
    lineEnd: number;
    signature: string | null;
    pagerank: number;
    symbolRole: string | null;
  };
  module: { id: number; label: string } | null;
  /** v10 — monorepo boundary the symbol's file belongs to (null when none). */
  boundary: { id: number; label: string; kind: string; rootRelPath: string } | null;
  complexity: {
    loc: number | null;
    cyclomatic: number | null;
    cognitive: number | null;
    maxNesting: number | null;
  };
  callers: {
    total: number;
    preview: Array<{
      name: string; qualifiedName: string | null; kind: string;
      file: string; line: number;
    }>;
  };
  callees: {
    total: number;
    preview: Array<{
      name: string; kind: string | null;
      file: string | null; line: number | null;
    }>;
  };
  blastRadius: {
    directCallers: number;
    transitiveCallers: number;
    /** Sample of the highest-PageRank reverse-reachable callers (capped). */
    topAffected: Array<{ id: number; name: string; qualifiedName: string | null; file: string; pagerank: number }>;
    maxDepth: number;
  };
  /** Route preview for this handler symbol; bounded to keep the packet compact. */
  routes: Array<{ method: string; path: string; framework: string }>;
  /** Exact total route count before preview truncation. */
  routesTotal: number;
  /** True when `routes` is a capped preview, not the full list. */
  routesTruncated: boolean;
  /** Config-read preview for this symbol; bounded to keep the packet compact. */
  configKeys: Array<{ key: string; source: string; line: number }>;
  /** Exact total config-key count before preview truncation. */
  configKeysTotal: number;
  /** True when `configKeys` is a capped preview, not the full list. */
  configKeysTruncated: boolean;
  /**
   * v8 Track-G — outbound service calls this symbol makes (preview, capped).
   * Empty array on Pre-Track-G DBs or symbols with no outgoing client calls.
   */
  serviceCalls: Array<{
    method: string | null;
    path: string | null;
    framework: string;
    rawTarget: string;
    line: number;
    envKey: string | null;
    hostHint: string | null;
    confidence: number;
  }>;
  /**
   * v8 Track-G — service-link evidence pointing at this symbol as the handler
   * (inbound) and as the caller (outbound). Capped previews.
   */
  serviceLinksInbound: Array<{
    routePath: string | null;
    method: string | null;
    matchKind: string;
    confidence: number;
    callerName: string | null;
    callerFile: string | null;
  }>;
  serviceLinksOutbound: Array<{
    routePath: string | null;
    method: string | null;
    matchKind: string;
    confidence: number;
    handlerName: string | null;
    handlerFile: string | null;
  }>;
  behavior: {
    direct: number;
    indirect: number;
    namingMatches: number;
    sameFileMatches: number;
    preview: Array<{
      name: string; qualifiedName: string | null; file: string; lineStart: number;
      relationship: string; assertionCount: number; specificity: number;
    }>;
  };
  recentHistory: {
    total: number;
    preview: Array<{
      sha: string; author: string | null; email: string | null;
      committedAt: number; message: string | null;
      linesAdded: number; linesRemoved: number;
      prNumber: number | null; prUrl: string | null;
      confidence: number;
    }>;
  };
  /**
   * Whether the per-symbol git history index exists. When `built` is false the
   * empty `recentHistory` means "history not indexed", NOT "symbol has no
   * commits" — the agent should not infer the symbol is new/untouched.
   */
  historyIndex: {
    built: boolean;
    rows: number;
    lastHistoryHeadSha: string | null;
    lastHistoryAt: number | null;
  };
  fileChurn: {
    commitCount: number;
    lastCommitAt: number | null;
    topAuthor: string | null;
  } | null;
  risk: {
    risk: 'low' | 'medium' | 'high';
    score: number;
    signals: RiskResult['signals'];
    signalContributions: RiskResult['signalContributions'];
  };
  source: 'tree-sitter';
}

export interface ContextOptions {
  filePath?: string;
  callerLimit?: number;
  calleeLimit?: number;
  testLimit?: number;
  historyLimit?: number;
  callerDepth?: number;
  affectedLimit?: number;
}

export function buildContext(
  store: Store,
  nameOrId: string | number,
  options: ContextOptions = {},
): ContextPacket | null {
  const callerLimit = options.callerLimit ?? 10;
  const calleeLimit = options.calleeLimit ?? 10;
  const testLimit = options.testLimit ?? 10;
  const historyLimit = options.historyLimit ?? 5;
  const callerDepth = options.callerDepth ?? 3;
  const affectedLimit = options.affectedLimit ?? 10;

  let target: SymbolRow | null = null;
  if (typeof nameOrId === 'number') {
    target = store.getSymbolById(nameOrId);
  } else {
    const defs = store.getDefinition(nameOrId, { filePath: options.filePath });
    if (defs.length === 0) return null;
    target = defs[0];
  }
  if (!target) return null;

  // Callers + callees use the id-based path so short-name siblings
  // (Alpha.run vs Beta.run) don't share evidence. The legacy name-based
  // APIs (findCallers / countCallers / findCallees) intentionally stay
  // broad for the agent-facing CLI tools — Track E packets always have a
  // resolved id and should never collapse.
  const totalCallers = store.countCallersById(target.id);
  const directCallers: CallerRow[] = store.findCallersById(target.id, callerLimit);

  const allCallees: CalleeRow[] = store.findCalleesById(target.id);
  const calleesPreview = allCallees.slice(0, calleeLimit);

  // Blast radius.
  const reverseHits = store.reverseReachableWithDepth(target.id, callerDepth);
  const directRows = store.rawDb().prepare(
    "SELECT DISTINCT from_id FROM edges WHERE to_id = ? AND kind = 'call'",
  ).all(target.id) as Array<{ from_id: unknown }>;
  const directSet = new Set<number>(directRows.map(r => Number(r.from_id)));
  const transitive = reverseHits.filter(h => !directSet.has(h.id));
  let topAffected: ContextPacket['blastRadius']['topAffected'] = [];
  if (reverseHits.length > 0) {
    const ids = reverseHits.map(h => h.id);
    const ph = ids.map(() => '?').join(',');
    const rows = store.rawDb().prepare(`
      SELECT s.id, s.name, s.qualified_name AS qualifiedName, f.path AS file, s.pagerank
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.id IN (${ph}) AND s.is_rankable = 1
      ORDER BY s.pagerank DESC
      LIMIT ?
    `).all(...ids, affectedLimit) as Array<{
      id: unknown; name: unknown; qualifiedName: unknown; file: unknown; pagerank: unknown;
    }>;
    topAffected = rows.map(r => ({
      id: Number(r.id),
      name: String(r.name),
      qualifiedName: r.qualifiedName == null ? null : String(r.qualifiedName),
      file: String(r.file),
      pagerank: Number(r.pagerank),
    }));
  }

  // Routes / config / behavior / history. Routes + config reads are kept as
  // bounded previews because hub handlers / bootstraps can otherwise dominate
  // the packet with dozens of repetitive rows.
  const ROUTE_PREVIEW_CAP = 12;
  const CONFIG_KEY_PREVIEW_CAP = 12;
  const allRoutes = store.routesForHandler(target.id);
  const routes = allRoutes.slice(0, ROUTE_PREVIEW_CAP);
  const allConfigKeys = store.configKeysForSymbol(target.id);
  const configKeys = allConfigKeys.slice(0, CONFIG_KEY_PREVIEW_CAP);
  const behavior = rankedBehavior(store, target.id, { limit: testLimit });

  // v8 Track-G — service-link evidence. Capped previews so the packet stays
  // compact even when the symbol is a hub.
  const SERVICE_CALL_PREVIEW_CAP = 12;
  const SERVICE_LINK_PREVIEW_CAP = 12;
  const serviceCallsRows = store.listServiceCalls({
    callerSymbolId: target.id, limit: SERVICE_CALL_PREVIEW_CAP,
  });
  const serviceLinksInbound = store.serviceLinksForHandler(target.id, { limit: SERVICE_LINK_PREVIEW_CAP });
  const serviceLinksOutbound = store.serviceLinksForCaller(target.id, { limit: SERVICE_LINK_PREVIEW_CAP });
  const history = store.getSymbolHistory(target.id, { limit: historyLimit });
  const totalHistory = store.countSymbolHistory(target.id);
  const historyIndex = store.getHistoryIndexInfo();
  const fileChurn = (() => {
    try {
      const c = store.getFileChurn(target.filePath);
      if (!c) return null;
      return { commitCount: c.commitCount, lastCommitAt: c.lastCommitAt, topAuthor: c.topAuthor };
    } catch { return null; }
  })();

  // Risk (reuses behavior + history + signals computed above; cheaper to
  // recompute than to share through a back-channel.)
  const risk = computeRisk(store, target.id, { callerDepth })!;

  const moduleRow = store.moduleForFile(target.fileId);
  const boundaryRow = store.boundaryForFile(target.fileId);

  return {
    symbol: {
      id: target.id, name: target.name, qualifiedName: target.qualifiedName,
      kind: target.kind, file: target.filePath,
      lineStart: target.lineStart, lineEnd: target.lineEnd,
      signature: target.signature, pagerank: target.pagerank,
      symbolRole: target.symbolRole ?? null,
    },
    module: moduleRow,
    boundary: boundaryRow,
    complexity: {
      loc: target.loc ?? null,
      cyclomatic: target.cyclomatic ?? null,
      cognitive: target.cognitive ?? null,
      maxNesting: target.maxNesting ?? null,
    },
    callers: {
      total: totalCallers,
      preview: directCallers.map(c => ({
        name: c.callerName, qualifiedName: c.callerQualifiedName, kind: c.callerKind,
        file: c.callerFile, line: c.callerLine,
      })),
    },
    callees: {
      total: allCallees.length,
      preview: calleesPreview.map(c => ({
        name: c.calleeName, kind: c.calleeKind,
        file: c.calleeFile, line: c.calleeLineStart,
      })),
    },
    blastRadius: {
      directCallers: directSet.size,
      transitiveCallers: transitive.length,
      topAffected,
      maxDepth: callerDepth,
    },
    routes,
    routesTotal: allRoutes.length,
    routesTruncated: routes.length < allRoutes.length,
    configKeys,
    configKeysTotal: allConfigKeys.length,
    configKeysTruncated: configKeys.length < allConfigKeys.length,
    serviceCalls: serviceCallsRows.map(sc => ({
      method: sc.method,
      path: sc.normalizedPath,
      framework: sc.framework,
      rawTarget: sc.rawTarget,
      line: sc.line,
      envKey: sc.envKey,
      hostHint: sc.hostHint,
      confidence: sc.confidence,
    })),
    serviceLinksInbound: serviceLinksInbound.map(l => ({
      routePath: l.routePath,
      method: l.routeMethod ?? l.callMethod,
      matchKind: l.matchKind,
      confidence: l.confidence,
      callerName: l.callerQualifiedName ?? l.callerName,
      callerFile: l.callerFile,
    })),
    serviceLinksOutbound: serviceLinksOutbound.map(l => ({
      routePath: l.routePath,
      method: l.routeMethod ?? l.callMethod,
      matchKind: l.matchKind,
      confidence: l.confidence,
      handlerName: l.handlerQualifiedName ?? l.handlerName,
      handlerFile: l.handlerFile,
    })),
    behavior: {
      direct: behavior?.direct ?? 0,
      indirect: behavior?.indirect ?? 0,
      namingMatches: behavior?.namingMatches ?? 0,
      sameFileMatches: behavior?.sameFileMatches ?? 0,
      preview: (behavior?.tests ?? []).map(t => ({
        name: t.testSymbol.name,
        qualifiedName: t.testSymbol.qualifiedName,
        file: t.testSymbol.file,
        lineStart: t.testSymbol.lineStart,
        relationship: t.relationship,
        assertionCount: t.assertionCount,
        specificity: t.specificity,
      })),
    },
    recentHistory: {
      total: totalHistory,
      preview: history.map(h => ({
        sha: h.commitSha,
        author: h.authorName,
        email: h.authorEmail,
        committedAt: h.committedAt,
        message: h.message,
        linesAdded: h.linesAdded,
        linesRemoved: h.linesRemoved,
        prNumber: h.prNumber,
        prUrl: h.prUrl,
        confidence: h.confidence,
      })),
    },
    historyIndex,
    fileChurn,
    risk: {
      risk: risk.risk,
      score: risk.score,
      signals: risk.signals,
      signalContributions: risk.signalContributions,
    },
    source: 'tree-sitter',
  };
}
