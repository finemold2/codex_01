/**
 * Procedural, bone-driven humanoid.
 *
 * There are no model files in this project: the body is assembled from `core/geometry.js`
 * primitives into one shared set of GPU meshes (`buildCharacterMeshes`), and every character
 * animates that shared set through a 20-bone hierarchy. Colour comes from a per-instance rgba
 * tint multiplied by a baked vertex-colour detail mask, so a single mesh set serves civilians,
 * cops, gangsters and the player.
 *
 * Rendering goes through the renderer's instanced path: one `InstancedBatch` per body part,
 * so *all* characters in the world cost ~20 draw calls in total rather than 20 each.
 *
 * Nothing in here allocates during `update()` or `submit()`.
 */
import {
  vec3, mat4, quat, clamp, lerp, damp, angleLerp, angleDamp, wrapAngle, smoothstep, Rand
} from '../core/math.js';
import {
  box, roundedBox, sphere, cylinder, capsule, cone, mergeGeometries,
  transformGeometry, computeBounds, computeNormals, geometryTriangleCount
} from '../core/geometry.js';
import { createMaterial } from '../render/materials.js';

/* -------------------------------------------------------------------------- */
/* Rig                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Bone names in hierarchy order (parents always precede children), exactly as specified by
 * `docs/ARCHITECTURE.md` section 9.
 * @type {string[]}
 */
export const BONES = ['root', 'pelvis', 'spine', 'chest', 'neck', 'head', 'shoulderL', 'armL', 'forearmL', 'handL',
  'shoulderR', 'armR', 'forearmR', 'handR', 'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR'];

/** Number of bones in the rig. @type {number} */
export const BONE_COUNT = BONES.length;

/** Name -> index lookup. @type {Object<string, number>} */
export const BONE_INDEX = (() => {
  const m = Object.create(null);
  for (let i = 0; i < BONES.length; i++) m[BONES[i]] = i;
  return m;
})();

/** Parent index per bone, -1 for the root. @type {Int8Array} */
const BONE_PARENT = new Int8Array([
  -1, // root
  0,  // pelvis
  1,  // spine
  2,  // chest
  3,  // neck
  4,  // head
  3,  // shoulderL
  6,  // armL
  7,  // forearmL
  8,  // handL
  3,  // shoulderR
  10, // armR
  11, // forearmR
  12, // handR
  1,  // thighL
  14, // shinL
  15, // footL
  1,  // thighR
  17, // shinR
  18  // footR
]);

/**
 * Rest offset of each bone in its parent's local frame, in metres, for a 1.80 m male.
 * The rest pose is a natural A-pose with the arms hanging straight down, so a zero local
 * rotation on every bone already produces a standing figure.
 * @type {Float32Array}
 */
const REST_OFFSET = new Float32Array([
  0, 0, 0,             // root      (on the ground between the feet)
  0, 0.98, 0,          // pelvis
  0, 0.13, 0,          // spine     -> 1.11
  0, 0.16, 0,          // chest     -> 1.27
  0, 0.21, 0,          // neck      -> 1.48
  0, 0.09, 0,          // head      -> 1.57 (skull base)
  -0.045, 0.155, 0,    // shoulderL -> 1.425
  -0.135, -0.03, 0,    // armL      -> shoulder joint at x -0.18, y 1.395
  0, -0.285, 0,        // forearmL  -> elbow  y 1.11
  0, -0.255, 0,        // handL     -> wrist  y 0.855
  0.045, 0.155, 0,     // shoulderR
  0.135, -0.03, 0,     // armR
  0, -0.285, 0,        // forearmR
  0, -0.255, 0,        // handR
  -0.095, -0.07, 0,    // thighL    -> hip joint y 0.91
  0, -0.45, 0,         // shinL     -> knee   y 0.46
  0, -0.38, 0,         // footL     -> ankle  y 0.08
  0.095, -0.07, 0,     // thighR
  0, -0.45, 0,         // shinR
  0, -0.38, 0          // footR
]);

/** Bone chain half-lengths used by the ragdoll solver and the sanity radius. */
const RIG_HEIGHT = 1.8;

/** Channels per bone in a pose buffer: local euler x (pitch), y (yaw), z (roll). */
const POSE_STRIDE = 3;
/** Pose buffers carry three trailing floats: the pelvis translation offset in root space. */
const POSE_LEN = BONE_COUNT * POSE_STRIDE + 3;
/** Index of the pelvis translation offset inside a pose buffer. */
const POSE_ROOT = BONE_COUNT * POSE_STRIDE;

const D2R = Math.PI / 180;

/**
 * Largest time step any animation layer is ever integrated with, in seconds.
 *
 * `update()` clamps its own `dt`, but the LOD accumulator can still hand a single step of up
 * to two clamped frames to the layers below. Every damped spring in this module (ragdoll,
 * recoil) is only unconditionally stable up to a bounded step, so the accumulated step is
 * clamped here as well and the excess is dropped.
 */
const MAX_STEP = 0.1;

/**
 * How long (seconds) and for how many consecutive updates an owner must keep asking a
 * ragdolled character for a living state before the body is revived. A respawned or recycled
 * character is driven every frame; a stray one-off request (a reload finishing on a body that
 * has just died, say) never reaches the threshold, so a corpse cannot be popped upright by an
 * unrelated system.
 */
const REVIVE_HOLD_TIME = 0.08;
const REVIVE_HOLD_FRAMES = 3;

/**
 * Returns `v` when it is a finite number, otherwise `fallback`.
 *
 * Every value that crosses the module boundary (`dt`, the frame context, `yaw`, `position`)
 * goes through this: a single non-finite frame from a caller would otherwise latch into the
 * smoothing accumulators and leave the character permanently un-drawable.
 * @param {*} v Candidate value.
 * @param {number} fallback Value to use when `v` is not a finite number.
 * @returns {number} A finite number.
 */
function num(v, fallback) {
  return typeof v === 'number' && v - v === 0 ? v : fallback;
}

/* -------------------------------------------------------------------------- */
/* Keyframe authoring                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Compiles a hand-authored pose description into a flat pose buffer.
 *
 * Angles are given in DEGREES as `[x, y, z]` (YXZ euler: x = pitch, y = yaw, z = roll) and are
 * stored in radians. Sign conventions, consistent for every bone:
 *   +x  swings the bone's tip forward (-Z) — hip flexion, shoulder flexion, toe-up on the feet.
 *   +y  turns the bone to the character's left.
 *   +z  tilts the bone's tip toward the character's left (-X).
 * `_root` is the pelvis translation offset in metres `[x, y, z]` (+z = behind the character).
 *
 * @param {Object<string, number[]>} spec Bone name -> `[x, y, z]` degrees, plus optional `_root`.
 * @returns {Float32Array} Pose buffer of length {@link POSE_LEN}.
 */
function P(spec) {
  const out = new Float32Array(POSE_LEN);
  for (const key in spec) {
    if (key === '_root') {
      const r = spec._root;
      out[POSE_ROOT] = r[0] || 0;
      out[POSE_ROOT + 1] = r[1] || 0;
      out[POSE_ROOT + 2] = r[2] || 0;
      continue;
    }
    const bi = BONE_INDEX[key];
    if (bi === undefined) continue;
    const a = spec[key];
    const o = bi * POSE_STRIDE;
    out[o] = (a[0] || 0) * D2R;
    out[o + 1] = (a[1] || 0) * D2R;
    out[o + 2] = (a[2] || 0) * D2R;
  }
  return out;
}

/**
 * Mirrors a pose description left <-> right so cyclic gaits only need half of their keys
 * authored by hand. Yaw and roll flip sign, pitch is kept, X translation flips.
 * @param {Object<string, number[]>} spec Source description.
 * @returns {Object<string, number[]>} New mirrored description.
 */
function mirrorSpec(spec) {
  const out = {};
  for (const key in spec) {
    if (key === '_root') {
      const r = spec._root;
      out._root = [-(r[0] || 0), r[1] || 0, r[2] || 0];
      continue;
    }
    const a = spec[key];
    let name = key;
    if (key.endsWith('L')) name = key.slice(0, -1) + 'R';
    else if (key.endsWith('R')) name = key.slice(0, -1) + 'L';
    out[name] = [a[0] || 0, -(a[1] || 0), -(a[2] || 0)];
  }
  return out;
}

/** Raw clip descriptions; compiled into typed arrays once at module load. */
const CLIP_SPECS = Object.create(null);

/* --- idle: relaxed stance, breathing, a slow weight shift ------------------ */
const IDLE_BASE = {
  spine: [2, 0, 0], chest: [-1, 0, 0], neck: [3, 0, 0], head: [-2, 0, 0],
  shoulderL: [0, 0, 3], armL: [-4, 0, 7], forearmL: [9, 0, 4], handL: [0, 0, 3],
  shoulderR: [0, 0, -3], armR: [-4, 0, -7], forearmR: [9, 0, -4], handR: [0, 0, -3],
  thighL: [1, 0, 1], shinL: [-3, 0, 0], footL: [2, 0, 0],
  thighR: [1, 0, -1], shinR: [-3, 0, 0], footR: [2, 0, 0],
  _root: [0, -0.012, 0]
};
CLIP_SPECS.idle = {
  loop: true, duration: 4.4, gait: false,
  keys: [
    [0.0, IDLE_BASE],
    [1.15, {
      spine: [2.6, 0, 0], chest: [-2.6, 0, 0], neck: [3, 0, 0], head: [-2, 0, 0],
      shoulderL: [0, 0, 4.5], armL: [-5, 0, 8], forearmL: [10, 0, 4], handL: [0, 0, 3],
      shoulderR: [0, 0, -4.5], armR: [-5, 0, -8], forearmR: [10, 0, -4], handR: [0, 0, -3],
      thighL: [1, 0, 1], shinL: [-3, 0, 0], footL: [2, 0, 0],
      thighR: [1, 0, -1], shinR: [-3, 0, 0], footR: [2, 0, 0],
      _root: [0, -0.004, 0]
    }],
    [2.2, {
      pelvis: [0, -2.5, -2.4], spine: [1.5, 1.5, 2.2], chest: [-1, 1.5, 0.6],
      neck: [3, -1, 0], head: [-2, -2, 0],
      shoulderL: [0, 0, 3], armL: [-3, 0, 9], forearmL: [12, 0, 5], handL: [0, 0, 3],
      shoulderR: [0, 0, -3], armR: [-5, 0, -6], forearmR: [8, 0, -4], handR: [0, 0, -3],
      thighL: [-1, 0, 3], shinL: [-2, 0, 0], footL: [1, 0, 0],
      thighR: [4, 0, -4], shinR: [-8, 0, 0], footR: [5, 0, 0],
      _root: [-0.028, -0.018, 0]
    }],
    [3.3, {
      pelvis: [0, -2.5, -2.4], spine: [2.4, 1.5, 2.2], chest: [-2.6, 1.5, 0.6],
      neck: [3, -1, 0], head: [-2, -2, 0],
      shoulderL: [0, 0, 4.5], armL: [-3, 0, 10], forearmL: [13, 0, 5], handL: [0, 0, 3],
      shoulderR: [0, 0, -4.5], armR: [-6, 0, -7], forearmR: [9, 0, -4], handR: [0, 0, -3],
      thighL: [-1, 0, 3], shinL: [-2, 0, 0], footL: [1, 0, 0],
      thighR: [4, 0, -4], shinR: [-8, 0, 0], footR: [5, 0, 0],
      _root: [-0.028, -0.010, 0]
    }],
    [4.4, IDLE_BASE]
  ]
};

/* --- walk: 1.0 phase = one full gait cycle (two steps) --------------------- */
const WALK_CONTACT = {
  pelvis: [0, -4, -1.5], spine: [3, 2, 0], chest: [1, 3.5, 0], neck: [2, 0, 0], head: [-1, 0, 0],
  shoulderL: [0, 0, 2], armL: [-21, 0, 6], forearmL: [14, 0, 4], handL: [0, 0, 2],
  shoulderR: [0, 0, -2], armR: [23, 0, -5], forearmR: [26, 0, -4], handR: [0, 0, -2],
  thighL: [25, -1, 1], shinL: [-7, 0, 0], footL: [-9, 0, 0],
  thighR: [-23, 1, -1], shinR: [-24, 0, 0], footR: [13, 0, 0],
  _root: [0.012, -0.034, 0]
};
const WALK_PASS = {
  pelvis: [0, 0, -2.5], spine: [3, 0, 0], chest: [1, 0, 0], neck: [2, 0, 0], head: [-1, 0, 0],
  shoulderL: [0, 0, 2], armL: [-6, 0, 6], forearmL: [12, 0, 4], handL: [0, 0, 2],
  shoulderR: [0, 0, -2], armR: [7, 0, -5], forearmR: [17, 0, -4], handR: [0, 0, -2],
  thighL: [-9, 0, 1], shinL: [-6, 0, 0], footL: [4, 0, 0],
  thighR: [16, 0, -1], shinR: [-46, 0, 0], footR: [-4, 0, 0],
  _root: [0.006, -0.004, 0]
};
CLIP_SPECS.walk = {
  loop: true, duration: 1, gait: true,
  legs: { stride: 1.30, stance: 0.58, lift: 0.13, heelRise: 0.10, frontFrac: 0.44, toeOff: 0.42, heelStrike: 0.20 },
  keys: [
    [0.0, WALK_CONTACT],
    [0.25, WALK_PASS],
    [0.5, mirrorSpec(WALK_CONTACT)],
    [0.75, mirrorSpec(WALK_PASS)],
    [1.0, WALK_CONTACT]
  ]
};

/* --- run ------------------------------------------------------------------- */
const RUN_CONTACT = {
  pelvis: [0, -6, -2], spine: [7, 3, 0], chest: [4, 5, 0], neck: [-2, 0, 0], head: [-3, 0, 0],
  shoulderL: [0, 0, 3], armL: [-36, 0, 9], forearmL: [66, 0, 6], handL: [0, 0, 4],
  shoulderR: [0, 0, -3], armR: [34, 0, -9], forearmR: [80, 0, -6], handR: [0, 0, -4],
  thighL: [31, -2, 1], shinL: [-19, 0, 0], footL: [-6, 0, 0],
  thighR: [-30, 2, -1], shinR: [-44, 0, 0], footR: [22, 0, 0],
  _root: [0.018, -0.052, 0]
};
const RUN_FLIGHT = {
  pelvis: [0, 0, -3], spine: [8, 0, 0], chest: [5, 0, 0], neck: [-2, 0, 0], head: [-3, 0, 0],
  shoulderL: [0, 0, 3], armL: [-14, 0, 9], forearmL: [56, 0, 6], handL: [0, 0, 4],
  shoulderR: [0, 0, -3], armR: [12, 0, -9], forearmR: [64, 0, -6], handR: [0, 0, -4],
  thighL: [-24, 0, 1], shinL: [-24, 0, 0], footL: [16, 0, 0],
  thighR: [40, 0, -1], shinR: [-88, 0, 0], footR: [-12, 0, 0],
  _root: [0.010, 0.014, 0]
};
CLIP_SPECS.run = {
  loop: true, duration: 1, gait: true,
  legs: {
    stride: 2.45, stance: 0.36, lift: 0.26, heelRise: 0.085,
    frontFrac: 0.46, toeOff: 0.50, heelStrike: 0.10, flightArc: 0.045
  },
  keys: [
    [0.0, RUN_CONTACT],
    [0.25, RUN_FLIGHT],
    [0.5, mirrorSpec(RUN_CONTACT)],
    [0.75, mirrorSpec(RUN_FLIGHT)],
    [1.0, RUN_CONTACT]
  ]
};

/* --- sprint ---------------------------------------------------------------- */
const SPRINT_CONTACT = {
  pelvis: [0, -8, -2], spine: [12, 4, 0], chest: [7, 6, 0], neck: [-6, 0, 0], head: [-4, 0, 0],
  shoulderL: [0, 0, 4], armL: [-52, 0, 11], forearmL: [78, 0, 8], handL: [0, 0, 5],
  shoulderR: [0, 0, -4], armR: [48, 0, -11], forearmR: [96, 0, -8], handR: [0, 0, -5],
  thighL: [38, -3, 1], shinL: [-26, 0, 0], footL: [-4, 0, 0],
  thighR: [-36, 3, -1], shinR: [-56, 0, 0], footR: [28, 0, 0],
  _root: [0.022, -0.058, 0]
};
const SPRINT_FLIGHT = {
  pelvis: [0, 0, -3.5], spine: [13, 0, 0], chest: [8, 0, 0], neck: [-6, 0, 0], head: [-4, 0, 0],
  shoulderL: [0, 0, 4], armL: [-20, 0, 11], forearmL: [66, 0, 8], handL: [0, 0, 5],
  shoulderR: [0, 0, -4], armR: [18, 0, -11], forearmR: [76, 0, -8], handR: [0, 0, -5],
  thighL: [-32, 0, 1], shinL: [-30, 0, 0], footL: [22, 0, 0],
  thighR: [55, 0, -1], shinR: [-104, 0, 0], footR: [-16, 0, 0],
  _root: [0.012, 0.022, 0]
};
CLIP_SPECS.sprint = {
  loop: true, duration: 1, gait: true,
  legs: {
    stride: 3.30, stance: 0.28, lift: 0.34, heelRise: 0.08,
    frontFrac: 0.47, toeOff: 0.55, heelStrike: 0.05, flightArc: 0.065
  },
  keys: [
    [0.0, SPRINT_CONTACT],
    [0.25, SPRINT_FLIGHT],
    [0.5, mirrorSpec(SPRINT_CONTACT)],
    [0.75, mirrorSpec(SPRINT_FLIGHT)],
    [1.0, SPRINT_CONTACT]
  ]
};

