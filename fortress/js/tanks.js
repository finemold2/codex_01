'use strict';
/* tanks.js — 전차 24종 성능 데이터
 * 그림은 tankart_set1/2/3.js 에서 TankArt.register(id, ...) 로 등록합니다.
 *
 * cls    경장(light) / 표준(std) / 중장(heavy) / 특수(special)
 * size   그리기 배율 + 피격 반경 배율
 * hp     최대 체력
 * armor  받는 피해 배율 (낮을수록 튼튼)
 * fuel   턴당 이동력 (px)
 * power  포구 초속 배율 (사거리)
 * barrel 포신 길이
 * climb  오를 수 있는 경사 (기본 1.7, 클수록 험지 주파)
 * traits 특성 태그 (UI 표시 + 일부 규칙)
 */

const TANK_CLASSES = {
  light:   { label: '경장',  color: '#5ce08a', desc: '빠르고 멀리 쏘지만 약합니다' },
  std:     { label: '표준',  color: '#4d8dff', desc: '모든 면에서 균형 잡혔습니다' },
  heavy:   { label: '중장',  color: '#ff7b3d', desc: '단단하고 강하지만 굼뜹니다' },
  special: { label: '특수',  color: '#d76bff', desc: '독특한 기동과 무장을 가집니다' },
};

