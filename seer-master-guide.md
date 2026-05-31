# Seer — Master Guide & Architectural Spec

*A product and architectural specification for turning deterministic local code intelligence into a high-leverage AI-agent workflow and temporal developer onboarding system.*

Seer is divided into two distinct product layers:
1.  **Seer-Core:** The open-source, local-first, deterministic code-intelligence engine for AI agents and local developer tools (zero-AI).
2.  **Seer-Onboarding:** The richer web and temporal product experience designed to onboard developers and explain complex architectures (AI-enabled).

---

## 1. Product Philosophies

### 1.1 Seer-Core
AI agents waste massive amounts of LLM context window tokens and multiple tool call round-trips using raw search or grep to navigate codebases. Seer-Core solves this by exposing **deterministic, structural facts** from a local SQLite index over an MCP server.

*   **Deterministic Only:** Seer-Core does not generate explanations, summaries, or narrative prose. It returns clean, source-labelled facts (definitions, call graphs, routes, churn, etc.) so consuming LLMs can reason without guessing.
*   **Wedge Differentiator (Symbol History):** While generic MCP servers show file-level git churn, Seer-Core's primary differentiator is **symbol-level git history**—returning commit blame chains for the exact function, class, or method.
*   **Workflow Compression:** Rather than forcing an agent to invoke ten different lookup tools, Seer-Core combines metrics, tests, boundaries, and history into unified, high-density pre-edit context packets.

### 1.2 Seer-Onboarding
While Core is optimized for machines (agents), Seer-Onboarding is optimized for humans (developers). It sits on top of Core and uses LLMs to translate structural graph facts into guided visual walkthroughs, timelines, and interactive learning paths.

---

## 2. Seer-Core Architectural Blueprint

```text
  Workspace Files
       |
       | File discovery (.gitignore + .seerignore)
       v
    Indexer
       |
       | Worker thread pool (web-tree-sitter WASM)
       v
  AST Language Extractors
       |
       | Qualified names, calls, routes, complexity, config, shape hashes
       v
  Idempotent SQLite Store (Schema v10)
       |
       | Post-pass resolution (same-file -> import -> global fallback)
       | Service-link resolver (Track G/H client -> route matching)
       | Louvain modular clustering
       v
  CLI / MCP Server
       |
       | JIT Freshness Check (jitSync file hash checking)
       v
  AI Client / Monaco UI
```

### JIT Freshness Model
Correctness is a product requirement. If an agent edits a file, Seer must reflect those changes immediately.
1.  **Chokidar Watcher:** Keeps the index warm in the background by debouncing write bursts.
2.  **JIT Freshness (`jitSync`):** Runs an instant hash check over changed files before any MCP query returns. If a hash mismatch is detected, Seer runs a serial single-file parse to guarantee correct results without blocking concurrent reads.

## 3. Seer-Core Foundational Feature Tracks (Tracks A to H)

Seer-Core was developed across a series of structured functional tracks. These tracks form the conceptual and architectural foundation of the deterministic, zero-AI code-intelligence engine:

