/**
 * @file js/render/renderer.js
 * Camera, forward+ style renderer, static/instanced batching and the cascaded shadow pass
 * for NEON CITY.
 *
 * Frame graph (normative, see docs/ARCHITECTURE.md section 5):
 *   1. update lights / frustum, build the per-frame draw list
 *   2. shadow pass into the cascaded depth-only targets
 *   3. bind the HDR target (rgba16f + depth texture), clear
 *   4. sky.render(camera)                 fullscreen, depth LEQUAL, depth write off
 *   5. opaque pass                        static batches, instanced batches, dynamic submits
 *   6. transparent pass                   sorted back-to-front, depth write off
 *   7. particles.render(camera)           reads the depth texture for soft particles
 *   8. postfx.render(hdrColor, depth, camera, dt, params) into the default framebuffer
 *
 * `Sky`, `PostFX` and `ParticleSystem` all render into whatever framebuffer is bound and must
 * not touch the viewport; the renderer owns both.
 *
 * @module render/renderer
 */

import { GpuMesh, RenderTarget, Shader, drawFullscreen } from '../core/gl.js';
import { clamp, DEG2RAD, mat3, mat4, vec3 } from '../core/math.js';
import {
  BLIT_FRAGMENT_SOURCE,
  FULLSCREEN_VERTEX_SOURCE,
  MAX_DRAW_LIGHTS,
  PBR_FRAGMENT_SOURCE,
  PBR_VERTEX_SOURCE,
  SHADOW_FRAGMENT_SOURCE,
  SHADOW_VERTEX_SOURCE
} from './shaders.js';
import {
  MATERIAL_FLAGS,
  QUEUE_TRANSPARENT,
  TEXTURE_UNITS,
  bindMaterialUniforms,
  bindShadowMaterialUniforms,
  buildMaterialDefines,
  buildShadowDefines,
  createMaterial,
  shadowFlagsOf
} from './materials.js';
import { Sky } from './sky.js';
import { PostFX } from './postfx.js';
import { ParticleSystem } from './particles.js';

/* -------------------------------------------------------------------------- */
/* Module scratch (never allocate per frame)                                   */
/* -------------------------------------------------------------------------- */

const _v0 = vec3.create();
const _v1 = vec3.create();
const _center = vec3.create();
const _lightUp = vec3.create();
const _lightDir = vec3.create();
const _m0 = mat4.create();
const _m1 = mat4.create();
const _clip = new Float32Array(4);
const _identity = mat4.identity(mat4.create());
const _identity3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const _white = new Float32Array([1, 1, 1, 1]);
const _frustumCorners = new Float32Array(24);

/** Highest triangle count merged into a single static batch chunk. */
const MAX_CHUNK_TRIANGLES = 200000;
/** Highest vertex count merged into a single static batch chunk (keeps 32-bit indices sane). */
const MAX_CHUNK_VERTICES = 900000;
/** Hard cap on per-frame dynamic submissions, guards against runaway callers. */
const MAX_DYNAMIC_SUBMITS = 20000;

/** Monotonic clock in milliseconds. @returns {number} Milliseconds. */
function nowMs() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

/* -------------------------------------------------------------------------- */
/* Camera                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Perspective camera driven by position + yaw + pitch (+ optional roll).
 *
 * Yaw convention (engine-wide): `yaw = 0` faces `-Z`, and
 * `forward = [-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch)]`.
 */
export class Camera {
  /**
   * @param {number} [fovDeg] Vertical field of view in DEGREES.
   * @param {number} [near] Near plane distance in metres.
   * @param {number} [far] Far plane distance in metres.
   */
  constructor(fovDeg = 62, near = 0.12, far = 1400) {
    /** @type {Float32Array} World-space eye position. */
    this.position = vec3.fromValues(0, 1.7, 0);
    /** @type {number} Radians, 0 faces -Z. */
    this.yaw = 0;
    /** @type {number} Radians, positive looks up. */
    this.pitch = 0;
    /** @type {number} Radians, rotation about the view axis. */
    this.roll = 0;
    /** @type {number} Vertical field of view in degrees. */
    this.fov = fovDeg;
    /** @type {number} */
    this.near = near;
    /** @type {number} */
    this.far = far;
    /** @type {number} Viewport aspect ratio, refreshed by {@link Camera#update}. */
    this.aspect = 16 / 9;

    /** @type {Float32Array} */
    this.view = mat4.create();
    /** @type {Float32Array} */
    this.proj = mat4.create();
    /** @type {Float32Array} */
    this.viewProj = mat4.create();
    /** @type {Float32Array} Inverse view == the camera world matrix. */
    this.invView = mat4.create();
    /** @type {Float32Array} */
    this.invProj = mat4.create();
    /** @type {Float32Array} */
    this.invViewProj = mat4.create();

    /** @type {Float32Array} Unit view direction. */
    this.forward = vec3.fromValues(0, 0, -1);
    /** @type {Float32Array} Unit right vector. */
    this.right = vec3.fromValues(1, 0, 0);
    /** @type {Float32Array} Unit up vector. */
    this.up = vec3.fromValues(0, 1, 0);

    /** @type {Float32Array} Six normalized planes (a,b,c,d), left/right/bottom/top/near/far. */
    this.frustum = new Float32Array(24);

    this.update(this.aspect);
  }

  /**
   * Points the camera at a target, deriving `yaw`/`pitch` so later mouse-look stays consistent.
   * @param {ArrayLike<number>} eye Eye position.
   * @param {ArrayLike<number>} target Look-at point.
   * @param {ArrayLike<number>} [up] Ignored (kept for API compatibility); world up is used.
   * @returns {Camera} this, for chaining.
   */
  setLookAt(eye, target, up) {
    void up;
    this.position[0] = eye[0];
    this.position[1] = eye[1];
    this.position[2] = eye[2];
    let dx = target[0] - eye[0];
    let dy = target[1] - eye[1];
    let dz = target[2] - eye[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len > 1e-6) {
      dx /= len;
      dy /= len;
      dz /= len;
      this.pitch = Math.asin(clamp(dy, -1, 1));
      this.yaw = Math.atan2(-dx, -dz);
    }
    return this.update(this.aspect);
  }

  /**
   * Rebuilds every matrix, the camera basis and the six frustum planes.
   * @param {number} [aspect] Viewport aspect ratio (width / height).
   * @returns {Camera} this, for chaining.
   */
  update(aspect) {
    if (aspect !== undefined && isFinite(aspect) && aspect > 0) this.aspect = aspect;

    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);

    const fx = -sy * cp;
    const fy = sp;
    const fz = -cy * cp;
    // Roll-free basis: right is always horizontal, up follows from right x forward.
    const r0x = cy;
    const r0y = 0;
    const r0z = -sy;
    const u0x = sy * sp;
    const u0y = cp;
    const u0z = cy * sp;

    let rx = r0x;
    let ry = r0y;
    let rz = r0z;
    let ux = u0x;
    let uy = u0y;
    let uz = u0z;
    if (this.roll !== 0) {
      const cr = Math.cos(this.roll);
      const sr = Math.sin(this.roll);
      rx = r0x * cr + u0x * sr;
      ry = r0y * cr + u0y * sr;
      rz = r0z * cr + u0z * sr;
      ux = u0x * cr - r0x * sr;
      uy = u0y * cr - r0y * sr;
      uz = u0z * cr - r0z * sr;
    }

    this.forward[0] = fx;
    this.forward[1] = fy;
    this.forward[2] = fz;
    this.right[0] = rx;
    this.right[1] = ry;
    this.right[2] = rz;
    this.up[0] = ux;
    this.up[1] = uy;
    this.up[2] = uz;

    const px = this.position[0];
    const py = this.position[1];
    const pz = this.position[2];
    const v = this.view;
    v[0] = rx; v[4] = ry; v[8] = rz; v[12] = -(rx * px + ry * py + rz * pz);
    v[1] = ux; v[5] = uy; v[9] = uz; v[13] = -(ux * px + uy * py + uz * pz);
    v[2] = -fx; v[6] = -fy; v[10] = -fz; v[14] = fx * px + fy * py + fz * pz;
    v[3] = 0; v[7] = 0; v[11] = 0; v[15] = 1;

    const iv = this.invView;
    iv[0] = rx; iv[1] = ry; iv[2] = rz; iv[3] = 0;
    iv[4] = ux; iv[5] = uy; iv[6] = uz; iv[7] = 0;
    iv[8] = -fx; iv[9] = -fy; iv[10] = -fz; iv[11] = 0;
    iv[12] = px; iv[13] = py; iv[14] = pz; iv[15] = 1;

