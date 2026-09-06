/**
 * NEON CITY — headless regression tests for `js/missions.js` and `js/entities/weapons.js`.
 *
 * Builds a fake `Game` that exposes exactly the members contract section 16 documents (plus the
 * stubs the ped / police / traffic systems will provide) and drives every mission through its
 * whole life cycle: start -> success, start -> fail, start -> abort, start -> player death.
 *
 * It checks the things a browser would only show as "the game feels broken":
 *   - contract shape (exports, MissionDef fields, WeaponSystem API)
 *   - entity leaks after cleanup (vehicles, peds, markers, waypoints, HUD text)
 *   - NaN in any published number
 *   - determinism (same seed -> same layout, no Math.random)
 *   - per-frame HUD churn (a mission panel that rewrites the DOM every frame)
 *   - the weapon ballistics: ammo, reload, falloff, self-hits, tracer origin, hit attribution
 *
 * Run: node tools/test-missions.mjs
 */
import { Rand } from '../js/core/math.js';
import { MISSIONS, MissionManager } from '../js/missions.js';
import { WEAPONS, WeaponSystem, damageFalloff } from '../js/entities/weapons.js';

/* ------------------------------------------------------------------ *
 * Tiny test harness
 * ------------------------------------------------------------------ */

let passed = 0;
const failures = [];
let group = '';

/**
 * @param {string} name Group label.
 * @returns {void}
 */
function section(name) {
  group = name;
  console.log(`\n── ${name}`);
}

/**
 * @param {boolean} cond Condition that must hold.
 * @param {string} msg Description.
 * @returns {boolean} `cond`
 */
function ok(cond, msg) {
  if (cond) {
    passed++;
  } else {
    fail(`${group}: ${msg}`);
    console.log(`  FAIL  ${msg}`);
  }
  return !!cond;
}

/**
 * Records a failure once, however many times it is hit.
 * @param {string} msg Description.
 * @returns {void}
 */
function fail(msg) {
  if (!failures.includes(msg)) failures.push(msg);
}

/**
 * @param {*} a Actual.
 * @param {*} b Expected.
 * @param {string} msg Description.
 * @returns {boolean} True when equal.
 */
