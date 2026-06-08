import path from 'path';
import fs from 'fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Store } from '../db/store.js';
import { Indexer } from '../indexer/index.js';
import { jitSync } from '../indexer/freshness.js';
import { SeerWatcher } from '../indexer/watcher.js';
import { gitHeadSha } from '../indexer/git.js';
import { buildArchitecture } from '../indexer/architecture.js';
import { detectChanges } from '../indexer/detectchanges.js';
import { collectChurn } from '../indexer/churn.js';
import { buildSymbolHistory, parseHistorySince } from '../indexer/symbolhistory.js';
import { buildModules } from '../indexer/modules.js';
import { rankedBehavior } from '../indexer/behavior.js';
import { computeRisk } from '../indexer/risk.js';
import { buildContext } from '../indexer/context.js';
import { exportBundle } from '../bundle/export.js';
import { importBundle, readBundleManifest } from '../bundle/import.js';
import { importExternalBundle } from '../bundle/external.js';
import { contractDiff } from '../bundle/contract.js';
import { preflight } from '../indexer/preflight.js';
import { getContinuityForSymbol, buildContinuity } from '../indexer/continuity.js';
import { importScip } from '../scip/import.js';
import { findDuplicates, buildShapeHashes } from '../indexer/shapehash.js';
import { buildSkeleton } from '../indexer/skeleton.js';
import { computeCoupling } from '../indexer/coupling.js';
import { attachCallSiteSnippets } from '../indexer/snippets.js';
import {
  AgentNextBestCall, AgentPrecision, AgentWarning,
  agentWarning, boundedPrecision, boundedUnquantifiedPrecision,
  exactPrecision, heuristicPrecision,
  nameAggregatePrecision, nextBestCall, unknownPrecision,
} from '../indexer/agentMetadata.js';

/**
 * Seer MCP server.
 *
 * Exposes the read/query surface of the Store (plus a few opt-in maintenance
 * actions) as MCP tools over stdio. The authoritative, always-current list of
 * tools — names, schemas, and descriptions — is registerTools() below; this
 * header deliberately does not enumerate them so it can't drift out of date.
 *
 * Cross-cutting behavior layered on top of the raw handlers:
 *   - JIT freshness (ensureFresh) keeps query results current without blocking
 *     on a full reconcile when a clean watcher already vouches for the index.
 *   - Per-tool timeouts (runToolWithTimeout) and uniform error payloads.
 *   - Client hints + did-you-mean suggestions (withClientHints, suggestSymbols).
 *   - Lazy auto-build of derived indexes (modules / shape hashes / continuity)
 *     on first query against a cold DB.
 *   - seer_batch / seer_trace dispatch other tools in-process via `handlers`.
 */

export interface McpServerOptions {
  workspace: string;
  dbPath?: string;
  watch?: boolean;
  jit?: boolean;
}

import {
  TraceMode, TraceReach, TraceItem, TraceRow,
  CORE_ALWAYS_LOAD_TOOLS, MAINTENANCE_TOOLS, SIDE_EFFECTING_TOOLS,
  TRACE_PREVIEW_LIMIT, TRACE_FULL_LIMIT, TRACE_SUMMARY_SAMPLE_LIMIT, TRACE_SQL_CHUNK_SIZE,
  DEFAULT_MCP_TOOL_TIMEOUT_MS, DEFAULT_MCP_MAINTENANCE_TIMEOUT_MS, DEFAULT_FRESHNESS_WAIT_MS,
  DEFAULT_HISTORY_BUILD_SECONDS, DEFAULT_HISTORY_GIT_TIMEOUT_MS,
  SeerToolError, SeerToolTimeoutError, mcpInstructions,
} from './server-support.js';

export class SeerMcpServer {
  private store!: Store;
  private indexer!: Indexer;
  private watcher: SeerWatcher | null = null;
  private mcp: McpServer;
  private startedAt = Date.now();
  private workspace: string;
  private dbPath: string;
  private jitEnabled: boolean;
  private watchEnabled: boolean;
  private jitPromise: Promise<void> | null = null;
  private backgroundJitPromise: Promise<void> | null = null;
  private lastReconcileMs = 0;
  /**
   * How long a watcher-confirmed-clean index is trusted before the per-query
   * JIT pass pays for another full-workspace re-discovery. The background
   * chokidar watcher marks files dirty on OS events, so within this window a
   * clean watcher means the workspace probably cannot have drifted, so we skip
   * the walk and keep normal queries cheap. The periodic full reconcile is a
   * fallback for missed filesystem events; override with SEER_JIT_FULL_RECONCILE_MS.
   */
  private static readonly DEFAULT_RECONCILE_THROTTLE_MS = 30_000;

  constructor(options: McpServerOptions) {
    this.workspace = path.resolve(options.workspace);
    this.dbPath = options.dbPath ?? path.join(this.workspace, '.seer', 'graph.db');
    this.jitEnabled = options.jit ?? true;
    this.watchEnabled = options.watch ?? true;

    this.mcp = new McpServer(
      { name: 'seer', version: '0.1.0' },
      { instructions: mcpInstructions() },
    );
    this.registerTools();
  }

  async start(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.store = new Store(this.dbPath);
    this.indexer = new Indexer(this.store);

    const stats = this.store.getStats();
    if (stats.files === 0) {
      process.stderr.write(`[seer-mcp] empty index; running initial index...\n`);
      const r = await this.indexer.indexDirectory(this.workspace, { quiet: true });
      process.stderr.write(`[seer-mcp] initial index: ${r.filesIndexed} files, ${r.symbols} symbols, ${r.elapsedMs}ms\n`);
      // Freshly indexed — the workspace is current as of now, so the first
      // query can take the cheap throttled path instead of re-walking.
      this.lastReconcileMs = Date.now();
    } else {
      // A pre-existing index may have drifted while the server was down. Trust
      // it for the first queries (cheap path) but kick ONE reconcile in the
      // background so any offline edits heal without blocking startup or the
      // first tool call. The Indexer serializes this against the watcher.
      this.lastReconcileMs = Date.now();
      void (async () => {
        try { await jitSync(this.store, this.indexer, this.workspace, { maxDirty: 200 }); }
        catch (err) { process.stderr.write(`[seer-mcp] startup reconcile failed: ${err}\n`); }
        finally { this.lastReconcileMs = Date.now(); }
      })();
    }

    if (this.watchEnabled) {
      this.watcher = new SeerWatcher(this.workspace, this.indexer, {
        log: (m) => process.stderr.write(`[watcher] ${m}\n`),
      });
      this.watcher.start();
    }

    const transport = new StdioServerTransport();
    await this.mcp.connect(transport);
    process.stderr.write(`[seer-mcp] ready  workspace=${this.workspace}\n`);
  }

  async stop(): Promise<void> {
    if (this.watcher) await this.watcher.stop();
    try { this.store.close(); } catch { /* */ }
  }

  private reconcileThrottleMs(): number {
    const raw = Number(process.env.SEER_JIT_FULL_RECONCILE_MS);
    if (Number.isFinite(raw) && raw >= 1000) return raw;
    return SeerMcpServer.DEFAULT_RECONCILE_THROTTLE_MS;
  }

  private freshnessWaitMs(): number {
    const raw = Number(process.env.SEER_MCP_FRESHNESS_WAIT_MS);
    if (Number.isFinite(raw) && raw >= 0) return raw;
    return DEFAULT_FRESHNESS_WAIT_MS;
  }

  private startBackgroundJit(reason: string): void {
    if (this.backgroundJitPromise) return;
    const trace = process.env.SEER_JIT_TRACE === '1';
    const t0 = Date.now();
    this.backgroundJitPromise = (async () => {
      try {
        const r = await jitSync(this.store, this.indexer, this.workspace, { maxDirty: 200 });
        if (trace) {
          process.stderr.write(
            `[seer-mcp] background JIT (${reason}): dirty=${r.dirtyReindexed} added=${r.added} ` +
            `removed=${r.removed} in ${Date.now() - t0}ms\n`,
          );
        }
      } catch (err) {
        process.stderr.write(`[seer-mcp] background JIT failed (${reason}): ${err}\n`);
      } finally {
        this.lastReconcileMs = Date.now();
        this.backgroundJitPromise = null;
      }
    })();
  }

