/**
 * @file NEON CITY — world builder: turns {@link CityData} into GPU batches and collision bodies.
 *
 * This module is the bridge between `world/citygen.js` (pure data) and everything the player
 * actually sees and walks on:
 *
 *  - a district-tinted terrain mesh with a carved shoreline and an animated sea,
 *  - road surfaces plus a painted-marking decal layer (dashes, double yellow, stop bars,
 *    zebra crossings, lane arrows) taken from the `roadLines` atlas,
 *  - raised sidewalks, kerbs, plazas, parking bays and park lawns,
 *  - fully detailed buildings (ground-floor shopfronts, window facades with an emissive window
 *    mask, setbacks, parapets, roof clutter, balconies, pitched roofs, neon and rooftop
 *    billboards) merged into per-chunk static batches so frustum culling actually removes work,
 *  - one instanced batch per street prop, each modelled from primitives,
 *  - collision bodies for buildings, kerbs and solid props plus a terrain height function,
 *  - a 4-way traffic light state machine, night lights and the minimap description.
 *
 * Everything is deterministic: the only randomness comes from `Rand` seeded off `city.seed`.
 *
 * @module world/worldbuild
 */

import {
  box as boxGeo, cylinder as cylinderGeo, cone as coneGeo, sphere as sphereGeo,
  torus as torusGeo, capsule as capsuleGeo
} from '../core/geometry.js';
import { Rand, clamp, lerp, smoothstep } from '../core/math.js';
import * as TEXLIB from '../render/textures.js';
import * as COLLISION from './collision.js';

/* ------------------------------------------------------------------ tuning */

/** Height of the sidewalk slab above the road surface (m). */
const SIDEWALK_H = 0.15;
/** Road surface height (m). Terrain is pushed slightly below it. */
const ROAD_Y = 0.0;
/** Painted markings sit this far above the asphalt to avoid z-fighting (m). */
const MARK_Y = 0.035;
/** Terrain plane offset below the road so the two never z-fight (m). */
const GROUND_DROP = 0.09;
/** Width of the visible kerb strip at the edge of every block (m). */
const KERB_W = 0.34;
/** Default storey height used when a building does not give one (m). */
const FLOOR_H = 3.3;
/** Height of the taller ground floor of commercial buildings (m). */
const SHOP_H = 4.6;
/** Facade texture tile size (m) — one tile is a 4x4 window grid. */
const FACADE_TILE_W = 12.0;
/** Facade texture tile height (m) — four storeys. */
const FACADE_TILE_H = 13.2;
/** Street props inside this radius get a point light submitted at night (m). */
const LIGHT_RADIUS = 90;
/** Hard cap on point lights submitted by the world each frame. */
const MAX_WORLD_LIGHTS = 12;
/** Traffic light timings (s): green, amber, all-red. */
const TL_GREEN = 9.5, TL_AMBER = 3.0, TL_RED = 1.7;
/** Full traffic light cycle length (s). */
const TL_CYCLE = (TL_GREEN + TL_AMBER + TL_RED) * 2;

/** Face bit flags for {@link MeshBuilder#addBox}. */
const FX = 1, NX = 2, PY = 4, NY = 8, PZ = 16, NZ = 32;
/** All six box faces. */
const ALL_FACES = FX | NX | PY | NY | PZ | NZ;
/** Sides only (no top, no bottom). */
const SIDE_FACES = FX | NX | PZ | NZ;

/**
 * Box face table: outward normal, the four corner sign triplets in CCW order seen from
 * outside, and which half-extent drives the horizontal (u) and vertical (v) UV span.
 * @type {Array<{bit:number, n:number[], c:number[][], uAxis:number, vAxis:number}>}
 */
