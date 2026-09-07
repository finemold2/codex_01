# NEON CITY — Architecture & Module Contract

A GTA-style third-person open-world action game. **Zero dependencies, no build step.**
Pure ES modules + WebGL2 + Web Audio API. Runs by opening `index.html` from any static server.

> This document is the binding contract between modules. Signatures here are normative:
> implement them exactly. Do not invent alternative names.

---

## 0. Global rules

- **ES modules only.** `import { vec3 } from '../core/math.js'` (always include the `.js`).
- **No external libraries, no CDN, no bundler.** Everything ships in this repo.
- **WebGL2 required.** `main.js` shows a graceful error if unavailable.
- **Units are meters, seconds, radians.** Y is up. Ground plane is `y = 0`.
  World lies on the XZ plane; `+X` = east, `+Z` = south. Camera looks down `-Z` in view space.
- **Yaw convention:** `yaw = 0` faces `-Z` (north). Forward vector = `[-sin(yaw)*cos(pitch), sin(pitch), -cos(yaw)*cos(pitch)]`.
  Ground forward (movement) = `[-sin(yaw), 0, -cos(yaw)]`, right = `[cos(yaw), 0, -sin(yaw)]`.
- **Matrices are column-major `Float32Array(16)`** (WebGL/gl-matrix layout). Element `m[12..14]` = translation.
- **Colors are linear-space `[r,g,b]` floats 0..1** unless a name ends in `Srgb`.
- **No allocation in hot loops.** Reuse scratch vectors/matrices declared at module scope.
- **Determinism:** all procedural generation uses the seeded `Rand` class, never `Math.random()`.
- **Every module is `export`-only** — no side effects at import time except pure constant tables.
- **Code style:** 2-space indent, single quotes, semicolons, `const`/`let`, JSDoc on public API.
  Comments in English. User-visible strings in Korean.

## 1. File layout

```
index.html                 shell: canvas, HUD DOM, menus, loading screen
css/game.css               all UI styling
js/main.js                 boot, asset build, main loop, menu wiring
js/game.js                 world state + system update order + camera rig + player glue
js/core/math.js            vec2/vec3/vec4/quat/mat3/mat4/aabb/Rand/scalar helpers
js/core/gl.js              WebGL2 wrappers: Shader, GpuMesh, Texture2D, RenderTarget
js/core/geometry.js        primitive builders + merge/transform utilities
js/core/input.js           keyboard, mouse (pointer lock), gamepad, touch
js/render/shaders.js       all GLSL source strings
js/render/materials.js     Material definition + uniform packing
js/render/renderer.js      Camera, Renderer (shadow/opaque/transparent passes)
js/render/sky.js           atmospheric sky, sun/moon/stars/clouds, time of day
js/render/postfx.js        bloom, ACES tonemap, FXAA, vignette, grain, wet/rain overlay
js/render/particles.js     billboard particle system
js/render/textures.js      procedural texture generation (canvas2d -> Texture2D)
js/world/citygen.js        seeded city layout data (roads, lanes, lots, buildings, props)
js/world/worldbuild.js     CityData -> GPU batches + collision bodies
js/world/collision.js      spatial hash, AABB queries, sphere sweep, raycast
js/entities/character.js   procedural humanoid rig + animation state machine
js/entities/player.js      on-foot player controller (movement, aim, enter/exit)
js/entities/vehicle.js     vehicle model assembly + arcade physics
js/entities/ped.js         pedestrian AI
js/entities/traffic.js     traffic AI (lane following, lights, avoidance)
js/entities/police.js      wanted system + police AI
js/entities/weapons.js     weapon definitions, firing, ballistics, damage
js/audio/audio.js          AudioContext graph, buses, 3D listener, master controls
js/audio/sfx.js            procedural sound effects
js/audio/music.js          classical music sequencer + synthesizer
js/audio/scores.js         public-domain classical scores as note data
js/ui/hud.js               HUD: health, wanted, money, weapon, minimap, notifications
js/ui/menu.js              main menu, pause, settings, controls
js/ui/map.js               fullscreen map screen
js/missions.js             mission definitions + state machine
```

---

## 2. `core/math.js`

gl-matrix-compatible, out-parameter style. All `out` params are returned.

