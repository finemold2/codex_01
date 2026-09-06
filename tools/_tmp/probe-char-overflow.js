/**
 * Verifies the parts of entities/character.js the main probe cannot see: the non-instanced
 * fallback that draws characters past the batch capacity, revive() after playRagdoll, and
 * that the frame-token reset keeps batch counts correct when the crowd shrinks.
 */
import { createGLContext } from '/js/core/gl.js';
import { Renderer, Camera } from '/js/render/renderer.js';
import { buildTextureLibrary } from '/js/render/textures.js';
import { BONES, buildCharacterMeshes, Character } from '/js/entities/character.js';

export default async function run({ canvas }) {
  const out = { errors: [], notes: [] };
  const bad = (m) => out.errors.push(m);
  const gl = createGLContext(canvas, {});
  if (!gl) { bad('no webgl2'); return out; }
  const renderer = new Renderer(gl, canvas, {});
  renderer.resize(canvas.width, canvas.height);
  const textures = buildTextureLibrary(gl, { size: 128 });
  renderer.textures = textures;

  // Capacity 4 so the overflow path is the common case, all of them in front of the camera.
  const assets = buildCharacterMeshes(gl, renderer, textures, { capacity: 4 });
  const cam = new Camera(60, 0.1, 200);
  cam.position[0] = 0; cam.position[1] = 1.2; cam.position[2] = 9;
  cam.yaw = 0; cam.pitch = -0.03;
  if (renderer.sky) {
    renderer.sky.setTimeOfDay(13);
    renderer.sky.update(1 / 60, 0);
    renderer.setSun({ direction: renderer.sky.sunDirection, color: renderer.sky.sunColor,
      intensity: renderer.sky.sunIntensity, ambientSky: renderer.sky.ambientSky,
      ambientGround: renderer.sky.ambientGround });
  }

  const chars = [];
  for (let i = 0; i < 16; i++) {
    const c = new Character(assets, { kind: 'civ', seed: 400 + i, weaponVisible: i % 3 === 0 });
    c.position[0] = (i % 8) * 0.85 - 3.0;
    c.position[2] = -Math.floor(i / 8) * 1.4;
    c.yaw = 0;
    c.setState(i % 2 ? 'walk' : 'idle', { restart: true });
    chars.push(c);
  }

  const shot = (n) => {
    for (let f = 0; f < 3; f++) {
      for (let i = 0; i < n; i++) {
        chars[i].update(1 / 60, { moveSpeed: i % 2 ? 2.3 : 0, lod: 0 });
        chars[i].submit(renderer);
      }
      cam.update(canvas.width / canvas.height);
      renderer.render(cam, 1 / 60);
    }
    const W = Math.min(400, canvas.width), H = Math.min(220, canvas.height);
    const px = new Uint8Array(4 * W * H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels((canvas.width - W) >> 1, (canvas.height - H) >> 1, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // Characters are dark silhouettes against a bright sky: count the non-sky pixels.
    let lit = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] < 330) lit++;
    let inst = 0;
    for (const p of assets.parts) if (p.batch) inst += p.batch.count;
    return { lit, inst, draws: renderer.stats.drawCalls, err: gl.getError() };
  };

  const four = shot(4);
  const sixteen = shot(16);
  out.notes.push(`capacity ${assets.capacity}: 4 chars -> ${four.inst} instances, ${four.draws} draws, ${four.lit} character px`);
  out.notes.push(`capacity ${assets.capacity}: 16 chars -> ${sixteen.inst} instances, ${sixteen.draws} draws, ${sixteen.lit} character px`);
  if (four.err) bad(`GL error drawing 4 characters: 0x${four.err.toString(16)}`);
  if (sixteen.err) bad(`GL error on the overflow path: 0x${sixteen.err.toString(16)}`);
  if (sixteen.inst > assets.capacity * assets.parts.length) bad(`instances written beyond the batch capacity (${sixteen.inst} > ${assets.capacity * assets.parts.length})`);
  if (sixteen.draws <= four.draws) bad('overflow characters produced no extra draw calls (they are invisible)');
  if (sixteen.lit <= four.lit * 1.15) {
    bad(`overflow characters did not reach the screen (${four.lit} -> ${sixteen.lit} lit pixels)`);
  }

  // Shrinking the crowd must not leave last frame's instances on screen.
  const back = shot(4);
  out.notes.push(`back down to 4 chars -> ${back.inst} instances, ${back.lit} character px`);
  if (back.inst !== four.inst) bad(`stale instances after the crowd shrank: ${back.inst} vs ${four.inst}`);
  if (back.lit > four.lit * 1.15) bad('ghost characters left on screen after the crowd shrank');

  // revive(): a corpse handed back to the animation system must stand up and draw again.
  {
    const c = chars[0];
    c.setState('run');
    for (let i = 0; i < 40; i++) c.update(1 / 60, { moveSpeed: 5 });
    c.playRagdoll([4, 1, 0]);
    for (let i = 0; i < 240; i++) c.update(1 / 60, {});
    const downHead = c.getBoneMatrix('head')[13] - c.position[1];
    c.revive('idle');
    let nan = 0;
    for (let i = 0; i < 120; i++) {
      c.update(1 / 60, { moveSpeed: 0 });
      for (const b of BONES) { const m = c.getBoneMatrix(b); for (let k = 0; k < 16; k++) if (!Number.isFinite(m[k])) nan++; }
    }
    const upHead = c.getBoneMatrix('head')[13] - c.position[1];
    out.notes.push(`revive(): head ${downHead.toFixed(2)} m (down) -> ${upHead.toFixed(2)} m (up), dead=${c.dead}`);
    if (nan) bad(`${nan} non-finite components after revive()`);
    if (c.dead || c.state !== 'idle') bad(`revive() left the character at state=${c.state} dead=${c.dead}`);
    if (upHead < 1.3) bad(`revive() did not stand the character back up (head at ${upHead.toFixed(2)} m)`);
  }
  return out;
}
