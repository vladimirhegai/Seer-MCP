import path from 'path';
import fs from 'fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Store } from '../db/store.js';
import { Indexer } from '../indexer/index.js';
import { jitSync } from '../indexer/freshness.js';
import { StrataWatcher } from '../indexer/watcher.js';
import { buildArchitecture } from '../indexer/architecture.js';
import { detectChanges } from '../indexer/detectchanges.js';
import { collectChurn } from '../indexer/churn.js';
import { buildSymbolHistory } from '../indexer/symbolhistory.js';

/**
 * Strata MCP server.
 *
 * Tool surface (Track-B baseline + Track-C/D additions):
 *   - strata_health         freshness + schema state
 *   - strata_stats          counts (files/symbols/edges + role + Track-C totals)
 *   - strata_symbols        symbol search (BM25 / LIKE)
 *   - strata_definition     exact symbol definition lookup
 *   - strata_file_symbols   list symbols in a file
 *   - strata_callers        direct callers, bounded with true total
 *   - strata_callees        direct callees, bounded
 *   - strata_search         combined symbol + file path BM25 search,
 *                           enriched with containing-symbol context
 *   - strata_reindex        explicit reindex
 *
 *   v4 additions:
 *   - strata_routes         list HTTP routes detected in source
 *   - strata_dependencies   list external dependencies from manifests
 *   - strata_config         list config / env reads
 *   - strata_complexity     rank symbols by cyclomatic/cognitive complexity
 *   - strata_behavior       tests that exercise a given symbol
 *   - strata_trace_path     bounded BFS shortest call path A → B
 *   - strata_architecture   one-page codebase snapshot
 *   - strata_detect_changes blast-radius for current diff
 *   - strata_churn          file-level git churn pass (opt-in)
 *   - strata_history        per-symbol git history
 *   - strata_symbol_history (action) build symbol history index
 */

export interface McpServerOptions {
  workspace: string;
  dbPath?: string;
  watch?: boolean;
  jit?: boolean;
}

export class StrataMcpServer {
  private store!: Store;
  private indexer!: Indexer;
  private watcher: StrataWatcher | null = null;
  private mcp: McpServer;
  private startedAt = Date.now();
  private workspace: string;
  private dbPath: string;
  private jitEnabled: boolean;
  private watchEnabled: boolean;
  private jitPromise: Promise<void> | null = null;

  constructor(options: McpServerOptions) {
    this.workspace = path.resolve(options.workspace);
    this.dbPath = options.dbPath ?? path.join(this.workspace, '.strata', 'graph.db');
    this.jitEnabled = options.jit ?? true;
    this.watchEnabled = options.watch ?? true;

    this.mcp = new McpServer({ name: 'strata', version: '0.1.0' });
    this.registerTools();
  }

  async start(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.store = new Store(this.dbPath);
    this.indexer = new Indexer(this.store);

    const stats = this.store.getStats();
    if (stats.files === 0) {
      process.stderr.write(`[strata-mcp] empty index; running initial index...\n`);
      const r = await this.indexer.indexDirectory(this.workspace, { quiet: true });
      process.stderr.write(`[strata-mcp] initial index: ${r.filesIndexed} files, ${r.symbols} symbols, ${r.elapsedMs}ms\n`);
    }

    if (this.watchEnabled) {
      this.watcher = new StrataWatcher(this.workspace, this.store, this.indexer, {
        log: (m) => process.stderr.write(`[watcher] ${m}\n`),
      });
      this.watcher.start();
    }

    const transport = new StdioServerTransport();
    await this.mcp.connect(transport);
    process.stderr.write(`[strata-mcp] ready  workspace=${this.workspace}\n`);
  }

  async stop(): Promise<void> {
    if (this.watcher) await this.watcher.stop();
    try { this.store.close(); } catch { /* */ }
  }

  private async ensureFresh(): Promise<void> {
    if (!this.jitEnabled) return;
    if (this.jitPromise) { await this.jitPromise; return; }
    this.jitPromise = (async () => {
      try { await jitSync(this.store, this.indexer, this.workspace, { maxDirty: 200 }); }
      catch (err) { process.stderr.write(`[strata-mcp] JIT failed: ${err}\n`); }
      finally { this.jitPromise = null; }
    })();
    await this.jitPromise;
  }

  private text(obj: unknown): { content: Array<{ type: 'text'; text: string }> } {
    return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
  }

