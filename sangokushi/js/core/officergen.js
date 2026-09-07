// ============================================================
//  무장 절차 생성기
//  능력·특기·성격·꿈·상성·적성·외모까지 전부 무작위로 태어난다.
//  아키타입으로 편향을 주어 "그럴듯한" 인물이 나오게 한다.
// ============================================================
import { makePersonName } from './names.js';
import {
  TRAITS, PERSONALITIES, DREAMS, ORIGINS, GROWTH_TYPES,
  ARMS, APT_ORDER, rankFor,
} from './traits.js';

let OFFICER_SEQ = 1;
export function resetOfficerSeq() { OFFICER_SEQ = 1; }

// ---- 아키타입: 능력 분포의 뼈대 ---------------------------------------
export const ARCHETYPES = [
  { id: 'warlord',  name: '맹장',   w: 130, m: { lead: 68, war: 82, int: 42, pol: 38, cha: 55 }, traitKind: ['war'] },
  { id: 'general',  name: '명장',   w: 110, m: { lead: 80, war: 70, int: 58, pol: 48, cha: 60 }, traitKind: ['war', 'gov'] },
  { id: 'strategist', name: '군사', w: 90,  m: { lead: 62, war: 30, int: 84, pol: 68, cha: 55 }, traitKind: ['str'] },
  { id: 'minister', name: '문관',   w: 100, m: { lead: 38, war: 24, int: 70, pol: 82, cha: 58 }, traitKind: ['gov'] },
  { id: 'allround', name: '재사',   w: 80,  m: { lead: 62, war: 58, int: 62, pol: 62, cha: 62 }, traitKind: ['war', 'gov', 'str', 'misc'] },
  { id: 'brute',    name: '용사',   w: 120, m: { lead: 48, war: 78, int: 26, pol: 22, cha: 42 }, traitKind: ['war'] },
  { id: 'sage',     name: '현자',   w: 45,  m: { lead: 45, war: 20, int: 88, pol: 70, cha: 72 }, traitKind: ['str', 'misc'] },
  { id: 'orator',   name: '변사',   w: 60,  m: { lead: 40, war: 28, int: 72, pol: 66, cha: 78 }, traitKind: ['misc', 'str'] },
  { id: 'admiral',  name: '수장',   w: 55,  m: { lead: 74, war: 62, int: 58, pol: 45, cha: 55 }, traitKind: ['war'] },
  { id: 'ranger',   name: '유협',   w: 70,  m: { lead: 52, war: 68, int: 50, pol: 30, cha: 66 }, traitKind: ['war', 'misc'] },
  { id: 'engineerT',name: '장인',   w: 40,  m: { lead: 35, war: 32, int: 76, pol: 62, cha: 40 }, traitKind: ['gov'] },
  { id: 'commoner', name: '범인',   w: 150, m: { lead: 40, war: 42, int: 42, pol: 40, cha: 42 }, traitKind: ['gov', 'misc'] },
  { id: 'hero',     name: '영걸',   w: 18,  m: { lead: 86, war: 84, int: 76, pol: 70, cha: 88 }, traitKind: ['war', 'str', 'misc'] },
];

// ---- 외모 시드 (초상화 생성에 사용) -----------------------------------
function makeAppearance(rng, age, arche) {
  const beardy = ['warlord', 'general', 'brute', 'admiral', 'sage'].includes(arche.id);
  return {
    seed: rng.int(0x7fffffff),
    face: rng.int(6),                       // 얼굴형
    eyes: rng.int(8),                       // 눈매
    brow: rng.int(6),
    nose: rng.int(5),
    mouth: rng.int(5),
    beard: age < 22 ? 0 : rng.int(beardy ? 7 : 4),
    hat: rng.int(9),                        // 관/투구
    skin: rng.int(5),
    scar: rng.percent(14) ? rng.int(3) + 1 : 0,
    hue: rng.range(0, 359),                 // 의복 색
    sat: rng.range(20, 70),
  };
}

function clamp(v, lo = 1, hi = 100) { return Math.max(lo, Math.min(hi, Math.round(v))); }

/**
 * 무장 1인 생성
 * @param {RNG} rng
 * @param {object} opt {registry, year, archetype, quality(0~1), ageRange, forceRuler}
 */
