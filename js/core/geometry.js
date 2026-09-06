/**
 * @file Procedural primitive builders and geometry utilities for NEON CITY.
 *
 * Every builder returns a plain "geometry object" that `core/gl.js` consumes directly:
 *
 * ```
 * {
 *   positions: Float32Array,  // xyz per vertex
 *   normals:   Float32Array,  // xyz per vertex, unit length
 *   uvs:       Float32Array,  // uv per vertex
 *   indices:   Uint32Array,   // triangle list
 *   colors?:   Float32Array,  // rgb per vertex (linear), only when requested
 *   bounds:    { min: [x, y, z], max: [x, y, z] }
 * }
 * ```
 *
 * UV conventions (deliberate, tiling textures depend on them):
 * - Large flat surfaces (`box`, `plane`, `wedge`, `extrudePolygon`, `polygonFan`,
 *   `quadStrip`) use WORLD UNITS: one UV unit is one meter times the supplied uv
 *   scale, so a 20 m wall tiles 20 times with `uvScale = 1`.
 * - Curved props (`sphere`, `cylinder`, `cone`, `capsule`, `torus`) use a normalized
 *   0..1 spherical / cylindrical parameterization; `tube` uses 0..1 around the ring
 *   and meters along the path.
 *
 * Units are meters, +Y is up, geometry is centered on the origin unless stated.
 */

import { vec3, mat3 } from './math.js';

/** Position weld tolerance (meters) used when hashing vertices in computeNormals. */
const WELD_TOLERANCE = 1e-4;

/** Cross-product magnitude below which a polygon corner counts as collinear. */
const COLLINEAR_EPS = 1e-9;

/** Generic small number used for divide-by-zero guards. */
const TINY = 1e-12;

/** Quarter turn, used by the rounded-box corner sampling. */
const QUARTER_PI = Math.PI * 0.25;

/** Full turn. */
const TWO_PI = Math.PI * 2;

// --- module scope scratch (never allocate inside the per-vertex loops) ---------
const _n3 = mat3.create();
const _va = vec3.create();
const _vb = vec3.create();
const _vc = vec3.create();
const _e1 = vec3.create();
const _e2 = vec3.create();
const _cross = vec3.create();
/** Reusable index scratch used by the ear clipper. */
const _earIndices = [];
/** Reusable triangle output scratch used by the ear clipper. */
const _earTris = [];

/**
 * Per-face description of the 24 vertex box.
 * `c` holds corner sign triplets in CCW order seen from outside; `uAxis` / `vAxis`
 * select which of [w, h, d] drives the world-space UV extent of that face.
 * @type {Array<{n:number[], uAxis:number, vAxis:number, c:number[][]}>}
 */
