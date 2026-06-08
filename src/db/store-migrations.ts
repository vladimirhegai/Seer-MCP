// Schema migrations for the Store.
//
// SCHEMA_SQL (schema.ts) creates a brand-new DB at the current version. These
// routines bring an OLDER on-disk DB up to the current layout: ALTER TABLE ADD
// COLUMN for additive columns, CREATE TABLE/INDEX IF NOT EXISTS for new tables,
// and a couple of one-time backfills. runMigrations() runs on every writable
// Store open (it is a no-op once the DB is already current), so any breakage
// here surfaces immediately across the test suite.
//
// These are free functions taking the DatabaseSync handle rather than Store
// methods so the migration logic — the single largest block in the old
// store.ts — lives apart from the query/write surface.

import { DatabaseSync } from 'node:sqlite';
import { CURRENT_SCHEMA_VERSION } from './schema.js';
import { Row, toNum, toStr, splitIdentifierTokens } from './store-helpers.js';

export function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    return cols.some(c => toStr(c.name) === column);
  } catch {
    return false;
  }
}

export function addColumnIfMissing(db: DatabaseSync, table: string, column: string, def: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
  if (cols.some(c => toStr(c.name) === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}

/**
 * Populate symbols.symbol_key for every existing row. Mirrors
 * makeSymbolKey() — `kind:qualified_name` (or `kind:name` if qualified is
 * NULL). symbol_history is keyed on these so without the backfill,
 * listSymbolsForHistoryIndex() returns zero candidates after a v3→v4
 * upgrade.
 */
function backfillSymbolKeys(db: DatabaseSync): void {
  try {
    db.exec(`
      UPDATE symbols
      SET symbol_key = kind || ':' || COALESCE(qualified_name, name)
      WHERE symbol_key IS NULL
    `);
  } catch { /* table may not exist on a brand-new DB; non-fatal */ }
}

/**
 * Rebuild symbols_fts / files_fts from the current symbols / files rows if
 * either FTS table is empty while its source table has rows. This is the
 * only safe trigger condition — Seer never deliberately leaves FTS empty
 * while symbols are populated, so emptiness is a reliable "stale FTS"
 * signal (post-migration or post-manual-patch).
 */
function rebuildFtsIfStale(db: DatabaseSync): void {
  try {
    const sym = db.prepare('SELECT COUNT(*) AS c FROM symbols').get() as Row;
    const symFts = db.prepare('SELECT COUNT(*) AS c FROM symbols_fts').get() as Row;
    if (toNum(sym.c) > 0 && toNum(symFts.c) === 0) {
      const ins = db.prepare(
        'INSERT INTO symbols_fts(rowid, name, qualified_name, signature, split) VALUES (?, ?, ?, ?, ?)',
      );
      const rows = db.prepare(
        'SELECT id, name, qualified_name, signature FROM symbols',
      ).all() as Row[];
      db.exec('BEGIN');
      try {
        for (const r of rows) {
          const name = toStr(r.name);
          const qual = toStr(r.qualified_name ?? r.name);
          ins.run(
            toNum(r.id), name, qual, toStr(r.signature ?? ''),
            splitIdentifierTokens(`${name} ${qual}`),
          );
        }
        db.exec('COMMIT');
      } catch (err) { db.exec('ROLLBACK'); throw err; }
    }
  } catch { /* FTS5 unavailable; non-fatal */ }
  try {
    const file = db.prepare('SELECT COUNT(*) AS c FROM files').get() as Row;
    const fileFts = db.prepare('SELECT COUNT(*) AS c FROM files_fts').get() as Row;
    if (toNum(file.c) > 0 && toNum(fileFts.c) === 0) {
      const ins = db.prepare('INSERT INTO files_fts(rowid, rel_path) VALUES (?, ?)');
      const rows = db.prepare('SELECT id, rel_path FROM files').all() as Row[];
      db.exec('BEGIN');
      try {
        for (const r of rows) {
          ins.run(toNum(r.id), splitIdentifierTokens(toStr(r.rel_path)));
        }
        db.exec('COMMIT');
      } catch (err) { db.exec('ROLLBACK'); throw err; }
    }
  } catch { /* FTS5 unavailable; non-fatal */ }
}

export function runMigrations(db: DatabaseSync): void {
  addColumnIfMissing(db, 'symbols', 'qualified_name', 'TEXT');
  addColumnIfMissing(
    db,
    'file_imports',
    'resolved_file_id',
    'INTEGER REFERENCES files(id) ON DELETE SET NULL',
  );
  addColumnIfMissing(db, 'files', 'role',         "TEXT NOT NULL DEFAULT 'project'");
  addColumnIfMissing(db, 'files', 'is_vendor',    'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'files', 'is_generated', 'INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_role         ON files(role)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_is_vendor    ON files(is_vendor)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_is_generated ON files(is_generated)');

  // v3: is_rankable
  const isV3Migration = !hasColumn(db, 'symbols', 'is_rankable');
  addColumnIfMissing(db, 'symbols', 'is_rankable', 'INTEGER NOT NULL DEFAULT 1');
  db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_is_rankable ON symbols(is_rankable)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_file_name ON symbols(file_id, name)');
  if (isV3Migration) {
    db.prepare(
      `UPDATE symbols SET is_rankable = 0 WHERE kind NOT IN ('function','method','constructor','class')`,
    ).run();
    db.prepare('UPDATE symbols SET pagerank = 0 WHERE is_rankable = 0').run();
  }

  // v4: complexity columns, symbol_key, edges.kind index
  const isV4Migration = !hasColumn(db, 'symbols', 'symbol_key');
  addColumnIfMissing(db, 'symbols', 'loc',         'INTEGER');
  addColumnIfMissing(db, 'symbols', 'cyclomatic',  'INTEGER');
  addColumnIfMissing(db, 'symbols', 'cognitive',   'INTEGER');
  addColumnIfMissing(db, 'symbols', 'max_nesting', 'INTEGER');
  addColumnIfMissing(db, 'symbols', 'symbol_key',  'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_symbol_key ON symbols(symbol_key)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_edges_from_to_kind ON edges(from_id, to_id, kind)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_edges_to_name_kind ON edges(to_name, kind)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_edges_to_id_kind_from ON edges(to_id, kind, from_id)');

  // v4.1: separate history HEAD marker so churn doesn't poison the
  // skip-if-unchanged check used by buildSymbolHistory. Cheap ALTER ADD;
  // existing DBs get NULL which forces history to run on next invocation.
  addColumnIfMissing(db, 'git_index_state', 'last_history_head_sha', 'TEXT');
  addColumnIfMissing(db, 'git_index_state', 'last_history_at',       'INTEGER');
  // v11+: persist the --follow choice used for the last full build so
  // incremental refreshes can replicate it without scanning watermarks.
  // NULL = unknown (old DB) → treated as false (the B2 default).
  addColumnIfMissing(db, 'git_index_state', 'last_history_follow',   'INTEGER');
  // Persist the resolved --since horizon (unix-seconds lower bound) used by the
  // last full build, so an incremental post-index refresh replicates the SAME
  // absolute bound. Replicating the stored value (not recomputing now-2y each
  // run) is what keeps the per-file options fingerprint — and therefore resume
  // watermarks — stable across refreshes. NULL = unbounded (the default).
  addColumnIfMissing(db, 'git_index_state', 'last_history_since',    'INTEGER');

  // v5: symbol_role on symbols. The NOT NULL DEFAULT 'definition' on the
  // ALTER means every pre-v5 row gets a sane default without an explicit
  // UPDATE backfill. The role only changes its meaning when the indexer
  // re-runs against the file (e.g. for C/C++ fixtures where field_declaration
  // is now emitted as 'declaration').
  addColumnIfMissing(db, 'symbols', 'symbol_role', "TEXT NOT NULL DEFAULT 'definition'");
  db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_symbol_role ON symbols(symbol_role)');

  // v7: provenance + shape_hash on symbols/edges, plus scip_imports table.
  // ALTER ADD COLUMN paths are cheap and idempotent; the index creation is
  // guarded by hasColumn so a partial migration on an older DB doesn't fail.
  addColumnIfMissing(db, 'symbols', 'provenance', "TEXT NOT NULL DEFAULT 'tree-sitter'");
  addColumnIfMissing(db, 'symbols', 'shape_hash', 'INTEGER');
  addColumnIfMissing(db, 'edges',   'provenance', "TEXT NOT NULL DEFAULT 'tree-sitter'");
  // v7.1 — scip_import_id links a SCIP-provenance row back to the
  // scip_imports table entry that produced it, so re-importing or clearing
  // ONE SCIP layer doesn't nuke rows contributed by sibling layers (the
  // original v7 wipe was global, which collapsed multi-layer setups).
  addColumnIfMissing(db, 'symbols', 'scip_import_id', 'INTEGER');
  addColumnIfMissing(db, 'edges',   'scip_import_id', 'INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_provenance ON symbols(provenance)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_shape_hash ON symbols(shape_hash) WHERE shape_hash IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_edges_provenance  ON edges(provenance)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_scip_import ON symbols(scip_import_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_edges_scip_import  ON edges(scip_import_id)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS scip_imports (
      id            INTEGER PRIMARY KEY,
      path          TEXT    NOT NULL,
      sha256        TEXT    NOT NULL,
      tool          TEXT,
      project_root  TEXT,
      imported_at   INTEGER NOT NULL,
      symbol_count  INTEGER NOT NULL DEFAULT 0,
      ref_count     INTEGER NOT NULL DEFAULT 0,
      UNIQUE(path, sha256)
    );
    CREATE INDEX IF NOT EXISTS idx_scip_imports_path ON scip_imports(path);
  `);

  // v6: modules + module_members + module_edges. CREATE TABLE IF NOT EXISTS
  // is the migration — pre-v6 DBs get the tables on first writer open.
  // No backfill needed: the clustering pass repopulates them on the next
  // index run (it always runs when the graph changed; otherwise the cached
  // membership stays valid because the graph it was built from stays valid).
  db.exec(`
    CREATE TABLE IF NOT EXISTS modules (
      id              INTEGER PRIMARY KEY,
      label           TEXT    NOT NULL,
      size_files      INTEGER NOT NULL DEFAULT 0,
      size_symbols    INTEGER NOT NULL DEFAULT 0,
      primary_language TEXT,
      cohesion        REAL    NOT NULL DEFAULT 0,
      centrality      REAL    NOT NULL DEFAULT 0,
      computed_at     INTEGER NOT NULL DEFAULT 0,
      algorithm       TEXT    NOT NULL DEFAULT 'louvain'
    );
    CREATE INDEX IF NOT EXISTS idx_modules_label      ON modules(label);
    CREATE INDEX IF NOT EXISTS idx_modules_centrality ON modules(centrality DESC);
    CREATE INDEX IF NOT EXISTS idx_modules_size       ON modules(size_files DESC);
    CREATE TABLE IF NOT EXISTS module_members (
      file_id    INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
      module_id  INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_module_members_module ON module_members(module_id);
    CREATE TABLE IF NOT EXISTS module_edges (
      id              INTEGER PRIMARY KEY,
      from_module_id  INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      to_module_id    INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      kind            TEXT    NOT NULL DEFAULT 'call',
      weight          INTEGER NOT NULL DEFAULT 1,
      UNIQUE(from_module_id, to_module_id, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_module_edges_from   ON module_edges(from_module_id);
    CREATE INDEX IF NOT EXISTS idx_module_edges_to     ON module_edges(to_module_id);
  `);

  // v8: Track-G service_calls + service_links. CREATE TABLE IF NOT EXISTS
  // is the migration. Existing cached DBs need one forced parse pass to
  // populate service_calls; needsServiceCallBackfill() + the indexer marker
  // handle that so unchanged hashes do not leave the tables empty forever.
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_calls (
      id              INTEGER PRIMARY KEY,
      file_id         INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      symbol_id       INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
      protocol        TEXT    NOT NULL,
      method          TEXT,
      raw_target      TEXT    NOT NULL,
      normalized_path TEXT,
      host_hint       TEXT,
      env_key         TEXT,
      framework       TEXT    NOT NULL,
      line            INTEGER NOT NULL DEFAULT 0,
      confidence      REAL    NOT NULL DEFAULT 0.5
    );
    CREATE INDEX IF NOT EXISTS idx_service_calls_symbol_id ON service_calls(symbol_id);
    CREATE INDEX IF NOT EXISTS idx_service_calls_path      ON service_calls(normalized_path);
    CREATE INDEX IF NOT EXISTS idx_service_calls_protocol  ON service_calls(protocol);
    CREATE INDEX IF NOT EXISTS idx_service_calls_file_id   ON service_calls(file_id);

    CREATE TABLE IF NOT EXISTS service_links (
      id                INTEGER PRIMARY KEY,
      call_id           INTEGER NOT NULL REFERENCES service_calls(id) ON DELETE CASCADE,
      route_id          INTEGER REFERENCES routes(id) ON DELETE CASCADE,
      caller_symbol_id  INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
      handler_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
      protocol          TEXT    NOT NULL,
      match_kind        TEXT    NOT NULL,
      confidence        REAL    NOT NULL,
      evidence_json     TEXT    NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_service_links_call_id    ON service_links(call_id);
    CREATE INDEX IF NOT EXISTS idx_service_links_handler    ON service_links(handler_symbol_id);
    CREATE INDEX IF NOT EXISTS idx_service_links_caller     ON service_links(caller_symbol_id);
    CREATE INDEX IF NOT EXISTS idx_service_links_protocol   ON service_links(protocol);
    CREATE INDEX IF NOT EXISTS idx_service_links_match_kind ON service_links(match_kind);
  `);

  // v9: Track-H protocol expansion. Adds generalized columns to service_calls
  // and routes so non-HTTP protocols (tRPC / GraphQL / gRPC / Kafka / etc.)
  // can be stored alongside HTTP without one column per protocol. All
  // additions are nullable (or default 'http' for routes.protocol) so v8 DBs
  // upgrade in-place with no data rewrite. Existing HTTP rows keep working
  // unchanged because the resolver still matches on normalized_path + method
  // when the new fields are NULL.
  addColumnIfMissing(db, 'service_calls', 'operation',     'TEXT');
  addColumnIfMissing(db, 'service_calls', 'topic',         'TEXT');
  addColumnIfMissing(db, 'service_calls', 'queue',         'TEXT');
  addColumnIfMissing(db, 'service_calls', 'exchange',      'TEXT');
  addColumnIfMissing(db, 'service_calls', 'service',       'TEXT');
  addColumnIfMissing(db, 'service_calls', 'broker',        'TEXT');
  addColumnIfMissing(db, 'service_calls', 'metadata_json', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_service_calls_operation ON service_calls(operation) WHERE operation IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_service_calls_topic     ON service_calls(topic)     WHERE topic IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_service_calls_queue     ON service_calls(queue)     WHERE queue IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_service_calls_service   ON service_calls(service)   WHERE service IS NOT NULL');

  addColumnIfMissing(db, 'routes', 'protocol',      "TEXT NOT NULL DEFAULT 'http'");
  addColumnIfMissing(db, 'routes', 'operation',     'TEXT');
  addColumnIfMissing(db, 'routes', 'topic',         'TEXT');
  addColumnIfMissing(db, 'routes', 'queue',         'TEXT');
  addColumnIfMissing(db, 'routes', 'exchange',      'TEXT');
  addColumnIfMissing(db, 'routes', 'service',       'TEXT');
  addColumnIfMissing(db, 'routes', 'broker',        'TEXT');
  addColumnIfMissing(db, 'routes', 'metadata_json', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_routes_protocol  ON routes(protocol)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_routes_operation ON routes(operation) WHERE operation IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_routes_topic     ON routes(topic)     WHERE topic IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_routes_queue     ON routes(queue)     WHERE queue IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_routes_service   ON routes(service)   WHERE service IS NOT NULL');

  // v10 — external bundle layers + monorepo boundaries + history continuity.
  // CREATE IF NOT EXISTS + ALTER ADD COLUMN keep older DBs upgradable
  // without data rewrites. The default values are chosen so HTTP/local
  // behavior is unchanged on rows that don't set the new fields.
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_bundles (
      id              INTEGER PRIMARY KEY,
      source_kind     TEXT    NOT NULL DEFAULT 'external-bundle',
      bundle_path     TEXT    NOT NULL,
      external_project TEXT,
      external_version TEXT,
      external_hash    TEXT,
      schema_version  INTEGER NOT NULL DEFAULT 0,
      imported_at     INTEGER NOT NULL,
      routes_imported INTEGER NOT NULL DEFAULT 0,
      service_calls_imported INTEGER NOT NULL DEFAULT 0,
      service_links_imported INTEGER NOT NULL DEFAULT 0,
      UNIQUE(bundle_path)
    );
    CREATE INDEX IF NOT EXISTS idx_external_bundles_project ON external_bundles(external_project);
    CREATE TABLE IF NOT EXISTS boundaries (
      id              INTEGER PRIMARY KEY,
      label           TEXT    NOT NULL,
      kind            TEXT    NOT NULL DEFAULT 'package',
      root_rel_path   TEXT    NOT NULL,
      manifest_path   TEXT,
      ecosystem       TEXT,
      size_files      INTEGER NOT NULL DEFAULT 0,
      computed_at     INTEGER NOT NULL DEFAULT 0,
      UNIQUE(root_rel_path)
    );
    CREATE INDEX IF NOT EXISTS idx_boundaries_label ON boundaries(label);
    CREATE INDEX IF NOT EXISTS idx_boundaries_kind  ON boundaries(kind);
    CREATE TABLE IF NOT EXISTS boundary_members (
      file_id     INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
      boundary_id INTEGER NOT NULL REFERENCES boundaries(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_boundary_members_boundary ON boundary_members(boundary_id);
    CREATE TABLE IF NOT EXISTS boundary_edges (
      id                INTEGER PRIMARY KEY,
      from_boundary_id  INTEGER NOT NULL REFERENCES boundaries(id) ON DELETE CASCADE,
      to_boundary_id    INTEGER NOT NULL REFERENCES boundaries(id) ON DELETE CASCADE,
      kind              TEXT    NOT NULL DEFAULT 'call',
      weight            INTEGER NOT NULL DEFAULT 1,
      UNIQUE(from_boundary_id, to_boundary_id, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_boundary_edges_from ON boundary_edges(from_boundary_id);
    CREATE INDEX IF NOT EXISTS idx_boundary_edges_to   ON boundary_edges(to_boundary_id);
    CREATE TABLE IF NOT EXISTS symbol_history_continuity (
      id                  INTEGER PRIMARY KEY,
      symbol_id           INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      symbol_key          TEXT    NOT NULL,
      previous_symbol_key TEXT,
      previous_name       TEXT,
      previous_file       TEXT,
      bridging_sha        TEXT,
      confidence          REAL    NOT NULL DEFAULT 0.0,
      match_reasons       TEXT    NOT NULL DEFAULT '[]',
      recorded_at         INTEGER NOT NULL,
      UNIQUE(symbol_id, previous_symbol_key)
    );
    CREATE INDEX IF NOT EXISTS idx_symbol_history_continuity_symbol ON symbol_history_continuity(symbol_id);
    CREATE INDEX IF NOT EXISTS idx_symbol_history_continuity_prev   ON symbol_history_continuity(previous_symbol_key);
  `);
  // v10 — external_bundle_id columns on rows that can come from an external
  // layer. NULL = local row (default).
  addColumnIfMissing(db, 'routes',         'external_bundle_id', 'INTEGER');
  addColumnIfMissing(db, 'service_calls',  'external_bundle_id', 'INTEGER');
  addColumnIfMissing(db, 'service_links',  'external_bundle_id', 'INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_routes_external_bundle ON routes(external_bundle_id) WHERE external_bundle_id IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_service_calls_external_bundle ON service_calls(external_bundle_id) WHERE external_bundle_id IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_service_links_external_bundle ON service_links(external_bundle_id) WHERE external_bundle_id IS NOT NULL');

  // v11: per-file resume watermark for the symbol-history build. CREATE TABLE
  // IF NOT EXISTS is the migration; absence on an older DB just means the next
  // build starts with no resume info (it writes watermarks as it goes).
  db.exec(`
    CREATE TABLE IF NOT EXISTS symbol_history_progress (
      repo_root            TEXT    NOT NULL,
      file_path            TEXT    NOT NULL,
      file_hash            TEXT    NOT NULL,
      options_fingerprint  TEXT    NOT NULL,
      algorithm_version    INTEGER NOT NULL DEFAULT 1,
      head_sha             TEXT,
      rows_inserted        INTEGER NOT NULL DEFAULT 0,
      processed_at         INTEGER NOT NULL,
      PRIMARY KEY (repo_root, file_path)
    );
  `);

  // v4 backfill — required because upsertFileWithCache() short-circuits on
  // unchanged content hash, so a v3 DB upgraded to v4 would never get
  // symbol_key populated (nor FTS rebuilt) for any file whose source hadn't
  // changed. That left seer_history with zero candidates and FTS search
  // returning empty for the entire pre-upgrade corpus until a manual
  // --reset. Both backfills are cheap and idempotent.
  if (isV4Migration) {
    backfillSymbolKeys(db);
  }
  // FTS rebuild: detect "v4 columns exist but FTS tables are empty while
  // symbols/files have rows". Triggers on the v3→v4 upgrade AND on the rare
  // case where a v4 DB lost its FTS rows (e.g. a manual schema patch). The
  // check is constant-time (COUNT on empty FTS is instant).
  rebuildFtsIfStale(db);

  // Prune redundant single-column edge indexes. Each is a leftmost-prefix
  // duplicate of a composite (…_kind) index, so a `from_id=?` / `to_name=?` /
  // `to_id=?` lookup is served identically by the composite (verified via
  // EXPLAIN QUERY PLAN). Existing DBs created by an older base schema still
  // carry these three; dropping them removes three b-tree updates per edge
  // insert/resolve with zero query-plan regression. DROP … IF EXISTS is a
  // cheap metadata op and a no-op on already-pruned DBs.
  db.exec('DROP INDEX IF EXISTS idx_edges_from');
  db.exec('DROP INDEX IF EXISTS idx_edges_to_name');
  db.exec('DROP INDEX IF EXISTS idx_edges_to_id');

  db.prepare(
    "INSERT INTO _schema_meta (key, value) VALUES ('schema_version', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(CURRENT_SCHEMA_VERSION));
}
