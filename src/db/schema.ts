// SQL DDL for the Seer graph database

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
//
// v5 adds explicit symbol_role on `symbols`:
//   - 'definition' (default) | 'declaration' | 'type_ref'
//   - Required so agent-facing search/ranking can hide forward declarations
//     and (future) bare type-reference rows by default while keeping them
//     queryable when callers opt in via includeDeclarations / includeTypeRefs.
//   - C/C++ class-body method declarations (field_declaration with a
//     function_declarator inside, no body) are now recorded as 'declaration'
//     while the out-of-line `void Class::method() { ... }` stays
//     'definition'. Pre-existing behavior of every other extractor is
//     preserved: when an extractor doesn't set symbolRole, the Store writes
//     'definition'.
//
// v6 adds Track-E "agent orientation" tables:
//   - modules: one row per Louvain-clustered module (label, size, primary
//     language, cohesion, centrality)
//   - module_members: file_id → module_id mapping (PRIMARY KEY on file_id —
//     a file belongs to exactly one module)
//   - module_edges: cached cross-module call+import weights so
//     seer_module_dependencies stays sub-millisecond
//   The clustering is deterministic (seeded label-tie-break by id, modularity-
//   gain ties resolved by lower-id-wins), so two indexes of the same DB
//   produce the same module ids.
//
// v7 adds Track-F "portability and precision":
//   - symbols.provenance / edges.provenance — 'tree-sitter' (default) | 'scip' |
//     'scip-merge'. SCIP-imported precision data is additive and source-
//     labelled so agents can see which signals came from a precise indexer vs
//     tree-sitter's syntactic best-effort.
//   - symbols.shape_hash — 64-bit SimHash (stored as INTEGER) over the
//     symbol's structural token stream. NULL for non-function symbols and for
//     symbols where the extractor didn't compute it. Used by
//     seer_duplicates to find near-duplicate functions within Hamming distance N.
//   - scip_imports — one row per SCIP file ingested (path, sha, indexed_at,
//     symbol_count, ref_count). Lets us re-run idempotently and lets the
//     bundle exporter record which SCIP layers contributed precision.
//
// v8 adds Track-G "service links" — deterministic cross-service linking:
//   - service_calls: one row per HTTP client call extracted from source
//     (fetch/axios/requests/http.Get/HttpClient/etc.). The caller symbol is
//     AST-attributed; the endpoint value is captured as raw_target + an
//     optional normalized_path / host_hint / env_key parsed by serviceLinks.
//   - service_links: deterministic rendezvous between service_calls and the
//     route handlers that satisfy them. Built by the post-index resolver.
//     A parallel evidence layer; not mutating the normal edges table.
//   Routes table is the rendezvous; service calls are the clients.
//
// v9 adds Track-H "protocol expansion" — generalize beyond HTTP to tRPC /
// GraphQL / gRPC / Kafka / SQS / SNS / RabbitMQ / NATS / Redis pub-sub /
// WebSocket / SSE. Rather than overfit one column per protocol, we add a
// small shared set of fields and let each protocol fill the ones that apply:
//   service_calls + routes both gain:
//     - operation       — graphql opName, tRPC procedure path, gRPC method
//     - topic           — kafka / pub-sub topic
//     - queue           — sqs / rabbitmq queue
//     - exchange        — rabbitmq exchange
//     - service         — gRPC service name, k8s service hostname
//     - broker          — broker host/cluster identifier (kafka:9092, etc.)
//     - metadata_json   — protocol-specific catch-all
//   routes additionally gains:
//     - protocol        — 'http' (default) / 'trpc' / 'graphql' / 'grpc' /
//                         'kafka' / 'sqs' / 'sns' / 'rabbitmq' / 'nats' /
//                         'redis_pubsub' / 'websocket' / 'sse'
//   All columns are added via ALTER TABLE ADD COLUMN so v8 DBs migrate
//   in-place; pre-v9 rows get NULL for the new fields. HTTP behavior is
//   unchanged: when protocol/operation/topic/etc. are NULL the resolver
//   keeps using the existing literal-path / pattern-path matching.
//
// v10 adds post-Track-H features:
//   - external_bundles: read-only layer of routes / service-endpoints imported
//     from a peer repo's exported .seerbundle. Additive — local files/symbols
//     are untouched. Rows have provenance='external-bundle' and a foreign-key
//     bundle id so re-importing the same bundle replaces only that layer.
//   - routes / service_calls / service_links gain `external_bundle_id` so the
//     resolver can pick up cross-repo evidence (auth → billing) without
//     checking out billing source. Local rows leave it NULL.
//   - boundaries / boundary_members / boundary_edges: monorepo package/service
//     boundary detection (package.json workspaces, pnpm-workspace.yaml,
//     turbo.json, nx.json, go.work, Cargo workspace, nested manifests, and
//     services/* / packages/* fallback). Risk and context get a boundary
//     crossing signal — strictly advisory.
//   - symbol_history_continuity: rename/move continuity evidence. When exact
//     symbol_key history stops, optional heuristics (shape_hash exact / close
//     Hamming + signature similarity / shared file rename history) attach the
//     historical previous_symbol_key with a confidence and a match_reasons
//     blob. Never pretends rename continuity is certain.
//
// v11 adds:
//   - symbol_history_progress: per-file resume watermark for the symbol-history
//     build. Lets an interrupted/budgeted build (Ctrl-C, deadline, maxFiles)
//     resume without re-walking already-finished files, and makes a HEAD-moved
//     rerun reprocess only the files whose content actually changed. Pure
//     additive table; absence just means "no resume info yet".
//   - git_index_state.last_history_follow: records whether the last full
//     symbol-history build used `git log --follow`, so incremental refreshes
//     replicate the same matching without re-deriving it. Added via ALTER TABLE
//     ADD COLUMN; NULL on older DBs is treated as false (the default).
export const CURRENT_SCHEMA_VERSION = 11;

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
  symbol_key     TEXT,
  -- v5 symbol_role distinguishes canonical definitions from forward / class-
  -- body declarations and (future) bare type-reference sites. Default keeps
  -- legacy behavior: every existing extractor that doesn't set a role gets
  -- 'definition'. Used by default search/ranking filters to exclude
  -- declarations unless includeDeclarations=true and to never emit type_ref
  -- rows in agent-facing defaults unless includeTypeRefs=true.
  symbol_role    TEXT    NOT NULL DEFAULT 'definition',
  -- v7 provenance — which indexer produced this row:
  --   'tree-sitter' (default) — our syntactic extractor; never deleted by SCIP merges
  --   'scip'                  — imported from a precise SCIP index
  --   'scip-merge'            — tree-sitter row that SCIP confirmed/refined (rare)
  -- SCIP rows are additive; agents can filter precision by provenance.
  provenance     TEXT    NOT NULL DEFAULT 'tree-sitter',
  -- v7 shape_hash — 64-bit structural SimHash of the symbol's body token
  -- stream, stored as INTEGER for cheap Hamming-distance comparison. NULL
  -- when not computed (non-function kinds, declarations, types).
  shape_hash     INTEGER,
  -- v7.1 scip_import_id — when provenance='scip', the scip_imports.id row
  -- that contributed this symbol. Lets us wipe/refresh a single SCIP layer
  -- without touching siblings.
  scip_import_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_symbols_name           ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_qualified_name ON symbols(qualified_name);
