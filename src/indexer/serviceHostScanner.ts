/**
 * v9 Track-H: extract service hostnames from Kubernetes manifests and
 * Docker Compose files.
 *
 * The result is a {hostname -> file_path[]} map: e.g. "payment-service" was
 * declared in `k8s/payment.yaml`. The resolver uses this to boost confidence
 * on HTTP service_calls whose host_hint matches one of these names. It is
 * evidence, not proof. We only emit a `service_host` link when the call's
 * path also matches a route in the workspace.
 *
 * The scanner is intentionally regex-based (no YAML parser dependency) and
 * forgiving: it extracts top-level `name:` values from any document that
 * looks like a `kind: Service` declaration, plus the keys of `services:` in
 * Docker Compose. Unknown YAMLs are skipped silently.
 */

import fs from 'fs';
import path from 'path';
import glob from 'fast-glob';

export interface ServiceHostMap {
  /** lowercase hostname -> list of file paths where it was declared */
  hosts: Map<string, string[]>;
}

const K8S_SERVICE_RE =
  /(?:^|\n)\s*kind\s*:\s*Service[\s\S]*?(?:^|\n)\s*metadata\s*:[\s\S]*?(?:^|\n)\s*name\s*:\s*["']?([A-Za-z0-9_-]+)["']?/g;

/**
 * Scan a workspace for k8s/Docker service hostnames. Returns the empty map
 * when none are found; callers should treat missing entries as "no boost".
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

    K8S_SERVICE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = K8S_SERVICE_RE.exec(src)) !== null) record(m[1], rel);

    const isCompose = /(?:^|[/\\])docker-compose[^/\\]*\.ya?ml$/i.test(rel) ||
                      /(?:^|\n)version\s*:/m.test(src) && /(?:^|\n)services\s*:/m.test(src);
    if (isCompose) {
      for (const service of composeServiceNames(src)) record(service, rel);
    }
  }

  return { hosts };
}

function indentWidth(s: string): number {
  let n = 0;
  for (const ch of s) n += ch === '\t' ? 2 : 1;
  return n;
}

function composeServiceNames(src: string): string[] {
  const out: string[] = [];
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const services = lines[i].match(/^([ \t]*)services\s*:\s*(?:#.*)?$/);
    if (!services) continue;
    const baseIndent = indentWidth(services[1]);
    let serviceIndent: number | null = null;
    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j];
      if (!raw.trim() || /^\s*#/.test(raw)) continue;
      const m = raw.match(/^([ \t]*)([A-Za-z0-9_-]+)\s*:/);
      if (!m) continue;
      const currentIndent = indentWidth(m[1]);
      if (currentIndent <= baseIndent) break;
      if (serviceIndent == null) serviceIndent = currentIndent;
      if (currentIndent === serviceIndent) out.push(m[2]);
    }
  }
  return out;
}
