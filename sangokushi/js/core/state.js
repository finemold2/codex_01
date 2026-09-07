// ============================================================
//  게임 상태 — 세계 · 세력 · 무장 · 보물 · 달력
// ============================================================
import { RNG } from './rng.js';
import { generateWorld, makeRealmName } from './worldgen.js';
import { generateOfficer, resetOfficerSeq, power, combatRating } from './officergen.js';
import { generateItem, makeLegend, LEGENDS, aggregateItems } from './itemgen.js';
import { rankFor, compatDistance, TRAIT_BY_ID, APT_MULT } from './traits.js';
import { makeCorpsName } from './names.js';

export const REALM_COLORS = [
  '#c8433a', '#2f6fb5', '#3e8f52', '#9a4fb0', '#d08a24', '#1f8f96',
  '#b5476f', '#6b7f2a', '#7a5cc4', '#c96a2a', '#48959f', '#8d5a33',
  '#a03d8c', '#547f4a', '#3a5fa8', '#b8623c',
];

export const AI_STYLES = [
  { id: 'conqueror', name: '패도',   aggr: 1.45, dev: 0.7, ploy: 0.9, diplo: 0.6 },
  { id: 'steady',    name: '왕도',   aggr: 0.85, dev: 1.35, ploy: 0.8, diplo: 1.2 },
  { id: 'schemer',   name: '권모',   aggr: 1.0,  dev: 0.9, ploy: 1.7, diplo: 1.1 },
  { id: 'turtle',    name: '수성',   aggr: 0.5,  dev: 1.5, ploy: 0.9, diplo: 1.4 },
  { id: 'raider',    name: '유격',   aggr: 1.3,  dev: 0.6, ploy: 1.2, diplo: 0.5 },
  { id: 'balanced',  name: '중용',   aggr: 1.0,  dev: 1.0, ploy: 1.0, diplo: 1.0 },
];

