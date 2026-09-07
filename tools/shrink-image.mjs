/**
 * Downscales and re-encodes screenshots using the headless browser's canvas encoder (this
 * container has no PIL/ImageMagick).
 *
 * Usage: node tools/shrink-image.mjs <in.png> <out.jpg> [width] [quality]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const [inPath, outPath, widthArg = '960', qualityArg = '0.82'] = process.argv.slice(2);
if (!inPath || !outPath) { console.error('usage: node tools/shrink-image.mjs <in> <out> [width] [quality]'); process.exit(2); }

async function loadPlaywright() {
  const norm = (m) => (m && m.chromium ? m : m && m.default) || m;
  try { return norm(await import('playwright')); } catch { /* fall through */ }
  for (const p of ['/opt/node22/lib/node_modules/playwright/index.js',
    '/usr/lib/node_modules/playwright/index.js', '/usr/local/lib/node_modules/playwright/index.js']) {
    if (existsSync(p)) return norm(await import(p));
  }
  throw new Error('Playwright not found');
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
const src = `data:image/png;base64,${(await readFile(inPath)).toString('base64')}`;
const out = await page.evaluate(async ({ src, width, quality }) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
  const w = Math.min(width, img.naturalWidth);
  const h = Math.round(img.naturalHeight * (w / img.naturalWidth));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return { data: c.toDataURL('image/jpeg', quality), w, h };
}, { src, width: Number(widthArg), quality: Number(qualityArg) });

const buf = Buffer.from(out.data.split(',')[1], 'base64');
await writeFile(outPath, buf);
console.log(`${inPath} -> ${outPath}  ${out.w}x${out.h}  ${(buf.length / 1024).toFixed(0)} KB`);
await browser.close();
