import type Parser from 'web-tree-sitter';
import type { SymbolDef, SymbolRef, FileExtraction, RouteDef, ConfigKeyRead } from '../types.js';

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
 */
export function walkTree(
  root: Parser.SyntaxNode,
  extractor: LanguageExtractor,
): FileExtraction {
  const extraction: FileExtraction = {
    language: extractor.languageName as FileExtraction['language'],
    definitions: [],
    references: [],
    importedModules: [],
    routes: [],
    configKeys: [],
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

  function walk(node: Parser.SyntaxNode): void {
    const def = extractor.tryExtractDefinition(node);
    if (def) {
      const disambig = pushName(def.name);
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
        def.cognitive  = m.cognitive;
        def.maxNesting = m.maxNesting;
        def.loc        = m.loc;
      } else if (def.kind === 'function' || def.kind === 'method' || def.kind === 'constructor') {
        // LOC even without branchNodeTypes — cheap and useful.
        def.loc = countNonBlankLines(node);
      }

      extraction.definitions.push(def);
      for (const child of node.children) walk(child);
      popName();
      return;
    }

    const ctxName = extractor.tryExtractContextName?.(node);
    if (ctxName) {
      defStack.push(ctxName);
      siblingCounts.push(new Map());
      for (const child of node.children) walk(child);
      popName();
      return;
    }

    // Routes are checked before calls because route registrations are
    // themselves call expressions in JS frameworks (`app.get("/x", handler)`).
    // Returning routes doesn't prevent the call from also being recorded —
    // the route registration call is itself useful in the call graph.
    const routes = extractor.tryExtractRoute?.(node);
    if (routes && routes.length > 0) {
      for (const r of routes) extraction.routes!.push(r);
    }

    const configKey = extractor.tryExtractConfigKey?.(node);
    if (configKey) {
      configKey.callerName = defStack.length > 0 ? defStack.join('.') : '';
      extraction.configKeys!.push(configKey);
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