function eq(a, b, msg) {
  return ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

/**
 * Recursively asserts that a value tree holds no NaN / Infinity.
 * @param {*} v Value.
 * @param {string} path Debug path.
 * @param {Set<*>} seen Cycle guard.
 * @returns {string[]} Offending paths.
 */
function findNaN(v, path = '', seen = new Set()) {
  const out = [];
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) out.push(`${path}=${v}`);
    return out;
  }
  if (!v || typeof v !== 'object' || seen.has(v)) return out;
  if (v instanceof Set || v instanceof Map) return out;
  seen.add(v);
  const keys = Array.isArray(v) ? v.keys() : Object.keys(v);
  for (const k of keys) {
    // Waypoint sentinels are deliberately NaN until the mission publishes one.
    if (k === 'waypointX' || k === 'waypointZ') continue;
    out.push(...findNaN(v[k], `${path}.${k}`, seen));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Fake world
 * ------------------------------------------------------------------ */

/** Documented `sfx.uiClick` kinds. */
const UI_KINDS = ['click', 'select', 'hover', 'confirm', 'back', 'close', 'open', 'toggle', 'error', 'tick'];
/** Documented `sfx.notify` kinds. */
const NOTIFY_KINDS = ['info', 'warn', 'money', 'mission', 'wanted'];
/** Documented `sfx.pickup` kinds. */
const PICKUP_KINDS = ['health', 'armor', 'money', 'ammo', 'weapon'];
/** Documented `sfx.bulletImpact` surfaces. */
const IMPACT_KINDS = ['concrete', 'metal', 'glass', 'flesh', 'wood', 'dirt', 'water'];
/** Documented `hud.notify` kinds. */
const TOAST_KINDS = ['info', 'warn', 'money', 'mission', 'wanted'];
/** Documented `hud.hitMarker` kinds. */
const HIT_KINDS = ['hit', 'kill', 'headshot'];
/** Particle preset names `render/particles.js` implements. */
const PARTICLE_KINDS = ['smoke', 'dust', 'tireSmoke', 'exhaust', 'skid', 'fire', 'explosion', 'spark',
  'ember', 'flash', 'muzzle', 'ring', 'impact', 'blood', 'debris', 'glass', 'shell', 'leaf', 'rain', 'splash'];

/** A stand-in for `entities/vehicle.js` with the documented surface and a trivial arcade step. */
class FakeVehicle {
  /**
   * @param {string} key Type key.
   * @param {number} x Spawn x.
   * @param {number} y Spawn y.
   * @param {number} z Spawn z.
   * @param {number} yaw Facing.
   * @param {Object} opts Spawn options.
   */
  constructor(key, x, y, z, yaw, opts) {
    this.type = { key, nameKo: key, width: 1.9, length: 4.4, height: 1.45 };
    this.position = [x, y, z];
    this.velocity = [0, 0, 0];
    this.yaw = yaw;
    this.speed = 0;
    this.forwardSpeed = 0;
    this.health = 1000;
    this.maxHealth = 1000;
    this.isDestroyed = false;
    this.engineOn = true;
    this.visible = true;
    this.driver = null;
    this.occupants = [];
    this.isPolice = !!(opts && opts.isPolice);
    this.input = { throttle: 0, brake: 0, steer: 0, handbrake: false, horn: false };
    this.lights = { head: false, brake: false, reverse: false, siren: false };
    this.damageTaken = 0;
  }

  /**
   * @param {number} dt Seconds.
   * @returns {void}
   */
  update(dt) {
    if (this.isDestroyed) return;
    const i = this.input;
    if (i.handbrake) {
      this.speed *= 0.2;
    } else {
      this.speed += (i.throttle * 14 - i.brake * 22 - this.speed * 0.5) * dt;
    }
    if (this.speed < -8) this.speed = -8;
    if (this.speed > 60) this.speed = 60;
    this.yaw += i.steer * dt * 1.9 * Math.min(1, Math.abs(this.speed) / 6);
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    this.position[0] += fx * this.speed * dt;
    this.position[2] += fz * this.speed * dt;
    this.velocity[0] = fx * this.speed;
    this.velocity[2] = fz * this.speed;
    this.forwardSpeed = this.speed;
  }

  /**
   * @param {number} n Damage.
   * @returns {void}
   */
  applyDamage(n) {
    this.damageTaken += n;
    this.health = Math.max(0, this.health - n);
    if (this.health <= 0) this.isDestroyed = true;
  }

  /**
   * @param {boolean} head Headlights.
   * @param {boolean} brake Brake lights.
   * @param {boolean} rev Reverse lights.
   * @param {boolean} siren Siren.
   * @returns {void}
   */
  setLights(head, brake, rev, siren) {
    this.lights.head = head; this.lights.brake = brake;
    this.lights.reverse = rev; this.lights.siren = siren;
  }

  /** @returns {void} */
  dispose() { this.disposed = true; }
}

/** A minimal ped record shaped like the one `PedManager` publishes. */
class FakePed {
  /**
   * @param {number} x World x.
   * @param {number} y World y.
   * @param {number} z World z.
   */
  constructor(x, y, z) {
    this.position = [x, y, z];
    this.character = { position: [x, y, z], yaw: 0, setState() {} };
    this.state = 'idle';
    this.health = 100;
    this.maxHealth = 100;
    this.yaw = 0;
    this.dead = false;
  }
}

/**
 * Builds the fake game.
 * @param {Object} [opts] `{police:boolean, wall:boolean}`.
 * @returns {Object} Fake game.
 */
function makeGame(opts = {}) {
  const calls = {
    notify: [], subtitle: [], missionText: [], toast: [], hit: [], sfx: [], particles: [],
    lights: 0, meshes: 0, showMissionResult: [], waypoints: [], warns: [],
  };
  const listeners = new Map();
  const game = {
    calls,
    rng: new Rand(1337),
    city: {
      bounds: { min: [-500, -500], max: [500, 500] },
      spawns: {
        missionPoints: MISSIONS.map((m, i) => ({ x: i * 120 - 420, y: 0, z: 20, name: `지점${i}` })),
      },
    },
    time: { now: 0, dt: 1 / 60, scale: 1, elapsed: 0, frame: 0, hours: 12, daySpeed: 0 },
    paused: false,
    started: true,
    over: false,
    vehicles: [],
    pickups: [],
    waypoint: null,
    cameraMode: 'thirdPerson',
    ext: {},
    camera: { position: [0, 1.7, 0], forward: [0, 0, -1], yaw: 0, pitch: 0 },
    input: {
      blocked: false,
      justPressed() { return false; },
      isDown() { return false; },
      consumeWheel() { return 0; },
    },
  };

  game.player = {
    character: {
      position: [0, 0, 0],
      setState() {},
      getMuzzleOrigin(out) { out[0] = 0; out[1] = 1.4; out[2] = -0.4; return out; },
    },
    position: [0, 0, 20],
    velocity: [0, 0, 0],
    yaw: 0,
    pitch: 0,
    health: 100,
    maxHealth: 100,
    armor: 0,
    maxArmor: 100,
    money: 0,
    stamina: 1,
    vehicle: null,
    aiming: false,
    sprinting: false,
    crouching: false,
    grounded: true,
    dead: false,
    invincible: false,
    weapon: 'pistol',
    kills: 0,
    damageDealt: 0,
    distanceTravelled: 0,
    damageTaken: 0,
    respawn() {},
    damage(n) { this.damageTaken += n; this.health = Math.max(0, this.health - n); },
    heal(n) { this.health = Math.min(this.maxHealth, this.health + n); },
    addMoney(n) { this.money += n; },
    addArmor(n) { this.armor = Math.min(this.maxArmor, this.armor + n); },
    enterVehicle(v) { this.vehicle = v; v.driver = this; },
    exitVehicle() { if (this.vehicle) this.vehicle.driver = null; this.vehicle = null; },
  };

  game.police = opts.police === false ? null : {
    wanted: 0,
    cops: [],
    cars: [],
    searchTimer: 0,
    heatMeterVisible: false,
    addWanted(n) { this.wanted = Math.max(0, Math.min(5, this.wanted + n)); },
    clearWanted() { this.wanted = 0; },
    reportCrime() { this.addWanted(1); },
    update() {},
  };

  game.peds = {
    peds: [],
    spawnAround(pos, count) {
      for (let i = 0; i < count; i++) this.peds.push(new FakePed(pos[0], pos[1], pos[2]));
    },
    update() {},
    alertGunshot() {},
    damagePed(ped, amount, dir, headshot) {
      ped.health -= amount;
      if (ped.health <= 0 && !ped.dead) {
        ped.dead = true;
        ped.state = 'dead';
        game.player.kills++;
        game.emit('pedKilled', { ped, x: ped.position[0], y: ped.position[1], z: ped.position[2], byPlayer: true, headshot });
      }
    },
    raycastPeds(origin, dir, maxDist) {
      // Vertical capsule, exactly like the real ped manager will do it.
      let best = null;
      for (const p of this.peds) {
        if (p.dead) continue;
        const mx = origin[0] - p.position[0];
        const mz = origin[2] - p.position[2];
        const a = dir[0] * dir[0] + dir[2] * dir[2];
        if (a < 1e-8) continue;
        const b = 2 * (mx * dir[0] + mz * dir[2]);
        const c = mx * mx + mz * mz - 0.45 * 0.45;
        const disc = b * b - 4 * a * c;
        if (disc < 0) continue;
        const sq = Math.sqrt(disc);
        let t = (-b - sq) / (2 * a);
        if (t < 0) t = (-b + sq) / (2 * a);
        if (t < 0.05 || t > maxDist) continue;
        const y = origin[1] + dir[1] * t;
        if (y < p.position[1] || y > p.position[1] + 1.85) continue;
        if (!best || t < best.t) {
          best = {
            ped: p, t, point: [origin[0] + dir[0] * t, y, origin[2] + dir[2] * t],
            headshot: y - p.position[1] > 1.5,
          };
        }
      }
      return best;
    },
  };

  game.traffic = { vehicles: [], update() {}, spawnAround() {}, despawnFar() {}, alert() {} };

  game.collision = {
    // Flat ground at y=0 plus one wall at z = -40 when requested.
    raycast(origin, dir, maxDist) {
      let best = null;
      if (dir[1] < -1e-6) {
        const t = -origin[1] / dir[1];
        if (t > 0 && t < maxDist) best = { t, point: [origin[0] + dir[0] * t, 0, origin[2] + dir[2] * t], normal: [0, 1, 0], body: { tag: 'terrain' } };
      }
      if (opts.wall && Math.abs(dir[2]) > 1e-6) {
        const t = (-40 - origin[2]) / dir[2];
        if (t > 0 && t < maxDist && (!best || t < best.t)) {
          best = { t, point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, -40], normal: [0, 0, 1], body: { tag: 'static', userData: {} } };
        }
      }
      return best;
    },
    sweepSphere(from, to) {
      if (to[1] > 0.2) return null;
      const dy = to[1] - from[1];
      if (Math.abs(dy) < 1e-9) return null;
      const t = Math.max(0, Math.min(1, (0.2 - from[1]) / dy));
      return { t, hit: [from[0] + (to[0] - from[0]) * t, 0.2, from[2] + (to[2] - from[2]) * t], normal: [0, 1, 0], body: null };
    },
    querySphere() { return []; },
    groundHeight() { return 0; },
  };

  game.renderer = {
    createMesh() { calls.meshes++; return { indexCount: 36, triangleCount: 12, boundsCenter: [0, 0, 0], boundsRadius: 2 }; },
    createMaterial(desc) { return { ...desc, isMaterial: true }; },
    submit(mesh, material, matrix) {
      calls.particles.push('submit');
      if (!mesh) fail('renderer.submit called with no mesh');
      if (!material) fail('renderer.submit called with a null material');
      for (let i = 0; i < 16; i++) {
        if (!Number.isFinite(matrix[i])) fail(`renderer.submit matrix[${i}] is not finite`);
      }
    },
    submitLight(x, y, z, r, g, b, radius, intensity) {
      calls.lights++;
      if (![x, y, z, r, g, b, radius, intensity].every(Number.isFinite)) {
        fail('renderer.submitLight got a non-finite argument');
      }
    },
  };

  game.particles = {
    burst(kind, x, y, z, count) {
      calls.particles.push(kind);
      if (!PARTICLE_KINDS.includes(kind)) fail(`particles.burst got unknown preset '${kind}'`);
      if (![x, y, z, count].every(Number.isFinite)) fail(`particles.burst('${kind}') got a non-finite argument`);
    },
    spawn(o) {
      calls.particles.push('spawn');
      if (!Number.isFinite(o.x) || !Number.isFinite(o.y) || !Number.isFinite(o.z)) {
        fail('particles.spawn got a non-finite position');
      }
    },
  };

  game.sfx = {
    ready: true,
    uiClick(kind) { calls.sfx.push(`uiClick:${kind}`); if (!UI_KINDS.includes(kind)) fail(`sfx.uiClick got unknown kind '${kind}'`); },
    notify(kind) { calls.sfx.push(`notify:${kind}`); if (!NOTIFY_KINDS.includes(kind)) fail(`sfx.notify got unknown kind '${kind}'`); },
    pickup(kind) { calls.sfx.push(`pickup:${kind}`); if (!PICKUP_KINDS.includes(kind)) fail(`sfx.pickup got unknown kind '${kind}'`); },
    bulletImpact(surface) { calls.sfx.push(`impact:${surface}`); if (!IMPACT_KINDS.includes(surface)) fail(`sfx.bulletImpact got unknown surface '${surface}'`); },
    gunshot(kind) { calls.sfx.push(`gunshot:${kind}`); },
    reload(kind) { calls.sfx.push(`reload:${kind}`); },
    ricochet() { calls.sfx.push('ricochet'); },
    glassBreak() { calls.sfx.push('glassBreak'); },
    punch() { calls.sfx.push('punch'); },
    explosion() { calls.sfx.push('explosion'); },
    wanted(n) { calls.sfx.push(`wanted:${n}`); },
    missionSuccess() { calls.sfx.push('missionSuccess'); },
    missionFail() { calls.sfx.push('missionFail'); },
  };

  game.hud = {
    notify(text, kind) {
      calls.toast.push([text, kind]);
      if (!TOAST_KINDS.includes(kind)) fail(`hud.notify got unknown kind '${kind}'`);
    },
    subtitle(text) { calls.subtitle.push(text); },
    setMissionText(title, objective) { calls.missionText.push([title, objective]); },
    hitMarker(kind) {
      calls.hit.push(kind);
      if (!HIT_KINDS.includes(kind)) fail(`hud.hitMarker got '${JSON.stringify(kind)}', expected one of ${HIT_KINDS.join('|')}`);
    },
    showMissionResult(passedFlag, label) { calls.showMissionResult.push([passedFlag, label]); },
    setWaypoint() {},
    flashDamage() {},
  };

  game.notify = (text, kind = 'info', duration = 3) => game.hud.notify(text, kind, duration);
  game.subtitle = (text, duration) => game.hud.subtitle(text, duration);
  game.setWaypoint = (x, z) => { game.waypoint = { x, z }; calls.waypoints.push([x, z]); };
  game.clearWaypoint = () => { game.waypoint = null; };
  game.worldToGround = () => 0;
  game.nearestRoadPoint = (x, z, out = { x: 0, z: 0, laneId: -1 }) => {
    // Snap onto a 40 m road grid so the snap is deterministic and non-degenerate.
    out.x = Math.round(x / 40) * 40;
    out.z = z;
    out.laneId = 0;
    return out;
  };
  game.distanceToPlayer = (x, y, z) => Math.hypot(x - game.player.position[0], y - game.player.position[1], z - game.player.position[2]);
  game.isNight = () => false;
  game.setCameraMode = (m) => { game.cameraMode = m; };
  game.shakeCamera = () => {};
  game.addRecoil = () => {};
  game.save = () => {};
  game.load = () => {};
  game.spawnVehicle = (key, x, z, yaw = 0, o = {}) => {
    const v = new FakeVehicle(key, x, o.y !== undefined ? o.y : 0, z, yaw, o);
    game.vehicles.push(v);
    return v;
  };
  game.removeVehicle = (v) => {
    const i = game.vehicles.indexOf(v);
    if (i >= 0) game.vehicles.splice(i, 1);
    if (game.player.vehicle === v) game.player.exitVehicle();
  };
  game.spawnPickup = (kind, x, y, z, value) => {
    const k = { id: `p${game.pickups.length}`, kind, x, y, z, value, taken: false };
    game.pickups.push(k);
    return k;
  };
  game.explosionAt = (x, y, z, r, d) => { calls.sfx.push(`explosion:${r}:${d}`); };
  game.on = (event, fn) => {
    let arr = listeners.get(event);
    if (!arr) { arr = []; listeners.set(event, arr); }
    arr.push(fn);
    return () => { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); };
  };
  game.emit = (event, payload) => {
    const arr = listeners.get(event);
    if (!arr) return;
    for (const fn of arr.slice()) fn(payload);
  };
  game.listenerCount = () => {
    let n = 0;
    for (const arr of listeners.values()) n += arr.length;
    return n;
  };

  game.weapons = new WeaponSystem(game);
  game.missions = new MissionManager(game);
  return game;
}

