/**
 * Headless probe for js/render/sky.js — verifies the atmospheric model produces a believable
 * progression through the day (blue noon, warm sunset, dark starry night) with no GL errors.
 *
 * Run: node tools/gl-probe.mjs tools/probe-sky.js
 */
import { createGLContext } from '/js/core/gl.js';
import { mat4, DEG2RAD } from '/js/core/math.js';
import { Sky } from '/js/render/sky.js';

/**
 * Stand-in camera with REAL matrices, so this probe works before renderer.js is importable.
 * Uses the project's yaw/pitch convention: forward = [-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch)].
 */
function makeCamera(aspect) {
  const position = new Float32Array([0, 20, 0]);
  const yaw = 0;
  const pitch = 0.18;
  const cp = Math.cos(pitch);
  const forward = new Float32Array([-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp]);
  const target = [position[0] + forward[0], position[1] + forward[1], position[2] + forward[2]];
  const view = mat4.lookAt(mat4.create(), position, target, [0, 1, 0]);
  const proj = mat4.perspective(mat4.create(), 62 * DEG2RAD, aspect, 0.1, 4000);
  const viewProj = mat4.multiply(mat4.create(), proj, view);
  return {
    position, yaw, pitch, fov: 62, near: 0.1, far: 4000,
    view, proj, viewProj,
    invView: mat4.invert(mat4.create(), view),
    invProj: mat4.invert(mat4.create(), proj),
    forward, right: new Float32Array([1, 0, 0]), up: new Float32Array([0, 1, 0]),
  };
}

