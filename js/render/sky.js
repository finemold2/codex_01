/**
 * @file js/render/sky.js
 * NEON CITY atmospheric sky.
 *
 * A single full-screen pass that evaluates a physically motivated single-scattering
 * atmosphere (Rayleigh + Mie, Henyey-Greenstein phase, analytic Chapman optical depth for
 * the sun path) and layers the celestial cast on top: sun disc with limb darkening, moon
 * with a procedurally shaded phase, a hash based star field with twinkle, the Milky Way as
 * a soft noise band and two drifting fBm cloud decks with sun-dependent silver lining.
 *
 * The same scattering integral runs on the CPU at a lower step count so `fogColor`,
 * `ambientSky` and `ambientGround` are guaranteed to match what the shader paints. That is
 * what makes distant geometry dissolve into the horizon instead of ending on a hard line.
 *
 * Conventions other modules must honour:
 *  - `sunDirection` points FROM the world TOWARD the key light. During the day it is the sun;
 *    once the sun is below the horizon it blends into `moonDirection` so night shading never
 *    comes from below the ground. `sunDirectionTrue` is always the real solar direction.
 *  - Every colour is linear HDR radiance in the same scale as the renderer's lighting, sized
 *    for an ACES tonemap at exposure ~1.0 (a sunlit white surface lands near 2.5).
 *  - `render()` draws into whatever framebuffer is bound, never touches the viewport, uses
 *    depth test LEQUAL with depth writes OFF and restores depth mask / face culling after.
 */

import { clamp, smoothstep, lerp, DEG2RAD, PI, mat4 } from '../core/math.js';
import { Shader, drawFullscreen } from '../core/gl.js';

/* -------------------------------------------------------------------------- */
/* Atmosphere constants (kilometres, so fp32 keeps plenty of precision)        */
/* -------------------------------------------------------------------------- */

/** Planet radius in km. */
const RG = 6360.0;
/** Atmosphere outer radius in km. */
const RA = 6420.0;
/** Rayleigh scale height in km. */
const HR = 8.0;
/** Mie scale height in km. */
const HM = 1.2;
/** Rayleigh scattering coefficients per km at sea level (680/550/440 nm). */
const BETA_R = [5.8e-3, 13.5e-3, 33.1e-3];
/** Base Mie scattering coefficient per km at sea level (turbidity 1). */
const BETA_M_BASE = 4.0e-3;
/** Desaturated Rayleigh coefficients used by the isotropic multiple-scattering term. */
const BETA_MS = [0.0072, 0.0152, 0.0310];
/** Softening applied to the sun-path optical depth inside the multiple-scattering term. */
const MS_SOFT = 0.40;
/** Mie extinction is a little larger than scattering (single scattering albedo ~0.9). */
const MIE_ALBEDO = 0.9;
/** Sample distribution steepness for the view-ray integral (higher = more samples near the eye). */
const STEP_K = 6.0;
/** CPU integration step count (the GPU uses 4..10 depending on quality). */
const CPU_STEPS = 7;

/** Observer latitude used by the solar position model, radians. */
const LATITUDE = 36.0 * DEG2RAD;
/** Solar declination (a fixed late-spring season), radians. */
const DECLINATION = 12.0 * DEG2RAD;
/** Moon declination, mirrored and flattened relative to the sun. */
const MOON_DECLINATION = -7.0 * DEG2RAD;

/** Cool tint of moonlight. */
const MOON_TINT = [0.56, 0.66, 0.92];
/** Warm sodium-vapour tint of a big city's light pollution. */
const POLLUTION_TINT = [0.034, 0.020, 0.008];
/** Airglow / integrated starlight floor so a moonless night is never pure black. */
const NIGHT_SKY_TINT = [0.0060, 0.0082, 0.0165];

/* -------------------------------------------------------------------------- */
/* Module scratch (no per-frame allocation)                                    */
/* -------------------------------------------------------------------------- */

const _rgb = new Float32Array(3);
const _rgb2 = new Float32Array(3);
const _trans = new Float32Array(3);
const _dir = new Float32Array(3);
const _invProj = new Float32Array(16);
const _invView = new Float32Array(16);

/* -------------------------------------------------------------------------- */
/* Shared analytic helpers (CPU mirror of the GLSL below)                      */
/* -------------------------------------------------------------------------- */

/**
 * Chapman function approximation: relative column density of an exponential atmosphere,
 * looking from radius `x` (in scale heights) along a ray whose cosine to the local zenith
 * is `cosZ`. Multiply by `H * exp(-altitude / H) * beta` to get an optical depth.
 * @param {number} x Radius of the sample point divided by the scale height.
 * @param {number} cosZ Cosine of the zenith angle of the ray.
 * @returns {number} Column density in scale-height units (>= 0).
 */
function chapman(x, cosZ) {
  const c = Math.sqrt(1.5707963267948966 * x);
  if (cosZ >= 0.0) return c / (c * cosZ + 1.0);
  const sinZ = Math.sqrt(Math.max(0.0, 1.0 - cosZ * cosZ));
  const x0 = x * sinZ;
  const e = Math.min(x - x0, 60.0);
  return Math.max(0.0, 2.0 * Math.sqrt(1.5707963267948966 * x0) * Math.exp(e) - c / (1.0 - c * cosZ));
}

/**
 * Rayleigh phase function.
 * @param {number} mu Cosine of the scattering angle.
 * @returns {number} Phase value.
 */
function phaseRayleigh(mu) {
  return 0.0596831 * (1.0 + mu * mu);
}

/**
 * Henyey-Greenstein phase function used for the Mie (aerosol) term.
 * @param {number} mu Cosine of the scattering angle.
 * @param {number} g Asymmetry parameter in (-1, 1).
 * @returns {number} Phase value.
 */
function phaseHG(mu, g) {
  const g2 = g * g;
  const d = Math.max(1.0 + g2 - 2.0 * g * mu, 1e-4);
  return (1.0 - g2) / (12.566370614359172 * d * Math.sqrt(d));
}

/**
 * Solves `|ro + rd * t| = radius`. Returns the near root in `out[0]` and the far root in
 * `out[1]`; when the ray misses, `out[0] > out[1]`.
 * @param {number} rx Ray origin x.
 * @param {number} ry Ray origin y.
 * @param {number} rz Ray origin z.
 * @param {number} dx Ray direction x (unit).
 * @param {number} dy Ray direction y (unit).
 * @param {number} dz Ray direction z (unit).
 * @param {number} radius Sphere radius.
 * @param {Float32Array|number[]} out Two-element output.
 * @returns {Float32Array|number[]} `out`.
 */
function raySphere(rx, ry, rz, dx, dy, dz, radius, out) {
  const b = rx * dx + ry * dy + rz * dz;
  const c = rx * rx + ry * ry + rz * rz - radius * radius;
  const d = b * b - c;
  if (d < 0.0) {
    out[0] = 1.0;
    out[1] = -1.0;
    return out;
  }
  const s = Math.sqrt(d);
  out[0] = -b - s;
  out[1] = -b + s;
  return out;
}

