/**
 * Pedestrian AI: the crowd that makes the city feel inhabited.
 *
 * Peds are streamed in and out of a ring around the player along `city.walks` (the sidewalk
 * graph). Each one owns a {@link Character}, a seeded appearance, a walking speed and a small
 * state machine (walk / idle / chat / cross / flee / cower / hit / dead). Steering is a
 * carrot-on-a-path follower with arrive-and-turn behaviour plus three corrective forces:
 * separation from other peds, evasion of moving vehicles, and a spring that pulls a ped that
 * drifted off the sidewalk back onto the walk graph. The final position always goes through
 * `CollisionWorld.moveCapsule`, so a ped can never end up inside a building.
 *
 * Everything is pooled: ped records, `Character` instances (bucketed by kind and sex) and the
 * scratch vectors used by the steering maths. The per-frame loops allocate nothing.
 *
 * LOD: peds within 45 m update every frame, up to 80 m every second frame, beyond that every
 * fourth frame; the accumulated delta is handed to `Character.update`, which throttles its own
 * animation sampling on top of that.
 *
 * @module entities/ped
 */

import { clamp, wrapAngle, angleDamp, Rand } from '../core/math.js';
import { Character } from './character.js';
import { PathGraph } from './traffic.js';

/* ------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------ */

/** Hard cap on live pedestrians. */
const MAX_PEDS = 60;
/** Inner radius of the preferred spawn annulus (metres). */
const SPAWN_MIN = 68;
/** Outer radius of the preferred spawn annulus (metres). */
const SPAWN_MAX = 102;
/** Inner radius of the fallback annulus, which only accepts hidden spots (metres). */
const SPAWN_NEAR = 26;
/** Peds beyond this distance are recycled (metres). */
const DESPAWN_DIST = 140;
/** Spawn attempts allowed per frame. */
const SPAWN_BUDGET = 2;
/** Candidate walk samples examined per spawn attempt. */
const SPAWN_TRIES = 12;
/** Minimum spacing between a new ped and existing ones (metres). */
const SPAWN_CLEAR = 2.6;
/** Look-ahead distance of the path carrot (metres). */
const CARROT = 2.4;
/** Route ring buffer length (current walk + look-ahead walks). */
const ROUTE_LEN = 4;
/** Capsule radius used for collision (metres). */
const PED_RADIUS = 0.3;
/** Capsule height used for collision (metres). */
const PED_HEIGHT = 1.72;
/** Gravity applied to peds (m/s^2). */
const GRAVITY = 18;
/** Distance at which the separation force starts acting (metres). */
const SEP_RADIUS = 1.25;
/** Distance at which peds notice a moving car (metres). */
const CAR_FEAR = 9;
/** Distance from the walk graph at which a ped is pulled back (metres). */
const LEASH = 1.6;
/** Hard limit past which a ped is teleported back onto the graph (metres). */
const LEASH_HARD = 9;
/** Seconds a corpse stays in the world. */
const BODY_TIME = 25;
/** Seconds a ped keeps fleeing after being scared. */
const FLEE_TIME = 11;
/** Seconds a cowering ped stays down. */
const COWER_TIME = 6.5;
/** Seconds a ped is staggered after taking a non-lethal hit. */
const HIT_TIME = 0.55;
/** Longest wait at a kerb before a ped jaywalks anyway (seconds). */
const CROSS_PATIENCE = 9;
/** Minimum seconds between two screams anywhere in the crowd. */
const SCREAM_COOLDOWN = 0.28;
/** Vehicle speed above which a collision is lethal (m/s). */
const LETHAL_CAR_SPEED = 4.2;
/** Vehicle speed above which a collision knocks a ped down (m/s). */
const KNOCKDOWN_CAR_SPEED = 1.7;
/** Draw distance for pedestrians (metres). */
const DRAW_DIST = 170;
/** Health of a civilian. */
const PED_HEALTH = 100;

/** Linear-rgb appearance tables used when a pooled character is re-dressed. */
const SKIN_TONES = [
  [0.84, 0.68, 0.55], [0.76, 0.58, 0.45], [0.63, 0.45, 0.33],
  [0.46, 0.31, 0.21], [0.30, 0.19, 0.13], [0.90, 0.76, 0.65],
];
const HAIR_TONES = [
  [0.045, 0.035, 0.030], [0.13, 0.08, 0.045], [0.32, 0.20, 0.09],
  [0.58, 0.46, 0.28], [0.28, 0.28, 0.30], [0.66, 0.66, 0.68], [0.36, 0.10, 0.06],
];
const SHIRT_TONES = [
  [0.62, 0.63, 0.66], [0.10, 0.13, 0.22], [0.44, 0.09, 0.11], [0.09, 0.24, 0.18],
  [0.72, 0.55, 0.18], [0.20, 0.20, 0.24], [0.55, 0.30, 0.45], [0.12, 0.32, 0.48],
  [0.80, 0.80, 0.82], [0.34, 0.14, 0.32],
];
const PANTS_TONES = [
  [0.10, 0.12, 0.20], [0.16, 0.16, 0.18], [0.06, 0.06, 0.07],
  [0.30, 0.26, 0.20], [0.22, 0.14, 0.10], [0.14, 0.20, 0.16],
];
const SHOE_TONES = [
  [0.05, 0.05, 0.06], [0.14, 0.09, 0.06], [0.70, 0.70, 0.72], [0.22, 0.22, 0.24],
];

/* ------------------------------------------------------------------ *
 * Module scratch
 * ------------------------------------------------------------------ */

const _pt = new Float32Array(2);
const _pt2 = new Float32Array(2);
const _delta = new Float32Array(3);
const _dir3 = new Float32Array(3);
const _hitPoint = new Float32Array(3);
const _cand = new Int32Array(512);
const _move = { x: 0, y: 0, z: 0, grounded: false, groundY: 0, normal: new Float32Array([0, 1, 0]), hits: 0 };
const _ctx = {
  moveSpeed: 0, aiming: false, aimPitch: 0, grounded: true, crouching: false,
  lookYaw: 0, distance: 0,
};
const _rayHit = { ped: null, t: 0, point: new Float32Array(3), headshot: false };

/** Nearest ped-shaped record found by the current {@link PedManager#raycastPeds} call. */
let _rayBest = null;
/** Distance to {@link _rayBest} along the ray. */
let _rayBestT = 0;
/** Whether {@link _rayBest} was hit in the head. */
let _rayBestHead = false;

/**
 * Reads a number defensively.
 * @param {*} v Value.
 * @param {number} d Fallback.
 * @returns {number} `v` when finite, otherwise `d`.
 */
function fin(v, d) {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/**
 * Ray against an upright cylinder with flat caps (a good-enough body capsule).
 * @param {number} ox Ray origin x.
 * @param {number} oy Ray origin y.
 * @param {number} oz Ray origin z.
 * @param {number} dx Ray direction x (unit).
 * @param {number} dy Ray direction y (unit).
 * @param {number} dz Ray direction z (unit).
 * @param {number} cx Cylinder axis x.
 * @param {number} cz Cylinder axis z.
 * @param {number} yLo Bottom of the cylinder.
 * @param {number} yHi Top of the cylinder.
 * @param {number} r Radius.
 * @param {number} maxT Maximum distance.
 * @returns {number} Distance along the ray, or -1.
 */
function rayCylinderY(ox, oy, oz, dx, dy, dz, cx, cz, yLo, yHi, r, maxT) {
  const mx = ox - cx;
  const mz = oz - cz;
  const a = dx * dx + dz * dz;
  const c = mx * mx + mz * mz - r * r;
  if (a < 1e-9) {
    // Ray is (near) vertical: it can only enter through a cap.
    if (c > 0 || Math.abs(dy) < 1e-9) return -1;
    const t = ((dy > 0 ? yLo : yHi) - oy) / dy;
    return t >= 0 && t <= maxT ? t : -1;
  }
  const b = 2 * (mx * dx + mz * dz);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  const inv = 0.5 / a;
  let t = (-b - sq) * inv;
  if (t < 0) t = (-b + sq) * inv;
  if (t < 0 || t > maxT) return -1;
  const y = oy + dy * t;
  if (y >= yLo && y <= yHi) return t;
  if (Math.abs(dy) < 1e-9) return -1;
  const capY = y > yHi ? yHi : yLo;
  const tc = (capY - oy) / dy;
  if (tc < 0 || tc > maxT) return -1;
  const px = ox + dx * tc - cx;
  const pz = oz + dz * tc - cz;
  return px * px + pz * pz <= r * r ? tc : -1;
}

/**
 * Ray against a sphere.
 * @param {number} ox Ray origin x.
 * @param {number} oy Ray origin y.
 * @param {number} oz Ray origin z.
 * @param {number} dx Direction x (unit).
 * @param {number} dy Direction y (unit).
 * @param {number} dz Direction z (unit).
 * @param {number} cx Centre x.
 * @param {number} cy Centre y.
 * @param {number} cz Centre z.
 * @param {number} r Radius.
 * @param {number} maxT Maximum distance.
 * @returns {number} Distance along the ray, or -1.
 */
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, maxT) {
  const mx = ox - cx;
  const my = oy - cy;
  const mz = oz - cz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - r * r;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t < 0) t = -b + sq;
  return t >= 0 && t <= maxT ? t : -1;
}

