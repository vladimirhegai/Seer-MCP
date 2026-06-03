/**
 * Track F feature tests — portability and precision.
 *
 * Exercises:
 *   - Schema v7 columns (provenance, shape_hash) and scip_imports table
 *   - Structural SimHash duplicate detection (shape-folded across renames)
 *   - Portable .seerbundle export → import round trip + integrity check
 *   - SCIP JSON import: additive precision, source-labelled, idempotent
 *   - getStats() includes provenance + scipImports + shapeHashed
 *
 * Run with: npx tsx tests/trackf.ts
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { Indexer } from '../src/indexer/index';
import { Store } from '../src/db/store';
import { exportBundle } from '../src/bundle/export';
import { importBundle, readBundleManifest } from '../src/bundle/import';
import { importScip } from '../src/scip/import';
import {
  computeShapeHash, hammingDistance, tokenize, findDuplicates, buildShapeHashes,
} from '../src/indexer/shapehash';

const FIXTURES = path.join(__dirname, 'fixtures-trackf');
const TMP_DIR = path.join(os.tmpdir(), `seer-trackf-${Date.now()}`);
const TMP_DB = path.join(TMP_DIR, 'graph.db');

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}`); failed++; }
}
function safeStr(v: unknown): string {
  if (typeof v === 'bigint') return `0x${v.toString(16)}`;
  try { return JSON.stringify(v); }
  catch { return String(v); }
}
function assertEq<T>(actual: T, expected: T, msg: string): void {
  assert(actual === expected, `${msg} (got ${safeStr(actual)}, expected ${safeStr(expected)})`);
}

function cleanup(): void {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* */ }
}