const _roots = new Float32Array(2);

/** Azimuth weights for the fog colour average; the sun's side counts double. */
const FOG_AZIMUTH_WEIGHTS = [0.34, 0.22, 0.22, 0.22];

/* -------------------------------------------------------------------------- */
/* GLSL                                                                        */
/* -------------------------------------------------------------------------- */

const SKY_VERT = `
uniform mat4 uInvProj;
uniform mat4 uInvView;

out vec3 vRay;

void main() {
  // Fullscreen triangle straight out of gl_VertexID (see gl.js drawFullscreen).
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vec2 ndc = p * 2.0 - 1.0;
  vec4 v = uInvProj * vec4(ndc, 1.0, 1.0);
  // The unnormalised view ray is linear in NDC for any perspective matrix, so interpolating
  // it across the triangle is exact and the fragment shader only pays for a normalize().
  vRay = (uInvView * vec4(v.xyz / v.w, 0.0)).xyz;
  gl_Position = vec4(ndc, 1.0, 1.0);
}
`;

const SKY_FRAG = `
in vec3 vRay;
out vec4 fragColor;

uniform vec3 uCameraPos;      // world position, metres
uniform vec3 uSunDir;         // toward the true sun (may be below the horizon)
uniform vec3 uMoonDir;        // toward the moon
uniform vec3 uKeyDir;         // toward the key light (sun by day, moon by night)
uniform vec3 uKeyLight;       // key light radiance, lights the clouds
uniform vec3 uMoonLight;      // moon radiance used for the halo and cloud fill
uniform vec3 uHorizonColor;   // CPU-matched fog colour
uniform vec3 uAmbientSky;     // hemisphere ambient, lights the clouds from above
uniform vec3 uNightSky;       // airglow / integrated starlight floor
uniform vec3 uLightPollution; // warm city glow hugging the horizon
uniform vec3 uGroundAlbedo;   // distant terrain seen below the horizon

uniform float uSunIrradiance;
uniform float uMieBeta;
uniform float uMieG;
uniform float uMultiScatter;
uniform float uTime;
uniform float uNightFactor;
uniform float uStarIntensity;
uniform float uPixelAngle;
uniform float uCameraAlt;     // km above sea level
uniform float uSunAngular;    // sun disc angular radius, radians
uniform float uMoonAngular;
uniform float uMoonBright;
uniform float uHaze;
uniform float uCloudCoverA;
uniform float uCloudCoverB;
uniform float uCloudSharp;
uniform float uStarDensity;
uniform float uMilkyWay;
uniform vec2 uWindA;
uniform vec2 uWindB;

const float PI = 3.141592653589793;
const float RG = 6360.0;
const float RA = 6420.0;
const float HR = 8.0;
const float HM = 1.2;
const vec3 BETA_R = vec3(5.8e-3, 13.5e-3, 33.1e-3);
// Desaturated Rayleigh coefficients driving the isotropic multiple-scattering term: real
// skies keep plenty of blue at low sun because light bounces more than once.
const vec3 BETA_MS = vec3(0.0072, 0.0152, 0.0310);
const float MS_SOFT = 0.40;
const float STEP_K = 6.0;
const float CLOUD_ALT_A = 1500.0;
const float CLOUD_ALT_B = 5400.0;

/* ---------------------------------------------------------------- utilities */

vec2 raySphere(vec3 ro, vec3 rd, float rad) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - rad * rad;
  float d = b * b - c;
  if (d < 0.0) return vec2(1.0, -1.0);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}

float chapman(float x, float cosZ) {
  float c = sqrt(1.5707963 * x);
  if (cosZ >= 0.0) return c / (c * cosZ + 1.0);
  float sinZ = sqrt(max(0.0, 1.0 - cosZ * cosZ));
  float x0 = x * sinZ;
  return max(0.0, 2.0 * sqrt(1.5707963 * x0) * exp(min(x - x0, 60.0)) - c / (1.0 - c * cosZ));
}

float phaseRayleigh(float mu) {
  return 0.0596831 * (1.0 + mu * mu);
}

float phaseHG(float mu, float g) {
  float g2 = g * g;
  float d = max(1.0 + g2 - 2.0 * g * mu, 1e-4);
  return (1.0 - g2) / (12.5663706 * d * sqrt(d));
}

/** Optical depth from a point in the atmosphere toward a light, analytic in both species. */
void lightOpticalDepth(vec3 p, vec3 l, out float odR, out float odM) {
  float r = length(p);
  float alt = max(r - RG, 0.0);
  float cosZ = dot(p, l) / r;
  odR = HR * exp(-alt / HR) * chapman(r / HR, cosZ);
  odM = HM * exp(-alt / HM) * chapman(r / HM, cosZ);
}

/* --------------------------------------------------------------- atmosphere */

/**
 * Single-scattering integral along the view ray. Returns the in-scattered radiance and
 * reports the view transmittance plus the distance to the ground (negative when the ray
 * escapes into space).
 */
vec3 atmosphere(vec3 ro, vec3 rd, out vec3 viewT, out float tGround) {
  vec2 atm = raySphere(ro, rd, RA);
  float tMax = max(atm.y, 0.0);
  vec2 gnd = raySphere(ro, rd, RG);
  tGround = -1.0;
  if (gnd.x <= gnd.y && gnd.x > 0.0) {
    tGround = gnd.x;
    tMax = min(tMax, tGround);
  }

  float betaMs = uMieBeta;
  float betaMe = uMieBeta / 0.9;
  float mu = dot(rd, uSunDir);
  float phR = phaseRayleigh(mu);
  float phM = phaseHG(mu, uMieG);

  float odR = 0.0;
  float odM = 0.0;
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  vec3 sumMS = vec3(0.0);
  float kInv = 1.0 / (exp(STEP_K) - 1.0);
  float tPrev = 0.0;

  for (int i = 0; i < SKY_STEPS; i++) {
    float f = float(i + 1) / float(SKY_STEPS);
    float tNext = tMax * (exp(STEP_K * f) - 1.0) * kInv;
    float dt = tNext - tPrev;
    vec3 p = ro + rd * (tPrev + dt * 0.5);
    tPrev = tNext;

    float alt = max(length(p) - RG, 0.0);
    float dR = exp(-alt / HR) * dt;
    float dM = exp(-alt / HM) * dt;
    odR += dR;
    odM += dM;

    float sR, sM;
    lightOpticalDepth(p, uSunDir, sR, sM);
    vec3 tauView = BETA_R * odR + betaMe * odM;
    vec3 tauSun = BETA_R * sR + betaMe * sM;
    vec3 T = exp(-min(tauView + tauSun, 60.0));
    sumR += T * dR;
    sumM += T * dM;
    // Multiple scattering: the eye still sees through the full column, but light reaching
    // the sample has effectively taken a shorter path, which is what keeps a low sun from
    // draining every last photon out of the blue channel.
    sumMS += exp(-min(tauView + tauSun * MS_SOFT, 60.0)) * (dR + dM);
  }

  viewT = exp(-min(BETA_R * odR + betaMe * odM, 60.0));
  return uSunIrradiance * (BETA_R * (phR * sumR) + betaMs * (phM * sumM)
    + BETA_MS * (uMultiScatter * 0.0795775 * sumMS));
}

/* --------------------------------------------------------------------- hash */

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 hash32(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = p - i;
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i);
  float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}

/* ------------------------------------------------------------------- clouds */

float fbmA(vec2 p) {
  float a = 0.5;
  float s = 0.0;
  float n = 0.0;
  for (int i = 0; i < CLOUD_OCT_A; i++) {
    s += a * vnoise(p);
    n += a;
    a *= 0.5;
    p = p * 2.03 + vec2(1.7, -3.1);
  }
  return s / n;
}

float fbmB(vec2 p) {
  float a = 0.5;
  float s = 0.0;
  float n = 0.0;
  for (int i = 0; i < CLOUD_OCT_B; i++) {
    s += a * vnoise(p);
    n += a;
    a *= 0.5;
    p = p * 2.17 + vec2(-2.3, 1.9);
  }
  return s / n;
}

float fbmStars(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  float n = 0.0;
  for (int i = 0; i < 3; i++) {
    s += a * vnoise3(p);
    n += a;
    a *= 0.5;
    p = p * 2.11 + vec3(3.1, -1.7, 2.3);
  }
  return s / n;
}

/** Cumulus deck: coverage-shaped fBm with a self-shadowed, sun-facing silver lining. */
vec4 cloudsLow(vec3 rd, vec3 sunDir, float mu) {
  float dy = max(rd.y, 0.014);
  float t = (CLOUD_ALT_A - uCameraPos.y) / dy;
  vec2 p = (uCameraPos.xz + rd.xz * t) * 0.00042 + uWindA;
  float d = fbmA(p);
  float cover = uCloudCoverA;
  float density = smoothstep(cover, cover + uCloudSharp, d);
  if (density <= 0.001) return vec4(0.0);

  // Second tap toward the sun estimates how much cloud the light had to cross.
  vec2 sunStep = normalize(sunDir.xz + vec2(1e-4, 1e-4)) * 0.085;
  float toward = smoothstep(cover, cover + uCloudSharp, fbmA(p - sunStep));
  float depth = clamp(toward * 1.15, 0.0, 1.0);
  float lit = exp(-depth * 2.6) * (0.35 + 0.65 * clamp(sunDir.y * 3.0 + 0.35, 0.0, 1.0));
  float silver = clamp(density - toward, 0.0, 1.0);

  float hg = phaseHG(mu, 0.62) * 1.6 + 0.2;
  vec3 col = uAmbientSky * (0.5 + 0.5 * density)
    + uKeyLight * (lit * 0.62 + silver * hg * 0.9)
    + uMoonLight * 0.6;

  float fade = smoothstep(0.012, 0.085, rd.y);
  float aerial = 1.0 - smoothstep(0.03, 0.30, rd.y);
  col = mix(col, uHorizonColor, aerial * 0.75);
  return vec4(col, density * fade * 0.96);
}

/** Cirrus deck: stretched, thin, high and slower. */
vec4 cloudsHigh(vec3 rd, vec3 sunDir, float mu) {
  float dy = max(rd.y, 0.02);
  float t = (CLOUD_ALT_B - uCameraPos.y) / dy;
  vec2 p = (uCameraPos.xz + rd.xz * t) * 0.00013 + uWindB;
  p.x *= 0.42;
  float d = fbmB(p);
  float density = smoothstep(uCloudCoverB, uCloudCoverB + 0.30, d);
  if (density <= 0.001) return vec4(0.0);

  float hg = phaseHG(mu, 0.5) * 1.1 + 0.25;
  vec3 col = uAmbientSky * 0.7 + uKeyLight * (0.35 + 0.35 * hg) + uMoonLight * 0.4;
  float fade = smoothstep(0.02, 0.11, rd.y);
  float aerial = 1.0 - smoothstep(0.05, 0.34, rd.y);
  col = mix(col, uHorizonColor, aerial * 0.7);
  return vec4(col, density * fade * 0.62);
}

/* -------------------------------------------------------------------- stars */

/** Maps a direction to a cube face so star cells stay roughly square everywhere. */
vec2 cubeFaceUV(vec3 rd, out float face) {
  vec3 a = abs(rd);
  if (a.x >= a.y && a.x >= a.z) {
    face = rd.x > 0.0 ? 0.0 : 1.0;
    return rd.zy / a.x;
  }
  if (a.y >= a.z) {
    face = rd.y > 0.0 ? 2.0 : 3.0;
    return rd.xz / a.y;
  }
  face = rd.z > 0.0 ? 4.0 : 5.0;
  return rd.xy / a.z;
}

/**
 * One star layer. Cells hold at most one star, jittered inside the cell and clamped so it
 * never crosses the border; the radius grows with the pixel angle so stars stay visible at
 * any resolution instead of aliasing away.
 */
vec3 starLayer(vec2 uv, float face, float density, float seed, float twinkle) {
  vec2 g = uv * density + seed;
  vec2 cell = floor(g);
  vec2 f = g - cell;
  vec3 h = hash32(cell + vec2(face * 17.13, seed * 3.77));
  if (h.z > 0.55) return vec3(0.0);

  float mag = fract(h.z * 57.31);
  float base = 0.020 + 0.038 * mag;
  // Grow the star with the pixel angle so it never aliases away, but dim it as it grows so
  // low resolutions get points of light instead of a glowing mush.
  float rad = clamp(max(base, uPixelAngle * density * 1.2732 * 0.8), 0.008, 0.30);
  float gain = clamp(base / rad, 0.30, 1.0);
  vec2 pos = clamp(h.xy, min(rad, 0.5), max(1.0 - rad, 0.5));
  float d = length(f - pos);
  float s = 1.0 - smoothstep(0.0, rad, d);
  s *= s;
  if (s <= 0.0) return vec3(0.0);

  float tw = 1.0 + twinkle * 0.55 * sin(uTime * (1.6 + 4.5 * mag) + h.x * 41.0);
  vec3 tint = mix(vec3(0.70, 0.80, 1.0), vec3(1.0, 0.86, 0.66), fract(h.y * 33.7));
  return tint * (s * gain * (0.18 + 1.5 * mag * mag) * max(tw, 0.0));
}

/* --------------------------------------------------------------------- moon */

/** Shades the moon disc: sphere normal, real solar terminator, craters, limb softening. */
vec3 moonDisc(vec3 rd, out float coverage) {
  coverage = 0.0;
  float mc = dot(rd, uMoonDir);
  if (mc <= 0.0) return vec3(0.0);

  vec3 up = abs(uMoonDir.y) > 0.95 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
  vec3 mr = normalize(cross(up, uMoonDir));
  vec3 mu2 = cross(uMoonDir, mr);
  vec2 duv = vec2(dot(rd, mr), dot(rd, mu2)) / uMoonAngular;
  float r2 = dot(duv, duv);
  float edge = max(uPixelAngle / uMoonAngular, 0.01);
  if (r2 > (1.0 + edge) * (1.0 + edge)) return vec3(0.0);

  float r = sqrt(r2);
  float z = sqrt(max(1.0 - min(r2, 1.0), 0.0));
  vec3 n = mr * duv.x + mu2 * duv.y - uMoonDir * z;
  float lam = dot(n, uSunDir);
  float lit = smoothstep(-0.06, 0.16, lam);

  // Lommel-Seeliger-ish flat look plus maria and craters.
  float shade = pow(clamp(lam, 0.0, 1.0), 0.42);
  float maria = smoothstep(0.34, 0.62, vnoise3(n * 3.1 + 4.0));
  float craters = vnoise3(n * 14.0) * 0.35 + vnoise3(n * 31.0) * 0.2;
  float surface = mix(1.0, 0.62, maria) * (0.78 + 0.34 * craters);
  float mask = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, r);
  coverage = mask;

  vec3 body = vec3(0.98, 0.96, 0.90) * surface * (shade * lit + 0.035);
  return body * uMoonBright * mask;
}

/* --------------------------------------------------------------------- main */

void main() {
  vec3 rd = normalize(vRay);
  vec3 ro = vec3(0.0, RG + uCameraAlt, 0.0);

  vec3 viewT;
  float tGround;
  vec3 col = atmosphere(ro, rd, viewT, tGround);

  float muS = dot(rd, uSunDir);
  float muM = dot(rd, uMoonDir);
  vec3 opacity = 1.0 - viewT;

  // Night: airglow, city light pollution hugging the horizon, and the moon's halo.
  if (uNightFactor > 0.002) {
    vec3 night = uNightSky * opacity;
    night += uLightPollution * opacity * exp(-max(rd.y, 0.0) * 5.0);
    night += uMoonLight * opacity * (phaseHG(muM, 0.66) * 0.55 + 0.05);
    col += night * uNightFactor;
  }

  // Distant ground below the horizon, shaded and pushed through the same haze.
  if (tGround > 0.0) {
    vec3 gp = ro + rd * tGround;
    vec3 gn = gp / length(gp);
    float sR, sM;
    lightOpticalDepth(gp, uSunDir, sR, sM);
    vec3 sunT = exp(-min(BETA_R * sR + (uMieBeta / 0.9) * sM, 60.0));
    vec3 lit = sunT * uSunIrradiance * max(dot(gn, uSunDir), 0.0) * 0.318;
    col += uGroundAlbedo * (lit + uAmbientSky * 0.6 + uNightSky * 12.0 * uNightFactor) * viewT;
  } else {
    // ---- celestial bodies, all attenuated by the air in front of them ----
    if (uStarIntensity > 0.002) {
      float face;
      vec2 uv = cubeFaceUV(rd, face);
      vec3 stars = starLayer(uv, face, uStarDensity, 0.0, 1.0)
        + starLayer(uv, face, uStarDensity * 2.13, 7.0, 0.7) * 0.55;
      // Milky Way: a soft band about a fixed galactic pole, broken up by dust lanes.
      vec3 pole = normalize(vec3(0.36, 0.58, -0.73));
      float b = dot(rd, pole);
      float band = exp(-b * b * 15.0);
      float dust = fbmStars(rd * 3.4);
      float mw = band * (0.35 + 0.9 * dust * dust) * uMilkyWay;
      stars += vec3(0.62, 0.66, 0.92) * mw * 0.016;
      col += stars * uStarIntensity * viewT;
    }

    float mcov;
    vec3 moon = moonDisc(rd, mcov);
    col += moon * viewT;
    // Soft glow around the moon, occluded by the disc itself.
    float mang = acos(clamp(muM, -1.0, 1.0));
    col += uMoonLight * 3.2 * exp(-mang * 26.0) * (1.0 - mcov) * viewT;

    // Sun disc with limb darkening, plus a tight halo on top of the Mie glow.
    float sang = acos(clamp(muS, -1.0, 1.0));
    float sEdge = max(uPixelAngle * 1.1, uSunAngular * 0.02);
    float disc = 1.0 - smoothstep(uSunAngular - sEdge, uSunAngular + sEdge, sang);
    if (disc > 0.0) {
      float rr = clamp(sang / uSunAngular, 0.0, 1.0);
      float cosPsi = sqrt(max(1.0 - rr * rr, 0.0));
      float limb = 1.0 - 0.62 * (1.0 - pow(max(cosPsi, 1e-3), 0.45));
      col += vec3(1.0, 0.97, 0.93) * (uSunIrradiance * 1.7 * limb * disc) * viewT;
    }
    col += vec3(1.0, 0.82, 0.58) * (uSunIrradiance * 0.10 * exp(-sang * 55.0)) * viewT;
    col += vec3(1.0, 0.88, 0.72) * (uSunIrradiance * 0.020 * exp(-sang * 9.0)) * viewT;
  }

#if CLOUDS
  vec4 hi = cloudsHigh(rd, uKeyDir, dot(rd, uKeyDir));
  col = mix(col, hi.rgb, clamp(hi.a, 0.0, 1.0));
  vec4 lo = cloudsLow(rd, uKeyDir, dot(rd, uKeyDir));
  col = mix(col, lo.rgb, clamp(lo.a, 0.0, 1.0));
#endif

  // Horizon haze: forces the sky to meet the renderer's fog colour exactly at y = 0 so
  // distant geometry dissolves instead of ending on a visible line.
  float hz = exp(-max(rd.y, 0.0) * 24.0) * uHaze;
  col = mix(col, uHorizonColor, clamp(hz * 0.4, 0.0, 1.0));

  // Guard against any NaN/Inf leaking into the HDR target.
  if (any(isnan(col)) || any(isinf(col))) col = uHorizonColor;
  fragColor = vec4(clamp(col, 0.0, 60000.0), 1.0);
}
`;

