/**
 * Headless probe for js/render/textures.js — verifies the procedural texture library actually
 * produces varied, non-flat, seamless-ish images with the expected emissive window masks.
 *
 * Run: node tools/gl-probe.mjs tools/probe-textures.js
 */
import { createGLContext } from '/js/core/gl.js';
import { buildTextureLibrary, makeNoiseCanvas, normalMapFromHeight } from '/js/render/textures.js';

const REQUIRED = ['asphalt', 'roadLines', 'sidewalk', 'concrete', 'brick', 'glassFacade',
  'officeFacade', 'apartmentFacade', 'metal', 'roofGravel', 'grass', 'dirt', 'sand', 'water',
  'treeBark', 'leaves', 'tire', 'chrome', 'smoke', 'spark', 'flash', 'blood', 'raindrop',
  'muzzle', 'decalBulletHole', 'noiseBlue', 'gradientRamp'];

function analyse(canvas) {
  const w = canvas.width; const h = canvas.height;
  const ctx = canvas.getContext('2d');
  const d = ctx.getImageData(0, 0, w, h).data;
  let sr = 0; let sg = 0; let sb = 0; let sa = 0;
  let mn = 255; let mx = 0;
  const uniq = new Set();
  for (let i = 0; i < d.length; i += 4) {
    sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; sa += d[i + 3];
    const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
    if (l < mn) mn = l;
    if (l > mx) mx = l;
    uniq.add(d[i] >> 4 << 8 | d[i + 1] >> 4 << 4 | d[i + 2] >> 4);
  }
  const n = d.length / 4;
  // seam error: compare column 0 vs column w-1 and row 0 vs row h-1
  let seam = 0;
  for (let y = 0; y < h; y++) {
    const a = (y * w) * 4; const b = (y * w + w - 1) * 4;
    seam += Math.abs(d[a] - d[b]) + Math.abs(d[a + 1] - d[b + 1]) + Math.abs(d[a + 2] - d[b + 2]);
  }
  for (let x = 0; x < w; x++) {
    const a = x * 4; const b = ((h - 1) * w + x) * 4;
    seam += Math.abs(d[a] - d[b]) + Math.abs(d[a + 1] - d[b + 1]) + Math.abs(d[a + 2] - d[b + 2]);
  }
  return {
    w, h, r: sr / n, g: sg / n, b: sb / n, a: sa / n,
    contrast: mx - mn, uniq: uniq.size, seam: seam / ((w + h) * 3),
  };
}

export default async function run({ canvas }) {
  const out = { errors: [], notes: [], flat: [], seamy: [] };
  const bad = (m) => out.errors.push(m);
  const gl = createGLContext(canvas, {});
  if (!gl) { bad('no webgl2'); return out; }

  let lib;
  const t0 = performance.now();
  try { lib = buildTextureLibrary(gl, { size: 512 }); }
  catch (e) { bad('buildTextureLibrary threw: ' + e.message + '\n' + (e.stack || '')); return out; }
  const ms = performance.now() - t0;
  out.notes.push(`buildTextureLibrary(512): ${ms.toFixed(0)} ms`);
  if (ms > 4000) bad(`texture generation is too slow: ${ms.toFixed(0)} ms`);
  if (gl.getError()) bad('GL error after building textures');

  const missing = REQUIRED.filter((k) => !lib[k]);
  if (missing.length) bad('missing textures: ' + missing.join(', '));
  out.notes.push(`library keys: ${Object.keys(lib).filter((k) => typeof lib[k] === 'object' && lib[k]).length}`);
  if (lib.stats) out.notes.push('stats: ' + JSON.stringify(lib.stats));

  const canvases = lib.canvases || {};
  const names = Object.keys(canvases);
  out.notes.push(`inspectable canvases: ${names.length}`);
  if (!names.length) {
    out.notes.push('no lib.canvases exposed — skipping pixel analysis');
    return out;
  }

  const tiling = new Set(['asphalt', 'sidewalk', 'concrete', 'brick', 'metal', 'roofGravel',
    'grass', 'dirt', 'sand', 'treeBark', 'glassFacade', 'officeFacade', 'apartmentFacade',
    'tileFloor', 'noiseBlue']);

  for (const name of names) {
    const c = canvases[name];
    if (!c || !c.width) continue;
    let a;
    try { a = analyse(c); } catch (e) { bad(`analyse(${name}) threw: ${e.message}`); continue; }
    if (a.contrast < 6 || a.uniq < 6) out.flat.push(`${name} (contrast ${a.contrast.toFixed(0)}, ${a.uniq} colours)`);
    if (tiling.has(name) && a.seam > 26) out.seamy.push(`${name} (seam err ${a.seam.toFixed(1)})`);
    if (/Facade/.test(name)) {
      out.notes.push(`${name}: mean alpha ${a.a.toFixed(1)} (window mask), contrast ${a.contrast.toFixed(0)}`);
      if (a.a > 250 || a.a < 3) bad(`${name} alpha channel carries no window mask (mean ${a.a.toFixed(1)})`);
    }
  }
  if (out.flat.length) bad(`flat/uniform textures: ${out.flat.join('; ')}`);
  if (out.seamy.length) out.notes.push(`possible seams: ${out.seamy.join('; ')}`);

  // helpers
  try {
    const n = makeNoiseCanvas(64, 64, {});
    const an = analyse(n);
    out.notes.push(`makeNoiseCanvas: contrast ${an.contrast.toFixed(0)}, ${an.uniq} colours`);
    if (an.contrast < 20) bad('makeNoiseCanvas produced a nearly flat image');
    const nm = normalMapFromHeight(n, 1);
    const anm = analyse(nm);
    out.notes.push(`normalMapFromHeight: mean ${anm.r.toFixed(0)}/${anm.g.toFixed(0)}/${anm.b.toFixed(0)} (expect ~128/128/>200)`);
    if (anm.b < 150) bad(`normal map blue channel is ${anm.b.toFixed(0)}, expected > 150 for a tangent-space map`);
  } catch (e) { bad('noise/normal helpers threw: ' + e.message); }

  return out;
}
