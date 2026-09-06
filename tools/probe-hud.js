/**
 * Fast HUD probe: boots the game, forces the states each HUD panel reacts to, and reports the
 * on-screen geometry of every panel. Catches panels that are built in the DOM but never actually
 * become visible.
 *
 * Run: node tools/gl-probe.mjs tools/probe-hud.js
 */
import { Game } from '/js/game.js';

function buildDom() {
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/css/game.css';
  document.head.appendChild(css);
  const mk = (id, cls) => {
    let el = document.getElementById(id);
    if (!el) { el = document.createElement('div'); el.id = id; document.body.appendChild(el); }
    if (cls) el.className = cls;
    return el;
  };
  const loading = mk('loading-screen');
  for (const id of ['load-fill', 'load-status', 'load-tip']) {
    const e = document.createElement('div'); e.id = id; loading.appendChild(e);
  }
  const fatal = mk('fatal', 'hidden');
  const fm = document.createElement('p'); fm.id = 'fatal-msg'; fatal.appendChild(fm);
  return {
    hudRoot: mk('hud-root', 'layer'),
    menuRoot: mk('menu-root', 'layer'),
    mapRoot: mk('map-root', 'layer hidden'),
    loading, loadFill: document.getElementById('load-fill'),
    loadStatus: document.getElementById('load-status'), loadTip: document.getElementById('load-tip'),
    fatal, fatalMsg: fm,
  };
}

const geom = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return `${sel}: MISSING`;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const onScreen = r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0
    && r.left < innerWidth && r.top < innerHeight && Number(cs.opacity) > 0.05
    && cs.display !== 'none' && cs.visibility !== 'hidden';
  return `${sel}: ${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)} op=${cs.opacity} ${onScreen ? 'VISIBLE' : 'hidden'}`;
};

export default async function run({ canvas }) {
  const out = { errors: [], notes: [] };
  const bad = (m) => out.errors.push(m);
  const dom = buildDom();
  dom.canvas = canvas;

  const game = new Game(canvas, dom);
  await game.init(() => {});
  game.startNewGame({ skipPointerLock: true });
  dom.loading.style.display = 'none';
  game.menu.hide();
  dom.menuRoot.style.display = 'none';
  game.hud.show();

  // CSS opacity transitions only progress against wall-clock time, so give the browser real time
  // to settle before measuring computed styles.
  const settle = async (n = 12, waitMs = 450) => {
    for (let i = 0; i < n; i++) { game.update(1 / 60); game.hud.update(1 / 60); }
    await new Promise((r) => setTimeout(r, waitMs));
  };

  // --- on foot -----------------------------------------------------------------------------
  await settle();
  // List what the HUD actually built so the checks below target real class names.
  const built = Array.from(dom.hudRoot.querySelectorAll('*'))
    .map((e) => (typeof e.className === 'string' ? e.className.split(' ')[0] : ''))
    .filter((c) => c && c.startsWith('hud-'));
  out.notes.push('HUD panels built: ' + Array.from(new Set(built)).join(', '));
  out.notes.push('ON FOOT: ' + ['.hud-weapon', '.hud-money', '.hud-wanted', '.hud-veh'].map(geom).join(' | '));

  // --- driving ------------------------------------------------------------------------------
  const v = game.spawnVehicle('sedan', game.player.position[0] + 2.5, game.player.position[2], 0, {});
  game.player.enterVehicle(v, 0);
  // game._updateVehicleControl rewrites v.input from the player's keys every frame, so drive with
  // a real key rather than poking the input struct.
  const vx0 = v.position[0];
  const vz0 = v.position[2];
  game.input.injectKey('KeyW', true);
  let peak = 0;
  for (let i = 0; i < 300; i++) { game.update(1 / 60); peak = Math.max(peak, (v.speed || 0) * 3.6); }
  game.input.injectKey('KeyW', false);
  out.notes.push(`drove ${Math.hypot(v.position[0] - vx0, v.position[2] - vz0).toFixed(1)} m in 5 s, peak ${peak.toFixed(1)} km/h`);
  await settle(30);
  const kmh = (v.speed || 0) * 3.6;
  out.notes.push(`DRIVING at ${kmh.toFixed(1)} km/h: ` + ['.hud-veh', '.hud-weapon', '.hud-minimap'].map(geom).join(' | '));
  const vehEl = document.querySelector('.hud-veh');
  if (!vehEl) bad('.hud-veh panel does not exist');
  else {
    const cs = getComputedStyle(vehEl);
    const r = vehEl.getBoundingClientRect();
    if (Number(cs.opacity) < 0.5) bad(`speedometer stays invisible while driving (opacity ${cs.opacity}, class "${vehEl.className}")`);
    if (r.width < 40 || r.height < 40) bad(`speedometer has no size: ${Math.round(r.width)}x${Math.round(r.height)}`);
    if (r.left > innerWidth || r.top > innerHeight || r.right < 0 || r.bottom < 0) bad('speedometer is off-screen');
    const shown = (document.querySelector('[data-r="kmh"]') || {}).textContent;
    out.notes.push(`speedometer reads "${shown}" for ${kmh.toFixed(1)} km/h`);
    if (kmh > 20 && (!shown || Number(shown) < 5)) bad(`speedometer shows "${shown}" while doing ${kmh.toFixed(0)} km/h`);
  }
  game.player.exitVehicle();
  await settle(20);

  // --- wanted / toasts / mission ---------------------------------------------------------------
  game.police.addWanted(3, 'probe');
  game.hud.notify('테스트 알림', 'info', 3);
  game.hud.setMissionText('테스트 미션', '목표를 확인하세요');
  await settle(20);
  out.notes.push('WANTED 3: ' + ['.hud-wanted', '.hud-toasts', '.hud-mission'].map(geom).join(' | '));
  game.police.clearWanted();

  // --- big messages ------------------------------------------------------------------------------
  game.hud.showWasted();
  await settle(6);
  out.notes.push('WASTED: ' + geom('.hud-big'));
  game.hud.hideBigMessage();
  await settle(4);

  // --- map ----------------------------------------------------------------------------------------
  game.mapScreen.show();
  game.mapScreen.update();
  await settle(6);
  out.notes.push('MAP OPEN: ' + geom('#map-root'));
  // Leave a viewpoint the harness can screenshot: `--view map` shows the fullscreen map,
  // anything else shows the HUD over the game.
  window.__shot = async (arg) => {
    const mode = String(arg || '');
    if (mode.includes('menu')) {
      game.menu.showMain();
      dom.menuRoot.style.display = '';
      game.hud.hide();
      await new Promise((r) => setTimeout(r, 700));
      game.render(1 / 60);
      return;
    }
    if (mode.includes('settings')) {
      game.menu.showSettings();
      dom.menuRoot.style.display = '';
      game.hud.hide();
      await new Promise((r) => setTimeout(r, 700));
      game.render(1 / 60);
      return;
    }
    if (mode.includes('map')) {
      game.mapScreen.show();
      for (let i = 0; i < 6; i++) { game.update(1 / 60); game.mapScreen.update(); }
      await new Promise((r) => setTimeout(r, 400));
    } else {
      game.mapScreen.hide();
      for (let i = 0; i < 6; i++) { game.update(1 / 60); game.hud.update(1 / 60); }
    }
    game.render(1 / 60);
  };

  game.mapScreen.hide();
  return out;
}
