import { createGLContext } from '/js/core/gl.js';
import { buildTextureLibrary } from '/js/render/textures.js';
import { Renderer, Camera } from '/js/render/renderer.js';
import { generateCity } from '/js/world/citygen.js';
import { buildWorld } from '/js/world/worldbuild.js';
import { CollisionWorld } from '/js/world/collision.js';
import { box, plane } from '/js/core/geometry.js';

const meanOf = (c) => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let r = 0, g = 0, b = 0, a = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i+1]; b += d[i+2]; a += d[i+3]; }
  const n = d.length / 4;
  return [ +(r/n).toFixed(1), +(g/n).toFixed(1), +(b/n).toFixed(1), +(a/n).toFixed(1) ];
};

export default async function run({ canvas }) {
  const out = { notes: [], materials: [], facades: {} };
  const gl = createGLContext(canvas, {});
  const tex = buildTextureLibrary(gl, { size: 256 });
  for (const k of ['glassFacade', 'officeFacade', 'apartmentFacade', 'groundFloorShops', 'concrete', 'brick', 'asphalt', 'sidewalk']) {
    if (tex.canvases && tex.canvases[k]) out.facades[k] = meanOf(tex.canvases[k]);
  }

  const renderer = new Renderer(gl, canvas, {});
  renderer.textures = tex;
  renderer.createMaterial = renderer.createMaterial || ((d) => (window.__cm ? window.__cm(d) : d));
  const mats = await import('/js/render/materials.js');
  if (typeof renderer.createMaterial !== 'function') renderer.createMaterial = mats.createMaterial;
  renderer.updateMaterial = renderer.updateMaterial || mats.updateMaterial;

  const city = generateCity(20260906, {});
  const coll = new CollisionWorld(2000, 16);
  const world = buildWorld(gl, renderer, tex, city, { collision: coll });

  // Dump every material the world created
  const seen = new Map();
  const batches = renderer._staticBatches || renderer.staticBatches || [];
  for (const b of batches) {
    const m = b && b.material;
    if (m && !seen.has(m)) {
      seen.set(m, 1);
      out.materials.push({
        name: m.name, albedo: m.albedo && Array.from(m.albedo).map(v => +v.toFixed(3)),
        rough: m.roughness, metal: m.metallic,
        emissive: m.emissive && Array.from(m.emissive).map(v => +v.toFixed(3)),
        windowGlow: m.windowGlow, map: !!m.map, vertexColors: !!m.vertexColors,
      });
    }
  }
  out.notes.push(`static batches: ${batches.length}, distinct materials: ${seen.size}`);

  // Isolated lighting test: one building-sized box with the office facade material, lit from +X
  const testMat = renderer.createMaterial({
    albedo: [0.6, 0.6, 0.62], roughness: 0.75, map: tex.officeFacade, uvScale: [1, 1],
    windowGlow: 1, name: 'diag-facade',
  });
  const rr = new Renderer(gl, canvas, {});
  rr.textures = tex;
  rr.createMaterial = mats.createMaterial; rr.updateMaterial = mats.updateMaterial;
  rr.resize(canvas.width, canvas.height);
  rr.addStatic(plane(400, 400, 4, 4, [80, 80]), rr.createMaterial({ albedo: [0.3, 0.3, 0.3], roughness: 0.9 }));
  const g = box(20, 40, 20, { uvScale: [0.5, 0.5] });
  for (let i = 0; i < g.positions.length; i += 3) g.positions[i + 1] += 20;
  rr.addStatic(g, testMat);
  rr.setSun({ direction: [0.6, 0.7, 0.4], color: [1, 0.96, 0.9], intensity: 3.2,
    ambientSky: [0.3, 0.38, 0.52], ambientGround: [0.16, 0.15, 0.13] });
  rr.setFog({ color: [0.6, 0.7, 0.8], density: 0.0002, heightFalloff: 0.01 });
  const cam = new Camera(62, 0.1, 900);
  cam.position[0] = 70; cam.position[1] = 22; cam.position[2] = 70;
  cam.yaw = 0.72; cam.pitch = -0.08;
  cam.update(canvas.width / canvas.height);
  rr.render(cam, 1 / 60);

  const px = new Uint8Array(4 * 200 * 200);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(500, 300, 200, 200, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let r = 0, gg = 0, b = 0, mx = 0;
  for (let i = 0; i < px.length; i += 4) { r += px[i]; gg += px[i+1]; b += px[i+2]; mx = Math.max(mx, px[i]); }
  const n = px.length / 4;
  out.notes.push(`isolated lit facade box: mean ${(r/n).toFixed(1)}/${(gg/n).toFixed(1)}/${(b/n).toFixed(1)} max R ${mx}`);

  window.__shot = async () => { cam.update(canvas.width / canvas.height); rr.render(cam, 1 / 60); };
  return out;
}
