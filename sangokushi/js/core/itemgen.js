// ============================================================
//  보물(寶物) 절차 생성기
//  기본형 × 재질/접두 × 명문/접미 × 희귀도 × 무작위 옵션
//  → 사실상 수만 가지 조합의 아이템이 나온다.
// ============================================================
import { STAT_KEYS } from './traits.js';

// ---- 희귀도 ----------------------------------------------------------
export const RARITY = [
  { id: 0, name: '평범', color: '#b7ad97', mult: 0.6, affixes: [0, 1], weight: 100 },
  { id: 1, name: '양품', color: '#79b37a', mult: 0.9, affixes: [1, 2], weight: 62 },
  { id: 2, name: '일품', color: '#6fa8d6', mult: 1.25, affixes: [2, 3], weight: 30 },
  { id: 3, name: '진품', color: '#b98ade', mult: 1.7, affixes: [3, 4], weight: 12 },
  { id: 4, name: '신품', color: '#e0a martial', mult: 2.3, affixes: [4, 5], weight: 4 },
  { id: 5, name: '천하제일', color: '#e8c15a', mult: 3.2, affixes: [5, 6], weight: 1 },
];
RARITY[4].color = '#e0a24c';

// ---- 기본형 ----------------------------------------------------------
// slot: weapon(무기) / armor(방어구) / horse(명마) / book(병서) / treasure(보물) / relic(신물)
export const BASE_ITEMS = [
  // 무기
  { slot: 'weapon', name: '검',     hanja: '劍',   base: { war: 4 }, w: 100 },
  { slot: 'weapon', name: '도',     hanja: '刀',   base: { war: 5 }, w: 100 },
  { slot: 'weapon', name: '창',     hanja: '槍',   base: { war: 5 }, w: 95 },
  { slot: 'weapon', name: '모',     hanja: '矛',   base: { war: 6 }, w: 70 },
  { slot: 'weapon', name: '극',     hanja: '戟',   base: { war: 7 }, w: 55 },
  { slot: 'weapon', name: '월도',   hanja: '月刀', base: { war: 8 }, w: 35 },
  { slot: 'weapon', name: '부',     hanja: '斧',   base: { war: 7, lead: -1 }, w: 45 },
  { slot: 'weapon', name: '추',     hanja: '鎚',   base: { war: 8, lead: -2 }, w: 30 },
  { slot: 'weapon', name: '편',     hanja: '鞭',   base: { war: 5, lead: 1 }, w: 45 },
  { slot: 'weapon', name: '궁',     hanja: '弓',   base: { war: 4, int: 1 }, w: 70 },
  { slot: 'weapon', name: '노',     hanja: '弩',   base: { war: 5, int: 2 }, w: 40 },
  { slot: 'weapon', name: '쌍고검', hanja: '雙股劍', base: { war: 6, cha: 2 }, w: 20 },
  { slot: 'weapon', name: '삼첨도', hanja: '三尖刀', base: { war: 8 }, w: 18 },
  { slot: 'weapon', name: '철편',   hanja: '鐵鞭', base: { war: 7 }, w: 25 },
  // 방어구
  { slot: 'armor', name: '갑옷',   hanja: '甲',   base: { lead: 3 }, w: 100 },
  { slot: 'armor', name: '찰갑',   hanja: '札甲', base: { lead: 4 }, w: 80 },
  { slot: 'armor', name: '어린갑', hanja: '魚鱗甲', base: { lead: 5 }, w: 50 },
  { slot: 'armor', name: '쇄자갑', hanja: '鎖子甲', base: { lead: 6 }, w: 30 },
  { slot: 'armor', name: '전포',   hanja: '戰袍', base: { lead: 2, cha: 3 }, w: 70 },
  { slot: 'armor', name: '투구',   hanja: '兜',   base: { lead: 3, war: 1 }, w: 85 },
  { slot: 'armor', name: '방패',   hanja: '盾',   base: { lead: 4, war: -1 }, w: 60 },
  { slot: 'armor', name: '학창의', hanja: '鶴氅衣', base: { int: 4, cha: 2 }, w: 35 },
  // 명마
  { slot: 'horse', name: '준마',   hanja: '駿馬', base: { war: 3, lead: 2 }, w: 100 },
  { slot: 'horse', name: '전마',   hanja: '戰馬', base: { war: 4, lead: 2 }, w: 80 },
  { slot: 'horse', name: '서량마', hanja: '西涼馬', base: { war: 5, lead: 3 }, w: 40 },
  { slot: 'horse', name: '흉노마', hanja: '匈奴馬', base: { war: 5, lead: 2 }, w: 40 },
  { slot: 'horse', name: '한혈마', hanja: '汗血馬', base: { war: 7, lead: 4 }, w: 12 },
  // 병서
  { slot: 'book', name: '병법서', hanja: '兵法書', base: { lead: 4, int: 3 }, w: 80 },
  { slot: 'book', name: '경서',   hanja: '經書',  base: { pol: 5, int: 2 }, w: 80 },
  { slot: 'book', name: '사서',   hanja: '史書',  base: { int: 4, pol: 3 }, w: 70 },
  { slot: 'book', name: '천문서', hanja: '天文書', base: { int: 6 }, w: 40 },
  { slot: 'book', name: '둔갑서', hanja: '遁甲書', base: { int: 7, cha: 2 }, w: 18 },
  { slot: 'book', name: '농서',   hanja: '農書',  base: { pol: 6 }, w: 45 },
  { slot: 'book', name: '의서',   hanja: '醫書',  base: { int: 3, pol: 3 }, w: 45 },
  // 보물
  { slot: 'treasure', name: '옥',    hanja: '玉',   base: { cha: 4 }, w: 90 },
  { slot: 'treasure', name: '금인',  hanja: '金印', base: { cha: 5, pol: 2 }, w: 60 },
  { slot: 'treasure', name: '동경',  hanja: '銅鏡', base: { cha: 4, int: 1 }, w: 60 },
  { slot: 'treasure', name: '향로',  hanja: '香爐', base: { cha: 3, pol: 2 }, w: 55 },
  { slot: 'treasure', name: '거문고',hanja: '琴',   base: { cha: 6 }, w: 45 },
  { slot: 'treasure', name: '술잔',  hanja: '爵',   base: { cha: 3 }, w: 70 },
  { slot: 'treasure', name: '인수',  hanja: '印綬', base: { pol: 5, cha: 3 }, w: 35 },
  { slot: 'treasure', name: '보검',  hanja: '寶劍', base: { cha: 4, war: 3 }, w: 40 },
  // 신물 (최상위 전용)
  { slot: 'relic', name: '옥새',   hanja: '玉璽', base: { cha: 12, pol: 8 }, w: 3, unique: true },
  { slot: 'relic', name: '구정',   hanja: '九鼎', base: { cha: 10, pol: 10 }, w: 3, unique: true },
  { slot: 'relic', name: '천서',   hanja: '天書', base: { int: 14 }, w: 3, unique: true },
];

