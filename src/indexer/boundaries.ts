/**
 * v10 — Monorepo package/service boundary detection.
 *
 * Source signals (in priority order — earlier sources win on overlap):
 *   1. Nested manifest files:
 *      - package.json (npm/yarn/pnpm workspaces)
 *      - pyproject.toml
 *      - Cargo.toml
 *      - go.mod
 *      - composer.json
 *   2. Workspace-declared member globs — expanded into member boundaries even
 *      when the member directory carries NO child manifest of its own
 *      (e.g. `components/*`):
 *      - package.json:workspaces (array or { packages: [...] })
 *      - pnpm-workspace.yaml (packages:)
 *      - go.work (use directives)
 *      - Cargo workspace members (parent Cargo.toml [workspace] members)
 *   3. Convention fallback:
 *      - packages/<name>/
 *      - services/<name>/
 *      - apps/<name>/
 *      - libs/<name>/
 *
 * Each detected boundary owns a contiguous subtree of files. The TRUE root
 * is the deepest manifest/glob root — so `packages/core/src/lib/foo.ts`
 * belongs to `packages/core/` if a package.json sits there.
 *
 * Boundary `label` is derived from the manifest name (`@scope/pkg` → `pkg`,
 * etc.) when present, else from the root_rel_path segment.
 *
 * Boundary dependencies come from cross-boundary call/import/service edges
 * aggregated across resolved graphs. Strictly advisory — never gates anything.
 */

import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { Store } from '../db/store.js';

export interface BoundaryDef {
  label: string;
  kind: 'package' | 'service' | 'app' | 'lib' | 'workspace-root' | 'convention';
  rootRelPath: string;
  manifestPath: string | null;
  ecosystem: string | null;
  fileIds: number[];
}

export interface BoundaryEdgeDef {
  fromIndex: number;
  toIndex: number;
  kind: 'call' | 'import' | 'service';
  weight: number;
}

export interface BoundaryBuildResult {
  boundaries: BoundaryDef[];
  edges: BoundaryEdgeDef[];
  /** Files that didn't match any boundary. */
  orphanFiles: number;
}

interface ManifestHit {
  relRoot: string;
  manifestPath: string;
  label: string;
  kind: BoundaryDef['kind'];
  ecosystem: string | null;
  /** How the root was discovered. Drives priority on overlap:
   *  manifest > glob (workspace-declared member) > convention. */
  source: 'manifest' | 'glob' | 'convention';
}

/** A workspace declaration that names member globs/paths, e.g. a root
 *  package.json `workspaces`, pnpm-workspace.yaml `packages:`, a Cargo
 *  `[workspace] members`, or go.work `use` directives. `baseRel` is the
 *  directory (relative to the workspace root) the patterns resolve against. */
interface WorkspaceGlobDecl {
  baseRel: string;
  includes: string[];
  excludes: string[];
  ecosystem: string;
}

// Directories that never own boundaries and should be skipped while walking
// or expanding workspace member globs.
const BOUNDARY_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  'target', 'obj', '.gradle', '__pycache__', '.cache', '.idea',
  '.vs', '.seer',
]);

/**
 * Single source of truth for boundary roots, shared by the real build and the
 * cheap fingerprint. Order matters: manifest hits first (they win on overlap),
 * then workspace-glob members, then the convention fallback.
 */
function collectBoundaryHits(absRoot: string): ManifestHit[] {
  const { hits, decls } = discoverManifests(absRoot);
  expandWorkspaceMembers(absRoot, decls, hits);
  seedConventionRoots(absRoot, hits);
  return hits;
}

/**
 * Detect boundaries by walking the workspace once for manifests + convention
 * fallback, then assigning each indexed file to the deepest matching
 * boundary root.
 */
