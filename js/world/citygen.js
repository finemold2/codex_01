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
  /** @type {Array<{x:number,z:number,grid:number,side:string,bi:number}>} */
  const wf = [];
  for (let i = 0; i <= blocksX; i += 2) {
    if (gridNode[i][blocksZ] < 0) continue;
    wf.push({
      x: xRoad[i],
      z: outZ + 9 * Math.sin(i * 0.72 + 1.3),
      grid: gridNode[i][blocksZ],
      side: 'south',
      bi: i
    });
  }
  if (gridNode[blocksX][blocksZ] >= 0) {
    wf.push({ x: outX, z: outZ, grid: gridNode[blocksX][blocksZ], side: 'corner', bi: blocksX });
  }
  for (let j = blocksZ - 2; j >= 0; j -= 2) {
    if (gridNode[blocksX][j] < 0) continue;
    wf.push({
      x: outX + 9 * Math.sin(j * 0.72 + 2.1),
      z: zRoad[j],
      grid: gridNode[blocksX][j],
      side: 'east',
      bi: j
    });
  }
  ctx.wfMeta = wf;

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

/* ------------------------------------------------------------------ *
 * Phase 2 — road rectangles and the keep-out index
 * ------------------------------------------------------------------ */

/**
 * Splits every edge polyline into straight road rectangles and fills two
 * spatial indices: the asphalt index (used by {@link isOnRoad}) and the
 * keep-out index (asphalt + sidewalk, used by building placement).
 * @param {object} ctx Generation context.
 * @returns {void}
 */
function buildRoads(ctx) {
  const b = ctx.bounds;
  ctx.roads = [];
  ctx.roadGrid = new Grid2D(b.min[0], b.min[1], b.max[0], b.max[1], HASH_CELL);
  ctx.blockGrid = new Grid2D(b.min[0], b.min[1], b.max[0], b.max[1], HASH_CELL);

  for (const e of ctx.edges) {
    for (let s = 0; s + 1 < e.pts.length; s++) {
      const p = e.pts[s];
      const q = e.pts[s + 1];
      const dx = q[0] - p[0];
      const dz = q[1] - p[1];
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      const rot = Math.atan2(dz, dx);
      const road = {
        id: ctx.roads.length,
        ax: p[0], az: p[1], bx: q[0], bz: q[1],
        width: e.width,
        axis: Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z',
        lanes: e.lanesPerDir * 2,
        lanesPerDir: e.lanesPerDir,
        kind: e.kind,
        edgeId: e.id,
        nodeA: e.a,
        nodeB: e.b
      };
      ctx.roads.push(road);
      e.roadIds.push(road.id);
      const cx = (p[0] + q[0]) * 0.5;
      const cz = (p[1] + q[1]) * 0.5;
      const grow = e.width * 0.5;
      insertBox(ctx.roadGrid, {
        x: cx, z: cz, hx: len * 0.5 + grow, hz: e.width * 0.5, rot, road
      });
      insertBox(ctx.blockGrid, {
        x: cx, z: cz, hx: len * 0.5 + grow, hz: e.width * 0.5 + SIDEWALK_W, rot, road
      });
    }
    ctx.nodes[e.a].roads.push(e.roadIds[0]);
    ctx.nodes[e.b].roads.push(e.roadIds[e.roadIds.length - 1]);
  }

  // Square asphalt pads so intersection corners also report as "on road".
  for (const n of ctx.nodes) {
    let half = 0;
    for (const eid of n.edges) half = Math.max(half, ctx.edges[eid].width * 0.5);
    if (half <= 0) continue;
    insertBox(ctx.roadGrid, { x: n.x, z: n.z, hx: half, hz: half, rot: 0, road: null });
  }
}

/* ------------------------------------------------------------------ *
 * Phase 3 — lots
 * ------------------------------------------------------------------ */

/**
 * Appends one lot.
 * @param {object} ctx Generation context.
 * @param {number} x0 Min x.
 * @param {number} z0 Min z.
 * @param {number} x1 Max x.
 * @param {number} z1 Max z.
 * @param {number} districtId District id.
 * @param {string} kind Lot kind.
 * @param {string} surface Surface hint for the renderer.
 * @returns {object} The lot.
 */
function pushLot(ctx, x0, z0, x1, z1, districtId, kind, surface) {
  const lot = {
    id: ctx.lots.length,
    districtId,
    x: (x0 + x1) * 0.5,
    z: (z0 + z1) * 0.5,
    w: x1 - x0,
    d: z1 - z0,
    kind,
    surface,
    x0, z0, x1, z1
  };
  ctx.lots.push(lot);
  return lot;
}

/**
 * Creates one lot per block / superblock plus the beach, sea and fringe lots.
 * @param {object} ctx Generation context.
 * @returns {void}
 */
function buildLots(ctx) {
  const { blocksX, blocksZ, xRoad, zRoad, roadWX, roadWZ } = ctx;
  const rng = new Rand(mixSeed(ctx.seed, 'lots'));
  ctx.lots = [];

  const bx0 = (i) => xRoad[i] + roadWX[i] * 0.5;
  const bx1 = (i) => xRoad[i + 1] - roadWX[i + 1] * 0.5;
  const bz0 = (j) => zRoad[j] + roadWZ[j] * 0.5;
  const bz1 = (j) => zRoad[j + 1] - roadWZ[j + 1] * 0.5;

  for (const sb of ctx.superblocks) {
    const districtId = ctx.blockDistrict[sb.i0][sb.j0];
    let kind = 'building';
    let surface = 'concrete';
    if (sb.kind === 'park') { kind = 'park'; surface = 'grass'; }
    else if (sb.kind === 'plaza') { kind = 'plaza'; surface = 'concrete'; }
    else if (sb.kind === 'railyard') { kind = 'parking'; surface = 'gravel'; }
    else if (sb.kind === 'parking') { kind = 'parking'; surface = 'asphalt'; }
    else if (sb.kind === 'stadium') { kind = 'building'; surface = 'concrete'; }
    const lot = pushLot(ctx, bx0(sb.i0), bz0(sb.j0), bx1(sb.i1), bz1(sb.j1),
      districtId, kind, surface);
    lot.superblock = sb.kind;
    lot.name = sb.name;
    sb.lotId = lot.id;
  }

  for (let i = 0; i < blocksX; i++) {
    for (let j = 0; j < blocksZ; j++) {
      if (ctx.blockOwner[i][j] !== -1) continue;
      const districtId = ctx.blockDistrict[i][j];
      const dk = ctx.districts[districtId].kind;
      let kind = 'building';
      let surface = 'concrete';
      const roll = rng.next();
      if (dk === 'industrial' && roll < 0.20) { kind = 'parking'; surface = 'asphalt'; }
      else if (dk === 'midtown' && roll < 0.06) { kind = 'parking'; surface = 'asphalt'; }
      else if (dk === 'residential' && roll < 0.07) { kind = 'park'; surface = 'grass'; }
      else if (dk === 'downtown' && roll < 0.05) { kind = 'plaza'; surface = 'concrete'; }
      else if (dk === 'beach' && roll < 0.14) { kind = 'park'; surface = 'sand'; }
      const lot = pushLot(ctx, bx0(i), bz0(j), bx1(i), bz1(j), districtId, kind, surface);
      lot.blockI = i;
      lot.blockJ = j;
    }
  }

  const b = ctx.bounds;
  // North and west fringe strips.
  const fringeNorth = ctx.districts[ctx.blockDistrict[Math.floor(blocksX / 2)][0]].id;
  const fringeWest = ctx.districts[ctx.blockDistrict[0][Math.floor(blocksZ / 2)]].id;
  pushLot(ctx, ctx.gridMinX, b.min[1], ctx.gridMaxX, ctx.gridMinZ, fringeNorth, 'park', 'grass');
  pushLot(ctx, b.min[0], b.min[1], ctx.gridMinX, ctx.gridMaxZ, fringeWest, 'park', 'grass');

  if (!ctx.seaSide) {
    pushLot(ctx, ctx.gridMaxX, b.min[1], b.max[0], ctx.gridMaxZ, fringeNorth, 'park', 'grass');
    pushLot(ctx, b.min[0], ctx.gridMaxZ, b.max[0], b.max[1], fringeWest, 'park', 'grass');
    ctx.waterLevel = null;
    return;
  }

  const beachSouth = ctx.districts[ctx.blockDistrict[Math.floor(blocksX / 2)][blocksZ - 1]].id;
  const beachEast = ctx.districts[ctx.blockDistrict[blocksX - 1][Math.floor(blocksZ / 2)]].id;
  pushLot(ctx, b.min[0], ctx.gridMaxZ, ctx.shoreX, ctx.shoreZ, beachSouth, 'park', 'sand');
  pushLot(ctx, ctx.gridMaxX, b.min[1], ctx.shoreX, ctx.gridMaxZ, beachEast, 'park', 'sand');
  pushLot(ctx, b.min[0], ctx.shoreZ, b.max[0], b.max[1], beachSouth, 'water', 'water');
  pushLot(ctx, ctx.shoreX, b.min[1], b.max[0], ctx.shoreZ, beachEast, 'water', 'water');
  ctx.waterLevel = WATER_LEVEL;
}

