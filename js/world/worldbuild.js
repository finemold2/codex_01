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
    // Right vector for the game's yaw convention: forward (0,0,1) has right (-1,0,0).
    const rx = -dirZ, rz = dirX;
    const cr = color[0], cg = color[1], cb = color[2];
    const lbx = cx - rx * hw - dirX * hd, lbz = cz - rz * hw - dirZ * hd;
    const rbx = cx + rx * hw - dirX * hd, rbz = cz + rz * hw - dirZ * hd;
    const rfx = cx + rx * hw + dirX * hd, rfz = cz + rz * hw + dirZ * hd;
    const lfx = cx - rx * hw + dirX * hd, lfz = cz - rz * hw + dirZ * hd;
    const i0 = this.vert(lbx, y, lbz, 0, 1, 0, r.u0, r.v0, cr, cg, cb);
    const i1 = this.vert(rbx, y, rbz, 0, 1, 0, r.u1, r.v0, cr, cg, cb);
    const i2 = this.vert(rfx, y, rfz, 0, 1, 0, r.u1, r.v1, cr, cg, cb);
    const i3 = this.vert(lfx, y, lfz, 0, 1, 0, r.u0, r.v1, cr, cg, cb);
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

/* --------------------------------------------------------- ground & water */

/**
 * Converts a canvas-space atlas rectangle into GL UV space (the texture uploader flips Y).
 * @param {{u0:number,v0:number,u1:number,v1:number}} r Canvas-space rectangle.
 * @returns {{u0:number,v0:number,u1:number,v1:number}} GL-space rectangle.
 */
function glRect(r) {
  return { u0: r.u0, v0: 1 - r.v1, u1: r.u1, v1: 1 - r.v0 };
}

/**
 * Picks the ground tint for a world position: district colour, dirt/grass noise, a sand
 * band along the shoreline and a darker, bluer bed below the waterline.
 * @param {object} bc Build context.
 * @param {number} x World x.
 * @param {number} z World z.
 * @param {number} h Terrain height at the sample.
 * @param {number[]} out Destination rgb.
 * @returns {number[]} out
 */
function groundTint(bc, x, z, h, out) {
  const d = districtAtPoint(bc, x, z);
  const base = (d && DISTRICT_GROUND[d.kind]) || DISTRICT_GROUND.residential;
  const n = fbm(x * 0.035, z * 0.035, bc.seed + 991, 3);
  const k = 0.72 + n * 0.55;
  out[0] = base[0] * k;
  out[1] = base[1] * k;
  out[2] = base[2] * k;
  const wl = bc.terrain.waterLevel;
  if (wl !== null) {
    // Sand band just above the waterline, wet mud just below it.
    const beach = 1 - smoothstep(0.0, 3.4, h - wl);
    if (beach > 0) {
      const sand = DISTRICT_GROUND.beach;
      out[0] = lerp(out[0], sand[0] * k, beach);
      out[1] = lerp(out[1], sand[1] * k, beach);
      out[2] = lerp(out[2], sand[2] * k, beach);
    }
    const deep = smoothstep(0, 6, wl - h);
    if (deep > 0) {
      out[0] = lerp(out[0], 0.075 * k, deep);
      out[1] = lerp(out[1], 0.085 * k, deep);
      out[2] = lerp(out[2], 0.075 * k, deep);
    }
  }
  return out;
}

/**
 * Finds the district containing a point (linear scan over a handful of rectangles).
 * @param {object} bc Build context.
 * @param {number} x World x.
 * @param {number} z World z.
 * @returns {object|null} District or null.
 */
function districtAtPoint(bc, x, z) {
  const list = bc.city.districts;
  if (!list) return null;
  let best = null, bestD = Infinity;
  for (let i = 0; i < list.length; i++) {
    const r = list[i].rect;
    const x0 = r.x0 !== undefined ? r.x0 : r.x;
    const z0 = r.z0 !== undefined ? r.z0 : r.z;
    const x1 = r.x1 !== undefined ? r.x1 : r.x + r.w;
    const z1 = r.z1 !== undefined ? r.z1 : r.z + r.d;
    if (x >= x0 && x <= x1 && z >= z0 && z <= z1) return list[i];
    const dx = Math.max(x0 - x, x - x1, 0);
    const dz = Math.max(z0 - z, z - z1, 0);
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = list[i]; }
  }
  return best;
}

/**
 * Builds the terrain mesh as a grid of patches (one static batch each) so the horizon can be
 * frustum culled. Heights come straight from {@link Terrain} so collision and visuals agree.
 * @param {object} bc Build context.
 * @returns {void}
 */
function buildTerrainMesh(bc) {
  const t = bc.terrain;
  const cell = 10;
  const patches = 5;
  const spanX = t.maxX - t.minX;
  const spanZ = t.maxZ - t.minZ;
  const nx = Math.ceil(spanX / cell);
  const nz = Math.ceil(spanZ / cell);
  const perX = Math.ceil(nx / patches);
  const perZ = Math.ceil(nz / patches);
  const col = [0, 0, 0];

  for (let pz = 0; pz < patches; pz++) {
    for (let px = 0; px < patches; px++) {
      const i0 = px * perX, i1 = Math.min(nx, i0 + perX);
      const j0 = pz * perZ, j1 = Math.min(nz, j0 + perZ);
      if (i0 >= i1 || j0 >= j1) continue;
      const mb = new MeshBuilder((i1 - i0 + 1) * (j1 - j0 + 1));
      const w = i1 - i0 + 1;
      for (let j = j0; j <= j1; j++) {
        const z = t.minZ + j * cell;
        for (let i = i0; i <= i1; i++) {
          const x = t.minX + i * cell;
          const h = t.height(x, z);
          groundTint(bc, x, z, h, col);
          // Normal from central differences on the height field.
          const hx = t.height(x + cell, z) - t.height(x - cell, z);
          const hz = t.height(x, z + cell) - t.height(x, z - cell);
          const nxv = -hx, nyv = 2 * cell, nzv = -hz;
          const len = Math.hypot(nxv, nyv, nzv) || 1;
          mb.vert(x, h - GROUND_DROP, z, nxv / len, nyv / len, nzv / len,
            x * 0.08, z * 0.08, col[0], col[1], col[2]);
        }
      }
      for (let j = 0; j < j1 - j0; j++) {
        for (let i = 0; i < i1 - i0; i++) {
          const a = j * w + i;
          mb.quad(a, a + w, a + w + 1, a + 1);
        }
      }
      const geo = mb.toGeometry();
      if (!geo) continue;
      bc.stats.batches++;
      bc.stats.triangles += geo.indices.length / 3;
      if (typeof bc.renderer.addStatic === 'function') {
        const id = bc.renderer.addStatic(geo, bc.mats.terrain);
        if (id !== undefined && id !== null) bc.staticIds.push(id);
      }
    }
  }
}

