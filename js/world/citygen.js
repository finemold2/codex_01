/**
 * @file NEON CITY — seeded procedural city layout generator.
 *
 * Produces the complete `CityData` structure consumed by `world/worldbuild.js`
 * (geometry + collision), `entities/traffic.js` (lane graph), `entities/ped.js`
 * (pedestrian graph), `ui/map.js` (minimap / landmarks) and `missions.js`.
 *
 * Everything here is deterministic: the only randomness source is the seeded
 * `Rand` class from `core/math.js` plus a pure integer hash noise. Calling
 * `generateCity(1337)` twice always yields deeply equal data.
 *
 * Coordinate conventions (see docs/ARCHITECTURE.md §0):
 *   - Units are metres. Y is up, the ground plane is y = 0.
 *   - The world lies on the XZ plane, `+X` = east, `+Z` = south.
 *   - `yaw = 0` faces `-Z` (north); ground forward = `[-sin(yaw), 0, -cos(yaw)]`.
 *
 * All object `id` fields are the object's own index inside its array, so
 * `city.lanes[laneId]`, `city.walks[walkId]`, `city.nodes[nodeId]`,
 * `city.roads[roadId]`, `city.lots[lotId]`, `city.buildings[buildingId]` and
 * `city.districts[districtId]` are O(1) lookups.
 */

import { Rand, clamp, lerp, vec2 } from '../core/math.js';

/* ------------------------------------------------------------------ *
 * Tunable constants
 * ------------------------------------------------------------------ */

/** Width of the sidewalk strip that borders every road, in metres. */
const SIDEWALK_W = 3.0;
/** Extra setback kept between the sidewalk edge and any building wall. */
const BUILDING_SETBACK = 2.5;
/** Distance of the pedestrian centre line from the kerb, in metres. */
const WALK_OFFSET = 1.8;
/** Height of the sidewalk surface above the road, in metres. */
const SIDEWALK_H = 0.15;
/** Carriageway width of a wide avenue. */
const AVENUE_WIDTH = 24;
/** Carriageway width of the diagonal boulevard. */
const BOULEVARD_WIDTH = 30;
/** Carriageway width of the curved waterfront road. */
const WATERFRONT_WIDTH = 20;
/** Distance from the last grid road centre out to the waterfront road. */
const WATERFRONT_SETOUT = 58;
/** Sea level (negative so the shoreline reads as a beach slope). */
const WATER_LEVEL = -0.6;
/** Metres of floor-to-floor height used to derive `floors` from `h`. */
const FLOOR_HEIGHT = 3.4;

/** Speed limits expressed in m/s (40 / 70 / 90 / 60 / 30 km/h). */
const SPEED_STREET = 40 / 3.6;
const SPEED_AVENUE = 70 / 3.6;
const SPEED_BOULEVARD = 90 / 3.6;
const SPEED_WATERFRONT = 60 / 3.6;
const SPEED_TURN = 30 / 3.6;

/** Spatial-hash cell size used for overlap queries during generation. */
const HASH_CELL = 24;

/* ------------------------------------------------------------------ *
 * Static tables (pure constants — no side effects at import time)
 * ------------------------------------------------------------------ */

/**
 * Per-district-kind colour palettes in linear space.
 * `wall` entries are picked per building, `trim` and `glass` accent them.
 */
const PALETTES = {
  downtown: {
    wall: [[0.052, 0.060, 0.078], [0.078, 0.086, 0.105], [0.036, 0.046, 0.062],
      [0.100, 0.104, 0.115], [0.062, 0.070, 0.096], [0.030, 0.034, 0.044]],
    trim: [[0.145, 0.170, 0.205], [0.085, 0.115, 0.150], [0.190, 0.195, 0.205]],
    glass: [[0.030, 0.075, 0.098], [0.020, 0.055, 0.085], [0.045, 0.090, 0.110],
      [0.018, 0.040, 0.060]]
  },
  midtown: {
    wall: [[0.135, 0.128, 0.118], [0.108, 0.100, 0.092], [0.160, 0.146, 0.126],
      [0.090, 0.092, 0.098], [0.145, 0.112, 0.090], [0.120, 0.124, 0.130]],
    trim: [[0.205, 0.196, 0.180], [0.155, 0.140, 0.120], [0.230, 0.222, 0.210]],
    glass: [[0.040, 0.070, 0.082], [0.032, 0.058, 0.072], [0.055, 0.080, 0.090]]
  },
  residential: {
    wall: [[0.170, 0.120, 0.098], [0.190, 0.160, 0.130], [0.135, 0.115, 0.100],
      [0.205, 0.185, 0.155], [0.150, 0.140, 0.155], [0.180, 0.140, 0.115]],
    trim: [[0.240, 0.225, 0.200], [0.135, 0.100, 0.080], [0.215, 0.205, 0.195]],
    glass: [[0.052, 0.070, 0.078], [0.040, 0.060, 0.070]]
  },
  industrial: {
    wall: [[0.098, 0.100, 0.096], [0.120, 0.108, 0.090], [0.086, 0.092, 0.098],
      [0.135, 0.100, 0.075], [0.075, 0.080, 0.082]],
    trim: [[0.150, 0.150, 0.145], [0.180, 0.130, 0.070], [0.110, 0.115, 0.120]],
    glass: [[0.055, 0.062, 0.060], [0.045, 0.052, 0.055]]
  },
  park: {
    wall: [[0.120, 0.140, 0.110], [0.150, 0.155, 0.140]],
    trim: [[0.200, 0.210, 0.190]],
    glass: [[0.050, 0.075, 0.070]]
  },
  beach: {
    wall: [[0.230, 0.215, 0.180], [0.205, 0.200, 0.195], [0.195, 0.180, 0.150],
      [0.180, 0.200, 0.205], [0.235, 0.225, 0.205]],
    trim: [[0.255, 0.250, 0.235], [0.100, 0.150, 0.165], [0.240, 0.190, 0.140]],
    glass: [[0.060, 0.095, 0.100], [0.048, 0.080, 0.090]]
  }
};