/* -------------------------------------------------------------------------- */
/* Quality tiers                                                               */
/* -------------------------------------------------------------------------- */

/** Shader define presets per quality tier. @type {Object<string, Object>} */
const QUALITY_PRESETS = {
  low: { SKY_STEPS: 4, CLOUD_OCT_A: 3, CLOUD_OCT_B: 2, CLOUDS: 1 },
  medium: { SKY_STEPS: 6, CLOUD_OCT_A: 4, CLOUD_OCT_B: 3, CLOUDS: 1 },
  high: { SKY_STEPS: 8, CLOUD_OCT_A: 6, CLOUD_OCT_B: 4, CLOUDS: 1 },
  ultra: { SKY_STEPS: 10, CLOUD_OCT_A: 7, CLOUD_OCT_B: 5, CLOUDS: 1 }
};

/* -------------------------------------------------------------------------- */
/* Sky                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Procedural sky dome: atmospheric scattering, sun, moon, stars, Milky Way and clouds,
 * plus the lighting terms (`sunColor`, `ambientSky`, `fogColor`, ...) the renderer needs to
 * keep the world consistent with what the sky is painting.
 */
export class Sky {
  /**
   * @param {WebGL2RenderingContext} gl Context.
   * @param {Object} [renderer] Owning renderer; only `quality.name` and `hdr` are read,
   *   and both are optional.
   */
  constructor(gl, renderer) {
    /** @type {WebGL2RenderingContext} */
    this.gl = gl;
    /** @type {Object|null} */
    this.renderer = renderer || null;

    /** @type {number} Current clock, 0..24 hours (12 = noon). */
    this.timeOfDay = 12.0;
    /** @type {number} Seconds accumulated by `update`, drives cloud drift and twinkle. */
    this.elapsed = 0.0;
    /** @type {number} Default hours-per-second used when `update` gets no explicit speed. */
    this.daySpeed = 0.0;
    /** @type {boolean} */
    this.disposed = false;

    /**
     * Art-direction knobs. Everything here is safe to change at runtime.
     * @type {Object}
     */
    this.params = {
      cloudiness: 0.38,
      cirrus: 0.45,
      cloudSharpness: 0.22,
      cloudSpeed: 1.0,
      windX: 1.0,
      windZ: 0.35,
      turbidity: 1.0,
      mieG: 0.76,
      sunIrradiance: 8.0,
      multiScatter: 0.25,
      sunAngularRadius: 0.0125,
      moonAngularRadius: 0.026,
      moonElongation: 118.0,
      moonBrightness: 1.35,
      starDensity: 46.0,
      milkyWay: 1.0,
      haze: 1.0,
      lightPollution: 1.0,
      groundAlbedo: [0.085, 0.082, 0.078],
      dayLightIntensity: 3.2,
      moonLightIntensity: 0.055
    };

    /** @type {Float32Array} Unit vector toward the key light (sun by day, moon by night). */
    this.sunDirection = new Float32Array([0.0, 1.0, 0.0]);
    /** @type {Float32Array} Unit vector toward the real sun, even when it is below the horizon. */
    this.sunDirectionTrue = new Float32Array([0.0, 1.0, 0.0]);
    /** @type {Float32Array} Unit vector toward the moon. */
    this.moonDirection = new Float32Array([0.0, -1.0, 0.0]);
    /** @type {Float32Array} Linear colour of the key light, normalised to a peak of 1. */
    this.sunColor = new Float32Array([1.0, 1.0, 1.0]);
    /** @type {number} Key light intensity (small moonlight value at night). */
    this.sunIntensity = 3.0;
    /** @type {Float32Array} Upper-hemisphere ambient radiance. */
    this.ambientSky = new Float32Array([0.2, 0.3, 0.5]);
    /** @type {Float32Array} Lower-hemisphere (bounced) ambient radiance. */
    this.ambientGround = new Float32Array([0.05, 0.05, 0.05]);
    /** @type {Float32Array} Fog colour; matches the sky exactly at the horizon. */
    this.fogColor = new Float32Array([0.6, 0.7, 0.8]);
    /** @type {Float32Array} Zenith radiance (handy for UI/minimap tinting). */
    this.zenithColor = new Float32Array([0.2, 0.3, 0.5]);
    /** @type {number} 0 = full day, 1 = full night. */
    this.nightFactor = 0.0;
    /** @type {number} 0..1 star visibility, follows astronomical twilight. */
    this.starIntensity = 0.0;
    /** @type {number} Sun elevation, radians (negative below the horizon). */
    this.sunElevation = 0.0;
    /** @type {number} Moon elevation, radians. */
    this.moonElevation = 0.0;

    /** @type {Float32Array} Moon radiance used for the halo and cloud fill. */
    this.moonLight = new Float32Array(3);
    /** @type {Float32Array} Warm horizon glow of the city at night. */
    this.lightPollution = new Float32Array(3);

    /** @type {Map<string, Shader>} Compiled variants keyed by define signature. */
    this._shaders = new Map();
    /** @type {string} */
    this._qualityName = this._readQualityName();
    /** @type {number} Viewport height override for the pixel-angle estimate. */
    this._viewportHeight = 0;
    /** @type {Float32Array} Cloud scroll offsets (metres of texture space). */
    this._wind = new Float32Array(4);
    /** @type {number} Cached time the derived values were computed for. */
    this._computedTime = NaN;
    /** @type {boolean} */
    this._dirty = true;
    /** @type {number} Effective Mie scattering coefficient, per km. */
    this._betaM = BETA_M_BASE;

    this._recompute();
    // Compile the current tier up front so shader errors surface at load time.
    this._shader(this._qualityName);
  }

