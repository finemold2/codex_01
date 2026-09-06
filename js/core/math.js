/**
 * NEON CITY - core math library.
 *
 * gl-matrix compatible, out-parameter style: every function that takes an `out`
 * argument writes into it and returns it so calls can be chained.
 *
 * Conventions (see docs/ARCHITECTURE.md):
 *  - Matrices are column-major `Float32Array(16)`; `m[12..14]` is the translation.
 *  - `mat3` is a column-major `Float32Array(9)`.
 *  - Vectors are `Float32Array(2|3|4)`; quaternions are `Float32Array(4)` laid out `[x, y, z, w]`.
 *  - Units are meters, seconds and radians. Y is up, the ground plane is y = 0.
 *  - `yaw = 0` faces -Z; ground forward = `[-sin(yaw), 0, -cos(yaw)]`, right = `[cos(yaw), 0, -sin(yaw)]`.
 *  - Projection matrices are right handed with a [-1, 1] depth range (standard WebGL).
 *
 * The module allocates nothing except in `create`/`clone`/`fromValues` helpers, so it is
 * safe to call from hot loops.
 *
 * @module core/math
 */

/** Epsilon used for zero tests and degenerate-case guards. @type {number} */
export const EPS = 1e-6;

/** Pi. @type {number} */
export const PI = Math.PI;

/** Two pi (a full turn in radians). @type {number} */
export const TAU = Math.PI * 2;

/** Multiplier converting degrees to radians. @type {number} */
export const DEG2RAD = Math.PI / 180;

/** Multiplier converting radians to degrees. @type {number} */
export const RAD2DEG = 180 / Math.PI;

/**
 * Clamps a value into the inclusive range [lo, hi].
 * @param {number} v Value.
 * @param {number} lo Lower bound.
 * @param {number} hi Upper bound.
 * @returns {number} The clamped value.
 */
export function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

/**
 * Linear interpolation between a and b. `t` is not clamped.
 * @param {number} a Start value.
 * @param {number} b End value.
 * @param {number} t Interpolation factor.
 * @returns {number} Interpolated value.
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Hermite smoothstep. Returns 0 below e0, 1 above e1 and a smooth ramp between.
 * @param {number} e0 Lower edge.
 * @param {number} e1 Upper edge.
 * @param {number} x Sample position.
 * @returns {number} Value in [0, 1].
 */