/* --- crouch ---------------------------------------------------------------- */
const CROUCH_BASE = {
  pelvis: [-4, 0, 0], spine: [16, 0, 0], chest: [8, 0, 0], neck: [-8, 0, 0], head: [-6, 0, 0],
  shoulderL: [0, 0, 4], armL: [-16, 0, 12], forearmL: [46, 0, 6], handL: [0, 0, 4],
  shoulderR: [0, 0, -4], armR: [-16, 0, -12], forearmR: [46, 0, -6], handR: [0, 0, -4],
  thighL: [48, -1, 3], shinL: [-88, 0, 0], footL: [40, 0, 0],
  thighR: [48, 1, -3], shinR: [-88, 0, 0], footR: [40, 0, 0],
  _root: [0, -0.24, 0.087]
};
CLIP_SPECS.crouch = {
  loop: true, duration: 3.6, gait: false,
  keys: [
    [0.0, CROUCH_BASE],
    [1.1, {
      pelvis: [-4, 0, 0], spine: [17.5, 0, 0], chest: [6.5, 0, 0], neck: [-8, 0, 0], head: [-6, 0, 0],
      shoulderL: [0, 0, 5], armL: [-17, 0, 13], forearmL: [48, 0, 6], handL: [0, 0, 4],
      shoulderR: [0, 0, -5], armR: [-17, 0, -13], forearmR: [48, 0, -6], handR: [0, 0, -4],
      thighL: [49, -1, 3], shinL: [-89, 0, 0], footL: [40, 0, 0],
      thighR: [49, 1, -3], shinR: [-89, 0, 0], footR: [40, 0, 0],
      _root: [0, -0.248, 0.09]
    }],
    [2.3, {
      pelvis: [-4, -3, -1.5], spine: [16, 2, 1.5], chest: [8, 2, 0.5], neck: [-8, -1, 0], head: [-6, -2, 0],
      shoulderL: [0, 0, 4], armL: [-15, 0, 11], forearmL: [44, 0, 6], handL: [0, 0, 4],
      shoulderR: [0, 0, -4], armR: [-18, 0, -13], forearmR: [49, 0, -6], handR: [0, 0, -4],
      thighL: [46, -1, 4], shinL: [-86, 0, 0], footL: [40, 0, 0],
      thighR: [50, 1, -4], shinR: [-90, 0, 0], footR: [40, 0, 0],
      _root: [-0.014, -0.236, 0.085]
    }],
    [3.6, CROUCH_BASE]
  ]
};

/* --- crouchWalk ------------------------------------------------------------- */
const CROUCHWALK_CONTACT = {
  pelvis: [-4, -5, -1.5], spine: [15, 3, 0], chest: [7, 4, 0], neck: [-7, 0, 0], head: [-6, 0, 0],
  shoulderL: [0, 0, 5], armL: [-24, 0, 13], forearmL: [50, 0, 6], handL: [0, 0, 4],
  shoulderR: [0, 0, -5], armR: [-6, 0, -13], forearmR: [42, 0, -6], handR: [0, 0, -4],
  thighL: [45, -2, 3], shinL: [-82, 0, 0], footL: [37, 0, 0],
  thighR: [12, 2, -3], shinR: [-74, 0, 0], footR: [42, 0, 0],
  _root: [0.01, -0.20, 0.07]
};
const CROUCHWALK_PASS = {
  pelvis: [-4, 0, -2], spine: [15, 0, 0], chest: [7, 0, 0], neck: [-7, 0, 0], head: [-6, 0, 0],
  shoulderL: [0, 0, 5], armL: [-16, 0, 13], forearmL: [46, 0, 6], handL: [0, 0, 4],
  shoulderR: [0, 0, -5], armR: [-14, 0, -13], forearmR: [45, 0, -6], handR: [0, 0, -4],
  thighL: [30, 0, 3], shinL: [-75, 0, 0], footL: [45, 0, 0],
  thighR: [45, 0, -3], shinR: [-95, 0, 0], footR: [40, 0, 0],
  _root: [0.006, -0.20, 0.07]
};
CLIP_SPECS.crouchWalk = {
  loop: true, duration: 1, gait: true,
  legs: {
    stride: 1.00, stance: 0.62, lift: 0.09, heelRise: 0.05,
    frontFrac: 0.45, toeOff: 0.30, heelStrike: 0.12, hipFixed: 0.665
  },
  keys: [
    [0.0, CROUCHWALK_CONTACT],
    [0.25, CROUCHWALK_PASS],
    [0.5, mirrorSpec(CROUCHWALK_CONTACT)],
    [0.75, mirrorSpec(CROUCHWALK_PASS)],
    [1.0, CROUCHWALK_CONTACT]
  ]
};

/* --- jump / fall / land ----------------------------------------------------- */
CLIP_SPECS.jump = {
  loop: false, duration: 0.52, gait: false,
  keys: [
    [0.0, {
      pelvis: [0, 0, 0], spine: [-5, 0, 0], chest: [-3, 0, 0], neck: [4, 0, 0], head: [3, 0, 0],
      shoulderL: [0, 0, 8], armL: [-62, 0, 14], forearmL: [26, 0, 6], handL: [0, 0, 4],
      shoulderR: [0, 0, -8], armR: [-64, 0, -14], forearmR: [26, 0, -6], handR: [0, 0, -4],
      thighL: [-13, 0, 1], shinL: [-9, 0, 0], footL: [-24, 0, 0],
      thighR: [-11, 0, -1], shinR: [-13, 0, 0], footR: [-22, 0, 0],
      _root: [0, 0.03, 0]
    }],
    [0.18, {
      spine: [7, 0, 0], chest: [4, 0, 0], neck: [-3, 0, 0], head: [-2, 0, 0],
      shoulderL: [0, 0, 8], armL: [-34, 0, 18], forearmL: [46, 0, 8], handL: [0, 0, 4],
      shoulderR: [0, 0, -8], armR: [-36, 0, -18], forearmR: [46, 0, -8], handR: [0, 0, -4],
      thighL: [42, 0, 2], shinL: [-72, 0, 0], footL: [-4, 0, 0],
      thighR: [32, 0, -2], shinR: [-62, 0, 0], footR: [-2, 0, 0],
      _root: [0, -0.02, 0]
    }],
    [0.35, {
      spine: [3, 0, 0], chest: [1, 0, 0], neck: [-2, 0, 0], head: [-2, 0, 0],
      shoulderL: [0, 0, 8], armL: [-12, 0, 22], forearmL: [34, 0, 8], handL: [0, 0, 4],
      shoulderR: [0, 0, -8], armR: [-14, 0, -22], forearmR: [34, 0, -8], handR: [0, 0, -4],
      thighL: [24, 0, 2], shinL: [-42, 0, 0], footL: [2, 0, 0],
      thighR: [18, 0, -2], shinR: [-36, 0, 0], footR: [0, 0, 0],
      _root: [0, -0.01, 0]
    }],
    [0.52, {
      spine: [-3, 0, 0], chest: [-2, 0, 0], neck: [1, 0, 0], head: [-1, 0, 0],
      shoulderL: [0, 0, 8], armL: [12, 0, 30], forearmL: [22, 0, 8], handL: [0, 0, 4],
      shoulderR: [0, 0, -8], armR: [14, 0, -30], forearmR: [22, 0, -8], handR: [0, 0, -4],
      thighL: [8, 0, 2], shinL: [-20, 0, 0], footL: [8, 0, 0],
      thighR: [-4, 0, -2], shinR: [-16, 0, 0], footR: [6, 0, 0],
      _root: [0, 0, 0]
    }]
  ]
};

CLIP_SPECS.fall = {
  loop: true, duration: 0.94, gait: false,
  keys: [
    [0.0, {
      spine: [-6, 2, 0], chest: [-4, 3, 0], neck: [4, -2, 0], head: [3, -3, 0],
      shoulderL: [0, 0, 10], armL: [-22, -6, 34], forearmL: [30, 0, 10], handL: [0, 0, 6],
      shoulderR: [0, 0, -10], armR: [-24, 6, -34], forearmR: [32, 0, -10], handR: [0, 0, -6],
      thighL: [16, 0, 3], shinL: [-28, 0, 0], footL: [6, 0, 0],
      thighR: [-8, 0, -3], shinR: [-18, 0, 0], footR: [2, 0, 0],
      _root: [0, 0.01, 0]
    }],
    [0.31, {
      spine: [-6, -2, 0], chest: [-4, -3, 0], neck: [4, 2, 0], head: [3, 3, 0],
      shoulderL: [0, 0, 10], armL: [-8, -4, 42], forearmL: [26, 0, 10], handL: [0, 0, 6],
      shoulderR: [0, 0, -10], armR: [-36, 4, -30], forearmR: [38, 0, -10], handR: [0, 0, -6],
      thighL: [4, 0, 3], shinL: [-20, 0, 0], footL: [4, 0, 0],
      thighR: [4, 0, -3], shinR: [-28, 0, 0], footR: [6, 0, 0],
      _root: [0, 0.015, 0]
    }],
    [0.63, {
      spine: [-6, 2, 0], chest: [-4, 3, 0], neck: [4, -2, 0], head: [3, -3, 0],
      shoulderL: [0, 0, 10], armL: [-28, -6, 30], forearmL: [34, 0, 10], handL: [0, 0, 6],
      shoulderR: [0, 0, -10], armR: [-14, 6, -40], forearmR: [28, 0, -10], handR: [0, 0, -6],
      thighL: [-6, 0, 3], shinL: [-16, 0, 0], footL: [2, 0, 0],
      thighR: [18, 0, -3], shinR: [-30, 0, 0], footR: [8, 0, 0],
      _root: [0, 0.01, 0]
    }],
    [0.94, {
      spine: [-6, 2, 0], chest: [-4, 3, 0], neck: [4, -2, 0], head: [3, -3, 0],
      shoulderL: [0, 0, 10], armL: [-22, -6, 34], forearmL: [30, 0, 10], handL: [0, 0, 6],
      shoulderR: [0, 0, -10], armR: [-24, 6, -34], forearmR: [32, 0, -10], handR: [0, 0, -6],
      thighL: [16, 0, 3], shinL: [-28, 0, 0], footL: [6, 0, 0],
      thighR: [-8, 0, -3], shinR: [-18, 0, 0], footR: [2, 0, 0],
      _root: [0, 0.01, 0]
    }]
  ]
};

CLIP_SPECS.land = {
  loop: false, duration: 0.44, gait: false,
  keys: [
    [0.0, {
      spine: [8, 0, 0], chest: [4, 0, 0], neck: [-4, 0, 0], head: [-3, 0, 0],
      shoulderL: [0, 0, 10], armL: [16, 0, 26], forearmL: [30, 0, 8], handL: [0, 0, 4],
      shoulderR: [0, 0, -10], armR: [18, 0, -26], forearmR: [30, 0, -8], handR: [0, 0, -4],
      thighL: [22, 0, 2], shinL: [-42, 0, 0], footL: [18, 0, 0],
      thighR: [20, 0, -2], shinR: [-40, 0, 0], footR: [18, 0, 0],
      _root: [0, -0.06, 0.02]
    }],
    [0.13, {
      spine: [19, 0, 0], chest: [9, 0, 0], neck: [-9, 0, 0], head: [-7, 0, 0],
      shoulderL: [0, 0, 14], armL: [-6, 0, 34], forearmL: [54, 0, 10], handL: [0, 0, 6],
      shoulderR: [0, 0, -14], armR: [-4, 0, -34], forearmR: [54, 0, -10], handR: [0, 0, -6],
      thighL: [44, 0, 3], shinL: [-84, 0, 0], footL: [38, 0, 0],
      thighR: [42, 0, -3], shinR: [-82, 0, 0], footR: [38, 0, 0],
      _root: [0, -0.20, 0.06]
    }],
    [0.29, {
      spine: [8, 0, 0], chest: [4, 0, 0], neck: [-4, 0, 0], head: [-3, 0, 0],
      shoulderL: [0, 0, 8], armL: [-8, 0, 16], forearmL: [26, 0, 6], handL: [0, 0, 4],
      shoulderR: [0, 0, -8], armR: [-8, 0, -16], forearmR: [26, 0, -6], handR: [0, 0, -4],
      thighL: [18, 0, 2], shinL: [-34, 0, 0], footL: [14, 0, 0],
      thighR: [17, 0, -2], shinR: [-33, 0, 0], footR: [14, 0, 0],
      _root: [0, -0.07, 0.02]
    }],
    [0.44, IDLE_BASE]
  ]
};

/* --- aim / shoot ------------------------------------------------------------ */
const AIM_BASE = {
  pelvis: [0, -6, 0], spine: [2, -8, 0], chest: [1, -16, 0], neck: [2, 11, 0], head: [-1, 11, 0],
  shoulderL: [4, 0, 8], armL: [74, -46, -26], forearmL: [40, 0, 2], handL: [0, 0, 6],
  shoulderR: [6, -4, -8], armR: [72, 4, 2], forearmR: [34, 0, -6], handR: [0, 0, -2],
  thighL: [7, -5, 2], shinL: [-14, 0, 0], footL: [7, 0, 0],
  thighR: [-5, 5, -3], shinR: [-11, 0, 0], footR: [5, 0, 0],
  _root: [0.02, -0.03, 0.02]
};
const AIM_BREATH = {
  pelvis: [0, -6, 0], spine: [3, -8, 0], chest: [-0.5, -16, 0], neck: [2, 11, 0], head: [-1, 11, 0],
  shoulderL: [4, 0, 9], armL: [72.5, -46, -26], forearmL: [41, 0, 2], handL: [0, 0, 6],
  shoulderR: [6, -4, -9], armR: [70.5, 4, 2], forearmR: [35, 0, -6], handR: [0, 0, -2],
  thighL: [7, -5, 2], shinL: [-14, 0, 0], footL: [7, 0, 0],
  thighR: [-5, 5, -3], shinR: [-11, 0, 0], footR: [5, 0, 0],
  _root: [0.02, -0.024, 0.02]
};
CLIP_SPECS.aim = {
  loop: true, duration: 3.0, gait: false,
  keys: [[0.0, AIM_BASE], [0.85, AIM_BREATH], [1.7, AIM_BASE], [2.4, AIM_BREATH], [3.0, AIM_BASE]]
};

const AIMWALK_CONTACT = {
  pelvis: [0, -9, -1.2], spine: [3, -7, 0], chest: [1, -15, 0], neck: [2, 11, 0], head: [-1, 11, 0],
  shoulderL: [4, 0, 8], armL: [73, -46, -26], forearmL: [41, 0, 2], handL: [0, 0, 6],
  shoulderR: [6, -4, -8], armR: [71, 4, 2], forearmR: [35, 0, -6], handR: [0, 0, -2],
  thighL: [19, -2, 2], shinL: [-8, 0, 0], footL: [-4, 0, 0],
  thighR: [-17, 2, -2], shinR: [-20, 0, 0], footR: [12, 0, 0],
  _root: [0.02, -0.046, 0.02]
};
const AIMWALK_PASS = {
  pelvis: [0, -5, -2], spine: [3, -8, 0], chest: [1, -16, 0], neck: [2, 11, 0], head: [-1, 11, 0],
  shoulderL: [4, 0, 8], armL: [74, -46, -26], forearmL: [40, 0, 2], handL: [0, 0, 6],
  shoulderR: [6, -4, -8], armR: [72, 4, 2], forearmR: [34, 0, -6], handR: [0, 0, -2],
  thighL: [-7, 0, 2], shinL: [-7, 0, 0], footL: [3, 0, 0],
  thighR: [13, 0, -2], shinR: [-40, 0, 0], footR: [-3, 0, 0],
  _root: [0.02, -0.02, 0.02]
};
CLIP_SPECS.aimWalk = {
  loop: true, duration: 1, gait: true,
  legs: { stride: 1.15, stance: 0.60, lift: 0.10, heelRise: 0.08, frontFrac: 0.45, toeOff: 0.35, heelStrike: 0.16 },
  keys: [
    [0.0, AIMWALK_CONTACT],
    [0.25, AIMWALK_PASS],
    [0.5, mirrorSpec(AIMWALK_CONTACT)],
    [0.75, mirrorSpec(AIMWALK_PASS)],
    [1.0, AIMWALK_CONTACT]
  ]
};

CLIP_SPECS.shoot = {
  loop: false, duration: 0.26, gait: false,
  keys: [
    [0.0, AIM_BASE],
    [0.05, {
      pelvis: [0, -6, 0], spine: [-3, -8, 0], chest: [-6, -16, 0], neck: [6, 11, 0], head: [4, 11, 0],
      shoulderL: [4, 0, 8], armL: [66, -46, -26], forearmL: [46, 0, 2], handL: [0, 0, 6],
      shoulderR: [2, -4, -8], armR: [62, 4, 2], forearmR: [44, 0, -6], handR: [-14, 0, -2],
      thighL: [7, -5, 2], shinL: [-14, 0, 0], footL: [7, 0, 0],
      thighR: [-5, 5, -3], shinR: [-11, 0, 0], footR: [5, 0, 0],
      _root: [0.02, -0.03, 0.05]
    }],
    [0.14, {
      pelvis: [0, -6, 0], spine: [3, -8, 0], chest: [3, -16, 0], neck: [0, 11, 0], head: [-3, 11, 0],
      shoulderL: [4, 0, 8], armL: [77, -46, -26], forearmL: [37, 0, 2], handL: [0, 0, 6],
      shoulderR: [7, -4, -8], armR: [75, 4, 2], forearmR: [31, 0, -6], handR: [4, 0, -2],
      thighL: [7, -5, 2], shinL: [-14, 0, 0], footL: [7, 0, 0],
      thighR: [-5, 5, -3], shinR: [-11, 0, 0], footR: [5, 0, 0],
      _root: [0.02, -0.03, 0.01]
    }],
    [0.26, AIM_BASE]
  ]
};

/* --- reload ------------------------------------------------------------------ */
CLIP_SPECS.reload = {
  loop: false, duration: 1.9, gait: false,
  keys: [
    [0.0, AIM_BASE],
    [0.3, {
      pelvis: [0, -4, 0], spine: [6, -6, 0], chest: [6, -12, 0], neck: [-6, 8, 0], head: [-10, 6, 0],
      shoulderL: [2, 0, 8], armL: [26, -20, -10], forearmL: [82, 0, 4], handL: [0, 0, 10],
      shoulderR: [4, -4, -8], armR: [44, 6, 4], forearmR: [64, 0, -8], handR: [0, 0, -4],
      thighL: [7, -5, 2], shinL: [-14, 0, 0], footL: [7, 0, 0],
      thighR: [-5, 5, -3], shinR: [-11, 0, 0], footR: [5, 0, 0],
      _root: [0.02, -0.036, 0.02]
    }],
    [0.62, {
      pelvis: [0, -4, 0], spine: [9, -6, 0], chest: [9, -12, 0], neck: [-8, 8, 0], head: [-14, 6, 0],
      shoulderL: [-2, 0, 6], armL: [-6, -10, 6], forearmL: [58, 0, 6], handL: [10, 0, 12],
      shoulderR: [4, -4, -8], armR: [42, 6, 4], forearmR: [66, 0, -8], handR: [0, 0, -4],
      thighL: [7, -5, 2], shinL: [-14, 0, 0], footL: [7, 0, 0],
      thighR: [-5, 5, -3], shinR: [-11, 0, 0], footR: [5, 0, 0],
      _root: [0.02, -0.04, 0.02]
    }],
    [0.98, {
      pelvis: [0, -4, 0], spine: [8, -6, 0], chest: [8, -12, 0], neck: [-7, 8, 0], head: [-12, 6, 0],
      shoulderL: [2, 0, 8], armL: [30, -22, -12], forearmL: [96, 0, 4], handL: [-6, 0, 8],
      shoulderR: [4, -4, -8], armR: [44, 6, 4], forearmR: [64, 0, -8], handR: [0, 0, -4],
      thighL: [7, -5, 2], shinL: [-14, 0, 0], footL: [7, 0, 0],
      thighR: [-5, 5, -3], shinR: [-11, 0, 0], footR: [5, 0, 0],
      _root: [0.02, -0.038, 0.02]
    }],
    [1.32, {
      pelvis: [0, -5, 0], spine: [5, -7, 0], chest: [4, -14, 0], neck: [-2, 9, 0], head: [-6, 8, 0],
      shoulderL: [4, 0, 8], armL: [56, -40, -22], forearmL: [72, 0, 2], handL: [0, 0, 6],
      shoulderR: [5, -4, -8], armR: [56, 5, 3], forearmR: [50, 0, -7], handR: [0, 0, -3],
      thighL: [7, -5, 2], shinL: [-14, 0, 0], footL: [7, 0, 0],
      thighR: [-5, 5, -3], shinR: [-11, 0, 0], footR: [5, 0, 0],
      _root: [0.02, -0.034, 0.02]
    }],
    [1.9, AIM_BASE]
  ]
};

