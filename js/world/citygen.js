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
/** Carriageway width of the diagonal boulevard. Kept under 27.7 m so the kerb
 * corners of the 16 m streets it crosses at 45 degrees stay off the asphalt. */
const BOULEVARD_WIDTH = 26;
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

/** Full circle in radians (local copy so the import list stays minimal). */
const TAU_LOCAL = Math.PI * 2;

/** Radius within which two sidewalk ends at a node collapse to one kerb corner.
 * Perpendicular roads land on the exact same point, skewed ones a few decimetres
 * apart; anything further apart is a genuinely separate corner. */
const CORNER_MERGE = 6.0;

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
  return polyClean(out);
}

/**
 * Removes degenerate and folded-back vertices from an offset polyline. Mitred
 * offsets fold over on the inside of a sharp bend; those folds would otherwise
 * become tiny reversed lane/sidewalk segments.
 * @param {number[][]} pts Source points.
 * @returns {number[][]} Cleaned polyline (at least two points).
 */
function polyClean(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    const q = out[out.length - 1];
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= 0.35) {
      out.push(p);
    } else if (i === pts.length - 1 && out.length > 1) {
      out[out.length - 1] = p;
    }
  }
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let i = 1; i < out.length - 1; i++) {
      const ax = out[i][0] - out[i - 1][0];
      const az = out[i][1] - out[i - 1][1];
      const bx = out[i + 1][0] - out[i][0];
      const bz = out[i + 1][1] - out[i][1];
      if (ax * bx + az * bz < 0) {
        out.splice(i, 1);
        changed = true;
        i--;
      }
    }
    if (!changed) break;
  }
  return out.length >= 2 ? out : [pts[0], pts[pts.length - 1]];
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
 * @param {number} margin Extra clearance added to *both* boxes, so the
 *   effective gap the test enforces is twice this value.
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

  /**
   * Block column at a fraction of the grid width.
   * @param {number} f Fraction 0..1.
   * @returns {number} Block column index.
   */
  const bi = (f) => Math.round(blocksX * f);
  /**
   * Block row at a fraction of the grid height.
   * @param {number} f Fraction 0..1.
   * @returns {number} Block row index.
   */
  const bj = (f) => Math.round(blocksZ * f);
  ctx.sbPark = tryAdd(bi(0.14), bj(0.57), 2, 2, 'park', '네온 공원');
  ctx.sbStadium = tryAdd(bi(0.64), Math.max(1, bj(0.07)), 2, 2, 'stadium', '스타디움');
  ctx.sbRail = tryAdd(bi(0.71), blocksZ - 2, 2, 2, 'railyard', '차량기지');
  ctx.sbPlaza = tryAdd(bi(0.5), bj(0.43), 1, 1, 'plaza', '중앙 광장');
  ctx.sbMarket = tryAdd(bi(0.21), bj(0.21), 1, 1, 'plaza', '북부 시장');
  ctx.sbParking = tryAdd(bi(0.79), bj(0.5), 1, 1, 'parking', '중앙 주차장');
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
    // Arms touching the 90 degree bend stay straight: a spline through the
    // corner would curve tighter than the sidewalk offset and fold over.
    if (p1.side !== 'corner' && p2.side !== 'corner') {
      for (let s = 1; s <= 3; s++) {
        catmullRom(a0, a1, a2, a3, s / 4, tmp);
        pts.push([tmp[0], tmp[1]]);
      }
    }
    pts.push([p2.x, p2.z]);
    const e = addEdge(wfIds[k], wfIds[k + 1], pts, 'waterfront',
      WATERFRONT_WIDTH, 2, SPEED_WATERFRONT);
    ctx.waterfrontEdges.push(e.id);
  }
  for (let k = 0; k < wf.length; k++) {
    // The bend node is left alone: a link arriving there at 45 degrees to both
    // promenade arms cannot produce clean kerb corners, and the chain stays
    // connected through its neighbours anyway.
    if (wf[k].side === 'corner') continue;
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
      } else if (ctx.seaSide &&
          ((j === blocksZ - 1 && i < indI0) || (i === blocksX - 1 && j < indJ0))) {
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
      // A little low-rise infill between the towers keeps the skyline reading
      // as a skyline instead of a uniform slab of glass.
      if (area > 430) return r < 0.66 ? 'tower' : r < 0.91 ? 'office' : 'shop';
      if (area > 190) return r < 0.42 ? 'office' : r < 0.7 ? 'tower' : r < 0.86 ? 'apartment' : 'shop';
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
    industrial: 640, beach: 190, park: 260
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
      // Two octaves of coherent noise keep neighbouring lots in agreement while
      // still spanning the district's full height range.
      const n1 = noise2(px / 96, pz / 96, ctx.seed);
      const n2 = noise2(px / 31, pz / 31, ctx.seed + 7717);
      let t = clamp(0.28 + (1 - dc) * 0.42 + (n1 - 0.5) * 0.72 + (n2 - 0.5) * 0.4, 0, 1);
      if (style === 'house') t *= 0.45;
      if (style === 'shop') t = Math.min(t, 0.22);
      if (style === 'warehouse') t = Math.min(t, 0.62);
      if (style === 'office' && dk === 'downtown') t *= 0.72;
      if (style === 'apartment' && dk === 'downtown') t *= 0.62;
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
    // The tower just grew, so any crown sign authored for the old height would
    // now be stranded halfway up the glass. Drop it and re-crown the building.
    for (let k = b.signs.length - 1; k >= 0; k--) {
      if (b.signs[k].kind === 'roof') b.signs.splice(k, 1);
    }
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
    refitSigns(b);
    ctx.landmarkTowers.push(b);
  }
}

