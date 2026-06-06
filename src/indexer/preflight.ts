/**
 * v10 — Preflight Context.
 *
 * One compact "should I edit this?" evidence packet for an agent. Combines
 * existing deterministic facts (context, risk, behavior, history, service
 * links) plus a "likely tests" recommendation derived from the behavior
 * ranker. Optionally compares a git ref range, mapping touched lines to
 * symbols and aggregating evidence across the change set.
 *
 * No AI prose. Structured facts only. Output is bounded and stable.
 *
 * Two entry points:
 *   1. `preflightForSymbol(store, symbolNameOrId)` — packet for a single
 *      symbol; built on top of buildContext + computeRisk.
 *   2. `preflightForRange(store, workspace, fromRef, toRef)` — packet for a
 *      diff range; uses detectChanges and aggregates per-symbol evidence.
 */

import { Store } from '../db/store.js';
import { buildContext, ContextPacket } from './context.js';
import { computeRisk } from './risk.js';
import { rankedBehavior } from './behavior.js';
import { detectChanges } from './detectchanges.js';
import { contractDiff, ContractDiff } from '../bundle/contract.js';

export interface PreflightTouchedSymbol {
  id: number;
  name: string;
  qualifiedName: string | null;
  kind: string;
  file: string;
  lineStart: number;
  lineEnd: number;
}

export interface PreflightLikelyTest {
  testSymbol: {
    name: string;
    qualifiedName: string | null;
    file: string;
    lineStart: number;
  };
  relationship: string;
  specificity: number;
  assertionCount: number;
  graphDistance: number | null;
}

export interface PreflightServiceImpact {
  inbound: Array<{
    routePath: string | null;
    routeMethod: string | null;
    protocol: string;
    matchKind: string;
    callerName: string | null;
    callerFile: string | null;
  }>;
  outbound: Array<{
    routePath: string | null;
    routeMethod: string | null;
    protocol: string;
    matchKind: string;
    handlerName: string | null;
    handlerFile: string | null;
  }>;
}

export interface PreflightHistoryRow {
  sha: string;
  author: string | null;
  email: string | null;
  committedAt: number;
  message: string | null;
  linesAdded: number;
  linesRemoved: number;
  prNumber: number | null;
  prUrl: string | null;
}

export interface PreflightResult {
  ok: boolean;
  reason?: string;
  /** Mode: 'symbol' for --symbol or 'range' for --from/--to. */
  mode: 'symbol' | 'range';
  /** Symbol mode: the focal symbol. Range mode: empty. */
  symbol?: PreflightTouchedSymbol;
  /** Range mode only. */
  range?: {
    fromRef: string | null;
    toRef: string | null;
    changedFiles: number;
    directHunkCount: number;
  };
  /** All symbols touched by this preflight. */
  touchedSymbols: PreflightTouchedSymbol[];
  /** Risk verdict, aggregated when range mode. */
  risk: {
    overall: 'low' | 'medium' | 'high';
    perSymbol: Array<{
      symbol: PreflightTouchedSymbol;
      risk: 'low' | 'medium' | 'high';
      score: number;
      topContributors: Array<{ signal: string; value: number; contribution: number }>;
    }>;
  };
  likelyTests: PreflightLikelyTest[];
  serviceImpact: PreflightServiceImpact;
  contractChanges?: ContractDiff;
  history: PreflightHistoryRow[];
  /**
   * Whether the per-symbol git history index exists. When `built` is false an
   * empty `history` means "history not indexed", NOT "no commits touched these
   * symbols" — surface that distinction rather than implying a clean slate.
   */
  historyIndex: {
    built: boolean;
    rows: number;
    lastHistoryHeadSha: string | null;
    lastHistoryAt: number | null;
  };
  warnings: string[];
  module: { id: number; label: string } | null;
  /** v10 — boundaries the touched symbol(s) live in or cross into. */
  boundaries: {
    primary: { id: number; label: string; kind: string; rootRelPath: string } | null;
    crossed: Array<{ id: number; label: string; kind: string; rootRelPath: string }>;
  };
  source: 'tree-sitter';
}

