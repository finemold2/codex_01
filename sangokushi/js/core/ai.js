// ============================================================
//  세력 AI — 성향(패도/왕도/권모/수성/유격/중용)에 따라
//  내정·군사·계략·외교를 스스로 판단한다.
// ============================================================
import { COMMAND_BY_ID, execCommand, adjacentEnemyCities, enemyOfficersNear } from './commands.js';
import { AI_STYLES } from './state.js';
import { combatRating } from './officergen.js';

const STYLE = Object.fromEntries(AI_STYLES.map(s => [s.id, s]));

/** 도시의 개발 필요도 (0~1, 높을수록 급하다) */
function needScore(c) {
  return {
    farm: 1 - c.agri / Math.max(1, c.maxAgri),
    commerce: 1 - c.comm / Math.max(1, c.maxComm),
    flood: (1 - c.flood / Math.max(1, c.maxFlood)) * (c.riverside ? 1.2 : 0.4),
    tech: 1 - c.tech / Math.max(1, c.maxTech),
    wall: 1 - c.wall / Math.max(1, c.maxWall),
    inspect: Math.max(0, (70 - c.order) / 70),
    relief: Math.max(0, (60 - c.loyalty) / 60),
    train: Math.max(0, (85 - c.train) / 85) * (c.troops > 500 ? 1 : 0.2),
    rally: Math.max(0, (80 - c.morale) / 80) * (c.troops > 500 ? 1 : 0.2),
    draft: Math.max(0, 1 - c.troops / Math.max(1, c.pop * 0.15)),
  };
}

/** 무장이 어떤 명령에 어울리는가 */
function fitness(g, o, cmdId) {
  const e = g.eff(o);
  const map = {
    farm: e.pol + (o.traits.includes('farmer') ? 40 : 0),
    commerce: e.pol + (o.traits.includes('merchant') ? 40 : 0),
    flood: (e.pol + e.int) / 2 + (o.traits.includes('engineer') ? 40 : 0),
    tech: e.int + (o.traits.includes('artisan') ? 40 : 0),
    wall: e.pol + (o.traits.includes('builder') ? 40 : 0),
    inspect: e.cha + (o.traits.includes('sheriff') ? 40 : 0),
    relief: e.cha,
    train: e.lead + (o.traits.includes('drill') ? 40 : 0),
    rally: e.cha + (o.traits.includes('rally') ? 40 : 0),
    draft: e.cha + (o.traits.includes('recruiter') ? 40 : 0),
    recruit: e.cha + (o.traits.includes('headhunt') ? 40 : 0),
    search: e.int + (o.traits.includes('explorer') ? 40 : 0),
    reward: e.pol,
    rumor: e.int + (o.traits.includes('rumor') ? 40 : 0),
    discord: e.int + (o.traits.includes('discord') ? 50 : 0),
    bribe: e.pol + (o.traits.includes('bribe') ? 40 : 0),
    incite: e.cha + (o.traits.includes('incite') ? 40 : 0),
    sabotage: e.int + (o.traits.includes('sabotage') ? 40 : 0),
    spy: e.int + (o.traits.includes('spy') ? 50 : 0),
  };
  return map[cmdId] ?? 40;
}

