import os from 'os';
import path from 'path';
import { Store } from '../db/store.js';
import {
  commitsWithDiffsForFile, commitsWithDiffsForFileNoWalk, nameOnlyHistory,
  normalizeRepoRelPath, isGitRepo, isShallowRepo, gitHeadSha, gitRemoteUrl,
  extractPrNumber, githubPrUrl,
} from './git.js';
import { buildContinuity } from './continuity.js';
import { profileStart, profileReport, profileEnabled } from './profile.js';
import type { SymbolHistoryInsert } from '../types.js';

/**
 * Symbol-history pass — for every indexed function/method/constructor/class
 * symbol, walk the commits that touched its file and record the ones whose
 * diff hunks overlap the symbol's current line span.
 *
 * Performance (see SYMBOL_HISTORY_PERF_PLAN.md):
 *   - One `git log -U0 -p` subprocess per file (combined log+patch) instead of
 *     one `git log` plus one `git show` per commit. Spawns drop from ~F*C to F.
 *   - The per-file walks run through a bounded concurrency pool (B1): N git
 *     subprocesses are in flight at once (N = `concurrency`, default ~CPU count).
 *     Git spawns are I/O-bound and independent, so this is near-linear on the
 *     spawn-bound portion. ALL SQLite writes still happen on the single main
 *     thread — JS is single-threaded and each write section is synchronous, so
 *     concurrent lanes' writes serialize naturally (SQLite is single-writer).
 *   - `--follow` is OFF by default (B2): it re-runs rename detection at every
 *     step and is the most expensive common log flag. The continuity pass bridges
 *     rename boundaries instead. Pass `follow: true` for unbroken raw rename
 *     chains. The `follow` choice is part of the options fingerprint, so toggling
 *     it invalidates watermarks and reprocesses cleanly.
 *   - The repo is validated once; per-file helpers run with assumeRepo so they
 *     don't re-spawn `git rev-parse` on every call.
 *   - Each file's rows are written DELETE-then-INSERT in one transaction
 *     (replaceSymbolHistoryForSymbols) so a reprocess yields exactly the current
 *     set, never a stale union.
 *   - A per-file resume watermark (symbol_history_progress) lets an interrupted
 *     or budgeted build skip already-finished files on the next run, and makes a
 *     HEAD-moved rerun reprocess only files whose content changed (incremental
 *     auto-update — see `onlyPaths` for the scoped/on-demand entry point).
 *   - Progress is reported through `onProgress` so the CLI can render a bar; the
 *     module itself never writes to stdout.
 *
 * Limitations (documented honestly):
 *   - Renames within a file: we do NOT reparse historical file versions, so
 *     a function rename will appear as "history starts here" at the rename
 *     commit. The symbol_key column captures `kind:qualified_name` so a
 *     future enhancement (key-match on historical AST parse) could recover
 *     pre-rename history without touching this schema.
 *   - File renames: by default (`follow:false`) a file rename cuts off raw
 *     history at the rename commit ("history starts here"); the continuity pass
 *     bridges the boundary with shape-hash evidence. Pass `follow:true` to thread
 *     raw rows through file renames at a per-file cost. Cross-file moves are not
 *     followed in either mode. A PURE rename (file moved with no content change)
 *     contributes no history row in either mode.
 *   - Line numbers shift across history. We compare a commit's hunks against
 *     the current symbol's line range — older overlaps are approximate.
 *     match_strategy = 'overlap' / confidence < 1.0 reflect that.
 */

/**
 * Bump when the matching semantics change (overlap rule, confidence formula,
 * file-addition handling, candidate symbol kinds). It is part of every resume
 * watermark, so a bump invalidates stale watermarks and forces a rebuild.
 *   - v1: original `--follow`-always overlap matcher.
 *   - v2: `--follow` is opt-out (default off) and per-file writes are
 *     DELETE-then-INSERT. The default no-follow output differs from v1 at file
 *     renames, so this is a real semantic change, not just a refactor.
 *
 * v2 is the PER-FILE path's version (scoped builds, follow:true, and the
 * legacy fallback). It uses `git log -- <file>`, which applies git's per-path
 * history simplification.
 */