/**
 * Advances the fake world one frame.
 * @param {Object} game Game.
 * @param {number} [dt=1/60] Seconds.
 * @returns {void}
 */
function step(game, dt = 1 / 60) {
  game.time.frame++;
  game.time.now += dt;
  game.time.elapsed += dt;
  for (const v of game.vehicles.slice()) v.update(dt);
  game.weapons.update(dt);
  game.missions.update(dt);
}

/**
 * @param {Object} game Game.
 * @param {number} x Target x.
 * @param {number} z Target z.
 * @returns {void}
 */
function teleportPlayer(game, x, z) {
  game.player.position[0] = x;
  game.player.position[2] = z;
  if (game.player.vehicle) {
    game.player.vehicle.position[0] = x;
    game.player.vehicle.position[2] = z;
  }
}

/* ------------------------------------------------------------------ *
 * 1. Contract shape
 * ------------------------------------------------------------------ */

section('contract — missions.js');
{
  ok(Array.isArray(MISSIONS), 'MISSIONS is an array');
  ok(MISSIONS.length >= 8, `MISSIONS has at least 8 entries (has ${MISSIONS.length})`);
  const TYPES = ['delivery', 'race', 'assassinate', 'rampage', 'chase', 'survive', 'collect'];
  const fields = ['id', 'name', 'nameKo', 'brief', 'briefKo', 'giver', 'reward', 'wantedOnStart', 'type'];
  const ids = new Set();
  for (const m of MISSIONS) {
    for (const f of fields) ok(m[f] !== undefined, `${m.id}.${f} is defined`);
    ok(TYPES.includes(m.type), `${m.id}.type '${m.type}' is a contract type`);
    ok(typeof m.setup === 'function' && m.setup.length >= 1, `${m.id}.setup(game)`);
    ok(typeof m.update === 'function' && m.update.length >= 3, `${m.id}.update(game, state, dt)`);
    ok(typeof m.cleanup === 'function' && m.cleanup.length >= 2, `${m.id}.cleanup(game, state)`);
    ok(typeof m.objectiveText === 'function' && m.objectiveText.length >= 1, `${m.id}.objectiveText(state)`);
    ok(Number.isFinite(m.reward) && m.reward > 0, `${m.id}.reward is a positive number`);
    ok(!ids.has(m.id), `${m.id} is unique`);
    ids.add(m.id);
  }
}

