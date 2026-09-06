/**
 * NEON CITY — procedural texture library.
 *
 * Every texture in the game is generated at load time into a 2D canvas
 * (`OffscreenCanvas` when available) and uploaded through `Texture2D`.
 * There are no image files, no data URIs and no network access.
 *
 * The module is organised in four layers:
 *   1. canvas / pixel helpers,
 *   2. noise (periodic Perlin + value noise, fBm, ridged, Worley, domain warp),
 *   3. one generator per texture (each returns a canvas, some also a height field),
 *   4. {@link buildTextureLibrary} which wires everything into GPU textures.
 *
 * All tiling textures are seamless *by construction*: every noise field is
 * sampled on a torus (integer lattice periods, wrapped cell lookups), every
 * feature layout is an exact integer division of the tile, and the Sobel
 * filter used for normal maps wraps at the borders.
 *
 * @module render/textures
 */

import { Texture2D } from '../core/gl.js';
import { Rand, clamp, lerp, smoothstep } from '../core/math.js';

const TWO_PI = Math.PI * 2;
const SQRT2 = Math.SQRT2;

/** Font stacks used by signs, billboards and graffiti (Korean + display faces). */
const FONT_KO = '"Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR","Nanum Gothic","WenQuanYi Zen Hei","Unifont",sans-serif';
const FONT_DISPLAY = '"Arial Black","Helvetica Neue",Impact,sans-serif';
const FONT_MONO = '"Courier New",monospace';

/** Base texture resolution per quality preset. */
const QUALITY_SIZE = { low: 256, medium: 512, high: 1024, ultra: 1024 };

/* ------------------------------------------------------------------------- *
 * 1. Canvas / pixel helpers
 * ------------------------------------------------------------------------- */

/**
 * Creates an offscreen drawing surface.
 * @param {number} w Width in pixels.
 * @param {number} h Height in pixels.
 * @returns {HTMLCanvasElement|OffscreenCanvas} A blank canvas.
 */
function createCanvas(w, h) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Gets a 2D context configured for frequent read-back.
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas Target canvas.
 * @returns {CanvasRenderingContext2D} The drawing context.
 */
function ctx2d(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  return ctx;
}

/**
 * Allocates an RGBA pixel buffer for a canvas.
 * @param {CanvasRenderingContext2D} ctx Context to allocate from.
 * @param {number} w Width.
 * @param {number} h Height.
 * @returns {ImageData} Zero-filled image data.
 */
function newImage(ctx, w, h) {
  return ctx.createImageData(w, h);
}

/**
 * Builds an `rgba()` CSS colour string.
 * @param {number} r Red 0..255.
 * @param {number} g Green 0..255.
 * @param {number} b Blue 0..255.
 * @param {number} [a] Alpha 0..1.
 * @returns {string} CSS colour.
 */
function rgba(r, g, b, a) {
  const al = a === undefined ? 1 : a;
  return 'rgba(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ',' + al.toFixed(3) + ')';
}

/**
 * Converts HSL to an `rgb()` CSS string.
 * @param {number} h Hue in degrees.
 * @param {number} s Saturation 0..1.
 * @param {number} l Lightness 0..1.
 * @returns {string} CSS colour.
 */
function hsl(h, s, l) {
  return 'hsl(' + h.toFixed(1) + ',' + (s * 100).toFixed(1) + '%,' + (l * 100).toFixed(1) + '%)';
}

/**
 * Bleeds opaque colour into fully transparent texels so mipmapping and
 * bilinear filtering never pull black halos out of an alpha-cut texture.
 * @param {Uint8ClampedArray} px RGBA pixels, modified in place.
 * @param {number} w Width.
 * @param {number} h Height.
 * @param {number} [passes] Dilation passes.
 * @returns {void}
 */
function bleedAlpha(px, w, h, passes) {
  const n = passes === undefined ? 4 : passes;
  const src = new Uint8ClampedArray(px.length);
  for (let pass = 0; pass < n; pass++) {
    src.set(px);
    let changed = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (src[i + 3] > 0) continue;
        let r = 0, g = 0, b = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const j = (yy * w + xx) * 4;
            if (src[j + 3] === 0) continue;
            r += src[j]; g += src[j + 1]; b += src[j + 2]; c++;
          }
        }
        if (c === 0) continue;
        px[i] = r / c; px[i + 1] = g / c; px[i + 2] = b / c;
        changed++;
      }
    }
    if (changed === 0) break;
  }
}

/* ------------------------------------------------------------------------- *
 * 2. Noise
 * ------------------------------------------------------------------------- */

/** 8 evenly spaced 2D gradients (unit length). */
const GRAD_X = new Float32Array([1, -1, 0, 0, 0.70710678, -0.70710678, 0.70710678, -0.70710678]);
const GRAD_Y = new Float32Array([0, 0, 1, -1, 0.70710678, 0.70710678, -0.70710678, -0.70710678]);

/**
 * Quintic interpolation curve (Perlin's improved fade).
 * @param {number} t Value in 0..1.
 * @returns {number} Eased value.
 */
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Permutation-table noise source. Every generator is *periodic*: lattice
 * coordinates are wrapped to the requested cell period so the resulting field
 * tiles seamlessly on a torus.
 */
class NoiseSource {
  /**
   * @param {number} seed Deterministic integer seed.
   */
  constructor(seed) {
    const rng = new Rand((seed >>> 0) || 1);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = rng.int(0, i);
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    /** @type {Uint8Array} Doubled permutation table. */
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    /** @type {Rand} Companion RNG (feature points, jitter). */
    this.rng = rng;
  }

  /**
   * Hashes an integer lattice coordinate pair to 0..255.
   * @param {number} ix Lattice x.
   * @param {number} iy Lattice y.
   * @returns {number} Hash value.
   */
  hash(ix, iy) {
    const p = this.perm;
    return p[(p[ix & 255] + (iy & 255)) & 255];
  }

  /**
   * Periodic 2D gradient (Perlin) noise.
   * @param {number} x Sample x in lattice units.
   * @param {number} y Sample y in lattice units.
   * @param {number} px Period along x, in lattice cells.
   * @param {number} py Period along y, in lattice cells.
   * @returns {number} Noise in about [-1, 1].
   */
  perlin2(x, y, px, py) {
    const pxi = px > 0 ? px | 0 : 256;
    const pyi = py > 0 ? py | 0 : 256;
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    let x0 = xi % pxi; if (x0 < 0) x0 += pxi;
    let y0 = yi % pyi; if (y0 < 0) y0 += pyi;
    const x1 = (x0 + 1) % pxi, y1 = (y0 + 1) % pyi;
    const p = this.perm;
    const c0 = p[x0 & 255], c1 = p[x1 & 255];
    const h00 = p[(c0 + y0) & 255] & 7, h10 = p[(c1 + y0) & 255] & 7;
    const h01 = p[(c0 + y1) & 255] & 7, h11 = p[(c1 + y1) & 255] & 7;
    const u = fade(fx), v = fade(fy);
    const n00 = GRAD_X[h00] * fx + GRAD_Y[h00] * fy;
    const n10 = GRAD_X[h10] * (fx - 1) + GRAD_Y[h10] * fy;
    const n01 = GRAD_X[h01] * fx + GRAD_Y[h01] * (fy - 1);
    const n11 = GRAD_X[h11] * (fx - 1) + GRAD_Y[h11] * (fy - 1);
    const a = n00 + u * (n10 - n00);
    const b = n01 + u * (n11 - n01);
    return (a + v * (b - a)) * SQRT2;
  }

  /**
   * Periodic 2D value noise (smoother, cheaper, slightly blockier than Perlin).
   * @param {number} x Sample x in lattice units.
   * @param {number} y Sample y in lattice units.
   * @param {number} px Period along x.
   * @param {number} py Period along y.
   * @returns {number} Noise in [-1, 1].
   */
  value2(x, y, px, py) {
    const pxi = px > 0 ? px | 0 : 256;
    const pyi = py > 0 ? py | 0 : 256;
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    let x0 = xi % pxi; if (x0 < 0) x0 += pxi;
    let y0 = yi % pyi; if (y0 < 0) y0 += pyi;
    const x1 = (x0 + 1) % pxi, y1 = (y0 + 1) % pyi;
    const u = fade(fx), v = fade(fy);
    const v00 = this.hash(x0, y0) / 127.5 - 1;
    const v10 = this.hash(x1, y0) / 127.5 - 1;
    const v01 = this.hash(x0, y1) / 127.5 - 1;
    const v11 = this.hash(x1, y1) / 127.5 - 1;
    const a = v00 + u * (v10 - v00);
    const b = v01 + u * (v11 - v01);
    return a + v * (b - a);
  }

  /**
   * Periodic fractal Brownian motion built from {@link NoiseSource#perlin2}.
   * @param {number} x Sample x in 0..1 tile space.
   * @param {number} y Sample y in 0..1 tile space.
   * @param {{freq?:number, octaves?:number, lacunarity?:number, gain?:number, ridged?:boolean}} [opts] Options.
   * @returns {number} Value in about [-1, 1] (0..1 when ridged).
   */
  fbm2(x, y, opts) {
    const o = opts || {};
    const octaves = o.octaves || 4;
    const lac = o.lacunarity || 2;
    const gain = o.gain === undefined ? 0.5 : o.gain;
    const ridged = !!o.ridged;
    let freq = o.freq || 4;
    let amp = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      const cells = Math.max(1, Math.round(freq));
      let n = this.perlin2(x * cells + i * 7, y * cells + i * 13, cells, cells);
      if (ridged) { n = 1 - Math.abs(n); n *= n; }
      sum += n * amp;
      norm += amp;
      amp *= gain;
      freq *= lac;
    }
    return sum / norm;
  }

  /**
   * Deterministic feature point for a Worley cell, in 0..1 cell space.
   * @param {number} ix Cell x.
   * @param {number} iy Cell y.
   * @param {Float32Array} out Receives [x, y].
   * @returns {Float32Array} out
   */
  cellPoint(ix, iy, out) {
    const p = this.perm;
    const a = p[(p[ix & 255] + (iy & 255)) & 255];
    const b = p[(p[(ix + 41) & 255] + ((iy + 97) & 255)) & 255];
    out[0] = a / 255;
    out[1] = b / 255;
    return out;
  }

  /**
   * Periodic Worley / cellular noise.
   * @param {number} x Sample x in 0..1 tile space.
   * @param {number} y Sample y in 0..1 tile space.
   * @param {number} cells Cells across the tile.
   * @param {string} [mode] 'f1' nearest distance, 'f2f1' cell edges.
   * @returns {number} Value in about [0, 1].
   */
  worley2(x, y, cells, mode) {
    const cx = Math.floor(x * cells), cy = Math.floor(y * cells);
    const pxs = x * cells, pys = y * cells;
    let f1 = 1e9, f2 = 1e9;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        let wx = nx % cells; if (wx < 0) wx += cells;
        let wy = ny % cells; if (wy < 0) wy += cells;
        this.cellPoint(wx, wy, SCRATCH_PT);
        const fxp = nx + SCRATCH_PT[0] - pxs;
        const fyp = ny + SCRATCH_PT[1] - pys;
        const d = fxp * fxp + fyp * fyp;
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
      }
    }
    f1 = Math.sqrt(f1); f2 = Math.sqrt(f2);
    if (mode === 'f2f1') return clamp(f2 - f1, 0, 1);
    return clamp(f1, 0, 1);
  }
}

/** Scratch pair reused by cell point lookups. */
const SCRATCH_PT = new Float32Array(2);

/* Column scratch buffers reused by the octave rasterisers. */
let SC_H0 = new Int32Array(0);
let SC_H1 = new Int32Array(0);
let SC_FX = new Float32Array(0);
let SC_U = new Float32Array(0);

/**
 * Grows the column scratch buffers.
 * @param {number} n Required length.
 * @returns {void}
 */
function ensureScratch(n) {
  if (SC_H0.length >= n) return;
  SC_H0 = new Int32Array(n);
  SC_H1 = new Int32Array(n);
  SC_FX = new Float32Array(n);
  SC_U = new Float32Array(n);
}

/**
 * Rasterises one periodic Perlin octave into a float field.
 * @param {Float32Array} dst Accumulator of length w*h.
 * @param {number} w Field width.
 * @param {number} h Field height.
 * @param {number} cellsX Lattice cells across the width (also the period).
 * @param {number} cellsY Lattice cells across the height.
 * @param {NoiseSource} noise Noise source.
 * @param {number} amp Octave amplitude.
 * @param {number} mode 0 = signed, 1 = ridged, 2 = turbulence (absolute).
 * @param {number} phase Integer lattice offset so octaves do not align.
 * @returns {void}
 */
function addPerlinOctave(dst, w, h, cellsX, cellsY, noise, amp, mode, phase) {
  ensureScratch(w);
  const perm = noise.perm;
  const px = cellsX, py = cellsY;
  const sx = cellsX / w, sy = cellsY / h;
  const ph = phase | 0;
  for (let x = 0; x < w; x++) {
    const fx = x * sx + ph;
    const xi = Math.floor(fx);
    let x0 = xi % px; if (x0 < 0) x0 += px;
    const x1 = (x0 + 1) % px;
    SC_H0[x] = perm[x0 & 255];
    SC_H1[x] = perm[x1 & 255];
    SC_FX[x] = fx - xi;
    SC_U[x] = fade(fx - xi);
  }
  for (let y = 0; y < h; y++) {
    const fy = y * sy + ph * 2;
    const yi = Math.floor(fy);
    let y0 = yi % py; if (y0 < 0) y0 += py;
    const y1 = (y0 + 1) % py;
    const gy = fy - yi;
    const gy1 = gy - 1;
    const v = fade(gy);
    const row = y * w;
    const b0 = y0 & 255, b1 = y1 & 255;
    for (let x = 0; x < w; x++) {
      const c0 = SC_H0[x], c1 = SC_H1[x];
      const h00 = perm[(c0 + b0) & 255] & 7, h10 = perm[(c1 + b0) & 255] & 7;
      const h01 = perm[(c0 + b1) & 255] & 7, h11 = perm[(c1 + b1) & 255] & 7;
      const gx = SC_FX[x], gx1 = gx - 1, u = SC_U[x];
      const n00 = GRAD_X[h00] * gx + GRAD_Y[h00] * gy;
      const n10 = GRAD_X[h10] * gx1 + GRAD_Y[h10] * gy;
      const n01 = GRAD_X[h01] * gx + GRAD_Y[h01] * gy1;
      const n11 = GRAD_X[h11] * gx1 + GRAD_Y[h11] * gy1;
      const a = n00 + u * (n10 - n00);
      const b = n01 + u * (n11 - n01);
      let n = (a + v * (b - a)) * SQRT2;
      if (mode === 1) { n = 1 - (n < 0 ? -n : n); n *= n; } else if (mode === 2) { n = n < 0 ? -n : n; }
      dst[row + x] += n * amp;
    }
  }
}

/**
 * Rasterises one periodic value-noise octave into a float field.
 * @param {Float32Array} dst Accumulator of length w*h.
 * @param {number} w Field width.
 * @param {number} h Field height.
 * @param {number} cellsX Lattice cells across the width.
 * @param {number} cellsY Lattice cells across the height.
 * @param {NoiseSource} noise Noise source.
 * @param {number} amp Octave amplitude.
 * @param {number} phase Integer lattice offset.
 * @returns {void}
 */
function addValueOctave(dst, w, h, cellsX, cellsY, noise, amp, phase) {
  ensureScratch(w);
  const perm = noise.perm;
  const px = cellsX, py = cellsY;
  const sx = cellsX / w, sy = cellsY / h;
  const ph = phase | 0;
  for (let x = 0; x < w; x++) {
    const fx = x * sx + ph;
    const xi = Math.floor(fx);
    let x0 = xi % px; if (x0 < 0) x0 += px;
    const x1 = (x0 + 1) % px;
    SC_H0[x] = perm[x0 & 255];
    SC_H1[x] = perm[x1 & 255];
    SC_U[x] = fade(fx - xi);
  }
  for (let y = 0; y < h; y++) {
    const fy = y * sy + ph * 3;
    const yi = Math.floor(fy);
    let y0 = yi % py; if (y0 < 0) y0 += py;
    const y1 = (y0 + 1) % py;
    const v = fade(fy - yi);
    const row = y * w;
    const b0 = y0 & 255, b1 = y1 & 255;
    for (let x = 0; x < w; x++) {
      const c0 = SC_H0[x], c1 = SC_H1[x];
      const v00 = perm[(c0 + b0) & 255] * 0.00784314 - 1;
      const v10 = perm[(c1 + b0) & 255] * 0.00784314 - 1;
      const v01 = perm[(c0 + b1) & 255] * 0.00784314 - 1;
      const v11 = perm[(c1 + b1) & 255] * 0.00784314 - 1;
      const u = SC_U[x];
      const a = v00 + u * (v10 - v00);
      const b = v01 + u * (v11 - v01);
      dst[row + x] += (a + v * (b - a)) * amp;
    }
  }
}

/**
 * Builds a seamless fBm / ridged / turbulence field.
 * @param {number} w Width.
 * @param {number} h Height.
 * @param {NoiseSource} noise Noise source.
 * @param {{freq?:number, freqX?:number, freqY?:number, octaves?:number, lacunarity?:number,
 *          gain?:number, mode?:string, value?:boolean, signed?:boolean}} [opts] Options.
 *   `freqX`/`freqY` allow anisotropic (stretched) noise; `mode` is
 *   'fbm' | 'ridged' | 'turbulence'.
 * @returns {Float32Array} Field in [0,1] (or [-1,1] when `opts.signed`).
 */
function fbmField(w, h, noise, opts) {
  const o = opts || {};
  const octaves = o.octaves || 4;
  const lac = o.lacunarity || 2;
  const gain = o.gain === undefined ? 0.5 : o.gain;
  const mode = o.mode === 'ridged' ? 1 : (o.mode === 'turbulence' ? 2 : 0);
  const useValue = !!o.value;
  const out = new Float32Array(w * h);
  let fx = o.freqX || o.freq || 4;
  let fy = o.freqY || o.freq || 4;
  let amp = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const cx = Math.max(1, Math.round(fx));
    const cy = Math.max(1, Math.round(fy));
    if (useValue) addValueOctave(out, w, h, cx, cy, noise, amp, i * 11 + 1);
    else addPerlinOctave(out, w, h, cx, cy, noise, amp, mode, i * 7 + 1);
    norm += amp;
    amp *= gain;
    fx *= lac;
    fy *= lac;
  }
  const inv = 1 / norm;
  if (o.signed) {
    for (let i = 0; i < out.length; i++) out[i] *= inv;
  } else if (mode === 0) {
    for (let i = 0; i < out.length; i++) out[i] = out[i] * inv * 0.5 + 0.5;
  } else {
    for (let i = 0; i < out.length; i++) out[i] *= inv;
  }
  return out;
}

/**
 * Builds a seamless Worley / cellular field.
 * @param {number} w Width.
 * @param {number} h Height.
 * @param {NoiseSource} noise Noise source.
 * @param {number} cellsX Cells across the width.
 * @param {number} cellsY Cells across the height.
 * @param {{mode?:string, jitter?:number, outId?:Float32Array}} [opts] Options:
 *   `mode` 'f1' (default, distance to nearest point) or 'f2f1' (cell borders);
 *   `outId` receives the per-cell random value of the closest feature point.
 * @returns {Float32Array} Field roughly in [0,1].
 */
