/**
 * @file js/render/postfx.js
 * NEON CITY post-processing stack: the HDR resolve chain that turns the renderer's
 * `RGBA16F` scene buffer into the final sRGB image shown on the canvas.
 *
 * Pass order (each pass is individually toggleable, so `low` quality collapses to
 * "tonemap + FXAA"):
 *   1. SSAO         depth-only hemisphere occlusion + 4x4 bilateral blur -> single channel target
 *   2. bright pass  soft-knee luminance threshold at half resolution
 *   3. bloom        5-6 mip progressive downsample (13-tap, Karis average) then a 3x3 tent
 *                   upsample lerped back up the chain (dual filtering) - smooth and wide,
 *                   never boxy, and energy-normalised so `bloomStrength` reads as 0..1
 *   4. composite    hdr * exposure + bloom, AO, radial speed blur, chromatic aberration,
 *                   ACES filmic tonemap, saturation/contrast grading, vignette, film grain,
 *                   damage flash, death desaturation, animated rain/wet overlay, linear -> sRGB
 *   5. FXAA         3.11 quality preset on the final sRGB image
 *
 * Contract with `render/renderer.js`:
 *  - `render()` draws into whatever framebuffer is bound on entry and restores that binding
 *    plus the output viewport (`resize()` dimensions) before returning;
 *  - `aoTexture` is published as soon as SSAO is enabled by the active quality preset, because
 *    the renderer samples it in the PBR pass (`uAoTex`, screen-space uv, red channel). The AO of
 *    frame N is produced at the end of frame N, so the lighting pass consumes it one frame later;
 *  - no allocation happens per frame: every target, shader and scratch array lives on the instance.
 *
 * All shader bodies omit `#version` - `core/gl.js` injects the version, precision and defines.
 */

import { Shader, RenderTarget, Texture2D, drawFullscreen } from '../core/gl.js';
import { clamp, Rand } from '../core/math.js';

/* -------------------------------------------------------------------------- */
/* Tunables                                                                    */
/* -------------------------------------------------------------------------- */

/** Maximum number of bloom mips (the chain is shortened on small framebuffers). */
const MAX_BLOOM_LEVELS = 6;
/** Smallest mip edge that is still worth rendering. */
const MIN_BLOOM_SIZE = 4;
/** Hemisphere kernel size of the SSAO pass. */
const SSAO_SAMPLES = 16;
/** Radial motion blur taps (uniform-branched off when `speedBlur` is 0). */
const MOTION_BLUR_TAPS = 8;
/**
 * Encoding divisor used when `EXT_color_buffer_float` is missing and the bloom chain has to
 * live in RGBA8: the bright pass writes `color / LDR_BLOOM_SCALE` and the composite multiplies
 * it back. Bloom filtering is linear, so the scale commutes through the whole chain.
 */
const LDR_BLOOM_SCALE = 16;

/** Quality preset name -> ordinal, used to gate the expensive passes. */
const QUALITY_LEVEL = { low: 0, medium: 1, high: 2, ultra: 3 };

/**
 * Default post FX parameters. `Renderer.postParams` overrides these every frame; any missing
 * or non-finite field falls back to the value below.
 * @type {Object<string, number>}
 */
export const POSTFX_DEFAULTS = {
  exposure: 1,
  bloomStrength: 0.55,
  bloomThreshold: 1.1,
  bloomKnee: 0.6,
  bloomRadius: 1,
  vignette: 0.32,
  grain: 0.03,
  chromatic: 0.35,
  saturation: 1.05,
  contrast: 1.02,
  rain: 0,
  wetness: 0,
  damageFlash: 0,
  deathFade: 0,
  ssao: 1,
  speedBlur: 0
};

/**
 * Parameter names, resolved once so the per-frame merge never walks object keys.
 * @type {string[]}
 */
const PARAM_KEYS = Object.keys(POSTFX_DEFAULTS);

/* -------------------------------------------------------------------------- */
/* Shared GLSL                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Fullscreen triangle vertex stage used by every pass (matches `drawFullscreen`).
 * Kept local so post FX never depends on another module's shader table.
 * @type {string}
 */
const VERTEX_FULLSCREEN = `
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** Hash helpers (Dave Hoskins style: fract/multiply only, stable across drivers). */
const GLSL_HASH = `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
`;

/** Rec.709 luminance. */
const GLSL_LUMA = `
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

/* -------------------------------------------------------------------------- */
/* SSAO                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Screen-space ambient occlusion from the depth buffer alone: view-space position and
 * normal are reconstructed per pixel, then a hemisphere kernel (rotated by a per-pixel hash)
 * is projected back to screen space and range-checked.
 * Uniforms: `uDepth`, `uInvProj`, `uProj`, `uKernel[]`, `uDepthTexel`, `uParams`.
 * @type {string}
 */
const FRAGMENT_SSAO = GLSL_HASH + `
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uDepth;
uniform mat4 uInvProj;
uniform mat4 uProj;
uniform vec3 uKernel[SSAO_SAMPLES];
uniform vec2 uDepthTexel;
/** x = radius (m), y = bias (m), z = intensity, w = power. */
uniform vec4 uParams;

/** Reconstructs a view-space position from a uv + hardware depth pair. */
vec3 viewPos(vec2 uv, float depth) {
  vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 v = uInvProj * clip;
  return v.xyz / v.w;
}

void main() {
  float dC = texture(uDepth, vUv).r;
  // Sky / cleared depth: fully unoccluded.
  if (dC >= 0.999999) {
    fragColor = vec4(1.0);
    return;
  }

  vec3 pC = viewPos(vUv, dC);

  // Normal from depth using the closest neighbour on each axis, so creases and silhouettes
  // do not smear a bogus normal across the depth discontinuity.
  vec2 ex = vec2(uDepthTexel.x, 0.0);
  vec2 ey = vec2(0.0, uDepthTexel.y);
  vec3 pL = viewPos(vUv - ex, texture(uDepth, vUv - ex).r);
  vec3 pR = viewPos(vUv + ex, texture(uDepth, vUv + ex).r);
  vec3 pD = viewPos(vUv - ey, texture(uDepth, vUv - ey).r);
  vec3 pU = viewPos(vUv + ey, texture(uDepth, vUv + ey).r);
  vec3 ddx = (abs(pC.z - pL.z) < abs(pR.z - pC.z)) ? (pC - pL) : (pR - pC);
  vec3 ddy = (abs(pC.z - pD.z) < abs(pU.z - pC.z)) ? (pC - pD) : (pU - pC);
  vec3 n = cross(ddx, ddy);
  float nl = length(n);
  n = nl > 1e-8 ? n / nl : vec3(0.0, 0.0, 1.0);
  if (n.z < 0.0) n = -n;

  float angle = hash12(gl_FragCoord.xy) * 6.2831853;
  vec3 rv = vec3(cos(angle), sin(angle), 0.0);
  vec3 t = rv - n * dot(rv, n);
  float tl = length(t);
  t = tl > 1e-6 ? t / tl : normalize(cross(n, vec3(0.0, 1.0, 0.0) + vec3(0.001, 0.0, 0.0)));
  vec3 b = cross(n, t);
  mat3 tbn = mat3(t, b, n);

  float radius = uParams.x;
  float occlusion = 0.0;
  float weight = 0.0;
  for (int i = 0; i < SSAO_SAMPLES; i++) {
    vec3 sp = pC + tbn * (uKernel[i] * radius);
    vec4 clip = uProj * vec4(sp, 1.0);
    if (clip.w <= 0.0) continue;
    vec2 suv = (clip.xy / clip.w) * 0.5 + 0.5;
    weight += 1.0;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
    float sd = texture(uDepth, suv).r;
    if (sd >= 0.999999) continue;
    // View-space z of whatever the scene actually has at that screen position.
    float sceneZ = viewPos(suv, sd).z;
    // View space looks down -z, so a *larger* z is closer to the camera.
    float occluded = step(sp.z + uParams.y, sceneZ);
    float rangeCheck = smoothstep(0.0, 1.0, radius / max(1e-4, abs(pC.z - sceneZ)));
    occlusion += occluded * rangeCheck;
  }

  float ao = 1.0 - (occlusion / max(1.0, weight)) * uParams.z;
  fragColor = vec4(pow(clamp(ao, 0.0, 1.0), uParams.w));
}
`;

