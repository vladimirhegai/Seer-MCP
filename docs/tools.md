# Tool Guide

These are the MCP tools an agent sees after Seer is connected. The tools return
local structural facts from the index: definitions, calls, routes, tests,
history, risk, and related context.

For exact parameters, each tool exposes its input schema over MCP. This page is
about choosing the right tool.

## Start Here

| Situation | First tool |
|---|---|
| Confirm Seer is attached to the right repo | `seer_health` |
| Search for a symbol, file, or subsystem | `seer_search` |
| Inspect one symbol before editing | `seer_context` |
| Check impact before editing | `seer_preflight` |
| Find direct callers or callees | `seer_callers`, `seer_callees` |
| Trace a bigger dependency graph | `seer_trace` |
| Scan a long file cheaply | `seer_skeleton` |
| Find tests for a symbol | `seer_behavior` |
| Find route and service boundaries | `seer_service_links` |
| Inspect symbol history | `seer_history` |

Many drill-down responses include compact metadata:

| Field | Meaning |
|---|---|
| `precision` | Exact, bounded, heuristic, or name aggregate. |
| `warnings` | Caveats the agent should keep in mind. |
| `nextBestCall` | One useful follow-up when narrowing or paging is obvious. |

## Search And Navigation

| Tool | Use |
|---|---|
| `seer_search` | Search symbols and file paths together. |
| `seer_symbols` | Search symbol names or list top-ranked symbols. |
| `seer_definition` | Find a definition by name, optionally scoped by file. |
| `seer_file_symbols` | List symbols in a file in source order. |
| `seer_skeleton` | Show file structure with bodies collapsed. |

Example:

```json
{ "query": "chargeCard" }
```

For common names, add a file:

```json
{ "symbol": "init", "file": "src/server.ts" }
```

## Call Graph

| Tool | Use |
|---|---|
| `seer_callers` | Direct callers. |
| `seer_callees` | Direct callees. |
| `seer_trace` | Transitive callers, callees, paths, file graphs, modules, and service paths. |
| `seer_trace_path` | Shortest call path between two symbols. |
| `seer_trace_callers` | Transitive callers. |
| `seer_trace_callees` | Transitive callees. |

`seer_callers` returns call sites and distinct caller functions. Add
`includeSnippets: true` to see the real source around each call site:

```json
{
  "symbol": "buildInvoice",
  "limit": 5,
  "includeSnippets": true,
  "snippetContext": 2
}
```

For C and C++ member calls, receiver types may be unresolved. Seer reports this
with an ambiguity block and a likely caller estimate.

## Pre-Edit Context

| Tool | Use |
|---|---|
| `seer_preflight` | One packet before editing a symbol or reviewing a diff. |
| `seer_context` | Definition, callers, tests, history, and risk for one symbol. |
| `seer_risk` | Edit-risk score with its ingredients. |
| `seer_behavior` | Tests ranked by how directly they exercise a symbol. |
| `seer_detect_changes` | Map a git diff to changed symbols. |

`seer_preflight` accepts either a symbol:

```json
{ "symbol": "chargeCard", "file": "src/billing/payment.ts" }
```

or a diff range:

```json
{ "fromRef": "main", "toRef": "HEAD" }
```

## Routes, Config, Dependencies

| Tool | Use |
|---|---|
| `seer_routes` | Server routes discovered from supported frameworks. |
| `seer_dependencies` | Package dependencies from manifests. |
| `seer_config` | Env and config reads. |
| `seer_service_calls` | Outbound HTTP, RPC, GraphQL, queue, and service calls. |
| `seer_service_links` | Outbound calls resolved to handlers. |
| `seer_trace_service_path` | Path between two service symbols. |

## Modules And Boundaries

| Tool | Use |
|---|---|
| `seer_modules` | Inferred code clusters. |
| `seer_module_members` | Files and symbols in a cluster. |
| `seer_symbol_module` | Cluster for one symbol. |
| `seer_module_dependencies` | Edges between clusters. |
| `seer_boundaries` | Monorepo package or service boundaries. |
| `seer_boundary_dependencies` | Cross-boundary calls. |
| `seer_trace_file_dependencies` | File dependency BFS. |
| `seer_trace_module_dependencies` | Module dependency BFS. |

## Git History

| Tool | Use |
|---|---|
| `seer_churn` | File-level git stats. |
| `seer_history` | Per-symbol commit chain. |
| `seer_continuity` | Rename or move evidence in the current tree. |
| `seer_changes_with` | Symbols that historically changed with this one. |
| `seer_symbol_history_build` | Build the full symbol-history index. |

`seer_history` can build the queried symbol's file on first use. For
`seer_changes_with`, build the full history index for the strongest result.

## Portability And Precision

| Tool | Use |
|---|---|
| `seer_bundle_export` | Export a portable `.seerbundle`. |
| `seer_bundle_import` | Import another repo as a read-only layer. |
| `seer_bundle_info` | Inspect a bundle. |
| `seer_external_bundles` | List imported layers. |
| `seer_contract_diff` | Compare API surfaces across bundles. |
| `seer_scip_import` | Add a SCIP precision overlay. |
| `seer_provenance` | See where an edge came from. |
| `seer_duplicates` | Find near-duplicate code clusters. |

## Fewer Round Trips

| Tool | Use |
|---|---|
| `seer_batch` | Run up to 25 read-only Seer calls in one request. |
| `seer_trace` | Single entry point for the trace family. |

`seer_batch` accepts short names and MCP-client namespaced names:

```json
{
  "calls": [
    { "tool": "seer_definition", "args": { "name": "chargeCard" } },
    { "tool": "mcp__seer__seer_callers", "args": { "symbol": "chargeCard" } }
  ]
}
```

A failed call leaves the rest of the batch running.

## Keeping Output Small

High-volume list tools accept `tokenBudget`. Seer packs the highest-ranked rows
first, then returns `truncated: true` and an `omitted` count when it stops.

```json
{ "query": "payment", "tokenBudget": 800 }
```

Trace tools also support preview and summary modes for big graphs.