/**
 * Builds the sea: one gently tessellated plane at `waterLevel` covering the whole terrain.
 * @param {object} bc Build context.
 * @returns {void}
 */
function buildWaterMesh(bc) {
  const wl = bc.terrain.waterLevel;
  if (wl === null) return;
  const t = bc.terrain;
  const seg = 24;
  const mb = new MeshBuilder((seg + 1) * (seg + 1));
  const x0 = t.minX - 300, z0 = t.minZ - 300;
  const x1 = t.maxX + 300, z1 = t.maxZ + 300;
  const dx = (x1 - x0) / seg, dz = (z1 - z0) / seg;
  for (let j = 0; j <= seg; j++) {
    for (let i = 0; i <= seg; i++) {
      const x = x0 + i * dx, z = z0 + j * dz;
      mb.vert(x, wl, z, 0, 1, 0, x * 0.02, z * 0.02, 1, 1, 1);
    }
  }
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i;
      mb.quad(a, a + seg + 1, a + seg + 2, a + 1);
    }
  }
  const geo = mb.toGeometry();
  if (!geo) return;
  bc.stats.batches++;
  bc.stats.triangles += geo.indices.length / 3;
  if (typeof bc.renderer.addStatic === 'function') {
    const id = bc.renderer.addStatic(geo, bc.mats.water);
    if (id !== undefined && id !== null) bc.staticIds.push(id);
  }
}

/* ------------------------------------------------------------------ roads */

/**
 * Emits one flat, world-UV quad. Overlapping road quads are harmless because the UVs are
 * derived from world position, so the overlap samples exactly the same texels.
 * @param {MeshBuilder} mb Target builder.
 * @param {number} cx Centre x.
 * @param {number} cz Centre z.
 * @param {number} dirX Unit direction x.
 * @param {number} dirZ Unit direction z.
 * @param {number} hw Half width.
 * @param {number} hl Half length.
 * @param {number} y Height.
 * @param {number} s UV scale (tiles per metre).
 * @param {number[]} color Vertex colour.
 * @returns {void}
 */
function pushSurfaceQuad(mb, cx, cz, dirX, dirZ, hw, hl, y, s, color) {
  const rx = -dirZ, rz = dirX;
  const r = color[0], g = color[1], b = color[2];
  const xs = [cx - rx * hw - dirX * hl, cx + rx * hw - dirX * hl,
    cx + rx * hw + dirX * hl, cx - rx * hw + dirX * hl];
  const zs = [cz - rz * hw - dirZ * hl, cz + rz * hw - dirZ * hl,
    cz + rz * hw + dirZ * hl, cz - rz * hw + dirZ * hl];
  const i0 = mb.vert(xs[0], y, zs[0], 0, 1, 0, xs[0] * s, zs[0] * s, r, g, b);
  const i1 = mb.vert(xs[1], y, zs[1], 0, 1, 0, xs[1] * s, zs[1] * s, r, g, b);
  const i2 = mb.vert(xs[2], y, zs[2], 0, 1, 0, xs[2] * s, zs[2] * s, r, g, b);
  const i3 = mb.vert(xs[3], y, zs[3], 0, 1, 0, xs[3] * s, zs[3] * s, r, g, b);
  mb.quad(i0, i1, i2, i3);
}

/**
 * Builds every road surface plus square pads under the intersections.
 * @param {object} bc Build context.
 * @returns {void}
 */
function buildRoadSurfaces(bc) {
  const roads = bc.city.roads || [];
  const col = [1, 1, 1];
  const uv = 1 / 9;
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i];
    const dx = r.bx - r.ax, dz = r.bz - r.az;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    const ux = dx / len, uz = dz / len;
    const cx = (r.ax + r.bx) * 0.5, cz = (r.az + r.bz) * 0.5;
    const half = r.width * 0.5;
    // Extend by half a width at each end so consecutive segments and corners never gap.
    const hl = len * 0.5 + half;
    const shade = 0.86 + hash2(Math.round(cx), Math.round(cz), bc.seed) * 0.2;
    col[0] = shade; col[1] = shade; col[2] = shade * 1.01;
    pushSurfaceQuad(bc.coarse.at(cx, cz, 'asphalt'), cx, cz, ux, uz, half, hl, ROAD_Y, uv, col);
  }
  const nodes = bc.city.nodes || [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const half = bc.nodeHalf[i];
    if (!(half > 0)) continue;
    col[0] = 0.9; col[1] = 0.9; col[2] = 0.91;
    pushSurfaceQuad(bc.coarse.at(n.x, n.z, 'asphalt'), n.x, n.z, 0, 1, half, half, ROAD_Y, uv, col);
  }
}

/**
 * Paints the road-marking decal layer from the `roadLines` atlas: lane dashes, the double
 * yellow centre line on multi-lane roads, stop bars, zebra crossings and lane arrows at
 * every signalled approach.
 * @param {object} bc Build context.
 * @returns {void}
 */