```js
export const EPS, TAU, PI, DEG2RAD, RAD2DEG;
export function clamp(v, lo, hi);
export function lerp(a, b, t);
export function smoothstep(e0, e1, x);
export function damp(a, b, lambda, dt);          // frame-rate independent lerp
export function wrapAngle(a);                    // -> (-PI, PI]
export function angleLerp(a, b, t);              // shortest path
export function angleDamp(a, b, lambda, dt);
export function moveTowards(a, b, maxDelta);
export function randRange(rng, a, b);

export const vec2 = { create, fromValues, set, copy, clone, add, sub, mul, scale, scaleAndAdd,
  len, sqrLen, dist, sqrDist, normalize, dot, cross2, lerp, rotate, angle, negate, zero };
export const vec3 = { create, fromValues, set, copy, clone, add, sub, mul, div, scale, scaleAndAdd,
  len, sqrLen, dist, sqrDist, normalize, dot, cross, lerp, negate, min, max, zero,
  transformMat4, transformMat4Dir, transformQuat, rotateY, floor, equals };
export const vec4 = { create, fromValues, set, copy, scale, add, transformMat4 };
export const quat = { create, identity, copy, setAxisAngle, fromEuler /* (out,yaw,pitch,roll) YXZ */,
  multiply, normalize, slerp, conjugate, rotateVec3, fromMat4, toMat4 };
export const mat3 = { create, identity, fromMat4, normalFromMat4, transpose, invert, multiply };
export const mat4 = { create, identity, copy, clone, multiply, translate, rotateX, rotateY, rotateZ,
  scale, fromTranslation, fromScaling, fromRotationY, fromRotationTranslationScale,
  fromQuatPosScale, perspective, ortho, lookAt, targetTo, invert, transpose,
  getTranslation, getForward, getRight, getUp, compose };

export const aabb = { create, fromCenterSize, fromPoints, set, copy, center, size, expandPoint,
  expandAabb, intersects, containsPoint, distanceToPoint, rayIntersect /* -> t or -1 */,
  sphereIntersects, closestPoint };

export class Rand {
  constructor(seed = 1);      // xorshift128 / mulberry32, deterministic
  next();                     // [0,1)
  range(a, b);
  int(a, b);                  // inclusive
  pick(array);
  chance(p);
  sign();
  gaussian();
  fork(salt);                 // -> new Rand deterministically derived
}
```

## 3. `core/gl.js`

```js
export function createGLContext(canvas, opts) -> WebGL2RenderingContext | null;
  // requests antialias:false (we do our own AA), alpha:false, powerPreference:'high-performance',
  // enables EXT_color_buffer_float / OES_texture_float_linear when present.

export class Shader {
  constructor(gl, vertexSrc, fragmentSrc, defines = {}, name = '');
  use();
  uniform(name) -> WebGLUniformLocation|null;   // cached
  setFloat(n, v); setInt(n, v); setVec2(n, x, y); setVec3(n, x, y, z);
  setVec3v(n, arr); setVec4(n, x, y, z, w); setVec4v(n, arr);
  setMat3(n, m); setMat4(n, m); setMat4Array(n, arr); setFloatArray(n, arr); setVec3Array(n, arr);
  setTexture(n, texture, unit);
  dispose();
}

/** Geometry object accepted everywhere: plain object with typed arrays. */
// { positions: Float32Array, normals: Float32Array, uvs: Float32Array,
//   indices: Uint32Array|Uint16Array, colors?: Float32Array (rgb), bounds?: {min,max} }

export class GpuMesh {
  constructor(gl, geometry);            // builds VAO with attribs 0=pos 1=normal 2=uv 3=color
  enableInstancing(capacity, floatsPerInstance = 20);  // attribs 4..7 = mat4, 8 = vec4 tint
  setInstanceData(float32Array, count); // uploads, sets this.instanceCount
  draw(instanceCount = 0);
  dispose();
  indexCount; bounds;
}

export class Texture2D {
  constructor(gl, opts);
  // opts: {width,height,data|source(canvas/img),internalFormat,format,type,
  //        wrap:'repeat'|'clamp'|'mirror', filter:'linear'|'nearest', mipmaps:bool,
  //        anisotropy:number, srgb:bool}
  static fromCanvas(gl, canvas, {srgb=true, mipmaps=true, wrap='repeat', anisotropy=8});
  static solid(gl, r, g, b, a = 255);
  bind(unit);
  update(source);
  dispose();
}

export class RenderTarget {
  constructor(gl, width, height, opts);
  // opts: {colorFormat:'rgba8'|'rgba16f'|'r11g11b10', depth:bool, depthTexture:bool,
  //        filter:'linear'|'nearest', wrap:'clamp', colorCount:1}
  bind(clear = true);          // sets viewport + framebuffer
  resize(w, h);
  color(i = 0) -> Texture2D-like {texture, bind(unit)};
  depthTex;
  dispose();
}

export function drawFullscreen(gl);      // draws a fullscreen triangle (no VBO needed, gl_VertexID)
export function checkGLError(gl, tag);   // dev only, no-op unless DEBUG
```

## 4. `core/geometry.js`

All builders return the geometry object described above, centered at origin unless stated.

