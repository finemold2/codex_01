/**
 * NEON CITY — missions.
 *
 * Eight hand-written missions plus the state machine that offers them from yellow world markers,
 * runs exactly one at a time, keeps the HUD objective in sync and guarantees that every entity a
 * mission spawned is removed again — on success, failure, abort, player death or mission switch.
 *
 * Everything a mission touches goes through the documented `game` API (contract section 16):
 * spawning, audio, particles, HUD, police and persistence. Missions own no timers of their own;
 * all timing is driven from {@link MissionManager#update}, so a paused game pauses the mission.
 */
import { clamp, wrapAngle, Rand } from './core/math.js';
import { cylinder, cone, mergeGeometries } from './core/geometry.js';

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */

/** Radius in metres at which the player triggers a mission marker. */
const MARKER_RADIUS = 3.4;
/** Seconds of standing inside a marker before the mission auto-starts. */
const MARKER_DWELL = 1.5;
/** Countdown length before a started mission begins ticking. */
const START_COUNTDOWN = 3;
/** Cooldown after a success before the same mission can be replayed. */
const COOLDOWN_SUCCESS = 30;
/** Cooldown after a failure / abort. */
const COOLDOWN_FAIL = 15;
/** Metres from the camera beyond which a start marker is not drawn. */
const MARKER_DRAW_RANGE = 180;
/** Seconds between objective-line refreshes (the HUD rebuilds its DOM whenever it changes). */
const OBJECTIVE_INTERVAL = 0.25;

/**
 * @param {*} v Candidate.
 * @param {number} d Fallback.
 * @returns {number} A finite number.
 */
function fin(v, d) {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/**
 * @param {number} ax Point A x.
 * @param {number} az Point A z.
 * @param {number} bx Point B x.
 * @param {number} bz Point B z.
 * @returns {number} Planar distance.
 */
function dist2(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Formats a duration for the objective line.
 * @param {number} seconds Remaining seconds.
 * @returns {string} `M:SS`
 */
function clockText(seconds) {
  const s = Math.max(0, Math.ceil(fin(seconds, 0)));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

/**
 * Ground height helper that never returns NaN.
 * @param {Object} game Game.
 * @param {number} x World x.
 * @param {number} z World z.
 * @returns {number} Ground Y.
 */
function groundY(game, x, z) {
  if (game && typeof game.worldToGround === 'function') {
    const y = game.worldToGround(x, z);
    if (Number.isFinite(y)) return y;
  }
  return 0;
}

/**
 * Reads an entity position (vehicle, ped or player) into `out`.
 * @param {Object} ent Entity.
 * @param {number[]} out Destination `[x,y,z]`.
 * @returns {boolean} True when a finite position was found.
 */
function entityPos(ent, out) {
  if (!ent) return false;
  let p = ent.position;
  if ((!p || !Number.isFinite(p[0])) && ent.character) p = ent.character.position;
  if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) return false;
  out[0] = p[0];
  out[1] = p[1];
  out[2] = p[2];
  return true;
}

/**
 * @param {Object} game Game.
 * @param {Object} v Vehicle.
 * @returns {boolean} True when the vehicle still exists and is drivable.
 */
function vehicleAlive(game, v) {
  if (!v || v.isDestroyed) return false;
  if (typeof v.health === 'number' && v.health <= 0) return false;
  if (!v.position || !Number.isFinite(v.position[0])) return false;
  if (game && Array.isArray(game.vehicles) && game.vehicles.indexOf(v) < 0) return false;
  return true;
}

/**
 * @param {Object} game Game.
 * @param {Object} ped Ped record.
 * @returns {boolean} True when the ped is alive and still managed.
 */
function pedAlive(game, ped) {
  if (!ped || ped.dead === true || ped.state === 'dead') return false;
  if (typeof ped.health === 'number' && ped.health <= 0) return false;
  const list = game && game.peds && game.peds.peds;
  if (Array.isArray(list) && list.indexOf(ped) < 0) return false;
  return true;
}

/**
 * @param {Object} game Game.
 * @param {Object} ped Ped record.
 * @returns {boolean} True when the ped object is no longer tracked by the ped manager.
 */
function pedVanished(game, ped) {
  const list = game && game.peds && game.peds.peds;
  if (!Array.isArray(list)) return false;
  return list.indexOf(ped) < 0;
}

/**
 * Teleports a ped (and its character) to a spot on the ground.
 * @param {Object} ped Ped record.
 * @param {number} x World x.
 * @param {number} y World y.
 * @param {number} z World z.
 * @param {number} [yaw=0] Facing.
 * @returns {void}
 */
function placePed(ped, x, y, z, yaw = 0) {
  if (!ped) return;
  if (ped.position && ped.position.length >= 3) {
    ped.position[0] = x; ped.position[1] = y; ped.position[2] = z;
  }
  if (ped.character) {
    if (ped.character.position && ped.character.position.length >= 3) {
      ped.character.position[0] = x;
      ped.character.position[1] = y;
      ped.character.position[2] = z;
    }
    ped.character.yaw = yaw;
  }
  if (typeof ped.yaw === 'number') ped.yaw = yaw;
}

/**
 * Steers an AI-driven vehicle towards a world point by writing its input struct.
 * Works with the arcade vehicle controller: no physics is applied here.
 *
 * When an `ai` record is supplied the driver also notices that it has been pinned against a wall
 * (barely moving while still far from the target) and reverses out of it for a moment, so a
 * mission car can never park itself in a corner and stall the whole mission.
 *
 * @param {Object} v Vehicle.
 * @param {number} tx Target x.
 * @param {number} tz Target z.
 * @param {number} [topSpeed=22] Desired speed in m/s.
 * @param {Object|null} [ai=null] Per-driver scratch `{stuck, reverse}` (see {@link newDriver}).
 * @param {number} [dt=0] Seconds, required for the stuck detector.
 * @returns {number} Distance to the target.
 */
function driveTowards(v, tx, tz, topSpeed = 22, ai = null, dt = 0) {
  if (!v || !v.input || !v.position) return Infinity;
  const dx = tx - fin(v.position[0], 0);
  const dz = tz - fin(v.position[2], 0);
  const d = Math.hypot(dx, dz);
  if (!(d > 0.001)) {
    v.input.throttle = 0;
    v.input.brake = 1;
    v.input.steer = 0;
    return 0;
  }
  // Yaw convention: forward = (-sin(yaw), 0, -cos(yaw)).
  const wantYaw = Math.atan2(-dx, -dz);
  const diff = wrapAngle(wantYaw - fin(v.yaw, 0));
  const speed = Math.hypot(fin(v.velocity ? v.velocity[0] : 0, 0), fin(v.velocity ? v.velocity[2] : 0, 0));

  if (ai) {
    if (ai.reverse > 0) {
      ai.reverse -= dt;
      // Back up while steering the nose away from whatever we are wedged against.
      v.input.throttle = -0.8;
      v.input.steer = clamp(-diff * 1.4, -1, 1);
      v.input.brake = 0;
      v.input.handbrake = false;
      if (v.engineOn === false) v.engineOn = true;
      if (ai.reverse <= 0) { ai.reverse = 0; ai.stuck = 0; }
      return d;
    }
    if (d > 6 && speed < 1.5) ai.stuck += dt;
    else ai.stuck = 0;
    if (ai.stuck > 1.2) {
      ai.stuck = 0;
      ai.reverse = 1.1;
    }
  }

  v.input.steer = clamp(diff * 1.8, -1, 1);
  // Slow down for hard turns and when arriving.
  const turnLimit = 1 - Math.min(0.75, Math.abs(diff) * 0.55);
  const want = Math.min(topSpeed * turnLimit, d * 1.3 + 2);
  if (speed < want) v.input.throttle = clamp((want - speed) * 0.45, 0, 1);
  else v.input.throttle = -0.1;
  v.input.brake = speed > want * 1.4 ? 0.7 : 0;
  v.input.handbrake = false;
  if (v.engineOn === false) v.engineOn = true;
  return d;
}

/**
 * Fresh scratch record for one AI driver.
 * @returns {{stuck:number, reverse:number, leg:number, fireTimer:number}} Driver state.
 */
function newDriver() {
  return { stuck: 0, reverse: 0, leg: 0, fireTimer: 0 };
}

/**
 * Builds a coarse road-following route between two points by sampling the straight line and
 * snapping every sample onto the road network. Cheap, deterministic and good enough to stop an
 * escort car from driving straight through a city block.
 * @param {Object} game Game.
 * @param {number} fromX Start x.
 * @param {number} fromZ Start z.
 * @param {{x:number, z:number}} to Destination.
 * @param {number} [spacing=70] Metres between samples.
 * @returns {Array<{x:number, z:number}>} Route, always ending exactly on `to`.
 */
function buildRoute(game, fromX, fromZ, to, spacing = 70) {
  const out = [];
  const dx = to.x - fromX;
  const dz = to.z - fromZ;
  const total = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.min(24, Math.floor(total / spacing)));
  const scratch = { x: 0, z: 0, laneId: -1 };
  for (let i = 1; i <= steps; i++) {
    const t = i / (steps + 1);
    let x = fromX + dx * t;
    let z = fromZ + dz * t;
    if (typeof game.nearestRoadPoint === 'function') {
      try {
        const p = game.nearestRoadPoint(x, z, scratch);
        if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) { x = p.x; z = p.z; }
      } catch (err) { /* keep the straight-line sample */ }
    }
    const prev = out.length ? out[out.length - 1] : { x: fromX, z: fromZ };
    if (dist2(x, z, prev.x, prev.z) < 12) continue;
    out.push({ x, z });
  }
  out.push({ x: to.x, z: to.z });
  return out;
}

/**
 * Drives a vehicle along a route built by {@link buildRoute}.
 * @param {Object} v Vehicle.
 * @param {Array<{x:number, z:number}>} route Waypoints.
 * @param {Object} ai Driver scratch (`leg` is the current waypoint index).
 * @param {number} topSpeed Desired speed in m/s.
 * @param {number} dt Seconds.
 * @returns {number} Straight-line distance left to the final waypoint.
 */
function driveRoute(v, route, ai, topSpeed, dt) {
  if (!v || !v.position || !route || !route.length) return Infinity;
  if (ai.leg >= route.length) ai.leg = route.length - 1;
  const last = route[route.length - 1];
  const leg = route[ai.leg];
  const arrive = ai.leg === route.length - 1 ? 10 : 16;
  const d = driveTowards(v, leg.x, leg.z, topSpeed, ai, dt);
  if (d < arrive && ai.leg < route.length - 1) {
    ai.leg++;
    ai.stuck = 0;
  }
  return dist2(fin(v.position[0], 0), fin(v.position[2], 0), last.x, last.z);
}

