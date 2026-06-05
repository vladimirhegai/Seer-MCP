/**
 * Production-stability regressions from the May/June audit.
 *
 * These tests focus on concrete repros for stale metadata, generated-file
 * filtering, proto freshness/scanning, compose service-host false positives,
 * skeleton line math, deep CLI DB lookup, and global npx installer launchers.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { Store } from '../src/db/store';
import { Indexer } from '../src/indexer/index';
import { discoverFiles } from '../src/indexer/discovery';
import { jitSync } from '../src/indexer/freshness';
import { scanServiceHosts } from '../src/indexer/serviceHostScanner';
import { buildSkeleton } from '../src/indexer/skeleton';
import { runInit } from '../src/cli/init';
import { workflowTemplate } from '../src/bundle/ci';

let passed = 0;
let failed = 0;

function check(cond: boolean, msg: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  OK ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL ${msg}` + (detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 240)}`));
  }
}

function tempRoot(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `seer-stability-${tag}-`));
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

async function withIndexedRepo(
  tag: string,
  setup: (root: string) => void,
  run: (root: string, store: Store, indexer: Indexer) => Promise<void>,
): Promise<void> {
  const root = tempRoot(tag);
  try {
    setup(root);
    const dbPath = path.join(root, '.seer', 'graph.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const store = new Store(dbPath);
    const indexer = new Indexer(store);
    await indexer.indexDirectory(root, { quiet: true, parallel: false });
    await run(root, store, indexer);
    store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function metadataOnlyChangesRefresh(): Promise<void> {
  console.log('\n-- metadata-only changes refresh --');
  await withIndexedRepo('deps', root => {
    write(path.join(root, 'src', 'a.ts'), 'export function a(){ return 1; }\n');
    write(path.join(root, 'package.json'), JSON.stringify({ dependencies: { leftpad: '1.0.0' } }, null, 2));
  }, async (root, store, indexer) => {
    check(store.listExternalDeps().some(d => d.name === 'leftpad'), 'initial dependency indexed');
    write(path.join(root, 'package.json'), JSON.stringify({ dependencies: { lodash: '4.17.21' } }, null, 2));
    const second = await indexer.indexDirectory(root, { quiet: true, parallel: false });
    const names = store.listExternalDeps().map(d => d.name);
    check(second.filesIndexed === 0 && second.filesReusedFromCache === 1, 'manifest-only reindex reuses source cache', second);
    check(names.includes('lodash') && !names.includes('leftpad'), 'dependencies update on manifest-only edit', names);
  });

  await withIndexedRepo('boundaries', root => {
    write(path.join(root, 'packages', 'pkg', 'src', 'index.ts'), 'export function api(){ return 1; }\n');
    write(path.join(root, 'packages', 'pkg', 'package.json'), JSON.stringify({ name: '@scope/old-name' }, null, 2));
  }, async (root, store, indexer) => {
    check(store.listBoundaries(10).some(b => b.label === 'old-name'), 'initial boundary label indexed');
    write(path.join(root, 'packages', 'pkg', 'package.json'), JSON.stringify({ name: '@scope/new-name' }, null, 2));
    await indexer.indexDirectory(root, { quiet: true, parallel: false });
    const labels = store.listBoundaries(10).map(b => b.label);
    check(labels.includes('new-name') && !labels.includes('old-name'), 'boundaries update on manifest-only edit', labels);
    const stampsBefore = store.rawDb().prepare(
      'SELECT root_rel_path AS rootRelPath, computed_at AS computedAt FROM boundaries ORDER BY root_rel_path',
    ).all();
    await new Promise(resolve => setTimeout(resolve, 5));
    const third = await indexer.indexDirectory(root, { quiet: true, parallel: false });
    const stampsAfter = store.rawDb().prepare(
      'SELECT root_rel_path AS rootRelPath, computed_at AS computedAt FROM boundaries ORDER BY root_rel_path',
    ).all();
    check(third.filesIndexed === 0 && third.filesReusedFromCache === 1, 'boundary no-op reindex reuses source cache', third);
    check(JSON.stringify(stampsAfter) === JSON.stringify(stampsBefore),
      'boundary no-op reindex does not rewrite boundary rows', { before: stampsBefore, after: stampsAfter });
  });
}

async function generatedFiltering(): Promise<void> {
  console.log('\n-- generated-file filtering --');
  const root = tempRoot('generated');
  try {
    write(path.join(root, 'src', 'api', 'user.pb.go'), 'package api\nfunc Generated() {}\n');
    write(path.join(root, 'src', 'api', 'real.go'), 'package api\nfunc Real() {}\n');
    const standard = (await discoverFiles(root, { mode: 'standard' })).map(f => f.relativePath.replace(/\\/g, '/'));
    check(standard.includes('src/api/real.go'), 'standard mode keeps real source', standard);
    check(!standard.includes('src/api/user.pb.go'), 'standard mode skips nested generated .pb.go', standard);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  await withIndexedRepo('generated-full', root => {
    write(path.join(root, 'real.cpp'), 'int real() { return 1; }\n');
    write(path.join(root, 'thing.generated.h'), 'int generated_fn();\n');
  }, async (root, store, indexer) => {
    const r = await indexer.indexDirectory(root, {
      quiet: true,
      parallel: false,
      mode: 'full',
      includeGenerated: true,
    });
    const files = store.listFiles().map(f => f.relPath).sort();
    check(r.filesSkipped === 0, 'full/includeGenerated does not per-file skip generated headers', r);
    check(files.includes('thing.generated.h'), 'full/includeGenerated indexes generated header', files);
  });
}

async function protoFreshnessAndScanning(): Promise<void> {
  console.log('\n-- proto freshness and scanning --');
  await withIndexedRepo('proto-jit', root => {
    write(path.join(root, 'main.ts'), 'export function main(){ return 1; }\n');
    write(path.join(root, 'api.proto'), 'syntax = "proto3"; service UserService { rpc GetUser (Req) returns (Res); }\n');
  }, async (root, _store, indexer) => {
    const store = _store;
    const first = await jitSync(store, indexer, root, { maxDirty: 200 });
    const second = await jitSync(store, indexer, root, { maxDirty: 200 });
    check(first.removed === 0 && second.removed === 0, 'JIT does not report indexed proto as removed', { first, second });
    check(first.dirtyReindexed === 0 && second.dirtyReindexed === 0, 'JIT proto hash matches scanner hash on no-op', { first, second });
  });

  await withIndexedRepo('proto-rpc', root => {
    write(path.join(root, 'api.proto'), [
      'syntax = "proto3";',
      'service UserService {',
      '  rpc GetUser (Req) returns (Res) {',
      '    option (google.api.http) = { get: "/v1/users/{id}" };',
      '  }',
      '  rpc ListUsers (Req) returns (Res);',
      '}',
      '',
    ].join('\n'));
  }, async (_root, store) => {
    const ops = store.listRoutes({ framework: 'grpc', limit: 10 }).map(r => r.operation).sort();
    check(ops.includes('UserService/GetUser') && ops.includes('UserService/ListUsers'), 'proto scanner keeps RPCs after option body blocks', ops);
  });
}

async function jitElapsedDoesNotDoubleCountIndexerTime(): Promise<void> {
  console.log('\n-- jit elapsed accounting --');
  await withIndexedRepo('jit-elapsed', root => {
    write(path.join(root, 'main.ts'), 'export function main(){ return 1; }\n');
  }, async (root, store) => {
    fs.unlinkSync(path.join(root, 'main.ts'));
    const fakeIndexer = {
      indexDirectory: async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return { elapsedMs: 100_000 };
      },
    } as unknown as Indexer;
    const report = await jitSync(store, fakeIndexer, root, { maxDirty: 200 });
    check(report.removed === 1, 'JIT full reindex branch triggered by a removed file', report);
    check(report.elapsedMs < 100_000, 'JIT elapsedMs reports wall-clock time, not wall-clock plus indexer elapsed', report);
  });
}

async function composeHostsDoNotInventNestedKeys(): Promise<void> {
  console.log('\n-- compose service-host scan --');
  const root = tempRoot('compose-hosts');
  try {
    write(path.join(root, 'docker-compose.yml'), [
      'services:',
      '  api:',
      '    image: my-api:latest',
      '    ports:',
      '      - "8080:8080"',
      '  db:',
      '    image: postgres:16',
      '',
    ].join('\n'));
    const hosts = Array.from((await scanServiceHosts(root)).hosts.keys()).sort();
    check(JSON.stringify(hosts) === JSON.stringify(['api', 'db']), 'compose scanner records only service keys', hosts);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  await withIndexedRepo('compose-link', root => {
    write(path.join(root, 'docker-compose.yml'), [
      'services:',
      '  api:',
      '    image: my-api:latest',
      '',
    ].join('\n'));
    write(path.join(root, 'server.ts'), [
      'declare const app: any;',
      'declare const fetch: any;',
      'function health(req:any,res:any){}',
      "app.get('/health', health);",
      "export async function callImage(){ return fetch('http://image/health'); }",
      '',
    ].join('\n'));
  }, async (_root, store) => {
    const rows = store.rawDb().prepare(`
      SELECT sl.match_kind AS matchKind, sc.raw_target AS rawTarget
      FROM service_links sl JOIN service_calls sc ON sc.id = sl.call_id
    `).all() as Array<{ matchKind: string; rawTarget: string }>;
    check(!rows.some(r => r.matchKind === 'service_host' && r.rawTarget.includes('image')), 'nested compose key image does not create service_host link', rows);
  });
}

async function skeletonLineMath(): Promise<void> {
  console.log('\n-- skeleton line math --');
  await withIndexedRepo('skeleton', root => {
    write(path.join(root, 'main.ts'), 'export function main() {\n  return 1;\n}\n');
  }, async (_root, store) => {
    const skel = buildSkeleton(store, 'main.ts');
    const focus = buildSkeleton(store, 'main.ts', { focusSymbol: 'main' });
    check(Boolean(skel.skeleton?.includes('[L1-3]')), 'skeleton displays one-based inclusive line range', skel.skeleton);
    check(Boolean(focus.skeleton?.includes('return 1;')), 'focused skeleton includes actual body lines', focus.skeleton);
  });
}

async function deepCliDbLookup(): Promise<void> {
  console.log('\n-- deep CLI DB lookup --');
  const root = tempRoot('deep-cli');
  try {
    const deep = path.join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'g');
    fs.mkdirSync(deep, { recursive: true });
    write(path.join(root, 'main.ts'), 'export function main(){ return 1; }\n');
    const index = spawnSync(process.execPath, [path.join(__dirname, '..', 'dist', 'cli', 'index.js'), 'index', root, '--reset', '--no-parallel'], {
      encoding: 'utf8',
    });
    check(index.status === 0, 'built CLI indexes temp repo', index.stderr || index.stdout);
    const stats = spawnSync(process.execPath, [path.join(__dirname, '..', 'dist', 'cli', 'index.js'), 'stats'], {
      cwd: deep,
      encoding: 'utf8',
    });
    check(stats.status === 0 && stats.stdout.includes('Seer Index Stats'), 'CLI finds .seer/graph.db more than six levels up', stats.stderr || stats.stdout);

    const customDb = path.join(root, 'nested', '.seer', 'custom.db');
    const custom = spawnSync(process.execPath, [path.join(__dirname, '..', 'dist', 'cli', 'index.js'), 'index', root, '--db', customDb, '--reset', '--no-parallel'], {
      encoding: 'utf8',
    });
    check(custom.status === 0 && fs.existsSync(customDb), 'CLI creates parent directories for custom --db path', custom.stderr || custom.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function globalNpxLaunchersCarryWorkspace(): void {
  console.log('\n-- global npx launcher workspace --');
  const ws = tempRoot('init-global');
  try {
    const claude = runInit({ workspace: ws, clients: ['claude'], npx: true, print: true });
    const claudeSnippet = claude.entries[0].snippet ?? '';
    check(!claudeSnippet.includes('--workspace') && !claudeSnippet.includes(ws), 'project-local npx launcher stays portable', claudeSnippet);

    const windsurf = runInit({ workspace: ws, clients: ['windsurf'], npx: true, print: true });
    const windsurfSnippet = windsurf.entries[0].snippet ?? '';
    const windsurfArgs = JSON.parse(windsurfSnippet).mcpServers.seer.args as string[];
    check(windsurfArgs.includes('--workspace') && windsurfArgs.includes(ws), 'user-level-only Windsurf npx launcher pins workspace', windsurfArgs);

    const ag = runInit({ workspace: ws, clients: ['antigravity'], npx: true, print: true });
    const projectEntry = ag.entries.find(e => e.file.endsWith(path.join('.agents', 'mcp_config.json')));
    const projectRoot = JSON.parse(projectEntry?.snippet ?? '{}').mcpServers ?? {};
    const projectKey = Object.keys(projectRoot).find((k) => /^seer[_-]/.test(k) || k === 'seer');
    const projectEntryJson = projectKey ? projectRoot[projectKey] : undefined;
    const projectArgs = projectEntryJson?.args as string[] | undefined;
    const agGlobal = runInit({ workspace: ws, clients: ['antigravity'], npx: true, global: true, print: true });
    const globalEntries = agGlobal.entries.filter(e => path.isAbsolute(e.file) && !e.file.startsWith(ws));
    check(Boolean(projectArgs?.includes('--workspace') && projectArgs.includes(ws)),
      'Antigravity workspace-local entry pins workspace because IDE cwd can be outside repo', projectArgs);
    check(Boolean(projectKey && /^seer_/.test(projectKey) && projectEntryJson?.cwd === ws),
      'Antigravity workspace-local entry uses repo-specific server id and cwd', { projectKey, projectEntryJson });
    check(globalEntries.every(e => (e.snippet ?? '').includes('--workspace')), 'Antigravity --global entries pin workspace', globalEntries.map(e => e.snippet));
    check(globalEntries.every(e => {
      const root = JSON.parse(e.snippet ?? '{}').mcpServers ?? {};
      const key = Object.keys(root).find((k) => /^seer_/.test(k));
      return Boolean(key && root[key]?.cwd === ws);
    }), 'Antigravity --global entries use repo-specific server ids and cwd', globalEntries.map(e => e.snippet));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

async function callersFileDisambiguation(): Promise<void> {
  console.log('\n-- callers --file disambiguation --');
  await withIndexedRepo('callers-file', root => {
    write(path.join(root, 'src', 'alpha.ts'), [
      'export class Alpha {',
      '  run(): number { return 1; }',
      '}',
      'export function alphaOnly(): number {',
      '  const a = new Alpha();',
      '  return a.run();',
      '}',
      '',
    ].join('\n'));
    write(path.join(root, 'src', 'beta.ts'), [
      'export class Beta {',
      '  run(): number { return 2; }',
      '}',
      'export function betaOnly(): number {',
      '  const b = new Beta();',
      '  return b.run();',
      '}',
      '',
    ].join('\n'));
  }, async (root) => {
    const cli = path.join(__dirname, '..', 'dist', 'cli', 'index.js');
    const db = path.join(root, '.seer', 'graph.db');
    const broad = spawnSync(process.execPath, [cli, 'callers', 'run', '--db', db, '--limit', '20'], {
      encoding: 'utf8',
    });
    check(broad.status === 0 && broad.stdout.includes('alphaOnly') && broad.stdout.includes('betaOnly'),
      'name-only callers remain broad for shared short method names', broad.stderr || broad.stdout);

    const scoped = spawnSync(process.execPath, [
      cli, 'callers', 'Alpha.run', '--file', 'src/alpha.ts', '--db', db, '--limit', '20',
    ], { encoding: 'utf8' });
    check(scoped.status === 0 && scoped.stdout.includes('alphaOnly') && !scoped.stdout.includes('betaOnly'),
      'callers --file resolves qualified name to the exact symbol id', scoped.stderr || scoped.stdout);
  });
}

function ciWorkflowRuntime(): void {
  console.log('\n-- ci workflow runtime --');
  const workflow = workflowTemplate();
  check(workflow.includes("node-version: '24'"), 'generated CI workflow uses the supported Node 24 runtime');
  check(!workflow.includes("node-version: '22'"), 'generated CI workflow does not pin unsupported Node 22');
  check(workflow.includes('npx -y seer-mcp ci bundle'), 'generated CI workflow invokes the published Seer package');
  check(!workflow.includes('node dist/cli/index.js'), 'generated CI workflow does not assume Seer source checkout layout');
}

function reverseCallLookupIndexes(): void {
  console.log('\n-- reverse call lookup indexes --');
  const root = tempRoot('reverse-call-indexes');
  let store: Store | null = null;
  try {
    const dbPath = path.join(root, 'graph.db');
    store = new Store(dbPath);
    const db = store.rawDb();
    const indexes = (db.prepare("PRAGMA index_list('edges')").all() as Array<{ name: string }>).map(r => r.name);
    check(indexes.includes('idx_edges_to_name_kind'), 'edges has composite to_name+kind index for name-keyed caller counts', indexes);
    check(indexes.includes('idx_edges_to_id_kind_from'), 'edges has composite to_id+kind+from_id index for id-keyed reverse traversal', indexes);

    const byNamePlan = db.prepare(
      "EXPLAIN QUERY PLAN SELECT COUNT(*) AS c FROM edges WHERE to_name IN (?) AND kind = 'call'",
    ).all('Target') as Array<{ detail: string }>;
    const byIdPlan = db.prepare(
      "EXPLAIN QUERY PLAN SELECT DISTINCT from_id FROM edges WHERE to_id = ? AND kind = 'call'",
    ).all(1) as Array<{ detail: string }>;
    check(byNamePlan.some(p => p.detail.includes('idx_edges_to_name_kind')),
      'countCallers query plan uses the selective to_name+kind index', byNamePlan);
    check(byIdPlan.some(p => p.detail.includes('idx_edges_to_id_kind_from')),
      'reverse traversal query plan uses the selective to_id+kind+from_id index', byIdPlan);
  } finally {
    if (store) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function run(): Promise<void> {
  console.log('\nSeer Stability Regression Tests');
  console.log('================================');
  await metadataOnlyChangesRefresh();
  await generatedFiltering();
  await protoFreshnessAndScanning();
  await jitElapsedDoesNotDoubleCountIndexerTime();
  await composeHostsDoNotInventNestedKeys();
  await skeletonLineMath();
  await deepCliDbLookup();
  globalNpxLaunchersCarryWorkspace();
  await callersFileDisambiguation();
  ciWorkflowRuntime();
  reverseCallLookupIndexes();

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