/** Korean base names for each district kind. */
const DISTRICT_NAMES = {
  downtown: '네온 다운타운',
  midtown: '미드타운',
  residential: '리버사이드 주택가',
  industrial: '항만 공업지구',
  park: '네온 공원',
  beach: '선셋 해변'
};

/** Neon shop signage (Korean, user visible). */
const SHOP_SIGNS = ['네온 바', '전당포', '24시 편의점', '국수집', '왕만두', '치킨',
  '노래방', '전자상가', '약국', '커피', '세탁소', '분식', '포장마차', '피시방',
  '중고차', '철물점', '해변 카페', '레코드', '헌책방', '이발소', '떡볶이', '초밥'];

/** Corporate neon signage used on towers and offices. */
const TOWER_SIGNS = ['사이버 타워', '네온 그룹', '동방 은행', '미래 전자', '한강 물산',
  '스타 미디어', '태양 화학', '제일 보험', '오리온 통신', '금성 중공업'];

/** Billboard copy (Korean, user visible). */
const BILLBOARD_TEXTS = ['오늘 밤 네온 시티', '신형 세단 출시', '해변으로 오세요',
  '심야 라디오 88.1', '클래식 라이브', '치킨 두 마리', '자유 도시', '별빛 호텔'];

/** Emissive neon colours (linear) reused by signs and billboards. */
const NEON_COLORS = [[3.4, 0.55, 1.5], [0.25, 2.8, 3.4], [3.6, 2.0, 0.35],
  [0.5, 3.2, 1.2], [3.2, 0.7, 0.5], [1.4, 0.9, 3.6]];

/* ------------------------------------------------------------------ *
 * Small deterministic helpers
 * ------------------------------------------------------------------ */

/**
 * Mixes a string salt into a numeric seed so each generation phase can own a
 * private, reproducible `Rand` stream.
 * @param {number} seed Base seed.
 * @param {string} salt Phase name.
 * @returns {number} A 32-bit unsigned seed.
 */
function mixSeed(seed, salt) {
  let h = (seed | 0) ^ 0x9e3779b9;
  for (let i = 0; i < salt.length; i++) {
    h = Math.imul(h ^ salt.charCodeAt(i), 0x85ebca6b);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 0xc2b2ae35);
  return (h ^ (h >>> 15)) >>> 0;
}

/**
 * Uniform float in `[a, b)` from a `Rand`.
 * @param {Rand} rng Random source.
 * @param {number} a Lower bound.
 * @param {number} b Upper bound.
 * @returns {number} Random value.
 */
function rr(rng, a, b) {
  return a + rng.next() * (b - a);
}

/**
 * Uniform integer in `[a, b]` (inclusive) from a `Rand`.
 * @param {Rand} rng Random source.
 * @param {number} a Lower bound.
 * @param {number} b Upper bound.
 * @returns {number} Random integer.
 */
function ri(rng, a, b) {
  const v = a + Math.floor(rng.next() * (b - a + 1));
  return v > b ? b : v;
}

/**
 * Picks one entry of an array.
 * @template T
 * @param {Rand} rng Random source.
 * @param {T[]} arr Non-empty array.
 * @returns {T} Chosen entry.
 */
function rpick(rng, arr) {
  let i = Math.floor(rng.next() * arr.length);
  if (i >= arr.length) i = arr.length - 1;
  if (i < 0) i = 0;
  return arr[i];
}

/**
 * Bernoulli trial.
 * @param {Rand} rng Random source.
 * @param {number} p Probability in 0..1.
 * @returns {boolean} True with probability `p`.
 */
function rchance(rng, p) {
  return rng.next() < p;
}

/**
 * Deterministic 2D integer hash in `[0, 1)` — used for coherent noise so that
 * neighbouring lots agree on skyline height without consuming rng state.
 * @param {number} x Integer cell x.
 * @param {number} z Integer cell z.
 * @param {number} seed Seed.
 * @returns {number} Pseudo-random value in [0,1).
 */
function hash2(x, z, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1) ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2d);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Smooth 2D value noise built on {@link hash2}.
 * @param {number} x Sample x (world metres / feature size).
 * @param {number} z Sample z.
 * @param {number} seed Seed.
 * @returns {number} Noise value in 0..1.
 */
function noise2(x, z, seed) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const a = hash2(xi, zi, seed);
  const b = hash2(xi + 1, zi, seed);
  const c = hash2(xi, zi + 1, seed);
  const d = hash2(xi + 1, zi + 1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/**
 * Yaw (see §0 conventions) for an entity that should face direction `(dx, dz)`.
 * @param {number} dx Direction x.
 * @param {number} dz Direction z.
 * @returns {number} Yaw in radians.
 */
function yawFromDir(dx, dz) {
  return Math.atan2(-dx, -dz);
}

/* ------------------------------------------------------------------ *
 * Polyline helpers (generation-time only; they allocate)
 * ------------------------------------------------------------------ */

/**
 * Total length of a polyline.
 * @param {number[][]} pts Points as `[x, z]`.
 * @returns {number} Length in metres.
 */
function polyLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dz = pts[i][1] - pts[i - 1][1];
    len += Math.sqrt(dx * dx + dz * dz);
  }
  return len;
}