export function buildBoundaries(workspace: string, store: Store): BoundaryBuildResult {
  const absRoot = path.resolve(workspace);

  // Discover manifest hits, expand workspace-declared member globs, and seed
  // convention-based hits where no manifest/glob matches a directory.
  const hits = collectBoundaryHits(absRoot);

  // Materialize hits as boundary defs. De-dup by relRoot — manifest wins
  // over convention.
  const byRel = new Map<string, ManifestHit>();
  for (const h of hits) {
    const prev = byRel.get(h.relRoot);
    if (!prev || rank(h) > rank(prev)) byRel.set(h.relRoot, h);
  }
  const sortedHits = Array.from(byRel.values()).sort((a, b) =>
    b.relRoot.length - a.relRoot.length || (a.relRoot < b.relRoot ? -1 : 1));

  // Assign every indexed file to the deepest matching hit.
  const files = store.listFiles();
  const fileToHit = new Map<number, ManifestHit | null>();
  for (const f of files) {
    let assigned: ManifestHit | null = null;
    const rel = normalizePath(f.relPath);
    for (const h of sortedHits) {
      const root = h.relRoot;
      if (root === '' || root === '.') continue;
      if (rel === root || rel.startsWith(root + '/')) {
        assigned = h;
        break;
      }
    }
    fileToHit.set(f.id, assigned);
  }

  // Build boundary list (only include hits that own at least one file).
  const boundariesByRoot = new Map<string, BoundaryDef & { _index: number }>();
  const definitions: BoundaryDef[] = [];
  let nextIndex = 0;
  for (const h of sortedHits) {
    const def: BoundaryDef = {
      label: h.label, kind: h.kind, rootRelPath: h.relRoot,
      manifestPath: h.manifestPath || null, ecosystem: h.ecosystem,
      fileIds: [],
    };
    boundariesByRoot.set(h.relRoot, { ...def, _index: nextIndex });
    nextIndex++;
  }
  for (const [fileId, hit] of fileToHit) {
    if (!hit) continue;
    const b = boundariesByRoot.get(hit.relRoot);
    if (!b) continue;
    b.fileIds.push(fileId);
  }
  // Drop empty boundaries (e.g. convention `services/` parent with no files).
  for (const b of boundariesByRoot.values()) {
    if (b.fileIds.length === 0) continue;
    definitions.push({
      label: b.label, kind: b.kind, rootRelPath: b.rootRelPath,
      manifestPath: b.manifestPath, ecosystem: b.ecosystem, fileIds: b.fileIds,
    });
  }
  // Re-index after dropping.
  const indexByRoot = new Map<string, number>();
  definitions.forEach((d, i) => indexByRoot.set(d.rootRelPath, i));

  // Build boundary→boundary edges from the resolved file-call / file-import /
  // service-link graphs.
  const edges = aggregateBoundaryEdges(store, fileToHit, indexByRoot);

  let orphan = 0;
  for (const [_id, h] of fileToHit) if (!h) orphan++;

  return { boundaries: definitions, edges, orphanFiles: orphan };
}

export function boundaryInputFingerprint(workspace: string): string {
  const absRoot = path.resolve(workspace);
  const hits = collectBoundaryHits(absRoot);
  const parts = hits
    .map(h => [
      normalizePath(h.relRoot),
      normalizePath(h.manifestPath),
      h.label,
      h.kind,
      h.ecosystem ?? '',
    ].join('\0'))
    .sort();
  return crypto.createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex').slice(0, 16);
}

function rank(h: ManifestHit): number {
  // Manifest > workspace-glob member > convention.
  switch (h.source) {
    case 'manifest': return 2;
    case 'glob':     return 1;
    default:         return 0; // convention
  }
}

