/**
 * Headless WebGL2 conformance probe for js/core/gl.js.
 *
 * Exercises shader compilation, instanced meshes, sRGB/mipmapped textures, HDR float render
 * targets, float readback, the fullscreen triangle and target resizing, asserting zero GL errors.
 *
 * Run: node tools/gl-probe.mjs tools/probe-gl.js
 */
import { createGLContext, Shader, GpuMesh, Texture2D, RenderTarget, drawFullscreen } from '/js/core/gl.js';
import { box, sphere, mergeGeometries } from '/js/core/geometry.js';

export default async function run({ canvas }) {
  const out = { errors: [], notes: [] };
  const gl = createGLContext(canvas, {});
  if (!gl) { out.errors.push('no webgl2'); return out; }
  out.notes.push('ext: ' + JSON.stringify(Object.keys(gl.__ext || {})));

  const err = (tag) => { const e = gl.getError(); if (e) out.errors.push(`${tag}: gl error 0x${e.toString(16)}`); };

  // --- shader ---
  let sh;
  try {
    sh = new Shader(gl, `
      layout(location=0) in vec3 aPos;
      layout(location=1) in vec3 aNormal;
      layout(location=2) in vec2 aUV;
      layout(location=4) in vec4 iM0;
      layout(location=5) in vec4 iM1;
      layout(location=6) in vec4 iM2;
      layout(location=7) in vec4 iM3;
      layout(location=8) in vec4 iTint;
      uniform mat4 uMVP; out vec3 vN; out vec2 vUV; out vec4 vTint;
      void main(){ mat4 M = mat4(iM0, iM1, iM2, iM3);
        vN = aNormal; vUV = aUV; vTint = iTint;
        gl_Position = uMVP * M * vec4(aPos, 1.0); }`, `
      in vec3 vN; in vec2 vUV; in vec4 vTint; uniform sampler2D uTex; uniform vec3 uColor;
      out vec4 fragColor;
      void main(){ float d = max(dot(normalize(vN), normalize(vec3(0.4,0.8,0.3))), 0.0);
        fragColor = vec4(uColor * vTint.rgb * (0.4 + 2.0 * d) * texture(uTex, vUV).rgb, 1.0); }`, {}, 'probe');
  } catch (e) { out.errors.push('shader: ' + e.message); return out; }
  err('shader');

  // --- mesh ---
  const geo = mergeGeometries([{ geometry: box(1, 1, 1) }, { geometry: sphere(0.6, 12, 8) }]);
  const mesh = new GpuMesh(gl, geo);
  out.notes.push(`mesh indexCount=${mesh.indexCount} bounds=${JSON.stringify(mesh.bounds)}`);
  err('mesh');

  // instancing
  try {
    mesh.enableInstancing(64, 20);
    const data = new Float32Array(64 * 20);
    for (let i = 0; i < 64; i++) {
      const o = i * 20;
      data[o] = 1; data[o + 5] = 1; data[o + 10] = 1; data[o + 15] = 1;
      data[o + 12] = ((i % 8) - 3.5) * 0.4; data[o + 13] = (((i / 8) | 0) - 3.5) * 0.4;
      data[o + 16] = 1; data[o + 17] = 1; data[o + 18] = 1; data[o + 19] = 1;
    }
    mesh.setInstanceData(data, 64);
  } catch (e) { out.errors.push('instancing: ' + e.message); }
  err('instancing');

  // --- texture ---
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#345'; ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#fc0'; ctx.fillRect(0, 0, 32, 32);
  let tex;
  try { tex = Texture2D.fromCanvas(gl, c, { srgb: true, mipmaps: true, wrap: 'repeat', anisotropy: 8 }); }
  catch (e) { out.errors.push('texture: ' + e.message); }
  err('texture');
  try { Texture2D.solid(gl, 255, 0, 0, 255); } catch (e) { out.errors.push('solid: ' + e.message); }

  // --- render target ---
  let rt;
  try {
    rt = new RenderTarget(gl, 256, 256, { colorFormat: 'rgba16f', depth: true, depthTexture: true, filter: 'linear' });
    rt.bind(true);
  } catch (e) { out.errors.push('rendertarget: ' + e.message); }
  err('rendertarget');

  // --- draw ---
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0.05, 0.06, 0.09, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  sh.use();
  const mvp = new Float32Array([0.5,0,0,0, 0,0.9,0,0, 0,0,-1,0, 0,0,-0.5,1]);
  sh.setMat4('uMVP', mvp);
  sh.setVec3('uColor', 1, 0.8, 0.4);
  sh.setTexture('uTex', tex, 0);
  mesh.draw(64);
  err('draw-instanced');

  // read back from the HDR target
  const px = new Float32Array(4 * 64 * 64);
  try {
    gl.readPixels(96, 96, 64, 64, gl.RGBA, gl.FLOAT, px);
    let mx = 0; let nz = 0;
    for (let i = 0; i < px.length; i += 4) { mx = Math.max(mx, px[i]); if (px[i] > 0.08) nz++; }
    out.notes.push(`hdr readback max=${mx.toFixed(3)} litPixels=${nz}`);
    if (nz < 10) out.errors.push('HDR target looks empty after an instanced draw');
  } catch (e) { out.notes.push('float readback unsupported: ' + e.message); }
  err('readback');

  // --- fullscreen triangle ---
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  const fs = new Shader(gl, `
    out vec2 vUv;
    void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); vUv = p; gl_Position = vec4(p*2.0-1.0,0.0,1.0); }`,
  `in vec2 vUv; uniform sampler2D uSrc; out vec4 fragColor;
    void main(){ fragColor = vec4(texture(uSrc, vUv).rgb, 1.0); }`, {}, 'fullscreen');
  fs.use();
  fs.setTexture('uSrc', rt.color(0), 0);
  gl.disable(gl.DEPTH_TEST);
  drawFullscreen(gl);
  err('fullscreen');

  const bytes = new Uint8Array(4 * 32 * 32);
  gl.readPixels((canvas.width >> 1) - 16, (canvas.height >> 1) - 16, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  const uniq = new Set();
  for (let i = 0; i < bytes.length; i += 4) uniq.add(bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2]);
  out.notes.push(`canvas unique colors=${uniq.size}`);
  if (uniq.size < 2) out.errors.push('fullscreen blit produced a flat image');

  rt.resize(128, 128); err('resize');
  return out;
}
