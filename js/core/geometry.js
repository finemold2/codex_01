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

// --- polygon triangulation ----------------------------------------------------

/**
 * Signed area of a 2D polygon using the shoelace formula.
 * Positive means the loop is counter-clockwise in (x, z) parameter space.
 * @param {ArrayLike<ArrayLike<number>>} pts Polygon points as [x, z] pairs.
 * @returns {number} Signed area (square meters).
 */
function polygonSignedArea(pts) {
  let a = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a * 0.5;
}

/**
 * Point in triangle test for a positively oriented triangle (boundary counts as in).
 * @param {number} ax Triangle a.x.
 * @param {number} az Triangle a.z.
 * @param {number} bx Triangle b.x.
 * @param {number} bz Triangle b.z.
 * @param {number} cx Triangle c.x.
 * @param {number} cz Triangle c.z.
 * @param {number} px Query x.
 * @param {number} pz Query z.
 * @returns {boolean} True when the point is inside or on the triangle.
 */
function pointInTriangle(ax, az, bx, bz, cx, cz, px, pz) {
  const d1 = (bx - ax) * (pz - az) - (bz - az) * (px - ax);
  if (d1 < 0) return false;
  const d2 = (cx - bx) * (pz - bz) - (cz - bz) * (px - bx);
  if (d2 < 0) return false;
  const d3 = (ax - cx) * (pz - cz) - (az - cz) * (px - cx);
  return d3 >= 0;
}

/**
 * Ear clipping triangulation for simple polygons, concave included.
 * Input winding does not matter: the traversal is normalized so every emitted
 * triple is positively oriented in the (x, z) shoelace sense. Collinear and
 * duplicated corners are dropped without emitting degenerate triangles, and a
 * forced-progress fallback guarantees termination on malformed input.
 * @param {ArrayLike<ArrayLike<number>>} pts Polygon points as [x, z] pairs.
 * @param {number[]} out Array receiving flat index triples (cleared first).
 * @returns {number[]} out
 */
function earClipPolygon(pts, out) {
  out.length = 0;
  const n = pts.length;
  if (n < 3) return out;
  const v = _earIndices;
  v.length = 0;
  if (polygonSignedArea(pts) >= 0) {
    for (let i = 0; i < n; i++) v.push(i);
  } else {
    for (let i = n - 1; i >= 0; i--) v.push(i);
  }

  let count = v.length;
  let i = 0;
  let attempts = 0;
  while (count > 3) {
    if (i >= count) i = 0;
    const pi = (i + count - 1) % count;
    const ni = (i + 1) % count;
    const a = pts[v[pi]];
    const b = pts[v[i]];
    const c = pts[v[ni]];
    const ax = a[0], az = a[1];
    const bx = b[0], bz = b[1];
    const cx = c[0], cz = c[1];
    const cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    let clip = false;
    let emit = false;
    if (cross > COLLINEAR_EPS) {
      let blocked = false;
      for (let k = 0; k < count; k++) {
        if (k === pi || k === i || k === ni) continue;
        const p = pts[v[k]];
        const px = p[0];
        const pz = p[1];
        if ((px === ax && pz === az) || (px === bx && pz === bz) || (px === cx && pz === cz)) continue;
        if (pointInTriangle(ax, az, bx, bz, cx, cz, px, pz)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        clip = true;
        emit = true;
      }
    } else if (cross > -COLLINEAR_EPS) {
      // Collinear or duplicated corner: remove it, it carries no area.
      clip = true;
    }
    if (!clip && attempts >= count * 3) {
      // Self-intersecting or otherwise broken input: force progress.
      clip = true;
      emit = cross > COLLINEAR_EPS;
    }
    if (clip) {
      if (emit) out.push(v[pi], v[i], v[ni]);
      v.splice(i, 1);
      count--;
      attempts = 0;
      i = i > 0 ? i - 1 : count - 1;
    } else {
      i++;
      attempts++;
    }
  }
  if (count === 3) {
    const a = pts[v[0]];
    const b = pts[v[1]];
    const c = pts[v[2]];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(cross) > COLLINEAR_EPS) out.push(v[0], v[1], v[2]);
  }
  return out;
}

