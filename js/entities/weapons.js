/**
 * NEON CITY — weapons: definitions, firing, ballistics, damage.
 *
 * Owns the player's arsenal (ammo pools, switching, reloading), the hitscan ballistics used by
 * every shooter in the game (player, cops, gangsters) and the thrown-grenade projectiles.
 *
 * Everything audible goes through `game.sfx`, everything visible through `game.particles` /
 * `renderer.submit*`; this module never touches the AudioContext or WebGL directly.
 *
 * Ray order per shot is peds -> vehicles -> static world, and the nearest of the three wins.
 * All per-frame work reuses module-scope scratch buffers: firing allocates nothing.
 */
import { clamp, damp, lerp, Rand } from '../core/math.js';

/* ------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------ */

/** Height above a ped's feet at which a bullet counts as a head hit (metres). */
const CHEST_HEIGHT = 1.32;
/** Damage multiplier for a head hit. */
const HEADSHOT_MULT = 3;
/** Muzzle light duration in seconds (contract: 40 ms). */
const MUZZLE_LIGHT_TIME = 0.04;
/** Gravity applied to thrown grenades (m/s^2). */
const GRENADE_GRAVITY = 19.6;
/** Bounce restitution for grenades. */
const GRENADE_BOUNCE = 0.42;
/** Collision radius of a grenade (metres). */
const GRENADE_RADIUS = 0.13;
/** Maximum simultaneous tracers (pooled). */
const MAX_TRACERS = 48;
/** Maximum simultaneous grenades (pooled). */
const MAX_GRENADES = 12;
/** Maximum tracer lights submitted per frame. */
const MAX_TRACER_LIGHTS = 4;
/** Seconds between "someone is shooting" police reports. */
const SHOT_REPORT_COOLDOWN = 6;
/** Player capsule radius used when an AI shoots at the player. */
const PLAYER_HIT_RADIUS = 0.42;
/** Player capsule height used when an AI shoots at the player. */
const PLAYER_HIT_HEIGHT = 1.82;

/* ------------------------------------------------------------------ *
 * Weapon table
 * ------------------------------------------------------------------ */

/**
 * Every weapon in the game.
 *
 * Contract fields: `name, nameKo, damage, fireRate, magazine, reserve, spread, recoil, range,
 * auto, pellets, reloadTime, muzzleVelocity, sfx, twoHanded, zoom, icon`.
 *
 * Extra fields used by this module (and safe for UI code to read):
 * - `key` self reference, `slot` 1..5 for the number keys, `order` for wheel cycling
 * - `equipTime` seconds before the weapon can fire after a switch
 * - `recoilYaw` horizontal kick, `recoilRecover` recovery speed, `shake` camera shake amount
 * - `bloomPerShot` / `bloomMax` / `bloomRecover` dynamic spread growth while firing
 * - `falloffStart` / `falloffMin` damage falloff window (see {@link damageFalloff})
 * - `melee` fists, `thrown` grenades (`fuse`, `blastRadius`, `blastDamage`, `throwSpeed`)
 * - `shellTime` per-shell reload (shotgun), `tracer` tracer chance, `loudness` ped alert radius
 * - `ammoIcon` short HUD label (`icon` is a short uppercase glyph string, not an image path)
 * @type {Record<string, Object>}
 */
export const WEAPONS = {
  fist: {
    key: 'fist', name: 'Fists', nameKo: '맨손', icon: 'FIST', slot: 1, order: 0,
    damage: 14, fireRate: 0.42, magazine: 0, reserve: 0, spread: 0, recoil: 0.012,
    recoilYaw: 0.004, recoilRecover: 12, shake: 0.05,
    range: 2.05, auto: false, pellets: 0, reloadTime: 0, muzzleVelocity: 0,
    sfx: 'fist', twoHanded: false, zoom: 1, equipTime: 0.18,
    bloomPerShot: 0, bloomMax: 0, bloomRecover: 1,
    falloffStart: 2, falloffMin: 1, melee: true, thrown: false,
    tracer: 0, loudness: 3, ammoIcon: '—',
  },
  pistol: {
    key: 'pistol', name: 'Pistol', nameKo: '권총', icon: 'PSTL', slot: 2, order: 1,
    damage: 26, fireRate: 0.16, magazine: 12, reserve: 60, reserveMax: 150,
    spread: 0.011, recoil: 0.030, recoilYaw: 0.011, recoilRecover: 9, shake: 0.09,
    range: 95, auto: false, pellets: 1, reloadTime: 1.35, muzzleVelocity: 380,
    sfx: 'pistol', twoHanded: false, zoom: 1.18, equipTime: 0.28,
    bloomPerShot: 0.013, bloomMax: 0.055, bloomRecover: 0.10,
    falloffStart: 26, falloffMin: 0.45, melee: false, thrown: false,
    tracer: 0.55, loudness: 38, ammoIcon: '9mm',
  },
  smg: {
    key: 'smg', name: 'SMG', nameKo: '기관단총', icon: 'SMG', slot: 3, order: 2,
    damage: 18, fireRate: 0.075, magazine: 30, reserve: 120, reserveMax: 360,
    spread: 0.026, recoil: 0.020, recoilYaw: 0.013, recoilRecover: 11, shake: 0.07,
    range: 70, auto: true, pellets: 1, reloadTime: 2.05, muzzleVelocity: 400,
    sfx: 'smg', twoHanded: true, zoom: 1.16, equipTime: 0.34,
    bloomPerShot: 0.0085, bloomMax: 0.085, bloomRecover: 0.13,
    falloffStart: 18, falloffMin: 0.35, melee: false, thrown: false,
    tracer: 0.35, loudness: 42, ammoIcon: '9mm',
  },
  shotgun: {
    key: 'shotgun', name: 'Shotgun', nameKo: '산탄총', icon: 'SHTG', slot: 3, order: 3,
    damage: 12, fireRate: 0.85, magazine: 8, reserve: 24, reserveMax: 72,
    spread: 0.075, recoil: 0.075, recoilYaw: 0.024, recoilRecover: 6.5, shake: 0.26,
    range: 46, auto: false, pellets: 8, reloadTime: 2.9, shellTime: 0.42,
    muzzleVelocity: 340, sfx: 'shotgun', twoHanded: true, zoom: 1.1, equipTime: 0.4,
    bloomPerShot: 0.02, bloomMax: 0.06, bloomRecover: 0.09,
    falloffStart: 9, falloffMin: 0.18, melee: false, thrown: false,
    tracer: 0.12, loudness: 60, ammoIcon: '12ga',
  },
  rifle: {
    key: 'rifle', name: 'Assault Rifle', nameKo: '소총', icon: 'RIFL', slot: 4, order: 4,
    damage: 30, fireRate: 0.1, magazine: 30, reserve: 120, reserveMax: 360,
    spread: 0.017, recoil: 0.026, recoilYaw: 0.010, recoilRecover: 9.5, shake: 0.11,
    range: 150, auto: true, pellets: 1, reloadTime: 2.4, muzzleVelocity: 880,
    sfx: 'rifle', twoHanded: true, zoom: 1.4, equipTime: 0.38,
    bloomPerShot: 0.009, bloomMax: 0.07, bloomRecover: 0.12,
    falloffStart: 55, falloffMin: 0.55, melee: false, thrown: false,
    tracer: 0.45, loudness: 55, ammoIcon: '5.56',
  },
  sniper: {
    key: 'sniper', name: 'Sniper Rifle', nameKo: '저격총', icon: 'SNPR', slot: 4, order: 5,
    damage: 120, fireRate: 1.4, magazine: 5, reserve: 20, reserveMax: 50,
    spread: 0.0012, recoil: 0.115, recoilYaw: 0.018, recoilRecover: 4.5, shake: 0.34,
    range: 420, auto: false, pellets: 1, reloadTime: 3.2, muzzleVelocity: 900,
    sfx: 'sniper', twoHanded: true, zoom: 3.5, equipTime: 0.55,
    bloomPerShot: 0.03, bloomMax: 0.05, bloomRecover: 0.05,
    falloffStart: 200, falloffMin: 0.9, melee: false, thrown: false,
    tracer: 0.9, loudness: 85, ammoIcon: '.50',
  },
  grenade: {
    key: 'grenade', name: 'Grenade', nameKo: '수류탄', icon: 'GRND', slot: 5, order: 6,
    damage: 0, fireRate: 1.0, magazine: 1, reserve: 4, reserveMax: 12,
    spread: 0.008, recoil: 0.010, recoilYaw: 0.004, recoilRecover: 10, shake: 0.05,
    range: 34, auto: false, pellets: 0, reloadTime: 0.85, muzzleVelocity: 17,
    sfx: 'grenade', twoHanded: false, zoom: 1, equipTime: 0.35,
    bloomPerShot: 0, bloomMax: 0, bloomRecover: 1,
    falloffStart: 8, falloffMin: 1, melee: false, thrown: true,
    fuse: 3, blastRadius: 8, blastDamage: 145, throwSpeed: 17,
    tracer: 0, loudness: 20, ammoIcon: 'FRAG',
  },
};

/** Weapon keys in wheel / cycle order. @type {string[]} */
const WEAPON_ORDER = Object.keys(WEAPONS).sort((a, b) => WEAPONS[a].order - WEAPONS[b].order);

/** Weapon keys per number-key slot (1..5). @type {Record<number, string[]>} */
const SLOTS = (() => {
  /** @type {Record<number, string[]>} */
  const out = {};
  for (const k of WEAPON_ORDER) {
    const s = WEAPONS[k].slot;
    if (!out[s]) out[s] = [];
    out[s].push(k);
  }
  return out;
})();

/**
 * Ammo pickup table: how much ammunition a world pickup gives per weapon, plus the strings and
 * colours a HUD / pickup spawner needs. Keyed by weapon key.
 * @type {Record<string, {weapon:string, kind:string, amount:number, nameKo:string, icon:string,
 *   color:number[], respawn:number}>}
 */
