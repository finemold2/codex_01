/**
 * Parses every ES module in the project and reports real syntax errors.
 *
 * `node --check file.js` is NOT usable here: for files Node treats as ES modules it prints the
 * error but still exits 0, so it silently passes broken code. This compiles each file as a module
 * instead, which fails loudly.
 *
 * Run: node tools/check-syntax.mjs
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import vm from 'node:vm';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIRS = ['js', 'tools'];

async function walk(dir, out = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

const files = [];
for (const d of DIRS) await walk(join(ROOT, d), files);
files.sort();

let failed = 0;
for (const f of files) {
  const src = await readFile(f, 'utf8');
  try {
    // eslint-disable-next-line no-new
    new vm.SourceTextModule(src, { identifier: f });
  } catch (err) {
    if (err.code === 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING' || /experimental-vm-modules/.test(String(err.message))) {
      // vm modules need a flag; fall back to a Function-based parse that still catches syntax errors
      // in the module body (import/export statements are stripped first).
      const stripped = src
        .replace(/^\s*import\s[^;]*;?$/gm, '')
        .replace(/^\s*export\s+default\s+/gm, 'void ')
        .replace(/^\s*export\s+/gm, '');
      try { new Function(stripped); } catch (e2) {
        failed++;
        console.log(`FAIL ${relative(ROOT, f)}: ${e2.message}`);
      }
      continue;
    }
    failed++;
    console.log(`FAIL ${relative(ROOT, f)}: ${err.message}`);
  }
}
console.log(`\n${files.length} files checked, ${failed} with syntax errors`);
process.exit(failed ? 1 : 0);
