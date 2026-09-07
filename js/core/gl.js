/**
 * @file js/core/gl.js
 * Thin, fast WebGL2 wrappers for NEON CITY: context creation, shader programs with
 * cached uniform locations and readable compile errors, GPU meshes (indexed, optionally
 * instanced), 2D textures and multi-attachment render targets.
 *
 * Design rules honoured here:
 *  - zero dependencies, plain ES module, no build step;
 *  - no allocation inside per-frame paths (draw / bind / uniform setters);
 *  - every wrapper keeps its raw GL handle public so callers can drop down when needed.
 *
 * Conventions:
 *  - Vertex attribute layout is fixed: 0 = position (vec3), 1 = normal (vec3),
 *    2 = uv (vec2), 3 = color (vec3), 4..7 = instance model matrix columns (vec4),
 *    8 = instance tint (vec4).
 *  - Vertical flip is a per-texture choice driven by `opts.flipY`, which defaults to true for
 *    canvas/image sources (so canvas2d top-left maps to uv (0,1)) and false for raw typed-array
 *    data (so element 0 is the uv (0,0) texel). UNPACK_FLIP_Y_WEBGL applies to both upload
 *    paths, so passing `flipY: true` alongside `data` flips raw rows exactly like a canvas.
 */

/* -------------------------------------------------------------------------- */
/* Context                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Context attributes requested by the game. Callers may override individual fields.
 * @type {Object<string, *>}
 */
const DEFAULT_CONTEXT_ATTRIBS = {
  alpha: false,
  antialias: false,
  depth: true,
  stencil: false,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: false,
  desynchronized: true,
  premultipliedAlpha: false,
  failIfMajorPerformanceCaveat: false
};

/**
 * Creates the WebGL2 rendering context used by the whole engine.
 *
 * Queried extensions are exposed on `gl.__ext`:
 * `{colorBufferFloat, colorBufferHalfFloat, textureFloatLinear, floatBlend, anisotropic,
 *   textureFilterAnisotropic, loseContext, debugRendererInfo, maxAnisotropy}`.
 * Device limits are exposed on `gl.__limits` and adapter strings on `gl.__info`.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas Target canvas.
 * @param {Object} [opts] Context attribute overrides (same keys as WebGLContextAttributes).
 * @returns {WebGL2RenderingContext|null} The context, or null when WebGL2 is unavailable.
 */
export function createGLContext(canvas, opts) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  const attribs = {};
  for (const key in DEFAULT_CONTEXT_ATTRIBS) attribs[key] = DEFAULT_CONTEXT_ATTRIBS[key];
  if (opts) for (const key in opts) attribs[key] = opts[key];

  let gl = null;
  try {
    gl = canvas.getContext('webgl2', attribs);
  } catch (err) {
    gl = null;
  }
  if (!gl) return null;

  const aniso = gl.getExtension('EXT_texture_filter_anisotropic') ||
    gl.getExtension('MOZ_EXT_texture_filter_anisotropic') ||
    gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic') || null;

  const ext = {
    colorBufferFloat: gl.getExtension('EXT_color_buffer_float'),
    colorBufferHalfFloat: gl.getExtension('EXT_color_buffer_half_float'),
    textureFloatLinear: gl.getExtension('OES_texture_float_linear'),
    floatBlend: gl.getExtension('EXT_float_blend'),
    anisotropic: aniso,
    textureFilterAnisotropic: aniso,
    loseContext: gl.getExtension('WEBGL_lose_context'),
    debugRendererInfo: gl.getExtension('WEBGL_debug_renderer_info'),
    maxAnisotropy: aniso ? gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1
  };
  gl.__ext = ext;

  gl.__limits = {
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxCubeMapSize: gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE),
    maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    maxTextureUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
    maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
    maxColorAttachments: gl.getParameter(gl.MAX_COLOR_ATTACHMENTS),
    maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS),
    maxSamples: gl.getParameter(gl.MAX_SAMPLES),
    maxVaryingVectors: gl.getParameter(gl.MAX_VARYING_VECTORS),
    maxFragmentUniformVectors: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
    maxVertexUniformVectors: gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS),
    maxAnisotropy: ext.maxAnisotropy
  };

  let vendor = '';
  let renderer = '';
  try {
    if (ext.debugRendererInfo) {
      vendor = String(gl.getParameter(ext.debugRendererInfo.UNMASKED_VENDOR_WEBGL) || '');
      renderer = String(gl.getParameter(ext.debugRendererInfo.UNMASKED_RENDERER_WEBGL) || '');
    } else {
      vendor = String(gl.getParameter(gl.VENDOR) || '');
      renderer = String(gl.getParameter(gl.RENDERER) || '');
    }
  } catch (err) {
    vendor = '';
    renderer = '';
  }
  gl.__info = { vendor, renderer, version: String(gl.getParameter(gl.VERSION) || '') };

  // Baseline render state shared by every pass.
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.depthMask(true);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.frontFace(gl.CCW);
  gl.disable(gl.BLEND);
  gl.disable(gl.SCISSOR_TEST);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 1);
  gl.clearDepth(1);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  return gl;
}

/* -------------------------------------------------------------------------- */
/* Debug helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Enables or disables GL error checking performed by {@link checkGLError}.
 * Off by default because `gl.getError()` forces a pipeline flush.
 * @param {boolean} enabled True to enable per-call error checks.
 * @returns {void}
 */
export function setGLDebug(enabled) {
  globalThis.NEON_GL_DEBUG = !!enabled;
}

/** Human readable names for the GL error codes. @type {Object<number, string>} */
const GL_ERROR_NAMES = {
  0x0500: 'INVALID_ENUM',
  0x0501: 'INVALID_VALUE',
  0x0502: 'INVALID_OPERATION',
  0x0503: 'STACK_OVERFLOW',
  0x0504: 'STACK_UNDERFLOW',
  0x0505: 'OUT_OF_MEMORY',
  0x0506: 'INVALID_FRAMEBUFFER_OPERATION',
  0x9242: 'CONTEXT_LOST_WEBGL'
};

/**
 * Reports pending GL errors. No-op unless `globalThis.NEON_GL_DEBUG` is truthy
 * (see {@link setGLDebug}), so it is safe to sprinkle through hot code.
 * @param {WebGL2RenderingContext} gl Context to poll.
 * @param {string} [tag] Label printed with the error.
 * @returns {number} The first error code found, or 0 when there was none / checks are off.
 */
export function checkGLError(gl, tag) {
  if (!globalThis.NEON_GL_DEBUG) return 0;
  let first = 0;
  let err = gl.getError();
  let guard = 0;
  while (err !== gl.NO_ERROR && guard++ < 16) {
    if (first === 0) first = err;
    console.error('[gl] ' + (tag || '') + ': ' + (GL_ERROR_NAMES[err] || ('0x' + err.toString(16))));
    err = gl.getError();
  }
  return first;
}

/* -------------------------------------------------------------------------- */
/* Shader                                                                      */
/* -------------------------------------------------------------------------- */

/** Header injected when the source does not declare its own `#version`. */
const GLSL_HEADER = '#version 300 es\nprecision highp float;\nprecision highp int;\n';

/**
 * Builds the `#define` block for a shader.
 * @param {Object} defines Map of macro name to value; `false`/`null`/`undefined` skip the macro,
 *   `true` becomes `1`.
 * @returns {string} Newline terminated define block (possibly empty).
 */
