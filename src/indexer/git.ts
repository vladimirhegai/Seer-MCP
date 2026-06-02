import path from 'path';
import fs from 'fs';
import { spawn, spawnSync } from 'child_process';

/**
 * Thin async wrapper around `git` so the rest of the indexer doesn't deal
 * with child_process directly. All commands run with `cwd = repoRoot`.
 *
 * Errors are surfaced as `null` returns (not throws) so a non-git workspace
 * silently no-ops. Callers should check the return value.
 */

const DEFAULT_GIT_TIMEOUT_MS = 15_000;

function gitTimeoutMs(override?: number): number {
  if (override != null && Number.isFinite(override) && override > 0) return override;
  const raw = Number(process.env.SEER_GIT_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_GIT_TIMEOUT_MS;
}

function syncOpts(timeoutMs?: number): { encoding: 'utf8'; timeout: number; windowsHide: boolean } {
  return { encoding: 'utf8', timeout: gitTimeoutMs(timeoutMs), windowsHide: true };
}

function killProcess(proc: ReturnType<typeof spawn>): void {
  try { proc.kill('SIGKILL'); }
  catch { try { proc.kill(); } catch { /* */ } }
}

export function isGitRepo(repoRoot: string): boolean {
  try {
    const r = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--is-inside-work-tree'], syncOpts());
    return r.status === 0 && r.stdout.trim() === 'true';
  } catch { return false; }
}

export function gitHeadSha(repoRoot: string): string | null {
  try {
    const r = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], syncOpts());
    if (r.status !== 0) return null;
    return r.stdout.trim() || null;
  } catch { return null; }
}

export function gitRemoteUrl(repoRoot: string, remote = 'origin'): string | null {
  try {
    const r = spawnSync('git', ['-C', repoRoot, 'config', '--get', `remote.${remote}.url`], syncOpts());
    if (r.status !== 0) return null;
    return r.stdout.trim() || null;
  } catch { return null; }
}

export interface FileChurnStats {
  commitCount: number;
  lastCommitSha: string | null;
  lastCommitAt: number | null;        // unix seconds
  topAuthor: string | null;
  secondAuthor: string | null;
}

/**
 * Collect file-level churn stats by streaming `git log` once and bucketing
 * per file. Uses `--follow` per-file would be ~slow on big repos, so we use
 * a single `git log --name-only` pass and aggregate in JS. The trade-off is
 * that renames lose their pre-rename history; callers documenting that fact
 * matches the master guide's "honest about rename limits" stance.
 */
export async function collectFileChurn(
  repoRoot: string,
  filesAbs: Iterable<string>,
  options: { timeoutMs?: number; onTimeout?: (command: string) => void } = {},
): Promise<Map<string, FileChurnStats>> {
  const result = new Map<string, FileChurnStats>();
  if (!isGitRepo(repoRoot)) return result;

  // Build a quick lookup: relPath (forward slashes, normalized) → absPath.
  // `git log` reports paths relative to repo root, so we have to translate
  // back to absolute paths the indexer keyed off.
  const absSet = new Set<string>();
  for (const a of filesAbs) absSet.add(normalize(a));

  return new Promise((resolve, reject) => {
    let timedOut = false;
    const proc = spawn(
      'git',
      ['-C', repoRoot, 'log', '--name-only', '--pretty=format:__COMMIT__%H%x09%an%x09%aI', '--no-merges'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const timer = setTimeout(() => {
      timedOut = true;
      options.onTimeout?.('git log --name-only');
      killProcess(proc);
    }, gitTimeoutMs(options.timeoutMs));
    let buf = '';
    let currentSha: string | null = null;
    let currentAuthor: string | null = null;
    let currentDateSec: number | null = null;

    const perFile = new Map<string, {
      count: number;
      lastSha: string | null;
      lastAt: number | null;
      authors: Map<string, number>;
    }>();

    const handleLine = (line: string): void => {
      if (line.startsWith('__COMMIT__')) {
        const parts = line.slice('__COMMIT__'.length).split('\t');
        currentSha = parts[0] || null;
        currentAuthor = parts[1] || null;
        currentDateSec = parts[2] ? Math.floor(Date.parse(parts[2]) / 1000) : null;
        return;
      }
      if (!line.trim()) return;
      const rel = normalize(line);
      // Resolve to absolute. Path may use forward slashes; we compare against
      // absSet directly. Also fall back to repoRoot-joined.
      const cand1 = normalize(path.resolve(repoRoot, rel));
      let key: string | null = null;
      if (absSet.has(cand1)) key = cand1;
      else if (absSet.has(rel)) key = rel;
      if (!key) return;
      let entry = perFile.get(key);
      if (!entry) {
        entry = { count: 0, lastSha: null, lastAt: null, authors: new Map() };
        perFile.set(key, entry);
      }
      entry.count++;
      if (entry.lastSha === null) {
        entry.lastSha = currentSha;
        entry.lastAt = currentDateSec;
      }
      if (currentAuthor) {
        entry.authors.set(currentAuthor, (entry.authors.get(currentAuthor) ?? 0) + 1);
      }
    };

    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handleLine(line);
      }
    });
    proc.stderr.on('data', () => { /* swallow */ });
    proc.on('error', err => {
      clearTimeout(timer);
      if (timedOut) resolve(result);
      else reject(err);
    });
    proc.on('close', () => {
      clearTimeout(timer);
      if (buf.length > 0) handleLine(buf);
      for (const [key, e] of perFile) {
        const sortedAuthors = Array.from(e.authors.entries()).sort((a, b) => b[1] - a[1]);
        result.set(key, {
          commitCount: e.count,
          lastCommitSha: e.lastSha,
          lastCommitAt: e.lastAt,
          topAuthor: sortedAuthors[0]?.[0] ?? null,
          secondAuthor: sortedAuthors[1]?.[0] ?? null,
        });
      }
      resolve(result);
    });
  });
}

