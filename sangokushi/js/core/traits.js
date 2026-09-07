// ============================================================
//  무장 특성 데이터 — 특기 / 성격 / 꿈 / 상성 / 병과 적성
//  무장 1인은 이 표들에서 무작위로 조합되어 태어난다.
// ============================================================

/** 능력 5종 */
export const STATS = ['통솔', '무력', '지력', '정치', '매력'];
export const STAT_KEYS = { 통솔: 'lead', 무력: 'war', 지력: 'int', 정치: 'pol', 매력: 'cha' };

/** 병과 — 적성 S~E */
export const ARMS = ['보병', '기병', '궁병', '수군', '병기'];
export const APT_ORDER = ['E', 'D', 'C', 'B', 'A', 'S'];
export const APT_MULT = { S: 1.35, A: 1.20, B: 1.08, C: 1.0, D: 0.90, E: 0.78 };

// ------------------------------------------------------------
//  특기 (RTK 계열의 「특기」에 해당) — 60종
//  kind: war(전투) / str(계략) / gov(내정) / misc(기타)
// ------------------------------------------------------------
export const TRAITS = [
  // ── 전투 ──
  { id: 'monster',  name: '패왕',   kind: 'war', rarity: 5, desc: '일기토 승률 대폭 상승, 부대 공격력 +25%' },
  { id: 'duelist',  name: '무쌍',   kind: 'war', rarity: 4, desc: '일기토 시 무력 판정 +20' },
  { id: 'charge',   name: '돌격',   kind: 'war', rarity: 3, desc: '기병 돌격 피해 +30%' },
  { id: 'volley',   name: '연사',   kind: 'war', rarity: 3, desc: '궁병 사격이 2회 발생' },
  { id: 'phalanx',  name: '방진',   kind: 'war', rarity: 3, desc: '받는 피해 -20%' },
  { id: 'naval',    name: '수전',   kind: 'war', rarity: 3, desc: '수상 전투력 +35%' },
  { id: 'siege',    name: '공성',   kind: 'war', rarity: 3, desc: '성벽 파괴력 2배' },
  { id: 'ambusher', name: '복병',   kind: 'war', rarity: 3, desc: '삼림·산악에서 선제 기습' },
  { id: 'pursuit',  name: '추격',   kind: 'war', rarity: 2, desc: '퇴각하는 적에게 추가 타격' },
  { id: 'rally',    name: '고무',   kind: 'war', rarity: 3, desc: '아군 사기 회복량 2배' },
  { id: 'ironwall', name: '철벽',   kind: 'war', rarity: 4, desc: '농성 시 성벽 피해 -40%' },
  { id: 'vanguard', name: '선봉',   kind: 'war', rarity: 2, desc: '전투 첫 턴 공격력 +40%' },
  { id: 'guerilla', name: '유격',   kind: 'war', rarity: 2, desc: '이동력 +2' },
  { id: 'endurance',name: '인내',   kind: 'war', rarity: 2, desc: '병량 소모 -25%' },
  { id: 'deadeye',  name: '저격',   kind: 'war', rarity: 4, desc: '적장 부상 확률 상승' },
  { id: 'berserk',  name: '광전',   kind: 'war', rarity: 3, desc: '병력이 적을수록 공격력 증가' },
  { id: 'shield',   name: '수호',   kind: 'war', rarity: 3, desc: '인접 아군 피해 일부 대신 받음' },
  { id: 'formation',name: '진형',   kind: 'war', rarity: 3, desc: '모든 진형 효과 +15%' },
  { id: 'nightraid',name: '야습',   kind: 'war', rarity: 3, desc: '야간 전투 공격력 +40%' },
  { id: 'trample',  name: '유린',   kind: 'war', rarity: 4, desc: '적 부대 격파 시 인접 적도 피해' },

  // ── 계략 ──
  { id: 'firelord', name: '화계',   kind: 'str', rarity: 4, desc: '화공 성공률·피해 대폭 상승' },
  { id: 'flood',    name: '수계',   kind: 'str', rarity: 4, desc: '수계 성공률 상승, 광역 피해' },
  { id: 'confuse',  name: '혼란',   kind: 'str', rarity: 3, desc: '적 부대를 혼란시킨다' },
  { id: 'discord',  name: '이간',   kind: 'str', rarity: 4, desc: '이간계 성공률 +40%' },
  { id: 'rumor',    name: '유언',   kind: 'str', rarity: 3, desc: '유언비어 효과 2배' },
  { id: 'bribe',    name: '매수',   kind: 'str', rarity: 3, desc: '매수 비용 -40%' },
  { id: 'spy',      name: '첩보',   kind: 'str', rarity: 2, desc: '적 정보 완전 공개' },
  { id: 'insight',  name: '통찰',   kind: 'str', rarity: 4, desc: '적 계략 간파 확률 +50%' },
  { id: 'trap',     name: '함정',   kind: 'str', rarity: 3, desc: '전장에 함정을 설치' },
  { id: 'incite',   name: '선동',   kind: 'str', rarity: 3, desc: '적 도시 치안을 크게 떨어뜨림' },
  { id: 'sorcery',  name: '기문',   kind: 'str', rarity: 5, desc: '기상 조작·환술 등 특수 계략' },
  { id: 'psywar',   name: '설전',   kind: 'str', rarity: 3, desc: '설전 판정 +25' },
  { id: 'counter',  name: '반계',   kind: 'str', rarity: 4, desc: '간파한 계략을 되돌려준다' },
  { id: 'sabotage', name: '파괴',   kind: 'str', rarity: 2, desc: '적 병량고를 태운다' },

  // ── 내정 ──
  { id: 'farmer',   name: '둔전',   kind: 'gov', rarity: 3, desc: '개간 효율 +60%' },
  { id: 'merchant', name: '상재',   kind: 'gov', rarity: 3, desc: '상업 효율 +60%' },
  { id: 'engineer', name: '치수',   kind: 'gov', rarity: 3, desc: '치수 효율 +60%, 수해 방지' },
  { id: 'artisan',  name: '기술',   kind: 'gov', rarity: 3, desc: '기술 효율 +60%' },
  { id: 'builder',  name: '축성',   kind: 'gov', rarity: 3, desc: '성벽 수리량 2배' },
  { id: 'recruiter',name: '징병',   kind: 'gov', rarity: 3, desc: '징병 수 +50%, 민심 하락 감소' },
  { id: 'drill',    name: '조련',   kind: 'gov', rarity: 3, desc: '훈련 상승량 +80%' },
  { id: 'healer',   name: '의술',   kind: 'gov', rarity: 4, desc: '역병 무효, 부상 회복 촉진' },
  { id: 'sheriff',  name: '치안',   kind: 'gov', rarity: 2, desc: '치안 유지, 도적 발생 억제' },
  { id: 'trader',   name: '교역',   kind: 'gov', rarity: 3, desc: '교역 이익 +80%' },
  { id: 'logistics',name: '보급',   kind: 'gov', rarity: 3, desc: '수송량 2배, 수송 사고 없음' },
  { id: 'astrolog', name: '천문',   kind: 'gov', rarity: 4, desc: '재해·기후를 미리 알림' },
  { id: 'scribe',   name: '문필',   kind: 'gov', rarity: 2, desc: '명성 획득량 +30%' },
  { id: 'auditor',  name: '회계',   kind: 'gov', rarity: 2, desc: '유지비 -15%' },

  // ── 기타 ──
  { id: 'headhunt', name: '인망',   kind: 'misc', rarity: 4, desc: '등용 성공률 +30%' },
  { id: 'explorer', name: '탐색',   kind: 'misc', rarity: 3, desc: '탐색으로 인재·보물 발견율 상승' },
  { id: 'envoy',    name: '변설',   kind: 'misc', rarity: 3, desc: '외교 성공률 +35%' },
  { id: 'loyalist', name: '충의',   kind: 'misc', rarity: 3, desc: '충성도 하락 없음, 계략 면역' },
  { id: 'famed',    name: '명망',   kind: 'misc', rarity: 4, desc: '주둔 도시 민심 매월 상승' },
  { id: 'rider',    name: '마술',   kind: 'misc', rarity: 2, desc: '이동 시 소모 시간 감소' },
  { id: 'longevity',name: '양생',   kind: 'misc', rarity: 4, desc: '수명 연장, 병사(病死) 확률 감소' },
  { id: 'prodigy',  name: '천재',   kind: 'misc', rarity: 5, desc: '모든 능력 성장 속도 2배' },
  { id: 'lucky',    name: '행운',   kind: 'misc', rarity: 4, desc: '모든 판정에 보정 +8' },
  { id: 'tutor',    name: '교육',   kind: 'misc', rarity: 3, desc: '같은 도시 무장의 능력 성장 촉진' },
  { id: 'poet',     name: '풍류',   kind: 'misc', rarity: 2, desc: '연회 효과 2배, 매력 성장' },
  { id: 'smith',    name: '단야',   kind: 'misc', rarity: 3, desc: '무기·방어구 아이템 제작 가능' },
];

