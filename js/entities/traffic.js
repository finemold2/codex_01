/**
 * Traffic AI: streamed civilian drivers that follow the city lane graph.
 *
 * Every AI car is an ordinary {@link Vehicle} from `entities/vehicle.js`; the driver only writes
 * `vehicle.input` (throttle / brake / steer / handbrake / horn), exactly like the human player,
 * so AI and player traffic obey the same physics. `game.js` owns the physics tick for everything
 * in `game.vehicles`, which means this module must run *before* it in the frame (it does: the
 * fixed system order is traffic -> peds -> police -> ... -> vehicle integration).
 *
 * The lateral controller is a pure-pursuit tracker on the lane centre line; the longitudinal
 * controller takes the minimum of the lane speed limit, a curvature limit, an IDM-style
 * car-following limit, a traffic-light limit and a hazard (pedestrian / player / wreck) limit.
 *
 * This file also owns {@link PathGraph}, the arc-length + spatial index shared with
 * `entities/ped.js` (sidewalk graph) and `entities/police.js` (pursuit routing). Keeping one
 * implementation avoids three subtly different polyline samplers.
 *
 * @module entities/traffic
 */

import { clamp, wrapAngle, Rand } from '../core/math.js';

/* ------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------ */

/** Hard cap on simultaneously simulated AI cars. */
const MAX_VEHICLES = 28;
/** Never spawn a car closer than this to the player (metres). */
const SPAWN_MIN = 80;
/** Never spawn a car further than this from the player (metres). */
const SPAWN_MAX = 165;
/** Recycle a car once it drifts beyond this distance (metres). */
const DESPAWN_DIST = 200;
/** Spawn attempts allowed per frame (keeps streaming hitch-free). */
const SPAWN_BUDGET = 1;
/** Candidate lane samples examined per spawn attempt. */
const SPAWN_TRIES = 10;
/** Minimum clearance to any other vehicle at spawn time (metres). */
const SPAWN_CLEAR = 11;
/** Route ring buffer length (current lane + look-ahead lanes). */
const ROUTE_LEN = 5;
/** Comfortable lateral acceleration used for the curvature speed limit (m/s^2). */
const LAT_ACCEL = 4.6;
/** Standstill gap kept behind the car in front (metres). */
const MIN_GAP = 2.6;
/** Time headway used by the car-following law (seconds). */
const HEADWAY = 0.95;
/** Corridor half width used when looking for the car in front (metres). */
const FOLLOW_HALF_WIDTH = 2.3;
/** Distance ahead scanned for a leading vehicle (metres). */
const FOLLOW_RANGE = 42;
/** Distance ahead scanned for pedestrians / the player on foot (metres). */
const HAZARD_RANGE = 16;
/** Seconds of being unable to move before the driver leans on the horn. */
const BLOCKED_HORN = 1.6;
/** Seconds between two horn blasts from the same driver. */
const HORN_COOLDOWN = 3.4;
/** Seconds a panicking driver keeps panicking. */
const PANIC_TIME = 9;
/** AI tick period at LOD 1 (45 m .. 110 m) in seconds. */
const LOD1_STEP = 1 / 20;
/** AI tick period at LOD 2 (beyond 110 m) in seconds. */
const LOD2_STEP = 1 / 8;
/** Wrecks are cleaned up beyond this distance (metres). */
const WRECK_DIST = 220;
/** Pooled vehicles kept per type. */
const POOL_PER_TYPE = 5;

/** Civilian vehicle mix. Weights are relative. */
const TRAFFIC_MIX = [
  ['sedan', 30], ['taxi', 14], ['suv', 14], ['van', 9], ['muscle', 7],
  ['sports', 6], ['truck', 5], ['bus', 3], ['sportsbike', 4],
];

/** Total of {@link TRAFFIC_MIX} weights. */
const TRAFFIC_MIX_TOTAL = (() => {
  let t = 0;
  for (let i = 0; i < TRAFFIC_MIX.length; i++) t += TRAFFIC_MIX[i][1];
  return t;
})();

/** Relative likelihood of each turn class at a junction. */
const TURN_WEIGHT = { straight: 1, right: 0.45, left: 0.34, uturn: 0.03 };

/* ------------------------------------------------------------------ *
 * Module scratch (no allocation in the hot path)
 * ------------------------------------------------------------------ */

const _pt = new Float32Array(2);
const _tan = new Float32Array(2);
const _pt2 = new Float32Array(2);
const _cand = new Int32Array(512);

/**
 * Reads a number defensively.
 * @param {*} v Value.
 * @param {number} d Fallback.
 * @returns {number} `v` when finite, otherwise `d`.
 */
