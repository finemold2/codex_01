// ============================================================
//  명령 — 무장 1인이 한 달에 하나씩 수행한다
// ============================================================
import { generateItem } from './itemgen.js';
import { generateOfficer } from './officergen.js';
import { compatDistance } from './traits.js';
import { removeFromCity } from './events.js';

const T = (o, id) => o.traits.includes(id);

/** 능력 → 효율 계수 */
function eff(stat, bonus = 0) { return (stat + bonus) / 100; }

export const COMMANDS = [
  // ── 내정 ──────────────────────────────────────────
  {
    id: 'farm', name: '개간', cat: 'gov', stat: 'pol', icon: '禾',
    desc: '농지를 일군다. 농업이 오르면 가을 수확이 늘어난다.',
    cost: (g, c) => ({ gold: 120 }),
    can: (g, c, o) => c.agri < c.maxAgri,
    run: (g, c, o) => {
      const e = g.eff(o);
      let v = Math.round((18 + e.pol * 0.9) * (T(o, 'farmer') ? 1.6 : 1) * g.rng.jitter(1, 0.3));
      v = Math.min(v, c.maxAgri - c.agri);
      c.agri += v; o.exp.pol += 12;
      return { text: `${o.name}이(가) ${c.name}의 전답을 넓혔다. 농업 +${v}`, ok: true, sfx: 'confirm' };
    },
  },
  {
    id: 'commerce', name: '상업', cat: 'gov', stat: 'pol', icon: '商',
    desc: '저잣거리를 키운다. 매달 금 수입이 늘어난다.',
    cost: () => ({ gold: 120 }),
    can: (g, c) => c.comm < c.maxComm,
    run: (g, c, o) => {
      const e = g.eff(o);
      let v = Math.round((18 + e.pol * 0.9) * (T(o, 'merchant') ? 1.6 : 1) * g.rng.jitter(1, 0.3));
      v = Math.min(v, c.maxComm - c.comm);
      c.comm += v; o.exp.pol += 12;
      return { text: `${o.name}이(가) ${c.name}의 상업을 일으켰다. 상업 +${v}`, ok: true, sfx: 'coin' };
    },
  },
  {
    id: 'flood', name: '치수', cat: 'gov', stat: 'pol', icon: '水',
    desc: '제방을 쌓는다. 수해를 막고 농지를 지킨다.',
    cost: () => ({ gold: 150 }),
    can: (g, c) => c.flood < c.maxFlood,
    run: (g, c, o) => {
      const e = g.eff(o);
      let v = Math.round((16 + (e.pol + e.int) * 0.45) * (T(o, 'engineer') ? 1.6 : 1) * g.rng.jitter(1, 0.3));
      v = Math.min(v, c.maxFlood - c.flood);
      c.flood += v; o.exp.pol += 10;
      return { text: `${o.name}이(가) ${c.name}에 제방을 쌓았다. 치수 +${v}`, ok: true, sfx: 'confirm' };
    },
  },
  {
    id: 'tech', name: '기술', cat: 'gov', stat: 'int', icon: '工',
    desc: '공방을 키운다. 무기와 공성 병기의 질이 오른다.',
    cost: () => ({ gold: 180 }),
    can: (g, c) => c.tech < c.maxTech,
    run: (g, c, o) => {
      const e = g.eff(o);
      let v = Math.round((14 + e.int * 0.9) * (T(o, 'artisan') ? 1.6 : 1) * g.rng.jitter(1, 0.3));
      v = Math.min(v, c.maxTech - c.tech);
      c.tech += v; o.exp.int += 12;
      return { text: `${o.name}이(가) ${c.name}의 공방을 정비했다. 기술 +${v}`, ok: true, sfx: 'seal' };
    },
  },
  {
    id: 'wall', name: '수복', cat: 'gov', stat: 'pol', icon: '城',
    desc: '성벽을 수리한다.',
    cost: () => ({ gold: 200 }),
    can: (g, c) => c.wall < c.maxWall,
    run: (g, c, o) => {
      const e = g.eff(o);
      let v = Math.round((90 + e.pol * 3.2 + c.tech * 0.05) * (T(o, 'builder') ? 2 : 1) * g.rng.jitter(1, 0.25));
      v = Math.min(v, c.maxWall - c.wall);
      c.wall += v; o.exp.pol += 8;
      return { text: `${o.name}이(가) ${c.name}의 성벽을 고쳤다. 성벽 +${v}`, ok: true, sfx: 'siege' };
    },
  },
  {
    id: 'inspect', name: '순찰', cat: 'gov', stat: 'cha', icon: '巡',
    desc: '거리를 돌며 민심과 치안을 다스린다.',
    cost: () => ({ gold: 60 }),
    can: () => true,
    run: (g, c, o) => {
      const e = g.eff(o);
      const a = Math.round((3 + e.cha * 0.13) * (T(o, 'sheriff') ? 1.6 : 1) * g.rng.jitter(1, 0.25));
      const b = Math.round((2 + e.cha * 0.10) * (T(o, 'famed') ? 1.6 : 1) * g.rng.jitter(1, 0.25));
      c.order = Math.min(100, c.order + a);
      c.loyalty = Math.min(100, c.loyalty + b);
      o.exp.cha += 10;
      return { text: `${o.name}이(가) ${c.name}을(를) 순찰했다. 치안 +${a}, 민심 +${b}`, ok: true, sfx: 'confirm' };
    },
  },
  {
    id: 'relief', name: '시혜', cat: 'gov', stat: 'cha', icon: '恤',
    desc: '창고를 열어 백성을 구휼한다. 민심이 크게 오른다.',
    cost: (g, c) => ({ food: Math.max(500, Math.round(c.pop * 0.02)) }),
    can: (g, c) => c.food > Math.max(500, Math.round(c.pop * 0.02)),
    run: (g, c, o) => {
      const e = g.eff(o);
      const v = Math.round((5 + e.cha * 0.16) * g.rng.jitter(1, 0.2));
      c.loyalty = Math.min(100, c.loyalty + v);
      c.pop = Math.round(c.pop * 1.01);
      o.fame += 6; o.exp.cha += 14;
      return { text: `${o.name}이(가) ${c.name}에 곡식을 풀었다. 민심 +${v}`, ok: true, sfx: 'cheer' };
    },
  },

  // ── 군사 ──────────────────────────────────────────
  {
    id: 'draft', name: '징병', cat: 'mil', stat: 'cha', icon: '徵',
    desc: '백성을 병사로 모은다. 민심이 떨어진다.',
    cost: (g, c) => ({ gold: 250 }),
    can: (g, c) => c.pop > 12000 && c.troops < c.pop * 0.28,
    run: (g, c, o) => {
      const e = g.eff(o);
      const base = Math.round(c.pop * (0.009 + (e.cha / 100) * 0.022) * (c.loyalty / 100));
      const v = Math.round(base * (T(o, 'recruiter') ? 1.5 : 1) * g.rng.jitter(1, 0.25));
      c.troops += v; c.pop -= Math.round(v * 0.9);
      const drop = Math.round((T(o, 'recruiter') ? 3 : 6) * g.rng.jitter(1, 0.3));
      c.loyalty = Math.max(0, c.loyalty - drop);
      c.train = Math.max(0, Math.round(c.train * (c.troops - v) / Math.max(1, c.troops)));
      o.exp.cha += 8;
      return { text: `${o.name}이(가) ${c.name}에서 ${v.toLocaleString()}명을 징집했다. 민심 -${drop}`, ok: true, sfx: 'warDrum' };
    },
  },
  {
    id: 'train', name: '훈련', cat: 'mil', stat: 'lead', icon: '練',
    desc: '병사를 조련한다. 훈련도와 사기가 오른다.',
    cost: (g, c) => ({ gold: 150, food: Math.round(c.troops * 0.4) }),
    can: (g, c) => c.troops > 200 && c.train < 100,
    run: (g, c, o) => {
      const e = g.eff(o);
      const v = Math.round((4 + e.lead * 0.12) * (T(o, 'drill') ? 1.8 : 1) * g.rng.jitter(1, 0.2));
      c.train = Math.min(100, c.train + v);
      c.morale = Math.min(100, c.morale + Math.round(v * 0.5));
      o.exp.lead += 14;
      return { text: `${o.name}이(가) ${c.name}의 병사를 조련했다. 훈련 +${v}`, ok: true, sfx: 'drum' };
    },
  },
  {
    id: 'rally', name: '고무', cat: 'mil', stat: 'cha', icon: '鼓',
    desc: '군을 격려해 사기를 끌어올린다.',
    cost: (g, c) => ({ gold: 100, food: Math.round(c.troops * 0.2) }),
    can: (g, c) => c.troops > 100 && c.morale < 100,
    run: (g, c, o) => {
      const e = g.eff(o);
      const v = Math.round((5 + e.cha * 0.15) * (T(o, 'rally') ? 2 : 1) * g.rng.jitter(1, 0.2));
      c.morale = Math.min(100, c.morale + v);
      o.exp.cha += 10;
      return { text: `${o.name}이(가) 삼군을 고무했다. 사기 +${v}`, ok: true, sfx: 'horn' };
    },
  },

  // ── 인사 ──────────────────────────────────────────
  {
    id: 'recruit', name: '등용', cat: 'per', stat: 'cha', icon: '登',
    desc: '이 도시의 재야 인재를 부른다. 설전으로 이어질 수 있다.',
    cost: () => ({ gold: 200 }),
    can: (g, c) => g.officersIn(c.id).some(o => !o.realm && !o.dead && o.age >= 15),
    needsTarget: 'freeOfficer',
    run: (g, c, o, target) => {
      const t = target || g.officersIn(c.id).find(x => !x.realm && x.age >= 15);
      if (!t) return { text: '등용할 인재가 없다.', ok: false, sfx: 'error' };
      const e = g.eff(o), realm = g.realmById[o.realm];
      const ruler = g.officerById[realm.ruler];
      let p = 26
        + (e.cha - t.int * 0.35) * 0.55
        + (75 - compatDistance(t.compat, ruler.compat)) * 0.55
        + realm.fame * 0.035
        + (T(o, 'headhunt') ? 25 : 0)
        + (e.fx.recruit || 0)
        - t.ambition * 2.2
        + t.virtue * 0.8;
      if (t.personality === 'reclusive') p -= 22;
      if (t.bonds[o.id]) p += 30;
      for (const [bid, k] of Object.entries(t.bonds)) {
        const b = g.officerById[bid];
        if (b && !b.dead && b.realm === o.realm && (k === 'brother' || k === 'kin' || k === 'friend')) p += 18;
      }
      p = Math.max(4, Math.min(94, p));
      if (g.rng.percent(p)) {
        removeFromCity(g, t);
        t.realm = o.realm; t.city = c.id; c.officers.push(t.id);
        t.loyalty = Math.max(35, Math.min(100, Math.round(62 + (75 - compatDistance(t.compat, ruler.compat)) * 0.4 + g.rng.range(-8, 12))));
        o.fame += 12; o.exp.cha += 18;
        return { text: `${o.name}의 청에 ${t.name}(${t.courtesy})이(가) 응했다. 《${realm.name}》에 출사한다.`,
          ok: true, sfx: 'levelup', bgm: 'person', focus: t.id, recruited: t.id };
      }
      t.recruitCooldown = (t.recruitCooldown || 0) + 1;
      return { text: `${t.name}은(는) ${o.name}의 청을 정중히 거절했다. (성공률 ${Math.round(p)}%)`,
        ok: true, sfx: 'cancel', focus: t.id };
    },
  },
  {
    id: 'search', name: '탐색', cat: 'per', stat: 'int', icon: '探',
    desc: '주변을 뒤져 인재나 보물을 찾는다.',
    cost: () => ({ gold: 150 }),
    can: () => true,
    run: (g, c, o) => {
      const e = g.eff(o);
      let p = 22 + e.int * 0.28 + (T(o, 'explorer') ? 25 : 0) + (c.famous ? 12 : 0)
        + (c.resource?.id === 'jade' ? 15 : 0);
      o.exp.int += 8;
      if (!g.rng.percent(Math.min(88, p))) {
        return { text: `${o.name}이(가) ${c.name} 근방을 뒤졌으나 아무것도 찾지 못했다.`, ok: true, sfx: 'cancel' };
      }
      // 인재 / 보물 / 병량 / 금
      const roll = g.rng.weighted([
        { k: 'person', w: 34 }, { k: 'item', w: 30 }, { k: 'gold', w: 20 }, { k: 'food', w: 16 },
      ], x => x.w).k;
      if (roll === 'person') {
        const t = generateOfficer(g.rng, {
          registry: g.world.registry, year: g.year,
          quality: Math.min(1, Math.max(0.1, g.rng.gauss(0.42 + e.int * 0.0022, 0.18))),
          ageRange: [16, 52],
        });
        t.realm = null; t.city = c.id;
        g.officers.push(t); g.officerById[t.id] = t; g.freeOfficers.push(t.id);
        return { text: `${o.name}이(가) ${c.name}에서 재야의 ${t.name}(${t.courtesy})을(를) 찾아냈다!`,
          ok: true, sfx: 'confirm', bgm: 'person', focus: t.id };
      }
      if (roll === 'item') {
        const it = generateItem(g.rng, {
          minRarity: c.resource?.id === 'jade' ? 2 : 0,
          maxRarity: 4, powerScale: 1 + e.int * 0.004,
        });
        g.items.push(it); g.itemById[it.uid] = it; c.items.push(it.uid); it.city = c.id;
        return { text: `${o.name}이(가) 「${it.name}」(${it.rarityName})을(를) 발견했다!`, ok: true, sfx: 'treasure', item: it.uid };
      }
      if (roll === 'gold') {
        const v = g.rng.range(200, 1600);
        c.gold += v;
        return { text: `${o.name}이(가) 숨겨진 재물 ${v}금을 찾아냈다.`, ok: true, sfx: 'coin' };
      }
      const v = g.rng.range(800, 5000);
      c.food += v;
      return { text: `${o.name}이(가) 묻어둔 곡식 ${v.toLocaleString()}을 찾아냈다.`, ok: true, sfx: 'coin' };
    },
  },
  {
    id: 'reward', name: '포상', cat: 'per', stat: 'pol', icon: '賞',
    desc: '금을 내려 무장의 충성을 산다.',
    cost: () => ({ gold: 400 }),
    can: (g, c) => g.officersIn(c.id).some(o => o.realm && o.loyalty < 100),
    needsTarget: 'ownOfficer',
    run: (g, c, o, target) => {
      const t = target || g.officersIn(c.id).filter(x => x.realm === o.realm).sort((a, b) => a.loyalty - b.loyalty)[0];
      if (!t) return { text: '포상할 무장이 없다.', ok: false, sfx: 'error' };
      const e = g.eff(o);
      const v = Math.round((5 + e.pol * 0.13) * g.rng.jitter(1, 0.25) * (1 - t.greed / 100));
      t.loyalty = Math.min(100, t.loyalty + v);
      return { text: `${t.name}에게 상을 내렸다. 충성 +${v}`, ok: true, sfx: 'coin', focus: t.id };
    },
  },

  // ── 계략 ──────────────────────────────────────────
  {
    id: 'rumor', name: '유언비어', cat: 'ploy', stat: 'int', icon: '謠',
    desc: '적 도시에 헛소문을 퍼뜨려 민심과 치안을 흔든다.',
    cost: () => ({ gold: 400 }),
    can: (g, c, o) => adjacentEnemyCities(g, c, o).length > 0,
    needsTarget: 'enemyCity',
    run: (g, c, o, target) => {
      const t = target || g.rng.pick(adjacentEnemyCities(g, c, o));
      if (!t) return { text: '대상이 없다.', ok: false, sfx: 'error' };
      const e = g.eff(o);
      const guard = bestGuard(g, t);
      let p = 30 + e.int * 0.5 - guard * 0.3 + (T(o, 'rumor') ? 25 : 0) + (e.fx.ployRate || 0);
      p = Math.max(5, Math.min(92, p));
      o.exp.int += 12;
      if (!g.rng.percent(p)) return { text: `${o.name}의 유언비어가 ${t.name}에서 간파되었다.`, ok: true, sfx: 'cancel' };
      const m = T(o, 'rumor') ? 2 : 1;
      const a = Math.round(g.rng.range(6, 18) * m), b = Math.round(g.rng.range(5, 15) * m);
      t.loyalty = Math.max(0, t.loyalty - a);
      t.order = Math.max(0, t.order - b);
      return { text: `${t.name}에 흉흉한 소문이 돌았다. 민심 -${a}, 치안 -${b}`, ok: true, sfx: 'crowd', bgm: 'scheme', cityId: t.id };
    },
  },
  {
    id: 'discord', name: '이간계', cat: 'ploy', stat: 'int', icon: '離',
    desc: '적 무장과 그 군주를 갈라놓는다.',
    cost: () => ({ gold: 900 }),
    can: (g, c, o) => enemyOfficersNear(g, c, o).length > 0,
    needsTarget: 'enemyOfficer',
    run: (g, c, o, target) => {
      const t = target || g.rng.pick(enemyOfficersNear(g, c, o));
      if (!t) return { text: '대상이 없다.', ok: false, sfx: 'error' };
      if (T(t, 'loyalist')) return { text: `${t.name}은(는) 흔들리지 않았다. 충의가 굳다.`, ok: true, sfx: 'cancel', focus: t.id };
      const e = g.eff(o), te = g.eff(t);
      let p = 24 + (e.int - te.int) * 0.6 + (T(o, 'discord') ? 40 : 0) + (100 - t.loyalty) * 0.35
        + t.ambition * 1.6 - (te.fx.ployGuard || 0) + (e.fx.ployRate || 0);
      if (T(t, 'insight')) p -= 30;
      p = Math.max(4, Math.min(90, p));
      o.exp.int += 16;
      if (!g.rng.percent(p)) return { text: `${t.name}이(가) ${o.name}의 이간계를 간파했다.`, ok: true, sfx: 'cancel', focus: t.id };
      const drop = g.rng.range(12, 34);
      t.loyalty = Math.max(0, t.loyalty - drop);
      return { text: `${t.name}이(가) 주군을 의심하기 시작했다. 충성 -${drop}`, ok: true, sfx: 'debate', bgm: 'scheme', focus: t.id };
    },
  },
  {
    id: 'bribe', name: '매수', cat: 'ploy', stat: 'pol', icon: '賂',
    desc: '금으로 적 무장을 빼돌린다.',
    cost: () => ({ gold: 1800 }),
    can: (g, c, o) => enemyOfficersNear(g, c, o).length > 0,
    needsTarget: 'enemyOfficer',
    run: (g, c, o, target) => {
      const t = target || g.rng.pick(enemyOfficersNear(g, c, o));
      if (!t) return { text: '대상이 없다.', ok: false, sfx: 'error' };
      if (T(t, 'loyalist')) return { text: `${t.name}은(는) 재물에 흔들리지 않는다.`, ok: true, sfx: 'cancel', focus: t.id };
      const e = g.eff(o);
      let p = 12 + (100 - t.loyalty) * 0.55 + t.greed * 0.6 + t.ambition * 1.5
        + e.pol * 0.25 + (T(o, 'bribe') ? 22 : 0) - t.virtue * 2.2;
      p = Math.max(2, Math.min(85, p));
      o.exp.pol += 12;
      if (!g.rng.percent(p)) return { text: `${t.name}이(가) ${o.name}의 뇌물을 뿌리쳤다.`, ok: true, sfx: 'cancel', focus: t.id };
      const from = g.realmById[t.realm];
      removeFromCity(g, t);
      t.realm = o.realm; t.city = c.id; c.officers.push(t.id);
      t.loyalty = g.rng.range(40, 62);
      return { text: `${t.name}이(가) 《${from?.name ?? '적'}》을(를) 등지고 넘어왔다!`,
        ok: true, sfx: 'coin', bgm: 'scheme', focus: t.id };
    },
  },
  {
    id: 'incite', name: '선동', cat: 'ploy', stat: 'cha', icon: '煽',
    desc: '적 도시의 백성을 부추겨 봉기를 일으킨다.',
    cost: () => ({ gold: 700 }),
    can: (g, c, o) => adjacentEnemyCities(g, c, o).length > 0,
    needsTarget: 'enemyCity',
    run: (g, c, o, target) => {
      const t = target || g.rng.pick(adjacentEnemyCities(g, c, o));
      if (!t) return { text: '대상이 없다.', ok: false, sfx: 'error' };
      const e = g.eff(o);
      let p = 20 + e.cha * 0.4 + (100 - t.loyalty) * 0.5 + (T(o, 'incite') ? 28 : 0) - bestGuard(g, t) * 0.25;
      p = Math.max(4, Math.min(88, p));
      o.exp.cha += 12;
      if (!g.rng.percent(p)) return { text: `${t.name}의 관리들이 ${o.name}의 선동을 막았다.`, ok: true, sfx: 'cancel' };
      const lost = Math.round(t.troops * g.rng.range(4, 14) / 100);
      t.troops = Math.max(0, t.troops - lost);
      t.order = Math.max(0, t.order - g.rng.range(10, 26));
      t.loyalty = Math.max(0, t.loyalty - g.rng.range(6, 16));
      return { text: `${t.name}에서 민란이 일었다! 적 병력 -${lost.toLocaleString()}, 치안 급락`,
        ok: true, sfx: 'crowd', bgm: 'scheme', cityId: t.id };
    },
  },
  {
    id: 'sabotage', name: '방화', cat: 'ploy', stat: 'int', icon: '火',
    desc: '적 도시의 병량고에 불을 지른다.',
    cost: () => ({ gold: 800 }),
    can: (g, c, o) => adjacentEnemyCities(g, c, o).length > 0,
    needsTarget: 'enemyCity',
    run: (g, c, o, target) => {
      const t = target || g.rng.pick(adjacentEnemyCities(g, c, o));
      if (!t) return { text: '대상이 없다.', ok: false, sfx: 'error' };
      const e = g.eff(o);
      let p = 18 + e.int * 0.45 + (T(o, 'sabotage') ? 28 : 0) + (T(o, 'firelord') ? 18 : 0)
        - bestGuard(g, t) * 0.3 + (100 - t.order) * 0.2;
      p = Math.max(3, Math.min(85, p));
      o.exp.int += 14;
      if (!g.rng.percent(p)) {
        if (g.rng.percent(30)) { o.injury += g.rng.range(10, 40); return { text: `${o.name}의 방화가 발각되어 부상을 입고 돌아왔다.`, ok: true, sfx: 'error', focus: o.id }; }
        return { text: `${o.name}의 방화가 실패했다.`, ok: true, sfx: 'cancel' };
      }
      const burn = Math.round(t.food * g.rng.range(20, 55) / 100);
      t.food = Math.max(0, t.food - burn);
      t.morale = Math.max(0, t.morale - g.rng.range(5, 15));
      return { text: `${t.name}의 병량고가 불탔다! 병량 -${burn.toLocaleString()}`, ok: true, sfx: 'fire', bgm: 'scheme', cityId: t.id };
    },
  },
  {
    id: 'spy', name: '첩보', cat: 'ploy', stat: 'int', icon: '諜',
    desc: '적 세력의 내부를 살핀다. 정보가 드러난다.',
    cost: () => ({ gold: 300 }),
    can: (g, c, o) => adjacentEnemyCities(g, c, o).length > 0,
    needsTarget: 'enemyCity',
    run: (g, c, o, target) => {
      const t = target || g.rng.pick(adjacentEnemyCities(g, c, o));
      if (!t) return { text: '대상이 없다.', ok: false, sfx: 'error' };
      const e = g.eff(o);
      const p = Math.min(96, 40 + e.int * 0.5 + (T(o, 'spy') ? 45 : 0));
      o.exp.int += 8;
      if (!g.rng.percent(p)) return { text: `${o.name}의 세작이 ${t.name}에서 붙잡혔다.`, ok: true, sfx: 'cancel' };
      t.spied = g.turnNo + 12;
      return { text: `${t.name}의 내정이 낱낱이 드러났다. (병력 ${t.troops.toLocaleString()}, 병량 ${t.food.toLocaleString()}, 성벽 ${t.wall})`,
        ok: true, sfx: 'scroll', cityId: t.id, reveal: true };
    },
  },
];

