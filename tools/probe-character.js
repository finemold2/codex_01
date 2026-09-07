/**
 * Headless probe for entities/character.js.
 *
 * Builds 30 characters of every kind, runs every animation state for 600 frames at 1/60 with
 * varying speeds, and asserts: no exceptions, no NaN in any bone matrix, bones stay inside a
 * sane world radius, the feet never sink more than 3 cm during walk/run, cross-fades do not
 * make bone angles jump, and 30 characters update in well under 3 ms per frame. Finally it
 * renders the crowd through the renderer to check the instanced path and the draw-call budget.
 *
 * Run: node tools/gl-probe.mjs tools/probe-character.js [--shot out.png]
 */
import { createGLContext } from '/js/core/gl.js';
import { Renderer, Camera } from '/js/render/renderer.js';
import { buildTextureLibrary } from '/js/render/textures.js';
import { BONES, CHARACTER_STATES, buildCharacterMeshes, Character } from '/js/entities/character.js';

const KINDS = ['civ', 'cop', 'gangster', 'player'];
const GAITS = ['walk', 'run', 'sprint', 'crouchWalk', 'aimWalk'];

/**
 * Speed the test drives a state at.
 * @param {string} state State name.
 * @returns {number} Ground speed in m/s.
 */
function speedFor(state) {
  switch (state) {
    case 'walk': return 2.3;
    case 'run': return 5.1;
    case 'sprint': return 8.0;
    case 'crouchWalk': return 1.6;
    case 'aimWalk': return 1.9;
    case 'swim': return 2.2;
    default: return 0;
  }
}

