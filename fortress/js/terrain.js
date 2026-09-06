'use strict';
/* terrain.js — 높이맵 기반 파괴 가능 지형
 * 지형은 Float32Array(W). 각 인덱스 x 의 값이 그 지점의 지면 y (작을수록 위).
 */
const Terrain = (() => {
  /** mulberry32 시드 난수 */
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 지형 형태 프리셋 — 테마별로 실루엣이 달라집니다 */
  const STYLES = {
    rolling:  { waves: 3, amp: 0.13, noise: 0.075, smooth: 16, decay: 0.5, plateau: 1, spike: 0 },
    dunes:    { waves: 3, amp: 0.11, noise: 0.05, smooth: 26, decay: 0.46, plateau: 0, spike: 0 },
    jagged:   { waves: 5, amp: 0.15, noise: 0.13, smooth: 7, decay: 0.6, plateau: 1, spike: 0.4 },
    plateau:  { waves: 3, amp: 0.11, noise: 0.09, smooth: 13, decay: 0.55, plateau: 3, spike: 0 },
    volcanic: { waves: 4, amp: 0.16, noise: 0.11, smooth: 10, decay: 0.58, plateau: 1, spike: 0.28 },
    urban:    { waves: 2, amp: 0.08, noise: 0.06, smooth: 15, decay: 0.45, plateau: 4, spike: 0 },
  };

  function generate(w, h, seed, styleKey) {
    const S = STYLES[styleKey] || STYLES.rolling;
    const r = rng(seed);
    const g = new Float32Array(w);

    // 사인파 여러 겹
    const layers = [];
    for (let i = 0; i < S.waves; i++) {
      layers.push({
        f: ((0.6 + r() * 2.2) * (i + 1) * Math.PI * 2) / w,
        a: ((h * S.amp) / (i + 1)) * (0.6 + r() * 0.8),
        p: r() * Math.PI * 2,
      });
    }

    // 중점 변위 노이즈
    const N = 256;
    const md = new Float32Array(N + 1);
    let step = N, amp = h * S.noise;
    while (step > 1) {
      for (let i = step / 2; i < N; i += step) {
        md[i] = (md[i - step / 2] + md[i + step / 2]) / 2 + (r() * 2 - 1) * amp;
      }
      step /= 2; amp *= S.decay;
    }

    const base = h * 0.62;
    for (let x = 0; x < w; x++) {
      let y = base;
      for (const L of layers) y += Math.sin(x * L.f + L.p) * L.a;
      const t = (x / (w - 1)) * N;
      const i = Math.min(N - 1, Math.floor(t));
      const f = t - i;
      y += md[i] * (1 - f) + md[i + 1] * f;
      g[x] = y;
    }

    // 뾰족한 첨탑 (협곡/화산)
    for (let k = 0; k < Math.round(S.spike * 6); k++) {
      const cx = Math.floor(r() * w);
      const wid = 40 + r() * 90;
      const dep = h * (0.06 + r() * 0.12) * (r() < 0.5 ? -1 : 1);
      for (let x = Math.max(0, cx - wid); x < Math.min(w, cx + wid); x++) {
        const d = Math.abs(x - cx) / wid;
        g[x] += dep * Math.pow(1 - d, 2);
      }
    }

    smooth(g, S.smooth);

    // 평평한 대지 (도시/고원)
    for (let k = 0; k < S.plateau; k++) {
      const cx = Math.floor(r() * w);
      const wid = 90 + r() * 180;
      const x0 = Math.max(0, Math.round(cx - wid / 2));
      const x1 = Math.min(w - 1, Math.round(cx + wid / 2));
      let lvl = 0;
      for (let x = x0; x <= x1; x++) lvl += g[x];
      lvl /= Math.max(1, x1 - x0 + 1);
      for (let x = x0; x <= x1; x++) {
        const d = Math.min(x - x0, x1 - x) / 22;
        g[x] += (lvl - g[x]) * Math.min(1, d);
      }
    }

    const minY = h * 0.26, maxY = h * 0.9;
    for (let x = 0; x < w; x++) g[x] = Math.min(maxY, Math.max(minY, g[x]));
    return g;
  }

  function smooth(g, k) {
    if (k <= 0) return;
    const n = g.length;
    const c = Float32Array.from(g);
    let sum = 0;
    for (let i = 0; i <= k && i < n; i++) sum += c[i];
    let cnt = Math.min(k + 1, n);
    for (let x = 0; x < n; x++) {
      g[x] = sum / cnt;
      const add = x + k + 1, rem = x - k;
      if (add < n) { sum += c[add]; cnt++; }
      if (rem >= 0) { sum -= c[rem]; cnt--; }
    }
  }

  function heightAt(g, x) {
    const i = Math.max(0, Math.min(g.length - 1, Math.round(x)));
    return g[i];
  }

  /** 원형 크레이터. hLimit = 지면 최대 깊이(화면 아래 한계) */
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

  /** 수직 갱도 — 굴착탄 */
  function shaft(g, cx, halfWidth, depth, hLimit) {
    const x0 = Math.max(0, Math.floor(cx - halfWidth));
    const x1 = Math.min(g.length - 1, Math.ceil(cx + halfWidth));
    for (let x = x0; x <= x1; x++) {
      const d = Math.abs(x - cx) / halfWidth;
      const drop = depth * (1 - d * d);
      g[x] = Math.min(hLimit, g[x] + drop);
    }
  }

  /** 흙더미 생성 — 방어벽 */
  function mound(g, cx, halfWidth, height, minY) {
    const x0 = Math.max(0, Math.floor(cx - halfWidth));
    const x1 = Math.min(g.length - 1, Math.ceil(cx + halfWidth));
    for (let x = x0; x <= x1; x++) {
      const d = Math.abs(x - cx) / halfWidth;
      const rise = height * Math.pow(Math.cos((d * Math.PI) / 2), 1.4);
      g[x] = Math.max(minY, g[x] - rise);
    }
  }

  /** 넓고 얕게 무너뜨리기 — 지진탄 */
  function collapse(g, cx, rad, drop, hLimit) {
    const x0 = Math.max(0, Math.floor(cx - rad));
    const x1 = Math.min(g.length - 1, Math.ceil(cx + rad));
    for (let x = x0; x <= x1; x++) {
      const d = Math.abs(x - cx) / rad;
      g[x] = Math.min(hLimit, g[x] + drop * (1 - d * d));
    }
  }

  return { generate, heightAt, crater, shaft, mound, collapse, smooth, rng, STYLES };
})();
