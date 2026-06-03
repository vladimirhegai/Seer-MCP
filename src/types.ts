// Core shared types for the Seer indexer

export type Language =
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'go'
  | 'java'
  | 'rust'
  | 'c'
  | 'cpp'
  | 'csharp'
  // v9 Track-H — proto files contribute routes (gRPC) but no symbols.
  // They go through a regex scanner in `protoScanner.ts`, not tree-sitter.
  | 'proto';

export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'struct'
  | 'enum'
  | 'type'
  | 'constructor'
  | 'variable';

export type EdgeKind = 'call' | 'import' | 'inherits' | 'implements' | 'tests';

/**
 * What variety of symbol this row represents.
 *   - 'definition'  — the canonical, body-bearing definition site. The default
 *                     and the only role indexed by every extractor on every
 *                     symbol historically. Rankable when the kind allows it.
 *   - 'declaration' — a forward declaration or prototype (no body). C/C++
 *                     class-body method declarations and forward declarations
 *                     fall here. Not rankable; excluded from agent-facing
 *                     defaults unless `includeDeclarations=true`.
 *   - 'type_ref'    — a bare use of a type name (no body, no declaration).
 *                     Not yet emitted by any extractor — the slot exists so a
 *                     future indexing mode can store reference sites without
 *                     re-shaping the schema.
 */
export type SymbolRole = 'definition' | 'declaration' | 'type_ref';

// A symbol definition extracted from source
export interface SymbolDef {
  name: string;
  /**
   * Dotted path including all enclosing class/struct/impl scopes.
   * Computed by the walker from the def stack — extractors should not set it.
   * E.g. `Alpha.run`, `AuthService.login`, `PaymentService.process_payment`.
   * Equals `name` for top-level definitions.
   */
  qualifiedName?: string;
  kind: SymbolKind;
  lineStart: number; // 0-indexed row
  lineEnd: number;
  colStart: number;
  colEnd: number;
  signature?: string; // first line of the definition, truncated
  /**
   * Complexity metrics, populated by language extractors via the walker.
   * `loc`/`cyclomatic`/`cognitive`/`maxNesting` are non-null only for
   * function-like symbols (function, method, constructor) where they make
   * sense. For classes/structs/enums/types they stay null.
   */
  loc?: number;
  cyclomatic?: number;
  cognitive?: number;
  maxNesting?: number;
  /**
   * Optional. When omitted, the Store treats this as `'definition'` —
   * matches all pre-existing extractor behavior. C/C++ field_declaration
   * (class-body method declarations) and forward declarations set this to
   * `'declaration'` so default agent-facing queries can hide them.
   */
  symbolRole?: SymbolRole;
  /**
   * Extra owning-scope segments that are NOT on the lexical definition stack.
   * Used for out-of-line definitions whose declarator names a qualifier that
   * the walker can't see lexically — e.g. a C++ method defined at namespace
   * scope as `T Vec<T>::dot(...) { ... }` sets `scopePath = ['Vec']` so its
   * qualified name becomes `geo.Vec.dot` (the true owner) instead of `geo.dot`
   * (which reads like a free function). The walker folds these segments into
   * the qualified name and keys overload disambiguation on (scope + name), so
   * `Foo::bar` and `Baz::bar` stay distinct instead of collapsing to bar / bar#1.
   * Extractors set short names only; this is the one sanctioned scope hint.
   */
  scopePath?: string[];
}

// A reference (call/usage) extracted from source
export interface SymbolRef {
  calleeName: string;  // the name being called/referenced
  callerName: string;  // name of the enclosing function/method, or '' for module level
  kind: EdgeKind;
  line: number; // 0-indexed row
}

/**
 * v9 Track-H — protocols supported by the service-link layer. HTTP was the
 * only protocol at v8; v9 generalizes to RPC/messaging/streaming protocols.
 * Protocol-specific fields are stored sparsely on the same row.
 */
