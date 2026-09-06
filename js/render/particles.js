/**
 * @file js/render/particles.js
 * NEON CITY billboard particle system (contract section 6).
 *
 * Design
 * ------
 * A fixed-capacity struct-of-arrays pool: one `Float32Array` per field, plus a dense live
 * range `[0, count)`. The tail `[count, capacity)` IS the free list — allocation pops from
 * it, death swaps the dead entry with the last live one and pushes it back. `spawn()` never
 * allocates and never grows; when the pool is saturated it recycles an old live particle of the
 * same kind, chosen by a rotating bounded sweep so the cost per spawn stays constant.
 *
 * Every frame `update()` runs the CPU simulation, classifies particles into the alpha and
 * additive sets, counting-sorts the alpha set back-to-front (sorting *indices*, never the
 * data) and packs both sets into one interleaved instance array which is uploaded with a
 * single `bufferSubData` over the live range only. `render()` then issues exactly two
 * instanced draw calls, one per blend mode.
 *
 * Rendering conventions other modules must honour:
 *  - `render(camera)` draws into whatever framebuffer is already bound and NEVER touches the
 *    viewport. It expects the HDR target bound, depth test enabled, and the scene depth
 *    already resolved. It leaves depth writes ON, blending OFF and back-face culling ON.
 *  - Output is premultiplied: `vec4(rgb * a, a)`. Alpha particles blend with
 *    `(ONE, ONE_MINUS_SRC_ALPHA)`, additive particles with `(ONE, ONE)`.
 *  - Colours are linear HDR radiance in the renderer's scale (a sunlit white surface is
 *    around 2.5), so emissive particles bloom naturally after the tonemap.
 *  - Soft particles need `setDepthTexture(tex, near, far)`, and the renderer owns that call:
 *    from the first one onward `null` means "no scene depth this frame", never "guess". Only
 *    a system nobody drives falls back to `renderer.hdr.depthTex` on its own.
 *    Sampling a texture that is still attached to the bound framebuffer is a feedback loop
 *    (Chrome raises INVALID_OPERATION even with depth writes off), so the first soft draw with
 *    any given texture is validated with `gl.getError()`: on failure the system transparently
 *    switches to blitting the depth buffer into a private copy, and only if that fails too
 *    does it give up. Either way a bad depth texture can never break a frame.
 *  - Point lights are requested through `onLight(x, y, z, r, g, b, radius, intensity)`, which
 *    defaults to `renderer.submitLight`. The renderer may replace it at any time.
 */

import { clamp, Rand } from '../core/math.js';
import { Shader, Texture2D, RenderTarget } from '../core/gl.js';

/* -------------------------------------------------------------------------- */
/* Layout constants                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Floats per instance in the interleaved buffer:
 * `[px, py, pz, size] [vx, vy, vz, rot] [r, g, b, a] [sprite, stretch, emissive, soft]`.
 * @type {number}
 */
const STRIDE = 16;

/** Byte stride of one instance. @type {number} */
const BYTE_STRIDE = STRIDE * 4;

/** Sprite atlas grid. @type {number} */
const ATLAS_COLS = 4;
/** Sprite atlas grid. @type {number} */
const ATLAS_ROWS = 4;
/** Atlas cell size in texels. @type {number} */
const ATLAS_CELL = 128;
/** Atlas width in texels. @type {number} */
const ATLAS_W = ATLAS_COLS * ATLAS_CELL;
/** Atlas height in texels. @type {number} */
const ATLAS_H = ATLAS_ROWS * ATLAS_CELL;

/** Sprite cell indices (row-major, row 0 at the top of the atlas). */
const SPR_SMOKE = 0;
const SPR_SPARK = 1;
const SPR_FLASH = 2;
const SPR_BLOOD = 3;
const SPR_GLASS = 4;
const SPR_RAIN = 5;
const SPR_MUZZLE = 6;
const SPR_DEBRIS = 7;
const SPR_EMBER = 8;
const SPR_LEAF = 9;
const SPR_SHELL = 10;
const SPR_SPLASH = 11;
const SPR_RING = 12;
const SPR_DUST = 13;
const SPR_STREAK = 14;
const SPR_SOFT = 15;

/** Particle is drawn in the additive pass. @type {number} */
const FLAG_ADDITIVE = 1;
/** Particle requests a point light every frame it is alive. @type {number} */
const FLAG_LIGHT = 2;
/** Particle bounces off its ground plane instead of sinking through it. @type {number} */
const FLAG_BOUNCE = 4;
/** Particle belongs to the persistent rain volume. @type {number} */
const FLAG_RAIN = 8;
/** Particle flutters sideways (leaves, paper). @type {number} */
const FLAG_FLUTTER = 16;

/** Number of buckets used by the back-to-front counting sort. @type {number} */
const SORT_BUCKETS = 1024;
/** Distances beyond this (metres) all land in the far-most sort bucket. @type {number} */
const SORT_RANGE = 320;

/** Largest `dt` a single simulation step will integrate, in seconds. @type {number} */
const MAX_STEP = 0.1;

/**
 * Slots examined per recycle when the pool is saturated. A full scan is O(live) per spawn,
 * which turns one saturated explosion into a multi-frame stall (4000 recycled spawns measured
 * at ~84 ms on SwiftShader); a bounded window whose cursor carries across calls walks the whole
 * pool over consecutive spawns instead, at a fixed cost each.
 * @type {number}
 */
const RECYCLE_WINDOW = 64;

/* -------------------------------------------------------------------------- */
/* Shaders                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Vertex stage. The quad has no vertex buffer at all: the four corners of a triangle strip
 * are derived from `gl_VertexID`, and every attribute is per-instance (divisor 1).
 * @type {string}
 */
const PARTICLE_VS = `
layout(location = 0) in vec4 aPosSize;   // xyz = world position, w = size (metres)
layout(location = 1) in vec4 aVelRot;    // xyz = velocity, w = roll (radians)
layout(location = 2) in vec4 aColor;     // linear rgb + alpha
layout(location = 3) in vec4 aParams;    // x = sprite cell, y = stretch, z = emissive, w = softness

uniform mat4 uViewProj;
uniform vec3 uCameraPos;
uniform vec3 uCameraRight;
uniform vec3 uCameraUp;

out vec2 vUv;
out vec2 vLocal;
out vec4 vColor;
out float vEmissive;
out float vSoft;
out vec3 vView;    // world-space camera -> particle centre (constant across the quad)

void main() {
  // 0 -> (0,0), 1 -> (1,0), 2 -> (0,1), 3 -> (1,1): a triangle strip quad.
  vec2 c = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vec2 corner = c - 0.5;
  vLocal = corner * 2.0;

  float cell = floor(aParams.x + 0.5);
  float col = mod(cell, float(ATLAS_COLS));
  float row = floor(cell / float(ATLAS_COLS));
  vec2 cellSize = vec2(1.0 / float(ATLAS_COLS), 1.0 / float(ATLAS_ROWS));
  // The atlas is uploaded unflipped, so texture row 0 is the top of cell row 0.
  vUv = (vec2(col + c.x, row + (1.0 - c.y))) * cellSize;

  vec3 center = aPosSize.xyz;
  float size = max(aPosSize.w, 0.0);
  float stretch = aParams.y;

  vec3 world;
  if (stretch > 0.0001) {
    // Velocity stretched billboard: local +Y follows the velocity, local X stays screen aligned.
    vec3 vel = aVelRot.xyz;
    float vlen = length(vel);
    vec3 axis = vlen > 1e-4 ? vel / vlen : uCameraUp;
    vec3 side = cross(axis, uCameraPos - center);
    float sideLen = length(side);
    side = sideLen > 1e-5 ? side / sideLen : uCameraRight;
    float total = size + vlen * stretch;
    float head = size * 0.5;
    float tail = total - head;
    world = center + side * (corner.x * size) + axis * mix(-tail, head, c.y);
  } else {
    float s = sin(aVelRot.w);
    float co = cos(aVelRot.w);
    vec2 rc = vec2(corner.x * co - corner.y * s, corner.x * s + corner.y * co);
    world = center + (uCameraRight * rc.x + uCameraUp * rc.y) * size;
  }

  vColor = aColor;
  vEmissive = aParams.z;
  vSoft = aParams.w;
  vView = center - uCameraPos;
  gl_Position = uViewProj * vec4(world, 1.0);
}
`;

/**
 * Fragment stage: atlas lookup, cheap hemispheric + sun lighting on a fake spherical normal,
 * emissive override, exponential fog matched to the scene, optional soft-particle depth fade
 * and a near-camera fade so puffs never fill the screen.
 * @type {string}
 */
const PARTICLE_FS = `
in vec2 vUv;
in vec2 vLocal;
in vec4 vColor;
in float vEmissive;
in float vSoft;
in vec3 vView;

uniform sampler2D uAtlas;
uniform vec3 uCameraPos;
uniform vec3 uCameraRight;
uniform vec3 uCameraUp;
uniform vec3 uCameraForward;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;      // sun radiance (colour * intensity), same scale as the PBR pass
uniform vec3 uAmbientSky;
uniform vec3 uAmbientGround;
uniform vec3 uFogColor;
uniform vec4 uFogParams;     // x = density, y = height falloff, z = sun scatter, w = unused
uniform float uAdditive;
uniform vec2 uNearFade;

/**
 * Analytic height fog: the same integral render/shaders.js (GLSL_FOG) uses for the scene.
 * Matching it matters: a plume high above the street would otherwise be fogged with a flat
 * distance term while the buildings behind it use the height-attenuated one.
 */
float fogAmount(vec3 camPos, vec3 worldPos, vec2 params) {
  vec3 d = worldPos - camPos;
  float dist = length(d);
  if (dist < 1e-4 || params.x <= 0.0) return 0.0;
  float hf = params.y;
  float t;
  if (hf < 1e-4) {
    t = params.x * dist;
  } else {
    float dy = d.y;
    float ec = exp(-hf * camPos.y);
    if (abs(dy) < 1e-3) {
      t = params.x * dist * ec;
    } else {
      float ew = exp(-hf * worldPos.y);
      t = params.x * dist * (ec - ew) / (hf * dy);
    }
  }
  return 1.0 - exp(-max(t, 0.0));
}

#if SOFT_PARTICLES
uniform sampler2D uDepthTex;
uniform vec2 uDepthPlanes;   // near, far
uniform float uSoftDistance;

/**
 * Converts a window-space depth sample into a positive eye-space distance.
 */
float linearizeDepth(float d) {
  float n = uDepthPlanes.x;
  float f = uDepthPlanes.y;
  float z = d * 2.0 - 1.0;
  return (2.0 * n * f) / (f + n - z * (f - n));
}
#endif

out vec4 fragColor;

void main() {
  vec4 texel = texture(uAtlas, vUv);
  float alpha = texel.a * vColor.a;
  float dist = length(vView);

  // Fade out anything hugging the near plane instead of smearing it over the whole screen.
  alpha *= clamp((dist - uNearFade.x) / max(uNearFade.y, 1e-4), 0.0, 1.0);

#if SOFT_PARTICLES
  if (vSoft > 0.001) {
    vec2 duv = gl_FragCoord.xy / vec2(textureSize(uDepthTex, 0));
    float sceneZ = linearizeDepth(texture(uDepthTex, duv).r);
    float partZ = linearizeDepth(gl_FragCoord.z);
    float fade = clamp((sceneZ - partZ) / max(uSoftDistance * vSoft, 1e-3), 0.0, 1.0);
    alpha *= fade;
  }
#endif

  if (alpha < 0.0025) discard;

  vec3 albedo = texel.rgb * vColor.rgb;

  // Fake spherical normal so round puffs get a believable terminator for free.
  float r2 = min(dot(vLocal, vLocal), 1.0);
  vec3 n = normalize(uCameraRight * vLocal.x + uCameraUp * vLocal.y - uCameraForward * sqrt(1.0 - r2));
  float wrap = dot(n, uSunDirection) * 0.5 + 0.5;
  vec3 ambient = mix(uAmbientGround, uAmbientSky, n.y * 0.5 + 0.5);
  vec3 lit = albedo * (ambient + uSunColor * 0.35 * wrap * wrap);

  float e = clamp(vEmissive, 0.0, 1.0);
  vec3 color = mix(lit, albedo * (1.0 + vEmissive * 2.0), e);

  float fog = fogAmount(uCameraPos, uCameraPos + vView, uFogParams.xy);
  if (fog > 0.0) {
    // Same aerial-perspective sun tint as the opaque pass, so a puff and the wall behind it
    // fade into the identical colour.
    vec3 viewDir = vView / max(dist, 1e-4);
    float sunAmount = clamp(dot(viewDir, uSunDirection), 0.0, 1.0);
    vec3 fogCol = mix(uFogColor, uFogColor + uSunColor * 0.35, pow(sunAmount, 8.0) * uFogParams.z);
    // Additive light is only attenuated by fog; it never picks the fog colour up.
    color = uAdditive > 0.5 ? color * (1.0 - fog) : mix(color, fogCol, fog);
  }

  fragColor = vec4(color * alpha, alpha);
}
`;

/* -------------------------------------------------------------------------- */
/* Procedural sprite atlas                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Integer hash used by the value noise below.
 * @param {number} x Lattice X.
 * @param {number} y Lattice Y.
 * @param {number} s Seed.
 * @returns {number} Value in [0, 1).
 */
function hash2(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Smoothstep helper local to the atlas generator.
 * @param {number} e0 Lower edge.
 * @param {number} e1 Upper edge.
 * @param {number} x Value.
 * @returns {number} Smoothly interpolated 0..1.
 */
function sstep(e0, e1, x) {
  if (e1 === e0) return x < e0 ? 0 : 1;
  let t = (x - e0) / (e1 - e0);
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return t * t * (3 - 2 * t);
}

/**
 * Saturates a value into 0..1.
 * @param {number} v Value.
 * @returns {number} Clamped value.
 */
function sat(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

/**
 * Bilinear value noise.
 * @param {number} x Sample X.
 * @param {number} y Sample Y.
 * @param {number} s Seed.
 * @returns {number} Value in [0, 1).
 */
function vnoise(x, y, s) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, s);
  const b = hash2(xi + 1, yi, s);
  const c = hash2(xi, yi + 1, s);
  const d = hash2(xi + 1, yi + 1, s);
  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
}

/**
 * Fractal Brownian motion built on {@link vnoise}.
 * @param {number} x Sample X.
 * @param {number} y Sample Y.
 * @param {number} s Seed.
 * @param {number} octaves Octave count.
 * @returns {number} Value in [0, 1].
 */
function fbm(x, y, s, octaves) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += vnoise(fx, fy, s + i * 131) * amp;
    norm += amp;
    amp *= 0.55;
    fx *= 2.03;
    fy *= 2.01;
  }
  return sum / norm;
}

/**
 * Distance from a point to a line segment.
 * @param {number} px Point X.
 * @param {number} py Point Y.
 * @param {number} ax Segment start X.
 * @param {number} ay Segment start Y.
 * @param {number} bx Segment end X.
 * @param {number} by Segment end Y.
 * @returns {number} Distance.
 */
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 1e-9 ? (wx * vx + wy * vy) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = wx - vx * t;
  const dy = wy - vy * t;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Triangle used by the glass shard sprite. @type {number[]} */