  /* ------------------------------------------------------------- public API */

  /**
   * Sets the wall clock.
   * @param {number} h Hours, 0..24 (wrapped). 12 = noon.
   * @returns {void}
   */
  setTimeOfDay(h) {
    let t = Number(h);
    if (!isFinite(t)) t = 12.0;
    t = t % 24.0;
    if (t < 0.0) t += 24.0;
    if (t !== this.timeOfDay) {
      this.timeOfDay = t;
      this._dirty = true;
    }
  }

  /**
   * Advances the clock and refreshes every derived lighting value.
   * @param {number} dt Frame time in seconds.
   * @param {number} [speed] Hours of game time per real second; defaults to `daySpeed`.
   * @returns {void}
   */
  update(dt, speed) {
    const d = isFinite(dt) ? Math.max(0, dt) : 0;
    this.elapsed += d;
    const s = speed === undefined || speed === null ? this.daySpeed : speed;
    if (s) this.setTimeOfDay(this.timeOfDay + d * s);
    const spd = this.params.cloudSpeed;
    this._wind[0] += d * this.params.windX * 0.0016 * spd;
    this._wind[1] += d * this.params.windZ * 0.0016 * spd;
    this._wind[2] += d * this.params.windX * 0.00042 * spd;
    this._wind[3] += d * this.params.windZ * 0.00042 * spd;
    if (this._dirty) this._recompute();
  }