export function smoothstep(e0, e1, x) {
  const d = e1 - e0;
  if (d > -EPS && d < EPS) return x < e0 ? 0 : 1;
  let t = (x - e0) / d;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential approach: `b + (a - b) * exp(-lambda * dt)`.
 * Larger `lambda` converges faster. Equivalent to a lerp whose factor is corrected for `dt`.
 * @param {number} a Current value.
 * @param {number} b Target value.
 * @param {number} lambda Convergence rate (1/seconds).
 * @param {number} dt Delta time in seconds.
 * @returns {number} The damped value.
 */
export function damp(a, b, lambda, dt) {
  return b + (a - b) * Math.exp(-lambda * dt);
}

/**
 * Wraps an angle into the range (-PI, PI].
 * @param {number} a Angle in radians.
 * @returns {number} Equivalent angle in (-PI, PI].
 */
export function wrapAngle(a) {
  let x = a % TAU;
  if (x <= -PI) x += TAU;
  else if (x > PI) x -= TAU;
  return x;
}

/**
 * Interpolates between two angles along the shortest path across the -PI/PI seam.
 * @param {number} a Start angle in radians.
 * @param {number} b End angle in radians.
 * @param {number} t Interpolation factor (not clamped).
 * @returns {number} Interpolated angle wrapped into (-PI, PI].
 */
export function angleLerp(a, b, t) {
  return wrapAngle(a + wrapAngle(b - a) * t);
}

/**
 * Frame-rate independent angular damping along the shortest path.
 * @param {number} a Current angle in radians.
 * @param {number} b Target angle in radians.
 * @param {number} lambda Convergence rate (1/seconds).
 * @param {number} dt Delta time in seconds.
 * @returns {number} The damped angle wrapped into (-PI, PI].
 */
export function angleDamp(a, b, lambda, dt) {
  const d = wrapAngle(b - a);
  return wrapAngle(a + d * (1 - Math.exp(-lambda * dt)));
}

/**
 * Moves `a` towards `b` by at most `maxDelta` (never overshoots).
 * @param {number} a Current value.
 * @param {number} b Target value.
 * @param {number} maxDelta Maximum absolute step.
 * @returns {number} The stepped value.
 */
export function moveTowards(a, b, maxDelta) {
  const d = b - a;
  if (d <= maxDelta && d >= -maxDelta) return b;
  return a + (d > 0 ? maxDelta : -maxDelta);
}

/**
 * Draws a uniformly distributed number in [a, b) from a seeded generator.
 * @param {Rand|function():number} rng A `Rand` instance or a plain `() => [0,1)` function.
 * @param {number} a Lower bound.
 * @param {number} b Upper bound.
 * @returns {number} Random value in [a, b).
 */
export function randRange(rng, a, b) {
  const u = typeof rng === 'function' ? rng() : rng.next();
  return a + (b - a) * u;
}

/* ------------------------------------------------------------------------- */
/* vec2                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * 2D vector helpers operating on `Float32Array(2)` (any indexable of length >= 2 works).
 * @namespace vec2
 */
export const vec2 = {
  /**
   * Creates a zeroed 2D vector.
   * @returns {Float32Array} New vector.
   */
  create() {
    return new Float32Array(2);
  },

  /**
   * Creates a 2D vector from components.
   * @param {number} x X component.
   * @param {number} y Y component.
   * @returns {Float32Array} New vector.
   */
  fromValues(x, y) {
    const o = new Float32Array(2);
    o[0] = x; o[1] = y;
    return o;
  },

  /**
   * Sets the components of a vector.
   * @param {Float32Array} out Target.
   * @param {number} x X component.
   * @param {number} y Y component.
   * @returns {Float32Array} out
   */
  set(out, x, y) {
    out[0] = x; out[1] = y;
    return out;
  },

  /**
   * Copies `a` into `out`.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source.
   * @returns {Float32Array} out
   */
  copy(out, a) {
    out[0] = a[0]; out[1] = a[1];
    return out;
  },

  /**
   * Allocates a copy of `a`.
   * @param {ArrayLike<number>} a Source.
   * @returns {Float32Array} New vector.
   */
  clone(a) {
    const o = new Float32Array(2);
    o[0] = a[0]; o[1] = a[1];
    return o;
  },

  /**
   * out = a + b
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {Float32Array} out
   */
  add(out, a, b) {
    out[0] = a[0] + b[0]; out[1] = a[1] + b[1];
    return out;
  },

  /**
   * out = a - b
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {Float32Array} out
   */
  sub(out, a, b) {
    out[0] = a[0] - b[0]; out[1] = a[1] - b[1];
    return out;
  },

  /**
   * Component-wise multiply.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {Float32Array} out
   */
  mul(out, a, b) {
    out[0] = a[0] * b[0]; out[1] = a[1] * b[1];
    return out;
  },

  /**
   * out = a * s
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source vector.
   * @param {number} s Scalar.
   * @returns {Float32Array} out
   */
  scale(out, a, s) {
    out[0] = a[0] * s; out[1] = a[1] * s;
    return out;
  },

  /**
   * out = a + b * s
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Base vector.
   * @param {ArrayLike<number>} b Vector to scale and add.
   * @param {number} s Scalar.
   * @returns {Float32Array} out
   */
  scaleAndAdd(out, a, b, s) {
    out[0] = a[0] + b[0] * s; out[1] = a[1] + b[1] * s;
    return out;
  },

  /**
   * Vector length.
   * @param {ArrayLike<number>} a Vector.
   * @returns {number} Euclidean length.
   */
  len(a) {
    return Math.sqrt(a[0] * a[0] + a[1] * a[1]);
  },

  /**
   * Squared vector length.
   * @param {ArrayLike<number>} a Vector.
   * @returns {number} Squared length.
   */
  sqrLen(a) {
    return a[0] * a[0] + a[1] * a[1];
  },

  /**
   * Distance between two points.
   * @param {ArrayLike<number>} a First point.
   * @param {ArrayLike<number>} b Second point.
   * @returns {number} Distance.
   */
  dist(a, b) {
    const x = b[0] - a[0], y = b[1] - a[1];
    return Math.sqrt(x * x + y * y);
  },

  /**
   * Squared distance between two points.
   * @param {ArrayLike<number>} a First point.
   * @param {ArrayLike<number>} b Second point.
   * @returns {number} Squared distance.
   */
  sqrDist(a, b) {
    const x = b[0] - a[0], y = b[1] - a[1];
    return x * x + y * y;
  },

  /**
   * Normalizes `a`. A zero-length input yields a zero vector (never NaN).
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source vector.
   * @returns {Float32Array} out
   */
  normalize(out, a) {
    const x = a[0], y = a[1];
    let l = x * x + y * y;
    if (l > 0) {
      l = 1 / Math.sqrt(l);
      out[0] = x * l; out[1] = y * l;
    } else {
      out[0] = 0; out[1] = 0;
    }
    return out;
  },

  /**
   * Dot product.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {number} Dot product.
   */
  dot(a, b) {
    return a[0] * b[0] + a[1] * b[1];
  },

  /**
   * 2D scalar cross product (`a.x * b.y - a.y * b.x`), the signed area of the parallelogram.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {number} Signed cross product.
   */
  cross2(a, b) {
    return a[0] * b[1] - a[1] * b[0];
  },

  /**
   * Component-wise linear interpolation.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Start vector.
   * @param {ArrayLike<number>} b End vector.
   * @param {number} t Interpolation factor.
   * @returns {Float32Array} out
   */
  lerp(out, a, b, t) {
    out[0] = a[0] + (b[0] - a[0]) * t;
    out[1] = a[1] + (b[1] - a[1]) * t;
    return out;
  },

  /**
   * Rotates `a` counter-clockwise by `rad`, optionally around a pivot.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source vector.
   * @param {number} rad Angle in radians.
   * @param {ArrayLike<number>|null} [origin=null] Optional pivot point.
   * @returns {Float32Array} out
   */
  rotate(out, a, rad, origin) {
    const ox = origin ? origin[0] : 0;
    const oy = origin ? origin[1] : 0;
    const x = a[0] - ox, y = a[1] - oy;
    const s = Math.sin(rad), c = Math.cos(rad);
    out[0] = x * c - y * s + ox;
    out[1] = x * s + y * c + oy;
    return out;
  },

  /**
   * With one argument: the heading of `a` as `atan2(y, x)`.
   * With two: the signed angle from `a` to `b` in (-PI, PI].
   * @param {ArrayLike<number>} a First vector.
   * @param {ArrayLike<number>} [b] Optional second vector.
   * @returns {number} Angle in radians.
   */
  angle(a, b) {
    if (b === undefined) return Math.atan2(a[1], a[0]);
    return Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
  },

  /**
   * out = -a
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source vector.
   * @returns {Float32Array} out
   */
  negate(out, a) {
    out[0] = -a[0]; out[1] = -a[1];
    return out;
  },

  /**
   * Sets all components to zero.
   * @param {Float32Array} out Target.
   * @returns {Float32Array} out
   */
  zero(out) {
    out[0] = 0; out[1] = 0;
    return out;
  }
};

/* gl-matrix compatibility aliases. */
vec2.subtract = vec2.sub;
vec2.multiply = vec2.mul;
vec2.length = vec2.len;
vec2.squaredLength = vec2.sqrLen;
vec2.distance = vec2.dist;
vec2.squaredDistance = vec2.sqrDist;

/* ------------------------------------------------------------------------- */
/* vec3                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * 3D vector helpers operating on `Float32Array(3)` (any indexable of length >= 3 works).
 * @namespace vec3
 */
export const vec3 = {
  /**
   * Creates a zeroed 3D vector.
   * @returns {Float32Array} New vector.
   */
  create() {
    return new Float32Array(3);
  },

  /**
   * Creates a 3D vector from components.
   * @param {number} x X component.
   * @param {number} y Y component.
   * @param {number} z Z component.
   * @returns {Float32Array} New vector.
   */
  fromValues(x, y, z) {
    const o = new Float32Array(3);
    o[0] = x; o[1] = y; o[2] = z;
    return o;
  },

  /**
   * Sets the components of a vector.
   * @param {Float32Array} out Target.
   * @param {number} x X component.
   * @param {number} y Y component.
   * @param {number} z Z component.
   * @returns {Float32Array} out
   */
  set(out, x, y, z) {
    out[0] = x; out[1] = y; out[2] = z;
    return out;
  },

  /**
   * Copies `a` into `out`.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source.
   * @returns {Float32Array} out
   */
  copy(out, a) {
    out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
    return out;
  },

  /**
   * Allocates a copy of `a`.
   * @param {ArrayLike<number>} a Source.
   * @returns {Float32Array} New vector.
   */
  clone(a) {
    const o = new Float32Array(3);
    o[0] = a[0]; o[1] = a[1]; o[2] = a[2];
    return o;
  },

  /**
   * out = a + b
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {Float32Array} out
   */
  add(out, a, b) {
    out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2];
    return out;
  },

  /**
   * out = a - b
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {Float32Array} out
   */
  sub(out, a, b) {
    out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2];
    return out;
  },

  /**
   * Component-wise multiply.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {Float32Array} out
   */
  mul(out, a, b) {
    out[0] = a[0] * b[0]; out[1] = a[1] * b[1]; out[2] = a[2] * b[2];
    return out;
  },

  /**
   * Component-wise divide. Division by zero yields 0 for that component (never NaN/Infinity).
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Numerator.
   * @param {ArrayLike<number>} b Denominator.
   * @returns {Float32Array} out
   */
  div(out, a, b) {
    out[0] = b[0] !== 0 ? a[0] / b[0] : 0;
    out[1] = b[1] !== 0 ? a[1] / b[1] : 0;
    out[2] = b[2] !== 0 ? a[2] / b[2] : 0;
    return out;
  },

  /**
   * out = a * s
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source vector.
   * @param {number} s Scalar.
   * @returns {Float32Array} out
   */
  scale(out, a, s) {
    out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s;
    return out;
  },

  /**
   * out = a + b * s
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Base vector.
   * @param {ArrayLike<number>} b Vector to scale and add.
   * @param {number} s Scalar.
   * @returns {Float32Array} out
   */
  scaleAndAdd(out, a, b, s) {
    out[0] = a[0] + b[0] * s;
    out[1] = a[1] + b[1] * s;
    out[2] = a[2] + b[2] * s;
    return out;
  },

  /**
   * Vector length.
   * @param {ArrayLike<number>} a Vector.
   * @returns {number} Euclidean length.
   */
  len(a) {
    return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  },

  /**
   * Squared vector length.
   * @param {ArrayLike<number>} a Vector.
   * @returns {number} Squared length.
   */
  sqrLen(a) {
    return a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
  },

  /**
   * Distance between two points.
   * @param {ArrayLike<number>} a First point.
   * @param {ArrayLike<number>} b Second point.
   * @returns {number} Distance.
   */
  dist(a, b) {
    const x = b[0] - a[0], y = b[1] - a[1], z = b[2] - a[2];
    return Math.sqrt(x * x + y * y + z * z);
  },

  /**
   * Squared distance between two points.
   * @param {ArrayLike<number>} a First point.
   * @param {ArrayLike<number>} b Second point.
   * @returns {number} Squared distance.
   */
  sqrDist(a, b) {
    const x = b[0] - a[0], y = b[1] - a[1], z = b[2] - a[2];
    return x * x + y * y + z * z;
  },

  /**
   * Normalizes `a`. A zero-length input yields a zero vector (never NaN).
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source vector.
   * @returns {Float32Array} out
   */
  normalize(out, a) {
    const x = a[0], y = a[1], z = a[2];
    let l = x * x + y * y + z * z;
    if (l > 0) {
      l = 1 / Math.sqrt(l);
      out[0] = x * l; out[1] = y * l; out[2] = z * l;
    } else {
      out[0] = 0; out[1] = 0; out[2] = 0;
    }
    return out;
  },

  /**
   * Dot product.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {number} Dot product.
   */
  dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  },

  /**
   * Cross product `a x b`. Safe when `out` aliases `a` or `b`.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {Float32Array} out
   */
  cross(out, a, b) {
    const ax = a[0], ay = a[1], az = a[2];
    const bx = b[0], by = b[1], bz = b[2];
    out[0] = ay * bz - az * by;
    out[1] = az * bx - ax * bz;
    out[2] = ax * by - ay * bx;
    return out;
  },

  /**
   * Component-wise linear interpolation.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Start vector.
   * @param {ArrayLike<number>} b End vector.
   * @param {number} t Interpolation factor.
   * @returns {Float32Array} out
   */
  lerp(out, a, b, t) {
    out[0] = a[0] + (b[0] - a[0]) * t;
    out[1] = a[1] + (b[1] - a[1]) * t;
    out[2] = a[2] + (b[2] - a[2]) * t;
    return out;
  },

  /**
   * out = -a
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source vector.
   * @returns {Float32Array} out
   */
  negate(out, a) {
    out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2];
    return out;
  },

  /**
   * Component-wise minimum.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {Float32Array} out
   */
  min(out, a, b) {
    out[0] = a[0] < b[0] ? a[0] : b[0];
    out[1] = a[1] < b[1] ? a[1] : b[1];
    out[2] = a[2] < b[2] ? a[2] : b[2];
    return out;
  },

  /**
   * Component-wise maximum.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {Float32Array} out
   */
  max(out, a, b) {
    out[0] = a[0] > b[0] ? a[0] : b[0];
    out[1] = a[1] > b[1] ? a[1] : b[1];
    out[2] = a[2] > b[2] ? a[2] : b[2];
    return out;
  },

  /**
   * Sets all components to zero.
   * @param {Float32Array} out Target.
   * @returns {Float32Array} out
   */
  zero(out) {
    out[0] = 0; out[1] = 0; out[2] = 0;
    return out;
  },

  /**
   * Transforms a point by a column-major mat4 (translation applied, perspective divide performed).
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Point to transform.
   * @param {ArrayLike<number>} m Column-major 4x4 matrix.
   * @returns {Float32Array} out
   */
  transformMat4(out, a, m) {
    const x = a[0], y = a[1], z = a[2];
    let w = m[3] * x + m[7] * y + m[11] * z + m[15];
    w = w || 1;
    out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
    return out;
  },

  /**
   * Transforms a direction by a column-major mat4 (w = 0: translation ignored, no divide).
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Direction to transform.
   * @param {ArrayLike<number>} m Column-major 4x4 matrix.
   * @returns {Float32Array} out
   */
  transformMat4Dir(out, a, m) {
    const x = a[0], y = a[1], z = a[2];
    out[0] = m[0] * x + m[4] * y + m[8] * z;
    out[1] = m[1] * x + m[5] * y + m[9] * z;
    out[2] = m[2] * x + m[6] * y + m[10] * z;
    return out;
  },

  /**
   * Rotates a vector by a quaternion.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Vector to rotate.
   * @param {ArrayLike<number>} q Quaternion [x, y, z, w].
   * @returns {Float32Array} out
   */
  transformQuat(out, a, q) {
    const x = a[0], y = a[1], z = a[2];
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    // t = 2 * cross(q.xyz, v)
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);
    // v + qw * t + cross(q.xyz, t)
    out[0] = x + qw * tx + qy * tz - qz * ty;
    out[1] = y + qw * ty + qz * tx - qx * tz;
    out[2] = z + qw * tz + qx * ty - qy * tx;
    return out;
  },

  /**
   * Rotates a vector around the Y axis, optionally around a pivot point.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Vector to rotate.
   * @param {number} rad Angle in radians (matches `mat4.rotateY`).
   * @param {ArrayLike<number>|null} [origin=null] Optional pivot point.
   * @returns {Float32Array} out
   */
  rotateY(out, a, rad, origin) {
    const ox = origin ? origin[0] : 0;
    const oy = origin ? origin[1] : 0;
    const oz = origin ? origin[2] : 0;
    const x = a[0] - ox, y = a[1] - oy, z = a[2] - oz;
    const s = Math.sin(rad), c = Math.cos(rad);
    out[0] = x * c + z * s + ox;
    out[1] = y + oy;
    out[2] = -x * s + z * c + oz;
    return out;
  },

  /**
   * Component-wise floor.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source vector.
   * @returns {Float32Array} out
   */
  floor(out, a) {
    out[0] = Math.floor(a[0]);
    out[1] = Math.floor(a[1]);
    out[2] = Math.floor(a[2]);
    return out;
  },

  /**
   * Approximate component-wise equality.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @param {number} [eps=EPS] Tolerance.
   * @returns {boolean} True when every component differs by less than `eps`.
   */
  equals(a, b, eps) {
    const e = eps === undefined ? EPS : eps;
    return Math.abs(a[0] - b[0]) < e && Math.abs(a[1] - b[1]) < e && Math.abs(a[2] - b[2]) < e;
  }
};

