import { Store } from '../db/store.js';
import {
  commitsWithDiffsForFile, isGitRepo, gitHeadSha, gitRemoteUrl,
  extractPrNumber, githubPrUrl,
} from './git.js';
import { buildContinuity } from './continuity.js';
import type { SymbolHistoryInsert } from '../types.js';

/**
 * Symbol-history pass — for every indexed function/method/constructor/class
 * symbol, walk the commits that touched its file and record the ones whose
 * diff hunks overlap the symbol's current line span.
 *
 * Performance (see SYMBOL_HISTORY_PERF_PLAN.md):
 *   - One `git log --follow -U0 -p` subprocess per file (combined log+patch)
 *     instead of one `git log` plus one `git show` per commit. Spawns drop from
 *     ~F*C to F while keeping per-file `--follow` rename precision.
 *   - The repo is validated once; per-file helpers run with assumeRepo so they
 *     don't re-spawn `git rev-parse` on every call.
 *   - Each file's rows are written in one batched transaction via a cached
 *     prepared statement, not one autocommit per row.
 *   - A per-file resume watermark (symbol_history_progress) lets an interrupted
 *     or budgeted build skip already-finished files on the next run, and makes a
 *     HEAD-moved rerun reprocess only files whose content changed.
 *   - Progress is reported through `onProgress` so the CLI can render a bar; the
 *     module itself never writes to stdout.
 *
 * Limitations (documented honestly):
 *   - Renames within a file: we do NOT reparse historical file versions, so
 *     a function rename will appear as "history starts here" at the rename
 *     commit. The symbol_key column captures `kind:qualified_name` so a
 *     future enhancement (key-match on historical AST parse) could recover
 *     pre-rename history without touching this schema.
 *   - File renames: `git log --follow` is used per-file so file renames
 *     ARE preserved; but cross-file moves are not. A PURE rename (the file moved
 *     with no content change) is represented as a rename — it contributes no
 *     history row, and the symbols' creation stays attributed to the original
 *     add commit. (The previous two-step `git show -U0 <sha> -- <newpath>` walk
 *     mis-saw a pure rename as a fresh file addition, fabricating a file-addition
 *     row at the rename commit; the combined `--follow -p` walk no longer does.
 *     Rename-with-content-change commits are unchanged — their hunks attribute as
 *     before. Rename *linkage* across the boundary is the continuity pass's job.)
 *   - Line numbers shift across history. We compare a commit's hunks against
 *     the current symbol's line range — older overlaps are approximate.
 *     match_strategy = 'overlap' / confidence < 1.0 reflect that.
 */

/**
 * Bump when the matching semantics change (overlap rule, confidence formula,
 * file-addition handling, candidate symbol kinds). It is part of every resume
 * watermark, so a bump invalidates stale watermarks and forces a rebuild. The
 * v11 combined-helper change did NOT alter row output (parity-tested), so it
 * stays at 1.
 */
export const HISTORY_ALGORITHM_VERSION = 1;

export interface SymbolHistoryProgress {
  /** Coarse phase of the build. */
  phase: 'scan' | 'history' | 'continuity';
  /** Files handled so far (processed + resume-skipped) — monotonic to filesTotal. */
  filesHandled: number;
  /** Total candidate files. */
  filesTotal: number;
  /** Repo-relative path of the file just handled (or '' at phase boundaries). */
  currentFile: string;
  /** Files actually walked this run (excludes resume skips). */
  filesProcessed: number;
  /** Files skipped this run because their resume watermark still matched. */
  filesSkipped: number;
  /** Cumulative commits read this run. */
  commitsProcessed: number;
  /** Cumulative history rows inserted this run. */
  rowsInserted: number;
}

export interface SymbolHistoryOptions {
  /** Cap commits processed per file. Default 200. */
  maxCommitsPerFile?: number;
  /** Cap history-since lookback in seconds. Default no limit. */
  since?: number;
  /** Only re-run if HEAD differs from `git_index_state.last_history_head_sha`. Default true. */
  skipIfHeadUnchanged?: boolean;
  /**
   * When false, ignore per-file resume watermarks and reprocess every file,
   * clearing stale watermarks first. Defaults to the value of
   * `skipIfHeadUnchanged` (so `--force` disables both the HEAD skip and the
   * resume skip — a true full rebuild).
   */
  useResumeWatermarks?: boolean;
  /** Stop after this many files actually processed. Intended for MCP-safe partial builds. */
  maxFiles?: number;
  /** Wall-clock budget for the build. Incomplete runs do not stamp HEAD. */
  deadlineMs?: number;
  /** Timeout for each individual git log command. */
  gitCommandTimeoutMs?: number;
  /** Logger; defaults to stderr. */
  log?: (msg: string) => void;
  /** Per-file progress callback. The module never writes to stdout itself. */
  onProgress?: (p: SymbolHistoryProgress) => void;
}