function buildRoadMarkings(bc) {
  const src = (TEXLIB && TEXLIB.ROAD_MARKING_UV) || FALLBACK_MARKING_UV;
  const R = {
    dash: glRect(src.dash), solid: glRect(src.solid), doubleYellow: glRect(src.doubleYellow),
    stopBar: glRect(src.stopBar), crosswalk: glRect(src.crosswalk),
    arrowStraight: glRect(src.arrowStraight), arrowLeft: glRect(src.arrowLeft),
    arrowRight: glRect(src.arrowRight), parking: glRect(src.parking)
  };
  bc.markRects = R;
  const roads = bc.city.roads || [];
  const nodes = bc.city.nodes || [];
  const white = [1, 1, 1];

  for (let i = 0; i < roads.length; i++) {
    const r = roads[i];
    const dx = r.bx - r.ax, dz = r.bz - r.az;
    const len = Math.hypot(dx, dz);
    if (len < 6) continue;
    const ux = dx / len, uz = dz / len;
    const half = r.width * 0.5;
    const lanesPerDir = Math.max(1, r.lanesPerDir || Math.max(1, Math.round((r.lanes || 2) / 2)));
    const laneW = r.width / (lanesPerDir * 2);

    // Trim the ends that sit inside an intersection.
    const na = nodes[r.nodeA], nb = nodes[r.nodeB];
    let t0 = 0, t1 = len;
    if (na && Math.hypot(na.x - r.ax, na.z - r.az) < 1.2) t0 = bc.nodeHalf[r.nodeA] + 3.2;
    if (nb && Math.hypot(nb.x - r.bx, nb.z - r.bz) < 1.2) t1 = len - (bc.nodeHalf[r.nodeB] + 3.2);
    if (t1 - t0 < 4) continue;

    // Centre line: double yellow when the road carries opposing traffic, otherwise nothing.
    if (lanesPerDir >= 1 && r.kind !== 'turn') {
      const segLen = t1 - t0;
      const cx = r.ax + ux * (t0 + segLen * 0.5);
      const cz = r.az + uz * (t0 + segLen * 0.5);
      const mb = bc.coarse.at(cx, cz, 'mark');
      // Tile the yellow band along the road by emitting 12 m chunks (keeps UVs in 0..1).
      const chunks = Math.max(1, Math.round(segLen / 12));
      const cl = segLen / chunks;
      for (let c = 0; c < chunks; c++) {
        const s = t0 + cl * (c + 0.5);
        mb.addOrientedQuad(r.ax + ux * s, r.az + uz * s, MARK_Y, 0.7, cl * 0.5, ux, uz, R.doubleYellow, white);
      }
    }

    // Lane dashes on every interior lane boundary of each direction.
    for (let side = -1; side <= 1; side += 2) {
      for (let k = 1; k < lanesPerDir; k++) {
        const off = side * k * laneW;
        const period = 9;
        const count = Math.floor((t1 - t0) / period);
        for (let c = 0; c < count; c++) {
          const s = t0 + period * (c + 0.5);
          const px = r.ax + ux * s - uz * off;
          const pz = r.az + uz * s + ux * off;
          const mb = bc.coarse.at(px, pz, 'mark');
          mb.addOrientedQuad(px, pz, MARK_Y, 0.46, 1.6, ux, uz, R.dash, white);
        }
      }
    }

    // Kerb-side solid edge line on wide roads.
    if (r.width >= 18) {
      const period = 12;
      const count = Math.floor((t1 - t0) / period);
      for (let side = -1; side <= 1; side += 2) {
        const off = side * (half - 0.55);
        for (let c = 0; c < count; c++) {
          const s = t0 + period * (c + 0.5);
          const px = r.ax + ux * s - uz * off;
          const pz = r.az + uz * s + ux * off;
          bc.coarse.at(px, pz, 'mark')
            .addOrientedQuad(px, pz, MARK_Y, 0.46, period * 0.5, ux, uz, R.solid, white);
        }
      }
    }
  }

  // Intersection furniture: zebra crossings, stop bars and lane arrows on each approach.
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const half = bc.nodeHalf[i];
    if (!(half > 0)) continue;
    const approaches = bc.nodeApproaches[i];
    if (!approaches || approaches.length < 3) continue;
    const signalled = !!n.hasTrafficLight;
    for (let a = 0; a < approaches.length; a++) {
      const ap = approaches[a];
      // ap.dx/dz points away from the node, along the outgoing road.
      const outX = ap.dx, outZ = ap.dz;
      const w = ap.width;
      const cw = half + 2.6;
      const px = n.x + outX * cw, pz = n.z + outZ * cw;
      const mb = bc.coarse.at(px, pz, 'mark');
      mb.addOrientedQuad(px, pz, MARK_Y, w * 0.5, 1.9, outX, outZ, R.crosswalk, white);
      // Stop bar for the traffic coming towards the node: right half of the carriageway.
      const sx = n.x + outX * (cw + 2.6), sz = n.z + outZ * (cw + 2.6);
      const rx = -outZ, rz = outX;
      const bx = sx + rx * w * 0.25, bz = sz + rz * w * 0.25;
      bc.coarse.at(bx, bz, 'mark')
        .addOrientedQuad(bx, bz, MARK_Y, w * 0.25, 0.5, outX, outZ, R.stopBar, white);
      if (signalled && w >= 11) {
        // Lane arrows pointing into the junction (so drawn facing -out).
        const lanes = Math.max(1, Math.round(w / 7));
        for (let l = 0; l < lanes; l++) {
          const t = (l + 0.5) / lanes;
          const off = w * 0.25 * (t * 2 - 1) + w * 0.25;
          const ax2 = sx + rx * off + outX * 6.5;
          const az2 = sz + rz * off + outZ * 6.5;
          const rect = l === 0 ? R.arrowRight : (l === lanes - 1 && lanes > 2 ? R.arrowLeft : R.arrowStraight);
          bc.coarse.at(ax2, az2, 'mark')
            .addOrientedQuad(ax2, az2, MARK_Y, 1.25, 1.7, -outX, -outZ, rect, white);
        }
      }
    }
  }
}

/* ------------------------------------------------------------ lot surfaces */

/**
 * Emits a convex polygon with a Newell normal and planar UVs.
 * @param {MeshBuilder} mb Target builder.
 * @param {number[][]} pts World-space points in CCW order seen from the front face.
 * @param {number[]} color Vertex colour.
 * @param {number} uvScale Tiles per metre.
 * @returns {void}
 */
function pushPoly(mb, pts, color, uvScale) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  const base = mb.vcount;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    let u, v;
    if (ay >= ax && ay >= az) { u = p[0]; v = p[2]; } else if (ax >= az) { u = p[2]; v = p[1]; } else { u = p[0]; v = p[1]; }
    mb.vert(p[0], p[1], p[2], nx, ny, nz, u * uvScale, v * uvScale, color[0], color[1], color[2]);
  }
  for (let i = 2; i < pts.length; i++) mb.tri(base, base + i - 1, base + i);
}

/**
 * Builds the raised pavement, kerb ring and interior surface of every city block, plus the
 * collision slab that makes the sidewalk 15 cm higher than the road.
 * @param {object} bc Build context.
 * @returns {void}
 */