/* gl-matrix compatibility aliases. */
vec3.subtract = vec3.sub;
vec3.multiply = vec3.mul;
vec3.divide = vec3.div;
vec3.length = vec3.len;
vec3.squaredLength = vec3.sqrLen;
vec3.distance = vec3.dist;
vec3.squaredDistance = vec3.sqrDist;

/* ------------------------------------------------------------------------- */
/* vec4                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * 4D vector helpers operating on `Float32Array(4)`.
 * @namespace vec4
 */
export const vec4 = {
  /**
   * Creates a zeroed 4D vector.
   * @returns {Float32Array} New vector.
   */
  create() {
    return new Float32Array(4);
  },

  /**
   * Creates a 4D vector from components.
   * @param {number} x X component.
   * @param {number} y Y component.
   * @param {number} z Z component.
   * @param {number} w W component.
   * @returns {Float32Array} New vector.
   */
  fromValues(x, y, z, w) {
    const o = new Float32Array(4);
    o[0] = x; o[1] = y; o[2] = z; o[3] = w;
    return o;
  },

  /**
   * Sets the components of a vector.
   * @param {Float32Array} out Target.
   * @param {number} x X component.
   * @param {number} y Y component.
   * @param {number} z Z component.
   * @param {number} w W component.
   * @returns {Float32Array} out
   */
  set(out, x, y, z, w) {
    out[0] = x; out[1] = y; out[2] = z; out[3] = w;
    return out;
  },

  /**
   * Copies `a` into `out`.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source.
   * @returns {Float32Array} out
   */
  copy(out, a) {
    out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
    return out;
  },

  /**
   * out = a * s
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source vector.
   * @param {number} s Scalar.
   * @returns {Float32Array} out
   */
  scale(out, a, s) {
    out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s; out[3] = a[3] * s;
    return out;
  },

  /**
   * out = a + b
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {Float32Array} out
   */
  add(out, a, b) {
    out[0] = a[0] + b[0]; out[1] = a[1] + b[1];
    out[2] = a[2] + b[2]; out[3] = a[3] + b[3];
    return out;
  },

  /**
   * Transforms a 4D vector by a column-major mat4 (no perspective divide).
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Vector to transform.
   * @param {ArrayLike<number>} m Column-major 4x4 matrix.
   * @returns {Float32Array} out
   */
  transformMat4(out, a, m) {
    const x = a[0], y = a[1], z = a[2], w = a[3];
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
    out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
    return out;
  }
};

/* ------------------------------------------------------------------------- */
/* quat                                                                       */
/* ------------------------------------------------------------------------- */

/** Scratch 3x3 basis used by `quat.fromMat4`. @type {Float32Array} */
const QUAT_BASIS = new Float32Array(9);

/**
 * Quaternion helpers. Layout is `[x, y, z, w]` in a `Float32Array(4)`.
 * @namespace quat
 */
export const quat = {
  /**
   * Creates an identity quaternion.
   * @returns {Float32Array} New quaternion [0, 0, 0, 1].
   */
  create() {
    const o = new Float32Array(4);
    o[3] = 1;
    return o;
  },

  /**
   * Resets a quaternion to identity.
   * @param {Float32Array} out Target.
   * @returns {Float32Array} out
   */
  identity(out) {
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
    return out;
  },

  /**
   * Copies `a` into `out`.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source.
   * @returns {Float32Array} out
   */
  copy(out, a) {
    out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
    return out;
  },

  /**
   * Builds a rotation of `rad` radians around `axis` (axis is normalized internally).
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} axis Rotation axis.
   * @param {number} rad Angle in radians.
   * @returns {Float32Array} out
   */
  setAxisAngle(out, axis, rad) {
    let ax = axis[0], ay = axis[1], az = axis[2];
    let l = ax * ax + ay * ay + az * az;
    if (l > 0) {
      l = 1 / Math.sqrt(l);
      ax *= l; ay *= l; az *= l;
    } else {
      out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
      return out;
    }
    const h = rad * 0.5;
    const s = Math.sin(h);
    out[0] = ax * s; out[1] = ay * s; out[2] = az * s;
    out[3] = Math.cos(h);
    return out;
  },

  /**
   * Builds a quaternion from Euler angles in YXZ order (yaw, then pitch, then roll),
   * i.e. the same rotation as `Ry(yaw) * Rx(pitch) * Rz(roll)`.
   * Angles are in RADIANS (unlike gl-matrix, which uses degrees).
   * @param {Float32Array} out Target.
   * @param {number} yaw Rotation around Y in radians.
   * @param {number} pitch Rotation around X in radians.
   * @param {number} roll Rotation around Z in radians.
   * @returns {Float32Array} out
   */
  fromEuler(out, yaw, pitch, roll) {
    const hy = yaw * 0.5, hx = pitch * 0.5, hz = roll * 0.5;
    const cy = Math.cos(hy), sy = Math.sin(hy);
    const cx = Math.cos(hx), sx = Math.sin(hx);
    const cz = Math.cos(hz), sz = Math.sin(hz);
    out[0] = sx * cy * cz + cx * sy * sz;
    out[1] = cx * sy * cz - sx * cy * sz;
    out[2] = cx * cy * sz - sx * sy * cz;
    out[3] = cx * cy * cz + sx * sy * sz;
    return out;
  },

  /**
   * Quaternion product `a * b` (applies `b` first, then `a`). Safe when `out` aliases an input.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {Float32Array} out
   */
  multiply(out, a, b) {
    const ax = a[0], ay = a[1], az = a[2], aw = a[3];
    const bx = b[0], by = b[1], bz = b[2], bw = b[3];
    out[0] = ax * bw + aw * bx + ay * bz - az * by;
    out[1] = ay * bw + aw * by + az * bx - ax * bz;
    out[2] = az * bw + aw * bz + ax * by - ay * bx;
    out[3] = aw * bw - ax * bx - ay * by - az * bz;
    return out;
  },

  /**
   * Normalizes a quaternion. A zero-length input yields identity (never NaN).
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source quaternion.
   * @returns {Float32Array} out
   */
  normalize(out, a) {
    const x = a[0], y = a[1], z = a[2], w = a[3];
    let l = x * x + y * y + z * z + w * w;
    if (l > 0) {
      l = 1 / Math.sqrt(l);
      out[0] = x * l; out[1] = y * l; out[2] = z * l; out[3] = w * l;
    } else {
      out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
    }
    return out;
  },

  /**
   * Spherical linear interpolation along the shortest arc.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Start quaternion.
   * @param {ArrayLike<number>} b End quaternion.
   * @param {number} t Interpolation factor.
   * @returns {Float32Array} out
   */
  slerp(out, a, b, t) {
    const ax = a[0], ay = a[1], az = a[2], aw = a[3];
    let bx = b[0], by = b[1], bz = b[2], bw = b[3];
    let cosom = ax * bx + ay * by + az * bz + aw * bw;
    if (cosom < 0) {
      cosom = -cosom;
      bx = -bx; by = -by; bz = -bz; bw = -bw;
    }
    let scale0, scale1;
    if (1 - cosom > EPS) {
      const omega = Math.acos(cosom);
      const sinom = Math.sin(omega);
      scale0 = Math.sin((1 - t) * omega) / sinom;
      scale1 = Math.sin(t * omega) / sinom;
    } else {
      // Nearly parallel: fall back to linear interpolation.
      scale0 = 1 - t;
      scale1 = t;
    }
    out[0] = scale0 * ax + scale1 * bx;
    out[1] = scale0 * ay + scale1 * by;
    out[2] = scale0 * az + scale1 * bz;
    out[3] = scale0 * aw + scale1 * bw;
    return out;
  },

  /**
   * Conjugate (inverse for unit quaternions).
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source quaternion.
   * @returns {Float32Array} out
   */
  conjugate(out, a) {
    out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2]; out[3] = a[3];
    return out;
  },

  /**
   * Rotates a vector by a quaternion (`out = q * v * q^-1`).
   * @param {Float32Array} out Target vec3.
   * @param {ArrayLike<number>} q Quaternion.
   * @param {ArrayLike<number>} v Vector to rotate.
   * @returns {Float32Array} out
   */
  rotateVec3(out, q, v) {
    return vec3.transformQuat(out, v, q);
  },

  /**
   * Extracts the rotation of a column-major mat4. Non-uniform scale in the matrix is removed
   * by normalizing the basis vectors first.
   * @param {Float32Array} out Target quaternion.
   * @param {ArrayLike<number>} m Column-major 4x4 matrix.
   * @returns {Float32Array} out
   */
  fromMat4(out, m) {
    let lx = Math.sqrt(m[0] * m[0] + m[1] * m[1] + m[2] * m[2]);
    let ly = Math.sqrt(m[4] * m[4] + m[5] * m[5] + m[6] * m[6]);
    let lz = Math.sqrt(m[8] * m[8] + m[9] * m[9] + m[10] * m[10]);
    lx = lx > EPS ? 1 / lx : 0;
    ly = ly > EPS ? 1 / ly : 0;
    lz = lz > EPS ? 1 / lz : 0;
    const b = QUAT_BASIS;
    b[0] = m[0] * lx; b[1] = m[1] * lx; b[2] = m[2] * lx;
    b[3] = m[4] * ly; b[4] = m[5] * ly; b[5] = m[6] * ly;
    b[6] = m[8] * lz; b[7] = m[9] * lz; b[8] = m[10] * lz;
    const m00 = b[0], m10 = b[1], m20 = b[2];
    const m01 = b[3], m11 = b[4], m21 = b[5];
    const m02 = b[6], m12 = b[7], m22 = b[8];
    const trace = m00 + m11 + m22;
    let s;
    if (trace > 0) {
      s = Math.sqrt(trace + 1) * 2;
      out[3] = 0.25 * s;
      out[0] = (m21 - m12) / s;
      out[1] = (m02 - m20) / s;
      out[2] = (m10 - m01) / s;
    } else if (m00 > m11 && m00 > m22) {
      s = Math.sqrt(1 + m00 - m11 - m22) * 2;
      out[3] = (m21 - m12) / s;
      out[0] = 0.25 * s;
      out[1] = (m01 + m10) / s;
      out[2] = (m02 + m20) / s;
    } else if (m11 > m22) {
      s = Math.sqrt(1 + m11 - m00 - m22) * 2;
      out[3] = (m02 - m20) / s;
      out[0] = (m01 + m10) / s;
      out[1] = 0.25 * s;
      out[2] = (m12 + m21) / s;
    } else {
      s = Math.sqrt(1 + m22 - m00 - m11) * 2;
      out[3] = (m10 - m01) / s;
      out[0] = (m02 + m20) / s;
      out[1] = (m12 + m21) / s;
      out[2] = 0.25 * s;
    }
    return out;
  },

  /**
   * Writes the rotation matrix of a unit quaternion into a column-major mat4.
   * @param {Float32Array} out Target 4x4 matrix.
   * @param {ArrayLike<number>} q Unit quaternion.
   * @returns {Float32Array} out
   */
  toMat4(out, q) {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    out[0] = 1 - (yy + zz); out[1] = xy + wz;       out[2] = xz - wy;       out[3] = 0;
    out[4] = xy - wz;       out[5] = 1 - (xx + zz); out[6] = yz + wx;       out[7] = 0;
    out[8] = xz + wy;       out[9] = yz - wx;       out[10] = 1 - (xx + yy); out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
    return out;
  }
};