/**
 * Puts a spawned-but-unmanned mission vehicle on the handbrake so it cannot creep down a slope
 * while the player walks over to it.
 * @param {Object|null} v Vehicle.
 * @returns {void}
 */
function parkVehicle(v) {
  if (!v || !v.input) return;
  v.input.throttle = 0;
  v.input.steer = 0;
  v.input.brake = 1;
  v.input.handbrake = true;
}

/* ------------------------------------------------------------------ *
 * Mission state helpers
 * ------------------------------------------------------------------ */

const _p = [0, 0, 0];
const _q = [0, 0, 0];
const _dir = [0, 0, 0];
const _muzzle = [0, 0, 0];

/**
 * Creates the shared mission state skeleton.
 * @param {Object} game Game.
 * @param {string} id Mission id (also the RNG salt).
 * @returns {Object} Fresh state.
 */
function newState(game, id) {
  const mgr = game.missions;
  let ox = 0;
  let oz = 0;
  if (mgr && mgr.origin) { ox = fin(mgr.origin.x, 0); oz = fin(mgr.origin.z, 0); } else if (game.player) {
    ox = fin(game.player.position[0], 0);
    oz = fin(game.player.position[2], 0);
  }
  const run = mgr ? fin(mgr.runCount, 0) : 0;
  const rng = game.rng && typeof game.rng.fork === 'function'
    ? game.rng.fork(`${id}:${run}`) : new Rand(`${id}:${run}`);
  return {
    id,
    rng,
    origin: { x: ox, y: groundY(game, ox, oz), z: oz },
    /** @type {Object[]} vehicles spawned by this mission */
    vehicles: [],
    /** @type {Object[]} peds spawned by this mission */
    peds: [],
    /** @type {Object[]} world markers owned by this mission */
    markers: [],
    /** @type {Object[]} pickups spawned by this mission */
    pickups: [],
    elapsed: 0,
    phase: 'run',
    failReason: '',
    note: '',
    waypointX: NaN,
    waypointZ: NaN,
  };
}

/**
 * Spawns a vehicle and registers it for cleanup.
 * @param {Object} game Game.
 * @param {Object} st Mission state.
 * @param {string} typeKey Vehicle type key.
 * @param {number} x World x.
 * @param {number} z World z.
 * @param {number} [yaw=0] Facing.
 * @param {Object} [opts] Extra options forwarded to `game.spawnVehicle`.
 * @returns {Object|null} The vehicle, or null when spawning failed.
 */
function spawnVehicle(game, st, typeKey, x, z, yaw = 0, opts = undefined) {
  if (typeof game.spawnVehicle !== 'function') return null;
  let v = null;
  try {
    v = game.spawnVehicle(typeKey, x, z, yaw, opts || {});
  } catch (err) {
    v = null;
  }
  if (!v) return null;
  v.missionOwned = true;
  v.parked = false;
  parkVehicle(v);
  st.vehicles.push(v);
  return v;
}

/**
 * Muzzle position for a gunman leaning out of a moving car. Deliberately offset sideways and
 * upwards so the bullet starts clear of its own bodywork.
 * @param {Object} v Vehicle.
 * @param {number} towardsX Target x (the shot leans towards it).
 * @param {number} towardsZ Target z.
 * @param {number[]} out Destination `[x,y,z]`.
 * @returns {boolean} True when a finite muzzle was produced.
 */
function vehicleMuzzle(v, towardsX, towardsZ, out) {
  if (!v || !v.position || !Number.isFinite(v.position[0])) return false;
  const cx = v.position[0];
  const cz = v.position[2];
  let sx = towardsX - cx;
  let sz = towardsZ - cz;
  const l = Math.hypot(sx, sz);
  if (l > 1e-4) { sx /= l; sz /= l; } else { sx = 1; sz = 0; }
  const type = v.type || {};
  const reach = fin(type.width, 1.9) * 0.5 + 0.55;
  out[0] = cx + sx * reach;
  out[1] = fin(v.position[1], 0) + fin(type.height, 1.45) * 0.72 + 0.35;
  out[2] = cz + sz * reach;
  return true;
}

/**
 * A drive-by burst at the player from a mission vehicle.
 * @param {Object} game Game.
 * @param {Object} v Shooter vehicle.
 * @param {Object} slot Per-vehicle scratch holding `fireTimer`.
 * @param {number} dt Seconds.
 * @param {Object} [opts] `{weapon, range, rate, spread, damageMul}`.
 * @returns {void}
 */
function driveByFire(game, v, slot, dt, opts = {}) {
  const player = game.player;
  const weapons = game.weapons;
  if (!player || player.dead || !player.position || !Number.isFinite(player.position[0])) return;
  if (!weapons || typeof weapons.tryFire !== 'function') return;
  if (!vehicleAlive(game, v)) return;
  const d = dist2(fin(v.position[0], 0), fin(v.position[2], 0), player.position[0], player.position[2]);
  if (d > fin(opts.range, 45)) { slot.fireTimer = Math.min(slot.fireTimer, 0.5); return; }
  slot.fireTimer -= dt;
  if (slot.fireTimer > 0) return;
  slot.fireTimer = fin(opts.rate, 0.6);
  if (!vehicleMuzzle(v, player.position[0], player.position[2], _muzzle)) return;
  _dir[0] = player.position[0] - _muzzle[0];
  _dir[1] = player.position[1] + 1 - _muzzle[1];
  _dir[2] = player.position[2] - _muzzle[2];
  const l = Math.hypot(_dir[0], _dir[1], _dir[2]);
  if (!(l > 0.01)) return;
  _dir[0] /= l; _dir[1] /= l; _dir[2] /= l;
  weapons.tryFire(_muzzle, _dir, false, fin(opts.spread, 3), {
    weapon: opts.weapon || 'smg',
    shooter: v,
    damageMul: fin(opts.damageMul, 0.35),
  });
}

/**
 * Spawns a hostile mission ped and registers it for cleanup.
 * @param {Object} game Game.
 * @param {Object} st Mission state.
 * @param {number} x World x.
 * @param {number} z World z.
 * @param {Object} [opts] `{weapon, health, kind, yaw}`.
 * @returns {Object|null} Ped record, or null when the ped manager could not spawn one.
 */
function spawnHostilePed(game, st, x, z, opts = {}) {
  const peds = game.peds;
  if (!peds) return null;
  const y = groundY(game, x, z) + 0.05;
  let ped = null;
  if (typeof peds.spawnPed === 'function') {
    try { ped = peds.spawnPed(x, y, z, opts); } catch (err) { ped = null; }
  }
  if (!ped && typeof peds.spawnAround === 'function') {
    const list = Array.isArray(peds.peds) ? peds.peds : null;
    const before = list ? list.length : 0;
    _p[0] = x; _p[1] = y; _p[2] = z;
    try { peds.spawnAround(_p, 1); } catch (err) { /* ped manager refused */ }
    if (list && list.length > before) ped = list[list.length - 1];
  }
  if (!ped) return null;
  placePed(ped, x, y, z, fin(opts.yaw, 0));
  ped.missionOwned = true;
  ped.persistent = true;
  ped.noDespawn = true;
  ped.hostile = true;
  ped.aggressive = true;
  ped.armed = true;
  ped.weapon = opts.weapon || 'pistol';
  ped.kind = opts.kind || 'gangster';
  if (Number.isFinite(opts.health)) {
    ped.health = opts.health;
    ped.maxHealth = Math.max(fin(ped.maxHealth, 0), opts.health);
  }
  st.peds.push(ped);
  return ped;
}

/**
 * Removes a mission ped from the ped manager, whatever API it exposes.
 * @param {Object} game Game.
 * @param {Object} ped Ped record.
 * @returns {void}
 */
function removePed(game, ped) {
  const peds = game.peds;
  if (!peds || !ped) return;
  const methods = ['removePed', 'despawnPed', 'despawn', 'remove'];
  for (let i = 0; i < methods.length; i++) {
    const fn = peds[methods[i]];
    if (typeof fn === 'function') {
      try { fn.call(peds, ped); } catch (err) { /* fall through to the splice */ }
      break;
    }
  }
  const list = peds.peds;
  if (Array.isArray(list)) {
    const i = list.indexOf(ped);
    if (i >= 0) list.splice(i, 1);
  }
}

/**
 * Creates a mission world marker.
 * @param {Object} st Mission state.
 * @param {number} x World x.
 * @param {number} y World y.
 * @param {number} z World z.
 * @param {Object} [opts] `{radius, color, label, kind, scale}`.
 * @returns {Object} The marker record (already registered on the state).
 */
function addMarker(st, x, y, z, opts = {}) {
  const m = {
    x, y, z,
    radius: fin(opts.radius, 3),
    color: opts.color || [1, 0.78, 0.15],
    label: opts.label || '',
    kind: opts.kind || 'objective',
    scale: fin(opts.scale, 1),
    active: true,
  };
  st.markers.push(m);
  return m;
}

/**
 * Picks a point close to the road network, `min`..`max` metres from a centre.
 * @param {Object} game Game.
 * @param {Rand} rng Deterministic source.
 * @param {number} cx Centre x.
 * @param {number} cz Centre z.
 * @param {number} min Minimum radius.
 * @param {number} max Maximum radius.
 * @returns {{x:number, y:number, z:number}} World point.
 */
function roadPointNear(game, rng, cx, cz, min, max) {
  const out = { x: 0, z: 0, laneId: -1 };
  let bx = cx;
  let bz = cz;
  for (let attempt = 0; attempt < 8; attempt++) {
    const a = rng.next() * Math.PI * 2;
    const r = min + rng.next() * Math.max(1, max - min);
    let x = cx + Math.cos(a) * r;
    let z = cz + Math.sin(a) * r;
    if (typeof game.nearestRoadPoint === 'function') {
      try {
        const p = game.nearestRoadPoint(x, z, out);
        if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) { x = p.x; z = p.z; }
      } catch (err) { /* keep the raw point */ }
    }
    const bounds = game.city && game.city.bounds;
    if (bounds) {
      const pad = 12;
      if (x < bounds.min[0] + pad || x > bounds.max[0] - pad
        || z < bounds.min[1] + pad || z > bounds.max[1] - pad) continue;
    }
    bx = x;
    bz = z;
    if (dist2(bx, bz, cx, cz) >= min * 0.5) break;
  }
  return { x: bx, y: groundY(game, bx, bz), z: bz };
}

/**
 * Picks several well-separated road points around a centre.
 * @param {Object} game Game.
 * @param {Rand} rng Deterministic source.
 * @param {number} count How many points.
 * @param {number} cx Centre x.
 * @param {number} cz Centre z.
 * @param {number} min Minimum radius.
 * @param {number} max Maximum radius.
 * @param {number} [apart=40] Minimum separation between the results.
 * @returns {Array<{x:number, y:number, z:number}>} Points.
 */