export const COMMAND_BY_ID = Object.fromEntries(COMMANDS.map(c => [c.id, c]));

// ------------------------------------------------------------------
export function adjacentEnemyCities(g, c, o) {
  const out = [];
  for (const l of [...c.links, ...c.seaLinks]) {
    const t = g.cityById[l.to];
    if (t && t.realm !== o.realm) out.push(t);
  }
  return out;
}

export function enemyOfficersNear(g, c, o) {
  const out = [];
  for (const t of adjacentEnemyCities(g, c, o)) {
    for (const x of g.officersIn(t.id)) {
      if (x.realm && x.realm !== o.realm && g.realmById[x.realm]?.ruler !== x.id) out.push(x);
    }
  }
  return out;
}

function bestGuard(g, city) {
  const offs = g.officersIn(city.id);
  if (!offs.length) return 0;
  return Math.max(...offs.map(o => o.int + (o.traits.includes('insight') ? 30 : 0)));
}

/** 명령 실행 — 비용 검사 포함 */
export function execCommand(g, cmdId, officer, city, target) {
  const cmd = COMMAND_BY_ID[cmdId];
  if (!cmd) return { ok: false, text: '알 수 없는 명령' };
  if (officer.injury > 60) return { ok: false, text: `${officer.name}은(는) 부상으로 움직일 수 없다.`, sfx: 'error' };
  if (cmd.can && !cmd.can(g, city, officer)) return { ok: false, text: '지금은 할 수 없다.', sfx: 'error' };
  const cost = cmd.cost ? cmd.cost(g, city, officer) : {};
  const realm = g.realmById[officer.realm];
  if (cost.gold && realm.gold < cost.gold) return { ok: false, text: `금이 부족하다. (${cost.gold} 필요)`, sfx: 'error' };
  if (cost.food && city.food < cost.food) return { ok: false, text: `병량이 부족하다. (${cost.food} 필요)`, sfx: 'error' };
  if (cost.gold) realm.gold -= cost.gold;
  if (cost.food) city.food -= cost.food;
  const res = cmd.run(g, city, officer, target) || { ok: false, text: '아무 일도 없었다.' };
  officer.status = 'acted';
  officer.fatigue = Math.min(100, officer.fatigue + 12);
  return res;
}
