/** Isolated A/B of the old (three nested blur loops) vs new (one shared radial loop)
 *  sceneFetch, benchmarked interleaved in one context so machine noise cancels. */
import { createGLContext, RenderTarget, Shader, drawFullscreen } from '../js/core/gl.js';

const VS = `out vec2 vUv;
void main(){ vec2 p=vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); vUv=p; gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;

const COMMON = `
in vec2 vUv; out vec4 fragColor;
uniform sampler2D uHdr;
uniform float uChromatic;
uniform float uSpeedBlur;
uniform float uAspect;
`;

const OLD = COMMON + `
vec3 sceneAt(vec2 uv) { return texture(uHdr, uv).rgb; }
vec3 sceneBlurred(vec2 uv) {
  if (uSpeedBlur <= 0.0) return sceneAt(uv);
  vec2 dir = (uv - vec2(0.5)) * (uSpeedBlur * 0.11);
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for (int i = 0; i < MB_TAPS; i++) {
    float t = float(i) / float(MB_TAPS - 1);
    float w = 1.0 - 0.72 * t;
    acc += sceneAt(clamp(uv - dir * t, vec2(0.0), vec2(1.0))) * w;
    wsum += w;
  }
  return acc / wsum;
}
vec3 sceneFetch(vec2 uv, float radial) {
  if (uChromatic <= 0.0) return sceneBlurred(uv);
  vec2 dir = (uv - vec2(0.5));
  vec2 offset = dir * (uChromatic * radial * radial * 0.024);
  vec3 col;
  col.r = sceneBlurred(clamp(uv + offset, vec2(0.0), vec2(1.0))).r;
  col.g = sceneBlurred(uv).g;
  col.b = sceneBlurred(clamp(uv - offset, vec2(0.0), vec2(1.0))).b;
  return col;
}
void main(){
  vec2 c = (vUv - 0.5) * vec2(uAspect, 1.0);
  fragColor = vec4(sceneFetch(vUv, clamp(length(c) * 1.42, 0.0, 2.0)), 1.0);
}`;

const NEW = COMMON + `
vec3 sceneAt(vec2 uv) { return texture(uHdr, clamp(uv, vec2(0.0), vec2(1.0))).rgb; }
vec3 sceneFetch(vec2 uv, float radial) {
  vec2 centred = uv - vec2(0.5);
  vec2 offset = uChromatic > 0.0 ? centred * (uChromatic * radial * radial * 0.024) : vec2(0.0);
  if (uSpeedBlur <= 0.0) {
    if (uChromatic <= 0.0) return sceneAt(uv);
    return vec3(sceneAt(uv + offset).r, sceneAt(uv).g, sceneAt(uv - offset).b);
  }
  vec2 dir = centred * (uSpeedBlur * 0.11);
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for (int i = 0; i < MB_TAPS; i++) {
    float t = float(i) / float(MB_TAPS - 1);
    float w = 1.0 - 0.72 * t;
    vec2 p = uv - dir * t;
    vec3 col = sceneAt(p);
    if (uChromatic > 0.0) {
      col.r = sceneAt(p + offset).r;
      col.b = sceneAt(p - offset).b;
    }
    acc += col * w;
    wsum += w;
  }
  return acc / wsum;
}
void main(){
  vec2 c = (vUv - 0.5) * vec2(uAspect, 1.0);
  fragColor = vec4(sceneFetch(vUv, clamp(length(c) * 1.42, 0.0, 2.0)), 1.0);
}`;

export default async function probe({ canvas }) {
  const gl = createGLContext(canvas, {});
  const W = 640, H = 360;
  const src = new RenderTarget(gl, W, H, { colorFormat: 'rgba16f', depth: false, filter: 'linear', wrap: 'clamp' });
  const dst = new RenderTarget(gl, W, H, { colorFormat: 'rgba8', depth: false, filter: 'nearest', wrap: 'clamp' });
  src.setClearColor(0.4, 0.5, 0.6, 1); src.bind(true);
  const oldSh = new Shader(gl, VS, OLD, { MB_TAPS: 8 }, 'ab/old');
  const newSh = new Shader(gl, VS, NEW, { MB_TAPS: 8 }, 'ab/new');
  gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
  const one = new Uint8Array(4);
  function bench(sh, chroma, blur, n) {
    sh.use();
    sh.setTexture('uHdr', src.color(0), 0);
    sh.setFloat('uChromatic', chroma); sh.setFloat('uSpeedBlur', blur); sh.setFloat('uAspect', W / H);
    for (let i = 0; i < 4; i++) { dst.bind(false); drawFullscreen(gl); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.framebuffer);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one);
    const t = performance.now();
    for (let i = 0; i < n; i++) { dst.bind(false); drawFullscreen(gl); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.framebuffer);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one);
    return (performance.now() - t) / n;
  }
  const N = 20, REPS = 5;
  const acc = { oldBoth: [], newBoth: [], oldBlur: [], newBlur: [] };
  for (let r = 0; r < REPS; r++) {
    acc.oldBoth.push(bench(oldSh, 0.35, 1, N));
    acc.newBoth.push(bench(newSh, 0.35, 1, N));
    acc.oldBlur.push(bench(oldSh, 0, 1, N));
    acc.newBlur.push(bench(newSh, 0, 1, N));
  }
  // Visual equivalence: render a textured source through both and diff every pixel.
  const noise = new Float32Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const x = i % W, y = (i / W) | 0;
    // A smooth, scene-like field: broad gradient plus two soft bright blobs. A high-frequency
    // pattern would exaggerate any sub-pixel tap shift into a meaningless diff.
    const u = x / W, w = y / H;
    const b1 = Math.exp(-(((u - 0.3) * 4) ** 2 + ((w - 0.6) * 4) ** 2)) * 5;
    const b2 = Math.exp(-(((u - 0.78) * 6) ** 2 + ((w - 0.35) * 6) ** 2)) * 8;
    const v = 0.25 + u * 0.6 + w * 0.3 + b1 + b2;
    noise[i * 4] = v; noise[i * 4 + 1] = v * 0.6; noise[i * 4 + 2] = v * 0.3; noise[i * 4 + 3] = 1;
  }
  src.color(0).update(noise, W, H);
  const bufA = new Uint8Array(W * H * 4), bufB = new Uint8Array(W * H * 4);
  function shot(sh, buf) {
    sh.use(); sh.setTexture('uHdr', src.color(0), 0);
    sh.setFloat('uChromatic', 0.35); sh.setFloat('uSpeedBlur', 1); sh.setFloat('uAspect', W / H);
    dst.bind(false); drawFullscreen(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.framebuffer);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  }
  shot(oldSh, bufA); shot(newSh, bufB);
  let maxDiff = 0, diffPixels = 0;
  for (let i = 0; i < W * H; i++) {
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(bufA[i * 4 + k] - bufB[i * 4 + k]));
    if (d > 0) diffPixels++;
    if (d > maxDiff) maxDiff = d;
  }

  const med = (a) => { const b = a.slice().sort((x, y) => x - y); return +b[b.length >> 1].toFixed(3); };
  const o = med(acc.oldBoth), nw = med(acc.newBoth);
  return {
    msPerPass: { oldBlurPlusChromatic: o, newBlurPlusChromatic: nw,
      oldBlurOnly: med(acc.oldBlur), newBlurOnly: med(acc.newBlur) },
    speedup: +(o / nw).toFixed(3),
    savedPct: +(100 * (1 - nw / o)).toFixed(1),
    visualEquivalence: { maxChannelDiff: maxDiff, differingPixels: diffPixels, totalPixels: W * H },
    size: [W, H], iterations: N, reps: REPS
  };
}