/* ------------------------------------------------------------------ *
 * Phase 4 — buildings
 * ------------------------------------------------------------------ */

/**
 * Recursively subdivides a lot into building cells separated by alleys.
 * @param {object} ctx Generation context.
 * @param {number[][]} cells Output array of `[x0, z0, x1, z1]`.
 * @param {object[]} alleys Output array of alley descriptors.
 * @param {number} x0 Min x.
 * @param {number} z0 Min z.
 * @param {number} x1 Max x.
 * @param {number} z1 Max z.
 * @param {number} target Target cell area in m².
 * @param {Rand} rng Random source.
 * @param {number} depth Current recursion depth.
 * @returns {void}
 */
function subdivide(ctx, cells, alleys, x0, z0, x1, z1, target, rng, depth) {
  const w = x1 - x0;
  const d = z1 - z0;
  if (w < 7 || d < 7) return;
  const area = w * d;
  if (depth >= 5 || area < target * rr(rng, 1.05, 1.9) || Math.min(w, d) < 13) {
    cells.push([x0, z0, x1, z1]);
    return;
  }
  const alley = rr(rng, 1.6, 3.4);
  if (w >= d) {
    const t = rr(rng, 0.36, 0.64);
    const xm = x0 + w * t;
    alleys.push({ x: xm, z: (z0 + z1) * 0.5, len: d, rot: Math.PI * 0.5, width: alley });
    subdivide(ctx, cells, alleys, x0, z0, xm - alley * 0.5, z1, target, rng, depth + 1);
    subdivide(ctx, cells, alleys, xm + alley * 0.5, z0, x1, z1, target, rng, depth + 1);
  } else {
    const t = rr(rng, 0.36, 0.64);
    const zm = z0 + d * t;
    alleys.push({ x: (x0 + x1) * 0.5, z: zm, len: w, rot: 0, width: alley });
    subdivide(ctx, cells, alleys, x0, z0, x1, zm - alley * 0.5, target, rng, depth + 1);
    subdivide(ctx, cells, alleys, x0, zm + alley * 0.5, x1, z1, target, rng, depth + 1);
  }
}

/** Scratch array reused by the overlap queries during building placement. */
const _hits = [];

/**
 * Tests a candidate footprint against roads, sidewalks and existing buildings.
 * @param {object} ctx Generation context.
 * @param {number} x Centre x.
 * @param {number} z Centre z.
 * @param {number} hx Half width.
 * @param {number} hz Half depth.
 * @param {number} rot Rotation.
 * @param {number} margin Clearance.
 * @returns {boolean} True when the footprint is free.
 */
function footprintFree(ctx, x, z, hx, hz, rot, margin) {
  const c = Math.abs(Math.cos(rot));
  const s = Math.abs(Math.sin(rot));
  const ex = hx * c + hz * s + margin + 1;
  const ez = hx * s + hz * c + margin + 1;
  ctx.blockGrid.query(x - ex, z - ez, x + ex, z + ez, _hits);
  for (let i = 0; i < _hits.length; i++) {
    const o = _hits[i];
    if (obbOverlap(x, z, hx, hz, rot, o.x, o.z, o.hx, o.hz, o.rot, margin)) return false;
  }
  ctx.buildingGrid.query(x - ex, z - ez, x + ex, z + ez, _hits);
  for (let i = 0; i < _hits.length; i++) {
    const o = _hits[i];
    if (obbOverlap(x, z, hx, hz, rot, o.x, o.z, o.hx, o.hz, o.rot, margin)) return false;
  }
  return true;
}

/**
 * Picks a building style for a district / footprint combination.
 * @param {string} dk District kind.
 * @param {number} area Footprint area.
 * @param {Rand} rng Random source.
 * @returns {string} One of the contract styles.
 */
function pickStyle(dk, area, rng) {
  const r = rng.next();
  switch (dk) {
    case 'downtown':
      if (area > 430) return r < 0.72 ? 'tower' : 'office';
      if (area > 190) return r < 0.45 ? 'office' : r < 0.75 ? 'tower' : 'apartment';
      return r < 0.7 ? 'shop' : 'office';
    case 'midtown':
      if (area > 380) return r < 0.5 ? 'office' : 'apartment';
      if (area > 150) return r < 0.4 ? 'apartment' : r < 0.75 ? 'office' : 'shop';
      return r < 0.75 ? 'shop' : 'apartment';
    case 'residential':
      if (area > 320) return r < 0.55 ? 'apartment' : 'house';
      return r < 0.62 ? 'house' : r < 0.86 ? 'shop' : 'apartment';
    case 'industrial':
      return r < 0.78 ? 'warehouse' : r < 0.92 ? 'office' : 'shop';
    case 'beach':
      return r < 0.5 ? 'house' : r < 0.86 ? 'shop' : 'apartment';
    default:
      return r < 0.5 ? 'shop' : 'house';
  }
}

/**
 * Roof shape for a style.
 * @param {string} style Building style.
 * @param {number} h Height in metres.
 * @param {Rand} rng Random source.
 * @returns {string} 'flat'|'hip'|'setback'|'dome'|'sawtooth'.
 */
function pickRoof(style, h, rng) {
  const r = rng.next();
  switch (style) {
    case 'tower': return h > 95 && r < 0.6 ? 'setback' : r < 0.12 ? 'dome' : 'flat';
    case 'warehouse': return r < 0.6 ? 'sawtooth' : 'flat';
    case 'house': return r < 0.82 ? 'hip' : 'flat';
    case 'apartment': return r < 0.14 ? 'hip' : 'flat';
    case 'office': return r < 0.1 ? 'setback' : 'flat';
    default: return r < 0.16 ? 'hip' : 'flat';
  }
}

/**
 * Builds the signage array for a building.
 * @param {object} ctx Generation context.
 * @param {object} bld Building record.
 * @param {string} dk District kind.
 * @param {Rand} rng Random source.
 * @returns {object[]} Sign descriptors.
 */
function makeSigns(ctx, bld, dk, rng) {
  const signs = [];
  const face = bld.face;
  const nx = face === 0 ? 1 : face === 2 ? -1 : 0;
  const nz = face === 1 ? 1 : face === 3 ? -1 : 0;
  const halfAlong = (face === 0 || face === 2) ? bld.d * 0.5 : bld.w * 0.5;
  const halfOut = (face === 0 || face === 2) ? bld.w * 0.5 : bld.d * 0.5;
  const sx = bld.x + nx * (halfOut + 0.12);
  const sz = bld.z + nz * (halfOut + 0.12);
  if (bld.style === 'shop' || (bld.style === 'apartment' && rchance(rng, 0.25))) {
    const w = Math.min(halfAlong * 1.5, rr(rng, 2.4, 4.6));
    signs.push({
      kind: 'shopfront',
      text: rpick(rng, SHOP_SIGNS),
      face, nx, nz,
      x: sx, z: sz,
      y: Math.min(bld.h - 0.9, 3.35),
      w, h: 1.0,
      color: rpick(rng, NEON_COLORS)
    });
    if (rchance(rng, 0.35) && bld.h > 7) {
      signs.push({
        kind: 'vertical',
        text: rpick(rng, SHOP_SIGNS),
        face, nx, nz,
        x: sx, z: sz,
        y: bld.h * 0.55,
        w: 1.1, h: Math.min(bld.h * 0.45, 6.5),
        color: rpick(rng, NEON_COLORS)
      });
    }
  }
  if ((bld.style === 'tower' || bld.style === 'office') && bld.h > 26 &&
      (dk === 'downtown' || dk === 'midtown') && rchance(rng, 0.42)) {
    signs.push({
      kind: 'roof',
      text: rpick(rng, TOWER_SIGNS),
      face, nx, nz,
      x: sx, z: sz,
      y: bld.h - 3.2,
      w: Math.min(halfAlong * 1.7, 12),
      h: 2.6,
      color: rpick(rng, NEON_COLORS)
    });
  }
  if (bld.style === 'warehouse' && rchance(rng, 0.3)) {
    signs.push({
      kind: 'shopfront',
      text: rpick(rng, ['제1창고', '제2창고', '냉동창고', '물류센터', '부두 창고']),
      face, nx, nz,
      x: sx, z: sz,
      y: Math.min(bld.h - 1.2, 5.2),
      w: Math.min(halfAlong * 1.4, 6.5),
      h: 1.2,
      color: [1.6, 1.5, 1.2]
    });
  }
  return signs;
}