/* gl-matrix compatibility alias. */
quat.mul = quat.multiply;

/* ------------------------------------------------------------------------- */
/* mat3                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Singularity threshold for a 3x3 determinant.
 *
 * A determinant scales with the *cube* of the matrix magnitude, so testing it against the
 * plain (linear) `EPS` wrongly rejects perfectly invertible matrices built from small scales:
 * a uniform scale of 0.005 has a determinant of 1.25e-7, well below 1e-6. Scaling the
 * tolerance by the largest column length cubed keeps the test dimensionally consistent, so
 * unit-scale matrices behave exactly as they did before and tiny props still invert correctly.
 *
 * @param {number} s0 Squared length of column 0.
 * @param {number} s1 Squared length of column 1.
 * @param {number} s2 Squared length of column 2.
 * @returns {number} Absolute tolerance the determinant must exceed to be considered invertible.
 */
function detEpsilon3(s0, s1, s2) {
  let s = s0 > s1 ? s0 : s1;
  if (s2 > s) s = s2;
  return EPS * s * Math.sqrt(s);
}

/**
 * Column-major 3x3 matrix helpers on `Float32Array(9)`.
 * Index layout: `m[column * 3 + row]`.
 * @namespace mat3
 */
export const mat3 = {
  /**
   * Creates an identity 3x3 matrix.
   * @returns {Float32Array} New matrix.
   */
  create() {
    const o = new Float32Array(9);
    o[0] = 1; o[4] = 1; o[8] = 1;
    return o;
  },

  /**
   * Resets a matrix to identity.
   * @param {Float32Array} out Target.
   * @returns {Float32Array} out
   */
  identity(out) {
    out[0] = 1; out[1] = 0; out[2] = 0;
    out[3] = 0; out[4] = 1; out[5] = 0;
    out[6] = 0; out[7] = 0; out[8] = 1;
    return out;
  },

  /**
   * Copies the upper-left 3x3 block of a mat4.
   * @param {Float32Array} out Target 3x3 matrix.
   * @param {ArrayLike<number>} a Column-major 4x4 matrix.
   * @returns {Float32Array} out
   */
  fromMat4(out, a) {
    out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
    out[3] = a[4]; out[4] = a[5]; out[5] = a[6];
    out[6] = a[8]; out[7] = a[9]; out[8] = a[10];
    return out;
  },

  /**
   * Builds the normal matrix (inverse transpose of the upper-left 3x3) of a mat4.
   * Falls back to the plain 3x3 block if the matrix is singular.
   * @param {Float32Array} out Target 3x3 matrix.
   * @param {ArrayLike<number>} a Column-major 4x4 matrix.
   * @returns {Float32Array} out
   */
  normalFromMat4(out, a) {
    const a00 = a[0], a01 = a[1], a02 = a[2];
    const a10 = a[4], a11 = a[5], a12 = a[6];
    const a20 = a[8], a21 = a[9], a22 = a[10];
    const b01 = a22 * a11 - a12 * a21;
    const b11 = -a22 * a10 + a12 * a20;
    const b21 = a21 * a10 - a11 * a20;
    let det = a00 * b01 + a01 * b11 + a02 * b21;
    const tol = detEpsilon3(
      a00 * a00 + a01 * a01 + a02 * a02,
      a10 * a10 + a11 * a11 + a12 * a12,
      a20 * a20 + a21 * a21 + a22 * a22
    );
    if (!(det > tol || det < -tol)) {
      // Singular (degenerate scale): fall back to the plain rotation block.
      out[0] = a00; out[1] = a01; out[2] = a02;
      out[3] = a10; out[4] = a11; out[5] = a12;
      out[6] = a20; out[7] = a21; out[8] = a22;
      return out;
    }
    det = 1 / det;
    // Inverse of the upper-left 3x3, written out transposed.
    out[0] = b01 * det;
    out[3] = (-a22 * a01 + a02 * a21) * det;
    out[6] = (a12 * a01 - a02 * a11) * det;
    out[1] = b11 * det;
    out[4] = (a22 * a00 - a02 * a20) * det;
    out[7] = (-a12 * a00 + a02 * a10) * det;
    out[2] = b21 * det;
    out[5] = (-a21 * a00 + a01 * a20) * det;
    out[8] = (a11 * a00 - a01 * a10) * det;
    return out;
  },

  /**
   * Transposes a 3x3 matrix. Safe when `out` aliases `a`.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source matrix.
   * @returns {Float32Array} out
   */
  transpose(out, a) {
    const a01 = a[1], a02 = a[2], a12 = a[5];
    out[0] = a[0];
    out[1] = a[3];
    out[2] = a[6];
    out[3] = a01;
    out[4] = a[4];
    out[5] = a[7];
    out[6] = a02;
    out[7] = a12;
    out[8] = a[8];
    return out;
  },

  /**
   * Inverts a 3x3 matrix. If the matrix is singular, `out` is set to identity.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source matrix.
   * @returns {Float32Array} out
   */
  invert(out, a) {
    const a00 = a[0], a01 = a[1], a02 = a[2];
    const a10 = a[3], a11 = a[4], a12 = a[5];
    const a20 = a[6], a21 = a[7], a22 = a[8];
    const b01 = a22 * a11 - a12 * a21;
    const b11 = -a22 * a10 + a12 * a20;
    const b21 = a21 * a10 - a11 * a20;
    let det = a00 * b01 + a01 * b11 + a02 * b21;
    const tol = detEpsilon3(
      a00 * a00 + a01 * a01 + a02 * a02,
      a10 * a10 + a11 * a11 + a12 * a12,
      a20 * a20 + a21 * a21 + a22 * a22
    );
    if (!(det > tol || det < -tol)) return mat3.identity(out);
    det = 1 / det;
    out[0] = b01 * det;
    out[1] = (-a22 * a01 + a02 * a21) * det;
    out[2] = (a12 * a01 - a02 * a11) * det;
    out[3] = b11 * det;
    out[4] = (a22 * a00 - a02 * a20) * det;
    out[5] = (-a12 * a00 + a02 * a10) * det;
    out[6] = b21 * det;
    out[7] = (-a21 * a00 + a01 * a20) * det;
    out[8] = (a11 * a00 - a01 * a10) * det;
    return out;
  },

  /**
   * Matrix product `a * b`. Safe when `out` aliases an input.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {Float32Array} out
   */
  multiply(out, a, b) {
    const a00 = a[0], a01 = a[1], a02 = a[2];
    const a10 = a[3], a11 = a[4], a12 = a[5];
    const a20 = a[6], a21 = a[7], a22 = a[8];
    const b00 = b[0], b01 = b[1], b02 = b[2];
    const b10 = b[3], b11 = b[4], b12 = b[5];
    const b20 = b[6], b21 = b[7], b22 = b[8];
    out[0] = b00 * a00 + b01 * a10 + b02 * a20;
    out[1] = b00 * a01 + b01 * a11 + b02 * a21;
    out[2] = b00 * a02 + b01 * a12 + b02 * a22;
    out[3] = b10 * a00 + b11 * a10 + b12 * a20;
    out[4] = b10 * a01 + b11 * a11 + b12 * a21;
    out[5] = b10 * a02 + b11 * a12 + b12 * a22;
    out[6] = b20 * a00 + b21 * a10 + b22 * a20;
    out[7] = b20 * a01 + b21 * a11 + b22 * a21;
    out[8] = b20 * a02 + b21 * a12 + b22 * a22;
    return out;
  }
};