```js
export function box(w, h, d, opts = {});             // opts.uvScale = [u,v], opts.center = [x,y,z]
export function roundedBox(w, h, d, radius, segments = 3);
export function plane(w, d, segX = 1, segZ = 1, uvScale = [1, 1]);  // faces +Y
export function sphere(radius, widthSeg = 16, heightSeg = 12);
export function cylinder(rTop, rBottom, height, radialSeg = 16, capped = true);
export function cone(radius, height, radialSeg = 16);
export function capsule(radius, height, radialSeg = 12, capSeg = 6);
export function torus(radius, tube, radialSeg = 16, tubularSeg = 24);
export function wedge(w, h, d);                       // right-triangle prism, ramp facing +Z
export function extrudePolygon(points2d, height, opts = {}); // points [[x,z],...] CCW, base y=0
export function polygonFan(points2d, y = 0);          // flat cap, faces +Y
export function tube(pathPoints3d, radius, radialSeg = 8);
export function quadStrip(pointsLeft3d, pointsRight3d, uvRepeat = 1); // roads / sidewalks

export function transformGeometry(geo, matrix);       // in place, also rotates normals
export function translateGeometry(geo, x, y, z);
export function scaleGeometry(geo, sx, sy, sz);
export function colorizeGeometry(geo, rgb);           // fills .colors
export function mergeGeometries(list);                // [{geometry, matrix?, color?}] -> geometry
export function computeBounds(geo);                   // -> {min:[..], max:[..]}, also sets geo.bounds
export function computeNormals(geo);
export function geometryTriangleCount(geo);
```

## 5. `render/materials.js` + `render/renderer.js`

```js
// materials.js
export function createMaterial(desc) -> Material;
// desc (all optional): {
//   name, albedo:[r,g,b]=[1,1,1], roughness=0.8, metallic=0.0, emissive:[r,g,b]=[0,0,0],
//   emissiveStrength=1, map=null (Texture2D), normalMap=null, ormMap=null,
//   uvScale=[1,1], uvOffset=[0,0], alpha=1, blend='opaque'|'alpha'|'add',
//   doubleSided=false, castShadow=true, receiveShadow=true, vertexColors=false,
//   windowGlow=0 (0..1: emissive window animation), reflectivity=0.04, unlit=false,
//   depthWrite=true, sortBias=0, wetness=0
// }
export function updateMaterial(mat, patch);
```

```js
// renderer.js
export class Camera {
  constructor(fovDeg = 62, near = 0.12, far = 1400);
  position; yaw; pitch; roll; fov; near; far;
  view; proj; viewProj; invView; invProj;  // Float32Array(16)
  forward; right; up;                      // vec3, updated by update()
  setLookAt(eye, target, up);
  update(aspect);                          // recomputes matrices + basis + frustum
  frustumContainsSphere(x, y, z, r) -> bool;
  worldToScreen(v3, outVec3, viewportW, viewportH) -> bool; // false if behind camera
}

export class Renderer {
  constructor(gl, canvas, options = {});
  gl; canvas; sky; particles; stats;   // stats {drawCalls, triangles, fps, frameMs}
  quality;   // {name:'low'|'medium'|'high'|'ultra', shadowRes, cascades, bloom, ssao,
             //  renderScale, maxPointLights, aniso, particleBudget}
  setQuality(nameOrObject);
  resize(width, height);

  createMesh(geometry) -> GpuMesh;                       // cached upload helper
  addStatic(geometry, material) -> number;               // static world geometry, merged per material
  removeStatic(id);
  addInstanced(geometry, material, capacity) -> InstancedBatch;
  clearWorld();                                          // drops all static/instanced batches

  submit(mesh, material, matrix, opts = null);           // per-frame dynamic draw
    // opts: {tint:[r,g,b,a], castShadow:bool, emissiveBoost:number}
  submitLight(x, y, z, r, g, b, radius, intensity);      // per-frame point light
  submitSpotLight(pos3, dir3, color3, range, cosInner, cosOuter, intensity); // headlights

  setSun({direction, color, intensity, ambientSky, ambientGround, shadowStrength});
  setFog({color, density, heightFalloff, skyBlend});
  setExposure(v); setWetness(v01); setRainIntensity(v01);
  render(camera, dt);
}

export class InstancedBatch {
  setCount(n); setInstance(i, matrix, tintRgba); upload(); // or setAll(float32Array, count)
  material; capacity; count; visible;
}
```

**Renderer implementation requirements (non-negotiable for "high graphics quality"):**
1. HDR pipeline: render to `RGBA16F`, ACES filmic tonemap + exposure at the end.
2. Cook–Torrance GGX PBR: albedo/roughness/metallic, Fresnel-Schlick, Smith visibility,
   simple analytic sky IBL (hemisphere ambient split into sky/ground colors) + specular ambient.
3. Cascaded shadow maps (3 cascades at high, 1 at low) with PCF (3x3..5x5) and normal-offset bias.
4. Forward point/spot lights: cull to the 32 nearest per draw call, no popping artifacts.
5. Height + distance exponential fog matched to the sky color (aerial perspective).
6. Post FX: bright-pass + progressive mip bloom, FXAA, vignette, film grain, chromatic aberration
   at screen edges, optional SSAO (depth-derived normals, 12 samples, blurred).
