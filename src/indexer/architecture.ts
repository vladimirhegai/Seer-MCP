import { Store } from '../db/store.js';

/**
 * Aggregate "what is this codebase?" snapshot. The view an agent should load
 * BEFORE asking detailed questions — languages, packages, entry points,
 * hotspots, deps, top-N symbols.
 *
 * Pure read-side: never mutates the DB. Cheap enough to run on every
 * `seer_architecture` call (a few aggregate queries + some JS shaping).
 */

export interface ArchitectureView {
  workspace: string;
  languages: Array<{ language: string; files: number; symbols: number }>;
  fileRoles: { project: number; vendor: number; generated: number; test: number };
  totals: {
    files: number;
    symbols: number;
    edges: number;
    routes: number;
    externalDependencies: number;
    configKeys: number;
  };
  /** Highest-PageRank symbols across the project (excludes vendor/generated). */
  topSymbols: Array<{ name: string; qualifiedName: string | null; kind: string; file: string; pagerank: number }>;
  /** Most-churned files. Empty if churn pass hasn't run. */
  hotspots: Array<{ file: string; commits: number; lastCommit: number | null; topAuthor: string | null }>;
  /** Probable entry points — top-PageRank symbols whose name matches common entry conventions. */
  entryPoints: Array<{ name: string; qualifiedName: string | null; file: string; kind: string }>;
  /** Aggregate of detected HTTP routes. */
  routes: { total: number; byFramework: Record<string, number> };
  /** Module / package boundaries — top-level directories under the workspace by file count. */
  topModules: Array<{ name: string; files: number; symbols: number }>;
  /** Most-depended-on external dependencies. */
  externalDependencies: Array<{ ecosystem: string; name: string; versionRange: string | null }>;
}

const ENTRY_POINT_NAMES = new Set([
  'main', 'Main', '__main__', 'run', 'start', 'serve', 'app',
  'createServer', 'createApp', 'bootstrap', 'init', 'entry',
]);

export function buildArchitecture(workspace: string, store: Store): ArchitectureView {
  const stats = store.getStats();
  const langMap = new Map<string, { files: number; symbols: number }>();
  for (const [lang, count] of Object.entries(stats.languages)) {
    langMap.set(lang, { files: count, symbols: 0 });
  }
  // Symbol counts per language: one quick query.
  const langSymRows = store.rawDb().prepare(`
    SELECT f.language, COUNT(*) AS c
    FROM symbols s JOIN files f ON f.id = s.file_id
    GROUP BY f.language
  `).all() as Array<{ language: string; c: number }>;
  for (const r of langSymRows) {
    const entry = langMap.get(String(r.language));
    if (entry) entry.symbols = Number(r.c);
  }
  const languages = Array.from(langMap.entries())
    .map(([language, v]) => ({ language, files: v.files, symbols: v.symbols }))
    .sort((a, b) => b.files - a.files);

  const topSymbols = store.getTopSymbols(15).map(s => ({
    name: s.name, qualifiedName: s.qualifiedName, kind: s.kind,
    file: s.filePath, pagerank: s.pagerank,
  }));

  const hotspotRows = store.topChurnedFiles(15);
  const hotspots = hotspotRows.map(h => ({
    file: h.filePath, commits: h.commitCount, lastCommit: h.lastCommitAt,
    topAuthor: h.topAuthor,
  }));

  // Entry-point heuristic: top-PageRank rankable symbols whose name matches
  // a common entry-point convention. We pull more rows than we need and
  // filter so the heuristic adapts naturally to bigger codebases.
  const entryPointCandidates = store.getTopSymbols(200);
  const entryPoints = entryPointCandidates
    .filter(s => ENTRY_POINT_NAMES.has(s.name) || /^(?:_)?main_?$/.test(s.name))
    .slice(0, 10)
    .map(s => ({ name: s.name, qualifiedName: s.qualifiedName, file: s.filePath, kind: s.kind }));

  // Module breakdown: bucket files by their top-level directory under the
  // workspace. Helps an agent see "billing/ is 200 files, auth/ is 80".
  const moduleMap = new Map<string, { files: number; symbols: number }>();
  const allFiles = store.listFiles();
  for (const f of allFiles) {
    const top = topLevelDir(f.relPath);
    if (!top) continue;
    const e = moduleMap.get(top) ?? { files: 0, symbols: 0 };
    e.files++;
    moduleMap.set(top, e);
  }
  const modSymRows = store.rawDb().prepare(`
    SELECT f.rel_path AS rel_path, COUNT(*) AS c
    FROM symbols s JOIN files f ON f.id = s.file_id
    GROUP BY f.id
  `).all() as Array<{ rel_path: string; c: number }>;
  for (const r of modSymRows) {
    const top = topLevelDir(String(r.rel_path));
    if (!top) continue;
    const e = moduleMap.get(top);
    if (e) e.symbols += Number(r.c);
  }
  const topModules = Array.from(moduleMap.entries())
    .map(([name, v]) => ({ name, files: v.files, symbols: v.symbols }))
    .sort((a, b) => b.symbols - a.symbols)
    .slice(0, 12);

  // Routes by framework.
  const routesByFramework: Record<string, number> = {};
  try {
    const rows = store.rawDb().prepare('SELECT framework, COUNT(*) AS c FROM routes GROUP BY framework').all() as Array<{ framework: string; c: number }>;
    for (const r of rows) routesByFramework[String(r.framework)] = Number(r.c);
  } catch { /* */ }

  const externalDependencies = store.listExternalDeps({ limit: 25 }).map(d => ({
    ecosystem: d.ecosystem, name: d.name, versionRange: d.versionRange,
  }));

  return {
    workspace,
    languages,
    fileRoles: stats.roles ?? { project: 0, vendor: 0, generated: 0, test: 0 },
    totals: {
      files: stats.files,
      symbols: stats.symbols,
      edges: stats.edges,
      routes: stats.routes ?? 0,
      externalDependencies: stats.externalDependencies ?? 0,
      configKeys: stats.configKeys ?? 0,
    },
    topSymbols,
    hotspots,
    entryPoints,
    routes: { total: stats.routes ?? 0, byFramework: routesByFramework },
    topModules,
    externalDependencies,
  };
}

function topLevelDir(relPath: string): string | null {
  const norm = relPath.replace(/\\/g, '/');
  const idx = norm.indexOf('/');
  if (idx <= 0) return null;
  return norm.slice(0, idx);
}