### 3.1 Track A & B — Core Indexing Framework, Discovery & Symbol Extraction
*   **Layered Ignore-Aware Discovery:** Seer implements a fast directory walker that respects hierarchical `.gitignore` and `.seerignore` rules, classifying files automatically into `project`, `test`, `generated`, or `vendor` roles to exclude low-value files immediately.
*   **WASM Worker Thread Pool:** To bypass V8 execution lockouts when parsing multiple files asynchronously, Seer orchestrates a parallel `WorkerPool` of native Node `worker_threads` containing isolated `web-tree-sitter` WASM instances.
*   **Discovery Modes:** Supports three levels via `--mode full|standard|fast`. Standard is the default; Full includes vendor + generated; Fast layers extra heuristic directory exclusions (`docs/`, `fixtures/`, `testdata/`, `migrations/`).
*   **Tree-Sitter Query-Assisted Walker:** Extractor declares its `candidateNodeTypes` which compiles a `Parser.Query` once and runs it on parse. The walker walks the tree and only executes extractor callbacks (`tryExtractDefinition`, `tryExtractContextName`, etc.) on these captured candidate nodes, speeding up walks. Standard baseline is used as fallback or forced via `SEER_USE_CANDIDATE_QUERY=0`.
*   **Multi-Language AST Extractor:** Performs high-precision syntactic walks of ASTs for TypeScript/JavaScript (including TSX grammar mapping for React components), Python, Go, Java, Rust, C/C++ (including out-of-line method resolution), and C# (constructor/member call tracking).
*   **Syntactic Body Gating:** Prevents type-reference pollution (e.g. C/C++ `struct device *dev`) by dropping body-less nodes, only emitting struct/class/union/enum symbols when the node contains a definition `body`.
*   **Symbol Role Partitioning (Schema v5):** Populates `symbols.symbol_role` (`definition | declaration | type_ref`). Free-function prototypes and class declarations are stored as declarations, excluded from PageRank, and filtered through `includeTests`/`includeDeclarations`/`includeTypeRefs` search constraints.
*   **Three-Pass Scope-Aware Symbol Resolution:** Project-wide references are resolved to target symbol definition IDs via (1) Same-File binding, (2) Imported-File matching (following explicit relative imports), and (3) Global Fallback matching.
*   **Lazy Rankable PageRank (Schema v3):** Restricts the PageRank graph purely to `is_rankable` symbols (functions, methods, classes, constructors) to prevent dilution from isolated declaration rows. PageRank for non-rankables is pinned to 0, and runs are skipped if the graph has not changed.

### 3.2 Track C & D — Web Endpoints, Configuration, Metadata, Complexity & Search
*   **Web Route Extraction:** Parses API routing declarations (Express/Fastify object-style routing URLs, FastAPI/Flask, Spring Boot annotations with prefix inheritance) to map endpoints, methods, and backend handlers.
*   **Config & Env Variable Auditing:** Audits and indexes calls to configuration keys (e.g., `process.env`, `os.getenv`, `System.getenv`), mapping reads to enclosing caller symbols via line containment.
*   **External Dependency Manifest Parsing:** Collects declared external libraries from standard manifests (`package.json`, `Cargo.toml`, `requirements.txt`, `go.mod`), storing them in the `external_dependencies` index.
*   **Abstract-Complexity Analysis:** Tracks structural code complexity metrics—including Cyclomatic Complexity, Cognitive Complexity, Lines of Code (LOC), and Max Nesting Depth—per symbol definition to pinpoint refactoring hotspots.
*   **High-Fan-In Query Optimizations:** Bypasses B-tree temp sorting and database locks on large codebases by separate-routing `findCallers(name, limit)` indexed seeks and `countCallers(name)` true counts.
*   **BM25 Token-Split FTS5 Search:** A high-speed full-text search index backed by custom SQLite FTS5 tokenizers designed to split camelCase (`AuthServiceImpl` -> `auth service impl`) and snake_case keywords for high-precision query matches.
*   **BFS Call Path Tracing:** Exposes BFS solvers (`tracePath`) to trace step-by-step caller chains between any source and destination symbol IDs, and yields reverse reachability graphs.