// ---- 접두(재질·유래) --------------------------------------------------
export const PREFIXES = [
  { name: '무쇠',   hanja: '鐵',   mods: { war: 2 }, tier: 0 },
  { name: '청동',   hanja: '靑銅', mods: { cha: 1, war: 1 }, tier: 0 },
  { name: '백은',   hanja: '白銀', mods: { cha: 3 }, tier: 1 },
  { name: '황금',   hanja: '黃金', mods: { cha: 5, pol: 2 }, tier: 2 },
  { name: '한철',   hanja: '寒鐵', mods: { war: 5 }, tier: 2 },
  { name: '오금',   hanja: '烏金', mods: { war: 4, lead: 2 }, tier: 2 },
  { name: '자옥',   hanja: '紫玉', mods: { int: 4, cha: 3 }, tier: 2 },
  { name: '적동',   hanja: '赤銅', mods: { war: 3 }, tier: 1 },
  { name: '흑철',   hanja: '黑鐵', mods: { war: 4, lead: 1 }, tier: 1 },
  { name: '운문',   hanja: '雲紋', mods: { int: 3 }, tier: 1 },
  { name: '용린',   hanja: '龍鱗', mods: { lead: 5, war: 3 }, tier: 3 },
  { name: '봉황',   hanja: '鳳凰', mods: { cha: 7, int: 3 }, tier: 3 },
  { name: '기린',   hanja: '麒麟', mods: { lead: 6, cha: 4 }, tier: 3 },
  { name: '현무',   hanja: '玄武', mods: { lead: 8 }, tier: 3 },
  { name: '주작',   hanja: '朱雀', mods: { war: 6, cha: 3 }, tier: 3 },
  { name: '백호',   hanja: '白虎', mods: { war: 8 }, tier: 3 },
  { name: '청룡',   hanja: '靑龍', mods: { war: 7, lead: 3 }, tier: 3 },
  { name: '태극',   hanja: '太極', mods: { int: 8, cha: 4 }, tier: 4 },
  { name: '북두',   hanja: '北斗', mods: { int: 7, lead: 4 }, tier: 4 },
  { name: '천뢰',   hanja: '天雷', mods: { war: 9, int: 2 }, tier: 4 },
  { name: '고대',   hanja: '古',   mods: { int: 3, cha: 3 }, tier: 1 },
  { name: '서역',   hanja: '西域', mods: { war: 3, cha: 3 }, tier: 1 },
  { name: '남만',   hanja: '南蠻', mods: { war: 4 }, tier: 1 },
  { name: '오나라', hanja: '吳',   mods: { lead: 3 }, tier: 1 },
  { name: '월나라', hanja: '越',   mods: { war: 4, int: 1 }, tier: 2 },
  { name: '초나라', hanja: '楚',   mods: { cha: 3, war: 2 }, tier: 1 },
];

