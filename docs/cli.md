# CLI Reference

Every Seer feature is available from a shell. This is handy for CI, scripts, and
quick repo checks without an agent.

Most query commands auto-detect `.seer/graph.db` by walking up from the current
directory. Use `--db <path>` when you want a specific index.

```bash
seer --help
seer <command> --help
```

## Setup

| Command | Use |
|---|---|
| `seer init [workspace]` | Wire Seer into an MCP client. |
| `seer index <repo-path>` | Build or refresh the index. |
| `seer mcp --workspace <path>` | Run the MCP server. |
| `seer update` | Refresh existing Seer config. |
| `seer uninstall` | Remove Seer config. |

### `seer index`

| Flag | Meaning |
|---|---|
| `--reset` | Rebuild from scratch. |
| `--mode full\|standard\|fast` | Discovery breadth. Default is `standard`. |
| `--include-vendor` | Include dependency folders. |
| `--include-generated` | Include generated files. |
| `--max-file-kb <n>` | Skip files larger than `n` KiB. |
| `--parallel` / `--no-parallel` | Force or disable worker parsing. |
| `--jobs <n>` | Worker count. |
| `-v, --verbose` | Show per-file progress. |

## Orientation

| Command | Answers |
|---|---|
| `seer health` | Is the index live and fresh? |
| `seer stats` | How many files, symbols, edges, routes, and configs are indexed? |
| `seer architecture` | What are the top symbols, modules, and frameworks? |
| `seer boundaries` | What package or service boundaries exist? |
| `seer modules` | What clusters did Seer infer? |
| `seer module <label>` | Which files and symbols are in one cluster? |

## Symbols And Calls

```bash
seer symbols [query]
seer symbols <query> --top 20
seer callers <symbol> --file path/to/file.ts
seer callees <symbol>
```

By default, search hides vendor files, generated files, tests, forward
declarations, and type references. Opt in with:

```bash
seer symbols <query> --include-tests --include-declarations --include-type-refs
```

For common names like `init`, `update`, or `render`, pass `--file` to target one
definition.

To sample real call-site source:

```bash
seer callers buildInvoice --limit 5 --include-snippets --snippet-context 2
```

## Routes, Dependencies, Config

```bash
seer routes [--method POST] [--framework express] [--path checkout]
seer deps   [--ecosystem npm] [--name react]
seer config [--key DATABASE_URL]
```

## Pre-Edit Checks

| Command | Use |
|---|---|
| `seer preflight --symbol <name>` | Full packet before editing a symbol. |
| `seer preflight --from main --to HEAD` | Blast radius of a diff. |
| `seer context <symbol>` | Definition, callers, tests, history, risk. |
| `seer risk <symbol>` | Decomposed edit-risk score. |
| `seer behavior <symbol>` | Tests that exercise a symbol. |
| `seer detect-changes --from main --to HEAD` | Diff mapped to symbols. |

`preflight` is the usual first call before an edit.

## Git History

```bash
seer churn
seer symbol-history
seer history <symbol>
seer continuity <symbol>
seer changes-with <symbol>
```

`seer changes-with` finds symbols that historically changed in the same commits
as the target. Build the full symbol-history index first for the best signal:

```bash
seer symbol-history
```

## Service Links

```bash
seer service-calls  [--protocol http] [--path /users]
seer service-links  [--match-kind exact]
seer trace-service <from> <to> [--depth n]
```

These resolve outbound calls such as fetch, axios, gRPC, tRPC, GraphQL, and
queue producers to route handlers.

## Bundles And Overlays

```bash
seer bundle export [--out file.seerbundle]
seer bundle import <bundle> [--external --alias <name>]
seer bundle info <bundle>
seer contract diff <old> <new> [--include-callers]
seer scip-import <scip.json>
seer duplicates [--max-distance 4] [--min-loc 5]
```

## Common Flags

| Flag | Use |
|---|---|
| `--db <path>` | Query a specific SQLite index. |
| `--limit <n>` | Cap list output. |
| `--json` | Machine-readable output where supported. |
