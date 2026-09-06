/**
 * Third-stage particle probe: the real texture library override path + full renderer
 * integration (frame graph position, soft depth handoff, state hygiene).
 * Run: node tools/gl-probe.mjs tools/_tmp/probe-particles3.js
 */
import { createGLContext } from '/js/core/gl.js';
import { ParticleSystem } from '/js/render/particles.js';
import { Renderer, Camera } from '/js/render/renderer.js';
import { buildTextureLibrary } from '/js/render/textures.js';
import { plane, box } from '/js/core/geometry.js';

export default async function run({ canvas }) {
  const out = { errors: [], notes: [], checks: {} };
  const bad = (m) => out.errors.push(m);
  canvas.width = 480; canvas.height = 320;
  const gl = createGLContext(canvas, {});
  if (!gl) { bad('no webgl2'); return out; }

  // ---- library override path -------------------------------------------------------------
  let lib = null;
  try { lib = buildTextureLibrary(gl); } catch (e) { bad('buildTextureLibrary threw: ' + e.message); }
  const ps = new ParticleSystem(gl, null, 2000);
  let e = gl.getError();
  if (e) bad('gl error after ctor 0x' + e.toString(16));
  if (lib) {
    const used = ps.rebuildAtlas(lib);
    out.checks.atlasFromLibrary = used;
    out.checks.atlasSpriteSources = ps.atlas.spriteSources;
    if (!used) bad('texture library sprites were not composited into the atlas');
    e = gl.getError();
    if (e) bad('gl error after rebuildAtlas 0x' + e.toString(16));
  }
  ps.dispose();

  // ---- renderer integration ---------------------------------------------------------------
  let renderer;
  try { renderer = new Renderer(gl, canvas, {}); }
  catch (err) { bad('Renderer ctor threw: ' + err.message); return out; }
  renderer.resize(canvas.width, canvas.height);
  renderer.textures = lib;
  const groundMat = renderer.createMaterial({ albedo: [0.3, 0.3, 0.32], roughness: 0.9 });
  renderer.addStatic(plane(300, 300, 4, 4, [30, 30]), groundMat);
  const wall = box(8, 8, 1);
  for (let i = 1; i < wall.positions.length; i += 3) wall.positions[i] += 4;
  renderer.addStatic(wall, groundMat);
  renderer.setSun({ direction: [-0.4, 0.75, 0.5], color: [1, 0.95, 0.85], intensity: 3.4,
    ambientSky: [0.28, 0.36, 0.5], ambientGround: [0.14, 0.13, 0.11] });
  renderer.setFog({ color: [0.55, 0.65, 0.78], density: 0.0018, heightFalloff: 0.02, skyBlend: 0.7 });

  const cam = new Camera(62, 0.12, 800);
  cam.position[0] = 0; cam.position[1] = 3; cam.position[2] = 18;
  cam.yaw = 0; cam.pitch = -0.05;

  const parts = renderer.particles;
  if (!parts) { bad('renderer.particles missing'); return out; }
  out.checks.budgetFromQuality = parts.capacity;

  const px = new Uint8Array(canvas.width * canvas.height * 4);
  const sample = () => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let s = 0;
    for (let i = 0; i < px.length; i += 4) s += px[i] + px[i + 1] + px[i + 2];
    return +(s / (px.length / 4) / 3).toFixed(2);
  };

  // a frame with no particles, then the same frame with a plume, to prove they reach the screen
  renderer.render(cam, 1 / 60);
  const empty = sample();
  const base = px.slice();
  parts.burst('smoke', 0, 2, 4, 120, { size: 0.9, life: 5 });
  parts.burst('fire', 1.5, 1.5, 4, 40, { power: 2 });
  for (let f = 0; f < 30; f++) { parts.update(1 / 60, cam); renderer.render(cam, 1 / 60); }
  const withParts = sample();
  let changed = 0; let peak = 0;
  for (let i = 0; i < px.length; i += 4) {
    const d = Math.abs(px[i] - base[i]) + Math.abs(px[i + 1] - base[i + 1]) + Math.abs(px[i + 2] - base[i + 2]);
    if (d > 12) changed++;
    if (d > peak) peak = d;
  }
  out.checks.frameLuma = { empty, withParts,
    changedPixels: +(changed / (px.length / 4)).toFixed(4), peakDelta: peak };
  if (changed / (px.length / 4) < 0.02) bad('particles barely reach the final image: ' + changed + ' px');
  out.checks.particleStats = JSON.parse(JSON.stringify(parts.stats));
  if (parts.stats.drawCalls === 0) bad('particle pass issued no draw calls');
  if (parts.stats.depthMode !== 0) out.notes.push('soft-particle depthMode=' + parts.stats.depthMode);

  // GL state after a full renderer frame must still be the context baseline
  out.checks.postFrameState = {
    blend: gl.getParameter(gl.BLEND),
    blendSrcRGB: gl.getParameter(gl.BLEND_SRC_RGB),
    blendDstRGB: gl.getParameter(gl.BLEND_DST_RGB),
    depthMask: gl.getParameter(gl.DEPTH_WRITEMASK),
    cull: gl.getParameter(gl.CULL_FACE),
    depthTest: gl.getParameter(gl.DEPTH_TEST)
  };
  e = gl.getError();
  out.checks.finalGLError = e ? '0x' + e.toString(16) : 0;
  if (e) bad('gl error after renderer frames 0x' + e.toString(16));
  return out;
}
