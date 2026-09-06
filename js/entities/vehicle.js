/**
 * Vehicles: shared procedural models plus an arcade-but-grounded driving simulation.
 *
 * One set of meshes is built per vehicle type by {@link buildVehicleAssets} and reused by every
 * instance; the body colour is a per-instance tint so a single painted mesh serves every colour.
 * Physics is a four-wheel raycast-suspension rigid body with a torque-curve engine, a five-speed
 * automatic gearbox, slip-angle tyre forces with a peak-then-falloff curve, load-sensitive grip
 * (so weight transfer under braking and cornering really changes the handling) and swept-sphere
 * collision against the {@link CollisionWorld}. Integration runs on fixed 1/120 s sub-steps, so
 * the car behaves identically at 5 fps and at 240 fps and can never tunnel through a building.
 *
 * Local model frame: `+X` = right, `+Y` = up, `+Z` = rear (forward is `-Z`, matching the global
 * yaw convention). The origin sits at the centre of mass, which is `wheelRadius + restLength`
 * above the ground when the suspension is at rest.
 *
 * @module entities/vehicle
 */

import {
  vec3, mat4, clamp, lerp, damp, wrapAngle, moveTowards, Rand
} from '../core/math.js';
import {
  box, roundedBox, cylinder, torus, mergeGeometries, computeBounds, geometryTriangleCount
} from '../core/geometry.js';
import { createMaterial } from '../render/materials.js';

/* ------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------ */

/** Gravity in m/s^2. */
const GRAVITY = 9.81;
/** Air density in kg/m^3. */
const AIR_DENSITY = 1.204;
/** Fixed physics sub-step in seconds. */
const FIXED_STEP = 1 / 120;
/** Hard cap on sub-steps per update so a huge frame spike can never stall the tab. */
const MAX_SUBSTEPS = 40;
/** Largest frame delta the simulation will consume in one call (seconds). */
const MAX_FRAME_DT = 0.34;
/** Drivetrain efficiency from crank to contact patch. */
const DRIVETRAIN_EFF = 0.88;
/** Rolling resistance coefficient. */
const CRR = 0.014;
/** Slip angle (radians) at which a tyre reaches peak lateral force. */
const PEAK_SLIP = 0.145;
/** Yaw damping in 1/s: keeps the car from feeling twitchy. */
const YAW_DAMP = 1.25;
/** Hard clamp on yaw rate (rad/s). */
const MAX_YAW_RATE = 3.2;
/** Fraction above the type maximum the speed clamp allows. */
const OVERSPEED_ALLOW = 1.03;
/** Gearbox ratios for road cars (5 forward speeds). */
const GEARS_ROAD = [3.55, 2.1, 1.42, 1.03, 0.8];
/** Gearbox ratios for heavy vehicles. */
const GEARS_HEAVY = [5.2, 3.0, 1.9, 1.3, 1.0];
/** Gearbox ratios for the motorbike. */
const GEARS_BIKE = [2.85, 2.05, 1.68, 1.42, 1.2];
/** Seconds a gear change takes (torque is cut during the shift). */
const SHIFT_TIME = 0.22;
/** Full health of an undamaged vehicle. */
const MAX_HEALTH = 1000;
/** Damage fraction above which a vehicle smokes. */
const SMOKE_DAMAGE = 0.6;
/** Damage fraction above which a vehicle burns. */
const FIRE_DAMAGE = 0.85;
/** Restitution used for vehicle-vs-world impacts. */
const WORLD_RESTITUTION = 0.24;
/** Restitution used for vehicle-vs-vehicle impacts. */
const CAR_RESTITUTION = 0.32;
/** Impact speed (m/s) below which a contact does no damage at all. */
const DAMAGE_FLOOR = 2.6;
/** Radians of visual body pitch/roll allowed. */
const MAX_BODY_TILT = 0.075;

/* ------------------------------------------------------------------ *
 * Colour tables (linear space)
 * ------------------------------------------------------------------ */

/** Named paint colours in linear RGB. @type {Object<string, number[]>} */
const PAINT = {
  white: [0.84, 0.85, 0.86],
  silver: [0.52, 0.54, 0.57],
  grey: [0.22, 0.23, 0.25],
  black: [0.032, 0.032, 0.036],
  red: [0.60, 0.045, 0.038],
  darkRed: [0.26, 0.028, 0.03],
  orange: [0.72, 0.20, 0.028],
  yellow: [0.80, 0.60, 0.05],
  taxiYellow: [0.86, 0.56, 0.028],
  green: [0.055, 0.28, 0.12],
  teal: [0.035, 0.30, 0.32],
  blue: [0.045, 0.13, 0.50],
  skyBlue: [0.15, 0.40, 0.70],
  navy: [0.018, 0.045, 0.19],
  purple: [0.22, 0.055, 0.40],
  brown: [0.19, 0.10, 0.045],
  beige: [0.60, 0.53, 0.40],
  wine: [0.30, 0.02, 0.08]
};

/** Trim / detail colours in linear RGB. */
const C_TYRE = [0.030, 0.030, 0.033];
const C_DARK = [0.045, 0.045, 0.050];
const C_RUBBER = [0.055, 0.055, 0.058];
const C_CHROME = [0.72, 0.74, 0.78];
const C_RIM = [0.50, 0.52, 0.55];
const C_STEEL = [0.30, 0.31, 0.33];
const C_PLATE = [0.80, 0.80, 0.74];
const C_INTERIOR = [0.045, 0.042, 0.048];
const C_SEAT = [0.075, 0.07, 0.08];
const C_CALIPER = [0.32, 0.035, 0.03];
const C_WHITE = [1, 1, 1];

/* ------------------------------------------------------------------ *
 * Vehicle type table
 * ------------------------------------------------------------------ */

/**
 * Raw per-type definitions. `maxSpeed` is metres per second, `enginePower` kilowatts,
 * `brakeForce` newtons of total braking force, `steerMax` radians at the road wheel.
 * `drive` picks which axle receives engine torque.
 * @type {Object<string, Object>}
 */
const TYPE_DEFS = {
  sedan: {
    name: 'Sedan', nameKo: '세단', shape: 'car',
    mass: 1420, enginePower: 128, redline: 6200, idleRpm: 780, maxSpeed: 48.6,
    brakeForce: 15200, grip: 1.06, drive: 'fwd', weightFront: 0.60, cdA: 0.70, clA: 0.02,
    steerMax: 0.60, steerSpeed: 4.2, driftFactor: 0.82,
    length: 4.52, width: 1.84, height: 1.45, wheelBase: 2.70, track: 1.56,
    wheelRadius: 0.34, wheelWidth: 0.22, restLength: 0.24, travel: 0.19,
    seats: 4, sirens: false, price: 14000,
    colorOptions: ['white', 'silver', 'grey', 'black', 'red', 'blue', 'navy', 'teal', 'beige', 'wine']
  },
  sports: {
    name: 'Sports', nameKo: '스포츠카', shape: 'car',
    mass: 1300, enginePower: 353, redline: 8200, idleRpm: 900, maxSpeed: 83.3,
    brakeForce: 24000, grip: 1.44, drive: 'rwd', weightFront: 0.45, cdA: 0.60, clA: 0.34,
    steerMax: 0.56, steerSpeed: 5.0, driftFactor: 1.05,
    length: 4.42, width: 1.94, height: 1.21, wheelBase: 2.62, track: 1.68,
    wheelRadius: 0.33, wheelWidth: 0.28, restLength: 0.17, travel: 0.13,
    seats: 2, sirens: false, price: 145000,
    colorOptions: ['red', 'yellow', 'black', 'white', 'silver', 'orange', 'skyBlue', 'purple', 'green']
  },
  suv: {
    name: 'SUV', nameKo: 'SUV', shape: 'wagon',
    mass: 2060, enginePower: 186, redline: 5800, idleRpm: 720, maxSpeed: 52.8,
    brakeForce: 19500, grip: 1.00, drive: 'awd', weightFront: 0.55, cdA: 1.05, clA: 0.0,
    steerMax: 0.56, steerSpeed: 3.6, driftFactor: 0.70,
    length: 4.88, width: 1.98, height: 1.82, wheelBase: 2.86, track: 1.68,
    wheelRadius: 0.40, wheelWidth: 0.26, restLength: 0.33, travel: 0.24,
    seats: 4, sirens: false, price: 42000,
    colorOptions: ['black', 'white', 'silver', 'grey', 'navy', 'green', 'brown', 'darkRed']
  },
  taxi: {
    name: 'Taxi', nameKo: '택시', shape: 'car',
    mass: 1520, enginePower: 118, redline: 6000, idleRpm: 800, maxSpeed: 47.2,
    brakeForce: 15000, grip: 1.02, drive: 'fwd', weightFront: 0.60, cdA: 0.75, clA: 0.02,
    steerMax: 0.60, steerSpeed: 4.0, driftFactor: 0.80,
    length: 4.64, width: 1.86, height: 1.49, wheelBase: 2.76, track: 1.58,
    wheelRadius: 0.34, wheelWidth: 0.22, restLength: 0.25, travel: 0.20,
    seats: 4, sirens: false, price: 16000, taxi: true,
    colorOptions: ['taxiYellow']
  },
  police: {
    name: 'Police Cruiser', nameKo: '순찰차', shape: 'car',
    mass: 1780, enginePower: 288, redline: 7000, idleRpm: 820, maxSpeed: 66.7,
    brakeForce: 22500, grip: 1.28, drive: 'rwd', weightFront: 0.53, cdA: 0.78, clA: 0.12,
    steerMax: 0.58, steerSpeed: 4.6, driftFactor: 0.94,
    length: 4.96, width: 1.94, height: 1.46, wheelBase: 2.94, track: 1.64,
    wheelRadius: 0.35, wheelWidth: 0.24, restLength: 0.23, travel: 0.18,
    seats: 4, sirens: true, price: 0, police: true,
    colorOptions: ['white', 'black']
  },
  van: {
    name: 'Van', nameKo: '밴', shape: 'van',
    mass: 2360, enginePower: 142, redline: 5200, idleRpm: 700, maxSpeed: 41.7,
    brakeForce: 18000, grip: 0.94, drive: 'rwd', weightFront: 0.52, cdA: 1.36, clA: 0.0,
    steerMax: 0.54, steerSpeed: 3.2, driftFactor: 0.66,
    length: 5.30, width: 2.02, height: 2.18, wheelBase: 3.10, track: 1.72,
    wheelRadius: 0.37, wheelWidth: 0.24, restLength: 0.27, travel: 0.22,
    seats: 2, sirens: false, price: 26000,
    colorOptions: ['white', 'silver', 'grey', 'skyBlue', 'brown', 'green', 'beige']
  },
  truck: {
    name: 'Truck', nameKo: '트럭', shape: 'truck',
    mass: 7200, enginePower: 268, redline: 3200, idleRpm: 620, maxSpeed: 33.3,
    brakeForce: 46000, grip: 0.90, drive: 'rwd', weightFront: 0.45, cdA: 2.40, clA: 0.0,
    steerMax: 0.50, steerSpeed: 2.6, driftFactor: 0.58,
    length: 7.60, width: 2.44, height: 2.92, wheelBase: 4.20, track: 2.00,
    wheelRadius: 0.50, wheelWidth: 0.32, restLength: 0.32, travel: 0.26,
    seats: 2, sirens: false, price: 58000, gears: 'heavy',
    colorOptions: ['white', 'red', 'blue', 'grey', 'green', 'orange', 'silver']
  },
  muscle: {
    name: 'Muscle', nameKo: '머슬카', shape: 'car',
    mass: 1660, enginePower: 322, redline: 6600, idleRpm: 700, maxSpeed: 70.8,
    brakeForce: 19800, grip: 1.20, drive: 'rwd', weightFront: 0.54, cdA: 0.82, clA: 0.04,
    steerMax: 0.56, steerSpeed: 4.2, driftFactor: 1.18,
    length: 4.94, width: 1.96, height: 1.34, wheelBase: 2.82, track: 1.66,
    wheelRadius: 0.35, wheelWidth: 0.28, restLength: 0.20, travel: 0.16,
    seats: 4, sirens: false, price: 78000,
    colorOptions: ['red', 'black', 'orange', 'yellow', 'darkRed', 'green', 'blue', 'white']
  },
  bus: {
    name: 'Bus', nameKo: '버스', shape: 'bus',
    mass: 11500, enginePower: 258, redline: 3000, idleRpm: 600, maxSpeed: 30.6,
    brakeForce: 60000, grip: 0.88, drive: 'rwd', weightFront: 0.40, cdA: 3.40, clA: 0.0,
    steerMax: 0.46, steerSpeed: 2.2, driftFactor: 0.52,
    length: 11.40, width: 2.55, height: 3.10, wheelBase: 5.90, track: 2.10,
    wheelRadius: 0.50, wheelWidth: 0.30, restLength: 0.30, travel: 0.24,
    seats: 8, sirens: false, price: 96000, gears: 'heavy',
    colorOptions: ['white', 'skyBlue', 'green', 'orange', 'silver', 'red']
  },
  sportsbike: {
    name: 'Sportsbike', nameKo: '스포츠바이크', shape: 'bike',
    mass: 218, enginePower: 141, redline: 13500, idleRpm: 1400, maxSpeed: 79.2,
    brakeForce: 4600, grip: 1.30, drive: 'rwd', weightFront: 0.48, cdA: 0.42, clA: 0.0,
    steerMax: 0.62, steerSpeed: 5.4, driftFactor: 1.10,
    length: 2.06, width: 0.76, height: 1.16, wheelBase: 1.42, track: 0.60,
    wheelRadius: 0.32, wheelWidth: 0.16, restLength: 0.17, travel: 0.14,
    seats: 2, sirens: false, price: 34000, gears: 'bike', bike: true,
    colorOptions: ['red', 'black', 'blue', 'white', 'orange', 'green', 'yellow']
  }
};

/**
 * Fills in the derived fields every type needs (final drive, inertia, seat layout).
 * @param {string} key Type key.
 * @param {Object} d Raw definition.
 * @returns {Object} The completed, frozen-by-convention type record.
 */
