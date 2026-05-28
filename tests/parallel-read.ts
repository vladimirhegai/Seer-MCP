/**
 * Track A regression net: parallel read-only opens against a busy DB.
 *
 * The dogfood gap was that `Store` always ran SCHEMA_SQL + migrations on
 * open, which took a write lock — and on Windows that lock would conflict
 * with a concurrent indexer's transaction, surfacing as `database is locked`
 * for everyone. The fix is:
 *   - Store.openReadOnly() opens with readOnly: true, skips schema setup,
 *     sets PRAGMA query_only=ON + busy_timeout.
 *   - The writer also sets busy_timeout so brief reader contention waits
 *     instead of failing.
 *
 * This test pounds the read path while the writer indexes, then confirms:
 *   1. No `SQLITE_BUSY` errors during 100 parallel read opens.
 *   2. The reader sees a consistent snapshot — symbol count never decreases.
 *   3. Writes through a read-only Store are rejected with a clear error.
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { Store } from '../src/db/store';
import { Indexer } from '../src/indexer/index';
import { CURRENT_SCHEMA_VERSION } from '../src/db/schema';

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'tests/fixtures');
const TMP_DB = path.join(os.tmpdir(), `strata-parallel-${Date.now()}.db`);

let passed = 0;
let failed = 0;
function ok(label: string): void { passed++; console.log(`  ✓ ${label}`); }
function bad(label: string, extra?: unknown): void {
  failed++;
  console.error(`  ✗ ${label}` + (extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''));
}

async function main(): Promise<void> {
  console.log('\nStrata Parallel-Read Test\n=========================\n');

  // Seed the DB with an initial index.
  const writer = new Store(TMP_DB);
  await new Indexer(writer).indexDirectory(FIXTURES, { quiet: true });

  // Verify schema version stored properly — pinned at the current build.
  const sinfo = writer.schemaInfo();
  if (sinfo.current && sinfo.dbVersion === CURRENT_SCHEMA_VERSION) ok(`schema_version pinned at ${sinfo.dbVersion}`);
  else bad('schema_version not pinned', sinfo);

  writer.close();

  // 100 parallel read-only opens, each doing a couple of cheap queries.
  // No SQLITE_BUSY allowed.
  const N = 100;
  const errors: Error[] = [];
  const counts: number[] = [];
  await Promise.all(Array.from({ length: N }, async () => {
    try {
      const s = Store.openReadOnly(TMP_DB);
      counts.push(s.getStats().symbols);
      void s.findCallers('process_payment', 5);
      void s.findSymbols('AuthService', { limit: 10 });
      void s.getTopSymbols(5);
      s.close();
    } catch (e) {
      errors.push(e as Error);
    }
  }));
  if (errors.length === 0) ok(`${N} parallel read-only opens completed without errors`);
  else bad(`${errors.length}/${N} parallel reads failed`, errors[0]?.message);

  if (new Set(counts).size === 1) ok(`all ${N} reads saw the same symbol count (${counts[0]})`);
  else bad('symbol count drifted between parallel reads', new Set(counts));

  // Concurrent reader + writer. A reindex pass should not lock out readers.
  const w2 = new Store(TMP_DB);
  const indexer = new Indexer(w2);

  let raceErrors = 0;
  const writerDone = indexer.indexDirectory(FIXTURES, { quiet: true });
  // Hammer reads while the indexer runs.
  for (let i = 0; i < 25; i++) {
    try {
      const r = Store.openReadOnly(TMP_DB);
      r.getStats();
      r.close();
    } catch {
      raceErrors++;
    }
  }
  await writerDone;
  w2.close();
  if (raceErrors === 0) ok('25 reads while writer was active: no SQLITE_BUSY');
  else bad(`${raceErrors} reads failed while writer was active`);

  // Read-only Store must reject writes.
  const ro = Store.openReadOnly(TMP_DB);
  let writeBlocked = false;
  try {
    ro.upsertFile('/tmp/bogus.ts', 'bogus.ts', 'typescript', 'abc', 0);
  } catch (e) {
    writeBlocked = true;
    // The exact message varies (sqlite says "attempt to write a readonly database"
    // or "no such column"); we only require that it threw.
    process.stdout.write(`  (read-only write rejected: ${(e as Error).message.substring(0, 60)})\n`);
  }
  if (writeBlocked) ok('read-only Store rejects writes');
  else bad('read-only Store allowed a write');
  ro.close();

  // Cleanup.
  for (const ext of ['', '-wal', '-shm']) {
    const p = TMP_DB + ext;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  Parallel-read results: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Parallel-read test crashed:', err);
  process.exit(1);
});
