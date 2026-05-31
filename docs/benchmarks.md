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
Gemini 3.5 Flash (High), and Gemini 3.1 Pro**. See
[methodology](benchmarks/methodology.md) for exactly how, and
[raw-results](benchmarks/raw-results.md) for the full tables.

---

## Speed (measured)

Indexing throughput and cache speedup across the large-codebase suite. See
[raw-results](benchmarks/raw-results.md) for the full table, hardware, and the
determinism guarantees that ride along with these runs.

<!-- speed-summary: populated from a single clean `npm run scale-test` -->

The shape that matters: indexing scales roughly linearly in files, and a warm
re-index is one to two orders of magnitude faster than a cold one because
unchanged files are skipped entirely. Query latency against the finished index
is SQLite-fast (low single-digit milliseconds for typical lookups), which is why
an agent can afford to ask Seer many small questions.

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

→ [Methodology](benchmarks/methodology.md) · [Raw results](benchmarks/raw-results.md)