/**
 * Depth-aware 4x4 box blur of the AO buffer. Weighting by view-space depth similarity keeps
 * occlusion from bleeding across silhouettes.
 * Uniforms: `uAo`, `uDepth`, `uInvProj`, `uTexel`, `uDepthSigma`.
 * @type {string}
 */
const FRAGMENT_AO_BLUR = `
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uAo;
uniform sampler2D uDepth;
uniform mat4 uInvProj;
uniform vec2 uTexel;
uniform float uDepthSigma;

/** View-space z only: for a standard perspective matrix it depends solely on the ndc depth. */
float viewZ(vec2 uv) {
  float d = texture(uDepth, uv).r;
  vec4 v = uInvProj * vec4(0.0, 0.0, d * 2.0 - 1.0, 1.0);
  return v.z / v.w;
}

void main() {
  float zc = viewZ(vUv);
  float sum = 0.0;
  float wsum = 0.0;
  for (int y = -2; y < 2; y++) {
    for (int x = -2; x < 2; x++) {
      vec2 o = vec2(float(x) + 0.5, float(y) + 0.5);
      vec2 uv = vUv + o * uTexel;
      float spatial = exp(-dot(o, o) * 0.18);
      float z = viewZ(uv);
      float range = 1.0 / (1.0 + abs(z - zc) * uDepthSigma);
      float w = spatial * range;
      sum += texture(uAo, uv).r * w;
      wsum += w;
    }
  }
  fragColor = vec4(sum / max(wsum, 1e-4));
}
`;

/* -------------------------------------------------------------------------- */
/* Bloom                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Bright pass: 4-tap Karis-averaged box downsample to half resolution followed by a
 * soft-knee luminance threshold, so a bright pixel fades in instead of popping.
 * Uniforms: `uSource`, `uTexel`, `uParams` (exposure, threshold, knee, outScale).
 * @type {string}
 */
const FRAGMENT_BRIGHT = GLSL_LUMA + `
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uTexel;
uniform vec4 uParams;

/** Karis weight: averages in "luminance-inverse" space to stop single-pixel fireflies. */
float karis(vec3 c) { return 1.0 / (1.0 + luma(c)); }

void main() {
  vec3 a = texture(uSource, vUv + vec2(-1.0, -1.0) * uTexel).rgb * uParams.x;
  vec3 b = texture(uSource, vUv + vec2( 1.0, -1.0) * uTexel).rgb * uParams.x;
  vec3 c = texture(uSource, vUv + vec2(-1.0,  1.0) * uTexel).rgb * uParams.x;
  vec3 d = texture(uSource, vUv + vec2( 1.0,  1.0) * uTexel).rgb * uParams.x;
  float wa = karis(a);
  float wb = karis(b);
  float wc = karis(c);
  float wd = karis(d);
  vec3 col = (a * wa + b * wb + c * wc + d * wd) / max(1e-5, wa + wb + wc + wd);

  // Soft-knee threshold (Unity/Frostbite style prefilter).
  float br = max(col.r, max(col.g, col.b));
  float knee = max(1e-4, uParams.z);
  float soft = br - uParams.y + knee;
  soft = clamp(soft, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contribution = max(soft, br - uParams.y) / max(br, 1e-4);
  fragColor = vec4(col * contribution * uParams.w, 1.0);
}
`;

/**
 * 13-tap downsample (Jimenez / Call of Duty). The five 4-tap groups are optionally combined
 * with a Karis average on the first step, which is where fireflies would otherwise survive.
 * Uniforms: `uSource`, `uTexel` (1 / source size), `uKaris`.
 * @type {string}
 */
const FRAGMENT_DOWNSAMPLE = GLSL_LUMA + `
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uKaris;

vec3 fetch(vec2 o) { return texture(uSource, vUv + o * uTexel).rgb; }
float karis(vec3 c) { return 1.0 / (1.0 + luma(c)); }

void main() {
  vec3 a = fetch(vec2(-2.0,  2.0));
  vec3 b = fetch(vec2( 0.0,  2.0));
  vec3 c = fetch(vec2( 2.0,  2.0));
  vec3 d = fetch(vec2(-2.0,  0.0));
  vec3 e = fetch(vec2( 0.0,  0.0));
  vec3 f = fetch(vec2( 2.0,  0.0));
  vec3 g = fetch(vec2(-2.0, -2.0));
  vec3 h = fetch(vec2( 0.0, -2.0));
  vec3 i = fetch(vec2( 2.0, -2.0));
  vec3 j = fetch(vec2(-1.0,  1.0));
  vec3 k = fetch(vec2( 1.0,  1.0));
  vec3 l = fetch(vec2(-1.0, -1.0));
  vec3 m = fetch(vec2( 1.0, -1.0));

  vec3 g0 = (a + b + d + e) * 0.25;
  vec3 g1 = (b + c + e + f) * 0.25;
  vec3 g2 = (d + e + g + h) * 0.25;
  vec3 g3 = (e + f + h + i) * 0.25;
  vec3 g4 = (j + k + l + m) * 0.25;

  vec3 result;
  if (uKaris > 0.5) {
    float w0 = karis(g0) * 0.125;
    float w1 = karis(g1) * 0.125;
    float w2 = karis(g2) * 0.125;
    float w3 = karis(g3) * 0.125;
    float w4 = karis(g4) * 0.5;
    result = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) /
      max(1e-5, w0 + w1 + w2 + w3 + w4);
  } else {
    result = (g0 + g1 + g2 + g3) * 0.125 + g4 * 0.5;
  }
  fragColor = vec4(result, 1.0);
}
`;

/**
 * 3x3 tent upsample. Blended straight onto the next larger mip with a constant-factor lerp
 * (`dst = tent(src) * scatter + dst * (1 - scatter)`), which is the "dual filtering"
 * accumulation that makes the bloom wide and perfectly smooth while keeping the total energy
 * equal to the bright pass, so `bloomStrength` stays a meaningful 0..1 dial.
 * Uniforms: `uSource`, `uTexel` (radius / source size).
 * @type {string}
 */