7. Frustum culling for static batches (per-batch bounds) and instanced batches.
8. Draw-call sorting: opaque front-to-back by material, transparent back-to-front.
9. `renderScale` support so quality scales on weak GPUs; target 60 fps at 1080p on integrated GPUs.

## 6. `render/sky.js`, `render/postfx.js`, `render/particles.js`, `render/textures.js`

```js
// sky.js
export class Sky {
  constructor(gl, renderer);
  timeOfDay;        // 0..24 hours, 12 = noon
  setTimeOfDay(h);
  update(dt, speed); // advances clock; recomputes sunDirection/colors
  sunDirection; sunColor; sunIntensity; ambientSky; ambientGround; fogColor; nightFactor; // 0..1
  moonDirection; starIntensity;
  render(camera);   // full-screen sky (procedural Rayleigh/Mie scattering + clouds + stars + moon)
}

// postfx.js
export class PostFX {
  constructor(gl, renderer);
  resize(w, h);
  render(hdrTexture, depthTexture, camera, dt, params);
  // params: {exposure, bloomStrength, bloomThreshold, vignette, grain, chromatic,
  //          saturation, contrast, rain, wetness, damageFlash, deathFade, ssao}
}

// particles.js
export class ParticleSystem {
  constructor(gl, renderer, maxParticles = 6000);
  spawn(opts);
  // opts: {x,y,z, vx,vy,vz, life, size, sizeEnd, color:[r,g,b], colorEnd, alpha, alphaEnd,
  //        gravity, drag, kind:'smoke'|'spark'|'flash'|'blood'|'debris'|'rain'|'dust'|'fire'|'glass',
  //        rotation, rotationSpeed, additive, light}
  burst(kind, x, y, z, count, opts = {});   // preset bursts used by gameplay code
  update(dt, camera);
  render(camera);
  clear();
}

// textures.js  — all textures are generated procedurally on an offscreen canvas
export function buildTextureLibrary(gl) -> TextureLibrary;
// TextureLibrary keys (Texture2D each; *_n suffix = normal map):
//  asphalt, asphalt_n, roadLines, sidewalk, sidewalk_n, concrete, concrete_n, brick, brick_n,
//  glassFacade (window grid w/ emissive mask in alpha), officeFacade, apartmentFacade,
//  metal, metal_n, roofGravel, grass, dirt, sand, water, waterNormal, treeBark, leaves,
//  carPaintNoise, tire, chrome, neonSign1..3, billboard1..4, graffiti1..2, tileFloor,
//  smoke, spark, flash, blood, glassShard, raindrop, muzzle, decalBulletHole, decalCrack,
//  skyStars, noiseBlue, gradientRamp
export function makeNoiseCanvas(w, h, opts);       // helper, exported for reuse
export function normalMapFromHeight(canvas, strength) -> canvas;
```

## 7. `world/citygen.js` — CityData contract

```js
export function generateCity(seed = 1337, opts = {}) -> CityData;
// opts: {blocksX=14, blocksZ=14, blockSize=64, roadWidth=16, seaSide=true}
```

```ts
CityData = {
  seed, blockSize, roadWidth, blocksX, blocksZ,
  bounds: { min: [x, z], max: [x, z] },          // playable area
  districts: [{ id, name, kind:'downtown'|'midtown'|'residential'|'industrial'|'park'|'beach', rect:{x,z,w,d}, palette:[[r,g,b],...] }],
  roads:  [{ id, ax, az, bx, bz, width, axis:'x'|'z', lanes }],
  nodes:  [{ id, x, z, roads:[roadId], hasTrafficLight:bool }],  // intersections
  lanes:  [{ id, pts:[[x,z],...], width, next:[laneId], nodeId|null, speedLimit, oneWay:true }],
  walks:  [{ id, pts:[[x,z],...], next:[walkId], crossing:bool }],  // pedestrian graph
  lots:   [{ id, districtId, x, z, w, d, kind:'building'|'park'|'parking'|'plaza'|'water' }],
  buildings: [{ id, lotId, x, z, w, d, h, floors, style:'tower'|'office'|'apartment'|'shop'|'warehouse'|'house',
                rot, palette:{wall:[r,g,b], trim:[r,g,b], glass:[r,g,b]}, hasSetback, roofKind, signs:[{...}] }],
  props:  [{ type, x, y, z, rot, scale, extra }],   // streetlight|tree|palm|bench|hydrant|trafficlight|
                                                    // sign|bin|busstop|billboard|barrier|cone|dumpster|
                                                    // planter|bollard|atm|phonebox|streetvendor|lamp
  spawns: { player: {x, y, z, yaw}, vehicles: [{x, y, z, yaw, laneId}], peds: [{x, y, z}],
            police: [{x, y, z, yaw}], missionPoints: [{x, y, z, name}] },
  landmarks: [{ id, name, x, z, kind }],
  waterLevel: number|null,
};
```
Rules: buildings never overlap roads or sidewalks; lanes are directed with correct handedness
(right-hand traffic); `walks` run along both sides of every road with crossings at intersections;
downtown in the centre with the tallest towers, gradually lower outward; one park and one
waterfront district; ≥ 600 buildings and ≥ 1500 props for a dense city.

