'use strict';
/* terrain.js — 높이맵 기반 파괴 가능 지형 */
const Terrain = (() => {
  // mulberry32 시드 난수
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const THEMES = {
    grass:  { name: '초원', sky: ['#14213d', '#3d6fb8', '#a6d3f2'], ground: '#5a3b24', groundDark: '#30200f', top: '#4caf50', topLine: '#8fe08f', far: '#233457', sun: '#fff3b0' },
    desert: { name: '사막', sky: ['#2a1633', '#c9642f', '#f6c986'], ground: '#b57a3d', groundDark: '#6d4520', top: '#e9bd6b', topLine: '#f8dc98', far: '#5f2f2a', sun: '#ffd27d' },
    snow:   { name: '설원', sky: ['#0a1020', '#2f4f7f', '#c9dcef'], ground: '#5f6f80', groundDark: '#35414d', top: '#eef4f9', topLine: '#ffffff', far: '#25334a', sun: '#e8f1ff' },
  };

  function generate(w, h, seed) {
    const r = rng(seed);
    const g = new Float32Array(w);

    // 여러 겹의 사인파
    const layers = [];
    for (let i = 0; i < 5; i++) {
      layers.push({
        f: ((0.6 + r() * 2.2) * (i + 1) * Math.PI * 2) / w,
        a: ((h * 0.15) / (i + 1)) * (0.6 + r() * 0.8),
        p: r() * Math.PI * 2,
      });
    }
    // 중점 변위 노이즈
    const N = 256;
    const md = new Float32Array(N + 1);
    let step = N, amp = h * 0.13;
    while (step > 1) {
      for (let i = step / 2; i < N; i += step) {
        md[i] = (md[i - step / 2] + md[i + step / 2]) / 2 + (r() * 2 - 1) * amp;
      }
      step /= 2; amp *= 0.55;
    }

    const base = h * 0.6;
    for (let x = 0; x < w; x++) {
      let y = base;
      for (const L of layers) y += Math.sin(x * L.f + L.p) * L.a;
      const t = (x / (w - 1)) * N;
      const i = Math.min(N - 1, Math.floor(t));
      const f = t - i;
      y += md[i] * (1 - f) + md[i + 1] * f;
      g[x] = y;
    }
    smooth(g, 6);
    const minY = h * 0.3, maxY = h * 0.88;
    for (let x = 0; x < w; x++) g[x] = Math.min(maxY, Math.max(minY, g[x]));
    return g;
  }

  function smooth(g, k) {
    const n = g.length;
    const c = Float32Array.from(g);
    for (let x = 0; x < n; x++) {
      let s = 0, cnt = 0;
      for (let d = -k; d <= k; d++) {
        const i = x + d;
        if (i >= 0 && i < n) { s += c[i]; cnt++; }
      }
      g[x] = s / cnt;
    }
  }

  function heightAt(g, x) {
    const i = Math.max(0, Math.min(g.length - 1, Math.round(x)));
    return g[i];
  }

  /** (cx, cy) 중심 반지름 rad 원형 크레이터. hLimit = 지면 최대 깊이 */
  function crater(g, cx, cy, rad, hLimit) {
    const x0 = Math.max(0, Math.floor(cx - rad));
    const x1 = Math.min(g.length - 1, Math.ceil(cx + rad));
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const d = Math.sqrt(Math.max(0, rad * rad - dx * dx));
      const top = cy - d, bot = cy + d;
      if (g[x] > top - 2 && g[x] < bot) g[x] = Math.min(hLimit, bot);
    }
  }

  return { generate, heightAt, crater, THEMES, rng };
})();
