# Known Limits

Seer is honest about what it does not do. Knowing these keeps an agent from
trusting a signal further than it should.

## HTTP route extraction is framework-limited

Server-side routes are extracted for Java (Spring), Python (FastAPI, Flask), and
TypeScript/JavaScript (Express, Fastify, tRPC, GraphQL). Go `net/http`/gin/chi,
Rust axum/actix, C# ASP.NET, and C++ have no HTTP route extraction. Those
backends can still be a *client* in a service link, and they can be a *target*
over gRPC (routes come from `.proto` files), but not an HTTP target. See
[Language Support](languages.md).

## Continuity is a snapshot matcher, not a time machine

`seer_continuity` links a rename or move only when both identities exist in the
current working tree (for example a kept alias). A true cross-commit rename,
where the old symbol is gone, yields no continuity candidate, on purpose, because
inventing one would be a false positive. Cross-commit lineage is delivered by
`seer_history` instead, which follows the file through git. So the "trace
refactoring across renames" promise is real; it is just fulfilled by history,
with continuity as advisory snapshot evidence.

## Edge resolution is heuristic, not a compiler

The three-pass resolver (same-file, imported-file, global fallback) is fast and
language-agnostic, but it is not type-aware. On heavily overloaded or
dynamically dispatched code, the global fallback can bind to a plausible
same-name target rather than the exact one. For compiler-grade precision on a
specific language, layer in a SCIP index with `seer scip-import`; those edges are
labeled by provenance and sit on top of the tree-sitter baseline.

## It indexes what is on disk

Seer parses source files. Code generated at build time, behavior injected by
reflection or runtime DI, and routes registered dynamically at startup are
invisible until they exist as files. `--include-generated` pulls in generated
files if you want them.

## Resolution percentage is not coverage

The "resolved edges" percentage in `seer stats` reflects how many call edges
were bound to a definition, which is naturally lower in repos that lean on
external libraries (those targets are not in the index). It is a health signal,
not a quality grade.

## Deterministic, not semantic

Seer returns facts, not understanding. It will tell you a function has 9
dependents and sits on a public route; it will not tell you whether your change
is correct. That judgment stays with the agent and with you.
