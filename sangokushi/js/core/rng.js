// ============================================================
//  난수 엔진 — 모든 무작위성의 근원
//  게임의 거의 모든 판정은 여기를 통과한다. 시드를 저장하면
//  세이브/로드 후에도 동일한 난수열이 재현된다.
// ============================================================

/** Mulberry32 — 32bit 시드 기반 PRNG */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RNG {
  constructor(seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0) {
    this.seed = seed >>> 0;
    this.calls = 0;
    this._f = mulberry32(this.seed);
  }

  /** 상태 직렬화 (세이브용) */
  serialize() { return { seed: this.seed, calls: this.calls }; }

  static deserialize(s) {
    const r = new RNG(s.seed);
    for (let i = 0; i < s.calls; i++) r.next();
    return r;
  }

  next() { this.calls++; return this._f(); }

  /** [0, n) 정수 */
  int(n) { return Math.floor(this.next() * n); }

  /** [min, max] 정수 (양끝 포함) */
  range(min, max) { return min + this.int(max - min + 1); }

  /** 확률 p(0~1)로 참 */
  chance(p) { return this.next() < p; }

  /** 확률 percent(0~100)로 참 */
  percent(p) { return this.next() * 100 < p; }

  pick(arr) { return arr[this.int(arr.length)]; }

  /** 배열에서 n개를 중복 없이 뽑는다 */
  sample(arr, n) {
    const copy = arr.slice();
    this.shuffle(copy);
    return copy.slice(0, Math.min(n, copy.length));
  }

  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** 가중치 선택 — items: [{w: number, ...}] 또는 (item)=>weight */
  weighted(items, weightFn = (it) => it.w ?? 1) {
    let total = 0;
    for (const it of items) total += Math.max(0, weightFn(it));
    if (total <= 0) return null;
    let r = this.next() * total;
    for (const it of items) {
      r -= Math.max(0, weightFn(it));
      if (r <= 0) return it;
    }
    return items[items.length - 1];
  }

  /** 평균 mid, 폭 spread 의 삼각분포 (중앙 집중) */
  around(mid, spread) {
    const t = (this.next() + this.next()) / 2; // 삼각분포
    return mid + (t * 2 - 1) * spread;
  }

  /** 정규분포 근사 (Box-Muller) */
  gauss(mean = 0, sd = 1) {
    const u = 1 - this.next(), v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** 값에 ±pct% 요동을 준다 */
  jitter(value, pct = 0.2) {
    return value * (1 + (this.next() * 2 - 1) * pct);
  }
}

/** 전역 난수 (UI 연출 등 세이브와 무관한 용도) */
export const fx = new RNG();
