/**
 * @file js/render/shaders.js
 * Every GLSL source string used by the NEON CITY forward renderer.
 *
 * There is exactly ONE surface shader ("uber shader"): {@link PBR_VERTEX_SOURCE} /
 * {@link PBR_FRAGMENT_SOURCE}. Feature permutations are selected with `#define`s injected by
 * `core/gl.js` (which also prepends `#version 300 es` and the precision block, so nothing here
 * carries a version line):
 *
 *   USE_MAP           albedo/ORM texture is bound to `uMap`
 *   USE_NORMAL_MAP    tangent-space normal map bound to `uNormalMap` (TBN from derivatives)
 *   USE_VERTEX_COLOR  attribute 3 modulates the base color
 *   USE_INSTANCING    attributes 4..7 carry the model matrix, 8 the rgba tint
 *   ALPHA_TEST        `discard` below `uMatParams.w`
 *   UNLIT             skip the BRDF, emit base color * tint (+ emissive), still fogged
 *   WINDOW_GLOW       night-time emissive window cells driven by a world-space hash
 *   SHADOW_CASCADES n number of cascaded shadow maps (0 disables shadows entirely)
 *   SHADOW_PCF n      0 = single tap, 1 = 3x3 box, 2 = 12-tap rotated Poisson (~5x5)
 *   POINT_LIGHTS n    size of the per-frame point/spot light uniform array (0 disables)
 *   SSAO              modulate ambient with the screen-space AO buffer in `uAoTex`
 *
 * Uniform conventions shared by every permutation are documented next to the sources.
 *
 * @module render/shaders
 */

/**
 * Maximum number of point/spot lights a single draw call may reference.
 * The renderer uploads at most this many indices into the per-frame light arrays.
 * @type {number}
 */
export const MAX_DRAW_LIGHTS = 8;

/**
 * Maximum number of shadow cascades the uber shader can sample (one sampler each).
 * @type {number}
 */
export const MAX_SHADOW_CASCADES = 4;

/* -------------------------------------------------------------------------- */
/* Shared GLSL chunks                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Small hash / noise helpers shared by the window-glow and ripple code.
 * Hashes are the classic Dave Hoskins integer-free formulations: stable across drivers
 * because they only use `fract` and multiplies.
 * @type {string}
 */
export const GLSL_HASH = `
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
`;

/**
 * Cook-Torrance GGX building blocks plus the analytic environment terms.
 * @type {string}
 */
export const GLSL_BRDF = `
const float PI = 3.141592653589793;
const float INV_PI = 0.3183098861837907;

/** GGX / Trowbridge-Reitz normal distribution. 'a' is the perceptual roughness squared. */
float D_GGX(float NoH, float a) {
  float a2 = a * a;
  float d = (NoH * a2 - NoH) * NoH + 1.0;
  return a2 / max(PI * d * d, 1e-8);
}

/** Height-correlated Smith visibility term (already divided by 4*NoL*NoV). */
float V_SmithGGXCorrelated(float NoV, float NoL, float a) {
  float a2 = a * a;
  float lambdaV = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float lambdaL = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(lambdaV + lambdaL, 1e-5);
}

/** Schlick Fresnel. */
vec3 F_Schlick(vec3 f0, float u) {
  float f = pow(1.0 - u, 5.0);
  return f0 + (1.0 - f0) * f;
}

/** Scalar Schlick Fresnel used for the energy-conserving diffuse term. */
float F_Schlick1(float f0, float f90, float u) {
  return f0 + (f90 - f0) * pow(1.0 - u, 5.0);
}

/** Burley (Disney) diffuse, normalised so it stays energy conserving. */
float Fd_Burley(float NoV, float NoL, float LoH, float rough) {
  float f90 = 0.5 + 2.0 * rough * LoH * LoH;
  float lightScatter = F_Schlick1(1.0, f90, NoL);
  float viewScatter = F_Schlick1(1.0, f90, NoV);
  return lightScatter * viewScatter * INV_PI;
}

/** Karis' analytic split-sum environment BRDF approximation. */
vec3 envBRDFApprox(vec3 f0, float rough, float NoV) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  vec2 ab = vec2(-1.04, 1.04) * a004 + r.zw;
  return f0 * ab.x + ab.y;
}

/** Inverse-square point light falloff with a smooth cutoff at the light radius. */
float distanceAttenuation(float distSq, float radius) {
  float invR2 = 1.0 / max(radius * radius, 1e-4);
  float factor = distSq * invR2;
  float smoothF = clamp(1.0 - factor * factor, 0.0, 1.0);
  return (smoothF * smoothF) / max(distSq, 1e-4);
}
`;