/**
 * Creates a blank ped record. Records are pooled and reused forever.
 * @param {number} id Stable slot id.
 * @returns {object} Ped record.
 */
function makePed(id) {
  return {
    id,
    active: false,
    character: null,
    /** @type {Float32Array} World position of the feet. */
    position: new Float32Array(3),
    velocity: new Float32Array(3),
    yaw: 0,
    speed: 0,
    vy: 0,
    grounded: true,

    state: 'walk',
    stateTime: 0,
    timer: 0,
    idleKind: 0,

    health: PED_HEALTH,
    maxHealth: PED_HEALTH,
    dead: false,
    bodyTimer: 0,
    hitTimer: 0,

    walkId: -1,
    route: new Int32Array(ROUTE_LEN),
    routeLen: 0,
    carrot: 0,
    walkSpeed: 1.35,
    runSpeed: 4.8,

    threatX: 0,
    threatZ: 0,
    hasThreat: false,
    scared: 0,
    screamed: false,

    partner: null,
    crossAxis: 'x',
    crossNode: -1,
    crossWait: 0,
    crossing: false,

    accum: 0,
    phase: 0,
    lod: 0,
    distToPlayer: 1e9,

    kind: 'civ',
    female: false,
    seed: 1,
    bucket: 'civM',

    missionOwned: false,
    persistent: false,
    noDespawn: false,
    hostile: false,
    aggressive: false,
    armed: false,
    weapon: null,
  };
}

/* ------------------------------------------------------------------ *
 * PedManager
 * ------------------------------------------------------------------ */

/**
 * Streams, steers, animates and draws the pedestrian crowd.
 */
export class PedManager {
  /**
   * @param {object} game The {@link Game} instance (see docs/ARCHITECTURE.md section 16).
   */
  constructor(game) {
    /** @type {object} */
    this.game = game;
    /** @type {object} */
    this.city = (game && game.city) || { walks: [], lanes: [] };
    /** @type {Rand} Seeded generator; never `Math.random`. */
    this.rng = game && game.rng && typeof game.rng.fork === 'function'
      ? game.rng.fork('peds') : new Rand(0xBEEF01);
    /** @type {PathGraph} Sidewalk graph index. */
    this.walks = new PathGraph(this.city.walks || [], { step: 4, cell: 24 });
    /** @type {object[]} Live pedestrians. */
    this.peds = [];
    /** @type {number} Hard cap on live pedestrians. */
    this.maxPeds = MAX_PEDS;
    /** @type {boolean} Set false to freeze streaming. */
    this.streaming = true;
    /** @type {number} Corpses currently lying around. */
    this.bodies = 0;

    this._pool = [];
    this._charPool = new Map();
    this._nextId = 0;
    this._frame = 0;
    this._time = 0;
    this._screamTimer = 0;
    this._spawnCursor = 0;
    this._assets = (game && game.characterAssets) || null;
  }

  /* ---------------------------------------------------------------- pooling */

  /**
   * @returns {object} A recycled or fresh ped record.
   * @private
   */
  _acquireRecord() {
    if (this._pool.length > 0) return this._pool.pop();
    return makePed(this._nextId++);
  }

  /**
   * Builds (or recycles) a `Character` for a ped and randomises its clothes.
   * @param {object} ped Ped record.
   * @returns {object|null} Character, or null when the asset set is missing.
   * @private
   */
  _acquireCharacter(ped) {
    const assets = this._assets || (this.game && this.game.characterAssets) || null;
    if (!assets) return null;
    this._assets = assets;
    const bucket = ped.kind + (ped.female ? 'F' : 'M');
    ped.bucket = bucket;
    let list = this._charPool.get(bucket);
    if (!list) { list = []; this._charPool.set(bucket, list); }
    const rng = this.rng;
    let ch = list.length > 0 ? list.pop() : null;
    if (!ch) {
      try {
        ch = new Character(assets, {
          kind: ped.kind, female: ped.female, seed: ped.seed,
          height: ped.female ? rng.range(1.60, 1.74) : rng.range(1.70, 1.90),
          build: rng.range(0.88, 1.16),
        });
      } catch (err) {
        return null;
      }
    } else {
      // Re-dress the recycled body instead of allocating a new one.
      const c = ch.colors;
      c.skin = rng.pick(SKIN_TONES);
      c.hair = rng.pick(HAIR_TONES);
      if (ped.kind === 'civ') {
        c.shirt = rng.pick(SHIRT_TONES);
        c.pants = rng.pick(PANTS_TONES);
      }
      c.shoe = rng.pick(SHOE_TONES);
      ch.sleeves = rng.int(0, 2);
      ch.shorts = ped.kind === 'civ' && rng.chance(0.18);
      ch.skirt = ped.female && ped.kind === 'civ' && rng.chance(0.32);
      ch.bald = !ped.female && rng.chance(0.09);
      if (typeof ch.refreshAppearance === 'function') ch.refreshAppearance();
    }
    ch.visible = true;
    ch.lod = 0;
    return ch;
  }

  /**
   * Returns a character to its pool unless it has ragdolled (a ragdoll cannot be reset from
   * outside `character.js`, so those are simply dropped).
   * @param {object} ped Ped record.
   * @returns {void}
   * @private
   */
  _releaseCharacter(ped) {
    const ch = ped.character;
    ped.character = null;
    if (!ch) return;
    if (ch.dead || ch._ragActive) return;
    let list = this._charPool.get(ped.bucket);
    if (!list) { list = []; this._charPool.set(ped.bucket, list); }
    if (list.length < 24) {
      ch.visible = false;
      list.push(ch);
    }
  }

  /* ---------------------------------------------------------------- spawning */

  /**
   * Spawns a pedestrian at an exact position (used by missions and by ejected drivers).
   * @param {number} x World x.
   * @param {number} y World y (feet).
   * @param {number} z World z.
   * @param {object} [opts] `{kind, female, seed, health, walkSpeed}`.
   * @returns {object|null} The ped record, or null when the crowd is full.
   */
  spawnPed(x, y, z, opts) {
    // The cap is hard: an out-of-band spawn (an ejected driver, a mission ped) evicts the
    // pedestrian furthest from the player rather than growing the crowd.
    if (this.peds.length >= this.maxPeds && !this._makeRoom(x, z)) return null;
    const o = opts || {};
    const rng = this.rng;
    const ped = this._acquireRecord();

    ped.active = true;
    ped.kind = o.kind || 'civ';
    ped.female = o.female === undefined ? rng.chance(0.48) : !!o.female;
    ped.seed = o.seed === undefined ? rng.int(1, 0x7ffffff) : o.seed | 0;
    ped.character = this._acquireCharacter(ped);

    ped.position[0] = x;
    ped.position[1] = y;
    ped.position[2] = z;
    ped.velocity[0] = 0;
    ped.velocity[1] = 0;
    ped.velocity[2] = 0;
    ped.vy = 0;
    ped.grounded = true;
    ped.yaw = rng.range(-Math.PI, Math.PI);
    ped.speed = 0;

    ped.state = 'walk';
    ped.stateTime = 0;
    ped.timer = rng.range(4, 16);
    ped.idleKind = rng.int(0, 2);

    ped.maxHealth = fin(o.health, PED_HEALTH);
    ped.health = ped.maxHealth;
    ped.dead = false;
    ped.bodyTimer = 0;
    ped.hitTimer = 0;

    ped.walkSpeed = fin(o.walkSpeed, rng.range(1.05, 1.75));
    ped.runSpeed = ped.walkSpeed * rng.range(2.9, 3.6);

    ped.hasThreat = false;
    ped.scared = 0;
    ped.screamed = false;
    ped.partner = null;
    ped.crossing = false;
    ped.crossWait = 0;
    ped.crossNode = -1;

    ped.accum = 0;
    ped.phase = this._frame & 3;
    ped.lod = 0;
    ped.distToPlayer = 1e9;

    ped.missionOwned = false;
    ped.persistent = false;
    ped.noDespawn = false;
    ped.hostile = false;
    ped.aggressive = false;
    ped.armed = false;
    ped.weapon = null;

    ped.walkId = -1;
    ped.routeLen = 0;
    ped.carrot = 0;
    this._attachToGraph(ped);

    if (ped.character) {
      ped.character.position[0] = x;
      ped.character.position[1] = y;
      ped.character.position[2] = z;
      ped.character.yaw = ped.yaw;
      ped.character.setState('idle');
    }
    this.peds.push(ped);
    return ped;
  }