const BOX_FACES = [
  { bit: FX, n: [1, 0, 0], uAxis: 2, vAxis: 1, c: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { bit: NX, n: [-1, 0, 0], uAxis: 2, vAxis: 1, c: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { bit: PY, n: [0, 1, 0], uAxis: 0, vAxis: 2, c: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { bit: NY, n: [0, -1, 0], uAxis: 0, vAxis: 2, c: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  { bit: PZ, n: [0, 0, 1], uAxis: 0, vAxis: 1, c: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { bit: NZ, n: [0, 0, -1], uAxis: 0, vAxis: 1, c: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] }
];

/**
 * Fallback copy of the road marking atlas layout, used when `render/textures.js` does not
 * export {@link TEXLIB.ROAD_MARKING_UV}. Rectangles are in canvas space (v runs downwards).
 */
const FALLBACK_MARKING_UV = {
  dash: { u0: 0.00, v0: 0.00, u1: 0.25, v1: 0.25 },
  solid: { u0: 0.25, v0: 0.00, u1: 0.50, v1: 0.25 },
  doubleYellow: { u0: 0.50, v0: 0.00, u1: 0.75, v1: 0.25 },
  stopBar: { u0: 0.75, v0: 0.00, u1: 1.00, v1: 0.25 },
  crosswalk: { u0: 0.00, v0: 0.25, u1: 1.00, v1: 0.75 },
  arrowStraight: { u0: 0.00, v0: 0.75, u1: 0.25, v1: 1.00 },
  arrowLeft: { u0: 0.25, v0: 0.75, u1: 0.50, v1: 1.00 },
  arrowRight: { u0: 0.50, v0: 0.75, u1: 0.75, v1: 1.00 },
  parking: { u0: 0.75, v0: 0.75, u1: 1.00, v1: 1.00 }
};

/** Ground tint per district kind (linear rgb). */
const DISTRICT_GROUND = {
  downtown: [0.115, 0.118, 0.128],
  midtown: [0.135, 0.135, 0.140],
  residential: [0.145, 0.185, 0.115],
  industrial: [0.155, 0.148, 0.130],
  park: [0.115, 0.245, 0.095],
  beach: [0.520, 0.455, 0.310],
  water: [0.070, 0.115, 0.140]
};

/** Minimap fill colour per district kind (CSS, consumed by ui/hud.js and ui/map.js). */
const DISTRICT_MAP_COLOR = {
  downtown: '#2a3040',
  midtown: '#272c38',
  residential: '#26332b',
  industrial: '#332f28',
  park: '#1d3a24',
  beach: '#4a4330',
  water: '#0e2436'
};

/* ------------------------------------------------------------------ helpers */

/**
 * Integer hash producing a deterministic value in [0,1).
 * @param {number} x First coordinate.
 * @param {number} y Second coordinate.
 * @param {number} seed Seed.
 * @returns {number} Pseudo-random value in [0,1).
 */
function hash2(x, y, seed) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Smooth value noise on a unit lattice.
 * @param {number} x Sample x.
 * @param {number} z Sample z.
 * @param {number} seed Seed.
 * @returns {number} Noise in 0..1.
 */
function valueNoise(x, z, seed) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const tx = x - xi, tz = z - zi;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const a = hash2(xi, zi, seed);
  const b = hash2(xi + 1, zi, seed);
  const c = hash2(xi, zi + 1, seed);
  const d = hash2(xi + 1, zi + 1, seed);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sz);
}

/**
 * Fractal value noise.
 * @param {number} x Sample x.
 * @param {number} z Sample z.
 * @param {number} seed Seed.
 * @param {number} octaves Octave count.
 * @returns {number} Noise in 0..1.
 */
function fbm(x, z, seed, octaves) {
  let sum = 0, amp = 0.5, norm = 0, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * f, z * f, seed + i * 131) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

/**
 * Builds a column-major TRS matrix (yaw about Y only).
 * @param {Float32Array|number[]} out Destination (16 floats).
 * @param {number} x Translation x.
 * @param {number} y Translation y.
 * @param {number} z Translation z.
 * @param {number} yaw Rotation about Y (rad).
 * @param {number} sx Scale x.
 * @param {number} sy Scale y.
 * @param {number} sz Scale z.
 * @returns {Float32Array|number[]} out
 */
function trs(out, x, y, z, yaw, sx, sy, sz) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  out[0] = c * sx; out[1] = 0; out[2] = -s * sx; out[3] = 0;
  out[4] = 0; out[5] = sy; out[6] = 0; out[7] = 0;
  out[8] = s * sz; out[9] = 0; out[10] = c * sz; out[11] = 0;
  out[12] = x; out[13] = y; out[14] = z; out[15] = 1;
  return out;
}

/**
 * Builds a column-major matrix that rotates about X then Y, then translates.
 * Used by tilted props (aerials, palm fronds, awnings).
 * @param {Float32Array|number[]} out Destination (16 floats).
 * @param {number} x Translation x.
 * @param {number} y Translation y.
 * @param {number} z Translation z.
 * @param {number} yaw Rotation about Y (rad), applied last.
 * @param {number} pitch Rotation about X (rad), applied first.
 * @param {number} s Uniform scale.
 * @returns {Float32Array|number[]} out
 */
function trsPitch(out, x, y, z, yaw, pitch, s) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  // R = Ry * Rx
  out[0] = cy * s; out[1] = 0; out[2] = -sy * s; out[3] = 0;
  out[4] = sy * sp * s; out[5] = cp * s; out[6] = cy * sp * s; out[7] = 0;
  out[8] = sy * cp * s; out[9] = -sp * s; out[10] = cy * cp * s; out[11] = 0;
  out[12] = x; out[13] = y; out[14] = z; out[15] = 1;
  return out;
}

/**
 * Multiplies two column-major 4x4 matrices.
 * @param {Float32Array|number[]} out Destination.
 * @param {ArrayLike<number>} a Left matrix.
 * @param {ArrayLike<number>} b Right matrix.
 * @returns {Float32Array|number[]} out
 */
function mul4(out, a, b) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

/**
 * Multiplies a linear rgb triple by a scalar, clamped to 0..1.
 * @param {number[]} c Source colour.
 * @param {number} k Multiplier.
 * @param {number[]} out Destination.
 * @returns {number[]} out
 */
function tint(c, k, out) {
  out[0] = clamp(c[0] * k, 0, 1);
  out[1] = clamp(c[1] * k, 0, 1);
  out[2] = clamp(c[2] * k, 0, 1);
  return out;
}

/**
 * Picks the first texture present in a texture library.
 * @param {object} lib Texture library (or `{textures:{...}}` wrapper).
 * @param {...string} names Candidate keys in priority order.
 * @returns {object|null} The texture, or null when none exist.
 */
function pickTex(lib, ...names) {
  if (!lib) return null;
  const table = lib.textures && typeof lib.textures === 'object' ? lib.textures : lib;
  for (let i = 0; i < names.length; i++) {
    const t = table[names[i]];
    if (t) return t;
  }
  return null;
}

/* ------------------------------------------------------------- mesh builder */

/**
 * Growable triangle-soup accumulator producing the geometry object that
 * `core/gl.js` and `Renderer.addStatic` consume. One instance per (chunk, material).
 */
class MeshBuilder {
  /**
   * @param {number} [vertCap] Initial vertex capacity.
   */
  constructor(vertCap = 64) {
    this.pos = new Float32Array(vertCap * 3);
    this.nrm = new Float32Array(vertCap * 3);
    this.uv = new Float32Array(vertCap * 2);
    this.col = new Float32Array(vertCap * 3);
    this.idx = new Uint32Array(vertCap * 3);
    this.vcap = vertCap;
    this.icap = vertCap * 3;
    this.vcount = 0;
    this.icount = 0;
  }