export type ServiceProtocol =
  | 'http'
  | 'trpc'
  | 'graphql'
  | 'grpc'
  | 'kafka'
  | 'sqs'
  | 'sns'
  | 'rabbitmq'
  | 'nats'
  | 'redis_pubsub'
  | 'websocket'
  | 'sse';

/**
 * One route / endpoint detected during parsing.
 *
 * For HTTP (default): Express/Fastify/FastAPI/Flask/Spring routes. `method` +
 * `path` carry the matchable contract; `framework` records the library.
 *
 * v9 Track-H: the same row shape now represents tRPC procedures, GraphQL
 * resolvers, gRPC service methods, Kafka/SQS/RabbitMQ consumers, etc. The
 * protocol-specific fields (operation/topic/queue/exchange/service/broker)
 * are populated by the protocol's extractor and left undefined elsewhere.
 *
 * The handler is named when the route maps to a local function; the post-pass
 * resolves `handlerName` → a `symbol_id` after all definitions are inserted.
 */
export interface RouteDef {
  method: string;
  path: string;
  framework: string;
  handlerName?: string;
  line: number;
  /** v9 Track-H. Defaults to 'http' when omitted (every pre-v9 RouteDef). */
  protocol?: ServiceProtocol;
  /** tRPC procedure path ('user.getById'), GraphQL operation name, gRPC method. */
  operation?: string;
  /** Kafka / pub-sub topic the consumer subscribes to. */
  topic?: string;
  /** SQS / RabbitMQ queue the consumer reads from. */
  queue?: string;
  /** RabbitMQ exchange. */
  exchange?: string;
  /** gRPC service name; k8s service hostname for HTTP routes inside a service module. */
  service?: string;
  /** Broker host / cluster identifier (kafka:9092, sqs.us-east-1, etc.). */
  broker?: string;
  /** Protocol-specific catch-all already serialized as JSON. */
  metadataJson?: string;
}

/** A static read of an environment variable or config key. */
export interface ConfigKeyRead {
  key: string;
  source: 'env' | 'config';
  callerName?: string;   // enclosing symbol qualified name, '' for module-level
  line: number;
}

/**
 * One outbound HTTP client call detected during parsing — fetch / axios /
 * requests / http.Get / HttpClient.GetAsync / etc.
 *
 * Routes are HANDLERS (registered with the framework so an incoming request
 * lands on a function); ServiceCalls are CLIENTS (your code dialing OUT to
 * another service). They are deliberately separate concepts; the post-index
 * resolver rendezvous-matches calls to routes to build service_links.
 *
 * `rawTarget` always carries the literal/expression as written — if the path
 * can't be confidently extracted, normalizedPath stays undefined but the call
 * is still recorded so seer can show "this code calls something via fetch()"
 * even when the target can't be resolved.
 *
 * `callerName` is the enclosing function/method's qualified name at the call
 * site; the walker sets it from the def stack, and the indexer backfills the
 * resolved symbol id from the symbolIdMap.
 */
export interface ServiceCallDef {
  /** v9 Track-H — HTTP at v8; v9 generalizes to RPC / messaging / streaming. */
  protocol: ServiceProtocol;
  /** Upper-cased HTTP method when known: 'GET' | 'POST' | … | 'ANY' if unknown.
   *  For non-HTTP protocols, may carry the operation kind ('query'/'mutation'/'publish'). */
  method?: string;
  /** Original literal/expression text at the call site (truncated to 240 chars) */
  rawTarget: string;
  /** /api/users when extractable; undefined when dynamic and not recoverable */
  normalizedPath?: string;
  /** Hostname / service name (e.g. "payment-service") when present in the URL */
  hostHint?: string;
  /** Env-variable name used in URL building (e.g. "PAYMENT_URL") when seen */
  envKey?: string;
  /** Library that emitted this call: 'fetch' / 'axios' / 'requests' / 'http.Get' / 'trpc' / 'apollo' / … */
  framework: string;
  /** Enclosing symbol qualified name; '' for module-level reads */
  callerName?: string;
  line: number;
  /**
   * Extractor confidence (0..1). High (≥0.9) for unambiguous literal-path
   * calls; lower when only a host or env key was recovered.
   */
  confidence: number;
  // ── v9 Track-H protocol-specific fields. All optional; only set the ones
  // that apply to the protocol you're emitting.
  /** tRPC procedure path ('user.getById'), GraphQL operation name, gRPC method. */
  operation?: string;
  /** Kafka / pub-sub topic this call publishes to. */
  topic?: string;
  /** SQS / RabbitMQ queue this call publishes to. */
  queue?: string;
  /** RabbitMQ exchange. */
  exchange?: string;
  /** gRPC service name; k8s service hostname for outbound HTTP. */
  service?: string;
  /** Broker host / cluster identifier. */
  broker?: string;
  /** Protocol-specific catch-all (serialized JSON object). */
  metadataJson?: string;
}

