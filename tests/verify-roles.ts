/**
 * Post-scale verification: walk every produced DB and print
 *   - schema_version
 *   - file role breakdown
 *   - top-3 symbols (and whether any are in a vendored path)
 *
 * This catches regressions in classification / project-first ranking
 * that the scale-test invariants don't quite cover.
 */

import path from 'path';
import fs from 'fs';
import { Store } from '../src/db/store';

const NAMES = ['helix', 'client-go', 'react', 'godot', 'linux', 'typescript', 'unreal', 'cbm'];

function vendoredLooking(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/');
  return /(^|\/)(vendor|vendored|thirdparty|third_party|external|node_modules)\//i.test(norm);
}

async function main(): Promise<void> {
  console.log('\nStrata DB Role Verification\n===========================\n');
  for (const name of NAMES) {
    const dbPath = path.join(__dirname, 'outputs', 'dbs', `${name}.db`);
    if (!fs.existsSync(dbPath)) { console.log(`  ${name.padEnd(12)} (no DB)`); continue; }
    const s = Store.openReadOnly(dbPath);
    try {
      const schema = s.schemaInfo();
      const stats = s.getStats();
      const top3 = s.getTopSymbols(3);
      const vendored = top3.filter(t => vendoredLooking(t.filePath));
      const status = vendored.length === 0 ? 'OK' : `WARN ${vendored.length} top-3 vendored`;
      console.log(`  ${name.padEnd(12)}`);
      console.log(`    schema=${schema.dbVersion}/${schema.buildVersion}${schema.current ? ' ✓' : ' ⚠'}`);
      console.log(`    files=${stats.files.toLocaleString()}  symbols=${stats.symbols.toLocaleString()}  edges=${stats.edges.toLocaleString()}`);
      console.log(`    roles: project=${stats.roles?.project} vendor=${stats.roles?.vendor} generated=${stats.roles?.generated} test=${stats.roles?.test}`);
      console.log(`    top3:`);
      for (const t of top3) {
        const rel = t.filePath.replace(/\\/g, '/').split('/').slice(-3).join('/');
        const flag = vendoredLooking(t.filePath) ? ' ← VENDORED' : '';
        console.log(`      ${t.name.padEnd(28)} pagerank=${t.pagerank.toFixed(5)}  ${rel}${flag}`);
      }
      console.log(`    => ${status}\n`);
    } finally {
      s.close();
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