  /**
   * Sets the cloud coverage.
   * @param {number} v 0 = clear, 1 = overcast.
   * @returns {void}
   */
  setCloudiness(v) {
    this.params.cloudiness = clamp(v, 0, 1);
  }

  /**
   * Sets the cloud drift direction/speed.
   * @param {number} x East-west component.
   * @param {number} z North-south component.
   * @param {number} [speed] Overall multiplier.
   * @returns {void}
   */
  setWind(x, z, speed) {
    this.params.windX = x;
    this.params.windZ = z;
    if (speed !== undefined) this.params.cloudSpeed = speed;
  }

  /**
   * Picks the shader variant tier. Unknown names fall back to 'high'.
   * @param {string|{name: string}} nameOrObject Quality tier.
   * @returns {void}
   */
  setQuality(nameOrObject) {
    const name = typeof nameOrObject === 'string' ? nameOrObject : (nameOrObject && nameOrObject.name);
    this._qualityName = QUALITY_PRESETS[name] ? name : 'high';
  }

  /**
   * Tells the sky how tall the render target is, so star and disc edges can be sized in
   * pixels. Optional: without it the drawing buffer / renderer HDR target size is used.
   * @param {number} width Target width in pixels (unused, kept for symmetry).
   * @param {number} height Target height in pixels.
   * @returns {void}
   */
  resize(width, height) {
    this._viewportHeight = Math.max(1, height | 0);
  }

