/**
 * Headless probe for js/core/input.js — verifies key/mouse handling, edge detection, axes,
 * blocked-state gating, the stuck-key guard on blur and the test injection hooks.
 *
 * Run: node tools/gl-probe.mjs tools/probe-input.js
 */
import { Input } from '/js/core/input.js';

const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));

export default async function run({ canvas }) {
  const out = { errors: [], notes: [] };
  const bad = (m) => out.errors.push(m);

  const input = new Input(canvas, {});
  input.attach();

  // --- key edges -------------------------------------------------------------------------
  key('keydown', 'KeyW');
  input.update(1 / 60);
  if (!input.isDown('forward')) bad('KeyW did not register as forward');
  if (!input.justPressed('forward')) bad('justPressed(forward) false on the press frame');
  input.endFrame();
  input.update(1 / 60);
  if (input.justPressed('forward')) bad('justPressed stayed true after endFrame');
  if (!input.isDown('forward')) bad('isDown(forward) lost while held');

  // auto-repeat must not re-trigger justPressed
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', repeat: true }));
  input.update(1 / 60);
  if (input.justPressed('forward')) bad('auto-repeat re-triggered justPressed');
  input.endFrame();

  key('keyup', 'KeyW');
  input.update(1 / 60);
  if (input.isDown('forward')) bad('forward stuck down after keyup');
  if (!input.justReleased('forward')) bad('justReleased(forward) not reported');
  input.endFrame();

  // --- axes ------------------------------------------------------------------------------
  key('keydown', 'KeyW'); key('keydown', 'KeyD');
  input.update(1 / 60);
  const my = input.axis('moveY');
  const mx = input.axis('moveX');
  out.notes.push(`axis W+D -> moveY=${my.toFixed(2)} moveX=${mx.toFixed(2)}`);
  if (!(my > 0.5)) bad(`moveY should be positive for forward, got ${my}`);
  if (!(mx > 0.5)) bad(`moveX should be positive for right, got ${mx}`);
  key('keyup', 'KeyW'); key('keyup', 'KeyD');
  input.update(1 / 60); input.endFrame();

  // opposite keys cancel
  key('keydown', 'KeyA'); key('keydown', 'KeyD');
  input.update(1 / 60);
  if (Math.abs(input.axis('moveX')) > 0.01) bad('A+D should cancel out');
  key('keyup', 'KeyA'); key('keyup', 'KeyD');
  input.update(1 / 60); input.endFrame();

  // --- blocked gating ---------------------------------------------------------------------
  key('keydown', 'KeyW');
  input.blocked = true;
  input.update(1 / 60);
  if (input.isDown('forward')) bad('blocked did not gate a gameplay action');
  if (input.axis('moveY') !== 0) bad('blocked did not zero the axes');
  key('keydown', 'Escape');
  input.update(1 / 60);
  if (!input.justPressed('pause')) bad('blocked wrongly gated the UI action "pause"');
  input.blocked = false;
  key('keyup', 'KeyW'); key('keyup', 'Escape');
  input.update(1 / 60); input.endFrame();

  // --- stuck-key guard --------------------------------------------------------------------
  key('keydown', 'KeyS');
  input.update(1 / 60);
  window.dispatchEvent(new Event('blur'));
  input.update(1 / 60);
  if (input.isDown('back')) bad('keys were not cleared on window blur (stuck key)');
  input.endFrame();

  // --- mouse look --------------------------------------------------------------------------
  input.sensitivity = 1;
  input.invertY = false;
  input.injectMouseDelta(100, 50);
  const d1 = input.consumeMouseDelta({ x: 0, y: 0 });
  out.notes.push(`mouse 100,50 -> ${d1.x.toFixed(4)}, ${d1.y.toFixed(4)} rad`);
  if (!(d1.x > 0.01 && d1.x < 1.5)) bad(`mouse yaw delta out of a sane radian range: ${d1.x}`);
  const d2 = input.consumeMouseDelta({ x: 0, y: 0 });
  if (d2.x !== 0 || d2.y !== 0) bad('consumeMouseDelta did not reset the accumulator');

  input.invertY = true;
  input.injectMouseDelta(0, 50);
  const d3 = input.consumeMouseDelta({ x: 0, y: 0 });
  if (Math.sign(d3.y) === Math.sign(d1.y) && d1.y !== 0) bad('invertY had no effect');
  input.invertY = false;

  input.sensitivity = 2;
  input.injectMouseDelta(100, 0);
  const d4 = input.consumeMouseDelta({ x: 0, y: 0 });
  if (!(Math.abs(d4.x - d1.x * 2) < 1e-6)) bad(`sensitivity scaling wrong: ${d4.x} vs ${d1.x * 2}`);
  input.sensitivity = 1;

  // spike guard
  input.injectMouseDelta(100000, 0);
  const d5 = input.consumeMouseDelta({ x: 0, y: 0 });
  out.notes.push(`spike 100000px -> ${d5.x.toFixed(3)} rad`);
  if (Math.abs(d5.x) > 6.5) bad(`pointer-lock spike not clamped: ${d5.x} rad in one frame`);

  // --- injectKey -----------------------------------------------------------------------------
  input.injectKey('KeyW', true);
  input.update(1 / 60);
  if (!input.isDown('forward')) bad('injectKey(down) did not register');
  input.injectKey('KeyW', false);
  input.update(1 / 60);
  if (input.isDown('forward')) bad('injectKey(up) did not release');
  input.endFrame();

  // --- allocation sanity ----------------------------------------------------------------------
  const t0 = performance.now();
  for (let i = 0; i < 20000; i++) { input.update(1 / 60); input.axis('moveX'); input.isDown('fire'); input.endFrame(); }
  out.notes.push(`20000 update+endFrame cycles in ${(performance.now() - t0).toFixed(1)} ms`);

  // --- drag-to-look fallback (pointer lock refused, e.g. an iframe without allow="pointer-lock")
  {
    const fb = new Input(canvas, {});
    fb.attach();
    fb.pointerLockAvailable = false;
    fb.dragLook = true;
    const rect = canvas.getBoundingClientRect();
    const at = (type, x, y, button = 0, buttons = 1) => {
      const ev = new MouseEvent(type, {
        clientX: rect.left + x, clientY: rect.top + y, button, buttons, bubbles: true, cancelable: true,
      });
      (type === 'mousedown' ? canvas : window).dispatchEvent(ev);
    };

    // A drag must turn the camera and must NOT fire.
    at('mousedown', 100, 100);
    for (let i = 1; i <= 8; i++) at('mousemove', 100 + i * 10, 100, 0, 1);
    fb.update(1 / 60);
    const d = fb.consumeMouseDelta({ x: 0, y: 0 });
    out.notes.push(`drag-look: 80px drag right -> ${d.x.toFixed(3)} rad (gain ${fb.dragSensitivity}, invertX ${fb.dragInvertX})`);
    if (Math.abs(d.x) < 0.05) bad(`drag-to-look produced no camera movement (${d.x})`);
    // game.js applies `camera.yaw -= delta.x`, so dragging RIGHT must yield a NEGATIVE delta for
    // the view to swing LEFT (drag-the-world), which is what the inverted axis is for.
    if (fb.dragInvertX && d.x >= 0) bad(`dragging right should give a negative look delta, got ${d.x.toFixed(3)}`);
    // A drag of 80 px should turn a useful amount, not a sliver.
    if (Math.abs(d.x) < 0.35) bad(`drag-to-look is too slow: 80 px only turned ${Math.abs(d.x).toFixed(3)} rad`);
    if (fb.isDown('fire')) bad('dragging to look also held the fire button');
    at('mouseup', 180, 100);
    fb.update(1 / 60);
    if (fb.isDown('fire')) bad('releasing a look-drag fired the weapon');
    fb.endFrame();

    // A tap must fire.
    at('mousedown', 300, 300);
    at('mouseup', 301, 300);
    fb.update(1 / 60);
    const fired = fb.isDown('fire') || fb.justPressed('fire');
    out.notes.push(`drag-look: tap -> fire=${fired}`);
    if (!fired) bad('a quick click did not fire in drag-look mode');
    fb.endFrame(); fb.update(1 / 60); fb.endFrame(); fb.update(1 / 60);
    if (fb.isDown('fire')) bad('the synthetic fire press was never released');
    fb.detach();
  }

  input.detach();
  return out;
}