/* --- punch -------------------------------------------------------------------- */
CLIP_SPECS.punch = {
  loop: false, duration: 0.56, gait: false,
  keys: [
    [0.0, {
      pelvis: [0, 6, 0], spine: [2, 10, 0], chest: [-2, 16, 0], neck: [0, -10, 0], head: [0, -12, 0],
      shoulderL: [0, 0, 6], armL: [24, -10, -14], forearmL: [88, 0, 4], handL: [0, 0, 4],
      shoulderR: [-4, 0, -6], armR: [-24, 0, -14], forearmR: [92, 0, -4], handR: [0, 0, -4],
      thighL: [6, -4, 2], shinL: [-12, 0, 0], footL: [6, 0, 0],
      thighR: [-6, 4, -2], shinR: [-14, 0, 0], footR: [8, 0, 0],
      _root: [0.02, -0.024, 0.03]
    }],
    [0.14, {
      pelvis: [0, -14, 0], spine: [4, -14, 0], chest: [2, -26, 0], neck: [0, 16, 0], head: [-2, 18, 0],
      shoulderL: [0, 0, 6], armL: [10, -6, -10], forearmL: [102, 0, 4], handL: [0, 0, 4],
      shoulderR: [10, 0, -4], armR: [86, 2, 2], forearmR: [8, 0, -2], handR: [0, 0, -2],
      thighL: [10, -6, 2], shinL: [-16, 0, 0], footL: [8, 0, 0],
      thighR: [-10, 6, -2], shinR: [-18, 0, 0], footR: [10, 0, 0],
      _root: [0.01, -0.02, -0.03]
    }],
    [0.26, {
      pelvis: [0, -10, 0], spine: [4, -10, 0], chest: [2, -20, 0], neck: [0, 12, 0], head: [-2, 14, 0],
      shoulderL: [0, 0, 6], armL: [14, -8, -12], forearmL: [96, 0, 4], handL: [0, 0, 4],
      shoulderR: [8, 0, -5], armR: [70, 2, 2], forearmR: [30, 0, -4], handR: [0, 0, -3],
      thighL: [8, -5, 2], shinL: [-14, 0, 0], footL: [7, 0, 0],
      thighR: [-8, 5, -2], shinR: [-16, 0, 0], footR: [9, 0, 0],
      _root: [0.015, -0.022, -0.01]
    }],
    [0.4, {
      pelvis: [0, 2, 0], spine: [2, 4, 0], chest: [-1, 8, 0], neck: [0, -5, 0], head: [0, -6, 0],
      shoulderL: [0, 0, 6], armL: [20, -10, -14], forearmL: [90, 0, 4], handL: [0, 0, 4],
      shoulderR: [0, 0, -6], armR: [-4, 0, -10], forearmR: [82, 0, -4], handR: [0, 0, -4],
      thighL: [5, -3, 2], shinL: [-11, 0, 0], footL: [5, 0, 0],
      thighR: [-5, 3, -2], shinR: [-12, 0, 0], footR: [6, 0, 0],
      _root: [0.02, -0.02, 0.02]
    }],
    [0.56, IDLE_BASE]
  ]
};

/* --- hit reaction --------------------------------------------------------------- */
CLIP_SPECS.hit = {
  loop: false, duration: 0.48, gait: false,
  keys: [
    [0.0, IDLE_BASE],
    [0.09, {
      pelvis: [-6, 3, 0], spine: [-14, 5, -3], chest: [-12, 6, -4], neck: [12, -4, 0], head: [14, -6, 0],
      shoulderL: [-6, 0, 14], armL: [-30, -8, 26], forearmL: [56, 0, 8], handL: [0, 0, 6],
      shoulderR: [-6, 0, -14], armR: [-32, 8, -26], forearmR: [58, 0, -8], handR: [0, 0, -6],
      thighL: [-6, 0, 2], shinL: [-14, 0, 0], footL: [4, 0, 0],
      thighR: [8, 0, -2], shinR: [-20, 0, 0], footR: [8, 0, 0],
      _root: [0, -0.03, 0.07]
    }],
    [0.24, {
      pelvis: [-2, 1, 0], spine: [-4, 2, -1], chest: [-3, 2, -1], neck: [5, -2, 0], head: [6, -2, 0],
      shoulderL: [-2, 0, 8], armL: [-16, -4, 16], forearmL: [34, 0, 6], handL: [0, 0, 4],
      shoulderR: [-2, 0, -8], armR: [-17, 4, -16], forearmR: [35, 0, -6], handR: [0, 0, -4],
      thighL: [-2, 0, 2], shinL: [-7, 0, 0], footL: [3, 0, 0],
      thighR: [4, 0, -2], shinR: [-11, 0, 0], footR: [5, 0, 0],
      _root: [0, -0.02, 0.03]
    }],
    [0.48, IDLE_BASE]
  ]
};

/* --- die: the slack pose the ragdoll springs settle into ------------------------- */
CLIP_SPECS.die = {
  loop: false, duration: 1.2, gait: false,
  keys: [
    [0.0, IDLE_BASE],
    [0.22, {
      pelvis: [-8, 0, 0], spine: [-10, 4, -4], chest: [-8, 6, -5], neck: [16, -4, 0], head: [18, -6, 0],
      shoulderL: [-8, 0, 16], armL: [-34, -10, 30], forearmL: [40, 0, 10], handL: [0, 0, 8],
      shoulderR: [-8, 0, -16], armR: [-36, 10, -30], forearmR: [42, 0, -10], handR: [0, 0, -8],
      thighL: [16, -3, 4], shinL: [-40, 0, 0], footL: [12, 0, 0],
      thighR: [10, 3, -4], shinR: [-34, 0, 0], footR: [10, 0, 0],
      _root: [0, -0.14, 0.05]
    }],
    [0.6, {
      pelvis: [-4, 0, 0], spine: [-6, 6, -6], chest: [-4, 8, -7], neck: [14, -6, 0], head: [16, -8, 0],
      shoulderL: [-4, 0, 22], armL: [-14, -14, 44], forearmL: [26, 0, 12], handL: [0, 0, 10],
      shoulderR: [-4, 0, -22], armR: [-16, 14, -44], forearmR: [28, 0, -12], handR: [0, 0, -10],
      thighL: [22, -4, 8], shinL: [-30, 0, 0], footL: [6, 0, 0],
      thighR: [8, 4, -8], shinR: [-22, 0, 0], footR: [4, 0, 0],
      _root: [0, -0.06, 0.02]
    }],
    [1.2, {
      pelvis: [-2, 0, 0], spine: [-3, 5, -5], chest: [-2, 6, -6], neck: [12, -5, 0], head: [13, -7, 0],
      shoulderL: [-2, 0, 26], armL: [-6, -16, 52], forearmL: [18, 0, 14], handL: [0, 0, 12],
      shoulderR: [-2, 0, -26], armR: [-8, 16, -52], forearmR: [20, 0, -14], handR: [0, 0, -12],
      thighL: [16, -4, 10], shinL: [-22, 0, 0], footL: [4, 0, 0],
      thighR: [6, 4, -10], shinR: [-16, 0, 0], footR: [2, 0, 0],
      _root: [0, -0.02, 0]
    }]
  ]
};

/* --- drive: seated at the wheel ---------------------------------------------------- */
const DRIVE_BASE = {
  pelvis: [-6, 0, 0], spine: [7, 0, 0], chest: [3, 0, 0], neck: [-3, 0, 0], head: [-2, 0, 0],
  shoulderL: [4, 0, 10], armL: [56, -20, -16], forearmL: [56, 0, 6], handL: [0, 0, 8],
  shoulderR: [4, 0, -10], armR: [56, 20, 16], forearmR: [56, 0, -6], handR: [0, 0, -8],
  thighL: [80, -6, 7], shinL: [-78, 0, 0], footL: [6, 0, 0],
  thighR: [80, 6, -7], shinR: [-72, 0, 0], footR: [10, 0, 0],
  _root: [0, 0, 0]
};
CLIP_SPECS.drive = {
  loop: true, duration: 5.2, gait: false,
  keys: [
    [0.0, DRIVE_BASE],
    [1.4, {
      pelvis: [-6, 0, 0], spine: [8, 1, 0], chest: [2, 1.5, 0], neck: [-3, -1, 0], head: [-2, -2, 0],
      shoulderL: [4, 0, 11], armL: [55, -20, -16], forearmL: [57, 0, 6], handL: [0, 0, 8],
      shoulderR: [4, 0, -11], armR: [57, 20, 16], forearmR: [55, 0, -6], handR: [0, 0, -8],
      thighL: [80, -6, 7], shinL: [-78, 0, 0], footL: [8, 0, 0],
      thighR: [80, 6, -7], shinR: [-70, 0, 0], footR: [12, 0, 0],
      _root: [0, 0.004, 0]
    }],
    [3.1, {
      pelvis: [-6, 0, 0], spine: [7, -1, 0], chest: [3, -1.5, 0], neck: [-3, 1, 0], head: [-2, 2, 0],
      shoulderL: [4, 0, 10], armL: [57, -20, -16], forearmL: [55, 0, 6], handL: [0, 0, 8],
      shoulderR: [4, 0, -10], armR: [55, 20, 16], forearmR: [57, 0, -6], handR: [0, 0, -8],
      thighL: [80, -6, 7], shinL: [-76, 0, 0], footL: [5, 0, 0],
      thighR: [80, 6, -7], shinR: [-74, 0, 0], footR: [9, 0, 0],
      _root: [0, -0.004, 0]
    }],
    [5.2, DRIVE_BASE]
  ]
};

/* --- swim: the whole body is pitched face-down by the clip's root override --------- */
CLIP_SPECS.swim = {
  loop: true, duration: 1.7, gait: false, rootPitch: -76, rootLift: 0.34,
  keys: [
    [0.0, {
      pelvis: [4, 0, 0], spine: [-10, 4, 0], chest: [-12, 6, 0], neck: [26, -4, 0], head: [22, -6, 0],
      shoulderL: [0, 0, 10], armL: [-96, -10, 22], forearmL: [30, 0, 8], handL: [0, 0, 6],
      shoulderR: [0, 0, -10], armR: [40, 10, -30], forearmR: [46, 0, -8], handR: [0, 0, -6],
      thighL: [16, 0, 4], shinL: [-34, 0, 0], footL: [-14, 0, 0],
      thighR: [-14, 0, -4], shinR: [-16, 0, 0], footR: [-8, 0, 0],
      _root: [0, 0.02, 0]
    }],
    [0.42, {
      pelvis: [4, 0, 0], spine: [-10, 0, 0], chest: [-12, 0, 0], neck: [26, 0, 0], head: [22, 0, 0],
      shoulderL: [0, 0, 10], armL: [-60, -10, 34], forearmL: [52, 0, 8], handL: [0, 0, 6],
      shoulderR: [0, 0, -10], armR: [-16, 10, -34], forearmR: [52, 0, -8], handR: [0, 0, -6],
      thighL: [-12, 0, 4], shinL: [-18, 0, 0], footL: [-10, 0, 0],
      thighR: [14, 0, -4], shinR: [-32, 0, 0], footR: [-12, 0, 0],
      _root: [0, 0.01, 0]
    }],
    [0.85, {
      pelvis: [4, 0, 0], spine: [-10, -4, 0], chest: [-12, -6, 0], neck: [26, 4, 0], head: [22, 6, 0],
      shoulderL: [0, 0, 10], armL: [40, -10, 30], forearmL: [46, 0, 8], handL: [0, 0, 6],
      shoulderR: [0, 0, -10], armR: [-96, 10, -22], forearmR: [30, 0, -8], handR: [0, 0, -6],
      thighL: [-14, 0, 4], shinL: [-16, 0, 0], footL: [-8, 0, 0],
      thighR: [16, 0, -4], shinR: [-34, 0, 0], footR: [-14, 0, 0],
      _root: [0, 0.02, 0]
    }],
    [1.27, {
      pelvis: [4, 0, 0], spine: [-10, 0, 0], chest: [-12, 0, 0], neck: [26, 0, 0], head: [22, 0, 0],
      shoulderL: [0, 0, 10], armL: [-16, -10, 34], forearmL: [52, 0, 8], handL: [0, 0, 6],
      shoulderR: [0, 0, -10], armR: [-60, 10, -34], forearmR: [52, 0, -8], handR: [0, 0, -6],
      thighL: [14, 0, 4], shinL: [-32, 0, 0], footL: [-12, 0, 0],
      thighR: [-12, 0, -4], shinR: [-18, 0, 0], footR: [-10, 0, 0],
      _root: [0, 0.01, 0]
    }],
    [1.7, {
      pelvis: [4, 0, 0], spine: [-10, 4, 0], chest: [-12, 6, 0], neck: [26, -4, 0], head: [22, -6, 0],
      shoulderL: [0, 0, 10], armL: [-96, -10, 22], forearmL: [30, 0, 8], handL: [0, 0, 6],
      shoulderR: [0, 0, -10], armR: [40, 10, -30], forearmR: [46, 0, -8], handR: [0, 0, -6],
      thighL: [16, 0, 4], shinL: [-34, 0, 0], footL: [-14, 0, 0],
      thighR: [-14, 0, -4], shinR: [-16, 0, 0], footR: [-8, 0, 0],
      _root: [0, 0.02, 0]
    }]
  ]
};

/* --- enter / exit vehicle ----------------------------------------------------------- */
CLIP_SPECS.enter = {
  loop: false, duration: 0.8, gait: false,
  keys: [
    [0.0, IDLE_BASE],
    [0.22, {
      pelvis: [0, -14, -3], spine: [8, -8, 2], chest: [6, -14, 3], neck: [-4, 16, 0], head: [-4, 18, 0],
      shoulderL: [0, 0, 8], armL: [-8, -6, 14], forearmL: [30, 0, 6], handL: [0, 0, 4],
      shoulderR: [8, 0, -6], armR: [58, 14, 10], forearmR: [46, 0, -6], handR: [0, 0, -4],
      thighL: [12, -6, 3], shinL: [-26, 0, 0], footL: [10, 0, 0],
      thighR: [34, 10, -6], shinR: [-56, 0, 0], footR: [18, 0, 0],
      _root: [0.03, -0.07, 0.02]
    }],
    [0.5, {
      pelvis: [-4, -22, -4], spine: [16, -10, 3], chest: [12, -18, 4], neck: [-8, 22, 0], head: [-8, 24, 0],
      shoulderL: [0, 0, 8], armL: [16, -10, 18], forearmL: [46, 0, 6], handL: [0, 0, 4],
      shoulderR: [8, 0, -6], armR: [64, 16, 12], forearmR: [52, 0, -6], handR: [0, 0, -4],
      thighL: [40, -8, 5], shinL: [-70, 0, 0], footL: [24, 0, 0],
      thighR: [66, 14, -8], shinR: [-78, 0, 0], footR: [16, 0, 0],
      _root: [0.05, -0.20, 0.06]
    }],
    [0.8, DRIVE_BASE]
  ]
};
CLIP_SPECS.exit = {
  loop: false, duration: 0.76, gait: false,
  keys: [
    [0.0, DRIVE_BASE],
    [0.26, {
      pelvis: [-4, -20, -4], spine: [15, -10, 3], chest: [11, -17, 4], neck: [-8, 21, 0], head: [-8, 23, 0],
      shoulderL: [0, 0, 8], armL: [20, -12, 20], forearmL: [50, 0, 6], handL: [0, 0, 4],
      shoulderR: [8, 0, -6], armR: [60, 15, 12], forearmR: [50, 0, -6], handR: [0, 0, -4],
      thighL: [56, -8, 5], shinL: [-76, 0, 0], footL: [26, 0, 0],
      thighR: [70, 14, -8], shinR: [-80, 0, 0], footR: [18, 0, 0],
      _root: [0.05, -0.22, 0.06]
    }],
    [0.52, {
      pelvis: [0, -10, -2], spine: [8, -6, 2], chest: [5, -10, 2], neck: [-4, 12, 0], head: [-4, 13, 0],
      shoulderL: [0, 0, 8], armL: [-4, -6, 14], forearmL: [26, 0, 6], handL: [0, 0, 4],
      shoulderR: [4, 0, -6], armR: [26, 8, 6], forearmR: [34, 0, -6], handR: [0, 0, -4],
      thighL: [16, -6, 3], shinL: [-32, 0, 0], footL: [12, 0, 0],
      thighR: [26, 8, -5], shinR: [-46, 0, 0], footR: [16, 0, 0],
      _root: [0.02, -0.08, 0.02]
    }],
    [0.76, IDLE_BASE]
  ]
};

/* -------------------------------------------------------------------------- */
/* Clip compilation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A compiled animation clip: key times plus one flat pose buffer holding every key.
 * @typedef {{name:string, loop:boolean, gait:boolean, duration:number, keyCount:number,
 *   times:Float32Array, poses:Float32Array, rootPitch:number, rootLift:number}} Clip
 */

/* --- gait baking ---------------------------------------------------------- */

/** Segment lengths of the rig's legs (metres) and the height of the hip joint at rest. */
const THIGH_LEN = 0.45;
const SHIN_LEN = 0.38;
const LEG_REACH = THIGH_LEN + SHIN_LEN;
const REST_HIP_Y = 0.98 - 0.07;
/** Ankle height when the shoe sole rests on the ground. */
const ANKLE_GROUND = 0.085;
/** Keys generated per baked gait cycle (plus the duplicated wrap key). */
const GAIT_KEYS = 16;

/** Reused output record for {@link gaitFootPath} (build time only). */
const _foot = { z: 0, y: 0, stance: 0, pitch: 0 };

