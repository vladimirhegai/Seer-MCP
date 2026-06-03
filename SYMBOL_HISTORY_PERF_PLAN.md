# Symbol-History Performance Plan

Status: **A + B1 + B2 IMPLEMENTED** (2026-06-03). B3 (single streaming whole-repo
walk) and B4 (commit-range sharding) are intentionally **not** implemented yet —
measured results below made them unnecessary for now.

Validated on the Strata git repo (real history): full build **5,295ms → 1,139ms
(4.6× via B1)** with byte-identical rows; a **scoped on-demand build of one
symbol's file in ~241ms**; re-index auto-refreshes history incrementally. Godot
grounding numbers (**3,992 files / 129,820 symbols**) still motivate the design.

Resolutions to the §5 open questions (as built):
1. **Default rename semantics:** `--follow` is OFF by default (B2); continuity
   bridges renames. `follow:true` / `--follow` opts back in. Algorithm version
   bumped 1→2; `follow` is in the options fingerprint.
2. **On-demand inline budget:** the scoped MCP build caps `symbols`/`paths` at 50
   entries each (Zod `.max(50)`).
3. **Does seer_context/seer_history auto-build?** No — read tools never mutate.
   seer_history stays read-only + batchable and emits a `buildHint`; the scoped
   write lives in `seer_symbol_history_build { symbols | paths }`.
4. **Resume granularity:** unchanged — per-file watermarks (no B3, so no
   commit-range checkpoints needed).
5. **Target SLA:** met for repos of Strata's size in ~1s; B3/B4 deferred until a
   real repo exceeds the budget after A+B1+B2.

The original proposal follows for reference.

---

Status (original): **proposal**. Numbers below use the bundled Godot index for
grounding: **3,992 candidate files / 129,820 candidate symbols** (standard mode,
tests/vendor/generated excluded).

---

## 1. Why it is slow today

`buildSymbolHistory()` walks history **one file at a time**:

```
for each candidate file F (≈4,000, sequential):
    spawn: git log --follow -U0 -p --no-merges -n200 -- <file>
    parse the streamed patch, attribute hunks to that file's symbols
    batch-insert rows, stamp a per-file resume watermark
```

Four compounding costs, in order of impact:

1. **Redundant per-commit work (the dominant asymptotic cost).** A commit that
   touches *K* files is read and diff-parsed **K separate times** — once inside
   each file's walk. Godot has commits touching hundreds of files (engine-wide
   renames, formatting passes, license headers). Total work is
   `Σ_files (history-of-that-file × diff-size)`, which for a monorepo is far
   larger than the `Σ_commits (diff-size)` that a single walk would pay.

2. **`--follow` rename detection, per file.** `--follow` re-runs git's rename
   detection at each step of each file's walk. It is the single most expensive
   common `git log` flag and only works for one path at a time — it is the
   reason we are *forced* into the per-file shape. Rarely-changed files are the
   worst case: git walks to the repo root to find 2–3 commits, doing rename
   detection the whole way.

3. **No parallelism.** ~4,000 `git` subprocesses run strictly sequentially.
   Process spawn + git object-walk startup is paid 4,000 times on one core.