  private registerTools(): void {
    this.mcp.registerTool('strata_health', {
      description: 'Server health, schema, file/symbol counts, watcher status. Cheap; no JIT.',
      inputSchema: {},
    }, async () => {
      const schema = this.store.schemaInfo();
      const stats = this.store.getStats();
      const watcher = this.watcher ? this.watcher.syncStatus() : null;
      return this.text({
        workspace: this.workspace,
        dbPath: this.dbPath,
        schemaVersion: schema.dbVersion,
        buildSchemaVersion: schema.buildVersion,
        schemaCurrent: schema.current,
        files: stats.files, symbols: stats.symbols, edges: stats.edges,
        resolvedEdges: stats.resolvedEdges,
        roles: stats.roles, languages: stats.languages,
        routes: stats.routes,
        externalDependencies: stats.externalDependencies,
        configKeys: stats.configKeys,
        symbolHistory: stats.symbolHistory,
        watcher, jitEnabled: this.jitEnabled,
        uptimeMs: Date.now() - this.startedAt,
      });
    });

    this.mcp.registerTool('strata_stats', {
      description: 'Index statistics: counts, languages, roles, routes, deps, config keys. Runs JIT.',
      inputSchema: {},
    }, async () => {
      await this.ensureFresh();
      return this.text(this.store.getStats());
    });

    this.mcp.registerTool('strata_symbols', {
      description: 'Search symbols by name (BM25 over name/qualified_name/signature with camelCase/snake_case split). Returns top by PageRank when query omitted.',
      inputSchema: {
        query: z.string().optional(),
        top: z.number().int().positive().max(500).optional(),
        limit: z.number().int().positive().max(500).optional(),
        includeVendor: z.boolean().optional(),
        includeGenerated: z.boolean().optional(),
      },
    }, async ({ query, top, limit, includeVendor, includeGenerated }) => {
      await this.ensureFresh();
      const opts = { includeVendor: includeVendor ?? false, includeGenerated: includeGenerated ?? false };
      let rows;
      let total: number | null = null;
      if (query) {
        rows = this.store.searchSymbolsFts(query, { ...opts, limit: limit ?? 50 });
        total = this.store.countSymbols(query, opts);
      } else {
        rows = this.store.getTopSymbols(top ?? 20, opts);
      }
      return this.text({
        total, returned: rows.length,
        items: rows.map(r => ({
          id: r.id, name: r.name, qualifiedName: r.qualifiedName, kind: r.kind,
          file: r.filePath, lineStart: r.lineStart, lineEnd: r.lineEnd,
          pagerank: r.pagerank, signature: r.signature,
          loc: r.loc, cyclomatic: r.cyclomatic, cognitive: r.cognitive,
        })),
        source: 'tree-sitter',
      });
    });

    this.mcp.registerTool('strata_definition', {
      description: 'Look up an exact symbol by name or qualified name.',
      inputSchema: {
        name: z.string(),
        file: z.string().optional(),
        includeVendor: z.boolean().optional(),
        includeGenerated: z.boolean().optional(),
      },
    }, async ({ name, file, includeVendor, includeGenerated }) => {
      await this.ensureFresh();
      const rows = this.store.getDefinition(name, {
        filePath: file,
        includeVendor: includeVendor ?? false,
        includeGenerated: includeGenerated ?? false,
      });
      return this.text({
        total: rows.length,
        items: rows.map(r => ({
          id: r.id, name: r.name, qualifiedName: r.qualifiedName, kind: r.kind,
          file: r.filePath, lineStart: r.lineStart, lineEnd: r.lineEnd,
          pagerank: r.pagerank, signature: r.signature,
          loc: r.loc, cyclomatic: r.cyclomatic, cognitive: r.cognitive,
        })),
        source: 'tree-sitter',
      });
    });

    this.mcp.registerTool('strata_file_symbols', {
      description: 'List symbols defined in a file (sorted by line).',
      inputSchema: {
        file: z.string(),
        limit: z.number().int().positive().max(2000).optional(),
      },
    }, async ({ file, limit }) => {
      await this.ensureFresh();
      const rows = this.store.listSymbolsInFile(file, limit ?? 200);
      return this.text({
        file, total: rows.length,
        items: rows.map(r => ({
          id: r.id, name: r.name, qualifiedName: r.qualifiedName, kind: r.kind,
          lineStart: r.lineStart, lineEnd: r.lineEnd, pagerank: r.pagerank,
          signature: r.signature, loc: r.loc,
          cyclomatic: r.cyclomatic, cognitive: r.cognitive,
        })),
      });
    });

    this.mcp.registerTool('strata_callers', {
      description: 'Direct callers of a symbol, bounded preview + true total.',
      inputSchema: {
        symbol: z.string(),
        limit: z.number().int().positive().max(500).optional(),
      },
    }, async ({ symbol, limit }) => {
      await this.ensureFresh();
      const total = this.store.countCallers(symbol);
      const items = this.store.findCallers(symbol, limit ?? 40);
      return this.text({
        symbol, total, returned: items.length,
        items: items.map(c => ({
          callerName: c.callerName, callerQualifiedName: c.callerQualifiedName,
          callerKind: c.callerKind, file: c.callerFile, line: c.callerLine,
          edgeKind: c.edgeKind,
        })),
        source: 'tree-sitter',
      });
    });

    this.mcp.registerTool('strata_callees', {
      description: 'Direct callees of a symbol.',
      inputSchema: { symbol: z.string(), limit: z.number().int().positive().max(500).optional() },
    }, async ({ symbol, limit }) => {
      await this.ensureFresh();
      const all = this.store.findCallees(symbol);
      const max = Math.min(all.length, limit ?? 40);
      return this.text({
        symbol, total: all.length, returned: max,
        items: all.slice(0, max).map(c => ({
          calleeName: c.calleeName, calleeKind: c.calleeKind,
          file: c.calleeFile, lineStart: c.calleeLineStart,
          edgeKind: c.edgeKind,
          source: c.calleeFile ? 'tree-sitter' : 'unresolved',
        })),
      });
    });

    // Search: BM25 across symbols + files. Each symbol hit also gets enriched
    // with the containing symbol when the match is non-symbol (e.g. file).
    this.mcp.registerTool('strata_search', {
      description: 'Combined BM25 search across symbol names and file paths. Use this first; follow up with strata_definition / strata_file_symbols.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().positive().max(200).optional(),
        includeVendor: z.boolean().optional(),
        includeGenerated: z.boolean().optional(),
      },
    }, async ({ query, limit, includeVendor, includeGenerated }) => {
      await this.ensureFresh();
      const opts = { includeVendor: includeVendor ?? false, includeGenerated: includeGenerated ?? false };
      const symHits = this.store.searchSymbolsFts(query, { ...opts, limit: limit ?? 30 });
      const symbolTotal = this.store.countSymbols(query, opts);
      const fileHits = this.store.searchFilesFts(query, limit ?? 30)
        .filter(f => (includeVendor || f.role !== 'vendor') && (includeGenerated || f.role !== 'generated'));
      return this.text({
        query,
        symbolHits: {
          total: symbolTotal, returned: symHits.length,
          items: symHits.map(r => ({
            id: r.id, name: r.name, qualifiedName: r.qualifiedName,
            kind: r.kind, file: r.filePath, lineStart: r.lineStart,
            pagerank: r.pagerank,
          })),
        },
        fileHits: {
          total: fileHits.length,
          items: fileHits.map(f => ({ path: f.path, relPath: f.relPath, language: f.language, role: f.role })),
        },
        source: 'tree-sitter',
        note: 'Search-first: call strata_definition or strata_file_symbols on the chosen hit.',
      });
    });

