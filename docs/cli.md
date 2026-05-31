# CLI Reference

Every Seer capability is available from a plain shell, not just over MCP. This
is useful for scripting, CI, and just looking around a repo yourself. All query
commands auto-detect `.seer/graph.db` by walking up from the current directory;
pass `--db <path>` to point at a saved index.

Run `seer --help`, or `seer <command> --help`, for the full flag list of any
command.

---

## Setup

```bash
seer init [workspace]          # wire Seer into your agents (see docs/mcp.md)
seer index <repo-path>         # build or refresh the index
seer mcp --workspace <path>    # run the MCP server over the index
```

### `seer index` options

| Flag | Meaning |
|---|---|
| `--reset` | Delete the existing index first. |
| `--mode full\|standard\|fast` | Discovery breadth. `standard` is the default. |
| `--include-vendor` / `--include-generated` | Pull in normally-excluded files. |
| `--max-file-kb <n>` | Skip files larger than `n` KiB (0 = no cap, the default). |
| `--parallel` / `--no-parallel` | Force or disable worker-thread parsing. |
| `--jobs <n>` | Worker thread count (default: cores minus one, capped at 8). |
| `-v, --verbose` | Per-file progress. |

`standard` excludes big dependency and generated trees. `fast` also drops docs,
fixtures, and static assets. `full` indexes everything.

---

## Orientation

```bash
seer health           # schema version, role counts, watcher state (cheap)
seer stats            # file / symbol / edge / route / config counts
seer architecture     # one-page snapshot: top symbols, modules, frameworks
seer boundaries       # detected monorepo package boundaries
seer modules          # Louvain module clusters
seer module <label>   # files and top symbols inside a module
```

---

## Search and symbols

```bash
seer symbols [query]            # search by name, or list top symbols by PageRank
seer symbols <q> --top 20
seer symbols <q> --include-tests --include-declarations --include-type-refs
```

By default, vendor, generated, test-file symbols, forward declarations, and type
references are hidden. Opt in with the `--include-*` flags.

---

## Call graph

```bash
seer callers <symbol> [--limit n]    # who calls this (name-based, broad)
seer callees <symbol> [--limit n]    # what this calls
```

For precise, id-scoped call graphs, prefer `seer preflight` / `seer context`,
which resolve to exact symbol IDs.

---

## Routes, dependencies, config

```bash
seer routes [--method POST] [--framework express] [--path checkout]
seer deps   [--ecosystem npm] [--name react]
seer config [--key DATABASE_URL]
```

---

## Pre-edit intelligence

```bash
seer preflight --symbol <name> [--file <path>]      # full pre-edit packet
seer preflight --from main --to HEAD                # blast radius of a diff
seer preflight --from main --to HEAD --old-bundle a.seerbundle --new-bundle b.seerbundle

seer context  <symbol>      # definition + callers + tests + history + risk
seer risk     <symbol>      # decomposed edit-risk score
seer behavior <symbol>      # ranked tests that exercise the symbol
seer detect-changes --from main --to HEAD   # standalone diff blast radius
```

`preflight` is the one to reach for first. It folds definition, callers,
transitive dependents, tests, recent history, and risk into a single packet.

---

## Git history and continuity

```bash
seer churn                       # file-level git stats
seer symbol-history [--force]    # build the per-symbol history index (opt-in)
seer history <symbol>            # commit blame chain for one symbol
seer continuity <symbol>         # rename/move continuity evidence (advisory)
```

---

## Portability and diffing

```bash
seer bundle export [--out file.seerbundle]
seer bundle import <bundle> [--external --alias <name>]
seer bundle info <bundle>
seer bundle external                       # list imported external layers
seer contract diff <old> <new> [--include-callers]
seer ci bundle                             # fresh-index + emit a bundle (for CI)
seer ci workflow                           # print a GitHub Actions YAML
seer scip-import <scip.json>               # add a SCIP precision overlay
seer duplicates [--max-distance 4] [--min-loc 5]
```

---

## Service links

```bash
seer service-calls  [--protocol http] [--path /users]
seer service-links  [--match-kind exact]
seer trace-service <from> <to> [--depth n]
```

These resolve outbound network calls (fetch, axios, gRPC, tRPC, GraphQL, message
queues) to the concrete route handlers that serve them.

---

## Common flags

- `--db <path>` on any query command points at a specific index.
- `--limit <n>` caps list output on most list commands.
- `--json` is available on `preflight` and `contract diff` for machine output.