function buildDefines(defines) {
  if (!defines) return '';
  let out = '';
  for (const key in defines) {
    const value = defines[key];
    if (value === false || value === null || value === undefined) continue;
    out += '#define ' + key + ' ' + (value === true ? '1' : String(value)) + '\n';
  }
  return out;
}

/**
 * Injects the default version/precision header and the `#define` block into a shader source.
 * When the source already starts with `#version`, that line is preserved and the defines are
 * inserted immediately after it (required by GLSL: nothing may precede `#version`).
 * @param {string} src Raw GLSL source.
 * @param {string} defineBlock Pre-built define block.
 * @returns {string} Preprocessed source ready for `shaderSource`.
 */
function preprocessSource(src, defineBlock) {
  const text = String(src);
  const lead = text.replace(/^[\s\uFEFF]+/, '');
  if (lead.startsWith('#version')) {
    const nl = lead.indexOf('\n');
    if (nl < 0) return lead + '\n' + defineBlock;
    return lead.slice(0, nl + 1) + defineBlock + lead.slice(nl + 1);
  }
  return GLSL_HEADER + defineBlock + text;
}

/**
 * Extracts the source line numbers referenced by a GL info log. Handles both the
 * `ERROR: 0:12:` (ANGLE/desktop GL) and `0(12) : error` (D3D backend) spellings.
 * @param {string} log Info log text.
 * @returns {number[]} Unique 1-based line numbers, in order of appearance.
 */
function parseErrorLines(log) {
  const lines = [];
  if (!log) return lines;
  const re = /\b\d+\s*[:(]\s*(\d+)\s*[:)]/g;
  let m = re.exec(log);
  while (m !== null) {
    const n = parseInt(m[1], 10);
    if (n > 0 && lines.indexOf(n) < 0) lines.push(n);
    if (lines.length >= 8) break;
    m = re.exec(log);
  }
  return lines;
}

/**
 * Renders a numbered window of source lines around a faulty line.
 * @param {string} src Preprocessed shader source.
 * @param {number} line 1-based line number to centre on.
 * @param {number} [radius] Number of context lines above and below.
 * @returns {string} Printable snippet.
 */
function sourceWindow(src, line, radius) {
  const r = radius === undefined ? 3 : radius;
  const lines = src.split('\n');
  const start = Math.max(1, line - r);
  const end = Math.min(lines.length, line + r);
  const pad = String(end).length;
  let out = '';
  for (let i = start; i <= end; i++) {
    const num = String(i);
    out += (i === line ? '> ' : '  ') + ' '.repeat(pad - num.length) + num + ' | ' + lines[i - 1] + '\n';
  }
  return out;
}

/**
 * Formats a compile/link failure into a message containing the shader name, the GL info log
 * and the offending source lines with line numbers.
 * @param {string} name Shader name.
 * @param {string} stage 'vertex', 'fragment' or 'link'.
 * @param {string} log GL info log.
 * @param {Array<{label: string, src: string}>} sources Preprocessed sources to search.
 * @returns {string} The full error message.
 */
function formatShaderError(name, stage, log, sources) {
  const info = (log || '').replace(/\0/g, '').trim();
  let out = 'Shader "' + (name || '(unnamed)') + '" ' + stage + ' failed\n' + info + '\n';
  const lineNumbers = parseErrorLines(info);
  if (lineNumbers.length === 0) {
    out += '\n(no source line reported; line numbers below refer to the preprocessed source)\n';
    return out;
  }
  out += '\n(line numbers refer to the preprocessed source, header included)\n';
  for (let i = 0; i < lineNumbers.length; i++) {
    for (let s = 0; s < sources.length; s++) {
      const entry = sources[s];
      out += '--- ' + entry.label + ' around line ' + lineNumbers[i] + ' ---\n';
      out += sourceWindow(entry.src, lineNumbers[i]);
    }
  }
  return out;
}

/**
 * Compiles a single shader stage.
 * @param {WebGL2RenderingContext} gl Context.
 * @param {number} type gl.VERTEX_SHADER or gl.FRAGMENT_SHADER.
 * @param {string} src Preprocessed source.
 * @param {string} name Shader name (for errors).
 * @returns {WebGLShader} The compiled shader.
 */
function compileStage(gl, type, src, name) {
  const stage = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Shader "' + name + '": createShader failed (context lost?)');
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || '';
    gl.deleteShader(shader);
    throw new Error(formatShaderError(name, stage + ' compile', log, [{ label: stage + ' shader', src }]));
  }
  return shader;
}

/**
 * A linked GLSL program with cached uniform locations and safe setters.
 * Every setter silently ignores uniforms that were optimised away or misspelled.
 */
export class Shader {
  /**
   * @param {WebGL2RenderingContext} gl Context.
   * @param {string} vertexSrc Vertex shader source (with or without a `#version` line).
   * @param {string} fragmentSrc Fragment shader source.
   * @param {Object} [defines] Macros injected right after the version line.
   * @param {string} [name] Name used in error messages.
   */
  constructor(gl, vertexSrc, fragmentSrc, defines = {}, name = '') {
    /** @type {WebGL2RenderingContext} */
    this.gl = gl;
    /** @type {string} */
    this.name = name || 'shader';
    /** @type {Object} */
    this.defines = defines || {};

    const defineBlock = buildDefines(defines);
    /** @type {string} Preprocessed vertex source (what the driver actually saw). */
    this.vertexSource = preprocessSource(vertexSrc, defineBlock);
    /** @type {string} Preprocessed fragment source. */
    this.fragmentSource = preprocessSource(fragmentSrc, defineBlock);

    const vs = compileStage(gl, gl.VERTEX_SHADER, this.vertexSource, this.name);
    let fs = null;
    try {
      fs = compileStage(gl, gl.FRAGMENT_SHADER, this.fragmentSource, this.name);
    } catch (err) {
      gl.deleteShader(vs);
      throw err;
    }

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
    gl.detachShader(program, vs);
    gl.detachShader(program, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!linked) {
      const log = gl.getProgramInfoLog(program) || '';
      gl.deleteProgram(program);
      throw new Error(formatShaderError(this.name, 'link', log, [
        { label: 'vertex shader', src: this.vertexSource },
        { label: 'fragment shader', src: this.fragmentSource }
      ]));
    }

    /** @type {WebGLProgram} */
    this.program = program;
    /** @type {Map<string, WebGLUniformLocation|null>} */
    this._uniforms = new Map();
    /** @type {Map<string, number>} */
    this._attribs = new Map();
    /** @type {boolean} */
    this.disposed = false;
  }

  /**
   * Makes this program current.
   * @returns {Shader} this, for chaining.
   */
  use() {
    this.gl.useProgram(this.program);
    return this;
  }

  /**
   * Returns a cached uniform location.
   * @param {string} name Uniform name (use `arr[0]` for array uniforms).
   * @returns {WebGLUniformLocation|null} Location, or null when the uniform is absent.
   */
  uniform(name) {
    const cached = this._uniforms.get(name);
    if (cached !== undefined) return cached;
    const loc = this.gl.getUniformLocation(this.program, name);
    this._uniforms.set(name, loc);
    return loc;
  }

  /**
   * Returns a cached attribute location.
   * @param {string} name Attribute name.
   * @returns {number} Location, or -1 when absent.
   */
  attrib(name) {
    const cached = this._attribs.get(name);
    if (cached !== undefined) return cached;
    const loc = this.gl.getAttribLocation(this.program, name);
    this._attribs.set(name, loc);
    return loc;
  }

