'use strict';
/* items.js — 아이템 정의 · 등급 · 성능 굴림 · 상점 재고
 *
 * 같은 아이템이라도 나올 때마다 성능이 다르게 굴려집니다.
 *   인스턴스 = { id, roll, price }
 *   roll 0.70 ~ 1.55 → 품질 등급(노후 / 표준 / 정밀 / 시제 / 걸작)과 수치·가격이 함께 변합니다.
 *
 * kind
 *   ammo    : 무기 탄약 지급 (획득 즉시)
 *   instant : 즉시 효과
 *   buff    : 이번 판 내내 지속되는 강화 (tank.buffs)
 *   active  : 전투 중 직접 사용 (Z X C V)
 */

const RARITY = {
  common: { label: '일반', color: '#8fa3bf', weight: 62, floor: 0 },
  rare: { label: '희귀', color: '#4d9dff', weight: 27, floor: 0.06 },
  epic: { label: '전설', color: '#c07bff', weight: 9, floor: 0.13 },
  legend: { label: '유물', color: '#ffb02e', weight: 2, floor: 0.2 },
};

const QUALITY = [
  { min: 1.40, label: '걸작', color: '#ffb02e' },
  { min: 1.24, label: '시제', color: '#c07bff' },
  { min: 1.09, label: '정밀', color: '#4d9dff' },
  { min: 0.93, label: '표준', color: '#9fb0c7' },
  { min: 0, label: '노후', color: '#6f7889' },
];

const ITEM_CATS = {
  ammo: '탄약', heal: '보급', offense: '공격', defense: '방어',
  mobility: '기동', tactic: '전술', support: '지원', eco: '경제',
};

const ITEMS = {};

function defItem(o) {
  o.rarity = o.rarity || 'common';
  o.kind = o.kind || 'instant';
  o.cat = o.cat || 'tactic';
  o.base = o.base != null ? o.base : 1;
  // 기본 굴림: 기준값 × roll (최소 1)
  if (!o.value) o.value = (roll) => Math.max(1, Math.round(o.base * roll));
  ITEMS[o.id] = o;
  return o;
}
function defActive(o) {
  o.kind = 'active';
  // usesFrom 이면 굴림값이 곧 사용 횟수
  if (!o.usesOf) o.usesOf = o.usesFrom ? (v) => v : () => (o.uses || 1);
  return defItem(o);
}

/* ══════════════ 1. 탄약 ══════════════ */
const AMMO_DEFS = [
  { w: 'nuke', n: 1, rarity: 'epic', price: 440 },
  { w: 'quake', n: 1, rarity: 'rare', price: 200 },
  { w: 'mirv', n: 2, rarity: 'rare', price: 225 },
  { w: 'cluster', n: 3, rarity: 'common', price: 130 },
  { w: 'napalm', n: 2, rarity: 'rare', price: 185 },
  { w: 'frost', n: 2, rarity: 'rare', price: 180 },
  { w: 'roller', n: 3, rarity: 'common', price: 125 },
  { w: 'drill', n: 3, rarity: 'common', price: 110 },
  { w: 'chain', n: 2, rarity: 'rare', price: 170 },
  { w: 'sniper', n: 3, rarity: 'common', price: 140 },
  { w: 'flak', n: 3, rarity: 'common', price: 135 },
  { w: 'hail', n: 2, rarity: 'common', price: 120 },
  { w: 'multi6', n: 3, rarity: 'common', price: 115 },
  { w: 'multi3', n: 4, rarity: 'common', price: 95 },
  { w: 'twin', n: 4, rarity: 'common', price: 100 },
  { w: 'bunker', n: 2, rarity: 'common', price: 95 },
  { w: 'teleport', n: 2, rarity: 'rare', price: 160 },
];

for (const a of AMMO_DEFS) {
  const w = WEAPONS[a.w];
  defItem({
    id: `ammo_${a.w}`, name: `${w.name} 상자`, icon: w.icon,
    kind: 'ammo', cat: 'ammo', rarity: a.rarity, price: a.price, base: a.n,
    weapon: a.w,
    label: (v) => `${w.name} ${v}발`,
    desc: (v) => `${w.name}을 ${v}발 보급받습니다. ${w.desc}`,
    apply(game, t, v) {
      if (t.ammo[a.w] == null) { t.weapons.push(a.w); t.ammo[a.w] = 0; }
      if (t.ammo[a.w] !== Infinity) t.ammo[a.w] += v;
      return `${w.name} +${v}`;
    },
  });
}

defItem({
  id: 'arsenal', name: '무기고 개방', icon: '🗃', kind: 'ammo', cat: 'ammo', rarity: 'epic', price: 400, base: 2,
  desc: (v) => `내 전차에 없던 무기 ${v}종을 무작위로 지급받습니다.`,
  apply(game, t, v) {
    const pool = Object.keys(WEAPONS).filter((id) => t.ammo[id] == null);
    const got = [];
    for (let i = 0; i < v && pool.length; i++) {
      const id = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
      t.weapons.push(id);
      t.ammo[id] = Math.max(2, WEAPONS[id].ammo === Infinity ? 3 : WEAPONS[id].ammo);
      got.push(WEAPONS[id].name);
    }
    return got.length ? `신규 무장: ${got.join(', ')}` : '지급할 무기 없음';
  },
});

defItem({
  id: 'reload', name: '긴급 재보급', icon: '📦', kind: 'instant', cat: 'ammo', rarity: 'rare', price: 190, base: 1,
  desc: (v) => `가진 모든 무기의 탄약이 ${v}발씩 늘어납니다.`,
  apply(game, t, v) {
    let n = 0;
    for (const id of t.weapons) if (t.ammo[id] !== Infinity) { t.ammo[id] += v; n++; }
    return `탄약 +${v} ×${n}`;
  },
});

