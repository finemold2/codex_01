/**
 * Node regression test for js/entities/player.js (the on-foot controller).
 *
 * Runs the controller against stub collision/input/game objects and asserts the movement feel:
 * walk/run/sprint speeds, jump arc and air time, wall collision, aim strafing, vehicle entry and
 * exit, armour absorption, death and respawn, plus a randomised-input NaN sweep.
 *
 * Run: node tools/test-player.mjs
 */
import { Player } from '../js/entities/player.js';

const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); };

// ---- stubs -------------------------------------------------------------------------------
const keys = new Set();
const input = {
  blocked: false, sensitivity: 1, invertY: false,
  axis(n) {
    if (n === 'moveX') return (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0);
    if (n === 'moveY') return (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0);
    return 0;
  },
  isDown(a) { return keys.has(a); },
  justPressed(a) { return keys.has('press:' + a); },
  requestPointerLock() {}, exitPointerLock() {},
};

// Flat ground at y=0 with a wall at x >= 6, and a 0.3 m kerb at z >= 5.
const collision = {
  moveCapsule(pos, r, h, delta, out) {
    let x = pos[0] + delta[0];
    let y = pos[1] + delta[1];
    let z = pos[2] + delta[2];
    let hits = 0;
    if (x + r > 6) { x = 6 - r; hits++; }
    const groundY = z > 5 ? 0.3 : 0;
    let grounded = false;
    if (y <= groundY) { y = groundY; grounded = true; }
    out.x = x; out.y = y; out.z = z;
    out.grounded = grounded; out.groundY = groundY;
    out.normal[0] = 0; out.normal[1] = 1; out.normal[2] = 0;
    out.hits = hits;
    return out;
  },
  groundHeight(x, z) { return z > 5 ? 0.3 : 0; },
  raycast() { return null; },
};

const events = [];
const game = {
  input, collision,
  camera: { yaw: 0, pitch: 0 },
  waterLevel: null,
  time: { now: 0 },
  weapons: { canAim: () => true },
  sfx: new Proxy({}, { get: () => () => {} }),
  peds: { alertNoise() {}, alertGunshot() {} },
  police: { reportCrime() {}, addWanted() {}, clearWanted() {} },
  hud: new Proxy({}, { get: () => () => {} }),
  particles: { burst() {} },
  vehicles: [],
  surfaceAt: () => 'concrete',
  worldToGround: (x, z) => (z > 5 ? 0.3 : 0),
  shakeCamera() {}, setCameraMode(m) { events.push('cam:' + m); },
  emit(e) { events.push(e); },
  respawnPlayer() { events.push('respawn'); player.reset(0, 0, 0, 0); },
  ejectDriver() {},
};

const character = {
  position: [0, 0, 0], yaw: 0, state: 'idle',
  setState(s) { this.state = s; }, update() {}, submit() {}, playRagdoll() {},
};

const player = new Player(game, character);
game.player = player;
player.reset(0, 0, 0, 0);

const step = (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) { player.update(dt); keys.forEach((k) => { if (k.startsWith('press:')) keys.delete(k); }); } };

// ---- 1. walking -------------------------------------------------------------------------
keys.add('w');
step(120);
const dz = player.position[2];
console.log(`walk 2s: z=${dz.toFixed(2)} speed=${player.speed.toFixed(2)} state=${character.state}`);
ok(dz < -6, `forward (yaw 0 = -Z) should move ~-10 m in 2 s, got ${dz.toFixed(2)}`);
ok(player.speed > 4.5 && player.speed < 6, `run speed should be ~5.2 m/s, got ${player.speed.toFixed(2)}`);
ok(character.state === 'run', `expected state run, got ${character.state}`);

// ---- 2. sprint ----------------------------------------------------------------------------
keys.add('sprint');
step(90);
console.log(`sprint: speed=${player.speed.toFixed(2)} stamina=${player.stamina.toFixed(0)} state=${character.state}`);
ok(player.speed > 7.5, `sprint should exceed 7.5 m/s, got ${player.speed.toFixed(2)}`);
ok(player.stamina < 100, 'sprinting should drain stamina');
keys.delete('sprint');

// ---- 3. stopping ---------------------------------------------------------------------------
keys.delete('w');
step(60);
console.log(`stop: speed=${player.speed.toFixed(3)} state=${character.state}`);
ok(player.speed < 0.2, `should come to rest, speed=${player.speed.toFixed(3)}`);
ok(character.state === 'idle', `expected idle, got ${character.state}`);

// ---- 4. jump --------------------------------------------------------------------------------
player.reset(0, 0, 0, 0);
keys.add('press:jump'); keys.add('jump');
player.update(1 / 60);
keys.delete('press:jump');
const vy0 = player.velocity[1];
let peak = 0;
let airFrames = 0;
for (let i = 0; i < 90; i++) {
  player.update(1 / 60);
  peak = Math.max(peak, player.position[1]);
  if (!player.grounded) airFrames++;
}
keys.delete('jump');
console.log(`  airborne for ${airFrames} frames (${(airFrames / 60).toFixed(2)} s)`);
ok(airFrames > 20 && airFrames < 60, `air time should be ~0.6 s, got ${(airFrames / 60).toFixed(2)} s`);
console.log(`jump: v0=${vy0.toFixed(2)} peak=${peak.toFixed(2)} grounded=${player.grounded}`);
ok(vy0 > 6, `jump velocity too low: ${vy0.toFixed(2)}`);
ok(peak > 0.9 && peak < 2.0, `jump height should be ~1.2 m, got ${peak.toFixed(2)}`);
ok(player.grounded, 'should have landed again after 1.5 s');

