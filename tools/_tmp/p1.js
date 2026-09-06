import { createGLContext, Shader, GpuMesh, Texture2D, RenderTarget, drawFullscreen } from '/js/core/gl.js';

export default async function run({ canvas }) {
  const out = { errors: [], notes: [] };
  const gl = createGLContext(canvas, {});
  const err = (t) => { const e = gl.getError(); if (e) out.errors.push(`${t}: 0x${e.toString(16)}`); };

  // ---- 1. instancing coverage test: unit quad, 4 instances translated ----
  const sh = new Shader(gl, `
    layout(location=0) in vec3 aPos;
    layout(location=4) in vec4 iM0; layout(location=5) in vec4 iM1;
    layout(location=6) in vec4 iM2; layout(location=7) in vec4 iM3;
    layout(location=8) in vec4 iTint;
    out vec4 vTint;
    void main(){ mat4 M = mat4(iM0,iM1,iM2,iM3); vTint = iTint;
      gl_Position = M * vec4(aPos,1.0); }`,
   `in vec4 vTint; out vec4 f; void main(){ f = vTint; }`, {}, 'inst');
  err('shader');

  // quad in XY, z=0, two triangles
  const quad = {
    positions: new Float32Array([-1,-1,0,  1,-1,0,  1,1,0,  -1,1,0]),
    indices: new Uint16Array([0,1,2, 0,2,3])
  };
  const mesh = new GpuMesh(gl, quad);
  out.notes.push('indexCount=' + mesh.indexCount + ' triangleCount=' + mesh.triangleCount +
                 ' vertexCount=' + mesh.vertexCount + ' hasColors=' + mesh.hasColors);
  mesh.enableInstancing(4, 20);
  const d = new Float32Array(4*20);
  const quads = [[-0.5,-0.5,1,0,0],[0.5,-0.5,0,1,0],[-0.5,0.5,0,0,1],[0.5,0.5,1,1,0]];
  for (let i=0;i<4;i++){
    const o=i*20; const q=quads[i];
    d[o+0]=0.4; d[o+5]=0.4; d[o+10]=0.4; d[o+15]=1;
    d[o+12]=q[0]; d[o+13]=q[1];
    d[o+16]=q[2]; d[o+17]=q[3]; d[o+18]=q[4]; d[o+19]=1;
  }
  mesh.setInstanceData(d, 4);
  out.notes.push('instanceCount=' + mesh.instanceCount + ' cap=' + mesh.instanceCapacity);
  err('instdata');

  const rt = new RenderTarget(gl, 128, 128, { colorFormat: 'rgba16f', depth: true, depthTexture: true });
  rt.setClearColor(0,0,0,1);
  rt.bind(true);
  gl.disable(gl.CULL_FACE); gl.disable(gl.DEPTH_TEST);
  sh.use();
  mesh.draw(4);
  err('draw');
  const px = new Float32Array(4*128*128);
  gl.readPixels(0,0,128,128,gl.RGBA,gl.FLOAT,px);
  const sample = (x,y) => { const i=(y*128+x)*4; return [px[i].toFixed(2),px[i+1].toFixed(2),px[i+2].toFixed(2)].join(','); };
  // instance 0 at (-0.5,-0.5) => NDC lower-left => pixel (32,32) in GL coords (y up)
  out.notes.push('LL(32,32)=' + sample(32,32) + ' LR(96,32)=' + sample(96,32) +
                 ' UL(32,96)=' + sample(32,96) + ' UR(96,96)=' + sample(96,96));
  let lit=0; for(let i=0;i<px.length;i+=4) if(px[i]+px[i+1]+px[i+2] > 0.01) lit++;
  out.notes.push('litPixels=' + lit + ' of 16384');
  err('readback');

  // ---- 2. fullscreen blit of a known 2x2 texture ----
  const t = new Texture2D(gl, { width:2, height:2, filter:'nearest', wrap:'clamp', mipmaps:false,
    internalFormat:'rgba8',
    data: new Uint8Array([255,0,0,255,  0,255,0,255,  0,0,255,255,  255,255,0,255]) });
  err('tex');
  const fs = new Shader(gl, `out vec2 vUv;
    void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); vUv=p; gl_Position=vec4(p*2.0-1.0,0.0,1.0);} `,
   `in vec2 vUv; uniform sampler2D uSrc; out vec4 f; void main(){ f = vec4(texture(uSrc,vUv).rgb,1.0); }`, {}, 'fs');
  rt.bind(true);
  fs.use(); fs.setTexture('uSrc', t, 0);
  drawFullscreen(gl);
  err('fullscreen');
  gl.readPixels(0,0,128,128,gl.RGBA,gl.FLOAT,px);
  out.notes.push('blit LL=' + sample(10,10) + ' LR=' + sample(118,10) + ' UL=' + sample(10,118) + ' UR=' + sample(118,118));

  // ---- 3. resize + re-read ----
  rt.resize(64,64); err('resize');
  out.notes.push('after resize ' + rt.width + 'x' + rt.height + ' colorFmt=' + rt.colorFormats.join(',') +
                 ' depthTex=' + (rt.depthTex ? 'yes':'no'));
  rt.bind(true); err('bind after resize');

  // ---- 4. grow instancing past capacity ----
  const big = new Float32Array(300*20);
  for (let i=0;i<300;i++){ const o=i*20; big[o]=1;big[o+5]=1;big[o+10]=1;big[o+15]=1; big[o+19]=1; }
  mesh.setInstanceData(big, 300);
  out.notes.push('grown cap=' + mesh.instanceCapacity + ' count=' + mesh.instanceCount);
  mesh.draw(300); err('draw grown');

  // ---- 5. partial upload (count < array length) ----
  mesh.setInstanceData(big, 10);
  out.notes.push('partial count=' + mesh.instanceCount);
  mesh.draw(10); err('draw partial');

  // ---- 6. no-index geometry ----
  const m2 = new GpuMesh(gl, { positions: new Float32Array([0,0,0, 1,0,0, 0,1,0]) });
  out.notes.push('noindex indexCount=' + m2.indexCount + ' type=' + (m2.indexType===gl.UNSIGNED_SHORT?'u16':'u32'));
  m2.draw(); err('draw noindex');

  // ---- 7. >65535 vertices -> u32 indices ----
  const n = 70000;
  const m3 = new GpuMesh(gl, { positions: new Float32Array(n*3) });
  out.notes.push('wide indexCount=' + m3.indexCount + ' type=' + (m3.indexType===gl.UNSIGNED_INT?'u32':'u16'));
  err('wide');

  // ---- 8. texture update ----
  const c2 = document.createElement('canvas'); c2.width=c2.height=8;
  const cx=c2.getContext('2d'); cx.fillStyle='#0f0'; cx.fillRect(0,0,8,8);
  const tc = Texture2D.fromCanvas(gl, c2, {});
  tc.update(c2); err('tex update same size');
  const c3 = document.createElement('canvas'); c3.width=c3.height=16;
  c3.getContext('2d').fillStyle='#f00'; c3.getContext('2d').fillRect(0,0,16,16);
  tc.update(c3); err('tex update resized');
  out.notes.push('tex size ' + tc.width + 'x' + tc.height + ' srgb=' + tc.srgb + ' mips=' + tc.mipmaps);

  // ---- 9. half-float data upload ----
  const th = new Texture2D(gl, { width:2, height:2, internalFormat:'rgba16f',
    data: new Float32Array(16).fill(0.5), filter:'linear', wrap:'clamp', mipmaps:false });
  err('half upload');
  out.notes.push('halfTex ok ' + th.width);

  // ---- 10. depth-only target ----
  try { const dOnly = new RenderTarget(gl, 64,64,{ colorCount:0, depth:true, depthTexture:true });
        dOnly.bind(true); out.notes.push('depthOnly ok'); } catch(e){ out.errors.push('depthOnly: '+e.message); }
  err('depthonly');

  // ---- 11. shader error reporting ----
  try { new Shader(gl, 'void main(){ gl_Position = vec4(bogus,1.0); }', 'out vec4 f; void main(){f=vec4(1);}', {}, 'bad');
        out.errors.push('bad shader did not throw'); }
  catch(e){ out.notes.push('shader error msg has line window: ' + /\|/.test(e.message) + ' len=' + e.message.length); }

  // ---- 12. defines ----
  const sd = new Shader(gl, 'void main(){ gl_Position=vec4(float(FOO),0,0,1);} ',
    '#ifndef BAR\n#error BAR missing\n#endif\nout vec4 f; void main(){f=vec4(BAR);}', {FOO:3, BAR:true, SKIP:false}, 'def');
  out.notes.push('defines ok');
  err('defines');
  return out;
}
