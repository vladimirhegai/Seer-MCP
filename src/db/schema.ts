// SQL DDL for the Strata graph database

// Current schema version. Bumped whenever the table layout or column meanings
// change in a way that older code can't read transparently. Stored on the
// `_schema_meta` table; the Store checks it on open and runs migrations to
// catch up. ALTER TABLE ADD COLUMN additions don't bump this version — they
// are detected via PRAGMA table_info() and applied unconditionally for back
// compat with DBs older than schema-version tracking itself.
//
// v4 brings Track-C enrichment + Track-D symbol history:
//   - routes, external_dependencies, config_keys
//   - symbol complexity metrics columns
//   - file_churn (file-level git stats)
//   - symbol_history + git_index_state (per-symbol commit chains)
//   - FTS5 virtual table over symbols for BM25 search
export const CURRENT_SCHEMA_VERSION = 4;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS _schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id           INTEGER PRIMARY KEY,
  path         TEXT    NOT NULL UNIQUE,
  rel_path     TEXT    NOT NULL,
  language     TEXT    NOT NULL,
  hash         TEXT    NOT NULL,
  lines        INTEGER NOT NULL DEFAULT 0,
  indexed_at   INTEGER NOT NULL,
  -- Project-owned / vendored / generated / test / docs classification. Used
  -- so ranking and search default to project-owned code while keeping vendor
  -- and generated code inspectable when explicitly included.
  --   'project'   — first-party application/library code (default)
  --   'vendor'    — vendored third-party deps left untouched (./vendor, /vendored, etc.)
  --   'generated' — machine-emitted boilerplate (*.generated.h, *.pb.cc, etc.)
  --   'test'      — files inside test directories
  role         TEXT    NOT NULL DEFAULT 'project',
  -- Convenience boolean projections of role, indexed independently so
  -- predicates like "exclude vendored unless explicitly included" are cheap.
  is_vendor    INTEGER NOT NULL DEFAULT 0,
  is_generated INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_files_role         ON files(role);
CREATE INDEX IF NOT EXISTS idx_files_is_vendor    ON files(is_vendor);
CREATE INDEX IF NOT EXISTS idx_files_is_generated ON files(is_generated);

CREATE TABLE IF NOT EXISTS symbols (
  id             INTEGER PRIMARY KEY,
  name           TEXT    NOT NULL,
  qualified_name TEXT,
  kind           TEXT    NOT NULL,
  file_id        INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  line_start     INTEGER NOT NULL DEFAULT 0,
  line_end       INTEGER NOT NULL DEFAULT 0,
  col_start      INTEGER NOT NULL DEFAULT 0,
  col_end        INTEGER NOT NULL DEFAULT 0,
  signature      TEXT,
  pagerank       REAL    NOT NULL DEFAULT 0.15,
  -- 1 when this symbol participates in PageRank, top-N ranking, and the
  -- agent-facing default symbol list. Functions/methods/constructors/classes
  -- are rankable; structs/enums/types/interfaces/variables are not.
  is_rankable    INTEGER NOT NULL DEFAULT 1,
  -- v4 Complexity columns. Populated by the language extractor for
  -- function/method/constructor symbols; NULL for types/classes.
  --
  -- loc:        lines of code (line_end - line_start + 1; non-blank)
  -- cyclomatic: McCabe complexity (1 + branch count)
  -- cognitive:  cognitive complexity (penalizes nesting)
  -- max_nesting: deepest nested control-flow depth inside the body
  loc            INTEGER,
  cyclomatic     INTEGER,
  cognitive      INTEGER,
  max_nesting    INTEGER,
  -- v4 Symbol identity key for git history matching across line moves. Built
  -- as kind:qualified_name(arity?) so a function rename keeps history as long
  -- as the qualified name stays the same. NOT unique - duplicate keys are
  -- possible across files; symbol_history is keyed by (symbol_id, symbol_key).
  symbol_key     TEXT
);

