/**
 * Headless WebGL2 regression probe for `js/render/postfx.js`.
 *
 * Run: node tools/gl-probe.mjs tools/probe-postfx.js
 *
 * Every check is an assertion with a measured value attached, so a regression shows both what
 * broke and by how much. The four checks that exist because of a real bug are marked [REG].
 */
import { createGLContext, RenderTarget, Shader, drawFullscreen } from '../js/core/gl.js';
import { PostFX, POSTFX_DEFAULTS } from '../js/render/postfx.js';
import { mat4 } from '../js/core/math.js';

const GL_ERR = {
  0x0500: 'INVALID_ENUM', 0x0501: 'INVALID_VALUE', 0x0502: 'INVALID_OPERATION',
  0x0505: 'OUT_OF_MEMORY', 0x0506: 'INVALID_FRAMEBUFFER_OPERATION'
};

const VS = `
out vec2 vUv;
void main(){ vec2 p=vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); vUv=p; gl_Position=vec4(p*2.0-1.0,0.0,1.0); }
`;

/**
 * Test scene. `uA.x` selects the pattern, `uA.yzw` the base colour, `uB` the bright disc.
 * `uMode2.x` selects the depth pattern: 0 = flat wall at `uMode2.y`, 1 = receding floor.
 */
const FS_SCENE = `
in vec2 vUv; out vec4 fragColor;
uniform vec4 uA;
uniform vec4 uB;
uniform vec4 uMode2;
uniform mat4 uProj;
void main(){
  vec3 c = uA.yzw;
  if (uA.x > 0.5) {
    float d = length((vUv - uB.xy) * vec2(1.7777, 1.0));
    c += vec3(uB.w) * step(d, uB.z);
  }
  float z = uMode2.x > 0.5 ? -(3.0 + vUv.y * 60.0) : uMode2.y;
  vec4 clip = uProj * vec4(0.0, 0.0, z, 1.0);
  gl_FragDepth = (clip.z / clip.w) * 0.5 + 0.5;
  fragColor = vec4(c, 1.0);
}
`;