function spreadPoints(game, rng, count, cx, cz, min, max, apart = 40) {
  const out = [];
  let guard = 0;
  while (out.length < count && guard < count * 14) {
    guard++;
    const p = roadPointNear(game, rng, cx, cz, min, max);
    let ok = true;
    for (let i = 0; i < out.length; i++) {
      if (dist2(p.x, p.z, out[i].x, out[i].z) < apart) { ok = false; break; }
    }
    if (ok) out.push(p);
  }
  // Never hand a mission fewer points than it asked for.
  while (out.length < count) {
    const a = (out.length / Math.max(1, count)) * Math.PI * 2;
    const r = (min + max) * 0.5;
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    out.push({ x, y: groundY(game, x, z), z });
  }
  return out;
}

/**
 * Sets the HUD waypoint, but only when it actually moved (avoids per-frame HUD churn).
 * @param {Object} game Game.
 * @param {Object} st Mission state.
 * @param {number} x World x.
 * @param {number} z World z.
 * @returns {void}
 */
function waypoint(game, st, x, z) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return;
  if (Number.isFinite(st.waypointX) && dist2(x, z, st.waypointX, st.waypointZ) < 3) return;
  st.waypointX = x;
  st.waypointZ = z;
  if (typeof game.setWaypoint === 'function') game.setWaypoint(x, z);
}

/**
 * Lets a hostile ped shoot at the player through the weapon system.
 * @param {Object} game Game.
 * @param {Object} ped Shooter.
 * @param {Object} slot Per-target bookkeeping `{fireTimer}`.
 * @param {number} dt Seconds.
 * @param {Object} [opts] `{weapon, range, spread, damageMul, rate}`.
 * @returns {void}
 */
function returnFire(game, ped, slot, dt, opts = {}) {
  const weapons = game.weapons;
  const player = game.player;
  if (!weapons || typeof weapons.tryFire !== 'function' || !player || player.dead) return;
  if (!entityPos(ped, _p) || !player.position || !Number.isFinite(player.position[0])) return;
  const range = fin(opts.range, 55);
  const d = Math.hypot(player.position[0] - _p[0], player.position[2] - _p[2]);
  if (d > range) { slot.fireTimer = Math.min(slot.fireTimer, 0.6); return; }
  slot.fireTimer -= dt;
  if (slot.fireTimer > 0) return;
  slot.fireTimer = fin(opts.rate, 0.95) * (0.7 + (ped.missionRate || 0.6));
  _muzzle[0] = _p[0];
  _muzzle[1] = _p[1] + 1.35;
  _muzzle[2] = _p[2];
  _dir[0] = player.position[0] - _muzzle[0];
  _dir[1] = player.position[1] + 1.0 - _muzzle[1];
  _dir[2] = player.position[2] - _muzzle[2];
  const l = Math.hypot(_dir[0], _dir[1], _dir[2]);
  if (!(l > 0.001)) return;
  _dir[0] /= l; _dir[1] /= l; _dir[2] /= l;
  weapons.tryFire(_muzzle, _dir, false, fin(opts.spread, 2.4), {
    weapon: opts.weapon || 'pistol',
    shooter: ped,
    damageMul: fin(opts.damageMul, 0.55),
  });
}

/**
 * Removes everything a mission created. Safe to call twice.
 * @param {Object} game Game.
 * @param {Object} st Mission state.
 * @returns {void}
 */
function releaseState(game, st) {
  if (!st) return;
  if (Array.isArray(st.vehicles)) {
    for (let i = 0; i < st.vehicles.length; i++) {
      const v = st.vehicles[i];
      if (!v) continue;
      try {
        if (typeof game.removeVehicle === 'function') game.removeVehicle(v);
        else if (Array.isArray(game.vehicles)) {
          const k = game.vehicles.indexOf(v);
          if (k >= 0) game.vehicles.splice(k, 1);
        }
      } catch (err) { /* already gone */ }
    }
    st.vehicles.length = 0;
  }
  if (Array.isArray(st.peds)) {
    for (let i = 0; i < st.peds.length; i++) removePed(game, st.peds[i]);
    st.peds.length = 0;
  }
  if (Array.isArray(st.pickups)) {
    for (let i = 0; i < st.pickups.length; i++) {
      const k = st.pickups[i];
      if (!k || !Array.isArray(game.pickups)) continue;
      const idx = game.pickups.indexOf(k);
      if (idx >= 0) game.pickups.splice(idx, 1);
    }
    st.pickups.length = 0;
  }
  if (Array.isArray(st.markers)) st.markers.length = 0;
  if (typeof game.clearWaypoint === 'function') game.clearWaypoint();
}

/* ------------------------------------------------------------------ *
 * The eight missions
 * ------------------------------------------------------------------ */

/**
 * Every mission definition. `setup` returns the mission state, `update` returns
 * `'running' | 'success' | 'fail'`, `cleanup` must leave the world exactly as it found it.
 * @type {Array<Object>}
 */