export default async function run({ canvas }) {
  const out = { errors: [], notes: [] };
  const bad = (m) => out.errors.push(m);
  canvas.width = 480; canvas.height = 270;
  const gl = createGLContext(canvas, {});
  if (!gl) { bad('no webgl2'); return out; }

  let CameraCls = null;
  try { CameraCls = (await import('/js/render/renderer.js')).Camera; } catch { /* not ready yet */ }

  const aspect = canvas.width / canvas.height;
  const cam = CameraCls ? new CameraCls(62, 0.1, 4000) : makeCamera(aspect);
  if (CameraCls) { cam.position[1] = 20; cam.pitch = 0.18; cam.update(aspect); }
  else { out.notes.push('renderer.js not importable yet — using a stand-in camera with real matrices'); }

  let sky;
  try { sky = new Sky(gl, { quality: { name: 'high' }, hdr: { width: canvas.width, height: canvas.height } }); }
  catch (e) { bad('Sky ctor threw: ' + e.message + '\n' + (e.stack || '')); return out; }

  const readSky = (h) => {
    sky.setTimeOfDay(h);
    sky.update(0.016, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    try { sky.render(cam); } catch (e) { bad(`sky.render(${h}) threw: ${e.message}`); return null; }
    const e = gl.getError();
    if (e) { bad(`gl error 0x${e.toString(16)} at hour ${h}`); return null; }
    const band = (y0, y1) => {
      const h2 = y1 - y0;
      const px = new Uint8Array(canvas.width * h2 * 4);
      gl.readPixels(0, y0, canvas.width, h2, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let r = 0; let g = 0; let b = 0; let mx = 0; let bright = 0;
      for (let i = 0; i < px.length; i += 4) {
        r += px[i]; g += px[i + 1]; b += px[i + 2];
        const l = px[i] + px[i + 1] + px[i + 2];
        mx = Math.max(mx, l);
        if (l > 210) bright++;
      }
      const n = px.length / 4;
      return { r: r / n, g: g / n, b: b / n, luma: (r + g + b) / (3 * n), max: mx / 3, bright };
    };
    return { zenith: band(canvas.height - 40, canvas.height - 5), horizon: band(10, 50) };
  };

  const hours = [0.5, 4.8, 5.4, 6.0, 8, 12, 16, 17.2, 17.8, 18.2, 18.6, 19.2, 21];
  const data = {};
  for (const h of hours) {
    const r = readSky(h);
    if (!r) continue;
    data[h] = r;
    out.notes.push(`h=${h}: zenith ${r.zenith.r.toFixed(0)}/${r.zenith.g.toFixed(0)}/${r.zenith.b.toFixed(0)} (luma ${r.zenith.luma.toFixed(1)}) | horizon ${r.horizon.r.toFixed(0)}/${r.horizon.g.toFixed(0)}/${r.horizon.b.toFixed(0)} (luma ${r.horizon.luma.toFixed(1)}) | sunI=${sky.sunIntensity.toFixed(2)} night=${sky.nightFactor.toFixed(2)} stars=${(sky.starIntensity ?? 0).toFixed(2)} brightPx=${r.zenith.bright}`);
  }

  if (data[12]) {
    if (!(data[12].zenith.b > data[12].zenith.r + 8)) bad(`noon zenith is not blue: ${JSON.stringify(data[12].zenith)}`);
    if (!(data[12].zenith.luma < data[12].horizon.luma + 60)) out.notes.push('note: noon zenith vs horizon contrast is mild');
  }
  const sunsetHour = [17.2, 17.8, 18.2, 18.6].reduce((best, h) => (
    data[h] && (!data[best] || (data[h].horizon.r - data[h].horizon.b) > (data[best].horizon.r - data[best].horizon.b)) ? h : best), 17.2);
  out.notes.push(`warmest evening hour sampled: ${sunsetHour}`);
  if (data[sunsetHour] && data[12]) {
    const warm = data[sunsetHour].horizon.r - data[sunsetHour].horizon.b;
    const noonWarm = data[12].horizon.r - data[12].horizon.b;
    out.notes.push(`horizon warmth: sunset ${warm.toFixed(1)} vs noon ${noonWarm.toFixed(1)}`);
    if (!(warm > noonWarm + 10)) bad('sunset horizon is not measurably warmer than midday');
  }
  if (data[0.5] && data[12]) {
    if (!(data[0.5].zenith.luma < data[12].zenith.luma * 0.5)) bad(`night sky is not much darker than day (${data[0.5].zenith.luma.toFixed(1)} vs ${data[12].zenith.luma.toFixed(1)})`);
    if (data[0.5].zenith.luma < 0.4) bad('night sky is pure black');
    if (!(data[0.5].zenith.bright > 0)) bad('no visible stars at night');
  }
  if (sky.fogColor && !(sky.fogColor.every ? sky.fogColor.every(Number.isFinite) : true)) bad('fogColor is not finite');
  for (const k of ['sunDirection', 'sunColor', 'ambientSky', 'ambientGround', 'fogColor', 'moonDirection']) {
    const v = sky[k];
    if (!v || ![v[0], v[1], v[2]].every(Number.isFinite)) bad(`sky.${k} is missing or non-finite`);
  }

  // sun elevation must actually track the clock
  // sky.sunDirection is the KEY light (it crossfades to the moon at night), so the true solar
  // elevation lives on sunDirectionTrue.
  sky.setTimeOfDay(12); sky.update(0.016, 0);
  const noonY = (sky.sunDirectionTrue || sky.sunDirection)[1];
  const noonKey = sky.sunDirection[1];
  sky.setTimeOfDay(0); sky.update(0.016, 0);
  const midnightY = (sky.sunDirectionTrue || sky.sunDirection)[1];
  const midnightKey = sky.sunDirection[1];
  out.notes.push(`true sun.y noon=${noonY.toFixed(2)} midnight=${midnightY.toFixed(2)}; key light y noon=${noonKey.toFixed(2)} midnight=${midnightKey.toFixed(2)}`);
  if (!(noonY > 0 && midnightY < 0)) bad('true sun elevation does not invert between noon and midnight');
  if (!(midnightKey > 0)) bad('the night key light (moon) is below the horizon at midnight');
  return out;
}
