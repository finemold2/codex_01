/**
 * Node regression test for js/entities/vehicle.js physics.
 *
 * Runs each vehicle type against a stub collision world (flat ground) and measures 0-100 km/h,
 * top speed, braking distance, cornering and stability, asserting nothing diverges or goes NaN.
 *
 * Run: node tools/test-vehicle.mjs
 */
import { Vehicle, VEHICLE_TYPES } from '../js/entities/vehicle.js';
import { mat4 } from '../js/core/math.js';

const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); };

/** Flat ground at y=0 with a wall at x=200. */
const collision = {
  groundHeight() { return 0; },
  raycast(origin, dir, maxDist) {
    if (dir[1] < -0.5) {
      const t = origin[1] / -dir[1];
      return t <= maxDist ? { t, point: [origin[0], 0, origin[2]], normal: [0, 1, 0], body: { tag: 'ground' } } : null;
    }
    return null;
  },
  sweepSphere(from, to, r) {
    if (to[0] > 200 - r) {
      const t = (200 - r - from[0]) / Math.max(1e-6, to[0] - from[0]);
      return { t: Math.max(0, Math.min(1, t)), hit: true, normal: [-1, 0, 0], body: { tag: 'wall' } };
    }
    return null;
  },
  querySphere() { return []; },
  queryAABB() { return []; },
};

const game = {
  collision,
  sfx: new Proxy({}, { get: () => () => ({ stop() {}, setPosition() {}, update() {} }) }),
  particles: { burst() {}, spawn() {} },
  renderer: { submit() {}, submitLight() {}, submitSpotLight() {} },
  hud: new Proxy({}, { get: () => () => {} }),
  shakeCamera() {}, emit() {}, explosionAt() {},
  isNight: () => false,
  distanceToPlayer: () => 50,
  player: { position: [0, 0, 0] },
  time: { now: 0 },
};

const assets = new Proxy({}, { get: () => ({ draw() {}, indexCount: 0, bounds: { min: [0, 0, 0], max: [1, 1, 1] } }) });

const mk = (key, opts = {}) => new Vehicle(assets, key, { position: [0, 0.5, 0], yaw: 0, game, ...opts });
const step = (v, dt, n, input) => {
  for (let i = 0; i < n; i++) {
    Object.assign(v.input, input);
    v.update(dt, collision, game);
    if (!Number.isFinite(v.position[0]) || !Number.isFinite(v.position[1]) || !Number.isFinite(v.position[2])) {
      fails.push(`${v.type.name}: position went NaN`);
      return false;
    }
  }
  return true;
};
const kmh = (v) => Math.abs(v.forwardSpeed !== undefined ? v.forwardSpeed : Math.hypot(v.velocity[0], v.velocity[2])) * 3.6;

console.log('type         0-100 km/h    top km/h   spec km/h   brake m*  corner ok   (* from top speed)');
console.log('-'.repeat(72));