// ---- 접미(명문·이명) --------------------------------------------------
export const SUFFIXES = [
  { name: '단월',   hanja: '斷月', mods: { war: 4 }, tier: 1 },
  { name: '파산',   hanja: '破山', mods: { war: 6 }, tier: 2 },
  { name: '멸혼',   hanja: '滅魂', mods: { war: 7, int: -2 }, tier: 3 },
  { name: '진천',   hanja: '震天', mods: { war: 8, lead: 2 }, tier: 3 },
  { name: '수호',   hanja: '守護', mods: { lead: 5 }, tier: 2 },
  { name: '불괴',   hanja: '不壞', mods: { lead: 8 }, tier: 3 },
  { name: '질풍',   hanja: '疾風', mods: { war: 3, lead: 3 }, tier: 2 },
  { name: '만리',   hanja: '萬里', mods: { lead: 4 }, tier: 2 },
  { name: '천리',   hanja: '千里', mods: { lead: 5, war: 2 }, tier: 3 },
  { name: '통현',   hanja: '通玄', mods: { int: 6 }, tier: 2 },
  { name: '지음',   hanja: '知音', mods: { cha: 6 }, tier: 2 },
  { name: '경국',   hanja: '傾國', mods: { cha: 9 }, tier: 3 },
  { name: '안민',   hanja: '安民', mods: { pol: 6 }, tier: 2 },
  { name: '치세',   hanja: '治世', mods: { pol: 8, int: 2 }, tier: 3 },
  { name: '무명',   hanja: '無銘', mods: {}, tier: 0 },
  { name: '고졸',   hanja: '古拙', mods: { int: 2 }, tier: 0 },
  { name: '유성',   hanja: '流星', mods: { war: 5, lead: 1 }, tier: 2 },
  { name: '한상',   hanja: '寒霜', mods: { war: 4, int: 2 }, tier: 2 },
  { name: '광휘',   hanja: '光輝', mods: { cha: 5, lead: 2 }, tier: 2 },
  { name: '현묘',   hanja: '玄妙', mods: { int: 7, cha: 2 }, tier: 3 },
];