function buildLotSurfaces(bc) {
  const lots = bc.city.lots || [];
  const walkCol = [0.86, 0.86, 0.88];
  const kerbCol = [0.74, 0.74, 0.76];
  const grassCol = [0.42, 0.72, 0.34];
  const asphaltCol = [0.9, 0.9, 0.92];
  const plazaCol = [0.92, 0.9, 0.88];
  const rb = bc.roadBox;

  for (let i = 0; i < lots.length; i++) {
    const l = lots[i];
    if (l.kind === 'water' || l.surface === 'water' || l.surface === 'sand') continue;
    const x0 = l.x0 !== undefined ? l.x0 : l.x - l.w * 0.5;
    const z0 = l.z0 !== undefined ? l.z0 : l.z - l.d * 0.5;
    const x1 = l.x1 !== undefined ? l.x1 : l.x + l.w * 0.5;
    const z1 = l.z1 !== undefined ? l.z1 : l.z + l.d * 0.5;
    // Fringe lots outside the road network keep the natural terrain.
    if (x0 < rb[0] - 6 || z0 < rb[1] - 6 || x1 > rb[2] + 6 || z1 > rb[3] + 6) continue;
    const w = x1 - x0, d = z1 - z0;
    if (w < 4 || d < 4) continue;
    bc.raised[i] = 1;

    const cx = (x0 + x1) * 0.5, cz = (z0 + z1) * 0.5;
    const kerb = bc.coarse.at(cx, cz, 'kerb');
    const shade = 0.92 + hash2(Math.round(cx), Math.round(cz), bc.seed + 3) * 0.14;
    const kc = [kerbCol[0] * shade, kerbCol[1] * shade, kerbCol[2] * shade];
    // Kerb ring: four boxes so the vertical face reads as a real kerb from the road.
    const kh = (SIDEWALK_H + 0.02) * 0.5;
    kerb.addBox(cx, kh, z0 + KERB_W * 0.5, w * 0.5, kh, KERB_W * 0.5, 0, { color: kc, uScale: 0.5, faces: ALL_FACES & ~NY });
    kerb.addBox(cx, kh, z1 - KERB_W * 0.5, w * 0.5, kh, KERB_W * 0.5, 0, { color: kc, uScale: 0.5, faces: ALL_FACES & ~NY });
    kerb.addBox(x0 + KERB_W * 0.5, kh, cz, KERB_W * 0.5, kh, d * 0.5 - KERB_W, 0, { color: kc, uScale: 0.5, faces: ALL_FACES & ~NY });
    kerb.addBox(x1 - KERB_W * 0.5, kh, cz, KERB_W * 0.5, kh, d * 0.5 - KERB_W, 0, { color: kc, uScale: 0.5, faces: ALL_FACES & ~NY });

    const ix0 = x0 + KERB_W, iz0 = z0 + KERB_W, ix1 = x1 - KERB_W, iz1 = z1 - KERB_W;
    const walkW = Math.min(3.0 - KERB_W, Math.min(w, d) * 0.24);
    const surf = l.surface || 'concrete';
    const interiorKey = l.kind === 'park' ? (surf === 'grass' ? 'grass' : 'terrain')
      : l.kind === 'parking' ? 'asphalt'
        : l.kind === 'plaza' ? 'plaza' : null;
    const uvWalk = 1 / 3.6;

    if (!interiorKey) {
      // Plain pavement over the whole block; buildings sit on top of it.
      bc.coarse.at(cx, cz, 'sidewalk')
        .addFlatQuad(ix0, iz0, ix1, iz1, SIDEWALK_H,
          ix0 * uvWalk, iz0 * uvWalk, ix1 * uvWalk, iz1 * uvWalk, walkCol);
    } else {
      const jx0 = ix0 + walkW, jz0 = iz0 + walkW, jx1 = ix1 - walkW, jz1 = iz1 - walkW;
      const sw = bc.coarse.at(cx, cz, 'sidewalk');
      sw.addFlatQuad(ix0, iz0, ix1, jz0, SIDEWALK_H, ix0 * uvWalk, iz0 * uvWalk, ix1 * uvWalk, jz0 * uvWalk, walkCol);
      sw.addFlatQuad(ix0, jz1, ix1, iz1, SIDEWALK_H, ix0 * uvWalk, jz1 * uvWalk, ix1 * uvWalk, iz1 * uvWalk, walkCol);
      sw.addFlatQuad(ix0, jz0, jx0, jz1, SIDEWALK_H, ix0 * uvWalk, jz0 * uvWalk, jx0 * uvWalk, jz1 * uvWalk, walkCol);
      sw.addFlatQuad(jx1, jz0, ix1, jz1, SIDEWALK_H, jx1 * uvWalk, jz0 * uvWalk, ix1 * uvWalk, jz1 * uvWalk, walkCol);
      const col = interiorKey === 'grass' ? grassCol : interiorKey === 'asphalt' ? asphaltCol : plazaCol;
      const uv = interiorKey === 'grass' ? 1 / 7 : interiorKey === 'asphalt' ? 1 / 9 : 1 / 3;
      bc.coarse.at(cx, cz, interiorKey)
        .addFlatQuad(jx0, jz0, jx1, jz1, SIDEWALK_H, jx0 * uv, jz0 * uv, jx1 * uv, jz1 * uv, col);
      if (interiorKey === 'asphalt' && bc.markRects) {
        // Parking bays: two rows of stalls with painted dividers.
        const bay = 2.6;
        const rows = Math.max(1, Math.floor((jz1 - jz0) / 5.4));
        const mb = bc.coarse.at(cx, cz, 'mark');
        for (let ry = 0; ry < rows; ry++) {
          const zc = jz0 + (ry + 0.5) * ((jz1 - jz0) / rows);
          const count = Math.floor((jx1 - jx0) / bay);
          for (let s = 0; s < count; s++) {
            const xc = jx0 + (s + 0.5) * bay;
            mb.addOrientedQuad(xc, zc, MARK_Y + SIDEWALK_H, bay * 0.5, 2.4, 0, 1, bc.markRects.parking, [1, 1, 1]);
          }
        }
      }
    }

    if (bc.collision) {
      bc.bodies.push(bc.collision.addBox(cx, SIDEWALK_H * 0.5, cz, w * 0.5, SIDEWALK_H * 0.5, d * 0.5,
        0, 'kerb', { lotId: l.id }));
    }
  }
}

/* -------------------------------------------------------------- buildings */

/**
 * Places a box expressed in a building's local frame.
 * @param {MeshBuilder} mb Target builder.
 * @param {object} b Building record.
 * @param {number} lx Local x offset.
 * @param {number} y World y centre.
 * @param {number} lz Local z offset.
 * @param {number} hx Half extent x.
 * @param {number} hy Half extent y.
 * @param {number} hz Half extent z.
 * @param {object} opt Options forwarded to {@link MeshBuilder#addBox}.
 * @returns {void}
 */