const GLASS_TRI = [0.5, 0.05, 0.93, 0.84, 0.13, 0.7];

/** Satellite droplet centres (x, y, radius) for the blood sprite. @type {number[]} */
const BLOOD_DROPS = [0.14, 0.2, 0.055, 0.86, 0.28, 0.04, 0.79, 0.83, 0.06, 0.2, 0.83, 0.045];

/** Crown droplet count for the splash sprite. @type {number} */
const SPLASH_DROPS = 7;

/** Scratch output of {@link spriteSample}: `[luminance, alpha]`. @type {Float32Array} */
const SPRITE_OUT = new Float32Array(2);

/**
 * Evaluates one sprite cell at a normalized coordinate. `v` runs downward (texture order).
 * Writes `[luminance, alpha]` into {@link SPRITE_OUT} so the generator never allocates.
 * @param {number} cell Sprite cell index.
 * @param {number} u Horizontal coordinate in [0, 1].
 * @param {number} v Vertical coordinate in [0, 1], 0 at the top.
 * @returns {Float32Array} {@link SPRITE_OUT}.
 */
function spriteSample(cell, u, v) {
  const dx = (u - 0.5) * 2;
  const dy = (v - 0.5) * 2;
  const d = Math.sqrt(dx * dx + dy * dy);
  let lum = 1;
  let a = 0;

  switch (cell) {
    case SPR_SMOKE: {
      const n = fbm(u * 3.6, v * 3.6, 17, 4);
      const shape = 1 - sstep(0.18, 1.0, d + (n - 0.5) * 0.62);
      a = sat(shape * (0.52 + n * 0.8));
      lum = 0.70 + n * 0.28;
      break;
    }
    case SPR_SPARK: {
      const ax = dx / 0.20;
      const ay = dy / 0.95;
      const body = Math.exp(-(ax * ax * 1.15 + ay * ay * 1.35) * 2.2);
      const core = Math.exp(-(ax * ax * 6.0 + ay * ay * 40.0));
      a = sat(body * 0.75 + core);
      lum = 1;
      break;
    }
    case SPR_FLASH: {
      const ang = Math.atan2(dy, dx);
      const core = Math.exp(-d * d * 26);
      const halo = Math.exp(-d * d * 4.2) * 0.42;
      const spike = Math.pow(Math.max(0, Math.cos(ang * 4)), 14) * Math.exp(-d * d * 2.0) * 0.5;
      a = sat(core + halo + spike);
      lum = 1;
      break;
    }
    case SPR_BLOOD: {
      const n = fbm(u * 3.2, v * 3.2, 91, 3);
      const r = 0.60 + (n - 0.5) * 0.5;
      a = 1 - sstep(r - 0.2, r, d);
      for (let i = 0; i < BLOOD_DROPS.length; i += 3) {
        const ddx = u - BLOOD_DROPS[i];
        const ddy = v - BLOOD_DROPS[i + 1];
        const rr = BLOOD_DROPS[i + 2];
        const dd = Math.sqrt(ddx * ddx + ddy * ddy);
        const blob = 1 - sstep(rr * 0.5, rr, dd);
        if (blob > a) a = blob;
      }
      lum = 0.78 + n * 0.24;
      break;
    }
    case SPR_GLASS: {
      const e0 = segDist(u, v, GLASS_TRI[0], GLASS_TRI[1], GLASS_TRI[2], GLASS_TRI[3]);
      const e1 = segDist(u, v, GLASS_TRI[2], GLASS_TRI[3], GLASS_TRI[4], GLASS_TRI[5]);
      const e2 = segDist(u, v, GLASS_TRI[4], GLASS_TRI[5], GLASS_TRI[0], GLASS_TRI[1]);
      const c0 = (GLASS_TRI[2] - GLASS_TRI[0]) * (v - GLASS_TRI[1]) - (GLASS_TRI[3] - GLASS_TRI[1]) * (u - GLASS_TRI[0]);
      const c1 = (GLASS_TRI[4] - GLASS_TRI[2]) * (v - GLASS_TRI[3]) - (GLASS_TRI[5] - GLASS_TRI[3]) * (u - GLASS_TRI[2]);
      const c2 = (GLASS_TRI[0] - GLASS_TRI[4]) * (v - GLASS_TRI[5]) - (GLASS_TRI[1] - GLASS_TRI[5]) * (u - GLASS_TRI[4]);
      const inside = (c0 >= 0 && c1 >= 0 && c2 >= 0) || (c0 <= 0 && c1 <= 0 && c2 <= 0);
      const edge = Math.min(e0, Math.min(e1, e2));
      const rim = (1 - sstep(0.0, 0.055, edge)) * 0.95;
      a = sat((inside ? 0.36 : 0) + rim);
      lum = inside ? 0.85 + rim * 0.15 : 1;
      break;
    }
    case SPR_RAIN: {
      const ax = dx / 0.16;
      const along = 1 - sstep(0.62, 1.0, Math.abs(dy));
      const prof = Math.exp(-ax * ax * 1.6);
      const hy = dy - 0.52;
      const head = Math.exp(-(ax * ax * 0.9 + hy * hy * 26.0) * 1.8);
      a = sat(prof * along * 0.6 + head * 0.85);
      lum = 1;
      break;
    }
    case SPR_MUZZLE: {
      const ang = Math.atan2(dy, dx);
      const s1 = Math.pow(Math.max(0, Math.cos(ang * 3 + 0.4)), 3) * 0.55;
      const s2 = Math.pow(Math.max(0, Math.cos(ang * 7 - 1.1)), 9) * 0.45;
      const reach = 0.30 + (s1 + s2) * 0.78;
      const petal = 1 - sstep(reach * 0.45, reach, d);
      a = sat(petal * 0.9 + Math.exp(-d * d * 34));
      lum = 1;
      break;
    }
    case SPR_DEBRIS: {
      const n = fbm(u * 4.6, v * 4.6, 233, 3);
      const r = 0.52 + (n - 0.5) * 0.6;
      a = 1 - sstep(r - 0.09, r, d);
      lum = 0.5 + n * 0.55;
      break;
    }
    case SPR_EMBER: {
      a = sat(Math.exp(-d * d * 62) + Math.exp(-d * d * 13) * 0.22);
      lum = 1;
      break;
    }
    case SPR_LEAF: {
      const t = sat(v);
      const w = 0.46 * Math.pow(Math.sin(Math.PI * t), 0.62);
      const x = Math.abs(u - 0.5);
      a = w > 1e-3 ? (1 - sstep(w - 0.035, w, x)) : 0;
      const rib = 1 - sstep(0.0, 0.02, x);
      lum = 0.55 + 0.35 * (1 - x / Math.max(w, 1e-3)) + rib * 0.2;
      break;
    }
    case SPR_SHELL: {
      const ax = Math.abs(dx) / 0.30;
      const ay = Math.abs(dy) / 0.80;
      const q = Math.pow(Math.pow(ax, 4) + Math.pow(ay, 4), 0.25);
      a = 1 - sstep(0.86, 1.0, q);
      const hl = (u - 0.40) / 0.11;
      lum = 0.5 + 0.5 * Math.exp(-hl * hl) + 0.12 * (1 - sat(Math.abs(dy)));
      break;
    }
    case SPR_SPLASH: {
      const ring = Math.exp(-(d - 0.5) * (d - 0.5) * 60) * 0.7;
      let drops = 0;
      for (let i = 0; i < SPLASH_DROPS; i++) {
        const ang = (i / SPLASH_DROPS) * Math.PI * 2 + 0.35;
        const px = Math.cos(ang) * 0.78;
        const py = Math.sin(ang) * 0.78;
        const ddx = dx - px;
        const ddy = dy - py;
        const blob = Math.exp(-(ddx * ddx + ddy * ddy) * 90);
        if (blob > drops) drops = blob;
      }
      a = sat(ring + drops * 0.9);
      lum = 1;
      break;
    }
    case SPR_RING: {
      const rr = d - 0.76;
      a = sat(Math.exp(-rr * rr * 85) * (1 - sstep(0.9, 1.0, d)));
      lum = 1;
      break;
    }
    case SPR_DUST: {
      const n = fbm(u * 2.7, v * 2.7, 411, 3);
      const shape = 1 - sstep(0.08, 1.0, d + (n - 0.5) * 0.34);
      a = sat(shape * 0.72);
      lum = 0.78 + n * 0.22;
      break;
    }
    case SPR_STREAK: {
      const ax = dx / 0.98;
      const ay = dy / 0.30;
      a = sat(Math.exp(-(ax * ax * 1.4 + ay * ay * 1.9)) * 0.85);
      lum = 0.92;
      break;
    }
    case SPR_SOFT:
    default: {
      const t = 1 - Math.min(d, 1);
      a = Math.pow(t, 2.2);
      lum = 1;
      break;
    }
  }

  // Keep a transparent margin inside every cell so mip levels never bleed across the atlas.
  a *= 1 - sstep(0.88, 1.0, Math.max(Math.abs(dx), Math.abs(dy)));
  SPRITE_OUT[0] = sat(lum);
  SPRITE_OUT[1] = sat(a);
  return SPRITE_OUT;
}

/**
 * Cached procedural atlas pixels. Rasterising the 16 sprites costs a few milliseconds, and the
 * atlas is rebuilt once more when the texture library shows up, so the result is kept.
 * Treated as immutable by every consumer.
 * @type {Uint8ClampedArray|null}
 */
let ATLAS_BASE = null;

/**
 * Rasterises the whole 4x4 sprite atlas into an RGBA byte buffer, memoised.
 * @returns {Uint8ClampedArray} `ATLAS_W * ATLAS_H * 4` bytes, row 0 at the top.
 */
function buildAtlasPixels() {
  if (ATLAS_BASE) return ATLAS_BASE;
  const px = new Uint8ClampedArray(ATLAS_W * ATLAS_H * 4);
  const inv = 1 / (ATLAS_CELL - 1);
  for (let cell = 0; cell < ATLAS_COLS * ATLAS_ROWS; cell++) {
    const cx = (cell % ATLAS_COLS) * ATLAS_CELL;
    const cy = ((cell / ATLAS_COLS) | 0) * ATLAS_CELL;
    for (let y = 0; y < ATLAS_CELL; y++) {
      const v = y * inv;
      let o = ((cy + y) * ATLAS_W + cx) * 4;
      for (let x = 0; x < ATLAS_CELL; x++, o += 4) {
        const s = spriteSample(cell, x * inv, v);
        const l = s[0] * 255;
        px[o] = l;
        px[o + 1] = l;
        px[o + 2] = l;
        px[o + 3] = s[1] * 255;
      }
    }
  }
  ATLAS_BASE = px;
  return px;
}

/**
 * Library canvases that override generated cells, with the rotation (in quarter turns)
 * needed to line the sprite up with the local +Y stretch axis.
 * @type {Array<{cell: number, key: string, turns: number}>}
 */
const ATLAS_OVERRIDES = [
  { cell: SPR_SMOKE, key: 'smoke', turns: 0 },
  { cell: SPR_SPARK, key: 'spark', turns: 3 },
  { cell: SPR_FLASH, key: 'flash', turns: 0 },
  { cell: SPR_BLOOD, key: 'blood', turns: 0 },
  { cell: SPR_GLASS, key: 'glassShard', turns: 0 },
  { cell: SPR_RAIN, key: 'raindrop', turns: 0 },
  { cell: SPR_MUZZLE, key: 'muzzle', turns: 0 }
];

/**
 * Creates a 2D canvas, preferring the DOM one so `drawImage` can consume library canvases.
 * @param {number} w Width.
 * @param {number} h Height.
 * @returns {HTMLCanvasElement|OffscreenCanvas|null} A canvas, or null when none is available.
 */
function makeCanvas(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return null;
}

/**
 * Builds the particle sprite atlas texture. Cells are generated procedurally, then any
 * matching sprite from the renderer's texture library is composited on top so the particle
 * system uses the game's real art when it exists and still works completely standalone.
 * @param {WebGL2RenderingContext} gl Context.
 * @param {Object|null} library Texture library (`renderer.textures`), may be null.
 * @returns {Texture2D} The atlas.
 */
function buildAtlasTexture(gl, library) {
  const pixels = buildAtlasPixels();
  const canvases = library && library.canvases ? library.canvases : null;
  const canvas = makeCanvas(ATLAS_W, ATLAS_H);
  let used = 0;

  if (canvas) {
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const image = ctx.createImageData(ATLAS_W, ATLAS_H);
      image.data.set(pixels);
      ctx.putImageData(image, 0, 0);
      if (canvases) {
        const pad = 6;
        const inner = ATLAS_CELL - pad * 2;
        for (let i = 0; i < ATLAS_OVERRIDES.length; i++) {
          const entry = ATLAS_OVERRIDES[i];
          const src = canvases[entry.key];
          if (!src || !src.width || !src.height) continue;
          const cx = (entry.cell % ATLAS_COLS) * ATLAS_CELL;
          const cy = ((entry.cell / ATLAS_COLS) | 0) * ATLAS_CELL;
          const turns = entry.turns & 3;
          const swap = (turns & 1) === 1;
          // `sw`/`sh` are the ROTATED footprint (what has to fit the cell); the drawn rect is
          // still in the source's own orientation, so it must keep the source's aspect ratio.
          const sw = swap ? src.height : src.width;
          const sh = swap ? src.width : src.height;
          const scale = Math.min(inner / sw, inner / sh);
          const dw = src.width * scale;
          const dh = src.height * scale;
          ctx.clearRect(cx, cy, ATLAS_CELL, ATLAS_CELL);
          ctx.save();
          ctx.translate(cx + ATLAS_CELL * 0.5, cy + ATLAS_CELL * 0.5);
          if (turns) ctx.rotate(turns * Math.PI * 0.5);
          ctx.drawImage(src, -dw * 0.5, -dh * 0.5, dw, dh);
          ctx.restore();
          used++;
        }
      }
      const tex = new Texture2D(gl, {
        source: canvas,
        srgb: true,
        wrap: 'clamp',
        filter: 'linear',
        mipmaps: true,
        flipY: false,
        anisotropy: 1
      });
      tex.spriteSources = used;
      return tex;
    }
  }

  const tex = new Texture2D(gl, {
    width: ATLAS_W,
    height: ATLAS_H,
    data: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length),
    internalFormat: 'srgb8_alpha8',
    wrap: 'clamp',
    filter: 'linear',
    mipmaps: true,
    flipY: false,
    anisotropy: 1
  });
  tex.spriteSources = 0;
  return tex;
}

/* -------------------------------------------------------------------------- */
/* Kind table                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Per-kind simulation defaults. `spawn({kind})` starts from these and applies its overrides;
 * `burst()` layers a tuned preset on top.
 * @type {Object<string, Object>}
 */