export interface SymbolHistoryResult {
  completed: boolean;
  filesProcessed: number;
  filesTotal: number;
  filesRemaining: number;
  /** Files skipped this run because their resume watermark still matched. */
  filesSkippedResume: number;
  symbolsProcessed: number;
  historyRowsInserted: number;
  skipped: boolean;
  elapsedMs: number;
  reason?: string;
}

/** Stable fingerprint of the options that affect which/what rows get written.
 *  Part of the resume watermark — if it changes, prior watermarks are ignored. */
function optionsFingerprint(maxCommits: number, since: number | undefined): string {
  return `mc=${maxCommits};since=${since ?? ''}`;
}

export async function buildSymbolHistory(
  repoRoot: string,
  store: Store,
  options: SymbolHistoryOptions = {},
): Promise<SymbolHistoryResult> {
  const start = Date.now();
  const deadlineAt = options.deadlineMs && options.deadlineMs > 0
    ? start + options.deadlineMs
    : Number.POSITIVE_INFINITY;
  let stopReason: string | null = null;
  const log = options.log ?? ((m: string) => process.stderr.write(`[symbol-history] ${m}\n`));
  const done = (
    completed: boolean,
    filesProcessed: number,
    filesTotal: number,
    filesSkippedResume: number,
    symbolsProcessed: number,
    historyRowsInserted: number,
    skipped: boolean,
    reason?: string,
  ): SymbolHistoryResult => ({
    completed,
    filesProcessed,
    filesTotal,
    filesRemaining: Math.max(0, filesTotal - filesProcessed - filesSkippedResume),
    filesSkippedResume,
    symbolsProcessed,
    historyRowsInserted,
    skipped,
    elapsedMs: Date.now() - start,
    ...(reason ? { reason } : {}),
  });
  const deadlineExceeded = (): boolean => Date.now() >= deadlineAt;
  const noteTimeout = (command: string): void => {
    const timeout = options.gitCommandTimeoutMs ?? (Number(process.env.SEER_GIT_TIMEOUT_MS) || 15000);
    stopReason = `${command} timed out after ${timeout}ms`;
  };
  if (!isGitRepo(repoRoot)) {
    log('not a git repo, skipping');
    return done(true, 0, 0, 0, 0, 0, true);
  }
  const head = gitHeadSha(repoRoot);
  const state = store.getGitIndexState();
  // NB: the "HEAD unchanged → skip" decision is deferred until AFTER watermarks
  // are loaded (just before the file loop). A coarse `lastHistoryHeadSha === head`
  // early-return here would wrongly skip a same-HEAD rerun whose options
  // fingerprint (e.g. --max-commits) or file content (edited + reindexed) changed
  // — exactly the cases the per-file watermark exists to catch. We still read
  // `lastHistoryHeadSha` (not the generic `lastHeadSha`) so a prior churn pass
  // can't masquerade as a completed history build.
  const remote = gitRemoteUrl(repoRoot);
  const maxCommits = options.maxCommitsPerFile ?? 200;
  const fingerprint = optionsFingerprint(maxCommits, options.since);
  // `--force` (skipIfHeadUnchanged===false) disables resume too unless a caller
  // overrides explicitly; a forced rebuild then wipes stale watermarks so the
  // next interrupted run resumes against the fresh set.
  const useResume = options.useResumeWatermarks ?? (options.skipIfHeadUnchanged !== false);
  if (!useResume) store.clearSymbolHistoryWatermarks(repoRoot);

  const symbols = store.listSymbolsForHistoryIndex();
  if (symbols.length === 0) {
    return done(true, 0, 0, 0, 0, 0, false);
  }

  // Group symbols by file path so we walk `git log` once per file. Iterate in a
  // deterministic (sorted) order so progress and resume behaviour are stable
  // across runs.
  const byFile = new Map<string, { fileHash: string; symbols: typeof symbols }>();
  for (const s of symbols) {
    let entry = byFile.get(s.filePath);
    if (!entry) { entry = { fileHash: s.fileHash, symbols: [] }; byFile.set(s.filePath, entry); }
    entry.symbols.push(s);
  }
  const fileOrder = Array.from(byFile.keys()).sort();

  const watermarks = useResume ? store.getSymbolHistoryWatermarks(repoRoot) : new Map();

  // Precise no-op fast path (replaces the old coarse HEAD-only early-return):
  // skip the whole build — git work, continuity pass, and re-stamp — only when
  // history was last built against THIS HEAD AND every candidate file's watermark
  // still matches (content hash + options fingerprint + algorithm version). A
  // changed fingerprint or an edited+reindexed file flips a watermark and makes
  // `allCurrent` false, so a same-HEAD rerun that actually needs work falls
  // through to the loop (which still per-file-skips the unchanged files cheaply).
  if (options.skipIfHeadUnchanged !== false && head !== null && state?.lastHistoryHeadSha === head) {
    let allCurrent = true; // fileOrder is non-empty here (symbols.length > 0 above)
    for (const filePath of fileOrder) {
      const wm = watermarks.get(filePath);
      const entry = byFile.get(filePath)!;
      if (!wm || wm.fileHash !== entry.fileHash || wm.optionsFingerprint !== fingerprint
          || wm.algorithmVersion !== HISTORY_ALGORITHM_VERSION) { allCurrent = false; break; }
    }
    if (allCurrent) {
      log(`HEAD ${head.slice(0, 8)} unchanged and all ${byFile.size} files current; skipping`);
      return done(true, 0, byFile.size, byFile.size, symbols.length, 0, true);
    }
  }

  const filesTotal = byFile.size;
  const maxFiles = Math.min(options.maxFiles ?? filesTotal, filesTotal);
  let totalInserts = 0;
  let processedFiles = 0;
  let skippedResume = 0;
  let commitsProcessed = 0;

  const emit = (phase: SymbolHistoryProgress['phase'], currentFile: string): void => {
    options.onProgress?.({
      phase,
      filesHandled: processedFiles + skippedResume,
      filesTotal,
      currentFile,
      filesProcessed: processedFiles,
      filesSkipped: skippedResume,
      commitsProcessed,
      rowsInserted: totalInserts,
    });
  };
  emit('scan', '');

  for (const filePath of fileOrder) {
    const { fileHash, symbols: fileSymbols } = byFile.get(filePath)!;
    if (deadlineExceeded()) {
      stopReason = `deadline exceeded after ${options.deadlineMs}ms`;
      break;
    }
    // Resume skip: a watermark whose file content, options fingerprint, AND
    // algorithm version all still match proves this file's rows would be
    // recomputed identically — safe to skip without git work. (See the
    // symbol_history_progress schema comment for why HEAD is not the key.)
    const wm = watermarks.get(filePath);
    if (wm && wm.fileHash === fileHash && wm.optionsFingerprint === fingerprint
        && wm.algorithmVersion === HISTORY_ALGORITHM_VERSION) {
      skippedResume++;
      emit('history', relOf(repoRoot, filePath));
      continue;
    }
    if (processedFiles >= maxFiles) {
      stopReason = `stopped after maxFiles=${maxFiles}`;
      break;
    }
    processedFiles++;

    // One subprocess: commits touching this file AND their diffs, newest first.
    const commits = await commitsWithDiffsForFile(repoRoot, filePath, {
      limit: maxCommits,
      since: options.since,
      timeoutMs: options.gitCommandTimeoutMs,
      onTimeout: noteTimeout,
      assumeRepo: true,
    });
    if (stopReason) break;

    const fileRows: SymbolHistoryInsert[] = [];
    let fileComplete = true;
    for (const c of commits) {
      if (deadlineExceeded()) {
        stopReason = `deadline exceeded after ${options.deadlineMs}ms`;
        fileComplete = false;
        break;
      }
      commitsProcessed++;
      if (c.hunks.length === 0 && !c.isFileAddition) continue;
      const totalAdded = c.hunks.reduce((acc, h) => acc + h.newLines, 0);
      const totalRemoved = c.hunks.reduce((acc, h) => acc + h.oldLines, 0);
      const prNum = extractPrNumber(c.message);
      const prUrl = prNum != null ? githubPrUrl(remote, prNum) : null;
      const ageDays = Math.max(0, (Date.now() / 1000 - c.committedAt) / 86400);
      // Confidence: 1.0 for recent commits, decays with age but never below 0.3.
      const confidence = Math.max(0.3, 1.0 - Math.min(0.7, ageDays / 365 * 0.1));
      for (const sym of fileSymbols) {
        // The current symbol's line span is in the HEAD file. As commits get
        // older, line numbers drift — so we accept any overlap in any commit
        // as "this commit touched the line range that now holds this symbol".
        //
        // Special case: if this commit added the file (isFileAddition), the
        // pre-commit state had no symbols at all — every current symbol got its
        // initial existence from this commit, so attribute all of them
        // regardless of hunk position. match_strategy 'file-addition' tells the
        // caller apart "this commit created the file" from "this commit
        // overlapped the symbol".
        const symStart = sym.lineStart + 1; // git is 1-indexed
        const symEnd = sym.lineEnd + 1;
        let strategy: 'overlap' | 'file-addition';
        if (c.isFileAddition) {
          strategy = 'file-addition';
        } else {
          const overlaps = c.hunks.some(h => {
            const hStart = h.newStart;
            const hEnd = h.newStart + Math.max(0, h.newLines - 1);
            return hStart <= symEnd && hEnd >= symStart;
          });
          if (!overlaps) continue;
          strategy = 'overlap';
        }
        fileRows.push({
          symbolId: sym.id, symbolKey: sym.symbolKey, commitSha: c.sha,
          authorName: c.authorName, authorEmail: c.authorEmail,
          committedAt: c.committedAt, message: c.message,
          linesAdded: totalAdded, linesRemoved: totalRemoved,
          prNumber: prNum, prUrl,
          matchStrategy: strategy, confidence,
        });
      }
    }

    // Flush this file's rows in one transaction. Even a partial (deadline-cut)
    // batch is safe to write — INSERT OR IGNORE dedupes on the next run. We only
    // stamp the watermark when the file finished, so an interrupted file is
    // reprocessed (and completed) next time rather than wrongly skipped.
    const inserted = store.insertSymbolHistoryBatch(fileRows);
    totalInserts += inserted;
    if (fileComplete && !stopReason) {
      // Record the ACTUAL inserted count (INSERT OR IGNORE may drop duplicates on
      // a rerun / duplicate-heavy file), not the attempted row count.
      store.upsertSymbolHistoryWatermark(
        repoRoot, filePath, fileHash, fingerprint, HISTORY_ALGORITHM_VERSION, head, inserted,
      );
    }
    emit('history', relOf(repoRoot, filePath));
    if (stopReason) break;
  }

  if (stopReason) {
    log(`partial: ${processedFiles}/${filesTotal} files (${skippedResume} resume-skipped), ${totalInserts} history rows (${stopReason})`);
    return done(false, processedFiles, filesTotal, skippedResume, symbols.length, totalInserts, false, stopReason);
  }

  // v10 — run the continuity heuristics for symbols whose recorded history is
  // shallow. Strictly additive (lives in symbol_history_continuity); never
  // touches symbol_history rows.
  try {
    if (store.hasV10()) {
      emit('continuity', '');
      const cont = buildContinuity(store, { historyThreshold: 1 });
      log(`continuity: considered=${cont.candidatesConsidered}, inserted=${cont.inserted}, skipped=${cont.skipped}`);
    }
  } catch (err) {
    log(`continuity pass failed: ${(err as Error).message}`);
  }

  // Stamp the history-specific HEAD marker (not the generic one) so a future
  // run can skip this work without colliding with file-level churn's stamp.
  store.setHistoryHeadSha(repoRoot, head, remote);
  log(`done: ${processedFiles} files processed, ${skippedResume} resume-skipped, ${totalInserts} history rows`);
  return done(true, processedFiles, filesTotal, skippedResume, symbols.length, totalInserts, false);
}

/** repo-relative, forward-slash path for progress labels. */
function relOf(repoRoot: string, abs: string): string {
  const r = abs.startsWith(repoRoot) ? abs.slice(repoRoot.length) : abs;
  return r.replace(/^[\\/]+/, '').replace(/\\/g, '/');
}