    this.mcp.registerTool('strata_reindex', {
      description: 'Reindex the workspace (incremental). Pass reset=true to wipe.',
      inputSchema: { reset: z.boolean().optional() },
    }, async ({ reset }) => {
      if (reset) {
        this.store.close();
        try { fs.unlinkSync(this.dbPath); } catch { /* */ }
        try { fs.unlinkSync(this.dbPath + '-wal'); } catch { /* */ }
        try { fs.unlinkSync(this.dbPath + '-shm'); } catch { /* */ }
        this.store = new Store(this.dbPath);
        this.indexer = new Indexer(this.store);
        if (this.watcher) {
          await this.watcher.stop();
          this.watcher = new StrataWatcher(this.workspace, this.store, this.indexer, {
            log: (m) => process.stderr.write(`[watcher] ${m}\n`),
          });
          this.watcher.start();
        }
      }
      const r = await this.indexer.indexDirectory(this.workspace, { quiet: true });
      return this.text({
        reset: Boolean(reset),
        filesIndexed: r.filesIndexed,
        filesReusedFromCache: r.filesReusedFromCache,
        symbols: r.symbols, edges: r.edges, resolvedEdges: r.resolvedEdges,
        externalDependencies: r.externalDependencies,
        testEdgesAdded: r.testEdgesAdded,
        routesResolved: r.routesResolved,
        elapsedMs: r.elapsedMs,
        pagerankRecomputed: r.pagerankRecomputed,
      });
    });

