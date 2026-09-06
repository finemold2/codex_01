/** Fill-rate of the sky pass at 1280x720, forced to complete with a readPixels sync. */
import { createGLContext, RenderTarget, Shader } from '/js/core/gl.js';
import { mat4, DEG2RAD } from '/js/core/math.js';
import { Sky } from '/js/render/sky.js';

export default async function run({ canvas }) {
  canvas.width = 64; canvas.height = 64;
  const gl = createGLContext(canvas, {});
  const sky = new Sky(gl, { quality: { name: 'high' }, hdr: { width: 1280, height: 720 } });
  sky.precompile();
  const rt = new RenderTarget(gl, 1280, 720, { colorFormat: 'rgba16f', depth: true });
  const p = new Float32Array([0, 20, 0]);
  const view = mat4.lookAt(mat4.create(), p, [0, 20.2, -1], [0, 1, 0]);
  const proj = mat4.perspective(mat4.create(), 62 * DEG2RAD, 1280 / 720, 0.1, 4000);
  const cam = { position: p, fov: 62, view, proj,
    invView: mat4.invert(mat4.create(), view), invProj: mat4.invert(mat4.create(), proj) };
  const px = new Float32Array(4);
  const out = {};

  // A copy of the current shader with the quadrature reverted to the arithmetic midpoint +
  // whole-segment self-extinction, to price the correctness fix.
  const before = sky._shader('high');
  const revert = (s) => s
    .replace('vec3 p = ro + rd * tMid;', 'vec3 p = ro + rd * (tPrev + dt * 0.5);')
    .replace('vec3 tauView = BETA_R * (odR + dR * 0.5) + betaMe * (odM + dM * 0.5) + BETA_O3 * (odO + dO * 0.5);',
      'vec3 tauView = BETA_R * (odR + dR) + betaMe * (odM + dM) + BETA_O3 * (odO + dO);');
  let old = null;
  try { old = new Shader(gl, before.vertexSource, revert(before.fragmentSource), {}, 'skyOld'); }
  catch (e) { out.oldShaderError = e.message.slice(0, 200); }

  // Each iteration is drained individually, and the two configurations under test are
  // interleaved, so scheduler noise hits both equally. Report the median.
  const one = (fn) => {
    const t0 = performance.now();
    fn();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px);
    return performance.now() - t0;
  };
  const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];

  sky.setTimeOfDay(12); sky.update(0, 0);
  const draw = () => { rt.bind(true); sky.render(cam); };
  for (const q of ['low', 'medium', 'high', 'ultra']) {
    sky.setQuality(q); sky.update(0, 0);
    for (let i = 0; i < 3; i++) one(draw);
    const t = []; for (let i = 0; i < 9; i++) t.push(one(draw));
    out['1280x720 ' + q] = +med(t).toFixed(1) + ' ms';
  }
  if (old) {
    sky.setQuality('high'); sky.update(0, 0);
    const a = []; const b = [];
    for (let i = 0; i < 9; i++) {
      sky._shaders.set('high', before); a.push(one(draw));
      sky._shaders.set('high', old); b.push(one(draw));
    }
    sky._shaders.set('high', before);
    out['high fixed quadrature'] = +med(a).toFixed(1) + ' ms';
    out['high old quadrature'] = +med(b).toFixed(1) + ' ms';
    out['fix cost'] = ((med(a) / med(b) - 1) * 100).toFixed(1) + '%';
  }
  out.note = 'SwiftShader CPU rasteriser; treat as a relative cost, not a GPU number';
  rt.dispose(); sky.dispose();
  return out;
}