export const AMMO_PICKUPS = {
  pistol: {
    weapon: 'pistol', kind: 'ammo', amount: 24, nameKo: '권총 탄약', icon: '9mm',
    color: [1, 0.78, 0.25], respawn: 45,
  },
  smg: {
    weapon: 'smg', kind: 'ammo', amount: 60, nameKo: '기관단총 탄약', icon: '9mm',
    color: [1, 0.7, 0.3], respawn: 50,
  },
  shotgun: {
    weapon: 'shotgun', kind: 'ammo', amount: 16, nameKo: '산탄총 탄약', icon: '12ga',
    color: [1, 0.45, 0.2], respawn: 55,
  },
  rifle: {
    weapon: 'rifle', kind: 'ammo', amount: 60, nameKo: '소총 탄약', icon: '5.56',
    color: [0.95, 0.85, 0.35], respawn: 60,
  },
  sniper: {
    weapon: 'sniper', kind: 'ammo', amount: 8, nameKo: '저격총 탄약', icon: '.50',
    color: [0.55, 0.85, 1], respawn: 75,
  },
  grenade: {
    weapon: 'grenade', kind: 'ammo', amount: 2, nameKo: '수류탄', icon: 'FRAG',
    color: [0.4, 0.95, 0.5], respawn: 90,
  },
};

/**
 * Distance based damage multiplier.
 * @param {string|Object} weapon Weapon key or definition.
 * @param {number} distance Metres between muzzle and impact.
 * @returns {number} Multiplier in `[def.falloffMin, 1]`.
 */
export function damageFalloff(weapon, distance) {
  const def = typeof weapon === 'string' ? WEAPONS[weapon] : weapon;
  if (!def) return 1;
  const d = Number.isFinite(distance) ? Math.max(0, distance) : 0;
  const start = Number.isFinite(def.falloffStart) ? def.falloffStart : def.range * 0.35;
  const end = Number.isFinite(def.range) ? def.range : start + 1;
  const min = Number.isFinite(def.falloffMin) ? def.falloffMin : 1;
  if (d <= start) return 1;
  if (d >= end) return min;
  const t = (d - start) / Math.max(1e-4, end - start);
  return lerp(1, min, t);
}

/* ------------------------------------------------------------------ *
 * Module scratch — nothing below allocates during a frame
 * ------------------------------------------------------------------ */

const _origin = [0, 0, 0];
const _dir = [0, 0, 0];
const _muzzle = [0, 0, 0];
const _focus = [0, 0, 0];
const _aimDir = [0, 0, 0];
const _tmp = [0, 0, 0];
const _pedPos = [0, 0, 0];
const _hitPoint = [0, 0, 0];
const _hitNormal = [0, 1, 0];
const _sweepFrom = [0, 0, 0];
const _sweepTo = [0, 0, 0];
const _impulse = [0, 0, 0];
const _matrix = new Float32Array(16);
/** Reusable direction + options for `particles.burst` — keeps firing allocation free. */
const _pdir = [0, 1, 0];
const _popts = { power: 1, dir: _pdir };
const _sdir = [1, 0, 0];
const _sopts = { power: 1, dir: _sdir, groundY: 0 };
/** Reusable descriptor for tracer particles. */
const _tracerOpts = {
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0.045, size: 0.07, sizeEnd: 0.02,
  color: [1, 0.78, 0.35], colorEnd: [1, 0.45, 0.12], alpha: 1, alphaEnd: 0,
  gravity: 0, drag: 0, kind: 'spark', additive: true, stretch: 0.07,
};

/** Shared hit record handed to {@link WeaponSystem#applyHit}. Reused every shot. */
const _hit = {
  kind: 'none',
  t: 0,
  distance: 0,
  point: _hitPoint,
  normal: _hitNormal,
  ped: null,
  vehicle: null,
  body: null,
  headshot: false,
  surface: 'concrete',
};

/** Normal produced by the last vehicle / player ray test. */
let _nx = 0;
let _ny = 1;
let _nz = 0;

/**
 * Reads a finite number or a fallback.
 * @param {*} v Candidate.
 * @param {number} d Fallback.
 * @returns {number} Finite value.
 */
function fin(v, d) {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/**
 * Copies an entity position into `out`, tolerating peds/vehicles that store it differently.
 * @param {Object} ent Entity with `position` or `character.position`.
 * @param {number[]} out Destination.
 * @returns {boolean} True when a finite position was found.
 */
function readPosition(ent, out) {
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
 * @param {Object} ped Ped record from PedManager.
 * @returns {boolean} True when the ped can still take damage.
 */
function pedAlive(ped) {
  if (!ped) return false;
  if (ped.dead === true) return false;
  if (ped.state === 'dead') return false;
  return !(typeof ped.health === 'number' && ped.health <= 0);
}

/**
 * Maps a collision body to a surface name understood by `sfx.bulletImpact`.
 * @param {Object|null} body Collision body (null = terrain).
 * @returns {string} `'concrete'|'metal'|'glass'|'wood'|'dirt'|'water'`
 */
function surfaceForBody(body) {
  if (!body) return 'concrete';
  if (body.tag === 'water') return 'water';
  if (body.tag === 'terrain') return 'dirt';
  const ud = body.userData;
  if (ud) {
    if (ud.surface) return ud.surface;
    if (ud.glass) return 'glass';
    const t = ud.propType;
    if (t) {
      if (t === 'tree' || t === 'palm' || t === 'bench' || t === 'planter' || t === 'busstop') return 'wood';
      if (t === 'hydrant' || t === 'bollard' || t === 'streetlight' || t === 'trafficlight'
        || t === 'bin' || t === 'barrier' || t === 'dumpster' || t === 'sign' || t === 'atm'
        || t === 'cone' || t === 'lamp') return 'metal';
      if (t === 'phonebox' || t === 'billboard') return 'glass';
    }
  }
  return 'concrete';
}

/**
 * Builds an orthonormal basis around `dir` and writes a cone-perturbed direction into `out`.
 * @param {number[]} dir Normalised direction.
 * @param {number} angle Cone half-angle in radians.
 * @param {Rand} rng Deterministic source.
 * @param {number[]} out Destination.
 * @returns {number[]} `out`
 */
function coneSpread(dir, angle, rng, out) {
  out[0] = dir[0];
  out[1] = dir[1];
  out[2] = dir[2];
  if (!(angle > 1e-6)) return out;
  // Pick a perpendicular axis that is never parallel to dir.
  let ax = 0;
  let ay = 1;
  let az = 0;
  if (Math.abs(dir[1]) > 0.94) { ax = 1; ay = 0; az = 0; }
  let rx = ay * dir[2] - az * dir[1];
  let ry = az * dir[0] - ax * dir[2];
  let rz = ax * dir[1] - ay * dir[0];
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  const ux = dir[1] * rz - dir[2] * ry;
  const uy = dir[2] * rx - dir[0] * rz;
  const uz = dir[0] * ry - dir[1] * rx;
  // Gaussian in the tangent plane keeps the centre dense, like real dispersion.
  const a = rng.next() * Math.PI * 2;
  const r = Math.min(2.2, Math.abs(rng.gaussian())) * angle;
  const sx = Math.cos(a) * r;
  const sy = Math.sin(a) * r;
  out[0] = dir[0] + rx * sx + ux * sy;
  out[1] = dir[1] + ry * sx + uy * sy;
  out[2] = dir[2] + rz * sx + uz * sy;
  const l = Math.hypot(out[0], out[1], out[2]) || 1;
  out[0] /= l; out[1] /= l; out[2] /= l;
  return out;
}

/**
 * Emits a directional preset burst without allocating an options object.
 * @param {Object} parts Particle system.
 * @param {string} kind Preset name.
 * @param {number} x World x.
 * @param {number} y World y.
 * @param {number} z World z.
 * @param {number} count Particle count.
 * @param {number} dx Direction x.
 * @param {number} dy Direction y.
 * @param {number} dz Direction z.
 * @param {number} power Energy multiplier.
 * @returns {void}
 */
function burstDir(parts, kind, x, y, z, count, dx, dy, dz, power) {
  if (!parts || typeof parts.burst !== 'function') return;
  _pdir[0] = dx;
  _pdir[1] = dy;
  _pdir[2] = dz;
  _popts.power = power;
  _popts.dir = _pdir;
  parts.burst(kind, x, y, z, count, _popts);
}

/**
 * Ray vs oriented vehicle box.
 * @param {Object} v Vehicle.
 * @param {number} ox Ray origin x.
 * @param {number} oy Ray origin y.
 * @param {number} oz Ray origin z.
 * @param {number} dx Ray dir x (normalised).
 * @param {number} dy Ray dir y.
 * @param {number} dz Ray dir z.
 * @param {number} maxT Current best distance.
 * @returns {number} Hit distance or -1. Writes the world normal into the module scratch.
 */
function rayVehicle(v, ox, oy, oz, dx, dy, dz, maxT) {
  const type = v.type || {};
  const hw = fin(type.width, 1.9) * 0.5 + 0.05;
  const hl = fin(type.length, 4.4) * 0.5 + 0.05;
  const hgt = fin(type.height, 1.45);
  const cx = fin(v.position ? v.position[0] : NaN, NaN);
  const cy = fin(v.position ? v.position[1] : NaN, NaN) + hgt * 0.22;
  const cz = fin(v.position ? v.position[2] : NaN, NaN);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)) return -1;
  const hy = hgt * 0.62;

  // Cheap bounding-sphere reject first.
  const rx0 = cx - ox;
  const ry0 = cy - oy;
  const rz0 = cz - oz;
  const proj = rx0 * dx + ry0 * dy + rz0 * dz;
  const radius = Math.hypot(hw, hy, hl);
  if (proj < -radius || proj > maxT + radius) return -1;
  const perp2 = (rx0 * rx0 + ry0 * ry0 + rz0 * rz0) - proj * proj;
  if (perp2 > radius * radius) return -1;

  const yaw = fin(v.yaw, 0);
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  // Local axes: right = (c, 0, -s), forward = (-s, 0, -c).
  const px = -rx0 * c + rz0 * s;      // -(o - c) . right
  const py = -ry0;
  const pz = rx0 * s + rz0 * c;       // -(o - c) . forward
  const vx = dx * c - dz * s;
  const vy = dy;
  const vz = -dx * s - dz * c;

  let tmin = 0;
  let tmax = maxT;
  let axis = 0;
  let sign = 1;
  // X slab
  for (let i = 0; i < 3; i++) {
    const o = i === 0 ? px : i === 1 ? py : pz;
    const d = i === 0 ? vx : i === 1 ? vy : vz;
    const h = i === 0 ? hw : i === 1 ? hy : hl;
    if (Math.abs(d) < 1e-8) {
      if (o < -h || o > h) return -1;
      continue;
    }
    let t1 = (-h - o) / d;
    let t2 = (h - o) / d;
    let sg = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; sg = 1; }
    if (t1 > tmin) { tmin = t1; axis = i; sign = sg; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  if (tmin <= 0 || tmin > maxT) return -1;

  // Local normal -> world.
  if (axis === 0) { _nx = c * sign; _ny = 0; _nz = -s * sign; } else if (axis === 1) {
    _nx = 0; _ny = sign; _nz = 0;
  } else { _nx = -s * sign; _ny = 0; _nz = -c * sign; }
  return tmin;
}

/**
 * Ray vs the player's vertical capsule (used when AI fires at the player).
 * @param {Object} player Player object.
 * @param {number} ox Origin x.
 * @param {number} oy Origin y.
 * @param {number} oz Origin z.
 * @param {number} dx Dir x.
 * @param {number} dy Dir y.
 * @param {number} dz Dir z.
 * @param {number} maxT Current best distance.
 * @returns {number} Hit distance or -1.
 */
function rayPlayer(player, ox, oy, oz, dx, dy, dz, maxT) {
  if (!player || player.dead || !player.position) return -1;
  const cx = fin(player.position[0], NaN);
  const cy = fin(player.position[1], NaN);
  const cz = fin(player.position[2], NaN);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)) return -1;
  const r = PLAYER_HIT_RADIUS;
  const mx = ox - cx;
  const mz = oz - cz;
  const a = dx * dx + dz * dz;
  if (a < 1e-8) return -1;
  const b = 2 * (mx * dx + mz * dz);
  const cc = mx * mx + mz * mz - r * r;
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / (2 * a);
  if (t < 0) t = (-b + sq) / (2 * a);
  if (t < 0.05 || t > maxT) return -1;
  const y = oy + dy * t;
  if (y < cy - 0.1 || y > cy + PLAYER_HIT_HEIGHT) return -1;
  const hx = ox + dx * t - cx;
  const hz = oz + dz * t - cz;
  const hl = Math.hypot(hx, hz) || 1;
  _nx = hx / hl; _ny = 0; _nz = hz / hl;
  return t;
}