function localBox(mb, b, lx, y, lz, hx, hy, hz, opt) {
  const rot = b.rot || 0;
  const c = Math.cos(rot), s = Math.sin(rot);
  mb.addBox(b.x + lx * c + lz * s, y, b.z - lx * s + lz * c, hx, hy, hz, rot, opt);
}

/**
 * Transforms a local (x, z) offset of a building into world space.
 * @param {object} b Building record.
 * @param {number} lx Local x.
 * @param {number} lz Local z.
 * @param {number[]} out Destination `[x, z]`.
 * @returns {number[]} out
 */
function localXZ(b, lx, lz, out) {
  const rot = b.rot || 0;
  const c = Math.cos(rot), s = Math.sin(rot);
  out[0] = b.x + lx * c + lz * s;
  out[1] = b.z - lx * s + lz * c;
  return out;
}

/**
 * Adds a hip (pitched) roof over a building's top storey.
 * @param {object} bc Build context.
 * @param {object} b Building record.
 * @param {number} y0 Eaves height.
 * @param {number} rise Ridge height above the eaves.
 * @param {number} ov Overhang in metres.
 * @param {number[]} color Roof colour.
 * @returns {void}
 */
function addHipRoof(bc, b, y0, rise, ov, color) {
  const mb = bc.chunks.at(b.x, b.z, 'roof');
  const W = b.w * 0.5 + ov, D = b.d * 0.5 + ov;
  const along = W >= D;
  const ridge = along ? Math.max(0.4, W - D * 0.75) : Math.max(0.4, D - W * 0.75);
  const p = [0, 0];
  const P = (lx, ly, lz) => { localXZ(b, lx, lz, p); return [p[0], ly, p[1]]; };
  const y1 = y0 + rise;
  const c0 = P(-W, y0, -D), c1 = P(W, y0, -D), c2 = P(W, y0, D), c3 = P(-W, y0, D);
  if (along) {
    const r0 = P(-ridge, y1, 0), r1 = P(ridge, y1, 0);
    pushPoly(mb, [c0, c1, r1, r0], color, 0.5);
    pushPoly(mb, [c2, c3, r0, r1], color, 0.5);
    pushPoly(mb, [c1, c2, r1], color, 0.5);
    pushPoly(mb, [c3, c0, r0], color, 0.5);
  } else {
    const r0 = P(0, y1, -ridge), r1 = P(0, y1, ridge);
    pushPoly(mb, [c1, c2, r1, r0], color, 0.5);
    pushPoly(mb, [c3, c0, r0, r1], color, 0.5);
    pushPoly(mb, [c0, c1, r0], color, 0.5);
    pushPoly(mb, [c2, c3, r1], color, 0.5);
  }
  // Fascia board so the roof does not look paper thin from below.
  localBox(mb, b, 0, y0 - 0.12, 0, W, 0.12, D, { color: [color[0] * 0.7, color[1] * 0.7, color[2] * 0.7], uScale: 0.6 });
}

/**
 * Adds a north-light sawtooth roof over a warehouse.
 * @param {object} bc Build context.
 * @param {object} b Building record.
 * @param {number} y0 Roof base height.
 * @param {number[]} color Roof colour.
 * @param {number[]} glassColor Glazing colour.
 * @returns {void}
 */
function addSawtoothRoof(bc, b, y0, color, glassColor) {
  const mb = bc.chunks.at(b.x, b.z, 'roof');
  const gl = bc.chunks.at(b.x, b.z, 'facadeGlass');
  const W = b.w * 0.5, D = b.d * 0.5;
  const teeth = clamp(Math.round(b.w / 9), 2, 7);
  const step = b.w / teeth;
  const rise = clamp(b.w * 0.06, 1.2, 2.6);
  const p = [0, 0];
  const P = (lx, ly, lz) => { localXZ(b, lx, lz, p); return [p[0], ly, p[1]]; };
  for (let k = 0; k < teeth; k++) {
    const xa = -W + k * step, xb = xa + step;
    // Sloped pane rising towards +x, then a vertical glazed face dropping back.
    pushPoly(mb, [P(xa, y0, -D), P(xb, y0 + rise, -D), P(xb, y0 + rise, D), P(xa, y0, D)], color, 0.4);
    pushPoly(gl, [P(xb, y0 + rise, -D), P(xb, y0, -D), P(xb, y0, D), P(xb, y0 + rise, D)], glassColor, 0.16);
    pushPoly(mb, [P(xa, y0, -D), P(xa, y0, -D + 0.01), P(xb, y0 + rise, -D)], color, 0.4);
  }
}

/**
 * Adds roof clutter: stair bulkhead, AC units, water tank, vents, aerials and, on tall
 * downtown blocks, a lit rooftop billboard.
 * @param {object} bc Build context.
 * @param {object} b Building record.
 * @param {number} roofY Roof surface height.
 * @param {number} hw Half width of the top tier.
 * @param {number} hd Half depth of the top tier.
 * @param {Rand} rng Deterministic random source.
 * @param {number[]} wallCol Wall colour.
 * @returns {void}
 */