export const MISSIONS = [
  // ---------------------------------------------------------------- 1. delivery
  {
    id: 'delivery_run',
    name: 'Delivery Run',
    nameKo: '배달',
    brief: 'Three parcels, three deadlines. Do not scratch the van.',
    briefKo: '승합차를 몰고 세 곳에 시간 안에 배달하세요. 차가 부서지면 실패입니다.',
    giver: '토니',
    reward: 1800,
    wantedOnStart: 0,
    type: 'delivery',

    /**
     * @param {Object} game Game.
     * @returns {Object} Mission state.
     */
    setup(game) {
      const st = newState(game, 'delivery_run');
      const o = st.origin;
      const yaw = st.rng.range(0, Math.PI * 2);
      st.van = spawnVehicle(game, st, 'van', o.x + Math.cos(yaw) * 5, o.z + Math.sin(yaw) * 5, yaw,
        { color: [0.9, 0.75, 0.15] });
      st.drops = spreadPoints(game, st.rng, 3, o.x, o.z, 110, 320, 90);
      st.index = 0;
      st.phase = 'toVehicle';
      st.boardTime = 60;
      st.outTime = 0;
      st.timeLeft = legTime(o.x, o.z, st.drops[0]);
      st.marker = addMarker(st, st.drops[0].x, st.drops[0].y, st.drops[0].z,
        { radius: 8, color: [1, 0.8, 0.2], label: '배달 지점' });
      if (!st.van) {
        releaseState(game, st);
        return null;
      }
      st.vanMarker = addMarker(st, o.x, o.y, o.z,
        { radius: 3, color: [0.3, 0.9, 1], label: '배달 차량' });
      return st;
    },

    /**
     * @param {Object} game Game.
     * @param {Object} st Mission state.
     * @param {number} dt Seconds.
     * @returns {string} Mission status.
     */
    update(game, st, dt) {
      st.elapsed += dt;
      const player = game.player;
      if (!st.van || !vehicleAlive(game, st.van)) {
        st.failReason = '배달 차량이 파괴되었습니다.';
        return 'fail';
      }
      if (st.vanMarker) {
        st.vanMarker.x = st.van.position[0];
        st.vanMarker.y = st.van.position[1] + 1.4;
        st.vanMarker.z = st.van.position[2];
        st.vanMarker.active = st.phase === 'toVehicle';
      }

      if (st.phase === 'toVehicle') {
        st.boardTime -= dt;
        waypoint(game, st, st.van.position[0], st.van.position[2]);
        if (player && player.vehicle === st.van) {
          st.phase = 'drive';
          st.waypointX = NaN;
          if (typeof game.notify === 'function') game.notify('첫 번째 배달 지점으로!', 'mission', 3);
        } else if (st.boardTime <= 0) {
          st.failReason = '제 시간에 배달 차량에 타지 않았습니다.';
          return 'fail';
        }
        return 'running';
      }

      const drop = st.drops[st.index];
      if (!drop) return 'success';
      st.marker.x = drop.x;
      st.marker.y = drop.y;
      st.marker.z = drop.z;
      waypoint(game, st, drop.x, drop.z);

      if (!player || player.vehicle !== st.van) {
        st.outTime += dt;
        if (st.outTime > 15) {
          st.failReason = '배달 차량을 버렸습니다.';
          return 'fail';
        }
      } else {
        st.outTime = 0;
      }

      st.timeLeft -= dt;
      if (st.timeLeft <= 0) {
        st.failReason = '배달 시간이 초과되었습니다.';
        return 'fail';
      }

      const d = dist2(st.van.position[0], st.van.position[2], drop.x, drop.z);
      if (d < 9) {
        st.index++;
        if (game.sfx && game.sfx.pickup) game.sfx.pickup('money', st.van.position);
        if (game.particles && game.particles.burst) {
          game.particles.burst('flash', drop.x, drop.y + 1, drop.z, 6, { power: 1.2 });
        }
        if (st.index >= st.drops.length) {
          st.note = '배달 완료';
          return 'success';
        }
        const next = st.drops[st.index];
        st.timeLeft = legTime(st.van.position[0], st.van.position[2], next);
        st.waypointX = NaN;
        if (typeof game.notify === 'function') {
          game.notify(`배달 ${st.index}/${st.drops.length} 완료`, 'mission', 2.5);
        }
      }
      return 'running';
    },

    /**
     * @param {Object} game Game.
     * @param {Object} st Mission state.
     * @returns {void}
     */
    cleanup(game, st) { releaseState(game, st); },

    /**
     * @param {Object} st Mission state.
     * @returns {string} Korean objective line.
     */
    objectiveText(st) {
      const n = st.drops.length;
      if (st.phase === 'toVehicle') return `배달 차량에 탑승 (${clockText(st.boardTime)})`;
      return `배달 ${Math.min(st.index + 1, n)}/${n} · 남은 시간 ${clockText(st.timeLeft)}`;
    },
  },

  // ---------------------------------------------------------------- 2. street race
  {
    id: 'street_race',
    name: 'Street Race',
    nameKo: '스트리트 레이스',
    brief: 'Eight checkpoints, three rivals. Only first place pays.',
    briefKo: '체크포인트 8개를 돌아 3명의 라이벌보다 먼저 결승선을 통과하세요.',
    giver: '유나',
    reward: 3200,
    wantedOnStart: 0,
    type: 'race',

    /**
     * @param {Object} game Game.
     * @returns {Object} Mission state.
     */
    setup(game) {
      const st = newState(game, 'street_race');
      const o = st.origin;
      const radius = 140;
      st.checkpoints = [];
      const phase = st.rng.range(0, Math.PI * 2);
      for (let i = 0; i < 8; i++) {
        const a = phase + (i / 8) * Math.PI * 2;
        const r = radius * (0.78 + ((i % 3) * 0.12));
        const x = o.x + Math.cos(a) * r;
        const z = o.z + Math.sin(a) * r;
        let px = x;
        let pz = z;
        if (typeof game.nearestRoadPoint === 'function') {
          const out = { x: 0, z: 0, laneId: -1 };
          try {
            const p = game.nearestRoadPoint(x, z, out);
            if (p && Number.isFinite(p.x)) { px = p.x; pz = p.z; }
          } catch (err) { /* keep the ring point */ }
        }
        st.checkpoints.push({ x: px, y: groundY(game, px, pz), z: pz });
      }
      st.marker = addMarker(st, st.checkpoints[0].x, st.checkpoints[0].y, st.checkpoints[0].z,
        { radius: 10, color: [0.3, 1, 0.6], label: '체크포인트' });

      // Player's car (only spawned when they arrive on foot).
      st.playerCar = null;
      if (!game.player || !game.player.vehicle) {
        st.playerCar = spawnVehicle(game, st, 'sports', o.x + 4, o.z + 4,
          st.rng.range(0, Math.PI * 2), { color: [0.9, 0.15, 0.35] });
      }

      // Three rivals lined up beside the start.
      st.racers = [];
      const kinds = ['sports', 'muscle', 'sports'];
      const names = ['레드', '블레이즈', '고스트'];
      for (let i = 0; i < 3; i++) {
        const v = spawnVehicle(game, st, kinds[i], o.x - 4 - i * 3.6, o.z + 4, 0,
          { color: [0.2 + i * 0.3, 0.4, 0.9 - i * 0.25] });
        if (!v) continue;
        v.driver = { missionAI: true, character: null };
        st.racers.push({
          vehicle: v, name: names[i], cp: 0, done: false, finish: 0,
          skill: 17 + st.rng.range(0, 6) + i * 0.8, ai: newDriver(),
        });
      }
      if (!st.playerCar && !(game.player && game.player.vehicle)) {
        releaseState(game, st);
        return null;
      }
      st.cp = 0;
      st.place = 1;
      st.phase = game.player && game.player.vehicle ? 'race' : 'toCar';
      st.boardTime = 45;
      st.raceTime = 0;
      st.raceLimit = 420;
      // `timeLeft` is the field ui/hud.js reads for the mission countdown.
      st.timeLeft = st.raceLimit;
      st.finished = 0;
      return st;
    },

    /**
     * @param {Object} game Game.
     * @param {Object} st Mission state.
     * @param {number} dt Seconds.
     * @returns {string} Mission status.
     */
    update(game, st, dt) {
      st.elapsed += dt;
      const player = game.player;
      if (st.phase === 'toCar') {
        st.boardTime -= dt;
        st.timeLeft = st.boardTime;
        if (st.playerCar && vehicleAlive(game, st.playerCar)) {
          waypoint(game, st, st.playerCar.position[0], st.playerCar.position[2]);
        }
        if (player && player.vehicle) {
          st.phase = 'race';
          st.waypointX = NaN;
          st.timeLeft = st.raceLimit;
          if (typeof game.notify === 'function') game.notify('출발!', 'mission', 2);
        } else if (st.boardTime <= 0) {
          st.failReason = '차량에 탑승하지 않았습니다.';
          return 'fail';
        }
        return 'running';
      }

      st.raceTime += dt;
      st.timeLeft = Math.max(0, st.raceLimit - st.raceTime);
      if (st.raceTime > st.raceLimit) {
        st.failReason = '제한 시간을 초과했습니다.';
        return 'fail';
      }

      // --- rivals ------------------------------------------------------------------------
      for (let i = 0; i < st.racers.length; i++) {
        const r = st.racers[i];
        if (r.done) continue;
        if (!vehicleAlive(game, r.vehicle)) { r.done = true; r.cp = -1; continue; }
        const target = st.checkpoints[Math.min(r.cp, st.checkpoints.length - 1)];
        const d = driveTowards(r.vehicle, target.x, target.z, r.skill, r.ai, dt);
        if (d < 13) {
          r.cp++;
          if (r.cp >= st.checkpoints.length) {
            r.done = true;
            st.finished++;
            r.finish = st.finished;
          }
        }
      }

      // --- player ------------------------------------------------------------------------
      const car = player ? player.vehicle : null;
      if (!car) {
        st.onFoot = fin(st.onFoot, 0) + dt;
        if (st.onFoot > 25) {
          st.failReason = '차량 없이 레이스를 이어갈 수 없습니다.';
          return 'fail';
        }
      } else {
        st.onFoot = 0;
      }
      const px = car ? car.position[0] : (player ? player.position[0] : 0);
      const pz = car ? car.position[2] : (player ? player.position[2] : 0);
      const cp = st.checkpoints[Math.min(st.cp, st.checkpoints.length - 1)];
      st.marker.x = cp.x;
      st.marker.y = cp.y;
      st.marker.z = cp.z;
      waypoint(game, st, cp.x, cp.z);
      const pd = dist2(px, pz, cp.x, cp.z);
      if (pd < 13) {
        st.cp++;
        st.waypointX = NaN;
        if (game.sfx && game.sfx.pickup) game.sfx.pickup('ammo', car ? car.position : null);
        if (st.cp >= st.checkpoints.length) {
          st.finished++;
          st.place = st.finished;
          if (st.place === 1) {
            st.note = '1위 완주';
            return 'success';
          }
          st.failReason = `${st.place}위로 완주했습니다. 1위만 인정됩니다.`;
          return 'fail';
        }
      }

      // --- live position -----------------------------------------------------------------
      let ahead = 1;
      for (let i = 0; i < st.racers.length; i++) {
        const r = st.racers[i];
        if (r.cp < 0) continue;
        if (r.cp > st.cp) { ahead++; continue; }
        if (r.cp === st.cp && vehicleAlive(game, r.vehicle)) {
          const rd = dist2(r.vehicle.position[0], r.vehicle.position[2], cp.x, cp.z);
          if (rd < pd) ahead++;
        }
      }
      st.place = ahead;
      return 'running';
    },

    /**
     * @param {Object} game Game.
     * @param {Object} st Mission state.
     * @returns {void}
     */
    cleanup(game, st) { releaseState(game, st); },

    /**
     * @param {Object} st Mission state.
     * @returns {string} Korean objective line.
     */
    objectiveText(st) {
      if (st.phase === 'toCar') return `경주용 차량에 탑승 (${clockText(st.boardTime)})`;
      const total = st.checkpoints.length;
      const field = st.racers.length + 1;
      return `체크포인트 ${Math.min(st.cp + 1, total)}/${total} · 순위 ${Math.min(st.place, field)}/${field}`;
    },
  },

  // ---------------------------------------------------------------- 3. hit list
  {
    id: 'hit_list',
    name: 'Hit List',
    nameKo: '청부',
    brief: 'Three names, one night. They are armed.',
    briefKo: '표적 3명을 제거하세요. 무장하고 있으니 조심하세요.',
    giver: '미스터 강',
    reward: 4000,
    wantedOnStart: 2,
    type: 'assassinate',

    /**
     * @param {Object} game Game.
     * @returns {Object} Mission state.
     */
    setup(game) {
      const st = newState(game, 'hit_list');
      const o = st.origin;
      const spots = spreadPoints(game, st.rng, 3, o.x, o.z, 45, 150, 35);
      st.targets = [];
      const names = ['빅토르', '샤오', '데스몬드'];
      for (let i = 0; i < spots.length; i++) {
        const s = spots[i];
        const ped = spawnHostilePed(game, st, s.x, s.z, {
          weapon: 'pistol', health: 130, kind: 'gangster', yaw: st.rng.range(0, Math.PI * 2),
        });
        const marker = addMarker(st, s.x, s.y + 2.2, s.z,
          { radius: 2, color: [1, 0.2, 0.3], label: names[i], kind: 'target' });
        st.targets.push({
          ped, name: names[i], anchor: s, marker, dead: !ped, respawns: 0,
          fireTimer: st.rng.range(0.8, 2.4),
        });
        if (ped) ped.missionRate = st.rng.range(0.4, 1.1);
      }
      st.killed = 0;
      st.timeLeft = 300;
      st.nearX = o.x;
      st.nearZ = o.z;
      if (!st.targets.some((t) => t.ped)) {
        // No ped manager / no room to spawn: refuse the contract instead of auto-completing.
        releaseState(game, st);
        return null;
      }
      return st;
    },

    /**
     * @param {Object} game Game.
     * @param {Object} st Mission state.
     * @param {number} dt Seconds.
     * @returns {string} Mission status.
     */
    update(game, st, dt) {
      st.elapsed += dt;
      st.timeLeft -= dt;
      if (st.timeLeft <= 0) {
        st.failReason = '표적을 모두 제거하지 못했습니다.';
        return 'fail';
      }
      const player = game.player;
      let alive = 0;
      let haveNearest = false;
      let nearestD = Infinity;

      for (let i = 0; i < st.targets.length; i++) {
        const t = st.targets[i];
        if (t.dead) { if (t.marker) t.marker.active = false; continue; }
        if (t.ped && pedVanished(game, t.ped) && t.respawns < 2) {
          // The ped manager recycled our target: put it back at its anchor.
          t.respawns++;
          const idx = st.peds.indexOf(t.ped);
          if (idx >= 0) st.peds.splice(idx, 1);
          t.ped = spawnHostilePed(game, st, t.anchor.x, t.anchor.z,
            { weapon: 'pistol', health: 130, kind: 'gangster' });
        }
        if (!t.ped || !pedAlive(game, t.ped)) {
          t.dead = true;
          st.killed++;
          if (t.marker) t.marker.active = false;
          if (typeof game.notify === 'function') {
            game.notify(`${t.name} 제거 (${st.killed}/${st.targets.length})`, 'mission', 3);
          }
          continue;
        }
        alive++;
        if (entityPos(t.ped, _q)) {
          if (t.marker) { t.marker.x = _q[0]; t.marker.y = _q[1] + 2.2; t.marker.z = _q[2]; }
          if (player && player.position) {
            const d = dist2(player.position[0], player.position[2], _q[0], _q[2]);
            if (d < nearestD) { nearestD = d; haveNearest = true; st.nearX = _q[0]; st.nearZ = _q[2]; }
          }
        }
        returnFire(game, t.ped, t, dt, { weapon: 'pistol', range: 48, spread: 2.6, damageMul: 0.5 });
      }

      if (haveNearest) waypoint(game, st, st.nearX, st.nearZ);
      if (alive === 0) {
        st.note = '표적 전원 제거';
        return 'success';
      }
      return 'running';
    },

    /**
     * @param {Object} game Game.
     * @param {Object} st Mission state.
     * @returns {void}
     */
    cleanup(game, st) { releaseState(game, st); },

    /**
     * @param {Object} st Mission state.
     * @returns {string} Korean objective line.
     */
    objectiveText(st) {
      return `표적 제거 ${st.killed}/${st.targets.length} · ${clockText(st.timeLeft)}`;
    },
  },

  // ---------------------------------------------------------------- 4. rampage
  {
    id: 'rampage',
    name: 'Rampage',
    nameKo: '광란',
    brief: 'Ninety seconds. One SMG. Make it count.',
    briefKo: '90초 안에 기관단총으로 목표 수만큼 처치하세요. 경찰이 몰려옵니다.',
    giver: '익명',
    reward: 2600,
    wantedOnStart: 0,
    type: 'rampage',

    /**
     * @param {Object} game Game.
     * @returns {Object} Mission state.
     */
    setup(game) {
      const st = newState(game, 'rampage');
      st.target = 18;
      st.kills = 0;
      /** Kills reported through the `pedKilled` event. */
      st.eventKills = 0;
      /** `player.kills` when the rampage began — the contract's own kill counter. */
      st.killBase = game.player ? fin(game.player.kills, 0) : 0;
      st.timeLeft = 90;
      st.wantedStep = 0;
      st.prevWeapon = game.weapons ? game.weapons.current : null;
      if (game.weapons && typeof game.weapons.giveWeapon === 'function') {
        game.weapons.giveWeapon('smg', 300);
        if (typeof game.weapons.switchTo === 'function') game.weapons.switchTo('smg');
      }
      if (typeof game.notify === 'function') game.notify('기관단총 지급', 'info', 3);
      return st;
    },

    /**
     * Counts every kill the player scores while the rampage runs.
     * @param {Object} game Game.
     * @param {Object} st Mission state.
     * @param {string} event Event name.
     * @param {Object} payload Event payload.
     * @returns {void}
     */
    onEvent(game, st, event, payload) {
      if (event !== 'pedKilled') return;
      if (payload && payload.byPlayer === false) return;
      st.eventKills++;
      if (game.particles && game.particles.burst && payload && Number.isFinite(payload.x)) {
        game.particles.burst('flash', payload.x, fin(payload.y, 1) + 1.6, payload.z, 3, { power: 0.8 });
      }
    },

    /**
     * @param {Object} game Game.
     * @param {Object} st Mission state.
     * @param {number} dt Seconds.
     * @returns {string} Mission status.
     */
    update(game, st, dt) {
      st.elapsed += dt;
      st.timeLeft -= dt;
      // Two independent sources so the counter still works whichever one the ped manager feeds:
      // the `pedKilled` event and the contract's own `player.kills` tally.
      const tallied = game.player ? Math.max(0, fin(game.player.kills, 0) - st.killBase) : 0;
      const kills = Math.max(st.eventKills, tallied);
      if (kills !== st.kills) {
        st.kills = kills;
        const level = Math.floor(st.kills / 5);
        if (level > st.wantedStep) {
          st.wantedStep = level;
          if (game.police && typeof game.police.addWanted === 'function') {
            game.police.addWanted(1, 'rampage');
          }
        }
      }
      if (st.kills >= st.target) {
        st.note = `${st.kills}명 처치`;
        return 'success';
      }
      if (st.timeLeft <= 0) {
        st.failReason = `시간 초과 (${st.kills}/${st.target})`;
        return 'fail';
      }
      // Keep the player supplied so the rampage never stalls on ammo.
      if (game.weapons && typeof game.weapons.addAmmo === 'function') {
        st.ammoTimer = fin(st.ammoTimer, 0) - dt;
        if (st.ammoTimer <= 0) {
          st.ammoTimer = 12;
          game.weapons.addAmmo('smg', 60);
        }
      }
      return 'running';
    },

    /**
     * @param {Object} game Game.
     * @param {Object} st Mission state.
     * @returns {void}
     */
    cleanup(game, st) {
      releaseState(game, st);
      if (st.prevWeapon && game.weapons && typeof game.weapons.switchTo === 'function') {
        game.weapons.switchTo(st.prevWeapon);
      }
    },

    /**
     * @param {Object} st Mission state.
     * @returns {string} Korean objective line.
     */
    objectiveText(st) {
      return `처치 ${st.kills}/${st.target} · 남은 시간 ${clockText(st.timeLeft)}`;
    },
  },

  // ---------------------------------------------------------------- 5. getaway
  {
    id: 'getaway',
    name: 'Getaway',
    nameKo: '도주',
    brief: 'Three stars on your back. Lose them.',
    briefKo: '수배 3성으로 시작합니다. 3분 안에 경찰을 완전히 따돌리세요.',
    giver: '무전',
    reward: 3000,
    wantedOnStart: 3,
    type: 'chase',

    /**
     * @param {Object} game Game.
     * @returns {Object} Mission state.
     */
    setup(game) {
      // Losing the cops is the whole mission: without a police system there is nothing to lose,
      // and "wanted === 0" would hand out the reward on the first frame.
      if (!game.police || typeof game.police.addWanted !== 'function') return null;
      const st = newState(game, 'getaway');
      const o = st.origin;
      st.timeLeft = 180;
      /** Set once the stars have actually appeared; success is impossible before that. */
      st.armed = false;
      /** Seconds spent waiting for `wantedOnStart` to register. */
      st.armTimer = 0;
      st.car = null;
      if (!game.player || !game.player.vehicle) {
        const yaw = st.rng.range(0, Math.PI * 2);
        st.car = spawnVehicle(game, st, 'muscle', o.x + Math.cos(yaw) * 5.5, o.z + Math.sin(yaw) * 5.5,
          yaw, { color: [0.1, 0.1, 0.12] });
        if (st.car) {
          st.marker = addMarker(st, st.car.position[0], st.car.position[1] + 1.4, st.car.position[2],
            { radius: 3, color: [0.3, 0.9, 1], label: '도주 차량' });
        }
      }
      st.clearTimer = 0;
      return st;
    },

    /**
     * @param {Object} game Game.
     * @param {Object} st Mission state.
     * @param {number} dt Seconds.
     * @returns {string} Mission status.
     */
    update(game, st, dt) {
      st.elapsed += dt;
      st.timeLeft -= dt;
      const wanted = game.police ? fin(game.police.wanted, 0) : 0;
      st.wanted = wanted;
      if (st.car && st.marker) {
        if (vehicleAlive(game, st.car)) {
          st.marker.x = st.car.position[0];
          st.marker.y = st.car.position[1] + 1.4;
          st.marker.z = st.car.position[2];
          st.marker.active = !(game.player && game.player.vehicle === st.car);
        } else {
          st.marker.active = false;
        }
      }
      if (!st.armed) {
        // Wait for the wanted level the manager applied on start to show up before the
        // "no stars left" test can pass, otherwise the mission would win itself instantly.
        st.armTimer += dt;
        if (wanted > 0) st.armed = true;
        else if (st.armTimer > 6) {
          st.failReason = '수배가 발생하지 않았습니다.';
          return 'fail';
        }
        if (st.timeLeft <= 0) {
          st.failReason = '3분 안에 경찰을 따돌리지 못했습니다.';
          return 'fail';
        }
        return 'running';
      }
      if (wanted <= 0) {
        st.clearTimer += dt;
        if (st.clearTimer > 1.5) {
          st.note = '경찰 따돌리기 성공';
          return 'success';
        }
      } else {
        st.clearTimer = 0;
      }
      if (st.timeLeft <= 0) {
        st.failReason = '3분 안에 경찰을 따돌리지 못했습니다.';
        return 'fail';
      }
      return 'running';
    },

    /**
     * @param {Object} game Game.
     * @param {Object} st Mission state.
     * @returns {void}
     */
    cleanup(game, st) { releaseState(game, st); },

    /**
     * @param {Object} st Mission state.
     * @returns {string} Korean objective line.
     */
    objectiveText(st) {
      const stars = '★'.repeat(clamp(Math.round(fin(st.wanted, 0)), 0, 5));
      return `경찰 따돌리기 ${stars || '—'} · ${clockText(st.timeLeft)}`;
    },
  },

  // ---------------------------------------------------------------- 6. protect
  {
    id: 'protect',
    name: 'Escort',
    nameKo: '호위',
    brief: 'Keep the client alive all the way across town.',
    briefKo: '의뢰인의 차량을 목적지까지 호위하세요. 습격자들이 따라붙습니다.',
    giver: '세라',
    reward: 3600,
    wantedOnStart: 0,
    type: 'chase',

    /**
     * @param {Object} game Game.
     * @returns {Object} Mission state.
     */
    setup(game) {
      const st = newState(game, 'protect');
      const o = st.origin;
      const yaw = st.rng.range(0, Math.PI * 2);
      st.vip = spawnVehicle(game, st, 'sedan', o.x + Math.cos(yaw) * 6, o.z + Math.sin(yaw) * 6, yaw,
        { color: [0.08, 0.09, 0.14] });
      if (!st.vip) {
        releaseState(game, st);
        return null;
      }
      st.vip.driver = { missionAI: true, character: null };
      st.vipAi = newDriver();
      st.destination = roadPointNear(game, st.rng, o.x, o.z, 260, 420);
      // Follow the road network instead of ploughing straight through the city blocks.
      st.route = buildRoute(game, st.vip.position[0], st.vip.position[2], st.destination);
      st.marker = addMarker(st, st.destination.x, st.destination.y, st.destination.z,
        { radius: 9, color: [0.3, 1, 0.5], label: '목적지' });
      st.vipMarker = addMarker(st, o.x, o.y + 2, o.z,
        { radius: 2, color: [0.3, 0.8, 1], label: '의뢰인', kind: 'target' });
      st.attackers = [];
      st.spawnTimer = 18;
      st.wave = 0;
      st.timeLeft = 360;
      st.remaining = dist2(st.vip.position[0], st.vip.position[2], st.destination.x, st.destination.z);
      st.vipHealth = 1;
      return st;
    },

    /**
     * @param {Object} game Game.
     * @param {Object} st Mission state.
     * @param {number} dt Seconds.
     * @returns {string} Mission status.
     */
    update(game, st, dt) {
      st.elapsed += dt;
      st.timeLeft -= dt;
      if (st.timeLeft <= 0) {
        st.failReason = '호위 시간이 초과되었습니다.';
        return 'fail';
      }
      if (!st.vip || !vehicleAlive(game, st.vip)) {
        st.failReason = '의뢰인의 차량이 파괴되었습니다.';
        return 'fail';
      }
      const vx = st.vip.position[0];
      const vz = st.vip.position[2];
      st.vipMarker.x = vx;
      st.vipMarker.y = st.vip.position[1] + 2.1;
      st.vipMarker.z = vz;
      // Vehicle health is an absolute pool (1000 by default), so publish a fraction, not the raw
      // number — the objective line renders it as a percentage.
      const maxHp = Math.max(1, fin(st.vip.maxHealth, 1000));
      st.vipHealth = clamp(fin(st.vip.health, maxHp) / maxHp, 0, 1);

      const remaining = driveRoute(st.vip, st.route, st.vipAi, 19, dt);
      st.remaining = remaining;
      waypoint(game, st, st.destination.x, st.destination.z);
      if (remaining < 12) {
        st.note = '의뢰인 무사 도착';
        return 'success';
      }

      // --- attacker waves ------------------------------------------------------------------
      st.spawnTimer -= dt;
      if (st.spawnTimer <= 0 && st.attackers.length < 3) {
        st.spawnTimer = 26;
        st.wave++;
        const a = st.rng.range(0, Math.PI * 2);
        const sx = vx + Math.cos(a) * 70;
        const sz = vz + Math.sin(a) * 70;
        const v = spawnVehicle(game, st, 'muscle', sx, sz, a, { color: [0.35, 0.05, 0.08] });
        if (v) {
          v.driver = { missionAI: true, character: null };
          const ai = newDriver();
          ai.fireTimer = st.rng.range(1, 3);
          st.attackers.push({ vehicle: v, ai, fireTimer: ai.fireTimer });
          if (typeof game.notify === 'function') game.notify('습격자 접근!', 'warn', 3);
          if (game.sfx && game.sfx.notify) game.sfx.notify('warn');
        }
      }

      for (let i = st.attackers.length - 1; i >= 0; i--) {
        const at = st.attackers[i];
        if (!vehicleAlive(game, at.vehicle)) {
          const k = st.vehicles.indexOf(at.vehicle);
          if (k >= 0) st.vehicles.splice(k, 1);
          if (at.vehicle && typeof game.removeVehicle === 'function') {
            try { game.removeVehicle(at.vehicle); } catch (err) { /* already removed */ }
          }
          st.attackers.splice(i, 1);
          continue;
        }
        driveTowards(at.vehicle, vx, vz, 24, at.ai, dt);
        // The gunman leans out and fires at the player, not at the client.
        driveByFire(game, at.vehicle, at.ai, dt,
          { weapon: 'smg', range: 45, rate: 0.55, spread: 3.2, damageMul: 0.35 });
        at.fireTimer = at.ai.fireTimer;
      }
      return 'running';
    },

    /**
     * @param {Object} game Game.
     * @param {Object} st Mission state.
     * @returns {void}
     */
    cleanup(game, st) {
      if (Array.isArray(st.attackers)) st.attackers.length = 0;
      releaseState(game, st);
    },

    /**
     * @param {Object} st Mission state.
     * @returns {string} Korean objective line.
     */
    objectiveText(st) {
      // Quantised to 10 m: the HUD rebuilds its objective list whenever this string changes, so a
      // metre-accurate readout would rewrite the DOM on every single frame while driving.
      const d = Math.max(0, Math.round(fin(st.remaining, 0) / 10) * 10);
      const hp = clamp(Math.round(fin(st.vipHealth, 1) * 100), 0, 100);
      return `의뢰인 호위 · 남은 거리 ${d}m · 차량 상태 ${hp}%`;
    },
  },

  // ---------------------------------------------------------------- 7. collect
  {
    id: 'collect',
    name: 'Package Run',
    nameKo: '수집',
    brief: 'Twelve packages dropped across the city. Clock is ticking.',
    briefKo: '도시에 흩어진 12개의 화물을 제한 시간 안에 모두 회수하세요.',
    giver: '부두 관리인',
    reward: 2400,
    wantedOnStart: 0,
    type: 'collect',

    /**
     * @param {Object} game Game.
     * @returns {Object} Mission state.
     */
    setup(game) {
      const st = newState(game, 'collect');
      const o = st.origin;
      const pts = spreadPoints(game, st.rng, 12, o.x, o.z, 40, 340, 28);
      st.packages = [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const marker = addMarker(st, p.x, p.y + 0.9, p.z,
          { radius: 2.6, color: [0.2, 1, 0.75], label: '화물', kind: 'pickup', scale: 0.55 });
        st.packages.push({ x: p.x, y: p.y, z: p.z, taken: false, marker });
      }
      st.collected = 0;
      st.timeLeft = 220;
      return st;
    },

    /**
     * @param {Object} game Game.
     * @param {Object} st Mission state.
     * @param {number} dt Seconds.
     * @returns {string} Mission status.
     */
    update(game, st, dt) {
      st.elapsed += dt;
      st.timeLeft -= dt;
      if (st.timeLeft <= 0) {
        st.failReason = `화물 ${st.collected}/${st.packages.length}개만 회수했습니다.`;
        return 'fail';
      }
      const player = game.player;
      if (!player || !player.position) return 'running';
      const px = player.position[0];
      const py = player.position[1];
      const pz = player.position[2];
      let nearest = -1;
      let nearestD = Infinity;
      for (let i = 0; i < st.packages.length; i++) {
        const pk = st.packages[i];
        if (pk.taken) continue;
        const dx = pk.x - px;
        const dz = pk.z - pz;
        const dy = pk.y - py;
        const d2 = dx * dx + dz * dz;
        if (d2 < 9 && Math.abs(dy) < 3.5) {
          pk.taken = true;
          pk.marker.active = false;
          st.collected++;
          if (game.sfx && game.sfx.pickup) game.sfx.pickup('money', player.position);
          if (game.particles && game.particles.burst) {
            game.particles.burst('flash', pk.x, pk.y + 0.6, pk.z, 6, { power: 1 });
          }
          if (typeof game.notify === 'function') {
            game.notify(`화물 ${st.collected}/${st.packages.length}`, 'money', 2);
          }
          st.waypointX = NaN;
          continue;
        }
        if (d2 < nearestD) { nearestD = d2; nearest = i; }
      }
      if (st.collected >= st.packages.length) {
        st.note = '화물 전량 회수';
        return 'success';
      }
      if (nearest >= 0) waypoint(game, st, st.packages[nearest].x, st.packages[nearest].z);
      return 'running';
    },

    /**
     * @param {Object} game Game.
     * @param {Object} st Mission state.
     * @returns {void}
     */
    cleanup(game, st) { releaseState(game, st); },

    /**
     * @param {Object} st Mission state.
     * @returns {string} Korean objective line.
     */
    objectiveText(st) {
      return `화물 회수 ${st.collected}/${st.packages.length} · ${clockText(st.timeLeft)}`;
    },
  },

  // ---------------------------------------------------------------- 8. survive
  {
    id: 'survive',
    name: 'Last Stand',
    nameKo: '최후의 저항',
    brief: 'Four minutes against everything the city can send.',
    briefKo: '4분 동안 밀려오는 경찰의 파상 공세를 버텨내세요.',
    giver: '무전',
    reward: 5000,
    wantedOnStart: 2,
    type: 'survive',

    /**
     * @param {Object} game Game.
     * @returns {Object} Mission state.
     */
    setup(game) {
      const st = newState(game, 'survive');
      st.timeLeft = 240;
      st.wave = 0;
      st.waveTimer = 8;
      st.cars = [];
      if (game.weapons) {
        if (typeof game.weapons.giveWeapon === 'function') game.weapons.giveWeapon('rifle', 180);
        if (typeof game.weapons.switchTo === 'function') game.weapons.switchTo('rifle');
      }
      if (game.player && typeof game.player.addArmor === 'function') game.player.addArmor(50);
      return st;
    },

    /**
     * @param {Object} game Game.
     * @param {Object} st Mission state.
     * @param {number} dt Seconds.
     * @returns {string} Mission status.
     */
    update(game, st, dt) {
      st.elapsed += dt;
      st.timeLeft -= dt;
      if (st.timeLeft <= 0) {
        st.note = '4분 생존';
        return 'success';
      }
      const player = game.player;
      if (!player || !player.position) return 'running';
      const px = player.position[0];
      const pz = player.position[2];

      st.waveTimer -= dt;
      if (st.waveTimer <= 0) {
        st.wave++;
        st.waveTimer = 40;
        if (game.police && typeof game.police.addWanted === 'function') {
          game.police.addWanted(1, 'survive');
        }
        const count = Math.min(2, 1 + Math.floor(st.wave / 2));
        for (let i = 0; i < count; i++) {
          const a = st.rng.range(0, Math.PI * 2);
          const sx = px + Math.cos(a) * 85;
          const sz = pz + Math.sin(a) * 85;
          const v = spawnVehicle(game, st, 'police', sx, sz, a, { isPolice: true });
          if (!v) continue;
          v.driver = { missionAI: true, character: null };
          if (typeof v.setLights === 'function') {
            try { v.setLights(true, false, false, true); } catch (err) { /* no siren rig */ }
          }
          const ai = newDriver();
          ai.fireTimer = st.rng.range(1.5, 3.5);
          st.cars.push({ vehicle: v, ai, fireTimer: ai.fireTimer });
        }
        if (game.weapons && typeof game.weapons.addAmmo === 'function') game.weapons.addAmmo('rifle', 120);
        if (typeof game.notify === 'function') game.notify(`${st.wave}차 공세!`, 'warn', 3);
        if (game.sfx && game.sfx.wanted) game.sfx.wanted(Math.min(5, st.wave + 1));
      }

      for (let i = st.cars.length - 1; i >= 0; i--) {
        const c = st.cars[i];
        if (!vehicleAlive(game, c.vehicle)) {
          const k = st.vehicles.indexOf(c.vehicle);
          if (k >= 0) st.vehicles.splice(k, 1);
          if (c.vehicle && typeof game.removeVehicle === 'function') {
            try { game.removeVehicle(c.vehicle); } catch (err) { /* already removed */ }
          }
          st.cars.splice(i, 1);
          continue;
        }
        driveTowards(c.vehicle, px, pz, 21, c.ai, dt);
        driveByFire(game, c.vehicle, c.ai, dt,
          { weapon: 'pistol', range: 40, rate: 0.85, spread: 2.8, damageMul: 0.4 });
        c.fireTimer = c.ai.fireTimer;
      }
      return 'running';
    },

    /**
     * @param {Object} game Game.
     * @param {Object} st Mission state.
     * @returns {void}
     */
    cleanup(game, st) {
      if (Array.isArray(st.cars)) st.cars.length = 0;
      releaseState(game, st);
    },

    /**
     * @param {Object} st Mission state.
     * @returns {string} Korean objective line.
     */
    objectiveText(st) {
      return `생존 · ${clockText(st.timeLeft)} 남음 · ${st.wave}차 공세`;
    },
  },
];