  /**
   * @param {string} n Uniform name.
   * @param {number} v Value.
   * @returns {void}
   */
  setFloat(n, v) {
    const loc = this.uniform(n);
    if (loc) this.gl.uniform1f(loc, v);
  }

  /**
   * @param {string} n Uniform name.
   * @param {number|boolean} v Value (booleans are coerced to 0/1).
   * @returns {void}
   */
  setInt(n, v) {
    const loc = this.uniform(n);
    if (loc) this.gl.uniform1i(loc, v === true ? 1 : (v === false ? 0 : v | 0));
  }

  /**
   * @param {string} n Uniform name.
   * @param {number} x X component.
   * @param {number} y Y component.
   * @returns {void}
   */
  setVec2(n, x, y) {
    const loc = this.uniform(n);
    if (loc) this.gl.uniform2f(loc, x, y);
  }

  /**
   * @param {string} n Uniform name.
   * @param {ArrayLike<number>} arr Two floats.
   * @returns {void}
   */
  setVec2v(n, arr) {
    const loc = this.uniform(n);
    if (loc) this.gl.uniform2f(loc, arr[0], arr[1]);
  }

  /**
   * @param {string} n Uniform name.
   * @param {number} x X component.
   * @param {number} y Y component.
   * @param {number} z Z component.
   * @returns {void}
   */
  setVec3(n, x, y, z) {
    const loc = this.uniform(n);
    if (loc) this.gl.uniform3f(loc, x, y, z);
  }

  /**
   * @param {string} n Uniform name.
   * @param {ArrayLike<number>} arr Three floats.
   * @returns {void}
   */
  setVec3v(n, arr) {
    const loc = this.uniform(n);
    if (loc) this.gl.uniform3f(loc, arr[0], arr[1], arr[2]);
  }

  /**
   * @param {string} n Uniform name.
   * @param {number} x X component.
   * @param {number} y Y component.
   * @param {number} z Z component.
   * @param {number} w W component.
   * @returns {void}
   */
  setVec4(n, x, y, z, w) {
    const loc = this.uniform(n);
    if (loc) this.gl.uniform4f(loc, x, y, z, w);
  }

  /**
   * @param {string} n Uniform name.
   * @param {ArrayLike<number>} arr Four floats.
   * @returns {void}
   */
  setVec4v(n, arr) {
    const loc = this.uniform(n);
    if (loc) this.gl.uniform4f(loc, arr[0], arr[1], arr[2], arr[3]);
  }

  /**
   * @param {string} n Uniform name.
   * @param {Float32Array|number[]} m 9 floats, column-major.
   * @returns {void}
   */
  setMat3(n, m) {
    const loc = this.uniform(n);
    if (loc) this.gl.uniformMatrix3fv(loc, false, m);
  }

  /**
   * @param {string} n Uniform name.
   * @param {Float32Array|number[]} m 16 floats, column-major.
   * @returns {void}
   */
  setMat4(n, m) {
    const loc = this.uniform(n);
    if (loc) this.gl.uniformMatrix4fv(loc, false, m);
  }

  /**
   * Uploads an array of mat4 (e.g. bone or cascade matrices).
   * @param {string} n Uniform name, typically `uName[0]`.
   * @param {Float32Array|number[]} arr Packed 16*N floats.
   * @returns {void}
   */
  setMat4Array(n, arr) {
    const loc = this.uniform(n);
    if (loc) this.gl.uniformMatrix4fv(loc, false, arr);
  }

  /**
   * @param {string} n Uniform name, typically `uName[0]`.
   * @param {Float32Array|number[]} arr Packed floats.
   * @returns {void}
   */
  setFloatArray(n, arr) {
    const loc = this.uniform(n);
    if (loc) this.gl.uniform1fv(loc, arr);
  }

  /**
   * @param {string} n Uniform name, typically `uName[0]`.
   * @param {Float32Array|number[]} arr Packed 3*N floats.
   * @returns {void}
   */
  setVec3Array(n, arr) {
    const loc = this.uniform(n);
    if (loc) this.gl.uniform3fv(loc, arr);
  }

  /**
   * @param {string} n Uniform name, typically `uName[0]`.
   * @param {Float32Array|number[]} arr Packed 4*N floats.
   * @returns {void}
   */
  setVec4Array(n, arr) {
    const loc = this.uniform(n);
    if (loc) this.gl.uniform4fv(loc, arr);
  }

  /**
   * @param {string} n Uniform name, typically `uName[0]`.
   * @param {Int32Array|number[]} arr Packed ints.
   * @returns {void}
   */
  setIntArray(n, arr) {
    const loc = this.uniform(n);
    if (loc) this.gl.uniform1iv(loc, arr);
  }

  /**
   * Binds a texture to a unit and points the sampler uniform at it.
   * Accepts a {@link Texture2D}, any object exposing `.texture`, or a raw WebGLTexture.
   * When the sampler uniform does not exist the call is a complete no-op: neither the active
   * texture unit nor the texture binding is disturbed.
   * @param {string} n Sampler uniform name.
   * @param {Texture2D|{texture: WebGLTexture, target?: number}|WebGLTexture|null} texture Texture.
   * @param {number} [unit] Texture unit index (added to gl.TEXTURE0).
   * @returns {void}
   */
  setTexture(n, texture, unit = 0) {
    const loc = this.uniform(n);
    if (!loc) return;
    const gl = this.gl;
    let handle = null;
    let target = gl.TEXTURE_2D;
    if (texture) {
      if (texture.texture !== undefined) {
        handle = texture.texture;
        if (texture.target !== undefined) target = texture.target;
      } else {
        handle = texture;
      }
    }
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, handle);
    gl.uniform1i(loc, unit);
  }

  /**
   * Deletes the GPU program. The instance must not be used afterwards.
   * @returns {void}
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.gl.deleteProgram(this.program);
    this.program = null;
    this._uniforms.clear();
    this._attribs.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* GpuMesh                                                                     */
/* -------------------------------------------------------------------------- */

/** Fixed attribute slots. */
const ATTR_POSITION = 0;
const ATTR_NORMAL = 1;
const ATTR_UV = 2;
const ATTR_COLOR = 3;
const ATTR_INSTANCE_M0 = 4;
const ATTR_INSTANCE_TINT = 8;

/** Primitive name -> GL enum key. @type {Object<string, string>} */
const PRIMITIVE_MODES = {
  points: 'POINTS',
  lines: 'LINES',
  lineStrip: 'LINE_STRIP',
  lineLoop: 'LINE_LOOP',
  triangles: 'TRIANGLES',
  triangleStrip: 'TRIANGLE_STRIP',
  triangleFan: 'TRIANGLE_FAN'
};

/**
 * A VAO plus its vertex/index buffers, optionally instanced.
 *
 * Accepted geometry: `{positions: Float32Array, normals?: Float32Array, uvs?: Float32Array,
 * indices?: Uint16Array|Uint32Array|number[], colors?: Float32Array, bounds?: {min, max},
 * mode?: 'triangles'|'lines'|...}`.
 */