function completeType(key, d) {
  const gearSet = d.gears === 'heavy' ? GEARS_HEAVY : d.gears === 'bike' ? GEARS_BIKE : GEARS_ROAD;
  const topGear = gearSet[gearSet.length - 1];
  // Final drive is chosen so the redline in top gear lands right on the type's maximum speed.
  const finalDrive = (d.redline * 0.10471975511965977 * 0.99 * d.wheelRadius) /
    Math.max(0.5, d.maxSpeed * topGear);
  // Peak crank torque implied by the rated power (peak power sits near 85% of the redline).
  const peakTorque = (d.enginePower * 1000) /
    (d.redline * 0.85 * 0.10471975511965977) * 1.22;
  const comHeight = d.wheelRadius + d.restLength;
  const t = {
    key,
    name: d.name,
    nameKo: d.nameKo,
    shape: d.shape,
    mass: d.mass,
    enginePower: d.enginePower,
    peakTorque,
    redline: d.redline,
    idleRpm: d.idleRpm,
    maxSpeed: d.maxSpeed,
    maxSpeedKmh: d.maxSpeed * 3.6,
    brakeForce: d.brakeForce,
    grip: d.grip,
    drive: d.drive,
    weightFront: d.weightFront,
    cdA: d.cdA,
    clA: d.clA === undefined ? 0 : d.clA,
    steerMax: d.steerMax,
    steerSpeed: d.steerSpeed,
    driftFactor: d.driftFactor,
    length: d.length,
    width: d.width,
    height: d.height,
    wheelBase: d.wheelBase,
    track: d.track,
    wheelRadius: d.wheelRadius,
    wheelWidth: d.wheelWidth,
    restLength: d.restLength,
    travel: d.travel,
    comHeight,
    seats: d.seats,
    sirens: !!d.sirens,
    price: d.price,
    taxi: !!d.taxi,
    police: !!d.police,
    bike: !!d.bike,
    gearRatios: gearSet,
    reverseRatio: d.gears === 'heavy' ? 4.8 : d.gears === 'bike' ? 2.6 : 3.35,
    finalDrive,
    colorOptions: d.colorOptions.map((n) => PAINT[n] || PAINT.white),
    colorNames: d.colorOptions.slice(),
    // Suspension rates: ~1.4 Hz ride frequency with a 0.42 damping ratio.
    springRate: (d.mass * GRAVITY * 0.30) / Math.max(0.02, d.travel * 0.55),
    damperRate: 0,
    yawInertia: d.mass * (d.length * d.length + d.width * d.width) / 12 * 1.18,
    // Radius of the four collision spheres placed at the body corners.
    hitRadius: Math.min(d.width, d.length) * 0.32,
    boundRadius: Math.hypot(d.length * 0.5, d.width * 0.5)
  };
  t.damperRate = 2 * Math.sqrt(t.springRate * (d.mass / 4)) * 0.44;
  return t;
}

/**
 * Every drivable vehicle type. Keys are the identifiers `game.spawnVehicle` accepts.
 * @type {Object<string, Object>}
 */
export const VEHICLE_TYPES = {};
for (const k of Object.keys(TYPE_DEFS)) VEHICLE_TYPES[k] = completeType(k, TYPE_DEFS[k]);

/** Ordered list of type keys, handy for spawners. @type {string[]} */
export const VEHICLE_TYPE_KEYS = Object.keys(VEHICLE_TYPES);

/* ------------------------------------------------------------------ *
 * Geometry assembly helpers
 * ------------------------------------------------------------------ */

/**
 * Builds a model matrix for one body part. Only called while assets are built.
 * @param {number} x Local X.
 * @param {number} y Local Y.
 * @param {number} z Local Z.
 * @param {number} rx Pitch in radians.
 * @param {number} ry Yaw in radians.
 * @param {number} rz Roll in radians.
 * @param {number} sx Scale X.
 * @param {number} sy Scale Y.
 * @param {number} sz Scale Z.
 * @returns {Float32Array} Column-major matrix.
 */
function partMat(x, y, z, rx, ry, rz, sx, sy, sz) {
  const m = mat4.create();
  mat4.identity(m);
  m[12] = x;
  m[13] = y;
  m[14] = z;
  if (ry) mat4.rotateY(m, m, ry);
  if (rx) mat4.rotateX(m, m, rx);
  if (rz) mat4.rotateZ(m, m, rz);
  if (sx !== 1 || sy !== 1 || sz !== 1) mat4.scale(m, m, sx, sy, sz);
  return m;
}

/**
 * Appends one primitive to a merge list.
 * @param {Array} list Destination merge list.
 * @param {Object} geometry Primitive geometry.
 * @param {number} x Local X.
 * @param {number} y Local Y.
 * @param {number} z Local Z.
 * @param {Object} [o] Options: `rx`,`ry`,`rz` radians, `sx`,`sy`,`sz` scale, `color` rgb.
 * @returns {void}
 */
function put(list, geometry, x, y, z, o) {
  const p = o || null;
  list.push({
    geometry,
    matrix: partMat(x, y, z,
      p && p.rx ? p.rx : 0, p && p.ry ? p.ry : 0, p && p.rz ? p.rz : 0,
      p && p.sx !== undefined ? p.sx : 1,
      p && p.sy !== undefined ? p.sy : 1,
      p && p.sz !== undefined ? p.sz : 1),
    color: (p && p.color) || C_WHITE
  });
}

/**
 * Appends a primitive twice, mirrored across the X axis (left and right).
 * @param {Array} list Destination merge list.
 * @param {Object} geometry Primitive geometry.
 * @param {number} x Local X of the right-hand copy (positive).
 * @param {number} y Local Y.
 * @param {number} z Local Z.
 * @param {Object} [o] Same options as {@link put}; `ry`/`rz` are negated on the mirror.
 * @returns {void}
 */
function putPair(list, geometry, x, y, z, o) {
  put(list, geometry, x, y, z, o);
  const m = o ? {
    rx: o.rx || 0, ry: -(o.ry || 0), rz: -(o.rz || 0),
    sx: o.sx, sy: o.sy, sz: o.sz, color: o.color
  } : null;
  put(list, geometry, -x, y, z, m);
}

/**
 * Creates the empty per-material part lists used while assembling one vehicle body.
 * @returns {Object<string, Array>} Named merge lists.
 */
function newPartLists() {
  return {
    paint: [],
    trim: [],
    chrome: [],
    glass: [],
    interior: [],
    lampHead: [],
    lampTail: [],
    lampReverse: [],
    lampSide: [],
    sirenRed: [],
    sirenBlue: [],
    sign: []
  };
}

/**
 * Builds a thin, tilted panel (windscreen, backlight, side glass).
 * The panel is a slab whose local +Y runs from the bottom edge to the top edge.
 * @param {Array} list Destination merge list.
 * @param {number} width Panel width along X.
 * @param {number} thickness Panel thickness.
 * @param {number} x Centre X.
 * @param {number} yBottom Bottom edge Y.
 * @param {number} zBottom Bottom edge Z.
 * @param {number} yTop Top edge Y.
 * @param {number} zTop Top edge Z.
 * @param {number[]} color Vertex colour.
 * @returns {void}
 */
function putPanel(list, width, thickness, x, yBottom, zBottom, yTop, zTop, color) {
  const dy = yTop - yBottom;
  const dz = zTop - zBottom;
  const len = Math.max(0.02, Math.hypot(dy, dz));
  const angle = Math.atan2(dz, dy);
  put(list, box(width, len, thickness), x, (yBottom + yTop) * 0.5, (zBottom + zTop) * 0.5,
    { rx: angle, color });
}

/**
 * Builds the shared unit wheel: rim barrel, spokes, hub, brake disc and a rounded tyre.
 * Radius is 1, width is 1 along the X axis, so callers scale by
 * `(wheelWidth, wheelRadius, wheelRadius)`.
 * @param {boolean} detailed False for the low-detail LOD wheel.
 * @returns {Object} Merged geometry.
 */
function buildWheelGeometry(detailed) {
  const seg = detailed ? 20 : 12;
  const parts = [];

  // Assembled with the axle along +Y, then rotated so the axle lies along +X.
  const tread = cylinder(1.0, 1.0, 0.62, seg, false);
  put(parts, tread, 0, 0, 0, { color: C_TYRE });
  const sidewall = cylinder(0.70, 0.99, 0.16, seg, true);
  put(parts, sidewall, 0, 0.36, 0, { color: C_TYRE });
  put(parts, sidewall, 0, -0.36, 0, { rz: Math.PI, color: C_TYRE });
  if (detailed) {
    const shoulder = torus(0.92, 0.10, 5, seg);
    put(parts, shoulder, 0, 0.28, 0, { color: C_RUBBER });
    put(parts, shoulder, 0, -0.28, 0, { color: C_RUBBER });
  }

  const rim = cylinder(0.70, 0.70, 0.60, seg, true);
  put(parts, rim, 0, 0.02, 0, { color: C_RIM });
  if (detailed) {
    const lip = torus(0.70, 0.045, 5, seg);
    put(parts, lip, 0, 0.31, 0, { color: C_CHROME });
    put(parts, lip, 0, -0.29, 0, { color: C_CHROME });
    const spoke = box(0.17, 0.13, 0.52);
    for (let i = 0; i < 5; i++) {
      // Rotate about the axle, then push the spoke out along its own +Z to the rim.
      const m = partMat(0, 0.26, 0, 0, (i / 5) * Math.PI * 2, 0, 1, 1, 1);
      mat4.translate(m, m, 0, 0, 0.40);
      parts.push({ geometry: spoke, matrix: m, color: C_RIM });
    }
    const hub = cylinder(0.24, 0.24, 0.66, 10, true);
    put(parts, hub, 0, 0.06, 0, { color: C_CHROME });
    const disc = cylinder(0.60, 0.60, 0.07, 14, true);
    put(parts, disc, 0, -0.16, 0, { color: C_STEEL });
    const caliper = box(0.11, 0.26, 0.30);
    put(parts, caliper, 0, -0.10, 0.46, { color: C_CALIPER });
  } else {
    const hub = cylinder(0.30, 0.30, 0.64, 8, true);
    put(parts, hub, 0, 0.04, 0, { color: C_RIM });
  }

  const geo = mergeGeometries(parts);
  // Rotate the whole wheel so its axle points along +X.
  const rot = mat4.create();
  mat4.identity(rot);
  mat4.rotateZ(rot, rot, -Math.PI * 0.5);
  transformInPlace(geo, rot);
  computeBounds(geo);
  return geo;
}

/**
 * Applies a matrix to a geometry in place (positions and normals).
 * A local copy so asset assembly does not depend on the optional geometry helper.
 * @param {Object} geo Geometry object.
 * @param {ArrayLike<number>} m Column-major matrix (rotation + translation only).
 * @returns {Object} The same geometry.
 */
function transformInPlace(geo, m) {
  const p = geo.positions;
  const n = geo.normals;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i];
    const y = p[i + 1];
    const z = p[i + 2];
    p[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    p[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    p[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    if (n) {
      const nx = n[i];
      const ny = n[i + 1];
      const nz = n[i + 2];
      n[i] = m[0] * nx + m[4] * ny + m[8] * nz;
      n[i + 1] = m[1] * nx + m[5] * ny + m[9] * nz;
      n[i + 2] = m[2] * nx + m[6] * ny + m[10] * nz;
    }
  }
  return geo;
}

/**
 * Builds an additive light cone whose apex sits at the origin and which opens toward -Z.
 * Vertex colours fade from white at the apex to black at the mouth so the additive blend
 * produces a soft volumetric shaft with no hard edge.
 * @param {number} radius Mouth radius in metres.
 * @param {number} length Cone length in metres.
 * @param {number} [seg=14] Radial segments.
 * @returns {Object} Geometry with vertex colours.
 */
function buildLightCone(radius, length, seg = 14) {
  const rings = [
    { t: 0.0, r: 0.045, c: 1.0 },
    { t: 0.22, r: 0.30, c: 0.52 },
    { t: 0.58, r: 0.68, c: 0.20 },
    { t: 1.0, r: 1.0, c: 0.0 }
  ];
  const vCount = rings.length * (seg + 1);
  const positions = new Float32Array(vCount * 3);
  const normals = new Float32Array(vCount * 3);
  const uvs = new Float32Array(vCount * 2);
  const colors = new Float32Array(vCount * 3);
  const indices = new Uint32Array((rings.length - 1) * seg * 6);
  let vp = 0;
  let up = 0;
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const cx = Math.cos(a) * ring.r * radius;
      const cy = Math.sin(a) * ring.r * radius;
      positions[vp] = cx;
      positions[vp + 1] = cy;
      positions[vp + 2] = -ring.t * length;
      normals[vp] = 0;
      normals[vp + 1] = 0;
      normals[vp + 2] = -1;
      colors[vp] = ring.c;
      colors[vp + 1] = ring.c;
      colors[vp + 2] = ring.c;
      vp += 3;
      uvs[up] = i / seg;
      uvs[up + 1] = ring.t;
      up += 2;
    }
  }
  let ip = 0;
  const stride = seg + 1;
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < seg; i++) {
      const a = r * stride + i;
      const b = a + stride;
      indices[ip] = a;
      indices[ip + 1] = b;
      indices[ip + 2] = a + 1;
      indices[ip + 3] = b;
      indices[ip + 4] = b + 1;
      indices[ip + 5] = a + 1;
      ip += 6;
    }
  }
  const geo = { positions, normals, uvs, colors, indices };
  computeBounds(geo);
  return geo;
}

/* ------------------------------------------------------------------ *
 * Body builders
 * ------------------------------------------------------------------ */

/**
 * Builds the shared detail set every road car gets: bumpers, grille, lights, plates,
 * mirrors, exhaust, door handles and a simple interior.
 * @param {Object} L Part lists from {@link newPartLists}.
 * @param {Object} S Shape metrics produced by {@link carMetrics}.
 * @returns {void}
 */