/**
 * Analytic exponential height fog with an aerial-perspective sun tint.
 * @type {string}
 */
export const GLSL_FOG = `
/**
 * Integrates exp(-heightFalloff * y) along the view ray, giving distance + height fog in one term.
 * params: x = density, y = height falloff, z = sun scatter amount, w = unused.
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
`;

/**
 * Wet-surface response: raises reflectance, drops roughness and adds an animated ripple
 * normal on upward facing surfaces while it rains.
 * @type {string}
 */
export const GLSL_WETNESS = `
/** Analytic gradient of a small sum-of-sines ripple field (cheap, tileless enough). */
vec2 rippleGradient(vec2 p, float t) {
  vec2 g = vec2(0.0);
  vec2 d0 = vec2(0.8321, 0.5547);
  vec2 d1 = vec2(-0.6, 0.8);
  vec2 d2 = vec2(0.3162, -0.9487);
  float k0 = 5.3, k1 = 8.1, k2 = 12.7;
  g += d0 * k0 * cos(dot(p, d0) * k0 - t * 7.0) * 0.030;
  g += d1 * k1 * cos(dot(p, d1) * k1 + t * 9.5) * 0.016;
  g += d2 * k2 * cos(dot(p, d2) * k2 - t * 13.0) * 0.008;
  return g;
}
`;

/* -------------------------------------------------------------------------- */
/* Uber shader - vertex                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Vertex stage of the uber shader.
 *
 * Attributes follow the fixed `core/gl.js` layout (0 position, 1 normal, 2 uv, 3 color,
 * 4..7 instance model matrix columns, 8 instance rgba tint).
 *
 * Uniforms: `uViewProj`, `uCameraPos`, `uCameraForward`, `uModel`, `uNormalMatrix`, `uTint`,
 * `uUvTransform` (scale.xy, offset.zw).
 * @type {string}
 */
export const PBR_VERTEX_SOURCE = `
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
layout(location = 3) in vec3 aColor;
#ifdef USE_INSTANCING
layout(location = 4) in vec4 aInstance0;
layout(location = 5) in vec4 aInstance1;
layout(location = 6) in vec4 aInstance2;
layout(location = 7) in vec4 aInstance3;
layout(location = 8) in vec4 aInstanceTint;
#endif

uniform mat4 uViewProj;
uniform vec3 uCameraPos;
uniform vec3 uCameraForward;
uniform vec4 uUvTransform;
#ifndef USE_INSTANCING
uniform mat4 uModel;
uniform mat3 uNormalMatrix;
uniform vec4 uTint;
#endif

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUv;
out vec4 vTint;
out float vViewZ;

void main() {
#ifdef USE_INSTANCING
  mat4 model = mat4(aInstance0, aInstance1, aInstance2, aInstance3);
  mat3 m3 = mat3(model);
  // Cofactor matrix == det(M) * inverse-transpose: correct normals under non-uniform scale.
  mat3 nrm = mat3(cross(m3[1], m3[2]), cross(m3[2], m3[0]), cross(m3[0], m3[1]));
  vec4 tint = aInstanceTint;
#else
  mat4 model = uModel;
  mat3 nrm = uNormalMatrix;
  vec4 tint = uTint;
#endif

  vec4 world = model * vec4(aPosition, 1.0);
  vWorldPos = world.xyz;
  vNormal = normalize(nrm * aNormal);
  vUv = aUv * uUvTransform.xy + uUvTransform.zw;
#ifdef USE_VERTEX_COLOR
  tint.rgb *= aColor;
#endif
  vTint = tint;
  vViewZ = dot(world.xyz - uCameraPos, uCameraForward);
  gl_Position = uViewProj * world;
}
`;