const FRAGMENT_UPSAMPLE = `
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uTexel;

vec3 fetch(vec2 o) { return texture(uSource, vUv + o * uTexel).rgb; }

void main() {
  vec3 sum = fetch(vec2(-1.0,  1.0)) * 1.0;
  sum += fetch(vec2( 0.0,  1.0)) * 2.0;
  sum += fetch(vec2( 1.0,  1.0)) * 1.0;
  sum += fetch(vec2(-1.0,  0.0)) * 2.0;
  sum += fetch(vec2( 0.0,  0.0)) * 4.0;
  sum += fetch(vec2( 1.0,  0.0)) * 2.0;
  sum += fetch(vec2(-1.0, -1.0)) * 1.0;
  sum += fetch(vec2( 0.0, -1.0)) * 2.0;
  sum += fetch(vec2( 1.0, -1.0)) * 1.0;
  fragColor = vec4(sum * (1.0 / 16.0), 1.0);
}
`;

/* -------------------------------------------------------------------------- */
/* Composite                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The resolve pass: HDR + bloom + AO -> ACES filmic tonemap -> grading -> screen effects -> sRGB.
 * Every effect is uniform-gated so a strength of 0 leaves the image bit-for-bit untouched.
 * Uniforms: `uHdr`, `uBloom`, `uAo`, `uExposure`, `uBloomStrength`, `uBloomScale`,
 * `uAoStrength`, `uSaturation`, `uContrast`, `uVignette`, `uGrain`, `uChromatic`,
 * `uSpeedBlur`, `uDamage`, `uDeath`, `uRain`, `uWetness`, `uTonemap`, `uTime`, `uAspect`.
 * @type {string}
 */
const FRAGMENT_COMPOSITE = GLSL_HASH + GLSL_LUMA + `
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uHdr;
uniform sampler2D uBloom;
uniform sampler2D uAo;

uniform float uExposure;
uniform float uBloomStrength;
uniform float uBloomScale;
uniform float uAoStrength;
uniform float uSaturation;
uniform float uContrast;
uniform float uVignette;
uniform float uGrain;
uniform float uChromatic;
uniform float uSpeedBlur;
uniform float uDamage;
uniform float uDeath;
uniform float uRain;
uniform float uWetness;
uniform float uTonemap;
uniform float uTime;
uniform float uAspect;

/* --- ACES (Stephen Hill's fit of the RRT + ODT, sRGB primaries) ------------- */
const mat3 ACES_INPUT = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777);
const mat3 ACES_OUTPUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602);

vec3 rrtOdtFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 acesFilmic(vec3 color) {
  vec3 c = ACES_INPUT * max(color, vec3(0.0));
  c = rrtOdtFit(c);
  return clamp(ACES_OUTPUT * c, 0.0, 1.0);
}

/* --- linear -> sRGB (exact piecewise transfer curve) ------------------------ */
vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

/* --- scene fetch: radial speed blur, then edge-only chromatic aberration ----- */
vec3 sceneAt(vec2 uv) { return texture(uHdr, uv).rgb; }

vec3 sceneBlurred(vec2 uv) {
  if (uSpeedBlur <= 0.0) return sceneAt(uv);
  vec2 dir = (uv - vec2(0.5)) * (uSpeedBlur * 0.11);
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < MB_TAPS; i++) {
    float t = float(i) / float(MB_TAPS - 1);
    float w = 1.0 - 0.72 * t;
    acc += sceneAt(clamp(uv - dir * t, vec2(0.0), vec2(1.0))) * w;
    wsum += w;
  }
  return acc / wsum;
}

vec3 sceneFetch(vec2 uv, float radial) {
  if (uChromatic <= 0.0) return sceneBlurred(uv);
  // Edge-only: the split grows with the squared distance from the centre.
  vec2 dir = (uv - vec2(0.5));
  vec2 offset = dir * (uChromatic * radial * radial * 0.024);
  vec3 col;
  col.r = sceneBlurred(clamp(uv + offset, vec2(0.0), vec2(1.0))).r;
  col.g = sceneBlurred(uv).g;
  col.b = sceneBlurred(clamp(uv - offset, vec2(0.0), vec2(1.0))).b;
  return col;
}

/* --- animated rain / wet lens ---------------------------------------------- */

/** One layer of falling streaks; returns (highlight, du, dv). */
vec3 rainLayer(vec2 uv, float scale, float speed, float seed) {
  vec2 p = vec2(uv.x * scale * uAspect, uv.y * scale * 0.22 - uTime * speed);
  vec2 cell = floor(p);
  vec2 f = fract(p);
  vec2 rnd = hash22(cell + seed);
  float alive = step(0.62, rnd.x);
  float cx = 0.25 + 0.5 * rnd.y;
  float dx = abs(f.x - cx);
  float body = smoothstep(0.09, 0.0, dx);
  float tail = smoothstep(0.0, 0.35, f.y) * smoothstep(1.0, 0.55, f.y);
  float streak = alive * body * tail;
  float slope = (f.x - cx) * body * alive;
  return vec3(streak, slope * 0.35, streak * 0.25);
}

/** Slow fat droplets clinging to the lens; returns (highlight, du, dv). */
vec3 dropLayer(vec2 uv, float scale, float seed) {
  vec2 p = vec2(uv.x * uAspect, uv.y) * scale;
  vec2 cell = floor(p);
  vec2 f = fract(p) - 0.5;
  vec2 rnd = hash22(cell + seed);
  float alive = step(0.55, rnd.x);
  vec2 c = (rnd - 0.5) * 0.55;
  c.y += sin(uTime * (0.35 + rnd.y * 0.5) + rnd.x * 6.28) * 0.06;
  float d = length(f - c);
  float drop = alive * smoothstep(0.26, 0.05, d);
  vec2 grad = (f - c) * drop;
  return vec3(drop, grad.x, grad.y);
}

void main() {
  vec2 uv = vUv;
  vec2 centred = (vUv - 0.5) * vec2(uAspect, 1.0);
  float radial = clamp(length(centred) * 1.42, 0.0, 2.0);

  // Wet-lens refraction has to happen before the scene is sampled.
  float wetAmount = max(uRain, uWetness);
  vec3 rain = vec3(0.0);
  if (wetAmount > 0.0) {
    vec3 l0 = rainLayer(vUv, 34.0, 1.35, 0.0);
    vec3 l1 = rainLayer(vUv, 19.0, 0.85, 7.31);
    vec3 dr = dropLayer(vUv, 11.0, 3.17);
    rain = l0 * (0.6 * uRain) + l1 * (0.75 * uRain) + dr * (0.5 * wetAmount);
    uv = clamp(uv + rain.yz * (0.02 * wetAmount), vec2(0.0), vec2(1.0));
  }

  vec3 color = sceneFetch(uv, radial) * uExposure;

  if (uBloomStrength > 0.0) {
    color += texture(uBloom, uv).rgb * (uBloomScale * uBloomStrength);
  }
  if (uAoStrength > 0.0) {
    float ao = texture(uAo, uv).r;
    color *= mix(1.0, ao, uAoStrength);
  }

  vec3 mapped = uTonemap > 0.5 ? acesFilmic(color) : clamp(color, 0.0, 1.0);

  // Grading: saturation around luminance, contrast around mid grey.
  if (uSaturation != 1.0) mapped = mix(vec3(luma(mapped)), mapped, uSaturation);
  if (uContrast != 1.0) mapped = (mapped - 0.5) * uContrast + 0.5;
  mapped = max(mapped, vec3(0.0));

  // Rain highlights sit on top of the graded image so they read as lens water, not scene light.
  if (wetAmount > 0.0) {
    mapped += vec3(0.55, 0.62, 0.72) * rain.x * 0.35;
    mapped = mix(mapped, mapped * 0.92 + vec3(0.02, 0.025, 0.03), uRain * 0.5);
  }

  // Damage flash: red, strongest at the screen edges.
  if (uDamage > 0.0) {
    float edge = 0.25 + 0.75 * smoothstep(0.2, 1.0, radial);
    mapped = mix(mapped, vec3(0.62, 0.02, 0.03), clamp(uDamage, 0.0, 1.0) * edge * 0.85);
  }

  // Death: desaturate and sink to black.
  if (uDeath > 0.0) {
    float f = clamp(uDeath, 0.0, 1.0);
    mapped = mix(mapped, vec3(luma(mapped)), clamp(f * 1.2, 0.0, 1.0));
    mapped *= mix(1.0, 0.18, f);
  }

  if (uVignette > 0.0) {
    float v = smoothstep(1.02, 0.34, radial);
    mapped *= mix(1.0, v, clamp(uVignette, 0.0, 1.0));
  }

  if (uGrain > 0.0) {
    float n = hash12(gl_FragCoord.xy + vec2(uTime * 137.13, uTime * 71.77)) - 0.5;
    // Slightly heavier in the shadows, where sensor noise actually lives.
    mapped += n * uGrain * (0.35 + 0.65 * (1.0 - luma(mapped)));
  }

  fragColor = vec4(linearToSrgb(mapped), 1.0);
}
`;