// ---- 무작위 부가 옵션 ------------------------------------------------
export const AFFIX_POOL = [
  { key: 'lead', name: '통솔', min: 1, max: 9 },
  { key: 'war',  name: '무력', min: 1, max: 9 },
  { key: 'int',  name: '지력', min: 1, max: 9 },
  { key: 'pol',  name: '정치', min: 1, max: 9 },
  { key: 'cha',  name: '매력', min: 1, max: 9 },
];

export const SPECIAL_EFFECTS = [
  { id: 'duelPow',    name: '일기토 위력', unit: '%', min: 5, max: 30 },
  { id: 'chargePow',  name: '돌격 위력',   unit: '%', min: 5, max: 30 },
  { id: 'defense',    name: '피해 감소',   unit: '%', min: 3, max: 20 },
  { id: 'moraleKeep', name: '사기 유지',   unit: '%', min: 5, max: 25 },
  { id: 'moveBonus',  name: '이동력',      unit: '',  min: 1, max: 2 },
  { id: 'siegePow',   name: '공성 위력',   unit: '%', min: 8, max: 35 },
  { id: 'navalPow',   name: '수상 전투',   unit: '%', min: 8, max: 35 },
  { id: 'ployRate',   name: '계략 성공률', unit: '%', min: 4, max: 22 },
  { id: 'ployGuard',  name: '계략 간파',   unit: '%', min: 4, max: 22 },
  { id: 'foodSave',   name: '병량 절약',   unit: '%', min: 5, max: 25 },
  { id: 'goldGain',   name: '수입 증가',   unit: '%', min: 3, max: 18 },
  { id: 'loyalGain',  name: '충성 유지',   unit: '',  min: 2, max: 10 },
  { id: 'fameGain',   name: '명성 획득',   unit: '%', min: 5, max: 30 },
  { id: 'healRate',   name: '부상 회복',   unit: '%', min: 10, max: 45 },
  { id: 'lifespan',   name: '수명',        unit: '년', min: 1, max: 6 },
  { id: 'recruit',    name: '등용 성공률', unit: '%', min: 4, max: 20 },
];