function fin(v, d) {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/* ------------------------------------------------------------------ *
 * PathGraph
 * ------------------------------------------------------------------ */

/**
 * Flattened arc-length index over a polyline graph (`city.lanes` or `city.walks`).
 *
 * Vertices, cumulative lengths and evenly spaced query samples all live in typed arrays, and the
 * samples are bucketed into a uniform grid, so ring queries (streaming) and nearest-point queries
 * (snapping an entity back onto the network) never allocate.
 */
export class PathGraph {
  /**
   * @param {object[]} polys Records shaped `{pts:[[x,z],...], next:number[]}`.
   * @param {object} [opts] Options.
   * @param {number} [opts.step=5] Spacing between query samples, metres.
   * @param {number} [opts.cell=32] Spatial grid cell size, metres.
   */
  constructor(polys, opts) {
    const o = opts || {};
    const step = fin(o.step, 5) > 0.5 ? fin(o.step, 5) : 5;
    const cell = fin(o.cell, 32) > 1 ? fin(o.cell, 32) : 32;
    const list = Array.isArray(polys) ? polys : [];
    const n = list.length;

    /** @type {object[]} The source records (lanes / walks). */
    this.polys = list;
    /** @type {number} Number of polylines. */
    this.count = n;
    /** @type {number} Sample spacing in metres. */
    this.step = step;

    // ---- vertices -----------------------------------------------------------------
    this.vOff = new Int32Array(n + 1);
    let tv = 0;
    for (let i = 0; i < n; i++) {
      const pts = list[i] && list[i].pts;
      this.vOff[i] = tv;
      tv += pts ? pts.length : 0;
    }
    this.vOff[n] = tv;
    this.vx = new Float32Array(tv);
    this.vz = new Float32Array(tv);
    this.vc = new Float32Array(tv);
    this.len = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const pts = list[i] && list[i].pts;
      if (!pts || pts.length === 0) continue;
      const base = this.vOff[i];
      this.vx[base] = fin(pts[0][0], 0);
      this.vz[base] = fin(pts[0][1], 0);
      this.vc[base] = 0;
      let acc = 0;
      for (let k = 1; k < pts.length; k++) {
        const x = fin(pts[k][0], 0);
        const z = fin(pts[k][1], 0);
        const dx = x - this.vx[base + k - 1];
        const dz = z - this.vz[base + k - 1];
        acc += Math.sqrt(dx * dx + dz * dz);
        this.vx[base + k] = x;
        this.vz[base + k] = z;
        this.vc[base + k] = acc;
      }
      this.len[i] = acc;
    }

    // ---- query samples ------------------------------------------------------------
    let sc = 0;
    for (let i = 0; i < n; i++) {
      if (this.vOff[i + 1] - this.vOff[i] === 0) continue;
      sc += 1 + Math.floor(this.len[i] / step);
    }
    this.sampleCount = sc;
    this.sx = new Float32Array(sc);
    this.sz = new Float32Array(sc);
    this.sPoly = new Int32Array(sc);
    this.sDist = new Float32Array(sc);

    let w = 0;
    let minx = Infinity;
    let minz = Infinity;
    let maxx = -Infinity;
    let maxz = -Infinity;
    for (let i = 0; i < n; i++) {
      if (this.vOff[i + 1] - this.vOff[i] === 0) continue;
      const cnt = 1 + Math.floor(this.len[i] / step);
      for (let k = 0; k < cnt; k++) {
        const d = cnt === 1 ? this.len[i] * 0.5 : (k / (cnt - 1)) * this.len[i];
        this.sample(i, d, _pt);
        this.sx[w] = _pt[0];
        this.sz[w] = _pt[1];
        this.sPoly[w] = i;
        this.sDist[w] = d;
        if (_pt[0] < minx) minx = _pt[0];
        if (_pt[0] > maxx) maxx = _pt[0];
        if (_pt[1] < minz) minz = _pt[1];
        if (_pt[1] > maxz) maxz = _pt[1];
        w++;
      }
    }
    if (!(minx < maxx)) { minx = -1; maxx = 1; }
    if (!(minz < maxz)) { minz = -1; maxz = 1; }

    // ---- uniform grid over the samples --------------------------------------------
    this.cell = cell;
    this.gx0 = minx - cell;
    this.gz0 = minz - cell;
    this.gw = Math.max(1, Math.min(1024, Math.ceil((maxx - minx + cell * 2) / cell)));
    this.gh = Math.max(1, Math.min(1024, Math.ceil((maxz - minz + cell * 2) / cell)));
    const cells = this.gw * this.gh;
    this.cellStart = new Int32Array(cells + 1);
    this.cellItem = new Int32Array(sc);
    const counts = new Int32Array(cells);
    for (let s = 0; s < sc; s++) counts[this._cellOf(this.sx[s], this.sz[s])]++;
    let run = 0;
    for (let c = 0; c < cells; c++) {
      this.cellStart[c] = run;
      run += counts[c];
      counts[c] = this.cellStart[c];
    }
    this.cellStart[cells] = run;
    for (let s = 0; s < sc; s++) {
      const c = this._cellOf(this.sx[s], this.sz[s]);
      this.cellItem[counts[c]++] = s;
    }

    /** @type {number} Squared distance from the last {@link PathGraph#project} call. */
    this.projDist2 = 0;
    /** @type {number} X of the last projected point. */
    this.projX = 0;
    /** @type {number} Z of the last projected point. */
    this.projZ = 0;
    /** @type {number} Polyline id from the last {@link PathGraph#nearest} call, -1 when none. */
    this.nearPoly = -1;
    /** @type {number} Arc distance from the last {@link PathGraph#nearest} call. */
    this.nearDist = 0;
    /** @type {number} Squared distance from the last {@link PathGraph#nearest} call. */
    this.nearDist2 = Infinity;
  }

  /**
   * @param {number} x World x.
   * @param {number} z World z.
   * @returns {number} Flat grid cell index (clamped to the grid).
   * @private
   */
  _cellOf(x, z) {
    let i = Math.floor((x - this.gx0) / this.cell);
    let j = Math.floor((z - this.gz0) / this.cell);
    if (i < 0) i = 0; else if (i >= this.gw) i = this.gw - 1;
    if (j < 0) j = 0; else if (j >= this.gh) j = this.gh - 1;
    return i * this.gh + j;
  }

  /**
   * Total length of one polyline.
   * @param {number} id Polyline id.
   * @returns {number} Length in metres (0 for an unknown id).
   */
  length(id) {
    return id >= 0 && id < this.count ? this.len[id] : 0;
  }

  /**
   * Point at an arc distance along a polyline.
   * @param {number} id Polyline id.
   * @param {number} dist Arc distance in metres (clamped to the polyline).
   * @param {Float32Array|number[]} out Destination `[x, z]`.
   * @returns {Float32Array|number[]} `out`
   */
  sample(id, dist, out) {
    if (id < 0 || id >= this.count) { out[0] = 0; out[1] = 0; return out; }
    const base = this.vOff[id];
    const end = this.vOff[id + 1];
    const m = end - base;
    if (m <= 0) { out[0] = 0; out[1] = 0; return out; }
    if (m === 1 || !(dist > 0)) { out[0] = this.vx[base]; out[1] = this.vz[base]; return out; }
    const total = this.len[id];
    if (dist >= total) { out[0] = this.vx[end - 1]; out[1] = this.vz[end - 1]; return out; }
    let k = base + 1;
    while (k < end - 1 && this.vc[k] < dist) k++;
    const c0 = this.vc[k - 1];
    const c1 = this.vc[k];
    const t = c1 > c0 ? (dist - c0) / (c1 - c0) : 0;
    out[0] = this.vx[k - 1] + (this.vx[k] - this.vx[k - 1]) * t;
    out[1] = this.vz[k - 1] + (this.vz[k] - this.vz[k - 1]) * t;
    return out;
  }

  /**
   * Unit tangent at an arc distance along a polyline.
   * @param {number} id Polyline id.
   * @param {number} dist Arc distance in metres.
   * @param {Float32Array|number[]} out Destination `[dx, dz]`.
   * @returns {Float32Array|number[]} `out`
   */
  tangent(id, dist, out) {
    out[0] = 0;
    out[1] = 1;
    if (id < 0 || id >= this.count) return out;
    const base = this.vOff[id];
    const end = this.vOff[id + 1];
    if (end - base < 2) return out;
    let k = base + 1;
    while (k < end - 1 && this.vc[k] < dist) k++;
    const dx = this.vx[k] - this.vx[k - 1];
    const dz = this.vz[k] - this.vz[k - 1];
    const l = Math.sqrt(dx * dx + dz * dz);
    if (l > 1e-6) { out[0] = dx / l; out[1] = dz / l; }
    return out;
  }

  /**
   * Projects a world point onto one polyline.
   * @param {number} id Polyline id.
   * @param {number} x World x.
   * @param {number} z World z.
   * @returns {number} Arc distance of the closest point; `projDist2`, `projX` and `projZ`
   *   carry the squared distance and the point itself.
   */
  project(id, x, z) {
    this.projDist2 = Infinity;
    this.projX = x;
    this.projZ = z;
    if (id < 0 || id >= this.count) return 0;
    const base = this.vOff[id];
    const end = this.vOff[id + 1];
    if (end - base < 2) {
      if (end - base === 1) {
        const dx = x - this.vx[base];
        const dz = z - this.vz[base];
        this.projDist2 = dx * dx + dz * dz;
        this.projX = this.vx[base];
        this.projZ = this.vz[base];
      }
      return 0;
    }
    let bestD = 0;
    let bestD2 = Infinity;
    let bx = x;
    let bz = z;
    for (let k = base; k < end - 1; k++) {
      const ax = this.vx[k];
      const az = this.vz[k];
      const ex = this.vx[k + 1] - ax;
      const ez = this.vz[k + 1] - az;
      const l2 = ex * ex + ez * ez;
      let t = l2 > 1e-9 ? ((x - ax) * ex + (z - az) * ez) / l2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const px = ax + ex * t;
      const pz = az + ez * t;
      const dx = x - px;
      const dz = z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestD = this.vc[k] + Math.sqrt(l2) * t;
        bx = px;
        bz = pz;
      }
    }
    this.projDist2 = bestD2;
    this.projX = bx;
    this.projZ = bz;
    return bestD;
  }

  /**
   * Nearest point on the whole network.
   * @param {number} x World x.
   * @param {number} z World z.
   * @param {number} [maxR=40] Search radius in metres.
   * @returns {number} Polyline id, or -1 when nothing is in range. Results also land in
   *   `nearPoly`, `nearDist` (arc distance) and `nearDist2` (squared distance).
   */
  nearest(x, z, maxR = 40) {
    this.nearPoly = -1;
    this.nearDist = 0;
    this.nearDist2 = Infinity;
    if (this.sampleCount === 0) return -1;
    const cell = this.cell;
    const r = maxR > 0 ? maxR : 40;
    let i0 = Math.floor((x - r - this.gx0) / cell);
    let i1 = Math.floor((x + r - this.gx0) / cell);
    let j0 = Math.floor((z - r - this.gz0) / cell);
    let j1 = Math.floor((z + r - this.gz0) / cell);
    if (i0 < 0) i0 = 0;
    if (j0 < 0) j0 = 0;
    if (i1 >= this.gw) i1 = this.gw - 1;
    if (j1 >= this.gh) j1 = this.gh - 1;
    let bestSample = -1;
    let bestD2 = r * r;
    for (let ci = i0; ci <= i1; ci++) {
      const colBase = ci * this.gh;
      for (let cj = j0; cj <= j1; cj++) {
        const c = colBase + cj;
        const s1 = this.cellStart[c + 1];
        for (let k = this.cellStart[c]; k < s1; k++) {
          const s = this.cellItem[k];
          const dx = this.sx[s] - x;
          const dz = this.sz[s] - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD2) { bestD2 = d2; bestSample = s; }
        }
      }
    }
    if (bestSample < 0) return -1;
    const poly = this.sPoly[bestSample];
    const d = this.project(poly, x, z);
    this.nearPoly = poly;
    this.nearDist = d;
    this.nearDist2 = this.projDist2;
    return poly;
  }

  /**
   * Collects query samples whose distance from a point falls inside an annulus.
   * @param {number} x World x.
   * @param {number} z World z.
   * @param {number} rMin Inner radius, metres.
   * @param {number} rMax Outer radius, metres.
   * @param {Int32Array} out Destination buffer (sample indices).
   * @returns {number} Number of indices written (never more than `out.length`).
   */
  queryRing(x, z, rMin, rMax, out) {
    if (this.sampleCount === 0) return 0;
    const cell = this.cell;
    let i0 = Math.floor((x - rMax - this.gx0) / cell);
    let i1 = Math.floor((x + rMax - this.gx0) / cell);
    let j0 = Math.floor((z - rMax - this.gz0) / cell);
    let j1 = Math.floor((z + rMax - this.gz0) / cell);
    if (i0 < 0) i0 = 0;
    if (j0 < 0) j0 = 0;
    if (i1 >= this.gw) i1 = this.gw - 1;
    if (j1 >= this.gh) j1 = this.gh - 1;
    const lo = rMin * rMin;
    const hi = rMax * rMax;
    const cap = out.length;
    let count = 0;
    for (let ci = i0; ci <= i1; ci++) {
      const colBase = ci * this.gh;
      for (let cj = j0; cj <= j1; cj++) {
        const c = colBase + cj;
        const s1 = this.cellStart[c + 1];
        for (let k = this.cellStart[c]; k < s1; k++) {
          const s = this.cellItem[k];
          const dx = this.sx[s] - x;
          const dz = this.sz[s] - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < lo || d2 > hi) continue;
          out[count++] = s;
          if (count >= cap) return count;
        }
      }
    }
    return count;
  }
}

