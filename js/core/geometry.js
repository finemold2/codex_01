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

/**
 * Builds a UV sphere centered on the origin. The seam column is duplicated so the
 * 0..1 spherical UVs never wrap, and pole rows keep per-column u to avoid pinching.
 * @param {number} radius Radius (meters).
 * @param {number} [widthSeg=16] Segments around the equator (>= 3).
 * @param {number} [heightSeg=12] Segments from pole to pole (>= 2).
 * @returns {object} Geometry object.
 */
export function sphere(radius, widthSeg = 16, heightSeg = 12) {
  const ws = Math.max(3, Math.floor(widthSeg));
  const hs = Math.max(2, Math.floor(heightSeg));
  const vertCount = (ws + 1) * (hs + 1);
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices = new Uint32Array(ws * (hs - 1) * 6 + ws * 6);

  let vp = 0;
  let up = 0;
  for (let j = 0; j <= hs; j++) {
    const theta = (j / hs) * Math.PI;
    const st = Math.sin(theta);
    const ct = Math.cos(theta);
    for (let i = 0; i <= ws; i++) {
      const phi = (i / ws) * TWO_PI;
      const nx = st * Math.sin(phi);
      const ny = ct;
      const nz = st * Math.cos(phi);
      positions[vp] = nx * radius;
      positions[vp + 1] = ny * radius;
      positions[vp + 2] = nz * radius;
      normals[vp] = nx;
      normals[vp + 1] = ny;
      normals[vp + 2] = nz;
      vp += 3;
      uvs[up] = i / ws;
      uvs[up + 1] = 1 - j / hs;
      up += 2;
    }
  }
  let ip = 0;
  for (let j = 0; j < hs; j++) {
    for (let i = 0; i < ws; i++) {
      const a = j * (ws + 1) + i;
      const b = a + 1;
      const c = b + ws + 1;
      const dIdx = a + ws + 1;
      if (j !== 0) {
        indices[ip] = a;
        indices[ip + 1] = dIdx;
        indices[ip + 2] = b;
        ip += 3;
      }
      if (j !== hs - 1) {
        indices[ip] = b;
        indices[ip + 1] = dIdx;
        indices[ip + 2] = c;
        ip += 3;
      }
    }
  }

  const geo = {
    positions,
    normals,
    uvs,
    indices: ip === indices.length ? indices : indices.slice(0, ip)
  };
  computeBounds(geo);
  return geo;
}

/**
 * Builds a cylinder / truncated cone around the Y axis, centered on the origin.
 * Side UVs are 0..1 around the circumference and 0..1 along the height; caps use a
 * 0..1 disc projection. A zero radius end produces a proper apex with no cap.
 * @param {number} rTop Top radius (meters, may be 0).
 * @param {number} rBottom Bottom radius (meters, may be 0).
 * @param {number} height Height along Y (meters).
 * @param {number} [radialSeg=16] Segments around the axis (>= 3).
 * @param {boolean} [capped=true] Whether to add the end discs.
 * @returns {object} Geometry object.
 */
export function cylinder(rTop, rBottom, height, radialSeg = 16, capped = true) {
  const seg = Math.max(3, Math.floor(radialSeg));
  const hh = height * 0.5;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const slope = rBottom - rTop;
  const nScale = 1 / Math.max(TINY, Math.sqrt(slope * slope + height * height));
  const topApex = Math.abs(rTop) < TINY;
  const bottomApex = Math.abs(rBottom) < TINY;

  // Side wall: ring 0 at the bottom, ring 1 at the top.
  for (let j = 0; j < 2; j++) {
    const r = j === 0 ? rBottom : rTop;
    const y = j === 0 ? -hh : hh;
    for (let i = 0; i <= seg; i++) {
      const phi = (i / seg) * TWO_PI;
      const sp = Math.sin(phi);
      const cp = Math.cos(phi);
      pushVertex(positions, normals, uvs,
        sp * r, y, cp * r,
        sp * height * nScale, slope * nScale, cp * height * nScale,
        i / seg, j);
    }
  }
  const rowB = seg + 1;
  for (let i = 0; i < seg; i++) {
    const a = i;
    const b = i + 1;
    const d = rowB + i;
    const c = rowB + i + 1;
    if (!bottomApex) indices.push(a, b, d);
    if (!topApex) indices.push(b, c, d);
  }

  if (capped && !topApex) {
    const base = positions.length / 3;
    pushVertex(positions, normals, uvs, 0, hh, 0, 0, 1, 0, 0.5, 0.5);
    for (let i = 0; i <= seg; i++) {
      const phi = (i / seg) * TWO_PI;
      const sp = Math.sin(phi);
      const cp = Math.cos(phi);
      pushVertex(positions, normals, uvs,
        sp * rTop, hh, cp * rTop, 0, 1, 0,
        0.5 + sp * 0.5, 0.5 + cp * 0.5);
    }
    for (let i = 0; i < seg; i++) indices.push(base, base + 1 + i, base + 2 + i);
  }
  if (capped && !bottomApex) {
    const base = positions.length / 3;
    pushVertex(positions, normals, uvs, 0, -hh, 0, 0, -1, 0, 0.5, 0.5);
    for (let i = 0; i <= seg; i++) {
      const phi = (i / seg) * TWO_PI;
      const sp = Math.sin(phi);
      const cp = Math.cos(phi);
      pushVertex(positions, normals, uvs,
        sp * rBottom, -hh, cp * rBottom, 0, -1, 0,
        0.5 + sp * 0.5, 0.5 - cp * 0.5);
    }
    for (let i = 0; i < seg; i++) indices.push(base, base + 2 + i, base + 1 + i);
  }

  return fromArrays(positions, normals, uvs, indices, null);
}

