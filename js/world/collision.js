/**
 * NEON CITY - collision world.
 *
 * A uniform spatial hash over the XZ plane holding oriented boxes (yaw only) and vertical
 * cylinders, plus everything gameplay needs on top of it: the character mover, swept spheres,
 * raycasts and ground queries.
 *
 * Design notes:
 *  - Bodies live in one flat `Float32Array` (stride {@link BODY_STRIDE}) with parallel typed
 *    arrays for kind/flags/generation, and a parallel object array holding the public body
 *    records handed back by queries. Nothing is allocated while querying.
 *  - The hash is a power-of-two grid wrapped with a bitmask, so world coordinates never need to
 *    be centred or clamped; huge bodies (a ground plane) go into a small "oversize" list instead
 *    of being written into thousands of buckets.
 *  - Every body has a constant XZ cross section, which makes the character mover exact: the
 *    horizontal pass is a 2D circle-vs-cross-section test using the capsule radius at the
 *    overlapping height band, and the vertical pass is solved analytically.
 *
 * Units are meters, Y is up, `yaw = 0` faces -Z (see docs/ARCHITECTURE.md section 0).
 *
 * @module world/collision
 */

import { DEG2RAD } from '../core/math.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** Body kind: oriented box (yaw rotation about Y). @type {number} */
const KIND_BOX = 0;
/** Body kind: vertical cylinder (Y aligned). @type {number} */
const KIND_CYLINDER = 1;

/** Floats reserved per body in the packed body array. @type {number} */
const BODY_STRIDE = 16;
const B_CX = 0;
const B_CY = 1;
const B_CZ = 2;
const B_HX = 3;
const B_HY = 4;
const B_HZ = 5;
const B_SIN = 6;
const B_COS = 7;
const B_YAW = 8;
const B_MINX = 9;
const B_MINY = 10;
const B_MINZ = 11;
const B_MAXX = 12;
const B_MAXY = 13;
const B_MAXZ = 14;
const B_TOP = 15;

/** Slots reserved per generation step inside a body id. @type {number} */
const ID_SLOT_SPAN = 1 << 20;

/** Tags that exist only to be queried - they never block movement or act as ground. */
export const NON_SOLID_TAGS = ['trigger', 'sensor', 'zone', 'water', 'marker'];

/** Maximum height a grounded mover climbs without jumping (kerbs, low walls). @type {number} */
export const STEP_HEIGHT = 0.45;

/** Steepest walkable surface. Anything above this makes the mover slide. @type {number} */
export const SLOPE_LIMIT_DEG = 50;

/** Cosine of {@link SLOPE_LIMIT_DEG}, compared against a contact normal's Y. @type {number} */
const SLOPE_LIMIT_COS = Math.cos(SLOPE_LIMIT_DEG * DEG2RAD);

/** Contact skin: the mover is allowed to sit this close to a surface. @type {number} */
const SKIN = 0.02;

/** Extra downward probe used to keep a grounded mover glued to small drops. @type {number} */
const SNAP_DOWN = 0.18;

/** Depenetration passes per sub-step. @type {number} */
const DEPEN_PASSES = 4;

/**
 * Hard cap on mover sub-steps. A delta longer than `MAX_SUBSTEPS * radius * 0.5` is scaled down
 * rather than sub-stepped coarsely, so motion is truncated instead of tunnelling. Teleports must
 * assign the position directly instead of going through the mover.
 * @type {number}
 */
const MAX_SUBSTEPS = 512;

/** Broadphase padding around the mover's swept volume, in meters. @type {number} */
const BROAD_MARGIN = 0.6;

/** Cells a body may occupy before it is treated as "oversize". @type {number} */
const MAX_BODY_CELLS = 256;

/** Hard cap on candidates returned by one broadphase gather. @type {number} */
const MAX_CANDIDATES = 4096;

/** Hard cap on cells one DDA ray walk may visit. @type {number} */
const MAX_RAY_CELLS = 4096;

/** Pool sizes for ray / sweep results (results stay valid for this many further calls). */
const RAY_POOL_SIZE = 32;
const SWEEP_POOL_SIZE = 16;

/* -------------------------------------------------------------------------- */
/* Module scratch (single threaded, never escapes a call)                      */
/* -------------------------------------------------------------------------- */

/** Contact normal written by the narrow-phase helpers. */
let _nx = 0;
let _ny = 0;
let _nz = 0;

/** Closest point on a body's XZ cross section, and the distance to it. */
let _cpx = 0;
let _cpz = 0;
let _cpd = 0;

/** Ground probe output: contact flag, distance and normal. */
let _probeHit = false;
let _probeDist = 0;
let _pnx = 0;
let _pny = 1;
let _pnz = 0;

/** Shared move result used when the caller does not supply one. */
const _moveResult = {
  x: 0, y: 0, z: 0, grounded: false, groundY: 0,
  normal: new Float32Array([0, 1, 0]), hits: 0,
  stepped: false, hitWall: false, hitCeiling: false,
};

/**
 * Replaces a non-finite number with a fallback.
 * @param {number} v Value to sanitise.
 * @param {number} d Fallback value.
 * @returns {number} `v` when finite, otherwise `d`.
 */
function fin(v, d) {
  return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity ? v : d;
}

/* -------------------------------------------------------------------------- */
/* CollisionWorld                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The world's collision database and query engine.
 *
 * Bodies are static by default (add once, remove when a mission entity dies); moving bodies can
 * be re-placed with {@link CollisionWorld#updateBody}, which re-hashes them in place.
 */
export class CollisionWorld {
  /**
   * @param {number} [worldSize=1024] Approximate playable extent in meters. Only used to size the
   *   hash grid - coordinates outside it still work, they just share buckets.
   * @param {number} [cellSize=16] Grid cell size in meters.
   */
  constructor(worldSize = 1024, cellSize = 16) {
    this.worldSize = Math.max(64, fin(worldSize, 1024));
    this.cellSize = Math.max(1, fin(cellSize, 16));
    this.invCell = 1 / this.cellSize;

    // Power-of-two grid so cell wrapping is a bitmask instead of a modulo.
    let dim = 32;
    const want = Math.ceil(this.worldSize / this.cellSize);
    while (dim < want && dim < 1024) dim <<= 1;
    /** Grid resolution per axis. @type {number} */
    this.gridDim = dim;
    /** Bitmask used to wrap cell coordinates. @type {number} */
    this.gridMask = dim - 1;

    const cellCount = dim * dim;
    /** Head entry index per bucket, -1 when empty. @type {Int32Array} */
    this._cellHead = new Int32Array(cellCount).fill(-1);

    const cap = 2048;
    /** Packed body data, {@link BODY_STRIDE} floats each. @type {Float32Array} */
    this._f = new Float32Array(cap * BODY_STRIDE);
    /** Per-body kind. @type {Int32Array} */
    this._kind = new Int32Array(cap);
    /** Per-body liveness. @type {Uint8Array} */
    this._alive = new Uint8Array(cap);
    /** Per-body "blocks movement" flag. @type {Uint8Array} */
    this._solid = new Uint8Array(cap);
    /** Per-body "in the oversize list" flag. @type {Uint8Array} */
    this._huge = new Uint8Array(cap);
    /** Per-body id generation, bumped on every slot reuse. @type {Int32Array} */
    this._gen = new Int32Array(cap);
    /** Per-body occupied cell rectangle (minCX, minCZ, maxCX, maxCZ). @type {Int32Array} */
    this._rect = new Int32Array(cap * 4);
    /** Per-body visit stamp used to dedupe multi-cell bodies. @type {Int32Array} */
    this._stamp = new Int32Array(cap);
    /** Public body records, index aligned with the typed arrays. @type {Array<object>} */
    this._objects = new Array(cap).fill(null);
    /** Body slot capacity. @type {number} */
    this._capacity = cap;
    /** Highest slot ever used + 1. @type {number} */
    this._used = 0;
    /** Head of the free slot list, -1 when empty. @type {number} */
    this._freeHead = -1;
    /** Free slot chain (reuses `_rect[i*4]` would be fragile, so keep a dedicated array). */
    this._freeNext = new Int32Array(cap).fill(-1);

    const entCap = 4096;
    /** Body index per hash entry. @type {Int32Array} */
    this._entBody = new Int32Array(entCap);
    /** Next entry in the bucket chain. @type {Int32Array} */
    this._entNext = new Int32Array(entCap);
    /** Entry capacity. @type {number} */
    this._entCapacity = entCap;
    /** Next never-used entry. @type {number} */
    this._entUsed = 0;
    /** Head of the free entry list. @type {number} */
    this._entFree = -1;

    /** Body indices too large to hash, tested by every query. @type {Int32Array} */
    this._over = new Int32Array(64);
    /** Number of oversize bodies. @type {number} */
    this._overCount = 0;

    /** Broadphase candidate buffer. @type {Int32Array} */
    this._cand = new Int32Array(512);
    /** Candidates written by the last gather. @type {number} */
    this._candCount = 0;

    /** Visit stamp counter. @type {number} */
    this._stampCounter = 0;

    /** Terrain height sampler installed by the world builder. @type {(x:number,z:number)=>number} */
    this._terrainFn = null;
    /** True while `_terrainFn` is the flat default. @type {boolean} */
    this._terrainFlat = true;
    /** Height of the implicit flat floor used until `setTerrainFn` installs a real one. */
    this._terrainY = 0;
    /** When false, `raycast` ignores the terrain function and only tests bodies. @type {boolean} */
    this.terrainRaycast = true;

    /** Live body count. @type {number} */
    this._bodyCount = 0;
    /** Non-empty bucket count. @type {number} */
    this._cellsUsed = 0;

    /** @type {{bodies:number, cells:number, queriesLastFrame:number, rayCells:number, rayBodies:number, queriesTotal:number}} */
    this.stats = {
      bodies: 0, cells: 0, queriesLastFrame: 0, rayCells: 0, rayBodies: 0, queriesTotal: 0,
    };

    this._rayPool = new Array(RAY_POOL_SIZE);
    for (let i = 0; i < RAY_POOL_SIZE; i++) {
      this._rayPool[i] = {
        t: 0, point: new Float32Array(3), normal: new Float32Array(3), body: null,
      };
    }
    this._rayPoolAt = 0;

    this._sweepPool = new Array(SWEEP_POOL_SIZE);
    for (let i = 0; i < SWEEP_POOL_SIZE; i++) {
      const hit = new Float32Array(3);
      this._sweepPool[i] = {
        t: 0, distance: 0, hit, point: hit, normal: new Float32Array(3), body: null,
      };
    }
    this._sweepPoolAt = 0;
  }

  /** @returns {number} Number of live bodies. */
  get bodyCount() { return this._bodyCount; }

  /* ---------------------------------------------------------------- storage */