/* gl-matrix compatibility alias. */
mat3.mul = mat3.multiply;

/* ------------------------------------------------------------------------- */
/* mat4                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Builds a translation * rotation * scale matrix.
 * Accepts the position and the quaternion in either order (they are told apart by length,
 * a quaternion has 4 components), which makes `compose`, `fromQuatPosScale` and
 * `fromRotationTranslationScale` interchangeable.
 * @param {Float32Array} out Target 4x4 matrix.
 * @param {ArrayLike<number>} a Position (vec3) or rotation (quat).
 * @param {ArrayLike<number>} b The other of position / rotation.
 * @param {ArrayLike<number>|number} [s=1] Scale vector or uniform scalar.
 * @returns {Float32Array} out
 */
function composeTRS(out, a, b, s) {
  const aIsQuat = a.length === 4;
  const q = aIsQuat ? a : b;
  const p = aIsQuat ? b : a;
  let sx = 1, sy = 1, sz = 1;
  if (s !== undefined && s !== null) {
    if (typeof s === 'number') {
      sx = s; sy = s; sz = s;
    } else {
      sx = s[0]; sy = s[1]; sz = s[2];
    }
  }
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = (1 - (yy + zz)) * sx;
  out[1] = (xy + wz) * sx;
  out[2] = (xz - wy) * sx;
  out[3] = 0;
  out[4] = (xy - wz) * sy;
  out[5] = (1 - (xx + zz)) * sy;
  out[6] = (yz + wx) * sy;
  out[7] = 0;
  out[8] = (xz + wy) * sz;
  out[9] = (yz - wx) * sz;
  out[10] = (1 - (xx + yy)) * sz;
  out[11] = 0;
  out[12] = p[0];
  out[13] = p[1];
  out[14] = p[2];
  out[15] = 1;
  return out;
}

/**
 * Column-major 4x4 matrix helpers on `Float32Array(16)`.
 * Index layout: `m[column * 4 + row]`; `m[12..14]` is the translation.
 * @namespace mat4
 */