/* ------------------------------------------------------------------ *
 * WeaponSystem
 * ------------------------------------------------------------------ */

export class WeaponSystem {
  /**
   * @param {Object} game The `Game` instance (contract section 16).
   */
  constructor(game) {
    this.game = game;
    /** Deterministic randomness — never `Math.random()`. @type {Rand} */
    this.rng = game && game.rng && typeof game.rng.fork === 'function'
      ? game.rng.fork('weapons') : new Rand(0x7EA9012);

    /** Currently equipped weapon key. @type {string} */
    this.current = 'fist';
    /**
     * The weapon table, published so UI code can look a definition up by key without importing
     * this module (`ui/hud.js` reads `weapons.defs[key].magazine` / `.nameKo`).
     * @type {Record<string, Object>}
     */
    this.defs = WEAPONS;
    /** Per-weapon ammunition pools. @type {Record<string, {mag:number, reserve:number}>} */
    this.ammo = {};
    /** Weapons the player owns. @type {Set<string>} */
    this.owned = new Set(['fist']);
    for (const k of WEAPON_ORDER) this.ammo[k] = { mag: 0, reserve: 0 };

    /** True while a reload is running. @type {boolean} */
    this.reloading = false;
    /** Seconds left on the reload. @type {number} */
    this.reloadLeft = 0;
    /**
     * Length of the reload step currently running, so a HUD can draw `1 - reloadLeft/reloadDuration`
     * (`ui/hud.js` reads exactly this pair). Equals `shellTime` during a per-shell reload.
     * @type {number}
     */
    this.reloadDuration = 0;
    /** Seconds left before the weapon can fire again. @type {number} */
    this.cooldown = 0;
    /** Seconds left of the equip animation. @type {number} */
    this.equipLeft = 0;
    /** Dynamic spread in radians added to the weapon's base spread. @type {number} */
    this.bloom = 0;
    /** Total spread used by the last shot (radians) — HUD reticle size. @type {number} */
    this.spreadRadians = WEAPONS.fist.spread;
    /**
     * Live aiming cone in radians: base spread scaled by stance and movement plus the dynamic
     * bloom, refreshed every frame so the crosshair breathes even when nobody is shooting.
     * `ui/hud.js` reads this to size the reticle.
     * @type {number}
     */
    this.currentSpread = WEAPONS.fist.spread;
    /** Recoil kick applied to the view, recovering over time. @type {{pitch:number, yaw:number}} */
    this.viewKick = { pitch: 0, yaw: 0 };
    /** Scope zoom currently requested by the equipped weapon (1 = none). @type {number} */
    this.zoom = 1;
    /** Rounds fired since the game started. @type {number} */
    this.shotsFired = 0;
    /** Confirmed hits (any target). @type {number} */
    this.shotsHit = 0;

    this._fireHeld = false;
    this._shotReport = 0;
    this._dryClick = 0;
    this._shellReload = false;
    this._meshes = null;
    this._meshFailed = false;

    /** Muzzle flash light state. */
    this._flash = { t: 0, x: 0, y: 0, z: 0, power: 1 };

    /** Pooled tracers. */
    this._tracers = new Array(MAX_TRACERS);
    for (let i = 0; i < MAX_TRACERS; i++) {
      this._tracers[i] = {
        active: false, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1,
        speed: 400, travelled: 0, dist: 0, life: 0, r: 1, g: 0.75, b: 0.35, bright: 1,
      };
    }
    /** Pooled grenades. */
    this._grenades = new Array(MAX_GRENADES);
    for (let i = 0; i < MAX_GRENADES; i++) {
      this._grenades[i] = {
        active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        fuse: 0, spin: 0, trail: 0, owner: null, radius: 8, damage: 145,
      };
    }
    /** Bounded decal request queue drained by the renderer/world when it supports decals. */
    if (game && game.ext && !Array.isArray(game.ext.decals)) game.ext.decals = [];
  }

  // ================================================================ queries

  /**
   * @returns {Object} The equipped weapon definition (never null).
   */
  def() {
    return WEAPONS[this.current] || WEAPONS.fist;
  }

  /**
   * @param {string} [key] Weapon key, defaults to the equipped one.
   * @returns {{mag:number, reserve:number}} Ammo pool (never null).
   */
  ammoFor(key) {
    const k = key || this.current;
    let a = this.ammo[k];
    if (!a) { a = { mag: 0, reserve: 0 }; this.ammo[k] = a; }
    return a;
  }

  /**
   * @returns {boolean} True when the equipped weapon supports the aim stance.
   */
  canAim() {
    const d = this.def();
    return !d.melee;
  }

  /**
   * @returns {boolean} True when the weapon is scoped and the player is aiming.
   */
  isScoped() {
    const p = this.game && this.game.player;
    return !!(p && p.aiming && this.def().zoom >= 2.5);
  }

  /**
   * Snapshot for the HUD.
   * @returns {{key:string, nameKo:string, icon:string, mag:number, reserve:number,
   *   magazine:number, reloading:boolean, reloadProgress:number, melee:boolean}}
   */
  hudInfo() {
    const d = this.def();
    const a = this.ammoFor();
    const total = this.reloadDuration > 0 ? this.reloadDuration : (d.reloadTime > 0 ? d.reloadTime : 1);
    return {
      key: this.current,
      nameKo: d.nameKo,
      icon: d.icon,
      mag: a.mag,
      reserve: a.reserve,
      magazine: d.magazine,
      reloading: this.reloading,
      reloadProgress: this.reloading ? clamp(1 - this.reloadLeft / total, 0, 1) : 0,
      melee: !!d.melee,
    };
  }

  // ================================================================ inventory

  /**
   * Grants a weapon and (optionally) ammunition for it.
   * @param {string} key Weapon key.
   * @param {number} [ammo=0] Rounds added to the reserve (the magazine is topped up first).
   * @returns {boolean} True when the key exists.
   */
  giveWeapon(key, ammo = 0) {
    const def = WEAPONS[key];
    if (!def) return false;
    const isNew = !this.owned.has(key);
    this.owned.add(key);
    const a = this.ammoFor(key);
    let n = Math.max(0, fin(ammo, 0));
    if (isNew && def.magazine > 0) {
      const load = Math.min(def.magazine, n > 0 ? n : def.magazine);
      a.mag = Math.max(a.mag, load);
      n -= load;
    }
    if (n > 0) this.addAmmo(key, n);
    if (isNew) {
      const g = this.game;
      if (g && g.hud && g.hud.notify) g.hud.notify(`${def.nameKo} 획득`, 'info', 3);
      if (g && g.sfx && g.sfx.pickup) g.sfx.pickup('weapon', g.player ? g.player.position : null);
      if (this.current === 'fist' || WEAPONS[this.current].order < def.order) this.switchTo(key);
    }
    return true;
  }

  /**
   * Adds reserve ammunition.
   * @param {string} key Weapon key.
   * @param {number} n Rounds.
   * @returns {number} Rounds actually added (reserve is capped per weapon).
   */
  addAmmo(key, n) {
    const def = WEAPONS[key];
    if (!def || def.melee) return 0;
    const a = this.ammoFor(key);
    const cap = fin(def.reserveMax, def.reserve * 3);
    const add = Math.max(0, Math.floor(fin(n, 0)));
    const before = a.reserve;
    a.reserve = Math.min(cap, a.reserve + add);
    return a.reserve - before;
  }