function addCarDetails(L, S) {
  const { w, hw, zFront, zRear, ground, sillY, beltY, roofY, hasBoot } = S;

  /* --- bumpers and valances ------------------------------------------------------- */
  const bumpY = ground + S.height * 0.24;
  put(L.trim, roundedBox(w * 0.99, S.height * 0.20, 0.22, 0.06, 2),
    0, bumpY, zFront + 0.09, { color: C_DARK });
  put(L.trim, roundedBox(w * 0.99, S.height * 0.20, 0.22, 0.06, 2),
    0, bumpY, zRear - 0.09, { color: C_DARK });
  // Lower splitter / diffuser hint.
  put(L.trim, box(w * 0.82, 0.06, 0.34), 0, ground + 0.13, zFront + 0.17, { color: C_DARK });
  put(L.trim, box(w * 0.78, 0.08, 0.30), 0, ground + 0.13, zRear - 0.17, { color: C_DARK });
  // Rocker panels.
  putPair(L.trim, box(0.07, 0.14, S.wheelBase * 0.86), hw - 0.02, ground + 0.16, 0,
    { color: C_DARK });

  /* --- grille ---------------------------------------------------------------------- */
  const grillY = ground + S.height * 0.36;
  put(L.trim, box(w * 0.52, S.height * 0.13, 0.10), 0, grillY, zFront + 0.03, { color: C_DARK });
  for (let i = 0; i < 3; i++) {
    put(L.chrome, box(w * 0.5, 0.022, 0.05), 0, grillY - 0.05 + i * 0.05, zFront + 0.01,
      { color: C_CHROME });
  }
  // Front badge.
  put(L.chrome, box(0.10, 0.10, 0.04), 0, grillY + 0.02, zFront - 0.01, { color: C_CHROME });

  /* --- head lights ------------------------------------------------------------------ */
  const headY = ground + S.height * 0.44;
  const headX = hw * 0.68;
  putPair(L.lampHead, roundedBox(0.34, 0.15, 0.13, 0.045, 2), headX, headY, zFront + 0.04,
    { color: C_WHITE });
  // Chrome bezel around each lamp.
  putPair(L.chrome, box(0.38, 0.19, 0.06), headX, headY, zFront + 0.10, { color: C_STEEL });
  // Amber indicator strip below the main lamp.
  putPair(L.lampSide, box(0.20, 0.05, 0.08), headX + 0.06, headY - 0.12, zFront + 0.05,
    { color: C_WHITE });

  /* --- tail lights ------------------------------------------------------------------- */
  const tailY = ground + S.height * (hasBoot ? 0.50 : 0.56);
  const tailX = hw * 0.70;
  putPair(L.lampTail, roundedBox(0.36, 0.17, 0.11, 0.04, 2), tailX, tailY, zRear - 0.05,
    { color: C_WHITE });
  putPair(L.lampReverse, box(0.11, 0.07, 0.08), tailX - 0.11, tailY - 0.08, zRear - 0.04,
    { color: C_WHITE });
  putPair(L.chrome, box(0.40, 0.21, 0.05), tailX, tailY, zRear - 0.11, { color: C_STEEL });

  /* --- number plates ------------------------------------------------------------------ */
  put(L.trim, box(0.34, 0.13, 0.03), 0, ground + S.height * 0.27, zFront + 0.13,
    { color: C_PLATE });
  put(L.trim, box(0.34, 0.13, 0.03), 0, ground + S.height * 0.29, zRear - 0.13,
    { color: C_PLATE });

  /* --- mirrors -------------------------------------------------------------------------- */
  const mirrorZ = S.cabinFrontZ + S.wsRun * 0.55;
  putPair(L.paint, box(0.07, 0.045, 0.10), hw - 0.02, beltY + 0.03, mirrorZ, { color: C_WHITE });
  putPair(L.paint, roundedBox(0.09, 0.12, 0.20, 0.04, 2), hw + 0.09, beltY + 0.05, mirrorZ,
    { color: C_WHITE });
  putPair(L.chrome, box(0.02, 0.09, 0.15), hw + 0.13, beltY + 0.05, mirrorZ, { color: C_CHROME });

  /* --- door handles ---------------------------------------------------------------------- */
  putPair(L.chrome, box(0.03, 0.035, 0.14), hw - 0.005, beltY - 0.14, -0.15, { color: C_CHROME });
  if (S.doors > 2) {
    putPair(L.chrome, box(0.03, 0.035, 0.14), hw - 0.005, beltY - 0.14, 0.85, { color: C_CHROME });
  }

  /* --- exhaust ------------------------------------------------------------------------------ */
  const exX = hw * 0.55;
  put(L.chrome, cylinder(0.048, 0.052, 0.18, 8, true), exX, ground + 0.14, zRear - 0.06,
    { rx: Math.PI * 0.5, color: C_CHROME });
  if (S.twinExhaust) {
    put(L.chrome, cylinder(0.048, 0.052, 0.18, 8, true), -exX, ground + 0.14, zRear - 0.06,
      { rx: Math.PI * 0.5, color: C_CHROME });
  }

  /* --- interior ------------------------------------------------------------------------------- */
  const seatY = ground + S.height * 0.36;
  const seatBackY = seatY + 0.30;
  const seatX = w * 0.24;
  putPair(L.interior, box(0.42, 0.10, 0.44), seatX, seatY, S.frontSeatZ, { color: C_SEAT });
  putPair(L.interior, box(0.42, 0.50, 0.11), seatX, seatBackY, S.frontSeatZ + 0.20,
    { color: C_SEAT });
  if (S.doors > 2) {
    put(L.interior, box(w * 0.72, 0.10, 0.42), 0, seatY, S.rearSeatZ, { color: C_SEAT });
    put(L.interior, box(w * 0.72, 0.46, 0.11), 0, seatBackY - 0.02, S.rearSeatZ + 0.19,
      { color: C_SEAT });
  }
  // Dashboard and steering wheel.
  put(L.interior, box(w * 0.86, 0.16, 0.26), 0, beltY - 0.13, S.cabinFrontZ + 0.14,
    { color: C_INTERIOR });
  put(L.interior, torus(0.16, 0.022, 5, 12), -seatX, beltY - 0.07, S.cabinFrontZ + 0.30,
    { rx: 1.15, color: C_INTERIOR });
  put(L.interior, box(w * 0.9, 0.05, 0.9), 0, sillY + 0.02, 0.1, { color: C_INTERIOR });
}

/**
 * Computes the shared metric layout for a car-shaped body.
 * @param {Object} t Vehicle type record.
 * @param {Object} k Shape knobs.
 * @returns {Object} Metrics consumed by the body builders.
 */
function carMetrics(t, k) {
  const w = t.width;
  const hw = w * 0.5;
  const ground = -t.comHeight;
  const height = t.height;
  const roofY = ground + height;
  const beltY = ground + height * k.belt;
  const sillY = ground + height * 0.20;
  const zFront = -t.length * 0.5;
  const zRear = t.length * 0.5;
  const cabinFrontZ = zFront + t.length * k.hood;
  const cabinRearZ = zRear - t.length * k.boot;
  return {
    t,
    w,
    hw,
    height,
    ground,
    roofY,
    beltY,
    sillY,
    zFront,
    zRear,
    cabinFrontZ,
    cabinRearZ,
    wsRun: t.length * k.wsRun,
    bsRun: t.length * k.bsRun,
    cabinInset: k.inset * w,
    wheelBase: t.wheelBase,
    axleF: -t.wheelBase * 0.5,
    axleR: t.wheelBase * 0.5,
    doors: k.doors,
    hasBoot: k.boot > 0.06,
    twinExhaust: !!k.twinExhaust,
    frontSeatZ: cabinFrontZ + (cabinRearZ - cabinFrontZ) * 0.34,
    rearSeatZ: cabinFrontZ + (cabinRearZ - cabinFrontZ) * 0.74
  };
}

/**
 * Builds a three-box or two-box car body: bonnet, raked cabin, boot, arches and glass.
 * @param {Object} t Vehicle type record.
 * @param {Object} k Shape knobs.
 * @returns {Object} Part lists ready to merge.
 */
function buildCarBody(t, k) {
  const L = newPartLists();
  const S = carMetrics(t, k);
  const { w, hw, ground, beltY, roofY, sillY, zFront, zRear, cabinFrontZ, cabinRearZ } = S;
  const bodyLen = t.length;
  const lowerH = beltY - sillY;

  /* --- lower body ------------------------------------------------------------------------ */
  put(L.paint, roundedBox(w, lowerH, bodyLen * 0.995, 0.16, 3),
    0, (sillY + beltY) * 0.5, 0, { color: C_WHITE });
  // Underfloor slab closes the silhouette from below.
  put(L.paint, box(w * 0.92, sillY - ground - 0.06, bodyLen * 0.9),
    0, (ground + 0.06 + sillY) * 0.5, 0, { color: C_WHITE });

  /* --- bonnet ------------------------------------------------------------------------------- */
  const hoodLen = cabinFrontZ - zFront;
  const noseDrop = S.height * k.noseDrop;
  put(L.paint, roundedBox(w * 0.95, 0.13, hoodLen * 0.98, 0.05, 2),
    0, beltY - 0.03 - noseDrop * 0.5, zFront + hoodLen * 0.5,
    { rx: -Math.atan2(noseDrop, hoodLen), color: C_WHITE });
  // Front wings blend the bonnet into the arches.
  putPair(L.paint, roundedBox(0.16, 0.20, hoodLen * 0.9, 0.06, 2),
    hw - 0.07, beltY - 0.09, zFront + hoodLen * 0.5, { color: C_WHITE });

  /* --- boot / tail ----------------------------------------------------------------------------- */
  if (S.hasBoot) {
    const bootLen = zRear - cabinRearZ;
    put(L.paint, roundedBox(w * 0.95, 0.14, bootLen * 0.98, 0.05, 2),
      0, beltY + 0.01, cabinRearZ + bootLen * 0.5, { color: C_WHITE });
    if (k.spoiler) {
      put(L.paint, box(w * 0.80, 0.045, 0.20), 0, beltY + 0.13, cabinRearZ + bootLen * 0.72,
        { color: C_WHITE });
      putPair(L.paint, box(0.05, 0.13, 0.10), w * 0.36, beltY + 0.07,
        cabinRearZ + bootLen * 0.72, { color: C_WHITE });
    }
  }

  /* --- cabin ------------------------------------------------------------------------------------ */
  const cw = w - S.cabinInset * 2;
  const roofFrontZ = cabinFrontZ + S.wsRun;
  const roofRearZ = cabinRearZ - S.bsRun;
  put(L.paint, roundedBox(cw, 0.10, Math.max(0.25, roofRearZ - roofFrontZ), 0.05, 2),
    0, roofY - 0.05, (roofFrontZ + roofRearZ) * 0.5, { color: C_WHITE });
  // A pillars.
  putPanel(L.paint, 0.075, 0.075, (cw - 0.05) * 0.5, beltY, cabinFrontZ, roofY - 0.02, roofFrontZ,
    C_WHITE);
  putPanel(L.paint, 0.075, 0.075, -(cw - 0.05) * 0.5, beltY, cabinFrontZ, roofY - 0.02, roofFrontZ,
    C_WHITE);
  // C pillars.
  putPanel(L.paint, 0.085, 0.085, (cw - 0.05) * 0.5, beltY, cabinRearZ, roofY - 0.02, roofRearZ,
    C_WHITE);
  putPanel(L.paint, 0.085, 0.085, -(cw - 0.05) * 0.5, beltY, cabinRearZ, roofY - 0.02, roofRearZ,
    C_WHITE);
  // B pillar.
  if (S.doors > 2) {
    const bz = (roofFrontZ + roofRearZ) * 0.5;
    putPair(L.paint, box(0.06, roofY - beltY, 0.09), (cw - 0.04) * 0.5, (beltY + roofY) * 0.5, bz,
      { color: C_WHITE });
  }
  // Roof rails / drip channels.
  putPair(L.trim, box(0.05, 0.035, Math.max(0.2, roofRearZ - roofFrontZ)), (cw - 0.05) * 0.5,
    roofY - 0.03, (roofFrontZ + roofRearZ) * 0.5, { color: C_DARK });

  /* --- glass -------------------------------------------------------------------------------------- */
  putPanel(L.glass, cw - 0.10, 0.035, 0, beltY + 0.01, cabinFrontZ, roofY - 0.06, roofFrontZ,
    C_WHITE);
  putPanel(L.glass, cw - 0.12, 0.035, 0, beltY + 0.01, cabinRearZ, roofY - 0.06, roofRearZ,
    C_WHITE);
  const sideLen = Math.max(0.2, roofRearZ - roofFrontZ + S.wsRun * 0.55 + S.bsRun * 0.55);
  const sideZ = (roofFrontZ + roofRearZ) * 0.5 - S.wsRun * 0.28 + S.bsRun * 0.28;
  putPair(L.glass, box(0.03, roofY - beltY - 0.12, sideLen), (cw - 0.02) * 0.5,
    (beltY + roofY) * 0.5 - 0.02, sideZ, { color: C_WHITE });

  /* --- wheel arches -------------------------------------------------------------------------------- */
  const archR = t.wheelRadius * 1.20;
  const arch = torus(archR, 0.055, 5, 12);
  putPair(L.paint, arch, hw - 0.03, ground + t.wheelRadius, S.axleF,
    { rz: Math.PI * 0.5, color: C_WHITE });
  putPair(L.paint, arch, hw - 0.03, ground + t.wheelRadius, S.axleR,
    { rz: Math.PI * 0.5, color: C_WHITE });
  // Arch fillers hide the wheel well interior.
  putPair(L.trim, cylinder(archR * 0.95, archR * 0.95, 0.05, 10, false), hw - 0.10,
    ground + t.wheelRadius, S.axleF, { rz: Math.PI * 0.5, color: C_DARK });
  putPair(L.trim, cylinder(archR * 0.95, archR * 0.95, 0.05, 10, false), hw - 0.10,
    ground + t.wheelRadius, S.axleR, { rz: Math.PI * 0.5, color: C_DARK });

  addCarDetails(L, S);
  return { lists: L, metrics: S };
}

/**
 * Builds a one-and-a-half box body (SUV / wagon): long roof, vertical tailgate.
 * @param {Object} t Vehicle type record.
 * @param {Object} k Shape knobs.
 * @returns {Object} Part lists ready to merge.
 */
