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

  // --- run frames --------------------------------------------------------------------------
  let frames = 0;
  const t1 = performance.now();
  try {
    for (let i = 0; i < 40; i++) { game.update(1 / 60); game.render(1 / 60); frames++; }
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
  try {
    const st = game.selfTest();
    out.notes.push(`selfTest stats: ${JSON.stringify(st.stats)}`);
    for (const f of st.failures) bad(`selfTest: ${f}`);
  } catch (e) { bad(`selfTest threw: ${e.message}\n${e.stack || ''}`); }

  try {
    const fl = game.exerciseFlows();
    out.notes.push(`flows stats: ${JSON.stringify(fl.stats)}`);
    for (const f of fl.errors) bad(`flow: ${f}`);
  } catch (e) { bad(`exerciseFlows threw: ${e.message}\n${e.stack || ''}`); }

  // --- frame content ---------------------------------------------------------------------------
  try {
    const px = game.readPixelStats();
    out.notes.push(`pixels: ${JSON.stringify(px)}`);
    if (px && px.unique < 24) bad(`rendered frame looks blank (${px.unique} unique colours)`);
  } catch (e) { bad(`readPixelStats threw: ${e.message}`); }

  // --- HUD presence ------------------------------------------------------------------------------
  const hudChildren = dom.hudRoot.children.length;
  out.notes.push(`HUD root children: ${hudChildren}, menu root children: ${dom.menuRoot.children.length}`);
  if (hudChildren === 0) bad('HUD built no DOM');

  for (const e of consoleErrors.slice(0, 12)) bad(`console.error: ${e}`);
  console.error = origError;

  window.__shot = async () => { game.update(1 / 60); game.render(1 / 60); };
  window.__game = game;
  return out;
}