export interface PreflightOptions {
  symbol?: string | number;
  /** Disambiguate via file. */
  filePath?: string;
  fromRef?: string;
  toRef?: string;
  /**
   * When true (and no `symbol` was supplied), run range-mode preflight even
   * if `fromRef`/`toRef` are both omitted — uses git's working tree diff to
   * find touched symbols. Lets agents call `seer_preflight` with just a
   * workspace and get a "what changed locally" packet.
   */
  range?: boolean;
  /** Workspace (required when fromRef/toRef supplied). */
  workspace?: string;
  /** Optional bundle paths for contract diff comparison. */
  oldBundle?: string;
  newBundle?: string;
  /** Bound: max symbols returned in touchedSymbols. */
  maxSymbols?: number;
  /** Bound: max tests in likelyTests. */
  maxTests?: number;
  /** Bound: max history rows. */
  maxHistory?: number;
  /** Bound: caller BFS depth. */
  callerDepth?: number;
}

const DEFAULT_MAX_SYMBOLS = 12;
const DEFAULT_MAX_TESTS = 8;
const DEFAULT_MAX_HISTORY = 8;

export async function preflight(
  store: Store, options: PreflightOptions = {},
): Promise<PreflightResult> {
  if (options.symbol !== undefined) {
    return preflightForSymbol(store, options);
  }
  if (options.fromRef !== undefined || options.toRef !== undefined || options.range === true) {
    return preflightForRange(store, options);
  }
  return {
    ok: false,
    reason: 'preflight requires either --symbol or --from/--to',
    mode: 'symbol',
    touchedSymbols: [],
    risk: { overall: 'low', perSymbol: [] },
    likelyTests: [],
    serviceImpact: { inbound: [], outbound: [] },
    history: [],
    historyIndex: store.getHistoryIndexInfo(),
    warnings: ['no input provided'],
    module: null,
    boundaries: { primary: null, crossed: [] },
    source: 'tree-sitter',
  };
}

function preflightForSymbol(
  store: Store, options: PreflightOptions,
): PreflightResult {
  const maxSymbols = options.maxSymbols ?? DEFAULT_MAX_SYMBOLS;
  const maxTests = options.maxTests ?? DEFAULT_MAX_TESTS;
  const maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
  const callerDepth = options.callerDepth ?? 3;

  const ctx = buildContext(store, options.symbol!, {
    filePath: options.filePath,
    callerLimit: 10, calleeLimit: 10,
    testLimit: maxTests, historyLimit: maxHistory,
    callerDepth,
  });
  if (!ctx) {
    return {
      ok: false,
      reason: `no symbol "${options.symbol}"`,
      mode: 'symbol',
      touchedSymbols: [],
      risk: { overall: 'low', perSymbol: [] },
      likelyTests: [],
      serviceImpact: { inbound: [], outbound: [] },
      history: [],
      historyIndex: store.getHistoryIndexInfo(),
      warnings: [`symbol "${options.symbol}" not found in index`],
      module: null,
      boundaries: { primary: null, crossed: [] },
      source: 'tree-sitter',
    };
  }

  const focal: PreflightTouchedSymbol = {
    id: ctx.symbol.id, name: ctx.symbol.name,
    qualifiedName: ctx.symbol.qualifiedName, kind: ctx.symbol.kind,
    file: ctx.symbol.file, lineStart: ctx.symbol.lineStart,
    lineEnd: ctx.symbol.lineEnd,
  };

  const warnings: string[] = collectWarnings(ctx);

  const likelyTests = pickLikelyTestsFromContext(ctx, maxTests);
  // Read service links straight from the store so the real protocol
  // (http/trpc/grpc/kafka/...) is preserved — the ContextPacket preview drops
  // it, and hardcoding 'http' here mislabels non-HTTP links.
  const serviceImpact: PreflightServiceImpact = {
    inbound: store.serviceLinksForHandler(focal.id, { limit: 10 }).map(l => ({
      routePath: l.routePath, routeMethod: l.routeMethod ?? l.callMethod,
      protocol: l.protocol, matchKind: l.matchKind,
      callerName: l.callerQualifiedName ?? l.callerName, callerFile: l.callerFile,
    })),
    outbound: store.serviceLinksForCaller(focal.id, { limit: 10 }).map(l => ({
      routePath: l.routePath, routeMethod: l.routeMethod ?? l.callMethod,
      protocol: l.protocol, matchKind: l.matchKind,
      handlerName: l.handlerQualifiedName ?? l.handlerName, handlerFile: l.handlerFile,
    })),
  };

  const history: PreflightHistoryRow[] = ctx.recentHistory.preview.slice(0, maxHistory).map(h => ({
    sha: h.sha, author: h.author, email: h.email,
    committedAt: h.committedAt, message: h.message,
    linesAdded: h.linesAdded, linesRemoved: h.linesRemoved,
    prNumber: h.prNumber, prUrl: h.prUrl,
  }));

  return {
    ok: true,
    mode: 'symbol',
    symbol: focal,
    touchedSymbols: [focal].slice(0, maxSymbols),
    risk: {
      overall: ctx.risk.risk,
      perSymbol: [{
        symbol: focal,
        risk: ctx.risk.risk,
        score: ctx.risk.score,
        topContributors: pickTopContributions(ctx.risk.signalContributions, 5),
      }],
    },
    likelyTests,
    serviceImpact,
    history,
    historyIndex: ctx.historyIndex,
    warnings,
    module: ctx.module,
    boundaries: {
      primary: ctx.boundary,
      crossed: extractCrossedBoundaries(store, focal.id, ctx.boundary?.id ?? null),
    },
    source: 'tree-sitter',
  };
}