/**
 * Builds a cone with the apex at +height/2 and the base disc at -height/2.
 * @param {number} radius Base radius (meters).
 * @param {number} height Height along Y (meters).
 * @param {number} [radialSeg=16] Segments around the axis (>= 3).
 * @returns {object} Geometry object.
 */
export function cone(radius, height, radialSeg = 16) {
  return cylinder(0, radius, height, radialSeg, true);
}

/**
 * Builds a capsule aligned to the Y axis and centered on the origin.
 * `height` is the length of the straight middle section, so the total height is
 * `height + 2 * radius`. V runs 0..1 along the profile by arc length, so the caps
 * are not stretched relative to the barrel.
 * @param {number} radius Cap radius (meters).
 * @param {number} height Length of the cylindrical middle (meters, >= 0).
 * @param {number} [radialSeg=12] Segments around the axis (>= 3).
 * @param {number} [capSeg=6] Rings per hemispherical cap (>= 1).
 * @returns {object} Geometry object.
 */
export function capsule(radius, height, radialSeg = 12, capSeg = 6) {
  const seg = Math.max(3, Math.floor(radialSeg));
  const caps = Math.max(1, Math.floor(capSeg));
  const h = Math.max(0, height);
  const hh = h * 0.5;
  const rows = [];
  // Top hemisphere: theta 0 (north pole) down to PI/2 (top of the barrel).
  for (let j = 0; j <= caps; j++) {
    const theta = (j / caps) * (Math.PI * 0.5);
    rows.push({ st: Math.sin(theta), ct: Math.cos(theta), yOff: hh });
  }
  // Bottom hemisphere: theta PI/2 (bottom of the barrel) down to PI (south pole).
  for (let j = 0; j <= caps; j++) {
    const theta = Math.PI * 0.5 + (j / caps) * (Math.PI * 0.5);
    rows.push({ st: Math.sin(theta), ct: Math.cos(theta), yOff: -hh });
  }
  const rowCount = rows.length;
  // Arc length parameterization for v (measured from the south pole upwards).
  const vs = new Array(rowCount);
  const total = Math.PI * radius + h;
  for (let j = 0; j < rowCount; j++) {
    const r = rows[j];
    const capArc = Math.acos(Math.max(-1, Math.min(1, r.ct))) * radius;
    const dist = r.yOff > 0
      ? (Math.PI * radius * 0.5 + h + (Math.PI * radius * 0.5 - capArc))
      : (Math.PI * radius - capArc);
    vs[j] = total > TINY ? dist / total : 0;
  }

  const vertCount = rowCount * (seg + 1);
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices = [];
  let vp = 0;
  let up = 0;
  for (let j = 0; j < rowCount; j++) {
    const row = rows[j];
    for (let i = 0; i <= seg; i++) {
      const phi = (i / seg) * TWO_PI;
      const nx = row.st * Math.sin(phi);
      const ny = row.ct;
      const nz = row.st * Math.cos(phi);
      positions[vp] = nx * radius;
      positions[vp + 1] = ny * radius + row.yOff;
      positions[vp + 2] = nz * radius;
      normals[vp] = nx;
      normals[vp + 1] = ny;
      normals[vp + 2] = nz;
      vp += 3;
      uvs[up] = i / seg;
      uvs[up + 1] = vs[j];
      up += 2;
    }
  }
  const stride = seg + 1;
  for (let j = 0; j < rowCount - 1; j++) {
    const northPole = j === 0;
    const southPole = j === rowCount - 2;
    for (let i = 0; i < seg; i++) {
      const a = j * stride + i;
      const b = a + 1;
      const d = a + stride;
      const c = d + 1;
      if (!northPole) indices.push(a, d, b);
      if (!southPole) indices.push(b, d, c);
    }
  }

  const geo = { positions, normals, uvs, indices: new Uint32Array(indices) };
  computeBounds(geo);
  return geo;
}

/**
 * Builds a torus lying in the XZ plane (its axis is +Y), centered on the origin.
 * @param {number} radius Distance from the center to the tube center (meters).
 * @param {number} tube Tube radius (meters).
 * @param {number} [radialSeg=16] Segments around the tube cross-section (>= 3).
 * @param {number} [tubularSeg=24] Segments around the main ring (>= 3).
 * @returns {object} Geometry object with 0..1 UVs (u around the ring).
 */