  /**
   * Doubles the per-body arrays.
   * @private
   */
  _growBodies() {
    const cap = this._capacity * 2;
    const f = new Float32Array(cap * BODY_STRIDE); f.set(this._f); this._f = f;
    const kind = new Int32Array(cap); kind.set(this._kind); this._kind = kind;
    const alive = new Uint8Array(cap); alive.set(this._alive); this._alive = alive;
    const solid = new Uint8Array(cap); solid.set(this._solid); this._solid = solid;
    const huge = new Uint8Array(cap); huge.set(this._huge); this._huge = huge;
    const gen = new Int32Array(cap); gen.set(this._gen); this._gen = gen;
    const rect = new Int32Array(cap * 4); rect.set(this._rect); this._rect = rect;
    const stamp = new Int32Array(cap); stamp.set(this._stamp); this._stamp = stamp;
    const next = new Int32Array(cap).fill(-1); next.set(this._freeNext); this._freeNext = next;
    this._objects.length = cap;
    this._capacity = cap;
  }

  /**
   * Doubles the hash entry pool.
   * @private
   */
  _growEntries() {
    const cap = this._entCapacity * 2;
    const body = new Int32Array(cap); body.set(this._entBody); this._entBody = body;
    const next = new Int32Array(cap); next.set(this._entNext); this._entNext = next;
    this._entCapacity = cap;
  }

  /**
   * Claims a body slot, reusing a freed one when possible.
   * @returns {number} Slot index.
   * @private
   */
  _allocSlot() {
    let i = this._freeHead;
    if (i !== -1) {
      this._freeHead = this._freeNext[i];
      this._freeNext[i] = -1;
      return i;
    }
    if (this._used >= this._capacity) this._growBodies();
    i = this._used++;
    return i;
  }

  /**
   * Recomputes a body's world AABB from its centre, half extents and yaw.
   * @param {number} i Slot index.
   * @private
   */
  _recomputeAabb(i) {
    const f = this._f;
    const o = i * BODY_STRIDE;
    const cx = f[o + B_CX];
    const cy = f[o + B_CY];
    const cz = f[o + B_CZ];
    const hy = f[o + B_HY];
    let ex;
    let ez;
    if (this._kind[i] === KIND_BOX) {
      const s = Math.abs(f[o + B_SIN]);
      const c = Math.abs(f[o + B_COS]);
      const hx = f[o + B_HX];
      const hz = f[o + B_HZ];
      ex = hx * c + hz * s;
      ez = hx * s + hz * c;
    } else {
      ex = f[o + B_HX];
      ez = f[o + B_HX];
    }
    f[o + B_MINX] = cx - ex;
    f[o + B_MINY] = cy - hy;
    f[o + B_MINZ] = cz - ez;
    f[o + B_MAXX] = cx + ex;
    f[o + B_MAXY] = cy + hy;
    f[o + B_MAXZ] = cz + ez;
    f[o + B_TOP] = cy + hy;
  }

  /**
   * Syncs the public record of a body with the packed data.
   * @param {number} i Slot index.
   * @private
   */
  _syncObject(i) {
    const f = this._f;
    const o = i * BODY_STRIDE;
    let b = this._objects[i];
    if (!b) {
      b = {
        id: 0, index: i, kind: 'box', cx: 0, cy: 0, cz: 0, hx: 0, hy: 0, hz: 0,
        yaw: 0, sin: 0, cos: 1, tag: 'static', userData: null,
        aabb: { min: new Float32Array(3), max: new Float32Array(3) },
      };
      this._objects[i] = b;
    }
    b.kind = this._kind[i] === KIND_BOX ? 'box' : 'cylinder';
    b.cx = f[o + B_CX];
    b.cy = f[o + B_CY];
    b.cz = f[o + B_CZ];
    b.hx = f[o + B_HX];
    b.hy = f[o + B_HY];
    b.hz = f[o + B_HZ];
    b.yaw = f[o + B_YAW];
    b.sin = f[o + B_SIN];
    b.cos = f[o + B_COS];
    b.aabb.min[0] = f[o + B_MINX];
    b.aabb.min[1] = f[o + B_MINY];
    b.aabb.min[2] = f[o + B_MINZ];
    b.aabb.max[0] = f[o + B_MAXX];
    b.aabb.max[1] = f[o + B_MAXY];
    b.aabb.max[2] = f[o + B_MAXZ];
    return b;
  }

  /**
   * Inserts a live body into the hash (or the oversize list).
   * @param {number} i Slot index.
   * @private
   */
  _insert(i) {
    const f = this._f;
    const o = i * BODY_STRIDE;
    const inv = this.invCell;
    const c0x = Math.floor(f[o + B_MINX] * inv);
    const c1x = Math.floor(f[o + B_MAXX] * inv);
    const c0z = Math.floor(f[o + B_MINZ] * inv);
    const c1z = Math.floor(f[o + B_MAXZ] * inv);
    const spanX = c1x - c0x + 1;
    const spanZ = c1z - c0z + 1;
    const r = i * 4;
    this._rect[r] = c0x;
    this._rect[r + 1] = c0z;
    this._rect[r + 2] = c1x;
    this._rect[r + 3] = c1z;

    if (spanX > this.gridDim || spanZ > this.gridDim || spanX * spanZ > MAX_BODY_CELLS) {
      this._huge[i] = 1;
      if (this._overCount >= this._over.length) {
        const grown = new Int32Array(this._over.length * 2);
        grown.set(this._over);
        this._over = grown;
      }
      this._over[this._overCount++] = i;
      return;
    }
    this._huge[i] = 0;

    const dim = this.gridDim;
    const mask = this.gridMask;
    for (let cx = c0x; cx <= c1x; cx++) {
      const row = (cx & mask) * dim;
      for (let cz = c0z; cz <= c1z; cz++) {
        let e = this._entFree;
        if (e !== -1) {
          this._entFree = this._entNext[e];
        } else {
          if (this._entUsed >= this._entCapacity) this._growEntries();
          e = this._entUsed++;
        }
        const cell = row + (cz & mask);
        if (this._cellHead[cell] === -1) this._cellsUsed++;
        this._entBody[e] = i;
        this._entNext[e] = this._cellHead[cell];
        this._cellHead[cell] = e;
      }
    }
  }

  /**
   * Removes a body from every bucket it occupies.
   * @param {number} i Slot index.
   * @private
   */
  _unlink(i) {
    if (this._huge[i]) {
      for (let k = 0; k < this._overCount; k++) {
        if (this._over[k] === i) {
          this._over[k] = this._over[--this._overCount];
          break;
        }
      }
      this._huge[i] = 0;
      return;
    }
    const r = i * 4;
    const c0x = this._rect[r];
    const c0z = this._rect[r + 1];
    const c1x = this._rect[r + 2];
    const c1z = this._rect[r + 3];
    const dim = this.gridDim;
    const mask = this.gridMask;
    for (let cx = c0x; cx <= c1x; cx++) {
      const row = (cx & mask) * dim;
      for (let cz = c0z; cz <= c1z; cz++) {
        const cell = row + (cz & mask);
        let e = this._cellHead[cell];
        let prev = -1;
        while (e !== -1) {
          if (this._entBody[e] === i) {
            const next = this._entNext[e];
            if (prev === -1) this._cellHead[cell] = next;
            else this._entNext[prev] = next;
            this._entNext[e] = this._entFree;
            this._entFree = e;
            if (this._cellHead[cell] === -1) this._cellsUsed--;
            break;
          }
          prev = e;
          e = this._entNext[e];
        }
      }
    }
  }

  /* ------------------------------------------------------------------- add */

  /**
   * Adds an oriented box (a yaw-rotated OBB).
   * @param {number} cx Centre X.
   * @param {number} cy Centre Y.
   * @param {number} cz Centre Z.
   * @param {number} hx Half extent along the body's local X.
   * @param {number} hy Half height (Y).
   * @param {number} hz Half extent along the body's local Z.
   * @param {number} [yaw=0] Rotation about Y, radians.
   * @param {string} [tag='static'] Gameplay tag; see {@link NON_SOLID_TAGS}.
   * @param {*} [userData=null] Arbitrary payload returned with the body.
   * @returns {number} Body id, used with {@link CollisionWorld#remove}.
   */
  addBox(cx, cy, cz, hx, hy, hz, yaw = 0, tag = 'static', userData = null) {
    const i = this._allocSlot();
    const f = this._f;
    const o = i * BODY_STRIDE;
    const y = fin(yaw, 0);
    f[o + B_CX] = fin(cx, 0);
    f[o + B_CY] = fin(cy, 0);
    f[o + B_CZ] = fin(cz, 0);
    f[o + B_HX] = Math.max(1e-4, Math.abs(fin(hx, 0.5)));
    f[o + B_HY] = Math.max(1e-4, Math.abs(fin(hy, 0.5)));
    f[o + B_HZ] = Math.max(1e-4, Math.abs(fin(hz, 0.5)));
    f[o + B_YAW] = y;
    f[o + B_SIN] = Math.sin(y);
    f[o + B_COS] = Math.cos(y);
    this._kind[i] = KIND_BOX;
    return this._finishAdd(i, tag, userData);
  }

  /**
   * Adds a vertical (Y aligned) cylinder - lamp posts, trees, barrels.
   * @param {number} cx Centre X.
   * @param {number} cy Centre Y (the middle of the cylinder, not its base).
   * @param {number} cz Centre Z.
   * @param {number} radius Radius.
   * @param {number} height Full height.
   * @param {string} [tag='static'] Gameplay tag.
   * @param {*} [userData=null] Arbitrary payload.
   * @returns {number} Body id.
   */
  addCylinder(cx, cy, cz, radius, height, tag = 'static', userData = null) {
    const i = this._allocSlot();
    const f = this._f;
    const o = i * BODY_STRIDE;
    const r = Math.max(1e-4, Math.abs(fin(radius, 0.3)));
    f[o + B_CX] = fin(cx, 0);
    f[o + B_CY] = fin(cy, 0);
    f[o + B_CZ] = fin(cz, 0);
    f[o + B_HX] = r;
    f[o + B_HY] = Math.max(1e-4, Math.abs(fin(height, 1)) * 0.5);
    f[o + B_HZ] = r;
    f[o + B_YAW] = 0;
    f[o + B_SIN] = 0;
    f[o + B_COS] = 1;
    this._kind[i] = KIND_CYLINDER;
    return this._finishAdd(i, tag, userData);
  }