export const mat4 = {
  /**
   * Creates an identity 4x4 matrix.
   * @returns {Float32Array} New matrix.
   */
  create() {
    const o = new Float32Array(16);
    o[0] = 1; o[5] = 1; o[10] = 1; o[15] = 1;
    return o;
  },

  /**
   * Resets a matrix to identity.
   * @param {Float32Array} out Target.
   * @returns {Float32Array} out
   */
  identity(out) {
    out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
    return out;
  },

  /**
   * Copies `a` into `out`.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source matrix.
   * @returns {Float32Array} out
   */
  copy(out, a) {
    out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
    out[4] = a[4]; out[5] = a[5]; out[6] = a[6]; out[7] = a[7];
    out[8] = a[8]; out[9] = a[9]; out[10] = a[10]; out[11] = a[11];
    out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
    return out;
  },

  /**
   * Allocates a copy of `a`.
   * @param {ArrayLike<number>} a Source matrix.
   * @returns {Float32Array} New matrix.
   */
  clone(a) {
    const o = new Float32Array(16);
    for (let i = 0; i < 16; i++) o[i] = a[i];
    return o;
  },

  /**
   * Matrix product `a * b` (b is applied first when transforming a column vector).
   * Safe when `out` aliases an input.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Left operand.
   * @param {ArrayLike<number>} b Right operand.
   * @returns {Float32Array} out
   */
  multiply(out, a, b) {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
    out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
    out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
    out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
    out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    return out;
  },

  /**
   * Post-multiplies `a` by a translation (`out = a * T(v)`).
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source matrix.
   * @param {ArrayLike<number>|number} v Translation vec3, or the X component when passing numbers.
   * @param {number} [y] Y component when `v` is a number.
   * @param {number} [z] Z component when `v` is a number.
   * @returns {Float32Array} out
   */
  translate(out, a, v, y, z) {
    let x0, y0, z0;
    if (typeof v === 'number') {
      x0 = v; y0 = y; z0 = z;
    } else {
      x0 = v[0]; y0 = v[1]; z0 = v[2];
    }
    if (out !== a) {
      out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
      out[4] = a[4]; out[5] = a[5]; out[6] = a[6]; out[7] = a[7];
      out[8] = a[8]; out[9] = a[9]; out[10] = a[10]; out[11] = a[11];
    }
    out[12] = a[0] * x0 + a[4] * y0 + a[8] * z0 + a[12];
    out[13] = a[1] * x0 + a[5] * y0 + a[9] * z0 + a[13];
    out[14] = a[2] * x0 + a[6] * y0 + a[10] * z0 + a[14];
    out[15] = a[3] * x0 + a[7] * y0 + a[11] * z0 + a[15];
    return out;
  },

  /**
   * Post-multiplies `a` by a rotation around the X axis.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source matrix.
   * @param {number} rad Angle in radians.
   * @returns {Float32Array} out
   */
  rotateX(out, a, rad) {
    const s = Math.sin(rad), c = Math.cos(rad);
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    if (out !== a) {
      out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
      out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
    }
    out[4] = a10 * c + a20 * s;
    out[5] = a11 * c + a21 * s;
    out[6] = a12 * c + a22 * s;
    out[7] = a13 * c + a23 * s;
    out[8] = a20 * c - a10 * s;
    out[9] = a21 * c - a11 * s;
    out[10] = a22 * c - a12 * s;
    out[11] = a23 * c - a13 * s;
    return out;
  },

  /**
   * Post-multiplies `a` by a rotation around the Y axis.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source matrix.
   * @param {number} rad Angle in radians.
   * @returns {Float32Array} out
   */
  rotateY(out, a, rad) {
    const s = Math.sin(rad), c = Math.cos(rad);
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    if (out !== a) {
      out[4] = a[4]; out[5] = a[5]; out[6] = a[6]; out[7] = a[7];
      out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
    }
    out[0] = a00 * c - a20 * s;
    out[1] = a01 * c - a21 * s;
    out[2] = a02 * c - a22 * s;
    out[3] = a03 * c - a23 * s;
    out[8] = a00 * s + a20 * c;
    out[9] = a01 * s + a21 * c;
    out[10] = a02 * s + a22 * c;
    out[11] = a03 * s + a23 * c;
    return out;
  },

  /**
   * Post-multiplies `a` by a rotation around the Z axis.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source matrix.
   * @param {number} rad Angle in radians.
   * @returns {Float32Array} out
   */
  rotateZ(out, a, rad) {
    const s = Math.sin(rad), c = Math.cos(rad);
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    if (out !== a) {
      out[8] = a[8]; out[9] = a[9]; out[10] = a[10]; out[11] = a[11];
      out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
    }
    out[0] = a00 * c + a10 * s;
    out[1] = a01 * c + a11 * s;
    out[2] = a02 * c + a12 * s;
    out[3] = a03 * c + a13 * s;
    out[4] = a10 * c - a00 * s;
    out[5] = a11 * c - a01 * s;
    out[6] = a12 * c - a02 * s;
    out[7] = a13 * c - a03 * s;
    return out;
  },

  /**
   * Post-multiplies `a` by a scale (`out = a * S(v)`).
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source matrix.
   * @param {ArrayLike<number>|number} v Scale vec3, a uniform scalar, or the X component.
   * @param {number} [y] Y scale when `v` is the X component.
   * @param {number} [z] Z scale when `v` is the X component.
   * @returns {Float32Array} out
   */
  scale(out, a, v, y, z) {
    let x0, y0, z0;
    if (typeof v === 'number') {
      x0 = v;
      y0 = y === undefined ? v : y;
      z0 = z === undefined ? v : z;
    } else {
      x0 = v[0]; y0 = v[1]; z0 = v[2];
    }
    out[0] = a[0] * x0; out[1] = a[1] * x0; out[2] = a[2] * x0; out[3] = a[3] * x0;
    out[4] = a[4] * y0; out[5] = a[5] * y0; out[6] = a[6] * y0; out[7] = a[7] * y0;
    out[8] = a[8] * z0; out[9] = a[9] * z0; out[10] = a[10] * z0; out[11] = a[11] * z0;
    if (out !== a) {
      out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
    }
    return out;
  },

  /**
   * Builds a pure translation matrix.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>|number} v Translation vec3, or the X component when passing numbers.
   * @param {number} [y] Y component when `v` is a number.
   * @param {number} [z] Z component when `v` is a number.
   * @returns {Float32Array} out
   */
  fromTranslation(out, v, y, z) {
    mat4.identity(out);
    if (typeof v === 'number') {
      out[12] = v; out[13] = y; out[14] = z;
    } else {
      out[12] = v[0]; out[13] = v[1]; out[14] = v[2];
    }
    return out;
  },

  /**
   * Builds a pure scale matrix.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>|number} v Scale vec3 or uniform scalar.
   * @param {number} [y] Y scale when `v` is the X component.
   * @param {number} [z] Z scale when `v` is the X component.
   * @returns {Float32Array} out
   */
  fromScaling(out, v, y, z) {
    mat4.identity(out);
    if (typeof v === 'number') {
      out[0] = v;
      out[5] = y === undefined ? v : y;
      out[10] = z === undefined ? v : z;
    } else {
      out[0] = v[0]; out[5] = v[1]; out[10] = v[2];
    }
    return out;
  },

  /**
   * Builds a rotation matrix around the Y axis (yaw). With `rad = 0` the -Z column faces -Z.
   * @param {Float32Array} out Target.
   * @param {number} rad Angle in radians.
   * @returns {Float32Array} out
   */
  fromRotationY(out, rad) {
    const s = Math.sin(rad), c = Math.cos(rad);
    out[0] = c; out[1] = 0; out[2] = -s; out[3] = 0;
    out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
    out[8] = s; out[9] = 0; out[10] = c; out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
    return out;
  },

  /**
   * Builds a translation * rotation * scale matrix.
   * Position and rotation may be given in either order (a quaternion is detected by its length).
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Rotation quaternion or position vec3.
   * @param {ArrayLike<number>} b The other of rotation / position.
   * @param {ArrayLike<number>|number} [s=1] Scale vec3 or uniform scalar.
   * @returns {Float32Array} out
   */
  fromRotationTranslationScale: composeTRS,

  /**
   * Alias of {@link mat4.compose}: builds a translation * rotation * scale matrix.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Position vec3 or rotation quaternion.
   * @param {ArrayLike<number>} b The other of position / rotation.
   * @param {ArrayLike<number>|number} [s=1] Scale vec3 or uniform scalar.
   * @returns {Float32Array} out
   */
  fromQuatPosScale: composeTRS,

  /**
   * Composes a transform from position, rotation and scale.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} position Position vec3.
   * @param {ArrayLike<number>} rotation Rotation quaternion.
   * @param {ArrayLike<number>|number} [scale=1] Scale vec3 or uniform scalar.
   * @returns {Float32Array} out
   */
  compose: composeTRS,

  /**
   * Right-handed perspective projection with a [-1, 1] depth range (standard WebGL clip space).
   * A point on the near plane maps to z = -1 and the far plane to z = +1 after the perspective divide.
   * @param {Float32Array} out Target.
   * @param {number} fovy Vertical field of view in radians.
   * @param {number} aspect Viewport width / height.
   * @param {number} near Near plane distance (> 0).
   * @param {number} far Far plane distance, may be `Infinity`.
   * @returns {Float32Array} out
   */
  perspective(out, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy * 0.5);
    out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[11] = -1;
    out[12] = 0; out[13] = 0; out[15] = 0;
    if (far != null && far !== Infinity) {
      const nf = 1 / (near - far);
      out[10] = (far + near) * nf;
      out[14] = 2 * far * near * nf;
    } else {
      out[10] = -1;
      out[14] = -2 * near;
    }
    return out;
  },

  /**
   * Orthographic projection with a [-1, 1] depth range.
   * @param {Float32Array} out Target.
   * @param {number} left Left plane.
   * @param {number} right Right plane.
   * @param {number} bottom Bottom plane.
   * @param {number} top Top plane.
   * @param {number} near Near plane.
   * @param {number} far Far plane.
   * @returns {Float32Array} out
   */
  ortho(out, left, right, bottom, top, near, far) {
    const lr = 1 / (left - right);
    const bt = 1 / (bottom - top);
    const nf = 1 / (near - far);
    out[0] = -2 * lr; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = -2 * bt; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = 2 * nf; out[11] = 0;
    out[12] = (left + right) * lr;
    out[13] = (top + bottom) * bt;
    out[14] = (far + near) * nf;
    out[15] = 1;
    return out;
  },

  /**
   * Builds a right-handed view matrix looking from `eye` towards `center`.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} eye Camera position.
   * @param {ArrayLike<number>} center Point to look at.
   * @param {ArrayLike<number>} up World up vector.
   * @returns {Float32Array} out
   */
  lookAt(out, eye, center, up) {
    const eyex = eye[0], eyey = eye[1], eyez = eye[2];
    const upx = up[0], upy = up[1], upz = up[2];
    let z0 = eyex - center[0];
    let z1 = eyey - center[1];
    let z2 = eyez - center[2];
    let l = z0 * z0 + z1 * z1 + z2 * z2;
    if (l < EPS * EPS) return mat4.identity(out);
    l = 1 / Math.sqrt(l);
    z0 *= l; z1 *= l; z2 *= l;
    let x0 = upy * z2 - upz * z1;
    let x1 = upz * z0 - upx * z2;
    let x2 = upx * z1 - upy * z0;
    l = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2);
    if (l < EPS) {
      // up is parallel to the view direction: build x from a world axis that is not parallel to z.
      const tx = Math.abs(z0) > 0.9 ? 0 : 1;
      const ty = Math.abs(z0) > 0.9 ? 1 : 0;
      x0 = ty * z2;
      x1 = -tx * z2;
      x2 = tx * z1 - ty * z0;
      l = 1 / Math.hypot(x0, x1, x2);
    } else {
      l = 1 / l;
    }
    x0 *= l; x1 *= l; x2 *= l;
    const y0 = z1 * x2 - z2 * x1;
    const y1 = z2 * x0 - z0 * x2;
    const y2 = z0 * x1 - z1 * x0;
    out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
    out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
    out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
    out[12] = -(x0 * eyex + x1 * eyey + x2 * eyez);
    out[13] = -(y0 * eyex + y1 * eyey + y2 * eyez);
    out[14] = -(z0 * eyex + z1 * eyey + z2 * eyez);
    out[15] = 1;
    return out;
  },

  /**
   * Builds a world (model) matrix placing an object at `eye` with its -Z axis aimed at `target`.
   * This is the inverse of {@link mat4.lookAt}.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} eye Object position.
   * @param {ArrayLike<number>} target Point to aim at.
   * @param {ArrayLike<number>} up World up vector.
   * @returns {Float32Array} out
   */
  targetTo(out, eye, target, up) {
    const eyex = eye[0], eyey = eye[1], eyez = eye[2];
    const upx = up[0], upy = up[1], upz = up[2];
    let z0 = eyex - target[0];
    let z1 = eyey - target[1];
    let z2 = eyez - target[2];
    let l = z0 * z0 + z1 * z1 + z2 * z2;
    if (l < EPS * EPS) {
      z0 = 0; z1 = 0; z2 = 1;
    } else {
      l = 1 / Math.sqrt(l);
      z0 *= l; z1 *= l; z2 *= l;
    }
    let x0 = upy * z2 - upz * z1;
    let x1 = upz * z0 - upx * z2;
    let x2 = upx * z1 - upy * z0;
    l = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2);
    if (l < EPS) {
      // Degenerate up vector: build x from a world axis that is not parallel to z.
      const tx = Math.abs(z0) > 0.9 ? 0 : 1;
      const ty = Math.abs(z0) > 0.9 ? 1 : 0;
      x0 = ty * z2;
      x1 = -tx * z2;
      x2 = tx * z1 - ty * z0;
      l = 1 / Math.hypot(x0, x1, x2);
    } else {
      l = 1 / l;
    }
    x0 *= l; x1 *= l; x2 *= l;
    out[0] = x0; out[1] = x1; out[2] = x2; out[3] = 0;
    out[4] = z1 * x2 - z2 * x1;
    out[5] = z2 * x0 - z0 * x2;
    out[6] = z0 * x1 - z1 * x0;
    out[7] = 0;
    out[8] = z0; out[9] = z1; out[10] = z2; out[11] = 0;
    out[12] = eyex; out[13] = eyey; out[14] = eyez; out[15] = 1;
    return out;
  },

  /**
   * Inverts a 4x4 matrix. If the matrix is singular, `out` is set to identity.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source matrix.
   * @returns {Float32Array} out
   */
  invert(out, a) {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (det === 0) return mat4.identity(out);
    det = 1 / det;
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return out;
  },

  /**
   * Transposes a 4x4 matrix. Safe when `out` aliases `a`.
   * @param {Float32Array} out Target.
   * @param {ArrayLike<number>} a Source matrix.
   * @returns {Float32Array} out
   */
  transpose(out, a) {
    if (out === a) {
      const a01 = a[1], a02 = a[2], a03 = a[3];
      const a12 = a[6], a13 = a[7], a23 = a[11];
      out[1] = a[4]; out[2] = a[8]; out[3] = a[12];
      out[4] = a01; out[6] = a[9]; out[7] = a[13];
      out[8] = a02; out[9] = a12; out[11] = a[14];
      out[12] = a03; out[13] = a13; out[14] = a23;
    } else {
      out[0] = a[0]; out[1] = a[4]; out[2] = a[8]; out[3] = a[12];
      out[4] = a[1]; out[5] = a[5]; out[6] = a[9]; out[7] = a[13];
      out[8] = a[2]; out[9] = a[6]; out[10] = a[10]; out[11] = a[14];
      out[12] = a[3]; out[13] = a[7]; out[14] = a[11]; out[15] = a[15];
    }
    return out;
  },

  /**
   * Extracts the translation column.
   * @param {Float32Array} out Target vec3.
   * @param {ArrayLike<number>} m Source matrix.
   * @returns {Float32Array} out
   */
  getTranslation(out, m) {
    out[0] = m[12]; out[1] = m[13]; out[2] = m[14];
    return out;
  },

  /**
   * Extracts the normalized forward axis (-Z column).
   * @param {Float32Array} out Target vec3.
   * @param {ArrayLike<number>} m Source matrix.
   * @returns {Float32Array} out
   */
  getForward(out, m) {
    const x = -m[8], y = -m[9], z = -m[10];
    let l = x * x + y * y + z * z;
    if (l > 0) {
      l = 1 / Math.sqrt(l);
      out[0] = x * l; out[1] = y * l; out[2] = z * l;
    } else {
      out[0] = 0; out[1] = 0; out[2] = -1;
    }
    return out;
  },

  /**
   * Extracts the normalized right axis (+X column).
   * @param {Float32Array} out Target vec3.
   * @param {ArrayLike<number>} m Source matrix.
   * @returns {Float32Array} out
   */
  getRight(out, m) {
    const x = m[0], y = m[1], z = m[2];
    let l = x * x + y * y + z * z;
    if (l > 0) {
      l = 1 / Math.sqrt(l);
      out[0] = x * l; out[1] = y * l; out[2] = z * l;
    } else {
      out[0] = 1; out[1] = 0; out[2] = 0;
    }
    return out;
  },

  /**
   * Extracts the normalized up axis (+Y column).
   * @param {Float32Array} out Target vec3.
   * @param {ArrayLike<number>} m Source matrix.
   * @returns {Float32Array} out
   */
  getUp(out, m) {
    const x = m[4], y = m[5], z = m[6];
    let l = x * x + y * y + z * z;
    if (l > 0) {
      l = 1 / Math.sqrt(l);
      out[0] = x * l; out[1] = y * l; out[2] = z * l;
    } else {
      out[0] = 0; out[1] = 1; out[2] = 0;
    }
    return out;
  }
};