// ---- 전설의 신물 (게임당 소수만 존재) --------------------------------
export const LEGENDS = [
  { name: '전국옥새', hanja: '傳國玉璽', slot: 'relic', mods: { cha: 15, pol: 10 },
    effects: [{ id: 'fameGain', v: 50 }, { id: 'loyalGain', v: 8 }],
    lore: '천명을 담았다는 옥의 도장. 지닌 자는 스스로 제위를 칭할 수 있다.' },
  { name: '용천보검', hanja: '龍泉寶劍', slot: 'weapon', mods: { war: 16, lead: 6 },
    effects: [{ id: 'duelPow', v: 40 }], lore: '용의 숨결로 벼렸다는 검. 뽑으면 물빛이 서린다.' },
  { name: '방천화극', hanja: '方天畵戟', slot: 'weapon', mods: { war: 20 },
    effects: [{ id: 'duelPow', v: 45 }, { id: 'chargePow', v: 20 }],
    lore: '한 자루로 천하를 겨눈 무적의 극.' },
  { name: '청홍쌍검', hanja: '靑釭雙劍', slot: 'weapon', mods: { war: 14, lead: 8 },
    effects: [{ id: 'defense', v: 15 }], lore: '갑옷을 진흙처럼 가르는 두 자루의 검.' },
  { name: '적토마',   hanja: '赤兎馬',   slot: 'horse', mods: { war: 12, lead: 8 },
    effects: [{ id: 'moveBonus', v: 2 }, { id: 'chargePow', v: 30 }],
    lore: '하루에 천 리를 달리는 붉은 말. 사람 중엔 여포, 말 중엔 적토.' },
  { name: '적로마',   hanja: '的盧馬',   slot: 'horse', mods: { war: 9, lead: 6 },
    effects: [{ id: 'moveBonus', v: 2 }, { id: 'lifespan', v: -2 }],
    lore: '주인을 살리기도, 해치기도 한다는 백액의 명마.' },
  { name: '태평요술서', hanja: '太平要術書', slot: 'book', mods: { int: 18, cha: 6 },
    effects: [{ id: 'ployRate', v: 25 }, { id: 'ployGuard', v: 20 }],
    lore: '바람을 부르고 비를 내린다는 도가의 비서.' },
  { name: '손자병법',  hanja: '孫子兵法', slot: 'book', mods: { lead: 14, int: 10 },
    effects: [{ id: 'moraleKeep', v: 20 }, { id: 'siegePow', v: 20 }],
    lore: '싸우지 않고 이기는 것이 최상이라 하였다.' },
  { name: '육도삼략',  hanja: '六韜三略', slot: 'book', mods: { lead: 12, int: 8, pol: 6 },
    effects: [{ id: 'moraleKeep', v: 15 }], lore: '태공망이 남겼다는 왕도의 병략.' },
  { name: '칠성보도',  hanja: '七星寶刀', slot: 'weapon', mods: { war: 12, int: 6 },
    effects: [{ id: 'duelPow', v: 25 }, { id: 'ployRate', v: 10 }],
    lore: '일곱 별을 새긴 단도. 암살에도 헌상에도 쓰였다.' },
  { name: '옥대조서',  hanja: '玉帶詔書', slot: 'relic', mods: { cha: 12, pol: 8 },
    effects: [{ id: 'recruit', v: 20 }, { id: 'fameGain', v: 30 }],
    lore: '허리띠에 감춘 천자의 밀조. 대의명분 그 자체.' },
  { name: '동작대금',  hanja: '銅雀臺琴', slot: 'treasure', mods: { cha: 14 },
    effects: [{ id: 'loyalGain', v: 6 }], lore: '한 곡조에 삼군이 눈물을 흘렸다는 거문고.' },
  { name: '남만독룡갑',hanja: '南蠻毒龍甲', slot: 'armor', mods: { lead: 14, war: 6 },
    effects: [{ id: 'defense', v: 25 }], lore: '등나무를 기름에 절여 만든 갑옷. 화공에 약하다.' },
  { name: '만년불후',  hanja: '萬年不朽', slot: 'armor', mods: { lead: 16 },
    effects: [{ id: 'defense', v: 22 }, { id: 'healRate', v: 30 }],
    lore: '천 년을 두어도 녹슬지 않는다는 신갑.' },
  { name: '구천현녀도',hanja: '九天玄女圖', slot: 'relic', mods: { int: 12, cha: 10 },
    effects: [{ id: 'ployGuard', v: 30 }, { id: 'lifespan', v: 5 }],
    lore: '선녀가 내렸다는 그림. 보는 이의 마음을 꿰뚫는다.' },
];

// ------------------------------------------------------------------
let ITEM_SEQ = 1;

function statLabel(k) {
  const e = Object.entries(STAT_KEYS).find(([, v]) => v === k);
  return e ? e[0] : k;
}

function mergeMods(target, src, mult = 1) {
  for (const [k, v] of Object.entries(src || {})) {
    target[k] = (target[k] || 0) + Math.round(v * mult);
  }
  return target;
}

/**
 * 보물 하나를 무작위 생성한다.
 * @param {RNG} rng
 * @param {object} opt { minRarity, maxRarity, slot, powerScale }
 */
