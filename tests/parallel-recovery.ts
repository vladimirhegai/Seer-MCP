/**
 * Parallel parser stress & recovery tests (Step 5 of parallel parsing).
 *
 * Exercises the failure paths the audit flagged:
 *   - Per-job attempt limit: a "poison" file that crashes every worker it
 *     touches must be marked parse-error after `maxAttempts` worker deaths
 *     and the dispatch must complete (not hang).
 *   - Crashes are contained: a single sentinel-matched file inside a healthy
 *     workspace produces exactly one parse-error; every other file is parsed
 *     correctly and indexed by the indexer integration test.
 *   - Edge cases:
 *       - empty workspace runs cleanly under `parallel: true`
 *       - one-file workspace with jobs > 1 doesn't deadlock
 *       - `maxFileBytes` is honored (worker reports too-large; row pruned)
 *
 * The crash is injected via `SEER_WORKER_TEST_CRASH_ON` — when set, the worker
 * `process.exit(13)`s on any parse job whose `abs` contains that substring.
 * Production never sets the variable.
 *
 * Run with: npm run test:parallel-recovery
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Indexer } from '../src/indexer/index';
import { Store } from '../src/db/store';
import { WorkerPool, WorkItem, PoolResult } from '../src/parser/workerpool';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

function tmpDb(label: string): string {
  return path.join(os.tmpdir(), `seer-parallel-recovery-${label}-${Date.now()}.db`);
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log('\nParallel Recovery Test (Step 5)');
  console.log('=================================\n');

  // ── 1. Empty workspace ───────────────────────────────────────────────────
  console.log('── Empty workspace runs cleanly under parallel=true ──');
  {
    const root = path.join(os.tmpdir(), `seer-parallel-empty-${Date.now()}`);
    fs.mkdirSync(root, { recursive: true });
    const db = tmpDb('empty');
    const store = new Store(db);
    const indexer = new Indexer(store);
    const res = await indexer.indexDirectory(root, { quiet: true, parallel: true });
    store.close();
    assert(res.filesIndexed === 0, 'empty workspace: filesIndexed=0');
    assert(res.symbols === 0, 'empty workspace: symbols=0');
    assert(res.pagerankRecomputed === false, 'empty workspace: no PageRank recompute');
    fs.rmSync(root, { recursive: true, force: true });
    try { fs.unlinkSync(db); } catch { /* */ }
  }

  // ── 2. Single-file workspace with jobs=8 doesn't deadlock ────────────────
  console.log('\n── Single-file workspace, jobs=8 ──');
  {
    const root = path.join(os.tmpdir(), `seer-parallel-single-${Date.now()}`);
    fs.mkdirSync(root, { recursive: true });
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.ts'), path.join(root, 'sample.ts'));
    const db = tmpDb('single');
    const store = new Store(db);
    const indexer = new Indexer(store);
    const res = await indexer.indexDirectory(root, { quiet: true, parallel: true, jobs: 8 });
    store.close();
    assert(res.filesIndexed === 1, 'single file: filesIndexed=1');
    assert(res.symbols > 0, 'single file: symbols extracted');
    fs.rmSync(root, { recursive: true, force: true });
    try { fs.unlinkSync(db); } catch { /* */ }
  }

  // ── 3. maxFileBytes enforcement ──────────────────────────────────────────
  console.log('\n── maxFileBytes enforcement (parallel) ──');
  {
    const root = path.join(os.tmpdir(), `seer-parallel-toolarge-${Date.now()}`);
    fs.mkdirSync(root, { recursive: true });
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.ts'), path.join(root, 'small.ts'));
    // Build a 50 KB file that exceeds the cap.
    fs.writeFileSync(path.join(root, 'big.ts'), 'const x = 1;\n'.repeat(5000));
    const db = tmpDb('toolarge');
    const store = new Store(db);
    const indexer = new Indexer(store);
    const res = await indexer.indexDirectory(root, {
      quiet: true, parallel: true, jobs: 2, maxFileBytes: 8192,
    });
    store.close();
    assert(res.filesSkippedTooLarge === 1, `one file skipped as too-large (got ${res.filesSkippedTooLarge})`);
    assert(res.filesIndexed === 1, `the other file was indexed (got ${res.filesIndexed})`);
    fs.rmSync(root, { recursive: true, force: true });
    try { fs.unlinkSync(db); } catch { /* */ }
  }

  // ── 4. Poison job hits attempt limit → parse-error (pool layer) ──────────
  console.log('\n── Poison job hits maxAttempts → parse-error ──');
  {
    process.env.SEER_WORKER_TEST_CRASH_ON = 'POISON_SENTINEL';
    try {
      const pool = new WorkerPool({ jobs: 2, maxAttempts: 3 });
      await pool.ready();
      const goodPath = path.join(FIXTURES_DIR, 'sample.ts');
      const poisonPath = path.join(os.tmpdir(), `POISON_SENTINEL-${Date.now()}.ts`);
      // The poison file doesn't actually need to exist on disk — the worker
      // crashes BEFORE it tries to read.
      const items: WorkItem[] = [
        { abs: goodPath,   lang: 'typescript', expectedHash: null, maxFileBytes: 0 },
        { abs: poisonPath, lang: 'typescript', expectedHash: null, maxFileBytes: 0 },
        { abs: goodPath,   lang: 'typescript', expectedHash: null, maxFileBytes: 0 },
      ];
      const results: PoolResult[] = [];
      await pool.dispatch(items, (seq, result) => { results[seq] = result; });
      assert(results.length === 3, 'all 3 items delivered (no hang)');
      assert(results[0].kind === 'parsed', 'good file 0 parsed');
      assert(results[1].kind === 'parse-error', `poison file synthesized parse-error (got ${results[1]?.kind})`);
      assert(results[2].kind === 'parsed', 'good file 2 parsed (pool recovered after the crash)');
      await pool.shutdown();
    } finally {
      delete process.env.SEER_WORKER_TEST_CRASH_ON;
    }
  }

  // ── 5. Many crashes don't deadlock the pool ──────────────────────────────
  console.log('\n── Many poison jobs interleaved with healthy ones ──');
  {
    process.env.SEER_WORKER_TEST_CRASH_ON = 'POISON_MANY';
    try {
      const pool = new WorkerPool({ jobs: 4, maxAttempts: 2 });
      await pool.ready();
      const goodPath = path.join(FIXTURES_DIR, 'sample.ts');
      const items: WorkItem[] = [];
      for (let i = 0; i < 12; i++) {
        const isPoison = i % 3 === 0; // 4 of 12 are poison
        items.push({
          abs: isPoison
            ? path.join(os.tmpdir(), `POISON_MANY-${i}.ts`)
            : goodPath,
          lang: 'typescript', expectedHash: null, maxFileBytes: 0,
        });
      }
      const kinds: string[] = [];
      await pool.dispatch(items, (seq, result) => { kinds[seq] = result.kind; });
      assert(kinds.length === 12, '12 items delivered (no hang under 4 poison + 8 healthy)');
      const goodCount     = kinds.filter(k => k === 'parsed').length;
      const errorCount    = kinds.filter(k => k === 'parse-error').length;
      assert(goodCount === 8, `8 healthy parses (got ${goodCount})`);
      assert(errorCount === 4, `4 poison parse-errors (got ${errorCount})`);
      await pool.shutdown();
    } finally {
      delete process.env.SEER_WORKER_TEST_CRASH_ON;
    }
  }

  // ── 6. Indexer integration: parallel run with one poison file ────────────
  console.log('\n── Indexer integration: worker WASM reset count is aggregated ──');
  {
    const root = path.join(os.tmpdir(), `seer-parallel-reset-aggregation-${Date.now()}`);
    fs.mkdirSync(root, { recursive: true });
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.ts'), path.join(root, 'FAKE_WASM_RESET_INDEXER.ts'));
    process.env.SEER_WORKER_TEST_FAKE_WASM_RESET_ON = 'FAKE_WASM_RESET_INDEXER';
    try {
      const db = tmpDb('reset-aggregation');
      const store = new Store(db);
      const indexer = new Indexer(store);
      const res = await indexer.indexDirectory(root, {
        quiet: true, parallel: true, jobs: 1,
      });
      store.close();
      assert(res.filesIndexed === 1, `reset aggregation fixture indexed (got ${res.filesIndexed})`);
      assert(res.wasmResets === 1, `IndexResult aggregates worker-local wasm resets (got ${res.wasmResets})`);
      try { fs.unlinkSync(db); } catch { /* */ }
    } finally {
      delete process.env.SEER_WORKER_TEST_FAKE_WASM_RESET_ON;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── 7. Indexer integration: parallel run with one poison file ────────────
  console.log('\n── Indexer integration: parallel + one poison file ──');
  {
    const root = path.join(os.tmpdir(), `seer-parallel-indexer-recovery-${Date.now()}`);
    fs.mkdirSync(root, { recursive: true });
    // Stage a couple of healthy fixtures plus the poison file.
    for (const f of ['sample.ts', 'sample.py']) {
      fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(root, f));
    }
    // The poison file MUST exist on disk so discoverFiles picks it up; the
    // worker exits before opening it though, so content is irrelevant.
    fs.writeFileSync(path.join(root, 'POISON_INDEXER.ts'), 'const x = 1;\n');
    process.env.SEER_WORKER_TEST_CRASH_ON = 'POISON_INDEXER';
    try {
      const db = tmpDb('indexer-recovery');
      const store = new Store(db);
      const indexer = new Indexer(store);
      const res = await indexer.indexDirectory(root, {
        quiet: true, parallel: true, jobs: 2,
      });
      store.close();
      assert(res.filesIndexed === 2, `2 healthy files indexed (got ${res.filesIndexed})`);
      assert(res.filesParseError === 1, `1 file reported as parse-error (got ${res.filesParseError})`);
      // The poison file's row should still exist (upsert with hash+lines was
      // synthesized from the parse-error result), so it's not pruned.
      const store2 = new Store(db);
      const filesNow = store2.listFiles().map(f => f.relPath);
      store2.close();
      assert(filesNow.includes('POISON_INDEXER.ts'), 'poison file row preserved (not pruned)');
      try { fs.unlinkSync(db); } catch { /* */ }
    } finally {
      delete process.env.SEER_WORKER_TEST_CRASH_ON;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ── Deferred reverse-traversal index: lifecycle + failure restore ──────────
  // A bulk fresh index drops idx_edges_to_id_kind_from for the insert+resolve,
  // then rebuilds it. It must end up present on BOTH a successful index AND a
  // failed one (the finally/catch safety net), so reverse-traversal queries are
  // never left to fall back to a full scan.
  console.log('\n── Deferred reverse index is restored on success AND on failure ──');
  {
    const hasRevIndex = (db: string): boolean => {
      const s = new Store(db);
      const row = s.rawDb().prepare(
        "SELECT 1 AS x FROM sqlite_master WHERE type='index' AND name='idx_edges_to_id_kind_from'",
      ).get() as { x: number } | undefined;
      s.close();
      return !!row;
    };
    // A bulk fixture (>= the parallel/defer threshold) of trivial files that
    // each define + call a function, so edges actually exist.
    const root = path.join(os.tmpdir(), `seer-defer-idx-${Date.now()}`);
    fs.mkdirSync(root, { recursive: true });
    for (let i = 0; i < 130; i++) {
      fs.writeFileSync(
        path.join(root, `f${i}.ts`),
        `export function f${i}(): number { return helper${i}(); }\nfunction helper${i}(): number { return ${i}; }\n`,
        'utf8',
      );
    }
    try {
      // 1. Successful fresh bulk index → index present.
      const dbOk = tmpDb('defer-ok');
      const okStore = new Store(dbOk);
      const okRes = await new Indexer(okStore).indexDirectory(root, { quiet: true });
      okStore.close();
      assert(okRes.filesIndexed >= 130, `bulk fixture indexed (${okRes.filesIndexed} files)`);
      assert(hasRevIndex(dbOk), 'reverse index present after a successful deferred bulk index');
      try { fs.unlinkSync(dbOk); } catch { /* */ }

      // 2. Failed index (resolveEdges throws mid-pass, after the drop) → the
      //    safety net must still restore the index.
      const dbFail = tmpDb('defer-fail');
      const failStore = new Store(dbFail);
      const realResolve = failStore.resolveEdges.bind(failStore);
      void realResolve;
      (failStore as unknown as { resolveEdges: () => never }).resolveEdges = () => {
        throw new Error('injected resolveEdges failure');
      };
      let threw = false;
      try {
        await new Indexer(failStore).indexDirectory(root, { quiet: true });
      } catch {
        threw = true;
      }
      failStore.close();
      assert(threw, 'index attempt with a thrown resolveEdges rejects (as expected)');
      assert(hasRevIndex(dbFail), 'reverse index RESTORED after a failed deferred bulk index');
      try { fs.unlinkSync(dbFail); } catch { /* */ }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  Parallel-recovery results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\n  PARALLEL-RECOVERY TESTS FAILED\n');
    process.exit(1);
  } else {
    console.log('\n  All parallel-recovery tests passed! ✓\n');
  }
}

run().catch(err => {
  console.error('parallel-recovery test threw:', err);
  process.exit(1);
});
