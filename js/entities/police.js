/**
 * Wanted system and police AI.
 *
 * The wanted level runs 0..5 and drives everything else: how many cruisers are dispatched,
 * whether cops get out and shoot, whether roadblocks are attempted, whether a helicopter is
 * overhead and whether armoured units join in. Each level owns a search timer that only runs
 * down while the player is out of every cop's line of sight; the HUD reads `searchTimer`,
 * `searchMax`, `searching` and `heatMeterVisible` to draw the cooldown.
 *
 * Police cruisers are ordinary {@link Vehicle} instances driven through `vehicle.input` (a
 * pure-pursuit tracker over the lane graph while navigating, a predictive intercept once the
 * player is in sight, plus deliberate ramming at high heat). Cops on foot are `Character`
 * instances that dismount, take cover behind cars, fire in bursts with distance-based accuracy
 * falloff, reload, and shout Korean lines through `game.hud.subtitle`.
 *
 * `update(dt)` allocates nothing, and every entity reference is re-validated each frame so an
 * entity removed by another system (an exploded cruiser, a despawned cop) can never throw.
 *
 * @module entities/police
 */

import { clamp, wrapAngle, angleDamp, Rand } from '../core/math.js';
import { box, cylinder, sphere, mergeGeometries } from '../core/geometry.js';
import { createMaterial } from '../render/materials.js';
import { Character } from './character.js';
import {
  PathGraph, forwardSpeedOf, pursuitSteer, applySpeedControl,
} from './traffic.js';

/* ------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------ */

/** Per-wanted-level response plan. Index 0 is "no heat". */
const RESPONSE = [
  { cars: 0, cops: 0, heli: false, armored: 0, search: 0, aggression: 0, roadblocks: 0, ram: false },
  { cars: 1, cops: 0, heli: false, armored: 0, search: 22, aggression: 0.25, roadblocks: 0, ram: false },
  { cars: 2, cops: 1, heli: false, armored: 0, search: 30, aggression: 0.5, roadblocks: 0, ram: false },
  { cars: 4, cops: 2, heli: false, armored: 0, search: 38, aggression: 0.72, roadblocks: 1, ram: true },
  { cars: 5, cops: 4, heli: true, armored: 0, search: 48, aggression: 0.86, roadblocks: 2, ram: true },
  { cars: 6, cops: 6, heli: true, armored: 2, search: 64, aggression: 1.0, roadblocks: 3, ram: true },
];

/** Crimes the rest of the game reports, with their base wanted contribution. */
const CRIMES = {
  carjack: { amount: 1, ko: '차량 탈취', cooldown: 6 },
  pedKill: { amount: 2, ko: '살인', cooldown: 3 },
  copKill: { amount: 3, ko: '경찰관 살해', cooldown: 1 },
  shooting: { amount: 1, ko: '총기 사용', cooldown: 5 },
  hitPolice: { amount: 2, ko: '경찰차 공격', cooldown: 4 },
  speeding: { amount: 1, ko: '검문소 돌파', cooldown: 10 },
  assault: { amount: 1, ko: '폭행', cooldown: 4 },
  vehicleDestroyed: { amount: 1, ko: '기물 파손', cooldown: 6 },
  explosion: { amount: 3, ko: '폭발물 사용', cooldown: 4 },
};

/** Korean radio chatter shouted at the player. */
const SHOUTS = [
  '꼼짝 마! 경찰이다!',
  '무기를 버리고 손 들어!',
  '지원 요청한다, 용의자 발견!',
  '거기 서! 도망칠 수 없다!',
  '용의자가 도주 중이다, 차단하라!',
  '엄호한다, 접근해!',
  '재장전 중! 엄호해 줘!',
];

/** Lines used while the police are only searching. */
const SEARCH_SHOUTS = [
  '용의자를 놓쳤다, 수색 범위를 넓혀라.',
  '이 구역을 수색한다.',
  '어디 숨었지…',
];

/** Inner radius of the police spawn annulus (metres). */
const SPAWN_MIN = 88;
/** Outer radius of the police spawn annulus (metres). */
const SPAWN_MAX = 165;
/** Candidate lane samples examined per spawn attempt. */
const SPAWN_TRIES = 14;
/** Minimum clearance to other vehicles when spawning (metres). */
const SPAWN_CLEAR = 12;
/** Cruisers beyond this distance are recycled (metres). */
const CAR_DESPAWN = 260;
/** Cars dispatched per second (keeps the response from popping in all at once). */
const DISPATCH_INTERVAL = 1.6;
/** How far a cruiser can see the player (metres). */
const CAR_SIGHT = 85;
/** How far a cop on foot can see the player (metres). */
const COP_SIGHT = 55;
/** Line-of-sight tests are refreshed on this period (seconds). */
const LOS_PERIOD = 0.22;
/** Distance at which a cruiser deploys its cops when the player is on foot (metres). */
const DEPLOY_RANGE = 44;
/** Preferred engagement range for a cop on foot (metres). */
const COP_RANGE = 11;
/** Cop movement speed (m/s). */
const COP_SPEED = 4.6;
/** Cop capsule radius (metres). */
const COP_RADIUS = 0.32;
/** Cop capsule height (metres). */
const COP_HEIGHT = 1.8;
/** Gravity applied to cops (m/s^2). */
const GRAVITY = 18;
/** Seconds a dead cop stays in the world. */
const BODY_TIME = 25;
/** Seconds of being surrounded and still before the player is busted. */
const BUST_TIME = 3;
/** Radius inside which a cop counts towards a bust (metres). */
const BUST_RADIUS = 5.0;
/** Player speed below which a bust can build up (m/s). */
const BUST_SPEED = 0.9;
/** Helicopter cruise altitude above the target (metres). */
const HELI_ALT = 46;
/** Helicopter orbit radius (metres). */
const HELI_ORBIT = 42;
/** Maximum simultaneous sirens (the nearest cars win). */
const MAX_SIRENS = 3;
/** Seconds between two shouted lines. */
const SHOUT_COOLDOWN = 6.5;
/* ------------------------------------------------------------------ *
 * Module scratch
 * ------------------------------------------------------------------ */

const _pt = new Float32Array(2);
const _pt2 = new Float32Array(2);
const _tan = new Float32Array(2);
const _origin = new Float32Array(3);
const _dir = new Float32Array(3);
const _delta = new Float32Array(3);
const _tmp3 = new Float32Array(3);
const _cand = new Int32Array(512);
const _move = { x: 0, y: 0, z: 0, grounded: false, groundY: 0, normal: new Float32Array([0, 1, 0]), hits: 0 };
const _spawn = { x: 0, z: 0, yaw: 0, laneId: -1, laneDist: 0 };
const _ctx = {
  moveSpeed: 0, aiming: false, aimPitch: 0, grounded: true, crouching: false,
  lookYaw: 0, distance: 0,
};
const _fireOpts = { weapon: 'pistol', shooter: null, damageMul: 0.55 };
/** Nearest-first selection scratch used by {@link PoliceSystem#_checkVisibility}. */
const _losIdx = new Int32Array(4);
const _losD2 = new Float64Array(4);

/**
 * Bodies a sight line may pass straight through. Trigger volumes (mission markers, pickups)
 * and water are not cover.
 * @param {object} body Collision body.
 * @returns {boolean} True when the body blocks sight.
 */
function losBlocks(body) {
  return body.tag !== 'trigger' && body.tag !== 'water';
}

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
 * Creates a blank police-cruiser record.
 * @returns {object} Unit record.
 */
function makeUnit() {
  return {
    vehicle: null,
    cops: [],
    state: 'pursue',
    laneId: -1,
    laneDist: 0,
    accum: 0,
    deployTimer: 0,
    ramTimer: 0,
    stuck: 0,
    lastX: 0,
    lastZ: 0,
    blocked: 0,
    bestDist: Infinity,
    noProgress: 0,
    targetX: 0,
    targetZ: 0,
    prevLane: -1,
    prevHealth: 1000,
    siren: null,
    armored: false,
    blockX: 0,
    blockZ: 0,
    lightPhase: 0,
    age: 0,
  };
}

/**
 * Creates a blank cop-on-foot record. The shape deliberately matches a ped record closely
 * enough that `PedManager.raycastPeds` can shoot at cops too.
 * @returns {object} Cop record.
 */
function makeCop() {
  return {
    isCop: true,
    character: null,
    position: new Float32Array(3),
    velocity: new Float32Array(3),
    yaw: 0,
    vy: 0,
    grounded: true,
    speed: 0,

    health: 100,
    maxHealth: 100,
    dead: false,
    state: 'chase',
    stateTime: 0,
    bodyTimer: 0,

    weapon: 'pistol',
    mag: 12,
    magSize: 12,
    fireTimer: 0,
    burst: 0,
    reloadTimer: 0,
    accuracy: 1,

    coverX: 0,
    coverZ: 0,
    hasCover: false,
    coverTimer: 0,

    unit: null,
    armored: false,
    standDown: 0,
    accum: 0,
    phase: 0,
    distToPlayer: 1e9,
    female: false,
    bucket: 'copM',
  };
}

/* ------------------------------------------------------------------ *
 * PoliceSystem
 * ------------------------------------------------------------------ */

/**
 * Owns the wanted level and every police entity it dispatches.
 */
export class PoliceSystem {
  /**
   * @param {object} game The {@link Game} instance (see docs/ARCHITECTURE.md section 16).
   */
  constructor(game) {
    /** @type {object} */
    this.game = game;
    /** @type {object} */
    this.city = (game && game.city) || { lanes: [], nodes: [], landmarks: [], spawns: null };
    /** @type {Rand} Seeded generator; never `Math.random`. */
    this.rng = game && game.rng && typeof game.rng.fork === 'function'
      ? game.rng.fork('police') : new Rand(0x9110CE);

    /** @type {number} Current wanted level, 0..5. */
    this.wanted = 0;
    /** @type {number} Seconds left before the level drops while the player is unseen. */
    this.searchTimer = 0;
    /** @type {number} Full value of {@link PoliceSystem#searchTimer} for the current level. */
    this.searchMax = 0;
    /** @type {boolean} True while the police have lost the player and are searching. */
    this.searching = false;
    /** @type {boolean} True whenever the HUD should show the heat meter. */
    this.heatMeterVisible = false;
    /** @type {object[]} Dispatched cruisers (each has a `.vehicle`). */
    this.cars = [];
    /** @type {object[]} Cops on foot (each has a `.character`). */
    this.cops = [];
    /** @type {object|null} The circling helicopter, when one is up. */
    this.helicopter = null;
    /** @type {{x:number,z:number,valid:boolean}} Last position the police saw the player at. */
    this.lastKnown = { x: 0, z: 0, valid: false };
    /** @type {boolean} True while the player is inside somebody's line of sight. */
    this.playerVisible = false;
    /** @type {number} Total busts this session. */
    this.busts = 0;

    // The lane index is shared with the traffic manager when it exists (same data, one copy).
    const shared = game && game.traffic ? game.traffic.lanes : null;
    /** @type {PathGraph} Lane graph index used for dispatch and navigation. */
    this.lanes = shared && typeof shared.queryRing === 'function'
      ? shared : new PathGraph(this.city.lanes || [], { step: 6, cell: 32 });

    this._unitPool = [];
    this._copPool = [];
    this._charPool = [];
    this._time = 0;
    this._frame = 0;
    this._losTimer = 0;
    this._dispatchTimer = 0;
    this._shoutTimer = 0;
    this._bustTimer = 0;
    this._crimeTimers = Object.create(null);
    this._spawnCursor = 0;
    this._roadblockTimer = 0;
    this._roadblocks = 0;
    this._starveTimer = 0;
    this._heliAngle = 0;
    this._heliAssets = null;
    this._assets = (game && game.characterAssets) || null;
    this._station = this._findStation();
    /** Time of the last shot the *player* fired; used to attribute cruiser damage. @private */
    this._playerShotTime = -1e9;
    if (game && typeof game.on === 'function') {
      game.on('weaponFired', (e) => {
        if (e && e.player) this._playerShotTime = this._time;
      });
      game.on('explosion', () => { this._playerShotTime = this._time; });
    }
  }

