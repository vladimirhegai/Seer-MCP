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
import { buildSymbolHistory } from '../indexer/symbolhistory.js';
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

/**
 * Seer MCP server.
 *
 * Tool surface (Track-B baseline + Track-C/D additions):
 *   - seer_health         freshness + schema state
 *   - seer_stats          counts (files/symbols/edges + role + Track-C totals)
 *   - seer_symbols        symbol search (BM25 / LIKE)
 *   - seer_definition     exact symbol definition lookup
 *   - seer_file_symbols   list symbols in a file
 *   - seer_callers        direct callers, bounded with true total
 *   - seer_callees        direct callees, bounded
 *   - seer_search         combined symbol + file path BM25 search,
 *                           enriched with containing-symbol context
 *   - seer_reindex        explicit reindex
 *
 *   v4 additions:
 *   - seer_routes         list HTTP routes detected in source
 *   - seer_dependencies   list external dependencies from manifests
 *   - seer_config         list config / env reads
 *   - seer_complexity     rank symbols by cyclomatic/cognitive complexity
 *   - seer_behavior       tests that exercise a given symbol
 *   - seer_trace_path     bounded BFS shortest call path A → B
 *   - seer_architecture   one-page codebase snapshot
 *   - seer_detect_changes blast-radius for current diff
 *   - seer_churn          file-level git churn pass (opt-in)
 *   - seer_history        per-symbol git history
 *   - seer_symbol_history (action) build symbol history index
 */

export interface McpServerOptions {
  workspace: string;
  dbPath?: string;
  watch?: boolean;
  jit?: boolean;
}

type TraceMode = 'summary' | 'preview' | 'full';

interface TraceReach {
  id: number;
  depth: number;
}

interface TraceItem {
  id: number;
  name: string;
  qualifiedName: string | null;
  kind: string;
  file: string;
  lineStart: number;
  pagerank: number;
  depth: number;
}

interface TraceRow {
  id: unknown;
  name: unknown;
  qualifiedName: unknown;
  kind: unknown;
  file: unknown;
  lineStart: unknown;
  pagerank: unknown;
}

const CORE_ALWAYS_LOAD_TOOLS = new Set([
  'seer_health',
  'seer_search',
  'seer_definition',
  'seer_file_symbols',
  'seer_context',
  'seer_preflight',
  'seer_callers',
  'seer_callees',
  'seer_trace',
  'seer_behavior',
  'seer_history',
  'seer_skeleton',
  'seer_batch',
]);

const MAINTENANCE_TOOLS = new Set([
  'seer_reindex',
  'seer_churn',
  'seer_symbol_history_build',
  'seer_modules_build',
  'seer_shape_hash_build',
  'seer_bundle_export',
  'seer_bundle_import',
  'seer_scip_import',
]);

const SIDE_EFFECTING_TOOLS = new Set([
  ...MAINTENANCE_TOOLS,
  // These are query-shaped tools, but they can populate derived indexes on a
  // cold DB before returning data. Do not advertise them as read-only, and keep
  // them out of seer_batch's read-only fan-out contract.
  'seer_modules',
  'seer_module_members',
  'seer_symbol_module',
  'seer_module_dependencies',
  'seer_trace_module_dependencies',
  'seer_duplicates',
  'seer_continuity',
]);

const TRACE_PREVIEW_LIMIT = 20;
const TRACE_FULL_LIMIT = 100;
const TRACE_SUMMARY_SAMPLE_LIMIT = 5000;
const TRACE_SQL_CHUNK_SIZE = 900;
const DEFAULT_MCP_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_MCP_MAINTENANCE_TIMEOUT_MS = 90_000;
const DEFAULT_FRESHNESS_WAIT_MS = 3_000;
const DEFAULT_HISTORY_BUILD_SECONDS = 60;
const DEFAULT_HISTORY_GIT_TIMEOUT_MS = 10_000;

