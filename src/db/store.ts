import path from 'path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { CURRENT_SCHEMA_VERSION, SCHEMA_SQL } from './schema.js';
import type {
  SymbolDef, SymbolKind, SymbolRow, CallerRow, CalleeRow, StatsRow,
  RouteRow, ExternalDepRow, ConfigKeyRow, FileChurnRow, SymbolHistoryRow,
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

export function isRankableKind(kind: string): boolean {
  return RANKABLE_KINDS.has(kind as SymbolKind);
}

// Typed wrapper around node:sqlite rows (which use null prototypes)
type Row = Record<string, unknown>;

function toNum(v: unknown): number { return Number(v); }
function toStr(v: unknown): string { return String(v ?? ''); }
function toNullStr(v: unknown): string | null { return v == null ? null : String(v); }
function toNullNum(v: unknown): number | null { return v == null ? null : Number(v); }

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
}

function buildRoleFilter(
  prefix: string,
  includeVendor: boolean,
  includeGenerated: boolean,
  hasRoleColumns: boolean,
): string {
  if (!hasRoleColumns) return '';
  const clauses: string[] = [];
  if (!includeVendor)    clauses.push(`${prefix}is_vendor = 0`);
  if (!includeGenerated) clauses.push(`${prefix}is_generated = 0`);
  return clauses.length === 0 ? '' : 'AND ' + clauses.join(' AND ');
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

  // Prepared statements — initialized in constructor (writer path only)
  private stmtUpsertFile!: StatementSync;
  private stmtInsertSymbol!: StatementSync;
  private stmtInsertEdge!: StatementSync;
  private stmtInsertFileImport!: StatementSync;
  private stmtInsertRoute!: StatementSync;
  private stmtInsertConfigKey!: StatementSync;
  private stmtInsertExternalDep!: StatementSync;
  private stmtInsertSymbolsFts!: StatementSync;
  private stmtInsertFilesFts!: StatementSync;
  private stmtDeleteSymbolsFtsForFile!: StatementSync;
  private stmtDeleteFilesFtsForFile!: StatementSync;

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
      this.runMigrations();
      this.prepare();
    }
    this.cachedSchemaInfo = this.readSchemaInfo();
    this.hasRoleColumns = this.checkHasRoleColumns();
    this.hasComplexityColumns = this.hasColumn('symbols', 'cyclomatic');
    this.hasV4Tables = this.checkHasV4Tables();
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

  schemaInfo(): SchemaInfo { return this.cachedSchemaInfo; }

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

    // v4.1: separate history HEAD marker so churn doesn't poison the
    // skip-if-unchanged check used by buildSymbolHistory. Cheap ALTER ADD;
    // existing DBs get NULL which forces history to run on next invocation.
    this.addColumnIfMissing('git_index_state', 'last_history_head_sha', 'TEXT');
    this.addColumnIfMissing('git_index_state', 'last_history_at',       'INTEGER');

    // v4 backfill — required because upsertFileWithCache() short-circuits on
    // unchanged content hash, so a v3 DB upgraded to v4 would never get
    // symbol_key populated (nor FTS rebuilt) for any file whose source hadn't
    // changed. That left strata_history with zero candidates and FTS search
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
   * only safe trigger condition — Strata never deliberately leaves FTS empty
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
         signature, is_rankable, loc, cyclomatic, cognitive, max_nesting, symbol_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtInsertEdge = this.db.prepare(`
      INSERT INTO edges (from_id, to_name, kind, line) VALUES (?, ?, ?, ?)
    `);

    this.stmtInsertFileImport = this.db.prepare(`
      INSERT OR IGNORE INTO file_imports (from_file_id, import_name) VALUES (?, ?)
    `);

    this.stmtInsertRoute = this.db.prepare(`
      INSERT INTO routes (file_id, method, path, framework, handler_name, line)
      VALUES (?, ?, ?, ?, ?, ?)
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
  }

  // ── Write operations ────────────────────────────────────────────────────────

  pruneFilesNotIn(keepIds: Set<number>): number {
    if (keepIds.size === 0) {
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
    const existing = this.db.prepare('SELECT id FROM files WHERE path = ?').get(path) as Row | undefined;
    if (existing) {
      const fileId = toNum(existing.id);
      // Wipe FTS rows + dependent table rows for this file
      try { this.stmtDeleteSymbolsFtsForFile.run(fileId); } catch { /* */ }
      this.db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
      this.db.prepare('DELETE FROM file_imports WHERE from_file_id = ?').run(fileId);
      this.db.prepare('DELETE FROM routes WHERE file_id = ?').run(fileId);
      this.db.prepare('DELETE FROM config_keys WHERE file_id = ?').run(fileId);
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
    const sig = def.signature ? def.signature.slice(0, 240) : null;
    const qualified = def.qualifiedName ?? def.name;
    const rankable = isRankableKind(def.kind) ? 1 : 0;
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
    this.stmtInsertEdge.run(fromSymbolId, toName, kind, line);
  }

  insertFileImport(fromFileId: number, importName: string): void {
    this.stmtInsertFileImport.run(fromFileId, importName);
  }

  insertRoute(
    fileId: number, method: string, routePath: string, framework: string,
    handlerName: string | null, line: number,
  ): void {
    this.stmtInsertRoute.run(fileId, method, routePath, framework, handlerName, line);
  }

  insertConfigKey(
    key: string, source: string, fileId: number,
    symbolId: number | null, line: number,
  ): void {
    this.stmtInsertConfigKey.run(key, source, fileId, symbolId, line);
  }

  insertExternalDep(
    ecosystem: string, name: string, versionRange: string | null,
    manifestPath: string, isDev: 0 | 1,
  ): void {
    this.stmtInsertExternalDep.run(ecosystem, name, versionRange, manifestPath, isDev);
  }

  clearExternalDeps(): void {
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
   * test edges live in their own kind so `strata_behavior` can pull them
   * directly without scanning the full edge table.
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
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        this.stmtInsertEdge.run(toNum(r.from_id), toStr(r.to_name), 'tests', toNum(r.line));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    // Resolve the to_id on the new test edges. `synthesizeTestEdges` re-runs
    // every index pass and only inserts non-duplicate rows, so this is cheap.
    this.db.prepare(`
      UPDATE edges SET to_id = (
        SELECT id FROM symbols WHERE name = edges.to_name LIMIT 1
      )
      WHERE kind = 'tests' AND to_id IS NULL
    `).run();
    return rows.length;
  }

  // ── Read operations ─────────────────────────────────────────────────────────

  findCallers(symbolName: string, limit?: number): CallerRow[] {
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
        WHERE e.to_name = ? AND e.kind = 'call'
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
        WHERE e.to_name = ? AND e.kind = 'call'
        ORDER BY f.path, e.line
      `;
    const stmt = this.db.prepare(sql);
    const rows = (hasLimit
      ? stmt.all(symbolName, limit)
      : stmt.all(symbolName)) as Row[];

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
    const row = this.db.prepare(
      "SELECT COUNT(*) AS c FROM edges WHERE to_name = ? AND kind = 'call'",
    ).get(symbolName) as Row;
    return toNum(row.c);
  }

  findCallees(symbolName: string): CalleeRow[] {
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
      WHERE s.name = ? AND e.kind = 'call'
      ORDER BY e.line
    `).all(symbolName) as Row[];

    return rows.map(r => ({
      calleeName: toStr(r.calleeName),
      calleeKind: toNullStr(r.calleeKind),
      calleeFile: toNullStr(r.calleeFile),
      calleeLineStart: toNullNum(r.calleeLineStart),
      edgeKind: toStr(r.edgeKind),
    }));
  }

  findSymbols(name: string, options: SymbolSearchOptions = {}): SymbolRow[] {
    const limit = Math.max(1, options.limit ?? 50);
    const includeVendor = options.includeVendor ?? false;
    const includeGenerated = options.includeGenerated ?? false;
    const filter = buildRoleFilter('f.', includeVendor, includeGenerated, this.hasRoleColumns);
    const rows = this.db.prepare(`
      SELECT ${symbolSelectCols(this.hasComplexityColumns)}
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE (s.name LIKE ? OR s.qualified_name LIKE ?)
        ${filter}
      ORDER BY s.pagerank DESC
      LIMIT ?
    `).all(`%${name}%`, `%${name}%`, limit) as Row[];

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
    const filter = buildRoleFilter('f.',
      options.includeVendor ?? false,
      options.includeGenerated ?? false,
      this.hasRoleColumns,
    );
    try {
      const rows = this.db.prepare(`
        SELECT ${symbolSelectCols(this.hasComplexityColumns)},
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
  searchFilesFts(query: string, limit = 30): Array<{ id: number; path: string; relPath: string; language: string; role: string }> {
    if (!this.hasV4Tables) return [];
    const matchExpr = ftsQuery(query);
    if (!matchExpr) return [];
    try {
      const rows = this.db.prepare(`
        SELECT f.id, f.path, f.rel_path AS relPath, f.language, f.role
        FROM files_fts
        JOIN files f ON f.id = files_fts.rowid
        WHERE files_fts MATCH ?
        ORDER BY bm25(files_fts)
        LIMIT ?
      `).all(matchExpr, limit) as Row[];
      return rows.map(r => ({
        id: toNum(r.id),
        path: toStr(r.path),
        relPath: toStr(r.relPath),
        language: toStr(r.language),
        role: toStr(r.role),
      }));
    } catch { return []; }
  }

  listSymbolsInFile(filePath: string, limit = 200): SymbolRow[] {
    const rows = this.db.prepare(`
      SELECT ${symbolSelectCols(this.hasComplexityColumns)}
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE f.path = ? OR f.rel_path = ?
      ORDER BY s.line_start
      LIMIT ?
    `).all(filePath, filePath, limit) as Row[];

    return rows.map(toSymbolRow);
  }

  getTopSymbols(limit = 20, options: { includeVendor?: boolean; includeGenerated?: boolean } = {}): SymbolRow[] {
    const includeVendor = options.includeVendor ?? false;
    const includeGenerated = options.includeGenerated ?? false;
    const filter = buildRoleFilter('f.', includeVendor, includeGenerated, this.hasRoleColumns);
    const where = filter ? `WHERE ${filter.replace(/^AND\s+/, '')}` : '';
    const rows = this.db.prepare(`
      SELECT ${symbolSelectCols(this.hasComplexityColumns)}
      FROM symbols s JOIN files f ON f.id = s.file_id
      ${where}
      ORDER BY s.pagerank DESC
      LIMIT ?
    `).all(limit) as Row[];

    return rows.map(toSymbolRow);
  }

  getDefinition(name: string, options: { filePath?: string; includeVendor?: boolean; includeGenerated?: boolean } = {}): SymbolRow[] {
    const filter = buildRoleFilter('f.', options.includeVendor ?? false, options.includeGenerated ?? false, this.hasRoleColumns);
    const fileClause = options.filePath ? 'AND (f.path = ? OR f.rel_path = ?)' : '';
    const stmt = this.db.prepare(`
      SELECT ${symbolSelectCols(this.hasComplexityColumns)}
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE (s.name = ? OR s.qualified_name = ?)
        ${filter}
        ${fileClause}
      ORDER BY s.pagerank DESC
      LIMIT 50
    `);
    const rows = (options.filePath
      ? stmt.all(name, name, options.filePath, options.filePath)
      : stmt.all(name, name)) as Row[];

    return rows.map(toSymbolRow);
  }

  getSymbolById(id: number): SymbolRow | null {
    const row = this.db.prepare(`
      SELECT ${symbolSelectCols(this.hasComplexityColumns)}
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.id = ?
    `).get(id) as Row | undefined;
    return row ? toSymbolRow(row) : null;
  }

  countSymbols(name: string, options: { includeVendor?: boolean; includeGenerated?: boolean } = {}): number {
    const filter = buildRoleFilter('f.', options.includeVendor ?? false, options.includeGenerated ?? false, this.hasRoleColumns);
    const row = this.db.prepare(`
      SELECT COUNT(*) AS c
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE (s.name LIKE ? OR s.qualified_name LIKE ?) ${filter}
    `).get(`%${name}%`, `%${name}%`) as Row;
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

  listRoutes(options: { method?: string; pathSubstr?: string; framework?: string; limit?: number } = {}): RouteRow[] {
    if (!this.hasV4Tables) return [];
    const where: string[] = [];
    const args: Array<string | number | null> = [];
    if (options.method)    { where.push('r.method = ?');           args.push(options.method.toUpperCase()); }
    if (options.pathSubstr){ where.push('r.path LIKE ?');          args.push(`%${options.pathSubstr}%`); }
    if (options.framework) { where.push('r.framework = ?');        args.push(options.framework); }
    const limit = options.limit ?? 200;
    const sql = `
      SELECT r.id, r.method, r.path, r.framework, r.handler_name AS handlerName,
             r.handler_id AS handlerId,
             s.qualified_name AS handlerSymbol,
             sf.path AS handlerFile,
             f.path AS filePath, r.line
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
    }));
  }

  countRoutes(): number {
    if (!this.hasV4Tables) return 0;
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM routes').get() as Row;
    return toNum(row.c);
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
    this.db.prepare(`
      INSERT OR IGNORE INTO symbol_history
        (symbol_id, symbol_key, commit_sha, author_name, author_email, committed_at, message,
         lines_added, lines_removed, pr_number, pr_url, match_strategy, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(symbolId, symbolKey, commitSha, authorName, authorEmail, committedAt, message,
           linesAdded, linesRemoved, prNumber, prUrl, matchStrategy, confidence);
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
  } | null {
    if (!this.hasV4Tables) return null;
    const row = this.db.prepare(
      `SELECT repo_root AS repoRoot, last_head_sha AS lastHeadSha,
              last_processed_at AS lastProcessedAt, remote_url AS remoteUrl,
              algorithm_version AS algorithmVersion,
              last_history_head_sha AS lastHistoryHeadSha,
              last_history_at AS lastHistoryAt
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
  setHistoryHeadSha(repoRoot: string, lastHistoryHeadSha: string | null, remoteUrl: string | null): void {
    // Upsert: insert a fresh row if churn hasn't run yet; otherwise just
    // update the history columns. repo_root + remote_url are kept in sync
    // either way so the row stays self-describing.
    this.db.prepare(`
      INSERT INTO git_index_state
        (id, repo_root, last_processed_at, remote_url, algorithm_version,
         last_history_head_sha, last_history_at)
      VALUES (1, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        repo_root = excluded.repo_root,
        remote_url = COALESCE(excluded.remote_url, git_index_state.remote_url),
        last_history_head_sha = excluded.last_history_head_sha,
        last_history_at = excluded.last_history_at
    `).run(repoRoot, Date.now(), remoteUrl, lastHistoryHeadSha, Date.now());
  }

  /** All symbols matching a symbol_key — used by `strata_history` to find the
   *  current id for a key that came from the indexed graph. */
  findSymbolsByKey(symbolKey: string): SymbolRow[] {
    const rows = this.db.prepare(`
      SELECT ${symbolSelectCols(this.hasComplexityColumns)}
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.symbol_key = ?
      ORDER BY s.pagerank DESC
    `).all(symbolKey) as Row[];
    return rows.map(toSymbolRow);
  }

  /** Iterate over (id, file_id, line_start, line_end, symbol_key) — used by
   *  the symbol-history indexer to map historical line ranges to current ids. */
  listSymbolsForHistoryIndex(): Array<{ id: number; fileId: number; filePath: string; relPath: string; lineStart: number; lineEnd: number; symbolKey: string }> {
    const rows = this.db.prepare(`
      SELECT s.id, s.file_id AS fileId, f.path AS filePath, f.rel_path AS relPath,
             s.line_start AS lineStart, s.line_end AS lineEnd, s.symbol_key AS symbolKey
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.symbol_key IS NOT NULL
        AND s.kind IN ('function','method','constructor','class')
    `).all() as Row[];
    return rows.map(r => ({
      id: toNum(r.id), fileId: toNum(r.fileId),
      filePath: toStr(r.filePath), relPath: toStr(r.relPath),
      lineStart: toNum(r.lineStart), lineEnd: toNum(r.lineEnd),
      symbolKey: toStr(r.symbolKey),
    }));
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
      SELECT ${symbolSelectCols(this.hasComplexityColumns)}
      FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.file_id = ? AND (${clauses})
      ORDER BY s.line_start
    `).all(...args) as Row[];
    return rows.map(toSymbolRow);
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

    let routes = 0, externalDependencies = 0, configKeys = 0, symbolHistory = 0;
    try { routes = this.countRoutes(); } catch { /* */ }
    try { externalDependencies = this.countExternalDeps(); } catch { /* */ }
    try { configKeys = this.countConfigKeys(); } catch { /* */ }
    try {
      if (this.hasV4Tables) {
        symbolHistory = toNum((this.db.prepare('SELECT COUNT(*) AS c FROM symbol_history').get() as Row).c);
      }
    } catch { /* */ }

    return {
      files, symbols, edges, resolvedEdges, languages,
      roles: this.getRoleCounts(),
      routes,
      externalDependencies,
      configKeys,
      symbolHistory,
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

function symbolSelectCols(hasComplexity: boolean): string {
  const base =
    `s.id, s.name, s.qualified_name AS qualifiedName, s.kind, s.file_id AS fileId,
     f.path AS filePath, s.line_start AS lineStart,
     s.line_end AS lineEnd, s.signature, s.pagerank`;
  if (!hasComplexity) return base;
  return `${base}, s.loc, s.cyclomatic, s.cognitive, s.max_nesting AS maxNesting`;
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
 * Build an FTS5 MATCH expression from a free-text query. Strategy:
 *   - lower-case
 *   - split on whitespace and identifier punctuation
 *   - quote each non-empty token and OR them together with `*` for prefix
 *
 * Empty / invalid → null (the caller falls back to LIKE).
 */
export function ftsQuery(input: string): string | null {
  if (!input) return null;
  const tokens = splitIdentifierTokens(input)
    .split(/\s+/)
    .filter(t => t.length > 0 && /^[a-z0-9]/i.test(t))
    .map(t => t.replace(/["'*]/g, ''))
    .filter(t => t.length > 0);
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
