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
  const collision = new CollisionWorld(2600, 16);
  const world = buildWorld(gl, renderer, textures, city, { collision });
  const cam = new Camera(62, 0.12, 1600);
  const VIEWS = {
    shore: { pos: [600, 14, 40], yaw: -1.35, pitch: -0.18, hour: 13.5 },
    shore2: { pos: [560, 40, 300], yaw: -0.9, pitch: -0.35, hour: 13.5 },
    quay:  { pos: [620, 6, 300], yaw: -1.5, pitch: -0.12, hour: 13.5 },
  };
  window.__shot = async (name = 'shore') => {
    const v = VIEWS[String(name).split(':')[0]] || VIEWS.shore;
    cam.position[0] = v.pos[0]; cam.position[1] = v.pos[1]; cam.position[2] = v.pos[2];
    cam.yaw = v.yaw; cam.pitch = v.pitch;
    cam.update(canvas.width / canvas.height);
    renderer.sky.setTimeOfDay(v.hour); renderer.sky.update(1 / 60, 0);
    renderer.setSun({ direction: renderer.sky.sunDirection, color: renderer.sky.sunColor,
      intensity: renderer.sky.sunIntensity, ambientSky: renderer.sky.ambientSky, ambientGround: renderer.sky.ambientGround });
    renderer.setFog({ color: renderer.sky.fogColor, density: 0.0016, heightFalloff: 0.018 });
    world.update(1 / 60, v.hour, cam); world.update(1 / 60, v.hour, cam);
    renderer.render(cam, 1 / 60); renderer.render(cam, 1 / 60);
  };
  // numeric probe of the waterfront road
  let worst = 0, wx = 0, wz = 0;
  for (const lane of city.lanes) for (const p of lane.pts) {
    const g = collision.groundHeight(p[0], p[1]);
    if (g < worst) { worst = g; wx = p[0]; wz = p[1]; }
  }
  out.notes.push(`worst lane groundHeight ${worst.toFixed(2)} at (${wx.toFixed(0)},${wz.toFixed(0)})`);
  return out;
}