/* ------------------------------------------------------------------ *
 * Small shared helpers (used by police.js as well)
 * ------------------------------------------------------------------ */

/**
 * Signed forward speed of a vehicle along its own nose.
 * @param {object} v Vehicle.
 * @returns {number} Metres per second, negative when reversing.
 */
export function forwardSpeedOf(v) {
  const fs = v.forwardSpeed;
  if (typeof fs === 'number' && Number.isFinite(fs)) return fs;
  const yaw = fin(v.yaw, 0);
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  return fin(v.velocity ? v.velocity[0] : 0, 0) * fx + fin(v.velocity ? v.velocity[2] : 0, 0) * fz;
}

/**
 * Pure-pursuit steering command for a vehicle chasing a world point.
 * @param {object} v Vehicle (uses `position`, `yaw`, `type.wheelBase`, `type.steerMax`).
 * @param {number} tx Target x.
 * @param {number} tz Target z.
 * @returns {number} Steering input in -1..1.
 */
export function pursuitSteer(v, tx, tz) {
  const yaw = fin(v.yaw, 0);
  const dx = tx - fin(v.position[0], 0);
  const dz = tz - fin(v.position[2], 0);
  const ld = Math.sqrt(dx * dx + dz * dz);
  if (!(ld > 0.05)) return 0;
  const want = Math.atan2(-dx, -dz);
  const alpha = wrapAngle(want - yaw);
  const type = v.type || null;
  const wb = type && Number.isFinite(type.wheelBase) ? type.wheelBase : 2.7;
  const smax = type && Number.isFinite(type.steerMax) && type.steerMax > 0.05 ? type.steerMax : 0.6;
  const delta = Math.atan2(2 * wb * Math.sin(alpha), Math.max(2.5, ld));
  return clamp(delta / smax, -1, 1);
}

/**
 * Writes throttle / brake for a target speed.
 * @param {object} v Vehicle whose `input` is written.
 * @param {number} speed Current forward speed, m/s.
 * @param {number} target Desired forward speed, m/s.
 * @returns {void}
 */
export function applySpeedControl(v, speed, target) {
  const input = v.input;
  if (!input) return;
  const err = target - speed;
  if (target <= 0.15) {
    input.throttle = speed > 0.4 ? 0 : 0;
    input.brake = 1;
    return;
  }
  if (err > 0) {
    input.throttle = clamp(err * 0.55, 0, 1);
    input.brake = 0;
  } else {
    input.throttle = 0;
    input.brake = clamp(-err * 0.42, 0, 1);
  }
}

/**
 * Distance to a point measured along a vehicle's nose, or -1 when it is behind / off to the side.
 * @param {number} ox Origin x.
 * @param {number} oz Origin z.
 * @param {number} fx Forward x (unit).
 * @param {number} fz Forward z (unit).
 * @param {number} tx Target x.
 * @param {number} tz Target z.
 * @param {number} halfWidth Corridor half width, metres.
 * @returns {number} Distance ahead, or -1.
 */
export function corridorDistance(ox, oz, fx, fz, tx, tz, halfWidth) {
  const dx = tx - ox;
  const dz = tz - oz;
  const along = dx * fx + dz * fz;
  if (along <= 0) return -1;
  const lat = dx * -fz + dz * fx;
  if (lat > halfWidth || lat < -halfWidth) return -1;
  return along;
}

/**
 * Resets a pooled vehicle so it can be handed out again.
 * @param {object} v Vehicle.
 * @param {number} x World x.
 * @param {number} y World y.
 * @param {number} z World z.
 * @param {number} yaw Facing.
 * @returns {void}
 */