export const HISTORY_ALGORITHM_VERSION = 2;

/**
 * The two-phase path's version (full, unscoped, follow:false builds). It learns
 * each file's commits from ONE whole-repo `git log --name-only` walk, which does
 * NOT apply per-path history simplification — so it attributes a few extra,
 * legitimate commits that `git log -- <file>` simplifies away (measured ~+0.8%
 * rows on Godot; strictly a superset-leaning, more-complete view). Because the
 * rows differ from the per-file path, the watermark version is path-aware: a
 * two-phase build only resume-skips files a prior two-phase build wrote, and a
 * per-file build only skips per-file watermarks, so the two never cross-claim
 * each other's rows as current.
 */
export const HISTORY_ALGORITHM_VERSION_TWOPHASE = 3;

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
  /**
   * Thread `git log --follow` through file renames in the RAW history (B2).
   * Default false: the walk stops at a file's rename boundary and the continuity
   * pass bridges it. Set true for unbroken raw rename chains at a per-file cost.
   * Part of the options fingerprint, so toggling it reprocesses cleanly.
   */
  follow?: boolean;
  /**
   * Number of per-file `git log` walks in flight at once (B1). Defaults to the
   * CPU count (clamped to [1, 16]); env SEER_HISTORY_CONCURRENCY overrides.
   * Writes always stay on the main thread regardless of this value.
   */
  concurrency?: number;
  /**
   * Scope the build to just these files (absolute or repo-relative paths). When
   * set, this is a SCOPED / on-demand build: it processes only the requested
   * files, does NOT stamp the global history HEAD (so the index is not falsely
   * marked fully-built), and SKIPS the global continuity pass. Per-file
   * watermarks are still written, so a later full build reuses the work for free.
   * This is the agent's cheap "history of one symbol" path.
   */
  onlyPaths?: string[];
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

/**
 * Parse a `--since` history horizon into a unix-seconds lower bound, or
 * `undefined` for "unbounded" (the default). Accepts, case-insensitively:
 *   - `''` / `0` / `all` / `none` / `unbounded`            → undefined
 *   - a bare integer                                       → unix seconds (absolute)
 *   - an ISO date (`2024-01-01`, `2024-01-01T00:00:00Z`)   → that instant
 *   - a relative duration: `<n><unit>` where unit ∈
 *     y/yr/yrs/year(s), mo/month(s), w/week(s), d/day(s)   → now − n·unit
 *
 * Relative durations resolve against `now` AT CALL TIME and are quantized to
 * UTC-midnight so repeated explicit builds within the same day produce an
 * identical bound (and therefore an identical options fingerprint). The
 * resolved absolute value is what gets persisted + replicated, so the horizon
 * does not silently drift on every incremental refresh.
 *
 * Returns `null` when the input can't be parsed, so callers can warn rather
 * than silently treat a typo as unbounded.
 */
export function parseHistorySince(
  raw: string | undefined | null, now: number = Date.now(),
): number | undefined | null {
  if (raw == null) return undefined;
  const s = raw.trim().toLowerCase();
  if (s === '' || s === '0' || s === 'all' || s === 'none' || s === 'unbounded') return undefined;
  const nowSec = Math.floor(now / 1000);
  const DAY = 86400;
  // Number, then an optional whitespace/dot separator, then a unit word. The
  // dot separator also accepts git's own `2.years` spelling so a copied git
  // `--since` value parses the same way.
  const dur = /^(\d+(?:\.\d+)?)[\s.]*(y|yr|yrs|year|years|mo|month|months|w|week|weeks|d|day|days)$/.exec(s);
  if (dur) {
    const n = parseFloat(dur[1]);
    const unit = dur[2];
    const days = unit.startsWith('y') ? n * 365.25
      : unit.startsWith('mo') || unit === 'month' || unit === 'months' ? n * 30.4375
      : unit.startsWith('w') ? n * 7
      : n;
    // Quantize to UTC midnight so same-day reruns share a bound.
    const bound = nowSec - Math.round(days * DAY);
    return bound - (bound % DAY);
  }
  if (/^\d+$/.test(s)) return parseInt(s, 10); // bare unix seconds
  const ms = Date.parse(raw.trim());
  if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  return null; // unparseable
}