/* -------------------------------------------------------------------------- */
/* FXAA                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * FXAA 3.11 (Timothy Lottes) quality preset 12, ported to GLSL ES 3.00. Runs on the final
 * sRGB-encoded image; flat regions take the early-out branch and are returned untouched.
 * Uniforms: `uSource`, `uTexel`, `uQuality` (subpix, edgeThreshold, edgeThresholdMin).
 * @type {string}
 */
const FRAGMENT_FXAA = `
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uTexel;
uniform vec3 uQuality;

const int FXAA_STEPS = 12;
const float FXAA_STEP[12] = float[12](
  1.0, 1.0, 1.0, 1.0, 1.0, 1.5, 2.0, 2.0, 2.0, 2.0, 4.0, 8.0);

float fxaaLuma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec2 posM = vUv;
  vec3 rgbM = texture(uSource, posM).rgb;
  float lumaM = fxaaLuma(rgbM);
  float lumaN = fxaaLuma(textureOffset(uSource, posM, ivec2( 0,  1)).rgb);
  float lumaS = fxaaLuma(textureOffset(uSource, posM, ivec2( 0, -1)).rgb);
  float lumaE = fxaaLuma(textureOffset(uSource, posM, ivec2( 1,  0)).rgb);
  float lumaW = fxaaLuma(textureOffset(uSource, posM, ivec2(-1,  0)).rgb);

  float rangeMin = min(lumaM, min(min(lumaN, lumaS), min(lumaE, lumaW)));
  float rangeMax = max(lumaM, max(max(lumaN, lumaS), max(lumaE, lumaW)));
  float range = rangeMax - rangeMin;
  if (range < max(uQuality.z, rangeMax * uQuality.y)) {
    fragColor = vec4(rgbM, 1.0);
    return;
  }

  float lumaNW = fxaaLuma(textureOffset(uSource, posM, ivec2(-1,  1)).rgb);
  float lumaNE = fxaaLuma(textureOffset(uSource, posM, ivec2( 1,  1)).rgb);
  float lumaSW = fxaaLuma(textureOffset(uSource, posM, ivec2(-1, -1)).rgb);
  float lumaSE = fxaaLuma(textureOffset(uSource, posM, ivec2( 1, -1)).rgb);

  float lumaNS = lumaN + lumaS;
  float lumaWE = lumaW + lumaE;
  float subpixRcpRange = 1.0 / range;
  float subpixNSWE = lumaNS + lumaWE;
  float edgeHorz1 = (-2.0 * lumaM) + lumaNS;
  float edgeVert1 = (-2.0 * lumaM) + lumaWE;

  float lumaNESE = lumaNE + lumaSE;
  float lumaNWNE = lumaNW + lumaNE;
  float edgeHorz2 = (-2.0 * lumaE) + lumaNESE;
  float edgeVert2 = (-2.0 * lumaN) + lumaNWNE;

  float lumaNWSW = lumaNW + lumaSW;
  float lumaSWSE = lumaSW + lumaSE;
  float edgeHorz4 = (abs(edgeHorz1) * 2.0) + abs(edgeHorz2);
  float edgeVert4 = (abs(edgeVert1) * 2.0) + abs(edgeVert2);
  float edgeHorz3 = (-2.0 * lumaW) + lumaNWSW;
  float edgeVert3 = (-2.0 * lumaS) + lumaSWSE;
  float edgeHorz = abs(edgeHorz3) + edgeHorz4;
  float edgeVert = abs(edgeVert3) + edgeVert4;

  float subpixNWSWNESE = lumaNWSW + lumaNESE;
  bool horzSpan = edgeHorz >= edgeVert;
  float lengthSign = horzSpan ? uTexel.y : uTexel.x;
  float subpixA = subpixNSWE * 2.0 + subpixNWSWNESE;
  if (!horzSpan) {
    lumaN = lumaW;
    lumaS = lumaE;
  }
  float subpixB = (subpixA * (1.0 / 12.0)) - lumaM;

  float gradientN = lumaN - lumaM;
  float gradientS = lumaS - lumaM;
  float lumaNN = lumaN + lumaM;
  float lumaSS = lumaS + lumaM;
  bool pairN = abs(gradientN) >= abs(gradientS);
  float gradient = max(abs(gradientN), abs(gradientS));
  if (pairN) lengthSign = -lengthSign;
  float subpixC = clamp(abs(subpixB) * subpixRcpRange, 0.0, 1.0);

  vec2 posB = posM;
  vec2 offNP = horzSpan ? vec2(uTexel.x, 0.0) : vec2(0.0, uTexel.y);
  if (horzSpan) posB.y += lengthSign * 0.5;
  else posB.x += lengthSign * 0.5;

  vec2 posN = posB - offNP * FXAA_STEP[0];
  vec2 posP = posB + offNP * FXAA_STEP[0];
  float subpixD = (-2.0 * subpixC) + 3.0;
  float subpixE = subpixC * subpixC;
  if (!pairN) lumaNN = lumaSS;
  float gradientScaled = gradient * 0.25;
  float lumaMM = lumaM - lumaNN * 0.5;
  float subpixF = subpixD * subpixE;
  bool lumaMLTZero = lumaMM < 0.0;

  float lumaEndN = fxaaLuma(texture(uSource, posN).rgb) - lumaNN * 0.5;
  float lumaEndP = fxaaLuma(texture(uSource, posP).rgb) - lumaNN * 0.5;
  bool doneN = abs(lumaEndN) >= gradientScaled;
  bool doneP = abs(lumaEndP) >= gradientScaled;

  for (int i = 1; i < FXAA_STEPS; i++) {
    if (doneN && doneP) break;
    if (!doneN) {
      posN -= offNP * FXAA_STEP[i];
      lumaEndN = fxaaLuma(texture(uSource, posN).rgb) - lumaNN * 0.5;
      doneN = abs(lumaEndN) >= gradientScaled;
    }
    if (!doneP) {
      posP += offNP * FXAA_STEP[i];
      lumaEndP = fxaaLuma(texture(uSource, posP).rgb) - lumaNN * 0.5;
      doneP = abs(lumaEndP) >= gradientScaled;
    }
  }

  float dstN = horzSpan ? (posM.x - posN.x) : (posM.y - posN.y);
  float dstP = horzSpan ? (posP.x - posM.x) : (posP.y - posM.y);
  bool goodSpanN = (lumaEndN < 0.0) != lumaMLTZero;
  bool goodSpanP = (lumaEndP < 0.0) != lumaMLTZero;
  float spanLength = dstP + dstN;
  float spanLengthRcp = 1.0 / max(spanLength, 1e-6);
  bool directionN = dstN < dstP;
  float dst = min(dstN, dstP);
  bool goodSpan = directionN ? goodSpanN : goodSpanP;
  float subpixG = subpixF * subpixF;
  float pixelOffset = (dst * -spanLengthRcp) + 0.5;
  float subpixH = subpixG * uQuality.x;
  float pixelOffsetGood = goodSpan ? pixelOffset : 0.0;
  float pixelOffsetSubpix = max(pixelOffsetGood, subpixH);

  if (horzSpan) posM.y += pixelOffsetSubpix * lengthSign;
  else posM.x += pixelOffsetSubpix * lengthSign;

  fragColor = vec4(texture(uSource, posM).rgb, 1.0);
}
`;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Halves a dimension, rounding up so odd sizes never lose their last row/column and
 * never collapse below one texel.
 * @param {number} v Size in pixels.
 * @returns {number} Halved size, at least 1.
 */