export const MONTH_NAMES = ['정월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];
export const SEASONS = ['봄','봄','여름','여름','여름','가을','가을','가을','겨울','겨울','겨울','봄'];

/** 시드로부터 세계를 그대로 재현한다 (세이브 로드용) — build()와 난수 소비 순서가 같아야 한다 */
export function rebuildWorld(seed, worldOpt) {
  const rng = new RNG(seed);
  rng.int(40);                        // 생성자의 rolledYear 자리
  rng.range(30, 46);                  // build()의 rolledCityCount 자리
  return generateWorld(rng, worldOpt);
}

export class Game {
  constructor(opt = {}) {
    this.seed = (opt.seed ?? (Date.now() ^ (Math.random() * 0xffffffff))) >>> 0;
    this.rng = new RNG(this.seed);
    this.opt = opt;
    const rolledYear = 180 + this.rng.int(40);   // 항상 굴려 난수 순서를 고정한다
    this.year = opt.year ?? rolledYear;
    this.month = 0;
    this.turnNo = 0;
    this.log = [];
    this.officers = [];
    this.officerById = {};
    this.realms = [];
    this.realmById = {};
    this.items = [];
    this.itemById = {};
    this.playerRealm = null;
    this.playerOfficer = null;
    this.pendingBattle = null;
    this.gameOver = null;
    this.difficulty = opt.difficulty ?? 2;   // 0~4
    this.freeOfficers = [];                  // 재야
    this.history = [];
    this.build();
  }

  // ── 생성 ──────────────────────────────────────────────
  build() {
    const rng = this.rng;
    resetOfficerSeq();
    // 세계 생성에 쓴 설정을 그대로 보관한다 — 세이브에서 같은 대륙을 재현하기 위해.
    // 난수 소비 순서를 고정해야 하므로 기본값도 항상 한 번 굴린다.
    const rolledCityCount = rng.range(30, 46);
    this.worldOpt = {
      cityCount: this.opt.cityCount ?? rolledCityCount,
      cols: 220, rows: 150,
    };
    this.world = generateWorld(rng, this.worldOpt);
    this.cities = this.world.cities;
    this.cityById = Object.fromEntries(this.cities.map(c => [c.id, c]));
    this.provinces = this.world.provinces;

    // ── 무장 생성 ──
    const n = this.opt.officerCount ?? Math.round(this.cities.length * rng.range(5, 8));
    for (let i = 0; i < n; i++) {
      const o = generateOfficer(rng, { registry: this.world.registry, year: this.year });
      this.officers.push(o);
    }
    // 걸출한 영웅 몇 명을 반드시 섞는다
    const heroes = rng.range(4, 9);
    for (let i = 0; i < heroes; i++) {
      const o = generateOfficer(rng, {
        registry: this.world.registry, year: this.year,
        quality: 0.90 + rng.next() * 0.10, ageRange: [20, 42],
      });
      this.officers.push(o);
    }
    this.officers.forEach(o => { this.officerById[o.id] = o; });

    // ── 세력 편성 ──
    const realmCount = this.opt.realmCount ?? rng.range(5, Math.min(11, Math.max(6, Math.floor(this.cities.length / 3.4))));
    this.formRealms(realmCount);

    // ── 보물 배치 ──
    this.seedItems();

    // ── 인물 관계 ──
    this.seedBonds();

    this.pushLog(`${this.year}년 ${MONTH_NAMES[this.month]} — 난세가 열렸다.`, 'era');
  }

  formRealms(count) {
    const rng = this.rng;
    // 유력 인물을 군주로
    const pool = this.officers.slice().sort((a, b) =>
      (b.cha * 1.5 + b.lead + b.ambition * 8) - (a.cha * 1.5 + a.lead + a.ambition * 8));
    const rulers = [];
    for (const o of pool) {
      if (rulers.length >= count) break;
      if (o.age > 62 || o.age < 18) continue;
      rulers.push(o);
    }
    // 도시를 세력별로 나눈다 — 씨앗 도시에서 확장
    const seeds = rng.sample(this.cities, count);
    const owner = {};
    const frontier = seeds.map((c, i) => ({ i, list: [c] }));
    seeds.forEach((c, i) => { owner[c.id] = i; });
    let remaining = this.cities.length - count;
    let guard = 0;
    while (remaining > 0 && guard++ < 4000) {
      const f = rng.pick(frontier);
      if (!f.list.length) continue;
      const from = f.list[rng.int(f.list.length)];
      const cands = from.links.map(l => this.cityById[l.to]).filter(c => c && owner[c.id] === undefined);
      if (!cands.length) {
        f.list.splice(f.list.indexOf(from), 1);
        if (frontier.every(x => !x.list.length)) break;
        continue;
      }
      const pick = rng.pick(cands);
      owner[pick.id] = f.i;
      f.list.push(pick);
      remaining--;
    }
    // 남은 도시는 재야(중립) — 소규모 독립 세력이나 공백지
    this.realms = rulers.map((r, i) => {
      const nm = makeRealmName(rng, this.world.registry);
      const style = rng.pick(AI_STYLES);
      return {
        id: 'r' + i, name: nm.name, hanja: nm.hanja,
        color: REALM_COLORS[i % REALM_COLORS.length],
        ruler: r.id, cities: [], gold: rng.range(1500, 6000), food: rng.range(20000, 70000),
        fame: rng.range(60, 260), aiStyle: style.id, aiName: style.name,
        diplo: {}, truce: {}, ally: {}, isPlayer: false, dead: false,
        corps: [], strategy: null, capital: null, tribute: {},
        stats: { battlesWon: 0, battlesLost: 0, citiesTaken: 0 },
      };
    });
    this.realms.forEach(r => { this.realmById[r.id] = r; });

    for (const c of this.cities) {
      const idx = owner[c.id];
      if (idx === undefined || idx >= this.realms.length) { c.realm = null; continue; }
      c.realm = this.realms[idx].id;
      this.realms[idx].cities.push(c.id);
    }
    // 도시가 없는 세력 제거
    this.realms = this.realms.filter(r => r.cities.length > 0);
    this.realmById = Object.fromEntries(this.realms.map(r => [r.id, r]));
    this.realms.forEach(r => {
      r.capital = r.cities[0];
      const ruler = this.officerById[r.ruler];
      ruler.realm = r.id; ruler.city = r.capital; ruler.loyalty = 100;
      ruler.fame += rng.range(60, 200);
      this.cityById[r.capital].officers.push(ruler.id);
    });

    // ── 무장 배치 ──
    const rulerIds = new Set(this.realms.map(r => r.ruler));
    const rest = this.officers.filter(o => !rulerIds.has(o.id));
    rng.shuffle(rest);
    for (const o of rest) {
      // 재야로 남을 확률
      if (rng.percent(24)) {
        o.realm = null;
        o.city = rng.pick(this.cities).id;
        this.freeOfficers.push(o.id);
        continue;
      }
      // 상성이 맞는 군주에게 붙는다
      const cand = this.realms.map(r => {
        const ru = this.officerById[r.ruler];
        const d = compatDistance(o.compat, ru.compat);
        return { r, w: Math.max(1, (75 - d)) ** 1.6 * (1 + r.cities.length * 0.1) };
      });
      const chosen = rng.weighted(cand, x => x.w);
      const realm = chosen ? chosen.r : rng.pick(this.realms);
      const city = this.cityById[rng.pick(realm.cities)];
      o.realm = realm.id; o.city = city.id;
      city.officers.push(o.id);
      const ru = this.officerById[realm.ruler];
      o.loyalty = Math.max(30, Math.min(100,
        Math.round(88 - compatDistance(o.compat, ru.compat) * 0.5 + o.virtue * 2 - o.ambition * 1.5 + rng.range(-8, 8))));
    }

    // ── 도시 병력/자원 ──
    for (const c of this.cities) {
      const owned = !!c.realm;
      c.troops = owned ? Math.round(c.pop * rng.range(3, 9) / 100) : Math.round(c.pop * rng.range(1, 3) / 100);
      c.train = rng.range(35, 78);
      c.morale = rng.range(45, 82);
      c.gold = rng.range(200, 1800);
      c.food = Math.round(c.troops * rng.range(18, 55));
    }
    // 중립 도시에 재야 군소 세력 무장 배치
    for (const c of this.cities.filter(x => !x.realm)) {
      const cnt = rng.range(0, 3);
      for (let i = 0; i < cnt; i++) {
        const o = generateOfficer(rng, { registry: this.world.registry, year: this.year });
        o.realm = null; o.city = c.id;
        this.officers.push(o); this.officerById[o.id] = o;
        this.freeOfficers.push(o.id);
      }
    }
    // 외교 초기화
    for (const a of this.realms) for (const b of this.realms) {
      if (a === b) continue;
      a.diplo[b.id] = rng.range(20, 60);
    }
  }

  seedItems() {
    const rng = this.rng;
    // 전설의 신물 — 매 게임 절반 정도만 등장
    const legends = rng.sample(LEGENDS, rng.range(Math.floor(LEGENDS.length * 0.4), LEGENDS.length));
    for (const def of legends) {
      const it = makeLegend(def);
      this.items.push(it);
      if (rng.percent(55)) {
        // 유력 무장이 소지
        const cand = this.officers.filter(o => !o.dead && o.realm && o.items.length < 3);
        const owner = cand.length ? rng.weighted(cand, o => power(o) ** 2) : null;
        if (owner) { owner.items.push(it.uid); it.owner = owner.id; }
        else { const c = rng.pick(this.cities); c.items.push(it.uid); it.city = c.id; }
      } else {
        const c = rng.pick(this.cities); c.items.push(it.uid); it.city = c.id;   // 숨겨진 보물
      }
    }
    // 일반 보물
    const n = Math.round(this.cities.length * rng.range(2, 4));
    for (let i = 0; i < n; i++) {
      const it = generateItem(rng, { maxRarity: 4 });
      this.items.push(it);
      if (rng.percent(45)) {
        const cand = this.officers.filter(o => !o.dead && o.items.length < 3);
        const owner = cand.length ? rng.weighted(cand, o => power(o)) : null;
        if (owner) { owner.items.push(it.uid); it.owner = owner.id; continue; }
      }
      const c = rng.pick(this.cities); c.items.push(it.uid); it.city = c.id;
    }
    this.itemById = Object.fromEntries(this.items.map(i => [i.uid, i]));
  }

  seedBonds() {
    const rng = this.rng;
    const alive = this.officers.filter(o => !o.dead);
    // 의형제 / 혈연 / 사제 / 원한
    const bondCount = Math.round(alive.length * 0.28);
    for (let i = 0; i < bondCount; i++) {
      const a = rng.pick(alive), b = rng.pick(alive);
      if (a === b || a.bonds[b.id]) continue;
      const kind = rng.weighted([
        { k: 'brother', w: 22, name: '의형제' }, { k: 'kin', w: 26, name: '혈연' },
        { k: 'master', w: 18, name: '사제' }, { k: 'friend', w: 24, name: '지기' },
        { k: 'hate', w: 20, name: '원한' }, { k: 'spouse', w: 8, name: '부부' },
      ], x => x.w);
      a.bonds[b.id] = kind.k; b.bonds[a.id] = kind.k === 'master' ? 'pupil' : kind.k;
      if (kind.k === 'kin' || kind.k === 'brother') {
        // 같은 성으로 통일하지는 않되, 상성을 가깝게
        b.compat = (a.compat + rng.range(-8, 8) + 150) % 150;
      }
      if (kind.k === 'hate') { a.nemesis = b.id; b.nemesis = a.id; }
    }
  }

  // ── 조회 ──────────────────────────────────────────────
  officersOf(realmId) { return this.officers.filter(o => !o.dead && o.realm === realmId && !o.prisoner); }
  citiesOf(realmId) { return this.cities.filter(c => c.realm === realmId); }
  officersIn(cityId) { return (this.cityById[cityId]?.officers || []).map(id => this.officerById[id]).filter(o => o && !o.dead); }
  ruler(realmId) { return this.officerById[this.realmById[realmId]?.ruler]; }
  itemsOf(o) { return o.items.map(u => this.itemById[u]).filter(Boolean); }

  /** 보물 보정을 포함한 실효 능력치 */
  eff(o) {
    const { mods, effects } = aggregateItems(this.itemsOf(o));
    return {
      lead: clampStat(o.lead + (mods.lead || 0)),
      war: clampStat(o.war + (mods.war || 0)),
      int: clampStat(o.int + (mods.int || 0)),
      pol: clampStat(o.pol + (mods.pol || 0)),
      cha: clampStat(o.cha + (mods.cha || 0)),
      fx: effects,
    };
  }

  hasTrait(o, id) { return o.traits.includes(id); }

  /** 세력 총 전력 평가 */
  realmPower(r) {
    let troops = 0, dev = 0;
    for (const cid of r.cities) {
      const c = this.cityById[cid];
      troops += c.troops; dev += c.agri + c.comm;
    }
    const offs = this.officersOf(r.id);
    const off = offs.reduce((s, o) => s + combatRating(o), 0);
    return Math.round(troops * 0.4 + dev * 0.25 + off * 1.2 + r.gold * 0.02);
  }

  pushLog(text, kind = 'info', extra = {}) {
    const e = { y: this.year, m: this.month, text, kind, ...extra };
    this.log.push(e);
    if (this.log.length > 900) this.log.splice(0, 300);
    return e;
  }

  get seasonName() { return SEASONS[this.month]; }
  get dateLabel() { return `${this.year}년 ${MONTH_NAMES[this.month]}`; }

  /** 명성에 따른 월간 명령 가능 수 (삼국지6의 명성 시스템 차용) */
  commandLimit(realm) {
    const base = 3 + Math.floor(realm.fame / 140);
    const cityBonus = Math.floor(realm.cities.length / 3);
    return Math.max(3, Math.min(24, base + cityBonus));
  }

  /** 세력 소멸 처리 */
  destroyRealm(r, byRealm = null) {
    if (r.dead) return;
    r.dead = true;
    this.pushLog(`《${r.name}》 세력이 멸망했다.`, 'realm-fall');
    const ruler = this.officerById[r.ruler];
    if (ruler && !ruler.dead) { ruler.realm = null; ruler.prisoner = false; }
    for (const o of this.officersOf(r.id)) { o.realm = null; o.corps = null; }
    if (this.playerRealm === r.id) this.gameOver = { win: false, reason: '세력이 멸망했다' };
  }
}

function clampStat(v) { return Math.max(1, Math.min(120, Math.round(v))); }

export { power, combatRating, aggregateItems, rankFor, compatDistance, TRAIT_BY_ID, APT_MULT, makeCorpsName };
