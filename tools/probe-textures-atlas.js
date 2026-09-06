/**
 * Second headless probe for js/render/textures.js.
 *
 * Where `probe-textures.js` checks that the library is complete and not flat, this one checks
 * the parts that are easy to get silently wrong:
 *   1. `ROAD_MARKING_UV` really addresses the marking it names, in the space it documents
 *      (canvas space, v downwards — the space `world/worldbuild.js#glRect` converts from).
 *   2. `GRADIENT_RAMP_ROWS` really lands on its ramp once the LUT is on the GPU (flipY).
 *   3. Facade alpha is an emissive mask and the RGB under alpha = 0 survives the upload
 *      (the premultiplied-canvas trap).
 *   4. The library is deterministic for a seed and actually changes with the seed.
 *   5. `makeNoiseCanvas({type:'blue'})` stays fast at a size a caller might plausibly ask for.
 *
 * Run: node tools/gl-probe.mjs tools/probe-textures-atlas.js
 */
import { createGLContext, Shader, RenderTarget, drawFullscreen } from '/js/core/gl.js';
import {
  buildTextureLibrary, makeNoiseCanvas, ROAD_MARKING_UV, GRADIENT_RAMP_ROWS
} from '/js/render/textures.js';

const VS = `#version 300 es
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0.0,1.0);}`;
const FS = `#version 300 es
precision highp float;uniform sampler2D uTex;uniform vec2 uUv;uniform float uMode;uniform float uScale;out vec4 o;
void main(){vec4 t=texture(uTex,uUv);o=vec4(mix(t.rgb*uScale, vec3(t.a), uMode),1.0);}`;

/**
 * Reads one texel of a texture through the GPU, so upload flips and formats are exercised.
 * The default framebuffer has no alpha channel, so sampling happens into an RGBA8 target and
 * alpha is fetched in a second pass that broadcasts it into RGB. Colour maps are uploaded as
 * sRGB, so `uScale` is used to lift the (hardware-linearised) values back into a readable range.
 */
function makeSampler(gl) {
  const sh = new Shader(gl, VS, FS, {}, 'atlasProbe');
  const rt = new RenderTarget(gl, 4, 4, { colorFormat: 'rgba8', depth: false, filter: 'nearest' });
  const out = new Uint8Array(4);
  const pass = (tex, u, v, mode, scale) => {
    rt.bind(true);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    sh.use();
    sh.setTexture('uTex', tex, 0);
    sh.setVec2('uUv', u, v);
    sh.setFloat('uMode', mode);
    sh.setFloat('uScale', scale);
    drawFullscreen(gl);
    gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out[0];
  };
  /**
   * @param {object} tex Texture to sample.
   * @param {number} u U coordinate.
   * @param {number} v V coordinate.
   * @param {number} [scale] RGB gain (use > 1 to inspect very dark sRGB texels).
   * @returns {number[]} `[r, g, b, a]`, RGB after the hardware sRGB decode.
   */
  return (tex, u, v, scale) => {
    const s = scale === undefined ? 1 : scale;
    rt.bind(true);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    sh.use();
    sh.setTexture('uTex', tex, 0);
    sh.setVec2('uUv', u, v);
    sh.setFloat('uMode', 0);
    sh.setFloat('uScale', s);
    drawFullscreen(gl);
    gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const rgb = [out[0], out[1], out[2]];
    return [rgb[0], rgb[1], rgb[2], pass(tex, u, v, 1, 1)];
  };
}