/**
 * Evaluates one leg's ankle trajectory for a normalised leg phase, where 0 is heel strike.
 * The stance segment is a straight backward slide so the planted foot is world-stationary;
 * the swing segment is a smooth arc that lifts and reaches forward again.
 * @param {number} u Leg phase in [0, 1).
 * @param {Object} cfg Gait configuration (`CLIP_SPECS.<state>.legs`).
 * @param {number} zFront Ankle Z at heel strike (negative = ahead of the hip).
 * @param {number} zBack Ankle Z at toe-off (positive = behind the hip).
 * @returns {Object} `_foot` with `z`, `y`, `stance` (0..1) and `pitch` (world foot pitch).
 */
function gaitFootPath(u, cfg, zFront, zBack) {
  const f = cfg.stance;
  if (u < f) {
    const t = u / f;
    _foot.z = zFront + (zBack - zFront) * t;
    _foot.y = ANKLE_GROUND + cfg.heelRise * smoothstep(0.55, 1, t);
    _foot.stance = 1 - smoothstep(0.9, 1, t);
    _foot.pitch = cfg.heelStrike * (1 - smoothstep(0, 0.2, t)) - cfg.toeOff * smoothstep(0.55, 1, t);
  } else {
    const t = (u - f) / (1 - f);
    const e = t * t * (3 - 2 * t);
    _foot.z = zBack + (zFront - zBack) * e;
    _foot.y = ANKLE_GROUND + Math.sin(Math.PI * t) * cfg.lift + cfg.heelRise * (1 - smoothstep(0, 0.3, t));
    _foot.stance = 0;
    _foot.pitch = -cfg.toeOff * (1 - smoothstep(0, 0.35, t)) + cfg.heelStrike * smoothstep(0.55, 1, t);
  }
  return _foot;
}

/**
 * Two-bone analytic IK in the sagittal plane. Writes `[thighPitch, kneeFlexion]` into `out`.
 * @param {number} dz Ankle Z relative to the hip (negative = ahead).
 * @param {number} dy Ankle Y relative to the hip (negative = below).
 * @param {number[]} out Two-element output array.
 * @returns {number[]} out
 */
function legIK(dz, dy, out) {
  let d = Math.hypot(dz, dy);
  const maxD = LEG_REACH * 0.995;
  let z = dz;
  let y = dy;
  if (d > maxD) { const k = maxD / d; z *= k; y *= k; d = maxD; }
  if (d < 0.08) { const k = 0.08 / Math.max(d, 1e-5); z *= k; y *= k; d = 0.08; }
  const theta = Math.atan2(-z, -y);
  const cosA = clamp((THIGH_LEN * THIGH_LEN + d * d - SHIN_LEN * SHIN_LEN) / (2 * THIGH_LEN * d), -1, 1);
  const cosK = clamp((THIGH_LEN * THIGH_LEN + SHIN_LEN * SHIN_LEN - d * d) / (2 * THIGH_LEN * SHIN_LEN), -1, 1);
  out[0] = theta + Math.acos(cosA);
  out[1] = -(Math.PI - Math.acos(cosK));
  return out;
}

/**
 * Replaces a gait clip's leg channels and pelvis height with an IK solution built from a
 * foot trajectory. The hand-authored torso and arm keys are resampled onto the denser key
 * grid, so the upper body keeps its authored timing while the legs stop skating: during
 * stance the ankle slides backward at exactly the cycle speed, and the hip height is derived
 * from how far the stance leg can actually reach.
 * @param {Clip} clip Compiled clip, mutated in place.
 * @param {Object} cfg Gait configuration.
 * @returns {Clip} clip
 */
function bakeGait(clip, cfg) {
  const n = GAIT_KEYS;
  const travel = cfg.stride * cfg.stance;
  const zFront = -travel * cfg.frontFrac;
  const zBack = travel * (1 - cfg.frontFrac);
  const reach = LEG_REACH * 0.985;

  const legZ = new Float64Array(n * 2);
  const legY = new Float64Array(n * 2);
  const legP = new Float64Array(n * 2);
  const legS = new Float64Array(n * 2);
  const hip = new Float64Array(n);
  const known = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const phase = i / n;
    let best = Infinity;
    for (let leg = 0; leg < 2; leg++) {
      let u = phase + (leg === 1 ? 0.5 : 0);
      u -= Math.floor(u);
      const fp = gaitFootPath(u, cfg, zFront, zBack);
      const k = i * 2 + leg;
      legZ[k] = fp.z; legY[k] = fp.y; legP[k] = fp.pitch; legS[k] = fp.stance;
      if (fp.stance > 0.001) {
        const h = reach * reach - fp.z * fp.z;
        if (h > 0) {
          const cand = fp.y + Math.sqrt(h);
          if (cand < best) best = cand;
        }
      }
    }
    if (cfg.hipFixed) { hip[i] = cfg.hipFixed; known[i] = 1; }
    else if (best < Infinity) { hip[i] = best; known[i] = 1; }
    else { hip[i] = 0; known[i] = 0; }
  }

  // Flight phases have no stance leg: bridge them with an arc between the neighbouring
  // supported samples so running keeps its ballistic rise.
  for (let i = 0; i < n; i++) {
    if (known[i]) continue;
    let back = 0;
    let fwd = 0;
    while (back < n && !known[(i - back - 1 + n * 2) % n]) back++;
    while (fwd < n && !known[(i + fwd + 1) % n]) fwd++;
    const a = hip[(i - back - 1 + n * 2) % n];
    const b = hip[(i + fwd + 1) % n];
    const span = back + fwd + 2;
    const t = (back + 1) / span;
    const arc = (cfg.flightArc || 0) * Math.sin(Math.PI * t);
    hip[i] = a + (b - a) * t + arc;
  }
  // One pass of light smoothing removes the kink where support swaps legs.
  const hipSmooth = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    hipSmooth[i] = hip[(i - 1 + n) % n] * 0.25 + hip[i] * 0.5 + hip[(i + 1) % n] * 0.25;
  }

  const times = new Float32Array(n + 1);
  const poses = new Float32Array((n + 1) * POSE_LEN);
  const tmp = new Float32Array(POSE_LEN);
  const ik = [0, 0];
  const legBones = [
    [BONE_INDEX.thighL, BONE_INDEX.shinL, BONE_INDEX.footL],
    [BONE_INDEX.thighR, BONE_INDEX.shinR, BONE_INDEX.footR]
  ];
  const legRoll = [-0.045, 0.045];
  for (let i = 0; i <= n; i++) {
    const idx = i % n;
    const t = i / n;
    times[i] = t * clip.duration;
    sampleClip(clip, t * clip.duration, tmp);
    const hy = hipSmooth[idx];
    tmp[POSE_ROOT + 1] = hy - REST_HIP_Y;
    for (let leg = 0; leg < 2; leg++) {
      const k = idx * 2 + leg;
      legIK(legZ[k], legY[k] - hy, ik);
      const b = legBones[leg];
      tmp[b[0] * POSE_STRIDE] = ik[0];
      tmp[b[0] * POSE_STRIDE + 2] = legRoll[leg];
      tmp[b[1] * POSE_STRIDE] = ik[1];
      tmp[b[1] * POSE_STRIDE + 2] = -legRoll[leg] * 0.45;
      tmp[b[2] * POSE_STRIDE] = legP[k] - ik[0] - ik[1];
      tmp[b[2] * POSE_STRIDE + 2] = 0;
    }
    poses.set(tmp, i * POSE_LEN);
  }
  clip.times = times;
  clip.poses = poses;
  clip.keyCount = n + 1;
  return clip;
}

/**
 * Compiles the hand-authored descriptions into typed arrays. Runs once at module load.
 * @param {Object<string, Object>} specs Raw clip descriptions.
 * @returns {Object<string, Clip>} Compiled clips keyed by state name.
 */
function compileClips(specs) {
  const out = Object.create(null);
  for (const name in specs) {
    const spec = specs[name];
    const keys = spec.keys;
    const n = keys.length;
    const times = new Float32Array(n);
    const poses = new Float32Array(n * POSE_LEN);
    for (let i = 0; i < n; i++) {
      times[i] = keys[i][0];
      poses.set(P(keys[i][1]), i * POSE_LEN);
    }
    out[name] = {
      name,
      loop: !!spec.loop,
      gait: !!spec.gait,
      duration: Math.max(1e-3, spec.duration),
      keyCount: n,
      times,
      poses,
      rootPitch: (spec.rootPitch || 0) * D2R,
      rootLift: spec.rootLift || 0
    };
    if (spec.legs) bakeGait(out[name], spec.legs);
  }
  return out;
}

/** Every compiled clip, keyed by state name. @type {Object<string, Clip>} */
const CLIPS = compileClips(CLIP_SPECS);

/** Every state name the character understands. @type {string[]} */
export const CHARACTER_STATES = Object.keys(CLIPS);

/** Default cross-fade duration per state, seconds (0.12 - 0.25 s per the contract). */
const BLEND_TIME = {
  idle: 0.22, walk: 0.18, run: 0.16, sprint: 0.16, crouch: 0.2, crouchWalk: 0.18,
  jump: 0.12, fall: 0.16, land: 0.12, aim: 0.16, aimWalk: 0.16, shoot: 0.12,
  reload: 0.16, punch: 0.12, hit: 0.12, die: 0.14, drive: 0.22, swim: 0.22,
  enter: 0.18, exit: 0.18
};

/** States that read their phase from the shared gait clock instead of their own timer. */
const GAIT_STATES = { walk: 1, run: 1, sprint: 1, crouchWalk: 1, aimWalk: 1 };

/** Metres of ground covered by one full two-step cycle, per gait. */
const STRIDE_WALK = CLIP_SPECS.walk.legs.stride;
const STRIDE_RUN = CLIP_SPECS.run.legs.stride;
const STRIDE_SPRINT = CLIP_SPECS.sprint.legs.stride;
const STRIDE_CROUCH = CLIP_SPECS.crouchWalk.legs.stride;
const STRIDE_AIM = CLIP_SPECS.aimWalk.legs.stride;
/** Baked stride per gait state. @type {Object<string, number>} */
const STRIDE_BY_STATE = {
  walk: STRIDE_WALK, run: STRIDE_RUN, sprint: STRIDE_SPRINT,
  crouchWalk: STRIDE_CROUCH, aimWalk: STRIDE_AIM
};

/* -------------------------------------------------------------------------- */
/* Mesh construction                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Builds a smooth, elliptical-cross-section limb / torso segment by stacking rings.
 *
 * This is the workhorse behind the humanoid silhouette: plain boxes look like a robot, but a
 * stack of ellipses with rounded ends reads as a tapered organic form. Rings are listed from
 * top to bottom; each carries its own radii, lateral offset and vertex-colour multiplier, so a
 * belt, a collar or a calf bulge is just another ring.
 *
 * @param {Array<{y:number, rx:number, rz:number, x?:number, z?:number, c?:number[]}>} sections
 *   Rings ordered by decreasing `y`.
 * @param {number} seg Radial segments.
 * @param {object} [opts] Options.
 * @param {'round'|'flat'|'none'} [opts.capTop='round'] How the top end is closed.
 * @param {'round'|'flat'|'none'} [opts.capBottom='round'] How the bottom end is closed.
 * @param {number} [opts.capSeg=2] Extra rings per rounded cap.
 * @param {number} [opts.capScale=1] Stretches the rounded caps along Y.
 * @returns {object} Geometry object with smooth normals and vertex colours.
 */
function ringStack(sections, seg, opts) {
  const o = opts || {};
  const capTop = o.capTop === undefined ? 'round' : o.capTop;
  const capBottom = o.capBottom === undefined ? 'round' : o.capBottom;
  const capSeg = Math.max(1, o.capSeg === undefined ? 2 : o.capSeg);
  const capScale = o.capScale === undefined ? 1 : o.capScale;

  const rings = [];
  const first = sections[0];
  const last = sections[sections.length - 1];
  if (capTop === 'round') {
    const rt = (first.rx + first.rz) * 0.5 * capScale;
    for (let i = capSeg; i >= 1; i--) {
      const a = (i / (capSeg + 1)) * Math.PI * 0.5;
      const s = Math.cos(a);
      rings.push({
        y: first.y + Math.sin(a) * rt, rx: first.rx * s, rz: first.rz * s,
        x: first.x, z: first.z, c: first.c
      });
    }
  }
  for (let i = 0; i < sections.length; i++) rings.push(sections[i]);
  if (capBottom === 'round') {
    const rb = (last.rx + last.rz) * 0.5 * capScale;
    for (let i = 1; i <= capSeg; i++) {
      const a = (i / (capSeg + 1)) * Math.PI * 0.5;
      const s = Math.cos(a);
      rings.push({
        y: last.y - Math.sin(a) * rb, rx: last.rx * s, rz: last.rz * s,
        x: last.x, z: last.z, c: last.c
      });
    }
  }

  const rn = rings.length;
  const cols = seg + 1;
  const flatTop = capTop === 'flat' ? 1 : 0;
  const flatBottom = capBottom === 'flat' ? 1 : 0;
  const vertCount = rn * cols + (flatTop + flatBottom) * (cols + 1);
  const triCount = (rn - 1) * seg * 2 + (flatTop + flatBottom) * seg;
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const colors = new Float32Array(vertCount * 3);
  const indices = new Uint32Array(triCount * 3);

  // Total profile length for a roughly arc-length v coordinate.
  let vp = 0;
  let ip = 0;
  const yTop = rings[0].y;
  const ySpan = Math.max(1e-4, yTop - rings[rn - 1].y);
  for (let r = 0; r < rn; r++) {
    const ring = rings[r];
    const ox = ring.x || 0;
    const oz = ring.z || 0;
    const c = ring.c;
    const cr = c ? c[0] : 1, cg = c ? c[1] : 1, cb = c ? c[2] : 1;
    const v = (yTop - ring.y) / ySpan;
    for (let j = 0; j < cols; j++) {
      const th = (j / seg) * Math.PI * 2;
      const p = (r * cols + j) * 3;
      positions[p] = ox + Math.cos(th) * ring.rx;
      positions[p + 1] = ring.y;
      positions[p + 2] = oz + Math.sin(th) * ring.rz;
      const u = (r * cols + j) * 2;
      uvs[u] = j / seg;
      uvs[u + 1] = v;
      colors[p] = cr; colors[p + 1] = cg; colors[p + 2] = cb;
    }
  }
  vp = rn * cols;
  for (let r = 0; r + 1 < rn; r++) {
    for (let j = 0; j < seg; j++) {
      const a = r * cols + j;
      const b = (r + 1) * cols + j;
      indices[ip++] = a; indices[ip++] = b; indices[ip++] = b + 1;
      indices[ip++] = a; indices[ip++] = b + 1; indices[ip++] = a + 1;
    }
  }
  // Flat caps: a fan around a centre vertex. Top faces +Y (CCW seen from above),
  // bottom faces -Y.
  if (flatTop) {
    const ring = rings[0];
    const base = vp;
    const cx = ring.x || 0, cz = ring.z || 0;
    const c = ring.c;
    const cr = c ? c[0] : 1, cg = c ? c[1] : 1, cb = c ? c[2] : 1;
    for (let j = 0; j < cols; j++) {
      const th = (j / seg) * Math.PI * 2;
      const p = (base + j) * 3;
      positions[p] = cx + Math.cos(th) * ring.rx;
      positions[p + 1] = ring.y;
      positions[p + 2] = cz + Math.sin(th) * ring.rz;
      uvs[(base + j) * 2] = 0.5 + Math.cos(th) * 0.5;
      uvs[(base + j) * 2 + 1] = 0.5 + Math.sin(th) * 0.5;
      colors[p] = cr; colors[p + 1] = cg; colors[p + 2] = cb;
    }
    const centre = base + cols;
    positions[centre * 3] = cx; positions[centre * 3 + 1] = ring.y; positions[centre * 3 + 2] = cz;
    uvs[centre * 2] = 0.5; uvs[centre * 2 + 1] = 0.5;
    colors[centre * 3] = cr; colors[centre * 3 + 1] = cg; colors[centre * 3 + 2] = cb;
    for (let j = 0; j < seg; j++) {
      indices[ip++] = centre; indices[ip++] = base + j + 1; indices[ip++] = base + j;
    }
    vp += cols + 1;
  }
  if (flatBottom) {
    const ring = rings[rn - 1];
    const base = vp;
    const cx = ring.x || 0, cz = ring.z || 0;
    const c = ring.c;
    const cr = c ? c[0] : 1, cg = c ? c[1] : 1, cb = c ? c[2] : 1;
    for (let j = 0; j < cols; j++) {
      const th = (j / seg) * Math.PI * 2;
      const p = (base + j) * 3;
      positions[p] = cx + Math.cos(th) * ring.rx;
      positions[p + 1] = ring.y;
      positions[p + 2] = cz + Math.sin(th) * ring.rz;
      uvs[(base + j) * 2] = 0.5 + Math.cos(th) * 0.5;
      uvs[(base + j) * 2 + 1] = 0.5 + Math.sin(th) * 0.5;
      colors[p] = cr; colors[p + 1] = cg; colors[p + 2] = cb;
    }
    const centre = base + cols;
    positions[centre * 3] = cx; positions[centre * 3 + 1] = ring.y; positions[centre * 3 + 2] = cz;
    uvs[centre * 2] = 0.5; uvs[centre * 2 + 1] = 0.5;
    colors[centre * 3] = cr; colors[centre * 3 + 1] = cg; colors[centre * 3 + 2] = cb;
    for (let j = 0; j < seg; j++) {
      indices[ip++] = centre; indices[ip++] = base + j; indices[ip++] = base + j + 1;
    }
    vp += cols + 1;
  }

  const geo = { positions, normals: new Float32Array(vertCount * 3), uvs, indices, colors };
  computeNormals(geo);
  computeBounds(geo);
  return geo;
}

/** Scratch matrix used only while building the (one-off) shared meshes. */
const _bm = mat4.create();
const _bq = quat.create();
const _bp = vec3.create();

/**
 * Convenience: places a primitive with an euler rotation (degrees) and a translation.
 * Build-time only, never called per frame.
 * @param {object} geo Geometry to transform in place.
 * @param {number} x Translation X.
 * @param {number} y Translation Y.
 * @param {number} z Translation Z.
 * @param {number} [rx=0] Pitch in degrees.
 * @param {number} [ry=0] Yaw in degrees.
 * @param {number} [rz=0] Roll in degrees.
 * @param {number[]} [scale] Optional non-uniform scale.
 * @returns {object} The same geometry.
 */
function place(geo, x, y, z, rx, ry, rz, scale) {
  quat.fromEuler(_bq, (ry || 0) * D2R, (rx || 0) * D2R, (rz || 0) * D2R);
  vec3.set(_bp, x, y, z);
  mat4.compose(_bm, _bp, _bq, scale || 1);
  transformGeometry(geo, _bm);
  return geo;
}