/**
 * Fills every buildable lot with non-overlapping footprints, then promotes a
 * few downtown giants to landmark towers.
 * @param {object} ctx Generation context.
 * @returns {void}
 */
function buildBuildings(ctx) {
  const b = ctx.bounds;
  const rng = new Rand(mixSeed(ctx.seed, 'buildings'));
  ctx.buildings = [];
  ctx.alleys = [];
  ctx.buildingGrid = new Grid2D(b.min[0], b.min[1], b.max[0], b.max[1], HASH_CELL);
  ctx.maxRadius = Math.max(ctx.gridMaxX - ctx.gridMinX, ctx.gridMaxZ - ctx.gridMinZ) * 0.5;

  const targets = {
    downtown: 620, midtown: 360, residential: 200,
    industrial: 900, beach: 190, park: 260
  };
  const heights = {
    downtown: [60, 160], midtown: [25, 70], residential: [8, 20],
    industrial: [7, 15], beach: [6, 16], park: [5, 9]
  };

  for (const lot of ctx.lots) {
    if (lot.kind !== 'building') continue;
    const district = ctx.districts[lot.districtId];
    const dk = district.kind;
    const inset = SIDEWALK_W + BUILDING_SETBACK;
    const ux0 = lot.x0 + inset;
    const uz0 = lot.z0 + inset;
    const ux1 = lot.x1 - inset;
    const uz1 = lot.z1 - inset;
    if (ux1 - ux0 < 8 || uz1 - uz0 < 8) continue;

    if (lot.superblock === 'stadium') {
      makeStadium(ctx, lot, district, rng);
      continue;
    }

    const cells = [];
    const alleys = [];
    subdivide(ctx, cells, alleys, ux0, uz0, ux1, uz1, targets[dk] || 260, rng, 0);
    for (const a of alleys) {
      if (a.width >= 2.0) ctx.alleys.push(a);
    }

    for (const cell of cells) {
      const [cx0, cz0, cx1, cz1] = cell;
      const cw = cx1 - cx0;
      const cd = cz1 - cz0;
      if (cw < 7 || cd < 7) continue;
      const area = cw * cd;
      const style = pickStyle(dk, area, rng);

      let rot = 0;
      if ((style === 'house' || style === 'shop') && rchance(rng, 0.35)) rot = rr(rng, -0.05, 0.05);
      let w = cw * rr(rng, 0.80, 0.99);
      let d = cd * rr(rng, 0.80, 0.99);
      if (style === 'house') {
        w = Math.min(w, rr(rng, 9, 15));
        d = Math.min(d, rr(rng, 8, 14));
      } else if (style === 'warehouse') {
        w = Math.max(w, cw * 0.9);
        d = Math.max(d, cd * 0.9);
      }
      const ca = Math.abs(Math.cos(rot));
      const sa = Math.abs(Math.sin(rot));
      let ex = w * 0.5 * ca + d * 0.5 * sa;
      let ez = w * 0.5 * sa + d * 0.5 * ca;
      const fit = Math.min(1, (cw * 0.5) / ex, (cd * 0.5) / ez);
      w *= fit;
      d *= fit;
      ex *= fit;
      ez *= fit;
      const slackX = Math.max(0, cw * 0.5 - ex);
      const slackZ = Math.max(0, cd * 0.5 - ez);
      let px = (cx0 + cx1) * 0.5 + rr(rng, -1, 1) * slackX;
      let pz = (cz0 + cz1) * 0.5 + rr(rng, -1, 1) * slackZ;

      // Resolve against roads / neighbours: push out, then shrink, then drop.
      let placed = false;
      for (let attempt = 0; attempt < 7 && !placed; attempt++) {
        if (footprintFree(ctx, px, pz, w * 0.5, d * 0.5, rot, 0.25)) {
          placed = true;
          break;
        }
        if (attempt < 4) {
          // _mtv holds the push-out from the last reported overlap.
          const push = Math.min(_mtv[2] + 0.15, 6);
          px += _mtv[0] * push;
          pz += _mtv[1] * push;
          px = clamp(px, cx0 + ex, cx1 - ex);
          pz = clamp(pz, cz0 + ez, cz1 - ez);
        } else {
          w *= 0.82;
          d *= 0.82;
          ex *= 0.82;
          ez *= 0.82;
          if (w < 6 || d < 6) break;
        }
      }
      if (!placed) continue;

      const range = heights[dk] || [8, 20];
      const dc = clamp(Math.hypot(px, pz) / ctx.maxRadius, 0, 1);
      const n1 = noise2(px / 96, pz / 96, ctx.seed);
      const n2 = noise2(px / 31, pz / 31, ctx.seed + 7717);
      let t = clamp((1 - dc) * 0.55 + n1 * 0.32 + n2 * 0.18, 0, 1);
      if (style === 'house') t *= 0.45;
      if (style === 'shop') t = Math.min(t, 0.22);
      if (style === 'warehouse') t = Math.min(t, 0.4);
      let h = lerp(range[0], range[1], t);
      if (style === 'tower') h = Math.max(h, range[0] * 1.05);
      if (style === 'shop') h = clamp(h, 6.4, 11.5);
      if (style === 'house') h = clamp(h, 5.2, 11.0);
      if (style === 'warehouse') h = clamp(h, 6.5, 15);
      h = Math.round(h * 10) / 10;

      const pal = PALETTES[dk] || PALETTES.midtown;
      const lx = px - lot.x;
      const lz = pz - lot.z;
      const face = Math.abs(lx) >= Math.abs(lz) ? (lx >= 0 ? 0 : 2) : (lz >= 0 ? 1 : 3);
      const bld = {
        id: ctx.buildings.length,
        lotId: lot.id,
        x: px, z: pz, w, d, h,
        floors: Math.max(1, Math.round(h / FLOOR_HEIGHT)),
        style,
        rot,
        palette: {
          wall: rpick(rng, pal.wall).slice(),
          trim: rpick(rng, pal.trim).slice(),
          glass: rpick(rng, pal.glass).slice()
        },
        hasSetback: false,
        roofKind: pickRoof(style, h, rng),
        signs: [],
        face,
        districtId: lot.districtId
      };
      bld.hasSetback = bld.roofKind === 'setback' || (style === 'tower' && h > 110);
      bld.signs = makeSigns(ctx, bld, dk, rng);
      ctx.buildings.push(bld);
      insertBox(ctx.buildingGrid, { x: px, z: pz, hx: w * 0.5, hz: d * 0.5, rot, bld });
    }
  }

  promoteLandmarkTowers(ctx, rng);
}

/**
 * Places the single stadium volume inside its superblock lot.
 * @param {object} ctx Generation context.
 * @param {object} lot Stadium lot.
 * @param {object} district Owning district.
 * @param {Rand} rng Random source.
 * @returns {void}
 */
function makeStadium(ctx, lot, district, rng) {
  const w = lot.w - 26;
  const d = lot.d - 26;
  if (w < 20 || d < 20) return;
  if (!footprintFree(ctx, lot.x, lot.z, w * 0.5, d * 0.5, 0, 0.25)) return;
  const pal = PALETTES[district.kind] || PALETTES.midtown;
  const bld = {
    id: ctx.buildings.length,
    lotId: lot.id,
    x: lot.x, z: lot.z, w, d, h: 32,
    floors: Math.max(1, Math.round(32 / FLOOR_HEIGHT)),
    style: 'office',
    rot: 0,
    palette: {
      wall: rpick(rng, pal.wall).slice(),
      trim: [0.24, 0.24, 0.26],
      glass: rpick(rng, pal.glass).slice()
    },
    hasSetback: false,
    roofKind: 'dome',
    signs: [{
      kind: 'roof',
      text: '스타디움',
      face: 3, nx: 0, nz: -1,
      x: lot.x, z: lot.z - d * 0.5 - 0.12,
      y: 27,
      w: 14, h: 3.2,
      color: [3.6, 2.0, 0.35]
    }],
    face: 3,
    districtId: lot.districtId,
    landmark: true,
    name: '스타디움'
  };
  ctx.buildings.push(bld);
  insertBox(ctx.buildingGrid, { x: bld.x, z: bld.z, hx: w * 0.5, hz: d * 0.5, rot: 0, bld });
}