### 3.3 Track E — Louvain Modules, Reachability Closures & Behavioral Specs
*   **Louvain Modular Clustering:** Constructs a weighted, undirected file graph (weights: import = 2, call = 1, test = 3) and runs Louvain community detection to segment files into highly cohesive **Modules**, allowing agents to orient at subsystem levels.
*   **Transitive BFS Closures:** Computes bounded forward/reverse reachability maps with depth, and resolves transitive file import closures.
*   **Collision Hardening & Exact-ID Evidence Paths:** Copies exact target `to_id` tags on synthesized test edges so same-short-name symbols in different scopes (e.g. `Alpha.run` and `Beta.run`) do not share test coverage, callers, or risk profiles in `seer_behavior`, `seer_risk`, or `seer_context`.
*   **Ranked Behavioral Specs (Behavior 2.0):** Dynamically scores and ranks tests and assertions exercising a target symbol, sorted descending by specificity: (1) Direct call from test to target, (2) Naming conventions (sibling test specs), (3) Call graph step distance, and (4) Assertion counts and commit recency.
*   **Deterministic Edit-Risk Scoring (`seer_risk`):** Synthesizes a composite risk verdict (low, medium, high) and score by evaluating caller fan-in, public route exposure, test coverage gaps, boundary crossings, and structural complexity/churn.
*   **Context Packet (`seer_context`):** Compresses definition, module membership, blast radius, behavioral tests, and edit risk into a high-density JSON payload, ideal for packing into single-call agent prompts.

### 3.4 Track F — SCIP Precision Overlays, SimHash Shapes & Portable Bundles
*   **SCIP JSON Precision Overlays:** Additively integrates language-agnostic SCIP (LSIF) index formats. Merges overlapping tree-sitter nodes under a `scip-merge` role while preserving standalone SCIP facts, allowing idempotent layer updates and removals.
*   **Structural SimHash Shapes:** Generates a 64-bit structural shape hash over AST subtrees folded into category tokens (NAME, OP, NUMBER), ignoring naming and parameter refactorings.
*   **Hamming-Distance Code Clones:** Identifies identical or near-identical code clones across the repository using a SimHash Hamming distance threshold $\le 4$, skipping trivial boilerplate.
*   **Portable `.seerbundle` Archives:** Vacuums and compresses local index files into reproducible, signed binary tarballs containing SHA-256 integrity verifications and fast, zero-write manifest peeks.

### 3.5 Track G & H — Cross-Service Links & Protocol Extensions
*   **HTTP Client Auditing:** Scans source code for network call signatures (e.g., fetch, axios, requests, httpx, HttpClient, RestTemplate) and records outgoing requests in the `service_calls` table.
*   **Infrastructure Host-Evidence Mapping:** Extractor parses Docker Compose configurations and Kubernetes manifests for service host evidence, classifying patterns like `http://payment-service/...` as local service host matches.
*   **Post-Index Service Link Resolver:** Normalizes client URLs and patterns to match them against server route declarations, populating `service_links` to trace API call flows across microservices.
*   **Candidate Telemetry & Truncation:** Caps potential service-link routes at 25 candidates with deterministic ordering, outputting `truncated` and `total_candidates` telemetry attributes.
*   **tRPC Protocol Support:** Parses tRPC routers and query/mutation procedures, scans client operations (e.g., `client.user.getById.query()`), and links them via `trpc_procedure` connections.
*   **GraphQL Protocol Support:** Maps GraphQL schemas and Query/Mutation field resolvers, parses client operations (e.g., `client.query({ query: GET_USER })`), and connects them via `graphql_operation` service links.
*   **gRPC Protocol Support:** Parses `.proto` files to identify services and RPC declarations, extracts Go/Java/C# gRPC client calls, and links them via `grpc_method` matches.
*   **Messaging Protocol Support:** Audits topic/queue producers and consumers across RabbitMQ, Kafka, SQS, SNS, NATS, and Redis Pub/Sub, mapping decoupled data-flow linkages across distinct systems.
*   **Generalized Graph Tracing Tools:** Exposes high-leverage service-link dependency tracing tools: `seer_trace_service_dependencies` (bounded BFS over the service-link graph) and `seer_trace_module_service_dependencies`.
*   **SeerBench Service Benchmarks:** Validated by a deterministic service-link validation benchmark (`npm run test:bench`) enforcing precision and recall $\ge 0.9$ over 8 standard task cases.

---

## 4. Product Specifications of Core Features (Track I - Schema v10)