/* ══════════════ 2. 보급 · 회복 ══════════════ */

defItem({
  id: 'repair', name: '수리 키트', icon: '🔧', cat: 'heal', rarity: 'common', price: 90, base: 35,
  desc: (v) => `체력을 ${v} 회복합니다.`,
  apply(game, t, v) { const b = t.hp; t.hp = Math.min(t.maxHp, t.hp + v); return `HP +${t.hp - b}`; },
});
defItem({
  id: 'repair_big', name: '정비반 호출', icon: '🛠', cat: 'heal', rarity: 'rare', price: 215, base: 70,
  desc: (v) => `체력을 ${v} 회복합니다.`,
  apply(game, t, v) { const b = t.hp; t.hp = Math.min(t.maxHp, t.hp + v); return `HP +${t.hp - b}`; },
});
defItem({
  id: 'overhaul', name: '완전 정비', icon: '✨', cat: 'heal', rarity: 'epic', price: 380, base: 100,
  value: (roll) => Math.min(100, Math.round(70 * roll)),
  desc: (v) => `체력을 ${v}% 회복합니다.`,
  apply(game, t, v) { const b = t.hp; t.hp = Math.min(t.maxHp, t.hp + Math.round(t.maxHp * v / 100)); return `HP +${t.hp - b}`; },
});
defItem({
  id: 'hull', name: '증설 차체', icon: '🧰', kind: 'buff', cat: 'heal', rarity: 'rare', price: 240, base: 30,
  desc: (v) => `최대 체력이 ${v} 늘고 그만큼 회복합니다.`,
  apply(game, t, v) { t.maxHp += v; t.hp += v; return `최대 HP +${v}`; },
});
defItem({
  id: 'nano', name: '나노 재생', icon: '💠', kind: 'buff', cat: 'heal', rarity: 'epic', price: 360, base: 9,
  desc: (v) => `매 턴 시작마다 체력을 ${v}씩 회복합니다.`,
  apply(game, t, v) { t.buffs.regen = (t.buffs.regen || 0) + v; return `자가 재생 +${v}/턴`; },
});
defItem({
  id: 'leech', name: '흡수 장치', icon: '🩸', kind: 'buff', cat: 'heal', rarity: 'epic', price: 380, base: 30,
  desc: (v) => `적에게 입힌 피해의 ${v}%만큼 체력을 회복합니다.`,
  apply(game, t, v) { t.buffs.leech = (t.buffs.leech || 0) + v / 100; return `흡혈 ${v}%`; },
});
defItem({
  id: 'phoenix', name: '불사조 회로', icon: '🔥', kind: 'buff', cat: 'heal', rarity: 'legend', price: 700, base: 45,
  desc: (v) => `파괴되는 순간 체력 ${v}로 한 번 부활합니다.`,
  apply(game, t, v) { t.buffs.phoenix = (t.buffs.phoenix || 0) + 1; t.buffs.phoenixHp = Math.max(t.buffs.phoenixHp || 0, v); return `부활 (HP ${v})`; },
});

/* ══════════════ 3. 공격 ══════════════ */