  /**
   * Evicts the pedestrian furthest from the player so a forced spawn stays inside the cap.
   * Mission-owned and no-despawn peds are never evicted.
   * @param {number} x Where the new ped wants to appear (x).
   * @param {number} z Where the new ped wants to appear (z).
   * @returns {boolean} True when a slot was freed.
   * @private
   */
  _makeRoom(x, z) {
    const pl = this.game.player;
    const px = pl && pl.position ? fin(pl.position[0], x) : x;
    const pz = pl && pl.position ? fin(pl.position[2], z) : z;
    let worst = -1;
    let worstD = -1;
    for (let i = 0; i < this.peds.length; i++) {
      const p = this.peds[i];
      if (p.missionOwned || p.noDespawn || p.persistent) continue;
      const dx = p.position[0] - px;
      const dz = p.position[2] - pz;
      // Corpses go first, then whoever is furthest away.
      const d = dx * dx + dz * dz + (p.dead ? 1e6 : 0);
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst < 0) return false;
    const ped = this.peds[worst];
    this.peds.splice(worst, 1);
    this._retire(ped);
    return true;
  }

  /**
   * Snaps a ped onto the nearest sidewalk and builds a fresh route.
   * @param {object} ped Ped record.
   * @returns {boolean} True when a walk was found.
   * @private
   */
  _attachToGraph(ped) {
    const g = this.walks;
    const near = g.nearest(ped.position[0], ped.position[2], 45);
    if (near < 0) { ped.walkId = -1; ped.routeLen = 0; return false; }
    ped.walkId = near;
    ped.carrot = Math.min(g.nearDist + CARROT, g.length(near));
    ped.routeLen = 0;
    this._extendRoute(ped);
    return true;
  }

  /**
   * Spawns up to `count` peds on sidewalks around a point.
   * @param {ArrayLike<number>} pos3 Centre (usually the player).
   * @param {number} count How many to try.
   * @returns {number} How many were created.
   */
  spawnAround(pos3, count) {
    let made = 0;
    const px = fin(pos3 ? pos3[0] : 0, 0);
    const pz = fin(pos3 ? pos3[2] : 0, 0);
    for (let i = 0; i < count; i++) {
      if (this.peds.length >= this.maxPeds) break;
      // The initial population is allowed close in; streaming keeps its distance.
      if (this._trySpawn(px, pz, i < count * 0.5 ? 8 : SPAWN_MIN, SPAWN_MAX)) made++;
    }
    return made;
  }

  /**
   * One streaming spawn attempt inside an annulus.
   * @param {number} px Centre x.
   * @param {number} pz Centre z.
   * @param {number} rMin Inner radius.
   * @param {number} rMax Outer radius.
   * @param {boolean} [requireHidden=false] Reject any spot the player can actually see. Used for
   *   the close-in fallback ring, so a ped never materialises in plain sight.
   * @returns {boolean} True when a ped was created.
   * @private
   */
  _trySpawn(px, pz, rMin, rMax, requireHidden = false) {
    const g = this.walks;
    if (g.sampleCount === 0) return false;
    const n = g.queryRing(px, pz, rMin, rMax, _cand);
    if (n === 0) return false;
    const camera = this.game.camera;
    let bestSample = -1;
    let bestScore = -Infinity;
    let rayBudget = 4;
    for (let t = 0; t < SPAWN_TRIES; t++) {
      this._spawnCursor = (this._spawnCursor + 1 + this.rng.int(0, 5)) % n;
      const s = _cand[this._spawnCursor];
      const rec = this.city.walks[g.sPoly[s]];
      if (!rec || rec.crossing) continue;
      const x = g.sx[s];
      const z = g.sz[s];
      if (!this._spotClear(x, z, SPAWN_CLEAR)) continue;
      // Prefer spawn points the player cannot see: behind the camera or behind a building.
      let score = 10;
      if (camera && typeof camera.frustumContainsSphere === 'function') {
        let visible = false;
        try { visible = camera.frustumContainsSphere(x, 1.0, z, 1.2); } catch (err) { visible = false; }
        if (visible) {
          const hidden = rayBudget > 0 && this._occluded(camera, x, z);
          if (rayBudget > 0) rayBudget--;
          score = hidden ? 6 : 0;
        }
      }
      if (requireHidden && score < 6) continue;
      if (score > bestScore) { bestScore = score; bestSample = s; }
      if (score >= 10 && t >= 2) break;
    }
    if (bestSample < 0) return false;
    const x = g.sx[bestSample];
    const z = g.sz[bestSample];
    const y = this._groundAt(x, z);
    const ped = this.spawnPed(x, y, z, {});
    return ped !== null;
  }

  /**
   * @param {object} camera Active camera.
   * @param {number} x World x.
   * @param {number} z World z.
   * @returns {boolean} True when a solid body sits between the camera and the point.
   * @private
   */
  _occluded(camera, x, z) {
    const coll = this.game.collision;
    if (!coll || typeof coll.raycast !== 'function' || !camera.position) return false;
    const ox = camera.position[0];
    const oy = camera.position[1];
    const oz = camera.position[2];
    _dir3[0] = x - ox;
    _dir3[1] = 1.0 - oy;
    _dir3[2] = z - oz;
    const l = Math.hypot(_dir3[0], _dir3[1], _dir3[2]);
    if (!(l > 0.5)) return false;
    _dir3[0] /= l; _dir3[1] /= l; _dir3[2] /= l;
    let hit = null;
    try { hit = coll.raycast(camera.position, _dir3, l - 0.6, null); } catch (err) { hit = null; }
    return !!hit;
  }

  /**
   * @param {number} x World x.
   * @param {number} z World z.
   * @param {number} clear Required clearance.
   * @returns {boolean} True when no ped and not the player sits within `clear`.
   * @private
   */
  _spotClear(x, z, clear) {
    const c2 = clear * clear;
    for (let i = 0; i < this.peds.length; i++) {
      const p = this.peds[i];
      const dx = p.position[0] - x;
      const dz = p.position[2] - z;
      if (dx * dx + dz * dz < c2) return false;
    }
    const pl = this.game.player;
    if (pl && pl.position) {
      const dx = pl.position[0] - x;
      const dz = pl.position[2] - z;
      if (dx * dx + dz * dz < 16) return false;
    }
    return true;
  }

  /**
   * Ground height under a column, with a safe fallback.
   * @param {number} x World x.
   * @param {number} z World z.
   * @returns {number} Height in metres.
   * @private
   */
  _groundAt(x, z) {
    const game = this.game;
    if (typeof game.worldToGround === 'function') {
      const y = game.worldToGround(x, z);
      if (Number.isFinite(y)) return y;
    }
    if (game.collision && typeof game.collision.groundHeight === 'function') {
      const y = game.collision.groundHeight(x, z);
      if (Number.isFinite(y)) return y;
    }
    return 0;
  }

  /**
   * Removes a ped and recycles its record and character.
   * @param {object} ped Ped record.
   * @returns {void}
   */
  removePed(ped) {
    if (!ped) return;
    const i = this.peds.indexOf(ped);
    if (i >= 0) this.peds.splice(i, 1);
    this._retire(ped);
  }

  /**
   * @param {object} ped Ped record (already spliced out of {@link PedManager#peds}).
   * @returns {void}
   * @private
   */
  _retire(ped) {
    if (ped.dead) this.bodies = Math.max(0, this.bodies - 1);
    if (ped.partner) {
      if (ped.partner.partner === ped) ped.partner.partner = null;
      ped.partner = null;
    }
    ped.active = false;
    ped.dead = false;
    ped.missionOwned = false;
    ped.noDespawn = false;
    ped.persistent = false;
    this._releaseCharacter(ped);
    if (this._pool.length < MAX_PEDS * 2) this._pool.push(ped);
  }

  /**
   * Removes every pedestrian (world teardown / mission reset).
   * @returns {void}
   */
  clear() {
    for (let i = this.peds.length - 1; i >= 0; i--) this._retire(this.peds[i]);
    this.peds.length = 0;
    this.bodies = 0;
  }

  /* ---------------------------------------------------------------- routing */

  /**
   * Picks the next sidewalk after `walkId`.
   * @param {object} ped Ped record (used for its crossing preference).
   * @param {number} walkId Current walk.
   * @param {number} avoid Walk to avoid (the previous one).
   * @returns {number} Walk id, or -1.
   * @private
   */
  _pickNext(ped, walkId, avoid) {
    const walks = this.city.walks;
    const rec = walks[walkId];
    if (!rec || !rec.next || rec.next.length === 0) return -1;
    const list = rec.next;
    if (list.length === 1) return list[0];
    // Weight: keep going, avoid turning straight back, and cross roads only sometimes.
    let total = 0;
    for (let i = 0; i < list.length; i++) {
      const nx = walks[list[i]];
      if (!nx) continue;
      if (list[i] === avoid || list[i] === rec.twin) continue;
      total += nx.crossing ? 0.45 : 1;
    }
    if (total <= 0) return list[this.rng.int(0, list.length - 1)];
    let r = this.rng.next() * total;
    for (let i = 0; i < list.length; i++) {
      const nx = walks[list[i]];
      if (!nx) continue;
      if (list[i] === avoid || list[i] === rec.twin) continue;
      r -= nx.crossing ? 0.45 : 1;
      if (r <= 0) return list[i];
    }
    return list[list.length - 1];
  }

