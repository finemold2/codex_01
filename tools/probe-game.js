/**
 * End-to-end integration probe: boots the real js/game.js Game class in a browser, runs the
 * loading pipeline, starts a game, drives input, and runs the in-game self-test battery.
 *
 * Run with the entity stubs while those modules are still being written:
 *   node tools/gl-probe.mjs tools/probe-game.js --stub
 * Once every module exists, drop --stub to test the real thing.
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
  const fill = document.createElement('div'); fill.id = 'load-fill'; loading.appendChild(fill);
  const status = document.createElement('p'); status.id = 'load-status'; loading.appendChild(status);
  const tip = document.createElement('p'); tip.id = 'load-tip'; loading.appendChild(tip);
  const fatal = mk('fatal', 'hidden');
  const fatalMsg = document.createElement('p'); fatalMsg.id = 'fatal-msg'; fatal.appendChild(fatalMsg);
  return {
    canvas: document.getElementById('c'),
    hudRoot: mk('hud-root', 'layer'),
    menuRoot: mk('menu-root', 'layer'),
    mapRoot: mk('map-root', 'layer hidden'),
    loading, loadFill: fill, loadStatus: status, loadTip: tip, fatal, fatalMsg,
  };
}

export default async function run({ canvas }) {
  const out = { errors: [], notes: [], progress: [] };
  const bad = (m) => out.errors.push(m);
  const consoleErrors = [];
  const origError = console.error;
  console.error = (...a) => { consoleErrors.push(a.map(String).join(' ')); origError.apply(console, a); };
  window.addEventListener('error', (e) => bad(`window error: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => bad(`unhandled rejection: ${e.reason && e.reason.message}`));

  const dom = buildDom();
  dom.canvas = canvas;

  let game;
  const t0 = performance.now();
  try {
    game = new Game(canvas, dom);
  } catch (e) { bad(`Game constructor threw: ${e.message}\n${e.stack || ''}`); return out; }

  try {
    await game.init((p, label) => { out.progress.push(`${(p * 100) | 0}% ${label}`); });
  } catch (e) { bad(`game.init threw: ${e.message}\n${e.stack || ''}`); return out; }
  out.notes.push(`init: ${(performance.now() - t0).toFixed(0)} ms`);
  out.notes.push(`buildInfo: ${JSON.stringify(game.buildInfo())}`);

  // --- menus ------------------------------------------------------------------------------
  try { game.menu.showMain(); } catch (e) { bad(`menu.showMain threw: ${e.message}`); }

  // --- start ------------------------------------------------------------------------------
  try { game.startNewGame({ skipPointerLock: true }); }
  catch (e) { bad(`startNewGame threw: ${e.message}\n${e.stack || ''}`); return out; }

  const light = String(window.__shotArg || '').includes('light');

  // --- run frames --------------------------------------------------------------------------
  let frames = 0;
  const t1 = performance.now();
  try {
    const N = light ? 6 : 40;
    for (let i = 0; i < N; i++) { game.update(1 / 60); game.render(1 / 60); frames++; }
  } catch (e) { bad(`frame ${frames} threw: ${e.message}\n${e.stack || ''}`); }
  out.notes.push(`${frames} frames in ${(performance.now() - t1).toFixed(0)} ms (software rasteriser)`);
  out.notes.push(`stats: ${JSON.stringify(game.debugStats())}`);

  // --- camera + movement --------------------------------------------------------------------
  const p0 = [game.player.position[0], game.player.position[2]];
  const yaw0 = game.camera.yaw;
  try {
    game.input.injectKey('KeyW', true);
    for (let i = 0; i < 60; i++) { game.input.injectMouseDelta(6, 0); game.update(1 / 60); }
    game.input.injectKey('KeyW', false);
    for (let i = 0; i < 10; i++) game.update(1 / 60);
  } catch (e) { bad(`input drive threw: ${e.message}\n${e.stack || ''}`); }
  const moved = Math.hypot(game.player.position[0] - p0[0], game.player.position[2] - p0[1]);
  const turned = Math.abs(game.camera.yaw - yaw0);
  out.notes.push(`walked ${moved.toFixed(2)} m, camera turned ${turned.toFixed(2)} rad`);
  if (moved < 0.5) bad(`player barely moved on W (${moved.toFixed(2)} m)`);
  if (turned < 0.1) bad(`camera barely rotated on mouse input (${turned.toFixed(3)} rad)`);
  const camDist = Math.hypot(
    game.camera.position[0] - game.player.position[0],
    game.camera.position[1] - game.player.position[1],
    game.camera.position[2] - game.player.position[2]);
  out.notes.push(`camera boom length: ${camDist.toFixed(2)} m`);
  if (!(camDist > 0.6 && camDist < 12)) bad(`camera boom is out of range: ${camDist.toFixed(2)} m`);
  if (!game.player.position.every(Number.isFinite)) bad('player position went NaN');
  if (!game.camera.position.every(Number.isFinite)) bad('camera position went NaN');

  // --- selfTest / flows ----------------------------------------------------------------------
  if (light) { window.__shotReady = true; }
  try {
    if (light) throw { __skip: true };
    const st = game.selfTest();
    out.notes.push(`selfTest stats: ${JSON.stringify(st.stats)}`);
    for (const f of st.failures) bad(`selfTest: ${f}`);
  } catch (e) { if (!e.__skip) bad(`selfTest threw: ${e.message}\n${e.stack || ''}`); }

  try {
    if (light) throw { __skip: true };
    const fl = game.exerciseFlows();
    out.notes.push(`flows stats: ${JSON.stringify(fl.stats)}`);
    for (const f of fl.errors) bad(`flow: ${f}`);
  } catch (e) { if (!e.__skip) bad(`exerciseFlows threw: ${e.message}\n${e.stack || ''}`); }

  // --- frame content ---------------------------------------------------------------------------
  try {
    if (light) throw { __skip: true };
    const px = game.readPixelStats();
    out.notes.push(`pixels: ${JSON.stringify(px)}`);
    if (px && px.unique < 24) bad(`rendered frame looks blank (${px.unique} unique colours)`);
  } catch (e) { if (!e.__skip) bad(`readPixelStats threw: ${e.message}`); }

  // --- AI soak: update-only (no render) so thousands of frames are affordable ----------------
  if (!light) {
    try {
      const t2 = performance.now();
      const bounds = game.city.bounds;
      let maxPeds = 0; let maxVeh = 0; let nan = 0; let outOfBounds = 0; let inBuilding = 0;
      let maxWanted = 0;
      const spots = game.city.spawns.missionPoints;
      for (let i = 0; i < 3000; i++) {
        // Teleport every 500 frames so the streamers have to spawn and despawn repeatedly.
        if (i % 500 === 0) {
          const p = spots[(i / 500) % spots.length];
          game.player.reset(p.x, game.worldToGround(p.x, p.z) + 0.1, p.z, 0);
        }
        if (i === 1200) game.police.addWanted(4, 'soak');
        if (i === 2400) game.police.clearWanted();
        game.update(1 / 60);

        maxWanted = Math.max(maxWanted, game.police.wanted);
        const peds = game.peds.peds || [];
        maxPeds = Math.max(maxPeds, peds.length);
        maxVeh = Math.max(maxVeh, game.vehicles.length);
        if (i % 25 === 0) {
          for (let k = 0; k < peds.length; k++) {
            const c = peds[k].character || peds[k];
            const pos = c.position || peds[k].position;
            if (!pos) continue;
            if (!Number.isFinite(pos[0]) || !Number.isFinite(pos[1]) || !Number.isFinite(pos[2])) { nan++; break; }
            if (pos[0] < bounds.min[0] - 300 || pos[0] > bounds.max[0] + 300
              || pos[2] < bounds.min[1] - 300 || pos[2] > bounds.max[1] + 300) { outOfBounds++; break; }
            const hits = game.collision.querySphere(pos[0], pos[1] + 0.9, pos[2], 0.25, []);
            if (hits.some((b) => b.tag === 'building')) { inBuilding++; break; }
          }
          for (let k = 0; k < game.vehicles.length; k++) {
            const v = game.vehicles[k];
            if (!Number.isFinite(v.position[0]) || !Number.isFinite(v.position[1]) || !Number.isFinite(v.position[2])) { nan++; break; }
          }
        }
      }
      const ms = (performance.now() - t2) / 3000;
      out.notes.push(`AI soak: 3000 update-only frames, ${ms.toFixed(2)} ms/frame, peak peds ${maxPeds}, peak vehicles ${maxVeh}, peak wanted ${maxWanted}`);
      out.notes.push(`soak invariants: NaN ${nan}, out-of-bounds ${outOfBounds}, ped-inside-building ${inBuilding}`);
      if (nan) bad(`${nan} NaN entity positions during the AI soak`);
      if (outOfBounds) bad(`${outOfBounds} entities left the world during the AI soak`);
      if (inBuilding > 6) bad(`${inBuilding} sample points found a pedestrian inside a building`);
      if (maxPeds > 120) bad(`pedestrian cap exceeded: ${maxPeds}`);
      if (maxVeh > 160) bad(`vehicle cap exceeded: ${maxVeh}`);
      if (maxWanted < 4) bad(`wanted level never escalated (peak ${maxWanted})`);
      if (game.police.wanted !== 0) bad(`clearWanted left wanted at ${game.police.wanted}`);
      const leftoverCops = (game.police.cars || []).length + (game.police.cops || []).length;
      out.notes.push(`police entities after clearWanted: ${leftoverCops}`);
      if (leftoverCops > 4) bad(`clearWanted leaked ${leftoverCops} police entities`);
      if (ms > 12) bad(`AI update costs ${ms.toFixed(2)} ms/frame`);
    } catch (e) { bad(`AI soak threw: ${e.message}\n${e.stack || ''}`); }
  }

  // --- render target vs canvas geometry -------------------------------------------------------
  try {
    const r = game.renderer;
    const c = canvas;
    out.notes.push(`canvas=${c.width}x${c.height} client=${c.clientWidth}x${c.clientHeight} dpr=${window.devicePixelRatio}`);
    out.notes.push(`drawingBuffer=${game.gl.drawingBufferWidth}x${game.gl.drawingBufferHeight}`);
    out.notes.push(`renderScale=${r.quality && r.quality.renderScale} hdr=${r.hdr ? r.hdr.width + 'x' + r.hdr.height : 'n/a'}`);
    if (r.postfx) out.notes.push(`postfx size=${r.postfx.width || '?'}x${r.postfx.height || '?'}`);
    const vp = game.gl.getParameter(game.gl.VIEWPORT);
    out.notes.push(`viewport after render=[${Array.from(vp).join(',')}]`);
  } catch (e) { out.notes.push('target diag failed: ' + e.message); }

  // --- what is that geometry filling the right of the frame? ------------------------------
  try {
    const cam = game.camera;
    const probeDirs = [];
    for (const deg of [-40, -30, -20, -10, 0, 10, 20, 30, 40]) {
      const a = cam.yaw + deg * Math.PI / 180;
      probeDirs.push([deg, [-Math.sin(a), 0, -Math.cos(a)]]);
    }
    const hits = [];
    for (const [deg, d] of probeDirs) {
      const h = game.collision.raycast(cam.position, d, 60, null);
      hits.push(`${deg}deg:${h ? `${h.body && h.body.tag}@${h.t.toFixed(1)}m` : 'none'}`);
    }
    out.notes.push('camera raycasts: ' + hits.join(' '));
    // nearest bodies around the camera
    const near = game.collision.querySphere(cam.position[0], cam.position[1], cam.position[2], 12, []);
    const tags = {};
    for (const b of near) tags[b.tag] = (tags[b.tag] || 0) + 1;
    out.notes.push(`bodies within 12 m of the camera: ${JSON.stringify(tags)}`);
    const b0 = near.filter((b) => b.tag === 'building')[0];
    if (b0) {
      const bid = b0.userData && (b0.userData.id !== undefined ? b0.userData.id : b0.userData.buildingId);
      const bd = bid !== undefined ? game.city.buildings[bid] : null;
      out.notes.push(`nearest building body: tag=${b0.tag} id=${bid} ${bd ? `style=${bd.style} h=${bd.h.toFixed(1)} pal=${JSON.stringify(bd.palette)}` : ''}`);
    }
  } catch (e) { out.notes.push('raycast diag failed: ' + e.message); }

  // --- HUD presence ------------------------------------------------------------------------------
  const hudChildren = dom.hudRoot.children.length;
  out.notes.push(`HUD root children: ${hudChildren}, menu root children: ${dom.menuRoot.children.length}`);
  if (hudChildren === 0) bad('HUD built no DOM');

  for (const e of consoleErrors.slice(0, 12)) bad(`console.error: ${e}`);
  console.error = origError;

  window.__shot = async (arg) => {
    const mode = String(arg || '');
    // main.js hides these once boot finishes; this probe drives Game directly, so do it here.
    dom.loading.classList.add('hidden');
    dom.loading.style.display = 'none';
    game.menu.hide();
    dom.menuRoot.style.display = 'none';
    game.hud.show();
    game.player.aiming = false;
    if (mode.includes('turn')) game.camera.yaw += Math.PI;
    if (mode.includes('nomark')) game.missions.submit = () => {};
    if (mode.includes('nopick')) game._submitPickups = () => {};
    if (mode.includes('move')) {
      const p = game.city.spawns.missionPoints[3] || game.city.spawns.missionPoints[0];
      game.player.reset(p.x, game.worldToGround(p.x, p.z) + 0.1, p.z, 0);
      game.camera.yaw = 1.2;
      game._camPos[0] = p.x; game._camPos[1] = p.y + 2; game._camPos[2] = p.z + 6;
    }
    for (let i = 0; i < 6; i++) { game.update(1 / 60); game.hud.update(1 / 60); }
    game.render(1 / 60);
  };
  window.__game = game;
  return out;
}
