import type Parser from 'web-tree-sitter';
import type { SymbolDef, FileExtraction, RouteDef, ConfigKeyRead, ServiceCallDef } from '../types.js';

export interface LanguageExtractor {
  /** tree-sitter language name (used to load the WASM grammar) */
  languageName: string;
  extensions: string[];
  /** Return a SymbolDef if this node is a top-level definition, else null */
  tryExtractDefinition(node: Parser.SyntaxNode): SymbolDef | null;
  /** Return the callee name if this node is a call/reference, else null */
  tryExtractCallName(node: Parser.SyntaxNode): string | null;
  /** Return the imported module/path if this node is an import, else null */
  tryExtractImport(node: Parser.SyntaxNode): string | null;
  /**
   * Optional: return a name for nodes that supply naming context but are not
   * themselves symbols (e.g. Rust `impl AuthService { ... }`).
   */
  tryExtractContextName?(node: Parser.SyntaxNode): string | null;

  /**
   * Optional: extract one or more HTTP routes from a node. Languages return
   * different shapes (Python decorators vs JS call_expression on app), so the
   * extractor owns the recognizer.
   */
  tryExtractRoute?(node: Parser.SyntaxNode): RouteDef[] | null;

  /** Optional: extract a config/env key read from a node. */
  tryExtractConfigKey?(node: Parser.SyntaxNode): ConfigKeyRead | null;

  /**
   * Optional: extract zero-or-more outbound service calls from a node.
   * Languages return different shapes for clients (Python `requests.get('/x')`
   * vs JS `fetch('/x')` vs Go `http.Get('/x')`), so the extractor owns the
   * recognizer. Returns null when the node is not a service-call site.
   */
  tryExtractServiceCalls?(node: Parser.SyntaxNode): ServiceCallDef[] | null;

  /**
   * Set of tree-sitter node types that count as control-flow branches for
   * cyclomatic/cognitive complexity. Optional; languages that omit this
   * leave complexity at null on every symbol.
   */
  branchNodeTypes?: ReadonlySet<string>;

  /**
   * Optional set of node types that increase nesting depth for cognitive
   * complexity. If omitted, defaults to `branchNodeTypes` minus the
   * "non-nesting" branches (logical operators, ternaries).
   */
  nestingNodeTypes?: ReadonlySet<string>;

  /**
   * Optional: list of tree-sitter node types that may produce a
   * definition / call / import / route / config-key / context name on this
   * extractor. Used by the parser to compile a Tree-Sitter Query that bulk-
   * collects candidate nodes in one tree pass, so the walker can skip the
   * `tryExtract*` calls on the ~95% of nodes that can never match anything.
   *
   * This is purely a performance optimization — the extractor's `tryExtract*`
   * functions still own all semantic decisions (body gates, qualified-name
   * resolution, overload disambiguation, route vs prefix, etc.). The list
   * must be a SUPERSET of every node type any `tryExtract*` may accept;
   * missing a type means whole categories of extracted things go silently
   * unindexed. The fallback walker (`walkTree` with no candidate set) stays
   * available for languages that omit this list or for diagnostics.
   */
  candidateNodeTypes?: readonly string[];
}

/**
 * Walk the tree, tracking the enclosing definition stack so that calls can
 * be attributed to their containing function/method.
 *
 * v4 additions:
 *   - For function/method/constructor symbols, computes cyclomatic + cognitive
 *     complexity + max nesting depth + LOC by walking the def's subtree once.
 *   - Calls `tryExtractRoute` / `tryExtractConfigKey` per node and threads the
 *     results back through `FileExtraction.routes` / `.configKeys`.
 *
 * Optional `candidates` parameter: when provided, the walker only invokes the
 * extractor's `tryExtract*` callbacks on nodes whose id is in the set. Tree
 * structure is still fully traversed so the def-stack stays accurate; we just
 * skip the per-node switch on non-candidates. Pass `undefined` (the default)
 * to run as a full baseline walker.
 */