    mat4.perspective(this.proj, this.fov * DEG2RAD, this.aspect, this.near, this.far);
    mat4.invert(this.invProj, this.proj);
    mat4.multiply(this.viewProj, this.proj, this.view);
    mat4.invert(this.invViewProj, this.viewProj);
    this._extractFrustum();
    return this;
  }

  /**
   * Gribb-Hartmann plane extraction from `viewProj`, normalized so distances are metric.
   * @returns {void}
   * @private
   */
  _extractFrustum() {
    const m = this.viewProj;
    const f = this.frustum;
    // rows of the (column-major) matrix
    const r0x = m[0], r0y = m[4], r0z = m[8], r0w = m[12];
    const r1x = m[1], r1y = m[5], r1z = m[9], r1w = m[13];
    const r2x = m[2], r2y = m[6], r2z = m[10], r2w = m[14];
    const r3x = m[3], r3y = m[7], r3z = m[11], r3w = m[15];
    const planes = [
      r3x + r0x, r3y + r0y, r3z + r0z, r3w + r0w,
      r3x - r0x, r3y - r0y, r3z - r0z, r3w - r0w,
      r3x + r1x, r3y + r1y, r3z + r1z, r3w + r1w,
      r3x - r1x, r3y - r1y, r3z - r1z, r3w - r1w,
      r3x + r2x, r3y + r2y, r3z + r2z, r3w + r2w,
      r3x - r2x, r3y - r2y, r3z - r2z, r3w - r2w
    ];
    for (let i = 0; i < 6; i++) {
      const o = i * 4;
      const a = planes[o];
      const b = planes[o + 1];
      const c = planes[o + 2];
      const inv = 1 / (Math.sqrt(a * a + b * b + c * c) || 1);
      f[o] = a * inv;
      f[o + 1] = b * inv;
      f[o + 2] = c * inv;
      f[o + 3] = planes[o + 3] * inv;
    }
  }

  /**
   * Frustum test for a world-space sphere.
   * @param {number} x Centre X.
   * @param {number} y Centre Y.
   * @param {number} z Centre Z.
   * @param {number} r Radius.
   * @returns {boolean} False only when the sphere is fully outside a plane.
   */
  frustumContainsSphere(x, y, z, r) {
    const f = this.frustum;
    for (let i = 0; i < 6; i++) {
      const o = i * 4;
      if (f[o] * x + f[o + 1] * y + f[o + 2] * z + f[o + 3] < -r) return false;
    }
    return true;
  }

  /**
   * Frustum test for a world-space AABB.
   * @param {ArrayLike<number>} min Minimum corner.
   * @param {ArrayLike<number>} max Maximum corner.
   * @returns {boolean} False only when the box is fully outside a plane.
   */
  frustumContainsAabb(min, max) {
    const f = this.frustum;
    for (let i = 0; i < 6; i++) {
      const o = i * 4;
      const a = f[o];
      const b = f[o + 1];
      const c = f[o + 2];
      const px = a >= 0 ? max[0] : min[0];
      const py = b >= 0 ? max[1] : min[1];
      const pz = c >= 0 ? max[2] : min[2];
      if (a * px + b * py + c * pz + f[o + 3] < 0) return false;
    }
    return true;
  }

  /**
   * Projects a world point to pixel coordinates (origin top-left).
   * @param {ArrayLike<number>} v3 World position.
   * @param {Float32Array|number[]} outVec3 Receives `[x, y, ndcZ]`.
   * @param {number} viewportW Viewport width in pixels.
   * @param {number} viewportH Viewport height in pixels.
   * @returns {boolean} False when the point is behind the camera.
   */
  worldToScreen(v3, outVec3, viewportW, viewportH) {
    const m = this.viewProj;
    const x = v3[0];
    const y = v3[1];
    const z = v3[2];
    _clip[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
    _clip[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    _clip[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    _clip[3] = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (_clip[3] <= 1e-6) {
      if (outVec3) {
        outVec3[0] = 0;
        outVec3[1] = 0;
        outVec3[2] = 1;
      }
      return false;
    }
    const iw = 1 / _clip[3];
    const ndcX = _clip[0] * iw;
    const ndcY = _clip[1] * iw;
    if (outVec3) {
      outVec3[0] = (ndcX * 0.5 + 0.5) * viewportW;
      outVec3[1] = (0.5 - ndcY * 0.5) * viewportH;
      outVec3[2] = _clip[2] * iw;
    }
    return true;
  }
}

/**
 * World-space point one kilometre down the camera's view ray, i.e. what the reticle points at
 * when nothing is hit. Gameplay code uses it as the aim target for hitscan weapons.
 * @param {Camera} camera Camera to read.
 * @param {Float32Array|number[]} out Receives the world position.
 * @returns {Float32Array|number[]} `out`.
 */
export function screenSpaceReticlePoint(camera, out) {
  out[0] = camera.position[0] + camera.forward[0] * 1000;
  out[1] = camera.position[1] + camera.forward[1] * 1000;
  out[2] = camera.position[2] + camera.forward[2] * 1000;
  return out;
}

/* -------------------------------------------------------------------------- */
/* Quality presets                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Built-in quality presets. `setQuality` accepts a name or a partial object that patches
 * the current preset.
 * @type {Object<string, Object>}
 */
export const QUALITY_PRESETS = {
  low: {
    name: 'low',
    shadowRes: 1024,
    cascades: 1,
    shadowDistance: 110,
    pcf: 0,
    bloom: false,
    ssao: false,
    renderScale: 0.7,
    maxPointLights: 8,
    aniso: 1,
    particleBudget: 900
  },
  medium: {
    name: 'medium',
    shadowRes: 1536,
    cascades: 2,
    shadowDistance: 170,
    pcf: 1,
    bloom: true,
    ssao: false,
    renderScale: 0.85,
    maxPointLights: 16,
    aniso: 4,
    particleBudget: 2200
  },
  high: {
    name: 'high',
    shadowRes: 2048,
    cascades: 3,
    shadowDistance: 250,
    pcf: 2,
    bloom: true,
    ssao: true,
    renderScale: 1,
    maxPointLights: 32,
    aniso: 8,
    particleBudget: 4200
  },
  ultra: {
    name: 'ultra',
    shadowRes: 4096,
    cascades: 4,
    shadowDistance: 340,
    pcf: 2,
    bloom: true,
    ssao: true,
    renderScale: 1,
    maxPointLights: 48,
    aniso: 16,
    particleBudget: 6000
  }
};

/* -------------------------------------------------------------------------- */
/* Internal records                                                            */
/* -------------------------------------------------------------------------- */

/** One entry of the per-frame draw list. Pooled: never constructed on the hot path. */
class DrawItem {
  constructor() {
    /** @type {GpuMesh|null} */
    this.mesh = null;
    /** @type {Object|null} */
    this.material = null;
    /** @type {Float32Array} */
    this.matrix = mat4.create();
    /** @type {Float32Array} */
    this.normalMatrix = new Float32Array(9);
    /** @type {Float32Array} */
    this.tint = new Float32Array([1, 1, 1, 1]);
    /** @type {number} 0 = non-instanced. */
    this.instanceCount = 0;
    /** @type {boolean} */
    this.instanced = false;
    /** @type {boolean} */
    this.castShadow = true;
    /** @type {number} */
    this.emissiveBoost = 1;
    /** @type {Float32Array} World-space bounding sphere centre. */
    this.center = vec3.create();
    /** @type {number} */
    this.radius = 0;
    /** @type {number} Distance to the camera (sort key). */
    this.depth = 0;
    /** @type {number} */
    this.triangles = 0;
    /** @type {Shader|null} */
    this.shader = null;
    /** @type {number} */
    this.programIndex = 0;
    /** @type {Int32Array} */
    this.lights = new Int32Array(MAX_DRAW_LIGHTS);
    /** @type {number} */
    this.lightCount = 0;
  }
}

/** A per-frame point or spot light. Pooled. */
class LightRecord {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.r = 0;
    this.g = 0;
    this.b = 0;
    this.radius = 1;
    this.dx = 0;
    this.dy = -1;
    this.dz = 0;
    this.spotScale = 0;
    this.spotOffset = 1;
    this.sortKey = 0;
  }
}

/** Merged static geometry for one material. */
class StaticGroup {
  /** @param {Object} material Material shared by every entry. */
  constructor(material) {
    /** @type {Object} */
    this.material = material;
    /** @type {Map<number, Object>} id -> geometry */
    this.entries = new Map();
    /** @type {Array<{mesh: GpuMesh, center: Float32Array, radius: number, triangles: number}>} */
    this.chunks = [];
    /** @type {boolean} */
    this.dirty = false;
  }
}

/* -------------------------------------------------------------------------- */
/* InstancedBatch                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A single mesh drawn many times with per-instance model matrices and rgba tints.
 * Instance data lives in one CPU-side `Float32Array` (20 floats per instance: a column-major
 * mat4 followed by an rgba tint) which is uploaded in one `bufferSubData` on {@link upload}.
 */
export class InstancedBatch {
  /**
   * @param {Renderer} renderer Owning renderer.
   * @param {Object} geometry Geometry object (see `core/gl.js`).
   * @param {Object} material Material from `createMaterial`.
   * @param {number} capacity Maximum instance count.
   */
  constructor(renderer, geometry, material, capacity) {
    /** @type {Renderer} */
    this.renderer = renderer;
    /** @type {Object} */
    this.material = material;
    /** @type {number} */
    this.capacity = Math.max(1, capacity | 0);
    /** @type {number} */
    this.count = 0;
    /** @type {boolean} */
    this.visible = true;
    /** @type {boolean} */
    this.disposed = false;

    // Instanced batches own their mesh: the instance buffer lives inside the VAO, so it must
    // never be shared with another batch through the mesh cache.
    /** @type {GpuMesh} */
    this.mesh = new GpuMesh(renderer.gl, geometry);
    this.mesh.enableInstancing(this.capacity, 20);
    /** @type {Float32Array} Packed instance data, 20 floats each. */
    this.data = new Float32Array(this.capacity * 20);
    for (let i = 0; i < this.capacity; i++) {
      const o = i * 20;
      this.data[o] = 1;
      this.data[o + 5] = 1;
      this.data[o + 10] = 1;
      this.data[o + 15] = 1;
      this.data[o + 16] = 1;
      this.data[o + 17] = 1;
      this.data[o + 18] = 1;
      this.data[o + 19] = 1;
    }
    /** @type {boolean} */
    this.dirty = true;
    /** @type {Float32Array} World bounding sphere centre. */
    this.center = vec3.create();
    /** @type {number} */
    this.radius = 0;
    /** @type {{min: Float32Array, max: Float32Array}} World AABB. */
    this.bounds = { min: vec3.create(), max: vec3.create() };
  }

  /**
   * Sets how many instances are drawn (clamped to the capacity).
   * @param {number} n Instance count.
   * @returns {InstancedBatch} this, for chaining.
   */
  setCount(n) {
    this.count = clamp(n | 0, 0, this.capacity);
    this.dirty = true;
    return this;
  }

  /**
   * Writes one instance.
   * @param {number} i Instance index.
   * @param {ArrayLike<number>} matrix Column-major mat4.
   * @param {ArrayLike<number>} [tintRgba] rgba tint, defaults to opaque white.
   * @returns {InstancedBatch} this, for chaining.
   */
  setInstance(i, matrix, tintRgba) {
    if (i < 0 || i >= this.capacity) return this;
    const o = i * 20;
    const d = this.data;
    for (let k = 0; k < 16; k++) d[o + k] = matrix[k];
    if (tintRgba) {
      d[o + 16] = tintRgba[0];
      d[o + 17] = tintRgba[1];
      d[o + 18] = tintRgba[2];
      d[o + 19] = tintRgba[3] === undefined ? 1 : tintRgba[3];
    } else {
      d[o + 16] = 1;
      d[o + 17] = 1;
      d[o + 18] = 1;
      d[o + 19] = 1;
    }
    if (i >= this.count) this.count = i + 1;
    this.dirty = true;
    return this;
  }

  /**
   * Replaces the whole instance array at once.
   * @param {Float32Array} float32Array Packed data, 20 floats per instance.
   * @param {number} [count] Instance count, defaults to `float32Array.length / 20`.
   * @returns {InstancedBatch} this, for chaining.
   */
  setAll(float32Array, count) {
    const n = clamp(count === undefined ? (float32Array.length / 20) | 0 : count | 0, 0, this.capacity);
    this.data.set(float32Array.subarray(0, n * 20));
    this.count = n;
    this.dirty = true;
    return this;
  }

  /**
   * Uploads dirty instance data to the GPU and refreshes the world bounds.
   * Cheap and idempotent: a clean batch returns immediately.
   * @returns {InstancedBatch} this, for chaining.
   */
  upload() {
    if (!this.dirty || this.disposed) return this;
    this.dirty = false;
    this.mesh.setInstanceData(this.data, this.count);
    this._computeBounds();
    return this;
  }

  /**
   * Recomputes the world AABB / bounding sphere from the instance matrices.
   * @returns {void}
   * @private
   */
  _computeBounds() {
    const d = this.data;
    const lc = this.mesh.boundsCenter;
    const lr = this.mesh.boundsRadius;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const o = i * 20;
      const cx = d[o] * lc[0] + d[o + 4] * lc[1] + d[o + 8] * lc[2] + d[o + 12];
      const cy = d[o + 1] * lc[0] + d[o + 5] * lc[1] + d[o + 9] * lc[2] + d[o + 13];
      const cz = d[o + 2] * lc[0] + d[o + 6] * lc[1] + d[o + 10] * lc[2] + d[o + 14];
      const s0 = Math.sqrt(d[o] * d[o] + d[o + 1] * d[o + 1] + d[o + 2] * d[o + 2]);
      const s1 = Math.sqrt(d[o + 4] * d[o + 4] + d[o + 5] * d[o + 5] + d[o + 6] * d[o + 6]);
      const s2 = Math.sqrt(d[o + 8] * d[o + 8] + d[o + 9] * d[o + 9] + d[o + 10] * d[o + 10]);
      const r = lr * Math.max(s0, Math.max(s1, s2));
      if (cx - r < minX) minX = cx - r;
      if (cy - r < minY) minY = cy - r;
      if (cz - r < minZ) minZ = cz - r;
      if (cx + r > maxX) maxX = cx + r;
      if (cy + r > maxY) maxY = cy + r;
      if (cz + r > maxZ) maxZ = cz + r;
    }
    if (this.count === 0) {
      minX = minY = minZ = 0;
      maxX = maxY = maxZ = 0;
    }
    this.bounds.min[0] = minX;
    this.bounds.min[1] = minY;
    this.bounds.min[2] = minZ;
    this.bounds.max[0] = maxX;
    this.bounds.max[1] = maxY;
    this.bounds.max[2] = maxZ;
    this.center[0] = (minX + maxX) * 0.5;
    this.center[1] = (minY + maxY) * 0.5;
    this.center[2] = (minZ + maxZ) * 0.5;
    const ex = (maxX - minX) * 0.5;
    const ey = (maxY - minY) * 0.5;
    const ez = (maxZ - minZ) * 0.5;
    this.radius = Math.sqrt(ex * ex + ey * ey + ez * ez);
  }

  /**
   * Releases the GPU mesh. The batch is removed from the renderer.
   * @returns {void}
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.visible = false;
    this.mesh.dispose();
    if (this.renderer) this.renderer._removeInstanced(this);
  }
}

/* -------------------------------------------------------------------------- */
/* Renderer                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The NEON CITY forward renderer.
 *
 * Owns the HDR target, the shadow cascades, the shader permutation cache, the static and
 * instanced batches and the sky / post FX / particle subsystems.
 */
export class Renderer {
  /**
   * @param {WebGL2RenderingContext} gl Context from `createGLContext`.
   * @param {HTMLCanvasElement} canvas Canvas backing the default framebuffer.
   * @param {Object} [options] Options.
   * @param {string|Object} [options.quality] Initial quality preset, default `'high'`.
   * @param {number} [options.maxParticles] Particle system capacity, default 6000.
   */
  constructor(gl, canvas, options = {}) {
    /** @type {WebGL2RenderingContext} */
    this.gl = gl;
    /** @type {HTMLCanvasElement} */
    this.canvas = canvas;

    /** @type {{drawCalls: number, triangles: number, fps: number, frameMs: number,
     *   shadowDrawCalls: number, culled: number, programs: number, lights: number,
     *   batches: number}} */
    this.stats = {
      drawCalls: 0,
      triangles: 0,
      fps: 0,
      frameMs: 0,
      shadowDrawCalls: 0,
      culled: 0,
      programs: 0,
      lights: 0,
      batches: 0
    };

    /** @type {number} Seconds since the renderer was created (shader animation clock). */
    this.time = 0;
    /** @type {number} */
    this._frameId = 0;
    /** @type {number} */
    this._fpsAccum = 0;
    /** @type {number} */
    this._fpsFrames = 0;

    // ---- lighting environment ----------------------------------------------------------
    /** @type {{direction: Float32Array, color: Float32Array, intensity: number,
     *   ambientSky: Float32Array, ambientGround: Float32Array, shadowStrength: number}} */
    this.sun = {
      direction: vec3.fromValues(0.42, 0.79, 0.45),
      color: vec3.fromValues(1, 0.96, 0.89),
      intensity: 3.4,
      ambientSky: vec3.fromValues(0.22, 0.30, 0.44),
      ambientGround: vec3.fromValues(0.10, 0.09, 0.08),
      shadowStrength: 1
    };
    vec3.normalize(this.sun.direction, this.sun.direction);
    /** @type {{color: Float32Array, density: number, heightFalloff: number, skyBlend: number}} */
    this.fog = {
      color: vec3.fromValues(0.52, 0.60, 0.70),
      density: 0.0016,
      heightFalloff: 0.018,
      skyBlend: 0.7
    };
    /** @type {number} 0..1, driven by the sky each frame. */
    this.nightFactor = 0;
    /** @type {Float32Array} `[wetness, rainIntensity]`. */
    this.wet = new Float32Array(2);
    /** @type {number} Tonemap exposure handed to post FX. */
    this.exposure = 1;

    /** Parameters handed to `postfx.render` every frame; mutate in place, never replace. */
    this.postParams = {
      exposure: 1,
      bloomStrength: 0.55,
      bloomThreshold: 1.1,
      vignette: 0.32,
      grain: 0.03,
      chromatic: 0.35,
      saturation: 1.05,
      contrast: 1.02,
      rain: 0,
      wetness: 0,
      damageFlash: 0,
      deathFade: 0,
      ssao: 1
    };

    // ---- shader cache -------------------------------------------------------------------
    /** @type {Map<string, Shader>} */
    this._programs = new Map();
    /** @type {Map<string, Shader>} */
    this._shadowPrograms = new Map();
    /** @type {number} */
    this._programIndex = 0;
    /** @type {Shader|null} */
    this._blitShader = null;

    // ---- geometry ------------------------------------------------------------------------
    /** @type {WeakMap<Object, GpuMesh>} */
    this._meshCache = new WeakMap();
    /** @type {GpuMesh[]} */
    this._ownedMeshes = [];
    /** @type {Map<number, StaticGroup>} */
    this._staticGroups = new Map();
    /** @type {Map<number, StaticGroup>} */
    this._staticIndex = new Map();
    /** @type {number} */
    this._nextStaticId = 1;
    /** @type {InstancedBatch[]} */
    this._instanced = [];

    // ---- per-frame pools -----------------------------------------------------------------
    /** @type {DrawItem[]} */
    this._itemPool = [];
    /** @type {number} */
    this._itemUsed = 0;
    /** @type {DrawItem[]} */
    this._dynamic = [];
    /** @type {DrawItem[]} */
    this._opaque = [];
    /** @type {DrawItem[]} */
    this._transparent = [];
    /** @type {DrawItem[]} */
    this._casters = [];
    /** @type {LightRecord[]} */
    this._lightPool = [];
    /** @type {number} */
    this._lightUsed = 0;
    /** @type {LightRecord[]} */
    this._lights = [];

    // ---- render state cache ---------------------------------------------------------------
    this._state = { blend: -1, depthWrite: -1, depthTest: -1, cull: -1, program: null, material: null };

    /** @type {RenderTarget|null} HDR scene target (rgba16f colour + depth texture). */
    this.hdr = null;
    /** @type {RenderTarget[]} Depth-only cascade targets. */
    this.shadowTargets = [];

    /** @type {number} Canvas width in pixels. */
    this.width = Math.max(1, canvas && canvas.width ? canvas.width : gl.drawingBufferWidth || 1);
    /** @type {number} Canvas height in pixels. */
    this.height = Math.max(1, canvas && canvas.height ? canvas.height : gl.drawingBufferHeight || 1);
    /** @type {number} HDR target width (canvas * renderScale). */
    this.renderWidth = this.width;
    /** @type {number} */
    this.renderHeight = this.height;

    // ---- shadow bookkeeping ----------------------------------------------------------------
    /** @type {Float32Array} Packed cascade view-projection matrices. */
    this._cascadeMatrices = new Float32Array(16 * 4);
    /** @type {Float32Array} Far distance of each cascade along the view axis. */
    this._cascadeSplits = new Float32Array(4);
    /** @type {Float32Array} World size of one shadow texel per cascade. */
    this._cascadeTexel = new Float32Array(4);
    /** @type {Float32Array} World-space cascade sphere centres (xyz per cascade). */
    this._cascadeCenters = new Float32Array(12);
    /** @type {Float32Array} World-space cascade sphere radii. */
    this._cascadeRadius = new Float32Array(4);
    /** @type {Float32Array} `[strength, normalBias, depthBias, 1/shadowRes]`. */
    this._shadowParams = new Float32Array([1, 1.4, 0.0012, 1 / 2048]);
    /** @type {boolean} */
    this._shadowsEnabled = true;

    // ---- light uniform payloads --------------------------------------------------------------
    /** @type {Float32Array} */
    this._lightPosRadius = new Float32Array(4);
    /** @type {Float32Array} */
    this._lightColor = new Float32Array(4);
    /** @type {Float32Array} */
    this._lightDirCone = new Float32Array(4);
    /** @type {number} */
    this._activeLights = 0;
    /** @type {Float32Array} `[renderWidth, renderHeight]` for screen-space lookups. */
    this._resolution = new Float32Array(2);
    /** @type {Float32Array} `[sunColor * intensity]`. */
    this._sunRadiance = vec3.create();

    /** @type {Camera|null} Camera of the frame currently being rendered. */
    this._camera = null;

    /** @type {Object} Fallback material for `submit` calls without one. */
    this.defaultMaterial = createMaterial({ name: 'default' });

    this.setQuality(options.quality || 'high');
    this.resize(this.width, this.height);

    // ---- subsystems (owned by the renderer, per the frame graph) --------------------------------
    /** @type {Sky|null} */
    this.sky = null;
    /** @type {PostFX|null} */
    this.postfx = null;
    /** @type {ParticleSystem|null} */
    this.particles = null;
    try {
      this.sky = new Sky(gl, this);
    } catch (err) {
      console.error('[renderer] Sky unavailable:', err);
    }
    try {
      this.postfx = new PostFX(gl, this);
      if (this.postfx && this.postfx.resize) this.postfx.resize(this.width, this.height);
    } catch (err) {
      console.error('[renderer] PostFX unavailable, falling back to a plain tonemap blit:', err);
    }
    try {
      this.particles = new ParticleSystem(gl, this, options.maxParticles || this.quality.particleBudget);
    } catch (err) {
      console.error('[renderer] ParticleSystem unavailable:', err);
    }
  }

  /* ---------------------------------------------------------------- quality */

  /**
   * Switches quality preset. Safe at runtime: shadow targets and the HDR target are
   * recreated and the shader permutation cache is invalidated.
   * @param {string|Object} nameOrObject `'low'|'medium'|'high'|'ultra'`, or a patch object
   *   whose fields override the current preset.
   * @returns {Object} The resolved quality object (`this.quality`).
   */
  setQuality(nameOrObject) {
    const gl = this.gl;
    let base;
    let patch = null;
    if (typeof nameOrObject === 'string') {
      base = QUALITY_PRESETS[nameOrObject] || QUALITY_PRESETS.high;
    } else if (nameOrObject && typeof nameOrObject === 'object') {
      base = QUALITY_PRESETS[nameOrObject.name] || this.quality || QUALITY_PRESETS.high;
      patch = nameOrObject;
    } else {
      base = QUALITY_PRESETS.high;
    }

    const q = {};
    for (const k in base) q[k] = base[k];
    if (patch) for (const k in patch) if (patch[k] !== undefined) q[k] = patch[k];

    const limits = gl.__limits || {};
    const maxTex = limits.maxTextureSize || 2048;
    q.shadowRes = clamp(q.shadowRes | 0, 256, Math.min(4096, maxTex));
    q.cascades = clamp(q.cascades | 0, 0, 4);
    q.pcf = clamp(q.pcf | 0, 0, 2);
    q.renderScale = clamp(q.renderScale, 0.4, 1);
    q.shadowDistance = Math.max(20, q.shadowDistance || 250);
    q.aniso = clamp(q.aniso | 0, 1, 16);
    q.particleBudget = Math.max(64, q.particleBudget | 0);
    q.bloom = !!q.bloom;
    q.ssao = !!q.ssao;

    // Keep the fragment uniform budget safe: 3 vec4 per light + 4 per cascade matrix + slack.
    const maxVectors = limits.maxFragmentUniformVectors || 224;
    const budget = Math.floor((maxVectors - 48 - q.cascades * 6) / 3);
    q.maxPointLights = clamp(q.maxPointLights | 0, 0, Math.max(4, budget));

    this.quality = q;
    this._shaderCtx = {
      cascades: q.cascades,
      pcf: q.pcf,
      pointLights: Math.max(1, q.maxPointLights),
      maxDrawLights: MAX_DRAW_LIGHTS,
      ssao: false
    };

    this._resizeLightArrays(this._shaderCtx.pointLights);
    this._disposeShaderCache();
    this._createShadowTargets();
    this._shadowParams[3] = 1 / q.shadowRes;
    this._shadowParams[1] = q.pcf >= 2 ? 1.7 : 1.35;
    this._shadowParams[2] = q.shadowRes >= 2048 ? 0.0009 : 0.0016;

    // Re-create the HDR target at the new render scale.
    this.resize(this.width, this.height);
    if (this.particles && this.particles.setBudget) this.particles.setBudget(q.particleBudget);
    this.postParams.bloomStrength = q.bloom ? this.postParams.bloomStrength || 0.55 : 0;
    this.postParams.ssao = q.ssao ? 1 : 0;
    return q;
  }

  /**
   * Resizes the canvas-dependent targets. The HDR target honours `quality.renderScale`
   * while post FX always outputs at the full canvas resolution.
   * @param {number} width Canvas width in pixels.
   * @param {number} height Canvas height in pixels.
   * @returns {void}
   */
  resize(width, height) {
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    this.width = w;
    this.height = h;
    const scale = this.quality ? this.quality.renderScale : 1;
    this.renderWidth = Math.max(1, Math.round(w * scale));
    this.renderHeight = Math.max(1, Math.round(h * scale));
    this._resolution[0] = this.renderWidth;
    this._resolution[1] = this.renderHeight;

    if (!this.hdr) {
      this.hdr = new RenderTarget(this.gl, this.renderWidth, this.renderHeight, {
        colorFormat: 'rgba16f',
        depth: true,
        depthTexture: true,
        filter: 'linear',
        wrap: 'clamp'
      });
    } else {
      this.hdr.resize(this.renderWidth, this.renderHeight);
    }
    if (this.postfx && this.postfx.resize) this.postfx.resize(w, h);
  }

  /**
   * (Re)creates the cascade depth targets from `quality.shadowRes` / `quality.cascades`.
   * @returns {void}
   * @private
   */
  _createShadowTargets() {
    for (let i = 0; i < this.shadowTargets.length; i++) this.shadowTargets[i].dispose();
    this.shadowTargets.length = 0;
    const n = this.quality.cascades;
    for (let i = 0; i < n; i++) {
      this.shadowTargets.push(new RenderTarget(this.gl, this.quality.shadowRes, this.quality.shadowRes, {
        colorCount: 0,
        depth: true,
        depthTexture: true,
        filter: 'nearest',
        wrap: 'clamp'
      }));
    }
  }

  /**
   * Reallocates the per-frame light uniform payloads.
   * @param {number} n Light array size.
   * @returns {void}
   * @private
   */
  _resizeLightArrays(n) {
    const size = Math.max(1, n) * 4;
    if (this._lightPosRadius.length !== size) {
      this._lightPosRadius = new Float32Array(size);
      this._lightColor = new Float32Array(size);
      this._lightDirCone = new Float32Array(size);
    }
  }

  /* --------------------------------------------------------------- shaders */

  /**
   * Returns (compiling on first use) the uber-shader permutation for a material.
   * @param {Object} mat Material.
   * @param {boolean} instanced True when drawn with per-instance matrices.
   * @returns {Shader} The cached program.
   * @private
   */
  _getProgram(mat, instanced) {
    let flags = mat.flags;
    if (instanced) flags |= MATERIAL_FLAGS.INSTANCED;
    const ctx = this._shaderCtx;
    const key = flags + '|' + ctx.cascades + '|' + ctx.pcf + '|' + ctx.pointLights + '|' + (ctx.ssao ? 1 : 0);
    let shader = this._programs.get(key);
    if (shader) return shader;
    const defines = buildMaterialDefines(flags, ctx);
    shader = new Shader(this.gl, PBR_VERTEX_SOURCE, PBR_FRAGMENT_SOURCE, defines, 'pbr:' + key);
    shader._index = ++this._programIndex;
    shader._frameStamp = -1;
    this._programs.set(key, shader);
    this.stats.programs = this._programs.size + this._shadowPrograms.size;
    return shader;
  }

  /**
   * Returns (compiling on first use) the depth-only shadow permutation for a material.
   * @param {Object} mat Material.
   * @param {boolean} instanced True when drawn with per-instance matrices.
   * @returns {Shader} The cached program.
   * @private
   */
  _getShadowProgram(mat, instanced) {
    const flags = shadowFlagsOf(mat, instanced);
    const key = String(flags);
    let shader = this._shadowPrograms.get(key);
    if (shader) return shader;
    shader = new Shader(this.gl, SHADOW_VERTEX_SOURCE, SHADOW_FRAGMENT_SOURCE,
      buildShadowDefines(flags), 'shadow:' + key);
    shader._index = ++this._programIndex;
    shader._cascadeStamp = -1;
    this._shadowPrograms.set(key, shader);
    this.stats.programs = this._programs.size + this._shadowPrograms.size;
    return shader;
  }

  /**
   * Drops every cached program (used when quality changes the global defines).
   * @returns {void}
   * @private
   */
  _disposeShaderCache() {
    for (const shader of this._programs.values()) shader.dispose();
    for (const shader of this._shadowPrograms.values()) shader.dispose();
    this._programs.clear();
    this._shadowPrograms.clear();
    this._programIndex = 0;
    this._state.program = null;
    this.stats.programs = 0;
  }

  /**
   * Compiles shader permutations ahead of time so the first frames never hitch.
   * @param {boolean} [deep] Compile the full feature matrix (used by tests) instead of the
   *   permutations the game actually hits during loading.
   * @returns {number} Number of programs in the cache afterwards.
   */
  precompile(deep) {
    const F = MATERIAL_FLAGS;
    const common = [
      0,
      F.MAP,
      F.MAP | F.NORMAL_MAP,
      F.VERTEX_COLOR,
      F.MAP | F.VERTEX_COLOR,
      F.MAP | F.NORMAL_MAP | F.VERTEX_COLOR,
      F.MAP | F.WINDOW_GLOW,
      F.MAP | F.ALPHA_TEST,
      F.UNLIT,
      F.MAP | F.UNLIT
    ];
    const fake = { flags: 0, alphaTest: 1, map: true };
    const compile = (flags) => {
      fake.flags = flags;
      this._getProgram(fake, false);
      this._getProgram(fake, true);
      this._getShadowProgram(fake, false);
      this._getShadowProgram(fake, true);
    };
    if (deep) {
      const bits = [F.MAP, F.NORMAL_MAP, F.VERTEX_COLOR, F.ALPHA_TEST, F.WINDOW_GLOW, F.NO_SHADOW];
      for (let mask = 0; mask < (1 << bits.length); mask++) {
        let flags = 0;
        for (let b = 0; b < bits.length; b++) if (mask & (1 << b)) flags |= bits[b];
        compile(flags);
      }
      compile(F.UNLIT);
      compile(F.UNLIT | F.MAP);
      compile(F.UNLIT | F.MAP | F.ALPHA_TEST);
    } else {
      for (let i = 0; i < common.length; i++) compile(common[i]);
    }
    return this._programs.size + this._shadowPrograms.size;
  }

  /* -------------------------------------------------------------- geometry */

  /**
   * Uploads a geometry object to the GPU, caching by geometry identity so repeated calls
   * with the same object return the same mesh.
   * @param {Object} geometry Geometry object (positions/normals/uvs/indices/colors).
   * @returns {GpuMesh} The uploaded mesh (owned by the renderer).
   */
  createMesh(geometry) {
    let mesh = this._meshCache.get(geometry);
    if (mesh && !mesh.disposed) return mesh;
    mesh = new GpuMesh(this.gl, geometry);
    this._meshCache.set(geometry, mesh);
    this._ownedMeshes.push(mesh);
    return mesh;
  }

  /**
   * Adds world-space static geometry. Everything sharing a material is merged into large
   * VBOs (rebuilt lazily), split into chunks of at most ~200k triangles so per-chunk frustum
   * culling stays meaningful.
   * @param {Object} geometry Geometry already positioned in world space.
   * @param {Object} material Material from `createMaterial`.
   * @returns {number} Handle for {@link Renderer#removeStatic}.
   */
  addStatic(geometry, material) {
    const mat = material || this.defaultMaterial;
    let group = this._staticGroups.get(mat.id);
    if (!group) {
      group = new StaticGroup(mat);
      this._staticGroups.set(mat.id, group);
    }
    const id = this._nextStaticId++;
    group.entries.set(id, geometry);
    group.dirty = true;
    this._staticIndex.set(id, group);
    return id;
  }

  /**
   * Removes static geometry previously added with {@link Renderer#addStatic}.
   * @param {number} id Handle returned by `addStatic`.
   * @returns {boolean} True when something was removed.
   */
  removeStatic(id) {
    const group = this._staticIndex.get(id);
    if (!group) return false;
    group.entries.delete(id);
    group.dirty = true;
    this._staticIndex.delete(id);
    return true;
  }

  /**
   * Creates an instanced batch owned by the renderer.
   * @param {Object} geometry Geometry drawn once per instance.
   * @param {Object} material Material from `createMaterial`.
   * @param {number} capacity Maximum instance count.
   * @returns {InstancedBatch} The new batch.
   */
  addInstanced(geometry, material, capacity) {
    const batch = new InstancedBatch(this, geometry, material || this.defaultMaterial, capacity);
    this._instanced.push(batch);
    return batch;
  }

  /**
   * Detaches a batch from the render list (called by `InstancedBatch#dispose`).
   * @param {InstancedBatch} batch Batch to remove.
   * @returns {void}
   * @private
   */
  _removeInstanced(batch) {
    const i = this._instanced.indexOf(batch);
    if (i >= 0) this._instanced.splice(i, 1);
  }

  /**
   * Drops every static and instanced batch and the meshes created by {@link createMesh}.
   * @returns {void}
   */
  clearWorld() {
    for (const group of this._staticGroups.values()) {
      for (let i = 0; i < group.chunks.length; i++) group.chunks[i].mesh.dispose();
      group.chunks.length = 0;
      group.entries.clear();
    }
    this._staticGroups.clear();
    this._staticIndex.clear();
    for (let i = this._instanced.length - 1; i >= 0; i--) {
      const batch = this._instanced[i];
      batch.disposed = true;
      batch.mesh.dispose();
    }
    this._instanced.length = 0;
    for (let i = 0; i < this._ownedMeshes.length; i++) this._ownedMeshes[i].dispose();
    this._ownedMeshes.length = 0;
    this._meshCache = new WeakMap();
    this._opaque.length = 0;
    this._transparent.length = 0;
    this._casters.length = 0;
    this._dynamic.length = 0;
    this._itemUsed = 0;
  }

  /**
   * Merges every entry of a static group into chunk meshes.
   * @param {StaticGroup} group Group to rebuild.
   * @returns {void}
   * @private
   */
  _rebuildStaticGroup(group) {
    group.dirty = false;
    for (let i = 0; i < group.chunks.length; i++) group.chunks[i].mesh.dispose();
    group.chunks.length = 0;
    if (group.entries.size === 0) return;

    const list = [];
    for (const geo of group.entries.values()) {
      if (!geo || !geo.positions || geo.positions.length < 9) continue;
      list.push(geo);
    }
    if (list.length === 0) return;

    let start = 0;
    while (start < list.length) {
      let end = start;
      let verts = 0;
      let indices = 0;
      let hasUv = false;
      let hasColor = false;
      let hasNormal = false;
      while (end < list.length) {
        const geo = list[end];
        const vCount = (geo.positions.length / 3) | 0;
        const iCount = geo.indices && geo.indices.length ? geo.indices.length : vCount;
        if (end > start && (indices + iCount > MAX_CHUNK_TRIANGLES * 3 || verts + vCount > MAX_CHUNK_VERTICES)) break;
        verts += vCount;
        indices += iCount;
        if (geo.uvs && geo.uvs.length >= vCount * 2) hasUv = true;
        if (geo.colors && geo.colors.length >= vCount * 3) hasColor = true;
        if (geo.normals && geo.normals.length >= vCount * 3) hasNormal = true;
        end++;
      }

      const positions = new Float32Array(verts * 3);
      const normals = hasNormal ? new Float32Array(verts * 3) : null;
      const uvs = hasUv ? new Float32Array(verts * 2) : null;
      const colors = hasColor ? new Float32Array(verts * 3) : null;
      const indexArray = verts > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);

      let vo = 0;
      let io = 0;
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let e = start; e < end; e++) {
        const geo = list[e];
        const vCount = (geo.positions.length / 3) | 0;
        positions.set(geo.positions.subarray ? geo.positions.subarray(0, vCount * 3) : geo.positions, vo * 3);
        for (let i = 0; i < vCount; i++) {
          const x = geo.positions[i * 3];
          const y = geo.positions[i * 3 + 1];
          const z = geo.positions[i * 3 + 2];
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (z < minZ) minZ = z;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          if (z > maxZ) maxZ = z;
        }
        if (normals) {
          if (geo.normals && geo.normals.length >= vCount * 3) {
            normals.set(geo.normals.subarray ? geo.normals.subarray(0, vCount * 3) : geo.normals, vo * 3);
          } else {
            for (let i = 0; i < vCount; i++) normals[(vo + i) * 3 + 1] = 1;
          }
        }
        if (uvs && geo.uvs && geo.uvs.length >= vCount * 2) {
          uvs.set(geo.uvs.subarray ? geo.uvs.subarray(0, vCount * 2) : geo.uvs, vo * 2);
        }
        if (colors) {
          if (geo.colors && geo.colors.length >= vCount * 3) {
            colors.set(geo.colors.subarray ? geo.colors.subarray(0, vCount * 3) : geo.colors, vo * 3);
          } else {
            for (let i = 0; i < vCount * 3; i++) colors[vo * 3 + i] = 1;
          }
        }
        if (geo.indices && geo.indices.length) {
          for (let i = 0; i < geo.indices.length; i++) indexArray[io + i] = geo.indices[i] + vo;
          io += geo.indices.length;
        } else {
          for (let i = 0; i < vCount; i++) indexArray[io + i] = vo + i;
          io += vCount;
        }
        vo += vCount;
      }

      const merged = {
        positions,
        normals: normals || undefined,
        uvs: uvs || undefined,
        colors: colors || undefined,
        indices: indexArray,
        bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] }
      };
      const mesh = new GpuMesh(this.gl, merged);
      const cx = (minX + maxX) * 0.5;
      const cy = (minY + maxY) * 0.5;
      const cz = (minZ + maxZ) * 0.5;
      const ex = (maxX - minX) * 0.5;
      const ey = (maxY - minY) * 0.5;
      const ez = (maxZ - minZ) * 0.5;
      group.chunks.push({
        mesh,
        center: vec3.fromValues(cx, cy, cz),
        radius: Math.sqrt(ex * ex + ey * ey + ez * ez),
        triangles: (indices / 3) | 0
      });
      start = end;
    }
  }

  /* ------------------------------------------------------- per-frame input */

  /**
   * Takes the next pooled draw item.
   * @returns {DrawItem|null} A reusable item, or null once the per-frame cap is hit.
   * @private
   */
  _acquireItem() {
    if (this._itemUsed >= MAX_DYNAMIC_SUBMITS * 4) return null;
    let item = this._itemPool[this._itemUsed];
    if (item === undefined) {
      item = new DrawItem();
      this._itemPool.push(item);
    }
    this._itemUsed++;
    return item;
  }

  /**
   * Queues a dynamic draw for this frame. The matrix is copied, so callers may reuse scratch.
   * @param {GpuMesh|Object} mesh Mesh (or a geometry object, which is uploaded and cached).
   * @param {Object} material Material.
   * @param {ArrayLike<number>} matrix Column-major model matrix.
   * @param {Object} [opts] Options.
   * @param {ArrayLike<number>} [opts.tint] rgba multiplier, default white.
   * @param {boolean} [opts.castShadow] Override the material's shadow casting.
   * @param {number} [opts.emissiveBoost] Multiplies the emissive term, default 1.
   * @returns {void}
   */
  submit(mesh, material, matrix, opts = null) {
    if (!mesh) return;
    if (this._dynamic.length >= MAX_DYNAMIC_SUBMITS) return;
    const gpuMesh = mesh instanceof GpuMesh ? mesh : this.createMesh(mesh);
    if (!gpuMesh || gpuMesh.indexCount === 0) return;
    const item = this._acquireItem();
    if (!item) return;
    const mat = material || this.defaultMaterial;

    item.mesh = gpuMesh;
    item.material = mat;
    item.instanced = false;
    item.instanceCount = 0;
    item.triangles = gpuMesh.triangleCount;
    const m = item.matrix;
    for (let i = 0; i < 16; i++) m[i] = matrix[i];
    mat3.normalFromMat4(item.normalMatrix, m);

    if (opts && opts.tint) {
      item.tint[0] = opts.tint[0];
      item.tint[1] = opts.tint[1];
      item.tint[2] = opts.tint[2];
      item.tint[3] = opts.tint[3] === undefined ? 1 : opts.tint[3];
    } else {
      item.tint.set(_white);
    }
    item.castShadow = opts && opts.castShadow !== undefined ? !!opts.castShadow : mat.castShadow;
    item.emissiveBoost = opts && opts.emissiveBoost !== undefined ? opts.emissiveBoost : 1;

    // World bounding sphere of the mesh under this transform.
    const lc = gpuMesh.boundsCenter;
    item.center[0] = m[0] * lc[0] + m[4] * lc[1] + m[8] * lc[2] + m[12];
    item.center[1] = m[1] * lc[0] + m[5] * lc[1] + m[9] * lc[2] + m[13];
    item.center[2] = m[2] * lc[0] + m[6] * lc[1] + m[10] * lc[2] + m[14];
    const s0 = Math.sqrt(m[0] * m[0] + m[1] * m[1] + m[2] * m[2]);
    const s1 = Math.sqrt(m[4] * m[4] + m[5] * m[5] + m[6] * m[6]);
    const s2 = Math.sqrt(m[8] * m[8] + m[9] * m[9] + m[10] * m[10]);
    item.radius = gpuMesh.boundsRadius * Math.max(s0, Math.max(s1, s2));
    this._dynamic.push(item);
  }

  /**
   * Takes the next pooled light record.
   * @returns {LightRecord|null} A reusable record, or null when the frame budget is spent.
   * @private
   */
  _acquireLight() {
    if (this._lightUsed >= 4096) return null;
    let light = this._lightPool[this._lightUsed];
    if (light === undefined) {
      light = new LightRecord();
      this._lightPool.push(light);
    }
    this._lightUsed++;
    return light;
  }

  /**
   * Adds a point light for this frame.
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} r Linear red.
   * @param {number} g Linear green.
   * @param {number} b Linear blue.
   * @param {number} radius Cutoff radius in metres.
   * @param {number} intensity Radiant multiplier.
   * @returns {void}
   */
  submitLight(x, y, z, r, g, b, radius, intensity) {
    const l = this._acquireLight();
    if (!l) return;
    const i = intensity === undefined ? 1 : intensity;
    l.x = x;
    l.y = y;
    l.z = z;
    l.r = r * i;
    l.g = g * i;
    l.b = b * i;
    l.radius = Math.max(0.05, radius);
    l.dx = 0;
    l.dy = -1;
    l.dz = 0;
    l.spotScale = 0;
    l.spotOffset = 1;
    this._lights.push(l);
  }

  /**
   * Adds a spot light for this frame (headlights, torches, searchlights).
   * @param {ArrayLike<number>} pos3 World position.
   * @param {ArrayLike<number>} dir3 Direction the cone points at (does not need to be unit).
   * @param {ArrayLike<number>} color3 Linear rgb.
   * @param {number} range Cutoff radius in metres.
   * @param {number} cosInner Cosine of the inner cone half-angle.
   * @param {number} cosOuter Cosine of the outer cone half-angle.
   * @param {number} intensity Radiant multiplier.
   * @returns {void}
   */
  submitSpotLight(pos3, dir3, color3, range, cosInner, cosOuter, intensity) {
    const l = this._acquireLight();
    if (!l) return;
    const i = intensity === undefined ? 1 : intensity;
    l.x = pos3[0];
    l.y = pos3[1];
    l.z = pos3[2];
    l.r = color3[0] * i;
    l.g = color3[1] * i;
    l.b = color3[2] * i;
    l.radius = Math.max(0.05, range);
    const len = Math.sqrt(dir3[0] * dir3[0] + dir3[1] * dir3[1] + dir3[2] * dir3[2]) || 1;
    l.dx = dir3[0] / len;
    l.dy = dir3[1] / len;
    l.dz = dir3[2] / len;
    const inner = cosInner === undefined ? 0.9 : cosInner;
    const outer = cosOuter === undefined ? 0.75 : cosOuter;
    l.spotScale = 1 / Math.max(inner - outer, 1e-3);
    l.spotOffset = -outer * l.spotScale;
    this._lights.push(l);
  }

  /* ------------------------------------------------------------ environment */

  /**
   * Sets the sun / moon key light and the analytic ambient hemisphere.
   * @param {Object} desc Description.
   * @param {ArrayLike<number>} [desc.direction] Unit vector pointing FROM the scene TOWARDS
   *   the sun (the same convention `render/sky.js` publishes as `sunDirection`).
   * @param {ArrayLike<number>} [desc.color] Linear rgb.
   * @param {number} [desc.intensity] Radiance multiplier.
   * @param {ArrayLike<number>} [desc.ambientSky] Upper hemisphere ambient.
   * @param {ArrayLike<number>} [desc.ambientGround] Lower hemisphere ambient.
   * @param {number} [desc.shadowStrength] 0 = no shadowing, 1 = fully dark shadows.
   * @returns {void}
   */
  setSun(desc) {
    if (!desc) return;
    const sun = this.sun;
    if (desc.direction) {
      sun.direction[0] = desc.direction[0];
      sun.direction[1] = desc.direction[1];
      sun.direction[2] = desc.direction[2];
      vec3.normalize(sun.direction, sun.direction);
    }
    if (desc.color) {
      sun.color[0] = desc.color[0];
      sun.color[1] = desc.color[1];
      sun.color[2] = desc.color[2];
    }
    if (desc.intensity !== undefined) sun.intensity = desc.intensity;
    if (desc.ambientSky) {
      sun.ambientSky[0] = desc.ambientSky[0];
      sun.ambientSky[1] = desc.ambientSky[1];
      sun.ambientSky[2] = desc.ambientSky[2];
    }
    if (desc.ambientGround) {
      sun.ambientGround[0] = desc.ambientGround[0];
      sun.ambientGround[1] = desc.ambientGround[1];
      sun.ambientGround[2] = desc.ambientGround[2];
    }
    if (desc.shadowStrength !== undefined) sun.shadowStrength = clamp(desc.shadowStrength, 0, 1);
  }

  /**
   * Sets the exponential height fog matched to the sky.
   * @param {Object} desc Description.
   * @param {ArrayLike<number>} [desc.color] Linear rgb.
   * @param {number} [desc.density] Extinction per metre at y = 0.
   * @param {number} [desc.heightFalloff] Vertical falloff; 0 makes the fog uniform.
   * @param {number} [desc.skyBlend] 0..1 amount of sun-direction scattering.
   * @returns {void}
   */
  setFog(desc) {
    if (!desc) return;
    if (desc.color) {
      this.fog.color[0] = desc.color[0];
      this.fog.color[1] = desc.color[1];
      this.fog.color[2] = desc.color[2];
    }
    if (desc.density !== undefined) this.fog.density = Math.max(0, desc.density);
    if (desc.heightFalloff !== undefined) this.fog.heightFalloff = Math.max(0, desc.heightFalloff);
    if (desc.skyBlend !== undefined) this.fog.skyBlend = clamp(desc.skyBlend, 0, 1);
  }

  /**
   * Sets the tonemap exposure handed to post FX.
   * @param {number} v Exposure multiplier.
   * @returns {void}
   */
  setExposure(v) {
    this.exposure = Math.max(0.01, v);
    this.postParams.exposure = this.exposure;
  }

  /**
   * Sets how wet the world looks (roads darken, reflect and smooth out).
   * @param {number} v01 0..1.
   * @returns {void}
   */
  setWetness(v01) {
    this.wet[0] = clamp(v01, 0, 1);
    this.postParams.wetness = this.wet[0];
  }

  /**
   * Sets rain intensity, which drives the animated ripple normals and the post FX overlay.
   * @param {number} v01 0..1.
   * @returns {void}
   */
  setRainIntensity(v01) {
    this.wet[1] = clamp(v01, 0, 1);
    this.postParams.rain = this.wet[1];
  }

  /* ------------------------------------------------------------------ frame */

  /**
   * Renders one frame following the documented frame graph.
   * @param {Camera} camera Camera to render from.
   * @param {number} dt Seconds since the previous frame.
   * @returns {void}
   */
  render(camera, dt) {
    const gl = this.gl;
    const t0 = nowMs();
    const step = clamp(dt || 0, 0, 0.25);
    this.time += step;
    this._frameId++;
    this.stats.drawCalls = 0;
    this.stats.triangles = 0;
    this.stats.shadowDrawCalls = 0;
    this.stats.culled = 0;

    if (this.canvas && this.canvas.width && (this.canvas.width !== this.width || this.canvas.height !== this.height)) {
      this.resize(this.canvas.width, this.canvas.height);
    }

    // Pick up the sky's night factor so night-time window glow works without extra plumbing.
    if (this.sky && typeof this.sky.nightFactor === 'number') {
      this.nightFactor = clamp(this.sky.nightFactor, 0, 1);
    } else {
      this.nightFactor = clamp(1 - (this.sun.direction[1] + 0.08) * 6, 0, 1);
    }
    this._sunRadiance[0] = this.sun.color[0] * this.sun.intensity;
    this._sunRadiance[1] = this.sun.color[1] * this.sun.intensity;
    this._sunRadiance[2] = this.sun.color[2] * this.sun.intensity;

    // SSAO permutation follows the post FX module: it only exists when postfx publishes an
    // AO texture (optional hook). Changing it invalidates the program cache, so it is sticky.
    const wantSsao = !!(this.quality.ssao && this.postfx && this.postfx.aoTexture);
    if (wantSsao !== this._shaderCtx.ssao) {
      this._shaderCtx.ssao = wantSsao;
      this._disposeShaderCache();
    }

    this._camera = camera;
    camera.update(this.width / Math.max(1, this.height));

    // 1. lights + draw list
    this._prepareLights(camera);
    this._buildDrawList(camera);

    // 2. shadows
    this._renderShadows(camera);

    // 3. HDR target
    this.hdr.setClearColor(this.fog.color[0], this.fog.color[1], this.fog.color[2], 1);
    this.hdr.bind(true);
    this._resetState();

    // 4. sky
    if (this.sky && this.sky.render) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(false);
      gl.disable(gl.BLEND);
      this.sky.render(camera);
      this._resetState();
    }

    // 5. opaque
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    this._drawList(this._opaque);

    // 6. transparent
    this._drawList(this._transparent);

    // 7. particles
    if (this.particles && this.particles.render) {
      this.particles.render(camera);
      this._resetState();
    }

    // 8. post FX into the default framebuffer at full canvas resolution
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    this.postParams.exposure = this.exposure;
    this.postParams.wetness = this.wet[0];
    this.postParams.rain = this.wet[1];
    this.postParams.ssao = this.quality.ssao ? 1 : 0;
    this.postParams.bloomStrength = this.quality.bloom ? this.postParams.bloomStrength : 0;
    if (this.postfx && this.postfx.render) {
      this.postfx.render(this.hdr.color(0), this.hdr.depthTex, camera, step, this.postParams);
    } else {
      this._blitFallback();
    }
    this._resetState();

    this._endFrame(t0, step);
  }

  /**
   * Resets per-frame pools and updates timing stats.
   * @param {number} t0 Frame start timestamp.
   * @param {number} dt Frame delta in seconds.
   * @returns {void}
   * @private
   */
  _endFrame(t0, dt) {
    this._dynamic.length = 0;
    this._opaque.length = 0;
    this._transparent.length = 0;
    this._casters.length = 0;
    this._lights.length = 0;
    this._itemUsed = 0;
    this._lightUsed = 0;
    this.stats.frameMs = nowMs() - t0;
    this.stats.batches = this._staticGroups.size + this._instanced.length;
    this._fpsAccum += dt;
    this._fpsFrames++;
    if (this._fpsAccum >= 0.5) {
      this.stats.fps = this._fpsFrames / this._fpsAccum;
      this._fpsAccum = 0;
      this._fpsFrames = 0;
    }
  }

  /**
   * Sorts submitted lights by camera distance, keeps the nearest `quality.maxPointLights`
   * and packs them into the uniform payloads.
   * @param {Camera} camera Active camera.
   * @returns {void}
   * @private
   */
  _prepareLights(camera) {
    const lights = this._lights;
    const max = this.quality.maxPointLights;
    const px = camera.position[0];
    const py = camera.position[1];
    const pz = camera.position[2];
    for (let i = 0; i < lights.length; i++) {
      const l = lights[i];
      const dx = l.x - px;
      const dy = l.y - py;
      const dz = l.z - pz;
      // Bigger lights survive culling further away.
      l.sortKey = Math.sqrt(dx * dx + dy * dy + dz * dz) - l.radius;
    }
    if (lights.length > max) lights.sort((a, b) => a.sortKey - b.sortKey);
    const n = Math.min(lights.length, max);
    this._activeLights = n;
    this.stats.lights = n;
    const pr = this._lightPosRadius;
    const lc = this._lightColor;
    const ld = this._lightDirCone;
    for (let i = 0; i < n; i++) {
      const l = lights[i];
      const o = i * 4;
      pr[o] = l.x;
      pr[o + 1] = l.y;
      pr[o + 2] = l.z;
      pr[o + 3] = l.radius;
      lc[o] = l.r;
      lc[o + 1] = l.g;
      lc[o + 2] = l.b;
      lc[o + 3] = l.spotScale;
      ld[o] = l.dx;
      ld[o + 1] = l.dy;
      ld[o + 2] = l.dz;
      ld[o + 3] = l.spotOffset;
    }
    for (let i = n; i < (pr.length / 4) | 0; i++) {
      const o = i * 4;
      pr[o + 3] = 0;
      lc[o] = 0;
      lc[o + 1] = 0;
      lc[o + 2] = 0;
    }
  }

  /**
   * Picks up to {@link MAX_DRAW_LIGHTS} lights whose sphere overlaps a draw's bounds.
   * The light array is already sorted nearest-first, so the selection is the nearest set.
   * @param {DrawItem} item Draw item to fill.
   * @returns {void}
   * @private
   */
  _selectLights(item) {
    const n = this._activeLights;
    item.lightCount = 0;
    if (n === 0 || item.material.unlit) return;
    const pr = this._lightPosRadius;
    const cx = item.center[0];
    const cy = item.center[1];
    const cz = item.center[2];
    const r = item.radius;
    let count = 0;
    for (let i = 0; i < n && count < MAX_DRAW_LIGHTS; i++) {
      const o = i * 4;
      const dx = pr[o] - cx;
      const dy = pr[o + 1] - cy;
      const dz = pr[o + 2] - cz;
      const reach = pr[o + 3] + r;
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
      item.lights[count++] = i;
    }
    item.lightCount = count;
  }

  /**
   * Builds the opaque / transparent / shadow-caster lists with frustum culling and sorting.
   * @param {Camera} camera Active camera.
   * @returns {void}
   * @private
   */
  _buildDrawList(camera) {
    const opaque = this._opaque;
    const transparent = this._transparent;
    const casters = this._casters;
    opaque.length = 0;
    transparent.length = 0;
    casters.length = 0;

    const shadowsOn = this._shadowsEnabled && this.quality.cascades > 0;

    // --- static batches -------------------------------------------------------------------
    for (const group of this._staticGroups.values()) {
      if (group.dirty) this._rebuildStaticGroup(group);
      const mat = group.material;
      const casts = shadowsOn && mat.castShadow && (mat.blend === 'opaque' || mat.alphaTest > 0);
      for (let c = 0; c < group.chunks.length; c++) {
        const chunk = group.chunks[c];
        const visible = camera.frustumContainsSphere(chunk.center[0], chunk.center[1], chunk.center[2], chunk.radius);
        if (!visible && !casts) {
          this.stats.culled++;
          continue;
        }
        const item = this._acquireItem();
        if (!item) return;
        item.mesh = chunk.mesh;
        item.material = mat;
        item.instanced = false;
        item.instanceCount = 0;
        item.triangles = chunk.triangles;
        item.matrix.set(_identity);
        item.normalMatrix.set(_identity3);
        item.tint.set(_white);
        item.center.set(chunk.center);
        item.radius = chunk.radius;
        item.emissiveBoost = 1;
        item.castShadow = casts;
        this._pushItem(item, camera, visible, casts, opaque, transparent, casters);
      }
    }

    // --- instanced batches ----------------------------------------------------------------
    for (let b = 0; b < this._instanced.length; b++) {
      const batch = this._instanced[b];
      if (batch.disposed || !batch.visible || batch.count === 0) continue;
      if (batch.dirty) batch.upload();
      const mat = batch.material;
      const casts = shadowsOn && mat.castShadow && (mat.blend === 'opaque' || mat.alphaTest > 0);
      const visible = camera.frustumContainsSphere(batch.center[0], batch.center[1], batch.center[2], batch.radius);
      if (!visible && !casts) {
        this.stats.culled++;
        continue;
      }
      const item = this._acquireItem();
      if (!item) return;
      item.mesh = batch.mesh;
      item.material = mat;
      item.instanced = true;
      item.instanceCount = batch.count;
      item.triangles = batch.mesh.triangleCount * batch.count;
      item.matrix.set(_identity);
      item.normalMatrix.set(_identity3);
      item.tint.set(_white);
      item.center.set(batch.center);
      item.radius = batch.radius;
      item.emissiveBoost = 1;
      item.castShadow = casts;
      this._pushItem(item, camera, visible, casts, opaque, transparent, casters);
    }

    // --- dynamic submits -------------------------------------------------------------------
    for (let d = 0; d < this._dynamic.length; d++) {
      const item = this._dynamic[d];
      const mat = item.material;
      const casts = shadowsOn && item.castShadow && (mat.blend === 'opaque' || mat.alphaTest > 0);
      const visible = camera.frustumContainsSphere(item.center[0], item.center[1], item.center[2], item.radius);
      if (!visible && !casts) {
        this.stats.culled++;
        continue;
      }
      item.castShadow = casts;
      this._pushItem(item, camera, visible, casts, opaque, transparent, casters);
    }

    opaque.sort(compareOpaque);
    transparent.sort(compareTransparent);
  }

  /**
   * Finishes one draw item: depth, program, light selection, list membership.
   * @param {DrawItem} item Item to finish.
   * @param {Camera} camera Active camera.
   * @param {boolean} visible Passed the camera frustum test.
   * @param {boolean} casts Contributes to the shadow pass.
   * @param {DrawItem[]} opaque Opaque list.
   * @param {DrawItem[]} transparent Transparent list.
   * @param {DrawItem[]} casters Shadow caster list.
   * @returns {void}
   * @private
   */
  _pushItem(item, camera, visible, casts, opaque, transparent, casters) {
    if (casts) casters.push(item);
    if (!visible) return;
    const dx = item.center[0] - camera.position[0];
    const dy = item.center[1] - camera.position[1];
    const dz = item.center[2] - camera.position[2];
    item.depth = Math.sqrt(dx * dx + dy * dy + dz * dz) - item.radius + item.material.sortBias;
    item.shader = this._getProgram(item.material, item.instanced);
    item.programIndex = item.shader._index;
    this._selectLights(item);
    if (item.material.queue === QUEUE_TRANSPARENT) transparent.push(item);
    else opaque.push(item);
  }

  /* ---------------------------------------------------------------- shadows */

  /**
   * Renders every cascade. Splits use the practical scheme (lambda 0.65); each cascade fits a
   * texel-snapped ortho box around the bounding sphere of its view-frustum slice, which keeps
   * shadows from swimming while the camera moves.
   * @param {Camera} camera Active camera.
   * @returns {void}
   * @private
   */
  _renderShadows(camera) {
    const gl = this.gl;
    const n = this.quality.cascades;
    const strength = this.sun.shadowStrength * (this.sun.intensity > 0.001 ? 1 : 0);
    this._shadowParams[0] = n > 0 ? strength : 0;
    if (n === 0 || strength <= 0 || this.shadowTargets.length === 0) {
      for (let i = 0; i < 4; i++) {
        this._cascadeSplits[i] = 0;
        this._cascadeTexel[i] = 1;
      }
      return;
    }

    vec3.copy(_lightDir, this.sun.direction);
    if (Math.abs(_lightDir[1]) < 1e-3 && Math.abs(_lightDir[0]) < 1e-3 && Math.abs(_lightDir[2]) < 1e-3) {
      vec3.set(_lightDir, 0, 1, 0);
    }
    vec3.normalize(_lightDir, _lightDir);
    if (Math.abs(_lightDir[1]) > 0.995) vec3.set(_lightUp, 0, 0, 1);
    else vec3.set(_lightUp, 0, 1, 0);

    // Pure light rotation (independent of the camera) so texel snapping is stable.
    vec3.set(_v0, 0, 0, 0);
    vec3.set(_v1, -_lightDir[0], -_lightDir[1], -_lightDir[2]);
    mat4.lookAt(_m0, _v0, _v1, _lightUp);

    const near = camera.near;
    const far = Math.min(camera.far, this.quality.shadowDistance);
    const lambda = 0.65;
    const res = this.quality.shadowRes;

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(2.2, 3.5);

    let splitNear = near;
    for (let i = 0; i < n; i++) {
      const p = (i + 1) / n;
      const logSplit = near * Math.pow(far / near, p);
      const uniSplit = near + (far - near) * p;
      const splitFar = i === n - 1 ? far : lambda * logSplit + (1 - lambda) * uniSplit;

      const radius = this._cascadeSphere(camera, splitNear * 0.98, splitFar, _center);
      const texel = (radius * 2) / res;

      // Snap the cascade centre to whole texels in light space.
      const lx = _m0[0] * _center[0] + _m0[4] * _center[1] + _m0[8] * _center[2] + _m0[12];
      const ly = _m0[1] * _center[0] + _m0[5] * _center[1] + _m0[9] * _center[2] + _m0[13];
      const lz = _m0[2] * _center[0] + _m0[6] * _center[1] + _m0[10] * _center[2] + _m0[14];
      const sx = Math.floor(lx / texel) * texel;
      const sy = Math.floor(ly / texel) * texel;
      const depthPad = Math.max(300, radius * 3);
      mat4.ortho(_m1, sx - radius, sx + radius, sy - radius, sy + radius,
        -lz - radius - depthPad, -lz + radius + depthPad);
      mat4.multiply(_m1, _m1, _m0);
      this._cascadeMatrices.set(_m1, i * 16);
      this._cascadeSplits[i] = splitFar;
      this._cascadeTexel[i] = texel;
      this._cascadeCenters[i * 3] = _center[0];
      this._cascadeCenters[i * 3 + 1] = _center[1];
      this._cascadeCenters[i * 3 + 2] = _center[2];
      this._cascadeRadius[i] = radius;

      const target = this.shadowTargets[i];
      target.bind(true);
      this._drawShadowCasters(i, _m1, _center, radius);
      splitNear = splitFar;
    }

    for (let i = n; i < 4; i++) {
      this._cascadeSplits[i] = this._cascadeSplits[n - 1];
      this._cascadeTexel[i] = this._cascadeTexel[n - 1];
    }

    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(0, 0);
    gl.enable(gl.CULL_FACE);
    this._resetState();
  }

  /**
   * Bounding sphere of a view-frustum slice, in world space.
   * @param {Camera} camera Active camera.
   * @param {number} nearD Slice near distance.
   * @param {number} farD Slice far distance.
   * @param {Float32Array} outCenter Receives the sphere centre.
   * @returns {number} Sphere radius.
   * @private
   */
  _cascadeSphere(camera, nearD, farD, outCenter) {
    const tanHalf = Math.tan(camera.fov * 0.5 * DEG2RAD);
    const f = camera.forward;
    const r = camera.right;
    const u = camera.up;
    const p = camera.position;
    const c = _frustumCorners;
    let k = 0;
    for (let s = 0; s < 2; s++) {
      const d = s === 0 ? nearD : farD;
      const hh = tanHalf * d;
      const hw = hh * camera.aspect;
      for (let j = 0; j < 4; j++) {
        const sx = (j & 1) ? 1 : -1;
        const sy = (j & 2) ? 1 : -1;
        c[k++] = p[0] + f[0] * d + r[0] * hw * sx + u[0] * hh * sy;
        c[k++] = p[1] + f[1] * d + r[1] * hw * sx + u[1] * hh * sy;
        c[k++] = p[2] + f[2] * d + r[2] * hw * sx + u[2] * hh * sy;
      }
    }
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < 8; i++) {
      cx += c[i * 3];
      cy += c[i * 3 + 1];
      cz += c[i * 3 + 2];
    }
    cx /= 8;
    cy /= 8;
    cz /= 8;
    let radiusSq = 0;
    for (let i = 0; i < 8; i++) {
      const dx = c[i * 3] - cx;
      const dy = c[i * 3 + 1] - cy;
      const dz = c[i * 3 + 2] - cz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > radiusSq) radiusSq = d;
    }
    outCenter[0] = cx;
    outCenter[1] = cy;
    outCenter[2] = cz;
    return Math.max(1, Math.ceil(Math.sqrt(radiusSq) * 16) / 16);
  }

  /**
   * Draws every caster overlapping one cascade into the currently bound depth target.
   * @param {number} cascade Cascade index.
   * @param {Float32Array} lightViewProj Cascade matrix.
   * @param {Float32Array} center Cascade sphere centre.
   * @param {number} radius Cascade sphere radius.
   * @returns {void}
   * @private
   */
  _drawShadowCasters(cascade, lightViewProj, center, radius) {
    const casters = this._casters;
    let shader = null;
    let boundMaterial = null;
    const stamp = this._frameId * 8 + cascade;
    for (let i = 0; i < casters.length; i++) {
      const item = casters[i];
      // Reject anything whose sphere misses the cascade cylinder around the light axis.
      const dx = item.center[0] - center[0];
      const dy = item.center[1] - center[1];
      const dz = item.center[2] - center[2];
      const along = dx * _lightDir[0] + dy * _lightDir[1] + dz * _lightDir[2];
      const px = dx - _lightDir[0] * along;
      const py = dy - _lightDir[1] * along;
      const pz = dz - _lightDir[2] * along;
      const reach = radius + item.radius;
      if (px * px + py * py + pz * pz > reach * reach) continue;
      if (along < -(radius + item.radius + Math.max(300, radius * 3))) continue;

      const mat = item.material;
      const next = this._getShadowProgram(mat, item.instanced);
      if (next !== shader) {
        shader = next;
        shader.use();
        boundMaterial = null;
        shader._cascadeStamp = -1;
      }
      if (shader._cascadeStamp !== stamp) {
        shader._cascadeStamp = stamp;
        shader.setMat4('uLightViewProj', lightViewProj);
      }
      if (boundMaterial !== mat) {
        boundMaterial = mat;
        bindShadowMaterialUniforms(shader, mat);
        const gl = this.gl;
        if (mat.doubleSided) gl.disable(gl.CULL_FACE);
        else gl.enable(gl.CULL_FACE);
      }
      if (!item.instanced) shader.setMat4('uModel', item.matrix);
      item.mesh.draw(item.instanced ? item.instanceCount : 0);
      this.stats.shadowDrawCalls++;
    }
    this._state.program = null;
    this._state.cull = -1;
  }

  /* ------------------------------------------------------------- draw passes */

  /**
   * Invalidates the cached GL render state after foreign code (sky / post / particles) ran.
   * @returns {void}
   * @private
   */
  _resetState() {
    const st = this._state;
    st.blend = -1;
    st.depthWrite = -1;
    st.depthTest = -1;
    st.cull = -1;
    st.program = null;
    st.material = null;
  }

  /**
   * Uploads the frame-constant uniforms into a program (once per program per frame).
   * @param {Shader} shader Program in use.
   * @param {Camera} camera Camera of the current frame.
   * @returns {void}
   * @private
   */
  _bindFrameUniforms(shader, camera) {
    if (shader._frameStamp === this._frameId) return;
    shader._frameStamp = this._frameId;

    shader.setMat4('uViewProj', camera.viewProj);
    shader.setVec3v('uCameraPos', camera.position);
    shader.setVec3v('uCameraForward', camera.forward);
    shader.setFloat('uTime', this.time);
    shader.setVec3v('uSunDirection', this.sun.direction);
    shader.setVec3v('uSunColor', this._sunRadiance);
    shader.setVec3v('uAmbientSky', this.sun.ambientSky);
    shader.setVec3v('uAmbientGround', this.sun.ambientGround);
    shader.setVec3v('uFogColor', this.fog.color);
    shader.setVec4('uFogParams', this.fog.density, this.fog.heightFalloff, this.fog.skyBlend, 0);
    shader.setFloat('uNightFactor', this.nightFactor);
    shader.setVec2('uGlobalWet', this.wet[0], this.wet[1]);
    shader.setVec2('uResolution', this._resolution[0], this._resolution[1]);

    const n = this.quality.cascades;
    if (n > 0) {
      shader.setVec4v('uShadowParams', this._shadowParams);
      shader.setMat4Array('uLightViewProj[0]', this._cascadeMatrices.subarray(0, n * 16));
      shader.setFloatArray('uCascadeSplit[0]', this._cascadeSplits.subarray(0, n));
      shader.setFloatArray('uCascadeTexel[0]', this._cascadeTexel.subarray(0, n));
      for (let i = 0; i < n && i < this.shadowTargets.length; i++) {
        shader.setTexture('uShadowMap' + i, this.shadowTargets[i].depthTex, TEXTURE_UNITS.SHADOW0 + i);
      }
    }

    if (this.quality.maxPointLights > 0) {
      const count = this._shaderCtx.pointLights * 4;
      shader.setVec4Array('uLightPosRadius[0]', this._lightPosRadius.subarray(0, count));
      shader.setVec4Array('uLightColor[0]', this._lightColor.subarray(0, count));
      shader.setVec4Array('uLightDir[0]', this._lightDirCone.subarray(0, count));
    }

    if (this._shaderCtx.ssao && this.postfx && this.postfx.aoTexture) {
      shader.setTexture('uAoTex', this.postfx.aoTexture, TEXTURE_UNITS.AO);
    }
  }

  /**
   * Applies the blend / depth / cull state a material asks for, with redundancy filtering.
   * @param {Object} mat Material.
   * @returns {void}
   * @private
   */
  _applyMaterialState(mat) {
    const gl = this.gl;
    const st = this._state;
    const blend = mat.blend === 'opaque' ? 0 : (mat.blend === 'add' ? 2 : 1);
    if (st.blend !== blend) {
      if (blend === 0) {
        gl.disable(gl.BLEND);
      } else {
        gl.enable(gl.BLEND);
        if (blend === 2) gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      }
      st.blend = blend;
    }
    const depthWrite = mat.depthWrite ? 1 : 0;
    if (st.depthWrite !== depthWrite) {
      gl.depthMask(!!depthWrite);
      st.depthWrite = depthWrite;
    }
    const depthTest = mat.depthTest ? 1 : 0;
    if (st.depthTest !== depthTest) {
      if (depthTest) gl.enable(gl.DEPTH_TEST);
      else gl.disable(gl.DEPTH_TEST);
      st.depthTest = depthTest;
    }
    const cull = mat.doubleSided ? 0 : 1;
    if (st.cull !== cull) {
      if (cull) gl.enable(gl.CULL_FACE);
      else gl.disable(gl.CULL_FACE);
      st.cull = cull;
    }
  }

  /**
   * Issues one sorted draw list.
   * @param {DrawItem[]} list Sorted draw items.
   * @returns {void}
   * @private
   */
  _drawList(list) {
    if (list.length === 0) return;
    const camera = this._camera;
    const st = this._state;
    let shader = null;
    let material = null;
    let materialVersion = -1;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (item.shader !== shader) {
        shader = item.shader;
        shader.use();
        this._bindFrameUniforms(shader, camera);
        material = null;
        materialVersion = -1;
      }
      const mat = item.material;
      if (mat !== material || mat.version !== materialVersion) {
        material = mat;
        materialVersion = mat.version;
        bindMaterialUniforms(shader, mat);
        this._applyMaterialState(mat);
      }
      if (!item.instanced) {
        shader.setMat4('uModel', item.matrix);
        shader.setMat3('uNormalMatrix', item.normalMatrix);
        shader.setVec4v('uTint', item.tint);
      }
      shader.setFloat('uEmissiveBoost', item.emissiveBoost);
      if (this.quality.maxPointLights > 0) {
        shader.setInt('uLightCount', item.lightCount);
        if (item.lightCount > 0) shader.setIntArray('uLightIndex[0]', item.lights);
      }
      item.mesh.draw(item.instanced ? item.instanceCount : 0);
      this.stats.drawCalls++;
      this.stats.triangles += item.triangles;
    }
    st.program = shader;
  }

  /**
   * Tonemapped blit used only when `render/postfx.js` could not be constructed, so the game
   * still displays a correct (if plain) image.
   * @returns {void}
   * @private
   */
  _blitFallback() {
    const gl = this.gl;
    if (!this._blitShader) {
      this._blitShader = new Shader(gl, FULLSCREEN_VERTEX_SOURCE, BLIT_FRAGMENT_SOURCE, {}, 'blit');
    }
    this._blitShader.use();
    this._blitShader.setTexture('uSource', this.hdr.color(0), 0);
    this._blitShader.setFloat('uExposure', this.exposure);
    drawFullscreen(gl);
    this.stats.drawCalls++;
  }

  /**
   * Releases every GPU resource owned by the renderer.
   * @returns {void}
   */
  dispose() {
    this.clearWorld();
    this._disposeShaderCache();
    if (this._blitShader) this._blitShader.dispose();
    this._blitShader = null;
    for (let i = 0; i < this.shadowTargets.length; i++) this.shadowTargets[i].dispose();
    this.shadowTargets.length = 0;
    if (this.hdr) this.hdr.dispose();
    this.hdr = null;
    if (this.particles && this.particles.dispose) this.particles.dispose();
    if (this.postfx && this.postfx.dispose) this.postfx.dispose();
    if (this.sky && this.sky.dispose) this.sky.dispose();
  }
}

/**
 * Opaque ordering: program, then material, then front-to-back.
 * @param {DrawItem} a Left item.
 * @param {DrawItem} b Right item.
 * @returns {number} Comparator result.
 */
function compareOpaque(a, b) {
  if (a.programIndex !== b.programIndex) return a.programIndex - b.programIndex;
  if (a.material.id !== b.material.id) return a.material.id - b.material.id;
  return a.depth - b.depth;
}

/**
 * Transparent ordering: strictly back-to-front.
 * @param {DrawItem} a Left item.
 * @param {DrawItem} b Right item.
 * @returns {number} Comparator result.
 */
function compareTransparent(a, b) {
  return b.depth - a.depth;
}