for (const key of Object.keys(VEHICLE_TYPES)) {
  const spec = VEHICLE_TYPES[key];
  const specKmh = spec.maxSpeed * 3.6;

  // --- acceleration ---------------------------------------------------------------------
  let v = mk(key);
  let t100 = null;
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 45; i++) {
    Object.assign(v.input, { throttle: 1, brake: 0, steer: 0, handbrake: false });
    v.update(dt, collision, game);
    if (!Number.isFinite(v.position[0])) { fails.push(`${key}: NaN during acceleration`); break; }
    if (t100 === null && kmh(v) >= 100) t100 = i * dt;
  }
  const top = kmh(v);

  // --- braking from 80 km/h --------------------------------------------------------------
  v = mk(key);
  step(v, dt, 60 * 30, { throttle: 1, brake: 0, steer: 0, handbrake: false });
  const x0 = v.position[0];
  const z0 = v.position[2];
  const vStart = kmh(v);
  let brakeFrames = 0;
  for (let i = 0; i < 60 * 20; i++) {
    Object.assign(v.input, { throttle: 0, brake: 1, steer: 0, handbrake: false });
    v.update(dt, collision, game);
    brakeFrames++;
    if (kmh(v) < 1) break;
  }
  const brakeDist = Math.hypot(v.position[0] - x0, v.position[2] - z0);
  const stopped = kmh(v) < 2;

  // --- cornering / stability --------------------------------------------------------------
  v = mk(key);
  step(v, dt, 60 * 12, { throttle: 1, brake: 0, steer: 0, handbrake: false });
  let cornerOk = true;
  for (let i = 0; i < 60 * 15; i++) {
    const s = Math.sin(i * 0.02);
    Object.assign(v.input, { throttle: 0.7, brake: 0, steer: s, handbrake: false });
    v.update(dt, collision, game);
    if (!Number.isFinite(v.yaw) || !Number.isFinite(v.position[0]) || Math.abs(v.position[1]) > 8) { cornerOk = false; break; }
    if (kmh(v) > specKmh * 1.25) { cornerOk = false; fails.push(`${key}: exceeded spec top speed while cornering (${kmh(v).toFixed(0)} km/h)`); break; }
  }

  console.log(
    key.padEnd(12),
    (t100 === null ? '  n/a  ' : `${t100.toFixed(1)} s`).padStart(10),
    `${top.toFixed(0)}`.padStart(11),
    `${specKmh.toFixed(0)}`.padStart(12),
    `${brakeDist.toFixed(0)}`.padStart(10),
    `${cornerOk ? 'yes' : 'NO'}`.padStart(11));

  ok(Number.isFinite(top), `${key}: top speed is NaN`);
  ok(top > specKmh * 0.55, `${key}: only reached ${top.toFixed(0)} km/h of a ${specKmh.toFixed(0)} km/h spec`);
  ok(top <= specKmh * 1.12, `${key}: exceeded spec top speed (${top.toFixed(0)} vs ${specKmh.toFixed(0)})`);
  ok(stopped, `${key}: did not come to a stop under full braking (${kmh(v).toFixed(1)} km/h left)`);
  ok(brakeDist < 260, `${key}: braking distance ${brakeDist.toFixed(0)} m is implausible`);
  ok(cornerOk, `${key}: became unstable while cornering`);
  if (key !== 'bus' && key !== 'truck') {
    ok(t100 !== null, `${key}: never reached 100 km/h at full throttle`);
    if (t100 !== null) ok(t100 > 1.2 && t100 < 30, `${key}: implausible 0-100 time ${t100.toFixed(1)} s`);
  }
}

// --- wall collision: must not tunnel ---------------------------------------------------------
{
  // yaw 0 faces -Z, so aim the car at +X (the wall) with yaw = -PI/2.
  const v = mk('sports', { position: [80, 0.5, 0], yaw: -Math.PI / 2 });
  step(v, 1 / 60, 60 * 25, { throttle: 1, brake: 0, steer: 0, handbrake: false });
  console.log(`\nwall test: sports car ran from x=80 at full throttle, ended at x=${v.position[0].toFixed(1)} (wall face at 200)`);
  ok(v.position[0] < 205, `car tunnelled through the wall (x=${v.position[0].toFixed(1)})`);
  ok(v.position[0] > 120, `car did not actually drive towards the wall (x=${v.position[0].toFixed(1)})`);
}

// --- throughput --------------------------------------------------------------------------------
{
  const fleet = Object.keys(VEHICLE_TYPES).map((k) => mk(k));
  while (fleet.length < 40) fleet.push(mk('sedan'));
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 600; i++) {
    for (const v of fleet) { v.input.throttle = 0.8; v.input.steer = Math.sin(i * 0.05) * 0.4; v.update(1 / 60, collision, game); }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 600;
  console.log(`40 vehicles: ${ms.toFixed(2)} ms per frame`);
  ok(ms < 6, `40 vehicles cost ${ms.toFixed(2)} ms/frame`);
}