export function generateOfficer(rng, opt = {}) {
  const arche = opt.archetype
    ? ARCHETYPES.find(a => a.id === opt.archetype)
    : rng.weighted(ARCHETYPES, a => a.w);

  const origin = rng.pick(ORIGINS);
  const growth = rng.weighted(GROWTH_TYPES, g => g.id === 'genius' ? 12 : 40);
  const nm = makePersonName(rng, opt.registry);

  // 품질 계수 — 대부분 평범, 드물게 걸출
  const q = opt.quality != null ? opt.quality
    : Math.min(1, Math.max(0, rng.gauss(0.5, 0.19)));
  const bonus = (q - 0.5) * 46;   // -23 ~ +23

  const potential = {};
  for (const k of ['lead', 'war', 'int', 'pol', 'cha']) {
    const base = arche.m[k] + bonus + (origin.bias[k] || 0);
    potential[k] = clamp(rng.gauss(base, 9), 6, 100);
  }
  if (opt.forceRuler) {
    potential.cha = clamp(potential.cha + rng.range(10, 22));
    potential.lead = clamp(potential.lead + rng.range(4, 14));
  }

  const [amin, amax] = opt.ageRange || [16, 58];
  const age = rng.range(amin, amax);
  const born = (opt.year ?? 190) - age;

  // 현재 능력 = 잠재 × 나이 곡선
  const cur = {};
  for (const k of Object.keys(potential)) cur[k] = applyAgeCurve(potential[k], age, growth);

  // 특기 — 아키타입 성향에 맞춰 1~4개
  const traitCount = rng.weighted(
    [{ n: 0, w: 18 }, { n: 1, w: 46 }, { n: 2, w: 26 }, { n: 3, w: 9 }, { n: 4, w: 2 }],
    x => x.w).n + (q > 0.9 ? 1 : 0);
  const traits = pickTraits(rng, arche, traitCount, q);

  // 병과 적성
  const apt = {};
  for (const arm of ARMS) apt[arm] = rollAptitude(rng, arche, arm, q);

  const pers = rng.pick(PERSONALITIES);
  const dream = rng.weighted(DREAMS, d => {
    if (d.id === 'unify' || d.id === 'lord') return q > 0.75 ? 26 : 6;
    if (d.id === 'strongest') return cur.war > 75 ? 24 : 5;
    if (d.id === 'master') return cur.lead > 70 ? 20 : 5;
    return 14;
  });

  const ambition = clamp(rng.range(1, 10) + (pers.greed > 10 ? 2 : 0) +
    (dream.id === 'lord' || dream.id === 'unify' ? 3 : 0), 1, 10);
  const virtue = clamp(rng.range(1, 10) + (pers.id === 'loyal' ? 4 : 0) +
    (pers.id === 'cunning' || pers.id === 'brooding' ? -3 : 0), 1, 10);

  const lifespan = rng.range(38, 76)
    + (traits.includes('longevity') ? rng.range(6, 16) : 0)
    + Math.round((q - 0.5) * 8);

  const fameBase = Math.round(
    origin.fame + (cur.cha + cur.lead) * 0.35 + (q > 0.85 ? rng.range(40, 120) : 0));

  return {
    id: 'o' + (OFFICER_SEQ++),
    name: nm.name, hanja: nm.hanja, courtesy: nm.courtesy, courtesyHanja: nm.courtesyHanja,
    archetype: arche.id, archetypeName: arche.name,
    origin: origin.id, originName: origin.name,
    growth: growth.id, growthName: growth.name,
    // 능력
    lead: cur.lead, war: cur.war, int: cur.int, pol: cur.pol, cha: cur.cha,
    pot: potential,
    exp: { lead: 0, war: 0, int: 0, pol: 0, cha: 0 },
    // 성향
    personality: pers.id, personalityName: pers.name,
    aggr: pers.aggr, caution: pers.caution, greed: pers.greed,
    dream: dream.id, dreamName: dream.name, dreamDone: false,
    ambition, virtue,
    compat: rng.int(150),
    traits,
    apt,
    // 상태
    born, age, lifespan, dead: false, deathYear: null,
    fame: fameBase,
    loyalty: 70, realm: null, city: null, corps: null,
    troops: 0, morale: 0, injury: 0, fatigue: 0, status: 'idle',
    items: [], prisoner: false, free: true,
    stats: { battles: 0, wins: 0, duels: 0, duelWins: 0, kills: 0, debates: 0, debateWins: 0 },
    bonds: {},      // 다른 무장과의 관계 (의형제·원한 등)
    appearance: makeAppearance(rng, age, arche),
    gender: rng.percent(8) ? 'F' : 'M',
    rankLv: 0,
  };
}

function applyAgeCurve(pot, age, growth) {
  const g = GROWTH_TYPES.find(x => x.id === growth.id) || GROWTH_TYPES[1];
  if (age >= g.peak) {
    const over = age - g.peak;
    return clamp(pot - over * g.decay * 0.55, 4, 100);
  }
  const t = Math.max(0, age - 14) / Math.max(1, g.peak - 14);
  const start = g.id === 'genius' ? 0.86 : g.id === 'early' ? 0.72 : g.id === 'late' ? 0.45 : 0.58;
  return clamp(pot * (start + (1 - start) * Math.pow(t, 0.75)), 4, 100);
}