export const TRAIT_BY_ID = Object.fromEntries(TRAITS.map(t => [t.id, t]));

// ------------------------------------------------------------
//  성격 — 행동 성향에 직접 영향
// ------------------------------------------------------------
export const PERSONALITIES = [
  { id: 'daring',   name: '대담', aggr: +25, caution: -20, greed:  0, desc: '무모할 만큼 과감하다' },
  { id: 'brave',    name: '용맹', aggr: +18, caution: -12, greed:  0, desc: '앞장서 싸우기를 즐긴다' },
  { id: 'cool',     name: '냉정', aggr:  -5, caution: +15, greed:  0, desc: '감정에 휘둘리지 않는다' },
  { id: 'prudent',  name: '신중', aggr: -18, caution: +25, greed: -5, desc: '돌다리도 두드린다' },
  { id: 'wild',     name: '저돌', aggr: +30, caution: -28, greed:  5, desc: '앞뒤를 재지 않는다' },
  { id: 'gentle',   name: '온후', aggr: -12, caution:  +8, greed:-15, desc: '너그럽고 인망이 있다' },
  { id: 'strict',   name: '엄격', aggr:  +5, caution: +10, greed:-10, desc: '법도를 중히 여긴다' },
  { id: 'cunning',  name: '교활', aggr:  +8, caution:  +5, greed:+22, desc: '수단을 가리지 않는다' },
  { id: 'loyal',    name: '충직', aggr:   0, caution:   0, greed:-25, desc: '주군을 저버리지 않는다' },
  { id: 'proud',    name: '오만', aggr: +12, caution: -10, greed:+12, desc: '자신을 과신한다' },
  { id: 'reclusive',name: '은둔', aggr: -25, caution: +18, greed:-18, desc: '세상에 나서기를 꺼린다' },
  { id: 'zealous',  name: '열혈', aggr: +20, caution: -15, greed:-10, desc: '뜻을 위해 몸을 사리지 않는다' },
  { id: 'scholar',  name: '학구', aggr: -15, caution: +12, greed: -5, desc: '책과 이치를 좋아한다' },
  { id: 'jovial',   name: '호방', aggr: +10, caution: -8,  greed: +5, desc: '술과 벗을 좋아한다' },
  { id: 'brooding', name: '음침', aggr:  +5, caution: +15, greed:+15, desc: '속을 알 수 없다' },
];

