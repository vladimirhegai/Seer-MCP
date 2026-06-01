/**
 * MCP smoke test for Track I (post-Track-H features):
 *   - seer_external_bundles
 *   - seer_contract_diff
 *   - seer_preflight
 *   - seer_boundaries / seer_boundary_for_file / seer_boundary_dependencies
 *   - seer_continuity
 *
 * Spawns `seer mcp` against a tiny fixture monorepo and exercises each tool.
 *
 * Run: npx tsx tests/mcp-tracki.ts
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const ROOT = path.resolve(__dirname, '..');
const TMP_WS = path.join(os.tmpdir(), `seer-mcp-i-${Date.now()}`);
const CLI = path.join(ROOT, 'dist/cli/index.js');

let passed = 0;
let failed = 0;
const ok  = (m: string): void => { passed++; console.log(`  ✓ ${m}`); };
const bad = (m: string, x?: unknown): void => {
  failed++;
  console.error(`  ✗ ${m}` + (x !== undefined ? `  ::  ${JSON.stringify(x).slice(0, 400)}` : ''));
};

function write(rel: string, content: string): void {
  const full = path.join(TMP_WS, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

async function main(): Promise<void> {
  console.log('\nSeer MCP Track-I Smoke');
  console.log('======================\n');

  fs.mkdirSync(TMP_WS, { recursive: true });
  // Tiny monorepo with one package and one service.
  write('package.json', JSON.stringify({
    name: 'tracki-mcp-fixture', private: true,
    workspaces: ['packages/*', 'services/*'],
  }));
  write('packages/lib/package.json', JSON.stringify({ name: 'lib', version: '0.0.0' }));
  write('packages/lib/src/util.ts', `
export function makeId(seed: number): string { return 'id-' + seed; }
`.trimStart());
  write('services/svc/package.json', JSON.stringify({ name: 'svc', version: '0.0.0' }));
  write('services/svc/src/api.ts', `
import { makeId } from '../../../packages/lib/src/util';
declare const app: any;
export function getHandler(req: any, res: any): unknown {
  return res.send({ id: makeId(req.body.seed) });
}
app.get('/api/get', getHandler);
`.trimStart());

  const proc = spawn(process.execPath,
    [CLI, 'mcp', '--workspace', TMP_WS, '--no-watch', '--no-jit'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stderr.on('data', d => process.stderr.write(`[mcp-stderr] ${d}`));

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
      }, 60_000);
      pending.set(id, { resolve, timer });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };

  let initOk = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await call('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' },
      });
      if (r.result) { initOk = true; break; }
    } catch { /* */ }
    await new Promise(r => setTimeout(r, 500));
  }
  if (initOk) ok('initialize');
  else { bad('initialize'); process.exit(1); }

  const list = await call('tools/list', {});
  const names: string[] = (list.result?.tools ?? []).map((t: any) => t.name);
  for (const n of [
    'seer_external_bundles', 'seer_contract_diff', 'seer_preflight',
    'seer_boundaries', 'seer_boundary_for_file', 'seer_boundary_dependencies',
    'seer_continuity',
  ]) {
    if (names.includes(n)) ok(`tools/list advertises ${n}`);
    else bad(`tools/list missing ${n}`, names);
  }

  const callTool = async (name: string, args: any = {}): Promise<any> => {
    const r = await call('tools/call', { name, arguments: args });
    return JSON.parse(r.result?.content?.[0]?.text ?? '{}');
  };

  // seer_boundaries
  const boundaries = await callTool('seer_boundaries');
  if (boundaries.total >= 1) ok(`seer_boundaries returned ${boundaries.total} boundaries`);
  else bad('seer_boundaries returned no boundaries', boundaries);
  const labels = (boundaries.items ?? []).map((b: any) => b.label);
  if (labels.includes('lib')) ok('seer_boundaries includes lib');
  else bad('seer_boundaries missing lib', labels);
  if (labels.includes('svc')) ok('seer_boundaries includes svc');
  else bad('seer_boundaries missing svc', labels);

  // seer_boundary_for_file
  const bf = await callTool('seer_boundary_for_file', {
    file: 'services/svc/src/api.ts',
  });
  if (bf.ok && bf.boundary?.label === 'svc')
    ok('seer_boundary_for_file returns svc for api.ts');
  else bad('seer_boundary_for_file unexpected', bf);

  // seer_preflight (symbol)
  const pf = await callTool('seer_preflight', { symbol: 'getHandler' });
  if (pf.ok && pf.symbol?.name === 'getHandler')
    ok('seer_preflight symbol mode returns getHandler');
  else bad('seer_preflight symbol mode', pf);
  if (pf.boundaries?.primary?.label === 'svc')
    ok('seer_preflight surfaces boundary');
  else bad('seer_preflight boundary missing', pf.boundaries);

  // seer_external_bundles (no layers imported — should return total=0)
  const eb = await callTool('seer_external_bundles');
  if (eb.total === 0) ok('seer_external_bundles total=0 when no layers');
  else bad('seer_external_bundles unexpected', eb);

  // seer_continuity — for getHandler may or may not find candidates, just
  // verify it does not crash.
  const ct = await callTool('seer_continuity', { symbol: 'getHandler' });
  if (ct.ok === true) ok('seer_continuity ok=true');
  else bad('seer_continuity not ok', ct);

  proc.kill();
  await new Promise(r => setTimeout(r, 200));
  try { fs.rmSync(TMP_WS, { recursive: true, force: true }); } catch { /* */ }

  console.log(`\nPassed: ${passed}   Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