/** Vertex-colour accents (multiplied by the per-instance tint in the vertex shader). */
const C_DARK = [0.42, 0.42, 0.45];
const C_DARKER = [0.26, 0.26, 0.29];
const C_LIGHT = [1.16, 1.16, 1.18];
const C_SOLE = [0.3, 0.3, 0.32];
const C_SHADE = [0.82, 0.82, 0.84];

/**
 * Builds every shared body-part geometry once. Positions are authored directly in the local
 * frame of the bone that drives the part, so a part's model matrix is simply
 * `boneWorld * perCharacterShapeScale`.
 * @returns {Object<string, object>} Geometry keyed by part id.
 */
function buildPartGeometries() {
  const g = Object.create(null);
  const SEG = 14;

  /* --- head ------------------------------------------------------------- */
  // The head bone sits at the base of the skull (ear height), so the profile runs from the
  // chin at -0.04 up to a crown at ~0.20: a 0.25 m head on a 1.8 m body.
  const skull = ringStack([
    { y: 0.130, rx: 0.084, rz: 0.089 },
    { y: 0.098, rx: 0.096, rz: 0.102 },
    { y: 0.062, rx: 0.095, rz: 0.101 },
    { y: 0.030, rx: 0.088, rz: 0.097 },
    { y: 0.004, rx: 0.079, rz: 0.090 },
    { y: -0.020, rx: 0.066, rz: 0.078 },
    { y: -0.038, rx: 0.052, rz: 0.064 }
  ], 14, { capTop: 'round', capBottom: 'round', capSeg: 2, capScale: 0.72 });
  place(skull, 0, 0, -0.004);
  const nose = place(cone(0.016, 0.038, 6), 0, 0.036, -0.086, -100);
  const earL = place(sphere(0.026, 8, 6), -0.092, 0.040, 0.012, 0, 0, 0, [0.42, 1.05, 0.72]);
  const earR = place(sphere(0.026, 8, 6), 0.092, 0.040, 0.012, 0, 0, 0, [0.42, 1.05, 0.72]);
  const eyeL = place(sphere(0.013, 7, 5), -0.034, 0.058, -0.079, 0, 0, 0, [1, 0.62, 0.5]);
  const eyeR = place(sphere(0.013, 7, 5), 0.034, 0.058, -0.079, 0, 0, 0, [1, 0.62, 0.5]);
  const mouth = place(box(0.032, 0.007, 0.011), 0, -0.008, -0.072);
  g.head = mergeGeometries([
    { geometry: skull },
    { geometry: nose },
    { geometry: earL }, { geometry: earR },
    { geometry: eyeL, color: C_DARKER }, { geometry: eyeR, color: C_DARKER },
    { geometry: mouth, color: [0.66, 0.42, 0.40] }
  ]);

  /* --- hair: a thin shell over the crown plus a nape and sideburns -------- */
  const hairShell = ringStack([
    { y: 0.148, rx: 0.078, rz: 0.084, z: 0.004 },
    { y: 0.120, rx: 0.099, rz: 0.105, z: 0.005 },
    { y: 0.088, rx: 0.104, rz: 0.109, z: 0.011 },
    { y: 0.048, rx: 0.101, rz: 0.104, z: 0.022 },
    { y: 0.006, rx: 0.092, rz: 0.094, z: 0.034 }
  ], 14, { capTop: 'round', capBottom: 'flat', capSeg: 2, capScale: 0.9 });
  const fringe = place(roundedBox(0.128, 0.034, 0.052, 0.014, 1), 0, 0.126, -0.052, -22);
  g.hair = mergeGeometries([
    { geometry: hairShell },
    { geometry: fringe, color: C_SHADE }
  ]);
  g.ponytail = mergeGeometries([
    { geometry: place(capsule(0.038, 0.13, 8, 3), 0, -0.020, 0.118, 20) },
    { geometry: place(cylinder(0.026, 0.034, 0.03, 8), 0, 0.046, 0.104), color: C_DARKER }
  ]);

  /* --- cop cap ---------------------------------------------------------- */
  const capCrown = ringStack([
    { y: 0.184, rx: 0.086, rz: 0.092 },
    { y: 0.146, rx: 0.106, rz: 0.111 },
    { y: 0.114, rx: 0.108, rz: 0.113 }
  ], 14, { capTop: 'round', capBottom: 'flat', capSeg: 2, capScale: 0.68 });
  const capBrim = place(cylinder(0.106, 0.110, 0.012, 14), 0, 0.110, -0.078, -12, 0, 0, [1.0, 1, 1.30]);
  const capBand = ringStack([
    { y: 0.118, rx: 0.110, rz: 0.115 },
    { y: 0.100, rx: 0.110, rz: 0.115 }
  ], 14, { capTop: 'none', capBottom: 'none' });
  const capBadge = place(box(0.036, 0.030, 0.012), 0, 0.146, -0.104, -12);
  g.cap = mergeGeometries([
    { geometry: capCrown },
    { geometry: capBrim, color: C_DARK },
    { geometry: capBand, color: C_DARKER },
    { geometry: capBadge, color: [2.2, 1.9, 0.8] }
  ]);

  /* --- neck ------------------------------------------------------------- */
  g.neck = ringStack([
    { y: 0.085, rx: 0.050, rz: 0.050 },
    { y: 0.010, rx: 0.056, rz: 0.055 },
    { y: -0.075, rx: 0.072, rz: 0.070 }
  ], 10, { capTop: 'none', capBottom: 'none' });

  /* --- chest ------------------------------------------------------------ */
  const torso = ringStack([
    { y: 0.205, rx: 0.101, rz: 0.087 },
    { y: 0.172, rx: 0.149, rz: 0.106 },
    { y: 0.118, rx: 0.159, rz: 0.114 },
    { y: 0.042, rx: 0.150, rz: 0.115 },
    { y: -0.030, rx: 0.139, rz: 0.107 },
    { y: -0.095, rx: 0.130, rz: 0.100 }
  ], SEG + 2, { capTop: 'flat', capBottom: 'none', capSeg: 2 });
  const collar = ringStack([
    { y: 0.218, rx: 0.083, rz: 0.078 },
    { y: 0.188, rx: 0.100, rz: 0.090 }
  ], SEG + 2, { capTop: 'none', capBottom: 'none' });
  const deltoidL = place(sphere(0.070, 10, 8), -0.136, 0.144, 0.002, 0, 0, 0, [1.02, 0.74, 0.88]);
  const deltoidR = place(sphere(0.070, 10, 8), 0.136, 0.144, 0.002, 0, 0, 0, [1.02, 0.74, 0.88]);
  const lapelL = place(box(0.052, 0.150, 0.020), -0.046, 0.110, -0.100, 0, 0, 10);
  const lapelR = place(box(0.052, 0.150, 0.020), 0.046, 0.110, -0.100, 0, 0, -10);
  const zip = place(box(0.014, 0.290, 0.016), 0, 0.060, -0.106);
  g.chest = mergeGeometries([
    { geometry: torso },
    { geometry: deltoidL }, { geometry: deltoidR },
    { geometry: collar, color: C_DARK },
    { geometry: lapelL, color: C_SHADE }, { geometry: lapelR, color: C_SHADE },
    { geometry: zip, color: C_DARKER }
  ]);

  /* --- cop vest + gangster hood (both ride the chest bone) --------------- */
  const vestShell = ringStack([
    { y: 0.182, rx: 0.152, rz: 0.116 },
    { y: 0.112, rx: 0.172, rz: 0.130 },
    { y: 0.020, rx: 0.164, rz: 0.126 },
    { y: -0.062, rx: 0.150, rz: 0.116 }
  ], SEG + 2, { capTop: 'flat', capBottom: 'flat', capSeg: 1 });
  const radio = place(box(0.048, 0.075, 0.032), -0.132, 0.140, -0.074, 0, 0, 8);
  const shoulderPatch = place(box(0.036, 0.030, 0.052), 0.156, 0.150, 0.010);
  g.vest = mergeGeometries([
    { geometry: vestShell },
    { geometry: radio, color: C_DARKER },
    { geometry: shoulderPatch, color: [1.8, 1.7, 0.9] }
  ]);
  g.hood = mergeGeometries([
    { geometry: place(sphere(0.118, 12, 8), 0, 0.215, 0.104, 0, 0, 0, [1.05, 0.72, 0.92]) },
    { geometry: place(cylinder(0.086, 0.118, 0.09, 12), 0, 0.252, 0.074, 22), color: C_SHADE }
  ]);

  /* --- abdomen ---------------------------------------------------------- */
  g.spine = ringStack([
    { y: 0.098, rx: 0.134, rz: 0.101 },
    { y: 0.020, rx: 0.126, rz: 0.095 },
    { y: -0.062, rx: 0.122, rz: 0.093 }
  ], SEG + 2, { capTop: 'none', capBottom: 'none' });

  /* --- pelvis ----------------------------------------------------------- */
  const hips = ringStack([
    { y: 0.086, rx: 0.124, rz: 0.096 },
    { y: 0.062, rx: 0.132, rz: 0.100, c: C_DARKER },
    { y: 0.028, rx: 0.135, rz: 0.102, c: C_DARKER },
    { y: -0.010, rx: 0.137, rz: 0.105 },
    { y: -0.072, rx: 0.132, rz: 0.102 },
    { y: -0.128, rx: 0.116, rz: 0.096 }
  ], SEG + 2, { capTop: 'none', capBottom: 'flat', capSeg: 1 });
  const buckle = place(box(0.046, 0.036, 0.016), 0, 0.046, -0.100);
  g.pelvis = mergeGeometries([
    { geometry: hips },
    { geometry: buckle, color: [1.9, 1.7, 1.0] }
  ]);
  g.skirt = ringStack([
    { y: 0.020, rx: 0.140, rz: 0.108 },
    { y: -0.090, rx: 0.170, rz: 0.140 },
    { y: -0.230, rx: 0.205, rz: 0.178 },
    { y: -0.255, rx: 0.200, rz: 0.174 }
  ], SEG + 2, { capTop: 'none', capBottom: 'flat', capSeg: 1 });

  /* --- arms ------------------------------------------------------------- */
  const upperArm = ringStack([
    { y: -0.008, rx: 0.059, rz: 0.059 },
    { y: -0.095, rx: 0.051, rz: 0.053 },
    { y: -0.195, rx: 0.044, rz: 0.046 },
    { y: -0.272, rx: 0.042, rz: 0.044 }
  ], SEG, { capTop: 'round', capBottom: 'round', capSeg: 2, capScale: 0.95 });
  g.armL = upperArm;
  g.armR = ringStack([
    { y: -0.008, rx: 0.059, rz: 0.059 },
    { y: -0.095, rx: 0.051, rz: 0.053 },
    { y: -0.195, rx: 0.044, rz: 0.046 },
    { y: -0.272, rx: 0.042, rz: 0.044 }
  ], SEG, { capTop: 'round', capBottom: 'round', capSeg: 2, capScale: 0.95 });

  const foreProfile = [
    { y: -0.006, rx: 0.044, rz: 0.046 },
    { y: -0.085, rx: 0.039, rz: 0.041 },
    { y: -0.175, rx: 0.031, rz: 0.033 },
    { y: -0.243, rx: 0.028, rz: 0.030 }
  ];
  g.forearmL = ringStack(foreProfile, SEG, { capTop: 'round', capBottom: 'round', capSeg: 2, capScale: 0.9 });
  g.forearmR = ringStack(foreProfile, SEG, { capTop: 'round', capBottom: 'round', capSeg: 2, capScale: 0.9 });

  /**
   * Builds one hand; `side` is -1 for the left hand and +1 for the right.
   * @param {number} side Mirror sign.
   * @returns {object} Geometry.
   */
  const hand = (side) => mergeGeometries([
    { geometry: place(roundedBox(0.064, 0.086, 0.034, 0.015, 1), 0, -0.048, -0.002) },
    { geometry: place(roundedBox(0.060, 0.056, 0.030, 0.014, 1), 0.004 * side, -0.100, -0.010, -6) },
    { geometry: place(capsule(0.013, 0.030, 5, 1), 0.034 * side, -0.038, -0.014, 20, 0, -34 * side) }
  ]);
  g.handL = hand(-1);
  g.handR = hand(1);

  /* --- legs -------------------------------------------------------------- */
  const thighProfile = [
    { y: -0.018, rx: 0.087, rz: 0.090 },
    { y: -0.150, rx: 0.079, rz: 0.083 },
    { y: -0.300, rx: 0.068, rz: 0.072 },
    { y: -0.428, rx: 0.061, rz: 0.063 }
  ];
  g.thighL = ringStack(thighProfile, SEG, { capTop: 'round', capBottom: 'round', capSeg: 2, capScale: 0.85 });
  g.thighR = ringStack(thighProfile, SEG, { capTop: 'round', capBottom: 'round', capSeg: 2, capScale: 0.85 });

  const shinProfile = [
    { y: -0.012, rx: 0.061, rz: 0.063 },
    { y: -0.098, rx: 0.059, rz: 0.066, z: 0.008 },
    { y: -0.235, rx: 0.045, rz: 0.048, z: 0.004 },
    { y: -0.348, rx: 0.037, rz: 0.039 }
  ];
  g.shinL = ringStack(shinProfile, SEG, { capTop: 'round', capBottom: 'round', capSeg: 2, capScale: 0.8 });
  g.shinR = ringStack(shinProfile, SEG, { capTop: 'round', capBottom: 'round', capSeg: 2, capScale: 0.8 });

  const shoe = () => mergeGeometries([
    { geometry: place(roundedBox(0.098, 0.030, 0.252, 0.013, 1), 0, -0.060, -0.036), color: C_SOLE },
    { geometry: place(roundedBox(0.090, 0.064, 0.196, 0.024, 1), 0, -0.026, -0.056, 3) },
    { geometry: place(roundedBox(0.084, 0.062, 0.090, 0.022, 1), 0, -0.014, 0.030) },
    { geometry: place(box(0.062, 0.016, 0.070), 0, 0.004, -0.052), color: C_DARKER }
  ]);
  g.footL = shoe();
  g.footR = shoe();

  /* --- held weapon (generic, reads as pistol / SMG) ---------------------- */
  g.weapon = mergeGeometries([
    { geometry: place(box(0.036, 0.062, 0.190), 0, -0.048, -0.086), color: C_DARK },
    { geometry: place(cylinder(0.012, 0.013, 0.110, 8), 0, -0.040, -0.214, -90), color: C_DARKER },
    { geometry: place(box(0.032, 0.096, 0.048), 0, -0.092, -0.010, 14), color: C_DARKER },
    { geometry: place(box(0.026, 0.070, 0.040), 0, -0.108, -0.048, 6), color: C_DARK },
    { geometry: place(box(0.010, 0.016, 0.030), 0, -0.012, -0.130), color: C_LIGHT }
  ]);

  return g;
}

/**
 * Static part table. `tint` names the colour slot each part samples from the character:
 *   skin | hair | shirt | pants | shoe | accent | gear | sleeve (upper arm: shirt or skin) |
 *   cuff (forearm: shirt only with long sleeves) | leg (shin: pants or skin).
 * `kinds` restricts a part to certain character kinds; `optional` parts are enabled per
 * character. `lodCut` drops the part once the LOD level reaches that value.
 * @type {Array<{id:string, bone:string, tint:string, kinds:?string[], optional:boolean, lodCut:number}>}
 */
const PART_DEFS = [
  { id: 'head', bone: 'head', tint: 'skin', kinds: null, optional: false, lodCut: 9 },
  { id: 'hair', bone: 'head', tint: 'hair', kinds: null, optional: true, lodCut: 9 },
  { id: 'ponytail', bone: 'head', tint: 'hair', kinds: null, optional: true, lodCut: 2 },
  { id: 'cap', bone: 'head', tint: 'accent', kinds: null, optional: true, lodCut: 9 },
  { id: 'neck', bone: 'neck', tint: 'skin', kinds: null, optional: false, lodCut: 2 },
  { id: 'chest', bone: 'chest', tint: 'shirt', kinds: null, optional: false, lodCut: 9 },
  { id: 'vest', bone: 'chest', tint: 'accent', kinds: null, optional: true, lodCut: 9 },
  { id: 'hood', bone: 'chest', tint: 'shirt', kinds: null, optional: true, lodCut: 9 },
  { id: 'spine', bone: 'spine', tint: 'shirt', kinds: null, optional: false, lodCut: 9 },
  { id: 'pelvis', bone: 'pelvis', tint: 'pants', kinds: null, optional: false, lodCut: 9 },
  { id: 'skirt', bone: 'pelvis', tint: 'pants', kinds: null, optional: true, lodCut: 9 },
  { id: 'armL', bone: 'armL', tint: 'sleeve', kinds: null, optional: false, lodCut: 9 },
  { id: 'armR', bone: 'armR', tint: 'sleeve', kinds: null, optional: false, lodCut: 9 },
  { id: 'forearmL', bone: 'forearmL', tint: 'cuff', kinds: null, optional: false, lodCut: 9 },
  { id: 'forearmR', bone: 'forearmR', tint: 'cuff', kinds: null, optional: false, lodCut: 9 },
  { id: 'handL', bone: 'handL', tint: 'skin', kinds: null, optional: false, lodCut: 2 },
  { id: 'handR', bone: 'handR', tint: 'skin', kinds: null, optional: false, lodCut: 2 },
  { id: 'thighL', bone: 'thighL', tint: 'pants', kinds: null, optional: false, lodCut: 9 },
  { id: 'thighR', bone: 'thighR', tint: 'pants', kinds: null, optional: false, lodCut: 9 },
  { id: 'shinL', bone: 'shinL', tint: 'leg', kinds: null, optional: false, lodCut: 9 },
  { id: 'shinR', bone: 'shinR', tint: 'leg', kinds: null, optional: false, lodCut: 9 },
  { id: 'footL', bone: 'footL', tint: 'shoe', kinds: null, optional: false, lodCut: 9 },
  { id: 'footR', bone: 'footR', tint: 'shoe', kinds: null, optional: false, lodCut: 9 },
  { id: 'weapon', bone: 'handR', tint: 'gear', kinds: null, optional: true, lodCut: 3 }
];

/** Which material each part uses. */
const PART_MATERIAL = {
  head: 'skin', neck: 'skin', handL: 'skin', handR: 'skin',
  hair: 'hair', ponytail: 'hair',
  cap: 'leather', vest: 'leather', footL: 'leather', footR: 'leather', weapon: 'gear',
  chest: 'cloth', hood: 'cloth', spine: 'cloth', pelvis: 'cloth', skirt: 'cloth',
  armL: 'cloth', armR: 'cloth', forearmL: 'skin', forearmR: 'skin',
  thighL: 'cloth', thighR: 'cloth', shinL: 'cloth', shinR: 'cloth'
};