  /**
   * Equips a weapon. Cancels any running reload and starts the equip delay.
   * @param {string} key Weapon key.
   * @returns {boolean} True when the weapon was equipped.
   */
  switchTo(key) {
    const def = WEAPONS[key];
    if (!def) return false;
    if (key !== 'fist' && !this.owned.has(key)) {
      // Ammo pickups can hand us a weapon we do not own yet; only silently accept when it has ammo.
      const a = this.ammo[key];
      if (!a || (a.mag <= 0 && a.reserve <= 0)) return false;
      this.owned.add(key);
    }
    if (this.current === key) return true;
    this.current = key;
    this.reloading = false;
    this._shellReload = false;
    this.reloadLeft = 0;
    this.reloadDuration = 0;
    this.bloom = 0;
    this.cooldown = Math.max(this.cooldown, 0.08);
    this.equipLeft = fin(def.equipTime, 0.3);
    this._fireHeld = true; // require a fresh trigger pull after a switch
    const g = this.game;
    if (g) {
      if (g.sfx && g.sfx.uiClick) g.sfx.uiClick('weapon');
      if (g.player && g.player.character) this._setCharacterState('equip');
      if (g.ext) g.ext.weaponZoom = 1;
    }
    return true;
  }

  /**
   * Equips the next owned weapon in wheel order.
   * @returns {string} The equipped key.
   */
  nextWeapon() { return this._cycle(1); }

  /**
   * Equips the previous owned weapon in wheel order.
   * @returns {string} The equipped key.
   */
  prevWeapon() { return this._cycle(-1); }

  /**
   * Equips a weapon from a number-key slot; repeated presses cycle inside the slot.
   * @param {number} slot 1..5.
   * @returns {boolean} True when something was equipped.
   */
  selectSlot(slot) {
    const list = SLOTS[slot];
    if (!list) return false;
    const start = list.indexOf(this.current);
    for (let i = 1; i <= list.length; i++) {
      const key = list[(start + i + list.length) % list.length];
      if (key === 'fist' || this.owned.has(key)) return this.switchTo(key);
    }
    return false;
  }

  /**
   * @param {number} step +1 / -1.
   * @returns {string} Equipped key.
   * @private
   */
  _cycle(step) {
    const start = Math.max(0, WEAPON_ORDER.indexOf(this.current));
    const n = WEAPON_ORDER.length;
    for (let i = 1; i <= n; i++) {
      const key = WEAPON_ORDER[(start + step * i + n * n) % n];
      if (key === 'fist' || this.owned.has(key)) { this.switchTo(key); break; }
    }
    return this.current;
  }

  // ================================================================ reloading

  /**
   * Starts a reload when it makes sense.
   * @returns {boolean} True when a reload actually started.
   */
  reload() {
    const def = this.def();
    if (def.melee) return false;
    if (this.reloading || this.equipLeft > 0) return false;
    const a = this.ammoFor();
    if (a.mag >= def.magazine || a.reserve <= 0) return false;
    this.reloading = true;
    this._shellReload = !!def.shellTime;
    this.reloadLeft = this._shellReload ? def.shellTime : def.reloadTime;
    this.reloadDuration = Math.max(1e-3, this.reloadLeft);
    this.bloom = 0;
    const g = this.game;
    if (g) {
      if (g.sfx && g.sfx.reload) g.sfx.reload(def.thrown ? 'fist' : def.sfx, this._ownerPos(g));
      this._setCharacterState('reload');
    }
    return true;
  }

  /**
   * Moves rounds from the reserve into the magazine.
   * @param {Object} def Weapon definition.
   * @param {number} max Maximum rounds to move.
   * @returns {number} Rounds moved.
   * @private
   */
  _fillMagazine(def, max) {
    const a = this.ammoFor();
    const need = Math.min(max, def.magazine - a.mag, a.reserve);
    if (need <= 0) return 0;
    a.mag += need;
    a.reserve -= need;
    return need;
  }

  /**
   * Advances the reload timers.
   * @param {number} dt Seconds.
   * @private
   */
  _updateReload(dt) {
    if (!this.reloading) return;
    const def = this.def();
    this.reloadLeft -= dt;
    if (this.reloadLeft > 0) return;
    const a = this.ammoFor();
    if (this._shellReload) {
      this._fillMagazine(def, 1);
      if (a.mag >= def.magazine || a.reserve <= 0) {
        this.reloading = false;
        this._shellReload = false;
        this.reloadLeft = 0;
        this.reloadDuration = 0;
        this._setCharacterState(null);
      } else {
        this.reloadLeft = def.shellTime;
        this.reloadDuration = Math.max(1e-3, def.shellTime);
        const g = this.game;
        if (g && g.sfx && g.sfx.reload) g.sfx.reload(def.sfx, this._ownerPos(g));
      }
      return;
    }
    this._fillMagazine(def, def.magazine);
    this.reloading = false;
    this.reloadLeft = 0;
    this.reloadDuration = 0;
    this._setCharacterState(null);
  }

  // ================================================================ firing

  /**
   * Fires the weapon if it is ready.
   *
   * The player's shot consumes ammunition, applies recoil / bloom / shake and spawns the muzzle
   * effects; AI shots (`ownerIsPlayer === false`) skip the inventory entirely so cops and
   * gangsters can use the same ballistics.
   *
   * @param {ArrayLike<number>} origin3 Muzzle position in world space.
   * @param {ArrayLike<number>} dir3 Aim direction (normalised internally).
   * @param {boolean} [ownerIsPlayer=true] Whether the player pulled the trigger.
   * @param {number} [spreadMul=1] Extra spread multiplier (AI accuracy, hip fire, ...).
   * @param {Object|null} [opts=null] `{weapon, shooter, damageMul}` — used by AI shooters.
   * @returns {boolean} True when a shot left the barrel.
   */
  tryFire(origin3, dir3, ownerIsPlayer = true, spreadMul = 1, opts = null) {
    const game = this.game;
    if (!game) return false;
    const key = (opts && opts.weapon && WEAPONS[opts.weapon]) ? opts.weapon
      : (ownerIsPlayer ? this.current : 'pistol');
    const def = WEAPONS[key] || WEAPONS.fist;

    if (!origin3 || !dir3) return false;
    const ox = fin(origin3[0], NaN);
    const oy = fin(origin3[1], NaN);
    const oz = fin(origin3[2], NaN);
    let dx = fin(dir3[0], 0);
    let dy = fin(dir3[1], 0);
    let dz = fin(dir3[2], 0);
    const dl = Math.hypot(dx, dy, dz);
    if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(oz) || !(dl > 1e-6)) return false;
    dx /= dl; dy /= dl; dz /= dl;

    if (ownerIsPlayer) {
      const player = game.player;
      if (player && (player.dead || player.vehicle)) return false;
      if (this.cooldown > 0 || this.equipLeft > 0) return false;
      if (this.reloading) {
        if (!this._shellReload) return false;
        // A pumped shotgun can be fired mid-reload.
        this.reloading = false;
        this._shellReload = false;
        this.reloadLeft = 0;
        this.reloadDuration = 0;
      }
      if (!def.melee) {
        const a = this.ammoFor(key);
        if (a.mag <= 0) {
          this._dryFire(def);
          return false;
        }
        a.mag -= 1;
      }
      this.cooldown = def.fireRate;
    }

    _origin[0] = ox; _origin[1] = oy; _origin[2] = oz;
    _dir[0] = dx; _dir[1] = dy; _dir[2] = dz;

    const shooter = (opts && opts.shooter) || (ownerIsPlayer ? (game.player || null) : null);
    const damageMul = fin(opts && opts.damageMul, ownerIsPlayer ? 1 : 0.7);

    if (def.melee) {
      this._melee(def, ownerIsPlayer, damageMul, shooter);
      if (game.emit) game.emit('weaponFired', { weapon: key, player: ownerIsPlayer, x: ox, y: oy, z: oz });
      return true;
    }
    if (def.thrown) {
      this._throwGrenade(def, ownerIsPlayer, shooter);
      if (game.emit) game.emit('weaponFired', { weapon: key, player: ownerIsPlayer, x: ox, y: oy, z: oz });
      return true;
    }

    // --- spread ------------------------------------------------------------------------------
    let spread = def.spread + this.bloom * (ownerIsPlayer ? 1 : 0);
    if (ownerIsPlayer) spread *= this._playerSpreadMul();
    spread *= Math.max(0, fin(spreadMul, 1));
    if (ownerIsPlayer) this.spreadRadians = spread;

    const pellets = Math.max(1, def.pellets | 0);
    for (let i = 0; i < pellets; i++) {
      coneSpread(_dir, pellets > 1 ? Math.max(spread, def.spread) : spread, this.rng, _aimDir);
      this._castBullet(_origin, _aimDir, def, ownerIsPlayer, damageMul, shooter);
    }