function aggregateBoundaryEdges(
  store: Store,
  fileToHit: Map<number, ManifestHit | null>,
  indexByRoot: Map<string, number>,
): BoundaryEdgeDef[] {
  const buckets = new Map<string, BoundaryEdgeDef>();
  const lookup = (fileId: number): number | null => {
    const h = fileToHit.get(fileId) ?? null;
    if (!h) return null;
    const idx = indexByRoot.get(h.relRoot);
    return idx == null ? null : idx;
  };
  const push = (from: number, to: number, kind: BoundaryEdgeDef['kind'], weight: number): void => {
    if (from === to) return;
    const key = `${from}|${to}|${kind}`;
    const existing = buckets.get(key);
    if (existing) existing.weight += weight;
    else buckets.set(key, { fromIndex: from, toIndex: to, kind, weight });
  };
  for (const e of store.fileCallEdgeWeights()) {
    const a = lookup(e.from); const b = lookup(e.to);
    if (a != null && b != null) push(a, b, 'call', e.weight);
  }
  for (const e of store.fileImportEdgeWeights()) {
    const a = lookup(e.from); const b = lookup(e.to);
    if (a != null && b != null) push(a, b, 'import', e.weight);
  }
  try {
    for (const e of store.fileServiceLinkEdgeWeights()) {
      const a = lookup(e.from); const b = lookup(e.to);
      if (a != null && b != null) push(a, b, 'service', e.weight);
    }
  } catch { /* */ }
  return Array.from(buckets.values()).sort((a, b) =>
    a.fromIndex - b.fromIndex || a.toIndex - b.toIndex || (a.kind < b.kind ? -1 : 1));
}

// ── Manifest discovery ──────────────────────────────────────────────────

function discoverManifests(absRoot: string): { hits: ManifestHit[]; decls: WorkspaceGlobDecl[] } {
  const hits: ManifestHit[] = [];
  const decls: WorkspaceGlobDecl[] = [];

  function walk(absDir: string, relDir: string, depth: number): void {
    if (depth > 6) return; // bound recursion — boundaries beyond ~6 levels are rare
    let entries: string[];
    try { entries = fs.readdirSync(absDir); }
    catch { return; }
    const fileSet = new Set(entries);
    let claimed = false;

    // package.json — may declare workspaces.
    if (fileSet.has('package.json')) {
      const manifestRel = relDir === '' ? 'package.json' : `${relDir}/package.json`;
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(absDir, 'package.json'), 'utf8'));
        const label = derivePackageName(pkg, relDir);
        const ws = pkg.workspaces;
        const wsGlobs: string[] =
          Array.isArray(ws) ? ws :
          (ws && Array.isArray(ws.packages) ? ws.packages : []);
        const isRoot = wsGlobs.length > 0;
        hits.push({
          relRoot: relDir,
          manifestPath: manifestRel,
          label,
          kind: isRoot ? 'workspace-root' : 'package',
          ecosystem: 'npm',
          source: 'manifest',
        });
        if (isRoot) pushGlobDecl(decls, relDir, wsGlobs, 'npm');
        claimed = true;
      } catch { /* */ }
    }
    // pnpm-workspace.yaml — declares member globs (no JSON package.json:workspaces).
    if (fileSet.has('pnpm-workspace.yaml')) {
      try {
        const text = fs.readFileSync(path.join(absDir, 'pnpm-workspace.yaml'), 'utf8');
        pushGlobDecl(decls, relDir, parsePnpmWorkspacePackages(text), 'npm');
      } catch { /* */ }
    }
    // pyproject.toml
    if (fileSet.has('pyproject.toml')) {
      const manifestRel = relDir === '' ? 'pyproject.toml' : `${relDir}/pyproject.toml`;
      hits.push({
        relRoot: relDir,
        manifestPath: manifestRel,
        label: derivePyProjectLabel(absDir, relDir),
        kind: 'package',
        ecosystem: 'pypi',
        source: 'manifest',
      });
      claimed = true;
    }
    // Cargo.toml — may carry [package] and/or a [workspace] members list.
    if (fileSet.has('Cargo.toml')) {
      const manifestRel = relDir === '' ? 'Cargo.toml' : `${relDir}/Cargo.toml`;
      let cargoText = '';
      try { cargoText = fs.readFileSync(path.join(absDir, 'Cargo.toml'), 'utf8'); }
      catch { /* */ }
      hits.push({
        relRoot: relDir,
        manifestPath: manifestRel,
        label: deriveCargoLabel(cargoText, relDir),
        kind: 'package',
        ecosystem: 'cargo',
        source: 'manifest',
      });
      const members = parseCargoWorkspaceMembers(cargoText);
      if (members.includes.length) {
        decls.push({ baseRel: relDir, includes: members.includes, excludes: members.excludes, ecosystem: 'cargo' });
      }
      claimed = true;
    }
    // go.mod
    if (fileSet.has('go.mod')) {
      const manifestRel = relDir === '' ? 'go.mod' : `${relDir}/go.mod`;
      hits.push({
        relRoot: relDir,
        manifestPath: manifestRel,
        label: deriveGoModuleLabel(absDir, relDir),
        kind: 'package',
        ecosystem: 'go',
        source: 'manifest',
      });
      claimed = true;
    }
    // go.work — declares member modules via `use` directives.
    if (fileSet.has('go.work')) {
      try {
        const text = fs.readFileSync(path.join(absDir, 'go.work'), 'utf8');
        pushGlobDecl(decls, relDir, parseGoWorkUses(text), 'go');
      } catch { /* */ }
    }
    // composer.json
    if (fileSet.has('composer.json')) {
      const manifestRel = relDir === '' ? 'composer.json' : `${relDir}/composer.json`;
      hits.push({
        relRoot: relDir,
        manifestPath: manifestRel,
        label: path.basename(relDir || '.'),
        kind: 'package',
        ecosystem: 'composer',
        source: 'manifest',
      });
      claimed = true;
    }
    void claimed;

    // Recurse into subdirectories. Always recurse if THIS level didn't
    // declare a non-root package — that's how packages/<x> work — but DO
    // recurse anyway through workspace-root or convention dirs.
    for (const entry of entries) {
      if (BOUNDARY_SKIP_DIRS.has(entry)) continue;
      const abs = path.join(absDir, entry);
      let st: fs.Stats;
      try { st = fs.statSync(abs); }
      catch { continue; }
      if (!st.isDirectory()) continue;
      const sub = relDir === '' ? entry : `${relDir}/${entry}`;
      walk(abs, sub, depth + 1);
    }
  }

  walk(absRoot, '', 0);
  return { hits, decls };
}