/* -------------------------------------------------------------------------- */
/* Uber shader - fragment                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Fragment stage of the uber shader: full Cook-Torrance GGX with a metallic workflow,
 * analytic hemisphere ambient + ambient specular, cascaded shadows, clustered-per-draw
 * point/spot lights, night window glow, wetness and height fog.
 *
 * Frame uniforms: `uCameraPos`, `uTime`, `uSunDirection` (towards the sun), `uSunColor`
 * (colour * intensity), `uAmbientSky`, `uAmbientGround`, `uFogColor`, `uFogParams`
 * (density, heightFalloff, sunScatter, unused), `uNightFactor`, `uGlobalWet` (wetness, rain),
 * `uShadowParams` (strength, normalBias, depthBias, 1/shadowRes), `uLightViewProj[]`,
 * `uCascadeSplit[]`, `uCascadeTexel[]`, `uShadowMap0..3`, `uLightPosRadius[]`, `uLightColor[]`,
 * `uLightDir[]`, `uResolution`, `uAoTex`.
 *
 * Material uniforms: `uBaseColor` (rgb, alpha), `uMatParams` (roughness, metallic, reflectance,
 * alphaCutoff), `uMatParams2` (wetness, normalScale, windowGrid, windowGlow),
 * `uEmissive` (rgb premultiplied by strength, w unused), `uMap`, `uNormalMap`.
 *
 * Draw uniforms: `uEmissiveBoost`, `uLightIndex[MAX_DRAW_LIGHTS]`, `uLightCount`.
 * @type {string}
 */