  /**
   * Fills the ped's look-ahead route buffer.
   * @param {object} ped Ped record.
   * @returns {void}
   * @private
   */
  _extendRoute(ped) {
    while (ped.routeLen < ROUTE_LEN) {
      const from = ped.routeLen === 0 ? ped.walkId : ped.route[ped.routeLen - 1];
      const avoid = ped.routeLen >= 2 ? ped.route[ped.routeLen - 2] : ped.walkId;
      const next = this._pickNext(ped, from, avoid);
      if (next < 0) break;
      ped.route[ped.routeLen++] = next;
    }
  }

  /**
   * Steps the ped onto the next walk of its route.
   * @param {object} ped Ped record.
   * @returns {boolean} False when the route ran dry.
   * @private
   */
  _advanceWalk(ped) {
    if (ped.routeLen === 0) this._extendRoute(ped);
    if (ped.routeLen === 0) return false;
    ped.walkId = ped.route[0];
    for (let i = 1; i < ped.routeLen; i++) ped.route[i - 1] = ped.route[i];
    ped.routeLen--;
    ped.carrot = 0;
    this._extendRoute(ped);
    return true;
  }

  /**
   * Point on the route `dist` metres past `from`.
   * @param {object} ped Ped record.
   * @param {number} from Arc distance on the current walk.
   * @param {number} dist Extra distance to walk along the route.
   * @param {Float32Array|number[]} out Destination `[x, z]`.
   * @returns {Float32Array|number[]} `out`
   * @private
   */
  _routePoint(ped, from, dist, out) {
    let walk = ped.walkId;
    let d = from + dist;
    let hop = 0;
    let len = this.walks.length(walk);
    while (d > len && hop < ped.routeLen) {
      d -= len;
      walk = ped.route[hop++];
      len = this.walks.length(walk);
    }
    this.walks.sample(walk, d, out);
    return out;
  }

  /* ---------------------------------------------------------------- alerts */

  /**
   * A gunshot: everyone in earshot panics, most run, some freeze.
   * @param {ArrayLike<number>} pos3 Shot position.
   * @param {number} [radius=45] Audible radius in metres.
   * @returns {void}
   */
  alertGunshot(pos3, radius = 45) {
    if (!pos3) return;
    const x = fin(pos3[0], 0);
    const z = fin(pos3[2], 0);
    const r = radius > 4 ? radius : 45;
    const r2 = r * r;
    for (let i = 0; i < this.peds.length; i++) {
      const ped = this.peds[i];
      if (ped.dead) continue;
      const dx = ped.position[0] - x;
      const dz = ped.position[2] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const close = d2 < r2 * 0.25;
      this.scare(ped, x, z, close || this.rng.chance(0.72));
    }
  }

  /**
   * A loud noise (sprinting, a crash, a horn): mild reaction, only the very close panic.
   * @param {ArrayLike<number>} pos3 Noise position.
   * @param {number} [radius=12] Audible radius in metres.
   * @returns {void}
   */
  alertNoise(pos3, radius = 12) {
    if (!pos3) return;
    const x = fin(pos3[0], 0);
    const z = fin(pos3[2], 0);
    const r = radius > 1 ? radius : 12;
    const r2 = r * r;
    const panic2 = (r * 0.34) * (r * 0.34);
    for (let i = 0; i < this.peds.length; i++) {
      const ped = this.peds[i];
      if (ped.dead) continue;
      const dx = ped.position[0] - x;
      const dz = ped.position[2] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      ped.scared = Math.min(1, ped.scared + 0.25);
      ped.threatX = x;
      ped.threatZ = z;
      ped.hasThreat = true;
      if (d2 < panic2 && r > 18) this.scare(ped, x, z, true);
      else if (ped.state === 'chat' || ped.state === 'idle') this._setState(ped, 'walk');
    }
  }

  /**
   * Makes one ped react to a threat.
   * @param {object} ped Ped record.
   * @param {number} x Threat x.
   * @param {number} z Threat z.
   * @param {boolean} run True to flee, false to cower on the spot.
   * @returns {void}
   */
  scare(ped, x, z, run) {
    if (!ped || ped.dead) return;
    ped.threatX = x;
    ped.threatZ = z;
    ped.hasThreat = true;
    ped.scared = 1;
    if (ped.partner) {
      if (ped.partner.partner === ped) ped.partner.partner = null;
      ped.partner = null;
    }
    if (run) {
      if (ped.state !== 'flee') {
        this._setState(ped, 'flee');
        ped.timer = FLEE_TIME * this.rng.range(0.7, 1.3);
        this._scream(ped);
      } else {
        ped.timer = Math.max(ped.timer, FLEE_TIME * 0.6);
      }
    } else if (ped.state !== 'cower') {
      this._setState(ped, 'cower');
      ped.timer = COWER_TIME * this.rng.range(0.7, 1.4);
    }
  }