function addRoofClutter(bc, b, roofY, hw, hd, rng, wallCol) {
  const det = bc.chunks.at(b.x, b.z, 'detail');
  const roof = bc.chunks.at(b.x, b.z, 'roof');
  const ix = Math.max(0.6, hw - 1.6), iz = Math.max(0.6, hd - 1.6);
  const grey = [0.62, 0.63, 0.65];
  const dark = [0.34, 0.35, 0.37];

  // Stair / lift bulkhead.
  if (hw > 3 && hd > 3) {
    const bw = clamp(hw * 0.34, 1.1, 3.2), bd = clamp(hd * 0.34, 1.1, 3.0);
    const bx = rng.range(-ix + bw, ix - bw), bz = rng.range(-iz + bd, iz - bd);
    const bh = rng.range(2.2, 3.4);
    localBox(roof, b, bx, roofY + bh * 0.5, bz, bw, bh * 0.5, bd, {
      color: [wallCol[0] * 0.85, wallCol[1] * 0.85, wallCol[2] * 0.85], uScale: 0.42
    });
    localBox(det, b, bx, roofY + bh + 0.06, bz, bw + 0.14, 0.07, bd + 0.14, { color: dark, uScale: 0.5 });
  }

  // Air conditioning units with fan cowls.
  const acs = rng.int(1, hw > 8 ? 5 : 3);
  for (let i = 0; i < acs; i++) {
    const w = rng.range(0.7, 1.15), d = rng.range(0.55, 0.95), h = rng.range(0.55, 0.95);
    const x = rng.range(-ix + w, ix - w), z = rng.range(-iz + d, iz - d);
    localBox(det, b, x, roofY + h * 0.5, z, w, h * 0.5, d, { color: grey, uScale: 1.1 });
    const p = localXZ(b, x, z, [0, 0]);
    det.addGeometry(bc.proto.fan, trs(bc.m16, p[0], roofY + h + 0.05, p[1], b.rot || 0, 1, 1, 1), dark);
    localBox(det, b, x, roofY + h * 0.55, z + d + 0.03, w * 0.8, h * 0.28, 0.03, { color: dark, uScale: 2 });
  }

  // Water tank on legs.
  if (hw > 4 && hd > 4 && rng.chance(0.55)) {
    const r = rng.range(1.0, 1.7);
    const x = rng.range(-ix + r, ix - r), z = rng.range(-iz + r, iz - r);
    const p = localXZ(b, x, z, [0, 0]);
    const legH = 0.9, tankH = rng.range(1.8, 2.6);
    for (let l = 0; l < 4; l++) {
      const a = (l / 4) * Math.PI * 2 + 0.78;
      localBox(det, b, x + Math.cos(a) * r * 0.72, roofY + legH * 0.5, z + Math.sin(a) * r * 0.72,
        0.08, legH * 0.5, 0.08, { color: dark, uScale: 2 });
    }
    det.addGeometry(bc.proto.tank, trs(bc.m16, p[0], roofY + legH + tankH * 0.5, p[1], 0, r, tankH * 0.5, r),
      [0.46, 0.4, 0.34]);
    det.addGeometry(bc.proto.tankTop, trs(bc.m16, p[0], roofY + legH + tankH + 0.28, p[1], 0, r * 1.04, 1, r * 1.04),
      [0.4, 0.35, 0.3]);
  }

  // Vent pipes.
  const vents = rng.int(1, 4);
  for (let i = 0; i < vents; i++) {
    const x = rng.range(-ix, ix), z = rng.range(-iz, iz);
    const h = rng.range(0.5, 1.3);
    const p = localXZ(b, x, z, [0, 0]);
    det.addGeometry(bc.proto.vent, trs(bc.m16, p[0], roofY + h * 0.5, p[1], 0, 1, h * 0.5, 1), grey);
  }

  // Aerial mast with cross arms.
  if (b.h > 24 && rng.chance(0.5)) {
    const x = rng.range(-ix, ix), z = rng.range(-iz, iz);
    const h = rng.range(3.5, 9);
    const p = localXZ(b, x, z, [0, 0]);
    det.addGeometry(bc.proto.mast, trs(bc.m16, p[0], roofY + h * 0.5, p[1], 0, 1, h * 0.5, 1), dark);
    for (let a = 0; a < 3; a++) {
      const yy = roofY + h * (0.55 + a * 0.14);
      localBox(det, b, x, yy, z, 0.62 - a * 0.14, 0.03, 0.03, { color: dark, uScale: 2 });
    }
    bc.lights.push({ x: p[0], y: roofY + h, z: p[1], r: 1.4, g: 0.12, b: 0.12, radius: 9, intensity: 1.2, night: true, blink: true });
  }
}

/**
 * Adds the emissive signage a building carries (shopfront strips, vertical blade signs and
 * rooftop letters). Colours come straight from citygen and are HDR, so bloom picks them up.
 * @param {object} bc Build context.
 * @param {object} b Building record.
 * @returns {void}
 */
function addBuildingSigns(bc, b) {
  const signs = b.signs;
  if (!signs || !signs.length) return;
  const rot = b.rot || 0;
  const c = Math.cos(rot), s = Math.sin(rot);
  for (let i = 0; i < signs.length; i++) {
    const sg = signs[i];
    const w = Math.max(0.6, sg.w || 2.4);
    const h = Math.max(0.4, sg.h || 1.0);
    const lx = (sg.x !== undefined ? sg.x : b.x) - b.x;
    const lz = (sg.z !== undefined ? sg.z : b.z) - b.z;
    const wx = b.x + lx * c + lz * s;
    const wz = b.z - lx * s + lz * c;
    const y = (sg.y !== undefined ? sg.y : b.h * 0.5) + h * 0.5;
    const alongX = Math.abs(sg.nx || 0) < 0.5;
    const hx = alongX ? w * 0.5 : 0.13;
    const hz = alongX ? 0.13 : w * 0.5;
    const col = sg.color || [2.4, 1.6, 3.0];
    const key = 'neon' + (Math.abs(b.id + i) % 3);
    const mb = bc.chunks.at(wx, wz, key);
    mb.addBox(wx, y, wz, hx, h * 0.5, hz, rot, { color: col, uv: 'fit', tileW: w, tileH: h });
    // Dark mounting frame just behind the neon face.
    bc.chunks.at(wx, wz, 'detail').addBox(
      wx - (sg.nx || 0) * 0.1, y, wz - (sg.nz || 0) * 0.1,
      hx * 1.04, h * 0.5 + 0.07, hz * 1.04, rot, { color: [0.12, 0.12, 0.14], uScale: 1.5 });
    bc.lights.push({
      x: wx + (sg.nx || 0) * 0.6, y, z: wz + (sg.nz || 0) * 0.6,
      r: clamp(col[0] * 0.4, 0, 1.6), g: clamp(col[1] * 0.4, 0, 1.6), b: clamp(col[2] * 0.4, 0, 1.6),
      radius: 7 + w, intensity: 0.9, night: true, neon: true
    });
    bc.signMaterials.add(key);
  }
}

/**
 * Adds apartment balconies on the two long faces, capped so a tall block never explodes the
 * triangle budget.
 * @param {object} bc Build context.
 * @param {object} b Building record.
 * @param {number} y0 First balcony floor height.
 * @param {number} floors Number of storeys above `y0`.
 * @param {number} floorH Storey height.
 * @param {number[]} col Slab colour.
 * @param {Rand} rng Random source.
 * @returns {void}
 */