/**
 * Copies a polygon dropping consecutive duplicate points and forcing positive
 * (counter-clockwise in shoelace terms) orientation.
 * @param {ArrayLike<ArrayLike<number>>} src Source points as [x, z] pairs.
 * @returns {number[][]} Cleaned polygon, may hold fewer than 3 points.
 */
function preparePolygon(src) {
  const poly = [];
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const p = src[i];
    if (!p || !isFinite(p[0]) || !isFinite(p[1])) continue;
    const last = poly[poly.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 1e-9 && Math.abs(last[1] - p[1]) < 1e-9) continue;
    poly.push([p[0], p[1]]);
  }
  while (poly.length > 1) {
    const first = poly[0];
    const last = poly[poly.length - 1];
    if (Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9) poly.pop();
    else break;
  }
  if (poly.length >= 3 && polygonSignedArea(poly) < 0) poly.reverse();
  return poly;
}

/**
 * Extrudes a 2D polygon (XZ plane) vertically into a prism.
 * Side walls get exact per-quad normals, u equal to the perimeter arc length in
 * meters and v equal to the height in meters (both times `opts.uvScale`); caps are
 * ear-clipped and use world-space planar UVs.
 * @param {ArrayLike<ArrayLike<number>>} points2d Footprint as [x, z] pairs, any winding.
 * @param {number} height Extrusion height; negative extrudes below `baseY`.
 * @param {object} [opts] Options.
 * @param {boolean} [opts.capTop=true] Build the top cap.
 * @param {boolean} [opts.capBottom=false] Build the bottom cap.
 * @param {number|number[]} [opts.uvScale=[1,1]] UV tiles per meter.
 * @param {number} [opts.baseY=0] World Y of the base.
 * @param {number} [opts.taper=0] 0..1 shrink of the top outline toward the centroid.
 * @param {boolean} [opts.flipNormals=false] Invert winding and normals (interiors).
 * @returns {object} Geometry object.
 */
