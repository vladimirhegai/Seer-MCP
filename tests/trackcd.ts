/**
 * Track C + D feature tests.
 *
 * Indexes `tests/fixtures-trackcd/` once and exercises every new feature:
 *   - route extraction (Express, FastAPI, Flask, Spring)
 *   - env/config key extraction (process.env, os.getenv, System.getenv)
 *   - external dependency parsing (package.json, Cargo.toml, requirements.txt, go.mod)
 *   - complexity metrics (cyclomatic, cognitive, LOC, max_nesting)
 *   - test edge synthesis
 *   - FTS5 BM25 symbol search with camelCase/snake_case splitting
 *   - architecture aggregate
 *   - graph trace_path
 *
 * Run with: npx tsx tests/trackcd.ts
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { Indexer } from '../src/indexer/index';
import { Store, ftsQuery, splitIdentifierTokens, makeSymbolKey } from '../src/db/store';
import { buildArchitecture } from '../src/indexer/architecture';

const FIXTURES = path.join(__dirname, 'fixtures-trackcd');
const TMP_DB = path.join(os.tmpdir(), `seer-trackcd-${Date.now()}.db`);

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}`); failed++; }
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  assert(actual === expected, `${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

function assertContains(haystack: string[], needle: string, msg: string): void {
  assert(haystack.includes(needle), `${msg} (in ${JSON.stringify(haystack)})`);
}

async function run(): Promise<void> {
  console.log('\nSeer Track C + D Feature Tests');
  console.log('================================\n');

  if (!fs.existsSync(FIXTURES)) {
    console.error(`Missing fixtures dir: ${FIXTURES}`);
    process.exit(1);
  }

  const store = new Store(TMP_DB);
  const indexer = new Indexer(store);
  console.log(`Indexing ${FIXTURES}...`);
  const r = await indexer.indexDirectory(FIXTURES, { quiet: true });
  console.log(`  files=${r.filesIndexed} symbols=${r.symbols} edges=${r.edges} extDeps=${r.externalDependencies} testEdges=${r.testEdgesAdded}\n`);

  // ── Schema version ────────────────────────────────────────────────────────
  console.log('── Schema ──');
  const schema = store.schemaInfo();
  assertEq(schema.current, true, 'schema is current');
  assertEq(schema.dbVersion, 11, `schema version is v11`);

  // ── Helper: tokenizer ─────────────────────────────────────────────────────
  console.log('\n── Identifier tokenizer ──');
  const t1 = splitIdentifierTokens('AuthServiceImpl').split(' ').sort();
  assertContains(t1, 'authserviceimpl', 'tokenizer keeps original');
  assertContains(t1, 'auth', 'camelCase split: Auth');
  assertContains(t1, 'service', 'camelCase split: Service');
  assertContains(t1, 'impl', 'camelCase split: Impl');
  const t2 = splitIdentifierTokens('XMLParser').split(' ').sort();
  assertContains(t2, 'xml', 'caps-acronym split: XML');
  assertContains(t2, 'parser', 'caps-acronym split: Parser');
  const t3 = splitIdentifierTokens('user_repo_manager').split(' ').sort();
  assertContains(t3, 'user', 'snake_case split: user');
  assertContains(t3, 'repo', 'snake_case split: repo');
  assertContains(t3, 'manager', 'snake_case split: manager');

  // ── Symbol key ────────────────────────────────────────────────────────────
  console.log('\n── Symbol key ──');
  assertEq(makeSymbolKey('function', 'foo'), 'function:foo', 'makeSymbolKey basic');
  assertEq(makeSymbolKey('method', 'Auth.login'), 'method:Auth.login', 'makeSymbolKey qualified');

  // ── FTS5 query builder ────────────────────────────────────────────────────
  console.log('\n── FTS query builder ──');
  const q = ftsQuery('AuthService');
  assert(q !== null && q.includes('"auth"*'), `ftsQuery splits camelCase: ${q}`);
  const q2 = ftsQuery('');
  assertEq(q2, null, 'empty query → null');

  // ── Route extraction ──────────────────────────────────────────────────────
  console.log('\n── Route extraction ──');
  const routes = store.listRoutes({ limit: 100 });
  console.log(`  Total routes: ${routes.length}`);
  for (const r of routes) console.log(`    ${r.method} ${r.path} (${r.framework}) → ${r.handlerSymbol ?? r.handlerName ?? '(none)'}`);

  // Express
  assert(routes.some(r => r.method === 'GET' && r.path === '/users' && r.framework === 'express'),
    'Express GET /users detected');
  assert(routes.some(r => r.method === 'POST' && r.path === '/users' && r.framework === 'express'),
    'Express POST /users detected');
  assert(routes.some(r => r.method === 'DELETE' && r.path === '/users/:id' && r.framework === 'express'),
    'Express DELETE /users/:id detected');
  assert(routes.some(r => r.method === 'PUT' && r.path === '/users/:id' && r.framework === 'express'),
    'Express PUT /users/:id (inline handler) detected');

  // Express handler resolution
  const listUsersRoute = routes.find(r => r.method === 'GET' && r.path === '/users' && r.framework === 'express');
  assert(listUsersRoute?.handlerName === 'listUsers', `Express handler name = listUsers`);
  assert(listUsersRoute?.handlerId !== null, `Express handler id resolved`);

  // FastAPI
  assert(routes.some(r => r.method === 'GET' && r.path === '/items/{item_id}' && r.framework === 'fastapi'),
    'FastAPI GET /items/{item_id} detected');
  assert(routes.some(r => r.method === 'POST' && r.path === '/items' && r.framework === 'fastapi'),
    'FastAPI POST /items detected');
  const readItemRoute = routes.find(r => r.method === 'GET' && r.framework === 'fastapi');
  assert(readItemRoute?.handlerName === 'read_item', `FastAPI handler name = read_item`);
  assert(readItemRoute?.handlerId !== null, `FastAPI handler id resolved`);

  // Flask
  assert(routes.some(r => r.method === 'GET' && r.path === '/health' && r.framework === 'flask'),
    'Flask GET /health detected');
  assert(routes.some(r => r.method === 'GET' && r.path === '/users' && r.framework === 'flask'),
    'Flask GET /users detected (methods=GET,POST)');
  assert(routes.some(r => r.method === 'POST' && r.path === '/users' && r.framework === 'flask'),
    'Flask POST /users detected (methods=GET,POST)');

  // Spring — class-level @RequestMapping("/api") is a prefix; method routes
  // should be concatenated, and the class-level annotation must NOT emit a
  // route on its own.
  assert(routes.some(r => r.method === 'GET' && r.path === '/api/users' && r.framework === 'spring'),
    'Spring GET /api/users detected (class prefix applied)');
  assert(routes.some(r => r.method === 'POST' && r.path === '/api/users' && r.framework === 'spring'),
    'Spring POST /api/users detected (class prefix applied)');
  assert(routes.some(r => r.method === 'DELETE' && r.path === '/api/users/{id}' && r.framework === 'spring'),
    'Spring DELETE /api/users/{id} detected (class prefix applied)');
  assert(routes.some(r => r.method === 'GET' && r.path === '/api/items' && r.framework === 'spring'),
    'Spring @RequestMapping method=GET → /api/items detected (class prefix applied)');
  // Regression: the class-level annotation itself must NOT emit a bare /api
  // route. This was the symptom of the pre-fix bug — the extractor produced
  // a phantom `GET /api → (no handler)` row.
  assert(!routes.some(r => r.framework === 'spring' && r.path === '/api'),
    'Spring class-level @RequestMapping("/api") does NOT emit a bogus /api route');

  // Route filters
  const onlyGet = store.listRoutes({ method: 'GET' });
  assert(onlyGet.every(r => r.method === 'GET'), 'method filter works');
  const onlySpring = store.listRoutes({ framework: 'spring' });
  assert(onlySpring.every(r => r.framework === 'spring'), 'framework filter works');

  // ── Config / env extraction ──────────────────────────────────────────────
  console.log('\n── Config / env extraction ──');
  const configs = store.listConfigKeys({ limit: 200 });
  console.log(`  Total config reads: ${configs.length}`);
  const keys = configs.map(c => c.key).sort();
  console.log(`  Keys: ${JSON.stringify(keys)}`);

  assertContains(keys, 'DATABASE_URL', 'process.env.DATABASE_URL extracted');
  assertContains(keys, 'TIMEOUT_MS', 'process.env["TIMEOUT_MS"] extracted');
  assertContains(keys, 'FEATURE_FLAG', 'os.environ.get FEATURE_FLAG extracted');
  assertContains(keys, 'SECRET_KEY', 'os.environ[SECRET_KEY] extracted');

  // Symbol-id backfill: most config reads should have an enclosing symbol.
  const enclosedReads = configs.filter(c => c.symbolId !== null);
  assert(enclosedReads.length > 0, `at least one config read has resolved enclosing symbol`);
  // listUsers's DATABASE_URL must be attributed to listUsers.
  const inListUsers = configs.find(c => c.key === 'DATABASE_URL' && c.symbolName === 'listUsers');
  assert(inListUsers !== undefined, `DATABASE_URL in listUsers attributed correctly`);
  // get_db_url contains os.getenv("DATABASE_URL")
  const inGetDbUrl = configs.find(c => c.key === 'DATABASE_URL' && c.symbolName === 'get_db_url');
  assert(inGetDbUrl !== undefined, 'os.getenv("DATABASE_URL") attributed to get_db_url');

  // ── External dependency extraction ────────────────────────────────────────
  console.log('\n── External deps ──');
  const npm = store.listExternalDeps({ ecosystem: 'npm' });
  console.log(`  npm: ${npm.map(d => `${d.name}@${d.versionRange ?? ''}${d.isDev ? '*dev' : ''}`).join(', ')}`);
  assert(npm.some(d => d.name === 'express'), 'package.json express dep');
  assert(npm.some(d => d.name === 'lodash'), 'package.json lodash dep');
  assert(npm.some(d => d.name === 'jest' && d.isDev === 1), 'package.json jest dev dep');
  assert(npm.some(d => d.name === 'react'), 'package.json react peer dep');

  const cargo = store.listExternalDeps({ ecosystem: 'cargo' });
  console.log(`  cargo: ${cargo.map(d => `${d.name}@${d.versionRange ?? ''}`).join(', ')}`);
  assert(cargo.some(d => d.name === 'serde'), 'Cargo.toml serde');
  assert(cargo.some(d => d.name === 'tokio' && d.versionRange === '1.0'), 'Cargo.toml tokio with version');
  assert(cargo.some(d => d.name === 'criterion' && d.isDev === 1), 'Cargo.toml criterion dev dep');

  const pypi = store.listExternalDeps({ ecosystem: 'pypi' });
  console.log(`  pypi: ${pypi.map(d => `${d.name}@${d.versionRange ?? ''}`).join(', ')}`);
  assert(pypi.some(d => d.name === 'requests'), 'requirements.txt requests');
  assert(pypi.some(d => d.name === 'fastapi' && (d.versionRange ?? '').includes('0.104.0')), 'requirements.txt fastapi version');

  const goDeps = store.listExternalDeps({ ecosystem: 'go' });
  console.log(`  go: ${goDeps.map(d => `${d.name}@${d.versionRange ?? ''}`).join(', ')}`);
  assert(goDeps.some(d => d.name === 'github.com/spf13/cobra'), 'go.mod cobra dep');
  assert(goDeps.some(d => d.name === 'github.com/stretchr/testify'), 'go.mod testify dep');

  // ── Complexity ────────────────────────────────────────────────────────────
  console.log('\n── Complexity ──');
  const simple = store.findSymbols('simple_function').filter(s => s.kind === 'function');
  assert(simple.length >= 1, 'simple_function indexed');
  assert(simple[0].cyclomatic === 1, `simple_function cyclomatic = 1 (got ${simple[0].cyclomatic})`);

  const branchy = store.findSymbols('branchy_function').filter(s => s.kind === 'function');
  assert(branchy.length >= 1, 'branchy_function indexed');
  assert((branchy[0].cyclomatic ?? 0) >= 5, `branchy_function cyclomatic ≥ 5 (got ${branchy[0].cyclomatic})`);
  assert((branchy[0].maxNesting ?? 0) >= 3, `branchy_function max_nesting ≥ 3 (got ${branchy[0].maxNesting})`);

  const loopy = store.findSymbols('loopy_function').filter(s => s.kind === 'function');
  assert(loopy.length >= 1, 'loopy_function indexed');
  assert((loopy[0].cyclomatic ?? 0) >= 5, `loopy_function cyclomatic ≥ 5 (got ${loopy[0].cyclomatic})`);
  assert((loopy[0].cognitive ?? 0) > (loopy[0].cyclomatic ?? 0), `loopy_function cognitive > cyclomatic (nested branches cost more)`);
  assert((loopy[0].loc ?? 0) >= 10, `loopy_function loc ≥ 10 (got ${loopy[0].loc})`);

  // Calculator.divide — multiple ifs, raise. Python extractor uses 'function' for methods too.
  const divide = store.findSymbols('divide');
  assert(divide.length >= 1, 'Calculator.divide indexed');
  assert((divide[0].cyclomatic ?? 0) >= 4, `divide cyclomatic ≥ 4 (got ${divide[0].cyclomatic})`);

  // Class itself is not "rankable for complexity" — classes don't carry metrics
  const calcClass = store.findSymbols('Calculator').filter(s => s.kind === 'class');
  assert(calcClass.length >= 1, 'Calculator class indexed');
  assert(calcClass[0].cyclomatic == null, 'classes have null complexity');

  // ── Test edge synthesis ──────────────────────────────────────────────────
  console.log('\n── Test edge synthesis ──');
  // The fixture has tests/auth_service.test.ts calling AuthService.login and validateCredentials.
  // synthesizeTestEdges() should have populated edges of kind='tests' from those calls.
  const testCount = store.rawDb().prepare("SELECT COUNT(*) AS c FROM edges WHERE kind = 'tests'").get() as { c: number };
  console.log(`  Total 'tests' edges: ${testCount.c}`);
  assert(testCount.c >= 2, `at least 2 tests edges synthesized (got ${testCount.c})`);

  const loginTestEdges = store.rawDb().prepare(`
    SELECT s.name AS caller, e.to_name AS callee, f.role AS fromRole
    FROM edges e JOIN symbols s ON s.id = e.from_id JOIN files f ON f.id = s.file_id
    WHERE e.kind = 'tests' AND e.to_name = ?
  `).all('login') as Array<{ caller: string; callee: string; fromRole: string }>;
  assert(loginTestEdges.length >= 1, `tests edge: login() exercised by a test`);
  assert(loginTestEdges.every(t => t.fromRole === 'test'), 'all tests edges come from test files');

  // ── FTS5 BM25 search ──────────────────────────────────────────────────────
  console.log('\n── FTS5 BM25 search ──');
  const authHits = store.searchSymbolsFts('auth', { limit: 20 });
  console.log(`  searchSymbolsFts('auth') → ${authHits.length} hits`);
  assert(authHits.some(h => h.name === 'AuthService'), 'FTS finds AuthService for "auth"');

  // camelCase split lets 'service' match AuthService too
  const serviceHits = store.searchSymbolsFts('service', { limit: 20 });
  assert(serviceHits.some(h => h.name === 'AuthService'), 'FTS camelCase split: "service" → AuthService');

  // snake_case split lets 'validate' match validate_credentials and validateCredentials
  const validateHits = store.searchSymbolsFts('validate', { limit: 20 });
  assert(validateHits.some(h => h.name === 'validateCredentials'),
    `FTS finds validateCredentials for "validate" (camel-split)`);

  // File-path FTS
  const fileHits = store.searchFilesFts('auth');
  assert(fileHits.some(f => f.relPath.toLowerCase().includes('auth')),
    `searchFilesFts('auth') finds auth_service files`);

  // ── Architecture aggregate ────────────────────────────────────────────────
  console.log('\n── Architecture aggregate ──');
  const arch = buildArchitecture(FIXTURES, store);
  console.log(`  Languages: ${arch.languages.map(l => `${l.language}=${l.files}`).join(', ')}`);
  console.log(`  Total routes: ${arch.totals.routes}, deps: ${arch.totals.externalDependencies}, configKeys: ${arch.totals.configKeys}`);
  console.log(`  Routes by framework: ${JSON.stringify(arch.routes.byFramework)}`);
  console.log(`  Top modules: ${arch.topModules.map(m => `${m.name}(${m.files})`).join(', ')}`);
  console.log(`  External deps (top 5): ${arch.externalDependencies.slice(0,5).map(d => d.name).join(', ')}`);

  assert(arch.totals.routes >= 10, `architecture: ≥10 routes`);
  assert(arch.totals.externalDependencies >= 8, `architecture: ≥8 external deps`);
  assert(arch.totals.configKeys >= 4, `architecture: ≥4 config keys`);
  assert(arch.languages.length >= 3, `architecture: ≥3 languages`);
  assert(arch.routes.byFramework['express'] >= 1, 'architecture: express framework counted');
  assert(arch.routes.byFramework['fastapi'] >= 1, 'architecture: fastapi framework counted');
  assert(arch.routes.byFramework['spring'] >= 1, 'architecture: spring framework counted');
  assert(arch.routes.byFramework['flask'] >= 1, 'architecture: flask framework counted');

  // ── Graph trace_path ──────────────────────────────────────────────────────
  console.log('\n── Graph trace_path ──');
  // login → validateCredentials direct path (login calls validateCredentials)
  const loginDef = store.getDefinition('login').find(s => s.kind === 'method');
  const valDef = store.getDefinition('validateCredentials');
  assert(loginDef !== undefined && valDef.length > 0, 'fixtures: login and validateCredentials defined');
  const tracePath = store.tracePath(loginDef!.id, valDef[0].id, 4);
  console.log(`  tracePath login→validateCredentials = ${tracePath?.map(n => n.name).join(' → ')}`);
  assert(tracePath !== null, 'trace_path finds login → validateCredentials');
  assert(tracePath![0].name === 'login' && tracePath![tracePath!.length - 1].name === 'validateCredentials',
    'trace_path endpoints correct');

  // Identity path: a→a is a single node
  const selfPath = store.tracePath(loginDef!.id, loginDef!.id, 1);
  assert(selfPath !== null && selfPath.length === 1, 'trace_path(a, a) → single node');

  // Unreachable path
  const reverseBadPath = store.tracePath(valDef[0].id, loginDef!.id, 3);
  // validateCredentials doesn't call login, so the path should be null.
  assert(reverseBadPath === null, 'trace_path: no path validateCredentials → login');

  // reverseReachable: who transitively calls validateCredentials?
  const callers = store.reverseReachable(valDef[0].id, 3);
  assert(callers.length >= 1, `reverseReachable(validateCredentials) finds ≥1 caller`);

  // ── symbolsTouchingLines ──────────────────────────────────────────────────
  console.log('\n── symbolsTouchingLines ──');
  const authFile = store.listFiles().find(f => f.relPath.endsWith('auth_service.ts'))!;
  assert(authFile !== undefined, 'auth_service.ts indexed');
  // Pull syms whose range overlaps line 5 (somewhere inside login).
  const touching = store.symbolsTouchingLines(authFile.id, [[2, 6]]);
  assert(touching.some(s => s.name === 'AuthService' || s.name === 'login'),
    'symbolsTouchingLines finds AuthService or login at lines 2-6');

  // ── Cleanup ───────────────────────────────────────────────────────────────
  store.close();
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB);
  ['-wal','-shm'].forEach(suf => { try { fs.unlinkSync(TMP_DB + suf); } catch { /* */ } });

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.error('\n  TRACK C/D TEST FAILED\n'); process.exit(1); }
  else            { console.log('\n  All Track C+D tests passed! ✓\n'); }
}

run().catch(err => { console.error('trackcd crashed:', err); process.exit(1); });