/** Split a raw glob list into include/exclude (`!`-prefixed) patterns and
 *  record a declaration. Empty include lists are dropped. */
function pushGlobDecl(decls: WorkspaceGlobDecl[], baseRel: string, globs: string[], ecosystem: string): void {
  const includes: string[] = [];
  const excludes: string[] = [];
  for (const g of globs) {
    if (typeof g !== 'string') continue;
    const t = g.trim();
    if (t === '') continue;
    if (t.startsWith('!')) excludes.push(t.slice(1).trim());
    else includes.push(t);
  }
  if (includes.length) decls.push({ baseRel, includes, excludes, ecosystem });
}

/**
 * Expand workspace-declared member globs (e.g. `components/*`) into concrete
 * boundary roots. This is the fix for declared members that have NO child
 * manifest of their own — without it, repos using non-convention roots like
 * `components/*` lose boundary/preflight/risk grouping. Member dirs that DO
 * carry a manifest were already added with higher priority and win on overlap;
 * empty members are pruned later by buildBoundaries.
 */
function expandWorkspaceMembers(absRoot: string, decls: WorkspaceGlobDecl[], hits: ManifestHit[]): void {
  for (const decl of decls) {
    const excluded = new Set<string>();
    for (const ex of decl.excludes) {
      for (const rel of expandGlob(absRoot, decl.baseRel, ex)) excluded.add(rel);
    }
    for (const inc of decl.includes) {
      for (const rel of expandGlob(absRoot, decl.baseRel, inc)) {
        if (rel === '' || rel === '.' || excluded.has(rel)) continue;
        hits.push({
          relRoot: rel,
          manifestPath: '',
          label: path.basename(rel),
          kind: 'package',
          ecosystem: decl.ecosystem,
          source: 'glob',
        });
      }
    }
  }
}