const BOX_FACES = [
  { n: [1, 0, 0], uAxis: 2, vAxis: 1, c: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { n: [-1, 0, 0], uAxis: 2, vAxis: 1, c: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { n: [0, 1, 0], uAxis: 0, vAxis: 2, c: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { n: [0, -1, 0], uAxis: 0, vAxis: 2, c: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  { n: [0, 0, 1], uAxis: 0, vAxis: 1, c: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { n: [0, 0, -1], uAxis: 0, vAxis: 1, c: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] }
];

/**
 * Axis descriptors for the rounded box: normal axis + sign and the u/v axes chosen
 * so that cross(uDir, vDir) equals the outward face normal.
 * @type {Array<{a:number, s:number, ua:number, us:number, va:number, vs:number}>}
 */
const ROUNDED_FACES = [
  { a: 0, s: 1, ua: 2, us: -1, va: 1, vs: 1 },
  { a: 0, s: -1, ua: 2, us: 1, va: 1, vs: 1 },
  { a: 1, s: 1, ua: 0, us: 1, va: 2, vs: -1 },
  { a: 1, s: -1, ua: 0, us: 1, va: 2, vs: 1 },
  { a: 2, s: 1, ua: 0, us: 1, va: 1, vs: 1 },
  { a: 2, s: -1, ua: 0, us: -1, va: 1, vs: 1 }
];

// --- internal helpers ---------------------------------------------------------

/**
 * Normalizes a scale option that may be a scalar, a 2 element array or undefined.
 * @param {number|ArrayLike<number>|undefined|null} v Raw option value.
 * @param {number} du Default u scale.
 * @param {number} dv Default v scale.
 * @param {number[]} out Two element array receiving the result.
 * @returns {number[]} out
 */
function scale2(v, du, dv, out) {
  if (typeof v === 'number' && isFinite(v)) {
    out[0] = v;
    out[1] = v;
  } else if (v && typeof v.length === 'number' && v.length >= 2) {
    out[0] = isFinite(v[0]) ? v[0] : du;
    out[1] = isFinite(v[1]) ? v[1] : dv;
  } else {
    out[0] = du;
    out[1] = dv;
  }
  return out;
}

/** Shared destination for scale2 (builders are never re-entrant). */
const _uvScale = [1, 1];

/**
 * Creates a valid but empty geometry object.
 * @returns {object} Geometry with zero-length arrays.
 */
function emptyGeometry() {
  return {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    uvs: new Float32Array(0),
    indices: new Uint32Array(0),
    bounds: { min: [0, 0, 0], max: [0, 0, 0] }
  };
}

/**
 * Packs plain number arrays into a finished geometry object and computes bounds.
 * @param {number[]} pos Positions (xyz triplets).
 * @param {number[]} nrm Normals (xyz triplets).
 * @param {number[]} uv UVs (uv pairs).
 * @param {number[]} idx Triangle indices.
 * @param {number[]|null} [col] Optional per-vertex rgb colors.
 * @returns {object} Geometry object.
 */
function fromArrays(pos, nrm, uv, idx, col) {
  const geo = {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    uvs: new Float32Array(uv),
    indices: new Uint32Array(idx)
  };
  if (col) geo.colors = new Float32Array(col);
  computeBounds(geo);
  return geo;
}

/**
 * Pushes one vertex into plain arrays.
 * @param {number[]} pos Position array.
 * @param {number[]} nrm Normal array.
 * @param {number[]} uv UV array.
 * @param {number} x Position x.
 * @param {number} y Position y.
 * @param {number} z Position z.
 * @param {number} nx Normal x.
 * @param {number} ny Normal y.
 * @param {number} nz Normal z.
 * @param {number} u Texture u.
 * @param {number} v Texture v.
 * @returns {void}
 */
function pushVertex(pos, nrm, uv, x, y, z, nx, ny, nz, u, v) {
  pos.push(x, y, z);
  nrm.push(nx, ny, nz);
  uv.push(u, v);
}

/**
 * Reverses triangle winding and negates normals of a finished geometry, in place.
 * @param {object} geo Geometry to flip.
 * @returns {object} geo
 */
function flipGeometry(geo) {
  const n = geo.normals;
  for (let i = 0; i < n.length; i++) n[i] = -n[i];
  const idx = geo.indices;
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const t = idx[i + 1];
    idx[i + 1] = idx[i + 2];
    idx[i + 2] = t;
  }
  return geo;
}

/**
 * Determinant of the upper-left 3x3 block of a column-major mat4.
 * @param {ArrayLike<number>} m Column-major 4x4 matrix.
 * @returns {number} Determinant, negative when the transform mirrors.
 */
function det3OfMat4(m) {
  return m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[4] * (m[1] * m[10] - m[2] * m[9]) +
    m[8] * (m[1] * m[6] - m[2] * m[5]);
}

// --- primitive builders -------------------------------------------------------

/**
 * Builds an axis-aligned box with 24 vertices (hard per-face normals) and 36 indices.
 * Face UVs are expressed in world meters times `opts.uvScale`, so a 20 m wall tiles
 * 20 times at the default scale of 1.
 * @param {number} w Size along X (meters).
 * @param {number} h Size along Y (meters).
 * @param {number} d Size along Z (meters).
 * @param {object} [opts] Options.
 * @param {number|number[]} [opts.uvScale=[1,1]] UV tiles per meter.
 * @param {number[]} [opts.center=[0,0,0]] Center offset applied to every vertex.
 * @returns {object} Geometry object.
 */
export function box(w, h, d, opts = {}) {
  scale2(opts.uvScale, 1, 1, _uvScale);
  const su = _uvScale[0];
  const sv = _uvScale[1];
  const c = opts.center;
  const cx = c ? (c[0] || 0) : 0;
  const cy = c ? (c[1] || 0) : 0;
  const cz = c ? (c[2] || 0) : 0;
  const hw = w * 0.5;
  const hh = h * 0.5;
  const hd = d * 0.5;
  const size = [w, h, d];

  const positions = new Float32Array(72);
  const normals = new Float32Array(72);
  const uvs = new Float32Array(48);
  const indices = new Uint32Array(36);

  let vp = 0;
  let up = 0;
  let ip = 0;
  let base = 0;
  for (let f = 0; f < 6; f++) {
    const face = BOX_FACES[f];
    const nx = face.n[0];
    const ny = face.n[1];
    const nz = face.n[2];
    const uExtent = size[face.uAxis] * su;
    const vExtent = size[face.vAxis] * sv;
    for (let k = 0; k < 4; k++) {
      const sgn = face.c[k];
      positions[vp] = cx + sgn[0] * hw;
      positions[vp + 1] = cy + sgn[1] * hh;
      positions[vp + 2] = cz + sgn[2] * hd;
      normals[vp] = nx;
      normals[vp + 1] = ny;
      normals[vp + 2] = nz;
      vp += 3;
      // corner order is (0,0) (1,0) (1,1) (0,1)
      uvs[up] = (k === 1 || k === 2) ? uExtent : 0;
      uvs[up + 1] = (k === 2 || k === 3) ? vExtent : 0;
      up += 2;
    }
    indices[ip] = base;
    indices[ip + 1] = base + 1;
    indices[ip + 2] = base + 2;
    indices[ip + 3] = base;
    indices[ip + 4] = base + 2;
    indices[ip + 5] = base + 3;
    ip += 6;
    base += 4;
  }

  const geo = { positions, normals, uvs, indices };
  computeBounds(geo);
  return geo;
}

/**
 * Builds one axis sample list for the rounded box: the corner arc is sampled by
 * uniform angle (tangent spaced) so the projected corners are evenly curved, and
 * the flat middle span contributes a single quad.
 * @param {number} half Half extent of the axis (meters).
 * @param {number} r Corner radius (meters).
 * @param {number} segments Arc subdivisions per corner.
 * @returns {number[]} Ascending coordinates from -half to +half.
 */
function roundedAxisSamples(half, r, segments) {
  const inner = Math.max(0, half - r);
  const list = [];
  for (let j = 0; j <= segments; j++) {
    const t = (segments - j) / segments;
    const off = t >= 1 ? r : r * Math.tan(t * QUARTER_PI);
    list.push(-inner - off);
  }
  for (let j = 0; j <= segments; j++) {
    const t = j / segments;
    const off = t >= 1 ? r : r * Math.tan(t * QUARTER_PI);
    list.push(inner + off);
  }
  // Drop coordinates that collapse onto their predecessor (radius == half extent).
  const out = [list[0]];
  for (let i = 1; i < list.length; i++) {
    if (Math.abs(list[i] - out[out.length - 1]) > 1e-9) out.push(list[i]);
  }
  return out;
}

/**
 * Builds a box with real rounded corners: a subdivided cube whose vertices are
 * clamped to the inner box and pushed back out onto the rounded surface, so edges
 * and corners share exact positions and normals (no seams between faces).
 * @param {number} w Size along X (meters).
 * @param {number} h Size along Y (meters).
 * @param {number} d Size along Z (meters).
 * @param {number} radius Corner radius, clamped to half of the smallest extent.
 * @param {number} [segments=3] Arc subdivisions per corner (>= 1).
 * @returns {object} Geometry object with per-face 0..1 UVs.
 */
export function roundedBox(w, h, d, radius, segments = 3) {
  const half = [w * 0.5, h * 0.5, d * 0.5];
  const maxR = Math.min(half[0], half[1], half[2]);
  const r = Math.max(0, Math.min(radius, maxR));
  if (r < 1e-5) return box(w, h, d);
  const seg = Math.max(1, Math.floor(segments));
  const inner = [Math.max(0, half[0] - r), Math.max(0, half[1] - r), Math.max(0, half[2] - r)];
  const samples = [
    roundedAxisSamples(half[0], r, seg),
    roundedAxisSamples(half[1], r, seg),
    roundedAxisSamples(half[2], r, seg)
  ];

  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const p = [0, 0, 0];
  const q = [0, 0, 0];

  for (let f = 0; f < 6; f++) {
    const face = ROUNDED_FACES[f];
    const uList = samples[face.ua];
    const vList = samples[face.va];
    const nu = uList.length;
    const nv = vList.length;
    const uSpan = half[face.ua] * 2;
    const vSpan = half[face.va] * 2;
    const base = positions.length / 3;
    for (let iv = 0; iv < nv; iv++) {
      const vc = vList[face.vs > 0 ? iv : nv - 1 - iv];
      for (let iu = 0; iu < nu; iu++) {
        const uc = uList[face.us > 0 ? iu : nu - 1 - iu];
        p[face.a] = face.s * half[face.a];
        p[face.ua] = uc;
        p[face.va] = vc;
        q[0] = Math.max(-inner[0], Math.min(inner[0], p[0]));
        q[1] = Math.max(-inner[1], Math.min(inner[1], p[1]));
        q[2] = Math.max(-inner[2], Math.min(inner[2], p[2]));
        let dx = p[0] - q[0];
        let dy = p[1] - q[1];
        let dz = p[2] - q[2];
        let len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < TINY) {
          dx = face.a === 0 ? face.s : 0;
          dy = face.a === 1 ? face.s : 0;
          dz = face.a === 2 ? face.s : 0;
          len = 1;
        }
        dx /= len;
        dy /= len;
        dz /= len;
        const u = uSpan > TINY ? (uc * face.us + half[face.ua]) / uSpan : 0;
        const v = vSpan > TINY ? (vc * face.vs + half[face.va]) / vSpan : 0;
        pushVertex(positions, normals, uvs,
          q[0] + dx * r, q[1] + dy * r, q[2] + dz * r,
          dx, dy, dz, u, v);
      }
    }
    for (let iv = 0; iv < nv - 1; iv++) {
      for (let iu = 0; iu < nu - 1; iu++) {
        const a = base + iv * nu + iu;
        const b = a + 1;
        const cIdx = a + nu + 1;
        const dIdx = a + nu;
        indices.push(a, b, dIdx, b, cIdx, dIdx);
      }
    }
  }

  return fromArrays(positions, normals, uvs, indices, null);
}

/**
 * Builds a flat grid facing +Y, centered on the origin.
 * UVs are world meters times `uvScale` so terrain and roads tile consistently.
 * @param {number} w Size along X (meters).
 * @param {number} d Size along Z (meters).
 * @param {number} [segX=1] Subdivisions along X (>= 1).
 * @param {number} [segZ=1] Subdivisions along Z (>= 1).
 * @param {number|number[]} [uvScale=[1,1]] UV tiles per meter.
 * @returns {object} Geometry object.
 */
export function plane(w, d, segX = 1, segZ = 1, uvScale = [1, 1]) {
  const sx = Math.max(1, Math.floor(segX));
  const sz = Math.max(1, Math.floor(segZ));
  scale2(uvScale, 1, 1, _uvScale);
  const su = _uvScale[0];
  const sv = _uvScale[1];
  const hw = w * 0.5;
  const hd = d * 0.5;
  const vertCount = (sx + 1) * (sz + 1);
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices = new Uint32Array(sx * sz * 6);

  let vp = 0;
  let up = 0;
  for (let j = 0; j <= sz; j++) {
    const tz = j / sz;
    const z = -hd + d * tz;
    for (let i = 0; i <= sx; i++) {
      const tx = i / sx;
      const x = -hw + w * tx;
      positions[vp] = x;
      positions[vp + 1] = 0;
      positions[vp + 2] = z;
      normals[vp] = 0;
      normals[vp + 1] = 1;
      normals[vp + 2] = 0;
      vp += 3;
      uvs[up] = (x + hw) * su;
      uvs[up + 1] = (z + hd) * sv;
      up += 2;
    }
  }
  let ip = 0;
  for (let j = 0; j < sz; j++) {
    for (let i = 0; i < sx; i++) {
      const a = j * (sx + 1) + i;
      const b = a + 1;
      const c = a + sx + 2;
      const e = a + sx + 1;
      indices[ip] = a;
      indices[ip + 1] = c;
      indices[ip + 2] = b;
      indices[ip + 3] = a;
      indices[ip + 4] = e;
      indices[ip + 5] = c;
      ip += 6;
    }
  }

  const geo = { positions, normals, uvs, indices };
  computeBounds(geo);
  return geo;
}