/* gl-matrix compatibility alias. */
mat4.mul = mat4.multiply;

/* ------------------------------------------------------------------------- */
/* aabb                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * An axis-aligned bounding box: `{ min, max }` where both are indexable xyz triples.
 * Every function here accepts any object with `min`/`max` arrays, so geometry `bounds`
 * objects (`{min: [..], max: [..]}`) work directly.
 * @typedef {{min: (Float32Array|number[]), max: (Float32Array|number[])}} AABB
 */

/**
 * Axis-aligned bounding box helpers.
 * @namespace aabb
 */
export const aabb = {
  /**
   * Creates a box. With no arguments the box is "empty" (min = +Infinity, max = -Infinity)
   * so that `expandPoint` / `expandAabb` can grow it from nothing.
   * @param {ArrayLike<number>} [min] Optional initial minimum corner.
   * @param {ArrayLike<number>} [max] Optional initial maximum corner.
   * @returns {AABB} New box.
   */
  create(min, max) {
    const box = { min: new Float32Array(3), max: new Float32Array(3) };
    if (min && max) {
      box.min[0] = min[0]; box.min[1] = min[1]; box.min[2] = min[2];
      box.max[0] = max[0]; box.max[1] = max[1]; box.max[2] = max[2];
    } else {
      box.min[0] = Infinity; box.min[1] = Infinity; box.min[2] = Infinity;
      box.max[0] = -Infinity; box.max[1] = -Infinity; box.max[2] = -Infinity;
    }
    return box;
  },

  /**
   * Builds a box from a center point and its full size (not half extents).
   * @param {AABB} out Target box.
   * @param {ArrayLike<number>} center Center point.
   * @param {ArrayLike<number>|number} size Full size vec3 or a uniform size.
   * @returns {AABB} out
   */
  fromCenterSize(out, center, size) {
    let sx, sy, sz;
    if (typeof size === 'number') {
      sx = size; sy = size; sz = size;
    } else {
      sx = size[0]; sy = size[1]; sz = size[2];
    }
    out.min[0] = center[0] - sx * 0.5;
    out.min[1] = center[1] - sy * 0.5;
    out.min[2] = center[2] - sz * 0.5;
    out.max[0] = center[0] + sx * 0.5;
    out.max[1] = center[1] + sy * 0.5;
    out.max[2] = center[2] + sz * 0.5;
    return out;
  },

  /**
   * Builds the tight box around a point set. Accepts either an array of xyz triples
   * (`[[x,y,z], ...]`) or a flat array / `Float32Array` of packed xyz components.
   * @param {AABB} out Target box.
   * @param {ArrayLike<number>|Array<ArrayLike<number>>} points Point set.
   * @returns {AABB} out
   */
  fromPoints(out, points) {
    let minx = Infinity, miny = Infinity, minz = Infinity;
    let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    const n = points.length;
    if (n > 0 && typeof points[0] === 'number') {
      for (let i = 0; i + 2 < n; i += 3) {
        const x = points[i], y = points[i + 1], z = points[i + 2];
        if (x < minx) minx = x;
        if (y < miny) miny = y;
        if (z < minz) minz = z;
        if (x > maxx) maxx = x;
        if (y > maxy) maxy = y;
        if (z > maxz) maxz = z;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const p = points[i];
        const x = p[0], y = p[1], z = p[2];
        if (x < minx) minx = x;
        if (y < miny) miny = y;
        if (z < minz) minz = z;
        if (x > maxx) maxx = x;
        if (y > maxy) maxy = y;
        if (z > maxz) maxz = z;
      }
    }
    out.min[0] = minx; out.min[1] = miny; out.min[2] = minz;
    out.max[0] = maxx; out.max[1] = maxy; out.max[2] = maxz;
    return out;
  },

  /**
   * Sets the box corners from raw components.
   * @param {AABB} out Target box.
   * @param {number} minx Minimum X.
   * @param {number} miny Minimum Y.
   * @param {number} minz Minimum Z.
   * @param {number} maxx Maximum X.
   * @param {number} maxy Maximum Y.
   * @param {number} maxz Maximum Z.
   * @returns {AABB} out
   */
  set(out, minx, miny, minz, maxx, maxy, maxz) {
    out.min[0] = minx; out.min[1] = miny; out.min[2] = minz;
    out.max[0] = maxx; out.max[1] = maxy; out.max[2] = maxz;
    return out;
  },

  /**
   * Copies box `a` into `out`.
   * @param {AABB} out Target box.
   * @param {AABB} a Source box.
   * @returns {AABB} out
   */
  copy(out, a) {
    out.min[0] = a.min[0]; out.min[1] = a.min[1]; out.min[2] = a.min[2];
    out.max[0] = a.max[0]; out.max[1] = a.max[1]; out.max[2] = a.max[2];
    return out;
  },

  /**
   * Writes the box center into `out`.
   * @param {Float32Array} out Target vec3.
   * @param {AABB} box Source box.
   * @returns {Float32Array} out
   */
  center(out, box) {
    out[0] = (box.min[0] + box.max[0]) * 0.5;
    out[1] = (box.min[1] + box.max[1]) * 0.5;
    out[2] = (box.min[2] + box.max[2]) * 0.5;
    return out;
  },

  /**
   * Writes the full box size into `out`.
   * @param {Float32Array} out Target vec3.
   * @param {AABB} box Source box.
   * @returns {Float32Array} out
   */
  size(out, box) {
    out[0] = box.max[0] - box.min[0];
    out[1] = box.max[1] - box.min[1];
    out[2] = box.max[2] - box.min[2];
    return out;
  },

  /**
   * Grows the box so it contains a point.
   * @param {AABB} out Box to grow (modified in place).
   * @param {ArrayLike<number>|number} p Point vec3, or the X component when passing numbers.
   * @param {number} [y] Y component when `p` is a number.
   * @param {number} [z] Z component when `p` is a number.
   * @returns {AABB} out
   */
  expandPoint(out, p, y, z) {
    let px, py, pz;
    if (typeof p === 'number') {
      px = p; py = y; pz = z;
    } else {
      px = p[0]; py = p[1]; pz = p[2];
    }
    if (px < out.min[0]) out.min[0] = px;
    if (py < out.min[1]) out.min[1] = py;
    if (pz < out.min[2]) out.min[2] = pz;
    if (px > out.max[0]) out.max[0] = px;
    if (py > out.max[1]) out.max[1] = py;
    if (pz > out.max[2]) out.max[2] = pz;
    return out;
  },

  /**
   * Grows the box so it contains another box (union).
   * @param {AABB} out Box to grow (modified in place).
   * @param {AABB} b Box to absorb.
   * @returns {AABB} out
   */
  expandAabb(out, b) {
    if (b.min[0] < out.min[0]) out.min[0] = b.min[0];
    if (b.min[1] < out.min[1]) out.min[1] = b.min[1];
    if (b.min[2] < out.min[2]) out.min[2] = b.min[2];
    if (b.max[0] > out.max[0]) out.max[0] = b.max[0];
    if (b.max[1] > out.max[1]) out.max[1] = b.max[1];
    if (b.max[2] > out.max[2]) out.max[2] = b.max[2];
    return out;
  },

  /**
   * Tests whether two boxes overlap (touching counts as overlapping).
   * @param {AABB} a First box.
   * @param {AABB} b Second box.
   * @returns {boolean} True on overlap.
   */
  intersects(a, b) {
    return a.min[0] <= b.max[0] && a.max[0] >= b.min[0] &&
      a.min[1] <= b.max[1] && a.max[1] >= b.min[1] &&
      a.min[2] <= b.max[2] && a.max[2] >= b.min[2];
  },

  /**
   * Tests whether a point is inside the box (inclusive bounds).
   * @param {AABB} box Box to test.
   * @param {ArrayLike<number>|number} p Point vec3, or the X component when passing numbers.
   * @param {number} [y] Y component when `p` is a number.
   * @param {number} [z] Z component when `p` is a number.
   * @returns {boolean} True when the point is inside.
   */
  containsPoint(box, p, y, z) {
    let px, py, pz;
    if (typeof p === 'number') {
      px = p; py = y; pz = z;
    } else {
      px = p[0]; py = p[1]; pz = p[2];
    }
    return px >= box.min[0] && px <= box.max[0] &&
      py >= box.min[1] && py <= box.max[1] &&
      pz >= box.min[2] && pz <= box.max[2];
  },

  /**
   * Distance from a point to the box surface; 0 when the point is inside.
   * @param {AABB} box Box to test.
   * @param {ArrayLike<number>} p Point.
   * @returns {number} Distance.
   */
  distanceToPoint(box, p) {
    const dx = Math.max(box.min[0] - p[0], 0, p[0] - box.max[0]);
    const dy = Math.max(box.min[1] - p[1], 0, p[1] - box.max[1]);
    const dz = Math.max(box.min[2] - p[2], 0, p[2] - box.max[2]);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  },

  /**
   * Ray/box intersection using the slab method. Handles axis-parallel rays.
   * Returns the distance along `dir` of the nearest non-negative hit, or -1 when there is none.
   * A ray starting inside the box returns 0. `dir` should be normalized for `t` to be in meters.
   * @param {AABB} box Box to test.
   * @param {ArrayLike<number>} origin Ray origin.
   * @param {ArrayLike<number>} dir Ray direction (normalized).
   * @param {number} [maxDist=Infinity] Maximum distance to consider.
   * @returns {number} Hit distance, or -1 for a miss.
   */
  rayIntersect(box, origin, dir, maxDist) {
    const limit = maxDist === undefined ? Infinity : maxDist;
    let tmin = 0;
    let tmax = limit;
    for (let i = 0; i < 3; i++) {
      const o = origin[i];
      const d = dir[i];
      const lo = box.min[i];
      const hi = box.max[i];
      if (d > -EPS && d < EPS) {
        // Ray is parallel to this slab: it must already be inside it.
        if (o < lo || o > hi) return -1;
      } else {
        const inv = 1 / d;
        let t1 = (lo - o) * inv;
        let t2 = (hi - o) * inv;
        if (t1 > t2) {
          const tmp = t1; t1 = t2; t2 = tmp;
        }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return -1;
      }
    }
    // tmin is clamped to [0, limit] by construction: a ray starting inside reports 0.
    return tmin;
  },

  /**
   * Tests whether a sphere overlaps the box.
   * @param {AABB} box Box to test.
   * @param {ArrayLike<number>} center Sphere center.
   * @param {number} radius Sphere radius.
   * @returns {boolean} True on overlap.
   */
  sphereIntersects(box, center, radius) {
    const dx = Math.max(box.min[0] - center[0], 0, center[0] - box.max[0]);
    const dy = Math.max(box.min[1] - center[1], 0, center[1] - box.max[1]);
    const dz = Math.max(box.min[2] - center[2], 0, center[2] - box.max[2]);
    return dx * dx + dy * dy + dz * dz <= radius * radius;
  },

  /**
   * Writes the point of the box closest to `p` into `out` (equal to `p` when inside).
   * @param {Float32Array} out Target vec3.
   * @param {AABB} box Box to test.
   * @param {ArrayLike<number>} p Query point.
   * @returns {Float32Array} out
   */
  closestPoint(out, box, p) {
    out[0] = p[0] < box.min[0] ? box.min[0] : (p[0] > box.max[0] ? box.max[0] : p[0]);
    out[1] = p[1] < box.min[1] ? box.min[1] : (p[1] > box.max[1] ? box.max[1] : p[1]);
    out[2] = p[2] < box.min[2] ? box.min[2] : (p[2] > box.max[2] ? box.max[2] : p[2]);
    return out;
  }
};