/**
 * Unit direction of the first segment of a polyline.
 * @param {number[][]} pts Points.
 * @param {number[]} out Two-element output.
 * @returns {number[]} `out`.
 */
function polyStartDir(pts, out) {
  const dx = pts[1][0] - pts[0][0];
  const dz = pts[1][1] - pts[0][1];
  const l = Math.hypot(dx, dz) || 1;
  out[0] = dx / l;
  out[1] = dz / l;
  return out;
}

/**
 * Unit direction of the last segment of a polyline.
 * @param {number[][]} pts Points.
 * @param {number[]} out Two-element output.
 * @returns {number[]} `out`.
 */
function polyEndDir(pts, out) {
  const n = pts.length;
  const dx = pts[n - 1][0] - pts[n - 2][0];
  const dz = pts[n - 1][1] - pts[n - 2][1];
  const l = Math.hypot(dx, dz) || 1;
  out[0] = dx / l;
  out[1] = dz / l;
  return out;
}

/**
 * Offsets a polyline sideways (positive = to the right of travel) using a
 * mitred join at interior vertices.
 * @param {number[][]} pts Source points.
 * @param {number} off Lateral offset in metres.
 * @returns {number[][]} New polyline.
 */
function polyOffset(pts, off) {
  const n = pts.length;
  const dirs = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dz = pts[i + 1][1] - pts[i][1];
    const l = Math.hypot(dx, dz) || 1;
    dirs.push([dx / l, dz / l]);
  }
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = dirs[Math.max(0, i - 1)];
    const b = dirs[Math.min(dirs.length - 1, i)];
    // Right normal of a direction (dx, dz) is (-dz, dx).
    let nx = -(a[1] + b[1]);
    let nz = a[0] + b[0];
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    const cosHalf = Math.max(0.5, nx * -b[1] + nz * b[0]);
    const m = off / cosHalf;
    out[i] = [pts[i][0] + nx * m, pts[i][1] + nz * m];
  }
  return out;
}

/**
 * Trims a polyline by arc length from both ends.
 * @param {number[][]} pts Source points (not modified).
 * @param {number} startTrim Metres removed from the start.
 * @param {number} endTrim Metres removed from the end.
 * @returns {number[][]|null} Trimmed polyline, or null when nothing survives.
 */
function polyTrim(pts, startTrim, endTrim) {
  let work = pts.map((p) => [p[0], p[1]]);
  if (startTrim > 0) {
    let remain = startTrim;
    while (work.length >= 2) {
      const dx = work[1][0] - work[0][0];
      const dz = work[1][1] - work[0][1];
      const l = Math.hypot(dx, dz);
      if (l > remain + 0.001) {
        work[0] = [work[0][0] + (dx / l) * remain, work[0][1] + (dz / l) * remain];
        break;
      }
      remain -= l;
      work.shift();
    }
    if (work.length < 2) return null;
  }
  if (endTrim > 0) {
    let remain = endTrim;
    while (work.length >= 2) {
      const n = work.length;
      const dx = work[n - 1][0] - work[n - 2][0];
      const dz = work[n - 1][1] - work[n - 2][1];
      const l = Math.hypot(dx, dz);
      if (l > remain + 0.001) {
        work[n - 1] = [work[n - 1][0] - (dx / l) * remain, work[n - 1][1] - (dz / l) * remain];
        break;
      }
      remain -= l;
      work.pop();
    }
    if (work.length < 2) return null;
  }
  return polyLength(work) < 0.4 ? null : work;
}

/**
 * Samples a point along a polyline by normalised arc length.
 * @param {number[][]} pts Points.
 * @param {number} t Parameter 0..1.
 * @param {number[]} out Output `[x, z]`.
 * @returns {number[]} `out`.
 */
function polySample(pts, t, out) {
  const total = polyLength(pts);
  let want = clamp(t, 0, 1) * total;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dz = pts[i][1] - pts[i - 1][1];
    const l = Math.hypot(dx, dz);
    if (want <= l || i === pts.length - 1) {
      const k = l > 0 ? want / l : 0;
      out[0] = pts[i - 1][0] + dx * k;
      out[1] = pts[i - 1][1] + dz * k;
      return out;
    }
    want -= l;
  }
  out[0] = pts[0][0];
  out[1] = pts[0][1];
  return out;
}

/**
 * Direction of the polyline at normalised arc length `t`.
 * @param {number[][]} pts Points.
 * @param {number} t Parameter 0..1.
 * @param {number[]} out Output `[dx, dz]`.
 * @returns {number[]} `out`.
 */
function polyDirAt(pts, t, out) {
  const total = polyLength(pts);
  let want = clamp(t, 0, 1) * total;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dz = pts[i][1] - pts[i - 1][1];
    const l = Math.hypot(dx, dz) || 1;
    if (want <= l || i === pts.length - 1) {
      out[0] = dx / l;
      out[1] = dz / l;
      return out;
    }
    want -= l;
  }
  out[0] = 0;
  out[1] = 1;
  return out;
}

/**
 * Builds a cubic Bézier arc between two directed points — used for the turn
 * lanes that thread through intersections.
 * @param {number[]} p0 Start `[x, z]`.
 * @param {number[]} d0 Start direction (unit).
 * @param {number[]} p1 End `[x, z]`.
 * @param {number[]} d1 End direction (unit).
 * @param {number} samples Number of output points (>= 2).
 * @returns {number[][]} Sampled polyline.
 */
