# Symbol-History Performance And Observability Plan

**Status:** IMPLEMENTED 2026-06-02 (schema v11). All stages S1–S5 landed; S6 (bounded concurrency) deferred. See "As-built deltas" below for where the implementation refined the proposal after verifying real `git` output.
**Scope:** make `seer symbol-history`, `seer_symbol_history_build`, and `buildSymbolHistory` fast and observable on large repos such as Godot, Linux, and godot-cpp, without regressing rename precision or history correctness.
**Author:** review pass, 2026-06-02. Reviewed/updated for resume correctness.

## 0. As-built deltas from the proposal

Three refinements emerged from verifying real `git` output (the plan asked for exactly this):

1. **The combined command drops `--name-status`.** Combined with `-p` and a custom `--pretty=format:`, `--name-status` makes git emit the name-status summary and *suppress the patch* — every hunk would be silently lost. `--follow -p -U0` alone already threads the diff through renames, so the per-commit path the old code parsed from `--name-status` is no longer needed. `pathAtCommit` is eliminated entirely: the patch is inline, so there is no second `git show` to disambiguate (B1 spawn count drops from F·C straight to F with no rename-lookup logic).

2. **Resume skip key = `file_hash` + `options_fingerprint` + `algorithm_version`** (NOT `head_sha`). An unchanged file hash at a newer HEAD *proves* no commit touched the file since it was processed, so its `--follow` history and current symbol ranges are unchanged — making this strictly stronger than a HEAD check and giving free incremental reruns (only changed files reprocess). `head_sha` is still recorded, for observability and the completion stamp. This fully satisfies the plan's "must not be keyed only by HEAD" requirement.

3. **Pure renames are now represented as renames, not file additions** — a small, deliberate correctness *improvement* over criterion #4's "identical row set" (see that criterion for detail).

---

## 1. Goal And Success Criteria

`npx seer-mcp symbol-history` can take a long time on large repos and currently gives little feedback while it runs, so the user cannot tell whether it is working or hung.

Success criteria:

1. **Observable.** A TTY shows a live progress bar with phase, files done/total, current file, and rows inserted. Non-TTY emits periodic plain log lines.
2. **Fast.** Use far fewer `git` subprocess spawns and avoid per-row SQLite overhead. Target: a multi-thousand-file repo drops from minutes to tens of seconds for a cold run.
3. **Resumable.** A run interrupted by `Ctrl-C`, deadline, or `maxFiles` does not restart from file 1 next time.
4. **No correctness regression.** Same `symbol_history` row set as today for every content-bearing commit, with per-file `--follow` rename tracking preserved. Rename precision must not be traded away.
   - *As-built refinement:* one row-set difference, and it is an improvement. The old two-step resolved each commit's diff with `git show -U0 <sha> -- <newPath>`; that pathspec hides the rename source, so git mis-reports a PURE rename (file moved, zero content change) as a brand-new file, fabricating a `file-addition` row that attributes every symbol's creation to the rename commit. The combined `--follow -p` walk sees the rename correctly (no hunks, not an addition), so a pure rename contributes no row and creation stays attributed to the real original add. Rename-WITH-content-change commits are byte-identical (covered by `bug-regressions` Bugs 4+5 and `symbol-history-perf` parity). Rename *linkage* across the boundary remains the v10 continuity pass's job.

---

## 2. Current Architecture