function halfSize(v) {
  return Math.max(1, Math.ceil(v * 0.5));
}

/**
 * Returns a finite number or the fallback.
 * @param {*} v Candidate value.
 * @param {number} fallback Value used when `v` is not a finite number.
 * @returns {number} Resolved number.
 */
function num(v, fallback) {
  return typeof v === 'number' && isFinite(v) ? v : fallback;
}

/* -------------------------------------------------------------------------- */
/* PostFX                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The HDR resolve chain. One instance is owned by the renderer; it never changes the bound
 * framebuffer or viewport as observed by its caller.
 */
export class PostFX {
  /**
   * @param {WebGL2RenderingContext} gl Context.
   * @param {Object} [renderer] Owning renderer. Only `quality` (`{name, bloom, ssao}`),
   *   `renderWidth` and `renderHeight` are read, so a plain object works in tests.
   */
  constructor(gl, renderer) {
    /** @type {WebGL2RenderingContext} */
    this.gl = gl;
    /** @type {Object|null} */
    this.renderer = renderer || null;
    /** @type {boolean} */
    this.disposed = false;

    /** @type {number} Output width in pixels (the viewport post FX resolves into). */
    this.width = 1;
    /** @type {number} Output height in pixels. */
    this.height = 1;
    /** @type {number} Working width (the renderer's internal resolution). */
    this.procWidth = 1;
    /** @type {number} Working height. */
    this.procHeight = 1;

    /** @type {number} Seconds accumulated from `render(dt)`, drives grain and rain. */
    this.time = 0;
    /** @type {{drawCalls: number, passes: number}} */
    this.stats = { drawCalls: 0, passes: 0 };

    /**
     * Per-pass master switches. Quality presets narrow these further; setting one to false
     * removes the pass entirely (so `low` really is just tonemap + FXAA).
     * @type {{ssao: boolean, bloom: boolean, fxaa: boolean, tonemap: boolean, grade: boolean,
     *   vignette: boolean, grain: boolean, chromatic: boolean, rain: boolean,
     *   damage: boolean, motionBlur: boolean}}
     */
    this.enabled = {
      ssao: true,
      bloom: true,
      fxaa: true,
      tonemap: true,
      grade: true,
      vignette: true,
      grain: true,
      chromatic: true,
      rain: true,
      damage: true,
      motionBlur: true
    };

    /** @type {{ssao: boolean, bloom: boolean, fxaa: boolean, motionBlur: boolean}} */
    this._q = { ssao: true, bloom: true, fxaa: true, motionBlur: true };

    /** @type {Object<string, number>} Resolved parameters of the current frame (reused). */
    this.params = {};
    for (let i = 0; i < PARAM_KEYS.length; i++) this.params[PARAM_KEYS[i]] = POSTFX_DEFAULTS[PARAM_KEYS[i]];

    /* ---- tunables that gameplay code may poke ---- */
    /** @type {number} SSAO hemisphere radius in metres. */
    this.aoRadius = 0.65;
    /** @type {number} SSAO depth bias in metres. */
    this.aoBias = 0.025;
    /** @type {number} SSAO occlusion strength before the power curve. */
    this.aoIntensity = 1.15;
    /** @type {number} SSAO contrast curve. */
    this.aoPower = 1.6;
    /**
     * @type {number} How much AO the composite applies on top of the renderer's ambient term.
     * The renderer already multiplies ambient by `aoTexture`, so this stays subtle; set it to 0
     * to leave AO entirely to the lighting pass.
     */
    this.aoComposite = 0.45;
    /** @type {number} Bloom tent-filter radius in source texels. */
    this.bloomRadius = 1.15;
    /**
     * @type {number} How much of each upsampled mip is mixed into the next larger one (0..1).
     * Higher scatters light further; the lerp keeps the chain energy-normalised.
     */
    this.bloomScatter = 0.68;
    /** @type {number} FXAA subpixel aliasing removal (0..1). */
    this.fxaaSubpix = 0.75;
    /** @type {number} FXAA edge threshold. */
    this.fxaaEdgeThreshold = 0.125;
    /** @type {number} FXAA darkness threshold below which pixels are skipped. */
    this.fxaaEdgeThresholdMin = 0.0312;

    /* ---- GPU resources ---- */
    /** @type {RenderTarget[]} Bloom mip chain, index 0 = half resolution. */
    this._bloom = [];
    /** @type {number[]} Flat `[w0,h0,w1,h1,...]` of the current chain. */
    this._bloomSizes = [];
    /** @type {number} Number of live bloom mips. */
    this.bloomLevels = 0;
    /** @type {RenderTarget|null} Raw SSAO. */
    this._aoRaw = null;
    /** @type {RenderTarget|null} Blurred SSAO (published as `aoTexture`). */
    this._aoBlur = null;
    /** @type {RenderTarget|null} sRGB composite buffer consumed by FXAA. */
    this._ldr = null;
    /** @type {Texture2D|null} Screen-space AO for the renderer's PBR pass, or null. */
    this.aoTexture = null;
    /** @type {boolean} True while the AO target still holds stale data. */
    this._aoDirty = true;
    /** @type {boolean} False when the driver forced the bloom chain into RGBA8. */
    this.floatTargets = true;
    /** @type {number} Encode scale applied by the bright pass (1 for float targets). */
    this.bloomEncodeScale = 1;

    /** @type {Float32Array} Hemisphere kernel, `SSAO_SAMPLES * 3` floats. */
    this._kernel = this._buildKernel();

    this._createShaders();

    /** @type {Texture2D} 1x1 white stand-in bound when AO is off. */
    this._white = Texture2D.solid(gl, 255, 255, 255, 255);
    /** @type {Texture2D} 1x1 black stand-in bound when bloom is off. */
    this._black = Texture2D.solid(gl, 0, 0, 0, 255);

    const r = this.renderer;
    const w = r && num(r.width, 0) > 0 ? r.width : 1;
    const h = r && num(r.height, 0) > 0 ? r.height : 1;
    this.resize(w, h);
  }