function buildWagonBody(t, k) {
  const res = buildCarBody(t, k);
  const L = res.lists;
  const S = res.metrics;
  // Roof rails and a rear spoiler over the tailgate.
  putPair(L.trim, box(0.06, 0.06, t.length * 0.42), S.w * 0.36, S.roofY + 0.03, -0.1,
    { color: C_DARK });
  put(L.paint, box(S.w * 0.72, 0.05, 0.22), 0, S.roofY + 0.02, S.cabinRearZ - S.bsRun * 0.4,
    { color: C_WHITE });
  // Skid plates.
  put(L.trim, box(S.w * 0.6, 0.05, 0.26), 0, S.ground + 0.10, S.zFront + 0.24, { color: C_STEEL });
  put(L.trim, box(S.w * 0.6, 0.05, 0.26), 0, S.ground + 0.10, S.zRear - 0.24, { color: C_STEEL });
  return res;
}

/**
 * Builds a tall panel van: short bonnet, near vertical windscreen, box cargo area.
 * @param {Object} t Vehicle type record.
 * @returns {Object} Part lists ready to merge.
 */
function buildVanBody(t) {
  const L = newPartLists();
  const S = carMetrics(t, {
    belt: 0.56, hood: 0.14, boot: 0.02, wsRun: 0.09, bsRun: 0.01, inset: 0.02, doors: 2
  });
  const { w, hw, ground, beltY, roofY, sillY, zFront, zRear, cabinFrontZ } = S;

  put(L.paint, roundedBox(w, beltY - sillY, t.length * 0.99, 0.14, 3),
    0, (sillY + beltY) * 0.5, 0, { color: C_WHITE });
  put(L.paint, box(w * 0.93, sillY - ground - 0.05, t.length * 0.92),
    0, (ground + 0.05 + sillY) * 0.5, 0, { color: C_WHITE });
  // Short bonnet.
  put(L.paint, roundedBox(w * 0.94, 0.12, t.length * 0.14, 0.05, 2),
    0, beltY - 0.04, zFront + t.length * 0.07, { rx: -0.12, color: C_WHITE });
  // Cargo box.
  const boxFrontZ = cabinFrontZ + S.wsRun;
  put(L.paint, roundedBox(w * 0.99, roofY - beltY, zRear - boxFrontZ, 0.10, 2),
    0, (beltY + roofY) * 0.5, (boxFrontZ + zRear) * 0.5, { color: C_WHITE });
  put(L.paint, roundedBox(w * 0.92, 0.09, zRear - boxFrontZ + 0.05, 0.05, 2),
    0, roofY - 0.03, (boxFrontZ + zRear) * 0.5, { color: C_WHITE });
  // Cab pillars + steep windscreen.
  putPanel(L.paint, 0.08, 0.08, (w - 0.08) * 0.5, beltY, cabinFrontZ, roofY - 0.04, boxFrontZ,
    C_WHITE);
  putPanel(L.paint, 0.08, 0.08, -(w - 0.08) * 0.5, beltY, cabinFrontZ, roofY - 0.04, boxFrontZ,
    C_WHITE);
  putPanel(L.glass, w * 0.90, 0.035, 0, beltY + 0.02, cabinFrontZ, roofY - 0.07, boxFrontZ,
    C_WHITE);
  putPair(L.glass, box(0.03, roofY - beltY - 0.18, 0.95), (w - 0.02) * 0.5,
    (beltY + roofY) * 0.5 - 0.04, boxFrontZ + 0.52, { color: C_WHITE });
  // Rear doors: two glass panes and a centre seam.
  putPair(L.glass, box(w * 0.40, 0.42, 0.03), w * 0.24, roofY - 0.36, zRear - 0.02,
    { color: C_WHITE });
  put(L.trim, box(0.05, roofY - beltY, 0.05), 0, (beltY + roofY) * 0.5, zRear - 0.01,
    { color: C_DARK });
  // Corrugation ribs down the cargo sides.
  for (let i = 0; i < 4; i++) {
    const z = boxFrontZ + 0.4 + i * ((zRear - boxFrontZ - 0.6) / 3);
    putPair(L.paint, box(0.035, roofY - beltY - 0.12, 0.06), hw, (beltY + roofY) * 0.5, z,
      { color: C_WHITE });
  }

  const archR = t.wheelRadius * 1.18;
  const arch = torus(archR, 0.055, 5, 12);
  putPair(L.paint, arch, hw - 0.03, ground + t.wheelRadius, S.axleF,
    { rz: Math.PI * 0.5, color: C_WHITE });
  putPair(L.paint, arch, hw - 0.03, ground + t.wheelRadius, S.axleR,
    { rz: Math.PI * 0.5, color: C_WHITE });
  putPair(L.trim, cylinder(archR * 0.95, archR * 0.95, 0.05, 10, false), hw - 0.10,
    ground + t.wheelRadius, S.axleF, { rz: Math.PI * 0.5, color: C_DARK });
  putPair(L.trim, cylinder(archR * 0.95, archR * 0.95, 0.05, 10, false), hw - 0.10,
    ground + t.wheelRadius, S.axleR, { rz: Math.PI * 0.5, color: C_DARK });

  S.doors = 2;
  addCarDetails(L, S);
  return { lists: L, metrics: S };
}

/**
 * Builds a flatbed lorry: cab over the front axle, chassis rails and a cargo bed.
 * @param {Object} t Vehicle type record.
 * @returns {Object} Part lists ready to merge.
 */
function buildTruckBody(t) {
  const L = newPartLists();
  const S = carMetrics(t, {
    belt: 0.62, hood: 0.10, boot: 0.02, wsRun: 0.05, bsRun: 0.01, inset: 0.01, doors: 2
  });
  const { w, hw, ground, zFront, zRear, roofY } = S;
  const frameY = ground + 0.52;
  const cabRear = zFront + t.length * 0.36;
  const cabTop = ground + t.height * 0.98;
  const cabFloor = frameY + 0.10;

  // Chassis rails and the axle beams.
  putPair(L.trim, box(0.16, 0.24, t.length * 0.94), w * 0.30, frameY, 0, { color: C_STEEL });
  put(L.trim, box(w * 0.86, 0.16, 0.22), 0, frameY - 0.06, S.axleF, { color: C_STEEL });
  put(L.trim, box(w * 0.86, 0.16, 0.22), 0, frameY - 0.06, S.axleR, { color: C_STEEL });

  // Cab.
  put(L.paint, roundedBox(w * 0.98, cabTop - cabFloor, cabRear - zFront, 0.12, 3),
    0, (cabFloor + cabTop) * 0.5, (zFront + cabRear) * 0.5, { color: C_WHITE });
  put(L.paint, roundedBox(w * 0.92, 0.10, cabRear - zFront - 0.1, 0.05, 2),
    0, cabTop - 0.04, (zFront + cabRear) * 0.5, { color: C_WHITE });
  // Windscreen and side glass sunk into the cab.
  const glassBase = cabFloor + (cabTop - cabFloor) * 0.44;
  putPanel(L.glass, w * 0.86, 0.04, 0, glassBase, zFront + 0.06, cabTop - 0.14, zFront + 0.32,
    C_WHITE);
  putPair(L.glass, box(0.03, cabTop - glassBase - 0.22, (cabRear - zFront) * 0.5),
    w * 0.49, glassBase + (cabTop - glassBase) * 0.42, zFront + (cabRear - zFront) * 0.62,
    { color: C_WHITE });
  // Bull bar and grille.
  put(L.trim, box(w * 0.96, 0.30, 0.20), 0, frameY + 0.06, zFront + 0.06, { color: C_DARK });
  for (let i = 0; i < 4; i++) {
    put(L.chrome, box(w * 0.6, 0.05, 0.05), 0, glassBase - 0.42 + i * 0.11, zFront + 0.02,
      { color: C_CHROME });
  }
  // Exhaust stack behind the cab.
  put(L.chrome, cylinder(0.075, 0.075, 1.5, 8, true), hw - 0.14, cabFloor + 0.75, cabRear + 0.05,
    { color: C_CHROME });
  // Cargo bed.
  const bedFrontZ = cabRear + 0.12;
  const bedFloorY = frameY + 0.20;
  put(L.paint, box(w * 0.98, 0.10, zRear - bedFrontZ), 0, bedFloorY, (bedFrontZ + zRear) * 0.5,
    { color: C_WHITE });
  putPair(L.paint, box(0.08, 0.66, zRear - bedFrontZ), hw - 0.04, bedFloorY + 0.36,
    (bedFrontZ + zRear) * 0.5, { color: C_WHITE });
  put(L.paint, box(w * 0.98, 0.66, 0.08), 0, bedFloorY + 0.36, zRear - 0.04, { color: C_WHITE });
  put(L.paint, box(w * 0.98, 0.90, 0.08), 0, bedFloorY + 0.48, bedFrontZ + 0.04,
    { color: C_WHITE });
  // Mud flaps.
  putPair(L.trim, box(0.30, 0.34, 0.03), w * 0.34, ground + 0.20, zRear - 0.10, { color: C_DARK });

  // Lights.
  const headY = frameY + 0.10;
  putPair(L.lampHead, roundedBox(0.30, 0.20, 0.12, 0.04, 2), hw * 0.66, headY, zFront + 0.03,
    { color: C_WHITE });
  putPair(L.lampTail, box(0.26, 0.34, 0.10), hw * 0.72, frameY + 0.04, zRear - 0.03,
    { color: C_WHITE });
  putPair(L.lampReverse, box(0.12, 0.09, 0.08), hw * 0.72, frameY - 0.14, zRear - 0.03,
    { color: C_WHITE });
  // Roof marker lamps.
  for (let i = -2; i <= 2; i++) {
    put(L.lampSide, box(0.08, 0.05, 0.08), i * w * 0.17, cabTop + 0.04, zFront + 0.30,
      { color: C_WHITE });
  }
  put(L.trim, box(0.34, 0.14, 0.03), 0, frameY - 0.14, zFront + 0.16, { color: C_PLATE });
  put(L.trim, box(0.34, 0.14, 0.03), 0, frameY - 0.16, zRear - 0.10, { color: C_PLATE });
  // Mirrors on tall stalks.
  putPair(L.trim, box(0.04, 0.55, 0.04), hw + 0.06, glassBase + 0.20, zFront + 0.34,
    { color: C_DARK });
  putPair(L.trim, box(0.05, 0.40, 0.16), hw + 0.12, glassBase + 0.24, zFront + 0.34,
    { color: C_DARK });
  // Cab interior.
  putPair(L.interior, box(0.44, 0.56, 0.14), w * 0.24, cabFloor + 0.42, zFront + 0.90,
    { color: C_SEAT });
  put(L.interior, box(w * 0.88, 0.16, 0.24), 0, glassBase - 0.10, zFront + 0.40,
    { color: C_INTERIOR });
  put(L.interior, torus(0.20, 0.025, 5, 12), -w * 0.24, glassBase - 0.02, zFront + 0.56,
    { rx: 1.2, color: C_INTERIOR });

  S.frontSeatZ = zFront + 0.9;
  S.rearSeatZ = zFront + 0.9;
  return { lists: L, metrics: S };
}

/**
 * Builds a city bus: long slab body, window band, doors and a roof vent.
 * @param {Object} t Vehicle type record.
 * @returns {Object} Part lists ready to merge.
 */
function buildBusBody(t) {
  const L = newPartLists();
  const S = carMetrics(t, {
    belt: 0.46, hood: 0.04, boot: 0.02, wsRun: 0.05, bsRun: 0.02, inset: 0.01, doors: 2
  });
  const { w, hw, ground, zFront, zRear, roofY } = S;
  const floorY = ground + 0.42;
  const beltY = ground + t.height * 0.46;

  put(L.paint, roundedBox(w, beltY - floorY, t.length * 0.995, 0.16, 3),
    0, (floorY + beltY) * 0.5, 0, { color: C_WHITE });
  put(L.paint, box(w * 0.94, floorY - ground - 0.06, t.length * 0.94),
    0, (ground + 0.06 + floorY) * 0.5, 0, { color: C_WHITE });
  put(L.paint, roundedBox(w, roofY - beltY, t.length * 0.995, 0.20, 3),
    0, (beltY + roofY) * 0.5, 0, { color: C_WHITE });
  put(L.paint, roundedBox(w * 0.94, 0.10, t.length * 0.96, 0.06, 2),
    0, roofY - 0.04, 0, { color: C_WHITE });

  // Window band down both sides (one long pane per side plus mullions).
  const winY = beltY + (roofY - beltY) * 0.52;
  const winH = (roofY - beltY) * 0.62;
  putPair(L.glass, box(0.03, winH, t.length * 0.82), (w - 0.02) * 0.5, winY, 0.2,
    { color: C_WHITE });
  const bays = 9;
  for (let i = 0; i <= bays; i++) {
    const z = -t.length * 0.41 + (i / bays) * t.length * 0.82 + 0.2;
    putPair(L.paint, box(0.05, winH + 0.06, 0.09), hw - 0.005, winY, z, { color: C_WHITE });
  }
  // Windscreen and rear screen.
  putPanel(L.glass, w * 0.9, 0.04, 0, beltY + 0.10, zFront + 0.05, roofY - 0.16, zFront + 0.30,
    C_WHITE);
  putPanel(L.glass, w * 0.88, 0.04, 0, beltY + 0.16, zRear - 0.05, roofY - 0.20, zRear - 0.26,
    C_WHITE);
  // Doors: darker glass panels near the front and middle.
  put(L.glass, box(0.03, beltY + winH * 0.4 - floorY, 1.05), (w - 0.02) * 0.5,
    (floorY + beltY + winH * 0.4) * 0.5, zFront + 1.35, { color: C_WHITE });
  put(L.glass, box(0.03, beltY + winH * 0.4 - floorY, 1.05), (w - 0.02) * 0.5,
    (floorY + beltY + winH * 0.4) * 0.5, 1.4, { color: C_WHITE });
  // Roof hatches and vents.
  put(L.trim, box(0.70, 0.09, 0.70), 0, roofY + 0.02, -t.length * 0.22, { color: C_DARK });
  put(L.trim, box(0.70, 0.09, 0.70), 0, roofY + 0.02, t.length * 0.22, { color: C_DARK });
  // Skirts, bumpers.
  put(L.trim, box(w * 0.99, 0.24, 0.20), 0, floorY - 0.06, zFront + 0.07, { color: C_DARK });
  put(L.trim, box(w * 0.99, 0.24, 0.20), 0, floorY - 0.06, zRear - 0.07, { color: C_DARK });
  // Wheel arches.
  const archR = t.wheelRadius * 1.16;
  const arch = torus(archR, 0.06, 5, 12);
  putPair(L.paint, arch, hw - 0.03, ground + t.wheelRadius, S.axleF,
    { rz: Math.PI * 0.5, color: C_WHITE });
  putPair(L.paint, arch, hw - 0.03, ground + t.wheelRadius, S.axleR,
    { rz: Math.PI * 0.5, color: C_WHITE });

  // Lights.
  putPair(L.lampHead, roundedBox(0.34, 0.20, 0.12, 0.04, 2), hw * 0.68, floorY + 0.02,
    zFront + 0.04, { color: C_WHITE });
  putPair(L.lampTail, box(0.24, 0.44, 0.10), hw * 0.74, floorY + 0.10, zRear - 0.04,
    { color: C_WHITE });
  putPair(L.lampReverse, box(0.14, 0.10, 0.08), hw * 0.74, floorY - 0.18, zRear - 0.04,
    { color: C_WHITE });
  put(L.lampSide, box(0.9, 0.14, 0.05), 0, roofY - 0.22, zFront + 0.03, { color: C_WHITE });
  put(L.trim, box(0.36, 0.14, 0.03), 0, floorY - 0.18, zRear - 0.14, { color: C_PLATE });
  // Interior: driver seat plus a run of passenger seats.
  put(L.interior, box(0.44, 0.60, 0.16), -w * 0.26, floorY + 0.45, zFront + 0.75,
    { color: C_SEAT });
  put(L.interior, box(w * 0.9, 0.06, t.length * 0.86), 0, floorY + 0.02, 0.2,
    { color: C_INTERIOR });
  for (let i = 0; i < 6; i++) {
    const z = zFront + 2.4 + i * 1.3;
    if (z > zRear - 0.8) break;
    putPair(L.interior, box(0.46, 0.52, 0.14), w * 0.28, floorY + 0.42, z, { color: C_SEAT });
  }
  S.frontSeatZ = zFront + 0.75;
  S.rearSeatZ = zFront + 3.0;
  return { lists: L, metrics: S };
}

