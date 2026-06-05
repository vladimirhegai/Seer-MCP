import path from 'path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { CURRENT_SCHEMA_VERSION, SCHEMA_SQL } from './schema.js';
import type {
  SymbolDef, SymbolKind, SymbolRole, SymbolRow, CallerRow, CalleeRow, StatsRow,
  RouteRow, ExternalDepRow, ConfigKeyRow, FileChurnRow, SymbolHistoryRow, SymbolHistoryInsert,
} from '../types.js';

/**
 * Which symbol kinds participate in PageRank, ranking, and the default
 * symbol list. Functions/methods/constructors/classes are rankable because
 * they are call targets — edges flow into them and meaningful behavior lives
 * there. Structs, enums, type aliases, interfaces, and variables are not
 * rankable: they are type/state declarations, not call targets.
 *
 * Excluding non-rankable kinds from PageRank is a correctness fix as much as
 * an optimization. With them included, the graph has hundreds of thousands of
 * isolated zero-edge nodes (every struct/enum row) that absorb the (1-d)/n
 * mass on each iteration but never propagate it. That dilutes every real
 * function's score and inflates compute time linearly with the noise count.
 */
const RANKABLE_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  'function', 'method', 'constructor', 'class',
]);

const SERVICE_CALLS_BACKFILL_VERSION = '1';

export function isRankableKind(kind: string): boolean {
  return RANKABLE_KINDS.has(kind as SymbolKind);
}

// Typed wrapper around node:sqlite rows (which use null prototypes)
type Row = Record<string, unknown>;

function toNum(v: unknown): number { return Number(v); }
/** Escape SQLite LIKE metacharacters (`%`, `_`, `\`) for use with ESCAPE '\'.
 *  Lets a literal filename like `bom_crlf.ts` match without `_` acting as a
 *  single-char wildcard. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, m => '\\' + m);
}
function toStr(v: unknown): string { return String(v ?? ''); }
function toNullStr(v: unknown): string | null { return v == null ? null : String(v); }
function toNullNum(v: unknown): number | null { return v == null ? null : Number(v); }

/**
 * Convert a 64-bit unsigned bigint shape hash into a signed bigint suitable
 * for storage in an SQLite INTEGER column. We treat the high bit as the sign,
 * so `0x8000_0000_0000_0000` and above wrap into negative values; this round-
 * trips losslessly with `toUnsignedI64` below.
 */
function toSignedI64(u: bigint): bigint {
  const MAX_I64 = 0x7FFFFFFFFFFFFFFFn;
  return u > MAX_I64 ? u - 0x10000000000000000n : u;
}
function toUnsignedI64(v: unknown): bigint {
  if (v == null) return 0n;
  const b = typeof v === 'bigint' ? v : BigInt(Number(v));
  return b < 0n ? b + 0x10000000000000000n : b;
}

export interface EdgeResolutionStats {
  sameFile: number;
  imported: number;
  global: number;
  total: number;
}

/**
 * What kind of code a file is. Used to keep project-owned code from being
 * drowned out by vendored or generated boilerplate in ranking and search.
 */
export type FileRole = 'project' | 'vendor' | 'generated' | 'test';

export interface FileClassification {
  role: FileRole;
  isVendor: 0 | 1;
  isGenerated: 0 | 1;
}

export interface SymbolSearchOptions {
  limit?: number;
  includeVendor?: boolean;
  includeGenerated?: boolean;
  /**
   * When false (default for agent-facing search/ranking), file-role=test
   * symbols are filtered out. seer_behavior bypasses this because the test
   * relationship IS its content; everything else (top symbols, search, deps,
   * complexity) should default to non-test code so agents don't get drowned
   * in test names. Indexer-wide test indexing stays on so seer_behavior keeps
   * working — this filter is purely query-side.
   */
  includeTests?: boolean;
  /**
   * When false (default), rows where symbol_role='declaration' (forward
   * declarations, C++ class-body method declarations whose bodies live
   * out-of-line) are hidden. Pass true to include them — useful for
   * "show me every place this method is announced" workflows.
   */
  includeDeclarations?: boolean;
  /**
   * When false (default), symbol_role='type_ref' rows stay hidden. Currently
   * Seer's extractors never emit type-ref rows, so the flag is a forward-
   * looking opt-in for future indexing modes that materialize them.
   */
  includeTypeRefs?: boolean;
}

/**
 * Build the per-table predicate clauses for the default project-first lens.
 * Used by `findSymbols` / `getDefinition` / `getTopSymbols` / `countSymbols`
 * and the MCP tool wrappers around them. Each `include*` flag turns OFF the
 * corresponding restriction.
 *
 * The function is forgiving about pre-v4 / pre-v5 DBs: when the role columns
 * or the symbol_role column don't exist on disk, the corresponding clauses
 * are simply dropped so a read-only open against an old index keeps working.
 */
function buildRoleFilter(
  filePrefix: string,
  includeVendor: boolean,
  includeGenerated: boolean,
  hasRoleColumns: boolean,
  options?: {
    symbolPrefix?: string;
    includeTests?: boolean;
    includeDeclarations?: boolean;
    includeTypeRefs?: boolean;
    hasSymbolRoleColumn?: boolean;
  },
): string {
  const clauses: string[] = [];
  if (hasRoleColumns) {
    if (!includeVendor)    clauses.push(`${filePrefix}is_vendor = 0`);
    if (!includeGenerated) clauses.push(`${filePrefix}is_generated = 0`);
    if (options && options.includeTests === false) clauses.push(`${filePrefix}role <> 'test'`);
  }
  if (options?.hasSymbolRoleColumn) {
    const sp = options.symbolPrefix ?? 's.';
    if (options.includeDeclarations === false) clauses.push(`${sp}symbol_role <> 'declaration'`);
    if (options.includeTypeRefs === false)     clauses.push(`${sp}symbol_role <> 'type_ref'`);
  }
  return clauses.length === 0 ? '' : 'AND ' + clauses.join(' AND ');
}

/**
 * Resolve the agent-facing query defaults for the include-flags. The contract:
 *   - vendor / generated stay hidden by default (existing behavior).
 *   - tests stay hidden by default for ranking/search tools, on top of the
 *     existing file-role classification. seer_behavior overrides via
 *     includeTests=true since tests ARE its content.
 *   - declarations stay hidden by default so callers/top-by-rank focus on
 *     real definition sites.
 *   - type_refs stay hidden by default (and aren't even produced yet).
 */
function resolveSearchFlags(opts: SymbolSearchOptions): {
  includeVendor: boolean;
  includeGenerated: boolean;
  includeTests: boolean;
  includeDeclarations: boolean;
  includeTypeRefs: boolean;
} {
  return {
    includeVendor:       opts.includeVendor       ?? false,
    includeGenerated:    opts.includeGenerated    ?? false,
    includeTests:        opts.includeTests        ?? false,
    includeDeclarations: opts.includeDeclarations ?? false,
    includeTypeRefs:     opts.includeTypeRefs     ?? false,
  };
}

export interface StoreOptions {
  readonly?: boolean;
  busyTimeoutMs?: number;
}

export interface SchemaInfo {
  dbVersion: number;
  buildVersion: number;
  current: boolean;
}

/**
 * Split an identifier into searchable tokens. Used at FTS-insert time so a
 * query for "auth" finds `AuthService`, `auth_service`, `authService`, and
 * `AuthServiceImpl` alike.
 *
 *  - splits on _ and -
 *  - splits camelCase boundaries (`AuthService` → "Auth Service Auth_Service")
 *  - splits consecutive caps like XMLParser → "XML Parser"
 *  - always includes the original token so prefix matches still work
 */
export function splitIdentifierTokens(s: string): string {
  if (!s) return '';
  const seen = new Set<string>();
  const push = (t: string): void => { if (t) seen.add(t.toLowerCase()); };
  push(s);
  // Split on . _ - / : ::
  for (const part of s.split(/[._\-/:]+/)) {
    push(part);
    // CamelCase / PascalCase split: split before an upper-case letter that's
    // either preceded by a lower-case letter, or followed by a lower-case
    // letter when preceded by another upper-case letter (XMLParser → XML, Parser).
    const camel = part.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
                      .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
    for (const tok of camel.split(/\s+/)) push(tok);
  }
  return Array.from(seen).join(' ');
}

export class Store {
  private db: DatabaseSync;
  private readonly readonly: boolean;
  private cachedSchemaInfo: SchemaInfo;
  private hasRoleColumns: boolean;
  private hasComplexityColumns: boolean;
  private hasV4Tables: boolean;
  /**
   * True when the v5 `symbols.symbol_role` column exists. Read-only opens
   * against a pre-v5 DB transparently skip declaration/type_ref filtering;
   * writer opens always have it since runMigrations() adds the column.
   */
  private hasSymbolRoleColumn: boolean;
  /**
   * True when the v6 module tables (modules / module_members / module_edges)
   * exist. Read-only opens against a pre-v6 DB skip module queries gracefully
   * (they return empty arrays); writer opens always have it.
   */
  private hasModuleTables: boolean;
  /**
   * True when the v7 provenance/shape_hash columns + scip_imports table exist.
   * Read-only opens against a pre-v7 DB return empty arrays for SCIP / dup
   * queries and skip the provenance column on selects.
   */
  private hasV7Columns: boolean;
  /**
   * True when v10 external_bundles / boundaries / symbol_history_continuity
   * tables exist. Read-only opens against a pre-v10 DB return empty arrays.
   */
  private hasV10Tables: boolean;

  // Prepared statements — initialized in constructor (writer path only)
  private stmtUpsertFile!: StatementSync;
  private stmtInsertSymbol!: StatementSync;
  private stmtInsertEdge!: StatementSync;
  private stmtInsertFileImport!: StatementSync;
  private stmtInsertRoute!: StatementSync;
  private stmtInsertConfigKey!: StatementSync;
  private stmtInsertExternalDep!: StatementSync;
  private stmtInsertServiceCall!: StatementSync;
  private stmtInsertServiceLink!: StatementSync;
  private stmtInsertSymbolsFts!: StatementSync;
  private stmtInsertFilesFts!: StatementSync;
  private stmtDeleteSymbolsFtsForFile!: StatementSync;
  private stmtDeleteFilesFtsForFile!: StatementSync;
  private stmtInsertSymbolHistory!: StatementSync;

  constructor(dbPath: string, options: StoreOptions = {}) {
    this.readonly = Boolean(options.readonly);
    const busyMs = options.busyTimeoutMs ?? 5000;

    if (this.readonly) {
      this.db = new DatabaseSync(dbPath, { readOnly: true });
      try { this.db.exec(`PRAGMA busy_timeout = ${busyMs}; PRAGMA query_only = ON;`); }
      catch { /* best effort */ }
    } else {
      this.db = new DatabaseSync(dbPath);
      this.db.exec(SCHEMA_SQL);
      try { this.db.exec(`PRAGMA busy_timeout = ${busyMs};`); }
      catch { /* best effort */ }
      // WAL gives us concurrent readers alongside the single writer (so a CLI
      // `seer symbols` against a DB the MCP server holds open no longer blocks),
      // and replaces the per-commit rollback-journal fsync with a much cheaper
      // append. On Windows in particular the rollback journal + antivirus file
      // scanning made every batched commit expensive; WAL removes that cost.
      // `synchronous=NORMAL` is the WAL-recommended setting: durable across
      // application crashes, only at risk on OS/power loss, which for a
      // rebuildable code index is an acceptable trade for the speed.
      try { this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;'); }
      catch { /* best effort — falls back to the default rollback journal */ }
      this.runMigrations();
      this.prepare();
    }
    this.cachedSchemaInfo = this.readSchemaInfo();
    this.hasRoleColumns = this.checkHasRoleColumns();
    this.hasComplexityColumns = this.hasColumn('symbols', 'cyclomatic');
    this.hasV4Tables = this.checkHasV4Tables();
    this.hasSymbolRoleColumn = this.hasColumn('symbols', 'symbol_role');
    this.hasModuleTables = this.checkHasModuleTables();
    this.hasV7Columns = this.hasColumn('symbols', 'provenance') && this.hasColumn('symbols', 'shape_hash');
    this.hasV10Tables = this.checkHasV10Tables();
  }

  private checkHasV10Tables(): boolean {
    try {
      const rows = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('external_bundles','boundaries','boundary_members','boundary_edges','symbol_history_continuity')"
      ).all() as Row[];
      return rows.length === 5;
    } catch {
      return false;
    }
  }