Under **Schema v10**, Seer defines five core features designed to give agents high-density, high-integrity workspace intelligence:

### 4.1 Feature 1 — External Bundle Layers
In microservice architectures, code intelligence engines are traditionally constrained to a single workspace. Seer solves this by allowing teams to import pre-indexed `.seerbundle` files from external repositories additively:
*   **Phantom Files:** Imported bundles are mapped to read-only "phantom files" (e.g. `'external:<bundle-id>'`) inside the local database.
*   **Cross-Service Call Resolution:** Outbound network calls (`service_calls`) are automatically matched against routes inside these external layers.
*   **Pruning & Additivity:** External layers are isolated, ensuring local codebase prunes never wipe them out. Forced re-imports safely wipe and replace the layer atomically without leaking files.

### 4.2 Feature 2 — Contract Diff
Ensures API contract safety across development cycles:
*   **Zero-Import Comparisons:** Reads and compares two `.seerbundle` files directly on disk without database write overhead.
*   **Protocol-Aware Diffs:** Identifies breaking changes, route deletions, or signature modifications across HTTP, tRPC, GraphQL, gRPC, and messaging queues (Kafka, SQS, SNS, NATS, RabbitMQ).
*   **Impact Mapping (`--include-callers`):** Cross-references route changes with local and external service links to show precisely which local callers will be broken by a contract modification.

### 4.3 Feature 3 — Preflight Context
The entry point for any file edit. `seer preflight` replaces high-frequency, narrow tool calls with a single, high-density packet:
*   **Diff-to-Symbol Range Mapping:** Translates raw line-number diffs between git refs (e.g. `main..HEAD`) directly into affected AST symbols using `detectChanges`.
*   **Decomposed Blast Radius:** Combines direct callers, transitive dependents, test spec coverage, recent commit history, and boundary crossing risks into a single, bounded JSON packet.
*   **Bundle Pairing:** Accepts an optional secondary bundle to inject a live API contract diff preview into the preflight check.

### 4.4 Feature 4 — Monorepo Boundaries
Large monorepos contain logical layer divisions that should not be violated. Seer parses boundaries from standard manifests (`package.json`, `go.mod`, etc.) or fallback paths (`packages/*`):
*   **Boundary Crossing Signals:** If a call edge originates in boundary A but resolves to a symbol in boundary B, Seer flags a `boundaryCrossing` in the edit-risk profile.
*   **Logical Scoping:** Allows agents to scope searches and module mappings to distinct sub-projects, avoiding structural information overload.

### 4.5 Feature 5 — Rename/Move Continuity
Refactoring regularly rename or moves symbols across files, which breaks standard Git history blame chains. Seer preserves continuous symbol lineage:
*   **Structural SimHash:** Generates a 64-bit structural shape hash over identifier-folded AST subtrees.
*   **Hamming & Scope Heuristics:** Maps moved or renamed functions by matching shape similarity, scope paths, and parameters.
*   **Ambiguity Safeguards:** Bucket searches containing trivial boilerplate (e.g., standard getters) are capped at low confidence and require scope/name similarity to match, preventing false positives.
*   **Unbroken Histories:** Continuity is automatically folded into `seer history` and `seer preflight` results.

### 4.6 Feature 6 — Structural Skeleton Renderer (`seer_skeleton`)
To help agents comprehend large code files without consuming excessive LLM context tokens or running into rate limits, Seer provides a deterministic source elision engine:
*   **Signature Preservation:** Every function, class, method, and variable signature is preserved in full.
*   **Body Elision:** The implementation bodies of these symbols are collapsed to single-line fold markers containing the exact number of collapsed lines: `{ ... N lines ... }`.
*   **Line-Range Containment:** The nesting hierarchy of these signatures is computed via language-agnostic line-range containment, ensuring perfect structure preservation.
*   **Focus Expansion:** Accepts an optional `focusSymbol` parameter to expand one target symbol body verbatim while leaving all other symbol bodies collapsed, enabling highly targeted reads.
*   **Deterministic Re-Rendering:** Re-rendering is completely deterministic and byte-identical for identical inputs.

