// ============================================================
//  세계 생성 — 대륙 · 지형 · 하천 · 도시 · 가도 · 주(州) · 세력
//  새 게임마다 완전히 다른 중원이 만들어진다.
// ============================================================
import { Perlin, clamp01, smoothstep, lerp } from './noise.js';
import { makeCityName, makeProvinceName, makeRealmName, NameRegistry } from './names.js';

export const TERRAIN = {
  DEEP:    { id: 0, name: '심해',   color: '#12283c', land: false, move: 99, def: 0 },
  SEA:     { id: 1, name: '바다',   color: '#1c3d59', land: false, move: 99, def: 0 },
  COAST:   { id: 2, name: '연안',   color: '#2b5a78', land: false, move: 99, def: 0 },
  MARSH:   { id: 3, name: '습지',   color: '#4a5f44', land: true,  move: 2.4, def: 10 },
  PLAIN:   { id: 4, name: '평원',   color: '#7a8a52', land: true,  move: 1.0, def: 0 },
  GRASS:   { id: 5, name: '초원',   color: '#8d9a58', land: true,  move: 1.0, def: 0 },
  FOREST:  { id: 6, name: '삼림',   color: '#4c6b3f', land: true,  move: 1.7, def: 20 },
  HILL:    { id: 7, name: '구릉',   color: '#8a7a4c', land: true,  move: 1.5, def: 15 },
  MOUNT:   { id: 8, name: '산악',   color: '#6e6152', land: true,  move: 2.8, def: 35 },
  PEAK:    { id: 9, name: '고봉',   color: '#8d8578', land: true,  move: 4.0, def: 45 },
  DESERT:  { id: 10, name: '사막',  color: '#b09b6a', land: true,  move: 1.9, def: 5 },
  SNOW:    { id: 11, name: '설원',  color: '#c3c8cc', land: true,  move: 2.2, def: 10 },
  RIVER:   { id: 12, name: '하천',  color: '#3a6f96', land: true,  move: 3.2, def: 5 },
  LAKE:    { id: 13, name: '호수',  color: '#27536f', land: false, move: 99, def: 0 },
};
export const TERRAIN_BY_ID = Object.fromEntries(Object.values(TERRAIN).map(t => [t.id, t]));

// 도시 유형
export const CITY_TYPES = [
  { id: 'capital',  name: '대도',   w: 0,  scale: 1.45, wall: 1.4 },
  { id: 'city',     name: '성',     w: 100, scale: 1.0, wall: 1.0 },
  { id: 'fortress', name: '관',     w: 40,  scale: 0.7, wall: 1.7 },
  { id: 'port',     name: '항',     w: 35,  scale: 0.95, wall: 0.85 },
  { id: 'frontier', name: '진',     w: 45,  scale: 0.75, wall: 0.9 },
];

/**
 * 세계를 생성한다.
 * @param {RNG} rng
 * @param {object} opt {cols, rows, cityCount, realmCount, seaLevel, year}
 */