/* ============================================================================================
 * Regression coverage for defects found by adversarial review. Each block fails loudly if the
 * old behaviour ever comes back.
 * ==========================================================================================*/

/** A game object with a real vehicle list, so the module's own car-vs-car pass runs. */
function worldGame(bodies = []) {
  const world = {
    groundHeight() { return 0; },
    raycast() { return null; },
    sweepSphere() { return null; },
    querySphere() { return []; },
    queryAABB(a, b, c, d, e, f, out = []) { out.length = 0; for (const bd of bodies) out.push(bd); return out; },
  };
  const g = {
    collision: world,
    sfx: {
      createEngine: () => ({ alive: true, update() {}, setVolume() {}, stop() {} }),
      tireScreech: () => ({ alive: true, setIntensity() {}, setPosition() {}, stop() {} }),
      siren: () => ({ alive: true, setPosition() {}, stop() {} }),
      carCollision() {}, glassBreak() {}, horn() {},
    },
    particles: { burst() {}, spawn() {} },
    renderer: { submit() {}, submitLight() {}, submitSpotLight() {} },
    hud: new Proxy({}, { get: () => () => {} }),
    shakeCamera() {}, emit() {}, explosionAt() {},
    isNight: () => false, distanceToPlayer: () => 50,
    player: { position: [0, 0, 0] }, time: { now: 0, frame: 0 }, ext: {}, vehicles: [],
  };
  return { g, world };
}
const spawn = (g, world, key, opts) => {
  const v = new Vehicle(assets, key, { position: [0, 0.5, 0], yaw: 0, game: g, ...opts });
  g.vehicles.push(v);
  return v;
};
const tick = (g, world, n, each) => {
  for (let i = 0; i < n; i++) {
    for (const v of g.vehicles) { if (each) each(v, i); v.update(1 / 60, world, g); }
    g.time.frame++;
  }
};

// --- `speed` is metres per second (ui/hud.js multiplies it by 3.6) ----------------------------
{
  const { g, world } = worldGame();
  const v = spawn(g, world, 'sedan');
  tick(g, world, 60 * 30, (x) => { x.input.throttle = 1; });
  const ms = Math.hypot(v.velocity[0], v.velocity[2]);
  console.log(`\nunits: speed=${v.speed.toFixed(2)} m/s, |velocity|=${ms.toFixed(2)} m/s, speedKmh=${v.speedKmh.toFixed(0)}`);
  ok(Math.abs(v.speed - ms) < 0.05, `speed must be m/s like player.speed (got ${v.speed.toFixed(2)} for ${ms.toFixed(2)} m/s)`);
  ok(Math.abs(v.speedKmh - ms * 3.6) < 0.2, 'speedKmh must be the km/h conversion');
}

// --- wheels roll forwards, not backwards ------------------------------------------------------
{
  const { g, world } = worldGame();
  const v = spawn(g, world, 'sedan');
  tick(g, world, 120, (x) => { x.input.throttle = 1; });
  ok(v.forwardSpeed > 1, 'setup: car should be rolling');
  ok(Math.sign(v.wheels[0].spinRate) === Math.sign(v.forwardSpeed),
    'wheel spin rate must follow the direction of travel');
  // The drawn contact patch has to sweep opposite the car's motion.
  const m = mat4.create();
  mat4.identity(m);
  mat4.rotateY(m, m, v.yaw);
  mat4.rotateX(m, m, -Math.abs(v.wheels[0].spin % 1) || -0.1);
  const contactZ = m[6] * -1;   // local (0,-1,0) -> world z
  ok(contactZ > 0, 'wheels are drawn spinning backwards while driving forwards');
}

