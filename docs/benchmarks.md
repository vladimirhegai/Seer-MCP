# Benchmarks

## Summary

Seer makes three claims. One is deterministic and measured here. Two depend on a
model in the loop and are being measured now.

- **Speed.** Indexing is fast and the cache is near-instant. Measured directly,
  reproducibly, on eight real open-source repos up to the size of the Linux
  kernel and Unreal Engine. Numbers below.
- **Accuracy.** An agent with Seer answers structural and impact questions more
  correctly than the same agent with only grep. In progress.
- **Token usage.** That same agent gets there with fewer tokens and fewer tool
  round-trips. In progress.

Accuracy and token-usage numbers are measured with **GPT-5.5, Claude Opus 4.8,
Gemini 3.5 Flash (High), and Gemini 3.1 Pro**, by running each model on the same
tasks twice (once with only grep/file tools, once with Seer added) and scoring
against an independently verified answer key. Full speed numbers are in
[raw-results](benchmarks/raw-results.md).

---

## Speed (measured)

From one `npm run scale-test` session on a consumer laptop (Node v26.1.0,
win32). Full per-repo detail, cold-start figures, and the reproduce command are
in [raw-results](benchmarks/raw-results.md).

| Codebase | Files | Symbols | Edges | Index time | Cached re-index |
|---|---:|---:|---:|---:|---:|
| helix (Rust) | 245 | 5,207 | 24,057 | 1.4s | 0.6s |
| client-go (Go) | 2,314 | 17,589 | 41,714 | 2.2s | 0.6s |
| react (TS/JS) | 4,359 | 20,624 | 48,387 | 6.9s | 2.2s |
| godot (C++/C#) | 4,228 | 134,792 | 541,981 | 22.9s | 1.5s |
| TypeScript (TS) | 39,331 | 133,691 | 118,389 | 40.1s | 4.1s |
| linux (C/C++) | 63,965 | 1,050,833 | 4,380,287 | 3m46s | 16.3s |
| Unreal Engine (C++) | 84,331 | 1,547,940 | 5,028,722 | 5m43s | 22.7s |

The shape that matters: indexing scales roughly linearly in files (about 1 to 5
ms per file even on the giant repos), and an unchanged re-index is up to ~15x
faster because Seer skips every file whose hash has not moved. Query latency
against the finished index is SQLite-fast (low single-digit milliseconds for
typical lookups), which is why an agent can afford to ask Seer many small
questions. Absolute times depend on your hardware; rerun `npm run scale-test` to
get your own.

---

## Accuracy (in progress)

For a fixed suite of repo tasks with deterministic ground truth, we run each
model twice: once with only its normal tools, once with Seer added, and score
the final answer against the answer key.

<!-- accuracy-table: filled in as model runs complete -->

| Task family | Baseline (grep only) | With Seer | Models |
|---|---|---|---|
| Caller / dependent sets | (pending) | (pending) | GPT-5.5, Opus 4.8, Gemini 3.5 Flash (High), Gemini 3.1 Pro |
| Test coverage of a symbol | (pending) | (pending) | " |
| Change blast radius | (pending) | (pending) | " |
| Route / handler lookup | (pending) | (pending) | " |
| Symbol history | (pending) | (pending) | " |

---

## Token usage (in progress)

Same task suite, same A/B design. The metric is total tokens and tool
round-trips to reach a correct answer.

<!-- token-table: filled in as model runs complete -->

| Task family | Baseline tokens | With Seer | Reduction | Round-trips (base / Seer) |
|---|---|---|---|---|
| Caller / dependent sets | (pending) | (pending) | (pending) | (pending) |
| Test coverage of a symbol | (pending) | (pending) | (pending) | (pending) |
| Change blast radius | (pending) | (pending) | (pending) | (pending) |
| Route / handler lookup | (pending) | (pending) | (pending) | (pending) |
| Symbol history | (pending) | (pending) | (pending) | (pending) |

---

→ [Raw results](benchmarks/raw-results.md)
