import { createGLContext } from '/js/core/gl.js';
import { generateCity } from '/js/world/citygen.js';
import { buildWorld } from '/js/world/worldbuild.js';
import { CollisionWorld } from '/js/world/collision.js';
import { Renderer, Camera } from '/js/render/renderer.js';
import { buildTextureLibrary } from '/js/render/textures.js';

export default async function run({ canvas }) {
  const out = { errors: [], notes: [] };
  const gl = createGLContext(canvas, {});
  const city = generateCity(20260906, {});
  const renderer = new Renderer(gl, canvas, {});
  renderer.resize(canvas.width, canvas.height);
  const textures = buildTextureLibrary(gl, { size: 256 });
  renderer.textures = textures;
  const size = Math.max(city.bounds.max[0] - city.bounds.min[0], city.bounds.max[1] - city.bounds.min[1]) + 400;
  let collision = new CollisionWorld(size, 16);
  const world = buildWorld(gl, renderer, textures, city, { collision });
  const cam = new Camera(62, 0.12, 1600);
  cam.position[0] = city.spawns.player.x; cam.position[1] = 40; cam.position[2] = city.spawns.player.z + 60;
  cam.yaw = 0; cam.pitch = -0.25;
  const hour = 13.5;
  for (let i = 0; i < 8; i++) {
    cam.yaw += 0.05;
    cam.update(canvas.width / canvas.height);
    renderer.sky.setTimeOfDay(hour); renderer.sky.update(1 / 60, 0);
    renderer.setSun({ direction: renderer.sky.sunDirection, color: renderer.sky.sunColor,
      intensity: renderer.sky.sunIntensity, ambientSky: renderer.sky.ambientSky, ambientGround: renderer.sky.ambientGround });
    renderer.setFog({ color: renderer.sky.fogColor, density: 0.0016, heightFalloff: 0.018 });
    world.update(1 / 60, hour, cam);
    renderer.render(cam, 1 / 60);
  }
  // Full-frame histogram, not just the centre.
  const W = canvas.width, H = canvas.height;
  const px = new Uint8Array(4 * W * H);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let sum = 0, mn = 255, mx = 0; const uniq = new Set();
  for (let i = 0; i < px.length; i += 4) {
    const l = (px[i] + px[i + 1] + px[i + 2]) / 3; sum += l; if (l < mn) mn = l; if (l > mx) mx = l;
    uniq.add(px[i] >> 3 << 10 | px[i + 1] >> 3 << 5 | px[i + 2] >> 3);
  }
  out.notes.push(`FULL frame ${W}x${H}: uniq=${uniq.size} luma mean ${(sum / (W * H)).toFixed(1)} range ${mn}..${mx}`);
  // What is directly in front? raycast
  const d = [-Math.sin(cam.yaw) * Math.cos(cam.pitch), Math.sin(cam.pitch), -Math.cos(cam.yaw) * Math.cos(cam.pitch)];
  const hit = collision.raycast([cam.position[0], cam.position[1], cam.position[2]], d, 800, null);
  out.notes.push('centre ray: ' + (hit ? `t=${hit.t.toFixed(1)} tag=${hit.body && hit.body.tag} ud=${JSON.stringify(hit.body && hit.body.userData)}` : 'nothing within 800m'));
  window.__shot = async () => { renderer.render(cam, 1 / 60); renderer.render(cam, 1 / 60); };
  return out;
}