function bezierArc(p0, d0, p1, d1, samples) {
  const dist = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const k = clamp(dist * 0.55, 1.0, 26);
  const c0x = p0[0] + d0[0] * k;
  const c0z = p0[1] + d0[1] * k;
  const c1x = p1[0] - d1[0] * k;
  const c1z = p1[1] - d1[1] * k;
  const out = new Array(samples);
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    const it = 1 - t;
    const a = it * it * it;
    const b = 3 * it * it * t;
    const c = 3 * it * t * t;
    const d = t * t * t;
    out[i] = [
      a * p0[0] + b * c0x + c * c1x + d * p1[0],
      a * p0[1] + b * c0z + c * c1z + d * p1[1]
    ];
  }
  return out;
}

/**
 * Centripetal-ish Catmull-Rom interpolation used for the curved waterfront.
 * @param {number[]} p0 Control point before the segment.
 * @param {number[]} p1 Segment start.
 * @param {number[]} p2 Segment end.
 * @param {number[]} p3 Control point after the segment.
 * @param {number} t Parameter 0..1.
 * @param {number[]} out Output `[x, z]`.
 * @returns {number[]} `out`.
 */
function catmullRom(p0, p1, p2, p3, t, out) {
  const t2 = t * t;
  const t3 = t2 * t;
  for (let c = 0; c < 2; c++) {
    out[c] = 0.5 * ((2 * p1[c]) + (-p0[c] + p2[c]) * t +
      (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 +
      (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Oriented-box overlap (SAT) + uniform spatial hash
 * ------------------------------------------------------------------ */

/** Scratch axes for the SAT test — module scope so the test never allocates. */
const _satAx = new Float64Array(2);
const _satAz = new Float64Array(2);
const _satBx = new Float64Array(2);
const _satBz = new Float64Array(2);
/** Minimum translation vector output of {@link obbOverlap}. */
const _mtv = new Float64Array(3);

/**
 * Separating-axis overlap test between two oriented rectangles on the XZ plane.
 * On overlap `_mtv` holds `[axisX, axisZ, depth]`, the push-out that separates
 * box A from box B.
 * @param {number} ax Centre x of A.
 * @param {number} az Centre z of A.
 * @param {number} ahx Half extent of A along its local X.
 * @param {number} ahz Half extent of A along its local Z.
 * @param {number} arot Rotation of A in radians.
 * @param {number} bx Centre x of B.
 * @param {number} bz Centre z of B.
 * @param {number} bhx Half extent of B along its local X.
 * @param {number} bhz Half extent of B along its local Z.
 * @param {number} brot Rotation of B in radians.
 * @param {number} margin Extra clearance added to both boxes.
 * @returns {boolean} True when the rectangles overlap.
 */
function obbOverlap(ax, az, ahx, ahz, arot, bx, bz, bhx, bhz, brot, margin) {
  const ca = Math.cos(arot);
  const sa = Math.sin(arot);
  const cb = Math.cos(brot);
  const sb = Math.sin(brot);
  _satAx[0] = ca; _satAx[1] = sa;
  _satAz[0] = -sa; _satAz[1] = ca;
  _satBx[0] = cb; _satBx[1] = sb;
  _satBz[0] = -sb; _satBz[1] = cb;
  const AHX = ahx + margin;
  const AHZ = ahz + margin;
  const BHX = bhx + margin;
  const BHZ = bhz + margin;
  const dx = bx - ax;
  const dz = bz - az;
  let bestDepth = Infinity;
  let bestX = 0;
  let bestZ = 0;
  for (let i = 0; i < 4; i++) {
    const axis = i === 0 ? _satAx : i === 1 ? _satAz : i === 2 ? _satBx : _satBz;
    const nx = axis[0];
    const nz = axis[1];
    const ra = AHX * Math.abs(nx * _satAx[0] + nz * _satAx[1]) +
      AHZ * Math.abs(nx * _satAz[0] + nz * _satAz[1]);
    const rb = BHX * Math.abs(nx * _satBx[0] + nz * _satBx[1]) +
      BHZ * Math.abs(nx * _satBz[0] + nz * _satBz[1]);
    const d = nx * dx + nz * dz;
    const overlap = ra + rb - Math.abs(d);
    if (overlap <= 0) return false;
    if (overlap < bestDepth) {
      bestDepth = overlap;
      const s = d >= 0 ? -1 : 1;
      bestX = nx * s;
      bestZ = nz * s;
    }
  }
  _mtv[0] = bestX;
  _mtv[1] = bestZ;
  _mtv[2] = bestDepth;
  return true;
}

/**
 * Uniform spatial hash over the XZ plane. Stores arbitrary items registered by
 * their axis-aligned bounds; queries return de-duplicated candidates.
 */
class Grid2D {
  /**
   * @param {number} minX World min x.
   * @param {number} minZ World min z.
   * @param {number} maxX World max x.
   * @param {number} maxZ World max z.
   * @param {number} cell Cell size in metres.
   */
  constructor(minX, minZ, maxX, maxZ, cell) {
    this.minX = minX;
    this.minZ = minZ;
    this.cell = cell;
    this.nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
    this.nz = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 1);
    /** @type {Array<number[]|null>} */
    this.cells = new Array(this.nx * this.nz).fill(null);
    /** @type {any[]} */
    this.items = [];
    this.stamp = new Int32Array(0);
    this.tick = 0;
  }

  /**
   * Registers an item covering an axis-aligned rectangle.
   * @param {number} minx Rect min x.
   * @param {number} minz Rect min z.
   * @param {number} maxx Rect max x.
   * @param {number} maxz Rect max z.
   * @param {any} item Payload.
   * @returns {number} Item index.
   */
  insert(minx, minz, maxx, maxz, item) {
    const id = this.items.length;
    this.items.push(item);
    const i0 = clamp(Math.floor((minx - this.minX) / this.cell), 0, this.nx - 1);
    const i1 = clamp(Math.floor((maxx - this.minX) / this.cell), 0, this.nx - 1);
    const j0 = clamp(Math.floor((minz - this.minZ) / this.cell), 0, this.nz - 1);
    const j1 = clamp(Math.floor((maxz - this.minZ) / this.cell), 0, this.nz - 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * this.nx + i;
        let arr = this.cells[k];
        if (arr === null) {
          arr = [];
          this.cells[k] = arr;
        }
        arr.push(id);
      }
    }
    return id;
  }

  /**
   * Collects the items whose cells intersect a rectangle.
   * @param {number} minx Rect min x.
   * @param {number} minz Rect min z.
   * @param {number} maxx Rect max x.
   * @param {number} maxz Rect max z.
   * @param {any[]} out Array cleared and filled with payloads.
   * @returns {any[]} `out`.
   */
  query(minx, minz, maxx, maxz, out) {
    out.length = 0;
    if (this.stamp.length < this.items.length) {
      const next = new Int32Array(Math.max(64, this.items.length * 2));
      next.set(this.stamp);
      this.stamp = next;
    }
    this.tick++;
    const i0 = clamp(Math.floor((minx - this.minX) / this.cell), 0, this.nx - 1);
    const i1 = clamp(Math.floor((maxx - this.minX) / this.cell), 0, this.nx - 1);
    const j0 = clamp(Math.floor((minz - this.minZ) / this.cell), 0, this.nz - 1);
    const j1 = clamp(Math.floor((maxz - this.minZ) / this.cell), 0, this.nz - 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const arr = this.cells[j * this.nx + i];
        if (arr === null) continue;
        for (let n = 0; n < arr.length; n++) {
          const id = arr[n];
          if (this.stamp[id] === this.tick) continue;
          this.stamp[id] = this.tick;
          out.push(this.items[id]);
        }
      }
    }
    return out;
  }
}

/**
 * Inserts an oriented box into a {@link Grid2D} using its AABB.
 * @param {Grid2D} grid Target grid.
 * @param {{x:number,z:number,hx:number,hz:number,rot:number}} box Oriented box.
 * @returns {void}
 */
function insertBox(grid, box) {
  const c = Math.abs(Math.cos(box.rot));
  const s = Math.abs(Math.sin(box.rot));
  const ex = box.hx * c + box.hz * s;
  const ez = box.hx * s + box.hz * c;
  grid.insert(box.x - ex, box.z - ez, box.x + ex, box.z + ez, box);
}

/* ------------------------------------------------------------------ *
 * Phase 1 — street layout
 * ------------------------------------------------------------------ */

/**
 * Computes road widths and centre-line positions, then centres the block grid
 * on the world origin.
 * @param {object} ctx Generation context.
 * @returns {void}
 */
function buildLayout(ctx) {
  const { blocksX, blocksZ, blockSize, roadWidth } = ctx;
  ctx.avenueX = new Set();
  ctx.avenueZ = new Set();
  // Two north-south avenues and one east-west avenue, evenly spread and never
  // on the perimeter so they always cross the whole city.
  ctx.avenueX.add(Math.max(1, Math.round(blocksX * 0.29)));
  ctx.avenueX.add(Math.max(2, Math.round(blocksX * 0.79)));
  ctx.avenueZ.add(Math.max(1, Math.round(blocksZ * 0.5)));

  const roadWX = new Array(blocksX + 1);
  const roadWZ = new Array(blocksZ + 1);
  for (let i = 0; i <= blocksX; i++) roadWX[i] = ctx.avenueX.has(i) ? AVENUE_WIDTH : roadWidth;
  for (let j = 0; j <= blocksZ; j++) roadWZ[j] = ctx.avenueZ.has(j) ? AVENUE_WIDTH : roadWidth;

  const xRoad = new Array(blocksX + 1);
  const zRoad = new Array(blocksZ + 1);
  xRoad[0] = roadWX[0] * 0.5;
  for (let i = 1; i <= blocksX; i++) {
    xRoad[i] = xRoad[i - 1] + roadWX[i - 1] * 0.5 + blockSize + roadWX[i] * 0.5;
  }
  zRoad[0] = roadWZ[0] * 0.5;
  for (let j = 1; j <= blocksZ; j++) {
    zRoad[j] = zRoad[j - 1] + roadWZ[j - 1] * 0.5 + blockSize + roadWZ[j] * 0.5;
  }
  const spanX = xRoad[blocksX] + roadWX[blocksX] * 0.5;
  const spanZ = zRoad[blocksZ] + roadWZ[blocksZ] * 0.5;
  for (let i = 0; i <= blocksX; i++) xRoad[i] -= spanX * 0.5;
  for (let j = 0; j <= blocksZ; j++) zRoad[j] -= spanZ * 0.5;

  ctx.roadWX = roadWX;
  ctx.roadWZ = roadWZ;
  ctx.xRoad = xRoad;
  ctx.zRoad = zRoad;
  ctx.gridMinX = xRoad[0] - roadWX[0] * 0.5;
  ctx.gridMaxX = xRoad[blocksX] + roadWX[blocksX] * 0.5;
  ctx.gridMinZ = zRoad[0] - roadWZ[0] * 0.5;
  ctx.gridMaxZ = zRoad[blocksZ] + roadWZ[blocksZ] * 0.5;

  // The sea occupies the south and east margins; the north and west get a thin
  // service fringe so the perimeter roads are never flush with the bounds.
  const outer = ctx.seaSide ? WATERFRONT_SETOUT + 74 : 40;
  ctx.bounds = {
    min: [ctx.gridMinX - 40, ctx.gridMinZ - 40],
    max: [ctx.gridMaxX + outer, ctx.gridMaxZ + outer]
  };
  ctx.shoreZ = ctx.gridMaxZ + (WATERFRONT_SETOUT - ctx.roadWZ[blocksZ] * 0.5) + 26;
  ctx.shoreX = ctx.gridMaxX + (WATERFRONT_SETOUT - ctx.roadWX[blocksX] * 0.5) + 26;
}

/**
 * Chooses the diagonal boulevard path and the merged superblocks (park,
 * stadium, rail yard, plaza). Superblocks never swallow a boulevard node.
 * @param {object} ctx Generation context.
 * @returns {void}
 */
function buildSuperblocks(ctx) {
  const { blocksX, blocksZ } = ctx;

  // Diagonal boulevard: a 1:1 staircase of grid intersections, so every corner
  // it touches is a real node and the lane graph stitches together naturally.
  const startI = clamp(Math.round(blocksX * 0.14), 1, blocksX - 3);
  const steps = Math.min(blocksX - startI, blocksZ);
  /** @type {number[][]} */
  ctx.diagNodes = [];
  for (let k = 0; k <= steps; k++) ctx.diagNodes.push([startI + k, k]);
  ctx.diagBlocks = new Set();
  for (let k = 0; k < steps; k++) ctx.diagBlocks.add((startI + k) * 1000 + k);

  ctx.blockOwner = [];
  for (let i = 0; i < blocksX; i++) {
    ctx.blockOwner.push(new Array(blocksZ).fill(-1));
  }
  ctx.superblocks = [];

  /**
   * Attempts to merge a rectangle of blocks into a superblock.
   * @param {number} i0 First block column.
   * @param {number} j0 First block row.
   * @param {number} w Width in blocks.
   * @param {number} h Height in blocks.
   * @param {string} kind Superblock kind.
   * @param {string} name Korean display name.
   * @returns {number} Superblock index, or -1 when rejected.
   */
  const tryAdd = (i0, j0, w, h, kind, name) => {
    const i1 = i0 + w - 1;
    const j1 = j0 + h - 1;
    if (i0 < 0 || j0 < 0 || i1 >= blocksX || j1 >= blocksZ) return -1;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        if (ctx.blockOwner[i][j] !== -1) return -1;
        if (ctx.diagBlocks.has(i * 1000 + j)) return -1;
      }
    }
    const idx = ctx.superblocks.length;
    ctx.superblocks.push({ index: idx, i0, j0, i1, j1, kind, name });
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) ctx.blockOwner[i][j] = idx;
    }
    return idx;
  };

  ctx.sbPark = tryAdd(Math.round(blocksX * 0.14), Math.round(blocksZ * 0.57), 2, 2, 'park', '네온 공원');
  ctx.sbStadium = tryAdd(Math.round(blocksX * 0.64), Math.max(1, Math.round(blocksZ * 0.07)), 2, 2, 'stadium', '스타디움');
  ctx.sbRail = tryAdd(Math.round(blocksX * 0.71), blocksZ - 2, 2, 2, 'railyard', '차량기지');
  ctx.sbPlaza = tryAdd(Math.round(blocksX * 0.5), Math.round(blocksZ * 0.43), 1, 1, 'plaza', '중앙 광장');
  ctx.sbMarket = tryAdd(Math.round(blocksX * 0.21), Math.round(blocksZ * 0.21), 1, 1, 'plaza', '북부 시장');
  ctx.sbParking = tryAdd(Math.round(blocksX * 0.79), Math.round(blocksZ * 0.5), 1, 1, 'parking', '중앙 주차장');
}