/** Expand a single workspace glob pattern, relative to `baseRel`, into the
 *  set of existing directories (relative to the workspace root) it matches.
 *  Supports literal segments, `*`/`?` within a segment, and `**` across
 *  segments — the subset workspace tooling actually uses. */
function expandGlob(absRoot: string, baseRel: string, pattern: string): string[] {
  let pat = normalizePath(pattern).trim();
  pat = pat.replace(/^\.\//, '').replace(/\/+$/, '');
  if (pat === '' || pat === '.') return [];
  const segs = pat.split('/').filter(s => s.length > 0);
  const out: string[] = [];
  const seen = new Set<string>();
  const isDir = (rel: string): boolean => {
    try { return fs.statSync(path.join(absRoot, rel)).isDirectory(); } catch { return false; }
  };
  const subdirs = (rel: string): string[] => {
    let entries: string[];
    try { entries = fs.readdirSync(path.join(absRoot, rel)); } catch { return []; }
    const dirs: string[] = [];
    for (const e of entries) {
      if (BOUNDARY_SKIP_DIRS.has(e)) continue;
      const child = rel === '' ? e : `${rel}/${e}`;
      try { if (fs.statSync(path.join(absRoot, child)).isDirectory()) dirs.push(e); } catch { /* */ }
    }
    return dirs;
  };
  const emit = (rel: string): void => {
    if (rel === '' || rel === '.' || seen.has(rel)) return;
    seen.add(rel);
    out.push(rel);
  };
  const recurse = (curRel: string, i: number, depth: number): void => {
    if (depth > 12) return; // safety bound on ** explosion
    if (i === segs.length) {
      if (isDir(curRel)) emit(curRel);
      return;
    }
    const seg = segs[i];
    const join = (sub: string): string => (curRel === '' ? sub : `${curRel}/${sub}`);
    if (seg === '**') {
      recurse(curRel, i + 1, depth);                       // ** matches zero segments
      for (const sub of subdirs(curRel)) recurse(join(sub), i, depth + 1); // …or more
      return;
    }
    if (seg.includes('*') || seg.includes('?')) {
      const re = segGlobToRegExp(seg);
      for (const sub of subdirs(curRel)) {
        if (re.test(sub)) recurse(join(sub), i + 1, depth + 1);
      }
      return;
    }
    const child = join(seg);                                // literal segment
    if (isDir(child)) recurse(child, i + 1, depth + 1);
  };
  recurse(normalizePath(baseRel), 0, 0);
  return out;
}

function segGlobToRegExp(seg: string): RegExp {
  let re = '^';
  for (const ch of seg) {
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  re += '$';
  return new RegExp(re);
}

function parsePnpmWorkspacePackages(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let inPackages = false;
  let baseIndent = -1;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    const stripped = line.trim();
    if (stripped === '' || stripped.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (!inPackages) {
      if (/^packages\s*:/.test(stripped)) { inPackages = true; baseIndent = indent; }
      continue;
    }
    // A dedented non-list line begins a new top-level key — list is done.
    if (indent <= baseIndent && !stripped.startsWith('-')) { inPackages = false; continue; }
    const m = /^-\s*(.+)$/.exec(stripped);
    if (!m) continue;
    let val = m[1].trim();
    // Strip surrounding quotes; if unquoted, drop trailing inline comment.
    if (/^['"]/.test(val)) val = val.replace(/^['"]/, '').replace(/['"].*$/, '');
    else val = val.replace(/\s+#.*$/, '').trim();
    if (val) out.push(val);
  }
  return out;
}

function parseGoWorkUses(text: string): string[] {
  const out: string[] = [];
  const blockRe = /use\s*\(([\s\S]*?)\)/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text))) {
    for (const line of m[1].split(/\r?\n/)) {
      const s = line.trim().replace(/\/\/.*$/, '').trim();
      if (s) out.push(s);
    }
  }
  const singleRe = /^[ \t]*use[ \t]+(?!\()(\S+)/gm;
  while ((m = singleRe.exec(text))) out.push(m[1].trim());
  return out;
}

function parseCargoWorkspaceMembers(text: string): { includes: string[]; excludes: string[] } {
  const idx = text.search(/^[ \t]*\[workspace\][ \t]*$/m);
  if (idx < 0) return { includes: [], excludes: [] };
  const lines = text.slice(idx).split(/\r?\n/);
  let section = lines[0] + '\n';
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    // Stop at the next table header that isn't a [workspace.*] subtable.
    if (/^[ \t]*\[/.test(l) && !/^[ \t]*\[workspace[.\]]/.test(l)) break;
    section += l + '\n';
  }
  return {
    includes: extractTomlArray(section, 'members'),
    excludes: extractTomlArray(section, 'exclude'),
  };
}

function extractTomlArray(text: string, key: string): string[] {
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*\\[([\\s\\S]*?)\\]`, 'm');
  const m = re.exec(text);
  if (!m) return [];
  const out: string[] = [];
  const itemRe = /['"]([^'"]+)['"]/g;
  let im: RegExpExecArray | null;
  while ((im = itemRe.exec(m[1]))) out.push(im[1]);
  return out;
}

function seedConventionRoots(absRoot: string, hits: ManifestHit[]): void {
  // For each <conventionDir>/<sub>/ that exists and isn't already a manifest
  // root, register a fallback boundary so services/* / packages/* still get
  // surfaced even without a manifest.
  const conventionDirs: Array<{ dir: string; kind: BoundaryDef['kind'] }> = [
    { dir: 'services', kind: 'service' },
    { dir: 'packages', kind: 'package' },
    { dir: 'apps',     kind: 'app' },
    { dir: 'libs',     kind: 'lib' },
  ];
  const existingRoots = new Set(hits.map(h => h.relRoot));
  for (const c of conventionDirs) {
    const abs = path.join(absRoot, c.dir);
    if (!fs.existsSync(abs)) continue;
    let entries: string[];
    try { entries = fs.readdirSync(abs); }
    catch { continue; }
    for (const e of entries) {
      const subAbs = path.join(abs, e);
      try {
        if (!fs.statSync(subAbs).isDirectory()) continue;
      } catch { continue; }
      const rel = `${c.dir}/${e}`;
      if (existingRoots.has(rel)) continue;
      hits.push({
        relRoot: rel,
        manifestPath: '',
        label: e,
        kind: c.kind,
        ecosystem: null,
        source: 'convention',
      });
    }
  }
}

function derivePackageName(pkg: any, relDir: string): string {
  const name = (pkg && pkg.name && typeof pkg.name === 'string') ? pkg.name : null;
  if (!name) return path.basename(relDir || '.');
  // Strip @scope/
  const m = /^@[^/]+\/(.+)$/.exec(name);
  return m ? m[1] : name;
}

function derivePyProjectLabel(absDir: string, relDir: string): string {
  try {
    const text = fs.readFileSync(path.join(absDir, 'pyproject.toml'), 'utf8');
    const m = /^\s*name\s*=\s*['"]([^'"]+)['"]/m.exec(text);
    if (m) return m[1];
  } catch { /* */ }
  return path.basename(relDir || '.');
}

function deriveCargoLabel(text: string, relDir: string): string {
  // Capture [package].name; skip [workspace] sections.
  const pkgSection = /^\s*\[package\][\s\S]*?(?=^\s*\[)/m.exec(text)?.[0] ?? text;
  const m = /^\s*name\s*=\s*['"]([^'"]+)['"]/m.exec(pkgSection);
  if (m) return m[1];
  return path.basename(relDir || '.');
}

function deriveGoModuleLabel(absDir: string, relDir: string): string {
  try {
    const text = fs.readFileSync(path.join(absDir, 'go.mod'), 'utf8');
    const m = /^\s*module\s+([^\s]+)/m.exec(text);
    if (m) {
      // Take the last path segment.
      return path.basename(m[1]);
    }
  } catch { /* */ }
  return path.basename(relDir || '.');
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}