/** Number of body parts. @type {number} */
const PART_COUNT = PART_DEFS.length;

/** Part id -> index. @type {Object<string, number>} */
const PART_INDEX = (() => {
  const m = Object.create(null);
  for (let i = 0; i < PART_DEFS.length; i++) m[PART_DEFS[i].id] = i;
  return m;
})();

/** Local muzzle offset in the right-hand bone frame (metres). */
const MUZZLE_LOCAL = new Float32Array([0, -0.040, -0.272]);

/** Leg parts that show skin instead of trousers when a skirt is worn. */
const SKIRT_BARE_PARTS = ['thighL', 'thighR', 'shinL', 'shinR'];

/**
 * Builds the shared, immutable character asset set: one geometry, material and instanced
 * batch per body part. Call this once at load time and pass the result to every
 * {@link Character}.
 *
 * @param {WebGL2RenderingContext} gl GL context.
 * @param {Object} renderer Renderer (may be null for headless use; batches are then skipped).
 * @param {Object} [textures] Texture library from `render/textures.js` (optional).
 * @param {Object} [opts] Options.
 * @param {number} [opts.capacity=192] Maximum characters drawn through the instanced path.
 * @returns {Object} CharacterAssets.
 */
export function buildCharacterMeshes(gl, renderer, textures, opts) {
  const o = opts || {};
  const capacity = Math.max(8, o.capacity === undefined ? 192 : o.capacity | 0);
  const tex = textures || null;
  const clothNormal = tex && tex.concrete_n ? tex.concrete_n : null;

  const materials = {
    skin: createMaterial({
      name: 'charSkin', albedo: [1, 1, 1], roughness: 0.62, metallic: 0,
      reflectance: 0.4, vertexColors: true
    }),
    cloth: createMaterial({
      name: 'charCloth', albedo: [1, 1, 1], roughness: 0.94, metallic: 0,
      reflectance: 0.32, vertexColors: true,
      normalMap: clothNormal, normalScale: clothNormal ? 0.35 : 1, uvScale: [3, 3]
    }),
    hair: createMaterial({
      name: 'charHair', albedo: [1, 1, 1], roughness: 0.55, metallic: 0,
      reflectance: 0.45, vertexColors: true
    }),
    leather: createMaterial({
      name: 'charLeather', albedo: [1, 1, 1], roughness: 0.48, metallic: 0,
      reflectance: 0.55, vertexColors: true
    }),
    gear: createMaterial({
      name: 'charGear', albedo: [1, 1, 1], roughness: 0.34, metallic: 0.7,
      reflectance: 0.6, vertexColors: true
    })
  };

  const geos = buildPartGeometries();
  const parts = new Array(PART_COUNT);
  let triangles = 0;
  for (let i = 0; i < PART_COUNT; i++) {
    const def = PART_DEFS[i];
    const geometry = geos[def.id];
    const material = materials[PART_MATERIAL[def.id]] || materials.cloth;
    triangles += geometryTriangleCount(geometry);
    let batch = null;
    if (renderer && typeof renderer.addInstanced === 'function') {
      batch = renderer.addInstanced(geometry, material, capacity);
      batch.setCount(0);
    }
    parts[i] = {
      id: def.id,
      index: i,
      bone: BONE_INDEX[def.bone],
      tint: def.tint,
      optional: def.optional,
      lodCut: def.lodCut,
      geometry,
      material,
      batch,
      cursor: 0
    };
  }

  const assets = {
    gl,
    renderer: renderer || null,
    parts,
    partIndex: PART_INDEX,
    partCount: PART_COUNT,
    materials,
    capacity,
    /** Triangles in one fully equipped character. */
    triangles,
    /** Set true by an integrator that calls beginFrame()/flush() itself. */
    manualFrames: false,
    _frameToken: -1,
    _shapeCache: new Map(),

    /**
     * Resets every batch write cursor. Called automatically when a new render frame is
     * detected, or manually by an integrator that prefers to drive it.
     * @returns {void}
     */
    beginFrame() {
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        p.cursor = 0;
        if (p.batch) p.batch.setCount(0);
      }
    },

    /**
     * Publishes the instance counts written since {@link beginFrame}.
     * @returns {void}
     */
    flush() {
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p.batch) p.batch.setCount(p.cursor);
      }
    },

    /** Frees the GPU resources owned by the asset set. @returns {void} */
    dispose() {
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].batch && typeof parts[i].batch.dispose === 'function') parts[i].batch.dispose();
        parts[i].batch = null;
      }
      assets._shapeCache.clear();
    }
  };
  return assets;
}

/* -------------------------------------------------------------------------- */
/* Pose sampling                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Uniform Catmull-Rom through four scalar samples expressed relative to `p1`.
 * @param {number} a0 Previous sample, relative.
 * @param {number} a2 Next sample, relative.
 * @param {number} a3 Sample after next, relative.
 * @param {number} u Interpolant in [0, 1].
 * @returns {number} Offset from `p1`.
 */
function catmull(a0, a2, a3, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * ((-a0 + a2) * u + (2 * a0 + 4 * a2 - a3) * u2 + (-a0 - 3 * a2 + a3) * u3);
}

/**
 * Samples a compiled clip into a pose buffer with C1-continuous Catmull-Rom interpolation.
 * Angle channels take the shortest path around the circle; the three trailing translation
 * channels are interpolated linearly in the same spline.
 * @param {Clip} clip Compiled clip.
 * @param {number} time Time in seconds (or gait phase * duration).
 * @param {Float32Array} out Destination pose buffer of length {@link POSE_LEN}.
 * @returns {Float32Array} out
 */
function sampleClip(clip, time, out) {
  const n = clip.keyCount;
  const times = clip.times;
  const poses = clip.poses;
  const dur = clip.duration;
  let t = time;
  if (clip.loop) {
    t = t % dur;
    if (t < 0) t += dur;
  } else {
    t = t < 0 ? 0 : (t > dur ? dur : t);
  }
  // Locate the segment (clips have <= 8 keys, a linear scan is the fastest thing here).
  let i = 0;
  while (i < n - 2 && times[i + 1] <= t) i++;
  const t0 = times[i];
  const t1 = times[i + 1];
  const span = t1 - t0;
  let u = span > 1e-6 ? (t - t0) / span : 0;
  if (u < 0) u = 0; else if (u > 1) u = 1;

  const last = n - 1;
  let im1 = i - 1;
  let ip2 = i + 2;
  if (clip.loop) {
    // The final key duplicates the first one in looping clips, so wrap past it.
    if (im1 < 0) im1 = last - 1;
    if (ip2 > last) ip2 = ip2 - last;
  } else {
    if (im1 < 0) im1 = 0;
    if (ip2 > last) ip2 = last;
  }

  const b0 = im1 * POSE_LEN;
  const b1 = i * POSE_LEN;
  const b2 = (i + 1) * POSE_LEN;
  const b3 = ip2 * POSE_LEN;

  for (let c = 0; c < POSE_ROOT; c++) {
    const p1 = poses[b1 + c];
    const a0 = wrapAngle(poses[b0 + c] - p1);
    const a2 = wrapAngle(poses[b2 + c] - p1);
    const a3 = a2 + wrapAngle(poses[b3 + c] - poses[b2 + c]);
    out[c] = p1 + catmull(a0, a2, a3, u);
  }
  for (let c = POSE_ROOT; c < POSE_LEN; c++) {
    const p1 = poses[b1 + c];
    const a0 = poses[b0 + c] - p1;
    const a2 = poses[b2 + c] - p1;
    const a3 = a2 + (poses[b3 + c] - poses[b2 + c]);
    out[c] = p1 + catmull(a0, a2, a3, u);
  }
  return out;
}

/**
 * Blends pose `b` into pose `a` and writes the result to `out` (aliasing `a` is allowed).
 * @param {Float32Array} out Destination.
 * @param {Float32Array} a Source at t = 0.
 * @param {Float32Array} b Source at t = 1.
 * @param {number} t Weight in [0, 1].
 * @returns {Float32Array} out
 */
function blendPose(out, a, b, t) {
  for (let c = 0; c < POSE_ROOT; c++) out[c] = angleLerp(a[c], b[c], t);
  for (let c = POSE_ROOT; c < POSE_LEN; c++) out[c] = a[c] + (b[c] - a[c]) * t;
  return out;
}

/* --- module scratch (never allocated per frame) ---------------------------- */
const _sq = quat.create();
const _sq2 = quat.create();
const _sq3 = quat.create();
const _sq4 = quat.create();
const _sp = vec3.create();
const _sp2 = vec3.create();
const _sm = mat4.create();
const _sm2 = mat4.create();
const _tint4 = new Float32Array(4);
const _defaultCtx = {};

/** Default palettes used when the caller does not specify colours. */
const SKIN_TONES = [
  [0.86, 0.69, 0.56], [0.78, 0.58, 0.45], [0.68, 0.48, 0.36],
  [0.52, 0.35, 0.25], [0.38, 0.25, 0.18], [0.92, 0.77, 0.66]
];
const HAIR_TONES = [
  [0.07, 0.055, 0.05], [0.14, 0.09, 0.06], [0.28, 0.18, 0.10],
  [0.45, 0.34, 0.18], [0.62, 0.58, 0.55], [0.16, 0.10, 0.09]
];
const SHIRT_TONES = [
  [0.72, 0.20, 0.22], [0.16, 0.30, 0.55], [0.20, 0.45, 0.32], [0.85, 0.80, 0.72],
  [0.24, 0.24, 0.28], [0.62, 0.42, 0.18], [0.48, 0.22, 0.50], [0.10, 0.42, 0.48]
];
const PANTS_TONES = [
  [0.16, 0.19, 0.28], [0.22, 0.22, 0.24], [0.34, 0.30, 0.26],
  [0.10, 0.10, 0.12], [0.42, 0.40, 0.36], [0.20, 0.26, 0.22]
];
const SHOE_TONES = [
  [0.09, 0.09, 0.10], [0.22, 0.15, 0.11], [0.75, 0.75, 0.78], [0.14, 0.16, 0.22]
];

/* -------------------------------------------------------------------------- */
/* Character                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Builds (and caches) the per-variant rest skeleton and per-part shape matrices.
 * Characters that share a body type share these tables, so a crowd costs one copy.
 * @param {Object} assets Character assets (owns the cache).
 * @param {string} kind Character kind.
 * @param {boolean} female Female proportions.
 * @param {number} build Bulk multiplier, 0.85 (slim) .. 1.2 (heavy).
 * @returns {{rest: Float32Array, mats: Float32Array, views: Float32Array[]}} Shape tables.
 */
function getShape(assets, kind, female, build) {
  // The key has to be derived from the *clamped* bulk: keying on the raw value stores one
  // duplicate entry per distinct out-of-range build, and this cache is never evicted.
  const bulk = clamp(num(build, 1), 0.8, 1.25);
  const key = kind + '|' + (female ? 1 : 0) + '|' + Math.round(bulk * 20);
  const cached = assets._shapeCache.get(key);
  if (cached) return cached;

  const rest = new Float32Array(REST_OFFSET);
  if (female) {
    rest[BONE_INDEX.pelvis * 3 + 1] = 0.985;
    rest[BONE_INDEX.chest * 3 + 1] = 0.150;
    rest[BONE_INDEX.neck * 3 + 1] = 0.205;
    rest[BONE_INDEX.shoulderL * 3] = -0.040;
    rest[BONE_INDEX.shoulderR * 3] = 0.040;
    rest[BONE_INDEX.armL * 3] = -0.122;
    rest[BONE_INDEX.armR * 3] = 0.122;
    rest[BONE_INDEX.armL * 3 + 1] = -0.026;
    rest[BONE_INDEX.armR * 3 + 1] = -0.026;
    rest[BONE_INDEX.forearmL * 3 + 1] = -0.268;
    rest[BONE_INDEX.forearmR * 3 + 1] = -0.268;
    rest[BONE_INDEX.handL * 3 + 1] = -0.240;
    rest[BONE_INDEX.handR * 3 + 1] = -0.240;
    rest[BONE_INDEX.thighL * 3] = -0.102;
    rest[BONE_INDEX.thighR * 3] = 0.102;
  }

  // Per-part shape scale: torso and arms carry the build, the female silhouette narrows the
  // shoulders and widens the hips.
  const s = new Float32Array(PART_COUNT * 3);
  for (let i = 0; i < PART_COUNT; i++) { s[i * 3] = 1; s[i * 3 + 1] = 1; s[i * 3 + 2] = 1; }
  /**
   * @param {string} id Part id.
   * @param {number} x Scale X.
   * @param {number} y Scale Y.
   * @param {number} z Scale Z.
   * @returns {void}
   */
  const set = (id, x, y, z) => {
    const i = PART_INDEX[id];
    if (i === undefined) return;
    s[i * 3] = x; s[i * 3 + 1] = y; s[i * 3 + 2] = z;
  };
  const torsoX = (female ? 0.90 : 1) * bulk;
  const torsoZ = (female ? 0.95 : 1) * (1 + (bulk - 1) * 1.4);
  set('chest', torsoX, female ? 0.98 : 1, torsoZ);
  set('vest', torsoX, female ? 0.98 : 1, torsoZ);
  set('hood', torsoX, 1, torsoZ);
  set('spine', (female ? 0.90 : 1) * bulk, 1, (female ? 0.94 : 1) * (1 + (bulk - 1) * 1.5));
  set('pelvis', (female ? 1.07 : 1) * bulk, 1, (female ? 1.02 : 1) * (1 + (bulk - 1) * 1.2));
  set('skirt', female ? 1.02 : 1, 1, female ? 1.02 : 1);
  const armS = (female ? 0.87 : 1) * (1 + (bulk - 1) * 0.9);
  set('armL', armS, female ? 0.98 : 1, armS);
  set('armR', armS, female ? 0.98 : 1, armS);
  set('forearmL', armS, female ? 0.98 : 1, armS);
  set('forearmR', armS, female ? 0.98 : 1, armS);
  set('handL', female ? 0.90 : 1, female ? 0.94 : 1, female ? 0.90 : 1);
  set('handR', female ? 0.90 : 1, female ? 0.94 : 1, female ? 0.90 : 1);
  const legS = (female ? 0.95 : 1) * (1 + (bulk - 1) * 0.8);
  set('thighL', legS, 1, legS);
  set('thighR', legS, 1, legS);
  set('shinL', (female ? 0.92 : 1) * (1 + (bulk - 1) * 0.6), 1, (female ? 0.92 : 1) * (1 + (bulk - 1) * 0.6));
  set('shinR', (female ? 0.92 : 1) * (1 + (bulk - 1) * 0.6), 1, (female ? 0.92 : 1) * (1 + (bulk - 1) * 0.6));
  set('footL', female ? 0.92 : 1, female ? 0.95 : 1, female ? 0.94 : 1);
  set('footR', female ? 0.92 : 1, female ? 0.95 : 1, female ? 0.94 : 1);
  set('head', female ? 0.95 : 1, female ? 0.97 : 1, female ? 0.96 : 1);
  set('hair', female ? 0.97 : 1, female ? 1.0 : 1, female ? 0.98 : 1);
  set('neck', female ? 0.90 : 1, 1, female ? 0.90 : 1);

  const mats = new Float32Array(PART_COUNT * 16);
  const views = new Array(PART_COUNT);
  for (let i = 0; i < PART_COUNT; i++) {
    const v = mats.subarray(i * 16, i * 16 + 16);
    mat4.identity(v);
    v[0] = s[i * 3];
    v[5] = s[i * 3 + 1];
    v[10] = s[i * 3 + 2];
    views[i] = v;
  }
  const entry = { rest, mats, views };
  assets._shapeCache.set(key, entry);
  return entry;
}

/**
 * One animated humanoid. Owns its pose, its bone matrices and its per-instance colours;
 * geometry, materials and GPU batches all live in the shared {@link buildCharacterMeshes}
 * asset set.
 */