## 8. `world/worldbuild.js` & `world/collision.js`

```js
// worldbuild.js
export function buildWorld(gl, renderer, textures, city, opts = {}) -> WorldRender;
// WorldRender = { collision: CollisionWorld, lights: [{x,y,z,r,g,b,radius,intensity,night:bool}],
//                 trafficLights: [{nodeId, x, z, phase, meshes...}], update(dt, timeOfDay, camera),
//                 minimapData: {roads:[...], blocks:[...], water:[...]},  // for ui/map.js + hud minimap
//                 dispose() }
// Builds merged static batches per material (roads, sidewalks, ground, buildings, roofs,
// windows/emissive, props via InstancedBatch), plus night-time emissive window animation.

// collision.js
export class CollisionWorld {
  constructor(worldSize, cellSize = 16);
  addBox(cx, cy, cz, hx, hy, hz, yaw = 0, tag = 'static', userData = null) -> id;
  addCylinder(cx, cy, cz, radius, height, tag, userData) -> id;
  remove(id);
  queryAABB(minx, miny, minz, maxx, maxy, maxz, out = []) -> array of bodies;
  querySphere(x, y, z, r, out = []) -> bodies;
  /** Resolves a vertical capsule against the world. Returns {x,y,z,grounded,normal,hit}. */
  moveCapsule(pos3, radius, height, delta3, out) -> {x, y, z, grounded, groundY, normal, hits};
  /** Swept sphere for vehicles / projectiles. */
  sweepSphere(from3, to3, radius) -> {t, hit, normal, body} | null;
  raycast(origin3, dir3, maxDist, filterFn = null) -> {t, point, normal, body} | null;
  groundHeight(x, z) -> number;    // top surface (roads/sidewalks/terrain)
  stats;
}
```

## 9. `entities/character.js`

Procedural, bone-driven humanoid built from primitives (no external model formats).

```js
export const BONES = ['root','pelvis','spine','chest','neck','head','shoulderL','armL','forearmL','handL',
  'shoulderR','armR','forearmR','handR','thighL','shinL','footL','thighR','shinR','footR'];

export function buildCharacterMeshes(gl, renderer, textures) -> CharacterAssets; // shared, build once

export class Character {
  constructor(assets, opts);  // opts: {skin:[r,g,b], shirt, pants, hair, height=1.8, kind:'civ'|'cop'|'player'|'gangster', female:bool}
  position; yaw; velocity; height; radius;
  state;      // 'idle'|'walk'|'run'|'sprint'|'jump'|'fall'|'aim'|'shoot'|'punch'|'hit'|'die'|'drive'|'enter'|'exit'
  setState(name, opts);
  update(dt, ctx);   // ctx: {moveSpeed, aimPitch, aiming, grounded, seatMatrix|null}
  getBoneMatrix(name) -> mat4;      // world-space
  getMuzzleOrigin(out3);            // right hand weapon muzzle
  submit(renderer);                 // draws all body parts with correct bone matrices
  playRagdoll(impulse3);            // simple procedural death fall
}
```
Animation requirements: hand-authored keyframe poses (arrays of per-bone euler angles) blended with
`angleLerp`, plus procedural additive layers — hip bob, arm swing, foot planting via a phase-based
gait cycle, head look-at, torso twist when aiming, recoil kick, lean into turns. Blend between
states over 0.12–0.25 s. Everything must be frame-rate independent.

## 10. `entities/vehicle.js`

```js
export const VEHICLE_TYPES = { sedan, sports, suv, taxi, police, van, truck, muscle, bus, sportsbike };
// each: {name, mass, enginePower, brakeForce, maxSpeed, grip, steerMax, steerSpeed, driftFactor,
//        length, width, height, wheelBase, wheelRadius, seats, colorOptions, sirens:bool, price}

export function buildVehicleAssets(gl, renderer, textures) -> VehicleAssets;

export class Vehicle {
  constructor(assets, typeKey, opts);   // {position, yaw, color, isPolice}
  position; velocity; yaw; speed; rpm; gear; steer; health; type; occupants; wheels;
  input;    // {throttle: -1..1, brake: 0..1, steer: -1..1, handbrake: bool, horn: bool}
  update(dt, collision, ctx);
  applyDamage(amount, point3, impulse3);
  getSeatMatrix(index, out) -> mat4;
  getDoorPosition(index, out3);
  submit(renderer, dt);            // body, wheels (steering + rolling), lights, sirens
  setLights(headlights, brake, reverse, siren);
  explode();
  isDestroyed;
}
```
Physics requirements: per-wheel raycast suspension (4 rays), longitudinal engine/brake force with a
gearbox curve, lateral grip with slip-angle-based drift and handbrake sliding, downforce, air drag,
body roll/pitch visuals from suspension compression, collision response against `CollisionWorld`
(impulse + damage + sparks), speed-sensitive steering, arcade-friendly but stable at 200 km/h.