/** 세력 한 곳의 한 달 행동 */
export function runRealmAI(g, realm, hooks = {}) {
  if (realm.dead || realm.isPlayer) return [];
  const st = STYLE[realm.aiStyle] || STYLE.balanced;
  const rng = g.rng;
  const logs = [];
  const cities = g.citiesOf(realm.id);
  if (!cities.length) return logs;

  // ── 1. 전략 판단 ──
  const myPower = g.realmPower(realm);
  const targets = [];
  for (const c of cities) {
    for (const t of adjacentEnemyCities(g, c, { realm: realm.id })) {
      if (realm.truce[t.realm] > g.turnNo) continue;
      if (realm.ally[t.realm] > g.turnNo) continue;
      const tr = t.realm ? g.realmById[t.realm] : null;
      const defOff = g.officersIn(t.id);
      const defPow = t.troops * (1 + t.train / 150) * (1 + t.wall / 12000)
        + defOff.reduce((s, o) => s + combatRating(o), 0) * 6;
      const atkOff = g.officersIn(c.id).filter(o => o.realm === realm.id && o.injury < 40);
      const atkPow = c.troops * (1 + c.train / 150) * (1 + c.morale / 200)
        + atkOff.reduce((s, o) => s + combatRating(o), 0) * 6;
      const ratio = atkPow / Math.max(1, defPow);
      let score = (ratio - 1) * 100 * st.aggr;
      if (!tr) score += 45;                                  // 중립 도시는 먹기 쉽다
      if (tr && tr.isPlayer) score += 8;
      score += (60 - t.loyalty) * 0.35;
      score -= t.wall / 90;
      if (c.troops < 3000) score -= 60;
      if (c.food < c.troops * 12) score -= 80;
      score += rng.range(-22, 22);
      targets.push({ from: c, to: t, score, ratio, atkOff });
    }
  }
  targets.sort((a, b) => b.score - a.score);
  const best = targets[0];

  // ── 2. 출진 ──
  let attacked = null;
  if (best && best.score > 26 && best.atkOff.length && best.from.troops > 2500) {
    const lead = best.atkOff.slice().sort((a, b) => combatRating(b) - combatRating(a));
    const squad = lead.slice(0, Math.min(5, Math.max(1, Math.round(1 + rng.int(4)))));
    const send = Math.round(best.from.troops * (0.45 + rng.next() * 0.4));
    const food = Math.min(best.from.food, Math.round(send * rng.range(20, 40)));
    if (send > 800 && food > send * 8) {
      attacked = {
        realm: realm.id, from: best.from.id, to: best.to.id,
        officers: squad.map(o => o.id), troops: send, food,
      };
      best.from.troops -= send;
      best.from.food -= food;
      for (const o of squad) o.status = 'march';
    }
  }

  // ── 3. 명령 배분 ──
  for (const c of cities) {
    const need = needScore(c);
    const offs = g.officersIn(c.id).filter(o =>
      o.realm === realm.id && o.status !== 'march' && o.status !== 'acted' && o.injury < 60 && o.age >= 15);
    for (const o of offs) {
      const cand = [];
      for (const [id, n] of Object.entries(need)) {
        const cmd = COMMAND_BY_ID[id];
        if (!cmd || (cmd.can && !cmd.can(g, c, o))) continue;
        let w = n * 100 * (cmd.cat === 'gov' ? st.dev : 1);
        w *= 0.4 + fitness(g, o, id) / 120;
        cand.push({ id, w });
      }
      // 인재·계략
      if (COMMAND_BY_ID.recruit.can(g, c, o)) {
        // 무장이 부족할수록 등용에 매달린다
        const myOff = g.officersOf(realm.id).length;
        const hunger = Math.max(1, (realm.cities.length * 3 + 4) / Math.max(1, myOff));
        cand.push({ id: 'recruit', w: 90 * hunger * (0.4 + fitness(g, o, 'recruit') / 120) });
      }
      if (rng.percent(30)) cand.push({ id: 'search', w: 26 * (0.4 + fitness(g, o, 'search') / 120) });
      const lowLoyal = g.officersIn(c.id).some(x => x.realm === realm.id && x.loyalty < 62);
      if (lowLoyal) cand.push({ id: 'reward', w: 48 });
      for (const pid of ['rumor', 'discord', 'bribe', 'incite', 'sabotage', 'spy']) {
        const cmd = COMMAND_BY_ID[pid];
        if (cmd.can && cmd.can(g, c, o)) {
          cand.push({ id: pid, w: 30 * st.ploy * (0.3 + fitness(g, o, pid) / 110) });
        }
      }
      if (!cand.length) continue;
      const pick = rng.weighted(cand, x => Math.max(0.1, x.w));
      if (!pick) continue;
      const cmd = COMMAND_BY_ID[pick.id];
      const cost = cmd.cost ? cmd.cost(g, c, o) : {};
      if ((cost.gold || 0) > realm.gold * 0.55) continue;
      const res = execCommand(g, pick.id, o, c, pickTarget(g, pick.id, c, o));
      if (res.ok) logs.push({ realm: realm.id, ...res });
    }
  }

  // ── 4. 외교 ──
  if (rng.percent(10 * st.diplo)) {
    const others = g.realms.filter(r => !r.dead && r !== realm);
    if (others.length) {
      const t = rng.pick(others);
      const strong = g.realmPower(t) > myPower * 1.35;
      if (strong && rng.percent(55)) {
        const months = rng.range(6, 24);
        realm.truce[t.id] = g.turnNo + months; t.truce[realm.id] = g.turnNo + months;
        realm.diplo[t.id] = Math.min(100, (realm.diplo[t.id] || 30) + 15);
        logs.push({ text: `《${realm.name}》과 《${t.name}》이(가) 정전에 합의했다.`, kind: 'diplo' });
      }
    }
  }

  return attacked ? [...logs, { attack: attacked }] : logs;
}

function pickTarget(g, cmdId, city, officer) {
  const rng = g.rng;
  if (cmdId === 'recruit') {
    const cand = g.officersIn(city.id).filter(o => !o.realm && !o.dead && o.age >= 15);
    return cand.length ? cand.sort((a, b) =>
      (b.lead + b.war + b.int + b.pol + b.cha) - (a.lead + a.war + a.int + a.pol + a.cha))[0] : null;
  }
  if (cmdId === 'reward') {
    const cand = g.officersIn(city.id).filter(o => o.realm === officer.realm && o.loyalty < 100);
    return cand.length ? cand.sort((a, b) => a.loyalty - b.loyalty)[0] : null;
  }
  if (['rumor', 'incite', 'sabotage', 'spy'].includes(cmdId)) {
    const cand = adjacentEnemyCities(g, city, officer);
    return cand.length ? rng.pick(cand) : null;
  }
  if (['discord', 'bribe'].includes(cmdId)) {
    const cand = enemyOfficersNear(g, city, officer);
    return cand.length ? cand.sort((a, b) => a.loyalty - b.loyalty)[0] : null;
  }
  return null;
}