/** Resolve the effective per-file walk concurrency (B1). */
function resolveConcurrency(opt: number | undefined): number {
  const env = Number(process.env.SEER_HISTORY_CONCURRENCY);
  const raw = (opt && opt > 0) ? opt
    : (Number.isFinite(env) && env > 0) ? env
    : (os.cpus()?.length || 4);
  return Math.max(1, Math.min(16, Math.floor(raw)));
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
  /** True when the repo is a shallow clone (little/no history available). */
  shallow?: boolean;
  /**
   * Set when the build did real work (processed files) but inserted 0 history
   * rows — usually a shallow/zip checkout, or files not tracked by the resolved
   * git repo. Surfaces the likely cause instead of an unexplained empty history.
   */
  diagnostic?: string;
}

/** Stable fingerprint of the options that affect which/what rows get written.
 *  Part of the resume watermark — if it changes, prior watermarks are ignored.
 *  `follow` is included because it changes which commits attribute to a symbol
 *  at rename boundaries, so flipping it must reprocess. */
function optionsFingerprint(maxCommits: number, since: number | undefined, follow: boolean): string {
  return `mc=${maxCommits};since=${since ?? ''};follow=${follow ? 1 : 0}`;
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
  const shallow = isGitRepo(repoRoot) && isShallowRepo(repoRoot);
  const done = (
    completed: boolean,
    filesProcessed: number,
    filesTotal: number,
    filesSkippedResume: number,
    symbolsProcessed: number,
    historyRowsInserted: number,
    skipped: boolean,
    reason?: string,
  ): SymbolHistoryResult => {
    // Explain a "did work but found nothing" outcome rather than leaving the
    // agent staring at historyRowsInserted: 0 (the Godot-audit confusion).
    let diagnostic: string | undefined;
    if (!skipped && filesProcessed > 0 && historyRowsInserted === 0) {
      diagnostic = shallow
        ? 'Processed files but inserted 0 history rows: this is a SHALLOW git clone (git clone --depth N), which carries almost no commit history. Re-clone with full history (git fetch --unshallow) to build symbol history.'
        : 'Processed files but inserted 0 history rows. Likely causes: the workspace is a zip/snapshot download with no .git, the files are not tracked by the resolved git repo (e.g. a sub-directory inside a different repo), or git history does not overlap current symbol line ranges. Confirm `git -C <workspace> log -- <a source file>` returns commits.';
    }
    return {
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
      ...(shallow ? { shallow: true } : {}),
      ...(diagnostic ? { diagnostic } : {}),
    };
  };
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
  const follow = options.follow === true;
  const concurrency = resolveConcurrency(options.concurrency);
  const fingerprint = optionsFingerprint(maxCommits, options.since, follow);

  // Scoped / on-demand build (Thrust A): restrict to the requested files, don't
  // touch the global HEAD stamp, and skip the global continuity pass. `onlyPaths`
  // may be absolute or repo-relative; normalize to the absolute keys the symbol
  // table uses so the IN-filter matches.
  const scoped = Array.isArray(options.onlyPaths) && options.onlyPaths.length > 0;
  // Pass BOTH the raw inputs (which may be repo-relative) and their absolute
  // resolution. The store matches case/separator-insensitively against either
  // f.path or f.rel_path, so a relative path, an absolute path, or a Windows
  // drive letter whose case differs from the indexed value all resolve to the
  // right files. (Resolving to absolute only, then exact-matching f.path, used
  // to miss on Windows because `path.resolve` upper-cases the drive letter while
  // the index stored it lower-case — yielding 0 files and 0 history rows.)
  const scopedPathHints = scoped
    ? Array.from(new Set([
        ...options.onlyPaths!,
        ...options.onlyPaths!.map(p => (path.isAbsolute(p) ? p : path.resolve(repoRoot, p))),
      ]))
    : [];

  // Two-phase eligibility is a pure function of the request (full + follow:false
  // + not forced legacy); whether it actually ACTIVATES also depends on phase-1
  // succeeding, decided below. The watermark version is path-aware: the no-op
  // fast path checks against the version the eligible path WOULD write, so an
  // eligible rerun whose files already carry two-phase (v3) watermarks can skip
  // without even running phase-1.
  const twoPhaseEligible = !scoped && !follow && process.env.SEER_HISTORY_LEGACY !== '1';
  const eligibleAlgoVersion = twoPhaseEligible
    ? HISTORY_ALGORITHM_VERSION_TWOPHASE : HISTORY_ALGORITHM_VERSION;

  // `--force` (skipIfHeadUnchanged===false) disables resume too unless a caller
  // overrides explicitly; a forced rebuild then wipes stale watermarks so the
  // next interrupted run resumes against the fresh set. A scoped build never
  // force-clears the whole repo's watermarks (it isn't the whole repo).
  const useResume = options.useResumeWatermarks ?? (options.skipIfHeadUnchanged !== false);
  if (!useResume && !scoped) store.clearSymbolHistoryWatermarks(repoRoot);

  const symbols = scoped
    ? store.listSymbolsForHistoryIndexForFiles(scopedPathHints)
    : store.listSymbolsForHistoryIndex();
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
  if (!scoped && options.skipIfHeadUnchanged !== false && head !== null && state?.lastHistoryHeadSha === head) {
    let allCurrent = true; // fileOrder is non-empty here (symbols.length > 0 above)
    for (const filePath of fileOrder) {
      const wm = watermarks.get(filePath);
      const entry = byFile.get(filePath)!;
      if (!wm || wm.fileHash !== entry.fileHash || wm.optionsFingerprint !== fingerprint
          || wm.algorithmVersion !== eligibleAlgoVersion) { allCurrent = false; break; }
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

  // ── Two-phase walk (Part 2 #B) ─────────────────────────────────────────────
  // For a full (unscoped), follow:false build we replace F independent per-file
  // DAG walks with ONE shared `git log --name-only` walk that tells us exactly
  // which commits touched each file, then diff only those commits per file with
  // `--no-walk` (no DAG traversal). Scoped builds stay on the per-file path (a
  // handful of files — the shared walk wouldn't pay for itself), and follow:true
  // stays on the per-file path because a whole-repo name-only pass cannot
  // reproduce per-file `--follow` rename threading. `SEER_HISTORY_LEGACY=1`
  // forces the per-file path as an escape hatch. A phase-1 failure (timeout)
  // returns null and we transparently fall back to the per-file path, so history
  // is never silently dropped. (`twoPhaseEligible` / `eligibleAlgoVersion` were
  // computed earlier so the no-op fast path could use the right version.)
  //
  // Key an absolute indexed path to the same normalized repo-relative form git's
  // --name-only output uses. path.relative (not a naive prefix strip) so mixed
  // separators / drive-letter case between repoRoot and the stored absolute path
  // don't cause a miss — the exact bug that made an early build emit 0 rows.
  const relKey = (abs: string): string => normalizeRepoRelPath(path.relative(repoRoot, abs));
  let fileToShas: Map<string, string[]> | null = null;
  if (twoPhaseEligible) {
    const fileFilter = new Set<string>();
    for (const abs of fileOrder) fileFilter.add(relKey(abs));
    fileToShas = await nameOnlyHistory(repoRoot, {
      fileFilter,
      maxCommitsPerFile: maxCommits,
      since: options.since,
      // Phase-1 is ONE whole-repo walk; give it a generous floor (the per-file
      // git timeout is sized for a single file's history, not the whole DAG).
      timeoutMs: Math.max(options.gitCommandTimeoutMs ?? 0, 120_000),
      onTimeout: (cmd) => noteTimeout(cmd),
    });
    if (fileToShas === null) {
      log('two-phase name-only walk failed; falling back to per-file walks');
      stopReason = null; // a phase-1 timeout must NOT abort the build
    }
  }
  // The version THIS run will stamp: two-phase only when it actually activated
  // (eligible AND phase-1 produced a map). A fallback writes the per-file version
  // so its (simplified) rows are never mistaken for two-phase output next run.
  const twoPhaseActive = twoPhaseEligible && fileToShas !== null;
  const runAlgoVersion = twoPhaseActive
    ? HISTORY_ALGORITHM_VERSION_TWOPHASE : HISTORY_ALGORITHM_VERSION;

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

  // Compute one file's history rows from its commit walk. Pure (no DB writes,
  // no shared-state mutation beyond the returned values), so it is safe to run
  // many of these concurrently — the writes happen back on the main lane.
  const computeFileRows = (
    fileSymbols: typeof symbols, commits: Awaited<ReturnType<typeof commitsWithDiffsForFile>>,
  ): { rows: SymbolHistoryInsert[]; commitsCounted: number; complete: boolean } => {
    const fileRows: SymbolHistoryInsert[] = [];
    let counted = 0;
    let complete = true;
    for (const c of commits) {
      if (deadlineExceeded()) { complete = false; break; }
      counted++;
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
    return { rows: fileRows, commitsCounted: counted, complete };
  };

  // Synchronously claim the next file that actually needs git work. This walks
  // past resume-skips (counting them) and enforces the maxFiles cap. Because it
  // contains no `await`, lanes can't interleave inside it, so processedFiles /
  // the cursor stay consistent and maxFiles stays exact under concurrency.
  let cursor = 0;
  const claimNext = (): { filePath: string; fileHash: string; fileSymbols: typeof symbols } | null => {
    while (cursor < fileOrder.length) {
      if (stopReason) return null;
      if (deadlineExceeded()) {
        stopReason = `deadline exceeded after ${options.deadlineMs}ms`;
        return null;
      }
      const filePath = fileOrder[cursor++];
      const { fileHash, symbols: fileSymbols } = byFile.get(filePath)!;
      // Resume skip: a watermark whose file content, options fingerprint, AND
      // algorithm version all still match proves this file's rows would be
      // recomputed identically — safe to skip without git work. (See the
      // symbol_history_progress schema comment for why HEAD is not the key.)
      const wm = watermarks.get(filePath);
      if (wm && wm.fileHash === fileHash && wm.optionsFingerprint === fingerprint
          && wm.algorithmVersion === runAlgoVersion) {
        skippedResume++;
        emit('history', relOf(repoRoot, filePath));
        continue;
      }
      if (processedFiles >= maxFiles) {
        stopReason = `stopped after maxFiles=${maxFiles}`;
        return null;
      }
      processedFiles++;
      return { filePath, fileHash, fileSymbols };
    }
    return null;
  };

  // One lane: claim → git walk (concurrent) → write (serialized on the main
  // thread). The git walk is the only awaited step, so up to `concurrency`
  // subprocesses run at once while writes stay single-threaded.
  const lane = async (): Promise<void> => {
    for (;;) {
      const job = claimNext();
      if (!job) return;
      // Detect THIS file's git timeout locally: a sibling lane's stop (maxFiles
      // or its own deadline) must not be mistaken for this file failing.
      let timedOut = false;
      let commits;
      if (fileToShas !== null) {
        // Two-phase: diff only the commits phase-1 said touched this file — no
        // DAG walk. A file with zero in-window commits gets an empty list, which
        // computeFileRows turns into 0 rows + a 0-row watermark (so it is never
        // reconsidered until its content changes).
        const shas = fileToShas.get(relKey(job.filePath)) ?? [];
        const endGit = profileStart('git log --no-walk diff (two-phase)');
        commits = shas.length === 0 ? [] : await commitsWithDiffsForFileNoWalk(repoRoot, job.filePath, shas, {
          timeoutMs: options.gitCommandTimeoutMs,
          onTimeout: (cmd) => { noteTimeout(cmd); timedOut = true; },
        });
        endGit();
      } else {
        const endGit = profileStart('git log -p walk (subprocess)');
        commits = await commitsWithDiffsForFile(repoRoot, job.filePath, {
          limit: maxCommits,
          since: options.since,
          timeoutMs: options.gitCommandTimeoutMs,
          onTimeout: (cmd) => { noteTimeout(cmd); timedOut = true; },
          assumeRepo: true,
          follow,
        });
        endGit();
      }
      // This file's own walk timed out — leave it unwatermarked so the next run
      // reprocesses it. noteTimeout already set the global stopReason.
      if (timedOut) return;
      const endCompute = profileStart('computeFileRows (overlap match)');
      const { rows, commitsCounted, complete } = computeFileRows(job.fileSymbols, commits);
      endCompute();
      commitsProcessed += commitsCounted;
      // DELETE-then-INSERT in one transaction so a reprocess (option change,
      // algo bump, force) yields exactly the current set. Synchronous, so
      // concurrent lanes' writes serialize naturally.
      const endWrite = profileStart('replaceSymbolHistory (db write)');
      const inserted = store.replaceSymbolHistoryForSymbols(job.fileSymbols.map(s => s.id), rows);
      endWrite();
      totalInserts += inserted;
      // Stamp on PER-FILE completion, independent of the global stopReason: a
      // file that fully walked its commits is done even if a sibling lane has
      // since hit maxFiles/deadline. `complete` is only false when THIS file's
      // commit loop was cut mid-way by the deadline.
      if (complete) {
        store.upsertSymbolHistoryWatermark(
          repoRoot, job.filePath, job.fileHash, fingerprint, runAlgoVersion, head, inserted,
        );
      }
      emit('history', relOf(repoRoot, job.filePath));
      if (stopReason) return;
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, filesTotal)) }, () => lane()));

  if (profileEnabled()) profileReport('symbol-history');

  if (stopReason) {
    log(`partial: ${processedFiles}/${filesTotal} files (${skippedResume} resume-skipped), ${totalInserts} history rows (${stopReason})`);
    return done(false, processedFiles, filesTotal, skippedResume, symbols.length, totalInserts, false, stopReason);
  }

  // A scoped (on-demand) build is intentionally partial: it only touched the
  // requested files, so it must NOT run the global continuity pass and must NOT
  // stamp the global history HEAD (that would falsely mark the whole repo built).
  // Per-file watermarks were still written, so a later full build reuses them.
  if (scoped) {
    log(`scoped: ${processedFiles} files processed, ${skippedResume} resume-skipped, ${totalInserts} history rows`);
    return done(true, processedFiles, filesTotal, skippedResume, symbols.length, totalInserts, false);
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
  // Persist the resolved --since horizon too so the incremental post-index
  // refresh replicates the SAME absolute bound (stable options fingerprint).
  store.setHistoryHeadSha(repoRoot, head, remote, options.follow ?? false, options.since ?? null);
  log(`done: ${processedFiles} files processed, ${skippedResume} resume-skipped, ${totalInserts} history rows`);
  return done(true, processedFiles, filesTotal, skippedResume, symbols.length, totalInserts, false);
}

/** repo-relative, forward-slash path for progress labels. */
function relOf(repoRoot: string, abs: string): string {
  const r = abs.startsWith(repoRoot) ? abs.slice(repoRoot.length) : abs;
  return r.replace(/^[\\/]+/, '').replace(/\\/g, '/');
}