export function extrudePolygon(points2d, height, opts = {}) {
  if (!points2d || points2d.length < 3) return emptyGeometry();
  const poly = preparePolygon(points2d);
  const n = poly.length;
  if (n < 3) return emptyGeometry();

  const capTop = opts.capTop !== false;
  const capBottom = opts.capBottom === true;
  const baseY = isFinite(opts.baseY) ? opts.baseY : 0;
  const taper = Math.max(0, Math.min(1, isFinite(opts.taper) ? opts.taper : 0));
  const flip = opts.flipNormals === true;
  scale2(opts.uvScale, 1, 1, _uvScale);
  const su = _uvScale[0];
  const sv = _uvScale[1];
  const h = isFinite(height) ? height : 0;
  const y0 = h >= 0 ? baseY : baseY + h;
  const y1 = h >= 0 ? baseY + h : baseY;
  const wallH = Math.abs(h);

  // Area centroid, used as the taper pivot.
  let a2 = 0;
  let cxs = 0;
  let czs = 0;
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const cr = p[0] * q[1] - q[0] * p[1];
    a2 += cr;
    cxs += (p[0] + q[0]) * cr;
    czs += (p[1] + q[1]) * cr;
  }
  let cx = 0;
  let cz = 0;
  if (Math.abs(a2) > TINY) {
    cx = cxs / (3 * a2);
    cz = czs / (3 * a2);
  } else {
    for (let i = 0; i < n; i++) {
      cx += poly[i][0];
      cz += poly[i][1];
    }
    cx /= n;
    cz /= n;
  }
  const k = 1 - taper;
  const top = new Array(n);
  for (let i = 0; i < n; i++) {
    top[i] = [cx + (poly[i][0] - cx) * k, cz + (poly[i][1] - cz) * k];
  }
  const topCollapsed = taper > 1 - 1e-6;

  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  // Side walls.
  if (wallH > TINY) {
    let perim = 0;
    for (let i = 0; i < n; i++) {
      const i1 = (i + 1) % n;
      const b0x = poly[i][0];
      const b0z = poly[i][1];
      const b1x = poly[i1][0];
      const b1z = poly[i1][1];
      const t0x = top[i][0];
      const t0z = top[i][1];
      const t1x = top[i1][0];
      const t1z = top[i1][1];
      const ex = b1x - b0x;
      const ez = b1z - b0z;
      const edgeLen = Math.sqrt(ex * ex + ez * ez);
      if (edgeLen < 1e-9) continue;
      // Exact face normal from the (planar) trapezoid.
      const ux = t0x - b0x;
      const uy = y1 - y0;
      const uz = t0z - b0z;
      const wx = t1x - b0x;
      const wy = y1 - y0;
      const wz = t1z - b0z;
      let nx = uy * wz - uz * wy;
      let ny = uz * wx - ux * wz;
      let nz = ux * wy - uy * wx;
      let nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl < TINY) {
        nx = ez;
        ny = 0;
        nz = -ex;
        nl = edgeLen;
      }
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const u0 = perim * su;
      const u1 = (perim + edgeLen) * su;
      const vTop = wallH * sv;
      const base = positions.length / 3;
      pushVertex(positions, normals, uvs, b0x, y0, b0z, nx, ny, nz, u0, 0);
      pushVertex(positions, normals, uvs, b1x, y0, b1z, nx, ny, nz, u1, 0);
      pushVertex(positions, normals, uvs, t1x, y1, t1z, nx, ny, nz, u1, vTop);
      pushVertex(positions, normals, uvs, t0x, y1, t0z, nx, ny, nz, u0, vTop);
      const topDegenerate = Math.abs(t1x - t0x) < 1e-9 && Math.abs(t1z - t0z) < 1e-9;
      if (!topDegenerate) indices.push(base, base + 3, base + 2);
      indices.push(base, base + 2, base + 1);
      perim += edgeLen;
    }
  }

  // Caps.
  if ((capTop && !topCollapsed) || capBottom) {
    const tris = earClipPolygon(poly, _earTris);
    if (capBottom) {
      const base = positions.length / 3;
      for (let i = 0; i < n; i++) {
        pushVertex(positions, normals, uvs,
          poly[i][0], y0, poly[i][1], 0, -1, 0,
          poly[i][0] * su, poly[i][1] * sv);
      }
      for (let t = 0; t < tris.length; t += 3) {
        indices.push(base + tris[t], base + tris[t + 1], base + tris[t + 2]);
      }
    }
    if (capTop && !topCollapsed) {
      const base = positions.length / 3;
      for (let i = 0; i < n; i++) {
        pushVertex(positions, normals, uvs,
          top[i][0], y1, top[i][1], 0, 1, 0,
          top[i][0] * su, top[i][1] * sv);
      }
      for (let t = 0; t < tris.length; t += 3) {
        indices.push(base + tris[t], base + tris[t + 2], base + tris[t + 1]);
      }
    }
  }

  const geo = fromArrays(positions, normals, uvs, indices, null);
  if (flip) flipGeometry(geo);
  return geo;
}

/**
 * Builds a flat, ear-clipped polygon cap facing +Y at the given height.
 * UVs are world meters (x, z).
 * @param {ArrayLike<ArrayLike<number>>} points2d Outline as [x, z] pairs, any winding.
 * @param {number} [y=0] World height of the cap.
 * @returns {object} Geometry object.
 */
export function polygonFan(points2d, y = 0) {
  if (!points2d || points2d.length < 3) return emptyGeometry();
  const poly = preparePolygon(points2d);
  const n = poly.length;
  if (n < 3) return emptyGeometry();
  const tris = earClipPolygon(poly, _earTris);
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const uvs = new Float32Array(n * 2);
  const indices = new Uint32Array(tris.length);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = poly[i][0];
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = poly[i][1];
    normals[i * 3] = 0;
    normals[i * 3 + 1] = 1;
    normals[i * 3 + 2] = 0;
    uvs[i * 2] = poly[i][0];
    uvs[i * 2 + 1] = poly[i][1];
  }
  for (let t = 0; t < tris.length; t += 3) {
    indices[t] = tris[t];
    indices[t + 1] = tris[t + 2];
    indices[t + 2] = tris[t + 1];
  }
  const geo = { positions, normals, uvs, indices };
  computeBounds(geo);
  return geo;
}