/**
 * Builds the intersection nodes and the undirected road-edge graph: grid
 * streets and avenues, the diagonal boulevard, the curved waterfront road and
 * its connectors.
 * @param {object} ctx Generation context.
 * @returns {void}
 */
function buildNodesAndEdges(ctx) {
  const { blocksX, blocksZ, xRoad, zRoad, roadWX, roadWZ } = ctx;

  // --- segment existence -------------------------------------------------
  const segH = [];
  for (let j = 0; j <= blocksZ; j++) segH.push(new Array(blocksX).fill(true));
  const segV = [];
  for (let i = 0; i <= blocksX; i++) segV.push(new Array(blocksZ).fill(true));
  for (const sb of ctx.superblocks) {
    for (let i = sb.i0 + 1; i <= sb.i1; i++) {
      for (let j = sb.j0; j <= sb.j1; j++) segV[i][j] = false;
    }
    for (let j = sb.j0 + 1; j <= sb.j1; j++) {
      for (let i = sb.i0; i <= sb.i1; i++) segH[j][i] = false;
    }
  }
  ctx.segH = segH;
  ctx.segV = segV;

  ctx.nodes = [];
  ctx.edges = [];

  /**
   * Adds an intersection node.
   * @param {number} x World x.
   * @param {number} z World z.
   * @returns {number} Node id.
   */
  const addNode = (x, z) => {
    const id = ctx.nodes.length;
    ctx.nodes.push({ id, x, z, roads: [], hasTrafficLight: false, edges: [] });
    return id;
  };
  ctx.addNode = addNode;

  /**
   * Adds a road edge between two nodes.
   * @param {number} a Node id A.
   * @param {number} b Node id B.
   * @param {number[][]} pts Polyline from A to B (endpoints included).
   * @param {string} kind 'street'|'avenue'|'boulevard'|'waterfront'|'link'.
   * @param {number} width Carriageway width.
   * @param {number} lanesPerDir Lanes per travel direction.
   * @param {number} speed Speed limit in m/s.
   * @returns {object} The edge.
   */
  const addEdge = (a, b, pts, kind, width, lanesPerDir, speed) => {
    const e = {
      id: ctx.edges.length, a, b, pts, kind, width, lanesPerDir, speed,
      fwdLanes: [], bwdLanes: [], roadIds: []
    };
    ctx.edges.push(e);
    ctx.nodes[a].edges.push(e.id);
    ctx.nodes[b].edges.push(e.id);
    return e;
  };
  ctx.addEdge = addEdge;

  // --- grid nodes --------------------------------------------------------
  const gridNode = [];
  for (let i = 0; i <= blocksX; i++) gridNode.push(new Array(blocksZ + 1).fill(-1));
  for (let i = 0; i <= blocksX; i++) {
    for (let j = 0; j <= blocksZ; j++) {
      const west = i > 0 && segH[j][i - 1];
      const east = i < blocksX && segH[j][i];
      const north = j > 0 && segV[i][j - 1];
      const south = j < blocksZ && segV[i][j];
      if (west || east || north || south) gridNode[i][j] = addNode(xRoad[i], zRoad[j]);
    }
  }
  ctx.gridNode = gridNode;

  // --- grid edges --------------------------------------------------------
  for (let j = 0; j <= blocksZ; j++) {
    const avenue = ctx.avenueZ.has(j);
    for (let i = 0; i < blocksX; i++) {
      if (!segH[j][i]) continue;
      const a = gridNode[i][j];
      const b = gridNode[i + 1][j];
      if (a < 0 || b < 0) continue;
      addEdge(a, b, [[xRoad[i], zRoad[j]], [xRoad[i + 1], zRoad[j]]],
        avenue ? 'avenue' : 'street', roadWZ[j], avenue ? 3 : 1,
        avenue ? SPEED_AVENUE : SPEED_STREET);
    }
  }
  for (let i = 0; i <= blocksX; i++) {
    const avenue = ctx.avenueX.has(i);
    for (let j = 0; j < blocksZ; j++) {
      if (!segV[i][j]) continue;
      const a = gridNode[i][j];
      const b = gridNode[i][j + 1];
      if (a < 0 || b < 0) continue;
      addEdge(a, b, [[xRoad[i], zRoad[j]], [xRoad[i], zRoad[j + 1]]],
        avenue ? 'avenue' : 'street', roadWX[i], avenue ? 3 : 1,
        avenue ? SPEED_AVENUE : SPEED_STREET);
    }
  }

  // --- diagonal boulevard ------------------------------------------------
  ctx.boulevardEdges = [];
  for (let k = 0; k + 1 < ctx.diagNodes.length; k++) {
    const [i0, j0] = ctx.diagNodes[k];
    const [i1, j1] = ctx.diagNodes[k + 1];
    if (i1 > blocksX || j1 > blocksZ) break;
    const a = gridNode[i0][j0];
    const b = gridNode[i1][j1];
    if (a < 0 || b < 0) continue;
    const e = addEdge(a, b, [[xRoad[i0], zRoad[j0]], [xRoad[i1], zRoad[j1]]],
      'boulevard', BOULEVARD_WIDTH, 3, SPEED_BOULEVARD);
    ctx.boulevardEdges.push(e.id);
  }

  // --- curved waterfront road + connectors -------------------------------
  ctx.waterfrontEdges = [];
  ctx.waterfrontNodes = [];
  if (!ctx.seaSide) return;

  const outZ = ctx.gridMaxZ + WATERFRONT_SETOUT - roadWZ[blocksZ] * 0.5;
  const outX = ctx.gridMaxX + WATERFRONT_SETOUT - roadWX[blocksX] * 0.5;
  /** @type {Array<{x:number,z:number,grid:number}>} */
  const wf = [];
  for (let i = 0; i <= blocksX; i += 2) {
    if (gridNode[i][blocksZ] < 0) continue;
    wf.push({
      x: xRoad[i],
      z: outZ + 9 * Math.sin(i * 0.72 + 1.3),
      grid: gridNode[i][blocksZ]
    });
  }
  if (gridNode[blocksX][blocksZ] >= 0) {
    wf.push({ x: outX, z: outZ, grid: gridNode[blocksX][blocksZ] });
  }
  for (let j = blocksZ - 2; j >= 0; j -= 2) {
    if (gridNode[blocksX][j] < 0) continue;
    wf.push({
      x: outX + 9 * Math.sin(j * 0.72 + 2.1),
      z: zRoad[j],
      grid: gridNode[blocksX][j]
    });
  }

  const wfIds = [];
  for (const w of wf) {
    const id = addNode(w.x, w.z);
    wfIds.push(id);
    ctx.waterfrontNodes.push(id);
  }
  // Smooth the chain with Catmull-Rom so the promenade genuinely curves.
  const tmp = [0, 0];
  for (let k = 0; k + 1 < wf.length; k++) {
    const p0 = wf[Math.max(0, k - 1)];
    const p1 = wf[k];
    const p2 = wf[k + 1];
    const p3 = wf[Math.min(wf.length - 1, k + 2)];
    const a0 = [p0.x, p0.z];
    const a1 = [p1.x, p1.z];
    const a2 = [p2.x, p2.z];
    const a3 = [p3.x, p3.z];
    const pts = [[p1.x, p1.z]];
    for (let s = 1; s <= 3; s++) {
      catmullRom(a0, a1, a2, a3, s / 4, tmp);
      pts.push([tmp[0], tmp[1]]);
    }
    pts.push([p2.x, p2.z]);
    const e = addEdge(wfIds[k], wfIds[k + 1], pts, 'waterfront',
      WATERFRONT_WIDTH, 2, SPEED_WATERFRONT);
    ctx.waterfrontEdges.push(e.id);
  }
  for (let k = 0; k < wf.length; k++) {
    const g = ctx.nodes[wf[k].grid];
    const e = addEdge(wf[k].grid, wfIds[k], [[g.x, g.z], [wf[k].x, wf[k].z]],
      'link', ctx.roadWidth, 1, SPEED_STREET);
    ctx.waterfrontEdges.push(e.id);
  }
}

