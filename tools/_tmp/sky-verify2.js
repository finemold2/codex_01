/**
 * Focused CPU-vs-GPU consistency + seam probe for js/render/sky.js.
 * Run: node tools/gl-probe.mjs tools/_tmp/sky-verify2.js
 */
import { createGLContext, RenderTarget } from '/js/core/gl.js';
import { mat4, DEG2RAD } from '/js/core/math.js';
import { Sky } from '/js/render/sky.js';

const V3 = (x, y, z) => new Float32Array([x, y, z]);
function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return V3(v[0] / l, v[1] / l, v[2] / l); }
function camAt(dir, fovDeg, pos) {
  const d = norm(dir);
  const up = Math.abs(d[1]) > 0.98 ? [0, 0, -Math.sign(d[1] || 1)] : [0, 1, 0];
  const p = pos || V3(0, 20, 0);
  const view = mat4.lookAt(mat4.create(), p, [p[0] + d[0], p[1] + d[1], p[2] + d[2]], up);
  const proj = mat4.perspective(mat4.create(), fovDeg * DEG2RAD, 1, 0.1, 4000);
  return { position: p, fov: fovDeg, near: 0.1, far: 4000, view, proj,
    viewProj: mat4.multiply(mat4.create(), proj, view),
    invView: mat4.invert(mat4.create(), view), invProj: mat4.invert(mat4.create(), proj) };
}

