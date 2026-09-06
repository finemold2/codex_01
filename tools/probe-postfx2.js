/**
 * Phase-2 adversarial probe for js/render/postfx.js: validates the composite maths against a
 * CPU reference, measures grain behaviour, bloom threshold response, chromatic fringe width,
 * SSAO on a fronto-parallel wall and GL state leakage after a bloom frame.
 */
import { createGLContext, RenderTarget, Shader, drawFullscreen } from '../js/core/gl.js';
import { PostFX } from '../js/render/postfx.js';
import { mat4 } from '../js/core/math.js';

const ERR = { 0x0500: 'INVALID_ENUM', 0x0501: 'INVALID_VALUE', 0x0502: 'INVALID_OPERATION',
  0x0505: 'OUT_OF_MEMORY', 0x0506: 'INVALID_FRAMEBUFFER_OPERATION' };
function glErrors(gl, tag, out) {
  let e = gl.getError(); let n = 0;
  while (e !== gl.NO_ERROR && n++ < 8) { out.push(tag + ': ' + (ERR[e] || e)); e = gl.getError(); }
}

const VS = `
out vec2 vUv;
void main(){ vec2 p=vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); vUv=p; gl_Position=vec4(p*2.0-1.0,0.0,1.0); }
`;
const FS_FLAT = `
in vec2 vUv; out vec4 fragColor;
uniform vec3 uColor; uniform float uDepth;
void main(){ gl_FragDepth = uDepth; fragColor = vec4(uColor, 1.0); }
`;
const FS_HALF = `
in vec2 vUv; out vec4 fragColor;
uniform vec3 uLo; uniform vec3 uHi;
void main(){ gl_FragDepth = 0.5; fragColor = vec4(vUv.x < 0.5 ? uLo : uHi, 1.0); }
`;
const FS_WALL = `
in vec2 vUv; out vec4 fragColor;
uniform mat4 uProj; uniform float uZ;
void main(){
  vec4 clip = uProj * vec4(0.0, 0.0, uZ, 1.0);
  gl_FragDepth = (clip.z/clip.w) * 0.5 + 0.5;
  fragColor = vec4(0.5);
}
`;

/* ---- CPU reference of the composite ---- */
const ACES_IN = [[0.59719, 0.35458, 0.04823], [0.07600, 0.90834, 0.01566], [0.02840, 0.13383, 0.83777]];
const ACES_OUT = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]];
const mul3 = (m, v) => [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]);
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
function aces(c) {
  const v = mul3(ACES_IN, c.map((x) => Math.max(0, x)));
  const f = v.map((x) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081));
  return mul3(ACES_OUT, f).map((x) => Math.min(1, Math.max(0, x)));
}
function srgb(x) { const c = Math.min(1, Math.max(0, x)); return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }
function smoothstep(e0, e1, x) { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }

function cpuComposite(src, p, aspect, uvx, uvy, tonemap) {
  const cx = (uvx - 0.5) * aspect, cy = uvy - 0.5;
  const radial = Math.min(2, Math.hypot(cx, cy) * 1.42);
  let c = src.map((v) => v * p.exposure);
  let m = tonemap ? aces(c) : c.map((v) => Math.min(1, Math.max(0, v)));
  if (p.saturation !== 1) { const l = luma(m); m = m.map((v) => l + (v - l) * p.saturation); }
  if (p.contrast !== 1) m = m.map((v) => (v - 0.5) * p.contrast + 0.5);
  m = m.map((v) => Math.max(0, v));
  if (p.damageFlash > 0) {
    const edge = 0.25 + 0.75 * smoothstep(0.2, 1.0, radial);
    const t = Math.min(1, p.damageFlash) * edge * 0.85;
    const tgt = [0.62, 0.02, 0.03];
    m = m.map((v, i) => v + (tgt[i] - v) * t);
  }
  if (p.deathFade > 0) {
    const f = Math.min(1, p.deathFade); const l = luma(m); const t = Math.min(1, f * 1.2);
    m = m.map((v) => (v + (l - v) * t) * (1 + (0.18 - 1) * f));
  }
  if (p.vignette > 0) { const v = smoothstep(1.02, 0.34, radial); const k = 1 + (v - 1) * Math.min(1, p.vignette); m = m.map((x) => x * k); }
  return m.map((v) => srgb(v) * 255);
}