export class GpuMesh {
  /**
   * @param {WebGL2RenderingContext} gl Context.
   * @param {Object} geometry Geometry object (see class docs).
   */
  constructor(gl, geometry) {
    if (!geometry || !geometry.positions) throw new Error('GpuMesh: geometry.positions is required');
    /** @type {WebGL2RenderingContext} */
    this.gl = gl;
    /** @type {number} Vertex count. */
    this.vertexCount = (geometry.positions.length / 3) | 0;
    /** @type {number} GL primitive mode. */
    this.mode = gl[PRIMITIVE_MODES[geometry.mode] || 'TRIANGLES'];
    /** @type {boolean} True when a per-vertex color buffer is present. */
    this.hasColors = !!(geometry.colors && geometry.colors.length >= this.vertexCount * 3);
    /** @type {boolean} */
    this.disposed = false;

    /** @type {WebGLVertexArrayObject} */
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    /** @type {WebGLBuffer} */
    this.positionBuffer = createStaticBuffer(gl, toFloat32(geometry.positions));
    gl.vertexAttribPointer(ATTR_POSITION, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(ATTR_POSITION);

    /** @type {WebGLBuffer|null} */
    this.normalBuffer = null;
    if (geometry.normals && geometry.normals.length >= this.vertexCount * 3) {
      this.normalBuffer = createStaticBuffer(gl, toFloat32(geometry.normals));
      gl.vertexAttribPointer(ATTR_NORMAL, 3, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(ATTR_NORMAL);
    } else {
      gl.disableVertexAttribArray(ATTR_NORMAL);
      gl.vertexAttrib3f(ATTR_NORMAL, 0, 1, 0);
    }

    /** @type {WebGLBuffer|null} */
    this.uvBuffer = null;
    if (geometry.uvs && geometry.uvs.length >= this.vertexCount * 2) {
      this.uvBuffer = createStaticBuffer(gl, toFloat32(geometry.uvs));
      gl.vertexAttribPointer(ATTR_UV, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(ATTR_UV);
    } else {
      gl.disableVertexAttribArray(ATTR_UV);
      gl.vertexAttrib2f(ATTR_UV, 0, 0);
    }

    /** @type {WebGLBuffer|null} */
    this.colorBuffer = null;
    if (this.hasColors) {
      this.colorBuffer = createStaticBuffer(gl, toFloat32(geometry.colors));
      gl.vertexAttribPointer(ATTR_COLOR, 3, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(ATTR_COLOR);
    } else {
      // Generic vertex attribute values are context state, not VAO state, so the constant
      // is re-asserted in draw() as well.
      gl.disableVertexAttribArray(ATTR_COLOR);
      gl.vertexAttrib3f(ATTR_COLOR, 1, 1, 1);
    }

    const indices = buildIndexArray(geometry.indices, this.vertexCount);
    /** @type {number} GL index type (UNSIGNED_SHORT or UNSIGNED_INT). */
    this.indexType = indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    /** @type {number} Number of indices to draw. */
    this.indexCount = indices.length;
    /** @type {WebGLBuffer} */
    this.indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

    /** @type {number} Triangle count (0 for non-triangle primitives). */
    this.triangleCount = this.mode === gl.TRIANGLES ? (this.indexCount / 3) | 0 : 0;

    const bounds = geometry.bounds && geometry.bounds.min && geometry.bounds.max
      ? { min: [geometry.bounds.min[0], geometry.bounds.min[1], geometry.bounds.min[2]],
        max: [geometry.bounds.max[0], geometry.bounds.max[1], geometry.bounds.max[2]] }
      : computeMeshBounds(geometry.positions);
    /** @type {{min: number[], max: number[]}} Local-space AABB. */
    this.bounds = bounds;
    /** @type {Float32Array} Local-space bounding sphere centre. */
    this.boundsCenter = new Float32Array([
      (bounds.min[0] + bounds.max[0]) * 0.5,
      (bounds.min[1] + bounds.max[1]) * 0.5,
      (bounds.min[2] + bounds.max[2]) * 0.5
    ]);
    const ex = (bounds.max[0] - bounds.min[0]) * 0.5;
    const ey = (bounds.max[1] - bounds.min[1]) * 0.5;
    const ez = (bounds.max[2] - bounds.min[2]) * 0.5;
    /** @type {number} Local-space bounding sphere radius. */
    this.boundsRadius = Math.sqrt(ex * ex + ey * ey + ez * ez);

    /** @type {WebGLBuffer|null} */
    this.instanceBuffer = null;
    /** @type {number} */
    this.instanceCapacity = 0;
    /** @type {number} */
    this.floatsPerInstance = 20;
    /** @type {number} Instances uploaded by the last setInstanceData call. */
    this.instanceCount = 0;
  }

  /**
   * Allocates (or grows) the dynamic per-instance buffer and wires attributes
   * 4..7 (model matrix columns) and 8 (rgba tint), all with divisor 1.
   * @param {number} capacity Maximum number of instances.
   * @param {number} [floatsPerInstance] Stride in floats; must be >= 20.
   * @returns {GpuMesh} this, for chaining.
   */
  enableInstancing(capacity, floatsPerInstance = 20) {
    const gl = this.gl;
    const stride = Math.max(20, floatsPerInstance | 0);
    const cap = Math.max(1, capacity | 0);
    if (this.instanceBuffer && cap <= this.instanceCapacity && stride === this.floatsPerInstance) {
      return this;
    }
    if (this.instanceBuffer) gl.deleteBuffer(this.instanceBuffer);
    this.floatsPerInstance = stride;
    this.instanceCapacity = cap;
    this.instanceCount = 0;
    this.instanceBuffer = gl.createBuffer();

    const byteStride = stride * 4;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, cap * byteStride, gl.DYNAMIC_DRAW);
    for (let c = 0; c < 4; c++) {
      const loc = ATTR_INSTANCE_M0 + c;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, byteStride, c * 16);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.enableVertexAttribArray(ATTR_INSTANCE_TINT);
    gl.vertexAttribPointer(ATTR_INSTANCE_TINT, 4, gl.FLOAT, false, byteStride, 64);
    gl.vertexAttribDivisor(ATTR_INSTANCE_TINT, 1);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return this;
  }

  /**
   * Uploads instance data. The buffer is grown automatically when `count` exceeds capacity.
   * Layout per instance: 16 floats of column-major mat4, then 4 floats of rgba tint.
   * @param {Float32Array} data Source array, at least `count * floatsPerInstance` long.
   * @param {number} [count] Number of instances to upload; defaults to the whole array.
   * @returns {void}
   */
  setInstanceData(data, count) {
    const gl = this.gl;
    const stride = this.floatsPerInstance;
    let n = count === undefined ? ((data.length / stride) | 0) : (count | 0);
    if (n < 0) n = 0;
    if (!this.instanceBuffer) this.enableInstancing(Math.max(1, n), stride);
    if (n > this.instanceCapacity) this.enableInstancing(nextCapacity(n), stride);
    this.instanceCount = n;
    if (n === 0) return;
    const floats = n * stride;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    if (data.length === floats) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, floats);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /**
   * Draws the mesh. Binds the VAO; the caller is responsible for the program and uniforms.
   * @param {number} [instanceCount] 0 (default) draws once with `drawElements`,
   *   any positive value uses `drawElementsInstanced`.
   * @returns {void}
   */
  draw(instanceCount = 0) {
    const gl = this.gl;
    if (this.indexCount === 0) return;
    gl.bindVertexArray(this.vao);
    // Generic vertex attribute values live in context state, not VAO state, so they are
    // re-asserted here for every buffer this geometry does not provide.
    if (!this.hasColors) gl.vertexAttrib3f(ATTR_COLOR, 1, 1, 1);
    if (!this.normalBuffer) gl.vertexAttrib3f(ATTR_NORMAL, 0, 1, 0);
    if (!this.uvBuffer) gl.vertexAttrib2f(ATTR_UV, 0, 0);
    if (instanceCount > 0) {
      gl.drawElementsInstanced(this.mode, this.indexCount, this.indexType, 0, instanceCount);
    } else {
      gl.drawElements(this.mode, this.indexCount, this.indexType, 0);
    }
  }

  /**
   * Releases every GPU resource owned by the mesh.
   * @returns {void}
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    if (this.positionBuffer) gl.deleteBuffer(this.positionBuffer);
    if (this.normalBuffer) gl.deleteBuffer(this.normalBuffer);
    if (this.uvBuffer) gl.deleteBuffer(this.uvBuffer);
    if (this.colorBuffer) gl.deleteBuffer(this.colorBuffer);
    if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer);
    if (this.instanceBuffer) gl.deleteBuffer(this.instanceBuffer);
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.positionBuffer = null;
    this.normalBuffer = null;
    this.uvBuffer = null;
    this.colorBuffer = null;
    this.indexBuffer = null;
    this.instanceBuffer = null;
    this.vao = null;
    this.indexCount = 0;
  }
}

/**
 * Creates and fills a STATIC_DRAW array buffer, leaving it bound to ARRAY_BUFFER.
 * @param {WebGL2RenderingContext} gl Context.
 * @param {Float32Array} data Vertex data.
 * @returns {WebGLBuffer} The new buffer.
 */
function createStaticBuffer(gl, data) {
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  return buffer;
}

/**
 * Coerces array-likes to Float32Array without copying when already correct.
 * @param {Float32Array|number[]} arr Source.
 * @returns {Float32Array} Typed array.
 */
function toFloat32(arr) {
  return arr instanceof Float32Array ? arr : new Float32Array(arr);
}

/**
 * Chooses the index array type: 32-bit when the mesh has more than 65535 vertices,
 * 16-bit otherwise. Generates a sequential index list when the geometry has none.
 * @param {Uint16Array|Uint32Array|number[]|null|undefined} indices Source indices.
 * @param {number} vertexCount Vertex count of the mesh.
 * @returns {Uint16Array|Uint32Array} Index array ready for upload.
 */
function buildIndexArray(indices, vertexCount) {
  const wide = vertexCount > 65535;
  if (!indices || indices.length === 0) {
    const out = wide ? new Uint32Array(vertexCount) : new Uint16Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) out[i] = i;
    return out;
  }
  if (wide) return indices instanceof Uint32Array ? indices : new Uint32Array(indices);
  return indices instanceof Uint16Array ? indices : new Uint16Array(indices);
}

/**
 * Computes an axis-aligned bounding box from a packed position array.
 * @param {Float32Array|number[]} positions xyz triplets.
 * @returns {{min: number[], max: number[]}} Bounds (zeroed for empty input).
 */
function computeMeshBounds(positions) {
  if (!positions || positions.length < 3) return { min: [0, 0, 0], max: [0, 0, 0] };
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/**
 * Growth policy for the instance buffer: next power of two, minimum 64.
 * @param {number} n Required capacity.
 * @returns {number} New capacity.
 */
function nextCapacity(n) {
  let cap = 64;
  while (cap < n) cap *= 2;
  return cap;
}

/* -------------------------------------------------------------------------- */
/* Texture2D                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Named pixel format presets: `[internalFormat, format, type]` as GL constant names.
 * @type {Object<string, string[]>}
 */
const TEXTURE_FORMATS = {
  rgba8: ['RGBA8', 'RGBA', 'UNSIGNED_BYTE'],
  rgb8: ['RGB8', 'RGB', 'UNSIGNED_BYTE'],
  rg8: ['RG8', 'RG', 'UNSIGNED_BYTE'],
  r8: ['R8', 'RED', 'UNSIGNED_BYTE'],
  srgb8: ['SRGB8', 'RGB', 'UNSIGNED_BYTE'],
  srgb8_alpha8: ['SRGB8_ALPHA8', 'RGBA', 'UNSIGNED_BYTE'],
  rgba16f: ['RGBA16F', 'RGBA', 'HALF_FLOAT'],
  rgb16f: ['RGB16F', 'RGB', 'HALF_FLOAT'],
  rg16f: ['RG16F', 'RG', 'HALF_FLOAT'],
  r16f: ['R16F', 'RED', 'HALF_FLOAT'],
  rgba32f: ['RGBA32F', 'RGBA', 'FLOAT'],
  rg32f: ['RG32F', 'RG', 'FLOAT'],
  r32f: ['R32F', 'RED', 'FLOAT'],
  r11g11b10: ['R11F_G11F_B10F', 'RGB', 'UNSIGNED_INT_10F_11F_11F_REV'],
  depth16: ['DEPTH_COMPONENT16', 'DEPTH_COMPONENT', 'UNSIGNED_SHORT'],
  depth24: ['DEPTH_COMPONENT24', 'DEPTH_COMPONENT', 'UNSIGNED_INT'],
  depth32f: ['DEPTH_COMPONENT32F', 'DEPTH_COMPONENT', 'FLOAT'],
  depth24stencil8: ['DEPTH24_STENCIL8', 'DEPTH_STENCIL', 'UNSIGNED_INT_24_8']
};

/**
 * Resolves a format preset name to GL enums.
 * @param {WebGL2RenderingContext} gl Context.
 * @param {string} name Preset key from {@link TEXTURE_FORMATS}.
 * @returns {{internalFormat: number, format: number, type: number}} GL enums.
 */
function formatPreset(gl, name) {
  const entry = TEXTURE_FORMATS[name];
  if (!entry) throw new Error('Texture2D: unknown format "' + name + '"');
  return { internalFormat: gl[entry[0]], format: gl[entry[1]], type: gl[entry[2]] };
}

/** Wrap mode names. @type {Object<string, string>} */
const WRAP_MODES = { repeat: 'REPEAT', clamp: 'CLAMP_TO_EDGE', mirror: 'MIRRORED_REPEAT' };

/**
 * Resolves a wrap mode name (or raw GL enum) to a GL constant.
 * @param {WebGL2RenderingContext} gl Context.
 * @param {string|number} wrap Mode.
 * @returns {number} GL enum.
 */
function resolveWrap(gl, wrap) {
  if (typeof wrap === 'number') return wrap;
  return gl[WRAP_MODES[wrap] || 'REPEAT'];
}

/** Scratch views for float -> half-float conversion. */
const HALF_F32 = new Float32Array(1);
const HALF_U32 = new Uint32Array(HALF_F32.buffer);

/**
 * Converts a Float32Array to IEEE 754 half floats packed in a Uint16Array.
 * @param {Float32Array} src Source values.
 * @returns {Uint16Array} Half-float bit patterns.
 */
function floatsToHalfFloats(src) {
  const out = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    HALF_F32[0] = src[i];
    const bits = HALF_U32[0];
    const sign = (bits >>> 16) & 0x8000;
    let exp = (bits >>> 23) & 0xff;
    let mant = bits & 0x7fffff;
    if (exp === 0xff) {
      out[i] = sign | 0x7c00 | (mant ? 0x0200 : 0);
      continue;
    }
    exp = exp - 127 + 15;
    if (exp >= 0x1f) {
      out[i] = sign | 0x7c00;
    } else if (exp <= 0) {
      if (exp < -10) {
        out[i] = sign;
      } else {
        mant = (mant | 0x800000) >>> (1 - exp);
        out[i] = sign | (mant + 0x1000 >>> 13);
      }
    } else {
      out[i] = sign | (exp << 10) | (mant + 0x1000 >>> 13);
    }
  }
  return out;
}

/**
 * A 2D texture with full control over format, filtering, wrapping, mipmaps and anisotropy.
 * Non-power-of-two sizes are fully supported (WebGL2 allows repeat + mipmaps on NPOT).
 */
export class Texture2D {
  /**
   * @param {WebGL2RenderingContext} gl Context.
   * @param {Object} [opts] Options.
   * @param {number} [opts.width] Width in texels (required when there is no `source`).
   * @param {number} [opts.height] Height in texels.
   * @param {ArrayBufferView|null} [opts.data] Raw pixel data (row 0 maps to uv v = 0 unless
   *   `opts.flipY` is set, which flips raw rows just like a canvas source).
   * @param {HTMLCanvasElement|HTMLImageElement|ImageBitmap|HTMLVideoElement} [opts.source]
   *   Image source (flipped vertically by default so canvas2d top-left maps to uv (0,1)).
   * @param {number|string} [opts.internalFormat] GL enum or preset name from the format table.
   * @param {number} [opts.format] GL pixel format (derived from the preset when omitted).
   * @param {number|string} [opts.type] GL pixel type, or 'ubyte'|'half'|'float'.
   * @param {string|number} [opts.wrap] 'repeat'|'clamp'|'mirror'.
   * @param {string|number} [opts.wrapS] Per-axis override.
   * @param {string|number} [opts.wrapT] Per-axis override.
   * @param {string} [opts.filter] 'linear'|'nearest'.
   * @param {boolean} [opts.mipmaps] Generate a full mip chain.
   * @param {number} [opts.anisotropy] Desired anisotropy (clamped to the device maximum).
   * @param {boolean} [opts.srgb] Upload as SRGB8_ALPHA8 (hardware sRGB -> linear decode).
   * @param {boolean} [opts.flipY] Override the vertical flip.
   * @param {boolean} [opts.premultiplyAlpha] Premultiply alpha on upload.
   */
  constructor(gl, opts = {}) {
    /** @type {WebGL2RenderingContext} */
    this.gl = gl;
    /** @type {number} */
    this.target = gl.TEXTURE_2D;
    /** @type {boolean} */
    this.disposed = false;

    const source = opts.source || null;
    /** @type {number} */
    this.width = Math.max(1, (source ? (source.width || source.videoWidth || 1) : (opts.width || 1)) | 0);
    /** @type {number} */
    this.height = Math.max(1, (source ? (source.height || source.videoHeight || 1) : (opts.height || 1)) | 0);

    // Resolve the pixel format.
    let internalFormat;
    let format;
    let type;
    if (typeof opts.internalFormat === 'string') {
      const preset = formatPreset(gl, opts.internalFormat);
      internalFormat = preset.internalFormat;
      format = preset.format;
      type = preset.type;
    } else if (typeof opts.internalFormat === 'number') {
      internalFormat = opts.internalFormat;
      format = opts.format !== undefined ? opts.format : gl.RGBA;
      type = gl.UNSIGNED_BYTE;
    } else {
      const preset = formatPreset(gl, opts.srgb ? 'srgb8_alpha8' : 'rgba8');
      internalFormat = preset.internalFormat;
      format = preset.format;
      type = preset.type;
    }
    if (opts.format !== undefined) format = opts.format;
    if (opts.type !== undefined) {
      if (opts.type === 'float') type = gl.FLOAT;
      else if (opts.type === 'half') type = gl.HALF_FLOAT;
      else if (opts.type === 'ubyte') type = gl.UNSIGNED_BYTE;
      else type = opts.type;
    }

    /** @type {number} */
    this.internalFormat = internalFormat;
    /** @type {number} */
    this.format = format;
    /** @type {number} */
    this.type = type;
    /** @type {boolean} */
    this.srgb = internalFormat === gl.SRGB8_ALPHA8 || internalFormat === gl.SRGB8;

    const isFloat = type === gl.FLOAT;
    const isHalf = type === gl.HALF_FLOAT;
    const linearFilterable = !isFloat || !!(gl.__ext && gl.__ext.textureFloatLinear);
    const wantLinear = (opts.filter || 'linear') === 'linear' && linearFilterable;
    // generateMipmap requires a color-renderable and filterable internal format, so float
    // targets only get mips when the matching extensions are present.
    const ext = gl.__ext || {};
    let mipsAllowed = true;
    if (isFloat) mipsAllowed = !!(ext.colorBufferFloat && ext.textureFloatLinear);
    else if (isHalf) mipsAllowed = !!(ext.colorBufferFloat || ext.colorBufferHalfFloat);
    /** @type {boolean} */
    this.mipmaps = !!opts.mipmaps && mipsAllowed;
    /** @type {boolean} */
    this.filterLinear = wantLinear;
    /** @type {boolean} */
    this.flipY = opts.flipY !== undefined ? !!opts.flipY : !!source;
    /** @type {boolean} */
    this.premultiplyAlpha = !!opts.premultiplyAlpha;
    /** @type {number} */
    this.anisotropy = opts.anisotropy === undefined ? 1 : opts.anisotropy;

    /** @type {WebGLTexture} */
    this.texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    const wrapS = resolveWrap(gl, opts.wrapS !== undefined ? opts.wrapS : (opts.wrap || 'repeat'));
    const wrapT = resolveWrap(gl, opts.wrapT !== undefined ? opts.wrapT : (opts.wrap || 'repeat'));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);
    /** @type {number} */
    this.wrapS = wrapS;
    /** @type {number} */
    this.wrapT = wrapT;

    const mag = wantLinear ? gl.LINEAR : gl.NEAREST;
    let min;
    if (this.mipmaps) min = wantLinear ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST;
    else min = wantLinear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, opts.magFilter !== undefined ? opts.magFilter : mag);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.minFilter !== undefined ? opts.minFilter : min);

    const aniso = ext.anisotropic || null;
    if (aniso && this.anisotropy > 1 && this.mipmaps && wantLinear) {
      const maxA = ext.maxAnisotropy || 1;
      gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(this.anisotropy, maxA));
    }