export default async function run({ canvas }) {
  const out = { errors: [], warns: [], notes: [] };
  const bad = (m) => out.errors.push(m);
  const note = (m) => out.notes.push(m);
  canvas.width = 128; canvas.height = 128;
  const gl = createGLContext(canvas, {});
  if (!gl) { bad('no webgl2'); return out; }
  const sky = new Sky(gl, { quality: { name: 'high' }, hdr: { width: 128, height: 128 } });
  const RT = new RenderTarget(gl, 33, 33, { colorFormat: 'rgba16f', depth: true, filter: 'nearest' });
  const px1 = new Float32Array(4);

  /** Renders the sky in `dir` and returns the centre radiance. */
  function sample(dir, fov = 2) {
    RT.bind(true);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false); gl.disable(gl.BLEND);
    sky.render(camAt(dir, fov));
    gl.readPixels(16, 16, 1, 1, gl.RGBA, gl.FLOAT, px1);
    return [px1[0], px1[1], px1[2]];
  }
  /** Removes everything the CPU mirror does not model: clouds, stars, sun/moon discs. */
  function quiet() {
    sky.starIntensity = 0;
    sky.params.cloudiness = 0;          // coverage threshold 0.71 -> effectively clear
    sky.params.cirrus = 0;
  }

  const W = [0.34, 0.22, 0.22, 0.22];
  const hours = [7, 8, 10, 12, 14, 16, 17, 17.5, 18, 18.3, 19, 21, 0.5, 3];

  note('--- fogColor (CPU, weighted azimuth avg at 2.58deg) vs the same weighted avg read off the GPU ---');
  let worstRel = 0; let worstH = 0;
  for (const h of hours) {
    sky.setTimeOfDay(h); sky.update(0, 0); quiet();
    const st = sky.sunDirectionTrue;
    let hx = st[0]; let hz = st[2];
    const hl = Math.hypot(hx, hz) || 1; hx /= hl; hz /= hl;
    const hy = 0.045; const inv = 1 / Math.sqrt(1 + hy * hy);
    const avg = [0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI * 0.5; const ca = Math.cos(a); const sa = Math.sin(a);
      const s = sample([(hx * ca - hz * sa) * inv, hy * inv, (hx * sa + hz * ca) * inv], 1.5);
      for (let i = 0; i < 3; i++) avg[i] += s[i] * W[k];
    }
    const f = sky.fogColor;
    const rel = [0, 1, 2].map((i) => (avg[i] - f[i]) / Math.max(1e-5, f[i]));
    const m = Math.max(...rel.map(Math.abs));
    if (m > worstRel) { worstRel = m; worstH = h; }
    note(`h=${h}: cpuFog=[${[...f].map((v) => v.toFixed(4))}] gpuAvg=[${avg.map((v) => v.toFixed(4))}] relErr=[${rel.map((v) => (v * 100).toFixed(0) + '%')}]`);
  }
  note(`worst fog CPU/GPU relative error: ${(worstRel * 100).toFixed(0)}% at h=${worstH}`);
  if (worstRel > 0.25) bad(`fogColor does not match what the sky shader paints (worst ${(worstRel * 100).toFixed(0)}% at h=${worstH}h)`);

  note('--- zenith: CPU zenithColor vs GPU straight up ---');
  for (const h of [8, 12, 17.5, 18.3, 0.5]) {
    sky.setTimeOfDay(h); sky.update(0, 0); quiet();
    const g = sample([0, 1, 0], 1.5);
    const z = sky.zenithColor;
    const rel = [0, 1, 2].map((i) => (g[i] - z[i]) / Math.max(1e-5, z[i]));
    note(`h=${h}: cpuZenith=[${[...z].map((v) => v.toFixed(4))}] gpu=[${g.map((v) => v.toFixed(4))}] relErr=[${rel.map((v) => (v * 100).toFixed(0) + '%')}]`);
  }

  note('--- step-count convergence at low elevation (clouds/stars off) ---');
  for (const el of [2.58, 6, 20, 89]) {
    sky.setTimeOfDay(17.5); sky.update(0, 0); quiet();
    const st = sky.sunDirectionTrue;
    let hx = st[0]; let hz = st[2]; const hl = Math.hypot(hx, hz) || 1; hx /= hl; hz /= hl;
    const ce = Math.cos(el * DEG2RAD); const se = Math.sin(el * DEG2RAD);
    const d = [hx * ce, se, hz * ce];
    const r = {};
    for (const q of ['low', 'medium', 'high', 'ultra']) { sky.setQuality(q); r[q] = sample(d, 1.5); }
    sky.setQuality('high');
    note(`elev ${el}deg toward the sun: ` + Object.entries(r).map(([k, v]) => `${k}=${v[1].toFixed(4)}`).join(' ') +
      ` (4/6/8/10 steps; ultra-vs-low ${(((r.ultra[1] - r.low[1]) / r.ultra[1]) * 100).toFixed(1)}%)`);
  }

  note('--- azimuth seam scan with clouds + stars disabled ---');
  for (const [h, el] of [[12, 15], [12, 40], [0.5, 30], [18.2, 10]]) {
    sky.setTimeOfDay(h); sky.update(0, 0); quiet();
    const N = 144; const vals = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2; const ce = Math.cos(el * DEG2RAD);
      const s = sample([Math.sin(a) * ce, Math.sin(el * DEG2RAD), -Math.cos(a) * ce], 1.2);
      vals.push((s[0] + s[1] + s[2]) / 3);
    }
    let mx = 0; let at = 0; let sum = 0;
    for (let i = 0; i < N; i++) {
      const j = Math.abs(vals[i] - vals[(i + 1) % N]) / Math.max(1e-6, (vals[i] + vals[(i + 1) % N]) * 0.5);
      sum += j; if (j > mx) { mx = j; at = i; }
    }
    note(`h=${h} elev=${el}: max neighbour jump ${(mx * 100).toFixed(2)}% @az${(at / N * 360).toFixed(0)}deg, mean ${(sum / N * 100).toFixed(3)}%`);
    if (mx > 0.08) bad(`azimuth discontinuity in the clear sky at h=${h} elev=${el} (${(mx * 100).toFixed(1)}%)`);
  }

  note('--- below/above horizon step (ground stand-in vs fog) ---');
  for (const h of [12, 18.2, 0.5]) {
    sky.setTimeOfDay(h); sky.update(0, 0); quiet();
    const rows = [];
    for (const el of [-8, -4, -2, -1, -0.5, -0.2, 0.2, 0.5, 1, 2, 4]) {
      const s = sample([0, Math.sin(el * DEG2RAD), -Math.cos(el * DEG2RAD)], 1.2);
      rows.push([el, (s[0] + s[1] + s[2]) / 3]);
    }
    const f = sky.fogColor; const fm = (f[0] + f[1] + f[2]) / 3;
    note(`h=${h} fogMean=${fm.toFixed(4)} | ` + rows.map(([e, v]) => `${e}:${v.toFixed(4)}`).join(' '));
    const below = rows.find((r) => r[0] === -0.5)[1];
    const above = rows.find((r) => r[0] === 0.2)[1];
    note(`  step across the horizon: ${(Math.abs(above - below) / Math.max(above, below) * 100).toFixed(0)}% ; ` +
      `ground-vs-fog at -4deg: ${((rows.find((r) => r[0] === -4)[1] - fm) / fm * 100).toFixed(0)}%`);
  }

  sky.dispose(); RT.dispose();
  const e = gl.getError();
  if (e) bad('gl error at end 0x' + e.toString(16));
  return out;
}