function worleyField(w, h, noise, cellsX, cellsY, opts) {
  const o = opts || {};
  const mode = o.mode || 'f1';
  const jitter = o.jitter === undefined ? 0.9 : o.jitter;
  const outId = o.outId || null;
  const out = new Float32Array(w * h);
  const cw = w / cellsX, ch = h / cellsY;
  const total = cellsX * cellsY;
  const fpx = new Float32Array(total);
  const fpy = new Float32Array(total);
  const fid = new Float32Array(total);
  const rng = new Rand((noise.perm[7] << 16) ^ (cellsX * 131 + cellsY * 17) ^ 0x9e37);
  for (let i = 0; i < total; i++) {
    fpx[i] = 0.5 + (rng.next() - 0.5) * jitter;
    fpy[i] = 0.5 + (rng.next() - 0.5) * jitter;
    fid[i] = rng.next();
  }
  const norm = 1 / Math.sqrt(cw * cw + ch * ch);
  const candX = new Float32Array(9);
  const candY = new Float32Array(9);
  const candId = new Float32Array(9);
  for (let cy = 0; cy < cellsY; cy++) {
    const y0 = Math.floor(cy * ch), y1 = Math.floor((cy + 1) * ch);
    for (let cx = 0; cx < cellsX; cx++) {
      const x0 = Math.floor(cx * cw), x1 = Math.floor((cx + 1) * cw);
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          let wx = (cx + dx) % cellsX; if (wx < 0) wx += cellsX;
          let wy = (cy + dy) % cellsY; if (wy < 0) wy += cellsY;
          const idx = wy * cellsX + wx;
          candX[k] = (cx + dx + fpx[idx]) * cw;
          candY[k] = (cy + dy + fpy[idx]) * ch;
          candId[k] = fid[idx];
          k++;
        }
      }
      for (let y = y0; y < y1; y++) {
        const row = y * w;
        const py = y + 0.5;
        for (let x = x0; x < x1; x++) {
          const pxc = x + 0.5;
          let d1 = 1e18, d2 = 1e18, id = 0;
          for (let i = 0; i < 9; i++) {
            const ddx = candX[i] - pxc, ddy = candY[i] - py;
            const d = ddx * ddx + ddy * ddy;
            if (d < d1) { d2 = d1; d1 = d; id = candId[i]; } else if (d < d2) { d2 = d; }
          }
          const f1 = Math.sqrt(d1) * norm;
          out[row + x] = mode === 'f2f1' ? clamp((Math.sqrt(d2) - Math.sqrt(d1)) * norm, 0, 1) : clamp(f1, 0, 1);
          if (outId) outId[row + x] = id;
        }
      }
    }
  }
  return out;
}

/**
 * Bilinear field sample with toroidal wrapping.
 * @param {Float32Array} f Source field.
 * @param {number} w Width.
 * @param {number} h Height.
 * @param {number} x Sample x in pixels (may be out of range).
 * @param {number} y Sample y in pixels.
 * @returns {number} Interpolated value.
 */
function sampleField(f, w, h, x, y) {
  let x0 = Math.floor(x), y0 = Math.floor(y);
  const tx = x - x0, ty = y - y0;
  x0 = ((x0 % w) + w) % w;
  y0 = ((y0 % h) + h) % h;
  const x1 = x0 + 1 === w ? 0 : x0 + 1;
  const y1 = y0 + 1 === h ? 0 : y0 + 1;
  const r0 = y0 * w, r1 = y1 * w;
  const a = f[r0 + x0] + tx * (f[r0 + x1] - f[r0 + x0]);
  const b = f[r1 + x0] + tx * (f[r1 + x1] - f[r1 + x0]);
  return a + ty * (b - a);
}

/**
 * Domain-warps a tileable field by two low-frequency offset fields. The result
 * stays tileable because every sample wraps on the torus.
 * @param {Float32Array} src Field to warp.
 * @param {number} w Width.
 * @param {number} h Height.
 * @param {Float32Array} wx Offset field for x (0..1).
 * @param {Float32Array} wy Offset field for y (0..1).
 * @param {number} amount Warp distance in pixels.
 * @returns {Float32Array} New warped field.
 */
function warpField(src, w, h, wx, wy, amount) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      out[i] = sampleField(src, w, h, x + (wx[i] - 0.5) * amount, y + (wy[i] - 0.5) * amount);
    }
  }
  return out;
}

/**
 * Separable box blur with wrapped edges (keeps a tiling field tiling).
 * @param {Float32Array} src Source field.
 * @param {number} w Width.
 * @param {number} h Height.
 * @param {number} radius Blur radius in pixels.
 * @returns {Float32Array} New blurred field.
 */
function blurField(src, w, h, radius) {
  const r = Math.max(1, radius | 0);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const inv = 1 / (r * 2 + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + (((k % w) + w) % w)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum * inv;
      const outIdx = ((x - r) % w + w) % w;
      const inIdx = ((x + r + 1) % w + w) % w;
      sum += src[row + inIdx] - src[row + outIdx];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[(((k % h) + h) % h) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum * inv;
      const outIdx = ((y - r) % h + h) % h;
      const inIdx = ((y + r + 1) % h + h) % h;
      sum += tmp[inIdx * w + x] - tmp[outIdx * w + x];
    }
  }
  return out;
}

/**
 * Rescales a field so its actual min/max map to 0..1.
 * @param {Float32Array} f Field, modified in place.
 * @returns {Float32Array} f
 */
