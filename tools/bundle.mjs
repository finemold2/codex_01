/**
 * Bundles the game's ES modules into one self-contained HTML file that runs from `file://`,
 * an artifact iframe, or any static host — no module loader, no separate requests.
 *
 * The project has no build step by design; this is an optional distribution helper, not part of
 * how the game normally runs (index.html loads the real modules directly).
 *
 * Each module becomes `__def('<path>', function (__exports, __req) { 'use strict'; ... })`:
 *   import { a, b as c } from './x.js'  ->  const { a, b: c } = __req('js/.../x.js');
 *   import * as NS from './x.js'        ->  const NS = __req('js/.../x.js');
 *   export function foo() {}            ->  function foo() {}   (collected, exported at the end)
 *   export default Foo;                 ->  __exports.default = Foo;
 *
 * Usage: node tools/bundle.mjs [out.html]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const ENTRY = 'js/main.js';
const OUT = resolve(process.argv[2] || join(ROOT, 'neon-city.html'));
/**
 * `--artifact` emits a fragment (title + style + body + script) instead of a full document,
 * because the artifact host supplies its own <!DOCTYPE>/<html>/<head>/<body> wrapper.
 */
const ARTIFACT = process.argv.includes('--artifact');

const IMPORT_RE = /^import\s+(?:(\*\s*as\s+[A-Za-z_$][\w$]*)|(\{[\s\S]*?\}))\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm;

/** @returns {{code:string, deps:string[]}} */
function transform(id, src) {
  const deps = [];
  const dir = dirname(id);
  let code = src.replace(IMPORT_RE, (_m, ns, named, spec) => {
    const dep = normalize(join(dir, spec)).split('\\').join('/');
    deps.push(dep);
    if (ns) {
      const name = ns.replace(/^\*\s*as\s+/, '').trim();
      return `const ${name} = __req(${JSON.stringify(dep)});`;
    }
    // { a, b as c } -> { a, b: c }
    const inner = named.slice(1, -1)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const m = s.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        return m ? `${m[1]}: ${m[2]}` : s;
      })
      .join(', ');
    return `const { ${inner} } = __req(${JSON.stringify(dep)});`;
  });

  const names = new Set();
  let defaultName = null;

  code = code.replace(/^export\s+default\s+([A-Za-z_$][\w$]*)\s*;[ \t]*$/gm, (_m, n) => {
    defaultName = n;
    return '';
  });
  code = code.replace(/^export\s*\{([^}]*)\}\s*;[ \t]*$/gm, (_m, list) => {
    for (const raw of list.split(',')) {
      const s = raw.trim();
      if (!s) continue;
      const m = s.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      names.add(m ? m[2] : s);
    }
    return '';
  });
  code = code.replace(/^export\s+(async\s+function|function|class|const)\s+([A-Za-z_$][\w$]*)/gm,
    (_m, kind, name) => { names.add(name); return `${kind} ${name}`; });

  const stray = code.match(/^export\s+.*$/gm);
  if (stray) throw new Error(`${id}: unhandled export form -> ${stray[0].slice(0, 80)}`);

  const tail = [];
  for (const n of names) tail.push(`  __exports[${JSON.stringify(n)}] = ${n};`);
  if (defaultName) tail.push(`  __exports.default = ${defaultName};`);

  return { code: `${code}\n${tail.join('\n')}\n`, deps };
}

// --- walk the graph ------------------------------------------------------------------------
const modules = new Map();
const order = [];
const visiting = new Set();

async function walk(id) {
  if (modules.has(id)) return;
  if (visiting.has(id)) throw new Error(`circular import involving ${id}`);
  visiting.add(id);
  const src = await readFile(join(ROOT, id), 'utf8');
  const { code, deps } = transform(id, src);
  for (const d of deps) await walk(d);
  visiting.delete(id);
  modules.set(id, code);
  order.push(id);
}
await walk(ENTRY);

// --- assemble -------------------------------------------------------------------------------
const css = await readFile(join(ROOT, 'css/game.css'), 'utf8');
const html = await readFile(join(ROOT, 'index.html'), 'utf8');
const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
let body = bodyMatch ? bodyMatch[1] : '';
// Drop the module/nomodule loaders; the bundle replaces them.
body = body.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<noscript>[\s\S]*?<\/noscript>/gi, '');

const parts = [];
if (!ARTIFACT) {
  parts.push('<!DOCTYPE html>\n<html lang="ko">\n<head>\n<meta charset="UTF-8">');
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">');
}
parts.push('<title>NEON CITY</title>');
parts.push(`<style>\n${css}\n</style>`);
if (!ARTIFACT) parts.push('</head>\n<body>');
parts.push(body.trim());
parts.push('<script>\n(function () {\n  "use strict";\n  var __defs = {}, __cache = {};');
parts.push('  function __def(id, fn) { __defs[id] = fn; }');
parts.push('  function __req(id) {');
parts.push('    if (Object.prototype.hasOwnProperty.call(__cache, id)) return __cache[id];');
parts.push('    var e = (__cache[id] = {});');
parts.push('    var fn = __defs[id];');
parts.push('    if (!fn) throw new Error("module not bundled: " + id);');
parts.push('    fn(e, __req);');
parts.push('    return e;');
parts.push('  }');
for (const id of order) {
  parts.push(`  __def(${JSON.stringify(id)}, function (__exports, __req) {\n"use strict";\n${modules.get(id)}\n  });`);
}
parts.push(`  __req(${JSON.stringify(ENTRY)});`);
parts.push(ARTIFACT ? '})();\n</script>' : '})();\n</script>\n</body>\n</html>');

const outHtml = parts.join('\n');
await writeFile(OUT, outHtml);
console.log(`bundled ${order.length} modules -> ${relative(ROOT, OUT)}  ${(Buffer.byteLength(outHtml) / 1024 / 1024).toFixed(2)} MB`);
console.log('order:', order.slice(0, 4).join(', '), '...', order[order.length - 1]);