  /**
   * Locates the police station (used for the busted respawn).
   * @returns {{x:number, y:number, z:number, yaw:number}} Station spawn point.
   * @private
   */
  _findStation() {
    const city = this.city;
    const out = { x: 0, y: 0, z: 0, yaw: 0 };
    const marks = city.landmarks;
    if (Array.isArray(marks)) {
      for (let i = 0; i < marks.length; i++) {
        if (marks[i] && marks[i].kind === 'police') {
          out.x = fin(marks[i].x, 0);
          out.z = fin(marks[i].z, 0);
          break;
        }
      }
    }
    const spawns = city.spawns && city.spawns.police;
    if (Array.isArray(spawns) && spawns.length > 0) {
      // Prefer a real sidewalk spot beside the station over the building centre.
      let best = spawns[0];
      let bestD = Infinity;
      for (let i = 0; i < spawns.length; i++) {
        const dx = fin(spawns[i].x, 0) - out.x;
        const dz = fin(spawns[i].z, 0) - out.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = spawns[i]; }
      }
      out.x = fin(best.x, out.x);
      out.y = fin(best.y, 0);
      out.z = fin(best.z, out.z);
      out.yaw = fin(best.yaw, 0);
    }
    return out;
  }

  /* ---------------------------------------------------------------- wanted */

  /**
   * Raises (or lowers) the wanted level.
   * @param {number} amount Stars to add; negative values reduce the level.
   * @param {string} [reason] Free-form tag for logging / notifications.
   * @returns {number} The new wanted level.
   */
  addWanted(amount, reason) {
    const before = this.wanted;
    let next = clamp(Math.round(before + fin(amount, 0)), 0, 5);
    if (next === before) {
      if (next > 0) this.searchTimer = this.searchMax;
      return before;
    }
    if (next === 0) {
      this.clearWanted();
      return 0;
    }
    this.wanted = next;
    this.searchMax = RESPONSE[next].search;
    this.searchTimer = this.searchMax;
    this.searching = false;
    this.heatMeterVisible = true;
    const game = this.game;
    if (next > before) {
      if (game.sfx && typeof game.sfx.wanted === 'function') {
        try { game.sfx.wanted(next); } catch (err) { /* audio off */ }
      }
      const player = game.player;
      if (player && player.position) {
        this.lastKnown.x = fin(player.position[0], 0);
        this.lastKnown.z = fin(player.position[2], 0);
        this.lastKnown.valid = true;
      }
      if (game.hud && typeof game.hud.notify === 'function' && reason) {
        const crime = CRIMES[reason];
        if (crime) {
          try { game.hud.notify(`수배: ${crime.ko}`, 'wanted', 2.4); } catch (err) { /* ignore */ }
        }
      }
    }
    if (typeof game.emit === 'function') game.emit('wantedChanged', this.wanted);
    return this.wanted;
  }

  /**
   * Reports a specific crime. Repeats of the same crime inside its cooldown only refresh the
   * search timer, so a rampage escalates smoothly instead of jumping straight to five stars.
   * @param {string} kind One of `carjack`, `pedKill`, `copKill`, `shooting`, `hitPolice`,
   *   `speeding`, `assault`, `vehicleDestroyed`, `explosion`.
   * @param {ArrayLike<number>} [pos] Where it happened.
   * @returns {number} The resulting wanted level.
   */
  reportCrime(kind, pos) {
    const crime = CRIMES[kind] || CRIMES.assault;
    const now = this._time;
    const last = this._crimeTimers[kind];
    if (pos) {
      this.lastKnown.x = fin(pos[0], this.lastKnown.x);
      this.lastKnown.z = fin(pos[2], this.lastKnown.z);
      this.lastKnown.valid = true;
    }
    if (last !== undefined && now - last < crime.cooldown) {
      if (this.wanted > 0) this.searchTimer = this.searchMax;
      return this.wanted;
    }
    this._crimeTimers[kind] = now;
    // Escalation slows as the heat rises: the last stars have to be earned.
    let amount = crime.amount;
    if (this.wanted >= 3) amount = Math.min(amount, 1);
    if (this.wanted >= 4 && kind !== 'copKill') amount = Math.min(amount, 1);
    const target = Math.max(this.wanted + amount, kind === 'copKill' ? 3 : 1);
    return this.addWanted(target - this.wanted, kind);
  }

  /**
   * Clears the wanted level and removes every dispatched unit with no leaks.
   * @returns {void}
   */
  clearWanted() {
    const had = this.wanted;
    this.wanted = 0;
    this.searchTimer = 0;
    this.searchMax = 0;
    this.searching = false;
    this.heatMeterVisible = false;
    this.playerVisible = false;
    this.lastKnown.valid = false;
    this._bustTimer = 0;
    this._roadblocks = 0;
    this._dispatchTimer = 0;
    this._starveTimer = 0;

    for (let i = this.cars.length - 1; i >= 0; i--) this._removeUnit(this.cars[i], true);
    this.cars.length = 0;
    for (let i = this.cops.length - 1; i >= 0; i--) this._retireCop(this.cops[i]);
    this.cops.length = 0;
    this._removeHelicopter();
    if (had > 0 && typeof this.game.emit === 'function') this.game.emit('wantedChanged', 0);
  }

  /* ---------------------------------------------------------------- pooling */

  /**
   * @returns {object} A pooled or fresh unit record.
   * @private
   */
  _acquireUnit() {
    const u = this._unitPool.length > 0 ? this._unitPool.pop() : makeUnit();
    u.cops.length = 0;
    u.state = 'pursue';
    u.laneId = -1;
    u.laneDist = 0;
    u.accum = 0;
    u.deployTimer = 0;
    u.ramTimer = 0;
    u.stuck = 0;
    u.blocked = 0;
    u.bestDist = Infinity;
    u.noProgress = 0;
    u.targetX = 1e9;
    u.targetZ = 1e9;
    u.prevLane = -1;
    u.siren = null;
    u.armored = false;
    u.lightPhase = this.rng.next() * 6.28;
    u.age = 0;
    return u;
  }

  /**
   * Removes a cruiser: stops its siren, releases its cops and disposes of the vehicle.
   * @param {object} unit Unit record.
   * @param {boolean} [immediate=false] Also drop cops that are still alive.
   * @param {boolean} [keepVehicle=false] Leave the vehicle in the world (the player took it,
   *   or it is a wreck the traffic manager will stream out).
   * @returns {void}
   * @private
   */
  _removeUnit(unit, immediate = false, keepVehicle = false) {
    if (!unit) return;
    const i = this.cars.indexOf(unit);
    if (i >= 0) this.cars.splice(i, 1);
    if (unit.siren) {
      try { unit.siren.stop(); } catch (err) { /* audio off */ }
      unit.siren = null;
    }
    const v = unit.vehicle;
    unit.vehicle = null;
    if (v) {
      v.policeUnit = null;
      if (!keepVehicle) {
        // Hand a wreck to the traffic streamer so it fades out with everything else, instead of
        // vanishing the instant it stops burning.
        const traffic = this.game.traffic;
        const wrecks = traffic && Array.isArray(traffic.wrecks) ? traffic.wrecks : null;
        if (v.isDestroyed && wrecks && wrecks.length < 24 && wrecks.indexOf(v) < 0) {
          wrecks.push(v);
        } else if (typeof this.game.removeVehicle === 'function') {
          try { this.game.removeVehicle(v); } catch (err) { /* already gone */ }
        }
      }
    }
    if (immediate) {
      for (let k = unit.cops.length - 1; k >= 0; k--) {
        const cop = unit.cops[k];
        const ci = this.cops.indexOf(cop);
        if (ci >= 0) this.cops.splice(ci, 1);
        this._retireCop(cop);
      }
    } else {
      for (let k = 0; k < unit.cops.length; k++) if (unit.cops[k]) unit.cops[k].unit = null;
    }
    unit.cops.length = 0;
    if (this._unitPool.length < 16) this._unitPool.push(unit);
  }

  /**
   * @param {boolean} armored Whether this is an armoured trooper.
   * @returns {object|null} A pooled or fresh cop record with a character attached.
   * @private
   */
  _acquireCop(armored) {
    const assets = this._assets || (this.game && this.game.characterAssets) || null;
    if (!assets) return null;
    this._assets = assets;
    const cop = this._copPool.length > 0 ? this._copPool.pop() : makeCop();
    const rng = this.rng;
    cop.female = rng.chance(0.22);
    let ch = null;
    for (let i = this._charPool.length - 1; i >= 0; i--) {
      if (this._charPool[i].female === cop.female) { ch = this._charPool.splice(i, 1)[0]; break; }
    }
    if (!ch) {
      try {
        ch = new Character(assets, {
          kind: 'cop', female: cop.female, seed: rng.int(1, 0x7ffffff),
          height: cop.female ? rng.range(1.63, 1.75) : rng.range(1.74, 1.92),
          build: armored ? rng.range(1.1, 1.2) : rng.range(0.95, 1.12),
          accent: armored ? [0.03, 0.03, 0.035] : undefined,
        });
      } catch (err) {
        this._copPool.push(cop);
        return null;
      }
    }
    ch.visible = true;
    ch.lod = 0;
    cop.character = ch;

    cop.armored = !!armored;
    cop.maxHealth = armored ? 220 : 120;
    cop.health = cop.maxHealth;
    cop.dead = false;
    cop.bodyTimer = 0;
    cop.state = 'chase';
    cop.stateTime = 0;
    cop.weapon = armored || this.wanted >= 4 ? 'rifle' : 'pistol';
    cop.magSize = cop.weapon === 'rifle' ? 30 : 12;
    cop.mag = cop.magSize;
    cop.fireTimer = rng.range(0.3, 1.1);
    cop.burst = 0;
    cop.reloadTimer = 0;
    cop.accuracy = armored ? 1.35 : 1;
    cop.hasCover = false;
    cop.coverTimer = 0;
    cop.standDown = 0;
    cop.velocity[0] = 0;
    cop.velocity[1] = 0;
    cop.velocity[2] = 0;
    cop.vy = 0;
    cop.grounded = true;
    cop.speed = 0;
    cop.accum = 0;
    cop.phase = this._frame & 1;
    cop.distToPlayer = 1e9;
    cop.unit = null;
    return cop;
  }

  /**
   * @param {object} cop Cop record (already spliced out of {@link PoliceSystem#cops}).
   * @returns {void}
   * @private
   */
  _retireCop(cop) {
    if (!cop) return;
    const ch = cop.character;
    cop.character = null;
    cop.unit = null;
    cop.dead = false;
    if (ch && !ch.dead && !ch._ragActive && this._charPool.length < 12) {
      ch.visible = false;
      ch.female = cop.female;
      this._charPool.push(ch);
    }
    if (this._copPool.length < 16) this._copPool.push(cop);
  }

  /* ---------------------------------------------------------------- dispatch */

  /**
   * Finds a spawn point on the lane network inside an annulus around the player, preferring
   * points the player cannot see.
   * @param {number} px Player x.
   * @param {number} pz Player z.
   * @param {number} rMin Inner radius.
   * @param {number} rMax Outer radius.
   * @returns {boolean} True when `_spawn` was filled in.
   * @private
   */
  _findSpawn(px, pz, rMin, rMax, requireHidden = false) {
    const g = this.lanes;
    if (!g || g.sampleCount === 0) return false;
    const n = g.queryRing(px, pz, rMin, rMax, _cand);
    if (n === 0) return false;
    const camera = this.game.camera;
    let bestSample = -1;
    let bestScore = -Infinity;
    for (let t = 0; t < SPAWN_TRIES; t++) {
      this._spawnCursor = (this._spawnCursor + 1 + this.rng.int(0, 5)) % n;
      const s = _cand[this._spawnCursor];
      const lane = this.city.lanes[g.sPoly[s]];
      if (!lane) continue;
      if (lane.edgeId !== undefined && lane.edgeId < 0) continue;
      const x = g.sx[s];
      const z = g.sz[s];
      if (!this._spotClear(x, z, SPAWN_CLEAR)) continue;
      let score = 10;
      if (camera && typeof camera.frustumContainsSphere === 'function') {
        let visible = false;
        try { visible = camera.frustumContainsSphere(x, 1.2, z, 3.5); } catch (err) { visible = false; }
        if (visible) {
          if (requireHidden) continue;
          score = 0;
        }
      }
      const dx = x - px;
      const dz = z - pz;
      score += 8 - Math.abs(Math.sqrt(dx * dx + dz * dz) - (rMin + 24)) * 0.05;
      if (score > bestScore) { bestScore = score; bestSample = s; }
      if (score >= 15 && t >= 3) break;
    }
    if (bestSample < 0) return false;
    const lane = g.sPoly[bestSample];
    const d = g.sDist[bestSample];
    g.sample(lane, d, _pt);
    g.tangent(lane, d, _tan);
    _spawn.x = _pt[0];
    _spawn.z = _pt[1];
    _spawn.yaw = Math.atan2(-_tan[0], -_tan[1]);
    _spawn.laneId = lane;
    _spawn.laneDist = d;
    return true;
  }

  /**
   * @param {number} x World x.
   * @param {number} z World z.
   * @param {number} clear Required clearance in metres.
   * @returns {boolean} True when no vehicle sits within `clear`.
   * @private
   */
  _spotClear(x, z, clear) {
    const list = this.game.vehicles;
    if (!Array.isArray(list)) return true;
    const c2 = clear * clear;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!v || !v.position) continue;
      const dx = v.position[0] - x;
      const dz = v.position[2] - z;
      if (dx * dx + dz * dz < c2) return false;
    }
    return true;
  }

  /**
   * Dispatches one cruiser.
   * @param {number} px Player x.
   * @param {number} pz Player z.
   * @param {boolean} armored Whether this is an armoured unit.
   * @returns {object|null} The unit, or null when nothing could be spawned.
   * @private
   */
  _dispatchCar(px, pz, armored, close = false) {
    const game = this.game;
    if (typeof game.spawnVehicle !== 'function') return null;
    // `close` is the starvation fallback: nothing has reached the suspect for a while, so the
    // road route (not the car count) is the problem. Dispatch from a tighter ring, but only
    // onto a spot the player cannot currently see, so a cruiser never pops into frame.
    const found = close
      ? (this._findSpawn(px, pz, 52, 96, true) || this._findSpawn(px, pz, SPAWN_MIN, SPAWN_MAX))
      : this._findSpawn(px, pz, SPAWN_MIN, SPAWN_MAX);
    if (!found) return null;
    let v = null;
    try {
      v = game.spawnVehicle('police', _spawn.x, _spawn.z, _spawn.yaw, { isPolice: true });
    } catch (err) {
      v = null;
    }
    if (!v) return null;

    const unit = this._acquireUnit();
    unit.vehicle = v;
    unit.laneId = _spawn.laneId;
    unit.laneDist = _spawn.laneDist;
    unit.armored = armored;
    unit.prevHealth = fin(v.health, 1000);
    unit.lastX = v.position[0];
    unit.lastZ = v.position[2];
    unit.state = this.wanted >= 2 ? 'pursue' : 'investigate';
    v.policeUnit = unit;
    v.isPolice = true;
    v.parked = false;
    v.visible = true;
    v.engineOn = true;
    if (typeof v.setLights === 'function') {
      try { v.setLights(true, false, false, true); } catch (err) { /* optional */ }
    }
    this.cars.push(unit);
    return unit;
  }

  /**
   * Attempts a roadblock ahead of the player.
   * @param {number} px Player x.
   * @param {number} pz Player z.
   * @param {number} vx Player velocity x.
   * @param {number} vz Player velocity z.
   * @returns {boolean} True when a block was placed.
   * @private
   */
  _placeRoadblock(px, pz, vx, vz) {
    const sp = Math.hypot(vx, vz);
    if (sp < 4) return false;
    const ax = px + (vx / sp) * 110;
    const az = pz + (vz / sp) * 110;
    if (!this._findSpawn(ax, az, 0, 55)) return false;
    const g = this.lanes;
    g.tangent(_spawn.laneId, _spawn.laneDist, _tan);
    // Park across the lane: nose pointing along the kerb normal.
    const nx = -_tan[1];
    const nz = _tan[0];
    const yaw = Math.atan2(-nx, -nz);
    const game = this.game;
    let placed = 0;
    for (let k = -1; k <= 1; k += 2) {
      const x = _spawn.x + nx * k * 2.4;
      const z = _spawn.z + nz * k * 2.4;
      if (!this._spotClear(x, z, 3.4)) continue;
      let v = null;
      try { v = game.spawnVehicle('police', x, z, yaw, { isPolice: true }); } catch (err) { v = null; }
      if (!v) continue;
      const unit = this._acquireUnit();
      unit.vehicle = v;
      unit.state = 'roadblock';
      unit.blockX = _spawn.x;
      unit.blockZ = _spawn.z;
      unit.prevHealth = fin(v.health, 1000);
      unit.lastX = x;
      unit.lastZ = z;
      v.policeUnit = unit;
      v.isPolice = true;
      v.parked = true;
      if (v.input) {
        v.input.throttle = 0;
        v.input.brake = 1;
        v.input.handbrake = true;
        v.input.steer = 0;
      }
      if (typeof v.setLights === 'function') {
        try { v.setLights(true, true, false, true); } catch (err) { /* optional */ }
      }
      this.cars.push(unit);
      placed++;
    }
    if (placed > 0) {
      this._roadblocks++;
      this._notify('전방에 검문소가 설치되었습니다.', 'warn');
    }
    return placed > 0;
  }

  /* ---------------------------------------------------------------- update */

  /**
   * Advances the wanted system and every police entity.
   * @param {number} dt Delta time in seconds.
   * @returns {void}
   */
  update(dt) {
    const step = dt > 0.25 ? 0.25 : dt > 0 ? dt : 0;
    this._time += step;
    this._frame++;
    if (this._shoutTimer > 0) this._shoutTimer -= step;
    if (!this._assets && this.game) this._assets = this.game.characterAssets || null;

    const game = this.game;
    const player = game.player || null;
    const px = player && player.position ? fin(player.position[0], 0) : 0;
    const pz = player && player.position ? fin(player.position[2], 0) : 0;

    this.heatMeterVisible = this.wanted > 0;

    // Dead cops and stray cruisers are cleaned up even at zero heat.
    this._updateCops(step, px, pz);
    this._updateCars(step, px, pz);

    if (this.wanted <= 0) {
      this.searching = false;
      this.playerVisible = false;
      this._bustTimer = 0;
      if (this.cars.length > 0) {
        for (let i = this.cars.length - 1; i >= 0; i--) this._removeUnit(this.cars[i], true);
      }
      this._removeHelicopter();
      return;
    }

    const plan = RESPONSE[this.wanted];

    // --- line of sight --------------------------------------------------------------
    this._losTimer -= step;
    if (this._losTimer <= 0) {
      this._losTimer = LOS_PERIOD;
      this.playerVisible = this._checkVisibility(player, px, pz);
    }
    if (this.playerVisible) {
      this.lastKnown.x = px;
      this.lastKnown.z = pz;
      this.lastKnown.valid = true;
      this.searchTimer = this.searchMax;
      this.searching = false;
    } else {
      this.searching = true;
      this.searchTimer -= step;
      if (this.searchTimer <= 0) {
        const next = this.wanted - 1;
        if (next <= 0) {
          this.clearWanted();
          this._notify('경찰이 수색을 포기했습니다.', 'info');
          return;
        }
        this.wanted = next;
        this.searchMax = RESPONSE[next].search;
        this.searchTimer = this.searchMax;
        if (typeof game.emit === 'function') game.emit('wantedChanged', this.wanted);
      }
    }

    // --- dispatch ---------------------------------------------------------------------
    // While searching, units are sent to the last place the suspect was seen. Dispatching
    // them around his *actual* position handed them a free sighting the moment they spawned,
    // which re-armed the search timer for ever: the heat could never be lost by hiding.
    const searchX = this.searching && this.lastKnown.valid ? this.lastKnown.x : px;
    const searchZ = this.searching && this.lastKnown.valid ? this.lastKnown.z : pz;
    this._dispatchTimer -= step;
    let pursuing = 0;
    let closest = Infinity;
    for (let i = 0; i < this.cars.length; i++) {
      const u = this.cars[i];
      if (u.state !== 'roadblock') pursuing++;
      const v = u.vehicle;
      if (!v || !v.position || !Number.isFinite(v.position[0])) continue;
      const dx = v.position[0] - searchX;
      const dz = v.position[2] - searchZ;
      const d2 = dx * dx + dz * dz;
      if (d2 < closest) closest = d2;
    }
    // Starvation: cars are being dispatched but none of them can reach the place they are
    // being sent to, because the lane route in is blocked or the greedy route loops. Without
    // this the response is an endless stream of cruisers circling two blocks away and a
    // wanted level nobody ever comes to collect.
    if (closest < 3600) this._starveTimer = 0;
    else this._starveTimer += step;
    if (this._dispatchTimer <= 0 && pursuing < plan.cars) {
      this._dispatchTimer = DISPATCH_INTERVAL;
      const armored = plan.armored > 0 && pursuing >= plan.cars - plan.armored;
      this._dispatchCar(searchX, searchZ, armored, this._starveTimer > 18);
    }

    // --- roadblocks --------------------------------------------------------------------
    if (plan.roadblocks > 0 && this._roadblocks < plan.roadblocks) {
      this._roadblockTimer -= step;
      if (this._roadblockTimer <= 0) {
        this._roadblockTimer = 14;
        if (player && player.vehicle && player.velocity) {
          this._placeRoadblock(px, pz, fin(player.velocity[0], 0), fin(player.velocity[2], 0));
        }
      }
    }

    // --- helicopter ---------------------------------------------------------------------
    if (plan.heli) this._updateHelicopter(step, px, pz);
    else this._removeHelicopter();

    // --- busted -------------------------------------------------------------------------
    this._updateBusted(step, player, px, pz);

    // --- chatter -------------------------------------------------------------------------
    if (this._shoutTimer <= 0 && this.cops.length > 0) {
      const near = this._nearestCopDistance(px, pz);
      if (near < 30) {
        this._shoutTimer = SHOUT_COOLDOWN;
        const line = this.searching ? this.rng.pick(SEARCH_SHOUTS) : this.rng.pick(SHOUTS);
        if (game.hud && typeof game.hud.subtitle === 'function') {
          try { game.hud.subtitle(line, 2.6); } catch (err) { /* ignore */ }
        }
      }
    }
  }

  /**
   * @param {number} px Player x.
   * @param {number} pz Player z.
   * @returns {number} Distance to the closest living cop, or Infinity.
   * @private
   */
  _nearestCopDistance(px, pz) {
    let best = Infinity;
    for (let i = 0; i < this.cops.length; i++) {
      const cop = this.cops[i];
      if (cop.dead) continue;
      const dx = cop.position[0] - px;
      const dz = cop.position[2] - pz;
      const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    return best === Infinity ? Infinity : Math.sqrt(best);
  }

  /**
   * Tests whether any police entity currently has line of sight on the player.
   * @param {object|null} player Player.
   * @param {number} px Player x.
   * @param {number} pz Player z.
   * @returns {boolean} True when the player is being watched.
   * @private
   */
  _checkVisibility(player, px, pz) {
    if (!player || player.dead) return false;
    if (this.helicopter && this.helicopter.locked) return true;
    const py = fin(player.position ? player.position[1] : 0, 0) + 1.1;
    // Only a handful of raycasts are affordable per refresh, so they have to be spent on the
    // *nearest* watchers. Walking the list in order and stopping after four burnt the budget
    // on whichever cruisers happened to be dispatched first, so a unit sitting eight metres
    // from the suspect was never tested and the police stayed blind while parked next to him.
    let n = this._nearestFour(this.cars, px, pz, CAR_SIGHT, true);
    for (let k = 0; k < n; k++) {
      const v = this.cars[_losIdx[k]].vehicle;
      if (this._lineOfSight(v.position[0], v.position[1] + 1.1, v.position[2], px, py, pz)) return true;
    }
    n = this._nearestFour(this.cops, px, pz, COP_SIGHT, false);
    for (let k = 0; k < n; k++) {
      const cop = this.cops[_losIdx[k]];
      if (this._lineOfSight(cop.position[0], cop.position[1] + 1.5, cop.position[2], px, py, pz)) return true;
    }
    return false;
  }

  /**
   * Fills `_losIdx` with the indices of up to four live watchers nearest the player.
   * @param {object[]} list `cars` (unit records) or `cops`.
   * @param {number} px Player x.
   * @param {number} pz Player z.
   * @param {number} sight Maximum range in metres.
   * @param {boolean} isCar True when `list` holds unit records rather than cop records.
   * @returns {number} How many indices were written (0..4).
   * @private
   */
  _nearestFour(list, px, pz, sight, isCar) {
    let n = 0;
    const max = sight * sight;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      let x;
      let z;
      if (isCar) {
        const v = e.vehicle;
        if (!v || !v.position || v.isDestroyed || !Number.isFinite(v.position[0])) continue;
        x = v.position[0];
        z = v.position[2];
      } else {
        if (e.dead) continue;
        x = e.position[0];
        z = e.position[2];
      }
      const dx = px - x;
      const dz = pz - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > max) continue;
      // Insertion sort into a fixed four-slot buffer; no allocation, no full sort.
      let slot = n < 4 ? n++ : 4;
      if (slot === 4) {
        if (d2 >= _losD2[3]) continue;
        slot = 3;
      }
      while (slot > 0 && _losD2[slot - 1] > d2) {
        _losD2[slot] = _losD2[slot - 1];
        _losIdx[slot] = _losIdx[slot - 1];
        slot--;
      }
      _losD2[slot] = d2;
      _losIdx[slot] = i;
    }
    return n;
  }

  /**
   * Raycasts the static world between two points.
   * @param {number} ax From x.
   * @param {number} ay From y.
   * @param {number} az From z.
   * @param {number} bx To x.
   * @param {number} by To y.
   * @param {number} bz To z.
   * @returns {boolean} True when nothing solid is in the way.
   * @private
   */
  _lineOfSight(ax, ay, az, bx, by, bz) {
    const coll = this.game.collision;
    _dir[0] = bx - ax;
    _dir[1] = by - ay;
    _dir[2] = bz - az;
    const l = Math.hypot(_dir[0], _dir[1], _dir[2]);
    if (!(l > 0.2)) return true;
    if (!coll || typeof coll.raycast !== 'function') return true;
    _dir[0] /= l; _dir[1] /= l; _dir[2] /= l;
    _origin[0] = ax; _origin[1] = ay; _origin[2] = az;
    let hit = null;
    try { hit = coll.raycast(_origin, _dir, l - 0.4, losBlocks); } catch (err) { hit = null; }
    return !hit;
  }

  /* ---------------------------------------------------------------- cruisers */

  /**
   * Updates every dispatched cruiser.
   * @param {number} dt Time step.
   * @param {number} px Player x.
   * @param {number} pz Player z.
   * @returns {void}
   * @private
   */
  _updateCars(dt, px, pz) {
    const game = this.game;
    const player = game.player || null;
    const plan = RESPONSE[this.wanted] || RESPONSE[0];
    const vehicles = Array.isArray(game.vehicles) ? game.vehicles : null;
    let sirens = 0;

    for (let i = this.cars.length - 1; i >= 0; i--) {
      const unit = this.cars[i];
      const v = unit.vehicle;
      // The vehicle may have been removed by an explosion, a mission cleanup or a respawn.
      if (!v || !v.position || !Number.isFinite(v.position[0])
        || (vehicles && vehicles.indexOf(v) < 0)) {
        this._removeUnit(unit, false);
        continue;
      }
      unit.age += dt;

      // Player rammed or shot the cruiser. Proximity alone is not evidence: cruisers scrape
      // kerbs, traffic and each other constantly during a pursuit, and blaming the player for
      // every dent used to re-arm the search timer several times a second, so the heat could
      // never decay while a unit was anywhere near him.
      const hp = fin(v.health, unit.prevHealth);
      if (hp < unit.prevHealth - 12 && this._playerBlamed(player, v, px, pz)) {
        this.reportCrime('hitPolice', v.position);
      }
      unit.prevHealth = hp;

      if (v.isDestroyed || hp <= 0) {
        // Bail out the crew, then drop the wreck.
        this._bailOut(unit);
        this._removeUnit(unit, false);
        continue;
      }
      if (v.driver === player || v.isPlayer) {
        // Player stole a cruiser: hand the car over rather than deleting it under him.
        this._bailOut(unit);
        this._removeUnit(unit, false, true);
        v.isPolice = true;
        // Hand the lamps back to automatic control; the siren is the player's business now.
        if (typeof v.setLights === 'function') {
          try { v.setLights(null); } catch (err) { /* optional */ }
        }
        const traffic = game.traffic;
        if (traffic && Array.isArray(traffic.orphans) && traffic.orphans.indexOf(v) < 0
          && traffic.orphans.length < 24) {
          traffic.orphans.push(v);
        }
        this.reportCrime('carjack', v.position);
        continue;
      }

      const dx = v.position[0] - px;
      const dz = v.position[2] - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 > CAR_DESPAWN * CAR_DESPAWN && this.wanted > 0) {
        this._removeUnit(unit, false);
        continue;
      }

      // Sirens: only the nearest few, so the mix stays readable.
      if (this.wanted > 0 && sirens < MAX_SIRENS && d2 < 130 * 130 && unit.state !== 'roadblock') {
        sirens++;
        if (!unit.siren && game.sfx && typeof game.sfx.siren === 'function') {
          try { unit.siren = game.sfx.siren(v.position); } catch (err) { unit.siren = null; }
        } else if (unit.siren && typeof unit.siren.setPosition === 'function') {
          try { unit.siren.setPosition(v.position[0], v.position[1], v.position[2]); }
          catch (err) { unit.siren = null; }
        }
      } else if (unit.siren) {
        try { unit.siren.stop(); } catch (err) { /* audio off */ }
        unit.siren = null;
      }

      if (unit.state === 'roadblock') {
        this._updateRoadblock(unit, dt, player, px, pz);
        continue;
      }
      // Keep the label honest: a unit dispatched to investigate a single-star report is an
      // active pursuit once the heat rises (and back again if it falls).
      unit.state = this.wanted >= 2 ? 'pursue' : 'investigate';

      // Deploy cops when the player is on foot nearby, or at high heat.
      // The crew also gets out when the car has stopped making headway: if the cruiser cannot
      // route any closer, officers on foot are the only thing that will ever reach the
      // suspect, and "the police simply never turn up" is the worst failure this system has.
      const stranded = unit.noProgress > 6 || this._starveTimer > 14;
      const wantDeploy = player && !player.vehicle && !player.dead
        && (d2 < DEPLOY_RANGE * DEPLOY_RANGE || (this.wanted >= 4 && d2 < 3600)
          || (stranded && d2 < 6400));
      if (wantDeploy && unit.cops.length === 0 && this.cops.length < plan.cops) {
        unit.deployTimer += dt;
        // Officers get out as soon as the cruiser is down to walking pace. Waiting for a dead
        // stop meant a unit that could not quite park never put anybody on the pavement, and
        // the crew is what actually reaches a suspect the car cannot route to.
        if (unit.deployTimer > 0.4 && Math.abs(forwardSpeedOf(v)) < 4.5) this._deploy(unit);
      } else {
        unit.deployTimer = 0;
      }

      // Throttle the AI for distant cruisers.
      const period = d2 > 14400 ? 1 / 10 : 0;
      if (period > 0) {
        unit.accum += dt;
        if (unit.accum < period) continue;
        this._driveUnit(unit, unit.accum, player, px, pz, plan);
        unit.accum = 0;
      } else {
        this._driveUnit(unit, dt, player, px, pz, plan);
      }
    }
  }

  /**
   * Whether the player can plausibly be blamed for damage a cruiser has just taken.
   *
   * Two cases count: the player's own vehicle is in contact with the cruiser (a ram), or the
   * player fired a shot / set off an explosion in the last two seconds with the cruiser in
   * range. Everything else is the AI wrecking its own car.
   * @param {object|null} player Player.
   * @param {object} v The damaged cruiser.
   * @param {number} px Player x.
   * @param {number} pz Player z.
   * @returns {boolean} True when the crime should be reported.
   * @private
   */
  _playerBlamed(player, v, px, pz) {
    if (!player) return false;
    const pv = player.vehicle;
    if (pv && pv !== v && pv.position) {
      const reach = ((pv.type && pv.type.length) || 4.4) * 0.5
        + ((v.type && v.type.length) || 4.9) * 0.5 + 1.6;
      const dx = pv.position[0] - v.position[0];
      const dz = pv.position[2] - v.position[2];
      if (dx * dx + dz * dz < reach * reach) return true;
    }
    if (this._time - this._playerShotTime < 2) {
      const dx = v.position[0] - px;
      const dz = v.position[2] - pz;
      if (dx * dx + dz * dz < 120 * 120) return true;
    }
    return false;
  }

  /**
   * A parked roadblock cruiser: watch for the player barging through it.
   * @param {object} unit Unit record.
   * @param {number} dt Time step.
   * @param {object|null} player Player.
   * @param {number} px Player x.
   * @param {number} pz Player z.
   * @returns {void}
   * @private
   */
  _updateRoadblock(unit, dt, player, px, pz) {
    const v = unit.vehicle;
    if (v.input) {
      v.input.throttle = 0;
      v.input.brake = 1;
      v.input.steer = 0;
      v.input.handbrake = true;
      v.input.horn = false;
    }
    const dx = px - unit.blockX;
    const dz = pz - unit.blockZ;
    if (dx * dx + dz * dz < 144 && player && player.vehicle) {
      const sp = Math.hypot(fin(player.velocity[0], 0), fin(player.velocity[2], 0));
      if (sp > 14) this.reportCrime('speeding', player.position);
    }
    // Blocks stream out once the chase has moved on.
    const cx = v.position[0] - px;
    const cz = v.position[2] - pz;
    if (cx * cx + cz * cz > 240 * 240) this._removeUnit(unit, false);
  }

  /**
   * Drives one pursuing cruiser.
   * @param {object} unit Unit record.
   * @param {number} dt Time since this unit last ticked.
   * @param {object|null} player Player.
   * @param {number} px Player x.
   * @param {number} pz Player z.
   * @param {object} plan Response plan for the current wanted level.
   * @returns {void}
   * @private
   */
  _driveUnit(unit, dt, player, px, pz, plan) {
    const v = unit.vehicle;
    const input = v.input;
    if (!input) return;
    const x = fin(v.position[0], 0);
    const z = fin(v.position[2], 0);
    const speed = forwardSpeedOf(v);
    const maxSpeed = v.type && Number.isFinite(v.type.maxSpeed) ? v.type.maxSpeed : 60;

    // Target: the player when seen, otherwise the last known position.
    let tx = this.lastKnown.valid ? this.lastKnown.x : px;
    let tz = this.lastKnown.valid ? this.lastKnown.z : pz;
    if (this.playerVisible && player) { tx = px; tz = pz; }

    const dx = tx - x;
    const dz = tz - z;
    const dist = Math.hypot(dx, dz);

    // --- progress watchdog ------------------------------------------------------------
    // A cruiser that cannot close on its target is wedged: against geometry, behind a jam it
    // cannot pass, or trapped in a greedy routing loop. It still counts towards `plan.cars`,
    // so leaving it there means the dispatcher never sends a replacement and the response
    // simply never arrives. Recycle it and let the next dispatch drop a fresh unit into the
    // ring around the player.
    const tmx = tx - unit.targetX;
    const tmz = tz - unit.targetZ;
    if (tmx * tmx + tmz * tmz > 400) {
      // The suspect moved on: the cruiser is not failing, the goalposts moved.
      unit.targetX = tx;
      unit.targetZ = tz;
      unit.bestDist = dist;
      unit.noProgress = 0;
    } else if (dist < unit.bestDist - 4) {
      unit.bestDist = dist;
      unit.noProgress = 0;
    } else {
      unit.noProgress += dt;
      if (unit.noProgress > 11 && dist > 45) { this._removeUnit(unit, false); return; }
    }

    let steer;
    let target;
    // One star is an investigation: the unit drives to the scene on the road network rather
    // than locking on to the suspect. From two stars up it is an active pursuit.
    const intercepting = this.wanted >= 2 && this.playerVisible && dist < 55;
    if (intercepting) {
      // --- direct intercept ---------------------------------------------------------
      let ix = tx;
      let iz = tz;
      if (player && player.velocity) {
        const pvx = fin(player.velocity[0], 0);
        const pvz = fin(player.velocity[2], 0);
        const closing = Math.max(6, Math.abs(speed));
        const lead = clamp(dist / closing, 0, 2.2);
        ix += pvx * lead;
        iz += pvz * lead;
      }
      steer = pursuitSteer(v, ix, iz);
      target = maxSpeed * (0.55 + plan.aggression * 0.45);
      // Ramming only makes sense against another vehicle; a suspect on foot is boxed in.
      if (plan.ram && dist < 16 && player && player.vehicle) {
        unit.ramTimer += dt;
        target = maxSpeed * 0.8;
      } else {
        unit.ramTimer = 0;
        if (dist < 9) target = Math.min(target, Math.max(2, dist * 1.2));
      }
      unit.laneId = -1;
    } else {
      // --- lane navigation -----------------------------------------------------------
      const g = this.lanes;
      const hx = -Math.sin(fin(v.yaw, 0));
      const hz = -Math.cos(fin(v.yaw, 0));
      if (unit.laneId < 0 || g.length(unit.laneId) <= 0) {
        const near = this._reacquireLane(x, z, hx, hz, 70);
        unit.laneId = near;
        unit.laneDist = near >= 0 ? g.nearDist : 0;
      }
      if (unit.laneId < 0) {
        steer = pursuitSteer(v, tx, tz);
        target = maxSpeed * 0.4;
      } else {
        unit.laneDist = g.project(unit.laneId, x, z);
        const laneLen = g.length(unit.laneId);
        if (unit.laneDist >= laneLen - 1.2) {
          const nextId = this._bestNext(unit.laneId, tx, tz, unit.prevLane);
          if (nextId >= 0) {
            unit.prevLane = unit.laneId;
            unit.laneId = nextId;
            unit.laneDist = 0;
          } else {
            const near = this._reacquireLane(x, z, hx, hz, 70);
            unit.laneId = near;
            unit.laneDist = near >= 0 ? g.nearDist : 0;
          }
        }
        const look = clamp(6 + Math.abs(speed) * 0.8, 8, 30);
        let ld = unit.laneDist + look;
        let laneId = unit.laneId;
        const len = g.length(laneId);
        if (ld > len) {
          const nx = this._bestNext(laneId, tx, tz, unit.prevLane);
          if (nx >= 0) { ld -= len; laneId = nx; }
        }
        g.sample(laneId, ld, _pt);
        steer = pursuitSteer(v, _pt[0], _pt[1]);
        target = maxSpeed * (0.5 + plan.aggression * 0.4);
        // Slow for tight corners so the cruiser does not spin out.
        const bend = Math.abs(wrapAngle(Math.atan2(-(_pt[0] - x), -(_pt[1] - z)) - fin(v.yaw, 0)));
        if (bend > 0.5) target = Math.min(target, 14);
        else if (bend > 0.25) target = Math.min(target, 24);
      }
    }

    // Pull up short of a suspect on foot: the cruiser becomes cover and the crew gets out.
    // The envelope starts wide and shallow on purpose - braking hard from 20 m/s inside the
    // last thirty metres just overshoots the suspect, and a cruiser that keeps sailing past
    // is never slow enough to let its crew out.
    if (player && !player.vehicle && !player.dead && dist < 45) {
      target = Math.min(target, Math.max(0, (dist - 10) * 0.55));
    }

    // Do not plough through the traffic in front.
    const fx = -Math.sin(fin(v.yaw, 0));
    const fz = -Math.cos(fin(v.yaw, 0));
    const gap = this._leadGap(v, x, z, fx, fz, player);
    if (gap >= 0 && gap < 2) {
      // Blocked. Sirens are supposed to make traffic move; when it does not, lean on the car
      // in front rather than parking behind it for the rest of the chase.
      unit.blocked += dt;
      target = unit.blocked > 2.5 ? Math.min(target, 3.2) : 0;
    } else {
      unit.blocked = 0;
      if (gap >= 0) target = Math.min(target, gap * 1.15);
    }

    input.steer = steer;
    applySpeedControl(v, speed, target);
    input.handbrake = false;
    input.horn = false;

    // Stuck recovery. Progress is measured against a reference point that only moves once
    // the cruiser has actually covered a metre: a per-tick displacement test is reset by the
    // few centimetres of jitter a wedged car makes against whatever it is leaning on, so the
    // recovery never fired and the unit sat there holding a dispatch slot.
    const mdx = x - unit.lastX;
    const mdz = z - unit.lastZ;
    if (mdx * mdx + mdz * mdz > 1 || target <= 0.2) {
      unit.lastX = x;
      unit.lastZ = z;
      unit.stuck = 0;
    } else {
      unit.stuck += dt;
    }
    if (unit.stuck > 2.5) {
      input.throttle = -0.7;
      input.brake = 0;
      input.steer = -steer;
      if (unit.stuck > 6) {
        // Hopelessly wedged and far away: recycle and dispatch a fresh unit instead.
        const ddx = x - px;
        const ddz = z - pz;
        if (ddx * ddx + ddz * ddz > 3600) this._removeUnit(unit, false);
        else { unit.stuck = 0; unit.lastX = x; unit.lastZ = z; }
      }
    }
  }

  /**
   * Re-acquires a lane for a cruiser, preferring one that runs the way it is already facing.
   *
   * A plain nearest-point query is a coin toss between a two-way street's two lanes, and
   * latching onto the oncoming one puts the next waypoint behind the car, which pure pursuit
   * answers with zero steering and full throttle - straight into the kerb.
   * @param {number} x World x.
   * @param {number} z World z.
   * @param {number} fx Forward x (unit).
   * @param {number} fz Forward z (unit).
   * @param {number} r Search radius in metres.
   * @returns {number} Lane id, or -1.
   * @private
   */
  _reacquireLane(x, z, fx, fz, r) {
    const g = this.lanes;
    if (typeof g.nearestDirected === 'function') {
      const directed = g.nearestDirected(x, z, fx, fz, r);
      if (directed >= 0) return directed;
    }
    return g.nearest(x, z, r);
  }

  /**
   * Greedy lane choice: the successor whose far end is closest to the target.
   * @param {number} laneId Current lane.
   * @param {number} tx Target x.
   * @param {number} tz Target z.
   * @returns {number} Lane id, or -1.
   * @private
   */
  _bestNext(laneId, tx, tz, avoid) {
    const lanes = this.city.lanes;
    const lane = lanes[laneId];
    if (!lane || !lane.next || lane.next.length === 0) return -1;
    const g = this.lanes;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < lane.next.length; i++) {
      const id = lane.next[i];
      if (id === avoid && lane.next.length > 1) continue;
      g.sample(id, g.length(id), _pt);
      const dx = _pt[0] - tx;
      const dz = _pt[1] - tz;
      let d = dx * dx + dz * dz;
      // Two-ply. Single-ply "whichever arm ends closest" is a plain hill climb and gets stuck
      // in the local minimum every grid produces: the arm that eventually reaches the suspect
      // often has to start by heading away from him, so a one-lane horizon rejects it and the
      // cruiser circles the same block until the watchdog recycles it.
      const nx = lanes[id];
      if (nx && nx.next && nx.next.length) {
        let sub = Infinity;
        for (let k = 0; k < nx.next.length; k++) {
          const id2 = nx.next[k];
          if (id2 === laneId) continue;
          g.sample(id2, g.length(id2), _pt2);
          const ex = _pt2[0] - tx;
          const ez = _pt2[1] - tz;
          const d2 = ex * ex + ez * ez;
          if (d2 < sub) sub = d2;
        }
        if (sub < d) d = sub;
      }
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }

  /**
   * Distance to the nearest obstacle directly ahead of a cruiser.
   * @param {object} self Cruiser.
   * @param {number} x Its x.
   * @param {number} z Its z.
   * @param {number} fx Forward x.
   * @param {number} fz Forward z.
   * @param {object|null} player Player (ignored while ramming is desired).
   * @returns {number} Bumper gap in metres, or -1 when clear.
   * @private
   */
  _leadGap(self, x, z, fx, fz, player) {
    const list = this.game.vehicles;
    if (!Array.isArray(list)) return -1;
    const playerVehicle = player ? player.vehicle : null;
    const ram = (RESPONSE[this.wanted] || RESPONSE[0]).ram;
    const halfSelf = (self.type && self.type.length ? self.type.length : 4.9) * 0.5;
    let best = -1;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o === self || !o || !o.position) continue;
      if (ram && o === playerVehicle) continue;
      const dx = o.position[0] - x;
      const dz = o.position[2] - z;
      const along = dx * fx + dz * fz;
      if (along <= 0 || along > 34) continue;
      const lat = dx * -fz + dz * fx;
      if (lat > 2.4 || lat < -2.4) continue;
      const halfO = (o.type && o.type.length ? o.type.length : 4.4) * 0.5;
      const gap = along - halfSelf - halfO;
      if (best < 0 || gap < best) best = gap < 0 ? 0 : gap;
    }
    return best;
  }

  /* ---------------------------------------------------------------- cops */

  /**
   * Puts the crew of a cruiser on the pavement.
   * @param {object} unit Unit record.
   * @returns {void}
   * @private
   */
  _deploy(unit) {
    const v = unit.vehicle;
    if (!v) return;
    const plan = RESPONSE[this.wanted] || RESPONSE[0];
    const want = Math.min(2, Math.max(1, plan.cops - this.cops.length));
    for (let i = 0; i < want; i++) {
      if (this.cops.length >= plan.cops) break;
      const cop = this._acquireCop(unit.armored);
      if (!cop) break;
      const yaw = fin(v.yaw, 0);
      const side = i === 0 ? 1 : -1;
      const ox = Math.cos(yaw) * 1.85 * side;
      const oz = -Math.sin(yaw) * 1.85 * side;
      let x = v.position[0] + ox;
      let z = v.position[2] + oz;
      if (typeof v.getDoorPosition === 'function') {
        try {
          v.getDoorPosition(i, _tmp3);
          if (Number.isFinite(_tmp3[0])) { x = _tmp3[0]; z = _tmp3[2]; }
        } catch (err) { /* keep the offset fallback */ }
      }
      const y = this._groundAt(x, z);
      cop.position[0] = x;
      cop.position[1] = y;
      cop.position[2] = z;
      cop.yaw = yaw;
      cop.unit = unit;
      if (cop.character) {
        cop.character.position[0] = x;
        cop.character.position[1] = y;
        cop.character.position[2] = z;
        cop.character.yaw = yaw;
        cop.character.setState('idle');
      }
      unit.cops.push(cop);
      this.cops.push(cop);
    }
    if (unit.cops.length > 0 && this.game.sfx && typeof this.game.sfx.doorOpen === 'function') {
      try { this.game.sfx.doorOpen(v.position); } catch (err) { /* audio off */ }
    }
  }

  /**
   * Forces the crew out of a burning or stolen cruiser.
   * @param {object} unit Unit record.
   * @returns {void}
   * @private
   */
  _bailOut(unit) {
    if (!unit.vehicle || unit.cops.length > 0) return;
    if (this.wanted < 2) return;
    const plan = RESPONSE[this.wanted] || RESPONSE[0];
    if (this.cops.length >= plan.cops + 2) return;
    this._deploy(unit);
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
   * Updates every cop on foot.
   * @param {number} dt Time step.
   * @param {number} px Player x.
   * @param {number} pz Player z.
   * @returns {void}
   * @private
   */
  _updateCops(dt, px, pz) {
    const game = this.game;
    const player = game.player || null;
    for (let i = this.cops.length - 1; i >= 0; i--) {
      const cop = this.cops[i];
      const dx = cop.position[0] - px;
      const dz = cop.position[2] - pz;
      const d2 = dx * dx + dz * dz;
      cop.distToPlayer = Math.sqrt(d2);

      if (cop.dead) {
        cop.bodyTimer -= dt;
        if (cop.bodyTimer <= 0 || d2 > 200 * 200) {
          this.cops.splice(i, 1);
          this._detachCop(cop);
          this._retireCop(cop);
          continue;
        }
        this._animateCop(cop, dt, 0);
        continue;
      }
      if (this.wanted <= 0) {
        // Heat is gone: stand down. Out of sight they leave at once, otherwise they hold for
        // a few seconds and then go. Without the timer a cop kept walking towards the player
        // (`lastKnown` is invalid at zero heat, so the patrol target *is* the player), which
        // kept him inside the 90 m keep-alive radius and shadowing the player for ever.
        cop.standDown += dt;
        if (d2 > 90 * 90 || cop.standDown > 6) {
          this.cops.splice(i, 1);
          this._detachCop(cop);
          this._retireCop(cop);
          continue;
        }
      } else {
        cop.standDown = 0;
      }
      if (d2 > 220 * 220) {
        this.cops.splice(i, 1);
        this._detachCop(cop);
        this._retireCop(cop);
        continue;
      }

      const stride = d2 > 3600 ? 2 : 1;
      cop.accum += dt;
      if (stride > 1 && ((this._frame + cop.phase) & 1) !== 0) continue;
      const cdt = cop.accum;
      cop.accum = 0;
      if (cdt <= 0) continue;
      this._updateCop(cop, cdt, player, px, pz);
    }
  }

  /**
   * @param {object} cop Cop record.
   * @returns {void}
   * @private
   */
  _detachCop(cop) {
    const unit = cop.unit;
    if (unit && Array.isArray(unit.cops)) {
      const k = unit.cops.indexOf(cop);
      if (k >= 0) unit.cops.splice(k, 1);
    }
    cop.unit = null;
  }

  /**
   * One AI tick for a cop on foot: approach, take cover, fire in bursts, reload.
   * @param {object} cop Cop record.
   * @param {number} dt Time step.
   * @param {object|null} player Player.
   * @param {number} px Player x.
   * @param {number} pz Player z.
   * @returns {void}
   * @private
   */
  _updateCop(cop, dt, player, px, pz) {
    cop.stateTime += dt;
    if (cop.fireTimer > 0) cop.fireTimer -= dt;
    if (cop.reloadTimer > 0) cop.reloadTimer -= dt;
    if (cop.coverTimer > 0) cop.coverTimer -= dt;

    const dist = cop.distToPlayer;
    const engaged = this.wanted > 0 && player && !player.dead && dist < COP_SIGHT;
    let moveX = 0;
    let moveZ = 0;
    let desired = 0;

    if (!engaged) {
      cop.state = 'chase';
      // Patrol back towards the last known position. At zero heat there is nothing to patrol
      // towards - `lastKnown` has been invalidated - so stand still rather than treating the
      // player's own position as the search target.
      if (this.wanted > 0) {
        const tx = this.lastKnown.valid ? this.lastKnown.x : px;
        const tz = this.lastKnown.valid ? this.lastKnown.z : pz;
        const dx = tx - cop.position[0];
        const dz = tz - cop.position[2];
        const l = Math.hypot(dx, dz);
        if (l > 3) { moveX = dx / l; moveZ = dz / l; desired = COP_SPEED * 0.55; }
      }
    } else {
      const dx = px - cop.position[0];
      const dz = pz - cop.position[2];
      const l = Math.hypot(dx, dz) || 1;
      cop.yaw = angleDamp(cop.yaw, Math.atan2(-dx, -dz), 10, dt);

      const los = this._lineOfSight(cop.position[0], cop.position[1] + 1.5, cop.position[2],
        px, fin(player.position[1], 0) + 1.1, pz);

      // Arrest: a suspect who has stopped running (and is not putting up a fight at maximum
      // heat) gets closed on and cuffed instead of shot. This is what feeds the busted timer.
      const pSpeed = Math.hypot(fin(player.velocity ? player.velocity[0] : 0, 0),
        fin(player.velocity ? player.velocity[2] : 0, 0));
      const hurt = fin(player.health, 100) < fin(player.maxHealth, 100) * 0.35;
      const arrest = pSpeed < 1.3 && dist < 18 && !player.vehicle && !player.aiming
        && (this.wanted <= 3 || hurt);

      if (arrest) {
        cop.state = 'arrest';
        cop.hasCover = false;
        if (dist > 1.7) {
          moveX = dx / l;
          moveZ = dz / l;
          desired = COP_SPEED * (dist > 6 ? 0.95 : 0.55);
        }
      } else if (cop.reloadTimer > 0) {
        cop.state = 'reload';
        // Back off only when the suspect is right on top of us, and only at a walk: the
        // reload clip is a standing pose, so anything faster skates it across the ground.
        if (dist < 5) { moveX = -dx / l; moveZ = -dz / l; desired = 1.4; }
      } else if (!los || dist > COP_RANGE * 1.6) {
        cop.state = 'chase';
        moveX = dx / l;
        moveZ = dz / l;
        desired = COP_SPEED;
      } else {
        // In range with a clear shot: hold a cover spot and shoot.
        if (!cop.hasCover || cop.coverTimer <= 0) this._findCover(cop, px, pz);
        if (cop.hasCover) {
          const cx = cop.coverX - cop.position[0];
          const cz = cop.coverZ - cop.position[2];
          const cl = Math.hypot(cx, cz);
          if (cl > 0.7) {
            moveX = cx / cl;
            moveZ = cz / cl;
            desired = COP_SPEED * 0.8;
            cop.state = 'cover';
          } else {
            cop.state = 'fire';
          }
        } else if (dist < COP_RANGE * 0.6) {
          moveX = -dx / l;
          moveZ = -dz / l;
          desired = COP_SPEED * 0.5;
          cop.state = 'fire';
        } else {
          cop.state = 'fire';
        }
        this._copFire(cop, player, px, pz, dist, los);
      }
    }

    // --- separation from the other cops --------------------------------------------
    for (let i = 0; i < this.cops.length; i++) {
      const o = this.cops[i];
      if (o === cop || o.dead) continue;
      const sx = cop.position[0] - o.position[0];
      const sz = cop.position[2] - o.position[2];
      const d2 = sx * sx + sz * sz;
      if (d2 > 1.44 || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      moveX += (sx / d) * 0.8;
      moveZ += (sz / d) * 0.8;
      if (desired < 1) desired = 1.2;
    }

    const mag = Math.hypot(moveX, moveZ);
    let wantX = 0;
    let wantZ = 0;
    if (mag > 1e-4 && desired > 0) {
      wantX = (moveX / mag) * desired;
      wantZ = (moveZ / mag) * desired;
    }
    const accel = Math.min(1, 10 * dt);
    cop.velocity[0] += (wantX - cop.velocity[0]) * accel;
    cop.velocity[2] += (wantZ - cop.velocity[2]) * accel;

    const speed = Math.hypot(cop.velocity[0], cop.velocity[2]);
    cop.speed = speed;
    if (speed > 0.4 && cop.state === 'chase') {
      cop.yaw = angleDamp(cop.yaw, Math.atan2(-cop.velocity[0], -cop.velocity[2]), 9, dt);
    }

    this._integrateCop(cop, dt);
    this._animateCop(cop, dt, speed);
  }

  /**
   * Picks a cover spot on the far side of a nearby car.
   * @param {object} cop Cop record.
   * @param {number} px Player x.
   * @param {number} pz Player z.
   * @returns {void}
   * @private
   */
  _findCover(cop, px, pz) {
    cop.hasCover = false;
    cop.coverTimer = 3.5;
    const list = this.game.vehicles;
    if (!Array.isArray(list)) return;
    const playerVehicle = this.game.player ? this.game.player.vehicle : null;
    let best = null;
    let bestD = 18 * 18;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!v || !v.position || v === playerVehicle) continue;
      const dx = v.position[0] - cop.position[0];
      const dz = v.position[2] - cop.position[2];
      const d2 = dx * dx + dz * dz;
      if (d2 > bestD) continue;
      // The car must sit between the cop and the player, not behind him.
      const tx = v.position[0] - px;
      const tz = v.position[2] - pz;
      if (Math.hypot(tx, tz) > cop.distToPlayer + 3) continue;
      bestD = d2;
      best = v;
    }
    if (!best) return;
    const nx = best.position[0] - px;
    const nz = best.position[2] - pz;
    const nl = Math.hypot(nx, nz);
    if (!(nl > 0.2)) return;
    cop.coverX = best.position[0] + (nx / nl) * 2.1;
    cop.coverZ = best.position[2] + (nz / nl) * 2.1;
    cop.hasCover = true;
  }

  /**
   * Fires a burst at the player through the shared weapon system.
   * @param {object} cop Cop record.
   * @param {object} player Player.
   * @param {number} px Player x.
   * @param {number} pz Player z.
   * @param {number} dist Distance to the player.
   * @param {boolean} los Whether the shot is clear.
   * @returns {void}
   * @private
   */
  _copFire(cop, player, px, pz, dist, los) {
    if (!los || cop.fireTimer > 0 || cop.reloadTimer > 0) return;
    const game = this.game;
    const weapons = game.weapons;
    if (!weapons || typeof weapons.tryFire !== 'function') return;
    if (cop.mag <= 0) {
      cop.reloadTimer = cop.weapon === 'rifle' ? 2.6 : 1.9;
      cop.mag = cop.magSize;
      cop.state = 'reload';
      if (game.sfx && typeof game.sfx.reload === 'function') {
        try { game.sfx.reload(cop.weapon, cop.position); } catch (err) { /* audio off */ }
      }
      return;
    }

    const ch = cop.character;
    _origin[0] = cop.position[0];
    _origin[1] = cop.position[1] + 1.45;
    _origin[2] = cop.position[2];
    if (ch && typeof ch.getMuzzleOrigin === 'function') {
      try {
        ch.getMuzzleOrigin(_tmp3);
        if (Number.isFinite(_tmp3[0])) {
          _origin[0] = _tmp3[0];
          _origin[1] = _tmp3[1];
          _origin[2] = _tmp3[2];
        }
      } catch (err) { /* keep the chest-height fallback */ }
    }
    _dir[0] = px - _origin[0];
    _dir[1] = fin(player.position[1], 0) + 1.0 - _origin[1];
    _dir[2] = pz - _origin[2];
    const l = Math.hypot(_dir[0], _dir[1], _dir[2]);
    if (!(l > 0.4)) return;
    _dir[0] /= l; _dir[1] /= l; _dir[2] /= l;

    // Accuracy falls off with range and improves with the wanted level and armour.
    const skill = (0.75 + this.wanted * 0.09) * cop.accuracy;
    const spreadMul = clamp((1.1 + dist * 0.055) / skill, 0.5, 6);
    _fireOpts.weapon = cop.weapon;
    _fireOpts.shooter = cop;
    _fireOpts.damageMul = cop.armored ? 0.62 : 0.48;

    // Tell the ped manager who is shooting so stray rounds do not raise the player's heat.
    const ext = game.ext;
    const prev = ext ? ext.aiShooter : undefined;
    if (ext) ext.aiShooter = cop;
    try {
      weapons.tryFire(_origin, _dir, false, spreadMul, _fireOpts);
    } catch (err) {
      /* a weapon failure must never break the pursuit */
    }
    if (ext) ext.aiShooter = prev;

    cop.mag--;
    cop.burst++;
    if (cop.burst >= (cop.weapon === 'rifle' ? 4 : 3)) {
      cop.burst = 0;
      cop.fireTimer = this.rng.range(0.75, 1.5);
    } else {
      cop.fireTimer = cop.weapon === 'rifle' ? 0.1 : 0.19;
    }
    if (ch && typeof ch.triggerRecoil === 'function') {
      try { ch.triggerRecoil(0.7); } catch (err) { /* optional */ }
    }
  }

  /**
   * Integrates a cop and resolves it against the collision world.
   * @param {object} cop Cop record.
   * @param {number} dt Time step.
   * @returns {void}
   * @private
   */
  _integrateCop(cop, dt) {
    cop.vy -= GRAVITY * dt;
    if (cop.vy < -40) cop.vy = -40;
    _delta[0] = cop.velocity[0] * dt;
    _delta[1] = cop.vy * dt;
    _delta[2] = cop.velocity[2] * dt;

    const coll = this.game.collision;
    let done = false;
    if (coll && typeof coll.moveCapsule === 'function') {
      let res = null;
      try {
        res = coll.moveCapsule(cop.position, COP_RADIUS, COP_HEIGHT, _delta, _move);
      } catch (err) {
        res = null;
      }
      if (res && Number.isFinite(res.x)) {
        cop.position[0] = res.x;
        cop.position[1] = res.y;
        cop.position[2] = res.z;
        cop.grounded = !!res.grounded;
        if (cop.grounded && cop.vy < 0) cop.vy = 0;
        if (res.hits > 0) {
          cop.velocity[0] *= 0.5;
          cop.velocity[2] *= 0.5;
        }
        done = true;
      }
    }
    if (!done) {
      cop.position[0] += _delta[0];
      cop.position[2] += _delta[2];
      const g = this._groundAt(cop.position[0], cop.position[2]);
      cop.position[1] += _delta[1];
      if (cop.position[1] <= g) {
        cop.position[1] = g;
        cop.vy = 0;
        cop.grounded = true;
      } else {
        cop.grounded = false;
      }
    }
    if (!Number.isFinite(cop.position[0]) || !Number.isFinite(cop.position[1])
      || !Number.isFinite(cop.position[2])) {
      const p = this.game.player;
      cop.position[0] = p && p.position ? fin(p.position[0], 0) + 4 : 0;
      cop.position[2] = p && p.position ? fin(p.position[2], 0) + 4 : 0;
      cop.position[1] = this._groundAt(cop.position[0], cop.position[2]);
      cop.velocity[0] = 0;
      cop.velocity[2] = 0;
      cop.vy = 0;
    }
  }

  /**
   * Drives a cop's character rig.
   * @param {object} cop Cop record.
   * @param {number} dt Time step.
   * @param {number} speed Ground speed.
   * @returns {void}
   * @private
   */
  _animateCop(cop, dt, speed) {
    const ch = cop.character;
    if (!ch) return;
    ch.position[0] = cop.position[0];
    ch.position[1] = cop.position[1];
    ch.position[2] = cop.position[2];
    ch.yaw = cop.yaw;
    if (!cop.dead) {
      // `aim`, `crouch` and `reload` are standing poses. Playing one while the body is
      // travelling - closing in to arrest at 4.4 m/s, sliding into cover at 3.7 - is exactly
      // what reads as skating, so each has a gait-locked variant for when the feet move.
      const moving = speed > 0.28;
      let state = 'idle';
      if (cop.state === 'reload') state = moving ? 'walk' : 'reload';
      else if (cop.state === 'cover') {
        state = speed > 2.8 ? 'run' : moving ? 'crouchWalk' : 'crouch';
      } else if (cop.state === 'fire' || cop.state === 'arrest') {
        state = speed > 2.8 ? 'run' : moving ? 'aimWalk' : 'aim';
      } else if (speed > 5.4) state = 'sprint';
      else if (speed > 2.8) state = 'run';
      else if (moving) state = 'walk';
      ch.setState(state);
    }
    _ctx.moveSpeed = speed;
    _ctx.grounded = cop.grounded;
    _ctx.aiming = cop.state === 'fire' || cop.state === 'cover' || cop.state === 'arrest';
    _ctx.aimPitch = 0;
    _ctx.crouching = cop.state === 'cover';
    _ctx.lookYaw = 0;
    _ctx.distance = cop.distToPlayer;
    try { ch.update(dt, _ctx); } catch (err) { /* never let one rig break the squad */ }
  }

  /**
   * Applies damage to a cop. `PedManager.damagePed` forwards here when the hit entity is a cop.
   * @param {object} cop Cop record.
   * @param {number} amount Damage points.
   * @param {ArrayLike<number>} [dir3] Impact direction.
   * @param {boolean} [headshot=false] Whether the head was hit.
   * @param {object} [attacker] Who fired; defaults to the player.
   * @returns {number} Damage applied.
   */
  damageCop(cop, amount, dir3, headshot = false, attacker) {
    if (!cop || cop.dead) return 0;
    let dmg = Math.max(0, fin(amount, 0));
    if (dmg <= 0) return 0;
    if (headshot) dmg = Math.max(dmg, cop.armored ? cop.maxHealth * 0.75 : cop.maxHealth);
    cop.health -= dmg;
    const game = this.game;
    const parts = game.particles;
    if (parts && typeof parts.burst === 'function') {
      parts.burst('blood', cop.position[0], cop.position[1] + 1.2, cop.position[2], 7, { power: 1 });
    }
    if (cop.health <= 0) {
      cop.dead = true;
      cop.health = 0;
      cop.state = 'dead';
      cop.bodyTimer = BODY_TIME;
      cop.velocity[0] = 0;
      cop.velocity[2] = 0;
      if (cop.character) {
        _tmp3[0] = fin(dir3 ? dir3[0] : 0, 0) * 6;
        _tmp3[1] = 1.5;
        _tmp3[2] = fin(dir3 ? dir3[2] : 0, 0) * 6;
        try { cop.character.playRagdoll(_tmp3); } catch (err) { /* static death pose */ }
      }
      if (game.sfx && typeof game.sfx.bodyFall === 'function') {
        try { game.sfx.bodyFall(cop.position); } catch (err) { /* audio off */ }
      }
      const player = game.player || null;
      // `undefined`/`null` still means "unattributed, assume the player" for direct callers,
      // but ped.js now resolves the real shooter first, so an officer shot by another officer
      // during a firefight no longer costs the player three stars and a kill.
      const byPlayer = !!player && (attacker === undefined || attacker === null
        || attacker === player || attacker === player.vehicle);
      if (byPlayer) {
        if (player) player.kills = fin(player.kills, 0) + 1;
        this.reportCrime('copKill', cop.position);
      }
      if (typeof game.emit === 'function') game.emit('pedKilled', cop);
    } else {
      cop.hasCover = false;
      cop.coverTimer = 0;
    }
    return dmg;
  }

  /* ---------------------------------------------------------------- helicopter */

  /**
   * Keeps the police helicopter circling the target and sweeping its spotlight.
   * @param {number} dt Time step.
   * @param {number} px Player x.
   * @param {number} pz Player z.
   * @returns {void}
   * @private
   */
  _updateHelicopter(dt, px, pz) {
    let h = this.helicopter;
    if (!h) {
      h = {
        position: new Float32Array(3),
        target: new Float32Array(3),
        yaw: 0,
        rotor: 0,
        locked: false,
        alive: true,
      };
      const tx = this.lastKnown.valid ? this.lastKnown.x : px;
      const tz = this.lastKnown.valid ? this.lastKnown.z : pz;
      h.position[0] = tx + HELI_ORBIT * 2;
      h.position[1] = HELI_ALT + this._groundAt(tx, tz);
      h.position[2] = tz;
      this.helicopter = h;
      this._notify('경찰 헬기가 접근 중입니다.', 'warn');
    }
    this._heliAngle += dt * 0.32;
    const tx = this.lastKnown.valid ? this.lastKnown.x : px;
    const tz = this.lastKnown.valid ? this.lastKnown.z : pz;
    const gy = this._groundAt(tx, tz);
    const wantX = tx + Math.cos(this._heliAngle) * HELI_ORBIT;
    const wantZ = tz + Math.sin(this._heliAngle) * HELI_ORBIT;
    const wantY = gy + HELI_ALT;
    const k = Math.min(1, dt * 0.55);
    h.position[0] += (wantX - h.position[0]) * k;
    h.position[1] += (wantY - h.position[1]) * k;
    h.position[2] += (wantZ - h.position[2]) * k;
    h.target[0] = tx;
    h.target[1] = gy;
    h.target[2] = tz;
    h.yaw = Math.atan2(-(tx - h.position[0]), -(tz - h.position[2]));
    h.rotor += dt * 26;
    if (h.rotor > 6.283185307179586) h.rotor -= 6.283185307179586;

    // The spotlight only "sees" the player when it is actually pointing at him.
    const dx = px - h.position[0];
    const dz = pz - h.position[2];
    const dh = Math.hypot(dx, dz);
    h.locked = dh < 34 && this._lineOfSight(h.position[0], h.position[1], h.position[2],
      px, gy + 1.2, pz);
  }

  /**
   * Removes the helicopter.
   * @returns {void}
   * @private
   */
  _removeHelicopter() {
    this.helicopter = null;
  }

  /* ---------------------------------------------------------------- busted */

  /**
   * Builds up (and eventually triggers) the busted state.
   * @param {number} dt Time step.
   * @param {object|null} player Player.
   * @param {number} px Player x.
   * @param {number} pz Player z.
   * @returns {void}
   * @private
   */
  _updateBusted(dt, player, px, pz) {
    if (!player || player.dead || player.vehicle || this.wanted <= 0) {
      this._bustTimer = 0;
      return;
    }
    const speed = Math.hypot(fin(player.velocity ? player.velocity[0] : 0, 0),
      fin(player.velocity ? player.velocity[2] : 0, 0));
    let close = 0;
    let arresting = 0;
    let alive = 0;
    for (let i = 0; i < this.cops.length; i++) {
      const cop = this.cops[i];
      if (cop.dead) continue;
      alive++;
      const dx = cop.position[0] - px;
      const dz = cop.position[2] - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 < BUST_RADIUS * BUST_RADIUS) {
        close++;
        if (cop.state === 'arrest' && d2 < 9) arresting++;
      }
    }
    const hurt = fin(player.health, 100) < fin(player.maxHealth, 100) * 0.3;
    const surrounded = close >= 2 || (close >= 1 && hurt)
      || (arresting >= 1 && alive === 1);
    if (surrounded && speed < BUST_SPEED) {
      this._bustTimer += dt;
      if (this._bustTimer >= BUST_TIME) this.bustPlayer();
    } else {
      this._bustTimer = Math.max(0, this._bustTimer - dt * 1.5);
    }
  }

  /**
   * Arrests the player: fine, respawn at the police station, heat cleared.
   * @returns {void}
   */
  bustPlayer() {
    const game = this.game;
    const player = game.player;
    if (!player) return;
    const fine = Math.min(fin(player.money, 0), 200 + this.wanted * 180);
    this.busts++;
    this._bustTimer = 0;
    this.clearWanted();

    if (game.hud && typeof game.hud.showBusted === 'function') {
      try { game.hud.showBusted(); } catch (err) { /* ignore */ }
    }
    if (typeof player.addMoney === 'function') player.addMoney(-fine);
    else player.money = Math.max(0, fin(player.money, 0) - fine);

    const s = this._station;
    const y = this._groundAt(s.x, s.z);
    if (typeof player.reset === 'function') {
      player.reset(s.x, y + 0.1, s.z, s.yaw);
    } else if (player.position) {
      player.position[0] = s.x;
      player.position[1] = y + 0.1;
      player.position[2] = s.z;
    }
    player.health = Math.max(fin(player.health, 0), fin(player.maxHealth, 100) * 0.6);
    if (typeof game.setCameraMode === 'function') game.setCameraMode('thirdPerson');
    this._notify(`체포되었습니다. 벌금 $${fine}`, 'warn');
    if (typeof game.emit === 'function') game.emit('busted', { fine });
  }

  /**
   * HUD toast that can never throw into the AI loop.
   * @param {string} text Korean message.
   * @param {string} kind Toast kind.
   * @returns {void}
   * @private
   */
  _notify(text, kind) {
    const hud = this.game.hud;
    if (!hud || typeof hud.notify !== 'function') return;
    try { hud.notify(text, kind, 3); } catch (err) { /* ignore */ }
  }

  /* ---------------------------------------------------------------- render */

  /**
   * Draws cops, cruiser light bars and the helicopter.
   * @param {object} renderer Renderer.
   * @param {number} [dt] Delta time.
   * @returns {void}
   */
  submit(renderer, dt) {
    if (!renderer) return;
    const camera = this.game.camera;
    const cull = camera && typeof camera.frustumContainsSphere === 'function';

    for (let i = 0; i < this.cops.length; i++) {
      const cop = this.cops[i];
      const ch = cop.character;
      if (!ch) continue;
      if (cop.distToPlayer > 180) { ch.visible = false; continue; }
      if (cull) {
        let inView = true;
        try {
          inView = camera.frustumContainsSphere(cop.position[0], cop.position[1] + 0.9,
            cop.position[2], 1.5);
        } catch (err) { inView = true; }
        ch.visible = inView;
      } else {
        ch.visible = true;
      }
      try { ch.submit(renderer); } catch (err) { /* keep drawing the rest */ }
    }
    const assets = this._assets;
    if (assets && typeof assets.flush === 'function' && !assets.manualFrames) assets.flush();

    // Flashing light bars.
    if (typeof renderer.submitLight === 'function') {
      const t = this._time;
      for (let i = 0; i < this.cars.length; i++) {
        const unit = this.cars[i];
        const v = unit.vehicle;
        if (!v || !v.position || v.isDestroyed) continue;
        const phase = Math.sin(t * 9 + unit.lightPhase);
        const y = v.position[1] + (v.type && v.type.height ? v.type.height * 0.72 : 1.1);
        if (phase > 0) renderer.submitLight(v.position[0], y, v.position[2], 1.0, 0.08, 0.12, 11, 3.2);
        else renderer.submitLight(v.position[0], y, v.position[2], 0.1, 0.25, 1.0, 11, 3.2);
      }
    }

    this._submitHelicopter(renderer, dt);
  }

  /**
   * Builds (once) and draws the helicopter plus its spotlight.
   * @param {object} renderer Renderer.
   * @param {number} dt Delta time.
   * @returns {void}
   * @private
   */
  _submitHelicopter(renderer, dt) {
    const h = this.helicopter;
    if (!h) return;
    if (!this._heliAssets) this._heliAssets = this._buildHeliAssets(renderer);
    const a = this._heliAssets;

    if (a && typeof renderer.submit === 'function') {
      const c = Math.cos(h.yaw);
      const s = Math.sin(h.yaw);
      const m = a.matrix;
      m[0] = c; m[1] = 0; m[2] = -s; m[3] = 0;
      m[4] = 0; m[5] = 1; m[6] = 0; m[7] = 0;
      m[8] = s; m[9] = 0; m[10] = c; m[11] = 0;
      m[12] = h.position[0]; m[13] = h.position[1]; m[14] = h.position[2]; m[15] = 1;
      try { renderer.submit(a.body, a.material, m, null); } catch (err) { /* ignore */ }
      const rc = Math.cos(h.rotor);
      const rs = Math.sin(h.rotor);
      const rm = a.rotorMatrix;
      rm[0] = rc; rm[1] = 0; rm[2] = -rs; rm[3] = 0;
      rm[4] = 0; rm[5] = 1; rm[6] = 0; rm[7] = 0;
      rm[8] = rs; rm[9] = 0; rm[10] = rc; rm[11] = 0;
      rm[12] = h.position[0]; rm[13] = h.position[1] + 1.15; rm[14] = h.position[2]; rm[15] = 1;
      try { renderer.submit(a.rotor, a.rotorMaterial, rm, null); } catch (err) { /* ignore */ }
    }

    // Spotlight aimed at the ground target.
    if (typeof renderer.submitSpotLight === 'function') {
      _dir[0] = h.target[0] - h.position[0];
      _dir[1] = h.target[1] - h.position[1];
      _dir[2] = h.target[2] - h.position[2];
      const l = Math.hypot(_dir[0], _dir[1], _dir[2]) || 1;
      _dir[0] /= l; _dir[1] /= l; _dir[2] /= l;
      _origin[0] = h.position[0];
      _origin[1] = h.position[1] - 0.6;
      _origin[2] = h.position[2];
      _tmp3[0] = 1; _tmp3[1] = 0.97; _tmp3[2] = 0.86;
      try {
        renderer.submitSpotLight(_origin, _dir, _tmp3, l + 26, 0.985, 0.955, 26);
      } catch (err) { /* ignore */ }
    }
    if (typeof renderer.submitLight === 'function') {
      const blink = Math.sin(this._time * 6) > 0 ? 1 : 0.06;
      try {
        renderer.submitLight(h.position[0], h.position[1] - 0.5, h.position[2],
          1 * blink, 0.05 * blink, 0.05 * blink, 9, 2.4);
      } catch (err) { /* ignore */ }
    }
  }

  /**
   * Builds the helicopter meshes on first use.
   * @param {object} renderer Renderer.
   * @returns {object|null} Assets, or null when the renderer cannot build meshes.
   * @private
   */
  _buildHeliAssets(renderer) {
    if (typeof renderer.createMesh !== 'function') return null;
    try {
      const body = mergeGeometries([
        { geometry: sphere(1.35, 12, 8), matrix: null },
        { geometry: box(1.1, 0.9, 5.4, { center: [0, 0.35, 2.4] }) },
        { geometry: box(0.16, 1.5, 0.9, { center: [0, 1.0, 4.7] }) },
        { geometry: cylinder(0.09, 0.09, 1.3, 8, true), matrix: null },
        { geometry: box(2.6, 0.14, 0.16, { center: [0, -1.35, 0.4] }) },
        { geometry: box(0.16, 0.9, 0.16, { center: [0.9, -0.95, 0.4] }) },
        { geometry: box(0.16, 0.9, 0.16, { center: [-0.9, -0.95, 0.4] }) },
      ]);
      const rotor = mergeGeometries([
        { geometry: box(11.5, 0.06, 0.42) },
        { geometry: box(0.42, 0.06, 11.5) },
        { geometry: cylinder(0.14, 0.14, 0.4, 8, true) },
      ]);
      return {
        body: renderer.createMesh(body),
        rotor: renderer.createMesh(rotor),
        material: createMaterial({
          name: 'policeHeli', albedo: [0.06, 0.07, 0.11], roughness: 0.45, metallic: 0.6,
          emissive: [0.02, 0.03, 0.08], emissiveStrength: 1,
        }),
        rotorMaterial: createMaterial({
          name: 'policeHeliRotor', albedo: [0.05, 0.05, 0.06], roughness: 0.6, metallic: 0.3,
          alpha: 0.55, blend: 'alpha', doubleSided: true, castShadow: false,
        }),
        matrix: new Float32Array(16),
        rotorMatrix: new Float32Array(16),
      };
    } catch (err) {
      return null;
    }
  }
}