/**
 * Time budget for one delivery leg: distance at a sane city speed plus slack.
 * @param {number} fromX Start x.
 * @param {number} fromZ Start z.
 * @param {{x:number, z:number}} to Destination.
 * @returns {number} Seconds.
 */
function legTime(fromX, fromZ, to) {
  const d = dist2(fromX, fromZ, to.x, to.z);
  return clamp(d / 11 + 22, 35, 150);
}

/** Fast id -> definition lookup. @type {Record<string, Object>} */
const MISSION_BY_ID = (() => {
  /** @type {Record<string, Object>} */
  const map = {};
  for (const m of MISSIONS) map[m.id] = m;
  return map;
})();

/* ------------------------------------------------------------------ *
 * MissionManager
 * ------------------------------------------------------------------ */

const _mm = new Float32Array(16);

/**
 * Seconds the current cooldown tick should subtract. Module scope so {@link tickCooldown} can be
 * a shared function instead of a closure allocated every frame.
 * @type {number}
 */
let _cdStep = 0;

/**
 * `Map#forEach` callback that ages one replay cooldown.
 * @param {number} value Seconds left.
 * @param {string} key Mission id.
 * @param {Map<string, number>} map Owning map.
 * @returns {void}
 */
function tickCooldown(value, key, map) {
  const left = value - _cdStep;
  if (left <= 0) map.delete(key);
  else map.set(key, left);
}