  private checkHasModuleTables(): boolean {
    try {
      const rows = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('modules','module_members','module_edges')"
      ).all() as Row[];
      return rows.length === 3;
    } catch {
      return false;
    }
  }

  private checkHasRoleColumns(): boolean {
    try {
      const cols = this.db.prepare('PRAGMA table_info(files)').all() as Row[];
      const names = new Set(cols.map(c => toStr(c.name)));
      return names.has('role') && names.has('is_vendor') && names.has('is_generated');
    } catch {
      return false;
    }
  }

  private checkHasV4Tables(): boolean {
    try {
      const rows = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('routes','external_dependencies','config_keys','file_churn','symbol_history','git_index_state')"
      ).all() as Row[];
      return rows.length === 6;
    } catch {
      return false;
    }
  }

  static openReadOnly(dbPath: string, busyTimeoutMs?: number): Store {
    return new Store(dbPath, { readonly: true, busyTimeoutMs });
  }

  isReadOnly(): boolean { return this.readonly; }

  private assertWritable(): void {
    if (this.readonly) {
      throw new Error('Store is read-only; open a writable Store to mutate the index');
    }
  }

  schemaInfo(): SchemaInfo { return this.cachedSchemaInfo; }

  /**
   * v8 Track-G migration guard. When an existing v7 DB is opened by v8 code,
   * service_calls/service_links tables are created empty. A normal cached
   * re-index would skip every unchanged file, so service_calls would remain
   * empty forever. Until an index run marks this backfill version complete,
   * the indexer must force one full parse pass.
   */
  needsServiceCallBackfill(): boolean {
    try {
      const row = this.db.prepare(
        "SELECT value FROM _schema_meta WHERE key = 'service_calls_backfilled'",
      ).get() as Row | undefined;
      if (row && toStr(row.value) === SERVICE_CALLS_BACKFILL_VERSION) return false;
      const files = this.db.prepare('SELECT COUNT(*) AS c FROM files').get() as Row;
      return toNum(files.c) > 0;
    } catch {
      return false;
    }
  }

  markServiceCallsBackfilled(): void {
    this.assertWritable();
    this.db.prepare(
      "INSERT INTO _schema_meta (key, value) VALUES ('service_calls_backfilled', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(SERVICE_CALLS_BACKFILL_VERSION);
  }

  getIndexMeta(key: string): string | null {
    try {
      const row = this.db.prepare(
        'SELECT value FROM _schema_meta WHERE key = ?',
      ).get(key) as Row | undefined;
      return row ? toStr(row.value) : null;
    } catch {
      return null;
    }
  }

  setIndexMeta(key: string, value: string): void {
    this.assertWritable();
    this.db.prepare(
      'INSERT INTO _schema_meta (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  }

  private readSchemaInfo(): SchemaInfo {
    let dbVersion = 0;
    try {
      const row = this.db.prepare(
        "SELECT value FROM _schema_meta WHERE key = 'schema_version'",
      ).get() as Row | undefined;
      if (row) dbVersion = parseInt(toStr(row.value), 10) || 0;
    } catch { /* */ }
    return {
      dbVersion,
      buildVersion: CURRENT_SCHEMA_VERSION,
      current: dbVersion === CURRENT_SCHEMA_VERSION,
    };
  }

  private runMigrations(): void {
    this.addColumnIfMissing('symbols', 'qualified_name', 'TEXT');
    this.addColumnIfMissing(
      'file_imports',
      'resolved_file_id',
      'INTEGER REFERENCES files(id) ON DELETE SET NULL',
    );
    this.addColumnIfMissing('files', 'role',         "TEXT NOT NULL DEFAULT 'project'");
    this.addColumnIfMissing('files', 'is_vendor',    'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('files', 'is_generated', 'INTEGER NOT NULL DEFAULT 0');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_files_role         ON files(role)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_files_is_vendor    ON files(is_vendor)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_files_is_generated ON files(is_generated)');

    // v3: is_rankable
    const isV3Migration = !this.hasColumn('symbols', 'is_rankable');
    this.addColumnIfMissing('symbols', 'is_rankable', 'INTEGER NOT NULL DEFAULT 1');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_is_rankable ON symbols(is_rankable)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_file_name ON symbols(file_id, name)');
    if (isV3Migration) {
      this.db.prepare(
        `UPDATE symbols SET is_rankable = 0 WHERE kind NOT IN ('function','method','constructor','class')`,
      ).run();
      this.db.prepare('UPDATE symbols SET pagerank = 0 WHERE is_rankable = 0').run();
    }

    // v4: complexity columns, symbol_key, edges.kind index
    const isV4Migration = !this.hasColumn('symbols', 'symbol_key');
    this.addColumnIfMissing('symbols', 'loc',         'INTEGER');
    this.addColumnIfMissing('symbols', 'cyclomatic',  'INTEGER');
    this.addColumnIfMissing('symbols', 'cognitive',   'INTEGER');
    this.addColumnIfMissing('symbols', 'max_nesting', 'INTEGER');
    this.addColumnIfMissing('symbols', 'symbol_key',  'TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_symbol_key ON symbols(symbol_key)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_edges_from_to_kind ON edges(from_id, to_id, kind)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_edges_to_name_kind ON edges(to_name, kind)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_edges_to_id_kind_from ON edges(to_id, kind, from_id)');

    // v4.1: separate history HEAD marker so churn doesn't poison the
    // skip-if-unchanged check used by buildSymbolHistory. Cheap ALTER ADD;
    // existing DBs get NULL which forces history to run on next invocation.
    this.addColumnIfMissing('git_index_state', 'last_history_head_sha', 'TEXT');
    this.addColumnIfMissing('git_index_state', 'last_history_at',       'INTEGER');
    // v11+: persist the --follow choice used for the last full build so
    // incremental refreshes can replicate it without scanning watermarks.
    // NULL = unknown (old DB) → treated as false (the B2 default).
    this.addColumnIfMissing('git_index_state', 'last_history_follow',   'INTEGER');

    // v5: symbol_role on symbols. The NOT NULL DEFAULT 'definition' on the
    // ALTER means every pre-v5 row gets a sane default without an explicit
    // UPDATE backfill. The role only changes its meaning when the indexer
    // re-runs against the file (e.g. for C/C++ fixtures where field_declaration
    // is now emitted as 'declaration').
    this.addColumnIfMissing('symbols', 'symbol_role', "TEXT NOT NULL DEFAULT 'definition'");
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_symbol_role ON symbols(symbol_role)');

    // v7: provenance + shape_hash on symbols/edges, plus scip_imports table.
    // ALTER ADD COLUMN paths are cheap and idempotent; the index creation is
    // guarded by hasColumn so a partial migration on an older DB doesn't fail.
    this.addColumnIfMissing('symbols', 'provenance', "TEXT NOT NULL DEFAULT 'tree-sitter'");
    this.addColumnIfMissing('symbols', 'shape_hash', 'INTEGER');
    this.addColumnIfMissing('edges',   'provenance', "TEXT NOT NULL DEFAULT 'tree-sitter'");
    // v7.1 — scip_import_id links a SCIP-provenance row back to the
    // scip_imports table entry that produced it, so re-importing or clearing
    // ONE SCIP layer doesn't nuke rows contributed by sibling layers (the
    // original v7 wipe was global, which collapsed multi-layer setups).
    this.addColumnIfMissing('symbols', 'scip_import_id', 'INTEGER');
    this.addColumnIfMissing('edges',   'scip_import_id', 'INTEGER');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_provenance ON symbols(provenance)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_shape_hash ON symbols(shape_hash) WHERE shape_hash IS NOT NULL');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_edges_provenance  ON edges(provenance)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_scip_import ON symbols(scip_import_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_edges_scip_import  ON edges(scip_import_id)');
    this.db.exec(`
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
    this.db.exec(`
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
    this.db.exec(`
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
    this.addColumnIfMissing('service_calls', 'operation',     'TEXT');
    this.addColumnIfMissing('service_calls', 'topic',         'TEXT');
    this.addColumnIfMissing('service_calls', 'queue',         'TEXT');
    this.addColumnIfMissing('service_calls', 'exchange',      'TEXT');
    this.addColumnIfMissing('service_calls', 'service',       'TEXT');
    this.addColumnIfMissing('service_calls', 'broker',        'TEXT');
    this.addColumnIfMissing('service_calls', 'metadata_json', 'TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_service_calls_operation ON service_calls(operation) WHERE operation IS NOT NULL');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_service_calls_topic     ON service_calls(topic)     WHERE topic IS NOT NULL');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_service_calls_queue     ON service_calls(queue)     WHERE queue IS NOT NULL');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_service_calls_service   ON service_calls(service)   WHERE service IS NOT NULL');

    this.addColumnIfMissing('routes', 'protocol',      "TEXT NOT NULL DEFAULT 'http'");
    this.addColumnIfMissing('routes', 'operation',     'TEXT');
    this.addColumnIfMissing('routes', 'topic',         'TEXT');
    this.addColumnIfMissing('routes', 'queue',         'TEXT');
    this.addColumnIfMissing('routes', 'exchange',      'TEXT');
    this.addColumnIfMissing('routes', 'service',       'TEXT');
    this.addColumnIfMissing('routes', 'broker',        'TEXT');
    this.addColumnIfMissing('routes', 'metadata_json', 'TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_routes_protocol  ON routes(protocol)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_routes_operation ON routes(operation) WHERE operation IS NOT NULL');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_routes_topic     ON routes(topic)     WHERE topic IS NOT NULL');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_routes_queue     ON routes(queue)     WHERE queue IS NOT NULL');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_routes_service   ON routes(service)   WHERE service IS NOT NULL');

    // v10 — external bundle layers + monorepo boundaries + history continuity.
    // CREATE IF NOT EXISTS + ALTER ADD COLUMN keep older DBs upgradable
    // without data rewrites. The default values are chosen so HTTP/local
    // behavior is unchanged on rows that don't set the new fields.
    this.db.exec(`
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
    this.addColumnIfMissing('routes',         'external_bundle_id', 'INTEGER');
    this.addColumnIfMissing('service_calls',  'external_bundle_id', 'INTEGER');
    this.addColumnIfMissing('service_links',  'external_bundle_id', 'INTEGER');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_routes_external_bundle ON routes(external_bundle_id) WHERE external_bundle_id IS NOT NULL');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_service_calls_external_bundle ON service_calls(external_bundle_id) WHERE external_bundle_id IS NOT NULL');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_service_links_external_bundle ON service_links(external_bundle_id) WHERE external_bundle_id IS NOT NULL');

    // v11: per-file resume watermark for the symbol-history build. CREATE TABLE
    // IF NOT EXISTS is the migration; absence on an older DB just means the next
    // build starts with no resume info (it writes watermarks as it goes).
    this.db.exec(`
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
      this.backfillSymbolKeysFromExistingRows();
    }
    // FTS rebuild: detect "v4 columns exist but FTS tables are empty while
    // symbols/files have rows". Triggers on the v3→v4 upgrade AND on the rare
    // case where a v4 DB lost its FTS rows (e.g. a manual schema patch). The
    // check is constant-time (COUNT on empty FTS is instant).
    this.rebuildFtsIfStale();

    this.db.prepare(
      "INSERT INTO _schema_meta (key, value) VALUES ('schema_version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(CURRENT_SCHEMA_VERSION));
  }

  /**
   * Populate symbols.symbol_key for every existing row. Mirrors
   * makeSymbolKey() — `kind:qualified_name` (or `kind:name` if qualified is
   * NULL). symbol_history is keyed on these so without the backfill,
   * listSymbolsForHistoryIndex() returns zero candidates after a v3→v4
   * upgrade.
   */
  private backfillSymbolKeysFromExistingRows(): void {
    try {
      this.db.exec(`
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
  private rebuildFtsIfStale(): void {
    try {
      const sym = this.db.prepare('SELECT COUNT(*) AS c FROM symbols').get() as Row;
      const symFts = this.db.prepare('SELECT COUNT(*) AS c FROM symbols_fts').get() as Row;
      if (toNum(sym.c) > 0 && toNum(symFts.c) === 0) {
        const ins = this.db.prepare(
          'INSERT INTO symbols_fts(rowid, name, qualified_name, signature, split) VALUES (?, ?, ?, ?, ?)',
        );
        const rows = this.db.prepare(
          'SELECT id, name, qualified_name, signature FROM symbols',
        ).all() as Row[];
        this.db.exec('BEGIN');
        try {
          for (const r of rows) {
            const name = toStr(r.name);
            const qual = toStr(r.qualified_name ?? r.name);
            ins.run(
              toNum(r.id), name, qual, toStr(r.signature ?? ''),
              splitIdentifierTokens(`${name} ${qual}`),
            );
          }
          this.db.exec('COMMIT');
        } catch (err) { this.db.exec('ROLLBACK'); throw err; }
      }
    } catch { /* FTS5 unavailable; non-fatal */ }
    try {
      const file = this.db.prepare('SELECT COUNT(*) AS c FROM files').get() as Row;
      const fileFts = this.db.prepare('SELECT COUNT(*) AS c FROM files_fts').get() as Row;
      if (toNum(file.c) > 0 && toNum(fileFts.c) === 0) {
        const ins = this.db.prepare('INSERT INTO files_fts(rowid, rel_path) VALUES (?, ?)');
        const rows = this.db.prepare('SELECT id, rel_path FROM files').all() as Row[];
        this.db.exec('BEGIN');
        try {
          for (const r of rows) {
            ins.run(toNum(r.id), splitIdentifierTokens(toStr(r.rel_path)));
          }
          this.db.exec('COMMIT');
        } catch (err) { this.db.exec('ROLLBACK'); throw err; }
      }
    } catch { /* FTS5 unavailable; non-fatal */ }
  }

  private hasColumn(table: string, column: string): boolean {
    try {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
      return cols.some(c => toStr(c.name) === column);
    } catch {
      return false;
    }
  }

  private addColumnIfMissing(table: string, column: string, def: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (cols.some(c => toStr(c.name) === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }

  private prepare(): void {
    this.stmtUpsertFile = this.db.prepare(`
      INSERT INTO files (path, rel_path, language, hash, lines, indexed_at, role, is_vendor, is_generated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        rel_path     = excluded.rel_path,
        language     = excluded.language,
        hash         = excluded.hash,
        lines        = excluded.lines,
        indexed_at   = excluded.indexed_at,
        role         = excluded.role,
        is_vendor    = excluded.is_vendor,
        is_generated = excluded.is_generated
    `);

    this.stmtInsertSymbol = this.db.prepare(`
      INSERT INTO symbols
        (name, qualified_name, kind, file_id, line_start, line_end, col_start, col_end,
         signature, is_rankable, loc, cyclomatic, cognitive, max_nesting, symbol_key, symbol_role)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtInsertEdge = this.db.prepare(`
      INSERT INTO edges (from_id, to_name, kind, line) VALUES (?, ?, ?, ?)
    `);

    this.stmtInsertFileImport = this.db.prepare(`
      INSERT OR IGNORE INTO file_imports (from_file_id, import_name) VALUES (?, ?)
    `);

    this.stmtInsertRoute = this.db.prepare(`
      INSERT INTO routes
        (file_id, method, path, framework, handler_name, line,
         protocol, operation, topic, queue, exchange, service, broker, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtInsertConfigKey = this.db.prepare(`
      INSERT INTO config_keys (key, source, file_id, symbol_id, line)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.stmtInsertExternalDep = this.db.prepare(`
      INSERT OR REPLACE INTO external_dependencies
        (ecosystem, name, version_range, manifest_path, is_dev)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.stmtInsertServiceCall = this.db.prepare(`
      INSERT INTO service_calls
        (file_id, symbol_id, protocol, method, raw_target, normalized_path,
         host_hint, env_key, framework, line, confidence,
         operation, topic, queue, exchange, service, broker, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtInsertServiceLink = this.db.prepare(`
      INSERT INTO service_links
        (call_id, route_id, caller_symbol_id, handler_symbol_id,
         protocol, match_kind, confidence, evidence_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtInsertSymbolsFts = this.db.prepare(
      'INSERT INTO symbols_fts(rowid, name, qualified_name, signature, split) VALUES (?, ?, ?, ?, ?)',
    );
    this.stmtInsertFilesFts = this.db.prepare(
      'INSERT INTO files_fts(rowid, rel_path) VALUES (?, ?)',
    );
    this.stmtDeleteSymbolsFtsForFile = this.db.prepare(
      'DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_id = ?)',
    );
    this.stmtDeleteFilesFtsForFile = this.db.prepare(
      'DELETE FROM files_fts WHERE rowid = ?',
    );

    this.stmtInsertSymbolHistory = this.db.prepare(`
      INSERT OR IGNORE INTO symbol_history
        (symbol_id, symbol_key, commit_sha, author_name, author_email, committed_at, message,
         lines_added, lines_removed, pr_number, pr_url, match_strategy, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  // ── Write operations ────────────────────────────────────────────────────────

  pruneFilesNotIn(keepIds: Set<number>): number {
    this.assertWritable();
    // v10 — external bundle phantom files use path 'external' as language so
    // they're never pruned by accident on a cached re-index. The pruner adds
    // them to keepIds before the delete pass so importing an external bundle,
    // then running a regular `seer index`, leaves the external layer intact.
    const externalIds = this.listExternalPhantomFileIds();
    if (keepIds.size === 0 && externalIds.length === 0) {
      const res = this.db.prepare('DELETE FROM files').run();
      // FTS is contentless — wipe in parallel.
      try { this.db.exec('DELETE FROM symbols_fts'); this.db.exec('DELETE FROM files_fts'); } catch { /* */ }
      return toNum(res.changes);
    }
    this.db.exec('BEGIN');
    try {
      this.db.exec('CREATE TEMP TABLE IF NOT EXISTS _keep (id INTEGER PRIMARY KEY)');
      this.db.exec('DELETE FROM _keep');
      const insert = this.db.prepare('INSERT INTO _keep (id) VALUES (?)');
      for (const id of keepIds) insert.run(id);
      for (const id of externalIds) {
        try { insert.run(id); } catch { /* duplicate keep id; ignore */ }
      }
      // Wipe FTS rows for files we're about to delete (pre-delete, before
      // their ids become unrecoverable).
      try {
        this.db.exec(`
          DELETE FROM symbols_fts WHERE rowid IN (
            SELECT s.id FROM symbols s
            JOIN files f ON f.id = s.file_id
            WHERE f.id NOT IN (SELECT id FROM _keep)
          )
        `);
        this.db.exec(`
          DELETE FROM files_fts WHERE rowid IN (
            SELECT id FROM files WHERE id NOT IN (SELECT id FROM _keep)
          )
        `);
      } catch { /* */ }
      const res = this.db.prepare(
        'DELETE FROM files WHERE id NOT IN (SELECT id FROM _keep)'
      ).run();
      this.db.exec('COMMIT');
      return toNum(res.changes);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  upsertFile(
    path: string,
    relPath: string,
    language: string,
    hash: string,
    lines: number,
    classification: FileClassification = { role: 'project', isVendor: 0, isGenerated: 0 },
  ): number {
    this.assertWritable();
    const existing = this.db.prepare('SELECT id FROM files WHERE path = ?').get(path) as Row | undefined;
    if (existing) {
      const fileId = toNum(existing.id);
      // Wipe FTS rows + dependent table rows for this file
      try { this.stmtDeleteSymbolsFtsForFile.run(fileId); } catch { /* */ }
      this.db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
      this.db.prepare('DELETE FROM file_imports WHERE from_file_id = ?').run(fileId);
      this.db.prepare('DELETE FROM routes WHERE file_id = ?').run(fileId);
      this.db.prepare('DELETE FROM config_keys WHERE file_id = ?').run(fileId);
      this.db.prepare('DELETE FROM service_calls WHERE file_id = ?').run(fileId);
      try { this.stmtDeleteFilesFtsForFile.run(fileId); } catch { /* */ }
    }

    const result = this.stmtUpsertFile.run(
      path, relPath, language, hash, lines, Date.now(),
      classification.role, classification.isVendor, classification.isGenerated,
    );
    const fileId = existing ? toNum(existing.id) : toNum(result.lastInsertRowid);
    try { this.stmtInsertFilesFts.run(fileId, splitIdentifierTokens(relPath)); } catch { /* */ }
    return fileId;
  }

  upsertFileWithCache(
    path: string, relPath: string, language: string, hash: string, lines: number,
    classification: FileClassification = { role: 'project', isVendor: 0, isGenerated: 0 },
  ): { fileId: number; unchanged: boolean } {
    this.assertWritable();
    const existing = this.db
      .prepare('SELECT id, hash, role, is_vendor, is_generated FROM files WHERE path = ?')
      .get(path) as Row | undefined;

    if (existing && toStr(existing.hash) === hash) {
      const fileId = toNum(existing.id);
      const existingRole = toStr(existing.role);
      const existingVendor = toNum(existing.is_vendor);
      const existingGen = toNum(existing.is_generated);
      if (
        existingRole !== classification.role ||
        existingVendor !== classification.isVendor ||
        existingGen !== classification.isGenerated
      ) {
        this.db.prepare(
          'UPDATE files SET indexed_at = ?, role = ?, is_vendor = ?, is_generated = ? WHERE id = ?',
        ).run(
          Date.now(),
          classification.role, classification.isVendor, classification.isGenerated,
          fileId,
        );
      } else {
        this.db.prepare('UPDATE files SET indexed_at = ? WHERE id = ?')
          .run(Date.now(), fileId);
      }
      return { fileId, unchanged: true };
    }

    if (existing) {
      const fileId = toNum(existing.id);
      try { this.stmtDeleteSymbolsFtsForFile.run(fileId); } catch { /* */ }
      this.db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
      this.db.prepare('DELETE FROM file_imports WHERE from_file_id = ?').run(fileId);
      this.db.prepare('DELETE FROM routes WHERE file_id = ?').run(fileId);
      this.db.prepare('DELETE FROM config_keys WHERE file_id = ?').run(fileId);
      this.db.prepare('DELETE FROM service_calls WHERE file_id = ?').run(fileId);
      try { this.stmtDeleteFilesFtsForFile.run(fileId); } catch { /* */ }
    }

    const result = this.stmtUpsertFile.run(
      path, relPath, language, hash, lines, Date.now(),
      classification.role, classification.isVendor, classification.isGenerated,
    );
    const fileId = existing ? toNum(existing.id) : toNum(result.lastInsertRowid);
    try { this.stmtInsertFilesFts.run(fileId, splitIdentifierTokens(relPath)); } catch { /* */ }
    return { fileId, unchanged: false };
  }

  insertSymbol(fileId: number, def: SymbolDef): number {
    this.assertWritable();
    const sig = def.signature ? def.signature.slice(0, 240) : null;
    const qualified = def.qualifiedName ?? def.name;
    const symbolRole: SymbolRole = def.symbolRole ?? 'definition';
    // Declarations are not call targets in the same canonical sense as
    // definitions, so they're excluded from PageRank just like type rows.
    // The kind-based rankability still applies — a class declaration would
    // already be non-rankable from the kind check; this is the belt-and-
    // suspenders guard for the rarer "method declaration" case.
    const rankable = (symbolRole === 'definition' && isRankableKind(def.kind)) ? 1 : 0;
    const symbolKey = makeSymbolKey(def.kind, qualified);
    const result = this.stmtInsertSymbol.run(
      def.name, qualified, def.kind, fileId,
      def.lineStart, def.lineEnd,
      def.colStart, def.colEnd,
      sig,
      rankable,
      def.loc ?? null,
      def.cyclomatic ?? null,
      def.cognitive ?? null,
      def.maxNesting ?? null,
      symbolKey,
      symbolRole,
    );
    const symbolId = toNum(result.lastInsertRowid);
    try {
      this.stmtInsertSymbolsFts.run(
        symbolId,
        def.name,
        qualified,
        sig ?? '',
        splitIdentifierTokens(`${def.name} ${qualified}`),
      );
    } catch { /* FTS5 unavailable; non-fatal */ }
    return symbolId;
  }

  insertEdge(fromSymbolId: number, toName: string, kind: string, line: number): void {
    this.assertWritable();
    this.stmtInsertEdge.run(fromSymbolId, toName, kind, line);
  }

  insertFileImport(fromFileId: number, importName: string): void {
    this.assertWritable();
    this.stmtInsertFileImport.run(fromFileId, importName);
  }

  insertRoute(
    fileId: number, method: string, routePath: string, framework: string,
    handlerName: string | null, line: number,
    options: {
      protocol?: string;
      operation?: string | null;
      topic?: string | null;
      queue?: string | null;
      exchange?: string | null;
      service?: string | null;
      broker?: string | null;
      metadataJson?: string | null;
    } = {},
  ): void {
    this.assertWritable();
    this.stmtInsertRoute.run(
      fileId, method, routePath, framework, handlerName, line,
      options.protocol ?? 'http',
      options.operation ?? null,
      options.topic ?? null,
      options.queue ?? null,
      options.exchange ?? null,
      options.service ?? null,
      options.broker ?? null,
      options.metadataJson ?? null,
    );
  }

  insertConfigKey(
    key: string, source: string, fileId: number,
    symbolId: number | null, line: number,
  ): void {
    this.assertWritable();
    this.stmtInsertConfigKey.run(key, source, fileId, symbolId, line);
  }

  /**
   * v8 Track G — return a closure that inserts service_link rows. Used by
   * the resolver in `resolveServiceLinks(store)` so it can stream inserts
   * inside one prepared statement rather than re-resolving the statement
   * per row.
   */
  makeServiceLinkInserter(): (args: {
    callId: number;
    routeId: number | null;
    callerSymbolId: number | null;
    handlerSymbolId: number | null;
    protocol: string;
    matchKind: string;
    confidence: number;
    evidenceJson: string;
  }) => void {
    this.assertWritable();
    const stmt = this.stmtInsertServiceLink;
    return (a) => {
      stmt.run(
        a.callId, a.routeId, a.callerSymbolId, a.handlerSymbolId,
        a.protocol, a.matchKind, a.confidence, a.evidenceJson,
      );
    };
  }

  /**
   * v8 Track G — insert a service-call row (outbound HTTP/etc. client call).
   * The post-index resolver derives service_links from these and from routes.
   * Returns the new row id so callers can attach evidence in the same batch.
   */
  insertServiceCall(args: {
    fileId: number;
    symbolId: number | null;
    protocol: string;
    method: string | null;
    rawTarget: string;
    normalizedPath: string | null;
    hostHint: string | null;
    envKey: string | null;
    framework: string;
    line: number;
    confidence: number;
    // v9 Track-H protocol expansion. All optional; protocol-specific extractors
    // fill the fields that apply to their protocol and leave the rest NULL.
    operation?: string | null;
    topic?: string | null;
    queue?: string | null;
    exchange?: string | null;
    service?: string | null;
    broker?: string | null;
    metadataJson?: string | null;
  }): number {
    this.assertWritable();
    const r = this.stmtInsertServiceCall.run(
      args.fileId,
      args.symbolId,
      args.protocol,
      args.method,
      args.rawTarget.slice(0, 240),
      args.normalizedPath,
      args.hostHint,
      args.envKey,
      args.framework,
      args.line,
      args.confidence,
      args.operation ?? null,
      args.topic ?? null,
      args.queue ?? null,
      args.exchange ?? null,
      args.service ?? null,
      args.broker ?? null,
      args.metadataJson ?? null,
    );
    return toNum(r.lastInsertRowid);
  }

  insertExternalDep(
    ecosystem: string, name: string, versionRange: string | null,
    manifestPath: string, isDev: 0 | 1,
  ): void {
    this.assertWritable();
    this.stmtInsertExternalDep.run(ecosystem, name, versionRange, manifestPath, isDev);
  }

  clearExternalDeps(): void {
    this.assertWritable();
    this.db.exec('DELETE FROM external_dependencies');
  }

  // ── Import resolution ───────────────────────────────────────────────────────

  resolveImports(): number {
    const files = this.db.prepare('SELECT id, path, language FROM files').all() as Row[];
    if (files.length === 0) return 0;

    const fileByPath = new Map<string, number>();
    for (const f of files) {
      fileByPath.set(normalizePath(toStr(f.path)), toNum(f.id));
    }

    const imports = this.db.prepare(`
      SELECT fi.id, fi.from_file_id, fi.import_name, f.path AS from_path, f.language
      FROM file_imports fi
      JOIN files f ON f.id = fi.from_file_id
      WHERE fi.resolved_file_id IS NULL
    `).all() as Row[];

    const updateStmt = this.db.prepare(
      'UPDATE file_imports SET resolved_file_id = ? WHERE id = ?',
    );

    let resolved = 0;
    this.db.exec('BEGIN');
    try {
      for (const imp of imports) {
        const fromPath = toStr(imp.from_path);
        const language = toStr(imp.language);
        const importName = toStr(imp.import_name);
        const targetId = resolveImportToFileId(fromPath, language, importName, fileByPath);
        if (targetId !== null) {
          updateStmt.run(targetId, toNum(imp.id));
          resolved++;
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return resolved;
  }

  // ── Edge resolution (scope-aware) ───────────────────────────────────────────

  resolveEdges(): EdgeResolutionStats {
    const countUnresolved = (): number =>
      toNum((this.db.prepare(
        'SELECT COUNT(*) AS c FROM edges WHERE to_id IS NULL'
      ).get() as Row).c);

    const before0 = countUnresolved();

    this.db.prepare(`
      UPDATE edges
      SET to_id = (
        SELECT t.id
        FROM symbols t, symbols s
        WHERE s.id = edges.from_id
          AND t.name = edges.to_name
          AND t.file_id = s.file_id
        LIMIT 1
      )
      WHERE to_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM symbols t, symbols s
          WHERE s.id = edges.from_id
            AND t.name = edges.to_name
            AND t.file_id = s.file_id
        );
    `).run();

    const after1 = countUnresolved();
    const sameFile = before0 - after1;

    this.db.prepare(`
      UPDATE edges
      SET to_id = (
        SELECT t.id
        FROM symbols t
        JOIN file_imports fi ON fi.resolved_file_id = t.file_id
        JOIN symbols s ON s.id = edges.from_id
        WHERE fi.from_file_id = s.file_id
          AND t.name = edges.to_name
        LIMIT 1
      )
      WHERE to_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM symbols t
          JOIN file_imports fi ON fi.resolved_file_id = t.file_id
          JOIN symbols s ON s.id = edges.from_id
          WHERE fi.from_file_id = s.file_id
            AND t.name = edges.to_name
        );
    `).run();

    const after2 = countUnresolved();
    const imported = after1 - after2;

    this.db.prepare(`
      UPDATE edges
      SET to_id = (
        SELECT id FROM symbols WHERE name = edges.to_name LIMIT 1
      )
      WHERE to_id IS NULL
        AND EXISTS (SELECT 1 FROM symbols WHERE name = edges.to_name);
    `).run();

    const after3 = countUnresolved();
    const global = after2 - after3;

    return {
      sameFile,
      imported,
      global,
      total: sameFile + imported + global,
    };
  }

  /**
   * After symbol IDs are known, link routes.handler_id by name. Routes that
   * named a handler not defined in the same file stay with handler_id NULL.
   * Matching is by `handler_name = symbols.name` AND `file_id = routes.file_id`
   * — handlers nearly always live in the same file as the route registration.
   */
  resolveRouteHandlers(): number {
    const res = this.db.prepare(`
      UPDATE routes
      SET handler_id = (
        SELECT s.id FROM symbols s
        WHERE s.file_id = routes.file_id
          AND s.name = routes.handler_name
        LIMIT 1
      )
      WHERE handler_id IS NULL
        AND handler_name IS NOT NULL
    `).run();
    return toNum(res.changes);
  }

  /**
   * Backfill config_keys.symbol_id by line span. The extractor doesn't always
   * know the enclosing symbol id (extraction precedes symbol insertion), so we
   * resolve it via "the smallest function/method containing this line."
   */
  resolveConfigKeySymbols(): number {
    const res = this.db.prepare(`
      UPDATE config_keys
      SET symbol_id = (
        SELECT s.id FROM symbols s
        WHERE s.file_id = config_keys.file_id
          AND s.line_start <= config_keys.line
          AND s.line_end   >= config_keys.line
          AND s.kind IN ('function','method','constructor')
        ORDER BY (s.line_end - s.line_start) ASC
        LIMIT 1
      )
      WHERE symbol_id IS NULL
    `).run();
    return toNum(res.changes);
  }

  // ── Test-edge synthesis ─────────────────────────────────────────────────────

  /**
   * Promote calls from a test-file symbol to a non-test target into 'tests'
   * edges (in addition to keeping the original 'call' edge). The original
   * call edge is left in place so caller/callee queries don't double-count;
   * test edges live in their own kind so `seer_behavior` can pull them
   * directly without scanning the full edge table.
   *
   * The synthesized edge copies the SOURCE 'call' edge's `to_id` verbatim —
   * the call-edge resolution pass already did the same-file / imported /
   * global fallback work to pick the correct target. Re-resolving by name
   * via `WHERE name = edges.to_name LIMIT 1` (the old behavior) was buggy
   * when two symbols shared the same short name (`Alpha.run` / `Beta.run`):
   * `LIMIT 1` would attribute every test edge to whichever id sorted first,
   * so `seer_behavior(Beta.run)` returned tests that actually exercised
   * `Alpha.run`. Preserving the source `to_id` matches what the original
   * resolver already chose.
   *
   * Returns the number of new test edges inserted.
   */
  synthesizeTestEdges(): number {
    // Find call edges from a test file to a non-test target whose 'tests'
    // counterpart doesn't yet exist.
    const rows = this.db.prepare(`
      SELECT e.from_id, e.to_id, e.to_name, e.line
      FROM edges e
      JOIN symbols s ON s.id = e.from_id
      JOIN files fs ON fs.id = s.file_id
      JOIN symbols t ON t.id = e.to_id
      JOIN files ft ON ft.id = t.file_id
      WHERE e.kind = 'call'
        AND fs.role = 'test'
        AND ft.role <> 'test'
        AND NOT EXISTS (
          SELECT 1 FROM edges e2
          WHERE e2.from_id = e.from_id
            AND e2.to_id = e.to_id
            AND e2.kind = 'tests'
        )
    `).all() as Row[];

    if (rows.length === 0) return 0;
    // Insert with to_id set explicitly from the source edge — no LIMIT 1
    // name re-resolution that would collapse same-short-name symbols.
    const insert = this.db.prepare(
      "INSERT INTO edges (from_id, to_name, to_id, kind, line) VALUES (?, ?, ?, 'tests', ?)",
    );
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        insert.run(toNum(r.from_id), toStr(r.to_name), toNum(r.to_id), toNum(r.line));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return rows.length;
  }

  // ── Read operations ─────────────────────────────────────────────────────────

  findCallers(symbolName: string, limit?: number): CallerRow[] {
    const hasLimit = typeof limit === 'number' && limit > 0;
    // Match any spelling variant of the callee name (`Node::add_child` →
    // `Node.add_child`). A `::`-free name produces one variant so `IN (?)`
    // behaves exactly like the previous `= ?`.
    const variants = symbolNameVariants(symbolName);
    const inPh = variants.map(() => '?').join(', ');
    const sql = hasLimit
      ? `
        SELECT
          s.name           AS callerName,
          s.qualified_name AS callerQualifiedName,
          s.kind           AS callerKind,
          f.path           AS callerFile,
          e.line           AS callerLine,
          e.kind           AS edgeKind
        FROM edges e
        JOIN symbols s ON s.id = e.from_id
        JOIN files   f ON f.id = s.file_id
        WHERE e.to_name IN (${inPh}) AND e.kind = 'call'
        LIMIT ?
      `
      : `
        SELECT
          s.name           AS callerName,
          s.qualified_name AS callerQualifiedName,
          s.kind           AS callerKind,
          f.path           AS callerFile,
          e.line           AS callerLine,
          e.kind           AS edgeKind
        FROM edges e
        JOIN symbols s ON s.id = e.from_id
        JOIN files   f ON f.id = s.file_id
        WHERE e.to_name IN (${inPh}) AND e.kind = 'call'
        ORDER BY f.path, e.line
      `;
    const stmt = this.db.prepare(sql);
    const rows = (hasLimit
      ? stmt.all(...variants, limit)
      : stmt.all(...variants)) as Row[];

    const out = rows.map(r => ({
      callerName: toStr(r.callerName),
      callerQualifiedName: toNullStr(r.callerQualifiedName),
      callerKind: toStr(r.callerKind),
      callerFile: toStr(r.callerFile),
      callerLine: toNum(r.callerLine),
      edgeKind: toStr(r.edgeKind),
    }));

    if (hasLimit) {
      out.sort((a, b) =>
        a.callerFile < b.callerFile ? -1 :
        a.callerFile > b.callerFile ? 1 :
        a.callerLine - b.callerLine,
      );
    }
    return out;
  }

  countCallers(symbolName: string): number {
    const variants = symbolNameVariants(symbolName);
    const inPh = variants.map(() => '?').join(', ');
    const row = this.db.prepare(
      `SELECT COUNT(*) AS c FROM edges WHERE to_name IN (${inPh}) AND kind = 'call'`,
    ).get(...variants) as Row;
    return toNum(row.c);
  }

  /**
   * Callers of a specific symbol id — never collapses short-name siblings.
   * Track E + any tool that already has a resolved symbol id should use
   * this instead of `findCallers(name)`. Edges whose `to_id` is NULL
   * (unresolved) are intentionally skipped: with no resolved id we can't
   * tell whether they target THIS specific symbol vs. a same-short-name
   * sibling, and Track E callers want id-specificity.
   */
  findCallersById(symbolId: number, limit?: number): CallerRow[] {
    const hasLimit = typeof limit === 'number' && limit > 0;
    const sql = hasLimit
      ? `
        SELECT
          s.name           AS callerName,
          s.qualified_name AS callerQualifiedName,
          s.kind           AS callerKind,
          f.path           AS callerFile,
          e.line           AS callerLine,
          e.kind           AS edgeKind
        FROM edges e
        JOIN symbols s ON s.id = e.from_id
        JOIN files   f ON f.id = s.file_id
        WHERE e.to_id = ? AND e.kind = 'call'
        LIMIT ?
      `
      : `
        SELECT
          s.name           AS callerName,
          s.qualified_name AS callerQualifiedName,
          s.kind           AS callerKind,
          f.path           AS callerFile,
          e.line           AS callerLine,
          e.kind           AS edgeKind
        FROM edges e
        JOIN symbols s ON s.id = e.from_id
        JOIN files   f ON f.id = s.file_id
        WHERE e.to_id = ? AND e.kind = 'call'
        ORDER BY f.path, e.line
      `;
    const stmt = this.db.prepare(sql);
    const rows = (hasLimit ? stmt.all(symbolId, limit) : stmt.all(symbolId)) as Row[];
    const out = rows.map(r => ({
      callerName: toStr(r.callerName),
      callerQualifiedName: toNullStr(r.callerQualifiedName),
      callerKind: toStr(r.callerKind),
      callerFile: toStr(r.callerFile),
      callerLine: toNum(r.callerLine),
      edgeKind: toStr(r.edgeKind),
    }));
    if (hasLimit) {
      out.sort((a, b) =>
        a.callerFile < b.callerFile ? -1 :
        a.callerFile > b.callerFile ? 1 :
        a.callerLine - b.callerLine,
      );
    }
    return out;
  }

  /** Count of callers for a specific symbol id (id-scoped). Counts CALL SITES
   * (one per edge), so two calls from the same function count as two. */
  countCallersById(symbolId: number): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS c FROM edges WHERE to_id = ? AND kind = 'call'",
    ).get(symbolId) as Row;
    return toNum(row.c);
  }

  /** Count of DISTINCT caller functions for a symbol id — the number of unique
   * `from_id`s, not call sites. `countCallersById` counts edges (sites); a
   * function that calls the target twice contributes 1 here and 2 there. Surfaced
   * so agents don't read "6 callers" (sites) as "6 functions" (the count Codex
   * flagged as ambiguous against blastRadius.directCallers). */
  countUniqueCallersById(symbolId: number): number {
    const row = this.db.prepare(
      "SELECT COUNT(DISTINCT from_id) AS c FROM edges WHERE to_id = ? AND kind = 'call'",
    ).get(symbolId) as Row;
    return toNum(row.c);
  }

  /** How many definitions share a given SHORT name (e.g. `add_child`), excluding
   * declarations/type-refs. >1 means the name is ambiguous: a call edge carrying
   * only the short name (typical of C/C++ `obj->add_child()` member calls, whose
   * receiver type tree-sitter can't infer) cannot be statically attributed to one
   * specific definition. Used to flag honest blast-radius bounds. */
  countDefinitionsByShortName(shortName: string): number {
    if (!shortName) return 0;
    const row = this.db.prepare(`
      SELECT COUNT(*) AS c FROM symbols
      WHERE name = ?
        AND kind IN ('function','method','constructor','class')
        AND (symbol_role IS NULL OR symbol_role = 'definition')
    `).get(shortName) as Row;
    return toNum(row.c);
  }

  /**
   * Per-file call-site counts for a callee SHORT name, accurate over EVERY call
   * site (not a sample). Powers `seer_callers` groupByFile: when a hub method
   * like `add_child` has thousands of type-unresolved by-name call sites, an
   * agent can see WHERE they concentrate (e.g. editor/* plugins) and narrow the
   * refactor scope without paging through raw rows.
   */
  groupCallersByFile(symbolName: string, limit = 100): Array<{ file: string; relPath: string; count: number }> {
    const variants = symbolNameVariants(symbolName);
    const inPh = variants.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT f.path AS file, f.rel_path AS relPath, COUNT(*) AS c
      FROM edges e
      JOIN symbols s ON s.id = e.from_id
      JOIN files   f ON f.id = s.file_id
      WHERE e.to_name IN (${inPh}) AND e.kind = 'call'
      GROUP BY f.id
      ORDER BY c DESC, f.rel_path
      LIMIT ?
    `).all(...variants, limit) as Row[];
    return rows.map(r => ({ file: toStr(r.file), relPath: toStr(r.relPath), count: toNum(r.c) }));
  }

  /** Distinct (simple) class names that define a given short method name, taken
   *  from the dotted qualified_name (`Node.add_child` → `Node`,
   *  `FabrikInverseKinematic.ChainItem.add_child` → `ChainItem`). Lets
   *  `seer_callers` tell a target class apart from same-named siblings when
   *  attributing type-unresolved call sites by receiver. */
  definitionClassesByShortName(shortName: string): string[] {
    if (!shortName) return [];
    const rows = this.db.prepare(`
      SELECT DISTINCT qualified_name AS q FROM symbols
      WHERE name = ?
        AND kind IN ('function','method','constructor','class')
        AND (symbol_role IS NULL OR symbol_role = 'definition')
        AND qualified_name IS NOT NULL
    `).all(shortName) as Row[];
    const classes = new Set<string>();
    for (const r of rows) {
      const q = toStr(r.q);
      const idx = q.lastIndexOf('.');
      if (idx > 0) {
        const cls = q.slice(0, idx);
        classes.add(cls.split('.').pop() || cls);
      }
    }
    return Array.from(classes);
  }

  /** Count of DISTINCT files containing a by-name call site (the denominator for
   *  groupByFile's "top N of M files"). */
  countCallerFilesByName(symbolName: string): number {
    const variants = symbolNameVariants(symbolName);
    const inPh = variants.map(() => '?').join(', ');
    const row = this.db.prepare(`
      SELECT COUNT(DISTINCT s.file_id) AS c
      FROM edges e JOIN symbols s ON s.id = e.from_id
      WHERE e.to_name IN (${inPh}) AND e.kind = 'call'
    `).get(...variants) as Row;
    return toNum(row.c);
  }

  /**
   * By-name call sites of a method that land in TEST files, with the distinct
   * test-file count. Honest "tests mention this name" signal for the
   * heuristic-only coverage case (C/C++ member calls whose receiver type is
   * unresolved): these are REFERENCES, not proof of coverage. Lets an agent skip
   * a manual `rg tests/` to size the surface. Returns zeros when the DB predates
   * file-role classification.
   */
  countNameCallsInTests(symbolName: string): { callSites: number; files: number } {
    const variants = symbolNameVariants(symbolName);
    const inPh = variants.map(() => '?').join(', ');
    try {
      const row = this.db.prepare(`
        SELECT COUNT(*) AS sites, COUNT(DISTINCT s.file_id) AS files
        FROM edges e
        JOIN symbols s ON s.id = e.from_id
        JOIN files   f ON f.id = s.file_id
        WHERE e.to_name IN (${inPh}) AND e.kind = 'call' AND f.role = 'test'
      `).get(...variants) as Row;
      return { callSites: toNum(row.sites), files: toNum(row.files) };
    } catch {
      return { callSites: 0, files: 0 };
    }
  }

  /**
   * Callees emitted by a specific caller symbol id — never collapses
   * short-name siblings the way `findCallees(name)` does. Returns one row
   * per call edge.
   */
  findCalleesById(symbolId: number): CalleeRow[] {
    const rows = this.db.prepare(`
      SELECT
        e.to_name        AS calleeName,
        s2.kind          AS calleeKind,
        f2.path          AS calleeFile,
        s2.line_start    AS calleeLineStart,
        e.kind           AS edgeKind
      FROM edges e
      LEFT JOIN symbols s2 ON s2.id = e.to_id
      LEFT JOIN files   f2 ON f2.id = s2.file_id
      WHERE e.from_id = ? AND e.kind = 'call'
      ORDER BY e.line
    `).all(symbolId) as Row[];
    return rows.map(r => ({
      calleeName: toStr(r.calleeName),
      calleeKind: toNullStr(r.calleeKind),
      calleeFile: toNullStr(r.calleeFile),
      calleeLineStart: toNullNum(r.calleeLineStart),
      edgeKind: toStr(r.edgeKind),
    }));
  }

  findCallees(symbolName: string): CalleeRow[] {
    // Name-keyed fallback (the id-keyed `findCalleesById` is preferred when a
    // definition resolves). Also match `qualified_name` so a qualified caller
    // like `Node.add_child` works — the short-name-only predicate silently
    // returned nothing for those. Variants fold `Node::add_child` → the stored
    // `Node.add_child`; a `::`-free short name keeps the prior behavior.
    const variants = symbolNameVariants(symbolName);
    const inPh = variants.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT
        e.to_name        AS calleeName,
        s2.kind          AS calleeKind,
        f2.path          AS calleeFile,
        s2.line_start    AS calleeLineStart,
        e.kind           AS edgeKind
      FROM edges e
      JOIN symbols s  ON s.id  = e.from_id
      LEFT JOIN symbols s2 ON s2.id = e.to_id
      LEFT JOIN files   f2 ON f2.id = s2.file_id
      WHERE (s.name IN (${inPh}) OR s.qualified_name IN (${inPh})) AND e.kind = 'call'
      ORDER BY e.line
    `).all(...variants, ...variants) as Row[];

    return rows.map(r => ({
      calleeName: toStr(r.calleeName),
      calleeKind: toNullStr(r.calleeKind),
      calleeFile: toNullStr(r.calleeFile),
      calleeLineStart: toNullNum(r.calleeLineStart),
      edgeKind: toStr(r.edgeKind),
    }));
  }

  /**
   * Build the predicate suffix shared by findSymbols / getDefinition /
   * getTopSymbols / countSymbols. Returns the `AND …` string that augments a
   * WHERE clause; never starts the WHERE itself so callers control the rest.
   */
  private filterClauseFromOptions(opts: SymbolSearchOptions): string {
    const f = resolveSearchFlags(opts);
    return buildRoleFilter('f.', f.includeVendor, f.includeGenerated, this.hasRoleColumns, {
      symbolPrefix: 's.',
      includeTests: f.includeTests,
      includeDeclarations: f.includeDeclarations,
      includeTypeRefs: f.includeTypeRefs,
      hasSymbolRoleColumn: this.hasSymbolRoleColumn,
    });
  }

  findSymbols(name: string, options: SymbolSearchOptions = {}): SymbolRow[] {
    const limit = Math.max(1, options.limit ?? 50);
    const filter = this.filterClauseFromOptions(options);
    // OR each spelling variant so a `Node::add_child` query also LIKE-matches
    // the stored `Node.add_child`. A `::`-free name yields one variant, keeping
    // the SQL identical to the previous single-pair form.
    const variants = symbolNameVariants(name);
    const likeClause = variants.map(() => '(s.name LIKE ? OR s.qualified_name LIKE ?)').join(' OR ');
    const likeArgs: string[] = [];
    for (const v of variants) likeArgs.push(`%${v}%`, `%${v}%`);
    const rows = this.db.prepare(`
      SELECT ${symbolSelectCols(this.hasComplexityColumns, this.hasSymbolRoleColumn)}
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE (${likeClause})
        ${filter}
      ORDER BY s.pagerank DESC
      LIMIT ?
    `).all(...likeArgs, limit) as Row[];

    return rows.map(toSymbolRow);
  }

  /**
   * FTS5 search across symbol name / qualified_name / signature / split form.
   * Falls back to `findSymbols` (LIKE) when FTS5 isn't available or returns
   * nothing. Returns BM25-ranked results.
   */
  searchSymbolsFts(query: string, options: SymbolSearchOptions = {}): SymbolRow[] {
    const limit = Math.max(1, options.limit ?? 50);
    if (!this.hasV4Tables) return this.findSymbols(query, options);
    const matchExpr = ftsQuery(query);
    if (!matchExpr) return this.findSymbols(query, options);
    const filter = this.filterClauseFromOptions(options);
    try {
      const rows = this.db.prepare(`
        SELECT ${symbolSelectCols(this.hasComplexityColumns, this.hasSymbolRoleColumn)},
               bm25(symbols_fts) AS rank
        FROM symbols_fts
        JOIN symbols s ON s.id = symbols_fts.rowid
        JOIN files f ON f.id = s.file_id
        WHERE symbols_fts MATCH ?
          ${filter}
        ORDER BY rank, s.pagerank DESC
        LIMIT ?
      `).all(matchExpr, limit) as Row[];
      if (rows.length > 0) return rows.map(toSymbolRow);
    } catch { /* fall through */ }
    return this.findSymbols(query, options);
  }

  /**
   * FTS5 search over file paths. Returns matching files ranked by BM25.
   */
  searchFilesFts(query: string, limit = 30, options: { includeTests?: boolean; includeVendor?: boolean; includeGenerated?: boolean } = {}): Array<{ id: number; path: string; relPath: string; language: string; role: string }> {
    if (!this.hasV4Tables) return [];
    const matchExpr = ftsQuery(query);
    if (!matchExpr) return [];
    const includeTests = options.includeTests ?? false;
    const includeVendor = options.includeVendor ?? false;
    const includeGenerated = options.includeGenerated ?? false;
    try {
      const rows = this.db.prepare(`
        SELECT f.id, f.path, f.rel_path AS relPath, f.language, f.role
        FROM files_fts
        JOIN files f ON f.id = files_fts.rowid
        WHERE files_fts MATCH ?
        ORDER BY bm25(files_fts)
        LIMIT ?
      `).all(matchExpr, limit * 2) as Row[];
      return rows
        .map(r => ({
          id: toNum(r.id),
          path: toStr(r.path),
          relPath: toStr(r.relPath),
          language: toStr(r.language),
          role: toStr(r.role),
        }))
        .filter(f =>
          (includeVendor    || f.role !== 'vendor') &&
          (includeGenerated || f.role !== 'generated') &&
          (includeTests     || f.role !== 'test'),
        )
        .slice(0, limit);
    } catch { return []; }
  }

  listSymbolsInFile(filePath: string, limit = 200): SymbolRow[] {
    const rows = this.db.prepare(`
      SELECT ${symbolSelectCols(this.hasComplexityColumns, this.hasSymbolRoleColumn)}
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE f.path = ? OR f.rel_path = ?
      ORDER BY s.line_start
      LIMIT ?
    `).all(filePath, filePath, limit) as Row[];

    return rows.map(toSymbolRow);
  }

  getTopSymbols(limit = 20, options: SymbolSearchOptions = {}): SymbolRow[] {
    const filter = this.filterClauseFromOptions(options);
    const where = filter ? `WHERE ${filter.replace(/^AND\s+/, '')}` : '';
    const rows = this.db.prepare(`
      SELECT ${symbolSelectCols(this.hasComplexityColumns, this.hasSymbolRoleColumn)}
      FROM symbols s JOIN files f ON f.id = s.file_id
      ${where}
      ORDER BY s.pagerank DESC
      LIMIT ?
    `).all(limit) as Row[];

    return rows.map(toSymbolRow);
  }

  getDefinition(name: string, options: { filePath?: string } & SymbolSearchOptions = {}): SymbolRow[] {
    const filter = this.filterClauseFromOptions(options);
    // File disambiguation accepts an absolute path, the exact rel_path, OR a
    // trailing path fragment on a segment boundary (`weird.c` matches
    // `src/weird.c`; `auth/service.ts` matches `packages/api/auth/service.ts`).
    // Without this an agent had to know the full rel_path or the filter
    // silently returned nothing — a wasted round-trip. Matching stays
    // deterministic: the fragment must align to a `/` boundary (so `auth.ts`
    // never matches `oauth.ts`), and LIKE metacharacters are escaped so a `_`
    // in a filename can't act as a wildcard.
    const fp = options.filePath;
    let fileClause = '';
    let fileArgs: string[] = [];
    if (fp) {
      const norm = fp.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/,'');
      const suffix = '%/' + escapeLike(norm);
      fileClause = 'AND (f.path = ? OR f.rel_path = ? OR f.rel_path LIKE ? ESCAPE \'\\\')';
      fileArgs = [fp, norm, suffix];
    }
    // Match any spelling variant (e.g. `Node::add_child` also matches the stored
    // `Node.add_child`). For a `::`-free name this is a single value, so the
    // `IN (?)` collapses to the previous `= ?` semantics exactly.
    const variants = symbolNameVariants(name);
    const ph = variants.map(() => '?').join(', ');
    const stmt = this.db.prepare(`
      SELECT ${symbolSelectCols(this.hasComplexityColumns, this.hasSymbolRoleColumn)}
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE (s.name IN (${ph}) OR s.qualified_name IN (${ph}))
        ${filter}
        ${fileClause}
      ORDER BY s.pagerank DESC
      LIMIT 50
    `);
    const rows = stmt.all(...variants, ...variants, ...fileArgs) as Row[];

    return rows.map(toSymbolRow);
  }

  getSymbolById(id: number): SymbolRow | null {
    const row = this.db.prepare(`
      SELECT ${symbolSelectCols(this.hasComplexityColumns, this.hasSymbolRoleColumn)}
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.id = ?
    `).get(id) as Row | undefined;
    return row ? toSymbolRow(row) : null;
  }

  countSymbols(name: string, options: SymbolSearchOptions = {}): number {
    const filter = this.filterClauseFromOptions(options);
    // Mirror findSymbols' variant matching so the search-tool total never
    // disagrees with the rows it counts for a `::`-bearing query.
    const variants = symbolNameVariants(name);
    const likeClause = variants.map(() => '(s.name LIKE ? OR s.qualified_name LIKE ?)').join(' OR ');
    const likeArgs: string[] = [];
    for (const v of variants) likeArgs.push(`%${v}%`, `%${v}%`);
    const row = this.db.prepare(`
      SELECT COUNT(*) AS c
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE (${likeClause}) ${filter}
    `).get(...likeArgs) as Row;
    return toNum(row.c);
  }

  listFiles(): Array<{
    id: number; path: string; relPath: string; language: string; hash: string;
    indexedAt: number; role: string; isVendor: number; isGenerated: number;
  }> {
    const rows = this.db.prepare(`
      SELECT id, path, rel_path AS relPath, language, hash, indexed_at AS indexedAt,
             role, is_vendor AS isVendor, is_generated AS isGenerated
      FROM files
    `).all() as Row[];
    return rows.map(r => ({
      id: toNum(r.id),
      path: toStr(r.path),
      relPath: toStr(r.relPath),
      language: toStr(r.language),
      hash: toStr(r.hash),
      indexedAt: toNum(r.indexedAt),
      role: toStr(r.role),
      isVendor: toNum(r.isVendor),
      isGenerated: toNum(r.isGenerated),
    }));
  }

  getRoleCounts(): { project: number; vendor: number; generated: number; test: number } {
    const out = { project: 0, vendor: 0, generated: 0, test: 0 } as Record<string, number>;
    try {
      const rows = this.db.prepare(
        'SELECT role, COUNT(*) AS c FROM files GROUP BY role',
      ).all() as Row[];
      for (const r of rows) {
        const role = toStr(r.role);
        if (role in out) out[role] = toNum(r.c);
      }
    } catch { /* */ }
    return out as { project: number; vendor: number; generated: number; test: number };
  }

  // ── Routes ──────────────────────────────────────────────────────────────────

  listRoutes(options: {
    method?: string;
    pathSubstr?: string;
    framework?: string;
    /** v9 Track-H — filter by protocol ('http' / 'trpc' / 'graphql' / 'grpc' / 'kafka' / ...). */
    protocol?: string;
    operation?: string;
    topic?: string;
    queue?: string;
    service?: string;
    limit?: number;
  } = {}): RouteRow[] {
    if (!this.hasV4Tables) return [];
    const hasProtocol = this.hasColumn('routes', 'protocol');
    const where: string[] = [];
    const args: Array<string | number | null> = [];
    if (options.method)    { where.push('r.method = ?');           args.push(options.method.toUpperCase()); }
    if (options.pathSubstr){ where.push('r.path LIKE ?');          args.push(`%${options.pathSubstr}%`); }
    if (options.framework) { where.push('r.framework = ?');        args.push(options.framework); }
    if (hasProtocol) {
      if (options.protocol)  { where.push('r.protocol = ?');         args.push(options.protocol); }
      if (options.operation) { where.push('r.operation = ?');        args.push(options.operation); }
      if (options.topic)     { where.push('r.topic = ?');            args.push(options.topic); }
      if (options.queue)     { where.push('r.queue = ?');            args.push(options.queue); }
      if (options.service)   { where.push('r.service = ?');          args.push(options.service); }
    }
    const limit = options.limit ?? 200;
    const protocolCols = hasProtocol
      ? ', r.protocol, r.operation, r.topic, r.queue, r.exchange, r.service, r.broker, r.metadata_json AS metadataJson'
      : '';
    const sql = `
      SELECT r.id, r.method, r.path, r.framework, r.handler_name AS handlerName,
             r.handler_id AS handlerId,
             s.qualified_name AS handlerSymbol,
             sf.path AS handlerFile,
             f.path AS filePath, r.line
             ${protocolCols}
      FROM routes r
      JOIN files f ON f.id = r.file_id
      LEFT JOIN symbols s ON s.id = r.handler_id
      LEFT JOIN files sf ON sf.id = s.file_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY r.path, r.method
      LIMIT ?
    `;
    args.push(limit);
    const rows = this.db.prepare(sql).all(...args) as Row[];
    return rows.map(r => ({
      id: toNum(r.id),
      method: toStr(r.method),
      path: toStr(r.path),
      framework: toStr(r.framework),
      handlerName: toNullStr(r.handlerName),
      handlerId: toNullNum(r.handlerId),
      handlerSymbol: toNullStr(r.handlerSymbol),
      handlerFile: toNullStr(r.handlerFile),
      filePath: toStr(r.filePath),
      line: toNum(r.line),
      protocol: hasProtocol ? toNullStr(r.protocol) : null,
      operation: hasProtocol ? toNullStr(r.operation) : null,
      topic: hasProtocol ? toNullStr(r.topic) : null,
      queue: hasProtocol ? toNullStr(r.queue) : null,
      exchange: hasProtocol ? toNullStr(r.exchange) : null,
      service: hasProtocol ? toNullStr(r.service) : null,
      broker: hasProtocol ? toNullStr(r.broker) : null,
      metadataJson: hasProtocol ? toNullStr(r.metadataJson) : null,
    }));
  }

  countRoutes(): number {
    if (!this.hasV4Tables) return 0;
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM routes').get() as Row;
    return toNum(row.c);
  }

  // ── v8 Track-G service calls + links ────────────────────────────────────

  /** Total count of service_calls rows. */
  countServiceCalls(): number {
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS c FROM service_calls').get() as Row;
      return toNum(row.c);
    } catch { return 0; }
  }

  /** Total count of service_links rows. */
  countServiceLinks(): number {
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS c FROM service_links').get() as Row;
      return toNum(row.c);
    } catch { return 0; }
  }

  /** List service_calls with the AST-attributed caller joined in. */
  listServiceCalls(options: {
    protocol?: string;
    method?: string;
    pathSubstr?: string;
    framework?: string;
    callerSymbolId?: number;
    minConfidence?: number;
    /** v9 Track-H — filter by tRPC procedure / GraphQL operation / gRPC method. */
    operation?: string;
    /** v9 Track-H — filter by Kafka / pubsub topic. */
    topic?: string;
    /** v9 Track-H — filter by SQS / RabbitMQ queue. */
    queue?: string;
    /** v9 Track-H — filter by gRPC service / k8s service host. */
    service?: string;
    limit?: number;
    offset?: number;
  } = {}): import('../types.js').ServiceCallRow[] {
    const where: string[] = [];
    const args: Array<string | number | null> = [];
    if (options.protocol)        { where.push('sc.protocol = ?');          args.push(options.protocol); }
    if (options.method)          { where.push('sc.method = ?');            args.push(options.method.toUpperCase()); }
    if (options.framework)       { where.push('sc.framework = ?');         args.push(options.framework); }
    if (options.pathSubstr)      { where.push('sc.normalized_path LIKE ?'); args.push(`%${options.pathSubstr}%`); }
    if (options.callerSymbolId != null) { where.push('sc.symbol_id = ?');   args.push(options.callerSymbolId); }
    if (options.minConfidence != null)  { where.push('sc.confidence >= ?'); args.push(options.minConfidence); }
    if (options.operation)       { where.push('sc.operation = ?');         args.push(options.operation); }
    if (options.topic)           { where.push('sc.topic = ?');             args.push(options.topic); }
    if (options.queue)           { where.push('sc.queue = ?');             args.push(options.queue); }
    if (options.service)         { where.push('sc.service = ?');           args.push(options.service); }
    const limit = Math.min(options.limit ?? 100, 1000);
    const offset = options.offset ?? 0;
    args.push(limit, offset);
    const sql = `
      SELECT sc.id, sc.protocol, sc.method, sc.raw_target AS rawTarget,
             sc.normalized_path AS normalizedPath, sc.host_hint AS hostHint,
             sc.env_key AS envKey, sc.framework, sc.line, sc.confidence,
             sc.operation, sc.topic, sc.queue, sc.exchange, sc.service,
             sc.broker, sc.metadata_json AS metadataJson,
             f.rel_path AS filePath,
             sc.symbol_id AS callerSymbolId,
             s.name AS callerName, s.qualified_name AS callerQualifiedName,
             s.kind AS callerKind
        FROM service_calls sc
        JOIN files f ON f.id = sc.file_id
        LEFT JOIN symbols s ON s.id = sc.symbol_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY sc.id ASC
       LIMIT ? OFFSET ?
    `;
    try {
      const rows = this.db.prepare(sql).all(...args) as Row[];
      return rows.map(r => ({
        id: toNum(r.id),
        protocol: toStr(r.protocol),
        method: toNullStr(r.method),
        rawTarget: toStr(r.rawTarget),
        normalizedPath: toNullStr(r.normalizedPath),
        hostHint: toNullStr(r.hostHint),
        envKey: toNullStr(r.envKey),
        framework: toStr(r.framework),
        line: toNum(r.line),
        confidence: Number(r.confidence ?? 0),
        filePath: toStr(r.filePath),
        callerSymbolId: r.callerSymbolId == null ? null : toNum(r.callerSymbolId),
        callerName: toNullStr(r.callerName),
        callerQualifiedName: toNullStr(r.callerQualifiedName),
        callerKind: toNullStr(r.callerKind),
        operation: toNullStr(r.operation),
        topic: toNullStr(r.topic),
        queue: toNullStr(r.queue),
        exchange: toNullStr(r.exchange),
        service: toNullStr(r.service),
        broker: toNullStr(r.broker),
        metadataJson: toNullStr(r.metadataJson),
      }));
    } catch { return []; }
  }

  /** List service_links with caller + handler + route joined in. */
  listServiceLinks(options: {
    protocol?: string;
    method?: string;
    pathSubstr?: string;
    callerSymbolId?: number;
    handlerSymbolId?: number;
    matchKind?: string;
    minConfidence?: number;
    limit?: number;
    offset?: number;
  } = {}): import('../types.js').ServiceLinkRow[] {
    const where: string[] = [];
    const args: Array<string | number | null> = [];
    if (options.protocol)               { where.push('sl.protocol = ?');           args.push(options.protocol); }
    if (options.matchKind)              { where.push('sl.match_kind = ?');         args.push(options.matchKind); }
    if (options.minConfidence != null)  { where.push('sl.confidence >= ?');        args.push(options.minConfidence); }
    if (options.callerSymbolId != null) { where.push('sl.caller_symbol_id = ?');   args.push(options.callerSymbolId); }
    if (options.handlerSymbolId != null){ where.push('sl.handler_symbol_id = ?');  args.push(options.handlerSymbolId); }
    if (options.method)                 { where.push('sc.method = ?');             args.push(options.method.toUpperCase()); }
    if (options.pathSubstr)             { where.push('(sc.normalized_path LIKE ? OR r.path LIKE ?)');
                                          args.push(`%${options.pathSubstr}%`, `%${options.pathSubstr}%`); }
    const limit = Math.min(options.limit ?? 100, 1000);
    const offset = options.offset ?? 0;
    args.push(limit, offset);
    const sql = `
      SELECT sl.id, sl.call_id AS callId, sl.route_id AS routeId,
             sl.protocol, sl.match_kind AS matchKind,
             sl.confidence, sl.evidence_json AS evidenceJson,
             sl.caller_symbol_id AS callerSymbolId,
             cs.name AS callerName, cs.qualified_name AS callerQualifiedName,
             cf.rel_path AS callerFile,
             sc.line AS callerLine,
             sc.method AS callMethod, sc.raw_target AS callRawTarget,
             sc.normalized_path AS callNormalizedPath, sc.framework AS callFramework,
             sc.env_key AS callEnvKey, sc.host_hint AS callHostHint,
             sc.operation AS callOperation, sc.topic AS callTopic,
             sc.queue AS callQueue, sc.service AS callService,
             sl.handler_symbol_id AS handlerSymbolId,
             hs.name AS handlerName, hs.qualified_name AS handlerQualifiedName,
             hf.rel_path AS handlerFile, hs.line_start AS handlerLine,
             r.method AS routeMethod, r.path AS routePath, r.framework AS routeFramework,
             r.operation AS routeOperation, r.topic AS routeTopic,
             r.queue AS routeQueue, r.service AS routeService
        FROM service_links sl
        LEFT JOIN service_calls sc ON sc.id = sl.call_id
        LEFT JOIN files cf        ON cf.id = sc.file_id
        LEFT JOIN symbols cs      ON cs.id = sl.caller_symbol_id
        LEFT JOIN symbols hs      ON hs.id = sl.handler_symbol_id
        LEFT JOIN files hf        ON hf.id = hs.file_id
        LEFT JOIN routes r        ON r.id  = sl.route_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY sl.id ASC
       LIMIT ? OFFSET ?
    `;
    try {
      const rows = this.db.prepare(sql).all(...args) as Row[];
      return rows.map(r => ({
        id: toNum(r.id),
        callId: toNum(r.callId),
        routeId: r.routeId == null ? null : toNum(r.routeId),
        protocol: toStr(r.protocol),
        matchKind: toStr(r.matchKind),
        confidence: Number(r.confidence ?? 0),
        evidenceJson: toStr(r.evidenceJson),
        callerSymbolId: r.callerSymbolId == null ? null : toNum(r.callerSymbolId),
        callerName: toNullStr(r.callerName),
        callerQualifiedName: toNullStr(r.callerQualifiedName),
        callerFile: toNullStr(r.callerFile),
        callerLine: toNum(r.callerLine ?? 0),
        callMethod: toNullStr(r.callMethod),
        callRawTarget: toStr(r.callRawTarget),
        callNormalizedPath: toNullStr(r.callNormalizedPath),
        callFramework: toStr(r.callFramework),
        callEnvKey: toNullStr(r.callEnvKey),
        callHostHint: toNullStr(r.callHostHint),
        callOperation: toNullStr(r.callOperation),
        callTopic: toNullStr(r.callTopic),
        callQueue: toNullStr(r.callQueue),
        callService: toNullStr(r.callService),
        handlerSymbolId: r.handlerSymbolId == null ? null : toNum(r.handlerSymbolId),
        handlerName: toNullStr(r.handlerName),
        handlerQualifiedName: toNullStr(r.handlerQualifiedName),
        handlerFile: toNullStr(r.handlerFile),
        handlerLine: r.handlerLine == null ? null : toNum(r.handlerLine),
        routeMethod: toNullStr(r.routeMethod),
        routePath: toNullStr(r.routePath),
        routeFramework: toNullStr(r.routeFramework),
        routeOperation: toNullStr(r.routeOperation),
        routeTopic: toNullStr(r.routeTopic),
        routeQueue: toNullStr(r.routeQueue),
        routeService: toNullStr(r.routeService),
      }));
    } catch { return []; }
  }

  /** id-scoped helper: every service_link whose caller is symbolId. */
  serviceLinksForCaller(symbolId: number, options: { limit?: number } = {}): import('../types.js').ServiceLinkRow[] {
    return this.listServiceLinks({ callerSymbolId: symbolId, limit: options.limit });
  }

  /** id-scoped helper: every service_link whose handler is symbolId. */
  serviceLinksForHandler(symbolId: number, options: { limit?: number } = {}): import('../types.js').ServiceLinkRow[] {
    return this.listServiceLinks({ handlerSymbolId: symbolId, limit: options.limit });
  }

  /**
   * Bounded BFS over service_links from caller to handler. Treats each
   * service_link as a directed edge `caller_symbol_id → handler_symbol_id`.
   * Returns the shortest path as an array of symbol ids, or [] if unreachable
   * within maxDepth. Combines with the normal call-graph trace done by
   * `tracePath`; this one is service-link only.
   */
  traceServicePath(fromSymbolId: number, toSymbolId: number, maxDepth: number = 6): number[] {
    if (fromSymbolId === toSymbolId) return [fromSymbolId];
    if (maxDepth <= 0) return [];
    try {
      const stmt = this.db.prepare(
        `SELECT DISTINCT handler_symbol_id AS h
           FROM service_links
          WHERE caller_symbol_id = ? AND handler_symbol_id IS NOT NULL`,
      );
      const parents = new Map<number, number>();
      const visited = new Set<number>([fromSymbolId]);
      let frontier = [fromSymbolId];
      for (let depth = 0; depth < maxDepth; depth++) {
        const next: number[] = [];
        for (const cur of frontier) {
          const rows = stmt.all(cur) as Array<{ h: unknown }>;
          for (const r of rows) {
            const h = toNum(r.h);
            if (visited.has(h)) continue;
            visited.add(h);
            parents.set(h, cur);
            if (h === toSymbolId) {
              // Reconstruct path
              const path: number[] = [h];
              let cursor = cur;
              while (cursor !== fromSymbolId) {
                path.push(cursor);
                cursor = parents.get(cursor)!;
              }
              path.push(fromSymbolId);
              path.reverse();
              return path;
            }
            next.push(h);
          }
        }
        if (next.length === 0) break;
        frontier = next;
      }
      return [];
    } catch { return []; }
  }

  /**
   * v9 Track-H — bounded service-link traversal from a single symbol.
   *
   * Walks the directed service-link graph starting at `fromSymbolId`. Each
   * step follows `caller_symbol_id → handler_symbol_id` edges, recording the
   * protocol / matchKind / hop chain for every reachable handler.
   *
   * Bounds (all configurable; defaults are conservative):
   *   - maxDepth     limit hops away from the source (default 4)
   *   - maxNodes     stop after expanding this many handlers (default 200)
   *   - maxFanout    stop expanding a node after this many outgoing service
   *                  links (default 20)
   *
   * Returns one record per reached handler with the protocols and match-kinds
   * encountered along the path; `cutoff` flags the limit that fired (if any).
   */
  traceServiceDependencies(
    fromSymbolId: number,
    options: { maxDepth?: number; maxNodes?: number; maxFanout?: number } = {},
  ): {
    reached: Array<{
      symbolId: number;
      depth: number;
      protocols: string[];
      matchKinds: string[];
      hops: number[];
    }>;
    cutoff: 'maxNodes' | 'maxDepth' | 'maxFanout' | null;
    fromExpanded: number;
  } {
    const maxDepth  = options.maxDepth  ?? 4;
    const maxNodes  = options.maxNodes  ?? 200;
    const maxFanout = options.maxFanout ?? 20;

    const reached = new Map<number, { depth: number; protocols: Set<string>; matchKinds: Set<string>; parent: number | null }>();
    let cutoff: 'maxNodes' | 'maxDepth' | 'maxFanout' | null = null;
    let expanded = 0;

    try {
      // Deterministic ordering by handler symbol id ASC inside each step.
      const stmt = this.db.prepare(
        `SELECT handler_symbol_id AS h, protocol AS p, match_kind AS mk
           FROM service_links
          WHERE caller_symbol_id = ? AND handler_symbol_id IS NOT NULL
          ORDER BY confidence DESC, handler_symbol_id ASC
          LIMIT ?`,
      );

      let frontier: number[] = [fromSymbolId];
      let maxDepthFrontier: number[] = [];
      reached.set(fromSymbolId, { depth: 0, protocols: new Set(), matchKinds: new Set(), parent: null });
      for (let depth = 0; depth < maxDepth; depth++) {
        const next: number[] = [];
        for (const cur of frontier) {
          // +1 so we can detect fanout-cap hits cleanly (over-by-one).
          const rows = stmt.all(cur, maxFanout + 1) as Array<{ h: unknown; p: unknown; mk: unknown }>;
          if (rows.length > maxFanout) cutoff = 'maxFanout';
          for (let i = 0; i < Math.min(rows.length, maxFanout); i++) {
            const h = toNum(rows[i].h);
            const p = toStr(rows[i].p);
            const mk = toStr(rows[i].mk);
            if (reached.has(h)) {
              const entry = reached.get(h)!;
              entry.protocols.add(p);
              entry.matchKinds.add(mk);
              continue;
            }
            reached.set(h, {
              depth: depth + 1,
              protocols: new Set([p]),
              matchKinds: new Set([mk]),
              parent: cur,
            });
            next.push(h);
            if (reached.size > maxNodes) {
              cutoff = 'maxNodes';
              break;
            }
          }
          expanded++;
          if (cutoff === 'maxNodes') break;
        }
        if (cutoff === 'maxNodes') break;
        if (next.length === 0) break;
        if (depth + 1 >= maxDepth) {
          maxDepthFrontier = next;
          break;
        }
        frontier = next;
      }
      if (!cutoff && reached.size >= maxNodes) cutoff = 'maxNodes';
      if (!cutoff && maxDepthFrontier.length > 0) {
        const placeholders = maxDepthFrontier.map(() => '?').join(',');
        const row = this.db.prepare(
          `SELECT 1 AS ok
             FROM service_links
            WHERE caller_symbol_id IN (${placeholders})
              AND handler_symbol_id IS NOT NULL
            LIMIT 1`,
        ).get(...maxDepthFrontier) as Row | undefined;
        if (row) cutoff = 'maxDepth';
      }
    } catch { /* fall through with what we have */ }

    // Build hop chains for each reached handler.
    const out: Array<{
      symbolId: number; depth: number;
      protocols: string[]; matchKinds: string[]; hops: number[];
    }> = [];
    for (const [id, entry] of reached) {
      if (id === fromSymbolId) continue;
      const hops: number[] = [id];
      let p = entry.parent;
      while (p !== null && p !== fromSymbolId) {
        hops.push(p);
        p = reached.get(p)?.parent ?? null;
      }
      hops.push(fromSymbolId);
      hops.reverse();
      out.push({
        symbolId: id,
        depth: entry.depth,
        protocols: Array.from(entry.protocols).sort(),
        matchKinds: Array.from(entry.matchKinds).sort(),
        hops,
      });
    }
    // Deterministic order: by depth ASC, then symbolId ASC.
    out.sort((a, b) => a.depth - b.depth || a.symbolId - b.symbolId);
    return { reached: out, cutoff, fromExpanded: expanded };
  }

  /**
   * v9 Track-H — bounded service-link traversal at module granularity.
   *
   * Returns the set of modules reachable from `fromModuleId` by following
   * cross-module service links (one or more service_link edges whose caller
   * and handler live in different modules). For each reached module the
   * result includes the minimum hop depth and which protocols carry traffic
   * into it.
   *
   * Useful for "which modules depend on `billing` through HTTP/Kafka/etc?".
   */
  traceModuleServiceDependencies(
    fromModuleId: number,
    options: { maxDepth?: number; maxNodes?: number } = {},
  ): {
    reached: Array<{ moduleId: number; depth: number; protocols: string[]; viaLinks: number }>;
    cutoff: 'maxNodes' | 'maxDepth' | null;
  } {
    const maxDepth = options.maxDepth ?? 3;
    const maxNodes = options.maxNodes ?? 50;
    if (!this.hasModuleTables) return { reached: [], cutoff: null };

    // Materialize module → module service-link weights once for the BFS.
    type ModuleEdge = { from: number; to: number; protocol: string; n: number };
    const edges = this.db.prepare(
      `SELECT mm1.module_id AS f, mm2.module_id AS t, sl.protocol AS p, COUNT(*) AS n
         FROM service_links sl
         JOIN service_calls sc ON sc.id = sl.call_id
         JOIN module_members mm1 ON mm1.file_id = sc.file_id
         JOIN symbols hs ON hs.id = sl.handler_symbol_id
         JOIN module_members mm2 ON mm2.file_id = hs.file_id
        WHERE mm1.module_id <> mm2.module_id
        GROUP BY mm1.module_id, mm2.module_id, sl.protocol
        ORDER BY mm1.module_id ASC, mm2.module_id ASC, sl.protocol ASC`,
    ).all() as Array<{ f: unknown; t: unknown; p: unknown; n: unknown }>;
    const adj = new Map<number, ModuleEdge[]>();
    for (const e of edges) {
      const from = toNum(e.f);
      const list = adj.get(from) ?? [];
      list.push({ from, to: toNum(e.t), protocol: toStr(e.p), n: toNum(e.n) });
      adj.set(from, list);
    }

    type Reached = { depth: number; protocols: Set<string>; viaLinks: number };
    const reached = new Map<number, Reached>();
    reached.set(fromModuleId, { depth: 0, protocols: new Set(), viaLinks: 0 });
    let cutoff: 'maxNodes' | 'maxDepth' | null = null;

    let frontier: number[] = [fromModuleId];
    let maxDepthFrontier: number[] = [];
    for (let depth = 0; depth < maxDepth; depth++) {
      const next: number[] = [];
      for (const cur of frontier) {
        const outs = adj.get(cur) ?? [];
        for (const e of outs) {
          if (e.to === fromModuleId) continue;
          let entry = reached.get(e.to);
          if (!entry) {
            entry = { depth: depth + 1, protocols: new Set(), viaLinks: 0 };
            reached.set(e.to, entry);
            next.push(e.to);
            if (reached.size > maxNodes) { cutoff = 'maxNodes'; break; }
          }
          entry.protocols.add(e.protocol);
          entry.viaLinks += e.n;
        }
        if (cutoff) break;
      }
      if (cutoff) break;
      if (next.length === 0) break;
      if (depth + 1 >= maxDepth) {
        maxDepthFrontier = next;
        break;
      }
      frontier = next;
    }
    if (!cutoff && maxDepthFrontier.some(id => (adj.get(id)?.length ?? 0) > 0)) {
      cutoff = 'maxDepth';
    }

    const out: Array<{ moduleId: number; depth: number; protocols: string[]; viaLinks: number }> = [];
    for (const [id, r] of reached) {
      if (id === fromModuleId) continue;
      out.push({
        moduleId: id, depth: r.depth,
        protocols: Array.from(r.protocols).sort(),
        viaLinks: r.viaLinks,
      });
    }
    out.sort((a, b) => a.depth - b.depth || a.moduleId - b.moduleId);
    return { reached: out, cutoff };
  }

  // ── v10 External bundle layers ─────────────────────────────────────────────

  /** True iff the v10 external/boundary/continuity tables exist on disk. */
  hasV10(): boolean { return this.hasV10Tables; }

  /** Replace the boundaries / boundary_members / boundary_edges tables.
   *  Atomic — wrapped in a single transaction. */
  replaceBoundaries(
    boundaries: Array<{
      label: string;
      kind: string;
      rootRelPath: string;
      manifestPath: string | null;
      ecosystem: string | null;
      fileIds: number[];
    }>,
    edges: Array<{ fromIndex: number; toIndex: number; kind: string; weight: number }>,
  ): void {
    this.assertWritable();
    if (!this.hasV10Tables) return;
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM boundary_edges');
      this.db.exec('DELETE FROM boundary_members');
      this.db.exec('DELETE FROM boundaries');
      const insBoundary = this.db.prepare(`
        INSERT INTO boundaries
          (label, kind, root_rel_path, manifest_path, ecosystem, size_files, computed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insMember = this.db.prepare(
        'INSERT OR REPLACE INTO boundary_members (file_id, boundary_id) VALUES (?, ?)',
      );
      const insEdge = this.db.prepare(
        'INSERT OR REPLACE INTO boundary_edges (from_boundary_id, to_boundary_id, kind, weight) VALUES (?, ?, ?, ?)',
      );
      const now = Date.now();
      const indexToId: number[] = [];
      for (const b of boundaries) {
        const res = insBoundary.run(
          b.label, b.kind, b.rootRelPath, b.manifestPath, b.ecosystem,
          b.fileIds.length, now,
        );
        const id = toNum(res.lastInsertRowid);
        indexToId.push(id);
        for (const fid of b.fileIds) insMember.run(fid, id);
      }
      for (const e of edges) {
        const f = indexToId[e.fromIndex];
        const t = indexToId[e.toIndex];
        if (f == null || t == null) continue;
        insEdge.run(f, t, e.kind, e.weight);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** True iff boundaries were populated this build. */
  hasBoundariesData(): boolean {
    if (!this.hasV10Tables) return false;
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS c FROM boundaries').get() as Row;
      return toNum(row.c) > 0;
    } catch { return false; }
  }

  countBoundaries(): number {
    if (!this.hasV10Tables) return 0;
    try {
      return toNum((this.db.prepare('SELECT COUNT(*) AS c FROM boundaries').get() as Row).c);
    } catch { return 0; }
  }

  listBoundaries(limit = 200): Array<{
    id: number; label: string; kind: string; rootRelPath: string;
    manifestPath: string | null; ecosystem: string | null; sizeFiles: number;
  }> {
    if (!this.hasV10Tables) return [];
    try {
      const rows = this.db.prepare(`
        SELECT id, label, kind, root_rel_path AS rootRelPath,
               manifest_path AS manifestPath, ecosystem,
               size_files AS sizeFiles
        FROM boundaries
        ORDER BY size_files DESC, label
        LIMIT ?
      `).all(limit) as Row[];
      return rows.map(r => ({
        id: toNum(r.id), label: toStr(r.label), kind: toStr(r.kind),
        rootRelPath: toStr(r.rootRelPath),
        manifestPath: toNullStr(r.manifestPath),
        ecosystem: toNullStr(r.ecosystem),
        sizeFiles: toNum(r.sizeFiles),
      }));
    } catch { return []; }
  }

  /** Boundary that owns a file id (or null). */
  boundaryForFile(fileId: number): { id: number; label: string; kind: string; rootRelPath: string } | null {
    if (!this.hasV10Tables) return null;
    try {
      const row = this.db.prepare(`
        SELECT b.id, b.label, b.kind, b.root_rel_path AS rootRelPath
        FROM boundary_members bm JOIN boundaries b ON b.id = bm.boundary_id
        WHERE bm.file_id = ?
      `).get(fileId) as Row | undefined;
      if (!row) return null;
      return {
        id: toNum(row.id),
        label: toStr(row.label),
        kind: toStr(row.kind),
        rootRelPath: toStr(row.rootRelPath),
      };
    } catch { return null; }
  }

  /** Cross-boundary dependency edges from a boundary (outgoing by default). */
  boundaryDependencies(
    boundaryId: number,
    options: { direction?: 'in' | 'out'; limit?: number } = {},
  ): Array<{ boundaryId: number; label: string; kind: string; weight: number }> {
    if (!this.hasV10Tables) return [];
    const direction = options.direction ?? 'out';
    const limit = options.limit ?? 100;
    const sideThis = direction === 'out' ? 'from_boundary_id' : 'to_boundary_id';
    const sideOther = direction === 'out' ? 'to_boundary_id' : 'from_boundary_id';
    try {
      const rows = this.db.prepare(`
        SELECT b.id AS boundaryId, b.label, be.kind, be.weight
        FROM boundary_edges be JOIN boundaries b ON b.id = be.${sideOther}
        WHERE be.${sideThis} = ?
        ORDER BY be.weight DESC
        LIMIT ?
      `).all(boundaryId, limit) as Row[];
      return rows.map(r => ({
        boundaryId: toNum(r.boundaryId),
        label: toStr(r.label),
        kind: toStr(r.kind),
        weight: toNum(r.weight),
      }));
    } catch { return []; }
  }

  /** For a given symbol id, return the boundaries of each of its callees. */
  calleeBoundariesOf(symbolId: number): Array<{ calleeId: number; boundaryId: number }> {
    if (!this.hasV10Tables) return [];
    try {
      const rows = this.db.prepare(`
        SELECT DISTINCT e.to_id AS calleeId, bm.boundary_id AS boundaryId
        FROM edges e
        JOIN symbols s ON s.id = e.to_id
        JOIN boundary_members bm ON bm.file_id = s.file_id
        WHERE e.from_id = ? AND e.kind = 'call' AND e.to_id IS NOT NULL
      `).all(symbolId) as Row[];
      return rows.map(r => ({
        calleeId: toNum(r.calleeId), boundaryId: toNum(r.boundaryId),
      }));
    } catch { return []; }
  }

  /**
   * Return every files.id that's actually a phantom file backing an external
   * bundle layer. The indexer's prune pass preserves these so a local
   * re-index never drops external-imported rows.
   */
  listExternalPhantomFileIds(): number[] {
    try {
      const rows = this.db.prepare(
        "SELECT id FROM files WHERE path LIKE '__external_bundle__/%'",
      ).all() as Row[];
      return rows.map(r => toNum(r.id));
    } catch { return []; }
  }

  /** Insert (or replace) an external_bundles row for a given bundle path. */
  upsertExternalBundle(args: {
    bundlePath: string;
    externalProject: string | null;
    externalVersion: string | null;
    externalHash: string | null;
    schemaVersion: number;
    routesImported: number;
    serviceCallsImported: number;
    serviceLinksImported: number;
  }): number {
    this.assertWritable();
    if (!this.hasV10Tables) return 0;
    const existing = this.db.prepare(
      'SELECT id FROM external_bundles WHERE bundle_path = ?',
    ).get(args.bundlePath) as Row | undefined;
    if (existing) {
      const id = toNum(existing.id);
      this.db.prepare(`
        UPDATE external_bundles
        SET external_project = ?, external_version = ?, external_hash = ?,
            schema_version = ?, imported_at = ?, routes_imported = ?,
            service_calls_imported = ?, service_links_imported = ?
        WHERE id = ?
      `).run(
        args.externalProject, args.externalVersion, args.externalHash,
        args.schemaVersion, Date.now(),
        args.routesImported, args.serviceCallsImported, args.serviceLinksImported,
        id,
      );
      return id;
    }
    const r = this.db.prepare(`
      INSERT INTO external_bundles
        (source_kind, bundle_path, external_project, external_version, external_hash,
         schema_version, imported_at, routes_imported, service_calls_imported, service_links_imported)
      VALUES ('external-bundle', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      args.bundlePath, args.externalProject, args.externalVersion, args.externalHash,
      args.schemaVersion, Date.now(),
      args.routesImported, args.serviceCallsImported, args.serviceLinksImported,
    );
    return toNum(r.lastInsertRowid);
  }

  /**
   * Look up an existing external_bundles row by its bundle path. Returns the
   * id and the imported_at/external_hash for the existing layer when present.
   */
  findExternalBundleByPath(bundlePath: string): {
    id: number; bundlePath: string; externalProject: string | null;
    externalVersion: string | null; externalHash: string | null;
  } | null {
    if (!this.hasV10Tables) return null;
    try {
      const row = this.db.prepare(`
        SELECT id, bundle_path AS bundlePath, external_project AS externalProject,
               external_version AS externalVersion, external_hash AS externalHash
        FROM external_bundles WHERE bundle_path = ?
      `).get(bundlePath) as Row | undefined;
      if (!row) return null;
      return {
        id: toNum(row.id),
        bundlePath: toStr(row.bundlePath),
        externalProject: toNullStr(row.externalProject),
        externalVersion: toNullStr(row.externalVersion),
        externalHash: toNullStr(row.externalHash),
      };
    } catch { return null; }
  }

  /** List every external_bundles row (newest first). */
  listExternalBundles(): Array<{
    id: number; sourceKind: string; bundlePath: string;
    externalProject: string | null; externalVersion: string | null;
    externalHash: string | null; schemaVersion: number; importedAt: number;
    routesImported: number; serviceCallsImported: number; serviceLinksImported: number;
  }> {
    if (!this.hasV10Tables) return [];
    try {
      const rows = this.db.prepare(`
        SELECT id, source_kind AS sourceKind, bundle_path AS bundlePath,
               external_project AS externalProject,
               external_version AS externalVersion,
               external_hash AS externalHash,
               schema_version AS schemaVersion,
               imported_at AS importedAt,
               routes_imported AS routesImported,
               service_calls_imported AS serviceCallsImported,
               service_links_imported AS serviceLinksImported
        FROM external_bundles
        ORDER BY imported_at DESC
      `).all() as Row[];
      return rows.map(r => ({
        id: toNum(r.id),
        sourceKind: toStr(r.sourceKind),
        bundlePath: toStr(r.bundlePath),
        externalProject: toNullStr(r.externalProject),
        externalVersion: toNullStr(r.externalVersion),
        externalHash: toNullStr(r.externalHash),
        schemaVersion: toNum(r.schemaVersion),
        importedAt: toNum(r.importedAt),
        routesImported: toNum(r.routesImported),
        serviceCallsImported: toNum(r.serviceCallsImported),
        serviceLinksImported: toNum(r.serviceLinksImported),
      }));
    } catch { return []; }
  }

  /**
   * Delete every row associated with a given external_bundles.id — its
   * routes/service_calls/service_links rows and the bundle row itself. Used
   * during re-import so a fresh import is fully replacing the previous
   * snapshot of that bundle.
   */
  clearExternalBundle(bundleId: number): {
    routes: number; serviceCalls: number; serviceLinks: number;
  } {
    this.assertWritable();
    if (!this.hasV10Tables) return { routes: 0, serviceCalls: 0, serviceLinks: 0 };
    let routes = 0, serviceCalls = 0, serviceLinks = 0;
    this.db.exec('BEGIN');
    try {
      try {
        routes = toNum(this.db.prepare(
          'DELETE FROM routes WHERE external_bundle_id = ?',
        ).run(bundleId).changes);
      } catch { /* */ }
      try {
        serviceCalls = toNum(this.db.prepare(
          'DELETE FROM service_calls WHERE external_bundle_id = ?',
        ).run(bundleId).changes);
      } catch { /* */ }
      try {
        serviceLinks = toNum(this.db.prepare(
          'DELETE FROM service_links WHERE external_bundle_id = ?',
        ).run(bundleId).changes);
      } catch { /* */ }
      // Drop the phantom file row that owned this layer's external routes so a
      // forced re-import (which mints a new bundle id + phantom path) does not
      // leak orphaned `__external_bundle__/...` rows alongside sibling layers.
      try {
        this.db.prepare(
          "DELETE FROM files WHERE hash = ? AND path LIKE '__external_bundle__/%'",
        ).run(`external:${bundleId}`);
      } catch { /* */ }
      this.db.prepare('DELETE FROM external_bundles WHERE id = ?').run(bundleId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { routes, serviceCalls, serviceLinks };
  }

  /**
   * Insert a route from an external bundle. file_id is intentionally NULL —
   * external routes do not belong to any local file. The Store schema does
   * not allow NULL on routes.file_id by default; v10 keeps file_id NOT NULL,
   * so we have to ensure an external "phantom" file row exists per bundle to
   * own the routes. The route stays linked to the external_bundle_id so we
   * can wipe them as a layer.
   */
  insertExternalRoute(args: {
    bundleId: number;
    externalFileId: number;
    method: string;
    path: string;
    framework: string;
    handlerName: string | null;
    line: number;
    protocol?: string;
    operation?: string | null;
    topic?: string | null;
    queue?: string | null;
    exchange?: string | null;
    service?: string | null;
    broker?: string | null;
    metadataJson?: string | null;
  }): number {
    this.assertWritable();
    if (!this.hasV10Tables) return 0;
    const r = this.db.prepare(`
      INSERT INTO routes
        (file_id, method, path, framework, handler_name, line,
         protocol, operation, topic, queue, exchange, service, broker, metadata_json,
         external_bundle_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      args.externalFileId, args.method, args.path, args.framework, args.handlerName, args.line,
      args.protocol ?? 'http',
      args.operation ?? null, args.topic ?? null, args.queue ?? null,
      args.exchange ?? null, args.service ?? null, args.broker ?? null,
      args.metadataJson ?? null,
      args.bundleId,
    );
    return toNum(r.lastInsertRowid);
  }

  /**
   * Create (or reuse) an "external" phantom file row that owns external
   * bundle rows. Each external_bundles.id gets its own external-phantom file
   * so deleting a layer doesn't disturb sibling layers. The phantom file
   * carries role='vendor' so it stays out of project-first defaults.
   */
  ensureExternalFile(bundleId: number, externalProject: string): number {
    this.assertWritable();
    const phantomPath = `__external_bundle__/${externalProject}/${bundleId}`;
    const existing = this.db.prepare('SELECT id FROM files WHERE path = ?')
      .get(phantomPath) as Row | undefined;
    if (existing) return toNum(existing.id);
    const r = this.stmtUpsertFile.run(
      phantomPath, phantomPath, 'external',
      `external:${bundleId}`, 0, Date.now(),
      'vendor', 1, 0,
    );
    return toNum(r.lastInsertRowid);
  }

  /** Count of routes that came from an external bundle. */
  countExternalRoutes(): number {
    if (!this.hasV10Tables) return 0;
    try {
      const row = this.db.prepare(
        'SELECT COUNT(*) AS c FROM routes WHERE external_bundle_id IS NOT NULL',
      ).get() as Row;
      return toNum(row.c);
    } catch { return 0; }
  }

  /**
   * List routes filtered to external bundles only. Useful for verifying that
   * an external import landed and for the seer_external_bundles MCP tool.
   */
  listExternalRoutes(options: {
    bundleId?: number;
    method?: string;
    pathSubstr?: string;
    protocol?: string;
    limit?: number;
  } = {}): Array<{
    id: number;
    method: string;
    path: string;
    framework: string;
    handlerName: string | null;
    line: number;
    protocol: string | null;
    operation: string | null;
    topic: string | null;
    queue: string | null;
    service: string | null;
    externalBundleId: number;
    externalProject: string | null;
  }> {
    if (!this.hasV10Tables) return [];
    const where: string[] = ['r.external_bundle_id IS NOT NULL'];
    const args: Array<string | number | null> = [];
    if (options.bundleId != null) { where.push('r.external_bundle_id = ?'); args.push(options.bundleId); }
    if (options.method)           { where.push('r.method = ?');             args.push(options.method.toUpperCase()); }
    if (options.pathSubstr)       { where.push('r.path LIKE ?');            args.push(`%${options.pathSubstr}%`); }
    if (options.protocol)         { where.push('r.protocol = ?');           args.push(options.protocol); }
    const limit = options.limit ?? 200;
    args.push(limit);
    try {
      const rows = this.db.prepare(`
        SELECT r.id, r.method, r.path, r.framework, r.handler_name AS handlerName,
               r.line, r.protocol, r.operation, r.topic, r.queue, r.service,
               r.external_bundle_id AS externalBundleId,
               eb.external_project AS externalProject
        FROM routes r
        JOIN external_bundles eb ON eb.id = r.external_bundle_id
        WHERE ${where.join(' AND ')}
        ORDER BY r.path, r.method
        LIMIT ?
      `).all(...args) as Row[];
      return rows.map(r => ({
        id: toNum(r.id),
        method: toStr(r.method),
        path: toStr(r.path),
        framework: toStr(r.framework),
        handlerName: toNullStr(r.handlerName),
        line: toNum(r.line),
        protocol: toNullStr(r.protocol),
        operation: toNullStr(r.operation),
        topic: toNullStr(r.topic),
        queue: toNullStr(r.queue),
        service: toNullStr(r.service),
        externalBundleId: toNum(r.externalBundleId),
        externalProject: toNullStr(r.externalProject),
      }));
    } catch { return []; }
  }

  // ── External dependencies ───────────────────────────────────────────────────

  listExternalDeps(options: { ecosystem?: string; nameSubstr?: string; limit?: number } = {}): ExternalDepRow[] {
    if (!this.hasV4Tables) return [];
    const where: string[] = [];
    const args: Array<string | number | null> = [];
    if (options.ecosystem)  { where.push('ecosystem = ?');          args.push(options.ecosystem); }
    if (options.nameSubstr) { where.push('name LIKE ?');            args.push(`%${options.nameSubstr}%`); }
    const limit = options.limit ?? 500;
    args.push(limit);
    const sql = `
      SELECT id, ecosystem, name, version_range AS versionRange,
             manifest_path AS manifestPath, is_dev AS isDev
      FROM external_dependencies
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ecosystem, name
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(...args) as Row[];
    return rows.map(r => ({
      id: toNum(r.id),
      ecosystem: toStr(r.ecosystem),
      name: toStr(r.name),
      versionRange: toNullStr(r.versionRange),
      manifestPath: toStr(r.manifestPath),
      isDev: toNum(r.isDev),
    }));
  }

  countExternalDeps(): number {
    if (!this.hasV4Tables) return 0;
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM external_dependencies').get() as Row;
    return toNum(row.c);
  }

  // ── Config keys ─────────────────────────────────────────────────────────────

  listConfigKeys(options: { key?: string; source?: string; limit?: number } = {}): ConfigKeyRow[] {
    if (!this.hasV4Tables) return [];
    const where: string[] = [];
    const args: Array<string | number | null> = [];
    if (options.key)    { where.push('c.key LIKE ?');     args.push(`%${options.key}%`); }
    if (options.source) { where.push('c.source = ?');     args.push(options.source); }
    const limit = options.limit ?? 200;
    args.push(limit);
    const sql = `
      SELECT c.id, c.key, c.source, f.path AS filePath,
             c.symbol_id AS symbolId,
             s.qualified_name AS symbolName,
             c.line
      FROM config_keys c
      JOIN files f ON f.id = c.file_id
      LEFT JOIN symbols s ON s.id = c.symbol_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY c.key, f.path
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(...args) as Row[];
    return rows.map(r => ({
      id: toNum(r.id),
      key: toStr(r.key),
      source: toStr(r.source),
      filePath: toStr(r.filePath),
      symbolId: toNullNum(r.symbolId),
      symbolName: toNullStr(r.symbolName),
      line: toNum(r.line),
    }));
  }

  countConfigKeys(): number {
    if (!this.hasV4Tables) return 0;
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM config_keys').get() as Row;
    return toNum(row.c);
  }

  // ── File churn ──────────────────────────────────────────────────────────────

  upsertFileChurn(
    fileId: number, commitCount: number, lastCommitSha: string | null,
    lastCommitAt: number | null, topAuthor: string | null, secondAuthor: string | null,
  ): void {
    this.db.prepare(`
      INSERT INTO file_churn (file_id, commit_count, last_commit_sha, last_commit_at, top_author, second_author, collected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_id) DO UPDATE SET
        commit_count = excluded.commit_count,
        last_commit_sha = excluded.last_commit_sha,
        last_commit_at = excluded.last_commit_at,
        top_author = excluded.top_author,
        second_author = excluded.second_author,
        collected_at = excluded.collected_at
    `).run(fileId, commitCount, lastCommitSha, lastCommitAt, topAuthor, secondAuthor, Date.now());
  }

  getFileChurn(filePath: string): FileChurnRow | null {
    if (!this.hasV4Tables) return null;
    const row = this.db.prepare(`
      SELECT c.file_id AS fileId, f.path AS filePath,
             c.commit_count AS commitCount,
             c.last_commit_sha AS lastCommitSha,
             c.last_commit_at AS lastCommitAt,
             c.top_author AS topAuthor,
             c.second_author AS secondAuthor
      FROM file_churn c JOIN files f ON f.id = c.file_id
      WHERE f.path = ? OR f.rel_path = ?
    `).get(filePath, filePath) as Row | undefined;
    if (!row) return null;
    return {
      fileId: toNum(row.fileId),
      filePath: toStr(row.filePath),
      commitCount: toNum(row.commitCount),
      lastCommitSha: toNullStr(row.lastCommitSha),
      lastCommitAt: toNullNum(row.lastCommitAt),
      topAuthor: toNullStr(row.topAuthor),
      secondAuthor: toNullStr(row.secondAuthor),
    };
  }

  topChurnedFiles(limit = 20): FileChurnRow[] {
    if (!this.hasV4Tables) return [];
    const rows = this.db.prepare(`
      SELECT c.file_id AS fileId, f.path AS filePath,
             c.commit_count AS commitCount,
             c.last_commit_sha AS lastCommitSha,
             c.last_commit_at AS lastCommitAt,
             c.top_author AS topAuthor,
             c.second_author AS secondAuthor
      FROM file_churn c JOIN files f ON f.id = c.file_id
      ORDER BY c.commit_count DESC
      LIMIT ?
    `).all(limit) as Row[];
    return rows.map(r => ({
      fileId: toNum(r.fileId),
      filePath: toStr(r.filePath),
      commitCount: toNum(r.commitCount),
      lastCommitSha: toNullStr(r.lastCommitSha),
      lastCommitAt: toNullNum(r.lastCommitAt),
      topAuthor: toNullStr(r.topAuthor),
      secondAuthor: toNullStr(r.secondAuthor),
    }));
  }

  // ── Symbol history ──────────────────────────────────────────────────────────

  insertSymbolHistory(
    symbolId: number, symbolKey: string, commitSha: string,
    authorName: string | null, authorEmail: string | null,
    committedAt: number, message: string | null,
    linesAdded: number, linesRemoved: number,
    prNumber: number | null, prUrl: string | null,
    matchStrategy: string, confidence: number,
  ): void {
    // Cached prepared statement (see prepare()) — no per-row recompile.
    this.stmtInsertSymbolHistory.run(
      symbolId, symbolKey, commitSha, authorName, authorEmail, committedAt, message,
      linesAdded, linesRemoved, prNumber, prUrl, matchStrategy, confidence);
  }

  /**
   * Batched, transactional symbol-history insert. One cached prepared statement
   * reused across the batch, wrapped in a single transaction. Built for the
   * per-file row batches the history indexer produces: it turns each file's
   * writes from N autocommits into one commit.
   *
   * `INSERT OR IGNORE` against `UNIQUE(symbol_id, commit_sha)` keeps it
   * idempotent — re-running a file (resume, overlapping budgets) never
   * duplicates. Returns the number of rows ACTUALLY inserted (SQLite `changes`
   * is 0 for an ignored row), which the caller uses for honest progress/result
   * counts rather than counting attempts.
   */
  insertSymbolHistoryBatch(rows: SymbolHistoryInsert[]): number {
    if (rows.length === 0) return 0;
    const stmt = this.stmtInsertSymbolHistory;
    let inserted = 0;
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        const res = stmt.run(
          r.symbolId, r.symbolKey, r.commitSha, r.authorName, r.authorEmail,
          r.committedAt, r.message, r.linesAdded, r.linesRemoved,
          r.prNumber, r.prUrl, r.matchStrategy, r.confidence);
        if (Number(res.changes) > 0) inserted++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return inserted;
  }

  /**
   * Delete this file's existing history rows (by symbol id), then insert the
   * freshly-computed batch — both in ONE transaction. Used by the per-file
   * history walk so a reprocess produces EXACTLY the current correct set rather
   * than unioning with stale rows. The reprocess cases that need this:
   *   - a `--follow` toggle or algorithm bump changes which commits attribute
   *     (the options fingerprint flips the watermark, but the symbol ids may be
   *     unchanged, so plain INSERT OR IGNORE would leave the old rows behind);
   *   - a `--force` rebuild where symbols were never reindexed (no ON DELETE
   *     CASCADE fired).
   * For the common incremental case (a changed file is reindexed) the symbols
   * are replaced and ON DELETE CASCADE already cleared the old rows, so the
   * delete here is a cheap no-op. Returns rows actually inserted.
   */
  replaceSymbolHistoryForSymbols(symbolIds: number[], rows: SymbolHistoryInsert[]): number {
    if (symbolIds.length === 0 && rows.length === 0) return 0;
    const stmt = this.stmtInsertSymbolHistory;
    let inserted = 0;
    this.db.exec('BEGIN');
    try {
      if (symbolIds.length > 0) {
        // Chunk the IN-list so a file with thousands of symbols stays under the
        // SQLite variable limit.
        const del = this.db.prepare('DELETE FROM symbol_history WHERE symbol_id = ?');
        for (const id of symbolIds) del.run(id);
      }
      for (const r of rows) {
        const res = stmt.run(
          r.symbolId, r.symbolKey, r.commitSha, r.authorName, r.authorEmail,
          r.committedAt, r.message, r.linesAdded, r.linesRemoved,
          r.prNumber, r.prUrl, r.matchStrategy, r.confidence);
        if (Number(res.changes) > 0) inserted++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return inserted;
  }

  /**
   * Like listSymbolsForHistoryIndex but scoped to a set of absolute file paths —
   * used by the on-demand / scoped history build so it only loads the handful of
   * symbols whose files were requested, instead of every symbol in the repo.
   */
  listSymbolsForHistoryIndexForFiles(
    paths: string[],
  ): Array<{ id: number; fileId: number; filePath: string; relPath: string; fileHash: string; lineStart: number; lineEnd: number; symbolKey: string }> {
    if (paths.length === 0) return [];
    // Path inputs may be absolute OR repo-relative and, on Windows, can differ
    // from the stored f.path only by drive-letter case (`c:` vs `C:`) or path
    // separator (`\` vs `/`). The old exact `f.path IN (...)` match silently
    // returned nothing in those cases — which broke EVERY scoped/on-demand
    // symbol-history build on Windows (the agent-facing "~1s history" path).
    // Normalize both sides (lower-case + forward slashes, strip `./` and a
    // trailing slash) and match against BOTH the absolute path and the rel_path,
    // so an absolute, a relative, or a differently-cased input all resolve.
    const norm = (p: string): string =>
      p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
    const keys = Array.from(new Set(paths.map(norm))).filter(Boolean);
    if (keys.length === 0) return [];
    const ph = keys.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT s.id, s.file_id AS fileId, f.path AS filePath, f.rel_path AS relPath,
             f.hash AS fileHash,
             s.line_start AS lineStart, s.line_end AS lineEnd, s.symbol_key AS symbolKey
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.symbol_key IS NOT NULL
        AND s.kind IN ('function','method','constructor','class')
        AND (
          lower(replace(f.path, '\\', '/')) IN (${ph})
          OR lower(replace(f.rel_path, '\\', '/')) IN (${ph})
        )
    `).all(...keys, ...keys) as Row[];
    return rows.map(r => ({
      id: toNum(r.id), fileId: toNum(r.fileId),
      filePath: toStr(r.filePath), relPath: toStr(r.relPath),
      fileHash: toStr(r.fileHash),
      lineStart: toNum(r.lineStart), lineEnd: toNum(r.lineEnd),
      symbolKey: toStr(r.symbolKey),
    }));
  }

  getSymbolHistory(symbolId: number, options: { limit?: number; since?: number } = {}): SymbolHistoryRow[] {
    if (!this.hasV4Tables) return [];
    const limit = Math.max(1, options.limit ?? 50);
    const since = options.since;
    const where = since != null ? 'AND committed_at >= ?' : '';
    const args: Array<string | number | null> = [symbolId];
    if (since != null) args.push(since);
    args.push(limit);
    const rows = this.db.prepare(`
      SELECT id, symbol_id AS symbolId, symbol_key AS symbolKey, commit_sha AS commitSha,
             author_name AS authorName, author_email AS authorEmail,
             committed_at AS committedAt, message,
             lines_added AS linesAdded, lines_removed AS linesRemoved,
             pr_number AS prNumber, pr_url AS prUrl,
             match_strategy AS matchStrategy, confidence
      FROM symbol_history
      WHERE symbol_id = ? ${where}
      ORDER BY committed_at DESC
      LIMIT ?
    `).all(...args) as Row[];
    return rows.map(r => ({
      id: toNum(r.id),
      symbolId: toNum(r.symbolId),
      symbolKey: toStr(r.symbolKey),
      commitSha: toStr(r.commitSha),
      authorName: toNullStr(r.authorName),
      authorEmail: toNullStr(r.authorEmail),
      committedAt: toNum(r.committedAt),
      message: toNullStr(r.message),
      linesAdded: toNum(r.linesAdded),
      linesRemoved: toNum(r.linesRemoved),
      prNumber: toNullNum(r.prNumber),
      prUrl: toNullStr(r.prUrl),
      matchStrategy: toStr(r.matchStrategy),
      confidence: Number(r.confidence),
    }));
  }

  /** Total history count for a symbol — for "showing N of M commits" headers. */
  countSymbolHistory(symbolId: number): number {
    if (!this.hasV4Tables) return 0;
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM symbol_history WHERE symbol_id = ?').get(symbolId) as Row;
    return toNum(row.c);
  }

  getGitIndexState(): {
    repoRoot: string;
    lastHeadSha: string | null;
    lastProcessedAt: number;
    remoteUrl: string | null;
    algorithmVersion: number;
    lastHistoryHeadSha: string | null;
    lastHistoryAt: number | null;
    lastHistoryFollow: boolean | null;
  } | null {
    if (!this.hasV4Tables) return null;
    const row = this.db.prepare(
      `SELECT repo_root AS repoRoot, last_head_sha AS lastHeadSha,
              last_processed_at AS lastProcessedAt, remote_url AS remoteUrl,
              algorithm_version AS algorithmVersion,
              last_history_head_sha AS lastHistoryHeadSha,
              last_history_at AS lastHistoryAt,
              last_history_follow AS lastHistoryFollow
       FROM git_index_state WHERE id = 1`
    ).get() as Row | undefined;
    if (!row) return null;
    return {
      repoRoot: toStr(row.repoRoot),
      lastHeadSha: toNullStr(row.lastHeadSha),
      lastProcessedAt: toNum(row.lastProcessedAt),
      remoteUrl: toNullStr(row.remoteUrl),
      algorithmVersion: toNum(row.algorithmVersion),
      lastHistoryHeadSha: toNullStr(row.lastHistoryHeadSha),
      lastHistoryAt: row.lastHistoryAt == null ? null : toNum(row.lastHistoryAt),
      lastHistoryFollow: row.lastHistoryFollow == null ? null : (toNum(row.lastHistoryFollow) === 1),
    };
  }

  /**
   * Generic "the indexer has seen this HEAD" stamp — used by churn and any
   * other read-only git pass. Does NOT touch the history-specific marker.
   * symbol-history has its own setHistoryHeadSha() so the two passes can't
   * mask each other.
   */
  setGitIndexState(
    repoRoot: string, lastHeadSha: string | null, remoteUrl: string | null, algorithmVersion = 1,
  ): void {
    this.db.prepare(`
      INSERT INTO git_index_state (id, repo_root, last_head_sha, last_processed_at, remote_url, algorithm_version)
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        repo_root = excluded.repo_root,
        last_head_sha = excluded.last_head_sha,
        last_processed_at = excluded.last_processed_at,
        remote_url = excluded.remote_url,
        algorithm_version = excluded.algorithm_version
    `).run(repoRoot, lastHeadSha, Date.now(), remoteUrl, algorithmVersion);
  }

  /**
   * Stamp the HEAD that symbol-history was last built against. Independent of
   * setGitIndexState() so running file-level churn never makes a subsequent
   * buildSymbolHistory() skip.
   */
  setHistoryHeadSha(
    repoRoot: string, lastHistoryHeadSha: string | null, remoteUrl: string | null,
    follow?: boolean,
  ): void {
    // Upsert: insert a fresh row if churn hasn't run yet; otherwise just
    // update the history columns. repo_root + remote_url are kept in sync
    // either way so the row stays self-describing.
    // last_history_follow persists the --follow choice so incremental refreshes
    // can replicate it without scanning per-file watermarks (which may be mixed
    // if scoped builds ran after the full build).
    this.db.prepare(`
      INSERT INTO git_index_state
        (id, repo_root, last_processed_at, remote_url, algorithm_version,
         last_history_head_sha, last_history_at, last_history_follow)
      VALUES (1, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        repo_root = excluded.repo_root,
        remote_url = COALESCE(excluded.remote_url, git_index_state.remote_url),
        last_history_head_sha = excluded.last_history_head_sha,
        last_history_at = excluded.last_history_at,
        last_history_follow = excluded.last_history_follow
    `).run(repoRoot, Date.now(), remoteUrl, lastHistoryHeadSha, Date.now(), follow ? 1 : 0);
  }

  /** All symbols matching a symbol_key — used by `seer_history` to find the
   *  current id for a key that came from the indexed graph. */
  findSymbolsByKey(symbolKey: string): SymbolRow[] {
    const rows = this.db.prepare(`
      SELECT ${symbolSelectCols(this.hasComplexityColumns, this.hasSymbolRoleColumn)}
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.symbol_key = ?
      ORDER BY s.pagerank DESC
    `).all(symbolKey) as Row[];
    return rows.map(toSymbolRow);
  }

  /** Iterate over (id, file_id, line_start, line_end, symbol_key, file hash) —
   *  used by the symbol-history indexer to map historical line ranges to current
   *  ids and to key the per-file resume watermark on file content. */
  listSymbolsForHistoryIndex(): Array<{ id: number; fileId: number; filePath: string; relPath: string; fileHash: string; lineStart: number; lineEnd: number; symbolKey: string }> {
    const rows = this.db.prepare(`
      SELECT s.id, s.file_id AS fileId, f.path AS filePath, f.rel_path AS relPath,
             f.hash AS fileHash,
             s.line_start AS lineStart, s.line_end AS lineEnd, s.symbol_key AS symbolKey
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.symbol_key IS NOT NULL
        AND s.kind IN ('function','method','constructor','class')
    `).all() as Row[];
    return rows.map(r => ({
      id: toNum(r.id), fileId: toNum(r.fileId),
      filePath: toStr(r.filePath), relPath: toStr(r.relPath),
      fileHash: toStr(r.fileHash),
      lineStart: toNum(r.lineStart), lineEnd: toNum(r.lineEnd),
      symbolKey: toStr(r.symbolKey),
    }));
  }

  // ── Symbol-history resume watermarks (v11) ──────────────────────────────────

  /**
   * Load every per-file resume watermark for a repo into a Map keyed by
   * file_path. The history build consults this once up front to decide which
   * files it can safely skip. See the symbol_history_progress schema comment
   * for why file_hash + options_fingerprint + algorithm_version (NOT head_sha)
   * is the correctness key.
   */
  getSymbolHistoryWatermarks(
    repoRoot: string,
  ): Map<string, { fileHash: string; optionsFingerprint: string; algorithmVersion: number; headSha: string | null }> {
    const out = new Map<string, { fileHash: string; optionsFingerprint: string; algorithmVersion: number; headSha: string | null }>();
    if (!this.hasColumn('symbol_history_progress', 'file_hash')) return out;
    const rows = this.db.prepare(`
      SELECT file_path AS filePath, file_hash AS fileHash,
             options_fingerprint AS optionsFingerprint,
             algorithm_version AS algorithmVersion, head_sha AS headSha
      FROM symbol_history_progress WHERE repo_root = ?
    `).all(repoRoot) as Row[];
    for (const r of rows) {
      out.set(toStr(r.filePath), {
        fileHash: toStr(r.fileHash),
        optionsFingerprint: toStr(r.optionsFingerprint),
        algorithmVersion: toNum(r.algorithmVersion),
        headSha: toNullStr(r.headSha),
      });
    }
    return out;
  }

  /** Upsert one file's resume watermark after its history rows have been
   *  committed. Keyed (repo_root, file_path) so re-processing overwrites. */
  upsertSymbolHistoryWatermark(
    repoRoot: string, filePath: string, fileHash: string,
    optionsFingerprint: string, algorithmVersion: number,
    headSha: string | null, rowsInserted: number,
  ): void {
    this.db.prepare(`
      INSERT INTO symbol_history_progress
        (repo_root, file_path, file_hash, options_fingerprint, algorithm_version,
         head_sha, rows_inserted, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_root, file_path) DO UPDATE SET
        file_hash           = excluded.file_hash,
        options_fingerprint = excluded.options_fingerprint,
        algorithm_version   = excluded.algorithm_version,
        head_sha            = excluded.head_sha,
        rows_inserted       = excluded.rows_inserted,
        processed_at        = excluded.processed_at
    `).run(repoRoot, filePath, fileHash, optionsFingerprint, algorithmVersion,
           headSha, rowsInserted, Date.now());
  }

  /** Drop all resume watermarks for a repo — used by a forced full rebuild so
   *  the next run reprocesses every file from scratch. */
  clearSymbolHistoryWatermarks(repoRoot: string): void {
    if (!this.hasColumn('symbol_history_progress', 'file_hash')) return;
    this.db.prepare('DELETE FROM symbol_history_progress WHERE repo_root = ?').run(repoRoot);
  }

  // ── PageRank helpers ────────────────────────────────────────────────────────

  getAllEdges(): Array<{ from: number; to: number }> {
    const rows = this.db.prepare(`
      SELECT e.from_id AS \`from\`, e.to_id AS \`to\`
      FROM edges e
      JOIN symbols sf ON sf.id = e.from_id AND sf.is_rankable = 1
      JOIN symbols st ON st.id = e.to_id   AND st.is_rankable = 1
      WHERE e.to_id IS NOT NULL
        AND e.kind = 'call'
    `).all() as Row[];

    return rows.map(r => ({ from: toNum(r.from), to: toNum(r.to) }));
  }

  getAllSymbolIds(): number[] {
    const rows = this.db.prepare(
      'SELECT id FROM symbols WHERE is_rankable = 1',
    ).all() as Row[];
    return rows.map(r => toNum(r.id));
  }

  updatePageRanks(ranks: Map<number, number>): void {
    const stmt = this.db.prepare('UPDATE symbols SET pagerank = ? WHERE id = ?');
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE symbols SET pagerank = 0 WHERE is_rankable = 0 AND pagerank != 0').run();
      for (const [id, rank] of ranks) {
        stmt.run(rank, id);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ── Graph traversal ─────────────────────────────────────────────────────────

  /**
   * Bounded breadth-first search over the call graph. Returns one shortest
   * path from `fromId` to `toId` (by edge count), or null if none found.
   * The search expands at most `maxDepth` hops and at most `maxNodes` nodes
   * visited overall — without those caps a cycle in the graph would explode.
   */
  tracePath(fromId: number, toId: number, maxDepth = 6, maxNodes = 20_000): Array<{ id: number; name: string; qualifiedName: string | null; kind: string; filePath: string }> | null {
    if (fromId === toId) {
      const row = this.getSymbolById(fromId);
      return row ? [{ id: row.id, name: row.name, qualifiedName: row.qualifiedName, kind: row.kind, filePath: row.filePath }] : null;
    }
    const adjStmt = this.db.prepare("SELECT DISTINCT to_id FROM edges WHERE from_id = ? AND to_id IS NOT NULL AND kind = 'call'");
    const parent = new Map<number, number>();
    parent.set(fromId, -1);
    const queue: Array<{ id: number; depth: number }> = [{ id: fromId, depth: 0 }];
    let visited = 0;
    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      visited++;
      if (visited > maxNodes) return null;
      if (depth >= maxDepth) continue;
      const rows = adjStmt.all(id) as Row[];
      for (const r of rows) {
        const next = toNum(r.to_id);
        if (parent.has(next)) continue;
        parent.set(next, id);
        if (next === toId) {
          // Reconstruct
          const path: number[] = [];
          let cur: number = next;
          while (cur !== -1) { path.push(cur); cur = parent.get(cur)!; }
          path.reverse();
          return path.map(pid => {
            const s = this.getSymbolById(pid);
            return s ? { id: s.id, name: s.name, qualifiedName: s.qualifiedName, kind: s.kind, filePath: s.filePath }
                     : { id: pid, name: '', qualifiedName: null, kind: '', filePath: '' };
          });
        }
        queue.push({ id: next, depth: depth + 1 });
      }
    }
    return null;
  }

  /** Reverse BFS from a symbol — for "everything that transitively calls X". */
  reverseReachable(toId: number, maxDepth = 4, maxNodes = 20_000): number[] {
    const stmt = this.db.prepare("SELECT DISTINCT from_id FROM edges WHERE to_id = ? AND kind = 'call'");
    const seen = new Set<number>([toId]);
    const queue: Array<{ id: number; depth: number }> = [{ id: toId, depth: 0 }];
    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (seen.size > maxNodes) break;
      if (depth >= maxDepth) continue;
      const rows = stmt.all(id) as Row[];
      for (const r of rows) {
        const next = toNum(r.from_id);
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push({ id: next, depth: depth + 1 });
      }
    }
    seen.delete(toId);
    return Array.from(seen);
  }

  /**
   * Bounded reverse-reachable callers WITH depth, for risk/context callers.
   * Same termination semantics as reverseReachable() but returns the depth
   * at which each id was first discovered (1-indexed; direct callers = 1).
   */
  reverseReachableWithDepth(
    toId: number,
    maxDepth = 4,
    maxNodes = 20_000,
  ): Array<{ id: number; depth: number }> {
    const stmt = this.db.prepare(
      "SELECT DISTINCT from_id FROM edges WHERE to_id = ? AND kind = 'call'",
    );
    const seen = new Map<number, number>([[toId, 0]]);
    const queue: Array<{ id: number; depth: number }> = [{ id: toId, depth: 0 }];
    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (seen.size > maxNodes) break;
      if (depth >= maxDepth) continue;
      const rows = stmt.all(id) as Row[];
      for (const r of rows) {
        const next = toNum(r.from_id);
        if (seen.has(next)) continue;
        seen.set(next, depth + 1);
        queue.push({ id: next, depth: depth + 1 });
      }
    }
    seen.delete(toId);
    return Array.from(seen.entries()).map(([id, depth]) => ({ id, depth }));
  }

  /**
   * Bounded forward-reachable callees with depth — for callee blast-radius
   * questions and behavioral indirect-coverage. Mirror of
   * reverseReachableWithDepth().
   */
  forwardReachableWithDepth(
    fromId: number,
    maxDepth = 4,
    maxNodes = 20_000,
  ): Array<{ id: number; depth: number }> {
    const stmt = this.db.prepare(
      "SELECT DISTINCT to_id FROM edges WHERE from_id = ? AND to_id IS NOT NULL AND kind = 'call'",
    );
    const seen = new Map<number, number>([[fromId, 0]]);
    const queue: Array<{ id: number; depth: number }> = [{ id: fromId, depth: 0 }];
    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (seen.size > maxNodes) break;
      if (depth >= maxDepth) continue;
      const rows = stmt.all(id) as Row[];
      for (const r of rows) {
        const next = toNum(r.to_id);
        if (seen.has(next)) continue;
        seen.set(next, depth + 1);
        queue.push({ id: next, depth: depth + 1 });
      }
    }
    seen.delete(fromId);
    return Array.from(seen.entries()).map(([id, depth]) => ({ id, depth }));
  }

  /**
   * Bounded BFS over the file-import graph. Used by
   * seer_trace_file_dependencies — returns each reachable file with the BFS
   * depth at which we first saw it.
   */
  fileImportClosure(
    fileId: number,
    maxDepth = 4,
    maxNodes = 5_000,
  ): Array<{ id: number; depth: number; relPath: string; language: string }> {
    const stmt = this.db.prepare(
      'SELECT DISTINCT resolved_file_id FROM file_imports WHERE from_file_id = ? AND resolved_file_id IS NOT NULL',
    );
    const seen = new Map<number, number>([[fileId, 0]]);
    const queue: Array<{ id: number; depth: number }> = [{ id: fileId, depth: 0 }];
    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (seen.size > maxNodes) break;
      if (depth >= maxDepth) continue;
      const rows = stmt.all(id) as Row[];
      for (const r of rows) {
        const next = toNum(r.resolved_file_id);
        if (seen.has(next)) continue;
        seen.set(next, depth + 1);
        queue.push({ id: next, depth: depth + 1 });
      }
    }
    seen.delete(fileId);
    if (seen.size === 0) return [];
    const ids = Array.from(seen.keys());
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT id, rel_path AS relPath, language FROM files WHERE id IN (${placeholders})`,
    ).all(...ids) as Row[];
    const meta = new Map(rows.map(r => [
      toNum(r.id),
      { relPath: toStr(r.relPath), language: toStr(r.language) },
    ]));
    return ids.map(id => {
      const m = meta.get(id);
      return {
        id,
        depth: seen.get(id)!,
        relPath: m?.relPath ?? '',
        language: m?.language ?? '',
      };
    });
  }

  // ── Track-E: file/module aggregate graph helpers ────────────────────────────

  /**
   * All cross-file call edges as (fromFile, toFile, weight) triples.
   * Used by the Louvain clusterer; only resolved 'call' edges count.
   */
  fileCallEdgeWeights(): Array<{ from: number; to: number; weight: number }> {
    const rows = this.db.prepare(`
      SELECT sf.file_id AS fromFile, st.file_id AS toFile, COUNT(*) AS w
      FROM edges e
      JOIN symbols sf ON sf.id = e.from_id
      JOIN symbols st ON st.id = e.to_id
      WHERE e.kind = 'call' AND e.to_id IS NOT NULL
        AND sf.file_id <> st.file_id
      GROUP BY sf.file_id, st.file_id
    `).all() as Row[];
    return rows.map(r => ({
      from: toNum(r.fromFile),
      to: toNum(r.toFile),
      weight: toNum(r.w),
    }));
  }

  /** Resolved cross-file import edges as (fromFile, toFile, weight). */
  fileImportEdgeWeights(): Array<{ from: number; to: number; weight: number }> {
    const rows = this.db.prepare(`
      SELECT from_file_id AS fromFile, resolved_file_id AS toFile, COUNT(*) AS w
      FROM file_imports
      WHERE resolved_file_id IS NOT NULL
        AND from_file_id <> resolved_file_id
      GROUP BY from_file_id, resolved_file_id
    `).all() as Row[];
    return rows.map(r => ({
      from: toNum(r.fromFile),
      to: toNum(r.toFile),
      weight: toNum(r.w),
    }));
  }

  /** Synthesized test → production edges, file-aggregated. */
  fileTestEdgeWeights(): Array<{ from: number; to: number; weight: number }> {
    const rows = this.db.prepare(`
      SELECT sf.file_id AS fromFile, st.file_id AS toFile, COUNT(*) AS w
      FROM edges e
      JOIN symbols sf ON sf.id = e.from_id
      JOIN symbols st ON st.id = e.to_id
      WHERE e.kind = 'tests' AND e.to_id IS NOT NULL
        AND sf.file_id <> st.file_id
      GROUP BY sf.file_id, st.file_id
    `).all() as Row[];
    return rows.map(r => ({
      from: toNum(r.fromFile),
      to: toNum(r.toFile),
      weight: toNum(r.w),
    }));
  }

  /**
   * v8 Track-G — service-link file-aggregated edges. Each link contributes one
   * cross-file edge from the call-site file (service_calls.file_id) to the
   * handler-symbol's file. Used by the module clusterer to surface
   * client→handler dependencies as architecturally important.
   */
  fileServiceLinkEdgeWeights(): Array<{ from: number; to: number; weight: number }> {
    try {
      const rows = this.db.prepare(`
        SELECT sc.file_id AS fromFile, hs.file_id AS toFile, COUNT(*) AS w
          FROM service_links sl
          JOIN service_calls sc ON sc.id = sl.call_id
          LEFT JOIN symbols hs  ON hs.id = sl.handler_symbol_id
         WHERE hs.file_id IS NOT NULL
           AND sc.file_id <> hs.file_id
         GROUP BY sc.file_id, hs.file_id
      `).all() as Row[];
      return rows.map(r => ({
        from: toNum(r.fromFile),
        to: toNum(r.toFile),
        weight: toNum(r.w),
      }));
    } catch { return []; }
  }

  /** All file ids + their language + rel path — feeds the clusterer. */
  listFileSummaries(): Array<{ id: number; relPath: string; language: string; role: string }> {
    const rows = this.db.prepare(
      'SELECT id, rel_path AS relPath, language, role FROM files',
    ).all() as Row[];
    return rows.map(r => ({
      id: toNum(r.id), relPath: toStr(r.relPath),
      language: toStr(r.language), role: toStr(r.role),
    }));
  }

  // ── Track-E: modules persistence ────────────────────────────────────────────

  /**
   * Replace the modules / module_members / module_edges tables with the
   * provided clustering. Atomic — wrapped in a single transaction so a
   * partial write can't leave inconsistent membership.
   */
  replaceModules(
    modules: Array<{
      label: string;
      sizeFiles: number;
      sizeSymbols: number;
      primaryLanguage: string | null;
      cohesion: number;
      centrality: number;
      fileIds: number[];
    }>,
    edges: Array<{ fromIndex: number; toIndex: number; kind: string; weight: number }>,
    algorithm = 'louvain',
  ): void {
    if (!this.hasModuleTables) return;
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM module_edges');
      this.db.exec('DELETE FROM module_members');
      this.db.exec('DELETE FROM modules');
      const insModule = this.db.prepare(`
        INSERT INTO modules (label, size_files, size_symbols, primary_language, cohesion, centrality, computed_at, algorithm)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insMember = this.db.prepare(
        'INSERT INTO module_members (file_id, module_id) VALUES (?, ?)',
      );
      const insEdge = this.db.prepare(
        'INSERT OR REPLACE INTO module_edges (from_module_id, to_module_id, kind, weight) VALUES (?, ?, ?, ?)',
      );
      const now = Date.now();
      const indexToId: number[] = [];
      for (const m of modules) {
        const res = insModule.run(
          m.label, m.sizeFiles, m.sizeSymbols, m.primaryLanguage,
          m.cohesion, m.centrality, now, algorithm,
        );
        const id = toNum(res.lastInsertRowid);
        indexToId.push(id);
        for (const fid of m.fileIds) insMember.run(fid, id);
      }
      for (const e of edges) {
        const f = indexToId[e.fromIndex];
        const t = indexToId[e.toIndex];
        if (f == null || t == null) continue;
        insEdge.run(f, t, e.kind, e.weight);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  hasModulesData(): boolean {
    if (!this.hasModuleTables) return false;
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS c FROM modules').get() as Row;
      return toNum(row.c) > 0;
    } catch { return false; }
  }

  countModules(): number {
    if (!this.hasModuleTables) return 0;
    try {
      return toNum((this.db.prepare('SELECT COUNT(*) AS c FROM modules').get() as Row).c);
    } catch { return 0; }
  }

  listModules(options: { limit?: number; sortBy?: 'centrality' | 'size' | 'label' } = {}): Array<{
    id: number; label: string; sizeFiles: number; sizeSymbols: number;
    primaryLanguage: string | null; cohesion: number; centrality: number;
  }> {
    if (!this.hasModuleTables) return [];
    const limit = options.limit ?? 100;
    const sortBy = options.sortBy ?? 'centrality';
    const order =
      sortBy === 'label' ? 'label ASC'
      : sortBy === 'size' ? 'size_files DESC, size_symbols DESC'
      : 'centrality DESC, size_files DESC';
    try {
      const rows = this.db.prepare(`
        SELECT id, label, size_files AS sizeFiles, size_symbols AS sizeSymbols,
               primary_language AS primaryLanguage, cohesion, centrality
        FROM modules
        ORDER BY ${order}
        LIMIT ?
      `).all(limit) as Row[];
      return rows.map(r => ({
        id: toNum(r.id),
        label: toStr(r.label),
        sizeFiles: toNum(r.sizeFiles),
        sizeSymbols: toNum(r.sizeSymbols),
        primaryLanguage: toNullStr(r.primaryLanguage),
        cohesion: Number(r.cohesion),
        centrality: Number(r.centrality),
      }));
    } catch { return []; }
  }

  getModuleById(id: number): {
    id: number; label: string; sizeFiles: number; sizeSymbols: number;
    primaryLanguage: string | null; cohesion: number; centrality: number;
  } | null {
    if (!this.hasModuleTables) return null;
    try {
      const row = this.db.prepare(`
        SELECT id, label, size_files AS sizeFiles, size_symbols AS sizeSymbols,
               primary_language AS primaryLanguage, cohesion, centrality
        FROM modules WHERE id = ?
      `).get(id) as Row | undefined;
      if (!row) return null;
      return {
        id: toNum(row.id),
        label: toStr(row.label),
        sizeFiles: toNum(row.sizeFiles),
        sizeSymbols: toNum(row.sizeSymbols),
        primaryLanguage: toNullStr(row.primaryLanguage),
        cohesion: Number(row.cohesion),
        centrality: Number(row.centrality),
      };
    } catch { return null; }
  }

  /** Module label → row. Used by CLI/MCP module lookups by name. */
  getModuleByLabel(label: string): {
    id: number; label: string; sizeFiles: number; sizeSymbols: number;
    primaryLanguage: string | null; cohesion: number; centrality: number;
  } | null {
    if (!this.hasModuleTables) return null;
    try {
      const row = this.db.prepare(`
        SELECT id, label, size_files AS sizeFiles, size_symbols AS sizeSymbols,
               primary_language AS primaryLanguage, cohesion, centrality
        FROM modules WHERE label = ?
      `).get(label) as Row | undefined;
      if (!row) return null;
      return {
        id: toNum(row.id),
        label: toStr(row.label),
        sizeFiles: toNum(row.sizeFiles),
        sizeSymbols: toNum(row.sizeSymbols),
        primaryLanguage: toNullStr(row.primaryLanguage),
        cohesion: Number(row.cohesion),
        centrality: Number(row.centrality),
      };
    } catch { return null; }
  }

  /**
   * Files in a module, sorted by file path. Returns empty array if the
   * module id doesn't exist or modules haven't been built.
   */
  listModuleMembers(moduleId: number, limit = 1000): Array<{
    fileId: number; path: string; relPath: string; language: string; role: string;
  }> {
    if (!this.hasModuleTables) return [];
    try {
      const rows = this.db.prepare(`
        SELECT f.id AS fileId, f.path, f.rel_path AS relPath, f.language, f.role
        FROM module_members mm
        JOIN files f ON f.id = mm.file_id
        WHERE mm.module_id = ?
        ORDER BY f.rel_path
        LIMIT ?
      `).all(moduleId, limit) as Row[];
      return rows.map(r => ({
        fileId: toNum(r.fileId), path: toStr(r.path), relPath: toStr(r.relPath),
        language: toStr(r.language), role: toStr(r.role),
      }));
    } catch { return []; }
  }

  /** Top symbols (by PageRank) inside a module. Useful for "what does this module own?" */
  listModuleTopSymbols(moduleId: number, limit = 20): SymbolRow[] {
    if (!this.hasModuleTables) return [];
    try {
      const rows = this.db.prepare(`
        SELECT ${symbolSelectCols(this.hasComplexityColumns, this.hasSymbolRoleColumn)}
        FROM symbols s
        JOIN files f ON f.id = s.file_id
        JOIN module_members mm ON mm.file_id = s.file_id
        WHERE mm.module_id = ? AND s.is_rankable = 1
        ORDER BY s.pagerank DESC
        LIMIT ?
      `).all(moduleId, limit) as Row[];
      return rows.map(toSymbolRow);
    } catch { return []; }
  }

  /** Module containing a file id, or null when the file has no membership row. */
  moduleForFile(fileId: number): { id: number; label: string } | null {
    if (!this.hasModuleTables) return null;
    try {
      const row = this.db.prepare(`
        SELECT m.id, m.label
        FROM module_members mm JOIN modules m ON m.id = mm.module_id
        WHERE mm.file_id = ?
      `).get(fileId) as Row | undefined;
      if (!row) return null;
      return { id: toNum(row.id), label: toStr(row.label) };
    } catch { return null; }
  }

  /**
   * Cross-module dependency edges. Direction is configurable:
   *   - 'out' (default) → modules this one depends on (from = moduleId)
   *   - 'in'            → modules that depend on this one (to = moduleId)
   * Aggregates across all edge kinds; the kind is preserved per row.
   */
  moduleDependencies(
    moduleId: number,
    options: { direction?: 'in' | 'out'; limit?: number } = {},
  ): Array<{
    moduleId: number; label: string; kind: string; weight: number;
  }> {
    if (!this.hasModuleTables) return [];
    const direction = options.direction ?? 'out';
    const limit = options.limit ?? 100;
    const sideThis = direction === 'out' ? 'from_module_id' : 'to_module_id';
    const sideOther = direction === 'out' ? 'to_module_id' : 'from_module_id';
    try {
      const rows = this.db.prepare(`
        SELECT m.id AS moduleId, m.label, me.kind, me.weight
        FROM module_edges me JOIN modules m ON m.id = me.${sideOther}
        WHERE me.${sideThis} = ?
        ORDER BY me.weight DESC
        LIMIT ?
      `).all(moduleId, limit) as Row[];
      return rows.map(r => ({
        moduleId: toNum(r.moduleId),
        label: toStr(r.label),
        kind: toStr(r.kind),
        weight: toNum(r.weight),
      }));
    } catch { return []; }
  }

  // ── Track-E: behavioral / risk helpers ──────────────────────────────────────

  /**
   * Raw 'tests' edges into a specific symbol id — id-scoped so short-name
   * siblings (`Alpha.run` / `Beta.run`) don't share a behavioral contract.
   * Returns the test-side caller info (name, file, line) so the ranker can
   * compute path-convention and naming-convention signals without
   * re-fetching.
   *
   * The id-based filter is correct because `synthesizeTestEdges()` now
   * preserves the source call edge's resolved `to_id` verbatim instead of
   * re-resolving via `WHERE name = edges.to_name LIMIT 1` (which collapsed
   * same-short-name symbols).
   */
  directTestEdgesForId(symbolId: number, limit = 200): Array<{
    callerId: number; callerName: string; callerQualifiedName: string | null;
    callerKind: string; callerFile: string; callerLineStart: number; callerLineEnd: number;
    edgeLine: number; assertionCount: number;
  }> {
    if (!this.hasV4Tables) return [];
    try {
      const rows = this.db.prepare(`
        SELECT
          s.id           AS callerId,
          s.name         AS callerName,
          s.qualified_name AS callerQualifiedName,
          s.kind         AS callerKind,
          f.path         AS callerFile,
          s.line_start   AS callerLineStart,
          s.line_end     AS callerLineEnd,
          e.line         AS edgeLine
        FROM edges e
        JOIN symbols s ON s.id = e.from_id
        JOIN files f ON f.id = s.file_id
        WHERE e.to_id = ? AND e.kind = 'tests'
        ORDER BY f.path, e.line
        LIMIT ?
      `).all(symbolId, limit) as Row[];
      return rows.map(r => ({
        callerId: toNum(r.callerId),
        callerName: toStr(r.callerName),
        callerQualifiedName: toNullStr(r.callerQualifiedName),
        callerKind: toStr(r.callerKind),
        callerFile: toStr(r.callerFile),
        callerLineStart: toNum(r.callerLineStart),
        callerLineEnd: toNum(r.callerLineEnd),
        edgeLine: toNum(r.edgeLine),
        // Computed in JS — needs the file contents.
        assertionCount: 0,
      }));
    } catch { return []; }
  }

  /**
   * HEURISTIC, name-based test sites for a method's short name.
   *
   * C/C++ member calls (`node->add_child(child)`) carry only the method's short
   * name in the call edge — tree-sitter can't infer the receiver's static type,
   * so the edge never resolves to the specific `Node.add_child` id and the
   * precise `directTestEdgesForId` pass misses it entirely. This returns the
   * test-file functions that call *some* method whose name matches, excluding
   * edges already resolved to `excludeId` (those are real direct coverage).
   *
   * Lower-confidence by construction: a `Tree.add_child` call matches too, so
   * the caller MUST surface these as clearly-labeled heuristic evidence, never
   * as resolved coverage. The precision path is a SCIP overlay that resolves
   * the receiver type and promotes these to real `tests` edges.
   */
  namedCallTestSites(name: string, excludeId: number, limit = 200): Array<{
    callerId: number; callerName: string; callerQualifiedName: string | null;
    callerKind: string; callerFile: string; callerLineStart: number; callerLineEnd: number;
    edgeLine: number;
  }> {
    if (!this.hasRoleColumns) return [];
    const variants = symbolNameVariants(name);
    const inPh = variants.map(() => '?').join(', ');
    try {
      const rows = this.db.prepare(`
        SELECT
          s.id             AS callerId,
          s.name           AS callerName,
          s.qualified_name AS callerQualifiedName,
          s.kind           AS callerKind,
          f.path           AS callerFile,
          s.line_start     AS callerLineStart,
          s.line_end       AS callerLineEnd,
          MIN(e.line)      AS edgeLine
        FROM edges e
        JOIN symbols s ON s.id = e.from_id
        JOIN files f ON f.id = s.file_id
        WHERE e.to_name IN (${inPh}) AND e.kind = 'call' AND f.role = 'test'
          AND s.kind IN ('function','method')
          AND (e.to_id IS NULL OR e.to_id <> ?)
        GROUP BY s.id
        ORDER BY f.path, edgeLine
        LIMIT ?
      `).all(...variants, excludeId, limit) as Row[];
      return rows.map(r => ({
        callerId: toNum(r.callerId),
        callerName: toStr(r.callerName),
        callerQualifiedName: toNullStr(r.callerQualifiedName),
        callerKind: toStr(r.callerKind),
        callerFile: toStr(r.callerFile),
        callerLineStart: toNum(r.callerLineStart),
        callerLineEnd: toNum(r.callerLineEnd),
        edgeLine: toNum(r.edgeLine),
      }));
    } catch { return []; }
  }

  /** True when the DB carries the file-role columns needed to classify tests. */
  hasTestRoleClassification(): boolean {
    return this.hasRoleColumns;
  }

  /** Count of files classified role='test' (0 when role columns are absent). */
  countTestFiles(): number {
    if (!this.hasRoleColumns) return 0;
    try {
      const row = this.db.prepare("SELECT COUNT(*) AS c FROM files WHERE role = 'test'").get() as Row;
      return toNum(row.c);
    } catch { return 0; }
  }

  /**
   * Workspace-level "has the per-symbol git history index been built?" summary,
   * git-HEAD-agnostic so context/preflight can surface `built` without needing
   * the workspace path (the MCP `seer_history` status adds live-HEAD staleness
   * on top). `built` is true when history rows exist OR the history-HEAD marker
   * was stamped — a repo with zero qualifying commits still counts as "built,
   * just empty", which is distinct from "never built".
   */
  getHistoryIndexInfo(): {
    built: boolean; rows: number;
    lastHistoryHeadSha: string | null; lastHistoryAt: number | null;
  } {
    if (!this.hasV4Tables) {
      return { built: false, rows: 0, lastHistoryHeadSha: null, lastHistoryAt: null };
    }
    let rows = 0;
    try {
      rows = toNum((this.db.prepare('SELECT COUNT(*) AS c FROM symbol_history').get() as Row).c);
    } catch { /* */ }
    const state = this.getGitIndexState();
    const builtHead = state?.lastHistoryHeadSha ?? null;
    return {
      built: rows > 0 || builtHead != null,
      rows,
      lastHistoryHeadSha: builtHead,
      lastHistoryAt: state?.lastHistoryAt ?? null,
    };
  }

  /**
   * Count how many distinct routes have this symbol as their resolved handler.
   * Used by seer_risk for the "route exposure" signal.
   */
  routesForHandler(symbolId: number): Array<{ method: string; path: string; framework: string }> {
    if (!this.hasV4Tables) return [];
    try {
      const rows = this.db.prepare(`
        SELECT method, path, framework
        FROM routes WHERE handler_id = ?
      `).all(symbolId) as Row[];
      return rows.map(r => ({
        method: toStr(r.method), path: toStr(r.path), framework: toStr(r.framework),
      }));
    } catch { return []; }
  }

  /** Distinct config keys read inside a symbol's body. */
  configKeysForSymbol(symbolId: number): Array<{ key: string; source: string; line: number }> {
    if (!this.hasV4Tables) return [];
    try {
      const rows = this.db.prepare(`
        SELECT DISTINCT key, source, line
        FROM config_keys WHERE symbol_id = ?
        ORDER BY line
      `).all(symbolId) as Row[];
      return rows.map(r => ({
        key: toStr(r.key), source: toStr(r.source), line: toNum(r.line),
      }));
    } catch { return []; }
  }

  /**
   * For each call edge OUT of a symbol, return the callee's module id (when
   * resolved). Used by seer_risk for the "module-boundary crossing" signal.
   * NULL module ids are filtered out — those are external/unresolved calls.
   */
  calleeModulesOf(symbolId: number): Array<{ calleeId: number; moduleId: number }> {
    if (!this.hasModuleTables) return [];
    try {
      const rows = this.db.prepare(`
        SELECT DISTINCT e.to_id AS calleeId, mm.module_id AS moduleId
        FROM edges e
        JOIN symbols s ON s.id = e.to_id
        JOIN module_members mm ON mm.file_id = s.file_id
        WHERE e.from_id = ? AND e.kind = 'call' AND e.to_id IS NOT NULL
      `).all(symbolId) as Row[];
      return rows.map(r => ({
        calleeId: toNum(r.calleeId), moduleId: toNum(r.moduleId),
      }));
    } catch { return []; }
  }

  /**
   * For each file id, return the symbols that match the given line ranges.
   * Used by `detect_changes` to compute the blast radius of a diff.
   */
  symbolsTouchingLines(fileId: number, lineRanges: Array<[number, number]>): SymbolRow[] {
    if (lineRanges.length === 0) return [];
    const clauses = lineRanges.map(() => '(s.line_start <= ? AND s.line_end >= ?)').join(' OR ');
    const args: Array<string | number | null> = [fileId];
    for (const [start, end] of lineRanges) {
      args.push(end);   // s.line_start <= rangeEnd
      args.push(start); // s.line_end >= rangeStart
    }
    const rows = this.db.prepare(`
      SELECT ${symbolSelectCols(this.hasComplexityColumns, this.hasSymbolRoleColumn)}
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.file_id = ? AND (${clauses})
      ORDER BY s.line_start
    `).all(...args) as Row[];
    return rows.map(toSymbolRow);
  }

  // ── Track-F: SCIP imports tracking ──────────────────────────────────────────

  /**
   * Record (or refresh) a SCIP import. Returns the row id. UNIQUE on
   * (path, sha256) — if the same file with the same content is re-imported,
   * the existing row is kept (the caller's idempotency guarantee).
   */
  recordScipImport(
    scipPath: string, sha256: string, tool: string | null,
    projectRoot: string | null, symbolCount: number, refCount: number,
  ): number {
    if (!this.hasV7Columns) return 0;
    const existing = this.db.prepare(
      'SELECT id FROM scip_imports WHERE path = ? AND sha256 = ?',
    ).get(scipPath, sha256) as Row | undefined;
    if (existing) {
      this.db.prepare(
        'UPDATE scip_imports SET imported_at = ?, tool = ?, project_root = ?, symbol_count = ?, ref_count = ? WHERE id = ?',
      ).run(Date.now(), tool, projectRoot, symbolCount, refCount, toNum(existing.id));
      return toNum(existing.id);
    }
    const res = this.db.prepare(
      'INSERT INTO scip_imports (path, sha256, tool, project_root, imported_at, symbol_count, ref_count) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(scipPath, sha256, tool, projectRoot, Date.now(), symbolCount, refCount);
    return toNum(res.lastInsertRowid);
  }

  /**
   * Has this exact SCIP file (by sha) been imported already? Lets callers
   * short-circuit a re-parse on no-op CI re-runs.
   */
  hasScipImport(scipPath: string, sha256: string): boolean {
    if (!this.hasV7Columns) return false;
    const row = this.db.prepare(
      'SELECT 1 FROM scip_imports WHERE path = ? AND sha256 = ?',
    ).get(scipPath, sha256) as Row | undefined;
    return row != null;
  }

  /** Listing for `seer_scip_imports` / the bundle manifest. */
  listScipImports(): Array<{
    id: number; path: string; sha256: string; tool: string | null;
    projectRoot: string | null; importedAt: number;
    symbolCount: number; refCount: number;
  }> {
    if (!this.hasV7Columns) return [];
    const rows = this.db.prepare(`
      SELECT id, path, sha256, tool, project_root AS projectRoot,
             imported_at AS importedAt, symbol_count AS symbolCount, ref_count AS refCount
      FROM scip_imports ORDER BY imported_at DESC
    `).all() as Row[];
    return rows.map(r => ({
      id: toNum(r.id), path: toStr(r.path), sha256: toStr(r.sha256),
      tool: toNullStr(r.tool), projectRoot: toNullStr(r.projectRoot),
      importedAt: toNum(r.importedAt),
      symbolCount: toNum(r.symbolCount), refCount: toNum(r.refCount),
    }));
  }

  /**
   * Insert (or upsert) a SCIP-sourced symbol. Returns the row id. Uses
   * (file_id, qualified_name, line_start, kind) as the dedup key when the
   * existing row was also SCIP-sourced — we never delete tree-sitter rows.
   * Tree-sitter rows with the same identifier and overlapping line range are
   * marked 'scip-merge' (precision confirmed by SCIP) instead of being
   * duplicated, so the agent-facing default lens stays compact.
   *
   * `scipImportId` is the `scip_imports.id` row this symbol came from — it
   * gets persisted on both fresh inserts and merge updates so a later
   * `clearScipProvenance(path)` can scope its wipe to a single layer instead
   * of nuking every SCIP row in the DB.
   */
  insertOrMergeScipSymbol(
    fileId: number, def: SymbolDef, scipImportId: number,
  ): { id: number; merged: boolean } {
    if (!this.hasV7Columns) {
      const id = this.insertSymbol(fileId, def);
      return { id, merged: false };
    }
    const qualified = def.qualifiedName ?? def.name;
    // Look for a tree-sitter row with the same qualified name and overlapping
    // line range — that's the "SCIP confirms our row" case.
    const existing = this.db.prepare(`
      SELECT id, provenance FROM symbols
      WHERE file_id = ?
        AND (qualified_name = ? OR name = ?)
        AND kind = ?
        AND line_start <= ?
        AND line_end >= ?
    `).get(
      fileId, qualified, def.name, def.kind,
      def.lineEnd, def.lineStart,
    ) as Row | undefined;

    if (existing) {
      const existingId = toNum(existing.id);
      const prov = toStr(existing.provenance);
      // tree-sitter rows get re-labeled scip-merge AND linked to the import
      // id, so clearScipProvenance(path) can demote them back. Pre-existing
      // scip-merge / scip rows keep their original import id so two different
      // SCIP layers confirming the same tree-sitter row don't fight over it.
      if (prov === 'tree-sitter') {
        this.db.prepare("UPDATE symbols SET provenance = 'scip-merge', scip_import_id = ? WHERE id = ?")
          .run(scipImportId, existingId);
      }
      // Stay using the existing id — SCIP-sourced references can point at it.
      return { id: existingId, merged: true };
    }

    // No overlap → insert a fresh SCIP-provenance row.
    const sig = def.signature ? def.signature.slice(0, 240) : null;
    const symbolKey = makeSymbolKey(def.kind, qualified);
    const res = this.db.prepare(`
      INSERT INTO symbols
        (name, qualified_name, kind, file_id, line_start, line_end, col_start, col_end,
         signature, is_rankable, loc, cyclomatic, cognitive, max_nesting, symbol_key, symbol_role, provenance, shape_hash, scip_import_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scip', NULL, ?)
    `).run(
      def.name, qualified, def.kind, fileId,
      def.lineStart, def.lineEnd,
      def.colStart, def.colEnd,
      sig,
      (isRankableKind(def.kind) ? 1 : 0),
      def.loc ?? null, def.cyclomatic ?? null,
      def.cognitive ?? null, def.maxNesting ?? null,
      symbolKey, 'definition',
      scipImportId,
    );
    return { id: toNum(res.lastInsertRowid), merged: false };
  }

  /**
   * Insert a SCIP-sourced reference edge. `to_id` is set immediately because
   * SCIP gives us precise targets — no need for the same-file/imported/global
   * fallback resolver used for tree-sitter call edges.
   *
   * `scipImportId` ties the edge to the contributing SCIP layer so per-layer
   * wipes are clean.
   */
  insertScipEdge(
    fromSymbolId: number, toSymbolId: number, toName: string, kind: string,
    line: number, scipImportId: number,
  ): void {
    if (!this.hasV7Columns) return;
    this.db.prepare(
      "INSERT INTO edges (from_id, to_name, to_id, kind, line, provenance, scip_import_id) VALUES (?, ?, ?, ?, ?, 'scip', ?)",
    ).run(fromSymbolId, toName, toSymbolId, kind, line, scipImportId);
  }

  /**
   * Wipe SCIP-sourced rows so a fresh import can replace them. Tree-sitter
   * rows are preserved; only the rows that came from the specified SCIP layer
   * are touched.
   *
   *   - scipPath omitted → ALL SCIP layers are wiped (every scip-provenance
   *     row is dropped, every scip-merge row demoted to tree-sitter, and
   *     the scip_imports table emptied). Useful for "I want my baseline
   *     back."
   *   - scipPath provided → only rows linked to scip_imports.id for that
   *     path are touched. Sibling layers stay intact. This is what
   *     importScip() calls before re-ingesting the same path, so a
   *     multi-layer setup (rust+ts SCIPs) stays correct on partial refresh.
   */
  clearScipProvenance(scipPath?: string): number {
    if (!this.hasV7Columns) return 0;
    let edgeDeletes = 0, symDeletes = 0;
    this.db.exec('BEGIN');
    try {
      if (scipPath == null) {
        // Global wipe — every SCIP layer collapses.
        this.db.exec("UPDATE symbols SET provenance = 'tree-sitter', scip_import_id = NULL WHERE provenance = 'scip-merge'");
        const eRes = this.db.prepare("DELETE FROM edges WHERE provenance = 'scip'").run();
        edgeDeletes = toNum(eRes.changes);
        const sRes = this.db.prepare("DELETE FROM symbols WHERE provenance = 'scip'").run();
        symDeletes = toNum(sRes.changes);
        this.db.exec('DELETE FROM scip_imports');
      } else {
        // Per-layer wipe — look up the import id for this path. If there's
        // no row, treat it as "nothing to do" rather than failing (callers
        // can blindly call clearScipProvenance(path) before insertion).
        const rows = this.db.prepare(
          'SELECT id FROM scip_imports WHERE path = ?',
        ).all(scipPath) as Row[];
        const ids = rows.map(r => toNum(r.id));
        if (ids.length > 0) {
          const ph = ids.map(() => '?').join(',');
          this.db.prepare(
            `UPDATE symbols SET provenance = 'tree-sitter', scip_import_id = NULL
             WHERE provenance = 'scip-merge' AND scip_import_id IN (${ph})`,
          ).run(...ids);
          const eRes = this.db.prepare(
            `DELETE FROM edges WHERE provenance = 'scip' AND scip_import_id IN (${ph})`,
          ).run(...ids);
          edgeDeletes = toNum(eRes.changes);
          const sRes = this.db.prepare(
            `DELETE FROM symbols WHERE provenance = 'scip' AND scip_import_id IN (${ph})`,
          ).run(...ids);
          symDeletes = toNum(sRes.changes);
          this.db.prepare('DELETE FROM scip_imports WHERE path = ?').run(scipPath);
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return symDeletes + edgeDeletes;
  }

  /** Provenance breakdown for `seer_health` / `seer_stats`. */
  getProvenanceCounts(): { symbols: Record<string, number>; edges: Record<string, number> } {
    const out = {
      symbols: { 'tree-sitter': 0, scip: 0, 'scip-merge': 0 } as Record<string, number>,
      edges:   { 'tree-sitter': 0, scip: 0, 'scip-merge': 0 } as Record<string, number>,
    };
    if (!this.hasV7Columns) return out;
    try {
      for (const r of this.db.prepare('SELECT provenance, COUNT(*) AS c FROM symbols GROUP BY provenance').all() as Row[]) {
        out.symbols[toStr(r.provenance)] = toNum(r.c);
      }
      for (const r of this.db.prepare('SELECT provenance, COUNT(*) AS c FROM edges GROUP BY provenance').all() as Row[]) {
        out.edges[toStr(r.provenance)] = toNum(r.c);
      }
    } catch { /* */ }
    return out;
  }

  // ── Track-F: shape-hash (structural SimHash) ────────────────────────────────

  /** Set a symbol's shape_hash. NULL clears it. Persisted as INTEGER. */
  setShapeHash(symbolId: number, hash: bigint | null): void {
    if (!this.hasV7Columns) return;
    // node:sqlite accepts bigint for INTEGER columns; convert to signed range.
    const value = hash == null ? null : toSignedI64(hash);
    this.db.prepare('UPDATE symbols SET shape_hash = ? WHERE id = ?').run(value, symbolId);
  }

  /**
   * Fetch all symbols that have a non-null shape_hash. Used as the candidate
   * pool for duplicate detection. Returns minimal fields to keep the working
   * set small on huge codebases.
   */
  listSymbolsWithShapeHash(opts: {
    minLoc?: number; includeTests?: boolean; limit?: number;
  } = {}): Array<{
    id: number; name: string; qualifiedName: string | null; kind: string;
    filePath: string; lineStart: number; lineEnd: number;
    loc: number | null; shapeHash: bigint;
  }> {
    if (!this.hasV7Columns) return [];
    const conds: string[] = ['s.shape_hash IS NOT NULL'];
    const args: Array<string | number> = [];
    if (opts.minLoc != null) {
      conds.push('s.loc >= ?');
      args.push(opts.minLoc);
    }
    if (opts.includeTests === false) {
      conds.push("f.role <> 'test'");
    }
    const limit = opts.limit ?? 50000;
    args.push(limit);
    const stmt = this.db.prepare(`
      SELECT s.id, s.name, s.qualified_name AS qualifiedName, s.kind,
             f.path AS filePath, s.line_start AS lineStart, s.line_end AS lineEnd,
             s.loc, s.shape_hash AS shapeHash
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE ${conds.join(' AND ')}
      ORDER BY s.id
      LIMIT ?
    `);
    // shape_hash regularly overflows JS safe-integer range; without this flag
    // node:sqlite throws on row materialization, which the outer try-catch
    // would swallow into an empty result. We opt the entire row into bigint
    // and convert the small-int columns back to plain numbers.
    try { stmt.setReadBigInts(true); } catch { /* */ }
    try {
      const rows = stmt.all(...args) as Row[];
      return rows.map(r => ({
        id: toNum(r.id),
        name: toStr(r.name),
        qualifiedName: toNullStr(r.qualifiedName),
        kind: toStr(r.kind),
        filePath: toStr(r.filePath),
        lineStart: toNum(r.lineStart),
        lineEnd: toNum(r.lineEnd),
        loc: toNullNum(r.loc),
        shapeHash: toUnsignedI64(r.shapeHash),
      }));
    } catch { return []; }
  }

  /** v7 read-flag accessor for downstream features that need to gate on it. */
  hasV7(): boolean { return this.hasV7Columns; }

  /**
   * Are there function-like symbols (kind function/method/constructor, role
   * not 'declaration', loc >= 4) that don't yet have a shape_hash? Used by
   * the indexer to decide whether to run buildShapeHashes() on a cached
   * re-run — when a pre-v7 DB migrates to v7, every existing row still has
   * shape_hash NULL even though the file is "cached" (its content hash
   * didn't change), so the normal graphChanged predicate misses the
   * backfill. This check catches that.
   */
  hasMissingShapeHashes(minLoc = 4): boolean {
    if (!this.hasV7Columns) return false;
    try {
      const row = this.db.prepare(`
        SELECT 1 FROM symbols
        WHERE shape_hash IS NULL
          AND kind IN ('function','method','constructor')
          AND symbol_role <> 'declaration'
          AND loc >= ?
        LIMIT 1
      `).get(minLoc) as Row | undefined;
      return row != null;
    } catch { return false; }
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  getStats(): StatsRow {
    const files = toNum((this.db.prepare('SELECT COUNT(*) AS c FROM files').get() as Row).c);
    const symbols = toNum((this.db.prepare('SELECT COUNT(*) AS c FROM symbols').get() as Row).c);
    const edges = toNum((this.db.prepare("SELECT COUNT(*) AS c FROM edges WHERE kind = 'call'").get() as Row).c);
    const resolvedEdges = toNum(
      (this.db.prepare("SELECT COUNT(*) AS c FROM edges WHERE to_id IS NOT NULL AND kind = 'call'").get() as Row).c
    );

    const langRows = this.db.prepare(
      'SELECT language, COUNT(*) AS c FROM files GROUP BY language'
    ).all() as Row[];
    const languages: Record<string, number> = {};
    for (const r of langRows) languages[toStr(r.language)] = toNum(r.c);

    let routes = 0, externalDependencies = 0, configKeys = 0, symbolHistory = 0, modules = 0;
    try { routes = this.countRoutes(); } catch { /* */ }
    try { externalDependencies = this.countExternalDeps(); } catch { /* */ }
    try { configKeys = this.countConfigKeys(); } catch { /* */ }
    try {
      if (this.hasV4Tables) {
        symbolHistory = toNum((this.db.prepare('SELECT COUNT(*) AS c FROM symbol_history').get() as Row).c);
      }
    } catch { /* */ }
    try { modules = this.countModules(); } catch { /* */ }

    // v7 extras — provenance breakdown and SCIP imports + shape_hash coverage.
    let scipImports = 0;
    let shapeHashed = 0;
    if (this.hasV7Columns) {
      try {
        scipImports = toNum((this.db.prepare('SELECT COUNT(*) AS c FROM scip_imports').get() as Row).c);
      } catch { /* */ }
      try {
        shapeHashed = toNum((this.db.prepare('SELECT COUNT(*) AS c FROM symbols WHERE shape_hash IS NOT NULL').get() as Row).c);
      } catch { /* */ }
    }

    // v8 Track G — service-link counts.
    let serviceCalls = 0;
    let serviceLinks = 0;
    try { serviceCalls = this.countServiceCalls(); } catch { /* */ }
    try { serviceLinks = this.countServiceLinks(); } catch { /* */ }

    return {
      files, symbols, edges, resolvedEdges, languages,
      roles: this.getRoleCounts(),
      routes,
      externalDependencies,
      configKeys,
      symbolHistory,
      modules,
      scipImports,
      shapeHashed,
      provenance: this.getProvenanceCounts(),
      serviceCalls,
      serviceLinks,
    };
  }

  /** Direct access to the underlying DB for niche callers (history indexer). */
  rawDb(): DatabaseSync { return this.db; }

  begin(): void { this.db.exec('BEGIN'); }
  commit(): void { this.db.exec('COMMIT'); }
  rollback(): void { this.db.exec('ROLLBACK'); }

  close(): void {
    this.db.close();
  }
}

function symbolSelectCols(hasComplexity: boolean, hasSymbolRole: boolean): string {
  let cols =
    `s.id, s.name, s.qualified_name AS qualifiedName, s.kind, s.file_id AS fileId,
     f.path AS filePath, s.line_start AS lineStart,
     s.line_end AS lineEnd, s.signature, s.pagerank`;
  if (hasComplexity)  cols += `, s.loc, s.cyclomatic, s.cognitive, s.max_nesting AS maxNesting`;
  if (hasSymbolRole)  cols += `, s.symbol_role AS symbolRole`;
  return cols;
}

function toSymbolRow(r: Row): SymbolRow {
  return {
    id: toNum(r.id),
    name: toStr(r.name),
    qualifiedName: toNullStr(r.qualifiedName),
    kind: toStr(r.kind),
    fileId: toNum(r.fileId),
    filePath: toStr(r.filePath),
    lineStart: toNum(r.lineStart),
    lineEnd: toNum(r.lineEnd),
    signature: toNullStr(r.signature),
    pagerank: toNum(r.pagerank),
    loc: toNullNum(r.loc),
    cyclomatic: toNullNum(r.cyclomatic),
    cognitive: toNullNum(r.cognitive),
    maxNesting: toNullNum(r.maxNesting),
    symbolRole: r.symbolRole == null ? null : (toStr(r.symbolRole) as 'definition' | 'declaration' | 'type_ref'),
  };
}

/**
 * Build a stable symbol-history key for a symbol. The shape is
 * `kind:qualified_name` — coarse on purpose so a function rename within a
 * file collapses history to the new name (we'd rather lose precision than
 * lose history entirely when extractors disagree about parameter shape).
 *
 * Future: include parameter arity or signature-hash for overload distinction.
 */
export function makeSymbolKey(kind: string, qualifiedName: string): string {
  return `${kind}:${qualifiedName}`;
}

/**
 * Lookup variants for a symbol query. Seer stores qualified names dot-joined
 * (`Node.add_child`), but agents routinely paste the source-language spelling —
 * C++/Rust `Node::add_child`. We never rewrite what's stored; instead we expand
 * the *query* into the equivalent spellings and match any of them.
 *
 * The original always comes first (so exact hits keep their order/ranking), and
 * a query with no `::` returns a single-element array — meaning every call site
 * stays byte-identical to the previous `= ?` / `LIKE ?` behavior unless the
 * input actually carried a `::`.
 *
 * The original is added unconditionally (even when empty), so the result is
 * never an empty array: callers build `IN (${variants.map(()=>'?')})`
 * placeholders, and `[]` would emit a syntactically invalid `IN ()`. An empty
 * input therefore yields `['']`, which is valid SQL that matches nothing.
 */
export function symbolNameVariants(name: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (v: string): void => {
    if (!seen.has(v)) { seen.add(v); out.push(v); }
  };
  add(name);
  // Seer normalizes C++/Rust qualified names to the dot form at index time, but
  // match BOTH directions so a lookup is robust to either spelling: a caller
  // passing `Node::add_child` resolves the stored `Node.add_child`, and a
  // `::`-form name from a SCIP import resolves a dotted query too.
  if (name.includes('::')) add(name.replace(/::/g, '.'));
  if (name.includes('.'))  add(name.replace(/\./g, '::'));
  return out;
}

/**
 * Build an FTS5 MATCH expression from a free-text query. Strategy:
 *   - normalize C++/Rust `::` to the dot form Seer stores
 *   - lower-case
 *   - split on whitespace and identifier punctuation
 *   - quote each non-empty token and OR them together with `*` for prefix
 *
 * Tokens that still carry a `:` are dropped: `splitIdentifierTokens` already
 * emits the clean sub-tokens, and a `"node::add_child"*` phrase leans on
 * tokenizer quirks (and can read as an FTS5 column filter) — neither belongs in
 * the MATCH expression.
 *
 * Empty / invalid → null (the caller falls back to LIKE).
 */
export function ftsQuery(input: string): string | null {
  if (!input) return null;
  const normalized = input.replace(/::/g, '.');
  const tokens = splitIdentifierTokens(normalized)
    .split(/\s+/)
    .filter(t => t.length > 0 && /^[a-z0-9]/i.test(t))
    .map(t => t.replace(/["'*]/g, ''))
    .filter(t => t.length > 0 && !t.includes(':'));
  if (tokens.length === 0) return null;
  return tokens.map(t => `"${t}"*`).join(' OR ');
}

// ── Import path resolution ───────────────────────────────────────────────────

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

const TS_JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

function resolveImportToFileId(
  fromPath: string,
  language: string,
  importName: string,
  fileByPath: Map<string, number>,
): number | null {
  if (language === 'typescript' || language === 'javascript') {
    return resolveJsImport(fromPath, importName, fileByPath);
  }
  if (language === 'python') {
    return resolvePythonImport(fromPath, importName, fileByPath);
  }
  return null;
}

function resolveJsImport(
  fromPath: string,
  importName: string,
  fileByPath: Map<string, number>,
): number | null {
  if (!importName.startsWith('./') && !importName.startsWith('../')) return null;

  const fromDir = path.dirname(fromPath);
  const target = path.resolve(fromDir, importName);

  const ext = path.extname(target);
  if (ext && TS_JS_EXTS.includes(ext)) {
    const id = fileByPath.get(normalizePath(target));
    if (id !== undefined) return id;
  }

  for (const e of TS_JS_EXTS) {
    const id = fileByPath.get(normalizePath(target + e));
    if (id !== undefined) return id;
  }

  for (const e of TS_JS_EXTS) {
    const id = fileByPath.get(normalizePath(path.join(target, 'index' + e)));
    if (id !== undefined) return id;
  }

  return null;
}

function resolvePythonImport(
  fromPath: string,
  importName: string,
  fileByPath: Map<string, number>,
): number | null {
  if (!importName.startsWith('.')) return null;

  let levelsUp = 0;
  while (levelsUp < importName.length && importName[levelsUp] === '.') {
    levelsUp++;
  }
  const modulePath = importName.slice(levelsUp);

  if (modulePath.length === 0) return null;

  let baseDir = path.dirname(fromPath);
  for (let i = 1; i < levelsUp; i++) {
    baseDir = path.dirname(baseDir);
  }

  const parts = modulePath.split('.');
  const target = path.join(baseDir, ...parts);

  const fileCandidate = fileByPath.get(normalizePath(target + '.py'));
  if (fileCandidate !== undefined) return fileCandidate;

  const pkgCandidate = fileByPath.get(normalizePath(path.join(target, '__init__.py')));
  if (pkgCandidate !== undefined) return pkgCandidate;

  return null;
}
