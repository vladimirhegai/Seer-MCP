/**
 * Symbol-history performance & observability rework (SYMBOL_HISTORY_PERF_PLAN.md).
 *
 * Covers the pieces that the existing git-features test does not:
 *   - parseFollowLogWithPatches golden cases (normal edit / file addition /
 *     pure rename / multi-commit / message robustness),
 *   - helper-level parity: the new one-spawn `commitsWithDiffsForFile` produces
 *     byte-identical hunks + file-addition flags to the old two-step
 *     `commitsForFile` + per-commit `fileDiffInfo`,
 *   - Store.insertSymbolHistoryBatch idempotency + accurate insert count,
 *   - resume watermark round-trip + the file-hash / options-fingerprint /
 *     algorithm-version skip gates,
 *   - onProgress monotonicity.
 *
 * Run with: npx tsx tests/symbol-history-perf.ts
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawnSync } from 'child_process';
import { Indexer } from '../src/indexer/index';
import { Store } from '../src/db/store';
import {
  parseFollowLogWithPatches, commitsForFile, commitsWithDiffsForFile, fileDiffInfo,
} from '../src/indexer/git';
import {
  buildSymbolHistory, HISTORY_ALGORITHM_VERSION, HISTORY_ALGORITHM_VERSION_TWOPHASE,
  SymbolHistoryProgress, parseHistorySince,
} from '../src/indexer/symbolhistory';

const TMP = path.join(os.tmpdir(), `seer-symhist-${Date.now()}`);
const REPO = path.join(TMP, 'repo');
const ROOT = path.resolve(__dirname, '..');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_SRC = path.join(ROOT, 'src', 'cli', 'index.ts');

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
  git('add', '-A');
  const r = spawnSync('git',
    ['-C', REPO, '-c', `user.email=${author.replace(/^.* <(.+)>$/, '$1')}`,
     '-c', `user.name=${author.replace(/ <.+>$/, '')}`,
     'commit', '-m', message, '--no-gpg-sign'],
    { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git commit failed: ${r.stderr}`);
  return git('rev-parse', 'HEAD').stdout.trim();
}
function write(rel: string, content: string): void {
  const full = path.join(REPO, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}
function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(process.execPath, [TSX, CLI_SRC, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    status: r.status ?? 1,
  };
}

let dbCounter = 0;
function freshIndexedStore(): Store {
  const db = path.join(TMP, `idx-${dbCounter++}.db`);
  const store = new Store(db);
  // indexDirectory is async; callers await via indexInto().
  return store;
}
async function indexInto(store: Store): Promise<void> {
  const indexer = new Indexer(store);
  await indexer.indexDirectory(REPO, { quiet: true });
}

// ── 1. Parser golden cases (no git needed) ─────────────────────────────────────

function parserGoldens(): void {
  console.log('\n── parseFollowLogWithPatches golden cases ──');

  // Normal edit, two hunks.
  const edit = [
    '__C__abc123\tAlice\talice@example.com\t2026-01-02T00:00:00+00:00',
    'Fix something (#5)',
    '',
    'detail line',
    '__BODY_END__',
    'diff --git a/app.ts b/app.ts',
    'index 111..222 100644',
    '--- a/app.ts',
    '+++ b/app.ts',
    '@@ -10 +10 @@ ctx',
    '-old',
    '+new',
    '@@ -20,2 +21,3 @@',
    '-a',
    '-b',
    '+c',
    '+d',
    '+e',
    '',
  ].join('\n');
  const e = parseFollowLogWithPatches(edit);
  assert(e.length === 1, 'edit: one commit parsed');
  assert(e[0].sha === 'abc123', 'edit: sha');
  assert(e[0].authorName === 'Alice' && e[0].authorEmail === 'alice@example.com', 'edit: author+email');
  assert(e[0].message === 'Fix something (#5)\n\ndetail line', 'edit: multi-line message preserved');
  assert(e[0].committedAt > 0, 'edit: committedAt parsed');
  assert(e[0].isFileAddition === false, 'edit: not a file addition');
  assert(JSON.stringify(e[0].hunks) === JSON.stringify([
    { oldStart: 10, oldLines: 1, newStart: 10, newLines: 1 },
    { oldStart: 20, oldLines: 2, newStart: 21, newLines: 3 },
  ]), 'edit: both hunks parsed with implicit/explicit line counts');

  // File addition.
  const add = [
    '__C__def456\tBob\tbob@example.com\t2026-01-01T00:00:00+00:00',
    'Initial commit',
    '__BODY_END__',
    'diff --git a/app.ts b/app.ts',
    'new file mode 100644',
    'index 000..abc',
    '--- /dev/null',
    '+++ b/app.ts',
    '@@ -0,0 +1,3 @@',
    '+line1',
    '+line2',
    '+line3',
  ].join('\n');
  const a = parseFollowLogWithPatches(add);
  assert(a.length === 1 && a[0].isFileAddition === true, 'addition: isFileAddition true (new file mode + /dev/null)');
  assert(JSON.stringify(a[0].hunks) === JSON.stringify([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3 }]),
    'addition: @@ -0,0 +1,3 @@ hunk parsed');

  // Pure rename (no content change → no hunks, not an addition).
  const ren = [
    '__C__789aaa\tCarol\tcarol@example.com\t2026-01-03T00:00:00+00:00',
    'Rename file',
    '__BODY_END__',
    'diff --git a/old.ts b/new.ts',
    'similarity index 100%',
    'rename from old.ts',
    'rename to new.ts',
  ].join('\n');
  const r = parseFollowLogWithPatches(ren);
  assert(r.length === 1 && r[0].hunks.length === 0 && r[0].isFileAddition === false,
    'pure rename: no hunks, not a file addition');

  // Multi-commit + message robustness: body lines that look like diff markers
  // or a literal __C__ header must be consumed as message, never leak into the
  // diff section or split the commit.
  const tricky = [
    '__C__c1\tAlice\ta@e.com\t2026-01-05T00:00:00+00:00',
    'Tricky commit',
    '',
    '__C__not_a_real_header in body',
    'fake hunk in body: @@ -1 +1 @@',
    'fake addition in body: --- /dev/null',
    '__BODY_END__',
    'diff --git a/x.ts b/x.ts',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -3 +3 @@',
    '-x',
    '+y',
    '',
    '__C__c2\tBob\tb@e.com\t2026-01-04T00:00:00+00:00',
    'Second',
    '__BODY_END__',
    'diff --git a/x.ts b/x.ts',
    '@@ -7,0 +8,2 @@',
    '+p',
    '+q',
  ].join('\n');
  const t = parseFollowLogWithPatches(tricky);
  assert(t.length === 2, 'tricky: exactly two commits (literal __C__ in body did NOT split)');
  assert(t[0].message.includes('__C__not_a_real_header in body'), 'tricky: literal __C__ kept in message body');
  assert(t[0].isFileAddition === false, 'tricky: fake "--- /dev/null" in body did NOT flag file addition');
  assert(JSON.stringify(t[0].hunks) === JSON.stringify([{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 }]),
    'tricky: only the real post-__BODY_END__ hunk counted for c1');
  assert(JSON.stringify(t[1].hunks) === JSON.stringify([{ oldStart: 7, oldLines: 0, newStart: 8, newLines: 2 }]),
    'tricky: c2 hunk parsed');

  // Empty / junk input never throws and yields no commits.
  assert(parseFollowLogWithPatches('').length === 0, 'empty buffer → no commits');
  assert(parseFollowLogWithPatches('garbage\nwithout headers').length === 0, 'headerless buffer → no commits');
}

// ── main ───────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log('\nSeer Symbol-History Perf/Resume Tests');
  console.log('======================================');

  parserGoldens();

  // Build a small repo with an add, edits, and a rename (to exercise --follow).
  fs.mkdirSync(REPO, { recursive: true });
  if (spawnSync('git', ['-C', REPO, 'init', '-q', '-b', 'main'], { encoding: 'utf8' }).status !== 0) {
    spawnSync('git', ['-C', REPO, 'init', '-q'], { encoding: 'utf8' });
  }
  git('config', 'commit.gpgsign', 'false');
  git('remote', 'add', 'origin', 'git@github.com:example/symhist.git');

  write('alpha.ts', 'export function alphaOne(): number { return 1; }\nexport function alphaTwo(): number { return 2; }\n');
  write('beta.ts', 'export function betaOne(): number { return 10; }\nexport function betaTwo(): number { return 20; }\n');
  const shaAdd = commit('Initial commit', 'Alice <alice@example.com>');

  write('alpha.ts', 'export function alphaOne(): number { return 100; }\nexport function alphaTwo(): number { return 2; }\n');
  const shaEdit1 = commit('Tune alphaOne (#7)', 'Bob <bob@example.com>');

  // Pure rename beta.ts → gamma.ts (no content change → 100% similarity) so git's
  // rename detection reliably fires and --follow tracks gamma.ts back to its add.
  git('mv', 'beta.ts', 'gamma.ts');
  const shaRename = commit('Move beta→gamma', 'Alice <alice@example.com>');

  write('alpha.ts', 'export function alphaOne(): number { return 100; }\nexport function alphaTwo(): number { return 222; }\n');
  const shaEdit2 = commit('Tune alphaTwo', 'Bob <bob@example.com>');

  console.log(`\n  commits: ${[shaAdd, shaEdit1, shaRename, shaEdit2].map(s => s.slice(0, 7)).join(' ')}`);

  const alphaAbs = path.join(REPO, 'alpha.ts');
  const gammaAbs = path.join(REPO, 'gamma.ts');

  // ── 2. Helper-level parity: new combined vs old two-step ─────────────────────
  // For every CONTENT-BEARING commit the new one-spawn `commitsWithDiffsForFile`
  // must produce byte-identical metadata + hunks + file-addition flags to the old
  // `commitsForFile` + per-commit `fileDiffInfo`. The single documented divergence
  // is the PURE-rename commit: the old path did `git show -U0 <sha> -- <newpath>`,
  // whose pathspec hides the rename source so git mis-reports the rename as a new
  // file (add=true) — fabricating a file-addition row that attributes the symbols'
  // creation to the rename. The new `--follow -p` walk sees the rename correctly
  // (add=false, no hunks), so creation stays attributed to the real original add.
  console.log('\n── combined helper vs two-step parity ──');
  for (const { fileAbs, renameSha } of [
    { fileAbs: alphaAbs, renameSha: null as string | null },
    { fileAbs: gammaAbs, renameSha: shaRename },
  ]) {
    const label = path.basename(fileAbs);
    const oldCommits = await commitsForFile(REPO, fileAbs, { limit: 200 });
    // follow:true reproduces the old --follow two-step exactly (the parity
    // contract). The new DEFAULT is follow:false (B2) — covered separately below.
    const newCommits = await commitsWithDiffsForFile(REPO, fileAbs, { limit: 200, assumeRepo: true, follow: true });
    assert(oldCommits.length === newCommits.length && newCommits.length > 0,
      `${label}: same non-zero commit count (old=${oldCommits.length} new=${newCommits.length})`);
    let contentParity = oldCommits.length === newCommits.length;
    let renameImprovementSeen = false;
    for (let i = 0; i < Math.min(oldCommits.length, newCommits.length); i++) {
      const oc = oldCommits[i], nc = newCommits[i];
      if (oc.sha !== nc.sha || oc.committedAt !== nc.committedAt
          || oc.authorName !== nc.authorName || oc.authorEmail !== nc.authorEmail
          || oc.message !== nc.message) { contentParity = false; break; }
      const oldInfo = await fileDiffInfo(REPO, oc.sha, oc.pathAtCommit ?? fileAbs, {});
      if (renameSha && oc.sha === renameSha) {
        // The one allowed difference — and an improvement: old mis-sees the pure
        // rename as an addition; new represents it as a rename.
        if (oldInfo.isFileAddition && !nc.isFileAddition && nc.hunks.length === 0) renameImprovementSeen = true;
        continue;
      }
      if (oldInfo.isFileAddition !== nc.isFileAddition
          || JSON.stringify(oldInfo.hunks) !== JSON.stringify(nc.hunks)) { contentParity = false; break; }
    }
    assert(contentParity, `${label}: content commits byte-identical (metadata + hunks + file-addition flag)`);
    if (renameSha) {
      assert(renameImprovementSeen,
        `${label}: pure-rename commit represented as a rename by --follow (no spurious file-addition)`);
    }
  }

  // gamma.ts WITH follow:true must reach its add as beta.ts.
  const gammaCombined = await commitsWithDiffsForFile(REPO, gammaAbs, { limit: 200, assumeRepo: true, follow: true });
  assert(gammaCombined.some(c => c.sha === shaAdd && c.isFileAddition),
    'gamma.ts (follow:true): --follow reached the original add (as beta.ts) and flagged it as a file addition');

  // ── 2b. B2: no-follow DEFAULT stops at the rename boundary ────────────────────
  console.log('\n── B2: --follow opt-out (default) ──');
  {
    const gammaFollow = await commitsWithDiffsForFile(REPO, gammaAbs, { limit: 200, assumeRepo: true, follow: true });
    const gammaNoFollow = await commitsWithDiffsForFile(REPO, gammaAbs, { limit: 200, assumeRepo: true });
    assert(gammaNoFollow.length < gammaFollow.length,
      `default (no-follow) sees fewer commits than --follow across a rename (no-follow=${gammaNoFollow.length} follow=${gammaFollow.length})`);
    assert(!gammaNoFollow.some(c => c.sha === shaAdd),
      'default (no-follow): gamma.ts does NOT reach the pre-rename add commit (continuity bridges it instead)');
    // alpha.ts has no rename, so follow vs no-follow are identical for it.
    const alphaFollow = await commitsWithDiffsForFile(REPO, alphaAbs, { limit: 200, assumeRepo: true, follow: true });
    const alphaNoFollow = await commitsWithDiffsForFile(REPO, alphaAbs, { limit: 200, assumeRepo: true });
    assert(alphaFollow.length === alphaNoFollow.length,
      'no rename → follow and no-follow agree on commit count for alpha.ts');
  }

  // ── 3. Store.insertSymbolHistoryBatch idempotency + count ────────────────────
  console.log('\n── batched writes ──');
  {
    const store = freshIndexedStore();
    await indexInto(store);
    const alphaOne = store.getDefinition('alphaOne')[0];
    assert(alphaOne !== undefined, 'alphaOne indexed');
    const rows = [
      { symbolId: alphaOne.id, symbolKey: 'k', commitSha: 'fake0001', authorName: 'A', authorEmail: 'a@e',
        committedAt: 1000, message: 'm1', linesAdded: 1, linesRemoved: 0, prNumber: null, prUrl: null,
        matchStrategy: 'overlap', confidence: 1 },
      { symbolId: alphaOne.id, symbolKey: 'k', commitSha: 'fake0002', authorName: 'A', authorEmail: 'a@e',
        committedAt: 2000, message: 'm2', linesAdded: 2, linesRemoved: 1, prNumber: 9, prUrl: null,
        matchStrategy: 'overlap', confidence: 1 },
    ];
    const first = store.insertSymbolHistoryBatch(rows);
    assert(first === 2, `batch inserts both new rows (got ${first})`);
    const second = store.insertSymbolHistoryBatch(rows);
    assert(second === 0, `re-running the same batch inserts nothing — idempotent (got ${second})`);
    assert(store.insertSymbolHistoryBatch([]) === 0, 'empty batch is a no-op');
    const hist = store.getSymbolHistory(alphaOne.id, { limit: 10 });
    assert(hist.some(h => h.commitSha === 'fake0001') && hist.some(h => h.commitSha === 'fake0002'),
      'both batched rows are readable back');
    store.close();
  }

  // ── 4. Watermark round-trip + clear ──────────────────────────────────────────
  console.log('\n── resume watermark accessors ──');
  {
    const store = freshIndexedStore();
    await indexInto(store);
    assert(store.getSymbolHistoryWatermarks(REPO).size === 0, 'no watermarks before any build');
    store.upsertSymbolHistoryWatermark(REPO, alphaAbs, 'hashA', 'mc=200;since=', 1, 'headsha', 3);
    const wms = store.getSymbolHistoryWatermarks(REPO);
    const wm = wms.get(alphaAbs);
    assert(!!wm && wm.fileHash === 'hashA' && wm.optionsFingerprint === 'mc=200;since='
      && wm.algorithmVersion === 1 && wm.headSha === 'headsha', 'watermark round-trips all fields');
    store.upsertSymbolHistoryWatermark(REPO, alphaAbs, 'hashB', 'mc=200;since=', 1, 'headsha2', 5);
    assert(store.getSymbolHistoryWatermarks(REPO).get(alphaAbs)!.fileHash === 'hashB',
      'upsert overwrites on (repo_root, file_path) conflict');
    store.clearSymbolHistoryWatermarks(REPO);
    assert(store.getSymbolHistoryWatermarks(REPO).size === 0, 'clearSymbolHistoryWatermarks empties the repo');
    store.close();
  }

  // Reference: a full build's row count, for resume parity.
  let fullRowCount = 0;
  {
    const store = freshIndexedStore();
    await indexInto(store);
    const r = await buildSymbolHistory(REPO, store, { skipIfHeadUnchanged: false, log: () => {} });
    fullRowCount = (store.rawDb().prepare('SELECT COUNT(*) AS c FROM symbol_history').get() as { c: number }).c;
    assert(r.completed && r.filesProcessed === 2 && r.filesSkippedResume === 0,
      `full build: completed, 2 files processed, 0 skipped (got proc=${r.filesProcessed} skip=${r.filesSkippedResume})`);
    assert(fullRowCount > 0, `full build inserted rows (got ${fullRowCount})`);
    store.close();
  }

  // ── 5a. Resume: partial (maxFiles=1) then finish, skipping the done file ──────
  console.log('\n── resume: partial → finish ──');
  {
    const store = freshIndexedStore();
    await indexInto(store);
    const p = await buildSymbolHistory(REPO, store, { maxFiles: 1, log: () => {} });
    assert(!p.completed && p.filesProcessed === 1, `partial: 1 file, not completed (got proc=${p.filesProcessed})`);
    assert(store.getSymbolHistoryWatermarks(REPO).size === 1, 'partial wrote exactly one watermark');
    const resume = await buildSymbolHistory(REPO, store, { log: () => {} });
    assert(resume.completed, 'resume: completed');
    assert(resume.filesSkippedResume === 1, `resume skipped the already-done file (got ${resume.filesSkippedResume})`);
    assert(resume.filesProcessed === 1, `resume processed only the remaining file (got ${resume.filesProcessed})`);
    const total = (store.rawDb().prepare('SELECT COUNT(*) AS c FROM symbol_history').get() as any).c;
    assert(total === fullRowCount, `resume yields the same rows as a full build (got ${total}, full ${fullRowCount})`);
    store.close();
  }

  // ── 5b. Options-fingerprint gate: a different --max-commits is NOT skippable ──
  console.log('\n── resume gate: options fingerprint ──');
  {
    const store = freshIndexedStore();
    await indexInto(store);
    // Partial leaves HEAD unstamped, so the next build still enters the loop and
    // the per-file watermark gate is exercised regardless of HEAD.
    await buildSymbolHistory(REPO, store, { maxFiles: 1, maxCommitsPerFile: 200, log: () => {} });
    const rerun = await buildSymbolHistory(REPO, store, { maxCommitsPerFile: 50, log: () => {} });
    assert(rerun.filesSkippedResume === 0,
      `different maxCommits invalidates the watermark — nothing skipped (got ${rerun.filesSkippedResume})`);
    store.close();
  }

  // ── 5c. File-hash gate: an edited+reindexed file is NOT skippable ─────────────
  console.log('\n── resume gate: file hash ──');
  {
    const store = freshIndexedStore();
    await indexInto(store);
    // Partial processes the first file (alpha.ts in sorted order) and watermarks it.
    const p = await buildSymbolHistory(REPO, store, { maxFiles: 1, log: () => {} });
    assert(p.filesProcessed === 1, 'file-hash setup: one file watermarked');
    // Change alpha.ts content (working-tree edit) and reindex so files.hash flips.
    write('alpha.ts', 'export function alphaOne(): number { return 999; }\nexport function alphaTwo(): number { return 222; }\nexport function alphaThree(): number { return 3; }\n');
    await indexInto(store);
    const rerun = await buildSymbolHistory(REPO, store, { log: () => {} });
    assert(rerun.filesSkippedResume === 0,
      `edited file's stale watermark is ignored — not skipped (got ${rerun.filesSkippedResume})`);
    // restore on disk for any later use
    write('alpha.ts', 'export function alphaOne(): number { return 100; }\nexport function alphaTwo(): number { return 222; }\n');
    store.close();
  }

  // ── 5d. Force rebuild clears watermarks and reprocesses everything ───────────
  console.log('\n── resume: force rebuild ──');
  {
    const store = freshIndexedStore();
    await indexInto(store);
    await buildSymbolHistory(REPO, store, { skipIfHeadUnchanged: false, log: () => {} });
    assert(store.getSymbolHistoryWatermarks(REPO).size === 2, 'first build wrote watermarks for both files');
    const forced = await buildSymbolHistory(REPO, store, { skipIfHeadUnchanged: false, log: () => {} });
    assert(forced.completed && forced.filesProcessed === 2 && forced.filesSkippedResume === 0,
      `force ignores watermarks and reprocesses all (proc=${forced.filesProcessed} skip=${forced.filesSkippedResume})`);
    store.close();
  }

  // ── 5e. COMPLETED-build reruns at the same HEAD (the high-bug regressions) ────
  // A completed build stamps lastHistoryHeadSha. The skip decision must STILL run
  // the watermark check — a coarse "HEAD unchanged → skip" would wrongly no-op a
  // same-HEAD rerun whose options or file content changed.
  console.log('\n── completed-build rerun: HEAD-skip must honour watermarks ──');
  {
    // Positive control: a truly-unchanged rerun takes the fast no-op skip.
    const store = freshIndexedStore();
    await indexInto(store);
    const first = await buildSymbolHistory(REPO, store, { log: () => {} });
    assert(first.completed && !first.skipped, 'first full build runs (stamps HEAD + watermarks)');
    const noop = await buildSymbolHistory(REPO, store, { log: () => {} });
    assert(noop.skipped === true, 'truly-unchanged same-HEAD rerun takes the fast no-op skip');
    store.close();
  }
  {
    // Repro 1: same HEAD, different --max-commits → must NOT skip.
    const store = freshIndexedStore();
    await indexInto(store);
    const r1 = await buildSymbolHistory(REPO, store, { maxCommitsPerFile: 1, log: () => {} });
    assert(r1.completed && !r1.skipped, 'full build with maxCommitsPerFile=1 completes + stamps HEAD');
    const r2 = await buildSymbolHistory(REPO, store, { maxCommitsPerFile: 200, log: () => {} });
    assert(r2.skipped === false,
      'same-HEAD rerun with a DIFFERENT --max-commits is not skipped (options fingerprint changed)');
    assert(r2.filesProcessed === 2, `... and reprocesses every file (got ${r2.filesProcessed})`);
    store.close();
  }
  {
    // Repro 2: same HEAD, a tracked file edited (uncommitted) + reindexed → must
    // reprocess that file (its hash flipped) while still skipping the unchanged one.
    const store = freshIndexedStore();
    await indexInto(store);
    const r1 = await buildSymbolHistory(REPO, store, { log: () => {} });
    assert(r1.completed && !r1.skipped, 'full build completes + stamps HEAD');
    write('alpha.ts', 'export function alphaOne(): number { return 4242; }\nexport function alphaTwo(): number { return 222; }\n');
    await indexInto(store); // same HEAD (uncommitted), alpha.ts hash flips
    const r2 = await buildSymbolHistory(REPO, store, { log: () => {} });
    assert(r2.skipped === false,
      'same-HEAD rerun after an edited+reindexed file is not skipped');
    assert(r2.filesProcessed === 1 && r2.filesSkippedResume === 1,
      `reprocesses only the changed file, skips the unchanged one (proc=${r2.filesProcessed} skip=${r2.filesSkippedResume})`);
    write('alpha.ts', 'export function alphaOne(): number { return 100; }\nexport function alphaTwo(): number { return 222; }\n');
    store.close();
  }

  // ── 6. Progress callback monotonicity ────────────────────────────────────────
  console.log('\n── progress callback ──');
  {
    const store = freshIndexedStore();
    await indexInto(store);
    const events: SymbolHistoryProgress[] = [];
    const r = await buildSymbolHistory(REPO, store, {
      skipIfHeadUnchanged: false, log: () => {},
      onProgress: (p) => events.push(p),
    });
    assert(events.length > 0, 'onProgress fired');
    let monotonic = true;
    for (let i = 1; i < events.length; i++) if (events[i].filesHandled < events[i - 1].filesHandled) monotonic = false;
    assert(monotonic, 'filesHandled is monotonic non-decreasing');
    const last = events[events.length - 1];
    assert(last.filesTotal === 2, 'progress reports filesTotal = 2');
    assert(events.some(e => e.phase === 'scan') && events.some(e => e.phase === 'history'),
      'progress emits scan and history phases');
    const maxHandled = Math.max(...events.map(e => e.filesHandled));
    assert(maxHandled === r.filesProcessed + r.filesSkippedResume,
      'final filesHandled equals processed + skipped');
    store.close();
  }

  // ── 7. B1: concurrency parity — same rows regardless of lane count ───────────
  console.log('\n── B1: parallel-walk parity ──');
  {
    const serialStore = freshIndexedStore();
    await indexInto(serialStore);
    await buildSymbolHistory(REPO, serialStore, { skipIfHeadUnchanged: false, concurrency: 1, log: () => {} });
    const serialRows = (serialStore.rawDb().prepare('SELECT COUNT(*) AS c FROM symbol_history').get() as any).c;
    const serialKeys = (serialStore.rawDb()
      .prepare('SELECT symbol_key, commit_sha FROM symbol_history ORDER BY symbol_key, commit_sha').all() as any[])
      .map(r => `${r.symbol_key}@${r.commit_sha}`).join('|');
    serialStore.close();

    const parStore = freshIndexedStore();
    await indexInto(parStore);
    await buildSymbolHistory(REPO, parStore, { skipIfHeadUnchanged: false, concurrency: 8, log: () => {} });
    const parRows = (parStore.rawDb().prepare('SELECT COUNT(*) AS c FROM symbol_history').get() as any).c;
    const parKeys = (parStore.rawDb()
      .prepare('SELECT symbol_key, commit_sha FROM symbol_history ORDER BY symbol_key, commit_sha').all() as any[])
      .map(r => `${r.symbol_key}@${r.commit_sha}`).join('|');
    parStore.close();

    assert(serialRows === parRows && serialRows > 0,
      `concurrency 1 and 8 insert the same row count (serial=${serialRows} par=${parRows})`);
    assert(serialKeys === parKeys, 'concurrency 1 and 8 produce byte-identical (symbol_key, commit_sha) sets');
  }

  // ── 8. replaceSymbolHistoryForSymbols: delete-then-insert is exact ───────────
  console.log('\n── replace semantics ──');
  {
    const store = freshIndexedStore();
    await indexInto(store);
    const sym = store.getDefinition('alphaOne')[0];
    const mk = (sha: string, at: number) => ({
      symbolId: sym.id, symbolKey: 'k', commitSha: sha, authorName: 'A', authorEmail: 'a@e',
      committedAt: at, message: 'm', linesAdded: 1, linesRemoved: 0, prNumber: null, prUrl: null,
      matchStrategy: 'overlap', confidence: 1,
    });
    store.replaceSymbolHistoryForSymbols([sym.id], [mk('aaa', 1), mk('bbb', 2)]);
    assert(store.countSymbolHistory(sym.id) === 2, 'replace inserts the initial set');
    // Replace with a DIFFERENT set — the old rows must be gone, not unioned.
    store.replaceSymbolHistoryForSymbols([sym.id], [mk('ccc', 3)]);
    const after = store.getSymbolHistory(sym.id, { limit: 10 });
    assert(after.length === 1 && after[0].commitSha === 'ccc',
      `replace removes stale rows (no union); got [${after.map(h => h.commitSha).join(',')}]`);
    // Empty replace clears.
    store.replaceSymbolHistoryForSymbols([sym.id], []);
    assert(store.countSymbolHistory(sym.id) === 0, 'replace with no rows clears the symbol history');
    store.close();
  }

  // ── 9. Thrust A: scoped (on-demand) build ────────────────────────────────────
  console.log('\n── scoped / on-demand build ──');
  {
    const store = freshIndexedStore();
    await indexInto(store);
    const scoped = await buildSymbolHistory(REPO, store, { onlyPaths: [alphaAbs], log: () => {} });
    assert(scoped.completed && scoped.filesProcessed === 1 && scoped.filesTotal === 1,
      `scoped build touched only the one requested file (proc=${scoped.filesProcessed} total=${scoped.filesTotal})`);
    assert(store.getGitIndexState()?.lastHistoryHeadSha == null,
      'scoped build does NOT stamp the global history HEAD (index not falsely marked fully built)');
    assert(store.getSymbolHistoryWatermarks(REPO).has(alphaAbs),
      'scoped build still writes the per-file watermark');
    assert(store.getSymbolHistory(store.getDefinition('alphaOne')[0].id).length > 0,
      'scoped build populated alphaOne history');
    // A SECOND scoped build of the same file resume-skips it: scoped uses the
    // per-file path (v2), so its own watermark is reused.
    const scoped2 = await buildSymbolHistory(REPO, store, { onlyPaths: [alphaAbs], log: () => {} });
    assert(scoped2.filesSkippedResume === 1,
      `repeat scoped build reuses the scoped (v2) watermark (skipped=${scoped2.filesSkippedResume})`);
    // A subsequent FULL build does NOT reuse the scoped file's watermark: a full
    // build uses the two-phase path (algorithm v3, non-simplified attribution),
    // whose rows differ from the scoped per-file path (v2). The version-aware
    // watermark deliberately forces the scoped file to be reprocessed rather
    // than presenting v2 rows as if a full v3 build produced them.
    const full = await buildSymbolHistory(REPO, store, { log: () => {} });
    assert(full.completed && full.filesSkippedResume === 0,
      `full (two-phase v3) build reprocesses the scoped (v2) file rather than cross-claiming it (skipped=${full.filesSkippedResume})`);
    assert(store.getGitIndexState()?.lastHistoryHeadSha != null,
      'full build DOES stamp the global history HEAD');
    // And the full build is now internally consistent at v3 for that file.
    const wmAfterFull = store.getSymbolHistoryWatermarks(REPO).get(alphaAbs);
    assert(wmAfterFull?.algorithmVersion === HISTORY_ALGORITHM_VERSION_TWOPHASE,
      `after the full build the scoped file carries the two-phase version (got ${wmAfterFull?.algorithmVersion})`);
    store.close();
  }

  // ── 10. Incremental auto-update: a new commit refreshes only its file ────────
  console.log('\n── incremental auto-update on new commit ──');
  {
    const store = freshIndexedStore();
    await indexInto(store);
    await buildSymbolHistory(REPO, store, { log: () => {} });
    const beforeId = store.getDefinition('alphaOne')[0].id;
    const beforeCount = store.countSymbolHistory(beforeId);

    // New commit touching alphaOne only.
    write('alpha.ts', 'export function alphaOne(): number { return 31337; }\nexport function alphaTwo(): number { return 222; }\n');
    const shaEdit3 = commit('Bump alphaOne again (#42)', 'Bob <bob@example.com>');
    await indexInto(store); // alpha.ts hash flips; its symbols (and cascade history) are replaced

    const inc = await buildSymbolHistory(REPO, store, { log: () => {} });
    assert(!inc.skipped, 'HEAD moved → incremental build runs (not skipped)');
    assert(inc.filesProcessed === 1 && inc.filesSkippedResume === 1,
      `incremental reprocesses only the changed file, skips the rest (proc=${inc.filesProcessed} skip=${inc.filesSkippedResume})`);
    const afterId = store.getDefinition('alphaOne')[0].id;
    const newHist = store.getSymbolHistory(afterId, { limit: 50 });
    assert(newHist.some(h => h.commitSha === shaEdit3),
      'the new commit appears in alphaOne history after the incremental refresh');
    assert(store.countSymbolHistory(afterId) >= beforeCount,
      `history grew or held with the new commit (before=${beforeCount} after=${store.countSymbolHistory(afterId)})`);
    // restore working tree to the new HEAD's content (clean tree)
    store.close();
  }

  // ── 11. CLI index auto-refresh preserves persisted follow=true ──────────────
  console.log('\n── CLI auto-refresh preserves follow=true ──');
  {
    const dbPath = path.join(TMP, `cli-follow-${Date.now()}.db`);
    const seed = new Store(dbPath);
    await indexInto(seed);
    seed.close();

    const fullBuild = runCli(['symbol-history', '--workspace', REPO, '--db', dbPath, '--follow']);
    assert(fullBuild.status === 0,
      `CLI full --follow build succeeds (status=${fullBuild.status})`);

    const mixStore = new Store(dbPath);
    const stateAfterFull = mixStore.getGitIndexState();
    assert(stateAfterFull?.lastHistoryFollow === true,
      `full CLI build persists lastHistoryFollow=true (got ${String(stateAfterFull?.lastHistoryFollow)})`);
    // Deliberately create a mixed watermark set: scoped build uses the default
    // follow=false on alpha.ts only. Auto-refresh must IGNORE this mixed state
    // and use the persisted full-build follow=true from git_index_state.
    await buildSymbolHistory(REPO, mixStore, { onlyPaths: [alphaAbs], log: () => {} });
    mixStore.close();

    write('gamma.ts', 'export function betaOne(): number { return 11; }\nexport function betaTwo(): number { return 20; }\n');
    const shaEdit4 = commit('Bump betaOne after follow build', 'Bob <bob@example.com>');

    const reindex = runCli(['index', REPO, '--db', dbPath]);
    assert(reindex.status === 0,
      `CLI index with auto-refresh succeeds (status=${reindex.status})`);
    assert(/Refreshing symbol history \(incremental\)\.\.\./.test(reindex.stdout),
      'CLI index ran the auto history refresh path');

    const verify = new Store(dbPath);
    const stateAfterRefresh = verify.getGitIndexState();
    assert(stateAfterRefresh?.lastHistoryFollow === true,
      `auto-refresh keeps lastHistoryFollow=true (got ${String(stateAfterRefresh?.lastHistoryFollow)})`);
    const beta = verify.getDefinition('betaOne').find(d => /gamma\.ts$/.test(d.filePath));
    assert(beta != null, 'betaOne resolves in gamma.ts after CLI reindex');
    const betaHist = beta ? verify.getSymbolHistory(beta.id, { limit: 20 }) : [];
    assert(betaHist.some(h => h.commitSha === shaAdd),
      'CLI auto-refresh preserved follow=true semantics: pre-rename add commit is still present for gamma.ts');
    assert(betaHist.some(h => h.commitSha === shaEdit4),
      'CLI auto-refresh also captured the new gamma.ts commit');
    verify.close();
  }

  // ── --since history horizon (Part 2 #A) ────────────────────────────────────
  // parseHistorySince contract + the persist/replicate property that keeps the
  // incremental post-index refresh from reprocessing every file when a horizon
  // is in effect.
  {
    const NOW = Date.UTC(2026, 5, 7, 12, 0, 0);
    assert(parseHistorySince(undefined, NOW) === undefined, 'parseHistorySince(undefined) = unbounded');
    assert(parseHistorySince('0', NOW) === undefined, "parseHistorySince('0') = unbounded");
    assert(parseHistorySince('all', NOW) === undefined, "parseHistorySince('all') = unbounded");
    assert(parseHistorySince('garbage', NOW) === null, 'parseHistorySince(typo) = null (caller errors)');
    const y2 = parseHistorySince('2y', NOW);
    assert(y2 === parseHistorySince('2.years', NOW), '2y and git-style 2.years resolve identically');
    assert(typeof y2 === 'number' && y2 % 86400 === 0, '2y is quantized to UTC midnight');
    assert(parseHistorySince('2y', NOW) === parseHistorySince('2y', NOW + 5 * 3600_000),
      'same-day relative horizon is stable (fingerprint does not drift intra-day)');
    assert(parseHistorySince('2024-01-01', NOW) === Math.floor(Date.UTC(2024, 0, 1) / 1000),
      'ISO date resolves to that instant');
    assert(parseHistorySince('1700000000', NOW) === 1700000000, 'bare integer = unix seconds');

    // Persist + replicate: a completed full build with a horizon stamps
    // last_history_since; replicating it resume-skips everything, while NOT
    // replicating it (old behavior) reprocesses — proving the replication
    // is load-bearing for incremental refreshes.
    const dbPath = path.join(TMP, `since-${Date.now()}.db`);
    const seed = new Store(dbPath);
    await indexInto(seed);
    const since = parseHistorySince('2y') as number;
    const b1 = await buildSymbolHistory(REPO, seed, { since, follow: false, log: () => {} });
    assert(b1.completed && !b1.skipped, 'full build with --since completes');
    const st = seed.getGitIndexState();
    assert(st?.lastHistorySince === since,
      `full build persists lastHistorySince (got ${String(st?.lastHistorySince)}, want ${since})`);
    const b2 = await buildSymbolHistory(REPO, seed,
      { since: st!.lastHistorySince ?? undefined, follow: st!.lastHistoryFollow ?? false, log: () => {} });
    assert(b2.skipped && b2.filesProcessed === 0,
      `replicating persisted since resume-skips all (skipped=${b2.skipped}, processed=${b2.filesProcessed})`);
    const b3 = await buildSymbolHistory(REPO, seed,
      { /* no since — mismatched fingerprint */ follow: false, skipIfHeadUnchanged: true, log: () => {} });
    assert(b3.filesProcessed > 0,
      'dropping the horizon reprocesses (confirms the fingerprint includes since)');
    seed.close();
  }

  // ── Two-phase walk (Part 2 #B) ─────────────────────────────────────────────
  // On a linear/shallow fixture history git's per-path simplification does not
  // diverge from the whole-repo name-only attribution, so the two-phase path
  // (default) and the legacy per-file path (SEER_HISTORY_LEGACY=1) must produce
  // byte-identical rows. This is the gross-correctness guard for the new path;
  // the measured ~0.8% divergence on Godot is real history-simplification, not
  // a bug, and is why the watermark version is path-aware (v3 vs v2).
  console.log('\n── two-phase vs legacy parity (linear history) ──');
  {
    const dump = (store: Store): string[] =>
      (store.rawDb().prepare(
        `SELECT s.symbol_key k, f.rel_path file, h.commit_sha sha, h.lines_added la,
                h.lines_removed lr, h.match_strategy ms
         FROM symbol_history h JOIN symbols s ON s.id = h.symbol_id JOIN files f ON f.id = s.file_id`,
      ).all() as Array<Record<string, unknown>>)
        .map(r => `${r.k}|${r.file}|${r.sha}|${r.la}|${r.lr}|${r.ms}`).sort();

    const legacyStore = freshIndexedStore();
    await indexInto(legacyStore);
    process.env.SEER_HISTORY_LEGACY = '1';
    const legacy = await buildSymbolHistory(REPO, legacyStore, { follow: false, log: () => {} });
    const legacyRows = dump(legacyStore);
    const legacyWmV = (legacyStore.rawDb().prepare(
      'SELECT DISTINCT algorithm_version v FROM symbol_history_progress').all() as Array<{ v: number }>).map(x => x.v);
    legacyStore.close();
    delete process.env.SEER_HISTORY_LEGACY;

    const twoStore = freshIndexedStore();
    await indexInto(twoStore);
    const two = await buildSymbolHistory(REPO, twoStore, { follow: false, log: () => {} });
    const twoRows = dump(twoStore);
    const twoWmV = (twoStore.rawDb().prepare(
      'SELECT DISTINCT algorithm_version v FROM symbol_history_progress').all() as Array<{ v: number }>).map(x => x.v);
    // Determinism: a second two-phase pass on a fresh store is identical.
    const twoStore2 = freshIndexedStore();
    await indexInto(twoStore2);
    await buildSymbolHistory(REPO, twoStore2, { follow: false, log: () => {} });
    const twoRows2 = dump(twoStore2);
    twoStore2.close();
    twoStore.close();

    assert(legacyWmV.length === 1 && legacyWmV[0] === HISTORY_ALGORITHM_VERSION,
      `SEER_HISTORY_LEGACY=1 forces the per-file path (watermark v${HISTORY_ALGORITHM_VERSION}, got ${legacyWmV})`);
    assert(twoWmV.length === 1 && twoWmV[0] === HISTORY_ALGORITHM_VERSION_TWOPHASE,
      `default full build uses two-phase (watermark v${HISTORY_ALGORITHM_VERSION_TWOPHASE}, got ${twoWmV})`);
    assert(legacy.historyRowsInserted === two.historyRowsInserted,
      `row counts match on linear history (legacy=${legacy.historyRowsInserted} two-phase=${two.historyRowsInserted})`);
    assert(JSON.stringify(legacyRows) === JSON.stringify(twoRows),
      'two-phase rows are byte-identical to legacy on linear-history fixture');
    assert(JSON.stringify(twoRows) === JSON.stringify(twoRows2),
      'two-phase is deterministic across runs');
  }

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.error('\n  SYMBOL-HISTORY PERF TESTS FAILED'); process.exit(1); }
  console.log('\n  All symbol-history perf tests passed! ✓');
}

run().catch(err => { console.error(err); process.exit(1); });