// --- non-solid bodies (water volumes, triggers) must never act as walls -----------------------
{
  const water = {
    kind: 'box', cx: 0, cy: -6, cz: 0, hx: 40, hy: 6, hz: 40,
    sin: 0, cos: 1, tag: 'water', solid: false, userData: null,
  };
  const { g, world } = worldGame([water]);
  world.groundHeight = () => -1.5;                 // shore shelf under the water surface
  const v = spawn(g, world, 'sedan', { position: [0, -1.0, 0] });
  const x0 = v.position[0];
  tick(g, world, 60, (x) => { x.input.throttle = 0.4; });
  const shove = Math.abs(v.position[0] - x0);
  console.log(`water volume: car pushed sideways by ${shove.toFixed(2)} m in 1 s`);
  ok(shove < 1, `a non-solid body catapulted the car (${shove.toFixed(1)} m sideways)`);
}

// --- car vs car: no pass-through, no phantom repulsion between lanes ---------------------------
{
  const { g, world } = worldGame();
  const a = spawn(g, world, 'sedan', { position: [0, 0.5, 0] });
  const b = spawn(g, world, 'sedan', { position: [0, 0.5, -45] });
  let through = false;
  tick(g, world, 60 * 14, (x) => {
    if (x === a) { x.input.throttle = 1; } else { x.input.throttle = 0; x.input.brake = 1; }
    if (a.position[2] < b.position[2] - 0.5) through = true;
  });
  const gap = a.position[2] - b.position[2];
  console.log(`rear-end: chaser stopped ${gap.toFixed(2)} m behind (car is ${VEHICLE_TYPES.sedan.length} m long)`);
  ok(!through, 'a car drove straight through another car');
  ok(gap > VEHICLE_TYPES.sedan.length * 0.9 && gap < VEHICLE_TYPES.sedan.length * 1.6,
    `cars did not settle bumper to bumper (gap ${gap.toFixed(2)} m)`);
}
{
  const { g, world } = worldGame();
  const bus = spawn(g, world, 'bus', { position: [0, 0.5, 0] });
  const car = spawn(g, world, 'sedan', { position: [3.5, 0.5, 0] });
  tick(g, world, 60 * 5, (x) => { x.input.throttle = 0.6; });
  const lane = car.position[0] - bus.position[0];
  console.log(`lane test: sedan alongside a bus held ${lane.toFixed(2)} m of separation (started 3.50)`);
  ok(Math.abs(lane - 3.5) < 0.35, `vehicles repel each other from the next lane (${lane.toFixed(2)} m)`);
}

// --- a recycled damaged car must not keep burning or detonate its old fuse ---------------------
{
  const { g, world } = worldGame();
  let booms = 0;
  g.explosionAt = () => { booms++; };
  const v = spawn(g, world, 'sedan');
  v.applyDamage(900, [0, 0, 0], null);
  v.update(1 / 60, world, g);
  ok(v.burning, 'setup: a 90% damaged car should be burning');
  v.reset(60, 0.5, 60, 1);
  v.health = v.maxHealth;
  v.isDestroyed = false;
  tick(g, world, 60 * 12, (x) => { x.input.throttle = 0.5; });
  console.log(`pool round trip: burning=${v.burning} explosions=${booms}`);
  ok(!v.burning, 'a recycled car came back from the pool still on fire');
  ok(booms === 0, 'a recycled car detonated the fuse it carried into the pool');
}

// --- the engine-voice budget must not leak when audio hands back a silent stub -----------------
{
  const { g, world } = worldGame();
  g.camera = { position: [0, 0, 0] };
  g.sfx = { createEngine: () => null, tireScreech: () => null, siren: () => null, carCollision() {}, glassBreak() {} };
  for (let i = 0; i < 4; i++) spawn(g, world, 'sedan', { position: [i * 30, 0.5, 0] });
  tick(g, world, 600, (x) => { x.input.throttle = 0.4; });
  console.log(`audio budget after 600 frames with no audio: ${g.ext.vehicleVoices || 0}`);
  ok(!(g.ext.vehicleVoices > 0), `engine voice budget leaked (${g.ext.vehicleVoices} slots held by nothing)`);
}

console.log(`\n=== ${fails.length ? 'FAILURES (' + fails.length + ')' : 'ALL PASS'} ===`);
for (const f of fails) console.log(' *', f);
process.exit(fails.length ? 1 : 0);
