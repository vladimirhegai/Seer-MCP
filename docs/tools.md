# Tool Guide

These are the MCP tools an agent sees once Seer is connected. Everything is
read-only structural fact: no prose, no summaries, no guessing. If a lookup
finds nothing, list tools return a `didYouMean` array of close matches rather
than a dead end.

This page is about what each tool is *for*. For exact parameters, every tool
also self-describes its input schema over MCP, so your agent sees the arguments
inline.

---

## Agent Decision Table

| Situation | Start with |
|---|---|
| Confirm Seer is attached to this repo | `seer_health` |
| Unknown symbol, file, or subsystem | `seer_search` |
| Known symbol before reading or editing | `seer_context` or `seer_preflight` |
| Common method name like `init`, `update`, `add_child` | `seer_context` / `seer_callers` with `file` |
| Direct call graph | `seer_callers` or `seer_callees` |
| Large transitive graph | `seer_trace` with `mode: "summary"` or paged preview |
| Large file shape | `seer_skeleton` before a full file read |
| Literal strings, comments, docs, config values | `rg` or file reads after Seer |
| Symbol git history | `seer_history`; if not built, ask before starting a build |

---

## Start here

| Tool | Use it when |
|---|---|
| `seer_health` | You want to confirm the index is live and fresh. Cheap. |
| `seer_architecture` | You just landed in an unfamiliar repo and need the lay of the land. |
| `seer_preflight` | You are about to edit something, or want a diff's blast radius. |

`seer_preflight` is the workhorse. Give it a symbol and it returns the
definition, who calls it, transitive dependents, the tests that cover it, recent
commit history, and a risk verdict, all in one call. Give it `fromRef`/`toRef`
and it maps a git diff to the affected symbols and their blast radius.

---

## Navigation and search

- `seer_symbols` (`query?`, `top?`) BM25 search, or top symbols by PageRank.
- `seer_definition` (`name`, `file?`) exact definition lookup.
- `seer_file_symbols` (`file`) symbols in a file, in line order.
- `seer_callers` (`symbol`, `file?`, `includeNameMatches?`) DIRECT callers. `total`
  is call SITES (edges); `uniqueCallers` is distinct caller functions. Use `file`
  or a qualified `Class.method` to disambiguate. For C/C++ member calls the
  receiver type is unresolved, so the precise count can undercount; when that
  happens an `ambiguity` block reports the by-name upper bound, and
  `includeNameMatches: true` returns the by-name caller list. (For TRANSITIVE
  reach, use `seer_trace_callers` / `seer_trace` `scope: "callers"`.)
- `seer_callees` (`symbol`) direct callees.
- `seer_search` (`query`, `tokenBudget?`) combined symbol + file-path search.
- `seer_skeleton` (`file`, `focusSymbol?`) render a file as signatures only, with
  bodies collapsed to `{ ... N lines ... }`. Read a 2,000-line file for the cost
  of its outline. `focusSymbol` expands one body verbatim.

## Routes, deps, config

- `seer_routes` (`method?`, `framework?`, `pathSubstr?`)
- `seer_dependencies` (`ecosystem?`, `nameSubstr?`)
- `seer_config` (`key?`, `source?`)

## Complexity and blast radius

- `seer_complexity` (`by?`, `minValue?`) cyclomatic / cognitive / LOC rankings.
- `seer_behavior` (`symbol`, `file?`) tests that exercise the symbol, ranked by
  how directly they hit it. Pass `file` to pin a common method name.
- `seer_trace_path` (`from`, `to`) shortest call path between two symbols.
- `seer_trace_callers`
  (`symbol`, `file?`, `maxDepth?`, `limit?`, `offset?`, `mode?`) transitive
  callers. Default `mode: "preview"` returns exact totals, depth/file
  summaries, and a small page of rows.
- `seer_trace_callees`
  (`symbol`, `file?`, `maxDepth?`, `limit?`, `offset?`, `mode?`) transitive
  callees. Use `mode: "summary"` for counts/top files only, or `mode: "full"`
  when raw rows are needed.