    this.shotsFired++;
    this._muzzleEffects(def, _origin, _dir, ownerIsPlayer);
    if (ownerIsPlayer) {
      this.bloom = Math.min(def.bloomMax, this.bloom + def.bloomPerShot);
      this._applyRecoil(def);
      this._setCharacterState('shoot');
    }
    this._alertWorld(def, _origin, ownerIsPlayer);
    if (game.emit) {
      game.emit('weaponFired', { weapon: key, player: ownerIsPlayer, x: ox, y: oy, z: oz });
    }
    return true;
  }

  /**
   * Extra spread from the player's stance and movement.
   * @returns {number} Multiplier.
   * @private
   */
  _playerSpreadMul() {
    const p = this.game.player;
    if (!p) return 1;
    let m = p.aiming ? 0.45 : 1;
    if (p.crouching) m *= 0.7;
    const speed = Math.hypot(fin(p.velocity ? p.velocity[0] : 0, 0), fin(p.velocity ? p.velocity[2] : 0, 0));
    m *= 1 + clamp(speed / 8, 0, 1) * 1.5;
    if (!p.grounded) m *= 1.7;
    return m;
  }

  /**
   * Melee swing: a very short ray plus a small sphere sweep against peds.
   * @param {Object} def Weapon definition (fist).
   * @param {boolean} ownerIsPlayer Whether the player swung.
   * @param {number} damageMul Damage scale.
   * @param {Object|null} shooter Attacker.
   * @private
   */
  _melee(def, ownerIsPlayer, damageMul, shooter) {
    const game = this.game;
    this.shotsFired++;
    if (ownerIsPlayer) {
      this._setCharacterState('punch');
      if (game.shakeCamera) game.shakeCamera(def.shake, 0.12);
    }
    const hit = this._castBullet(_origin, _dir, def, ownerIsPlayer, damageMul, shooter, true);
    if (game.sfx && game.sfx.punch) game.sfx.punch(_origin, !!hit);
    if (!hit) {
      burstDir(game.particles, 'dust', _origin[0] + _dir[0] * 0.8, _origin[1] + _dir[1] * 0.8,
        _origin[2] + _dir[2] * 0.8, 2, _dir[0], 0.4, _dir[2], 0.4);
    }
  }

  /**
   * Raycasts one bullet through peds -> vehicles -> world and resolves the nearest hit.
   * @param {number[]} origin Ray origin.
   * @param {number[]} dir Normalised direction.
   * @param {Object} def Weapon definition.
   * @param {boolean} ownerIsPlayer Whether the player fired.
   * @param {number} damageMul Damage scale.
   * @param {Object|null} shooter Attacker entity.
   * @param {boolean} [melee=false] Skip tracer / impact decals for punches.
   * @returns {Object|null} The shared hit record, or null when nothing was hit.
   * @private
   */
  _castBullet(origin, dir, def, ownerIsPlayer, damageMul, shooter, melee = false) {
    const game = this.game;
    const maxDist = def.range;
    let bestT = maxDist;
    let kind = 'none';
    let ped = null;
    let vehicle = null;
    let body = null;
    let headshot = false;
    let nx = 0;
    let ny = 1;
    let nz = 0;
    let px = origin[0] + dir[0] * maxDist;
    let py = origin[1] + dir[1] * maxDist;
    let pz = origin[2] + dir[2] * maxDist;

    // --- 1. peds --------------------------------------------------------------------------
    const peds = game.peds;
    if (peds && typeof peds.raycastPeds === 'function') {
      const h = peds.raycastPeds(origin, dir, bestT);
      if (h && h.ped && Number.isFinite(h.t) && h.t > 0 && h.t < bestT && pedAlive(h.ped)
        && h.ped !== shooter) {
        bestT = h.t;
        kind = 'ped';
        ped = h.ped;
        if (h.point && Number.isFinite(h.point[0])) {
          px = h.point[0]; py = h.point[1]; pz = h.point[2];
        } else {
          px = origin[0] + dir[0] * bestT;
          py = origin[1] + dir[1] * bestT;
          pz = origin[2] + dir[2] * bestT;
        }
        headshot = !!h.headshot;
        if (!headshot && readPosition(ped, _pedPos)) headshot = py - _pedPos[1] > CHEST_HEIGHT;
        nx = -dir[0]; ny = -dir[1]; nz = -dir[2];
      }
    }

    // --- 2. the player (only when someone else is shooting) --------------------------------
    if (!ownerIsPlayer && game.player) {
      const t = rayPlayer(game.player, origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], bestT);
      if (t > 0) {
        bestT = t;
        kind = 'player';
        ped = null;
        vehicle = null;
        body = null;
        px = origin[0] + dir[0] * t;
        py = origin[1] + dir[1] * t;
        pz = origin[2] + dir[2] * t;
        headshot = py - fin(game.player.position[1], 0) > 1.5;
        nx = _nx; ny = _ny; nz = _nz;
      }
    }

    // --- 3. vehicles -----------------------------------------------------------------------
    const list = game.vehicles;
    if (list && list.length) {
      const ownVehicle = ownerIsPlayer && game.player ? game.player.vehicle : null;
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (!v || v === ownVehicle || v.isDestroyed) continue;
        const t = rayVehicle(v, origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], bestT);
        if (t > 0 && t < bestT) {
          bestT = t;
          kind = 'vehicle';
          vehicle = v;
          ped = null;
          body = null;
          headshot = false;
          px = origin[0] + dir[0] * t;
          py = origin[1] + dir[1] * t;
          pz = origin[2] + dir[2] * t;
          nx = _nx; ny = _ny; nz = _nz;
        }
      }
    }

    // --- 4. static world -------------------------------------------------------------------
    const coll = game.collision;
    if (coll && typeof coll.raycast === 'function') {
      const h = coll.raycast(origin, dir, bestT, null);
      if (h && Number.isFinite(h.t) && h.t > 0 && h.t < bestT) {
        bestT = h.t;
        kind = 'world';
        ped = null;
        vehicle = null;
        body = h.body || null;
        headshot = false;
        if (h.point && Number.isFinite(h.point[0])) {
          px = h.point[0]; py = h.point[1]; pz = h.point[2];
        } else {
          px = origin[0] + dir[0] * bestT;
          py = origin[1] + dir[1] * bestT;
          pz = origin[2] + dir[2] * bestT;
        }
        if (h.normal && Number.isFinite(h.normal[0])) {
          nx = h.normal[0]; ny = h.normal[1]; nz = h.normal[2];
        } else { nx = -dir[0]; ny = -dir[1]; nz = -dir[2]; }
      }
    }

    if (!melee && def.tracer > 0 && this.rng.chance(def.tracer)) {
      this._spawnTracer(origin, dir, Math.min(bestT, maxDist), def);
    }

    if (kind === 'none') return null;

    _hitPoint[0] = px; _hitPoint[1] = py; _hitPoint[2] = pz;
    const nl = Math.hypot(nx, ny, nz) || 1;
    _hitNormal[0] = nx / nl; _hitNormal[1] = ny / nl; _hitNormal[2] = nz / nl;
    _hit.kind = kind;
    _hit.t = bestT;
    _hit.distance = bestT;
    _hit.ped = ped;
    _hit.vehicle = vehicle;
    _hit.body = body;
    _hit.headshot = headshot;
    _hit.surface = kind === 'ped' || kind === 'player' ? 'flesh'
      : kind === 'vehicle' ? 'metal' : surfaceForBody(body);

    const damage = def.damage * damageMul * damageFalloff(def, bestT);
    this.applyHit(_hit, damage, dir);
    if (ownerIsPlayer) this.shotsHit++;
    return _hit;
  }

  /**
   * Applies damage and the audiovisual response for one resolved hit.
   * @param {Object} hit Hit record `{kind, point, normal, ped, vehicle, body, headshot, distance}`.
   * @param {number} damage Damage before the headshot multiplier.
   * @param {ArrayLike<number>} dir3 Bullet direction.
   * @returns {number} Damage actually applied.
   */
  applyHit(hit, damage, dir3) {
    const game = this.game;
    if (!game || !hit) return 0;
    const p = hit.point || _hitPoint;
    const x = fin(p[0], 0);
    const y = fin(p[1], 0);
    const z = fin(p[2], 0);
    const dx = fin(dir3 ? dir3[0] : 0, 0);
    const dy = fin(dir3 ? dir3[1] : 0, 0);
    const dz = fin(dir3 ? dir3[2] : 1, 1);
    let dmg = Math.max(0, fin(damage, 0));
    const parts = game.particles;
    const sfx = game.sfx;

    if (hit.kind === 'ped') {
      if (hit.headshot) dmg *= HEADSHOT_MULT;
      _tmp[0] = dx; _tmp[1] = dy; _tmp[2] = dz;
      if (game.peds && typeof game.peds.damagePed === 'function' && pedAlive(hit.ped)) {
        game.peds.damagePed(hit.ped, dmg, _tmp, !!hit.headshot);
      }
      burstDir(parts, 'blood', x, y, z, hit.headshot ? 14 : 8, dx, dy, dz,
        hit.headshot ? 1.6 : 1.1);
      if (sfx && sfx.bulletImpact) sfx.bulletImpact('flesh', p);
      if (game.hud && game.hud.hitMarker) game.hud.hitMarker(!!hit.headshot);
      if (game.player) game.player.damageDealt = fin(game.player.damageDealt, 0) + dmg;
      return dmg;
    }

    if (hit.kind === 'player') {
      if (hit.headshot) dmg *= 1.8;
      _tmp[0] = -dx; _tmp[1] = -dy; _tmp[2] = -dz;
      if (game.player && typeof game.player.damage === 'function') {
        game.player.damage(dmg, _tmp, 'bullet');
      }
      burstDir(parts, 'blood', x, y, z, 6, dx, dy, dz, 0.9);
      if (sfx && sfx.bulletImpact) sfx.bulletImpact('flesh', p);
      return dmg;
    }

    if (hit.kind === 'vehicle') {
      const v = hit.vehicle;
      if (v && typeof v.applyDamage === 'function' && !v.isDestroyed) {
        _impulse[0] = dx * dmg * 2.2;
        _impulse[1] = Math.abs(dy) * dmg * 0.6;
        _impulse[2] = dz * dmg * 2.2;
        v.applyDamage(dmg, p, _impulse);
      }
      const vn = hit.normal || _hitNormal;
      burstDir(parts, 'impact', x, y, z, 7, fin(vn[0], 0), fin(vn[1], 1), fin(vn[2], 0), 1.1);
      burstDir(parts, 'debris', x, y, z, 2, fin(vn[0], 0), fin(vn[1], 1), fin(vn[2], 0), 0.6);
      if (sfx && sfx.bulletImpact) sfx.bulletImpact('metal', p);
      if (sfx && sfx.ricochet && this.rng.chance(0.25)) sfx.ricochet(p);
      this._requestDecal(x, y, z, hit.normal, 'metal');
      return dmg;
    }

    // static world
    const surface = hit.surface || surfaceForBody(hit.body);
    const nX = fin(hit.normal ? hit.normal[0] : 0, 0);
    const nY = fin(hit.normal ? hit.normal[1] : 1, 1);
    const nZ = fin(hit.normal ? hit.normal[2] : 0, 0);
    if (surface === 'glass') {
      burstDir(parts, 'glass', x, y, z, 9, nX, nY, nZ, 1);
      if (sfx && sfx.glassBreak) sfx.glassBreak(p, 0.4);
    } else if (surface === 'water') {
      burstDir(parts, 'splash', x, y, z, 7, nX, nY, nZ, 0.8);
    } else if (surface === 'metal') {
      burstDir(parts, 'impact', x, y, z, 8, nX, nY, nZ, 1.2);
    } else if (surface === 'wood' || surface === 'dirt') {
      burstDir(parts, 'impact', x, y, z, 5, nX, nY, nZ, 0.8);
      burstDir(parts, 'debris', x, y, z, 2, nX, nY, nZ, 0.5);
    } else {
      burstDir(parts, 'impact', x, y, z, 6, nX, nY, nZ, 1);
    }
    if (sfx && sfx.bulletImpact) sfx.bulletImpact(surface, p);
    if (sfx && sfx.ricochet && surface !== 'water' && this.rng.chance(0.18)) sfx.ricochet(p);
    this._requestDecal(x, y, z, hit.normal, surface);
    return dmg;
  }

  /**
   * Queues a bullet-hole decal. Uses the renderer's decal API when one exists and otherwise
   * leaves the request in `game.ext.decals` (a bounded ring buffer) for whoever wants it.
   * @param {number} x World x.
   * @param {number} y World y.
   * @param {number} z World z.
   * @param {ArrayLike<number>} normal Surface normal.
   * @param {string} surface Surface name.
   * @private
   */
  _requestDecal(x, y, z, normal, surface) {
    const game = this.game;
    const nx = fin(normal ? normal[0] : 0, 0);
    const ny = fin(normal ? normal[1] : 1, 1);
    const nz = fin(normal ? normal[2] : 0, 0);
    const r = game.renderer;
    if (r && typeof r.addDecal === 'function') {
      r.addDecal(x, y, z, nx, ny, nz, surface === 'glass' ? 'crack' : 'bullet', 0.18);
      return;
    }
    if (game.world && typeof game.world.addDecal === 'function') {
      game.world.addDecal(x, y, z, nx, ny, nz, surface === 'glass' ? 'crack' : 'bullet', 0.18);
      return;
    }
    const q = game.ext && game.ext.decals;
    if (!Array.isArray(q)) return;
    if (q.length >= 128) q.shift();
    q.push({
      x, y, z, nx, ny, nz, size: 0.18, surface,
      kind: surface === 'glass' ? 'crack' : 'bullet',
      time: game.time ? game.time.now : 0,
    });
  }

  /**
   * Muzzle flash, smoke, shell ejection and the short dynamic light.
   * @param {Object} def Weapon definition.
   * @param {number[]} origin Muzzle position.
   * @param {number[]} dir Fire direction.
   * @param {boolean} ownerIsPlayer Whether the player fired.
   * @private
   */
  _muzzleEffects(def, origin, dir, ownerIsPlayer) {
    const game = this.game;
    const parts = game.particles;
    let mx = origin[0];
    let my = origin[1];
    let mz = origin[2];
    if (ownerIsPlayer && this._playerMuzzle(_muzzle)) {
      mx = _muzzle[0]; my = _muzzle[1]; mz = _muzzle[2];
    }
    const fx = mx + dir[0] * 0.28;
    const fy = my + dir[1] * 0.28;
    const fz = mz + dir[2] * 0.28;

    if (parts && parts.burst) {
      // 'muzzle' is flash + sparks + smoke in one preset, with its own short-lived light.
      const power = clamp(def.damage * 0.02 + def.pellets * 0.22 + 0.5, 0.6, 2.4);
      burstDir(parts, 'muzzle', fx, fy, fz, 7, dir[0], dir[1], dir[2], power);
      // Brass out of the ejection port, to the right of the aim direction.
      const rx = dir[2];
      const rz = -dir[0];
      const rl = Math.hypot(rx, rz) || 1;
      _sdir[0] = rx / rl;
      _sdir[1] = 0.2;
      _sdir[2] = rz / rl;
      _sopts.power = def.key === 'shotgun' ? 1.1 : 0.8;
      _sopts.dir = _sdir;
      _sopts.groundY = my - 1.35;
      parts.burst('shell', mx, my, mz, 1, _sopts);
    }

    this._flash.t = MUZZLE_LIGHT_TIME;
    this._flash.x = fx;
    this._flash.y = fy;
    this._flash.z = fz;
    this._flash.power = clamp(def.damage * 0.03 + def.pellets * 0.35, 0.6, 4);

    if (game.sfx && game.sfx.gunshot) {
      game.sfx.gunshot(def.sfx, origin, { gain: ownerIsPlayer ? 1 : 0.85 });
    }
  }

  /**
   * Applies recoil to the camera and the local view-kick fallback.
   * @param {Object} def Weapon definition.
   * @private
   */
  _applyRecoil(def) {
    const game = this.game;
    const aiming = game.player && game.player.aiming;
    const scale = aiming ? 0.65 : 1;
    const pitch = def.recoil * scale;
    const yaw = def.recoilYaw * scale * this.rng.sign() * (0.4 + this.rng.next() * 0.6);
    this.viewKick.pitch += pitch;
    this.viewKick.yaw += yaw;
    if (typeof game.addRecoil === 'function') game.addRecoil(pitch, yaw);
    if (typeof game.shakeCamera === 'function') game.shakeCamera(def.shake * scale, 0.18);
  }

  /**
   * Dry-fire click plus an automatic reload attempt.
   * @param {Object} def Weapon definition.
   * @private
   */
  _dryFire(def) {
    if (this._dryClick > 0) return;
    this._dryClick = 0.35;
    const game = this.game;
    const a = this.ammoFor();
    if (a.reserve > 0) {
      this.reload();
    } else {
      if (game.sfx && game.sfx.uiClick) game.sfx.uiClick('deny');
      if (game.hud && game.hud.notify) game.hud.notify(`${def.nameKo} 탄약 없음`, 'warn', 2);
    }
  }

  /**
   * Wakes up peds and (rarely) the police when a gun goes off.
   * @param {Object} def Weapon definition.
   * @param {number[]} pos Shot position.
   * @param {boolean} ownerIsPlayer Whether the player fired.
   * @private
   */
  _alertWorld(def, pos, ownerIsPlayer) {
    const game = this.game;
    if (game.peds && typeof game.peds.alertGunshot === 'function') {
      game.peds.alertGunshot(pos, def.loudness);
    }
    if (game.traffic && typeof game.traffic.alert === 'function') {
      game.traffic.alert(pos, def.loudness * 0.6);
    }
    if (!ownerIsPlayer) return;
    if (this._shotReport > 0) return;
    this._shotReport = SHOT_REPORT_COOLDOWN;
    const police = game.police;
    if (!police) return;
    const wanted = fin(police.wanted, 0);
    if (wanted >= 1) return;
    // Only a witnessed shot draws attention.
    const peds = game.peds && game.peds.peds;
    let witness = false;
    if (peds && peds.length) {
      for (let i = 0; i < peds.length; i++) {
        if (!pedAlive(peds[i])) continue;
        if (!readPosition(peds[i], _pedPos)) continue;
        const d = Math.hypot(_pedPos[0] - pos[0], _pedPos[2] - pos[2]);
        if (d < 28) { witness = true; break; }
      }
    }
    if (!witness) return;
    if (typeof police.reportCrime === 'function') police.reportCrime('shooting', pos);
    else if (typeof police.addWanted === 'function') police.addWanted(1, 'shooting');
  }

  // ================================================================ tracers

  /**
   * @param {number[]} origin Start.
   * @param {number[]} dir Direction.
   * @param {number} dist Travel distance.
   * @param {Object} def Weapon definition.
   * @private
   */
  _spawnTracer(origin, dir, dist, def) {
    const list = this._tracers;
    let t = null;
    for (let i = 0; i < list.length; i++) {
      if (!list[i].active) { t = list[i]; break; }
    }
    if (!t) return;
    let x = origin[0];
    let y = origin[1];
    let z = origin[2];
    if (this._playerMuzzle(_muzzle) && this.game.player && !this.game.player.dead) {
      // Start the visible streak at the barrel, not at the camera.
      x = _muzzle[0]; y = _muzzle[1]; z = _muzzle[2];
    }
    t.active = true;
    t.x = x; t.y = y; t.z = z;
    t.dx = dir[0]; t.dy = dir[1]; t.dz = dir[2];
    t.speed = Math.max(120, def.muzzleVelocity * 0.5);
    t.travelled = 0;
    t.dist = Math.max(1, dist);
    t.life = t.dist / t.speed + 0.05;
    t.bright = def.key === 'sniper' ? 1.6 : 1;
    t.r = 1; t.g = 0.78; t.b = 0.35;
  }

  /**
   * @param {number} dt Seconds.
   * @private
   */
  _updateTracers(dt) {
    const parts = this.game.particles;
    const list = this._tracers;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!t.active) continue;
      const step = Math.min(t.speed * dt, t.dist - t.travelled);
      t.travelled += step;
      t.x += t.dx * step;
      t.y += t.dy * step;
      t.z += t.dz * step;
      t.life -= dt;
      if (parts && parts.spawn) {
        // A stretched additive spark at the head of the round: reads as a real tracer streak.
        _tracerOpts.x = t.x;
        _tracerOpts.y = t.y;
        _tracerOpts.z = t.z;
        _tracerOpts.vx = t.dx * t.speed * 0.35;
        _tracerOpts.vy = t.dy * t.speed * 0.35;
        _tracerOpts.vz = t.dz * t.speed * 0.35;
        _tracerOpts.size = 0.06 * t.bright;
        parts.spawn(_tracerOpts);
      }
      if (t.travelled >= t.dist - 1e-3 || t.life <= 0) t.active = false;
    }
  }

  // ================================================================ grenades

  /**
   * Throws a grenade from the muzzle.
   * @param {Object} def Weapon definition.
   * @param {boolean} ownerIsPlayer Whether the player threw it.
   * @param {Object|null} shooter Thrower.
   * @private
   */
  _throwGrenade(def, ownerIsPlayer, shooter) {
    const game = this.game;
    const list = this._grenades;
    let g = null;
    for (let i = 0; i < list.length; i++) {
      if (!list[i].active) { g = list[i]; break; }
    }
    if (!g) return;
    let vx = 0;
    let vz = 0;
    if (ownerIsPlayer && game.player && game.player.velocity) {
      vx = fin(game.player.velocity[0], 0) * 0.5;
      vz = fin(game.player.velocity[2], 0) * 0.5;
    }
    const speed = fin(def.throwSpeed, def.muzzleVelocity);
    g.active = true;
    g.x = _origin[0] + _dir[0] * 0.4;
    g.y = _origin[1] + _dir[1] * 0.4;
    g.z = _origin[2] + _dir[2] * 0.4;
    g.vx = _dir[0] * speed + vx;
    g.vy = _dir[1] * speed + 3.4;
    g.vz = _dir[2] * speed + vz;
    g.fuse = def.fuse;
    g.spin = this.rng.range(4, 9);
    g.trail = 0;
    g.owner = shooter;
    g.radius = def.blastRadius;
    g.damage = def.blastDamage;
    if (ownerIsPlayer) {
      this._setCharacterState('throw');
      if (game.hud && game.hud.notify) {
        const a = this.ammoFor('grenade');
        if (a.mag + a.reserve <= 0) game.hud.notify('수류탄 소진', 'warn', 2);
      }
    }
    if (game.sfx && game.sfx.uiClick) game.sfx.uiClick('throw');
    // Pull the next grenade off the belt (a "reload" for a thrown weapon).
    if (ownerIsPlayer) this.reload();
  }

  /**
   * Integrates grenades: gravity, swept collision with bounce, fuse and detonation.
   * @param {number} dt Seconds.
   * @private
   */
  _updateGrenades(dt) {
    const game = this.game;
    const coll = game.collision;
    const parts = game.particles;
    const list = this._grenades;
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      if (!g.active) continue;
      g.vy -= GRENADE_GRAVITY * dt;
      _sweepFrom[0] = g.x; _sweepFrom[1] = g.y; _sweepFrom[2] = g.z;
      _sweepTo[0] = g.x + g.vx * dt;
      _sweepTo[1] = g.y + g.vy * dt;
      _sweepTo[2] = g.z + g.vz * dt;

      let moved = false;
      if (coll && typeof coll.sweepSphere === 'function') {
        const h = coll.sweepSphere(_sweepFrom, _sweepTo, GRENADE_RADIUS);
        if (h && Number.isFinite(h.t) && h.t >= 0 && h.t <= 1) {
          const hx = h.hit && Number.isFinite(h.hit[0]) ? h.hit[0]
            : _sweepFrom[0] + (_sweepTo[0] - _sweepFrom[0]) * h.t;
          const hy = h.hit && Number.isFinite(h.hit[1]) ? h.hit[1]
            : _sweepFrom[1] + (_sweepTo[1] - _sweepFrom[1]) * h.t;
          const hz = h.hit && Number.isFinite(h.hit[2]) ? h.hit[2]
            : _sweepFrom[2] + (_sweepTo[2] - _sweepFrom[2]) * h.t;
          const nx = fin(h.normal ? h.normal[0] : 0, 0);
          const ny = fin(h.normal ? h.normal[1] : 1, 1);
          const nz = fin(h.normal ? h.normal[2] : 0, 0);
          g.x = hx + nx * 0.02;
          g.y = hy + ny * 0.02;
          g.z = hz + nz * 0.02;
          const dot = g.vx * nx + g.vy * ny + g.vz * nz;
          g.vx = (g.vx - 2 * dot * nx) * GRENADE_BOUNCE;
          g.vy = (g.vy - 2 * dot * ny) * GRENADE_BOUNCE;
          g.vz = (g.vz - 2 * dot * nz) * GRENADE_BOUNCE;
          // Tangential friction so it does not slide forever.
          g.vx *= 0.86; g.vz *= 0.86;
          if (game.sfx && game.sfx.bulletImpact && Math.abs(dot) > 1.2) {
            _tmp[0] = g.x; _tmp[1] = g.y; _tmp[2] = g.z;
            game.sfx.bulletImpact('metal', _tmp);
          }
          moved = true;
        }
      }
      if (!moved) {
        g.x = _sweepTo[0];
        g.y = _sweepTo[1];
        g.z = _sweepTo[2];
        // Ground clamp as a safety net when the sweep missed the terrain.
        if (typeof game.worldToGround === 'function') {
          const gy = game.worldToGround(g.x, g.z);
          if (Number.isFinite(gy) && g.y < gy + GRENADE_RADIUS) {
            g.y = gy + GRENADE_RADIUS;
            if (g.vy < 0) g.vy = -g.vy * GRENADE_BOUNCE;
            g.vx *= 0.82; g.vz *= 0.82;
          }
        }
      }

      g.trail -= dt;
      if (g.trail <= 0 && parts && parts.burst) {
        g.trail = 0.07;
        burstDir(parts, 'smoke', g.x, g.y, g.z, 1, 0, 1, 0, 0.3);
      }

      g.fuse -= dt;
      if (g.fuse <= 0) {
        g.active = false;
        if (typeof game.explosionAt === 'function') {
          game.explosionAt(g.x, g.y, g.z, g.radius, g.damage, g.owner || 'grenade');
        }
      }
    }
  }

  // ================================================================ per-frame

  /**
   * Advances timers, input, tracers and grenades.
   * @param {number} dt Seconds.
   * @returns {void}
   */
  update(dt) {
    const step = Number.isFinite(dt) ? clamp(dt, 0, 0.25) : 0;
    const game = this.game;
    const def = this.def();

    this.cooldown = Math.max(0, this.cooldown - step);
    this.equipLeft = Math.max(0, this.equipLeft - step);
    this._dryClick = Math.max(0, this._dryClick - step);
    this._shotReport = Math.max(0, this._shotReport - step);
    this._flash.t = Math.max(0, this._flash.t - step);

    this._updateReload(step);

    // Bloom shrinks while the player holds fire.
    this.bloom = Math.max(0, damp(this.bloom, 0, def.bloomRecover > 0 ? 1 / def.bloomRecover : 8, step));
    this.viewKick.pitch = damp(this.viewKick.pitch, 0, def.recoilRecover, step);
    this.viewKick.yaw = damp(this.viewKick.yaw, 0, def.recoilRecover, step);

    // Scope zoom, published for the camera / HUD.
    const wantZoom = this.isScoped() ? def.zoom : 1;
    this.zoom = damp(this.zoom, wantZoom, 12, step);
    if (game && game.ext) game.ext.weaponZoom = this.zoom;

    this._handleInput(step);
    this._updateTracers(step);
    this._updateGrenades(step);
  }

  /**
   * Reads fire / reload / weapon-switch input for the player.
   * @param {number} dt Seconds.
   * @private
   */
  _handleInput(dt) {
    const game = this.game;
    const input = game && game.input;
    if (!input) return;
    if (game.paused || !game.started || (game.player && game.player.dead)) {
      this._fireHeld = false;
      return;
    }
    if (input.blocked) { this._fireHeld = false; return; }

    // --- weapon selection -----------------------------------------------------------------
    for (let s = 1; s <= 5; s++) {
      if (input.justPressed && input.justPressed(`weapon${s}`)) this.selectSlot(s);
    }
    if (typeof input.consumeWheel === 'function') {
      const w = input.consumeWheel();
      if (w > 0) this.nextWeapon();
      else if (w < 0) this.prevWeapon();
    }
    if (input.justPressed && input.justPressed('reload')) this.reload();

    // --- trigger ---------------------------------------------------------------------------
    const player = game.player;
    if (player && player.vehicle) { this._fireHeld = false; return; }
    const down = !!(input.isDown && input.isDown('fire'));
    const def = this.def();
    const fresh = down && !this._fireHeld;
    this._fireHeld = down;
    if (!down) return;
    if (!def.auto && !fresh) return;
    if (this.cooldown > 0 || this.equipLeft > 0) return;
    this._playerFire();
  }

  /**
   * Fires from the player's muzzle towards whatever the camera crosshair covers.
   * @returns {boolean} True when a shot was fired.
   * @private
   */
  _playerFire() {
    const game = this.game;
    const cam = game.camera;
    const def = this.def();
    if (!cam || !cam.position || !cam.forward) return false;
    const cx = fin(cam.position[0], 0);
    const cy = fin(cam.position[1], 0);
    const cz = fin(cam.position[2], 0);
    let fx = fin(cam.forward[0], 0);
    let fy = fin(cam.forward[1], 0);
    let fz = fin(cam.forward[2], -1);
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;

    // 1. Where is the crosshair pointing?
    _tmp[0] = cx; _tmp[1] = cy; _tmp[2] = cz;
    _aimDir[0] = fx; _aimDir[1] = fy; _aimDir[2] = fz;
    let focusT = def.range;
    const coll = game.collision;
    if (coll && typeof coll.raycast === 'function') {
      const h = coll.raycast(_tmp, _aimDir, def.range, null);
      if (h && Number.isFinite(h.t) && h.t > 0.6) focusT = h.t;
    }
    _focus[0] = cx + fx * focusT;
    _focus[1] = cy + fy * focusT;
    _focus[2] = cz + fz * focusT;

    // 2. Fire from the barrel towards that point.
    if (!this._playerMuzzle(_muzzle)) {
      _muzzle[0] = cx + fx * 0.5;
      _muzzle[1] = cy + fy * 0.5;
      _muzzle[2] = cz + fz * 0.5;
    }
    let dx = _focus[0] - _muzzle[0];
    let dy = _focus[1] - _muzzle[1];
    let dz = _focus[2] - _muzzle[2];
    const dl = Math.hypot(dx, dy, dz);
    if (!(dl > 1e-4)) { dx = fx; dy = fy; dz = fz; } else { dx /= dl; dy /= dl; dz /= dl; }
    _tmp[0] = dx; _tmp[1] = dy; _tmp[2] = dz;
    return this.tryFire(_muzzle, _tmp, true, 1, null);
  }

  /**
   * Reads the player's weapon muzzle position.
   * @param {number[]} out Destination.
   * @returns {boolean} True when a finite muzzle was found.
   * @private
   */
  _playerMuzzle(out) {
    const p = this.game && this.game.player;
    if (!p || !p.character) return false;
    const ch = p.character;
    if (typeof ch.getMuzzleOrigin === 'function') {
      const r = ch.getMuzzleOrigin(out);
      const v = r || out;
      if (v && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2])) {
        out[0] = v[0]; out[1] = v[1]; out[2] = v[2];
        return true;
      }
    }
    if (!p.position || !Number.isFinite(p.position[0])) return false;
    const yaw = fin(p.yaw, 0);
    out[0] = p.position[0] - Math.sin(yaw) * 0.35 + Math.cos(yaw) * 0.22;
    out[1] = p.position[1] + 1.36;
    out[2] = p.position[2] - Math.cos(yaw) * 0.35 - Math.sin(yaw) * 0.22;
    return true;
  }

  /**
   * Position used for weapon audio (the player, or the origin of the last shot).
   * @param {Object} game Game.
   * @returns {ArrayLike<number>} World position.
   * @private
   */
  _ownerPos(game) {
    if (game.player && game.player.position && Number.isFinite(game.player.position[0])) {
      return game.player.position;
    }
    return _origin;
  }

  /**
   * Hands an animation state to the player character, tolerating rigs that do not know it.
   * `equip` / `throw` fall back to the closest state every rig implements.
   * @param {string|null} name State name, or null to release the override.
   * @private
   */
  _setCharacterState(name) {
    const p = this.game && this.game.player;
    if (!p || !p.character || typeof p.character.setState !== 'function') return;
    const mapped = name === 'equip' ? 'reload' : name === 'throw' ? 'shoot' : name;
    try {
      if (mapped) p.character.setState(mapped, { weapon: this.current });
      else p.character.setState(p.aiming ? 'aim' : 'idle');
    } catch (err) {
      /* the rig does not implement this state — the base locomotion state stays */
    }
  }

  // ================================================================ rendering

  /**
   * Submits the muzzle light, tracer lights and grenade meshes for this frame.
   * @param {Object} renderer Renderer.
   * @param {number} [dt=0] Frame time (unused, kept for the system submit signature).
   * @returns {void}
   */
  submit(renderer, dt = 0) {
    if (!renderer) return;
    const f = this._flash;
    if (f.t > 0 && typeof renderer.submitLight === 'function') {
      const k = clamp(f.t / MUZZLE_LIGHT_TIME, 0, 1) * f.power;
      renderer.submitLight(f.x, f.y, f.z, 1, 0.82, 0.45, 7.5, 6 * k);
    }
    let lights = 0;
    const tracers = this._tracers;
    for (let i = 0; i < tracers.length && lights < MAX_TRACER_LIGHTS; i++) {
      const t = tracers[i];
      if (!t.active) continue;
      if (typeof renderer.submitLight === 'function') {
        renderer.submitLight(t.x, t.y, t.z, t.r, t.g, t.b, 3.2, 0.9 * t.bright);
        lights++;
      }
    }
    this._submitGrenades(renderer);
  }

  /**
   * Draws live grenades (lazily building a tiny mesh the first time).
   * @param {Object} renderer Renderer.
   * @private
   */
  _submitGrenades(renderer) {
    let any = false;
    const list = this._grenades;
    for (let i = 0; i < list.length; i++) {
      if (list[i].active) { any = true; break; }
    }
    if (!any) return;
    if (!this._meshes && !this._meshFailed) this._buildMeshes(renderer);
    const m = this._meshes;
    const time = this.game && this.game.time ? this.game.time.now : 0;
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      if (!g.active) continue;
      if (m && typeof renderer.submit === 'function') {
        const a = time * g.spin;
        const c = Math.cos(a);
        const s = Math.sin(a);
        _matrix[0] = c; _matrix[1] = 0; _matrix[2] = -s; _matrix[3] = 0;
        _matrix[4] = 0; _matrix[5] = 1; _matrix[6] = 0; _matrix[7] = 0;
        _matrix[8] = s; _matrix[9] = 0; _matrix[10] = c; _matrix[11] = 0;
        _matrix[12] = g.x; _matrix[13] = g.y; _matrix[14] = g.z; _matrix[15] = 1;
        renderer.submit(m.mesh, m.material, _matrix, null);
      }
      // Blinking fuse light: faster as the fuse runs out.
      if (typeof renderer.submitLight === 'function') {
        const blink = Math.sin(time * (14 + (3 - g.fuse) * 12)) * 0.5 + 0.5;
        renderer.submitLight(g.x, g.y + 0.1, g.z, 1, 0.25, 0.12, 2.6, 0.8 + blink * 1.6);
      }
    }
  }

  /**
   * Builds the grenade mesh + material once.
   * @param {Object} renderer Renderer.
   * @private
   */
  _buildMeshes(renderer) {
    try {
      if (typeof renderer.createMesh !== 'function') { this._meshFailed = true; return; }
      const geo = grenadeGeometry();
      const mesh = renderer.createMesh(geo);
      const material = typeof renderer.createMaterial === 'function'
        ? renderer.createMaterial({
          name: 'grenade', albedo: [0.15, 0.19, 0.13], roughness: 0.55, metallic: 0.35,
          emissive: [0.5, 0.06, 0.03], emissiveStrength: 1.4,
        })
        : null;
      this._meshes = { mesh, material };
    } catch (err) {
      this._meshFailed = true;
    }
  }

  // ================================================================ persistence

  /**
   * @returns {{current:string, owned:string[], ammo:Record<string,{mag:number,reserve:number}>}}
   *   Save payload.
   */
  serialize() {
    /** @type {Record<string, {mag:number, reserve:number}>} */
    const ammo = {};
    for (const k of WEAPON_ORDER) ammo[k] = { mag: this.ammo[k].mag, reserve: this.ammo[k].reserve };
    return { current: this.current, owned: Array.from(this.owned), ammo };
  }

  /**
   * @param {Object} data Payload produced by {@link WeaponSystem#serialize}.
   * @returns {void}
   */
  deserialize(data) {
    if (!data) return;
    this.owned = new Set(['fist']);
    if (Array.isArray(data.owned)) {
      for (const k of data.owned) if (WEAPONS[k]) this.owned.add(k);
    }
    if (data.ammo) {
      for (const k of WEAPON_ORDER) {
        const src = data.ammo[k];
        if (!src) continue;
        const a = this.ammoFor(k);
        a.mag = clamp(fin(src.mag, 0), 0, WEAPONS[k].magazine);
        a.reserve = clamp(fin(src.reserve, 0), 0, fin(WEAPONS[k].reserveMax, 999));
      }
    }
    this.reloading = false;
    this.reloadLeft = 0;
    this.reloadDuration = 0;
    this.cooldown = 0;
    this.equipLeft = 0;
    this.current = 'fist';
    if (data.current && WEAPONS[data.current]) this.switchTo(data.current);
  }

  /**
   * Clears live projectiles and resets the firing state (used on respawn / mission reset).
   * @returns {void}
   */
  reset() {
    for (let i = 0; i < this._tracers.length; i++) this._tracers[i].active = false;
    for (let i = 0; i < this._grenades.length; i++) this._grenades[i].active = false;
    this.reloading = false;
    this._shellReload = false;
    this.reloadLeft = 0;
    this.reloadDuration = 0;
    this.cooldown = 0;
    this.equipLeft = 0;
    this.bloom = 0;
    this.viewKick.pitch = 0;
    this.viewKick.yaw = 0;
    this._flash.t = 0;
    this._fireHeld = false;
  }
}