4. **Whole-output buffering.** Each spawn buffers its full patch into one JS
   string before parsing. Fine per-file; fatal for any whole-repo `-p` walk
   (Godot's full `git log -p` is multiple GB).

What is already good (keep it): per-file resume watermarks (content-hash +
options-fingerprint + algorithm-version), deadline/`maxFiles` budgets, batched
per-file transactions, the `shallow`/`diagnostic` honesty signals, and the
HEAD-stamp no-op fast path.

---

## 2. Two independent thrusts

The work splits cleanly along **how an agent vs a user actually consumes it**.

### Thrust A — make the *common agent path* not need a full build at all

How an agent thinks: it calls `seer_history { symbol }` (or `seer_context`,
which embeds recent history) for **one symbol it is about to touch**. It does
not want — and should never silently trigger — an hours-long whole-repo build.
Today `seer_history` is read-only and just reports `historyIndex.built: false`
until someone runs the full build. That is the real friction the agent hit.

**Proposal: on-demand, file-scoped history.**

- `seer_history { symbol, file? }` — on a cold/partial index, build history for
  **just the resolved symbol's file(s)** (1 git spawn, typically < 1s), insert
  those rows, then answer. One file is cheap even with `--follow`. The per-file
  watermark means the full build later reuses this work for free.
- New explicit scoped build for a known working set:
  `seer_symbol_history_build { paths: [...] }` or `{ symbols: [...] }` — builds
  only those files. This is the literal answer to "can the agent build it for a
  chunk of files." Seconds, not hours.
- Gate it: scoped/on-demand build is allowed inline (small, bounded); the
  **whole-repo** build stays explicit + user-approved (it is the only expensive
  path). A `maxFilesInline` guard (e.g. ≤ 25 files) keeps an over-eager agent
  from walking the whole repo through the back door.

Net effect: the agent's actual question ("history of `foo`?") is answered in
seconds on a fresh repo, with **zero** full-build requirement. The full build
becomes a *product/onboarding* feature (timeline UI, instant-every-query), not a
prerequisite for the edit loop.

### Thrust B — make the *full build* dramatically faster (for users/CI)

For the user who does want the whole index prebuilt (CI artifact, timeline,
every query instant), attack §1's costs in risk-ascending tiers.

**B1 — Parallelize the per-file walks (low risk, ~Nx where N≈cores).**
Run the existing per-file `commitsWithDiffsForFile` walks through a bounded
concurrency pool (N = CPU count, default ~8). Git subprocesses are independent
and I/O-bound, so this is near-linear on the spawn-bound portion. Keep all writes
on the single main thread (SQLite is single-writer): workers return parsed rows,
the main loop batches+watermarks them. Resume watermarks already make this safe
and idempotent. **This is the cheapest big win and reuses all existing logic.**
Estimate: 4,000 sequential spawns → ~4,000/8 effective ⇒ roughly 5–8× wall-clock.

**B2 — Make `--follow` opt-out (medium win, changes semantics slightly).**
Drop `--follow` by default; offer `--follow` as a precision flag. Without it,
`git log -p -- <file>` stops at the file's rename boundary ("history starts
here" at the rename). That truncation is **already bridged by the continuity
pass** (shape-hash rename/move recovery), so for most workflows `--follow` is
redundant with machinery we already run. Removing rename detection from every
step is a large per-file constant-factor cut (often 2–5× on deep histories).
Trade-off to decide: accept rename-truncated raw history + continuity bridge as
the default, vs. keep `--follow` for users who want unbroken file-rename chains.

**B3 — Single streaming whole-repo walk (high win, biggest rewrite).**
Replace F per-file walks with **one** `git log -U0 -p --no-merges` over the repo
(optionally `--since`/`-n` bounded), **stream-parsed** line-by-line (never
buffered). Maintain a `path → [symbols with line ranges]` map built once from the
index; for each commit, for each changed file in its diff, fan hunks out to that
file's symbols. This reads **every commit exactly once** — it removes cost §1.1
entirely (the dominant term) and §1.2 (no `--follow`). It is asymptotically the
right design: `O(total history × diff-size)` instead of `O(Σ per-file history)`.
Costs/risks: requires a robust **streaming** diff parser (the current code
buffers); loses per-file `--follow` (rely on continuity); per-file resume
watermarks become coarser (resume granularity shifts from "file" to "commit
range" — see B4). Memory stays flat because we stream.

**B4 — Commit-range sharding (parallelism for B3).**
B3 is inherently one stream. To use multiple cores, shard by commit range:
`git log <range>` partitioned into K contiguous slices (by `--skip`/`-n` or by
date windows), one streaming `-p` walk per slice on a worker, each emitting rows
for its slice. Resume becomes "which commit-range slices are done." This is the
top-end design (single-read semantics × cores) but only worth it after B3 proves
out.

---

## 3. Constraints / hard floors (so we set expectations)

- **Git itself has a floor.** A full `git log -p` must decompress and diff every
  commit once; on a huge repo that is inherently minutes of I/O+CPU. B3 reaches
  that floor; we cannot beat "read every diff once." The hours today are mostly
  *redundant* work above that floor, which is what B1–B3 remove.
- **SQLite is single-writer.** Parallel git is fine; writes must funnel through
  one thread. Batched transactions already handle throughput; not a bottleneck.
- **Shallow/zip checkouts have no history to mine.** Already detected and
  surfaced via `shallow`/`diagnostic`; no perf work changes that.
- **Correctness contract is unchanged.** Raw line-overlap attribution + the
  continuity bridge stay the source of truth; perf changes must be row-for-row
  parity-tested against the current output (the `HISTORY_ALGORITHM_VERSION`
  watermark exists exactly to gate this).

---

## 4. Recommended sequencing

1. **Thrust A (on-demand + scoped build).** Highest user-visible value, lowest
   risk, and it removes the full build from the agent's critical path entirely.
   Most "symbol-history takes hours" pain disappears because the agent stops
   needing the full build.
2. **B1 (parallelize per-file).** Cheap, big wall-clock win for users who still
   want the full prebuild; no semantic change; parity-safe.
3. **B2 (`--follow` opt-out).** Decide the default; another large constant cut.
4. **B3 (single streaming walk)** then **B4 (sharding).** The asymptotic fix —
   schedule only if, after A+B1+B2, the full build is still too slow for the
   target repos. Bigger rewrite + streaming parser + parity burden.

A + B1 + B2 are likely enough to take Godot's full build from "hours" to the
low-minutes range, with the agent path already at "seconds" after A.

---

## 5. Open questions to resolve before implementing

1. **Default rename semantics:** ship `--no-follow` as default (faster, lean on
   continuity) or keep `--follow` default (unbroken file-rename history)? This
   decides B2 and affects B3.
2. **On-demand inline budget:** what is the max file count Seer will build
   inline before forcing the explicit/approved path? (Proposed ≤ 25.)
3. **Should `seer_context`/`seer_preflight` also trigger on-demand history for
   the focal symbol's file,** or only `seer_history`? (Leaning: yes for the
   focal file only — it is one cheap spawn and history is part of the packet.)
4. **Resume granularity if we go to B3:** keep per-file watermarks (recomputed
   from a commit-range checkpoint) or move to commit-range checkpoints? Affects
   how an interrupted full build resumes.
5. **Target SLA:** what repo size / wall-clock are we designing for (e.g. "Godot
   full build < 5 min on 8 cores")? Sets how far down B3/B4 we go.