defItem({
  id: 'powder', name: '고성능 장약', icon: '🧨', kind: 'buff', cat: 'offense', rarity: 'common', price: 145, base: 14,
  desc: (v) => `포구 초속이 ${v}% 올라 사거리가 늘어납니다.`,
  apply(game, t, v) { t.buffs.power = (t.buffs.power || 1) * (1 + v / 100); return `사거리 +${v}%`; },
});
defItem({
  id: 'fuse', name: '증폭 신관', icon: '💥', kind: 'buff', cat: 'offense', rarity: 'rare', price: 230, base: 25,
  desc: (v) => `모든 폭발 반경이 ${v}% 커집니다.`,
  apply(game, t, v) { t.buffs.radius = (t.buffs.radius || 1) * (1 + v / 100); return `폭발 반경 +${v}%`; },
});
defItem({
  id: 'ap_core', name: '철갑 탄심', icon: '🔺', kind: 'buff', cat: 'offense', rarity: 'rare', price: 245, base: 20,
  desc: (v) => `주는 피해가 ${v}% 늘어납니다.`,
  apply(game, t, v) { t.buffs.damage = (t.buffs.damage || 1) * (1 + v / 100); return `피해 +${v}%`; },
});
defItem({
  id: 'warhead', name: '고폭 탄두', icon: '☄', kind: 'buff', cat: 'offense', rarity: 'epic', price: 410, base: 35,
  value: (roll) => ({ up: Math.round(35 * roll), down: Math.max(4, Math.round(16 / roll)) }),
  desc: (v) => `주는 피해가 ${v.up}% 늘지만 받는 피해도 ${v.down}% 늘어납니다.`,
  apply(game, t, v) {
    t.buffs.damage = (t.buffs.damage || 1) * (1 + v.up / 100);
    t.buffs.armor = (t.buffs.armor || 1) * (1 + v.down / 100);
    return `피해 +${v.up}% / 방어 −${v.down}%`;
  },
});
defItem({
  id: 'stabilizer', name: '풍향 보정기', icon: '🧭', kind: 'buff', cat: 'offense', rarity: 'rare', price: 220, base: 60,
  value: (roll) => Math.min(92, Math.round(55 * roll)),
  desc: (v) => `바람이 탄도에 주는 영향이 ${v}% 줄어듭니다.`,
  apply(game, t, v) { t.buffs.wind = Math.min(t.buffs.wind != null ? t.buffs.wind : 1, 1 - v / 100); return `바람 저항 ${v}%`; },
});
defItem({
  id: 'scope', name: '탄도 컴퓨터', icon: '🎯', kind: 'buff', cat: 'offense', rarity: 'epic', price: 400, base: 1,
  value: (roll) => Math.round(roll * 100) / 100,
  desc: () => '조준할 때 예상 탄착 궤적이 화면에 표시됩니다.',
  apply(game, t) { t.buffs.scope = true; return '탄도 예측'; },
});
defActive({
  id: 'pierce', name: '관통 탄심', icon: '🔻', cat: 'offense', rarity: 'rare', price: 230, base: 2, usesFrom: true,
  desc: (v) => `다음 사격이 지형을 한 겹 뚫고 지나갑니다. (${v}회)`,
  apply(game, t) { t.buffs.pierce = (t.buffs.pierce || 0) + 1; return '관통탄 장전'; },
});
defActive({
  id: 'bounce', name: '도탄 장치', icon: '🔄', cat: 'offense', rarity: 'common', price: 135, base: 2, usesFrom: true,
  desc: (v) => `다음 사격이 지면에 맞으면 한 번 튕겨 나갑니다. (${v}회)`,
  apply(game, t) { t.buffs.bounce = (t.buffs.bounce || 0) + 1; return '도탄 장전'; },
});
defActive({
  id: 'splitfuse', name: '분열 신관', icon: '✳', cat: 'offense', rarity: 'rare', price: 250, base: 2, usesFrom: true,
  desc: (v) => `다음 사격이 착탄 지점에서 세 번 연쇄 폭발합니다. (${v}회)`,
  apply(game, t) { t.buffs.splitFuse = (t.buffs.splitFuse || 0) + 1; return '분열 신관'; },
});
defActive({
  id: 'homing', name: '유도 장치', icon: '📶', cat: 'offense', rarity: 'epic', price: 420, base: 2, usesFrom: true,
  desc: (v) => `다음 사격이 비행 중 가장 가까운 적 쪽으로 휘어집니다. (${v}회)`,
  apply(game, t) { t.buffs.homing = (t.buffs.homing || 0) + 1; return '유도 장전'; },
});
defActive({
  id: 'overcharge', name: '과충전 회로', icon: '🔋', cat: 'offense', rarity: 'rare', price: 240, base: 2, usesFrom: true,
  desc: (v) => `다음 사격의 파워 상한이 135로 올라갑니다. (${v}회)`,
  apply(game, t) { t.buffs.overcharge = (t.buffs.overcharge || 0) + 1; return '과충전 (파워 135)'; },
});
defActive({
  id: 'double_tap', name: '속사 장전기', icon: '⏩', cat: 'offense', rarity: 'epic', price: 450, base: 1, usesFrom: true,
  desc: (v) => `이번 턴에 한 번 더 쏠 수 있습니다. (${v}회)`,
  apply(game, t) { t.buffs.extraShot = (t.buffs.extraShot || 0) + 1; return '추가 사격'; },
});
defActive({
  id: 'lowgrav', name: '중력 감쇄기', icon: '🌙', cat: 'offense', rarity: 'rare', price: 220, base: 2, usesFrom: true,
  desc: (v) => `다음 사격 동안 중력이 약해져 포탄이 아주 멀리 날아갑니다. (${v}회)`,
  apply(game, t) { t.buffs.lowGrav = (t.buffs.lowGrav || 0) + 1; return '저중력 사격'; },
});

/* ══════════════ 4. 방어 ══════════════ */

