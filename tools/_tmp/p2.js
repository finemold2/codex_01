import { createGLContext, Shader, GpuMesh, Texture2D, RenderTarget, drawFullscreen } from '/js/core/gl.js';
import { box, sphere, mergeGeometries } from '/js/core/geometry.js';

export default async function run({ canvas }) {
  const out = { errors: [], notes: [] };
  const gl = createGLContext(canvas, {});
  const err = (t) => { const e = gl.getError(); if (e) out.errors.push(`${t}: 0x${e.toString(16)}`); };
  const sh = new Shader(gl, `
      layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNormal; layout(location=2) in vec2 aUV;
      layout(location=4) in vec4 iM0; layout(location=5) in vec4 iM1;
      layout(location=6) in vec4 iM2; layout(location=7) in vec4 iM3; layout(location=8) in vec4 iTint;
      uniform mat4 uMVP; out vec3 vN; out vec2 vUV; out vec4 vTint;
      void main(){ mat4 M = mat4(iM0, iM1, iM2, iM3);
        vN = aNormal; vUV = aUV; vTint = iTint;
        gl_Position = uMVP * M * vec4(aPos, 1.0); }`, `
      in vec3 vN; in vec2 vUV; in vec4 vTint; uniform sampler2D uTex; uniform vec3 uColor;
      out vec4 fragColor;
      void main(){ float d = max(dot(normalize(vN), normalize(vec3(0.4,0.8,0.3))), 0.0);
        fragColor = vec4(uColor * vTint.rgb * (0.4 + 2.0 * d) * texture(uTex, vUV).rgb, 1.0); }`, {}, 'probe');
  const geo = mergeGeometries([{ geometry: box(1, 1, 1) }, { geometry: sphere(0.6, 12, 8) }]);
  const mesh = new GpuMesh(gl, geo);
  mesh.enableInstancing(64, 20);
  const data = new Float32Array(64 * 20);
  for (let i = 0; i < 64; i++) {
    const o = i * 20;
    data[o] = 1; data[o + 5] = 1; data[o + 10] = 1; data[o + 15] = 1;
    data[o + 12] = ((i % 8) - 3.5) * 0.4; data[o + 13] = (((i / 8) | 0) - 3.5) * 0.4;
    data[o + 16] = 1; data[o + 17] = 1; data[o + 18] = 1; data[o + 19] = 1;
  }
  mesh.setInstanceData(data, 64);
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#345'; ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#fc0'; ctx.fillRect(0, 0, 32, 32);
  const tex = Texture2D.fromCanvas(gl, c, { srgb: true, mipmaps: true, wrap: 'repeat', anisotropy: 8 });
  const rt = new RenderTarget(gl, 256, 256, { colorFormat: 'rgba16f', depth: true, depthTexture: true, filter: 'linear' });
  rt.bind(true);
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0.05, 0.06, 0.09, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  sh.use();
  const mvp = new Float32Array([0.5,0,0,0, 0,0.9,0,0, 0,0,-1,0, 0,0,-0.5,1]);
  sh.setMat4('uMVP', mvp); sh.setVec3('uColor', 1, 0.8, 0.4); sh.setTexture('uTex', tex, 0);
  mesh.draw(64);
  err('draw');
  const px = new Float32Array(4*256*256);
  gl.readPixels(0,0,256,256,gl.RGBA,gl.FLOAT,px);
  // coarse 16x16 coverage map of the whole RT
  let map = '';
  for (let ry=15; ry>=0; ry--) {
    let row='';
    for (let rx=0; rx<16; rx++) {
      let lit=0;
      for (let y=ry*16;y<ry*16+16;y++) for (let x=rx*16;x<rx*16+16;x++){
        const i=(y*256+x)*4; if (Math.abs(px[i]-0.05)>0.002) lit++;
      }
      row += lit>128 ? '#' : lit>16 ? '+' : lit>0 ? '.' : ' ';
    }
    map += row + '\n';
  }
  out.notes.push('RT coverage map:\n' + map);
  let tot=0; for(let i=0;i<px.length;i+=4) if(px[i]>0.08) tot++;
  out.notes.push('total lit=' + tot + ' / 65536');
  // depth texture readable?
  out.notes.push('depthTex present=' + !!rt.depthTex);
  return out;
}
