/**
 * Headless WebGL2 probe for js/render/postfx.js.
 * Run: node tools/gl-probe.mjs tools/probe-postfx.js
 */
import { createGLContext, RenderTarget, Shader, drawFullscreen } from '../js/core/gl.js';
import { PostFX, POSTFX_DEFAULTS } from '../js/render/postfx.js';
import { mat4 } from '../js/core/math.js';

const ERR = {
  0x0500: 'INVALID_ENUM', 0x0501: 'INVALID_VALUE', 0x0502: 'INVALID_OPERATION',
  0x0505: 'OUT_OF_MEMORY', 0x0506: 'INVALID_FRAMEBUFFER_OPERATION'
};

function glErrors(gl, tag, out) {
  let e = gl.getError();
  let n = 0;
  while (e !== gl.NO_ERROR && n++ < 8) {
    out.push(tag + ': ' + (ERR[e] || ('0x' + e.toString(16))));
    e = gl.getError();
  }
}

const VS = `
out vec2 vUv;
void main(){ vec2 p=vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); vUv=p; gl_Position=vec4(p*2.0-1.0,0.0,1.0); }
`;

/** Fills a target with a configurable HDR pattern and a depth ramp. */
const FS_FILL = `
in vec2 vUv;
out vec4 fragColor;
uniform vec4 uMode;   // x: 0 = flat, 1 = spot, 2 = gradient ; yzw = base colour
uniform vec4 uSpot;   // xy = centre, z = radius, w = intensity
uniform float uDepth; // ndc depth written
void main(){
  vec3 c = uMode.yzw;
  if (uMode.x > 1.5) {
    c = uMode.yzw * vUv.x;
  } else if (uMode.x > 0.5) {
    float d = length((vUv - uSpot.xy) * vec2(1.7777, 1.0));
    c += vec3(uSpot.w) * step(d, uSpot.z);
  }
  gl_FragDepth = uDepth;
  fragColor = vec4(c, 1.0);
}
`;

/** Writes a depth "wall + floor" scene so SSAO has a real crease. */
const FS_DEPTH_SCENE = `
in vec2 vUv;
out vec4 fragColor;
uniform mat4 uProj;
void main(){
  // A floor plane receding from the camera, with a box sitting on it in the middle.
  float z;
  if (abs(vUv.x - 0.5) < 0.12 && vUv.y < 0.62) {
    z = -6.0;                        // box front face, 6 m away
  } else {
    z = -(4.0 + vUv.y * 40.0);       // floor
  }
  vec4 clip = uProj * vec4(0.0, 0.0, z, 1.0);
  gl_FragDepth = (clip.z / clip.w) * 0.5 + 0.5;
  fragColor = vec4(0.4, 0.4, 0.4, 1.0);
}
`;