/**
 * Boosts the largest downtown footprints into signature skyline towers.
 * @param {object} ctx Generation context.
 * @param {Rand} rng Random source.
 * @returns {void}
 */
function promoteLandmarkTowers(ctx, rng) {
  const cands = [];
  for (const b of ctx.buildings) {
    if (b.style !== 'tower') continue;
    if (ctx.districts[b.districtId].kind !== 'downtown') continue;
    cands.push(b);
  }
  cands.sort((a, c) => (c.w * c.d) - (a.w * a.d) || a.id - c.id);
  const names = ['네온 타워', '오리온 빌딩', '천공 센터', '미래 은행 본점',
    '한강 트윈타워', '스타 미디어 본사'];
  ctx.landmarkTowers = [];
  for (let i = 0; i < Math.min(names.length, cands.length); i++) {
    const b = cands[i];
    b.h = Math.round(Math.min(192, Math.max(b.h * 1.28, 118 + i * 2)) * 10) / 10;
    b.floors = Math.max(1, Math.round(b.h / FLOOR_HEIGHT));
    b.hasSetback = true;
    b.roofKind = i === 0 ? 'setback' : (i % 3 === 0 ? 'dome' : 'setback');
    b.landmark = true;
    b.name = names[i];
    const halfOut = (b.face === 0 || b.face === 2) ? b.w * 0.5 : b.d * 0.5;
    const nx = b.face === 0 ? 1 : b.face === 2 ? -1 : 0;
    const nz = b.face === 1 ? 1 : b.face === 3 ? -1 : 0;
    b.signs.push({
      kind: 'roof',
      text: names[i],
      face: b.face, nx, nz,
      x: b.x + nx * (halfOut + 0.12),
      z: b.z + nz * (halfOut + 0.12),
      y: b.h - 4.5,
      w: Math.min(b.w, b.d) * 0.85,
      h: 3.4,
      color: rpick(rng, NEON_COLORS)
    });
    ctx.landmarkTowers.push(b);
  }
}

/* ------------------------------------------------------------------ *
 * Phase 5 — directed lane graph
 * ------------------------------------------------------------------ */

/** Scratch direction vectors used while stitching the graphs together. */
const _d0 = [0, 0];
const _d1 = [0, 0];
const _d2 = [0, 0];

/**
 * Distance a lane/sidewalk must keep from a node centre so it stops at the
 * kerb line of every crossing road (exact for perpendicular crossings).
 * @param {object} ctx Generation context.
 * @param {number} nodeId Node id.
 * @param {number} edgeId Edge being trimmed.
 * @param {number} dx Travel direction x at the node.
 * @param {number} dz Travel direction z at the node.
 * @param {number} extra Additional clearance (sidewalk offset for walks).
 * @returns {number} Trim distance in metres.
 */
function nodeTrim(ctx, nodeId, edgeId, dx, dz, extra) {
  const node = ctx.nodes[nodeId];
  let best = 0;
  for (let i = 0; i < node.edges.length; i++) {
    const fid = node.edges[i];
    if (fid === edgeId) continue;
    const f = ctx.edges[fid];
    let fx;
    let fz;
    if (f.a === nodeId) {
      polyStartDir(f.pts, _d2);
      fx = _d2[0];
      fz = _d2[1];
    } else {
      polyEndDir(f.pts, _d2);
      fx = -_d2[0];
      fz = -_d2[1];
    }
    const sn = Math.abs(dx * fz - dz * fx);
    if (sn < 0.4) continue;
    const t = (f.width * 0.5 + extra) / sn;
    if (t > best) best = t;
  }
  return best;
}

/**
 * Creates the two directed lane bundles of one edge.
 * @param {object} ctx Generation context.
 * @param {object} e Edge record.
 * @returns {void}
 */
function buildEdgeLanes(ctx, e) {
  const len = polyLength(e.pts);
  polyStartDir(e.pts, _d0);
  polyEndDir(e.pts, _d1);
  const capA = len * 0.42;
  const capB = len * 0.42;
  const trimA = Math.min(nodeTrim(ctx, e.a, e.id, _d0[0], _d0[1], 0), capA);
  const trimB = Math.min(nodeTrim(ctx, e.b, e.id, _d1[0], _d1[1], 0), capB);
  const L = e.lanesPerDir;
  const slot = e.width / (2 * L);
  const rev = e.pts.slice().reverse();

  for (let dir = 0; dir < 2; dir++) {
    const base = dir === 0 ? e.pts : rev;
    const ts = dir === 0 ? trimA : trimB;
    const te = dir === 0 ? trimB : trimA;
    for (let k = 0; k < L; k++) {
      const off = (k + 0.5) * slot;
      const line = polyTrim(polyOffset(base, off), ts, te);
      if (!line) continue;
      const lane = {
        id: ctx.lanes.length,
        pts: line,
        width: Math.min(slot, 3.8),
        next: [],
        nodeId: null,
        speedLimit: e.speed,
        oneWay: true,
        edgeId: e.id,
        index: k,
        offset: off,
        kind: e.kind,
        fromNode: dir === 0 ? e.a : e.b,
        toNode: dir === 0 ? e.b : e.a
      };
      ctx.lanes.push(lane);
      (dir === 0 ? e.fwdLanes : e.bwdLanes).push(lane.id);
    }
  }
}

/**
 * Connects an incoming lane to an outgoing lane, inserting a curved turn lane
 * through the intersection unless the two already meet.
 * @param {object} ctx Generation context.
 * @param {object} node Intersection node.
 * @param {object} inLane Incoming lane.
 * @param {object} outLane Outgoing lane.
 * @param {string} turn 'straight'|'left'|'right'|'uturn'.
 * @returns {void}
 */
function connectLanes(ctx, node, inLane, outLane, turn) {
  const p0 = inLane.pts[inLane.pts.length - 1];
  const p1 = outLane.pts[0];
  const gap = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  polyEndDir(inLane.pts, _d0);
  polyStartDir(outLane.pts, _d1);
  const cosang = _d0[0] * _d1[0] + _d0[1] * _d1[1];
  if (gap < 0.9 && cosang > 0.94) {
    if (inLane.next.indexOf(outLane.id) < 0) inLane.next.push(outLane.id);
    return;
  }
  const pts = bezierArc(p0, [_d0[0], _d0[1]], p1, [_d1[0], _d1[1]], 6);
  const lane = {
    id: ctx.lanes.length,
    pts,
    width: Math.min(inLane.width, outLane.width),
    next: [outLane.id],
    nodeId: node.id,
    speedLimit: turn === 'straight'
      ? Math.min(inLane.speedLimit, outLane.speedLimit)
      : Math.min(inLane.speedLimit, outLane.speedLimit, SPEED_TURN),
    oneWay: true,
    edgeId: -1,
    index: 0,
    offset: 0,
    kind: 'turn',
    turn,
    fromNode: node.id,
    toNode: outLane.toNode
  };
  ctx.lanes.push(lane);
  inLane.next.push(lane.id);
}

/**
 * Builds every lane and threads turn lanes through all intersections so that
 * `next` forms a strongly connected directed graph.
 * @param {object} ctx Generation context.
 * @returns {void}
 */
