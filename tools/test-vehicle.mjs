/**
 * Node regression test for js/entities/vehicle.js physics.
 *
 * Runs each vehicle type against a stub collision world (flat ground) and measures 0-100 km/h,
 * top speed, braking distance, cornering and stability, asserting nothing diverges or goes NaN.
 *
 * Run: node tools/test-vehicle.mjs
 */
import { Vehicle, VEHICLE_TYPES } from '../js/entities/vehicle.js';

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

console.log(`\n=== ${fails.length ? 'FAILURES (' + fails.length + ')' : 'ALL PASS'} ===`);
for (const f of fails) console.log(' *', f);
process.exit(fails.length ? 1 : 0);