  /**
   * Shared tail of `addBox` / `addCylinder`.
   * @param {number} i Slot index.
   * @param {string} tag Gameplay tag.
   * @param {*} userData Payload.
   * @returns {number} Body id.
   * @private
   */
  _finishAdd(i, tag, userData) {
    this._recomputeAabb(i);
    this._alive[i] = 1;
    const t = typeof tag === 'string' ? tag : 'static';
    this._solid[i] = NON_SOLID_TAGS.indexOf(t) === -1 ? 1 : 0;
    const b = this._syncObject(i);
    b.tag = t;
    b.userData = userData === undefined ? null : userData;
    b.id = i + this._gen[i] * ID_SLOT_SPAN;
    this._insert(i);
    this._bodyCount++;
    this.stats.bodies = this._bodyCount;
    this.stats.cells = this._cellsUsed;
    return b.id;
  }

  /**
   * Resolves a body id to its slot index.
   * @param {number} id Body id.
   * @returns {number} Slot index, or -1 when the id is stale/unknown.
   * @private
   */
  _slotOf(id) {
    if (typeof id !== 'number' || !(id >= 0)) return -1;
    const i = id % ID_SLOT_SPAN;
    if (i >= this._used || !this._alive[i]) return -1;
    const gen = (id - i) / ID_SLOT_SPAN;
    return this._gen[i] === gen ? i : -1;
  }

  /**
   * Looks up the public record for a body id.
   * @param {number} id Body id.
   * @returns {object|null} Body record, or null when the id is stale.
   */
  getBody(id) {
    const i = this._slotOf(id);
    return i === -1 ? null : this._objects[i];
  }

  /**
   * Removes a body. Its slot is recycled and its id becomes stale, so a later `remove` of the
   * same id is a safe no-op.
   * @param {number} id Body id.
   * @returns {boolean} True when a body was actually removed.
   */
  remove(id) {
    const i = this._slotOf(id);
    if (i === -1) return false;
    this._unlink(i);
    this._alive[i] = 0;
    this._gen[i] = (this._gen[i] + 1) | 0;
    if (this._gen[i] < 0) this._gen[i] = 0;
    const b = this._objects[i];
    if (b) { b.userData = null; b.id = -1; }
    this._freeNext[i] = this._freeHead;
    this._freeHead = i;
    this._bodyCount--;
    this.stats.bodies = this._bodyCount;
    this.stats.cells = this._cellsUsed;
    return true;
  }

  /**
   * Moves / re-orients an existing body and re-hashes it. Cheaper and safer than remove + add
   * for entities that move every frame (mission props, doors, moving platforms).
   * @param {number} id Body id.
   * @param {number} cx New centre X.
   * @param {number} cy New centre Y.
   * @param {number} cz New centre Z.
   * @param {number} [yaw] New yaw; the current yaw is kept when omitted.
   * @returns {boolean} True when the body exists.
   */
  updateBody(id, cx, cy, cz, yaw) {
    const i = this._slotOf(id);
    if (i === -1) return false;
    const f = this._f;
    const o = i * BODY_STRIDE;
    f[o + B_CX] = fin(cx, f[o + B_CX]);
    f[o + B_CY] = fin(cy, f[o + B_CY]);
    f[o + B_CZ] = fin(cz, f[o + B_CZ]);
    if (yaw !== undefined && this._kind[i] === KIND_BOX) {
      const y = fin(yaw, f[o + B_YAW]);
      f[o + B_YAW] = y;
      f[o + B_SIN] = Math.sin(y);
      f[o + B_COS] = Math.cos(y);
    }
    this._unlink(i);
    this._recomputeAabb(i);
    this._insert(i);
    this._syncObject(i);
    this.stats.cells = this._cellsUsed;
    return true;
  }

  /**
   * Drops every body. Grid storage is kept so the world can be rebuilt without re-allocating.
   */
  clear() {
    this._cellHead.fill(-1);
    this._cellsUsed = 0;
    this._entFree = -1;
    this._entUsed = 0;
    this._overCount = 0;
    this._freeHead = -1;
    this._freeNext.fill(-1);
    for (let i = 0; i < this._used; i++) {
      this._alive[i] = 0;
      this._huge[i] = 0;
      const b = this._objects[i];
      if (b) { b.userData = null; b.id = -1; }
    }
    this._used = 0;
    this._bodyCount = 0;
    this.stats.bodies = 0;
    this.stats.cells = 0;
  }

  /* --------------------------------------------------------------- terrain */

  /**
   * Installs the world's terrain height function. The mover treats it as a solid floor and
   * `groundHeight` falls back to it when no body covers the column.
   * @param {((x:number,z:number)=>number)|null} fn Sampler, or null to restore the flat y=0 floor.
   */
  setTerrainFn(fn) {
    if (typeof fn === 'function') {
      this._terrainFn = fn;
      this._terrainFlat = false;
    } else {
      this._terrainFn = null;
      this._terrainFlat = true;
    }
  }

  /**
   * Samples the terrain floor.
   * @param {number} x World X.
   * @param {number} z World Z.
   * @returns {number} Terrain height in meters.
   */
  terrainHeight(x, z) {
    if (this._terrainFlat) return this._terrainY;
    return fin(this._terrainFn(x, z), this._terrainY);
  }

  /**
   * Terrain normal from central differences.
   * @param {number} x World X.
   * @param {number} z World Z.
   * @private
   */
  _terrainNormal(x, z) {
    if (this._terrainFlat) { _pnx = 0; _pny = 1; _pnz = 0; return; }
    const e = 0.4;
    const hl = this.terrainHeight(x - e, z);
    const hr = this.terrainHeight(x + e, z);
    const hd = this.terrainHeight(x, z - e);
    const hu = this.terrainHeight(x, z + e);
    let nx = (hl - hr) / (2 * e);
    let nz = (hd - hu) / (2 * e);
    const len = Math.sqrt(nx * nx + 1 + nz * nz);
    _pnx = nx / len;
    _pny = 1 / len;
    _pnz = nz / len;
  }

  /* ------------------------------------------------------------ broadphase */

  /**
   * Bumps the visit stamp, resetting the table before it can wrap.
   * @returns {number} Fresh stamp.
   * @private
   */
  _nextStamp() {
    if (this._stampCounter >= 0x3ffffffe) {
      this._stamp.fill(0);
      this._stampCounter = 0;
    }
    return ++this._stampCounter;
  }

  /**
   * Collects every body whose AABB overlaps the query box into `this._cand`.
   * @param {number} minx Query min X.
   * @param {number} miny Query min Y.
   * @param {number} minz Query min Z.
   * @param {number} maxx Query max X.
   * @param {number} maxy Query max Y.
   * @param {number} maxz Query max Z.
   * @param {boolean} solidOnly Skip non-solid tags.
   * @returns {number} Candidate count.
   * @private
   */
  _gather(minx, miny, minz, maxx, maxy, maxz, solidOnly) {
    this.stats.queriesLastFrame++;
    this.stats.queriesTotal++;
    const stamp = this._nextStamp();
    const st = this._stamp;
    const f = this._f;
    const inv = this.invCell;
    const dim = this.gridDim;
    const mask = this.gridMask;
    let cand = this._cand;
    let n = 0;

    let c0x = Math.floor(minx * inv);
    let c1x = Math.floor(maxx * inv);
    let c0z = Math.floor(minz * inv);
    let c1z = Math.floor(maxz * inv);
    if (c1x - c0x >= dim) { c0x = 0; c1x = dim - 1; }
    if (c1z - c0z >= dim) { c0z = 0; c1z = dim - 1; }

    for (let cx = c0x; cx <= c1x; cx++) {
      const row = (cx & mask) * dim;
      for (let cz = c0z; cz <= c1z; cz++) {
        let e = this._cellHead[row + (cz & mask)];
        while (e !== -1) {
          const b = this._entBody[e];
          e = this._entNext[e];
          if (st[b] === stamp) continue;
          st[b] = stamp;
          if (solidOnly && !this._solid[b]) continue;
          const o = b * BODY_STRIDE;
          if (f[o + B_MAXX] < minx || f[o + B_MINX] > maxx) continue;
          if (f[o + B_MAXZ] < minz || f[o + B_MINZ] > maxz) continue;
          if (f[o + B_MAXY] < miny || f[o + B_MINY] > maxy) continue;
          if (n >= cand.length) {
            if (n >= MAX_CANDIDATES) { this._candCount = n; return n; }
            const grown = new Int32Array(cand.length * 2);
            grown.set(cand);
            this._cand = grown;
            cand = grown;
          }
          cand[n++] = b;
        }
      }
    }

    for (let k = 0; k < this._overCount; k++) {
      const b = this._over[k];
      if (st[b] === stamp) continue;
      st[b] = stamp;
      if (solidOnly && !this._solid[b]) continue;
      const o = b * BODY_STRIDE;
      if (f[o + B_MAXX] < minx || f[o + B_MINX] > maxx) continue;
      if (f[o + B_MAXZ] < minz || f[o + B_MINZ] > maxz) continue;
      if (f[o + B_MAXY] < miny || f[o + B_MINY] > maxy) continue;
      if (n >= cand.length) {
        if (n >= MAX_CANDIDATES) break;
        const grown = new Int32Array(cand.length * 2);
        grown.set(cand);
        this._cand = grown;
        cand = grown;
      }
      cand[n++] = b;
    }

    this._candCount = n;
    return n;
  }

  /* ----------------------------------------------------------- narrowphase */