  /* ------------------------------------------------------------- construction */

  /**
   * Builds the deterministic SSAO hemisphere kernel (seeded `Rand`, never `Math.random`).
   * Samples cluster towards the origin so near-field contact shadows dominate.
   * @returns {Float32Array} Packed xyz triplets.
   * @private
   */
  _buildKernel() {
    const rng = new Rand(0x5eed ^ SSAO_SAMPLES);
    const kernel = new Float32Array(SSAO_SAMPLES * 3);
    for (let i = 0; i < SSAO_SAMPLES; i++) {
      let x = rng.range(-1, 1);
      let y = rng.range(-1, 1);
      let z = rng.range(0.18, 1);
      const len = Math.sqrt(x * x + y * y + z * z) || 1;
      x /= len;
      y /= len;
      z /= len;
      const t = i / SSAO_SAMPLES;
      const scale = (0.1 + 0.9 * t * t) * (0.4 + 0.6 * rng.next());
      kernel[i * 3] = x * scale;
      kernel[i * 3 + 1] = y * scale;
      kernel[i * 3 + 2] = z * scale;
    }
    return kernel;
  }

  /**
   * Compiles every pass. Failures propagate so the renderer can fall back to its plain blit.
   * @returns {void}
   * @private
   */
  _createShaders() {
    const gl = this.gl;
    /** @type {Shader} */
    this.ssaoShader = new Shader(gl, VERTEX_FULLSCREEN, FRAGMENT_SSAO,
      { SSAO_SAMPLES }, 'postfx/ssao');
    /** @type {Shader} */
    this.aoBlurShader = new Shader(gl, VERTEX_FULLSCREEN, FRAGMENT_AO_BLUR, {}, 'postfx/ao-blur');
    /** @type {Shader} */
    this.brightShader = new Shader(gl, VERTEX_FULLSCREEN, FRAGMENT_BRIGHT, {}, 'postfx/bright');
    /** @type {Shader} */
    this.downsampleShader = new Shader(gl, VERTEX_FULLSCREEN, FRAGMENT_DOWNSAMPLE, {}, 'postfx/downsample');
    /** @type {Shader} */
    this.upsampleShader = new Shader(gl, VERTEX_FULLSCREEN, FRAGMENT_UPSAMPLE, {}, 'postfx/upsample');
    /** @type {Shader} */
    this.compositeShader = new Shader(gl, VERTEX_FULLSCREEN, FRAGMENT_COMPOSITE,
      { MB_TAPS: MOTION_BLUR_TAPS }, 'postfx/composite');
    /** @type {Shader} */
    this.fxaaShader = new Shader(gl, VERTEX_FULLSCREEN, FRAGMENT_FXAA, {}, 'postfx/fxaa');
  }

  /* ------------------------------------------------------------------ sizing */

  /**
   * Reallocates every internal target. `w`/`h` are the *output* (canvas) size; the working
   * resolution of SSAO and bloom follows the renderer's internal resolution when it exposes
   * one, so `renderScale` is honoured. Odd sizes are halved with a ceiling so nothing is lost.
   * @param {number} w Output width in pixels.
   * @param {number} h Output height in pixels.
   * @returns {void}
   */
  resize(w, h) {
    if (this.disposed) return;
    const width = Math.max(1, w | 0);
    const height = Math.max(1, h | 0);
    const r = this.renderer;
    let procW = width;
    let procH = height;
    if (r && num(r.renderWidth, 0) > 0 && num(r.renderHeight, 0) > 0) {
      procW = Math.max(1, r.renderWidth | 0);
      procH = Math.max(1, r.renderHeight | 0);
    }
    if (width === this.width && height === this.height &&
      procW === this.procWidth && procH === this.procHeight && this._ldr) {
      return;
    }
    this.width = width;
    this.height = height;
    this.procWidth = procW;
    this.procHeight = procH;
    this._allocate();
  }

  /**
   * Creates or resizes the bloom chain, the AO pair and the sRGB composite buffer.
   * @returns {void}
   * @private
   */
  _allocate() {
    const gl = this.gl;
    this._syncQuality();

    // ---- bloom chain: half resolution, then successive halves down to MIN_BLOOM_SIZE ----
    const sizes = this._bloomSizes;
    sizes.length = 0;
    let bw = halfSize(this.procWidth);
    let bh = halfSize(this.procHeight);
    for (let i = 0; i < MAX_BLOOM_LEVELS; i++) {
      sizes.push(bw, bh);
      const nw = halfSize(bw);
      const nh = halfSize(bh);
      if (nw < MIN_BLOOM_SIZE || nh < MIN_BLOOM_SIZE || (nw === bw && nh === bh)) break;
      bw = nw;
      bh = nh;
    }
    const levels = sizes.length >> 1;
    while (this._bloom.length > levels) {
      const rt = this._bloom.pop();
      if (rt) rt.dispose();
    }
    for (let i = 0; i < levels; i++) {
      const w = sizes[i * 2];
      const h = sizes[i * 2 + 1];
      if (!this._bloom[i]) {
        this._bloom[i] = new RenderTarget(gl, w, h, {
          colorFormat: 'rgba16f',
          depth: false,
          filter: 'linear',
          wrap: 'clamp'
        });
      } else {
        this._bloom[i].resize(w, h);
      }
    }
    this.bloomLevels = levels;
    // EXT_color_buffer_float missing: RenderTarget degraded us to RGBA8, so the bright pass
    // has to scale the HDR range down into [0,1] and the composite scales it back up.
    this.floatTargets = levels > 0 ? this._bloom[0].colorFormats[0] !== 'rgba8' : true;
    this.bloomEncodeScale = this.floatTargets ? 1 : 1 / LDR_BLOOM_SCALE;

    // ---- SSAO pair at half the working resolution ----
    if (this._q.ssao) this._allocateAo();
    else this._releaseAo();

    // ---- sRGB composite buffer feeding FXAA ----
    if (!this._ldr) {
      this._ldr = new RenderTarget(gl, this.width, this.height, {
        colorFormat: 'rgba8', depth: false, filter: 'linear', wrap: 'clamp'
      });
    } else {
      this._ldr.resize(this.width, this.height);
    }
  }

