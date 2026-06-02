import { Store } from '../db/store.js';
import {
  commitsForFile, fileDiffInfo, isGitRepo, gitHeadSha, gitRemoteUrl,
  extractPrNumber, githubPrUrl,
} from './git.js';
import { buildContinuity } from './continuity.js';

/**
 * Symbol-history pass — for every indexed function/method/constructor/class
 * symbol, walk the commits that touched its file and record the ones whose
 * diff hunks overlap the symbol's current line span.
 *
 * Limitations (documented honestly):
 *   - Renames within a file: we do NOT reparse historical file versions, so
 *     a function rename will appear as "history starts here" at the rename
 *     commit. The symbol_key column captures `kind:qualified_name` so a
 *     future enhancement (key-match on historical AST parse) could recover
 *     pre-rename history without touching this schema.
 *   - File renames: `git log --follow` is used per-file so file renames
 *     ARE preserved; but cross-file moves are not.
 *   - Line numbers shift across history. We compare a commit's hunks against
 *     the current symbol's line range — older overlaps are approximate.
 *     match_strategy = 'overlap' / confidence < 1.0 reflect that.
 *
 * Performance: bounded by `maxCommitsPerFile` (default 200) and per-call
 * timeout. For a 10k-symbol codebase this runs in ~1-2 min once; afterwards
 * the `git_index_state` lets us short-circuit if HEAD is unchanged.
 */

export interface SymbolHistoryOptions {
  /** Cap commits processed per file. Default 200. */
  maxCommitsPerFile?: number;
  /** Cap history-since lookback in seconds. Default no limit. */
  since?: number;
  /** Only re-run if HEAD differs from `git_index_state.last_head_sha`. Default true. */
  skipIfHeadUnchanged?: boolean;
  /** Stop after this many files. Intended for MCP-safe partial builds. */
  maxFiles?: number;
  /** Wall-clock budget for the build. Incomplete runs do not stamp HEAD. */
  deadlineMs?: number;
  /** Timeout for each individual git log/show command. */
  gitCommandTimeoutMs?: number;
  /** Logger; defaults to stderr. */
  log?: (msg: string) => void;
}