class SeerToolError extends Error {
  constructor(
    message: string,
    public readonly payload: Record<string, unknown>,
  ) {
    super(message);
  }
}

class SeerToolTimeoutError extends Error {
  constructor(public readonly toolName: string, public readonly timeoutMs: number) {
    super(`${toolName} exceeded ${timeoutMs}ms`);
  }
}

function mcpInstructions(): string {
  return [
    'Use Seer first for structural code navigation in this workspace.',
    'Core workflow: seer_health, then seer_search plus seer_definition/seer_file_symbols, then seer_context or seer_preflight, then seer_trace/seer_callers/seer_callees for drill-down.',
    'Before editing code, call seer_health once and confirm the workspace.',
    'If seer_health.workspace is not the active repo, report the stale/mispointed MCP session and ask the user to restart/reload after rerunning init; do not use stale Seer results for the task.',
    'For normal code tasks, call Seer MCP tools directly; do not inspect MCP JSON/config files or run npx seer-mcp unless the task is installation/debugging or MCP tools are unavailable.',
    'If you know the target symbol, call seer_context or seer_preflight before reading files.',
    'If you do not know the symbol, call seer_search first, then seer_definition or seer_file_symbols.',
    'For common method names, pass file to seer_context, seer_callers, or seer_trace callers so Seer uses the exact definition.',
    'Use seer_callers, seer_callees, seer_trace, seer_behavior, seer_history, and seer_skeleton for focused follow-up context.',
    'seer_history is read-only; if historyIndex.built is false, report that history is not built. Only run seer_symbol_history_build or CLI symbol-history when the user asks for a history build.',
    'For huge transitive graphs, prefer seer_trace mode="summary" or the compact preview; page with offset/limit and use mode="full" only when raw rows are needed.',
    'Use rg or manual file reads after Seer for literal strings, comments, docs, config values, unsupported languages, or when Seer returns no useful hit from the correct workspace.',
  ].join(' ');
}

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
      this.watcher = new SeerWatcher(this.workspace, this.store, this.indexer, {
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
    return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
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
        return this.text({ total: 0, items: [], source: 'tree-sitter',
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
      description: 'CORE drill-down tool. Direct callers of a symbol with bounded preview + true total. Pass file to disambiguate common names or qualified names such as Class.method.',
      inputSchema: {
        symbol: z.string(),
        file: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
        tokenBudget: z.number().int().positive().max(50000).optional()
          .describe('Soft cap (~4 chars/token) that prefix-trims the (already limit-bounded) caller list.'),
      },
    }, async ({ symbol, file, limit, tokenBudget }) => {
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
        return this.text({ symbol, file, found: false, total: 0, returned: 0, items: [], source: 'tree-sitter',
          reason: `no symbol "${symbol}" in ${file}`,
          ...(didYouMean.length > 0 ? { didYouMean } : {}) });
      }
      const total = target ? this.store.countCallersById(target.id) : this.store.countCallers(symbol);
      const rows = target
        ? this.store.findCallersById(target.id, limit ?? 40)
        : this.store.findCallers(symbol, limit ?? 40);
      const items = rows.map(c => ({
        callerName: c.callerName, callerQualifiedName: c.callerQualifiedName,
        callerKind: c.callerKind, file: c.callerFile, line: c.callerLine,
        edgeKind: c.edgeKind,
      }));
      if (total === 0) {
        const didYouMean = this.suggestSymbols(symbol);
        return this.text({ symbol, file, target: target ? {
          id: target.id, name: target.name, qualifiedName: target.qualifiedName,
          kind: target.kind, file: target.filePath, lineStart: target.lineStart,
        } : undefined, total: 0, returned: 0, items: [], source: 'tree-sitter',
          ...(didYouMean.length > 0 ? { didYouMean } : {}) });
      }
      return this.budgetedText({ symbol, file, target: target ? {
        id: target.id, name: target.name, qualifiedName: target.qualifiedName,
        kind: target.kind, file: target.filePath, lineStart: target.lineStart,
      } : undefined, total, source: 'tree-sitter' }, items, tokenBudget);
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
      return this.budgetedText({ symbol, file, target: target ? {
        id: target.id, name: target.name, qualifiedName: target.qualifiedName,
        kind: target.kind, file: target.filePath, lineStart: target.lineStart,
      } : undefined, total: all.length, source: 'tree-sitter' }, items, tokenBudget);
    });

    // Search: BM25 across symbols + files. Each symbol hit also gets enriched
    // with the containing symbol when the match is non-symbol (e.g. file).
    this.registerTool('seer_search', {
      description: 'CORE discovery tool. Combined BM25 search across symbol names and file paths. Use this first when the target symbol/file is unknown; follow up with seer_definition or seer_file_symbols. Excludes vendor/generated/test/declaration rows by default.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().positive().max(200).optional(),
        includeVendor: z.boolean().optional(),
        includeGenerated: z.boolean().optional(),
        includeTests: z.boolean().optional(),
        includeDeclarations: z.boolean().optional(),
        includeTypeRefs: z.boolean().optional(),
      },
    }, async ({ query, limit, includeVendor, includeGenerated, includeTests, includeDeclarations, includeTypeRefs }) => {
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
      return this.text({
        query,
        symbolHits: {
          total: symbolTotal, returned: symHits.length,
          items: symHits.map(r => ({
            id: r.id, name: r.name, qualifiedName: r.qualifiedName,
            kind: r.kind, file: r.filePath, lineStart: r.lineStart,
            pagerank: r.pagerank, symbolRole: r.symbolRole,
          })),
        },
        fileHits: {
          total: fileHits.length,
          items: fileHits.map(f => ({ path: f.path, relPath: f.relPath, language: f.language, role: f.role })),
        },
        source: 'tree-sitter',
        note: 'Search-first: call seer_definition or seer_file_symbols on the chosen hit.',
      });
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
          this.watcher = new SeerWatcher(this.workspace, this.store, this.indexer, {
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
      if (summaryOnly) return this.text({ ...base, returned: 0 });
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
      if (summaryOnly) return this.text({ ...base, returned: 0 });
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
      description: 'Ranked behavioral contract for a symbol: direct/indirect/naming-convention/same-file tests with assertion counts, graph distance, and recency. Use this BEFORE editing a symbol to find the tests that describe its expected behavior.',
      inputSchema: {
        symbol: z.string(),
        limit: z.number().int().positive().max(200).optional(),
        indirectDepth: z.number().int().nonnegative().max(4).optional()
          .describe('BFS depth for indirect coverage (callers that transitively reach the symbol). 0 disables indirect.'),
        includeNamingConvention: z.boolean().optional(),
        includeSameFile: z.boolean().optional(),
      },
    }, async ({ symbol, limit, indirectDepth, includeNamingConvention, includeSameFile }) => {
      await this.ensureFresh();
      const result = rankedBehavior(this.store, symbol, {
        limit: limit ?? 30,
        indirectDepth: indirectDepth ?? 2,
        includeNamingConvention: includeNamingConvention ?? true,
        includeSameFile: includeSameFile ?? true,
      });
      if (!result) {
        const didYouMean = this.suggestSymbols(symbol);
        return this.text({ symbol, total: 0, direct: 0, indirect: 0, tests: [], reason: `no symbol "${symbol}"`,
          ...(didYouMean.length > 0 ? { didYouMean } : {}) });
      }
      return this.text(result);
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
      const base = {
        symbol: { id: target.id, name: target.name, qualifiedName: target.qualifiedName, file: target.filePath },
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
      if (selectedMode === 'summary') return this.text({ ...base, returned: 0 });
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
      const base = {
        symbol: { id: target.id, name: target.name, qualifiedName: target.qualifiedName, file: target.filePath },
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
      if (selectedMode === 'summary') return this.text({ ...base, returned: 0 });
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
        callerDepth: z.number().int().positive().max(6).optional(),
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
      description: 'Read-only per-symbol git history from the prebuilt history index. Returns commits whose hunks overlap the symbol\'s line range. Does not build history; if historyIndex.built is false, only build explicitly with seer_symbol_history_build or CLI symbol-history when requested.',
      inputSchema: {
        symbol: z.string(),
        limit: z.number().int().positive().max(200).optional(),
        since: z.number().int().optional().describe('Unix-seconds lower bound on committed_at'),
        file: z.string().optional(),
      },
    }, async ({ symbol, limit, since, file }) => {
      await this.ensureFresh();
      const historyIndex = this.historyIndexStatus();
      const candidates = this.store.getDefinition(symbol, { filePath: file });
      const items: any[] = [];
      const continuityRows = this.countTableRows('symbol_history_continuity');
      for (const c of candidates.slice(0, 5)) {
        const history = this.store.getSymbolHistory(c.id, { limit: limit ?? 50, since });
        const total = this.store.countSymbolHistory(c.id);
        const continuity = continuityRows > 0 ? getContinuityForSymbol(this.store, c.id) : [];
        items.push({
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
      return this.text({
        symbol,
        file,
        historyIndex,
        returned: items.length,
        results: items,
        note: (historyIndex as any).built
          ? 'Honest limits: file renames followed via --follow; symbol renames cut off history at the rename commit. Confidence drops with commit age.'
          : 'Symbol history is not built for this workspace yet. Build explicitly with seer_symbol_history_build, or run `seer symbol-history --workspace <repo>` outside the agent for large repos. Agents should ask before starting a history build.',
      });
    });

    this.registerTool('seer_symbol_history_build', {
      description: '(Advanced maintenance.) Build the per-symbol git history index. Bounded by default for MCP safety; for very large repos, prefer the CLI `seer symbol-history --workspace <repo>`.',
      inputSchema: {
        maxCommitsPerFile: z.number().int().positive().max(2000).optional(),
        maxFiles: z.number().int().positive().max(100000).optional(),
        maxSeconds: z.number().int().positive().max(600).optional(),
        gitCommandTimeoutMs: z.number().int().positive().max(60000).optional(),
        force: z.boolean().optional(),
      },
    }, async ({ maxCommitsPerFile, maxFiles, maxSeconds, gitCommandTimeoutMs, force }) => {
      const r = await buildSymbolHistory(this.workspace, this.store, {
        maxCommitsPerFile: maxCommitsPerFile ?? 200,
        maxFiles,
        deadlineMs: (maxSeconds ?? DEFAULT_HISTORY_BUILD_SECONDS) * 1000,
        gitCommandTimeoutMs: gitCommandTimeoutMs ?? DEFAULT_HISTORY_GIT_TIMEOUT_MS,
        skipIfHeadUnchanged: !force,
      });
      return this.text({
        ...r,
        historyIndex: this.historyIndexStatus(),
        note: r.completed
          ? 'Symbol history build completed.'
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
      if (summaryOnly) return this.text({ ...base, returned: 0 });
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
      if (summaryOnly) return this.text({ ...base, returned: 0 });
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
      description: 'Deterministic edit-risk profile for a symbol. Returns a decomposed score with per-signal contributions: fan-in, route exposure, test coverage, complexity, churn, config reads, and module-boundary crossings. The verdict (low/medium/high) is for triage; the signals are the evidence.',
      inputSchema: {
        symbol: z.string(),
        callerDepth: z.number().int().positive().max(6).optional(),
      },
    }, async ({ symbol, callerDepth }) => {
      await this.ensureFresh();
      const r = computeRisk(this.store, symbol, { callerDepth: callerDepth ?? 3 });
      if (!r) {
        const didYouMean = this.suggestSymbols(symbol);
        return this.text({ found: false, reason: `no symbol "${symbol}"`,
          ...(didYouMean.length > 0 ? { didYouMean } : {}) });
      }
      return this.text(r);
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
          this.watcher = new SeerWatcher(this.workspace, this.store, this.indexer, {
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
      description: 'CORE pre-edit tool. Compact "should I edit this?" evidence packet. Pass `symbol` for a single-symbol packet (risk, likely tests, service impact, history), or `fromRef`/`toRef` for a diff-range packet. Output is structured facts only.',
      inputSchema: {
        symbol: z.string().optional(),
        file: z.string().optional(),
        fromRef: z.string().optional(),
        toRef: z.string().optional(),
        oldBundle: z.string().optional(),
        newBundle: z.string().optional(),
        maxSymbols: z.number().int().positive().max(50).optional(),
        maxTests: z.number().int().positive().max(50).optional(),
        maxHistory: z.number().int().positive().max(50).optional(),
        callerDepth: z.number().int().positive().max(6).optional(),
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
      description: 'CORE pre-edit tool. One compact packet for a symbol: definition, callers, callees, bounded route/config previews with totals, behavioral tests, history, complexity, module, blast radius, and deterministic risk. Use before reading/editing a known symbol, then drill in with seer_callers, seer_history, or seer_behavior.',
      inputSchema: {
        symbol: z.string(),
        file: z.string().optional(),
        callerLimit: z.number().int().positive().max(100).optional(),
        calleeLimit: z.number().int().positive().max(100).optional(),
        testLimit: z.number().int().positive().max(100).optional(),
        historyLimit: z.number().int().positive().max(50).optional(),
        callerDepth: z.number().int().positive().max(6).optional(),
        affectedLimit: z.number().int().positive().max(100).optional(),
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
        return this.text({ found: false, reason: `no symbol "${symbol}"`,
          ...(didYouMean.length > 0 ? { didYouMean } : {}) });
      }
      return this.text(packet);
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
        'seer_batch cannot nest, and it is intended for read-only tools.',
      inputSchema: {
        calls: z.array(z.object({
          tool: z.string(),
          args: z.any().optional(),
        })).min(1).max(25),
      },
    }, async ({ calls }) => {
      const results: Array<{ tool: string | null; ok: boolean; result?: unknown; error?: string }> = [];
      for (const c of calls) {
        const toolName = c && typeof c.tool === 'string' ? c.tool : null;
        if (!toolName || toolName === 'seer_batch') {
          results.push({ tool: toolName, ok: false, error: 'missing tool name or nested seer_batch (disallowed)' });
          continue;
        }
        if (this.isSideEffectingTool(toolName)) {
          results.push({
            tool: toolName,
            ok: false,
            error: 'seer_batch only dispatches read-only tools; run side-effecting or derived-index tools directly after user approval.',
          });
          continue;
        }
        const h = this.handlers.get(toolName);
        if (!h) { results.push({ tool: toolName, ok: false, error: `unknown tool "${toolName}"` }); continue; }
        // Re-validate against the tool's schema — in-process dispatch bypasses
        // the SDK's protocol-level validation, so an entry missing a required
        // field would otherwise reach the store as `undefined`.
        const v = this.validateToolArgs(toolName, c.args);
        if (!v.ok) { results.push({ tool: toolName, ok: false, error: v.error }); continue; }
        try {
          const r = await h(v.data);
          const raw = r?.content?.[0]?.text;
          let parsed: unknown;
          try { parsed = raw != null ? JSON.parse(raw) : null; } catch { parsed = raw ?? null; }
          const parsedOk = !(parsed && typeof parsed === 'object' && (parsed as any).ok === false);
          results.push({
            tool: toolName,
            ok: parsedOk,
            result: parsed,
            ...(!parsedOk ? { error: (parsed as any).error ?? (parsed as any).reason ?? 'tool returned ok:false' } : {}),
          });
        } catch (err) {
          results.push({ tool: toolName, ok: false, error: (err as Error).message });
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