CREATE INDEX IF NOT EXISTS idx_symbols_name           ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_qualified_name ON symbols(qualified_name);
CREATE INDEX IF NOT EXISTS idx_symbols_file_id        ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_pagerank       ON symbols(pagerank DESC);
-- v3+ indexes (idx_symbols_is_rankable, idx_symbols_symbol_key) live in
-- runMigrations because they target columns that don't exist on pre-v3/v4
-- DBs; trying to create them here on an upgrade would fail before the
-- ALTER TABLE ADD COLUMN runs.

-- from_id calls/references to_name; to_id is resolved after full index
CREATE TABLE IF NOT EXISTS edges (
  id       INTEGER PRIMARY KEY,
  from_id  INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  to_name  TEXT    NOT NULL,
  to_id    INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  kind     TEXT    NOT NULL DEFAULT 'call',
  line     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_edges_from    ON edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to_name ON edges(to_name);
CREATE INDEX IF NOT EXISTS idx_edges_to_id   ON edges(to_id);
CREATE INDEX IF NOT EXISTS idx_edges_kind    ON edges(kind);

-- File-level imports. resolved_file_id is populated by a post-index pass
-- when the imported module can be mapped to a file we've also indexed.
CREATE TABLE IF NOT EXISTS file_imports (
  id               INTEGER PRIMARY KEY,
  from_file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  import_name      TEXT    NOT NULL,
  resolved_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_file_imports_from     ON file_imports(from_file_id);
CREATE INDEX IF NOT EXISTS idx_file_imports_resolved ON file_imports(resolved_file_id);

-- v4 routes table. One row per HTTP route detected in source. Handlers are
-- linked by symbol_id when resolvable (extractor sees the handler name in the
-- same file), otherwise handler_name is filled in and the post-pass leaves
-- handler_id NULL.
CREATE TABLE IF NOT EXISTS routes (
  id              INTEGER PRIMARY KEY,
  file_id         INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  method          TEXT    NOT NULL,
  path            TEXT    NOT NULL,
  framework       TEXT    NOT NULL,
  handler_name    TEXT,
  handler_id      INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  line            INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_routes_method     ON routes(method);
CREATE INDEX IF NOT EXISTS idx_routes_path       ON routes(path);
CREATE INDEX IF NOT EXISTS idx_routes_file_id    ON routes(file_id);
CREATE INDEX IF NOT EXISTS idx_routes_framework  ON routes(framework);
CREATE INDEX IF NOT EXISTS idx_routes_handler_id ON routes(handler_id);

-- v4 external dependencies extracted from package manifests/lockfiles.
-- Each row represents one dependency entry; (manifest_file, name) is unique.
-- ecosystem ∈ {npm, cargo, pypi, maven, gradle, go}
CREATE TABLE IF NOT EXISTS external_dependencies (
  id              INTEGER PRIMARY KEY,
  ecosystem       TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  version_range   TEXT,
  manifest_path   TEXT    NOT NULL,
  is_dev          INTEGER NOT NULL DEFAULT 0,
  UNIQUE(ecosystem, name, manifest_path)
);

CREATE INDEX IF NOT EXISTS idx_extdeps_name      ON external_dependencies(name);
CREATE INDEX IF NOT EXISTS idx_extdeps_ecosystem ON external_dependencies(ecosystem);

-- v4 config keys read by source. Each row is a static read of an env var or
-- config key. symbol_id is the enclosing function/method when the read happens
-- inside one; NULL for module-level reads.
CREATE TABLE IF NOT EXISTS config_keys (
  id          INTEGER PRIMARY KEY,
  key         TEXT    NOT NULL,
  source      TEXT    NOT NULL,   -- 'env' | 'config' | other future kinds
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  symbol_id   INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  line        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_config_keys_key       ON config_keys(key);
CREATE INDEX IF NOT EXISTS idx_config_keys_file_id   ON config_keys(file_id);
CREATE INDEX IF NOT EXISTS idx_config_keys_symbol_id ON config_keys(symbol_id);

-- v4 file_churn - populated by an optional "strata churn" pass that shells
-- out to git log. One row per indexed file; absent when the file lives
-- outside a git repo or churn was not run.
CREATE TABLE IF NOT EXISTS file_churn (
  file_id            INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  commit_count       INTEGER NOT NULL DEFAULT 0,
  last_commit_sha    TEXT,
  last_commit_at     INTEGER,
  top_author         TEXT,
  second_author      TEXT,
  collected_at       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_file_churn_commit_count ON file_churn(commit_count DESC);
CREATE INDEX IF NOT EXISTS idx_file_churn_last_commit  ON file_churn(last_commit_at DESC);

-- v4 symbol_history — per-symbol commit chain. Built by an opt-in pass that
-- walks git log and matches changed line ranges to symbol line spans.
-- match_strategy describes how we matched the commit to the symbol; the
-- coarser strategies are honest about being heuristic.
--   'overlap'   = changed hunk overlapped the current symbol's line range
--   'key-match' = symbol_key matched the symbol in the historical file version
CREATE TABLE IF NOT EXISTS symbol_history (
  id              INTEGER PRIMARY KEY,
  symbol_id       INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  symbol_key      TEXT    NOT NULL,
  commit_sha      TEXT    NOT NULL,
  author_name     TEXT,
  author_email    TEXT,
  committed_at    INTEGER NOT NULL,
  message         TEXT,
  lines_added     INTEGER NOT NULL DEFAULT 0,
  lines_removed   INTEGER NOT NULL DEFAULT 0,
  pr_number       INTEGER,
  pr_url          TEXT,
  match_strategy  TEXT    NOT NULL,
  confidence      REAL    NOT NULL DEFAULT 1.0,
  UNIQUE(symbol_id, commit_sha)
);

CREATE INDEX IF NOT EXISTS idx_symbol_history_symbol     ON symbol_history(symbol_id, committed_at DESC);
CREATE INDEX IF NOT EXISTS idx_symbol_history_key        ON symbol_history(symbol_key, committed_at DESC);
CREATE INDEX IF NOT EXISTS idx_symbol_history_commit_sha ON symbol_history(commit_sha);

-- v4 git_index_state — tracks how far history extraction has progressed.
-- last_head_sha is a generic "the index has seen this HEAD" marker stamped
-- by churn AND symbol-history. last_history_head_sha is set ONLY by the
-- symbol-history pass and is what its skip-if-unchanged guard checks against.
-- Keeping them separate prevents the previous bug where running churn would
-- stamp last_head_sha = HEAD and a subsequent symbol-history build would
-- short-circuit despite never having indexed any history.
CREATE TABLE IF NOT EXISTS git_index_state (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  repo_root                TEXT    NOT NULL,
  last_head_sha            TEXT,
  last_processed_at        INTEGER NOT NULL DEFAULT 0,
  remote_url               TEXT,
  algorithm_version        INTEGER NOT NULL DEFAULT 1,
  last_history_head_sha    TEXT,
  last_history_at          INTEGER
);

-- v4 FTS5 virtual table over symbol names/qualified names + signatures.
-- Tokenizer is "unicode61 remove_diacritics 2" which splits on punctuation,
-- so identifiers like AuthService_login or auth_service.login break cleanly
-- on _ and .; camelCase is split by the symbols_fts_split() helper in the
-- Store at insertion time (we store both the original and the split form).
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name,
  qualified_name,
  signature,
  split,                -- camelCase + snake_case split form
  content='',           -- contentless table — Store keeps it in sync manually
  tokenize="unicode61 remove_diacritics 2"
);

CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  rel_path,
  content='',
  tokenize="unicode61 remove_diacritics 2"
);
`;
