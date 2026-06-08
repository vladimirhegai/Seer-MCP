# Testing Proof

Seer is tested in three layers: small fixtures, the real MCP protocol, and
production-sized repositories.

## At A Glance

| Layer | What it proves | Command |
|---|---|---|
| Fixtures | Parsers, graph edges, service links, history, risk, regressions. | `npm test` |
| MCP protocol | Agent-facing tools work over stdio JSON-RPC. | `npm run test:mcp` |
| Repo scale | Indexing survives real repositories such as Godot, Unreal Engine, Linux, TypeScript, React, client-go, and Helix. | `npm run scale-test` |

## Current Inventory

| Count | Meaning |
|---:|---|
| 45 | top-level executable test programs in `tests/*.ts` |
| 102 | test files and fixtures under `tests/` |
| 19 | release gates chained by `npm test` |
| 11 | MCP protocol suites inside `npm run test:mcp` |
| 339 | checks in the latest `npm run test:mcp` run |
| 87 | checks in the focused C++ / Godot regression suite |

Recount top-level suites:

```bash
node -e "const fs=require('fs'); console.log(fs.readdirSync('tests').filter(f=>f.endsWith('.ts')).length)"
```

## Coverage Matrix

| Area | Plain-English check | Proof |
|---|---|---|
| Language parsing | Can Seer read definitions, calls, imports, and qualified names? | `npm run test:smoke` |
| Parallel indexing | Does worker parsing match serial parsing? | `npm run test:parallel-suite` |
| Worker recovery | Does indexing recover after worker failure? | `npm run test:parallel-suite` |
| Query correctness | Do search, callers, and callees return stable rows? | `npm run test:query-parity` |
| MCP tools | Do real agent tools work through MCP? | `npm run test:mcp` |
| Freshness | Do edits and deletes show up before query results return? | `npm run test:mcp` |
| Installer | Does `seer init` safely write and merge config? | `npm run test:init` |
| Service maps | Do HTTP, GraphQL, gRPC, tRPC, queues, and handlers link? | `npm run test:trackg && npm run test:bench` |
| Edit impact | Do risk, tests, modules, boundaries, and preflight packets populate? | `npm run test:tracke && npm run test:tracki` |
| Git history | Do churn, symbol history, continuity, and co-change signals work? | `npm run test:git && npm run test:symbol-history && npm run test:coupling` |
| Regression net | Do fixed bugs stay fixed? | `npm run test:regressions && npm run test:stability && npm run test:godot-fixes` |
| Repo scale | Does indexing remain deterministic on production-sized repos? | `npm run scale-test` |

## Main Gates

| Command | Use |
|---|---|
| `npm test` | Full release gate. |
| `npm run test:mcp` | Agent-facing tool confidence. |
| `npm run test:godot-fixes` | Focused C++ and ambiguity regressions. |
| `npm run test:scale-parallel-parity` | Serial-vs-parallel agreement at scale. |
| `npm run scale-test -- --only godot` | Focused engine-code indexing check. |
| `npm run scale-test -- --only unreal` | Focused very-large C++ indexing check. |

## MCP Suite Breakdown

Latest `npm run test:mcp`:

| Suite | Checks |
|---|---:|
| Core MCP smoke | 33 |
| History | 8 |
| JIT freshness | 4 |
| Watcher | 3 |
| Track C/D tools | 30 |
| Track E tools | 45 |
| Track F tools | 36 |
| Track G tools | 30 |
| Track I tools | 16 |
| Optimization spec | 47 |
| C++ / Godot regressions | 87 |
| **Total** | **339** |

## Stress Targets

| Repo | Why it matters |
|---|---|
| Godot | C++ engine code, overloaded names, event-flow patterns. |
| Unreal Engine | Very large C++ repo, high fan-in, headers. |
| Linux kernel | Huge C repo, headers, macros, scale pressure. |
| TypeScript | Large TypeScript project with language-service-style code. |
| React | Large JavaScript/TypeScript UI library. |
| Kubernetes client-go | Large Go codebase. |
| Helix | Rust codebase. |

## Regression Net

| Suite | Locks down |
|---|---|
| `tests/bug-regressions.ts` | Bugs found during audits and scale runs. |
| `tests/stability-regressions.ts` | Caller/callee stability and ambiguous names. |
| `tests/godot-fixes.ts` | C++ ambiguity, `::` lookup, batch dispatch, MCP output. |
| `tests/trackf-bugs.ts` | Bundles, SCIP, portability, shape hashes. |

## Latest Local Verification

| Command | Result |
|---|---|
| `npm run build` | passed |
| `npm run test:mcp` | passed |
| `npm run test:godot-fixes` | `87 passed, 0 failed` |
