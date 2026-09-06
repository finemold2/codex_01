/**
 * Adversarial verification probe for js/render/sky.js.
 * Run: node tools/gl-probe.mjs tools/_tmp/sky-verify.js
 */
import { createGLContext, RenderTarget } from '/js/core/gl.js';
import { mat4, DEG2RAD } from '/js/core/math.js';
import { Sky } from '/js/render/sky.js';

const V3 = (x, y, z) => new Float32Array([x, y, z]);

function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return V3(v[0] / l, v[1] / l, v[2] / l);
}

/** Minimal camera with real matrices looking along `dir`. */
function camAt(dir, fovDeg, aspect, pos) {
  const d = norm(dir);
  const up = Math.abs(d[1]) > 0.98 ? [0, 0, -Math.sign(d[1] || 1)] : [0, 1, 0];
  const p = pos || V3(0, 20, 0);
  const view = mat4.lookAt(mat4.create(), p, [p[0] + d[0], p[1] + d[1], p[2] + d[2]], up);
  const proj = mat4.perspective(mat4.create(), fovDeg * DEG2RAD, aspect, 0.1, 4000);
  return {
    position: p, fov: fovDeg, near: 0.1, far: 4000,
    view, proj,
    viewProj: mat4.multiply(mat4.create(), proj, view),
    invView: mat4.invert(mat4.create(), view),
    invProj: mat4.invert(mat4.create(), proj)
  };
}