function buildLanes(ctx) {
  ctx.lanes = [];
  for (const e of ctx.edges) buildEdgeLanes(ctx, e);

  for (const node of ctx.nodes) {
    /** @type {object[]} */
    const app = [];
    for (const eid of node.edges) {
      const e = ctx.edges[eid];
      if (e.a === node.id) {
        polyStartDir(e.pts, _d2);
        app.push({
          e,
          inLanes: e.bwdLanes,
          outLanes: e.fwdLanes,
          inDir: [-_d2[0], -_d2[1]],
          outDir: [_d2[0], _d2[1]]
        });
      } else {
        polyEndDir(e.pts, _d2);
        app.push({
          e,
          inLanes: e.fwdLanes,
          outLanes: e.bwdLanes,
          inDir: [_d2[0], _d2[1]],
          outDir: [-_d2[0], -_d2[1]]
        });
      }
    }
    node.approaches = app.length;
    const dk = ctx.districts[districtIndexAt(ctx, node.x, node.z)];
    node.hasTrafficLight = app.length >= 4 ||
      (app.length === 3 && dk !== undefined && (dk.kind === 'downtown' || dk.kind === 'midtown'));

    for (let a = 0; a < app.length; a++) {
      const A = app[a];
      if (A.inLanes.length === 0) continue;
      for (let b = 0; b < app.length; b++) {
        if (b === a) continue;
        const B = app[b];
        if (B.outLanes.length === 0) continue;
        const cross = A.inDir[0] * B.outDir[1] - A.inDir[1] * B.outDir[0];
        const dot = A.inDir[0] * B.outDir[0] + A.inDir[1] * B.outDir[1];
        const ang = Math.atan2(cross, dot);
        const abs = Math.abs(ang);
        if (abs > 2.62 && app.length > 1) continue;   // no U-turns at real junctions
        const Lin = A.inLanes.length;
        const Lout = B.outLanes.length;
        if (abs <= 0.7) {
          for (let k = 0; k < Lin; k++) {
            const inLane = ctx.lanes[A.inLanes[k]];
            let prev = -1;
            for (let o = -1; o <= 1; o++) {
              const j = clamp(k + o, 0, Lout - 1);
              if (j === prev) continue;
              prev = j;
              connectLanes(ctx, node, inLane, ctx.lanes[B.outLanes[j]], 'straight');
            }
          }
        } else if (ang > 0) {
          connectLanes(ctx, node, ctx.lanes[A.inLanes[Lin - 1]],
            ctx.lanes[B.outLanes[Lout - 1]], 'right');
        } else {
          connectLanes(ctx, node, ctx.lanes[A.inLanes[0]],
            ctx.lanes[B.outLanes[0]], 'left');
        }
      }
    }

    // Dead ends (and any lane the rules above missed) get a U-turn so the
    // graph never traps a driver.
    for (let a = 0; a < app.length; a++) {
      const A = app[a];
      for (let k = 0; k < A.inLanes.length; k++) {
        const inLane = ctx.lanes[A.inLanes[k]];
        if (inLane.next.length > 0) continue;
        const j = Math.min(k, A.outLanes.length - 1);
        if (j < 0) continue;
        connectLanes(ctx, node, inLane, ctx.lanes[A.outLanes[j]], 'uturn');
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Phase 6 — pedestrian graph
 * ------------------------------------------------------------------ */

/**
 * Snaps a sidewalk endpoint onto one of a node's kerb corners, creating the
 * corner the first time it is seen.
 * @param {object} ctx Generation context.
 * @param {number} nodeId Node id.
 * @param {number} x Endpoint x.
 * @param {number} z Endpoint z.
 * @returns {number[]} The corner position `[x, z]` (shared instance).
 */
function snapCorner(ctx, nodeId, x, z) {
  let list = ctx.corners.get(nodeId);
  if (list === undefined) {
    list = [];
    ctx.corners.set(nodeId, list);
  }
  let best = null;
  let bestD = 16 * 16;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const dx = c[0] - x;
    const dz = c[1] - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  if (best !== null) return best;
  const c = [x, z];
  list.push(c);
  return c;
}

/**
 * Adds a forward/backward walk pair sharing one polyline.
 * @param {object} ctx Generation context.
 * @param {number[][]} pts Polyline.
 * @param {boolean} crossing True for a road crossing.
 * @param {number} nodeId Owning node id, or -1.
 * @param {number} edgeId Owning edge id, or -1.
 * @returns {void}
 */
function addWalkPair(ctx, pts, crossing, nodeId, edgeId) {
  if (pts.length < 2 || polyLength(pts) < 0.6) return;
  const a = {
    id: ctx.walks.length,
    pts,
    next: [],
    crossing,
    width: SIDEWALK_W,
    nodeId,
    edgeId,
    twin: ctx.walks.length + 1
  };
  ctx.walks.push(a);
  const rev = pts.slice().reverse();
  const b = {
    id: ctx.walks.length,
    pts: rev,
    next: [],
    crossing,
    width: SIDEWALK_W,
    nodeId,
    edgeId,
    twin: a.id
  };
  ctx.walks.push(b);
}

/**
 * Builds sidewalk centre lines on both sides of every road plus the crossings
 * that link the kerb corners of each intersection, then wires `next`.
 * @param {object} ctx Generation context.
 * @returns {void}
 */
function buildWalks(ctx) {
  ctx.walks = [];
  ctx.corners = new Map();

  // Grid streets first so their exact kerb corners seed every cluster.
  const order = [];
  for (const e of ctx.edges) if (e.kind === 'street' || e.kind === 'avenue') order.push(e);
  for (const e of ctx.edges) if (e.kind !== 'street' && e.kind !== 'avenue') order.push(e);

  for (const e of order) {
    const len = polyLength(e.pts);
    polyStartDir(e.pts, _d0);
    polyEndDir(e.pts, _d1);
    const trimA = Math.min(nodeTrim(ctx, e.a, e.id, _d0[0], _d0[1], WALK_OFFSET), len * 0.45);
    const trimB = Math.min(nodeTrim(ctx, e.b, e.id, _d1[0], _d1[1], WALK_OFFSET), len * 0.45);
    for (let side = 0; side < 2; side++) {
      const off = (side === 0 ? 1 : -1) * (e.width * 0.5 + WALK_OFFSET);
      const line = polyTrim(polyOffset(e.pts, off), trimA, trimB);
      if (!line) continue;
      const c0 = snapCorner(ctx, e.a, line[0][0], line[0][1]);
      const c1 = snapCorner(ctx, e.b, line[line.length - 1][0], line[line.length - 1][1]);
      line[0] = [c0[0], c0[1]];
      line[line.length - 1] = [c1[0], c1[1]];
      addWalkPair(ctx, line, false, -1, e.id);
    }
  }

  // Crossings: link kerb corners that are neighbours around the intersection.
  const scratch = [];
  for (const node of ctx.nodes) {
    const list = ctx.corners.get(node.id);
    if (list === undefined || list.length < 2) continue;
    scratch.length = 0;
    for (const c of list) {
      scratch.push({ c, a: Math.atan2(c[1] - node.z, c[0] - node.x) });
    }
    scratch.sort((p, q) => p.a - q.a);
    const n = scratch.length;
    const limit = n === 2 ? 1 : n;
    for (let i = 0; i < limit; i++) {
      const p = scratch[i].c;
      const q = scratch[(i + 1) % n].c;
      const dist = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (dist < 1 || dist > 72) continue;
      const mx = (p[0] + q[0]) * 0.5;
      const mz = (p[1] + q[1]) * 0.5;
      const crossing = pointOnRoadRects(ctx, mx, mz);
      addWalkPair(ctx, [[p[0], p[1]], [mx, mz], [q[0], q[1]]], crossing, node.id, -1);
    }
  }

  // Wire the graph by exact endpoint identity.
  /** @type {Map<string, number[]>} */
  const starts = new Map();
  for (const w of ctx.walks) {
    const k = walkKey(w.pts[0]);
    let arr = starts.get(k);
    if (arr === undefined) {
      arr = [];
      starts.set(k, arr);
    }
    arr.push(w.id);
  }
  for (const w of ctx.walks) {
    const arr = starts.get(walkKey(w.pts[w.pts.length - 1]));
    if (arr === undefined) {
      w.next.push(w.twin);
      continue;
    }
    for (let i = 0; i < arr.length; i++) {
      const id = arr[i];
      if (id === w.id || id === w.twin) continue;
      w.next.push(id);
    }
    if (w.next.length === 0) w.next.push(w.twin);
  }
}

/**
 * Hash key for an endpoint, quantised to a millimetre.
 * @param {number[]} p Point `[x, z]`.
 * @returns {string} Map key.
 */
function walkKey(p) {
  return Math.round(p[0] * 1000) + '|' + Math.round(p[1] * 1000);
}

/**
 * Point-in-asphalt test against the generation-time road index.
 * @param {object} ctx Generation context.
 * @param {number} x World x.
 * @param {number} z World z.
 * @returns {boolean} True when the point lies on a carriageway.
 */
function pointOnRoadRects(ctx, x, z) {
  ctx.roadGrid.query(x - 0.1, z - 0.1, x + 0.1, z + 0.1, _hits);
  for (let i = 0; i < _hits.length; i++) {
    const o = _hits[i];
    if (obbOverlap(x, z, 0.05, 0.05, 0, o.x, o.z, o.hx, o.hz, o.rot, 0)) return true;
  }
  return false;
}

/**
 * Index of the district rectangle containing a point (falls back to the
 * nearest rectangle so points on the sea still resolve).
 * @param {object} ctx Generation context or built city.
 * @param {number} x World x.
 * @param {number} z World z.
 * @returns {number} District index.
 */
function districtIndexAt(ctx, x, z) {
  const ds = ctx.districts;
  let bestIdx = 0;
  let bestD = Infinity;
  for (let i = 0; i < ds.length; i++) {
    const r = ds[i].rect;
    if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) return i;
    const dx = x < r.x0 ? r.x0 - x : x > r.x1 ? x - r.x1 : 0;
    const dz = z < r.z0 ? r.z0 - z : z > r.z1 ? z - r.z1 : 0;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/* ------------------------------------------------------------------ *
 * Phase 7 — props
 * ------------------------------------------------------------------ */

/** Scratch point/direction pairs used while scattering props. */
const _pp = [0, 0];
const _pd = [0, 0];

/**
 * Samples a polyline at an absolute arc length.
 * @param {number[][]} pts Polyline.
 * @param {number} s Arc length in metres.
 * @param {number[]} outP Output position.
 * @param {number[]} outD Output unit direction.
 * @returns {void}
 */
function polyAt(pts, s, outP, outD) {
  let rem = s;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dz = pts[i][1] - pts[i - 1][1];
    const l = Math.hypot(dx, dz) || 1;
    if (rem <= l || i === pts.length - 1) {
      const k = clamp(rem / l, 0, 1);
      outP[0] = pts[i - 1][0] + dx * k;
      outP[1] = pts[i - 1][1] + dz * k;
      outD[0] = dx / l;
      outD[1] = dz / l;
      return;
    }
    rem -= l;
  }
  outP[0] = pts[0][0];
  outP[1] = pts[0][1];
  outD[0] = 0;
  outD[1] = 1;
}

/**
 * Appends a prop.
 * @param {object} ctx Generation context.
 * @param {string} type Prop type.
 * @param {number} x World x.
 * @param {number} y World y.
 * @param {number} z World z.
 * @param {number} rot Yaw in radians.
 * @param {number} scale Uniform scale.
 * @param {object|null} extra Type specific payload.
 * @returns {void}
 */
function addProp(ctx, type, x, y, z, rot, scale, extra) {
  ctx.props.push({ type, x, y, z, rot, scale, extra: extra || null });
}

/**
 * Scatters street furniture along one road edge.
 * @param {object} ctx Generation context.
 * @param {object} e Edge record.
 * @param {string} dk District kind at the edge midpoint.
 * @param {Rand} rng Random source.
 * @returns {void}
 */
function edgeFurniture(ctx, e, dk, rng) {
  const len = polyLength(e.pts);
  if (len < 12) return;
  const half = e.width * 0.5;
  const kerb = half + 1.35;
  const inner = half + 2.5;

  // Streetlights every ~24 m, alternating sides.
  let flip = 0;
  for (let s = 12; s < len - 10; s += 24) {
    polyAt(e.pts, s, _pp, _pd);
    const side = (flip++ % 2 === 0) ? 1 : -1;
    const rx = -_pd[1] * side;
    const rz = _pd[0] * side;
    addProp(ctx, 'streetlight', _pp[0] + rx * kerb, 0, _pp[1] + rz * kerb,
      yawFromDir(-rx, -rz), 1, { arm: e.kind === 'avenue' || e.kind === 'boulevard' ? 2 : 1 });
  }

  // Trees / palms.
  const treeType = dk === 'beach' || e.kind === 'waterfront' ? 'palm' : 'tree';
  const wantTrees = dk === 'residential' || dk === 'park' || dk === 'beach' ||
    e.kind === 'waterfront' || e.kind === 'boulevard' ||
    (dk === 'midtown' && e.kind === 'avenue');
  if (wantTrees) {
    for (let s = 9; s < len - 9; s += 17) {
      for (let side = -1; side <= 1; side += 2) {
        if (rng.next() < 0.22) continue;
        polyAt(e.pts, s, _pp, _pd);
        const rx = -_pd[1] * side;
        const rz = _pd[0] * side;
        addProp(ctx, treeType, _pp[0] + rx * inner, 0, _pp[1] + rz * inner,
          rr(rng, 0, Math.PI * 2), rr(rng, 0.82, 1.28), null);
      }
    }
  }

  // Sidewalk clutter sampled every 6 m on both sides.
  for (let s = 7; s < len - 7; s += 6) {
    for (let side = -1; side <= 1; side += 2) {
      const roll = rng.next();
      polyAt(e.pts, s, _pp, _pd);
      const rx = -_pd[1] * side;
      const rz = _pd[0] * side;
      const face = yawFromDir(-rx, -rz);
      const px = _pp[0] + rx * kerb;
      const pz = _pp[1] + rz * kerb;
      const qx = _pp[0] + rx * inner;
      const qz = _pp[1] + rz * inner;
      if (roll < 0.035) {
        addProp(ctx, 'hydrant', px, SIDEWALK_H, pz, face, 1, null);
      } else if (roll < 0.075) {
        addProp(ctx, 'bin', qx, SIDEWALK_H, qz, face, 1,
          { full: rchance(rng, 0.4) });
      } else if (roll < 0.115 && (dk === 'downtown' || dk === 'midtown' || dk === 'beach')) {
        addProp(ctx, 'bench', qx, SIDEWALK_H, qz, face + Math.PI * 0.5, 1, null);
      } else if (roll < 0.145 && (dk === 'downtown' || dk === 'midtown')) {
        addProp(ctx, 'sign', px, SIDEWALK_H, pz, face, 1, { kind: 'meter' });
      } else if (roll < 0.165 && dk !== 'industrial') {
        addProp(ctx, 'planter', qx, SIDEWALK_H, qz, face, rr(rng, 0.9, 1.2), null);
      } else if (roll < 0.185 && (e.kind === 'avenue' || e.kind === 'boulevard')) {
        addProp(ctx, 'bollard', px, SIDEWALK_H, pz, face, 1, null);
      } else if (roll < 0.196 && dk === 'downtown') {
        addProp(ctx, 'atm', qx, SIDEWALK_H, qz, face, 1, null);
      } else if (roll < 0.206 && (dk === 'downtown' || dk === 'residential')) {
        addProp(ctx, 'phonebox', qx, SIDEWALK_H, qz, face, 1, null);
      } else if (roll < 0.216 && (dk === 'downtown' || dk === 'midtown' || dk === 'beach')) {
        addProp(ctx, 'streetvendor', qx, SIDEWALK_H, qz, face, 1,
          { menu: rpick(rng, ['어묵', '타코야키', '핫도그', '군밤']) });
      }
    }
  }

  // Bus stops on the big roads.
  if ((e.kind === 'avenue' || e.kind === 'boulevard') && len > 55 && rchance(rng, 0.5)) {
    const side = rchance(rng, 0.5) ? 1 : -1;
    polyAt(e.pts, len * 0.5, _pp, _pd);
    const rx = -_pd[1] * side;
    const rz = _pd[0] * side;
    addProp(ctx, 'busstop', _pp[0] + rx * inner, SIDEWALK_H, _pp[1] + rz * inner,
      yawFromDir(-rx, -rz), 1, { line: ri(rng, 100, 899) + '번' });
  }

  // Boulevard billboards.
  if (e.kind === 'boulevard' && len > 40) {
    const side = rchance(rng, 0.5) ? 1 : -1;
    polyAt(e.pts, len * 0.32, _pp, _pd);
    const rx = -_pd[1] * side;
    const rz = _pd[0] * side;
    addProp(ctx, 'billboard', _pp[0] + rx * (half + 3.0), SIDEWALK_H,
      _pp[1] + rz * (half + 3.0), yawFromDir(-rx, -rz), rr(rng, 1.0, 1.3),
      { text: rpick(rng, BILLBOARD_TEXTS), onWall: false });
  }
}

/**
 * Generates every prop: street furniture, intersection signals, lot dressing,
 * building billboards, alley dumpsters and roadworks.
 * @param {object} ctx Generation context.
 * @returns {void}
 */
function buildProps(ctx) {
  const rng = new Rand(mixSeed(ctx.seed, 'props'));
  ctx.props = [];

  for (const e of ctx.edges) {
    const mid = e.pts[Math.floor(e.pts.length / 2)];
    const dk = ctx.districts[districtIndexAt(ctx, mid[0], mid[1])].kind;
    edgeFurniture(ctx, e, dk, rng);
  }

  // Traffic signals, one head per approach, on the near right kerb.
  for (const node of ctx.nodes) {
    if (!node.hasTrafficLight) continue;
    for (const eid of node.edges) {
      const e = ctx.edges[eid];
      let dx;
      let dz;
      if (e.a === node.id) {
        polyStartDir(e.pts, _d2);
        dx = -_d2[0];
        dz = -_d2[1];
      } else {
        polyEndDir(e.pts, _d2);
        dx = _d2[0];
        dz = _d2[1];
      }
      const trim = Math.min(nodeTrim(ctx, node.id, e.id, dx, dz, 0), 26) + 1.6;
      const rx = -dz;
      const rz = dx;
      const off = e.width * 0.5 + 1.5;
      addProp(ctx, 'trafficlight',
        node.x - dx * trim + rx * off, SIDEWALK_H, node.z - dz * trim + rz * off,
        yawFromDir(-dx, -dz), 1, { nodeId: node.id, edgeId: e.id });
    }
  }

  // Lot dressing.
  for (const lot of ctx.lots) {
    const dk = ctx.districts[lot.districtId].kind;
    if (lot.kind === 'park') {
      const sand = lot.surface === 'sand';
      const area = lot.w * lot.d;
      const count = Math.min(260, Math.floor(area / (sand ? 320 : 95)));
      for (let i = 0; i < count; i++) {
        const x = rr(rng, lot.x0 + 4, lot.x1 - 4);
        const z = rr(rng, lot.z0 + 4, lot.z1 - 4);
        if (!footprintFree(ctx, x, z, 1.6, 1.6, 0, 0.4)) continue;
        addProp(ctx, sand ? 'palm' : 'tree', x, 0, z, rr(rng, 0, Math.PI * 2),
          rr(rng, 0.8, 1.35), null);
      }
      const dress = Math.min(48, Math.floor(area / 420));
      for (let i = 0; i < dress; i++) {
        const x = rr(rng, lot.x0 + 3, lot.x1 - 3);
        const z = rr(rng, lot.z0 + 3, lot.z1 - 3);
        if (!footprintFree(ctx, x, z, 1.2, 1.2, 0, 0.4)) continue;
        const r = rng.next();
        const t = r < 0.34 ? 'bench' : r < 0.6 ? 'lamp' : r < 0.8 ? 'bin' : 'planter';
        addProp(ctx, t, x, 0, z, rr(rng, 0, Math.PI * 2), 1, null);
      }
    } else if (lot.kind === 'parking') {
      const rows = Math.max(1, Math.floor(lot.d / 14));
      for (let r = 0; r < rows; r++) {
        const z = lot.z0 + 7 + r * ((lot.d - 14) / Math.max(1, rows - 1 || 1));
        for (let x = lot.x0 + 4; x < lot.x1 - 3; x += 5.5) {
          if (rchance(rng, 0.22)) {
            addProp(ctx, 'bollard', x, 0, z, 0, 0.8, { parking: true });
          }
        }
      }
      const lamps = Math.max(2, Math.floor(lot.w * lot.d / 900));
      for (let i = 0; i < lamps; i++) {
        addProp(ctx, 'lamp', rr(rng, lot.x0 + 4, lot.x1 - 4), 0,
          rr(rng, lot.z0 + 4, lot.z1 - 4), 0, 1.2, null);
      }
      if (lot.superblock === 'railyard') {
        for (let i = 0; i < 26; i++) {
          const x = rr(rng, lot.x0 + 5, lot.x1 - 5);
          const z = rr(rng, lot.z0 + 5, lot.z1 - 5);
          const r = rng.next();
          addProp(ctx, r < 0.5 ? 'barrier' : r < 0.8 ? 'dumpster' : 'bin',
            x, 0, z, rr(rng, 0, Math.PI * 2), 1, null);
        }
      }
    } else if (lot.kind === 'plaza') {
      const count = Math.floor(lot.w * lot.d / 260);
      for (let i = 0; i < count; i++) {
        const x = rr(rng, lot.x0 + 4, lot.x1 - 4);
        const z = rr(rng, lot.z0 + 4, lot.z1 - 4);
        if (!footprintFree(ctx, x, z, 1.3, 1.3, 0, 0.4)) continue;
        const r = rng.next();
        const t = r < 0.3 ? 'planter' : r < 0.5 ? 'bench' : r < 0.66 ? 'lamp'
          : r < 0.78 ? 'tree' : r < 0.9 ? 'bollard' : 'streetvendor';
        addProp(ctx, t, x, SIDEWALK_H, z, rr(rng, 0, Math.PI * 2), 1, null);
      }
    } else if (dk === 'industrial' && lot.kind === 'building') {
      for (let i = 0; i < 4; i++) {
        const x = rr(rng, lot.x0 + 4, lot.x1 - 4);
        const z = rr(rng, lot.z0 + 4, lot.z1 - 4);
        if (!footprintFree(ctx, x, z, 1.5, 1.2, 0, 0.4)) continue;
        addProp(ctx, rchance(rng, 0.6) ? 'dumpster' : 'barrier', x, 0, z,
          rr(rng, 0, Math.PI * 2), 1, null);
      }
    }
  }

  // Alley dumpsters.
  for (const a of ctx.alleys) {
    if (!rchance(rng, 0.32)) continue;
    const along = rr(rng, -0.35, 0.35) * a.len;
    const x = a.x + (a.rot === 0 ? along : 0);
    const z = a.z + (a.rot === 0 ? 0 : along);
    if (!footprintFree(ctx, x, z, 1.1, 0.8, a.rot, 0.1)) continue;
    addProp(ctx, 'dumpster', x, 0, z, a.rot, 1, null);
  }

  // Billboards on blank walls.
  for (const b of ctx.buildings) {
    if (b.h < 9 || b.h > 52) continue;
    if (b.signs.length > 1 || !rchance(rng, 0.07)) continue;
    const nx = b.face === 0 ? 1 : b.face === 2 ? -1 : 0;
    const nz = b.face === 1 ? 1 : b.face === 3 ? -1 : 0;
    const halfOut = (b.face === 0 || b.face === 2) ? b.w * 0.5 : b.d * 0.5;
    addProp(ctx, 'billboard', b.x + nx * (halfOut + 0.2), Math.min(b.h * 0.62, 16),
      b.z + nz * (halfOut + 0.2), yawFromDir(nx, nz), rr(rng, 0.9, 1.35),
      { text: rpick(rng, BILLBOARD_TEXTS), onWall: true, buildingId: b.id });
  }

  // Roadworks: a few coned-off stretches.
  const works = [];
  for (let i = 0; i < ctx.edges.length; i++) {
    const e = ctx.edges[i];
    if (e.kind !== 'street' && e.kind !== 'avenue') continue;
    if (polyLength(e.pts) > 40) works.push(e);
  }
  for (let n = 0; n < 3 && works.length > 0; n++) {
    const e = works[Math.floor(rng.next() * works.length)];
    const len = polyLength(e.pts);
    const start = rr(rng, 10, Math.max(11, len - 30));
    const side = rchance(rng, 0.5) ? 1 : -1;
    for (let s = 0; s < 22; s += 2.8) {
      polyAt(e.pts, start + s, _pp, _pd);
      const rx = -_pd[1] * side;
      const rz = _pd[0] * side;
      const lat = e.width * 0.25;
      addProp(ctx, 'cone', _pp[0] + rx * lat, 0, _pp[1] + rz * lat,
        yawFromDir(-rx, -rz), 1, null);
    }
    polyAt(e.pts, start - 1.5, _pp, _pd);
    addProp(ctx, 'barrier', _pp[0] - _pd[1] * side * e.width * 0.25, 0,
      _pp[1] + _pd[0] * side * e.width * 0.25, yawFromDir(_pd[0], _pd[1]), 1, null);
    polyAt(e.pts, start + 23, _pp, _pd);
    addProp(ctx, 'barrier', _pp[0] - _pd[1] * side * e.width * 0.25, 0,
      _pp[1] + _pd[0] * side * e.width * 0.25, yawFromDir(_pd[0], _pd[1]), 1, null);
  }
}

/* ------------------------------------------------------------------ *
 * Phase 8 — landmarks and spawns
 * ------------------------------------------------------------------ */

/**
 * Centre of a block in world coordinates.
 * @param {object} ctx Generation context.
 * @param {number} i Block column.
 * @param {number} j Block row.
 * @returns {number[]} `[x, z]`.
 */
function blockCenter(ctx, i, j) {
  const ii = clamp(i, 0, ctx.blocksX - 1);
  const jj = clamp(j, 0, ctx.blocksZ - 1);
  return [
    (ctx.xRoad[ii] + ctx.roadWX[ii] * 0.5 + ctx.xRoad[ii + 1] - ctx.roadWX[ii + 1] * 0.5) * 0.5,
    (ctx.zRoad[jj] + ctx.roadWZ[jj] * 0.5 + ctx.zRoad[jj + 1] - ctx.roadWZ[jj + 1] * 0.5) * 0.5
  ];
}

/**
 * Finds the building closest to a point, optionally filtered.
 * @param {object} ctx Generation context.
 * @param {number} x Anchor x.
 * @param {number} z Anchor z.
 * @param {(b: object) => boolean} pred Filter.
 * @returns {object|null} Building or null.
 */
function nearestBuilding(ctx, x, z, pred) {
  let best = null;
  let bestD = Infinity;
  for (const b of ctx.buildings) {
    if (b.landmark) continue;
    if (!pred(b)) continue;
    const dx = b.x - x;
    const dz = b.z - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/**
 * Builds the landmark list used by the map screen and the mission markers.
 * @param {object} ctx Generation context.
 * @returns {object[]} Landmarks.
 */
function buildLandmarks(ctx) {
  const marks = [];
  /**
   * @param {string} name Korean name.
   * @param {number} x World x.
   * @param {number} z World z.
   * @param {string} kind Landmark kind.
   * @returns {void}
   */
  const add = (name, x, z, kind) => {
    marks.push({ id: marks.length, name, x, z, kind });
  };

  for (let i = 0; i < ctx.landmarkTowers.length; i++) {
    const b = ctx.landmarkTowers[i];
    add(b.name, b.x, b.z, 'tower');
  }
  for (const sb of ctx.superblocks) {
    if (sb.lotId === undefined) continue;
    const lot = ctx.lots[sb.lotId];
    const kind = sb.kind === 'railyard' ? 'railyard' : sb.kind === 'stadium' ? 'stadium'
      : sb.kind === 'park' ? 'park' : sb.kind === 'parking' ? 'parking' : 'plaza';
    add(sb.name, lot.x, lot.z, kind);
  }

  const police = nearestBuilding(ctx, ...blockCenter(ctx, Math.round(ctx.blocksX * 0.21),
    Math.round(ctx.blocksZ * 0.43)), (b) => b.h > 12 && b.style !== 'house');
  if (police) {
    police.name = '중앙 경찰서';
    police.landmark = true;
    ctx.policeStation = police;
    add('중앙 경찰서', police.x, police.z, 'police');
  }
  const hospital = nearestBuilding(ctx, ...blockCenter(ctx, Math.round(ctx.blocksX * 0.71),
    Math.round(ctx.blocksZ * 0.36)), (b) => b.h > 14 && b.style !== 'house');
  if (hospital) {
    hospital.name = '시립 병원';
    hospital.landmark = true;
    add('시립 병원', hospital.x, hospital.z, 'hospital');
  }
  const hall = nearestBuilding(ctx, ...blockCenter(ctx, Math.round(ctx.blocksX * 0.43),
    Math.round(ctx.blocksZ * 0.57)), (b) => b.h > 20);
  if (hall) {
    hall.name = '시청';
    hall.landmark = true;
    add('시청', hall.x, hall.z, 'civic');
  }
  const port = nearestBuilding(ctx, ctx.gridMaxX - 60, ctx.gridMaxZ - 60,
    (b) => b.style === 'warehouse');
  if (port) {
    port.name = '항구 창고';
    port.landmark = true;
    ctx.portWarehouse = port;
    add('컨테이너 부두', port.x, port.z, 'port');
  }
  if (ctx.waterfrontEdges.length > 0) {
    const e = ctx.edges[ctx.waterfrontEdges[Math.floor(ctx.waterfrontEdges.length / 4)]];
    const mid = e.pts[Math.floor(e.pts.length / 2)];
    add('해변 산책로', mid[0], mid[1], 'beach');
  }
  return marks;
}

/**
 * Places the player, traffic, pedestrian, police and mission spawn points.
 * @param {object} ctx Generation context.
 * @param {object} city The assembled city (lanes/walks already final).
 * @returns {object} The `spawns` structure.
 */
function buildSpawns(ctx, city) {
  const rng = new Rand(mixSeed(ctx.seed, 'spawns'));
  const spawns = { player: null, vehicles: [], peds: [], police: [], missionPoints: [] };

  // --- vehicles ----------------------------------------------------------
  const roadLanes = [];
  for (const lane of city.lanes) {
    if (lane.edgeId < 0) continue;
    if (polyLength(lane.pts) < 16) continue;
    roadLanes.push(lane.id);
  }
  for (let i = roadLanes.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const t = roadLanes[i];
    roadLanes[i] = roadLanes[j];
    roadLanes[j] = t;
  }
  const wantVehicles = Math.min(roadLanes.length, 240);
  for (let i = 0; i < wantVehicles; i++) {
    const lane = city.lanes[roadLanes[i]];
    const t = rr(rng, 0.22, 0.78);
    polySample(lane.pts, t, _pp);
    polyDirAt(lane.pts, t, _pd);
    spawns.vehicles.push({
      x: _pp[0], y: 0, z: _pp[1],
      yaw: yawFromDir(_pd[0], _pd[1]),
      laneId: lane.id
    });
  }

  // --- pedestrians -------------------------------------------------------
  const walkIds = [];
  for (const w of city.walks) {
    if (w.crossing || (w.id & 1) === 1) continue;
    if (polyLength(w.pts) < 8) continue;
    walkIds.push(w.id);
  }
  for (let i = walkIds.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const t = walkIds[i];
    walkIds[i] = walkIds[j];
    walkIds[j] = t;
  }
  const wantPeds = Math.min(walkIds.length, 320);
  for (let i = 0; i < wantPeds; i++) {
    const w = city.walks[walkIds[i]];
    polySample(w.pts, rr(rng, 0.15, 0.85), _pp);
    spawns.peds.push({ x: _pp[0], y: SIDEWALK_H, z: _pp[1] });
  }

  // --- player ------------------------------------------------------------
  const plazaLot = ctx.sbPlaza >= 0 && ctx.superblocks[ctx.sbPlaza]
    ? ctx.lots[ctx.superblocks[ctx.sbPlaza].lotId] : null;
  const px = plazaLot ? plazaLot.x : 0;
  const pz = plazaLot ? plazaLot.z + (plazaLot.d * 0.5 + 12) : 0;
  const near = walkAt(city, px, pz);
  if (near) {
    const dx = px - near.point[0];
    const dz = pz - near.point[1];
    const l = Math.hypot(dx, dz) || 1;
    spawns.player = {
      x: near.point[0], y: SIDEWALK_H, z: near.point[1],
      yaw: yawFromDir(dx / l, dz / l)
    };
  } else {
    spawns.player = { x: px, y: SIDEWALK_H, z: pz, yaw: 0 };
  }

  // --- police ------------------------------------------------------------
  const station = ctx.policeStation;
  const sx = station ? station.x : px;
  const sz = station ? station.z : pz;
  const ring = [[18, 0], [-18, 0], [0, 18], [0, -18], [14, 14], [-14, -14]];
  for (let i = 0; i < ring.length; i++) {
    const tx = sx + ring[i][0];
    const tz = sz + ring[i][1];
    const hit = walkAt(city, tx, tz);
    const x = hit ? hit.point[0] : tx;
    const z = hit ? hit.point[1] : tz;
    const dx = sx - x;
    const dz = sz - z;
    const l = Math.hypot(dx, dz) || 1;
    spawns.police.push({ x, y: SIDEWALK_H, z, yaw: yawFromDir(dx / l, dz / l) });
  }

  // --- mission points ----------------------------------------------------
  /**
   * @param {string} name Korean name.
   * @param {number} x Anchor x.
   * @param {number} z Anchor z.
   * @returns {void}
   */
  const addMission = (name, x, z) => {
    const hit = walkAt(city, x, z);
    spawns.missionPoints.push({
      x: hit ? hit.point[0] : x,
      y: SIDEWALK_H,
      z: hit ? hit.point[1] : z,
      name
    });
  };
  /**
   * @param {string} kind Landmark kind.
   * @returns {object|null} First landmark of that kind.
   */
  const mark = (kind) => city.landmarks.find((m) => m.kind === kind) || null;
  const port = ctx.portWarehouse;
  addMission('항구 창고', port ? port.x : ctx.gridMaxX - 60, port ? port.z + 14 : ctx.gridMaxZ - 60);
  addMission('중앙 광장', px, pz);
  const stadium = mark('stadium');
  addMission('스타디움', stadium ? stadium.x : px, stadium ? stadium.z : pz);
  const beach = mark('beach');
  addMission('해변 산책로', beach ? beach.x : px, beach ? beach.z : pz);
  const park = mark('park');
  addMission('네온 공원', park ? park.x : px, park ? park.z : pz);
  const yard = mark('railyard');
  addMission('차량기지', yard ? yard.x : px, yard ? yard.z : pz);
  const tower = ctx.landmarkTowers[0];
  addMission('전망대 타워', tower ? tower.x + tower.w * 0.5 + 8 : px,
    tower ? tower.z : pz);
  const c = blockCenter(ctx, Math.round(ctx.blocksX * 0.14), Math.round(ctx.blocksZ * 0.86));
  addMission('리버사이드 주택가', c[0], c[1]);
  return spawns;
}
