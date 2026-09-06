/**
 * Headless probe for the render stack: Renderer + Camera + materials + Sky.
 *
 * Builds a small scene (ground, instanced boxes, a dynamic mesh, a sun and point lights), renders
 * frames, and asserts there are no GL errors, that shadows actually darken pixels, and that the
 * sky progresses believably through the day.
 *
 * Run: node tools/gl-probe.mjs tools/probe-render.js
 */
import { createGLContext } from '/js/core/gl.js';
import { Renderer, Camera } from '/js/render/renderer.js';
import { box, plane, sphere } from '/js/core/geometry.js';

const sample = (gl, x, y, w, h) => {
  const px = new Uint8Array(w * h * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let r = 0; let g = 0; let b = 0;
  const uniq = new Set();
  for (let i = 0; i < px.length; i += 4) {
    r += px[i]; g += px[i + 1]; b += px[i + 2];
    uniq.add(px[i] >> 3 << 10 | px[i + 1] >> 3 << 5 | px[i + 2] >> 3);
  }
  const n = px.length / 4;
  return { r: r / n, g: g / n, b: b / n, luma: (r + g + b) / (3 * n), uniq: uniq.size };
};

export default async function run({ canvas }) {
  const out = { errors: [], notes: [] };
  const bad = (m) => out.errors.push(m);
  canvas.width = 640; canvas.height = 360;

  const gl = createGLContext(canvas, {});
  if (!gl) { bad('no webgl2'); return out; }

  let renderer;
  try { renderer = new Renderer(gl, canvas, {}); }
  catch (e) { bad('Renderer ctor threw: ' + e.message + '\n' + (e.stack || '')); return out; }
  renderer.resize(canvas.width, canvas.height);
  out.notes.push('quality: ' + JSON.stringify(renderer.quality));

  const err = (tag) => { const e = gl.getError(); if (e) bad(`${tag}: gl error 0x${e.toString(16)}`); };

  // --- materials + geometry --------------------------------------------------------------
  const groundMat = renderer.createMaterial({ albedo: [0.28, 0.29, 0.31], roughness: 0.92, name: 'ground' });
  const boxMat = renderer.createMaterial({ albedo: [0.75, 0.35, 0.2], roughness: 0.55, metallic: 0.05, name: 'box' });
  const dynMat = renderer.createMaterial({ albedo: [0.2, 0.6, 0.9], roughness: 0.3, metallic: 0.6, name: 'dyn' });
  const emitMat = renderer.createMaterial({ albedo: [0, 0, 0], emissive: [1.0, 0.6, 0.2], emissiveStrength: 6, name: 'emit' });

  try {
    renderer.addStatic(plane(200, 200, 8, 8, [40, 40]), groundMat);
  } catch (e) { bad('addStatic threw: ' + e.message); }
  err('addStatic');

  // A tall pillar to cast a shadow across the ground.
  try {
    const pillar = box(2, 14, 2);
    for (let i = 0; i < pillar.positions.length; i += 3) pillar.positions[i + 1] += 7;
    renderer.addStatic(pillar, boxMat);
  } catch (e) { bad('pillar addStatic threw: ' + e.message); }

  let batch;
  try {
    batch = renderer.addInstanced(box(1.4, 3, 1.4), boxMat, 256);
    const m = new Float32Array(16);
    for (let i = 0; i < 200; i++) {
      m.fill(0); m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
      m[12] = ((i % 20) - 10) * 5; m[13] = 1.5; m[14] = (((i / 20) | 0) - 5) * 6 - 20;
      batch.setInstance(i, m, [0.6 + (i % 5) * 0.08, 0.5, 0.4, 1]);
    }
    batch.setCount(200);
    batch.upload();
  } catch (e) { bad('addInstanced threw: ' + e.message + '\n' + (e.stack || '')); }
  err('addInstanced');

  const dynMesh = renderer.createMesh(sphere(1.2, 20, 14));
  const emitMesh = renderer.createMesh(box(0.4, 0.4, 0.4));

  const cam = new Camera(62, 0.12, 800);
  cam.position[0] = 0; cam.position[1] = 6; cam.position[2] = 26;
  cam.yaw = 0; cam.pitch = -0.14;

  // NOTE: `direction` points FROM the world TOWARD the light (see render/sky.js).
  const sun = { direction: [-0.4, 0.75, 0.5], color: [1, 0.95, 0.85], intensity: 3.4,
    ambientSky: [0.28, 0.36, 0.5], ambientGround: [0.14, 0.13, 0.11] };
  renderer.setSun(sun);
  renderer.setFog({ color: [0.55, 0.65, 0.78], density: 0.0018, heightFalloff: 0.02 });

  const M = new Float32Array(16);
  const ident = () => { M.fill(0); M[0] = 1; M[5] = 1; M[10] = 1; M[15] = 1; return M; };

  // --- render loop ----------------------------------------------------------------------
  const t0 = performance.now();
  for (let f = 0; f < 20; f++) {
    ident(); M[12] = Math.sin(f * 0.2) * 4; M[13] = 2.0; M[14] = 4;
    renderer.submit(dynMesh, dynMat, M);
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2 + f * 0.02;
      const x = Math.cos(a) * 16; const z = Math.sin(a) * 16 - 10;
      ident(); M[12] = x; M[13] = 2.4; M[14] = z;
      renderer.submit(emitMesh, emitMat, M);
      renderer.submitLight(x, 2.4, z, 1.0, 0.55, 0.2, 12, 4.0);
    }
    if (renderer.sky) { renderer.sky.setTimeOfDay(13); renderer.sky.update(1 / 60, 0); }
    cam.update(canvas.width / canvas.height);
    renderer.render(cam, 1 / 60);
    const e = gl.getError();
    if (e) { bad(`gl error 0x${e.toString(16)} on frame ${f}`); break; }
  }
  const ms = (performance.now() - t0) / 20;
  out.notes.push(`20 frames, ${ms.toFixed(1)} ms/frame (SwiftShader software rasteriser)`);
  out.notes.push('stats: ' + JSON.stringify(renderer.stats));
  if ((renderer.stats.drawCalls | 0) < 3) bad(`only ${renderer.stats.drawCalls} draw calls`);
  if ((renderer.stats.triangles | 0) < 1000) bad(`only ${renderer.stats.triangles} triangles`);

  const centre = sample(gl, 300, 160, 40, 40);
  out.notes.push('centre sample: ' + JSON.stringify(centre));
  if (centre.uniq < 8) bad('rendered frame looks flat/blank');

  // --- shadow check: same ground spot with the sun on vs a sun aimed elsewhere --------------
  // Look straight down at empty ground so nothing occludes the sample, and kill ambient so the
  // measurement isolates the sun's direct contribution.
  const darkAmbient = { ambientSky: [0.01, 0.01, 0.01], ambientGround: [0.01, 0.01, 0.01] };
  const groundProbe = (intensity) => {
    renderer.setSun({ ...sun, ...darkAmbient, direction: [0, 1, 0], intensity });
    cam.position[0] = 60; cam.position[1] = 14; cam.position[2] = 60; // empty ground inside the 200x200 plane
    cam.pitch = -0.85; cam.yaw = 0.6;
    cam.update(canvas.width / canvas.height);
    renderer.render(cam, 1 / 60);
    return sample(gl, 300, 150, 40, 40).luma;
  };
  const noSun = groundProbe(0.0);
  const withSun = groundProbe(3.4);
  cam.position[0] = 0; cam.position[1] = 6; cam.position[2] = 26; cam.pitch = -0.14; cam.yaw = 0;
  renderer.setSun(sun);
  out.notes.push(`unoccluded ground luma: sun=${withSun.toFixed(1)} noSun=${noSun.toFixed(1)}`);
  if (!(withSun > noSun + 20)) bad(`sun light barely affects lit ground (${withSun.toFixed(1)} vs ${noSun.toFixed(1)})`);

  // Shadow test: a tall pillar stands at the origin; compare ground luma inside vs outside its shadow.
  // Light from +X so the pillar's shadow falls along -X, beside the pillar rather than behind it
  // (a sample directly behind it would read the sunlit pillar face instead of the ground).
  renderer.setSun({ ...sun, direction: [0.57, 0.82, 0.0], intensity: 3.4 });
  cam.position[0] = 0; cam.position[1] = 9; cam.position[2] = 22; cam.pitch = -0.42; cam.yaw = 0;
  cam.update(canvas.width / canvas.height);
  renderer.render(cam, 1 / 60);
  // The pillar is 14 m tall at the origin; with the sun at (0.57, 0.82, 0) its shadow falls along
  // -X. Project a shadowed point and a lit point to get exact screen coordinates.
  const proj = (x, y, z) => {
    const o = [0, 0, 0];
    if (typeof cam.worldToScreen === 'function' && cam.worldToScreen([x, y, z], o, canvas.width, canvas.height)) {
      // readPixels is bottom-up; worldToScreen is top-down.
      return [Math.round(o[0]) - 8, canvas.height - Math.round(o[1]) - 8];
    }
    return null;
  };
  const shadowPt = proj(-7, 0.02, 0);
  const litPt = proj(9, 0.02, 0);
  if (shadowPt && litPt) {
    const inShadow = sample(gl, Math.max(0, shadowPt[0]), Math.max(0, shadowPt[1]), 16, 16).luma;
    const outShadow = sample(gl, Math.max(0, litPt[0]), Math.max(0, litPt[1]), 16, 16).luma;
    out.notes.push(`shadow test @${shadowPt} vs @${litPt}: shadow=${inShadow.toFixed(1)} lit=${outShadow.toFixed(1)}`);
    if (!(outShadow > inShadow + 6)) bad(`cascaded shadow does not darken the ground (shadow ${inShadow.toFixed(1)} vs lit ${outShadow.toFixed(1)})`);
  } else out.notes.push('camera.worldToScreen unavailable — shadow sampling skipped');
  renderer.setSun(sun);

  // --- sky progression -----------------------------------------------------------------------
  if (renderer.sky) {
    const readings = {};
    for (const h of [1, 5.4, 8, 12, 18.2, 21]) {
      renderer.sky.setTimeOfDay(h);
      renderer.sky.update(0.016, 0);
      renderer.setSun({
        direction: renderer.sky.sunDirection, color: renderer.sky.sunColor,
        intensity: renderer.sky.sunIntensity, ambientSky: renderer.sky.ambientSky,
        ambientGround: renderer.sky.ambientGround,
      });
      // Pitch up slightly and read the band just above the horizon line.
      cam.position[1] = 40; cam.pitch = 0.10; cam.yaw = 0;
      cam.update(canvas.width / canvas.height);
      renderer.render(cam, 1 / 60);
      readings[h] = sample(gl, 200, 196, 240, 26);
    }
    out.notes.push('sky by hour: ' + JSON.stringify(Object.fromEntries(
      Object.entries(readings).map(([k, v]) => [k, `${v.r.toFixed(0)}/${v.g.toFixed(0)}/${v.b.toFixed(0)} luma ${v.luma.toFixed(0)}`]))));
    if (!(readings[12].luma > readings[1].luma + 15)) bad(`noon sky is not brighter than night (${readings[12].luma.toFixed(0)} vs ${readings[1].luma.toFixed(0)})`);
    if (!(readings[12].b > readings[12].r)) bad('midday sky is not blue (B <= R)');
    const sunsetWarmth = readings[18.2].r - readings[18.2].b;
    const noonWarmth = readings[12].r - readings[12].b;
    out.notes.push(`horizon warmth: sunset ${sunsetWarmth.toFixed(1)} vs noon ${noonWarmth.toFixed(1)}`);
    if (!(sunsetWarmth > noonWarmth + 8)) bad(`sunset horizon is not warmer than midday (${sunsetWarmth.toFixed(1)} vs ${noonWarmth.toFixed(1)})`);
    if (readings[1].luma > 90) bad(`night sky is too bright (luma ${readings[1].luma.toFixed(0)})`);
    err('sky');
  } else bad('renderer.sky is missing');

  // --- quality switching -------------------------------------------------------------------------
  for (const q of ['low', 'medium', 'high', 'ultra']) {
    try {
      renderer.setQuality(q);
      cam.update(canvas.width / canvas.height);
      renderer.render(cam, 1 / 60);
      const e = gl.getError();
      if (e) bad(`gl error 0x${e.toString(16)} at quality ${q}`);
    } catch (e) { bad(`setQuality(${q}) threw: ${e.message}`); }
  }
  out.notes.push('quality switching ok');

  renderer.resize(800, 450);
  cam.update(800 / 450);
  renderer.render(cam, 1 / 60);
  err('resize');

  return out;
}