export default async function probe({ canvas }) {
  const rep = { errors: [], checks: {} };
  const gl = createGLContext(canvas, {});
  if (!gl) { rep.errors.push('no webgl2'); return rep; }

  const W = 320, H = 180;
  const fake = { quality: { name: 'ultra', bloom: true, ssao: true }, width: W, height: H, renderWidth: W, renderHeight: H };
  const fx = new PostFX(gl, fake);
  const hdr = new RenderTarget(gl, W, H, { colorFormat: 'rgba16f', depth: true, depthTexture: true, filter: 'linear', wrap: 'clamp' });
  const out = new RenderTarget(gl, W, H, { colorFormat: 'rgba8', depth: false, filter: 'nearest', wrap: 'clamp' });
  const flat = new Shader(gl, VS, FS_FLAT, {}, 'probe/flat');
  const half = new Shader(gl, VS, FS_HALF, {}, 'probe/half');
  const wall = new Shader(gl, VS, FS_WALL, {}, 'probe/wall');
  const proj = mat4.create(); mat4.perspective(proj, 62 * Math.PI / 180, W / H, 0.12, 1400);
  const invProj = mat4.create(); mat4.invert(invProj, proj);
  const camera = { proj, invProj };
  glErrors(gl, 'setup', rep.errors);

  function paint(shader, setup) {
    hdr.bind(true);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.ALWAYS); gl.depthMask(true);
    gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    shader.use(); setup(shader); drawFullscreen(gl); gl.depthFunc(gl.LEQUAL);
  }
  const px = new Uint8Array(W * H * 4);
  function run(p) { out.bind(true); gl.viewport(0, 0, W, H); fx.render(hdr.color(0), hdr.depthTex, camera, 1 / 60, p); gl.bindFramebuffer(gl.FRAMEBUFFER, out.framebuffer); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); }
  const at = (x, y) => { const i = ((y * W) + x) * 4; return [px[i], px[i + 1], px[i + 2], px[i + 3]]; };

  const base = { exposure: 1, bloomStrength: 0, bloomThreshold: 1.1, bloomKnee: 0.6, bloomRadius: 1,
    vignette: 0, grain: 0, chromatic: 0, saturation: 1, contrast: 1, rain: 0, wetness: 0,
    damageFlash: 0, deathFade: 0, ssao: 0, speedBlur: 0 };

  fx.setEnabled('fxaa', false);
  const aspect = W / H;

  /* ---------- 1. composite maths vs CPU reference ---------- */
  const cases = [
    ['exposure', { exposure: 2.2 }, true],
    ['saturation', { saturation: 1.6 }, true],
    ['desaturate', { saturation: 0.2 }, true],
    ['contrast', { contrast: 1.4 }, true],
    ['vignette', { vignette: 1 }, true],
    ['damage', { damageFlash: 0.7 }, true],
    ['death', { deathFade: 0.6 }, true],
    ['tonemapOff', {}, false],
    ['combo', { exposure: 1.4, saturation: 1.2, contrast: 1.1, vignette: 0.5, damageFlash: 0.3 }, true]
  ];
  const src = [0.32, 0.55, 0.12];
  rep.checks.compositeMath = {};
  for (const [name, over, tm] of cases) {
    fx.setEnabled('tonemap', tm);
    paint(flat, (s) => { s.setVec3('uColor', src[0], src[1], src[2]); s.setFloat('uDepth', 0.5); });
    const p = Object.assign({}, base, over);
    run(p);
    const probes = [[W >> 1, H >> 1], [W - 4, H - 4], [8, H >> 1]];
    let worst = 0; const detail = [];
    for (const [x, y] of probes) {
      const got = at(x, y).slice(0, 3);
      const want = cpuComposite(src, p, aspect, (x + 0.5) / W, (y + 0.5) / H, tm);
      const err = Math.max(...want.map((v, i) => Math.abs(v - got[i])));
      worst = Math.max(worst, err);
      detail.push({ at: [x, y], got, want: want.map((v) => +v.toFixed(1)) });
    }
    rep.checks.compositeMath[name] = { maxErr: +worst.toFixed(2), detail };
  }
  glErrors(gl, 'composite-math', rep.errors);
  fx.setEnabled('tonemap', true);

  /* ---------- 2. grain: linear-space injection + time precision ---------- */
  function grainStats(sceneLinear, time, grain) {
    fx.time = time;
    paint(flat, (s) => { s.setVec3('uColor', sceneLinear, sceneLinear, sceneLinear); s.setFloat('uDepth', 0.5); });
    run(Object.assign({}, base, { grain }));
    let min = 255, max = 0, sum = 0, sum2 = 0, n = 0;
    const seen = new Set();
    for (let y = 40; y < 140; y++) for (let x = 40; x < 280; x++) {
      const v = px[((y * W) + x) * 4];
      min = Math.min(min, v); max = Math.max(max, v); sum += v; sum2 += v * v; n++; seen.add(v);
    }
    const mean = sum / n;
    return { min, max, mean: +mean.toFixed(1), sd: +Math.sqrt(sum2 / n - mean * mean).toFixed(2), distinct: seen.size };
  }
  // Reference: what the same grain amplitude looks like around mid grey.
  const gShadow = grainStats(0.004, 0, 0.03);   // dark surface (ACES(0.004) ~ 0.0035 linear)
  const gMid = grainStats(0.18, 0, 0.03);
  const gNone = grainStats(0.004, 0, 0);
  rep.checks.grainLinearSpace = {
    shadowNoGrain: gNone, shadow: gShadow, midGrey: gMid,
    shadowPeakToPeak: gShadow.max - gShadow.min, midPeakToPeak: gMid.max - gMid.min
  };
  // time precision
  const t0 = grainStats(0.18, 0, 0.05);
  const t1 = grainStats(0.18, 900, 0.05);
  const t2 = grainStats(0.18, 3500, 0.05);
  rep.checks.grainTimePrecision = { t0, t900: t1, t3500: t2 };
  fx.time = 0;
  glErrors(gl, 'grain', rep.errors);

  /* ---------- 3. temporal animation of grain (must change every frame) ---------- */
  paint(flat, (s) => { s.setVec3('uColor', 0.18, 0.18, 0.18); s.setFloat('uDepth', 0.5); });
  fx.time = 0;
  run(Object.assign({}, base, { grain: 0.05 }));
  const frameA = Uint8Array.from(px.subarray(0, W * 4));
  run(Object.assign({}, base, { grain: 0.05 }));
  let diff = 0;
  for (let i = 0; i < W * 4; i += 4) if (frameA[i] !== px[i]) diff++;
  rep.checks.grainAnimates = { changedOfRow: diff, rowLength: W };

  /* ---------- 4. bloom threshold response ---------- */
  fx.setEnabled('tonemap', false);
  const resp = [];
  for (const level of [0.5, 1.0, 1.5, 2.0, 4.0]) {
    paint(flat, (s) => { s.setVec3('uColor', level, level, level); s.setFloat('uDepth', 0.5); });
    run(Object.assign({}, base, { bloomStrength: 1, bloomThreshold: 1.1, bloomKnee: 0.6 }));
    const withB = at(W >> 1, H >> 1)[1];
    run(Object.assign({}, base, { bloomStrength: 0 }));
    const noB = at(W >> 1, H >> 1)[1];
    resp.push({ level, withBloom: withB, noBloom: noB });
  }
  rep.checks.bloomThresholdResponse = resp;
  glErrors(gl, 'bloom-threshold', rep.errors);

  /* ---------- 5. chromatic fringe width in pixels at the corner ---------- */
  fx.setEnabled('tonemap', false);
  paint(half, (s) => { s.setVec3('uLo', 0, 0, 0); s.setVec3('uHi', 1, 1, 1); });
  run(Object.assign({}, base, { chromatic: 0.35 }));
  const rowY = 6;   // near the bottom edge => large radial
  let firstR = -1, firstB = -1;
  for (let x = 0; x < W; x++) { const c = at(x, rowY); if (firstR < 0 && c[0] > 40) firstR = x; if (firstB < 0 && c[2] > 40) firstB = x; }
  rep.checks.chromaticFringePx = { edgeRedAt: firstR, edgeBlueAt: firstB, splitPx: Math.abs(firstR - firstB), width: W };

  /* ---------- 6. SSAO on a fronto-parallel wall (must be ~1.0) ---------- */
  fx.setEnabled('tonemap', true);
  for (const z of [-3, -10, -40]) {
    paint(wall, (s) => { s.setMat4('uProj', proj); s.setFloat('uZ', z); });
    out.bind(true); gl.viewport(0, 0, W, H);
    fx.render(hdr.color(0), hdr.depthTex, camera, 1 / 60, Object.assign({}, base, { ssao: 1 }));
    const rt = fx._aoBlur; const aw = rt.width, ah = rt.height;
    const ap = new Uint8Array(aw * ah * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.framebuffer);
    gl.readPixels(0, 0, aw, ah, gl.RGBA, gl.UNSIGNED_BYTE, ap);
    let mn = 255, mx = 0, s = 0;
    for (let y = 8; y < ah - 8; y++) for (let x = 8; x < aw - 8; x++) { const v = ap[((y * aw) + x) * 4]; mn = Math.min(mn, v); mx = Math.max(mx, v); s += v; }
    const n = (ah - 16) * (aw - 16);
    rep.checks['ssaoWall' + z] = { min: mn, max: mx, mean: +(s / n).toFixed(1) };
  }
  glErrors(gl, 'ssao-wall', rep.errors);

  /* ---------- 7. GL state leakage after a bloom frame ---------- */
  paint(flat, (s) => { s.setVec3('uColor', 3, 3, 3); s.setFloat('uDepth', 0.5); });
  out.bind(true); gl.viewport(0, 0, W, H);
  fx.render(hdr.color(0), hdr.depthTex, camera, 1 / 60, Object.assign({}, base, { bloomStrength: 1 }));
  const vp = gl.getParameter(gl.VIEWPORT);
  rep.checks.stateAfterBloom = {
    blend: gl.getParameter(gl.BLEND),
    blendSrcRGB: gl.getParameter(gl.BLEND_SRC_RGB),
    blendDstRGB: gl.getParameter(gl.BLEND_DST_RGB),
    blendColor: Array.from(gl.getParameter(gl.BLEND_COLOR) || []),
    depthTest: gl.getParameter(gl.DEPTH_TEST),
    depthMask: gl.getParameter(gl.DEPTH_WRITEMASK),
    cull: gl.getParameter(gl.CULL_FACE),
    viewport: [vp[0], vp[1], vp[2], vp[3]],
    fbo: gl.getParameter(gl.FRAMEBUFFER_BINDING) === out.framebuffer
  };

  /* ---------- 8. speed blur + chromatic tap cost ---------- */
  rep.checks.tapCost = { note: 'static: sceneFetch calls sceneBlurred 3x when chromatic > 0' };

  rep.ok = rep.errors.length === 0;
  return rep;
}