export function generateWorld(rng, opt = {}) {
  const cols = opt.cols ?? 220;
  const rows = opt.rows ?? 150;
  const cellSize = 9;                       // 월드 좌표 단위
  const W = cols * cellSize, H = rows * cellSize;

  const registry = new NameRegistry();
  const p1 = new Perlin(rng), p2 = new Perlin(rng), p3 = new Perlin(rng), p4 = new Perlin(rng);

  // ── 1. 고도 ────────────────────────────────────────────────
  const elev = new Float32Array(cols * rows);
  const moist = new Float32Array(cols * rows);
  const temp = new Float32Array(cols * rows);

  // 대륙의 중심을 살짝 흔들어 매번 다른 모양으로
  const cx = 0.5 + (rng.next() - 0.5) * 0.10;
  const cy = 0.5 + (rng.next() - 0.5) * 0.10;
  const stretchX = 1.0 + (rng.next() - 0.5) * 0.35;
  const stretchY = 1.0 + (rng.next() - 0.5) * 0.35;
  const warp = 0.6 + rng.next() * 0.9;
  const freq = 2.2 + rng.next() * 1.4;
  const seaLevel = opt.seaLevel ?? (0.40 + rng.next() * 0.07);

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const nx = x / cols, ny = y / rows;
      // 도메인 워핑 — 해안선을 구불구불하게
      const wx = nx + warp * 0.08 * p3.fbm(nx * 3.1, ny * 3.1, 3);
      const wy = ny + warp * 0.08 * p4.fbm(nx * 3.1 + 5.2, ny * 3.1 + 1.3, 3);
      let e = p1.fbm(wx * freq, wy * freq, 6, 2.05, 0.52);
      // 산맥 능선을 얹는다
      const ridge = p2.ridged(wx * (freq * 1.35) + 11, wy * (freq * 1.35) + 7, 5);
      e = e * 0.68 + ridge * 0.42;
      // 대륙 falloff (타원)
      const dx = (nx - cx) / (0.52 * stretchX), dy = (ny - cy) / (0.50 * stretchY);
      const d = Math.sqrt(dx * dx + dy * dy);
      e -= smoothstep(0.62, 1.16, d) * 0.85;
      // 가장자리는 반드시 바다
      const edge = Math.min(nx, ny, 1 - nx, 1 - ny);
      e -= smoothstep(0.09, 0.0, edge) * 0.9;
      elev[y * cols + x] = clamp01(e);

      moist[y * cols + x] = clamp01(
        p3.fbm(wx * 2.6 + 31, wy * 2.6 + 17, 4) * 0.75 +
        (1 - Math.abs(ny - 0.55) * 1.4) * 0.30);
      // 북쪽이 춥고 남쪽이 덥다 (약간의 요동)
      temp[y * cols + x] = clamp01(
        0.12 + ny * 0.88 + (p4.fbm(nx * 3.4 + 61, ny * 3.4 + 41, 3) - 0.5) * 0.26
        - Math.max(0, elev[y * cols + x] - 0.42) * 0.95);
    }
  }

  // ── 2. 바다 판별 (지도 가장자리에서 홍수 채우기) ─────────
  //  내륙의 웅덩이는 호수, 가장자리와 이어진 물만 바다로 본다.
  const ocean = new Uint8Array(cols * rows);
  {
    const stack = [];
    for (let x = 0; x < cols; x++) { stack.push(x); stack.push((rows - 1) * cols + x); }
    for (let y = 0; y < rows; y++) { stack.push(y * cols); stack.push(y * cols + cols - 1); }
    while (stack.length) {
      const i = stack.pop();
      if (ocean[i] || elev[i] >= seaLevel) continue;
      ocean[i] = 1;
      const x = i % cols, y = (i / cols) | 0;
      if (x > 0) stack.push(i - 1);
      if (x < cols - 1) stack.push(i + 1);
      if (y > 0) stack.push(i - cols);
      if (y < rows - 1) stack.push(i + cols);
    }
  }

  // ── 3. 하천 — 웅덩이 메우기 + 유량 누적 ────────────────────
  //  (1) 우선순위 홍수로 내수면을 메워 모든 육지에서 바다까지
  //      내리막 경로가 존재하도록 만든다.
  const filled = new Float32Array(elev);
  {
    const EPS = 1e-5;
    // 이진 힙
    const heapV = [], heapI = [];
    const push = (v, i) => {
      heapV.push(v); heapI.push(i);
      let c = heapV.length - 1;
      while (c > 0) {
        const p2 = (c - 1) >> 1;
        if (heapV[p2] <= heapV[c]) break;
        [heapV[p2], heapV[c]] = [heapV[c], heapV[p2]];
        [heapI[p2], heapI[c]] = [heapI[c], heapI[p2]];
        c = p2;
      }
    };
    const pop = () => {
      const topV = heapV[0], topI = heapI[0];
      const lv = heapV.pop(), li = heapI.pop();
      if (heapV.length) {
        heapV[0] = lv; heapI[0] = li;
        let c = 0;
        for (;;) {
          const l = c * 2 + 1, r = l + 1;
          let m = c;
          if (l < heapV.length && heapV[l] < heapV[m]) m = l;
          if (r < heapV.length && heapV[r] < heapV[m]) m = r;
          if (m === c) break;
          [heapV[m], heapV[c]] = [heapV[c], heapV[m]];
          [heapI[m], heapI[c]] = [heapI[c], heapI[m]];
          c = m;
        }
      }
      return [topV, topI];
    };
    const closed = new Uint8Array(cols * rows);
    for (let i = 0; i < ocean.length; i++) {
      if (ocean[i]) { closed[i] = 1; push(filled[i], i); }
    }
    // 바다가 하나도 없는 극단적 경우 대비 — 가장자리를 시드로
    if (!heapV.length) {
      for (let x = 0; x < cols; x++) { closed[x] = 1; push(filled[x], x); }
    }
    while (heapV.length) {
      const [v, i] = pop();
      const x = i % cols, y = (i / cols) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
        const j = yy * cols + xx;
        if (closed[j]) continue;
        closed[j] = 1;
        if (filled[j] <= v) filled[j] = v + EPS;
        push(filled[j], j);
      }
    }
  }

  //  (2) 각 육지 셀의 물이 흘러갈 방향 = 가장 낮은 이웃
  const flowTo = new Int32Array(cols * rows).fill(-1);
  const orderIdx = [];
  for (let i = 0; i < filled.length; i++) if (!ocean[i]) orderIdx.push(i);
  for (const i of orderIdx) {
    const x = i % cols, y = (i / cols) | 0;
    let best = -1, bestV = filled[i];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
      const j = yy * cols + xx;
      const w = filled[j] - (dx && dy ? 1e-7 : 0);
      if (w < bestV) { bestV = w; best = j; }
    }
    flowTo[i] = best;
  }

  //  (3) 강수량을 상류에서 하류로 누적
  const flowAcc = new Float32Array(cols * rows);
  orderIdx.sort((a, b) => filled[b] - filled[a]);
  for (const i of orderIdx) {
    flowAcc[i] += 0.35 + moist[i] * 1.3;
    const j = flowTo[i];
    if (j >= 0) flowAcc[j] += flowAcc[i];
  }

  //  (4) 누적량이 임계치를 넘으면 하천
  const river = new Uint8Array(cols * rows);
  const riverThreshold = 42 + rng.next() * 30;
  for (let i = 0; i < flowAcc.length; i++) {
    if (!ocean[i] && elev[i] >= seaLevel && flowAcc[i] > riverThreshold) river[i] = 1;
  }
  // 하천 주변 습도 상승
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (!river[y * cols + x]) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
      const k = yy * cols + xx;
      moist[k] = Math.min(1, moist[k] + (dx === 0 && dy === 0 ? 0.28 : 0.09));
    }
  }
  // 렌더링용 하천 폴리라인 추출 (본류만)
  const riverPaths = [];
  {
    const isSource = new Uint8Array(cols * rows).fill(1);
    for (let i = 0; i < flowTo.length; i++) {
      if (river[i] && flowTo[i] >= 0 && river[flowTo[i]]) isSource[flowTo[i]] = 0;
    }
    for (let i = 0; i < river.length; i++) {
      if (!river[i] || !isSource[i]) continue;
      const path = [];
      let cur = i, guard = 0;
      while (cur >= 0 && guard++ < 4000) {
        path.push([cur % cols, (cur / cols) | 0, flowAcc[cur]]);
        if (ocean[cur]) break;
        cur = flowTo[cur];
      }
      if (path.length > 6) riverPaths.push(path);
    }
  }

  // ── 4. 지형 분류 (분위수 기반 — 지도마다 균형 잡힌 구성) ──
  const landIdx = [];
  for (let i = 0; i < elev.length; i++) if (!ocean[i] && elev[i] >= seaLevel) landIdx.push(i);
  const quant = (arr, q) => {
    if (!arr.length) return 0;
    const a = arr.slice().sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.max(0, Math.floor(q * a.length)))];
  };
  const landElev = landIdx.map(i => elev[i]);
  const landMoist = landIdx.map(i => moist[i]);
  const landTemp = landIdx.map(i => temp[i]);
  const eHill  = quant(landElev, 0.55 + rng.next() * 0.08);
  const eMount = quant(landElev, 0.80 + rng.next() * 0.06);
  const ePeak  = quant(landElev, 0.955);
  const mDry   = quant(landMoist, 0.16 + rng.next() * 0.08);
  const mGrass = quant(landMoist, 0.42 + rng.next() * 0.08);
  const mWood  = quant(landMoist, 0.74 + rng.next() * 0.06);
  const mSwamp = quant(landMoist, 0.93);
  const tCold  = quant(landTemp, 0.07 + rng.next() * 0.06);

  const tiles = new Uint8Array(cols * rows);
  for (let i = 0; i < tiles.length; i++) {
    const e = elev[i], m = moist[i], t = temp[i];
    if (e < seaLevel) {
      if (!ocean[i]) { tiles[i] = TERRAIN.LAKE.id; continue; }   // 내륙호
      tiles[i] = e < seaLevel - 0.10 ? TERRAIN.DEEP.id
        : e < seaLevel - 0.03 ? TERRAIN.SEA.id : TERRAIN.COAST.id;
      continue;
    }
    if (river[i]) { tiles[i] = TERRAIN.RIVER.id; continue; }
    if (e >= ePeak) { tiles[i] = TERRAIN.PEAK.id; continue; }
    if (e >= eMount) { tiles[i] = TERRAIN.MOUNT.id; continue; }
    if (t <= tCold) { tiles[i] = TERRAIN.SNOW.id; continue; }
    if (e >= eHill) { tiles[i] = TERRAIN.HILL.id; continue; }
    if (m <= mDry) { tiles[i] = t > 0.55 ? TERRAIN.DESERT.id : TERRAIN.GRASS.id; continue; }
    if (m >= mSwamp) { tiles[i] = TERRAIN.MARSH.id; continue; }
    if (m >= mWood) { tiles[i] = TERRAIN.FOREST.id; continue; }
    if (m >= mGrass) { tiles[i] = TERRAIN.PLAIN.id; continue; }
    tiles[i] = TERRAIN.GRASS.id;
  }

  // ── 5. 거주 적합도 ─────────────────────────────────────────
  const habit = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const i = y * cols + x;
    const t = tiles[i];
    if (!TERRAIN_BY_ID[t].land) { habit[i] = 0; continue; }
    let h = 0.25;
    if (t === TERRAIN.PLAIN.id) h = 1.0;
    else if (t === TERRAIN.GRASS.id) h = 0.82;
    else if (t === TERRAIN.FOREST.id) h = 0.60;
    else if (t === TERRAIN.HILL.id) h = 0.62;
    else if (t === TERRAIN.RIVER.id) h = 0.90;
    else if (t === TERRAIN.MARSH.id) h = 0.30;
    else if (t === TERRAIN.DESERT.id) h = 0.16;
    else if (t === TERRAIN.SNOW.id) h = 0.14;
    else if (t === TERRAIN.MOUNT.id) h = 0.22;
    else if (t === TERRAIN.PEAK.id) h = 0.05;
    // 물가 보너스
    let nearRiver = 0, nearSea = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
      const k = yy * cols + xx;
      if (river[k]) nearRiver = 1;
      if (ocean[k]) nearSea = 1;
    }
    h += nearRiver * 0.35 + nearSea * 0.22;
    habit[i] = h;
  }

  // ── 6. 도시 배치 (가중 포아송) ─────────────────────────────
  const cityCount = opt.cityCount ?? rng.range(30, 46);
  const minDist = Math.max(9, Math.floor(Math.sqrt((cols * rows) / (cityCount * 3.4))));
  const sites = [];
  const candidates = [];
  for (let y = 3; y < rows - 3; y++) for (let x = 3; x < cols - 3; x++) {
    const i = y * cols + x;
    if (habit[i] > 0.5) candidates.push({ x, y, h: habit[i] });
  }
  rng.shuffle(candidates);
  candidates.sort((a, b) => b.h - a.h + (rng.next() - 0.5) * 0.55);
  for (const c of candidates) {
    if (sites.length >= cityCount) break;
    let ok = true;
    for (const s of sites) {
      const dx = s.x - c.x, dy = s.y - c.y;
      if (dx * dx + dy * dy < minDist * minDist) { ok = false; break; }
    }
    if (ok) sites.push(c);
  }

  // ── 7. 도시 객체화 ─────────────────────────────────────────
  const cities = sites.map((s, idx) => {
    const i = s.y * cols + s.x;
    const t = tiles[i];
    let coastal = false, riverside = false, mountainous = false;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = s.x + dx, yy = s.y + dy;
      if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
      const k = yy * cols + xx;
      if (ocean[k]) coastal = true;
      if (river[k]) riverside = true;
      if (tiles[k] === TERRAIN.MOUNT.id || tiles[k] === TERRAIN.PEAK.id) mountainous = true;
    }
    let type = 'city';
    if (coastal && rng.percent(45)) type = 'port';
    else if (mountainous && rng.percent(55)) type = 'fortress';
    else if (habit[i] < 0.75 && rng.percent(45)) type = 'frontier';
    const tdef = CITY_TYPES.find(c => c.id === type);
    const nm = makeCityName(rng, registry);

    const fertility = clamp01(moist[i] * 0.7 + (1 - Math.abs(temp[i] - 0.55)) * 0.5);
    const scale = tdef.scale * (0.7 + habit[i] * 0.55) * rng.jitter(1, 0.22);

    const maxAgri = Math.round(lerp(200, 1100, fertility) * scale);
    const maxComm = Math.round(lerp(180, 1050, clamp01(habit[i] * 0.6 + (riverside ? 0.25 : 0) + (coastal ? 0.22 : 0))) * scale);
    const maxTech = Math.round(rng.range(150, 900) * scale);
    const maxFlood = Math.round(lerp(250, 950, riverside ? 0.85 : 0.35) * scale);
    const maxWall = Math.round(rng.range(2200, 7200) * tdef.wall * (0.8 + habit[i] * 0.4));

    return {
      id: 'c' + idx, name: nm.name, hanja: nm.hanja,
      gx: s.x, gy: s.y, x: s.x * cellSize, y: s.y * cellSize,
      type, typeName: tdef.name,
      terrain: t, coastal, riverside, mountainous,
      province: null, realm: null,
      links: [], seaLinks: [],
      // 내정 수치
      agri: 0, comm: 0, tech: 0, flood: 0, wall: 0,
      maxAgri, maxComm, maxTech, maxFlood, maxWall,
      pop: Math.round(lerp(30000, 240000, habit[i] / 1.6) * scale * rng.jitter(1, 0.25)),
      maxPop: 0,
      order: rng.range(45, 88),          // 치안
      loyalty: rng.range(45, 85),        // 민심
      gold: 0, food: 0, troops: 0, train: 0, morale: 0,
      officers: [], items: [],
      siege: null, buildings: [],
      famous: rng.percent(18),           // 명소가 있는 도시 — 탐색 성공률↑
      resource: null,
    };
  });
  for (const c of cities) {
    c.maxPop = Math.round(c.pop * rng.range(2, 4));
    c.agri = Math.round(c.maxAgri * rng.range(25, 60) / 100);
    c.comm = Math.round(c.maxComm * rng.range(25, 60) / 100);
    c.tech = Math.round(c.maxTech * rng.range(15, 45) / 100);
    c.flood = Math.round(c.maxFlood * rng.range(20, 55) / 100);
    c.wall = Math.round(c.maxWall * rng.range(45, 85) / 100);
    // 특산물
    if (rng.percent(35)) {
      c.resource = rng.pick([
        { id: 'horse', name: '명마 산지', desc: '기병 적성 +1, 명마 발견 확률 상승' },
        { id: 'iron',  name: '철산',     desc: '무기 아이템 발견율·기술 상승' },
        { id: 'salt',  name: '염전',     desc: '금 수입 +20%' },
        { id: 'silk',  name: '비단',     desc: '금 수입 +15%, 매력 관련 보물' },
        { id: 'rice',  name: '곡창',     desc: '병량 수입 +25%' },
        { id: 'timber',name: '목재',     desc: '병기·수군 건조 유리' },
        { id: 'jade',  name: '옥광',     desc: '보물 발견율 대폭 상승' },
        { id: 'herb',  name: '약초',     desc: '부상 회복·역병 저항' },
      ]);
    }
  }

  // ── 8. 가도(도로) 연결 ─────────────────────────────────────
  buildRoads(cities, rng, tiles, cols, rows, cellSize);

  // ── 9. 주(州) 분할 ─────────────────────────────────────────
  const provinces = makeProvinces(cities, rng, registry);

  return {
    cols, rows, cellSize, W, H, seaLevel,
    tiles, elev, moist, temp, river, riverPaths, habit, ocean, flowAcc, filled,
    cities, provinces, registry,
  };
}