  /**
   * Compiles every quality variant up front (loading screen / validation).
   * @returns {void}
   */
  precompile() {
    for (const name in QUALITY_PRESETS) this._shader(name);
  }

  /**
   * Draws the sky as a full-screen triangle into the currently bound framebuffer.
   * Depth test LEQUAL with depth writes disabled, so existing geometry is never overwritten
   * and the viewport is left untouched.
   * @param {Object} camera Camera with `position`, `invProj`/`invView` (or `proj`/`view`) and `fov`.
   * @returns {void}
   */
  render(camera) {
    if (this.disposed || !camera) return;
    if (this._dirty) this._recompute();
    const gl = this.gl;

    const qualityName = this._readQualityName();
    if (QUALITY_PRESETS[qualityName]) this._qualityName = qualityName;
    const shader = this._shader(this._qualityName);
    shader.use();

    let invProj = camera.invProj;
    if (!invProj && camera.proj) invProj = mat4.invert(_invProj, camera.proj);
    let invView = camera.invView;
    if (!invView && camera.view) invView = mat4.invert(_invView, camera.view);
    if (!invProj || !invView) return;
    shader.setMat4('uInvProj', invProj);
    shader.setMat4('uInvView', invView);

    const pos = camera.position || _dir;
    const camY = pos[1] || 0;
    shader.setVec3('uCameraPos', pos[0] || 0, camY, pos[2] || 0);
    shader.setFloat('uCameraAlt', 0.02 + Math.max(camY, 0) * 0.001);

    shader.setVec3v('uSunDir', this.sunDirectionTrue);
    shader.setVec3v('uMoonDir', this.moonDirection);
    shader.setVec3v('uKeyDir', this.sunDirection);
    shader.setVec3(
      'uKeyLight',
      this.sunColor[0] * this.sunIntensity,
      this.sunColor[1] * this.sunIntensity,
      this.sunColor[2] * this.sunIntensity
    );
    shader.setVec3v('uMoonLight', this.moonLight);
    shader.setVec3v('uHorizonColor', this.fogColor);
    shader.setVec3v('uAmbientSky', this.ambientSky);
    shader.setVec3(
      'uNightSky',
      NIGHT_SKY_TINT[0], NIGHT_SKY_TINT[1], NIGHT_SKY_TINT[2]
    );
    shader.setVec3v('uLightPollution', this.lightPollution);
    const ga = this.params.groundAlbedo;
    shader.setVec3('uGroundAlbedo', ga[0], ga[1], ga[2]);

    shader.setFloat('uSunIrradiance', this.params.sunIrradiance);
    shader.setFloat('uMieBeta', this._betaM);
    shader.setFloat('uMieG', this.params.mieG);
    shader.setFloat('uMultiScatter', this.params.multiScatter);
    shader.setFloat('uTime', this.elapsed);
    shader.setFloat('uNightFactor', this.nightFactor);
    shader.setFloat('uStarIntensity', this.starIntensity);
    shader.setFloat('uSunAngular', this.params.sunAngularRadius);
    shader.setFloat('uMoonAngular', this.params.moonAngularRadius);
    shader.setFloat('uMoonBright', this.params.moonBrightness * (0.25 + 0.75 * this.nightFactor));
    shader.setFloat('uHaze', this.params.haze);
    shader.setFloat('uStarDensity', this.params.starDensity);
    shader.setFloat('uMilkyWay', this.params.milkyWay);

    const cover = clamp(1.0 - this.params.cloudiness, 0.02, 0.98);
    shader.setFloat('uCloudCoverA', 0.30 + cover * 0.42);
    shader.setFloat('uCloudCoverB', 0.34 + clamp(1.0 - this.params.cirrus, 0, 1) * 0.36);
    shader.setFloat('uCloudSharp', clamp(this.params.cloudSharpness, 0.02, 0.9));
    shader.setVec2('uWindA', this._wind[0], this._wind[1]);
    shader.setVec2('uWindB', this._wind[2], this._wind[3]);
    shader.setFloat('uPixelAngle', this._pixelAngle(camera));

    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    drawFullscreen(gl);
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
  }

  /**
   * Releases every compiled shader variant.
   * @returns {void}
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._shaders.forEach((s) => s.dispose());
    this._shaders.clear();
  }

  /* ---------------------------------------------------------------- private */

  /**
   * Reads the owning renderer's quality tier name.
   * @returns {string} Tier name, defaulting to 'high'.
   * @private
   */
  _readQualityName() {
    const q = this.renderer && this.renderer.quality;
    const name = q && q.name;
    return QUALITY_PRESETS[name] ? name : (this._qualityName || 'high');
  }

  /**
   * Returns (compiling on first use) the shader variant for a quality tier.
   * @param {string} name Tier name.
   * @returns {Shader} Compiled program.
   * @private
   */
  _shader(name) {
    const key = QUALITY_PRESETS[name] ? name : 'high';
    let shader = this._shaders.get(key);
    if (shader) return shader;
    shader = new Shader(this.gl, SKY_VERT, SKY_FRAG, QUALITY_PRESETS[key], 'sky:' + key);
    this._shaders.set(key, shader);
    return shader;
  }

  /**
   * Angular size of one pixel, used to keep stars and disc edges resolution independent.
   * @param {Object} camera Active camera.
   * @returns {number} Radians per pixel.
   * @private
   */
  _pixelAngle(camera) {
    let h = this._viewportHeight;
    if (!h && this.renderer && this.renderer.hdr && this.renderer.hdr.height) h = this.renderer.hdr.height;
    if (!h) h = this.gl.drawingBufferHeight || 720;
    let fov = camera.fov === undefined ? 62 : camera.fov;
    if (fov > 3.5) fov *= DEG2RAD;
    return (2.0 * Math.tan(fov * 0.5)) / h;
  }

