// ============================================================
//  절차적 지형용 노이즈 (시드 고정 Perlin/fBm)
// ============================================================

export class Perlin {
  constructor(rng) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) { const j = rng.int(i + 1); const t = p[i]; p[i] = p[j]; p[j] = t; }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }
  _fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  _grad(h, x, y) {
    switch (h & 7) {
      case 0: return  x + y; case 1: return -x + y; case 2: return  x - y; case 3: return -x - y;
      case 4: return  x;     case 5: return -x;     case 6: return  y;     default: return -y;
    }
  }
  /** [-1,1] */
  noise2(x, y) {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = this._fade(xf), v = this._fade(yf);
    const P = this.perm;
    const aa = P[P[X] + Y], ab = P[P[X] + Y + 1];
    const ba = P[P[X + 1] + Y], bb = P[P[X + 1] + Y + 1];
    const x1 = lerp(this._grad(aa, xf, yf), this._grad(ba, xf - 1, yf), u);
    const x2 = lerp(this._grad(ab, xf, yf - 1), this._grad(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v);
  }
  /** 다중 옥타브 — [0,1] */
  fbm(x, y, oct = 5, lac = 2.02, gain = 0.5) {
    let a = 1, f = 1, sum = 0, norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += a * this.noise2(x * f, y * f);
      norm += a; a *= gain; f *= lac;
    }
    return (sum / norm) * 0.5 + 0.5;
  }
  /** 능선 노이즈 — 산맥용 */
  ridged(x, y, oct = 5, lac = 2.05, gain = 0.5) {
    let a = 1, f = 1, sum = 0, norm = 0;
    for (let i = 0; i < oct; i++) {
      const n = 1 - Math.abs(this.noise2(x * f, y * f));
      sum += a * n * n; norm += a; a *= gain; f *= lac;
    }
    return sum / norm;
  }
}

export function lerp(a, b, t) { return a + (b - a) * t; }
export function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
export function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
