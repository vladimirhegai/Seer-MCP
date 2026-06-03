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
  buildSymbolHistory, HISTORY_ALGORITHM_VERSION, SymbolHistoryProgress,
} from '../src/indexer/symbolhistory';

const TMP = path.join(os.tmpdir(), `seer-symhist-${Date.now()}`);
const REPO = path.join(TMP, 'repo');

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
    const newCommits = await commitsWithDiffsForFile(REPO, fileAbs, { limit: 200, assumeRepo: true });
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

  // gamma.ts must have followed the rename back to its add as beta.ts.
  const gammaCombined = await commitsWithDiffsForFile(REPO, gammaAbs, { limit: 200, assumeRepo: true });
  assert(gammaCombined.some(c => c.sha === shaAdd && c.isFileAddition),
    'gamma.ts: --follow reached the original add (as beta.ts) and flagged it as a file addition');

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

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.error('\n  SYMBOL-HISTORY PERF TESTS FAILED'); process.exit(1); }
  console.log('\n  All symbol-history perf tests passed! ✓');
}

run().catch(err => { console.error(err); process.exit(1); });