function normalizeField(f) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < f.length; i++) {
    const v = f[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const d = hi - lo;
  if (d < 1e-6) return f;
  const inv = 1 / d;
  for (let i = 0; i < f.length; i++) f[i] = (f[i] - lo) * inv;
  return f;
}

/**
 * Generates a real blue-noise mask with the void-and-cluster algorithm
 * (Ulichney 1993). The energy field is evaluated toroidally, so the result
 * tiles seamlessly and has no low-frequency clumping.
 * @param {number} w Width (small, e.g. 64).
 * @param {number} h Height.
 * @param {number} seed Deterministic seed.
 * @returns {Float32Array} Dither values in [0,1).
 */
function blueNoiseField(w, h, seed) {
  const n = w * h;
  const rng = new Rand(seed || 7);
  const pattern = new Uint8Array(n);
  const energy = new Float32Array(n);
  const rank = new Int32Array(n).fill(-1);
  const kr = 6;
  const ks = kr * 2 + 1;
  const kernel = new Float32Array(ks * ks);
  const sigma = 1.9;
  for (let y = -kr; y <= kr; y++) {
    for (let x = -kr; x <= kr; x++) {
      kernel[(y + kr) * ks + (x + kr)] = Math.exp(-(x * x + y * y) / (2 * sigma * sigma));
    }
  }
  /**
   * Splats the kernel around a point.
   * @param {number} idx Pixel index.
   * @param {number} sign +1 to add, -1 to remove.
   * @returns {void}
   */
  const splat = (idx, sign) => {
    const px = idx % w, py = (idx / w) | 0;
    for (let y = -kr; y <= kr; y++) {
      let yy = (py + y) % h; if (yy < 0) yy += h;
      const row = yy * w;
      const krow = (y + kr) * ks;
      for (let x = -kr; x <= kr; x++) {
        let xx = (px + x) % w; if (xx < 0) xx += w;
        energy[row + xx] += sign * kernel[krow + (x + kr)];
      }
    }
  };
  /**
   * Finds the tightest cluster (max energy among set pixels).
   * @returns {number} Pixel index.
   */
  const tightest = () => {
    let best = -1, bv = -Infinity;
    for (let i = 0; i < n; i++) {
      if (pattern[i] === 1 && energy[i] > bv) { bv = energy[i]; best = i; }
    }
    return best;
  };
  /**
   * Finds the largest void (min energy among unset pixels).
   * @returns {number} Pixel index.
   */
  const largestVoid = () => {
    let best = -1, bv = Infinity;
    for (let i = 0; i < n; i++) {
      if (pattern[i] === 0 && energy[i] < bv) { bv = energy[i]; best = i; }
    }
    return best;
  };

  let ones = Math.max(16, Math.round(n * 0.1));
  let placed = 0;
  while (placed < ones) {
    const i = rng.int(0, n - 1);
    if (pattern[i]) continue;
    pattern[i] = 1;
    splat(i, 1);
    placed++;
  }
  for (let iter = 0; iter < ones * 4; iter++) {
    const c = tightest();
    pattern[c] = 0; splat(c, -1);
    const v = largestVoid();
    if (v === c) { pattern[c] = 1; splat(c, 1); break; }
    pattern[v] = 1; splat(v, 1);
  }
  const initial = pattern.slice();
  const initialEnergy = energy.slice();
  for (let r = ones - 1; r >= 0; r--) {
    const c = tightest();
    pattern[c] = 0; splat(c, -1);
    rank[c] = r;
  }
  pattern.set(initial);
  energy.set(initialEnergy);
  for (let r = ones; r < n; r++) {
    const v = largestVoid();
    pattern[v] = 1; splat(v, 1);
    rank[v] = r;
  }
  const out = new Float32Array(n);
  const inv = 1 / n;
  for (let i = 0; i < n; i++) out[i] = (rank[i] + 0.5) * inv;
  return out;
}

/**
 * Writes a float field into a canvas as greyscale (or a two-colour ramp).
 * @param {Float32Array} field Field in [0,1].
 * @param {number} w Width.
 * @param {number} h Height.
 * @param {{colorA?:number[], colorB?:number[], alphaFromField?:boolean, alpha?:number}} [opts] Options.
 * @returns {HTMLCanvasElement|OffscreenCanvas} Canvas holding the field.
 */
function fieldToCanvas(field, w, h, opts) {
  const o = opts || {};
  const a = o.colorA || [0, 0, 0];
  const b = o.colorB || [255, 255, 255];
  const canvas = createCanvas(w, h);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, w, h);
  const px = img.data;
  for (let i = 0, p = 0; i < field.length; i++, p += 4) {
    const t = field[i] < 0 ? 0 : (field[i] > 1 ? 1 : field[i]);
    px[p] = a[0] + (b[0] - a[0]) * t;
    px[p + 1] = a[1] + (b[1] - a[1]) * t;
    px[p + 2] = a[2] + (b[2] - a[2]) * t;
    px[p + 3] = o.alphaFromField ? t * 255 : (o.alpha === undefined ? 255 : o.alpha * 255);
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Generates a procedural noise canvas. Exported so other systems (fog volumes,
 * UI backdrops, particle masks) can reuse the same noise implementation.
 *
 * @param {number} w Canvas width.
 * @param {number} h Canvas height.
 * @param {object} [opts] Generation options.
 * @param {string} [opts.type] 'fbm' | 'perlin' | 'value' | 'ridged' | 'turbulence' |
 *   'worley' | 'cells' | 'warp' | 'blue'.
 * @param {number} [opts.seed] Deterministic seed (default 1).
 * @param {number} [opts.freq] Base frequency in cells across the tile (default 4).
 * @param {number} [opts.freqX] Horizontal frequency override (anisotropic noise).
 * @param {number} [opts.freqY] Vertical frequency override.
 * @param {number} [opts.octaves] fBm octaves (default 4).
 * @param {number} [opts.lacunarity] Frequency multiplier per octave (default 2).
 * @param {number} [opts.gain] Amplitude multiplier per octave (default 0.5).
 * @param {number} [opts.warp] Domain-warp distance in pixels (type 'warp').
 * @param {number} [opts.warpFreq] Frequency of the warp field (default 3).
 * @param {number} [opts.contrast] Contrast around 0.5 (1 = unchanged).
 * @param {number} [opts.brightness] Additive offset applied after contrast.
 * @param {boolean} [opts.invert] Inverts the field.
 * @param {boolean} [opts.normalize] Rescales min/max to 0..1.
 * @param {number[]} [opts.colorA] RGB for field value 0 (default black).
 * @param {number[]} [opts.colorB] RGB for field value 1 (default white).
 * @param {boolean} [opts.alphaFromField] Writes the field into alpha instead of a solid 255.
 * @returns {HTMLCanvasElement|OffscreenCanvas} The generated canvas (seamlessly tileable).
 */
export function makeNoiseCanvas(w, h, opts) {
  const o = opts || {};
  const seed = o.seed === undefined ? 1 : o.seed;
  const noise = new NoiseSource(seed);
  const type = o.type || 'fbm';
  let field;
  if (type === 'blue') {
    field = blueNoiseField(w, h, seed);
  } else if (type === 'worley' || type === 'cells') {
    const cells = Math.max(1, Math.round(o.freq || 8));
    field = worleyField(w, h, noise, cells, cells, { mode: type === 'cells' ? 'f2f1' : 'f1' });
  } else if (type === 'warp') {
    const base = fbmField(w, h, noise, o);
    const wx = fbmField(w, h, new NoiseSource(seed + 101), { freq: o.warpFreq || 3, octaves: 2 });
    const wy = fbmField(w, h, new NoiseSource(seed + 202), { freq: o.warpFreq || 3, octaves: 2 });
    field = warpField(base, w, h, wx, wy, o.warp === undefined ? w * 0.08 : o.warp);
  } else {
    const mode = type === 'ridged' ? 'ridged' : (type === 'turbulence' ? 'turbulence' : 'fbm');
    field = fbmField(w, h, noise, {
      freq: o.freq, freqX: o.freqX, freqY: o.freqY,
      octaves: type === 'perlin' || type === 'value' ? 1 : o.octaves,
      lacunarity: o.lacunarity, gain: o.gain,
      mode: mode, value: type === 'value'
    });
    if (type === 'value') for (let i = 0; i < field.length; i++) field[i] = field[i] * 0.5 + 0.5;
  }
  if (o.normalize) normalizeField(field);
  const contrast = o.contrast === undefined ? 1 : o.contrast;
  const brightness = o.brightness === undefined ? 0 : o.brightness;
  if (contrast !== 1 || brightness !== 0 || o.invert) {
    for (let i = 0; i < field.length; i++) {
      let v = (field[i] - 0.5) * contrast + 0.5 + brightness;
      if (o.invert) v = 1 - v;
      field[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
    }
  }
  return fieldToCanvas(field, w, h, o);
}

/**
 * Converts a height field into a tangent-space normal map canvas using a
 * wrapped Sobel filter (so tiling height maps produce tiling normal maps).
 * Output is OpenGL convention: RGB = normal * 0.5 + 0.5, green = +Y (up in UV).
 * @param {Float32Array} field Height field in roughly [0,1].
 * @param {number} w Width.
 * @param {number} h Height.
 * @param {number} strength Bump strength (1 = subtle, 8 = very pronounced).
 * @returns {HTMLCanvasElement|OffscreenCanvas} Normal map canvas.
 */
function normalCanvasFromField(field, w, h, strength) {
  const canvas = createCanvas(w, h);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, w, h);
  const px = img.data;
  const s = strength === undefined ? 2 : strength;
  for (let y = 0; y < h; y++) {
    const ym = ((y - 1) + h) % h, yp = (y + 1) % h;
    const r0 = ym * w, r1 = y * w, r2 = yp * w;
    for (let x = 0; x < w; x++) {
      const xm = ((x - 1) + w) % w, xp = (x + 1) % w;
      const h00 = field[r0 + xm], h10 = field[r0 + x], h20 = field[r0 + xp];
      const h01 = field[r1 + xm], h21 = field[r1 + xp];
      const h02 = field[r2 + xm], h12 = field[r2 + x], h22 = field[r2 + xp];
      const gx = (h20 + 2 * h21 + h22) - (h00 + 2 * h01 + h02);
      const gy = (h02 + 2 * h12 + h22) - (h00 + 2 * h10 + h20);
      let nx = -gx * s, ny = gy * s, nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv; ny *= inv; nz *= inv;
      const p = (r1 + x) * 4;
      px[p] = nx * 127.5 + 127.5;
      px[p + 1] = ny * 127.5 + 127.5;
      px[p + 2] = nz * 127.5 + 127.5;
      px[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Builds a tangent-space normal map from a greyscale height canvas.
 * Luminance is used as height; the Sobel filter wraps at the borders so a
 * seamless height map yields a seamless normal map.
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas Height source.
 * @param {number} [strength] Bump strength (default 2).
 * @returns {HTMLCanvasElement|OffscreenCanvas} Normal map canvas (RGB = XYZ*0.5+0.5).
 */
export function normalMapFromHeight(canvas, strength) {
  const w = canvas.width, h = canvas.height;
  const src = ctx2d(canvas).getImageData(0, 0, w, h).data;
  const field = new Float32Array(w * h);
  for (let i = 0, p = 0; i < field.length; i++, p += 4) {
    field[i] = (src[p] * 0.299 + src[p + 1] * 0.587 + src[p + 2] * 0.114) / 255;
  }
  return normalCanvasFromField(field, w, h, strength === undefined ? 2 : strength);
}

/**
 * Adds a soft radial blob into a field with wrapped coordinates (stays tileable).
 * @param {Float32Array} field Target field.
 * @param {number} w Width.
 * @param {number} h Height.
 * @param {number} cx Centre x in pixels.
 * @param {number} cy Centre y in pixels.
 * @param {number} radius Radius in pixels.
 * @param {number} strength Peak amount added.
 * @param {Float32Array|null} jitter Optional 0..1 field modulating the blob edge.
 * @returns {void}
 */
function splatBlob(field, w, h, cx, cy, radius, strength, jitter) {
  const r = Math.ceil(radius);
  const ix = Math.round(cx), iy = Math.round(cy);
  const invR = 1 / Math.max(1e-3, radius);
  for (let dy = -r; dy <= r; dy++) {
    let y = (iy + dy) % h; if (y < 0) y += h;
    const row = y * w;
    for (let dx = -r; dx <= r; dx++) {
      let x = (ix + dx) % w; if (x < 0) x += w;
      const d = Math.sqrt(dx * dx + dy * dy) * invR;
      if (d >= 1) continue;
      const i = row + x;
      let f = 1 - smoothstep(0.15, 1, d);
      if (jitter) f *= 0.45 + 1.1 * jitter[i];
      const v = field[i] + f * strength;
      field[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
    }
  }
}

/* ------------------------------------------------------------------------- *
 * 3. Ground and building material generators
 * ------------------------------------------------------------------------- */

/**
 * Asphalt road surface: Worley aggregate, fBm blotches, tar seams,
 * wheel-polished lanes, oil stains and ridged cracks.
 * @param {number} S Texture size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray, height:Float32Array}} Result.
 */
function genAsphalt(S, seed) {
  const noise = new NoiseSource(seed);
  const rng = new Rand(seed ^ 0x51ab);
  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;

  const cells = Math.max(10, Math.round(S / 9));
  const blotch = fbmField(S, S, noise, { freq: 3, octaves: 4, gain: 0.55 });
  const grain = fbmField(S, S, new NoiseSource(seed + 3), { freq: Math.max(32, S / 5), octaves: 2, gain: 0.5, value: true });
  const aggId = new Float32Array(S * S);
  const agg = worleyField(S, S, new NoiseSource(seed + 5), cells, cells, { mode: 'f1', jitter: 1, outId: aggId });
  const crack = fbmField(S, S, new NoiseSource(seed + 7), { freq: 5, octaves: 5, gain: 0.58, mode: 'ridged' });

  /* Oil stains, splatted as wrapped blobs so the tile stays seamless. */
  const oil = new Float32Array(S * S);
  const oilJitter = fbmField(S, S, new NoiseSource(seed + 11), { freq: 12, octaves: 3 });
  const stains = 5;
  for (let i = 0; i < stains; i++) {
    const cx = rng.next() * S, cy = rng.next() * S;
    const r = S * (0.035 + rng.next() * 0.06);
    splatBlob(oil, S, S, cx, cy, r, 0.85, oilJitter);
    for (let d = 0; d < 4; d++) {
      splatBlob(oil, S, S, cx + (rng.next() - 0.5) * r * 2.4, cy + (rng.next() - 0.5) * r * 2.4,
        r * (0.15 + rng.next() * 0.3), 0.6, oilJitter);
    }
  }

  /* Wobbling tar seams (one along each axis) using per-sample Perlin. */
  const seamU = new Float32Array(S);
  const seamV = new Float32Array(S);
  for (let i = 0; i < S; i++) {
    const t = i / S;
    seamU[i] = 0.34 + noise.perlin2(t * 6, 11.5, 6, 1) * 0.035;
    seamV[i] = 0.71 + noise.perlin2(t * 5, 27.5, 5, 1) * 0.03;
  }

  const height = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    const row = y * S;
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const i = row + x;
      const u = x / S;

      let tone = 30 + blotch[i] * 20;
      /* Aggregate: bright stone chips with per-stone tint. */
      const chip = smoothstep(0.62, 0.16, agg[i]);
      const chipTone = 0.55 + aggId[i] * 0.9;
      tone += chip * 26 * chipTone;
      /* Fine grain. */
      const g = grain[i] - 0.5;
      tone += g * 15;

      /* Wheel-polished lanes running along +V. */
      const laneA = 1 - smoothstep(0.02, 0.13, Math.abs(u - 0.27));
      const laneB = 1 - smoothstep(0.02, 0.13, Math.abs(u - 0.73));
      const lane = Math.max(laneA, laneB) * (0.55 + blotch[i] * 0.45);
      tone = lerp(tone, tone * 0.86 + 4, lane * 0.75);

      /* Tar seams. */
      let du = Math.abs(u - seamU[y]); du = Math.min(du, 1 - du);
      let dv = Math.abs(v - seamV[x]); dv = Math.min(dv, 1 - dv);
      const seam = Math.max(1 - smoothstep(0.002, 0.012, du), 1 - smoothstep(0.002, 0.010, dv));
      tone = lerp(tone, 22 + grain[i] * 8, seam * 0.9);

      /* Cracks. */
      const cr = smoothstep(0.80, 0.97, crack[i]);
      tone = lerp(tone, 16, cr * 0.85);

      /* Oil. */
      const ol = oil[i];
      tone = lerp(tone, tone * 0.32 + 3, clamp(ol, 0, 1) * 0.9);

      const p = i * 4;
      px[p] = tone * 0.98;
      px[p + 1] = tone;
      px[p + 2] = tone * 1.07 + 1;
      px[p + 3] = 255;

      height[i] = clamp(0.45 + chip * 0.35 + g * 0.25 - cr * 0.55 - seam * 0.3 - lane * 0.06, 0, 1);
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px, height: height };
}

/**
 * UV rectangles of the `roadLines` atlas, in **canvas space**: `u` runs left to
 * right, `v` runs top to bottom of `library.canvases.roadLines`. If the texture
 * uploader flips Y (`UNPACK_FLIP_Y_WEBGL`), use `1 - v`. Arrows point towards
 * `v = 0` (the direction of travel).
 * @type {{dash:{u0:number,v0:number,u1:number,v1:number},
 *         solid:{u0:number,v0:number,u1:number,v1:number},
 *         doubleYellow:{u0:number,v0:number,u1:number,v1:number},
 *         stopBar:{u0:number,v0:number,u1:number,v1:number},
 *         crosswalk:{u0:number,v0:number,u1:number,v1:number},
 *         arrowStraight:{u0:number,v0:number,u1:number,v1:number},
 *         arrowLeft:{u0:number,v0:number,u1:number,v1:number},
 *         arrowRight:{u0:number,v0:number,u1:number,v1:number},
 *         parking:{u0:number,v0:number,u1:number,v1:number}}}
 */
export const ROAD_MARKING_UV = {
  dash: { u0: 0.00, v0: 0.00, u1: 0.25, v1: 0.25 },
  solid: { u0: 0.25, v0: 0.00, u1: 0.50, v1: 0.25 },
  doubleYellow: { u0: 0.50, v0: 0.00, u1: 0.75, v1: 0.25 },
  stopBar: { u0: 0.75, v0: 0.00, u1: 1.00, v1: 0.25 },
  crosswalk: { u0: 0.00, v0: 0.25, u1: 1.00, v1: 0.75 },
  arrowStraight: { u0: 0.00, v0: 0.75, u1: 0.25, v1: 1.00 },
  arrowLeft: { u0: 0.25, v0: 0.75, u1: 0.50, v1: 1.00 },
  arrowRight: { u0: 0.50, v0: 0.75, u1: 0.75, v1: 1.00 },
  parking: { u0: 0.75, v0: 0.75, u1: 1.00, v1: 1.00 }
};

/**
 * Road marking atlas: transparent background, crisp paint, worn by noise.
 * Layout matches {@link ROAD_MARKING_UV}.
 * @param {number} S Texture size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray}} Result.
 */
function genRoadLines(S, seed) {
  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const Q = S / 4;
  const WHITE = '#f2f4f0';
  const YELLOW = '#f5c22b';
  ctx.clearRect(0, 0, S, S);
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';

  /* Row 0 — line primitives. */
  ctx.fillStyle = WHITE;
  ctx.fillRect(Q * 0.42, Q * 0.12, Q * 0.16, Q * 0.76);                 // dash
  ctx.fillRect(Q + Q * 0.42, 0, Q * 0.16, Q);                            // solid
  ctx.fillStyle = YELLOW;
  ctx.fillRect(2 * Q + Q * 0.34, 0, Q * 0.11, Q);                        // double yellow
  ctx.fillRect(2 * Q + Q * 0.55, 0, Q * 0.11, Q);
  ctx.fillStyle = WHITE;
  ctx.fillRect(3 * Q + Q * 0.06, Q * 0.30, Q * 0.88, Q * 0.30);          // stop bar

  /* Rows 1-2 — continental crosswalk: bars along the travel direction. */
  const bars = 8;
  const barW = S / (bars * 2 - 0.6);
  ctx.fillStyle = WHITE;
  for (let i = 0; i < bars; i++) {
    ctx.fillRect(i * barW * 2 + barW * 0.3, Q * 1.06, barW, Q * 1.88);
  }
  ctx.fillRect(0, Q * 1.0, S, Q * 0.045);
  ctx.fillRect(0, Q * 2.955, S, Q * 0.045);

  /* Row 3 — arrows and parking stall marks. */
  const arrowY = 3 * Q;
  /**
   * Draws a lane arrow inside a cell.
   * @param {number} cx Cell origin x.
   * @param {number} turn -1 left, 0 straight, 1 right.
   * @returns {void}
   */
  const arrow = (cx, turn) => {
    ctx.save();
    ctx.translate(cx, arrowY);
    ctx.fillStyle = WHITE;
    const shaftW = Q * 0.16;
    if (turn === 0) {
      ctx.fillRect(Q * 0.5 - shaftW * 0.5, Q * 0.34, shaftW, Q * 0.56);
      ctx.beginPath();
      ctx.moveTo(Q * 0.5, Q * 0.10);
      ctx.lineTo(Q * 0.5 + Q * 0.20, Q * 0.42);
      ctx.lineTo(Q * 0.5 - Q * 0.20, Q * 0.42);
      ctx.closePath();
      ctx.fill();
    } else {
      const dir = turn;
      ctx.fillRect(Q * 0.5 - shaftW * 0.5, Q * 0.46, shaftW, Q * 0.44);
      ctx.beginPath();
      ctx.moveTo(Q * 0.5 - shaftW * 0.5, Q * 0.52);
      ctx.quadraticCurveTo(Q * 0.5 - shaftW * 0.5, Q * 0.30, Q * (0.5 + dir * 0.26), Q * 0.30);
      ctx.lineTo(Q * (0.5 + dir * 0.26), Q * 0.30 + shaftW);
      ctx.quadraticCurveTo(Q * 0.5 + shaftW * 0.5, Q * 0.30 + shaftW, Q * 0.5 + shaftW * 0.5, Q * 0.52);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(Q * (0.5 + dir * 0.44), Q * 0.36);
      ctx.lineTo(Q * (0.5 + dir * 0.22), Q * 0.18);
      ctx.lineTo(Q * (0.5 + dir * 0.22), Q * 0.54);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  };
  arrow(0, 0);
  arrow(Q, -1);
  arrow(2 * Q, 1);
  /* Parking stall: corner mark plus bay divider. */
  ctx.fillStyle = WHITE;
  ctx.fillRect(3 * Q + Q * 0.10, arrowY + Q * 0.12, Q * 0.08, Q * 0.76);
  ctx.fillRect(3 * Q + Q * 0.10, arrowY + Q * 0.12, Q * 0.5, Q * 0.08);
  ctx.fillRect(3 * Q + Q * 0.10, arrowY + Q * 0.80, Q * 0.5, Q * 0.08);
  ctx.fillRect(3 * Q + Q * 0.78, arrowY + Q * 0.12, Q * 0.08, Q * 0.76);

  /* Wear the paint with noise so markings never look like decals. */
  const noise = new NoiseSource(seed);
  const wear = fbmField(S, S, noise, { freq: 14, octaves: 4, gain: 0.55 });
  const scuff = fbmField(S, S, new NoiseSource(seed + 4), { freq: Math.max(40, S / 6), octaves: 2, value: true });
  const img = ctx.getImageData(0, 0, S, S);
  const px = img.data;
  for (let i = 0, p = 0; i < S * S; i++, p += 4) {
    if (px[p + 3] === 0) continue;
    const w = wear[i];
    let a = px[p + 3] / 255;
    a *= 0.66 + 0.34 * smoothstep(0.25, 0.72, w);
    a *= 0.86 + 0.14 * scuff[i];
    if (w < 0.24) a *= smoothstep(0.10, 0.24, w) * 0.8 + 0.2;
    px[p + 3] = a * 255;
    const dirt = (scuff[i] - 0.5) * 26 - (1 - w) * 12;
    px[p] += dirt; px[p + 1] += dirt; px[p + 2] += dirt * 0.9;
  }
  bleedAlpha(px, S, S, 3);
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px };
}

/**
 * Sidewalk paving slabs with grout, chipped edges, stains and speckle.
 * @param {number} S Texture size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray, height:Float32Array}} Result.
 */
function genSidewalk(S, seed) {
  const noise = new NoiseSource(seed);
  const rng = new Rand(seed ^ 0x2f19);
  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;

  const SLABS = 4;
  const slabTone = new Float32Array(SLABS * SLABS);
  for (let i = 0; i < slabTone.length; i++) slabTone[i] = rng.range(-1, 1);

  const speck = fbmField(S, S, noise, { freq: Math.max(48, S / 4), octaves: 2, value: true });
  const mottle = fbmField(S, S, new NoiseSource(seed + 2), { freq: 7, octaves: 4, gain: 0.5 });
  const chipN = fbmField(S, S, new NoiseSource(seed + 3), { freq: 26, octaves: 3 });
  const stain = new Float32Array(S * S);
  const stainJ = fbmField(S, S, new NoiseSource(seed + 5), { freq: 16, octaves: 3 });
  for (let i = 0; i < 7; i++) {
    splatBlob(stain, S, S, rng.next() * S, rng.next() * S, S * rng.range(0.03, 0.10), rng.range(0.25, 0.6), stainJ);
  }
  const grit = worleyField(S, S, new NoiseSource(seed + 9), Math.max(20, Math.round(S / 5)), Math.max(20, Math.round(S / 5)), { mode: 'f1' });

  const height = new Float32Array(S * S);
  const g = 0.030;   // grout half-width in cell units
  for (let y = 0; y < S; y++) {
    const row = y * S;
    const fy = y / S * SLABS;
    const cy = Math.floor(fy), ly = fy - cy;
    for (let x = 0; x < S; x++) {
      const i = row + x;
      const fx = x / S * SLABS;
      const cx = Math.floor(fx), lx = fx - cx;

      /* Distance to the nearest slab border, perturbed for chipped edges. */
      const ex = Math.min(lx, 1 - lx);
      const ey = Math.min(ly, 1 - ly);
      let edge = Math.min(ex, ey) + (chipN[i] - 0.5) * 0.028;
      const groove = 1 - smoothstep(g, g + 0.022, edge);

      const tone = slabTone[(cy % SLABS) * SLABS + (cx % SLABS)];
      let c = 158 + tone * 9 + (mottle[i] - 0.5) * 26 + (speck[i] - 0.5) * 20;
      c += smoothstep(0.55, 0.05, grit[i]) * 12;
      c = lerp(c, 96 + (speck[i] - 0.5) * 14, groove);
      c = lerp(c, c * 0.62, clamp(stain[i], 0, 1));

      const p = i * 4;
      px[p] = c * 1.02;
      px[p + 1] = c;
      px[p + 2] = c * 0.95;
      px[p + 3] = 255;
      height[i] = clamp(0.72 - groove * 0.62 + (speck[i] - 0.5) * 0.12 + smoothstep(0.5, 0.05, grit[i]) * 0.06, 0, 1);
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px, height: height };
}

/**
 * Poured concrete: mottling, form-board seams, pitting and aggregate.
 * @param {number} S Texture size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray, height:Float32Array}} Result.
 */
function genConcrete(S, seed) {
  const noise = new NoiseSource(seed);
  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;

  const base = fbmField(S, S, noise, { freq: 4, octaves: 5, gain: 0.55 });
  const wx = fbmField(S, S, new NoiseSource(seed + 21), { freq: 3, octaves: 2 });
  const wy = fbmField(S, S, new NoiseSource(seed + 22), { freq: 3, octaves: 2 });
  const mottle = warpField(base, S, S, wx, wy, S * 0.06);
  const grain = fbmField(S, S, new NoiseSource(seed + 23), { freq: Math.max(64, S / 4), octaves: 2, value: true });
  const pits = worleyField(S, S, new NoiseSource(seed + 24), Math.max(14, Math.round(S / 12)), Math.max(14, Math.round(S / 12)), { mode: 'f1' });
  const streak = fbmField(S, S, new NoiseSource(seed + 25), { freqX: 6, freqY: 40, octaves: 3 });

  const height = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    const row = y * S;
    const v = y / S;
    /* Two horizontal form-board seams per tile. */
    const seam = Math.max(
      1 - smoothstep(0.0, 0.006, Math.abs(v - 0.5)),
      1 - smoothstep(0.0, 0.006, Math.min(v, 1 - v))
    );
    for (let x = 0; x < S; x++) {
      const i = row + x;
      let c = 150 + (mottle[i] - 0.5) * 46 + (grain[i] - 0.5) * 16;
      c -= smoothstep(0.5, 1.0, streak[i]) * 10;
      const pit = smoothstep(0.30, 0.0, pits[i]);
      c -= pit * 30;
      c = lerp(c, c * 0.82, seam);
      const p = i * 4;
      px[p] = c * 1.0;
      px[p + 1] = c * 0.99;
      px[p + 2] = c * 0.96;
      px[p + 3] = 255;
      height[i] = clamp(0.6 + (mottle[i] - 0.5) * 0.3 + (grain[i] - 0.5) * 0.18 - pit * 0.5 - seam * 0.35, 0, 1);
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px, height: height };
}

/**
 * Brick wall in running bond with mortar, per-brick tone and chipped corners.
 * @param {number} S Texture size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray, height:Float32Array}} Result.
 */
function genBrick(S, seed) {
  const noise = new NoiseSource(seed);
  const rng = new Rand(seed ^ 0x77c1);
  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;

  const ROWS = 8, COLS = 4;
  const total = ROWS * COLS;
  const tint = new Float32Array(total);
  const hue = new Float32Array(total);
  for (let i = 0; i < total; i++) { tint[i] = rng.range(-1, 1); hue[i] = rng.next(); }

  const grain = fbmField(S, S, noise, { freq: Math.max(40, S / 5), octaves: 3, value: true });
  const blotch = fbmField(S, S, new NoiseSource(seed + 31), { freq: 9, octaves: 3 });
  const chip = fbmField(S, S, new NoiseSource(seed + 32), { freq: 30, octaves: 3 });
  const mortarN = fbmField(S, S, new NoiseSource(seed + 33), { freq: Math.max(30, S / 8), octaves: 3 });
  const dirt = fbmField(S, S, new NoiseSource(seed + 34), { freqX: 5, freqY: 14, octaves: 3 });

  const height = new Float32Array(S * S);
  const mortarX = 0.035, mortarY = 0.09;
  for (let y = 0; y < S; y++) {
    const row = y * S;
    const fy = y / S * ROWS;
    const ry = Math.floor(fy);
    const ly = fy - ry;
    const offset = (ry & 1) ? 0.5 : 0;
    for (let x = 0; x < S; x++) {
      const i = row + x;
      const fx = x / S * COLS + offset;
      const rx = Math.floor(fx);
      const lx = fx - rx;

      const ex = Math.min(lx, 1 - lx) + (chip[i] - 0.5) * 0.05;
      const ey = Math.min(ly, 1 - ly) + (chip[i] - 0.5) * 0.10;
      const mx = 1 - smoothstep(mortarX, mortarX + 0.02, ex);
      const my = 1 - smoothstep(mortarY, mortarY + 0.05, ey);
      const mortar = Math.max(mx, my);

      const id = (ry % ROWS) * COLS + (((rx % COLS) + COLS) % COLS);
      const t = tint[id], hh = hue[id];
      let r = 138 + t * 26 + hh * 22;
      let gch = 62 + t * 14 + hh * 16;
      let b = 48 + t * 10 + hh * 12;
      const gr = (grain[i] - 0.5) * 26 + (blotch[i] - 0.5) * 22;
      r += gr; gch += gr * 0.7; b += gr * 0.5;
      /* Weathering streaks below each course. */
      const wsh = smoothstep(0.45, 1.0, dirt[i]) * 16;
      r -= wsh; gch -= wsh * 0.8; b -= wsh * 0.6;

      const mc = 168 + (mortarN[i] - 0.5) * 34;
      r = lerp(r, mc, mortar);
      gch = lerp(gch, mc * 0.98, mortar);
      b = lerp(b, mc * 0.92, mortar);

      const p = i * 4;
      px[p] = r; px[p + 1] = gch; px[p + 2] = b; px[p + 3] = 255;
      height[i] = clamp(0.78 - mortar * 0.6 + (grain[i] - 0.5) * 0.14, 0, 1);
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px, height: height };
}

/**
 * Painted / brushed metal panel with seams, rivets, brush streaks and rust.
 * @param {number} S Texture size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray, height:Float32Array}} Result.
 */
function genMetal(S, seed) {
  const noise = new NoiseSource(seed);
  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;

  const brush = fbmField(S, S, noise, { freqX: Math.max(96, S / 3), freqY: 4, octaves: 3, value: true });
  const rust = fbmField(S, S, new NoiseSource(seed + 41), { freq: 6, octaves: 5, gain: 0.55 });
  const rustFine = fbmField(S, S, new NoiseSource(seed + 42), { freq: 34, octaves: 3 });
  const dents = fbmField(S, S, new NoiseSource(seed + 43), { freq: 9, octaves: 3 });

  const PANELS = 2;
  const rivetR = S * 0.008;
  const height = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    const row = y * S;
    const fy = y / S * PANELS, ly = fy - Math.floor(fy);
    for (let x = 0; x < S; x++) {
      const i = row + x;
      const fx = x / S * PANELS, lx = fx - Math.floor(fx);
      const ex = Math.min(lx, 1 - lx), ey = Math.min(ly, 1 - ly);
      const seam = Math.max(1 - smoothstep(0.004, 0.012, ex), 1 - smoothstep(0.004, 0.012, ey));

      /* Rivets march along the seams. */
      const nrx = (x / S * PANELS * 16) % 1, nry = (y / S * PANELS * 16) % 1;
      const nearSeamX = ex < 0.028, nearSeamY = ey < 0.028;
      let rivet = 0;
      if (nearSeamX || nearSeamY) {
        const dx = (nrx - 0.5), dy = (nry - 0.5);
        const d = Math.sqrt(dx * dx + dy * dy);
        rivet = 1 - smoothstep(0.16, 0.26, d);
        if (nearSeamX && nearSeamY) rivet *= 1;
      }

      let base = 128 + (brush[i] - 0.5) * 46 + (dents[i] - 0.5) * 16;
      let r = base * 0.96, g = base * 0.99, b = base * 1.04;
      r += rivet * 26; g += rivet * 26; b += rivet * 26;
      const seamShade = seam * 0.55;
      r = lerp(r, r * 0.55, seamShade); g = lerp(g, g * 0.55, seamShade); b = lerp(b, b * 0.58, seamShade);

      /* Rust blooms. */
      const rz = smoothstep(0.58, 0.86, rust[i]) * (0.5 + rustFine[i] * 0.7);
      r = lerp(r, 118 + rustFine[i] * 40, rz);
      g = lerp(g, 62 + rustFine[i] * 26, rz);
      b = lerp(b, 34 + rustFine[i] * 16, rz);

      const p = i * 4;
      px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = 255;
      height[i] = clamp(0.6 - seam * 0.45 + rivet * 0.35 + (brush[i] - 0.5) * 0.08 + (dents[i] - 0.5) * 0.12 - rz * 0.1, 0, 1);
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px, height: height };
}

/**
 * Built-up roof: tar paper with a dense layer of loose gravel.
 * @param {number} S Texture size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray, height:Float32Array}} Result.
 */
function genRoofGravel(S, seed) {
  const noise = new NoiseSource(seed);
  const cells = Math.max(24, Math.round(S / 6));
  const id = new Float32Array(S * S);
  const stones = worleyField(S, S, noise, cells, cells, { mode: 'f1', jitter: 1, outId: id });
  const small = worleyField(S, S, new NoiseSource(seed + 51), cells * 2, cells * 2, { mode: 'f1', jitter: 1 });
  const tar = fbmField(S, S, new NoiseSource(seed + 52), { freq: 5, octaves: 4 });
  const grain = fbmField(S, S, new NoiseSource(seed + 53), { freq: Math.max(60, S / 4), octaves: 2, value: true });

  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;
  const height = new Float32Array(S * S);
  for (let i = 0, p = 0; i < S * S; i++, p += 4) {
    const st = smoothstep(0.72, 0.10, stones[i]);
    const sm = smoothstep(0.62, 0.12, small[i]) * 0.6;
    const tint = id[i];
    let c = 46 + tar[i] * 22 + (grain[i] - 0.5) * 12;
    const stoneC = 92 + tint * 78;
    c = lerp(c, stoneC * (0.8 + (grain[i] - 0.5) * 0.3), Math.max(st, sm));
    px[p] = c * (0.96 + tint * 0.1);
    px[p + 1] = c * (0.97 + tint * 0.04);
    px[p + 2] = c * (0.92 + tint * 0.06);
    px[p + 3] = 255;
    height[i] = clamp(0.3 + st * 0.55 + sm * 0.2 + (grain[i] - 0.5) * 0.1, 0, 1);
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px, height: height };
}

/**
 * Polished interior tile floor with grout lines and marble veining.
 * @param {number} S Texture size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray, height:Float32Array}} Result.
 */
function genTileFloor(S, seed) {
  const noise = new NoiseSource(seed);
  const rng = new Rand(seed ^ 0x1234);
  const TILES = 8;
  const tone = new Float32Array(TILES * TILES);
  for (let i = 0; i < tone.length; i++) tone[i] = rng.range(-1, 1);

  const veinBase = fbmField(S, S, noise, { freq: 4, octaves: 4, mode: 'ridged' });
  const wx = fbmField(S, S, new NoiseSource(seed + 61), { freq: 2, octaves: 3 });
  const wy = fbmField(S, S, new NoiseSource(seed + 62), { freq: 2, octaves: 3 });
  const veins = warpField(veinBase, S, S, wx, wy, S * 0.12);
  const grain = fbmField(S, S, new NoiseSource(seed + 63), { freq: Math.max(60, S / 4), octaves: 2, value: true });
  const wear = fbmField(S, S, new NoiseSource(seed + 64), { freq: 7, octaves: 3 });

  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;
  const height = new Float32Array(S * S);
  const g = 0.026;
  for (let y = 0; y < S; y++) {
    const row = y * S;
    const fy = y / S * TILES, ty = Math.floor(fy), ly = fy - ty;
    for (let x = 0; x < S; x++) {
      const i = row + x;
      const fx = x / S * TILES, tx = Math.floor(fx), lx = fx - tx;
      const edge = Math.min(Math.min(lx, 1 - lx), Math.min(ly, 1 - ly));
      const grout = 1 - smoothstep(g, g + 0.014, edge);
      const t = tone[(ty % TILES) * TILES + (tx % TILES)];

      let c = 206 + t * 10 + (grain[i] - 0.5) * 10;
      const vein = smoothstep(0.72, 0.98, veins[i]);
      c = lerp(c, 150 + t * 8, vein * 0.85);
      c -= smoothstep(0.55, 0.95, wear[i]) * 10;
      const gc = 128 + (grain[i] - 0.5) * 16;
      c = lerp(c, gc, grout);

      const p = i * 4;
      px[p] = c * 1.0;
      px[p + 1] = c * 0.995;
      px[p + 2] = c * 0.97;
      px[p + 3] = 255;
      height[i] = clamp(0.85 - grout * 0.7 - vein * 0.05 + (grain[i] - 0.5) * 0.05, 0, 1);
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px, height: height };
}

/**
 * Lawn / park grass seen from above: colour variation, blade detail, bare patches.
 * @param {number} S Texture size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray, height:Float32Array}} Result.
 */
function genGrass(S, seed) {
  const noise = new NoiseSource(seed);
  const clump = fbmField(S, S, noise, { freq: 5, octaves: 4, gain: 0.55 });
  const blades = fbmField(S, S, new NoiseSource(seed + 71), { freqX: Math.max(80, S / 3), freqY: Math.max(30, S / 8), octaves: 2, value: true });
  const blades2 = fbmField(S, S, new NoiseSource(seed + 72), { freqX: Math.max(30, S / 8), freqY: Math.max(80, S / 3), octaves: 2, value: true });
  const bare = fbmField(S, S, new NoiseSource(seed + 73), { freq: 3, octaves: 3 });
  const dry = fbmField(S, S, new NoiseSource(seed + 74), { freq: 11, octaves: 3 });

  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;
  const height = new Float32Array(S * S);
  for (let i = 0, p = 0; i < S * S; i++, p += 4) {
    const bl = (blades[i] - 0.5) + (blades2[i] - 0.5) * 0.7;
    const shade = 0.72 + clump[i] * 0.5 + bl * 0.45;
    let r = 44 * shade, g = 86 * shade, b = 34 * shade;
    /* Dry / yellowed patches. */
    const d = smoothstep(0.55, 0.85, dry[i]);
    r = lerp(r, r * 1.55 + 22, d); g = lerp(g, g * 1.12 + 14, d); b = lerp(b, b * 0.7, d);
    /* Bare earth showing through. */
    const e = smoothstep(0.74, 0.93, bare[i]);
    r = lerp(r, 84 + bl * 26, e); g = lerp(g, 66 + bl * 20, e); b = lerp(b, 46 + bl * 14, e);
    px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = 255;
    height[i] = clamp(0.5 + bl * 0.6 + (clump[i] - 0.5) * 0.4 - e * 0.25, 0, 1);
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px, height: height };
}

/**
 * Dry dirt / dust ground with pebbles and shrinkage cracks.
 * @param {number} S Texture size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray, height:Float32Array}} Result.
 */
function genDirt(S, seed) {
  const noise = new NoiseSource(seed);
  const base = fbmField(S, S, noise, { freq: 4, octaves: 5, gain: 0.55 });
  const grain = fbmField(S, S, new NoiseSource(seed + 81), { freq: Math.max(70, S / 4), octaves: 2, value: true });
  const pebbleId = new Float32Array(S * S);
  const pebbles = worleyField(S, S, new NoiseSource(seed + 82), Math.max(18, Math.round(S / 12)), Math.max(18, Math.round(S / 12)), { mode: 'f1', jitter: 1, outId: pebbleId });
  const crackCells = worleyField(S, S, new NoiseSource(seed + 83), 7, 7, { mode: 'f2f1', jitter: 0.9 });
  const damp = fbmField(S, S, new NoiseSource(seed + 84), { freq: 3, octaves: 3 });

  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;
  const height = new Float32Array(S * S);
  for (let i = 0, p = 0; i < S * S; i++, p += 4) {
    const t = base[i] * 0.7 + grain[i] * 0.3;
    let r = 118 + t * 46, g = 92 + t * 38, b = 66 + t * 28;
    const peb = smoothstep(0.34, 0.06, pebbles[i]);
    const pt = 0.7 + pebbleId[i] * 0.7;
    r = lerp(r, 128 * pt, peb); g = lerp(g, 118 * pt, peb); b = lerp(b, 104 * pt, peb);
    const cr = 1 - smoothstep(0.0, 0.06, crackCells[i]);
    r = lerp(r, r * 0.42, cr); g = lerp(g, g * 0.42, cr); b = lerp(b, b * 0.44, cr);
    const dm = smoothstep(0.62, 0.92, damp[i]);
    r = lerp(r, r * 0.72, dm); g = lerp(g, g * 0.74, dm); b = lerp(b, b * 0.78, dm);
    px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = 255;
    height[i] = clamp(0.55 + peb * 0.4 + (grain[i] - 0.5) * 0.25 - cr * 0.6, 0, 1);
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px, height: height };
}

/**
 * Beach sand: fine grain, wind ripples, scattered shell fragments.
 * @param {number} S Texture size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray, height:Float32Array}} Result.
 */
function genSand(S, seed) {
  const noise = new NoiseSource(seed);
  const grain = fbmField(S, S, noise, { freq: Math.max(90, S / 3), octaves: 2, value: true });
  const dunes = fbmField(S, S, new NoiseSource(seed + 91), { freq: 3, octaves: 4 });
  const rippleWarp = fbmField(S, S, new NoiseSource(seed + 92), { freq: 4, octaves: 3 });
  const shellId = new Float32Array(S * S);
  const shells = worleyField(S, S, new NoiseSource(seed + 93), Math.max(16, Math.round(S / 14)), Math.max(16, Math.round(S / 14)), { mode: 'f1', jitter: 1, outId: shellId });

  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;
  const height = new Float32Array(S * S);
  const RIPPLES = 14;
  for (let y = 0; y < S; y++) {
    const row = y * S;
    for (let x = 0; x < S; x++) {
      const i = row + x;
      /* Ripples: an integer number of periods keeps the tile seamless. */
      const phase = (y / S + (rippleWarp[i] - 0.5) * 0.12 + (dunes[i] - 0.5) * 0.05) * TWO_PI * RIPPLES;
      const rip = Math.sin(phase) * 0.5 + 0.5;
      const t = dunes[i] * 0.5 + grain[i] * 0.5;
      let c = 196 + t * 34 + (rip - 0.5) * 16;
      const sh = smoothstep(0.16, 0.02, shells[i]) * (shellId[i] > 0.55 ? 1 : 0);
      c = lerp(c, 236, sh);
      const p = i * 4;
      px[p] = c * 1.02;
      px[p + 1] = c * 0.955;
      px[p + 2] = c * 0.79;
      px[p + 3] = 255;
      height[i] = clamp(0.5 + (rip - 0.5) * 0.5 + (grain[i] - 0.5) * 0.3 + (dunes[i] - 0.5) * 0.3 + sh * 0.3, 0, 1);
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px, height: height };
}

/**
 * Tree bark: vertical furrows, cracks, lichen. Tiles along both axes so it can
 * wrap a trunk cylinder.
 * @param {number} S Texture size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray, height:Float32Array}} Result.
 */
function genTreeBark(S, seed) {
  const noise = new NoiseSource(seed);
  const furrow = fbmField(S, S, noise, { freqX: 14, freqY: 3, octaves: 4, mode: 'ridged', gain: 0.55 });
  const wx = fbmField(S, S, new NoiseSource(seed + 101), { freqX: 6, freqY: 2, octaves: 2 });
  const wy = fbmField(S, S, new NoiseSource(seed + 102), { freqX: 6, freqY: 2, octaves: 2 });
  const warped = warpField(furrow, S, S, wx, wy, S * 0.05);
  const fine = fbmField(S, S, new NoiseSource(seed + 103), { freqX: 40, freqY: 12, octaves: 3, value: true });
  const moss = fbmField(S, S, new NoiseSource(seed + 104), { freq: 6, octaves: 3 });
  const knots = worleyField(S, S, new NoiseSource(seed + 105), 4, 3, { mode: 'f1', jitter: 1 });

  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;
  const height = new Float32Array(S * S);
  for (let i = 0, p = 0; i < S * S; i++, p += 4) {
    const f = warped[i];
    const crack = smoothstep(0.32, 0.0, f);
    const ridge = smoothstep(0.45, 0.95, f);
    let shade = 0.55 + ridge * 0.55 - crack * 0.35 + (fine[i] - 0.5) * 0.3;
    const knot = smoothstep(0.22, 0.02, knots[i]);
    shade = lerp(shade, 0.42, knot * 0.8);
    let r = 96 * shade, g = 74 * shade, b = 56 * shade;
    const mo = smoothstep(0.66, 0.9, moss[i]) * (1 - crack * 0.5);
    r = lerp(r, 62 * shade + 10, mo * 0.7);
    g = lerp(g, 84 * shade + 16, mo * 0.7);
    b = lerp(b, 48 * shade + 8, mo * 0.7);
    px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = 255;
    height[i] = clamp(0.45 + ridge * 0.5 - crack * 0.55 + (fine[i] - 0.5) * 0.15 - knot * 0.2, 0, 1);
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px, height: height };
}

/**
 * Alpha-cut foliage cluster card used for tree canopies and bushes.
 * @param {number} S Texture size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray}} Result.
 */
function genLeaves(S, seed) {
  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const rng = new Rand(seed ^ 0x4e21);
  ctx.clearRect(0, 0, S, S);

  /**
   * Draws one leaf as a pointed oval with a midrib.
   * @param {number} cx Centre x.
   * @param {number} cy Centre y.
   * @param {number} len Leaf length.
   * @param {number} rot Rotation in radians.
   * @param {string} fill Fill colour.
   * @param {string} vein Vein colour.
   * @returns {void}
   */
  const leaf = (cx, cy, len, rot, fill, vein) => {
    const wdt = len * 0.42;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.beginPath();
    ctx.moveTo(0, -len * 0.5);
    ctx.bezierCurveTo(wdt, -len * 0.18, wdt * 0.85, len * 0.28, 0, len * 0.5);
    ctx.bezierCurveTo(-wdt * 0.85, len * 0.28, -wdt, -len * 0.18, 0, -len * 0.5);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = vein;
    ctx.lineWidth = Math.max(1, len * 0.035);
    ctx.beginPath();
    ctx.moveTo(0, -len * 0.44);
    ctx.lineTo(0, len * 0.44);
    ctx.stroke();
    ctx.restore();
  };

  const cx = S * 0.5, cy = S * 0.5;
  /* Three depth layers: dark interior first, bright rim leaves last. */
  const layers = [
    { count: 90, rad: 0.40, len: 0.20, light: 0.55 },
    { count: 80, rad: 0.44, len: 0.17, light: 0.80 },
    { count: 70, rad: 0.46, len: 0.14, light: 1.12 }
  ];
  for (let l = 0; l < layers.length; l++) {
    const cfg = layers[l];
    for (let i = 0; i < cfg.count; i++) {
      const ang = rng.next() * TWO_PI;
      const rad = Math.sqrt(rng.next()) * S * cfg.rad;
      const x = cx + Math.cos(ang) * rad;
      const y = cy + Math.sin(ang) * rad * 0.92;
      const len = S * cfg.len * rng.range(0.6, 1.25);
      const hue = 88 + rng.range(-14, 18);
      const sat = 0.38 + rng.next() * 0.26;
      const lig = clamp((0.17 + rng.next() * 0.16) * cfg.light, 0.05, 0.62);
      leaf(x, y, len, rng.next() * TWO_PI, hsl(hue, sat, lig), hsl(hue - 6, sat * 0.8, lig * 0.62));
    }
  }

  /* Break up the silhouette and punch holes so it reads as foliage, not a blob. */
  const noise = new NoiseSource(seed + 7);
  const holes = fbmField(S, S, noise, { freq: 9, octaves: 4 });
  const img = ctx.getImageData(0, 0, S, S);
  const px = img.data;
  for (let y = 0; y < S; y++) {
    const row = y * S;
    const dy = (y - cy) / (S * 0.5);
    for (let x = 0; x < S; x++) {
      const i = row + x;
      const p = i * 4;
      if (px[p + 3] === 0) continue;
      const dx = (x - cx) / (S * 0.5);
      const d = Math.sqrt(dx * dx + dy * dy);
      let a = px[p + 3] / 255;
      a *= 1 - smoothstep(0.72, 1.0, d + (holes[i] - 0.5) * 0.42);
      if (holes[i] < 0.30) a *= smoothstep(0.16, 0.30, holes[i]);
      px[p + 3] = a > 0.42 ? 255 : 0;    // alpha cut-out, no soft fringe
    }
  }
  bleedAlpha(px, S, S, 5);
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px };
}

/**
 * Sea water surface: layered wind waves and small ripples with foam glints.
 * @param {number} S Texture size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray, height:Float32Array}} Result.
 */
function genWater(S, seed) {
  const noise = new NoiseSource(seed);
  const swellBase = fbmField(S, S, noise, { freqX: 3, freqY: 5, octaves: 3, gain: 0.55 });
  const wx = fbmField(S, S, new NoiseSource(seed + 111), { freq: 3, octaves: 2 });
  const wy = fbmField(S, S, new NoiseSource(seed + 112), { freq: 3, octaves: 2 });
  const swell = warpField(swellBase, S, S, wx, wy, S * 0.05);
  const ripple = fbmField(S, S, new NoiseSource(seed + 113), { freqX: 18, freqY: 22, octaves: 3, mode: 'ridged' });
  const fine = fbmField(S, S, new NoiseSource(seed + 114), { freq: Math.max(48, S / 6), octaves: 2 });

  const height = new Float32Array(S * S);
  for (let i = 0; i < height.length; i++) {
    height[i] = clamp(swell[i] * 0.55 + ripple[i] * 0.33 + fine[i] * 0.12, 0, 1);
  }
  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;
  for (let y = 0; y < S; y++) {
    const row = y * S;
    for (let x = 0; x < S; x++) {
      const i = row + x;
      const hgt = height[i];
      /* Fake sky reflection: crests catch light, troughs go deep teal. */
      const crest = smoothstep(0.55, 0.92, hgt);
      const trough = smoothstep(0.45, 0.05, hgt);
      let r = 14 + crest * 76 - trough * 6;
      let g = 46 + crest * 96 - trough * 14;
      let b = 62 + crest * 96 - trough * 18;
      const foam = smoothstep(0.86, 0.99, ripple[i] * 0.6 + hgt * 0.6);
      r = lerp(r, 208, foam * 0.75);
      g = lerp(g, 224, foam * 0.75);
      b = lerp(b, 232, foam * 0.75);
      const p = i * 4;
      px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px, height: height };
}

/**
 * Metallic flake / clear-coat detail noise used to break up car paint.
 * @param {number} S Texture size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray}} Result.
 */
function genCarPaintNoise(S, seed) {
  const noise = new NoiseSource(seed);
  const flake = fbmField(S, S, noise, { freq: Math.max(96, S / 2), octaves: 2, value: true });
  const flake2 = worleyField(S, S, new NoiseSource(seed + 121), Math.max(64, Math.round(S / 3)), Math.max(64, Math.round(S / 3)), { mode: 'f1', jitter: 1 });
  const orangePeel = fbmField(S, S, new NoiseSource(seed + 122), { freq: 22, octaves: 3 });
  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;
  for (let i = 0, p = 0; i < S * S; i++, p += 4) {
    const sparkle = smoothstep(0.30, 0.0, flake2[i]) * (0.35 + flake[i] * 0.9);
    let c = 128 + (orangePeel[i] - 0.5) * 26 + (flake[i] - 0.5) * 22 + sparkle * 74;
    px[p] = c; px[p + 1] = c * 0.995; px[p + 2] = c * 1.01; px[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px };
}

/**
 * Tyre map: U wraps the circumference, V crosses the tread from sidewall to
 * sidewall. Includes a chevron tread block pattern and raised sidewall lettering.
 * @param {number} S Texture size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray, height:Float32Array}} Result.
 */
function genTire(S, seed) {
  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const noise = new NoiseSource(seed);
  const grain = fbmField(S, S, noise, { freq: Math.max(60, S / 4), octaves: 2, value: true });
  const wear = fbmField(S, S, new NoiseSource(seed + 131), { freq: 8, octaves: 3 });

  const img = newImage(ctx, S, S);
  const px = img.data;
  const height = new Float32Array(S * S);
  const BLOCKS = 16;         // tread blocks around the circumference
  for (let y = 0; y < S; y++) {
    const row = y * S;
    const v = y / S;                      // across the tread
    const across = Math.abs(v - 0.5) * 2; // 0 centre, 1 sidewall
    for (let x = 0; x < S; x++) {
      const i = row + x;
      const u = x / S;
      let tread = 0;
      if (across < 0.62) {
        /* Chevron blocks: shift the block phase with the distance from centre. */
        const skew = (v - 0.5) * 2.2;
        const bu = (u * BLOCKS + skew * 1.4) % 1;
        const bv = (v * 6) % 1;
        const gx = 1 - smoothstep(0.06, 0.14, Math.min(bu, 1 - bu));
        const gy = 1 - smoothstep(0.08, 0.18, Math.min(bv, 1 - bv));
        const groove = Math.max(gx, gy * 0.9);
        /* Two continuous circumferential grooves. */
        const circ = Math.max(
          1 - smoothstep(0.012, 0.03, Math.abs(across - 0.24)),
          1 - smoothstep(0.010, 0.028, Math.abs(across - 0.50))
        );
        tread = Math.max(groove, circ);
      }
      const shoulder = smoothstep(0.62, 0.80, across);
      let c = 30 + (grain[i] - 0.5) * 14 + wear[i] * 8;
      c *= 1 - tread * 0.55;
      c *= 1 - shoulder * 0.12;
      const p = i * 4;
      px[p] = c; px[p + 1] = c * 1.0; px[p + 2] = c * 1.03; px[p + 3] = 255;
      height[i] = clamp(0.7 - tread * 0.6 - across * 0.1 + (grain[i] - 0.5) * 0.1, 0, 1);
    }
  }
  ctx.putImageData(img, 0, 0);

  /* Sidewall lettering, repeated around the circumference. */
  ctx.save();
  ctx.fillStyle = 'rgba(150,150,154,0.55)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const labels = ['NEON RADIAL', '245/40 ZR19', 'NEON RADIAL', 'TUBELESS'];
  for (let k = 0; k < 4; k++) {
    const yTop = S * 0.055;
    const yBot = S * 0.945;
    ctx.font = 'bold ' + Math.round(S * 0.032) + 'px ' + FONT_DISPLAY;
    ctx.fillText(labels[k], S * (k + 0.5) / 4, yTop);
    ctx.fillText(labels[(k + 2) % 4], S * (k + 0.5) / 4, yBot);
  }
  ctx.fillStyle = 'rgba(120,120,124,0.4)';
  for (let k = 0; k < 64; k++) {
    const xx = S * k / 64;
    ctx.fillRect(xx, S * 0.10, S * 0.008, S * 0.045);
    ctx.fillRect(xx, S * 0.845, S * 0.008, S * 0.045);
  }
  ctx.restore();
  const out = ctx.getImageData(0, 0, S, S);
  return { canvas: canvas, pixels: out.data, height: height };
}

/**
 * Chrome environment strip: a cheap fake reflection probe (sky above, city
 * silhouette at the horizon, dark ground below).
 * @param {number} S Texture size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray}} Result.
 */
function genChrome(S, seed) {
  const noise = new NoiseSource(seed);
  const clouds = fbmField(S, S, noise, { freqX: 5, freqY: 3, octaves: 4, gain: 0.55 });
  const skyline = fbmField(S, S, new NoiseSource(seed + 141), { freqX: 12, freqY: 1, octaves: 2 });
  const grime = fbmField(S, S, new NoiseSource(seed + 142), { freq: 20, octaves: 3 });
  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;
  for (let y = 0; y < S; y++) {
    const row = y * S;
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const i = row + x;
      let r, g, b;
      if (v < 0.5) {
        /* Sky: deep blue to pale horizon with clouds. */
        const t = smoothstep(0.0, 0.5, v);
        r = lerp(56, 176, t) + clouds[i] * 46;
        g = lerp(96, 198, t) + clouds[i] * 42;
        b = lerp(158, 216, t) + clouds[i] * 30;
      } else {
        /* Horizon band with building silhouettes, then dark ground. */
        const t = smoothstep(0.5, 1.0, v);
        const sil = 0.5 + skyline[i] * 0.5;
        const isBuilding = v < 0.5 + sil * 0.12 ? 1 : 0;
        r = lerp(150, 34, t); g = lerp(158, 32, t); b = lerp(164, 34, t);
        if (isBuilding) { r *= 0.45; g *= 0.46; b *= 0.52; }
      }
      const gm = (grime[i] - 0.5) * 14;
      const p = i * 4;
      px[p] = r + gm; px[p + 1] = g + gm; px[p + 2] = b + gm; px[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px };
}

/* ------------------------------------------------------------------------- *
 * 3b. Facades — RGB carries the wall, ALPHA carries the emissive window mask
 * ------------------------------------------------------------------------- */

/**
 * Writes an emissive mask into the alpha channel of an RGBA buffer.
 * Called *after* the opaque colour has been committed to the canvas, so
 * `canvases.*Facade` stays a fully visible image for UI use while the uploaded
 * pixel buffer carries the mask in alpha.
 * @param {Uint8ClampedArray} px RGBA pixels.
 * @param {Float32Array} mask Mask in 0..1.
 * @returns {void}
 */
function applyMask(px, mask) {
  for (let i = 0, p = 3; i < mask.length; i++, p += 4) px[p] = mask[i] * 255;
}

/**
 * Curtain-wall glass tower facade: 6 floors x 6 bays of full-height glazing
 * with aluminium mullions, spandrel panels and sky reflections.
 * @param {number} S Texture size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray}} Result.
 */
function genGlassFacade(S, seed) {
  const FLOORS = 6, COLS = 6;
  const rng = new Rand(seed ^ 0x9a11);
  const noise = new NoiseSource(seed);
  const panes = FLOORS * COLS;
  const paneTint = new Float32Array(panes);
  const paneDark = new Float32Array(panes);
  const paneRefl = new Float32Array(panes);
  for (let i = 0; i < panes; i++) {
    paneTint[i] = rng.range(-1, 1);
    paneDark[i] = rng.chance(0.22) ? rng.range(0.45, 0.75) : 1;
    paneRefl[i] = rng.range(0.6, 1.35);
  }
  const clouds = fbmField(S, S, noise, { freqX: 4, freqY: 6, octaves: 4, gain: 0.55 });
  const grime = fbmField(S, S, new NoiseSource(seed + 151), { freqX: 8, freqY: 30, octaves: 3 });
  const dust = fbmField(S, S, new NoiseSource(seed + 152), { freq: Math.max(48, S / 6), octaves: 2, value: true });

  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;
  const mask = new Float32Array(S * S);

  const mullionW = 0.030, centreW = 0.014, spandrelTop = 0.74, glassTop = 0.07;
  for (let y = 0; y < S; y++) {
    const row = y * S;
    const fy = y / S * FLOORS, fl = Math.floor(fy), ly = fy - fl;
    for (let x = 0; x < S; x++) {
      const i = row + x;
      const fx = x / S * COLS, cl = Math.floor(fx), lx = fx - cl;
      const id = fl * COLS + cl;

      const edgeX = Math.min(lx, 1 - lx);
      const inMullion = edgeX < mullionW || Math.abs(lx - 0.5) < centreW;
      const inSpandrel = ly >= spandrelTop;
      const inTransom = ly < glassTop;
      let r, g, b, m = 0;

      if (inSpandrel) {
        /* Opaque spandrel panel hiding the floor slab. */
        const t = smoothstep(spandrelTop, spandrelTop + 0.04, ly);
        const shade = 0.55 + t * 0.35 + (dust[i] - 0.5) * 0.12;
        r = 44 * shade + 8; g = 50 * shade + 9; b = 56 * shade + 11;
        if (ly > 0.965) { r *= 0.5; g *= 0.5; b *= 0.55; }
      } else if (inMullion || inTransom) {
        const shade = 0.8 + (dust[i] - 0.5) * 0.25 + (edgeX < 0.008 ? -0.25 : 0);
        r = 92 * shade; g = 98 * shade; b = 104 * shade;
      } else {
        /* Glass: sky gradient + cloud reflection + per-pane variation. */
        const t = clamp((ly - glassTop) / (spandrelTop - glassTop), 0, 1);
        const refl = Math.pow(1 - t, 1.5) * paneRefl[id];
        const cloud = clouds[i];
        const tint = paneTint[id];
        const skyR = 96 + cloud * 84 + tint * 10;
        const skyG = 140 + cloud * 78 + tint * 8;
        const skyB = 184 + cloud * 60 + tint * 6;
        const baseR = 16 + tint * 5, baseG = 33 + tint * 6, baseB = 41 + tint * 7;
        r = lerp(baseR, skyR, clamp(refl * 0.62, 0, 1));
        g = lerp(baseG, skyG, clamp(refl * 0.62, 0, 1));
        b = lerp(baseB, skyB, clamp(refl * 0.62, 0, 1));
        /* Diagonal glazing streak. */
        const streak = smoothstep(0.72, 1.0, Math.sin((lx * 1.6 + t * 2.2 + id * 0.31) * Math.PI));
        r += streak * 26; g += streak * 30; b += streak * 34;
        /* Some panes show a dark interior instead of a reflection. */
        const dk = paneDark[id];
        r *= dk; g *= dk; b *= dk;
        /* Rain streak grime running down the glass. */
        const gm = smoothstep(0.55, 0.95, grime[i]) * t * 0.35;
        r = lerp(r, r * 0.7 + 12, gm); g = lerp(g, g * 0.72 + 12, gm); b = lerp(b, b * 0.75 + 12, gm);
        m = 1;
      }
      const p = i * 4;
      px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = 255;
      mask[i] = m;
    }
  }
  ctx.putImageData(img, 0, 0);
  applyMask(px, mask);
  return { canvas: canvas, pixels: px };
}

/**
 * Office block facade: 4 floors x 4 punched windows in a precast concrete
 * frame, with sills, dirt runoff, mullions and randomly lowered blinds.
 * @param {number} S Texture size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray}} Result.
 */
function genOfficeFacade(S, seed) {
  const FLOORS = 4, COLS = 4;
  const rng = new Rand(seed ^ 0x3b77);
  const noise = new NoiseSource(seed);
  const cells = FLOORS * COLS;
  const blind = new Float32Array(cells);
  const tint = new Float32Array(cells);
  const dark = new Float32Array(cells);
  for (let i = 0; i < cells; i++) {
    blind[i] = rng.chance(0.45) ? rng.range(0.15, 0.62) : 0;
    tint[i] = rng.range(-1, 1);
    dark[i] = rng.range(0.75, 1.15);
  }
  const wallN = fbmField(S, S, noise, { freq: 6, octaves: 4, gain: 0.55 });
  const wallFine = fbmField(S, S, new NoiseSource(seed + 161), { freq: Math.max(64, S / 4), octaves: 2, value: true });
  const runoff = fbmField(S, S, new NoiseSource(seed + 162), { freqX: 22, freqY: 5, octaves: 3 });
  const clouds = fbmField(S, S, new NoiseSource(seed + 163), { freqX: 5, freqY: 7, octaves: 3 });

  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;
  const mask = new Float32Array(S * S);

  const WX0 = 0.17, WX1 = 0.83, WY0 = 0.20, WY1 = 0.74;
  const FRAME = 0.030;
  for (let y = 0; y < S; y++) {
    const row = y * S;
    const fy = y / S * FLOORS, fl = Math.floor(fy), ly = fy - fl;
    for (let x = 0; x < S; x++) {
      const i = row + x;
      const fx = x / S * COLS, cl = Math.floor(fx), lx = fx - cl;
      const id = fl * COLS + cl;
      let r, g, b, m = 0;

      const inWin = lx > WX0 && lx < WX1 && ly > WY0 && ly < WY1;
      const inFrame = inWin && (lx < WX0 + FRAME || lx > WX1 - FRAME || ly < WY0 + FRAME || ly > WY1 - FRAME
        || Math.abs(lx - 0.5) < 0.012 || Math.abs(ly - 0.42) < 0.010);

      if (!inWin) {
        /* Concrete wall with a pilaster rhythm and floor bands. */
        const pil = 1 - smoothstep(0.02, 0.10, Math.min(lx, 1 - lx));
        const band = 1 - smoothstep(0.0, 0.035, Math.min(ly, 1 - ly));
        let c = 148 + (wallN[i] - 0.5) * 30 + (wallFine[i] - 0.5) * 14;
        c += pil * 12 - band * 26;
        /* Dirt streaks running below the sills. */
        const sillShadow = (ly > WY1 && ly < WY1 + 0.22 && lx > WX0 - 0.02 && lx < WX1 + 0.02) ? 1 : 0;
        const dirt = sillShadow * smoothstep(0.35, 0.95, runoff[i]) * smoothstep(WY1 + 0.22, WY1, ly);
        c = lerp(c, c * 0.68, dirt * 0.8);
        /* Protruding sill catches light. */
        if (ly > WY1 && ly < WY1 + 0.035 && lx > WX0 - 0.03 && lx < WX1 + 0.03) c *= 1.16;
        r = c * 1.0; g = c * 0.985; b = c * 0.95;
      } else if (inFrame) {
        const c = 176 + (wallFine[i] - 0.5) * 18;
        r = c * 0.96; g = c * 0.98; b = c;
      } else {
        const t = clamp((ly - WY0) / (WY1 - WY0), 0, 1);
        const refl = Math.pow(1 - t, 1.7) * (0.7 + clouds[i] * 0.7);
        let gr = 22 + tint[id] * 5, gg = 34 + tint[id] * 6, gb = 46 + tint[id] * 8;
        gr = lerp(gr, 118 + clouds[i] * 70, clamp(refl * 0.55, 0, 1));
        gg = lerp(gg, 150 + clouds[i] * 60, clamp(refl * 0.55, 0, 1));
        gb = lerp(gb, 178 + clouds[i] * 50, clamp(refl * 0.55, 0, 1));
        gr *= dark[id]; gg *= dark[id]; gb *= dark[id];
        m = 1;
        /* Venetian blinds lowered from the top of the pane. */
        const bl = blind[id];
        if (bl > 0 && t < bl) {
          const slat = ((ly - WY0) * 90) % 1;
          const s = 0.72 + 0.28 * smoothstep(0.35, 0.65, slat);
          gr = 168 * s; gg = 160 * s; gb = 146 * s;
          m = 0;
        }
        r = gr; g = gg; b = gb;
      }
      const p = i * 4;
      px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = 255;
      mask[i] = m;
    }
  }
  ctx.putImageData(img, 0, 0);
  applyMask(px, mask);
  return { canvas: canvas, pixels: px };
}

/**
 * Apartment block facade: 4 floors x 3 bays of stucco with balconies,
 * railings, air-conditioner boxes and curtained windows.
 * @param {number} S Texture size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray}} Result.
 */
function genApartmentFacade(S, seed) {
  const FLOORS = 4, COLS = 3;
  const rng = new Rand(seed ^ 0x5c31);
  const noise = new NoiseSource(seed);
  const cells = FLOORS * COLS;
  const hasBalcony = new Uint8Array(cells);
  const hasAC = new Uint8Array(cells);
  const curtain = new Float32Array(cells);
  const tint = new Float32Array(cells);
  for (let i = 0; i < cells; i++) {
    hasBalcony[i] = rng.chance(0.66) ? 1 : 0;
    hasAC[i] = rng.chance(0.35) ? 1 : 0;
    curtain[i] = rng.chance(0.5) ? rng.range(0.2, 0.9) : 0;
    tint[i] = rng.range(-1, 1);
  }
  const stucco = fbmField(S, S, noise, { freq: 9, octaves: 4, gain: 0.55 });
  const fine = fbmField(S, S, new NoiseSource(seed + 171), { freq: Math.max(70, S / 4), octaves: 2, value: true });
  const streak = fbmField(S, S, new NoiseSource(seed + 172), { freqX: 26, freqY: 6, octaves: 3 });
  const sky = fbmField(S, S, new NoiseSource(seed + 173), { freqX: 4, freqY: 6, octaves: 3 });

  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;
  const mask = new Float32Array(S * S);

  const WX0 = 0.13, WX1 = 0.87, WY0 = 0.13, WY1 = 0.70;
  const RAIL_TOP = 0.44, RAIL_BOT = 0.74, SLAB_BOT = 0.82;
  for (let y = 0; y < S; y++) {
    const row = y * S;
    const fy = y / S * FLOORS, fl = Math.floor(fy), ly = fy - fl;
    for (let x = 0; x < S; x++) {
      const i = row + x;
      const fx = x / S * COLS, cl = Math.floor(fx), lx = fx - cl;
      const id = fl * COLS + cl;
      let r, g, b, m = 0;

      const inWin = lx > WX0 && lx < WX1 && ly > WY0 && ly < WY1;
      const frame = inWin && (lx < WX0 + 0.028 || lx > WX1 - 0.028 || ly < WY0 + 0.028 || ly > WY1 - 0.028
        || Math.abs(lx - 0.5) < 0.014);
      const acBox = hasAC[id] && lx > 0.62 && lx < 0.84 && ly > 0.20 && ly < 0.33;

      if (inWin && !frame && !acBox) {
        const t = clamp((ly - WY0) / (WY1 - WY0), 0, 1);
        const refl = Math.pow(1 - t, 1.6) * (0.6 + sky[i] * 0.8);
        let gr = 26 + tint[id] * 6, gg = 36 + tint[id] * 6, gb = 44 + tint[id] * 8;
        gr = lerp(gr, 112 + sky[i] * 66, clamp(refl * 0.5, 0, 1));
        gg = lerp(gg, 142 + sky[i] * 58, clamp(refl * 0.5, 0, 1));
        gb = lerp(gb, 170 + sky[i] * 48, clamp(refl * 0.5, 0, 1));
        m = 1;
        if (curtain[id] > 0 && lx < WX0 + (WX1 - WX0) * curtain[id]) {
          /* Fabric curtain: soft vertical folds, still lets light through. */
          const fold = 0.78 + 0.22 * Math.sin(lx * 90 + id);
          gr = 196 * fold; gg = 188 * fold; gb = 172 * fold;
          m = 0.55;
        }
        r = gr; g = gg; b = gb;
      } else if (acBox) {
        const sh = ly > 0.30 ? 0.7 : 1;
        const c = (128 + (fine[i] - 0.5) * 20) * sh;
        r = c; g = c * 1.01; b = c * 1.04;
      } else if (inWin) {
        const c = 208 + (fine[i] - 0.5) * 16;
        r = c; g = c * 0.99; b = c * 0.96;
      } else {
        /* Stucco wall + floor slab bands. */
        let c = 176 + (stucco[i] - 0.5) * 34 + (fine[i] - 0.5) * 14;
        const slab = 1 - smoothstep(0.0, 0.045, Math.min(ly, 1 - ly));
        c = lerp(c, 196, slab * 0.7);
        c -= smoothstep(0.5, 0.95, streak[i]) * 14 * (ly > 0.5 ? 1 : 0.3);
        r = c * 1.03; g = c * 0.98; b = c * 0.90;
      }

      /* Balcony railing and slab drawn over everything in this bay. */
      if (hasBalcony[id]) {
        if (ly > RAIL_TOP && ly < RAIL_BOT && lx > 0.04 && lx < 0.96) {
          const bar = ((lx - 0.04) * 26) % 1;
          const isBar = bar < 0.42 || ly < RAIL_TOP + 0.045;
          if (isBar) {
            const c = 96 + (fine[i] - 0.5) * 22;
            r = c * 0.95; g = c; b = c * 1.06;
            m = 0;
          } else if (m > 0) {
            /* Glass seen between the bars is slightly shaded by the balcony. */
            r *= 0.86; g *= 0.86; b *= 0.88;
          }
        }
        if (ly >= RAIL_BOT && ly < SLAB_BOT) {
          const t = (ly - RAIL_BOT) / (SLAB_BOT - RAIL_BOT);
          const c = (200 - t * 66) + (fine[i] - 0.5) * 14;
          r = c; g = c * 0.99; b = c * 0.96;
          m = 0;
        }
      }

      const p = i * 4;
      px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = 255;
      mask[i] = m;
    }
  }
  ctx.putImageData(img, 0, 0);
  applyMask(px, mask);
  return { canvas: canvas, pixels: px };
}

/**
 * Ground-floor shopfront strip used for the bottom floor of city blocks:
 * three units with glazing, doors, awnings and illuminated Korean signage.
 * The sign lettering and the shop interiors are marked emissive in alpha.
 * @param {number} S Texture size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray}} Result.
 */
function genGroundFloorShops(S, seed) {
  const SHOPS = 3;
  const rng = new Rand(seed ^ 0x7f42);
  const noise = new NoiseSource(seed);
  const signHue = [];
  const awning = [];
  for (let i = 0; i < SHOPS; i++) {
    signHue.push(rng.int(0, 359));
    awning.push(rng.chance(0.6) ? 1 : 0);
  }
  const wallN = fbmField(S, S, noise, { freq: 7, octaves: 4 });
  const fine = fbmField(S, S, new NoiseSource(seed + 181), { freq: Math.max(64, S / 4), octaves: 2, value: true });
  const interior = fbmField(S, S, new NoiseSource(seed + 182), { freq: 12, octaves: 3 });

  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;
  const mask = new Float32Array(S * S);

  const CORNICE = 0.06, SIGN0 = 0.06, SIGN1 = 0.26, GLASS0 = 0.32, GLASS1 = 0.88;
  for (let y = 0; y < S; y++) {
    const row = y * S;
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const i = row + x;
      const fx = x / S * SHOPS, sh = Math.floor(fx), lx = fx - sh;
      let r, g, b, m = 0;
      const pier = Math.min(lx, 1 - lx) < 0.045;

      if (v < CORNICE) {
        const c = 96 + (wallN[i] - 0.5) * 22 - (v < 0.012 ? 26 : 0);
        r = c * 1.0; g = c * 0.98; b = c * 0.95;
      } else if (v < SIGN1 && !pier) {
        /* Illuminated sign box: saturated panel, letters added later. */
        const hh = signHue[sh] / 360;
        const t = smoothstep(SIGN0, SIGN1, v);
        const l = 0.20 + (1 - t) * 0.10;
        const c = hslToRgbBytes(hh, 0.62, l);
        r = c[0] + (fine[i] - 0.5) * 10;
        g = c[1] + (fine[i] - 0.5) * 10;
        b = c[2] + (fine[i] - 0.5) * 10;
        if (v > SIGN1 - 0.014) { r *= 0.4; g *= 0.4; b *= 0.4; }
      } else if (v < GLASS0) {
        if (awning[sh] && !pier) {
          /* Striped awning valance. */
          const stripe = ((lx * 9) % 1) < 0.5 ? 1 : 0;
          const shade = 0.72 + smoothstep(GLASS0, SIGN1, v) * 0.4;
          r = (stripe ? 196 : 42) * shade;
          g = (stripe ? 190 : 52) * shade;
          b = (stripe ? 182 : 72) * shade;
        } else {
          const c = 118 + (wallN[i] - 0.5) * 20;
          r = c; g = c * 0.99; b = c * 0.97;
        }
      } else if (v < GLASS1 && !pier) {
        const door = lx > 0.70 && lx < 0.93;
        const mull = Math.abs(lx - 0.36) < 0.012 || Math.abs(lx - 0.68) < 0.014
          || (door && (Math.abs(lx - 0.70) < 0.012 || Math.abs(lx - 0.93) < 0.012))
          || v > GLASS1 - 0.02 || v < GLASS0 + 0.015;
        if (mull) {
          const c = 74 + (fine[i] - 0.5) * 16;
          r = c; g = c * 1.02; b = c * 1.05;
        } else {
          /* Shop interior seen through glass: warm, uneven, emissive. */
          const t = clamp((v - GLASS0) / (GLASS1 - GLASS0), 0, 1);
          const glow = 0.45 + interior[i] * 0.8;
          r = (150 + interior[i] * 90) * glow * (1.1 - t * 0.35);
          g = (128 + interior[i] * 78) * glow * (1.1 - t * 0.35);
          b = (96 + interior[i] * 60) * glow * (1.1 - t * 0.35);
          /* Reflection of the street on the lower glass. */
          const refl = smoothstep(0.35, 1.0, t) * 0.4;
          r = lerp(r, 60, refl); g = lerp(g, 72, refl); b = lerp(b, 88, refl);
          m = 1 - refl * 0.5;
          if (door) m *= 0.85;
        }
      } else if (pier) {
        const c = 132 + (wallN[i] - 0.5) * 26 + (fine[i] - 0.5) * 12;
        const shade = v > GLASS1 ? 0.7 : 1;
        r = c * shade; g = c * 0.99 * shade; b = c * 0.95 * shade;
      } else {
        /* Plinth below the glazing. */
        const c = 62 + (wallN[i] - 0.5) * 18 + (fine[i] - 0.5) * 10;
        r = c; g = c * 0.99; b = c * 0.98;
      }
      const p = i * 4;
      px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = 255;
      mask[i] = m;
    }
  }
  ctx.putImageData(img, 0, 0);

  /* Signage: draw opaque, then detect the painted texels and mark them emissive. */
  const before = ctx.getImageData(0, 0, S, S).data.slice();
  const names = ['라면 24H', 'MART 마트', '전당포'];
  const sub = ['NOODLE BAR', 'OPEN 24 HOURS', 'PAWN SHOP'];
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < SHOPS; i++) {
    const cx = S * (i + 0.5) / SHOPS;
    ctx.fillStyle = '#fdfdf4';
    ctx.font = 'bold ' + Math.round(S * 0.085) + 'px ' + FONT_KO;
    ctx.fillText(names[i], cx, S * 0.135);
    ctx.fillStyle = 'rgba(255,244,214,0.92)';
    ctx.font = 'bold ' + Math.round(S * 0.030) + 'px ' + FONT_DISPLAY;
    ctx.fillText(sub[i], cx, S * 0.216);
  }
  ctx.restore();
  const after = ctx.getImageData(0, 0, S, S);
  const outPx = after.data;
  for (let i = 0, p = 0; i < S * S; i++, p += 4) {
    const d = Math.abs(outPx[p] - before[p]) + Math.abs(outPx[p + 1] - before[p + 1]) + Math.abs(outPx[p + 2] - before[p + 2]);
    if (d > 24) mask[i] = 1;
  }
  applyMask(outPx, mask);
  return { canvas: canvas, pixels: outPx };
}

/**
 * Converts HSL to 8-bit RGB.
 * @param {number} h Hue 0..1.
 * @param {number} s Saturation 0..1.
 * @param {number} l Lightness 0..1.
 * @returns {number[]} `[r, g, b]` in 0..255.
 */
function hslToRgbBytes(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (h - Math.floor(h)) * 6;
  const xx = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = xx; } else if (hp < 2) { r = xx; g = c; } else if (hp < 3) { g = c; b = xx; } else if (hp < 4) { g = xx; b = c; } else if (hp < 5) { r = xx; b = c; } else { r = c; b = xx; }
  const m = l - c * 0.5;
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/* ------------------------------------------------------------------------- *
 * 3c. Signage: neon, billboards, graffiti
 * ------------------------------------------------------------------------- */

/**
 * Traces a rounded rectangle path.
 * @param {CanvasRenderingContext2D} ctx Context.
 * @param {number} x Left.
 * @param {number} y Top.
 * @param {number} w Width.
 * @param {number} h Height.
 * @param {number} r Corner radius.
 * @returns {void}
 */
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/**
 * Strokes the current path as a glowing neon tube (wide dim halo, bright core).
 * @param {CanvasRenderingContext2D} ctx Context.
 * @param {string} color Tube colour.
 * @param {number} width Core width in pixels.
 * @returns {void}
 */
function neonStroke(ctx, color, width) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.16;
  ctx.lineWidth = width * 4.5;
  ctx.stroke();
  ctx.globalAlpha = 0.30;
  ctx.lineWidth = width * 2.4;
  ctx.stroke();
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = width * 1.15;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#fffaff';
  ctx.lineWidth = Math.max(1, width * 0.42);
  ctx.stroke();
  ctx.restore();
}

/**
 * Draws glowing text (halo passes then a bright core).
 * @param {CanvasRenderingContext2D} ctx Context.
 * @param {string} text Text to draw.
 * @param {number} x Centre x.
 * @param {number} y Centre y.
 * @param {string} font CSS font.
 * @param {string} color Glow colour.
 * @param {string} core Core colour.
 * @returns {void}
 */
function glowText(ctx, text, x, y, font, color, core) {
  ctx.save();
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.18;
  ctx.lineWidth = 18;
  ctx.strokeText(text, x, y);
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 9;
  ctx.strokeText(text, x, y);
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 4;
  ctx.strokeText(text, x, y);
  ctx.globalAlpha = 1;
  ctx.fillStyle = core;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/**
 * Neon sign cards. Transparent background, saturated emissive artwork.
 * @param {number} index 1..3 design selector.
 * @param {number} S Texture size (width; height is S/2).
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray}} Result.
 */
function genNeonSign(index, S, seed) {
  const W = S, H = Math.round(S * 0.5);
  const canvas = createCanvas(W, H);
  const ctx = ctx2d(canvas);
  ctx.clearRect(0, 0, W, H);

  /* Dark backing panel so the tubes read against bright buildings. */
  ctx.fillStyle = 'rgba(7,6,14,0.88)';
  roundRectPath(ctx, W * 0.03, H * 0.06, W * 0.94, H * 0.88, H * 0.10);
  ctx.fill();

  if (index === 1) {
    roundRectPath(ctx, W * 0.07, H * 0.13, W * 0.86, H * 0.74, H * 0.09);
    neonStroke(ctx, '#00e5ff', 5);
    glowText(ctx, '네온', W * 0.5, H * 0.42, 'bold ' + Math.round(H * 0.38) + 'px ' + FONT_KO, '#ff2e88', '#ffe6f4');
    glowText(ctx, 'NEON CITY', W * 0.5, H * 0.74, 'bold ' + Math.round(H * 0.15) + 'px ' + FONT_DISPLAY, '#00e5ff', '#e8feff');
  } else if (index === 2) {
    /* Ramen bowl icon + text. */
    ctx.beginPath();
    ctx.arc(W * 0.22, H * 0.56, H * 0.20, 0, Math.PI);
    ctx.closePath();
    neonStroke(ctx, '#ffb648', 5);
    ctx.beginPath();
    ctx.moveTo(W * 0.09, H * 0.36);
    ctx.lineTo(W * 0.35, H * 0.36);
    neonStroke(ctx, '#ffb648', 4);
    for (let i = 0; i < 3; i++) {
      const sx = W * (0.16 + i * 0.06);
      ctx.beginPath();
      ctx.moveTo(sx, H * 0.30);
      ctx.quadraticCurveTo(sx + W * 0.03, H * 0.20, sx, H * 0.11);
      neonStroke(ctx, '#ff5a3c', 3);
    }
    glowText(ctx, '라면', W * 0.63, H * 0.36, 'bold ' + Math.round(H * 0.30) + 'px ' + FONT_KO, '#ff2e88', '#fff0f6');
    glowText(ctx, 'RAMEN 24H', W * 0.63, H * 0.72, 'bold ' + Math.round(H * 0.19) + 'px ' + FONT_DISPLAY, '#ffb648', '#fff6e2');
  } else {
    /* Pawn shop: three-ball emblem + Korean sign. */
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(W * (0.14 + i * 0.075), H * (i === 1 ? 0.30 : 0.42), H * 0.07, 0, TWO_PI);
      neonStroke(ctx, '#ffd34d', 4);
    }
    glowText(ctx, '전당포', W * 0.62, H * 0.38, 'bold ' + Math.round(H * 0.30) + 'px ' + FONT_KO, '#00e5ff', '#e9ffff');
    glowText(ctx, 'PAWN · 24', W * 0.62, H * 0.74, 'bold ' + Math.round(H * 0.17) + 'px ' + FONT_DISPLAY, '#ff2e88', '#ffe9f4');
  }

  /* Subtle panel grunge + a flicker-friendly vignette. */
  const noise = new NoiseSource(seed + index);
  const grime = fbmField(W, H, noise, { freq: 8, octaves: 3 });
  const img = ctx.getImageData(0, 0, W, H);
  const px = img.data;
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    if (px[p + 3] === 0) continue;
    const g = 0.88 + grime[i] * 0.24;
    px[p] *= g; px[p + 1] *= g; px[p + 2] *= g;
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px };
}

/**
 * Printed billboard artwork (opaque, 2:1).
 * @param {number} index 1..4 design selector.
 * @param {number} S Texture width (height is S/2).
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray}} Result.
 */
function genBillboard(index, S, seed) {
  const W = S, H = Math.round(S * 0.5);
  const canvas = createCanvas(W, H);
  const ctx = ctx2d(canvas);
  const rng = new Rand(seed ^ (index * 7919));

  if (index === 1) {
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#2b0b4a');
    grad.addColorStop(0.55, '#7a1170');
    grad.addColorStop(1, '#ff3d6e');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    /* Skyline silhouette. */
    ctx.fillStyle = 'rgba(10,6,22,0.92)';
    let x = 0;
    while (x < W) {
      const bw = W * rng.range(0.04, 0.10);
      const bh = H * rng.range(0.18, 0.52);
      ctx.fillRect(x, H - bh, bw - 2, bh);
      x += bw;
    }
    ctx.fillStyle = '#ffd34d';
    for (let i = 0; i < 60; i++) {
      ctx.fillRect(rng.next() * W, H - rng.next() * H * 0.45, W * 0.006, W * 0.008);
    }
    glowText(ctx, 'NEON CITY', W * 0.5, H * 0.34, 'bold ' + Math.round(H * 0.28) + 'px ' + FONT_DISPLAY, '#00e5ff', '#ffffff');
    ctx.fillStyle = '#ffe9f4';
    ctx.textAlign = 'center';
    ctx.font = 'bold ' + Math.round(H * 0.13) + 'px ' + FONT_KO;
    ctx.fillText('어서 오세요', W * 0.5, H * 0.62);
  } else if (index === 2) {
    ctx.fillStyle = '#12060a';
    ctx.fillRect(0, 0, W, H);
    const grad = ctx.createRadialGradient(W * 0.5, H * 0.5, H * 0.05, W * 0.5, H * 0.5, H * 0.9);
    grad.addColorStop(0, 'rgba(190,26,52,0.95)');
    grad.addColorStop(1, 'rgba(24,4,10,0.9)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    /* Card suits. */
    ctx.fillStyle = '#f7d774';
    for (let i = 0; i < 4; i++) {
      const cx = W * (0.10 + i * 0.06), cy = H * 0.82;
      ctx.beginPath();
      ctx.moveTo(cx, cy - H * 0.06);
      ctx.lineTo(cx + H * 0.045, cy);
      ctx.lineTo(cx, cy + H * 0.06);
      ctx.lineTo(cx - H * 0.045, cy);
      ctx.closePath();
      ctx.fill();
    }
    glowText(ctx, 'CASINO', W * 0.5, H * 0.34, 'bold ' + Math.round(H * 0.30) + 'px ' + FONT_DISPLAY, '#ffd34d', '#fff8e0');
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd34d';
    ctx.font = 'bold ' + Math.round(H * 0.17) + 'px ' + FONT_KO;
    ctx.fillText('카지노 · 잭팟', W * 0.5, H * 0.63);
  } else if (index === 3) {
    ctx.fillStyle = '#0d3a3f';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#0a2b2f';
    for (let i = 0; i < 14; i++) ctx.fillRect(0, H * i / 14, W, H / 28);
    /* Plate and fish. */
    ctx.beginPath();
    ctx.arc(W * 0.20, H * 0.52, H * 0.30, 0, TWO_PI);
    ctx.fillStyle = '#f3efe2';
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(W * 0.20, H * 0.50, H * 0.19, H * 0.10, -0.2, 0, TWO_PI);
    ctx.fillStyle = '#e8604c';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(W * 0.20 + H * 0.17, H * 0.50);
    ctx.lineTo(W * 0.20 + H * 0.30, H * 0.40);
    ctx.lineTo(W * 0.20 + H * 0.30, H * 0.60);
    ctx.closePath();
    ctx.fillStyle = '#e8604c';
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f6f1e0';
    ctx.font = 'bold ' + Math.round(H * 0.26) + 'px ' + FONT_KO;
    ctx.fillText('초밥', W * 0.64, H * 0.42);
    ctx.fillStyle = '#7fe3c8';
    ctx.font = 'bold ' + Math.round(H * 0.16) + 'px ' + FONT_DISPLAY;
    ctx.fillText('SUSHI BAR', W * 0.64, H * 0.70);
  } else {
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#f4e6c8');
    grad.addColorStop(1, '#d9b877');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(40,26,10,0.55)';
    ctx.lineWidth = Math.max(1, H * 0.012);
    for (let i = 0; i < 5; i++) {
      const yy = H * (0.24 + i * 0.075);
      ctx.beginPath();
      ctx.moveTo(W * 0.05, yy);
      ctx.lineTo(W * 0.42, yy);
      ctx.stroke();
    }
    /* A couple of quaver glyphs drawn as paths. */
    ctx.fillStyle = '#23180a';
    for (let i = 0; i < 3; i++) {
      const nx = W * (0.11 + i * 0.10), ny = H * (0.42 - i * 0.075);
      ctx.beginPath();
      ctx.ellipse(nx, ny, H * 0.045, H * 0.033, -0.4, 0, TWO_PI);
      ctx.fill();
      ctx.fillRect(nx + H * 0.036, ny - H * 0.24, H * 0.014, H * 0.24);
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = '#23180a';
    ctx.font = 'bold ' + Math.round(H * 0.22) + 'px ' + FONT_DISPLAY;
    ctx.fillText('CLASSIC FM', W * 0.66, H * 0.38);
    ctx.font = 'bold ' + Math.round(H * 0.20) + 'px ' + FONT_KO;
    ctx.fillText('클래식 88.7', W * 0.66, H * 0.66);
  }

  /* Print grain, paper wear and a vignette. */
  const noise = new NoiseSource(seed + index * 13);
  const wear = fbmField(W, H, noise, { freq: 6, octaves: 4 });
  const grain = fbmField(W, H, new NoiseSource(seed + index * 29), { freq: Math.max(60, W / 6), octaves: 2, value: true });
  const img = ctx.getImageData(0, 0, W, H);
  const px = img.data;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    const dy = (y / H - 0.5) * 2;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      const p = i * 4;
      const dx = (x / W - 0.5) * 2;
      const vig = 1 - smoothstep(0.75, 1.5, Math.sqrt(dx * dx + dy * dy)) * 0.45;
      const g = (0.9 + wear[i] * 0.2) * vig + (grain[i] - 0.5) * 0.08;
      px[p] *= g; px[p + 1] *= g; px[p + 2] *= g;
      px[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px };
}

/**
 * Spray-paint graffiti decal with drips and a stencil-rough alpha edge.
 * @param {number} index 1..2 design selector.
 * @param {number} S Texture width (height is S/2).
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray}} Result.
 */
function genGraffiti(index, S, seed) {
  const W = S, H = Math.round(S * 0.5);
  const canvas = createCanvas(W, H);
  const ctx = ctx2d(canvas);
  const rng = new Rand(seed ^ (index * 4111));
  ctx.clearRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  const main = index === 1 ? '#ff2e88' : '#8dff5a';
  const outline = index === 1 ? '#00e5ff' : '#ffd34d';
  const word = index === 1 ? '네온' : '자유';
  const tag = index === 1 ? 'CREW 96' : 'FREE!';

  /* Halo cloud of over-spray. */
  ctx.save();
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = main;
  for (let i = 0; i < 90; i++) {
    const x = W * (0.5 + rng.gaussian() * 0.16);
    const y = H * (0.5 + rng.gaussian() * 0.18);
    ctx.beginPath();
    ctx.arc(x, y, W * rng.range(0.01, 0.05), 0, TWO_PI);
    ctx.fill();
  }
  ctx.restore();

  ctx.font = 'bold ' + Math.round(H * 0.52) + 'px ' + FONT_KO;
  ctx.strokeStyle = outline;
  ctx.lineWidth = H * 0.10;
  ctx.strokeText(word, W * 0.42, H * 0.46);
  ctx.fillStyle = main;
  ctx.fillText(word, W * 0.42, H * 0.46);
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = H * 0.02;
  ctx.strokeText(word, W * 0.42, H * 0.46);

  ctx.font = 'bold ' + Math.round(H * 0.20) + 'px ' + FONT_DISPLAY;
  ctx.fillStyle = outline;
  ctx.save();
  ctx.translate(W * 0.80, H * 0.72);
  ctx.rotate(-0.18);
  ctx.fillText(tag, 0, 0);
  ctx.restore();

  /* Paint drips. */
  ctx.fillStyle = main;
  for (let i = 0; i < 12; i++) {
    const x = W * rng.range(0.14, 0.72);
    const y = H * rng.range(0.52, 0.66);
    const len = H * rng.range(0.06, 0.30);
    const wdt = W * rng.range(0.004, 0.011);
    ctx.fillRect(x, y, wdt, len);
    ctx.beginPath();
    ctx.arc(x + wdt * 0.5, y + len, wdt * 1.15, 0, TWO_PI);
    ctx.fill();
  }

  /* Spray speckle: erode the alpha with noise so edges look aerosol-blown. */
  const noise = new NoiseSource(seed + index * 17);
  const speck = fbmField(W, H, noise, { freq: Math.max(40, W / 8), octaves: 3, value: true });
  const blotch = fbmField(W, H, new NoiseSource(seed + index * 23), { freq: 7, octaves: 3 });
  const img = ctx.getImageData(0, 0, W, H);
  const px = img.data;
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    let a = px[p + 3] / 255;
    if (a === 0) continue;
    a *= 0.55 + 0.6 * speck[i];
    a *= 0.72 + 0.5 * blotch[i];
    px[p + 3] = clamp(a, 0, 1) * 255;
  }
  bleedAlpha(px, W, H, 3);
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px };
}

/* ------------------------------------------------------------------------- *
 * 3d. Particle sprites, decals and lookup textures
 * ------------------------------------------------------------------------- */

/**
 * Soft smoke puff: radial falloff broken up by fBm so plumes look turbulent.
 * @param {number} S Sprite size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray}} Result.
 */
function genSmoke(S, seed) {
  const noise = new NoiseSource(seed);
  const puff = fbmField(S, S, noise, { freq: 4, octaves: 4, gain: 0.55 });
  const detail = fbmField(S, S, new NoiseSource(seed + 1), { freq: 11, octaves: 3 });
  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;
  const c = (S - 1) * 0.5;
  for (let y = 0; y < S; y++) {
    const row = y * S;
    const dy = (y - c) / c;
    for (let x = 0; x < S; x++) {
      const i = row + x;
      const dx = (x - c) / c;
      const d = Math.sqrt(dx * dx + dy * dy);
      const shape = 1 - smoothstep(0.15, 1.0, d + (puff[i] - 0.5) * 0.55);
      const a = clamp(shape * (0.55 + detail[i] * 0.7), 0, 1);
      const lum = 176 + detail[i] * 60 + (1 - d) * 22;
      const p = i * 4;
      px[p] = lum; px[p + 1] = lum; px[p + 2] = lum * 1.02;
      px[p + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px };
}

/**
 * Hot spark streak (long on X, thin on Y) with a white core.
 * @param {number} S Sprite size.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray}} Result.
 */
function genSpark(S) {
  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;
  const c = (S - 1) * 0.5;
  for (let y = 0; y < S; y++) {
    const row = y * S;
    const dy = (y - c) / (S * 0.06);
    for (let x = 0; x < S; x++) {
      const dx = (x - c) / (S * 0.46);
      const d = Math.sqrt(dx * dx + dy * dy);
      const core = Math.exp(-d * d * 5.5);
      const tail = Math.exp(-Math.abs(dx) * 2.2) * Math.exp(-dy * dy * 1.6) * 0.55;
      const a = clamp(core + tail, 0, 1);
      const heat = clamp(core * 1.6, 0, 1);
      const p = (row + x) * 4;
      px[p] = 255;
      px[p + 1] = lerp(150, 246, heat);
      px[p + 2] = lerp(46, 210, heat * heat);
      px[p + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px };
}

/**
 * Omnidirectional light flash: hot core, soft halo and thin star spikes.
 * @param {number} S Sprite size.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray}} Result.
 */
function genFlash(S) {
  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;
  const c = (S - 1) * 0.5;
  for (let y = 0; y < S; y++) {
    const row = y * S;
    const dy = (y - c) / c;
    for (let x = 0; x < S; x++) {
      const dx = (x - c) / c;
      const d = Math.sqrt(dx * dx + dy * dy) + 1e-5;
      const ang = Math.atan2(dy, dx);
      const halo = Math.exp(-d * d * 6.5);
      const core = Math.exp(-d * d * 60);
      const spikes = Math.pow(Math.max(0, Math.cos(ang * 4)), 12) * Math.exp(-d * 3.4) * 0.55;
      const ring = Math.exp(-Math.pow((d - 0.42) * 7.5, 2)) * 0.18;
      const a = clamp(halo * 0.8 + core + spikes + ring, 0, 1);
      const p = (row + x) * 4;
      px[p] = 255;
      px[p + 1] = lerp(214, 255, clamp(core + spikes, 0, 1));
      px[p + 2] = lerp(150, 246, clamp(core * 1.4, 0, 1));
      px[p + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px };
}

/**
 * Blood splat: irregular core plus satellite droplets.
 * @param {number} S Sprite size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray}} Result.
 */
function genBlood(S, seed) {
  const rng = new Rand(seed ^ 0xb100d);
  const noise = new NoiseSource(seed + 2);
  const wobble = fbmField(S, S, noise, { freq: 5, octaves: 3 });
  const field = new Float32Array(S * S);
  splatBlob(field, S, S, S * 0.5, S * 0.5, S * 0.30, 1.0, wobble);
  for (let i = 0; i < 16; i++) {
    const ang = rng.next() * TWO_PI;
    const r = S * rng.range(0.18, 0.44);
    splatBlob(field, S, S, S * 0.5 + Math.cos(ang) * r, S * 0.5 + Math.sin(ang) * r,
      S * rng.range(0.015, 0.06), rng.range(0.6, 1.0), wobble);
  }
  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;
  for (let i = 0, p = 0; i < S * S; i++, p += 4) {
    const a = clamp(field[i] * 1.35 - 0.12, 0, 1);
    const thick = smoothstep(0.2, 0.9, field[i]);
    px[p] = lerp(78, 148, thick);
    px[p + 1] = lerp(6, 16, thick);
    px[p + 2] = lerp(8, 18, thick);
    px[p + 3] = (a > 0.06 ? a : 0) * 255;
  }
  bleedAlpha(px, S, S, 2);
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px };
}

/**
 * Broken glass shard with bright refracted edges.
 * @param {number} S Sprite size.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray}} Result.
 */
function genGlassShard(S) {
  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  ctx.clearRect(0, 0, S, S);
  ctx.beginPath();
  ctx.moveTo(S * 0.50, S * 0.06);
  ctx.lineTo(S * 0.86, S * 0.62);
  ctx.lineTo(S * 0.58, S * 0.94);
  ctx.lineTo(S * 0.16, S * 0.52);
  ctx.closePath();
  const grad = ctx.createLinearGradient(S * 0.2, 0, S * 0.9, S);
  grad.addColorStop(0, 'rgba(214,246,255,0.92)');
  grad.addColorStop(0.45, 'rgba(126,186,206,0.55)');
  grad.addColorStop(1, 'rgba(206,240,255,0.85)');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = 'rgba(246,255,255,0.95)';
  ctx.lineWidth = Math.max(1, S * 0.02);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(S * 0.50, S * 0.10);
  ctx.lineTo(S * 0.55, S * 0.86);
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = Math.max(1, S * 0.012);
  ctx.stroke();
  const img = ctx.getImageData(0, 0, S, S);
  bleedAlpha(img.data, S, S, 2);
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: img.data };
}

/**
 * Falling rain streak (tall, thin, soft ends).
 * @param {number} W Sprite width.
 * @param {number} H Sprite height.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray}} Result.
 */
function genRaindrop(W, H) {
  const canvas = createCanvas(W, H);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, W, H);
  const px = img.data;
  const cx = (W - 1) * 0.5;
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    const along = Math.sin(t * Math.PI);
    const widthAt = 0.30 + along * 0.55;
    for (let x = 0; x < W; x++) {
      const dx = Math.abs(x - cx) / (W * 0.5 * widthAt);
      const a = clamp((1 - smoothstep(0.35, 1.0, dx)) * Math.pow(along, 0.6), 0, 1);
      const p = (y * W + x) * 4;
      px[p] = 196; px[p + 1] = 216; px[p + 2] = 236;
      px[p + 3] = a * 235;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px };
}

/**
 * Muzzle flash: irregular star burst with a white-hot core and smoke wisps.
 * @param {number} S Sprite size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray}} Result.
 */
function genMuzzle(S, seed) {
  const noise = new NoiseSource(seed);
  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;
  const c = (S - 1) * 0.5;
  for (let y = 0; y < S; y++) {
    const row = y * S;
    const dy = (y - c) / c;
    for (let x = 0; x < S; x++) {
      const dx = (x - c) / c;
      const d = Math.sqrt(dx * dx + dy * dy) + 1e-5;
      const ang = Math.atan2(dy, dx);
      /* Petals: an angular noise ring so the flash is never symmetric. */
      const petal = 0.42 + 0.30 * Math.pow(Math.abs(Math.cos(ang * 3 + 0.7)), 1.6)
        + 0.16 * noise.perlin2(Math.cos(ang) * 3 + 8, Math.sin(ang) * 3 + 8, 64, 64);
      const body = 1 - smoothstep(petal * 0.55, petal, d);
      const core = Math.exp(-d * d * 44);
      const spike = Math.pow(Math.max(0, Math.cos(ang * 2)), 26) * Math.exp(-d * 2.2);
      const a = clamp(body * 0.9 + core + spike * 0.7, 0, 1);
      const heat = clamp(core * 1.5 + body * 0.5, 0, 1);
      const p = (row + x) * 4;
      px[p] = 255;
      px[p + 1] = lerp(176, 252, heat);
      px[p + 2] = lerp(64, 226, heat * heat);
      px[p + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px };
}

/**
 * Bullet impact decal: punched hole, dark rim, radial cracks and dust ring.
 * @param {number} S Decal size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray}} Result.
 */
function genBulletHole(S, seed) {
  const noise = new NoiseSource(seed);
  const dust = fbmField(S, S, noise, { freq: 7, octaves: 3 });
  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;
  const c = (S - 1) * 0.5;
  for (let y = 0; y < S; y++) {
    const row = y * S;
    const dy = (y - c) / c;
    for (let x = 0; x < S; x++) {
      const i = row + x;
      const dx = (x - c) / c;
      const d = Math.sqrt(dx * dx + dy * dy) + 1e-5;
      const ang = Math.atan2(dy, dx);
      const wob = 1 + 0.22 * noise.perlin2(Math.cos(ang) * 4 + 5, Math.sin(ang) * 4 + 5, 64, 64);
      const hole = 1 - smoothstep(0.10 * wob, 0.16 * wob, d);
      const rim = (1 - smoothstep(0.16 * wob, 0.30 * wob, d)) * (1 - hole);
      /* Radial cracks. */
      const cr = Math.pow(Math.abs(Math.sin(ang * 5.5 + dust[i] * 3.2)), 22) * (1 - smoothstep(0.16, 0.62, d));
      const ring = (1 - smoothstep(0.30, 0.86, d)) * (0.20 + dust[i] * 0.5);
      const a = clamp(hole + rim * 0.92 + cr * 0.8 + ring * 0.42, 0, 1);
      const lum = lerp(150, 8, clamp(hole + rim * 0.8 + cr * 0.6, 0, 1));
      const p = i * 4;
      px[p] = lum; px[p + 1] = lum * 0.98; px[p + 2] = lum * 0.95;
      px[p + 3] = a * 255;
    }
  }
  bleedAlpha(px, S, S, 2);
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px };
}

/**
 * Impact crack decal: a branching fracture network with a light rim so it
 * reads on both dark and bright surfaces.
 * @param {number} S Decal size.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray}} Result.
 */
function genCrackDecal(S, seed) {
  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const rng = new Rand(seed ^ 0xc4ac);
  ctx.clearRect(0, 0, S, S);
  ctx.strokeStyle = '#000000';
  ctx.lineCap = 'round';

  /**
   * Walks one crack branch outwards, spawning children.
   * @param {number} x Start x.
   * @param {number} y Start y.
   * @param {number} ang Start angle.
   * @param {number} len Remaining length.
   * @param {number} width Line width.
   * @param {number} depth Recursion depth.
   * @returns {void}
   */
  const branch = (x, y, ang, len, width, depth) => {
    let cx = x, cy = y, a = ang, remaining = len, w = width;
    while (remaining > 0) {
      const step = Math.min(remaining, S * rng.range(0.02, 0.06));
      a += rng.range(-0.45, 0.45);
      const nx = cx + Math.cos(a) * step;
      const ny = cy + Math.sin(a) * step;
      ctx.lineWidth = Math.max(0.6, w);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(nx, ny);
      ctx.stroke();
      cx = nx; cy = ny;
      remaining -= step;
      w *= 0.94;
      if (depth < 3 && rng.chance(0.18)) {
        branch(cx, cy, a + (rng.chance(0.5) ? 1 : -1) * rng.range(0.5, 1.1), remaining * rng.range(0.4, 0.8), w * 0.7, depth + 1);
      }
    }
  };

  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TWO_PI + rng.range(-0.3, 0.3);
    branch(S * 0.5, S * 0.5, a, S * rng.range(0.24, 0.46), S * 0.018, 0);
  }
  ctx.beginPath();
  ctx.arc(S * 0.5, S * 0.5, S * 0.045, 0, TWO_PI);
  ctx.fillStyle = 'rgba(0,0,0,0.9)';
  ctx.fill();

  /* Add a bright rim: dilate the drawn alpha and paint the halo lighter. */
  const img = ctx.getImageData(0, 0, S, S);
  const px = img.data;
  const alpha = new Float32Array(S * S);
  for (let i = 0, p = 3; i < S * S; i++, p += 4) alpha[i] = px[p] / 255;
  const spread = blurField(alpha, S, S, Math.max(1, Math.round(S * 0.012)));
  const noise = new NoiseSource(seed + 3);
  const grit = fbmField(S, S, noise, { freq: 12, octaves: 3 });
  for (let i = 0, p = 0; i < S * S; i++, p += 4) {
    const core = alpha[i];
    const halo = clamp(spread[i] * 2.4 - core, 0, 1) * (0.5 + grit[i] * 0.7);
    const a = clamp(core + halo * 0.55, 0, 1);
    const lum = lerp(190, 14, core);
    px[p] = lum; px[p + 1] = lum * 0.99; px[p + 2] = lum * 0.97;
    px[p + 3] = a * 255;
  }
  bleedAlpha(px, S, S, 2);
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px };
}

/**
 * Adds a Gaussian star into a brightness field (wrapped horizontally).
 * @param {Float32Array} field Target field.
 * @param {number} w Width.
 * @param {number} h Height.
 * @param {number} cx Centre x.
 * @param {number} cy Centre y.
 * @param {number} radius Radius in pixels.
 * @param {number} brightness Peak brightness.
 * @returns {void}
 */
function splatStar(field, w, h, cx, cy, radius, brightness) {
  const r = Math.ceil(radius * 3);
  const k = 1 / (radius * radius);
  for (let dy = -r; dy <= r; dy++) {
    const y = Math.round(cy) + dy;
    if (y < 0 || y >= h) continue;
    const row = y * w;
    for (let dx = -r; dx <= r; dx++) {
      let x = (Math.round(cx) + dx) % w; if (x < 0) x += w;
      const d2 = dx * dx + dy * dy;
      const v = brightness * Math.exp(-d2 * k);
      if (v < 0.002) continue;
      field[row + x] += v;
    }
  }
}

/**
 * Night sky star field with a faint milky band and a few bright stars.
 * @param {number} W Width (wraps in U).
 * @param {number} H Height.
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray}} Result.
 */
function genSkyStars(W, H, seed) {
  const rng = new Rand(seed ^ 0x57a45);
  const noise = new NoiseSource(seed);
  const cloud = fbmField(W, H, noise, { freqX: 6, freqY: 3, octaves: 5, gain: 0.6 });
  const dust = fbmField(W, H, new NoiseSource(seed + 1), { freqX: 14, freqY: 7, octaves: 3 });
  const bright = new Float32Array(W * H);
  const warm = new Float32Array(W * H);

  /* Milky band: a slanted, wrapping ridge of glowing dust. */
  for (let y = 0; y < H; y++) {
    const row = y * W;
    const v = y / H;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      const u = x / W;
      const band = Math.sin((u * 2 + 0.35) * TWO_PI) * 0.16 + 0.5;
      const d = Math.abs(v - band);
      const g = (1 - smoothstep(0.02, 0.26, d)) * (0.30 + cloud[i] * 0.85) * (0.4 + dust[i] * 0.9);
      bright[i] += g * 0.28;
    }
  }
  /* Field stars. */
  const faint = Math.round(W * H * 0.0022);
  for (let i = 0; i < faint; i++) {
    const x = rng.next() * W;
    const y = rng.next() * H;
    const band = Math.sin((x / W * 2 + 0.35) * TWO_PI) * 0.16 + 0.5;
    const near = 1 - smoothstep(0.02, 0.30, Math.abs(y / H - band));
    if (rng.next() > 0.35 + near * 0.6) continue;
    const b = rng.range(0.15, 0.75);
    splatStar(bright, W, H, x, y, rng.range(0.55, 1.1), b);
    if (rng.chance(0.3)) splatStar(warm, W, H, x, y, rng.range(0.6, 1.2), b * rng.range(0.3, 1.0));
  }
  /* Named bright stars with a cross flare. */
  for (let i = 0; i < 26; i++) {
    const x = rng.next() * W, y = rng.next() * H;
    const b = rng.range(1.1, 2.2);
    splatStar(bright, W, H, x, y, rng.range(1.6, 2.8), b);
    const arm = Math.round(W * 0.012);
    for (let k = -arm; k <= arm; k++) {
      const f = (1 - Math.abs(k) / arm) * b * 0.35;
      let xx = (Math.round(x) + k) % W; if (xx < 0) xx += W;
      const yy = Math.round(y);
      if (yy >= 0 && yy < H) bright[yy * W + xx] += f;
      const yk = yy + k;
      const xr = Math.round(x) % W;
      if (yk >= 0 && yk < H) bright[yk * W + xr] += f;
    }
    if (rng.chance(0.5)) splatStar(warm, W, H, x, y, rng.range(1.4, 2.4), b * 0.6);
  }

  const canvas = createCanvas(W, H);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, W, H);
  const px = img.data;
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const b = clamp(bright[i], 0, 1.6);
    const wm = clamp(warm[i], 0, 1);
    const r = clamp(b * 235 + wm * 40, 0, 255);
    const g = clamp(b * 238 - wm * 10, 0, 255);
    const bl = clamp(b * 255 - wm * 46 + 4, 0, 255);
    px[p] = r; px[p + 1] = g; px[p + 2] = bl;
    px[p + 3] = clamp(b * 1.25, 0, 1) * 255;
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px };
}

/**
 * Tileable blue-noise dither texture. R and G hold two independent blue-noise
 * masks, B holds R offset by half a period, A is opaque.
 * @param {number} S Size (64 recommended).
 * @param {number} seed Seed.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray}} Result.
 */
function genNoiseBlue(S, seed) {
  const a = blueNoiseField(S, S, seed);
  const b = blueNoiseField(S, S, seed + 977);
  const canvas = createCanvas(S, S);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, S, S);
  const px = img.data;
  for (let i = 0, p = 0; i < S * S; i++, p += 4) {
    px[p] = a[i] * 255;
    px[p + 1] = b[i] * 255;
    px[p + 2] = ((a[i] + 0.5) % 1) * 255;
    px[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px };
}

/**
 * Row centres (texture V coordinate, canvas space) of each ramp inside the
 * `gradientRamp` LUT texture. Sample with `texture2D(gradientRamp, vec2(t, v))`.
 * @type {{fog:number, fire:number, smoke:number, water:number,
 *         health:number, heat:number, neon:number, sunset:number}}
 */
export const GRADIENT_RAMP_ROWS = {
  fog: 0.0625,
  fire: 0.1875,
  smoke: 0.3125,
  water: 0.4375,
  health: 0.5625,
  heat: 0.6875,
  neon: 0.8125,
  sunset: 0.9375
};

/** Stop tables for {@link genGradientRamp}: `[t, r, g, b, a]`. */
const RAMP_STOPS = [
  [[0, 150, 170, 195, 0], [0.5, 176, 196, 216, 140], [1, 210, 224, 238, 255]],
  [[0, 0, 0, 0, 0], [0.14, 92, 12, 4, 190], [0.4, 234, 66, 12, 255], [0.7, 255, 168, 40, 255], [0.9, 255, 240, 182, 255], [1, 255, 255, 255, 255]],
  [[0, 16, 16, 18, 0], [0.3, 60, 60, 64, 160], [0.7, 132, 132, 138, 220], [1, 192, 192, 198, 255]],
  [[0, 10, 24, 36, 255], [0.5, 24, 86, 102, 255], [1, 124, 198, 190, 255]],
  [[0, 198, 26, 32, 255], [0.5, 242, 176, 40, 255], [1, 72, 208, 96, 255]],
  [[0, 40, 80, 200, 255], [0.4, 150, 40, 200, 255], [0.7, 240, 60, 90, 255], [1, 255, 220, 120, 255]],
  [[0, 0, 229, 255, 255], [0.5, 122, 80, 255, 255], [1, 255, 46, 136, 255]],
  [[0, 18, 20, 54, 255], [0.35, 86, 44, 110, 255], [0.7, 232, 110, 72, 255], [1, 255, 206, 140, 255]]
];

/**
 * Horizontal LUT ramps stacked vertically (fog, fire, smoke, water, health,
 * heat, neon, sunset). See {@link GRADIENT_RAMP_ROWS}.
 * @param {number} W Ramp resolution (256 recommended).
 * @param {number} H Total height; must be a multiple of the row count.
 * @returns {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels:Uint8ClampedArray}} Result.
 */
function genGradientRamp(W, H) {
  const rows = RAMP_STOPS.length;
  const rowH = H / rows;
  const canvas = createCanvas(W, H);
  const ctx = ctx2d(canvas);
  const img = newImage(ctx, W, H);
  const px = img.data;
  for (let r = 0; r < rows; r++) {
    const stops = RAMP_STOPS[r];
    for (let x = 0; x < W; x++) {
      const t = x / (W - 1);
      let s = 0;
      while (s < stops.length - 2 && t > stops[s + 1][0]) s++;
      const a = stops[s], b = stops[s + 1];
      const span = Math.max(1e-5, b[0] - a[0]);
      const f = clamp((t - a[0]) / span, 0, 1);
      const cr = lerp(a[1], b[1], f);
      const cg = lerp(a[2], b[2], f);
      const cb = lerp(a[3], b[3], f);
      const ca = lerp(a[4], b[4], f);
      for (let y = 0; y < rowH; y++) {
        const p = ((r * rowH + y) * W + x) * 4;
        px[p] = cr; px[p + 1] = cg; px[p + 2] = cb; px[p + 3] = ca;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: canvas, pixels: px };
}

/* ------------------------------------------------------------------------- *
 * 4. Library assembly
 * ------------------------------------------------------------------------- */

/**
 * High resolution timer with a Date fallback.
 * @returns {number} Milliseconds.
 */
function nowMs() {
  return (typeof performance !== 'undefined' && performance && performance.now) ? performance.now() : Date.now();
}

/**
 * Uploads a generated canvas as a GPU texture.
 * Textures whose alpha carries data (emissive masks, cut-outs, LUT alpha) are
 * uploaded from the raw pixel buffer instead of the canvas, because canvas
 * back-buffers store premultiplied colour and would destroy RGB wherever
 * alpha is zero.
 * @param {WebGL2RenderingContext} gl GL context.
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas Source canvas.
 * @param {Uint8ClampedArray|null} pixels Raw RGBA pixels (used when `opts.alphaMask`).
 * @param {{srgb?:boolean, wrap?:string, mipmaps?:boolean, filter?:string,
 *          anisotropy?:number, alphaMask?:boolean}} opts Upload options.
 * @returns {Texture2D} The uploaded texture.
 */
function makeTexture(gl, canvas, pixels, opts) {
  const srgb = opts.srgb !== false;
  const wrap = opts.wrap || 'repeat';
  const mipmaps = opts.mipmaps !== false;
  const filter = opts.filter || 'linear';
  const anisotropy = opts.anisotropy === undefined ? 8 : opts.anisotropy;
  if (opts.alphaMask && pixels) {
    try {
      return new Texture2D(gl, {
        width: canvas.width,
        height: canvas.height,
        data: pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length),
        wrap: wrap,
        filter: filter,
        mipmaps: mipmaps,
        anisotropy: anisotropy,
        srgb: srgb
      });
    } catch (err) {
      /* Fall back to the canvas path if the data path is unavailable. */
    }
  }
  return Texture2D.fromCanvas(gl, canvas, { srgb: srgb, mipmaps: mipmaps, wrap: wrap, anisotropy: anisotropy });
}

/**
 * Builds every texture the game needs. All generation is procedural,
 * deterministic for a given seed and runs entirely on the CPU into canvases.
 *
 * Colour maps are uploaded as sRGB; normal maps, masks and LUT ramps are
 * uploaded as linear data. Tiling maps get mipmaps and anisotropic filtering.
 *
 * Facade textures pack two channels of information: **RGB** is the wall,
 * frames and reflections, **ALPHA** is the emissive window mask (1 = window
 * glass) so the shader can light random windows at night.
 *
 * @param {WebGL2RenderingContext} gl GL context used to upload the textures.
 * @param {object} [opts] Options.
 * @param {number} [opts.size] Base resolution (default 512, 1024 on 'high', 256 on 'low').
 * @param {string} [opts.quality] 'low' | 'medium' | 'high' | 'ultra'.
 * @param {number} [opts.seed] Deterministic seed (default 1337).
 * @param {number} [opts.anisotropy] Anisotropic filtering level for tiling maps (default 8).
 * @returns {object} The texture library: one {@link Texture2D} per documented key plus
 *   `canvases` (raw canvases for the minimap / UI), `stats` `{count, bytes, ms}`
 *   and `dispose()`.
 */
export function buildTextureLibrary(gl, opts) {
  const o = opts || {};
  const t0 = nowMs();
  const quality = o.quality || 'medium';
  const S = Math.max(64, (o.size || QUALITY_SIZE[quality] || 512) | 0);
  const seed = o.seed === undefined ? 1337 : o.seed | 0;
  const aniso = o.anisotropy === undefined ? 8 : o.anisotropy;

  const P = Math.max(64, Math.round(S / 4));     // particle sprites
  const D = Math.max(128, Math.round(S / 2));    // decals
  const canvases = {};
  const textures = {};
  let bytes = 0;

  /**
   * Registers one generated canvas as a texture.
   * @param {string} name Library key.
   * @param {{canvas:(HTMLCanvasElement|OffscreenCanvas), pixels?:Uint8ClampedArray}} res Generator result.
   * @param {object} texOpts Upload options (see {@link makeTexture}).
   * @returns {void}
   */
  const add = (name, res, texOpts) => {
    canvases[name] = res.canvas;
    textures[name] = makeTexture(gl, res.canvas, res.pixels || null, texOpts);
    const area = res.canvas.width * res.canvas.height * 4;
    bytes += texOpts.mipmaps === false ? area : Math.round(area * 4 / 3);
  };

  /** Common option sets. */
  const TILE = { srgb: true, wrap: 'repeat', mipmaps: true, anisotropy: aniso };
  const TILE_MASK = { srgb: true, wrap: 'repeat', mipmaps: true, anisotropy: aniso, alphaMask: true };
  const NORMAL = { srgb: false, wrap: 'repeat', mipmaps: true, anisotropy: aniso };
  const CARD = { srgb: true, wrap: 'clamp', mipmaps: true, anisotropy: 1, alphaMask: true };
  const CARD_OPAQUE = { srgb: true, wrap: 'clamp', mipmaps: true, anisotropy: 1 };

  /* --- roads and ground ------------------------------------------------- */
  const asphalt = genAsphalt(S, seed);
  add('asphalt', asphalt, TILE);
  add('asphalt_n', { canvas: normalCanvasFromField(asphalt.height, S, S, 2.4) }, NORMAL);
  add('roadLines', genRoadLines(S, seed + 1), TILE_MASK);

  const sidewalk = genSidewalk(S, seed + 2);
  add('sidewalk', sidewalk, TILE);
  add('sidewalk_n', { canvas: normalCanvasFromField(sidewalk.height, S, S, 3.0) }, NORMAL);

  const concrete = genConcrete(S, seed + 3);
  add('concrete', concrete, TILE);
  add('concrete_n', { canvas: normalCanvasFromField(concrete.height, S, S, 2.0) }, NORMAL);

  const brick = genBrick(S, seed + 4);
  add('brick', brick, TILE);
  add('brick_n', { canvas: normalCanvasFromField(brick.height, S, S, 3.4) }, NORMAL);

  const metal = genMetal(S, seed + 5);
  add('metal', metal, TILE);
  add('metal_n', { canvas: normalCanvasFromField(metal.height, S, S, 2.6) }, NORMAL);

  add('roofGravel', genRoofGravel(S, seed + 6), TILE);
  add('tileFloor', genTileFloor(S, seed + 7), TILE);
  add('grass', genGrass(S, seed + 8), TILE);
  add('dirt', genDirt(S, seed + 9), TILE);
  add('sand', genSand(S, seed + 10), TILE);

  const water = genWater(S, seed + 11);
  add('water', water, TILE);
  add('waterNormal', { canvas: normalCanvasFromField(water.height, S, S, 3.2) }, NORMAL);

  /* --- vegetation and vehicles ------------------------------------------ */
  add('treeBark', genTreeBark(S, seed + 12), TILE);
  add('leaves', genLeaves(S, seed + 13), CARD);
  add('carPaintNoise', genCarPaintNoise(S, seed + 14), { srgb: false, wrap: 'repeat', mipmaps: true, anisotropy: aniso });
  add('tire', genTire(S, seed + 15), TILE);
  add('chrome', genChrome(Math.max(128, S >> 1), seed + 16), CARD_OPAQUE);

  /* --- facades (alpha = emissive window mask) --------------------------- */
  add('glassFacade', genGlassFacade(S, seed + 20), TILE_MASK);
  add('officeFacade', genOfficeFacade(S, seed + 21), TILE_MASK);
  add('apartmentFacade', genApartmentFacade(S, seed + 22), TILE_MASK);
  add('groundFloorShops', genGroundFloorShops(S, seed + 23), TILE_MASK);

  /* --- signage ---------------------------------------------------------- */
  for (let i = 1; i <= 3; i++) add('neonSign' + i, genNeonSign(i, S, seed + 30 + i), CARD);
  for (let i = 1; i <= 4; i++) add('billboard' + i, genBillboard(i, S, seed + 40 + i), CARD_OPAQUE);
  for (let i = 1; i <= 2; i++) add('graffiti' + i, genGraffiti(i, S, seed + 50 + i), CARD);

  /* --- particles -------------------------------------------------------- */
  add('smoke', genSmoke(P, seed + 60), CARD);
  add('spark', genSpark(P), CARD);
  add('flash', genFlash(P), CARD);
  add('blood', genBlood(P, seed + 61), CARD);
  add('glassShard', genGlassShard(P), CARD);
  add('raindrop', genRaindrop(Math.max(16, P >> 2), P), CARD);
  add('muzzle', genMuzzle(P, seed + 62), CARD);

  /* --- decals ----------------------------------------------------------- */
  add('decalBulletHole', genBulletHole(D, seed + 70), CARD);
  add('decalCrack', genCrackDecal(D, seed + 71), CARD);

  /* --- sky and lookup tables -------------------------------------------- */
  add('skyStars', genSkyStars(S * 2, S, seed + 80), {
    srgb: true, wrap: 'repeat', mipmaps: true, anisotropy: aniso, alphaMask: true
  });
  add('noiseBlue', genNoiseBlue(64, seed + 81), {
    srgb: false, wrap: 'repeat', mipmaps: false, filter: 'nearest', anisotropy: 1
  });
  add('gradientRamp', genGradientRamp(256, 64), {
    srgb: false, wrap: 'clamp', mipmaps: false, filter: 'linear', anisotropy: 1, alphaMask: true
  });

  const keys = Object.keys(textures);
  const library = textures;
  library.canvases = canvases;
  library.stats = { count: keys.length, bytes: bytes, ms: Math.round((nowMs() - t0) * 100) / 100 };
  library.size = S;
  library.seed = seed;
  /**
   * Releases every GPU texture in the library and drops the canvas references.
   * @returns {void}
   */
  library.dispose = () => {
    for (let i = 0; i < keys.length; i++) {
      const tex = library[keys[i]];
      if (tex && typeof tex.dispose === 'function') tex.dispose();
      library[keys[i]] = null;
    }
    for (const k in canvases) delete canvases[k];
  };
  return library;
}
