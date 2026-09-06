/**
 * @file js/render/materials.js
 * Material definition and uniform packing for the NEON CITY uber shader.
 *
 * A Material is a plain data object plus a handful of preallocated `Float32Array`s holding the
 * exact uniform payloads the shader expects, so binding a material never allocates. Materials
 * also carry the feature bitmask that selects the shader permutation; the renderer combines that
 * mask with the global (quality dependent) shader context to obtain a program cache key, which
 * means hundreds of materials share a handful of programs.
 *
 * @module render/materials
 */

/**
 * Feature bits used to build shader permutations.
 * @enum {number}
 */
export const MATERIAL_FLAGS = {
  MAP: 1 << 0,
  NORMAL_MAP: 1 << 1,
  VERTEX_COLOR: 1 << 2,
  ALPHA_TEST: 1 << 3,
  WINDOW_GLOW: 1 << 4,
  UNLIT: 1 << 5,
  NO_SHADOW: 1 << 6,
  INSTANCED: 1 << 7
};

/** Texture unit assignment shared by the renderer and the uber shader. @enum {number} */
export const TEXTURE_UNITS = {
  MAP: 0,
  NORMAL_MAP: 1,
  AO: 2,
  SHADOW0: 3
};

/** Draw queue ids: opaque first (front-to-back), transparent afterwards (back-to-front). */
export const QUEUE_OPAQUE = 0;
/** @type {number} */
export const QUEUE_TRANSPARENT = 1;

/** Monotonic material id, used as a secondary sort key so state changes cluster. */
let nextMaterialId = 1;

/**
 * Copies up to `n` numbers from `src` into `dst`, falling back to `def` when absent.
 * @param {Float32Array} dst Destination.
 * @param {ArrayLike<number>|null|undefined} src Source values.
 * @param {number[]} def Default values.
 * @param {number} n Element count.
 * @returns {void}
 */
function copyN(dst, src, def, n) {
  for (let i = 0; i < n; i++) {
    const v = src && src[i] !== undefined ? src[i] : def[i];
    dst[i] = typeof v === 'number' && isFinite(v) ? v : def[i];
  }
}

/**
 * Recomputes the cached feature mask, queue and uniform payloads of a material.
 * Called by {@link createMaterial} and {@link updateMaterial}; never on the hot path.
 * @param {Object} mat Material to refresh.
 * @returns {Object} The same material.
 */
function refreshMaterial(mat) {
  let flags = 0;
  if (mat.map) flags |= MATERIAL_FLAGS.MAP;
  if (mat.normalMap) flags |= MATERIAL_FLAGS.NORMAL_MAP;
  if (mat.vertexColors) flags |= MATERIAL_FLAGS.VERTEX_COLOR;
  if (mat.alphaTest > 0) flags |= MATERIAL_FLAGS.ALPHA_TEST;
  if (mat.windowGlow > 0) flags |= MATERIAL_FLAGS.WINDOW_GLOW;
  if (mat.unlit) flags |= MATERIAL_FLAGS.UNLIT;
  if (!mat.receiveShadow) flags |= MATERIAL_FLAGS.NO_SHADOW;
  mat.flags = flags;

  mat.queue = mat.blend === 'opaque' ? QUEUE_OPAQUE : QUEUE_TRANSPARENT;
  mat.additive = mat.blend === 'add';

  const base = mat._baseColor;
  base[0] = mat.albedo[0];
  base[1] = mat.albedo[1];
  base[2] = mat.albedo[2];
  base[3] = mat.alpha;

  const p = mat._params;
  p[0] = mat.roughness;
  p[1] = mat.metallic;
  p[2] = mat.reflectance;
  p[3] = mat.alphaTest;

  const p2 = mat._params2;
  p2[0] = mat.wetness;
  p2[1] = mat.normalScale;
  p2[2] = mat.windowGrid;
  p2[3] = mat.windowGlow;

  const e = mat._emissive;
  e[0] = mat.emissive[0] * mat.emissiveStrength;
  e[1] = mat.emissive[1] * mat.emissiveStrength;
  e[2] = mat.emissive[2] * mat.emissiveStrength;
  e[3] = mat.emissiveStrength;

  const uv = mat._uv;
  uv[0] = mat.uvScale[0];
  uv[1] = mat.uvScale[1];
  uv[2] = mat.uvOffset[0];
  uv[3] = mat.uvOffset[1];

  mat.version++;
  return mat;
}

