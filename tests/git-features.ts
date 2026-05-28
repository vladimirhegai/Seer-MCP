/**
 * Git-dependent features: file churn, symbol history, detect_changes, PR/URL
 * mining. We build a tiny git repo on the fly in a temp dir and assert that
 * each pass correctly captures the history we just committed.
 *
 * Run with: npx tsx tests/git-features.ts
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawnSync } from 'child_process';
import { Indexer } from '../src/indexer/index';
import { Store } from '../src/db/store';
import { collectChurn } from '../src/indexer/churn';
import { buildSymbolHistory } from '../src/indexer/symbolhistory';
import { detectChanges } from '../src/indexer/detectchanges';
import { extractPrNumber, githubPrUrl } from '../src/indexer/git';

const TMP = path.join(os.tmpdir(), `strata-git-${Date.now()}`);
const REPO = path.join(TMP, 'repo');
const DB = path.join(TMP, 'graph.db');

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}`); failed++; }
}

function git(...args: string[]): { stdout: string; status: number } {
  const r = spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });
  return { stdout: r.stdout ?? '', status: r.status ?? 1 };
}

function commit(message: string, author = 'Alice <alice@example.com>'): string {
  git('add', '.');
  const r = spawnSync(
    'git',
    ['-C', REPO, '-c', `user.email=${author.replace(/^.* <(.+)>$/, '$1')}`,
            '-c', `user.name=${author.replace(/ <.+>$/, '')}`,
            'commit', '-m', message, '--no-gpg-sign'],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`git commit failed: ${r.stderr}`);
  const sha = git('rev-parse', 'HEAD').stdout.trim();
  return sha;
}

function write(rel: string, content: string): void {
  const full = path.join(REPO, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

async function run(): Promise<void> {
  console.log('\nStrata Git-Features Tests');
  console.log('=========================\n');

  // Setup
  fs.mkdirSync(REPO, { recursive: true });
  const initRes = spawnSync('git', ['-C', REPO, 'init', '-q', '-b', 'main'], { encoding: 'utf8' });
  if (initRes.status !== 0) {
    // try without -b on older git
    spawnSync('git', ['-C', REPO, 'init', '-q'], { encoding: 'utf8' });
  }
  git('config', 'commit.gpgsign', 'false');

  // Configure a fake GitHub remote so PR URL mining can run.
  git('remote', 'add', 'origin', 'git@github.com:example/myrepo.git');

  // Commit 1: initial files
  write('app.ts', `
export function login(user: string, password: string): boolean {
  return user === password;
}

export function logout(token: string): void {
  // noop
}

export function helper(x: number): number {
  return x * 2;
}
`.trimStart());
  write('README.md', '# Demo\n');
  const sha1 = commit('Initial commit', 'Alice <alice@example.com>');

  // Commit 2: extend login
  write('app.ts', `
export function login(user: string, password: string): boolean {
  if (!user || !password) return false;
  return user === password;
}

export function logout(token: string): void {
  // noop
}

export function helper(x: number): number {
  return x * 2;
}
`.trimStart());
  const sha2 = commit('Add empty-credentials guard to login (#42)', 'Bob <bob@example.com>');

  // Commit 3: add new file
  write('utils.ts', `
export function formatUser(u: string): string { return u.toUpperCase(); }
`.trimStart());
  const sha3 = commit('Merge pull request #99 from feature/utils\n\nAdd utils module', 'Alice <alice@example.com>');

  // Commit 4: tweak helper
  write('app.ts', `
export function login(user: string, password: string): boolean {
  if (!user || !password) return false;
  return user === password;
}

export function logout(token: string): void {
  // noop
}

export function helper(x: number): number {
  return x * 4;
}
`.trimStart());
  const sha4 = commit('Tweak helper multiplier', 'Bob <bob@example.com>');

  console.log(`  4 commits made: ${sha1.slice(0,8)} … ${sha4.slice(0,8)}\n`);

  // Index it
  const store = new Store(DB);
  const indexer = new Indexer(store);
  const r = await indexer.indexDirectory(REPO, { quiet: true });
  console.log(`  Indexed: files=${r.filesIndexed} symbols=${r.symbols} edges=${r.edges}\n`);

  // ── File churn ────────────────────────────────────────────────────────────
  console.log('── File churn ──');
  const ch = await collectChurn(REPO, store);
  console.log(`  ${ch.filesWithChurn}/${ch.filesAnalyzed} files have history, HEAD ${ch.headSha?.slice(0,8)}`);
  assert(ch.headSha === sha4, `churn.headSha matches HEAD (${ch.headSha?.slice(0,8)})`);
  assert(ch.filesWithChurn >= 2, `churn covers ≥2 files (app.ts and utils.ts)`);

  const appChurn = store.getFileChurn(path.join(REPO, 'app.ts'));
  console.log(`  app.ts: commits=${appChurn?.commitCount}, top=${appChurn?.topAuthor}, second=${appChurn?.secondAuthor}`);
  assert(appChurn !== null, 'getFileChurn(app.ts) returns a row');
  assert(appChurn!.commitCount === 3, `app.ts touched in 3 commits (got ${appChurn!.commitCount})`);
  // Bob did 2 commits to app.ts (sha2 + sha4), Alice did 1 (sha1)
  assert(appChurn!.topAuthor === 'Bob', `app.ts top author = Bob (got ${appChurn!.topAuthor})`);
  assert(appChurn!.secondAuthor === 'Alice', `app.ts second author = Alice (got ${appChurn!.secondAuthor})`);
  assert(appChurn!.lastCommitSha === sha4, `app.ts last commit = sha4 (got ${appChurn!.lastCommitSha?.slice(0,8)})`);
  assert(appChurn!.lastCommitAt !== null && appChurn!.lastCommitAt > 0, 'last commit timestamp populated');

  const utilsChurn = store.getFileChurn(path.join(REPO, 'utils.ts'));
  assert(utilsChurn !== null && utilsChurn.commitCount === 1, `utils.ts: 1 commit`);

  // top churned files
  const topChurn = store.topChurnedFiles(10);
  assert(topChurn[0].filePath.endsWith('app.ts'), `topChurnedFiles: app.ts first (most edited)`);

  // ── Git index state ──────────────────────────────────────────────────────
  console.log('\n── git_index_state ──');
  const state = store.getGitIndexState();
  assert(state !== null, 'git_index_state row populated');
  assert(state!.lastHeadSha === sha4, `git_index_state.last_head_sha = HEAD`);
  assert(state!.remoteUrl !== null, `git_index_state.remote_url captured`);

  // ── PR mining ────────────────────────────────────────────────────────────
  console.log('\n── PR / URL mining ──');
  assert(extractPrNumber('Add foo (#42)') === 42, 'extractPrNumber inline (#42)');
  assert(extractPrNumber('Merge pull request #99 from foo') === 99, 'extractPrNumber merge form');
  assert(extractPrNumber('  #123 fix') === 123, 'extractPrNumber leading');
  assert(extractPrNumber('no number here') === null, 'extractPrNumber empty');
  assert(githubPrUrl('git@github.com:foo/bar.git', 7) === 'https://github.com/foo/bar/pull/7',
    'githubPrUrl SSH form');
  assert(githubPrUrl('https://github.com/foo/bar.git', 7) === 'https://github.com/foo/bar/pull/7',
    'githubPrUrl HTTPS form');
  assert(githubPrUrl('https://gitlab.com/foo/bar.git', 7) === null, 'githubPrUrl rejects non-github');
  assert(githubPrUrl(null, 7) === null, 'githubPrUrl null remote');

  // ── Symbol history (Track D) ─────────────────────────────────────────────
  console.log('\n── Symbol history ──');
  const sh = await buildSymbolHistory(REPO, store, { skipIfHeadUnchanged: false, log: () => {} });
  console.log(`  inserts=${sh.historyRowsInserted}, files=${sh.filesProcessed}, symbols=${sh.symbolsProcessed}`);
  assert(sh.historyRowsInserted >= 4, `symbol history: ≥4 rows`);
  assert(sh.filesProcessed >= 1, `symbol history: ≥1 file processed`);

  // login was modified in sha2 — verify
  const loginDef = store.getDefinition('login')[0];
  assert(loginDef !== undefined, 'login defined');
  const loginHistory = store.getSymbolHistory(loginDef.id, { limit: 10 });
  console.log(`  login history: ${loginHistory.length} commits`);
  for (const h of loginHistory) {
    console.log(`    ${h.commitSha.slice(0,8)}  ${h.authorName ?? '?'}  pr=${h.prNumber}  ${(h.message ?? '').split('\n')[0].slice(0,40)}`);
  }
  assert(loginHistory.length >= 2, `login history: ≥2 commits (got ${loginHistory.length})`);
  assert(loginHistory.some(h => h.commitSha === sha1), `login history includes sha1`);
  assert(loginHistory.some(h => h.commitSha === sha2 && h.prNumber === 42),
    `login history sha2 includes PR #42`);
  assert(loginHistory.some(h => h.prUrl === 'https://github.com/example/myrepo/pull/42'),
    `login history includes GitHub PR URL`);

  // helper was modified in sha1 (added) and sha4 (multiplier change)
  const helperDef = store.getDefinition('helper')[0];
  const helperHistory = store.getSymbolHistory(helperDef.id);
  console.log(`  helper history: ${helperHistory.length} commits`);
  assert(helperHistory.some(h => h.commitSha === sha4), `helper history includes sha4`);

  // logout was NOT modified after sha1 (only sha1 in its history)
  const logoutDef = store.getDefinition('logout')[0];
  const logoutHistory = store.getSymbolHistory(logoutDef.id);
  console.log(`  logout history: ${logoutHistory.length} commits`);
  assert(logoutHistory.length === 1 && logoutHistory[0].commitSha === sha1,
    `logout history is exactly sha1 (got ${logoutHistory.length})`);

  // count
  const loginCount = store.countSymbolHistory(loginDef.id);
  assert(loginCount === loginHistory.length, 'countSymbolHistory matches getSymbolHistory');

  // skipIfHeadUnchanged: second run with no commits should be a no-op
  const sh2 = await buildSymbolHistory(REPO, store, { skipIfHeadUnchanged: true, log: () => {} });
  assert(sh2.skipped === true, 'second buildSymbolHistory skips because HEAD unchanged');

  // ── detect_changes ────────────────────────────────────────────────────────
  console.log('\n── detect_changes ──');
  // Make an uncommitted edit to app.ts (modify logout body)
  write('app.ts', `
export function login(user: string, password: string): boolean {
  if (!user || !password) return false;
  return user === password;
}

export function logout(token: string): void {
  console.log("logging out " + token);
}

export function helper(x: number): number {
  return x * 4;
}
`.trimStart());

  const dc = detectChanges(REPO, store, { callerDepth: 2 });
  console.log(`  changedFiles=${dc.changedFiles.length} directly=${dc.directlyChanged.length} transitively=${dc.transitivelyAffected.length}`);
  for (const f of dc.changedFiles) {
    console.log(`    ${path.basename(f.path)}: hunks=${f.hunks}, symbols=${f.symbols.map(s => s.symbol.name).join(',')}`);
  }
  assert(dc.changedFiles.length === 1, 'detect_changes finds 1 modified file');
  assert(dc.directlyChanged.some(s => s.name === 'logout'), 'detect_changes flags logout as directly-changed');
  assert(!dc.directlyChanged.some(s => s.name === 'helper'), 'detect_changes does NOT flag helper');

  // detect_changes between two refs
  const dcRange = detectChanges(REPO, store, { fromRef: sha1, toRef: sha2, callerDepth: 2 });
  // sha1 → sha2 touched login only
  assert(dcRange.directlyChanged.some(s => s.name === 'login'), 'between-refs detect_changes flags login');

  // ── Cleanup ───────────────────────────────────────────────────────────────
  store.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.error('\n  GIT-FEATURES TEST FAILED\n'); process.exit(1); }
  else            { console.log('\n  All git-features tests passed! ✓\n'); }
}

run().catch(err => { console.error('git-features crashed:', err); process.exit(1); });