  /**
   * Grows the vertex arrays so `n` more vertices fit.
   * @param {number} n Extra vertices needed.
   * @returns {void}
   */
  _reserveV(n) {
    if (this.vcount + n <= this.vcap) return;
    let cap = this.vcap;
    while (cap < this.vcount + n) cap *= 2;
    const p = new Float32Array(cap * 3); p.set(this.pos); this.pos = p;
    const nr = new Float32Array(cap * 3); nr.set(this.nrm); this.nrm = nr;
    const u = new Float32Array(cap * 2); u.set(this.uv); this.uv = u;
    const c = new Float32Array(cap * 3); c.set(this.col); this.col = c;
    this.vcap = cap;
  }

  /**
   * Grows the index array so `n` more indices fit.
   * @param {number} n Extra indices needed.
   * @returns {void}
   */
  _reserveI(n) {
    if (this.icount + n <= this.icap) return;
    let cap = this.icap;
    while (cap < this.icount + n) cap *= 2;
    const a = new Uint32Array(cap); a.set(this.idx); this.idx = a;
    this.icap = cap;
  }

  /**
   * Appends one vertex.
   * @param {number} x Position x.
   * @param {number} y Position y.
   * @param {number} z Position z.
   * @param {number} nx Normal x.
   * @param {number} ny Normal y.
   * @param {number} nz Normal z.
   * @param {number} u Texture u.
   * @param {number} v Texture v.
   * @param {number} r Colour r.
   * @param {number} g Colour g.
   * @param {number} b Colour b.
   * @returns {number} Index of the new vertex.
   */
  vert(x, y, z, nx, ny, nz, u, v, r, g, b) {
    this._reserveV(1);
    const i = this.vcount++;
    const p3 = i * 3, p2 = i * 2;
    this.pos[p3] = x; this.pos[p3 + 1] = y; this.pos[p3 + 2] = z;
    this.nrm[p3] = nx; this.nrm[p3 + 1] = ny; this.nrm[p3 + 2] = nz;
    this.uv[p2] = u; this.uv[p2 + 1] = v;
    this.col[p3] = r; this.col[p3 + 1] = g; this.col[p3 + 2] = b;
    return i;
  }

  /**
   * Appends a triangle from three existing vertex indices.
   * @param {number} a First index.
   * @param {number} b Second index.
   * @param {number} c Third index.
   * @returns {void}
   */
  tri(a, b, c) {
    this._reserveI(3);
    this.idx[this.icount++] = a;
    this.idx[this.icount++] = b;
    this.idx[this.icount++] = c;
  }

  /**
   * Appends a quad from four existing vertex indices (CCW).
   * @param {number} a First index.
   * @param {number} b Second index.
   * @param {number} c Third index.
   * @param {number} d Fourth index.
   * @returns {void}
   */
  quad(a, b, c, d) {
    this._reserveI(6);
    const i = this.idx;
    i[this.icount++] = a; i[this.icount++] = b; i[this.icount++] = c;
    i[this.icount++] = a; i[this.icount++] = c; i[this.icount++] = d;
  }

  /**
   * Appends a horizontal, axis-aligned quad (facing +Y) with explicit UVs.
   * @param {number} x0 Minimum x.
   * @param {number} z0 Minimum z.
   * @param {number} x1 Maximum x.
   * @param {number} z1 Maximum z.
   * @param {number} y Height.
   * @param {number} u0 UV at (x0,z0).
   * @param {number} v0 UV at (x0,z0).
   * @param {number} u1 UV at (x1,z1).
   * @param {number} v1 UV at (x1,z1).
   * @param {number[]} color Linear rgb.
   * @returns {void}
   */
  addFlatQuad(x0, z0, x1, z1, y, u0, v0, u1, v1, color) {
    const r = color[0], g = color[1], b = color[2];
    const a = this.vert(x0, y, z0, 0, 1, 0, u0, v0, r, g, b);
    const c = this.vert(x0, y, z1, 0, 1, 0, u0, v1, r, g, b);
    const d = this.vert(x1, y, z1, 0, 1, 0, u1, v1, r, g, b);
    const e = this.vert(x1, y, z0, 0, 1, 0, u1, v0, r, g, b);
    this.quad(a, c, d, e);
  }

  /**
   * Appends a horizontal quad rotated about Y, with the U axis across the local X axis and
   * the V axis along the local +Z axis. Used for road markings.
   * @param {number} cx Centre x.
   * @param {number} cz Centre z.
   * @param {number} y Height.
   * @param {number} hw Half size across (local x).
   * @param {number} hd Half size along (local z).
   * @param {number} dirX Unit forward x (local +Z direction).
   * @param {number} dirZ Unit forward z.
   * @param {object} r UV rect `{u0,v0,u1,v1}` in GL space.
   * @param {number[]} color Linear rgb.
   * @returns {void}
   */
  addOrientedQuad(cx, cz, y, hw, hd, dirX, dirZ, r, color) {
    // Right vector = forward rotated -90 degrees about Y.
    const rx = dirZ, rz = -dirX;
    const cr = color[0], cg = color[1], cb = color[2];
    const ax = cx - rx * hw - dirX * hd, az = cz - rz * hw - dirZ * hd;
    const bx = cx + rx * hw - dirX * hd, bz = cz + rz * hw - dirZ * hd;
    const dx = cx + rx * hw + dirX * hd, dz = cz + rz * hw + dirZ * hd;
    const ex = cx - rx * hw + dirX * hd, ez = cz - rz * hw + dirZ * hd;
    const i0 = this.vert(ax, y, az, 0, 1, 0, r.u0, r.v0, cr, cg, cb);
    const i1 = this.vert(ex, y, ez, 0, 1, 0, r.u0, r.v1, cr, cg, cb);
    const i2 = this.vert(dx, y, dz, 0, 1, 0, r.u1, r.v1, cr, cg, cb);
    const i3 = this.vert(bx, y, bz, 0, 1, 0, r.u1, r.v0, cr, cg, cb);
    this.quad(i0, i1, i2, i3);
  }