## 11. `entities/ped.js`, `entities/traffic.js`, `entities/police.js`, `entities/weapons.js`

```js
// ped.js
export class PedManager {
  constructor(game);   // access to city, collision, characters, audio, particles
  spawnAround(pos3, count);
  update(dt, playerPos);
  peds;   // [{character, state:'walk'|'idle'|'flee'|'panic'|'dead'|'cower'|'chat', health, ...}]
  alertGunshot(pos3, radius);
  damagePed(ped, amount, dir3, headshot);
  raycastPeds(origin3, dir3, maxDist) -> {ped, t, point, headshot} | null;
}

// traffic.js
export class TrafficManager {
  constructor(game);
  update(dt, playerPos);
  vehicles;  // active AI vehicles
  spawnAround(pos3, count);
  despawnFar(pos3, radius);
  alert(pos3, radius);       // drivers panic / stop
}

// police.js
export class PoliceSystem {
  constructor(game);
  wanted;         // 0..5
  addWanted(amount, reason);
  clearWanted();
  update(dt);
  cops;           // on-foot cops
  cars;           // police vehicles
  heatMeterVisible; searchTimer;
}

// weapons.js
export const WEAPONS = { fist, pistol, smg, shotgun, rifle, sniper, grenade };
// {name, nameKo, damage, fireRate, magazine, reserve, spread, recoil, range, auto, pellets,
//  reloadTime, muzzleVelocity, sfx, twoHanded, zoom, icon}
export class WeaponSystem {
  constructor(game);
  current; ammo;   // per-weapon {mag, reserve}
  switchTo(key); nextWeapon(); prevWeapon();
  tryFire(origin3, dir3, ownerIsPlayer, spreadMul) -> bool;
  reload();
  update(dt);
  applyHit(hit, damage, dir3);
}
```

## 12. `audio/*`

```js
// audio.js
export class AudioEngine {
  constructor();
  ctx; master; buses;   // buses: music, sfx, ui, ambience, vehicle, weapon, voice
  async resume();                        // must be called from a user gesture
  setVolume(bus, v01); getVolume(bus);
  setListener(position3, forward3, up3, velocity3);
  createPositional(bus, opts) -> {input, node, setPosition(x,y,z), setVolume(v), stop()};
  playSound(nodeFactory, opts);          // helper used by sfx.js
  now; enabled;
  suspend(); duck(amount, seconds);      // duck music under gunfire/dialogue
}

// sfx.js — 100% procedurally synthesized. NO audio files.
export class SFX {
  constructor(audioEngine);
  gunshot(kind, pos3, opts); reload(kind, pos3); bulletImpact(surface, pos3); ricochet(pos3);
  footstep(surface, pos3, running); jump(pos3); land(pos3); punch(pos3); bodyFall(pos3);
  carCollision(force, pos3); glassBreak(pos3); explosion(pos3); tireScreech(pos3, intensity);
  horn(pos3, type); doorOpen(pos3); doorClose(pos3); pickup(kind); uiClick(kind);
  siren(pos3) -> handle {stop(), setPosition()}; radioStatic(); heartbeat(rate);
  wanted(level); missionSuccess(); missionFail(); notify(kind);
  createEngine(vehicle) -> EngineVoice { update(rpm, load, speed, pos3), stop() };
  ambience(kind) -> handle;   // city hum, wind, rain, seagulls, crowd
  rain(intensity);
}

// music.js
export class MusicPlayer {
  constructor(audioEngine, scores);
  stations;        // [{id, name, nameKo, composer, tracks:[scoreId]}]
  currentStation; currentTrack; playing;
  play(stationId = null); stop(); pause(); resume();
  next(); prev(); setStation(id); nextStation();
  update(dt);
  onTrackChange;   // callback(trackInfo) for HUD "now playing"
  setIntensity(x); // 0..1 — action music variation (tempo/dynamics), used during chases
}
```
**Music requirements** — this is a headline feature:
- Fully synthesized multi-voice orchestra: piano, harpsichord, strings (saw/pulse + slow attack +
  vibrato + ensemble detune), pizzicato, woodwind, brass, timpani, organ, harp, celesta.
- Proper ADSR envelopes, per-voice filters, stereo width, an algorithmic reverb (generated
  impulse response convolver), a gentle bus compressor and EQ. It must sound *musical*, not beepy.
- Polyphonic scheduler with look-ahead (`setTimeout` 25 ms tick, schedule 0.4 s ahead) so timing is
  sample-accurate and never glitches under GC or frame drops.
- Support: tempo/rubato, dynamics (pp..ff), articulation (legato/staccato/accent), swing off,
  repeats, per-track instrumentation and per-voice pan.
- Radio stations mapping to classical repertoire (all public domain).