// ---- 5. wall ---------------------------------------------------------------------------------
player.reset(0, 0, 0, 0);
game.camera.yaw = -Math.PI / 2;  // face +X
keys.add('w');
step(180);
console.log(`wall: x=${player.position[2] !== undefined ? player.position[0].toFixed(3) : '?'} (limit 5.64)`);
ok(player.position[0] <= 5.6401, `walked through the wall: x=${player.position[0]}`);
ok(player.position[0] > 5.5, `should be pressed against the wall, x=${player.position[0].toFixed(3)}`);
ok(Number.isFinite(player.position[0]), 'position went NaN against a wall');
keys.delete('w');
game.camera.yaw = 0;

// ---- 6. fall damage ----------------------------------------------------------------------------
player.reset(0, 40, 0, 0);
player.health = 100;
step(240);
console.log(`fall from 40 m: health=${player.health.toFixed(0)} dead=${player.dead}`);
ok(player.health < 100, 'falling 40 m should hurt');

// ---- 7. aim slows movement ----------------------------------------------------------------------
player.reset(0, 0, 0, 0);
keys.add('w'); keys.add('aim');
step(90);
console.log(`aim walk: speed=${player.speed.toFixed(2)} state=${character.state} yaw=${player.yaw.toFixed(2)}`);
ok(player.speed < 2.6, `aim speed should be ~2 m/s, got ${player.speed.toFixed(2)}`);
ok(Math.abs(player.yaw - game.camera.yaw) < 0.05, 'body should face the camera while aiming');
keys.delete('aim'); keys.delete('w');

// ---- 8. vehicles -------------------------------------------------------------------------------
const vehicle = {
  position: [1.5, 0.5, 0], velocity: [0, 0, 0], yaw: 0.4, steer: 0, health: 1000,
  isDestroyed: false, driver: null, isPlayer: false, engineOn: false, forwardSpeed: 0,
  input: { throttle: 0, brake: 0, steer: 0, handbrake: false, horn: false },
  type: { key: 'sedan', nameKo: '세단', width: 1.9, length: 4.4, height: 1.45 },
  getSeatPosition(i, out) { out[0] = this.position[0]; out[1] = this.position[1] + 0.7; out[2] = this.position[2]; return out; },
};
game.vehicles.push(vehicle);
player.reset(0, 0, 0, 0);
keys.add('press:enterVehicle');
player.update(1 / 60);
console.log(`enter: vehicle=${!!player.vehicle} driver=${vehicle.driver === player} events=${events.join(',')}`);
ok(player.vehicle === vehicle, 'player did not enter the nearby vehicle');
ok(vehicle.driver === player, 'vehicle.driver was not set');
step(30);
ok(Math.abs(player.position[1] - 1.2) < 0.01, `player should ride at the seat height, y=${player.position[1]}`);
player.exitVehicle();
console.log(`exit: vehicle=${player.vehicle} pos=${player.position.map((v) => v.toFixed(2)).join(',')}`);
ok(player.vehicle === null, 'exitVehicle did not clear the vehicle');
ok(vehicle.driver === null, 'exitVehicle did not clear the driver');
ok(Number.isFinite(player.position[0]) && Number.isFinite(player.position[2]), 'exit position is NaN');

// ---- 9. damage / death / respawn -----------------------------------------------------------------
player.reset(0, 0, 0, 0);
player.armor = 50;
player.damage(40, [0, 0, 1], 'bullet');
console.log(`armored hit: hp=${player.health.toFixed(1)} armor=${player.armor.toFixed(1)}`);
ok(player.armor < 50 && player.health > 60, 'armor should absorb most of the damage');
player.damage(500, [0, 0, 1], 'bullet');
ok(player.dead, 'player should die at 0 health');
step(240);
ok(events.includes('respawn'), 'player never respawned after dying');

// ---- 10. no NaN under random input ------------------------------------------------------------------
player.reset(0, 0, 0, 0);
const pool = ['w', 'a', 's', 'd', 'sprint', 'jump', 'aim', 'crouch'];
for (let i = 0; i < 6000; i++) {
  if (i % 7 === 0) { keys.clear(); const k = pool[(Math.random() * pool.length) | 0]; keys.add(k); if (k === 'jump') keys.add('press:jump'); }
  game.camera.yaw += (Math.random() - 0.5) * 0.3;
  player.update(1 / 60 + Math.random() * 0.02);
  if (!player.position.every(Number.isFinite) || !player.velocity.every(Number.isFinite)) { fails.push(`NaN at random-input step ${i}`); break; }
}
console.log(`random input 6000 steps: pos=${player.position.map((v) => v.toFixed(1)).join(',')} ok`);

console.log(`\n=== ${fails.length ? 'FAILURES' : 'ALL PASS'} ===`);
for (const f of fails) console.log(' *', f);
process.exit(fails.length ? 1 : 0);