/**
 * Creates a material.
 *
 * @param {Object} [desc] Material description; every field is optional.
 * @param {string} [desc.name] Debug name.
 * @param {number[]} [desc.albedo] Linear base colour, default `[1,1,1]`.
 * @param {number} [desc.roughness] Perceptual roughness 0..1, default 0.8.
 * @param {number} [desc.metallic] Metalness 0..1, default 0.
 * @param {number[]} [desc.emissive] Linear emissive colour, default `[0,0,0]`.
 * @param {number} [desc.emissiveStrength] Multiplier for `emissive`, default 1.
 * @param {Object} [desc.map] Albedo texture (`Texture2D`); its alpha is the window mask when
 *   `windowGlow > 0`, otherwise an opacity mask.
 * @param {Object} [desc.normalMap] Tangent-space normal map.
 * @param {Object} [desc.ormMap] Occlusion/roughness/metallic map (accepted, currently unused
 *   by the shader; kept so world code can attach it without breaking).
 * @param {number} [desc.normalScale] Normal map strength, default 1.
 * @param {number[]} [desc.uvScale] UV scale, default `[1,1]`.
 * @param {number[]} [desc.uvOffset] UV offset, default `[0,0]`.
 * @param {number} [desc.alpha] Opacity, default 1.
 * @param {number} [desc.alphaTest] Alpha cutoff (0 disables the ALPHA_TEST permutation).
 * @param {string} [desc.blend] `'opaque'` | `'alpha'` | `'add'`, default `'opaque'`.
 * @param {boolean} [desc.doubleSided] Disable back-face culling, default false.
 * @param {boolean} [desc.castShadow] Include in the shadow pass, default true.
 * @param {boolean} [desc.receiveShadow] Sample the cascades, default true.
 * @param {boolean} [desc.vertexColors] Use attribute 3, default false.
 * @param {number} [desc.windowGlow] 0..1 night window emission amount, default 0.
 * @param {number} [desc.windowGrid] Window cells per uv unit when there is no map, default 4.
 * @param {number} [desc.reflectance] Dielectric reflectance 0..1 (0.5 == 4%), default 0.5.
 * @param {boolean} [desc.unlit] Skip lighting entirely, default false.
 * @param {boolean} [desc.depthWrite] Write depth; defaults to true for opaque, false otherwise.
 * @param {boolean} [desc.depthTest] Depth test, default true.
 * @param {number} [desc.sortBias] Added to the sort depth (metres), default 0.
 * @param {number} [desc.wetness] How much global wetness affects this surface, default 1.
 * @returns {Object} The new material.
 */