defItem({
  id: 'plating', name: '경사 장갑판', icon: '🔰', kind: 'buff', cat: 'defense', rarity: 'common', price: 125, base: 12,
  desc: (v) => `받는 피해가 ${v}% 줄어듭니다.`,
  apply(game, t, v) { t.buffs.armor = (t.buffs.armor || 1) * (1 - v / 100); return `피해 −${v}%`; },
});
defItem({
  id: 'armor', name: '증가 장갑', icon: '🛡', kind: 'buff', cat: 'defense', rarity: 'rare', price: 250, base: 25,
  value: (roll) => Math.min(48, Math.round(25 * roll)),
  desc: (v) => `받는 피해가 ${v}% 줄어듭니다.`,
  apply(game, t, v) { t.buffs.armor = (t.buffs.armor || 1) * (1 - v / 100); return `피해 −${v}%`; },
});
defItem({
  id: 'composite', name: '복합 장갑', icon: '⬛', kind: 'buff', cat: 'defense', rarity: 'epic', price: 430, base: 40,
  value: (roll) => Math.min(62, Math.round(40 * roll)),
  desc: (v) => `받는 피해가 ${v}% 줄어듭니다.`,
  apply(game, t, v) { t.buffs.armor = (t.buffs.armor || 1) * (1 - v / 100); return `피해 −${v}%`; },
});
defItem({
  id: 'reactive', name: '반응 장갑', icon: '🧱', kind: 'buff', cat: 'defense', rarity: 'rare', price: 200, base: 2,
  desc: (v) => `피격 ${v}회까지 그 피해를 절반으로 줄입니다.`,
  apply(game, t, v) { t.buffs.reactive = (t.buffs.reactive || 0) + v; return `반응 장갑 ×${v}`; },
});
defItem({
  id: 'thorns', name: '가시 도금', icon: '🌵', kind: 'buff', cat: 'defense', rarity: 'rare', price: 230, base: 30,
  desc: (v) => `받은 피해의 ${v}%를 공격자에게 되돌려 줍니다.`,
  apply(game, t, v) { t.buffs.thorns = (t.buffs.thorns || 0) + v / 100; return `피해 반사 ${v}%`; },
});
defItem({
  id: 'chute', name: '낙하산', icon: '🪂', kind: 'buff', cat: 'defense', rarity: 'common', price: 85, base: 1,
  desc: () => '떨어질 때 받는 낙하 피해가 사라집니다.',
  apply(game, t) { t.buffs.chute = true; return '낙하 피해 무효'; },
});
defActive({
  id: 'shield', name: '방어막', icon: '🔵', cat: 'defense', rarity: 'rare', price: 230, base: 2, usesFrom: true,
  desc: (v) => `다음에 받는 피해 1회를 완전히 막습니다. (${v}회)`,
  apply(game, t) { t.buffs.shield = (t.buffs.shield || 0) + 1; return '방어막 전개'; },
});
defActive({
  id: 'dodge', name: '회피 기동', icon: '💨', cat: 'defense', rarity: 'common', price: 145, base: 2, usesFrom: true,
  desc: (v) => `다음 공격 1회를 아예 빗나가게 만듭니다. (${v}회)`,
  apply(game, t) { t.buffs.dodge = (t.buffs.dodge || 0) + 1; return '회피 준비'; },
});
defActive({
  id: 'trench', name: '참호 삽', icon: '⛏', cat: 'defense', rarity: 'common', price: 105, base: 52, uses: 2,
  desc: (v) => `양옆에 높이 ${v}짜리 흙더미를 쌓아 몸을 숨깁니다.`,
  apply(game, t, v) {
    Terrain.mound(game.ground, clamp(t.x - 40, 10, W - 10), 26, v, H * 0.2);
    Terrain.mound(game.ground, clamp(t.x + 40, 10, W - 10), 26, v, H * 0.2);
    if (typeof Sfx !== 'undefined' && Sfx.collapse) Sfx.collapse();
    if (typeof FX !== 'undefined' && FX.dust) { FX.dust(t.x - 40, t.y, -1); FX.dust(t.x + 40, t.y, 1); }
    return '참호 구축';
  },
});
defActive({
  id: 'wall', name: '급조 방벽', icon: '🧊', cat: 'defense', rarity: 'common', price: 95, base: 92, uses: 2,
  desc: (v) => `바라보는 앞쪽에 높이 ${v}짜리 흙벽을 세웁니다.`,
  apply(game, t, v) {
    Terrain.mound(game.ground, clamp(t.x + t.facing * 62, 20, W - 20), 34, v, H * 0.18);
    if (typeof Sfx !== 'undefined' && Sfx.collapse) Sfx.collapse();
    return '방벽 설치';
  },
});
defActive({
  id: 'smoke', name: '연막탄', icon: '🌫', cat: 'defense', rarity: 'common', price: 115, base: 3, uses: 2,
  desc: (v) => `${v}턴 동안 나를 노리는 적의 명중률이 크게 떨어집니다.`,
  apply(game, t, v) { t.buffs.smoke = v; return `연막 ${v}턴`; },
});

/* ══════════════ 5. 기동 ══════════════ */

defItem({
  id: 'engine', name: '경량 엔진', icon: '⚙', kind: 'buff', cat: 'mobility', rarity: 'common', price: 115, base: 60,
  desc: (v) => `이동력이 ${v}% 늘어납니다.`,
  apply(game, t, v) {
    t.buffs.fuel = (t.buffs.fuel || 1) * (1 + v / 100);
    t.maxFuel = Math.round(t.type.fuel * t.buffs.fuel);
    t.fuel = t.maxFuel;
    return `이동력 +${v}%`;
  },
});
defItem({
  id: 'grapple', name: '등반 갈고리', icon: '🪝', kind: 'buff', cat: 'mobility', rarity: 'rare', price: 190, base: 45,
  value: (roll) => Math.round(45 * roll) / 10,
  desc: (v) => `경사 ${v}까지 오를 수 있게 됩니다. (기본 1.7)`,
  apply(game, t, v) { t.buffs.climb = Math.max(t.buffs.climb || 0, v); return `험지 주파 ${v}`; },
});
defItem({
  id: 'anchor', name: '고정 앵커', icon: '⚓', kind: 'buff', cat: 'mobility', rarity: 'common', price: 105, base: 1,
  desc: () => '낙하 피해를 받지 않고 폭풍에도 밀리지 않습니다.',
  apply(game, t) { t.buffs.chute = true; t.buffs.anchor = true; return '고정'; },
});
defActive({
  id: 'refuel', name: '예비 연료', icon: '⛽', cat: 'mobility', rarity: 'common', price: 85, base: 2, usesFrom: true,
  desc: (v) => `이번 턴 이동력을 가득 채웁니다. (${v}회)`,
  apply(game, t) { t.fuel = t.maxFuel; return '연료 보충'; },
});
defActive({
  id: 'blink', name: '긴급 도약', icon: '⚡', cat: 'mobility', rarity: 'rare', price: 220, base: 2, usesFrom: true,
  desc: (v) => `적에게서 먼 안전한 위치로 즉시 이동합니다. (${v}회)`,
  apply(game, t) {
    let best = t.x, bestScore = -Infinity;
    for (let i = 0; i < 26; i++) {
      const x = 60 + Math.random() * (W - 120);
      let score = Math.random() * 40;
      for (const o of game.tanks) {
        if (!o.alive || o.team === t.team) continue;
        score += Math.min(320, Math.abs(o.x - x)) * 0.35;
      }
      if (score > bestScore) { bestScore = score; best = x; }
    }
    if (typeof FX !== 'undefined') FX.explosion(t.x, t.cy, 26, 'ice');
    t.x = Math.round(best);
    t.y = Terrain.heightAt(game.ground, t.x);
    if (typeof FX !== 'undefined') FX.explosion(t.x, t.cy, 30, 'ice');
    return '도약';
  },
});

