/**
 * Runs a browser-side ES module inside headless Chromium (WebGL2 via SwiftShader) against the
 * repo served over http, and prints whatever it returns.
 *
 * Usage: node tools/gl-probe.mjs <module-path-relative-to-repo-root> [--headed]
 * The module must `export default async function(page-context) { ... return jsonSerializable; }`
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const target = process.argv[2];
const HEADED = process.argv.includes('--headed');
if (!target) { console.error('usage: node tools/gl-probe.mjs <module path relative to repo root>'); process.exit(2); }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

async function loadPlaywright() {
  const norm = (m) => (m && m.chromium ? m : m && m.default) || m;
  try { return norm(await import('playwright')); } catch { /* fall through */ }
  for (const p of ['/opt/node22/lib/node_modules/playwright/index.js',
    '/usr/lib/node_modules/playwright/index.js', '/usr/local/lib/node_modules/playwright/index.js']) {
    if (existsSync(p)) return norm(await import(p));
  }
  throw new Error('Playwright not found');
}

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/__probe') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html><meta charset="utf-8"><canvas id="c" width="640" height="360"></canvas>
<script type="module">
  import probe from '/${target.replace(/^\.?\//, '')}';
  window.__run = () => probe({ canvas: document.getElementById('c') });
  window.__loaded = true;
</script>`);
      return;
    }
    if (p.endsWith('/')) p += 'index.html';
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch (e) { res.writeHead(404, { 'content-type': 'text/plain' }).end(String(e.message)); }
});

await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const url = `http://127.0.0.1:${server.address().port}/__probe`;
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  headless: !HEADED,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
    '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--enable-webgl', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => { logs.push(`${m.type()}: ${m.text()}`); console.log(`  page> ${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => { logs.push(`pageerror: ${e.message}`); console.error(`  page! ${e.message}\n${e.stack || ''}`); });

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__loaded === true, null, { timeout: 30000 })
  .catch(() => { throw new Error('probe module failed to load — see page errors above'); });

let result; let error = null;
try { result = await page.evaluate(() => window.__run()); }
catch (e) { error = e.message; }

console.log('\n=== probe result ===');
console.log(JSON.stringify(result ?? null, null, 1));
if (error) console.error('=== probe error ===\n' + error);

await browser.close();
server.close();
process.exit(error ? 1 : 0);