export class MissionManager {
  /**
   * @param {Object} game The `Game` instance (contract section 16).
   */
  constructor(game) {
    this.game = game;
    /** Active mission `{id, def, state}` or null. @type {Object|null} */
    this.active = null;
    /** Ids of missions the player finished. @type {Set<string>} */
    this.completed = new Set();
    /** Start markers placed at `city.spawns.missionPoints`. @type {Object[]} */
    this.markers = [];
    /** Per-mission replay cooldowns in seconds. @type {Map<string, number>} */
    this.cooldowns = new Map();
    /** How many missions have been started this session (RNG salt). @type {number} */
    this.runCount = 0;
    /** Position of the marker the active mission was started from. @type {{x:number,y:number,z:number}|null} */
    this.origin = null;
    /** Seconds left of the pre-mission countdown. @type {number} */
    this.countdown = 0;

    this._lastObjective = '';
    this._objectiveTimer = 0;
    this._promptTimer = 0;
    this._promptId = '';
    this._unsub = [];
    this._meshes = null;
    this._meshFailed = false;
    this._time = 0;
    /** Set while {@link MissionManager#dispose} tears down: no banners, no toasts. */
    this._silent = false;

    this._buildMarkers();
    this._subscribe();
  }

  /**
   * Places one yellow marker per mission point in the city.
   * @private
   */
  _buildMarkers() {
    const game = this.game;
    const pts = game && game.city && game.city.spawns ? game.city.spawns.missionPoints : null;
    if (!Array.isArray(pts) || !pts.length) return;
    for (let i = 0; i < pts.length && i < MISSIONS.length * 3; i++) {
      const p = pts[i];
      const def = MISSIONS[i % MISSIONS.length];
      const x = fin(p.x, 0);
      const z = fin(p.z, 0);
      this.markers.push({
        missionId: def.id,
        // `nameKo` is what ui/map.js and the HUD radar label a blip with; `name` keeps the
        // city's own name for the place the mission is given from.
        nameKo: def.nameKo,
        name: p.name || def.nameKo,
        reward: def.reward,
        x,
        y: Number.isFinite(p.y) ? p.y : groundY(game, x, z),
        z,
        radius: MARKER_RADIUS,
        color: [1, 0.78, 0.12],
        dwell: 0,
        inside: false,
      });
    }
  }