export function createMaterial(desc = {}) {
  const blend = desc.blend === 'alpha' || desc.blend === 'add' ? desc.blend : 'opaque';
  const mat = {
    id: nextMaterialId++,
    name: desc.name || 'material',
    version: 0,

    albedo: [1, 1, 1],
    roughness: desc.roughness === undefined ? 0.8 : desc.roughness,
    metallic: desc.metallic === undefined ? 0 : desc.metallic,
    emissive: [0, 0, 0],
    emissiveStrength: desc.emissiveStrength === undefined ? 1 : desc.emissiveStrength,

    map: desc.map || null,
    normalMap: desc.normalMap || null,
    ormMap: desc.ormMap || null,
    normalScale: desc.normalScale === undefined ? 1 : desc.normalScale,

    uvScale: [1, 1],
    uvOffset: [0, 0],

    alpha: desc.alpha === undefined ? 1 : desc.alpha,
    alphaTest: desc.alphaTest === undefined ? 0 : desc.alphaTest,
    blend,
    doubleSided: !!desc.doubleSided,
    castShadow: desc.castShadow === undefined ? true : !!desc.castShadow,
    receiveShadow: desc.receiveShadow === undefined ? true : !!desc.receiveShadow,
    vertexColors: !!desc.vertexColors,
    windowGlow: desc.windowGlow === undefined ? 0 : desc.windowGlow,
    windowGrid: desc.windowGrid === undefined ? 4 : desc.windowGrid,
    reflectance: desc.reflectance === undefined ? 0.5 : desc.reflectance,
    unlit: !!desc.unlit,
    depthWrite: desc.depthWrite === undefined ? blend === 'opaque' : !!desc.depthWrite,
    depthTest: desc.depthTest === undefined ? true : !!desc.depthTest,
    sortBias: desc.sortBias === undefined ? 0 : desc.sortBias,
    wetness: desc.wetness === undefined ? 1 : desc.wetness,

    // Derived, filled by refreshMaterial().
    flags: 0,
    queue: QUEUE_OPAQUE,
    additive: false,

    // Renderer-owned bookkeeping.
    _anisoStamp: -1,

    // Preallocated uniform payloads (never reallocated).
    _baseColor: new Float32Array(4),
    _params: new Float32Array(4),
    _params2: new Float32Array(4),
    _emissive: new Float32Array(4),
    _uv: new Float32Array(4)
  };

  copyN(mat.albedo, desc.albedo, [1, 1, 1], 3);
  copyN(mat.emissive, desc.emissive, [0, 0, 0], 3);
  copyN(mat.uvScale, desc.uvScale, [1, 1], 2);
  copyN(mat.uvOffset, desc.uvOffset, [0, 0], 2);

  // `reflectance` is accepted both as the Filament 0..1 parameter and as a raw F0 (e.g. 0.04).
  if (mat.reflectance < 0.2) mat.reflectance = Math.sqrt(mat.reflectance / 0.16);
  mat.reflectance = Math.max(0, Math.min(1, mat.reflectance));

  return refreshMaterial(mat);
}

/**
 * Applies a partial description to an existing material and refreshes its cached payloads.
 * Safe to call at runtime; the renderer picks up permutation changes on the next draw.
 * @param {Object} mat Material returned by {@link createMaterial}.
 * @param {Object} patch Subset of the {@link createMaterial} description.
 * @returns {Object} The material, for chaining.
 */
export function updateMaterial(mat, patch) {
  if (!mat || !patch) return mat;
  for (const key in patch) {
    const v = patch[key];
    if (v === undefined) continue;
    if (key === 'albedo') copyN(mat.albedo, v, mat.albedo, 3);
    else if (key === 'emissive') copyN(mat.emissive, v, mat.emissive, 3);
    else if (key === 'uvScale') copyN(mat.uvScale, v, mat.uvScale, 2);
    else if (key === 'uvOffset') copyN(mat.uvOffset, v, mat.uvOffset, 2);
    else if (key === 'reflectance') mat.reflectance = v < 0.2 ? Math.sqrt(Math.max(v, 0) / 0.16) : Math.min(1, v);
    else if (key === 'blend') mat.blend = v === 'alpha' || v === 'add' ? v : 'opaque';
    else if (key === 'id' || key === 'version' || key.charAt(0) === '_') continue;
    else mat[key] = v;
  }
  if (patch.blend !== undefined && patch.depthWrite === undefined) {
    mat.depthWrite = mat.blend === 'opaque';
  }
  return refreshMaterial(mat);
}

/**
 * Deep-copies a material (the texture references are shared).
 * @param {Object} mat Source material.
 * @param {Object} [patch] Optional overrides applied to the copy.
 * @returns {Object} A new independent material.
 */