const KIND_DEFS = {
  smoke: { sprite: SPR_SMOKE, additive: 0, gravity: 0.35, drag: 1.1, fadeIn: 0.16, soft: 1.0, emissive: 0 },
  dust: { sprite: SPR_DUST, additive: 0, gravity: -0.12, drag: 1.8, fadeIn: 0.12, soft: 1.0, emissive: 0 },
  tireSmoke: { sprite: SPR_SMOKE, additive: 0, gravity: 0.5, drag: 2.4, fadeIn: 0.1, soft: 1.0, emissive: 0 },
  exhaust: { sprite: SPR_DUST, additive: 0, gravity: 0.35, drag: 2.6, fadeIn: 0.12, soft: 1.0, emissive: 0 },
  skid: { sprite: SPR_STREAK, additive: 0, gravity: 0.05, drag: 3.4, fadeIn: 0.08, soft: 1.0, emissive: 0 },
  fire: { sprite: SPR_SMOKE, additive: 1, gravity: 2.2, drag: 2.0, fadeIn: 0.06, soft: 0.7, emissive: 1 },
  explosion: { sprite: SPR_SMOKE, additive: 1, gravity: 1.2, drag: 1.6, fadeIn: 0.03, soft: 0.7, emissive: 1 },
  spark: { sprite: SPR_SPARK, additive: 1, gravity: -11, drag: 0.35, fadeIn: 0, soft: 0.35, emissive: 1, stretch: 0.03 },
  ember: { sprite: SPR_EMBER, additive: 1, gravity: -1.4, drag: 1.1, fadeIn: 0.05, soft: 0.35, emissive: 1 },
  flash: { sprite: SPR_FLASH, additive: 1, gravity: 0, drag: 0, fadeIn: 0, soft: 0.4, emissive: 1 },
  muzzle: { sprite: SPR_MUZZLE, additive: 1, gravity: 0, drag: 0, fadeIn: 0, soft: 0.4, emissive: 1 },
  ring: { sprite: SPR_RING, additive: 1, gravity: 0, drag: 0, fadeIn: 0, soft: 0.5, emissive: 1 },
  impact: { sprite: SPR_DUST, additive: 0, gravity: -0.4, drag: 2.4, fadeIn: 0.08, soft: 1.0, emissive: 0 },
  blood: { sprite: SPR_BLOOD, additive: 0, gravity: -14, drag: 0.35, fadeIn: 0, soft: 0.8, emissive: 0 },
  debris: { sprite: SPR_DEBRIS, additive: 0, gravity: -16, drag: 0.2, fadeIn: 0, soft: 0.6, emissive: 0 },
  glass: { sprite: SPR_GLASS, additive: 0, gravity: -16, drag: 0.15, fadeIn: 0, soft: 0.5, emissive: 0.18 },
  shell: { sprite: SPR_SHELL, additive: 0, gravity: -18, drag: 0.08, fadeIn: 0, soft: 0.5, emissive: 0.1 },
  leaf: { sprite: SPR_LEAF, additive: 0, gravity: -1.3, drag: 1.4, fadeIn: 0.1, soft: 0.8, emissive: 0 },
  rain: { sprite: SPR_RAIN, additive: 0, gravity: -2.5, drag: 0.04, fadeIn: 0.05, soft: 0.4, emissive: 0.15, stretch: 0.055 },
  splash: { sprite: SPR_SPLASH, additive: 0, gravity: -13, drag: 0.5, fadeIn: 0, soft: 0.5, emissive: 0.1 }
};

/**
 * Every kind name understood by {@link ParticleSystem#spawn} and {@link ParticleSystem#burst}.
 * @type {ReadonlyArray<string>}
 */
export const PARTICLE_KINDS = Object.freeze(Object.keys(KIND_DEFS));

/** Kind name -> numeric id stored in the pool. @type {Object<string, number>} */
const KIND_IDS = {};
for (let i = 0; i < PARTICLE_KINDS.length; i++) KIND_IDS[PARTICLE_KINDS[i]] = i;

/** Numeric id -> defaults, for O(1) lookup during spawning. @type {Object[]} */
const KIND_BY_ID = PARTICLE_KINDS.map((name) => KIND_DEFS[name]);

/* -------------------------------------------------------------------------- */
/* Staging record                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Module-scope staging record. `spawn`/`burst` fill it and `_commit` copies it into the pool,
 * which keeps the spawn path completely allocation free.
 * @type {Object<string, number>}
 */
const P = {
  kind: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
  life: 1, size: 1, sizeEnd: 1,
  r: 1, g: 1, b: 1, a: 1, r2: 1, g2: 1, b2: 1, a2: 0,
  rot: 0, rotVel: 0, gravity: 0, drag: 0,
  sprite: 0, additive: 0, light: 0, bounce: 0, flutter: 0,
  groundY: -1e30, emissive: 0, stretch: 0, fadeIn: 0, soft: 1,
  lightRadius: 6, lightPower: 1
};

/** Scratch direction used by the burst presets. @type {Float32Array} */
const DIR = new Float32Array(3);
/** Scratch tangent basis used by the burst presets. @type {Float32Array} */
const TAN = new Float32Array(6);

/**
 * Reads a 3-component vector out of an options object into {@link DIR}, with a default.
 * @param {Object|null} opts Options object.
 * @param {string} key Field name.
 * @param {number} dx Default X.
 * @param {number} dy Default Y.
 * @param {number} dz Default Z.
 * @returns {Float32Array} {@link DIR}.
 */
function readDir(opts, key, dx, dy, dz) {
  const v = opts ? opts[key] : null;
  let x = dx;
  let y = dy;
  let z = dz;
  if (v && v.length >= 3) {
    x = v[0];
    y = v[1];
    z = v[2];
  }
  const len = Math.sqrt(x * x + y * y + z * z);
  if (len > 1e-6) {
    DIR[0] = x / len;
    DIR[1] = y / len;
    DIR[2] = z / len;
  } else {
    DIR[0] = dx;
    DIR[1] = dy;
    DIR[2] = dz;
  }
  return DIR;
}

/**
 * Builds an orthonormal tangent basis around {@link DIR} into {@link TAN}.
 * @returns {Float32Array} {@link TAN} (`[t0x, t0y, t0z, t1x, t1y, t1z]`).
 */
function buildBasis() {
  const nx = DIR[0];
  const ny = DIR[1];
  const nz = DIR[2];
  let ax = 0;
  let ay = 1;
  let az = 0;
  if (Math.abs(ny) > 0.9) {
    ax = 1;
    ay = 0;
  }
  let t0x = ay * nz - az * ny;
  let t0y = az * nx - ax * nz;
  let t0z = ax * ny - ay * nx;
  const l0 = Math.sqrt(t0x * t0x + t0y * t0y + t0z * t0z) || 1;
  t0x /= l0;
  t0y /= l0;
  t0z /= l0;
  TAN[0] = t0x;
  TAN[1] = t0y;
  TAN[2] = t0z;
  TAN[3] = ny * t0z - nz * t0y;
  TAN[4] = nz * t0x - nx * t0z;
  TAN[5] = nx * t0y - ny * t0x;
  return TAN;
}

/** Milliseconds clock that works with or without `performance`. @returns {number} Milliseconds. */
const nowMs = (typeof performance !== 'undefined' && performance.now)
  ? () => performance.now()
  : () => Date.now();

/* -------------------------------------------------------------------------- */
/* ParticleSystem                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Instanced billboard particle system: fixed capacity, struct-of-arrays pool, CPU simulation,
 * two instanced draw calls per frame (alpha then additive).
 */
export class ParticleSystem {
  /**
   * @param {WebGL2RenderingContext} gl Context.
   * @param {Object|null} [renderer] Owning renderer; read for sun/fog/textures and lights.
   * @param {number} [maxParticles] Pool capacity. Never grows during play.
   */
  constructor(gl, renderer = null, maxParticles = 6000) {
    /** @type {WebGL2RenderingContext} */
    this.gl = gl;
    /** @type {Object|null} */
    this.renderer = renderer || null;
    /** @type {boolean} */
    this.disposed = false;
    /** @type {boolean} Master switch; when false `update` only ages particles out. */
    this.enabled = true;

    /** @type {number} Live particle count (also the head of the free list). */
    this.count = 0;
    /** @type {number} Pool capacity. */
    this.capacity = 0;

    /** @type {Rand} Deterministic generator; never `Math.random`. */
    this.rng = new Rand(0x9e3779b9);

    /** @type {Float32Array} Constant wind that drag pulls particles toward, m/s. */
    this.wind = new Float32Array([0.4, 0, 0.25]);
    /** @type {number} Scene depth difference (metres) over which soft particles fade in. */
    this.softDistance = 0.65;
    /** @type {number} Distance at which particles start fading in near the camera. */
    this.nearFadeStart = 0.22;
    /** @type {number} Length of the near-camera fade ramp. */
    this.nearFadeRange = 0.55;
    /** @type {boolean} Soft particles on/off (also switched off if the driver refuses). */
    this.softParticles = true;
    /** @type {number} Maximum point lights requested per frame. */
    this.maxLights = 10;

    /**
     * Point-light request callback, `(x, y, z, r, g, b, radius, intensity)`.
     * The renderer may replace this at any time.
     * @type {?function(number, number, number, number, number, number, number, number): *}
     */
    this.onLight = (renderer && typeof renderer.submitLight === 'function')
      ? renderer.submitLight.bind(renderer)
      : null;

    /** @type {number} Persistent rain volume intensity, 0..1. */
    this.rainIntensity = 0;
    /** @type {number} Radius of the rain volume around the camera, metres. */
    this.rainRadius = 16;
    /** @type {number} Live rain particles counted by the last update. */
    this._rainAlive = 0;
    /** @type {number} Rain particles the current intensity asks for. */
    this._rainTarget = 0;

    /** @type {Texture2D|null} */
    this.atlas = null;
    /** @type {Object|null} Explicit depth texture set by the renderer. */
    this._depthTex = null;
    /** @type {boolean} True once `setDepthTexture` has been called at least once. */
    this._depthDriven = false;
    /** @type {number} */
    this._depthNear = 0.12;
    /** @type {number} */
    this._depthFar = 1400;
    /** @type {number} 0 = sample directly, 1 = sample a private blit copy, 2 = soft disabled. */
    this._depthMode = 0;
    /** @type {boolean} The next soft draw still has to be validated with `getError`. */
    this._softProbe = true;
    /** @type {RenderTarget|null} Private depth copy used when direct sampling feeds back. */
    this._depthCopy = null;

    /**
     * Per-frame statistics. `spawned` and `recycled` are cumulative counters; everything else
     * describes the frame that was last updated. `depthMode` mirrors the soft-particle
     * verdict: 0 = sampling the supplied depth directly, 1 = sampling a private copy of it,
     * 2 = soft particles off.
     * @type {Object}
     */
    this.stats = {
      alive: 0, alpha: 0, additive: 0, drawCalls: 0,
      spawned: 0, recycled: 0, killed: 0, lights: 0, depthMode: 0, simMs: 0, updateMs: 0
    };

    /** @type {number} Monotonic spawn counter used to find the oldest particle. */
    this._seq = 0;
    /** @type {number} Rotating start of the saturated-pool recycle sweep. */
    this._recycleCursor = 0;
    /** @type {number} Instances packed by the last update, ready to draw. */
    this._drawAlpha = 0;
    /** @type {number} */
    this._drawAdditive = 0;

    this._allocate(Math.max(64, maxParticles | 0));
    this._createGpu();
  }

  /* ---------------------------------------------------------------- storage */

  /**
   * (Re)allocates the struct-of-arrays pool and every CPU side buffer.
   * @param {number} capacity New capacity.
   * @returns {void}
   * @private
   */
  _allocate(capacity) {
    const n = Math.max(16, capacity | 0);
    const keep = this.capacity > 0 ? Math.min(this.count, n) : 0;

    const px = new Float32Array(n);
    const py = new Float32Array(n);
    const pz = new Float32Array(n);
    const vx = new Float32Array(n);
    const vy = new Float32Array(n);
    const vz = new Float32Array(n);
    const life = new Float32Array(n);
    const lifeMax = new Float32Array(n);
    const size0 = new Float32Array(n);
    const size1 = new Float32Array(n);
    const r0 = new Float32Array(n);
    const g0 = new Float32Array(n);
    const b0 = new Float32Array(n);
    const a0 = new Float32Array(n);
    const r1 = new Float32Array(n);
    const g1 = new Float32Array(n);
    const b1 = new Float32Array(n);
    const a1 = new Float32Array(n);
    const rot = new Float32Array(n);
    const rotVel = new Float32Array(n);
    const gravity = new Float32Array(n);
    const drag = new Float32Array(n);
    const emissive = new Float32Array(n);
    const stretch = new Float32Array(n);
    const fadeIn = new Float32Array(n);
    const soft = new Float32Array(n);
    const bounce = new Float32Array(n);
    const groundY = new Float32Array(n);
    const sprite = new Float32Array(n);
    const lightRadius = new Float32Array(n);
    const lightPower = new Float32Array(n);
    const flags = new Uint8Array(n);
    const kind = new Uint8Array(n);
    const seq = new Float64Array(n);

    if (keep > 0) {
      px.set(this.px.subarray(0, keep));
      py.set(this.py.subarray(0, keep));
      pz.set(this.pz.subarray(0, keep));
      vx.set(this.vx.subarray(0, keep));
      vy.set(this.vy.subarray(0, keep));
      vz.set(this.vz.subarray(0, keep));
      life.set(this.life.subarray(0, keep));
      lifeMax.set(this.lifeMax.subarray(0, keep));
      size0.set(this.size0.subarray(0, keep));
      size1.set(this.size1.subarray(0, keep));
      r0.set(this.r0.subarray(0, keep));
      g0.set(this.g0.subarray(0, keep));
      b0.set(this.b0.subarray(0, keep));
      a0.set(this.a0.subarray(0, keep));
      r1.set(this.r1.subarray(0, keep));
      g1.set(this.g1.subarray(0, keep));
      b1.set(this.b1.subarray(0, keep));
      a1.set(this.a1.subarray(0, keep));
      rot.set(this.rot.subarray(0, keep));
      rotVel.set(this.rotVel.subarray(0, keep));
      gravity.set(this.gravity.subarray(0, keep));
      drag.set(this.drag.subarray(0, keep));
      emissive.set(this.emissive.subarray(0, keep));
      stretch.set(this.stretch.subarray(0, keep));
      fadeIn.set(this.fadeIn.subarray(0, keep));
      soft.set(this.soft.subarray(0, keep));
      bounce.set(this.bounce.subarray(0, keep));
      groundY.set(this.groundY.subarray(0, keep));
      sprite.set(this.sprite.subarray(0, keep));
      lightRadius.set(this.lightRadius.subarray(0, keep));
      lightPower.set(this.lightPower.subarray(0, keep));
      flags.set(this.flags.subarray(0, keep));
      kind.set(this.kind.subarray(0, keep));
      seq.set(this.seq.subarray(0, keep));
    }

    /** @type {Float32Array} World X. */
    this.px = px;
    /** @type {Float32Array} World Y. */
    this.py = py;
    /** @type {Float32Array} World Z. */
    this.pz = pz;
    /** @type {Float32Array} Velocity X, m/s. */
    this.vx = vx;
    /** @type {Float32Array} Velocity Y, m/s. */
    this.vy = vy;
    /** @type {Float32Array} Velocity Z, m/s. */
    this.vz = vz;
    /** @type {Float32Array} Remaining life, seconds. */
    this.life = life;
    /** @type {Float32Array} Total life, seconds. */
    this.lifeMax = lifeMax;
    /** @type {Float32Array} Size at birth, metres. */
    this.size0 = size0;
    /** @type {Float32Array} Size at death, metres. */
    this.size1 = size1;
    /** @type {Float32Array} Birth colour. */
    this.r0 = r0;
    this.g0 = g0;
    this.b0 = b0;
    /** @type {Float32Array} Birth alpha. */
    this.a0 = a0;
    /** @type {Float32Array} Death colour. */
    this.r1 = r1;
    this.g1 = g1;
    this.b1 = b1;
    /** @type {Float32Array} Death alpha. */
    this.a1 = a1;
    /** @type {Float32Array} Roll, radians. */
    this.rot = rot;
    /** @type {Float32Array} Roll speed, rad/s. */
    this.rotVel = rotVel;
    /** @type {Float32Array} Vertical acceleration, m/s^2 (positive rises). */
    this.gravity = gravity;
    /** @type {Float32Array} Velocity relaxation rate toward the wind, 1/s. */
    this.drag = drag;
    /** @type {Float32Array} 0 = fully lit, 1 = unlit and boosted. */
    this.emissive = emissive;
    /** @type {Float32Array} Velocity stretch in seconds of travel. */
    this.stretch = stretch;
    /** @type {Float32Array} Fraction of life spent fading in. */
    this.fadeIn = fadeIn;
    /** @type {Float32Array} Soft-particle fade scale, 0 disables it. */
    this.soft = soft;
    /** @type {Float32Array} Ground restitution. */
    this.bounce = bounce;
    /** @type {Float32Array} Ground plane height. */
    this.groundY = groundY;
    /** @type {Float32Array} Atlas cell index. */
    this.sprite = sprite;
    /** @type {Float32Array} Requested light radius, metres. */
    this.lightRadius = lightRadius;
    /** @type {Float32Array} Requested light intensity at birth. */
    this.lightPower = lightPower;
    /** @type {Uint8Array} Bitfield of `FLAG_*`. */
    this.flags = flags;
    /** @type {Uint8Array} Kind id. */
    this.kind = kind;
    /** @type {Float64Array} Spawn sequence number (age ordering). */
    this.seq = seq;

    this.capacity = n;
    this.count = keep;
    this._recycleCursor = 0;

    /** @type {Float32Array} Interleaved instance data in draw order. */
    this._instances = new Float32Array(n * STRIDE);
    /** @type {Int32Array} Pool indices of the alpha set. */
    this._alphaIdx = new Int32Array(n);
    /** @type {Uint16Array} Sort key per entry of `_alphaIdx`. */
    this._alphaKey = new Uint16Array(n);
    /** @type {Int32Array} Alpha set after the back-to-front sort. */
    this._alphaSorted = new Int32Array(n);
    /** @type {Int32Array} Pool indices of the additive set. */
    this._addIdx = new Int32Array(n);
    /** @type {Uint32Array} Counting sort histogram. */
    this._buckets = new Uint32Array(SORT_BUCKETS + 1);
  }