/* ---------------- CPU reference for the composite ---------------- */
const ACES_IN = [[0.59719, 0.35458, 0.04823], [0.07600, 0.90834, 0.01566], [0.02840, 0.13383, 0.83777]];
const ACES_OUT = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]];
const mul3 = (m, v) => [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]);
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
function aces(c) {
  const v = mul3(ACES_IN, c.map((x) => Math.max(0, x)));
  const f = v.map((x) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081));
  return mul3(ACES_OUT, f).map((x) => Math.min(1, Math.max(0, x)));
}
function srgb(x) {
  const c = Math.min(1, Math.max(0, x));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
function smoothstep(e0, e1, x) { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
function cpuComposite(src, p, aspect, uvx, uvy, tonemap) {
  const radial = Math.min(2, Math.hypot((uvx - 0.5) * aspect, uvy - 0.5) * 1.42);
  let m = src.map((v) => v * p.exposure);
  m = tonemap ? aces(m) : m.map((v) => Math.min(1, Math.max(0, v)));
  if (p.saturation !== 1) { const l = luma(m); m = m.map((v) => l + (v - l) * p.saturation); }
  if (p.contrast !== 1) m = m.map((v) => (v - 0.5) * p.contrast + 0.5);
  m = m.map((v) => Math.max(0, v));
  if (p.damageFlash > 0) {
    const t = Math.min(1, p.damageFlash) * (0.25 + 0.75 * smoothstep(0.2, 1.0, radial)) * 0.85;
    const tgt = [0.62, 0.02, 0.03];
    m = m.map((v, i) => v + (tgt[i] - v) * t);
  }
  if (p.deathFade > 0) {
    const f = Math.min(1, p.deathFade); const l = luma(m);
    m = m.map((v) => (v + (l - v) * Math.min(1, f * 1.2)) * (1 + (0.18 - 1) * f));
  }
  if (p.vignette > 0) {
    const k = 1 + (smoothstep(1.02, 0.34, radial) - 1) * Math.min(1, p.vignette);
    m = m.map((x) => x * k);
  }
  return m.map((v) => srgb(v) * 255);
}

export default async function probe({ canvas }) {
  const rep = { ok: true, failures: [], glErrors: [], measurements: {} };
  const fail = (name, detail) => { rep.failures.push(name + ': ' + detail); rep.ok = false; };
  const gl = createGLContext(canvas, {});
  if (!gl) { fail('context', 'WebGL2 unavailable'); return rep; }
  const drain = (tag) => {
    let e = gl.getError(); let n = 0;
    while (e !== gl.NO_ERROR && n++ < 8) { rep.glErrors.push(tag + ': ' + (GL_ERR[e] || e)); rep.ok = false; e = gl.getError(); }
  };

  const W = 512, H = 288;
  const fakeRenderer = { quality: { name: 'ultra', bloom: true, ssao: true }, width: W, height: H, renderWidth: W, renderHeight: H };

  /* ============ 1. every pass compiles and links ============ */
  let fx = null;
  try { fx = new PostFX(gl, fakeRenderer); } catch (err) { fail('compile', err.message); return rep; }
  drain('construct');
  for (const k of ['ssaoShader', 'aoBlurShader', 'brightShader', 'downsampleShader', 'upsampleShader', 'compositeShader', 'fxaaShader']) {
    if (!fx[k]) fail('compile', k + ' missing');
  }
  rep.measurements.pipeline = { bloomLevels: fx.bloomLevels, floatTargets: fx.floatTargets, aoPublished: !!fx.aoTexture };

  /* ============ 2. documented contract surface ============ */
  for (const m of ['resize', 'render', 'dispose', 'setEnabled']) {
    if (typeof fx[m] !== 'function') fail('contract', 'PostFX#' + m + ' is ' + typeof fx[m]);
  }
  if (PostFX.prototype.render.length !== 5) fail('contract', 'render arity ' + PostFX.prototype.render.length + ' != 5');
  for (const key of ['exposure', 'bloomStrength', 'bloomThreshold', 'vignette', 'grain', 'chromatic',
    'saturation', 'contrast', 'rain', 'wetness', 'damageFlash', 'deathFade', 'ssao']) {
    if (!(key in POSTFX_DEFAULTS)) fail('contract', 'POSTFX_DEFAULTS missing ' + key);
  }

  /* ============ scene rig ============ */
  const hdr = new RenderTarget(gl, W, H, { colorFormat: 'rgba16f', depth: true, depthTexture: true, filter: 'linear', wrap: 'clamp' });
  const out = new RenderTarget(gl, W, H, { colorFormat: 'rgba8', depth: false, filter: 'nearest', wrap: 'clamp' });
  const scene = new Shader(gl, VS, FS_SCENE, {}, 'probe/scene');
  const proj = mat4.create(); mat4.perspective(proj, 62 * Math.PI / 180, W / H, 0.12, 1400);
  const invProj = mat4.create(); mat4.invert(invProj, proj);
  const camera = { proj, invProj };
  drain('rig');

  const px = new Uint8Array(W * H * 4);
  const at = (x, y) => { const i = ((y * W) + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
  function paint(colour, spot, depthMode, flatZ) {
    hdr.bind(true);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.ALWAYS); gl.depthMask(true);
    gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    scene.use();
    scene.setVec4('uA', spot ? 1 : 0, colour[0], colour[1], colour[2]);
    scene.setVec4('uB', spot ? spot[0] : 0, spot ? spot[1] : 0, spot ? spot[2] : 0, spot ? spot[3] : 0);
    scene.setVec4('uMode2', depthMode, flatZ === undefined ? -8 : flatZ, 0, 0);
    scene.setMat4('uProj', proj);
    drawFullscreen(gl); gl.depthFunc(gl.LEQUAL);
  }
  function run(p) {
    out.bind(true); gl.viewport(0, 0, W, H);
    fx.render(hdr.color(0), hdr.depthTex, camera, 1 / 60, p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.framebuffer);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  }
  function region(x0, y0, x1, y1) {
    let s = 0, s2 = 0, n = 0, mn = 255, mx = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const v = px[((y * W) + x) * 4];
      s += v; s2 += v * v; n++; if (v < mn) mn = v; if (v > mx) mx = v;
    }
    const mean = s / n;
    return { mean: +mean.toFixed(2), sd: +Math.sqrt(Math.max(0, s2 / n - mean * mean)).toFixed(2), min: mn, max: mx };
  }

  const base = { exposure: 1, bloomStrength: 0, bloomThreshold: 1.1, bloomKnee: 0.6, bloomRadius: 1,
    vignette: 0, grain: 0, chromatic: 0, saturation: 1, contrast: 1, rain: 0, wetness: 0,
    damageFlash: 0, deathFade: 0, ssao: 0, speedBlur: 0 };
  const aspect = W / H;

  /* ============ 3. neutral passthrough is an exact sRGB encode ============ */
  fx.setEnabled('fxaa', false); fx.setEnabled('tonemap', false);
  paint([0.25, 0.5, 0.75], null, 0);
  run(base);
  drain('neutral');
  {
    const got = at(W >> 1, H >> 1);
    const want = [0.25, 0.5, 0.75].map((v) => srgb(v) * 255);
    const err = Math.max(...want.map((v, i) => Math.abs(v - got[i])));
    rep.measurements.neutralPassthrough = { got, want: want.map((v) => +v.toFixed(1)), maxErr: +err.toFixed(2) };
    if (err > 1.01) fail('neutral', 'sRGB encode off by ' + err.toFixed(2) + ' codes');
  }

  /* ============ 4. composite maths against the CPU reference ============ */
  const src = [0.32, 0.55, 0.12];
  const cases = [
    ['exposure', { exposure: 2.2 }, true], ['saturation', { saturation: 1.6 }, true],
    ['desaturate', { saturation: 0.2 }, true], ['contrast', { contrast: 1.4 }, true],
    ['vignette', { vignette: 1 }, true], ['damage', { damageFlash: 0.7 }, true],
    ['death', { deathFade: 0.6 }, true], ['tonemapOff', {}, false],
    ['combo', { exposure: 1.4, saturation: 1.2, contrast: 1.1, vignette: 0.5, damageFlash: 0.3 }, true]
  ];
  rep.measurements.compositeMath = {};
  for (const [name, over, tm] of cases) {
    fx.setEnabled('tonemap', tm);
    paint(src, null, 0);
    const p = Object.assign({}, base, over);
    run(p);
    let worst = 0;
    for (const [x, y] of [[W >> 1, H >> 1], [W - 4, H - 4], [8, H >> 1]]) {
      const got = at(x, y);
      const want = cpuComposite(src, p, aspect, (x + 0.5) / W, (y + 0.5) / H, tm);
      worst = Math.max(worst, ...want.map((v, i) => Math.abs(v - got[i])));
    }
    rep.measurements.compositeMath[name] = +worst.toFixed(2);
    if (worst > 1.01) fail('compositeMath/' + name, worst.toFixed(2) + ' codes off the reference');
  }
  fx.setEnabled('tonemap', true);
  drain('composite-math');

  /* ============ 5. [REG] GL state is handed back exactly as found ============ */
  paint([3, 3, 3], null, 0);                                   // bright enough to run the bloom chain
  out.bind(true); gl.viewport(0, 0, W, H);
  gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.enable(gl.CULL_FACE);
  gl.disable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  fx.render(hdr.color(0), hdr.depthTex, camera, 1 / 60, Object.assign({}, base, { bloomStrength: 1 }));
  {
    const vp = gl.getParameter(gl.VIEWPORT);
    const st = {
      fbo: gl.getParameter(gl.FRAMEBUFFER_BINDING) === out.framebuffer,
      viewport: [vp[0], vp[1], vp[2], vp[3]],
      depthTest: gl.isEnabled(gl.DEPTH_TEST), depthMask: gl.getParameter(gl.DEPTH_WRITEMASK),
      cull: gl.isEnabled(gl.CULL_FACE), blend: gl.isEnabled(gl.BLEND),
      blendSrcRGB: gl.getParameter(gl.BLEND_SRC_RGB), blendDstRGB: gl.getParameter(gl.BLEND_DST_RGB),
      blendColor: Array.from(gl.getParameter(gl.BLEND_COLOR))
    };
    rep.measurements.stateAfterBloomFrame = st;
    if (!st.fbo) fail('state', 'framebuffer binding not restored');
    if (st.viewport.join() !== [0, 0, W, H].join()) fail('state', 'viewport ' + st.viewport);
    if (!st.depthTest) fail('state', 'DEPTH_TEST left disabled');
    if (!st.depthMask) fail('state', 'DEPTH_WRITEMASK left off');
    if (!st.cull) fail('state', 'CULL_FACE left disabled');
    if (st.blend) fail('state', 'BLEND left enabled');
    // the bloom upsample uses CONSTANT_COLOR / ONE_MINUS_CONSTANT_COLOR blending
    if (st.blendSrcRGB !== gl.SRC_ALPHA || st.blendDstRGB !== gl.ONE_MINUS_SRC_ALPHA) {
      fail('state', 'blend func left at ' + st.blendSrcRGB + '/' + st.blendDstRGB + ' (bloom scatter leak)');
    }
    if (st.blendColor.some((v) => v !== 0)) fail('state', 'BLEND_COLOR left at ' + st.blendColor);
  }
  drain('state');

  /* ============ 6. bloom: energy, threshold, halo shape ============ */
  fx.setEnabled('tonemap', false);
  paint([0.5, 0.5, 0.5], null, 0);
  run(Object.assign({}, base, { bloomStrength: 1, bloomThreshold: 0, bloomKnee: 0.05 }));
  {
    const got = at(W >> 1, H >> 1)[1];
    const want = Math.round(srgb(1.0) * 255);              // 0.5 scene + 0.5 bloom = 1.0 linear
    rep.measurements.bloomFlatEnergy = { got, want, withoutBloom: Math.round(srgb(0.5) * 255) };
    if (Math.abs(got - want) > 2) fail('bloomEnergy', 'flat field resolved to ' + got + ', expected ' + want);
  }
  const mip = fx._bloom[0];
  const mipPx = new Float32Array(mip.width * mip.height * 4);
  const curve = [];
  for (const level of [0.4, 0.8, 1.1, 2.0, 4.0]) {
    paint([level, level, level], null, 0);
    run(Object.assign({}, base, { bloomStrength: 1 }));
    gl.bindFramebuffer(gl.FRAMEBUFFER, mip.framebuffer);
    gl.readPixels(0, 0, mip.width, mip.height, gl.RGBA, gl.FLOAT, mipPx);
    curve.push({ level, bloom: +mipPx[((((mip.height >> 1) * mip.width) + (mip.width >> 1)) * 4) + 1].toFixed(4) });
  }
  rep.measurements.bloomThresholdCurve = curve;
  if (curve[0].bloom !== 0) fail('bloomThreshold', 'level 0.4 (well under the knee) leaked ' + curve[0].bloom);
  for (let i = 1; i < curve.length; i++) {
    if (curve[i].bloom <= curve[i - 1].bloom) fail('bloomThreshold', 'response not monotonic at level ' + curve[i].level);
  }
  paint([0, 0, 0], [0.5, 0.5, 0.015, 40], 0);
  run(Object.assign({}, base, { bloomStrength: 1 }));
  {
    const cx = W >> 1, cy = H >> 1;
    const prof = [], anis = [];
    for (let d = 10; d <= 90; d += 10) {
      const a = at(cx + d, cy)[1];
      const q = Math.round(d / Math.SQRT2);
      const g = at(cx + q, cy + q)[1];
      prof.push(a);
      if (a > 3) anis.push(+(g / a).toFixed(2));
    }
    rep.measurements.bloomHalo = { alongAxis: prof, diagonalOverAxis: anis };
    // a boxy (separable-only) bloom shows up as a diagonal that is much brighter than the axis
    for (const r of anis) if (r > 1.6 || r < 0.5) fail('bloomShape', 'halo anisotropy ' + r + ' (boxy / star-shaped)');
    for (let i = 1; i < prof.length; i++) if (prof[i] > prof[i - 1]) fail('bloomShape', 'halo not monotonically falling');
  }
  drain('bloom');

  /* ============ 7. [REG] film grain lives in display space ============ */
  fx.setEnabled('tonemap', false);
  const grainRows = [];
  for (const lin of [0.0, 0.01, 0.18]) {
    paint([lin, lin, lin], null, 0);
    run(Object.assign({}, base, { grain: 0 }));
    const clean = region(120, 80, 400, 200);
    run(Object.assign({}, base, { grain: 0.03 }));
    const noisy = region(120, 80, 400, 200);
    grainRows.push({ linear: lin, cleanMean: clean.mean, grainMean: noisy.mean,
      dcShift: +(noisy.mean - clean.mean).toFixed(2), sd: noisy.sd, peakToPeak: noisy.max - noisy.min });
  }
  rep.measurements.grain = grainRows;
  {
    const black = grainRows[0], mid = grainRows[2];
    // grain is zero-mean, so it must not lift the black level
    if (black.dcShift > 3) fail('grain', 'black lifted by ' + black.dcShift + ' codes (grain applied in linear light?)');
    // and it must not be dramatically louder in the shadows than at mid grey
    if (black.sd > mid.sd * 2.5) fail('grain', 'shadow sd ' + black.sd + ' vs mid-grey sd ' + mid.sd);
  }
  // it still has to animate frame to frame
  paint([0.18, 0.18, 0.18], null, 0);
  fx.time = 0;
  run(Object.assign({}, base, { grain: 0.05 }));
  const rowA = Uint8Array.from(px.subarray(0, W * 4));
  run(Object.assign({}, base, { grain: 0.05 }));
  let changed = 0;
  for (let i = 0; i < W * 4; i += 4) if (rowA[i] !== px[i]) changed++;
  rep.measurements.grainAnimatedPixelsPerRow = changed;
  if (changed < W * 0.5) fail('grain', 'only ' + changed + '/' + W + ' pixels changed between frames');
  fx.time = 0;
  drain('grain');

  /* ============ 8. SSAO ============ */
  fx.setEnabled('tonemap', true);
  const aoRt = fx._aoBlur;
  const aoPx = new Uint8Array(aoRt.width * aoRt.height * 4);
  function readAo() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, aoRt.framebuffer);
    gl.readPixels(0, 0, aoRt.width, aoRt.height, gl.RGBA, gl.UNSIGNED_BYTE, aoPx);
    let mn = 255, mx = 0, s = 0, n = 0;
    for (let y = 8; y < aoRt.height - 8; y++) for (let x = 8; x < aoRt.width - 8; x++) {
      const v = aoPx[((y * aoRt.width) + x) * 4]; if (v < mn) mn = v; if (v > mx) mx = v; s += v; n++;
    }
    return { min: mn, max: mx, mean: +(s / n).toFixed(1) };
  }
  // a) a plane facing the camera must be completely unoccluded (no self-occlusion / bias bug)
  rep.measurements.ssaoFlatWall = {};
  for (const z of [-3, -10, -40]) {
    paint([0.5, 0.5, 0.5], null, 0, z);
    run(Object.assign({}, base, { ssao: 1 }));
    const st = readAo();
    rep.measurements.ssaoFlatWall['z' + z] = st;
    if (st.min < 250) fail('ssao', 'flat wall at z=' + z + ' self-occludes down to ' + st.min);
  }
  // b) a steeply receding floor must produce real occlusion
  paint([0.5, 0.5, 0.5], null, 1);
  run(Object.assign({}, base, { ssao: 1 }));
  rep.measurements.ssaoFloor = readAo();
  if (rep.measurements.ssaoFloor.mean > 250) fail('ssao', 'receding floor produced no occlusion');

  /* ============ 9. [REG] AO must not eat the bloom halo ============ */
  {
    const savedComposite = fx.aoComposite;
    fx.aoComposite = 1;                                   // maximise so the check is unambiguous
    fx.setEnabled('tonemap', false);
    // black background + a small, very bright disc: halo pixels have no scene term of their own
    paint([0, 0, 0], [0.28, 0.5, 0.02, 80], 1);
    const bloomOn = Object.assign({}, base, { bloomStrength: 1 });
    run(Object.assign({}, bloomOn, { ssao: 1 }));         // prime the AO buffer (one frame late)
    run(Object.assign({}, bloomOn, { ssao: 1 }));
    const withAo = [[180, 144], [230, 144], [260, 144]].map(([x, y]) => at(x, y)[1]);
    run(Object.assign({}, bloomOn, { ssao: 0 }));
    const noAo = [[180, 144], [230, 144], [260, 144]].map(([x, y]) => at(x, y)[1]);
    run(Object.assign({}, base, { ssao: 0 }));
    const sceneOnly = [[180, 144], [230, 144], [260, 144]].map(([x, y]) => at(x, y)[1]);
    const darkened = noAo.map((v, i) => (v === 0 ? 0 : +(100 * (1 - withAo[i] / v)).toFixed(1)));
    rep.measurements.bloomHaloVsAo = { sceneOnly, haloNoAo: noAo, haloWithAo: withAo, darkenedPct: darkened };
    for (let i = 0; i < darkened.length; i++) {
      if (sceneOnly[i] === 0 && darkened[i] > 2) {
        fail('aoOrder', 'AO darkened a pure-bloom pixel by ' + darkened[i] + '% (AO applied after bloom)');
      }
    }
    fx.aoComposite = savedComposite;
    fx.setEnabled('tonemap', true);
  }
  drain('ssao');

  /* ============ 10. everything on at once: no NaN, no black frame ============ */
  paint([0.2, 0.22, 0.3], [0.6, 0.55, 0.05, 20], 1);
  fx.setEnabled('fxaa', true);
  run(Object.assign({}, base, { rain: 1, wetness: 1, damageFlash: 0.5, deathFade: 0.4, grain: 0.05,
    chromatic: 1, speedBlur: 1, bloomStrength: 0.6, ssao: 1, saturation: 1.2, contrast: 1.1, vignette: 0.4 }));
  drain('heavy');
  {
    let black = 0, badAlpha = 0;
    for (let i = 0; i < W * H; i++) {
      if (px[i * 4] === 0 && px[i * 4 + 1] === 0 && px[i * 4 + 2] === 0) black++;
      if (px[i * 4 + 3] !== 255) badAlpha++;
    }
    rep.measurements.heavyFrame = { blackPixels: black, badAlpha, centre: at(W >> 1, H >> 1) };
    if (badAlpha) fail('heavy', badAlpha + ' pixels with a non-opaque alpha');
    if (black > W * H * 0.5) fail('heavy', 'frame is ' + black + '/' + (W * H) + ' black');
  }

  /* ============ 11. quality switching, renderScale, null safety ============ */
  fakeRenderer.quality = { name: 'low', bloom: false, ssao: false };
  paint([0.4, 0.4, 0.4], null, 0);
  run(Object.assign({}, base, { ssao: 1, bloomStrength: 1 }));
  rep.measurements.lowQuality = { aoReleased: fx.aoTexture === null, pixel: at(W >> 1, H >> 1) };
  if (fx.aoTexture !== null) fail('quality', 'aoTexture still published on a preset without SSAO');
  fakeRenderer.quality = { name: 'ultra', bloom: true, ssao: true };
  fakeRenderer.renderWidth = 256; fakeRenderer.renderHeight = 144;
  fx.resize(W, H);
  drain('resize');
  rep.measurements.afterRenderScale = { bloomLevels: fx.bloomLevels, proc: [fx.procWidth, fx.procHeight],
    ldr: [fx._ldr.width, fx._ldr.height], ao: !!fx.aoTexture };
  if (fx._ldr.width !== W || fx._ldr.height !== H) fail('resize', 'LDR buffer is not at output resolution');
  try {
    out.bind(true); gl.viewport(0, 0, W, H);
    fx.render(hdr.color(0), null, null, 1 / 60, base);
  } catch (err) { fail('nullSafety', 'render(hdr, null, null) threw: ' + err.message); }
  drain('null-safety');

  fx.dispose();
  drain('dispose');
  return rep;
}