export function resetVehicle(v, x, y, z, yaw) {
  v.position[0] = x;
  v.position[1] = y;
  v.position[2] = z;
  if (v.velocity) { v.velocity[0] = 0; v.velocity[1] = 0; v.velocity[2] = 0; }
  v.yaw = yaw;
  if (typeof v.pitch === 'number') v.pitch = 0;
  if (typeof v.roll === 'number') v.roll = 0;
  if (typeof v.yawRate === 'number') v.yawRate = 0;
  if (typeof v.angularVelocity === 'number') v.angularVelocity = 0;
  v.speed = 0;
  v.forwardSpeed = 0;
  v.steer = 0;
  v.gear = 1;
  v.health = Number.isFinite(v.maxHealth) ? v.maxHealth : 1000;
  v.isDestroyed = false;
  v.driver = null;
  v.isPlayer = false;
  v.parked = false;
  v.visible = true;
  v.lodSkip = 0;
  if (v.input) {
    v.input.throttle = 0;
    v.input.brake = 0;
    v.input.steer = 0;
    v.input.handbrake = false;
    v.input.horn = false;
  }
  if (typeof v.setLights === 'function') {
    try { v.setLights(false, false, false, false); } catch (err) { /* optional */ }
  }
}

/* ------------------------------------------------------------------ *
 * Driver record pool
 * ------------------------------------------------------------------ */

/**
 * Creates a blank AI driver record.
 * @returns {object} Driver record.
 */
function makeDriver() {
  return {
    vehicle: null,
    laneId: -1,
    laneDist: 0,
    route: new Int32Array(ROUTE_LEN),
    routeLen: 0,
    cruise: 1,
    aggression: 0.5,
    reaction: 0,
    accum: 0,
    blocked: 0,
    hornTimer: 0,
    panic: 0,
    crash: 0,
    swerve: 0,
    stuck: 0,
    lastX: 0,
    lastZ: 0,
    seed: 0,
    female: false,
    lost: 0,
    state: 'drive',
    typeKey: 'sedan',
  };
}

/* ------------------------------------------------------------------ *
 * TrafficManager
 * ------------------------------------------------------------------ */

/**
 * Streams and drives the civilian traffic around the player.
 */
export class TrafficManager {
  /**
   * @param {object} game The {@link Game} instance (see docs/ARCHITECTURE.md section 16).
   */
  constructor(game) {
    /** @type {object} */
    this.game = game;
    /** @type {object} */
    this.city = (game && game.city) || { lanes: [], walks: [], nodes: [] };
    /** @type {Rand} Seeded generator; never `Math.random`. */
    this.rng = game && game.rng && typeof game.rng.fork === 'function'
      ? game.rng.fork('traffic') : new Rand(0x7A11C);
    /** @type {PathGraph} Lane graph index. */
    this.lanes = new PathGraph(this.city.lanes || [], { step: 6, cell: 32 });
    /** @type {object[]} Vehicles currently driven by this manager. */
    this.vehicles = [];
    /** @type {object[]} Destroyed cars this manager spawned, kept until they stream out. */
    this.wrecks = [];
    /** @type {object[]} Cars this manager spawned that lost their driver (jacked / abandoned). */
    this.orphans = [];
    /** @type {number} Hard cap on live AI cars. */
    this.maxVehicles = MAX_VEHICLES;
    /** @type {boolean} Set false to freeze streaming (used by missions / cut-scenes). */
    this.streaming = true;

    this._pool = new Map();
    this._drivers = [];
    this._time = 0;
    this._spawnCursor = 0;
    this._edgeLanes = null;
    this._buildSpawnTable();
  }