async function preflightForRange(
  store: Store, options: PreflightOptions,
): Promise<PreflightResult> {
  const workspace = options.workspace;
  if (!workspace) {
    return {
      ok: false,
      reason: 'preflight --from/--to requires a workspace (pass workspace option)',
      mode: 'range',
      touchedSymbols: [],
      risk: { overall: 'low', perSymbol: [] },
      likelyTests: [],
      serviceImpact: { inbound: [], outbound: [] },
      history: [],
      historyIndex: store.getHistoryIndexInfo(),
      warnings: ['missing workspace path for range preflight'],
      module: null,
      boundaries: { primary: null, crossed: [] },
      source: 'tree-sitter',
    };
  }
  const maxSymbols = options.maxSymbols ?? DEFAULT_MAX_SYMBOLS;
  const maxTests = options.maxTests ?? DEFAULT_MAX_TESTS;
  const maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
  const callerDepth = options.callerDepth ?? 2;

  const dc = detectChanges(workspace, store, {
    fromRef: options.fromRef, toRef: options.toRef, callerDepth,
  });
  if (dc.directlyChanged.length === 0) {
    return {
      ok: true,
      mode: 'range',
      range: {
        fromRef: dc.fromRef, toRef: dc.toRef,
        changedFiles: dc.changedFiles.length,
        directHunkCount: dc.changedFiles.reduce((acc, f) => acc + f.hunks, 0),
      },
      touchedSymbols: [],
      risk: { overall: 'low', perSymbol: [] },
      likelyTests: [],
      serviceImpact: { inbound: [], outbound: [] },
      history: [],
      historyIndex: store.getHistoryIndexInfo(),
      warnings: ['no symbol-bearing changes detected in range'],
      module: null,
      boundaries: { primary: null, crossed: [] },
      source: 'tree-sitter',
    };
  }

  const touched: PreflightTouchedSymbol[] = dc.directlyChanged.slice(0, maxSymbols).map(s => ({
    id: s.id, name: s.name, qualifiedName: s.qualifiedName, kind: s.kind,
    file: s.filePath, lineStart: s.lineStart, lineEnd: s.lineEnd,
  }));

  const risks: Array<{
    symbol: PreflightTouchedSymbol;
    risk: 'low' | 'medium' | 'high';
    score: number;
    topContributors: Array<{ signal: string; value: number; contribution: number }>;
  }> = [];
  const likelyTests: PreflightLikelyTest[] = [];
  const seenTestKey = new Set<string>();

  const serviceImpact: PreflightServiceImpact = { inbound: [], outbound: [] };
  const allHistory: PreflightHistoryRow[] = [];

  for (const t of touched) {
    const r = computeRisk(store, t.id, { callerDepth });
    if (r) {
      risks.push({
        symbol: t,
        risk: r.risk, score: r.score,
        topContributors: pickTopContributions(r.signalContributions, 4),
      });
    }
    const b = rankedBehavior(store, t.id, { limit: maxTests });
    if (b) {
      for (const test of b.tests) {
        const key = `${test.testSymbol.file}:${test.testSymbol.lineStart}:${test.testSymbol.name}`;
        if (seenTestKey.has(key)) continue;
        seenTestKey.add(key);
        likelyTests.push({
          testSymbol: {
            name: test.testSymbol.name,
            qualifiedName: test.testSymbol.qualifiedName,
            file: test.testSymbol.file,
            lineStart: test.testSymbol.lineStart,
          },
          relationship: test.relationship,
          specificity: test.specificity,
          assertionCount: test.assertionCount,
          graphDistance: test.graphDistance,
        });
        if (likelyTests.length >= maxTests) break;
      }
    }
    const inbound = store.serviceLinksForHandler(t.id, { limit: 5 });
    for (const l of inbound) {
      serviceImpact.inbound.push({
        routePath: l.routePath, routeMethod: l.routeMethod ?? l.callMethod,
        protocol: l.protocol, matchKind: l.matchKind,
        callerName: l.callerQualifiedName ?? l.callerName,
        callerFile: l.callerFile,
      });
    }
    const outbound = store.serviceLinksForCaller(t.id, { limit: 5 });
    for (const l of outbound) {
      serviceImpact.outbound.push({
        routePath: l.routePath, routeMethod: l.routeMethod ?? l.callMethod,
        protocol: l.protocol, matchKind: l.matchKind,
        handlerName: l.handlerQualifiedName ?? l.handlerName,
        handlerFile: l.handlerFile,
      });
    }
    const history = store.getSymbolHistory(t.id, { limit: 3 });
    for (const h of history) {
      allHistory.push({
        sha: h.commitSha, author: h.authorName, email: h.authorEmail,
        committedAt: h.committedAt, message: h.message,
        linesAdded: h.linesAdded, linesRemoved: h.linesRemoved,
        prNumber: h.prNumber, prUrl: h.prUrl,
      });
    }
  }
  // Deduplicate history by sha and sort by committedAt DESC.
  const seenSha = new Set<string>();
  const dedupedHistory: PreflightHistoryRow[] = [];
  allHistory.sort((a, b) => b.committedAt - a.committedAt);
  for (const h of allHistory) {
    if (seenSha.has(h.sha)) continue;
    seenSha.add(h.sha);
    dedupedHistory.push(h);
    if (dedupedHistory.length >= maxHistory) break;
  }

  const overall: 'low' | 'medium' | 'high' = pickOverallRisk(risks.map(r => r.risk));

  const warnings: string[] = [];
  if (risks.some(r => r.risk === 'high')) {
    warnings.push('at least one touched symbol classified as high risk');
  }
  if (dc.changedFiles.some(f => f.symbols.length === 0)) {
    warnings.push('some changed files contain hunks outside known symbol ranges (graph may be stale)');
  }

  // Module label of the first touched symbol — gives the agent a single
  // "you're working in X" pointer.
  const moduleRow = touched.length > 0
    ? store.moduleForFile((store.getSymbolById(touched[0].id)?.fileId ?? -1))
    : null;

  let contractChanges: ContractDiff | undefined;
  if (options.oldBundle && options.newBundle) {
    try {
      contractChanges = await contractDiffSync(options.oldBundle, options.newBundle);
    } catch (err) {
      warnings.push(`contract diff failed: ${(err as Error).message}`);
    }
  }

  return {
    ok: true,
    mode: 'range',
    range: {
      fromRef: dc.fromRef, toRef: dc.toRef,
      changedFiles: dc.changedFiles.length,
      directHunkCount: dc.changedFiles.reduce((acc, f) => acc + f.hunks, 0),
    },
    touchedSymbols: touched,
    risk: { overall, perSymbol: risks },
    likelyTests: likelyTests.slice(0, maxTests),
    serviceImpact,
    contractChanges,
    history: dedupedHistory,
    historyIndex: store.getHistoryIndexInfo(),
    warnings,
    module: moduleRow,
    boundaries: {
      primary: touched.length > 0
        ? store.boundaryForFile((store.getSymbolById(touched[0].id)?.fileId ?? -1))
        : null,
      crossed: extractCrossedBoundariesMany(store, touched),
    },
    source: 'tree-sitter',
  };
}