    this._upload(source || opts.data || null, this.width, this.height, true);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * Uploads pixels into the currently bound texture object.
   * @param {ArrayBufferView|TexImageSource|null} payload Data or image source.
   * @param {number} width Width in texels.
   * @param {number} height Height in texels.
   * @param {boolean} allocate True to (re)allocate storage with texImage2D.
   * @returns {void}
   * @private
   */
  _upload(payload, width, height, allocate) {
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, this.flipY);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, this.premultiplyAlpha);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    const isView = payload && ArrayBuffer.isView(payload);
    if (payload && !isView) {
      // Image / canvas / video source.
      if (allocate) gl.texImage2D(gl.TEXTURE_2D, 0, this.internalFormat, this.format, this.type, payload);
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.format, this.type, payload);
    } else {
      let data = payload;
      if (isView && this.type === gl.HALF_FLOAT && data instanceof Float32Array) {
        data = floatsToHalfFloats(data);
      }
      if (allocate) {
        gl.texImage2D(gl.TEXTURE_2D, 0, this.internalFormat, width, height, 0, this.format, this.type, data || null);
      } else if (data) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, this.format, this.type, data);
      }
    }

    if (this.mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }

  /**
   * Binds the texture to a texture unit.
   * @param {number} [unit] Unit index added to gl.TEXTURE0.
   * @returns {Texture2D} this, for chaining.
   */
  bind(unit = 0) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    return this;
  }

  /**
   * Re-uploads the texture contents. Storage is reallocated when the size changed.
   * @param {HTMLCanvasElement|HTMLImageElement|ImageBitmap|HTMLVideoElement|ArrayBufferView} source
   *   New pixels.
   * @param {number} [width] Required when passing raw data of a new size.
   * @param {number} [height] Required when passing raw data of a new size.
   * @returns {void}
   */
  update(source, width, height) {
    if (!source || this.disposed) return;
    const gl = this.gl;
    const isView = ArrayBuffer.isView(source);
    const w = isView ? (width || this.width) : (source.width || source.videoWidth || this.width);
    const h = isView ? (height || this.height) : (source.height || source.videoHeight || this.height);
    const resized = w !== this.width || h !== this.height;
    this.width = w;
    this.height = h;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    this._upload(source, w, h, resized);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * Sets the anisotropic filtering level (clamped to the device maximum).
   * @param {number} value Desired anisotropy.
   * @returns {void}
   */
  setAnisotropy(value) {
    const gl = this.gl;
    const aniso = gl.__ext ? gl.__ext.anisotropic : null;
    if (!aniso) return;
    this.anisotropy = value;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT,
      Math.min(value, gl.__ext.maxAnisotropy || 1));
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * Deletes the GPU texture.
   * @returns {void}
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.gl.deleteTexture(this.texture);
    this.texture = null;
  }

  /**
   * Creates a texture from a canvas (the standard path for procedural textures).
   * @param {WebGL2RenderingContext} gl Context.
   * @param {HTMLCanvasElement|OffscreenCanvas|ImageBitmap} canvas Source canvas.
   * @param {Object} [opts] Options.
   * @param {boolean} [opts.srgb] Decode as sRGB (default true).
   * @param {boolean} [opts.mipmaps] Build mips (default true).
   * @param {string} [opts.wrap] Wrap mode (default 'repeat').
   * @param {number} [opts.anisotropy] Anisotropy (default 8).
   * @param {string} [opts.filter] 'linear'|'nearest' (default 'linear').
   * @param {boolean} [opts.flipY] Vertical flip (default true).
   * @returns {Texture2D} The new texture.
   */
  static fromCanvas(gl, canvas, opts = {}) {
    return new Texture2D(gl, {
      source: canvas,
      srgb: opts.srgb === undefined ? true : opts.srgb,
      mipmaps: opts.mipmaps === undefined ? true : opts.mipmaps,
      wrap: opts.wrap === undefined ? 'repeat' : opts.wrap,
      anisotropy: opts.anisotropy === undefined ? 8 : opts.anisotropy,
      filter: opts.filter === undefined ? 'linear' : opts.filter,
      flipY: opts.flipY === undefined ? true : opts.flipY
    });
  }

  /**
   * Creates a 1x1 solid color texture. Channel values are bytes (0..255).
   * @param {WebGL2RenderingContext} gl Context.
   * @param {number} r Red 0..255.
   * @param {number} g Green 0..255.
   * @param {number} b Blue 0..255.
   * @param {number} [a] Alpha 0..255.
   * @returns {Texture2D} The new texture.
   */
  static solid(gl, r, g, b, a = 255) {
    return new Texture2D(gl, {
      width: 1,
      height: 1,
      data: new Uint8Array([r & 255, g & 255, b & 255, a & 255]),
      internalFormat: 'rgba8',
      filter: 'nearest',
      wrap: 'clamp',
      mipmaps: false,
      flipY: false
    });
  }
}

