/**
 * Headless probe for the UI task: js/ui/hud.js + js/ui/menu.js + js/ui/map.js + css/game.css.
 *
 * Builds the DOM contract from index.html, drives the three modules against a fake `game` that
 * matches docs/ARCHITECTURE.md section 16 (and the real shapes the other modules publish), then
 * asserts the things a shipped build must get right: the HUD actually updates, the radar and the
 * map really rasterise the city, the mission banner fires, the damage arc points the right way,
 * nothing is written to the DOM when nothing changed, and nothing allocates per frame.
 *
 * Run: node tools/gl-probe.mjs tools/probe-ui.js
 */
import { HUD } from '/js/ui/hud.js';
import { Menu } from '/js/ui/menu.js';
import { MapScreen } from '/js/ui/map.js';
import { WEAPONS } from '/js/entities/weapons.js';

/* ------------------------------------------------------------------ page scaffolding */

/** Injects css/game.css and resolves once the browser has applied it. @returns {Promise<void>} */
function loadStylesheet() {
  return new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/css/game.css';
    link.onload = () => resolve();
    link.onerror = () => resolve();
    document.head.appendChild(link);
  });
}

/** Builds the #app / .layer shell index.html provides. @returns {object} Root elements. */
function buildShell() {
  document.body.innerHTML = '';
  const app = document.createElement('div');
  app.id = 'app';
  const mk = (id) => {
    const d = document.createElement('div');
    d.id = id;
    d.className = 'layer';
    app.appendChild(d);
    return d;
  };
  const hudRoot = mk('hud-root');
  const mapRoot = mk('map-root');
  mapRoot.classList.add('hidden');
  const menuRoot = mk('menu-root');
  document.body.appendChild(app);
  return { hudRoot, mapRoot, menuRoot };
}

/* ------------------------------------------------------------------ fake world / game */

/**
 * A small but structurally real city plan in the exact shape `worldbuild.buildMinimapData()`
 * returns, so the radar and the map exercise their real code paths.
 * @returns {object} minimapData.
 */
function makeMinimapData() {
  const N = 9;
  const step = 64;
  const half = (N - 1) * step * 0.5;
  const roads = [];
  const blocks = [];
  for (let i = 0; i < N; i++) {
    const v = -half + i * step;
    const avenue = i % 4 === 0;
    roads.push({ x1: -half, z1: v, x2: half, z2: v, w: avenue ? 24 : 12, kind: avenue ? 'avenue' : 'street' });
    roads.push({ x1: v, z1: -half, x2: v, z2: half, w: avenue ? 24 : 12, kind: avenue ? 'avenue' : 'street' });
  }
  for (let i = 0; i < N - 1; i++) {
    for (let j = 0; j < N - 1; j++) {
      const x0 = -half + i * step + 8;
      const z0 = -half + j * step + 8;
      blocks.push({ x0, z0, x: x0 + 24, z: z0 + 24, w: 48, d: 48, c: '#272c38', kind: 'building' });
    }
  }
  const buildings = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    buildings.push({ x: b.x, z: b.z, w: 30, d: 30, rot: i % 3 === 0 ? 0.3 : 0, h: 30, style: 'office' });
  }
  return {
    bounds: { min: [-half - 40, -half - 40], max: [half + 40, half + 40] },
    roads,
    blocks,
    water: [{ x0: half - 60, z0: -half, x: half - 20, z: 0, w: 80, d: half * 2, c: '#0e2436' }],
    parks: [{ x0: -60, z0: -60, x: 0, z: 0, w: 120, d: 120, c: '#1d3a24' }],
    buildings,
    districts: [
      { name: '다운타운', kind: 'downtown', x0: -half, z0: -half, w: half, d: half, x: -half * 0.5, z: -half * 0.5, c: '#2a3040' },
      { name: '해안가', kind: 'beach', x0: 0, z0: 0, w: half, d: half, x: half * 0.5, z: half * 0.5, c: '#4a4330' },
    ],
    landmarks: [{ id: 0, name: '네온 타워', x: 40, z: -40, kind: 'tower' }],
    waterLevel: -1,
  };
}

