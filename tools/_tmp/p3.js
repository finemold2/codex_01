import { createGLContext, Shader, GpuMesh, Texture2D, RenderTarget, drawFullscreen,
         bindDefaultFramebuffer, checkGLError, setGLDebug } from '/js/core/gl.js';

export default async function run({ canvas }) {
  const out = { errors: [], notes: [] };
  const gl = createGLContext(canvas, {});
  const err = (t) => { const e = gl.getError(); if (e) out.errors.push(`${t}: 0x${e.toString(16)}`); };

  const blit = new Shader(gl, `out vec2 vUv;
    void main(){ vec2 p=vec2((gl_VertexID<<1)&2, gl_VertexID&2); vUv=p; gl_Position=vec4(p*2.0-1.0,0.0,1.0);} `,
   `in vec2 vUv; uniform sampler2D uSrc; out vec4 f; void main(){ f=vec4(texture(uSrc,vUv).rgb,1.0); }`, {}, 'blit');

  // A) does flipY apply to raw ArrayBufferView uploads? (gl.js docs say NO)
  const raw = new Uint8Array([255,0,0,255,  255,0,0,255,   0,0,255,255, 0,0,255,255]); // row0 red, row1 blue
  const tFlip = new Texture2D(gl, { width:2, height:2, data:raw, internalFormat:'rgba8',
    filter:'nearest', wrap:'clamp', mipmaps:false, flipY:true });
  const rt = new RenderTarget(gl, 32, 32, { colorFormat:'rgba8', depth:false, filter:'nearest', wrap:'clamp' });
  rt.bind(true); gl.disable(gl.DEPTH_TEST);
  blit.use(); blit.setTexture('uSrc', tFlip, 0); drawFullscreen(gl); err('flip blit');
  const b = new Uint8Array(4*32*32);
  gl.readPixels(0,0,32,32,gl.RGBA,gl.UNSIGNED_BYTE,b);
  const at=(x,y)=>{const i=(y*32+x)*4; return b[i]+','+b[i+1]+','+b[i+2];};
  out.notes.push('flipY:true raw-data: bottom(v=0)=' + at(16,2) + ' top(v=1)=' + at(16,29) +
    '  (data row0=red first; if unflipped bottom=red)');

  // canvas source for comparison
  const c = document.createElement('canvas'); c.width=c.height=2;
  const cx = c.getContext('2d');
  cx.fillStyle='#f00'; cx.fillRect(0,0,2,1);   // canvas TOP row red
  cx.fillStyle='#00f'; cx.fillRect(0,1,2,1);   // canvas BOTTOM row blue
  const tCanvas = Texture2D.fromCanvas(gl, c, { srgb:false, mipmaps:false, wrap:'clamp', filter:'nearest' });
  rt.bind(true); blit.setTexture('uSrc', tCanvas, 0); drawFullscreen(gl); err('canvas blit');
  gl.readPixels(0,0,32,32,gl.RGBA,gl.UNSIGNED_BYTE,b);
  out.notes.push('fromCanvas: bottom(v=0)=' + at(16,2) + ' top(v=1)=' + at(16,29) +
    '  (canvas top row is red -> expect top=red)');

  // B) MRT
  try {
    const mrt = new RenderTarget(gl, 16,16, { colorCount:2, colorFormats:['rgba8','rgba16f'], depth:true });
    mrt.bind(true);
    out.notes.push('MRT ok fmts=' + mrt.colorFormats.join(',') + ' attachments=' + mrt.colors.length +
      ' drawBuffers=' + mrt.drawBuffers.length);
    const sh2 = new Shader(gl, `void main(){ vec2 p=vec2((gl_VertexID<<1)&2, gl_VertexID&2); gl_Position=vec4(p*2.0-1.0,0.0,1.0);} `,
      `layout(location=0) out vec4 o0; layout(location=1) out vec4 o1;
       void main(){ o0=vec4(1.0,0.0,0.0,1.0); o1=vec4(0.0,4.0,0.0,1.0); }`, {}, 'mrt');
    sh2.use(); drawFullscreen(gl); err('mrt draw');
    const p8 = new Uint8Array(16); gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(8,8,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p8);
    const pf = new Float32Array(4); gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.readPixels(8,8,1,1,gl.RGBA,gl.FLOAT,pf);
    out.notes.push('MRT a0=' + p8.slice(0,3).join(',') + ' a1=' + Array.from(pf.slice(0,3)).join(','));
    mrt.dispose();
  } catch(e){ out.errors.push('MRT: ' + e.message); }
  err('mrt');

  // C) r11g11b10
  try { const t11 = new RenderTarget(gl, 16,16,{ colorFormat:'r11g11b10', depth:false });
        out.notes.push('r11g11b10 resolved=' + t11.colorFormats[0]); t11.bind(true); t11.dispose(); }
  catch(e){ out.errors.push('r11g11b10: ' + e.message); }
  err('r11');

  // D) NPOT + repeat + mipmaps
  const npot = document.createElement('canvas'); npot.width=37; npot.height=53;
  npot.getContext('2d').fillRect(0,0,37,53);
  const tn = Texture2D.fromCanvas(gl, npot, {});
  out.notes.push('NPOT ' + tn.width + 'x' + tn.height + ' mips=' + tn.mipmaps);
  err('npot');

  // E) setTexture with a missing uniform must not disturb unit/binding
  gl.activeTexture(gl.TEXTURE0 + 3); gl.bindTexture(gl.TEXTURE_2D, tn.texture);
  gl.activeTexture(gl.TEXTURE0);
  blit.use(); blit.setTexture('uNoSuchUniform', tFlip, 5);
  const activeAfter = gl.getParameter(gl.ACTIVE_TEXTURE) - gl.TEXTURE0;
  out.notes.push('setTexture(missing) left activeTexture=' + activeAfter + ' (expect 0)');
  err('setTexture missing');

  // F) setTexture(null) unbinds
  blit.setTexture('uSrc', null, 0); err('setTexture null');

  // G) bindDefaultFramebuffer + checkGLError/setGLDebug
  bindDefaultFramebuffer(gl);
  out.notes.push('default fb viewport=' + gl.getParameter(gl.VIEWPORT).join(','));
  setGLDebug(false);
  gl.texParameteri(gl.TEXTURE_2D, 0x9999, 0); // invalid enum -> queues a GL error
  out.notes.push('checkGLError(off)=' + checkGLError(gl, 'x'));
  setGLDebug(true);
  const ce = checkGLError(gl, 'expected');
  out.notes.push('checkGLError(on) returned=' + ce);
  setGLDebug(false);
  while (gl.getError()) {}

  // H) resize down then up, reuse
  rt.resize(8,8); rt.bind(true); rt.resize(64,64); rt.bind(true); err('resize cycle');
  out.notes.push('resize cycle ok ' + rt.width + 'x' + rt.height);

  // I) dispose safety (double dispose)
  const d = new RenderTarget(gl, 8,8,{}); d.dispose(); d.dispose();
  const m = new GpuMesh(gl, { positions:new Float32Array(9) }); m.dispose(); m.dispose(); m.draw();
  const s = new Shader(gl, 'void main(){gl_Position=vec4(0);}','out vec4 f;void main(){f=vec4(1);}',{},'d');
  s.dispose(); s.dispose();
  const tt = Texture2D.solid(gl,1,2,3); tt.dispose(); tt.dispose();
  err('double dispose');
  out.notes.push('double dispose ok');
  return out;
}