/* ------------------------------------------------------------------ *
 * Phase 5 — directed lane graph
 * ------------------------------------------------------------------ */

/** Scratch point used by the kerb-corner clustering. */
const _corner2 = [0, 0];

/** Scratch direction vectors used while stitching the graphs together. */
const _d0 = [0, 0];
const _d1 = [0, 0];
const _d2 = [0, 0];

/**
 * Distance an offset centre line must keep from a node so that it clears the
 * carriageway of every road crossing there.
 *
 * The line is `P(t) = node + away * t + lat`. For a crossing road with kerb
 * normal `n` and half width `h` we need `|P(t) - node| . n >= h`, which gives
 * `t >= (h - sign(away.n) * (lat.n)) / |away.n|`. For perpendicular crossings
 * `lat . n` is zero, so this reduces to the exact kerb distance `h` and the
 * sidewalk corners of the grid coincide bit-for-bit.
 *
 * @param {object} ctx Generation context.
 * @param {number} nodeId Node id.
 * @param {number} edgeId Edge being trimmed (skipped as a crossing road).
 * @param {number} awayX Unit direction leading away from the node.
 * @param {number} awayZ Unit direction leading away from the node.
 * @param {number} latX Lateral offset already applied to the line.
 * @param {number} latZ Lateral offset already applied to the line.
 * @param {number} extra Additional clearance (sidewalk offset for walks).
 * @returns {number} Trim distance in metres.
 */
