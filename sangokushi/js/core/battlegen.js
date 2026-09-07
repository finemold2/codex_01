// ============================================================
//  전투 맵 절차 생성
//  대전략 지도의 지형·계절·도시 정보를 읽어
//  그때그때 새로운 전장을 만든다. 같은 성을 쳐도 매번 다르다.
// ============================================================
import { Perlin, clamp01 } from './noise.js';
import { TERRAIN, TERRAIN_BY_ID } from './worldgen.js';

// 전장 타일
export const BT = {
  PLAIN:  { id: 0,  name: '평지',   move: 1, def: 0,   atk: 0,   color: '#8a9457', block: false },
  GRASS:  { id: 1,  name: '초지',   move: 1, def: 3,   atk: 0,   color: '#7d8a4e', block: false },
  FOREST: { id: 2,  name: '숲',     move: 2, def: 18,  atk: -8,  color: '#47653c', block: false, hide: true },
  HILL:   { id: 3,  name: '언덕',   move: 2, def: 15,  atk: 10,  color: '#93814f', block: false, high: true },
  MOUNT:  { id: 4,  name: '산',     move: 3, def: 30,  atk: 15,  color: '#6d6152', block: false, high: true },
  CLIFF:  { id: 5,  name: '절벽',   move: 99, def: 0,  atk: 0,   color: '#4d453c', block: true },
  WATER:  { id: 6,  name: '강',     move: 99, def: 0,  atk: 0,   color: '#33607f', block: true, water: true },
  FORD:   { id: 7,  name: '여울',   move: 3, def: -12, atk: -10, color: '#4c7d96', block: false, water: true },
  MARSH:  { id: 8,  name: '늪',     move: 3, def: -6,  atk: -12, color: '#4f6047', block: false },
  ROAD:   { id: 9,  name: '길',     move: 0.7, def: -4, atk: 0,  color: '#a3946a', block: false },
  WALL:   { id: 10, name: '성벽',   move: 99, def: 55, atk: 0,   color: '#7e7466', block: true, wall: true },
  GATE:   { id: 11, name: '성문',   move: 1.5, def: 35, atk: 0,  color: '#8a6a3f', block: false, gate: true },
  INNER:  { id: 12, name: '성내',   move: 1, def: 20,  atk: 0,   color: '#9a8f74', block: false, inner: true },
  TOWER:  { id: 13, name: '망루',   move: 2, def: 40,  atk: 20,  color: '#8f8168', block: false, high: true },
  CAMP:   { id: 14, name: '진영',   move: 1, def: 12,  atk: 0,   color: '#95763f', block: false, camp: true },
  SAND:   { id: 15, name: '모래',   move: 1.6, def: -3, atk: -4, color: '#bda876', block: false },
  SNOW:   { id: 16, name: '설원',   move: 1.6, def: 0,  atk: -6, color: '#c6cbcf', block: false },
  BRIDGE: { id: 17, name: '다리',   move: 1, def: -8,  atk: 0,   color: '#9b8455', block: false },
  RUIN:   { id: 18, name: '폐허',   move: 1.4, def: 22, atk: 0,  color: '#7c7568', block: false, hide: true },
};
export const BT_BY_ID = Object.fromEntries(Object.values(BT).map(t => [t.id, t]));

export const WEATHERS = [
  { id: 'clear', name: '맑음',   fire: 1.0, arrow: 1.0, move: 1.0, morale: 0 },
  { id: 'cloud', name: '흐림',   fire: 0.9, arrow: 1.0, move: 1.0, morale: 0 },
  { id: 'rain',  name: '비',     fire: 0.25, arrow: 0.7, move: 0.8, morale: -3 },
  { id: 'storm', name: '폭풍우', fire: 0.05, arrow: 0.45, move: 0.65, morale: -8 },
  { id: 'wind',  name: '강풍',   fire: 1.8, arrow: 0.8, move: 1.0, morale: -2 },
  { id: 'fog',   name: '안개',   fire: 0.8, arrow: 0.5, move: 0.9, morale: -2, sight: 3 },
  { id: 'snow',  name: '눈',     fire: 0.4, arrow: 0.8, move: 0.7, morale: -6 },
  { id: 'heat',  name: '폭염',   fire: 1.4, arrow: 1.0, move: 0.85, morale: -5 },
];

/**
 * 전투 맵 생성
 * @param {RNG} rng
 * @param {object} opt { world, city, siege, month, W, H }
 */