  /**
   * Appends a box, optionally yawed, with world-scaled or tile-fitted UVs.
   *
   * @param {number} cx Centre x.
   * @param {number} cy Centre y.
   * @param {number} cz Centre z.
   * @param {number} hx Half extent x.
   * @param {number} hy Half extent y.
   * @param {number} hz Half extent z.
   * @param {number} yaw Rotation about Y (rad).
   * @param {object} [opt] Options.
   * @param {number[]} [opt.color] Linear rgb vertex colour.
   * @param {number} [opt.faces] Face bitmask (default all six).
   * @param {string} [opt.uv] `'world'` (default) or `'fit'`.
   * @param {number} [opt.uScale] World UV scale (tiles per metre) for `'world'`.
   * @param {number} [opt.vScale] Vertical UV scale for `'world'`.
   * @param {number} [opt.vBase] World y that maps to v = 0 for `'world'`.
   * @param {number} [opt.tileW] Tile width in metres for `'fit'`.
   * @param {number} [opt.tileH] Tile height in metres for `'fit'`.
   * @param {number} [opt.uOff] Constant u offset.
   * @param {number} [opt.vOff] Constant v offset.
   * @returns {void}
   */
  addBox(cx, cy, cz, hx, hy, hz, yaw, opt) {
    const o = opt || {};
    const color = o.color || WHITE;
    const faces = o.faces === undefined ? ALL_FACES : o.faces;
    const fit = o.uv === 'fit';
    const uScale = o.uScale === undefined ? 1 : o.uScale;
    const vScale = o.vScale === undefined ? uScale : o.vScale;
    const vBase = o.vBase === undefined ? cy - hy : o.vBase;
    const tileW = o.tileW || FACADE_TILE_W;
    const tileH = o.tileH || FACADE_TILE_H;
    const uOff = o.uOff || 0;
    const vOff = o.vOff || 0;
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const half = [hx, hy, hz];
    const r = color[0], g = color[1], b = color[2];

    for (let f = 0; f < 6; f++) {
      const face = BOX_FACES[f];
      if (!(faces & face.bit)) continue;
      const isSide = face.n[1] === 0;
      let uExt, vExt, v0;
      if (fit) {
        if (isSide) {
          uExt = Math.max(1, Math.round((half[face.uAxis] * 2) / tileW));
          vExt = Math.max(1, Math.round((half[face.vAxis] * 2) / tileH));
        } else {
          uExt = (half[face.uAxis] * 2) / tileW;
          vExt = (half[face.vAxis] * 2) / tileH;
        }
        v0 = 0;
      } else if (isSide) {
        uExt = half[face.uAxis] * 2 * uScale;
        vExt = half[face.vAxis] * 2 * vScale;
        v0 = (cy - hy - vBase) * vScale;
      } else {
        uExt = half[face.uAxis] * 2 * uScale;
        vExt = half[face.vAxis] * 2 * uScale;
        v0 = 0;
      }
      const nx = face.n[0] * cs + face.n[2] * sn;
      const nz = -face.n[0] * sn + face.n[2] * cs;
      const ny = face.n[1];
      const base = this.vcount;
      for (let k = 0; k < 4; k++) {
        const sgn = face.c[k];
        const lx = sgn[0] * hx, ly = sgn[1] * hy, lz = sgn[2] * hz;
        const wx = cx + lx * cs + lz * sn;
        const wz = cz - lx * sn + lz * cs;
        const u = (k === 1 || k === 2 ? uExt : 0) + uOff;
        const v = (k >= 2 ? v0 + vExt : v0) + vOff;
        this.vert(wx, cy + ly, wz, nx, ny, nz, u, v, r, g, b);
      }
      this.quad(base, base + 1, base + 2, base + 3);
    }
  }

  /**
   * Appends a whole geometry object, optionally transformed and recoloured.
   * @param {object} geo Geometry object with positions/normals/uvs/indices.
   * @param {ArrayLike<number>|null} m Column-major 4x4 transform, or null.
   * @param {number[]|null} color Linear rgb vertex colour, or null to keep white.
   * @param {number} [uvScale] Multiplier applied to the source UVs.
   * @returns {void}
   */
  addGeometry(geo, m, color, uvScale) {
    const pos = geo.positions, nrm = geo.normals, uv = geo.uvs, idx = geo.indices;
    const n = pos.length / 3;
    const base = this.vcount;
    const us = uvScale === undefined ? 1 : uvScale;
    const c = color || WHITE;
    this._reserveV(n);
    let sx = 1, sy = 1, sz = 1;
    if (m) {
      sx = Math.hypot(m[0], m[1], m[2]) || 1;
      sy = Math.hypot(m[4], m[5], m[6]) || 1;
      sz = Math.hypot(m[8], m[9], m[10]) || 1;
    }
    const isx = 1 / (sx * sx), isy = 1 / (sy * sy), isz = 1 / (sz * sz);
    for (let i = 0; i < n; i++) {
      const i3 = i * 3, i2 = i * 2;
      let x = pos[i3], y = pos[i3 + 1], z = pos[i3 + 2];
      let nx = nrm ? nrm[i3] : 0, ny = nrm ? nrm[i3 + 1] : 1, nz = nrm ? nrm[i3 + 2] : 0;
      if (m) {
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
        const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
        const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
        const ax = nx * isx, ay = ny * isy, az = nz * isz;
        let tx = m[0] * ax + m[4] * ay + m[8] * az;
        let ty = m[1] * ax + m[5] * ay + m[9] * az;
        let tz = m[2] * ax + m[6] * ay + m[10] * az;
        const len = Math.hypot(tx, ty, tz) || 1;
        nx = tx / len; ny = ty / len; nz = tz / len;
        x = wx; y = wy; z = wz;
      }
      const vi = this.vcount++;
      const p3 = vi * 3, p2 = vi * 2;
      this.pos[p3] = x; this.pos[p3 + 1] = y; this.pos[p3 + 2] = z;
      this.nrm[p3] = nx; this.nrm[p3 + 1] = ny; this.nrm[p3 + 2] = nz;
      this.uv[p2] = uv ? uv[i2] * us : 0;
      this.uv[p2 + 1] = uv ? uv[i2 + 1] * us : 0;
      this.col[p3] = c[0]; this.col[p3 + 1] = c[1]; this.col[p3 + 2] = c[2];
    }
    this._reserveI(idx.length);
    for (let i = 0; i < idx.length; i++) this.idx[this.icount++] = base + idx[i];
  }