export class Character {
  /**
   * @param {Object} assets Result of {@link buildCharacterMeshes}.
   * @param {Object} [opts] Options.
   * @param {number[]} [opts.skin] Linear rgb skin colour.
   * @param {number[]} [opts.shirt] Linear rgb shirt / jacket colour.
   * @param {number[]} [opts.pants] Linear rgb trouser colour.
   * @param {number[]} [opts.hair] Linear rgb hair colour.
   * @param {number[]} [opts.shoe] Linear rgb shoe colour.
   * @param {number[]} [opts.accent] Linear rgb accent colour (cap, vest, hood).
   * @param {number[]} [opts.gearColor] Linear rgb colour of the held weapon.
   * @param {boolean} [opts.weaponVisible] Draw the weapon in the right hand.
   * @param {number} [opts.height=1.8] Total height in metres (1.69 by default for females),
   *   clamped to 0.6 - 2.6 m.
   * @param {string} [opts.kind='civ'] `'civ'` | `'cop'` | `'player'` | `'gangster'`.
   * @param {boolean} [opts.female=false] Use the female skeleton and silhouette.
   * @param {number} [opts.build=1] Bulk multiplier 0.8 .. 1.25.
   * @param {number|string} [opts.seed] Seed for the randomised details.
   * @param {number} [opts.sleeves] 0 sleeveless, 1 short, 2 long.
   * @param {boolean} [opts.shorts] Bare shins.
   * @param {boolean} [opts.skirt] Wear a skirt instead of trousers.
   * @param {boolean} [opts.bald] Hide the hair cap.
   */
  constructor(assets, opts) {
    const o = opts || {};
    const rng = new Rand(o.seed === undefined ? 1 : o.seed);

    /** @type {Object} Shared asset set. */
    this.assets = assets;
    /** @type {string} */
    this.kind = o.kind || 'civ';
    /** @type {boolean} */
    this.female = !!o.female;
    // A non-finite or absurd height would divide straight through to `scale` and bake NaN (or
    // a zero-volume rig) into every bone matrix for the lifetime of the character.
    /** @type {number} Total height in metres, clamped to 0.6 - 2.6 m. */
    this.height = clamp(num(o.height, this.female ? 1.69 : 1.8), 0.6, 2.6);
    /** @type {number} Uniform rig scale. */
    this.scale = this.height / RIG_HEIGHT;
    /** @type {number} Capsule radius used by gameplay code. */
    this.radius = 0.34 * this.scale;
    /** @type {number} Bulk multiplier, clamped to the range the silhouette actually spans. */
    this.build = clamp(num(o.build, this.kind === 'cop' ? 1.08 : 1), 0.8, 1.25);

    /** @type {Float32Array} World position of the feet. */
    this.position = vec3.create();
    /** @type {Float32Array} Last finite position, used to heal a bad write. @private */
    this._lastPos = vec3.create();
    /** @type {number} Facing yaw; 0 looks down -Z. */
    this.yaw = 0;
    /** @type {Float32Array} World velocity (informational, written by the owner). */
    this.velocity = vec3.create();
    /** @type {boolean} Skipped by {@link submit} when false. */
    this.visible = true;
    /** @type {number} 0 = full detail, grows with distance. */
    this.lod = 0;
    /** @type {string} Current animation state. */
    this.state = 'idle';
    /** @type {boolean} True once {@link playRagdoll} has been called. */
    this.dead = false;

    // ---- appearance ------------------------------------------------------------------
    const isCop = this.kind === 'cop';
    const isGang = this.kind === 'gangster';
    const skin = o.skin || rng.pick(SKIN_TONES);
    const hair = o.hair || rng.pick(HAIR_TONES);
    let shirt = o.shirt;
    let pants = o.pants;
    let accent = o.accent;
    if (isCop) {
      shirt = shirt || [0.11, 0.14, 0.24];
      pants = pants || [0.08, 0.10, 0.17];
      accent = accent || [0.05, 0.06, 0.10];
    } else if (isGang) {
      shirt = shirt || [0.10, 0.10, 0.12];
      pants = pants || [0.14, 0.15, 0.19];
      accent = accent || [0.30, 0.05, 0.12];
    } else {
      shirt = shirt || rng.pick(SHIRT_TONES);
      pants = pants || rng.pick(PANTS_TONES);
      accent = accent || [0.35, 0.35, 0.38];
    }
    const shoe = o.shoe || (isCop ? [0.07, 0.07, 0.08] : rng.pick(SHOE_TONES));

    /** @type {Object<string, number[]>} Per-slot linear rgb colours. */
    this.colors = {
      skin, shirt, pants, hair, shoe, accent,
      gear: o.gearColor || [0.30, 0.31, 0.34]
    };

    /** @type {number} 0 sleeveless, 1 short sleeve, 2 long sleeve. */
    this.sleeves = o.sleeves === undefined
      ? (isCop || isGang ? 2 : rng.int(0, 2))
      : o.sleeves | 0;
    /** @type {boolean} */
    this.shorts = o.shorts === undefined ? (!isCop && !isGang && rng.chance(0.18)) : !!o.shorts;
    /** @type {boolean} */
    this.skirt = o.skirt === undefined ? (this.female && !isCop && rng.chance(0.35)) : !!o.skirt;
    /** @type {boolean} */
    this.bald = o.bald === undefined ? (!this.female && rng.chance(0.08)) : !!o.bald;
    /** @type {boolean} Draw the held weapon on the right hand. */
    this.weaponVisible = !!o.weaponVisible;

    // ---- rig -------------------------------------------------------------------------
    const shape = getShape(assets, this.kind, this.female, this.build);
    /** @type {Float32Array} Per-character rest offsets (shared per body type). */
    this._rest = shape.rest;
    /** @type {Float32Array[]} Per-part shape matrices (shared per body type). */
    this._partMats = shape.views;

    /** @type {Float32Array} Bone world matrices, 16 floats each. */
    this._world = new Float32Array(BONE_COUNT * 16);
    /** @type {Float32Array[]} Stable views into {@link _world}, one per bone. */
    this._boneViews = new Array(BONE_COUNT);
    for (let i = 0; i < BONE_COUNT; i++) {
      this._boneViews[i] = this._world.subarray(i * 16, i * 16 + 16);
      mat4.identity(this._boneViews[i]);
    }

    /** @type {Float32Array} Final local pose fed to {@link _computeMatrices}. */
    this._pose = new Float32Array(POSE_LEN);
    this._poseA = new Float32Array(POSE_LEN);
    this._poseB = new Float32Array(POSE_LEN);
    /** Blended keyframe pose before the procedural layers; the cross-fade source. */
    this._poseRaw = new Float32Array(POSE_LEN);
    this._snap = new Float32Array(POSE_LEN);

    // ---- state machine ---------------------------------------------------------------
    this._clip = CLIPS.idle;
    this._clipTime = 0;
    this._prevClip = null;
    this._prevTime = 0;
    this._useSnap = false;
    this._blend = 1;
    this._blendDur = 0.2;
    this._stateTime = 0;
    this._gaitPhase = rng.next();
    this._speed = 0;
    this._speedSmooth = 0;
    this._moveBlend = 0;
    /** Weight of the gait-locked additive layer; 0 unless a gait clip is contributing. */
    this._gaitWeight = 0;

    // ---- procedural layers ------------------------------------------------------------
    this._lookYaw = 0;
    this._lookPitch = 0;
    this._lean = 0;
    this._leanPitch = 0;
    this._prevYaw = 0;
    this._yawRate = 0;
    this._recoil = 0;
    this._recoilVel = 0;
    this._footLift = 0;
    this._breathPhase = rng.next() * Math.PI * 2;
    this._idleSalt = rng.range(0.8, 1.2);
    this._steer = 0;
    this._rootPitchCur = 0;
    this._rootLiftCur = 0;
    this._rootYawCur = 0;
    this._pendingDt = 0;
    this._submitToken = -2;
    this._rng = rng;

    // ---- ragdoll ------------------------------------------------------------------------
    this._ragActive = false;
    this._ragFall = 0;
    this._ragFallVel = 0;
    this._ragYaw = 0;
    this._ragLift = 0;
    this._ragAngle = new Float32Array(BONE_COUNT * POSE_STRIDE);
    this._ragVel = new Float32Array(BONE_COUNT * POSE_STRIDE);
    this._ragTarget = new Float32Array(POSE_LEN);
    this._ragSettle = 0;
    /** Sustained-request gate that lets an owner take a ragdolled body back. */
    this._reviveState = '';
    this._reviveHold = 0;
    this._reviveFrames = 0;
    this._reviveAsked = false;

    // ---- per-instance draw data ---------------------------------------------------------
    /** @type {Float32Array} rgba tint per part. */
    this._tints = new Float32Array(PART_COUNT * 4);
    /** @type {Uint8Array} Which parts this character draws. */
    this._partOn = new Uint8Array(PART_COUNT);
    /** @type {Float32Array} Seat transform composed with the rig scale. */
    this._seatOffset = mat4.create();
    mat4.identity(this._seatOffset);
    this._seatOffset[0] = this.scale;
    this._seatOffset[5] = this.scale;
    this._seatOffset[10] = this.scale;
    this._seatOffset[13] = -this._rest[BONE_INDEX.pelvis * 3 + 1] * this.scale;

    this.refreshAppearance();
    sampleClip(this._clip, 0, this._pose);
    this._computeMatrices(null);
  }

  /**
   * Recomputes the per-part instance tints and the enabled-part mask from the current
   * appearance fields. Call after changing `colors`, `sleeves`, `weaponVisible`, ...
   * @returns {void}
   */
  refreshAppearance() {
    const c = this.colors;
    const sleeveUpper = this.sleeves >= 1 ? c.shirt : c.skin;
    const sleeveLower = this.sleeves >= 2 ? c.shirt : c.skin;
    const legLower = this.shorts ? c.skin : c.pants;
    for (let i = 0; i < PART_COUNT; i++) {
      const def = PART_DEFS[i];
      let col = c.shirt;
      switch (def.tint) {
        case 'skin': col = c.skin; break;
        case 'hair': col = c.hair; break;
        case 'shirt': col = c.shirt; break;
        case 'pants': col = c.pants; break;
        case 'shoe': col = c.shoe; break;
        case 'accent': col = c.accent; break;
        case 'gear': col = c.gear; break;
        case 'sleeve': col = sleeveUpper; break;
        case 'cuff': col = sleeveLower; break;
        case 'leg': col = legLower; break;
        default: col = c.shirt; break;
      }
      const o = i * 4;
      this._tints[o] = col[0];
      this._tints[o + 1] = col[1];
      this._tints[o + 2] = col[2];
      this._tints[o + 3] = 1;
      this._partOn[i] = def.optional ? 0 : 1;
    }
    const on = (id, v) => { const i = PART_INDEX[id]; if (i !== undefined) this._partOn[i] = v ? 1 : 0; };
    on('hair', !this.bald);
    on('ponytail', this.female && !this.bald);
    on('cap', this.kind === 'cop');
    on('vest', this.kind === 'cop');
    on('hood', this.kind === 'gangster');
    on('skirt', this.skirt);
    on('weapon', this.weaponVisible);
    // A skirt covers the trousers, so both the thighs and the shins below it read as bare skin.
    if (this.skirt) {
      const skin = c.skin;
      for (const id of SKIRT_BARE_PARTS) {
        const idx = PART_INDEX[id];
        if (idx === undefined) continue;
        this._tints[idx * 4] = skin[0];
        this._tints[idx * 4 + 1] = skin[1];
        this._tints[idx * 4 + 2] = skin[2];
      }
    }
  }

  /**
   * Switches animation state with a cross-fade. Re-selecting the current state is a no-op
   * unless `opts.restart` is set, so gameplay code may call this every frame.
   * @param {string} name One of {@link CHARACTER_STATES}.
   * @param {Object} [opts] Options.
   * @param {number} [opts.blend] Cross-fade seconds (0.12 - 0.25 by default).
   * @param {boolean} [opts.restart] Restart the clip even if it is already playing.
   * @param {boolean} [opts.revive] Cancel an active ragdoll instead of ignoring the request.
   * @returns {void}
   */
  setState(name, opts) {
    const clip = CLIPS[name];
    if (!clip) return;
    if (this._ragActive) {
      // A ragdoll ignores one-off animation requests, otherwise a corpse would pop upright
      // because some unrelated system (a reload finishing on a body that has just died)
      // asked for 'idle'. It must not be a dead end either: `playRagdoll` used to be
      // irreversible, which left a respawned player face-down for the rest of the session
      // and forced ped.js and police.js to throw every killed body away instead of recycling
      // it. Two ways out: an explicit `{revive: true}`, or an owner that keeps driving the
      // character frame after frame, which is exactly what a respawn or a pool reuse looks
      // like. `update()` arbitrates; see REVIVE_HOLD_TIME.
      if (opts && opts.revive) { this.revive(name); return; }
      this._reviveState = name;
      this._reviveAsked = true;
      return;
    }
    const restart = !!(opts && opts.restart);
    if (name === this.state && !restart) return;

    if (this._blend < 1) {
      // A fade is already running: freeze the current output so the new fade starts from
      // exactly what is on screen. Guarantees continuity under rapid state churn.
      this._snap.set(this._poseRaw);
      this._useSnap = true;
      this._prevClip = null;
    } else {
      this._prevClip = this._clip;
      this._prevTime = this._clipTime;
      this._useSnap = false;
    }
    this.state = name;
    this._clip = clip;
    this._clipTime = 0;
    this._stateTime = 0;
    this._blend = 0;
    this._blendDur = Math.max(0.04, (opts && opts.blend) || BLEND_TIME[name] || 0.18);
    if (name === 'shoot') this.triggerRecoil(opts && opts.recoil !== undefined ? opts.recoil : 1);
  }

  /**
   * Kicks the additive recoil layer. Called automatically by `setState('shoot')`.
   * @param {number} [amount=1] Kick strength, roughly one unit per pistol shot.
   * @returns {void}
   */
  triggerRecoil(amount) {
    const a = amount === undefined ? 1 : amount;
    this._recoilVel += 5.2 * a;
    if (this._recoilVel > 22) this._recoilVel = 22;
  }