export default async function run({ canvas }) {
  const out = { errors: [], notes: [] };
  const bad = (m) => out.errors.push(m);

  const gl = createGLContext(canvas, {});
  if (!gl) { bad('no webgl2'); return out; }

  const renderer = new Renderer(gl, canvas, {});
  renderer.resize(canvas.width, canvas.height);
  const textures = buildTextureLibrary(gl, { size: 256 });
  renderer.textures = textures;

  // ---- assets ---------------------------------------------------------------------------
  let assets;
  const tBuild = performance.now();
  try {
    assets = buildCharacterMeshes(gl, renderer, textures, { capacity: 64 });
  } catch (e) {
    bad('buildCharacterMeshes threw: ' + e.message);
    return out;
  }
  out.notes.push(`buildCharacterMeshes: ${(performance.now() - tBuild).toFixed(0)} ms, ` +
    `${assets.parts.length} parts, ${assets.triangles} tris (fully equipped)`);
  if (assets.triangles < 2500 || assets.triangles > 7000) {
    bad(`character triangle count out of the 3-6k band: ${assets.triangles}`);
  }
  if (BONES.length !== 20) bad(`BONES has ${BONES.length} entries, expected 20`);
  if (CHARACTER_STATES.length < 20) bad(`only ${CHARACTER_STATES.length} states`);
  for (const need of ['idle', 'walk', 'run', 'sprint', 'crouch', 'crouchWalk', 'jump', 'fall',
    'land', 'aim', 'aimWalk', 'shoot', 'reload', 'punch', 'hit', 'die', 'drive', 'swim',
    'enter', 'exit']) {
    if (CHARACTER_STATES.indexOf(need) < 0) bad(`missing state '${need}'`);
  }

  // ---- population -------------------------------------------------------------------------
  const chars = [];
  try {
    for (let i = 0; i < 30; i++) {
      const c = new Character(assets, {
        kind: KINDS[i % KINDS.length],
        female: i % 3 === 0,
        seed: 1000 + i,
        height: 1.62 + (i % 7) * 0.04,
        weaponVisible: i % 4 === 1
      });
      c.position[0] = (i % 6) * 1.6 - 4;
      c.position[1] = 0;
      c.position[2] = Math.floor(i / 6) * 1.8 - 3.6;
      c.yaw = i * 0.21;
      chars.push(c);
    }
  } catch (e) {
    bad('Character constructor threw: ' + e.message);
    return out;
  }

  // ---- state sweep -------------------------------------------------------------------------
  const scratch = new Float32Array(30 * BONES.length * 3);
  const prevAngles = new Float32Array(30 * BONES.length * 3);
  let nanCount = 0;
  let radiusFails = 0;
  let worstRadius = 0;
  let footSink = 0;
  let worstFootY = 1e9;
  let jumpSpikes = 0;
  let worstSpike = 0;
  let updateMs = 0;
  let frames = 0;
  const deltaHist = new Float64Array(6);
  let switchFrame = -10;

  const stateList = CHARACTER_STATES;
  try {
    for (let f = 0; f < 600; f++) {
      const stateIdx = Math.floor(f / 30) % stateList.length;
      const state = stateList[stateIdx];
      const justSwitched = f % 30 === 0;
      if (justSwitched) switchFrame = f;
      const baseSpeed = speedFor(state);

      const t0 = performance.now();
      for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        if (justSwitched) c.setState(state);
        const speed = baseSpeed * (0.6 + 0.5 * Math.abs(Math.sin(f * 0.013 + i)));
        c.yaw += 0.012 * Math.sin(f * 0.02 + i);
        c.update(1 / 60, {
          moveSpeed: speed,
          aimPitch: 0.35 * Math.sin(f * 0.017),
          lookYaw: 0.9 * Math.sin(f * 0.011 + i),
          aiming: state === 'aim' || state === 'aimWalk' || state === 'shoot',
          grounded: state !== 'jump' && state !== 'fall',
          steer: Math.sin(f * 0.03),
          lod: 0
        });
      }
      updateMs += performance.now() - t0;
      frames++;

      // --- assertions on the resulting matrices -------------------------------------------
      let maxDelta = 0;
      for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        for (let b = 0; b < BONES.length; b++) {
          const m = c.getBoneMatrix(BONES[b]);
          for (let k = 0; k < 16; k++) if (!Number.isFinite(m[k])) nanCount++;
          const dx = m[12] - c.position[0];
          const dy = m[13] - c.position[1];
          const dz = m[14] - c.position[2];
          const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (r > worstRadius) worstRadius = r;
          if (r > 2.6) radiusFails++;
          const o = (i * BONES.length + b) * 3;
          scratch[o] = c._pose[b * 3];
          scratch[o + 1] = c._pose[b * 3 + 1];
          scratch[o + 2] = c._pose[b * 3 + 2];
          const d = Math.abs(scratch[o] - prevAngles[o]) +
            Math.abs(scratch[o + 1] - prevAngles[o + 1]) +
            Math.abs(scratch[o + 2] - prevAngles[o + 2]);
          if (f > 2 && d > maxDelta) maxDelta = d;
        }
        if (GAITS.indexOf(state) >= 0 && f - switchFrame > 15) {
          const fl = c.getBoneMatrix('footL')[13];
          const fr = c.getBoneMatrix('footR')[13];
          const lo = Math.min(fl, fr) - c.position[1];
          if (lo < worstFootY) worstFootY = lo;
          if (lo < -0.03) footSink++;
        }
      }
      prevAngles.set(scratch);

      // A cross-fade must not make the angles jump: compare the switch frame against the
      // recent history of per-frame deltas.
      if (f > 6) {
        let med = 0;
        for (let k = 0; k < deltaHist.length; k++) med += deltaHist[k];
        med /= deltaHist.length;
        if (f - switchFrame <= 1 && maxDelta > Math.max(0.35, med * 4)) {
          jumpSpikes++;
          if (maxDelta > worstSpike) worstSpike = maxDelta;
        }
      }
      deltaHist[f % deltaHist.length] = maxDelta;
    }
  } catch (e) {
    bad('update threw: ' + e.message + '\n' + (e.stack || ''));
    return out;
  }

  const msPerFrame = updateMs / Math.max(1, frames);
  out.notes.push(`30 characters, ${frames} frames, all ${stateList.length} states: ` +
    `${msPerFrame.toFixed(3)} ms/frame update`);
  out.notes.push(`worst bone radius from origin: ${worstRadius.toFixed(2)} m; ` +
    `lowest foot during walk/run: ${worstFootY.toFixed(4)} m`);
  if (nanCount) bad(`${nanCount} non-finite bone matrix components`);
  if (radiusFails) bad(`${radiusFails} bone matrices further than 2.6 m from the character`);
  if (footSink) bad(`feet sank below the ground ${footSink} times (worst ${worstFootY.toFixed(3)} m)`);
  if (jumpSpikes) bad(`${jumpSpikes} cross-fade angle jumps (worst ${worstSpike.toFixed(3)} rad/frame)`);
  if (msPerFrame > 3) bad(`update too slow: ${msPerFrame.toFixed(3)} ms/frame for 30 characters`);

  // ---- foot lock: world-space slip of the planted foot -------------------------------------
  for (const [state, spd] of [['walk', 2.4], ['run', 5.2], ['sprint', 8.0]]) {
    const c = new Character(assets, { kind: 'civ', seed: 77 });
    c.setState(state);
    for (let i = 0; i < 240; i++) { c.position[2] -= spd / 60; c.update(1 / 60, { moveSpeed: spd }); }
    let slip = 0;
    let n = 0;
    for (const bone of ['footL', 'footR']) {
      let anchor = null;
      let runMax = 0;
      for (let i = 0; i < 600; i++) {
        c.position[2] -= spd / 60;
        c.update(1 / 60, { moveSpeed: spd });
        const m = c.getBoneMatrix(bone);
        if (m[13] - c.position[1] < 0.1) {
          if (anchor === null) { anchor = m[14]; runMax = 0; }
          runMax = Math.max(runMax, Math.abs(m[14] - anchor));
        } else if (anchor !== null) { slip += runMax; n++; anchor = null; }
      }
    }
    const avg = slip / Math.max(1, n);
    out.notes.push(`${state} planted-foot world slip: ${(avg * 100).toFixed(1)} cm per stance (${n} stances)`);
    if (avg > 0.08) bad(`${state} foot skating: ${(avg * 100).toFixed(1)} cm slip per stance`);
  }

  // ---- ragdoll -----------------------------------------------------------------------------
  {
    const c = new Character(assets, { kind: 'gangster', seed: 5 });
    c.setState('run');
    for (let i = 0; i < 60; i++) c.update(1 / 60, { moveSpeed: 5 });
    c.playRagdoll([5, 1.5, -7]);
    let nan = 0;
    for (let i = 0; i < 400; i++) {
      c.update(1 / 60, {});
      for (const b of BONES) {
        const m = c.getBoneMatrix(b);
        for (let k = 0; k < 16; k++) if (!Number.isFinite(m[k])) nan++;
      }
    }
    const headY = c.getBoneMatrix('head')[13];
    const before = headY;
    for (let i = 0; i < 200; i++) c.update(1 / 60, {});
    const drift = Math.abs(c.getBoneMatrix('head')[13] - before);
    out.notes.push(`ragdoll: head settles at y=${headY.toFixed(3)}, residual drift ${drift.toFixed(5)} m`);
    if (nan) bad(`${nan} non-finite components during ragdoll`);
    if (headY > 0.55) bad(`ragdoll did not end lying flat (head y=${headY.toFixed(2)})`);
    if (drift > 0.01) bad(`ragdoll never settles (drift ${drift.toFixed(3)} m)`);
    if (!c.dead) bad('playRagdoll did not mark the character dead');
  }

  // ---- muzzle + bone accessors ---------------------------------------------------------------
  {
    const c = chars[0];
    c.setState('aim', { restart: true });
    for (let i = 0; i < 60; i++) c.update(1 / 60, { aiming: true, aimPitch: 0.2, moveSpeed: 0 });
    const mz = [0, 0, 0];
    c.getMuzzleOrigin(mz);
    const hand = c.getBoneMatrix('handR');
    const d = Math.hypot(mz[0] - hand[12], mz[1] - hand[13], mz[2] - hand[14]);
    out.notes.push(`muzzle offset from right hand: ${d.toFixed(3)} m at y=${mz[1].toFixed(2)}`);
    if (!(d > 0.15 && d < 0.45)) bad(`muzzle offset looks wrong: ${d.toFixed(3)} m`);
    if (c.getBoneMatrix('nope') !== null) bad('getBoneMatrix should return null for unknown bones');
  }

  // ---- rendering --------------------------------------------------------------------------
  const cam = new Camera(55, 0.1, 400);
  cam.position[0] = 0; cam.position[1] = 1.7; cam.position[2] = 7.5;
  cam.yaw = 0; cam.pitch = -0.06;
  if (renderer.sky) {
    renderer.sky.setTimeOfDay(14.5);
    renderer.sky.update(1 / 60, 0);
    renderer.setSun({
      direction: renderer.sky.sunDirection, color: renderer.sky.sunColor,
      intensity: renderer.sky.sunIntensity, ambientSky: renderer.sky.ambientSky,
      ambientGround: renderer.sky.ambientGround
    });
    renderer.setFog({ color: renderer.sky.fogColor, density: 0.0008, heightFalloff: 0.02 });
  }
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    c.setState(i % 3 === 0 ? 'idle' : (i % 3 === 1 ? 'walk' : 'aim'), { restart: true });
    c.position[0] = (i % 6) * 1.15 - 2.9;
    c.position[2] = -Math.floor(i / 6) * 1.5;
    c.yaw = 0.15 * Math.sin(i);
  }
  let glErr = 0;
  const tRender = performance.now();
  const drawFrame = () => {
    for (let i = 0; i < chars.length; i++) {
      chars[i].update(1 / 60, { moveSpeed: i % 3 === 1 ? 2.3 : 0, lookYaw: 0.2, aimPitch: 0.05, lod: 0 });
      chars[i].submit(renderer);
    }
    cam.update(canvas.width / canvas.height);
    renderer.render(cam, 1 / 60);
  };
  for (let f = 0; f < 12; f++) {
    drawFrame();
    const g = gl.getError();
    if (g) { glErr = g; break; }
  }
  out.notes.push(`12 rendered frames in ${(performance.now() - tRender).toFixed(0)} ms; ` +
    `stats=${JSON.stringify(renderer.stats)}`);
  if (glErr) bad(`GL error while drawing characters: 0x${glErr.toString(16)}`);
  if ((renderer.stats.drawCalls | 0) > 60) {
    bad(`${renderer.stats.drawCalls} draw calls for 30 characters (instancing not working)`);
  }
  let instanced = 0;
  for (const p of assets.parts) if (p.batch && p.batch.count > 0) instanced += p.batch.count;
  out.notes.push(`instances written this frame: ${instanced} across ${assets.parts.length} batches`);
  if (instanced < 30 * 15) bad(`only ${instanced} instances written, expected >= 450`);

  // Overflow path: more characters than the batch capacity must still draw.
  const extra = [];
  for (let i = 0; i < 40; i++) {
    const c = new Character(assets, { kind: 'civ', seed: 5000 + i });
    c.position[0] = 40 + i;
    c.update(1 / 60, {});
    extra.push(c);
  }
  for (const c of chars) c.submit(renderer);
  for (const c of extra) c.submit(renderer);
  cam.update(canvas.width / canvas.height);
  renderer.render(cam, 1 / 60);
  const g2 = gl.getError();
  if (g2) bad(`GL error on the overflow path: 0x${g2.toString(16)}`);
  out.notes.push(`70 characters (capacity 64): drawCalls=${renderer.stats.drawCalls}`);

  // Frame is not blank.
  const W = Math.min(320, canvas.width);
  const H = Math.min(180, canvas.height);
  const px = new Uint8Array(4 * W * H);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels((canvas.width - W) >> 1, (canvas.height - H) >> 1, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const uniq = new Set();
  for (let i = 0; i < px.length; i += 4) uniq.add(px[i] >> 3 << 10 | px[i + 1] >> 3 << 5 | px[i + 2] >> 3);
  out.notes.push(`unique colours in the centre ${W}x${H}: ${uniq.size}`);
  if (uniq.size < 12) bad('rendered character frame looks blank');

  // Beauty pass: four kinds side by side in different states so the model itself can be
  // eyeballed, not just the crowd.
  window.__shot = () => {
    for (const c of extra) c.visible = false;
    for (let i = 0; i < chars.length; i++) chars[i].visible = i < 4;
    const poses = ['idle', 'walk', 'aim', 'run'];
    for (let i = 0; i < 4; i++) {
      const c = chars[i];
      c.position[0] = (i - 1.5) * 0.78;
      c.position[2] = 0;
      c.yaw = i === 3 ? 0 : (i === 2 ? Math.PI * 0.55 : Math.PI);
      c.setState(poses[i], { restart: true });
      for (let k = 0; k < 40; k++) {
        c.update(1 / 60, { moveSpeed: speedFor(poses[i]), lookYaw: 0.2, aimPitch: 0.05, lod: 0 });
      }
    }
    cam.position[0] = 0; cam.position[1] = 1.15; cam.position[2] = 2.55;
    cam.yaw = 0; cam.pitch = -0.05;
    drawFrame();
  };

  return out;
}