```js
// scores.js — note data only, no code dependencies
export const SCORES = { /* id: Score */ };
// Score = {
//   id, title, titleKo, composer, year, tempo /* BPM */, timeSig:[4,4], key,
//   swing:0, reverb:0.35, station:'classic'|'baroque'|'romantic'|'opera'|'action',
//   tracks: [{ instrument:'piano'|'strings'|'cello'|'violin'|'harpsichord'|'organ'|'flute'|
//              'oboe'|'clarinet'|'horn'|'trumpet'|'timpani'|'harp'|'celesta'|'pizzicato'|'bass',
//              gain:0..1, pan:-1..1, notes: [[timeBeats, midiPitch|null, durBeats, velocity0..1], ...] }],
//   loop:true, lengthBeats: number, sections?: [{name, startBeat}]
// }
```
Required repertoire (all public domain, transcribed as note data — at least **10** pieces,
each ≥ 60 seconds of music when looped, with real harmony, bass lines and inner voices):
1. J.S. Bach — Air on the G String (BWV 1068)
2. J.S. Bach — Prelude No. 1 in C major (BWV 846)
3. J.S. Bach — Toccata and Fugue in D minor (BWV 565) — opening
4. Beethoven — Moonlight Sonata, Op. 27 No. 2, 1st movement
5. Beethoven — Symphony No. 5, Op. 67, 1st movement (opening)
6. Mozart — Eine kleine Nachtmusik, K. 525, 1st movement
7. Mozart — Rondo alla Turca, K. 331
8. Vivaldi — The Four Seasons, "Spring", 1st movement
9. Grieg — In the Hall of the Mountain King (Peer Gynt)
10. Offenbach — Infernal Galop ("Can-Can")
11. Chopin — Nocturne Op. 9 No. 2 (bonus)
12. Tchaikovsky — Dance of the Sugar Plum Fairy (bonus)
Melodies must be recognizably correct — verify intervals against the score by ear/theory,
not approximated. Include measured bass/accompaniment voices, not just the tune.

## 13. `ui/*`

```js
// hud.js
export class HUD {
  constructor(game, rootElement);
  show(); hide();
  update(dt);            // health/armor bars, money counter (animated), wanted stars,
                         // weapon + ammo, speedometer while driving, mission panel, radio banner
  minimap;               // canvas radar: rotating, roads + blips + player cone + waypoint
  notify(text, kind, duration);      // toast, kind: 'info'|'warn'|'money'|'mission'|'wanted'
  subtitle(text, duration);
  setMissionText(title, objective);
  flashDamage(amount); showWasted(); showBusted(); hideBigMessage();
  setWaypoint(x, z);
}

// menu.js
export class Menu {
  constructor(game, rootElement);
  showMain(); showPause(); showSettings(); showControls(); hide();
  isOpen; onStart; onResume; onQuit;
  settings;   // {quality, masterVolume, musicVolume, sfxVolume, sensitivity, invertY,
              //  fov, cameraShake, showFps, motionBlur, language}
  loadSettings(); saveSettings();   // localStorage key 'neoncity.settings'
}

// map.js
export class MapScreen {
  constructor(game, rootElement);
  toggle(); show(); hide(); isOpen;
  update();      // draws city map + player + missions + waypoints; click to set waypoint
}
```

## 14. `missions.js`

```js
export const MISSIONS = [ /* MissionDef */ ];
// MissionDef = { id, name, nameKo, brief, briefKo, giver, reward, wantedOnStart,
//                type:'delivery'|'race'|'assassinate'|'rampage'|'chase'|'survive'|'collect',
//                setup(game) -> state, update(game, state, dt) -> 'running'|'success'|'fail',
//                cleanup(game, state), objectiveText(state) }
export class MissionManager {
  constructor(game);
  active; completed; markers;
  update(dt);
  start(id); abort(); complete();
  getAvailable();     // yellow map markers the player walks into
}
```

## 15. `game.js` / `main.js` (integration — owned by the integrator)

```js
export class Game {
  constructor(canvas, dom);
  async init(onProgress);       // builds textures, world, entities, audio
  start(); pause(); resume();
  update(dt); render(dt);
  // Systems in fixed update order:
  //   input -> player/vehicle -> traffic -> peds -> police -> weapons -> missions ->
  //   collision resolve -> camera -> audio listener -> particles -> hud
  camera; cameraMode;  // 'thirdPerson'|'aim'|'vehicle'|'cinematic'|'map'
  player; vehicles; renderer; audio; music; sfx; hud; menu; city; collision; time;
}
```

**Camera requirements** (explicitly requested by the user — must feel excellent):
- Pointer-lock mouse look with configurable sensitivity, optional Y inversion, smoothed input.
- Third-person spring arm: shoulder offset, collision-aware boom that shortens against walls,
  slow auto-align behind the player when moving, fast when driving.