  /**
   * Recomputes the solar/lunar positions and every derived lighting colour by running the
   * same scattering integral the shader uses (at a lower step count).
   * @returns {void}
   * @private
   */
  _recompute() {
    this._dirty = false;
    this._computedTime = this.timeOfDay;
    this._betaM = BETA_M_BASE * clamp(this.params.turbidity, 0.05, 8.0);

    // ---- solar position (hour angle / declination / observer latitude) ----
    const hourAngle = (this.timeOfDay - 12.0) * (PI / 12.0);
    const sinLat = Math.sin(LATITUDE);
    const cosLat = Math.cos(LATITUDE);
    this._placeBody(hourAngle, DECLINATION, sinLat, cosLat, this.sunDirectionTrue);
    const sunY = this.sunDirectionTrue[1];
    this.sunElevation = Math.asin(clamp(sunY, -1, 1));

    const elong = this.params.moonElongation * DEG2RAD;
    this._placeBody(hourAngle - elong, MOON_DECLINATION, sinLat, cosLat, this.moonDirection);
    const moonY = this.moonDirection[1];
    this.moonElevation = Math.asin(clamp(moonY, -1, 1));

    // ---- day / night blends ----
    this.nightFactor = 1.0 - smoothstep(-0.18, 0.06, sunY);
    this.starIntensity = smoothstep(-0.02, -0.14, sunY);
    const moonUp = smoothstep(-0.05, 0.12, moonY);
    const moonAmount = moonUp * this.nightFactor;

    // ---- key light direction: sun by day, moon once the sun is gone ----
    const toMoon = smoothstep(-0.02, -0.12, sunY) * moonUp;
    for (let i = 0; i < 3; i++) {
      this.sunDirection[i] = lerp(this.sunDirectionTrue[i], this.moonDirection[i], toMoon);
    }
    normalize3(this.sunDirection);

    // ---- sun colour from the transmittance along the solar ray ----
    const camAlt = 0.02;
    const r = RG + camAlt;
    const cosZ = Math.max(sunY, 0.015);
    const odR = HR * Math.exp(-camAlt / HR) * chapman(r / HR, cosZ);
    const odM = HM * Math.exp(-camAlt / HM) * chapman(r / HM, cosZ);
    const betaMe = this._betaM / MIE_ALBEDO;
    let peak = 1e-4;
    for (let i = 0; i < 3; i++) {
      const t = Math.exp(-Math.min(BETA_R[i] * odR + betaMe * odM, 60.0));
      _rgb[i] = t;
      if (t > peak) peak = t;
    }
    const dayIntensity = this.params.dayLightIntensity * smoothstep(-0.06, 0.14, sunY);
    const moonIntensity = this.params.moonLightIntensity * moonAmount;
    for (let i = 0; i < 3; i++) {
      const warm = Math.pow(clamp(_rgb[i] / peak, 0.0, 1.0), 0.62);
      this.sunColor[i] = lerp(Math.max(warm, 0.02), MOON_TINT[i], toMoon);
    }
    this.sunIntensity = Math.max(dayIntensity, moonIntensity);

    // ---- moon radiance + city light pollution feed the shader's night terms ----
    const moonGlow = this.params.moonLightIntensity * moonUp * (0.5 + 0.5 * this.nightFactor);
    for (let i = 0; i < 3; i++) {
      this.moonLight[i] = MOON_TINT[i] * moonGlow;
      this.lightPollution[i] = POLLUTION_TINT[i] * this.params.lightPollution;
    }

    // ---- sky colours straight out of the scattering integral ----
    this._scatter(0.0, 1.0, 0.0, this.zenithColor);

    const sx = this.sunDirectionTrue[0];
    const sz = this.sunDirectionTrue[2];
    let hx = sx;
    let hz = sz;
    const hl = Math.hypot(hx, hz);
    if (hl < 1e-4) { hx = 0; hz = -1; } else { hx /= hl; hz /= hl; }
    const hy = 0.045;
    const inv = 1.0 / Math.sqrt(1.0 + hy * hy);
    this.fogColor[0] = 0; this.fogColor[1] = 0; this.fogColor[2] = 0;
    // Weighted azimuth average: the sun's side counts double so sunset fog stays warm.
    const weights = FOG_AZIMUTH_WEIGHTS;
    for (let k = 0; k < 4; k++) {
      const a = k * (PI * 0.5);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const dx = (hx * ca - hz * sa) * inv;
      const dz = (hx * sa + hz * ca) * inv;
      this._scatter(dx, hy * inv, dz, _rgb2);
      this.fogColor[0] += _rgb2[0] * weights[k];
      this.fogColor[1] += _rgb2[1] * weights[k];
      this.fogColor[2] += _rgb2[2] * weights[k];
    }

    // ---- hemisphere ambient ----
    for (let i = 0; i < 3; i++) {
      const sky = lerp(this.zenithColor[i], this.fogColor[i], 0.42);
      this.ambientSky[i] = sky;
      const bounce = (this.fogColor[i] * 0.55 + this.sunColor[i] * this.sunIntensity *
        Math.max(sunY, 0.0) * 0.12) * this.params.groundAlbedo[i] * 2.2;
      this.ambientGround[i] = bounce;
    }
  }

  /**
   * Places a celestial body from its hour angle and declination.
   * @param {number} H Hour angle in radians (0 = local meridian).
   * @param {number} dec Declination in radians.
   * @param {number} sinLat Sine of the observer latitude.
   * @param {number} cosLat Cosine of the observer latitude.
   * @param {Float32Array} out Receives the unit direction toward the body.
   * @returns {Float32Array} `out`.
   * @private
   */
  _placeBody(H, dec, sinLat, cosLat, out) {
    const sinDec = Math.sin(dec);
    const cosDec = Math.cos(dec);
    const cosH = Math.cos(H);
    const sinH = Math.sin(H);
    const sinAlt = clamp(sinLat * sinDec + cosLat * cosDec * cosH, -1, 1);
    const cosAlt = Math.sqrt(Math.max(0.0, 1.0 - sinAlt * sinAlt));
    // Azimuth measured from due south toward the west.
    const azS = Math.atan2(sinH, cosH * sinLat - (sinDec / Math.max(cosDec, 1e-6)) * cosLat);
    // Compass azimuth = 180 deg + azS; +X is east and -Z is north.
    const compass = PI + azS;
    out[0] = cosAlt * Math.sin(compass);
    out[1] = sinAlt;
    out[2] = -cosAlt * Math.cos(compass);
    return out;
  }