/* -------------------------------------------------------------------------- */
/* RenderTarget                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Picks a renderable color format, degrading gracefully when float extensions are absent.
 * `r11g11b10` falls back to `rgba16f`, and `rgba16f` falls back to `rgba8`.
 * @param {WebGL2RenderingContext} gl Context.
 * @param {string} name Requested format name.
 * @returns {string} The format name actually used.
 */
function resolveRenderFormat(gl, name) {
  const ext = gl.__ext || {};
  const float = !!ext.colorBufferFloat;
  const half = float || !!ext.colorBufferHalfFloat;
  switch (name) {
    case 'r11g11b10':
      if (float) return 'r11g11b10';
      return half ? 'rgba16f' : 'rgba8';
    case 'rgba32f':
      if (float) return 'rgba32f';
      return half ? 'rgba16f' : 'rgba8';
    case 'rgba16f':
    case 'rgb16f':
      return half ? 'rgba16f' : 'rgba8';
    case 'rg16f':
      return half ? 'rg16f' : 'rg8';
    case 'r16f':
      return half ? 'r16f' : 'r8';
    default:
      return name || 'rgba8';
  }
}

/** Framebuffer status enum -> name. @type {Object<number, string>} */
const FBO_STATUS_NAMES = {
  0x8CD5: 'FRAMEBUFFER_COMPLETE',
  0x8CD6: 'FRAMEBUFFER_INCOMPLETE_ATTACHMENT',
  0x8CD7: 'FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT',
  0x8CD9: 'FRAMEBUFFER_INCOMPLETE_DIMENSIONS',
  0x8CDD: 'FRAMEBUFFER_UNSUPPORTED',
  0x8D56: 'FRAMEBUFFER_INCOMPLETE_MULTISAMPLE'
};