/**
 * Builds a sports motorbike: frame, tank, seat, fairing, forks and handlebars.
 * @param {Object} t Vehicle type record.
 * @returns {Object} Part lists ready to merge.
 */
function buildBikeBody(t) {
  const L = newPartLists();
  const S = carMetrics(t, {
    belt: 0.55, hood: 0.30, boot: 0.20, wsRun: 0.10, bsRun: 0.10, inset: 0.05, doors: 0
  });
  const { ground, zFront, zRear } = S;
  const axleF = -t.wheelBase * 0.5;
  const axleR = t.wheelBase * 0.5;
  const frameY = ground + t.wheelRadius + 0.16;

  // Engine block and frame spars.
  put(L.trim, roundedBox(0.34, 0.34, 0.42, 0.07, 2), 0, frameY - 0.06, 0.05, { color: C_STEEL });
  putPair(L.trim, box(0.05, 0.20, 0.80), 0.16, frameY + 0.14, -0.05, { color: C_STEEL });
  // Fuel tank and fairing.
  put(L.paint, roundedBox(0.40, 0.26, 0.62, 0.11, 3), 0, frameY + 0.32, -0.12,
    { color: C_WHITE });
  put(L.paint, roundedBox(0.42, 0.44, 0.34, 0.13, 3), 0, frameY + 0.30, zFront + 0.30,
    { rx: -0.28, color: C_WHITE });
  putPair(L.paint, roundedBox(0.09, 0.36, 0.44, 0.07, 2), 0.20, frameY + 0.16, zFront + 0.42,
    { color: C_WHITE });
  // Seat and tail unit.
  put(L.interior, roundedBox(0.30, 0.11, 0.46, 0.05, 2), 0, frameY + 0.42, 0.34,
    { color: C_SEAT });
  put(L.paint, roundedBox(0.26, 0.20, 0.44, 0.08, 2), 0, frameY + 0.44, zRear - 0.22,
    { rx: -0.22, color: C_WHITE });
  // Swing arm and forks.
  putPair(L.trim, box(0.055, 0.10, 0.60), 0.14, ground + t.wheelRadius + 0.02, axleR - 0.28,
    { color: C_STEEL });
  putPair(L.chrome, cylinder(0.028, 0.028, 0.62, 8, true), 0.12,
    ground + t.wheelRadius + 0.30, axleF + 0.06, { rx: -0.42, color: C_CHROME });
  // Handlebars and mirrors.
  put(L.trim, box(0.58, 0.035, 0.035), 0, frameY + 0.58, zFront + 0.22, { color: C_DARK });
  putPair(L.chrome, box(0.03, 0.08, 0.12), 0.28, frameY + 0.66, zFront + 0.20,
    { color: C_CHROME });
  // Exhaust can.
  put(L.chrome, cylinder(0.06, 0.07, 0.44, 8, true), 0.13, ground + t.wheelRadius - 0.02,
    zRear - 0.30, { rx: Math.PI * 0.5, ry: 0.06, color: C_CHROME });
  // Lights.
  put(L.lampHead, roundedBox(0.20, 0.14, 0.10, 0.045, 2), 0, frameY + 0.44, zFront + 0.10,
    { color: C_WHITE });
  put(L.lampTail, box(0.14, 0.07, 0.07), 0, frameY + 0.44, zRear - 0.06, { color: C_WHITE });
  put(L.lampReverse, box(0.06, 0.04, 0.05), 0, frameY + 0.36, zRear - 0.06, { color: C_WHITE });
  putPair(L.lampSide, box(0.05, 0.05, 0.05), 0.24, frameY + 0.52, zFront + 0.16,
    { color: C_WHITE });
  put(L.trim, box(0.16, 0.11, 0.02), 0, frameY + 0.26, zRear - 0.02, { color: C_PLATE });
  // Rider foot pegs.
  putPair(L.chrome, box(0.10, 0.03, 0.03), 0.19, frameY - 0.14, 0.16, { color: C_CHROME });

  S.frontSeatZ = 0.30;
  S.rearSeatZ = 0.58;
  return { lists: L, metrics: S };
}

/**
 * Adds the police light bar, push bar and spotlight to an already built cruiser body.
 * @param {Object} L Part lists.
 * @param {Object} S Shape metrics.
 * @returns {void}
 */
function addPoliceKit(L, S) {
  const { w, hw, roofY, zFront, ground } = S;
  const barZ = S.cabinFrontZ + S.wsRun + 0.28;
  const barW = w * 0.74;
  const barH = 0.13;
  // Housing.
  put(L.trim, roundedBox(barW, barH * 0.55, 0.22, 0.04, 2), 0, roofY + 0.045, barZ,
    { color: C_DARK });
  putPair(L.trim, box(0.05, 0.05, 0.16), barW * 0.4, roofY + 0.015, barZ, { color: C_DARK });
  // Red half on the left, blue half on the right (Korean/US cruiser layout).
  put(L.sirenRed, roundedBox(barW * 0.46, barH, 0.17, 0.045, 2), -barW * 0.25, roofY + 0.10, barZ,
    { color: C_WHITE });
  put(L.sirenBlue, roundedBox(barW * 0.46, barH, 0.17, 0.045, 2), barW * 0.25, roofY + 0.10, barZ,
    { color: C_WHITE });
  // Grille strobes.
  put(L.sirenRed, box(0.16, 0.05, 0.04), -w * 0.20, S.beltY - 0.16, S.cabinFrontZ + 0.02,
    { color: C_WHITE });
  put(L.sirenBlue, box(0.16, 0.05, 0.04), w * 0.20, S.beltY - 0.16, S.cabinFrontZ + 0.02,
    { color: C_WHITE });
  // Push bar.
  put(L.trim, box(w * 0.92, 0.10, 0.08), 0, ground + S.height * 0.31, zFront - 0.06,
    { color: C_STEEL });
  putPair(L.trim, box(0.08, S.height * 0.26, 0.07), w * 0.32, ground + S.height * 0.30,
    zFront - 0.03, { color: C_STEEL });
  // A pillar spotlight.
  put(L.chrome, cylinder(0.055, 0.055, 0.13, 8, true), -(w * 0.5 - 0.03), S.beltY + 0.10,
    S.cabinFrontZ + 0.10, { rx: Math.PI * 0.5, color: C_CHROME });
}

/**
 * Adds the illuminated roof sign and door badge to a taxi body.
 * @param {Object} L Part lists.
 * @param {Object} S Shape metrics.
 * @returns {void}
 */
function addTaxiKit(L, S) {
  const signZ = S.cabinFrontZ + S.wsRun + 0.22;
  put(L.trim, box(0.34, 0.035, 0.16), 0, S.roofY + 0.02, signZ, { color: C_DARK });
  put(L.sign, roundedBox(0.52, 0.16, 0.20, 0.045, 2), 0, S.roofY + 0.11, signZ,
    { color: C_WHITE });
  // Chequer band along the doors.
  for (let i = 0; i < 6; i++) {
    putPair(L.trim, box(0.012, 0.07, 0.16), S.w * 0.5, S.beltY - 0.20,
      -0.7 + i * 0.28, { color: i % 2 ? C_DARK : C_PLATE });
  }
}

/**
 * Chooses the body builder for a type and returns its merged part lists.
 * @param {Object} t Vehicle type record.
 * @returns {Object} `{lists, metrics}`.
 */
function buildBodyFor(t) {
  switch (t.shape) {
    case 'wagon':
      return buildWagonBody(t, {
        belt: 0.52, hood: 0.20, boot: 0.05, wsRun: 0.11, bsRun: 0.03, inset: 0.03, doors: 4
      });
    case 'van':
      return buildVanBody(t);
    case 'truck':
      return buildTruckBody(t);
    case 'bus':
      return buildBusBody(t);
    case 'bike':
      return buildBikeBody(t);
    default: {
      const low = t.key === 'sports' || t.key === 'muscle';
      return buildCarBody(t, {
        belt: low ? 0.50 : 0.56,
        hood: low ? 0.30 : 0.24,
        boot: low ? 0.20 : 0.19,
        wsRun: low ? 0.16 : 0.13,
        bsRun: low ? 0.14 : 0.11,
        inset: low ? 0.06 : 0.045,
        noseDrop: low ? 0.10 : 0.05,
        doors: t.seats > 2 ? 4 : 2,
        spoiler: low,
        twinExhaust: low || t.key === 'police'
      });
    }
  }
}

/* ------------------------------------------------------------------ *
 * Asset construction
 * ------------------------------------------------------------------ */

/**
 * Builds every shared vehicle mesh and material exactly once.
 *
 * The returned object is passed to every {@link Vehicle} constructor. When `renderer` is null
 * (head-less validation) the geometries are still produced but nothing is uploaded to the GPU.
 *
 * @param {WebGL2RenderingContext|null} gl GL context, or null for a head-less build.
 * @param {Object|null} renderer Renderer used to upload meshes (`createMesh`).
 * @param {Object|null} textures Texture library from `render/textures.js`.
 * @returns {Object} VehicleAssets: `{types, models, materials, wheel, wheelLod, dispose()}`.
 */