- `seer_detect_changes` (`fromRef?`, `toRef?`) blast radius for a diff.

## Modules and boundaries

- `seer_modules`, `seer_module_members`, `seer_symbol_module`,
  `seer_module_dependencies` Louvain clusters and their edges.
- `seer_boundaries`, `seer_boundary_for_file`, `seer_boundary_dependencies`
  monorepo package partitions and crossings.
- `seer_trace_file_dependencies`, `seer_trace_module_dependencies` import BFS.

## History and continuity

- `seer_churn` file-level git stats.
- `seer_history` (`symbol`) per-symbol commit blame chain from a prebuilt
  history index. Read-only; it reports `historyIndex.built: false` until an
  explicit history build has populated the index.
- `seer_continuity` (`symbol`) rename/move evidence (advisory, confidence-labeled).

## Portability and precision

- `seer_bundle_export`, `seer_bundle_info`, `seer_bundle_import` portable
  `.seerbundle` archives.
- `seer_external_bundles` list imported peer-repo layers.
- `seer_contract_diff` (`oldBundle`, `newBundle`) advisory API diff across protocols.
- `seer_scip_import`, `seer_scip_imports`, `seer_provenance` SCIP precision overlays.
- `seer_duplicates` near-duplicate code clusters via SimHash.

## Service links (cross-service)

- `seer_service_calls`, `seer_service_links` outbound calls resolved to handlers.
- `seer_trace_service_path`, `seer_trace_service_dependencies`,
  `seer_trace_module_service_dependencies` cross-service BFS.

## Unified context

- `seer_preflight` consolidated pre-edit packet (symbol or diff-range mode).
- `seer_context` (`symbol`, `file?`) consolidated symbol context.
- `seer_risk` (`symbol`, `file?`) decomposed edit-risk analysis.

> Disambiguation: the single-definition tools (`seer_context`, `seer_behavior`,
> `seer_risk`, `seer_trace_callers`, `seer_trace_callees`) resolve a bare name to
> the highest-PageRank definition. When the name is ambiguous and no `file` is
> given, the response carries a `nameAmbiguity` hint listing the chosen
> definition and the alternatives — pass `file` or a qualified `Class::method` to
> target a specific one. `seer_callers`/`seer_callees` instead aggregate every
> same-named definition on a bare name (the count is an upper bound across all of
> them); pass `file` or `Class.method` there to scope to one.

---

## Tools that save round-trips

- `seer_batch` (`calls`) run up to 25 read-only tools in a single request.
  One failing call does not abort the rest. It cannot nest inside itself.
- `seer_trace` (`scope`, `args?`) a single entry point that dispatches to the
  whole `seer_trace_*` family (`callers`, `callees`, `path`, `file`, `module`,
  `service`, `service_path`, `module_service`). `seer_trace` is the always-loaded
  entry point; the individual `seer_trace_*` tools behave identically when called
  directly, but some MCP clients lazy-load them — prefer `seer_trace` if a
  `seer_trace_*` tool is not listed. `args` is the delegate's own argument object
  (e.g. `{ scope: "callers", args: { symbol, file?, maxDepth?, mode? } }`).

## Keeping output small

The high-volume list tools (`seer_symbols`, `seer_definition`, `seer_callers`,
`seer_callees`, `seer_search`, `seer_trace_callers`, `seer_trace_callees`,
`seer_complexity`, `seer_service_calls`, `seer_service_links`) accept an optional
`tokenBudget`.
Seer packs the highest-ranked rows until the serialized payload would exceed
roughly `tokenBudget * 4` characters, then flags `truncated: true` with an
`omitted` count and a note on how to get the rest. With no budget, direct list
tools stay untrimmed; trace tools default to compact previews with totals.

## Tools you usually do not need

Modules and shape hashes normally build during indexing and may self-heal on
first use. Symbol history is different: it can be expensive on large repos, so
`seer_history` never builds it inline. Agents should report missing history and
ask before starting a build. Run `seer_symbol_history_build` with a small
`maxSeconds`/`maxFiles` budget, or run `seer symbol-history` from a shell when
you want the full history pass.
