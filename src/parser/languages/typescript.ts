import type Parser from 'web-tree-sitter';
import type { SymbolDef, SymbolKind, RouteDef, ConfigKeyRead, ServiceCallDef } from '../../types.js';
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

// HTTP CLIENT method names (axios/fetch-style outbound calls). Subset of
// HTTP_METHODS because clients don't expose all/use.
const HTTP_CLIENT_METHODS = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request',
]);

// Receiver names that strongly indicate a route REGISTRATION (Express/
// Fastify). Used to distinguish `app.get('/x', handler)` (route) from
// `axios.get('/x')` (client call). Lowercase + capitalised variants.
const ROUTER_RECEIVER_NAMES = new Set([
  'app', 'router', 'Router', 'server', 'fastify', 'expressApp', 'expressRouter',
  'api', 'apiRouter',
]);

// v9 Track-H — tRPC. Server-side procedure terminals (procedure.query(handler))
// and client-side call terminals (trpc.user.getById.query()). Server names are
// the ones that mark a node as a procedure DEFINITION; client names are how a
// call rendezvous through the tRPC proxy.
const TRPC_PROCEDURE_METHODS = new Set(['query', 'mutation', 'subscription']);

// Common tRPC procedure-builder identifiers. Hitting any of these in the
// receiver chain of a procedure.query(...) is what proves "this is a tRPC
// procedure definition" (vs. some other library that happens to expose a
// .query method).
const TRPC_PROCEDURE_BASES = new Set([
  'procedure', 'publicProcedure', 'protectedProcedure',
  'authedProcedure', 'adminProcedure', 'baseProcedure', 'loggedProcedure',
]);

// Terminal client methods on the tRPC proxy. Maps each to its operation kind
// so query/useQuery both become "query", mutate/useMutation become "mutation",
// subscribe/useSubscription become "subscription".
const TRPC_CLIENT_METHODS = new Map<string, 'query' | 'mutation' | 'subscription'>([
  ['query', 'query'],
  ['mutate', 'mutation'],
  ['useQuery', 'query'],
  ['useMutation', 'mutation'],
  ['useInfiniteQuery', 'query'],
  ['useSuspenseQuery', 'query'],
  ['useSubscription', 'subscription'],
  ['subscribe', 'subscription'],
]);

// Root receiver names that mark a member-chain as flowing through the tRPC
// client proxy. Anything ending in 'trpc' (case-insensitive) is accepted; we
// also allow bare 'api' / 'client' / 'rpc' since those are the other common
// proxy variable names in the wild.
const TRPC_CLIENT_ROOTS = new Set(['trpc', 'api', 'client', 'rpc']);
function isTrpcClientRoot(name: string): boolean {
  if (!name) return false;
  if (TRPC_CLIENT_ROOTS.has(name)) return true;
  const lower = name.toLowerCase();
  return lower.startsWith('trpc') || lower.endsWith('trpc');
}

// v9 Track-H — GraphQL.
//
// CLIENT METHODS — Apollo/urql/relay-style call terminals. Each maps to an
// operation kind. `useQuery` / `useMutation` / `useSubscription` are React-
// hook variants that take the document as their first arg.
const GRAPHQL_CLIENT_METHODS = new Map<string, 'query' | 'mutation' | 'subscription'>([
  ['query', 'query'],
  ['mutate', 'mutation'],
  ['mutation', 'mutation'],
  ['subscribe', 'subscription'],
  ['useQuery', 'query'],
  ['useMutation', 'mutation'],
  ['useSubscription', 'subscription'],
  ['useLazyQuery', 'query'],
]);

// Server-side resolver-map top-level keys. Anything nested under one of these
// is a resolver. We emit one route per resolver with operation = field name
// and method = the parent kind.
const GRAPHQL_RESOLVER_KEYS = new Set(['Query', 'Mutation', 'Subscription']);

// v9 Track-H — messaging protocols (Kafka / SQS / SNS / RabbitMQ / NATS /
// Redis pub-sub). Each producer/consumer pattern is recognized by its method
// name combined with a structural cue (option-object field name, receiver
// name). Keep this list tight — false positives here would link unrelated code.
type MsgProtocol = 'kafka' | 'sqs' | 'sns' | 'rabbitmq' | 'nats' | 'redis_pubsub';

// Receiver-name hints that boost confidence we're looking at the right lib.
const MSG_RECV_HINTS: Record<MsgProtocol, string[]> = {
  kafka:        ['producer', 'kafkaProducer', 'consumer', 'kafkaConsumer', 'kafka'],
  sqs:          ['sqs', 'sqsClient'],
  sns:          ['sns', 'snsClient'],
  rabbitmq:     ['channel', 'amqp', 'rabbit', 'rabbitmq', 'ch'],
  nats:         ['nc', 'nats', 'natsClient', 'jetstream'],
  redis_pubsub: ['redis', 'redisClient', 'pubsub', 'publisher', 'subscriber'],
};
function receiverHintsProtocol(recvName: string | null, protocol: MsgProtocol): boolean {
  if (!recvName) return false;
  const hints = MSG_RECV_HINTS[protocol] ?? [];
  if (hints.includes(recvName)) return true;
  const lower = recvName.toLowerCase();
  for (const h of hints) if (lower.includes(h.toLowerCase())) return true;
  return false;
}

