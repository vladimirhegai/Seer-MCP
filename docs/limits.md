# Known Limits

Seer is useful because it is fast, local, and deterministic. Those choices come
with boundaries. This page names them plainly.

## Summary

| Area | Limit | Practical move |
|---|---|---|
| HTTP routes | Framework support is explicit. | Check [Language Support](languages.md). |
| Edge resolution | Tree-sitter gives structural edges without full type checking. | Use SCIP overlays for compiler-grade edges. |
| Generated code | Seer indexes files on disk. | Include generated files when you need them. |
| Runtime behavior | Reflection and dynamic DI are invisible until represented in source. | Treat dynamic systems as manual review areas. |
| Co-change history | Needs the full history index. | Run `seer symbol-history`. |

## Route Extraction

Routes are extracted for:

| Ecosystem | Frameworks |
|---|---|
| TypeScript / JavaScript | Express, Fastify, tRPC, GraphQL |
| Python | FastAPI, Flask |
| Java | Spring Boot |
| gRPC | `.proto` files |

Other languages can still be clients in service links.

## Edge Resolution

Seer links calls to definitions with a fast scope-aware resolver:

1. Same file.
2. Imported files.
3. Global same-name fallback.

This works well for structural navigation. Heavily overloaded or dynamically
dispatched code may need a compiler index. Import one with:

```bash
seer scip-import scip.json
```

## Generated And Runtime Code

Seer reads files. Build-time generated code, runtime route registration,
reflection, and dependency injection only appear when they are visible in files.

To include generated files:

```bash
seer index . --include-generated
```

## Resolution Percentage

`seer stats` reports resolved call edges. That percentage is a health signal.
Projects with many external-library calls naturally resolve fewer edges because
those definitions live outside the repo.

## Temporal Coupling

`seer_changes_with` looks for symbols that changed in the same commits. It needs
the full history index because partner symbols may live in other files.

```bash
seer symbol-history
```

Check `historyComplete` in the response before relying on an empty partner list.

## Deterministic Facts

Seer tells an agent what the repo structure says. The agent still decides what
the change means and whether the final code is correct.
