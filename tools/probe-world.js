/**
 * Headless probe for the world stack: citygen -> collision -> worldbuild.
 *
 * Verifies the generated city is self-consistent (no dangling graph ids, no buildings on roads),
 * that collision is queryable everywhere, and that the world builds into a sane number of draw
 * calls and triangles without GL errors.
 *
 * Run: node tools/gl-probe.mjs tools/probe-world.js
 */
import { createGLContext } from '/js/core/gl.js';
import { generateCity, cityStats, laneAt, walkAt, districtAt } from '/js/world/citygen.js';
import { buildWorld } from '/js/world/worldbuild.js';
import { CollisionWorld } from '/js/world/collision.js';
import { Renderer, Camera } from '/js/render/renderer.js';
import { buildTextureLibrary } from '/js/render/textures.js';

export default async function run({ canvas }) {
  const out = { errors: [], notes: [] };
  const bad = (m) => out.errors.push(m);
  const t = (label, fn) => { const s = performance.now(); const r = fn(); out.notes.push(`${label}: ${(performance.now() - s).toFixed(0)} ms`); return r; };

  const gl = createGLContext(canvas, {});
  if (!gl) { bad('no webgl2'); return out; }

  // --- city --------------------------------------------------------------------------------
  const city = t('generateCity', () => generateCity(20260906, {}));
  const stats = cityStats ? cityStats(city) : null;
  out.notes.push('cityStats: ' + JSON.stringify(stats));

  if (!city.buildings || city.buildings.length < 400) bad(`too few buildings: ${city.buildings && city.buildings.length}`);
  if (!city.props || city.props.length < 1200) bad(`too few props: ${city.props && city.props.length}`);
  if (!city.lanes || city.lanes.length < 40) bad(`too few lanes: ${city.lanes && city.lanes.length}`);

  // determinism
  const again = generateCity(20260906, {});
  if (again.buildings.length !== city.buildings.length || again.props.length !== city.props.length) {
    bad('generateCity is not deterministic for a fixed seed');
  }

  // graph integrity
  const laneIds = new Set(city.lanes.map((l) => l.id));
  let dangling = 0;
  for (const l of city.lanes) for (const n of (l.next || [])) if (!laneIds.has(n)) dangling++;
  if (dangling) bad(`${dangling} dangling lane.next ids`);
  const walkIds = new Set(city.walks.map((w) => w.id));
  let dw = 0;
  for (const w of city.walks) for (const n of (w.next || [])) if (!walkIds.has(n)) dw++;
  if (dw) bad(`${dw} dangling walk.next ids`);

  // reachability: how much of the lane graph is reachable from lane 0
  const seen = new Set([city.lanes[0].id]);
  const byId = new Map(city.lanes.map((l) => [l.id, l]));
  const q = [city.lanes[0].id];
  while (q.length) {
    const l = byId.get(q.pop());
    for (const n of (l.next || [])) if (!seen.has(n)) { seen.add(n); q.push(n); }
  }
  const reach = seen.size / city.lanes.length;
  out.notes.push(`lane graph reachability from lane 0: ${(reach * 100).toFixed(1)}%`);
  if (reach < 0.6) bad(`lane graph is fragmented (${(reach * 100).toFixed(1)}% reachable)`);

  // finite coordinates
  let nan = 0;
  for (const b of city.buildings) if (![b.x, b.z, b.w, b.d, b.h].every(Number.isFinite)) nan++;
  for (const p of city.props) if (![p.x, p.y, p.z].every(Number.isFinite)) nan++;
  if (nan) bad(`${nan} entities with non-finite coordinates`);

  // helpers
  const l0 = laneAt(city, city.spawns.player.x, city.spawns.player.z);
  out.notes.push(`laneAt(player spawn) -> ${l0 ? 'lane ' + l0.lane.id : 'null'}`);
  if (walkAt(city, city.spawns.player.x, city.spawns.player.z) === undefined) bad('walkAt returned undefined');
  if (districtAt(city, 0, 0) === undefined) bad('districtAt returned undefined');

  // --- renderer + world -----------------------------------------------------------------------
  const renderer = new Renderer(gl, canvas, {});
  renderer.resize(canvas.width, canvas.height);
  const textures = t('buildTextureLibrary', () => buildTextureLibrary(gl, { size: 256 }));
  renderer.textures = textures;

  const size = Math.max(city.bounds.max[0] - city.bounds.min[0], city.bounds.max[1] - city.bounds.min[1]) + 400;
  let collision = new CollisionWorld(size, 16);
  const world = t('buildWorld', () => buildWorld(gl, renderer, textures, city, { collision }));
  if (world && world.collision) collision = world.collision;

  out.notes.push('collision stats: ' + JSON.stringify(collision.stats || {}));
  if (world && world.stats) out.notes.push('world stats: ' + JSON.stringify(world.stats));

  // ground everywhere
  let badGround = 0;
  for (let i = 0; i < 300; i++) {
    const x = city.bounds.min[0] + Math.random() * (city.bounds.max[0] - city.bounds.min[0]);
    const z = city.bounds.min[1] + Math.random() * (city.bounds.max[1] - city.bounds.min[1]);
    if (!Number.isFinite(collision.groundHeight(x, z))) badGround++;
  }
  if (badGround) bad(`groundHeight returned non-finite at ${badGround}/300 random points`);

  // buildings actually collide
  let noHit = 0;
  for (let i = 0; i < 60; i++) {
    const b = city.buildings[(i * 37) % city.buildings.length];
    const hits = collision.querySphere(b.x, (b.h || 10) * 0.4, b.z, 2, []);
    if (!hits || hits.length === 0) noHit++;
  }
  if (noHit > 3) bad(`${noHit}/60 buildings have no collision body at their centre`);

  // --- render a few frames -----------------------------------------------------------------------
  const cam = new Camera(62, 0.12, 1600);
  cam.position[0] = city.spawns.player.x;
  cam.position[1] = 40;
  cam.position[2] = city.spawns.player.z + 60;
  cam.yaw = 0; cam.pitch = -0.25;
  let e = 0;
  const s = performance.now();
  const hour = 13.5;
  for (let i = 0; i < 8; i++) {
    cam.yaw += 0.05;
    cam.update(canvas.width / canvas.height);
    // Drive the sun from the sky exactly like js/game.js does each frame.
    if (renderer.sky) {
      renderer.sky.setTimeOfDay(hour);
      renderer.sky.update(1 / 60, 0);
      renderer.setSun({
        direction: renderer.sky.sunDirection, color: renderer.sky.sunColor,
        intensity: renderer.sky.sunIntensity, ambientSky: renderer.sky.ambientSky,
        ambientGround: renderer.sky.ambientGround,
      });
      renderer.setFog({ color: renderer.sky.fogColor, density: 0.0016, heightFalloff: 0.018 });
    }
    if (world && world.update) world.update(1 / 60, hour, cam);
    renderer.render(cam, 1 / 60);
    const g = gl.getError();
    if (g) { e = g; break; }
  }
  out.notes.push(`sun: dir=${renderer.sky ? Array.from(renderer.sky.sunDirection).map((v) => v.toFixed(2)).join(',') : '?'} intensity=${renderer.sky ? renderer.sky.sunIntensity.toFixed(2) : '?'}`);
  out.notes.push(`8 frames in ${(performance.now() - s).toFixed(0)} ms; stats=${JSON.stringify(renderer.stats)}`);
  if (e) bad(`GL error during render: 0x${e.toString(16)}`);
  if ((renderer.stats.drawCalls | 0) < 5) bad(`only ${renderer.stats.drawCalls} draw calls for a whole city`);
  if ((renderer.stats.drawCalls | 0) > 2500) bad(`too many draw calls: ${renderer.stats.drawCalls}`);

  // frame is not blank
  const W = Math.min(320, canvas.width); const H = Math.min(180, canvas.height);
  const px = new Uint8Array(4 * W * H);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels((canvas.width - W) >> 1, (canvas.height - H) >> 1, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const uniq = new Set();
  let sum = 0; let mn = 255; let mx = 0;
  for (let i = 0; i < px.length; i += 4) {
    uniq.add(px[i] >> 3 << 10 | px[i + 1] >> 3 << 5 | px[i + 2] >> 3);
    const l = (px[i] + px[i + 1] + px[i + 2]) / 3;
    sum += l; if (l < mn) mn = l; if (l > mx) mx = l;
  }
  const mean = sum / (px.length / 4);
  out.notes.push(`frame ${W}x${H}: ${uniq.size} unique colours, luma mean ${mean.toFixed(1)} range ${mn.toFixed(0)}..${mx.toFixed(0)}`);
  if (uniq.size < 24) bad(`rendered frame looks blank (${uniq.size} unique colours, luma ${mn.toFixed(0)}..${mx.toFixed(0)})`);
  if (mx - mn < 30) bad(`rendered frame has almost no contrast (${mn.toFixed(0)}..${mx.toFixed(0)})`);

  if (world && world.minimapData) {
    out.notes.push(`minimap roads=${(world.minimapData.roads || []).length} blocks=${(world.minimapData.blocks || []).length}`);
    if (!(world.minimapData.roads || []).length) bad('minimapData.roads is empty');
  } else bad('world.minimapData missing');

  // Let the harness grab a fresh frame (the drawing buffer is not preserved between tasks).
  /**
   * Renders a named viewpoint so tools/gl-probe.mjs --shot can capture it.
   * Usage from the harness: window.__shot('aerial'|'street'|'night'|'sunset')
   */
  const VIEWS = {
    aerial: { pos: [city.spawns.player.x - 260, 210, city.spawns.player.z + 340], yaw: 0.62, pitch: -0.42, hour: 13.5 },
    street: { pos: [city.spawns.player.x, 3.2, city.spawns.player.z + 14], yaw: 0.0, pitch: -0.04, hour: 12.0 },
    sunset: { pos: [city.spawns.player.x - 200, 120, city.spawns.player.z + 280], yaw: 0.62, pitch: -0.26, hour: 18.2 },
    night: { pos: [city.spawns.player.x - 200, 120, city.spawns.player.z + 280], yaw: 0.62, pitch: -0.26, hour: 22.0 },
  };
  window.__shot = async (name = 'aerial') => {
    const spec = String(name || 'aerial').split(':');
    const v = VIEWS[spec[0]] || VIEWS.aerial;
    // Optional post-FX overrides, e.g. --view "street:grain=0,chromatic=0,exposure=1.4"
    if (spec[1] && renderer.postParams) {
      for (const kv of spec[1].split(',')) {
        const [k, val] = kv.split('=');
        if (k && val !== undefined && k in renderer.postParams) renderer.postParams[k] = Number(val);
      }
      if (spec[1].includes('exposure=') && renderer.setExposure) {
        const e = Number(spec[1].split('exposure=')[1].split(',')[0]);
        if (Number.isFinite(e)) renderer.setExposure(e);
      }
    }
    cam.position[0] = v.pos[0]; cam.position[1] = v.pos[1]; cam.position[2] = v.pos[2];
    cam.yaw = v.yaw; cam.pitch = v.pitch;
    cam.update(canvas.width / canvas.height);
    if (renderer.sky) {
      renderer.sky.setTimeOfDay(v.hour);
      renderer.sky.update(1 / 60, 0);
      renderer.setSun({
        direction: renderer.sky.sunDirection, color: renderer.sky.sunColor,
        intensity: renderer.sky.sunIntensity, ambientSky: renderer.sky.ambientSky,
        ambientGround: renderer.sky.ambientGround,
      });
      renderer.setFog({ color: renderer.sky.fogColor, density: 0.0016, heightFalloff: 0.018 });
    }
    // Two updates so night lights latch on before the capture.
    if (world && world.update) { world.update(1 / 60, v.hour, cam); world.update(1 / 60, v.hour, cam); }
    renderer.render(cam, 1 / 60);
    renderer.render(cam, 1 / 60);
  };

  return out;
}
