import fs from 'fs';
import path from 'path';
import { Store } from '../db/store.js';
import { Indexer } from '../indexer/index.js';
import { exportBundle, ExportResult } from './export.js';
import type { DiscoveryMode } from '../indexer/discovery.js';

export interface CiBuildOptions {
  /** Repo root to index. Required. */
  repoRoot: string;
  /** Where to write the bundle. Defaults to `<repoRoot>/.seer/index.seerbundle`. */
  out?: string;
  /** Discovery mode for the index pass. CI defaults to `'standard'`. */
  mode?: DiscoveryMode;
  /** Wipe any existing DB before the indexing pass. CI defaults to `true`. */
  reset?: boolean;
  /** Pass through to the indexer's `parallel` toggle. */
  parallel?: boolean;
  /** Optional gitHead/gitBranch overrides (CI runners frequently know them). */
  gitHead?: string;
  gitBranch?: string;
  /** Pin manifest.builtAt for reproducible bundles (defaults to Date.now()). */
  builtAt?: number;
  /** Logger. */
  log?: (msg: string) => void;
}

export interface CiBuildResult {
  /** Result of the indexing pass (file/symbol counts). */
  index: {
    filesIndexed: number;
    symbols: number;
    edges: number;
    elapsedMs: number;
  };
  /** Result of the bundle export. */
  bundle: ExportResult;
  totalElapsedMs: number;
}

/**
 * One-call CI pipeline: fresh-index a repo, export the result as a portable
 * bundle, and report both phases. Exits with a non-zero status if either
 * phase fails — wired up in the CLI command's caller.
 */
export async function buildCiBundle(options: CiBuildOptions): Promise<CiBuildResult> {
  const start = Date.now();
  const log = options.log ?? ((msg: string) => process.stdout.write(`${msg}\n`));
  const repoRoot = path.resolve(options.repoRoot);
  if (!fs.existsSync(repoRoot)) {
    throw new Error(`Repo not found: ${repoRoot}`);
  }
  const dbPath = path.join(repoRoot, '.seer', 'graph.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // CI mode wipes the DB by default — every pipeline run should be a clean
  // snapshot, not an incremental update over whatever junk was on the runner.
  const reset = options.reset ?? true;
  if (reset && fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
    for (const sfx of ['-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + sfx); } catch { /* */ }
    }
  }

  log(`[ci] Indexing ${repoRoot}...`);
  const store = new Store(dbPath);
  const indexer = new Indexer(store);
  let indexResult;
  try {
    indexResult = await indexer.indexDirectory(repoRoot, {
      mode: options.mode ?? 'standard',
      parallel: options.parallel,
      quiet: true,
    });
  } finally {
    store.close();
  }
  log(`[ci] Indexed ${indexResult.filesIndexed} files, ${indexResult.symbols} symbols, ${indexResult.edges} edges in ${indexResult.elapsedMs}ms`);

  log(`[ci] Exporting bundle...`);
  const bundle = await exportBundle(dbPath, repoRoot, {
    out: options.out,
    log: (m) => log(`  ${m}`),
    gitHead: options.gitHead,
    gitBranch: options.gitBranch,
    builtAt: options.builtAt,
  });
  log(`[ci] Wrote ${bundle.bundlePath} (${bundle.bytes.toLocaleString()} bytes) in ${bundle.elapsedMs}ms`);

  return {
    index: {
      filesIndexed: indexResult.filesIndexed,
      symbols: indexResult.symbols,
      edges: indexResult.edges,
      elapsedMs: indexResult.elapsedMs,
    },
    bundle,
    totalElapsedMs: Date.now() - start,
  };
}

/**
 * Emit a ready-to-paste GitHub Actions workflow that runs the CI bundle
 * pipeline on every push to main and uploads the resulting bundle as a
 * build artifact. The workflow is self-contained — no per-repo edits
 * required beyond dropping it at `.github/workflows/seer-bundle.yml`.
 */
export function workflowTemplate(): string {
  return [
    "name: Seer bundle",
    "",
    "on:",
    "  push:",
    "    branches: [main]",
    "  workflow_dispatch:",
    "",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: read",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "        with:",
    "          fetch-depth: 0   # full history so symbol-history pass works",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: '24'",
    "      - name: Build Seer bundle",
    "        run: npx -y seer-mcp ci bundle --workspace ${{ github.workspace }} --out seer-index.seerbundle",
    "      - uses: actions/upload-artifact@v4",
    "        with:",
    "          name: seer-index",
    "          path: seer-index.seerbundle",
    "          if-no-files-found: error",
    "",
  ].join('\n');
}