  /**
   * Routes game events into the active mission.
   * @private
   */
  _subscribe() {
    const game = this.game;
    if (!game || typeof game.on !== 'function') return;
    const events = ['pedKilled', 'vehicleDestroyed', 'playerDied', 'explosion', 'wantedChanged'];
    for (const name of events) {
      this._unsub.push(game.on(name, (payload) => this._onEvent(name, payload)));
    }
  }

  /**
   * @param {string} name Event name.
   * @param {Object} payload Event payload.
   * @private
   */
  _onEvent(name, payload) {
    if (!this.active) return;
    if (name === 'playerDied') {
      this.fail('사망했습니다.');
      return;
    }
    const def = this.active.def;
    if (typeof def.onEvent !== 'function') return;
    try {
      def.onEvent(this.game, this.active.state, name, payload || {});
    } catch (err) {
      console.warn(`[missions] ${def.id} onEvent(${name}) threw`, err);
    }
  }

  // ================================================================ queries

  /**
   * Missions the player can start right now.
   * @returns {Array<{id:string, name:string, nameKo:string, reward:number, x:number, y:number,
   *   z:number, completed:boolean, cooldown:number}>} Marker list for the map screen.
   */
  getAvailable() {
    const out = [];
    if (this.active) return out;
    for (let i = 0; i < this.markers.length; i++) {
      const m = this.markers[i];
      const def = MISSION_BY_ID[m.missionId];
      if (!def) continue;
      const cd = this.cooldowns.get(def.id) || 0;
      if (cd > 0) continue;
      out.push({
        id: def.id,
        name: def.name,
        nameKo: def.nameKo,
        reward: def.reward,
        x: m.x,
        y: m.y,
        z: m.z,
        completed: this.completed.has(def.id),
        cooldown: cd,
      });
    }
    return out;
  }

  /**
   * @returns {Object|null} The active mission definition, or null.
   */
  activeDef() {
    return this.active ? this.active.def : null;
  }

  // ================================================================ lifecycle

  /**
   * Starts a mission by id. Any running mission is aborted (and cleaned up) first.
   * @param {string} id Mission id.
   * @returns {boolean} True when the mission started.
   */
  start(id) {
    const game = this.game;
    const def = MISSION_BY_ID[id];
    if (!game || !def) return false;
    if ((this.cooldowns.get(id) || 0) > 0) {
      if (typeof game.notify === 'function') game.notify('아직 준비되지 않았습니다.', 'warn', 2);
      return false;
    }
    if (this.active) this.abort('다른 미션을 시작했습니다.');

    if (!this.origin) {
      const marker = this.markers.find((m) => m.missionId === id);
      if (marker) this.origin = { x: marker.x, y: marker.y, z: marker.z };
      else if (game.player) {
        this.origin = {
          x: fin(game.player.position[0], 0),
          y: fin(game.player.position[1], 0),
          z: fin(game.player.position[2], 0),
        };
      } else this.origin = { x: 0, y: 0, z: 0 };
    }

    this.runCount++;
    let state = null;
    try {
      state = def.setup(game);
    } catch (err) {
      console.warn(`[missions] ${id} setup failed`, err);
      if (state) {
        try { def.cleanup(game, state); } catch (e2) { /* nothing else we can do */ }
      }
      this.origin = null;
      this.cooldowns.set(id, COOLDOWN_FAIL);
      if (typeof game.notify === 'function') game.notify('미션을 시작할 수 없습니다.', 'warn', 3);
      return false;
    }
    if (!state) {
      // The mission refused the world it was given (no room for its vehicles / peds).
      this.origin = null;
      this.cooldowns.set(id, COOLDOWN_FAIL);
      if (typeof game.notify === 'function') {
        game.notify('지금은 이 미션을 시작할 수 없습니다.', 'warn', 3);
      }
      return false;
    }

    this.active = { id, def, state };
    this.countdown = START_COUNTDOWN;
    this._lastObjective = '';
    this._objectiveTimer = 0;

    if (def.wantedOnStart > 0 && game.police && typeof game.police.addWanted === 'function') {
      game.police.addWanted(def.wantedOnStart, `mission:${id}`);
    }
    if (game.hud) {
      if (typeof game.hud.setMissionText === 'function') game.hud.setMissionText(def.nameKo, '준비…');
      if (typeof game.hud.notify === 'function') game.hud.notify(`미션 시작: ${def.nameKo}`, 'mission', 4);
    }
    if (typeof game.subtitle === 'function') game.subtitle(def.briefKo, 6);
    if (game.sfx && game.sfx.notify) game.sfx.notify('mission');
    if (typeof game.emit === 'function') game.emit('missionStarted', { id, name: def.nameKo });
    return true;
  }

  /**
   * Aborts the running mission without a reward.
   * @param {string} [reason='미션을 포기했습니다.'] Korean reason shown to the player.
   * @returns {void}
   */
  abort(reason = '미션을 포기했습니다.') {
    if (!this.active) return;
    this._finish('abort', reason);
  }

  /**
   * Completes the running mission and pays the reward.
   * @returns {void}
   */
  complete() {
    if (!this.active) return;
    this._finish('success', this.active.state ? this.active.state.note : '');
  }

  /**
   * Fails the running mission.
   * @param {string} [reason='미션 실패'] Korean reason shown to the player.
   * @returns {void}
   */
  fail(reason = '미션 실패') {
    if (!this.active) return;
    this._finish('fail', reason);
  }

  /**
   * Shared shutdown path: cleanup first, rewards and messaging after.
   * @param {'success'|'fail'|'abort'} result Outcome.
   * @param {string} note Korean detail line.
   * @private
   */
  _finish(result, note) {
    const game = this.game;
    const entry = this.active;
    if (!entry) return;
    const quiet = this._silent;
    this.active = null;
    this.countdown = 0;
    this.origin = null;
    this._lastObjective = '';
    this._objectiveTimer = 0;

    try {
      entry.def.cleanup(game, entry.state);
    } catch (err) {
      console.warn(`[missions] ${entry.id} cleanup threw`, err);
    }
    // Belt and braces: even a broken cleanup must not leak entities.
    releaseState(game, entry.state);

    const hud = game.hud;
    if (hud && typeof hud.setMissionText === 'function') hud.setMissionText(null, null);

    const success = result === 'success';
    const label = success ? entry.def.nameKo : (note || (result === 'abort' ? '미션 중단' : '미션 실패'));
    if (success) {
      this.completed.add(entry.id);
      this.cooldowns.set(entry.id, COOLDOWN_SUCCESS);
      const reward = fin(entry.def.reward, 0);
      if (game.player && typeof game.player.addMoney === 'function') game.player.addMoney(reward);
      if (!quiet) {
        if (hud && typeof hud.notify === 'function') hud.notify(`미션 성공! $${reward}`, 'mission', 5);
        if (typeof game.subtitle === 'function') {
          game.subtitle(note ? `${entry.def.nameKo} — ${note}` : `${entry.def.nameKo} 완료`, 4);
        }
        if (game.sfx && game.sfx.missionSuccess) game.sfx.missionSuccess();
      }
      if (typeof game.save === 'function') {
        try { game.save(); } catch (err) { /* storage may be unavailable */ }
      }
    } else {
      this.cooldowns.set(entry.id, COOLDOWN_FAIL);
      if (!quiet) {
        const prefix = result === 'abort' ? '미션 중단' : '미션 실패';
        if (hud && typeof hud.notify === 'function') {
          hud.notify(note ? `${prefix}: ${note}` : prefix, 'warn', 5);
        }
        if (game.sfx && game.sfx.missionFail) game.sfx.missionFail();
      }
    }
    // The big centre banner is the shipped-game payoff. ui/hud.js raises it from the
    // `missionEnded` payload below (hence `success` / `name` / `reason`); this direct call is the
    // fallback for a host without an event bus, and never runs alongside it.
    if (!quiet && typeof game.emit !== 'function'
      && hud && typeof hud.showMissionResult === 'function') {
      hud.showMissionResult(success, label);
    }
    if (typeof game.emit === 'function') {
      game.emit('missionEnded', {
        id: entry.id,
        result,
        success,
        name: entry.def.nameKo,
        nameKo: entry.def.nameKo,
        reward: success ? fin(entry.def.reward, 0) : 0,
        reason: success ? '' : (note || ''),
        note: note || '',
        silent: quiet,
      });
    }
  }

