/**
 * Regression probe for: "after visiting the settings menu mid-game, the keyboard stops working".
 *
 * Uses REAL dispatched KeyboardEvents rather than Input.injectKey, because the failure mode lives
 * in DOM listener ordering (ui/menu.js installs a capture-phase keydown handler on window that
 * calls stopPropagation, so core/input.js's bubble-phase listener never sees the event).
 *
 * Run: node tools/gl-probe.mjs tools/probe-menu-return.js
 */
import { Game } from '/js/game.js';

function buildDom() {
  const css = document.createElement('link');
  css.rel = 'stylesheet'; css.href = '/css/game.css';
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
    hudRoot: mk('hud-root', 'layer'), menuRoot: mk('menu-root', 'layer'),
    mapRoot: mk('map-root', 'layer hidden'), loading,
    loadFill: document.getElementById('load-fill'), loadStatus: document.getElementById('load-status'),
    loadTip: document.getElementById('load-tip'), fatal, fatalMsg: fm,
  };
}

// Dispatch on the focused element, NOT on window: a real keydown targets the focused node and
// propagates window(capture) -> target -> window(bubble), so a capture-phase stopPropagation can
// legitimately starve the bubble-phase listener in core/input.js. Dispatching on window makes
// window the target, which silently defeats that mechanism and hides the bug.
const key = (type, code) => (document.activeElement || document.body)
  .dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true }));

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
  const step = (n = 4) => { for (let i = 0; i < n; i++) game.update(1 / 60); };

  /** Presses a key through the real DOM and reports whether the game saw it. */
  const walks = (label) => {
    key('keydown', 'KeyW');
    game.update(1 / 60);
    const down = game.input.isDown('forward');
    const before = game.player.position[2];
    step(30);
    const moved = Math.abs(game.player.position[2] - before);
    key('keyup', 'KeyW');
    step(4);
    out.notes.push(`${label}: isDown(forward)=${down} moved=${moved.toFixed(2)}m menu.isOpen=${game.menu.isOpen} blocked=${game.input.blocked} paused=${game.paused}`);
    return { down, moved };
  };

  const a = walks('before menu');
  if (!a.down || a.moved < 0.4) bad('baseline broken: keyboard did not work before opening any menu');

  // pause -> settings -> back -> resume, all through the real UI paths
  game.pause();
  step(2);
  game.menu.showSettings();
  step(2);
  out.notes.push(`in settings: menu.isOpen=${game.menu.isOpen} screen=${game.menu._screen}`);
  key('keydown', 'Escape'); key('keyup', 'Escape');   // back out of settings
  step(2);
  out.notes.push(`after Esc from settings: screen=${game.menu._screen} isOpen=${game.menu.isOpen}`);
  game.resume();
  step(4);
  out.notes.push(`after resume: menu.isOpen=${game.menu.isOpen} blocked=${game.input.blocked} paused=${game.paused}`);

  const b = walks('after settings round-trip');
  if (!b.down) bad('REPRO: after visiting settings, a real KeyW event no longer reaches the game');
  if (b.moved < 0.4) bad(`REPRO: player does not move after the settings round-trip (${b.moved.toFixed(2)} m)`);

  // --- the real user path, with pointer lock refused exactly as it is inside an iframe --------
  // (the published build runs in an embedding that never grants pointer lock, so resume() takes
  //  the failure path; reproduce that here rather than the desktop path.)
  game.input.pointerLockAvailable = false;
  game.input.dragLook = true;
  const clickText = (txt) => {
    // Only the screen that is actually on-screen: every screen stays in the DOM, just hidden.
    const nodes = Array.from(dom.menuRoot.querySelectorAll('button, [role="button"], .btn, [tabindex]'))
      .filter((n) => n.offsetParent !== null);
    const el = nodes.find((n) => (n.textContent || '').trim().includes(txt));
    if (!el) return `NOT FOUND: ${txt}`;
    el.focus();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return `clicked ${txt} (${el.nodeName}.${el.className})`;
  };

  game.pause(); step(2);
  out.notes.push('pause menu buttons: ' + Array.from(dom.menuRoot.querySelectorAll('button, .btn'))
    .filter((n) => n.offsetParent !== null)
    .map((n) => (n.textContent || '').trim().slice(0, 12)).filter(Boolean).join(' | '));
  out.notes.push(clickText('설정')); step(3);
  out.notes.push(`screen now=${game.menu._screen}`);
  out.notes.push('settings buttons: ' + Array.from(dom.menuRoot.querySelectorAll('button, .btn'))
    .filter((n) => n.offsetParent !== null)
    .map((n) => (n.textContent || '').trim().slice(0, 14)).filter(Boolean).slice(0, 10).join(' | '));
  out.notes.push(clickText('뒤로')); step(3);
  out.notes.push(`screen now=${game.menu._screen} isOpen=${game.menu.isOpen}`);
  out.notes.push(clickText('계속')); step(6);
  out.notes.push(`after 계속하기: isOpen=${game.menu.isOpen} blocked=${game.input.blocked} paused=${game.paused} active=${document.activeElement && document.activeElement.nodeName}`);
  const e2 = walks('after clicking through settings');
  if (!e2.down || e2.moved < 0.4) bad('REPRO: keyboard dead after clicking through the settings menu');

  // --- the earlier programmatic path: click a settings control, then return to the game ------------------
  game.pause(); step(2);
  game.menu.showSettings(); step(2);
  const controls = dom.menuRoot.querySelectorAll('input, select, textarea');
  out.notes.push(`settings controls found: ${controls.length} (${Array.from(controls).slice(0, 4).map((e) => e.nodeName + (e.type ? ':' + e.type : '')).join(', ')})`);
  if (controls.length) {
    controls[0].focus();   // exactly what clicking a slider/select does
    out.notes.push(`focused after click: ${document.activeElement && document.activeElement.nodeName}`);
  }
  game.menu.showPause(); step(2);
  game.resume(); step(4);
  out.notes.push(`after resume, activeElement=${document.activeElement && document.activeElement.nodeName} id=${document.activeElement && document.activeElement.id}`);
  const d = walks('after touching a settings control');
  if (!d.down || d.moved < 0.4) bad('REPRO: keyboard dead after interacting with a settings control');

  // and again via the pause menu only (no settings), to isolate which step breaks it
  game.pause(); step(2); game.resume(); step(4);
  const c = walks('after plain pause/resume');
  if (!c.down || c.moved < 0.4) bad('keyboard also broken after a plain pause/resume');

  return out;
}
