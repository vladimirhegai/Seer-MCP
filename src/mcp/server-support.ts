// Stateless support layer for the Seer MCP server (server.ts):
// tool-classification sets, trace-shaping constants/types, error classes, and
// the static agent-facing instructions string. None of these touch server
// state, so they live apart from the SeerMcpServer class to keep server.ts
// focused on wiring and the tool handlers.

export type TraceMode = 'summary' | 'preview' | 'full';

export interface TraceReach {
  id: number;
  depth: number;
}

export interface TraceItem {
  id: number;
  name: string;
  qualifiedName: string | null;
  kind: string;
  file: string;
  lineStart: number;
  pagerank: number;
  depth: number;
}

export interface TraceRow {
  id: unknown;
  name: unknown;
  qualifiedName: unknown;
  kind: unknown;
  file: unknown;
  lineStart: unknown;
  pagerank: unknown;
}

/**
 * Tools an agent should keep loaded at all times — the core navigation surface.
 * (Advisory metadata surfaced via client hints; does not gate registration.)
 */
export const CORE_ALWAYS_LOAD_TOOLS = new Set([
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

/** Tools that mutate the index / run an expensive build — longer timeout. */
export const MAINTENANCE_TOOLS = new Set([
  'seer_reindex',
  'seer_churn',
  'seer_symbol_history_build',
  'seer_modules_build',
  'seer_shape_hash_build',
  'seer_bundle_export',
  'seer_bundle_import',
  'seer_scip_import',
]);

export const SIDE_EFFECTING_TOOLS = new Set([
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

export const TRACE_PREVIEW_LIMIT = 20;
export const TRACE_FULL_LIMIT = 100;
export const TRACE_SUMMARY_SAMPLE_LIMIT = 5000;
export const TRACE_SQL_CHUNK_SIZE = 900;
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 30_000;
export const DEFAULT_MCP_MAINTENANCE_TIMEOUT_MS = 90_000;
export const DEFAULT_FRESHNESS_WAIT_MS = 3_000;
export const DEFAULT_HISTORY_BUILD_SECONDS = 60;
export const DEFAULT_HISTORY_GIT_TIMEOUT_MS = 10_000;

/** Carries a structured payload back to the agent as a clean tool error. */
export class SeerToolError extends Error {
  constructor(
    message: string,
    public readonly payload: Record<string, unknown>,
  ) {
    super(message);
  }
}

export class SeerToolTimeoutError extends Error {
  constructor(public readonly toolName: string, public readonly timeoutMs: number) {
    super(`${toolName} exceeded ${timeoutMs}ms`);
  }
}

export function mcpInstructions(): string {
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
    'seer_history auto-builds just the queried symbol\'s file on a cold miss (bounded ~1s) and returns its commits — no separate build step. Pass autoBuild=false for a strictly read-only lookup. The FULL repo history index (seer_symbol_history_build with no args) can take minutes on large repos: ask the user first, or point them at `seer symbol-history`.',
    'For C/C++ member calls where seer_callers reports an ambiguity (resolved count far below the by-name count), narrow with seer_callers groupByFile=true (where the sites concentrate) and filterReceiverType (best-effort receiver class; true infers it); includeNameMatches pages the raw list. SCIP import gives an exact count.',
    'For huge transitive graphs, prefer seer_trace mode="summary" or the compact preview; page with offset/limit and use mode="full" only when raw rows are needed.',
    'Use rg or manual file reads after Seer for literal strings, comments, docs, config values, unsupported languages, or when Seer returns no useful hit from the correct workspace.',
  ].join(' ');
}