  /**
   * Collects the lane ids long enough to spawn on (turn arcs are excluded).
   * @returns {void}
   * @private
   */
  _buildSpawnTable() {
    const lanes = this.city.lanes || [];
    let n = 0;
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i].edgeId !== undefined && lanes[i].edgeId < 0) continue;
      if (this.lanes.length(i) < 18) continue;
      n++;
    }
    this._edgeLanes = new Int32Array(n);
    let w = 0;
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i].edgeId !== undefined && lanes[i].edgeId < 0) continue;
      if (this.lanes.length(i) < 18) continue;
      this._edgeLanes[w++] = i;
    }
  }

  /* ---------------------------------------------------------------- pooling */

  /**
   * Picks a civilian vehicle type from the seeded mix.
   * @returns {string} A key of `VEHICLE_TYPES`.
   * @private
   */
  _pickType() {
    let r = this.rng.next() * TRAFFIC_MIX_TOTAL;
    for (let i = 0; i < TRAFFIC_MIX.length; i++) {
      r -= TRAFFIC_MIX[i][1];
      if (r <= 0) return TRAFFIC_MIX[i][0];
    }
    return 'sedan';
  }

  /**
   * Takes a vehicle out of the pool, or asks the game to build a new one.
   * @param {string} typeKey Vehicle type key.
   * @param {number} x World x.
   * @param {number} z World z.
   * @param {number} yaw Facing.
   * @returns {object|null} Vehicle, or null when the game refused.
   * @private
   */
  _acquireVehicle(typeKey, x, z, yaw) {
    const game = this.game;
    const pool = this._pool.get(typeKey);
    if (pool && pool.length > 0) {
      const v = pool.pop();
      const y = typeof game.worldToGround === 'function' ? fin(game.worldToGround(x, z), 0) : 0;
      resetVehicle(v, x, y + 0.45, z, yaw);
      if (Array.isArray(game.vehicles) && game.vehicles.indexOf(v) < 0) game.vehicles.push(v);
      return v;
    }
    if (typeof game.spawnVehicle !== 'function') return null;
    let v = null;
    try {
      v = game.spawnVehicle(typeKey, x, z, yaw, {});
    } catch (err) {
      v = null;
    }
    return v || null;
  }

  /**
   * Removes a vehicle from the world and keeps the instance for reuse.
   * @param {object} v Vehicle.
   * @param {boolean} [destroy=false] Force a real removal instead of pooling.
   * @returns {void}
   * @private
   */
  _releaseVehicle(v, destroy = false) {
    const game = this.game;
    if (!v) return;
    if (Array.isArray(game.vehicles)) {
      const i = game.vehicles.indexOf(v);
      if (i >= 0) game.vehicles.splice(i, 1);
    }
    v.ai = null;
    v.isTraffic = false;
    const key = (v.type && v.type.key) || 'sedan';
    if (destroy || v.isDestroyed) {
      if (typeof game.removeVehicle === 'function') {
        try { game.removeVehicle(v); } catch (err) { /* already gone */ }
      } else if (typeof v.dispose === 'function') {
        try { v.dispose(); } catch (err) { /* optional */ }
      }
      return;
    }
    v.visible = false;
    v.engineOn = false;
    if (v.input) {
      v.input.throttle = 0;
      v.input.brake = 1;
      v.input.steer = 0;
      v.input.handbrake = true;
      v.input.horn = false;
    }
    if (typeof v.setLights === 'function') {
      try { v.setLights(false, false, false, false); } catch (err) { /* optional */ }
    }
    let pool = this._pool.get(key);
    if (!pool) { pool = []; this._pool.set(key, pool); }
    if (pool.length < POOL_PER_TYPE) pool.push(v);
    else if (typeof game.removeVehicle === 'function') {
      try { game.removeVehicle(v); } catch (err) { /* already gone */ }
    }
  }

  /**
   * @returns {object} A recycled or fresh driver record.
   * @private
   */
  _acquireDriver() {
    return this._drivers.length > 0 ? this._drivers.pop() : makeDriver();
  }

  /**
   * @param {object} ai Driver record.
   * @returns {void}
   * @private
   */
  _releaseDriver(ai) {
    ai.vehicle = null;
    ai.laneId = -1;
    ai.routeLen = 0;
    ai.panic = 0;
    ai.crash = 0;
    ai.blocked = 0;
    ai.stuck = 0;
    ai.state = 'drive';
    if (this._drivers.length < 48) this._drivers.push(ai);
  }

  /* ---------------------------------------------------------------- routing */

  /**
   * Chooses the next lane after `laneId`, weighted towards going straight on.
   * @param {number} laneId Current lane.
   * @param {number} avoid Lane id to avoid picking (the previous one).
   * @returns {number} Lane id, or -1 when the lane is a dead end.
   * @private
   */
  _pickNext(laneId, avoid) {
    const lanes = this.city.lanes;
    const lane = lanes[laneId];
    if (!lane || !lane.next || lane.next.length === 0) return -1;
    const list = lane.next;
    if (list.length === 1) return list[0];
    let total = 0;
    for (let i = 0; i < list.length; i++) {
      const nx = lanes[list[i]];
      if (!nx) continue;
      if (list[i] === avoid && list.length > 1) continue;
      total += TURN_WEIGHT[nx.turn] !== undefined ? TURN_WEIGHT[nx.turn] : TURN_WEIGHT.straight;
    }
    if (total <= 0) return list[this.rng.int(0, list.length - 1)];
    let r = this.rng.next() * total;
    for (let i = 0; i < list.length; i++) {
      const nx = lanes[list[i]];
      if (!nx) continue;
      if (list[i] === avoid && list.length > 1) continue;
      r -= TURN_WEIGHT[nx.turn] !== undefined ? TURN_WEIGHT[nx.turn] : TURN_WEIGHT.straight;
      if (r <= 0) return list[i];
    }
    return list[list.length - 1];
  }

  /**
   * Fills the driver's look-ahead route buffer.
   * @param {object} ai Driver record.
   * @returns {void}
   * @private
   */
  _extendRoute(ai) {
    while (ai.routeLen < ROUTE_LEN) {
      const from = ai.routeLen === 0 ? ai.laneId : ai.route[ai.routeLen - 1];
      const avoid = ai.routeLen >= 2 ? ai.route[ai.routeLen - 2] : ai.laneId;
      const next = this._pickNext(from, avoid);
      if (next < 0) break;
      ai.route[ai.routeLen++] = next;
    }
  }

  /**
   * Advances the driver onto the next lane of its route.
   * @param {object} ai Driver record.
   * @returns {boolean} False when the route ran dry (the driver should be recycled).
   * @private
   */
  _advanceLane(ai) {
    if (ai.routeLen === 0) this._extendRoute(ai);
    if (ai.routeLen === 0) return false;
    ai.laneId = ai.route[0];
    for (let i = 1; i < ai.routeLen; i++) ai.route[i - 1] = ai.route[i];
    ai.routeLen--;
    ai.laneDist = 0;
    this._extendRoute(ai);
    return true;
  }

  /**
   * Point on the route at `dist` metres past the driver's current lane position.
   * @param {object} ai Driver record.
   * @param {number} dist Look-ahead distance, metres.
   * @param {Float32Array|number[]} out Destination `[x, z]`.
   * @returns {Float32Array|number[]} `out`
   * @private
   */
  _routePoint(ai, dist, out) {
    let lane = ai.laneId;
    let d = ai.laneDist + dist;
    let hop = 0;
    let len = this.lanes.length(lane);
    while (d > len && hop < ai.routeLen) {
      d -= len;
      lane = ai.route[hop++];
      len = this.lanes.length(lane);
    }
    this.lanes.sample(lane, d, out);
    return out;
  }

  /* ---------------------------------------------------------------- spawning */

  /**
   * Spawns up to `count` AI cars on lanes around a point.
   * @param {ArrayLike<number>} pos3 Centre (usually the player).
   * @param {number} count How many to try to spawn.
   * @returns {number} How many were actually created.
   */
  spawnAround(pos3, count) {
    let made = 0;
    for (let i = 0; i < count; i++) {
      if (this.vehicles.length >= this.maxVehicles) break;
      if (this._trySpawn(fin(pos3[0], 0), fin(pos3[2], 0), i === 0 ? 22 : SPAWN_MIN, SPAWN_MAX)) made++;
    }
    return made;
  }

  /**
   * Attempts one spawn inside an annulus around a point.
   * @param {number} px Centre x.
   * @param {number} pz Centre z.
   * @param {number} rMin Inner radius.
   * @param {number} rMax Outer radius.
   * @returns {boolean} True when a car was created.
   * @private
   */
  _trySpawn(px, pz, rMin, rMax) {
    const graph = this.lanes;
    if (graph.sampleCount === 0) return false;
    const n = graph.queryRing(px, pz, rMin, rMax, _cand);
    if (n === 0) return false;
    const camera = this.game.camera;
    let bestSample = -1;
    let bestScore = -Infinity;
    for (let t = 0; t < SPAWN_TRIES; t++) {
      const s = _cand[(this._spawnCursor = (this._spawnCursor + 1 + this.rng.int(0, 7)) % n)];
      const lane = graph.sPoly[s];
      const rec = this.city.lanes[lane];
      if (!rec) continue;
      if (rec.edgeId !== undefined && rec.edgeId < 0) continue;
      const x = graph.sx[s];
      const z = graph.sz[s];
      if (!this._spotClear(x, z, SPAWN_CLEAR)) continue;
      let score = 0;
      if (camera && typeof camera.frustumContainsSphere === 'function') {
        let visible = false;
        try { visible = camera.frustumContainsSphere(x, 1.2, z, 3.5); } catch (err) { visible = false; }
        score = visible ? 0 : 10;
      } else {
        score = 10;
      }
      const dx = x - px;
      const dz = z - pz;
      score += Math.sqrt(dx * dx + dz * dz) * 0.01;
      if (score > bestScore) { bestScore = score; bestSample = s; }
      if (score >= 10 && t >= 3) break;
    }
    if (bestSample < 0) return false;
    return this._spawnAt(graph.sPoly[bestSample], graph.sDist[bestSample]) !== null;
  }

  /**
   * @param {number} x World x.
   * @param {number} z World z.
   * @param {number} clear Required clearance in metres.
   * @returns {boolean} True when no vehicle is within `clear`.
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
    const p = this.game.player;
    if (p && p.position) {
      const dx = p.position[0] - x;
      const dz = p.position[2] - z;
      if (dx * dx + dz * dz < 36) return false;
    }
    return true;
  }

  /**
   * Creates one AI car on a lane.
   * @param {number} laneId Lane id.
   * @param {number} laneDist Arc distance along the lane.
   * @returns {object|null} The vehicle, or null on failure.
   * @private
   */
  _spawnAt(laneId, laneDist) {
    const graph = this.lanes;
    graph.sample(laneId, laneDist, _pt);
    graph.tangent(laneId, laneDist, _tan);
    const yaw = Math.atan2(-_tan[0], -_tan[1]);
    const typeKey = this._pickType();
    const v = this._acquireVehicle(typeKey, _pt[0], _pt[1], yaw);
    if (!v) return null;

    const ai = this._acquireDriver();
    ai.vehicle = v;
    ai.laneId = laneId;
    ai.laneDist = laneDist;
    ai.routeLen = 0;
    ai.cruise = this.rng.range(0.78, 1.06);
    ai.aggression = this.rng.next();
    ai.reaction = this.rng.range(0.06, 0.24);
    ai.accum = this.rng.range(0, LOD1_STEP);
    ai.blocked = 0;
    ai.hornTimer = this.rng.range(0, 1.5);
    ai.panic = 0;
    ai.crash = 0;
    ai.swerve = 0;
    ai.stuck = 0;
    ai.lost = 0;
    ai.state = 'drive';
    ai.typeKey = typeKey;
    ai.seed = this.rng.int(1, 0x7ffffff);
    ai.female = this.rng.chance(0.45);
    ai.lastX = v.position[0];
    ai.lastZ = v.position[2];
    this._extendRoute(ai);

    v.ai = ai;
    v.isTraffic = true;
    v.parked = false;
    v.visible = true;
    v.engineOn = true;
    // Start rolling so a freshly streamed car does not look parked in the middle of the road.
    const startSpeed = Math.min(fin(this.city.lanes[laneId] && this.city.lanes[laneId].speedLimit, 12), 14)
      * ai.cruise * 0.8;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    if (v.velocity) {
      v.velocity[0] = fx * startSpeed;
      v.velocity[2] = fz * startSpeed;
    }
    v.forwardSpeed = startSpeed;
    this.vehicles.push(v);
    return v;
  }

  /**
   * Recycles every AI car beyond `radius` from a point.
   * @param {ArrayLike<number>} pos3 Centre.
   * @param {number} [radius=DESPAWN_DIST] Distance in metres.
   * @returns {number} Number of cars recycled.
   */
  despawnFar(pos3, radius = DESPAWN_DIST) {
    const px = fin(pos3[0], 0);
    const pz = fin(pos3[2], 0);
    const r2 = radius * radius;
    let n = 0;
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i];
      if (!v || !v.position) { this._dropIndex(i, true); n++; continue; }
      const dx = v.position[0] - px;
      const dz = v.position[2] - pz;
      if (dx * dx + dz * dz > r2) { this._dropIndex(i, false); n++; }
    }
    return n;
  }

  /**
   * Removes the AI car at `i` from the live list.
   * @param {number} i Index into {@link TrafficManager#vehicles}.
   * @param {boolean} destroy Force a real removal.
   * @returns {void}
   * @private
   */
  _dropIndex(i, destroy) {
    const v = this.vehicles[i];
    this.vehicles.splice(i, 1);
    if (!v) return;
    const ai = v.ai;
    if (ai) this._releaseDriver(ai);
    this._releaseVehicle(v, destroy);
  }

  /**
   * Hands a car over to whoever just stole it and turns its driver into a fleeing pedestrian.
   * @param {object} vehicle Vehicle the driver was ejected from.
   * @param {object|null} ai The driver record (may be null).
   * @returns {void}
   */
  onDriverEjected(vehicle, ai) {
    const game = this.game;
    const rec = ai && ai.vehicle === vehicle ? ai : (vehicle && vehicle.ai) || null;
    const i = this.vehicles.indexOf(vehicle);
    if (i >= 0) this.vehicles.splice(i, 1);
    if (vehicle) {
      vehicle.ai = null;
      vehicle.isTraffic = false;
      // Keep owning the abandoned shell so it streams out instead of piling up in the world.
      if (this.orphans.indexOf(vehicle) < 0) {
        if (this.orphans.length < 24) this.orphans.push(vehicle);
        else this._releaseVehicle(this.orphans.shift(), false);
        if (this.orphans.indexOf(vehicle) < 0) this.orphans.push(vehicle);
      }
    }
    if (!rec) return;
    // Drop the driver out of the door and let the ped manager panic it.
    const px = fin(vehicle && vehicle.position ? vehicle.position[0] : 0, 0);
    const pz = fin(vehicle && vehicle.position ? vehicle.position[2] : 0, 0);
    const yaw = fin(vehicle ? vehicle.yaw : 0, 0);
    const ox = Math.cos(yaw) * 1.7;
    const oz = -Math.sin(yaw) * 1.7;
    const x = px + ox;
    const z = pz + oz;
    const y = typeof game.worldToGround === 'function' ? fin(game.worldToGround(x, z), 0) : 0;
    const peds = game.peds;
    if (peds && typeof peds.spawnPed === 'function') {
      let ped = null;
      try {
        ped = peds.spawnPed(x, y + 0.05, z, { seed: rec.seed, female: rec.female, kind: 'civ' });
      } catch (err) { ped = null; }
      if (ped && typeof peds.scare === 'function') peds.scare(ped, px, pz, true);
    }
    this._releaseDriver(rec);
  }

  /**
   * Panics every driver near a loud, frightening event.
   * @param {ArrayLike<number>} pos3 Event position.
   * @param {number} [radius=45] Radius in metres.
   * @returns {void}
   */
  alert(pos3, radius = 45) {
    if (!pos3) return;
    const x = fin(pos3[0], 0);
    const z = fin(pos3[2], 0);
    const r2 = radius * radius;
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      const ai = v && v.ai;
      if (!ai || !v.position) continue;
      const dx = v.position[0] - x;
      const dz = v.position[2] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      ai.panic = PANIC_TIME * (0.6 + 0.4 * (1 - d2 / r2));
      ai.state = 'panic';
      // A small share of panicking drivers lose it completely and swerve into something.
      if (this.rng.chance(0.16)) ai.crash = this.rng.range(0.5, 1.4);
      if (ai.hornTimer <= 0) {
        ai.hornTimer = HORN_COOLDOWN;
        this._horn(v);
      }
    }
  }

  /**
   * Sounds a horn without letting the audio layer throw into the AI loop.
   * @param {object} v Vehicle.
   * @returns {void}
   * @private
   */
  _horn(v) {
    const sfx = this.game.sfx;
    if (!sfx || typeof sfx.horn !== 'function') return;
    try { sfx.horn(v.position, (v.type && v.type.key) || 'sedan'); } catch (err) { /* audio off */ }
  }

  /* ---------------------------------------------------------------- update */

  /**
   * Streams and drives the traffic.
   * @param {number} dt Delta time in seconds.
   * @param {ArrayLike<number>} playerPos Player world position.
   * @returns {void}
   */
  update(dt, playerPos) {
    const step = dt > 0.25 ? 0.25 : dt > 0 ? dt : 0;
    this._time += step;
    const px = playerPos ? fin(playerPos[0], 0) : 0;
    const pz = playerPos ? fin(playerPos[2], 0) : 0;

    // --- stream out -----------------------------------------------------------------
    const far2 = DESPAWN_DIST * DESPAWN_DIST;
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i];
      if (!v || !v.position || !Number.isFinite(v.position[0])) { this._dropIndex(i, true); continue; }
      const ai = v.ai;
      if (!ai) { this.vehicles.splice(i, 1); continue; }
      // Somebody jacked it: hand it over and turn the driver into a fleeing pedestrian.
      if (v.driver || v.isPlayer) {
        const player = this.game.player;
        this.onDriverEjected(v, ai);
        if (player && (v.driver === player || v.isPlayer) && this.game.police
          && typeof this.game.police.reportCrime === 'function') {
          try { this.game.police.reportCrime('carjack', v.position); } catch (err) { /* ignore */ }
        }
        continue;
      }
      if (v.isDestroyed || (typeof v.health === 'number' && v.health <= 0)) {
        this.vehicles.splice(i, 1);
        this._releaseDriver(ai);
        v.ai = null;
        v.isTraffic = false;
        if (this.wrecks.length < 24) this.wrecks.push(v);
        else this._releaseVehicle(v, true);
        continue;
      }
      const dx = v.position[0] - px;
      const dz = v.position[2] - pz;
      if (dx * dx + dz * dz > far2) { this._dropIndex(i, false); continue; }
    }

    // --- wrecks and abandoned cars ----------------------------------------------------
    const wreckFar = WRECK_DIST * WRECK_DIST;
    const playerVehicle = this.game.player ? this.game.player.vehicle : null;
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      const v = this.wrecks[i];
      if (!v || !v.position) { this.wrecks.splice(i, 1); continue; }
      if (v === playerVehicle) { this.wrecks.splice(i, 1); continue; }
      const dx = v.position[0] - px;
      const dz = v.position[2] - pz;
      if (dx * dx + dz * dz > wreckFar) {
        this.wrecks.splice(i, 1);
        this._releaseVehicle(v, true);
      }
    }
    for (let i = this.orphans.length - 1; i >= 0; i--) {
      const v = this.orphans[i];
      if (!v || !v.position) { this.orphans.splice(i, 1); continue; }
      if (v === playerVehicle) continue;
      if (v.isDestroyed) {
        this.orphans.splice(i, 1);
        if (this.wrecks.length < 24) this.wrecks.push(v);
        else this._releaseVehicle(v, true);
        continue;
      }
      const dx = v.position[0] - px;
      const dz = v.position[2] - pz;
      if (dx * dx + dz * dz > wreckFar) {
        this.orphans.splice(i, 1);
        // Police cruisers are not part of the civilian mix, so never pool one.
        this._releaseVehicle(v, !!v.isPolice);
      }
    }

    // --- stream in ------------------------------------------------------------------
    if (this.streaming) {
      let budget = SPAWN_BUDGET;
      while (budget > 0 && this.vehicles.length < this.maxVehicles) {
        if (!this._trySpawn(px, pz, SPAWN_MIN, SPAWN_MAX)) break;
        budget--;
      }
    }

    // --- drive ----------------------------------------------------------------------
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      const ai = v.ai;
      if (!ai) continue;
      const dx = v.position[0] - px;
      const dz = v.position[2] - pz;
      const d2 = dx * dx + dz * dz;
      const period = d2 > 12100 ? LOD2_STEP : d2 > 2025 ? LOD1_STEP : 0;
      if (period > 0) {
        ai.accum += step;
        if (ai.accum < period) continue;
        this._drive(v, ai, ai.accum);
        ai.accum = 0;
      } else {
        this._drive(v, ai, step);
      }
    }
  }

  /**
   * One AI tick for a single car.
   * @param {object} v Vehicle.
   * @param {object} ai Driver record.
   * @param {number} dt Time since this driver last ticked.
   * @returns {void}
   * @private
   */
  _drive(v, ai, dt) {
    const input = v.input;
    if (!input) return;
    const graph = this.lanes;
    const x = fin(v.position[0], 0);
    const z = fin(v.position[2], 0);
    const yaw = fin(v.yaw, 0);
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const speed = forwardSpeedOf(v);

    ai.hornTimer -= dt;
    if (ai.panic > 0) ai.panic -= dt;
    if (ai.crash > 0) ai.crash -= dt;
    if (ai.swerve !== 0) ai.swerve *= Math.max(0, 1 - dt * 2.2);

    // --- lane tracking ---------------------------------------------------------------
    let laneLen = graph.length(ai.laneId);
    ai.laneDist = graph.project(ai.laneId, x, z);
    let offTrack = graph.projDist2;
    if (ai.laneDist >= laneLen - 0.6) {
      if (!this._advanceLane(ai)) {
        // Dead end with nowhere to go: snap onto the nearest lane instead of freezing.
        const near = graph.nearest(x, z, 60);
        if (near < 0) { ai.lost += dt; if (ai.lost > 3) this._recycle(v); return; }
        ai.laneId = near;
        ai.laneDist = graph.nearDist;
        ai.routeLen = 0;
        this._extendRoute(ai);
      }
      laneLen = graph.length(ai.laneId);
      ai.laneDist = graph.project(ai.laneId, x, z);
      offTrack = graph.projDist2;
    }
    // Knocked off the network (spun out, rammed): re-acquire the nearest lane.
    if (offTrack > 100) {
      ai.lost += dt;
      if (ai.lost > 0.8) {
        const near = graph.nearest(x, z, 70);
        if (near >= 0) {
          ai.laneId = near;
          ai.laneDist = graph.nearDist;
          ai.routeLen = 0;
          this._extendRoute(ai);
          ai.lost = 0;
        } else if (ai.lost > 4) {
          this._recycle(v);
          return;
        }
      }
    } else {
      ai.lost = 0;
    }

    const lane = this.city.lanes[ai.laneId] || null;
    const limit = lane && Number.isFinite(lane.speedLimit) ? lane.speedLimit : 12;

    // --- pure pursuit ---------------------------------------------------------------
    const lookahead = clamp(4.5 + Math.abs(speed) * 0.72, 5.5, 26);
    this._routePoint(ai, lookahead, _pt);
    let tx = _pt[0];
    let tz = _pt[1];
    if (ai.swerve !== 0) {
      // Lateral offset (right-hand normal of the pursuit direction) to dodge a wreck.
      const ddx = tx - x;
      const ddz = tz - z;
      const l = Math.hypot(ddx, ddz) || 1;
      tx += (-ddz / l) * ai.swerve;
      tz += (ddx / l) * ai.swerve;
    }
    let steer = pursuitSteer(v, tx, tz);
    if (ai.crash > 0) steer = clamp(steer + (ai.seed & 1 ? 0.85 : -0.85), -1, 1);
    input.steer = steer;

    // --- speed targets ---------------------------------------------------------------
    const panicking = ai.panic > 0;
    let target = limit * ai.cruise * (panicking ? 1.35 : 1);

    // curvature: sample further ahead and cap the speed for the bend
    this._routePoint(ai, lookahead + 9, _pt2);
    const c1x = _pt2[0] - x;
    const c1z = _pt2[1] - z;
    const cl = Math.hypot(c1x, c1z);
    if (cl > 1) {
      const bend = Math.abs(wrapAngle(Math.atan2(-c1x, -c1z) - yaw));
      if (bend > 0.12) {
        const curv = 2 * Math.sin(Math.min(bend, 1.4)) / Math.max(4, cl);
        if (curv > 1e-4) target = Math.min(target, Math.sqrt(LAT_ACCEL / curv));
      }
    }

    // car following
    const lead = this._leadGap(v, x, z, fx, fz);
    if (lead >= 0) {
      const gap = lead - MIN_GAP;
      if (gap <= 0.2) target = 0;
      else target = Math.min(target, gap / HEADWAY);
      if (lead < MIN_GAP + 1.2 && Math.abs(speed) < 0.8) {
        ai.blocked += dt;
        if (ai.blocked > BLOCKED_HORN && ai.hornTimer <= 0) {
          ai.hornTimer = HORN_COOLDOWN;
          input.horn = true;
          this._horn(v);
        }
      } else {
        ai.blocked = 0;
      }
    } else {
      ai.blocked = 0;
    }
    if (ai.hornTimer > HORN_COOLDOWN - 0.25) input.horn = true;
    else input.horn = false;

    // traffic lights (never ignored unless panicking)
    if (!panicking && lane && lane.kind !== 'turn') {
      const stopDist = laneLen - ai.laneDist;
      if (stopDist < 40) {
        const tl = this._lightFor(lane.toNode);
        if (tl) {
          graph.tangent(ai.laneId, laneLen, _tan);
          const axis = Math.abs(_tan[0]) > Math.abs(_tan[1]) ? 'x' : 'z';
          const state = typeof tl.state === 'function' ? tl.state(axis) : 'green';
          const brakeDist = Math.max(2, (speed * speed) / 6.5 + 3);
          if (state === 'red' || (state === 'amber' && stopDist > brakeDist * 0.7)) {
            const room = Math.max(0, stopDist - 3.2);
            target = Math.min(target, room * 0.55);
            if (room < 1.2) target = 0;
          }
        }
      }
    }

    // hazards: pedestrians, the player on foot, wrecks
    target = Math.min(target, this._hazardLimit(v, ai, x, z, fx, fz, speed));

    if (panicking) target = Math.max(target, limit * 0.6);
    if (target < 0) target = 0;
    applySpeedControl(v, speed, target);
    input.handbrake = false;

    // --- stuck detection --------------------------------------------------------------
    const mdx = x - ai.lastX;
    const mdz = z - ai.lastZ;
    if (mdx * mdx + mdz * mdz < 0.0016 && target > 1.5) ai.stuck += dt;
    else ai.stuck = 0;
    ai.lastX = x;
    ai.lastZ = z;
    if (ai.stuck > 6) {
      // Wedged against geometry with nobody in front: reverse out, then re-route.
      input.throttle = -0.55;
      input.brake = 0;
      input.steer = -steer;
      if (ai.stuck > 9.5) {
        const player = this.game.player;
        const dpx = player && player.position ? player.position[0] - x : 1e9;
        const dpz = player && player.position ? player.position[2] - z : 1e9;
        if (dpx * dpx + dpz * dpz > 3600) this._recycle(v);
        else ai.stuck = 0;
      }
    }
  }

  /**
   * Recycles one AI car by identity.
   * @param {object} v Vehicle.
   * @returns {void}
   * @private
   */
  _recycle(v) {
    const i = this.vehicles.indexOf(v);
    if (i >= 0) this._dropIndex(i, false);
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
    if (map && typeof map.get === 'function') {
      const tl = map.get(nodeId);
      return tl || null;
    }
    const list = world.trafficLights;
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i++) if (list[i].nodeId === nodeId) return list[i];
    }
    return null;
  }

  /**
   * Distance to the closest vehicle ahead inside the driving corridor.
   * @param {object} self The querying vehicle.
   * @param {number} x Its x.
   * @param {number} z Its z.
   * @param {number} fx Forward x.
   * @param {number} fz Forward z.
   * @returns {number} Bumper-to-bumper distance in metres, or -1 when the road is clear.
   * @private
   */
  _leadGap(self, x, z, fx, fz) {
    const list = this.game.vehicles;
    if (!Array.isArray(list)) return -1;
    const halfSelf = (self.type && self.type.length ? self.type.length : 4.4) * 0.5;
    let best = -1;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o === self || !o || !o.position) continue;
      const dx = o.position[0] - x;
      const dz = o.position[2] - z;
      const along = dx * fx + dz * fz;
      if (along <= 0 || along > FOLLOW_RANGE) continue;
      const lat = dx * -fz + dz * fx;
      const halfO = (o.type && o.type.length ? o.type.length : 4.4) * 0.5;
      const width = FOLLOW_HALF_WIDTH + (o.type && o.type.width ? o.type.width * 0.25 : 0.5);
      if (lat > width || lat < -width) continue;
      const gap = along - halfSelf - halfO;
      if (best < 0 || gap < best) best = gap < 0 ? 0 : gap;
    }
    return best;
  }

  /**
   * Speed cap imposed by pedestrians, the player on foot and wrecks in the road.
   * @param {object} v Vehicle.
   * @param {object} ai Driver record.
   * @param {number} x Vehicle x.
   * @param {number} z Vehicle z.
   * @param {number} fx Forward x.
   * @param {number} fz Forward z.
   * @param {number} speed Forward speed.
   * @returns {number} Speed limit in m/s (`Infinity` when nothing is in the way).
   * @private
   */
  _hazardLimit(v, ai, x, z, fx, fz, speed) {
    let limit = Infinity;
    const game = this.game;

    // player on foot
    const player = game.player;
    if (player && !player.vehicle && !player.dead && player.position) {
      const d = corridorDistance(x, z, fx, fz, player.position[0], player.position[2], 2.0);
      if (d >= 0 && d < HAZARD_RANGE) limit = Math.min(limit, Math.max(0, (d - 3.4) * 0.8));
    }

    // pedestrians
    const peds = game.peds && game.peds.peds;
    if (Array.isArray(peds) && peds.length) {
      for (let i = 0; i < peds.length; i++) {
        const p = peds[i];
        if (!p || p.dead || !p.position) continue;
        const dx = p.position[0] - x;
        const dz = p.position[2] - z;
        if (dx * dx + dz * dz > HAZARD_RANGE * HAZARD_RANGE) continue;
        const d = corridorDistance(x, z, fx, fz, p.position[0], p.position[2], 1.9);
        if (d >= 0) limit = Math.min(limit, Math.max(0, (d - 2.8) * 0.8));
      }
    }

    // wrecks: brake a little and steer around them
    for (let i = 0; i < this.wrecks.length; i++) {
      const w = this.wrecks[i];
      if (!w || !w.position) continue;
      const d = corridorDistance(x, z, fx, fz, w.position[0], w.position[2], 2.6);
      if (d < 0 || d > 26) continue;
      const dx = w.position[0] - x;
      const dz = w.position[2] - z;
      const lat = dx * -fz + dz * fx;
      ai.swerve = lat >= 0 ? -3.4 : 3.4;
      limit = Math.min(limit, Math.max(3, d * 0.6));
    }

    if (ai.panic > 0) limit = Math.max(limit, 6);
    if (speed < 0.2 && limit < 0.5) limit = 0;
    return limit;
  }

  /**
   * Removes every AI car and empties the pools. Used when the world is torn down.
   * @returns {void}
   */
  clear() {
    for (let i = this.vehicles.length - 1; i >= 0; i--) this._dropIndex(i, true);
    for (let i = this.wrecks.length - 1; i >= 0; i--) this._releaseVehicle(this.wrecks[i], true);
    this.wrecks.length = 0;
    for (let i = this.orphans.length - 1; i >= 0; i--) this._releaseVehicle(this.orphans[i], true);
    this.orphans.length = 0;
    this._pool.forEach((pool) => {
      for (let i = 0; i < pool.length; i++) {
        if (typeof this.game.removeVehicle === 'function') {
          try { this.game.removeVehicle(pool[i]); } catch (err) { /* already gone */ }
        }
      }
      pool.length = 0;
    });
    this._pool.clear();
  }

  /**
   * AI cars render through `game.vehicles`, so there is nothing extra to draw here. The method
   * exists because the contract lists it and `game.js` calls `submit` on every system.
   * @returns {void}
   */
  submit() { /* vehicles are drawn by game.js from game.vehicles */ }
}