export function buildVehicleAssets(gl, renderer, textures) {
  const tex = textures || null;
  const paintMap = tex && tex.carPaintNoise ? tex.carPaintNoise : null;
  const tyreMap = tex && tex.tire ? tex.tire : null;

  const materials = {
    paint: createMaterial({
      name: 'vehPaint',
      albedo: paintMap ? [1.95, 1.95, 1.95] : [1, 1, 1],
      roughness: 0.30, metallic: 0.55, reflectance: 0.65, vertexColors: true,
      map: paintMap, uvScale: [0.9, 0.9]
    }),
    trim: createMaterial({
      name: 'vehTrim', albedo: [1, 1, 1], roughness: 0.62, metallic: 0.12,
      reflectance: 0.4, vertexColors: true
    }),
    chrome: createMaterial({
      name: 'vehChrome', albedo: [1, 1, 1], roughness: 0.16, metallic: 0.95,
      reflectance: 0.9, vertexColors: true
    }),
    tyre: createMaterial({
      name: 'vehTyre', albedo: [1, 1, 1], roughness: 0.93, metallic: 0.02,
      reflectance: 0.25, vertexColors: true, map: tyreMap, uvScale: [2, 1]
    }),
    glass: createMaterial({
      name: 'vehGlass', albedo: [0.10, 0.12, 0.14], roughness: 0.055, metallic: 0.0,
      reflectance: 0.95, alpha: 0.42, blend: 'alpha', castShadow: false, depthWrite: false,
      vertexColors: true, sortBias: -0.4
    }),
    interior: createMaterial({
      name: 'vehInterior', albedo: [1, 1, 1], roughness: 0.86, metallic: 0.0,
      reflectance: 0.3, vertexColors: true, castShadow: false
    }),
    lampHead: createMaterial({
      name: 'vehLampHead', albedo: [0.55, 0.56, 0.58], roughness: 0.12, metallic: 0.0,
      reflectance: 0.85, emissive: [1.0, 0.94, 0.80], emissiveStrength: 7, vertexColors: true
    }),
    lampTail: createMaterial({
      name: 'vehLampTail', albedo: [0.20, 0.012, 0.010], roughness: 0.18, metallic: 0.0,
      reflectance: 0.8, emissive: [1.0, 0.055, 0.030], emissiveStrength: 6, vertexColors: true
    }),
    lampReverse: createMaterial({
      name: 'vehLampReverse', albedo: [0.5, 0.5, 0.48], roughness: 0.16, metallic: 0.0,
      reflectance: 0.8, emissive: [0.92, 0.94, 1.0], emissiveStrength: 5, vertexColors: true
    }),
    lampSide: createMaterial({
      name: 'vehLampSide', albedo: [0.35, 0.20, 0.02], roughness: 0.2, metallic: 0.0,
      reflectance: 0.8, emissive: [1.0, 0.44, 0.03], emissiveStrength: 5, vertexColors: true
    }),
    sirenRed: createMaterial({
      name: 'vehSirenRed', albedo: [0.22, 0.01, 0.01], roughness: 0.16, metallic: 0.0,
      reflectance: 0.85, emissive: [1.0, 0.035, 0.02], emissiveStrength: 10, vertexColors: true
    }),
    sirenBlue: createMaterial({
      name: 'vehSirenBlue', albedo: [0.01, 0.03, 0.24], roughness: 0.16, metallic: 0.0,
      reflectance: 0.85, emissive: [0.05, 0.16, 1.0], emissiveStrength: 10, vertexColors: true
    }),
    sign: createMaterial({
      name: 'vehSign', albedo: [0.45, 0.35, 0.12], roughness: 0.35, metallic: 0.0,
      reflectance: 0.6, emissive: [1.0, 0.62, 0.10], emissiveStrength: 4, vertexColors: true
    }),
    cone: createMaterial({
      name: 'vehLightCone', albedo: [1.0, 0.95, 0.82], roughness: 1, metallic: 0,
      blend: 'add', unlit: true, depthWrite: false, castShadow: false, doubleSided: true,
      vertexColors: true, sortBias: 1.5
    }),
    wreck: createMaterial({
      name: 'vehWreck', albedo: [1, 1, 1], roughness: 0.88, metallic: 0.30,
      reflectance: 0.3, vertexColors: true
    })
  };

  const wheelGeo = buildWheelGeometry(true);
  const wheelLodGeo = buildWheelGeometry(false);

  /** Groups that carry the paint tint (the rest bake their own vertex colours). */
  const GROUPS = [
    ['paint', 'paint', true],
    ['trim', 'trim', false],
    ['chrome', 'chrome', false],
    ['interior', 'interior', false],
    ['glass', 'glass', false],
    ['lampHead', 'lampHead', false],
    ['lampTail', 'lampTail', false],
    ['lampReverse', 'lampReverse', false],
    ['lampSide', 'lampSide', false],
    ['sirenRed', 'sirenRed', false],
    ['sirenBlue', 'sirenBlue', false],
    ['sign', 'sign', false]
  ];

  const models = {};
  let triangles = geometryTriangleCount(wheelGeo) + geometryTriangleCount(wheelLodGeo);

  for (const key of VEHICLE_TYPE_KEYS) {
    const t = VEHICLE_TYPES[key];
    const built = buildBodyFor(t);
    const L = built.lists;
    const S = built.metrics;
    if (t.police) addPoliceKit(L, S);
    if (t.taxi) addTaxiKit(L, S);

    const model = {
      type: t,
      parts: [],
      lod: null,
      lodMesh: null,
      wheelCount: t.bike ? 2 : 4,
      seatLocal: buildSeatLayout(t, S),
      doorLocal: buildDoorLayout(t, S),
      lampLocal: buildLampLayout(t, S),
      cone: null,
      coneMesh: null,
      coneLocal: null
    };

    const lodParts = [];
    for (const [listKey, matKey, tinted] of GROUPS) {
      const list = L[listKey];
      if (!list || list.length === 0) continue;
      const geometry = mergeGeometries(list);
      if (!geometry.indices || geometry.indices.length === 0) continue;
      triangles += geometryTriangleCount(geometry);
      const part = {
        id: listKey,
        geometry,
        material: materials[matKey],
        mesh: renderer && renderer.createMesh ? renderer.createMesh(geometry) : null,
        tinted,
        emissive: listKey.startsWith('lamp') || listKey.startsWith('siren') || listKey === 'sign'
      };
      model.parts.push(part);
      // The far LOD keeps only the solid body: paint, trim and the lamp lenses.
      if (listKey === 'paint' || listKey === 'trim' || listKey === 'chrome') {
        for (const entry of list) lodParts.push(entry);
      }
    }

    const lodGeo = mergeGeometries(lodParts);
    triangles += geometryTriangleCount(lodGeo);
    model.lod = lodGeo;
    model.lodMesh = renderer && renderer.createMesh ? renderer.createMesh(lodGeo) : null;

    // Head light cone: apex at the lamp, opening forward.
    const cone = buildLightCone(t.width * 0.42, Math.min(20, 9 + t.length), 12);
    model.cone = cone;
    model.coneMesh = renderer && renderer.createMesh ? renderer.createMesh(cone) : null;
    triangles += geometryTriangleCount(cone);

    models[key] = model;
  }

  const wheel = {
    geometry: wheelGeo,
    mesh: renderer && renderer.createMesh ? renderer.createMesh(wheelGeo) : null,
    material: materials.tyre
  };
  const wheelLod = {
    geometry: wheelLodGeo,
    mesh: renderer && renderer.createMesh ? renderer.createMesh(wheelLodGeo) : null,
    material: materials.tyre
  };

  return {
    gl: gl || null,
    renderer: renderer || null,
    textures: tex,
    types: VEHICLE_TYPES,
    models,
    materials,
    wheel,
    wheelLod,
    stats: { triangles, types: VEHICLE_TYPE_KEYS.length },
    /**
     * Releases every GPU mesh this asset set owns.
     * @returns {void}
     */
    dispose() {
      for (const key of Object.keys(models)) {
        const m = models[key];
        for (const p of m.parts) if (p.mesh && p.mesh.dispose) p.mesh.dispose();
        if (m.lodMesh && m.lodMesh.dispose) m.lodMesh.dispose();
        if (m.coneMesh && m.coneMesh.dispose) m.coneMesh.dispose();
        m.parts.length = 0;
      }
      if (wheel.mesh && wheel.mesh.dispose) wheel.mesh.dispose();
      if (wheelLod.mesh && wheelLod.mesh.dispose) wheelLod.mesh.dispose();
    }
  };
}

/**
 * Computes the local-space seat anchor points (hip height) for a type.
 * @param {Object} t Vehicle type record.
 * @param {Object} S Shape metrics.
 * @returns {Float32Array} Flat `[x,y,z]` triples, one per seat.
 */
function buildSeatLayout(t, S) {
  const n = Math.max(1, t.seats);
  const out = new Float32Array(n * 3);
  if (t.bike) {
    for (let i = 0; i < n; i++) {
      out[i * 3] = 0;
      out[i * 3 + 1] = S.ground + t.wheelRadius + 0.50;
      out[i * 3 + 2] = i === 0 ? S.frontSeatZ : S.rearSeatZ;
    }
    return out;
  }
  const sx = t.width * 0.24;
  const hip = S.ground + t.height * 0.42;
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / 2);
    const side = i % 2 === 0 ? -1 : 1;
    out[i * 3] = sx * side;
    out[i * 3 + 1] = hip;
    out[i * 3 + 2] = row === 0 ? S.frontSeatZ : S.rearSeatZ + (row - 1) * 1.15;
  }
  return out;
}

/**
 * Computes the local-space door anchor points (where a character stands to enter).
 * @param {Object} t Vehicle type record.
 * @param {Object} S Shape metrics.
 * @returns {Float32Array} Flat `[x,y,z]` triples, one per seat.
 */
function buildDoorLayout(t, S) {
  const seats = buildSeatLayout(t, S);
  const n = seats.length / 3;
  const out = new Float32Array(n * 3);
  const reach = t.width * 0.5 + 0.62;
  for (let i = 0; i < n; i++) {
    const side = seats[i * 3] < 0 ? -1 : 1;
    out[i * 3] = reach * (t.bike ? -1 : side);
    out[i * 3 + 1] = S.ground;
    out[i * 3 + 2] = seats[i * 3 + 2];
  }
  return out;
}

/**
 * Computes local anchors for the head lights, tail lights, siren bar and exhaust,
 * used for lights, particles and the visible light cones.
 * @param {Object} t Vehicle type record.
 * @param {Object} S Shape metrics.
 * @returns {Object} Named `[x,y,z]` anchor arrays.
 */
function buildLampLayout(t, S) {
  const hw = t.width * 0.5;
  const headY = t.shape === 'truck' || t.shape === 'bus'
    ? S.ground + t.height * 0.24
    : S.ground + t.height * 0.44;
  const tailY = S.ground + t.height * (t.shape === 'bus' ? 0.28 : 0.52);
  const hx = t.bike ? 0 : hw * 0.68;
  const sirenZ = S.cabinFrontZ !== undefined ? S.cabinFrontZ + S.wsRun + 0.28 : 0;
  return {
    headL: [-hx, headY, S.zFront + 0.02],
    headR: [hx, headY, S.zFront + 0.02],
    tailL: [-hw * 0.7, tailY, S.zRear - 0.02],
    tailR: [hw * 0.7, tailY, S.zRear - 0.02],
    sirenL: [-t.width * 0.185, S.roofY + 0.10, sirenZ],
    sirenR: [t.width * 0.185, S.roofY + 0.10, sirenZ],
    exhaust: [t.bike ? 0.13 : hw * 0.55, S.ground + 0.14, S.zRear - 0.05],
    bonnet: [0, S.ground + t.height * 0.62, S.zFront + t.length * 0.20],
    roof: [0, S.roofY + 0.06, 0]
  };
}

/* ------------------------------------------------------------------ *
 * Physics helpers
 * ------------------------------------------------------------------ */

/**
 * Normalised engine torque as a function of `rpm / redline`.
 * Rises quickly off idle, plateaus near 0.6 and falls away past the power peak.
 * @param {number} x Normalised engine speed.
 * @returns {number} Torque multiplier in 0.2..1.
 */
function torqueCurve(x) {
  const t = x < 0 ? 0 : x > 1.15 ? 1.15 : x;
  const v = 0.58 + 1.30 * t - 1.15 * t * t + 0.12 * t * t * t;
  return v < 0.2 ? 0.2 : v > 1 ? 1 : v;
}

/**
 * Slip-angle tyre curve: linear-ish rise to a peak at `peak`, then a progressive falloff
 * to a 0.72 asymptote so the car breaks away smoothly instead of snapping.
 * @param {number} slip Slip angle in radians (signed).
 * @param {number} peak Slip angle of peak grip.
 * @returns {number} Normalised force in -1..1 (signed like `slip`).
 */
function tyreCurve(slip, peak) {
  const a = Math.abs(slip) / peak;
  let f;
  if (a <= 1) f = a * (2 - a);
  else {
    const d = a - 1;
    f = 0.72 + 0.28 / (1 + d * d * 2.2);
  }
  return slip < 0 ? -f : f;
}

/**
 * Reads a finite number or falls back.
 * @param {*} v Candidate.
 * @param {number} d Fallback.
 * @returns {number} Finite value.
 */