export function cloneMaterial(mat, patch) {
  const copy = createMaterial({
    name: mat.name + '#copy',
    albedo: mat.albedo,
    roughness: mat.roughness,
    metallic: mat.metallic,
    emissive: mat.emissive,
    emissiveStrength: mat.emissiveStrength,
    map: mat.map,
    normalMap: mat.normalMap,
    ormMap: mat.ormMap,
    normalScale: mat.normalScale,
    uvScale: mat.uvScale,
    uvOffset: mat.uvOffset,
    alpha: mat.alpha,
    alphaTest: mat.alphaTest,
    blend: mat.blend,
    doubleSided: mat.doubleSided,
    castShadow: mat.castShadow,
    receiveShadow: mat.receiveShadow,
    vertexColors: mat.vertexColors,
    windowGlow: mat.windowGlow,
    windowGrid: mat.windowGrid,
    reflectance: mat.reflectance,
    unlit: mat.unlit,
    depthWrite: mat.depthWrite,
    depthTest: mat.depthTest,
    sortBias: mat.sortBias,
    wetness: mat.wetness
  });
  return patch ? updateMaterial(copy, patch) : copy;
}

/**
 * Builds the `#define` map for one shader permutation.
 *
 * @param {number} flags Material feature mask (see {@link MATERIAL_FLAGS}), optionally with
 *   `MATERIAL_FLAGS.INSTANCED` set.
 * @param {Object} ctx Global shader context.
 * @param {number} ctx.cascades Shadow cascade count (0 = no shadows).
 * @param {number} ctx.pcf PCF quality: 0 single tap, 1 3x3, 2 Poisson.
 * @param {number} ctx.pointLights Size of the point-light uniform array.
 * @param {number} ctx.maxDrawLights Lights referenced by a single draw call.
 * @param {boolean} ctx.ssao Sample the screen-space AO buffer.
 * @returns {Object<string, number>} Defines for `Shader`.
 */
export function buildMaterialDefines(flags, ctx) {
  const defines = {
    SHADOW_CASCADES: (flags & MATERIAL_FLAGS.NO_SHADOW) ? 0 : (ctx.cascades | 0),
    SHADOW_PCF: ctx.pcf | 0,
    POINT_LIGHTS: ctx.pointLights | 0,
    MAX_DRAW_LIGHTS: ctx.maxDrawLights | 0
  };
  if (flags & MATERIAL_FLAGS.MAP) defines.USE_MAP = 1;
  if (flags & MATERIAL_FLAGS.NORMAL_MAP) defines.USE_NORMAL_MAP = 1;
  if (flags & MATERIAL_FLAGS.VERTEX_COLOR) defines.USE_VERTEX_COLOR = 1;
  if (flags & MATERIAL_FLAGS.ALPHA_TEST) defines.ALPHA_TEST = 1;
  if (flags & MATERIAL_FLAGS.WINDOW_GLOW) defines.WINDOW_GLOW = 1;
  if (flags & MATERIAL_FLAGS.UNLIT) defines.UNLIT = 1;
  if (flags & MATERIAL_FLAGS.INSTANCED) defines.USE_INSTANCING = 1;
  if (ctx.ssao) defines.SSAO = 1;
  return defines;
}

/**
 * Builds the `#define` map for the depth-only shadow permutation.
 * @param {number} flags Material feature mask, optionally with `INSTANCED`.
 * @returns {Object<string, number>} Defines for `Shader`.
 */
export function buildShadowDefines(flags) {
  const defines = {};
  if (flags & MATERIAL_FLAGS.INSTANCED) defines.USE_INSTANCING = 1;
  if (flags & MATERIAL_FLAGS.ALPHA_TEST) {
    defines.ALPHA_TEST = 1;
    if (flags & MATERIAL_FLAGS.MAP) defines.USE_MAP = 1;
  }
  return defines;
}

/**
 * The feature bits of a material that actually affect the depth-only shadow program.
 * @param {Object} mat Material.
 * @param {boolean} instanced True when drawn with instancing.
 * @returns {number} Reduced flag mask.
 */
export function shadowFlagsOf(mat, instanced) {
  let flags = mat.flags & (MATERIAL_FLAGS.ALPHA_TEST | MATERIAL_FLAGS.MAP);
  if (!(mat.flags & MATERIAL_FLAGS.ALPHA_TEST)) flags = 0;
  if (instanced) flags |= MATERIAL_FLAGS.INSTANCED;
  return flags;
}