  /** @returns {number} Triangle count accumulated so far. */
  get triangles() {
    return (this.icount / 3) | 0;
  }

  /** @returns {boolean} True when nothing has been added. */
  get empty() {
    return this.icount === 0;
  }

  /**
   * Packs the accumulated data into a geometry object with computed bounds.
   * @returns {object|null} Geometry object, or null when empty.
   */
  toGeometry() {
    if (this.icount === 0) return null;
    const positions = this.pos.subarray(0, this.vcount * 3).slice();
    const normals = this.nrm.subarray(0, this.vcount * 3).slice();
    const uvs = this.uv.subarray(0, this.vcount * 2).slice();
    const colors = this.col.subarray(0, this.vcount * 3).slice();
    const indices = this.idx.subarray(0, this.icount).slice();
    let minx = Infinity, miny = Infinity, minz = Infinity;
    let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1], z = positions[i + 2];
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
    }
    return {
      positions, normals, uvs, colors, indices,
      bounds: { min: [minx, miny, minz], max: [maxx, maxy, maxz] }
    };
  }
}

/** Neutral vertex colour. */
const WHITE = [1, 1, 1];

/* ----------------------------------------------------------------- terrain */

/**
 * Height field for everything outside the flat city grid: beaches, the sea bed, carved
 * water lots and the rolling hills that close the horizon. Sampled bilinearly so the
 * rendered mesh and `groundHeight` always agree.
 */
class Terrain {
  /**
   * @param {object} city CityData.
   * @param {number} margin Metres of terrain built outside the city bounds.
   * @param {number} cell Height field cell size in metres.
   */
  constructor(city, margin, cell) {
    const b = city.bounds;
    this.minX = b.min[0] - margin;
    this.minZ = b.min[1] - margin;
    this.maxX = b.max[0] + margin;
    this.maxZ = b.max[1] + margin;
    this.cell = cell;
    this.nx = Math.ceil((this.maxX - this.minX) / cell) + 1;
    this.nz = Math.ceil((this.maxZ - this.minZ) / cell) + 1;
    this.h = new Float32Array(this.nx * this.nz);
    this.flat = new Uint8Array(this.nx * this.nz);
    this.waterLevel = typeof city.waterLevel === 'number' ? city.waterLevel : null;
    this.seaFloor = this.waterLevel === null ? -14 : this.waterLevel - 11;
    this.cityMin = [b.min[0], b.min[1]];
    this.cityMax = [b.max[0], b.max[1]];
    this._build(city);
  }

  /**
   * Rasterises the height field.
   * @param {object} city CityData.
   * @returns {void}
   */
  _build(city) {
    const seed = (city.seed | 0) ^ 0x51ed;
    const { nx, nz, cell } = this;
    const cx0 = this.cityMin[0], cz0 = this.cityMin[1];
    const cx1 = this.cityMax[0], cz1 = this.cityMax[1];
    const hasSea = this.waterLevel !== null;

    // Which side of the city faces open water? Prefer the beach district's offset from the
    // city centre; fall back to +X so a world without a beach still gets a coastline.
    let sx = 1, sz = 0;
    if (hasSea) {
      const mx = (cx0 + cx1) * 0.5, mz = (cz0 + cz1) * 0.5;
      let bestD = -1, bx = 0, bz = 0;
      const list = city.districts || [];
      for (let i = 0; i < list.length; i++) {
        const d = list[i];
        if (d.kind !== 'beach' && d.kind !== 'water') continue;
        const r = d.rect;
        const dx = (r.x + r.w * 0.5) - mx;
        const dz = (r.z + r.d * 0.5) - mz;
        const len = Math.hypot(dx, dz);
        if (len > bestD) { bestD = len; bx = dx; bz = dz; }
      }
      if (bestD > 1) {
        if (Math.abs(bx) >= Math.abs(bz)) { sx = Math.sign(bx) || 1; sz = 0; } else { sx = 0; sz = Math.sign(bz) || 1; }
      }
    }
    this.seaDirX = sx;
    this.seaDirZ = sz;
    // Shoreline plane: the outer edge of the city on the sea side.
    const shore = sx !== 0 ? (sx > 0 ? cx1 : -cx0) : (sz > 0 ? cz1 : -cz0);

    // Water lots carved inside the city (canals, ponds, marina basins).
    const waterRects = [];
    const lots = city.lots || [];
    for (let i = 0; i < lots.length; i++) {
      if (lots[i].kind === 'water') waterRects.push(lots[i]);
    }
    this.waterRects = waterRects;

    for (let j = 0; j < nz; j++) {
      const z = this.minZ + j * cell;
      for (let i = 0; i < nx; i++) {
        const x = this.minX + i * cell;
        const k = j * nx + i;
        // Distance outside the city rectangle (0 while inside).
        const ox = Math.max(cx0 - x, x - cx1, 0);
        const oz = Math.max(cz0 - z, z - cz1, 0);
        const outside = Math.hypot(ox, oz);
        let h = 0;
        let flat = outside < 1;

        if (hasSea) {
          const along = sx !== 0 ? (sx > 0 ? x : -x) : (sz > 0 ? z : -z);
          const beyond = along - shore + 6;
          if (beyond > -34) {
            const t = smoothstep(-34, 150, beyond);
            const wobble = (fbm(x * 0.006, z * 0.006, seed + 71, 3) - 0.5) * 26;
            const tw = clamp(t + wobble * 0.0016 * smoothstep(-30, 40, beyond), 0, 1);
            h = Math.min(h, lerp(0.4, this.seaFloor, tw * tw));
            if (beyond > -30) flat = false;
          }
        }
        if (outside > 2 && !(hasSea && this._towardSea(x, z, shore))) {
          const t = smoothstep(6, 210, outside);
          const hill = fbm(x * 0.0035, z * 0.0035, seed, 4);
          h = Math.max(h, t * (3 + hill * 22));
          flat = false;
        }
        for (let w = 0; w < waterRects.length; w++) {
          const r = waterRects[w];
          const dx = Math.max(r.x - r.w * 0.5 - x, x - (r.x + r.w * 0.5), 0);
          const dz = Math.max(r.z - r.d * 0.5 - z, z - (r.z + r.d * 0.5), 0);
          const d = Math.hypot(dx, dz);
          if (d < 14) {
            const depth = (this.waterLevel === null ? -2 : this.waterLevel) - 2.6;
            const t = 1 - smoothstep(0, 14, d);
            h = Math.min(h, lerp(h, depth, t));
            if (t > 0.02) flat = false;
          }
        }
        this.h[k] = h;
        this.flat[k] = flat ? 1 : 0;
      }
    }
    this._smooth(2);
  }

