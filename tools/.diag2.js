import { createGLContext, Shader, drawFullscreen } from '/js/core/gl.js';
import { buildTextureLibrary } from '/js/render/textures.js';

export default async function run({ canvas }) {
  const out = { notes: [], gpu: {} };
  canvas.width = 256; canvas.height = 256;
  const gl = createGLContext(canvas, {});
  const tex = buildTextureLibrary(gl, { size: 256 });

  // Blit each texture to the screen with a trivial shader and read back the mean.
  const sh = new Shader(gl, `
    out vec2 vUv;
    void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); vUv = p; gl_Position = vec4(p*2.0-1.0,0.0,1.0); }`,
  `in vec2 vUv; uniform sampler2D uTex; uniform int uMode; out vec4 fragColor;
    void main(){ vec4 t = texture(uTex, vUv);
      fragColor = uMode == 0 ? vec4(t.rgb, 1.0) : vec4(vec3(t.a), 1.0); }`, {}, 'blit');

  const readMean = () => {
    const px = new Uint8Array(256 * 256 * 4);
    gl.readPixels(0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let r = 0, g = 0, b = 0, mn = 255, mx = 0;
    for (let i = 0; i < px.length; i += 4) {
      r += px[i]; g += px[i+1]; b += px[i+2];
      const l = (px[i]+px[i+1]+px[i+2])/3; if (l<mn) mn=l; if (l>mx) mx=l;
    }
    const n = px.length/4;
    return { r: +(r/n).toFixed(1), g: +(g/n).toFixed(1), b: +(b/n).toFixed(1), min: +mn.toFixed(0), max: +mx.toFixed(0) };
  };

  gl.disable(gl.DEPTH_TEST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, 256, 256);
  for (const k of ['officeFacade', 'glassFacade', 'apartmentFacade', 'groundFloorShops', 'concrete', 'sidewalk', 'brick']) {
    if (!tex[k]) continue;
    sh.use();
    sh.setTexture('uTex', tex[k], 0);
    // NOTE: these are sRGB textures, so the sampler linearises them. Values read back are LINEAR.
    sh.setInt('uMode', 0);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    drawFullscreen(gl);
    const rgb = readMean();
    sh.setInt('uMode', 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    drawFullscreen(gl);
    const a = readMean();
    out.gpu[k] = { rgbLinear: rgb, alpha: a.r, alphaRange: `${a.min}..${a.max}` };
  }
  out.notes.push('values are LINEAR (sRGB textures are decoded by the sampler); 0.5 sRGB ~= 55 linear');
  return out;
}
