import type Parser from 'web-tree-sitter';
import type { SymbolDef, RouteDef, ConfigKeyRead } from '../../types.js';
import type { LanguageExtractor } from '../walker.js';
import { firstLine } from '../walker.js';

const PY_BRANCH_NODES = new Set<string>([
  'if_statement', 'elif_clause', 'while_statement', 'for_statement',
  'try_statement', 'except_clause', 'case_clause',
  'conditional_expression',
]);

const PY_NESTING_NODES = new Set<string>([
  'if_statement', 'while_statement', 'for_statement', 'try_statement', 'except_clause',
  'match_statement',
]);

// FastAPI / Flask decorator method names. Flask uses `app.route(...)` with a
// `methods=[...]` kwarg; FastAPI has per-method decorators (`@app.get(...)`).
const FASTAPI_DECORATOR_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

export const pythonExtractor: LanguageExtractor = {
  languageName: 'python',
  extensions: ['.py', '.pyw'],
  branchNodeTypes: PY_BRANCH_NODES,
  nestingNodeTypes: PY_NESTING_NODES,

  tryExtractDefinition(node: Parser.SyntaxNode): SymbolDef | null {
    switch (node.type) {
      case 'function_definition': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return {
          name: nameNode.text,
          kind: 'function',
          lineStart: node.startPosition.row,
          lineEnd:   node.endPosition.row,
          colStart:  node.startPosition.column,
          colEnd:    node.endPosition.column,
          signature: firstLine(node),
        };
      }
      case 'class_definition': {
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
      default:
        return null;
    }
  },

  tryExtractCallName(node: Parser.SyntaxNode): string | null {
    if (node.type !== 'call') return null;
    const funcNode = node.childForFieldName('function');
    if (!funcNode) return null;

    if (funcNode.type === 'identifier') return funcNode.text;

    if (funcNode.type === 'attribute') {
      return funcNode.childForFieldName('attribute')?.text ?? null;
    }

    return null;
  },

  tryExtractImport(node: Parser.SyntaxNode): string | null {
    if (node.type === 'import_statement') {
      const names = node.childrenForFieldName('name');
      return names[0]?.text ?? null;
    }
    if (node.type === 'import_from_statement') {
      return node.childForFieldName('module_name')?.text ?? null;
    }
    return null;
  },

  /**
   * FastAPI / Flask route decorators:
   *   @app.get("/users")           → FastAPI
   *   @router.post("/items")       → FastAPI router
   *   @app.route("/x", methods=["GET", "POST"])  → Flask
   *
   * The decorator node sits ABOVE the function_definition in tree-sitter; we
   * detect when we're on a decorator and emit one route per HTTP method. The
   * decorated function's name becomes the handler.
   */
  tryExtractRoute(node: Parser.SyntaxNode): RouteDef[] | null {
    if (node.type !== 'decorator') return null;
    // decorator → expression → call(_object.attr, args)
    const exprChild = node.namedChildren[0];
    if (!exprChild || exprChild.type !== 'call') return null;
    const fn = exprChild.childForFieldName('function');
    if (!fn || fn.type !== 'attribute') return null;
    const methodName = fn.childForFieldName('attribute')?.text;
    if (!methodName) return null;

    const args = exprChild.childForFieldName('arguments');
    if (!args) return null;

    // First positional arg is the path.
    let routePath: string | null = null;
    for (const child of args.namedChildren) {
      if (child.type === 'string') { routePath = stripPyQuotes(child.text); break; }
      if (child.type === 'concatenated_string') { routePath = stripPyQuotes(child.text); break; }
      if (child.type === 'keyword_argument') break; // first kwarg means positional path is missing
    }
    if (!routePath) return null;

    // Find the decorated function's name (the sibling/parent function_definition).
    let handlerName: string | undefined;
    const parent = node.parent;
    if (parent && parent.type === 'decorated_definition') {
      const def = parent.childForFieldName('definition');
      if (def) {
        const nm = def.childForFieldName('name');
        if (nm) handlerName = nm.text;
      }
    }

    if (FASTAPI_DECORATOR_METHODS.has(methodName.toLowerCase())) {
      return [{
        method: methodName.toUpperCase(),
        path: routePath,
        framework: 'fastapi',
        handlerName,
        line: node.startPosition.row,
      }];
    }

    // Flask: @app.route("/x", methods=["GET", ...])
    if (methodName === 'route') {
      const methods: string[] = [];
      for (const child of args.namedChildren) {
        if (child.type === 'keyword_argument') {
          const nameNode = child.childForFieldName('name');
          const value = child.childForFieldName('value');
          if (nameNode?.text === 'methods' && value && value.type === 'list') {
            for (const m of value.namedChildren) {
              if (m.type === 'string') methods.push(stripPyQuotes(m.text).toUpperCase());
            }
          }
        }
      }
      const finalMethods = methods.length > 0 ? methods : ['GET'];
      return finalMethods.map(m => ({
        method: m,
        path: routePath!,
        framework: 'flask',
        handlerName,
        line: node.startPosition.row,
      }));
    }

    return null;
  },

  /**
   * Python env var reads: `os.getenv("NAME")`, `os.environ["NAME"]`,
   * `os.environ.get("NAME")`. `getenv("X", "default")` also handled.
   */
  tryExtractConfigKey(node: Parser.SyntaxNode): ConfigKeyRead | null {
    // os.getenv / os.environ.get / dotenv.get
    if (node.type === 'call') {
      const fn = node.childForFieldName('function');
      if (fn && fn.type === 'attribute') {
        const obj = fn.childForFieldName('object');
        const attr = fn.childForFieldName('attribute');
        if (!obj || !attr) return null;
        if (attr.text === 'getenv' && obj.text === 'os') {
          return firstStringArg(node, 'env');
        }
        if (attr.text === 'get' && obj.type === 'attribute') {
          // os.environ.get("X")
          const oo = obj.childForFieldName('object');
          const oa = obj.childForFieldName('attribute');
          if (oo?.text === 'os' && oa?.text === 'environ') {
            return firstStringArg(node, 'env');
          }
        }
      }
    }
    // os.environ["NAME"]
    if (node.type === 'subscript') {
      const value = node.childForFieldName('value');
      const subscript = node.childForFieldName('subscript');
      if (value && subscript && value.type === 'attribute') {
        const obj = value.childForFieldName('object');
        const attr = value.childForFieldName('attribute');
        if (obj?.text === 'os' && attr?.text === 'environ' && subscript.type === 'string') {
          const key = stripPyQuotes(subscript.text);
          if (key) return { key, source: 'env', line: node.startPosition.row };
        }
      }
    }
    return null;
  },
};

function firstStringArg(callNode: Parser.SyntaxNode, source: 'env' | 'config'): ConfigKeyRead | null {
  const args = callNode.childForFieldName('arguments');
  if (!args) return null;
  for (const child of args.namedChildren) {
    if (child.type === 'string') {
      const key = stripPyQuotes(child.text);
      if (key) return { key, source, line: callNode.startPosition.row };
      return null;
    }
    if (child.type === 'keyword_argument') return null;
  }
  return null;
}

function stripPyQuotes(s: string): string {
  // Python strings can be prefixed (r"...", b"...", f"...") — strip prefix
  // then the quote pair. Triple quotes get stripped to inner content.
  let t = s;
  // Strip prefix letters
  while (t.length > 0 && /[a-zA-Z]/.test(t[0])) t = t.slice(1);
  if (t.startsWith('"""') && t.endsWith('"""')) return t.slice(3, -3);
  if (t.startsWith("'''") && t.endsWith("'''")) return t.slice(3, -3);
  return t.replace(/^['"]|['"]$/g, '');
}