  private async waitForFreshness(promise: Promise<void>): Promise<void> {
    const timeoutMs = this.freshnessWaitMs();
    if (timeoutMs === 0) {
      throw new SeerToolError('index freshness check is running', {
        ok: false,
        error: 'index_freshness_busy',
        reason: 'Index freshness is running in the background. Retry shortly or call seer_health for watcher status.',
      });
    }
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SeerToolError('index freshness timed out', {
        ok: false,
        error: 'index_freshness_busy',
        timeoutMs,
        reason: 'Index freshness did not finish within the MCP wait budget. Retry shortly or run seer_reindex explicitly.',
      })), timeoutMs);
    });
    try {
      await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async ensureFresh(): Promise<void> {
    if (!this.jitEnabled) return;
    // Coalesce concurrent queries onto a single in-flight reconcile.
    if (this.jitPromise) { await this.waitForFreshness(this.jitPromise); return; }

    // Fast path: when the background watcher is running it marks files dirty on
    // OS file events. If it reports nothing pending AND a watcher/JIT pass
    // recently reconciled, we trust that signal and skip the full-workspace
    // discovery walk. This keeps steady-state queries close to seer_health
    // cost while a periodic full reconcile still catches missed events.
    // This is the fix for `seer_stats` (and every other
    // JIT-gated tool) taking many seconds while `seer_health` stayed instant:
    // the walk + any cascading reindex used to run on EVERY query. Without a
    // watcher (`--no-watch`) there is no background freshness signal, so we
    // always reconcile to preserve per-query correctness.
    const watcherStatus = this.watcher?.syncStatus() ?? null;
    const watcherClean = this.watcher != null && !this.watcher.isDirty();
    const lastKnownCleanMs = Math.max(this.lastReconcileMs, watcherStatus?.lastSyncMs ?? 0);
    if (watcherClean) {
      // A clean watcher is the steady-state signal. Never block a user query on
      // a periodic full workspace scan; kick that scan in the background so
      // large repos do not turn ordinary searches into minute-long waits.
      if ((Date.now() - lastKnownCleanMs) >= this.reconcileThrottleMs()) {
        this.startBackgroundJit('periodic clean-watcher reconcile');
      }
      return;
    }

    if (this.watcher && this.watcher.isDirty()) {
      void this.watcher.syncNow().catch(err => process.stderr.write(`[seer-mcp] watcher sync failed: ${err}\n`));
      throw new SeerToolError('index is syncing changes', {
        ok: false,
        error: 'index_sync_in_progress',
        watcher: watcherStatus,
        reason: 'The workspace index is syncing file changes. Retry shortly or call seer_health for current watcher status.',
      });
    }

    const trace = process.env.SEER_JIT_TRACE === '1';
    const t0 = Date.now();
    this.jitPromise = (async () => {
      try {
        const r = await jitSync(this.store, this.indexer, this.workspace, { maxDirty: 200 });
        if (trace) {
          process.stderr.write(
            `[seer-mcp] JIT reconcile: dirty=${r.dirtyReindexed} added=${r.added} ` +
            `removed=${r.removed} in ${Date.now() - t0}ms\n`,
          );
        }
      } catch (err) { process.stderr.write(`[seer-mcp] JIT failed: ${err}\n`); }
      finally { this.lastReconcileMs = Date.now(); this.jitPromise = null; }
    })();
    await this.waitForFreshness(this.jitPromise);
  }

  private text(obj: unknown): { content: Array<{ type: 'text'; text: string }> } {
    // Compact (no pretty-print) on purpose. The consumer is an LLM agent, and
    // 2-space indentation added ~25% pure-whitespace tokens to EVERY response —
    // a direct tax on Seer's core promise (lower tokens). Agents parse compact
    // JSON fine, and this also makes budgetedText/seer_search budget accounting
    // exact, since those already measure with a compact JSON.stringify.
    return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
  }

  /**
   * Registry of every tool handler, keyed by name. Mirrors the MCP registration
   * so seer_batch can dispatch internally without a second round-trip. The
   * wrapper stores the raw handler and forwards to the SDK unchanged.
   */
  private handlers = new Map<string, (args: any) => Promise<any>>();
  /**
   * The zod object schema for each tool, reconstructed from its raw inputSchema
   * shape. The MCP SDK validates protocol-level calls against this before the
   * handler runs, but in-process delegation (seer_batch / seer_trace) bypasses
   * that layer — so we re-run the same schema there. See validateToolArgs().
   */
  private toolSchemas = new Map<string, z.ZodTypeAny>();

  private registerTool(
    name: string,
    def: { description?: string; inputSchema?: Record<string, any>; [k: string]: any },
    handler: (args: any) => Promise<any>,
  ): void {
    const wrapped = async (args: any): Promise<any> => {
      try {
        return await this.runToolWithTimeout(name, handler, args);
      } catch (err) {
        return this.text(this.toolErrorPayload(name, err));
      }
    };
    this.handlers.set(name, wrapped);
    if (def.inputSchema && Object.keys(def.inputSchema).length > 0) {
      try { this.toolSchemas.set(name, z.object(def.inputSchema)); } catch { /* */ }
    }
    (this.mcp.registerTool as any)(name, this.withClientHints(name, def), wrapped);
  }

  /**
   * Validate delegated args against a tool's declared schema before an
   * in-process dispatch (seer_batch / seer_trace). Without this, a missing
   * required field (e.g. a seer_definition call with no `name`) reached the
   * store as `undefined` and surfaced as an opaque "cannot be bound to SQLite
   * parameter" error instead of a clean validation message. Returns the parsed
   * args (defaults applied, unknown keys stripped) on success.
   */
  private validateToolArgs(
    toolName: string, rawArgs: unknown,
  ): { ok: true; data: any } | { ok: false; error: string } {
    const schema = this.toolSchemas.get(toolName);
    if (!schema) return { ok: true, data: rawArgs ?? {} };
    const parsed = schema.safeParse(rawArgs ?? {});
    if (parsed.success) return { ok: true, data: parsed.data };
    const issues = parsed.error.issues
      .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `invalid args for ${toolName}: ${issues}` };
  }

  private toolTimeoutMs(name: string): number {
    const env = Number(process.env.SEER_MCP_TOOL_TIMEOUT_MS);
    if (Number.isFinite(env) && env >= 0) return env;
    if (this.isMaintenanceTool(name)) return DEFAULT_MCP_MAINTENANCE_TIMEOUT_MS;
    return DEFAULT_MCP_TOOL_TIMEOUT_MS;
  }

  private isMaintenanceTool(name: string): boolean {
    return MAINTENANCE_TOOLS.has(name);
  }

  private isSideEffectingTool(name: string): boolean {
    return SIDE_EFFECTING_TOOLS.has(name);
  }

  /**
   * MCP clients often expose server tools as `mcp__<server>__seer_tool` even
   * though Seer's in-process handler registry is keyed by the short
   * `seer_tool` name. `seer_batch` accepts either spelling so agents can paste
   * the visible tool name without knowing about this internal registry.
   */
  private normalizeDelegatedToolName(rawName: string): { toolName: string; requestedTool?: string } {
    if (!rawName.startsWith('mcp__')) return { toolName: rawName };
    const last = rawName.split('__').pop() ?? rawName;
    if (!last.startsWith('seer_')) return { toolName: rawName };
    return { toolName: last, requestedTool: rawName };
  }

  private countShortNameDefinitions(name: string): number {
    try { return this.store.countDefinitionsByShortName(name); }
    catch { return 0; }
  }

  private ambiguityPrecision(ambiguity: { reason: string; likelyCallersEstimate: { lowerBound: number; upperBound: number } }): AgentPrecision {
    return boundedPrecision(
      ambiguity.likelyCallersEstimate.lowerBound,
      ambiguity.likelyCallersEstimate.upperBound,
      'call-sites',
      ambiguity.reason === 'unresolved-receiver-type'
        ? 'C/C++ receiver type is unresolved; resolved callers are a lower bound.'
        : 'This short name is shared; by-name callers are an upper bound.',
    );
  }

  private ambiguityGraphPrecision(): AgentPrecision {
    return boundedUnquantifiedPrecision(
      'Graph traversal starts from id-resolved edges; unresolved receiver types can hide additional graph edges.',
    );
  }

  private ambiguityWarning(ambiguity: { reason: string }): AgentWarning {
    return agentWarning(
      'caller-undercount',
      ambiguity.reason === 'unresolved-receiver-type'
        ? 'Resolved caller counts may undercount this C/C++ member because receiver types are unresolved.'
        : 'This short name is shared; by-name caller counts include other definitions.',
    );
  }

  private ambiguityNextCall(
    target: { name: string; qualifiedName: string | null; filePath: string },
    state: { groupByFile?: boolean; includeNameMatches?: boolean; receiverFilter?: boolean } = {},
  ): AgentNextBestCall | undefined {
    const base = { symbol: target.qualifiedName ?? target.name, file: target.filePath };
    if (!state.groupByFile) {
      return nextBestCall(
        'seer_callers',
        { ...base, groupByFile: true },
        'Resolved callers are bounded; groupByFile shows where same-name call sites concentrate.',
      );
    }
    if (!state.includeNameMatches) {
      return nextBestCall(
        'seer_callers',
        { ...base, includeNameMatches: true, limit: 40 },
        'You already have the by-file breakdown; includeNameMatches pages the same-name call sites.',
      );
    }
    if (!state.receiverFilter) {
      return nextBestCall(
        'seer_callers',
        { ...base, filterReceiverType: true, limit: 40 },
        'You already have same-name sites; filterReceiverType tries to attribute them to the target class.',
      );
    }
    return undefined;
  }

  private nameAggregateNextCall(symbol: string): AgentNextBestCall {
    return nextBestCall(
      'seer_definition',
      { name: symbol, tokenBudget: 4000 },
      'This bare name matches multiple definitions; inspect definitions, then re-call with file or a qualified name.',
    );
  }

  private nameAmbiguityWarning(symbol: string, count: number): AgentWarning {
    return agentWarning(
      'ambiguous-target',
      `Bare name "${symbol}" resolved to the highest-ranked definition, but ${count} other definition(s) exist.`,
    );
  }

  private async runToolWithTimeout(
    name: string,
    handler: (args: any) => Promise<any>,
    args: any,
  ): Promise<any> {
    const timeoutMs = this.toolTimeoutMs(name);
    if (timeoutMs === 0) return handler(args);
    const pending = handler(args);
    let timer: NodeJS.Timeout | null = null;
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new SeerToolTimeoutError(name, timeoutMs));
      }, timeoutMs);
    });
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        pending.catch((err: unknown) => {
          process.stderr.write(`[seer-mcp] ${name} finished after timeout/failure: ${(err as Error).message ?? err}\n`);
        });
      }
    }
  }

  private toolErrorPayload(name: string, err: unknown): Record<string, unknown> {
    if (err instanceof SeerToolError) return { tool: name, ...err.payload };
    if (err instanceof SeerToolTimeoutError) {
      return {
        ok: false,
        tool: name,
        error: 'tool_timeout',
        timeoutMs: err.timeoutMs,
        reason: `${name} exceeded the MCP timeout budget. Narrow the query, use summary/pagination, or run the explicit CLI/build command for long maintenance work.`,
      };
    }
    return {
      ok: false,
      tool: name,
      error: 'tool_failed',
      reason: (err as Error).message ?? String(err),
    };
  }

  private withClientHints(
    name: string,
    def: { description?: string; inputSchema?: Record<string, any>; [k: string]: any },
  ): { description?: string; inputSchema?: Record<string, any>; [k: string]: any } {
    const sideEffecting = this.isSideEffectingTool(name);
    const annotations = sideEffecting
      ? {
          readOnlyHint: false,
          openWorldHint: false,
          ...(def.annotations ?? {}),
        }
      : {
          readOnlyHint: true,
          openWorldHint: false,
          ...(def.annotations ?? {}),
        };
    const meta = CORE_ALWAYS_LOAD_TOOLS.has(name)
      ? {
          ...(def._meta ?? {}),
          'anthropic/alwaysLoad': true,
        }
      : def._meta;
    return {
      ...def,
      annotations,
      ...(meta ? { _meta: meta } : {}),
    };
  }

  /**
   * Up to 5 deterministic fuzzy suggestions (BM25 over the camel/snake-split
   * FTS index) for a name that resolved to nothing. SUGGESTION-ONLY: callers
   * surface these under a `didYouMean` key, never substitute them for a real
   * lookup. Returning a guessed symbol as if exact would be exactly the
   * "misleading information" Seer's contract forbids.
   */
  private suggestSymbols(name: string): Array<{
    name: string; qualifiedName: string | null; kind: string; file: string; lineStart: number;
  }> {
    let rows;
    try { rows = this.store.searchSymbolsFts(name, { limit: 5 }); }
    catch { return []; }
    return rows.map(r => ({
      name: r.name, qualifiedName: r.qualifiedName, kind: r.kind,
      file: r.filePath, lineStart: r.lineStart,
    }));
  }

  /**
   * Honest blast-radius bounds for a resolved caller target. id-resolved callers
   * (`countCallersById`) are PRECISE but can badly understate reality when the
   * call edges only carry a short name: C/C++ member calls (`obj->add_child()`)
   * lose the receiver's static type, so tree-sitter can't bind them to THIS
   * `Node.add_child` — they scatter across every same-named definition during
   * global fallback. When that happens the id-resolved count (e.g. 6) is a lower
   * bound and the name-level call-site count (e.g. 4252) is the upper bound. We
   * surface BOTH so an agent sizing a refactor isn't misled into "only 6 callers".
   * Returns undefined when the name is unambiguous (no extra context needed).
   */
  private callerAmbiguity(target: {
    id: number; name: string; filePath: string; total: number;
  }): {
    reason: 'unresolved-receiver-type' | 'shared-short-name';
    shortName: string;
    sharedByDefinitions: number;
    nameCallsites: number;
    resolvedCallsites: number;
    likelyCallersEstimate: {
      unit: 'call-sites';
      lowerBound: number;
      upperBound: number;
      confidence: 'bounded';
    };
    note: string;
  } | undefined {
    const shortName = target.name;
    if (!shortName) return undefined;
    let sharedDefs = 0;
    let nameCallsites = 0;
    try {
      sharedDefs = this.store.countDefinitionsByShortName(shortName);
      nameCallsites = this.store.countCallers(shortName);
    } catch { return undefined; }
    // Only meaningful when the name is shared AND more call sites use the bare
    // name than resolved to this id (i.e. the resolver could not attribute them).
    if (sharedDefs <= 1 || nameCallsites <= target.total) return undefined;
    const lc = target.filePath.toLowerCase();
    const dot = lc.lastIndexOf('.');
    const ext = dot === -1 ? '' : lc.slice(dot);
    const cppExts = new Set(['.c', '.cc', '.cpp', '.cxx', '.c++', '.h', '.hh', '.hpp', '.hxx', '.h++', '.inl', '.ino']);
    const reason = cppExts.has(ext) ? 'unresolved-receiver-type' as const : 'shared-short-name' as const;
    const note = reason === 'unresolved-receiver-type'
      ? `Likely undercount: ${target.total} resolved call site(s), ${nameCallsites} by-name site(s) across ${sharedDefs} "${shortName}" definitions. Receiver types are unresolved in C/C++; use includeNameMatches/groupByFile/filterReceiverType to narrow.`
      : `Shared short name: ${target.total} resolved call site(s), ${nameCallsites} by-name site(s) across ${sharedDefs} "${shortName}" definitions. The by-name count is an upper bound.`;
    return {
      reason,
      shortName,
      sharedByDefinitions: sharedDefs,
      nameCallsites,
      resolvedCallsites: target.total,
      likelyCallersEstimate: {
        unit: 'call-sites' as const,
        lowerBound: target.total,
        upperBound: nameCallsites,
        confidence: 'bounded' as const,
      },
      note,
    };
  }

  /**
   * When a BARE (file-less, unqualified) symbol name resolves to MORE THAN ONE
   * definition, the symbol tools silently use the highest-PageRank one. On the
   * Godot DB `add_child` resolves to `FabrikInverseKinematic::ChainItem::add_child`
   * (pr 0.0002) instead of `Node::add_child` (pr 0.0000) — so an agent that asked
   * about the wrong symbol got plausible-but-wrong data and no signal it happened.
   * This returns a compact hint (chosen def + a few alternatives) so the agent
   * knows to pass `file=` / a qualified name. Returns undefined when unambiguous,
   * a file was given, or the name is already qualified. One cheap indexed lookup.
   */
  private nameAmbiguityHint(symbol: string, file: string | undefined): {
    note: string;
    totalDefinitions: number;
    otherDefinitionsCount: number;
    resolvedTo: { qualifiedName: string; file: string; lineStart: number };
    otherDefinitions: Array<{ qualifiedName: string; file: string; lineStart: number }>;
  } | undefined {
    if (file) return undefined;
    if (symbol.includes('.') || symbol.includes('::')) return undefined;
    let defs;
    try { defs = this.store.getDefinition(symbol); } catch { return undefined; }
    if (defs.length <= 1) return undefined;
    const [chosen, ...rest] = defs;
    return {
      totalDefinitions: defs.length,
      otherDefinitionsCount: rest.length,
      resolvedTo: { qualifiedName: chosen.qualifiedName ?? chosen.name, file: chosen.filePath, lineStart: chosen.lineStart },
      otherDefinitions: rest.slice(0, 4).map(d => ({
        qualifiedName: d.qualifiedName ?? d.name, file: d.filePath, lineStart: d.lineStart,
      })),
      note: `Top match: ${chosen.qualifiedName ?? chosen.name}; ${rest.length} other definition(s). Pass file= or a qualified Class::method to narrow.`,
    };
  }

  /**
   * Explain a "no symbol" miss that is really a declaration-vs-definition gap.
   * The default symbol search excludes declarations (header prototypes, forward
   * decls), so `seer_context { symbol, file: "node.h" }` returns nothing while
   * the same name in `node.cpp` works — the Codex "felt inconsistent" report.
   * When the name resolves ONLY to a declaration, return a hint naming the
   * declaration site(s) and where the real definition lives. Undefined when no
   * declaration exists (so a genuine miss stays a genuine miss).
   */
  private declarationHint(symbol: string, file: string | undefined): {
    note: string;
    declarations: Array<{ qualifiedName: string; file: string; lineStart: number }>;
    definition?: { qualifiedName: string; file: string; lineStart: number };
  } | undefined {
    let withDecls;
    try { withDecls = this.store.getDefinition(symbol, { filePath: file, includeDeclarations: true }); }
    catch { return undefined; }
    const decls = (withDecls ?? []).filter(d => d.symbolRole === 'declaration');
    if (decls.length === 0) return undefined;
    // Point at the definition that matches the DECLARATION's own class, not the
    // globally-highest-PageRank same-named symbol. For `add_child` in node.h the
    // decl is `Node.add_child`, so resolve THAT — otherwise the hint would send
    // the agent to an unrelated `ChainItem.add_child` that merely ranks higher.
    let definition;
    const declQn = decls[0].qualifiedName;
    try {
      definition = (declQn ? this.store.getDefinition(declQn)[0] : undefined)
        ?? this.store.getDefinition(symbol)[0];
    } catch { /* */ }
    const defNote = definition ? ` Its definition is in ${definition.filePath}` : '';
    return {
      note: `"${symbol}"${file ? ` in ${file}` : ''} resolved only to a DECLARATION (e.g. a header prototype), which symbol tools skip by default.${defNote}. Re-call with the definition's file, or pass includeDeclarations to inspect the declaration itself.`,
      declarations: decls.slice(0, 4).map(d => ({ qualifiedName: d.qualifiedName ?? d.name, file: d.filePath, lineStart: d.lineStart })),
      ...(definition ? { definition: { qualifiedName: definition.qualifiedName ?? definition.name, file: definition.filePath, lineStart: definition.lineStart } } : {}),
    };
  }

  /** The class segment of a dotted qualified name (`Node.add_child` → `Node`,
   *  `A.B.method` → `B`). Undefined for an unqualified name. Used to infer the
   *  receiver type when `filterReceiverType: true`. */
  private classOfQualified(qualifiedName: string | null | undefined): string | undefined {
    if (!qualifiedName) return undefined;
    const parts = qualifiedName.split('.');
    return parts.length >= 2 ? parts[parts.length - 2] : undefined;
  }

  /** Does a bounded same-file window show `recv` locally typed as `type`?
   *  Matches the common C/C++ shapes: `T* v` / `T v` / `T& v`, `Ref<T> v`, and
   *  `v = memnew(T...)` / `v = cast_to<T>` / `Object::cast_to<T>`. */
  private receiverLocallyTyped(recv: string, type: string, hay: string): boolean {
    const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const T = esc(type), v = esc(recv);
    return new RegExp(
      `\\b${T}\\b\\s*[*&]?\\s*\\b${v}\\b` +
      `|Ref\\s*<\\s*${T}\\s*>\\s*\\b${v}\\b` +
      `|\\b${v}\\b\\s*=\\s*(?:memnew\\s*\\(\\s*${T}\\b|(?:Object::)?cast_to\\s*<\\s*${T}\\s*>)`,
    ).test(hay);
  }

  /**
   * Best-effort attribution of type-unresolved by-name call sites to a receiver
   * class. C/C++ member calls lose the receiver's static type, so `add_child`
   * scatters across thousands of sites that could belong to `Node`, `TreeItem`,
   * etc. For each candidate call line this reads the receiver token and looks
   * back a bounded same-file window for a local typing, bucketing the site as:
   *   - confirmedTarget  — receiver locally typed as `type`
   *   - confirmedSibling — receiver locally typed as another same-named class
   *                        (this is the "discard TreeItem->add_child" the review
   *                        agents asked for)
   *   - unresolved       — no local type evidence (typed elsewhere / implicit
   *                        `this` / macro). The HONEST majority for C++.
   * Bounded (caps the scan, reads each file once). It is deliberately not a
   * precise count: SCIP import is the precise path. The value is a high-precision
   * lower bound for the target plus a confident exclusion of siblings.
   */
  private filterCallersByReceiverType(
    callers: Array<{ callerName: string; callerQualifiedName: string | null; callerKind: string; callerFile: string; callerLine: number; edgeKind: string }>,
    methodName: string,
    type: string,
    siblingTypes: string[],
    cap = 6000,
  ): {
    type: string;
    siblingTypes: string[];
    scannedSites: number;
    confirmedTargetSites: number;
    confirmedSiblingSites: number;
    confirmedSiblingByType: Record<string, number>;
    unresolvedSites: number;
    capped: boolean;
    note: string;
    items: Array<{ callerName: string; callerQualifiedName: string | null; callerKind: string; file: string; line: number; edgeKind: string }>;
  } {
    const scan = callers.slice(0, cap);
    const fileCache = new Map<string, string[] | null>();
    const readLines = (f: string): string[] | null => {
      if (fileCache.has(f)) return fileCache.get(f) ?? null;
      let lines: string[] | null = null;
      try { lines = fs.readFileSync(f, 'utf8').split(/\r?\n/); } catch { lines = null; }
      fileCache.set(f, lines);
      return lines;
    };
    const recvRe = new RegExp(`([A-Za-z_]\\w*)\\s*(?:->|\\.)\\s*${methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const confirmedTarget: typeof scan = [];
    const siblingCounts: Record<string, number> = {};
    let confirmedSibling = 0;
    let unresolved = 0;
    for (const c of scan) {
      const lines = readLines(c.callerFile);
      if (!lines) { unresolved++; continue; }
      const m = recvRe.exec(lines[c.callerLine] ?? '');
      if (!m) { unresolved++; continue; }
      const recv = m[1];
      const hay = lines.slice(Math.max(0, c.callerLine - 200), c.callerLine + 1).join('\n');
      if (this.receiverLocallyTyped(recv, type, hay)) { confirmedTarget.push(c); continue; }
      const sib = siblingTypes.find(s => this.receiverLocallyTyped(recv, s, hay));
      if (sib) { siblingCounts[sib] = (siblingCounts[sib] ?? 0) + 1; confirmedSibling++; continue; }
      unresolved++;
    }
    return {
      type,
      siblingTypes,
      scannedSites: scan.length,
      confirmedTargetSites: confirmedTarget.length,
      confirmedSiblingSites: confirmedSibling,
      confirmedSiblingByType: siblingCounts,
      unresolvedSites: unresolved,
      capped: callers.length > cap,
      note: `Best-effort receiver attribution (C/C++ has no static receiver type without SCIP). Of ${scan.length} scanned by-name site(s): ${confirmedTarget.length} are locally typed as ${type}, ${confirmedSibling} as a same-named sibling (excluded), and ${unresolved} have no local type evidence (receiver typed elsewhere / implicit this / macro). Treat confirmedTargetSites as a lower bound and (total - confirmedSiblingSites) as the upper bound; for a precise count import a SCIP index.`,
      items: confirmedTarget.map(c => ({
        callerName: c.callerName, callerQualifiedName: c.callerQualifiedName,
        callerKind: c.callerKind, file: c.callerFile, line: c.callerLine, edgeKind: c.edgeKind,
      })),
    };
  }

  /**
   * Emit a list response under a deterministic token budget. Items are assumed
   * pre-sorted by relevance, so we prefix-trim: keep appending until the
   * serialized payload would exceed `tokenBudget * 4` chars (~4 chars/token).
   * Without a budget the output is byte-identical to the previous behavior.
   */
  private budgetedText(
    base: Record<string, unknown>,
    items: unknown[],
    tokenBudget?: number,
    key = 'items',
  ): { content: Array<{ type: 'text'; text: string }> } {
    if (!tokenBudget || tokenBudget <= 0) {
      return this.text({ ...base, returned: items.length, [key]: items });
    }
    const budgetChars = tokenBudget * 4;
    const kept: unknown[] = [];
    for (const it of items) {
      kept.push(it);
      const len = JSON.stringify({ ...base, returned: kept.length, [key]: kept }).length;
      // Always keep at least one item; stop once we cross the budget.
      if (len > budgetChars) break;
    }
    const truncated = kept.length < items.length;
    const out: Record<string, unknown> = { ...base, returned: kept.length, [key]: kept };
    if (truncated) {
      out.truncated = true;
      out.omitted = items.length - kept.length;
      out.tokenBudget = tokenBudget;
      out.note = `Output trimmed to ~${tokenBudget} tokens (${kept.length}/${items.length} items shown). Raise tokenBudget, add a filter, or paginate for the rest.`;
    }
    return this.text(out);
  }

  private traceMode(mode?: TraceMode, summaryOnly?: boolean): TraceMode {
    if (summaryOnly) return 'summary';
    return mode ?? 'preview';
  }

  private traceLimit(mode: TraceMode, limit?: number): number {
    return Math.min(limit ?? (mode === 'full' ? TRACE_FULL_LIMIT : TRACE_PREVIEW_LIMIT), 500);
  }

  private loadTraceItems(
    hits: TraceReach[],
    pageOffset: number,
    pageLimit: number,
  ): { items: TraceItem[]; pageItems: TraceItem[]; sampled: boolean } {
    if (hits.length === 0) return { items: [], pageItems: [], sampled: false };

    const sample = hits.slice(0, TRACE_SUMMARY_SAMPLE_LIMIT);
    const page = hits.slice(pageOffset, pageOffset + pageLimit);
    const combinedById = new Map<number, TraceReach>();
    for (const h of sample) combinedById.set(h.id, h);
    for (const h of page) combinedById.set(h.id, h);
    const combined = Array.from(combinedById.values());

    const depthById = new Map<number, number>();
    for (const h of combined) depthById.set(h.id, h.depth);

    const byId = new Map<number, TraceItem>();
    const db = this.store.rawDb();
    for (let i = 0; i < combined.length; i += TRACE_SQL_CHUNK_SIZE) {
      const ids = combined.slice(i, i + TRACE_SQL_CHUNK_SIZE).map(h => h.id);
      const ph = ids.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT s.id, s.name, s.qualified_name AS qualifiedName, s.kind,
               f.path AS file, s.line_start AS lineStart, s.pagerank
        FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE s.id IN (${ph})
      `).all(...ids) as unknown as TraceRow[];
      for (const row of rows) {
        const id = Number(row.id);
        byId.set(id, {
          id,
          name: String(row.name),
          qualifiedName: row.qualifiedName == null ? null : String(row.qualifiedName),
          kind: String(row.kind),
          file: String(row.file),
          lineStart: Number(row.lineStart),
          pagerank: Number(row.pagerank ?? 0),
          depth: depthById.get(id) ?? 0,
        });
      }
    }

    const toItem = (h: TraceReach): TraceItem => byId.get(h.id) ?? {
      id: h.id,
      name: '',
      qualifiedName: null,
      kind: '',
      file: '',
      lineStart: 0,
      pagerank: 0,
      depth: h.depth,
    };
    const items = sample.map(toItem);
    const pageItems = page.map(toItem);
    items.sort((a, b) => a.depth - b.depth || b.pagerank - a.pagerank);
    pageItems.sort((a, b) => a.depth - b.depth || b.pagerank - a.pagerank);
    return { items, pageItems, sampled: sample.length < hits.length };
  }

  private traceDepthCounts(hits: TraceReach[]): Record<string, number> {
    const depthCounts: Record<string, number> = {};
    for (const h of hits) {
      const key = String(h.depth);
      depthCounts[key] = (depthCounts[key] ?? 0) + 1;
    }
    return depthCounts;
  }

  private traceSummary(
    hits: TraceReach[],
    items: TraceItem[],
    sampled: boolean,
  ): {
    depthCounts: Record<string, number>;
    topFiles: Array<{
      file: string;
      count: number;
      minDepth: number;
      samples: Array<{ name: string; qualifiedName: string | null; lineStart: number; depth: number }>;
    }>;
    topSymbols: Array<{
      id: number;
      name: string;
      qualifiedName: string | null;
      kind: string;
      file: string;
      lineStart: number;
      depth: number;
      pagerank: number;
    }>;
    summarySampled?: boolean;
    summarySampleSize?: number;
  } {
    const files = new Map<string, {
      file: string;
      count: number;
      minDepth: number;
      samples: Array<{ name: string; qualifiedName: string | null; lineStart: number; depth: number }>;
    }>();
    for (const item of items) {
      const current = files.get(item.file) ?? {
        file: item.file,
        count: 0,
        minDepth: item.depth,
        samples: [],
      };
      current.count += 1;
      current.minDepth = Math.min(current.minDepth, item.depth);
      if (current.samples.length < 3) {
        current.samples.push({
          name: item.name,
          qualifiedName: item.qualifiedName,
          lineStart: item.lineStart,
          depth: item.depth,
        });
      }
      files.set(item.file, current);
    }

    return {
      depthCounts: this.traceDepthCounts(hits),
      topFiles: Array.from(files.values())
        .sort((a, b) => b.count - a.count || a.minDepth - b.minDepth || a.file.localeCompare(b.file))
        .slice(0, 10),
      topSymbols: items.slice(0, 10).map(item => ({
        id: item.id,
        name: item.name,
        qualifiedName: item.qualifiedName,
        kind: item.kind,
        file: item.file,
        lineStart: item.lineStart,
        depth: item.depth,
        pagerank: item.pagerank,
      })),
      ...(sampled ? {
        summarySampled: true,
        summarySampleSize: items.length,
      } : {}),
    };
  }

  // ── Lazy lifecycle resolution (AI-agent optimization §5a) ────────────────
  // Derived passes (modules / shape-hash) normally run during indexing. When
  // the DB was produced some other way (bundle import, partial index), the
  // dependent tools used to silently return nothing until the agent hand-ran a
  // *_build tool. These guards self-heal cheap-ish local derived state once
  // per process. Symbol history is intentionally excluded because git history
  // walking can take minutes in large repos and must stay explicit.
  private autoBuilt = { modules: false, shapes: false, continuity: false };

  private autoModuleMaxFiles(): number {
    const raw = Number(process.env.SEER_MCP_AUTO_MODULE_MAX_FILES);
    if (Number.isFinite(raw) && raw >= 0) return raw;
    return 10_000;
  }

  private autoShapeMaxSymbols(): number {
    const raw = Number(process.env.SEER_MCP_AUTO_SHAPE_MAX_SYMBOLS);
    if (Number.isFinite(raw) && raw >= 0) return raw;
    return 5_000;
  }

  private ensureModules(): boolean {
    if (this.autoBuilt.modules) return true;
    this.autoBuilt.modules = true;
    try {
      if (this.store.countModules() === 0) {
        const files = this.store.getStats().files;
        const maxFiles = this.autoModuleMaxFiles();
        if (files > maxFiles) {
          process.stderr.write(`[seer-mcp] auto modules build skipped: ${files} files exceeds ${maxFiles}\n`);
          return false;
        }
        buildModules(this.store);
      }
      return true;
    } catch (err) {
      process.stderr.write(`[seer-mcp] auto modules build skipped: ${err}\n`);
      return false;
    }
  }

  private ensureShapeHashes(): boolean {
    if (this.autoBuilt.shapes) return true;
    this.autoBuilt.shapes = true;
    try {
      const row = this.store.rawDb()
        .prepare('SELECT COUNT(*) AS c FROM symbols WHERE shape_hash IS NOT NULL')
        .get() as { c: number };
      if (Number(row.c) === 0) {
        const pending = this.store.rawDb().prepare(`
          SELECT COUNT(*) AS c
          FROM symbols s
          WHERE s.kind IN ('function','method','constructor')
            AND s.symbol_role <> 'declaration'
            AND s.loc >= 4
        `).get() as { c: number };
        const maxSymbols = this.autoShapeMaxSymbols();
        if (Number(pending.c) > maxSymbols) {
          process.stderr.write(`[seer-mcp] auto shape-hash build skipped: ${pending.c} symbols exceeds ${maxSymbols}\n`);
          return false;
        }
        buildShapeHashes(this.store, {});
      }
      return true;
    } catch (err) {
      process.stderr.write(`[seer-mcp] auto shape-hash build skipped: ${err}\n`);
      return false;
    }
  }

  private countTableRows(table: string): number {
    try {
      const row = this.store.rawDb()
        .prepare(`SELECT COUNT(*) AS c FROM ${table}`)
        .get() as { c: number };
      return Number(row.c);
    } catch {
      return 0;
    }
  }

  private historyIndexStatus(): Record<string, unknown> {
    // Base built/rows/marker come from the store (shared with context/preflight
    // so the `built` semantics never drift); the live-HEAD staleness check is
    // server-only because it needs the workspace path.
    const info = this.store.getHistoryIndexInfo();
    const head = gitHeadSha(this.workspace);
    const stale = info.lastHistoryHeadSha != null && head != null && info.lastHistoryHeadSha !== head;
    return {
      built: info.built,
      rows: info.rows,
      headSha: head,
      lastHistoryHeadSha: info.lastHistoryHeadSha,
      lastHistoryAt: info.lastHistoryAt,
      stale,
    };
  }

  private ensureContinuity(): boolean {
    if (this.autoBuilt.continuity) return true;
    this.autoBuilt.continuity = true;
    try {
      if (!this.store.hasV10()) return true;
      if (!this.ensureShapeHashes()) return false; // continuity compares shape hashes
      const row = this.store.rawDb()
        .prepare('SELECT COUNT(*) AS c FROM symbol_history_continuity')
        .get() as { c: number };
      if (Number(row.c) === 0) buildContinuity(this.store, {});
      return true;
    } catch (err) {
      process.stderr.write(`[seer-mcp] auto continuity build skipped: ${err}\n`);
      return false;
    }
  }

  private registerTools(): void {
    this.registerTool('seer_health', {
      description: 'CORE start-here tool. Confirms workspace, schema, file/symbol counts, watcher status. Cheap; no JIT.',
      inputSchema: {},
    }, async () => {
      const schema = this.store.schemaInfo();
      const stats = this.store.getStats();
      const watcher = this.watcher ? this.watcher.syncStatus() : null;
      return this.text({
        workspace: this.workspace,
        dbPath: this.dbPath,
        schemaVersion: schema.dbVersion,
        buildSchemaVersion: schema.buildVersion,
        schemaCurrent: schema.current,
        files: stats.files, symbols: stats.symbols, edges: stats.edges,
        resolvedEdges: stats.resolvedEdges,
        roles: stats.roles, languages: stats.languages,
        routes: stats.routes,
        externalDependencies: stats.externalDependencies,
        configKeys: stats.configKeys,
        symbolHistory: stats.symbolHistory,
        modules: stats.modules ?? 0,
        scipImports: stats.scipImports ?? 0,
        shapeHashed: stats.shapeHashed ?? 0,
        provenance: stats.provenance,
        watcher, jitEnabled: this.jitEnabled,
        uptimeMs: Date.now() - this.startedAt,
      });
    });

    this.registerTool('seer_stats', {
      description: 'Index statistics: counts, languages, roles, routes, deps, config keys. Runs JIT.',
      inputSchema: {},
    }, async () => {
      await this.ensureFresh();
      return this.text(this.store.getStats());
    });

    this.registerTool('seer_symbols', {
      description: 'Search symbols by name (BM25 over name/qualified_name/signature with camelCase/snake_case split). Returns top by PageRank when query omitted. Excludes vendor/generated/test/declaration rows by default; pass include* to widen.',
      inputSchema: {
        query: z.string().optional(),
        top: z.number().int().positive().max(500).optional(),
        limit: z.number().int().positive().max(500).optional(),
        includeVendor: z.boolean().optional(),
        includeGenerated: z.boolean().optional(),
        includeTests: z.boolean().optional(),
        includeDeclarations: z.boolean().optional(),
        includeTypeRefs: z.boolean().optional(),
        tokenBudget: z.number().int().positive().max(50000).optional()
          .describe('Soft cap (~4 chars/token) that prefix-trims items, keeping the highest-ranked rows.'),
      },
    }, async ({ query, top, limit, includeVendor, includeGenerated, includeTests, includeDeclarations, includeTypeRefs, tokenBudget }) => {
      await this.ensureFresh();
      const opts = {
        includeVendor: includeVendor ?? false,
        includeGenerated: includeGenerated ?? false,
        includeTests: includeTests ?? false,
        includeDeclarations: includeDeclarations ?? false,
        includeTypeRefs: includeTypeRefs ?? false,
      };
      let rows;
      let total: number | null = null;
      if (query) {
        rows = this.store.searchSymbolsFts(query, { ...opts, limit: limit ?? 50 });
        total = this.store.countSymbols(query, opts);
      } else {
        rows = this.store.getTopSymbols(top ?? 20, opts);
      }
      if (query && rows.length === 0) {
        const didYouMean = this.suggestSymbols(query);
        return this.text({ total, returned: 0, items: [], source: 'tree-sitter',
          ...(didYouMean.length > 0 ? { didYouMean } : {}) });
      }
      const items = rows.map(r => ({
        id: r.id, name: r.name, qualifiedName: r.qualifiedName, kind: r.kind,
        file: r.filePath, lineStart: r.lineStart, lineEnd: r.lineEnd,
        pagerank: r.pagerank, signature: r.signature,
        loc: r.loc, cyclomatic: r.cyclomatic, cognitive: r.cognitive,
        symbolRole: r.symbolRole,
      }));
      return this.budgetedText({ total, source: 'tree-sitter' }, items, tokenBudget);
    });

    this.registerTool('seer_definition', {
      description: 'CORE lookup tool. Find exact symbol definitions by name or qualified name. Pass `name` (or its alias `symbol`, for parity with the drill-down tools). Pass `file` to disambiguate common symbols; accepts absolute path, exact rel_path, or trailing path fragment. Excludes vendor/generated/test/declaration rows by default.',
      inputSchema: {
        name: z.string().optional(),
        symbol: z.string().optional().describe('Alias for `name` — accepted so a call shaped like the other tools (which take `symbol`) still resolves.'),
        file: z.string().optional(),
        includeVendor: z.boolean().optional(),
        includeGenerated: z.boolean().optional(),
        includeTests: z.boolean().optional(),
        includeDeclarations: z.boolean().optional(),
        includeTypeRefs: z.boolean().optional(),
        tokenBudget: z.number().int().positive().max(50000).optional()
          .describe('Soft cap (~4 chars/token) that prefix-trims items, keeping the highest-PageRank rows.'),
      },
    }, async ({ name, symbol, file, includeVendor, includeGenerated, includeTests, includeDeclarations, includeTypeRefs, tokenBudget }) => {
      await this.ensureFresh();
      const query = name ?? symbol;
      if (!query) {
        return this.text({ ok: false, error: 'seer_definition requires `name` (or its alias `symbol`).' });
      }
      const rows = this.store.getDefinition(query, {
        filePath: file,
        includeVendor: includeVendor ?? false,
        includeGenerated: includeGenerated ?? false,
        includeTests: includeTests ?? false,
        includeDeclarations: includeDeclarations ?? false,
        includeTypeRefs: includeTypeRefs ?? false,
      });
      // Suggestion-only fuzzy fallback: never substitute, just hint.
      if (rows.length === 0) {
        const didYouMean = this.suggestSymbols(query);
        const declarationHint = this.declarationHint(query, file);
        return this.text({ total: 0, items: [], source: 'tree-sitter',
          ...(declarationHint ? { declarationHint } : {}),
          ...(didYouMean.length > 0 ? { didYouMean } : {}) });
      }
      const items = rows.map(r => ({
        id: r.id, name: r.name, qualifiedName: r.qualifiedName, kind: r.kind,
        file: r.filePath, lineStart: r.lineStart, lineEnd: r.lineEnd,
        pagerank: r.pagerank, signature: r.signature,
        loc: r.loc, cyclomatic: r.cyclomatic, cognitive: r.cognitive,
        symbolRole: r.symbolRole,
      }));
      return this.budgetedText({ total: rows.length, source: 'tree-sitter' }, items, tokenBudget);
    });

    this.registerTool('seer_file_symbols', {
      description: 'CORE lookup tool. List symbols defined in a file, sorted by line; use after seer_search file hits or before reading a large file.',
      inputSchema: {
        file: z.string(),
        limit: z.number().int().positive().max(2000).optional(),
      },
    }, async ({ file, limit }) => {
      await this.ensureFresh();
      const rows = this.store.listSymbolsInFile(file, limit ?? 200);
      return this.text({
        file, total: rows.length,
        items: rows.map(r => ({
          id: r.id, name: r.name, qualifiedName: r.qualifiedName, kind: r.kind,
          lineStart: r.lineStart, lineEnd: r.lineEnd, pagerank: r.pagerank,
          signature: r.signature, loc: r.loc,
          cyclomatic: r.cyclomatic, cognitive: r.cognitive,
        })),
      });
    });

    this.registerTool('seer_callers', {
      description: 'CORE drill-down tool. Direct callers of a symbol. `total` counts CALL SITES (edges); `uniqueCallers` counts distinct caller functions (a function calling the target twice = 1 unique / 2 sites). Pass file to disambiguate common names or qualified names such as Class.method. Pass includeSnippets=true to get the real source at each call site (HOW the symbol is invoked — argument patterns — before you write a new call). For C/C++ member calls the receiver type is unresolved, so a resolved count far below reality is reported under `ambiguity` with resolved call sites plus a bounded `likelyCallersEstimate`. To narrow that bound: includeNameMatches=true (raw list, pageable with nameMatchOffset), groupByFile=true (accurate per-file breakdown of where the by-name sites concentrate), and filterReceiverType (best-effort: keep only sites whose receiver is locally typed as a given class; true infers the class from the target).',
      inputSchema: {
        symbol: z.string(),
        file: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
        includeSnippets: z.boolean().optional()
          .describe('Attach a bounded source snippet at each call site (real argument/usage patterns) to the resolved `items` list. Best paired with a small limit; snippets are counted against tokenBudget.'),
        snippetContext: z.number().int().nonnegative().max(6).optional()
          .describe('Lines of context above/below each call site in includeSnippets (default 2, max 6).'),
        includeNameMatches: z.boolean().optional()
          .describe('Also return callers matched by SHORT name (type-unresolved upper bound). Useful for C/C++ member calls where the precise id-resolved set undercounts.'),
        nameMatchOffset: z.number().int().nonnegative().max(1000000).optional()
          .describe('Offset into the by-name caller list for paging (use with limit + includeNameMatches). nameMatches.nextOffset reports the next page.'),
        groupByFile: z.boolean().optional()
          .describe('Return an accurate per-file breakdown of the by-name call sites (where the thousands of type-unresolved sites concentrate) so you can scope a refactor by file without paging raw rows.'),
        filterReceiverType: z.union([z.string(), z.boolean()]).optional()
          .describe('Best-effort (C/C++): narrow by-name callers to those whose receiver is locally typed as this class. Pass a class name, or true to infer it from the target symbol. Receivers typed in another file are reported under uncertainSites, not silently dropped.'),
        tokenBudget: z.number().int().positive().max(50000).optional()
          .describe('Soft cap (~4 chars/token) that prefix-trims the (already limit-bounded) caller list.'),
      },
    }, async ({ symbol, file, limit, includeNameMatches, nameMatchOffset, groupByFile, filterReceiverType, tokenBudget, includeSnippets, snippetContext }) => {
      await this.ensureFresh();
      // Resolve to a specific id when the input is DISAMBIGUATING: a `file` was
      // given, or the symbol is qualified (`Node.add_child` / `Node::add_child`).
      // Then findCallersById reads its precise resolved callers — the name-keyed
      // findCallers fallback matched edges by `to_name` only, and member-call
      // edges store the short name, so a qualified input silently found nothing.
      // A BARE short name stays on the broad name path so `seer_callers run`
      // still returns callers of every `run` (the documented "pass file to
      // disambiguate" contract). We hard-fail only when a `file` was given but
      // matched nothing.
      const qualified = symbol.includes('.') || symbol.includes('::');
      const target = (file || qualified)
        ? this.store.getDefinition(symbol, { filePath: file })[0] ?? null
        : null;
      if (file && !target) {
        const didYouMean = this.suggestSymbols(symbol);
        const declarationHint = this.declarationHint(symbol, file);
        return this.text({ symbol, file, found: false, total: 0, returned: 0, items: [], source: 'tree-sitter',
          reason: `no symbol "${symbol}" in ${file}`,
          ...(declarationHint ? { declarationHint } : {}),
          ...(didYouMean.length > 0 ? { didYouMean } : {}) });
      }
      const total = target ? this.store.countCallersById(target.id) : this.store.countCallers(symbol);
      const uniqueCallers = target ? this.store.countUniqueCallersById(target.id) : undefined;
      const rows = target
        ? this.store.findCallersById(target.id, limit ?? 40)
        : this.store.findCallers(symbol, limit ?? 40);
      const baseItems = rows.map(c => ({
        callerName: c.callerName, callerQualifiedName: c.callerQualifiedName,
        callerKind: c.callerKind, file: c.callerFile, line: c.callerLine,
        edgeKind: c.edgeKind,
      }));
      const items = includeSnippets
        ? attachCallSiteSnippets(baseItems, snippetContext ?? 2)
        : baseItems;
      // Honest blast-radius bounds: when a resolved target's short name is shared
      // and far more call sites use the bare name than resolved here, report both.
      const ambiguity = target
        ? this.callerAmbiguity({ id: target.id, name: target.name, filePath: target.filePath, total })
        : undefined;
      // By-name caller analysis (the type-unresolved upper bound). Built when the
      // agent asks for the raw list (includeNameMatches), a per-file breakdown
      // (groupByFile), or a receiver-type filter — each a way to narrow the
      // thousands of by-name sites a hub method attracts. The raw row fetch is
      // only paid when items or the receiver filter need it; groupByFile uses its
      // own accurate GROUP BY.
      let nameMatches: Record<string, unknown> | undefined;
      // `filterReceiverType` is on only for an explicit `true` or a non-empty
      // class name. An explicit `false` (allowed by the z.union) means OFF —
      // `!= null` would have wrongly treated it as "infer the type" (on).
      const wantReceiverFilter = filterReceiverType === true
        || (typeof filterReceiverType === 'string' && filterReceiverType.trim().length > 0);
      const wantNameMatches = (includeNameMatches || groupByFile || wantReceiverFilter) && target != null;
      if (wantNameMatches && target) {
        nameMatches = {
          shortName: target.name,
          total: this.store.countCallers(target.name),
          note: 'Callers matched by SHORT name only (type-unresolved). Includes calls to OTHER same-named symbols — an upper bound, not all this symbol\'s callers.',
        };
        if (includeNameMatches || wantReceiverFilter) {
          const SCAN_CAP = 6000;
          const nm = this.store.findCallers(target.name, SCAN_CAP);
          const seen = new Set<string>();
          const dedupedAll = nm.filter(c => {
            const key = `${c.callerQualifiedName ?? c.callerName}@${c.callerFile}`;
            if (seen.has(key)) return false;
            seen.add(key); return true;
          });
          if (includeNameMatches) {
            const nmOffset = Math.min(nameMatchOffset ?? 0, dedupedAll.length);
            // No snippets here on purpose: the by-name page is attached to the
            // base object, which budgetedText does NOT trim (it only trims the
            // top-level `items`). Snippets on a large includeNameMatches page
            // would escape tokenBudget entirely. Snippets stay on the resolved
            // `items` list, which IS budget-counted. The by-name list is a
            // counting/disambiguation aid, where call-site source adds little.
            const page = dedupedAll.slice(nmOffset, nmOffset + (limit ?? 40)).map(c => ({
              callerName: c.callerName, callerQualifiedName: c.callerQualifiedName,
              callerKind: c.callerKind, file: c.callerFile, line: c.callerLine, edgeKind: c.edgeKind,
            }));
            nameMatches.uniqueCallers = dedupedAll.length;
            if (nm.length >= SCAN_CAP) nameMatches.uniqueCallersCapped = true;
            nameMatches.offset = nmOffset;
            nameMatches.returned = page.length;
            nameMatches.nextOffset = nmOffset + page.length < dedupedAll.length ? nmOffset + page.length : null;
            nameMatches.items = page;
          }
          if (wantReceiverFilter) {
            const type = typeof filterReceiverType === 'string' && filterReceiverType.trim()
              ? filterReceiverType.trim()
              : this.classOfQualified(target.qualifiedName);
            if (type) {
              const siblings = this.store.definitionClassesByShortName(target.name).filter(c => c && c !== type);
              const rf = this.filterCallersByReceiverType(nm, target.name, type, siblings);
              const totalByName = nameMatches.total as number;
              // The scan is also capped when the upstream by-name fetch hit
              // SCAN_CAP (findCallers above) — rf.capped alone can't see that,
              // so reconcile here. When capped we can't trust a sibling count
              // taken over a partial scan, so we withhold plausibleUpperBound.
              const scanCapped = rf.capped || nm.length >= SCAN_CAP;
              nameMatches.receiverTypeFilter = scanCapped
                ? { ...rf, capped: true }
                : { ...rf, plausibleUpperBound: totalByName - rf.confirmedSiblingSites };
            } else {
              nameMatches.receiverTypeFilter = { note: 'Could not infer a receiver type from the target symbol; pass filterReceiverType: "ClassName" explicitly.' };
            }
          }
        }
        if (groupByFile) {
          const totalFiles = this.store.countCallerFilesByName(target.name);
          const byFile = this.store.groupCallersByFile(target.name, 40);
          nameMatches.byFile = {
            totalFiles,
            returned: byFile.length,
            ...(byFile.length < totalFiles ? { note: `Top ${byFile.length} of ${totalFiles} files by call-site count — inspect these first.` } : {}),
            items: byFile.map(f => ({ file: f.relPath, count: f.count })),
          };
        }
      }
      const targetMeta = target ? {
        id: target.id, name: target.name, qualifiedName: target.qualifiedName,
        kind: target.kind, file: target.filePath, lineStart: target.lineStart,
      } : undefined;
      const sharedDefinitions = target ? 1 : this.countShortNameDefinitions(symbol);
      const precision = ambiguity
        ? this.ambiguityPrecision(ambiguity)
        : target
          ? exactPrecision('Callers are resolved to this symbol id.')
          : sharedDefinitions > 1
            ? nameAggregatePrecision('call-sites', total, `Bare name "${symbol}" is shared by ${sharedDefinitions} definitions; callers are aggregated by name.`)
            : sharedDefinitions === 0
              ? unknownPrecision(`No indexed definition matched "${symbol}"; any rows are name-only call sites.`)
              : exactPrecision('This short name maps to one indexed definition.');
      const warnings: AgentWarning[] = [];
      let suggestedCall: AgentNextBestCall | undefined;
      if (ambiguity && target) {
        warnings.push(this.ambiguityWarning(ambiguity));
        suggestedCall = this.ambiguityNextCall(target, {
          groupByFile,
          includeNameMatches,
          receiverFilter: wantReceiverFilter,
        });
      } else if (!target && sharedDefinitions > 1) {
        warnings.push(agentWarning('name-aggregate', `Bare name "${symbol}" is shared by ${sharedDefinitions} definitions; pass file or a qualified name to scope the result.`));
        suggestedCall = this.nameAggregateNextCall(symbol);
      }
      if (total === 0) {
        const didYouMean = this.suggestSymbols(symbol);
        return this.text({ symbol, file, target: targetMeta,
          total: 0, uniqueCallers, returned: 0, items: [], precision,
          ...(ambiguity ? { ambiguity } : {}),
          ...(nameMatches ? { nameMatches } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
          ...(suggestedCall ? { nextBestCall: suggestedCall } : {}),
          source: 'tree-sitter',
          ...(didYouMean.length > 0 ? { didYouMean } : {}) });
      }
      return this.budgetedText({ symbol, file, target: targetMeta,
        total, uniqueCallers, precision,
        ...(ambiguity ? { ambiguity } : {}),
        ...(nameMatches ? { nameMatches } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(suggestedCall ? { nextBestCall: suggestedCall } : {}),
        source: 'tree-sitter' }, items, tokenBudget);
    });

    this.registerTool('seer_callees', {
      description: 'CORE drill-down tool. Direct callees of a symbol. Pass file to disambiguate common names or qualified names such as Class.method.',
      inputSchema: {
        symbol: z.string(),
        file: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
        tokenBudget: z.number().int().positive().max(50000).optional()
          .describe('Soft cap (~4 chars/token) that prefix-trims the callee list.'),
      },
    }, async ({ symbol, file, limit, tokenBudget }) => {
      await this.ensureFresh();
      // Resolve to a specific id when the input is DISAMBIGUATING (mirrors
      // seer_callers): a `file` was given, or the caller is qualified
      // (`Node.add_child` / `Node::add_child`). Then we read its exact callees by
      // id — the name-keyed findCallees only matched the short name, so qualified
      // inputs silently returned nothing. A bare short name stays on the broad
      // name path for symmetry with seer_callers.
      const qualified = symbol.includes('.') || symbol.includes('::');
      const target = (file || qualified)
        ? this.store.getDefinition(symbol, { filePath: file })[0] ?? null
        : null;
      if (file && !target) {
        const didYouMean = this.suggestSymbols(symbol);
        return this.text({ symbol, file, found: false, total: 0, returned: 0, items: [], source: 'tree-sitter',
          reason: `no symbol "${symbol}" in ${file}`,
          ...(didYouMean.length > 0 ? { didYouMean } : {}) });
      }
      const all = target ? this.store.findCalleesById(target.id) : this.store.findCallees(symbol);
      const max = Math.min(all.length, limit ?? 40);
      const items = all.slice(0, max).map(c => ({
        calleeName: c.calleeName, calleeKind: c.calleeKind,
        file: c.calleeFile, lineStart: c.calleeLineStart,
        edgeKind: c.edgeKind,
        source: c.calleeFile ? 'tree-sitter' : 'unresolved',
      }));
      const sharedDefinitions = target ? 1 : this.countShortNameDefinitions(symbol);
      const precision = target
        ? exactPrecision('Callees are resolved from this symbol id.')
        : sharedDefinitions > 1
          ? nameAggregatePrecision('call-sites', all.length, `Bare name "${symbol}" is shared by ${sharedDefinitions} definitions; callees are aggregated by name.`)
          : sharedDefinitions === 0
            ? unknownPrecision(`No indexed definition matched "${symbol}"; any rows are name-only callee edges.`)
            : exactPrecision('This short name maps to one indexed definition.');
      const warnings = !target && sharedDefinitions > 1
        ? [agentWarning('name-aggregate', `Bare name "${symbol}" is shared by ${sharedDefinitions} definitions; pass file or a qualified name to scope the result.`)]
        : [];
      const suggestedCall = !target && sharedDefinitions > 1 ? this.nameAggregateNextCall(symbol) : undefined;
      return this.budgetedText({ symbol, file, target: target ? {
        id: target.id, name: target.name, qualifiedName: target.qualifiedName,
        kind: target.kind, file: target.filePath, lineStart: target.lineStart,
      } : undefined, total: all.length, precision,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(suggestedCall ? { nextBestCall: suggestedCall } : {}),
        source: 'tree-sitter' }, items, tokenBudget);
    });

    // Search: BM25 across symbols + files. Each symbol hit also gets enriched
    // with the containing symbol when the match is non-symbol (e.g. file).
    this.registerTool('seer_search', {
      description: 'CORE discovery tool. Combined BM25 search across symbol names and file paths. Use this first when the target symbol/file is unknown; follow up with seer_definition or seer_file_symbols. Excludes vendor/generated/test/declaration rows by default. For broad queries pass a small limit (default 30, max 200) or tokenBudget to keep the response within MCP payload limits.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().positive().max(200).optional(),
        includeVendor: z.boolean().optional(),
        includeGenerated: z.boolean().optional(),
        includeTests: z.boolean().optional(),
        includeDeclarations: z.boolean().optional(),
        includeTypeRefs: z.boolean().optional(),
        tokenBudget: z.number().int().positive().max(50000).optional()
          .describe('Soft cap (~4 chars/token) on the whole response. Trims the lowest-ranked file-path hits first, then symbol hits, keeping totals + at least one symbol hit. Use on broad queries that overflow the MCP payload limit.'),
      },
    }, async ({ query, limit, includeVendor, includeGenerated, includeTests, includeDeclarations, includeTypeRefs, tokenBudget }) => {
      await this.ensureFresh();
      const opts = {
        includeVendor: includeVendor ?? false,
        includeGenerated: includeGenerated ?? false,
        includeTests: includeTests ?? false,
        includeDeclarations: includeDeclarations ?? false,
        includeTypeRefs: includeTypeRefs ?? false,
      };
      const symHits = this.store.searchSymbolsFts(query, { ...opts, limit: limit ?? 30 });
      const symbolTotal = this.store.countSymbols(query, opts);
      const fileHits = this.store.searchFilesFts(query, limit ?? 30, {
        includeVendor: opts.includeVendor,
        includeGenerated: opts.includeGenerated,
        includeTests: opts.includeTests,
      });
      let symItems = symHits.map(r => ({
        id: r.id, name: r.name, qualifiedName: r.qualifiedName,
        kind: r.kind, file: r.filePath, lineStart: r.lineStart,
        pagerank: r.pagerank, symbolRole: r.symbolRole,
      }));
      let fileItems = fileHits.map(f => ({ path: f.path, relPath: f.relPath, language: f.language, role: f.role }));
      // File search is BM25-capped at `limit`; unlike symbolHits there is no
      // cheap exact total, so a capped page must not masquerade as the full
      // count. `total` is the matches seen on this page; `capped` flags that
      // more may exist (raise limit to widen). symbolHits.total is exact.
      const fileCapped = fileHits.length >= (limit ?? 30);
      const build = (sym: typeof symItems, fil: typeof fileItems, extra?: Record<string, unknown>) => ({
        query,
        symbolHits: { total: symbolTotal, returned: sym.length, items: sym },
        fileHits: { total: fileHits.length, returned: fil.length, ...(fileCapped ? { capped: true } : {}), items: fil },
        source: 'tree-sitter',
        note: 'Search-first: call seer_definition or seer_file_symbols on the chosen hit.',
        ...(extra ?? {}),
      });
      // Token budgeting: trim the lowest-ranked file-path hits first, then symbol
      // hits, until the serialized payload fits. Always keep at least one symbol hit.
      if (tokenBudget && tokenBudget > 0) {
        const budgetChars = tokenBudget * 4;
        let trimmedSym = 0, trimmedFile = 0;
        while (JSON.stringify(build(symItems, fileItems)).length > budgetChars && fileItems.length > 0) {
          fileItems = fileItems.slice(0, -1); trimmedFile++;
        }
        while (JSON.stringify(build(symItems, fileItems)).length > budgetChars && symItems.length > 1) {
          symItems = symItems.slice(0, -1); trimmedSym++;
        }
        if (trimmedSym > 0 || trimmedFile > 0) {
          return this.text(build(symItems, fileItems, {
            truncated: true, tokenBudget,
            omitted: { symbolHits: trimmedSym, fileHits: trimmedFile },
            truncationNote: `Trimmed to ~${tokenBudget} tokens (dropped ${trimmedSym} symbol + ${trimmedFile} file hits). Raise tokenBudget, lower limit, or add a filter for the rest.`,
          }));
        }
      }
      return this.text(build(symItems, fileItems));
    });

    this.registerTool('seer_reindex', {
      description: 'Reindex the workspace (incremental). Pass reset=true to wipe.',
      inputSchema: { reset: z.boolean().optional() },
    }, async ({ reset }) => {
      if (reset) {
        this.store.close();
        try { fs.unlinkSync(this.dbPath); } catch { /* */ }
        try { fs.unlinkSync(this.dbPath + '-wal'); } catch { /* */ }
        try { fs.unlinkSync(this.dbPath + '-shm'); } catch { /* */ }
        this.store = new Store(this.dbPath);
        this.indexer = new Indexer(this.store);
        if (this.watcher) {
          await this.watcher.stop();
          this.watcher = new SeerWatcher(this.workspace, this.indexer, {
            log: (m) => process.stderr.write(`[watcher] ${m}\n`),
          });
          this.watcher.start();
        }
      }
      const r = await this.indexer.indexDirectory(this.workspace, { quiet: true });
      return this.text({
        reset: Boolean(reset),
        filesIndexed: r.filesIndexed,
        filesReusedFromCache: r.filesReusedFromCache,
        symbols: r.symbols, edges: r.edges, resolvedEdges: r.resolvedEdges,
        externalDependencies: r.externalDependencies,
        testEdgesAdded: r.testEdgesAdded,
        routesResolved: r.routesResolved,
        elapsedMs: r.elapsedMs,
        pagerankRecomputed: r.pagerankRecomputed,
      });
    });

    // ── Track-C tools ───────────────────────────────────────────────────────

    this.registerTool('seer_routes', {
      description: 'List HTTP routes detected in source (Express/Fastify/FastAPI/Flask/Spring).',
      inputSchema: {
        method: z.string().optional(),
        framework: z.string().optional(),
        pathSubstr: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
      },
    }, async ({ method, framework, pathSubstr, limit }) => {
      await this.ensureFresh();
      const rows = this.store.listRoutes({ method, framework, pathSubstr, limit: limit ?? 100 });
      return this.text({
        total: this.store.countRoutes(),
        returned: rows.length,
        items: rows,
        source: 'tree-sitter',
      });
    });

    this.registerTool('seer_service_calls', {
      description:
        'v9 Track H — List outbound HTTP/tRPC/GraphQL/gRPC/messaging service client calls. ' +
        'Each row is AST-attributed to its enclosing function/method. Pagination via limit/offset; ' +
        'filter by protocol, method, framework, path substring, caller symbol, or min confidence.',
      inputSchema: {
        protocol: z.string().optional(),
        method: z.string().optional(),
        framework: z.string().optional(),
        pathSubstr: z.string().optional(),
        callerSymbolId: z.number().int().nonnegative().optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        limit: z.number().int().positive().max(1000).optional(),
        offset: z.number().int().nonnegative().optional(),
        summaryOnly: z.boolean().optional(),
        tokenBudget: z.number().int().positive().max(50000).optional()
          .describe('Soft cap (~4 chars/token) that prefix-trims the returned items.'),
      },
    }, async (args) => {
      await this.ensureFresh();
      const limit = args.limit ?? 100;
      const rows = this.store.listServiceCalls({ ...args, limit });
      const total = this.store.countServiceCalls();
      if (args.summaryOnly) {
        return this.text({ total, returned: rows.length, source: 'tree-sitter' });
      }
      return this.budgetedText({ total, offset: args.offset ?? 0, source: 'tree-sitter' }, rows, args.tokenBudget);
    });

    this.registerTool('seer_service_links', {
      description:
        'v9 Track H — List deterministic service-link rendezvous between client calls and route handlers. ' +
        'Each link carries match_kind (literal_path / env_base / service_host / route_pattern / ' +
        'trpc_procedure / graphql_operation / grpc_method / topic_match / queue_match / exchange_match), confidence, ' +
        'and an evidence_json blob enumerating ambiguity candidates. Filter by protocol, method, path, ' +
        'caller/handler symbol id, match_kind, or min confidence.',
      inputSchema: {
        protocol: z.string().optional(),
        method: z.string().optional(),
        pathSubstr: z.string().optional(),
        callerSymbolId: z.number().int().nonnegative().optional(),
        handlerSymbolId: z.number().int().nonnegative().optional(),
        matchKind: z.string().optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        limit: z.number().int().positive().max(1000).optional(),
        offset: z.number().int().nonnegative().optional(),
        summaryOnly: z.boolean().optional(),
        tokenBudget: z.number().int().positive().max(50000).optional()
          .describe('Soft cap (~4 chars/token) that prefix-trims the returned items.'),
      },
    }, async (args) => {
      await this.ensureFresh();
      const limit = args.limit ?? 100;
      const rows = this.store.listServiceLinks({ ...args, limit });
      const total = this.store.countServiceLinks();
      if (args.summaryOnly) {
        return this.text({ total, returned: rows.length, source: 'tree-sitter' });
      }
      return this.budgetedText({ total, offset: args.offset ?? 0, source: 'tree-sitter' }, rows, args.tokenBudget);
    });

    this.registerTool('seer_trace_service_path', {
      description:
        'v8 Track G — Shortest service-link path between two symbols (bounded BFS). ' +
        'Treats each service_link as a directed edge caller→handler. Returns the chain of ' +
        'symbol ids and names; empty when unreachable within maxDepth.',
      inputSchema: {
        from: z.string().describe('Source symbol name or qualified name'),
        to: z.string().describe('Target symbol name or qualified name'),
        maxDepth: z.number().int().positive().max(20).optional(),
      },
    }, async ({ from, to, maxDepth }) => {
      await this.ensureFresh();
      const fRows = this.store.getDefinition(from);
      const tRows = this.store.getDefinition(to);
      if (fRows.length === 0) return this.text({ ok: false, error: `Source symbol not found: ${from}` });
      if (tRows.length === 0) return this.text({ ok: false, error: `Target symbol not found: ${to}` });
      const ids = this.store.traceServicePath(fRows[0].id, tRows[0].id, maxDepth ?? 6);
      if (ids.length === 0) return this.text({ ok: true, found: false, path: [] });
      const items = ids.map(id => {
        const row = this.store.rawDb().prepare(
          `SELECT id, name, qualified_name AS qualifiedName, kind FROM symbols WHERE id = ?`,
        ).get(id) as { id: unknown; name: unknown; qualifiedName: unknown; kind: unknown };
        return {
          id: Number(row.id),
          name: String(row.name),
          qualifiedName: row.qualifiedName == null ? null : String(row.qualifiedName),
          kind: String(row.kind),
        };
      });
      return this.text({ ok: true, found: true, hops: items.length - 1, path: items });
    });

    this.registerTool('seer_trace_service_dependencies', {
      description:
        'v9 Track H — Bounded BFS over service-link edges from one symbol. ' +
        'Returns every handler reachable within maxDepth/maxNodes/maxFanout, ' +
        'each with its depth, the protocols carrying traffic, and the hop chain. ' +
        'Default output is a compact preview; use summaryOnly for counts only and page with offset/limit for more rows. ' +
        '`cutoff` reports which limit fired (maxNodes / maxDepth / maxFanout) if any.',
      inputSchema: {
        from: z.string().describe('Source symbol name or qualified name'),
        maxDepth: z.number().int().positive().max(20).optional(),
        maxNodes: z.number().int().positive().max(2000).optional(),
        maxFanout: z.number().int().positive().max(200).optional(),
        limit: z.number().int().positive().max(500).optional(),
        offset: z.number().int().nonnegative().max(50000).optional(),
        summaryOnly: z.boolean().optional(),
        tokenBudget: z.number().int().positive().max(50000).optional()
          .describe('Soft cap (~4 chars/token) that trims the returned row page, never the totals.'),
      },
    }, async ({ from, maxDepth, maxNodes, maxFanout, limit, offset, summaryOnly, tokenBudget }) => {
      await this.ensureFresh();
      const fRows = this.store.getDefinition(from);
      if (fRows.length === 0) return this.text({ ok: false, error: `Source symbol not found: ${from}` });
      const r = this.store.traceServiceDependencies(fRows[0].id, { maxDepth, maxNodes, maxFanout });
      const items = r.reached.map(x => {
        const row = this.store.rawDb().prepare(
          `SELECT id, name, qualified_name AS qualifiedName, kind FROM symbols WHERE id = ?`,
        ).get(x.symbolId) as { id: unknown; name: unknown; qualifiedName: unknown; kind: unknown } | undefined;
        return {
          symbolId: x.symbolId,
          name: row ? String(row.name) : null,
          qualifiedName: row?.qualifiedName == null ? null : String(row.qualifiedName),
          kind: row ? String(row.kind) : null,
          depth: x.depth,
          protocols: x.protocols,
          matchKinds: x.matchKinds,
          hops: x.hops,
        };
      });
      const pageLimit = Math.min(limit ?? 25, 500);
      const pageOffset = Math.min(offset ?? 0, items.length);
      const pageItems = items.slice(pageOffset, pageOffset + pageLimit);
      const hasNextPage = !summaryOnly && pageOffset + pageItems.length < items.length;
      const base = {
        ok: true,
        from: { id: fRows[0].id, name: fRows[0].name, qualifiedName: fRows[0].qualifiedName },
        reached: items.length,
        cutoff: r.cutoff,
        offset: pageOffset,
        limit: pageLimit,
        truncated: hasNextPage,
        nextOffset: hasNextPage ? pageOffset + pageItems.length : null,
        source: 'tree-sitter',
        note: 'Compact dependency preview. Use summaryOnly for counts only or page with offset/limit for more rows.',
      };
      if (summaryOnly) return this.text({ ...base, rows: { returned: 0, omittedByMode: true, note: 'Summary mode returns aggregates only (totals + topFiles/topSymbols/depthCounts where present). No raw rows are included by design — re-call with summaryOnly=false (or mode="preview"/"full") and page with offset/limit to get rows.' } });
      return this.budgetedText(base, pageItems, tokenBudget);
    });

    this.registerTool('seer_trace_module_service_dependencies', {
      description:
        'v9 Track H — Bounded BFS over cross-module service-link edges from one ' +
        'module. Returns each downstream module with hop depth, the protocols ' +
        'carrying traffic, and the total cross-module link weight feeding it. ' +
        'Default output is a compact preview; use summaryOnly for counts only and page with offset/limit for more rows.',
      inputSchema: {
        moduleId: z.number().int().nonnegative(),
        maxDepth: z.number().int().positive().max(10).optional(),
        maxNodes: z.number().int().positive().max(500).optional(),
        limit: z.number().int().positive().max(500).optional(),
        offset: z.number().int().nonnegative().max(50000).optional(),
        summaryOnly: z.boolean().optional(),
        tokenBudget: z.number().int().positive().max(50000).optional()
          .describe('Soft cap (~4 chars/token) that trims the returned row page, never the totals.'),
      },
    }, async ({ moduleId, maxDepth, maxNodes, limit, offset, summaryOnly, tokenBudget }) => {
      await this.ensureFresh();
      const r = this.store.traceModuleServiceDependencies(moduleId, { maxDepth, maxNodes });
      // Hydrate module metadata for the response so callers don't need a
      // follow-up tool call.
      const ids = r.reached.map(x => x.moduleId);
      let metaById = new Map<number, { label: string; sizeFiles: number }>();
      if (ids.length > 0) {
        const rows = this.store.rawDb().prepare(
          `SELECT id, label, size_files AS sizeFiles FROM modules WHERE id IN (${ids.map(() => '?').join(',')})`,
        ).all(...ids) as Array<{ id: unknown; label: unknown; sizeFiles: unknown }>;
        for (const row of rows) {
          metaById.set(Number(row.id), { label: String(row.label), sizeFiles: Number(row.sizeFiles) });
        }
      }
      const items = r.reached.map(x => ({
        moduleId: x.moduleId,
        label: metaById.get(x.moduleId)?.label ?? null,
        sizeFiles: metaById.get(x.moduleId)?.sizeFiles ?? 0,
        depth: x.depth,
        protocols: x.protocols,
          viaLinks: x.viaLinks,
        }));
      const pageLimit = Math.min(limit ?? 25, 500);
      const pageOffset = Math.min(offset ?? 0, items.length);
      const pageItems = items.slice(pageOffset, pageOffset + pageLimit);
      const hasNextPage = !summaryOnly && pageOffset + pageItems.length < items.length;
      const base = {
        ok: true,
        fromModuleId: moduleId,
        reached: items.length,
        cutoff: r.cutoff,
        offset: pageOffset,
        limit: pageLimit,
        truncated: hasNextPage,
        nextOffset: hasNextPage ? pageOffset + pageItems.length : null,
        source: 'tree-sitter',
        note: 'Compact dependency preview. Use summaryOnly for counts only or page with offset/limit for more rows.',
      };
      if (summaryOnly) return this.text({ ...base, rows: { returned: 0, omittedByMode: true, note: 'Summary mode returns aggregates only (totals + topFiles/topSymbols/depthCounts where present). No raw rows are included by design — re-call with summaryOnly=false (or mode="preview"/"full") and page with offset/limit to get rows.' } });
      return this.budgetedText(base, pageItems, tokenBudget);
    });

    this.registerTool('seer_dependencies', {
      description: 'List external dependencies declared in package manifests / lockfiles.',
      inputSchema: {
        ecosystem: z.string().optional(),
        nameSubstr: z.string().optional(),
        limit: z.number().int().positive().max(2000).optional(),
      },
    }, async ({ ecosystem, nameSubstr, limit }) => {
      await this.ensureFresh();
      const rows = this.store.listExternalDeps({ ecosystem, nameSubstr, limit: limit ?? 200 });
      return this.text({
        total: this.store.countExternalDeps(),
        returned: rows.length,
        items: rows,
      });
    });

    this.registerTool('seer_config', {
      description: 'List static env/config reads detected in source (process.env, os.getenv, System.getenv).',
      inputSchema: {
        key: z.string().optional(),
        source: z.string().optional(),
        limit: z.number().int().positive().max(2000).optional(),
      },
    }, async ({ key, source, limit }) => {
      await this.ensureFresh();
      const rows = this.store.listConfigKeys({ key, source, limit: limit ?? 200 });
      return this.text({
        total: this.store.countConfigKeys(),
        returned: rows.length,
        items: rows,
      });
    });

    this.registerTool('seer_complexity', {
      description: 'Rank functions/methods by complexity. Useful for risk-aware editing. Excludes vendor/generated/test/declaration rows by default.',
      inputSchema: {
        by: z.enum(['cyclomatic', 'cognitive', 'loc', 'max_nesting']).optional(),
        minValue: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(500).optional(),
        includeVendor: z.boolean().optional(),
        includeGenerated: z.boolean().optional(),
        includeTests: z.boolean().optional(),
        includeDeclarations: z.boolean().optional(),
        tokenBudget: z.number().int().positive().max(50000).optional()
          .describe('Soft cap (~4 chars/token) that prefix-trims items, keeping the most complex rows.'),
      },
    }, async ({ by, minValue, limit, includeVendor, includeGenerated, includeTests, includeDeclarations, tokenBudget }) => {
      await this.ensureFresh();
      const col = by ?? 'cyclomatic';
      const min = minValue ?? 1;
      const lim = limit ?? 50;
      const conds: string[] = [`s.${col} >= ?`];
      const args: unknown[] = [min];
      if (!includeVendor)       conds.push('f.is_vendor = 0');
      if (!includeGenerated)    conds.push('f.is_generated = 0');
      if (!includeTests)        conds.push(`f.role <> 'test'`);
      if (!includeDeclarations) conds.push(`(s.symbol_role IS NULL OR s.symbol_role <> 'declaration')`);
      args.push(lim);
      const sql = `
        SELECT s.id, s.name, s.qualified_name AS qualifiedName, s.kind,
               f.path AS file, s.line_start AS lineStart, s.line_end AS lineEnd,
               s.loc, s.cyclomatic, s.cognitive, s.max_nesting AS maxNesting,
               s.pagerank
        FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE ${conds.join(' AND ')}
        ORDER BY s.${col} DESC, s.pagerank DESC
        LIMIT ?
      `;
      const rows = (this.store as any).rawDb().prepare(sql).all(...args);
      return this.budgetedText({ by: col, minValue: min }, rows, tokenBudget);
    });

    this.registerTool('seer_behavior', {
      description: 'Ranked behavioral contract for a symbol: direct/indirect/naming-convention/same-file tests with assertion counts, graph distance, and recency. Use this BEFORE editing a symbol to find the tests that describe its expected behavior. Pass file to disambiguate common method names.',
      inputSchema: {
        symbol: z.string(),
        file: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
        indirectDepth: z.number().int().nonnegative().max(4).optional()
          .describe('BFS depth for indirect coverage (callers that transitively reach the symbol). 0 disables indirect.'),
        includeNamingConvention: z.boolean().optional(),
        includeSameFile: z.boolean().optional(),
      },
    }, async ({ symbol, file, limit, indirectDepth, includeNamingConvention, includeSameFile }) => {
      await this.ensureFresh();
      const result = rankedBehavior(this.store, symbol, {
        filePath: file,
        limit: limit ?? 30,
        indirectDepth: indirectDepth ?? 2,
        includeNamingConvention: includeNamingConvention ?? true,
        includeSameFile: includeSameFile ?? true,
      });
      if (!result) {
        const didYouMean = this.suggestSymbols(symbol);
        const declarationHint = this.declarationHint(symbol, file);
        return this.text({ symbol, total: 0, direct: 0, indirect: 0, tests: [], reason: `no symbol "${symbol}"`,
          ...(declarationHint ? { declarationHint } : {}),
          ...(didYouMean.length > 0 ? { didYouMean } : {}) });
      }
      const nameAmbiguity = this.nameAmbiguityHint(symbol, file);
      const out: Record<string, unknown> = nameAmbiguity ? { ...result, nameAmbiguity } : { ...result };
      const warnings: AgentWarning[] = [];
      let suggestedCall: AgentNextBestCall | undefined;
      if (nameAmbiguity) {
        warnings.push(this.nameAmbiguityWarning(symbol, nameAmbiguity.otherDefinitionsCount));
        suggestedCall = this.nameAggregateNextCall(symbol);
      }
      if (result.lowConfidence) {
        warnings.push(agentWarning(
          'heuristic-coverage',
          'Only heuristic test evidence was found; verify tests before treating this as coverage.',
        ));
        suggestedCall ??= nextBestCall(
          'seer_callers',
          { symbol: result.symbol.qualifiedName ?? result.symbol.name, file: result.symbol.file, includeNameMatches: true, limit: 40 },
          'Heuristic behavior evidence is name-based; includeNameMatches shows same-name call sites to verify manually.',
        );
      }
      out.precision = result.lowConfidence
        ? heuristicPrecision('Only heuristic test evidence was found; verify tests before treating this as coverage.')
        : result.testCoverageState === 'no-indexed-tests' || result.testCoverageState === 'test-indexing-unavailable'
          ? unknownPrecision('Behavior coverage cannot be established from the current test index.')
          : result.testCoverageState === 'tests-indexed-no-link'
            ? unknownPrecision('Tests are indexed, but no behavioral link was found; absence of a link is not proof of no coverage.')
            : exactPrecision(`Behavior coverage state is ${result.testCoverageState}.`);
      if (warnings.length > 0) out.warnings = warnings;
      if (suggestedCall) out.nextBestCall = suggestedCall;
      // Honest "tests mention this name" signal for the heuristic-only / no-link
      // cases: when the call graph can't confirm coverage (C/C++ member calls
      // lose the receiver type), an agent otherwise has to grep tests/ by hand
      // (the Claude review's "I had to manually find the 46 files"). Surface the
      // by-name reference count — labelled as references, NOT verified coverage.
      if (result.testCoverageState === 'heuristic-only' || result.testCoverageState === 'tests-indexed-no-link') {
        const refs = this.store.countNameCallsInTests(result.symbol.name);
        if (refs.callSites > 0) {
          out.testNameReferences = {
            ...refs,
            note: `${refs.callSites} call site(s) across ${refs.files} test file(s) invoke a method named "${result.symbol.name}". These are NAME references (receiver type unresolved), not verified coverage of THIS symbol — open the files to confirm.`,
          };
        }
      }
      return this.text(out);
    });

    this.registerTool('seer_trace_path', {
      description: 'Bounded BFS shortest call path from one symbol to another.',
      inputSchema: {
        from: z.string(),
        to: z.string(),
        maxDepth: z.number().int().positive().max(12).optional(),
      },
    }, async ({ from, to, maxDepth }) => {
      await this.ensureFresh();
      const fromCandidates = this.store.getDefinition(from);
      const toCandidates = this.store.getDefinition(to);
      if (fromCandidates.length === 0) return this.text({ found: false, reason: `no symbol "${from}"` });
      if (toCandidates.length === 0)   return this.text({ found: false, reason: `no symbol "${to}"` });
      // Try the highest-PageRank pair first.
      for (const f of fromCandidates.slice(0, 5)) {
        for (const t of toCandidates.slice(0, 5)) {
          const p = this.store.tracePath(f.id, t.id, maxDepth ?? 6);
          if (p) return this.text({ found: true, depth: p.length - 1, path: p });
        }
      }
      return this.text({ found: false, reason: `no path within depth ${maxDepth ?? 6}` });
    });

    this.registerTool('seer_trace_callers', {
      description: 'Bounded reverse-reachable callers of a symbol (transitive blast radius). Pass file to disambiguate common names. Default mode=preview returns exact totals, depth/file summaries, and a small page of rows; use mode=full only when you need more raw rows.',
      inputSchema: {
        symbol: z.string(),
        file: z.string().optional(),
        maxDepth: z.number().int().positive().max(8).optional(),
        maxNodes: z.number().int().positive().max(50000).optional(),
        limit: z.number().int().positive().max(500).optional(),
        offset: z.number().int().nonnegative().max(50000).optional(),
        mode: z.enum(['summary', 'preview', 'full']).optional()
          .describe('summary returns counts/top files only; preview is compact default; full returns a larger raw page.'),
        summaryOnly: z.boolean().optional().describe('Shortcut for mode=summary.'),
        tokenBudget: z.number().int().positive().max(50000).optional()
          .describe('Soft cap (~4 chars/token) that trims the returned row page, never the totals or summary.'),
      },
    }, async ({ symbol, file, maxDepth, maxNodes, limit, offset, mode, summaryOnly, tokenBudget }) => {
      await this.ensureFresh();
      const defs = this.store.getDefinition(symbol, { filePath: file });
      if (defs.length === 0) return this.text({
        found: false,
        reason: file ? `no symbol "${symbol}" in ${file}` : `no symbol "${symbol}"`,
      });
      const target = defs[0];
      const maxD = maxDepth ?? 4;
      const maxN = maxNodes ?? 20000;
      const selectedMode = this.traceMode(mode, summaryOnly);
      const pageLimit = this.traceLimit(selectedMode, limit);
      const hits = this.store.reverseReachableWithDepth(target.id, maxD, maxN);
      const pageOffset = Math.min(offset ?? 0, hits.length);
      const { items, pageItems, sampled } = this.loadTraceItems(hits, pageOffset, pageLimit);
      const hasNextPage = selectedMode !== 'summary' && pageOffset + pageItems.length < hits.length;
      const nameAmbiguity = this.nameAmbiguityHint(symbol, file);
      const resolvedCallsites = this.store.countCallersById(target.id);
      const callerAmbiguity = this.callerAmbiguity({
        id: target.id, name: target.name, filePath: target.filePath, total: resolvedCallsites,
      });
      const warnings: AgentWarning[] = [];
      if (nameAmbiguity) warnings.push(this.nameAmbiguityWarning(symbol, nameAmbiguity.otherDefinitionsCount));
      if (callerAmbiguity) warnings.push(this.ambiguityWarning(callerAmbiguity));
      const precision = callerAmbiguity
        ? this.ambiguityGraphPrecision()
        : exactPrecision('Trace is resolved from the selected symbol id.');
      const suggestedCall = nameAmbiguity
        ? this.nameAggregateNextCall(symbol)
        : callerAmbiguity
          ? this.ambiguityNextCall(target)
          : hasNextPage
            ? nextBestCall(
                'seer_trace_callers',
                { symbol, ...(file ? { file } : {}), maxDepth: maxD, maxNodes: maxN, mode: selectedMode, limit: pageLimit, offset: pageOffset + pageItems.length },
                'More trace rows are available; use nextOffset to fetch the next page.',
              )
            : selectedMode === 'summary'
              ? nextBestCall(
                  'seer_trace_callers',
                  { symbol, ...(file ? { file } : {}), maxDepth: maxD, maxNodes: maxN, mode: 'preview', limit: TRACE_PREVIEW_LIMIT },
                  'Summary mode omits raw rows; preview mode returns a compact first page.',
                )
              : undefined;
      const base = {
        symbol: { id: target.id, name: target.name, qualifiedName: target.qualifiedName, file: target.filePath },
        ...(nameAmbiguity ? { nameAmbiguity } : {}),
        ...(callerAmbiguity ? { ambiguity: callerAmbiguity } : {}),
        precision,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(suggestedCall ? { nextBestCall: suggestedCall } : {}),
        maxDepth: maxD,
        maxNodes: maxN,
        total: hits.length,
        offset: pageOffset,
        limit: pageLimit,
        truncated: hasNextPage,
        nextOffset: hasNextPage ? pageOffset + pageItems.length : null,
        mode: selectedMode,
        source: 'tree-sitter',
        ...this.traceSummary(hits, items, sampled),
        note: selectedMode === 'full'
          ? 'Full mode still paginates. Increase limit or use nextOffset for more rows.'
          : 'Compact trace preview. Use mode="summary" for counts only or mode="full" with limit/offset for more rows.',
      };
      if (selectedMode === 'summary') return this.text({ ...base, rows: { returned: 0, omittedByMode: true, note: 'Summary mode returns aggregates only (totals + topFiles/topSymbols/depthCounts where present). No raw rows are included by design — re-call with summaryOnly=false (or mode="preview"/"full") and page with offset/limit to get rows.' } });
      return this.budgetedText(base, pageItems, tokenBudget);
    });

    this.registerTool('seer_trace_callees', {
      description: 'Bounded forward-reachable callees of a symbol. Default mode=preview returns exact totals, depth/file summaries, and a small page of rows; use mode=full only when you need more raw rows.',
      inputSchema: {
        symbol: z.string(),
        file: z.string().optional(),
        maxDepth: z.number().int().positive().max(8).optional(),
        maxNodes: z.number().int().positive().max(50000).optional(),
        limit: z.number().int().positive().max(500).optional(),
        offset: z.number().int().nonnegative().max(50000).optional(),
        mode: z.enum(['summary', 'preview', 'full']).optional()
          .describe('summary returns counts/top files only; preview is compact default; full returns a larger raw page.'),
        summaryOnly: z.boolean().optional().describe('Shortcut for mode=summary.'),
        tokenBudget: z.number().int().positive().max(50000).optional()
          .describe('Soft cap (~4 chars/token) that trims the returned row page, never the totals or summary.'),
      },
    }, async ({ symbol, file, maxDepth, maxNodes, limit, offset, mode, summaryOnly, tokenBudget }) => {
      await this.ensureFresh();
      const defs = this.store.getDefinition(symbol, { filePath: file });
      if (defs.length === 0) return this.text({
        found: false,
        reason: file ? `no symbol "${symbol}" in ${file}` : `no symbol "${symbol}"`,
      });
      const target = defs[0];
      const maxD = maxDepth ?? 4;
      const maxN = maxNodes ?? 20000;
      const selectedMode = this.traceMode(mode, summaryOnly);
      const pageLimit = this.traceLimit(selectedMode, limit);
      const hits = this.store.forwardReachableWithDepth(target.id, maxD, maxN);
      const pageOffset = Math.min(offset ?? 0, hits.length);
      const { items, pageItems, sampled } = this.loadTraceItems(hits, pageOffset, pageLimit);
      const hasNextPage = selectedMode !== 'summary' && pageOffset + pageItems.length < hits.length;
      const nameAmbiguity = this.nameAmbiguityHint(symbol, file);
      const warnings = nameAmbiguity
        ? [this.nameAmbiguityWarning(symbol, nameAmbiguity.otherDefinitionsCount)]
        : [];
      const suggestedCall = nameAmbiguity
        ? this.nameAggregateNextCall(symbol)
        : hasNextPage
          ? nextBestCall(
              'seer_trace_callees',
              { symbol, ...(file ? { file } : {}), maxDepth: maxD, maxNodes: maxN, mode: selectedMode, limit: pageLimit, offset: pageOffset + pageItems.length },
              'More trace rows are available; use nextOffset to fetch the next page.',
            )
          : selectedMode === 'summary'
            ? nextBestCall(
                'seer_trace_callees',
                { symbol, ...(file ? { file } : {}), maxDepth: maxD, maxNodes: maxN, mode: 'preview', limit: TRACE_PREVIEW_LIMIT },
                'Summary mode omits raw rows; preview mode returns a compact first page.',
              )
            : undefined;
      const base = {
        symbol: { id: target.id, name: target.name, qualifiedName: target.qualifiedName, file: target.filePath },
        ...(nameAmbiguity ? { nameAmbiguity } : {}),
        precision: exactPrecision('Trace is resolved from the selected symbol id.'),
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(suggestedCall ? { nextBestCall: suggestedCall } : {}),
        maxDepth: maxD,
        maxNodes: maxN,
        total: hits.length,
        offset: pageOffset,
        limit: pageLimit,
        truncated: hasNextPage,
        nextOffset: hasNextPage ? pageOffset + pageItems.length : null,
        mode: selectedMode,
        source: 'tree-sitter',
        ...this.traceSummary(hits, items, sampled),
        note: selectedMode === 'full'
          ? 'Full mode still paginates. Increase limit or use nextOffset for more rows.'
          : 'Compact trace preview. Use mode="summary" for counts only or mode="full" with limit/offset for more rows.',
      };
      if (selectedMode === 'summary') return this.text({ ...base, rows: { returned: 0, omittedByMode: true, note: 'Summary mode returns aggregates only (totals + topFiles/topSymbols/depthCounts where present). No raw rows are included by design — re-call with summaryOnly=false (or mode="preview"/"full") and page with offset/limit to get rows.' } });
      return this.budgetedText(base, pageItems, tokenBudget);
    });

    this.registerTool('seer_architecture', {
      description: 'One-page snapshot of the codebase: languages, modules, top symbols, entry points, hotspots, deps.',
      inputSchema: {},
    }, async () => {
      await this.ensureFresh();
      return this.text(buildArchitecture(this.workspace, this.store));
    });

    this.registerTool('seer_detect_changes', {
      description: 'Compute blast-radius of an uncommitted (or between-refs) diff. Direct + transitive callers.',
      inputSchema: {
        fromRef: z.string().optional(),
        toRef: z.string().optional(),
        callerDepth: z.number().int().positive().max(6).optional().describe('Transitive-caller BFS depth. Max 6.'),
      },
    }, async ({ fromRef, toRef, callerDepth }) => {
      await this.ensureFresh();
      return this.text(detectChanges(this.workspace, this.store, { fromRef, toRef, callerDepth }));
    });

    this.registerTool('seer_churn', {
      description: 'Run a file-level git churn pass (commit counts, last commit, authors). Idempotent.',
      inputSchema: {
        gitCommandTimeoutMs: z.number().int().positive().max(60000).optional()
          .describe('Timeout for the underlying git log command. Default 15000ms or SEER_GIT_TIMEOUT_MS.'),
      },
    }, async ({ gitCommandTimeoutMs }) => {
      return this.text(await collectChurn(this.workspace, this.store, { gitCommandTimeoutMs }));
    });

    // ── Track-D tools ───────────────────────────────────────────────────────

    this.registerTool('seer_history', {
      description: 'Per-symbol git history: commits whose hunks overlap the symbol\'s line range, with author, PR, and churn. If history is not built yet, this auto-builds JUST this symbol\'s file(s) inline (bounded, ~1s) and returns the rows — no separate build step needed. Pass autoBuild=false to force a pure read-only lookup. Pass file to disambiguate a common name.',
      inputSchema: {
        symbol: z.string(),
        limit: z.number().int().positive().max(200).optional(),
        since: z.number().int().optional().describe('Unix-seconds lower bound on committed_at'),
        file: z.string().optional(),
        autoBuild: z.boolean().optional()
          .describe('On a cold miss, build just this symbol\'s file(s) inline (bounded) so the first call returns history. Default true; set false for a strictly read-only lookup (e.g. inside seer_batch).'),
      },
    }, async ({ symbol, limit, since, file, autoBuild }) => {
      await this.ensureFresh();
      let historyIndex = this.historyIndexStatus();
      const candidates = this.store.getDefinition(symbol, { filePath: file });

      // Read the current history rows for the resolved candidates. Called again
      // after a lazy build so the same shaping serves both passes.
      const readItems = (): any[] => {
        const out: any[] = [];
        const continuityRows = this.countTableRows('symbol_history_continuity');
        for (const c of candidates.slice(0, 5)) {
          const history = this.store.getSymbolHistory(c.id, { limit: limit ?? 50, since });
          const total = this.store.countSymbolHistory(c.id);
          const continuity = continuityRows > 0 ? getContinuityForSymbol(this.store, c.id) : [];
          out.push({
            symbol: { id: c.id, name: c.name, qualifiedName: c.qualifiedName, kind: c.kind, file: c.filePath },
            total,
            returned: history.length,
            commits: history.map(h => ({
              sha: h.commitSha,
              author: h.authorName, email: h.authorEmail,
              committedAt: h.committedAt,
              message: h.message,
              linesAdded: h.linesAdded, linesRemoved: h.linesRemoved,
              prNumber: h.prNumber, prUrl: h.prUrl,
              matchStrategy: h.matchStrategy, confidence: h.confidence,
            })),
            continuity,
          });
        }
        return out;
      };

      let items = readItems();
      let anyRows = items.some(it => it.total > 0);
      // The FULL-index signal is the stamped global HEAD (a scoped build leaves it null).
      const fullyBuilt = (historyIndex as { lastHistoryHeadSha?: string | null }).lastHistoryHeadSha != null;

      // Lazy on-demand build (the fix for the jarring two-step flow three review
      // agents hit): when the symbol resolves but has NO rows and the full index
      // isn't built, build just its file(s) inline — bounded by a short deadline
      // and per-file git timeout, resume-watermarked so a genuinely-empty file is
      // only ever walked once. A fully-built index that still has no rows is a
      // real "no history", not a missing build, so we don't re-walk there.
      let autoBuildInfo: Record<string, unknown> | undefined;
      const shouldAutoBuild = autoBuild !== false && candidates.length > 0 && !anyRows && !fullyBuilt;
      if (shouldAutoBuild) {
        const filePaths = Array.from(new Set(candidates.slice(0, 5).map(c => c.filePath)));
        const t0 = Date.now();
        try {
          const br = await buildSymbolHistory(this.workspace, this.store, {
            onlyPaths: filePaths,
            maxCommitsPerFile: 200,
            deadlineMs: 15_000,
            gitCommandTimeoutMs: DEFAULT_HISTORY_GIT_TIMEOUT_MS,
            skipIfHeadUnchanged: true,
            // Bypass per-file resume watermarks: we only reach here because the
            // symbol has NO rows, so a watermark that would skip the file is
            // stale (rows cleared by a reindex but the watermark kept) and must
            // not block the build. replaceSymbolHistoryForSymbols is delete-then-
            // insert, so re-walking the file can't duplicate rows.
            useResumeWatermarks: false,
          });
          items = readItems();
          anyRows = items.some(it => it.total > 0);
          historyIndex = this.historyIndexStatus();
          autoBuildInfo = {
            ran: true,
            scopedFiles: filePaths.length,
            rowsInserted: br.historyRowsInserted,
            completed: br.completed,
            elapsedMs: Date.now() - t0,
          };
        } catch (err) {
          autoBuildInfo = { ran: true, failed: true, reason: (err as Error).message, elapsedMs: Date.now() - t0 };
        }
      }

      // Honest hint when there is still nothing to show.
      const buildHint = !anyRows
        ? (autoBuildInfo && (autoBuildInfo.failed || autoBuildInfo.completed === false)
            ? `Inline history build for "${symbol}" did not finish (large/old file). Run \`seer symbol-history --paths "${file ?? candidates[0]?.filePath ?? ''}"\` outside the agent, or retry with a larger budget.`
            : autoBuild === false
              ? `No history rows for "${symbol}" and autoBuild=false. Re-call seer_history (autoBuild defaults on) or run seer_symbol_history_build { symbols: ["${symbol}"]${file ? `, file: "${file}"` : ''} }.`
              : `No git history overlaps "${symbol}"'s current line range. The symbol may be new, or its file changed since the last build.`)
        : undefined;
      const note = fullyBuilt
        ? 'Honest limits: by default file renames cut off history at the rename commit (continuity bridges them); symbol renames also cut off there. Confidence drops with commit age.'
        : anyRows
          ? (autoBuildInfo?.ran
              ? 'History built on demand for this symbol\'s file. The FULL index is not built, so other symbols may report no history until they are queried (each auto-builds its own file) or you run `seer symbol-history`.'
              : 'This symbol\'s history is available from a scoped build; the FULL index is not built, so other symbols may report no history until queried or you run `seer symbol-history`.')
          : 'Symbol history is not built for this workspace yet, and the on-demand build returned nothing for this symbol. Run `seer symbol-history --workspace <repo>` outside the agent for the full index.';
      return this.text({
        symbol,
        file,
        historyIndex,
        ...(autoBuildInfo ? { autoBuild: autoBuildInfo } : {}),
        returned: items.length,
        results: items,
        ...(buildHint ? { buildHint } : {}),
        note,
      });
    });

    this.registerTool('seer_changes_with', {
      description: 'Temporal coupling (advisory): which OTHER symbols have historically changed in the SAME commits as this one. Catches edit-impact the call graph cannot — shared formats, protocol constants, parallel impls, config. Each partner carries sharedCommits (co-change count) and a confidence (P(partner changes | this changes), 0..1). Huge sweeping commits are dropped as noise. Read-only: check historyComplete. When historyComplete is false, partners may be partial or falsely empty; run seer_symbol_history_build with no args for authoritative coupling. Pass file to disambiguate a common name.',
      inputSchema: {
        symbol: z.string(),
        file: z.string().optional(),
        limit: z.number().int().positive().max(100).optional().describe('Max coupled partners to return (default 20).'),
        minSupport: z.number().int().positive().max(100).optional()
          .describe('Minimum shared commits for a partner to count (default 2; raise to cut coincidences).'),
        maxCommitSymbols: z.number().int().min(2).max(2000).optional()
          .describe('Drop commits touching more than this many distinct symbols as noise (default 50). Lower it on repos with frequent sweeping refactors.'),
        since: z.number().int().optional().describe('Unix-seconds lower bound on commit time.'),
        includeSameFile: z.boolean().optional()
          .describe('Include partners in the same file as the target (proximity coupling). Default true; set false for cross-file links only.'),
      },
    }, async ({ symbol, file, limit, minSupport, maxCommitSymbols, since, includeSameFile }) => {
      await this.ensureFresh();
      const historyIndex = this.historyIndexStatus();
      const target = this.store.getDefinition(symbol, { filePath: file })[0] ?? null;
      if (!target) {
        const didYouMean = this.suggestSymbols(symbol);
        return this.text({ symbol, file, found: false, partners: [], source: 'git-history',
          historyIndex,
          reason: `no symbol "${symbol}"${file ? ` in ${file}` : ''}`,
          ...(didYouMean.length > 0 ? { didYouMean } : {}) });
      }
      const result = computeCoupling(this.store, target.id, {
        limit, minSupport, maxCommitSymbols, since, includeSameFile,
      });
      const nameAmbiguity = this.nameAmbiguityHint(symbol, file);
      // Coupling is only trustworthy against the FULL, repo-wide history index:
      // a partner's file must be in symbol_history too, or it silently can't
      // co-occur. historyIndex.built is too weak — it flips true as soon as a
      // single scoped seer_history auto-build inserts ANY rows (with
      // lastHistoryHeadSha still null), which would make partial/empty coupling
      // look authoritative. The full build is the one that stamps
      // lastHistoryHeadSha, so gate on that. (See store.getHistoryIndexInfo.)
      const fullyBuilt = historyIndex.lastHistoryHeadSha != null;
      const note = !fullyBuilt
        ? 'Symbol history is not FULLY built, so coupling is unreliable here (it may be partial or falsely empty). Coupling needs REPO-WIDE history — each partner\'s file must be indexed too — so a single-file auto-build is not enough. Run `seer symbol-history` or seer_symbol_history_build with no args, then re-call.'
        : result.targetCommits === 0
          ? 'No built history overlaps this symbol\'s current line range (it may be new, or its file changed since the last full build).'
          : 'Advisory: co-change is correlation, not causation. confidence = P(partner changes | this changes) over non-noisy commits. Verify a partner before trusting it.';
      return this.text({
        symbol, file,
        historyIndex,
        // Structured honesty flag so an agent can branch without parsing prose:
        // when false, `partners` may be partial or empty regardless of content.
        historyComplete: fullyBuilt,
        ...result,
        ...(nameAmbiguity ? { nameAmbiguity } : {}),
        note,
      });
    });

    this.registerTool('seer_symbol_history_build', {
      description: 'Build the per-symbol git history index (this tool WRITES to the index). SCOPED is the cheap agent path: pass `symbols` (and/or `file`) or `paths` to build only those files\' history in ~1s — answer "history of one symbol" without a whole-repo build. Omit all of them for a bounded full build (prefer the CLI `seer symbol-history` for very large repos). Re-running is incremental: only files changed since last build are reprocessed.',
      inputSchema: {
        symbols: z.array(z.string()).max(50).optional()
          .describe('Build history for just the files that define these symbols (scoped/on-demand). Resolved by name; pair with `file` to disambiguate a single common name.'),
        file: z.string().optional().describe('Disambiguating file for a single `symbols` entry.'),
        paths: z.array(z.string()).max(50).optional()
          .describe('Build history for just these files (absolute or repo-relative). Scoped/on-demand.'),
        follow: z.boolean().optional()
          .describe('Thread git --follow through file renames in the raw history (slower; default off — the continuity pass bridges renames).'),
        maxCommitsPerFile: z.number().int().positive().max(2000).optional(),
        maxFiles: z.number().int().positive().max(100000).optional(),
        maxSeconds: z.number().int().positive().max(600).optional(),
        since: z.union([z.number().int(), z.string()]).optional()
          .describe('History horizon for a full build: a duration ("2y", "18mo", "90d"), an ISO date, or unix seconds. Bounds each file\'s git-log walk so rarely-changed files do not force a full-DAG scan (~3x faster on large repos). 0/"all" = unbounded (default).'),
        gitCommandTimeoutMs: z.number().int().positive().max(60000).optional(),
        force: z.boolean().optional(),
      },
    }, async ({ symbols, file, paths, follow, maxCommitsPerFile, maxFiles, maxSeconds, since: sinceRaw, gitCommandTimeoutMs, force }) => {
      // Resolve a scoped file set from `symbols` and/or `paths`. A scoped build
      // is fast (one git walk per file), bounded, and does not stamp the global
      // history HEAD — so it never masquerades as a full build.
      const onlyPaths = new Set<string>();
      for (const p of paths ?? []) onlyPaths.add(p);
      const unresolved: string[] = [];
      for (const sym of symbols ?? []) {
        const defs = this.store.getDefinition(sym, { filePath: file });
        if (defs.length === 0) { unresolved.push(sym); continue; }
        for (const d of defs.slice(0, 5)) onlyPaths.add(d.filePath);
      }
      const scopedRequested = (symbols?.length ?? 0) > 0 || (paths?.length ?? 0) > 0;
      const scoped = scopedRequested;
      if (scopedRequested && onlyPaths.size === 0) {
        return this.text({
          completed: true,
          filesProcessed: 0,
          filesTotal: 0,
          filesRemaining: 0,
          filesSkippedResume: 0,
          symbolsProcessed: 0,
          historyRowsInserted: 0,
          skipped: true,
          elapsedMs: 0,
          scoped: true,
          scopedFiles: 0,
          ...(unresolved.length > 0 ? { unresolvedSymbols: unresolved } : {}),
          historyIndex: this.historyIndexStatus(),
          note: 'Scoped symbol-history build did not run because no requested symbols/paths resolved to indexed source files. Check the symbol name or pass file/path to disambiguate.',
        });
      }
      // Resolve the optional history horizon (scoped builds ignore it — they are
      // already cheap and bounded to the requested files). An unparseable value
      // is reported rather than silently treated as unbounded.
      let since: number | undefined;
      const effectiveSinceRaw = sinceRaw ?? process.env.SEER_HISTORY_SINCE;
      if (!scoped && effectiveSinceRaw != null) {
        const parsed = parseHistorySince(typeof effectiveSinceRaw === 'number' ? String(effectiveSinceRaw) : effectiveSinceRaw);
        if (parsed === null) {
          return this.text({ error: `Invalid "since" value: ${effectiveSinceRaw}`, historyIndex: this.historyIndexStatus() });
        }
        since = parsed;
      }
      const r = await buildSymbolHistory(this.workspace, this.store, {
        ...(scoped ? { onlyPaths: Array.from(onlyPaths) } : {}),
        follow,
        maxCommitsPerFile: maxCommitsPerFile ?? 200,
        maxFiles,
        deadlineMs: (maxSeconds ?? DEFAULT_HISTORY_BUILD_SECONDS) * 1000,
        ...(since !== undefined ? { since } : {}),
        gitCommandTimeoutMs: gitCommandTimeoutMs ?? DEFAULT_HISTORY_GIT_TIMEOUT_MS,
        skipIfHeadUnchanged: !force,
      });
      return this.text({
        ...r,
        scoped,
        ...(scoped ? { scopedFiles: onlyPaths.size } : {}),
        ...(unresolved.length > 0 ? { unresolvedSymbols: unresolved } : {}),
        historyIndex: this.historyIndexStatus(),
        note: r.diagnostic
          ? r.diagnostic
          : scoped
            ? `Scoped build of ${onlyPaths.size} file(s) done — call seer_history for those symbols now. The global index is NOT marked fully built (run a full build or the CLI for that).`
            : r.completed
              ? 'Full symbol history build completed.'
              : 'Partial build only. Run again with a larger maxSeconds/maxFiles budget, or use the CLI for long history indexing outside an agent session.',
      });
    });

    // ── Track-E tools ───────────────────────────────────────────────────────

    this.registerTool('seer_modules', {
      description: 'List modules (Louvain clusters of files) — agents should start here to orient before reading files. Each module reports size, primary language, cohesion (intra-module edges / total), and centrality (sum of member PageRank).',
      inputSchema: {
        limit: z.number().int().positive().max(500).optional(),
        sortBy: z.enum(['centrality', 'size', 'label']).optional(),
      },
    }, async ({ limit, sortBy }) => {
      await this.ensureFresh();
      if (!this.ensureModules()) return this.text({
        ok: false,
        error: 'derived_index_required',
        derivedIndex: 'modules',
        reason: 'Module clustering is not built and this workspace is too large for safe inline MCP auto-build. Run seer_modules_build or rerun `seer index` explicitly.',
      });
      const modules = this.store.listModules({ limit: limit ?? 50, sortBy });
      return this.text({
        total: this.store.countModules(),
        returned: modules.length,
        items: modules,
        source: 'tree-sitter',
      });
    });

    this.registerTool('seer_module_members', {
      description: 'List files and top-PageRank symbols inside a module. Address the module by `id` or `label`.',
      inputSchema: {
        id: z.number().int().positive().optional(),
        label: z.string().optional(),
        fileLimit: z.number().int().positive().max(5000).optional(),
        symbolLimit: z.number().int().positive().max(500).optional(),
      },
    }, async ({ id, label, fileLimit, symbolLimit }) => {
      await this.ensureFresh();
      if (!this.ensureModules()) return this.text({
        ok: false,
        error: 'derived_index_required',
        derivedIndex: 'modules',
        reason: 'Module clustering is not built and this workspace is too large for safe inline MCP auto-build. Run seer_modules_build or rerun `seer index` explicitly.',
      });
      const mod = id != null ? this.store.getModuleById(id)
                : label != null ? this.store.getModuleByLabel(label)
                : null;
      if (!mod) return this.text({ found: false, reason: id != null ? `no module #${id}` : `no module "${label}"` });
      const files = this.store.listModuleMembers(mod.id, fileLimit ?? 100);
      const symbols = this.store.listModuleTopSymbols(mod.id, symbolLimit ?? 25);
      const totalFiles = typeof (mod as { sizeFiles?: unknown }).sizeFiles === 'number'
        ? Number((mod as { sizeFiles?: unknown }).sizeFiles)
        : files.length;
      return this.text({
        module: mod,
        files: {
          total: totalFiles,
          returned: files.length,
          truncated: files.length < totalFiles,
          ...(files.length < totalFiles
            ? { note: 'Compact file preview. Raise fileLimit for more rows.' }
            : {}),
          items: files,
        },
        topSymbols: { returned: symbols.length, items: symbols.map(s => ({
          id: s.id, name: s.name, qualifiedName: s.qualifiedName,
          kind: s.kind, file: s.filePath, lineStart: s.lineStart,
          pagerank: s.pagerank,
        })) },
        source: 'tree-sitter',
      });
    });

    this.registerTool('seer_symbol_module', {
      description: 'Look up the module a symbol belongs to. Helpful for "what part of the codebase does X live in?".',
      inputSchema: {
        symbol: z.string(),
        file: z.string().optional(),
      },
    }, async ({ symbol, file }) => {
      await this.ensureFresh();
      if (!this.ensureModules()) return this.text({
        ok: false,
        error: 'derived_index_required',
        derivedIndex: 'modules',
        reason: 'Module clustering is not built and this workspace is too large for safe inline MCP auto-build. Run seer_modules_build or rerun `seer index` explicitly.',
      });
      const defs = this.store.getDefinition(symbol, { filePath: file });
      if (defs.length === 0) {
        const didYouMean = this.suggestSymbols(symbol);
        return this.text({ found: false, reason: `no symbol "${symbol}"`,
          ...(didYouMean.length > 0 ? { didYouMean } : {}) });
      }
      const out: Array<{ symbol: any; module: any }> = [];
      for (const d of defs.slice(0, 5)) {
        const mod = this.store.moduleForFile(d.fileId);
        out.push({
          symbol: { id: d.id, name: d.name, qualifiedName: d.qualifiedName, kind: d.kind, file: d.filePath },
          module: mod,
        });
      }
      return this.text({ matches: out, source: 'tree-sitter' });
    });

    this.registerTool('seer_module_dependencies', {
      description: 'List module-to-module dependency edges. Direction "out" = modules this one calls/imports/tests into (default). "in" = modules that depend on this one. Edges are aggregated cross-module weights for calls / imports / tests.',
      inputSchema: {
        id: z.number().int().positive().optional(),
        label: z.string().optional(),
        direction: z.enum(['in', 'out']).optional(),
        limit: z.number().int().positive().max(500).optional(),
      },
    }, async ({ id, label, direction, limit }) => {
      await this.ensureFresh();
      if (!this.ensureModules()) return this.text({
        ok: false,
        error: 'derived_index_required',
        derivedIndex: 'modules',
        reason: 'Module clustering is not built and this workspace is too large for safe inline MCP auto-build. Run seer_modules_build or rerun `seer index` explicitly.',
      });
      const mod = id != null ? this.store.getModuleById(id)
                : label != null ? this.store.getModuleByLabel(label)
                : null;
      if (!mod) return this.text({ found: false, reason: id != null ? `no module #${id}` : `no module "${label}"` });
      const deps = this.store.moduleDependencies(mod.id, {
        direction: direction ?? 'out',
        limit: limit ?? 100,
      });
      return this.text({
        module: mod, direction: direction ?? 'out',
        returned: deps.length, items: deps, source: 'tree-sitter',
      });
    });

    this.registerTool('seer_trace_file_dependencies', {
      description: 'Bounded BFS over the resolved import graph starting at a file. Default output is a compact preview; use summaryOnly for counts only and page with offset/limit for more rows.',
      inputSchema: {
        file: z.string(),
        maxDepth: z.number().int().positive().max(8).optional(),
        maxNodes: z.number().int().positive().max(20000).optional(),
        limit: z.number().int().positive().max(500).optional(),
        offset: z.number().int().nonnegative().max(50000).optional(),
        summaryOnly: z.boolean().optional(),
        tokenBudget: z.number().int().positive().max(50000).optional()
          .describe('Soft cap (~4 chars/token) that trims the returned row page, never the totals.'),
      },
    }, async ({ file, maxDepth, maxNodes, limit, offset, summaryOnly, tokenBudget }) => {
      await this.ensureFresh();
      const files = this.store.listFiles();
      const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
      const match = files.find(f =>
        norm(f.path) === norm(file) || norm(f.relPath) === norm(file)
        || norm(f.path).endsWith(norm(file)) || norm(f.relPath).endsWith(norm(file)),
      );
      if (!match) return this.text({ found: false, reason: `no indexed file matching "${file}"` });
      const closure = this.store.fileImportClosure(match.id, maxDepth ?? 4, maxNodes ?? 5000);
      closure.sort((a, b) => a.depth - b.depth || (a.relPath < b.relPath ? -1 : 1));
      const pageLimit = Math.min(limit ?? 50, 500);
      const pageOffset = Math.min(offset ?? 0, closure.length);
      const pageItems = closure.slice(pageOffset, pageOffset + pageLimit)
        .map(c => ({ id: c.id, relPath: c.relPath, language: c.language, depth: c.depth }));
      const hasNextPage = !summaryOnly && pageOffset + pageItems.length < closure.length;
      const base = {
        from: { id: match.id, path: match.path, relPath: match.relPath, language: match.language },
        maxDepth: maxDepth ?? 4,
        totalReachable: closure.length,
        offset: pageOffset,
        limit: pageLimit,
        truncated: hasNextPage,
        nextOffset: hasNextPage ? pageOffset + pageItems.length : null,
        source: 'tree-sitter',
        note: 'Compact dependency preview. Use summaryOnly for counts only or page with offset/limit for more rows.',
      };
      if (summaryOnly) return this.text({ ...base, rows: { returned: 0, omittedByMode: true, note: 'Summary mode returns aggregates only (totals + topFiles/topSymbols/depthCounts where present). No raw rows are included by design — re-call with summaryOnly=false (or mode="preview"/"full") and page with offset/limit to get rows.' } });
      return this.budgetedText(base, pageItems, tokenBudget);
    });

    this.registerTool('seer_trace_module_dependencies', {
      description: 'Bounded BFS over the module dependency graph. Default output is a compact preview; use summaryOnly for counts only and page with offset/limit for more rows.',
      inputSchema: {
        id: z.number().int().positive().optional(),
        label: z.string().optional(),
        maxDepth: z.number().int().positive().max(8).optional(),
        direction: z.enum(['in', 'out']).optional(),
        limit: z.number().int().positive().max(500).optional(),
        offset: z.number().int().nonnegative().max(50000).optional(),
        summaryOnly: z.boolean().optional(),
        tokenBudget: z.number().int().positive().max(50000).optional()
          .describe('Soft cap (~4 chars/token) that trims the returned row page, never the totals.'),
      },
    }, async ({ id, label, maxDepth, direction, limit, offset, summaryOnly, tokenBudget }) => {
      await this.ensureFresh();
      if (!this.ensureModules()) return this.text({
        ok: false,
        error: 'derived_index_required',
        derivedIndex: 'modules',
        reason: 'Module clustering is not built and this workspace is too large for safe inline MCP auto-build. Run seer_modules_build or rerun `seer index` explicitly.',
      });
      const mod = id != null ? this.store.getModuleById(id)
                : label != null ? this.store.getModuleByLabel(label)
                : null;
      if (!mod) return this.text({ found: false, reason: id != null ? `no module #${id}` : `no module "${label}"` });
      const depth = Math.min(maxDepth ?? 4, 8);
      const dir = direction ?? 'out';
      const seen = new Map<number, number>([[mod.id, 0]]);
      const queue: Array<{ id: number; depth: number }> = [{ id: mod.id, depth: 0 }];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (cur.depth >= depth) continue;
        const deps = this.store.moduleDependencies(cur.id, { direction: dir, limit: 500 });
        for (const d of deps) {
          if (seen.has(d.moduleId)) continue;
          seen.set(d.moduleId, cur.depth + 1);
          queue.push({ id: d.moduleId, depth: cur.depth + 1 });
        }
      }
      seen.delete(mod.id);
      const items = Array.from(seen.entries()).map(([mid, d]) => {
        const m = this.store.getModuleById(mid);
        return { id: mid, label: m?.label ?? null, depth: d };
      });
      items.sort((a, b) => a.depth - b.depth || ((a.label ?? '') < (b.label ?? '') ? -1 : 1));
      const pageLimit = Math.min(limit ?? 50, 500);
      const pageOffset = Math.min(offset ?? 0, items.length);
      const pageItems = items.slice(pageOffset, pageOffset + pageLimit);
      const hasNextPage = !summaryOnly && pageOffset + pageItems.length < items.length;
      const base = {
        from: mod, direction: dir, maxDepth: depth,
        totalReachable: items.length,
        offset: pageOffset,
        limit: pageLimit,
        truncated: hasNextPage,
        nextOffset: hasNextPage ? pageOffset + pageItems.length : null,
        source: 'tree-sitter',
        note: 'Compact dependency preview. Use summaryOnly for counts only or page with offset/limit for more rows.',
      };
      if (summaryOnly) return this.text({ ...base, rows: { returned: 0, omittedByMode: true, note: 'Summary mode returns aggregates only (totals + topFiles/topSymbols/depthCounts where present). No raw rows are included by design — re-call with summaryOnly=false (or mode="preview"/"full") and page with offset/limit to get rows.' } });
      return this.budgetedText(base, pageItems, tokenBudget);
    });

    this.registerTool('seer_modules_build', {
      description: '(Advanced — usually unnecessary.) Module clustering (Louvain) runs automatically during indexing and auto-builds on first seer_modules* query. Call only to force a rebuild. Idempotent.',
      inputSchema: {
        forceLarge: z.boolean().optional().describe('Allow inline MCP rebuild even when the workspace exceeds the safe auto-build size guard. Prefer `seer index` from a shell instead.'),
      },
    }, async ({ forceLarge }) => {
      const files = this.store.getStats().files;
      const maxFiles = this.autoModuleMaxFiles();
      if (!forceLarge && files > maxFiles) {
        return this.text({
          ok: false,
          error: 'derived_index_too_large',
          derivedIndex: 'modules',
          files,
          maxFiles,
          reason: 'Module rebuild is too large for a safe MCP call. Run `seer index` from a shell, or pass forceLarge if you intentionally want the agent process to do it.',
        });
      }
      const r = buildModules(this.store);
      return this.text(r);
    });

    this.registerTool('seer_risk', {
      description: 'Deterministic edit-risk profile for a symbol. Returns a decomposed score with per-signal contributions: fan-in, route exposure, test coverage, complexity, churn, config reads, and module-boundary crossings. The verdict (low/medium/high) is for triage; the signals are the evidence. Pass file to disambiguate common method names.',
      inputSchema: {
        symbol: z.string(),
        file: z.string().optional(),
        callerDepth: z.number().int().positive().max(6).optional().describe('Fan-in BFS depth. Max 6.'),
      },
    }, async ({ symbol, file, callerDepth }) => {
      await this.ensureFresh();
      const r = computeRisk(this.store, symbol, { filePath: file, callerDepth: callerDepth ?? 3 });
      if (!r) {
        const didYouMean = this.suggestSymbols(symbol);
        return this.text({ found: false, reason: `no symbol "${symbol}"`,
          ...(didYouMean.length > 0 ? { didYouMean } : {}) });
      }
      const nameAmbiguity = this.nameAmbiguityHint(symbol, file);
      return this.text(nameAmbiguity ? { ...r, nameAmbiguity } : r);
    });

    // ── Track-F tools (portability + precision) ─────────────────────────────

    this.registerTool('seer_bundle_export', {
      description: 'Export the current index as a portable .seerbundle file. Use this in CI or to share a pre-built index with teammates so they skip the cold-start indexing cost.',
      inputSchema: {
        out: z.string().optional().describe('Output path (default: <workspace>/.seer/index.seerbundle)'),
        compressionLevel: z.number().int().min(0).max(9).optional(),
        builtAt: z.number().int().optional().describe('Pin manifest.builtAt (Unix millis) for reproducible bundle bytes.'),
      },
    }, async ({ out, compressionLevel, builtAt }) => {
      const r = await exportBundle(this.dbPath, this.workspace, {
        out, compressionLevel, builtAt,
      });
      return this.text({
        bundlePath: r.bundlePath, bytes: r.bytes,
        manifest: r.manifest, elapsedMs: r.elapsedMs,
      });
    });

    this.registerTool('seer_bundle_info', {
      description: 'Read a bundle\'s manifest without unpacking the DB (schema version, file count, symbol/edge totals, SCIP layers).',
      inputSchema: { bundle: z.string() },
    }, async ({ bundle }) => {
      try {
        return this.text(readBundleManifest(path.resolve(bundle)));
      } catch (err) {
        return this.text({ ok: false, reason: (err as Error).message });
      }
    });

    this.registerTool('seer_bundle_import', {
      description: 'Import a .seerbundle. Defaults to destructive whole-index restore. Pass external=true to import additively as a read-only external layer (peer-repo evidence) that does not replace any local rows.',
      inputSchema: {
        bundle: z.string(),
        overwrite: z.boolean().optional(),
        skipIntegrityCheck: z.boolean().optional(),
        skipSchemaCheck: z.boolean().optional(),
        external: z.boolean().optional().describe('Additive external import — never replaces the local DB.'),
        alias: z.string().optional().describe('External-only: alias for the imported layer.'),
        force: z.boolean().optional().describe('External-only: force re-import even if the same hash is already present.'),
      },
    }, async ({ bundle, overwrite, skipIntegrityCheck, skipSchemaCheck, external, alias, force }) => {
      if (external) {
        try {
          const r = await importExternalBundle(path.resolve(bundle), this.store, {
            alias, force,
          });
          return this.text({
            ok: true, external: true,
            bundleId: r.bundleId, externalProject: r.externalProject,
            externalHash: r.externalHash, schemaVersion: r.schemaVersion,
            routesImported: r.routesImported,
            serviceEndpointsImported: r.serviceEndpointsImported,
            alreadyImported: r.alreadyImported,
            elapsedMs: r.elapsedMs,
          });
        } catch (err) {
          return this.text({ ok: false, external: true, reason: (err as Error).message });
        }
      }
      try {
        // Closing the store ensures the file isn't locked when we overwrite.
        const wasWatchEnabled = this.watcher != null;
        if (this.watcher) { await this.watcher.stop(); this.watcher = null; }
        this.store.close();
        // Use this.dbPath so a server started with `--db custom.db` keeps
        // serving the same file after import. Without this override the
        // bundle would land at <workspace>/.seer/graph.db (the default in
        // importBundle) while the server kept reading from `custom.db`.
        const r = await importBundle(path.resolve(bundle), {
          repoRoot: this.workspace, overwrite,
          skipIntegrityCheck, skipSchemaCheck,
          dbOut: this.dbPath,
        });
        // Re-open against the freshly imported DB.
        this.store = new Store(this.dbPath);
        this.indexer = new Indexer(this.store);
        if (wasWatchEnabled) {
          this.watcher = new SeerWatcher(this.workspace, this.indexer, {
            log: (m) => process.stderr.write(`[watcher] ${m}\n`),
          });
          this.watcher.start();
        }
        return this.text({
          ok: true, dbPath: r.dbPath, manifest: r.manifest, elapsedMs: r.elapsedMs,
        });
      } catch (err) {
        return this.text({ ok: false, reason: (err as Error).message });
      }
    });

    this.registerTool('seer_continuity', {
      description: 'v10 — Rename/move continuity candidates for a symbol. When the exact symbol_key history walk terminates at a rename/move boundary, this tool surfaces honest, confidence-labelled candidates for the previous identity (shape_hash exact / close match, same containing scope, similar name). Always advisory — confidence < 1.0 reflects ambiguity.',
      inputSchema: {
        symbol: z.string(),
        file: z.string().optional(),
      },
    }, async ({ symbol, file }) => {
      await this.ensureFresh();
      if (!this.ensureContinuity()) return this.text({
        ok: false,
        error: 'derived_index_required',
        derivedIndex: 'continuity',
        reason: 'Continuity evidence needs shape hashes, and this workspace is too large for safe inline MCP auto-build. Run seer_shape_hash_build or rerun `seer index` explicitly.',
      });
      const defs = this.store.getDefinition(symbol, { filePath: file });
      if (defs.length === 0) {
        const didYouMean = this.suggestSymbols(symbol);
        return this.text({ ok: false, reason: `no symbol "${symbol}"`,
          ...(didYouMean.length > 0 ? { didYouMean } : {}) });
      }
      const items = defs.slice(0, 5).map(d => ({
        symbol: { id: d.id, name: d.name, qualifiedName: d.qualifiedName, kind: d.kind, file: d.filePath },
        candidates: getContinuityForSymbol(this.store, d.id),
      }));
      return this.text({ ok: true, results: items });
    });

    this.registerTool('seer_boundaries', {
      description: 'v10 — List monorepo package/service boundaries detected from manifests (package.json/pyproject.toml/Cargo.toml/go.mod/composer.json) and the services/* / packages/* / apps/* / libs/* fallback. Strictly advisory.',
      inputSchema: {
        limit: z.number().int().positive().max(1000).optional(),
      },
    }, async ({ limit }) => {
      await this.ensureFresh();
      const items = this.store.listBoundaries(limit ?? 100);
      return this.text({
        total: this.store.countBoundaries(),
        returned: items.length,
        items,
        source: 'tree-sitter',
      });
    });

    this.registerTool('seer_boundary_for_file', {
      description: 'v10 — Look up the boundary that owns a file. Returns null when no boundary matched (file lives outside any detected package/service root).',
      inputSchema: {
        file: z.string(),
      },
    }, async ({ file }) => {
      await this.ensureFresh();
      const files = this.store.listFiles();
      const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
      const match = files.find(f =>
        norm(f.path) === norm(file) || norm(f.relPath) === norm(file)
        || norm(f.path).endsWith(norm(file)) || norm(f.relPath).endsWith(norm(file)));
      if (!match) return this.text({ ok: false, reason: `no indexed file matching "${file}"` });
      const boundary = this.store.boundaryForFile(match.id);
      return this.text({
        ok: true,
        file: { id: match.id, relPath: match.relPath },
        boundary,
      });
    });

    this.registerTool('seer_boundary_dependencies', {
      description: 'v10 — Cross-boundary dependency edges from a given boundary (aggregated cross-boundary call/import/service-link weights).',
      inputSchema: {
        boundaryId: z.number().int().nonnegative(),
        direction: z.enum(['in', 'out']).optional(),
        limit: z.number().int().positive().max(500).optional(),
      },
    }, async ({ boundaryId, direction, limit }) => {
      await this.ensureFresh();
      const items = this.store.boundaryDependencies(boundaryId, {
        direction: direction ?? 'out',
        limit: limit ?? 100,
      });
      return this.text({
        boundaryId, direction: direction ?? 'out',
        returned: items.length,
        items,
      });
    });

    this.registerTool('seer_preflight', {
      description: 'CORE pre-edit tool. Compact "should I edit this?" evidence packet. Pass `symbol` for a single-symbol packet (risk, likely tests, service impact, history), or `fromRef`/`toRef` for a diff-range packet. Output is structured facts only. Caps: maxSymbols/maxTests/maxHistory ≤ 50, callerDepth ≤ 6.',
      inputSchema: {
        symbol: z.string().optional(),
        file: z.string().optional(),
        fromRef: z.string().optional(),
        toRef: z.string().optional(),
        oldBundle: z.string().optional(),
        newBundle: z.string().optional(),
        maxSymbols: z.number().int().positive().max(50).optional().describe('Max 50.'),
        maxTests: z.number().int().positive().max(50).optional().describe('Max 50.'),
        maxHistory: z.number().int().positive().max(50).optional().describe('Max 50.'),
        callerDepth: z.number().int().positive().max(6).optional().describe('Blast-radius BFS depth. Max 6.'),
      },
    }, async (args) => {
      await this.ensureFresh();
      const r = await preflight(this.store, {
        symbol: args.symbol,
        filePath: args.file,
        fromRef: args.fromRef,
        toRef: args.toRef,
        workspace: this.workspace,
        oldBundle: args.oldBundle,
        newBundle: args.newBundle,
        maxSymbols: args.maxSymbols,
        maxTests: args.maxTests,
        maxHistory: args.maxHistory,
        callerDepth: args.callerDepth,
      });
      return this.text(r);
    });

    this.registerTool('seer_contract_diff', {
      description: 'Diff API/service contracts between two .seerbundle artifacts (routes, tRPC/GraphQL/gRPC operations, topics, queues). Advisory only — never raises an error for breaking changes. Pass includeAffectedCallers to enrich the diff with service-link evidence when both bundles contain it.',
      inputSchema: {
        oldBundle: z.string(),
        newBundle: z.string(),
        includeAffectedCallers: z.boolean().optional(),
      },
    }, async ({ oldBundle, newBundle, includeAffectedCallers }) => {
      try {
        const diff = await contractDiff(
          path.resolve(oldBundle),
          path.resolve(newBundle),
          { includeAffectedCallers },
        );
        return this.text({ ok: true, ...diff });
      } catch (err) {
        return this.text({ ok: false, reason: (err as Error).message });
      }
    });

    this.registerTool('seer_external_bundles', {
      description: 'List external .seerbundle layers imported into this workspace. Each entry carries the source bundle path, external project alias, manifest hash, schemaVersion, and the rendezvous counts (routes / service endpoints) contributed by that layer.',
      inputSchema: {
        includeRoutes: z.boolean().optional().describe('When true, also returns a bounded preview of the external routes contributed by each layer.'),
        routesPreviewLimit: z.number().int().positive().max(500).optional(),
      },
    }, async ({ includeRoutes, routesPreviewLimit }) => {
      const layers = this.store.listExternalBundles();
      const previewLimit = routesPreviewLimit ?? 25;
      const items = layers.map(layer => {
        const base = {
          id: layer.id,
          sourceKind: layer.sourceKind,
          bundlePath: layer.bundlePath,
          externalProject: layer.externalProject,
          externalVersion: layer.externalVersion,
          externalHash: layer.externalHash,
          schemaVersion: layer.schemaVersion,
          importedAt: layer.importedAt,
          routesImported: layer.routesImported,
          serviceCallsImported: layer.serviceCallsImported,
          serviceLinksImported: layer.serviceLinksImported,
        };
        if (!includeRoutes) return base;
        const routes = this.store.listExternalRoutes({ bundleId: layer.id, limit: previewLimit });
        return { ...base, routesPreview: routes };
      });
      return this.text({
        total: items.length,
        items,
        source: 'external-bundle',
      });
    });

    this.registerTool('seer_scip_import', {
      description: 'Import a SCIP precision index. Adds source-labelled precise edges (provenance="scip") over the tree-sitter baseline. Tree-sitter rows are never deleted; overlapping rows are tagged "scip-merge" instead.',
      inputSchema: {
        scipPath: z.string(),
        requireFileInIndex: z.boolean().optional().describe('Skip SCIP docs whose file isn\'t already indexed (default: true)'),
      },
    }, async ({ scipPath, requireFileInIndex }) => {
      try {
        const r = await importScip(path.resolve(scipPath), this.store, {
          repoRoot: this.workspace,
          requireFileInIndex: requireFileInIndex ?? true,
        });
        return this.text(r);
      } catch (err) {
        return this.text({ ok: false, reason: (err as Error).message });
      }
    });

    this.registerTool('seer_scip_imports', {
      description: 'List every SCIP index that\'s been folded into this DB. Each entry includes the producer tool, sha256, and per-import symbol/ref counts so agents can see exactly which precision layers contributed.',
      inputSchema: {},
    }, async () => {
      return this.text({
        items: this.store.listScipImports(),
        provenance: this.store.getProvenanceCounts(),
      });
    });

    this.registerTool('seer_provenance', {
      description: 'Breakdown of symbols + edges by provenance (tree-sitter / scip / scip-merge). Lets agents tell which signals came from a precise indexer vs the tree-sitter baseline.',
      inputSchema: {},
    }, async () => {
      await this.ensureFresh();
      return this.text({
        provenance: this.store.getProvenanceCounts(),
        scipImports: this.store.listScipImports(),
      });
    });

    this.registerTool('seer_duplicates', {
      description: 'Find clusters of structurally near-duplicate functions/methods (SimHash over the body token shape, identifier-folded so renames still match). Returns each cluster sorted by size with Hamming distance from the cluster anchor.',
      inputSchema: {
        maxDistance: z.number().int().nonnegative().max(32).optional()
          .describe('Max Hamming distance for clustering (default: 6).'),
        minLoc: z.number().int().positive().optional()
          .describe('Minimum LOC for a symbol to count (default: 4).'),
        includeTests: z.boolean().optional(),
        limit: z.number().int().positive().max(1000).optional(),
      },
    }, async ({ maxDistance, minLoc, includeTests, limit }) => {
      await this.ensureFresh();
      if (!this.ensureShapeHashes()) return this.text({
        ok: false,
        error: 'derived_index_required',
        derivedIndex: 'shape_hashes',
        reason: 'Shape hashes are not built and this workspace is too large for safe inline MCP auto-build. Run seer_shape_hash_build or rerun `seer index` explicitly.',
      });
      const clusters = findDuplicates(this.store, {
        maxDistance: maxDistance ?? 6,
        minLoc: minLoc ?? 4,
        includeTests: includeTests ?? false,
        maxClusters: limit ?? 50,
      });
      // bigint isn't JSON-serializable — render as hex.
      return this.text({
        clusters: clusters.length,
        items: clusters.map(c => ({
          fingerprint: c.fingerprint.toString(16),
          size: c.symbols.length,
          symbols: c.symbols,
        })),
        source: 'tree-sitter',
      });
    });

    this.registerTool('seer_shape_hash_build', {
      description: '(Advanced — usually unnecessary.) The shape-hash pass (Track-F SimHash) runs automatically during indexing and auto-builds on first seer_duplicates / seer_continuity query. Call only to force a re-hash. Idempotent.',
      inputSchema: {
        force: z.boolean().optional().describe('Re-hash symbols that already have a hash.'),
        minLoc: z.number().int().positive().optional(),
        forceLarge: z.boolean().optional().describe('Allow inline MCP rebuild even when the workspace exceeds the safe auto-build size guard. Prefer `seer index` from a shell instead.'),
      },
    }, async ({ force, minLoc, forceLarge }) => {
      const pending = this.store.rawDb().prepare(`
        SELECT COUNT(*) AS c
        FROM symbols s
        WHERE s.kind IN ('function','method','constructor')
          AND s.symbol_role <> 'declaration'
          AND s.loc >= ?
          ${force ? '' : 'AND s.shape_hash IS NULL'}
      `).get(minLoc ?? 4) as { c: number };
      const maxSymbols = this.autoShapeMaxSymbols();
      if (!forceLarge && Number(pending.c) > maxSymbols) {
        return this.text({
          ok: false,
          error: 'derived_index_too_large',
          derivedIndex: 'shape_hashes',
          pendingSymbols: Number(pending.c),
          maxSymbols,
          reason: 'Shape-hash rebuild is too large for a safe MCP call. Run `seer index` from a shell, or pass forceLarge if you intentionally want the agent process to do it.',
        });
      }
      const r = buildShapeHashes(this.store, { force, minLoc });
      return this.text(r);
    });

    this.registerTool('seer_context', {
      description: 'CORE pre-edit tool. One compact packet for a symbol: definition, callers, callees, bounded route/config previews with totals, behavioral tests, history, complexity, module, blast radius, and deterministic risk. Use before reading/editing a known symbol, then drill in with seer_callers, seer_history, or seer_behavior. Caps: callerLimit/calleeLimit/testLimit/affectedLimit ≤ 100, historyLimit ≤ 50, callerDepth ≤ 6.',
      inputSchema: {
        symbol: z.string(),
        file: z.string().optional(),
        callerLimit: z.number().int().positive().max(100).optional().describe('Max 100.'),
        calleeLimit: z.number().int().positive().max(100).optional().describe('Max 100.'),
        testLimit: z.number().int().positive().max(100).optional().describe('Max 100.'),
        historyLimit: z.number().int().positive().max(50).optional().describe('Max 50.'),
        callerDepth: z.number().int().positive().max(6).optional().describe('Blast-radius BFS depth. Max 6.'),
        affectedLimit: z.number().int().positive().max(100).optional().describe('Max 100.'),
      },
    }, async ({ symbol, file, callerLimit, calleeLimit, testLimit, historyLimit, callerDepth, affectedLimit }) => {
      await this.ensureFresh();
      const packet = buildContext(this.store, symbol, {
        filePath: file,
        callerLimit, calleeLimit, testLimit, historyLimit,
        callerDepth, affectedLimit,
      });
      if (!packet) {
        const didYouMean = this.suggestSymbols(symbol);
        const declarationHint = this.declarationHint(symbol, file);
        return this.text({ found: false, reason: `no symbol "${symbol}"`,
          ...(declarationHint ? { declarationHint } : {}),
          ...(didYouMean.length > 0 ? { didYouMean } : {}) });
      }
      const nameAmbiguity = this.nameAmbiguityHint(symbol, file);
      if (!nameAmbiguity) return this.text(packet);
      const warnings = [
        ...(packet.warnings ?? []),
        this.nameAmbiguityWarning(symbol, nameAmbiguity.otherDefinitionsCount),
      ];
      return this.text({
        ...packet,
        nameAmbiguity,
        warnings,
        nextBestCall: this.nameAggregateNextCall(symbol),
      });
    });

    // ── AI-agent optimization tools ─────────────────────────────────────────

    this.registerTool('seer_skeleton', {
      description: 'Render a file as a structural skeleton: every symbol signature is kept, bodies are collapsed to fold markers carrying the exact collapsed line count. Deterministic source elision (not AI summarization) — a token-cheap way to grasp a file\'s shape before reading it in full. Pass `focusSymbol` to expand one symbol\'s real body inline while everything else stays collapsed.',
      inputSchema: {
        file: z.string().describe('Absolute path, exact rel_path, or a trailing path fragment on a / boundary.'),
        focusSymbol: z.string().optional().describe('Expand this symbol\'s body verbatim; collapse the rest.'),
      },
    }, async ({ file, focusSymbol }) => {
      await this.ensureFresh();
      return this.text(buildSkeleton(this.store, file, { focusSymbol }));
    });

    this.registerTool('seer_trace', {
      description:
        'CORE drill-down tool. Unified graph-trace entry point. Set `scope` and pass the matching `args`:\n' +
        '• callers {symbol, file?, maxDepth?, maxNodes?, limit?, offset?, mode?, summaryOnly?, tokenBudget?} — transitive reverse callers (blast radius)\n' +
        '• callees {symbol, file?, maxDepth?, maxNodes?, limit?, offset?, mode?, summaryOnly?, tokenBudget?} — transitive forward callees\n' +
        '• path {from, to, maxDepth?} — shortest call path A→B\n' +
        '• file {file, maxDepth?, maxNodes?} — import-graph closure from a file\n' +
        '• module {id|label, maxDepth?, direction?} — module dependency reachability\n' +
        '• service {from, maxDepth?, maxNodes?, maxFanout?} — service-link reachability\n' +
        '• service_path {from, to, maxDepth?} — shortest service-link path\n' +
        '• module_service {moduleId, maxDepth?, maxNodes?} — cross-module service-link reachability\n' +
        'For callers/callees, `mode` is summary|preview|full; use `offset` and `limit` to page large graphs.\n' +
        'Delegates to the specific seer_trace_* tool (each still available for direct use).',
      inputSchema: {
        scope: z.enum([
          'callers', 'callees', 'path', 'file',
          'module', 'service', 'service_path', 'module_service',
        ]),
        args: z.any().optional(),
      },
    }, async ({ scope, args }) => {
      const map: Record<string, string> = {
        callers: 'seer_trace_callers',
        callees: 'seer_trace_callees',
        path: 'seer_trace_path',
        file: 'seer_trace_file_dependencies',
        module: 'seer_trace_module_dependencies',
        service: 'seer_trace_service_dependencies',
        service_path: 'seer_trace_service_path',
        module_service: 'seer_trace_module_service_dependencies',
      };
      const target = map[scope];
      const h = target ? this.handlers.get(target) : undefined;
      if (!h) return this.text({ ok: false, error: `unsupported scope "${scope}"` });
      // The umbrella accepts `args` as opaque (z.any()), so the delegate's own
      // required-param schema isn't enforced by the SDK here. Re-validate
      // against the delegate's schema, then catch any throw — either way the
      // agent gets a clean, advisory error rather than a raw binding failure.
      const v = this.validateToolArgs(target, args ?? {});
      if (!v.ok) return this.text({ ok: false, scope, error: v.error });
      try {
        return await h(v.data);
      } catch (err) {
        return this.text({ ok: false, scope, error: `seer_trace[${scope}] failed: ${(err as Error).message}` });
      }
    });

    this.registerTool('seer_batch', {
      description:
        'CORE efficiency tool. Run several read-only Seer tools in one call and get all results back together. ' +
        'Saves turns when the fan-out is known up front (e.g. definition + callers + behavior + risk for one symbol). ' +
        'Each entry is {tool, args}. Calls run sequentially in one process; one failure never aborts the rest. ' +
        'Tool names may be short Seer names (seer_skeleton) or MCP-client namespaced names (mcp__seer__seer_skeleton). ' +
        'seer_batch cannot nest, and it is intended for read-only tools.',
      inputSchema: {
        calls: z.array(z.object({
          tool: z.string(),
          args: z.any().optional(),
        })).min(1).max(25),
      },
    }, async ({ calls }) => {
      const results: Array<{ tool: string | null; requestedTool?: string; ok: boolean; result?: unknown; error?: string }> = [];
      for (const c of calls) {
        const rawToolName = c && typeof c.tool === 'string' ? c.tool : null;
        const normalized = rawToolName ? this.normalizeDelegatedToolName(rawToolName) : null;
        const toolName = normalized?.toolName ?? null;
        const requestedTool = normalized?.requestedTool;
        if (!toolName || toolName === 'seer_batch') {
          results.push({
            tool: toolName,
            ...(requestedTool ? { requestedTool } : {}),
            ok: false,
            error: 'missing tool name or nested seer_batch (disallowed)',
          });
          continue;
        }
        if (this.isSideEffectingTool(toolName)) {
          results.push({
            tool: toolName,
            ...(requestedTool ? { requestedTool } : {}),
            ok: false,
            error: 'seer_batch only dispatches read-only tools; run side-effecting or derived-index tools directly after user approval.',
          });
          continue;
        }
        const h = this.handlers.get(toolName);
        if (!h) {
          results.push({
            tool: toolName,
            ...(requestedTool ? { requestedTool } : {}),
            ok: false,
            error: `unknown tool "${rawToolName ?? toolName}". Use a Seer tool name such as "seer_skeleton"; MCP namespaced names like "mcp__seer__seer_skeleton" are also accepted.`,
          });
          continue;
        }
        // Re-validate against the tool's schema — in-process dispatch bypasses
        // the SDK's protocol-level validation, so an entry missing a required
        // field would otherwise reach the store as `undefined`.
        const v = this.validateToolArgs(toolName, c.args);
        if (!v.ok) {
          results.push({
            tool: toolName,
            ...(requestedTool ? { requestedTool } : {}),
            ok: false,
            error: v.error,
          });
          continue;
        }
        // Keep seer_batch strictly read-only: seer_history can auto-build its
        // file on a cold miss, so default that off inside a batch. An explicit
        // autoBuild:true in the entry still wins for a caller who wants it.
        if (toolName === 'seer_history' && v.data && (v.data as { autoBuild?: boolean }).autoBuild === undefined) {
          (v.data as { autoBuild?: boolean }).autoBuild = false;
        }
        try {
          const r = await h(v.data);
          const raw = r?.content?.[0]?.text;
          let parsed: unknown;
          try { parsed = raw != null ? JSON.parse(raw) : null; } catch { parsed = raw ?? null; }
          const parsedOk = !(parsed && typeof parsed === 'object' && (parsed as any).ok === false);
          results.push({
            tool: toolName,
            ...(requestedTool ? { requestedTool } : {}),
            ok: parsedOk,
            result: parsed,
            ...(!parsedOk ? { error: (parsed as any).error ?? (parsed as any).reason ?? 'tool returned ok:false' } : {}),
          });
        } catch (err) {
          results.push({
            tool: toolName,
            ...(requestedTool ? { requestedTool } : {}),
            ok: false,
            error: (err as Error).message,
          });
        }
      }
      return this.text({ batch: true, count: results.length, results });
    });
  }
}

export async function runMcp(options: McpServerOptions): Promise<void> {
  const server = new SeerMcpServer(options);
  const shutdown = async (): Promise<void> => {
    try { await server.stop(); } catch { /* */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await server.start();
}