- Aim mode: over-the-shoulder, tighter FOV, reticle, reduced sensitivity.
- Vehicle camera: velocity-based lag, FOV kick with speed, look-back key, roll on drift.
- Screen shake for explosions/gunfire/collisions, all damped and frame-rate independent.
- Never clips into geometry; never gimbal-flips (pitch clamped to ±85°).

**Controls**
`WASD` move · `Shift` sprint · `Space` jump/handbrake · `Mouse` look · `LMB` fire · `RMB` aim ·
`R` reload · `1-5`/wheel weapons · `F` enter/exit vehicle · `E` interact · `Tab` map · `Esc` pause ·
`H` horn · `C` look back · `V` camera mode · `M` music next track · `N` next station · `P` photo mode.

---

## 16. The `game` runtime object (normative for every gameplay/UI module)

Every system receives the single `Game` instance and reads/writes only these documented members.
`game.js` is owned by the integrator; other modules must not add fields to it outside `game.ext`.

```js
game = {
  // --- core services ---
  canvas, gl, renderer, camera, input, collision, textures, city, world,
  audio,      // AudioEngine
  sfx,        // SFX
  music,      // MusicPlayer
  hud, menu, mapScreen,
  particles,  // shortcut to renderer.particles
  rng,        // Rand (gameplay-level, seeded)

  // --- clock ---
  time: { now, dt, scale, elapsed, frame, hours /* 0..24 */, daySpeed },
  paused, started, over,

  // --- player ---
  player: {
    character,            // Character
    position, velocity, yaw, pitch,
    health, maxHealth, armor, maxArmor, money, stamina,
    vehicle,              // Vehicle | null (null when on foot)
    aiming, sprinting, crouching, grounded, dead, invincible,
    weapon,               // key into WEAPONS
    kills, damageDealt, distanceTravelled,
    respawn(), damage(amount, dir3, source), heal(n), addMoney(n), addArmor(n),
    enterVehicle(vehicle, seat), exitVehicle(),
  },

  // --- world entities ---
  vehicles,   // Vehicle[] — every vehicle in the world (traffic, parked, police, player's)
  peds,       // PedManager
  traffic,    // TrafficManager
  police,     // PoliceSystem     (police.wanted is the 0..5 star level)
  weapons,    // WeaponSystem
  missions,   // MissionManager
  pickups,    // [{id, kind:'health'|'armor'|'ammo'|'money'|'weapon', x, y, z, value, taken}]

  // --- camera ---
  cameraMode,           // 'thirdPerson' | 'aim' | 'vehicle' | 'cinematic' | 'free'
  setCameraMode(mode),
  shakeCamera(amount, duration),

  // --- helpers every module may call ---
  notify(text, kind = 'info', duration = 3),   // -> hud toast
  subtitle(text, duration),
  setWaypoint(x, z) / clearWaypoint(),
  waypoint,                                    // {x, z} | null
  spawnVehicle(typeKey, x, z, yaw, opts) -> Vehicle,
  spawnPickup(kind, x, y, z, value) -> pickup,
  removeVehicle(vehicle),
  explosionAt(x, y, z, radius, damage, source),
  worldToGround(x, z) -> y,
  nearestRoadPoint(x, z, out) -> {x, z, laneId},
  distanceToPlayer(x, y, z) -> number,
  isNight() -> bool,
  save() / load(),                             // localStorage 'neoncity.save'
  ext: {},                                     // scratch namespace for modules that need one
}
```

### Event bus
```js
game.on(event, fn) -> unsubscribe;  game.emit(event, payload);
```
Events: `playerDamaged`, `playerDied`, `pedKilled`, `vehicleDestroyed`, `wantedChanged`,
`missionStarted`, `missionEnded`, `enteredVehicle`, `exitedVehicle`, `weaponFired`,
`moneyChanged`, `pickupCollected`, `explosion`, `trackChanged`, `settingsChanged`.

### DOM contract (index.html already provides these)
`#game-canvas`, `#hud-root`, `#menu-root`, `#map-root`, `#loading-screen`, `#load-fill`,
`#load-status`, `#load-tip`, `#fatal`, `#fatal-msg`.
UI modules build their own DOM inside their root; they must never touch another module's root.

### CSS contract
`css/game.css` is owned by the UI module. It must style the loading screen (`#loading-screen`,
`.load-inner`, `.load-logo`, `.load-sub`, `.load-bar`, `#load-fill`, `#load-status`, `.load-tip`),
the fatal panel (`#fatal`, `.fatal-inner`, `.fatal-hint`), `#app`, `#game-canvas`, `.layer`,
`.hidden`, plus everything the HUD/menu/map create. Art direction: dark neon-noir, `#05070d`
background, cyan `#00e5ff` + magenta `#ff2e88` + amber `#ffb648` accents, thin uppercase
letter-spaced labels, subtle scanline/vignette, all HUD text with a strong shadow so it stays
readable over bright scenes. Everything must scale sensibly from 1280x720 to 4K and degrade to a
compact layout under 820 px wide.
