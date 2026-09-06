/** Measures the per-call cost of the GL state queries sky.render() uses. */
import { createGLContext, RenderTarget } from '/js/core/gl.js';

export default async function run({ canvas }) {
  canvas.width = 64; canvas.height = 64;
  const gl = createGLContext(canvas, {});
  const rt = new RenderTarget(gl, 64, 64, { colorFormat: 'rgba16f', depth: true });
  rt.bind(true);
  const N = 2000;
  const out = {};
  const bench = (name, fn) => {
    for (let i = 0; i < 200; i++) fn();      // warm up
    const t0 = performance.now();
    for (let i = 0; i < N; i++) fn();
    out[name] = +(((performance.now() - t0) / N) * 1000).toFixed(2) + ' us';
  };
  bench('isEnabled(BLEND)', () => gl.isEnabled(gl.BLEND));
  bench('isEnabled(CULL_FACE)', () => gl.isEnabled(gl.CULL_FACE));
  bench('getParameter(DEPTH_FUNC)', () => gl.getParameter(gl.DEPTH_FUNC));
  bench('getParameter(DEPTH_WRITEMASK)', () => gl.getParameter(gl.DEPTH_WRITEMASK));
  bench('getParameter(VIEWPORT)', () => gl.getParameter(gl.VIEWPORT));
  bench('depthFunc()', () => gl.depthFunc(gl.LEQUAL));
  bench('depthMask()', () => gl.depthMask(false));
  return out;
}