export interface CommitMeta {
  sha: string;
  authorName: string | null;
  authorEmail: string | null;
  committedAt: number; // unix seconds
  message: string;
  /**
   * The path the file had AT THIS COMMIT (forward-slash, repo-relative).
   * Resolved from `git log --follow --name-status` so commits prior to a
   * rename can still be looked up by the historical path. Null if the path
   * couldn't be determined from log output (in which case callers should
   * fall back to the current path).
   */
  pathAtCommit: string | null;
}

/**
 * `git log` commits that touched a single file, newest first. Each commit
 * includes its author info and full message. Used by the symbol-history pass.
 *
 * `--name-status` is added on top of `--follow` so we get a per-commit path —
 * critical for the rename case: the historical commits touched the OLD path,
 * but our usual `git show <sha> -- <currentPath>` would look at the wrong
 * path and return empty hunks. With pathAtCommit threaded through to
 * fileDiffInfo(), pre-rename history is preserved.
 *
 * Parser shape: we ask git for a per-commit header line prefixed `__C__`
 * (sha, author, email, ISO date — all NUL-free fields tab-separated), then
 * the commit body (terminated by a unique end marker `__BODY_END__`), then
 * the name-status lines that git appends after each commit. The name-status
 * block has one path entry per commit relative to this file's --follow chain:
 * either `M\tpath`, `A\tpath`, `D\tpath`, or `R<score>\toldPath\tnewPath`.
 *
 * Using a custom body terminator (instead of git's default blank-line
 * separator) lets us handle commit messages that themselves contain blank
 * lines or `__C__` literals without re-introducing the old `__C__ff8` bug.
 */
export async function commitsForFile(
  repoRoot: string,
  filePath: string,
  options: { limit?: number; since?: number; timeoutMs?: number; onTimeout?: (command: string) => void } = {},
): Promise<CommitMeta[]> {
  if (!isGitRepo(repoRoot)) return [];
  const rel = path.relative(repoRoot, filePath);
  const args = ['-C', repoRoot, 'log',
    '--pretty=format:__C__%H%x09%an%x09%ae%x09%aI%n%B%n__BODY_END__',
    '--no-merges',
    '--follow',
    '--name-status',
  ];
  if (options.limit) args.push(`-n${options.limit}`);
  if (options.since) args.push(`--since=${new Date(options.since * 1000).toISOString()}`);
  args.push('--', rel);

  return new Promise((resolve) => {
    let timedOut = false;
    const proc = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      options.onTimeout?.(`git log --follow -- ${rel}`);
      killProcess(proc);
    }, gitTimeoutMs(options.timeoutMs));
    let buf = '';
    proc.stdout.on('data', (c: Buffer) => { buf += c.toString('utf8'); });
    proc.stderr.on('data', () => { /* */ });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
    proc.on('close', () => {
      clearTimeout(timer);
      resolve(timedOut ? [] : parseFollowLog(buf));
    });
  });
}

/**
 * Walk the line stream from `git log --follow --name-status` (with the
 * `__C__` header / `__BODY_END__` body terminator format above) and emit
 * one CommitMeta per `__C__` header. Exposed only for tests; the live
 * pipeline goes through commitsForFile().
 */
