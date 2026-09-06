/**
 * Headless probe for js/render/particles.js.
 * Run: node tools/gl-probe.mjs tools/_tmp/probe-particles.js
 */
import { createGLContext, RenderTarget } from '/js/core/gl.js';
import { ParticleSystem, PARTICLE_KINDS } from '/js/render/particles.js';
import { Camera } from '/js/render/renderer.js';

const GL_ERRS = {
  0x0500: 'INVALID_ENUM', 0x0501: 'INVALID_VALUE', 0x0502: 'INVALID_OPERATION',
  0x0505: 'OUT_OF_MEMORY', 0x0506: 'INVALID_FRAMEBUFFER_OPERATION'
};

export default async function run({ canvas }) {
  const out = { errors: [], notes: [], checks: {} };
  const bad = (m) => out.errors.push(m);
  const note = (m) => out.notes.push(m);
  canvas.width = 512; canvas.height = 384;

  const gl = createGLContext(canvas, {});
  if (!gl) { bad('no webgl2'); return out; }
  const err = (tag) => {
    let e = gl.getError(); let first = 0; let guard = 0;
    while (e !== 0 && guard++ < 16) { if (!first) first = e; bad(`${tag}: gl error ${GL_ERRS[e] || '0x' + e.toString(16)}`); e = gl.getError(); }
    return first;
  };

  // ------------------------------------------------------------ construction
  let ps = null;
  try { ps = new ParticleSystem(gl, null, 4000); }
  catch (e) { bad('ParticleSystem ctor threw: ' + e.message + '\n' + (e.stack || '')); return out; }
  err('ctor');
  out.checks.shadersLinked = !!(ps._shaderPlain && ps._shaderPlain.program && ps._shaderSoft && ps._shaderSoft.program);
  if (!out.checks.shadersLinked) bad('shader permutations missing');

  // contract surface
  for (const m of ['spawn', 'burst', 'update', 'render', 'clear']) {
    if (typeof ps[m] !== 'function') bad('missing contract method ' + m);
  }
  out.checks.kinds = PARTICLE_KINDS.length;

  // ------------------------------------------------------------ camera
  const cam = new Camera(62, 0.12, 800);
  cam.position[0] = 0; cam.position[1] = 1.6; cam.position[2] = 6;
  cam.yaw = 0; cam.pitch = 0;
  cam.update(canvas.width / canvas.height);

  // Offscreen target with a sampleable depth texture (mirrors the renderer's HDR pass).
  let rt = null;
  try {
    rt = new RenderTarget(gl, canvas.width, canvas.height, {
      colorFormat: 'rgba8', depth: true, depthTexture: true, filter: 'nearest', wrap: 'clamp'
    });
  } catch (e) { bad('RenderTarget failed: ' + e.message); return out; }
  // A separate depth copy, like renderer._depthCopy (NOT attached to rt).
  let depthCopy = null;
  try {
    depthCopy = new RenderTarget(gl, canvas.width, canvas.height, {
      colorCount: 0, depth: true, depthTexture: true, filter: 'nearest', wrap: 'clamp'
    });
  } catch (e) { bad('depth copy RT failed: ' + e.message); }
  err('targets');

  const readStats = () => {
    const px = new Uint8Array(canvas.width * canvas.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.framebuffer);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let sum = 0; let nonzero = 0; let maxv = 0;
    for (let i = 0; i < px.length; i += 4) {
      const l = px[i] + px[i + 1] + px[i + 2];
      sum += l;
      if (l > 6) nonzero++;
      if (l > maxv) maxv = l;
    }
    return { mean: +(sum / (px.length / 4) / 3).toFixed(3), coverage: +(nonzero / (px.length / 4)).toFixed(4), max: maxv };
  };

  const snapState = () => ({
    blend: gl.getParameter(gl.BLEND),
    depthMask: gl.getParameter(gl.DEPTH_WRITEMASK),
    cull: gl.getParameter(gl.CULL_FACE),
    depthTest: gl.getParameter(gl.DEPTH_TEST),
    depthFunc: gl.getParameter(gl.DEPTH_FUNC),
    blendSrcRGB: gl.getParameter(gl.BLEND_SRC_RGB),
    blendDstRGB: gl.getParameter(gl.BLEND_DST_RGB),
    viewport: Array.from(gl.getParameter(gl.VIEWPORT)),
    fbo: gl.getParameter(gl.FRAMEBUFFER_BINDING) === rt.framebuffer ? 'rt' : 'other',
    vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
    arrayBuf: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
    activeTex: gl.getParameter(gl.ACTIVE_TEXTURE)
  });

  // ------------------------------------------------------------ 1. plain pass
  rt.bind(true);
  gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
  gl.enable(gl.CULL_FACE); gl.disable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  const before = snapState();

  ps.softParticles = false;
  ps.burst('smoke', 0, 1.6, 0, 60, { size: 0.5, life: 4 });
  ps.burst('spark', 0.6, 1.6, 0, 40, { power: 1 });
  ps.update(1 / 60, cam);
  err('update(plain)');
  ps.render(cam);
  err('render(plain)');
  const plain = readStats();
  out.checks.plainPass = plain;
  if (plain.coverage < 0.001) bad('plain pass drew nothing (coverage ' + plain.coverage + ')');
  const after = snapState();
  out.checks.stateBefore = before;
  out.checks.stateAfter = after;
  for (const k of ['blend', 'depthMask', 'cull', 'depthTest', 'depthFunc', 'viewport', 'fbo', 'blendSrcRGB', 'blendDstRGB', 'activeTex']) {
    const a = JSON.stringify(before[k]); const b = JSON.stringify(after[k]);
    if (a !== b) bad(`render() left GL state changed: ${k} ${a} -> ${b}`);
  }

  // ------------------------------------------------------------ 2. soft pass
  ps.softParticles = true;
  ps.setDepthTexture(depthCopy.depthTex, cam.near, cam.far);
  rt.bind(true);
  ps.update(1 / 60, cam);
  ps.render(cam);
  const e2 = err('render(soft, separate depth)');
  out.checks.softDepthMode = ps.stats.depthMode;
  if (ps.stats.depthMode !== 0) bad('soft particles fell back with a non-attached depth texture (mode ' + ps.stats.depthMode + ')');
  const soft = readStats();
  out.checks.softPass = soft;
  if (soft.coverage < 0.001) bad('soft pass drew nothing');

  // ------------------------------------------------------------ 3. feedback-loop escalation
  ps.setDepthTexture(rt.depthTex, cam.near, cam.far);   // attached to the bound FBO on purpose
  rt.bind(true);
  ps.update(1 / 60, cam);
  ps.render(cam);
  gl.getError();
  rt.bind(true);
  ps.update(1 / 60, cam);
  ps.render(cam);
  const e3 = err('render(feedback)');
  out.checks.feedbackDepthMode = ps.stats.depthMode;
  out.checks.feedbackSoftEnabled = ps.softParticles;

  // ------------------------------------------------------------ 4. every kind + long run
  ps.setDepthTexture(depthCopy.depthTex, cam.near, cam.far);
  ps.clear();
  for (const kind of PARTICLE_KINDS) {
    ps.burst(kind, (Math.random() - 0.5) * 4, 1.6, -2, 24, { power: 2 });
  }
  err('burst all kinds');
  const inst0 = ps._instances;
  let sortOk = true;
  for (let f = 0; f < 120; f++) {
    ps.update(1 / 60, cam);
    rt.bind(true);
    ps.render(cam);
    if (f === 3) {
      // Verify the alpha block really is sorted back to front.
      const n = ps.stats.alpha;
      let prev = Infinity;
      for (let k = 0; k < n; k++) {
        const i = ps._alphaSorted[k];
        const dx = ps.px[i] - cam.position[0], dy = ps.py[i] - cam.position[1], dz = ps.pz[i] - cam.position[2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > prev + (320 / 1024)) { sortOk = false; break; }
        prev = d;
      }
    }
  }
  err('120 frames');
  out.checks.sortBackToFront = sortOk;
  if (!sortOk) bad('alpha particles are not sorted back-to-front');
  out.checks.instanceArrayStable = ps._instances === inst0;
  out.checks.statsAfterRun = JSON.parse(JSON.stringify(ps.stats));

  // ------------------------------------------------------------ 5. saturation / recycling
  ps.clear();
  for (let i = 0; i < 40; i++) ps.burst('explosion', 0, 2, -3, 300, { power: 4 });
  ps.update(1 / 60, cam);
  err('saturation');
  out.checks.saturated = { alive: ps.stats.alive, capacity: ps.capacity, recycled: ps.stats.recycled };
  if (ps.stats.alive > ps.capacity) bad('live count exceeded capacity');

  // ------------------------------------------------------------ 6. rain volume
  ps.clear();
  ps.rain(1);
  for (let f = 0; f < 90; f++) { ps.update(1 / 60, cam); rt.bind(true); ps.render(cam); }
  err('rain');
  out.checks.rain = { alive: ps.stats.alive, rainAlive: ps._rainAlive, target: ps._rainTarget };
  if (ps._rainAlive < ps._rainTarget * 0.5) bad('rain volume never filled: ' + ps._rainAlive + '/' + ps._rainTarget);
  ps.rain(0);

  // ------------------------------------------------------------ 7. lights
  ps.clear();
  const lights = [];
  ps.onLight = (x, y, z, r, g, b, radius, intensity) => { lights.push([x, y, z, r, g, b, radius, intensity]); };
  ps.burst('explosion', 0, 2, -4, 40, { power: 3 });
  ps.update(1 / 60, cam);
  out.checks.lights = lights.length;
  if (lights.length === 0) bad('no point light requested by an explosion burst');
  else {
    const l = lights[0];
    if (!(l[7] > 0) || !isFinite(l[7])) bad('bad light intensity ' + l[7]);
    if (!isFinite(l[6]) || l[6] <= 0) bad('bad light radius ' + l[6]);
    out.checks.firstLight = l.map((v) => +v.toFixed(3));
  }

  // ------------------------------------------------------------ 8. degenerate inputs
  ps.clear();
  ps.spawn({ kind: 'smoke', x: 0, y: 1, z: 0, life: 0, size: 0 });
  ps.spawn({ kind: 'nope', x: 0, y: 1, z: 0 });
  ps.spawn({ kind: 'spark', x: 0, y: 1, z: 0, vx: 0, vy: 0, vz: 0, stretch: 0.05 });
  ps.burst('smoke', 0, 1, 0, 0);
  ps.update(0, cam);
  ps.update(10, cam);
  rt.bind(true); ps.render(cam);
  err('degenerate');
  let nan = 0;
  for (let i = 0; i < ps.count; i++) {
    if (!isFinite(ps.px[i]) || !isFinite(ps.py[i]) || !isFinite(ps.pz[i])) nan++;
  }
  out.checks.nonFinite = nan;
  if (nan) bad(nan + ' particles have non-finite positions');

  // ------------------------------------------------------------ 9. setBudget
  try {
    ps.setBudget(1000);
    ps.burst('smoke', 0, 1, 0, 50);
    ps.update(1 / 60, cam);
    rt.bind(true); ps.render(cam);
    err('setBudget');
    out.checks.budget = ps.capacity;
  } catch (e) { bad('setBudget threw: ' + e.message); }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  out.checks.finalGLError = gl.getError();
  return out;
}