  /**
   * True when the sample lies on the seaward side of the shoreline.
   * @param {number} x Sample x.
   * @param {number} z Sample z.
   * @param {number} shore Shoreline coordinate along the sea axis.
   * @returns {boolean} Whether the point is seaward.
   */
  _towardSea(x, z, shore) {
    const along = this.seaDirX !== 0 ? (this.seaDirX > 0 ? x : -x) : (this.seaDirZ > 0 ? z : -z);
    return along > shore - 40;
  }

  /**
   * Box-blurs the non-flat cells so the shoreline and hills have no faceting.
   * Flat city cells act as fixed boundary values.
   * @param {number} passes Blur passes.
   * @returns {void}
   */
  _smooth(passes) {
    const { nx, nz } = this;
    const src = new Float32Array(this.h.length);
    for (let p = 0; p < passes; p++) {
      src.set(this.h);
      for (let j = 1; j < nz - 1; j++) {
        for (let i = 1; i < nx - 1; i++) {
          const k = j * nx + i;
          if (this.flat[k]) continue;
          const s = src[k - nx - 1] + src[k - nx] + src[k - nx + 1] +
            src[k - 1] + src[k] * 2 + src[k + 1] +
            src[k + nx - 1] + src[k + nx] + src[k + nx + 1];
          this.h[k] = s / 10;
        }
      }
    }
  }

  /**
   * Bilinearly samples the height field.
   * @param {number} x World x.
   * @param {number} z World z.
   * @returns {number} Terrain height in metres.
   */
  height(x, z) {
    const fx = (x - this.minX) / this.cell;
    const fz = (z - this.minZ) / this.cell;
    const i = clamp(Math.floor(fx), 0, this.nx - 2);
    const j = clamp(Math.floor(fz), 0, this.nz - 2);
    const tx = clamp(fx - i, 0, 1);
    const tz = clamp(fz - j, 0, 1);
    const k = j * this.nx + i;
    const a = this.h[k], b = this.h[k + 1], c = this.h[k + this.nx], d = this.h[k + this.nx + 1];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  }
}

/* ------------------------------------------------------------- chunk grids */

/**
 * A regular grid of merge buckets. Every (cell, material) pair becomes exactly one static
 * batch, which is what makes frustum culling worthwhile: a chunk that leaves the frustum
 * removes its whole slice of the city from the draw list.
 */
class ChunkGrid {
  /**
   * @param {number} minX Grid origin x.
   * @param {number} minZ Grid origin z.
   * @param {number} size Cell size in metres.
   * @param {number} nx Cells along x.
   * @param {number} nz Cells along z.
   */
  constructor(minX, minZ, size, nx, nz) {
    this.minX = minX;
    this.minZ = minZ;
    this.size = size;
    this.nx = nx;
    this.nz = nz;
    /** @type {Array<Map<string, MeshBuilder>>} */
    this.cells = new Array(nx * nz);
  }

  /**
   * Returns the builder for a world position and material key, creating it on demand.
   * @param {number} x World x.
   * @param {number} z World z.
   * @param {string} key Material key.
   * @returns {MeshBuilder} The builder.
   */
  at(x, z, key) {
    const i = clamp(Math.floor((x - this.minX) / this.size), 0, this.nx - 1);
    const j = clamp(Math.floor((z - this.minZ) / this.size), 0, this.nz - 1);
    const k = j * this.nx + i;
    let map = this.cells[k];
    if (!map) { map = new Map(); this.cells[k] = map; }
    let b = map.get(key);
    if (!b) { b = new MeshBuilder(96); map.set(key, b); }
    return b;
  }

  /**
   * Uploads every non-empty bucket as a static batch.
   * @param {object} renderer Renderer.
   * @param {Object<string,object>} mats Material table keyed like the buckets.
   * @param {number[]} outIds Receives the static batch ids.
   * @param {{batches:number, triangles:number}} stats Accumulated counters.
   * @returns {void}
   */
  emit(renderer, mats, outIds, stats) {
    for (let k = 0; k < this.cells.length; k++) {
      const map = this.cells[k];
      if (!map) continue;
      for (const [key, builder] of map) {
        if (builder.empty) continue;
        const mat = mats[key];
        if (!mat) continue;
        const geo = builder.toGeometry();
        if (!geo) continue;
        stats.batches++;
        stats.triangles += geo.indices.length / 3;
        if (typeof renderer.addStatic === 'function') {
          const id = renderer.addStatic(geo, mat);
          if (id !== undefined && id !== null) outIds.push(id);
        }
      }
      this.cells[k] = null;
    }
  }
}