export function parseFollowLog(buf: string): CommitMeta[] {
  const out: CommitMeta[] = [];
  // Normalize CRLF that Windows git may inject in some setups so the line
  // walker doesn't end up with trailing \r in messages or paths.
  const lines = buf.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith('__C__')) { i++; continue; }
    const headerParts = line.slice('__C__'.length).split('\t');
    if (headerParts.length < 4) { i++; continue; }
    const [sha, author, email, dateStr] = headerParts;
    const committedAt = Math.floor(Date.parse(dateStr) / 1000);
    if (!sha || isNaN(committedAt)) { i++; continue; }
    // Collect message body until __BODY_END__.
    i++;
    const msgLines: string[] = [];
    while (i < lines.length && lines[i] !== '__BODY_END__') {
      msgLines.push(lines[i]);
      i++;
    }
    // Skip the __BODY_END__ line itself.
    if (i < lines.length) i++;
    // Collect name-status lines until the next __C__ header or EOF. Blank
    // lines (which git emits between commit body and name-status) are
    // skipped; we never have to interpret them.
    let pathAtCommit: string | null = null;
    while (i < lines.length && !lines[i].startsWith('__C__')) {
      const nl = lines[i];
      if (nl.length === 0) { i++; continue; }
      const fields = nl.split('\t');
      if (fields.length >= 2) {
        const code = fields[0];
        if (code.startsWith('R') || code.startsWith('C')) {
          // Rename/copy: code, oldPath, newPath. The NEW path is what this
          // commit produced (and the path subsequent commits see).
          if (fields.length >= 3) pathAtCommit = fields[2];
        } else {
          pathAtCommit = fields[1];
        }
      }
      i++;
    }
    const message = msgLines.join('\n').trimEnd();
    out.push({
      sha,
      authorName: author || null,
      authorEmail: email || null,
      committedAt,
      message,
      pathAtCommit,
    });
  }
  return out;
}

export interface DiffHunk {
  oldStart: number; oldLines: number;
  newStart: number; newLines: number;
}

export interface FileDiffInfo {
  hunks: DiffHunk[];
  /**
   * True when the commit created the file (or — symmetrically — deleted it).
   * In that case the diff has `--- /dev/null` (added) or `+++ /dev/null`
   * (deleted) and EVERY symbol currently in the file should be attributed,
   * because the file's current shape didn't exist before.
   */
  isFileAddition: boolean;
}

/**
 * Diff hunks for a file changed by a single commit. `git show -U0 <sha>`
 * handles the root commit transparently (no parent → diff against the empty
 * tree), so the caller doesn't need to pass parentSha. `parentSha` is kept
 * for compatibility but ignored.
 */
export async function fileDiffHunks(
  repoRoot: string, _parentSha: string | null, sha: string, filePath: string,
): Promise<DiffHunk[]> {
  const info = await fileDiffInfo(repoRoot, sha, filePath);
  return info.hunks;
}

/** Like fileDiffHunks but returns extra metadata used for "this commit
 *  created the file → match every symbol" heuristic.
 *
 * `filePath` may be either an absolute path or a repo-relative one. When the
 * file was renamed across history, callers should pass the PATH-AT-COMMIT
 * (resolved from `git log --follow --name-status`) so `git show` looks at
 * the right side of the rename — passing the current path would return
 * empty hunks for pre-rename commits and silently lose history.
 */
export async function fileDiffInfo(
  repoRoot: string, sha: string, filePath: string,
  options: { timeoutMs?: number; onTimeout?: (command: string) => void } = {},
): Promise<FileDiffInfo> {
  if (!isGitRepo(repoRoot)) return { hunks: [], isFileAddition: false };
  const rel = path.isAbsolute(filePath) ? path.relative(repoRoot, filePath) : filePath;
  const args = ['-C', repoRoot, 'show', '--format=', '-U0', sha, '--', rel];
  return new Promise(resolve => {
    let timedOut = false;
    const proc = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      options.onTimeout?.(`git show ${sha} -- ${rel}`);
      killProcess(proc);
    }, gitTimeoutMs(options.timeoutMs));
    let buf = '';
    proc.stdout.on('data', (c: Buffer) => { buf += c.toString('utf8'); });
    proc.stderr.on('data', () => { /* */ });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve({ hunks: [], isFileAddition: false });
    });
    proc.on('close', () => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ hunks: [], isFileAddition: false });
        return;
      }
      const out: DiffHunk[] = [];
      const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
      let m;
      while ((m = re.exec(buf)) !== null) {
        out.push({
          oldStart: parseInt(m[1], 10),
          oldLines: m[2] ? parseInt(m[2], 10) : 1,
          newStart: parseInt(m[3], 10),
          newLines: m[4] ? parseInt(m[4], 10) : 1,
        });
      }
      const isFileAddition = /^--- \/dev\/null$/m.test(buf) || /^new file mode/m.test(buf);
      resolve({ hunks: out, isFileAddition });
    });
  });
}

