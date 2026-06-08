# Benchmarks

This page reports one measured claim: **indexing performance**.

The numbers come from one `npm run scale-test` session on a consumer laptop
running Node v26.1.0 on Windows. Your hardware will differ, so the per-file
shape matters more than the exact wall-clock time.

## Summary

| Codebase | Files | Fresh index | ms/file | Cached re-index |
|---|---:|---:|---:|---:|
| helix (Rust) | 245 | 1.4s | 5.8 | 0.6s |
| client-go (Go) | 2,314 | 2.2s | 0.9 | 0.6s |
| React (TS/JS) | 4,359 | 6.9s | 1.6 | 2.2s |
| Godot (C++/C#/Java) | 4,228 | 22.9s | 5.4 | 1.5s |
| TypeScript (TS) | 39,331 | 40.1s | 1.0 | 4.1s |
| Linux kernel (C/C++) | 63,965 | 3m46s | 3.5 | 16.3s |
| Unreal Engine (C++) | 84,331 | 5m43s | 4.1 | 22.7s |

## Read The Table

| Column | Meaning |
|---|---|
| Fresh index | Seer builds the local SQLite index. |
| ms/file | Fresh index time divided by indexed files. |
| Cached re-index | Seer checks the same repo again with no file changes. |

## Reproduce

```bash
npm run scale-test
npm run scale-test -- --skip cbm
```

The command writes:

| Output | Purpose |
|---|---|
| `tests/outputs/latest.md` | Human-readable summary. |
| `tests/outputs/run-<timestamp>.json` | Machine-readable report. |
| `tests/outputs/dbs/<name>.db` | Per-repo SQLite index. |

See [raw results](benchmarks/raw-results.md) for the full table.