  /**
   * Plays a panicked shout. Prefers a dedicated `sfx.scream` when the audio module grows one,
   * otherwise synthesises a short vocal cry through the audio engine.
   * @param {object} ped Ped record.
   * @returns {void}
   * @private
   */
  _scream(ped) {
    if (this._screamTimer > 0) return;
    const game = this.game;
    const sfx = game.sfx;
    this._screamTimer = SCREAM_COOLDOWN;
    if (sfx && typeof sfx.scream === 'function') {
      try { sfx.scream(ped.position, ped.female); } catch (err) { /* audio off */ }
      return;
    }
    const audio = game.audio;
    if (!audio || typeof audio.playSound !== 'function' || audio.enabled === false) return;
    const rng = this.rng;
    const base = (ped.female ? 470 : 280) * rng.range(0.88, 1.2);
    const dur = rng.range(0.5, 0.85);
    try {
      audio.playSound((ctx, dest, t, eng) => {
        const g = eng.createGain(0.0001);
        const band = eng.createFilter('bandpass', base * 3.1, 3.2);
        const shelf = eng.createFilter('highshelf', 2600, 1, 5);
        if (!g || !band || !shelf) return 0.1;
        band.connect(shelf);
        shelf.connect(g);
        g.connect(dest);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.55, t + 0.05);
        g.gain.setValueAtTime(0.55, t + dur * 0.45);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        const chain = [g, band, shelf];
        for (let i = 0; i < 2; i++) {
          const osc = eng.createOsc(i === 0 ? 'sawtooth' : 'square', base * (i === 0 ? 1 : 2.01), i * 9);
          if (!osc) continue;
          osc.frequency.setValueAtTime(base * (i === 0 ? 1 : 2.01), t);
          osc.frequency.linearRampToValueAtTime(base * (i === 0 ? 1.28 : 2.5), t + dur * 0.3);
          osc.frequency.linearRampToValueAtTime(base * (i === 0 ? 0.82 : 1.6), t + dur);
          const og = eng.createGain(i === 0 ? 0.6 : 0.22);
          osc.connect(og);
          og.connect(band);
          eng.schedule(osc, t, t + dur + 0.05, [og]);
        }
        // Breath noise on top so it reads as a voice, not a synth tone.
        const noise = eng.noiseSource ? eng.noiseSource('pink', 1, true) : null;
        if (noise) {
          const ng = eng.createGain(0.10);
          const nf = eng.createFilter('bandpass', base * 5.5, 1.4);
          if (ng && nf) {
            noise.connect(nf);
            nf.connect(ng);
            ng.connect(g);
            eng.schedule(noise, t, t + dur, [ng, nf]);
          }
        }
        return { duration: dur + 0.12, stop: () => {
          for (let i = 0; i < chain.length; i++) {
            try { chain[i].disconnect(); } catch (err) { /* already gone */ }
          }
        } };
      }, {
        bus: 'voice', category: 'voice', pos: ped.position,
        gain: 0.85, reverb: 0.28, refDistance: 6, maxDistance: 95,
      });
    } catch (err) { /* audio unavailable */ }
  }

  /* ---------------------------------------------------------------- damage */

  /**
   * Applies damage to a pedestrian.
   * @param {object} ped Ped record.
   * @param {number} amount Damage points (the weapon system already applied its headshot
   *   multiplier).
   * @param {ArrayLike<number>} [dir3] Direction the damage travelled in.
   * @param {boolean} [headshot=false] Whether the shot hit the head.
   * @param {object} [attacker] Who did it; defaults to the player, or to `game.ext.aiShooter`
   *   when an AI is mid-`tryFire`.
   * @returns {number} Damage actually applied.
   */
  damagePed(ped, amount, dir3, headshot = false, attacker) {
    if (!ped || ped.dead) return 0;
    // `raycastPeds` also reports police officers, so route their damage to the police system.
    if (ped.isCop === true) {
      const police = this.game.police;
      if (police && typeof police.damageCop === 'function') {
        return police.damageCop(ped, amount, dir3, headshot, attacker);
      }
      return 0;
    }
    if (!ped.active) return 0;
    let dmg = Math.max(0, fin(amount, 0));
    if (dmg <= 0) return 0;
    // A clean head hit on an unarmoured civilian is always fatal.
    if (headshot) dmg = Math.max(dmg, ped.maxHealth);
    ped.health -= dmg;
    const src = attacker !== undefined ? attacker
      : (this.game.ext && this.game.ext.aiShooter) || (this.game.player || null);
    if (dir3) {
      ped.threatX = ped.position[0] - fin(dir3[0], 0) * 6;
      ped.threatZ = ped.position[2] - fin(dir3[2], 0) * 6;
      ped.hasThreat = true;
    }
    if (ped.health <= 0) {
      this.killPed(ped, dir3, src, headshot);
    } else {
      ped.hitTimer = HIT_TIME;
      this._setState(ped, 'hit');
      ped.scared = 1;
      const parts = this.game.particles;
      if (parts && typeof parts.burst === 'function') {
        parts.burst('blood', ped.position[0], ped.position[1] + 1.2, ped.position[2], 6,
          { power: 1 });
      }
    }
    // Everyone nearby sees it happen.
    this.alertGunshot(ped.position, 26);
    return dmg;
  }

  /**
   * Kills a pedestrian: ragdoll, corpse timer, wanted level.
   * @param {object} ped Ped record.
   * @param {ArrayLike<number>} [dir3] Impact direction.
   * @param {object} [attacker] Killer (the player raises the wanted level).
   * @param {boolean} [headshot=false] Whether it was a head hit.
   * @returns {void}
   */
  killPed(ped, dir3, attacker, headshot = false) {
    if (!ped || ped.dead) return;
    const game = this.game;
    ped.dead = true;
    ped.health = 0;
    ped.state = 'dead';
    ped.stateTime = 0;
    ped.bodyTimer = BODY_TIME;
    ped.speed = 0;
    ped.velocity[0] = 0;
    ped.velocity[1] = 0;
    ped.velocity[2] = 0;
    ped.partner = null;
    this.bodies++;

    if (ped.character) {
      _dir3[0] = fin(dir3 ? dir3[0] : 0, 0) * 6;
      _dir3[1] = 1.5;
      _dir3[2] = fin(dir3 ? dir3[2] : 0, 0) * 6;
      try { ped.character.playRagdoll(_dir3); } catch (err) { /* fall back to a static pose */ }
    }
    if (game.sfx && typeof game.sfx.bodyFall === 'function') {
      try { game.sfx.bodyFall(ped.position); } catch (err) { /* audio off */ }
    }
    const parts = game.particles;
    if (parts && typeof parts.burst === 'function') {
      parts.burst('blood', ped.position[0], ped.position[1] + (headshot ? 1.6 : 1.1),
        ped.position[2], headshot ? 16 : 10, { power: 1.3 });
    }
    if (typeof game.emit === 'function') game.emit('pedKilled', ped);

    const player = game.player || null;
    const byPlayer = attacker === player || attacker === undefined || attacker === null
      || (player && attacker === player.vehicle);
    if (byPlayer && player) {
      player.kills = fin(player.kills, 0) + 1;
      if (game.police && typeof game.police.reportCrime === 'function') {
        try { game.police.reportCrime('pedKill', ped.position); } catch (err) { /* ignore */ }
      }
    }
    // The whole street reacts to a killing.
    this.alertGunshot(ped.position, 34);
  }

  /**
   * Blast damage from an explosion.
   * @param {number} x Blast x.
   * @param {number} y Blast y.
   * @param {number} z Blast z.
   * @param {number} radius Blast radius in metres.
   * @param {number} damage Damage at the centre.
   * @returns {void}
   */
  explosionDamage(x, y, z, radius, damage) {
    const r = radius > 0 ? radius : 8;
    const r2 = r * r;
    for (let i = this.peds.length - 1; i >= 0; i--) {
      const ped = this.peds[i];
      if (ped.dead) continue;
      const dx = ped.position[0] - x;
      const dy = ped.position[1] + 0.9 - y;
      const dz = ped.position[2] - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2);
      const l = Math.max(1e-3, d);
      _dir3[0] = dx / l;
      _dir3[1] = 0;
      _dir3[2] = dz / l;
      this.damagePed(ped, fin(damage, 100) * (1 - d / r), _dir3, false, this.game.player);
    }
    this.alertGunshot(_hitPointFrom(x, y, z), r * 3.5);
  }

  /**
   * Nearest pedestrian along a ray.
   * @param {ArrayLike<number>} origin3 Ray origin.
   * @param {ArrayLike<number>} dir3 Ray direction (need not be normalised).
   * @param {number} maxDist Maximum distance in metres.
   * @returns {{ped:object, t:number, point:Float32Array, headshot:boolean}|null} Shared hit
   *   record (valid until the next call), or null.
   */
  raycastPeds(origin3, dir3, maxDist) {
    if (!origin3 || !dir3) return null;
    const ox = fin(origin3[0], 0);
    const oy = fin(origin3[1], 0);
    const oz = fin(origin3[2], 0);
    let dx = fin(dir3[0], 0);
    let dy = fin(dir3[1], 0);
    let dz = fin(dir3[2], 0);
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(l > 1e-6)) return null;
    dx /= l; dy /= l; dz /= l;
    let limit = fin(maxDist, 100);
    if (!(limit > 0)) return null;

    _rayBest = null;
    _rayBestT = limit;
    _rayBestHead = false;
    this._rayList(this.peds, ox, oy, oz, dx, dy, dz);
    // Police officers are shot through the same call, so the weapon system needs no special case.
    const police = this.game.police;
    if (police && Array.isArray(police.cops) && police.cops.length > 0) {
      this._rayList(police.cops, ox, oy, oz, dx, dy, dz);
    }
    if (!_rayBest) return null;
    _rayHit.ped = _rayBest;
    _rayHit.t = _rayBestT;
    _rayHit.headshot = _rayBestHead;
    _rayHit.point[0] = ox + dx * _rayBestT;
    _rayHit.point[1] = oy + dy * _rayBestT;
    _rayHit.point[2] = oz + dz * _rayBestT;
    return _rayHit;
  }

  /**
   * Tests one list of ped-shaped records against a ray, keeping the nearest hit in the shared
   * `_rayBest*` state.
   * @param {object[]} list Records with `position`, `dead` and optionally `character`.
   * @param {number} ox Ray origin x.
   * @param {number} oy Ray origin y.
   * @param {number} oz Ray origin z.
   * @param {number} dx Direction x (unit).
   * @param {number} dy Direction y (unit).
   * @param {number} dz Direction z (unit).
   * @returns {void}
   * @private
   */
  _rayList(list, ox, oy, oz, dx, dy, dz) {
    for (let i = 0; i < list.length; i++) {
      const ped = list[i];
      if (!ped || ped.dead || ped.active === false || !ped.position) continue;
      const px = ped.position[0];
      const py = ped.position[1];
      const pz = ped.position[2];
      if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
      // Broad phase: reject anything whose centre is further from the ray than a body radius.
      const mx = px - ox;
      const my = py + 0.9 - oy;
      const mz = pz - oz;
      const along = mx * dx + my * dy + mz * dz;
      if (along < -1.2 || along > _rayBestT + 1.2) continue;
      const cx = mx - dx * along;
      const cy = my - dy * along;
      const cz = mz - dz * along;
      if (cx * cx + cy * cy + cz * cz > 1.6) continue;

      const ch = ped.character;
      const scale = ch && Number.isFinite(ch.height) ? ch.height / 1.8 : 1;
      const r = PED_RADIUS * scale;
      const headY = py + 1.60 * scale;
      const th = raySphere(ox, oy, oz, dx, dy, dz, px, headY, pz, 0.155 * scale, _rayBestT);
      if (th >= 0) {
        _rayBestT = th;
        _rayBest = ped;
        _rayBestHead = true;
        continue;
      }
      const tb = rayCylinderY(ox, oy, oz, dx, dy, dz, px, pz,
        py + 0.08, py + 1.48 * scale, r, _rayBestT);
      if (tb >= 0) {
        _rayBestT = tb;
        _rayBest = ped;
        _rayBestHead = false;
      }
    }
  }

  /* ---------------------------------------------------------------- update */

  /**
   * Streams and simulates the crowd.
   * @param {number} dt Delta time in seconds.
   * @param {ArrayLike<number>} playerPos Player world position.
   * @returns {void}
   */
  update(dt, playerPos) {
    const step = dt > 0.25 ? 0.25 : dt > 0 ? dt : 0;
    this._time += step;
    this._frame++;
    if (this._screamTimer > 0) this._screamTimer -= step;
    const px = playerPos ? fin(playerPos[0], 0) : 0;
    const pz = playerPos ? fin(playerPos[2], 0) : 0;
    if (!this._assets && this.game) this._assets = this.game.characterAssets || null;

    const far2 = DESPAWN_DIST * DESPAWN_DIST;
    for (let i = this.peds.length - 1; i >= 0; i--) {
      const ped = this.peds[i];
      const dx = ped.position[0] - px;
      const dz = ped.position[2] - pz;
      const d2 = dx * dx + dz * dz;
      ped.distToPlayer = Math.sqrt(d2);

      if (ped.dead) {
        ped.bodyTimer -= step;
        // Corpses out of sight leave immediately; the rest linger for BODY_TIME.
        if (ped.bodyTimer <= 0 || (d2 > far2 && !ped.noDespawn)) {
          this.peds.splice(i, 1);
          this._retire(ped);
          continue;
        }
      } else if (d2 > far2 && !ped.noDespawn && !ped.persistent) {
        this.peds.splice(i, 1);
        this._retire(ped);
        continue;
      }

      const stride = d2 > 6400 ? 4 : d2 > 2025 ? 2 : 1;
      ped.lod = stride === 4 ? 2 : stride === 2 ? 1 : 0;
      ped.accum += step;
      if (stride > 1 && ((this._frame + ped.phase) % stride) !== 0) continue;
      const pdt = ped.accum;
      ped.accum = 0;
      if (pdt > 0) this._updatePed(ped, pdt, px, pz);
    }

    if (this.streaming) {
      let budget = SPAWN_BUDGET;
      while (budget > 0 && this.peds.length < this.maxPeds) {
        if (!this._trySpawn(px, pz, SPAWN_MIN, SPAWN_MAX)) break;
        budget--;
      }
    }
  }

  /**
   * Full simulation step for one pedestrian.
   * @param {object} ped Ped record.
   * @param {number} dt Time since this ped last ticked.
   * @param {number} px Player x.
   * @param {number} pz Player z.
   * @returns {void}
   * @private
   */
  _updatePed(ped, dt, px, pz) {
    ped.stateTime += dt;
    if (ped.scared > 0) ped.scared = Math.max(0, ped.scared - dt * 0.22);

    if (ped.dead) {
      this._animate(ped, dt, 0);
      return;
    }

    this._think(ped, dt);
    const speed = this._steer(ped, dt);
    this._integrate(ped, dt);
    this._animate(ped, dt, speed);
  }

  /**
   * State machine: decides what the ped wants to do next.
   * @param {object} ped Ped record.
   * @param {number} dt Time step.
   * @returns {void}
   * @private
   */
  _think(ped, dt) {
    const rng = this.rng;
    ped.timer -= dt;

    switch (ped.state) {
      case 'hit':
        ped.hitTimer -= dt;
        if (ped.hitTimer <= 0) {
          this._setState(ped, 'flee');
          ped.timer = FLEE_TIME * 0.7;
        }
        return;

      case 'cower':
        if (ped.timer <= 0) {
          if (ped.hasThreat && this._threatDistance(ped) < 18) {
            this._setState(ped, 'flee');
            ped.timer = FLEE_TIME;
          } else {
            ped.hasThreat = false;
            this._setState(ped, 'walk');
            ped.timer = rng.range(6, 18);
          }
        }
        return;

      case 'flee':
        if (ped.timer <= 0) {
          ped.hasThreat = false;
          ped.screamed = false;
          this._setState(ped, 'walk');
          ped.timer = rng.range(6, 18);
          this._attachToGraph(ped);
        }
        return;

      case 'chat': {
        const other = ped.partner;
        if (!other || !other.active || other.dead || other.partner !== ped
          || ped.timer <= 0 || this._distance2(ped, other) > 16) {
          if (other && other.partner === ped) {
            other.partner = null;
            if (other.state === 'chat') this._setState(other, 'walk');
            other.timer = rng.range(5, 14);
          }
          ped.partner = null;
          this._setState(ped, 'walk');
          ped.timer = rng.range(6, 18);
        }
        return;
      }

      case 'idle':
        if (ped.timer <= 0) {
          this._setState(ped, 'walk');
          ped.timer = rng.range(8, 24);
        } else if (ped.stateTime > 0.6 && !ped.partner && rng.chance(dt * 0.5)) {
          this._tryChat(ped);
        }
        return;

      case 'cross':
        this._updateCrossing(ped, dt);
        return;

      case 'walk':
      default:
        break;
    }

    // --- walking -------------------------------------------------------------------
    if (ped.walkId < 0 && !this._attachToGraph(ped)) return;

    const g = this.walks;
    const len = g.length(ped.walkId);
    const proj = g.project(ped.walkId, ped.position[0], ped.position[2]);
    ped.carrot = proj + CARROT;

    if (proj >= len - 0.35) {
      // Reached the end of this sidewalk: is the next leg a crossing?
      if (ped.routeLen === 0) this._extendRoute(ped);
      const nextId = ped.routeLen > 0 ? ped.route[0] : -1;
      const nextRec = nextId >= 0 ? this.city.walks[nextId] : null;
      if (nextRec && nextRec.crossing) {
        this._beginCrossing(ped, nextRec);
        return;
      }
      if (!this._advanceWalk(ped)) {
        // Dead end: turn around by hopping onto the twin walk.
        const rec = this.city.walks[ped.walkId];
        if (rec && rec.twin !== undefined && rec.twin >= 0) {
          ped.walkId = rec.twin;
          ped.routeLen = 0;
          this._extendRoute(ped);
        } else {
          this._attachToGraph(ped);
        }
      }
      return;
    }

    if (ped.timer <= 0 && !ped.missionOwned) {
      // Stop for a moment: window shopping, a phone call, or a chat with a passer-by.
      if (!this._tryChat(ped)) {
        this._setState(ped, 'idle');
        ped.idleKind = rng.int(0, 2);
        ped.timer = rng.range(2.5, 7);
      }
    }
  }

  /**
   * Squared XZ distance between two peds.
   * @param {object} a First ped.
   * @param {object} b Second ped.
   * @returns {number} Distance squared.
   * @private
   */
  _distance2(a, b) {
    const dx = a.position[0] - b.position[0];
    const dz = a.position[2] - b.position[2];
    return dx * dx + dz * dz;
  }

  /**
   * Distance from a ped to its remembered threat.
   * @param {object} ped Ped record.
   * @returns {number} Metres (Infinity when there is no threat).
   * @private
   */
  _threatDistance(ped) {
    if (!ped.hasThreat) return Infinity;
    const dx = ped.position[0] - ped.threatX;
    const dz = ped.position[2] - ped.threatZ;
    return Math.sqrt(dx * dx + dz * dz);
  }

  /**
   * Tries to pair the ped with a nearby free pedestrian for a chat.
   * @param {object} ped Ped record.
   * @returns {boolean} True when a conversation started.
   * @private
   */
  _tryChat(ped) {
    if (ped.partner || ped.missionOwned) return false;
    for (let i = 0; i < this.peds.length; i++) {
      const other = this.peds[i];
      if (other === ped || other.dead || other.partner || other.missionOwned) continue;
      if (other.state !== 'walk' && other.state !== 'idle') continue;
      const d2 = this._distance2(ped, other);
      if (d2 > 6.25 || d2 < 0.4) continue;
      ped.partner = other;
      other.partner = ped;
      const t = this.rng.range(5, 13);
      this._setState(ped, 'chat');
      this._setState(other, 'chat');
      ped.timer = t;
      other.timer = t;
      return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- crossing */

  /**
   * Puts a ped at the kerb waiting for the light.
   * @param {object} ped Ped record.
   * @param {object} walk The crossing walk record.
   * @returns {void}
   * @private
   */
  _beginCrossing(ped, walk) {
    const g = this.walks;
    const id = walk.id !== undefined ? walk.id : ped.route[0];
    const len = g.length(id);
    g.sample(id, 0, _pt);
    g.sample(id, len, _pt2);
    const dx = _pt2[0] - _pt[0];
    const dz = _pt2[1] - _pt[1];
    // A crossing that runs along X spans the road whose traffic travels along Z.
    ped.crossAxis = Math.abs(dx) > Math.abs(dz) ? 'z' : 'x';
    ped.crossNode = walk.nodeId === undefined ? -1 : walk.nodeId;
    ped.crossWait = 0;
    ped.crossing = false;
    this._setState(ped, 'cross');
  }

  /**
   * Waits for the light (or a gap in the traffic) and then crosses.
   * @param {object} ped Ped record.
   * @param {number} dt Time step.
   * @returns {void}
   * @private
   */
  _updateCrossing(ped, dt) {
    if (ped.crossing) {
      const g = this.walks;
      const len = g.length(ped.walkId);
      const proj = g.project(ped.walkId, ped.position[0], ped.position[2]);
      ped.carrot = proj + CARROT;
      if (proj >= len - 0.35) {
        ped.crossing = false;
        if (!this._advanceWalk(ped)) this._attachToGraph(ped);
        this._setState(ped, 'walk');
        ped.timer = this.rng.range(8, 22);
      }
      return;
    }

    ped.crossWait += dt;
    let clear = false;
    const tl = this._lightFor(ped.crossNode);
    if (tl && typeof tl.state === 'function') {
      clear = tl.state(ped.crossAxis) === 'red';
    } else {
      clear = this._crossingClear(ped);
    }
    if (!clear && ped.crossWait < CROSS_PATIENCE) return;

    // Step onto the crossing.
    if (!this._advanceWalk(ped)) {
      this._attachToGraph(ped);
      this._setState(ped, 'walk');
      return;
    }
    ped.crossing = true;
    ped.stateTime = 0;
  }

  /**
   * Traffic light record for a node, or null.
   * @param {number} nodeId Node id.
   * @returns {object|null} Light.
   * @private
   */
  _lightFor(nodeId) {
    if (nodeId === undefined || nodeId === null || nodeId < 0) return null;
    const world = this.game.world;
    if (!world) return null;
    const map = world.trafficLightByNode;
    if (map && typeof map.get === 'function') return map.get(nodeId) || null;
    const list = world.trafficLights;
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i++) if (list[i].nodeId === nodeId) return list[i];
    }
    return null;
  }

  /**
   * Unsignalled crossing: look for a gap in the traffic.
   * @param {object} ped Ped record.
   * @returns {boolean} True when it is safe to step out.
   * @private
   */
  _crossingClear(ped) {
    const list = this.game.vehicles;
    if (!Array.isArray(list)) return true;
    const x = ped.position[0];
    const z = ped.position[2];
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!v || !v.position || v.isDestroyed) continue;
      const dx = v.position[0] - x;
      const dz = v.position[2] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 400) continue;
      const vx = fin(v.velocity ? v.velocity[0] : 0, 0);
      const vz = fin(v.velocity ? v.velocity[2] : 0, 0);
      const sp = Math.hypot(vx, vz);
      if (sp < 1.5) continue;
      // Closing on us?
      if (dx * vx + dz * vz < 0) {
        const d = Math.sqrt(d2);
        if (d / sp < 3.2) return false;
      }
    }
    return true;
  }

  /* ---------------------------------------------------------------- steering */

  /**
   * Computes the ped's velocity for this tick: path following plus separation, vehicle
   * evasion and the walk-graph leash.
   * @param {object} ped Ped record.
   * @param {number} dt Time step.
   * @returns {number} Resulting ground speed in m/s.
   * @private
   */
  _steer(ped, dt) {
    const state = ped.state;
    let wantX = 0;
    let wantZ = 0;
    let desired = 0;

    if (state === 'flee') {
      const dx = ped.position[0] - ped.threatX;
      const dz = ped.position[2] - ped.threatZ;
      const l = Math.hypot(dx, dz);
      if (l > 1e-3) { wantX = dx / l; wantZ = dz / l; } else { wantX = 1; wantZ = 0; }
      desired = ped.runSpeed;
      // Prefer running along the sidewalk rather than into the road.
      const g = this.walks;
      if (ped.walkId >= 0) {
        g.project(ped.walkId, ped.position[0] + wantX * 3, ped.position[2] + wantZ * 3);
        const tx = g.projX - ped.position[0];
        const tz = g.projZ - ped.position[2];
        const tl = Math.hypot(tx, tz);
        if (tl > 1e-3) {
          wantX = wantX * 0.55 + (tx / tl) * 0.45;
          wantZ = wantZ * 0.55 + (tz / tl) * 0.45;
        }
      }
    } else if (state === 'chat') {
      const other = ped.partner;
      if (other) {
        const dx = other.position[0] - ped.position[0];
        const dz = other.position[2] - ped.position[2];
        const l = Math.hypot(dx, dz);
        // Stand about 1.2 m apart, facing each other.
        if (l > 1.5) { wantX = dx / l; wantZ = dz / l; desired = 0.8; }
        else if (l < 0.9 && l > 1e-3) { wantX = -dx / l; wantZ = -dz / l; desired = 0.5; }
        if (l > 1e-3) ped.yaw = angleDamp(ped.yaw, Math.atan2(-dx, -dz), 8, dt);
      }
    } else if (state === 'idle' || state === 'cower' || state === 'hit') {
      desired = 0;
    } else {
      // walk / cross
      if (ped.walkId >= 0) {
        this._routePoint(ped, ped.carrot, 0, _pt);
        const dx = _pt[0] - ped.position[0];
        const dz = _pt[1] - ped.position[2];
        const l = Math.hypot(dx, dz);
        if (l > 1e-3) {
          wantX = dx / l;
          wantZ = dz / l;
          // Arrive: ease off over the last metre so peds do not jitter around the carrot.
          desired = ped.walkSpeed * clamp(l / 1.0, 0.15, 1);
          if (state === 'cross' && ped.crossing) desired = ped.walkSpeed * 1.5;
        }
      }
    }

    // --- separation from other peds --------------------------------------------------
    let sepX = 0;
    let sepZ = 0;
    if (ped.lod < 2) {
      const list = this.peds;
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (o === ped) continue;
        const dx = ped.position[0] - o.position[0];
        const dz = ped.position[2] - o.position[2];
        const d2 = dx * dx + dz * dz;
        if (d2 > SEP_RADIUS * SEP_RADIUS || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const w = (SEP_RADIUS - d) / SEP_RADIUS;
        sepX += (dx / d) * w;
        sepZ += (dz / d) * w;
      }
      const pl = this.game.player;
      if (pl && pl.position && !pl.vehicle) {
        const dx = ped.position[0] - pl.position[0];
        const dz = ped.position[2] - pl.position[2];
        const d2 = dx * dx + dz * dz;
        if (d2 < 1.44 && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          sepX += (dx / d) * 1.6;
          sepZ += (dz / d) * 1.6;
        }
      }
    }

    // --- vehicles ---------------------------------------------------------------------
    let carX = 0;
    let carZ = 0;
    let carDanger = 0;
    const vehicles = this.game.vehicles;
    if (Array.isArray(vehicles) && ped.distToPlayer < 120) {
      for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i];
        if (!v || !v.position) continue;
        const dx = ped.position[0] - v.position[0];
        const dz = ped.position[2] - v.position[2];
        const d2 = dx * dx + dz * dz;
        if (d2 > CAR_FEAR * CAR_FEAR) continue;
        const vx = fin(v.velocity ? v.velocity[0] : 0, 0);
        const vz = fin(v.velocity ? v.velocity[2] : 0, 0);
        const sp = Math.hypot(vx, vz);
        // Run over check first: an OBB overlap against a fast car is fatal.
        if (sp > KNOCKDOWN_CAR_SPEED && this._carHits(ped, v)) {
          this._hitByCar(ped, v, sp);
          return 0;
        }
        if (sp < 1.2 || d2 < 1e-6) continue;
        // Only fear cars actually heading our way.
        if (dx * vx + dz * vz > 0) continue;
        const d = Math.sqrt(d2);
        const w = (CAR_FEAR - d) / CAR_FEAR;
        carX += (dx / d) * w;
        carZ += (dz / d) * w;
        if (w > carDanger) carDanger = w;
      }
    }

    // --- walk-graph leash ---------------------------------------------------------------
    let leashX = 0;
    let leashZ = 0;
    if (ped.walkId >= 0 && state !== 'cross') {
      const g = this.walks;
      g.project(ped.walkId, ped.position[0], ped.position[2]);
      const off = Math.sqrt(g.projDist2);
      if (off > LEASH) {
        const dx = g.projX - ped.position[0];
        const dz = g.projZ - ped.position[2];
        const l = Math.hypot(dx, dz);
        if (l > 1e-3) {
          const w = clamp((off - LEASH) / 2, 0, 1.6);
          leashX = (dx / l) * w;
          leashZ = (dz / l) * w;
        }
        if (off > LEASH_HARD) {
          // Far outside the network (thrown by a car, pushed by a crowd): walk back.
          if (state !== 'flee' && state !== 'cower') {
            this._attachToGraph(ped);
            this._setState(ped, 'walk');
          }
        }
      }
    }

    if (carDanger > 0.05) desired = Math.max(desired, ped.runSpeed * 0.6);

    let vxWant = wantX * desired + (sepX + carX * 2.2 + leashX) * ped.walkSpeed;
    let vzWant = wantZ * desired + (sepZ + carZ * 2.2 + leashZ) * ped.walkSpeed;
    const cap = Math.max(desired, ped.runSpeed);
    const mag = Math.hypot(vxWant, vzWant);
    if (mag > cap && mag > 1e-6) {
      vxWant = (vxWant / mag) * cap;
      vzWant = (vzWant / mag) * cap;
    }

    const accel = Math.min(1, 9 * dt);
    ped.velocity[0] += (vxWant - ped.velocity[0]) * accel;
    ped.velocity[2] += (vzWant - ped.velocity[2]) * accel;

    const speed = Math.hypot(ped.velocity[0], ped.velocity[2]);
    ped.speed = speed;
    if (speed > 0.22 && state !== 'chat') {
      ped.yaw = angleDamp(ped.yaw, Math.atan2(-ped.velocity[0], -ped.velocity[2]),
        state === 'flee' ? 12 : 8, dt);
    }
    return speed;
  }

  /**
   * Oriented-box overlap between a ped and a vehicle.
   * @param {object} ped Ped record.
   * @param {object} v Vehicle.
   * @returns {boolean} True when they intersect.
   * @private
   */
  _carHits(ped, v) {
    const type = v.type || null;
    const halfL = (type && Number.isFinite(type.length) ? type.length : 4.4) * 0.5 + 0.28;
    const halfW = (type && Number.isFinite(type.width) ? type.width : 1.9) * 0.5 + 0.28;
    const yaw = fin(v.yaw, 0);
    const dx = ped.position[0] - v.position[0];
    const dz = ped.position[2] - v.position[2];
    // Vehicle local frame: forward = (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw).
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    const along = dx * -s + dz * -c;
    const side = dx * c + dz * -s;
    if (along > halfL || along < -halfL || side > halfW || side < -halfW) return false;
    const dy = ped.position[1] - v.position[1];
    return dy > -2.2 && dy < 2.2;
  }

  /**
   * Resolves a car running into a pedestrian.
   * @param {object} ped Ped record.
   * @param {object} v Vehicle.
   * @param {number} sp Vehicle speed in m/s.
   * @returns {void}
   * @private
   */
  _hitByCar(ped, v, sp) {
    const game = this.game;
    const vx = fin(v.velocity ? v.velocity[0] : 0, 0);
    const vz = fin(v.velocity ? v.velocity[2] : 0, 0);
    const l = sp > 1e-3 ? sp : 1;
    _dir3[0] = vx / l;
    _dir3[1] = 0;
    _dir3[2] = vz / l;
    const attacker = v.driver === game.player || v.isPlayer ? game.player : (v.ai || v);
    if (sp >= LETHAL_CAR_SPEED) {
      ped.health = 0;
      this.killPed(ped, _dir3, attacker, false);
      // Throw the body forward.
      ped.position[0] += _dir3[0] * Math.min(2.5, sp * 0.12);
      ped.position[2] += _dir3[2] * Math.min(2.5, sp * 0.12);
    } else {
      this.damagePed(ped, 10 + sp * 6, _dir3, false, attacker);
      if (!ped.dead) {
        ped.velocity[0] = _dir3[0] * sp * 0.6;
        ped.velocity[2] = _dir3[2] * sp * 0.6;
        this.scare(ped, v.position[0], v.position[2], true);
      }
    }
    if (game.sfx && typeof game.sfx.carCollision === 'function') {
      try { game.sfx.carCollision(sp * 0.2, ped.position); } catch (err) { /* audio off */ }
    }
  }

  /* ---------------------------------------------------------------- physics */

  /**
   * Integrates the ped and resolves it against the collision world.
   * @param {object} ped Ped record.
   * @param {number} dt Time step.
   * @returns {void}
   * @private
   */
  _integrate(ped, dt) {
    ped.vy -= GRAVITY * dt;
    if (ped.vy < -40) ped.vy = -40;
    _delta[0] = ped.velocity[0] * dt;
    _delta[1] = ped.vy * dt;
    _delta[2] = ped.velocity[2] * dt;

    const coll = this.game.collision;
    if (coll && typeof coll.moveCapsule === 'function') {
      const scale = ped.character && Number.isFinite(ped.character.height)
        ? ped.character.height / 1.8 : 1;
      let res = _move;
      try {
        res = coll.moveCapsule(ped.position, PED_RADIUS * scale, PED_HEIGHT * scale, _delta, _move);
      } catch (err) {
        res = null;
      }
      if (res && Number.isFinite(res.x)) {
        const movedX = res.x - ped.position[0];
        const movedZ = res.z - ped.position[2];
        ped.position[0] = res.x;
        ped.position[1] = res.y;
        ped.position[2] = res.z;
        ped.grounded = !!res.grounded;
        if (ped.grounded && ped.vy < 0) ped.vy = 0;
        // Bleed off velocity we actually lost to a wall so peds do not grind into it.
        if (res.hits > 0) {
          const wantX = _delta[0];
          const wantZ = _delta[2];
          if (Math.abs(movedX) < Math.abs(wantX) * 0.4) ped.velocity[0] *= 0.25;
          if (Math.abs(movedZ) < Math.abs(wantZ) * 0.4) ped.velocity[2] *= 0.25;
        }
      } else {
        this._integrateFallback(ped);
      }
    } else {
      this._integrateFallback(ped);
    }

    if (!Number.isFinite(ped.position[0]) || !Number.isFinite(ped.position[1])
      || !Number.isFinite(ped.position[2])) {
      // Something upstream produced a NaN: put the ped back on the network rather than
      // letting the corruption spread through the crowd.
      const g = this.walks;
      const s = g.sampleCount > 0 ? (ped.id * 7919) % g.sampleCount : -1;
      ped.position[0] = s >= 0 ? g.sx[s] : 0;
      ped.position[2] = s >= 0 ? g.sz[s] : 0;
      ped.position[1] = this._groundAt(ped.position[0], ped.position[2]);
      ped.velocity[0] = 0;
      ped.velocity[2] = 0;
      ped.vy = 0;
      this._attachToGraph(ped);
    }
  }

  /**
   * Position integration without a collision world (unit tests, teardown).
   * @param {object} ped Ped record.
   * @returns {void}
   * @private
   */
  _integrateFallback(ped) {
    ped.position[0] += _delta[0];
    ped.position[2] += _delta[2];
    const g = this._groundAt(ped.position[0], ped.position[2]);
    ped.position[1] += _delta[1];
    if (ped.position[1] <= g) {
      ped.position[1] = g;
      ped.vy = 0;
      ped.grounded = true;
    } else {
      ped.grounded = false;
    }
  }

  /* ---------------------------------------------------------------- animation */

  /**
   * Drives the character rig.
   * @param {object} ped Ped record.
   * @param {number} dt Time step.
   * @param {number} speed Ground speed.
   * @returns {void}
   * @private
   */
  _animate(ped, dt, speed) {
    const ch = ped.character;
    if (!ch) return;
    ch.position[0] = ped.position[0];
    ch.position[1] = ped.position[1];
    ch.position[2] = ped.position[2];
    ch.yaw = ped.yaw;

    if (!ped.dead) {
      let state = 'idle';
      if (ped.state === 'cower') state = 'crouch';
      else if (ped.state === 'hit') state = 'hit';
      else if (speed > 5.6) state = 'sprint';
      else if (speed > 2.9) state = 'run';
      else if (speed > 0.28) state = 'walk';
      ch.setState(state);
    }

    _ctx.moveSpeed = speed;
    _ctx.grounded = ped.grounded;
    _ctx.aiming = false;
    _ctx.aimPitch = 0;
    _ctx.crouching = ped.state === 'cower';
    _ctx.distance = ped.distToPlayer;
    // Idle peds glance around; chatting peds look at each other; fleeing peds look back.
    if (ped.state === 'chat' && ped.partner) {
      const dx = ped.partner.position[0] - ped.position[0];
      const dz = ped.partner.position[2] - ped.position[2];
      _ctx.lookYaw = wrapAngle(Math.atan2(-dx, -dz) - ped.yaw);
    } else if (ped.state === 'flee' && ped.hasThreat) {
      const dx = ped.threatX - ped.position[0];
      const dz = ped.threatZ - ped.position[2];
      _ctx.lookYaw = clamp(wrapAngle(Math.atan2(-dx, -dz) - ped.yaw), -1.1, 1.1);
    } else if (ped.state === 'idle') {
      _ctx.lookYaw = Math.sin(this._time * 0.7 + ped.id) * (ped.idleKind === 1 ? 0.15 : 0.55);
    } else {
      _ctx.lookYaw = 0;
    }
    try { ch.update(dt, _ctx); } catch (err) { /* never let one rig break the crowd */ }
  }

  /**
   * Switches state with the bookkeeping that always goes with it.
   * @param {object} ped Ped record.
   * @param {string} state New state name.
   * @returns {void}
   * @private
   */
  _setState(ped, state) {
    if (ped.state === state) return;
    ped.state = state;
    ped.stateTime = 0;
    if (state === 'flee') ped.screamed = false;
  }

  /* ---------------------------------------------------------------- render */

  /**
   * Draws the crowd.
   * @param {object} renderer Renderer.
   * @param {number} [dt] Delta time (unused; kept for the uniform `submit` signature).
   * @returns {void}
   */
  submit(renderer, dt) {
    if (!renderer) return;
    const camera = this.game.camera;
    const cull = camera && typeof camera.frustumContainsSphere === 'function';
    for (let i = 0; i < this.peds.length; i++) {
      const ped = this.peds[i];
      const ch = ped.character;
      if (!ch) continue;
      if (ped.distToPlayer > DRAW_DIST) { ch.visible = false; continue; }
      if (cull) {
        let inView = true;
        try {
          inView = camera.frustumContainsSphere(ped.position[0], ped.position[1] + 0.9,
            ped.position[2], 1.4);
        } catch (err) { inView = true; }
        ch.visible = inView;
      } else {
        ch.visible = true;
      }
      try { ch.submit(renderer); } catch (err) { /* keep drawing the rest of the crowd */ }
    }
    const assets = this._assets;
    if (assets && typeof assets.flush === 'function' && !assets.manualFrames) {
      // Publish the instance counts written this frame. Idempotent: police.js flushes again
      // after it has added its cops.
      assets.flush();
    }
  }
}

/**
 * Packs three numbers into the shared scratch vector (used to pass an explosion centre to the
 * alert helpers without allocating).
 * @param {number} x World x.
 * @param {number} y World y.
 * @param {number} z World z.
 * @returns {Float32Array} The shared vector.
 */
function _hitPointFrom(x, y, z) {
  _hitPoint[0] = x;
  _hitPoint[1] = y;
  _hitPoint[2] = z;
  return _hitPoint;
}