/* ══════════════ 6. 전술 ══════════════ */

defActive({
  id: 'mine', name: '지뢰 매설', icon: '⚫', cat: 'tactic', rarity: 'common', price: 100, base: 42, uses: 2,
  desc: (v) => `발밑에 지뢰를 묻습니다. 적이 지나가면 ${v} 피해로 터집니다.`,
  apply(game, t, v) {
    game.mines.push({ x: t.x, y: Terrain.heightAt(game.ground, t.x), owner: t.id, team: t.team, dmg: v, t: 0 });
    return `지뢰 매설 (${v})`;
  },
});
defActive({
  id: 'emp', name: 'EMP 발생기', icon: '📡', cat: 'tactic', rarity: 'rare', price: 250, base: 1, uses: 1,
  desc: (v) => `적 전원의 다음 ${v}턴 이동을 묶습니다.`,
  apply(game, t, v) {
    let n = 0;
    for (const o of game.tanks) {
      if (!o.alive || o.team === t.team) continue;
      o.frozen = Math.max(o.frozen, v); n++;
    }
    if (typeof Sfx !== 'undefined' && Sfx.warning) Sfx.warning();
    return `EMP — 적 ${n}대 ${v}턴 정지`;
  },
});
defActive({
  id: 'oil', name: '유막 살포', icon: '🛢', cat: 'tactic', rarity: 'common', price: 125, base: 2, uses: 2,
  desc: (v) => `적 전원의 이동력을 ${v}턴 동안 절반으로 떨어뜨립니다.`,
  apply(game, t, v) {
    for (const o of game.tanks) if (o.alive && o.team !== t.team) o.oiled = v;
    return `유막 ${v}턴`;
  },
});
defActive({
  id: 'sabotage', name: '무장 교란', icon: '🔧', cat: 'tactic', rarity: 'rare', price: 240, base: 1, uses: 1,
  value: (roll) => Math.max(1, Math.round(roll)),
  desc: (v) => `무작위 적의 특수 무기 ${v}종을 이번 판 동안 못 쓰게 만듭니다.`,
  apply(game, t, v) {
    const foes = game.tanks.filter((o) => o.alive && o.team !== t.team);
    if (!foes.length) return null;
    const foe = foes[Math.floor(Math.random() * foes.length)];
    const opts = foe.weapons.filter((id) => id !== 'shell' && foe.ammo[id] > 0);
    if (!opts.length) return '교란 실패 — 특수 무기 없음';
    const got = [];
    for (let i = 0; i < v && opts.length; i++) {
      const id = opts.splice(Math.floor(Math.random() * opts.length), 1)[0];
      foe.ammo[id] = 0;
      got.push(WEAPONS[id].name);
    }
    return `${foe.name}의 ${got.join(', ')} 봉인`;
  },
});
defActive({
  id: 'windctl', name: '기상 제어기', icon: '🌀', cat: 'tactic', rarity: 'rare', price: 210, base: 2, usesFrom: true,
  desc: (v) => `바람을 즉시 잠재웁니다. (${v}회)`,
  apply(game, t) {
    game.wind = 0;
    if (typeof FX !== 'undefined' && FX.setWind) FX.setWind(0);
    return '무풍';
  },
});
defActive({
  id: 'quakebomb', name: '지각 변동', icon: '🌎', cat: 'tactic', rarity: 'epic', price: 400, base: 7, uses: 1,
  desc: (v) => `전장 ${v}곳의 지형을 한꺼번에 무너뜨립니다.`,
  apply(game, t, v) {
    for (let i = 0; i < v; i++) {
      const x = 80 + Math.random() * (W - 160);
      Terrain.collapse(game.ground, x, 150 + Math.random() * 120, 30 + Math.random() * 26, H - 4);
      if (typeof FX !== 'undefined') FX.explosion(x, Terrain.heightAt(game.ground, x), 40, 'quake');
    }
    if (typeof FX !== 'undefined') FX.shake(1.1);
    if (typeof Sfx !== 'undefined' && Sfx.explode) Sfx.explode(90, 'quake');
    return `지각 변동 ×${v}`;
  },
});
defActive({
  id: 'meteor', name: '유성 소환', icon: '🌠', cat: 'tactic', rarity: 'epic', price: 450, base: 4, uses: 1,
  desc: (v) => `무작위 지역에 운석 ${v}발이 떨어집니다. 아군도 조심하세요.`,
  apply(game, t, v) { game.callMeteors(v, t.id); return `유성우 ×${v}`; },
});
defActive({
  id: 'strike', name: '항공 폭격', icon: '✈', cat: 'tactic', rarity: 'epic', price: 440, base: 3, uses: 1,
  desc: (v) => `가장 체력이 많은 적의 머리 위로 폭탄 ${v}발을 떨어뜨립니다.`,
  apply(game, t, v) {
    const foes = game.tanks.filter((o) => o.alive && o.team !== t.team);
    if (!foes.length) return null;
    foes.sort((a, b) => b.hp - a.hp);
    game.callAirstrike(foes[0].x, t.id, v);
    return `${foes[0].name} 좌표로 폭격 ×${v}`;
  },
});
defActive({
  id: 'acid', name: '산성비', icon: '🌧', cat: 'tactic', rarity: 'rare', price: 260, base: 3, uses: 1,
  desc: (v) => `${v}턴 동안 적 전원이 매 턴 12씩 피해를 입습니다.`,
  apply(game, t, v) {
    for (const o of game.tanks) if (o.alive && o.team !== t.team) o.acid = v;
    return `산성비 ${v}턴`;
  },
});

