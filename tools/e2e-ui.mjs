/**
 * NEON CITY — end-to-end UI check.
 *
 * Boots the real game from index.html in headless Chromium, starts a session, then verifies that
 * the UI task's three modules behave against the *real* world/player/weapon/mission/police data:
 * the HUD radar rasterises the real city, the readouts follow real gameplay state, the fullscreen
 * map draws the real plan and sets a real waypoint, and the menus open and persist settings.
 *
 * Complements tools/probe-ui.js (which unit-tests the modules against a synthetic game).
 *
 * Usage: node tools/e2e-ui.mjs [--headed]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const HEADED = process.argv.includes('--headed');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.md': 'text/markdown',
};

async function loadPlaywright() {
  const norm = (m) => (m && m.chromium ? m : m && m.default) || m;
  try { return norm(await import('playwright')); } catch { /* fall through */ }
  for (const p of ['/opt/node22/lib/node_modules/playwright/index.js',
    '/usr/lib/node_modules/playwright/index.js', '/usr/local/lib/node_modules/playwright/index.js']) {
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
      res.writeHead(200, {
        'content-type': MIME[extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

const fail = [];

(async () => {
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => { fail.push(`pageerror: ${e.message}`); console.log('  page!', e.message); });
  page.on('console', (m) => { if (m.type() === 'error') { fail.push(`console: ${m.text()}`); console.log('  page>', m.text()); } });

  // Headless Chromium only issues BeginFrames while something consumes them, so without this a
  // page runs its scripts but never fires requestAnimationFrame — the game loop would sit at two
  // frames and every HUD readout would look "broken" for reasons that have nothing to do with the
  // UI. A tiny screencast keeps the compositor (and therefore rAF) running for the whole session.
  const cdp = await page.context().newCDPSession(page);
  cdp.on('Page.screencastFrame', (f) => {
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast',
    { format: 'jpeg', quality: 1, maxWidth: 64, maxHeight: 64, everyNthFrame: 1 });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__NEON && window.__NEON.ready === true, null,
    { timeout: 240000 }).catch(() => fail.push('boot timeout'));

  // --- main menu ------------------------------------------------------------------------
  const menuState = await page.evaluate(() => {
    const g = window.__NEON.game;
    const root = document.getElementById('menu-root');
    return {
      isOpen: g.menu.isOpen,
      hidden: root.classList.contains('hidden'),
      screens: Array.from(root.querySelectorAll('.screen.on')).map((s) => s.className),
      buttons: Array.from(root.querySelectorAll('.screen-main .btn')).map((b) => b.textContent),
      hudVisible: g.hud.visible,
    };
  });
  if (!menuState.isOpen) fail.push('menu: main menu is not open after boot');
  if (menuState.hidden) fail.push('menu: #menu-root is hidden while the main menu is open');
  if (!menuState.screens.some((c) => /screen-main/.test(c))) fail.push('menu: main screen not marked .on');
  if (menuState.buttons.length < 5) fail.push(`menu: only ${menuState.buttons.length} main-menu buttons`);
  if (menuState.hudVisible) fail.push('hud: HUD is visible behind the main menu');

  // --- start a session ------------------------------------------------------------------
  await page.evaluate(() => window.__NEON.startGame());
  await page.waitForTimeout(2000);

  // Is the frame loop actually reaching hud.update()?
  const diag = await page.evaluate(() => {
    const g = window.__NEON.game;
    return {
      started: g.started, paused: g.paused, over: g.over,
      mapOpen: g.mapScreen.isOpen,
      gameFrames: g.time.frame,
      loopFrames: window.__NEON.frameCount(),
      fps: Math.round(window.__NEON.fps()),
      hudTime: g.hud._time,
      hudVisible: g.hud.visible,
      hudUpdateOwn: Object.prototype.hasOwnProperty.call(g.hud, 'update'),
      fatal: window.__NEON.fatal,
      errors: (window.__NEON.errors || []).slice(0, 4),
      fatalPanel: document.getElementById('fatal').classList.contains('hidden') ? null
        : document.getElementById('fatal-msg').textContent,
    };
  });
  console.log('diag:', JSON.stringify(diag));
  // SwiftShader renders this city at ~1-2 fps, so only a handful of frames land in two seconds.
  // The meaningful signal is that the loop reaches hud.update() at all.
  if (diag.loopFrames < 2) fail.push(`loop: only ${diag.loopFrames} frames rendered — the rAF loop is not running`);
  if (!(diag.hudTime > 0)) fail.push(`loop: hud.update() never ran (hud._time=${diag.hudTime}, started=${diag.started}, paused=${diag.paused})`);
  if (diag.fatalPanel) fail.push(`boot: the fatal panel is showing — ${diag.fatalPanel}`);

  const hudState = await page.evaluate(() => {
    const g = window.__NEON.game;
    const root = document.getElementById('hud-root');
    const radar = root.querySelector('.hud-radar');
    const ctx = radar.getContext('2d', { willReadFrequently: true });
    const d = ctx.getImageData(0, 0, radar.width, radar.height).data;
    const seen = new Set();
    let painted = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 8) continue;
      painted++;
      if (seen.size < 4096) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    }
    const txt = (sel) => {
      const n = root.querySelector(sel);
      return n ? n.textContent : null;
    };
    return {
      visible: g.hud.visible,
      radar: { w: radar.width, h: radar.height, painted, colours: seen.size },
      hp: txt('[data-r="vhp"]'),
      health: Math.round(g.player.health),
      weaponName: txt('[data-r="wname"]'),
      weaponKey: g.weapons.current,
      mag: txt('[data-r="wmag"]'),
      ammo: g.weapons.ammo[g.weapons.current],
      money: g.player.money,
      digits: root.querySelectorAll('.hud-money .digit').length,
      stars: root.querySelectorAll('.hud-wanted .star').length,
      indexed: !!(g.hud.minimap && g.hud.minimap.index),
      indexedRoads: g.hud.minimap.index ? g.hud.minimap.index.roads.length : 0,
      indexedFills: g.hud.minimap.index ? g.hud.minimap.index.fills.length : 0,
      markers: g.hud.minimap.markers ? g.hud.minimap.markers.length : -1,
    };
  });
  console.log('hud:', JSON.stringify(hudState));
  if (!hudState.visible) fail.push('hud: HUD not shown after startGame()');
  if (hudState.radar.painted < hudState.radar.w * hudState.radar.h * 0.2) {
    fail.push(`hud: radar drew ${hudState.radar.painted} px — the real city plan is not rendering`);
  }
  if (hudState.radar.colours < 5) fail.push(`hud: radar is a flat fill (${hudState.radar.colours} colours)`);
  if (hudState.indexedRoads < 100) fail.push(`hud: radar indexed only ${hudState.indexedRoads} roads from the real city`);
  if (hudState.indexedFills < 50) fail.push(`hud: radar indexed only ${hudState.indexedFills} blocks from the real city`);
  if (hudState.hp !== String(hudState.health)) fail.push(`hud: health readout "${hudState.hp}" != player.health ${hudState.health}`);
  if (String(hudState.digits) !== String(String(hudState.money).length)) {
    fail.push(`hud: ${hudState.digits} money digits for $${hudState.money}`);
  }
  if (hudState.stars !== 5) fail.push(`hud: ${hudState.stars} wanted stars, expected 5`);
  if (hudState.markers < 0) fail.push('hud: mission markers were never refreshed');

  // --- the HUD must follow live gameplay state -------------------------------------------
  const live = await page.evaluate(async () => {
    const g = window.__NEON.game;
    const root = document.getElementById('hud-root');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    g.player.addMoney(2500);
    g.player.damage(35, [1, 0, 0], 'test');
    g.police.addWanted(2, 'test');
    g.weapons.giveWeapon('rifle', 90);
    g.weapons.switchTo('rifle');
    g.notify('E2E 알림', 'mission', 2);
    // The money counter is deliberately animated (damped roll). Give it frames to settle before
    // comparing digits, otherwise a mid-roll value is read as a mismatch.
    const deadline = performance.now() + 45000;
    while (performance.now() < deadline) {
      await new Promise((r) => requestAnimationFrame(r));
      if (Math.round(g.hud._money) === Math.round(g.player.money) && g.hud._time > 0) break;
    }
    await wait(400);
    const arcs = Array.from(root.querySelectorAll('.hitdir'))
      .map((n) => n.style.transform).filter(Boolean);
    return {
      money: g.player.money,
      digits: Array.from(root.querySelectorAll('.hud-money .digit')).map((dgt) => {
        const m = /-?([\d.]+)%/.exec(dgt.querySelector('.strip').style.transform || '-0%');
        return m ? Math.round(Number(m[1]) / 10) : 0;
      }).join(''),
      hp: root.querySelector('[data-r="vhp"]').textContent,
      health: Math.round(g.player.health),
      stars: root.querySelectorAll('.hud-wanted .star.on').length,
      wanted: g.police.wanted,
      weaponName: root.querySelector('[data-r="wname"]').textContent,
      weaponKeyKo: g.weapons.current,
      mag: root.querySelector('[data-r="wmag"]').textContent,
      magReal: g.weapons.ammo.rifle.mag,
      toasts: root.querySelectorAll('.toast').length,
      damageArcs: arcs.length,
      dmgOpacity: root.querySelector('[data-r="dmg"]').style.opacity,
    };
  });
  console.log('live:', JSON.stringify(live));
  {
    // The counter rolls towards the target; under software rendering (~1 fps) it may still be a
    // few frames out, so the check is "it followed the money", not "it settled to the cent".
    const shown = Number(live.digits);
    if (!Number.isFinite(shown)) fail.push(`hud: money counter is unreadable ("${live.digits}")`);
    else if (shown <= 500) fail.push(`hud: money counter never moved off the starting value (${shown})`);
    else if (Math.abs(shown - live.money) > Math.max(5, live.money * 0.05)) {
      fail.push(`hud: money counter shows ${shown}, player has ${live.money}`);
    }
  }
  if (live.hp !== String(live.health)) fail.push(`hud: health readout "${live.hp}" != ${live.health} after damage`);
  if (live.stars !== live.wanted) fail.push(`hud: ${live.stars} stars lit, wanted level is ${live.wanted}`);
  if (live.mag !== String(live.magReal)) fail.push(`hud: magazine shows ${live.mag}, weapon has ${live.magReal}`);
  if (!live.weaponName) fail.push('hud: weapon name is blank');
  if (live.toasts < 1) fail.push('hud: notify() produced no toast');
  if (live.damageArcs < 1) fail.push('hud: flashDamage() spawned no direction arc');
  if (!(parseFloat(live.dmgOpacity) > 0)) fail.push('hud: damage vignette stayed at zero opacity');

  // --- fullscreen map --------------------------------------------------------------------
  const mapState = await page.evaluate(async () => {
    const g = window.__NEON.game;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    g.mapScreen.show();
    await wait(400);
    g.mapScreen.update();
    const c = document.querySelector('#map-root .map-canvas');
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    let painted = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 8) continue;
      painted++;
      if (seen.size < 4096) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    }
    const rect = c.getBoundingClientRect();
    const local = { x: rect.width * 0.5 + 120, y: rect.height * 0.5 - 80 };
    const want = g.mapScreen.screenToWorld(local.x, local.y);
    g.mapScreen._onPointerDown({ pointerId: 9, clientX: rect.left + local.x, clientY: rect.top + local.y, button: 0, preventDefault() {} });
    g.mapScreen._onPointerUp({ pointerId: 9, clientX: rect.left + local.x, clientY: rect.top + local.y, button: 0 });
    const wp = g.waypoint ? { x: g.waypoint.x, z: g.waypoint.z } : null;
    const scaleBefore = g.mapScreen.scale;
    g.mapScreen._zoomBy(1.8);
    g.mapScreen.update();
    const out = {
      isOpen: g.mapScreen.isOpen,
      hidden: document.getElementById('map-root').classList.contains('hidden'),
      inputBlocked: g.input.blocked,
      canvas: { w: c.width, h: c.height, painted, colours: seen.size },
      want, wp,
      scaleBefore, scaleAfter: g.mapScreen.scale,
      cssWidth: Math.round(rect.width), cssHeight: Math.round(rect.height),
    };
    g.mapScreen.hide();
    await wait(200);
    out.closedHidden = document.getElementById('map-root').classList.contains('hidden');
    out.closedBlocked = g.input.blocked;
    return out;
  });
  console.log('map:', JSON.stringify(mapState));
  if (!mapState.isOpen) fail.push('map: show() did not open');
  if (mapState.hidden) fail.push('map: #map-root stayed hidden while open');
  if (mapState.inputBlocked !== true) fail.push('map: gameplay input was not blocked');
  if (mapState.canvas.painted < mapState.canvas.w * mapState.canvas.h * 0.5) {
    fail.push(`map: canvas mostly empty (${mapState.canvas.painted}/${mapState.canvas.w * mapState.canvas.h})`);
  }
  if (mapState.canvas.colours < 8) fail.push(`map: canvas is a flat fill (${mapState.canvas.colours} colours)`);
  if (mapState.cssWidth !== 1440 || mapState.cssHeight !== 900) {
    fail.push(`map: canvas laid out at ${mapState.cssWidth}x${mapState.cssHeight}, expected the 1440x900 viewport`);
  }
  if (!mapState.wp) fail.push('map: clicking did not set a waypoint');
  else if (Math.abs(mapState.wp.x - mapState.want.x) > 1.5 || Math.abs(mapState.wp.z - mapState.want.z) > 1.5) {
    fail.push('map: waypoint does not match the clicked world position');
  }
  if (!(mapState.scaleAfter > mapState.scaleBefore)) fail.push('map: zoom-in did not increase the scale');
  if (!mapState.closedHidden) fail.push('map: #map-root not hidden after hide()');
  if (mapState.closedBlocked !== false) fail.push('map: input stayed blocked after the map closed');

  // --- pause menu + settings persistence --------------------------------------------------
  const pauseState = await page.evaluate(async () => {
    const g = window.__NEON.game;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    g.pause();
    await wait(250);
    const root = document.getElementById('menu-root');
    const openPause = !!root.querySelector('.screen-pause.on');
    g.menu.showSettings('pause');
    await wait(120);
    const openSettings = !!root.querySelector('.screen-settings.on');
    const sliders = root.querySelectorAll('.screen-settings .slider').length;
    const before = g.menu.settings.sfxVolume;
    const s = Array.from(root.querySelectorAll('.slider')).find((n) => n.__ctrl && n.__ctrl.key === 'sfxVolume');
    if (s) s.__ctrl.step(-1);
    const stored = JSON.parse(localStorage.getItem('neoncity.settings') || '{}');
    g.menu._backOut();
    await wait(120);
    const backToPause = !!root.querySelector('.screen-pause.on');
    g.resume();
    await wait(250);
    return {
      openPause, openSettings, sliders, backToPause,
      before, after: g.menu.settings.sfxVolume, stored: stored.sfxVolume,
      resumedHidden: root.classList.contains('hidden'),
      hudBack: g.hud.visible,
      paused: g.paused,
    };
  });
  console.log('menu:', JSON.stringify(pauseState));
  if (!pauseState.openPause) fail.push('menu: pause screen did not open on game.pause()');
  if (!pauseState.openSettings) fail.push('menu: settings screen did not open');
  if (pauseState.sliders < 6) fail.push(`menu: only ${pauseState.sliders} sliders on the settings screen`);
  if (pauseState.after === pauseState.before) fail.push('menu: slider step did not change the setting');
  if (pauseState.stored !== pauseState.after) fail.push('menu: setting was not persisted to localStorage');
  if (!pauseState.backToPause) fail.push('menu: 뒤로 did not return to the pause screen');
  if (!pauseState.resumedHidden) fail.push('menu: menu root not hidden after resume');
  if (!pauseState.hudBack) fail.push('hud: HUD not restored after resume');
  if (pauseState.paused) fail.push('game: still paused after resume');

  // --- the radar must keep animating over real frames ---------------------------------------
  const anim = await page.evaluate(async () => {
    const radar = document.querySelector('#hud-root .hud-radar');
    const ctx = radar.getContext('2d', { willReadFrequently: true });
    const sig = () => {
      const d = ctx.getImageData(0, 0, radar.width, radar.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 997) h = (h * 31 + d[i]) | 0;
      return h;
    };
    const g = window.__NEON.game;
    const a = sig();
    g.player.position[0] += 45;
    g.player.position[2] += 45;
    await new Promise((r) => setTimeout(r, 500));
    return { a, b: sig() };
  });
  if (anim.a === anim.b) fail.push('hud: the radar did not repaint after the player moved');

  await browser.close();
  server.close();

  console.log('\n=== e2e-ui ===');
  if (fail.length) {
    for (const f of fail) console.log('FAIL', f);
    console.log(`\n${fail.length} failure(s)`);
    process.exit(1);
  }
  console.log('all UI end-to-end checks passed');
  process.exit(0);
})().catch((e) => { console.error('harness error:', e); process.exit(2); });