export function generateItem(rng, opt = {}) {
  const minR = opt.minRarity ?? 0, maxR = opt.maxRarity ?? 5;
  const pool = RARITY.filter(r => r.id >= minR && r.id <= maxR);
  const rar = rng.weighted(pool, r => r.weight);

  const bases = BASE_ITEMS.filter(b =>
    (!opt.slot || b.slot === opt.slot) && (!b.unique || rar.id >= 4));
  const base = rng.weighted(bases.length ? bases : BASE_ITEMS, b => b.w);

  const scale = (opt.powerScale ?? 1) * rar.mult;
  const mods = {};
  mergeMods(mods, base.base, scale);

  let nameKo = base.name, nameHa = base.hanja;

  // 접두
  if (rng.percent(75)) {
    const pcand = PREFIXES.filter(p => p.tier <= rar.id + 1);
    const pre = rng.pick(pcand.length ? pcand : PREFIXES);
    mergeMods(mods, pre.mods, scale * 0.8);
    nameKo = pre.name + nameKo;
    nameHa = pre.hanja + nameHa;
  }
  // 접미
  if (rng.percent(55)) {
    const scand = SUFFIXES.filter(s => s.tier <= rar.id + 1);
    const suf = rng.pick(scand.length ? scand : SUFFIXES);
    mergeMods(mods, suf.mods, scale * 0.8);
    nameKo = nameKo + '·' + suf.name;
    nameHa = nameHa + suf.hanja;
  }

  // 무작위 부가 능력
  const [amin, amax] = rar.affixes;
  const n = rng.range(amin, amax);
  const effects = [];
  const usedStat = new Set(Object.keys(mods));
  for (let i = 0; i < n; i++) {
    if (rng.percent(55)) {
      const a = rng.pick(AFFIX_POOL);
      const v = Math.max(1, Math.round(rng.range(a.min, a.max) * scale * 0.55));
      mods[a.key] = (mods[a.key] || 0) + v;
      usedStat.add(a.key);
    } else {
      const e = rng.pick(SPECIAL_EFFECTS);
      if (effects.some(x => x.id === e.id)) continue;
      const v = Math.max(1, Math.round(rng.range(e.min, e.max) * (0.6 + rar.id * 0.16)));
      effects.push({ id: e.id, v });
    }
  }

  // 저주받은 물건 — 드물게 마이너스 옵션
  if (rng.percent(7)) {
    const a = rng.pick(AFFIX_POOL);
    mods[a.key] = (mods[a.key] || 0) - rng.range(2, 8);
  }

  const value = Math.round(
    (Object.values(mods).reduce((s, v) => s + Math.max(0, v), 0) * 55 +
     effects.reduce((s, e) => s + e.v * 12, 0)) * (1 + rar.id * 0.35));

  return {
    uid: 'it' + (ITEM_SEQ++),
    name: nameKo, hanja: nameHa,
    slot: base.slot, rarity: rar.id, rarityName: rar.name, color: rar.color,
    mods, effects, value,
    legend: false, owner: null, city: null,
    lore: null,
  };
}

/** 전설의 신물 생성 */
export function makeLegend(def) {
  return {
    uid: 'it' + (ITEM_SEQ++),
    name: def.name, hanja: def.hanja, slot: def.slot,
    rarity: 5, rarityName: '천하제일', color: RARITY[5].color,
    mods: { ...def.mods }, effects: def.effects.map(e => ({ ...e })),
    value: 30000, legend: true, owner: null, city: null, lore: def.lore,
  };
}

/** 아이템 설명 문자열 */
export function itemDescription(item) {
  const parts = [];
  for (const [k, v] of Object.entries(item.mods)) {
    if (!v) continue;
    parts.push(`${statLabel(k)} ${v > 0 ? '+' : ''}${v}`);
  }
  for (const e of item.effects) {
    const def = SPECIAL_EFFECTS.find(s => s.id === e.id);
    if (def) parts.push(`${def.name} ${e.v > 0 ? '+' : ''}${e.v}${def.unit}`);
  }
  return parts.join(' / ') || '특별한 효과는 없다';
}

/** 무장에게 장착된 아이템들의 합산 효과 */
export function aggregateItems(items) {
  const mods = { lead: 0, war: 0, int: 0, pol: 0, cha: 0 };
  const effects = {};
  for (const it of items) {
    for (const [k, v] of Object.entries(it.mods)) mods[k] = (mods[k] || 0) + v;
    for (const e of it.effects) effects[e.id] = (effects[e.id] || 0) + e.v;
  }
  return { mods, effects };
}