function fin(v, d) {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/**
 * Closest point on an oriented box (or cylinder) body to a world point.
 * @param {Object} b Collision body record.
 * @param {number} x World X.
 * @param {number} y World Y.
 * @param {number} z World Z.
 * @param {Float32Array} out Receives the closest point.
 * @returns {number} Distance from the point to the body surface (0 when inside).
 */
function closestOnBody(b, x, y, z, out) {
  const dx = x - b.cx;
  const dy = y - b.cy;
  const dz = z - b.cz;
  if (b.kind === 'cylinder') {
    const r = Math.hypot(dx, dz);
    const cr = b.hx;
    const px = r > 1e-6 ? (dx / r) * Math.min(r, cr) : 0;
    const pz = r > 1e-6 ? (dz / r) * Math.min(r, cr) : 0;
    const py = clamp(dy, -b.hy, b.hy);
    out[0] = b.cx + px;
    out[1] = b.cy + py;
    out[2] = b.cz + pz;
    return Math.hypot(x - out[0], y - out[1], z - out[2]);
  }
  const c = b.cos;
  const s = b.sin;
  // World -> local (yaw only).
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  const qx = clamp(lx, -b.hx, b.hx);
  const qy = clamp(dy, -b.hy, b.hy);
  const qz = clamp(lz, -b.hz, b.hz);
  out[0] = b.cx + qx * c + qz * s;
  out[1] = b.cy + qy;
  out[2] = b.cz - qx * s + qz * c;
  return Math.hypot(x - out[0], y - out[1], z - out[2]);
}

/* ------------------------------------------------------------------ *
 * Module scratch (no per-frame allocation)
 * ------------------------------------------------------------------ */

const _m = mat4.create();
const _m2 = mat4.create();
const _v = vec3.create();
const _v2 = vec3.create();
const _v3 = vec3.create();
const _from = vec3.create();
const _to = vec3.create();
const _pt = vec3.create();
const _tint = new Float32Array(4);
const _tint2 = new Float32Array(4);
const _coneTint = new Float32Array(4);
const _bodies = [];
const _corner = new Float32Array(12);
/** Shared per-vehicle spawn counter, used only to seed deterministic colour picks. */
let _spawnSeq = 0;

/** Wheel index constants. */
const WHEEL_FL = 0;
const WHEEL_FR = 1;
const WHEEL_RL = 2;
const WHEEL_RR = 3;

/* ------------------------------------------------------------------ *
 * Vehicle
 * ------------------------------------------------------------------ */

/**
 * A drivable vehicle: rigid body, four raycast suspension wheels, engine and gearbox,
 * slip-angle tyres, collision response, damage and all of its presentation.
 */
export class Vehicle {
  /**
   * @param {Object} assets Result of {@link buildVehicleAssets}.
   * @param {string} typeKey Key into {@link VEHICLE_TYPES}.
   * @param {Object} [opts] Spawn options.
   * @param {ArrayLike<number>} [opts.position] World spawn position.
   * @param {number} [opts.yaw] Spawn heading in radians.
   * @param {number[]|string} [opts.color] Linear rgb paint colour, or a name from the palette.
   * @param {boolean} [opts.isPolice] Force the police light bar and siren behaviour.
   * @param {Object} [opts.game] The `Game` instance (audio, particles, camera shake).
   * @param {number} [opts.seed] Deterministic seed for the colour pick.
   */
  constructor(assets, typeKey, opts) {
    const o = opts || {};
    const key = VEHICLE_TYPES[typeKey] ? typeKey : 'sedan';
    /** @type {Object} Shared asset set. */
    this.assets = assets || null;
    /** @type {Object} Type record from {@link VEHICLE_TYPES}. */
    this.type = VEHICLE_TYPES[key];
    /** @type {string} Type key. */
    this.typeKey = key;
    /** @type {Object|null} Shared model (meshes, anchors). */
    this.model = assets && assets.models ? assets.models[key] : null;
    /** @type {Object|null} Owning game instance. */
    this.game = o.game || null;

    const t = this.type;
    const seed = fin(o.seed, ((_spawnSeq++) * 2654435761) >>> 0);
    /** @type {Rand} Deterministic per-vehicle randomness. */
    this.rng = new Rand(seed || 1);

    /** @type {Float32Array} World position of the centre of mass. */
    this.position = vec3.fromValues(0, t.comHeight, 0);
    if (o.position) {
      this.position[0] = fin(o.position[0], 0);
      this.position[1] = fin(o.position[1], t.comHeight);
      this.position[2] = fin(o.position[2], 0);
    }
    /** @type {Float32Array} World linear velocity in m/s. */
    this.velocity = vec3.create();
    /** @type {number} Heading in radians (0 faces -Z). */
    this.yaw = fin(o.yaw, 0);
    /** @type {number} Yaw rate in rad/s (positive turns left). */
    this.yawRate = 0;
    /** @type {number} Visual body pitch from suspension compression. */
    this.pitch = 0;
    /** @type {number} Visual body roll from suspension compression. */
    this.roll = 0;

    /** @type {number} Signed speed along the car's forward axis, m/s. */
    this.forwardSpeed = 0;
    /** @type {number} Lateral speed along the car's right axis, m/s. */
    this.lateralSpeed = 0;
    /** @type {number} Speed in km/h (always positive). See `forwardSpeed` for m/s. */
    this.speed = 0;
    /** @type {number} Unsigned speed in m/s. */
    this.speedMs = 0;
    /** @type {number} Engine speed in rpm. */
    this.rpm = t.idleRpm;
    /** @type {number} Current gear: -1 reverse, 0 neutral, 1..5 forward. */
    this.gear = 1;
    /** @type {number} Normalised steering, -1 (full left) .. 1 (full right). */
    this.steer = 0;
    /** @type {number} Road-wheel steering angle in radians (positive steers right). */
    this.steerAngle = 0;
    /** @type {number} Engine load 0..1, drives audio and exhaust. */
    this.engineLoad = 0;
    /** @type {boolean} Whether the rear axle has broken traction. */
    this.drifting = false;
    /** @type {number} Drift intensity 0..1. */
    this.driftAmount = 0;
    /** @type {boolean} True while every wheel is off the ground. */
    this.airborne = false;

    /** @type {number} Structural health, 0..1000. */
    this.health = MAX_HEALTH;
    /** @type {number} Full health for HUD normalisation. */
    this.maxHealth = MAX_HEALTH;
    /** @type {boolean} True once the wreck has exploded. */
    this.isDestroyed = false;
    /** @type {boolean} Whether the renderer should draw this vehicle. */
    this.visible = true;
    /** @type {boolean} Engine running. */
    this.engineOn = true;
    /** @type {boolean} Set by traffic/parking code. */
    this.parked = false;
    /** @type {boolean} True while the human player is driving. */
    this.isPlayer = false;
    /** @type {Object|null} Driving entity (player or AI). */
    this.driver = null;
    /** @type {Array<Object|null>} One slot per seat. */
    this.occupants = new Array(t.seats).fill(null);
    /** @type {number} Update-rate divider set by `game.js`. */
    this.lodSkip = 0;

    /** @type {Object} Driver input. */
    this.input = { throttle: 0, brake: 0, steer: 0, handbrake: false, horn: false };
    /** @type {Object} Lamp state; see {@link Vehicle#setLights}. */
    this.lights = { head: false, brake: false, reverse: false, siren: false, indicator: 0 };
    /** @type {boolean} Whether the siren wails (police only). */
    this.sirenOn = false;

    // --- paint -------------------------------------------------------------------------------
    let color = o.color;
    if (typeof color === 'string') color = PAINT[color] || null;
    if (!color || color.length < 3) {
      color = t.colorOptions[this.rng.int(0, t.colorOptions.length - 1)];
    }
    /** @type {Float32Array} Linear rgb body colour. */
    this.color = new Float32Array([color[0], color[1], color[2]]);
    /** @type {boolean} Whether the police kit is active. */
    this.isPolice = !!o.isPolice || t.police;

    // --- wheels -------------------------------------------------------------------------------
    const hx = t.track * 0.5;
    const hz = t.wheelBase * 0.5;
    /** @type {Array<Object>} Four suspension wheels, front pair first. */
    this.wheels = [
      makeWheel(-hx, -hz, true, t),
      makeWheel(hx, -hz, true, t),
      makeWheel(-hx, hz, false, t),
      makeWheel(hx, hz, false, t)
    ];

    // --- derived / internal -------------------------------------------------------------------
    this._a = t.wheelBase * (1 - t.weightFront);   // CG -> front axle
    this._b = t.wheelBase * t.weightFront;         // CG -> rear axle
    this._accelLong = 0;
    this._accelLat = 0;
    this._shiftTimer = 0;
    this._settled = false;
    this._fuse = -1;
    this._burning = false;
    this._smoking = false;
    this._viewDist = 0;
    this._sfxAccum = 0;
    this._smokeAccum = 0;
    this._exhaustAccum = 0;
    this._skidAccum = 0;
    this._sirenPhase = this.rng.next() * 4;
    this._engineVoice = null;
    this._screech = null;
    this._screechLevel = 0;
    this._sirenHandle = null;
    this._impactCooldown = 0;
    this._lastCrashSpeed = 0;
    this._safeX = this.position[0];
    this._safeY = this.position[1];
    this._safeZ = this.position[2];
    this._safeYaw = this.yaw;
    this._groundY = new Float32Array(4);
    this._groundValid = false;
    this._prevX = this.position[0];
    this._prevY = this.position[1];
    this._prevZ = this.position[2];
    this._contacts = 0;
    this._age = 0;
    this._distanceDriven = 0;

    for (let i = 0; i < 4; i++) this._groundY[i] = this.position[1] - t.comHeight;
  }

  /** @returns {number} Body damage as a 0..1 fraction. */
  get damage() {
    return 1 - clamp(this.health / this.maxHealth, 0, 1);
  }

  /** @returns {boolean} True when the wreck is burning. */
  get burning() {
    return this._burning;
  }

  /**
   * World-space forward vector (unit, ground plane).
   * @param {ArrayLike<number>} out Receives the vector.
   * @returns {ArrayLike<number>} out
   */
  getForward(out) {
    out[0] = -Math.sin(this.yaw);
    out[1] = 0;
    out[2] = -Math.cos(this.yaw);
    return out;
  }

  /**
   * World-space right vector (unit, ground plane).
   * @param {ArrayLike<number>} out Receives the vector.
   * @returns {ArrayLike<number>} out
   */
  getRight(out) {
    out[0] = Math.cos(this.yaw);
    out[1] = 0;
    out[2] = -Math.sin(this.yaw);
    return out;
  }

  /**
   * Places the vehicle at a new position and clears its motion.
   * @param {number} x World X.
   * @param {number} y World Y of the centre of mass.
   * @param {number} z World Z.
   * @param {number} [yaw=0] Heading.
   * @returns {void}
   */
  reset(x, y, z, yaw = 0) {
    vec3.set(this.position, x, y, z);
    vec3.set(this.velocity, 0, 0, 0);
    this.yaw = yaw;
    this.yawRate = 0;
    this.pitch = 0;
    this.roll = 0;
    this.forwardSpeed = 0;
    this.speed = 0;
    this.speedMs = 0;
    this.gear = 1;
    this.rpm = this.type.idleRpm;
    this._settled = false;
    this._groundValid = false;
  }

  /**
   * Advances the simulation. Called once per frame by `game.js` with the frame delta
   * already scaled for this vehicle's LOD step.
   * @param {number} dt Seconds since the previous update for this vehicle.
   * @param {Object} collision CollisionWorld instance.
   * @param {Object} [ctx] The `Game` instance.
   * @returns {void}
   */
  update(dt, collision, ctx) {
    if (ctx) this.game = ctx;
    let d = fin(dt, 0);
    if (!(d > 0)) return;
    if (d > MAX_FRAME_DT) d = MAX_FRAME_DT;
    this._age += d;
    this._impactCooldown = Math.max(0, this._impactCooldown - d);

    const game = this.game;
    if (game && game.camera && game.camera.position) {
      const cp = game.camera.position;
      this._viewDist = Math.hypot(this.position[0] - cp[0], this.position[1] - cp[1],
        this.position[2] - cp[2]);
    }

    this._prevX = this.position[0];
    this._prevY = this.position[1];
    this._prevZ = this.position[2];

    this._sampleGround(collision, true);
    if (!this._settled) {
      // First frame: drop the body straight onto the suspension rest height.
      let best = -Infinity;
      for (let i = 0; i < 4; i++) if (this._groundY[i] > best) best = this._groundY[i];
      if (Number.isFinite(best)) this.position[1] = best + this.type.comHeight;
      this._settled = true;
    }

    this._readInput();

    const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(d / FIXED_STEP)));
    const h = d / steps;
    const resampleEvery = Math.max(1, Math.ceil(steps / 4));
    for (let s = 0; s < steps; s++) {
      if (s > 0 && (s % resampleEvery) === 0) this._sampleGround(collision, false);
      this._step(h);
    }

    this._collideWorld(collision);
    this._postStep(d);
  }

  /**
   * Samples the ground height under each wheel. Cheap: one hashed column query per wheel.
   * @param {Object} collision CollisionWorld.
   * @param {boolean} force Sample even when the vehicle is asleep.
   * @returns {void}
   */
  _sampleGround(collision, force) {
    const t = this.type;
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    const py = this.position[1];
    const ceiling = py + t.wheelRadius + 0.35;
    if (!collision || typeof collision.groundHeight !== 'function') {
      for (let i = 0; i < 4; i++) this._groundY[i] = 0;
      this._groundValid = true;
      return;
    }
    if (!force && !this._groundValid) return;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      // Local (x, z) rotated into world: right = (c, -s), forward = (-s, -c).
      const wx = this.position[0] + w.localX * c - w.localZ * s;
      const wz = this.position[2] - w.localX * s - w.localZ * c;
      let g = collision.groundHeight(wx, wz, ceiling);
      if (!Number.isFinite(g)) g = py - t.comHeight;
      // Never let a stale sample teleport the car; limit the per-sample step.
      this._groundY[i] = g;
      w.worldX = wx;
      w.worldZ = wz;
    }
    this._groundValid = true;
  }

  /**
   * Converts raw driver input into steering angle, throttle, brake and gear selection.
   * @returns {void}
   */
  _readInput() {
    const t = this.type;
    const inp = this.input;
    this._inThrottle = clamp(fin(inp.throttle, 0), -1, 1);
    this._inBrake = clamp(fin(inp.brake, 0), 0, 1);
    this._inSteer = clamp(fin(inp.steer, 0), -1, 1);
    this._inHandbrake = !!inp.handbrake;
    if (this.isDestroyed || !this.engineOn) {
      this._inThrottle = 0;
      this._inBrake = Math.max(this._inBrake, this.isDestroyed ? 0.15 : 0);
    }
    // Gear selection mirrors what game.js feeds us: S brakes while rolling forward and
    // engages reverse once the car is nearly stopped.
    const fs = this.forwardSpeed;
    if (this.gear === -1) {
      if (this._inThrottle > 0.1) {
        if (fs < -0.7) this._inBrake = Math.max(this._inBrake, 1);
        else this.gear = 1;
      }
    } else if (this._inThrottle < -0.1) {
      if (fs > 0.8) this._inBrake = Math.max(this._inBrake, 1);
      else this.gear = -1;
    }
    this._drive = this.gear === -1
      ? (this._inThrottle < 0 ? -this._inThrottle : 0)
      : (this._inThrottle > 0 ? this._inThrottle : 0);
  }

  /**
   * One fixed physics sub-step: suspension, load transfer, engine, gearbox, tyres, integration.
   * @param {number} h Sub-step length in seconds (always 1/120 or smaller).
   * @returns {void}
   */
  _step(h) {
    const t = this.type;
    const mass = t.mass;
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    const fx = -s;
    const fz = -c;
    const rx = c;
    const rz = -s;

    // --- body frame velocity ------------------------------------------------------------------
    let u = this.velocity[0] * fx + this.velocity[2] * fz;
    let vlat = this.velocity[0] * rx + this.velocity[2] * rz;
    const speedAbs = Math.hypot(this.velocity[0], this.velocity[2]);

    // --- steering: speed sensitive, rate limited, self centering --------------------------------
    const speedFrac = clamp(speedAbs / t.maxSpeed, 0, 1);
    const authority = 1 - speedFrac * 0.68;
    let target = this._inSteer * authority;
    const rate = t.steerSpeed * (Math.abs(this._inSteer) < 0.06 ? 1.9 : 1.0);
    this.steer = moveTowards(this.steer, target, rate * h);
    this.steerAngle = this.steer * t.steerMax;
    const sigma = this.steerAngle;
    const cosS = Math.cos(sigma);
    const sinS = Math.sin(sigma);

    // --- suspension ------------------------------------------------------------------------------
    let sumN = 0;
    let contacts = 0;
    const rayMax = t.restLength + t.travel * 0.9;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const gy = this._groundY[i];
      w.groundY = gy;
      const d = this.position[1] - gy;              // attach point height above ground
      const len = d - w.radius;                      // suspension extension
      w.prevSusLen = w.susLen;
      if (len > rayMax) {
        w.susLen = rayMax;
        w.compression = 0;
        w.contact = false;
        w.load = 0;
        continue;
      }
      const minLen = t.restLength - t.travel;
      w.susLen = len < minLen ? minLen : len;
      w.contact = true;
      contacts++;
      const compress = t.restLength - w.susLen;
      const susVel = (w.prevSusLen - w.susLen) / h;
      const spring = t.springRate * compress;
      const damper = t.damperRate * clamp(susVel, -12, 12);
      let n = spring + damper;
      if (n < 0) n = 0;
      // Hard bump stop when the suspension bottoms out.
      if (len < minLen) n += (minLen - len) * t.springRate * 12;
      w.compression = clamp(compress / t.travel, 0, 1.4);
      sumN += n;
      w.springN = n;
    }
    this.airborne = contacts === 0;
    this._contacts = contacts;

    // --- vertical integration ---------------------------------------------------------------------
    let vy = this.velocity[1] + (sumN / mass - GRAVITY) * h;
    if (vy < -70) vy = -70;
    if (vy > 70) vy = 70;
    this.velocity[1] = vy;

    // --- load distribution with weight transfer -----------------------------------------------------
    const downforce = 0.5 * AIR_DENSITY * t.clA * speedAbs * speedAbs;
    const weight = mass * GRAVITY + downforce;
    const dLong = mass * this._accelLong * t.comHeight / t.wheelBase;
    const dLat = mass * this._accelLat * t.comHeight / t.track;
    let frontTotal = weight * t.weightFront - dLong;
    let rearTotal = weight * (1 - t.weightFront) + dLong;
    if (frontTotal < 0) frontTotal = 0;
    if (rearTotal < 0) rearTotal = 0;
    const wFL = this.wheels[WHEEL_FL];
    const wFR = this.wheels[WHEEL_FR];
    const wRL = this.wheels[WHEEL_RL];
    const wRR = this.wheels[WHEEL_RR];
    wFL.load = Math.max(0, frontTotal * 0.5 + dLat * 0.25) * (wFL.contact ? 1 : 0);
    wFR.load = Math.max(0, frontTotal * 0.5 - dLat * 0.25) * (wFR.contact ? 1 : 0);
    wRL.load = Math.max(0, rearTotal * 0.5 + dLat * 0.25) * (wRL.contact ? 1 : 0);
    wRR.load = Math.max(0, rearTotal * 0.5 - dLat * 0.25) * (wRR.contact ? 1 : 0);
    const loadF = wFL.load + wFR.load;
    const loadR = wRL.load + wRR.load;

    // --- gearbox and engine ---------------------------------------------------------------------------
    this._shiftTimer = Math.max(0, this._shiftTimer - h);
    const ratio = this.gear === -1 ? -t.reverseRatio
      : this.gear > 0 ? t.gearRatios[this.gear - 1] : 0;
    const absRatio = Math.abs(ratio);
    const wheelOmega = Math.abs(u) / t.wheelRadius;
    let rpmTarget = t.idleRpm;
    if (absRatio > 0) rpmTarget = wheelOmega * absRatio * t.finalDrive * 9.5492965855;
    if (rpmTarget < t.idleRpm) rpmTarget = t.idleRpm + this._drive * 900;
    const redline = t.redline;
    this.rpm += (Math.min(rpmTarget, redline * 1.03) - this.rpm) * Math.min(1, 16 * h);
    if (!(this.rpm > 0)) this.rpm = t.idleRpm;

    if (this._shiftTimer <= 0 && this.gear > 0) {
      if (this.rpm > redline * 0.93 && this.gear < t.gearRatios.length && this._drive > 0.05) {
        this.gear++;
        this._shiftTimer = SHIFT_TIME;
      } else if (this.rpm < redline * 0.42 && this.gear > 1) {
        this.gear--;
        this._shiftTimer = SHIFT_TIME;
      }
    }

    let driveForce = 0;
    if (absRatio > 0 && this.engineOn && !this.isDestroyed) {
      const torque = t.peakTorque * torqueCurve(this.rpm / redline) * this._drive;
      driveForce = torque * absRatio * t.finalDrive * DRIVETRAIN_EFF / t.wheelRadius;
      if (this.gear === -1) driveForce = -driveForce;
      if (this._shiftTimer > 0) driveForce *= 0.07;
    }
    // Governor: never push past the type maximum (and only a third of it in reverse).
    const revLimit = t.maxSpeed * 0.34;
    if (u > t.maxSpeed && driveForce > 0) driveForce = 0;
    if (u < -revLimit && driveForce < 0) driveForce = 0;
    // Engine braking when coasting in gear.
    let engineBrake = 0;
    if (absRatio > 0 && this._drive < 0.03 && this.engineOn) {
      engineBrake = -Math.sign(u) * t.peakTorque * 0.13 * absRatio * t.finalDrive / t.wheelRadius;
      if (Math.abs(u) < 0.4) engineBrake = 0;
    }
    this.engineLoad = clamp(this._drive * 0.75 + Math.abs(driveForce) / (mass * 22), 0, 1);

    // --- brakes --------------------------------------------------------------------------------------
    const uSign = u > 0.02 ? 1 : u < -0.02 ? -1 : 0;
    const handbrake = this._inHandbrake && !this.isDestroyed;
    let brakeF = -uSign * t.brakeForce * 0.60 * this._inBrake;
    let brakeR = -uSign * t.brakeForce * 0.40 * this._inBrake;
    if (handbrake) brakeR += -uSign * t.brakeForce * 0.55;

    // --- drive split ------------------------------------------------------------------------------------
    let driveF = 0;
    let driveR = 0;
    if (t.drive === 'fwd') driveF = driveForce;
    else if (t.drive === 'rwd') driveR = driveForce;
    else { driveF = driveForce * 0.42; driveR = driveForce * 0.58; }
    driveF += engineBrake * 0.5;
    driveR += engineBrake * 0.5;

    // --- tyre forces ---------------------------------------------------------------------------------------
    const muBase = t.grip;
    const muF = muBase;
    let muR = muBase;
    if (handbrake) muR *= 0.44;
    const gripF = muF * loadF;
    const gripR = muR * loadR;

    // Longitudinal first: the drive axle can overwhelm its grip and light up the tyres.
    let flongF = clamp(driveF + brakeF, -gripF, gripF);
    let flongR = clamp(driveR + brakeR, -gripR, gripR);
    const slipDriveF = gripF > 1 ? clamp((Math.abs(driveF + brakeF) - gripF) / gripF, 0, 1) : 0;
    const slipDriveR = gripR > 1 ? clamp((Math.abs(driveR + brakeR) - gripR) / gripR, 0, 1) : 0;

    // Remaining lateral budget (friction circle).
    const latMaxF = Math.sqrt(Math.max(0, gripF * gripF - flongF * flongF));
    const latMaxR = Math.sqrt(Math.max(0, gripR * gripR - flongR * flongR));

    const den = Math.abs(u) < 1.6 ? 1.6 : Math.abs(u);
    const vLatF = vlat - this.yawRate * this._a;
    const vLatR = vlat + this.yawRate * this._b;
    // Front wheel frame (rotate the body-frame velocity by -sigma).
    const wLongF = u * cosS + vLatF * sinS;
    const wLatF = -u * sinS + vLatF * cosS;
    const denF = Math.abs(wLongF) < 1.6 ? 1.6 : Math.abs(wLongF);
    const alphaF = -Math.atan2(wLatF, denF);
    const alphaR = -Math.atan2(vLatR, den);
    this._alphaF = alphaF;
    this._alphaR = alphaR;

    let fyF = muF * loadF * tyreCurve(alphaF, PEAK_SLIP);
    let fyR = muR * loadR * tyreCurve(alphaR, PEAK_SLIP * (1 + t.driftFactor * 0.12));
    if (fyF > latMaxF) fyF = latMaxF; else if (fyF < -latMaxF) fyF = -latMaxF;
    if (fyR > latMaxR) fyR = latMaxR; else if (fyR < -latMaxR) fyR = -latMaxR;

    // Back to body axes.
    const bodyLongF = flongF * cosS - fyF * sinS;
    const bodyLatF = flongF * sinS + fyF * cosS;
    const bodyLongR = flongR;
    const bodyLatR = fyR;

    // --- resistance ------------------------------------------------------------------------------------------
    const drag = 0.5 * AIR_DENSITY * t.cdA * u * Math.abs(u);
    const roll = CRR * (loadF + loadR) * uSign;
    const totalLong = bodyLongF + bodyLongR - drag - roll;
    const totalLat = bodyLatF + bodyLatR;

    // --- yaw ---------------------------------------------------------------------------------------------------
    let mz = -this._a * bodyLatF + this._b * bodyLatR;
    mz -= this.yawRate * t.yawInertia * YAW_DAMP;
    let yawAcc = mz / t.yawInertia;
    // Clamp so no single sub-step can spin the car.
    const maxYawAcc = 26;
    if (yawAcc > maxYawAcc) yawAcc = maxYawAcc;
    else if (yawAcc < -maxYawAcc) yawAcc = -maxYawAcc;
    let yawRate = this.yawRate + yawAcc * h;

    // Low-speed kinematic blend keeps parking manoeuvres crisp and kills the
    // ill-conditioned region of the bicycle model near standstill.
    const kin = -u * Math.tan(sigma) / Math.max(0.4, t.wheelBase);
    const kBlend = clamp(1 - Math.abs(u) / 4.0, 0, 1) * 0.9;
    if (kBlend > 0 && contacts > 0) yawRate = lerp(yawRate, kin, kBlend);
    if (contacts === 0) yawRate *= Math.max(0, 1 - 1.2 * h);
    if (yawRate > MAX_YAW_RATE) yawRate = MAX_YAW_RATE;
    else if (yawRate < -MAX_YAW_RATE) yawRate = -MAX_YAW_RATE;
    this.yawRate = yawRate;
    this.yaw = wrapAngle(this.yaw + yawRate * h);

    // --- linear integration ---------------------------------------------------------------------------------------
    const aLong = contacts > 0 ? totalLong / mass : (-drag / mass);
    const aLat = contacts > 0 ? totalLat / mass : 0;
    this._accelLong = damp(this._accelLong, aLong, 22, h);
    this._accelLat = damp(this._accelLat, aLat, 22, h);
    u += aLong * h;
    vlat += aLat * h;

    // Complete stop under braking / at idle: kill the residual creep so the car really parks.
    if (Math.abs(u) < 0.55 && this._drive < 0.03 && (this._inBrake > 0.15 || handbrake)) {
      u = 0;
      vlat *= 0.3;
      this.yawRate *= 0.4;
    } else if (Math.abs(u) < 0.06 && this._drive < 0.02) {
      u = 0;
    }

    // Rebuild the world velocity from the body frame.
    this.velocity[0] = u * fx + vlat * rx;
    this.velocity[2] = u * fz + vlat * rz;

    // Hard speed clamp: nothing may exceed the type maximum by more than 3%.
    const cap = t.maxSpeed * OVERSPEED_ALLOW;
    const planar = Math.hypot(this.velocity[0], this.velocity[2]);
    if (planar > cap) {
      const k = cap / planar;
      this.velocity[0] *= k;
      this.velocity[2] *= k;
      u *= k;
      vlat *= k;
    }

    this.position[0] += this.velocity[0] * h;
    this.position[1] += this.velocity[1] * h;
    this.position[2] += this.velocity[2] * h;

    // --- ground floor: the body can never sink through the road ---------------------------------------------------
    let floor = -Infinity;
    for (let i = 0; i < 4; i++) if (this._groundY[i] > floor) floor = this._groundY[i];
    if (Number.isFinite(floor)) {
      const minY = floor + t.wheelRadius + (t.restLength - t.travel) * 0.55;
      if (this.position[1] < minY) {
        this.position[1] = minY;
        if (this.velocity[1] < 0) this.velocity[1] = 0;
      }
    }

    this.forwardSpeed = u;
    this.lateralSpeed = vlat;

    // --- drift bookkeeping -----------------------------------------------------------------------------------------
    const rearSlip = Math.abs(alphaR) / PEAK_SLIP;
    const slipping = Math.max(rearSlip - 1, 0) + slipDriveR * 1.4 + slipDriveF * 0.5;
    this.driftAmount = clamp(slipping * 0.55, 0, 1);
    this.drifting = Math.abs(u) > 4.5 && (rearSlip > 1.35 || slipDriveR > 0.25 || handbrake);
    wRL.slip = alphaR;
    wRR.slip = alphaR;
    wFL.slip = alphaF;
    wFR.slip = alphaF;
    const skidR = clamp(Math.max(rearSlip - 0.95, slipDriveR * 1.6), 0, 1.6);
    const skidF = clamp(Math.max(Math.abs(alphaF) / PEAK_SLIP - 0.95, slipDriveF * 1.6), 0, 1.6);
    wRL.skid = skidR;
    wRR.skid = skidR;
    wFL.skid = skidF;
    wFR.skid = skidF;
    wRL.locked = handbrake || (this._inBrake > 0.85 && skidR > 0.4);
    wRR.locked = wRL.locked;

    // --- wheel spin ---------------------------------------------------------------------------------------------------
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      let omega = u / t.wheelRadius;
      const driven = (t.drive === 'awd') || (t.drive === 'fwd' ? w.front : !w.front);
      if (driven && this._drive > 0.05) {
        const spinBoost = w.front ? slipDriveF : slipDriveR;
        omega *= 1 + spinBoost * 2.5;
        if (Math.abs(u) < 0.5 && spinBoost > 0.05) omega += Math.sign(driveForce) * spinBoost * 45;
      }
      if (w.locked && !w.front) omega = 0;
      w.spinRate = omega;
      w.spin += omega * h;
      if (w.spin > 1e6 || w.spin < -1e6) w.spin = 0;
      w.steerAngle = w.front ? sigma : 0;
    }

    // --- NaN guard -------------------------------------------------------------------------------------------------------
    if (!Number.isFinite(this.position[0]) || !Number.isFinite(this.position[1]) ||
      !Number.isFinite(this.position[2]) || !Number.isFinite(this.yaw) ||
      !Number.isFinite(this.velocity[0]) || !Number.isFinite(this.velocity[1]) ||
      !Number.isFinite(this.velocity[2]) || !Number.isFinite(this.yawRate)) {
      this.position[0] = this._safeX;
      this.position[1] = this._safeY;
      this.position[2] = this._safeZ;
      this.yaw = this._safeYaw;
      vec3.set(this.velocity, 0, 0, 0);
      this.yawRate = 0;
      this.forwardSpeed = 0;
      this.lateralSpeed = 0;
      this._accelLong = 0;
      this._accelLat = 0;
      this.rpm = t.idleRpm;
    } else {
      this._safeX = this.position[0];
      this._safeY = this.position[1];
      this._safeZ = this.position[2];
      this._safeYaw = this.yaw;
    }
  }