/** @returns {object} A fake Game matching contract section 16 closely enough for the UI. */
function makeGame() {
  const listeners = new Map();
  const g = {
    canvas: null,
    renderer: { stats: { triangles: 120000, drawCalls: 300 } },
    camera: { yaw: 0, pitch: 0 },
    input: { blocked: false },
    city: null,
    world: { minimapData: makeMinimapData() },
    time: { now: 0, dt: 0, scale: 1, elapsed: 0, frame: 0, hours: 12, daySpeed: 0.1 },
    paused: false,
    started: true,
    over: false,
    player: {
      position: [0, 0, 0],
      velocity: [0, 0, 0],
      yaw: 0,
      pitch: 0,
      health: 100,
      maxHealth: 100,
      armor: 0,
      maxArmor: 100,
      money: 500,
      vehicle: null,
      aiming: false,
      sprinting: false,
      crouching: false,
      dead: false,
      weapon: 'pistol',
    },
    vehicles: [],
    pickups: [],
    police: { wanted: 0, cars: [], cops: [], searchTimer: 0, heatMeterVisible: false },
    weapons: {
      current: 'pistol',
      ammo: { pistol: { mag: 12, reserve: 60 }, rifle: { mag: 30, reserve: 120 }, fist: { mag: 0, reserve: 0 } },
      reloading: false,
      reloadLeft: 0,
      spreadRadians: WEAPONS.pistol.spread,
    },
    missions: {
      active: null,
      markers: [{ missionId: 'm1', name: '배달', x: 90, y: 0, z: 30 }],
      _calls: 0,
      getAvailable() {
        this._calls++;
        return [{ id: 'm1', name: 'Delivery', nameKo: '배달', reward: 500, x: 90, y: 0, z: 30, completed: false, cooldown: 0 }];
      },
    },
    cameraMode: 'thirdPerson',
    waypoint: null,
    sfx: { uiClick() {} },
    hud: null,
    menu: null,
    mapScreen: null,
    hasSave: () => false,
    load: () => false,
    setWaypoint(x, z) { g.waypoint = { x, z }; if (g.hud) g.hud.setWaypoint(x, z); },
    clearWaypoint() { g.waypoint = null; if (g.hud) g.hud.setWaypoint(null, null); },
    on(name, fn) {
      let a = listeners.get(name);
      if (!a) { a = []; listeners.set(name, a); }
      a.push(fn);
      return () => { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
    },
    emit(name, payload) {
      const a = listeners.get(name);
      if (!a) return;
      for (const fn of a.slice()) fn(payload);
    },
    _listeners: listeners,
  };
  return g;
}

/** Counts the non-transparent, non-background pixels of a canvas. @returns {object} Stats. */
function canvasStats(canvas) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  if (!w || !h) return { painted: 0, colours: 0, w, h };
  const d = ctx.getImageData(0, 0, w, h).data;
  const seen = new Set();
  let painted = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) continue;
    painted++;
    if (seen.size < 4096) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
  }
  return { painted, colours: seen.size, w, h };
}

/* ------------------------------------------------------------------ probe */