async function run(): Promise<void> {
  console.log('\nSeer Track F Feature Tests');
  console.log('============================\n');

  if (!fs.existsSync(FIXTURES)) {
    console.error(`Missing fixtures dir: ${FIXTURES}`);
    process.exit(1);
  }

  fs.mkdirSync(TMP_DIR, { recursive: true });

  // ── Tokenizer & shape hash unit tests ───────────────────────────────────
  console.log('── tokenize() + computeShapeHash() ──');
  const tokA = tokenize('function foo(x: number) { return x + 1; }');
  const tokB = tokenize('function bar(y: number) { return y + 1; }');
  // Renames fold to NAME — token streams must equal.
  assertEq(JSON.stringify(tokA), JSON.stringify(tokB), 'identifier-folded token streams match across renames');

  const opCount = tokA.filter(t => t.kind === 'OP').length;
  assert(opCount > 0, 'tokenizer emits OP tokens');
  assert(tokA.every(t => t.kind === 'NAME' || t.kind === 'OP' || t.kind === 'NUMBER'),
    'token kinds are folded categories');

  const hashA = computeShapeHash('function foo(x: number) { return x + 1; }\n'.repeat(3));
  const hashB = computeShapeHash('function bar(y: number) { return y + 1; }\n'.repeat(3));
  assert(hashA !== null && hashB !== null, 'computeShapeHash returns a hash for both');
  if (hashA && hashB) {
    assertEq(hashA, hashB, 'shape hash identical after renames');
    assertEq(hammingDistance(hashA, hashB), 0, 'Hamming distance = 0 for identical shapes');
  }

  const hashC = computeShapeHash('function totallyDifferent() {\n  while (true) {\n    if (Math.random() > 0.5) {\n      break;\n    } else {\n      continue;\n    }\n  }\n}\n');
  if (hashA && hashC) {
    const d = hammingDistance(hashA, hashC);
    assert(d > 6, `differently-shaped functions produce a different hash (distance ${d} > 6)`);
  }

  const hashTiny = computeShapeHash('x;');
  assertEq(hashTiny, null, 'tiny input below minTokens → null hash');

  // ── Index the fixtures ───────────────────────────────────────────────────
  console.log('\n── Indexing fixtures-trackf/ ──');
  const store = new Store(TMP_DB);
  const indexer = new Indexer(store);
  const r = await indexer.indexDirectory(FIXTURES, { quiet: true });
  console.log(`  files=${r.filesIndexed} symbols=${r.symbols} edges=${r.edges} shapeHashesAdded=${r.shapeHashesAdded}`);
  assert(r.filesIndexed >= 2, 'indexed both source files');
  assert((r.shapeHashesAdded ?? 0) >= 3, `shape hash pass ran during index (got ${r.shapeHashesAdded})`);

  // ── Schema is v9 with v7 columns still present ──────────────────────────
  console.log('\n── Schema v9 (v7 columns intact) ──');
  const schema = store.schemaInfo();
  assertEq(schema.current, true, 'schema is current');
  assertEq(schema.dbVersion, 11, 'schema version is v11');
  assertEq(store.hasV7(), true, 'hasV7() reports true');

  const cols = store.rawDb().prepare("PRAGMA table_info('symbols')").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map(c => String(c.name)));
  assert(colNames.has('provenance'), 'symbols.provenance column exists');
  assert(colNames.has('shape_hash'), 'symbols.shape_hash column exists');
  const edgeCols = store.rawDb().prepare("PRAGMA table_info('edges')").all() as Array<{ name: string }>;
  assert(edgeCols.some(c => String(c.name) === 'provenance'), 'edges.provenance column exists');

  // ── Default provenance is tree-sitter ────────────────────────────────────
  console.log('\n── Default provenance ──');
  const stats = store.getStats();
  assert((stats.provenance?.symbols['tree-sitter'] ?? 0) > 0, 'tree-sitter symbols present');
  assertEq(stats.provenance?.symbols.scip ?? 0, 0, 'no SCIP symbols yet');
  assertEq(stats.scipImports ?? -1, 0, 'no SCIP imports yet');
  assert((stats.shapeHashed ?? 0) >= 3, `shapeHashed counter ≥ 3 (got ${stats.shapeHashed})`);

  // ── SimHash duplicates: fetchUserById ≡ fetchOrderById ───────────────────
  console.log('\n── Duplicate detection (SimHash) ──');
  const clusters = findDuplicates(store, { maxDistance: 4, minLoc: 3 });
  console.log(`  ${clusters.length} cluster(s):`);
  for (const c of clusters) {
    console.log(`    fp=${c.fingerprint.toString(16).slice(0, 12)} size=${c.symbols.length}`);
    for (const s of c.symbols) {
      console.log(`      d=${s.hammingFromAnchor} ${s.qualifiedName ?? s.name}  ${s.file}:${s.lineStart + 1}`);
    }
  }
  assert(clusters.length >= 1, 'at least one duplicate cluster found');
  const fetchCluster = clusters.find(c =>
    c.symbols.some(s => s.name === 'fetchUserById') &&
    c.symbols.some(s => s.name === 'fetchOrderById'));
  assert(fetchCluster !== undefined,
    'fetchUserById + fetchOrderById are in the same duplicate cluster');
  if (fetchCluster) {
    // The renamed-twin pair must have hamming distance 0 (identical shape).
    const ord = fetchCluster.symbols.find(s => s.name === 'fetchOrderById')!;
    assertEq(ord.hammingFromAnchor, 0,
      'fetchOrderById has 0 Hamming distance from the fetchUserById anchor');
  }
  // sumNumbers must NOT be in the fetch cluster.
  const sumInFetchCluster = fetchCluster?.symbols.some(s => s.name === 'sumNumbers') ?? false;
  assertEq(sumInFetchCluster, false, 'sumNumbers is not clustered with the fetch* twins');

  // Forcing re-hash is a no-op on hashed symbols (idempotent counters).
  const reHash = buildShapeHashes(store);
  assertEq(reHash.symbolsHashed, 0,
    're-running buildShapeHashes is a no-op (no symbols missing a hash)');

  // ── Portable bundle: export → integrity round-trip → import ──────────────
  console.log('\n── Portable bundle (export + import) ──');
  const bundleOut = path.join(TMP_DIR, 'test.seerbundle');
  const exp = await exportBundle(TMP_DB, FIXTURES, { out: bundleOut, compressionLevel: 9 });
  assert(fs.existsSync(bundleOut), 'bundle file exists on disk');
  assert(exp.bytes > 100, `bundle has meaningful size (${exp.bytes} bytes)`);
  assertEq(exp.manifest.schemaVersion, 11, 'manifest.schemaVersion = 11');
  assertEq(exp.manifest.bundleFormatVersion, 1, 'manifest.bundleFormatVersion = 1');
  assert(exp.manifest.source.rosterHash.length === 64, 'rosterHash is sha256-length');
  assert(exp.manifest.dbSha256.length === 64, 'dbSha256 is sha256-length');
  assert(exp.manifest.index.symbols >= 3, 'manifest.index.symbols ≥ 3');
  assert(exp.manifest.index.modules >= 0, 'manifest.index.modules present');
  assert(exp.manifest.scipImports.length === 0, 'manifest.scipImports empty pre-SCIP');

  // readBundleManifest doesn't decompress the DB — should be cheap.
  const manifestPeek = readBundleManifest(bundleOut);
  assertEq(manifestPeek.dbSha256, exp.manifest.dbSha256, 'readBundleManifest matches the exporter');

  // Import to a different DB location and verify it works.
  store.close();
  const importedDb = path.join(TMP_DIR, 'imported.db');
  const imp = await importBundle(bundleOut, {
    repoRoot: FIXTURES, dbOut: importedDb,
  });
  assert(fs.existsSync(importedDb), 'imported DB file exists');
  assertEq(imp.manifest.dbSha256, exp.manifest.dbSha256, 'import manifest sha matches export');
  assertEq(imp.dbPath, importedDb, 'import wrote to requested path');

  // Open the imported DB and verify it has the same symbol count.
  const imported = Store.openReadOnly(importedDb);
  try {
    const istat = imported.getStats();
    assertEq(istat.symbols, exp.manifest.index.symbols,
      'imported DB has the same symbol count as the manifest');
    assertEq(istat.edges, exp.manifest.index.edges,
      'imported DB has the same edge count as the manifest');
    assertEq(imported.schemaInfo().dbVersion, 11, 'imported DB is schema v11');
  } finally { imported.close(); }

  // Refuse-to-overwrite contract.
  let threw = false;
  try {
    await importBundle(bundleOut, { repoRoot: FIXTURES, dbOut: importedDb });
  } catch (err) {
    threw = (err as Error).message.includes('overwrite');
  }
  assert(threw, 'second import without overwrite=true refuses');

  // Overwrite explicit.
  const imp2 = await importBundle(bundleOut, {
    repoRoot: FIXTURES, dbOut: importedDb, overwrite: true,
  });
  assertEq(imp2.dbPath, importedDb, 'overwrite=true completes');

  // Corrupted bundle: tamper one byte → integrity check fails.
  console.log('\n── Bundle integrity check ──');
  const badBundle = path.join(TMP_DIR, 'bad.seerbundle');
  const orig = fs.readFileSync(bundleOut);
  const tampered = Buffer.from(orig);
  // Flip a byte well inside the compressed DB section (past manifest).
  const manifestLen = orig.readUInt32BE(8);
  const flipIndex = 12 + manifestLen + 24;
  if (flipIndex < tampered.length) tampered[flipIndex] = tampered[flipIndex] ^ 0xFF;
  fs.writeFileSync(badBundle, tampered);
  threw = false;
  let badErr: string | null = null;
  try {
    await importBundle(badBundle, {
      repoRoot: FIXTURES, dbOut: path.join(TMP_DIR, 'bad-out.db'),
    });
  } catch (err) {
    badErr = (err as Error).message;
    // Any of: explicit integrity check, gunzip decode error, sha mismatch.
    threw = true;
  }
  assert(threw, `tampered bundle is rejected (got error: ${badErr})`);

  // Bad magic.
  const noMagic = path.join(TMP_DIR, 'no-magic.seerbundle');
  fs.writeFileSync(noMagic, Buffer.from('NOPE0001000000000', 'utf-8'));
  threw = false;
  try {
    await importBundle(noMagic, {
      repoRoot: FIXTURES, dbOut: path.join(TMP_DIR, 'no-magic.db'),
    });
  } catch (err) {
    threw = (err as Error).message.includes('Not a Seer bundle');
  }
  assert(threw, 'bundle with bad magic is rejected');

  // ── SCIP import: precision overlay, additive, source-labelled ────────────
  console.log('\n── SCIP precision import ──');

  // Re-open writeable for SCIP.
  const wstore = new Store(TMP_DB);
  try {
    // Pre-SCIP baseline.
    const beforeProv = wstore.getProvenanceCounts();
    const beforeTSSymbols = beforeProv.symbols['tree-sitter'];
    const beforeTSEdges = beforeProv.edges['tree-sitter'];
    assert(beforeTSSymbols > 0, 'tree-sitter symbols exist pre-SCIP');

    // Hand-author a SCIP doc that adds a new symbol AND confirms an existing
    // tree-sitter one (AuthService.login).
    const scipJson = {
      tool: 'scip-test/0.1.0',
      projectRoot: FIXTURES,
      documents: [
        {
          relativePath: 'src/auth.ts',
          symbols: [
            {
              symbolId: 'auth#AuthService.login',
              displayName: 'login',
              qualifiedName: 'AuthService.login',
              kind: 'method',
              relativePath: 'src/auth.ts',
              // Match the tree-sitter row's line range — should merge.
              range: { startLine: 3, startCharacter: 0, endLine: 6, endCharacter: 1 },
            },
            {
              symbolId: 'auth#scipOnlyHelper',
              displayName: 'scipOnlyHelper',
              qualifiedName: 'scipOnlyHelper',
              kind: 'function',
              relativePath: 'src/auth.ts',
              // Outside any existing tree-sitter symbol's range → fresh row.
              range: { startLine: 28, startCharacter: 0, endLine: 30, endCharacter: 1 },
            },
          ],
          occurrences: [
            // reference from scipOnlyHelper → login
            {
              symbolId: 'auth#AuthService.login',
              relativePath: 'src/auth.ts',
              range: { startLine: 29, startCharacter: 2, endLine: 29, endCharacter: 7 },
              role: 'reference',
            },
          ],
        },
      ],
    };
    const scipPath = path.join(TMP_DIR, 'auth.scip.json');
    fs.writeFileSync(scipPath, JSON.stringify(scipJson, null, 2));

    const scipResult = await importScip(scipPath, wstore, { repoRoot: FIXTURES });
    console.log(`  docs=${scipResult.documentsProcessed} new=${scipResult.symbolsInserted} merged=${scipResult.symbolsMerged} edges=${scipResult.edgesInserted}`);
    assertEq(scipResult.documentsProcessed, 1, '1 SCIP doc processed');
    assert(scipResult.symbolsInserted >= 1, '≥1 new SCIP symbol inserted (scipOnlyHelper)');
    assert(scipResult.symbolsMerged >= 1, '≥1 SCIP symbol merged with tree-sitter (AuthService.login)');
    assertEq(scipResult.edgesInserted, 1, '1 SCIP edge inserted');
    assertEq(scipResult.filesMissing, 0, 'no SCIP files missing from the index');

    // tree-sitter rows survive (additive, not destructive).
    const afterProv = wstore.getProvenanceCounts();
    assert(afterProv.symbols['tree-sitter'] + afterProv.symbols['scip-merge'] === beforeTSSymbols,
      'no tree-sitter symbols destroyed (merged ones moved to scip-merge bucket)');
    assert(afterProv.symbols.scip >= 1, 'SCIP-pure symbols exist');
    assert(afterProv.symbols['scip-merge'] >= 1, 'scip-merge symbols exist (precision confirmed)');
    assert(afterProv.edges.scip === 1, '1 SCIP-provenance edge in the DB');
    assert(afterProv.edges['tree-sitter'] >= beforeTSEdges,
      'tree-sitter edges preserved');

    // Idempotent: re-importing same file is a no-op.
    const reScip = await importScip(scipPath, wstore, { repoRoot: FIXTURES });
    assertEq(reScip.symbolsInserted, 0, 're-import inserts 0 symbols (idempotent)');
    assertEq(reScip.edgesInserted, 0, 're-import inserts 0 edges (idempotent)');

    // scip_imports table records the layer.
    const scipImports = wstore.listScipImports();
    assertEq(scipImports.length, 1, 'one row in scip_imports');
    assertEq(scipImports[0].tool, 'scip-test/0.1.0', 'tool field captured');
    assert(scipImports[0].sha256.length === 64, 'sha256 stored');

    // hasScipImport idempotency probe.
    assertEq(wstore.hasScipImport(scipImports[0].path, scipImports[0].sha256), true,
      'hasScipImport(path, sha) = true for the recorded layer');

    // Modify the SCIP file → sha changes → re-import clears previous SCIP-pure rows.
    const scipJson2 = JSON.parse(JSON.stringify(scipJson));
    scipJson2.tool = 'scip-test/0.2.0';
    fs.writeFileSync(scipPath, JSON.stringify(scipJson2, null, 2));
    const scipResult2 = await importScip(scipPath, wstore, { repoRoot: FIXTURES });
    assert(scipResult2.symbolsInserted + scipResult2.symbolsMerged >= 2,
      're-import after content change inserts/merges again');
    const scipImports2 = wstore.listScipImports();
    assertEq(scipImports2.length, 1, 'still one row (same path, new sha replaces)');
    assertEq(scipImports2[0].tool, 'scip-test/0.2.0', 'tool field updated');

    // clearScipProvenance(path) removes ONLY that path's SCIP rows.
    const cleared = wstore.clearScipProvenance(scipImports2[0].path);
    assert(cleared >= 1, 'clearScipProvenance removed at least one row');
    assertEq(wstore.listScipImports().length, 0, 'scip_imports table emptied');
    const afterClear = wstore.getProvenanceCounts();
    assertEq(afterClear.symbols.scip, 0, 'no SCIP-pure symbols after clear');
    assertEq(afterClear.symbols['scip-merge'], 0, 'scip-merge demoted back to tree-sitter');

    // ── Stats includes Track-F fields ──────────────────────────────────────
    console.log('\n── Stats includes Track-F fields ──');
    const finalStats = wstore.getStats();
    assert(finalStats.provenance != null, 'stats.provenance present');
    assert(finalStats.scipImports != null, 'stats.scipImports present');
    assert(finalStats.shapeHashed != null && finalStats.shapeHashed >= 3, 'stats.shapeHashed populated');
  } finally { wstore.close(); }

  // ── Negative path: importing into a wholly fresh DB should still work ──
  console.log('\n── Bundle import lands an idle DB ──');
  const idleDb = path.join(TMP_DIR, 'idle.db');
  const restored = await importBundle(bundleOut, {
    repoRoot: FIXTURES, dbOut: idleDb,
  });
  assertEq(restored.manifest.schemaVersion, 11, 'restored DB schema v11');
  const restoredStore = Store.openReadOnly(idleDb);
  try {
    const rstat = restoredStore.getStats();
    assertEq(rstat.symbols, exp.manifest.index.symbols,
      'restored idle DB has the exported symbol count');
  } finally { restoredStore.close(); }

  cleanup();

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\n  TRACK F TESTS FAILED\n');
    process.exit(1);
  }
  console.log('\n  All Track F features verified. ✓\n');
}

run().catch(err => {
  console.error('trackf crashed:', err);
  try { cleanup(); } catch { /* */ }
  process.exit(1);
});

// Silence unused-import warning for crypto (used in test helpers below).
void crypto;