export function walkTree(
  root: Parser.SyntaxNode,
  extractor: LanguageExtractor,
  candidates?: ReadonlySet<number>,
): FileExtraction {
  const extraction: FileExtraction = {
    language: extractor.languageName as FileExtraction['language'],
    definitions: [],
    references: [],
    importedModules: [],
    routes: [],
    configKeys: [],
    serviceCalls: [],
  };

  const defStack: string[] = [];
  // One counter-map per nesting level tracks how many times each short name
  // has been pushed as a direct child, so overloads get distinct suffixes.
  const siblingCounts: Map<string, number>[] = [new Map()];

  function pushName(name: string): string {
    const counters = siblingCounts[siblingCounts.length - 1];
    const n = counters.get(name) ?? 0;
    counters.set(name, n + 1);
    const disambig = n === 0 ? name : `${name}#${n}`;
    defStack.push(disambig);
    siblingCounts.push(new Map());
    return disambig;
  }

  function popName(): void {
    defStack.pop();
    siblingCounts.pop();
  }

  // When `candidates` is provided, only nodes whose id is in the set get
  // their tryExtract* callbacks fired. Tree structure is still fully walked
  // so the def-stack remains correct across non-candidate ancestors.
  const useCandidates = candidates !== undefined;

  function walk(node: Parser.SyntaxNode): void {
    const isCandidate = useCandidates ? candidates!.has(node.id) : true;

    const def = isCandidate ? extractor.tryExtractDefinition(node) : null;
    if (def) {
      // Out-of-line / qualified definitions (e.g. C++ `Vec::dot` defined at
      // namespace scope) carry extra owning-scope segments that aren't on the
      // lexical def stack. Fold them into the local name so the qualified name
      // reflects the true owner, and key overload disambiguation on the full
      // (scope + name) so `Foo::bar` and `Baz::bar` don't collapse together.
      const localName = def.scopePath && def.scopePath.length > 0
        ? `${def.scopePath.join('.')}.${def.name}`
        : def.name;
      const disambig = pushName(localName);
      def.qualifiedName =
        defStack.length === 1
          ? disambig
          : `${defStack.slice(0, -1).join('.')}.${disambig}`;

      // Compute complexity for behavior-bearing symbols only (kinds where
      // cyclomatic complexity is meaningful).
      if (
        (def.kind === 'function' || def.kind === 'method' || def.kind === 'constructor') &&
        extractor.branchNodeTypes
      ) {
        const m = measureComplexity(node, extractor.branchNodeTypes, extractor.nestingNodeTypes);
        def.cyclomatic = m.cyclomatic;
        def.cognitive = m.cognitive;
        def.maxNesting = m.maxNesting;
        def.loc = m.loc;
      } else if (def.kind === 'function' || def.kind === 'method' || def.kind === 'constructor') {
        // LOC even without branchNodeTypes — cheap and useful.
        def.loc = countNonBlankLines(node);
      }

      extraction.definitions.push(def);
      for (const child of node.children) walk(child);
      popName();
      return;
    }

    const ctxName = isCandidate ? extractor.tryExtractContextName?.(node) : null;
    if (ctxName) {
      defStack.push(ctxName);
      siblingCounts.push(new Map());
      for (const child of node.children) walk(child);
      popName();
      return;
    }

    if (isCandidate) {
      // Routes are checked before calls because route registrations are
      // themselves call expressions in JS frameworks (`app.get("/x", handler)`).
      // Returning routes doesn't prevent the call from also being recorded —
      // the route registration call is itself useful in the call graph.
      const routes = extractor.tryExtractRoute?.(node);
      let wasRoute = false;
      if (routes && routes.length > 0) {
        for (const r of routes) extraction.routes!.push(r);
        wasRoute = true;
      }

      const configKey = extractor.tryExtractConfigKey?.(node);
      if (configKey) {
        configKey.callerName = defStack.length > 0 ? defStack.join('.') : '';
        extraction.configKeys!.push(configKey);
      }

      // Skip service-call extraction on nodes that were already classified as
      // route registrations — `app.post('/api/x', handler)` is a server-side
      // mount, not a client dialing /api/x. Without this guard the resolver
      // would see two service_calls for every route and link the route handler
      // to its own registration site.
      const svcCalls = !wasRoute ? extractor.tryExtractServiceCalls?.(node) : null;
      if (svcCalls && svcCalls.length > 0) {
        const callerName = defStack.length > 0 ? defStack.join('.') : '';
        for (const sc of svcCalls) {
          sc.callerName = sc.callerName ?? callerName;
          extraction.serviceCalls!.push(sc);
        }
      }

      const callee = extractor.tryExtractCallName(node);
      if (callee) {
        const callerName = defStack.length > 0 ? defStack.join('.') : '';
        extraction.references.push({
          calleeName: callee,
          callerName,
          kind: 'call',
          line: node.startPosition.row,
        });
      }

      const importPath = extractor.tryExtractImport(node);
      if (importPath) {
        extraction.importedModules.push(importPath);
      }
    }

    for (const child of node.children) walk(child);
  }

  walk(root);
  return extraction;
}

export function fieldText(
  node: Parser.SyntaxNode,
  fieldName: string,
): string | null {
  return node.childForFieldName(fieldName)?.text ?? null;
}

export function firstLine(node: Parser.SyntaxNode, maxLen = 120): string {
  const text = node.text;
  const end = text.indexOf('\n');
  const line = end === -1 ? text : text.slice(0, end);
  return line.trim().slice(0, maxLen);
}

// ── Complexity computation ─────────────────────────────────────────────────────

/**
 * Walk a function/method subtree once and compute:
 *   - cyclomatic: 1 + count of branch nodes (if/while/for/case/catch/&&/||/?:)
 *   - cognitive: branch count + extra penalty for nesting depth
 *   - maxNesting: deepest nesting level reached inside the def body
 *   - loc: non-blank lines in the def's source span
 *
 * Definitions of "branch" come from the extractor — different grammars name
 * the same constructs differently (Python `if_statement` vs JS `if_statement`
 * are spelled identically, but Go has `if_statement` + `expression_switch_statement`).
 */
function measureComplexity(
  defNode: Parser.SyntaxNode,
  branchTypes: ReadonlySet<string>,
  nestingTypes?: ReadonlySet<string>,
): { cyclomatic: number; cognitive: number; maxNesting: number; loc: number } {
  let cyclomatic = 1;
  let cognitive = 0;
  let maxNesting = 0;
  const nesting = nestingTypes ?? branchTypes;

  function visit(n: Parser.SyntaxNode, depth: number): void {
    if (n === defNode) {
      for (const child of n.children) visit(child, 0);
      return;
    }
    let newDepth = depth;
    if (branchTypes.has(n.type)) {
      cyclomatic++;
      // Cognitive: +1 + current depth for every branch (so deeply nested
      // branches cost more). This matches Sonar's rough scoring.
      cognitive += 1 + depth;
    }
    if (nesting.has(n.type)) {
      newDepth = depth + 1;
      if (newDepth > maxNesting) maxNesting = newDepth;
    }
    for (const child of n.children) visit(child, newDepth);
  }
  visit(defNode, 0);

  const loc = countNonBlankLines(defNode);
  return { cyclomatic, cognitive, maxNesting, loc };
}

function countNonBlankLines(node: Parser.SyntaxNode): number {
  const text = node.text;
  if (!text) return 0;
  let count = 0;
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === 10) {
      const line = text.slice(start, i);
      if (line.trim().length > 0) count++;
      start = i + 1;
    }
  }
  return count;
}
