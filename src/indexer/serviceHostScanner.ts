/**
 * v9 Track-H — extract service hostnames from Kubernetes manifests and
 * Docker Compose files.
 *
 * The result is a {hostname → file_path[]} map: e.g. "payment-service" was
 * declared in `k8s/payment.yaml`. The resolver uses this to boost confidence
 * on HTTP service_calls whose host_hint matches one of these names — it's
 * evidence, not proof. We only emit a `service_host` link when the call's
 * PATH also matches a route in the workspace (host alone is too noisy).
 *
 * The scanner is intentionally regex-based (no YAML parser dependency) and
 * forgiving — it extracts top-level `name:` values from any document that
 * looks like a `kind: Service` declaration, plus the keys of `services:` in
 * Docker Compose. Unknown YAMLs are skipped silently.
 */

import fs from 'fs';
import path from 'path';
import glob from 'fast-glob';

export interface ServiceHostMap {
  /** lowercase hostname → list of file paths where it was declared */
  hosts: Map<string, string[]>;
}

const K8S_SERVICE_RE =
  /(?:^|\n)\s*kind\s*:\s*Service[\s\S]*?(?:^|\n)\s*metadata\s*:[\s\S]*?(?:^|\n)\s*name\s*:\s*["']?([A-Za-z0-9_-]+)["']?/g;

const COMPOSE_SERVICES_RE =
  /(?:^|\n)services\s*:\s*\n((?:[ \t]+[A-Za-z0-9_-][^\n]*\n?)+)/g;

/**
 * Scan a workspace for k8s/Docker service hostnames. Returns the empty map
 * when none are found — callers should treat missing entries as "no boost".
 */
export async function scanServiceHosts(absRoot: string): Promise<ServiceHostMap> {
  const entries = await glob([
    '**/*.yaml', '**/*.yml',
    '**/docker-compose*.yml', '**/docker-compose*.yaml',
  ], {
    cwd: absRoot,
    ignore: [
      'node_modules/**', '**/node_modules/**',
      '.git/**', '**/.git/**',
      'dist/**', '**/dist/**',
      'build/**', '**/build/**',
      'out/**', '**/out/**',
      'vendor/**', '**/vendor/**', '**/__pycache__/**',
      '.next/**', '**/.next/**',
    ],
    onlyFiles: true, followSymbolicLinks: false, dot: false,
  });
  entries.sort();

  const hosts = new Map<string, string[]>();
  const record = (name: string, filePath: string) => {
    if (!name) return;
    const key = name.toLowerCase();
    const list = hosts.get(key);
    if (list) { if (!list.includes(filePath)) list.push(filePath); }
    else hosts.set(key, [filePath]);
  };

  for (const rel of entries) {
    const abs = path.join(absRoot, rel);
    let src: string;
    try { src = fs.readFileSync(abs, 'utf8'); }
    catch { continue; }

    // ── Kubernetes `kind: Service` ──────────────────────────────────────
    K8S_SERVICE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = K8S_SERVICE_RE.exec(src)) !== null) record(m[1], rel);

    // ── Docker Compose `services:` ─────────────────────────────────────
    const isCompose = /(?:^|[/\\])docker-compose[^/\\]*\.ya?ml$/i.test(rel) ||
                      /(?:^|\n)version\s*:/m.test(src) && /(?:^|\n)services\s*:/m.test(src);
    if (isCompose) {
      COMPOSE_SERVICES_RE.lastIndex = 0;
      let s: RegExpExecArray | null;
      while ((s = COMPOSE_SERVICES_RE.exec(src)) !== null) {
        const block = s[1];
        // Pull top-level service keys: lines like "  name:" with 2-4 space indent.
        const lines = block.split('\n');
        for (const line of lines) {
          const km = line.match(/^([ \t]+)([A-Za-z0-9_-]+)\s*:/);
          if (!km) continue;
          // Only first-level keys (consistent indent across the services block).
          // We accept indent ≤ 4 spaces / 1 tab.
          if (km[1].length <= 4) record(km[2], rel);
        }
      }
    }
  }

  return { hosts };
}
