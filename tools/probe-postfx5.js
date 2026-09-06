/** Phase-5: does the composite darken the bloom halo with ambient occlusion?
 *  A black background + an off-screen-ish bright spot means the halo pixels have (almost) no
 *  scene contribution of their own, so any AO-dependence of those pixels comes from AO being
 *  multiplied into the bloom term. */
import { createGLContext, RenderTarget, Shader, drawFullscreen } from '../js/core/gl.js';
import { PostFX } from '../js/render/postfx.js';
import { mat4 } from '../js/core/math.js';

const VS = `out vec2 vUv;
void main(){ vec2 p=vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); vUv=p; gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;
// Colour: black everywhere except a small very bright disc on the left.
// Depth: a floor receding steeply, so SSAO finds real occlusion across the whole frame.
const FS = `in vec2 vUv; out vec4 fragColor;
uniform mat4 uProj; uniform float uFlat;
void main(){
  float z = uFlat > 0.5 ? -8.0 : -(3.0 + vUv.y * 60.0);
  vec4 clip = uProj * vec4(0.0, 0.0, z, 1.0);
  gl_FragDepth = (clip.z/clip.w) * 0.5 + 0.5;
  float d = length((vUv - vec2(0.28, 0.5)) * vec2(1.7777, 1.0));
  fragColor = vec4(vec3(80.0) * step(d, 0.02), 1.0);
}`;

export default async function probe({ canvas }) {
  const rep = { checks: {} };
  const gl = createGLContext(canvas, {});
  const W = 512, H = 288;
  const fake = { quality: { name: 'ultra', bloom: true, ssao: true }, width: W, height: H, renderWidth: W, renderHeight: H };
  const fx = new PostFX(gl, fake);
  fx.setEnabled('fxaa', false);
  fx.setEnabled('tonemap', false);
  fx.aoComposite = 1;          // public tunable: maximise the effect so it is unambiguous
  const hdr = new RenderTarget(gl, W, H, { colorFormat: 'rgba16f', depth: true, depthTexture: true, filter: 'linear', wrap: 'clamp' });
  const outRt = new RenderTarget(gl, W, H, { colorFormat: 'rgba8', depth: false, filter: 'nearest', wrap: 'clamp' });
  const sh = new Shader(gl, VS, FS, {}, 'probe/scene');
  const proj = mat4.create(); mat4.perspective(proj, 62 * Math.PI / 180, W / H, 0.12, 1400);
  const invProj = mat4.create(); mat4.invert(invProj, proj);
  const camera = { proj, invProj };
  const base = { exposure: 1, bloomStrength: 1, bloomThreshold: 1.1, bloomKnee: 0.6, bloomRadius: 1,
    vignette: 0, grain: 0, chromatic: 0, saturation: 1, contrast: 1, rain: 0, wetness: 0,
    damageFlash: 0, deathFade: 0, ssao: 0, speedBlur: 0 };
  const px = new Uint8Array(W * H * 4);
  function paint(flat) {
    hdr.bind(true); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.ALWAYS); gl.depthMask(true);
    gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    sh.use(); sh.setMat4('uProj', proj); sh.setFloat('uFlat', flat ? 1 : 0); drawFullscreen(gl); gl.depthFunc(gl.LEQUAL);
  }
  function run(p) { outRt.bind(true); gl.viewport(0, 0, W, H); fx.render(hdr.color(0), hdr.depthTex, camera, 1 / 60, p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, outRt.framebuffer); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); }
  const at = (x, y) => { const i = ((y * W) + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };

  paint(false);
  // prime the AO buffer (it is produced at the end of a frame, consumed the next)
  run(Object.assign({}, base, { ssao: 1 }));
  run(Object.assign({}, base, { ssao: 1 }));
  const withAo = [];
  const samples = [[180, 144], [200, 144], [230, 144], [260, 144]];
  for (const [x, y] of samples) withAo.push(at(x, y));

  run(Object.assign({}, base, { ssao: 0 }));
  const noAo = [];
  for (const [x, y] of samples) noAo.push(at(x, y));

  // the AO value at those pixels
  const rt = fx._aoBlur; const aw = rt.width, ah = rt.height;
  const ap = new Uint8Array(aw * ah * 4);
  run(Object.assign({}, base, { ssao: 1 }));
  gl.bindFramebuffer(gl.FRAMEBUFFER, rt.framebuffer);
  gl.readPixels(0, 0, aw, ah, gl.RGBA, gl.UNSIGNED_BYTE, ap);
  const aoAt = samples.map(([x, y]) => ap[((Math.floor(y * ah / H) * aw) + Math.floor(x * aw / W)) * 4]);

  // the scene's own (bloom-free) contribution at those pixels
  run(Object.assign({}, base, { ssao: 0, bloomStrength: 0 }));
  const sceneOnly = samples.map(([x, y]) => at(x, y));

  rep.checks.bloomHaloVsAo = samples.map(([x, y], i) => ({
    at: [x, y],
    sceneWithoutBloom: sceneOnly[i][1],
    haloNoAo: noAo[i][1],
    haloWithAo: withAo[i][1],
    aoCode: aoAt[i],
    haloDarkenedPct: noAo[i][1] === 0 ? null : +(100 * (1 - withAo[i][1] / noAo[i][1])).toFixed(1)
  }));
  rep.ok = true;
  return rep;
}