// Everything extracted from one file
export interface FileExtraction {
  language: Language;
  definitions: SymbolDef[];
  references: SymbolRef[];
  importedModules: string[]; // raw module/file paths imported
  routes?: RouteDef[];
  configKeys?: ConfigKeyRead[];
  /** v8 Track G — HTTP/etc. client calls (outbound). Optional so legacy
   *  extractors that don't implement detection produce undefined / []. */
  serviceCalls?: ServiceCallDef[];
}

// ── DB result types ────────────────────────────────────────────────────────────

export interface SymbolRow {
  id: number;
  name: string;
  qualifiedName: string | null;
  kind: string;
  fileId: number;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  signature: string | null;
  pagerank: number;
  loc?: number | null;
  cyclomatic?: number | null;
  cognitive?: number | null;
  maxNesting?: number | null;
  /**
   * Stored variety of symbol. Null on pre-v5 DBs that haven't yet been
   * re-indexed; the Store treats null as `'definition'` for filter logic.
   */
  symbolRole?: SymbolRole | null;
}

export interface CallerRow {
  callerName: string;
  callerQualifiedName: string | null;
  callerKind: string;
  callerFile: string;
  callerLine: number;
  edgeKind: string;
}

export interface CalleeRow {
  calleeName: string;
  calleeKind: string | null;
  calleeFile: string | null;
  calleeLineStart: number | null;
  edgeKind: string;
}

export interface RouteRow {
  id: number;
  method: string;
  path: string;
  framework: string;
  handlerName: string | null;
  handlerId: number | null;
  handlerSymbol: string | null;
  handlerFile: string | null;
  filePath: string;
  line: number;
  // v9 Track-H — NULL on pre-v9 DBs.
  protocol?: string | null;
  operation?: string | null;
  topic?: string | null;
  queue?: string | null;
  exchange?: string | null;
  service?: string | null;
  broker?: string | null;
  metadataJson?: string | null;
}

export interface ExternalDepRow {
  id: number;
  ecosystem: string;
  name: string;
  versionRange: string | null;
  manifestPath: string;
  isDev: number;
}

export interface ConfigKeyRow {
  id: number;
  key: string;
  source: string;
  filePath: string;
  symbolId: number | null;
  symbolName: string | null;
  line: number;
}

export interface FileChurnRow {
  fileId: number;
  filePath: string;
  commitCount: number;
  lastCommitSha: string | null;
  lastCommitAt: number | null;
  topAuthor: string | null;
  secondAuthor: string | null;
}

export interface SymbolHistoryRow {
  id: number;
  symbolId: number;
  symbolKey: string;
  commitSha: string;
  authorName: string | null;
  authorEmail: string | null;
  committedAt: number;
  message: string | null;
  linesAdded: number;
  linesRemoved: number;
  prNumber: number | null;
  prUrl: string | null;
  matchStrategy: string;
  confidence: number;
}

