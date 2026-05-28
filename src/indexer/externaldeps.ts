import fs from 'fs';
import path from 'path';
import glob from 'fast-glob';
import { Store } from '../db/store.js';

/**
 * Walk the repo for known package manifests and emit one row per declared
 * dependency. Idempotent: clears `external_dependencies` and re-inserts every
 * call, so deletions in package.json are reflected on the next index.
 *
 * Supported ecosystems:
 *   npm    package.json / package-lock.json / pnpm-lock.yaml (deps only)
 *   cargo  Cargo.toml (Cargo.lock not parsed — duplicates would be noisy)
 *   pypi   requirements.txt, pyproject.toml (PEP 621 [project.dependencies])
 *   go     go.mod
 *
 * Manifest discovery uses fast-glob with the same ignores as the rest of the
 * indexer (no node_modules, no vendor) so monorepos can be picked up from
 * `packages/foo/package.json`.
 */
export async function extractExternalDependencies(repoRoot: string, store: Store): Promise<number> {
  const abs = path.resolve(repoRoot);
  const manifestPatterns = [
    'package.json',
    '**/package.json',
    'Cargo.toml',
    '**/Cargo.toml',
    'pyproject.toml',
    '**/pyproject.toml',
    'requirements*.txt',
    '**/requirements*.txt',
    'go.mod',
    '**/go.mod',
  ];
  const ignored = [
    'node_modules/**', '**/node_modules/**',
    'vendor/**', '**/vendor/**', 'vendored/**', '**/vendored/**',
    'third_party/**', '**/third_party/**', 'thirdparty/**', '**/thirdparty/**',
    'target/**', '**/target/**',
    'dist/**', '**/dist/**',
    '.git/**',
  ];
  const matches = await glob(manifestPatterns, {
    cwd: abs, ignore: ignored, onlyFiles: true, followSymbolicLinks: false, dot: false,
    unique: true,
  });

  store.clearExternalDeps();
  let inserted = 0;
  for (const rel of matches) {
    const filePath = path.join(abs, rel);
    let content: string;
    try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
    if (rel.endsWith('package.json') || rel === 'package.json') {
      inserted += parsePackageJson(content, rel, store);
    } else if (rel.endsWith('Cargo.toml') || rel === 'Cargo.toml') {
      inserted += parseCargoToml(content, rel, store);
    } else if (rel.endsWith('pyproject.toml') || rel === 'pyproject.toml') {
      inserted += parsePyproject(content, rel, store);
    } else if (rel.endsWith('.txt')) {
      inserted += parseRequirementsTxt(content, rel, store);
    } else if (rel.endsWith('go.mod') || rel === 'go.mod') {
      inserted += parseGoMod(content, rel, store);
    }
  }
  return inserted;
}

function parsePackageJson(content: string, manifestPath: string, store: Store): number {
  let json: any;
  try { json = JSON.parse(content); } catch { return 0; }
  if (!json || typeof json !== 'object') return 0;
  let count = 0;
  const groups: Array<[Record<string, unknown> | undefined, 0 | 1]> = [
    [json.dependencies, 0],
    [json.devDependencies, 1],
    [json.peerDependencies, 0],
    [json.optionalDependencies, 0],
  ];
  for (const [group, isDev] of groups) {
    if (!group || typeof group !== 'object') continue;
    for (const [name, version] of Object.entries(group)) {
      if (!name) continue;
      store.insertExternalDep('npm', name, typeof version === 'string' ? version : null, manifestPath, isDev);
      count++;
    }
  }
  return count;
}

function parseCargoToml(content: string, manifestPath: string, store: Store): number {
  // Lightweight TOML parser for [dependencies] / [dev-dependencies] sections.
  // We intentionally don't pull in a full TOML lib — Cargo manifests are
  // well-formed enough that a section-aware line walk suffices.
  let count = 0;
  let section = '';
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[(.+?)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    const inDeps = section === 'dependencies' || section === 'dev-dependencies' || section === 'build-dependencies';
    if (!inDeps) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const name = line.slice(0, eq).trim();
    const rest = line.slice(eq + 1).trim();
    if (!name || /[\[{]/.test(name)) continue;
    let version: string | null = null;
    const strMatch = rest.match(/^"([^"]+)"/);
    if (strMatch) version = strMatch[1];
    else {
      const inlineVer = rest.match(/version\s*=\s*"([^"]+)"/);
      if (inlineVer) version = inlineVer[1];
    }
    const isDev: 0 | 1 = section === 'dev-dependencies' ? 1 : 0;
    store.insertExternalDep('cargo', name, version, manifestPath, isDev);
    count++;
  }
  return count;
}