### 4.7 Feature 7 — Resilient Search Auto-Suggestions ("Did-you-mean")
To prevent AI agents from hitting dead ends when they make typographical errors in symbol or file references, Seer integrates a failsafe suggestion engine:
*   **Zero-Result Interception:** When query tools (`definition`, `symbols`, `callers`, `risk`, `context`, `behavior`, `symbol_module`, `continuity`) return zero direct results, Seer intercepts the failure and performs a BM25/FTS5 search.
*   **Suggestive Delivery:** Returns up to 5 close matches under a `didYouMean` array containing key metadata (name, qualified name, kind, file, and line start).
*   **No Auto-Substitution:** Suggestions are strictly advisory. Seer never auto-substitutes queries, preventing misleading information or incorrect context bindings.

### 4.8 Feature 8 — Dynamic Token Budgeting
To optimize context window usage and prevent prompt overflows during high-volume queries, Seer enforces strict token budgets on list outputs:
*   **Prefix-Trimming (`budgetedText`):** List tools accept a `tokenBudget` parameter and pack items dynamically, prefix-trimming the response to stay within `tokenBudget * 4` characters (assuming ~4 characters per token).
*   **High-Volume Tool Integration:** Available across the 7 high-volume MCP list tools: `seer_symbols`, `seer_definition`, `seer_callers`, `seer_callees`, `seer_service_calls`, `seer_service_links`, and `seer_complexity`.
*   **Truncation Flags & Notes:** Appends `truncated: true`, `omitted: N`, and a descriptive user note indicating how many items were omitted and how to retrieve the rest.
*   **Guaranteed Minimality:** Guarantees that at least one relevant item is returned even if the first item alone exceeds the budget.
*   **Zero-Overhead Baseline:** When no `tokenBudget` is provided, output is completely un-trimmed and byte-identical to previous versions. High-fan-in search paths are never re-sorted by budgeting.

### 4.9 Feature 9 — Lazy Lifecycle Management
Optimizes cold-start initialization and bundle import times by deferring heavy analytical passes until they are actually needed:
*   **Auto-Build triggers:** The three intensive derived-graph indexes (`ensureModules`, `ensureShapeHashes`, and `ensureSymbolHistory`) automatically run once-per-process on the first dependent query instead of upfront during indexing.
*   **Robust Exception Catching:** If a JIT build fails, exceptions are caught as clean, non-fatal warnings (logged to stderr) without crashing the server or blocking the parent query.
*   **Manual Rebuild Verification:** The corresponding manual build tools (`seer_modules_build`, `seer_symbol_history_build`, and `seer_shape_hash_build`) are rebranded as "(Advanced — usually unnecessary)" in metadata but remain registered for forced overrides.

### 4.10 Feature 10 — Batch Execution and Umbrella Tracing (`seer_batch` & `seer_trace`)
Minimizes network round-trip delays and agent decision load by introducing unified execution interfaces:
*   **Read-Only Batch Execution (`seer_batch`):** Accepts up to 25 read-only tools in a single MCP request. Runs tools sequentially in-process with failure isolation (one failing query does not abort other queries in the batch).
*   **Umbrella Scope Dispatcher (`seer_trace`):** Provides a single entrypoint that delegates to the specific `seer_trace_*` tool family (`callers`, `callees`, `path`, `file`, `module`, `service`, `service_path`, `module_service`).
*   **Nesting & Recursion Prevention:** Prevents nesting within itself (`seer_batch` cannot call another `seer_batch`), securing the server against recursive stack overflows.
*   **In-Process Mirroring:** Standard registration is wrapped in a `registerTool` decorator that mirrors every handler inside an in-memory handlers map, allowing `seer_batch` and `seer_trace` to dispatch internally without second round-trip MCP payloads.

