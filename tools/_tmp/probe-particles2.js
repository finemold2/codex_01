/**
 * Second-stage particle probe: visual correctness of the sprite atlas mapping, warmed-up
 * coverage, saturation cost, and fog agreement with the scene shader.
 * Run: node tools/gl-probe.mjs tools/_tmp/probe-particles2.js
 */
import { createGLContext, RenderTarget } from '/js/core/gl.js';
import { ParticleSystem } from '/js/render/particles.js';
import { Camera } from '/js/render/renderer.js';

export default async function run({ canvas }) {
  const out = { errors: [], notes: [], checks: {} };
  const bad = (m) => out.errors.push(m);
  const W = 256, H = 256;
  canvas.width = W; canvas.height = H;
  const gl = createGLContext(canvas, {});
  if (!gl) { bad('no webgl2'); return out; }

  const ps = new ParticleSystem(gl, null, 6000);
  ps.softParticles = false;
  const cam = new Camera(62, 0.12, 800);
  cam.position[0] = 0; cam.position[1] = 0; cam.position[2] = 5;
  cam.yaw = 0; cam.pitch = 0;
  cam.update(1);

  const rt = new RenderTarget(gl, W, H, { colorFormat: 'rgba8', depth: true, filter: 'nearest', wrap: 'clamp' });
  const buf = new Uint8Array(W * H * 4);
  const grab = () => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.framebuffer);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let n = 0, sy = 0, sx = 0, sum = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const l = buf[(y * W + x) * 4] + buf[(y * W + x) * 4 + 1] + buf[(y * W + x) * 4 + 2];
        if (l > 12) { n++; sy += y; sx += x; }
        sum += l;
      }
    }
    // readPixels y=0 is the BOTTOM of the image.
    return { cov: +(n / (W * H)).toFixed(4), cy: n ? +((sy / n - H / 2) / H).toFixed(4) : 0,
      cx: n ? +((sx / n - W / 2) / W).toFixed(4) : 0, mean: +(sum / (W * H * 3)).toFixed(2) };
  };

  // ---- per-sprite-cell fingerprint (no stretch, facing the camera, centred) ----
  const cells = [];
  for (let cell = 0; cell < 16; cell++) {
    ps.clear();
    ps.spawn({ kind: 'smoke', x: 0, y: 0, z: 0, life: 10, size: 3, sizeEnd: 3, sprite: cell,
      alpha: 1, alphaEnd: 1, color: [1, 1, 1], colorEnd: [1, 1, 1], gravity: 0, drag: 0,
      fadeIn: 0, soft: 0, emissive: 1, additive: 1, rotation: 0 });
    ps.update(1 / 240, cam);
    rt.bind(true);
    ps.render(cam);
    cells.push(grab());
  }
  out.checks.cells = cells;
  const distinct = new Set(cells.map((c) => c.cov + ':' + c.cy + ':' + c.cx));
  out.checks.distinctCells = distinct.size;
  if (distinct.size < 10) bad('sprite cells are not distinct (atlas indexing broken): ' + distinct.size);
  for (let i = 0; i < 16; i++) if (cells[i].cov <= 0) bad('sprite cell ' + i + ' rendered nothing');

  // SPR_RAIN (cell 5) puts the drop head at v=0.76 (lower half of the cell image), which the
  // quad maps to its bottom edge -> the bright head must land BELOW centre on screen.
  out.checks.rainHeadBelowCentre = cells[5].cy < 0;
  // SPR_LEAF (cell 9) is widest at v=0.5 and pointed at both ends -> roughly centred.
  out.notes.push('cell centroids (y, +up): ' + cells.map((c, i) => i + ':' + c.cy).join(' '));

  // ---- warmed-up coverage: a real smoke plume must actually be visible ----
  ps.clear();
  ps.burst('smoke', 0, 0, 0, 80, { size: 0.6, life: 3 });
  for (let f = 0; f < 40; f++) { ps.update(1 / 60, cam); rt.bind(true); ps.render(cam); }
  const smoke = grab();
  out.checks.smokePlume = smoke;
  if (smoke.cov < 0.05) bad('warmed-up smoke plume barely visible: coverage ' + smoke.cov);

  ps.clear();
  ps.burst('explosion', 0, 0, 0, 120, { power: 3 });
  for (let f = 0; f < 6; f++) { ps.update(1 / 60, cam); rt.bind(true); ps.render(cam); }
  const boom = grab();
  out.checks.explosion = boom;
  if (boom.cov < 0.05) bad('explosion barely visible: coverage ' + boom.cov);

  // ---- saturation cost of the recycle scan ----
  ps.clear();
  ps.burst('smoke', 0, 0, -20, 6000, { life: 30 });   // fill the pool
  ps.update(1 / 60, cam);
  let t0 = performance.now();
  for (let k = 0; k < 10; k++) ps.burst('explosion', 0, 0, -20, 400, { power: 3 });
  const recycleMs = +(performance.now() - t0).toFixed(2);
  out.checks.recycle4000SpawnsMs = recycleMs;
  t0 = performance.now();
  ps.clear();
  ps.burst('smoke', 0, 0, -20, 4000, { life: 30 });
  const freshMs = +(performance.now() - t0).toFixed(2);
  out.checks.fresh4000SpawnsMs = freshMs;

  // ---- update()/render() cost with a full pool ----
  ps.clear();
  ps.burst('smoke', 0, 0, -20, 6000, { life: 30 });
  ps.update(1 / 60, cam);
  t0 = performance.now();
  for (let f = 0; f < 30; f++) { ps.update(1 / 60, cam); rt.bind(true); ps.render(cam); }
  out.checks.msPerFrame6000 = +((performance.now() - t0) / 30).toFixed(3);

  let e = gl.getError();
  if (e) bad('trailing gl error 0x' + e.toString(16));
  return out;
}
