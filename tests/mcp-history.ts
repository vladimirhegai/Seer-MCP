/**
 * Regression coverage for MCP history behavior.
 *
 * seer_history auto-builds JUST the queried symbol's file(s) inline on a cold
 * miss (bounded ~1s) so "history of one symbol" works on the first call. The
 * pure read-only path is still available via autoBuild=false, and the FULL
 * index build stays explicit (seer_symbol_history_build, bounded by
 * maxSeconds/maxFiles). This suite checks both paths plus the scoped builds.
 *
 * Run: npm run build && npx tsx tests/mcp-history.ts
 */

import { spawn, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const ROOT = path.resolve(__dirname, '..');
const TMP_WS = path.join(os.tmpdir(), `seer-mcp-history-${Date.now()}`);
const CLI = path.join(ROOT, 'dist/cli/index.js');

let passed = 0;
let failed = 0;
function ok(label: string): void { passed++; console.log(`  PASS ${label}`); }
function bad(label: string, extra?: unknown): void {
  failed++;
  console.error(`  FAIL ${label}` + (extra !== undefined ? ` :: ${JSON.stringify(extra).slice(0, 400)}` : ''));
}

function git(args: string[]): boolean {
  const r = spawnSync('git', args, { cwd: TMP_WS, encoding: 'utf8', timeout: 10_000, windowsHide: true });
  return r.status === 0;
}

async function main(): Promise<void> {
  console.log('\nSeer MCP History Regression\n=============================\n');

  const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true }).status === 0;
  if (!hasGit) {
    console.log('  skipping: git is not available');
    return;
  }

  fs.mkdirSync(TMP_WS, { recursive: true });
  fs.writeFileSync(path.join(TMP_WS, 'sample.ts'), [
    'export function historyTarget(): number {',
    '  return 1;',
    '}',
    '',
  ].join('\n'));
  // A second symbol in its own file exercises the read-only (autoBuild=false)
  // and the inline auto-build paths without colliding with the scoped/full
  // builds that the first file (historyTarget) drives.
  fs.writeFileSync(path.join(TMP_WS, 'other.ts'), [
    'export function otherTarget(): number {',
    '  return 2;',
    '}',
    '',
  ].join('\n'));

  if (!git(['init'])) { bad('git init'); return; }
  git(['config', 'user.email', 'seer@example.test']);
  git(['config', 'user.name', 'Seer Test']);
  if (!git(['add', '.'])) { bad('git add'); return; }
  if (!git(['commit', '-m', 'initial history target'])) { bad('git commit'); return; }

  const proc = spawn(process.execPath, [CLI, 'mcp', '--workspace', TMP_WS, '--no-watch', '--no-jit'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
  function call(method: string, params: any, timeoutMs = 30_000): Promise<any> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); }
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  try {
    await call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-history', version: '0.1.0' },
    });

    // Read-only path: autoBuild=false must NOT build inline — rows stay 0 and a
    // buildHint points at the recovery (re-call without the flag, or the scoped
    // build tool). Uses otherTarget so the global index stays cold for the
    // scoped/full-build steps below.
    const before = await call('tools/call', {
      name: 'seer_history',
      arguments: { symbol: 'otherTarget', limit: 5, autoBuild: false },
    }, 5_000);
    const beforeParsed = JSON.parse(before.result?.content?.[0]?.text ?? '{}');
    if (beforeParsed.historyIndex?.built === false && beforeParsed.historyIndex?.rows === 0
        && beforeParsed.autoBuild === undefined) {
      ok('seer_history autoBuild=false stays read-only (no inline build)');
    } else {
      bad('seer_history autoBuild=false built or omitted historyIndex', beforeParsed);
    }
    // The read-only miss must carry an actionable buildHint.
    if (typeof beforeParsed.buildHint === 'string'
        && beforeParsed.buildHint.includes('seer_symbol_history_build')
        && beforeParsed.buildHint.includes('otherTarget')) {
      ok('seer_history surfaces a buildHint when read-only and nothing is built');
    } else {
      bad('seer_history missing buildHint on cold read-only call', beforeParsed.buildHint);
    }

    // A scoped request that resolves no files must NOT silently fall through to
    // a full build. It should no-op with unresolvedSymbols and leave the global
    // history index unbuilt.
    const unresolvedScoped = await call('tools/call', {
      name: 'seer_symbol_history_build',
      arguments: { symbols: ['missingHistoryTarget'], gitCommandTimeoutMs: 5000 },
    }, 5_000);
    const unresolvedScopedParsed = JSON.parse(unresolvedScoped.result?.content?.[0]?.text ?? '{}');
    if (unresolvedScopedParsed.scoped === true
        && unresolvedScopedParsed.scopedFiles === 0
        && unresolvedScopedParsed.historyRowsInserted === 0
        && Array.isArray(unresolvedScopedParsed.unresolvedSymbols)
        && unresolvedScopedParsed.historyIndex?.lastHistoryHeadSha == null) {
      ok('unresolved scoped history build no-ops instead of falling through to a full build');
    } else {
      bad('unresolved scoped history build fell through or returned the wrong contract', unresolvedScopedParsed);
    }

    // Thrust A: SCOPED on-demand build of just this symbol's file. Must report
    // scoped:true and NOT stamp the global index as fully built.
    const scoped = await call('tools/call', {
      name: 'seer_symbol_history_build',
      arguments: { symbols: ['historyTarget'], gitCommandTimeoutMs: 5000 },
    }, 15_000);
    const scopedParsed = JSON.parse(scoped.result?.content?.[0]?.text ?? '{}');
    // Scoped build populates rows but must NOT stamp the global HEAD
    // (lastHistoryHeadSha stays null — that is the "fully built" signal).
    if (scopedParsed.scoped === true && scopedParsed.historyRowsInserted >= 1
        && scopedParsed.historyIndex?.lastHistoryHeadSha == null) {
      ok('seer_symbol_history_build scoped path builds one symbol without marking the index fully built');
    } else {
      bad('scoped build did not behave as expected', scopedParsed);
    }

    // After the scoped build, seer_history has rows AND drops the buildHint,
    // even though the GLOBAL index is still not fully built.
    const mid = await call('tools/call', {
      name: 'seer_history',
      arguments: { symbol: 'historyTarget', limit: 5 },
    }, 5_000);
    const midParsed = JSON.parse(mid.result?.content?.[0]?.text ?? '{}');
    if (midParsed.results?.[0]?.returned >= 1 && midParsed.buildHint === undefined
        && midParsed.historyIndex?.lastHistoryHeadSha == null) {
      ok('seer_history reads scoped-built rows and drops the buildHint (global still unbuilt)');
    } else {
      bad('seer_history did not reflect scoped build', midParsed);
    }

    // NEW: inline auto-build. otherTarget has never been built and the global
    // index is still not fully built, so a DEFAULT seer_history call builds just
    // its file inline and returns rows in one shot — no separate build step.
    const auto = await call('tools/call', {
      name: 'seer_history',
      arguments: { symbol: 'otherTarget', limit: 5 },
    }, 20_000);
    const autoParsed = JSON.parse(auto.result?.content?.[0]?.text ?? '{}');
    if (autoParsed.autoBuild?.ran === true && autoParsed.results?.[0]?.returned >= 1
        && autoParsed.buildHint === undefined) {
      ok('seer_history auto-builds the symbol file inline on a cold miss and returns rows');
    } else {
      bad('seer_history did not auto-build on cold miss', autoParsed);
    }

    const build = await call('tools/call', {
      name: 'seer_symbol_history_build',
      arguments: { maxSeconds: 10, maxFiles: 2, gitCommandTimeoutMs: 5000, force: true },
    }, 20_000);
    const buildParsed = JSON.parse(build.result?.content?.[0]?.text ?? '{}');
    if (buildParsed.completed === true && buildParsed.historyRowsInserted >= 1 && buildParsed.scoped === false) {
      ok('seer_symbol_history_build completes bounded explicit FULL build');
    } else {
      bad('seer_symbol_history_build failed to populate history', buildParsed);
    }

    const after = await call('tools/call', {
      name: 'seer_history',
      arguments: { symbol: 'historyTarget', limit: 5 },
    }, 5_000);
    const afterParsed = JSON.parse(after.result?.content?.[0]?.text ?? '{}');
    if (afterParsed.historyIndex?.built === true && afterParsed.results?.[0]?.returned >= 1) {
      ok('seer_history reads explicit history index');
    } else {
      bad('seer_history did not read built history', afterParsed);
    }
  } finally {
    proc.stdin.end();
    proc.kill();
    await new Promise(r => setTimeout(r, 200));
    try { fs.rmSync(TMP_WS, { recursive: true, force: true }); } catch { /* */ }
  }

  console.log(`\nMCP history: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('mcp-history crashed:', err); process.exit(1); });