  // ================================================================ per-frame

  /**
   * Runs the active mission or offers the world markers.
   * @param {number} dt Seconds.
   * @returns {void}
   */
  update(dt) {
    const game = this.game;
    if (!game) return;
    const step = Number.isFinite(dt) ? clamp(dt, 0, 0.25) : 0;
    this._time += step;

    if (this.cooldowns.size > 0) {
      _cdStep = step;
      this.cooldowns.forEach(tickCooldown);
    }

    if (this.active) {
      this._updateActive(step);
      return;
    }
    this._updateMarkers(step);
  }

  /**
   * @param {number} dt Seconds.
   * @private
   */
  _updateActive(dt) {
    const game = this.game;
    const entry = this.active;
    if (!entry) return;

    if (this.countdown > 0) {
      const before = Math.ceil(this.countdown);
      this.countdown -= dt;
      const after = Math.ceil(this.countdown);
      if (after !== before && typeof game.subtitle === 'function') {
        game.subtitle(after > 0 ? String(after) : '시작!', 1);
        if (game.sfx && game.sfx.uiClick) game.sfx.uiClick(after > 0 ? 'tick' : 'confirm');
      }
      if (this.countdown > 0) return;
      this.countdown = 0;
    }

    let result = 'running';
    try {
      result = entry.def.update(game, entry.state, dt) || 'running';
    } catch (err) {
      console.warn(`[missions] ${entry.id} update threw`, err);
      if (entry.state) entry.state.failReason = '미션 오류로 중단되었습니다.';
      result = 'fail';
    }

    if (result === 'success') { this.complete(); return; }
    if (result === 'fail') {
      const reason = entry.state && entry.state.failReason ? entry.state.failReason : '미션 실패';
      this.fail(reason);
      return;
    }

    // Objective line. Rebuilt a few times a second, not every frame: `hud._applyMission()`
    // recreates the objective DOM whenever the string changes, and the string itself allocates.
    this._objectiveTimer -= dt;
    if (this._objectiveTimer > 0) return;
    this._objectiveTimer = OBJECTIVE_INTERVAL;
    let text = '';
    try {
      text = String(entry.def.objectiveText(entry.state) || '');
    } catch (err) {
      text = '';
    }
    if (text !== this._lastObjective) {
      this._lastObjective = text;
      if (game.hud && typeof game.hud.setMissionText === 'function') {
        game.hud.setMissionText(entry.def.nameKo, text);
      }
    }
  }

  /**
   * Walk-in detection and the HUD prompt for the yellow start markers.
   * @param {number} dt Seconds.
   * @private
   */
  _updateMarkers(dt) {
    const game = this.game;
    const player = game.player;
    if (!player || !player.position || player.dead) return;
    const px = fin(player.position[0], 0);
    const pz = fin(player.position[2], 0);
    this._promptTimer -= dt;

    for (let i = 0; i < this.markers.length; i++) {
      const m = this.markers[i];
      const def = MISSION_BY_ID[m.missionId];
      if (!def) continue;
      if ((this.cooldowns.get(def.id) || 0) > 0) { m.inside = false; m.dwell = 0; continue; }
      const d = dist2(px, pz, m.x, m.z);
      if (d > m.radius) {
        if (m.inside && this._promptId === def.id) this._promptId = '';
        m.inside = false;
        m.dwell = 0;
        continue;
      }
      if (!m.inside) {
        m.inside = true;
        m.dwell = 0;
        this._promptId = def.id;
        this._promptTimer = 0;
        if (game.sfx && game.sfx.uiClick) game.sfx.uiClick('hover');
      }
      m.dwell += dt;
      if (this._promptTimer <= 0 && typeof game.subtitle === 'function') {
        this._promptTimer = 0.5;
        game.subtitle(`[E] ${def.nameKo} 미션 시작 — 보상 $${def.reward}`, 0.8);
      }
      const input = game.input;
      const pressed = input && typeof input.justPressed === 'function' && input.justPressed('interact');
      if (pressed || m.dwell > MARKER_DWELL) {
        this.origin = { x: m.x, y: m.y, z: m.z };
        m.inside = false;
        m.dwell = 0;
        this.start(def.id);
        return;
      }
    }
  }

  // ================================================================ rendering

  /**
   * Draws the yellow start markers and the active mission's objective markers.
   * @param {Object} renderer Renderer.
   * @param {number} [dt=0] Frame time (unused; kept for the system submit signature).
   * @returns {void}
   */
  submit(renderer, dt = 0) {
    if (!renderer || typeof renderer.submit !== 'function') return;
    if (!this._meshes && !this._meshFailed) this._buildMeshes(renderer);
    const m = this._meshes;
    if (!m) return;
    const t = this._time;

    if (!this.active) {
      // Only the markers the player can actually see: eight lit pillars scattered across the
      // whole city would eat the renderer's point-light budget for nothing.
      const eye = this._viewPoint();
      const range = MARKER_DRAW_RANGE * MARKER_DRAW_RANGE;
      for (let i = 0; i < this.markers.length; i++) {
        const mk = this.markers[i];
        if ((this.cooldowns.get(mk.missionId) || 0) > 0) continue;
        if (eye) {
          const dx = mk.x - eye[0];
          const dz = mk.z - eye[2];
          if (dx * dx + dz * dz > range) continue;
        }
        this._drawMarker(renderer, m, mk.x, mk.y + 1.2, mk.z, mk.color, 1, t);
      }
      return;
    }
    const st = this.active.state;
    if (!st || !Array.isArray(st.markers)) return;
    for (let i = 0; i < st.markers.length; i++) {
      const mk = st.markers[i];
      if (!mk.active) continue;
      this._drawMarker(renderer, m, mk.x, mk.y + 1.1, mk.z, mk.color, fin(mk.scale, 1), t);
    }
  }

  /**
   * The point marker culling measures from: the camera when there is one, else the player.
   * @returns {ArrayLike<number>|null} `[x, y, z]`, or null when neither is available.
   * @private
   */
  _viewPoint() {
    const game = this.game;
    const cam = game.camera;
    if (cam && cam.position && Number.isFinite(cam.position[0])) return cam.position;
    const p = game.player;
    if (p && p.position && Number.isFinite(p.position[0])) return p.position;
    return null;
  }

  /**
   * @param {Object} renderer Renderer.
   * @param {Object} meshes `{mesh, material}` cache.
   * @param {number} x World x.
   * @param {number} y World y.
   * @param {number} z World z.
   * @param {number[]} color Linear rgb.
   * @param {number} scale Uniform scale.
   * @param {number} time Seconds, for the spin / bob.
   * @private
   */
  _drawMarker(renderer, meshes, x, y, z, color, scale, time) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    const a = time * 1.3;
    const c = Math.cos(a) * scale;
    const s = Math.sin(a) * scale;
    _mm[0] = c; _mm[1] = 0; _mm[2] = -s; _mm[3] = 0;
    _mm[4] = 0; _mm[5] = scale; _mm[6] = 0; _mm[7] = 0;
    _mm[8] = s; _mm[9] = 0; _mm[10] = c; _mm[11] = 0;
    _mm[12] = x;
    _mm[13] = y + Math.sin(time * 2.1) * 0.12;
    _mm[14] = z;
    _mm[15] = 1;
    renderer.submit(meshes.mesh, meshes.material, _mm, meshes.opts);
    if (typeof renderer.submitLight === 'function') {
      renderer.submitLight(x, y + 0.6, z, color[0], color[1], color[2], 8 * scale, 2.4);
    }
  }

  /**
   * Builds the shared marker mesh + material once.
   * @param {Object} renderer Renderer.
   * @private
   */
  _buildMeshes(renderer) {
    try {
      if (typeof renderer.createMesh !== 'function') { this._meshFailed = true; return; }
      const geo = mergeGeometries([
        { geometry: cylinder(1.05, 1.05, 2.4, 18, false) },
        { geometry: cone(0.72, 1.0, 14), matrix: markerConeMatrix() },
      ]);
      const mesh = renderer.createMesh(geo);
      const material = typeof renderer.createMaterial === 'function'
        ? renderer.createMaterial({
          name: 'missionMarker',
          albedo: [1, 0.78, 0.12],
          emissive: [1, 0.7, 0.12],
          emissiveStrength: 3.2,
          roughness: 0.5,
          metallic: 0,
          alpha: 0.42,
          blend: 'add',
          doubleSided: true,
          castShadow: false,
          receiveShadow: false,
          depthWrite: false,
          unlit: true,
        })
        : null;
      this._meshes = { mesh, material, opts: { castShadow: false, tint: [1, 1, 1, 0.65] } };
    } catch (err) {
      this._meshFailed = true;
    }
  }

  // ================================================================ persistence

  /**
   * @returns {{completed:string[]}} Save payload (also mirrored by `game.save()`).
   */
  serialize() {
    return { completed: Array.from(this.completed) };
  }

  /**
   * @param {Object} data Payload from {@link MissionManager#serialize}.
   * @returns {void}
   */
  deserialize(data) {
    if (!data || !Array.isArray(data.completed)) return;
    for (const id of data.completed) if (MISSION_BY_ID[id]) this.completed.add(id);
  }

  /**
   * Aborts anything running and drops the event subscriptions.
   * @returns {void}
   */
  dispose() {
    // Tear-down must clean up the world without flashing a "MISSION FAILED" banner on the way out.
    this._silent = true;
    if (this.active) this.abort('세션이 종료되었습니다.');
    this._silent = false;
    for (let i = 0; i < this._unsub.length; i++) {
      const fn = this._unsub[i];
      if (typeof fn === 'function') fn();
    }
    this._unsub.length = 0;
    this.markers.length = 0;
  }
}

/**
 * Matrix that lifts the marker's inner cone above the ring and turns it point-down.
 *
 * This is a real 180 degree rotation about X (determinant +1), not a Y mirror: a mirroring matrix
 * would flip the triangle winding and leave the cone inside out with inverted normals.
 * @returns {Float32Array} Column-major transform.
 */
function markerConeMatrix() {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = -1;
  m[10] = -1;
  m[13] = 2.05;
  m[15] = 1;
  return m;
}