CREATE INDEX IF NOT EXISTS idx_symbols_file_id        ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_file_name      ON symbols(file_id, name);
CREATE INDEX IF NOT EXISTS idx_symbols_pagerank       ON symbols(pagerank DESC);
-- v5 idx_symbols_symbol_role is created in runMigrations after the column
-- exists; putting it here would fail on pre-v5 DBs whose symbols table
-- does not yet have the column (CREATE TABLE IF NOT EXISTS above is a
-- no-op against an existing pre-v5 table).
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
  line     INTEGER NOT NULL DEFAULT 0,
  -- v7 provenance — see symbols.provenance.
  provenance TEXT  NOT NULL DEFAULT 'tree-sitter',
  -- v7.1 — see symbols.scip_import_id.
  scip_import_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_edges_from    ON edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to_name ON edges(to_name);
CREATE INDEX IF NOT EXISTS idx_edges_to_id   ON edges(to_id);
CREATE INDEX IF NOT EXISTS idx_edges_kind    ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_edges_from_to_kind ON edges(from_id, to_id, kind);
CREATE INDEX IF NOT EXISTS idx_edges_to_name_kind ON edges(to_name, kind);
CREATE INDEX IF NOT EXISTS idx_edges_to_id_kind_from ON edges(to_id, kind, from_id);

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
  line            INTEGER NOT NULL DEFAULT 0,
  -- v9 Track-H protocol expansion. protocol defaults to 'http' so all
  -- pre-v9 routes keep their semantics; tRPC procedures / GraphQL resolvers /
  -- gRPC service methods / Kafka consumers etc. set protocol explicitly.
  -- The generalized columns mirror service_calls so client to handler matching
  -- can be done by the same field on both sides.
  protocol        TEXT    NOT NULL DEFAULT 'http',
  operation       TEXT,
  topic           TEXT,
  queue           TEXT,
  exchange        TEXT,
  service         TEXT,
  broker          TEXT,
  metadata_json   TEXT
);

