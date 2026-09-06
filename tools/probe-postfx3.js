/** Phase-3 probe: bloom energy/threshold measured directly, chromatic fringe, speed blur,
 *  FXAA-vs-grain interaction, SSAO around a real crease. */
import { createGLContext, RenderTarget, Shader, drawFullscreen } from '../js/core/gl.js';
import { PostFX } from '../js/render/postfx.js';
import { mat4 } from '../js/core/math.js';

const VS = `
out vec2 vUv;
void main(){ vec2 p=vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); vUv=p; gl_Position=vec4(p*2.0-1.0,0.0,1.0); }
`;
const FS = `
in vec2 vUv; out vec4 fragColor;
uniform vec4 uA;  // x mode, yzw colour
uniform vec4 uB;  // spot cx, cy, r, intensity
void main(){
  vec3 c = uA.yzw;
  if (uA.x > 2.5) {            // horizontal split (top/bottom) for radial CA measurement
    c = vUv.y < 0.5 ? vec3(0.0) : uA.yzw;
  } else if (uA.x > 1.5) {     // vertical split near the left edge
    c = vUv.x < 0.12 ? vec3(0.0) : uA.yzw;
  } else if (uA.x > 0.5) {     // spot
    float d = length((vUv - uB.xy) * vec2(1.7777, 1.0));
    c += vec3(uB.w) * step(d, uB.z);
  }
  gl_FragDepth = 0.5; fragColor = vec4(c, 1.0);
}
`;
const ERRN = { 0x0500: 'INVALID_ENUM', 0x0501: 'INVALID_VALUE', 0x0502: 'INVALID_OPERATION' };