/**
 * An off-screen framebuffer with N color attachments and optional depth
 * (renderbuffer or sampleable depth texture).
 */
export class RenderTarget {
  /**
   * @param {WebGL2RenderingContext} gl Context.
   * @param {number} width Width in pixels.
   * @param {number} height Height in pixels.
   * @param {Object} [opts] Options.
   * @param {string} [opts.colorFormat] 'rgba8'|'rgba16f'|'r11g11b10'|'rg16f'|'r16f'|'rgba32f'.
   * @param {string[]} [opts.colorFormats] Per-attachment formats (overrides `colorFormat`).
   * @param {number} [opts.colorCount] Number of color attachments (default 1, 0 for depth-only).
   * @param {boolean} [opts.depth] Attach depth (default true).
   * @param {boolean} [opts.depthTexture] Use a sampleable depth texture instead of a renderbuffer.
   * @param {boolean} [opts.stencil] Use DEPTH24_STENCIL8 instead of DEPTH_COMPONENT24.
   * @param {string} [opts.filter] Color filtering, 'linear'|'nearest' (default 'linear').
   * @param {string} [opts.wrap] Color wrap mode (default 'clamp').
   * @param {number[]} [opts.clearColor] Clear color used by `bind(true)`.
   */
  constructor(gl, width, height, opts = {}) {
    /** @type {WebGL2RenderingContext} */
    this.gl = gl;
    /** @type {number} */
    this.width = Math.max(1, width | 0);
    /** @type {number} */
    this.height = Math.max(1, height | 0);
    /** @type {number} */
    this.colorCount = opts.colorCount === undefined ? 1 : Math.max(0, opts.colorCount | 0);
    /** @type {string[]} Resolved (post-fallback) format names, one per attachment. */
    this.colorFormats = [];
    const requested = opts.colorFormats || null;
    for (let i = 0; i < this.colorCount; i++) {
      const name = requested ? (requested[i] || requested[0]) : (opts.colorFormat || 'rgba8');
      this.colorFormats.push(resolveRenderFormat(gl, name));
    }
    /** @type {boolean} */
    this.hasDepth = opts.depth === undefined ? true : !!opts.depth;
    /** @type {boolean} */
    this.depthTexture = !!opts.depthTexture;
    /** @type {boolean} */
    this.stencil = !!opts.stencil;
    /** @type {string} */
    this.filter = opts.filter || 'linear';
    /** @type {string} */
    this.wrap = opts.wrap || 'clamp';
    /** @type {number[]} */
    this.clearColor = opts.clearColor ? opts.clearColor.slice(0, 4) : [0, 0, 0, 1];
    /** @type {number} */
    this.clearDepth = opts.clearDepth === undefined ? 1 : opts.clearDepth;
    /** @type {boolean} */
    this.disposed = false;

    /** @type {Texture2D[]} */
    this.colors = [];
    /** @type {Texture2D|null} Sampleable depth texture, when requested. */
    this.depthTex = null;
    /** @type {WebGLRenderbuffer|null} */
    this.depthBuffer = null;
    /** @type {number[]} Draw buffer enums, reused every bind (no per-frame allocation). */
    this.drawBuffers = [];

    /** @type {WebGLFramebuffer} */
    this.framebuffer = gl.createFramebuffer();
    this._createAttachments();
  }