/**
 * Diff numstat for one commit: returns added/removed line counts per file
 * (or aggregated when filePath is given).
 */
export async function commitNumstat(
  repoRoot: string, sha: string, filePath?: string,
): Promise<{ added: number; removed: number }> {
  if (!isGitRepo(repoRoot)) return { added: 0, removed: 0 };
  const args = ['-C', repoRoot, 'show', '--numstat', '--format=', sha];
  if (filePath) args.push('--', path.relative(repoRoot, filePath));
  return new Promise(resolve => {
    const proc = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => killProcess(proc), gitTimeoutMs());
    let buf = '';
    proc.stdout.on('data', (c: Buffer) => { buf += c.toString('utf8'); });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve({ added: 0, removed: 0 });
    });
    proc.on('close', () => {
      clearTimeout(timer);
      let added = 0, removed = 0;
      for (const line of buf.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) continue;
        const a = parseInt(parts[0], 10);
        const r = parseInt(parts[1], 10);
        if (!isNaN(a)) added += a;
        if (!isNaN(r)) removed += r;
      }
      resolve({ added, removed });
    });
  });
}

/**
 * git diff name-only between two refs. Defaults to HEAD vs the working
 * tree (uncommitted changes) — used by `detect_changes`. Returns absolute
 * paths (after path.resolve(repoRoot, rel)).
 */
export function gitChangedFiles(repoRoot: string, fromRef?: string, toRef?: string): string[] {
  if (!isGitRepo(repoRoot)) return [];
  const args = ['-C', repoRoot, 'diff', '--name-only'];
  if (fromRef && toRef) args.push(`${fromRef}..${toRef}`);
  else if (fromRef)    args.push(fromRef);
  // No refs → working-tree diff against HEAD.
  const r = spawnSync('git', args, syncOpts());
  if (r.status !== 0) return [];
  return r.stdout.split('\n').filter(Boolean).map(rel => path.resolve(repoRoot, rel));
}

/**
 * git diff -U0 hunks for one file between two refs (or working tree if refs
 * omitted). Returns parsed hunk headers (line ranges in the new file) so
 * `detect_changes` can compute which symbols overlap.
 */
export function fileDiffHunksSync(
  repoRoot: string, filePath: string, fromRef?: string, toRef?: string,
): DiffHunk[] {
  if (!isGitRepo(repoRoot)) return [];
  if (!fs.existsSync(filePath)) return [];
  const rel = path.relative(repoRoot, filePath);
  const args = ['-C', repoRoot, 'diff', '-U0'];
  if (fromRef && toRef) args.push(`${fromRef}..${toRef}`);
  else if (fromRef)    args.push(fromRef);
  args.push('--', rel);
  const r = spawnSync('git', args, syncOpts());
  if (r.status !== 0) return [];
  const out: DiffHunk[] = [];
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  let m;
  while ((m = re.exec(r.stdout)) !== null) {
    out.push({
      oldStart: parseInt(m[1], 10),
      oldLines: m[2] ? parseInt(m[2], 10) : 1,
      newStart: parseInt(m[3], 10),
      newLines: m[4] ? parseInt(m[4], 10) : 1,
    });
  }
  return out;
}

function normalize(p: string): string {
  const n = p.replace(/\\/g, '/');
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

/**
 * Extract GitHub-style PR numbers from a commit message. We accept the
 * common conventions:
 *   "Merge pull request #1234 from ..."
 *   "Fix something (#1234)"
 *   "#1234"
 *   "PR #1234"
 *
 * Returns the first matched PR number, or null.
 */
export function extractPrNumber(message: string): number | null {
  if (!message) return null;
  const merge = message.match(/Merge pull request #(\d+)/i);
  if (merge) return parseInt(merge[1], 10);
  // Trailing or inline `#1234` but not part of a hex-ish word
  const m = message.match(/(?:^|[\s(])#(\d{1,7})\b/);
  if (m) return parseInt(m[1], 10);
  return null;
}

/**
 * If `remoteUrl` is a GitHub URL (HTTPS or SSH), return the matching
 * `https://github.com/<owner>/<repo>/pull/<n>` URL for a PR number.
 * Returns null for non-GitHub remotes so we don't fabricate links to
 * GitLab/Bitbucket/etc.
 */
export function githubPrUrl(remoteUrl: string | null, prNumber: number): string | null {
  if (!remoteUrl || !prNumber) return null;
  // git@github.com:owner/repo.git
  let m = remoteUrl.match(/^git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (!m) m = remoteUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}/pull/${prNumber}`;
}
