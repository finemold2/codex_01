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
  if (smoke.cov < 0.02) bad('warmed-up smoke plume barely visible: coverage ' + smoke.cov);

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

  // ---- height fog must be consumed and must match the scene integral ----------------------
  // Reference: the same analytic integral render/shaders.js (GLSL_FOG) uses for geometry.
  const fogAmount = (camY, worldY, dist, density, hf) => {
    if (dist < 1e-4 || density <= 0) return 0;
    let t;
    if (hf < 1e-4) t = density * dist;
    else {
      const dy = worldY - camY;
      const ec = Math.exp(-hf * camY);
      if (Math.abs(dy) < 1e-3) t = density * dist * ec;
      else t = density * dist * (ec - Math.exp(-hf * worldY)) / (hf * dy);
    }
    return 1 - Math.exp(-Math.max(t, 0));
  };

  // Fake renderer surface so the particle system reads density / heightFalloff / skyBlend.
  const fakeFog = { color: new Float32Array([0, 0, 0]), density: 0.004, heightFalloff: 0, skyBlend: 0 };
  const fakeSun = { direction: new Float32Array([0, 1, 0]), color: new Float32Array([1, 1, 1]),
    intensity: 1, ambientSky: new Float32Array([0, 0, 0]), ambientGround: new Float32Array([0, 0, 0]) };
  ps.renderer = { sun: fakeSun, fog: fakeFog, textures: null };

  // Look up at a bright additive puff high above the camera: additive fog is a pure
  // attenuation (color * (1 - fog)), so the read-back luma is a direct probe of `fog`.
  const hiCam = new Camera(62, 0.12, 2000);
  hiCam.position[0] = 0; hiCam.position[1] = 2; hiCam.position[2] = 0;
  hiCam.yaw = 0; hiCam.pitch = Math.PI / 2 - 0.001;   // straight up
  hiCam.update(1);
  const puffY = 152;
  const dist = puffY - 2;

  const shootPuff = () => {
    ps.clear();
    ps.spawn({ kind: 'flash', x: 0, y: puffY, z: 0, life: 10, size: 60, sizeEnd: 60, sprite: 15,
      alpha: 1, alphaEnd: 1, color: [0.25, 0.25, 0.25], colorEnd: [0.25, 0.25, 0.25],
      gravity: 0, drag: 0, fadeIn: 0, soft: 0, emissive: 1, additive: 1, rotation: 0 });
    ps.update(1 / 240, hiCam);
    rt.bind(true);
    ps.render(hiCam);
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.framebuffer);
    gl.readPixels(W / 2, H / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf[0];
  };

  fakeFog.heightFalloff = 0;
  const flatPix = shootPuff();
  fakeFog.heightFalloff = 0.018;
  const heightPix = shootPuff();
  fakeFog.density = 0;
  const noFogPix = shootPuff();

  const flatFog = fogAmount(2, puffY, dist, 0.004, 0);
  const heightFog = fogAmount(2, puffY, dist, 0.004, 0.018);
  out.checks.fog = {
    noFogPix, flatPix, heightPix,
    expectFlatPix: Math.round(noFogPix * (1 - flatFog)),
    expectHeightPix: Math.round(noFogPix * (1 - heightFog)),
    flatFog: +flatFog.toFixed(4), heightFog: +heightFog.toFixed(4)
  };
  if (noFogPix < 40 || noFogPix > 250) bad('fog probe: reference puff out of measurable range (' + noFogPix + ')');
  if (Math.abs(flatPix - noFogPix * (1 - flatFog)) > 6) {
    bad('flat fog (heightFalloff=0) disagrees with the scene integral: got ' + flatPix +
      ', expected ' + Math.round(noFogPix * (1 - flatFog)));
  }
  if (Math.abs(heightPix - noFogPix * (1 - heightFog)) > 6) {
    bad('height fog disagrees with the scene integral: got ' + heightPix +
      ', expected ' + Math.round(noFogPix * (1 - heightFog)));
  }
  if (heightPix <= flatPix) bad('heightFalloff is ignored: height fog must be thinner aloft');
  ps.renderer = null;

  let e = gl.getError();
  if (e) bad('trailing gl error 0x' + e.toString(16));
  return out;
}