export default async function run() {
  const out = { errors: [], notes: [], stats: {} };
  const bad = (m) => out.errors.push(m);
  const note = (m) => out.notes.push(m);
  const near = (a, b, tol) => Math.abs(a - b) <= tol;

  await loadStylesheet();
  const dom = buildShell();
  const game = makeGame();

  /* ---------------------------------------------------------------- contract surface */
  const hud = new HUD(game, dom.hudRoot);
  const menu = new Menu(game, dom.menuRoot);
  const map = new MapScreen(game, dom.mapRoot);
  game.hud = hud;
  game.menu = menu;
  game.mapScreen = map;

  const need = (obj, name, members) => {
    for (const m of members) {
      const v = obj[m];
      const ok = typeof v === 'function' || m in obj;
      if (!ok) bad(`${name}.${m} missing (contract section 13)`);
    }
  };
  need(hud, 'HUD', ['show', 'hide', 'update', 'minimap', 'notify', 'subtitle', 'setMissionText',
    'flashDamage', 'showWasted', 'showBusted', 'hideBigMessage', 'setWaypoint']);
  need(menu, 'Menu', ['showMain', 'showPause', 'showSettings', 'showControls', 'hide', 'isOpen',
    'onStart', 'onResume', 'onQuit', 'settings', 'loadSettings', 'saveSettings']);
  need(map, 'MapScreen', ['toggle', 'show', 'hide', 'isOpen', 'update']);

  for (const k of ['quality', 'masterVolume', 'musicVolume', 'sfxVolume', 'sensitivity', 'invertY',
    'fov', 'cameraShake', 'showFps', 'motionBlur', 'language']) {
    if (!(k in menu.settings)) bad(`menu.settings.${k} missing (contract section 13)`);
  }

  /* ---------------------------------------------------------------- CSS contract */
  const cssProbe = (sel, prop) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return getComputedStyle(el)[prop];
  };
  if (cssProbe('#hud-root', 'pointerEvents') !== 'none') bad('css: .layer must not eat pointer events');
  if (cssProbe('#app', 'position') !== 'fixed') bad('css: #app is not laid out (stylesheet did not load?)');

  /* ---------------------------------------------------------------- HUD boot + radar */
  hud.show();
  hud.resize();
  const radar = dom.hudRoot.querySelector('.hud-radar');
  if (!radar) bad('hud: radar canvas was not built');
  if (radar && radar.clientWidth < 100) bad(`hud: radar box is ${radar.clientWidth}px — css/game.css did not size it`);

  const step = 1 / 60;
  for (let i = 0; i < 30; i++) hud.update(step);

  const radarStats = canvasStats(radar);
  out.stats.radar = radarStats;
  if (radarStats.painted < radarStats.w * radarStats.h * 0.2) {
    bad(`hud: radar rendered almost nothing (${radarStats.painted} px of ${radarStats.w * radarStats.h})`);
  }
  if (radarStats.colours < 5) bad(`hud: radar is a flat fill (${radarStats.colours} colours) — city plan not drawn`);

  /* ---------------------------------------------------------------- radar orientation */
  // Player at the origin facing north with a waypoint due east: the dashed line must leave the
  // dial centre towards the right when the radar is north-up.
  hud.minimap.rotate = false;
  game.setWaypoint(60, 0);
  for (let i = 0; i < 3; i++) hud.update(step);
  {
    const ctx = radar.getContext('2d');
    const d = hud.minimap.dpr;
    const S = hud.minimap.size;
    const px = (x, y) => {
      const p = ctx.getImageData(Math.round(x * d), Math.round(y * d), 1, 1).data;
      return { r: p[0], g: p[1], b: p[2] };
    };
    const right = px(S * 0.5 + S * 0.14, S * 0.5);
    const left = px(S * 0.5 - S * 0.14, S * 0.5);
    const magentaish = (c) => c.r > 150 && c.b > 80 && c.g < 120;
    if (!magentaish(right) && !magentaish(px(S * 0.5 + S * 0.1, S * 0.5))) {
      note(`radar waypoint line not sampled on the right (rgb ${right.r},${right.g},${right.b})`);
    }
    if (magentaish(left)) bad('hud: radar waypoint line points the wrong way (mirrored)');
  }
  game.clearWaypoint();
  hud.minimap.rotate = true;

  /* ---------------------------------------------------------------- vitals + money */
  game.player.health = 42;
  game.player.armor = 30;
  game.player.money = 1234;
  for (let i = 0; i < 90; i++) hud.update(step);
  const hpNode = dom.hudRoot.querySelector('[data-r="vhp"]');
  if (hpNode.textContent !== '42') bad(`hud: health readout shows "${hpNode.textContent}", expected 42`);
  const digits = dom.hudRoot.querySelectorAll('.hud-money .digit');
  if (digits.length !== 4) bad(`hud: money counter has ${digits.length} digit columns, expected 4`);
  {
    const shown = [];
    for (const d of digits) {
      const t = d.querySelector('.strip').style.transform || 'translateY(-0%)';
      const m = /-?([\d.]+)%/.exec(t);
      shown.push(m ? Math.round(Number(m[1]) / 10) : 0);
    }
    if (shown.join('') !== '1234') bad(`hud: money digits read ${shown.join('')}, expected 1234`);
  }

  /* ---------------------------------------------------------------- wanted stars */
  game.police.wanted = 3;
  hud.update(step);
  {
    const on = dom.hudRoot.querySelectorAll('.hud-wanted .star.on').length;
    if (on !== 3) bad(`hud: ${on} wanted stars lit, expected 3`);
  }
  game.police.wanted = 0;
  hud.update(step);

  /* ---------------------------------------------------------------- weapon widget */
  game.weapons.current = 'rifle';
  game.player.weapon = 'rifle';
  hud.update(step);
  {
    const name = dom.hudRoot.querySelector('[data-r="wname"]').textContent;
    if (name !== WEAPONS.rifle.nameKo) {
      bad(`hud: weapon label "${name}" does not match WEAPONS.rifle.nameKo "${WEAPONS.rifle.nameKo}"`);
    }
    const mag = dom.hudRoot.querySelector('[data-r="wmag"]').textContent;
    if (mag !== '30') bad(`hud: magazine reads "${mag}", expected 30`);
    const res = dom.hudRoot.querySelector('[data-r="wres"]').textContent;
    if (!/120/.test(res)) bad(`hud: reserve reads "${res}", expected /120`);
  }

  // Low-ammo warning must arm from the real magazine size, not a guess.
  game.weapons.ammo.rifle.mag = 5;
  hud.update(step);
  if (!dom.hudRoot.querySelector('[data-r="lowammo"]').classList.contains('on')) {
    bad('hud: low-ammo warning did not arm at 5/30 rounds');
  }
  game.weapons.ammo.rifle.mag = 30;
  hud.update(step);

  /* ---------------------------------------------------------------- reload arc animates */
  const arc = dom.hudRoot.querySelector('[data-r="reloadarc"]');
  const arcSamples = [];
  game.weapons.reloading = true;
  game.weapons.reloadLeft = WEAPONS.rifle.reloadTime;
  for (let i = 0; i < 40; i++) {
    game.weapons.reloadLeft = Math.max(0, WEAPONS.rifle.reloadTime - i * 0.06);
    hud.update(step);
    arcSamples.push(Number(arc.getAttribute('stroke-dashoffset')));
  }
  game.weapons.reloading = false;
  game.weapons.reloadLeft = 0;
  hud.update(step);
  {
    const uniq = new Set(arcSamples.map((v) => v.toFixed(1)));
    out.stats.reloadArcSteps = uniq.size;
    if (uniq.size < 8) bad(`hud: reload arc only took ${uniq.size} distinct values — it is not animating`);
    if (arcSamples[0] <= arcSamples[arcSamples.length - 1]) {
      bad('hud: reload arc did not fill from empty to full');
    }
  }

  /* ---------------------------------------------------------------- crosshair blooms */
  game.player.aiming = true;
  game.weapons.spreadRadians = WEAPONS.rifle.spread;
  for (let i = 0; i < 60; i++) hud.update(step);
  const crossNode = dom.hudRoot.querySelector('[data-r="cross"]');
  const tight = crossNode.style.getPropertyValue('--sp');
  game.weapons.spreadRadians = WEAPONS.rifle.spread + 0.07;
  for (let i = 0; i < 60; i++) hud.update(step);
  const wide = crossNode.style.getPropertyValue('--sp');
  out.stats.crosshair = { tight, wide };
  if (parseFloat(wide) <= parseFloat(tight) + 4) {
    bad(`hud: crosshair did not bloom with weapon spread (${tight} -> ${wide})`);
  }
  if (!crossNode.classList.contains('on')) bad('hud: crosshair hidden while aiming');
  game.player.aiming = false;
  game.weapons.spreadRadians = WEAPONS.rifle.spread;
  hud.update(step);

  /* ---------------------------------------------------------------- hit marker */
  hud.hitMarker(true);
  {
    const hit = dom.hudRoot.querySelector('[data-r="hit"]');
    if (!hit.classList.contains('on')) bad('hud: hit marker did not show');
    if (!hit.classList.contains('kill')) bad('hud: hitMarker(true) (weapons.js headshot flag) did not use the kill colour');
  }

  /* ---------------------------------------------------------------- damage direction */
  // player.damage() passes a vector pointing FROM the player TOWARDS the attacker.
  const dirCase = (dx, dz, yaw, expectDeg, label) => {
    for (const d of hud._dirs) { d.life = 0; d.t = 0; }
    game.camera.yaw = yaw;
    hud.flashDamage(30, [dx, 0, dz]);
    hud.update(step);
    let deg = null;
    for (const d of hud._dirs) {
      if (d.life <= 0) continue;
      const m = /rotate\(([-\d.]+)deg\)/.exec(d.el.style.transform || '');
      if (m) deg = Number(m[1]);
    }
    if (deg === null) { bad(`hud: no damage arc spawned for ${label}`); return; }
    const norm = ((deg % 360) + 360) % 360;
    const want = ((expectDeg % 360) + 360) % 360;
    const diff = Math.min(Math.abs(norm - want), 360 - Math.abs(norm - want));
    if (diff > 6) bad(`hud: damage arc for ${label} points ${norm.toFixed(1)}deg, expected ${want}deg`);
  };
  dirCase(1, 0, 0, 90, 'attacker due east, camera north');
  dirCase(0, -1, 0, 0, 'attacker straight ahead, camera north');
  dirCase(0, 1, 0, 180, 'attacker behind, camera north');
  dirCase(-1, 0, 0, 270, 'attacker due west, camera north');
  dirCase(-1, 0, Math.PI / 2, 0, 'attacker due west, camera facing west');
  game.camera.yaw = 0;

  /* ---------------------------------------------------------------- police blips */
  // police.js pushes *unit* records ({vehicle, cops, ...}) into `cars`, never bare positions,
  // and plain cop records with a `position` into `cops`.
  {
    const ctx = radar.getContext('2d');
    const d = hud.minimap.dpr;
    const S = hud.minimap.size;
    const blue = () => {
      const img = ctx.getImageData(0, 0, radar.width, radar.height).data;
      let hits = 0;
      for (let i = 0; i < img.length; i += 4) {
        if (img[i + 3] > 8 && img[i + 2] > 180 && img[i + 2] - img[i] > 70) hits++;
      }
      return hits;
    };
    hud.minimap.rotate = false;
    const before = blue();
    game.police.wanted = 2;
    game.police.searching = true;
    game.police.cars.push({ vehicle: { position: [18, 0, 6] }, cops: [] });
    game.police.cops.push({ position: [-14, 0, 10] });
    for (let i = 0; i < 3; i++) hud.update(step);
    const after = blue();
    out.stats.policeBlipPixels = [before, after];
    if (after <= before) bad('hud: police units (the {vehicle,...} records police.js publishes) draw no radar blips');
    if (!dom.hudRoot.querySelector('.hud-wanted').classList.contains('searching')) {
      bad('hud: the searching state from police.searchTimer/searching was not shown');
    }
    void S;
    void d;
    hud.minimap.rotate = true;
  }

  // police.js emits wantedChanged with a plain number.
  {
    const toastsBefore = dom.hudRoot.querySelectorAll('.toast').length;
    game.police.wanted = 4;
    game.emit('wantedChanged', 4);
    const toastsAfter = dom.hudRoot.querySelectorAll('.toast').length;
    if (toastsAfter <= toastsBefore) bad('hud: wantedChanged(number) did not raise a toast');
    hud.update(step);
    if (dom.hudRoot.querySelectorAll('.hud-wanted .star.on').length !== 4) {
      bad('hud: wanted stars did not follow police.wanted = 4');
    }
    game.police.wanted = 0;
    game.police.searching = false;
    game.police.cars.length = 0;
    game.police.cops.length = 0;
    hud.update(step);
    for (let i = 0; i < 260; i++) hud.update(step);
  }

  /* ---------------------------------------------------------------- toasts */
  hud.notify('테스트 알림', 'money', 0.5);
  hud.notify('두 번째', 'warn', 0.5);
  if (dom.hudRoot.querySelectorAll('.toast').length !== 2) bad('hud: toasts were not appended');
  for (let i = 0; i < 90; i++) hud.update(step);
  if (dom.hudRoot.querySelectorAll('.toast').length !== 0) bad('hud: expired toasts were not removed from the DOM');

  /* ---------------------------------------------------------------- mission banner */
  const big = dom.hudRoot.querySelector('[data-r="big"]');
  game.emit('missionEnded', { id: 'm1', result: 'success', note: '배달 완료' });
  if (!big.classList.contains('on') || !big.classList.contains('passed')) {
    bad('hud: missionEnded {result:"success"} (the shape missions.js emits) did not show the pass banner');
  }
  hud.hideBigMessage();
  game.emit('missionEnded', { id: 'm1', result: 'fail', note: '시간 초과' });
  if (!big.classList.contains('on') || !big.classList.contains('failed')) {
    bad('hud: missionEnded {result:"fail"} did not show the fail banner');
  }
  hud.hideBigMessage();
  game.emit('missionEnded', { id: 'm1', success: true, name: 'x' });
  if (!big.classList.contains('passed')) bad('hud: boolean missionEnded payload no longer works');
  hud.hideBigMessage();

  hud.showWasted();
  if (!big.classList.contains('wasted')) bad('hud: showWasted() did not show the banner');
  for (let i = 0; i < 300; i++) hud.update(step);
  if (!big.classList.contains('on')) bad('hud: WASTED banner is sticky and must not auto-hide');
  hud.hideBigMessage();
  hud.showBusted();
  if (!big.classList.contains('busted')) bad('hud: showBusted() did not show the banner');
  hud.hideBigMessage();

  /* ---------------------------------------------------------------- mission panel */
  hud.setMissionText('은행 강도', ['차량 확보', { text: '금고 열기', done: true }]);
  {
    const items = dom.hudRoot.querySelectorAll('.hud-obj .obj');
    if (items.length !== 2) bad(`hud: objective list rendered ${items.length} rows, expected 2`);
    if (!items[1] || !items[1].classList.contains('done')) bad('hud: completed objective not struck through');
    if (dom.hudRoot.querySelector('[data-r="mtitle"]').textContent !== '은행 강도') bad('hud: mission title not written');
  }
  hud.setMissionText(null, null);
  if (dom.hudRoot.querySelector('[data-r="mission"]').classList.contains('on')) {
    bad('hud: mission panel stayed visible after being cleared');
  }

  /* ---------------------------------------------------------------- vehicle panel */
  const fakeVehicle = { position: [0, 0, 0], velocity: [0, 0, 0], yaw: 0, speed: 30, gear: 3, health: 60, maxHealth: 100, isPolice: false };
  game.player.vehicle = fakeVehicle;
  game.vehicles.push(fakeVehicle, { position: [30, 0, 20], velocity: [0, 0, 0], yaw: 1, isPolice: false });
  hud.update(step);
  {
    const veh = dom.hudRoot.querySelector('[data-r="veh"]');
    if (!veh.classList.contains('on')) bad('hud: speedometer hidden while driving');
    const kmh = dom.hudRoot.querySelector('[data-r="kmh"]').textContent;
    if (kmh !== String(Math.round(30 * 3.6))) bad(`hud: speedometer reads ${kmh} km/h, expected ${Math.round(30 * 3.6)}`);
    if (dom.hudRoot.querySelector('[data-r="gear"]').textContent !== '3') bad('hud: gear readout wrong');
  }
  game.player.vehicle = null;
  hud.update(step);

  /* ---------------------------------------------------------------- no DOM churn when idle */
  {
    let writes = 0;
    const obs = new MutationObserver((records) => { writes += records.length; });
    obs.observe(dom.hudRoot, { childList: true, subtree: true, attributes: true, characterData: true });
    for (let i = 0; i < 120; i++) hud.update(step);
    obs.disconnect();
    out.stats.idleDomWrites = writes;
    // Health is 42/100 (>25 %), so the breathing damage vignette is off and a steady frame must
    // not touch the DOM at all.
    if (writes > 4) bad(`hud: ${writes} DOM writes over 120 idle frames — the HUD is rewriting every frame`);
  }

  /* ---------------------------------------------------------------- getAvailable is not per-frame */
  {
    const before = game.missions._calls;
    for (let i = 0; i < 120; i++) hud.update(step);
    const calls = game.missions._calls - before;
    out.stats.getAvailableCallsPer120Frames = calls;
    if (calls > 12) bad(`hud: missions.getAvailable() called ${calls}x in 120 frames (allocates per frame)`);
    if (calls === 0) bad('hud: mission markers are never refreshed');
  }

  /* ---------------------------------------------------------------- hidden HUD does not repaint */
  {
    hud.hide();
    const ctx = radar.getContext('2d');
    ctx.clearRect(0, 0, radar.width, radar.height);
    for (let i = 0; i < 10; i++) hud.update(step);
    const s = canvasStats(radar);
    if (s.painted > 0) bad('hud: the radar keeps repainting while the HUD is hidden');
    hud.show();
    for (let i = 0; i < 3; i++) hud.update(step);
    if (canvasStats(radar).painted === 0) bad('hud: the radar stopped painting after show()');
  }

  /* ---------------------------------------------------------------- map screen */
  map.show();
  if (!map.isOpen) bad('map: show() did not set isOpen');
  if (game.input.blocked !== true) bad('map: gameplay input was not blocked while the map is open');
  const mapCanvas = dom.mapRoot.querySelector('.map-canvas');
  if (!mapCanvas) bad('map: canvas was not built');
  if (mapCanvas && mapCanvas.clientWidth < 200) bad('map: canvas has no layout size (css)');

  // The fit must use the real canvas size, not the 1280x720 placeholder.
  {
    const data = game.world.minimapData;
    const w = data.bounds.max[0] - data.bounds.min[0];
    const fit = Math.min(mapCanvas.clientWidth / w, mapCanvas.clientHeight / (data.bounds.max[1] - data.bounds.min[1]));
    out.stats.mapScale = { scale: map.scale, fit };
    if (!near(map.scale, fit * 2.1, fit * 0.35)) {
      bad(`map: initial zoom ${map.scale.toFixed(3)} does not match the measured canvas fit ${(fit * 2.1).toFixed(3)}`);
    }
  }

  for (let i = 0; i < 4; i++) map.update();
  {
    const s = canvasStats(mapCanvas);
    out.stats.map = s;
    if (s.painted < s.w * s.h * 0.5) bad(`map: canvas is mostly empty (${s.painted}/${s.w * s.h})`);
    if (s.colours < 6) bad(`map: canvas is a flat fill (${s.colours} colours) — the city plan is not drawn`);
  }

  // Pan + zoom must change the rasterised plan.
  {
    const before = canvasStats(mapCanvas).colours;
    map._zoomBy(2.0);
    map.update();
    const after = canvasStats(mapCanvas);
    if (after.painted === 0) bad('map: zooming produced an empty frame');
    if (map.scale <= 0) bad('map: scale went non-positive after zoom');
    out.stats.mapZoomColours = [before, after.colours];
  }

  // Click sets a waypoint; a cancelled gesture must not.
  {
    const rect = mapCanvas.getBoundingClientRect();
    const cx = rect.left + rect.width * 0.5 + 40;
    const cy = rect.top + rect.height * 0.5 - 30;
    game.waypoint = null;
    map._onPointerDown({ pointerId: 1, clientX: cx, clientY: cy, button: 0, preventDefault() {} });
    map._onPointerUp({ pointerId: 1, clientX: cx, clientY: cy, button: 0 });
    if (!game.waypoint) bad('map: click did not set a waypoint');
    else {
      const w = map.screenToWorld(rect.width * 0.5 + 40, rect.height * 0.5 - 30);
      if (!near(game.waypoint.x, w.x, 1) || !near(game.waypoint.z, w.z, 1)) {
        bad('map: waypoint world position does not match the clicked pixel');
      }
    }
    game.waypoint = null;
    map._onPointerDown({ pointerId: 2, clientX: cx, clientY: cy, button: 0, preventDefault() {} });
    map._onPointerUp({ pointerId: 2, clientX: cx, clientY: cy, button: 0 }, true);
    if (game.waypoint) bad('map: a cancelled/leaving pointer placed a waypoint');
  }

  // The blip pulse must be driven by the clock, not by the frame counter: 30 back-to-back
  // frames take ~0 ms of wall time, so the phase must barely move.
  {
    const t0 = performance.now();
    map.update();
    const a = map._pulse;
    for (let i = 0; i < 30; i++) map.update();
    const b = map._pulse;
    const elapsed = (performance.now() - t0) / 1000;
    const advance = Math.abs(b - a);
    out.stats.mapPulse = { a, b, elapsed, advance };
    if (!Number.isFinite(b)) bad('map: pulse became NaN');
    if (advance > Math.max(0.4, elapsed * 8)) {
      bad(`map: blip pulse advanced ${advance.toFixed(2)} rad over ${elapsed.toFixed(3)}s `
        + '— it is frame-rate dependent, not time based');
    }
  }

  map.hide();

  // Reopening into a differently sized box must refit: the fit is measured, never assumed.
  {
    dom.mapRoot.style.left = '0px';
    dom.mapRoot.style.top = '0px';
    dom.mapRoot.style.right = 'auto';
    dom.mapRoot.style.bottom = 'auto';
    dom.mapRoot.style.width = '760px';
    dom.mapRoot.style.height = '420px';
    map.show();
    const c = dom.mapRoot.querySelector('.map-canvas');
    const data = game.world.minimapData;
    const fit = Math.min(c.clientWidth / (data.bounds.max[0] - data.bounds.min[0]),
      c.clientHeight / (data.bounds.max[1] - data.bounds.min[1]));
    out.stats.mapRefit = { w: c.clientWidth, h: c.clientHeight, scale: map.scale, want: fit * 2.1 };
    if (!near(map.scale, fit * 2.1, fit * 0.3)) {
      bad(`map: opening into a ${c.clientWidth}x${c.clientHeight} box fitted the city for the `
        + `stale size (scale ${map.scale.toFixed(3)}, expected ${(fit * 2.1).toFixed(3)})`);
    }
    map.update();
    if (canvasStats(c).painted === 0) bad('map: nothing drawn after reopening at a new size');
    dom.mapRoot.removeAttribute('style');
  }

  map.hide();
  if (map.isOpen) bad('map: hide() did not clear isOpen');
  if (game.input.blocked !== false) bad('map: input stayed blocked after the map closed');

  /* ---------------------------------------------------------------- menu */
  try { localStorage.removeItem('neoncity.settings'); } catch (err) { /* ignore */ }
  menu.showMain();
  if (!menu.isOpen) bad('menu: showMain() did not open');
  if (!dom.menuRoot.querySelector('.screen-main.on')) bad('menu: main screen not marked visible');
  {
    const cont = Array.from(dom.menuRoot.querySelectorAll('.screen-main .btn'))
      .find((b) => b.textContent === '이어하기');
    if (!cont) bad('menu: 이어하기 button missing');
    else if (!cont.classList.contains('disabled')) bad('menu: 이어하기 is enabled with no save data');
  }

  menu.showSettings('main');
  if (!dom.menuRoot.querySelector('.screen-settings.on')) bad('menu: settings screen did not open');

  // Segmented picker: Enter must cycle and wrap.
  {
    const seg = Array.from(dom.menuRoot.querySelectorAll('.seg'))
      .find((s) => s.__ctrl && s.__ctrl.key === 'minimapRotate');
    if (!seg) bad('menu: minimap direction picker missing');
    else {
      const first = menu.settings.minimapRotate;
      seg.__ctrl.activate();
      const second = menu.settings.minimapRotate;
      seg.__ctrl.activate();
      const third = menu.settings.minimapRotate;
      if (second === first) bad('menu: Enter on a segmented picker did nothing');
      if (third !== first) bad('menu: Enter on the last option is a dead key (no wrap-around)');
    }
  }

  // Slider: keyboard step, persistence and live push to the game.
  {
    let pushed = null;
    menu.onSettingsChanged = (s) => { pushed = s; };
    const slider = Array.from(dom.menuRoot.querySelectorAll('.slider'))
      .find((s) => s.__ctrl && s.__ctrl.key === 'fov');
    if (!slider) bad('menu: FOV slider missing');
    else {
      const before = menu.settings.fov;
      slider.__ctrl.step(1);
      if (menu.settings.fov !== before + 1) bad(`menu: FOV step moved ${before} -> ${menu.settings.fov}`);
      if (!pushed) bad('menu: settings change was not pushed to the game');
      const raw = localStorage.getItem('neoncity.settings');
      if (!raw || JSON.parse(raw).fov !== menu.settings.fov) bad('menu: settings were not persisted to localStorage');
      const fresh = menu.loadSettings();
      if (fresh.fov !== menu.settings.fov) bad('menu: loadSettings() did not read the stored value back');
    }
    menu.onSettingsChanged = null;
  }

  // HUD must pick the live settings up through the event bus.
  {
    menu.settings.showFps = true;
    game.emit('settingsChanged', menu.settings);
    hud.update(step);
    hud.update(0.3);
    const dbg = dom.hudRoot.querySelector('[data-r="debug"]');
    if (!dbg.classList.contains('on')) bad('hud: showFps setting was not honoured');
    if (!/FPS/.test(dbg.textContent)) bad(`hud: debug readout is empty ("${dbg.textContent}")`);
    menu.settings.minimapRotate = false;
    game.emit('settingsChanged', menu.settings);
    if (hud.minimap.rotate !== false) bad('hud: minimapRotate setting was not applied to the radar');
    menu.settings.showFps = false;
    menu.settings.minimapRotate = true;
    game.emit('settingsChanged', menu.settings);
  }

  menu.resetSettings();
  if (menu.settings.fov !== 62) bad('menu: resetSettings() did not restore the defaults');

  menu.showPause();
  if (!dom.menuRoot.querySelector('.screen-pause.on')) bad('menu: pause screen did not open');
  menu.showControls('pause');
  menu._backOut();
  if (!dom.menuRoot.querySelector('.screen-pause.on')) bad('menu: 뒤로 from controls did not return to pause');
  menu.hide();
  if (menu.isOpen) bad('menu: hide() left isOpen true');
  if (!dom.menuRoot.classList.contains('hidden')) bad('menu: root not hidden after hide()');

  /* ---------------------------------------------------------------- teardown */
  {
    const before = window.__uiKeyHandled === undefined ? 0 : 1;
    menu.dispose();
    map.dispose();
    hud.dispose();
    if (dom.hudRoot.innerHTML !== '') bad('hud: dispose() left DOM behind');
    if (dom.menuRoot.innerHTML !== '') bad('menu: dispose() left DOM behind');
    if (dom.mapRoot.innerHTML !== '') bad('map: dispose() left DOM behind');
    // The window listeners must be gone: a keydown after dispose must not throw or act.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowDown', bubbles: true }));
    window.dispatchEvent(new Event('resize'));
    void before;
  }

  out.ok = out.errors.length === 0;
  return out;
}