section('contract — weapons.js');
{
  const required = ['name', 'nameKo', 'damage', 'fireRate', 'magazine', 'reserve', 'spread', 'recoil',
    'range', 'auto', 'pellets', 'reloadTime', 'muzzleVelocity', 'sfx', 'twoHanded', 'zoom', 'icon'];
  for (const key of ['fist', 'pistol', 'smg', 'shotgun', 'rifle', 'sniper', 'grenade']) {
    ok(!!WEAPONS[key], `WEAPONS.${key} exists`);
    if (!WEAPONS[key]) continue;
    for (const f of required) ok(WEAPONS[key][f] !== undefined, `WEAPONS.${key}.${f} is defined`);
  }
  const g = makeGame();
  const w = g.weapons;
  for (const m of ['switchTo', 'nextWeapon', 'prevWeapon', 'tryFire', 'reload', 'update', 'applyHit']) {
    ok(typeof w[m] === 'function', `WeaponSystem#${m}()`);
  }
  ok(typeof w.current === 'string', 'WeaponSystem#current is a string');
  ok(w.ammo && typeof w.ammo === 'object', 'WeaponSystem#ammo is a record');
  eq(w.tryFire.length >= 2, true, 'tryFire accepts at least (origin, dir)');

  const mm = g.missions;
  for (const m of ['update', 'start', 'abort', 'complete', 'getAvailable']) {
    ok(typeof mm[m] === 'function', `MissionManager#${m}()`);
  }
  ok(mm.completed instanceof Set, 'MissionManager#completed is a Set');
  ok(Array.isArray(mm.markers), 'MissionManager#markers is an array');
  eq(mm.markers.length, MISSIONS.length, 'one start marker per mission point');
  ok(mm.markers.every((m) => typeof m.nameKo === 'string' && m.nameKo.length > 0),
    'markers publish nameKo (ui/map.js and the minimap label from it)');
}