function extractCrossedBoundaries(
  store: Store, symbolId: number, ownBoundaryId: number | null,
): Array<{ id: number; label: string; kind: string; rootRelPath: string }> {
  if (ownBoundaryId == null) return [];
  const seen = new Map<number, { id: number; label: string; kind: string; rootRelPath: string }>();
  for (const r of store.calleeBoundariesOf(symbolId)) {
    if (r.boundaryId === ownBoundaryId) continue;
    if (seen.has(r.boundaryId)) continue;
    const meta = store.listBoundaries(10000).find(b => b.id === r.boundaryId);
    if (!meta) continue;
    seen.set(r.boundaryId, {
      id: meta.id, label: meta.label, kind: meta.kind, rootRelPath: meta.rootRelPath,
    });
  }
  return Array.from(seen.values());
}

function extractCrossedBoundariesMany(
  store: Store, touched: PreflightTouchedSymbol[],
): Array<{ id: number; label: string; kind: string; rootRelPath: string }> {
  if (touched.length === 0) return [];
  const owns = new Map<number, number | null>();
  for (const s of touched) {
    const meta = store.getSymbolById(s.id);
    if (!meta) continue;
    const b = store.boundaryForFile(meta.fileId);
    owns.set(s.id, b?.id ?? null);
  }
  const seen = new Map<number, { id: number; label: string; kind: string; rootRelPath: string }>();
  const allBoundaries = store.listBoundaries(10000);
  const byId = new Map(allBoundaries.map(b => [b.id, b]));
  for (const s of touched) {
    const ownId = owns.get(s.id);
    if (ownId == null) continue;
    for (const r of store.calleeBoundariesOf(s.id)) {
      if (r.boundaryId === ownId) continue;
      if (seen.has(r.boundaryId)) continue;
      const meta = byId.get(r.boundaryId);
      if (!meta) continue;
      seen.set(r.boundaryId, {
        id: meta.id, label: meta.label, kind: meta.kind, rootRelPath: meta.rootRelPath,
      });
    }
  }
  return Array.from(seen.values());
}