/* ══════════════ 7. 지원 ══════════════ */

defActive({
  id: 'medevac', name: '아군 수리 신호', icon: '🚑', cat: 'support', rarity: 'rare', price: 220, base: 30, uses: 1,
  desc: (v) => `나를 포함한 아군 전원이 ${v} 회복합니다.`,
  apply(game, t, v) {
    let n = 0;
    for (const o of game.tanks) {
      if (!o.alive || o.team !== t.team) continue;
      o.hp = Math.min(o.maxHp, o.hp + v); n++;
    }
    return `아군 ${n}대 +${v}`;
  },
});
defActive({
  id: 'resupply', name: '아군 재보급', icon: '🎁', cat: 'support', rarity: 'rare', price: 240, base: 1, uses: 1,
  desc: (v) => `아군 전원의 모든 무기 탄약이 ${v}발씩 늘어납니다.`,
  apply(game, t, v) {
    let n = 0;
    for (const o of game.tanks) {
      if (!o.alive || o.team !== t.team) continue;
      for (const id of o.weapons) if (o.ammo[id] !== Infinity) o.ammo[id] += v;
      n++;
    }
    return `아군 ${n}대 탄약 +${v}`;
  },
});
defActive({
  id: 'command', name: '지휘 통제', icon: '🎖', cat: 'support', rarity: 'epic', price: 400, base: 18, uses: 1,
  desc: (v) => `아군 전원의 피해량이 이번 판 동안 ${v}% 올라갑니다.`,
  apply(game, t, v) {
    let n = 0;
    for (const o of game.tanks) {
      if (!o.alive || o.team !== t.team) continue;
      o.buffs.damage = (o.buffs.damage || 1) * (1 + v / 100); n++;
    }
    return `아군 ${n}대 화력 +${v}%`;
  },
});
defActive({
  id: 'airdrop', name: '보급 요청', icon: '🛩', cat: 'support', rarity: 'common', price: 160, base: 2, uses: 2,
  desc: (v) => `보급기를 즉시 불러 상자 ${v}개를 떨어뜨립니다.`,
  apply(game, t, v) { game.callSupplyPlane(v); return `보급기 호출 ×${v}`; },
});

/* ══════════════ 8. 경제 ══════════════ */

defItem({
  id: 'scanner', name: '전과 기록기', icon: '📈', kind: 'buff', cat: 'eco', rarity: 'rare', price: 230, base: 40,
  desc: (v) => `이번 판에서 얻는 크레딧이 ${v}% 늘어납니다.`,
  apply(game, t, v) { t.buffs.credit = (t.buffs.credit || 1) * (1 + v / 100); return `크레딧 +${v}%`; },
});
defItem({
  id: 'magnet', name: '자기 수집기', icon: '🧲', kind: 'buff', cat: 'eco', rarity: 'common', price: 135, base: 3,
  value: (roll) => Math.round(30 * roll) / 10,
  desc: (v) => `보급 상자를 ${v}배 먼 거리에서 끌어당겨 줍습니다.`,
  apply(game, t, v) { t.buffs.magnet = (t.buffs.magnet || 1) * v; return `수집 반경 ×${v}`; },
});
defItem({
  id: 'dupe', name: '복제 장치', icon: '♊', kind: 'buff', cat: 'eco', rarity: 'epic', price: 370, base: 1,
  desc: () => '앞으로 줍는 보급 상자가 두 개 분량이 됩니다.',
  apply(game, t) { t.buffs.dupe = true; return '상자 2배'; },
});
defItem({
  id: 'insurance', name: '전투 보험', icon: '📜', kind: 'buff', cat: 'eco', rarity: 'common', price: 125, base: 70,
  value: (roll) => Math.min(95, Math.round(60 * roll)),
  desc: (v) => `져도 크레딧의 ${v}%를 받습니다. (기본 40%)`,
  apply(game, t, v) { t.buffs.insurance = Math.max(t.buffs.insurance || 0, v / 100); return `패배 보상 ${v}%`; },
});
defItem({
  id: 'jackpot', name: '전리품 상자', icon: '💰', cat: 'eco', rarity: 'rare', price: 0, base: 130,
  noShop: true,
  desc: (v) => `즉시 크레딧 ${v}을 얻습니다.`,
  apply(game, t, v) { game.bonusCredits = (game.bonusCredits || 0) + v; return `크레딧 +${v}`; },
});

/* ══════════════ 9. 특수 개조 (창의 계열) ══════════════ */