export const PBR_FRAGMENT_SOURCE = `
in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUv;
in vec4 vTint;
in float vViewZ;

out vec4 fragColor;

uniform vec3 uCameraPos;
uniform float uTime;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uAmbientSky;
uniform vec3 uAmbientGround;
uniform vec3 uFogColor;
uniform vec4 uFogParams;
uniform float uNightFactor;
uniform vec2 uGlobalWet;

uniform vec4 uBaseColor;
uniform vec4 uMatParams;
uniform vec4 uMatParams2;
uniform vec4 uEmissive;
uniform float uEmissiveBoost;

#ifdef USE_MAP
uniform sampler2D uMap;
#endif
#ifdef USE_NORMAL_MAP
uniform sampler2D uNormalMap;
#endif
#ifdef SSAO
uniform sampler2D uAoTex;
uniform vec2 uResolution;
#endif

#if SHADOW_CASCADES > 0
uniform mat4 uLightViewProj[SHADOW_CASCADES];
uniform float uCascadeSplit[SHADOW_CASCADES];
uniform float uCascadeTexel[SHADOW_CASCADES];
uniform vec4 uShadowParams;
uniform sampler2D uShadowMap0;
#if SHADOW_CASCADES > 1
uniform sampler2D uShadowMap1;
#endif
#if SHADOW_CASCADES > 2
uniform sampler2D uShadowMap2;
#endif
#if SHADOW_CASCADES > 3
uniform sampler2D uShadowMap3;
#endif
#endif

#if POINT_LIGHTS > 0
uniform vec4 uLightPosRadius[POINT_LIGHTS];
uniform vec4 uLightColor[POINT_LIGHTS];
uniform vec4 uLightDir[POINT_LIGHTS];
uniform int uLightIndex[MAX_DRAW_LIGHTS];
uniform int uLightCount;
#endif

${GLSL_HASH}
${GLSL_BRDF}
${GLSL_FOG}
${GLSL_WETNESS}

/* ----------------------------------------------------------------- shadows */
#if SHADOW_CASCADES > 0
const vec2 POISSON[12] = vec2[12](
  vec2(-0.3245, 0.7654), vec2(0.4321, 0.8123), vec2(-0.8532, 0.2011),
  vec2(0.8912, 0.1234), vec2(-0.6123, -0.5321), vec2(0.1523, -0.9123),
  vec2(0.6721, -0.6231), vec2(-0.1234, 0.1234), vec2(0.2311, 0.3521),
  vec2(-0.4512, -0.1123), vec2(0.0231, 0.6812), vec2(-0.9123, -0.2312)
);

/** Percentage-closer filtering of one cascade. 'texel' is 1/shadowResolution. */
float pcfShadow(sampler2D map, vec3 coord, float texel) {
#if SHADOW_PCF == 0
  float d = texture(map, coord.xy).r;
  return coord.z <= d ? 1.0 : 0.0;
#elif SHADOW_PCF == 1
  float sum = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      float d = texture(map, coord.xy + vec2(float(x), float(y)) * texel).r;
      sum += coord.z <= d ? 1.0 : 0.0;
    }
  }
  return sum * (1.0 / 9.0);
#else
  float angle = hash12(gl_FragCoord.xy) * 6.2831853;
  float sa = sin(angle);
  float ca = cos(angle);
  mat2 rot = mat2(ca, sa, -sa, ca);
  float sum = 0.0;
  for (int i = 0; i < 12; i++) {
    vec2 o = rot * POISSON[i] * texel * 2.5;
    float d = texture(map, coord.xy + o).r;
    sum += coord.z <= d ? 1.0 : 0.0;
  }
  return sum * (1.0 / 12.0);
#endif
}

/** Projects into cascade 'ci' (with normal-offset bias) and filters it. 1 = fully lit. */
float shadowFromCascade(int ci, vec3 worldPos, vec3 N, float NoL) {
  float texelWorld = uCascadeTexel[ci];
  float slope = clamp(1.0 - NoL, 0.0, 1.0);
  vec3 offsetPos = worldPos + N * (texelWorld * uShadowParams.y * (1.0 + slope * 2.0));
  vec4 lp = uLightViewProj[ci] * vec4(offsetPos, 1.0);
  vec3 c = lp.xyz / lp.w;
  c = c * 0.5 + 0.5;
  if (c.z >= 1.0 || c.x < 0.002 || c.x > 0.998 || c.y < 0.002 || c.y > 0.998) return 1.0;
  c.z -= uShadowParams.z * (1.0 + slope * 3.0);
  float texel = uShadowParams.w;
  if (ci == 0) return pcfShadow(uShadowMap0, c, texel);
#if SHADOW_CASCADES > 1
  else if (ci == 1) return pcfShadow(uShadowMap1, c, texel);
#endif
#if SHADOW_CASCADES > 2
  else if (ci == 2) return pcfShadow(uShadowMap2, c, texel);
#endif
#if SHADOW_CASCADES > 3
  else if (ci == 3) return pcfShadow(uShadowMap3, c, texel);
#endif
  return 1.0;
}

/** Selects a cascade from the view depth and cross-fades over the split boundary. */
float sunShadow(vec3 worldPos, vec3 N, float NoL) {
  if (uShadowParams.x <= 0.0) return 1.0;
  int ci = -1;
  for (int i = 0; i < SHADOW_CASCADES; i++) {
    if (vViewZ < uCascadeSplit[i]) { ci = i; break; }
  }
  if (ci < 0) return 1.0;
  float s = shadowFromCascade(ci, worldPos, N, NoL);
  float far = uCascadeSplit[ci];
  float band = max(far * 0.12, 1.0);
  float blend = smoothstep(far - band, far, vViewZ);
  if (blend > 0.0) {
    float s2 = 1.0;
    if (ci + 1 < SHADOW_CASCADES) s2 = shadowFromCascade(ci + 1, worldPos, N, NoL);
    s = mix(s, s2, blend);
  }
  return mix(1.0, s, uShadowParams.x);
}
#endif

/* -------------------------------------------------------------- normal map */
#ifdef USE_NORMAL_MAP
/** Per-pixel tangent frame from screen-space derivatives (no tangent attribute needed). */
mat3 cotangentFrame(vec3 N, vec3 p, vec2 uv) {
  vec3 dp1 = dFdx(p);
  vec3 dp2 = dFdy(p);
  vec2 duv1 = dFdx(uv);
  vec2 duv2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, N);
  vec3 dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float invmax = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-8));
  return mat3(T * invmax, B * invmax, N);
}
#endif

/* ------------------------------------------------------------ window glow */
#ifdef WINDOW_GLOW
/**
 * Deterministic night-time window lighting. The world position is quantised to a window-sized
 * cell, hashed, and a subset of the cells is lit with a warm (occasionally TV-blue) colour that
 * drifts slowly over time. 'mask' comes from the albedo texture alpha channel.
 */
vec3 windowGlow(vec3 worldPos, float mask, float amount) {
  if (amount <= 0.0 || mask <= 0.001) return vec3(0.0);
  vec3 cell = vec3(3.05, 3.35, 3.05);
  vec3 id = floor(worldPos / cell + 0.5);
  float h = hash13(id);
  float h2 = hash13(id + vec3(17.13, 5.71, 91.7));
  float h3 = hash13(id + vec3(41.31, 77.7, 13.3));
  // Occupancy re-rolls every ~50 s so the skyline keeps changing without ever flashing.
  float phase = floor(uTime * 0.02 + h3 * 11.0);
  float occ = hash13(id + vec3(phase * 3.77, phase * 1.31, phase * 7.13));
  float lit = smoothstep(0.34, 0.46, mix(h, occ, 0.4));
  if (lit <= 0.0) return vec3(0.0);
  vec3 warm = mix(vec3(1.0, 0.66, 0.30), vec3(1.0, 0.90, 0.70), h2);
  vec3 cold = vec3(0.42, 0.68, 1.0);
  vec3 col = mix(warm, cold, step(0.90, h3) * 0.9);
  float flicker = 0.90 + 0.10 * sin(uTime * (0.7 + h2 * 2.6) + h * 51.0);
  float bright = 0.45 + 1.55 * h2 * h2;
  return col * (lit * mask * amount * bright * flicker);
}
#endif

void main() {
  vec4 base = uBaseColor * vTint;
#ifdef USE_MAP
  vec4 texel = texture(uMap, vUv);
  base.rgb *= texel.rgb;
#ifndef WINDOW_GLOW
  base.a *= texel.a;
#endif
#endif

#ifdef ALPHA_TEST
  if (base.a < uMatParams.w) discard;
#endif

  vec3 emissive = uEmissive.rgb * uEmissiveBoost;

#ifdef WINDOW_GLOW
#ifdef USE_MAP
  float winMask = texel.a;
#else
  vec2 wg = fract(vUv * uMatParams2.z);
  float winMask = step(0.14, wg.x) * step(wg.x, 0.86) * step(0.18, wg.y) * step(wg.y, 0.82);
#endif
  emissive += windowGlow(vWorldPos, winMask, uMatParams2.w * uNightFactor) * uEmissiveBoost;
#endif

#ifdef UNLIT
  vec3 color = base.rgb + emissive;
#else
  vec3 geoN = normalize(vNormal);
  if (!gl_FrontFacing) geoN = -geoN;
  vec3 N = geoN;
  vec3 V = normalize(uCameraPos - vWorldPos);

#ifdef USE_NORMAL_MAP
  vec3 tn = texture(uNormalMap, vUv).xyz * 2.0 - 1.0;
  tn.xy *= uMatParams2.y;
  N = normalize(cotangentFrame(geoN, vWorldPos, vUv) * normalize(tn));
#endif

  float roughness = clamp(uMatParams.x, 0.035, 1.0);
  float metallic = clamp(uMatParams.y, 0.0, 1.0);
  float reflectance = uMatParams.z;
  vec3 albedo = base.rgb;

  // --- wetness: darker, smoother, more reflective, ripples on upward faces ---------------
  float wetness = clamp(uGlobalWet.x * uMatParams2.x, 0.0, 1.0);
  if (wetness > 0.0) {
    float up = clamp(geoN.y, 0.0, 1.0);
    float wet = wetness * (0.25 + 0.75 * up * up);
    albedo *= mix(1.0, 0.68, wet);
    roughness = mix(roughness, 0.055, wet * 0.9);
    reflectance = mix(reflectance, 0.16, wet);
    float rain = uGlobalWet.y * up;
    if (rain > 0.0) {
      vec2 g = rippleGradient(vWorldPos.xz, uTime) * rain * (0.35 + 0.65 * wetness);
      N = normalize(N + vec3(g.x, 0.0, g.y));
    }
  }

  float a = roughness * roughness;
  vec3 f0 = mix(vec3(0.16 * reflectance * reflectance), albedo, metallic);
  vec3 diffuseColor = albedo * (1.0 - metallic);
  float NoV = clamp(dot(N, V), 1e-4, 1.0);

  vec3 color = vec3(0.0);

  // --- sun ------------------------------------------------------------------------------
  vec3 L = uSunDirection;
  float NoL = dot(N, L);
  if (NoL > 0.0) {
    vec3 H = normalize(V + L);
    float NoH = clamp(dot(N, H), 0.0, 1.0);
    float LoH = clamp(dot(L, H), 0.0, 1.0);
    float shadow = 1.0;
#if SHADOW_CASCADES > 0
    shadow = sunShadow(vWorldPos, geoN, clamp(dot(geoN, L), 0.0, 1.0));
#endif
    if (shadow > 0.0) {
      float D = D_GGX(NoH, a);
      float Vis = V_SmithGGXCorrelated(NoV, NoL, a);
      vec3 F = F_Schlick(f0, LoH);
      vec3 spec = D * Vis * F;
      vec3 diff = diffuseColor * Fd_Burley(NoV, NoL, LoH, roughness);
      color += (diff + spec) * uSunColor * (NoL * shadow);
    }
  }

  // --- ambient: analytic hemisphere + cheap specular probe --------------------------------
  float ao = 1.0;
#ifdef SSAO
  ao = texture(uAoTex, gl_FragCoord.xy / uResolution).r;
#endif
  vec3 hemi = mix(uAmbientGround, uAmbientSky, N.y * 0.5 + 0.5);
  color += diffuseColor * hemi * ao;

  vec3 R = reflect(-V, N);
  vec3 envSharp = mix(uAmbientGround, uAmbientSky, smoothstep(-0.35, 0.45, R.y));
  vec3 envAvg = (uAmbientSky + uAmbientGround) * 0.5;
  vec3 env = mix(envSharp, envAvg, roughness * roughness);
  // Roughness-dependent horizon fade: rough surfaces keep grazing energy, mirrors lose it.
  float horizon = clamp(1.0 + dot(R, geoN), 0.0, 1.0);
  horizon = mix(1.0, horizon * horizon, 1.0 - roughness * 0.75);
  float specAo = clamp(pow(ao, 1.0 + roughness), 0.0, 1.0);
  color += env * envBRDFApprox(f0, roughness, NoV) * (horizon * specAo);

  // --- punctual lights (already culled to this draw call) ---------------------------------
#if POINT_LIGHTS > 0
  for (int i = 0; i < MAX_DRAW_LIGHTS; i++) {
    if (i >= uLightCount) break;
    int li = clamp(uLightIndex[i], 0, POINT_LIGHTS - 1);
    vec4 posRadius = uLightPosRadius[li];
    vec3 toLight = posRadius.xyz - vWorldPos;
    float distSq = dot(toLight, toLight);
    if (distSq > posRadius.w * posRadius.w) continue;
    float atten = distanceAttenuation(distSq, posRadius.w);
    if (atten <= 0.0) continue;
    vec3 Lp = toLight * inversesqrt(max(distSq, 1e-8));
    float NoLp = dot(N, Lp);
    if (NoLp <= 0.0) continue;
    vec4 lc = uLightColor[li];
    vec4 ld = uLightDir[li];
    // Spot cone: scale/offset encoding, point lights use scale 0 / offset 1.
    float cd = dot(ld.xyz, -Lp);
    float cone = clamp(cd * lc.w + ld.w, 0.0, 1.0);
    cone *= cone;
    if (cone <= 0.0) continue;
    vec3 Hp = normalize(V + Lp);
    float NoHp = clamp(dot(N, Hp), 0.0, 1.0);
    float LoHp = clamp(dot(Lp, Hp), 0.0, 1.0);
    float D = D_GGX(NoHp, a);
    float Vis = V_SmithGGXCorrelated(NoV, NoLp, a);
    vec3 F = F_Schlick(f0, LoHp);
    vec3 diff = diffuseColor * Fd_Burley(NoV, NoLp, LoHp, roughness);
    color += (diff + D * Vis * F) * lc.rgb * (NoLp * atten * cone);
  }
#endif

  color += emissive;
#endif

  // --- fog --------------------------------------------------------------------------------
  float fog = fogAmount(uCameraPos, vWorldPos, uFogParams.xy);
  if (fog > 0.0) {
    vec3 viewDir = normalize(vWorldPos - uCameraPos);
    float sunAmount = clamp(dot(viewDir, uSunDirection), 0.0, 1.0);
    vec3 fogCol = mix(uFogColor, uFogColor + uSunColor * 0.35,
      pow(sunAmount, 8.0) * uFogParams.z);
    color = mix(color, fogCol, fog);
  }

  fragColor = vec4(color, base.a);
}
`;