  /**
   * Allocates textures/renderbuffers and attaches them to the framebuffer.
   * @returns {void}
   * @private
   */
  _createAttachments() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    this.colors.length = 0;
    this.drawBuffers.length = 0;

    for (let i = 0; i < this.colorCount; i++) {
      const preset = formatPreset(gl, this.colorFormats[i]);
      const tex = new Texture2D(gl, {
        width: this.width,
        height: this.height,
        internalFormat: preset.internalFormat,
        format: preset.format,
        type: preset.type,
        filter: this.filter,
        wrap: this.wrap,
        mipmaps: false,
        flipY: false
      });
      this.colors.push(tex);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex.texture, 0);
      this.drawBuffers.push(gl.COLOR_ATTACHMENT0 + i);
    }

    if (this.colorCount === 0) {
      gl.drawBuffers([gl.NONE]);
      gl.readBuffer(gl.NONE);
    } else {
      gl.drawBuffers(this.drawBuffers);
    }

    if (this.hasDepth) {
      const attachment = this.stencil ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT;
      if (this.depthTexture) {
        this.depthTex = new Texture2D(gl, {
          width: this.width,
          height: this.height,
          internalFormat: this.stencil ? 'depth24stencil8' : 'depth24',
          filter: 'nearest',
          wrap: 'clamp',
          mipmaps: false,
          flipY: false
        });
        gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, this.depthTex.texture, 0);
      } else {
        this.depthBuffer = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthBuffer);
        gl.renderbufferStorage(gl.RENDERBUFFER,
          this.stencil ? gl.DEPTH24_STENCIL8 : gl.DEPTH_COMPONENT24, this.width, this.height);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, attachment, gl.RENDERBUFFER, this.depthBuffer);
      }
    }

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      const name = FBO_STATUS_NAMES[status] || ('0x' + status.toString(16));
      this.dispose();
      throw new Error('RenderTarget: framebuffer incomplete (' + name + ') for ' +
        this.width + 'x' + this.height + ', colors=[' + this.colorFormats.join(', ') + '], depth=' +
        (this.hasDepth ? (this.depthTexture ? 'texture' : 'renderbuffer') : 'none') +
        (this.stencil ? '+stencil' : ''));
    }
  }

  /**
   * Binds the framebuffer, sets the viewport and the draw-buffer list.
   * Depth writes are re-enabled before clearing so a previous transparent pass
   * cannot silently swallow the depth clear.
   * A disposed target is a no-op: `this.framebuffer` is null once disposed, and binding null
   * would silently retarget (and with `clear` wipe) the canvas' default framebuffer.
   * @param {boolean} [clear] Clear color (and depth/stencil) after binding.
   * @returns {void}
   */
  bind(clear = true) {
    const gl = this.gl;
    if (this.disposed || !this.framebuffer) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    if (this.colorCount > 0) gl.drawBuffers(this.drawBuffers);
    if (!clear) return;
    let mask = 0;
    if (this.colorCount > 0) {
      const c = this.clearColor;
      gl.clearColor(c[0], c[1], c[2], c[3]);
      mask |= gl.COLOR_BUFFER_BIT;
    }
    if (this.hasDepth) {
      gl.depthMask(true);
      gl.clearDepth(this.clearDepth);
      mask |= gl.DEPTH_BUFFER_BIT;
      if (this.stencil) mask |= gl.STENCIL_BUFFER_BIT;
    }
    if (mask) gl.clear(mask);
  }

  /**
   * Sets the color used by `bind(true)`.
   * @param {number} r Red.
   * @param {number} g Green.
   * @param {number} b Blue.
   * @param {number} [a] Alpha.
   * @returns {void}
   */
  setClearColor(r, g, b, a = 1) {
    this.clearColor[0] = r;
    this.clearColor[1] = g;
    this.clearColor[2] = b;
    this.clearColor[3] = a;
  }

  /**
   * Reallocates every attachment at a new size. No-op when the size is unchanged.
   * @param {number} w New width in pixels.
   * @param {number} h New height in pixels.
   * @returns {void}
   */
  resize(w, h) {
    const gl = this.gl;
    const limit = (gl.__limits && gl.__limits.maxTextureSize) || 4096;
    const nw = Math.max(1, Math.min(limit, w | 0));
    const nh = Math.max(1, Math.min(limit, h | 0));
    if (nw === this.width && nh === this.height) return;
    this.width = nw;
    this.height = nh;
    this._destroyAttachments();
    this._createAttachments();
  }

  /**
   * Returns a color attachment.
   * @param {number} [i] Attachment index.
   * @returns {Texture2D} The attachment texture (exposes `.texture` and `.bind(unit)`).
   */
  color(i = 0) {
    return this.colors[i];
  }

  /**
   * Deletes attachment resources but keeps the framebuffer object alive.
   * @returns {void}
   * @private
   */
  _destroyAttachments() {
    const gl = this.gl;
    for (let i = 0; i < this.colors.length; i++) this.colors[i].dispose();
    this.colors.length = 0;
    if (this.depthTex) {
      this.depthTex.dispose();
      this.depthTex = null;
    }
    if (this.depthBuffer) {
      gl.deleteRenderbuffer(this.depthBuffer);
      this.depthBuffer = null;
    }
  }

  /**
   * Releases the framebuffer and all attachments.
   * @returns {void}
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._destroyAttachments();
    if (this.framebuffer) this.gl.deleteFramebuffer(this.framebuffer);
    this.framebuffer = null;
  }
}

/**
 * Binds the default framebuffer and sets the viewport to the whole drawing buffer.
 * @param {WebGL2RenderingContext} gl Context.
 * @param {number} [width] Viewport width (defaults to the canvas drawing buffer width).
 * @param {number} [height] Viewport height.
 * @returns {void}
 */
export function bindDefaultFramebuffer(gl, width, height) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0,
    width === undefined ? gl.drawingBufferWidth : width,
    height === undefined ? gl.drawingBufferHeight : height);
}

/* -------------------------------------------------------------------------- */
/* Fullscreen triangle                                                         */
/* -------------------------------------------------------------------------- */

/** Per-context empty VAO used by {@link drawFullscreen}. @type {WeakMap<object, object>} */
const FULLSCREEN_VAOS = new WeakMap();

/**
 * Draws a single oversized triangle covering the viewport. No vertex buffers are used:
 * the shader is expected to build clip-space positions from `gl_VertexID`, e.g.
 * `vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);`
 * A shared empty VAO is bound first because WebGL2 forbids drawing with VAO 0.
 * @param {WebGL2RenderingContext} gl Context.
 * @returns {void}
 */
export function drawFullscreen(gl) {
  let vao = FULLSCREEN_VAOS.get(gl);
  if (vao === undefined) {
    vao = gl.createVertexArray();
    FULLSCREEN_VAOS.set(gl, vao);
  }
  gl.bindVertexArray(vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