  /**
   * Advances the animation one step.
   * @param {number} dt Seconds since the previous call.
   * @param {Object} [ctx] Frame context.
   * @param {number} [ctx.moveSpeed] Horizontal ground speed in m/s (drives the gait cadence).
   * @param {number} [ctx.aimPitch] Look pitch in radians, positive looks up.
   * @param {number} [ctx.lookYaw] Head yaw offset relative to the body, radians.
   * @param {boolean} [ctx.aiming] Whether the character is aiming.
   * @param {boolean} [ctx.grounded] Whether the feet are on the ground.
   * @param {number} [ctx.steer] Steering input -1..1 while driving.
   * @param {ArrayLike<number>} [ctx.seatMatrix] World seat transform while driving.
   * @param {number} [ctx.distance] Distance to the camera, used to pick a LOD.
   * @param {number} [ctx.lod] Explicit LOD level (overrides `distance`).
   * @returns {void}
   */
  update(dt, ctx) {
    const c = ctx || _defaultCtx;
    let d = num(dt, 0);
    if (!(d > 0)) d = 0;
    else if (d > MAX_STEP) d = MAX_STEP;

    if (c.lod !== undefined) this.lod = c.lod | 0;
    else if (c.distance !== undefined) {
      const dist = c.distance;
      this.lod = dist > 95 ? 3 : dist > 46 ? 2 : dist > 20 ? 1 : 0;
    }

    // Distance-based update-rate throttling: distant crowds animate at 20 / 10 Hz.
    this._pendingDt += d;
    const step = this.lod >= 3 ? 0.1 : (this.lod >= 2 ? 0.05 : 0);
    if (step > 0 && this._pendingDt < step) return;
    // The accumulator can hold up to two clamped frames, so clamp again: the springs below
    // are only stable up to MAX_STEP, and a 0.2 s step used to make them diverge.
    let adt = this._pendingDt;
    this._pendingDt = 0;
    if (adt <= 0) return;
    if (adt > MAX_STEP) adt = MAX_STEP;

    // Heal a non-finite transform written by the owner instead of latching it into every
    // smoothing accumulator (which used to leave the character invisible for good).
    const p = this.position;
    if (Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2])) {
      this._lastPos[0] = p[0]; this._lastPos[1] = p[1]; this._lastPos[2] = p[2];
    } else {
      p[0] = this._lastPos[0]; p[1] = this._lastPos[1]; p[2] = this._lastPos[2];
    }
    this.yaw = num(this.yaw, this._prevYaw);

    // Hand a ragdolled body back to its owner once that owner has asked for a living state on
    // several consecutive updates — a respawn or a pool reuse — but never on a single stray
    // request. Arbitrated here, before the clip is sampled, so `revive()` can cross-fade out
    // of the pose that is still on screen.
    if (this._ragActive) {
      if (this._reviveAsked) {
        this._reviveAsked = false;
        this._reviveHold += adt;
        this._reviveFrames++;
        if (this._reviveHold >= REVIVE_HOLD_TIME && this._reviveFrames >= REVIVE_HOLD_FRAMES) {
          this.revive(this._reviveState);
        }
      } else if (this._reviveFrames !== 0) {
        this._reviveHold = 0;
        this._reviveFrames = 0;
        this._reviveState = '';
      }
    }

    this._stateTime += adt;
    this._clipTime += adt;

    // --- speed & gait clock ---------------------------------------------------------
    const moveSpeed = c.moveSpeed !== undefined
      ? Math.abs(num(c.moveSpeed, 0))
      : Math.hypot(num(this.velocity[0], 0), num(this.velocity[2], 0));
    this._speed = moveSpeed;
    this._speedSmooth = damp(this._speedSmooth, moveSpeed, 9, adt);
    const gaitNow = GAIT_STATES[this.state] === 1;
    const gaitPrev = this._prevClip !== null && this._prevClip.gait;
    // The hip bob / arm swing additive layer is locked to the gait clock, so it may only run
    // while a gait clip actually contributes. Driving it off speed alone bled a *frozen*
    // gait phase into jump, fall and swim as a constant asymmetric twist of the arms and hips.
    this._gaitWeight = damp(this._gaitWeight, gaitNow || gaitPrev ? 1 : 0, 9, adt);
    if (gaitNow || gaitPrev) {
      const stride = strideFor(this.state, this._speedSmooth) * this.scale;
      const cycles = clamp(moveSpeed / stride, 0.32, 4.6);
      this._gaitPhase += cycles * adt;
      if (this._gaitPhase >= 1 || this._gaitPhase < 0) this._gaitPhase -= Math.floor(this._gaitPhase);
    }
    this._moveBlend = clamp(this._speedSmooth / 4.4, 0, 1);

    // --- auto-return from one-shot clips ---------------------------------------------
    if (!this._ragActive && !this._clip.loop && this._clipTime > this._clip.duration) {
      const next = AUTO_RETURN[this.state];
      if (next && next !== this.state) this.setState(next);
    }

    // --- sample + cross-fade -----------------------------------------------------------
    if (this._blend < 1) {
      this._blend += adt / this._blendDur;
      if (this._blend >= 1) {
        this._blend = 1;
        this._prevClip = null;
        this._useSnap = false;
      }
    }
    const clip = this._clip;
    const tNow = clip.gait ? this._gaitPhase * clip.duration : this._clipTime;
    sampleClip(clip, tNow, this._poseB);
    if (this._blend < 1) {
      let src;
      if (this._useSnap) {
        src = this._snap;
      } else {
        this._prevTime += adt;
        const pc = this._prevClip;
        src = sampleClip(pc, pc.gait ? this._gaitPhase * pc.duration : this._prevTime, this._poseA);
      }
      blendPose(this._poseRaw, src, this._poseB, smoothstep(0, 1, this._blend));
    } else {
      this._poseRaw.set(this._poseB);
    }
    this._pose.set(this._poseRaw);

    if (this._ragActive) this._updateRagdoll(adt);
    else this._applyProcedural(adt, c);

    this._computeMatrices(c, adt);
  }

  /**
   * Applies the procedural layers on top of the sampled keyframes: gait-locked hip bob and
   * sway, torso counter-rotation, breathing, clamped head look-at, lean into turns, steering
   * and the additive recoil kick.
   * @param {number} adt Time step in seconds.
   * @param {Object} c Frame context.
   * @returns {void}
   * @private
   */
  _applyProcedural(adt, c) {
    const pose = this._pose;
    const mb = this._moveBlend * this._gaitWeight;

    // --- lean into turns and into acceleration ------------------------------------
    const dy = wrapAngle(this.yaw - this._prevYaw);
    this._prevYaw = this.yaw;
    const rate = clamp(dy / Math.max(adt, 1e-4), -7, 7);
    this._yawRate = damp(this._yawRate, rate, 8, adt);
    this._lean = damp(this._lean, clamp(this._yawRate * this._speedSmooth * 0.026, -0.17, 0.17), 7, adt);
    this._leanPitch = damp(this._leanPitch,
      clamp((this._speed - this._speedSmooth) * 0.035, -0.09, 0.09), 6, adt);
    pose[2] += this._lean;
    pose[0] += this._leanPitch;

    // --- gait-locked hip bob, sway, torso counter-rotation, arm sway ----------------
    if (mb > 0.001) {
      const tp = this._gaitPhase * Math.PI * 2;
      const s1 = Math.sin(tp);
      // Baked gaits already derive the hip height from the stance leg's reach, so only the
      // non-baked states get a synthetic vertical bob.
      if (!this._clip.gait) pose[POSE_ROOT + 1] += -0.014 * (0.5 - 0.5 * Math.cos(tp * 2)) * mb;
      pose[POSE_ROOT] += 0.011 * s1 * mb;
      pose[BONE_INDEX.chest * POSE_STRIDE + 1] += -0.09 * s1 * mb;
      pose[BONE_INDEX.pelvis * POSE_STRIDE + 1] += 0.05 * s1 * mb;
      const sw = 0.09 * s1 * mb;
      pose[BONE_INDEX.armL * POSE_STRIDE] -= sw;
      pose[BONE_INDEX.armR * POSE_STRIDE] += sw;
    }

    // --- breathing (fades out as the character speeds up) ---------------------------
    this._breathPhase += adt * 1.05 * this._idleSalt;
    const breath = Math.sin(this._breathPhase) * (1 - mb) * 0.016;
    pose[BONE_INDEX.chest * POSE_STRIDE] += breath;
    pose[BONE_INDEX.spine * POSE_STRIDE] += breath * 0.5;

    // --- head look-at, spread over chest / neck / head and hard clamped -------------
    const lookT = clamp(num(c.lookYaw, 0), -1.9, 1.9);
    const pitchT = clamp(num(c.aimPitch, 0), -1.0, 1.0);
    this._lookYaw = angleDamp(this._lookYaw, lookT, 10, adt);
    this._lookPitch = damp(this._lookPitch, pitchT, 10, adt);
    const ly = clamp(this._lookYaw, -1.5, 1.5);
    const lp = clamp(this._lookPitch, -0.85, 0.85);
    const w = c.aiming ? 0.35 : 1;
    const headY = BONE_INDEX.head * POSE_STRIDE + 1;
    const headX = BONE_INDEX.head * POSE_STRIDE;
    pose[BONE_INDEX.chest * POSE_STRIDE + 1] += ly * 0.16 * w;
    pose[BONE_INDEX.neck * POSE_STRIDE + 1] += ly * 0.30 * w;
    pose[headY] = clamp(pose[headY] + ly * 0.42 * w, -1.25, 1.25);
    pose[BONE_INDEX.neck * POSE_STRIDE] += lp * 0.36;
    pose[headX] = clamp(pose[headX] + lp * 0.5, -0.95, 0.95);

    // --- steering while seated -------------------------------------------------------
    this._steer = damp(this._steer, clamp(num(c.steer, 0), -1, 1), 8, adt);
    if (this.state === 'drive' || this.state === 'enter' || this.state === 'exit') {
      const st = this._steer;
      pose[BONE_INDEX.armL * POSE_STRIDE] += st * 0.30;
      pose[BONE_INDEX.armR * POSE_STRIDE] -= st * 0.30;
      pose[BONE_INDEX.forearmL * POSE_STRIDE] -= st * 0.22;
      pose[BONE_INDEX.forearmR * POSE_STRIDE] += st * 0.22;
      pose[BONE_INDEX.chest * POSE_STRIDE + 2] += st * 0.06;
    }

    // --- additive recoil (damped spring, decays back to zero) -------------------------
    // Implicit damping: `v = (v + f*dt) / (1 + c*dt)` instead of `v += (f - c*v)*dt`. The
    // explicit form needs `c*dt < 2` and blew up on the throttled LOD path, leaving the
    // shoulder rattling against its clamps forever on distant shooters and at low frame rates.
    let rv = (this._recoilVel - 44 * this._recoil * adt) / (1 + 10 * adt);
    if (rv > 60) rv = 60; else if (rv < -60) rv = -60;
    this._recoilVel = rv;
    this._recoil += rv * adt;
    if (this._recoil > 1.2) this._recoil = 1.2;
    else if (this._recoil < -0.6) this._recoil = -0.6;
    const r = this._recoil;
    if (r > 1e-4 || r < -1e-4) {
      pose[BONE_INDEX.chest * POSE_STRIDE] -= r * 0.16;
      pose[BONE_INDEX.armR * POSE_STRIDE] -= r * 0.26;
      pose[BONE_INDEX.forearmR * POSE_STRIDE] += r * 0.20;
      pose[BONE_INDEX.armL * POSE_STRIDE] -= r * 0.14;
      pose[BONE_INDEX.handR * POSE_STRIDE] -= r * 0.30;
      pose[headX] += r * 0.10;
      pose[POSE_ROOT + 2] += r * 0.012;
    }

    // --- one-frame foot planting correction ---------------------------------------------
    pose[POSE_ROOT + 1] += this._footLift;
  }

  /**
   * Advances the ragdoll: per-bone damped springs toward the slack death pose plus a
   * toppling root rotation that settles flat and stays there.
   * @param {number} adt Time step in seconds.
   * @returns {void}
   * @private
   */
  _updateRagdoll(adt) {
    const t = this._ragTarget;
    const a = this._ragAngle;
    const v = this._ragVel;
    const pose = this._pose;
    this._ragSettle = Math.min(1, this._ragSettle + adt * 0.75);
    const settle = this._ragSettle;
    const k = 34 + settle * 44;
    const dmp = 9 + settle * 16;
    const n = BONE_COUNT * POSE_STRIDE;
    for (let i = 0; i < n; i++) {
      const x = a[i];
      const e = wrapAngle(t[i] - x);
      // Implicit damping. The old explicit step needed `dmp * adt < 2`; once the springs
      // stiffened up (`dmp` reaches 25 as the body settles) that failed at 10 fps and on the
      // LOD-3 update path, so distant corpses shook themselves apart instead of lying still.
      let vel = (v[i] + e * k * adt) / (1 + dmp * adt);
      if (vel > 26) vel = 26; else if (vel < -26) vel = -26;
      v[i] = vel;
      const nx = x + vel * adt;
      a[i] = nx;
      pose[i] = nx;
    }
    for (let i = POSE_ROOT; i < POSE_LEN; i++) pose[i] = damp(pose[i], t[i], 6, adt);

    this._ragFallVel += (5.2 * (1.5 - this._ragFall) - 3.4 * this._ragFallVel) * adt;
    this._ragFall += this._ragFallVel * adt;
    if (this._ragFall > 1.62) { this._ragFall = 1.62; if (this._ragFallVel > 0) this._ragFallVel *= -0.18; }
    else if (this._ragFall < 0) { this._ragFall = 0; this._ragFallVel = 0; }
    this._ragLift = damp(this._ragLift, 0.15 * this.scale, 3.4, adt);
    this._footLift = damp(this._footLift, 0, 12, adt);
  }

  /**
   * Walks the bone hierarchy once and writes the world matrices into the preallocated buffer.
   * @param {Object|null} c Frame context (for `seatMatrix`).
   * @param {number} [adt=0] Time step, used for the smoothed whole-body overrides.
   * @returns {void}
   * @private
   */
  _computeMatrices(c, adt) {
    const pose = this._pose;
    const rest = this._rest;
    const views = this._boneViews;
    const s = this.scale;
    const dt = adt || 0;
    const seat = c && c.seatMatrix ? c.seatMatrix : null;

    if (seat) {
      mat4.multiply(_sm, seat, this._seatOffset);
      this._rootPitchCur = damp(this._rootPitchCur, 0, 7, dt);
      this._rootLiftCur = damp(this._rootLiftCur, 0, 7, dt);
    } else {
      let pitch, lift, ry;
      if (this._ragActive) {
        pitch = -this._ragFall;
        lift = this._ragLift;
        ry = this._ragYaw;
        // Track the toppled root so a revive continues from where the body actually lies and
        // stands it back up, instead of snapping it upright and un-twisting it in one frame.
        this._rootPitchCur = pitch;
        this._rootLiftCur = lift;
        this._rootYawCur = ry;
      } else {
        const clip = this._clip;
        this._rootPitchCur = damp(this._rootPitchCur, clip.rootPitch, 7, dt);
        this._rootLiftCur = damp(this._rootLiftCur, clip.rootLift * s, 7, dt);
        this._rootYawCur = damp(this._rootYawCur, 0, 7, dt);
        pitch = this._rootPitchCur;
        lift = this._rootLiftCur;
        ry = this._rootYawCur;
      }
      vec3.set(_sp, this.position[0], this.position[1] + lift, this.position[2]);
      quat.fromEuler(_sq, this.yaw + ry, pitch, 0);
      if (ry !== 0) {
        quat.fromEuler(_sq2, -ry, 0, 0);
        quat.multiply(_sq, _sq, _sq2);
      }
      mat4.compose(_sm, _sp, _sq, s);
    }

    const pelvis = BONE_INDEX.pelvis;
    for (let b = 0; b < BONE_COUNT; b++) {
      const o = b * POSE_STRIDE;
      quat.fromEuler(_sq3, pose[o + 1], pose[o], pose[o + 2]);
      let px = rest[o];
      let py = rest[o + 1];
      let pz = rest[o + 2];
      if (b === pelvis) {
        px += pose[POSE_ROOT];
        py += pose[POSE_ROOT + 1];
        pz += pose[POSE_ROOT + 2];
      }
      vec3.set(_sp2, px, py, pz);
      mat4.compose(_sm2, _sp2, _sq3, 1);
      const parent = BONE_PARENT[b];
      if (parent < 0) mat4.multiply(views[b], _sm, _sm2);
      else mat4.multiply(views[b], views[parent], _sm2);
    }

    // Foot planting: measure how far the lowest ankle sank and fold the correction into the
    // next frame's pelvis offset. Cheap (no second pass) and invisible at 60 fps.
    if (!this._ragActive && !seat && this._clip.rootPitch === 0) {
      const fl = views[BONE_INDEX.footL][13];
      const fr = views[BONE_INDEX.footR][13];
      const lowest = fl < fr ? fl : fr;
      const want = this.position[1] + 0.055 * s;
      // `lowest` was measured with the current lift already folded in, so the measurement is
      // the *residual* error, not the total one. Damping straight onto it made the loop settle
      // at half the required lift and left the feet permanently sunk; add the residual to the
      // lift in flight instead.
      const need = clamp(this._footLift + (want - lowest) / s, 0, 0.14);
      this._footLift = damp(this._footLift, need, 22, dt);
    } else {
      this._footLift = damp(this._footLift, 0, 14, dt);
    }
  }

  /**
   * Collapses the character with a cheap procedural ragdoll: the body topples in the
   * direction of the impulse while every limb follows a damped spring into a slack pose,
   * then it stays lying flat.
   * Reversible: call {@link Character#revive} to hand the body back to the animation system
   * (respawning the player, recycling a ped or a cop into its pool).
   * @param {ArrayLike<number>} [impulse] World-space impulse / velocity of the killing blow.
   * @returns {void}
   */
  playRagdoll(impulse) {
    if (this._ragActive) return;
    this._ragActive = true;
    this._reviveState = '';
    this._reviveHold = 0;
    this._reviveFrames = 0;
    this._reviveAsked = false;
    this.dead = true;
    this.state = 'die';
    this._clip = CLIPS.die;
    this._clipTime = 0;
    this._blend = 1;
    this._prevClip = null;
    this._useSnap = false;

    const ix = impulse ? (impulse[0] || 0) : 0;
    const iy = impulse ? (impulse[1] || 0) : 0;
    const iz = impulse ? (impulse[2] || 0) : 0;
    const mag = Math.hypot(ix, iz);
    this._ragYaw = mag > 0.05
      ? wrapAngle(Math.atan2(-ix, -iz) - this.yaw)
      : this._rng.range(-0.9, 0.9);
    this._ragFall = 0;
    this._ragFallVel = 0.85 + clamp(mag * 0.2, 0, 2.4);
    this._ragLift = 0;
    this._ragSettle = 0;

    sampleClip(CLIPS.die, CLIPS.die.duration, this._ragTarget);
    const kick = clamp(mag * 0.22 + Math.abs(iy) * 0.1, 0, 5);
    const n = BONE_COUNT * POSE_STRIDE;
    for (let i = 0; i < n; i++) {
      this._ragAngle[i] = this._pose[i];
      this._ragVel[i] = (this._rng.next() * 2 - 1) * kick;
    }
  }

  /**
   * Cancels an active ragdoll and hands the body back to the animation system, cross-fading
   * out of the pose the corpse is actually in and letting the toppled root stand back up over
   * the next fraction of a second (no pop).
   *
   * This is the counterpart to {@link Character#playRagdoll}. Without it a killed character
   * was a dead end: a respawned player stayed face-down for the rest of the session, and
   * `ped.js` / `police.js` had to drop every killed body on the floor instead of recycling it
   * into their character pools.
   * @param {string} [state='idle'] State to wake up in.
   * @returns {void}
   */
  revive(state) {
    const clip = CLIPS[state] || CLIPS.idle;

    // Fade from what is on screen right now, not from the death clip's timeline.
    this._snap.set(this._pose);
    this._useSnap = true;
    this._prevClip = null;
    this.state = clip.name;
    this._clip = clip;
    this._clipTime = 0;
    this._stateTime = 0;
    this._blend = 0;
    this._blendDur = Math.max(0.04, BLEND_TIME[clip.name] || 0.18);

    // `_computeMatrices` has been tracking the toppled root all along, so the body now damps
    // back to upright from where it lies rather than teleporting onto its feet.
    this._ragActive = false;
    this.dead = false;
    this._ragFall = 0;
    this._ragFallVel = 0;
    this._ragLift = 0;
    this._ragYaw = 0;
    this._ragSettle = 0;
    this._ragAngle.fill(0);
    this._ragVel.fill(0);
    this._footLift = 0;
    this._recoil = 0;
    this._recoilVel = 0;
    this._reviveState = '';
    this._reviveHold = 0;
    this._reviveFrames = 0;
    this._reviveAsked = false;
  }

  /**
   * Returns the world matrix of a bone. The returned array is a live view into the
   * character's matrix buffer: read it, never keep or mutate it.
   * @param {string|number} name Bone name or index.
   * @returns {Float32Array|null} Column-major world matrix, or null for an unknown bone.
   */
  getBoneMatrix(name) {
    const i = typeof name === 'number' ? name : BONE_INDEX[name];
    if (i === undefined || i < 0 || i >= BONE_COUNT) return null;
    return this._boneViews[i];
  }

  /**
   * Writes the world position of a bone.
   * @param {string|number} name Bone name or index.
   * @param {Float32Array|number[]} out Destination vec3.
   * @returns {Float32Array|number[]|null} `out`, or null for an unknown bone.
   */
  getBonePosition(name, out) {
    const m = this.getBoneMatrix(name);
    if (!m) return null;
    out[0] = m[12]; out[1] = m[13]; out[2] = m[14];
    return out;
  }

  /**
   * Writes the world-space muzzle position of the weapon held in the right hand.
   * @param {Float32Array|number[]} out Destination vec3.
   * @returns {Float32Array|number[]} `out`
   */
  getMuzzleOrigin(out) {
    const m = this._boneViews[BONE_INDEX.handR];
    const x = MUZZLE_LOCAL[0], y = MUZZLE_LOCAL[1], z = MUZZLE_LOCAL[2];
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    return out;
  }

  /**
   * Writes the world-space eye position (useful for AI line of sight and cameras).
   * @param {Float32Array|number[]} out Destination vec3.
   * @returns {Float32Array|number[]} `out`
   */
  getEyeOrigin(out) {
    const m = this._boneViews[BONE_INDEX.head];
    out[0] = m[8] * -0.08 + m[4] * 0.10 + m[12];
    out[1] = m[9] * -0.08 + m[5] * 0.10 + m[13];
    out[2] = m[10] * -0.08 + m[6] * 0.10 + m[14];
    return out;
  }

  /**
   * Draws every enabled body part. Parts go through the shared instanced batches (so an
   * entire crowd costs about 20 draw calls); anything past the batch capacity falls back to
   * an individual dynamic submit.
   * @param {Object} renderer Renderer.
   * @returns {void}
   */
  submit(renderer) {
    const assets = this.assets;
    if (!assets) return;
    const parts = assets.parts;

    if (!assets.manualFrames) {
      const fid = renderer && typeof renderer._frameId === 'number' ? renderer._frameId : -1;
      if (fid >= 0) {
        if (fid !== assets._frameToken) {
          assets._frameToken = fid;
          assets.beginFrame();
        }
      } else if (this._submitToken === assets._frameToken) {
        assets._frameToken++;
        assets.beginFrame();
      }
      this._submitToken = assets._frameToken;
    }
    if (!this.visible) return;

    const lod = this.lod;
    const tints = this._tints;
    const on = this._partOn;
    const mats = this._partMats;
    const views = this._boneViews;
    for (let i = 0; i < parts.length; i++) {
      if (on[i] === 0) continue;
      const p = parts[i];
      if (lod >= p.lodCut) continue;
      mat4.multiply(_sm2, views[p.bone], mats[i]);
      const o = i * 4;
      _tint4[0] = tints[o];
      _tint4[1] = tints[o + 1];
      _tint4[2] = tints[o + 2];
      _tint4[3] = tints[o + 3];
      const batch = p.batch;
      if (batch && p.cursor < batch.capacity) {
        batch.setInstance(p.cursor, _sm2, _tint4);
        p.cursor++;
      } else if (renderer && typeof renderer.submit === 'function') {
        _submitOpts.tint = _tint4;
        renderer.submit(p.geometry, p.material, _sm2, _submitOpts);
      }
    }
  }
}

/** Reused options object for the non-instanced fallback path. */
const _submitOpts = { tint: null };

/** Where each one-shot state returns to once its clip has played out. */
const AUTO_RETURN = {
  land: 'idle', shoot: 'aim', punch: 'idle', hit: 'idle',
  reload: 'aim', enter: 'drive', exit: 'idle', jump: 'fall'
};

/**
 * Ground distance covered by one full gait cycle.
 *
 * Each gait clip's legs are baked for one specific stride, and the runtime phase rate is
 * `speed / stride`, so returning the clip's own stride makes the planted foot world-stationary
 * at *any* speed. Blending strides between gaits would desynchronise the baked trajectory and
 * bring the skating straight back.
 * @param {string} state Current state name.
 * @param {number} speed Smoothed ground speed in m/s (used only for non-gait states).
 * @returns {number} Stride length in metres.
 */
function strideFor(state, speed) {
  const s = STRIDE_BY_STATE[state];
  if (s !== undefined) return s;
  if (speed <= 2.6) return STRIDE_WALK;
  if (speed >= 6.6) return STRIDE_SPRINT;
  if (speed <= 5.2) return lerp(STRIDE_WALK, STRIDE_RUN, (speed - 2.6) / 2.6);
  return lerp(STRIDE_RUN, STRIDE_SPRINT, (speed - 5.2) / 1.4);
}