/* ------------------------------------------------------------------ *
 * 2. HUD integration surface consumed by ui/hud.js
 * ------------------------------------------------------------------ */

section('HUD integration — weapons');
{
  const g = makeGame();
  const w = g.weapons;
  ok(w.defs && w.defs.pistol && Number.isFinite(w.defs.pistol.magazine),
    'WeaponSystem#defs is published (hud._magCapacity reads w.defs[key].magazine)');
  ok(Number.isFinite(w.currentSpread),
    'WeaponSystem#currentSpread is published (hud._updateCrosshair reads w.currentSpread)');
  w.giveWeapon('pistol', 60);
  w.switchTo('pistol');
  w.equipLeft = 0;
  w.ammoFor('pistol').mag = 3;
  ok(w.reload(), 'reload() starts');
  ok(Number.isFinite(w.reloadDuration) && w.reloadDuration > 0,
    'WeaponSystem#reloadDuration is published (hud._reloadProgress needs a total)');
  const p0 = 1 - w.reloadLeft / w.reloadDuration;
  for (let i = 0; i < 30; i++) w.update(1 / 60);
  const p1 = 1 - w.reloadLeft / w.reloadDuration;
  ok(p1 > p0 && p1 <= 1, `reload progress advances (${p0} -> ${p1})`);

  // Crosshair spread must react to aiming / movement, not be a constant.
  const hip = w.currentSpread;
  g.player.aiming = true;
  for (let i = 0; i < 10; i++) w.update(1 / 60);
  ok(Number.isFinite(hip) && w.currentSpread < hip, `currentSpread tightens while aiming (${hip} -> ${w.currentSpread})`);
}

/* ------------------------------------------------------------------ *
 * 3. Weapon ballistics
 * ------------------------------------------------------------------ */

section('weapons — firing');
{
  const g = makeGame({ wall: true });
  const w = g.weapons;
  w.giveWeapon('pistol', 60);
  w.switchTo('pistol');
  w.equipLeft = 0;
  w.cooldown = 0;
  const magBefore = w.ammoFor('pistol').mag;
  const fired = w.tryFire([0, 1.4, 0], [0, 0, -1], true, 1, null);
  ok(fired, 'player pistol shot leaves the barrel');
  eq(w.ammoFor('pistol').mag, magBefore - 1, 'the shot consumed one round');
  ok(w.cooldown > 0, 'fire rate cooldown engaged');
  const again = w.tryFire([0, 1.4, 0], [0, 0, -1], true, 1, null);
  eq(again, false, 'a second shot inside the cooldown is refused');

  // Empty magazine -> dry fire, no shot.
  w.cooldown = 0;
  w.ammoFor('pistol').mag = 0;
  w.ammoFor('pistol').reserve = 0;
  eq(w.tryFire([0, 1.4, 0], [0, 0, -1], true, 1, null), false, 'empty magazine refuses to fire');

  // Damage falloff is monotone and bounded.
  const near = damageFalloff('rifle', 1);
  const mid = damageFalloff('rifle', 100);
  const far = damageFalloff('rifle', 1000);
  ok(near === 1 && mid < near && far >= WEAPONS.rifle.falloffMin - 1e-9 && far <= mid,
    `damageFalloff is monotone (1:${near} 100:${mid.toFixed(2)} 1000:${far.toFixed(2)})`);
}

section('weapons — hit attribution');
{
  const g = makeGame();
  const w = g.weapons;
  g.peds.peds.push(new FakePed(0, 0, -10));
  w.giveWeapon('rifle', 120);
  w.switchTo('rifle');
  w.equipLeft = 0;
  w.cooldown = 0;

  // An AI shot that kills a ped must not pop the player's hit marker or credit their stats.
  const hitsBefore = g.calls.hit.length;
  const dealtBefore = g.player.damageDealt;
  w.tryFire([0, 1.4, 0], [0, 0, -1], false, 1, { weapon: 'rifle', shooter: null, damageMul: 1 });
  eq(g.calls.hit.length, hitsBefore, 'an AI shot does not flash the player hit marker');
  eq(g.player.damageDealt, dealtBefore, 'an AI shot does not credit player.damageDealt');

  // The player's own shot must.
  g.peds.peds.push(new FakePed(0, 0, -12));
  w.cooldown = 0;
  w.tryFire([0, 1.4, 0], [0, 0, -1], true, 1, null);
  ok(g.calls.hit.length > hitsBefore, 'a player hit flashes the hit marker');
  ok(g.player.damageDealt > dealtBefore, 'a player hit credits damageDealt');

  // Accuracy must not count the scenery.
  const g2 = makeGame({ wall: true });
  g2.weapons.giveWeapon('rifle', 120);
  g2.weapons.switchTo('rifle');
  g2.weapons.equipLeft = 0;
  g2.weapons.cooldown = 0;
  g2.weapons.tryFire([0, 1.4, 0], [0, 0, -1], true, 1, null);
  eq(g2.weapons.shotsHit, 0, 'hitting a wall does not count as a hit for the accuracy stat');
}