/**
 * Sweeps a circle along a 3D poly-line using parallel-transport frames, so the
 * tube never twists or flips even on sharp bends. Flat caps close both ends.
 * U runs 0..1 around the ring, V is the path arc length in meters.
 * @param {ArrayLike<ArrayLike<number>>} pathPoints3d Path as [x, y, z] triples.
 * @param {number} radius Tube radius (meters).
 * @param {number} [radialSeg=8] Segments around the tube (>= 3).
 * @returns {object} Geometry object.
 */
export function tube(pathPoints3d, radius, radialSeg = 8) {
  if (!pathPoints3d || pathPoints3d.length < 2) return emptyGeometry();
  const seg = Math.max(3, Math.floor(radialSeg));
  const path = [];
  for (let i = 0; i < pathPoints3d.length; i++) {
    const p = pathPoints3d[i];
    if (!p || !isFinite(p[0]) || !isFinite(p[1]) || !isFinite(p[2])) continue;
    const last = path[path.length - 1];
    if (last) {
      const dx = p[0] - last[0];
      const dy = p[1] - last[1];
      const dz = p[2] - last[2];
      if (dx * dx + dy * dy + dz * dz < 1e-18) continue;
    }
    path.push([p[0], p[1], p[2]]);
  }
  const m = path.length;
  if (m < 2) return emptyGeometry();

  // Tangents (central differences inside, one-sided at the ends).
  const tangents = new Array(m);
  for (let i = 0; i < m; i++) {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(m - 1, i + 1)];
    let tx = b[0] - a[0];
    let ty = b[1] - a[1];
    let tz = b[2] - a[2];
    let l = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (l < TINY) {
      tx = 0;
      ty = 0;
      tz = 1;
      l = 1;
    }
    tangents[i] = [tx / l, ty / l, tz / l];
  }

  // Seed frame: reference axis least aligned with the first tangent.
  const t0 = tangents[0];
  const ax = Math.abs(t0[0]);
  const ay = Math.abs(t0[1]);
  const az = Math.abs(t0[2]);
  let rx = 0;
  let ry = 0;
  let rz = 0;
  if (ay <= ax && ay <= az) ry = 1;
  else if (ax <= az) rx = 1;
  else rz = 1;
  let d = rx * t0[0] + ry * t0[1] + rz * t0[2];
  let nx = rx - t0[0] * d;
  let ny = ry - t0[1] * d;
  let nz = rz - t0[2] * d;
  let nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
  nx /= nl;
  ny /= nl;
  nz /= nl;

  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  let arc = 0;
  const frameN = new Array(m);
  const frameB = new Array(m);

  for (let i = 0; i < m; i++) {
    if (i > 0) {
      const tp = tangents[i - 1];
      const tc = tangents[i];
      // Rotate the previous normal by the minimal rotation taking tp to tc.
      let axx = tp[1] * tc[2] - tp[2] * tc[1];
      let axy = tp[2] * tc[0] - tp[0] * tc[2];
      let axz = tp[0] * tc[1] - tp[1] * tc[0];
      const axl = Math.sqrt(axx * axx + axy * axy + axz * axz);
      const dt = tp[0] * tc[0] + tp[1] * tc[1] + tp[2] * tc[2];
      if (axl > 1e-9) {
        axx /= axl;
        axy /= axl;
        axz /= axl;
        const angle = Math.atan2(axl, dt);
        const cs = Math.cos(angle);
        const sn = Math.sin(angle);
        const dotAN = axx * nx + axy * ny + axz * nz;
        const crx = axy * nz - axz * ny;
        const cry = axz * nx - axx * nz;
        const crz = axx * ny - axy * nx;
        const rxn = nx * cs + crx * sn + axx * dotAN * (1 - cs);
        const ryn = ny * cs + cry * sn + axy * dotAN * (1 - cs);
        const rzn = nz * cs + crz * sn + axz * dotAN * (1 - cs);
        nx = rxn;
        ny = ryn;
        nz = rzn;
      } else if (dt < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      // Re-orthogonalize against drift.
      const proj = nx * tc[0] + ny * tc[1] + nz * tc[2];
      nx -= tc[0] * proj;
      ny -= tc[1] * proj;
      nz -= tc[2] * proj;
      let l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (l < TINY) {
        nx = 1;
        ny = 0;
        nz = 0;
        const p2 = nx * tc[0] + ny * tc[1] + nz * tc[2];
        nx -= tc[0] * p2;
        ny -= tc[1] * p2;
        nz -= tc[2] * p2;
        l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      }
      nx /= l;
      ny /= l;
      nz /= l;
      const prev = path[i - 1];
      const cur = path[i];
      arc += Math.sqrt(
        (cur[0] - prev[0]) * (cur[0] - prev[0]) +
        (cur[1] - prev[1]) * (cur[1] - prev[1]) +
        (cur[2] - prev[2]) * (cur[2] - prev[2])
      );
    }
    const t = tangents[i];
    const bx = t[1] * nz - t[2] * ny;
    const by = t[2] * nx - t[0] * nz;
    const bz = t[0] * ny - t[1] * nx;
    frameN[i] = [nx, ny, nz];
    frameB[i] = [bx, by, bz];
    const c = path[i];
    for (let j = 0; j <= seg; j++) {
      const phi = (j / seg) * TWO_PI;
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);
      const dx = cp * nx + sp * bx;
      const dy = cp * ny + sp * by;
      const dz = cp * nz + sp * bz;
      pushVertex(positions, normals, uvs,
        c[0] + dx * radius, c[1] + dy * radius, c[2] + dz * radius,
        dx, dy, dz, j / seg, arc);
    }
  }

  const stride = seg + 1;
  for (let i = 0; i < m - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * stride + j;
      const b = a + 1;
      const dIdx = a + stride;
      const c = dIdx + 1;
      indices.push(a, b, dIdx, b, c, dIdx);
    }
  }

  // End caps.
  if (radius > TINY) {
    for (let end = 0; end < 2; end++) {
      const i = end === 0 ? 0 : m - 1;
      const t = tangents[i];
      const sign = end === 0 ? -1 : 1;
      const c = path[i];
      const nrmX = t[0] * sign;
      const nrmY = t[1] * sign;
      const nrmZ = t[2] * sign;
      const base = positions.length / 3;
      pushVertex(positions, normals, uvs, c[0], c[1], c[2], nrmX, nrmY, nrmZ, 0.5, 0.5);
      const fn = frameN[i];
      const fb = frameB[i];
      for (let j = 0; j <= seg; j++) {
        const phi = (j / seg) * TWO_PI;
        const cp = Math.cos(phi);
        const sp = Math.sin(phi);
        pushVertex(positions, normals, uvs,
          c[0] + (cp * fn[0] + sp * fb[0]) * radius,
          c[1] + (cp * fn[1] + sp * fb[1]) * radius,
          c[2] + (cp * fn[2] + sp * fb[2]) * radius,
          nrmX, nrmY, nrmZ,
          0.5 + cp * 0.5, 0.5 + sp * 0.5);
      }
      for (let j = 0; j < seg; j++) {
        if (end === 0) indices.push(base, base + 2 + j, base + 1 + j);
        else indices.push(base, base + 1 + j, base + 2 + j);
      }
    }
  }

  return fromArrays(positions, normals, uvs, indices, null);
}