function parsePyproject(content: string, manifestPath: string, store: Store): number {
  // [project] dependencies / optional-dependencies — Poetry uses
  // [tool.poetry.dependencies] in addition. We handle both.
  let count = 0;
  let section = '';
  let inList = false;
  let buf: string[] = [];
  const flushList = (isDev: 0 | 1): void => {
    for (const item of buf) {
      const m = item.match(/^"([^"]+)"|^'([^']+)'/);
      if (!m) continue;
      const spec = (m[1] ?? m[2] ?? '').trim();
      if (!spec) continue;
      // Strip extras / version: "package[extras]>=1.2.3"
      const nameMatch = spec.match(/^([A-Za-z0-9_.\-]+)/);
      if (!nameMatch) continue;
      const name = nameMatch[1];
      const versionMatch = spec.slice(nameMatch[0].length).match(/[<>=~!^].+/);
      const version = versionMatch ? versionMatch[0].trim() : null;
      store.insertExternalDep('pypi', name, version, manifestPath, isDev);
      count++;
    }
    buf = [];
  };
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/#.*$/, '').trim();
    const sectionMatch = line.match(/^\[(.+?)\]$/);
    if (sectionMatch) {
      if (inList) { flushList(section.includes('dev') ? 1 : 0); inList = false; }
      section = sectionMatch[1].trim();
      continue;
    }
    if (section === 'project' || section === 'tool.poetry.dependencies' || section === 'tool.poetry.dev-dependencies') {
      // [project] dependencies = ["pkg>=1.0", ...]
      if (section === 'project' && /^dependencies\s*=\s*\[/.test(line)) {
        inList = true;
        const after = line.replace(/^dependencies\s*=\s*\[/, '');
        if (after.includes(']')) {
          for (const item of after.replace(/\].*$/, '').split(',')) buf.push(item.trim());
          flushList(0);
          inList = false;
        } else {
          buf.push(after);
        }
        continue;
      }
      if (inList) {
        if (line.includes(']')) {
          for (const item of line.replace(/\].*$/, '').split(',')) if (item.trim()) buf.push(item.trim());
          flushList(0);
          inList = false;
        } else {
          for (const item of line.split(',')) if (item.trim()) buf.push(item.trim());
        }
        continue;
      }
      if (section.startsWith('tool.poetry') && /^[A-Za-z0-9_.\-]+\s*=/.test(line)) {
        const eq = line.indexOf('=');
        const name = line.slice(0, eq).trim();
        const rest = line.slice(eq + 1).trim();
        const verMatch = rest.match(/^"([^"]+)"/);
        const version = verMatch ? verMatch[1] : null;
        const isDev: 0 | 1 = section.includes('dev') ? 1 : 0;
        store.insertExternalDep('pypi', name, version, manifestPath, isDev);
        count++;
      }
    }
  }
  if (inList) flushList(section.includes('dev') ? 1 : 0);
  return count;
}

function parseRequirementsTxt(content: string, manifestPath: string, store: Store): number {
  let count = 0;
  const isDev: 0 | 1 = /dev|test/i.test(manifestPath) ? 1 : 0;
  for (const raw of content.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line || line.startsWith('-')) continue;
    const m = line.match(/^([A-Za-z0-9_.\-]+)/);
    if (!m) continue;
    const name = m[1];
    const rest = line.slice(m[0].length);
    const ver = rest.match(/[<>=~!^].+/);
    store.insertExternalDep('pypi', name, ver ? ver[0].trim() : null, manifestPath, isDev);
    count++;
  }
  return count;
}

function parseGoMod(content: string, manifestPath: string, store: Store): number {
  let count = 0;
  let inRequire = false;
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('require (')) { inRequire = true; continue; }
    if (line === ')') { inRequire = false; continue; }
    if (line.startsWith('require ')) {
      // single-line: `require mod v1.2.3`
      const parts = line.slice('require '.length).trim().split(/\s+/);
      if (parts.length >= 2) {
        store.insertExternalDep('go', parts[0], parts[1], manifestPath, 0);
        count++;
      }
      continue;
    }
    if (inRequire) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2 && !/^\/\//.test(parts[0])) {
        store.insertExternalDep('go', parts[0], parts[1], manifestPath, 0);
        count++;
      }
    }
  }
  return count;
}