const TANK_TYPES = [
  // ── set1 ─────────────────────────────────────────────────────────
  { id: 'saturn', name: '새턴', cls: 'std', size: 1.00, hp: 100, armor: 1.00, fuel: 150, power: 1.00, barrel: 27,
    weapons: ['shell', 'twin', 'cluster'], traits: [],
    desc: '균형 잡힌 정통파. 어떤 지형에서도 무난하게 싸웁니다.' },
  { id: 'cobra', name: '코브라', cls: 'light', size: 0.92, hp: 88, armor: 1.12, fuel: 190, power: 1.05, barrel: 30,
    weapons: ['shell', 'sniper', 'flak'], traits: [],
    desc: '낮게 웅크린 차체와 긴 포신. 정밀 사격에 강합니다.' },
  { id: 'titan', name: '타이탄', cls: 'heavy', size: 1.12, hp: 128, armor: 0.84, fuel: 105, power: 0.97, barrel: 24,
    weapons: ['shell', 'quake', 'nuke'], traits: [],
    desc: '움직이는 요새. 느리지만 한 방이 전장을 바꿉니다.' },
  { id: 'scorpion', name: '스콜피온', cls: 'special', size: 1.00, hp: 98, armor: 1.00, fuel: 145, power: 1.02, barrel: 26,
    weapons: ['shell', 'mirv', 'napalm'], traits: ['고각'],
    desc: '전갈 꼬리 포신으로 높은 포물선을 그립니다.', minElev: 20 },
  { id: 'falcon', name: '팔콘', cls: 'light', size: 0.90, hp: 84, armor: 1.15, fuel: 205, power: 1.06, barrel: 25,
    weapons: ['shell', 'hail', 'teleport'], traits: ['기동'],
    desc: '넓게 뿌리고 순식간에 빠져나갑니다.' },
  { id: 'goliath', name: '골리앗', cls: 'heavy', size: 1.14, hp: 132, armor: 0.82, fuel: 100, power: 0.96, barrel: 23,
    weapons: ['shell', 'roller', 'bunker'], traits: ['공병'],
    desc: '도저 블레이드로 밀어붙이고 방어벽을 세웁니다.' },
  { id: 'mastodon', name: '마스토돈', cls: 'heavy', size: 1.10, hp: 124, armor: 0.86, fuel: 110, power: 0.98, barrel: 25,
    weapons: ['shell', 'chain', 'drill'], traits: [],
    desc: '이중 포탑에서 쏟아지는 연쇄 포격.' },
  { id: 'banshee', name: '밴시', cls: 'special', size: 0.95, hp: 90, armor: 1.08, fuel: 200, power: 1.04, barrel: 24,
    weapons: ['shell', 'flak', 'teleport'], traits: ['부양'],
    desc: '지면에서 떠서 이동합니다. 급경사도 그대로 넘습니다.', climb: 4.5 },

  // ── set2 ─────────────────────────────────────────────────────────
  { id: 'harvester', name: '하베스터', cls: 'special', size: 1.06, hp: 112, armor: 0.92, fuel: 125, power: 0.99, barrel: 22,
    weapons: ['shell', 'drill', 'quake'], traits: ['굴착'],
    desc: '지형을 파헤쳐 적의 발밑을 무너뜨립니다.' },
  { id: 'rhino', name: '라이노', cls: 'heavy', size: 1.10, hp: 126, armor: 0.85, fuel: 115, power: 0.99, barrel: 22,
    weapons: ['shell', 'roller', 'chain'], traits: ['돌격'],
    desc: '두꺼운 전면 장갑으로 정면 돌파합니다.' },
  { id: 'zephyr', name: '제피르', cls: 'light', size: 0.88, hp: 82, armor: 1.18, fuel: 210, power: 1.08, barrel: 28,
    weapons: ['shell', 'hail', 'sniper'], traits: ['기동'],
    desc: '가장 빠르고 가장 멀리 쏩니다. 대신 가장 약합니다.' },
  { id: 'volcano', name: '볼케이노', cls: 'std', size: 1.02, hp: 104, armor: 0.98, fuel: 140, power: 1.00, barrel: 20,
    weapons: ['shell', 'napalm', 'cluster'], traits: ['고각'],
    desc: '위를 향한 박격포로 불을 쏟아붓습니다.', minElev: 25 },
  { id: 'glacier', name: '글레이셔', cls: 'std', size: 1.04, hp: 108, armor: 0.95, fuel: 135, power: 0.99, barrel: 26,
    weapons: ['shell', 'frost', 'bunker'], traits: ['공병'],
    desc: '적을 얼려 묶어두고 얼음벽을 세웁니다.' },
  { id: 'mirage', name: '미라주', cls: 'special', size: 0.94, hp: 92, armor: 1.06, fuel: 175, power: 1.05, barrel: 29,
    weapons: ['shell', 'sniper', 'teleport'], traits: ['은신'],
    desc: '평면 장갑으로 낮게 숨었다가 정확히 찌릅니다.' },
  { id: 'tempest', name: '템페스트', cls: 'std', size: 1.02, hp: 102, armor: 1.00, fuel: 145, power: 1.01, barrel: 24,
    weapons: ['shell', 'multi6', 'mirv'], traits: [],
    desc: '다연장 로켓으로 전선을 뒤덮습니다.' },
  { id: 'oberon', name: '오베론', cls: 'heavy', size: 1.12, hp: 130, armor: 0.84, fuel: 108, power: 0.97, barrel: 26,
    weapons: ['shell', 'mirv', 'nuke'], traits: [],
    desc: '왕관을 쓴 중포. 위엄만큼 무겁게 때립니다.' },

  // ── set3 ─────────────────────────────────────────────────────────
  { id: 'nova', name: '노바', cls: 'special', size: 1.00, hp: 96, armor: 1.02, fuel: 155, power: 1.06, barrel: 25,
    weapons: ['shell', 'flak', 'nuke'], traits: ['공중폭발'],
    desc: '에너지 코어가 정점에서 터집니다.' },
  { id: 'kraken', name: '크라켄', cls: 'special', size: 1.08, hp: 116, armor: 0.90, fuel: 130, power: 0.98, barrel: 24,
    weapons: ['shell', 'napalm', 'chain'], traits: [],
    desc: '다관절 팔에서 뻗어나오는 심해의 화력.' },
  { id: 'saber', name: '세이버', cls: 'light', size: 0.90, hp: 86, armor: 1.14, fuel: 195, power: 1.07, barrel: 32,
    weapons: ['shell', 'sniper', 'multi3'], traits: ['저격'],
    desc: '가장 긴 포신. 지평선 끝까지 노립니다.' },
  { id: 'ironbug', name: '아이언벅', cls: 'light', size: 0.92, hp: 88, armor: 1.10, fuel: 200, power: 1.03, barrel: 23,
    weapons: ['shell', 'cluster', 'teleport'], traits: ['등반'],
    desc: '여섯 다리로 절벽을 기어오릅니다.', climb: 3.6 },
  { id: 'warden', name: '워든', cls: 'heavy', size: 1.10, hp: 136, armor: 0.80, fuel: 95, power: 0.95, barrel: 22,
    weapons: ['shell', 'bunker', 'quake'], traits: ['방패', '공병'],
    desc: '전장에서 가장 단단한 방패. 버티면 이깁니다.' },
  { id: 'pegasus', name: '페가수스', cls: 'light', size: 0.94, hp: 90, armor: 1.10, fuel: 205, power: 1.05, barrel: 25,
    weapons: ['shell', 'hail', 'flak'], traits: ['기동'],
    desc: '펼친 날개로 전장을 가로지르는 지원 포격.' },
  { id: 'leviathan', name: '리바이어던', cls: 'heavy', size: 1.25, hp: 145, armor: 0.78, fuel: 85, power: 0.94, barrel: 30,
    weapons: ['shell', 'nuke', 'quake'], traits: ['거대'],
    desc: '3중 궤도의 초중량 함포. 느리지만 압도적입니다.' },
  { id: 'stinger', name: '스팅어', cls: 'light', size: 0.88, hp: 80, armor: 1.20, fuel: 210, power: 1.08, barrel: 21,
    weapons: ['shell', 'multi3', 'napalm'], traits: ['기동'],
    desc: '가장 작은 몸으로 가장 집요하게 찌릅니다.' },
];

const TANK_BY_ID = {};
for (const t of TANK_TYPES) {
  t.climb = t.climb || 1.7;
  t.minElev = t.minElev || 0;
  t.maxElev = t.maxElev || 90;
  TANK_BY_ID[t.id] = t;
}

function tankType(id) { return TANK_BY_ID[id] || TANK_TYPES[0]; }