// ------------------------------------------------------------
//  꿈(夢) — 삼국지6의 「꿈」에 해당. 달성 여부가 충성·이탈을 좌우
// ------------------------------------------------------------
export const DREAMS = [
  { id: 'unify',    name: '천하통일',   desc: '난세를 끝내고 천하를 하나로',   check: 'realmCities', need: 0.45 },
  { id: 'lord',     name: '일국의 주인', desc: '스스로 군주가 되어 기치를 든다', check: 'becomeRuler', need: 1 },
  { id: 'fame',     name: '천하에 이름', desc: '이름을 만인의 입에 올린다',     check: 'ownFame',     need: 400 },
  { id: 'serve',    name: '주군의 패업', desc: '섬기는 주군의 대업을 돕는다',   check: 'realmFame',   need: 900 },
  { id: 'peace',    name: '태평성대',   desc: '백성이 굶지 않는 세상',         check: 'realmLoyalty',need: 82 },
  { id: 'revenge',  name: '복수',       desc: '원수의 세력을 멸한다',          check: 'nemesisDead', need: 1 },
  { id: 'strongest',name: '천하제일',   desc: '무예로 천하제일이 된다',        check: 'duelWins',    need: 12 },
  { id: 'wealth',   name: '부귀영화',   desc: '금은과 보물을 산처럼',          check: 'ownItems',    need: 5 },
  { id: 'home',     name: '고향의 평온', desc: '고향 땅이 전화를 겪지 않기를',  check: 'homeSafe',    need: 1 },
  { id: 'friend',   name: '지기와 함께', desc: '뜻이 맞는 벗과 같은 기치 아래', check: 'friendSame',  need: 1 },
  { id: 'rank',     name: '높은 관직',   desc: '조정의 높은 자리에 오른다',     check: 'ownRank',     need: 6 },
  { id: 'record',   name: '사서에 남기', desc: '전공을 사서에 남긴다',          check: 'battleWins',  need: 20 },
  { id: 'recluse',  name: '산야의 은거', desc: '벼슬을 버리고 자연으로',        check: 'never',       need: 1 },
  { id: 'master',   name: '병법의 완성', desc: '병법을 극에 이르게 한다',       check: 'ownLead',     need: 95 },
];