/**
 * Small faceted ball used to draw a live grenade. Built inline so this module does not depend on
 * the geometry builders being loaded before the first throw.
 * @returns {{positions:Float32Array, normals:Float32Array, uvs:Float32Array, indices:Uint16Array}}
 *   Geometry object accepted by `renderer.createMesh`.
 */
function grenadeGeometry() {
  const R = 0.085;
  const H = 0.06;
  const seg = 8;
  const rings = 4;
  const verts = (rings + 1) * (seg + 1);
  const positions = new Float32Array(verts * 3);
  const normals = new Float32Array(verts * 3);
  const uvs = new Float32Array(verts * 2);
  let p = 0;
  let u = 0;
  for (let r = 0; r <= rings; r++) {
    const v = r / rings;
    const phi = v * Math.PI;
    const sy = Math.cos(phi);
    const sr = Math.sin(phi);
    for (let s = 0; s <= seg; s++) {
      const t = s / seg;
      const th = t * Math.PI * 2;
      const nx = Math.cos(th) * sr;
      const ny = sy;
      const nz = Math.sin(th) * sr;
      positions[p] = nx * R;
      positions[p + 1] = ny * (R + H * 0.5);
      positions[p + 2] = nz * R;
      normals[p] = nx;
      normals[p + 1] = ny;
      normals[p + 2] = nz;
      uvs[u] = t;
      uvs[u + 1] = v;
      p += 3;
      u += 2;
    }
  }
  const indices = new Uint16Array(rings * seg * 6);
  let i = 0;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < seg; s++) {
      const a = r * (seg + 1) + s;
      const b = a + seg + 1;
      indices[i] = a; indices[i + 1] = b; indices[i + 2] = a + 1;
      indices[i + 3] = a + 1; indices[i + 4] = b; indices[i + 5] = b + 1;
      i += 6;
    }
  }
  return { positions, normals, uvs, indices };
}
