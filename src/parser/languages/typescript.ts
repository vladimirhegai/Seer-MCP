import type Parser from 'web-tree-sitter';
import type { SymbolDef, SymbolKind, RouteDef, ConfigKeyRead } from '../../types.js';
import type { LanguageExtractor } from '../walker.js';
import { firstLine } from '../walker.js';

// Branch nodes for cyclomatic / cognitive complexity. tree-sitter-typescript
// shares its node grammar with tree-sitter-javascript and tree-sitter-tsx,
// so this set covers all three.
const TS_BRANCH_NODES = new Set<string>([
  'if_statement',
  'switch_case',
  'switch_default',
  'while_statement',
  'do_statement',
  'for_statement',
  'for_in_statement',
  'for_of_statement',
  'catch_clause',
  'ternary_expression',
  'conditional_expression',
]);

const TS_NESTING_NODES = new Set<string>([
  'if_statement',
  'switch_statement',
  'while_statement',
  'do_statement',
  'for_statement',
  'for_in_statement',
  'for_of_statement',
  'catch_clause',
]);

// HTTP method names used by Express/Fastify-style routers. Lower-cased because
// we compare against `member_expression.property` text.
const HTTP_METHODS = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all', 'use',
]);

// Handles .ts, .tsx, .js, .jsx via separate WASM grammars but shared extractor logic
export const typescriptExtractor: LanguageExtractor = {
  languageName: 'typescript',
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  branchNodeTypes: TS_BRANCH_NODES,
  nestingNodeTypes: TS_NESTING_NODES,

  tryExtractDefinition(node: Parser.SyntaxNode): SymbolDef | null {
    switch (node.type) {
      case 'function_declaration':
      case 'generator_function_declaration': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return mkDef(nameNode.text, 'function', node);
      }

      case 'class_declaration': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return mkDef(nameNode.text, 'class', node);
      }

      case 'method_definition': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        const isConstructor = nameNode.text === 'constructor';
        return mkDef(nameNode.text, isConstructor ? 'constructor' : 'method', node);
      }

      case 'interface_declaration': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return mkDef(nameNode.text, 'interface', node);
      }

      case 'type_alias_declaration': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return mkDef(nameNode.text, 'type', node);
      }

      case 'variable_declarator': {
        const nameNode = node.childForFieldName('name');
        const valueNode = node.childForFieldName('value');
        if (!nameNode || !valueNode) return null;
        if (
          valueNode.type === 'arrow_function' ||
          valueNode.type === 'function_expression' ||
          valueNode.type === 'generator_function'
        ) {
          return mkDef(nameNode.text, 'function', node);
        }
        return null;
      }

      default:
        return null;
    }
  },

  tryExtractCallName(node: Parser.SyntaxNode): string | null {
    if (node.type === 'call_expression') {
      const funcNode = node.childForFieldName('function');
      if (!funcNode) return null;

      if (funcNode.type === 'identifier') return funcNode.text;

      if (funcNode.type === 'member_expression') {
        return funcNode.childForFieldName('property')?.text ?? null;
      }

      return null;
    }

    if (node.type === 'new_expression') {
      const ctorNode = node.childForFieldName('constructor');
      if (!ctorNode) return null;
      if (ctorNode.type === 'identifier') return ctorNode.text;
      if (ctorNode.type === 'member_expression') {
        return ctorNode.childForFieldName('property')?.text ?? null;
      }
      return null;
    }

    return null;
  },

  tryExtractImport(node: Parser.SyntaxNode): string | null {
    if (node.type === 'import_statement') {
      return node.childForFieldName('source')?.text?.replace(/['"]/g, '') ?? null;
    }
    if (node.type === 'call_expression') {
      const funcNode = node.childForFieldName('function');
      if (funcNode?.text === 'require') {
        const args = node.childForFieldName('arguments');
        const firstArg = args?.namedChildren[0];
        if (firstArg?.type === 'string') {
          return firstArg.text.replace(/['"]/g, '');
        }
      }
    }
    return null;
  },

  /**
   * Recognize Express/Fastify-style route registrations:
   *   app.get('/users', handler)
   *   router.post('/login', handler)
   *   server.put('/items/:id', handler)
   *
   * Also handles Fastify object-style:
   *   app.route({ method: 'GET', url: '/users', handler: foo })
   *   app.route({ method: ['GET','POST'], url: '/users', handler: foo })
   * — only when method and url are string (or string-array) literals so it
   * stays deterministic. Returns one RouteDef per method when method is an
   * array.
   */
  tryExtractRoute(node: Parser.SyntaxNode): RouteDef[] | null {
    if (node.type !== 'call_expression') return null;
    const funcNode = node.childForFieldName('function');
    if (!funcNode || funcNode.type !== 'member_expression') return null;
    const prop = funcNode.childForFieldName('property');
    if (!prop) return null;
    const method = prop.text.toLowerCase();

    const args = node.childForFieldName('arguments');
    if (!args) return null;
    const named = args.namedChildren;
    if (named.length < 1) return null;

    // ── Fastify object-style: app.route({ method, url, handler }) ──────
    if (method === 'route') {
      const opts = named[0];
      if (opts.type !== 'object') return null;
      const fields = readObjectLiteralFields(opts);
      const urlNode = fields.get('url');
      const methodNode = fields.get('method');
      const handlerNode = fields.get('handler');
      if (!urlNode || !methodNode) return null;
      const urlStr = stringLiteralValue(urlNode);
      if (!urlStr || urlStr.length > 200) return null;
      const methods = stringOrStringArrayValues(methodNode);
      if (methods.length === 0) return null;
      const handlerName = handlerNode ? identifierLikeName(handlerNode) : undefined;
      return methods.map(m => ({
        method: m.toUpperCase(),
        path: urlStr,
        framework: 'fastify',
        handlerName,
        line: node.startPosition.row,
      }));
    }

    // ── Express/Fastify shorthand: app.<method>(path, handler) ──────────
    if (!HTTP_METHODS.has(method)) return null;

    // First arg must be a string literal route path
    const pathNode = named[0];
    if (pathNode.type !== 'string' && pathNode.type !== 'template_string') return null;
    const routePath = stripQuotes(pathNode.text);
    if (!routePath || routePath.length > 200) return null;

    // Last positional arg, if it's an identifier, is the handler name.
    let handlerName: string | undefined;
    for (let i = named.length - 1; i >= 1; i--) {
      const a = named[i];
      const found = identifierLikeName(a);
      if (found) { handlerName = found; break; }
      // Inline arrow / function — don't try to name it (would be an empty handler)
      if (a.type === 'arrow_function' || a.type === 'function_expression') break;
    }

    return [{
      method: method.toUpperCase(),
      path: routePath,
      framework: 'express',
      handlerName,
      line: node.startPosition.row,
    }];
  },

  /**
   * Static env var reads: `process.env.NAME` and `process.env["NAME"]`.
   * Also `import.meta.env.NAME` for Vite-style projects.
   */
  tryExtractConfigKey(node: Parser.SyntaxNode): ConfigKeyRead | null {
    if (node.type !== 'member_expression' && node.type !== 'subscript_expression') return null;

    // process.env.NAME → member_expression(member_expression("process","env"), "NAME")
    if (node.type === 'member_expression') {
      const obj = node.childForFieldName('object');
      const prop = node.childForFieldName('property');
      if (!obj || !prop) return null;
      if (obj.type === 'member_expression') {
        const objObj = obj.childForFieldName('object');
        const objProp = obj.childForFieldName('property');
        if (objObj && objProp) {
          if (objObj.text === 'process' && objProp.text === 'env') {
            return { key: prop.text, source: 'env', line: node.startPosition.row };
          }
          // import.meta.env.NAME
          if (objObj.type === 'member_expression') {
            const a = objObj.childForFieldName('object');
            const b = objObj.childForFieldName('property');
            if (a?.text === 'import' && b?.text === 'meta' && objProp.text === 'env') {
              return { key: prop.text, source: 'env', line: node.startPosition.row };
            }
          }
        }
      }
      return null;
    }

    // process.env["NAME"]
    if (node.type === 'subscript_expression') {
      const obj = node.childForFieldName('object');
      const idx = node.childForFieldName('index');
      if (!obj || !idx) return null;
      if (obj.type === 'member_expression') {
        const objObj = obj.childForFieldName('object');
        const objProp = obj.childForFieldName('property');
        if (objObj?.text === 'process' && objProp?.text === 'env'
            && (idx.type === 'string' || idx.type === 'template_string')) {
          const key = stripQuotes(idx.text);
          if (key) return { key, source: 'env', line: node.startPosition.row };
        }
      }
    }
    return null;
  },
};

function stripQuotes(s: string): string {
  return s.replace(/^[`'"]|[`'"]$/g, '');
}

/**
 * Read a TypeScript/JavaScript object literal into a key→value-node map.
 * Used by the Fastify route detector so we can pick out `url`, `method`,
 * and `handler` fields regardless of declaration order. Computed keys
 * (`[expr]: …`) are dropped — we only handle deterministic literal keys.
 */
function readObjectLiteralFields(obj: Parser.SyntaxNode): Map<string, Parser.SyntaxNode> {
  const out = new Map<string, Parser.SyntaxNode>();
  for (const prop of obj.namedChildren) {
    if (prop.type !== 'pair' && prop.type !== 'shorthand_property_identifier'
        && prop.type !== 'property_identifier') continue;
    if (prop.type === 'pair') {
      const k = prop.childForFieldName('key');
      const v = prop.childForFieldName('value');
      if (!k || !v) continue;
      let key: string | null = null;
      if (k.type === 'property_identifier' || k.type === 'identifier') key = k.text;
      else if (k.type === 'string' || k.type === 'template_string') key = stripQuotes(k.text);
      if (key) out.set(key, v);
    }
  }
  return out;
}

/** Strip quotes from a string-literal node, returning null for non-strings. */
function stringLiteralValue(node: Parser.SyntaxNode): string | null {
  if (node.type !== 'string' && node.type !== 'template_string') return null;
  return stripQuotes(node.text);
}

/**
 * Pull a list of string values out of a node that is either a single string
 * literal or an array literal containing only string literals. Anything
 * dynamic is dropped (`[]` returned) so route extraction stays deterministic.
 */
function stringOrStringArrayValues(node: Parser.SyntaxNode): string[] {
  const single = stringLiteralValue(node);
  if (single) return [single];
  if (node.type !== 'array') return [];
  const out: string[] = [];
  for (const el of node.namedChildren) {
    const v = stringLiteralValue(el);
    if (v) out.push(v);
  }
  return out;
}

/**
 * Return the identifier-like name of a node passed as a handler — either a
 * bare `identifier` (foo), a `member_expression` (a.b → "b"), or null for
 * inline functions/arrows where there's no name to extract.
 */
function identifierLikeName(node: Parser.SyntaxNode): string | undefined {
  if (node.type === 'identifier') return node.text;
  if (node.type === 'member_expression') {
    return node.childForFieldName('property')?.text ?? undefined;
  }
  return undefined;
}

function mkDef(name: string, kind: SymbolKind, node: Parser.SyntaxNode): SymbolDef {
  return {
    name,
    kind,
    lineStart: node.startPosition.row,
    lineEnd:   node.endPosition.row,
    colStart:  node.startPosition.column,
    colEnd:    node.endPosition.column,
    signature: firstLine(node),
  };
}