// ------------------------------------------------------------------
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function buildRoads(cities, rng, tiles, cols, rows, cellSize) {
  const n = cities.length;
  const edges = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    edges.push({ i, j, d: dist(cities[i], cities[j]) });
  }
  edges.sort((a, b) => a.d - b.d);

  // 최소 신장 트리로 전역 연결 보장
  const parent = cities.map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const uni = (a, b) => { const ra = find(a), rb = find(b); if (ra === rb) return false; parent[ra] = rb; return true; };

  const chosen = [];
  for (const e of edges) { if (uni(e.i, e.j)) chosen.push(e); }

  // 상대 근접 그래프(RNG graph) 방식으로 자연스러운 가도 추가
  const maxLink = Math.max(cities.reduce((s, c) => s + 1, 0) * 0, 0);
  for (const e of edges) {
    if (chosen.includes(e)) continue;
    if (e.d > cellSize * 46) continue;
    // 두 도시보다 더 가까운 제3의 도시가 사이에 있으면 생략
    let blocked = false;
    for (let k = 0; k < n; k++) {
      if (k === e.i || k === e.j) continue;
      if (dist(cities[k], cities[e.i]) < e.d * 0.92 && dist(cities[k], cities[e.j]) < e.d * 0.92) { blocked = true; break; }
    }
    if (blocked) continue;
    if (cities[e.i].links.length >= 5 || cities[e.j].links.length >= 5) continue;
    chosen.push(e);
  }

  for (const e of chosen) {
    const A = cities[e.i], B = cities[e.j];
    if (A.links.some(l => l.to === B.id)) continue;
    // 경로가 바다를 크게 건너면 해로로 취급
    const samples = 24;
    let seaHits = 0, mountHits = 0;
    for (let s = 1; s < samples; s++) {
      const t = s / samples;
      const gx = Math.round(lerp(A.gx, B.gx, t)), gy = Math.round(lerp(A.gy, B.gy, t));
      const tt = tiles[gy * cols + gx];
      if (!TERRAIN_BY_ID[tt].land) seaHits++;
      if (tt === TERRAIN.MOUNT.id || tt === TERRAIN.PEAK.id) mountHits++;
    }
    const seaRatio = seaHits / samples;
    const days = Math.max(2, Math.round(e.d / cellSize / 3.2 * (1 + mountHits / samples * 1.6)));
    if (seaRatio > 0.30) {
      if (!A.coastal || !B.coastal) continue;
      A.seaLinks.push({ to: B.id, dist: e.d, days: Math.max(2, Math.round(days * 0.75)) });
      B.seaLinks.push({ to: A.id, dist: e.d, days: Math.max(2, Math.round(days * 0.75)) });
    } else {
      const kind = mountHits / samples > 0.35 ? 'mountain' : seaRatio > 0.08 ? 'river' : 'road';
      A.links.push({ to: B.id, dist: e.d, days, kind });
      B.links.push({ to: A.id, dist: e.d, days, kind });
    }
  }

  // 고립 도시 구제
  for (const c of cities) {
    if (c.links.length === 0 && c.seaLinks.length === 0) {
      let best = null, bd = Infinity;
      for (const o of cities) {
        if (o === c) continue;
        const d = dist(c, o);
        if (d < bd) { bd = d; best = o; }
      }
      if (best) {
        const days = Math.max(2, Math.round(bd / cellSize / 3.0));
        c.links.push({ to: best.id, dist: bd, days, kind: 'road' });
        best.links.push({ to: c.id, dist: bd, days, kind: 'road' });
      }
    }
  }
}

