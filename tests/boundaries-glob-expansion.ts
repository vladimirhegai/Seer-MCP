/**
 * Boundary workspace-glob expansion.
 *
 * Regression for the handoff bug: boundary discovery documented workspace
 * member globs (package.json `workspaces`, pnpm-workspace.yaml, Cargo
 * `[workspace] members`, go.work `use`) but never expanded them. Repos whose
 * members live under non-convention roots like `components/*` WITHOUT their
 * own child manifest lost boundary/preflight/risk grouping entirely.
 *
 * Verifies each ecosystem expands declared member globs into boundaries even
 * when the member directory has no manifest of its own, that `!` exclusions
 * are honored, and that changing the declared globs changes the boundary
 * fingerprint (so a cached no-op re-index still rebuilds boundaries).
 *
 * Run: npx tsx tests/boundaries-glob-expansion.ts
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { Indexer } from '../src/indexer/index';
import { Store } from '../src/db/store';
import { boundaryInputFingerprint } from '../src/indexer/boundaries';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}`); failed++; }
}

function freshRoot(tag: string): string {
  const root = path.join(os.tmpdir(), `seer-bnd-glob-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  return root;
}
function write(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}
async function boundaryLabels(root: string): Promise<Map<string, { kind: string; rootRelPath: string }>> {
  const store = new Store(path.join(root, 'graph.db'));
  try {
    await new Indexer(store).indexDirectory(root, { quiet: true });
    const map = new Map<string, { kind: string; rootRelPath: string }>();
    for (const b of store.listBoundaries(500)) {
      map.set(b.label, { kind: b.kind, rootRelPath: b.rootRelPath.replace(/\\/g, '/') });
    }
    return map;
  } finally { store.close(); }
}

async function npmNonManifestMembers(): Promise<void> {
  console.log('\n-- npm workspaces: components/* without child manifests --');
  const root = freshRoot('npm');
  // Root declares members under a NON-convention root with no child manifests.
  write(root, 'package.json', JSON.stringify({
    name: 'app', private: true, workspaces: ['components/*', '!components/legacy'],
  }, null, 2));
  write(root, 'components/button/index.ts', 'export function Button(): string { return "b"; }\n');
  write(root, 'components/modal/index.ts', 'export function Modal(): string { return "m"; }\n');
  // Excluded member — must NOT become a boundary even though files are indexed.
  write(root, 'components/legacy/index.ts', 'export function Legacy(): string { return "l"; }\n');

  const labels = await boundaryLabels(root);
  assert(labels.has('button'), 'components/button expanded into a boundary (no child manifest)');
  assert(labels.has('modal'), 'components/modal expanded into a boundary (no child manifest)');
  assert(labels.get('button')?.rootRelPath === 'components/button', 'button boundary root is components/button');
  assert(!labels.has('legacy'), '!components/legacy exclusion honored — no boundary');
  fs.rmSync(root, { recursive: true, force: true });
}

async function pnpmWorkspaceYaml(): Promise<void> {
  console.log('\n-- pnpm-workspace.yaml: modules/* without child manifests --');
  const root = freshRoot('pnpm');
  // No package.json:workspaces — declaration lives only in the YAML.
  write(root, 'package.json', JSON.stringify({ name: 'root', private: true }, null, 2));
  write(root, 'pnpm-workspace.yaml', "packages:\n  - 'modules/*'\n  - \"!modules/scratch\"\n");
  write(root, 'modules/auth/auth.ts', 'export function login(): boolean { return true; }\n');
  write(root, 'modules/scratch/tmp.ts', 'export function tmp(): number { return 0; }\n');

  const labels = await boundaryLabels(root);
  assert(labels.has('auth'), 'modules/auth expanded from pnpm-workspace.yaml');
  assert(!labels.has('scratch'), '!modules/scratch exclusion honored from pnpm-workspace.yaml');
  fs.rmSync(root, { recursive: true, force: true });
}

async function cargoWorkspaceMembers(): Promise<void> {
  console.log('\n-- Cargo [workspace] members: crates/* without child Cargo.toml --');
  const root = freshRoot('cargo');
  write(root, 'Cargo.toml', '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/vendored"]\n');
  write(root, 'crates/engine/lib.rs', 'pub fn run() -> i32 { 1 }\n');
  write(root, 'crates/vendored/lib.rs', 'pub fn skip() -> i32 { 0 }\n');

  const labels = await boundaryLabels(root);
  assert(labels.has('engine'), 'crates/engine expanded from Cargo [workspace] members');
  assert(!labels.has('vendored'), 'Cargo exclude = [...] honored — no boundary');
  fs.rmSync(root, { recursive: true, force: true });
}

async function goWorkUses(): Promise<void> {
  console.log('\n-- go.work: use directives without child go.mod --');
  const root = freshRoot('go');
  write(root, 'go.work', 'go 1.21\n\nuse (\n  ./svc-a\n  ./svc-b // inline comment\n)\n');
  write(root, 'svc-a/main.go', 'package main\nfunc Handle() int { return 1 }\n');
  write(root, 'svc-b/main.go', 'package main\nfunc Serve() int { return 2 }\n');

  const labels = await boundaryLabels(root);
  assert(labels.has('svc-a'), 'go.work use ./svc-a expanded into a boundary');
  assert(labels.has('svc-b'), 'go.work use ./svc-b (with inline comment) expanded into a boundary');
  fs.rmSync(root, { recursive: true, force: true });
}

function fingerprintTracksDeclaredGlobs(): void {
  console.log('\n-- fingerprint reflects declared-glob changes --');
  const root = freshRoot('fp');
  write(root, 'package.json', JSON.stringify({ name: 'app', private: true, workspaces: ['components/*'] }, null, 2));
  write(root, 'components/button/index.ts', 'export const a = 1;\n');
  write(root, 'extra/widget/index.ts', 'export const b = 2;\n');

  const before = boundaryInputFingerprint(root);
  // Widening the globs to cover `extra/*` changes boundary inputs WITHOUT
  // touching any indexed source file — the cached-reindex path must notice.
  write(root, 'package.json', JSON.stringify({ name: 'app', private: true, workspaces: ['components/*', 'extra/*'] }, null, 2));
  const after = boundaryInputFingerprint(root);
  assert(before !== after, 'fingerprint changes when a workspace glob newly matches an existing dir');

  // Re-narrowing back to the original globs restores the original fingerprint.
  write(root, 'package.json', JSON.stringify({ name: 'app', private: true, workspaces: ['components/*'] }, null, 2));
  assert(boundaryInputFingerprint(root) === before, 'fingerprint is stable for identical declared globs');
  fs.rmSync(root, { recursive: true, force: true });
}

async function main(): Promise<void> {
  console.log('\nSeer — Boundary workspace-glob expansion');
  console.log('========================================');
  await npmNonManifestMembers();
  await pnpmWorkspaceYaml();
  await cargoWorkspaceMembers();
  await goWorkUses();
  fingerprintTracksDeclaredGlobs();
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