function nodeTrim(ctx, nodeId, edgeId, awayX, awayZ, latX, latZ, extra) {
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
    const nx = -fz;
    const nz = fx;
    const a = awayX * nx + awayZ * nz;
    const abs = Math.abs(a);
    if (abs < 0.4) continue;
    const b = latX * nx + latZ * nz;
    const t = (f.width * 0.5 + extra - (a >= 0 ? b : -b)) / abs;
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
  const cap = len * 0.42;
  const L = e.lanesPerDir;
  const slot = e.width / (2 * L);
  const rev = e.pts.slice().reverse();

  for (let dir = 0; dir < 2; dir++) {
    const base = dir === 0 ? e.pts : rev;
    const nodeStart = dir === 0 ? e.a : e.b;
    const nodeEnd = dir === 0 ? e.b : e.a;
    polyStartDir(base, _d0);
    polyEndDir(base, _d1);
    for (let k = 0; k < L; k++) {
      const off = (k + 0.5) * slot;
      const ts = Math.min(cap, nodeTrim(ctx, nodeStart, e.id, _d0[0], _d0[1],
        -_d0[1] * off, _d0[0] * off, 0));
      const te = Math.min(cap, nodeTrim(ctx, nodeEnd, e.id, -_d1[0], -_d1[1],
        -_d1[1] * off, _d1[0] * off, 0));
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
 * Re-anchors a building's signage onto its current facade.
 *
 * Signs are authored from the footprint the building had when it was created,
 * so anything that later changes `w`, `d` or `h` (the landmark promotion, the
 * road-clearance pass) must call this or the panels end up hanging in the air,
 * sunk into the wall, or wider than the wall they sit on.
 *
 * @param {object} b Building record.
 * @returns {void}
 */
function refitSigns(b) {
  for (let i = 0; i < b.signs.length; i++) {
    const s = b.signs[i];
    const halfOut = (s.face === 0 || s.face === 2) ? b.w * 0.5 : b.d * 0.5;
    const halfAlong = (s.face === 0 || s.face === 2) ? b.d * 0.5 : b.w * 0.5;
    s.x = b.x + s.nx * (halfOut + 0.12);
    s.z = b.z + s.nz * (halfOut + 0.12);
    s.w = clamp(s.w, 0.8, Math.max(0.8, halfAlong * 2 - 0.4));
    s.h = clamp(s.h, 0.5, Math.max(0.5, b.h - 0.4));
    s.y = clamp(s.y, s.h * 0.5 + 0.2, b.h - s.h * 0.5);
  }
}

/**
 * Shrinks one footprint clear of a road rectangle along that road's normal.
 *
 * The facade furthest from the road is held exactly where it is, so the new
 * footprint is always a strict subset of the old one: the pass can never push
 * a wall into a neighbour, and can never move a building across the road into
 * a different block.
 *
 * @param {object} b Building record (mutated on success).
 * @param {{x:number,z:number,hx:number,hz:number,rot:number}} rc Road keep-out rectangle.
 * @param {number} margin Clearance to leave between the facade and the kerb line.
 * @param {number} minSize Smallest footprint dimension this pass may produce.
 * @returns {boolean} True when the footprint changed.
 */
function shrinkOffRoad(b, rc, margin, minSize) {
  // Road normal (the short axis of the rectangle).
  const nx = -Math.sin(rc.rot);
  const nz = Math.cos(rc.rot);
  const s = (b.x - rc.x) * nx + (b.z - rc.z) * nz;
  const side = s >= 0 ? 1 : -1;
  const ux = Math.cos(b.rot);
  const uz = Math.sin(b.rot);
  // Components of the building's own axes along the road normal.
  const du = Math.abs(ux * nx + uz * nz);
  const dv = Math.abs(-uz * nx + ux * nz);
  const sup = b.w * 0.5 * du + b.d * 0.5 * dv;
  const deficit = (rc.hz + margin) - (Math.abs(s) - sup);
  if (deficit <= 0) return false;
  // Shrink whichever local axis leans hardest on the road normal.
  const useW = b.w * du >= b.d * dv;
  const proj = Math.max(useW ? du : dv, 0.2);
  const size = useW ? b.w : b.d;
  const shrink = Math.min(deficit / proj, size - minSize);
  if (shrink <= 0.001) return false;
  const axx = useW ? ux : -uz;
  const axz = useW ? uz : ux;
  // Step the centre away from the road by half the shrink so the far facade
  // stays put; the near facade then retreats by the full shrink.
  const sigma = ((axx * nx + axz * nz) * side >= 0) ? 1 : -1;
  const half = shrink * 0.5;
  b.x += axx * sigma * half;
  b.z += axz * sigma * half;
  if (useW) b.w = size - shrink;
  else b.d = size - shrink;
  return true;
}

/**
 * Final safety pass: pulls any building footprint that still touches a
 * carriageway or its sidewalk back off the asphalt.
 *
 * Placement already enforces the keep-out through {@link footprintFree}, so in
 * practice this pass finds nothing; it exists so that a future change to the
 * road widths can never ship a facade standing in a traffic lane. It only ever
 * *shrinks* a footprint (see {@link shrinkOffRoad}), which is why it cannot
 * introduce building-on-building overlaps the way a nudge-based pass would.
 * Building ids stay stable because nothing is added or removed.
 *
 * @param {object} ctx Generation context.
 * @returns {void}
 */
function clipBuildingsToRoads(ctx) {
  const MARGIN = 0.35;   // clear space to keep between a facade and the kerb line
  const MIN_SIZE = 5.0;  // never shrink a footprint below this
  const roads = ctx.roads;
  if (!roads || roads.length === 0 || ctx.buildings.length === 0) return;

  // Oriented rectangles matching the keep-out used during placement: the
  // carriageway plus its sidewalk, grown by half a width at each end so the
  // intersection squares are covered as well.
  const b0 = ctx.bounds;
  const grid = new Grid2D(b0.min[0], b0.min[1], b0.max[0], b0.max[1], HASH_CELL);
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i];
    const dx = r.bx - r.ax;
    const dz = r.bz - r.az;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    insertBox(grid, {
      x: (r.ax + r.bx) * 0.5,
      z: (r.az + r.bz) * 0.5,
      hx: len * 0.5 + r.width * 0.5,
      hz: r.width * 0.5 + SIDEWALK_W,
      rot: Math.atan2(dz, dx)
    });
  }

  const dirty = new Set();
  // Several passes: clearing one road can leave the footprint touching another.
  for (let pass = 0; pass < 4; pass++) {
    let moved = 0;
    for (let i = 0; i < ctx.buildings.length; i++) {
      const b = ctx.buildings[i];
      const c = Math.abs(Math.cos(b.rot));
      const sn = Math.abs(Math.sin(b.rot));
      const ex = b.w * 0.5 * c + b.d * 0.5 * sn + 1;
      const ez = b.w * 0.5 * sn + b.d * 0.5 * c + 1;
      grid.query(b.x - ex, b.z - ez, b.x + ex, b.z + ez, _hits);
      for (let k = 0; k < _hits.length; k++) {
        const rc = _hits[k];
        if (!obbOverlap(b.x, b.z, b.w * 0.5, b.d * 0.5, b.rot,
          rc.x, rc.z, rc.hx, rc.hz, rc.rot, 0)) continue;
        if (shrinkOffRoad(b, rc, MARGIN, MIN_SIZE)) {
          moved++;
          dirty.add(b);
        }
      }
    }
    if (moved === 0) break;
  }
  for (const b of dirty) refitSigns(b);
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

    /** Outgoing lanes that already received at least one connection. */
    const covered = new Set();
    /**
     * Connects two lanes and records the outgoing lane as reachable.
     * @param {object} inLane Incoming lane.
     * @param {object} outLane Outgoing lane.
     * @param {string} turn Turn classification.
     * @returns {void}
     */
    const link = (inLane, outLane, turn) => {
      connectLanes(ctx, node, inLane, outLane, turn);
      covered.add(outLane.id);
    };

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
              link(inLane, ctx.lanes[B.outLanes[j]], 'straight');
            }
          }
        } else if (ang > 0) {
          link(ctx.lanes[A.inLanes[Lin - 1]], ctx.lanes[B.outLanes[Lout - 1]], 'right');
        } else {
          link(ctx.lanes[A.inLanes[0]], ctx.lanes[B.outLanes[0]], 'left');
        }
      }
    }

    // Coverage pass: an outgoing lane nobody can enter would strand traffic,
    // so feed it from the most aligned incoming approach.
    for (let b = 0; b < app.length; b++) {
      const B = app[b];
      for (let j = 0; j < B.outLanes.length; j++) {
        const outId = B.outLanes[j];
        if (covered.has(outId)) continue;
        let bestA = null;
        let bestScore = -Infinity;
        for (let a = 0; a < app.length; a++) {
          if (a === b && app.length > 1) continue;
          const A = app[a];
          if (A.inLanes.length === 0) continue;
          const score = A.inDir[0] * B.outDir[0] + A.inDir[1] * B.outDir[1];
          if (score > bestScore) {
            bestScore = score;
            bestA = A;
          }
        }
        if (bestA === null) continue;
        const k = Math.min(j, bestA.inLanes.length - 1);
        const cross = bestA.inDir[0] * B.outDir[1] - bestA.inDir[1] * B.outDir[0];
        const ang = Math.atan2(cross, bestScore);
        const turn = Math.abs(ang) <= 0.7 ? 'straight'
          : Math.abs(ang) > 2.62 ? 'uturn' : ang > 0 ? 'right' : 'left';
        link(ctx.lanes[bestA.inLanes[k]], ctx.lanes[outId], turn);
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
        link(inLane, ctx.lanes[A.outLanes[j]], 'uturn');
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Phase 6 — pedestrian graph
 * ------------------------------------------------------------------ */

/**
 * Snaps a sidewalk endpoint onto one of a node's kerb corners (within
 * {@link CORNER_MERGE}), creating the corner the first time it is seen.
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
  let bestD = CORNER_MERGE * CORNER_MERGE;
  _corner2[0] = x;
  _corner2[1] = z;
  for (let i = 0; i < list.length; i++) {
    const d = vec2.sqrDist(list[i], _corner2);
    if (d < bestD) {
      bestD = d;
      best = list[i];
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
 * True when a point sits far enough from every carriageway to be a sidewalk.
 * @param {object} ctx Generation context.
 * @param {number} x World x.
 * @param {number} z World z.
 * @param {number} margin Required clearance from the kerb.
 * @returns {boolean} True when the point is clear.
 */
function pointClearOfRoads(ctx, x, z, margin) {
  ctx.roadGrid.query(x - margin - 1, z - margin - 1, x + margin + 1, z + margin + 1, _hits);
  for (let i = 0; i < _hits.length; i++) {
    const o = _hits[i];
    if (obbOverlap(x, z, 0.05, 0.05, 0, o.x, o.z, o.hx, o.hz, o.rot, margin)) return false;
  }
  return true;
}

/**
 * Moves every kerb corner off the carriageway.
 *
 * Corners built from perpendicular roads are already 1.8 m clear and never
 * move. Corners where roads meet at an odd angle (the boulevard, the
 * waterfront bend) can end up a few centimetres inside the asphalt once two
 * nearly-coincident sidewalk ends merge, so they are pushed out along the
 * shallowest separating axis; if that cannot resolve them (a corner boxed in
 * by three roads) a polar search around the intersection finds the closest
 * free spot instead.
 *
 * @param {object} ctx Generation context.
 * @returns {void}
 */
function resolveCorners(ctx) {
  // obbOverlap inflates both boxes, so this enforces a ~1.5 m gap from the
  // kerb — comfortably less than the 1.8 m the regular grid corners have.
  const margin = 0.72;
  const STEPS = 48;
  for (const [nodeId, list] of ctx.corners) {
    const node = ctx.nodes[nodeId];
    for (const c of list) {
      if (pointClearOfRoads(ctx, c[0], c[1], margin)) continue;
      const ox = c[0];
      const oz = c[1];
      for (let it = 0; it < 12; it++) {
        ctx.roadGrid.query(c[0] - 3, c[1] - 3, c[0] + 3, c[1] + 3, _hits);
        let depth = 0;
        let px = 0;
        let pz = 0;
        for (let i = 0; i < _hits.length; i++) {
          const o = _hits[i];
          if (!obbOverlap(c[0], c[1], 0.05, 0.05, 0, o.x, o.z, o.hx, o.hz, o.rot, margin)) continue;
          if (_mtv[2] > depth) {
            depth = _mtv[2];
            px = _mtv[0];
            pz = _mtv[1];
          }
        }
        if (depth === 0) break;
        c[0] += px * (depth + 0.02);
        c[1] += pz * (depth + 0.02);
      }
      if (pointClearOfRoads(ctx, c[0], c[1], margin)) continue;
      c[0] = ox;
      c[1] = oz;
      const dx = c[0] - node.x;
      const dz = c[1] - node.z;
      const theta = Math.atan2(dz, dx);
      const baseR = Math.max(6, Math.hypot(dx, dz));
      let done = false;
      for (let ring = 0; ring < 8 && !done; ring++) {
        const r = baseR + ring * 2.5;
        for (let k = 0; k < STEPS && !done; k++) {
          const step = ((k + 1) >> 1) * (TAU_LOCAL / STEPS);
          const ang = theta + ((k & 1) === 0 ? step : -step);
          const qx = node.x + Math.cos(ang) * r;
          const qz = node.z + Math.sin(ang) * r;
          if (!pointClearOfRoads(ctx, qx, qz, margin)) continue;
          c[0] = qx;
          c[1] = qz;
          done = true;
        }
      }
    }
  }
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

  const lines = [];
  for (const e of order) {
    const len = polyLength(e.pts);
    const cap = len * 0.45;
    polyStartDir(e.pts, _d0);
    polyEndDir(e.pts, _d1);
    for (let side = 0; side < 2; side++) {
      const off = (side === 0 ? 1 : -1) * (e.width * 0.5 + WALK_OFFSET);
      const trimA = Math.min(cap, nodeTrim(ctx, e.a, e.id, _d0[0], _d0[1],
        -_d0[1] * off, _d0[0] * off, WALK_OFFSET));
      const trimB = Math.min(cap, nodeTrim(ctx, e.b, e.id, -_d1[0], -_d1[1],
        -_d1[1] * off, _d1[0] * off, WALK_OFFSET));
      const line = polyTrim(polyOffset(e.pts, off), trimA, trimB);
      if (!line) continue;
      lines.push({
        line,
        c0: snapCorner(ctx, e.a, line[0][0], line[0][1]),
        c1: snapCorner(ctx, e.b, line[line.length - 1][0], line[line.length - 1][1]),
        edgeId: e.id
      });
    }
  }
  resolveCorners(ctx);
  for (const L of lines) {
    L.line[0] = [L.c0[0], L.c0[1]];
    L.line[L.line.length - 1] = [L.c1[0], L.c1[1]];
    addWalkPair(ctx, L.line, false, -1, L.edgeId);
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
      let crossing = false;
      for (let k = 1; k < 8 && !crossing; k++) {
        const f = k / 8;
        if (pointOnRoadRects(ctx, p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f)) {
          crossing = true;
        }
      }
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
    addProp(ctx, 'streetlight', _pp[0] + rx * kerb, SIDEWALK_H, _pp[1] + rz * kerb,
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
        addProp(ctx, treeType, _pp[0] + rx * inner, SIDEWALK_H, _pp[1] + rz * inner,
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
      const trim = Math.min(nodeTrim(ctx, node.id, e.id, -dx, -dz, 0, 0, 0), 26) + 1.6;
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
 * True when a candidate spawn keeps its distance from the ones already placed.
 * @param {Array<{x:number,z:number}>} list Accepted spawns.
 * @param {number} x Candidate x.
 * @param {number} z Candidate z.
 * @param {number} minDist Required separation in metres.
 * @returns {boolean} True when the candidate is far enough from all of them.
 */
function farFrom(list, x, z, minDist) {
  const m2 = minDist * minDist;
  for (let i = 0; i < list.length; i++) {
    const dx = list[i].x - x;
    const dz = list[i].z - z;
    if (dx * dx + dz * dz < m2) return false;
  }
  return true;
}

/**
 * Nearest standable sidewalk point: like {@link walkAt} but never returns a
 * position in the middle of a crosswalk.
 * @param {object} city City data.
 * @param {number} x Query x.
 * @param {number} z Query z.
 * @param {number[]} out Output `[x, z]`.
 * @returns {number[]} `out`.
 */
function sidewalkPoint(city, x, z, out) {
  const hit = walkAt(city, x, z);
  if (!hit) {
    out[0] = x;
    out[1] = z;
    return out;
  }
  if (!hit.walk.crossing) {
    out[0] = hit.point[0];
    out[1] = hit.point[1];
    return out;
  }
  const pts = hit.walk.pts;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const da = (a[0] - x) * (a[0] - x) + (a[1] - z) * (a[1] - z);
  const db = (b[0] - x) * (b[0] - x) + (b[1] - z) * (b[1] - z);
  const p = da <= db ? a : b;
  out[0] = p[0];
  out[1] = p[1];
  return out;
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
    let placed = false;
    for (let attempt = 0; attempt < 3 && !placed; attempt++) {
      const t = rr(rng, 0.22, 0.78);
      polySample(lane.pts, t, _pp);
      if (!farFrom(spawns.vehicles, _pp[0], _pp[1], 7)) continue;
      polyDirAt(lane.pts, t, _pd);
      spawns.vehicles.push({
        x: _pp[0], y: 0, z: _pp[1],
        yaw: yawFromDir(_pd[0], _pd[1]),
        laneId: lane.id
      });
      placed = true;
    }
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
  const wantPeds = Math.min(walkIds.length, 340);
  for (let i = 0; i < wantPeds; i++) {
    const w = city.walks[walkIds[i]];
    polySample(w.pts, rr(rng, 0.15, 0.85), _pp);
    if (!farFrom(spawns.peds, _pp[0], _pp[1], 2.2)) continue;
    spawns.peds.push({ x: _pp[0], y: SIDEWALK_H, z: _pp[1] });
  }

  // --- player ------------------------------------------------------------
  const plazaLot = ctx.sbPlaza >= 0 && ctx.superblocks[ctx.sbPlaza]
    ? ctx.lots[ctx.superblocks[ctx.sbPlaza].lotId] : null;
  const px = plazaLot ? plazaLot.x : 0;
  const pz = plazaLot ? plazaLot.z + (plazaLot.d * 0.5 + 12) : 0;
  sidewalkPoint(city, px, pz, _pp);
  {
    const dx = px - _pp[0];
    const dz = pz - _pp[1];
    const l = Math.hypot(dx, dz) || 1;
    spawns.player = {
      x: _pp[0], y: SIDEWALK_H, z: _pp[1],
      yaw: yawFromDir(dx / l, dz / l)
    };
  }

  // --- police ------------------------------------------------------------
  const station = ctx.policeStation;
  const sx = station ? station.x : px;
  const sz = station ? station.z : pz;
  const ring = [[18, 0], [-18, 0], [0, 18], [0, -18], [14, 14], [-14, -14]];
  for (let i = 0; i < ring.length; i++) {
    const tx = sx + ring[i][0];
    const tz = sz + ring[i][1];
    sidewalkPoint(city, tx, tz, _pp);
    const x = _pp[0];
    const z = _pp[1];
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
    sidewalkPoint(city, x, z, _pp);
    spawns.missionPoints.push({ x: _pp[0], y: SIDEWALK_H, z: _pp[1], name });
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

/* ------------------------------------------------------------------ *
 * Polyline nearest-point index (built lazily, cached per city)
 * ------------------------------------------------------------------ */

/** Scratch candidate list shared by every index query. */
const _qhits = [];

/**
 * Nearest-point acceleration structure over a list of polylines.
 */
class PolyIndex {
  /**
   * @param {Array<{pts:number[][]}>} items Polyline owners (lanes or walks).
   * @param {number} cell Cell size in metres.
   */
  constructor(items, cell) {
    this.items = items;
    this.cell = cell;
    /** @type {Float64Array[]} */
    this.cum = new Array(items.length);
    this.total = new Float64Array(items.length);
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < items.length; i++) {
      const pts = items[i].pts;
      for (let p = 0; p < pts.length; p++) {
        if (pts[p][0] < minX) minX = pts[p][0];
        if (pts[p][0] > maxX) maxX = pts[p][0];
        if (pts[p][1] < minZ) minZ = pts[p][1];
        if (pts[p][1] > maxZ) maxZ = pts[p][1];
      }
    }
    if (!isFinite(minX)) {
      minX = -1; minZ = -1; maxX = 1; maxZ = 1;
    }
    this.grid = new Grid2D(minX, minZ, maxX, maxZ, cell);
    for (let i = 0; i < items.length; i++) {
      const pts = items[i].pts;
      const cum = new Float64Array(pts.length);
      let acc = 0;
      for (let s = 0; s + 1 < pts.length; s++) {
        cum[s] = acc;
        const ax = pts[s][0];
        const az = pts[s][1];
        const bx = pts[s + 1][0];
        const bz = pts[s + 1][1];
        acc += Math.hypot(bx - ax, bz - az);
        if (s < 127) {
          this.grid.insert(Math.min(ax, bx), Math.min(az, bz),
            Math.max(ax, bx), Math.max(az, bz), i * 128 + s);
        }
      }
      cum[pts.length - 1] = acc;
      this.cum[i] = cum;
      this.total[i] = acc;
    }
  }

  /**
   * Finds the closest point on any indexed polyline.
   * @param {number} x Query x.
   * @param {number} z Query z.
   * @param {object} out Result object to fill.
   * @returns {object|null} `out` or null when nothing is in range.
   */
  nearest(x, z, out) {
    let r = this.cell;
    let bestI = -1;
    let bestS = 0;
    let bestT = 0;
    let bestD = Infinity;
    let bestX = 0;
    let bestZ = 0;
    for (let step = 0; step < 7; step++) {
      this.grid.query(x - r, z - r, x + r, z + r, _qhits);
      for (let n = 0; n < _qhits.length; n++) {
        const code = _qhits[n];
        const i = (code / 128) | 0;
        const s = code % 128;
        const pts = this.items[i].pts;
        const ax = pts[s][0];
        const az = pts[s][1];
        const bx = pts[s + 1][0];
        const bz = pts[s + 1][1];
        const dx = bx - ax;
        const dz = bz - az;
        const l2 = dx * dx + dz * dz;
        let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cxp = ax + dx * t;
        const czp = az + dz * t;
        const d = (cxp - x) * (cxp - x) + (czp - z) * (czp - z);
        if (d < bestD) {
          bestD = d;
          bestI = i;
          bestS = s;
          bestT = t;
          bestX = cxp;
          bestZ = czp;
        }
      }
      const found = Math.sqrt(bestD);
      if (bestI >= 0 && found <= r) break;
      if (step === 6) break;
      r *= 2;
    }
    if (bestI < 0) return null;
    const cum = this.cum[bestI];
    const total = this.total[bestI];
    const along = cum[bestS] + (cum[bestS + 1] - cum[bestS]) * bestT;
    out.lane = this.items[bestI];
    out.walk = this.items[bestI];
    out.t = total > 0 ? along / total : 0;
    out.point[0] = bestX;
    out.point[1] = bestZ;
    out.x = bestX;
    out.z = bestZ;
    out.dist = Math.sqrt(bestD);
    return out;
  }
}

/** Per-city caches so repeated queries never rebuild their index. */
const _laneIndex = new WeakMap();
const _walkIndex = new WeakMap();
const _roadIndex = new WeakMap();

/**
 * Lazily builds (and caches) the lane index of a city.
 * @param {object} city City data.
 * @returns {PolyIndex} Index.
 */
function laneIndexOf(city) {
  let idx = _laneIndex.get(city);
  if (idx === undefined) {
    idx = new PolyIndex(city.lanes, 24);
    _laneIndex.set(city, idx);
  }
  return idx;
}

/**
 * Lazily builds (and caches) the sidewalk index of a city.
 * @param {object} city City data.
 * @returns {PolyIndex} Index.
 */
function walkIndexOf(city) {
  let idx = _walkIndex.get(city);
  if (idx === undefined) {
    idx = new PolyIndex(city.walks, 24);
    _walkIndex.set(city, idx);
  }
  return idx;
}

/**
 * Lazily builds (and caches) the asphalt index of a city.
 * @param {object} city City data.
 * @returns {Grid2D} Index of oriented road rectangles.
 */
function roadIndexOf(city) {
  let idx = _roadIndex.get(city);
  if (idx === undefined) {
    const b = city.bounds;
    idx = new Grid2D(b.min[0], b.min[1], b.max[0], b.max[1], HASH_CELL);
    for (const r of city.roads) {
      const dx = r.bx - r.ax;
      const dz = r.bz - r.az;
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      insertBox(idx, {
        x: (r.ax + r.bx) * 0.5,
        z: (r.az + r.bz) * 0.5,
        hx: len * 0.5 + r.width * 0.5,
        hz: r.width * 0.5,
        rot: Math.atan2(dz, dx)
      });
    }
    _roadIndex.set(city, idx);
  }
  return idx;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Generates the complete city layout for a seed.
 *
 * The result is the `CityData` structure defined in docs/ARCHITECTURE.md §7:
 * `{seed, blockSize, roadWidth, blocksX, blocksZ, bounds, districts, roads,
 * nodes, lanes, walks, lots, buildings, props, spawns, landmarks, waterLevel}`.
 * Every `id` equals the object's index in its own array.
 *
 * @param {number} [seed] Deterministic seed.
 * @param {object} [opts] Layout options.
 * @param {number} [opts.blocksX] Block columns (default 14).
 * @param {number} [opts.blocksZ] Block rows (default 14).
 * @param {number} [opts.blockSize] Block edge length in metres (default 64).
 * @param {number} [opts.roadWidth] Standard carriageway width (default 16).
 * @param {boolean} [opts.seaSide] Generate the beach / sea margin (default true).
 * @returns {object} The city data.
 *
 * Fields beyond the contract that consumers may rely on:
 *  - `sidewalkWidth` / `sidewalkHeight` / `buildingSetback`: the metrics this
 *    layout was built with. `worldbuild.js` must use them so kerbs line up.
 *  - `roads[i]`: `lanes` is the total for both directions, `lanesPerDir`,
 *    `kind` ('street'|'avenue'|'boulevard'|'waterfront'|'link'), `edgeId`
 *    (road segments sharing an edge form one logical street), `nodeA`/`nodeB`.
 *  - `nodes[i]`: `edges` (edge ids), `approaches` (arm count).
 *  - `lanes[i]`: `edgeId` (-1 for turn lanes), `index` (0 = innermost),
 *    `offset`, `kind` ('turn' for intersection arcs), `turn`, `fromNode`,
 *    `toNode`.
 *  - `walks[i]`: `twin` (same strip, opposite direction), `edgeId`, `nodeId`.
 *  - `lots[i]`: `x0`/`z0`/`x1`/`z1`, `surface`
 *    ('concrete'|'grass'|'sand'|'asphalt'|'gravel'|'water'), `superblock`,
 *    `name`, `blockI`/`blockJ`.
 *  - `buildings[i]`: `face` (0=+X, 1=+Z, 2=-X, 3=-Z — the side that faces the
 *    street), `districtId`, `landmark`, `name`. Each entry of `signs` is
 *    `{kind:'shopfront'|'vertical'|'roof', text, face, nx, nz, x, z, y, w, h,
 *    color}` with `x`/`z`/`y` the centre of the panel on the wall surface.
 *  - `districts[i].rect`: `x`/`z` is the min corner, plus `x0,z0,x1,z1,cx,cz`.
 *  - `props[i].extra`: type specific (`{onWall, text}` for billboards,
 *    `{kind:'meter'}` for parking meters, `{nodeId, edgeId}` for signals).
 */
export function generateCity(seed = 1337, opts = {}) {
  const ctx = {
    seed: seed | 0,
    blocksX: Math.max(4, opts.blocksX === undefined ? 14 : opts.blocksX | 0),
    blocksZ: Math.max(4, opts.blocksZ === undefined ? 14 : opts.blocksZ | 0),
    blockSize: opts.blockSize === undefined ? 64 : opts.blockSize,
    roadWidth: opts.roadWidth === undefined ? 16 : opts.roadWidth,
    seaSide: opts.seaSide === undefined ? true : !!opts.seaSide
  };

  buildLayout(ctx);
  buildSuperblocks(ctx);
  buildNodesAndEdges(ctx);
  buildDistricts(ctx);
  buildRoads(ctx);
  buildLots(ctx);
  buildBuildings(ctx);
  clipBuildingsToRoads(ctx);
  buildLanes(ctx);
  buildWalks(ctx);
  buildProps(ctx);

  const landmarks = buildLandmarks(ctx);

  for (const d of ctx.districts) delete d.blocks;
  for (const n of ctx.nodes) {
    n.roads.sort((a, b) => a - b);
  }

  const city = {
    seed: ctx.seed,
    blockSize: ctx.blockSize,
    roadWidth: ctx.roadWidth,
    blocksX: ctx.blocksX,
    blocksZ: ctx.blocksZ,
    sidewalkWidth: SIDEWALK_W,
    sidewalkHeight: SIDEWALK_H,
    buildingSetback: BUILDING_SETBACK,
    bounds: ctx.bounds,
    districts: ctx.districts,
    roads: ctx.roads,
    nodes: ctx.nodes,
    lanes: ctx.lanes,
    walks: ctx.walks,
    lots: ctx.lots,
    buildings: ctx.buildings,
    props: ctx.props,
    spawns: null,
    landmarks,
    waterLevel: ctx.waterLevel === undefined ? null : ctx.waterLevel
  };
  city.spawns = buildSpawns(ctx, city);
  return city;
}

/**
 * Finds the closest point on the traffic lane network.
 * @param {object} city City data.
 * @param {number} x World x.
 * @param {number} z World z.
 * @param {object} [out] Optional result object to reuse (avoids allocation).
 * @returns {{lane:object, t:number, point:number[], x:number, z:number, dist:number}|null}
 *   Nearest lane sample, or null when the city has no lanes in range.
 */
export function laneAt(city, x, z, out) {
  const res = out || { lane: null, walk: null, t: 0, point: [0, 0], x: 0, z: 0, dist: 0 };
  if (!res.point) res.point = [0, 0];
  return laneIndexOf(city).nearest(x, z, res);
}

/**
 * Finds the closest point on the pedestrian network.
 * @param {object} city City data.
 * @param {number} x World x.
 * @param {number} z World z.
 * @param {object} [out] Optional result object to reuse (avoids allocation).
 * @returns {{walk:object, t:number, point:number[], x:number, z:number, dist:number}|null}
 *   Nearest sidewalk sample, or null when the city has no walks in range.
 */
export function walkAt(city, x, z, out) {
  const res = out || { lane: null, walk: null, t: 0, point: [0, 0], x: 0, z: 0, dist: 0 };
  if (!res.point) res.point = [0, 0];
  return walkIndexOf(city).nearest(x, z, res);
}

/**
 * Tests whether a world position lies on a carriageway (not the sidewalk).
 * @param {object} city City data.
 * @param {number} x World x.
 * @param {number} z World z.
 * @returns {boolean} True when the point is on asphalt.
 */
export function isOnRoad(city, x, z) {
  const idx = roadIndexOf(city);
  idx.query(x - 0.1, z - 0.1, x + 0.1, z + 0.1, _qhits);
  for (let i = 0; i < _qhits.length; i++) {
    const o = _qhits[i];
    if (obbOverlap(x, z, 0.02, 0.02, 0, o.x, o.z, o.hx, o.hz, o.rot, 0)) return true;
  }
  return false;
}

/**
 * Returns the district covering a world position.
 * @param {object} city City data.
 * @param {number} x World x.
 * @param {number} z World z.
 * @returns {object|null} District, or null outside the playable bounds.
 */
export function districtAt(city, x, z) {
  const b = city.bounds;
  if (x < b.min[0] || x > b.max[0] || z < b.min[1] || z > b.max[1]) return null;
  const ds = city.districts;
  for (let i = 0; i < ds.length; i++) {
    const r = ds[i].rect;
    if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) return ds[i];
  }
  return ds.length > 0 ? ds[districtIndexAt(city, x, z)] : null;
}

/**
 * Summary counters for the loading screen and the debug overlay.
 * @param {object} city City data.
 * @returns {{buildings:number, props:number, lanes:number, walks:number,
 *   roads:number, area:number}} Counts plus the playable area in m².
 */
export function cityStats(city) {
  const b = city.bounds;
  return {
    buildings: city.buildings.length,
    props: city.props.length,
    lanes: city.lanes.length,
    walks: city.walks.length,
    roads: city.roads.length,
    area: (b.max[0] - b.min[0]) * (b.max[1] - b.min[1])
  };
}
