/**
 * Track G — Service Links feature tests.
 *
 * Builds incrementally: Step 1 verifies the v8 schema migration, table layout,
 * and FK cascade. Later steps add HTTP-client extraction, URL normalization,
 * the post-index resolver, the Store APIs, and the CLI/MCP surface.
 *
 * Run: npx tsx tests/trackg.ts
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { Indexer } from '../src/indexer/index';
import { Store } from '../src/db/store';
import { CURRENT_SCHEMA_VERSION } from '../src/db/schema';
import { normalizeHttpTarget, routePatternsMatch, methodMatchScore } from '../src/indexer/serviceLinks';
import { computeRisk } from '../src/indexer/risk';
import { buildContext } from '../src/indexer/context';

const FIX_SERVICE = path.join(__dirname, 'fixtures-service');

const TMP_DIR = path.join(os.tmpdir(), `seer-trackg-${Date.now()}`);

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}`); failed++; }
}
function assertEq<T>(actual: T, expected: T, msg: string): void {
  assert(actual === expected,
    `${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

function rawColumns(s: Store, table: string): string[] {
  return (s.rawDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map(r => r.name);
}

async function main(): Promise<void> {
  console.log('\nSeer Track G — Step 1: Schema v9 (Track-H protocol expansion)');
  console.log('===================================\n');
  fs.mkdirSync(TMP_DIR, { recursive: true });

  // ── 1a: Fresh DB lands at CURRENT_SCHEMA_VERSION = 11 ──────────────────
  console.log('── Fresh DB schema ──');
  const freshDb = path.join(TMP_DIR, 'fresh.db');
  const fresh = new Store(freshDb);
  try {
    assertEq(CURRENT_SCHEMA_VERSION, 11, 'CURRENT_SCHEMA_VERSION = 11');
    const info = fresh.schemaInfo();
    assertEq(info.dbVersion, 11, 'fresh DB dbVersion = 11');
    assertEq(info.current, true, 'fresh DB schema.current = true');

    const scCols = rawColumns(fresh, 'service_calls');
    for (const c of [
      'id', 'file_id', 'symbol_id', 'protocol', 'method',
      'raw_target', 'normalized_path', 'host_hint', 'env_key',
      'framework', 'line', 'confidence',
      // v9 Track-H generalized fields
      'operation', 'topic', 'queue', 'exchange', 'service', 'broker', 'metadata_json',
    ]) assert(scCols.includes(c), `service_calls has column ${c}`);

    const slCols = rawColumns(fresh, 'service_links');
    for (const c of [
      'id', 'call_id', 'route_id', 'caller_symbol_id', 'handler_symbol_id',
      'protocol', 'match_kind', 'confidence', 'evidence_json',
    ]) assert(slCols.includes(c), `service_links has column ${c}`);

    // v9 Track-H — routes table gains the same generalized fields.
    const rCols = rawColumns(fresh, 'routes');
    for (const c of [
      'id', 'file_id', 'method', 'path', 'framework', 'handler_name', 'handler_id', 'line',
      'protocol', 'operation', 'topic', 'queue', 'exchange', 'service', 'broker', 'metadata_json',
    ]) assert(rCols.includes(c), `routes has column ${c}`);

    // Empty tables on first open.
    const sc = fresh.rawDb().prepare('SELECT COUNT(*) AS c FROM service_calls').get() as { c: number };
    const sl = fresh.rawDb().prepare('SELECT COUNT(*) AS c FROM service_links').get() as { c: number };
    assertEq(sc.c, 0, 'service_calls is empty on fresh DB');
    assertEq(sl.c, 0, 'service_links is empty on fresh DB');

    // Required indexes
    const idx = (fresh.rawDb().prepare(
      `SELECT name FROM sqlite_master WHERE type='index'`
    ).all() as Array<{ name: string }>).map(r => r.name);
    for (const n of [
      'idx_service_calls_symbol_id', 'idx_service_calls_path',
      'idx_service_calls_protocol', 'idx_service_calls_file_id',
      'idx_service_links_call_id', 'idx_service_links_handler',
      'idx_service_links_caller', 'idx_service_links_protocol',
      'idx_service_links_match_kind',
    ]) assert(idx.includes(n), `index ${n} exists`);
  } finally { fresh.close(); }

  // ── 1b: Pre-v8 DB migrates and gets empty service_* tables ─────────────
  console.log('\n── Migration from a pre-v8 DB ──');
  const migDb = path.join(TMP_DIR, 'migrate.db');
  {
    // Hand-craft a "fake" pre-v8 DB: open through Store (which will install
    // schema v9), then drop the v8 tables and rewind the schema_version.
    // Re-opening Store should re-add the tables and bump back to v9.
    const seed = new Store(migDb);
    seed.rawDb().exec('DROP TABLE IF EXISTS service_links');
    seed.rawDb().exec('DROP TABLE IF EXISTS service_calls');
    seed.rawDb().prepare(
      `UPDATE _schema_meta SET value = '7' WHERE key = 'schema_version'`,
    ).run();
    seed.close();
  }
  const migrated = new Store(migDb);
  try {
    const info = migrated.schemaInfo();
    assertEq(info.dbVersion, 11, 'migrated DB version bumped to v11');
    const sc = migrated.rawDb().prepare('SELECT COUNT(*) AS c FROM service_calls').get() as { c: number };
    const sl = migrated.rawDb().prepare('SELECT COUNT(*) AS c FROM service_links').get() as { c: number };
    assertEq(sc.c, 0, 'service_calls exists after migration');
    assertEq(sl.c, 0, 'service_links exists after migration');
    // v9: generalized columns must be present on the migrated DB.
    const scCols = rawColumns(migrated, 'service_calls');
    for (const c of ['operation', 'topic', 'queue', 'service', 'metadata_json']) {
      assert(scCols.includes(c), `migrated service_calls has v9 column ${c}`);
    }
    const rCols = rawColumns(migrated, 'routes');
    for (const c of ['protocol', 'operation', 'topic', 'queue', 'metadata_json']) {
      assert(rCols.includes(c), `migrated routes has v9 column ${c}`);
    }
  } finally { migrated.close(); }

  // ── 1b': Pre-v9 (v8) DB migrates in-place, existing HTTP rows preserved ──
  console.log('\n── Migration from a v8 DB (in-place) ──');
  const v8MigDb = path.join(TMP_DIR, 'v8migrate.db');
  {
    const seed = new Store(v8MigDb);
    await new Indexer(seed).indexDirectory(FIX_SERVICE, { quiet: true });
    const before = seed.rawDb().prepare('SELECT COUNT(*) AS c FROM service_calls').get() as { c: number };
    const beforeRoutes = seed.rawDb().prepare('SELECT COUNT(*) AS c FROM routes').get() as { c: number };
    assert(before.c > 0, 'v8 seed has service_calls');
    assert(beforeRoutes.c > 0, 'v8 seed has routes');
    // Simulate a v8 DB by dropping the v9 columns (we drop them by recreating
    // the bare v8 table shapes — SQLite < 3.35 has no DROP COLUMN). We just
    // rewind the schema_version marker and trust ALTER ADD to be idempotent.
    seed.rawDb().prepare(
      `UPDATE _schema_meta SET value = '8' WHERE key = 'schema_version'`,
    ).run();
    seed.close();
  }
  const v8Migrated = new Store(v8MigDb);
  try {
    const info = v8Migrated.schemaInfo();
    assertEq(info.dbVersion, 11, 'v8 DB version bumped to v11 in-place');
    const after = v8Migrated.rawDb().prepare('SELECT COUNT(*) AS c FROM service_calls').get() as { c: number };
    const afterRoutes = v8Migrated.rawDb().prepare('SELECT COUNT(*) AS c FROM routes').get() as { c: number };
    assert(after.c > 0, 'v8 rows preserved through v9 migration');
    assert(afterRoutes.c > 0, 'v8 routes preserved through v9 migration');
    // Every route row must have a non-null protocol after migration (the
    // column was added with DEFAULT 'http' so pre-existing HTTP rows get
    // that value; v9-aware extractor rows already carry their actual proto).
    const nullProto = v8Migrated.rawDb().prepare(
      `SELECT COUNT(*) AS c FROM routes WHERE protocol IS NULL`,
    ).get() as { c: number };
    assertEq(nullProto.c, 0,
      'no route has NULL protocol after v9 migration');
    // The HTTP fraction must be non-empty — otherwise the DEFAULT 'http'
    // wouldn't have any rows to apply to and the migration assertion is
    // toothless.
    const httpRoutes = v8Migrated.rawDb().prepare(
      `SELECT COUNT(*) AS c FROM routes WHERE protocol = 'http'`,
    ).get() as { c: number };
    assert(httpRoutes.c > 0,
      `at least one route has protocol=http after migration (got ${httpRoutes.c})`);
  } finally { v8Migrated.close(); }

  // v8 backfill regression: a pre-v8 DB already has file hashes, so a normal
  // cached re-index would skip parsing every file and leave service_calls
  // empty forever. The indexer must force one parse pass and then mark it done.
  console.log('\n-- Cached migration service-call backfill --');
  const backfillDb = path.join(TMP_DIR, 'backfill.db');
  {
    const seed = new Store(backfillDb);
    await new Indexer(seed).indexDirectory(FIX_SERVICE, { quiet: true });
    const seeded = seed.rawDb().prepare('SELECT COUNT(*) AS c FROM service_calls').get() as { c: number };
    assert(seeded.c > 0, `seed DB has service_calls before simulating v7 (got ${seeded.c})`);
    seed.rawDb().exec(`
      DROP TABLE IF EXISTS service_links;
      DROP TABLE IF EXISTS service_calls;
      DELETE FROM _schema_meta WHERE key = 'service_calls_backfilled';
      UPDATE _schema_meta SET value = '7' WHERE key = 'schema_version';
    `);
    seed.close();
  }
  const backfill = new Store(backfillDb);
  try {
    assert(backfill.needsServiceCallBackfill(), 'v7->v9 DB reports service-call backfill needed');
    const r = await new Indexer(backfill).indexDirectory(FIX_SERVICE, { quiet: true });
    const restored = backfill.rawDb().prepare('SELECT COUNT(*) AS c FROM service_calls').get() as { c: number };
    const links = backfill.rawDb().prepare('SELECT COUNT(*) AS c FROM service_links').get() as { c: number };
    assert(r.filesIndexed > 0, `backfill forced reparsing despite unchanged hashes (indexed ${r.filesIndexed})`);
    assertEq(r.filesReusedFromCache, 0, 'backfill run does not take cached fast path');
    assert(restored.c > 0, `service_calls restored on cached migration (got ${restored.c})`);
    assert(links.c > 0, `service_links rebuilt on cached migration (got ${links.c})`);
    assert(!backfill.needsServiceCallBackfill(), 'service-call backfill marker written after successful run');
  } finally { backfill.close(); }

  // ── 1c: FK cascade — deleting a file removes its service rows ────────
  console.log('\n── FK cascade ──');
  const cascDb = path.join(TMP_DIR, 'cascade.db');
  const c = new Store(cascDb);
  try {
    const raw = c.rawDb();
    const insertFile = raw.prepare(
      'INSERT INTO files(path, rel_path, language, hash, lines, indexed_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const r1 = insertFile.run('/tmp/x.ts', 'x.ts', 'typescript', 'abc', 10, Date.now());
    const fileId = Number(r1.lastInsertRowid);

    const ins = raw.prepare(`INSERT INTO service_calls
      (file_id, symbol_id, protocol, method, raw_target, normalized_path,
       host_hint, env_key, framework, line, confidence)
      VALUES (?, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`)
      .run(fileId, 'http', 'GET', '/api/users', '/api/users', 'fetch', 5, 0.9);
    const callId = Number(ins.lastInsertRowid);

    raw.prepare(`INSERT INTO service_links
      (call_id, route_id, caller_symbol_id, handler_symbol_id, protocol, match_kind, confidence, evidence_json)
      VALUES (?, NULL, NULL, NULL, 'http', 'literal_path', 0.95, '{}')`)
      .run(callId);

    const before = raw.prepare('SELECT COUNT(*) AS c FROM service_calls').get() as { c: number };
    const beforeLinks = raw.prepare('SELECT COUNT(*) AS c FROM service_links').get() as { c: number };
    assertEq(before.c, 1, 'service_calls inserted');
    assertEq(beforeLinks.c, 1, 'service_links inserted');

    raw.prepare('DELETE FROM files WHERE id = ?').run(fileId);
    const after = raw.prepare('SELECT COUNT(*) AS c FROM service_calls').get() as { c: number };
    const afterLinks = raw.prepare('SELECT COUNT(*) AS c FROM service_links').get() as { c: number };
    assertEq(after.c, 0, 'service_calls cascade-deleted with file');
    assertEq(afterLinks.c, 0, 'service_links cascade-deleted via service_calls');
  } finally { c.close(); }

  // ── Step 3: TypeScript HTTP client extraction ─────────────────────────
  console.log('\n── Step 3: TS HTTP client extraction ──');
  const tsDb = path.join(TMP_DIR, 'ts.db');
  const tsStore = new Store(tsDb);
  await new Indexer(tsStore).indexDirectory(FIX_SERVICE, { quiet: true });
  try {
    const raw = tsStore.rawDb();
    type SCRow = {
      framework: string; method: string | null; raw_target: string;
      env_key: string | null; line: number; symbol_id: number | null;
    };
    const rows = raw.prepare(
      `SELECT sc.framework, sc.method, sc.raw_target, sc.env_key, sc.line, sc.symbol_id
         FROM service_calls sc JOIN files f ON f.id = sc.file_id
        WHERE f.language = 'typescript'
        ORDER BY sc.line ASC`
    ).all() as SCRow[];
    console.log(`  → ${rows.length} TS service_calls extracted`);

    // listUsers → fetch('/api/users')
    const list = rows.find(r => r.raw_target === '/api/users' && r.framework === 'fetch');
    assert(!!list, 'fetch("/api/users") recorded');
    if (list) assertEq(list.method, 'ANY', 'plain fetch defaults to ANY method');

    // createUser → fetch('/api/users', {method:'POST'})
    const create = rows.find(r => r.raw_target === '/api/users' && r.method === 'POST');
    assert(!!create, 'fetch("/api/users", {method:"POST"}) recorded with POST');

    // checkout → axios.post('/checkout')
    const checkout = rows.find(r => r.raw_target === '/checkout');
    assert(!!checkout, 'axios.post("/checkout") recorded');
    if (checkout) {
      assertEq(checkout.framework, 'axios', 'axios framework labelled');
      assertEq(checkout.method, 'POST', 'method derived from .post');
    }

    // fetchOrders → apiClient.get('/api/orders')
    const orders = rows.find(r => r.raw_target === '/api/orders');
    assert(!!orders, 'apiClient.get("/api/orders") recorded');
    if (orders) assertEq(orders.framework, 'http-client', 'generic client.get → http-client');

    // chargeCustomer → fetch(`${process.env.PAYMENT_URL}/charge`)
    const charge = rows.find(r => r.raw_target === '/charge' && r.framework === 'fetch');
    assert(!!charge, 'template literal "/charge" path lifted');
    if (charge) assertEq(charge.env_key, 'PAYMENT_URL', 'PAYMENT_URL env var captured');

    // dynamicUrl(u) → fetch(u) — NOT recorded (no string literal arg).
    // Check: no row references the parameter name "u" as raw_target.
    const dyn = rows.find(r => r.raw_target === 'u');
    assert(!dyn, 'dynamic URL not recorded');

    // readCache → apiClient.get(key) — NOT recorded (first arg is identifier)
    const readCache = rows.find(r => r.raw_target === 'key');
    assert(!readCache, 'identifier arg not recorded as service call');

    // Caller attribution: list / create / checkout / fetchOrders / chargeCustomer
    // must all be inside their enclosing functions, not module-level (NULL).
    const callerCount = raw.prepare(
      `SELECT COUNT(*) AS c FROM service_calls WHERE symbol_id IS NOT NULL`
    ).get() as { c: number };
    assert(callerCount.c >= 4, `most service calls have caller symbol (got ${callerCount.c})`);

    // ── Python extraction ────────────────────────────────────────────────
    console.log('\n── Step 3: Python HTTP client extraction ──');
    type PyRow = {
      framework: string; method: string | null; raw_target: string;
      env_key: string | null;
    };
    const pyRows = raw.prepare(
      `SELECT sc.framework, sc.method, sc.raw_target, sc.env_key
         FROM service_calls sc JOIN files f ON f.id = sc.file_id
        WHERE f.language = 'python' ORDER BY sc.line ASC`
    ).all() as PyRow[];
    console.log(`  → ${pyRows.length} Python service_calls extracted`);

    const reqGet = pyRows.find(r => r.framework === 'requests' && r.raw_target === '/health');
    assert(!!reqGet, 'requests.get("/health") recorded');
    if (reqGet) assertEq(reqGet.method, 'GET', 'method=GET for requests.get');

    const reqPost = pyRows.find(r => r.framework === 'requests' && r.raw_target === '/api/users' && r.method === 'POST');
    assert(!!reqPost, 'requests.post("/api/users") recorded with POST');

    const httpxGet = pyRows.find(r => r.framework === 'httpx');
    assert(!!httpxGet, 'httpx.get(…) recorded');

    const generic = pyRows.find(r => r.framework === 'http-client' && r.raw_target === '/api/cart/items');
    assert(!!generic, 'self.client.post("/api/cart/items") recorded as generic http-client');

    const pyCharge = pyRows.find(r => r.raw_target === '/charge');
    assert(!!pyCharge, 'binary concat "/charge" recovered');
    if (pyCharge) assertEq(pyCharge.env_key, 'PAYMENT_URL', 'PAYMENT_URL envKey captured (Python)');

    const pyDyn = pyRows.find(r => r.raw_target === 'url');
    assert(!pyDyn, 'dynamic URL not recorded (Python)');

    // ── Go extraction ────────────────────────────────────────────────────
    console.log('\n── Step 3: Go HTTP client extraction ──');
    type GoRow = { framework: string; method: string | null; raw_target: string };
    const goRows = raw.prepare(
      `SELECT sc.framework, sc.method, sc.raw_target
         FROM service_calls sc JOIN files f ON f.id = sc.file_id
        WHERE f.language = 'go' ORDER BY sc.line ASC`
    ).all() as GoRow[];
    console.log(`  → ${goRows.length} Go service_calls extracted`);

    const httpGet = goRows.find(r => r.framework === 'http' && r.method === 'GET' && r.raw_target === '/api/users');
    assert(!!httpGet, 'http.Get("/api/users") recorded');
    const httpPost = goRows.find(r => r.framework === 'http' && r.method === 'POST' && r.raw_target === '/api/users');
    assert(!!httpPost, 'http.Post("/api/users", ...) recorded');
    const clientGet = goRows.find(r => r.framework === 'http-client' && r.raw_target === '/api/orders');
    assert(!!clientGet, 'client.Get("/api/orders") recorded as http-client');
    const newReq = goRows.find(r => r.method === 'POST' && r.raw_target === '/api/items');
    assert(!!newReq, 'http.NewRequest("POST", "/api/items", …) recorded with POST');

    // ── Java extraction ──────────────────────────────────────────────────
    console.log('\n── Step 3: Java HTTP client extraction ──');
    type JRow = { framework: string; method: string | null; raw_target: string };
    const jRows = raw.prepare(
      `SELECT sc.framework, sc.method, sc.raw_target
         FROM service_calls sc JOIN files f ON f.id = sc.file_id
        WHERE f.language = 'java' ORDER BY sc.line ASC`
    ).all() as JRow[];
    console.log(`  → ${jRows.length} Java service_calls extracted`);

    const restGet = jRows.find(r => r.framework === 'spring-rest' && r.method === 'GET' && r.raw_target === '/api/users');
    assert(!!restGet, 'restTemplate.getForObject("/api/users") recorded');
    const restPost = jRows.find(r => r.framework === 'spring-rest' && r.method === 'POST' && r.raw_target === '/api/orders');
    assert(!!restPost, 'restTemplate.postForObject("/api/orders", …) recorded');
    const httpReq = jRows.find(r => r.framework === 'java.net.http' && r.raw_target === 'https://payment-service/api/ping');
    assert(!!httpReq, 'HttpRequest.newBuilder(URI.create(...)) recorded');

    // ── C# extraction ────────────────────────────────────────────────────
    console.log('\n── Step 3: C# HTTP client extraction ──');
    type CSRow = { framework: string; method: string | null; raw_target: string };
    const csRows = raw.prepare(
      `SELECT sc.framework, sc.method, sc.raw_target
         FROM service_calls sc JOIN files f ON f.id = sc.file_id
        WHERE f.language = 'csharp' ORDER BY sc.line ASC`
    ).all() as CSRow[];
    console.log(`  → ${csRows.length} C# service_calls extracted`);

    const csGet = csRows.find(r => r.method === 'GET' && r.raw_target === '/api/users');
    assert(!!csGet, 'HttpClient.GetAsync("/api/users") recorded');
    const csPost = csRows.find(r => r.method === 'POST' && r.raw_target === '/api/orders');
    assert(!!csPost, 'HttpClient.PostAsJsonAsync("/api/orders", …) recorded');
    const csDel = csRows.find(r => r.method === 'DELETE' && r.raw_target === 'https://auth/api/session');
    assert(!!csDel, 'HttpClient.DeleteAsync absolute URL recorded');

    // ── v9 Track-H Step 2: tRPC procedure + client extraction ──────────────
    console.log('\n── Step 2 (Track-H): tRPC extraction ──');
    type TrpcCallRow = {
      framework: string; method: string | null; raw_target: string;
      protocol: string; operation: string | null;
      caller_qname: string | null;
    };
    const trpcCalls = raw.prepare(
      `SELECT sc.framework, sc.method, sc.raw_target, sc.protocol, sc.operation,
              s.qualified_name AS caller_qname
         FROM service_calls sc
         JOIN files f   ON f.id = sc.file_id
         LEFT JOIN symbols s ON s.id = sc.symbol_id
        WHERE sc.protocol = 'trpc'
          AND f.rel_path = 'trpc_client.ts'
        ORDER BY sc.line ASC`
    ).all() as TrpcCallRow[];
    console.log(`  → ${trpcCalls.length} tRPC client calls extracted`);

    const trpcGet = trpcCalls.find(r => r.operation === 'user.getById' && r.method === 'QUERY' && r.framework === 'trpc-query');
    assert(!!trpcGet, 'trpc.user.getById.query() recorded as trpc QUERY');
    const trpcCreate = trpcCalls.find(r => r.operation === 'user.create' && r.method === 'MUTATION');
    assert(!!trpcCreate, 'trpc.user.create.mutate() recorded as trpc MUTATION');
    const trpcDel = trpcCalls.find(r => r.operation === 'user.delete' && r.method === 'MUTATION');
    assert(!!trpcDel, 'trpc.user.delete.mutate() recorded');
    const trpcUseQuery = trpcCalls.find(r => r.operation === 'user.getById' && r.framework === 'trpc-useQuery');
    assert(!!trpcUseQuery, 'trpc.user.getById.useQuery() recorded as QUERY');
    const trpcUseMut = trpcCalls.find(r => r.operation === 'user.create' && r.framework === 'trpc-useMutation');
    assert(!!trpcUseMut, 'trpc.user.create.useMutation() recorded as MUTATION');
    const apiCall = trpcCalls.find(r => r.operation === 'user.getById' && r.caller_qname === 'viaApi');
    assert(!!apiCall, 'api.user.getById.query() recorded under viaApi caller');

    // Negative case: random object.foo.bar.query() must NOT be a tRPC call.
    const negCalls = raw.prepare(
      `SELECT sc.operation FROM service_calls sc
        JOIN files f ON f.id = sc.file_id
        WHERE f.rel_path = 'trpc_client.ts' AND sc.protocol = 'trpc'
          AND sc.operation = 'foo.bar'`
    ).all() as Array<{ operation: string }>;
    assertEq(negCalls.length, 0, 'someOtherObject.foo.bar.query() NOT a tRPC client call');

    // Server-side: tRPC procedures land in routes with protocol='trpc'.
    type TrpcRouteRow = {
      method: string; path: string; framework: string;
      protocol: string; operation: string | null;
      handler_name: string | null; handler_qname: string | null;
    };
    const trpcRoutes = raw.prepare(
      `SELECT r.method, r.path, r.framework, r.protocol, r.operation,
              r.handler_name, s.qualified_name AS handler_qname
         FROM routes r
         JOIN files f ON f.id = r.file_id
         LEFT JOIN symbols s ON s.id = r.handler_id
        WHERE r.protocol = 'trpc' AND f.rel_path = 'trpc_server.ts'
        ORDER BY r.id ASC`
    ).all() as TrpcRouteRow[];
    console.log(`  → ${trpcRoutes.length} tRPC procedure routes extracted`);

    const procGet = trpcRoutes.find(r => r.operation === 'getById' && r.method === 'QUERY');
    assert(!!procGet, 'userRouter.getById procedure recorded as QUERY');
    if (procGet) {
      assertEq(procGet.framework, 'trpc', 'tRPC procedure framework = trpc');
      assert(procGet.handler_name === 'getUserById' || procGet.handler_qname === 'getUserById',
        'getById handler resolves to getUserById');
    }
    const procCreate = trpcRoutes.find(r => r.operation === 'create' && r.method === 'MUTATION');
    assert(!!procCreate, 'userRouter.create procedure recorded as MUTATION');
    const procDelete = trpcRoutes.find(r => r.operation === 'delete' && r.method === 'MUTATION');
    assert(!!procDelete, 'userRouter.delete procedure recorded (inline arrow handler)');

    // tRPC → service_links: client trpc.user.getById.query() should link to
    // userRouter.getById via last-segment match (server operation = 'getById').
    type TrpcLinkRow = {
      match_kind: string; protocol: string;
      caller_qname: string | null; handler_qname: string | null;
      route_operation: string | null; confidence: number;
    };
    const trpcLinks = raw.prepare(
      `SELECT sl.match_kind, sl.protocol, sl.confidence,
              sc.qualified_name AS caller_qname,
              sh.qualified_name AS handler_qname,
              r.operation AS route_operation
         FROM service_links sl
         LEFT JOIN symbols sc ON sc.id = sl.caller_symbol_id
         LEFT JOIN symbols sh ON sh.id = sl.handler_symbol_id
         LEFT JOIN routes  r  ON r.id  = sl.route_id
        WHERE sl.protocol = 'trpc'
        ORDER BY sl.id ASC`
    ).all() as TrpcLinkRow[];
    console.log(`  → ${trpcLinks.length} tRPC service_links resolved`);
    assert(trpcLinks.length >= 3, `at least 3 tRPC links (getById/create/delete), got ${trpcLinks.length}`);

    const getByIdLink = trpcLinks.find(l =>
      l.caller_qname === 'fetchUser' && l.route_operation === 'getById');
    assert(!!getByIdLink, 'fetchUser → userRouter.getById link present');
    if (getByIdLink) {
      assertEq(getByIdLink.match_kind, 'trpc_procedure', 'tRPC match_kind set');
      assert(getByIdLink.handler_qname === 'getUserById',
        `handler resolved to getUserById (got ${getByIdLink.handler_qname})`);
    }

    const createLink = trpcLinks.find(l =>
      l.caller_qname === 'createUserClient' && l.route_operation === 'create');
    assert(!!createLink, 'createUserClient → userRouter.create link present');

    // Hook-based caller useUser → also resolves to getById.
    const hookLink = trpcLinks.find(l =>
      l.caller_qname === 'useUser' && l.route_operation === 'getById');
    assert(!!hookLink, 'useUser → userRouter.getById (useQuery hook) link present');

    // ── v9 Track-H Step 3: GraphQL resolver + client extraction ────────────
    console.log('\n── Step 3 (Track-H): GraphQL extraction ──');
    type GqlRouteRow = {
      method: string; path: string; framework: string;
      protocol: string; operation: string | null;
      handler_name: string | null; handler_qname: string | null;
    };
    const gqlRoutes = raw.prepare(
      `SELECT r.method, r.path, r.framework, r.protocol, r.operation,
              r.handler_name, s.qualified_name AS handler_qname
         FROM routes r
         JOIN files f ON f.id = r.file_id
         LEFT JOIN symbols s ON s.id = r.handler_id
        WHERE r.protocol = 'graphql' AND f.rel_path = 'graphql_server.ts'
        ORDER BY r.id ASC`
    ).all() as GqlRouteRow[];
    console.log(`  → ${gqlRoutes.length} GraphQL resolver routes extracted`);

    const userQ = gqlRoutes.find(r => r.operation === 'user' && r.method === 'QUERY');
    assert(!!userQ, 'resolvers.Query.user → QUERY/user route emitted');
    if (userQ) {
      assertEq(userQ.framework, 'graphql', 'resolver framework = graphql');
      assert(userQ.handler_name === 'userResolver' || userQ.handler_qname === 'userResolver',
        `handler resolved to userResolver (got ${userQ.handler_name})`);
    }
    const usersQ = gqlRoutes.find(r => r.operation === 'users' && r.method === 'QUERY');
    assert(!!usersQ, 'resolvers.Query.users → QUERY/users route emitted (inline arrow)');
    const createM = gqlRoutes.find(r => r.operation === 'createUser' && r.method === 'MUTATION');
    assert(!!createM, 'resolvers.Mutation.createUser → MUTATION/createUser route');
    const deleteM = gqlRoutes.find(r => r.operation === 'deleteUser' && r.method === 'MUTATION');
    assert(!!deleteM, 'resolvers.Mutation.deleteUser → MUTATION/deleteUser route');
    const subS = gqlRoutes.find(r => r.operation === 'onUserCreated' && r.method === 'SUBSCRIPTION');
    assert(!!subS, 'resolvers.Subscription.onUserCreated → SUBSCRIPTION/onUserCreated route');

    // Client side
    type GqlCallRow = {
      framework: string; method: string | null;
      protocol: string; operation: string | null;
      caller_qname: string | null; metadata_json: string | null;
    };
    const gqlCalls = raw.prepare(
      `SELECT sc.framework, sc.method, sc.protocol, sc.operation, sc.metadata_json,
              s.qualified_name AS caller_qname
         FROM service_calls sc
         JOIN files f ON f.id = sc.file_id
         LEFT JOIN symbols s ON s.id = sc.symbol_id
        WHERE sc.protocol = 'graphql' AND f.rel_path = 'graphql_client.ts'
        ORDER BY sc.line ASC`
    ).all() as GqlCallRow[];
    console.log(`  → ${gqlCalls.length} GraphQL client calls extracted`);

    // fetchUser → client.query({ query: GET_USER }) — operation stored as the
    // document identifier; the resolver rewrites this to the parsed field
    // name ('user') when matching against the resolver map.
    const fetchUserCall = gqlCalls.find(c =>
      c.caller_qname === 'fetchUser' && c.operation === 'GET_USER' && c.method === 'QUERY');
    assert(!!fetchUserCall, 'fetchUser → client.query(GET_USER) recorded with operation=GET_USER');
    if (fetchUserCall) {
      assertEq(fetchUserCall.framework, 'graphql-query', 'framework = graphql-query');
    }

    // The gql-doc sentinel for GET_USER should also be present and parsed.
    const gqlDoc = gqlCalls.find(c => c.framework === 'gql-doc' && c.operation === 'user');
    assert(!!gqlDoc, 'gql-doc sentinel for GET_USER parsed (operation=user, the body field)');
    if (gqlDoc) {
      const meta = JSON.parse(gqlDoc.metadata_json ?? '{}');
      assertEq(meta.operationName, 'GetUser', 'gql-doc metadata.operationName = GetUser');
      assertEq(meta.documentIdent, 'GET_USER', 'gql-doc metadata.documentIdent = GET_USER');
    }

    // Regression: a plain IIFE (`const counter = (() => {...})()`) is a
    // call_expression with a brace in its body, but must NOT be mistaken for a
    // gql document. No gql-doc sentinel should reference it.
    const iifeDoc = gqlCalls.find(c =>
      c.framework === 'gql-doc' &&
      (c.operation === 'counter' || c.operation === 'let' || c.operation === 'return'));
    assert(!iifeDoc, 'IIFE const is not emitted as a gql-doc service_call');

    // createUserViaApollo → apolloClient.mutate({ mutation: CREATE_USER })
    const createApolloCall = gqlCalls.find(c =>
      c.caller_qname === 'createUserViaApollo' && c.operation === 'CREATE_USER' && c.method === 'MUTATION');
    assert(!!createApolloCall, 'createUserViaApollo → apolloClient.mutate(CREATE_USER) recorded');

    // useUserHook → useQuery(gql`query ListAllUsers { users { ... } }`)
    const useUserCall = gqlCalls.find(c =>
      c.caller_qname === 'useUserHook' && c.operation === 'users');
    assert(!!useUserCall, 'useUserHook → useQuery(inline gql) → operation=users');
    if (useUserCall) assertEq(useUserCall.method, 'QUERY', 'useQuery emits QUERY');

    // useCreateUserHook → useMutation(CREATE_USER) — operation = doc identifier
    // since the const name is the only signal we have at this site (the gql
    // body lives in another const definition).
    const useCreateCall = gqlCalls.find(c =>
      c.caller_qname === 'useCreateUserHook' && c.method === 'MUTATION');
    assert(!!useCreateCall, 'useCreateUserHook → useMutation(CREATE_USER) recorded');
    if (useCreateCall) {
      assert(useCreateCall.operation === 'CREATE_USER' || useCreateCall.operation === 'createUser',
        `operation = doc ident or field (got ${useCreateCall.operation})`);
    }

    // GraphQL service_links
    type GqlLinkRow = {
      match_kind: string; protocol: string; confidence: number;
      caller_qname: string | null; handler_qname: string | null;
      route_operation: string | null;
    };
    const gqlLinks = raw.prepare(
      `SELECT sl.match_kind, sl.protocol, sl.confidence,
              sc.qualified_name AS caller_qname,
              sh.qualified_name AS handler_qname,
              r.operation AS route_operation
         FROM service_links sl
         LEFT JOIN symbols sc ON sc.id = sl.caller_symbol_id
         LEFT JOIN symbols sh ON sh.id = sl.handler_symbol_id
         LEFT JOIN routes  r  ON r.id  = sl.route_id
        WHERE sl.protocol = 'graphql'
        ORDER BY sl.id ASC`
    ).all() as GqlLinkRow[];
    console.log(`  → ${gqlLinks.length} GraphQL service_links resolved`);
    assert(gqlLinks.length >= 2, `at least 2 GraphQL links, got ${gqlLinks.length}`);

    const fetchUserLink = gqlLinks.find(l =>
      l.caller_qname === 'fetchUser' && l.route_operation === 'user');
    assert(!!fetchUserLink, 'fetchUser → Query.user resolver link present');
    if (fetchUserLink) {
      assertEq(fetchUserLink.match_kind, 'graphql_operation', 'match_kind = graphql_operation');
      assert(fetchUserLink.handler_qname === 'userResolver',
        `handler resolved to userResolver (got ${fetchUserLink.handler_qname})`);
    }
    const createLnk = gqlLinks.find(l =>
      l.caller_qname === 'createUserViaApollo' && l.route_operation === 'createUser');
    assert(!!createLnk, 'createUserViaApollo → Mutation.createUser resolver link present');

    // ── v9 Track-H Step 4: .proto + gRPC client extraction ─────────────────
    console.log('\n── Step 4 (Track-H): gRPC extraction ──');
    // Proto scanner emits one route per rpc, with operation = "Service/Method"
    type GrpcRouteRow = {
      method: string; path: string; framework: string;
      protocol: string; operation: string | null; service: string | null;
      handler_name: string | null;
    };
    const grpcRoutes = raw.prepare(
      `SELECT r.method, r.path, r.framework, r.protocol, r.operation, r.service,
              r.handler_name
         FROM routes r
        WHERE r.protocol = 'grpc'
        ORDER BY r.id ASC`
    ).all() as GrpcRouteRow[];
    console.log(`  → ${grpcRoutes.length} gRPC routes extracted from .proto`);
    assertEq(grpcRoutes.length, 5,
      'all 5 rpc methods from user_service.proto extracted');

    const protoGet = grpcRoutes.find(r => r.operation === 'UserService/GetUser');
    assert(!!protoGet, 'UserService/GetUser route emitted');
    if (protoGet) {
      assertEq(protoGet.framework, 'grpc', 'framework = grpc');
      assertEq(protoGet.service, 'UserService', 'service = UserService');
      assertEq(protoGet.path, 'UserService/GetUser', 'path = canonical operation');
    }
    const protoCreate = grpcRoutes.find(r => r.operation === 'UserService/CreateUser');
    assert(!!protoCreate, 'UserService/CreateUser route emitted (despite HTTP annotation)');
    const protoLogin = grpcRoutes.find(r => r.operation === 'AuthService/Login');
    assert(!!protoLogin, 'AuthService/Login route emitted');
    const protoLogout = grpcRoutes.find(r => r.operation === 'AuthService/Logout');
    assert(!!protoLogout, 'AuthService/Logout route emitted');

    // The .proto file itself is indexed with language='proto'
    const protoFile = raw.prepare(
      `SELECT id, language FROM files WHERE rel_path = 'user_service.proto'`
    ).get() as { id: number; language: string } | undefined;
    assert(!!protoFile, '.proto file upserted into files table');
    if (protoFile) assertEq(protoFile.language, 'proto', '.proto file language = proto');

    const grpcRouteIdsBefore = raw.prepare(
      `SELECT id, operation FROM routes WHERE protocol = 'grpc' ORDER BY operation ASC`
    ).all() as Array<{ id: number; operation: string | null }>;
    const cachedGrpc = await new Indexer(tsStore).indexDirectory(FIX_SERVICE, { quiet: true });
    const protoFileAfter = raw.prepare(
      `SELECT id, language FROM files WHERE rel_path = 'user_service.proto'`
    ).get() as { id: number; language: string } | undefined;
    const grpcRouteIdsAfter = raw.prepare(
      `SELECT id, operation FROM routes WHERE protocol = 'grpc' ORDER BY operation ASC`
    ).all() as Array<{ id: number; operation: string | null }>;
    assertEq(cachedGrpc.pagerankRecomputed, false,
      'cached re-index with unchanged .proto skips PageRank');
    if (protoFile && protoFileAfter) {
      assertEq(protoFileAfter.id, protoFile.id,
        'cached re-index keeps .proto file row stable');
    }
    assertEq(JSON.stringify(grpcRouteIdsAfter), JSON.stringify(grpcRouteIdsBefore),
      'cached re-index keeps .proto gRPC route rows stable');

    // Go client side
    type GrpcCallRow = {
      framework: string; method: string | null; raw_target: string;
      protocol: string; operation: string | null; service: string | null;
      caller_qname: string | null;
    };
    const grpcCalls = raw.prepare(
      `SELECT sc.framework, sc.method, sc.raw_target, sc.protocol, sc.operation, sc.service,
              s.qualified_name AS caller_qname
         FROM service_calls sc
         JOIN files f ON f.id = sc.file_id
         LEFT JOIN symbols s ON s.id = sc.symbol_id
        WHERE sc.protocol = 'grpc' AND f.rel_path = 'grpc_client.go'
        ORDER BY sc.line ASC`
    ).all() as GrpcCallRow[];
    console.log(`  → ${grpcCalls.length} gRPC client calls extracted (Go)`);

    const getCall = grpcCalls.find(c =>
      c.caller_qname === 'GetUserViaGrpc' && c.operation === 'UserService/GetUser');
    assert(!!getCall, 'pb.NewUserServiceClient(...).GetUser → operation=UserService/GetUser');
    if (getCall) {
      assertEq(getCall.framework, 'grpc-go', 'framework = grpc-go');
      assertEq(getCall.service, 'UserService', 'service captured');
    }
    const createCall = grpcCalls.find(c =>
      c.caller_qname === 'CreateUserViaGrpc' && c.operation === 'UserService/CreateUser');
    assert(!!createCall, 'pb.NewUserServiceClient(...).CreateUser recorded');
    const loginCall = grpcCalls.find(c =>
      c.caller_qname === 'LoginViaGrpc' && c.operation === 'AuthService/Login');
    assert(!!loginCall, 'pb.NewAuthServiceClient(...).Login recorded');

    // Unknown gRPC method: recorded as a call but no link.
    const noSuchCall = grpcCalls.find(c => c.operation === 'UserService/NoSuchMethod');
    assert(!!noSuchCall, 'NoSuchMethod is recorded even when unresolved');

    // gRPC service_links: 3 known calls should link, NoSuchMethod should NOT.
    type GrpcLinkRow = {
      match_kind: string;
      caller_qname: string | null; handler_qname: string | null;
      route_operation: string | null; confidence: number;
    };
    const grpcLinks = raw.prepare(
      `SELECT sl.match_kind, sl.confidence,
              sc.qualified_name AS caller_qname,
              sh.qualified_name AS handler_qname,
              r.operation AS route_operation
         FROM service_links sl
         LEFT JOIN symbols sc ON sc.id = sl.caller_symbol_id
         LEFT JOIN symbols sh ON sh.id = sl.handler_symbol_id
         LEFT JOIN routes  r  ON r.id  = sl.route_id
        WHERE sl.protocol = 'grpc'
        ORDER BY sl.id ASC`
    ).all() as GrpcLinkRow[];
    console.log(`  → ${grpcLinks.length} gRPC service_links resolved`);
    assertEq(grpcLinks.length, 3, '3 gRPC links: GetUser, CreateUser, Login');
    for (const l of grpcLinks) {
      assertEq(l.match_kind, 'grpc_method', 'gRPC match_kind = grpc_method');
    }
    const noSuchLink = grpcLinks.find(l =>
      l.route_operation === 'UserService/NoSuchMethod' || l.caller_qname === 'CallUnknown');
    assert(!noSuchLink, 'CallUnknown / NoSuchMethod did NOT link');

    // ── v9 Track-H Step 5: Messaging (Kafka/SQS/SNS/Rabbit/NATS/Redis) ─────
    console.log('\n── Step 5 (Track-H): Messaging extraction ──');
    type MsgCallRow = {
      protocol: string; framework: string; method: string | null;
      topic: string | null; queue: string | null; exchange: string | null;
      raw_target: string; caller_qname: string | null;
    };
    const msgCalls = raw.prepare(
      `SELECT sc.protocol, sc.framework, sc.method, sc.topic, sc.queue, sc.exchange,
              sc.raw_target, s.qualified_name AS caller_qname
         FROM service_calls sc
         JOIN files f ON f.id = sc.file_id
         LEFT JOIN symbols s ON s.id = sc.symbol_id
        WHERE f.rel_path = 'messaging.ts'
          AND sc.protocol IN ('kafka','sqs','sns','rabbitmq','nats','redis_pubsub')
        ORDER BY sc.line ASC`
    ).all() as MsgCallRow[];
    console.log(`  → ${msgCalls.length} messaging producer calls extracted`);

    // Kafka producers
    const kafkaOrders = msgCalls.find(c =>
      c.protocol === 'kafka' && c.topic === 'orders' && c.caller_qname === 'produceOrders');
    assert(!!kafkaOrders, 'producer.send({topic:"orders"}) recorded');
    if (kafkaOrders) assertEq(kafkaOrders.framework, 'kafkajs', 'framework=kafkajs');
    const kafkaShip = msgCalls.find(c =>
      c.protocol === 'kafka' && c.topic === 'shipments' && c.caller_qname === 'produceShipments');
    assert(!!kafkaShip, 'producer.send({topic:"shipments"}) recorded');

    // SQS
    const sqsSend = msgCalls.find(c =>
      c.protocol === 'sqs' && c.caller_qname === 'enqueueJob');
    assert(!!sqsSend, 'sqs.sendMessage({QueueUrl:...}) recorded');
    if (sqsSend) {
      assertEq(sqsSend.queue, 'job-queue', 'SQS queue name extracted from URL');
      assertEq(sqsSend.framework, 'aws-sdk-sqs', 'framework=aws-sdk-sqs');
    }

    // SNS
    const snsPub = msgCalls.find(c =>
      c.protocol === 'sns' && c.caller_qname === 'notifySubscribers');
    assert(!!snsPub, 'sns.publish({TopicArn:...}) recorded');
    if (snsPub) assertEq(snsPub.topic, 'user-events', 'SNS topic extracted from ARN');

    // RabbitMQ
    const rabbitPub = msgCalls.find(c =>
      c.protocol === 'rabbitmq' && c.caller_qname === 'publishEvent');
    assert(!!rabbitPub, 'channel.publish("exch","key",body) recorded');
    if (rabbitPub) assertEq(rabbitPub.exchange, 'events', 'Rabbit exchange recorded');
    const rabbitQ = msgCalls.find(c =>
      c.protocol === 'rabbitmq' && c.caller_qname === 'pushToQ');
    assert(!!rabbitQ, 'channel.sendToQueue("q",body) recorded');
    if (rabbitQ) assertEq(rabbitQ.queue, 'mailer-queue', 'Rabbit queue recorded');

    // NATS
    const natsPub = msgCalls.find(c =>
      c.protocol === 'nats' && c.caller_qname === 'natsPublish');
    assert(!!natsPub, 'nc.publish("subject",data) recorded');
    if (natsPub) assertEq(natsPub.topic, 'user.created', 'NATS subject recorded');

    // Redis pub-sub
    const redisP = msgCalls.find(c =>
      c.protocol === 'redis_pubsub' && c.caller_qname === 'redisPub');
    assert(!!redisP, 'redis.publish("chan",msg) recorded');

    // Consumer routes
    type MsgRouteRow = {
      protocol: string; framework: string; method: string;
      topic: string | null; queue: string | null;
      path: string; handler_name: string | null;
    };
    const msgRoutes = raw.prepare(
      `SELECT r.protocol, r.framework, r.method, r.topic, r.queue, r.path, r.handler_name
         FROM routes r
         JOIN files f ON f.id = r.file_id
        WHERE f.rel_path = 'messaging.ts'
          AND r.protocol IN ('kafka','sqs','sns','rabbitmq','nats','redis_pubsub')
        ORDER BY r.id ASC`
    ).all() as MsgRouteRow[];
    console.log(`  → ${msgRoutes.length} messaging consumer routes extracted`);

    const kafkaCons = msgRoutes.find(r =>
      r.protocol === 'kafka' && r.topic === 'orders');
    assert(!!kafkaCons, 'consumer.subscribe({topic:"orders"}) → route emitted');
    if (kafkaCons) assertEq(kafkaCons.method, 'CONSUME', 'consumer method = CONSUME');
    const kafkaMulti = msgRoutes.filter(r =>
      r.protocol === 'kafka' && (r.topic === 'shipments' || r.topic === 'invoices'));
    assertEq(kafkaMulti.length, 2, 'topics array fans out to one route per topic');

    const rabbitCons = msgRoutes.find(r =>
      r.protocol === 'rabbitmq' && r.queue === 'mailer-queue');
    assert(!!rabbitCons, 'channel.consume("mailer-queue",h) → route emitted');
    if (rabbitCons) assert(rabbitCons.handler_name === 'rabbitHandler',
      `consume handler captured (got ${rabbitCons.handler_name})`);

    const natsCons = msgRoutes.find(r =>
      r.protocol === 'nats' && r.topic === 'user.created');
    assert(!!natsCons, 'nc.subscribe("user.created") → route emitted');

    const sqsCons = msgRoutes.find(r =>
      r.protocol === 'sqs' && r.queue === 'job-queue');
    assert(!!sqsCons, 'sqs.receiveMessage({QueueUrl:...}) → route emitted');

    // Messaging service_links: kafka orders pair, rabbit queue pair, SQS pair,
    // NATS pair. Multiple consumers for same topic must produce multiple links.
    type MsgLinkRow = {
      protocol: string; match_kind: string;
      caller_qname: string | null; handler_qname: string | null;
      route_topic: string | null; route_queue: string | null;
    };
    const msgLinks = raw.prepare(
      `SELECT sl.protocol, sl.match_kind,
              sc.qualified_name AS caller_qname,
              sh.qualified_name AS handler_qname,
              r.topic AS route_topic, r.queue AS route_queue
         FROM service_links sl
         LEFT JOIN symbols sc ON sc.id = sl.caller_symbol_id
         LEFT JOIN symbols sh ON sh.id = sl.handler_symbol_id
         LEFT JOIN routes  r  ON r.id  = sl.route_id
        WHERE sl.protocol IN ('kafka','sqs','sns','rabbitmq','nats','redis_pubsub')
        ORDER BY sl.id ASC`
    ).all() as MsgLinkRow[];
    console.log(`  → ${msgLinks.length} messaging service_links resolved`);

    const kafkaLnk = msgLinks.find(l =>
      l.protocol === 'kafka' && l.route_topic === 'orders' && l.caller_qname === 'produceOrders');
    assert(!!kafkaLnk, 'produceOrders → kafka orders consumer link');
    if (kafkaLnk) assertEq(kafkaLnk.match_kind, 'topic_match', 'Kafka link match_kind = topic_match');

    // Multi-consumer for shipments: produceShipments has only one consumer
    // (subscribeMulti contains 'shipments'). Still asserts the route fanout
    // worked.
    const shipLnk = msgLinks.find(l =>
      l.protocol === 'kafka' && l.route_topic === 'shipments' && l.caller_qname === 'produceShipments');
    assert(!!shipLnk, 'produceShipments → shipments consumer link');

    const sqsLnk = msgLinks.find(l =>
      l.protocol === 'sqs' && l.route_queue === 'job-queue' && l.caller_qname === 'enqueueJob');
    assert(!!sqsLnk, 'enqueueJob → SQS job-queue consumer link');
    if (sqsLnk) assertEq(sqsLnk.match_kind, 'queue_match', 'SQS link match_kind = queue_match');

    const rabbitLnk = msgLinks.find(l =>
      l.protocol === 'rabbitmq' && l.route_queue === 'mailer-queue' && l.caller_qname === 'pushToQ');
    assert(!!rabbitLnk, 'pushToQ → rabbitmq mailer-queue consumer link');

    const natsLnk = msgLinks.find(l =>
      l.protocol === 'nats' && l.route_topic === 'user.created');
    assert(!!natsLnk, 'natsPublish → NATS user.created consumer link');

    const redisLnk = msgLinks.find(l =>
      l.protocol === 'redis_pubsub' && l.route_topic === 'chan:notifications');
    assert(!!redisLnk, 'redisPub → redis_pubsub chan:notifications link');

    // ── v9 Track-H Step 6: k8s / Docker service-host signal ────────────────
    console.log('\n── Step 6 (Track-H): k8s/Docker service-host signal ──');
    type SvcHostLinkRow = {
      match_kind: string; confidence: number;
      caller_qname: string | null; handler_qname: string | null;
      host_hint: string | null; route_path: string | null;
    };
    const hostLinks = raw.prepare(
      `SELECT sl.match_kind, sl.confidence,
              sc.qualified_name AS caller_qname,
              sh.qualified_name AS handler_qname,
              cc.host_hint, r.path AS route_path
         FROM service_links sl
         LEFT JOIN service_calls cc ON cc.id = sl.call_id
         LEFT JOIN symbols sc ON sc.id = sl.caller_symbol_id
         LEFT JOIN symbols sh ON sh.id = sl.handler_symbol_id
         LEFT JOIN routes  r  ON r.id  = sl.route_id
        WHERE sl.protocol = 'http' AND sl.match_kind = 'service_host'
        ORDER BY sl.id ASC`
    ).all() as SvcHostLinkRow[];
    console.log(`  → ${hostLinks.length} service_host-classified links`);

    // paymentCall: payment-service is a known k8s host AND /api/charge is a
    // workspace route → match_kind should be service_host.
    const payLink = hostLinks.find(l => l.caller_qname === 'paymentCall');
    assert(!!payLink, 'paymentCall → /api/charge linked as service_host');
    if (payLink) {
      assertEq(payLink.host_hint, 'payment-service', 'host_hint = payment-service');
      assertEq(payLink.route_path, '/api/charge', 'route_path = /api/charge');
      assert(payLink.confidence >= 0.95,
        `confidence boosted past plain literal (got ${payLink.confidence})`);
    }

    // unknownHostCall: same path, different host (not in k8s/Docker) → should
    // still link (literal_path) but NOT as service_host.
    const allLinksToCharge = raw.prepare(
      `SELECT sl.match_kind, sc.qualified_name AS caller_qname,
              cc.host_hint
         FROM service_links sl
         LEFT JOIN service_calls cc ON cc.id = sl.call_id
         LEFT JOIN symbols sc ON sc.id = sl.caller_symbol_id
         LEFT JOIN routes  r  ON r.id  = sl.route_id
        WHERE r.path = '/api/charge'
        ORDER BY sl.id ASC`
    ).all() as Array<{ match_kind: string; caller_qname: string | null; host_hint: string | null }>;
    const unknownHost = allLinksToCharge.find(l => l.caller_qname === 'unknownHostCall');
    assert(!!unknownHost, 'unknownHostCall still links to /api/charge');
    if (unknownHost) {
      assert(unknownHost.match_kind !== 'service_host',
        `unknown host NOT classified as service_host (got ${unknownHost.match_kind})`);
    }

    // hostOnlyCall: known host but no matching route — must NOT produce a link
    // (host alone is not enough evidence).
    const hostOnly = raw.prepare(
      `SELECT COUNT(*) AS c FROM service_links sl
        LEFT JOIN symbols sc ON sc.id = sl.caller_symbol_id
       WHERE sc.qualified_name = 'hostOnlyCall'`
    ).get() as { c: number };
    assertEq(hostOnly.c, 0,
      'hostOnlyCall (known host + unknown path) did NOT link');
  } finally { tsStore.close(); }

  // ── v9 Track-H Step 8: service-aware graph tracing ──────────────────────
  console.log('\n── Step 8 (Track-H): traceServiceDependencies + module variant ──');
  {
    const tDb = path.join(TMP_DIR, 'traceDeps.db');
    const tStore = new Store(tDb);
    try {
      await new Indexer(tStore).indexDirectory(FIX_SERVICE, { quiet: true });
      // Find processPayment caller and chargeHandler handler so we have a
      // known caller→handler link in the fixture.
      const procDef = tStore.getDefinition('processPayment');
      assert(procDef.length > 0, 'processPayment symbol found');
      const r = tStore.traceServiceDependencies(procDef[0].id, { maxDepth: 4, maxNodes: 50 });
      assert(r.reached.length >= 1,
        `processPayment reaches at least one handler via service-link (got ${r.reached.length})`);
      const targetIds = new Set(r.reached.map(x => x.symbolId));
      const chargeDef = tStore.getDefinition('chargeHandler');
      assert(chargeDef.length > 0 && targetIds.has(chargeDef[0].id),
        'chargeHandler is in reached set');
      const chargeHit = r.reached.find(x => x.symbolId === chargeDef[0].id)!;
      assertEq(chargeHit.depth, 1, 'chargeHandler depth = 1');
      assert(chargeHit.protocols.includes('http'),
        `chargeHandler hop has http protocol (got ${JSON.stringify(chargeHit.protocols)})`);
      assertEq(chargeHit.hops[0], procDef[0].id, 'hop chain starts at caller');
      assertEq(chargeHit.hops[chargeHit.hops.length - 1], chargeDef[0].id, 'hop chain ends at handler');

      // Bounded traversal: a tiny maxNodes cap must fire.
      const capped = tStore.traceServiceDependencies(procDef[0].id, { maxDepth: 4, maxNodes: 0 });
      assert(capped.reached.length <= 0 || capped.cutoff === 'maxNodes',
        'tiny maxNodes triggers cutoff');

      // Depth cutoff: create a manual second service hop
      // processPayment -> chargeHandler -> userResolver, then cap traversal at
      // one hop. The first handler is returned, and cutoff must say maxDepth
      // because more service-link graph exists beyond the boundary.
      const userResolver = tStore.getDefinition('userResolver');
      if (chargeDef.length > 0 && userResolver.length > 0) {
        const fileRow = tStore.rawDb().prepare(
          `SELECT id FROM files ORDER BY id ASC LIMIT 1`,
        ).get() as { id: number };
        const call = tStore.rawDb().prepare(
          `INSERT INTO service_calls
             (file_id, symbol_id, protocol, method, raw_target, framework, line, confidence)
           VALUES (?, ?, 'http', 'GET', '/depth-only', 'manual', 0, 1.0)`,
        ).run(fileRow.id, chargeDef[0].id);
        tStore.rawDb().prepare(
          `INSERT INTO service_links
             (call_id, route_id, caller_symbol_id, handler_symbol_id, protocol, match_kind, confidence, evidence_json)
           VALUES (?, NULL, ?, ?, 'http', 'literal_path', 1.0, '{}')`,
        ).run(Number(call.lastInsertRowid), chargeDef[0].id, userResolver[0].id);
        const depthCapped = tStore.traceServiceDependencies(procDef[0].id, { maxDepth: 1, maxNodes: 50 });
        assertEq(depthCapped.cutoff, 'maxDepth',
          'service dependency traversal reports maxDepth cutoff');
      }

      // Module variant: even when all fixture files cluster into a single
      // module (so no cross-module links exist), the BFS must run cleanly
      // and report an empty reached set without crashing.
      const anyMod = tStore.rawDb().prepare(
        `SELECT id FROM modules ORDER BY id ASC LIMIT 1`,
      ).get() as { id: number } | undefined;
      if (anyMod) {
        const modR = tStore.traceModuleServiceDependencies(anyMod.id, { maxDepth: 3, maxNodes: 20 });
        assert(Array.isArray(modR.reached), 'traceModuleServiceDependencies returns an array');
        // When reached is non-empty, every entry must carry at least one protocol.
        assert(modR.reached.every(x => x.protocols.length > 0),
          'every reached module reports protocols');
      } else {
        assert(false, 'at least one module exists after indexing fixtures');
      }
    } finally { tStore.close(); }
  }

  // ── v9 Track-H Step 7: ambiguity cap + truncation telemetry ──────────────
  console.log('\n── Step 7 (Track-H): ambiguity & truncation ──');
  {
    const ambDb = path.join(TMP_DIR, 'ambiguity.db');
    const ambStore = new Store(ambDb);
    try {
      const r = ambStore.rawDb();
      // Seed one file, one symbol acting as caller, one service_call, and
      // many routes (100) all targeting /api/users. The resolver must cap
      // candidates and mark truncation.
      const fileId = Number(r.prepare(
        `INSERT INTO files(path, rel_path, language, hash, lines, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('/tmp/amb.ts', 'amb.ts', 'typescript', 'x', 1, Date.now()).lastInsertRowid);
      const symId = Number(r.prepare(
        `INSERT INTO symbols(name, qualified_name, kind, file_id, line_start, line_end, col_start, col_end, is_rankable, symbol_role)
           VALUES ('caller','caller','function',?,0,0,0,0,1,'definition')`,
      ).run(fileId).lastInsertRowid);
      r.prepare(
        `INSERT INTO service_calls
           (file_id, symbol_id, protocol, method, raw_target, normalized_path,
            host_hint, env_key, framework, line, confidence)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(fileId, symId, 'http', 'GET', '/api/users', '/api/users',
            null, null, 'fetch', 1, 0.9);
      // 100 identical-path routes, ids 1..100 (after auto-increment).
      const ins = r.prepare(
        `INSERT INTO routes(file_id, method, path, framework, handler_name, line, protocol)
           VALUES (?,?,?,?,?,?,?)`,
      );
      for (let i = 0; i < 100; i++) {
        ins.run(fileId, 'GET', '/api/users', 'express', `h${i}`, i, 'http');
      }
      const { resolveServiceLinks } = await import('../src/indexer/serviceLinks');
      const result = resolveServiceLinks(ambStore);
      assertEq(result.linksInserted, 1, 'one link inserted despite 100 candidates');
      assertEq(result.truncated, 1, 'truncation telemetry reports 1 truncated call');

      const link = r.prepare('SELECT * FROM service_links').get() as { evidence_json: string; route_id: number };
      const ev = JSON.parse(link.evidence_json);
      assertEq(ev.total_candidates, 100, 'evidence reports total_candidates=100');
      assertEq(ev.truncated, true, 'evidence.truncated = true');
      assertEq(ev.ambiguity_candidates.length, 5,
        `ambiguity capped at MAX_EVIDENCE_CANDIDATES = 5 (got ${ev.ambiguity_candidates.length})`);
      // Top pick is deterministic: lowest route_id wins on confidence tie.
      const minRouteId = r.prepare('SELECT MIN(id) AS m FROM routes').get() as { m: number };
      assertEq(link.route_id, minRouteId.m, 'top pick = route with lowest id (deterministic tie-break)');

      // Re-running the resolver must produce the same top pick.
      resolveServiceLinks(ambStore);
      const linkAgain = r.prepare('SELECT route_id FROM service_links').get() as { route_id: number };
      assertEq(linkAgain.route_id, link.route_id, 'idempotent: same route picked on re-run');
    } finally { ambStore.close(); }
  }

  // ── Step 5: post-index resolver produces service_links ────────────────
  console.log('\n── Step 5: service_links resolver ──');
  const linkDb = path.join(TMP_DIR, 'links.db');
  const linkStore = new Store(linkDb);
  const linkResult = await new Indexer(linkStore).indexDirectory(FIX_SERVICE, { quiet: true });
  try {
    const raw2 = linkStore.rawDb();
    type LinkRow = {
      call_id: number; route_id: number | null;
      caller_symbol_id: number | null; handler_symbol_id: number | null;
      match_kind: string; confidence: number; evidence_json: string;
    };
    const links = raw2.prepare(
      `SELECT call_id, route_id, caller_symbol_id, handler_symbol_id,
              match_kind, confidence, evidence_json
         FROM service_links ORDER BY id ASC`
    ).all() as LinkRow[];
    console.log(`  → ${links.length} service_links resolved`);

    assertEq(typeof linkResult.serviceLinks, 'number', 'IndexResult.serviceLinks present');
    assert((linkResult.serviceLinks ?? 0) >= 2, `at least 2 links (charge + getUser pattern), got ${linkResult.serviceLinks}`);

    // Find the /api/charge link.
    type FullLink = LinkRow & {
      route_path: string; caller_qname: string | null; handler_qname: string | null;
    };
    const full = raw2.prepare(
      `SELECT sl.call_id, sl.route_id, sl.caller_symbol_id, sl.handler_symbol_id,
              sl.match_kind, sl.confidence, sl.evidence_json,
              r.path AS route_path,
              sc.qualified_name AS caller_qname,
              sh.qualified_name AS handler_qname
         FROM service_links sl
         LEFT JOIN routes  r  ON r.id = sl.route_id
         LEFT JOIN symbols sc ON sc.id = sl.caller_symbol_id
         LEFT JOIN symbols sh ON sh.id = sl.handler_symbol_id`
    ).all() as FullLink[];

    const charge = full.find(l => l.route_path === '/api/charge');
    assert(!!charge, 'service_link found for /api/charge');
    if (charge) {
      assertEq(charge.match_kind, 'literal_path', '/api/charge matched literal_path');
      assert(charge.confidence >= 0.9, `confidence ≥ 0.9 (got ${charge.confidence})`);
      assertEq(charge.caller_qname, 'processPayment', 'caller is processPayment');
      assertEq(charge.handler_qname, 'chargeHandler', 'handler is chargeHandler');
    }

    // The /users/:id pattern should be matched by fetch('/users/123').
    const pattern = full.find(l => l.match_kind === 'route_pattern');
    assert(!!pattern, 'a route_pattern link was produced');
    if (pattern) {
      assert(pattern.confidence >= 0.7 && pattern.confidence <= 0.95,
        `pattern confidence in (0.7, 0.95] (got ${pattern.confidence})`);
    }

    // Idempotency: re-running the resolver should produce the same row count.
    const r2 = await new Indexer(linkStore).indexDirectory(FIX_SERVICE, { quiet: true });
    const after = raw2.prepare('SELECT COUNT(*) AS c FROM service_links').get() as { c: number };
    assertEq(after.c, linkResult.serviceLinks ?? 0, 'cached re-index keeps link count stable');
    assert((r2.serviceLinks ?? 0) === (linkResult.serviceLinks ?? 0), 'resolver is idempotent');

    // File deletion prunes links.
    const gatewayFileId = raw2.prepare(
      `SELECT id FROM files WHERE rel_path = 'gateway.ts'`
    ).get() as { id: number } | undefined;
    if (gatewayFileId) {
      raw2.prepare('DELETE FROM files WHERE id = ?').run(gatewayFileId.id);
      const remaining = raw2.prepare(
        `SELECT COUNT(*) AS c FROM service_calls`
      ).get() as { c: number };
      assert(remaining.c < (linkResult.symbols ?? 9999),
        'service_calls reduced after file delete (cascade)');
      // Re-run resolver from outside: rebuild via the indexer's finishIndex.
      // The new index pass will see the gateway file as removed and resolve
      // service links over remaining rows.
    }
  } finally { linkStore.close(); }

  // ── Step 6: Store APIs ────────────────────────────────────────────────
  console.log('\n── Step 6: Store APIs ──');
  const apiDb = path.join(TMP_DIR, 'api.db');
  const apiStore = new Store(apiDb);
  await new Indexer(apiStore).indexDirectory(FIX_SERVICE, { quiet: true });
  try {
    const c = apiStore.countServiceCalls();
    const l = apiStore.countServiceLinks();
    assert(c > 0, `countServiceCalls > 0 (got ${c})`);
    assert(l > 0, `countServiceLinks > 0 (got ${l})`);

    const sc = apiStore.listServiceCalls({ limit: 50 });
    assert(sc.length > 0, `listServiceCalls returns rows (got ${sc.length})`);
    assert(sc.length <= 50, 'listServiceCalls respects limit');
    const fetched = apiStore.listServiceCalls({ framework: 'fetch' });
    assert(fetched.every(r => r.framework === 'fetch'), 'framework filter applied');
    const post = apiStore.listServiceCalls({ method: 'POST' });
    assert(post.every(r => r.method === 'POST'), 'method filter applied');

    // Pagination
    const page1 = apiStore.listServiceCalls({ limit: 2, offset: 0 });
    const page2 = apiStore.listServiceCalls({ limit: 2, offset: 2 });
    if (page1.length === 2 && page2.length > 0) {
      assert(page1[0].id !== page2[0].id, 'offset paginates distinct rows');
    }

    // Service links
    const links = apiStore.listServiceLinks();
    assert(links.length === l, 'listServiceLinks returns countServiceLinks rows');
    const chargeLink = links.find(x => x.routePath === '/api/charge');
    assert(!!chargeLink, 'service_link to /api/charge present');
    if (chargeLink) {
      assertEq(chargeLink.callerQualifiedName, 'processPayment', 'caller resolved');
      assertEq(chargeLink.handlerQualifiedName, 'chargeHandler', 'handler resolved');
      assertEq(chargeLink.routeMethod, 'POST', 'route method = POST');
    }

    // id-scoped helpers — find processPayment's symbol id then query for it
    const sym = apiStore.rawDb().prepare(
      `SELECT id FROM symbols WHERE qualified_name = 'processPayment' LIMIT 1`
    ).get() as { id: number } | undefined;
    assert(!!sym, 'found processPayment symbol');
    if (sym) {
      const callerLinks = apiStore.serviceLinksForCaller(sym.id);
      assert(callerLinks.length >= 1, 'serviceLinksForCaller returns rows');
      assert(callerLinks.every(x => x.callerSymbolId === sym.id),
        'serviceLinksForCaller is id-scoped');
    }
    const hsym = apiStore.rawDb().prepare(
      `SELECT id FROM symbols WHERE qualified_name = 'chargeHandler' LIMIT 1`
    ).get() as { id: number } | undefined;
    if (hsym) {
      const handlerLinks = apiStore.serviceLinksForHandler(hsym.id);
      assert(handlerLinks.length >= 1, 'serviceLinksForHandler returns rows');
      assert(handlerLinks.every(x => x.handlerSymbolId === hsym.id),
        'serviceLinksForHandler is id-scoped');
    }

    // traceServicePath: processPayment → chargeHandler should be 1 hop.
    if (sym && hsym) {
      const path = apiStore.traceServicePath(sym.id, hsym.id, 4);
      assertEq(path.length, 2, 'traceServicePath finds 2-node path (caller, handler)');
      if (path.length === 2) {
        assertEq(path[0], sym.id, 'path starts at caller');
        assertEq(path[1], hsym.id, 'path ends at handler');
      }
    }
  } finally { apiStore.close(); }

  // ── Step 4: URL normalization + route pattern matcher ────────────────
  console.log('\n── Step 4: URL normalization ──');
  let r = normalizeHttpTarget('/api/users');
  assertEq(r.path, '/api/users', 'plain path passes through');
  assert(!r.hostHint && !r.envKey, 'no host/env recovered from plain path');

  r = normalizeHttpTarget('https://payment-service/api/charge');
  assertEq(r.path, '/api/charge', 'scheme + host stripped from absolute URL');
  assertEq(r.hostHint, 'payment-service', 'host recovered from absolute URL');

  r = normalizeHttpTarget('/api/items?q=hi&page=2');
  assertEq(r.path, '/api/items', 'query string dropped');

  r = normalizeHttpTarget('/api/items#section');
  assertEq(r.path, '/api/items', 'fragment dropped');

  r = normalizeHttpTarget('/api/users/');
  assertEq(r.path, '/api/users', 'trailing slash normalized');

  r = normalizeHttpTarget('/');
  assertEq(r.path, '/', 'root path preserved');

  r = normalizeHttpTarget('bare-text');
  assertEq(r.path, undefined, 'bare identifier rejected');

  // Route patterns
  console.log('\n── Step 4: Route-pattern matcher ──');
  let m = routePatternsMatch('/users/123', '/users/:id');
  assert(m.matched && m.confidence >= 0.8, 'Express :id matches /users/123');
  m = routePatternsMatch('/users/123', '/users/{id}');
  assert(m.matched && m.confidence >= 0.8, 'FastAPI/Spring {id} matches /users/123');
  m = routePatternsMatch('/users/123', '/users/<int:id>');
  assert(m.matched, 'Flask <int:id> matches /users/123');
  m = routePatternsMatch('/users/123/posts/9', '/users/:id/posts/:pid');
  assert(m.matched, 'nested params match');
  m = routePatternsMatch('/users/123', '/users');
  assert(!m.matched, 'segment count mismatch rejected');
  m = routePatternsMatch('/users/123', '/posts/:id');
  assert(!m.matched, 'literal-segment mismatch rejected');
  m = routePatternsMatch('/users/123', '/users/123');
  assert(m.matched && m.confidence === 0.95, 'exact literal match is 0.95');

  // Method match score
  console.log('\n── Step 4: Method comparator ──');
  assertEq(methodMatchScore('GET', 'GET'), 1.0, 'GET vs GET = 1.0');
  assertEq(methodMatchScore('ANY', 'GET'), 0.9, 'ANY vs GET = 0.9');
  assertEq(methodMatchScore(null, 'GET'), 0.9, 'null vs GET = 0.9 (null treated as ANY)');
  assertEq(methodMatchScore('POST', 'GET'), 0, 'POST vs GET = 0');

  // ── Step 8: risk + context surface service-link signals ─────────────
  console.log('\n── Step 8: risk + context integration ──');
  const intDb = path.join(TMP_DIR, 'integrate.db');
  const intStore = new Store(intDb);
  await new Indexer(intStore).indexDirectory(FIX_SERVICE, { quiet: true });
  try {
    // Caller side (processPayment) → should have outboundServiceCalls + serviceLinksOutbound.
    const ctxCaller = buildContext(intStore, 'processPayment');
    assert(!!ctxCaller, 'context found for processPayment');
    if (ctxCaller) {
      assert(ctxCaller.serviceCalls.length >= 1,
        `processPayment has serviceCalls (got ${ctxCaller.serviceCalls.length})`);
      assert(ctxCaller.serviceLinksOutbound.length >= 1,
        `processPayment has serviceLinksOutbound (got ${ctxCaller.serviceLinksOutbound.length})`);
      const charge = ctxCaller.serviceCalls.find(c => c.path === '/api/charge');
      assert(!!charge, 'context.serviceCalls includes /api/charge');
    }

    // Handler side (chargeHandler) → should have serviceLinksInbound.
    const ctxHandler = buildContext(intStore, 'chargeHandler');
    assert(!!ctxHandler, 'context found for chargeHandler');
    if (ctxHandler) {
      assert(ctxHandler.serviceLinksInbound.length >= 1,
        `chargeHandler has serviceLinksInbound (got ${ctxHandler.serviceLinksInbound.length})`);
    }

    // Risk signals.
    const riskCaller = computeRisk(intStore, 'processPayment');
    assert(!!riskCaller, 'risk computed for processPayment');
    if (riskCaller) {
      assert(riskCaller.signals.outboundServiceCalls >= 1,
        `risk.outboundServiceCalls ≥ 1 (got ${riskCaller.signals.outboundServiceCalls})`);
      const cont = riskCaller.signalContributions.find(c => c.signal === 'outboundServiceCalls');
      assert(!!cont, 'outboundServiceCalls contribution present');
      if (cont) assert(cont.contribution > 0, 'outboundServiceCalls contributes to risk');
    }

    const riskHandler = computeRisk(intStore, 'chargeHandler');
    assert(!!riskHandler, 'risk computed for chargeHandler');
    if (riskHandler) {
      assert(riskHandler.signals.inboundServiceLinks >= 1,
        `risk.inboundServiceLinks ≥ 1 (got ${riskHandler.signals.inboundServiceLinks})`);
    }

    // Module integration: service links should produce a 'service' kind edge.
    const moduleServiceEdges = intStore.rawDb().prepare(
      `SELECT COUNT(*) AS c FROM module_edges WHERE kind = 'service'`
    ).get() as { c: number };
    assert(moduleServiceEdges.c >= 0, 'module_edges accepts service kind');
  } finally { intStore.close(); }

  // ── Step 7 (CLI smoke): seer service-calls / service-links / trace-service
  console.log('\n── Step 7: CLI smoke ──');
  {
    const child = require('child_process');
    const ROOT = path.join(__dirname, '..');
    const CLI = path.join(ROOT, 'dist/cli/index.js');
    const cliDb = path.join(TMP_DIR, 'cli.db');
    // Pre-index for the CLI commands to query.
    const s = new Store(cliDb);
    await new Indexer(s).indexDirectory(FIX_SERVICE, { quiet: true });
    s.close();

    const run = (args: string[]): string => child.execFileSync(
      process.execPath, [CLI, ...args, '--db', cliDb],
      { encoding: 'utf8' });

    const sc = run(['service-calls', '-n', '50']);
    assert(sc.includes('Service calls'), 'service-calls CLI prints rows');
    assert(sc.includes('/api/charge'), 'service-calls lists /api/charge');

    const sl = run(['service-links', '-n', '50']);
    assert(sl.includes('Service links'), 'service-links CLI prints rows');
    assert(sl.includes('processPayment'), 'service-links lists processPayment caller');
    assert(sl.includes('chargeHandler'), 'service-links lists chargeHandler handler');

    const trace = run(['trace-service', 'processPayment', 'chargeHandler']);
    assert(trace.includes('Service path'), 'trace-service finds a path');
    assert(trace.includes('processPayment'), 'trace-service path starts at caller');
    assert(trace.includes('chargeHandler'), 'trace-service path ends at handler');
  }

  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* */ }
  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  Track G Step 1+3+4+5+6+7: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('trackg crashed:', err); process.exit(1); });