/** Pulls the pixels of a canvas once. */
function pixelsOf(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

/** Measures the ink (alpha > 96) inside a canvas-space rectangle of the atlas. */
function inkStats(px, W, H, rect) {
  const x0 = Math.round(rect.u0 * W), x1 = Math.round(rect.u1 * W);
  const y0 = Math.round(rect.v0 * H), y1 = Math.round(rect.v1 * H);
  const w = x1 - x0, h = y1 - y0;
  let n = 0, sx = 0, sy = 0, sr = 0, sg = 0, sb = 0;
  let minX = 1, maxX = 0, minY = 1, maxY = 0, widest = 0;
  for (let y = y0; y < y1; y++) {
    let rowInk = 0;
    for (let x = x0; x < x1; x++) {
      const p = (y * W + x) * 4;
      if (px[p + 3] <= 96) continue;
      const fx = (x - x0 + 0.5) / w, fy = (y - y0 + 0.5) / h;
      n++; rowInk++;
      sx += fx; sy += fy;
      sr += px[p]; sg += px[p + 1]; sb += px[p + 2];
      if (fx < minX) minX = fx;
      if (fx > maxX) maxX = fx;
      if (fy < minY) minY = fy;
      if (fy > maxY) maxY = fy;
    }
    if (rowInk > widest) widest = rowInk;
  }
  if (!n) return { coverage: 0, n: 0 };
  return {
    n, coverage: n / (w * h),
    cx: sx / n, cy: sy / n,
    r: sr / n, g: sg / n, b: sb / n,
    minX, maxX, minY, maxY,
    widestRow: widest / w
  };
}

/** FNV-1a over a pixel buffer, for cheap determinism comparisons. */
function hashPixels(px) {
  let h = 0x811c9dc5;
  for (let i = 0; i < px.length; i += 7) {
    h ^= px[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export default async function run({ canvas }) {
  const out = { errors: [], notes: [] };
  const bad = (m) => out.errors.push(m);
  const gl = createGLContext(canvas, {});
  if (!gl) { bad('no webgl2'); return out; }
  const sample = makeSampler(gl);

  const lib = buildTextureLibrary(gl, { size: 512, seed: 1337 });

  /* ---------------------------------------------------------------- 1. atlas */
  const atlas = lib.canvases.roadLines;
  if (!atlas) {
    bad('no roadLines canvas exposed');
  } else {
    const W = atlas.width, H = atlas.height;
    const px = pixelsOf(atlas);
    const S = {};
    for (const k of Object.keys(ROAD_MARKING_UV)) S[k] = inkStats(px, W, H, ROAD_MARKING_UV[k]);
    for (const k of Object.keys(S)) {
      if (!S[k].n) { bad(`ROAD_MARKING_UV.${k} addresses an empty region of the atlas`); }
    }
    out.notes.push('atlas ink coverage: ' + Object.keys(S)
      .map((k) => `${k} ${(S[k].coverage * 100).toFixed(1)}%`).join(', '));

    // dash: one narrow vertical white bar with a gap top and bottom.
    if (S.dash.n) {
      if (S.dash.maxX - S.dash.minX > 0.30) {
        bad(`ROAD_MARKING_UV.dash is not a narrow bar (x span ${(S.dash.maxX - S.dash.minX).toFixed(2)}) `
          + '— the rect is probably pointing at a lane arrow (canvas/GL space mix-up)');
      }
      if (S.dash.minY < 0.06 || S.dash.maxY > 0.94) {
        bad(`ROAD_MARKING_UV.dash has no gap (y ${S.dash.minY.toFixed(2)}..${S.dash.maxY.toFixed(2)}) — that is the solid line cell`);
      }
      if (S.dash.b < 180) bad(`ROAD_MARKING_UV.dash is not white paint (b=${S.dash.b.toFixed(0)})`);
    }
    // solid: same narrow bar but running the full height of the cell.
    if (S.solid.n) {
      if (S.solid.maxX - S.solid.minX > 0.30) bad('ROAD_MARKING_UV.solid is not a narrow bar');
      if (S.solid.minY > 0.03 || S.solid.maxY < 0.97) {
        bad(`ROAD_MARKING_UV.solid does not span the cell (y ${S.solid.minY.toFixed(2)}..${S.solid.maxY.toFixed(2)})`);
      }
    }
    // doubleYellow: yellow paint, two bars.
    if (S.doubleYellow.n) {
      const dy = S.doubleYellow;
      if (!(dy.r > dy.b + 60 && dy.g > dy.b + 30)) {
        bad(`ROAD_MARKING_UV.doubleYellow is not yellow (rgb ${dy.r.toFixed(0)}/${dy.g.toFixed(0)}/${dy.b.toFixed(0)}) `
          + '— the rect is pointing at a white marking (canvas/GL space mix-up)');
      }
      if (dy.minY > 0.03 || dy.maxY < 0.97) bad('ROAD_MARKING_UV.doubleYellow does not run the full cell');
    }
    // stopBar: one wide horizontal band.
    if (S.stopBar.n && S.stopBar.widestRow < 0.7) {
      bad(`ROAD_MARKING_UV.stopBar is not a wide bar (widest row ${(S.stopBar.widestRow * 100).toFixed(0)}%)`);
    }
    // crosswalk: dense stripes across the whole width.
    if (S.crosswalk.n) {
      if (S.crosswalk.coverage < 0.35) bad(`ROAD_MARKING_UV.crosswalk coverage is only ${(S.crosswalk.coverage * 100).toFixed(0)}%`);
      if (S.crosswalk.maxX - S.crosswalk.minX < 0.9) bad('ROAD_MARKING_UV.crosswalk does not span the atlas width');
    }
    // arrows: the head is wider than the shaft, and it points up in canvas space.
    for (const k of ['arrowStraight', 'arrowLeft', 'arrowRight']) {
      const a = S[k];
      if (!a.n) continue;
      if (a.maxX - a.minX < 0.28) {
        bad(`ROAD_MARKING_UV.${k} is too narrow to be an arrow (x span ${(a.maxX - a.minX).toFixed(2)}) `
          + '— the rect is probably pointing at a lane line (canvas/GL space mix-up)');
      }
      if (a.minY > 0.25) bad(`ROAD_MARKING_UV.${k} has no arrow head near the top of the cell (minY ${a.minY.toFixed(2)})`);
    }
    if (S.arrowLeft.n && S.arrowRight.n) {
      if (!(S.arrowLeft.cx < 0.5)) bad(`ROAD_MARKING_UV.arrowLeft does not lean left (cx ${S.arrowLeft.cx.toFixed(2)})`);
      if (!(S.arrowRight.cx > 0.5)) bad(`ROAD_MARKING_UV.arrowRight does not lean right (cx ${S.arrowRight.cx.toFixed(2)})`);
    }
    // parking: outline strokes, never a solid bar.
    if (S.parking.n && S.parking.widestRow > 0.7) bad('ROAD_MARKING_UV.parking looks like a solid bar');

    // The consumer flips once (glRect); the flipped rect must hit the same ink on the GPU.
    const flip = (r) => ({ u0: r.u0, v0: 1 - r.v1, u1: r.u1, v1: 1 - r.v0 });
    const yr = flip(ROAD_MARKING_UV.doubleYellow);
    /* The two yellow bars sit at 0.34..0.45 and 0.55..0.66 of the cell; aim at the first. */
    const g = sample(lib.roadLines, yr.u0 + (yr.u1 - yr.u0) * 0.395, (yr.v0 + yr.v1) * 0.5);
    out.notes.push(`GPU sample inside glRect(doubleYellow): rgba ${g.join(',')}`);
    if (g[3] < 80 || !(g[0] > g[2] + 40)) {
      bad(`glRect(ROAD_MARKING_UV.doubleYellow) does not sample yellow paint on the GPU (rgba ${g.join(',')})`);
    }
  }

  /* ------------------------------------------------------------ 2. ramp rows */
  const expect = {
    fire: [255, 168, 40], water: [24, 86, 102], health: [242, 176, 40],
    neon: [122, 80, 255], sunset: [86, 44, 110], smoke: [132, 132, 138]
  };
  const tOf = { fire: 0.7, water: 0.5, health: 0.5, neon: 0.5, sunset: 0.35, smoke: 0.7 };
  for (const k of Object.keys(expect)) {
    const v = GRADIENT_RAMP_ROWS[k];
    if (v === undefined) { bad(`GRADIENT_RAMP_ROWS.${k} is missing`); continue; }
    const got = sample(lib.gradientRamp, tOf[k], v);
    const e = expect[k];
    const err = Math.abs(got[0] - e[0]) + Math.abs(got[1] - e[1]) + Math.abs(got[2] - e[2]);
    out.notes.push(`ramp ${k}: v=${v} -> ${got.slice(0, 3).join(',')} (expect ~${e.join(',')}, err ${err})`);
    if (err > 42) bad(`GRADIENT_RAMP_ROWS.${k} does not land on the ${k} ramp (got ${got.slice(0, 3).join(',')}, expect ~${e.join(',')})`);
  }
  // No band may be transparent/black: that is what a fractional row height produces.
  for (let i = 0; i < 8; i++) {
    const v = 1 - (i + 0.5) / 8;
    const c = sample(lib.gradientRamp, 0.98, v);
    if (c[0] + c[1] + c[2] === 0) bad(`gradientRamp band ${i} is empty at v=${v}`);
  }

  /* --------------------------------------------------- 3. facade window mask */
  for (const key of ['glassFacade', 'officeFacade', 'apartmentFacade', 'groundFloorShops']) {
    const tex = lib[key];
    if (!tex) { bad(`${key} missing`); continue; }
    let lit = 0, unlit = 0, blackWall = 0;
    for (let i = 0; i < 40; i++) {
      for (let j = 0; j < 40; j++) {
        const c = sample(tex, (i + 0.5) / 40, (j + 0.5) / 40, 8);
        if (c[3] > 160) lit++;
        else if (c[3] < 40) {
          unlit++;
          if (c[0] + c[1] + c[2] < 12) blackWall++;
        }
      }
    }
    out.notes.push(`${key}: ${lit} lit / ${unlit} unlit samples, ${blackWall} unlit samples with black rgb`);
    if (!lit) bad(`${key} has no emissive window texels (alpha mask is empty)`);
    if (!unlit) bad(`${key} is emissive everywhere (alpha mask is solid)`);
    if (blackWall > unlit * 0.2) {
      bad(`${key} lost its wall colour under alpha = 0 (${blackWall}/${unlit} black) — premultiplied canvas upload`);
    }
  }

  /* -------------------------------------------------------- 4. determinism */
  const keys = ['asphalt', 'brick', 'glassFacade', 'roadLines', 'noiseBlue', 'leaves', 'skyStars'];
  const a = buildTextureLibrary(gl, { size: 256, seed: 4242 });
  const hashA = keys.map((k) => hashPixels(pixelsOf(a.canvases[k])));
  a.dispose();
  const b = buildTextureLibrary(gl, { size: 256, seed: 4242 });
  const hashB = keys.map((k) => hashPixels(pixelsOf(b.canvases[k])));
  b.dispose();
  const c = buildTextureLibrary(gl, { size: 256, seed: 99 });
  const hashC = keys.map((k) => hashPixels(pixelsOf(c.canvases[k])));
  c.dispose();
  for (let i = 0; i < keys.length; i++) {
    if (hashA[i] !== hashB[i]) bad(`${keys[i]} is not deterministic for a fixed seed`);
    if (hashA[i] === hashC[i]) bad(`${keys[i]} ignores the seed`);
  }
  out.notes.push('determinism: same seed identical, different seed different, for ' + keys.join('/'));

  /* ------------------------------------------------- 5. blue noise stays fast */
  const t0 = performance.now();
  const bn = makeNoiseCanvas(128, 128, { type: 'blue', seed: 5 });
  const bms = performance.now() - t0;
  out.notes.push(`makeNoiseCanvas(128,128,blue): ${bms.toFixed(0)} ms`);
  if (bms > 1500) bad(`makeNoiseCanvas blue noise is O(n^2) unbounded: ${bms.toFixed(0)} ms at 128x128`);
  const bp = pixelsOf(bn);
  let lo = 255, hi = 0;
  for (let i = 0; i < bp.length; i += 4) { if (bp[i] < lo) lo = bp[i]; if (bp[i] > hi) hi = bp[i]; }
  if (hi - lo < 200) bad(`blue noise has no range (${lo}..${hi})`);

  /* ------------------------------------------------------------- 6. cleanup */
  lib.dispose();
  if (lib.asphalt !== null) bad('dispose() left textures behind');
  if (Object.keys(lib.canvases).length !== 0) bad('dispose() left canvases behind');
  if (!lib.stats || !lib.stats.count) bad('dispose() destroyed the stats block');
  if (gl.getError()) bad('GL error at the end of the probe');
  return out;
}