function addBalconies(bc, b, y0, floors, floorH, col, rng) {
  const mb = bc.chunks.at(b.x, b.z, 'wall');
  const det = bc.chunks.at(b.x, b.z, 'detail');
  const hw = b.w * 0.5, hd = b.d * 0.5;
  const wide = b.w >= b.d;
  const span = wide ? hw : hd;
  const perFloor = clamp(Math.floor(span / 2.6), 1, 3);
  const maxFloors = Math.min(floors, Math.ceil(16 / (perFloor * 2)));
  const bw = Math.min(1.6, span / (perFloor + 0.4));
  const depth = 0.85;
  const rail = [0.3, 0.32, 0.35];
  for (let f = 0; f < maxFloors; f++) {
    const y = y0 + f * floorH + 0.1;
    for (let sideI = 0; sideI < 2; sideI++) {
      const sgn = sideI === 0 ? 1 : -1;
      for (let k = 0; k < perFloor; k++) {
        const t = (k + 0.5) / perFloor * 2 - 1;
        const along = t * (span - bw - 0.3);
        const lx = wide ? along : sgn * (hw + depth * 0.5);
        const lz = wide ? sgn * (hd + depth * 0.5) : along;
        const ex = wide ? bw : depth * 0.5;
        const ez = wide ? depth * 0.5 : bw;
        localBox(mb, b, lx, y, lz, ex, 0.07, ez, { color: col, uScale: 0.8 });
        // Railing: outer bar plus two returns.
        const oy = y + 0.47;
        if (wide) {
          localBox(det, b, lx, oy, lz + sgn * (depth * 0.5 - 0.04), ex, 0.42, 0.035, { color: rail, uScale: 1.4 });
          localBox(det, b, lx - ex, oy, lz, 0.035, 0.42, ez, { color: rail, uScale: 1.4 });
          localBox(det, b, lx + ex, oy, lz, 0.035, 0.42, ez, { color: rail, uScale: 1.4 });
        } else {
          localBox(det, b, lx + sgn * (depth * 0.5 - 0.04), oy, lz, 0.035, 0.42, ez, { color: rail, uScale: 1.4 });
          localBox(det, b, lx, oy, lz - ez, ex, 0.42, 0.035, { color: rail, uScale: 1.4 });
          localBox(det, b, lx, oy, lz + ez, ex, 0.42, 0.035, { color: rail, uScale: 1.4 });
        }
      }
    }
    if (rng.chance(0.12)) break;
  }
}

/**
 * Builds one complete building: shopfront, facade tiers with setbacks, roof, clutter,
 * balconies, signage and the matching collision boxes.
 * @param {object} bc Build context.
 * @param {object} b Building record.
 * @returns {void}
 */
