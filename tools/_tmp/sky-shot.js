/** Renders a 2x3 contact sheet of the sky at six times of day, tonemapped for eyeballing. */
import { createGLContext, RenderTarget, Shader, drawFullscreen } from '/js/core/gl.js';
import { mat4, DEG2RAD } from '/js/core/math.js';
import { Sky } from '/js/render/sky.js';

const TONEMAP_FS = `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTex;
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
void main() {
  vec3 c = aces(texture(uTex, vUv).rgb);
  fragColor = vec4(pow(c, vec3(1.0 / 2.2)), 1.0);
}`;
const TONEMAP_VS = `
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export default async function run({ canvas }) {
  const COLS = 3; const ROWS = 2; const W = 420; const H = 260;
  canvas.width = COLS * W; canvas.height = ROWS * H;
  const gl = createGLContext(canvas, { preserveDrawingBuffer: true });
  const sky = new Sky(gl, { quality: { name: 'high' }, hdr: { width: W, height: H } });
  const rt = new RenderTarget(gl, W, H, { colorFormat: 'rgba16f', depth: true, filter: 'nearest' });
  const tone = new Shader(gl, TONEMAP_VS, TONEMAP_FS, {}, 'tone');

  // Optional: rebuild the shader as it was before the fix, for a before/after contact sheet.
  if (window.__shotArg === 'before') {
    const cur = sky._shader('high');
    const fs = cur.fragmentSource
      .replace('vec3 p = ro + rd * tMid;', 'vec3 p = ro + rd * (tPrev + dt * 0.5);')
      .replace('vec3 tauView = BETA_R * (odR + dR * 0.5) + betaMe * (odM + dM * 0.5) + BETA_O3 * (odO + dO * 0.5);',
        'vec3 tauView = BETA_R * (odR + dR) + betaMe * (odM + dM) + BETA_O3 * (odO + dO);')
      .replace('col = mix(col, uHorizonColor, 1.0 - exp(-tGround * uGroundFog));', '');
    sky._shaders.set('high', new Shader(gl, cur.vertexSource, fs, {}, 'skyBefore'));
  }

  const hours = [6.2, 9, 12, 17.6, 18.4, 1.0];
  const p = new Float32Array([0, 40, 0]);

  window.__shot = () => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    hours.forEach((h, i) => {
      sky.setTimeOfDay(h); sky.update(0.5, 0);
      // face the sun so the sunset/sunrise reads
      const st = sky.sunDirectionTrue;
      let hx = st[0]; let hz = st[2];
      const hl = Math.hypot(hx, hz) || 1; hx /= hl; hz /= hl;
      const view = mat4.lookAt(mat4.create(), p, [p[0] + hx, p[1] + 0.28, p[2] + hz], [0, 1, 0]);
      const proj = mat4.perspective(mat4.create(), 62 * DEG2RAD, W / H, 0.1, 4000);
      const cam = { position: p, fov: 62, view, proj,
        invView: mat4.invert(mat4.create(), view), invProj: mat4.invert(mat4.create(), proj) };
      rt.bind(true);
      gl.enable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.BLEND);
      sky.render(cam);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport((i % COLS) * W, (ROWS - 1 - Math.floor(i / COLS)) * H, W, H);
      gl.disable(gl.DEPTH_TEST);
      tone.use();
      tone.setTexture('uTex', rt.color(0), 0);
      drawFullscreen(gl);
    });
  };
  window.__shot();
  return { hours, note: 'ACES + gamma 2.2, camera at y=40 facing the sun, 62deg fov' };
}