/**
 * Builds a ribbon between two parallel poly-lines (roads, sidewalks, rails).
 * V runs along the strip in meters, U across the width in meters, both scaled by
 * `uvRepeat`. Normals follow the actual surface, so banked or sloped roads shade
 * correctly.
 * @param {ArrayLike<ArrayLike<number>>} pointsLeft3d Left edge as [x, y, z] triples.
 * @param {ArrayLike<ArrayLike<number>>} pointsRight3d Right edge, same length.
 * @param {number|number[]} [uvRepeat=1] UV tiles per meter ([across, along]).
 * @returns {object} Geometry object.
 */
export function quadStrip(pointsLeft3d, pointsRight3d, uvRepeat = 1) {
  if (!pointsLeft3d || !pointsRight3d) return emptyGeometry();
  const n = Math.min(pointsLeft3d.length, pointsRight3d.length);
  if (n < 2) return emptyGeometry();
  scale2(uvRepeat, 1, 1, _uvScale);
  const su = _uvScale[0];
  const sv = _uvScale[1];

  const positions = new Float32Array(n * 6);
  const normals = new Float32Array(n * 6);
  const uvs = new Float32Array(n * 4);
  const indices = new Uint32Array((n - 1) * 6);

  let along = 0;
  let prevCx = 0;
  let prevCy = 0;
  let prevCz = 0;
  for (let i = 0; i < n; i++) {
    const l = pointsLeft3d[i];
    const r = pointsRight3d[i];
    const lx = l[0], ly = l[1], lz = l[2];
    const rx = r[0], ry = r[1], rz = r[2];
    const cxp = (lx + rx) * 0.5;
    const cyp = (ly + ry) * 0.5;
    const czp = (lz + rz) * 0.5;
    if (i > 0) {
      const dx = cxp - prevCx;
      const dy = cyp - prevCy;
      const dz = czp - prevCz;
      along += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    prevCx = cxp;
    prevCy = cyp;
    prevCz = czp;

    // Along-strip tangent from neighbouring centers.
    const ia = Math.max(0, i - 1);
    const ib = Math.min(n - 1, i + 1);
    const la = pointsLeft3d[ia];
    const ra = pointsRight3d[ia];
    const lb = pointsLeft3d[ib];
    const rb = pointsRight3d[ib];
    let tx = (lb[0] + rb[0]) * 0.5 - (la[0] + ra[0]) * 0.5;
    let ty = (lb[1] + rb[1]) * 0.5 - (la[1] + ra[1]) * 0.5;
    let tz = (lb[2] + rb[2]) * 0.5 - (la[2] + ra[2]) * 0.5;
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (tl > TINY) {
      tx /= tl;
      ty /= tl;
      tz /= tl;
    } else {
      tx = 0;
      ty = 0;
      tz = 1;
    }
    let axx = rx - lx;
    let axy = ry - ly;
    let axz = rz - lz;
    const width = Math.sqrt(axx * axx + axy * axy + axz * axz);
    if (width > TINY) {
      axx /= width;
      axy /= width;
      axz /= width;
    } else {
      axx = 1;
      axy = 0;
      axz = 0;
    }
    let nx = axy * tz - axz * ty;
    let ny = axz * tx - axx * tz;
    let nz = axx * ty - axy * tx;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nl > TINY) {
      nx /= nl;
      ny /= nl;
      nz /= nl;
    } else {
      nx = 0;
      ny = 1;
      nz = 0;
    }

    const vp = i * 6;
    positions[vp] = lx;
    positions[vp + 1] = ly;
    positions[vp + 2] = lz;
    positions[vp + 3] = rx;
    positions[vp + 4] = ry;
    positions[vp + 5] = rz;
    normals[vp] = nx;
    normals[vp + 1] = ny;
    normals[vp + 2] = nz;
    normals[vp + 3] = nx;
    normals[vp + 4] = ny;
    normals[vp + 5] = nz;
    const up = i * 4;
    uvs[up] = 0;
    uvs[up + 1] = along * sv;
    uvs[up + 2] = width * su;
    uvs[up + 3] = along * sv;
  }

  let ip = 0;
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 3;
    const e = a + 2;
    indices[ip] = a;
    indices[ip + 1] = b;
    indices[ip + 2] = c;
    indices[ip + 3] = a;
    indices[ip + 4] = c;
    indices[ip + 5] = e;
    ip += 6;
  }

  const geo = { positions, normals, uvs, indices };
  computeBounds(geo);
  return geo;
}