/* --------------------------------------------------------------- lot index */

/**
 * Uniform grid over the axis-aligned city lots so `groundHeight` and prop placement can
 * answer "which block am I standing on" in constant time.
 */
class LotIndex {
  /**
   * @param {object[]} lots CityData lots.
   * @param {number[]} min World minimum `[x, z]`.
   * @param {number[]} max World maximum `[x, z]`.
   * @param {number} [cell] Cell size in metres.
   */
  constructor(lots, min, max, cell = 16) {
    this.minX = min[0];
    this.minZ = min[1];
    this.cell = cell;
    this.nx = Math.max(1, Math.ceil((max[0] - min[0]) / cell) + 1);
    this.nz = Math.max(1, Math.ceil((max[1] - min[1]) / cell) + 1);
    this.grid = new Int32Array(this.nx * this.nz).fill(-1);
    this.lots = lots;
    for (let i = 0; i < lots.length; i++) {
      const l = lots[i];
      const x0 = l.x0 !== undefined ? l.x0 : l.x - l.w * 0.5;
      const z0 = l.z0 !== undefined ? l.z0 : l.z - l.d * 0.5;
      const x1 = l.x1 !== undefined ? l.x1 : l.x + l.w * 0.5;
      const z1 = l.z1 !== undefined ? l.z1 : l.z + l.d * 0.5;
      const i0 = clamp(Math.floor((x0 - this.minX) / cell), 0, this.nx - 1);
      const i1 = clamp(Math.floor((x1 - this.minX) / cell), 0, this.nx - 1);
      const j0 = clamp(Math.floor((z0 - this.minZ) / cell), 0, this.nz - 1);
      const j1 = clamp(Math.floor((z1 - this.minZ) / cell), 0, this.nz - 1);
      for (let j = j0; j <= j1; j++) {
        for (let ii = i0; ii <= i1; ii++) this.grid[j * this.nx + ii] = i;
      }
    }
  }

  /**
   * Looks up the lot covering a world position.
   * @param {number} x World x.
   * @param {number} z World z.
   * @returns {object|null} The lot, or null when the point is on a road or outside.
   */
  at(x, z) {
    const i = Math.floor((x - this.minX) / this.cell);
    const j = Math.floor((z - this.minZ) / this.cell);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return null;
    const id = this.grid[j * this.nx + i];
    if (id < 0) return null;
    const l = this.lots[id];
    const x0 = l.x0 !== undefined ? l.x0 : l.x - l.w * 0.5;
    const z0 = l.z0 !== undefined ? l.z0 : l.z - l.d * 0.5;
    const x1 = l.x1 !== undefined ? l.x1 : l.x + l.w * 0.5;
    const z1 = l.z1 !== undefined ? l.z1 : l.z + l.d * 0.5;
    if (x < x0 || x > x1 || z < z0 || z > z1) return null;
    return l;
  }
}

/* -------------------------------------------------------------- materials */

/**
 * Builds every material the world uses. Materials are cheap; batches are not, so the keys
 * here are deliberately few and shared aggressively across chunks.
 *
 * @param {object} renderer Renderer (used for `createMaterial` when available).
 * @param {object} textures Texture library.
 * @returns {Object<string, object>} Material table keyed by builder key.
 */