section('weapons — no self-hits');
{
  const g = makeGame();
  const w = g.weapons;
  const car = g.spawnVehicle('muscle', 0, -20, 0, {});
  const target = g.spawnVehicle('sedan', 0, -60, 0, {});
  // Gunman leaning out of `car` fires at something far away; the muzzle sits at the roof line.
  w.tryFire([car.position[0], car.position[1] + 1.1, car.position[2]], [0, -0.02, -1], false, 1,
    { weapon: 'smg', shooter: car, damageMul: 1 });
  eq(car.damageTaken, 0, 'a vehicle-mounted shooter never hits its own car');
  ok(target.damageTaken >= 0, 'the shot still resolves against the world');
}

section('weapons — tracer origin');
{
  const g = makeGame();
  const w = g.weapons;
  w.rng = new Rand(1); // make the tracer roll deterministic
  // Force a tracer on an AI shot fired far away from the player.
  for (let i = 0; i < 12; i++) {
    w.tryFire([200, 1.4, 200], [0, 0, -1], false, 1, { weapon: 'sniper', shooter: null, damageMul: 1 });
  }
  const live = w._tracers.filter((t) => t.active);
  ok(live.length > 0, 'AI fire spawns tracers');
  const bad = live.filter((t) => Math.hypot(t.x - 200, t.z - 200) > 5);
  eq(bad.length, 0, 'AI tracers start at the AI muzzle, not at the player weapon');
}

section('weapons — grenades');
{
  const g = makeGame();
  const w = g.weapons;
  w.giveWeapon('grenade', 4);
  w.switchTo('grenade');
  w.equipLeft = 0;
  w.cooldown = 0;
  const boomsBefore = g.calls.sfx.filter((s) => s.startsWith('explosion:')).length;
  ok(w.tryFire([0, 1.4, 0], [0, 0.2, -1], true, 1, null), 'grenade throw accepted');
  ok(w._grenades.some((x) => x.active), 'a grenade is live');
  for (let i = 0; i < 60 * 5; i++) w.update(1 / 60);
  const booms = g.calls.sfx.filter((s) => s.startsWith('explosion:')).length - boomsBefore;
  eq(booms, 1, 'the grenade detonates exactly once');
  eq(w._grenades.filter((x) => x.active).length, 0, 'no grenade is left live');
  ok(findNaN(w._grenades, 'grenades').length === 0, 'grenade state holds no NaN');
}

section('weapons — decal queue is bounded');
{
  const g = makeGame({ wall: true });
  const w = g.weapons;
  w.giveWeapon('rifle', 999);
  w.switchTo('rifle');
  for (let i = 0; i < 400; i++) {
    w.cooldown = 0;
    w.equipLeft = 0;
    w.ammoFor('rifle').mag = 30;
    w.tryFire([0, 1.4, 0], [0, 0, -1], true, 1, null);
  }
  ok(g.ext.decals.length <= 128, `decal queue stays bounded (${g.ext.decals.length})`);
}

section('weapons — persistence');
{
  const g = makeGame();
  g.weapons.giveWeapon('smg', 120);
  g.weapons.switchTo('smg');
  const blob = JSON.parse(JSON.stringify(g.weapons.serialize()));
  const g2 = makeGame();
  g2.weapons.deserialize(blob);
  eq(g2.weapons.current, 'smg', 'the equipped weapon survives a save/load round trip');
  ok(g2.weapons.ammoFor('smg').reserve > 0, 'reserve ammo survives a save/load round trip');
}

/* ------------------------------------------------------------------ *
 * 4. Missions — lifecycle
 * ------------------------------------------------------------------ */

/**
 * Snapshots how much of the world a mission is allowed to leave behind.
 * @param {Object} game Game.
 * @returns {{vehicles:number, peds:number, pickups:number}} Counts.
 */
function worldCounts(game) {
  return { vehicles: game.vehicles.length, peds: game.peds.peds.length, pickups: game.pickups.length };
}

section('missions — start / abort leaves no leak');
for (const def of MISSIONS) {
  const g = makeGame();
  const before = worldCounts(g);
  const started = g.missions.start(def.id);
  ok(started, `${def.id} starts`);
  if (!started) continue;
  for (let i = 0; i < 60 * 6; i++) step(g);
  if (g.missions.active) g.missions.abort();
  const after = worldCounts(g);
  eq(after.vehicles, before.vehicles, `${def.id} leaves no vehicles behind`);
  eq(after.peds, before.peds, `${def.id} leaves no peds behind`);
  eq(after.pickups, before.pickups, `${def.id} leaves no pickups behind`);
  eq(g.waypoint, null, `${def.id} clears the waypoint`);
  eq(g.missions.active, null, `${def.id} is no longer active`);
  const last = g.calls.missionText[g.calls.missionText.length - 1];
  ok(last && !last[0], `${def.id} clears the HUD mission panel`);
}