export interface SymbolHistoryResult {
  completed: boolean;
  filesProcessed: number;
  filesTotal: number;
  filesRemaining: number;
  symbolsProcessed: number;
  historyRowsInserted: number;
  skipped: boolean;
  elapsedMs: number;
  reason?: string;
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
    symbolsProcessed: number,
    historyRowsInserted: number,
    skipped: boolean,
    reason?: string,
  ): SymbolHistoryResult => ({
    completed,
    filesProcessed,
    filesTotal,
    filesRemaining: Math.max(0, filesTotal - filesProcessed),
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
    return done(true, 0, 0, 0, 0, true);
  }
  const head = gitHeadSha(repoRoot);
  const state = store.getGitIndexState();
  // Skip only if symbol-history specifically has already been built against
  // this HEAD. Reading `lastHistoryHeadSha` instead of the generic
  // `lastHeadSha` means a previous file-level churn pass (which also stamps
  // git_index_state) can't trick us into skipping when history was never
  // actually built.
  if (options.skipIfHeadUnchanged !== false && state && state.lastHistoryHeadSha === head && head !== null) {
    log(`HEAD ${head?.slice(0, 8)} unchanged; skipping`);
    return done(true, 0, 0, 0, 0, true);
  }
  const remote = gitRemoteUrl(repoRoot);
  const maxCommits = options.maxCommitsPerFile ?? 200;
  const symbols = store.listSymbolsForHistoryIndex();
  if (symbols.length === 0) {
    return done(true, 0, 0, 0, 0, false);
  }

  // Group symbols by file path so we walk `git log` once per file.
  const byFile = new Map<string, typeof symbols>();
  for (const s of symbols) {
    let arr = byFile.get(s.filePath);
    if (!arr) { arr = []; byFile.set(s.filePath, arr); }
    arr.push(s);
  }

  const filesTotal = byFile.size;
  const maxFiles = Math.min(options.maxFiles ?? filesTotal, filesTotal);
  let totalInserts = 0;
  let processedFiles = 0;
  for (const [filePath, fileSymbols] of byFile) {
    if (processedFiles >= maxFiles) {
      stopReason = `stopped after maxFiles=${maxFiles}`;
      break;
    }
    if (deadlineExceeded()) {
      stopReason = `deadline exceeded after ${options.deadlineMs}ms`;
      break;
    }
    processedFiles++;
    const commits = await commitsForFile(repoRoot, filePath, {
      limit: maxCommits,
      since: options.since,
      timeoutMs: options.gitCommandTimeoutMs,
      onTimeout: noteTimeout,
    });
    if (stopReason) break;
    if (commits.length === 0) continue;
    // For each commit, fetch its diff hunks (in the new-file coordinate
    // space). A symbol whose [line_start..line_end] range overlaps any hunk
    // is considered touched.
    for (let i = 0; i < commits.length; i++) {
      if (deadlineExceeded()) {
        stopReason = `deadline exceeded after ${options.deadlineMs}ms`;
        break;
      }
      const c = commits[i];
      // Use the per-commit path resolved from `git log --follow --name-status`.
      // If that wasn't available (older git or no rename detected), fall back
      // to the current path — that's correct for commits where the file
      // hadn't been renamed.
      const lookupPath = c.pathAtCommit ?? filePath;
      const info = await fileDiffInfo(repoRoot, c.sha, lookupPath, {
        timeoutMs: options.gitCommandTimeoutMs,
        onTimeout: noteTimeout,
      });
      if (stopReason) break;
      if (info.hunks.length === 0 && !info.isFileAddition) continue;
      const totalAdded = info.hunks.reduce((acc, h) => acc + h.newLines, 0);
      const totalRemoved = info.hunks.reduce((acc, h) => acc + h.oldLines, 0);
      const prNum = extractPrNumber(c.message);
      const prUrl = prNum != null ? githubPrUrl(remote, prNum) : null;
      for (const sym of fileSymbols) {
        // The current symbol's line span is in the HEAD file. As commits get
        // older, line numbers drift — so we accept any overlap in any commit
        // as "this commit touched the line range that now holds this symbol".
        // confidence drops with commit age to flag the drift.
        //
        // Special case: if this commit added the file (isFileAddition), the
        // pre-commit state had no symbols at all — every current symbol
        // got its initial existence from this commit, so attribute all of
        // them regardless of where the hunk lines up. Match strategy
        // 'file-addition' so the caller can tell apart "this commit
        // created the file" from "this commit overlapped the symbol".
        const symStart = sym.lineStart + 1; // git is 1-indexed
        const symEnd = sym.lineEnd + 1;
        let strategy: 'overlap' | 'file-addition';
        if (info.isFileAddition) {
          strategy = 'file-addition';
        } else {
          const overlaps = info.hunks.some(h => {
            const hStart = h.newStart;
            const hEnd = h.newStart + Math.max(0, h.newLines - 1);
            return hStart <= symEnd && hEnd >= symStart;
          });
          if (!overlaps) continue;
          strategy = 'overlap';
        }
        const ageDays = Math.max(0, (Date.now() / 1000 - c.committedAt) / 86400);
        // Confidence: 1.0 for HEAD..HEAD~1, decays with age but never below 0.3.
        const confidence = Math.max(0.3, 1.0 - Math.min(0.7, ageDays / 365 * 0.1));
        store.insertSymbolHistory(
          sym.id, sym.symbolKey, c.sha,
          c.authorName, c.authorEmail, c.committedAt, c.message,
          totalAdded, totalRemoved,
          prNum, prUrl,
          strategy, confidence,
        );
        totalInserts++;
      }
    }
    if (stopReason) break;
  }

  if (stopReason) {
    log(`partial: ${processedFiles}/${filesTotal} files, ${totalInserts} history rows (${stopReason})`);
    return done(false, processedFiles, filesTotal, symbols.length, totalInserts, false, stopReason);
  }

  // v10 — run the continuity heuristics for symbols whose recorded history is
  // shallow. Strictly additive (lives in symbol_history_continuity); never
  // touches symbol_history rows.
  try {
    if (store.hasV10()) {
      const cont = buildContinuity(store, { historyThreshold: 1 });
      log(`continuity: considered=${cont.candidatesConsidered}, inserted=${cont.inserted}, skipped=${cont.skipped}`);
    }
  } catch (err) {
    log(`continuity pass failed: ${(err as Error).message}`);
  }

  // Stamp the history-specific HEAD marker (not the generic one) so a future
  // run can skip this work without colliding with file-level churn's stamp.
  store.setHistoryHeadSha(repoRoot, head, remote);
  log(`done: ${processedFiles} files, ${totalInserts} history rows`);
  return {
    completed: true,
    filesProcessed: processedFiles,
    filesTotal,
    filesRemaining: 0,
    symbolsProcessed: symbols.length,
    historyRowsInserted: totalInserts,
    skipped: false,
    elapsedMs: Date.now() - start,
  };
}