defItem({
  id: 'twin_barrel', name: '쌍둥이 포신', icon: '⚌', kind: 'buff', cat: 'offense', rarity: 'epic', price: 470, base: 1,
  desc: () => '모든 사격이 두 발로 나갑니다. 탄약은 한 발만 소모됩니다.',
  apply(game, t) { t.buffs.twinBarrel = true; return '쌍포신'; },
});
defItem({
  id: 'death_blast', name: '자폭 장치', icon: '💀', kind: 'buff', cat: 'offense', rarity: 'rare', price: 235, base: 70,
  desc: (v) => `파괴되는 순간 반경 ${v}의 대폭발을 일으킵니다.`,
  apply(game, t, v) { t.buffs.deathBlast = Math.max(t.buffs.deathBlast || 0, v); return `자폭 (반경 ${v})`; },
});
defItem({
  id: 'heatsink', name: '흡열 장갑', icon: '🌡', kind: 'buff', cat: 'defense', rarity: 'rare', price: 250, base: 10,
  desc: (v) => `불바다와 산성비 피해를 받지 않고, 오히려 매 턴 ${v}씩 회복합니다.`,
  apply(game, t, v) { t.buffs.heatsink = Math.max(t.buffs.heatsink || 0, v); return '열 흡수'; },
});
defItem({
  id: 'cryo_coat', name: '극저온 코팅', icon: '🧊', kind: 'buff', cat: 'offense', rarity: 'rare', price: 260, base: 1,
  desc: (v) => `내 공격에 맞은 적이 ${v}턴 동안 얼어붙습니다.`,
  apply(game, t, v) { t.buffs.frostTouch = Math.max(t.buffs.frostTouch || 0, v); return `빙결 부여 ${v}턴`; },
});
defItem({
  id: 'auto_medic', name: '자동 응급 나노', icon: '🚨', kind: 'buff', cat: 'heal', rarity: 'epic', price: 390, base: 45,
  desc: (v) => `체력이 30% 밑으로 떨어지면 즉시 ${v} 회복합니다. (판당 1회)`,
  apply(game, t, v) { t.buffs.autoMedic = Math.max(t.buffs.autoMedic || 0, v); return `응급 회복 ${v}`; },
});
defItem({
  id: 'scavenger', name: '약탈자', icon: '🏴', kind: 'buff', cat: 'eco', rarity: 'rare', price: 245, base: 60,
  desc: (v) => `적을 격파할 때마다 크레딧 ${v}을 추가로 챙깁니다.`,
  apply(game, t, v) { t.buffs.scavenger = (t.buffs.scavenger || 0) + v; return `격파 보상 +${v}`; },
});
defItem({
  id: 'charm', name: '행운의 부적', icon: '🍀', kind: 'buff', cat: 'eco', rarity: 'rare', price: 255, base: 20,
  desc: (v) => `보급 상자에서 나오는 아이템 성능이 ${v}% 좋아집니다.`,
  apply(game, t, v) { t.buffs.luck = (t.buffs.luck || 0) + v / 100; return `행운 +${v}%`; },
});
defItem({
  id: 'siege', name: '요새 모드', icon: '🏰', kind: 'buff', cat: 'offense', rarity: 'rare', price: 240, base: 30,
  desc: (v) => `이번 턴에 한 칸도 움직이지 않았다면 피해가 ${v}% 올라갑니다.`,
  apply(game, t, v) { t.buffs.siege = Math.max(t.buffs.siege || 0, v); return `정지 사격 +${v}%`; },
});
defItem({
  id: 'bulwark', name: '방폭 격벽', icon: '🚧', kind: 'buff', cat: 'defense', rarity: 'rare', price: 245, base: 30,
  desc: (v) => `폭발로 받는 피해가 ${v}% 줄어듭니다. (직격은 제외)`,
  apply(game, t, v) { t.buffs.bulwark = Math.max(t.buffs.bulwark || 0, v / 100); return `폭발 저항 ${v}%`; },
});

defActive({
  id: 'minefield', name: '지뢰밭', icon: '🕳', cat: 'tactic', rarity: 'rare', price: 230, base: 3, uses: 1,
  desc: (v) => `내 주변에 지뢰 ${v}개를 한꺼번에 묻습니다.`,
  apply(game, t, v) {
    for (let i = 0; i < v; i++) {
      const x = clamp(t.x + (i - (v - 1) / 2) * 56 + (Math.random() * 20 - 10), 20, W - 20);
      game.mines.push({ x, y: Terrain.heightAt(game.ground, x), owner: t.id, team: t.team, dmg: 38, t: 0 });
    }
    return `지뢰 ${v}개 매설`;
  },
});
defActive({
  id: 'storm', name: '폭풍 유발기', icon: '🌪', cat: 'tactic', rarity: 'common', price: 130, base: 10,
  value: (roll) => Math.min(10, Math.round(8 * roll)),
  uses: 2,
  desc: (v) => `바람을 세기 ${v}까지 몰아칩니다. 풍향 보정기가 있다면 나만 유리해집니다.`,
  apply(game, t, v) {
    game.wind = (t.facing >= 0 ? 1 : -1) * v;
    if (typeof FX !== 'undefined' && FX.setWind) FX.setWind(game.wind);
    if (typeof Sfx !== 'undefined' && Sfx.windGust) Sfx.windGust(game.wind);
    return `폭풍 ${game.wind > 0 ? '→' : '←'}${v}`;
  },
});
defActive({
  id: 'restore', name: '지형 복원기', icon: '🧱', cat: 'tactic', rarity: 'rare', price: 235, base: 220,
  uses: 1,
  desc: (v) => `내 주변 폭 ${v}의 지형을 원래 모습으로 되돌립니다.`,
  apply(game, t, v) {
    game.restoreTerrain(t.x, v / 2);
    if (typeof Sfx !== 'undefined' && Sfx.collapse) Sfx.collapse();
    return '지형 복원';
  },
});
defActive({
  id: 'shuffle', name: '전장 재배치', icon: '🔀', cat: 'tactic', rarity: 'epic', price: 380, base: 1, uses: 1,
  desc: () => '모든 전차의 위치를 무작위로 뒤섞습니다. 불리한 자리를 뒤집을 때.',
  apply(game, t) {
    const alive = game.tanks.filter((o) => o.alive);
    const spots = alive.map(() => 70 + Math.random() * (W - 140)).sort((a, b) => a - b);
    for (const o of alive) {
      if (typeof FX !== 'undefined') FX.explosion(o.x, o.cy, 24, 'ice');
      const x = Math.round(spots.splice(Math.floor(Math.random() * spots.length), 1)[0]);
      o.x = x;
      o.y = Terrain.heightAt(game.ground, x);
      if (typeof FX !== 'undefined') FX.explosion(o.x, o.cy, 26, 'ice');
    }
    return `${alive.length}대 재배치`;
  },
});
defActive({
  id: 'dome', name: '보호 돔', icon: '⛺', cat: 'defense', rarity: 'epic', price: 400, base: 2, uses: 1,
  desc: (v) => `${v}턴 동안 내가 받는 폭발 피해가 70% 줄어듭니다.`,
  apply(game, t, v) { t.buffs.dome = v + 1; return `보호 돔 ${v}턴`; },
});

