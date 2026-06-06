// Pure, connection-free helpers and shared types for the Store.
//
// Everything here is stateless: value coercion, identifier tokenization, SQL
// fragment builders, row mappers, and import-path resolution. The Store class
// (store.ts) and the migration routines (store-migrations.ts) import from here.
// Keeping these out of store.ts is what lets that file stay focused on the
// stateful, prepared-statement-backed query/write surface.

import path from 'path';
import type { SymbolKind, SymbolRow } from '../types.js';

/** Typed wrapper around node:sqlite rows (which use null prototypes). */
export type Row = Record<string, unknown>;

export function toNum(v: unknown): number { return Number(v); }
export function toStr(v: unknown): string { return String(v ?? ''); }
export function toNullStr(v: unknown): string | null { return v == null ? null : String(v); }
export function toNullNum(v: unknown): number | null { return v == null ? null : Number(v); }

/** Escape SQLite LIKE metacharacters (`%`, `_`, `\`) for use with ESCAPE '\'.
 *  Lets a literal filename like `bom_crlf.ts` match without `_` acting as a
 *  single-char wildcard. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, m => '\\' + m);
}

/**
 * Convert a 64-bit unsigned bigint shape hash into a signed bigint suitable
 * for storage in an SQLite INTEGER column. We treat the high bit as the sign,
 * so `0x8000_0000_0000_0000` and above wrap into negative values; this round-
 * trips losslessly with `toUnsignedI64` below.
 */
export function toSignedI64(u: bigint): bigint {
  const MAX_I64 = 0x7FFFFFFFFFFFFFFFn;
  return u > MAX_I64 ? u - 0x10000000000000000n : u;
}
export function toUnsignedI64(v: unknown): bigint {
  if (v == null) return 0n;
  const b = typeof v === 'bigint' ? v : BigInt(Number(v));
  return b < 0n ? b + 0x10000000000000000n : b;
}

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
 * Build the per-table predicate clauses for the default project-first lens.
 * Used by `findSymbols` / `getDefinition` / `getTopSymbols` / `countSymbols`
 * and the MCP tool wrappers around them. Each `include*` flag turns OFF the
 * corresponding restriction.
 *
 * The function is forgiving about pre-v4 / pre-v5 DBs: when the role columns
 * or the symbol_role column don't exist on disk, the corresponding clauses
 * are simply dropped so a read-only open against an old index keeps working.
 */
export function buildRoleFilter(
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
export function resolveSearchFlags(opts: SymbolSearchOptions): {
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

export function symbolSelectCols(hasComplexity: boolean, hasSymbolRole: boolean): string {
  let cols =
    `s.id, s.name, s.qualified_name AS qualifiedName, s.kind, s.file_id AS fileId,
     f.path AS filePath, s.line_start AS lineStart,
     s.line_end AS lineEnd, s.signature, s.pagerank`;
  if (hasComplexity)  cols += `, s.loc, s.cyclomatic, s.cognitive, s.max_nesting AS maxNesting`;
  if (hasSymbolRole)  cols += `, s.symbol_role AS symbolRole`;
  return cols;
}

export function toSymbolRow(r: Row): SymbolRow {
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

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

const TS_JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

export function resolveImportToFileId(
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