function buildBuilding(bc, b) {
  const rng = new Rand((((bc.seed ^ 0x9e3779b9) >>> 0) + b.id * 2654435761) >>> 0);
  const pal = b.palette || {};
  const wallCol = pal.wall || [0.5, 0.5, 0.52];
  const trimCol = pal.trim || [0.38, 0.38, 0.4];
  const glassCol = pal.glass || [0.36, 0.46, 0.56];
  const style = b.style || 'office';
  const rot = b.rot || 0;
  const hw = b.w * 0.5, hd = b.d * 0.5;
  const H = Math.max(3, b.h);
  const roofKind = b.roofKind || 'flat';
  const floors = Math.max(1, b.floors || Math.round(H / FLOOR_H));
  const floorH = H / floors;

  const facadeKey = style === 'tower' ? 'facadeGlass'
    : style === 'office' ? 'facadeOffice'
      : style === 'apartment' ? 'facadeApt'
        : style === 'shop' ? 'facadeApt'
          : style === 'house' ? 'brick' : 'wall';
  const facadeCol = (style === 'tower' || style === 'office')
    ? [lerp(wallCol[0], glassCol[0], 0.55), lerp(wallCol[1], glassCol[1], 0.55), lerp(wallCol[2], glassCol[2], 0.55)]
    : wallCol;
  const commercial = style === 'shop' || style === 'office' || style === 'tower';
  const groundH = commercial ? Math.min(SHOP_H, H * 0.5) : 0;

  // --- ground floor -------------------------------------------------------
  if (groundH > 1.2) {
    const shop = bc.chunks.at(b.x, b.z, 'shop');
    localBox(shop, b, 0, groundH * 0.5, 0, hw + 0.16, groundH * 0.5, hd + 0.16, {
      color: [lerp(wallCol[0], 1, 0.15), lerp(wallCol[1], 1, 0.15), lerp(wallCol[2], 1, 0.15)],
      faces: SIDE_FACES, uv: 'fit', tileW: 6.0, tileH: groundH
    });
    const det = bc.chunks.at(b.x, b.z, 'detail');
    localBox(det, b, 0, groundH + 0.16, 0, hw + 0.52, 0.16, hd + 0.52, { color: trimCol, uScale: 0.7 });
    // Awning strip on the street-facing side.
    if (style === 'shop') {
      const f = b.face === undefined ? 3 : b.face;
      const ax = f === 0 ? hw + 0.7 : f === 2 ? -(hw + 0.7) : 0;
      const az = f === 1 ? hd + 0.7 : f === 3 ? -(hd + 0.7) : 0;
      const ex = (f === 0 || f === 2) ? 0.75 : hw * 0.7;
      const ez = (f === 0 || f === 2) ? hd * 0.7 : 0.75;
      localBox(det, b, ax, groundH - 0.55, az, ex, 0.07, ez, {
        color: [0.55, 0.14, 0.16], uScale: 1.2
      });
    }
  }

  // --- facade tiers -------------------------------------------------------
  const tiers = [];
  const bodyTop = roofKind === 'hip' ? H - Math.min(H * 0.22, 2.6) : H;
  if ((roofKind === 'setback' || b.hasSetback) && bodyTop - groundH > 22) {
    const t0 = groundH, t3 = bodyTop;
    const s1 = t0 + (t3 - t0) * 0.55, s2 = t0 + (t3 - t0) * 0.82;
    tiers.push({ y0: t0, y1: s1, k: 1 });
    tiers.push({ y0: s1, y1: s2, k: 0.83 });
    tiers.push({ y0: s2, y1: t3, k: 0.66 });
  } else {
    tiers.push({ y0: groundH, y1: bodyTop, k: 1 });
  }

  const fac = bc.chunks.at(b.x, b.z, facadeKey);
  const roofMb = bc.chunks.at(b.x, b.z, 'roof');
  for (let t = 0; t < tiers.length; t++) {
    const tr = tiers[t];
    const th = tr.y1 - tr.y0;
    if (th < 0.4) continue;
    const kw = hw * tr.k, kd = hd * tr.k;
    localBox(fac, b, 0, (tr.y0 + tr.y1) * 0.5, 0, kw, th * 0.5, kd, {
      color: facadeCol, faces: SIDE_FACES, uv: 'fit',
      tileW: FACADE_TILE_W, tileH: Math.max(3.2, FACADE_TILE_H)
    });
    // Corner pilasters give the silhouette some relief.
    if (style !== 'house' && kw > 3 && kd > 3) {
      const pw = 0.22;
      for (let cnr = 0; cnr < 4; cnr++) {
        const sx = cnr < 2 ? 1 : -1;
        const sz = (cnr % 2 === 0) ? 1 : -1;
        localBox(bc.chunks.at(b.x, b.z, 'wall'), b, sx * kw, (tr.y0 + tr.y1) * 0.5, sz * kd,
          pw, th * 0.5, pw, { color: trimCol, uScale: 0.5 });
      }
    }
    // Tier cap + parapet.
    const capY = tr.y1;
    localBox(roofMb, b, 0, capY + 0.09, 0, kw + 0.2, 0.09, kd + 0.2, { color: trimCol, uScale: 0.5 });
    const ph = t === tiers.length - 1 ? 0.95 : 0.7;
    const pt = 0.22;
    localBox(roofMb, b, 0, capY + 0.18 + ph * 0.5, kd + 0.2 - pt, kw + 0.2, ph * 0.5, pt, { color: trimCol, uScale: 0.6 });
    localBox(roofMb, b, 0, capY + 0.18 + ph * 0.5, -(kd + 0.2 - pt), kw + 0.2, ph * 0.5, pt, { color: trimCol, uScale: 0.6 });
    localBox(roofMb, b, kw + 0.2 - pt, capY + 0.18 + ph * 0.5, 0, pt, ph * 0.5, kd + 0.2 - pt * 2, { color: trimCol, uScale: 0.6 });
    localBox(roofMb, b, -(kw + 0.2 - pt), capY + 0.18 + ph * 0.5, 0, pt, ph * 0.5, kd + 0.2 - pt * 2, { color: trimCol, uScale: 0.6 });
    // Roof deck.
    const deckCol = [0.28, 0.28, 0.29];
    localBox(roofMb, b, 0, capY + 0.22, 0, kw + 0.18, 0.04, kd + 0.18, { color: deckCol, uScale: 0.4, faces: PY });
    if (bc.collision && t > 0) {
      const p = localXZ(b, 0, 0, [0, 0]);
      bc.bodies.push(bc.collision.addBox(p[0], (tr.y0 + tr.y1) * 0.5, p[1], kw, th * 0.5, kd, rot,
        'building', { buildingId: b.id, tier: t }));
    }
  }

  const top = tiers[tiers.length - 1];
  const topHw = hw * top.k, topHd = hd * top.k;
  const roofY = top.y1 + 0.26;

  // --- roof treatment -----------------------------------------------------
  if (roofKind === 'hip') {
    addHipRoof(bc, b, bodyTop, Math.min(H * 0.22, 2.6) + 0.6, 0.45,
      [trimCol[0] * 0.8 + 0.12, trimCol[1] * 0.72, trimCol[2] * 0.7]);
  } else if (roofKind === 'sawtooth') {
    addSawtoothRoof(bc, b, top.y1 + 0.3, [trimCol[0] * 0.9, trimCol[1] * 0.9, trimCol[2] * 0.92], glassCol);
  } else if (roofKind === 'dome') {
    const det = bc.chunks.at(b.x, b.z, 'detail');
    const r = Math.min(topHw, topHd);
    det.addGeometry(bc.proto.dome, trs(bc.m16, b.x, roofY, b.z, rot, topHw * 0.98, r * 0.62, topHd * 0.98),
      [lerp(trimCol[0], 0.8, 0.3), lerp(trimCol[1], 0.82, 0.3), lerp(trimCol[2], 0.85, 0.3)]);
  }
  if (roofKind !== 'hip' && roofKind !== 'dome') {
    addRoofClutter(bc, b, roofY, topHw, topHd, rng, wallCol);
  }

  // Rooftop billboard on tall commercial blocks.
  if (H > 22 && (style === 'tower' || style === 'office' || style === 'warehouse') && rng.chance(0.22)) {
    const key = 'billboard' + (b.id % 2);
    const mb = bc.chunks.at(b.x, b.z, key);
    const det = bc.chunks.at(b.x, b.z, 'detail');
    const bw = Math.min(topHw * 1.6, 7.5);
    const bh = bw * 0.42;
    const y = roofY + 1.4 + bh * 0.5;
    const face = topHw >= topHd ? 0 : 1;
    const lx = face === 0 ? 0 : topHw * 0.2;
    const lz = face === 0 ? topHd * 0.2 : 0;
    const ex = face === 0 ? bw : 0.16;
    const ez = face === 0 ? 0.16 : bw;
    localBox(mb, b, lx, y, lz, ex, bh * 0.5, ez, { color: [1, 1, 1], uv: 'fit', tileW: bw * 2, tileH: bh });
    localBox(det, b, lx - (face === 0 ? bw * 0.6 : 0), roofY + 0.7 + bh * 0.5, lz - (face === 0 ? 0 : bw * 0.6),
      0.12, bh * 0.5 + 0.7, 0.12, { color: [0.2, 0.2, 0.22], uScale: 2 });
    localBox(det, b, lx + (face === 0 ? bw * 0.6 : 0), roofY + 0.7 + bh * 0.5, lz + (face === 0 ? 0 : bw * 0.6),
      0.12, bh * 0.5 + 0.7, 0.12, { color: [0.2, 0.2, 0.22], uScale: 2 });
    const p = localXZ(b, lx, lz, [0, 0]);
    bc.lights.push({ x: p[0], y: y + bh * 0.6, z: p[1], r: 0.9, g: 0.85, b: 0.7, radius: 12, intensity: 1.1, night: true });
    bc.billboardMaterials.add(key);
  }

  // --- balconies ----------------------------------------------------------
  if (style === 'apartment' && floors > 2) {
    addBalconies(bc, b, groundH + floorH, floors - 1, floorH,
      [trimCol[0] * 0.9, trimCol[1] * 0.9, trimCol[2] * 0.9], rng);
  }

  addBuildingSigns(bc, b);

  // --- collision ----------------------------------------------------------
  if (bc.collision) {
    const bodyH = tiers[0].y1;
    bc.bodies.push(bc.collision.addBox(b.x, bodyH * 0.5, b.z, hw + (groundH > 1.2 ? 0.16 : 0), bodyH * 0.5,
      hd + (groundH > 1.2 ? 0.16 : 0), rot, 'building', { buildingId: b.id, name: b.name || null }));
    bc.buildingBodies++;
  }
}