function pickOverallRisk(verdicts: Array<'low' | 'medium' | 'high'>): 'low' | 'medium' | 'high' {
  if (verdicts.includes('high')) return 'high';
  if (verdicts.includes('medium')) return 'medium';
  return 'low';
}

function pickTopContributions(
  contributions: Array<{ signal: string; value: number; contribution: number }>,
  n: number,
): Array<{ signal: string; value: number; contribution: number }> {
  return [...contributions]
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, n);
}

function pickLikelyTestsFromContext(ctx: ContextPacket, maxN: number): PreflightLikelyTest[] {
  return ctx.behavior.preview.slice(0, maxN).map(t => ({
    testSymbol: {
      name: t.name, qualifiedName: t.qualifiedName,
      file: t.file, lineStart: t.lineStart,
    },
    relationship: t.relationship,
    specificity: t.specificity,
    assertionCount: t.assertionCount,
    graphDistance: null,
  }));
}

function collectWarnings(ctx: ContextPacket): string[] {
  const out: string[] = [];
  if (ctx.behavior.direct === 0 && ctx.behavior.indirect === 0) {
    out.push('no direct or indirect test coverage detected');
  }
  if (ctx.risk.risk === 'high') {
    out.push('risk classified as high; inspect signal contributions before editing');
  }
  if (ctx.routes.length > 0 && ctx.behavior.direct === 0) {
    out.push('symbol is route-exposed but lacks direct tests');
  }
  return out;
}

// Wrap the async contractDiff so the sync-shaped range helper above doesn't
// need to be split into multiple async branches; we await it once.
async function contractDiffSync(oldBundle: string, newBundle: string): Promise<ContractDiff> {
  return await contractDiff(oldBundle, newBundle);
}