section('missions — player death fails the mission and cleans up');
for (const def of MISSIONS) {
  const g = makeGame();
  ok(g.missions.start(def.id), `${def.id} starts`);
  for (let i = 0; i < 60 * 4; i++) step(g);
  g.player.dead = true;
  g.emit('playerDied', { source: 'test' });
  eq(g.missions.active, null, `${def.id} ends on player death`);
  eq(g.vehicles.length, 0, `${def.id} removes its vehicles on player death`);
  eq(g.peds.peds.length, 0, `${def.id} removes its peds on player death`);
}

section('missions — no NaN and no runaway state');
for (const def of MISSIONS) {
  const g = makeGame();
  if (!g.missions.start(def.id)) continue;
  for (let i = 0; i < 60 * 30; i++) {
    step(g);
    if (!g.missions.active) break;
    // Wander so the mission logic exercises distance checks.
    teleportPlayer(g, Math.sin(i * 0.01) * 120, 20 + Math.cos(i * 0.013) * 120);
  }
  const st = g.missions.active ? g.missions.active.state : null;
  if (st) {
    const bad = findNaN(st, def.id);
    eq(bad.length, 0, `${def.id} state holds no NaN (${bad.slice(0, 4).join(', ')})`);
  }
  if (g.missions.active) g.missions.abort();
}

section('missions — objective text is stable enough for the DOM');
for (const def of MISSIONS) {
  const g = makeGame();
  if (!g.missions.start(def.id)) continue;
  for (let i = 0; i < 60 * 4; i++) step(g); // clear the countdown, get the mission moving
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    step(g);
    if (!g.missions.active) break;
    const t = def.objectiveText(g.missions.active.state);
    ok(typeof t === 'string' && t.length > 0, `${def.id} objectiveText returns a non-empty string`);
    seen.add(t);
  }
  // hud._applyMission rebuilds the objective list whenever the string changes: at 60 fps a
  // one-second sample must not produce a new string on (nearly) every frame.
  ok(seen.size <= 8, `${def.id} objective text changes at most 8x/second (saw ${seen.size})`);
  if (g.missions.active) g.missions.abort();
}

section('missions — determinism');
for (const def of MISSIONS) {
  /**
   * @returns {string} A fingerprint of everything the setup placed in the world.
   */
  const fingerprint = () => {
    const g = makeGame();
    if (!g.missions.start(def.id)) return 'refused';
    const st = g.missions.active.state;
    const parts = [];
    for (const v of g.vehicles) parts.push(`v:${v.position[0].toFixed(3)},${v.position[2].toFixed(3)}`);
    for (const m of st.markers) parts.push(`m:${m.x.toFixed(3)},${m.z.toFixed(3)}`);
    g.missions.abort();
    return parts.join('|');
  };
  const a = fingerprint();
  const b = fingerprint();
  eq(a, b, `${def.id} setup is deterministic for the same seed`);
}

section('missions — completion pays out and reports success');
{
  // delivery: board the van, then drive it to each drop.
  const g = makeGame();
  ok(g.missions.start('delivery_run'), 'delivery starts');
  const st = g.missions.active.state;
  for (let i = 0; i < 60 * 4; i++) step(g);
  g.player.enterVehicle(st.van);
  for (let i = 0; i < 5; i++) step(g);
  for (const drop of st.drops) {
    st.van.position[0] = drop.x;
    st.van.position[2] = drop.z;
    st.timeLeft = 120;
    step(g);
    if (!g.missions.active) break;
  }
  eq(g.missions.active, null, 'delivery finished');
  eq(g.player.money, 1800, 'delivery paid its reward');
  ok(g.missions.completed.has('delivery_run'), 'delivery is recorded as completed');
  const ended = g.calls.showMissionResult[g.calls.showMissionResult.length - 1];
  ok(ended && ended[0] === true, 'the HUD showed the MISSION PASSED banner');
  eq(g.vehicles.length, 0, 'the van was removed');
}

{
  // collect: walk over every package.
  const g = makeGame();
  ok(g.missions.start('collect'), 'collect starts');
  const st = g.missions.active.state;
  for (let i = 0; i < 60 * 4; i++) step(g);
  for (const p of st.packages) {
    teleportPlayer(g, p.x, p.z);
    g.player.position[1] = p.y;
    step(g);
    if (!g.missions.active) break;
  }
  eq(g.missions.active, null, 'collect finished');
  eq(g.player.money, 2400, 'collect paid its reward');
}

{
  // survive: outlast the clock.
  const g = makeGame();
  ok(g.missions.start('survive'), 'survive starts');
  for (let i = 0; i < 60 * 260 && g.missions.active; i++) step(g, 1 / 60);
  eq(g.missions.active, null, 'survive finished');
  eq(g.player.money, 5000, 'survive paid its reward');
  eq(g.vehicles.length, 0, 'survive removed its police cars');
}

{
  // hit_list: kill the three targets.
  const g = makeGame();
  ok(g.missions.start('hit_list'), 'hit list starts');
  const st = g.missions.active.state;
  for (let i = 0; i < 60 * 4; i++) step(g);
  for (const t of st.targets) {
    if (!t.ped) continue;
    t.ped.health = 0;
    t.ped.dead = true;
    t.ped.state = 'dead';
  }
  for (let i = 0; i < 10 && g.missions.active; i++) step(g);
  eq(g.missions.active, null, 'hit list finished');
  eq(g.player.money, 4000, 'hit list paid its reward');
  eq(g.peds.peds.length, 0, 'hit list removed its target peds');
}

