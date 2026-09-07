/**
 * NEON CITY - entry point.
 *
 * Boots the engine, streams progress into the loading screen, wires the menus, and owns the
 * requestAnimationFrame loop. Also installs the `window.__NEON` test surface used by
 * tools/smoke-test.mjs so the whole game can be driven headlessly.
 */
import { Game } from './game.js';

const LOADING_TIPS = [
  '마우스로 시점을 돌리고, WASD로 이동합니다.',
  'F 키로 가까운 차량에 타고 내릴 수 있습니다.',
  '우클릭으로 조준하면 어깨너머 시점으로 전환됩니다.',
  'Tab 키로 도시 전체 지도를 열고, 지도를 클릭해 목적지를 찍어보세요.',
  'N 키로 라디오 방송국을, M 키로 다음 곡을 바꿉니다. 전부 클래식입니다.',
  '수배 레벨이 올라가면 경찰이 더 집요해집니다. 골목으로 숨으세요.',
  '노란 마커 위에 서면 미션이 시작됩니다.',
  'V 키로 카메라 모드를, C 키로 뒤돌아보기를 사용할 수 있습니다.',
];

const dom = {
  canvas: document.getElementById('game-canvas'),
  loading: document.getElementById('loading-screen'),
  loadFill: document.getElementById('load-fill'),
  loadStatus: document.getElementById('load-status'),
  loadTip: document.getElementById('load-tip'),
  fatal: document.getElementById('fatal'),
  fatalMsg: document.getElementById('fatal-msg'),
  hudRoot: document.getElementById('hud-root'),
  menuRoot: document.getElementById('menu-root'),
  mapRoot: document.getElementById('map-root'),
};

/** @param {string} message */
function fatal(message, err) {
  if (err) console.error(err);
  if (dom.loading) dom.loading.classList.add('hidden');
  if (dom.fatal) dom.fatal.classList.remove('hidden');
  if (dom.fatalMsg) dom.fatalMsg.textContent = message;
  if (window.__NEON) window.__NEON.fatal = message;
}

function setProgress(p, label) {
  if (dom.loadFill) dom.loadFill.style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
  if (label && dom.loadStatus) dom.loadStatus.textContent = label;
}

let tipTimer = 0;
function cycleTip() {
  if (!dom.loadTip) return;
  dom.loadTip.textContent = LOADING_TIPS[(Math.random() * LOADING_TIPS.length) | 0];
  tipTimer = window.setTimeout(cycleTip, 4200);
}

// --- main loop ------------------------------------------------------------------------------
let game = null;
let rafId = 0;
let lastTime = 0;
let frameCount = 0;
let fpsAccum = 0;
let fpsFrames = 0;
let fps = 0;

function frame(now) {
  rafId = requestAnimationFrame(frame);
  if (!lastTime) lastTime = now;
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  // Clamp so a tab switch or a GC hitch never teleports the simulation.
  if (dt > 0.1) dt = 0.1;
  if (dt < 0) dt = 0;

  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum >= 0.5) {
    fps = fpsFrames / fpsAccum;
    fpsAccum = 0;
    fpsFrames = 0;
  }

  try {
    game.update(dt);
    game.render(dt);
  } catch (err) {
    cancelAnimationFrame(rafId);
    fatal(`실행 중 오류가 발생했습니다: ${err.message}`, err);
    throw err;
  }
  frameCount++;
}

async function boot() {
  installTestHooks();

  if (!dom.canvas) { fatal('캔버스를 찾을 수 없습니다.'); return; }
  cycleTip();

  try {
    game = new Game(dom.canvas, dom);
  } catch (err) {
    fatal(err && err.message ? err.message : '엔진을 초기화할 수 없습니다.', err);
    return;
  }

  try {
    await game.init((p, label) => setProgress(p, label));
  } catch (err) {
    fatal(`초기화 실패: ${err.message}`, err);
    return;
  }

  window.clearTimeout(tipTimer);
  setProgress(1, '준비 완료');
  dom.loading.classList.add('fade-out');
  window.setTimeout(() => dom.loading.classList.add('hidden'), 650);

  game.menu.showMain();
  lastTime = 0;
  rafId = requestAnimationFrame(frame);

  window.__NEON.game = game;
  window.__NEON.ready = true;
  window.__NEON.info = game.buildInfo();
  console.log('[test] NEON CITY ready', JSON.stringify(window.__NEON.info));
}

// --- headless test surface -------------------------------------------------------------------
function installTestHooks() {
  window.__NEON = {
    ready: false,
    fatal: null,
    game: null,
    info: null,
    frameCount: () => frameCount,
    fps: () => fps,
    stats: () => (game ? game.debugStats() : null),
    startGame: () => { if (game) game.startNewGame({ skipPointerLock: true }); },
    /** Feed synthetic mouse-look deltas (pointer lock is unavailable in headless runs). */
    injectMouse: (dx, dy) => { if (game) game.input.injectMouseDelta(dx, dy); },
    injectKey: (code, down) => { if (game) game.input.injectKey(code, down); },
    selfTest: () => (game ? game.selfTest() : { failures: ['game not built'] }),
    exerciseFlows: () => (game ? game.exerciseFlows() : { errors: ['game not built'] }),
    pixelStats: () => {
      if (!game) return null;
      return game.readPixelStats();
    },
  };
}

window.addEventListener('error', (e) => {
  if (window.__NEON) (window.__NEON.errors = window.__NEON.errors || []).push(String(e.message));
});

boot();
