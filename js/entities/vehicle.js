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
