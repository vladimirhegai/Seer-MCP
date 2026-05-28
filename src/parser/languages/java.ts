import type Parser from 'web-tree-sitter';
import type { SymbolDef, RouteDef, ConfigKeyRead } from '../../types.js';
import type { LanguageExtractor } from '../walker.js';
import { firstLine } from '../walker.js';

const JAVA_BRANCH_NODES = new Set<string>([
  'if_statement', 'while_statement', 'do_statement', 'for_statement', 'enhanced_for_statement',
  'switch_label', 'catch_clause', 'ternary_expression',
]);

const JAVA_NESTING_NODES = new Set<string>([
  'if_statement', 'while_statement', 'do_statement', 'for_statement', 'enhanced_for_statement',
  'switch_block', 'catch_clause',
]);

const SPRING_REQUEST_ANNOTATIONS: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  PatchMapping: 'PATCH',
  DeleteMapping: 'DELETE',
};

export const javaExtractor: LanguageExtractor = {
  languageName: 'java',
  extensions: ['.java'],
  branchNodeTypes: JAVA_BRANCH_NODES,
  nestingNodeTypes: JAVA_NESTING_NODES,

  tryExtractDefinition(node: Parser.SyntaxNode): SymbolDef | null {
    switch (node.type) {
      case 'method_declaration': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return {
          name: nameNode.text,
          kind: 'method',
          lineStart: node.startPosition.row,
          lineEnd:   node.endPosition.row,
          colStart:  node.startPosition.column,
          colEnd:    node.endPosition.column,
          signature: firstLine(node),
        };
      }

      case 'class_declaration': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return {
          name: nameNode.text,
          kind: 'class',
          lineStart: node.startPosition.row,
          lineEnd:   node.endPosition.row,
          colStart:  node.startPosition.column,
          colEnd:    node.endPosition.column,
          signature: firstLine(node),
        };
      }

      case 'interface_declaration': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return {
          name: nameNode.text,
          kind: 'interface',
          lineStart: node.startPosition.row,
          lineEnd:   node.endPosition.row,
          colStart:  node.startPosition.column,
          colEnd:    node.endPosition.column,
          signature: firstLine(node),
        };
      }

      case 'constructor_declaration': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return {
          name: nameNode.text,
          kind: 'constructor',
          lineStart: node.startPosition.row,
          lineEnd:   node.endPosition.row,
          colStart:  node.startPosition.column,
          colEnd:    node.endPosition.column,
          signature: firstLine(node),
        };
      }

      case 'enum_declaration': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return {
          name: nameNode.text,
          kind: 'enum',
          lineStart: node.startPosition.row,
          lineEnd:   node.endPosition.row,
          colStart:  node.startPosition.column,
          colEnd:    node.endPosition.column,
          signature: firstLine(node),
        };
      }

      default:
        return null;
    }
  },

  tryExtractCallName(node: Parser.SyntaxNode): string | null {
    if (node.type === 'method_invocation') {
      return node.childForFieldName('name')?.text ?? null;
    }
    return null;
  },

  tryExtractImport(node: Parser.SyntaxNode): string | null {
    if (node.type === 'import_declaration') {
      for (const child of node.children) {
        if (child.type === 'scoped_identifier' || child.type === 'identifier') {
          return child.text;
        }
      }
    }
    return null;
  },

  /**
   * Spring Boot mapping annotations on methods:
   *   @GetMapping("/users")
   *   @PostMapping(value = "/users")
   *   @RequestMapping(value = "/x", method = RequestMethod.GET)
   *
   * Class-level @RequestMapping("/api") is treated as a PREFIX for every
   * mapping annotation on that class's methods, not as a route on its own.
   * We never emit a route from a class-level annotation directly — that
   * was a pre-existing bug that produced bogus entries like `GET /api`.
   *
   * The annotation node sits above the method_declaration; we extract on
   * the annotation and walk up to the method for the handler name, then
   * walk further up to find the enclosing class to pick up any class-level
   * @RequestMapping prefix.
   */
  tryExtractRoute(node: Parser.SyntaxNode): RouteDef[] | null {
    if (node.type !== 'annotation' && node.type !== 'marker_annotation') return null;
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return null;
    const annName = nameNode.text;
    const method = SPRING_REQUEST_ANNOTATIONS[annName];

    // The enclosing declaration (method vs class) decides whether this
    // annotation is a route or a prefix. modifiers are the syntactic parent
    // of an annotation in tree-sitter-java; the method/class is one more
    // level up.
    let enclosing: Parser.SyntaxNode | null = node.parent;
    while (enclosing && enclosing.type === 'modifiers') enclosing = enclosing.parent;
    if (!enclosing) return null;
    // Class-level annotations: not a route on their own. Their path becomes
    // a prefix for method-level routes inside the class; the method-level
    // pass below walks up to find this annotation and prepends its path.
    if (enclosing.type === 'class_declaration' || enclosing.type === 'interface_declaration') {
      return null;
    }
    // Anything other than a method/constructor: not a route.
    if (enclosing.type !== 'method_declaration' && enclosing.type !== 'constructor_declaration') {
      return null;
    }

    const routePath = readSpringPath(node);

    let detectedMethod = method;
    const args = node.childForFieldName('arguments');
    if (annName === 'RequestMapping' && args) {
      for (const child of args.namedChildren) {
        if (child.type === 'element_value_pair') {
          const kn = child.childForFieldName('key');
          const vn = child.childForFieldName('value');
          if (kn?.text === 'method' && vn) {
            const txt = vn.text.replace(/.*RequestMethod\./, '').replace(/[,}\s]/g, '');
            if (txt) detectedMethod = txt;
          }
        }
      }
      if (!detectedMethod) detectedMethod = 'GET';
    }

    if (!detectedMethod) return null;

    // Walk up to the enclosing class to pick up a class-level @RequestMapping
    // prefix (if any). Concatenate with care so we don't end up with double
    // slashes or missing slashes.
    const prefix = findSpringClassPrefix(enclosing);
    const fullPath = joinSpringPaths(prefix, routePath);
    if (!fullPath) return null;

    const handlerName = enclosing.childForFieldName('name')?.text;

    return [{
      method: detectedMethod,
      path: fullPath,
      framework: 'spring',
      handlerName,
      line: node.startPosition.row,
    }];
  },

  /**
   * Java env reads: `System.getenv("NAME")`.
   */
  tryExtractConfigKey(node: Parser.SyntaxNode): ConfigKeyRead | null {
    if (node.type !== 'method_invocation') return null;
    const obj = node.childForFieldName('object');
    const name = node.childForFieldName('name');
    if (!obj || !name) return null;
    if (obj.text === 'System' && name.text === 'getenv') {
      const args = node.childForFieldName('arguments');
      if (!args) return null;
      for (const child of args.namedChildren) {
        if (child.type === 'string_literal') {
          const key = stripJavaQuotes(child.text);
          if (key) return { key, source: 'env', line: node.startPosition.row };
          break;
        }
      }
    }
    return null;
  },
};