export default async function probe({ canvas }) {
  const rep = { errors: [], checks: {} };
  const gl = createGLContext(canvas, {});
  const W = 512, H = 288;
  const fake = { quality: { name: 'ultra', bloom: true, ssao: true }, width: W, height: H, renderWidth: W, renderHeight: H };
  const fx = new PostFX(gl, fake);
  const hdr = new RenderTarget(gl, W, H, { colorFormat: 'rgba16f', depth: true, depthTexture: true, filter: 'linear', wrap: 'clamp' });
  const out = new RenderTarget(gl, W, H, { colorFormat: 'rgba8', depth: false, filter: 'nearest', wrap: 'clamp' });
  const sh = new Shader(gl, VS, FS, {}, 'probe/scene');
  const proj = mat4.create(); mat4.perspective(proj, 62 * Math.PI / 180, W / H, 0.12, 1400);
  const invProj = mat4.create(); mat4.invert(invProj, proj);
  const camera = { proj, invProj };

  const base = { exposure: 1, bloomStrength: 0, bloomThreshold: 1.1, bloomKnee: 0.6, bloomRadius: 1,
    vignette: 0, grain: 0, chromatic: 0, saturation: 1, contrast: 1, rain: 0, wetness: 0,
    damageFlash: 0, deathFade: 0, ssao: 0, speedBlur: 0 };

  function paint(mode, col, spot) {
    hdr.bind(true);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.ALWAYS); gl.depthMask(true);
    gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    sh.use();
    sh.setVec4('uA', mode, col[0], col[1], col[2]);
    sh.setVec4('uB', spot[0], spot[1], spot[2], spot[3]);
    drawFullscreen(gl); gl.depthFunc(gl.LEQUAL);
  }
  const px = new Uint8Array(W * H * 4);
  function run(p) { out.bind(true); gl.viewport(0, 0, W, H); fx.render(hdr.color(0), hdr.depthTex, camera, 1 / 60, p); gl.bindFramebuffer(gl.FRAMEBUFFER, out.framebuffer); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); }
  const at = (x, y) => { const i = ((y * W) + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };

  fx.setEnabled('fxaa', false);
  fx.setEnabled('tonemap', false);

  /* ---- 1. bloom mip0 content: threshold + energy, read straight off the target ---- */
  const mip = fx._bloom[0];
  const mp = new Float32Array(mip.width * mip.height * 4);
  function readMip() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, mip.framebuffer);
    gl.readPixels(0, 0, mip.width, mip.height, gl.RGBA, gl.FLOAT, mp);
    const c = ((((mip.height >> 1) * mip.width) + (mip.width >> 1)) * 4);
    let sum = 0;
    for (let i = 0; i < mip.width * mip.height; i++) sum += mp[i * 4 + 1];
    return { centre: +mp[c + 1].toFixed(4), mean: +(sum / (mip.width * mip.height)).toFixed(4) };
  }
  const thresholdCurve = [];
  for (const level of [0.4, 0.8, 1.0, 1.1, 1.3, 1.6, 2.0, 4.0]) {
    paint(0, [level, level, level], [0, 0, 0, 0]);
    run(Object.assign({}, base, { bloomStrength: 1 }));
    thresholdCurve.push({ level, bloom: readMip().centre });
  }
  rep.checks.bloomThresholdCurve = thresholdCurve;

  /* ---- 2. bloom halo profile from a small bright spot (smoothness / boxiness) ---- */
  paint(1, [0, 0, 0], [0.5, 0.5, 0.015, 40]);
  run(Object.assign({}, base, { bloomStrength: 1, exposure: 0.02 }));
  const cx = W >> 1, cy = H >> 1;
  const prof = [], profD = [];
  for (let d = 4; d <= 120; d += 8) {
    prof.push(at(Math.min(W - 1, cx + d), cy)[1]);
    const q = Math.round(d / Math.SQRT2);
    profD.push(at(cx + q, cy + q)[1]);
  }
  let ratio = [];
  for (let i = 0; i < prof.length; i++) ratio.push(prof[i] === 0 ? 0 : +(profD[i] / prof[i]).toFixed(2));
  rep.checks.bloomHalo = { axis: prof, diagonal: profD, diagOverAxis: ratio };

  /* ---- 3. chromatic aberration: radial split measured on a horizontal edge ---- */
  // Top/bottom split: at x = centre the radial direction is vertical, so R and B separate
  // vertically by a measurable number of rows.
  paint(3, [1, 1, 1], [0, 0, 0, 0]);
  function edgeRow(chan, params) {
    run(params);
    let first = -1;
    for (let y = 0; y < H; y++) { if (at(cx, y)[chan] > 40) { first = y; break; } }
    return first;
  }
  const caOff = { r: edgeRow(0, Object.assign({}, base, { chromatic: 0 })), b: edgeRow(2, Object.assign({}, base, { chromatic: 0 })) };
  const caOn = { r: edgeRow(0, Object.assign({}, base, { chromatic: 0.35 })), b: edgeRow(2, Object.assign({}, base, { chromatic: 0.35 })) };
  rep.checks.chromatic = {
    off: caOff, on: caOn, splitRows: Math.abs(caOn.r - caOn.b),
    splitFractionOfHeight: +(Math.abs(caOn.r - caOn.b) / H).toFixed(4),
    pxAt1080p: +(Math.abs(caOn.r - caOn.b) / H * 1080).toFixed(1)
  };

  /* ---- 4. radial speed blur: aspect distortion ---- */
  paint(1, [0, 0, 0], [0.5, 0.5, 0.02, 6]);
  run(Object.assign({}, base, { speedBlur: 1, exposure: 0.4 }));
  let horiz = 0, vert = 0;
  for (let d = 0; d < 120; d++) { if (at(Math.min(W - 1, cx + d), cy)[1] > 20) horiz = d; }
  for (let d = 0; d < 120; d++) { if (at(cx, Math.min(H - 1, cy + d))[1] > 20) vert = d; }
  rep.checks.speedBlurExtent = { horizontalPx: horiz, verticalPx: vert };

  /* ---- 5. FXAA vs grain: does AA eat/chase the grain? ---- */
  fx.setEnabled('tonemap', true);
  function sdOf() {
    let s = 0, s2 = 0, n = 0;
    for (let y = 80; y < 200; y++) for (let x = 120; x < 400; x++) { const v = px[((y * W) + x) * 4]; s += v; s2 += v * v; n++; }
    const m = s / n; return { mean: +m.toFixed(2), sd: +Math.sqrt(s2 / n - m * m).toFixed(3) };
  }
  paint(0, [0.18, 0.18, 0.18], [0, 0, 0, 0]);
  fx.setEnabled('fxaa', false); run(Object.assign({}, base, { grain: 0.03 })); const noAA = sdOf();
  fx.setEnabled('fxaa', true); run(Object.assign({}, base, { grain: 0.03 })); const withAA = sdOf();
  fx.setEnabled('fxaa', false); run(Object.assign({}, base, { grain: 0 })); const clean = sdOf();
  rep.checks.fxaaVsGrain = { clean, grainNoAA: noAA, grainWithAA: withAA,
    grainSurvival: +(withAA.sd / Math.max(1e-6, noAA.sd)).toFixed(3) };

  /* ---- 6. grain black-lift, measured as the DC shift of a near-black surface ---- */
  const lifts = [];
  for (const lin of [0.0, 0.002, 0.01, 0.05, 0.18]) {
    fx.setEnabled('fxaa', false);
    paint(0, [lin, lin, lin], [0, 0, 0, 0]);
    run(Object.assign({}, base, { grain: 0 })); const a = sdOf();
    run(Object.assign({}, base, { grain: 0.03 })); const b = sdOf();
    lifts.push({ linear: lin, cleanMean: a.mean, grainMean: b.mean, dcShift: +(b.mean - a.mean).toFixed(2), sd: b.sd });
  }
  rep.checks.grainBlackLift = lifts;

  let e = gl.getError(); while (e) { rep.errors.push(ERRN[e] || e); e = gl.getError(); }
  rep.ok = rep.errors.length === 0;
  return rep;
}
