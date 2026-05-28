/**
 * Regression tests for the six bugs found and fixed during the 2026-05-29
 * audit. Each section reproduces the original failure mode against the fixed
 * code so a future regression in any of these areas trips immediately.
 *
 * 1. v3→v4 migration leaves cached files without symbol_key + FTS rows
 * 2. churn-before-history makes buildSymbolHistory skip
 * 3. Spring class-level @RequestMapping("/api") emits bogus route + drops prefix
 * 4. Symbol history drops author email
 * 5. File rename: --follow finds commits but diff lookup misses them
 * 6. Fastify object-style app.route({ method, url, handler }) not extracted
 *
 * Run with: npx tsx tests/bug-regressions.ts
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'child_process';
import { Store } from '../src/db/store';
import { Indexer } from '../src/indexer/index';
import { collectChurn } from '../src/indexer/churn';
import { buildSymbolHistory } from '../src/indexer/symbolhistory';
import { parseFollowLog } from '../src/indexer/git';

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}`); failed++; }
}

function git(repo: string, ...args: string[]): { stdout: string; status: number } {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  return { stdout: r.stdout ?? '', status: r.status ?? 1 };
}

function makeGitRepo(repo: string): void {
  fs.mkdirSync(repo, { recursive: true });
  const initRes = spawnSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { encoding: 'utf8' });
  if (initRes.status !== 0) spawnSync('git', ['-C', repo, 'init', '-q'], { encoding: 'utf8' });
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'user.email', 'tester@example.com');
  git(repo, 'config', 'user.name', 'Tester');
}

function commit(repo: string, msg: string): string {
  spawnSync('git', ['-C', repo, 'add', '.'], { encoding: 'utf8' });
  const r = spawnSync('git', ['-C', repo, 'commit', '-m', msg, '--no-gpg-sign'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git commit failed: ${r.stderr}`);
  return git(repo, 'rev-parse', 'HEAD').stdout.trim();
}

// ── Bug 1: v3→v4 migration backfills symbol_key + FTS ──────────────────────
async function bug1_v3MigrationBackfill(): Promise<void> {
  console.log('\n── Bug 1: v3→v4 migration backfills symbol_key + FTS rows ──');
  const tmp = path.join(os.tmpdir(), `strata-bug1-${Date.now()}.db`);
  // Hand-build a "v3" DB: schema version 3, no v4 columns/tables/FTS.
  const db = new DatabaseSync(tmp);
  db.exec(`
    CREATE TABLE _schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO _schema_meta (key, value) VALUES ('schema_version', '3');
    CREATE TABLE files (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, rel_path TEXT NOT NULL,
      language TEXT NOT NULL, hash TEXT NOT NULL, lines INTEGER NOT NULL DEFAULT 0,
      indexed_at INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'project',
      is_vendor INTEGER NOT NULL DEFAULT 0, is_generated INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE symbols (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, qualified_name TEXT, kind TEXT NOT NULL,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      line_start INTEGER NOT NULL DEFAULT 0, line_end INTEGER NOT NULL DEFAULT 0,
      col_start INTEGER NOT NULL DEFAULT 0, col_end INTEGER NOT NULL DEFAULT 0,
      signature TEXT, pagerank REAL NOT NULL DEFAULT 0.15,
      is_rankable INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY, from_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      to_name TEXT NOT NULL, to_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
      kind TEXT NOT NULL DEFAULT 'call', line INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE file_imports (
      id INTEGER PRIMARY KEY, from_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      import_name TEXT NOT NULL, resolved_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL
    );
    INSERT INTO files (path, rel_path, language, hash, lines, indexed_at)
      VALUES ('/x/a.ts', 'a.ts', 'typescript', 'fakehash', 10, 0);
    INSERT INTO symbols (name, qualified_name, kind, file_id, line_start, line_end)
      VALUES ('foo', 'foo', 'function', 1, 0, 5),
             ('bar', 'Klass.bar', 'method', 1, 6, 9);
  `);
  db.close();

  // Open through Store — runs v3→v4 migration including the new backfill.
  const s = new Store(tmp);
  const raw = s.rawDb();
  const nullKeys = raw.prepare('SELECT COUNT(*) AS c FROM symbols WHERE symbol_key IS NULL').get() as { c: number };
  const ftsSyms = raw.prepare('SELECT COUNT(*) AS c FROM symbols_fts').get() as { c: number };
  const ftsFiles = raw.prepare('SELECT COUNT(*) AS c FROM files_fts').get() as { c: number };

  assert(s.schemaInfo().dbVersion === 4, `schema migrated to v4 (got ${s.schemaInfo().dbVersion})`);
  assert(nullKeys.c === 0, `symbol_key backfilled for every pre-v4 symbol (got ${nullKeys.c} NULL)`);
  assert(ftsSyms.c === 2, `symbols_fts rebuilt from existing symbols (got ${ftsSyms.c} rows, expected 2)`);
  assert(ftsFiles.c === 1, `files_fts rebuilt from existing files (got ${ftsFiles.c} rows, expected 1)`);

  // The keys should match makeSymbolKey() format: `kind:qualified_name`.
  const sample = raw.prepare("SELECT name, symbol_key FROM symbols WHERE name = 'bar'").get() as { name: string; symbol_key: string };
  assert(sample.symbol_key === 'method:Klass.bar', `bar.symbol_key = method:Klass.bar (got ${sample.symbol_key})`);

  // FTS query should actually find the migrated symbols (full integration).
  const ftsHits = raw.prepare(`SELECT rowid FROM symbols_fts WHERE symbols_fts MATCH ?`).all('"foo"*') as Array<{ rowid: number }>;
  assert(ftsHits.length === 1, `FTS query 'foo*' finds the migrated symbol (got ${ftsHits.length} hits)`);

  s.close();
  fs.unlinkSync(tmp);
}

// ── Bug 2: churn before history must not poison the history skip guard ────
async function bug2_churnHistoryClash(): Promise<void> {
  console.log('\n── Bug 2: churn before history does NOT make history skip ──');
  const tmp = path.join(os.tmpdir(), `strata-bug2-${Date.now()}`);
  const repo = path.join(tmp, 'repo');
  makeGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export function foo() { return 1; }\n');
  commit(repo, 'init');

  const dbPath = path.join(tmp, 'g.db');
  const store = new Store(dbPath);
  const indexer = new Indexer(store);
  await indexer.indexDirectory(repo, { quiet: true });

  // The original bug: running churn first stamps git_index_state.last_head_sha,
  // and a subsequent symbol-history build sees "HEAD unchanged" and skips —
  // even though history has never been built. The fix is a separate
  // last_history_head_sha column that only history touches.
  const ch = await collectChurn(repo, store);
  assert(ch.headSha !== null, 'churn stamped git_index_state.last_head_sha');

  const sh1 = await buildSymbolHistory(repo, store, { log: () => {} });
  assert(sh1.skipped === false, `history must NOT skip after churn (skipped=${sh1.skipped})`);
  assert(sh1.historyRowsInserted >= 1, `history inserted ≥1 row (got ${sh1.historyRowsInserted})`);

  // Now run again — this time it SHOULD skip because history already ran
  // against the same HEAD.
  const sh2 = await buildSymbolHistory(repo, store, { log: () => {} });
  assert(sh2.skipped === true, `second history call skips because HEAD unchanged`);

  // And running churn AGAIN after history must not undo the history-skip
  // signal — i.e. churn's stamp is separate.
  await collectChurn(repo, store);
  const sh3 = await buildSymbolHistory(repo, store, { log: () => {} });
  assert(sh3.skipped === true, `history still skips after a fresh churn pass`);

  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Bug 3: Spring class-level @RequestMapping prefixes method routes ──────
async function bug3_springClassPrefix(): Promise<void> {
  console.log('\n── Bug 3: Spring class-level @RequestMapping("/api") prefix ──');
  const tmp = path.join(os.tmpdir(), `strata-bug3-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'A.java'), `
package x;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
class A {
  @GetMapping("/users") String list() { return "u"; }
  @PostMapping(value = "/users") String create() { return "c"; }
  @RequestMapping(value = "/items", method = RequestMethod.GET) String items() { return "i"; }
}
`.trimStart());
  // Class with NO @RequestMapping — method paths should pass through unchanged.
  fs.writeFileSync(path.join(tmp, 'B.java'), `
package x;
import org.springframework.web.bind.annotation.*;

@RestController
class B {
  @GetMapping("/bare") String bare() { return "b"; }
}
`.trimStart());

  const store = new Store(path.join(tmp, 'g.db'));
  const indexer = new Indexer(store);
  await indexer.indexDirectory(tmp, { quiet: true });

  const routes = store.listRoutes({ framework: 'spring', limit: 50 });
  const paths = routes.map(r => `${r.method} ${r.path}`).sort();

  assert(!routes.some(r => r.path === '/api'),
    `class-level @RequestMapping does NOT emit a bare /api route (paths: ${JSON.stringify(paths)})`);
  assert(routes.some(r => r.method === 'GET' && r.path === '/api/users'),
    'GET /api/users (class prefix + method path)');
  assert(routes.some(r => r.method === 'POST' && r.path === '/api/users'),
    'POST /api/users (class prefix + method path)');
  assert(routes.some(r => r.method === 'GET' && r.path === '/api/items'),
    'GET /api/items (RequestMapping with method= and class prefix)');
  assert(routes.some(r => r.method === 'GET' && r.path === '/bare'),
    'GET /bare (no class prefix — pass-through unchanged)');

  // Handler resolution should still work — routes link back to the methods.
  const listRoute = routes.find(r => r.path === '/api/users' && r.method === 'GET');
  assert(listRoute?.handlerName === 'list', `class-prefixed route still resolves handler (got ${listRoute?.handlerName})`);

  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Bug 4 + 5: rename history + author email ──────────────────────────────
async function bug4and5_renameAndEmail(): Promise<void> {
  console.log('\n── Bugs 4 + 5: file rename + author email in symbol history ──');
  const tmp = path.join(os.tmpdir(), `strata-bug45-${Date.now()}`);
  const repo = path.join(tmp, 'repo');
  makeGitRepo(repo);

  // sha1: create old.ts
  fs.writeFileSync(path.join(repo, 'old.ts'), 'export function helper() { return 1; }\n');
  const sha1 = commit(repo, 'init old.ts');

  // sha2: rename old.ts → new.ts (no content change)
  spawnSync('git', ['-C', repo, 'mv', 'old.ts', 'new.ts'], { encoding: 'utf8' });
  const sha2 = commit(repo, 'rename to new.ts');

  // sha3: modify helper in new.ts
  fs.writeFileSync(path.join(repo, 'new.ts'), 'export function helper() { return 2; }\n');
  const sha3 = commit(repo, 'change return value');

  const dbPath = path.join(tmp, 'g.db');
  const store = new Store(dbPath);
  const indexer = new Indexer(store);
  await indexer.indexDirectory(repo, { quiet: true });

  const r = await buildSymbolHistory(repo, store, { log: () => {} });
  assert(r.historyRowsInserted >= 2,
    `history has ≥2 rows (got ${r.historyRowsInserted})`);

  const helperDef = store.getDefinition('helper')[0];
  assert(helperDef !== undefined, 'helper symbol indexed in new.ts');
  const hist = store.getSymbolHistory(helperDef.id, { limit: 20 });

  // Bug 4: every commit must carry the real author email — never ''.
  for (const h of hist) {
    assert(h.authorEmail !== null && h.authorEmail !== '',
      `commit ${h.commitSha.slice(0,8)} has non-empty author email (got '${h.authorEmail}')`);
  }

  // Bug 5: pre-rename commit must appear in history.
  assert(hist.some(h => h.commitSha === sha1),
    `pre-rename sha1=${sha1.slice(0,8)} appears in history (got [${hist.map(h => h.commitSha.slice(0,8)).join(',')}])`);
  // Post-rename change should also appear.
  assert(hist.some(h => h.commitSha === sha3),
    `post-rename sha3=${sha3.slice(0,8)} appears in history`);

  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── parseFollowLog unit test: messages with quirky content ────────────────
function bug5_parseFollowLogEdgeCases(): void {
  console.log('\n── Bug 5 (extra): parseFollowLog handles messy commit content ──');
  // Synthetic git log output exercising:
  //   - multi-line messages (with blank lines and a literal "__C__" substring)
  //   - rename entry (R100) — pathAtCommit should be the NEW path
  //   - modify entry (M)
  //   - root commit added entry (A)
  const buf = [
    '__C__aaaaaa\tAlice\talice@x\t2026-05-28T10:00:00Z',
    'tweak helper',
    '',
    'Fixes __C__ in formatting',
    '__BODY_END__',
    '',
    'M\tnew.ts',
    '',
    '__C__bbbbbb\tBob\tbob@x\t2026-05-27T10:00:00Z',
    'rename',
    '__BODY_END__',
    '',
    'R100\told.ts\tnew.ts',
    '',
    '__C__cccccc\tAlice\talice@x\t2026-05-26T10:00:00Z',
    'init',
    '__BODY_END__',
    '',
    'A\told.ts',
  ].join('\n');
  const commits = parseFollowLog(buf);
  assert(commits.length === 3, `parsed 3 commits (got ${commits.length})`);
  assert(commits[0].sha === 'aaaaaa', 'commit 0 sha');
  assert(commits[0].authorEmail === 'alice@x', `commit 0 email (got ${commits[0].authorEmail})`);
  assert(commits[0].pathAtCommit === 'new.ts', `commit 0 modify pathAtCommit = new.ts (got ${commits[0].pathAtCommit})`);
  assert(commits[0].message.includes('Fixes __C__ in formatting'),
    `commit 0 message preserves literal __C__ inside body (got: ${JSON.stringify(commits[0].message)})`);
  assert(commits[1].pathAtCommit === 'new.ts',
    `commit 1 rename pathAtCommit = NEW path (got ${commits[1].pathAtCommit})`);
  assert(commits[2].pathAtCommit === 'old.ts',
    `commit 2 add pathAtCommit = old.ts (got ${commits[2].pathAtCommit})`);
}

// ── Bug 6: Fastify object-style routes ────────────────────────────────────
async function bug6_fastifyObjectRoutes(): Promise<void> {
  console.log('\n── Bug 6: Fastify object-style app.route({ method, url, handler }) ──');
  const tmp = path.join(os.tmpdir(), `strata-bug6-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, 'fixtures-trackcd', 'fastify_object_routes.js'),
    path.join(tmp, 'fastify_object_routes.js'),
  );
  const store = new Store(path.join(tmp, 'g.db'));
  const indexer = new Indexer(store);
  await indexer.indexDirectory(tmp, { quiet: true });

  const routes = store.listRoutes({ framework: 'fastify', limit: 50 });
  const summary = routes.map(r => `${r.method} ${r.path}`).sort();

  assert(routes.some(r => r.method === 'GET' && r.path === '/things/:id'),
    `Fastify object-style GET extracted (paths: ${JSON.stringify(summary)})`);
  assert(routes.some(r => r.method === 'PUT' && r.path === '/things/:id'),
    `Fastify object-style method=['PUT','PATCH'] emits PUT route`);
  assert(routes.some(r => r.method === 'PATCH' && r.path === '/things/:id'),
    `Fastify object-style method=['PUT','PATCH'] also emits PATCH route`);
  assert(routes.some(r => r.method === 'DELETE' && r.path === '/things/:id'),
    `Fastify object-style with fields out-of-order still extracts (handler-first form)`);

  // Handler names should be resolved across all object-style routes.
  const getR = routes.find(r => r.method === 'GET' && r.path === '/things/:id');
  assert(getR?.handlerName === 'getThing', `Fastify GET handler resolved (got ${getR?.handlerName})`);
  const putR = routes.find(r => r.method === 'PUT' && r.path === '/things/:id');
  assert(putR?.handlerName === 'upsertThing', `Fastify PUT handler resolved (got ${putR?.handlerName})`);

  // Negative: app.route() with non-literal url must NOT emit a route. We
  // verify by adding a second fixture inline and re-indexing.
  fs.writeFileSync(path.join(tmp, 'dynamic.js'), `
const fastify = require('fastify')();
const url = computeUrl();
fastify.route({ method: 'GET', url: url, handler: doStuff });
`.trimStart());
  store.close();
  const store2 = new Store(path.join(tmp, 'g.db'));
  const indexer2 = new Indexer(store2);
  await indexer2.indexDirectory(tmp, { quiet: true });
  const dynRoutes = store2.listRoutes({ framework: 'fastify', limit: 50 })
    .filter(r => !r.handlerName || r.handlerName === 'doStuff');
  assert(!dynRoutes.some(r => r.handlerName === 'doStuff'),
    `Fastify object-style with dynamic url is NOT extracted (would be a false positive)`);

  store2.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function run(): Promise<void> {
  console.log('\nStrata Bug-Regression Tests');
  console.log('===========================');
  console.log('Each section asserts a bug found during the 2026-05-29 audit stays fixed.');
  await bug1_v3MigrationBackfill();
  await bug2_churnHistoryClash();
  await bug3_springClassPrefix();
  await bug4and5_renameAndEmail();
  bug5_parseFollowLogEdgeCases();
  await bug6_fastifyObjectRoutes();

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  Regression results: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.error('\n  BUG-REGRESSION TESTS FAILED\n'); process.exit(1); }
  else            { console.log('\n  All bug-regression tests passed! ✓\n'); }
}

run().catch(err => { console.error('bug-regressions crashed:', err); process.exit(1); });
