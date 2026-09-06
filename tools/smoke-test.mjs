/**
 * NEON CITY — headless smoke test.
 *
 * Boots the game in headless Chromium (software WebGL via SwiftShader), drives real input,
 * and fails the process if anything throws, if the frame loop stalls, or if the renderer
 * produces a blank frame.
 *
 * Usage:  node tools/smoke-test.mjs [--headed] [--shots out/dir] [--seconds 8]
 * Requires Playwright (`npm i -D playwright`), or the globally installed copy.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const HEADED = argv.includes('--headed');
const SHOTS = resolve(arg('--shots', join(ROOT, 'tools', '.shots')));
const SECONDS = Number(arg('--seconds', '8'));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.md': 'text/markdown',
};

async function loadPlaywright() {
  const norm = (m) => (m && m.chromium ? m : m && m.default) || m;
  try { return norm(await import('playwright')); } catch { /* fall through */ }
  for (const p of ['/opt/node22/lib/node_modules/playwright/index.js',
    '/usr/lib/node_modules/playwright/index.js',
    '/usr/local/lib/node_modules/playwright/index.js']) {
    if (existsSync(p)) return norm(await import(p));
  }
  throw new Error('Playwright not found. Run: npm i -D playwright');
}

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

const fail = [];
const warn = [];

(async () => {
  mkdirSync(SHOTS, { recursive: true });
  const { chromium } = await loadPlaywright();
  const server = await startServer();
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  console.log('serving', ROOT, '->', url);

  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  page.on('console', (m) => {
    const t = m.type();
    const text = `${t}: ${m.text()}`;
    if (t === 'error') fail.push(text);
    else if (t === 'warning') warn.push(text);
    if (t === 'error' || t === 'warning' || /\[test\]/.test(m.text())) console.log('  page>', text);
  });
  page.on('pageerror', (e) => { fail.push(`pageerror: ${e.message}\n${e.stack || ''}`); console.log('  page!', e.message); });
  page.on('requestfailed', (r) => {
    const f = r.failure();
    fail.push(`requestfailed: ${r.url()} ${f && f.errorText}`);
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // 1) boot
  await page.waitForFunction(() => window.__NEON && window.__NEON.ready === true, null,
    { timeout: 180000 }).catch(async () => {
    const status = await page.evaluate(() => ({
      status: document.getElementById('load-status')?.textContent,
      fatal: document.getElementById('fatal-msg')?.textContent,
      neon: window.__NEON ? Object.keys(window.__NEON) : null,
    }));
    fail.push(`boot timeout: ${JSON.stringify(status)}`);
  });
  await page.screenshot({ path: join(SHOTS, '01-menu.png'), timeout: 240000 });

  const bootInfo = await page.evaluate(() => window.__NEON && window.__NEON.info || null);
  console.log('boot info:', JSON.stringify(bootInfo));

  // 2) start the game (test hook bypasses the click-to-start gesture requirement)
  await page.evaluate(() => window.__NEON.startGame());
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(SHOTS, '02-ingame.png'), timeout: 240000 });

  // 3) drive input: look around + walk
  const canvas = await page.$('#game-canvas');
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('KeyW');
  for (let i = 0; i < 20; i++) {
    await page.evaluate((d) => window.__NEON.injectMouse(d, 0), 14);
    await page.waitForTimeout(70);
  }
  await page.keyboard.up('KeyW');
  await page.screenshot({ path: join(SHOTS, '03-walk-rotate.png'), timeout: 240000 });

  // 4) run the in-page self-test battery
  const selfTest = await page.evaluate(() => window.__NEON.selfTest());
  console.log('selfTest:', JSON.stringify(selfTest, null, 1));
  if (selfTest && selfTest.failures && selfTest.failures.length) {
    for (const f of selfTest.failures) fail.push(`selfTest: ${f}`);
  }

  // 5) let it run, sample fps + verify the frame is not blank/frozen
  const sample = await page.evaluate(async (secs) => {
    const N = window.__NEON;
    const t0 = performance.now();
    const f0 = N.frameCount();
    await new Promise((r) => setTimeout(r, secs * 1000));
    const dt = (performance.now() - t0) / 1000;
    return { fps: (N.frameCount() - f0) / dt, frames: N.frameCount() - f0, stats: N.stats() };
  }, SECONDS);
  console.log('render sample:', JSON.stringify(sample));
  // A software rasteriser needs seconds per frame for a 2.3M-triangle city, so only require that
  // the loop is alive there; on a real GPU expect a proper frame rate.
  const software = /swiftshader|llvmpipe|softwarerasterizer/i.test((bootInfo && bootInfo.renderer) || '');
  const minFrames = software ? 1 : 5;
  if (!sample.frames || sample.frames < minFrames) {
    fail.push(`frame loop stalled (${sample.frames} frames in ${SECONDS}s, ${software ? 'software' : 'hardware'} renderer)`);
  } else if (software) {
    console.log(`  note: software renderer — ${sample.frames} frame(s) in ${SECONDS}s is expected`);
  }

  await page.screenshot({ path: join(SHOTS, '04-later.png'), timeout: 240000 });

  // 6) non-blank frame check
  const pix = await page.evaluate(() => window.__NEON.pixelStats());
  console.log('pixel stats:', JSON.stringify(pix));
  if (pix && pix.unique < 12) fail.push(`frame looks blank (unique colors=${pix.unique})`);

  // 7) vehicle + map + pause paths
  const flows = await page.evaluate(() => window.__NEON.exerciseFlows());
  console.log('flows:', JSON.stringify(flows));
  if (flows && flows.errors && flows.errors.length) for (const e of flows.errors) fail.push(`flow: ${e}`);
  await page.screenshot({ path: join(SHOTS, '05-vehicle.png'), timeout: 240000 });

  await browser.close();
  server.close();

  console.log(`\n=== warnings (${warn.length}) ===`);
  for (const w of warn.slice(0, 25)) console.log(' -', w);
  console.log(`\n=== failures (${fail.length}) ===`);
  for (const f of fail) console.log(' *', f);
  console.log(`\nscreenshots -> ${SHOTS}`);
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('harness error:', e); process.exit(2); });