/* -------------------------------------------------------------------------- */
/* Shadow (depth only) shader                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Depth-only vertex stage used by the cascaded shadow pass.
 * Uniforms: `uLightViewProj`, `uModel`, `uUvTransform`.
 * @type {string}
 */
export const SHADOW_VERTEX_SOURCE = `
layout(location = 0) in vec3 aPosition;
layout(location = 2) in vec2 aUv;
#ifdef USE_INSTANCING
layout(location = 4) in vec4 aInstance0;
layout(location = 5) in vec4 aInstance1;
layout(location = 6) in vec4 aInstance2;
layout(location = 7) in vec4 aInstance3;
#endif

uniform mat4 uLightViewProj;
uniform vec4 uUvTransform;
#ifndef USE_INSTANCING
uniform mat4 uModel;
#endif

out vec2 vUv;

void main() {
#ifdef USE_INSTANCING
  mat4 model = mat4(aInstance0, aInstance1, aInstance2, aInstance3);
#else
  mat4 model = uModel;
#endif
  vUv = aUv * uUvTransform.xy + uUvTransform.zw;
  gl_Position = uLightViewProj * (model * vec4(aPosition, 1.0));
}
`;

/**
 * Depth-only fragment stage. Writes nothing unless ALPHA_TEST is on, in which case it
 * discards masked-out texels so foliage and fences cast correct shadows.
 * @type {string}
 */
