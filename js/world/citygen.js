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