export default async function run({ canvas }) {
  const out = { errors: [], warns: [], notes: [] };
  const bad = (m) => out.errors.push(m);
  const warn = (m) => out.warns.push(m);
  const note = (m) => out.notes.push(m);

  canvas.width = 256; canvas.height = 256;
  const gl = createGLContext(canvas, {});
  if (!gl) { bad('no webgl2'); return out; }
  note('renderer: ' + (gl.__ext && gl.__ext.debugRendererInfo
    ? gl.getParameter(gl.__ext.debugRendererInfo.UNMASKED_RENDERER_WEBGL) : 'n/a'));

  /* ---------------- 1. shader compile / link, every tier ---------------- */
  let sky;
  try {
    sky = new Sky(gl, { quality: { name: 'high' }, hdr: { width: 256, height: 256 } });
  } catch (e) { bad('Sky ctor threw: ' + e.message); return out; }
  try { sky.precompile(); } catch (e) { bad('precompile threw: ' + e.message); }
  note('compiled tiers: ' + [...sky._shaders.keys()].join(','));
  let e0 = gl.getError();
  if (e0) bad('gl error after compile: 0x' + e0.toString(16));

  /* ---------------- HDR sampling target ---------------- */
  const RT = new RenderTarget(gl, 33, 33, { colorFormat: 'rgba16f', depth: true, filter: 'nearest' });
  note('rt format: ' + RT.colorFormats[0]);
  const px1 = new Float32Array(4);
  let readOK = true;
  function readCenter() {
    gl.readPixels(16, 16, 1, 1, gl.RGBA, gl.FLOAT, px1);
    const er = gl.getError();
    if (er) { readOK = false; return null; }
    return [px1[0], px1[1], px1[2]];
  }

  /** Renders the sky with the camera looking at `dir` and returns the centre radiance. */
  function sample(dir, fov = 4) {
    RT.bind(true);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    sky.render(camAt(dir, fov, 1, V3(0, 20, 0)));
    const er = gl.getError();
    if (er) { bad('gl error during sample: 0x' + er.toString(16)); return null; }
    return readCenter();
  }

  sky.setTimeOfDay(12); sky.update(0, 0);
  const probe = sample([0, 1, 0]);
  if (!readOK || !probe) {
    bad('cannot read RGBA16F back (RGBA/FLOAT); results below are unavailable');
    return out;
  }
  note('noon zenith radiance = ' + probe.map((v) => v.toFixed(4)).join(', '));

  /* ---------------- 2. GL state save / restore ---------------- */
  {
    RT.bind(true);
    // A deliberately "hostile" incoming state: additive blending on, depth func GREATER,
    // culling off, depth writes on.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.GREATER);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(true);
    const before = {
      blend: gl.getParameter(gl.BLEND),
      depthFunc: gl.getParameter(gl.DEPTH_FUNC),
      cull: gl.getParameter(gl.CULL_FACE),
      depthMask: gl.getParameter(gl.DEPTH_WRITEMASK),
      viewport: Array.from(gl.getParameter(gl.VIEWPORT)),
      fbo: gl.getParameter(gl.FRAMEBUFFER_BINDING) === RT.framebuffer
    };
    sky.render(camAt([0, 0.2, -1], 60, 1, V3(0, 20, 0)));
    const after = {
      blend: gl.getParameter(gl.BLEND),
      depthFunc: gl.getParameter(gl.DEPTH_FUNC),
      cull: gl.getParameter(gl.CULL_FACE),
      depthMask: gl.getParameter(gl.DEPTH_WRITEMASK),
      viewport: Array.from(gl.getParameter(gl.VIEWPORT)),
      fbo: gl.getParameter(gl.FRAMEBUFFER_BINDING) === RT.framebuffer
    };
    note('state before ' + JSON.stringify(before));
    note('state after  ' + JSON.stringify(after));
    if (before.blend !== after.blend) bad('sky.render() changed BLEND enable ' + before.blend + ' -> ' + after.blend);
    // depthFunc(LEQUAL) is the one piece of state the sky pass asserts (documented in the
    // frame graph); anything else it leaves behind is a leak.
    if (after.depthFunc !== gl.LEQUAL) bad('sky.render() did not leave DEPTH_FUNC at LEQUAL');
    if (before.cull !== after.cull) bad('sky.render() changed CULL_FACE ' + before.cull + ' -> ' + after.cull);
    if (before.depthMask !== after.depthMask) bad('sky.render() changed DEPTH_WRITEMASK ' + before.depthMask + ' -> ' + after.depthMask);
    if (String(before.viewport) !== String(after.viewport)) bad('sky.render() changed the viewport');
    if (!after.fbo) bad('sky.render() changed the bound framebuffer');
    gl.disable(gl.BLEND);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
  }

  /* ---------------- 3. finite / non-negative over a direction grid ------- */
  const hoursGrid = [0, 3, 4.5, 5.0, 5.3, 5.6, 6, 9, 12, 15, 17.5, 18.0, 18.3, 18.6, 19, 20, 22];
  let nonFinite = 0; let negative = 0; let huge = 0;
  const bigW = 96;
  const bigRT = new RenderTarget(gl, bigW, bigW, { colorFormat: 'rgba16f', depth: true, filter: 'nearest' });
  const bigPx = new Float32Array(bigW * bigW * 4);
  const dirs6 = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
  for (const h of hoursGrid) {
    sky.setTimeOfDay(h); sky.update(0.016, 0);
    for (const d of dirs6) {
      bigRT.bind(true);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false); gl.disable(gl.BLEND);
      sky.render(camAt(d, 110, 1, V3(0, 20, 0)));
      gl.readPixels(0, 0, bigW, bigW, gl.RGBA, gl.FLOAT, bigPx);
      for (let i = 0; i < bigPx.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          const v = bigPx[i + c];
          if (!Number.isFinite(v)) nonFinite++;
          else if (v < 0) negative++;
          else if (v > 1e5) huge++;
        }
      }
    }
  }
  note(`direction grid scan: nonFinite=${nonFinite} negative=${negative} huge=${huge}`);
  if (nonFinite) bad(`${nonFinite} non-finite sky samples`);
  if (negative) bad(`${negative} negative sky samples`);

  /* ---------------- 4. horizon / azimuth seam scan ---------------- */
  function seamScan(h, elevDeg) {
    sky.setTimeOfDay(h); sky.update(0, 0);
    const N = 72;
    const vals = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const ce = Math.cos(elevDeg * DEG2RAD);
      const s = sample([Math.sin(a) * ce, Math.sin(elevDeg * DEG2RAD), -Math.cos(a) * ce], 3);
      vals.push(s ? (s[0] + s[1] + s[2]) / 3 : NaN);
    }
    let maxJump = 0; let at = -1;
    for (let i = 0; i < N; i++) {
      const a = vals[i]; const b = vals[(i + 1) % N];
      const j = Math.abs(a - b) / Math.max(1e-5, (a + b) * 0.5);
      if (j > maxJump) { maxJump = j; at = i; }
    }
    return { maxJump, at, mean: vals.reduce((s, v) => s + v, 0) / N };
  }
  for (const [h, el] of [[12, 2], [12, 15], [18.2, 2], [0.5, 2], [0.5, 30]]) {
    const r = seamScan(h, el);
    note(`azimuth seam h=${h} elev=${el}deg: maxRelJump=${r.maxJump.toFixed(3)} @${r.at} mean=${r.mean.toExponential(3)}`);
    if (r.maxJump > 0.6) warn(`possible azimuth seam at h=${h} elev=${el} (rel jump ${r.maxJump.toFixed(2)})`);
  }

  /* elevation sweep across the horizon */
  {
    sky.setTimeOfDay(12); sky.update(0, 0);
    const rows = [];
    for (let e = -6; e <= 6; e += 0.5) {
      const s = sample([0, Math.sin(e * DEG2RAD), -Math.cos(e * DEG2RAD)], 2);
      rows.push([e, s ? (s[0] + s[1] + s[2]) / 3 : NaN]);
    }
    note('noon elevation sweep (deg: mean radiance) ' +
      rows.map(([e, v]) => `${e}:${v.toExponential(2)}`).join(' '));
    let worst = 0; let worstE = 0;
    for (let i = 1; i < rows.length; i++) {
      const j = Math.abs(rows[i][1] - rows[i - 1][1]) / Math.max(1e-5, (rows[i][1] + rows[i - 1][1]) * 0.5);
      if (j > worst) { worst = j; worstE = rows[i][0]; }
    }
    note(`worst 0.5deg elevation step near the horizon: ${worst.toFixed(3)} at ${worstE}deg`);
    if (worst > 1.0) warn(`hard horizon edge at ${worstE}deg (rel jump ${worst.toFixed(2)})`);
  }

  /* ---------------- 5. CPU fogColor vs GPU horizon pixel ---------------- */
  for (const h of [8, 12, 17.5, 18.2, 21]) {
    sky.setTimeOfDay(h); sky.update(0, 0);
    const st = sky.sunDirectionTrue;
    let hx = st[0]; let hz = st[2];
    const hl = Math.hypot(hx, hz) || 1;
    hx /= hl; hz /= hl;
    const dir = norm([hx, 0.045, hz]);
    const g = sample(dir, 2);
    if (!g) continue;
    const f = sky.fogColor;
    const rel = [0, 1, 2].map((i) => Math.abs(g[i] - f[i]) / Math.max(1e-4, Math.max(g[i], f[i])));
    note(`h=${h} fog cpu=[${[...f].map((v) => v.toExponential(2))}] gpu(sun azimuth)=[${g.map((v) => v.toExponential(2))}] rel=[${rel.map((v) => v.toFixed(2))}]`);
    if (Math.max(...rel) > 0.5) warn(`fogColor vs sky mismatch at h=${h}: rel ${Math.max(...rel).toFixed(2)}`);
  }

  /* ---------------- 6. lighting continuity over the clock ---------------- */
  {
    let worstI = 0; let worstIh = 0; let worstD = 0; let worstDh = 0; let worstF = 0; let worstFh = 0;
    let prev = null;
    for (let h = 0; h <= 24.0001; h += 0.01) {
      sky.setTimeOfDay(h); sky.update(0, 0);
      const cur = {
        h,
        rad: [sky.sunColor[0] * sky.sunIntensity, sky.sunColor[1] * sky.sunIntensity, sky.sunColor[2] * sky.sunIntensity],
        dir: [sky.sunDirection[0], sky.sunDirection[1], sky.sunDirection[2]],
        fog: [sky.fogColor[0], sky.fogColor[1], sky.fogColor[2]],
        night: sky.nightFactor, star: sky.starIntensity
      };
      if (prev) {
        const dI = Math.max(...cur.rad.map((v, i) => Math.abs(v - prev.rad[i])));
        if (dI > worstI) { worstI = dI; worstIh = h; }
        // angular jump of the key light, weighted by how strongly it is actually lighting
        const dot = cur.dir[0] * prev.dir[0] + cur.dir[1] * prev.dir[1] + cur.dir[2] * prev.dir[2];
        const ang = Math.acos(Math.max(-1, Math.min(1, dot))) * Math.max(
          Math.max(...cur.rad), Math.max(...prev.rad));
        if (ang > worstD) { worstD = ang; worstDh = h; }
        const dF = Math.max(...cur.fog.map((v, i) => Math.abs(v - prev.fog[i])));
        if (dF > worstF) { worstF = dF; worstFh = h; }
      }
      prev = cur;
    }
    note(`clock sweep (0.01h step): max |d sun radiance|=${worstI.toExponential(2)} @${worstIh.toFixed(2)}h ; ` +
      `max weighted key-dir swing=${worstD.toExponential(2)} rad*rad @${worstDh.toFixed(2)}h ; ` +
      `max |d fogColor|=${worstF.toExponential(2)} @${worstFh.toFixed(2)}h`);
    if (worstD > 0.05) bad(`key light direction swings while it is still lighting the scene at ${worstDh.toFixed(2)}h`);
  }

  /* ---------------- 7. sun / moon discs ---------------- */
  {
    sky.setTimeOfDay(12); sky.update(0, 0);
    const sd = sky.sunDirectionTrue;
    const onSun = sample([sd[0], sd[1], sd[2]], 1.6);
    const offSun = sample([sd[0] + 0.25, sd[1], sd[2]], 3);
    note(`noon sun disc = [${onSun.map((v) => v.toFixed(2))}], 14deg off = [${offSun.map((v) => v.toFixed(3))}]`);
    if (!(onSun[0] > 5 * offSun[0])) bad('sun disc is not visible at noon');

    sky.setTimeOfDay(0.5); sky.update(0, 0);
    const md = sky.moonDirection;
    const onMoon = sample([md[0], md[1], md[2]], 1.6);
    const offMoon = sample([md[0] + 0.3, md[1], md[2]], 3);
    note(`midnight moon disc = [${onMoon.map((v) => v.toFixed(3))}], off = [${offMoon.map((v) => v.toExponential(2))}] moonDir.y=${md[1].toFixed(2)}`);
    if (md[1] > 0.05 && !(onMoon[0] > 3 * offMoon[0])) bad('moon disc is not visible at midnight');
  }

  /* ---------------- 8. runtime param responsiveness ---------------- */
  {
    sky.setTimeOfDay(12); sky.update(0, 0);
    const beforeBeta = sky._betaM;
    const beforeFog = Float32Array.from(sky.fogColor);
    sky.params.turbidity = 5.0;
    sky.update(0.016, 0);          // no clock change -> the doc says params are live
    const afterBeta = sky._betaM;
    const afterFog = Float32Array.from(sky.fogColor);
    note(`turbidity 1 -> 5: betaM ${beforeBeta.toExponential(3)} -> ${afterBeta.toExponential(3)}, ` +
      `fog ${beforeFog[2].toExponential(3)} -> ${afterFog[2].toExponential(3)}`);
    if (Math.abs(afterBeta - beforeBeta) < 1e-9) {
      bad('changing sky.params.turbidity at runtime has no effect (params documented as live)');
    }
    sky.params.turbidity = 1.0;
    sky.setTimeOfDay(12.0001); sky.update(0, 0);
  }

  /* ---------------- 9. per-frame cost / no recompiles ---------------- */
  {
    sky.setTimeOfDay(12); sky.update(0, 0);
    const nShaders = sky._shaders.size;
    const cam = camAt([0, 0.2, -1], 62, 1, V3(0, 20, 0));
    RT.bind(true);
    const t0 = performance.now();
    for (let i = 0; i < 240; i++) {
      sky.setTimeOfDay(12 + i * 0.001);
      sky.update(1 / 60, 0);
      sky.render(cam);
    }
    gl.finish();
    const t1 = performance.now();
    note(`240 update+render: ${(t1 - t0).toFixed(1)} ms total, ${((t1 - t0) / 240).toFixed(3)} ms/frame (33x33 target)`);
    if (sky._shaders.size !== nShaders) bad('sky compiled a new shader inside the frame loop');
    const er = gl.getError();
    if (er) bad('gl error in frame loop: 0x' + er.toString(16));
  }

  /* ---------------- 10. CPU-only update cost ---------------- */
  {
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) { sky.setTimeOfDay(12 + i * 0.0005); sky.update(1 / 60, 0); }
    const t1 = performance.now();
    note(`2000 CPU _recompute: ${(t1 - t0).toFixed(1)} ms => ${((t1 - t0) / 2000 * 1000).toFixed(1)} us/frame`);
  }

  /* ---------------- 11. camera without invProj/invView ---------------- */
  {
    const c = camAt([0, 0.2, -1], 62, 1, V3(0, 20, 0));
    const stripped = { position: c.position, fov: c.fov, view: c.view, proj: c.proj };
    RT.bind(true);
    try { sky.render(stripped); } catch (err) { bad('render() with proj/view only threw: ' + err.message); }
    const v = readCenter();
    note('proj/view-only camera sample = ' + (v ? v.map((x) => x.toExponential(2)).join(',') : 'null'));
    if (!v || !v.every(Number.isFinite) || v[0] + v[1] + v[2] <= 0) bad('render() with only proj/view produced nothing');
  }

  /* ---------------- 12. quality tiers agree ---------------- */
  {
    sky.setTimeOfDay(12); sky.update(0, 0);
    const res = {};
    for (const q of ['low', 'medium', 'high', 'ultra']) {
      sky.setQuality(q);
      const s = sample([0, 0.35, -0.93], 3);
      res[q] = s;
    }
    note('tier zenith-ish radiance: ' + Object.entries(res).map(([k, v]) => `${k}=[${v.map((x) => x.toFixed(4))}]`).join(' '));
    const hi = res.high; const lo = res.low;
    const rel = Math.max(...[0, 1, 2].map((i) => Math.abs(hi[i] - lo[i]) / Math.max(1e-5, hi[i])));
    note('low vs high relative difference: ' + rel.toFixed(3));
    if (rel > 0.25) warn('low tier differs from high by ' + (rel * 100).toFixed(0) + '%');
    sky.setQuality('high');
  }

  /* ---------------- 13. star field sanity ---------------- */
  {
    sky.setTimeOfDay(1.0); sky.update(0, 0);
    // count bright pixels in a patch of sky away from the moon
    const md = sky.moonDirection;
    let dir = [-md[0], 0.6, -md[2]];
    bigRT.bind(true);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false); gl.disable(gl.BLEND);
    sky.render(camAt(dir, 60, 1, V3(0, 20, 0)));
    gl.readPixels(0, 0, bigW, bigW, gl.RGBA, gl.FLOAT, bigPx);
    let n = 0; let sum = 0; let mx = 0;
    for (let i = 0; i < bigPx.length; i += 4) {
      const l = (bigPx[i] + bigPx[i + 1] + bigPx[i + 2]) / 3;
      sum += l; mx = Math.max(mx, l);
      if (l > 0.02) n++;
    }
    const mean = sum / (bigW * bigW);
    note(`night patch (60deg fov, ${bigW}x${bigW}): mean=${mean.toExponential(2)} max=${mx.toExponential(2)} px>0.02: ${n}`);
    if (n === 0) warn('no stars resolved in a 60deg night patch at 96px');
    if (mean <= 0) bad('night sky is pure black');
  }

  sky.dispose();
  RT.dispose(); bigRT.dispose();
  const eEnd = gl.getError();
  if (eEnd) bad('gl error at end: 0x' + eEnd.toString(16));
  return out;
}