Entry point: [`buildSymbolHistory`](src/indexer/symbolhistory.ts#L59).

Per-run flow:

- Once: `isGitRepo`, `gitHeadSha`, and the HEAD skip check via `git_index_state.lastHistoryHeadSha`.
- `store.listSymbolsForHistoryIndex()` -> group symbols by file -> `byFile` map.
- For each file:
  - `commitsForFile(...)` -> one `git log --follow --name-status --pretty=...` subprocess.
  - For each commit, up to `maxCommitsPerFile` default 200:
    - `fileDiffInfo(repoRoot, sha, lookupPath)` -> one `git show --format= -U0 <sha> -- <rel>` subprocess.
    - For each symbol in the file: overlap test -> `store.insertSymbolHistory(...)`.
- After the loop: continuity pass, then `store.setHistoryHeadSha(...)`.

Writes: `insertSymbolHistory` prepares and runs an `INSERT OR IGNORE` per row. Without an explicit transaction, SQLite/better-sqlite3 pays avoidable per-row overhead.

Progress UI today: only the `log()` callback for skip/timeout/summary lines. The CLI wires that to `console.log`. The indexer has a private TTY bar, `writeProgress(current, total, label)`, that is not exported.

Schema: `symbol_history` has `UNIQUE(symbol_id, commit_sha)`, so re-processing a `(symbol, commit)` pair is idempotent.

---

## 3. Bottlenecks

### B1 - `git show` Per File-Commit Pair

For F files averaging C commits, the diff phase spawns about `F * C` `git show` processes. On Windows especially, process creation can dominate wall time.

### B2 - Redundant Repo Checks

`commitsForFile` and `fileDiffInfo` each call `isGitRepo()`, which uses blocking `spawnSync('git rev-parse --is-inside-work-tree')`. `buildSymbolHistory` already checks the repo once, so the hot path can skip these repeated checks.

### B3 - Per-Row DB Work

`insertSymbolHistory` recompiles the statement and writes per row. For large histories, a cached prepared statement plus per-file or chunked transactions should be much faster.

### B4 - No Resume

On deadline/maxFiles/interruption, no per-file progress is persisted. The next run re-walks files from the start. Inserts are idempotent, but the work is wasted.

### B5 - No Progress Feedback

Users see no steady progress during the long git phase.

### B6 - Serial Git Phase

The per-file git reads are read-only and can be parallelized with a small bounded pool. SQLite writes should remain single-writer.

---

## 4. Proposed Improvements

### I1 - Replace Per-Commit `git show` With One `git log -p` Per File

Use one subprocess per file:

```bash
git -C <root> log --follow --no-merges -U0 -p \
  --pretty=format:__C__%H%x09%an%x09%ae%x09%aI%n%B%n__BODY_END__ \
  -n<maxCommits> [--since=...] -- <rel>
```

This keeps per-file `--follow` rename precision while reducing diff-phase spawns from `F * C` to `F`.

> **As-built:** `--name-status` was REMOVED from the proposed command. Verified empirically: with `-p` and a custom `--pretty=format:`, adding `--name-status` makes git emit the name-status block and suppress the patch, dropping all hunks. `--follow -p` alone yields the inline diff at the correct historical path, so `pathAtCommit` is no longer parsed or needed.

Implementation notes:

- Add `parseFollowLogWithPatches` or extend `parseFollowLog`.
- Parse commit headers, message body ending at `__BODY_END__`, name-status/diff headers, `@@ -a,b +c,d @@` hunks, and file-addition markers such as `new file mode` / `--- /dev/null`.
- A streaming parser should emit a commit record when the next `__C__` header or EOF is reached, not when `__BODY_END__` is reached, because hunks come after the body terminator.
- Keep current timeout/kill semantics.
- Add golden-output parser tests for rename/copy/file-addition cases.

### I2 - Skip Redundant `isGitRepo()` In The Batch Path

Add `assumeRepo?: boolean` or `skipRepoCheck?: boolean` to the git helpers. `buildSymbolHistory` can pass it after validating the repo once.

### I3 - Batch DB Writes

- Cache the `INSERT OR IGNORE INTO symbol_history` prepared statement.
- Add `insertSymbolHistoryBatch(rows)` or a small `withTransaction(fn)` helper.
- Prefer per-file transactions. They are simple, bounded, and align with resume watermarks.
- Mark the per-file watermark only after the file's insert transaction commits.

### I4 - Add Progress Events And CLI Progress UI

- Extract the indexer's `writeProgress` into a shared module such as `src/indexer/progress.ts` or `src/cli/progress.ts`.
- Add to `SymbolHistoryOptions`:

```ts
onProgress?: (p: {
  phase: 'scan' | 'history' | 'continuity';
  filesProcessed: number;
  filesTotal: number;
  currentFile: string;
  commitsProcessed: number;
  rowsInserted: number;
}) => void;
```

- Emit at phase boundaries and after each file.
- CLI maps progress to a TTY bar, or throttled plain logs for non-TTY.
- MCP can ignore progress for now because tool responses are single-shot.

### I5 - Add Safe Resume Watermarks

Do not key resume only by HEAD. That would be incorrect when:

- the user first runs `--max-commits 10` and later reruns with default 200,
- the user changes `--since`,
- the local Seer index changes under the same git HEAD,
- the parser/algorithm changes.

Use a per-file watermark keyed by enough state to prove the skipped work is equivalent:

```text
symbol_history_progress(
  repo_root,
  head_sha,
  file_path,
  file_hash,
  options_fingerprint,
  algorithm_version,
  processed_at
)
```

The `options_fingerprint` should include `maxCommitsPerFile`, `since`, follow/no-follow mode if ever added, and other history-affecting options. The `algorithm_version` should bump when parser semantics or match rules change.

On a full completion, stamp `lastHistoryHeadSha` as today and optionally prune matching watermark rows. On partial completion, leave the HEAD stamp unset but keep per-file watermarks.

Sort file iteration deterministically so progress and resume behavior are stable.

### I6 - Optional Bounded Concurrency

After I1 lands, run per-file git reads through a small pool, for example 4 to 8 workers. Keep DB writes serialized through a single consumer. Gate with `--concurrency` and default conservatively.

---

## 5. Staged Implementation Plan

| Stage | Change | Fixes | Risk | Effect |
|---|---|---|---|---|
| S1 | Skip redundant repo checks | B2 | very low | removes blocking sync spawns from the hot loop |
| S2 | Cached prepared statement plus per-file transaction | B3 | low | faster writes, no behavior change |
| S3 | One `git log -p --follow` per file plus parser extension | B1 | medium | headline spawn reduction |
| S4 | Progress callback plus CLI bar/logs | B5 | low | solves "is it hung?" |
| S5 | Safe resume watermark with file hash/options/algorithm fingerprint | B4 | medium | partial runs continue correctly |
| S6 | Bounded git-read concurrency | B6 | medium | further wall-time reduction |

Recommended landing order: S4 can land first or alongside S1/S2 for quick user-visible improvement. Then S1 -> S2 -> S3 -> S5 -> optional S6.

Files likely touched:

- `src/indexer/git.ts` - combined log+patch helper and parser; repo-check skip option.
- `src/indexer/symbolhistory.ts` - combined helper, progress callback, transactions, resume skip.
- `src/db/store.ts` - batch insert / transaction helper / watermark accessors.
- `src/db/schema.ts` - optional `symbol_history_progress` table.
- `src/indexer/progress.ts` or `src/cli/progress.ts` - shared progress rendering.
- `src/cli/index.ts` - progress wiring and optional `--concurrency`.

---

## 6. Risks And Tradeoffs

- **`git log -p --follow -U0` output shape.** Verify real output with golden tests. The parser should tolerate `diff --git`, `rename from/to`, and hunk headers in the same commit block.
- **Large patch memory.** The current landed code still accumulates the full `git log -p` output in memory. That is acceptable for now, but if large-repo benchmarks show pressure here, the next step should be a streaming line parser rather than larger buffers.
- **Concurrency vs SQLite.** Parallelize reads only; write through one serialized path.
- **Resume staleness.** Watermarks must include file hash, options fingerprint, and algorithm version. `head_sha` is useful for observability, but it is not the correctness key.
- **Behavior parity.** Guard with parity tests against the old path.

---

## 7. Testing Strategy

- Parser tests with captured `git log -p --follow -U0` output: normal edit, rename, copy, file addition.
- Live tiny-repo parity test: old path (`commitsForFile` + `fileDiffInfo`) and new combined path produce identical `(symbol_id, commit_sha, match_strategy, lines_added, lines_removed)` rows.
- Write-batching test: batch insert equals single-row inserts; second run inserts no duplicates.
- Resume tests:
  - `maxFiles=1` writes a watermark, rerun completes remaining files.
  - Changing `maxCommitsPerFile` or `since` ignores incompatible watermarks.
  - Changing file hash/index state ignores incompatible watermarks.
- Progress test: monotonic `filesProcessed`, final `filesProcessed === filesTotal`, and non-TTY log fallback.
- Regression: full `npm test`.
- Manual benchmark: large clone before/after, recording wall time and git subprocess count.

---

## 8. Rejected Or Out Of Scope

- **Repo-wide `git log -p` as the default.** Rejected because repo-wide history cannot use per-path `--follow`, so it loses rename tracking. It could be an explicit future `--no-follow --fast` mode only.
- **Reparsing historical file versions.** Useful for rename-within-file precision, but orthogonal to this performance work.
- **Long-lived `git cat-file --batch` or `fast-export`.** More complex; revisit only if the staged plan is still too slow.

---

## 9. TL;DR

1. Add progress first if quick user feedback matters.
2. Remove redundant repo-check spawns.
3. Batch SQLite writes.
4. Replace per-commit `git show` with per-file `git log -p --follow -U0`.
5. Add safe resume keyed by file hash, options fingerprint, and algorithm version, with `head_sha` kept for observability.
6. Optionally parallelize read-only git work while keeping DB writes serialized.
