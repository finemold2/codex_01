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
const shotIdx = process.argv.indexOf('--shot');
const SHOT = shotIdx >= 0 && process.argv[shotIdx + 1] ? process.argv[shotIdx + 1] : null;
const viewIdx = process.argv.indexOf('--view');
const VIEW = viewIdx >= 0 && process.argv[viewIdx + 1] ? process.argv[viewIdx + 1] : undefined;
// --stub redirects the not-yet-written entity modules to tools/stubs/* via an import map, so the
// full game boot path can be exercised before those modules land.
const STUB = process.argv.includes('--stub');
const IMPORT_MAP = STUB ? `<script type="importmap">${JSON.stringify({
  imports: {
    '/js/entities/vehicle.js': '/tools/stubs/vehicle.js',
    '/js/entities/ped.js': '/tools/stubs/ai.js',
    '/js/entities/traffic.js': '/tools/stubs/ai.js',
    '/js/entities/police.js': '/tools/stubs/ai.js',
  },
})}</script>` : '';
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
      const html = `<!doctype html><meta charset="utf-8">${IMPORT_MAP}<canvas id="c" width="1280" height="720"></canvas>
<script type="module">
  import probe from '/${target.replace(/^\.?\//, '')}';
  window.__run = () => probe({ canvas: document.getElementById('c') });
  window.__loaded = true;
</script>`;
      if (process.env.PROBE_DUMP) console.error('--- probe html ---\n' + html + '\n---');
      res.end(html);
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
await page.evaluate((v) => { window.__shotArg = v; }, VIEW).catch(() => {});
await page.waitForFunction(() => window.__loaded === true, null, { timeout: 30000 })
  .catch(() => { throw new Error('probe module failed to load — see page errors above'); });

let result; let error = null;
try { result = await page.evaluate(() => window.__run()); }
catch (e) { error = e.message; }

if (SHOT) {
  // The canvas is not preserveDrawingBuffer, so ask the probe to re-render then grab it in the
  // same task via toDataURL, falling back to a page screenshot.
  try {
    const dataUrl = await page.evaluate(async () => {
      if (typeof window.__shot === 'function') await window.__shot(window.__shotArg);
      const c = document.getElementById('c');
      try { return c.toDataURL('image/png'); } catch { return null; }
    });
    if (dataUrl && dataUrl.startsWith('data:image/png;base64,')) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(SHOT, Buffer.from(dataUrl.slice(22), 'base64'));
      console.log('screenshot ->', SHOT);
    } else {
      await page.screenshot({ path: SHOT });
      console.log('page screenshot ->', SHOT);
    }
  } catch (e) { console.error('screenshot failed:', e.message); }
}

console.log('\n=== probe result ===');
console.log(JSON.stringify(result ?? null, null, 1));
if (error) console.error('=== probe error ===\n' + error);

await browser.close();
server.close();
process.exit(error ? 1 : 0);