  /**
   * Creates the VAO, the instance buffer, both shader permutations and the sprite atlas.
   * @returns {void}
   * @private
   */
  _createGpu() {
    const gl = this.gl;

    /** @type {WebGLBuffer} */
    this._buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.capacity * BYTE_STRIDE, gl.DYNAMIC_DRAW);

    /** @type {WebGLVertexArrayObject} */
    this._vao = gl.createVertexArray();
    gl.bindVertexArray(this._vao);
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 4, gl.FLOAT, false, BYTE_STRIDE, i * 16);
      gl.vertexAttribDivisor(i, 1);
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    const defines = { ATLAS_COLS: ATLAS_COLS, ATLAS_ROWS: ATLAS_ROWS, SOFT_PARTICLES: 0 };
    /** @type {Shader} Plain permutation (no depth texture bound). */
    this._shaderPlain = new Shader(gl, PARTICLE_VS, PARTICLE_FS, defines, 'particles');
    /** @type {Shader} Soft-particle permutation. */
    this._shaderSoft = new Shader(gl, PARTICLE_VS, PARTICLE_FS,
      { ATLAS_COLS: ATLAS_COLS, ATLAS_ROWS: ATLAS_ROWS, SOFT_PARTICLES: 1 }, 'particles-soft');

    /** @type {boolean} True once the atlas has been built from the texture library. */
    this._atlasFromLibrary = false;
    /** @type {Object|null} Library the current atlas was built from (identity, not contents). */
    this._atlasLibrary = this.renderer ? (this.renderer.textures || null) : null;
    this.rebuildAtlas(this._atlasLibrary);
  }

  /**
   * (Re)builds the sprite atlas, compositing the texture library's particle sprites over the
   * procedural cells. The `Renderer` constructs this system before `renderer.textures` exists,
   * so `update()` calls this once by itself as soon as the library shows up; call it directly
   * only to force a different library in.
   * @param {Object|null} [library] Texture library (defaults to `renderer.textures`).
   * @returns {boolean} True when the library supplied at least one sprite.
   */
  rebuildAtlas(library) {
    const gl = this.gl;
    const lib = library === undefined ? (this.renderer ? this.renderer.textures : null) : library;
    const next = buildAtlasTexture(gl, lib);
    // Cap the mip chain so the 4x4 atlas cells never bleed into each other at distance.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, next.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 3);
    gl.bindTexture(gl.TEXTURE_2D, null);
    if (this.atlas && this.atlas.dispose) this.atlas.dispose();
    this.atlas = next;
    this._atlasFromLibrary = next.spriteSources > 0;
    return this._atlasFromLibrary;
  }

  /**
   * Changes the pool capacity (called by `Renderer.setQuality`). Live particles beyond the new
   * capacity are dropped. Never call this per frame.
   * @param {number} capacity New maximum particle count.
   * @returns {void}
   */
  setBudget(capacity) {
    const n = Math.max(64, capacity | 0);
    if (n === this.capacity || this.disposed) return;
    const gl = this.gl;
    this._allocate(n);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.capacity * BYTE_STRIDE, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this._drawAlpha = 0;
    this._drawAdditive = 0;
    // The rain population is a fraction of the pool, so it has to follow the new budget.
    this.rain(this.rainIntensity);
  }

  /**
   * Supplies the scene depth buffer used by the soft-particle fade.
   * @param {Object|null} texture Depth texture (`Texture2D` or `{texture}`), null to disable.
   * @param {number} [near] Near plane the depth was rendered with.
   * @param {number} [far] Far plane the depth was rendered with.
   * @returns {void}
   */
  setDepthTexture(texture, near, far) {
    const tex = texture || null;
    if (tex !== this._depthTex) {
      // A new source deserves a fresh feedback-loop verdict.
      this._depthMode = 0;
      this._softProbe = true;
    }
    // From the first call on, the renderer owns the scene depth: `null` then means "no depth
    // this frame", not "go and find one yourself". Guessing here would re-form the very
    // feedback loop a renderer that publishes a depth copy is working to avoid.
    this._depthDriven = true;
    this._depthTex = tex;
    if (near !== undefined && near > 0) this._depthNear = near;
    if (far !== undefined && far > 0) this._depthFar = far;
  }

  /* ------------------------------------------------------------------ spawn */

  /**
   * Loads the staging record with a kind's defaults.
   * @param {number} kindId Numeric kind id.
   * @returns {void}
   * @private
   */
  _reset(kindId) {
    const def = KIND_BY_ID[kindId] || KIND_DEFS.smoke;
    P.kind = kindId;
    P.x = 0; P.y = 0; P.z = 0;
    P.vx = 0; P.vy = 0; P.vz = 0;
    P.life = 1;
    P.size = 0.3;
    P.sizeEnd = 0.3;
    P.r = 1; P.g = 1; P.b = 1; P.a = 1;
    P.r2 = 1; P.g2 = 1; P.b2 = 1; P.a2 = 0;
    P.rot = 0;
    P.rotVel = 0;
    P.gravity = def.gravity || 0;
    P.drag = def.drag || 0;
    P.sprite = def.sprite;
    P.additive = def.additive || 0;
    P.light = 0;
    P.bounce = 0;
    P.flutter = 0;
    P.groundY = -1e30;
    P.emissive = def.emissive || 0;
    P.stretch = def.stretch || 0;
    P.fadeIn = def.fadeIn || 0;
    P.soft = def.soft === undefined ? 1 : def.soft;
    P.lightRadius = 6;
    P.lightPower = 1;
  }

  /**
   * Applies a user options object onto the staging record.
   * @param {Object|null} o Options (see {@link ParticleSystem#spawn}).
   * @param {boolean} [burst] True from {@link ParticleSystem#burst}, where the preset has
   *   already consumed `x/y/z`, `speed`, `size` and `life` and randomized around them; those
   *   fields must not be flattened back to a constant afterwards.
   * @returns {void}
   * @private
   */
  _applyOpts(o, burst) {
    if (!o) return;
    if (!burst) {
      if (o.x !== undefined) P.x = o.x;
      if (o.y !== undefined) P.y = o.y;
      if (o.z !== undefined) P.z = o.z;
      if (o.vx !== undefined) P.vx = o.vx;
      if (o.vy !== undefined) P.vy = o.vy;
      if (o.vz !== undefined) P.vz = o.vz;
      if (o.life !== undefined) P.life = o.life;
      if (o.size !== undefined) {
        P.size = o.size;
        P.sizeEnd = o.size;
      }
    }
    if (o.sizeEnd !== undefined) P.sizeEnd = o.sizeEnd;
    const c = o.color;
    if (c && c.length >= 3) {
      P.r = c[0]; P.g = c[1]; P.b = c[2];
      P.r2 = c[0]; P.g2 = c[1]; P.b2 = c[2];
    }
    const ce = o.colorEnd;
    if (ce && ce.length >= 3) {
      P.r2 = ce[0]; P.g2 = ce[1]; P.b2 = ce[2];
    }
    if (o.alpha !== undefined) {
      P.a = o.alpha;
      P.a2 = 0;
    }
    if (o.alphaEnd !== undefined) P.a2 = o.alphaEnd;
    if (o.gravity !== undefined) P.gravity = o.gravity;
    if (o.drag !== undefined) P.drag = o.drag;
    if (o.rotation !== undefined) P.rot = o.rotation;
    if (o.rotationSpeed !== undefined) P.rotVel = o.rotationSpeed;
    if (o.additive !== undefined) P.additive = o.additive ? 1 : 0;
    if (o.sprite !== undefined) P.sprite = o.sprite;
    if (o.emissive !== undefined) P.emissive = o.emissive;
    if (o.stretch !== undefined) P.stretch = o.stretch;
    if (o.fadeIn !== undefined) P.fadeIn = o.fadeIn;
    if (o.soft !== undefined) P.soft = o.soft;
    if (o.bounce !== undefined) P.bounce = o.bounce;
    if (o.flutter !== undefined) P.flutter = o.flutter ? 1 : 0;
    if (o.groundY !== undefined) P.groundY = o.groundY;
    if (o.lightRadius !== undefined) P.lightRadius = o.lightRadius;
    if (o.lightPower !== undefined) P.lightPower = o.lightPower;
    if (o.light !== undefined && o.light) {
      P.light = 1;
      P.additive = 1;
      P.emissive = Math.max(P.emissive, 1);
    }
  }

  /**
   * Finds a free pool slot. When the pool is saturated it recycles the oldest live particle of
   * the same kind found in a rotating window of {@link RECYCLE_WINDOW} slots (falling back to
   * the oldest of any kind in that window), which keeps the cost per spawn constant.
   * @param {number} kindId Kind being spawned.
   * @returns {number} Slot index.
   * @private
   */
  _alloc(kindId) {
    if (this.count < this.capacity) return this.count++;
    const kinds = this.kind;
    const seq = this.seq;
    const n = this.count;
    // CLOCK-style sweep: look at RECYCLE_WINDOW slots starting where the last recycle stopped,
    // so a long burst still spreads its victims over the whole pool without paying O(live)
    // per spawn. Within the window the oldest particle of the same kind wins, falling back to
    // the oldest of any kind.
    const window = n < RECYCLE_WINDOW ? n : RECYCLE_WINDOW;
    let i = this._recycleCursor;
    if (i >= n || i < 0) i = 0;
    let best = -1;
    let bestSeq = Infinity;
    let any = i;
    let anySeq = Infinity;
    for (let k = 0; k < window; k++) {
      const s = seq[i];
      if (s < anySeq) {
        anySeq = s;
        any = i;
      }
      if (kinds[i] === kindId && s < bestSeq) {
        bestSeq = s;
        best = i;
      }
      i++;
      if (i >= n) i = 0;
    }
    this._recycleCursor = i;
    const slot = best >= 0 ? best : any;
    if ((this.flags[slot] & FLAG_RAIN) !== 0 && this._rainAlive > 0) this._rainAlive--;
    this.stats.recycled++;
    return slot;
  }

  /**
   * Copies the staging record into the pool.
   * @returns {number} The pool index that was written.
   * @private
   */
  _commit() {
    const i = this._alloc(P.kind);
    const lifeSpan = P.life > 1e-4 ? P.life : 1e-4;
    this.px[i] = P.x;
    this.py[i] = P.y;
    this.pz[i] = P.z;
    this.vx[i] = P.vx;
    this.vy[i] = P.vy;
    this.vz[i] = P.vz;
    this.life[i] = lifeSpan;
    this.lifeMax[i] = lifeSpan;
    this.size0[i] = P.size;
    this.size1[i] = P.sizeEnd;
    this.r0[i] = P.r;
    this.g0[i] = P.g;
    this.b0[i] = P.b;
    this.a0[i] = P.a;
    this.r1[i] = P.r2;
    this.g1[i] = P.g2;
    this.b1[i] = P.b2;
    this.a1[i] = P.a2;
    this.rot[i] = P.rot;
    this.rotVel[i] = P.rotVel;
    this.gravity[i] = P.gravity;
    this.drag[i] = P.drag;
    this.emissive[i] = P.emissive;
    this.stretch[i] = P.stretch;
    this.fadeIn[i] = P.fadeIn;
    this.soft[i] = P.soft;
    this.bounce[i] = P.bounce;
    this.groundY[i] = P.groundY;
    this.sprite[i] = P.sprite;
    this.lightRadius[i] = P.lightRadius;
    this.lightPower[i] = P.lightPower;
    this.kind[i] = P.kind;
    this.seq[i] = ++this._seq;
    let f = 0;
    if (P.additive) f |= FLAG_ADDITIVE;
    if (P.light) f |= FLAG_LIGHT;
    if (P.bounce > 0 && P.groundY > -1e29) f |= FLAG_BOUNCE;
    if (P.flutter) f |= FLAG_FLUTTER;
    this.flags[i] = f;
    this.stats.spawned++;
    return i;
  }

  /**
   * Spawns a single particle. Never allocates and never grows the pool.
   * @param {Object} opts Particle description:
   *   `{x, y, z, vx, vy, vz, life, size, sizeEnd, color:[r,g,b], colorEnd:[r,g,b], alpha,
   *     alphaEnd, gravity, drag, kind, rotation, rotationSpeed, additive, light}` plus the
   *   extensions `{sprite, emissive, stretch, fadeIn, soft, bounce, flutter, groundY,
   *     lightRadius, lightPower}`.
   * @returns {number} Pool index of the new particle, or -1 when the system is disposed or off.
   */
  spawn(opts) {
    if (this.disposed || !this.enabled) return -1;
    const name = opts && opts.kind ? opts.kind : 'smoke';
    const id = KIND_IDS[name] === undefined ? KIND_IDS.smoke : KIND_IDS[name];
    this._reset(id);
    this._applyOpts(opts);
    return this._commit();
  }

  /* ------------------------------------------------------------------ burst */

  /**
   * Emits a tuned preset burst. This is the entry point gameplay code uses.
   * @param {string} kind One of {@link PARTICLE_KINDS} (`'muzzle'`, `'impact'`, `'blood'`,
   *   `'spark'`, `'debris'`, `'smoke'`, `'fire'`, `'explosion'`, `'glass'`, `'tireSmoke'`,
   *   `'exhaust'`, `'splash'`, `'rain'`, `'dust'`, `'leaf'`, `'shell'`, `'skid'`).
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   * @param {number} count Number of particles to try to emit.
   * @param {Object} [opts] Tuning, all optional:
   *   - `power` energy multiplier, 1 = a normal instance. Sizes scale with its square root and
   *     speeds/light radii linearly, so passing a blast radius (6, 12, ...) yields a bigger,
   *     harder burst instead of screen-filling sprites.
   *   - `dir:[x,y,z]` main direction (surface normal for impacts, barrel axis for muzzles).
   *   - `spread` 0..1 cone half-width around `dir`; `speed`, `size`, `life` replace the
   *     preset's base value, which the preset still randomizes around.
   *   - `color:[r,g,b]`, `colorEnd:[r,g,b]`, `alpha` override the whole burst.
   *   - `velocity:[x,y,z]` inherited velocity added to every particle (a moving car's exhaust).
   *   - `groundY` plane the bouncing kinds land on; defaults to `y`.
   *   - plus any {@link ParticleSystem#spawn} field except the motion ones the preset owns
   *     (`x/y/z`, `vx/vy/vz`, `life`, `size`), which are consumed as bases instead.
   * @returns {number} Number of particles emitted.
   */
  burst(kind, x, y, z, count, opts = null) {
    if (this.disposed || !this.enabled) return 0;
    const name = KIND_IDS[kind] === undefined ? 'smoke' : kind;
    const id = KIND_IDS[name];
    const n = Math.max(0, Math.min(count | 0, this.capacity));
    if (n === 0) return 0;

    const o = opts || null;
    const power = o && o.power !== undefined ? Math.max(0.05, o.power) : 1;
    const spread = o && o.spread !== undefined ? clamp(o.spread, 0, 1) : -1;
    const groundY = o && o.groundY !== undefined ? o.groundY : y;
    let ivx = 0;
    let ivy = 0;
    let ivz = 0;
    if (o && o.velocity && o.velocity.length >= 3) {
      ivx = o.velocity[0];
      ivy = o.velocity[1];
      ivz = o.velocity[2];
    }

    for (let i = 0; i < n; i++) {
      this._reset(id);
      P.x = x;
      P.y = y;
      P.z = z;
      this._preset(name, i, n, power, spread, groundY, o);
      P.vx += ivx;
      P.vy += ivy;
      P.vz += ivz;
      this._applyOpts(o, true);
      this._commit();
    }
    return n;
  }

  /**
   * Fills the staging record for one particle of a preset burst.
   * @param {string} name Preset name.
   * @param {number} i Index within the burst.
   * @param {number} n Burst size.
   * @param {number} power Energy multiplier.
   * @param {number} spread Cone spread override, or -1 for the preset default.
   * @param {number} groundY Ground plane for bouncing kinds.
   * @param {Object|null} o Caller options (read for `dir`, `speed`, `size`, `life`).
   * @returns {void}
   * @private
   */
  _preset(name, i, n, power, spread, groundY, o) {
    const rng = this.rng;
    // Gameplay passes a blast radius as `power` (see `Game.explosionAt`), so sizes scale with
    // its square root while speeds stay linear: a 6 m blast makes puffs ~2.4x bigger and hurls
    // them 6x harder, instead of inflating every sprite until it fills the screen.
    const sizePow = Math.sqrt(power);
    const baseSpeed = o && o.speed !== undefined ? o.speed : -1;
    const baseSize = o && o.size !== undefined ? o.size : -1;
    const baseLife = o && o.life !== undefined ? o.life : -1;
    const t = n > 1 ? i / (n - 1) : 0;

    switch (name) {
      case 'muzzle': {
        readDir(o, 'dir', 0, 0, -1);
        const dx = DIR[0];
        const dy = DIR[1];
        const dz = DIR[2];
        buildBasis();
        if (i === 0) {
          P.sprite = SPR_MUZZLE;
          P.size = (baseSize > 0 ? baseSize : 0.42) * sizePow;
          P.sizeEnd = P.size * 1.5;
          P.life = baseLife > 0 ? baseLife : 0.055;
          P.rot = rng.range(0, Math.PI * 2);
          P.r = 3.2; P.g = 2.4; P.b = 1.35;
          P.r2 = 2.0; P.g2 = 1.0; P.b2 = 0.35;
          P.a = 1; P.a2 = 0;
          P.emissive = 1;
          P.additive = 1;
          P.light = 1;
          P.lightRadius = 7 * power;
          P.lightPower = 5 * power;
          P.x += dx * 0.06;
          P.y += dy * 0.06;
          P.z += dz * 0.06;
        } else if (i < 1 + (n - 1) * 0.7) {
          const s = rng.range(4, 13) * power;
          const c = rng.range(0, 0.35);
          const ang = rng.range(0, Math.PI * 2);
          const ox = TAN[0] * Math.cos(ang) + TAN[3] * Math.sin(ang);
          const oy = TAN[1] * Math.cos(ang) + TAN[4] * Math.sin(ang);
          const oz = TAN[2] * Math.cos(ang) + TAN[5] * Math.sin(ang);
          P.sprite = SPR_SPARK;
          P.vx = (dx + ox * c) * s;
          P.vy = (dy + oy * c) * s + rng.range(0, 1.2);
          P.vz = (dz + oz * c) * s;
          P.size = rng.range(0.02, 0.05);
          P.sizeEnd = P.size * 0.4;
          P.life = rng.range(0.08, 0.24);
          P.gravity = -10;
          P.drag = 1.4;
          P.stretch = 0.03;
          P.r = 3.4; P.g = 1.9; P.b = 0.6;
          P.r2 = 1.8; P.g2 = 0.5; P.b2 = 0.1;
          P.a = 1; P.a2 = 0;
          P.emissive = 1;
          P.additive = 1;
        } else {
          P.sprite = SPR_SMOKE;
          P.vx = dx * rng.range(0.6, 2.4) + rng.range(-0.4, 0.4);
          P.vy = dy * rng.range(0.6, 2.0) + rng.range(0.1, 0.7);
          P.vz = dz * rng.range(0.6, 2.4) + rng.range(-0.4, 0.4);
          P.size = rng.range(0.05, 0.12) * sizePow;
          P.sizeEnd = P.size * rng.range(4, 7);
          P.life = rng.range(0.35, 0.75);
          P.gravity = 0.5;
          P.drag = 2.6;
          P.rot = rng.range(0, Math.PI * 2);
          P.rotVel = rng.range(-1.4, 1.4);
          P.r = 0.5; P.g = 0.48; P.b = 0.46;
          P.r2 = 0.3; P.g2 = 0.29; P.b2 = 0.28;
          P.a = 0.28; P.a2 = 0;
          P.fadeIn = 0.15;
          P.additive = 0;
          P.emissive = 0;
        }
        break;
      }

      case 'impact': {
        readDir(o, 'dir', 0, 1, 0);
        const dx = DIR[0];
        const dy = DIR[1];
        const dz = DIR[2];
        buildBasis();
        const cone = spread >= 0 ? spread : 0.75;
        const ang = rng.range(0, Math.PI * 2);
        const rad = Math.sqrt(rng.next()) * cone;
        const ox = (TAN[0] * Math.cos(ang) + TAN[3] * Math.sin(ang)) * rad;
        const oy = (TAN[1] * Math.cos(ang) + TAN[4] * Math.sin(ang)) * rad;
        const oz = (TAN[2] * Math.cos(ang) + TAN[5] * Math.sin(ang)) * rad;
        if (i === 0) {
          P.sprite = SPR_FLASH;
          P.size = 0.22 * sizePow;
          P.sizeEnd = 0.05;
          P.life = 0.06;
          P.r = 2.6; P.g = 2.0; P.b = 1.2;
          P.r2 = 1.4; P.g2 = 0.7; P.b2 = 0.25;
          P.a = 1; P.a2 = 0;
          P.emissive = 1;
          P.additive = 1;
          P.rot = rng.range(0, Math.PI * 2);
        } else if (t < 0.6) {
          const s = rng.range(2.5, 9) * power;
          P.sprite = SPR_SPARK;
          P.vx = (dx + ox) * s;
          P.vy = (dy + oy) * s;
          P.vz = (dz + oz) * s;
          P.size = rng.range(0.018, 0.05);
          P.sizeEnd = P.size * 0.3;
          P.life = rng.range(0.18, 0.5);
          P.gravity = -13;
          P.drag = 0.6;
          P.stretch = 0.035;
          P.bounce = 0.3;
          P.groundY = groundY;
          P.r = 3.2; P.g = 1.7; P.b = 0.55;
          P.r2 = 1.6; P.g2 = 0.35; P.b2 = 0.05;
          P.a = 1; P.a2 = 0;
          P.emissive = 1;
          P.additive = 1;
        } else {
          const s = rng.range(0.6, 3.0) * power;
          P.sprite = SPR_DUST;
          P.vx = (dx + ox) * s;
          P.vy = (dy + oy) * s;
          P.vz = (dz + oz) * s;
          P.size = (baseSize > 0 ? baseSize : rng.range(0.07, 0.16)) * sizePow;
          P.sizeEnd = P.size * rng.range(3.0, 5.5);
          P.life = rng.range(0.35, 0.85);
          P.gravity = -0.4;
          P.drag = 3.2;
          P.rot = rng.range(0, Math.PI * 2);
          P.rotVel = rng.range(-1.6, 1.6);
          P.r = 0.52; P.g = 0.48; P.b = 0.42;
          P.r2 = 0.34; P.g2 = 0.32; P.b2 = 0.29;
          P.a = 0.55; P.a2 = 0;
          P.fadeIn = 0.12;
        }
        break;
      }

      case 'blood': {
        readDir(o, 'dir', 0, 1, 0);
        buildBasis();
        const cone = spread >= 0 ? spread : 0.85;
        const ang = rng.range(0, Math.PI * 2);
        const rad = Math.sqrt(rng.next()) * cone;
        const ox = (TAN[0] * Math.cos(ang) + TAN[3] * Math.sin(ang)) * rad;
        const oy = (TAN[1] * Math.cos(ang) + TAN[4] * Math.sin(ang)) * rad;
        const oz = (TAN[2] * Math.cos(ang) + TAN[5] * Math.sin(ang)) * rad;
        if (t > 0.78) {
          P.sprite = SPR_SMOKE;
          P.vx = rng.range(-0.5, 0.5);
          P.vy = rng.range(0.1, 0.9);
          P.vz = rng.range(-0.5, 0.5);
          P.size = rng.range(0.1, 0.2) * sizePow;
          P.sizeEnd = P.size * rng.range(2.5, 4.5);
          P.life = rng.range(0.3, 0.6);
          P.gravity = -0.6;
          P.drag = 3.5;
          P.rot = rng.range(0, Math.PI * 2);
          P.r = 0.42; P.g = 0.045; P.b = 0.035;
          P.r2 = 0.16; P.g2 = 0.02; P.b2 = 0.02;
          P.a = 0.4; P.a2 = 0;
          P.fadeIn = 0.1;
        } else {
          const s = (baseSpeed > 0 ? baseSpeed : rng.range(1.5, 6.5)) * power;
          P.sprite = SPR_BLOOD;
          P.vx = (DIR[0] + ox) * s;
          P.vy = (DIR[1] + oy) * s + rng.range(0.2, 1.6);
          P.vz = (DIR[2] + oz) * s;
          P.size = (baseSize > 0 ? baseSize : rng.range(0.035, 0.12)) * sizePow;
          P.sizeEnd = P.size * rng.range(0.8, 1.3);
          P.life = (baseLife > 0 ? baseLife : rng.range(0.5, 1.2));
          P.gravity = -15;
          P.drag = 0.35;
          P.rot = rng.range(0, Math.PI * 2);
          P.rotVel = rng.range(-4, 4);
          P.r = 0.46; P.g = 0.035; P.b = 0.03;
          P.r2 = 0.2; P.g2 = 0.015; P.b2 = 0.015;
          P.a = 0.95; P.a2 = 0.35;
        }
        break;
      }

      case 'spark':
      case 'ember': {
        readDir(o, 'dir', 0, 1, 0);
        buildBasis();
        const cone = spread >= 0 ? spread : 1.0;
        const ang = rng.range(0, Math.PI * 2);
        const rad = Math.sqrt(rng.next()) * cone;
        const ox = (TAN[0] * Math.cos(ang) + TAN[3] * Math.sin(ang)) * rad;
        const oy = (TAN[1] * Math.cos(ang) + TAN[4] * Math.sin(ang)) * rad;
        const oz = (TAN[2] * Math.cos(ang) + TAN[5] * Math.sin(ang)) * rad;
        const s = (baseSpeed > 0 ? baseSpeed : rng.range(2, 10)) * power;
        P.sprite = name === 'ember' ? SPR_EMBER : SPR_SPARK;
        P.vx = (DIR[0] + ox) * s;
        P.vy = (DIR[1] + oy) * s;
        P.vz = (DIR[2] + oz) * s;
        P.size = (baseSize > 0 ? baseSize : rng.range(0.02, 0.055)) * sizePow;
        P.sizeEnd = P.size * 0.35;
        P.life = (baseLife > 0 ? baseLife : rng.range(0.3, 0.95));
        P.gravity = name === 'ember' ? -1.6 : -11.5;
        P.drag = name === 'ember' ? 1.2 : 0.45;
        P.stretch = name === 'ember' ? 0 : 0.04;
        P.bounce = 0.32;
        P.groundY = groundY;
        P.r = 3.6; P.g = 1.8; P.b = 0.5;
        P.r2 = 1.5; P.g2 = 0.28; P.b2 = 0.04;
        P.a = 1; P.a2 = 0;
        P.emissive = 1;
        P.additive = 1;
        break;
      }

      case 'debris': {
        readDir(o, 'dir', 0, 1, 0);
        buildBasis();
        const cone = spread >= 0 ? spread : 1.1;
        const ang = rng.range(0, Math.PI * 2);
        const rad = Math.sqrt(rng.next()) * cone;
        const ox = (TAN[0] * Math.cos(ang) + TAN[3] * Math.sin(ang)) * rad;
        const oy = (TAN[1] * Math.cos(ang) + TAN[4] * Math.sin(ang)) * rad;
        const oz = (TAN[2] * Math.cos(ang) + TAN[5] * Math.sin(ang)) * rad;
        const s = (baseSpeed > 0 ? baseSpeed : rng.range(2.5, 9)) * power;
        P.sprite = SPR_DEBRIS;
        P.vx = (DIR[0] + ox) * s;
        P.vy = (DIR[1] + oy) * s + rng.range(1, 4);
        P.vz = (DIR[2] + oz) * s;
        P.size = (baseSize > 0 ? baseSize : rng.range(0.05, 0.19)) * sizePow;
        P.sizeEnd = P.size * 0.85;
        P.life = (baseLife > 0 ? baseLife : rng.range(1.0, 2.4));
        P.gravity = -17;
        P.drag = 0.2;
        P.rot = rng.range(0, Math.PI * 2);
        P.rotVel = rng.range(-11, 11);
        P.bounce = 0.28;
        P.groundY = groundY;
        const g = rng.range(0.16, 0.4);
        P.r = g * 1.05; P.g = g; P.b = g * 0.92;
        P.r2 = g * 0.6; P.g2 = g * 0.58; P.b2 = g * 0.55;
        P.a = 1; P.a2 = 0.9;
        break;
      }

      case 'glass': {
        readDir(o, 'dir', 0, 1, 0);
        buildBasis();
        const cone = spread >= 0 ? spread : 1.15;
        const ang = rng.range(0, Math.PI * 2);
        const rad = Math.sqrt(rng.next()) * cone;
        const ox = (TAN[0] * Math.cos(ang) + TAN[3] * Math.sin(ang)) * rad;
        const oy = (TAN[1] * Math.cos(ang) + TAN[4] * Math.sin(ang)) * rad;
        const oz = (TAN[2] * Math.cos(ang) + TAN[5] * Math.sin(ang)) * rad;
        const s = (baseSpeed > 0 ? baseSpeed : rng.range(1.5, 6)) * power;
        P.sprite = SPR_GLASS;
        P.vx = (DIR[0] + ox) * s;
        P.vy = (DIR[1] + oy) * s + rng.range(0.5, 2.5);
        P.vz = (DIR[2] + oz) * s;
        P.size = (baseSize > 0 ? baseSize : rng.range(0.035, 0.115)) * sizePow;
        P.sizeEnd = P.size;
        P.life = (baseLife > 0 ? baseLife : rng.range(0.8, 1.8));
        P.gravity = -16;
        P.drag = 0.2;
        P.rot = rng.range(0, Math.PI * 2);
        P.rotVel = rng.range(-16, 16);
        P.bounce = 0.22;
        P.groundY = groundY;
        P.r = 1.25; P.g = 1.5; P.b = 1.7;
        P.r2 = 0.6; P.g2 = 0.75; P.b2 = 0.9;
        P.a = 0.9; P.a2 = 0;
        P.emissive = 0.25;
        break;
      }

      case 'shell': {
        readDir(o, 'dir', 1, 0, 0);
        buildBasis();
        const s = (baseSpeed > 0 ? baseSpeed : rng.range(1.8, 3.4)) * power;
        P.sprite = SPR_SHELL;
        P.vx = DIR[0] * s + rng.range(-0.5, 0.5);
        P.vy = DIR[1] * s + rng.range(1.6, 3.0);
        P.vz = DIR[2] * s + rng.range(-0.5, 0.5);
        P.size = (baseSize > 0 ? baseSize : 0.055) * sizePow;
        P.sizeEnd = P.size;
        P.life = (baseLife > 0 ? baseLife : rng.range(2.2, 3.4));
        P.gravity = -19;
        P.drag = 0.05;
        P.rot = rng.range(0, Math.PI * 2);
        P.rotVel = rng.range(-24, 24);
        P.bounce = 0.42;
        P.groundY = groundY;
        P.r = 1.35; P.g = 0.9; P.b = 0.3;
        P.r2 = 0.8; P.g2 = 0.52; P.b2 = 0.16;
        P.a = 1; P.a2 = 0;
        P.emissive = 0.2;
        break;
      }

      case 'smoke': {
        const ang = rng.range(0, Math.PI * 2);
        const rad = Math.sqrt(rng.next()) * (spread >= 0 ? spread : 0.55) * power;
        P.sprite = SPR_SMOKE;
        P.vx = Math.cos(ang) * rad;
        P.vy = rng.range(0.5, 2.0) * Math.sqrt(power);
        P.vz = Math.sin(ang) * rad;
        P.size = (baseSize > 0 ? baseSize : rng.range(0.35, 0.75)) * sizePow;
        P.sizeEnd = P.size * rng.range(2.6, 4.4);
        P.life = (baseLife > 0 ? baseLife : rng.range(1.6, 3.6));
        P.gravity = 0.5;
        P.drag = 1.15;
        P.rot = rng.range(0, Math.PI * 2);
        P.rotVel = rng.range(-0.55, 0.55);
        const g = rng.range(0.16, 0.3);
        P.r = g; P.g = g; P.b = g * 1.04;
        P.r2 = g * 0.5; P.g2 = g * 0.5; P.b2 = g * 0.55;
        P.a = rng.range(0.4, 0.7); P.a2 = 0;
        P.fadeIn = 0.2;
        break;
      }

      case 'tireSmoke': {
        const ang = rng.range(0, Math.PI * 2);
        const rad = Math.sqrt(rng.next()) * (spread >= 0 ? spread : 1.1);
        P.sprite = SPR_SMOKE;
        P.vx = Math.cos(ang) * rad;
        P.vy = rng.range(0.4, 1.5);
        P.vz = Math.sin(ang) * rad;
        P.size = (baseSize > 0 ? baseSize : rng.range(0.28, 0.5)) * sizePow;
        P.sizeEnd = P.size * rng.range(3.0, 4.6);
        P.life = (baseLife > 0 ? baseLife : rng.range(0.7, 1.6));
        P.gravity = 0.65;
        P.drag = 2.6;
        P.rot = rng.range(0, Math.PI * 2);
        P.rotVel = rng.range(-1.1, 1.1);
        P.r = 0.5; P.g = 0.49; P.b = 0.48;
        P.r2 = 0.34; P.g2 = 0.34; P.b2 = 0.34;
        P.a = rng.range(0.2, 0.36); P.a2 = 0;
        P.fadeIn = 0.14;
        break;
      }

      case 'skid': {
        const ang = rng.range(0, Math.PI * 2);
        P.sprite = SPR_STREAK;
        P.vx = Math.cos(ang) * rng.range(0.1, 0.6);
        P.vy = rng.range(0.05, 0.35);
        P.vz = Math.sin(ang) * rng.range(0.1, 0.6);
        P.size = (baseSize > 0 ? baseSize : rng.range(0.35, 0.7)) * sizePow;
        P.sizeEnd = P.size * rng.range(1.4, 2.2);
        P.life = (baseLife > 0 ? baseLife : rng.range(1.2, 2.6));
        P.gravity = 0.05;
        P.drag = 3.6;
        P.rot = rng.range(0, Math.PI * 2);
        P.rotVel = rng.range(-0.3, 0.3);
        P.r = 0.11; P.g = 0.105; P.b = 0.1;
        P.r2 = 0.07; P.g2 = 0.07; P.b2 = 0.07;
        P.a = rng.range(0.18, 0.34); P.a2 = 0;
        P.fadeIn = 0.1;
        break;
      }

      case 'exhaust': {
        readDir(o, 'dir', 0, 0, 1);
        const s = (baseSpeed > 0 ? baseSpeed : rng.range(0.4, 1.6)) * power;
        P.sprite = SPR_DUST;
        P.vx = DIR[0] * s + rng.range(-0.25, 0.25);
        P.vy = DIR[1] * s + rng.range(0.15, 0.7);
        P.vz = DIR[2] * s + rng.range(-0.25, 0.25);
        P.size = (baseSize > 0 ? baseSize : rng.range(0.08, 0.16)) * sizePow;
        P.sizeEnd = P.size * rng.range(3.0, 5.0);
        P.life = (baseLife > 0 ? baseLife : rng.range(0.45, 1.0));
        P.gravity = 0.4;
        P.drag = 2.8;
        P.rot = rng.range(0, Math.PI * 2);
        P.rotVel = rng.range(-1.0, 1.0);
        P.r = 0.34; P.g = 0.34; P.b = 0.35;
        P.r2 = 0.22; P.g2 = 0.22; P.b2 = 0.24;
        P.a = rng.range(0.12, 0.26); P.a2 = 0;
        P.fadeIn = 0.16;
        break;
      }

      case 'fire': {
        const ang = rng.range(0, Math.PI * 2);
        const rad = Math.sqrt(rng.next()) * (spread >= 0 ? spread : 0.9) * power;
        P.sprite = t > 0.82 ? SPR_EMBER : SPR_SMOKE;
        P.vx = Math.cos(ang) * rad;
        P.vy = rng.range(1.2, 4.0) * Math.sqrt(power);
        P.vz = Math.sin(ang) * rad;
        P.size = (baseSize > 0 ? baseSize : rng.range(0.22, 0.5)) * sizePow;
        P.sizeEnd = P.size * (t > 0.82 ? 0.2 : rng.range(0.25, 0.6));
        P.life = (baseLife > 0 ? baseLife : rng.range(0.35, 0.85));
        P.gravity = 2.6;
        P.drag = 1.9;
        P.rot = rng.range(0, Math.PI * 2);
        P.rotVel = rng.range(-2.2, 2.2);
        P.r = 4.5; P.g = 1.7; P.b = 0.35;
        P.r2 = 1.4; P.g2 = 0.2; P.b2 = 0.03;
        P.a = rng.range(0.6, 1); P.a2 = 0;
        P.emissive = 1;
        P.additive = 1;
        P.fadeIn = 0.08;
        if (i === 0) {
          P.light = 1;
          P.lightRadius = 8 * power;
          P.lightPower = 2.2 * power;
        }
        break;
      }

      case 'explosion': {
        readDir(o, 'dir', 0, 1, 0);
        buildBasis();
        const ang = rng.range(0, Math.PI * 2);
        const rad = Math.sqrt(rng.next());
        const ox = TAN[0] * Math.cos(ang) + TAN[3] * Math.sin(ang);
        const oy = TAN[1] * Math.cos(ang) + TAN[4] * Math.sin(ang);
        const oz = TAN[2] * Math.cos(ang) + TAN[5] * Math.sin(ang);
        if (i === 0) {
          P.sprite = SPR_FLASH;
          P.size = 2.4 * sizePow;
          P.sizeEnd = 5.5 * sizePow;
          P.life = 0.14;
          P.rot = rng.range(0, Math.PI * 2);
          P.r = 5.0; P.g = 3.4; P.b = 1.7;
          P.r2 = 2.4; P.g2 = 0.9; P.b2 = 0.2;
          P.a = 1; P.a2 = 0;
          P.emissive = 1;
          P.additive = 1;
          P.light = 1;
          P.lightRadius = 26 * power;
          P.lightPower = 14 * power;
        } else if (i === 1) {
          // Shock ring: it has to read as an expanding rim in the first few frames, not as a
          // donut hanging in the air, so it is short lived and fades as it grows.
          P.sprite = SPR_RING;
          P.size = 0.9 * sizePow;
          P.sizeEnd = 6.5 * sizePow;
          P.life = 0.26;
          P.r = 2.2; P.g = 1.5; P.b = 0.9;
          P.r2 = 0.7; P.g2 = 0.35; P.b2 = 0.12;
          P.a = 0.5; P.a2 = 0;
          P.emissive = 1;
          P.additive = 1;
        } else if (t < 0.42) {
          const s = rng.range(3, 13) * power;
          P.sprite = SPR_SMOKE;
          P.vx = ox * rad * s;
          P.vy = oy * rad * s + rng.range(1, 5);
          P.vz = oz * rad * s;
          P.size = rng.range(0.7, 1.5) * sizePow;
          P.sizeEnd = P.size * rng.range(2.0, 3.4);
          P.life = rng.range(0.35, 0.9);
          P.gravity = 2.0;
          P.drag = 1.9;
          P.rot = rng.range(0, Math.PI * 2);
          P.rotVel = rng.range(-1.8, 1.8);
          P.r = 5.2; P.g = 2.1; P.b = 0.45;
          P.r2 = 1.2; P.g2 = 0.2; P.b2 = 0.03;
          P.a = 1; P.a2 = 0;
          P.emissive = 1;
          P.additive = 1;
          P.fadeIn = 0.05;
        } else if (t < 0.78) {
          const s = rng.range(1, 6) * power;
          P.sprite = SPR_SMOKE;
          P.vx = ox * rad * s;
          P.vy = oy * rad * s + rng.range(0.5, 3);
          P.vz = oz * rad * s;
          P.size = rng.range(1.0, 2.2) * sizePow;
          P.sizeEnd = P.size * rng.range(2.4, 4.0);
          P.life = rng.range(1.8, 4.2);
          P.gravity = 0.7;
          P.drag = 1.1;
          P.rot = rng.range(0, Math.PI * 2);
          P.rotVel = rng.range(-0.6, 0.6);
          const g = rng.range(0.09, 0.2);
          P.r = g; P.g = g * 0.96; P.b = g * 0.92;
          P.r2 = g * 0.45; P.g2 = g * 0.45; P.b2 = g * 0.46;
          P.a = rng.range(0.5, 0.85); P.a2 = 0;
          P.fadeIn = 0.12;
        } else if (t < 0.92) {
          const s = rng.range(6, 20) * power;
          P.sprite = SPR_SPARK;
          P.vx = ox * rad * s;
          P.vy = oy * rad * s + rng.range(2, 9);
          P.vz = oz * rad * s;
          P.size = rng.range(0.03, 0.08);
          P.sizeEnd = P.size * 0.3;
          P.life = rng.range(0.5, 1.4);
          P.gravity = -12;
          P.drag = 0.3;
          P.stretch = 0.045;
          P.bounce = 0.3;
          P.groundY = groundY;
          P.r = 4.0; P.g = 2.0; P.b = 0.5;
          P.r2 = 1.5; P.g2 = 0.25; P.b2 = 0.03;
          P.a = 1; P.a2 = 0;
          P.emissive = 1;
          P.additive = 1;
        } else {
          const s = rng.range(4, 14) * power;
          P.sprite = SPR_DEBRIS;
          P.vx = ox * rad * s;
          P.vy = oy * rad * s + rng.range(3, 10);
          P.vz = oz * rad * s;
          P.size = rng.range(0.08, 0.24) * sizePow;
          P.sizeEnd = P.size * 0.9;
          P.life = rng.range(1.4, 3.0);
          P.gravity = -17;
          P.drag = 0.2;
          P.rot = rng.range(0, Math.PI * 2);
          P.rotVel = rng.range(-13, 13);
          P.bounce = 0.25;
          P.groundY = groundY;
          const g = rng.range(0.1, 0.24);
          P.r = g; P.g = g * 0.95; P.b = g * 0.9;
          P.r2 = g * 0.5; P.g2 = g * 0.48; P.b2 = g * 0.46;
          P.a = 1; P.a2 = 0.85;
        }
        break;
      }

      case 'dust': {
        const ang = rng.range(0, Math.PI * 2);
        const rad = Math.sqrt(rng.next()) * (spread >= 0 ? spread : 1.4) * power;
        P.sprite = SPR_DUST;
        P.vx = Math.cos(ang) * rad;
        P.vy = rng.range(0.15, 1.0);
        P.vz = Math.sin(ang) * rad;
        P.size = (baseSize > 0 ? baseSize : rng.range(0.25, 0.55)) * sizePow;
        P.sizeEnd = P.size * rng.range(2.0, 3.4);
        P.life = (baseLife > 0 ? baseLife : rng.range(0.9, 2.2));
        P.gravity = -0.2;
        P.drag = 2.1;
        P.rot = rng.range(0, Math.PI * 2);
        P.rotVel = rng.range(-0.8, 0.8);
        P.r = 0.46; P.g = 0.40; P.b = 0.31;
        P.r2 = 0.3; P.g2 = 0.27; P.b2 = 0.22;
        P.a = rng.range(0.22, 0.42); P.a2 = 0;
        P.fadeIn = 0.16;
        break;
      }

      case 'splash': {
        readDir(o, 'dir', 0, 1, 0);
        buildBasis();
        const ang = rng.range(0, Math.PI * 2);
        const rad = Math.sqrt(rng.next()) * (spread >= 0 ? spread : 0.9);
        const ox = (TAN[0] * Math.cos(ang) + TAN[3] * Math.sin(ang)) * rad;
        const oy = (TAN[1] * Math.cos(ang) + TAN[4] * Math.sin(ang)) * rad;
        const oz = (TAN[2] * Math.cos(ang) + TAN[5] * Math.sin(ang)) * rad;
        if (i === 0) {
          P.sprite = SPR_SPLASH;
          P.size = 0.3 * sizePow;
          P.sizeEnd = 1.3 * sizePow;
          P.life = 0.4;
          P.gravity = 0;
          P.drag = 3;
          P.r = 0.75; P.g = 0.85; P.b = 0.95;
          P.r2 = 0.4; P.g2 = 0.5; P.b2 = 0.62;
          P.a = 0.6; P.a2 = 0;
          P.emissive = 0.15;
        } else {
          const s = (baseSpeed > 0 ? baseSpeed : rng.range(1.2, 4.5)) * power;
          P.sprite = SPR_RAIN;
          P.vx = (DIR[0] + ox) * s;
          P.vy = (DIR[1] + oy) * s + rng.range(0.5, 2.5);
          P.vz = (DIR[2] + oz) * s;
          P.size = (baseSize > 0 ? baseSize : rng.range(0.02, 0.06)) * sizePow;
          P.sizeEnd = P.size * 0.7;
          P.life = (baseLife > 0 ? baseLife : rng.range(0.3, 0.75));
          P.gravity = -13;
          P.drag = 0.5;
          P.stretch = 0.03;
          P.r = 0.7; P.g = 0.8; P.b = 0.95;
          P.r2 = 0.4; P.g2 = 0.5; P.b2 = 0.65;
          P.a = 0.8; P.a2 = 0;
          P.emissive = 0.1;
        }
        break;
      }

      case 'leaf': {
        const ang = rng.range(0, Math.PI * 2);
        const rad = Math.sqrt(rng.next()) * (spread >= 0 ? spread : 1.6) * power;
        P.sprite = SPR_LEAF;
        P.vx = Math.cos(ang) * rad;
        P.vy = rng.range(0.2, 1.8);
        P.vz = Math.sin(ang) * rad;
        P.size = (baseSize > 0 ? baseSize : rng.range(0.07, 0.16)) * sizePow;
        P.sizeEnd = P.size;
        P.life = (baseLife > 0 ? baseLife : rng.range(2.5, 6.0));
        P.gravity = -1.4;
        P.drag = 1.5;
        P.rot = rng.range(0, Math.PI * 2);
        P.rotVel = rng.range(-4.5, 4.5);
        P.flutter = 1;
        const warm = rng.next();
        P.r = 0.18 + warm * 0.36;
        P.g = 0.3 - warm * 0.12;
        P.b = 0.06;
        P.r2 = P.r * 0.6; P.g2 = P.g * 0.6; P.b2 = P.b * 0.6;
        P.a = 1; P.a2 = 0;
        P.fadeIn = 0.05;
        break;
      }

      case 'rain': {
        P.sprite = SPR_RAIN;
        P.x += rng.range(-1, 1) * this.rainRadius;
        P.y += rng.range(0, 6);
        P.z += rng.range(-1, 1) * this.rainRadius;
        P.vx = this.wind[0] * 0.7;
        P.vy = -(baseSpeed > 0 ? baseSpeed : rng.range(15, 21));
        P.vz = this.wind[2] * 0.7;
        P.size = (baseSize > 0 ? baseSize : rng.range(0.012, 0.024));
        P.sizeEnd = P.size;
        P.life = (baseLife > 0 ? baseLife : rng.range(0.9, 1.5));
        P.gravity = -3;
        P.drag = 0.03;
        P.stretch = 0.055;
        P.r = 0.55; P.g = 0.66; P.b = 0.82;
        P.r2 = 0.5; P.g2 = 0.6; P.b2 = 0.78;
        P.a = 0.45; P.a2 = 0.35;
        P.emissive = 0.2;
        P.fadeIn = 0.06;
        break;
      }

      case 'flash':
      case 'ring':
      default: {
        P.sprite = name === 'ring' ? SPR_RING : SPR_FLASH;
        P.size = (baseSize > 0 ? baseSize : 0.8) * sizePow;
        P.sizeEnd = P.size * (name === 'ring' ? 6 : 2.2);
        P.life = (baseLife > 0 ? baseLife : 0.16);
        P.rot = rng.range(0, Math.PI * 2);
        P.r = 3.0; P.g = 2.4; P.b = 1.6;
        P.r2 = 1.2; P.g2 = 0.7; P.b2 = 0.3;
        P.a = 1; P.a2 = 0;
        P.emissive = 1;
        P.additive = 1;
        break;
      }
    }
  }

  /* ------------------------------------------------------------------- rain */

  /**
   * Sets the persistent rain volume intensity. The volume follows the camera and is topped up
   * every `update()`; there is no separate spawner to drive.
   * @param {number} intensity 0 = dry, 1 = downpour.
   * @returns {void}
   */
  rain(intensity) {
    this.rainIntensity = clamp(intensity || 0, 0, 1);
    const budget = Math.min(1400, Math.floor(this.capacity * 0.35));
    this._rainTarget = Math.round(budget * this.rainIntensity);
  }

  /**
   * Tops the rain volume up around the camera.
   * @param {Object} camera Active camera.
   * @returns {void}
   * @private
   */
  _updateRain(camera) {
    const want = this._rainTarget - this._rainAlive;
    if (want <= 0) return;
    const rng = this.rng;
    const pos = camera.position;
    const fwd = camera.forward;
    const cx = pos[0] + (fwd ? fwd[0] : 0) * this.rainRadius * 0.5;
    const cy = pos[1];
    const cz = pos[2] + (fwd ? fwd[2] : 0) * this.rainRadius * 0.5;
    const n = Math.min(want, 260);
    const id = KIND_IDS.rain;
    const speedBase = 15 + this.rainIntensity * 7;
    for (let i = 0; i < n; i++) {
      this._reset(id);
      P.sprite = SPR_RAIN;
      P.x = cx + rng.range(-1, 1) * this.rainRadius;
      P.y = cy + rng.range(7, 15);
      P.z = cz + rng.range(-1, 1) * this.rainRadius;
      const fall = speedBase + rng.range(0, 5);
      P.vx = this.wind[0] * 0.8 + rng.range(-0.4, 0.4);
      P.vy = -fall;
      P.vz = this.wind[2] * 0.8 + rng.range(-0.4, 0.4);
      P.size = rng.range(0.011, 0.022);
      P.sizeEnd = P.size;
      P.life = rng.range(1.1, 1.6);
      P.gravity = -3;
      P.drag = 0.03;
      P.stretch = 0.055;
      P.r = 0.5; P.g = 0.62; P.b = 0.8;
      P.r2 = 0.46; P.g2 = 0.58; P.b2 = 0.78;
      P.a = 0.24 + this.rainIntensity * 0.3;
      P.a2 = P.a * 0.7;
      P.emissive = 0.25;
      P.fadeIn = 0.05;
      P.soft = 0.35;
      const slot = this._commit();
      this.flags[slot] |= FLAG_RAIN;
      this._rainAlive++;
    }
  }

  /* ----------------------------------------------------------------- update */

  /**
   * Advances the simulation, culls dead particles, sorts the alpha set back-to-front and packs
   * the interleaved instance data. O(live), no allocation.
   * @param {number} dt Seconds since the previous frame.
   * @param {Object} [camera] Active camera (used for distance sorting and the rain volume).
   * @returns {void}
   */
  update(dt, camera) {
    if (this.disposed) return;
    const t0 = nowMs();
    const step = clamp(dt || 0, 0, MAX_STEP);
    const stats = this.stats;
    stats.killed = 0;
    stats.lights = 0;

    // The renderer builds this system before `renderer.textures` is assigned, so pick the real
    // sprites up the first frame they exist. Keyed on the library object, so a library without
    // particle sprites is tried exactly once, not once per frame.
    if (this.renderer) {
      const lib = this.renderer.textures || null;
      if (lib !== this._atlasLibrary) {
        this._atlasLibrary = lib;
        if (lib && lib.canvases) this.rebuildAtlas(lib);
      }
    }

    if (this.enabled && this.rainIntensity > 0 && camera && camera.position) this._updateRain(camera);

    const px = this.px;
    const py = this.py;
    const pz = this.pz;
    const vx = this.vx;
    const vy = this.vy;
    const vz = this.vz;
    const life = this.life;
    const lifeMax = this.lifeMax;
    const rot = this.rot;
    const rotVel = this.rotVel;
    const gravity = this.gravity;
    const drag = this.drag;
    const bounce = this.bounce;
    const groundY = this.groundY;
    const flags = this.flags;
    const alphaIdx = this._alphaIdx;
    const alphaKey = this._alphaKey;
    const addIdx = this._addIdx;

    const camX = camera && camera.position ? camera.position[0] : 0;
    const camY = camera && camera.position ? camera.position[1] : 0;
    const camZ = camera && camera.position ? camera.position[2] : 0;
    const windX = this.wind[0];
    const windY = this.wind[1];
    const windZ = this.wind[2];
    const keyScale = SORT_BUCKETS / SORT_RANGE;
    const emitLights = typeof this.onLight === 'function';
    const maxLights = this.maxLights;
    // Rain is a volume, not a shower of individuals: retire drops once they pass the camera
    // instead of letting them fall for their whole life somewhere under the street.
    const rainFloor = camY - 5.5;

    let nAlpha = 0;
    let nAdd = 0;
    let rainAlive = 0;
    let lightCount = 0;
    let i = 0;
    let n = this.count;

    while (i < n) {
      const remain = life[i] - step;
      const f = flags[i];
      if (remain <= 0 || ((f & FLAG_RAIN) !== 0 && py[i] < rainFloor)) {
        // Dead: swap with the tail and push the slot back onto the free list.
        n--;
        if (i !== n) this._swap(i, n);
        stats.killed++;
        continue;
      }
      life[i] = remain;

      const d = drag[i] * step;
      const k = d > 1 ? 1 : d;
      let nvx = vx[i] + (windX - vx[i]) * k;
      let nvy = vy[i] + (windY - vy[i]) * k + gravity[i] * step;
      let nvz = vz[i] + (windZ - vz[i]) * k;

      let nrot = rot[i] + rotVel[i] * step;
      if ((f & FLAG_FLUTTER) !== 0) {
        const s = Math.sin(nrot);
        nvx += s * 1.9 * step;
        nvz += Math.cos(nrot * 0.7) * 1.9 * step;
      }

      let nx = px[i] + nvx * step;
      let ny = py[i] + nvy * step;
      let nz = pz[i] + nvz * step;

      if ((f & FLAG_BOUNCE) !== 0) {
        const gy = groundY[i];
        if (ny < gy && nvy < 0) {
          ny = gy;
          const e = bounce[i];
          nvy = -nvy * e;
          nvx *= 0.68;
          nvz *= 0.68;
          rotVel[i] *= 0.55;
          bounce[i] = e * 0.62;
          if (nvy < 0.35) {
            // Settled: stop moving and let the particle fade out where it landed.
            nvy = 0;
            nvx *= 0.2;
            nvz *= 0.2;
            flags[i] = f & ~FLAG_BOUNCE;
            rotVel[i] = 0;
            gravity[i] = 0;
            drag[i] = 6;
          }
        }
      }

      px[i] = nx;
      py[i] = ny;
      pz[i] = nz;
      vx[i] = nvx;
      vy[i] = nvy;
      vz[i] = nvz;
      rot[i] = nrot;

      if ((f & FLAG_RAIN) !== 0) rainAlive++;

      if ((f & FLAG_LIGHT) !== 0 && emitLights && lightCount < maxLights) {
        const t = 1 - remain / lifeMax[i];
        const fade = 1 - t;
        const power = this.lightPower[i] * fade * fade;
        if (power > 0.02) {
          const inv = 1 / Math.max(this.r0[i], Math.max(this.g0[i], Math.max(this.b0[i], 1e-3)));
          this.onLight(nx, ny, nz,
            this.r0[i] * inv, this.g0[i] * inv, this.b0[i] * inv,
            this.lightRadius[i], power);
          lightCount++;
        }
      }

      if ((f & FLAG_ADDITIVE) !== 0) {
        // Additive blending is order independent, so these never need a distance at all.
        addIdx[nAdd++] = i;
      } else {
        const dx = nx - camX;
        const dy = ny - camY;
        const dz = nz - camZ;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        let bucket = (dist * keyScale) | 0;
        if (bucket < 0) bucket = 0;
        else if (bucket >= SORT_BUCKETS) bucket = SORT_BUCKETS - 1;
        alphaIdx[nAlpha] = i;
        // Ascending key order == descending distance == back to front.
        alphaKey[nAlpha] = SORT_BUCKETS - 1 - bucket;
        nAlpha++;
      }
      i++;
    }

    this.count = n;
    this._rainAlive = rainAlive;
    stats.alive = n;
    stats.alpha = nAlpha;
    stats.additive = nAdd;
    stats.lights = lightCount;

    this._sortAlpha(nAlpha);
    this._pack(nAlpha, nAdd);
    stats.simMs = nowMs() - t0;
    this._upload(nAlpha + nAdd);
    this._drawAlpha = nAlpha;
    this._drawAdditive = nAdd;

    stats.updateMs = nowMs() - t0;
  }

  /**
   * Moves the tail entry over a dead one, which is how the live range stays dense. The source
   * slot is left untouched: the caller has already decremented `count`, so it is back on the
   * free list and will be overwritten by the next spawn.
   * @param {number} a Destination (the dead particle).
   * @param {number} b Source (the current tail).
   * @returns {void}
   * @private
   */
  _swap(a, b) {
    this.px[a] = this.px[b];
    this.py[a] = this.py[b];
    this.pz[a] = this.pz[b];
    this.vx[a] = this.vx[b];
    this.vy[a] = this.vy[b];
    this.vz[a] = this.vz[b];
    this.life[a] = this.life[b];
    this.lifeMax[a] = this.lifeMax[b];
    this.size0[a] = this.size0[b];
    this.size1[a] = this.size1[b];
    this.r0[a] = this.r0[b];
    this.g0[a] = this.g0[b];
    this.b0[a] = this.b0[b];
    this.a0[a] = this.a0[b];
    this.r1[a] = this.r1[b];
    this.g1[a] = this.g1[b];
    this.b1[a] = this.b1[b];
    this.a1[a] = this.a1[b];
    this.rot[a] = this.rot[b];
    this.rotVel[a] = this.rotVel[b];
    this.gravity[a] = this.gravity[b];
    this.drag[a] = this.drag[b];
    this.emissive[a] = this.emissive[b];
    this.stretch[a] = this.stretch[b];
    this.fadeIn[a] = this.fadeIn[b];
    this.soft[a] = this.soft[b];
    this.bounce[a] = this.bounce[b];
    this.groundY[a] = this.groundY[b];
    this.sprite[a] = this.sprite[b];
    this.lightRadius[a] = this.lightRadius[b];
    this.lightPower[a] = this.lightPower[b];
    this.flags[a] = this.flags[b];
    this.kind[a] = this.kind[b];
    this.seq[a] = this.seq[b];
  }

  /**
   * Counting-sorts the alpha index list back to front. O(n + buckets), no allocation, and it
   * moves indices only - the pool data is never reordered.
   * @param {number} n Number of alpha particles.
   * @returns {void}
   * @private
   */
  _sortAlpha(n) {
    if (n <= 1) {
      if (n === 1) this._alphaSorted[0] = this._alphaIdx[0];
      return;
    }
    const keys = this._alphaKey;
    const src = this._alphaIdx;
    const dst = this._alphaSorted;
    const buckets = this._buckets;
    buckets.fill(0, 0, SORT_BUCKETS + 1);
    for (let i = 0; i < n; i++) buckets[keys[i] + 1]++;
    for (let b = 1; b <= SORT_BUCKETS; b++) buckets[b] += buckets[b - 1];
    for (let i = 0; i < n; i++) dst[buckets[keys[i]]++] = src[i];
  }

  /**
   * Evaluates every particle's life curves and writes the interleaved instance records:
   * the sorted alpha block first, then the additive block.
   * @param {number} nAlpha Alpha particle count.
   * @param {number} nAdd Additive particle count.
   * @returns {void}
   * @private
   */
  _pack(nAlpha, nAdd) {
    const out = this._instances;
    const sorted = this._alphaSorted;
    const addIdx = this._addIdx;
    const life = this.life;
    const lifeMax = this.lifeMax;
    const size0 = this.size0;
    const size1 = this.size1;
    const r0 = this.r0;
    const g0 = this.g0;
    const b0 = this.b0;
    const a0 = this.a0;
    const r1 = this.r1;
    const g1 = this.g1;
    const b1 = this.b1;
    const a1 = this.a1;
    const fadeIn = this.fadeIn;
    const px = this.px;
    const py = this.py;
    const pz = this.pz;
    const vx = this.vx;
    const vy = this.vy;
    const vz = this.vz;
    const rot = this.rot;
    const sprite = this.sprite;
    const stretch = this.stretch;
    const emissive = this.emissive;
    const soft = this.soft;
    const total = nAlpha + nAdd;
    let o = 0;

    for (let k = 0; k < total; k++) {
      const i = k < nAlpha ? sorted[k] : addIdx[k - nAlpha];
      const span = lifeMax[i];
      let t = span > 1e-6 ? 1 - life[i] / span : 1;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;

      let env = 1;
      const fi = fadeIn[i];
      if (fi > 1e-4 && t < fi) {
        const u = t / fi;
        env = u * u * (3 - 2 * u);
      }

      const alpha = (a0[i] + (a1[i] - a0[i]) * t) * env;
      out[o] = px[i];
      out[o + 1] = py[i];
      out[o + 2] = pz[i];
      out[o + 3] = size0[i] + (size1[i] - size0[i]) * t;
      out[o + 4] = vx[i];
      out[o + 5] = vy[i];
      out[o + 6] = vz[i];
      out[o + 7] = rot[i];
      out[o + 8] = r0[i] + (r1[i] - r0[i]) * t;
      out[o + 9] = g0[i] + (g1[i] - g0[i]) * t;
      out[o + 10] = b0[i] + (b1[i] - b0[i]) * t;
      out[o + 11] = alpha > 0 ? alpha : 0;
      out[o + 12] = sprite[i];
      out[o + 13] = stretch[i];
      out[o + 14] = emissive[i];
      out[o + 15] = soft[i];
      o += STRIDE;
    }
  }

  /**
   * Uploads the live range of the instance array with a single `bufferSubData`.
   * @param {number} count Instances to upload.
   * @returns {void}
   * @private
   */
  _upload(count) {
    if (count <= 0) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._instances, 0, count * STRIDE);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /* ----------------------------------------------------------------- render */

  /**
   * Draws the particles into the framebuffer that is already bound. Never changes the
   * viewport. Issues at most two instanced draw calls: alpha (back to front) then additive.
   * @param {Object} camera Active camera (needs `viewProj`, `position`, `right`, `up`, `forward`).
   * @returns {void}
   */
  render(camera) {
    this.stats.drawCalls = 0;
    if (this.disposed || !camera || !this.enabled) return;
    const total = this._drawAlpha + this._drawAdditive;
    if (total <= 0) return;

    const gl = this.gl;
    const renderer = this.renderer;

    // Drain pending errors before resolving depth so the feedback probe below sees only what
    // this pass produced - the depth blit itself has to be covered by it as well.
    if (this.softParticles && this._softProbe && this._depthMode !== 2) {
      let guard = 0;
      while (gl.getError() !== gl.NO_ERROR && guard++ < 32) { /* drain */ }
    }
    const depth = this._resolveDepth();
    const soft = !!depth;
    const probe = soft && this._softProbe;
    this.stats.depthMode = soft ? this._depthMode : 2;
    const shader = soft ? this._shaderSoft : this._shaderPlain;
    shader.use();

    shader.setMat4('uViewProj', camera.viewProj);
    shader.setVec3v('uCameraPos', camera.position);
    shader.setVec3v('uCameraRight', camera.right);
    shader.setVec3v('uCameraUp', camera.up);
    shader.setVec3v('uCameraForward', camera.forward);
    shader.setVec2('uNearFade', this.nearFadeStart, this.nearFadeRange);
    shader.setTexture('uAtlas', this.atlas, 0);

    // uSunColor carries the full sun radiance (colour * intensity), exactly like the PBR pass,
    // so the fog tint below matches; the 0.35 wrap-lighting factor lives in the shader.
    if (renderer && renderer.sun) {
      const sun = renderer.sun;
      const s = sun.intensity === undefined ? 1 : sun.intensity;
      shader.setVec3v('uSunDirection', sun.direction);
      shader.setVec3('uSunColor', sun.color[0] * s, sun.color[1] * s, sun.color[2] * s);
      shader.setVec3v('uAmbientSky', sun.ambientSky);
      shader.setVec3v('uAmbientGround', sun.ambientGround);
    } else {
      shader.setVec3('uSunDirection', 0.42, 0.79, 0.45);
      shader.setVec3('uSunColor', 3.4, 3.26, 3.03);
      shader.setVec3('uAmbientSky', 0.22, 0.30, 0.44);
      shader.setVec3('uAmbientGround', 0.10, 0.09, 0.08);
    }
    // Height fog has to be fed with the renderer's own parameters, or a plume above the
    // rooftops fogs differently from the geometry behind it.
    if (renderer && renderer.fog) {
      const fog = renderer.fog;
      shader.setVec3v('uFogColor', fog.color);
      shader.setVec4('uFogParams', fog.density,
        fog.heightFalloff === undefined ? 0 : fog.heightFalloff,
        fog.skyBlend === undefined ? 0 : fog.skyBlend, 0);
    } else {
      shader.setVec3('uFogColor', 0.52, 0.60, 0.70);
      shader.setVec4('uFogParams', 0.0016, 0.018, 0.7, 0);
    }

    if (soft) {
      shader.setTexture('uDepthTex', depth, 1);
      const near = this._depthTex ? this._depthNear : (camera.near || this._depthNear);
      const far = this._depthTex ? this._depthFar : (camera.far || this._depthFar);
      shader.setVec2('uDepthPlanes', near, far);
      shader.setFloat('uSoftDistance', this.softDistance);
    }

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);

    gl.bindVertexArray(this._vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);

    if (this._drawAlpha > 0) {
      // Premultiplied source, so SRC is ONE rather than SRC_ALPHA.
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      shader.setFloat('uAdditive', 0);
      this._pointAt(0);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this._drawAlpha);
      this.stats.drawCalls++;
    }
    if (this._drawAdditive > 0) {
      gl.blendFunc(gl.ONE, gl.ONE);
      shader.setFloat('uAdditive', 1);
      this._pointAt(this._drawAlpha);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this._drawAdditive);
      this.stats.drawCalls++;
    }
    if (probe) this._validateSoft();

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    if (soft) {
      // Never leave the scene depth bound: a later pass rendering into the framebuffer that
      // owns it would trip the same feedback check.
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
    }

    // Leave the pipeline in the renderer's baseline state. The blend equation is untouched,
    // but the function is not: leaving it at (ONE, ONE) hands additive blending to whatever
    // enables GL_BLEND next (HUD overlay, screenshot composite, a later transparent pass).
    gl.disable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
  }

  /**
   * Re-points the four instance attributes at a base instance offset. WebGL2 has no
   * `baseInstance`, so the two blend passes share one buffer through the attribute offset.
   * @param {number} base First instance of the block to draw.
   * @returns {void}
   * @private
   */
  _pointAt(base) {
    const gl = this.gl;
    const offset = base * BYTE_STRIDE;
    for (let i = 0; i < 4; i++) {
      gl.vertexAttribPointer(i, 4, gl.FLOAT, false, BYTE_STRIDE, offset + i * 16);
    }
  }

  /**
   * Picks the depth texture the soft-particle fade will sample this frame, honouring the
   * current feedback-loop verdict: sample the supplied texture directly, sample a private
   * blit copy of it, or return null (soft particles off).
   * @returns {Object|null} Texture to bind, or null.
   * @private
   */
  _resolveDepth() {
    if (!this.softParticles || this._depthMode === 2) return null;
    let source = this._depthTex;
    // Only guess when nobody has ever published a depth texture (standalone use).
    if (!source && !this._depthDriven && this.renderer && this.renderer.hdr) {
      source = this.renderer.hdr.depthTex;
    }
    if (!source || !source.texture) return null;
    if (this._depthMode === 0) return source;
    return this._blitDepth(source);
  }

  /**
   * Copies the bound framebuffer's depth buffer into a private target so it can be sampled
   * without forming a feedback loop. Leaves the caller's framebuffer bound and never touches
   * the viewport (`blitFramebuffer` is viewport independent).
   * @param {Object} source Depth texture whose size the copy must match.
   * @returns {Object|null} The copy's depth texture, or null when it could not be made.
   * @private
   */
  _blitDepth(source) {
    const gl = this.gl;
    const w = Math.max(1, source.width | 0);
    const h = Math.max(1, source.height | 0);
    // Capture the caller's framebuffer FIRST: creating or resizing a RenderTarget rebinds and
    // then clears the FRAMEBUFFER binding, which would silently make the blit read the
    // default framebuffer (and fail on the depth/stencil format mismatch).
    const bound = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    // The copy has to match the source format exactly or the blit is rejected.
    const stencil = source.internalFormat === gl.DEPTH24_STENCIL8 ||
      source.internalFormat === gl.DEPTH32F_STENCIL8;
    if (!this._depthCopy || this._depthCopy.stencil !== stencil) {
      if (this._depthCopy) this._depthCopy.dispose();
      this._depthCopy = null;
      try {
        this._depthCopy = new RenderTarget(gl, w, h, {
          colorCount: 0, depth: true, depthTexture: true, stencil: stencil, wrap: 'clamp'
        });
      } catch (err) {
        this._depthMode = 2;
        this._softProbe = false;
        this.softParticles = false;
        gl.bindFramebuffer(gl.FRAMEBUFFER, bound);
        if (typeof console !== 'undefined') console.warn('[particles] depth copy unavailable:', err);
        return null;
      }
    } else if (this._depthCopy.width !== w || this._depthCopy.height !== h) {
      this._depthCopy.resize(w, h);
    }
    // Some drivers mask blitted depth with DEPTH_WRITEMASK; render() sets it back to false.
    gl.depthMask(true);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, bound);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._depthCopy.framebuffer);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h,
      stencil ? (gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT) : gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, bound);
    return this._depthCopy.depthTex;
  }

  /**
   * Checks whether the soft-particle draw that just ran was legal. Chrome reports a
   * framebuffer feedback loop with `INVALID_OPERATION` when the depth attachment of the bound
   * framebuffer is also sampled - even with depth writes off. The first failure escalates to
   * the private depth copy, a second one turns soft particles off for good, so the pass can
   * never keep throwing errors frame after frame.
   * @returns {void}
   * @private
   */
  _validateSoft() {
    const gl = this.gl;
    const err = gl.getError();
    let guard = 0;
    while (gl.getError() !== gl.NO_ERROR && guard++ < 32) { /* drain the rest */ }
    if (err === gl.NO_ERROR) {
      this._softProbe = false;
      return;
    }
    if (this._depthMode === 0) {
      this._depthMode = 1;
      this._softProbe = true;
      if (typeof console !== 'undefined') {
        console.warn('[particles] depth texture is attached to the bound framebuffer ' +
          '(GL error 0x' + err.toString(16) + '); switching soft particles to a depth copy.');
      }
      return;
    }
    this._depthMode = 2;
    this._softProbe = false;
    this.softParticles = false;
    if (typeof console !== 'undefined') {
      console.warn('[particles] soft particles disabled: the scene depth cannot be sampled ' +
        '(GL error 0x' + err.toString(16) + ').');
    }
  }

  /* ------------------------------------------------------------------ misc */

  /**
   * Removes every live particle.
   * @returns {void}
   */
  clear() {
    this.count = 0;
    this._rainAlive = 0;
    this._recycleCursor = 0;
    this._drawAlpha = 0;
    this._drawAdditive = 0;
    this.stats.alive = 0;
    this.stats.alpha = 0;
    this.stats.additive = 0;
  }

  /**
   * Releases every GPU resource. The instance must not be used afterwards.
   * @returns {void}
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    if (this._buffer) gl.deleteBuffer(this._buffer);
    if (this._vao) gl.deleteVertexArray(this._vao);
    if (this._shaderPlain) this._shaderPlain.dispose();
    if (this._shaderSoft) this._shaderSoft.dispose();
    if (this.atlas && this.atlas.dispose) this.atlas.dispose();
    if (this._depthCopy) this._depthCopy.dispose();
    this._buffer = null;
    this._vao = null;
    this._shaderPlain = null;
    this._shaderSoft = null;
    this.atlas = null;
    this._depthCopy = null;
    this._depthTex = null;
    this.count = 0;
  }
}

export default ParticleSystem;