    // ── Track-C tools ───────────────────────────────────────────────────────

    this.mcp.registerTool('strata_routes', {
      description: 'List HTTP routes detected in source (Express/Fastify/FastAPI/Flask/Spring).',
      inputSchema: {
        method: z.string().optional(),
        framework: z.string().optional(),
        pathSubstr: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
      },
    }, async ({ method, framework, pathSubstr, limit }) => {
      await this.ensureFresh();
      const rows = this.store.listRoutes({ method, framework, pathSubstr, limit: limit ?? 100 });
      return this.text({
        total: this.store.countRoutes(),
        returned: rows.length,
        items: rows,
        source: 'tree-sitter',
      });
    });

    this.mcp.registerTool('strata_dependencies', {
      description: 'List external dependencies declared in package manifests / lockfiles.',
      inputSchema: {
        ecosystem: z.string().optional(),
        nameSubstr: z.string().optional(),
        limit: z.number().int().positive().max(2000).optional(),
      },
    }, async ({ ecosystem, nameSubstr, limit }) => {
      await this.ensureFresh();
      const rows = this.store.listExternalDeps({ ecosystem, nameSubstr, limit: limit ?? 200 });
      return this.text({
        total: this.store.countExternalDeps(),
        returned: rows.length,
        items: rows,
      });
    });

    this.mcp.registerTool('strata_config', {
      description: 'List static env/config reads detected in source (process.env, os.getenv, System.getenv).',
      inputSchema: {
        key: z.string().optional(),
        source: z.string().optional(),
        limit: z.number().int().positive().max(2000).optional(),
      },
    }, async ({ key, source, limit }) => {
      await this.ensureFresh();
      const rows = this.store.listConfigKeys({ key, source, limit: limit ?? 200 });
      return this.text({
        total: this.store.countConfigKeys(),
        returned: rows.length,
        items: rows,
      });
    });

    this.mcp.registerTool('strata_complexity', {
      description: 'Rank functions/methods by complexity. Useful for risk-aware editing.',
      inputSchema: {
        by: z.enum(['cyclomatic', 'cognitive', 'loc', 'max_nesting']).optional(),
        minValue: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(500).optional(),
        includeVendor: z.boolean().optional(),
        includeGenerated: z.boolean().optional(),
      },
    }, async ({ by, minValue, limit, includeVendor, includeGenerated }) => {
      await this.ensureFresh();
      const col = by ?? 'cyclomatic';
      const min = minValue ?? 1;
      const lim = limit ?? 50;
      const conds: string[] = [`s.${col} >= ?`];
      const args: unknown[] = [min];
      if (!includeVendor)    conds.push('f.is_vendor = 0');
      if (!includeGenerated) conds.push('f.is_generated = 0');
      args.push(lim);
      const sql = `
        SELECT s.id, s.name, s.qualified_name AS qualifiedName, s.kind,
               f.path AS file, s.line_start AS lineStart, s.line_end AS lineEnd,
               s.loc, s.cyclomatic, s.cognitive, s.max_nesting AS maxNesting,
               s.pagerank
        FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE ${conds.join(' AND ')}
        ORDER BY s.${col} DESC, s.pagerank DESC
        LIMIT ?
      `;
      const rows = (this.store as any).rawDb().prepare(sql).all(...args);
      return this.text({
        by: col, minValue: min,
        returned: rows.length,
        items: rows,
      });
    });

    this.mcp.registerTool('strata_behavior', {
      description: 'Tests that exercise a symbol (via synthesized "tests" edges from test files).',
      inputSchema: {
        symbol: z.string(),
        limit: z.number().int().positive().max(200).optional(),
      },
    }, async ({ symbol, limit }) => {
      await this.ensureFresh();
      const lim = limit ?? 50;
      const rows = (this.store as any).rawDb().prepare(`
        SELECT
          s.id           AS callerId,
          s.name         AS callerName,
          s.qualified_name AS callerQualifiedName,
          s.kind         AS callerKind,
          f.path         AS file,
          e.line         AS line
        FROM edges e
        JOIN symbols s ON s.id = e.from_id
        JOIN files f ON f.id = s.file_id
        WHERE e.to_name = ? AND e.kind = 'tests'
        ORDER BY f.path, e.line
        LIMIT ?
      `).all(symbol, lim);
      return this.text({ symbol, total: rows.length, items: rows });
    });