export const SHADOW_FRAGMENT_SOURCE = `
in vec2 vUv;

#ifdef ALPHA_TEST
uniform vec4 uBaseColor;
uniform vec4 uMatParams;
#ifdef USE_MAP
uniform sampler2D uMap;
#endif
#endif

void main() {
#ifdef ALPHA_TEST
  float a = uBaseColor.a;
#ifdef USE_MAP
  a *= texture(uMap, vUv).a;
#endif
  if (a < uMatParams.w) discard;
#endif
}
`;

/* -------------------------------------------------------------------------- */
/* Fullscreen helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Vertex shader for `drawFullscreen(gl)`: builds an oversized triangle from `gl_VertexID`
 * and hands the fragment stage a `vUv` in [0,1]. Reusable by sky / post FX modules.
 * @type {string}
 */
export const FULLSCREEN_VERTEX_SOURCE = `
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * Minimal exposure + ACES tonemap blit. The renderer only uses it as a safety net when
 * `render/postfx.js` is unavailable, so the game still shows a correct image.
 * Uniforms: `uSource`, `uExposure`.
 * @type {string}
 */
export const BLIT_FRAGMENT_SOURCE = `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSource;
uniform float uExposure;

vec3 acesFilm(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec3 hdr = texture(uSource, vUv).rgb * uExposure;
  vec3 mapped = acesFilm(hdr);
  fragColor = vec4(pow(mapped, vec3(1.0 / 2.2)), 1.0);
}
`;