{
  // rampage: the kill counter must work off the documented player.kills as well as the event.
  const g = makeGame();
  ok(g.missions.start('rampage'), 'rampage starts');
  for (let i = 0; i < 60 * 4; i++) step(g);
  for (let i = 0; i < 18; i++) {
    g.player.kills++;   // deliberately WITHOUT the pedKilled event
    step(g);
    if (!g.missions.active) break;
  }
  eq(g.missions.active, null, 'rampage completes from player.kills alone');
  eq(g.player.money, 2600, 'rampage paid its reward');
}

{
  // getaway: must not self-complete when nothing ever raised the wanted level.
  const g = makeGame({ police: false });
  const started = g.missions.start('getaway');
  if (started) {
    for (let i = 0; i < 60 * 10 && g.missions.active; i++) step(g);
    ok(g.player.money === 0, 'getaway does not pay out when the police system is missing');
    if (g.missions.active) g.missions.abort();
  } else {
    ok(true, 'getaway refuses to start without a police system');
  }

  const g2 = makeGame();
  ok(g2.missions.start('getaway'), 'getaway starts with a police system');
  for (let i = 0; i < 60 * 5; i++) step(g2);
  ok(g2.missions.active, 'getaway is still running while the player is wanted');
  ok(g2.police.wanted > 0, 'getaway put stars on the player');
  g2.police.clearWanted();
  for (let i = 0; i < 60 * 3 && g2.missions.active; i++) step(g2);
  eq(g2.missions.active, null, 'getaway completes once the heat is gone');
  eq(g2.player.money, 3000, 'getaway paid its reward');
}

section('missions — failure path');
{
  const g = makeGame();
  ok(g.missions.start('delivery_run'), 'delivery starts');
  const st = g.missions.active.state;
  for (let i = 0; i < 60 * 4; i++) step(g);
  st.van.isDestroyed = true;
  step(g);
  eq(g.missions.active, null, 'destroying the van fails the mission');
  eq(g.player.money, 0, 'a failed mission pays nothing');
  const ended = g.calls.showMissionResult[g.calls.showMissionResult.length - 1];
  ok(ended && ended[0] === false, 'the HUD showed the MISSION FAILED banner');
  ok(!!ended && typeof ended[1] === 'string' && ended[1].length > 0, 'the failure banner carries a reason');
  eq(g.vehicles.length, 0, 'the wreck was cleaned up');
}

section('missions — markers, cooldowns and rendering');
{
  const g = makeGame();
  const mm = g.missions;
  const avail = mm.getAvailable();
  eq(avail.length, MISSIONS.length, 'every mission is offered before any is started');
  ok(avail.every((a) => Number.isFinite(a.x) && Number.isFinite(a.z) && Number.isFinite(a.reward)),
    'getAvailable entries carry finite coordinates and a reward');

  // Rendering must not explode, must not submit a null material and must cull distant markers.
  g.player.position[0] = 0;
  g.player.position[2] = 20;
  g.camera.position[0] = 0;
  g.camera.position[2] = 20;
  const before = g.calls.lights;
  mm.submit(g.renderer, 1 / 60);
  const lit = g.calls.lights - before;
  ok(lit > 0, 'nearby mission markers are drawn');
  ok(lit < MISSIONS.length, `far mission markers are culled (${lit}/${MISSIONS.length} lit)`);

  // Walking into a marker starts the mission.
  const marker = mm.markers[0];
  teleportPlayer(g, marker.x, marker.z);
  for (let i = 0; i < 200 && !mm.active; i++) mm.update(1 / 60);
  ok(mm.active, 'standing in a marker starts its mission');
  mm.abort();
  ok((mm.cooldowns.get(marker.missionId) || 0) > 0, 'aborting puts the mission on cooldown');
  eq(mm.getAvailable().some((a) => a.id === marker.missionId), false, 'a mission on cooldown is not offered');
  for (let i = 0; i < 60 * 20; i++) mm.update(1 / 60);
  ok((mm.cooldowns.get(marker.missionId) || 0) === 0, 'the cooldown expires');
}

section('missions — dispose');
{
  const g = makeGame();
  const n0 = g.listenerCount();
  const mm = new MissionManager(g);
  ok(g.listenerCount() > n0, 'the manager subscribes to the event bus');
  mm.start('rampage');
  for (let i = 0; i < 60; i++) mm.update(1 / 60);
  mm.dispose();
  eq(g.listenerCount(), n0, 'dispose() removes every listener');
  eq(mm.active, null, 'dispose() ends the running mission');
  eq(g.vehicles.length, 0, 'dispose() cleans up spawned vehicles');
}

section('missions — persistence');
{
  const g = makeGame();
  g.missions.completed.add('rampage');
  const blob = JSON.parse(JSON.stringify(g.missions.serialize()));
  const g2 = makeGame();
  g2.missions.deserialize(blob);
  ok(g2.missions.completed.has('rampage'), 'completed missions survive a save/load round trip');
}

/* ------------------------------------------------------------------ *
 * 5. Static hygiene
 * ------------------------------------------------------------------ */

section('static hygiene');
{
  const { readFileSync } = await import('node:fs');
  for (const f of ['js/missions.js', 'js/entities/weapons.js']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    ok(!/Math\.random\s*\(/.test(src.replace(/`Math\.random\(\)`/g, '')), `${f} never calls Math.random()`);
    ok(!/setTimeout|setInterval/.test(src), `${f} owns no timers`);
    ok(!/addEventListener/.test(src), `${f} registers no DOM listeners`);
    ok(!/\bdocument\.|\bwindow\./.test(src), `${f} touches no DOM`);
    ok(!/TODO|FIXME/.test(src), `${f} has no TODO / FIXME left`);
  }
}

/* ------------------------------------------------------------------ */

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
