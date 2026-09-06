/** Phase-4: chromatic fringe at the corner, off-centre speed blur, composite cost. */
import { createGLContext, RenderTarget, Shader, drawFullscreen } from '../js/core/gl.js';
import { PostFX } from '../js/render/postfx.js';
import { mat4 } from '../js/core/math.js';

const VS = `out vec2 vUv;
void main(){ vec2 p=vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); vUv=p; gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;
const FS = `in vec2 vUv; out vec4 fragColor;
uniform vec4 uA;   // x mode, yzw colour
uniform vec4 uB;   // spot cx, cy, r, intensity
void main(){
  vec3 c = uA.yzw;
  if (uA.x > 1.5) {                       // white quadrant filling the top-right corner
    c = (vUv.x > 0.75 && vUv.y > 0.75) ? uA.yzw : vec3(0.0);
  } else if (uA.x > 0.5) {
    float d = length((vUv - uB.xy) * vec2(1.7777, 1.0));
    c = uA.yzw + vec3(uB.w) * step(d, uB.z);
  }
  gl_FragDepth = 0.5; fragColor = vec4(c, 1.0);
}`;

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
  const px = new Uint8Array(W * H * 4);
  function paint(mode, col, spot) {
    hdr.bind(true); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.ALWAYS); gl.depthMask(true);
    gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    sh.use(); sh.setVec4('uA', mode, col[0], col[1], col[2]);
    sh.setVec4('uB', spot[0], spot[1], spot[2], spot[3]); drawFullscreen(gl); gl.depthFunc(gl.LEQUAL);
  }
  function run(p) { out.bind(true); gl.viewport(0, 0, W, H); fx.render(hdr.color(0), hdr.depthTex, camera, 1 / 60, p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.framebuffer); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); }
  const at = (x, y) => { const i = ((y * W) + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };

  fx.setEnabled('fxaa', false); fx.setEnabled('tonemap', false);

  /* --- chromatic: scan the vertical edge of a corner quadrant (x = 0.75 W) at the top row --- */
  paint(2, [1, 1, 1], [0, 0, 0, 0]);
  function edgeX(chan) {
    const y = H - 3;
    for (let x = 0; x < W; x++) if (at(x, y)[chan] > 40) return x;
    return -1;
  }
  run(Object.assign({}, base, { chromatic: 0 }));
  const off = [edgeX(0), edgeX(1), edgeX(2)];
  for (const amt of [0.07, 0.35, 1.0]) {
    run(Object.assign({}, base, { chromatic: amt }));
    const on = [edgeX(0), edgeX(1), edgeX(2)];
    rep.checks['chromatic_' + amt] = {
      edgeRGB: on, refRGB: off, splitPx: Math.abs(on[0] - on[2]),
      splitFractionOfWidth: +(Math.abs(on[0] - on[2]) / W).toFixed(4),
      pxAt1920: +(Math.abs(on[0] - on[2]) / W * 1920).toFixed(1)
    };
  }

  /* --- speed blur measured off centre --- */
  paint(1, [0, 0, 0], [0.78, 0.5, 0.012, 3]);
  run(Object.assign({}, base, { speedBlur: 0 }));
  const sy = H >> 1;
  function extent() { let lo = -1, hi = -1; for (let x = 0; x < W; x++) { if (at(x, sy)[1] > 20) { if (lo < 0) lo = x; hi = x; } } return { lo, hi, len: hi - lo }; }
  const e0 = extent();
  run(Object.assign({}, base, { speedBlur: 1 }));
  const e1 = extent();
  rep.checks.speedBlur = { noBlur: e0, blur: e1, streakGrewBy: e1.len - e0.len };

  /* --- cost: composite with speed blur, chromatic on vs off --- */
  paint(0, [0.4, 0.4, 0.4], [0, 0, 0, 0]);
  function bench(p, n) {
    // warm-up
    for (let i = 0; i < 3; i++) { out.bind(true); gl.viewport(0, 0, W, H); fx.render(hdr.color(0), hdr.depthTex, camera, 1 / 60, p); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.framebuffer); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t = performance.now();
    for (let i = 0; i < n; i++) { out.bind(true); gl.viewport(0, 0, W, H); fx.render(hdr.color(0), hdr.depthTex, camera, 1 / 60, p); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.framebuffer); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return +((performance.now() - t) / n).toFixed(3);
  }
  const N = 24;
  rep.checks.cost = {
    plain: bench(Object.assign({}, base), N),
    chromaticOnly: bench(Object.assign({}, base, { chromatic: 0.35 }), N),
    speedBlurOnly: bench(Object.assign({}, base, { speedBlur: 1 }), N),
    speedBlurPlusChromatic: bench(Object.assign({}, base, { speedBlur: 1, chromatic: 0.35 }), N)
  };
  rep.ok = true;
  return rep;
}