/* ══════════════ 인스턴스 (굴림) ══════════════ */

const ITEM_IDS = Object.keys(ITEMS);
const SHOP_IDS = ITEM_IDS.filter((id) => !ITEMS[id].noShop);

function itemDef(id) { return ITEMS[id] || null; }

function qualityOf(roll) {
  for (const q of QUALITY) if (roll >= q.min) return q;
  return QUALITY[QUALITY.length - 1];
}

/** 인스턴스의 실제 수치 */
function itemValue(inst) {
  const def = ITEMS[inst.id];
  if (!def) return 0;
  return def.value(inst.roll != null ? inst.roll : 1);
}

/** 화면에 보여줄 이름 — 품질이 표준이 아니면 접두사를 붙입니다 */
function itemName(inst) {
  const def = ITEMS[inst.id];
  if (!def) return '?';
  const q = qualityOf(inst.roll != null ? inst.roll : 1);
  return q.label === '표준' ? def.name : `${q.label} ${def.name}`;
}

function itemDesc(inst) {
  const def = ITEMS[inst.id];
  if (!def) return '';
  return def.desc(itemValue(inst));
}

/** 사용형 아이템의 사용 횟수 */
function itemUses(inst) {
  const def = ITEMS[inst.id];
  if (!def || def.kind !== 'active') return 0;
  return Math.max(1, def.usesOf(itemValue(inst)));
}

/* ── 지속 방식 ──
 *   once : 일회성 (즉시 효과 · 탄약)
 *   match: 이번 판 동안 부착 (지속 강화 · 사용형)
 *   perm : 영구 장착 모듈 — 슬롯에 꽂아 두면 매 판 자동 적용 (비쌉니다)
 */
const PERM_PRICE_MUL = 6.5;

function durationOf(inst) {
  if (inst && inst.perm) return 'perm';
  const def = ITEMS[inst.id];
  if (!def) return 'once';
  return (def.kind === 'ammo' || def.kind === 'instant') ? 'once' : 'match';
}

const DURATION_LABEL = { once: '일회성', match: '이번 판', perm: '영구 장착' };

/** 영구 모듈로 만들 수 있는 아이템 — 지속 강화 계열만 */
function canBePermanent(id) {
  const def = ITEMS[id];
  return !!def && def.kind === 'buff' && !def.noShop;
}

function priceOf(def, roll, stage, perm) {
  const infl = 1 + Math.min(0.5, (stage || 0) * 0.04);
  const jitter = 0.94 + Math.random() * 0.12;
  const mul = perm ? PERM_PRICE_MUL : 1;
  return Math.max(25, Math.round(def.price * (0.30 + roll * 0.78) * infl * jitter * mul));
}

/** 아이템 인스턴스 하나 굴리기 */
function rollInstance(id, stage, perm) {
  const def = ITEMS[id];
  if (!def) return null;
  const floor = RARITY[def.rarity].floor || 0;
  // 가운데가 두툼한 분포 (양극단은 드물게). 영구 모듈은 조금 더 잘 나옵니다.
  const t = (Math.random() + Math.random()) / 2;
  const bump = perm ? 0.08 : 0;
  const roll = Math.round(Math.min(1.62, 0.70 + floor + bump + t * (0.85 - floor)) * 100) / 100;
  const inst = { id, roll, price: priceOf(def, roll, stage, perm) };
  if (perm) inst.perm = true;
  return inst;
}

/** 영구 모듈 재고 */
function rollModuleStock(n, stage) {
  const pool = SHOP_IDS.filter(canBePermanent);
  const out = [];
  const seen = {};
  let guard = 0;
  while (out.length < n && guard++ < 300) {
    const id = weightedPick(pool);
    if (!id || seen[id]) continue;
    seen[id] = 1;
    out.push(rollInstance(id, stage, true));
  }
  return out;
}

function weightedPick(pool) {
  if (!pool.length) return null;
  let total = 0;
  for (const id of pool) total += RARITY[ITEMS[id].rarity].weight;
  let r = Math.random() * total;
  for (const id of pool) {
    r -= RARITY[ITEMS[id].rarity].weight;
    if (r <= 0) return id;
  }
  return pool[pool.length - 1];
}

/** 상점 재고 n개 (중복 없음) */
function rollShopStock(n, stage) {
  const out = [];
  const seen = {};
  let guard = 0;
  while (out.length < n && guard++ < 400) {
    const id = weightedPick(SHOP_IDS);
    if (!id || seen[id]) continue;
    seen[id] = 1;
    out.push(rollInstance(id, stage));
  }
  return out;
}

/** 전장 보급 상자 내용물 */
function rollCrateItem(stage) {
  return rollInstance(weightedPick(ITEM_IDS.filter((id) => ITEMS[id].price <= 460)), stage);
}

/** 격파 드롭 — 조금 더 좋은 것이 나옵니다 */
function rollDropItem(stage) {
  const id = weightedPick(ITEM_IDS.filter((i) => ITEMS[i].rarity !== 'common' || Math.random() < 0.5));
  const inst = rollInstance(id, stage);
  if (inst) {
    inst.roll = Math.round(Math.min(1.55, inst.roll + 0.08) * 100) / 100;
    inst.price = priceOf(ITEMS[id], inst.roll, stage);
  }
  return inst;
}