/**
 * Classifies every block, then merges the classification into a
 * non-overlapping list of rectangular districts with Korean names.
 * @param {object} ctx Generation context.
 * @returns {void}
 */
function buildDistricts(ctx) {
  const { blocksX, blocksZ } = ctx;
  const indI0 = Math.round(blocksX * 0.71);
  const indJ0 = Math.round(blocksZ * 0.64);
  const downR = blocksX * 0.185;
  const midR = blocksX * 0.325;
  const cx = (blocksX - 1) / 2;
  const cz = (blocksZ - 1) / 2;

  const kinds = [];
  for (let i = 0; i < blocksX; i++) {
    kinds.push(new Array(blocksZ).fill('residential'));
    for (let j = 0; j < blocksZ; j++) {
      const owner = ctx.blockOwner[i][j];
      const sb = owner >= 0 ? ctx.superblocks[owner] : null;
      let kind;
      if (sb && sb.kind === 'park') {
        kind = 'park';
      } else if (sb && sb.kind === 'railyard') {
        kind = 'industrial';
      } else if (i >= indI0 && j >= indJ0) {
        kind = 'industrial';
      } else if (ctx.seaSide && ((j === blocksZ - 1 && i < indI0) || (i === blocksX - 1 && j < indJ0))) {
        kind = 'beach';
      } else {
        const r = Math.max(Math.abs(i - cx), Math.abs(j - cz));
        kind = r <= downR ? 'downtown' : r <= midR ? 'midtown' : 'residential';
      }
      kinds[i][j] = kind;
    }
  }
  ctx.blockKinds = kinds;

  // Greedy maximal-rectangle merge -> a clean partition of the block grid.
  const used = [];
  for (let i = 0; i < blocksX; i++) used.push(new Array(blocksZ).fill(false));
  ctx.districts = [];
  ctx.blockDistrict = [];
  for (let i = 0; i < blocksX; i++) ctx.blockDistrict.push(new Array(blocksZ).fill(0));
  const counters = {};
  for (let j = 0; j < blocksZ; j++) {
    for (let i = 0; i < blocksX; i++) {
      if (used[i][j]) continue;
      const kind = kinds[i][j];
      let i1 = i;
      while (i1 + 1 < blocksX && !used[i1 + 1][j] && kinds[i1 + 1][j] === kind) i1++;
      let j1 = j;
      for (let jj = j + 1; jj < blocksZ; jj++) {
        let ok = true;
        for (let ii = i; ii <= i1; ii++) {
          if (used[ii][jj] || kinds[ii][jj] !== kind) { ok = false; break; }
        }
        if (!ok) break;
        j1 = jj;
      }
      for (let ii = i; ii <= i1; ii++) {
        for (let jj = j; jj <= j1; jj++) used[ii][jj] = true;
      }
      const id = ctx.districts.length;
      counters[kind] = (counters[kind] || 0) + 1;
      const n = counters[kind];
      const x0 = i === 0 ? ctx.bounds.min[0] : ctx.xRoad[i];
      const x1 = i1 === blocksX - 1 ? ctx.bounds.max[0] : ctx.xRoad[i1 + 1];
      const z0 = j === 0 ? ctx.bounds.min[1] : ctx.zRoad[j];
      const z1 = j1 === blocksZ - 1 ? ctx.bounds.max[1] : ctx.zRoad[j1 + 1];
      ctx.districts.push({
        id,
        name: n === 1 ? DISTRICT_NAMES[kind] : DISTRICT_NAMES[kind] + ' ' + n,
        kind,
        rect: {
          x: x0, z: z0, w: x1 - x0, d: z1 - z0,
          x0, z0, x1, z1, cx: (x0 + x1) * 0.5, cz: (z0 + z1) * 0.5
        },
        palette: PALETTES[kind].wall.map((c) => [c[0], c[1], c[2]]),
        blocks: { i0: i, j0: j, i1, j1 }
      });
      for (let ii = i; ii <= i1; ii++) {
        for (let jj = j; jj <= j1; jj++) ctx.blockDistrict[ii][jj] = id;
      }
    }
  }
}