export function torus(radius, tube, radialSeg = 16, tubularSeg = 24) {
  const rs = Math.max(3, Math.floor(radialSeg));
  const ts = Math.max(3, Math.floor(tubularSeg));
  const vertCount = (rs + 1) * (ts + 1);
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices = new Uint32Array(rs * ts * 6);

  let vp = 0;
  let up = 0;
  for (let i = 0; i <= ts; i++) {
    const u = (i / ts) * TWO_PI;
    const su = Math.sin(u);
    const cu = Math.cos(u);
    for (let j = 0; j <= rs; j++) {
      const v = (j / rs) * TWO_PI;
      const sv = Math.sin(v);
      const cv = Math.cos(v);
      const nx = cv * su;
      const ny = sv;
      const nz = cv * cu;
      positions[vp] = su * radius + nx * tube;
      positions[vp + 1] = ny * tube;
      positions[vp + 2] = cu * radius + nz * tube;
      normals[vp] = nx;
      normals[vp + 1] = ny;
      normals[vp + 2] = nz;
      vp += 3;
      uvs[up] = i / ts;
      uvs[up + 1] = j / rs;
      up += 2;
    }
  }
  let ip = 0;
  const stride = rs + 1;
  for (let i = 0; i < ts; i++) {
    for (let j = 0; j < rs; j++) {
      const a = i * stride + j;
      const b = a + stride;
      const c = b + 1;
      const d = a + 1;
      indices[ip] = a;
      indices[ip + 1] = b;
      indices[ip + 2] = d;
      indices[ip + 3] = b;
      indices[ip + 4] = c;
      indices[ip + 5] = d;
      ip += 6;
    }
  }

  const geo = { positions, normals, uvs, indices };
  computeBounds(geo);
  return geo;
}

/**
 * Builds a right-triangle prism (ramp) centered on the origin. The ramp surface
 * rises from y = -h/2 at z = +d/2 to y = +h/2 at z = -d/2, so it faces +Z and +Y.
 * UVs are world meters (scale 1).
 * @param {number} w Width along X (meters).
 * @param {number} h Height along Y (meters).
 * @param {number} d Depth along Z (meters).
 * @returns {object} Geometry object (18 vertices, 8 triangles).
 */
export function wedge(w, h, d) {
  const hw = w * 0.5;
  const hh = h * 0.5;
  const hd = d * 0.5;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const slantLen = Math.sqrt(h * h + d * d);
  const rampNy = slantLen > TINY ? d / slantLen : 0;
  const rampNz = slantLen > TINY ? h / slantLen : 1;

  // Bottom face (-Y).
  let base = 0;
  pushVertex(positions, normals, uvs, -hw, -hh, -hd, 0, -1, 0, 0, 0);
  pushVertex(positions, normals, uvs, hw, -hh, -hd, 0, -1, 0, w, 0);
  pushVertex(positions, normals, uvs, hw, -hh, hd, 0, -1, 0, w, d);
  pushVertex(positions, normals, uvs, -hw, -hh, hd, 0, -1, 0, 0, d);
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);

  // Back face (-Z), the tall vertical wall.
  base = positions.length / 3;
  pushVertex(positions, normals, uvs, hw, -hh, -hd, 0, 0, -1, 0, 0);
  pushVertex(positions, normals, uvs, -hw, -hh, -hd, 0, 0, -1, w, 0);
  pushVertex(positions, normals, uvs, -hw, hh, -hd, 0, 0, -1, w, h);
  pushVertex(positions, normals, uvs, hw, hh, -hd, 0, 0, -1, 0, h);
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);

  // Ramp face (+Z / +Y).
  base = positions.length / 3;
  pushVertex(positions, normals, uvs, -hw, -hh, hd, 0, rampNy, rampNz, 0, 0);
  pushVertex(positions, normals, uvs, hw, -hh, hd, 0, rampNy, rampNz, w, 0);
  pushVertex(positions, normals, uvs, hw, hh, -hd, 0, rampNy, rampNz, w, slantLen);
  pushVertex(positions, normals, uvs, -hw, hh, -hd, 0, rampNy, rampNz, 0, slantLen);
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);

  // Right side triangle (+X).
  base = positions.length / 3;
  pushVertex(positions, normals, uvs, hw, -hh, hd, 1, 0, 0, 0, 0);
  pushVertex(positions, normals, uvs, hw, -hh, -hd, 1, 0, 0, d, 0);
  pushVertex(positions, normals, uvs, hw, hh, -hd, 1, 0, 0, d, h);
  indices.push(base, base + 1, base + 2);

  // Left side triangle (-X).
  base = positions.length / 3;
  pushVertex(positions, normals, uvs, -hw, -hh, -hd, -1, 0, 0, 0, 0);
  pushVertex(positions, normals, uvs, -hw, -hh, hd, -1, 0, 0, d, 0);
  pushVertex(positions, normals, uvs, -hw, hh, -hd, -1, 0, 0, 0, h);
  indices.push(base, base + 1, base + 2);

  return fromArrays(positions, normals, uvs, indices, null);
}