/** Input row for Store.insertSymbolHistoryBatch() — SymbolHistoryRow minus the
 *  DB-assigned id. Keeps the batched-write call site readable vs. a 13-arg call. */
export interface SymbolHistoryInsert {
  symbolId: number;
  symbolKey: string;
  commitSha: string;
  authorName: string | null;
  authorEmail: string | null;
  committedAt: number;
  message: string | null;
  linesAdded: number;
  linesRemoved: number;
  prNumber: number | null;
  prUrl: string | null;
  matchStrategy: string;
  confidence: number;
}

/**
 * v8 Track G — row returned by Store.listServiceCalls(). The caller is the
 * AST-attributed enclosing function/method; the call always carries the raw
 * literal/expression text as written.
 */
export interface ServiceCallRow {
  id: number;
  protocol: string;
  method: string | null;
  rawTarget: string;
  normalizedPath: string | null;
  hostHint: string | null;
  envKey: string | null;
  framework: string;
  line: number;
  confidence: number;
  filePath: string;
  callerSymbolId: number | null;
  callerName: string | null;
  callerQualifiedName: string | null;
  callerKind: string | null;
  // v9 Track-H — null on HTTP rows and pre-v9 DBs.
  operation: string | null;
  topic: string | null;
  queue: string | null;
  exchange: string | null;
  service: string | null;
  broker: string | null;
  metadataJson: string | null;
}

/**
 * v8 Track G — row returned by Store.listServiceLinks(). Each link rendezvous-
 * matches one service_call (the caller side) with one route (the handler side)
 * and carries the deterministic match_kind + confidence.
 */
export interface ServiceLinkRow {
  id: number;
  callId: number;
  routeId: number | null;
  protocol: string;
  matchKind: string;
  confidence: number;
  evidenceJson: string;
  // Caller side (snapshot from service_calls.symbol_id)
  callerSymbolId: number | null;
  callerName: string | null;
  callerQualifiedName: string | null;
  callerFile: string | null;
  callerLine: number;
  // Call details (forwarded from service_calls so consumers don't have to
  // re-join twice)
  callMethod: string | null;
  callRawTarget: string;
  callNormalizedPath: string | null;
  callFramework: string;
  callEnvKey: string | null;
  callHostHint: string | null;
  // Handler side (route.handler_id resolved to symbol)
  handlerSymbolId: number | null;
  handlerName: string | null;
  handlerQualifiedName: string | null;
  handlerFile: string | null;
  handlerLine: number | null;
  // Route details
  routeMethod: string | null;
  routePath: string | null;
  routeFramework: string | null;
  // v9 Track-H — protocol-specific fields on both sides of the link, null when N/A.
  callOperation: string | null;
  callTopic: string | null;
  callQueue: string | null;
  callService: string | null;
  routeOperation: string | null;
  routeTopic: string | null;
  routeQueue: string | null;
  routeService: string | null;
}

export interface StatsRow {
  files: number;
  symbols: number;
  edges: number;
  resolvedEdges: number;
  languages: Record<string, number>;
  roles?: { project: number; vendor: number; generated: number; test: number };
  routes?: number;
  externalDependencies?: number;
  configKeys?: number;
  symbolHistory?: number;
  /** Number of clustered modules; 0 if the clustering pass hasn't run. */
  modules?: number;
  /** v7: SCIP files imported into this DB; 0 on pre-v7. */
  scipImports?: number;
  /** v7: symbols with a non-null structural shape_hash. */
  shapeHashed?: number;
  /**
   * v7: symbol + edge counts grouped by provenance. Always present at v7;
   * agents can use it to see how much precision SCIP contributed vs the
   * tree-sitter baseline.
   */
  provenance?: {
    symbols: Record<string, number>;
    edges: Record<string, number>;
  };
  /** v8 Track G — total service_calls rows (outbound HTTP/etc. clients). */
  serviceCalls?: number;
  /** v8 Track G — total service_links rows (caller↔handler rendezvous). */
  serviceLinks?: number;
}