function srgb(c) {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

export default async function probe({ canvas }) {
  const report = { ok: true, notes: [], errors: [], checks: {} };
  const gl = createGLContext(canvas, {});
  if (!gl) { report.ok = false; report.errors.push('no webgl2'); return report; }

  const W = 320, H = 180;                 // output size
  const RW = 320, RH = 180;               // render (proc) size

  const fakeRenderer = {
    quality: { name: 'ultra', bloom: true, ssao: true },
    width: W, height: H, renderWidth: RW, renderHeight: RH
  };

  // ---- 1. construction / shader compile ----
  let fx = null;
  try {
    fx = new PostFX(gl, fakeRenderer);
  } catch (err) {
    report.ok = false;
    report.errors.push('PostFX constructor threw: ' + err.message);
    return report;
  }
  glErrors(gl, 'after-construct', report.errors);
  report.checks.compiled = {
    ssao: !!fx.ssaoShader, aoBlur: !!fx.aoBlurShader, bright: !!fx.brightShader,
    down: !!fx.downsampleShader, up: !!fx.upsampleShader,
    composite: !!fx.compositeShader, fxaa: !!fx.fxaaShader,
    bloomLevels: fx.bloomLevels, floatTargets: fx.floatTargets,
    aoTexture: !!fx.aoTexture
  };

  // ---- contract surface ----
  const api = ['resize', 'render', 'dispose', 'setEnabled'];
  report.checks.api = {};
  for (const k of api) report.checks.api[k] = typeof fx[k];
  report.checks.api.renderArity = PostFX.prototype.render.length;
  report.checks.api.defaults = Object.keys(POSTFX_DEFAULTS);

  // ---- scene targets ----
  const hdr = new RenderTarget(gl, RW, RH, {
    colorFormat: 'rgba16f', depth: true, depthTexture: true, filter: 'linear', wrap: 'clamp'
  });
  const out = new RenderTarget(gl, W, H, {
    colorFormat: 'rgba8', depth: false, filter: 'nearest', wrap: 'clamp'
  });
  const fill = new Shader(gl, VS, FS_FILL, {}, 'probe/fill');
  const depthScene = new Shader(gl, VS, FS_DEPTH_SCENE, {}, 'probe/depthscene');
  glErrors(gl, 'probe-setup', report.errors);

  const proj = mat4.create();
  mat4.perspective(proj, 62 * Math.PI / 180, RW / RH, 0.12, 1400);
  const invProj = mat4.create();
  mat4.invert(invProj, proj);
  const camera = { proj, invProj };

  function fillHdr(mode, base, spot, depth) {
    hdr.bind(true);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.ALWAYS);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    fill.use();
    fill.setVec4('uMode', mode, base[0], base[1], base[2]);
    fill.setVec4('uSpot', spot[0], spot[1], spot[2], spot[3]);
    fill.setFloat('uDepth', depth);
    drawFullscreen(gl);
    gl.depthFunc(gl.LEQUAL);
  }

  function fillDepthScene() {
    hdr.bind(true);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.ALWAYS);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    depthScene.use();
    depthScene.setMat4('uProj', proj);
    drawFullscreen(gl);
    gl.depthFunc(gl.LEQUAL);
  }

  const px = new Uint8Array(W * H * 4);
  function readOut() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.framebuffer);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  }
  function at(x, y) {
    const i = ((y * W) + x) * 4;
    return [px[i], px[i + 1], px[i + 2], px[i + 3]];
  }

  function runPost(params) {
    out.bind(true);
    gl.viewport(0, 0, W, H);
    fx.render(hdr.color(0), hdr.depthTex, camera, 1 / 60, params);
  }

  const neutral = {
    exposure: 1, bloomStrength: 0, bloomThreshold: 1.1, bloomKnee: 0.6, bloomRadius: 1,
    vignette: 0, grain: 0, chromatic: 0, saturation: 1, contrast: 1,
    rain: 0, wetness: 0, damageFlash: 0, deathFade: 0, ssao: 0, speedBlur: 0
  };

  /* =================== A. neutral passthrough (tonemap off, fxaa off) ============ */
  fx.setEnabled('tonemap', false);
  fx.setEnabled('fxaa', false);
  fillHdr(0, [0.25, 0.5, 0.75], [0, 0, 0, 0], 0.5);
  runPost(neutral);
  glErrors(gl, 'neutral-pass', report.errors);
  readOut();
  const centre = at(W >> 1, H >> 1);
  const expect = [srgb(0.25) * 255, srgb(0.5) * 255, srgb(0.75) * 255];
  report.checks.neutral = {
    got: centre.slice(0, 3),
    expect: expect.map((v) => Math.round(v)),
    maxErr: Math.max(...expect.map((v, i) => Math.abs(v - centre[i])))
  };
  // corner sample proves vignette/aberration really are off
  report.checks.neutralCorner = at(2, 2).slice(0, 3);

  /* =================== B. state / binding restoration ============================ */
  const prevFbo = out.framebuffer;
  out.bind(true);
  gl.viewport(0, 0, W, H);
  fx.render(hdr.color(0), hdr.depthTex, camera, 1 / 60, neutral);
  const vp = gl.getParameter(gl.VIEWPORT);
  report.checks.restore = {
    framebufferRestored: gl.getParameter(gl.FRAMEBUFFER_BINDING) === prevFbo,
    viewport: [vp[0], vp[1], vp[2], vp[3]],
    depthTest: gl.getParameter(gl.DEPTH_TEST),
    depthMask: gl.getParameter(gl.DEPTH_WRITEMASK),
    cullFace: gl.getParameter(gl.CULL_FACE),
    blend: gl.getParameter(gl.BLEND),
    blendSrcRGB: gl.getParameter(gl.BLEND_SRC_RGB),
    blendDstRGB: gl.getParameter(gl.BLEND_DST_RGB),
    blendColor: Array.from(gl.getParameter(gl.BLEND_COLOR) || [])
  };

  /* =================== C. bloom energy on a flat field =========================== */
  fx.setEnabled('fxaa', false);
  fillHdr(0, [0.5, 0.5, 0.5], [0, 0, 0, 0], 0.5);
  const bloomParams = Object.assign({}, neutral, {
    bloomStrength: 1, bloomThreshold: 0, bloomKnee: 0.05
  });
  runPost(bloomParams);
  glErrors(gl, 'bloom-flat', report.errors);
  readOut();
  const flat = at(W >> 1, H >> 1);
  report.checks.bloomFlatEnergy = {
    got: flat.slice(0, 3),
    // scene 0.5 + bloom 0.5 = 1.0 linear -> 255 in sRGB
    expectApprox: Math.round(srgb(1.0) * 255),
    // if bloom were dropped entirely we would see srgb(0.5)
    withoutBloom: Math.round(srgb(0.5) * 255)
  };

  /* =================== D. bloom shape (boxiness / smoothness) ==================== */
  fillHdr(1, [0.0, 0.0, 0.0], [0.5, 0.5, 0.02, 12.0], 0.5);
  runPost(Object.assign({}, neutral, { bloomStrength: 1, bloomThreshold: 1.0, bloomKnee: 0.5 }));
  glErrors(gl, 'bloom-spot', report.errors);
  readOut();
  const cx = W >> 1, cy = H >> 1;
  const R = 40;
  const axis = at(cx + R, cy)[1];
  const diagN = Math.round(R / Math.SQRT2);
  const diag = at(cx + diagN, cy + diagN)[1];
  const prof = [];
  for (let d = 0; d <= 70; d += 5) prof.push(at(Math.min(W - 1, cx + d), cy)[1]);
  report.checks.bloomShape = { profileAlongX: prof, axisAt40: axis, diagAt40: diag };

  /* =================== E. SSAO ==================================================== */
  fillDepthScene();
  fx.setEnabled('fxaa', false);
  const aoParams = Object.assign({}, neutral, { ssao: 1 });
  out.bind(true);
  gl.viewport(0, 0, W, H);
  fx.render(hdr.color(0), hdr.depthTex, camera, 1 / 60, aoParams);
  glErrors(gl, 'ssao', report.errors);
  // read the published AO texture directly
  const aoRt = fx._aoBlur;
  const aw = aoRt.width, ah = aoRt.height;
  const aoPx = new Uint8Array(aw * ah * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, aoRt.framebuffer);
  gl.readPixels(0, 0, aw, ah, gl.RGBA, gl.UNSIGNED_BYTE, aoPx);
  glErrors(gl, 'ssao-read', report.errors);
  let aoMin = 255, aoMax = 0, aoSum = 0;
  for (let i = 0; i < aw * ah; i++) {
    const v = aoPx[i * 4];
    if (v < aoMin) aoMin = v;
    if (v > aoMax) aoMax = v;
    aoSum += v;
  }
  // sample a row across the box/floor crease
  const row = Math.floor(ah * 0.45);
  const scan = [];
  for (let x = 0; x < aw; x += Math.max(1, aw >> 5)) scan.push(aoPx[(row * aw + x) * 4]);
  report.checks.ssao = {
    size: [aw, ah], min: aoMin, max: aoMax, mean: +(aoSum / (aw * ah)).toFixed(1), scanRow: scan
  };

  /* =================== F. FXAA does not eat a flat image ========================= */
  fx.setEnabled('fxaa', true);
  fillHdr(0, [0.25, 0.5, 0.75], [0, 0, 0, 0], 0.5);
  runPost(neutral);
  glErrors(gl, 'fxaa', report.errors);
  readOut();
  report.checks.fxaaFlat = { got: at(W >> 1, H >> 1).slice(0, 3), expect: report.checks.neutral.expect };

  /* =================== G. FXAA on a hard edge (should smooth, not shift) ========= */
  fillHdr(2, [1.0, 1.0, 1.0], [0, 0, 0, 0], 0.5);
  runPost(neutral);
  readOut();
  const gradRow = [];
  for (let x = 0; x < W; x += 32) gradRow.push(at(x, H >> 1)[0]);
  report.checks.fxaaGradient = gradRow;

  /* =================== H. tonemap on, defaults, sanity ========================== */
  fx.setEnabled('tonemap', true);
  fillHdr(0, [0.18, 0.18, 0.18], [0, 0, 0, 0], 0.5);
  runPost(null);   // exercise the default-parameter path
  glErrors(gl, 'defaults', report.errors);
  readOut();
  report.checks.defaultsMidGrey = { got: at(W >> 1, H >> 1).slice(0, 3), corner: at(2, 2).slice(0, 3) };

  /* =================== I. rain / wet / damage / death do not NaN ================= */
  const heavy = Object.assign({}, neutral, {
    rain: 1, wetness: 1, damageFlash: 0.5, deathFade: 0.5, grain: 0.05, chromatic: 1,
    speedBlur: 1, bloomStrength: 0.6, ssao: 1, saturation: 1.2, contrast: 1.1, vignette: 0.4
  });
  fillDepthScene();
  runPost(heavy);
  glErrors(gl, 'heavy', report.errors);
  readOut();
  let black = 0, nan = 0;
  for (let i = 0; i < W * H; i++) {
    if (px[i * 4] === 0 && px[i * 4 + 1] === 0 && px[i * 4 + 2] === 0) black++;
    if (px[i * 4 + 3] !== 255) nan++;
  }
  report.checks.heavy = { blackPixels: black, totalPixels: W * H, badAlpha: nan,
    centre: at(W >> 1, H >> 1).slice(0, 3) };

  /* =================== J. quality low path + resize ============================== */
  fakeRenderer.quality = { name: 'low', bloom: false, ssao: false };
  fx.resize(W, H);
  report.checks.lowQuality = { aoTexture: !!fx.aoTexture, bloomLevels: fx.bloomLevels };
  fillHdr(0, [0.4, 0.4, 0.4], [0, 0, 0, 0], 0.5);
  runPost(Object.assign({}, neutral, { ssao: 1, bloomStrength: 1 }));
  glErrors(gl, 'low-quality', report.errors);
  readOut();
  report.checks.lowQualityPixel = at(W >> 1, H >> 1).slice(0, 3);

  fakeRenderer.quality = { name: 'ultra', bloom: true, ssao: true };
  fakeRenderer.renderWidth = 160; fakeRenderer.renderHeight = 90;
  fx.resize(W, H);
  glErrors(gl, 'resize', report.errors);
  report.checks.afterResize = { bloomLevels: fx.bloomLevels, ao: !!fx.aoTexture,
    procW: fx.procWidth, procH: fx.procHeight, ldr: [fx._ldr.width, fx._ldr.height] };

  /* =================== K. null-safety ============================================ */
  try {
    out.bind(true);
    fx.render(hdr.color(0), null, null, 1 / 60, neutral);
    report.checks.nullDepthOk = true;
  } catch (e) {
    report.checks.nullDepthOk = 'threw: ' + e.message;
  }
  glErrors(gl, 'null-depth', report.errors);

  report.ok = report.errors.length === 0;
  return report;
}