  /**
   * Closest point of a body's XZ cross section to (x, z). Writes `_cpx`, `_cpz` and `_cpd`
   * (the distance, 0 when the point is inside the cross section).
   * @param {number} i Slot index.
   * @param {number} x World X.
   * @param {number} z World Z.
   * @private
   */
  _closestXZ(i, x, z) {
    const f = this._f;
    const o = i * BODY_STRIDE;
    const cx = f[o + B_CX];
    const cz = f[o + B_CZ];
    if (this._kind[i] === KIND_BOX) {
      const s = f[o + B_SIN];
      const c = f[o + B_COS];
      const dx = x - cx;
      const dz = z - cz;
      const lx = c * dx - s * dz;
      const lz = s * dx + c * dz;
      const hx = f[o + B_HX];
      const hz = f[o + B_HZ];
      const qx = lx < -hx ? -hx : (lx > hx ? hx : lx);
      const qz = lz < -hz ? -hz : (lz > hz ? hz : lz);
      const ox = lx - qx;
      const oz = lz - qz;
      _cpd = Math.sqrt(ox * ox + oz * oz);
      _cpx = cx + c * qx + s * qz;
      _cpz = cz - s * qx + c * qz;
      return;
    }
    const dx = x - cx;
    const dz = z - cz;
    const r = f[o + B_HX];
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d <= r) {
      _cpd = 0;
      _cpx = x;
      _cpz = z;
      return;
    }
    _cpd = d - r;
    _cpx = cx + dx / d * r;
    _cpz = cz + dz / d * r;
  }

  /**
   * 2D circle vs a body's XZ cross section. Writes the push-out normal into `_nx`/`_nz`.
   * @param {number} i Slot index.
   * @param {number} x Circle centre X.
   * @param {number} z Circle centre Z.
   * @param {number} r Circle radius.
   * @returns {number} Penetration depth, 0 when separated.
   * @private
   */
  _circleVsBodyXZ(i, x, z, r) {
    const f = this._f;
    const o = i * BODY_STRIDE;
    if (this._kind[i] === KIND_BOX) {
      const s = f[o + B_SIN];
      const c = f[o + B_COS];
      const dx = x - f[o + B_CX];
      const dz = z - f[o + B_CZ];
      const lx = c * dx - s * dz;
      const lz = s * dx + c * dz;
      const hx = f[o + B_HX];
      const hz = f[o + B_HZ];
      const qx = lx < -hx ? -hx : (lx > hx ? hx : lx);
      const qz = lz < -hz ? -hz : (lz > hz ? hz : lz);
      const ox = lx - qx;
      const oz = lz - qz;
      const d2 = ox * ox + oz * oz;
      if (d2 > 1e-16) {
        const d = Math.sqrt(d2);
        if (d >= r) return 0;
        const nlx = ox / d;
        const nlz = oz / d;
        _nx = c * nlx + s * nlz;
        _nz = -s * nlx + c * nlz;
        return r - d;
      }
      // Centre inside the rectangle: push out through the nearest face.
      const px = hx - (lx < 0 ? -lx : lx);
      const pz = hz - (lz < 0 ? -lz : lz);
      let nlx = 0;
      let nlz = 0;
      let depth;
      if (px <= pz) { nlx = lx >= 0 ? 1 : -1; depth = px + r; }
      else { nlz = lz >= 0 ? 1 : -1; depth = pz + r; }
      _nx = c * nlx + s * nlz;
      _nz = -s * nlx + c * nlz;
      return depth;
    }
    const dx = x - f[o + B_CX];
    const dz = z - f[o + B_CZ];
    const sum = f[o + B_HX] + r;
    const d2 = dx * dx + dz * dz;
    if (d2 >= sum * sum) return 0;
    const d = Math.sqrt(d2);
    if (d > 1e-8) { _nx = dx / d; _nz = dz / d; } else { _nx = 1; _nz = 0; }
    return sum - d;
  }

  /**
   * Widest radius of a vertical capsule over the height range [lo, hi]. Exact, because every
   * body has a constant cross section: the closest approach uses the widest slice.
   * @param {number} lo Range bottom.
   * @param {number} hi Range top.
   * @param {number} feetY Capsule base.
   * @param {number} height Capsule height.
   * @param {number} r Capsule radius.
   * @returns {number} Effective radius (0 when the capsule does not reach the range).
   * @private
   */
  _capsuleRadiusOver(lo, hi, feetY, height, r) {
    const y0 = feetY + r;
    const y1 = feetY + height - r;
    if (hi < y0) {
      const dy = y0 - hi;
      return dy >= r ? 0 : Math.sqrt(r * r - dy * dy);
    }
    if (lo > y1) {
      const dy = lo - y1;
      return dy >= r ? 0 : Math.sqrt(r * r - dy * dy);
    }
    return r;
  }

  /**
   * Horizontal overlap of a vertical capsule with a body, ignoring everything below `bandLo`
   * (the step-up band). Writes the horizontal push-out normal into `_nx`/`_nz`.
   * @param {number} i Slot index.
   * @param {number} x Capsule X.
   * @param {number} z Capsule Z.
   * @param {number} feetY Capsule base.
   * @param {number} height Capsule height.
   * @param {number} r Capsule radius.
   * @param {number} bandLo Lowest height that participates in horizontal blocking.
   * @returns {number} Penetration depth, 0 when separated.
   * @private
   */
  _horizontalOverlap(i, x, z, feetY, height, r, bandLo) {
    const f = this._f;
    const o = i * BODY_STRIDE;
    const b0 = f[o + B_MINY];
    const b1 = f[o + B_MAXY];
    const lo = bandLo > b0 ? bandLo : b0;
    const top = feetY + height;
    const hi = top < b1 ? top : b1;
    if (lo > hi) return 0;
    const er = this._capsuleRadiusOver(lo, hi, feetY, height, r);
    if (er <= 1e-5) return 0;
    return this._circleVsBodyXZ(i, x, z, er);
  }

  /**
   * True capsule vs body overlap using the closest point on the capsule segment. Writes the 3D
   * contact normal into `_nx`/`_ny`/`_nz`.
   * @param {number} i Slot index.
   * @param {number} x Capsule X.
   * @param {number} feetY Capsule base.
   * @param {number} z Capsule Z.
   * @param {number} r Capsule radius.
   * @param {number} height Capsule height.
   * @returns {number} Penetration depth, 0 when separated.
   * @private
   */
  _capsuleVsBody(i, x, feetY, z, r, height) {
    const f = this._f;
    const o = i * BODY_STRIDE;
    const cy = f[o + B_CY];
    const hy = f[o + B_HY];
    const y0 = feetY + r;
    const y1 = feetY + height - r;
    const b0 = cy - hy;
    const b1 = cy + hy;
    // Closest point on the (vertical) capsule segment to the body's height range.
    let sy;
    if (y1 <= b0) sy = y1;
    else if (y0 >= b1) sy = y0;
    else {
      const lo = y0 > b0 ? y0 : b0;
      const hi = y1 < b1 ? y1 : b1;
      sy = (lo + hi) * 0.5;
    }
    const ly = sy - cy;
    if (this._kind[i] === KIND_BOX) {
      const s = f[o + B_SIN];
      const c = f[o + B_COS];
      const dx = x - f[o + B_CX];
      const dz = z - f[o + B_CZ];
      const lx = c * dx - s * dz;
      const lz = s * dx + c * dz;
      const hx = f[o + B_HX];
      const hz = f[o + B_HZ];
      const qx = lx < -hx ? -hx : (lx > hx ? hx : lx);
      const qy = ly < -hy ? -hy : (ly > hy ? hy : ly);
      const qz = lz < -hz ? -hz : (lz > hz ? hz : lz);
      const ex = lx - qx;
      const ey = ly - qy;
      const ez = lz - qz;
      const d2 = ex * ex + ey * ey + ez * ez;
      if (d2 > 1e-16) {
        const d = Math.sqrt(d2);
        if (d >= r) return 0;
        const ilx = ex / d;
        const ily = ey / d;
        const ilz = ez / d;
        _nx = c * ilx + s * ilz;
        _ny = ily;
        _nz = -s * ilx + c * ilz;
        return r - d;
      }
      const px = hx - (lx < 0 ? -lx : lx);
      const py = hy - (ly < 0 ? -ly : ly);
      const pz = hz - (lz < 0 ? -lz : lz);
      let ilx = 0;
      let ily = 0;
      let ilz = 0;
      let depth;
      if (px <= py && px <= pz) { ilx = lx >= 0 ? 1 : -1; depth = px + r; }
      else if (py <= pz) { ily = ly >= 0 ? 1 : -1; depth = py + r; }
      else { ilz = lz >= 0 ? 1 : -1; depth = pz + r; }
      _nx = c * ilx + s * ilz;
      _ny = ily;
      _nz = -s * ilx + c * ilz;
      return depth;
    }
    // Cylinder.
    const dx = x - f[o + B_CX];
    const dz = z - f[o + B_CZ];
    const rad = f[o + B_HX];
    const dd = Math.sqrt(dx * dx + dz * dz);
    const qr = dd < rad ? dd : rad;
    const qy = ly < -hy ? -hy : (ly > hy ? hy : ly);
    const er = dd - qr;
    const ey = ly - qy;
    const d2 = er * er + ey * ey;
    if (d2 > 1e-16) {
      const d = Math.sqrt(d2);
      if (d >= r) return 0;
      if (dd > 1e-8) {
        _nx = dx / dd * (er / d);
        _nz = dz / dd * (er / d);
      } else { _nx = 0; _nz = 0; }
      _ny = ey / d;
      return r - d;
    }
    const pr = rad - dd;
    const py = hy - (ly < 0 ? -ly : ly);
    if (pr <= py) {
      if (dd > 1e-8) { _nx = dx / dd; _nz = dz / dd; } else { _nx = 1; _nz = 0; }
      _ny = 0;
      return pr + r;
    }
    _nx = 0;
    _nz = 0;
    _ny = ly >= 0 ? 1 : -1;
    return py + r;
  }

  /**
   * Distance a capsule may descend before it lands on body `i`.
   * @param {number} i Slot index.
   * @param {number} x Capsule X.
   * @param {number} z Capsule Z.
   * @param {number} feetY Capsule base.
   * @param {number} r Capsule radius.
   * @returns {number} Allowed descent, `Infinity` when the body cannot be landed on.
   * @private
   */
  _descentLimit(i, x, z, feetY, r) {
    this._closestXZ(i, x, z);
    const dh = _cpd;
    if (dh >= r) return Infinity;
    const f = this._f;
    const o = i * BODY_STRIDE;
    const y0 = feetY + r;
    // Descending only closes a gap when the capsule sits above the body's top. Beside it (a wall)
    // the distance does not change with height, so the body must not block the fall - otherwise
    // the mover sticks to walls instead of sliding down them.
    if (y0 <= f[o + B_TOP]) return Infinity;
    const g = Math.sqrt(r * r - dh * dh);
    const d = y0 - (f[o + B_TOP] + g);
    return d > 0 ? d : 0;
  }

  /**
   * Distance a capsule may rise before its head hits body `i`.
   * @param {number} i Slot index.
   * @param {number} x Capsule X.
   * @param {number} z Capsule Z.
   * @param {number} feetY Capsule base.
   * @param {number} height Capsule height.
   * @param {number} r Capsule radius.
   * @returns {number} Allowed ascent, `Infinity` when the body is not above the capsule.
   * @private
   */
  _ascentLimit(i, x, z, feetY, height, r) {
    this._closestXZ(i, x, z);
    const dh = _cpd;
    if (dh >= r) return Infinity;
    const f = this._f;
    const o = i * BODY_STRIDE;
    const y1 = feetY + height - r;
    // Mirror of `_descentLimit`: rising only closes a gap while the head is below the body.
    if (y1 >= f[o + B_MINY]) return Infinity;
    const g = Math.sqrt(r * r - dh * dh);
    const d = (f[o + B_MINY] - g) - y1;
    return d > 0 ? d : 0;
  }

  /**
   * Penetration recovery push for a capsule that has ended up inside a body.
   *
   * Identical to {@link CollisionWorld#_capsuleVsBody} except that a mover straddling the body's
   * height range is never shoved downwards (that would drive it through the floor and wedge it
   * permanently); it takes the cheaper of sliding out sideways or standing on top instead. A body
   * that is purely overhead - a ceiling - still pushes down, which is correct.
   *
   * @param {number} i Slot index.
   * @param {number} x Capsule X.
   * @param {number} feetY Capsule base.
   * @param {number} z Capsule Z.
   * @param {number} r Capsule radius.
   * @param {number} height Capsule height.
   * @returns {number} Penetration depth, 0 when separated.
   * @private
   */
  _escapePush(i, x, feetY, z, r, height) {
    const depth = this._capsuleVsBody(i, x, feetY, z, r, height);
    if (depth <= 0 || _ny > -0.2) return depth;
    const f = this._f;
    const o = i * BODY_STRIDE;
    const y0 = feetY + r;
    if (f[o + B_MINY] >= y0) return depth;      // purely overhead: pushing down is right
    const horiz = this._circleVsBodyXZ(i, x, z, r);
    const hnx = _nx;
    const hnz = _nz;
    this._closestXZ(i, x, z);
    const dh = _cpd;
    const g = dh >= r ? 0 : Math.sqrt(r * r - dh * dh);
    const up = (f[o + B_TOP] + g) - y0;
    if (horiz > 0 && (up <= 0 || horiz <= up)) {
      _nx = hnx; _ny = 0; _nz = hnz;
      return horiz;
    }
    if (up > 0) {
      _nx = 0; _ny = 1; _nz = 0;
      return up;
    }
    return depth;
  }

  /**
   * Deepest true capsule penetration over the current candidate list.
   * @param {number} x Capsule X.
   * @param {number} feetY Capsule base.
   * @param {number} z Capsule Z.
   * @param {number} r Capsule radius.
   * @param {number} height Capsule height.
   * @returns {number} Deepest penetration depth (0 when free).
   * @private
   */
  _deepestCapsule(x, feetY, z, r, height) {
    const cand = this._cand;
    const n = this._candCount;
    let deepest = 0;
    for (let k = 0; k < n; k++) {
      const d = this._capsuleVsBody(cand[k], x, feetY, z, r, height);
      if (d > deepest) deepest = d;
    }
    return deepest;
  }

  /**
   * Probes downwards from the capsule's current position. Sets `_probeHit`, `_probeDist` and
   * the contact normal `_pnx`/`_pny`/`_pnz`.
   * @param {number} x Capsule X.
   * @param {number} feetY Capsule base.
   * @param {number} z Capsule Z.
   * @param {number} r Capsule radius.
   * @param {number} maxDist Longest descent considered.
   * @private
   */
  _probeDown(x, feetY, z, r, maxDist) {
    const cand = this._cand;
    const n = this._candCount;
    let best = maxDist;
    let bestBody = -1;
    _probeHit = false;
    for (let k = 0; k < n; k++) {
      const i = cand[k];
      const lim = this._descentLimit(i, x, z, feetY, r);
      if (lim < best) { best = lim; bestBody = i; }
    }
    const ty = this.terrainHeight(x, z);
    const tLim = feetY - ty;
    if (tLim < best) {
      _probeDist = tLim > 0 ? tLim : 0;
      _probeHit = true;
      this._terrainNormal(x, z);
      return;
    }
    if (bestBody === -1) {
      _probeDist = maxDist;
      _pnx = 0; _pny = 1; _pnz = 0;
      return;
    }
    _probeHit = true;
    _probeDist = best > 0 ? best : 0;
    // Normal of the rounded contact between the capsule cap and the body's top edge.
    this._closestXZ(bestBody, x, z);
    const dh = _cpd;
    if (dh <= 1e-6) {
      _pnx = 0; _pny = 1; _pnz = 0;
    } else {
      const g = Math.sqrt(Math.max(0, r * r - dh * dh));
      _pnx = (x - _cpx) / r;
      _pny = g / r;
      _pnz = (z - _cpz) / r;
    }
  }

  /* ------------------------------------------------------------- queries */

  /**
   * Fills `out` with every body whose AABB overlaps the given box.
   * @param {number} minx Box min X.
   * @param {number} miny Box min Y.
   * @param {number} minz Box min Z.
   * @param {number} maxx Box max X.
   * @param {number} maxy Box max Y.
   * @param {number} maxz Box max Z.
   * @param {Array<object>} [out=[]] Caller supplied array; cleared and refilled.
   * @returns {Array<object>} `out`
   */
  queryAABB(minx, miny, minz, maxx, maxy, maxz, out = []) {
    const n = this._gather(minx, miny, minz, maxx, maxy, maxz, false);
    const cand = this._cand;
    out.length = 0;
    for (let k = 0; k < n; k++) out.push(this._objects[cand[k]]);
    return out;
  }

  /**
   * Fills `out` with every body actually overlapping the sphere (exact OBB / cylinder test).
   * @param {number} x Sphere centre X.
   * @param {number} y Sphere centre Y.
   * @param {number} z Sphere centre Z.
   * @param {number} r Sphere radius.
   * @param {Array<object>} [out=[]] Caller supplied array; cleared and refilled.
   * @returns {Array<object>} `out`
   */
  querySphere(x, y, z, r, out = []) {
    const n = this._gather(x - r, y - r, z - r, x + r, y + r, z + r, false);
    const cand = this._cand;
    out.length = 0;
    // A sphere is a capsule of height 2r whose base sits at y - r.
    for (let k = 0; k < n; k++) {
      if (this._capsuleVsBody(cand[k], x, y - r, z, r, r * 2) > 0) out.push(this._objects[cand[k]]);
    }
    return out;
  }

  /**
   * Highest solid top surface at a column - roads, sidewalks, building floors - falling back to
   * the terrain function. Touches only the bodies in the column's cell (plus oversize bodies).
   * @param {number} x World X.
   * @param {number} z World Z.
   * @param {number} [maxY=Infinity] Ignore surfaces above this height.
   * @returns {number} Surface height in meters.
   */
  groundHeight(x, z, maxY = Infinity) {
    this.stats.queriesLastFrame++;
    this.stats.queriesTotal++;
    const f = this._f;
    const dim = this.gridDim;
    const mask = this.gridMask;
    const cx = Math.floor(x * this.invCell) & mask;
    const cz = Math.floor(z * this.invCell) & mask;
    let best = -Infinity;
    let e = this._cellHead[cx * dim + cz];
    while (e !== -1) {
      const b = this._entBody[e];
      e = this._entNext[e];
      if (!this._solid[b]) continue;
      const o = b * BODY_STRIDE;
      const top = f[o + B_TOP];
      if (top <= best || top > maxY) continue;
      if (x < f[o + B_MINX] || x > f[o + B_MAXX] || z < f[o + B_MINZ] || z > f[o + B_MAXZ]) continue;
      this._closestXZ(b, x, z);
      if (_cpd > 0) continue;
      best = top;
    }
    for (let k = 0; k < this._overCount; k++) {
      const b = this._over[k];
      if (!this._solid[b]) continue;
      const o = b * BODY_STRIDE;
      const top = f[o + B_TOP];
      if (top <= best || top > maxY) continue;
      if (x < f[o + B_MINX] || x > f[o + B_MAXX] || z < f[o + B_MINZ] || z > f[o + B_MAXZ]) continue;
      this._closestXZ(b, x, z);
      if (_cpd > 0) continue;
      best = top;
    }
    const ty = this.terrainHeight(x, z);
    if (ty > best && ty <= maxY) best = ty;
    return best;
  }

  /* ---------------------------------------------------------- moveCapsule */

  /**
   * Resolves a vertical capsule against the world: the character mover.
   *
   * Horizontal and vertical motion are solved separately, long deltas are sub-stepped so nothing
   * can tunnel, penetrations are resolved deepest-first (which slides along contact planes), and
   * a grounded mover automatically climbs obstacles up to {@link STEP_HEIGHT}.
   *
   * @param {ArrayLike<number>} pos Current capsule base (feet) position. Never modified.
   * @param {number} radius Capsule radius.
   * @param {number} height Capsule height from feet to head.
   * @param {ArrayLike<number>} delta Desired motion this frame.
   * @param {object} [out] Result object to fill; a shared one is used when omitted.
   * @returns {{x:number,y:number,z:number,grounded:boolean,groundY:number,normal:ArrayLike<number>,hits:number,stepped:boolean,hitWall:boolean,hitCeiling:boolean}}
   *   The resolved feet position plus contact information.
   */
  moveCapsule(pos, radius, height, delta, out) {
    const res = out || _moveResult;
    let normal = res.normal;
    if (!normal || normal.length < 3) { normal = new Float32Array(3); res.normal = normal; }

    let px = fin(pos[0], 0);
    let py = fin(pos[1], 0);
    let pz = fin(pos[2], 0);
    const r = Math.max(0.05, fin(radius, 0.35));
    let h = fin(height, r * 2);
    if (h < r * 2 + 1e-4) h = r * 2 + 1e-4;

    let dx = fin(delta[0], 0);
    let dy = fin(delta[1], 0);
    let dz = fin(delta[2], 0);
    // Keep every sub-step at half the radius: scale an over-long delta down instead of stretching
    // the sub-steps, so a single call can never tunnel through thin geometry.
    const maxTravel = MAX_SUBSTEPS * r * 0.5;
    const hlen0 = Math.sqrt(dx * dx + dz * dz);
    const vlen0 = dy < 0 ? -dy : dy;
    const longest0 = hlen0 > vlen0 ? hlen0 : vlen0;
    if (longest0 > maxTravel) {
      const k = maxTravel / longest0;
      dx *= k;
      dy *= k;
      dz *= k;
    }

    // ---- broadphase over the whole swept volume, once ------------------------------------
    const minx = (dx < 0 ? px + dx : px) - r - BROAD_MARGIN;
    const maxx = (dx < 0 ? px : px + dx) + r + BROAD_MARGIN;
    const minz = (dz < 0 ? pz + dz : pz) - r - BROAD_MARGIN;
    const maxz = (dz < 0 ? pz : pz + dz) + r + BROAD_MARGIN;
    const miny = (dy < 0 ? py + dy : py) - BROAD_MARGIN - SNAP_DOWN;
    const maxy = (dy < 0 ? py : py + dy) + h + BROAD_MARGIN;
    const nc = this._gather(minx, miny, minz, maxx, maxy, maxz, true);
    const cand = this._cand;

    let hits = 0;
    let stepped = false;
    let hitWall = false;
    let hitCeiling = false;

    // ---- escape any penetration we started inside ----------------------------------------
    const ty0 = this.terrainHeight(px, pz);
    if (py < ty0) py = ty0;
    for (let pass = 0; pass < DEPEN_PASSES; pass++) {
      let deep = 0;
      let bx = 0;
      let by = 0;
      let bz = 0;
      for (let k = 0; k < nc; k++) {
        const d = this._escapePush(cand[k], px, py, pz, r, h);
        if (d > deep) { deep = d; bx = _nx; by = _ny; bz = _nz; }
      }
      if (deep <= 1e-4) break;
      px += bx * (deep + 1e-4);
      py += by * (deep + 1e-4);
      pz += bz * (deep + 1e-4);
      hits++;
    }

    // ---- initial ground state --------------------------------------------------------------
    this._probeDown(px, py, pz, r, SKIN);
    let grounded = _probeHit && _probeDist <= SKIN && _pny >= SLOPE_LIMIT_COS;
    let groundY = grounded ? py - _probeDist : py;
    let gnx = 0;
    let gny = 1;
    let gnz = 0;
    if (grounded) { gnx = _pnx; gny = _pny; gnz = _pnz; }

    // ---- sub-stepping ------------------------------------------------------------------------
    const hlen = Math.sqrt(dx * dx + dz * dz);
    const vlen = dy < 0 ? -dy : dy;
    const longest = hlen > vlen ? hlen : vlen;
    let steps = Math.ceil(longest / (r * 0.5));
    if (!(steps >= 1)) steps = 1;
    if (steps > MAX_SUBSTEPS) steps = MAX_SUBSTEPS;
    const sx = dx / steps;
    const sy = dy / steps;
    const sz = dz / steps;

    let slideX = 0;
    let slideZ = 0;

    for (let s = 0; s <= steps; s++) {
      const last = s === steps;
      if (last && slideX === 0 && slideZ === 0) break;
      const mx = (last ? 0 : sx) + slideX;
      const mz = (last ? 0 : sz) + slideZ;
      slideX = 0;
      slideZ = 0;

      // ------------------------------------------------------------------ horizontal
      const saveX = px;
      const saveZ = pz;
      const saveY = py;
      const startDepth = this._deepestCapsule(px, py, pz, r, h);
      if (mx !== 0 || mz !== 0) {
        px += mx;
        pz += mz;
        const bandLo = grounded ? py + STEP_HEIGHT : py;
        for (let pass = 0; pass < DEPEN_PASSES; pass++) {
          let deep = 0;
          let bnx = 0;
          let bnz = 0;
          for (let k = 0; k < nc; k++) {
            const d = this._horizontalOverlap(cand[k], px, pz, py, h, r, bandLo);
            if (d > deep) { deep = d; bnx = _nx; bnz = _nz; }
          }
          if (deep <= 1e-5) break;
          px += bnx * (deep + 1e-4);
          pz += bnz * (deep + 1e-4);
          hitWall = true;
          hits++;
        }

        // -------------------------------------------------------------- step up
        let didStep = false;
        if (grounded) {
          const ceiling = py + STEP_HEIGHT;
          let top = -Infinity;
          for (let k = 0; k < nc; k++) {
            const i = cand[k];
            const t = this._f[i * BODY_STRIDE + B_TOP];
            if (t <= py + 1e-4 || t > ceiling || t <= top) continue;
            this._closestXZ(i, px, pz);
            if (_cpd < r) top = t;
          }
          const tz = this.terrainHeight(px, pz);
          if (tz > py + 1e-4 && tz <= ceiling && tz > top) top = tz;
          if (top > -Infinity) {
            py = top;
            didStep = true;
          }
        }

        // -------------------------------------------------- terrain wall + safety net
        // Reverting the whole sub-step is what guarantees "never inside a body": the start of the
        // sub-step is known good, so a move that cannot be made safe simply does not happen.
        const tNow = this.terrainHeight(px, pz);
        let bad = tNow > py + 1e-3;
        if (!bad) {
          const depth = this._deepestCapsule(px, py, pz, r, h);
          bad = depth > 2e-3 && depth > startDepth + 1e-4;
        }
        if (bad) {
          px = saveX;
          pz = saveZ;
          py = saveY;
          didStep = false;
          hitWall = true;
          hits++;
        }
        if (didStep) stepped = true;
      }

      if (last) break;

      // -------------------------------------------------------------------- vertical
      const vy = sy;
      if (vy > 0) {
        let allowed = vy;
        for (let k = 0; k < nc; k++) {
          const lim = this._ascentLimit(cand[k], px, pz, py, h, r);
          if (lim < allowed) allowed = lim;
        }
        if (allowed < 0) allowed = 0;
        py += allowed;
        if (allowed < vy - 1e-9) { hitCeiling = true; hits++; }
        grounded = false;
      } else {
        const want = -vy;
        // A grounded mover probes further so it stays glued to small drops (stairs, kerbs).
        const total = want + (grounded ? SNAP_DOWN : SKIN);
        this._probeDown(px, py, pz, r, total);
        if (_probeHit && _probeDist < total) {
          py -= _probeDist;
          if (_pny >= SLOPE_LIMIT_COS) {
            grounded = true;
            groundY = py;
            gnx = _pnx; gny = _pny; gnz = _pnz;
          } else {
            // Too steep to stand on: keep the contact but slide down the plane.
            grounded = false;
            gnx = _pnx; gny = _pny; gnz = _pnz;
            const rem = want - _probeDist;
            if (rem > 0) {
              slideX += _pnx * _pny * rem;
              slideZ += _pnz * _pny * rem;
              hits++;
            }
          }
        } else {
          py -= want;
          grounded = false;
        }
      }
    }

    // ---- final safety net: never leave the capsule inside a body ----------------------------
    for (let pass = 0; pass < DEPEN_PASSES; pass++) {
      let deep = 0;
      let bx = 0;
      let by = 0;
      let bz = 0;
      for (let k = 0; k < nc; k++) {
        const d = this._escapePush(cand[k], px, py, pz, r, h);
        if (d > deep) { deep = d; bx = _nx; by = _ny; bz = _nz; }
      }
      if (deep <= 1e-4) break;
      px += bx * (deep + 1e-4);
      py += by * (deep + 1e-4);
      pz += bz * (deep + 1e-4);
      hits++;
    }
    const tEnd = this.terrainHeight(px, pz);
    if (py < tEnd) py = tEnd;

    if (!(px === px)) px = fin(pos[0], 0);
    if (!(py === py)) py = fin(pos[1], 0);
    if (!(pz === pz)) pz = fin(pos[2], 0);

    if (!grounded) {
      // Report the surface below even while airborne; the candidate list is already gathered.
      let below = this.terrainHeight(px, pz);
      const f = this._f;
      for (let k = 0; k < nc; k++) {
        const i = cand[k];
        const o = i * BODY_STRIDE;
        const top = f[o + B_TOP];
        if (top > py + 1e-3 || top <= below) continue;
        this._closestXZ(i, px, pz);
        if (_cpd <= 0) below = top;
      }
      groundY = below;
    }

    res.x = px;
    res.y = py;
    res.z = pz;
    res.grounded = grounded;
    res.groundY = groundY;
    normal[0] = gnx;
    normal[1] = gny;
    normal[2] = gnz;
    res.hits = hits;
    res.stepped = stepped;
    res.hitWall = hitWall;
    res.hitCeiling = hitCeiling;
    return res;
  }

  /* ---------------------------------------------------------- sweepSphere */

  /**
   * Sweeps a sphere from `from` to `to` and returns the earliest impact.
   *
   * The result is taken from a small pool: it stays valid for the next {@link SWEEP_POOL_SIZE}
   * sweeps, so copy anything that must live longer.
   *
   * @param {ArrayLike<number>} from Start centre.
   * @param {ArrayLike<number>} to End centre.
   * @param {number} radius Sphere radius.
   * @returns {{t:number,distance:number,hit:Float32Array,point:Float32Array,normal:Float32Array,body:object}|null}
   *   `t` is the fraction of the segment (0..1), `distance` the same impact in meters.
   */
  sweepSphere(from, to, radius) {
    const ox = fin(from[0], 0);
    const oy = fin(from[1], 0);
    const oz = fin(from[2], 0);
    const tx = fin(to[0], ox);
    const ty = fin(to[1], oy);
    const tz = fin(to[2], oz);
    const r = Math.max(1e-4, fin(radius, 0.25));
    const dx = tx - ox;
    const dy = ty - oy;
    const dz = tz - oz;

    const minx = (dx < 0 ? tx : ox) - r;
    const maxx = (dx < 0 ? ox : tx) + r;
    const miny = (dy < 0 ? ty : oy) - r;
    const maxy = (dy < 0 ? oy : ty) + r;
    const minz = (dz < 0 ? tz : oz) - r;
    const maxz = (dz < 0 ? oz : tz) + r;
    const n = this._gather(minx, miny, minz, maxx, maxy, maxz, true);
    const cand = this._cand;

    let bestT = Infinity;
    let bestBody = -1;
    let bnx = 0;
    let bny = 1;
    let bnz = 0;
    for (let k = 0; k < n; k++) {
      const i = cand[k];
      const t = this._kind[i] === KIND_BOX
        ? this._sweepBox(i, ox, oy, oz, dx, dy, dz, r)
        : this._sweepCylinder(i, ox, oy, oz, dx, dy, dz, r);
      if (t >= 0 && t < bestT) {
        bestT = t;
        bestBody = i;
        bnx = _nx; bny = _ny; bnz = _nz;
      }
    }
    if (bestBody === -1) return null;

    const res = this._sweepPool[this._sweepPoolAt];
    this._sweepPoolAt = (this._sweepPoolAt + 1) % SWEEP_POOL_SIZE;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    res.t = bestT;
    res.distance = bestT * len;
    res.hit[0] = ox + dx * bestT;
    res.hit[1] = oy + dy * bestT;
    res.hit[2] = oz + dz * bestT;
    res.normal[0] = bnx;
    res.normal[1] = bny;
    res.normal[2] = bnz;
    res.body = this._objects[bestBody];
    return res;
  }

  /**
   * Swept sphere vs oriented box. Exact: the slab test against the box grown by `r` is refined
   * with the edge cylinder / corner sphere when the contact lands outside a face.
   * @returns {number} Impact fraction in [0,1], or -1 for a miss.
   * @private
   */
  _sweepBox(i, ox, oy, oz, dx, dy, dz, r) {
    const f = this._f;
    const o = i * BODY_STRIDE;
    const s = f[o + B_SIN];
    const c = f[o + B_COS];
    const rx = ox - f[o + B_CX];
    const ry = oy - f[o + B_CY];
    const rz = oz - f[o + B_CZ];
    const lx = c * rx - s * rz;
    const ly = ry;
    const lz = s * rx + c * rz;
    const ldx = c * dx - s * dz;
    const ldy = dy;
    const ldz = s * dx + c * dz;
    const hx = f[o + B_HX];
    const hy = f[o + B_HY];
    const hz = f[o + B_HZ];
    const ex = hx + r;
    const ey = hy + r;
    const ez = hz + r;

    let tmin = 0;
    let tmax = 1;
    let axis = -1;

    // X slab
    if (ldx > -1e-12 && ldx < 1e-12) {
      if (lx < -ex || lx > ex) return -1;
    } else {
      const inv = 1 / ldx;
      let t1 = (-ex - lx) * inv;
      let t2 = (ex - lx) * inv;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
      if (t1 > tmin) { tmin = t1; axis = 0; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
    // Y slab
    if (ldy > -1e-12 && ldy < 1e-12) {
      if (ly < -ey || ly > ey) return -1;
    } else {
      const inv = 1 / ldy;
      let t1 = (-ey - ly) * inv;
      let t2 = (ey - ly) * inv;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
      if (t1 > tmin) { tmin = t1; axis = 1; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
    // Z slab
    if (ldz > -1e-12 && ldz < 1e-12) {
      if (lz < -ez || lz > ez) return -1;
    } else {
      const inv = 1 / ldz;
      let t1 = (-ez - lz) * inv;
      let t2 = (ez - lz) * inv;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
      if (t1 > tmin) { tmin = t1; axis = 2; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
    if (tmax < 0 || tmin > 1) return -1;

    if (axis === -1) {
      // Started already touching: report an immediate hit with the depenetration normal.
      this._sweepInitialNormal(i, lx, ly, lz, hx, hy, hz, c, s);
      return 0;
    }

    let t = tmin;
    let hx0 = lx + ldx * t;
    let hy0 = ly + ldy * t;
    let hz0 = lz + ldz * t;
    const outX = hx0 < -hx || hx0 > hx;
    const outY = hy0 < -hy || hy0 > hy;
    const outZ = hz0 < -hz || hz0 > hz;
    let outside = (outX ? 1 : 0) + (outY ? 1 : 0) + (outZ ? 1 : 0);

    if (outside <= 1) {
      // Face contact - the slab result is exact.
      let nlx = 0;
      let nly = 0;
      let nlz = 0;
      if (axis === 0) nlx = ldx > 0 ? -1 : 1;
      else if (axis === 1) nly = ldy > 0 ? -1 : 1;
      else nlz = ldz > 0 ? -1 : 1;
      _nx = c * nlx + s * nlz;
      _ny = nly;
      _nz = -s * nlx + c * nlz;
      return t;
    }

    // Edge or corner: solve against the rounded feature.
    const qx = hx0 < -hx ? -hx : (hx0 > hx ? hx : hx0);
    const qy = hy0 < -hy ? -hy : (hy0 > hy ? hy : hy0);
    const qz = hz0 < -hz ? -hz : (hz0 > hz ? hz : hz0);
    let a = 0;
    let b = 0;
    let cc = 0;
    if (outside === 3) {
      const px = lx - qx;
      const py = ly - qy;
      const pz = lz - qz;
      a = ldx * ldx + ldy * ldy + ldz * ldz;
      b = 2 * (px * ldx + py * ldy + pz * ldz);
      cc = px * px + py * py + pz * pz - r * r;
    } else if (!outX) {
      const py = ly - qy;
      const pz = lz - qz;
      a = ldy * ldy + ldz * ldz;
      b = 2 * (py * ldy + pz * ldz);
      cc = py * py + pz * pz - r * r;
    } else if (!outY) {
      const px = lx - qx;
      const pz = lz - qz;
      a = ldx * ldx + ldz * ldz;
      b = 2 * (px * ldx + pz * ldz);
      cc = px * px + pz * pz - r * r;
    } else {
      const px = lx - qx;
      const py = ly - qy;
      a = ldx * ldx + ldy * ldy;
      b = 2 * (px * ldx + py * ldy);
      cc = px * px + py * py - r * r;
    }
    let solved = -1;
    if (a > 1e-12) {
      const disc = b * b - 4 * a * cc;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        const r1 = (-b - sq) / (2 * a);
        const r2 = (-b + sq) / (2 * a);
        if (r1 >= -1e-6 && r1 <= 1) solved = r1 < 0 ? 0 : r1;
        else if (r2 >= -1e-6 && r2 <= 1) solved = r2 < 0 ? 0 : r2;
      }
    }
    if (solved >= 0) t = solved;   // otherwise keep the conservative slab time

    hx0 = lx + ldx * t;
    hy0 = ly + ldy * t;
    hz0 = lz + ldz * t;
    const cx2 = hx0 < -hx ? -hx : (hx0 > hx ? hx : hx0);
    const cy2 = hy0 < -hy ? -hy : (hy0 > hy ? hy : hy0);
    const cz2 = hz0 < -hz ? -hz : (hz0 > hz ? hz : hz0);
    let nlx = hx0 - cx2;
    let nly = hy0 - cy2;
    let nlz = hz0 - cz2;
    const nl = Math.sqrt(nlx * nlx + nly * nly + nlz * nlz);
    if (nl > 1e-9) { nlx /= nl; nly /= nl; nlz /= nl; } else { nlx = 0; nly = 1; nlz = 0; }
    _nx = c * nlx + s * nlz;
    _ny = nly;
    _nz = -s * nlx + c * nlz;
    return t;
  }

  /**
   * Normal for a sweep that already starts in contact.
   * @private
   */
  _sweepInitialNormal(i, lx, ly, lz, hx, hy, hz, c, s) {
    const qx = lx < -hx ? -hx : (lx > hx ? hx : lx);
    const qy = ly < -hy ? -hy : (ly > hy ? hy : ly);
    const qz = lz < -hz ? -hz : (lz > hz ? hz : lz);
    let nlx = lx - qx;
    let nly = ly - qy;
    let nlz = lz - qz;
    const d = Math.sqrt(nlx * nlx + nly * nly + nlz * nlz);
    if (d > 1e-9) {
      nlx /= d; nly /= d; nlz /= d;
    } else {
      const px = hx - (lx < 0 ? -lx : lx);
      const py = hy - (ly < 0 ? -ly : ly);
      const pz = hz - (lz < 0 ? -lz : lz);
      nlx = 0; nly = 0; nlz = 0;
      if (px <= py && px <= pz) nlx = lx >= 0 ? 1 : -1;
      else if (py <= pz) nly = ly >= 0 ? 1 : -1;
      else nlz = lz >= 0 ? 1 : -1;
    }
    _nx = c * nlx + s * nlz;
    _ny = nly;
    _nz = -s * nlx + c * nlz;
  }

  /**
   * Swept sphere vs vertical cylinder, treated as the cylinder grown by `r` (the rim rounding is
   * approximated, which errs on the side of blocking slightly early).
   * @returns {number} Impact fraction in [0,1], or -1 for a miss.
   * @private
   */
  _sweepCylinder(i, ox, oy, oz, dx, dy, dz, r) {
    const f = this._f;
    const o = i * BODY_STRIDE;
    const lx = ox - f[o + B_CX];
    const ly = oy - f[o + B_CY];
    const lz = oz - f[o + B_CZ];
    const rad = f[o + B_HX] + r;
    const hy = f[o + B_HY] + r;

    let tSide0 = 0;
    let tSide1 = 1;
    const a = dx * dx + dz * dz;
    const b = 2 * (lx * dx + lz * dz);
    const cc = lx * lx + lz * lz - rad * rad;
    if (a > 1e-12) {
      const disc = b * b - 4 * a * cc;
      if (disc < 0) return -1;
      const sq = Math.sqrt(disc);
      tSide0 = (-b - sq) / (2 * a);
      tSide1 = (-b + sq) / (2 * a);
    } else if (cc > 0) {
      return -1;
    } else {
      tSide0 = -Infinity;
      tSide1 = Infinity;
    }

    let tY0;
    let tY1;
    if (dy > -1e-12 && dy < 1e-12) {
      if (ly < -hy || ly > hy) return -1;
      tY0 = -Infinity;
      tY1 = Infinity;
    } else {
      const inv = 1 / dy;
      tY0 = (-hy - ly) * inv;
      tY1 = (hy - ly) * inv;
      if (tY0 > tY1) { const tt = tY0; tY0 = tY1; tY1 = tt; }
    }

    let tmin = tSide0 > tY0 ? tSide0 : tY0;
    const tmax = tSide1 < tY1 ? tSide1 : tY1;
    if (tmin > tmax || tmax < 0 || tmin > 1) return -1;
    const side = tSide0 >= tY0;
    if (tmin < 0) {
      tmin = 0;
      // Already overlapping: push out radially, or vertically when we are over a cap.
      const dd = Math.sqrt(lx * lx + lz * lz);
      if (dd > f[o + B_HX] * 0.5 && dd > 1e-8) { _nx = lx / dd; _ny = 0; _nz = lz / dd; }
      else { _nx = 0; _ny = ly >= 0 ? 1 : -1; _nz = 0; }
      return 0;
    }
    if (side) {
      const hx0 = lx + dx * tmin;
      const hz0 = lz + dz * tmin;
      const dd = Math.sqrt(hx0 * hx0 + hz0 * hz0);
      if (dd > 1e-8) { _nx = hx0 / dd; _ny = 0; _nz = hz0 / dd; } else { _nx = 1; _ny = 0; _nz = 0; }
    } else {
      _nx = 0;
      _ny = dy > 0 ? -1 : 1;
      _nz = 0;
    }
    return tmin;
  }

  /* --------------------------------------------------------------- raycast */

  /**
   * Casts a ray through the world, walking the spatial hash with a 2D DDA so only the cells the
   * ray actually crosses are visited.
   *
   * The result comes from a pool and stays valid for the next {@link RAY_POOL_SIZE} casts.
   *
   * @param {ArrayLike<number>} origin Ray origin.
   * @param {ArrayLike<number>} dir Ray direction (normalized internally).
   * @param {number} [maxDist=1000] Maximum distance in meters.
   * @param {((body:object)=>boolean)|null} [filterFn=null] Return false to ignore a body.
   * @returns {{t:number,point:Float32Array,normal:Float32Array,body:object|null}|null} Nearest hit
   *   (`body` is null for a terrain hit), or null when nothing was hit.
   */
  raycast(origin, dir, maxDist = 1000, filterFn = null) {
    const ox = fin(origin[0], 0);
    const oy = fin(origin[1], 0);
    const oz = fin(origin[2], 0);
    let dx = fin(dir[0], 0);
    let dy = fin(dir[1], 0);
    let dz = fin(dir[2], 0);
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(dl > 1e-9)) return null;
    dx /= dl; dy /= dl; dz /= dl;
    let limit = fin(maxDist, 1000);
    if (!(limit > 0)) return null;
    if (limit > 1e5) limit = 1e5;

    this.stats.rayCells = 0;
    this.stats.rayBodies = 0;
    this.stats.queriesLastFrame++;
    this.stats.queriesTotal++;
    const stamp = this._nextStamp();
    const st = this._stamp;

    let best = limit;
    let bestBody = -1;
    let bnx = 0;
    let bny = 1;
    let bnz = 0;

    for (let k = 0; k < this._overCount; k++) {
      const i = this._over[k];
      st[i] = stamp;
      if (filterFn && !filterFn(this._objects[i])) continue;
      this.stats.rayBodies++;
      const t = this._kind[i] === KIND_BOX
        ? this._rayBox(i, ox, oy, oz, dx, dy, dz, best)
        : this._rayCylinder(i, ox, oy, oz, dx, dy, dz, best);
      if (t >= 0 && t < best) { best = t; bestBody = i; bnx = _nx; bny = _ny; bnz = _nz; }
    }

    // ---- 2D DDA over the hash grid ----------------------------------------------------------
    const cs = this.cellSize;
    const inv = this.invCell;
    const dim = this.gridDim;
    const mask = this.gridMask;
    let cx = Math.floor(ox * inv);
    let cz = Math.floor(oz * inv);
    const stepX = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
    const stepZ = dz > 0 ? 1 : (dz < 0 ? -1 : 0);
    let tMaxX = Infinity;
    let tDeltaX = Infinity;
    let tMaxZ = Infinity;
    let tDeltaZ = Infinity;
    if (stepX !== 0) {
      const bound = (cx + (stepX > 0 ? 1 : 0)) * cs;
      tMaxX = (bound - ox) / dx;
      tDeltaX = cs / (dx < 0 ? -dx : dx);
      if (tMaxX < 0) tMaxX = 0;
    }
    if (stepZ !== 0) {
      const bound = (cz + (stepZ > 0 ? 1 : 0)) * cs;
      tMaxZ = (bound - oz) / dz;
      tDeltaZ = cs / (dz < 0 ? -dz : dz);
      if (tMaxZ < 0) tMaxZ = 0;
    }

    for (let guard = 0; guard < MAX_RAY_CELLS; guard++) {
      this.stats.rayCells++;
      let e = this._cellHead[(cx & mask) * dim + (cz & mask)];
      while (e !== -1) {
        const i = this._entBody[e];
        e = this._entNext[e];
        if (st[i] === stamp) continue;
        st[i] = stamp;
        if (filterFn && !filterFn(this._objects[i])) continue;
        this.stats.rayBodies++;
        const t = this._kind[i] === KIND_BOX
          ? this._rayBox(i, ox, oy, oz, dx, dy, dz, best)
          : this._rayCylinder(i, ox, oy, oz, dx, dy, dz, best);
        if (t >= 0 && t < best) { best = t; bestBody = i; bnx = _nx; bny = _ny; bnz = _nz; }
      }
      const tNext = tMaxX < tMaxZ ? tMaxX : tMaxZ;
      if (tNext >= limit || best <= tNext) break;
      if (tMaxX < tMaxZ) { cx += stepX; tMaxX += tDeltaX; } else { cz += stepZ; tMaxZ += tDeltaZ; }
    }

    // ---- terrain ------------------------------------------------------------------------------
    if (this.terrainRaycast) {
      const tt = this._rayTerrain(ox, oy, oz, dx, dy, dz, best);
      if (tt >= 0 && tt < best) {
        best = tt;
        bestBody = -1;
        this._terrainNormal(ox + dx * tt, oz + dz * tt);
        bnx = _pnx; bny = _pny; bnz = _pnz;
        const res0 = this._rayPool[this._rayPoolAt];
        this._rayPoolAt = (this._rayPoolAt + 1) % RAY_POOL_SIZE;
        res0.t = best;
        res0.point[0] = ox + dx * best;
        res0.point[1] = oy + dy * best;
        res0.point[2] = oz + dz * best;
        res0.normal[0] = bnx;
        res0.normal[1] = bny;
        res0.normal[2] = bnz;
        res0.body = null;
        return res0;
      }
    }

    if (bestBody === -1) return null;
    const res = this._rayPool[this._rayPoolAt];
    this._rayPoolAt = (this._rayPoolAt + 1) % RAY_POOL_SIZE;
    res.t = best;
    res.point[0] = ox + dx * best;
    res.point[1] = oy + dy * best;
    res.point[2] = oz + dz * best;
    res.normal[0] = bnx;
    res.normal[1] = bny;
    res.normal[2] = bnz;
    res.body = this._objects[bestBody];
    return res;
  }

  /**
   * Ray vs oriented box (slab test in the body's local space).
   * @returns {number} Distance along the (normalized) ray, or -1 for a miss.
   * @private
   */
  _rayBox(i, ox, oy, oz, dx, dy, dz, maxT) {
    const f = this._f;
    const o = i * BODY_STRIDE;
    const s = f[o + B_SIN];
    const c = f[o + B_COS];
    const rx = ox - f[o + B_CX];
    const ry = oy - f[o + B_CY];
    const rz = oz - f[o + B_CZ];
    const lx = c * rx - s * rz;
    const ly = ry;
    const lz = s * rx + c * rz;
    const ldx = c * dx - s * dz;
    const ldy = dy;
    const ldz = s * dx + c * dz;
    const hx = f[o + B_HX];
    const hy = f[o + B_HY];
    const hz = f[o + B_HZ];

    let tmin = 0;
    let tmax = maxT;
    let axis = -1;

    if (ldx > -1e-12 && ldx < 1e-12) {
      if (lx < -hx || lx > hx) return -1;
    } else {
      const inv = 1 / ldx;
      let t1 = (-hx - lx) * inv;
      let t2 = (hx - lx) * inv;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
      if (t1 > tmin) { tmin = t1; axis = 0; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
    if (ldy > -1e-12 && ldy < 1e-12) {
      if (ly < -hy || ly > hy) return -1;
    } else {
      const inv = 1 / ldy;
      let t1 = (-hy - ly) * inv;
      let t2 = (hy - ly) * inv;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
      if (t1 > tmin) { tmin = t1; axis = 1; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
    if (ldz > -1e-12 && ldz < 1e-12) {
      if (lz < -hz || lz > hz) return -1;
    } else {
      const inv = 1 / ldz;
      let t1 = (-hz - lz) * inv;
      let t2 = (hz - lz) * inv;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
      if (t1 > tmin) { tmin = t1; axis = 2; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
    if (axis === -1) {
      // Origin inside the box.
      _nx = -dx; _ny = -dy; _nz = -dz;
      return 0;
    }
    let nlx = 0;
    let nly = 0;
    let nlz = 0;
    if (axis === 0) nlx = ldx > 0 ? -1 : 1;
    else if (axis === 1) nly = ldy > 0 ? -1 : 1;
    else nlz = ldz > 0 ? -1 : 1;
    _nx = c * nlx + s * nlz;
    _ny = nly;
    _nz = -s * nlx + c * nlz;
    return tmin;
  }

  /**
   * Ray vs vertical capped cylinder.
   * @returns {number} Distance along the (normalized) ray, or -1 for a miss.
   * @private
   */
  _rayCylinder(i, ox, oy, oz, dx, dy, dz, maxT) {
    const f = this._f;
    const o = i * BODY_STRIDE;
    const lx = ox - f[o + B_CX];
    const ly = oy - f[o + B_CY];
    const lz = oz - f[o + B_CZ];
    const rad = f[o + B_HX];
    const hy = f[o + B_HY];

    let tS0;
    let tS1;
    const a = dx * dx + dz * dz;
    const b = 2 * (lx * dx + lz * dz);
    const cc = lx * lx + lz * lz - rad * rad;
    if (a > 1e-12) {
      const disc = b * b - 4 * a * cc;
      if (disc < 0) return -1;
      const sq = Math.sqrt(disc);
      tS0 = (-b - sq) / (2 * a);
      tS1 = (-b + sq) / (2 * a);
    } else if (cc > 0) {
      return -1;
    } else {
      tS0 = -Infinity;
      tS1 = Infinity;
    }
    let tY0;
    let tY1;
    if (dy > -1e-12 && dy < 1e-12) {
      if (ly < -hy || ly > hy) return -1;
      tY0 = -Infinity;
      tY1 = Infinity;
    } else {
      const inv = 1 / dy;
      tY0 = (-hy - ly) * inv;
      tY1 = (hy - ly) * inv;
      if (tY0 > tY1) { const tt = tY0; tY0 = tY1; tY1 = tt; }
    }
    let tmin = tS0 > tY0 ? tS0 : tY0;
    const tmax = tS1 < tY1 ? tS1 : tY1;
    if (tmin > tmax || tmax < 0 || tmin > maxT) return -1;
    const side = tS0 >= tY0;
    if (tmin < 0) {
      _nx = -dx; _ny = -dy; _nz = -dz;
      return 0;
    }
    if (side) {
      const px = lx + dx * tmin;
      const pz = lz + dz * tmin;
      const d = Math.sqrt(px * px + pz * pz);
      if (d > 1e-8) { _nx = px / d; _ny = 0; _nz = pz / d; } else { _nx = 1; _ny = 0; _nz = 0; }
    } else {
      _nx = 0;
      _ny = dy > 0 ? -1 : 1;
      _nz = 0;
    }
    return tmin;
  }

  /**
   * Marches the terrain height field along a ray and bisects the first crossing.
   * @returns {number} Distance to the terrain, or -1 when the ray never reaches it.
   * @private
   */
  _rayTerrain(ox, oy, oz, dx, dy, dz, maxT) {
    const limit = maxT;
    if (!(limit > 0)) return -1;
    if (this._terrainFlat) {
      const y = this._terrainY;
      if (oy < y) return 0;
      if (dy >= -1e-9) return -1;
      const t = (oy - y) / -dy;
      return t <= limit ? t : -1;
    }
    let prevT = 0;
    let prev = (oy) - this.terrainHeight(ox, oz);
    if (prev <= 0) return 0;
    const steps = 96;
    const dt = limit / steps;
    for (let k = 1; k <= steps; k++) {
      const t = k * dt;
      const cur = (oy + dy * t) - this.terrainHeight(ox + dx * t, oz + dz * t);
      if (cur <= 0) {
        let lo = prevT;
        let hi = t;
        for (let it = 0; it < 14; it++) {
          const mid = (lo + hi) * 0.5;
          const v = (oy + dy * mid) - this.terrainHeight(ox + dx * mid, oz + dz * mid);
          if (v <= 0) hi = mid; else lo = mid;
        }
        return hi;
      }
      prev = cur;
      prevT = t;
    }
    return -1;
  }

  /* ----------------------------------------------------------------- stats */

  /**
   * Starts a new stats window: call once per frame to make `stats.queriesLastFrame` meaningful.
   */
  resetFrameStats() {
    this.stats.queriesLastFrame = 0;
    this.stats.bodies = this._bodyCount;
    this.stats.cells = this._cellsUsed;
  }
}

export default CollisionWorld;
