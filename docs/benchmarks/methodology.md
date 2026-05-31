# Benchmark Methodology

There are two very different kinds of claim in this project, and they need two
very different kinds of evidence.

- **Speed** is deterministic. It does not involve an LLM, so we can measure it
  directly and reproducibly, and we do.
- **Accuracy** and **token usage** are about how much Seer helps an *agent*.
  That necessarily involves an LLM, so the numbers come from running real models
  on a fixed task suite. Those measurements are in progress; this page describes
  exactly how they are run so the results are honest and reproducible.

Accuracy and token-usage measurements use: **GPT-5.5, Claude Opus 4.8, Gemini
3.5 Flash (High), and Gemini 3.1 Pro.**

---

## Speed (deterministic)

Speed comes straight from `npm run scale-test`, which indexes each repo twice
(a cold fresh pass and a warm cached pass) and records:

- **Fresh time** and **ms/file** for the cold index.
- **Cached time** and the **cache speedup** for the warm re-index.
- **Symbols**, **edges**, **resolution rate**, and **database size**.

The same run also asserts determinism: the cached pass must reproduce the fresh
pass's counts exactly, and a separate parity gate proves the parallel and serial
indexers agree row-for-row. So the speed numbers are taken from runs that also
prove correctness, not from a separate "fast but maybe wrong" path.

To reproduce on your machine:

```bash
npm run scale-test                       # all repos under Large Codebases/
npm run scale-test -- --only helix,react # a subset
```

Hardware and Node version are recorded in `tests/outputs/latest.md`. Numbers
vary with disk and CPU; the shape (linear-ish ms/file, large cache speedup) is
what to compare.

---

## Accuracy and token usage (model-in-the-loop)

This is the part that proves the actual pitch: that an agent with Seer answers
more correctly while spending fewer tokens and fewer round-trips than the same
agent armed only with grep and file reads.

### The design

It is an A/B test where the only thing that changes is whether Seer is
available.

- **Condition A (baseline):** the agent has its normal file-read, grep/search,
  and shell tools. No Seer.
- **Condition B (Seer):** the same agent, same harness, same task, plus the Seer
  MCP tools.

Everything else (model, temperature, system prompt, repo, task wording) is held
constant. Each task is run several times per model, because models are
stochastic, and we report the mean and the spread rather than a single lucky
run.

### The task suite

A fixed set of repo tasks with deterministic ground truth, for example:

- "List every caller of function X." (ground truth: the resolved caller set)
- "Which tests exercise Y?" (ground truth: the tests that actually call it)
- "If I change the signature of Z, what breaks?" (ground truth: the transitive
  dependents and the routes/contracts affected)
- "Where is the handler for `POST /api/checkout`?" (ground truth: the route)
- "How did this function change over the last N commits?" (ground truth: git)

The tasks live alongside the repos so anyone can rerun them. Each task ships with
its verified answer.

### Establishing ground truth honestly

This is the part people get wrong. **Do not let Seer grade its own homework.**
Ground truth is established independently of Seer:

- caller and dependent sets are verified by hand and cross-checked with a
  compiler/LSP or a language-server where one exists,
- "which tests cover this" is verified by actually running the tests and seeing
  what executes the symbol,
- route and history answers are checked against the framework config and git
  directly.

Only after the answer key exists independently do we score the agent runs
against it.

### What gets measured

For each task, condition, and model:

| Metric | Definition |
|---|---|
| **Correctness** | Did the final answer match ground truth? For set answers, precision and recall of the items found. |
| **Tokens** | Total input + output tokens across every tool round-trip to reach the answer. |
| **Round-trips** | Number of tool calls the agent made. |
| **Wall time** | End-to-end time to a final answer. |

The headline numbers are the **deltas**: accuracy gain, token reduction, and
round-trip reduction of Condition B over Condition A, averaged across tasks and
models.

### Reporting rules (so it stays honest)

- Report every task, not a cherry-picked subset. Include the cases where the
  baseline ties or wins (small repos and trivial lookups, where grep is already
  fine). Showing where Seer does *not* help is what makes the cases where it
  does believable.
- Report variance, not just means.
- Keep the harness, prompts, and task suite public so the run is reproducible.
- Separate "got it right" from "got it cheaply." A tool that is right but
  expensive, or cheap but wrong, is not the claim.

### Why this is favorable to Seer without fudging

The pitch is structural: an agent without Seer reaches a caller set or a blast
radius by issuing many searches and reading many files, which costs tokens and
round-trips and still misses transitive and cross-file relationships. Seer
returns those as one deterministic fact. So on the tasks that are about
structure and impact, fewer round-trips and higher recall are the expected,
honest outcome. On tasks that are not about structure, it should be a wash, and
the report should say so.

---

See [raw-results.md](raw-results.md) for the measured speed numbers and the
accuracy/token tables (filled in as the model runs complete).