  /**
   * CPU mirror of the shader's scattering integral (plus the night terms), so the fog and
   * ambient colours are exactly what the sky paints in that direction.
   * @param {number} dx Ray direction x (unit).
   * @param {number} dy Ray direction y (unit).
   * @param {number} dz Ray direction z (unit).
   * @param {Float32Array} out Receives linear HDR radiance.
   * @returns {Float32Array} `out`.
   * @private
   */
  _scatter(dx, dy, dz, out) {
    const camAlt = 0.02;
    const oy = RG + camAlt;
    raySphere(0, oy, 0, dx, dy, dz, RA, _roots);
    let tMax = Math.max(_roots[1], 0.0);
    raySphere(0, oy, 0, dx, dy, dz, RG, _roots);
    let tGround = -1.0;
    if (_roots[0] <= _roots[1] && _roots[0] > 0.0) {
      tGround = _roots[0];
      tMax = Math.min(tMax, tGround);
    }

    const sun = this.sunDirectionTrue;
    const betaMs = this._betaM;
    const betaMe = this._betaM / MIE_ALBEDO;
    const mu = dx * sun[0] + dy * sun[1] + dz * sun[2];
    const phR = phaseRayleigh(mu);
    const phM = phaseHG(mu, this.params.mieG);

    let odR = 0.0;
    let odM = 0.0;
    let sumR0 = 0.0, sumR1 = 0.0, sumR2 = 0.0;
    let sumM0 = 0.0, sumM1 = 0.0, sumM2 = 0.0;
    let sumS0 = 0.0, sumS1 = 0.0, sumS2 = 0.0;
    const kInv = 1.0 / (Math.exp(STEP_K) - 1.0);
    let tPrev = 0.0;
    for (let i = 0; i < CPU_STEPS; i++) {
      const f = (i + 1) / CPU_STEPS;
      const tNext = tMax * (Math.exp(STEP_K * f) - 1.0) * kInv;
      const dt = tNext - tPrev;
      const tm = tPrev + dt * 0.5;
      tPrev = tNext;
      const px = dx * tm;
      const py = oy + dy * tm;
      const pz = dz * tm;
      const pr = Math.sqrt(px * px + py * py + pz * pz);
      const alt = Math.max(pr - RG, 0.0);
      const dR = Math.exp(-alt / HR) * dt;
      const dM = Math.exp(-alt / HM) * dt;
      odR += dR;
      odM += dM;
      const cosZ = (px * sun[0] + py * sun[1] + pz * sun[2]) / pr;
      const sR = HR * Math.exp(-alt / HR) * chapman(pr / HR, cosZ);
      const sM = HM * Math.exp(-alt / HM) * chapman(pr / HM, cosZ);
      const tv0 = BETA_R[0] * odR + betaMe * odM;
      const tv1 = BETA_R[1] * odR + betaMe * odM;
      const tv2 = BETA_R[2] * odR + betaMe * odM;
      const ts0 = BETA_R[0] * sR + betaMe * sM;
      const ts1 = BETA_R[1] * sR + betaMe * sM;
      const ts2 = BETA_R[2] * sR + betaMe * sM;
      const t0 = Math.exp(-Math.min(tv0 + ts0, 60.0));
      const t1 = Math.exp(-Math.min(tv1 + ts1, 60.0));
      const t2 = Math.exp(-Math.min(tv2 + ts2, 60.0));
      sumR0 += t0 * dR; sumR1 += t1 * dR; sumR2 += t2 * dR;
      sumM0 += t0 * dM; sumM1 += t1 * dM; sumM2 += t2 * dM;
      const dms = dR + dM;
      sumS0 += Math.exp(-Math.min(tv0 + ts0 * MS_SOFT, 60.0)) * dms;
      sumS1 += Math.exp(-Math.min(tv1 + ts1 * MS_SOFT, 60.0)) * dms;
      sumS2 += Math.exp(-Math.min(tv2 + ts2 * MS_SOFT, 60.0)) * dms;
    }

    const I = this.params.sunIrradiance;
    _trans[0] = Math.exp(-Math.min(BETA_R[0] * odR + betaMe * odM, 60.0));
    _trans[1] = Math.exp(-Math.min(BETA_R[1] * odR + betaMe * odM, 60.0));
    _trans[2] = Math.exp(-Math.min(BETA_R[2] * odR + betaMe * odM, 60.0));
    const ms = this.params.multiScatter * 0.0795775;
    out[0] = I * (BETA_R[0] * phR * sumR0 + betaMs * phM * sumM0 + BETA_MS[0] * ms * sumS0);
    out[1] = I * (BETA_R[1] * phR * sumR1 + betaMs * phM * sumM1 + BETA_MS[1] * ms * sumS1);
    out[2] = I * (BETA_R[2] * phR * sumR2 + betaMs * phM * sumM2 + BETA_MS[2] * ms * sumS2);

    // Night terms, mirroring the fragment shader.
    if (this.nightFactor > 0.002) {
      const moon = this.moonDirection;
      const muM = dx * moon[0] + dy * moon[1] + dz * moon[2];
      const halo = phaseHG(muM, 0.66) * 0.55 + 0.05;
      const horiz = Math.exp(-Math.max(dy, 0.0) * 5.0);
      for (let i = 0; i < 3; i++) {
        const opacity = 1.0 - _trans[i];
        out[i] += (NIGHT_SKY_TINT[i] * opacity + this.lightPollution[i] * opacity * horiz +
          this.moonLight[i] * opacity * halo) * this.nightFactor;
      }
    }

    if (tGround > 0.0) {
      const px = dx * tGround;
      const py = oy + dy * tGround;
      const pz = dz * tGround;
      const pr = Math.sqrt(px * px + py * py + pz * pz);
      const alt = Math.max(pr - RG, 0.0);
      const cosZ = (px * sun[0] + py * sun[1] + pz * sun[2]) / pr;
      const sR = HR * Math.exp(-alt / HR) * chapman(pr / HR, cosZ);
      const sM = HM * Math.exp(-alt / HM) * chapman(pr / HM, cosZ);
      const ndl = Math.max((px * sun[0] + py * sun[1] + pz * sun[2]) / pr, 0.0);
      const ga = this.params.groundAlbedo;
      for (let i = 0; i < 3; i++) {
        const sunT = Math.exp(-Math.min(BETA_R[i] * sR + betaMe * sM, 60.0));
        const lit = sunT * this.params.sunIrradiance * ndl * 0.318;
        out[i] += ga[i] * (lit + this.ambientSky[i] * 0.6 +
          NIGHT_SKY_TINT[i] * 12.0 * this.nightFactor) * _trans[i];
      }
    }

    for (let i = 0; i < 3; i++) {
      if (!isFinite(out[i]) || out[i] < 0) out[i] = 0;
    }
    return out;
  }
}

/**
 * Normalises a 3-component array in place.
 * @param {Float32Array} v Vector.
 * @returns {Float32Array} `v`.
 */
function normalize3(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (l > 1e-6) {
    v[0] /= l;
    v[1] /= l;
    v[2] /= l;
  } else {
    v[0] = 0;
    v[1] = 1;
    v[2] = 0;
  }
  return v;
}