function stripJavaQuotes(s: string): string {
  return s.replace(/^"|"$/g, '');
}

/**
 * Read the `value=`/`path=` (or first positional string-literal) from a
 * Spring mapping annotation. Returns '' when no path is given — which is
 * a perfectly valid mapping (`@GetMapping` with class-level prefix only).
 */
function readSpringPath(annNode: Parser.SyntaxNode): string {
  const args = annNode.childForFieldName('arguments');
  if (!args) return '';
  for (const child of args.namedChildren) {
    if (child.type === 'string_literal') return stripJavaQuotes(child.text);
    if (child.type === 'element_value_pair') {
      const kn = child.childForFieldName('key');
      const vn = child.childForFieldName('value');
      if ((kn?.text === 'value' || kn?.text === 'path') && vn?.type === 'string_literal') {
        return stripJavaQuotes(vn.text);
      }
    }
  }
  return '';
}

/**
 * Walk up from a method_declaration to its enclosing class_declaration and
 * return the path component of a class-level @RequestMapping(...) — or '' if
 * the class has no such annotation. Bare class-level @RestController without
 * a @RequestMapping yields ''.
 */
function findSpringClassPrefix(methodOrCtor: Parser.SyntaxNode): string {
  let n: Parser.SyntaxNode | null = methodOrCtor.parent;
  while (n) {
    if (n.type === 'class_declaration' || n.type === 'interface_declaration') break;
    n = n.parent;
  }
  if (!n) return '';
  // Class-level annotations sit in a `modifiers` block as the first child of
  // the class_declaration in tree-sitter-java.
  for (const child of n.children) {
    if (child.type !== 'modifiers') continue;
    for (const m of child.namedChildren) {
      if (m.type !== 'annotation' && m.type !== 'marker_annotation') continue;
      const nm = m.childForFieldName('name');
      if (nm?.text !== 'RequestMapping') continue;
      return readSpringPath(m);
    }
  }
  return '';
}

/**
 * Join a Spring class-level prefix and method-level path. Empty strings are
 * dropped; consecutive slashes are collapsed. Returns '' when both inputs
 * are empty.
 *   ('/api',  '/users')      → '/api/users'
 *   ('/api',  '')            → '/api'
 *   ('',      '/users')      → '/users'
 *   ('/api/', '/users')      → '/api/users'
 *   ('',      '')            → ''
 */
function joinSpringPaths(prefix: string, route: string): string {
  if (!prefix && !route) return '';
  if (!prefix) return route;
  if (!route)  return prefix;
  const a = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const b = route.startsWith('/') ? route : '/' + route;
  return a + b;
}
