/**
 * MCP smoke test for Track-F tools (portability + precision). Spawns
 * `seer mcp` against the fixtures-trackf workspace and exercises every new
 * tool over stdio.
 *
 * Run: npx tsx tests/mcp-trackf.ts
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const ROOT = path.resolve(__dirname, '..');
const FIX = path.join(ROOT, 'tests/fixtures-trackf');
const TMP_WS = path.join(os.tmpdir(), `seer-mcp-f-${Date.now()}`);
const CLI = path.join(ROOT, 'dist/cli/index.js');

let passed = 0;
let failed = 0;
const ok = (m: string): void => { passed++; console.log(`  ✓ ${m}`); };
const bad = (m: string, x?: unknown): void => { failed++; console.error(`  ✗ ${m}` + (x !== undefined ? `  ::  ${JSON.stringify(x).slice(0, 300)}` : '')); };

function copyRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function main(): Promise<void> {
  console.log('\nSeer MCP Track-F Smoke\n==========================\n');
  copyRecursive(FIX, TMP_WS);
  console.log(`  Workspace: ${TMP_WS}`);

  const proc = spawn(process.execPath, [CLI, 'mcp', '--workspace', TMP_WS, '--no-watch', '--no-jit'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stderr.on('data', (d) => process.stderr.write(`[mcp-stderr] ${d}`));

  let buf = '';
  const pending = new Map<number, { resolve: (msg: any) => void; timer: NodeJS.Timeout }>();
  proc.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      const pendingCall = msg.id != null ? pending.get(msg.id) : undefined;
      if (pendingCall) {
        clearTimeout(pendingCall.timer);
        pending.delete(msg.id);
        pendingCall.resolve(msg);
      }
    }
  });

  let nextId = 1;
  const call = (method: string, params: any): Promise<any> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); }
      }, 30_000);
      pending.set(id, { resolve, timer });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };

  // Wait for ready
  let initOk = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await call('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' },
      });
      if (r.result) { initOk = true; break; }
    } catch { /* */ }
    await new Promise(r => setTimeout(r, 500));
  }
  if (initOk) ok('initialize'); else { bad('initialize'); process.exit(1); }

  // tools/list — verify Track-F tools are advertised
  const list = await call('tools/list', {});
  const names: string[] = (list.result?.tools ?? []).map((t: any) => t.name);
  const trackfTools = [
    'seer_bundle_export', 'seer_bundle_info', 'seer_bundle_import',
    'seer_scip_import', 'seer_scip_imports', 'seer_provenance',
    'seer_duplicates', 'seer_shape_hash_build',
  ];
  for (const n of trackfTools) {
    if (names.includes(n)) ok(`tools/list advertises ${n}`);
    else bad(`tools/list missing ${n}`, names);
  }

  const callTool = async (name: string, args: any = {}): Promise<any> => {
    const r = await call('tools/call', { name, arguments: args });
    return JSON.parse(r.result?.content?.[0]?.text ?? '{}');
  };

  // seer_health surfaces v7 fields
  const health = await callTool('seer_health', {});
  if (health.schemaVersion === 10) ok(`seer_health.schemaVersion = 10`);
  else bad(`seer_health.schemaVersion not 9`, health);
  if (health.provenance && health.provenance.symbols)
    ok(`seer_health.provenance present`);
  else bad('seer_health.provenance missing', health);
  if (typeof health.shapeHashed === 'number' && health.shapeHashed >= 3)
    ok(`seer_health.shapeHashed = ${health.shapeHashed}`);
  else bad('seer_health.shapeHashed low', health);
  if (typeof health.scipImports === 'number' && health.scipImports === 0)
    ok('seer_health.scipImports = 0 pre-SCIP');
  else bad('seer_health.scipImports unexpected', health);

  // seer_provenance
  const prov = await callTool('seer_provenance', {});
  if (prov.provenance?.symbols?.['tree-sitter'] >= 3)
    ok(`seer_provenance has tree-sitter symbols`);
  else bad('seer_provenance missing tree-sitter symbols', prov);
  if (Array.isArray(prov.scipImports)) ok('seer_provenance.scipImports is an array');
  else bad('seer_provenance.scipImports not array', prov);

  // seer_duplicates — fetchUserById ≡ fetchOrderById
  const dupes = await callTool('seer_duplicates', { maxDistance: 4, minLoc: 3 });
  if (dupes.clusters >= 1) ok(`seer_duplicates found ${dupes.clusters} cluster(s)`);
  else bad('seer_duplicates empty', dupes);
  const fetchPair = (dupes.items ?? []).find((c: any) =>
    c.symbols?.some((s: any) => s.name === 'fetchUserById') &&
    c.symbols?.some((s: any) => s.name === 'fetchOrderById'));
  if (fetchPair) ok('seer_duplicates clusters fetchUserById + fetchOrderById together');
  else bad('seer_duplicates missing fetch* cluster', dupes.items);

  // seer_shape_hash_build is idempotent
  const sh = await callTool('seer_shape_hash_build', {});
  if (typeof sh.symbolsHashed === 'number' && sh.symbolsHashed === 0)
    ok('seer_shape_hash_build idempotent (re-run hashed 0)');
  else bad('seer_shape_hash_build not idempotent', sh);

  // seer_bundle_export
  const bundleOut = path.join(TMP_WS, 'mcp-export.seerbundle');
  const exp = await callTool('seer_bundle_export', { out: bundleOut, compressionLevel: 9 });
  if (exp.bundlePath === bundleOut) ok('seer_bundle_export writes to requested path');
  else bad('seer_bundle_export wrong path', exp);
  if (fs.existsSync(bundleOut)) ok('seer_bundle_export bundle exists on disk');
  else bad('bundle not on disk', exp);
  if (exp.manifest?.schemaVersion === 10) ok('exported manifest.schemaVersion=10');
  else bad('exported manifest wrong', exp.manifest);

  // seer_bundle_info — manifest peek
  const info = await callTool('seer_bundle_info', { bundle: bundleOut });
  if (info.schemaVersion === 10) ok('seer_bundle_info reads manifest');
  else bad('seer_bundle_info wrong', info);
  if (info.index?.symbols >= 3) ok('seer_bundle_info reports symbol count');
  else bad('seer_bundle_info missing symbols', info.index);

  // Bad bundle path → graceful error envelope
  const badInfo = await callTool('seer_bundle_info', { bundle: path.join(TMP_WS, 'no-such.bundle') });
  if (badInfo.ok === false) ok('seer_bundle_info(missing path) → ok=false');
  else bad('seer_bundle_info did not surface missing', badInfo);

  // seer_scip_import — author + import a tiny SCIP doc
  const scipJson = {
    tool: 'scip-mcp-test/0.0.1',
    documents: [
      {
        relativePath: 'src/auth.ts',
        symbols: [
          {
            symbolId: 'auth#login',
            displayName: 'login',
            qualifiedName: 'AuthService.login',
            kind: 'method',
            relativePath: 'src/auth.ts',
            range: { startLine: 3, startCharacter: 0, endLine: 6, endCharacter: 1 },
          },
        ],
        occurrences: [],
      },
    ],
  };
  const scipPath = path.join(TMP_WS, 'auth.scip.json');
  fs.writeFileSync(scipPath, JSON.stringify(scipJson));
  const scipImp = await callTool('seer_scip_import', { scipPath });
  if (scipImp.documentsProcessed === 1) ok('seer_scip_import processed 1 doc');
  else bad('seer_scip_import wrong doc count', scipImp);
  if ((scipImp.symbolsMerged ?? 0) >= 1) ok('seer_scip_import merged ≥1 existing symbol');
  else bad('seer_scip_import did not merge', scipImp);

  // seer_scip_imports — listing
  const sciList = await callTool('seer_scip_imports', {});
  if (Array.isArray(sciList.items) && sciList.items.length === 1)
    ok('seer_scip_imports lists 1 entry post-import');
  else bad('seer_scip_imports listing wrong', sciList);
  if (sciList.provenance?.symbols['scip-merge'] >= 1)
    ok('seer_scip_imports provenance includes scip-merge bucket');
  else bad('scip-merge bucket missing', sciList.provenance);

  // Re-import is idempotent
  const scipImp2 = await callTool('seer_scip_import', { scipPath });
  if (scipImp2.symbolsInserted === 0 && scipImp2.symbolsMerged === 0)
    ok('seer_scip_import is idempotent on same path+sha');
  else bad('seer_scip_import not idempotent', scipImp2);

  // seer_bundle_import — round-trip the just-exported bundle into a fresh
  // location (overwrite=true since the workspace already has a DB).
  // Importing back over the live DB is supported via overwrite=true; the
  // server re-opens transparently.
  const reImport = await callTool('seer_bundle_import', {
    bundle: bundleOut, overwrite: true,
  });
  if (reImport.ok === true) ok('seer_bundle_import overwrite=true succeeds');
  else bad('seer_bundle_import failed', reImport);

  // Health after re-import still healthy.
  const health2 = await callTool('seer_health', {});
  if (health2.schemaVersion === 10) ok('post-import seer_health.schemaVersion = 10');
  else bad('post-import schema wrong', health2);

  // Bundle import refuses missing file
  const importMissing = await callTool('seer_bundle_import', {
    bundle: path.join(TMP_WS, 'no-such.bundle'), overwrite: true,
  });
  if (importMissing.ok === false) ok('seer_bundle_import(missing) → ok=false');
  else bad('seer_bundle_import did not refuse missing', importMissing);

  proc.stdin.end(); proc.kill();
  await new Promise(r => setTimeout(r, 200));

  // ── Bug 4 regression at the MCP layer ────────────────────────────────
  // Spin up a second MCP server with --db <customPath>, import the bundle,
  // then confirm the imported DB lives at customPath rather than the
  // workspace default. Pre-fix, the bundle landed at <workspace>/.seer/
  // graph.db while the server kept reading customPath.
  console.log('\n── Bug 4: MCP --db honoured by bundle import ──');
  const customWs = TMP_WS + '-custom';
  copyRecursive(FIX, customWs);
  const customDb = path.join(customWs, 'sub', 'elsewhere.db');
  fs.mkdirSync(path.dirname(customDb), { recursive: true });

  const bundlePath = path.join(TMP_WS, 'mcp-export.seerbundle');
  // Sanity: the bundle was already exported by the first server above; reuse it.
  if (!fs.existsSync(bundlePath)) {
    bad('bundle from first phase missing — cannot test --db');
  } else {
    const proc2 = spawn(process.execPath,
      [CLI, 'mcp', '--workspace', customWs, '--db', customDb, '--no-watch', '--no-jit'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    proc2.stderr.on('data', (d) => process.stderr.write(`[mcp2-stderr] ${d}`));

    let buf2 = '';
    const pending2 = new Map<number, { resolve: (msg: any) => void; timer: NodeJS.Timeout }>();
    proc2.stdout.on('data', (chunk: Buffer) => {
      buf2 += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf2.indexOf('\n')) >= 0) {
        const line = buf2.slice(0, nl).trim();
        buf2 = buf2.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        const pendingCall = msg.id != null ? pending2.get(msg.id) : undefined;
        if (pendingCall) {
          clearTimeout(pendingCall.timer);
          pending2.delete(msg.id);
          pendingCall.resolve(msg);
        }
      }
    });
    let id2 = 1;
    const call2 = (method: string, params: any): Promise<any> => {
      const id = id2++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending2.has(id)) { pending2.delete(id); reject(new Error(`timeout ${method}`)); }
        }, 30_000);
        pending2.set(id, { resolve, timer });
        proc2.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    };
    let init2Ok = false;
    for (let i = 0; i < 30; i++) {
      try {
        const r = await call2('initialize', {
          protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' },
        });
        if (r.result) { init2Ok = true; break; }
      } catch { /* */ }
      await new Promise(r => setTimeout(r, 500));
    }
    if (!init2Ok) { bad('initialize on --db server'); }
    else {
      ok('--db server initialized');
      // Health should report a non-empty index because MCP's first-touch
      // logic runs `indexDirectory` against customDb if it's empty.
      const r = await call2('tools/call', {
        name: 'seer_bundle_import',
        arguments: { bundle: bundlePath, overwrite: true },
      });
      const out = JSON.parse(r.result?.content?.[0]?.text ?? '{}');
      if (out.ok === true && out.dbPath === customDb)
        ok(`bundle_import landed at --db path (${customDb})`);
      else bad('bundle_import did not land at --db path', out);

      // Default workspace path must NOT have been created.
      const defaultPath = path.join(customWs, '.seer', 'graph.db');
      if (!fs.existsSync(defaultPath))
        ok('default <workspace>/.seer/graph.db was NOT created by import');
      else bad('default DB path was clobbered despite --db override');

      // Health after import still reports the schema.
      const h2 = await call2('tools/call', {
        name: 'seer_health', arguments: {},
      });
      const health2 = JSON.parse(h2.result?.content?.[0]?.text ?? '{}');
      if (health2.schemaVersion === 10 && health2.dbPath === customDb)
        ok('post-import health.dbPath still equals --db override');
      else bad('post-import health did not honour --db', health2);
    }
    proc2.stdin.end(); proc2.kill();
    await new Promise(r => setTimeout(r, 200));
  }

  try { fs.rmSync(TMP_WS, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(customWs, { recursive: true, force: true }); } catch { /* */ }

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  MCP Track-F: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('mcp-trackf crashed:', err); process.exit(1); });