    this.mcp.registerTool('strata_trace_path', {
      description: 'Bounded BFS shortest call path from one symbol to another.',
      inputSchema: {
        from: z.string(),
        to: z.string(),
        maxDepth: z.number().int().positive().max(12).optional(),
      },
    }, async ({ from, to, maxDepth }) => {
      await this.ensureFresh();
      const fromCandidates = this.store.getDefinition(from);
      const toCandidates = this.store.getDefinition(to);
      if (fromCandidates.length === 0) return this.text({ found: false, reason: `no symbol "${from}"` });
      if (toCandidates.length === 0)   return this.text({ found: false, reason: `no symbol "${to}"` });
      // Try the highest-PageRank pair first.
      for (const f of fromCandidates.slice(0, 5)) {
        for (const t of toCandidates.slice(0, 5)) {
          const p = this.store.tracePath(f.id, t.id, maxDepth ?? 6);
          if (p) return this.text({ found: true, depth: p.length - 1, path: p });
        }
      }
      return this.text({ found: false, reason: `no path within depth ${maxDepth ?? 6}` });
    });

    this.mcp.registerTool('strata_architecture', {
      description: 'One-page snapshot of the codebase: languages, modules, top symbols, entry points, hotspots, deps.',
      inputSchema: {},
    }, async () => {
      await this.ensureFresh();
      return this.text(buildArchitecture(this.workspace, this.store));
    });

    this.mcp.registerTool('strata_detect_changes', {
      description: 'Compute blast-radius of an uncommitted (or between-refs) diff. Direct + transitive callers.',
      inputSchema: {
        fromRef: z.string().optional(),
        toRef: z.string().optional(),
        callerDepth: z.number().int().positive().max(6).optional(),
      },
    }, async ({ fromRef, toRef, callerDepth }) => {
      await this.ensureFresh();
      return this.text(detectChanges(this.workspace, this.store, { fromRef, toRef, callerDepth }));
    });

    this.mcp.registerTool('strata_churn', {
      description: 'Run a file-level git churn pass (commit counts, last commit, authors). Idempotent.',
      inputSchema: {},
    }, async () => {
      return this.text(await collectChurn(this.workspace, this.store));
    });

    // ── Track-D tools ───────────────────────────────────────────────────────

    this.mcp.registerTool('strata_history', {
      description: 'Per-symbol git history. Returns commits whose hunks overlap the symbol\'s line range.',
      inputSchema: {
        symbol: z.string(),
        limit: z.number().int().positive().max(200).optional(),
        since: z.number().int().optional().describe('Unix-seconds lower bound on committed_at'),
        file: z.string().optional(),
      },
    }, async ({ symbol, limit, since, file }) => {
      await this.ensureFresh();
      const candidates = this.store.getDefinition(symbol, { filePath: file });
      const items: any[] = [];
      for (const c of candidates.slice(0, 5)) {
        const history = this.store.getSymbolHistory(c.id, { limit: limit ?? 50, since });
        const total = this.store.countSymbolHistory(c.id);
        items.push({
          symbol: { id: c.id, name: c.name, qualifiedName: c.qualifiedName, kind: c.kind, file: c.filePath },
          total,
          returned: history.length,
          commits: history.map(h => ({
            sha: h.commitSha,
            author: h.authorName, email: h.authorEmail,
            committedAt: h.committedAt,
            message: h.message,
            linesAdded: h.linesAdded, linesRemoved: h.linesRemoved,
            prNumber: h.prNumber, prUrl: h.prUrl,
            matchStrategy: h.matchStrategy, confidence: h.confidence,
          })),
        });
      }
      return this.text({
        symbol, returned: items.length, results: items,
        note: 'Honest limits: file renames followed via --follow; symbol renames cut off history at the rename commit. Confidence drops with commit age.',
      });
    });

    this.mcp.registerTool('strata_symbol_history_build', {
      description: 'Build (or refresh) the per-symbol git history index. Opt-in; can take minutes.',
      inputSchema: {
        maxCommitsPerFile: z.number().int().positive().max(2000).optional(),
        force: z.boolean().optional(),
      },
    }, async ({ maxCommitsPerFile, force }) => {
      const r = await buildSymbolHistory(this.workspace, this.store, {
        maxCommitsPerFile: maxCommitsPerFile ?? 200,
        skipIfHeadUnchanged: !force,
      });
      return this.text(r);
    });
  }
}

export async function runMcp(options: McpServerOptions): Promise<void> {
  const server = new StrataMcpServer(options);
  const shutdown = async (): Promise<void> => {
    try { await server.stop(); } catch { /* */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await server.start();
}