CREATE INDEX IF NOT EXISTS idx_routes_method     ON routes(method);
CREATE INDEX IF NOT EXISTS idx_routes_path       ON routes(path);
CREATE INDEX IF NOT EXISTS idx_routes_file_id    ON routes(file_id);
CREATE INDEX IF NOT EXISTS idx_routes_framework  ON routes(framework);
CREATE INDEX IF NOT EXISTS idx_routes_handler_id ON routes(handler_id);
CREATE INDEX IF NOT EXISTS idx_routes_protocol   ON routes(protocol);
CREATE INDEX IF NOT EXISTS idx_routes_operation  ON routes(operation) WHERE operation IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_routes_topic      ON routes(topic)     WHERE topic IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_routes_queue      ON routes(queue)     WHERE queue IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_routes_service    ON routes(service)   WHERE service IS NOT NULL;

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

-- v4 file_churn - populated by an optional "seer churn" pass that shells
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
--   'overlap'       = a changed hunk overlapped the current symbol's line range
--   'file-addition' = the commit introduced the whole file, so every symbol in
--                     it is attributed to that commit (line numbers don't apply)
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

-- v11 symbol_history_progress — per-file resume watermark for the symbol-history
-- build. A processed file is safely skippable on a later run ONLY when its
-- content hash, the build's options fingerprint, AND the algorithm version all
-- still match: those three together prove the rows would be recomputed
-- identically. file_hash is the load-bearing key — an unchanged hash at a newer
-- HEAD proves no commit touched the file since it was processed, so its
-- "git log --follow" history and current symbol line ranges are unchanged. That
-- is why a HEAD-only watermark (rejected in the perf plan) was unsafe: --max-commits,
-- --since, a reindex, or a parser change could all leave HEAD identical while
-- changing the correct output. head_sha is recorded for observability and the
-- completion stamp, not used as the skip key.
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

-- v6 modules: one row per Louvain-clustered group of files. The cluster is
-- deterministic given the input graph, so two builds against the same DB
-- produce the same membership.
--   label             — derived from the dominant top-level directory of the
--                       files in the module, with a numeric suffix when two
--                       modules share the same dominant dir.
--   size_files        — number of files in the module
--   size_symbols      — number of rankable symbols in the module
--   primary_language  — most common files.language across members
--   cohesion          — fraction of intra-module edges over total weighted
--                       edges touching the module's members (0..1).
--   centrality        — sum of PageRank of the rankable symbols in this
--                       module — lets agents sort modules by graph importance.
--   algorithm         — 'louvain' today; allows alternate clusterings later.
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

-- v6 module_members: file → module mapping. A file belongs to exactly one
-- module (PRIMARY KEY on file_id). Rebuilt every time we run clustering.
CREATE TABLE IF NOT EXISTS module_members (
  file_id    INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  module_id  INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_module_members_module ON module_members(module_id);

-- v6 module_edges: cached cross-module dependency weights. Aggregated from
-- the resolved call/import/test graph by the clustering pass. UNIQUE on
-- (from, to, kind) so we can store calls / imports / tests separately and
-- agents can ask "which modules call into auth?" vs "which modules import
-- from auth?" independently.
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

-- v7 scip_imports: tracks every SCIP index that's been merged into the DB so
-- re-runs are idempotent and bundle manifests can list precision provenance.
-- One row per SCIP file path; the (path, sha) tuple is the dedup key.
CREATE TABLE IF NOT EXISTS scip_imports (
  id            INTEGER PRIMARY KEY,
  path          TEXT    NOT NULL,
  sha256        TEXT    NOT NULL,
  tool          TEXT,            -- e.g. "scip-typescript@0.3.5"
  project_root  TEXT,
  imported_at   INTEGER NOT NULL,
  symbol_count  INTEGER NOT NULL DEFAULT 0,
  ref_count     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(path, sha256)
);
CREATE INDEX IF NOT EXISTS idx_scip_imports_path ON scip_imports(path);

-- v7 indexes for provenance and shape_hash (CREATE IF NOT EXISTS so they're
-- harmless against pre-v7 DBs where the columns don't yet exist — those are
-- created in runMigrations before the indexes are attempted).

-- v8 service_calls — one row per HTTP client call site detected during parse.
-- symbol_id is the enclosing function/method when the call is inside one
-- (most cases); module-level calls leave it NULL. raw_target is the original
-- literal/expression text (e.g. "/api/users", "\${BASE_URL}/charge"); the
-- post-index resolver fills normalized_path / host_hint / env_key where it can
-- recover them deterministically.
CREATE TABLE IF NOT EXISTS service_calls (
  id              INTEGER PRIMARY KEY,
  file_id         INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  symbol_id       INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  protocol        TEXT    NOT NULL,        -- 'http' / 'trpc' / 'graphql' / 'grpc' / 'kafka' / 'sqs' / ...
  method          TEXT,                    -- 'GET' / 'POST' / 'ANY' / null (HTTP) or operation kind ('query'/'mutation')
  raw_target      TEXT    NOT NULL,        -- original literal/expression text
  normalized_path TEXT,                    -- '/api/users' where confidently extractable
  host_hint       TEXT,                    -- service name / hostname when present
  env_key         TEXT,                    -- env var used in the URL (PAYMENT_URL, etc.)
  framework       TEXT    NOT NULL,        -- 'fetch' / 'axios' / 'requests' / 'http.Get' / 'trpc' / 'apollo' / ...
  line            INTEGER NOT NULL DEFAULT 0,
  confidence      REAL    NOT NULL DEFAULT 0.5,
  -- v9 Track-H protocol expansion. NULL for HTTP rows; populated by the
  -- protocol-specific extractor when the field is meaningful.
  operation       TEXT,                    -- tRPC procedure path / GraphQL op name / gRPC method
  topic           TEXT,                    -- kafka / pub-sub topic
  queue           TEXT,                    -- sqs / rabbitmq queue
  exchange        TEXT,                    -- rabbitmq exchange
  service         TEXT,                    -- gRPC service name / k8s service hostname
  broker          TEXT,                    -- broker host / cluster identifier
  metadata_json   TEXT                     -- protocol-specific catch-all (JSON object)
);

CREATE INDEX IF NOT EXISTS idx_service_calls_symbol_id ON service_calls(symbol_id);
CREATE INDEX IF NOT EXISTS idx_service_calls_path      ON service_calls(normalized_path);
CREATE INDEX IF NOT EXISTS idx_service_calls_protocol  ON service_calls(protocol);
CREATE INDEX IF NOT EXISTS idx_service_calls_file_id   ON service_calls(file_id);
CREATE INDEX IF NOT EXISTS idx_service_calls_operation ON service_calls(operation) WHERE operation IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_service_calls_topic     ON service_calls(topic)     WHERE topic IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_service_calls_queue     ON service_calls(queue)     WHERE queue IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_service_calls_service   ON service_calls(service)   WHERE service IS NOT NULL;

-- v8 service_links — deterministic rendezvous between a service_call and the
-- route handler that satisfies it. caller_symbol_id and handler_symbol_id are
-- snapshotted from service_calls.symbol_id / routes.handler_id at link time
-- so a caller can query "service links for symbol X" cheaply without joining
-- back through the service_calls / routes / symbols chain.
--
-- match_kind:
--   'literal_path'   — call.normalized_path == route.path exactly (method-match preferred)
--   'env_base'       — call references an env var resolved to the same host; path also matched
--   'service_host'   — call's host_hint matched a known service host; path matched
--   'route_pattern'  — call path matched a parameterised route (e.g. /users/:id)
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

-- v10 external_bundles — one row per .seerbundle imported as an additive
-- external layer. Each row carries the source bundle's manifest identity so
-- callers can see exactly which external service contributed which rows.
-- Re-importing the same bundle replaces (per-bundle id) without disturbing
-- siblings or local rows.
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

-- v10 boundaries — package/service boundaries detected at index time. A file
-- belongs to at most one boundary. The clustering is deterministic from the
-- detected manifest layout (workspaces, services/* fallback, nested
-- package.json / go.mod / Cargo.toml / pyproject.toml).
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

-- Cross-boundary dependency edges. kind ∈ ('call', 'import', 'service').
-- weight is the aggregated count.
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

-- v10 symbol_history_continuity — when an exact-symbol_key history walk
-- terminates at a rename/move boundary, the continuity layer records the
-- previous identity it most likely had. Confidence + reasons stay honest:
-- shape_hash exact match is high confidence, signature similarity is lower.
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
`;