function buildMaterials(renderer, textures) {
  const make = (desc) => (typeof renderer.createMaterial === 'function'
    ? renderer.createMaterial(desc)
    : Object.assign({
      albedo: [1, 1, 1], roughness: 0.85, metallic: 0, emissive: [0, 0, 0], emissiveStrength: 1,
      uvScale: [1, 1], uvOffset: [0, 0], alpha: 1, blend: 'opaque', doubleSided: false,
      castShadow: true, receiveShadow: true, vertexColors: false, windowGlow: 0
    }, desc));
  const T = (...n) => pickTex(textures, ...n);

  const mats = {};
  mats.terrain = make({
    name: 'terrain', map: T('dirt', 'grass', 'concrete'), normalMap: T('dirt_n', 'grass_n'),
    uvScale: [0.09, 0.09], roughness: 0.97, vertexColors: true, receiveShadow: true
  });
  mats.grass = make({
    name: 'grass', map: T('grass', 'dirt'), normalMap: T('grass_n'),
    uvScale: [0.11, 0.11], roughness: 0.95, vertexColors: true
  });
  mats.sand = make({
    name: 'sand', map: T('sand', 'dirt'), uvScale: [0.1, 0.1], roughness: 0.94, vertexColors: true
  });
  mats.water = make({
    name: 'water', map: T('water'), normalMap: T('waterNormal', 'water_n'),
    uvScale: [0.02, 0.02], roughness: 0.09, metallic: 0.0, reflectivity: 0.22,
    albedo: [0.09, 0.19, 0.24], alpha: 0.86, blend: 'alpha', doubleSided: true,
    castShadow: false, vertexColors: false, wetness: 1
  });
  mats.asphalt = make({
    name: 'asphalt', map: T('asphalt'), normalMap: T('asphalt_n'),
    uvScale: [1, 1], roughness: 0.88, vertexColors: true, castShadow: false
  });
  mats.mark = make({
    name: 'roadMark', map: T('roadLines'), blend: 'alpha', depthWrite: false, sortBias: -4,
    roughness: 0.62, vertexColors: true, castShadow: false, receiveShadow: true
  });
  mats.sidewalk = make({
    name: 'sidewalk', map: T('sidewalk', 'concrete'), normalMap: T('sidewalk_n', 'concrete_n'),
    uvScale: [1, 1], roughness: 0.9, vertexColors: true, castShadow: false
  });
  mats.kerb = make({
    name: 'kerb', map: T('concrete', 'sidewalk'), normalMap: T('concrete_n'),
    uvScale: [1, 1], roughness: 0.85, vertexColors: true
  });
  mats.plaza = make({
    name: 'plaza', map: T('tileFloor', 'sidewalk'), uvScale: [1, 1], roughness: 0.6,
    vertexColors: true, castShadow: false
  });
  mats.facadeGlass = make({
    name: 'facadeGlass', map: T('glassFacade', 'officeFacade'), uvScale: [1, 1],
    roughness: 0.22, metallic: 0.08, reflectivity: 0.09, vertexColors: true, windowGlow: 1
  });
  mats.facadeOffice = make({
    name: 'facadeOffice', map: T('officeFacade', 'glassFacade'), uvScale: [1, 1],
    roughness: 0.55, vertexColors: true, windowGlow: 1
  });
  mats.facadeApt = make({
    name: 'facadeApartment', map: T('apartmentFacade', 'officeFacade'), uvScale: [1, 1],
    roughness: 0.72, vertexColors: true, windowGlow: 1
  });
  mats.wall = make({
    name: 'wallConcrete', map: T('concrete'), normalMap: T('concrete_n'),
    uvScale: [1, 1], roughness: 0.88, vertexColors: true
  });
  mats.brick = make({
    name: 'wallBrick', map: T('brick'), normalMap: T('brick_n'),
    uvScale: [1, 1], roughness: 0.9, vertexColors: true
  });
  mats.shop = make({
    name: 'shopfront', map: T('shopFacade', 'shopfront', 'storefront', 'groundFloor', 'tileFloor', 'glassFacade'),
    uvScale: [1, 1], roughness: 0.35, reflectivity: 0.07, vertexColors: true, windowGlow: 0.55
  });
  mats.roof = make({
    name: 'roof', map: T('roofGravel', 'concrete'), uvScale: [1, 1], roughness: 0.96,
    vertexColors: true
  });
  mats.detail = make({
    name: 'detailMetal', map: T('metal'), normalMap: T('metal_n'), uvScale: [1, 1],
    roughness: 0.55, metallic: 0.55, vertexColors: true
  });
  mats.glassPanel = make({
    name: 'glassPanel', albedo: [0.42, 0.55, 0.62], roughness: 0.08, metallic: 0.0,
    reflectivity: 0.2, alpha: 0.32, blend: 'alpha', doubleSided: true, castShadow: false,
    vertexColors: true
  });
  for (let i = 0; i < 3; i++) {
    mats['neon' + i] = make({
      name: 'neon' + i, map: T('neonSign' + (i + 1), 'neonSign1'), unlit: true,
      vertexColors: true, emissive: [1, 1, 1], emissiveStrength: 1.7, roughness: 0.4,
      castShadow: false, doubleSided: false
    });
  }
  for (let i = 0; i < 2; i++) {
    mats['billboard' + i] = make({
      name: 'billboard' + i, map: T('billboard' + (i + 1), 'billboard1'), unlit: false,
      emissive: [1, 1, 1], emissiveStrength: 0.28, roughness: 0.62, vertexColors: true,
      castShadow: false
    });
  }
  // Instanced prop materials.
  mats.propPaint = make({
    name: 'propPaint', map: T('metal'), normalMap: T('metal_n'), uvScale: [0.9, 0.9],
    roughness: 0.52, metallic: 0.35, vertexColors: true
  });
  mats.propBark = make({
    name: 'treeBark', map: T('treeBark', 'dirt'), uvScale: [1, 1], roughness: 0.94,
    vertexColors: true
  });
  mats.propLeaf = make({
    name: 'foliage', map: T('leaves', 'grass'), uvScale: [1, 1], roughness: 0.86,
    vertexColors: true, doubleSided: true
  });
  mats.propGlass = make({
    name: 'propGlass', albedo: [0.5, 0.62, 0.68], roughness: 0.07, reflectivity: 0.2,
    alpha: 0.3, blend: 'alpha', doubleSided: true, castShadow: false, vertexColors: true
  });
  mats.propLamp = make({
    name: 'propLamp', unlit: true, vertexColors: true, emissive: [1, 1, 1],
    emissiveStrength: 1.0, albedo: [1, 1, 1], castShadow: false
  });
  mats.propSign = make({
    name: 'propSign', map: T('billboard3', 'billboard1', 'graffiti1'), roughness: 0.6,
    emissive: [1, 1, 1], emissiveStrength: 0.2, vertexColors: true, castShadow: false
  });
  const bulb = (r, g, b) => make({
    name: 'bulb', unlit: true, albedo: [r, g, b], emissive: [r, g, b], emissiveStrength: 2.2,
    castShadow: false, vertexColors: false
  });
  mats.bulbRed = bulb(3.4, 0.28, 0.16);
  mats.bulbAmber = bulb(3.6, 1.7, 0.18);
  mats.bulbGreen = bulb(0.4, 3.4, 0.9);
  return mats;
}

/**
 * Patches a material in place, going through the renderer when it exposes an updater so
 * uniform blocks are invalidated correctly.
 * @param {object} renderer Renderer.
 * @param {object} mat Material.
 * @param {object} patch Fields to apply.
 * @returns {void}
 */
function patchMaterial(renderer, mat, patch) {
  if (!mat) return;
  if (typeof renderer.updateMaterial === 'function') { renderer.updateMaterial(mat, patch); return; }
  const keys = Object.keys(patch);
  for (let i = 0; i < keys.length; i++) mat[keys[i]] = patch[keys[i]];
  if (typeof mat.version === 'number') mat.version++;
  mat.dirty = true;
}