  /**
   * Creates (or resizes) the SSAO pair at half the working resolution and publishes
   * `aoTexture` for the renderer's lighting pass.
   * @returns {void}
   * @private
   */
  _allocateAo() {
    const gl = this.gl;
    const aw = halfSize(this.procWidth);
    const ah = halfSize(this.procHeight);
    if (!this._aoRaw) {
      this._aoRaw = new RenderTarget(gl, aw, ah, {
        colorFormat: 'r8', depth: false, filter: 'linear', wrap: 'clamp', clearColor: [1, 1, 1, 1]
      });
    } else {
      this._aoRaw.resize(aw, ah);
    }
    if (!this._aoBlur) {
      this._aoBlur = new RenderTarget(gl, aw, ah, {
        colorFormat: 'r8', depth: false, filter: 'linear', wrap: 'clamp', clearColor: [1, 1, 1, 1]
      });
    } else {
      this._aoBlur.resize(aw, ah);
    }
    this.aoTexture = this._aoBlur.color(0);
    this._aoDirty = true;
    this._clearAo();
  }

  /**
   * Drops the SSAO targets and stops publishing `aoTexture`.
   * @returns {void}
   * @private
   */
  _releaseAo() {
    if (this._aoRaw) {
      this._aoRaw.dispose();
      this._aoRaw = null;
    }
    if (this._aoBlur) {
      this._aoBlur.dispose();
      this._aoBlur = null;
    }
    this.aoTexture = null;
  }