---

## 5. Derived Conceptual Intelligence

On top of basic syntactic extraction, Seer computes three high-value graph-derived signals:

### 5.1 Louvain Module Clustering
Seer builds a weighted, undirected file graph where import edges have weight 2, call edges weight 1, and test edges weight 3. A Louvain community detection algorithm runs after each graph-mutating index, grouping files into highly cohesive **Modules**.
*   This allows agents to orient at module level (e.g., locating the `Billing` or `Auth` subsystems) before scanning raw directories.

### 5.2 Tests-as-Behavioral-Specs
Instead of returning a flat list of test files, `seer behavior` ranks tests that exercise a target symbol based on specificity:
1.  **Direct Call:** Test functions directly invoking the symbol.
2.  **Naming Convention:** Test files matching the symbol's file name.
3.  **Graph Distance:** Bounded call-graph steps from tests to the symbol.
4.  **Assertion Counts & Recency:** Boosts tests that have high assert densities or recent commits.

### 5.3 Decomposed Edit-Risk Profile
`seer_risk` calculates a deterministic score based on decomposed signals, showing *why* a change is risky:
*   **Fan-in / Transitive dependents:** The symbol has wide downstream usage.
*   **Route exposure:** The symbol sits directly on a public API endpoint.
*   **Test gap:** Direct test coverage is absent or weak.
*   **Boundary crossing:** Modifying this symbol alters interfaces across monorepo packages.
*   **Complexity & Churn:** The symbol is cyclomatically complex and has high historical commit frequency.

---

## 6. Seer-Onboarding Specification

Seer-Onboarding consumes the deterministic facts stored in Core and translates them into a human-first learning platform.

### 6.1 Knowledge Hierarchy
Onboarding visualizes repositories using a structured L0 to L5 hierarchy:

```text
  L5 System      Repo-wide architecture map, entry points, and domain glossary.
  L4 Subsystem   Aggregated summaries over related logical domains.
  L3 Module      Generated conceptual summaries over Louvain modules.
  L2 File        Purpose descriptions and key symbol highlights.
  L1 Graph       Core symbols, calls, and service links (from Seer-Core).
  L0 Source      Raw source files, loaded lazily.
```

### 6.2 The Local Onboarding Portal
A lightweight local web interface that launches in seconds:
*   **Architecture Explorer:** Interactive 2D visualization of Louvain modules, monorepo boundaries, and service-link connections.
*   **Monaco Context Companion:** A sidecar code editor that surfaces ranked tests, blast radius, and symbol blame chains as you hover over code.
*   **Temporal Time-Travel Timeline:** Visualizes how modules and boundaries evolved, mapping commits to logical "epochs" (e.g. "auth-overhaul").
*   **Interactive Katas:** Automatically extracts historically small pull requests to create interactive local coding exercises, allowing developers to practice real codebase changes.

---

## 7. Business & Launch Strategy

### 7.1 Launch Wedge (Symbol-Level History)
Rather than launching as a generic codebase search engine, Seer-Core will lead with a clear, memorably pitched differentiator:

> Seer-Core is the local MCP server that gives AI agents per-function git history, not just per-file churn.

This serves as a high-leverage wedge because:
*   It provides immediate, concrete value to developer agents before they touch code.
*   It is completely local, fast, and does not require third-party LLM costs.
*   It acts as the foundation for the temporal time-travel UI in the Onboarding portal.

### 7.2 Monetization & Open-Core Model
*   **OSS Core (Local):** Zero-config tree-sitter parser, SQLite indexer, watcher, JIT freshness, and all MCP navigation tools. Free and open source.
*   **Pro (Single-Developer Portal):** The local Onboarding website, Monaco companion editor, time-travel timeline, and local katas.
*   **Team / Cloud (Commercial):** Hosted collaborative portals, CI-generated `.seerbundle` sharing networks, SSO/SAML, security audit logs, and developer onboarding dashboards.