// Union of every node type any tryExtract* on this extractor may accept.
// Must be a strict superset; missing a type would silently drop whatever the
// extractor would have emitted for it. The parser/index.ts compiles this into
// a Tree-Sitter Query and only fires the per-node extract calls on captures.
const TS_CANDIDATE_NODE_TYPES = [
  // tryExtractDefinition
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
  'method_definition',
  'interface_declaration',
  'type_alias_declaration',
  'variable_declarator',
  // tryExtractCallName + tryExtractImport + tryExtractRoute (all reuse call_expression)
  'call_expression',
  'new_expression',
  // tryExtractImport (also)
  'import_statement',
  // tryExtractConfigKey
  'member_expression',
  'subscript_expression',
] as const;

// Handles .ts, .tsx, .js, .jsx via separate WASM grammars but shared extractor logic
export const typescriptExtractor: LanguageExtractor = {
  languageName: 'typescript',
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  branchNodeTypes: TS_BRANCH_NODES,
  nestingNodeTypes: TS_NESTING_NODES,
  candidateNodeTypes: TS_CANDIDATE_NODE_TYPES,

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
    // v9 Track-H: GraphQL resolver-map detection. Resolver definitions live in
    // object literals (`const resolvers = { Query: { user: ... } }`) — not
    // call expressions, so we dispatch by node type up front.
    if (node.type === 'variable_declarator') {
      return tryExtractGraphqlResolverMap(node);
    }
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

    // ── v9 Track-H: tRPC procedure definition ─────────────────────────────
    // `procedure.query(handler)` / `publicProcedure.input(...).mutation(handler)`.
    // We recognize this BEFORE the HTTP path because the prop name `query` /
    // `mutation` / `subscription` would otherwise fall through to "unknown
    // method" and return null — which is fine, but we want to actually emit
    // a tRPC route row for the proc.
    if (TRPC_PROCEDURE_METHODS.has(prop.text)) {
      const trpcRoute = tryExtractTrpcProcedure(node, prop.text, named);
      if (trpcRoute) return [trpcRoute];
      // fall through; not a tRPC procedure — could still be HTTP `app.query(...)`
      // (extremely rare) so we don't return null yet.
    }

    // ── v9 Track-H: messaging CONSUMER detection ──────────────────────────
    // Kafka consumer.subscribe({ topic|topics }) / Rabbit channel.consume /
    // SQS receiveMessage / NATS nc.subscribe. The consumer side registers
    // a route so producer→consumer linking works through the same resolver
    // that handles HTTP route → service_call rendezvous.
    const consumerRoutes = tryExtractMessagingConsumer(node, funcNode, named);
    if (consumerRoutes) return consumerRoutes;

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

    // Distinguish a route REGISTRATION (`app.get('/x', handler)`) from a
    // client CALL (`axios.get('/x')`). A route registration must have either:
    //   (a) a router-like receiver name (app, router, server, Router, …), OR
    //   (b) ≥2 args where arg 2..N is a handler-shaped node (identifier,
    //       member_expression, arrow_function, or function_expression).
    // Without one of those it's almost certainly a client GET/POST call and
    // belongs to the service-call recognizer instead.
    const receiver = funcNode.childForFieldName('object');
    const recvName = receiver?.type === 'identifier' ? receiver.text : null;
    const isRouterReceiver = recvName !== null && ROUTER_RECEIVER_NAMES.has(recvName);
    let hasHandlerArg = false;
    if (named.length >= 2) {
      for (let i = 1; i < named.length; i++) {
        const a = named[i];
        if (a.type === 'identifier' || a.type === 'member_expression'
            || a.type === 'arrow_function' || a.type === 'function_expression') {
          hasHandlerArg = true;
          break;
        }
      }
    }
    if (!isRouterReceiver && !hasHandlerArg) return null;

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
   * Detect HTTP client calls — fetch / axios.{get,post,…} / http.* /
   * any.<method>(literalUrl, …). We only record a service call when the URL
   * argument is a string or template_string whose literal portion contains a
   * path-like fragment; everything else is ignored to keep results deterministic.
   *
   * The recognizer is intentionally conservative:
   *   fetch('/api/users')                              ← yes
   *   fetch(`${BASE_URL}/api/users`)                   ← yes (path lifted, env tagged)
   *   axios.get('/api/x')                              ← yes
   *   client.post('/api/x')                            ← yes (any bare member.<method>(literalUrl…))
   *   fetch(someVar)                                   ← no
   *   logger.get(record)                               ← no  (no string arg)
   */
  tryExtractServiceCalls(node: Parser.SyntaxNode): ServiceCallDef[] | null {
    // v9 Track-H: gql document definition — `const X = gql\`...\``. Emitted
    // as a sentinel service_call with framework='gql-doc' so the resolver can
    // map document identifiers used in client calls back to the operation's
    // top-level field name. Sentinels are filtered out of normal listings by
    // their framework value.
    if (node.type === 'variable_declarator') {
      const sentinel = tryExtractGqlDocDefinition(node);
      return sentinel ? [sentinel] : null;
    }
    if (node.type !== 'call_expression') return null;
    const funcNode = node.childForFieldName('function');
    if (!funcNode) return null;

    // ── v9 Track-H: tRPC client call ─────────────────────────────────────
    // trpc.user.getById.query({...}) / trpc.user.create.mutate(...) /
    // trpc.user.getById.useQuery(...). The terminal method is one of
    // TRPC_CLIENT_METHODS; the receiver chain must root at an identifier
    // that looks like a tRPC proxy (`trpc*`, `api`, `client`, `rpc`).
    if (funcNode.type === 'member_expression') {
      const propNode = funcNode.childForFieldName('property');
      const propTxt = propNode?.text ?? '';
      const trpcKind = TRPC_CLIENT_METHODS.get(propTxt);
      if (trpcKind) {
        const trpcCall = tryExtractTrpcClientCall(node, funcNode, propTxt, trpcKind);
        if (trpcCall) return [trpcCall];
        // fall through — not tRPC-shaped; the HTTP recognizers below may still match.
      }
    }

    // ── v9 Track-H: GraphQL client call ──────────────────────────────────
    // Apollo/urql/relay: client.query({ query: GET_USER }) / .mutate(...) /
    // useQuery(GET_USER) / useMutation(CREATE_USER). The operation name is
    // extracted from the document — either the imported const name (mapped
    // back to its gql definition during indexing — done via a second pass)
    // or directly from a gql template tagged template literal arg.
    //
    // For Seer-Core's purposes we emit the operation name found inline. The
    // caller-side gql tag also gets its own service_call emitted (covers
    // direct `gql\`query GetUser{...}\`` usage in client code).
    if (funcNode.type === 'identifier') {
      // Hook calls: useQuery(GET_USER, …) / useMutation(CREATE_USER, …)
      const hookKind = GRAPHQL_CLIENT_METHODS.get(funcNode.text);
      if (hookKind) {
        const gqlCall = tryExtractGraphqlClientCall(node, funcNode.text, hookKind);
        if (gqlCall) return [gqlCall];
      }
    } else if (funcNode.type === 'member_expression') {
      const propNode = funcNode.childForFieldName('property');
      const propTxt = propNode?.text ?? '';
      const objNode = funcNode.childForFieldName('object');
      const objTxt = objNode?.type === 'identifier' ? objNode.text : null;
      const isGqlClient = objTxt !== null &&
        (objTxt === 'client' || objTxt === 'apollo' || objTxt === 'apolloClient' ||
         objTxt === 'gqlClient' || objTxt === 'urql' || objTxt === 'urqlClient');
      const gqlKind = GRAPHQL_CLIENT_METHODS.get(propTxt);
      if (isGqlClient && gqlKind) {
        const gqlCall = tryExtractGraphqlClientCall(node, propTxt, gqlKind);
        if (gqlCall) return [gqlCall];
      }
    }

    // ── v9 Track-H: messaging PRODUCER detection ──────────────────────────
    // Kafka producer.send / SQS sendMessage / SNS publish / Rabbit publish |
    // sendToQueue / NATS publish / Redis publish. Consumer-side detection
    // lives in tryExtractRoute so consumers register as routes.
    if (funcNode.type === 'member_expression') {
      const msgCall = tryExtractMessagingProducer(node, funcNode);
      if (msgCall) return [msgCall];
    }

    let framework: string | null = null;
    let method: string | undefined;

    if (funcNode.type === 'identifier') {
      // bare fetch('/x')
      if (funcNode.text === 'fetch') framework = 'fetch';
      else return null;
    } else if (funcNode.type === 'member_expression') {
      const obj = funcNode.childForFieldName('object');
      const prop = funcNode.childForFieldName('property');
      if (!obj || !prop) return null;
      const propText = prop.text;
      const propLower = propText.toLowerCase();

      // axios.get / axios.post / axios.request / axios.{put,patch,delete,head,options}
      if (obj.type === 'identifier' && obj.text === 'axios' && HTTP_CLIENT_METHODS.has(propLower)) {
        framework = 'axios';
        method = methodFromName(propLower);
      } else if (obj.type === 'identifier' && obj.text === 'fetch' && propLower === 'fetch') {
        framework = 'fetch';
      } else if (HTTP_CLIENT_METHODS.has(propLower)) {
        // Generic client.<method>(literalUrl, …) — record it when the URL arg
        // is a string literal; the path itself is the strongest signal.
        framework = 'http-client';
        method = methodFromName(propLower);
      } else {
        return null;
      }
    } else {
      return null;
    }

    // First argument must be a string-like literal we can read.
    const args = node.childForFieldName('arguments');
    if (!args) return null;
    const first = args.namedChildren[0];
    if (!first) return null;

    let raw: string | null = null;
    let envKey: string | undefined;
    if (first.type === 'string') {
      raw = stripQuotes(first.text);
    } else if (first.type === 'template_string') {
      const lifted = readTemplateString(first);
      if (!lifted) return null;
      raw = lifted.text;
      envKey = lifted.envKey;
    } else {
      return null;
    }

    if (!raw) return null;
    // Path-y heuristic: starts with '/', or contains a '/' and looks like a URL.
    if (!looksLikeHttpTarget(raw)) return null;

    // For fetch(url, { method: 'POST' }) — peek at the options arg if available.
    if (!method && framework === 'fetch') {
      const opts = args.namedChildren[1];
      if (opts && opts.type === 'object') {
        const fields = readObjectLiteralFields(opts);
        const m = fields.get('method');
        if (m) {
          const v = stringLiteralValue(m);
          if (v) method = v.toUpperCase();
        }
      }
    }

    const def: ServiceCallDef = {
      protocol: 'http',
      method: method ?? 'ANY',
      rawTarget: raw.slice(0, 240),
      framework,
      line: node.startPosition.row,
      confidence: 0.85,
    };
    if (envKey) def.envKey = envKey;
    return [def];
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

/** Upper-cased HTTP verb derived from an axios/fetch method name. */
function methodFromName(name: string): string | undefined {
  if (name === 'request') return 'ANY';
  return name.toUpperCase();
}

/**
 * Read a template_string and return the literal portion plus the first
 * env-key-looking identifier referenced via process.env.X or import.meta.env.X
 * inside `${…}` placeholders. Used so `fetch(`${process.env.PAYMENT_URL}/charge`)`
 * still records `/charge` + `envKey = PAYMENT_URL`.
 *
 * Returns null when there's nothing useful to extract.
 */
function readTemplateString(node: Parser.SyntaxNode): { text: string; envKey?: string } | null {
  let text = '';
  let envKey: string | undefined;
  for (const child of node.namedChildren) {
    if (child.type === 'string_fragment') {
      text += child.text;
    } else if (child.type === 'template_substitution') {
      // ${…} — try to pull a process.env.X env key out of the expression.
      const inner = child.namedChildren[0];
      const k = tryPickEnvKey(inner);
      if (k) {
        if (!envKey) envKey = k;
        // An env-base substitution (`${process.env.PAYMENT_URL}/charge`) is the
        // host/base, not a path segment — drop it; the literal `/charge` tail is
        // what we match against routes.
      } else {
        // A dynamic, NON-env value embedded in the URL is almost always a path
        // parameter (`/api/users/${id}`). Emit a single placeholder segment so
        // the segment COUNT is preserved and the route-pattern matcher can line
        // it up against a parameterised route (`/api/users/:id`, `/users/{id}`,
        // `/users/<id>`). Without this the segment vanished and a real call
        // under-matched (e.g. `/api/users/${id}` collapsed to `/api/users`).
        text += ':param';
      }
    }
  }
  if (!text && !envKey) return null;
  return { text, envKey };
}

/** Walk an expression node looking for process.env.X / import.meta.env.X. */
function tryPickEnvKey(node: Parser.SyntaxNode | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'member_expression') {
    const obj = node.childForFieldName('object');
    const prop = node.childForFieldName('property');
    if (obj?.type === 'member_expression') {
      const objObj = obj.childForFieldName('object');
      const objProp = obj.childForFieldName('property');
      if (objObj?.text === 'process' && objProp?.text === 'env' && prop) return prop.text;
      if (objObj?.type === 'member_expression') {
        const a = objObj.childForFieldName('object');
        const b = objObj.childForFieldName('property');
        if (a?.text === 'import' && b?.text === 'meta' && objProp?.text === 'env' && prop) return prop.text;
      }
    }
  }
  // Fall back: walk children breadth-first up to a small bound so something
  // like `${(process.env.X ?? "y") + "/charge"}` still gets a hit.
  for (const child of node.namedChildren) {
    const found = tryPickEnvKey(child);
    if (found) return found;
  }
  return undefined;
}

/** Conservative path-likeness check. */
function looksLikeHttpTarget(s: string): boolean {
  if (!s) return false;
  if (s.startsWith('/')) return true;                              // /api/users
  if (/^https?:\/\//i.test(s)) return true;                         // https://x/y
  if (/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9_-]/.test(s)) return true;       // hostish/path
  return false;
}

/**
 * v9 Track-H — recognize a tRPC procedure definition.
 *
 * Returns a route with protocol='trpc' when the call_expression is the terminal
 * `.query(handler)` / `.mutation(handler)` / `.subscription(handler)` of a
 * tRPC procedure builder chain (`procedure.input(...).query(handler)`).
 *
 * Two signals must both hold:
 *   1. The receiver chain bottoms out at a known procedure-builder identifier
 *      (`procedure`, `publicProcedure`, `protectedProcedure`, …).
 *   2. The call is the VALUE of a `pair` in an object literal — that pair's
 *      KEY is the procedure name within its immediate router (we use this as
 *      `operation` and `path` so the resolver can rendezvous on it).
 *
 * When either signal is missing we return null so the caller can fall through
 * to the HTTP route extractor.
 */
function tryExtractTrpcProcedure(
  node: Parser.SyntaxNode,
  methodName: string,
  args: Parser.SyntaxNode[],
): RouteDef | null {
  // (1) Walk receiver chain for a procedure-builder identifier.
  const funcNode = node.childForFieldName('function');
  if (!funcNode || funcNode.type !== 'member_expression') return null;
  let cur: Parser.SyntaxNode | null = funcNode.childForFieldName('object');
  let foundBase = false;
  // Bounded walk so a runaway chain can't burn time.
  for (let i = 0; i < 12 && cur; i++) {
    if (cur.type === 'identifier' && TRPC_PROCEDURE_BASES.has(cur.text)) {
      foundBase = true; break;
    }
    if (cur.type === 'member_expression') {
      const obj = cur.childForFieldName('object');
      if (obj?.type === 'identifier' && TRPC_PROCEDURE_BASES.has(obj.text)) {
        foundBase = true; break;
      }
      // Also accept member chains like `t.procedure` — check the property.
      const prop = cur.childForFieldName('property');
      if (prop && TRPC_PROCEDURE_BASES.has(prop.text)) {
        foundBase = true; break;
      }
      cur = obj;
    } else if (cur.type === 'call_expression') {
      const f = cur.childForFieldName('function');
      cur = f?.type === 'member_expression' ? f.childForFieldName('object') : null;
    } else {
      cur = null;
    }
  }
  if (!foundBase) return null;

  // (2) Walk UP to enclosing pair to harvest the procedure key.
  let parent: Parser.SyntaxNode | null = node.parent;
  let keyName: string | null = null;
  for (let i = 0; i < 8 && parent; i++) {
    if (parent.type === 'pair') {
      const k = parent.childForFieldName('key');
      if (k) {
        if (k.type === 'property_identifier' || k.type === 'identifier') keyName = k.text;
        else if (k.type === 'string' || k.type === 'template_string') keyName = stripQuotes(k.text);
      }
      break;
    }
    parent = parent.parent;
  }
  if (!keyName) return null;

  // Handler name when the first arg is a named function/identifier.
  const handlerArg = args[0];
  const handlerName = handlerArg ? identifierLikeName(handlerArg) : undefined;

  const opKind = methodName === 'mutation' ? 'mutation'
              : methodName === 'subscription' ? 'subscription'
              : 'query';

  return {
    method: opKind.toUpperCase(),
    path: keyName,
    framework: 'trpc',
    handlerName,
    line: node.startPosition.row,
    protocol: 'trpc',
    operation: keyName,
  };
}

/**
 * v9 Track-H — recognize a tRPC client call.
 *
 * trpc.user.getById.query({...})    → operation = "user.getById", method=QUERY
 * trpc.user.create.mutate(...)      → operation = "user.create",  method=MUTATION
 * trpc.user.getById.useQuery(...)   → operation = "user.getById", method=QUERY
 *
 * Recognition rules:
 *   - Terminal method is one of TRPC_CLIENT_METHODS.
 *   - The chain rooted at the leftmost identifier matches isTrpcClientRoot().
 *   - At least one procedure-name segment exists between the root and the terminal.
 *
 * The operation path is everything between the root and the terminal joined by
 * '.'. The resolver matches client.operation == server.operation.
 */
function tryExtractTrpcClientCall(
  node: Parser.SyntaxNode,
  funcNode: Parser.SyntaxNode,
  terminalMethod: string,
  kind: 'query' | 'mutation' | 'subscription',
): ServiceCallDef | null {
  const segs: string[] = [];
  // Walk receiver chain from .object downward, collecting property segments
  // and stopping at the first non-member identifier.
  let cur: Parser.SyntaxNode | null = funcNode.childForFieldName('object');
  let rootName: string | null = null;
  for (let i = 0; i < 16 && cur; i++) {
    if (cur.type === 'identifier') {
      rootName = cur.text;
      break;
    }
    if (cur.type === 'member_expression') {
      const prop = cur.childForFieldName('property');
      if (prop) segs.unshift(prop.text);
      cur = cur.childForFieldName('object');
    } else {
      // bracket access etc. break the chain — too risky to guess
      return null;
    }
  }
  if (!rootName) return null;
  if (!isTrpcClientRoot(rootName)) return null;
  if (segs.length < 1) return null;            // need at least one procedure segment

  const operation = segs.join('.');
  return {
    protocol: 'trpc',
    method: kind.toUpperCase(),
    rawTarget: operation,
    framework: `trpc-${terminalMethod}`,
    line: node.startPosition.row,
    confidence: 0.9,
    operation,
  };
}

/**
 * v9 Track-H — recognize a GraphQL resolver map.
 *
 * `const resolvers = { Query: { user: handler, ... }, Mutation: { ... } }`
 * (or `{ Query: { user() { ... } } }` with shorthand method syntax).
 *
 * Emits one route per resolver field with operation = field name, method =
 * 'QUERY' | 'MUTATION' | 'SUBSCRIPTION'. Only fires when the variable's
 * value is an object literal whose top-level keys are exactly the GraphQL
 * resolver-kind names — that gate keeps us from confusing this with arbitrary
 * config objects.
 */
function tryExtractGraphqlResolverMap(node: Parser.SyntaxNode): RouteDef[] | null {
  const valNode = node.childForFieldName('value');
  if (!valNode || valNode.type !== 'object') return null;
  const fields = readObjectLiteralFields(valNode);
  // At least one of Query/Mutation/Subscription must be present and itself be
  // an object — otherwise this isn't a resolver map.
  let hasResolverKey = false;
  for (const k of GRAPHQL_RESOLVER_KEYS) {
    if (fields.has(k)) { hasResolverKey = true; break; }
  }
  if (!hasResolverKey) return null;
  const routes: RouteDef[] = [];
  for (const kindKey of GRAPHQL_RESOLVER_KEYS) {
    const inner = fields.get(kindKey);
    if (!inner || inner.type !== 'object') continue;
    const kind = kindKey.toLowerCase();
    for (const child of inner.namedChildren) {
      let fieldName: string | null = null;
      let handlerName: string | undefined;
      const line = child.startPosition.row;
      if (child.type === 'pair') {
        const k = child.childForFieldName('key');
        const v = child.childForFieldName('value');
        if (!k) continue;
        if (k.type === 'property_identifier' || k.type === 'identifier') fieldName = k.text;
        else if (k.type === 'string' || k.type === 'template_string') fieldName = stripQuotes(k.text);
        if (v) handlerName = identifierLikeName(v);
      } else if (child.type === 'method_definition' || child.type === 'shorthand_property_identifier') {
        const k = child.childForFieldName('name');
        if (k) fieldName = k.text;
        handlerName = fieldName ?? undefined;
      } else {
        continue;
      }
      if (!fieldName) continue;
      routes.push({
        method: kind.toUpperCase(),
        path: fieldName,
        framework: 'graphql',
        handlerName,
        line,
        protocol: 'graphql',
        operation: fieldName,
      });
    }
  }
  return routes.length > 0 ? routes : null;
}

/**
 * v9 Track-H — recognize a GraphQL client call.
 *
 * Forms supported:
 *   client.query({ query: GET_USER })       — operation lifted from the
 *                                              document-identifier name
 *   client.mutate({ mutation: gql`mutation Foo { createUser { id } }` })
 *                                            — operation lifted from the gql
 *                                              body's first top-level field
 *   useQuery(GET_USER, { variables: ... })  — useQuery / useMutation hooks
 *   useQuery(gql`query Foo { user { id } }`, ...)
 *
 * Operation matching priority:
 *   1. Top-level field name parsed from the gql body (matches resolver-map keys)
 *   2. Operation name from the gql header
 *   3. Document-identifier (e.g. GET_USER) as a fallback so the call is still
 *      recorded — won't link to a resolver but the row carries the evidence.
 */
function tryExtractGraphqlClientCall(
  node: Parser.SyntaxNode,
  method: string,
  kind: 'query' | 'mutation' | 'subscription',
): ServiceCallDef | null {
  const args = node.childForFieldName('arguments');
  if (!args) return null;
  const first = args.namedChildren[0];
  if (!first) return null;

  let docNode: Parser.SyntaxNode | null = null;
  let documentIdent: string | null = null;

  if (first.type === 'object') {
    // client.{query,mutate,subscribe}({ query | mutation | subscription: DOC })
    const fields = readObjectLiteralFields(first);
    const fieldKey = kind === 'mutation' ? 'mutation'
                   : kind === 'subscription' ? 'subscription' : 'query';
    const v = fields.get(fieldKey);
    if (!v) return null;
    if (v.type === 'identifier') { documentIdent = v.text; }
    else docNode = v;
  } else if (first.type === 'identifier') {
    // useQuery(GET_USER, ...)
    documentIdent = first.text;
  } else {
    // useQuery(gql`...`, ...) — the tagged template literal itself
    docNode = first;
  }

  let opName: string | undefined;
  let opField: string | undefined;
  let rawTarget: string;

  if (docNode) {
    const txt = docNode.text;
    rawTarget = txt.slice(0, 240);
    const parsed = parseGqlOperation(txt);
    if (parsed) {
      opName = parsed.opName;
      opField = parsed.fieldName;
    }
  } else if (documentIdent) {
    rawTarget = documentIdent;
  } else {
    return null;
  }

  // Operation field is what matches a resolver-map key on the server. Op name
  // is the user-given operation alias (GetUser). Doc-ident is the const name.
  const operation = opField ?? opName ?? documentIdent ?? undefined;
  if (!operation) return null;

  const def: ServiceCallDef = {
    protocol: 'graphql',
    method: kind.toUpperCase(),
    rawTarget,
    framework: `graphql-${method}`,
    line: node.startPosition.row,
    // Higher confidence when we parsed the field name out of the gql body;
    // lower when all we have is a document const name.
    confidence: opField ? 0.9 : (opName ? 0.85 : 0.65),
    operation,
  };
  if (opName || documentIdent) {
    def.metadataJson = JSON.stringify({
      operationName: opName ?? null,
      documentIdent: documentIdent ?? null,
      fieldName: opField ?? null,
    });
  }
  return def;
}

/**
 * Pull operation kind, name, and first top-level selection field out of a
 * GraphQL document literal. Forgiving: handles `gql\`…\``, `\`…\``, bare
 * strings, and shorthand `{ field }` query bodies.
 *
 * Returns null when nothing GraphQL-shaped is found.
 */
function parseGqlOperation(src: string): { opKind: string; opName?: string; fieldName?: string } | null {
  let s = src;
  // strip a leading tag (gql, graphql, parse, etc.) if it's followed by a backtick
  s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*`/, '`');
  // trim wrapping backticks / quotes
  s = s.replace(/^[`'"]/, '').replace(/[`'"]\s*$/, '').trim();
  if (!s) return null;
  // strip /* ... */ block comments and # line comments so the regexes below
  // don't trip on doc-comments before the operation header
  s = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/#[^\n]*/g, '').trim();

  let opKind = 'query';
  let opName: string | undefined;
  let hasHeader = false;
  const opMatch = s.match(/^(query|mutation|subscription)\b(?:\s+([A-Za-z_][A-Za-z0-9_]*))?/);
  if (opMatch) {
    hasHeader = true;
    opKind = opMatch[1];
    opName = opMatch[2];
    s = s.slice(opMatch[0].length).trim();
    // drop ($vars) declaration block when present
    if (s.startsWith('(')) {
      const close = balancedClose(s, '(', ')');
      if (close > 0) s = s.slice(close + 1).trim();
    }
  }
  // A genuine GraphQL document either opens with an operation header
  // (query/mutation/subscription) or is a bare shorthand selection set that
  // starts immediately with `{`. Anything else — an IIFE body, an interpolated
  // template, arbitrary code that merely *contains* a brace somewhere — is not
  // GraphQL, so we bail instead of grabbing the first identifier we find.
  if (!hasHeader && !s.startsWith('{')) return null;
  // first '{' opens the selection set
  const openBrace = s.indexOf('{');
  if (openBrace < 0) return hasHeader ? { opKind, opName } : null;
  s = s.slice(openBrace + 1).trim();
  // first identifier in the selection set is the top-level field
  const fieldMatch = s.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  const fieldName = fieldMatch ? fieldMatch[1] : undefined;
  return { opKind, opName, fieldName };
}

/**
 * v9 Track-H — extract a `const X = gql\`...\`` document definition.
 *
 * Emitted as a sentinel service_call with framework='gql-doc' so the resolver
 * can map document identifiers (GET_USER) to their parsed operation field
 * (user). The row carries:
 *   - raw_target  = the document constant name
 *   - operation   = the parsed top-level field name (if any)
 *   - method      = operation kind (QUERY / MUTATION / SUBSCRIPTION)
 *   - confidence  = 0.4 — these aren't actual outbound calls, so we keep
 *                   confidence low to discourage them from showing up in
 *                   risk / context surfaces.
 */
function tryExtractGqlDocDefinition(node: Parser.SyntaxNode): ServiceCallDef | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode || (nameNode.type !== 'identifier' && nameNode.type !== 'property_identifier')) {
    return null;
  }
  const valNode = node.childForFieldName('value');
  if (!valNode) return null;
  // Accept both `gql\`...\`` (tagged template) and a bare template literal
  // that obviously wraps a GraphQL operation header.
  let body: string | null = null;
  if (valNode.type === 'call_expression') {
    // Some tag wrappers parse as call_expression(text("gql"), template_string).
    body = valNode.text;
  } else if (valNode.type === 'template_string') {
    body = valNode.text;
  }
  if (!body) return null;
  // Only emit when this actually looks GraphQL-shaped.
  const parsed = parseGqlOperation(body);
  if (!parsed || (!parsed.opName && !parsed.fieldName)) return null;
  const def: ServiceCallDef = {
    protocol: 'graphql',
    method: parsed.opKind.toUpperCase(),
    rawTarget: nameNode.text,
    framework: 'gql-doc',
    line: node.startPosition.row,
    confidence: 0.4,
    operation: parsed.fieldName ?? parsed.opName ?? nameNode.text,
  };
  def.metadataJson = JSON.stringify({
    documentIdent: nameNode.text,
    operationName: parsed.opName ?? null,
    fieldName: parsed.fieldName ?? null,
  });
  return def;
}

/**
 * v9 Track-H — recognize a messaging PRODUCER call.
 *
 * Decisions made by inspecting (a) the method name and (b) the shape of the
 * first argument, with the receiver name as a final disambiguation cue when
 * multiple protocols share a method (publish is the prototypical example).
 *
 *   Kafka:      producer.send({ topic: 'orders', messages: [...] })
 *   Kafka v1:   kafkaProducer.send('orders', message)
 *   SQS:        sqs.sendMessage({ QueueUrl: '...', MessageBody: '...' })
 *   SNS:        sns.publish({ TopicArn: '...', Message: '...' })
 *   RabbitMQ:   channel.publish('exch', 'rk', body) / channel.sendToQueue('q', body)
 *   NATS:       nc.publish('subject', data)
 *   Redis:      redis.publish('chan', msg)
 *
 * On match returns a ServiceCallDef carrying the relevant protocol field
 * (topic / queue / exchange).
 */
function tryExtractMessagingProducer(
  node: Parser.SyntaxNode,
  funcNode: Parser.SyntaxNode,
): ServiceCallDef | null {
  const propNode = funcNode.childForFieldName('property');
  const objNode = funcNode.childForFieldName('object');
  if (!propNode || !objNode) return null;
  const method = propNode.text;
  const recvName = objNode.type === 'identifier' ? objNode.text : null;
  const args = node.childForFieldName('arguments');
  if (!args) return null;
  const named = args.namedChildren;
  const first = named[0];
  if (!first) return null;

  // Helper: read a string literal from a node (returns null otherwise).
  const litString = (n: Parser.SyntaxNode | undefined): string | null => {
    if (!n) return null;
    if (n.type === 'string' || n.type === 'template_string') return stripQuotes(n.text);
    return null;
  };

  // ── send: Kafka topic ─────────────────────────────────────────────────
  if (method === 'send') {
    if (first.type === 'object') {
      const fields = readObjectLiteralFields(first);
      const topicNode = fields.get('topic');
      const topic = litString(topicNode);
      if (topic) {
        return mkMsgCall('kafka', 'kafkajs', { topic, line: node.startPosition.row });
      }
    } else if (first.type === 'string' || first.type === 'template_string') {
      // Older kafkajs / node-rdkafka: producer.send('topic', msg)
      if (receiverHintsProtocol(recvName, 'kafka')) {
        return mkMsgCall('kafka', 'kafka', { topic: stripQuotes(first.text), line: node.startPosition.row });
      }
    }
  }

  // ── sendMessage: SQS ──────────────────────────────────────────────────
  if (method === 'sendMessage' && first.type === 'object') {
    const fields = readObjectLiteralFields(first);
    const queueUrl = litString(fields.get('QueueUrl'));
    if (queueUrl !== null) {
      return mkMsgCall('sqs', 'aws-sdk-sqs', {
        queue: extractQueueName(queueUrl),
        rawTarget: queueUrl,
        line: node.startPosition.row,
      });
    }
  }

  // ── sendToQueue: RabbitMQ ─────────────────────────────────────────────
  if (method === 'sendToQueue') {
    const queue = litString(first);
    if (queue) {
      return mkMsgCall('rabbitmq', 'amqplib', { queue, line: node.startPosition.row });
    }
  }

  // ── publish: SNS / RabbitMQ / NATS / Redis ────────────────────────────
  if (method === 'publish') {
    if (first.type === 'object') {
      // SNS: { TopicArn, Message }
      const fields = readObjectLiteralFields(first);
      const topicArn = litString(fields.get('TopicArn'));
      if (topicArn !== null) {
        return mkMsgCall('sns', 'aws-sdk-sns', {
          topic: extractTopicNameFromArn(topicArn),
          rawTarget: topicArn,
          line: node.startPosition.row,
        });
      }
    }
    // RabbitMQ: channel.publish('exchange', 'routingKey', body)
    if (receiverHintsProtocol(recvName, 'rabbitmq')) {
      const exchange = litString(first);
      const routingKey = litString(named[1]);
      if (exchange !== null) {
        return mkMsgCall('rabbitmq', 'amqplib', {
          exchange,
          metadataJson: routingKey ? JSON.stringify({ routingKey }) : undefined,
          line: node.startPosition.row,
        });
      }
    }
    // NATS / Redis: nc.publish('subject', data) / redis.publish('chan', msg)
    const subject = litString(first);
    if (subject !== null) {
      if (receiverHintsProtocol(recvName, 'nats')) {
        return mkMsgCall('nats', 'nats', { topic: subject, line: node.startPosition.row });
      }
      if (receiverHintsProtocol(recvName, 'redis_pubsub')) {
        return mkMsgCall('redis_pubsub', 'redis', { topic: subject, line: node.startPosition.row });
      }
    }
  }

  return null;
}

/**
 * v9 Track-H — recognize a messaging CONSUMER registration as a RouteDef.
 *
 *   Kafka:    consumer.subscribe({ topic | topics: [...] })
 *   Rabbit:   channel.consume('queue', handler)
 *   SQS:      sqs.receiveMessage({ QueueUrl })
 *   NATS:     nc.subscribe('subject')
 *
 * Returns one route per topic/queue. The handler is recovered when it's a
 * named identifier in the args list.
 */
function tryExtractMessagingConsumer(
  node: Parser.SyntaxNode,
  funcNode: Parser.SyntaxNode,
  named: Parser.SyntaxNode[],
): RouteDef[] | null {
  if (funcNode.type !== 'member_expression') return null;
  const propNode = funcNode.childForFieldName('property');
  const objNode = funcNode.childForFieldName('object');
  if (!propNode || !objNode) return null;
  const method = propNode.text;
  const recvName = objNode.type === 'identifier' ? objNode.text : null;
  const first = named[0];
  if (!first) return null;
  const line = node.startPosition.row;

  const litString = (n: Parser.SyntaxNode | undefined): string | null => {
    if (!n) return null;
    if (n.type === 'string' || n.type === 'template_string') return stripQuotes(n.text);
    return null;
  };

  // ── Kafka consumer.subscribe({ topic | topics }) ─────────────────────
  if (method === 'subscribe' && first.type === 'object'
      && receiverHintsProtocol(recvName, 'kafka')) {
    const fields = readObjectLiteralFields(first);
    const single = litString(fields.get('topic'));
    if (single) {
      return [mkMsgRoute('kafka', 'kafkajs', { topic: single, line, path: single })];
    }
    const arrNode = fields.get('topics');
    if (arrNode && arrNode.type === 'array') {
      const out: RouteDef[] = [];
      for (const el of arrNode.namedChildren) {
        const t = litString(el);
        if (t) out.push(mkMsgRoute('kafka', 'kafkajs', { topic: t, line, path: t }));
      }
      if (out.length > 0) return out;
    }
  }

  // ── NATS nc.subscribe('subject') ─────────────────────────────────────
  if (method === 'subscribe' && receiverHintsProtocol(recvName, 'nats')) {
    const subject = litString(first);
    if (subject) {
      return [mkMsgRoute('nats', 'nats', { topic: subject, line, path: subject })];
    }
  }

  // ── Redis subscribe('chan') ──────────────────────────────────────────
  if (method === 'subscribe' && receiverHintsProtocol(recvName, 'redis_pubsub')) {
    const chan = litString(first);
    if (chan) {
      return [mkMsgRoute('redis_pubsub', 'redis', { topic: chan, line, path: chan })];
    }
  }

  // ── RabbitMQ channel.consume('queue', handler) ────────────────────────
  if (method === 'consume' && receiverHintsProtocol(recvName, 'rabbitmq')) {
    const queue = litString(first);
    if (queue) {
      const handlerName = named[1] ? identifierLikeName(named[1]) : undefined;
      return [mkMsgRoute('rabbitmq', 'amqplib', {
        queue, line, path: queue, handlerName,
      })];
    }
  }

  // ── SQS receiveMessage({ QueueUrl }) ─────────────────────────────────
  if (method === 'receiveMessage' && first.type === 'object') {
    const fields = readObjectLiteralFields(first);
    const queueUrl = litString(fields.get('QueueUrl'));
    if (queueUrl !== null) {
      return [mkMsgRoute('sqs', 'aws-sdk-sqs', {
        queue: extractQueueName(queueUrl), line, path: queueUrl,
      })];
    }
  }

  return null;
}

interface MsgCallOpts {
  topic?: string; queue?: string; exchange?: string;
  rawTarget?: string;
  line: number;
  metadataJson?: string;
}
function mkMsgCall(
  protocol: MsgProtocol, framework: string, opts: MsgCallOpts,
): ServiceCallDef {
  const rawTarget = opts.rawTarget ?? opts.topic ?? opts.queue ?? opts.exchange ?? '';
  return {
    protocol,
    method: 'PUBLISH',
    rawTarget: rawTarget.slice(0, 240),
    framework,
    line: opts.line,
    confidence: 0.9,
    topic: opts.topic,
    queue: opts.queue,
    exchange: opts.exchange,
    metadataJson: opts.metadataJson,
  };
}

interface MsgRouteOpts {
  topic?: string; queue?: string; exchange?: string;
  path: string; line: number; handlerName?: string;
}
function mkMsgRoute(
  protocol: MsgProtocol, framework: string, opts: MsgRouteOpts,
): RouteDef {
  return {
    method: 'CONSUME',
    path: opts.path,
    framework,
    handlerName: opts.handlerName,
    line: opts.line,
    protocol,
    topic: opts.topic,
    queue: opts.queue,
    exchange: opts.exchange,
  };
}

/** SQS QueueUrl → final path segment (queue name). */
function extractQueueName(url: string): string {
  if (!url) return url;
  const slash = url.lastIndexOf('/');
  return slash >= 0 ? url.slice(slash + 1) : url;
}

/** SNS TopicArn → topic name (the part after the last colon). */
function extractTopicNameFromArn(arn: string): string {
  if (!arn) return arn;
  const colon = arn.lastIndexOf(':');
  return colon >= 0 ? arn.slice(colon + 1) : arn;
}

/** Index of the matching close paren/brace for a string that starts with `open`. */
function balancedClose(s: string, open: string, close: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
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