  /**
   * Fills the AO targets with white so the lighting pass never reads uninitialised memory
   * before the first SSAO pass has run. Restores the previously bound framebuffer.
   * @returns {void}
   * @private
   */
  _clearAo() {
    if (!this._aoBlur || !this._aoRaw) return;
    const gl = this.gl;
    const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    this._aoRaw.bind(true);
    this._aoBlur.bind(true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
    gl.viewport(0, 0, this.width, this.height);
    this._aoDirty = false;
  }

  /* ----------------------------------------------------------------- quality */

  /**
   * Folds the renderer's quality preset into the per-pass switches. SSAO and bloom follow
   * `quality.ssao` / `quality.bloom`; the radial speed blur needs `medium` or better; FXAA
   * always runs because it is the cheapest quality win available.
   * @returns {void}
   * @private
   */
  _syncQuality() {
    const q = this.renderer && this.renderer.quality ? this.renderer.quality : null;
    const level = q && QUALITY_LEVEL[q.name] !== undefined ? QUALITY_LEVEL[q.name] : 2;
    this._q.ssao = !!this.enabled.ssao && (q ? !!q.ssao : true);
    this._q.bloom = !!this.enabled.bloom && (q ? q.bloom !== false : true);
    this._q.fxaa = !!this.enabled.fxaa;
    this._q.motionBlur = !!this.enabled.motionBlur && level >= 1;
    // Publishing (or hiding) aoTexture flips the renderer's SSAO shader permutation, so it
    // must follow the sticky quality flag rather than a per-frame parameter.
    if (this._q.ssao && !this._aoBlur) this._allocateAo();
    else if (!this._q.ssao && this._aoBlur) this._releaseAo();
  }

  /**
   * Turns a single pass on or off at runtime.
   * @param {string} name Key of {@link PostFX#enabled}.
   * @param {boolean} on True to enable.
   * @returns {void}
   */
  setEnabled(name, on) {
    if (!(name in this.enabled)) return;
    this.enabled[name] = !!on;
    this._syncQuality();
  }

  /**
   * Copies caller parameters over the defaults into the reusable frame parameter object.
   * @param {Object|null} params Values from `Renderer.postParams`.
   * @returns {Object<string, number>} `this.params`.
   * @private
   */
  _readParams(params) {
    const p = this.params;
    for (let i = 0; i < PARAM_KEYS.length; i++) {
      const key = PARAM_KEYS[i];
      p[key] = num(params ? params[key] : undefined, POSTFX_DEFAULTS[key]);
    }
    if (!this.enabled.grade) {
      p.saturation = 1;
      p.contrast = 1;
    }
    if (!this.enabled.vignette) p.vignette = 0;
    if (!this.enabled.grain) p.grain = 0;
    if (!this.enabled.chromatic) p.chromatic = 0;
    if (!this.enabled.rain) {
      p.rain = 0;
      p.wetness = 0;
    }
    if (!this.enabled.damage) {
      p.damageFlash = 0;
      p.deathFade = 0;
    }
    if (!this._q.motionBlur) p.speedBlur = 0;
    if (!this._q.bloom) p.bloomStrength = 0;
    if (!this._q.ssao) p.ssao = 0;
    return p;
  }

  /* ------------------------------------------------------------------ passes */

  /**
   * Issues one fullscreen triangle and books it in the stats.
   * @returns {void}
   * @private
   */
  _draw() {
    drawFullscreen(this.gl);
    this.stats.drawCalls++;
    this.stats.passes++;
  }

  /**
   * SSAO + bilateral blur into the published `aoTexture`.
   * @param {Object} depthTexture Sampleable depth texture of the HDR pass.
   * @param {Object} camera Active camera (needs `proj` and `invProj`).
   * @returns {void}
   * @private
   */
  _ssaoPass(depthTexture, camera) {
    const raw = this._aoRaw;
    const blur = this._aoBlur;
    const shader = this.ssaoShader;
    raw.bind(false);
    shader.use();
    shader.setTexture('uDepth', depthTexture, 0);
    shader.setMat4('uInvProj', camera.invProj);
    shader.setMat4('uProj', camera.proj);
    shader.setVec3Array('uKernel[0]', this._kernel);
    shader.setVec2('uDepthTexel', 1 / this.procWidth, 1 / this.procHeight);
    shader.setVec4('uParams', this.aoRadius, this.aoBias, this.aoIntensity, this.aoPower);
    this._draw();

    blur.bind(false);
    const blurShader = this.aoBlurShader;
    blurShader.use();
    blurShader.setTexture('uAo', raw.color(0), 0);
    blurShader.setTexture('uDepth', depthTexture, 1);
    blurShader.setMat4('uInvProj', camera.invProj);
    blurShader.setVec2('uTexel', 1 / raw.width, 1 / raw.height);
    blurShader.setFloat('uDepthSigma', 2.5);
    this._draw();
    this._aoDirty = false;
  }

  /**
   * Bright pass + progressive downsample + tent upsample accumulation.
   * Leaves the finished bloom in mip 0.
   * @param {Object} hdrTexture Scene colour texture.
   * @param {Object<string, number>} p Resolved frame parameters.
   * @returns {void}
   * @private
   */
  _bloomPass(hdrTexture, p) {
    const gl = this.gl;
    const chain = this._bloom;
    const levels = this.bloomLevels;

    // Bright pass: HDR -> mip 0 (half resolution).
    chain[0].bind(false);
    const bright = this.brightShader;
    bright.use();
    bright.setTexture('uSource', hdrTexture, 0);
    bright.setVec2('uTexel', 1 / this.procWidth, 1 / this.procHeight);
    bright.setVec4('uParams', p.exposure, Math.max(0, p.bloomThreshold),
      Math.max(1e-3, p.bloomThreshold * clamp(p.bloomKnee, 0.05, 1)), this.bloomEncodeScale);
    this._draw();

    // Downsample: 13 taps with a Karis average on the first step.
    const down = this.downsampleShader;
    down.use();
    for (let i = 1; i < levels; i++) {
      const src = chain[i - 1];
      chain[i].bind(false);
      down.setTexture('uSource', src.color(0), 0);
      down.setVec2('uTexel', 1 / src.width, 1 / src.height);
      down.setFloat('uKaris', i === 1 ? 1 : 0);
      this._draw();
    }

    // Upsample: 3x3 tent lerped back up the chain (dual filtering). The constant-colour blend
    // gives dst = tent(src) * scatter + dst * (1 - scatter), so the mip weights sum to 1.
    if (levels > 1) {
      const up = this.upsampleShader;
      up.use();
      const scatter = clamp(this.bloomScatter, 0.05, 0.95);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendColor(scatter, scatter, scatter, scatter);
      gl.blendFunc(gl.CONSTANT_COLOR, gl.ONE_MINUS_CONSTANT_COLOR);
      const radius = Math.max(0.25, this.bloomRadius * clamp(p.bloomRadius, 0.25, 4));
      for (let i = levels - 1; i > 0; i--) {
        const src = chain[i];
        chain[i - 1].bind(false);
        up.setTexture('uSource', src.color(0), 0);
        up.setVec2('uTexel', radius / src.width, radius / src.height);
        this._draw();
      }
      gl.disable(gl.BLEND);
    }
  }

  /**
   * Composite + FXAA into the caller's framebuffer.
   * @param {Object} hdrTexture Scene colour texture.
   * @param {Object<string, number>} p Resolved frame parameters.
   * @param {boolean} useBloom True when the bloom chain holds a fresh result.
   * @param {WebGLFramebuffer|null} outFbo Framebuffer bound when `render` was called.
   * @returns {void}
   * @private
   */
  _resolvePass(hdrTexture, p, useBloom, outFbo) {
    const gl = this.gl;
    const fxaa = this._q.fxaa && !!this._ldr;

    if (fxaa) {
      this._ldr.bind(false);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo);
      gl.viewport(0, 0, this.width, this.height);
    }

    const shader = this.compositeShader;
    shader.use();
    shader.setTexture('uHdr', hdrTexture, 0);
    shader.setTexture('uBloom', useBloom ? this._bloom[0].color(0) : this._black, 1);
    const aoOn = this._q.ssao && p.ssao > 0 && !!this.aoTexture && this.aoComposite > 0;
    shader.setTexture('uAo', aoOn ? this.aoTexture : this._white, 2);
    shader.setFloat('uExposure', Math.max(0, p.exposure));
    shader.setFloat('uBloomStrength', useBloom ? Math.max(0, p.bloomStrength) : 0);
    shader.setFloat('uBloomScale', this.floatTargets ? 1 : LDR_BLOOM_SCALE);
    shader.setFloat('uAoStrength', aoOn ? clamp(this.aoComposite * p.ssao, 0, 1) : 0);
    shader.setFloat('uSaturation', p.saturation);
    shader.setFloat('uContrast', p.contrast);
    shader.setFloat('uVignette', clamp(p.vignette, 0, 1));
    shader.setFloat('uGrain', Math.max(0, p.grain));
    shader.setFloat('uChromatic', Math.max(0, p.chromatic));
    shader.setFloat('uSpeedBlur', clamp(p.speedBlur, 0, 1));
    shader.setFloat('uDamage', clamp(p.damageFlash, 0, 1));
    shader.setFloat('uDeath', clamp(p.deathFade, 0, 1));
    shader.setFloat('uRain', clamp(p.rain, 0, 1));
    shader.setFloat('uWetness', clamp(p.wetness, 0, 1));
    shader.setFloat('uTonemap', this.enabled.tonemap ? 1 : 0);
    shader.setFloat('uTime', this.time);
    shader.setFloat('uAspect', this.width / Math.max(1, this.height));
    this._draw();

    if (!fxaa) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo);
    gl.viewport(0, 0, this.width, this.height);
    const aa = this.fxaaShader;
    aa.use();
    aa.setTexture('uSource', this._ldr.color(0), 0);
    aa.setVec2('uTexel', 1 / this._ldr.width, 1 / this._ldr.height);
    aa.setVec3('uQuality', this.fxaaSubpix, this.fxaaEdgeThreshold, this.fxaaEdgeThresholdMin);
    this._draw();
  }

  /**
   * Resolves the HDR scene into the framebuffer that is bound on entry (normally the default
   * one). The binding and the output viewport are restored before returning; no allocation
   * happens here.
   * @param {Object} hdrTexture HDR colour attachment of the scene pass (`Texture2D` or `{texture}`).
   * @param {Object|null} depthTexture Sampleable depth texture of the scene pass (SSAO input).
   * @param {Object|null} camera Active camera; SSAO needs `proj` / `invProj`.
   * @param {number} dt Seconds since the previous frame (drives grain and rain animation).
   * @param {Object|null} params Parameters, see {@link POSTFX_DEFAULTS}.
   * @returns {void}
   */
  render(hdrTexture, depthTexture, camera, dt, params) {
    if (this.disposed || !hdrTexture) return;
    const gl = this.gl;
    this._syncQuality();
    const p = this._readParams(params);
    this.time = (this.time + clamp(num(dt, 0), 0, 0.25)) % 3600;

    const outFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    this.stats.drawCalls = 0;
    this.stats.passes = 0;

    const useSsao = this._q.ssao && p.ssao > 0 && !!this._aoBlur && !!depthTexture &&
      !!camera && !!camera.proj && !!camera.invProj;
    if (useSsao) this._ssaoPass(depthTexture, camera);
    else if (this._aoBlur && this._aoDirty) this._clearAo();

    const useBloom = this._q.bloom && p.bloomStrength > 0 && this.bloomLevels > 0;
    if (useBloom) this._bloomPass(hdrTexture, p);

    this._resolvePass(hdrTexture, p, useBloom, outFbo);

    // Hand the caller's state back exactly as it was found.
    gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
  }

  /**
   * Releases every GPU resource owned by the post FX chain.
   * @returns {void}
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (let i = 0; i < this._bloom.length; i++) this._bloom[i].dispose();
    this._bloom.length = 0;
    this.bloomLevels = 0;
    this._releaseAo();
    if (this._ldr) {
      this._ldr.dispose();
      this._ldr = null;
    }
    if (this._white) this._white.dispose();
    if (this._black) this._black.dispose();
    this._white = null;
    this._black = null;
    const shaders = [this.ssaoShader, this.aoBlurShader, this.brightShader, this.downsampleShader,
      this.upsampleShader, this.compositeShader, this.fxaaShader];
    for (let i = 0; i < shaders.length; i++) {
      if (shaders[i]) shaders[i].dispose();
    }
    this.ssaoShader = null;
    this.aoBlurShader = null;
    this.brightShader = null;
    this.downsampleShader = null;
    this.upsampleShader = null;
    this.compositeShader = null;
    this.fxaaShader = null;
  }
}
