/**
 * Discovery ignore regression tests.
 *
 * These pin two production-facing guarantees:
 *   - dependency/build folders are skipped at any nesting depth;
 *   - nested .gitignore / .seerignore files are honored relative to their dir.
 *
 * Run: npx tsx tests/discovery-ignore.ts
 */
import path from 'path';
import fs from 'fs';
import os from 'os';
import { discoverFiles } from '../src/indexer/discovery';

let passed = 0;
let failed = 0;

function check(condition: boolean, message: string, extra?: unknown): void {
  if (condition) {
    passed++;
    console.log(`  OK ${message}`);
  } else {
    failed++;
    console.error(`  XX ${message}` + (extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''));
  }
}

function write(root: string, rel: string, content = 'export const value = 1;\n'): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

async function main(): Promise<void> {
  console.log('\nSeer Discovery Ignore Tests\n===========================\n');
  const root = path.join(os.tmpdir(), `seer-discovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  write(root, 'src/app.ts');
  write(root, 'node_modules/pkg/top.ts');
  write(root, 'packages/api/node_modules/pkg/nested.ts');
  write(root, 'packages/api/dist/out.ts');
  write(root, 'packages/api/src/kept.ts');
  write(root, 'packages/api/src/ignored-by-git.ts');
  write(root, 'packages/api/src/ignored-by-seer.ts');
  write(root, 'packages/api/.gitignore', 'src/ignored-by-git.ts\n');
  write(root, 'packages/api/.seerignore', 'src/ignored-by-seer.ts\n');

  const files = (await discoverFiles(root)).map(f => f.relativePath.replace(/\\/g, '/')).sort();

  check(files.includes('src/app.ts'), 'keeps normal project source', files);
  check(files.includes('packages/api/src/kept.ts'), 'keeps nested package source', files);
  check(!files.some(f => f.includes('node_modules/')), 'skips node_modules at every depth', files);
  check(!files.some(f => f.includes('/dist/')), 'skips dist at every depth', files);
  check(!files.includes('packages/api/src/ignored-by-git.ts'), 'honors nested .gitignore', files);
  check(!files.includes('packages/api/src/ignored-by-seer.ts'), 'honors nested .seerignore', files);

  fs.rmSync(root, { recursive: true, force: true });

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Discovery ignore test crashed:', err);
  process.exit(1);
});