// ------------------------------------------------------------
//  출신 — 초기 능력 편향
// ------------------------------------------------------------
export const ORIGINS = [
  { id: 'noble',   name: '명문',   bias: { pol: +14, cha: +10, war: -6 },  fame: 40 },
  { id: 'scholar', name: '사족',   bias: { int: +16, pol: +10, war: -10 }, fame: 25 },
  { id: 'general', name: '무가',   bias: { war: +16, lead: +10, pol: -8 }, fame: 20 },
  { id: 'farmer',  name: '농민',   bias: { war: +4, pol: +2, int: -4 },    fame: 0 },
  { id: 'merchant',name: '상인',   bias: { pol: +12, cha: +6, lead: -6 },  fame: 8 },
  { id: 'bandit',  name: '녹림',   bias: { war: +14, lead: +6, pol: -14 }, fame: 5 },
  { id: 'nomad',   name: '이민족', bias: { war: +12, lead: +8, int: -8 },  fame: 5 },
  { id: 'hermit',  name: '재야',   bias: { int: +14, cha: +8, lead: -4 },  fame: 12 },
  { id: 'official',name: '관리',   bias: { pol: +16, int: +6, war: -12 },  fame: 18 },
  { id: 'soldier', name: '병졸',   bias: { war: +10, lead: +4, int: -6 },  fame: 0 },
  { id: 'monk',    name: '방사',   bias: { int: +12, cha: +12, war: -10 }, fame: 15 },
  { id: 'artisan', name: '장인',   bias: { int: +8, pol: +8, cha: -6 },    fame: 5 },
];

// ------------------------------------------------------------
//  성장형 — 능력이 언제 절정에 이르는가
// ------------------------------------------------------------
export const GROWTH_TYPES = [
  { id: 'early',  name: '조숙', peak: 26, decay: 0.55, desc: '일찍 피고 일찍 진다' },
  { id: 'normal', name: '평범', peak: 36, decay: 0.40, desc: '무난한 성장' },
  { id: 'late',   name: '대기만성', peak: 48, decay: 0.28, desc: '늦게 꽃핀다' },
  { id: 'steady', name: '완숙', peak: 42, decay: 0.20, desc: '오래도록 쇠하지 않는다' },
  { id: 'genius', name: '천품', peak: 30, decay: 0.35, desc: '태어날 때부터 완성형' },
];

// ------------------------------------------------------------
//  관직 (명성에 따라 수여) — 높을수록 명령 가능 수·수입 증가
// ------------------------------------------------------------
export const RANKS = [
  { lv: 0,  name: '무관직',   fame: 0 },
  { lv: 1,  name: '현령',     fame: 60 },
  { lv: 2,  name: '태수',     fame: 150 },
  { lv: 3,  name: '자사',     fame: 280 },
  { lv: 4,  name: '장군',     fame: 430 },
  { lv: 5,  name: '정서장군', fame: 600 },
  { lv: 6,  name: '대장군',   fame: 800 },
  { lv: 7,  name: '삼공',     fame: 1050 },
  { lv: 8,  name: '승상',     fame: 1350 },
  { lv: 9,  name: '왕',       fame: 1750 },
  { lv: 10, name: '황제',     fame: 2300 },
];

export function rankFor(fame) {
  let r = RANKS[0];
  for (const x of RANKS) if (fame >= x.fame) r = x;
  return r;
}

/** 상성(相性) 거리 — 0~149 원형. 가까울수록 마음이 맞는다 */
export function compatDistance(a, b) {
  const d = Math.abs(a - b);
  return Math.min(d, 150 - d); // 0(최상) ~ 75(최악)
}