export function generateBattlefield(rng, opt) {
  const W = opt.W ?? 26, H = opt.H ?? 20;
  const city = opt.city;
  const world = opt.world;
  const siege = !!opt.siege;
  const map = new Uint8Array(W * H);
  const p = new Perlin(rng), p2 = new Perlin(rng);
  const at = (x, y) => y * W + x;

  // ── 주변 지형 성향 조사 ──
  const around = { forest: 0, hill: 0, mount: 0, water: 0, marsh: 0, desert: 0, snow: 0, plain: 0 };
  if (world && city) {
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      const gx = city.gx + dx, gy = city.gy + dy;
      if (gx < 0 || gy < 0 || gx >= world.cols || gy >= world.rows) continue;
      const t = world.tiles[gy * world.cols + gx];
      if (t === TERRAIN.FOREST.id) around.forest++;
      else if (t === TERRAIN.HILL.id) around.hill++;
      else if (t === TERRAIN.MOUNT.id || t === TERRAIN.PEAK.id) around.mount++;
      else if (t === TERRAIN.RIVER.id || t === TERRAIN.LAKE.id) around.water++;
      else if (!TERRAIN_BY_ID[t].land) around.water += 0.6;
      else if (t === TERRAIN.MARSH.id) around.marsh++;
      else if (t === TERRAIN.DESERT.id) around.desert++;
      else if (t === TERRAIN.SNOW.id) around.snow++;
      else around.plain++;
    }
  }
  const total = Math.max(1, Object.values(around).reduce((a, b) => a + b, 0));
  const f = (k) => around[k] / total;

  // ── 기본 지형 채우기 ──
  const scale = 0.14 + rng.next() * 0.1;
  const baseTile = f('desert') > 0.25 ? BT.SAND.id : f('snow') > 0.25 ? BT.SNOW.id : BT.PLAIN.id;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const n = p.fbm(x * scale, y * scale, 4);
    const n2 = p2.fbm(x * scale * 1.9 + 17, y * scale * 1.9 + 5, 3);
    let t = baseTile;
    if (n > 0.70 - f('mount') * 0.22) t = BT.MOUNT.id;
    else if (n > 0.60 - f('hill') * 0.20) t = BT.HILL.id;
    else if (n2 > 0.66 - f('forest') * 0.24) t = BT.FOREST.id;
    else if (n2 < 0.30 + f('marsh') * 0.18 && f('marsh') > 0.06) t = BT.MARSH.id;
    else if (n < 0.42) t = BT.GRASS.id;
    map[at(x, y)] = t;
  }

  // ── 하천 ──
  const rivers = [];
  const riverCount = f('water') > 0.10 ? rng.range(1, 2) : (rng.percent(35) ? 1 : 0);
  for (let i = 0; i < riverCount; i++) {
    const vertical = rng.percent(50);
    let pos = vertical ? rng.range(4, W - 5) : rng.range(4, H - 5);
    const path = [];
    const len = vertical ? H : W;
    for (let k = 0; k < len; k++) {
      pos += rng.range(-1, 1);
      pos = Math.max(2, Math.min((vertical ? W : H) - 3, pos));
      const x = vertical ? pos : k, y = vertical ? k : pos;
      const width = rng.percent(30) ? 2 : 1;
      for (let w = 0; w < width; w++) {
        const xx = vertical ? Math.min(W - 1, x + w) : x;
        const yy = vertical ? y : Math.min(H - 1, y + w);
        map[at(xx, yy)] = BT.WATER.id;
        path.push([xx, yy]);
      }
    }
    rivers.push({ vertical, path });
    // 여울·다리
    const crossings = rng.range(1, 3);
    for (let cN = 0; cN < crossings; cN++) {
      const k = rng.range(2, len - 3);
      const isBridge = rng.percent(45);
      for (let w = -1; w <= 2; w++) {
        const x = vertical ? Math.max(0, Math.min(W - 1, pos + w)) : k;
        const y = vertical ? k : Math.max(0, Math.min(H - 1, pos + w));
        if (map[at(x, y)] === BT.WATER.id) map[at(x, y)] = isBridge ? BT.BRIDGE.id : BT.FORD.id;
      }
    }
  }

  // ── 절벽 (산악 전장) ──
  if (f('mount') > 0.22) {
    for (let i = 0; i < rng.range(3, 9); i++) {
      const cx = rng.range(1, W - 2), cy = rng.range(1, H - 2);
      const r = rng.range(1, 3);
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        if (dx * dx + dy * dy > r * r) continue;
        if (map[at(x, y)] === BT.MOUNT.id) map[at(x, y)] = BT.CLIFF.id;
      }
    }
  }

  // ── 성 (공성전) ──
  let castle = null;
  if (siege && city) {
    const cw = Math.max(6, Math.min(12, Math.round(4 + city.maxWall / 900)));
    const ch = Math.max(5, Math.min(10, Math.round(3 + city.maxWall / 1100)));
    const cx0 = W - cw - 1, cy0 = Math.floor((H - ch) / 2);
    for (let y = cy0; y < cy0 + ch; y++) for (let x = cx0; x < cx0 + cw; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const edge = (x === cx0 || x === cx0 + cw - 1 || y === cy0 || y === cy0 + ch - 1);
      map[at(x, y)] = edge ? BT.WALL.id : BT.INNER.id;
    }
    // 성문 — 서쪽 벽 가운데
    const gy = cy0 + Math.floor(ch / 2);
    map[at(cx0, gy)] = BT.GATE.id;
    if (ch > 6) map[at(cx0, gy + 1)] = BT.GATE.id;
    // 망루 — 모서리
    for (const [tx, ty] of [[cx0, cy0], [cx0 + cw - 1, cy0], [cx0, cy0 + ch - 1], [cx0 + cw - 1, cy0 + ch - 1]]) {
      if (tx >= 0 && ty >= 0 && tx < W && ty < H) map[at(tx, ty)] = BT.TOWER.id;
    }
    // 성 앞 길
    for (let x = 1; x < cx0; x++) map[at(x, gy)] = BT.ROAD.id;
    castle = { x0: cx0, y0: cy0, w: cw, h: ch, gate: [cx0, gy], hp: city.wall, maxHp: city.maxWall };
  } else {
    // 야전 — 가도가 전장을 가로지른다
    let ry = Math.floor(H / 2) + rng.range(-3, 3);
    for (let x = 0; x < W; x++) {
      ry += rng.range(-1, 1);
      ry = Math.max(1, Math.min(H - 2, ry));
      if (!BT_BY_ID[map[at(x, ry)]].block) map[at(x, ry)] = BT.ROAD.id;
    }
    // 진영
    if (rng.percent(55)) {
      const cx = rng.range(W - 8, W - 4), cy = rng.range(2, H - 4);
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < W && y < H && !BT_BY_ID[map[at(x, y)]].block) map[at(x, y)] = BT.CAMP.id;
      }
    }
    // 폐허
    for (let i = 0; i < rng.range(0, 4); i++) {
      const x = rng.range(1, W - 2), y = rng.range(1, H - 2);
      if (!BT_BY_ID[map[at(x, y)]].block) map[at(x, y)] = BT.RUIN.id;
    }
  }

  // ── 배치 구역 ──
  const attackerZone = [], defenderZone = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < 4; x++) if (!BT_BY_ID[map[at(x, y)]].block) attackerZone.push([x, y]);
    if (castle) {
      for (let y2 = castle.y0 + 1; y2 < castle.y0 + castle.h - 1; y2++)
        for (let x2 = castle.x0 + 1; x2 < castle.x0 + castle.w - 1; x2++)
          if (!BT_BY_ID[map[at(x2, y2)]].block) defenderZone.push([x2, y2]);
    } else {
      for (let x = W - 4; x < W; x++) if (!BT_BY_ID[map[at(x, y)]].block) defenderZone.push([x, y]);
    }
  }
  const dedupe = (arr) => {
    const s = new Set(); const out = [];
    for (const [x, y] of arr) { const k = x + ',' + y; if (!s.has(k)) { s.add(k); out.push([x, y]); } }
    return out;
  };

  // ── 날씨 ──
  const month = opt.month ?? 0;
  const weather = rng.weighted(WEATHERS, w => {
    let base = { clear: 34, cloud: 20, rain: 14, storm: 5, wind: 10, fog: 8, snow: 4, heat: 5 }[w.id];
    if ([10, 11, 0, 1].includes(month)) { if (w.id === 'snow') base *= 5; if (w.id === 'heat') base = 0; }
    if ([4, 5, 6, 7].includes(month)) { if (w.id === 'heat') base *= 4; if (w.id === 'rain') base *= 1.8; if (w.id === 'snow') base = 0; }
    return base;
  });

  const night = rng.percent(18);

  return {
    W, H, map, castle, weather, night, month,
    rivers,
    attackerZone: dedupe(attackerZone),
    defenderZone: dedupe(defenderZone),
    fires: new Float32Array(W * H),
    floods: new Float32Array(W * H),
    traps: [],
    name: siege ? `${city?.name ?? ''} 공방전` : `${city?.name ?? ''} 야전`,
  };
}

export function tileAt(bf, x, y) {
  if (x < 0 || y < 0 || x >= bf.W || y >= bf.H) return null;
  return BT_BY_ID[bf.map[y * bf.W + x]];
}