/* ------------------------------------------------------------------------- */
/* Rand                                                                       */
/* ------------------------------------------------------------------------- */

/** Scratch buffer used to fold non-integer seeds into 32 bits. @type {ArrayBuffer} */
const SEED_BUFFER = new ArrayBuffer(8);
/** Float64 view over SEED_BUFFER. @type {Float64Array} */
const SEED_F64 = new Float64Array(SEED_BUFFER);
/** Uint32 view over SEED_BUFFER. @type {Uint32Array} */
const SEED_U32 = new Uint32Array(SEED_BUFFER);

/**
 * Murmur3 32-bit finalizer: scrambles an integer so that adjacent inputs land far apart.
 * @param {number} h Input integer.
 * @returns {number} Well-distributed unsigned 32-bit integer.
 */
function mix32(h) {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Hashes an arbitrary seed value (integer, float or string) into an unsigned 32-bit integer.
 * @param {number|string|null|undefined} value Seed value.
 * @returns {number} Unsigned 32-bit hash.
 */
function hashSeed(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isInteger(value)) return mix32(value | 0);
    SEED_F64[0] = value;
    return mix32(SEED_U32[0] ^ Math.imul(SEED_U32[1] | 0, 0x9e3779b1));
  }
  const s = value === undefined || value === null ? '0' : String(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  }
  return mix32(h);
}

/**
 * Deterministic seeded pseudo-random generator (mulberry32).
 *
 * Fast, allocation free and stable across browsers - all procedural world generation must use
 * this instead of `Math.random()`. Two generators built with the same seed always produce the
 * exact same stream.
 */
export class Rand {
  /**
   * @param {number|string} [seed=1] Seed value. Numbers and strings are both hashed, so
   *   `1`, `2`, `3` produce completely different (uncorrelated) streams.
   */
  constructor(seed = 1) {
    /** The seed this generator was built from; `new Rand(r.seed)` reproduces the stream. @type {number|string} */
    this.seed = seed;
    /** Initial scrambled state, kept so `fork` is independent of stream position. @type {number} */
    this._seed0 = hashSeed(seed);
    /** Current 32-bit generator state. @type {number} */
    this._state = this._seed0 | 0;
    /** Cached second Box-Muller sample. @type {number} */
    this._spare = 0;
    /** Whether `_spare` holds an unused gaussian sample. @type {boolean} */
    this._hasSpare = false;
  }

  /**
   * Draws the next uniform sample.
   * @returns {number} Value in [0, 1).
   */
  next() {
    let t = (this._state = (this._state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Draws a uniform sample in [a, b).
   * @param {number} a Lower bound.
   * @param {number} b Upper bound.
   * @returns {number} Value in [a, b).
   */
  range(a, b) {
    return a + (b - a) * this.next();
  }

  /**
   * Draws a uniform integer in [a, b], inclusive on both ends.
   * @param {number} a Lower bound.
   * @param {number} b Upper bound.
   * @returns {number} Integer in [a, b].
   */
  int(a, b) {
    const lo = Math.ceil(a < b ? a : b);
    const hi = Math.floor(a < b ? b : a);
    if (hi < lo) return lo;
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  /**
   * Picks a uniformly random element of an array.
   * @param {ArrayLike<*>} array Source array.
   * @returns {*} A random element, or `undefined` for an empty array.
   */
  pick(array) {
    if (!array || array.length === 0) return undefined;
    return array[Math.floor(this.next() * array.length)];
  }

  /**
   * Flips a biased coin.
   * @param {number} p Probability of `true`, in [0, 1].
   * @returns {boolean} True with probability `p`.
   */
  chance(p) {
    return this.next() < p;
  }

  /**
   * Draws -1 or +1 with equal probability.
   * @returns {number} Either -1 or 1.
   */
  sign() {
    return this.next() < 0.5 ? -1 : 1;
  }

  /**
   * Draws a normally distributed sample (mean 0, standard deviation 1) using the
   * polar Box-Muller transform; the second sample of each pair is cached.
   * @returns {number} Gaussian sample.
   */
  gaussian() {
    if (this._hasSpare) {
      this._hasSpare = false;
      return this._spare;
    }
    let u = 0, v = 0, s = 0;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    this._spare = v * m;
    this._hasSpare = true;
    return u * m;
  }

  /**
   * Creates an independent generator derived from this one's seed and a salt.
   * The result depends only on the constructor seed and the salt, never on how many
   * numbers have already been drawn, so sub-streams stay stable when generation order changes.
   * @param {number|string} salt Sub-stream identifier.
   * @returns {Rand} New deterministic generator.
   */
  fork(salt) {
    const h = mix32((this._seed0 ^ Math.imul(hashSeed(salt) | 0, 0x9e3779b1)) | 0);
    return new Rand(h);
  }
}