/**
 * Uploads every material-scoped uniform. Textures land on {@link TEXTURE_UNITS}.
 * @param {Object} shader Compiled `Shader` for the matching permutation.
 * @param {Object} mat Material.
 * @returns {void}
 */
export function bindMaterialUniforms(shader, mat) {
  shader.setVec4v('uBaseColor', mat._baseColor);
  shader.setVec4v('uMatParams', mat._params);
  shader.setVec4v('uMatParams2', mat._params2);
  shader.setVec4v('uEmissive', mat._emissive);
  shader.setVec4v('uUvTransform', mat._uv);
  if (mat.map) shader.setTexture('uMap', mat.map, TEXTURE_UNITS.MAP);
  if (mat.normalMap) shader.setTexture('uNormalMap', mat.normalMap, TEXTURE_UNITS.NORMAL_MAP);
}

/**
 * Uploads the subset of material uniforms the depth-only shadow program needs.
 * @param {Object} shader Compiled shadow `Shader`.
 * @param {Object} mat Material.
 * @returns {void}
 */
export function bindShadowMaterialUniforms(shader, mat) {
  shader.setVec4v('uUvTransform', mat._uv);
  if (mat.alphaTest > 0) {
    shader.setVec4v('uBaseColor', mat._baseColor);
    shader.setVec4v('uMatParams', mat._params);
    if (mat.map) shader.setTexture('uMap', mat.map, TEXTURE_UNITS.MAP);
  }
}

/**
 * Convenience presets used by world building and entity code.
 * Each call returns a fresh material, so callers may tweak them freely.
 * @param {string} kind Preset name: `'default'|'road'|'concrete'|'glass'|'metal'|'neon'|
 *   'foliage'|'water'|'carPaint'|'skin'|'cloth'|'rubber'|'plastic'`.
 * @param {Object} [overrides] Extra description fields merged on top of the preset.
 * @returns {Object} A new material.
 */
export function createPresetMaterial(kind, overrides) {
  const presets = {
    default: { roughness: 0.8, metallic: 0 },
    road: { albedo: [0.055, 0.056, 0.062], roughness: 0.86, metallic: 0, reflectance: 0.42 },
    concrete: { albedo: [0.46, 0.46, 0.45], roughness: 0.92, metallic: 0 },
    glass: { albedo: [0.12, 0.16, 0.2], roughness: 0.08, metallic: 0, reflectance: 0.8, alpha: 0.42, blend: 'alpha' },
    metal: { albedo: [0.62, 0.64, 0.68], roughness: 0.32, metallic: 1 },
    neon: { albedo: [0, 0, 0], emissive: [1, 0.25, 0.6], emissiveStrength: 6, unlit: true },
    foliage: { albedo: [0.16, 0.3, 0.12], roughness: 0.85, alphaTest: 0.45, doubleSided: true },
    water: { albedo: [0.02, 0.05, 0.07], roughness: 0.06, metallic: 0, reflectance: 0.7, alpha: 0.8, blend: 'alpha', wetness: 1 },
    carPaint: { albedo: [0.6, 0.05, 0.08], roughness: 0.25, metallic: 0.45, reflectance: 0.75 },
    skin: { albedo: [0.72, 0.53, 0.42], roughness: 0.68, metallic: 0, reflectance: 0.35 },
    cloth: { albedo: [0.3, 0.32, 0.38], roughness: 0.95, metallic: 0, reflectance: 0.3 },
    rubber: { albedo: [0.03, 0.03, 0.035], roughness: 0.9, metallic: 0, reflectance: 0.4 },
    plastic: { albedo: [0.5, 0.5, 0.52], roughness: 0.45, metallic: 0, reflectance: 0.55 }
  };
  const base = presets[kind] || presets.default;
  const desc = { name: kind };
  for (const k in base) desc[k] = base[k];
  if (overrides) for (const k in overrides) desc[k] = overrides[k];
  return createMaterial(desc);
}