function makeProvinces(cities, rng, registry) {
  const k = Math.max(4, Math.round(cities.length / rng.range(4, 6)));
  // k-means++ 초기화
  const centers = [rng.pick(cities)];
  while (centers.length < k) {
    const w = cities.map(c => {
      let m = Infinity;
      for (const ce of centers) m = Math.min(m, dist(c, ce) ** 2);
      return { c, w: m };
    });
    const pick = rng.weighted(w, x => x.w);
    if (!pick || centers.includes(pick.c)) { centers.push(rng.pick(cities)); }
    else centers.push(pick.c);
  }
  let assign = new Array(cities.length).fill(0);
  let cs = centers.map(c => ({ x: c.x, y: c.y }));
  for (let iter = 0; iter < 24; iter++) {
    for (let i = 0; i < cities.length; i++) {
      let bi = 0, bd = Infinity;
      for (let j = 0; j < cs.length; j++) {
        const d = Math.hypot(cities[i].x - cs[j].x, cities[i].y - cs[j].y);
        if (d < bd) { bd = d; bi = j; }
      }
      assign[i] = bi;
    }
    const sum = cs.map(() => ({ x: 0, y: 0, n: 0 }));
    for (let i = 0; i < cities.length; i++) {
      sum[assign[i]].x += cities[i].x; sum[assign[i]].y += cities[i].y; sum[assign[i]].n++;
    }
    cs = sum.map((s, j) => s.n ? { x: s.x / s.n, y: s.y / s.n } : cs[j]);
  }
  const provinces = cs.map((c, j) => {
    const nm = makeProvinceName(rng, registry);
    return { id: 'p' + j, name: nm.name, hanja: nm.hanja, x: c.x, y: c.y, cities: [] };
  });
  for (let i = 0; i < cities.length; i++) {
    cities[i].province = provinces[assign[i]].id;
    provinces[assign[i]].cities.push(cities[i].id);
  }
  return provinces.filter(p => p.cities.length > 0);
}

/** 세력 이름 생성 헬퍼 재수출 */
export { makeRealmName };