function pickTraits(rng, arche, count, q) {
  const out = [];
  const pool = TRAITS.slice();
  for (let i = 0; i < count; i++) {
    const cand = pool.filter(t => !out.includes(t.id));
    if (!cand.length) break;
    const t = rng.weighted(cand, tr => {
      let w = Math.max(1, 7 - tr.rarity) * 10;
      if (arche.traitKind.includes(tr.kind)) w *= 3.2;
      if (tr.rarity >= 4) w *= (q > 0.85 ? 1.6 : 0.22);
      if (tr.rarity === 5) w *= (q > 0.94 ? 1.2 : 0.06);
      return w;
    });
    if (t) out.push(t.id);
  }
  return out;
}

function rollAptitude(rng, arche, arm, q) {
  // 아키타입별 선호 병과
  const pref = {
    warlord: { 보병: 1, 기병: 2 }, general: { 보병: 2, 기병: 1, 병기: 1 },
    strategist: { 궁병: 1, 병기: 2 }, minister: {}, allround: { 보병: 1 },
    brute: { 보병: 2 }, sage: { 병기: 1 }, orator: {},
    admiral: { 수군: 3, 궁병: 1 }, ranger: { 기병: 2, 궁병: 1 },
    engineerT: { 병기: 3 }, commoner: {}, hero: { 보병: 1, 기병: 1, 궁병: 1 },
  }[arche.id] || {};
  let idx = rng.weighted(
    [{ i: 0, w: 22 }, { i: 1, w: 34 }, { i: 2, w: 30 }, { i: 3, w: 16 }, { i: 4, w: 7 }, { i: 5, w: 2 }],
    x => x.w).i;
  idx += (pref[arm] || 0);
  if (q > 0.88 && rng.percent(40)) idx += 1;
  return APT_ORDER[Math.max(0, Math.min(5, idx))];
}

/** 무장 다수 생성 */
export function generateOfficers(rng, n, opt = {}) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(generateOfficer(rng, opt));
  return out;
}

/** 능력 총합 (평가용) */
export function power(o) { return o.lead + o.war + o.int + o.pol + o.cha; }

/** 전투 지휘 종합력 */
export function combatRating(o) { return o.lead * 1.4 + o.war * 1.0 + o.int * 0.5; }

/** 무장 등급 표기 */
export function gradeOf(o) {
  const p = power(o);
  if (p >= 430) return { g: '초일류', c: '#e8c15a' };
  if (p >= 380) return { g: '일류', c: '#d68a5c' };
  if (p >= 330) return { g: '이류', c: '#7fb3d5' };
  if (p >= 270) return { g: '삼류', c: '#8fae83' };
  return { g: '범재', c: '#9a9384' };
}

/** 매년 성장/노화 처리 */
export function ageOfficer(o, rng, year) {
  o.age++;
  const g = GROWTH_TYPES.find(x => x.id === o.growth) || GROWTH_TYPES[1];
  const prodigy = o.traits.includes('prodigy');
  for (const k of ['lead', 'war', 'int', 'pol', 'cha']) {
    if (o.age <= g.peak) {
      const room = o.pot[k] - o[k];
      if (room > 0) {
        let gain = room * (prodigy ? 0.30 : 0.16) + rng.next() * 1.4;
        // 경험치로 인한 추가 성장
        gain += Math.min(3, (o.exp[k] || 0) / 100);
        o[k] = Math.min(o.pot[k], Math.round((o[k] + gain) * 10) / 10 | 0);
      }
    } else {
      const over = o.age - g.peak;
      if (over > 4 && rng.percent(35 + over)) {
        o[k] = Math.max(4, o[k] - (k === 'war' ? rng.range(1, 3) : rng.range(0, 2)));
      }
      // 지력·정치는 늙어도 잘 안 떨어진다
      if ((k === 'int' || k === 'pol') && rng.percent(25) && o[k] < o.pot[k]) o[k]++;
    }
    o.exp[k] = Math.max(0, (o.exp[k] || 0) * 0.6);
  }
  o.rankLv = rankFor(o.fame).lv;
}

/** 사망 판정 */
export function deathRoll(o, rng) {
  if (o.age < o.lifespan - 6) {
    // 요절 — 아주 드물게
    return rng.percent(0.35);
  }
  const over = o.age - (o.lifespan - 6);
  return rng.percent(4 + over * 6.5);
}
