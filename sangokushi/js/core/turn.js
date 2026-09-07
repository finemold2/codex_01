// ============================================================
//  월간 턴 처리 — 수입 · 소모 · 이벤트 · AI · 전투 · 노화
// ============================================================
import { rollEvents, killOfficer, removeFromCity, succeed } from './events.js';
import { runRealmAI } from './ai.js';
import { autoResolve, Battle } from './battle.js';
import { ageOfficer, deathRoll, combatRating } from './officergen.js';
import { rankFor, compatDistance } from './traits.js';
import { generateOfficer } from './officergen.js';

/** 도시의 월간 금 수입 */
export function cityIncome(g, c) {
  let gold = Math.round(c.comm * 0.9 * (c.order / 100) * (0.7 + c.loyalty / 300));
  if (c.resource?.id === 'salt') gold = Math.round(gold * 1.2);
  if (c.resource?.id === 'silk') gold = Math.round(gold * 1.15);
  return gold;
}

/** 가을 수확량 */
export function cityHarvest(g, c) {
  //  개간한 만큼 거두어 한 해를 난다. 병사 하나가 한 달에 0.4를 먹으므로
  //  농업 수치의 약 130배가 그 해의 소출이 된다.
  let food = Math.round(c.agri * 130 * (0.55 + c.loyalty / 250) * (0.6 + c.flood / Math.max(1, c.maxFlood) * 0.6));
  if (c.resource?.id === 'rice') food = Math.round(food * 1.25);
  return food;
}

/** 도시 유지비(병량 소모) */
export function cityUpkeep(g, c) {
  const offs = g.officersIn(c.id).filter(o => o.realm === c.realm);
  return {
    food: Math.round(c.troops * 0.4 + offs.length * 30),
    gold: Math.round(offs.length * 20 + c.troops * 0.006),
  };
}

/**
 * 한 달을 진행한다.
 * @param {Game} g
 * @param {object} hooks { onBattle(setup) → 'interactive'|null, onLog(entry) }
 * @returns {object} 이 달에 일어난 일들
 */
export function advanceMonth(g, hooks = {}) {
  const rng = g.rng;
  const report = { logs: [], events: [], battles: [], deaths: [], playerBattle: null };
  g.turnNo++;

  // ── 1. 정월 처리: 노화·성장·사망 ──
  if (g.month === 0) {
    for (const o of g.officers) {
      if (o.dead) continue;
      ageOfficer(o, rng, g.year);
      if (o.age >= 15 && deathRoll(o, rng)) {
        const isRuler = g.realmById[o.realm]?.ruler === o.id;
        killOfficer(g, o, '병사');
        report.deaths.push(o.id);
        report.logs.push(g.pushLog(
          `${o.name}이(가) ${o.age}세로 세상을 떠났다.`, isRuler ? 'ruler-death' : 'death', { officer: o.id }));
      }
    }
    // 성인이 된 자녀는 재야로 등록
    for (const o of g.officers) {
      if (!o.dead && o.age === 15 && !o.realm && !g.freeOfficers.includes(o.id)) g.freeOfficers.push(o.id);
    }
    // 새 인재 유입 — 재야가 넘치면 자제한다
    const freeNow = g.officers.filter(o => !o.dead && !o.realm && o.age >= 15).length;
    const glut = freeNow > g.cities.length * 1.6;
    const newcomers = glut ? 0 : rng.range(1, 2 + Math.floor(g.cities.length / 22));
    for (let i = 0; i < newcomers; i++) {
      const o = generateOfficer(rng, { registry: g.world.registry, year: g.year, ageRange: [16, 30] });
      o.realm = null; o.city = rng.pick(g.cities).id;
      g.officers.push(o); g.officerById[o.id] = o; g.freeOfficers.push(o.id);
    }
  }

  // ── 2. 수입·소모 ──
  for (const r of g.realms) {
    if (r.dead) continue;
    let gold = 0, food = 0, upG = 0, upF = 0;
    for (const cid of r.cities) {
      const c = g.cityById[cid];
      gold += cityIncome(g, c);
      if (g.month === 8) { const h = cityHarvest(g, c); c.food += h; food += h; }
      const up = cityUpkeep(g, c);
      upF += up.food; upG += up.gold;
      c.food = Math.max(0, c.food - up.food);
    }
    const ruler = g.officerById[r.ruler];
    const auditor = g.officersOf(r.id).some(o => o.traits.includes('auditor'));
    if (auditor) upG = Math.round(upG * 0.85);
    r.gold = Math.max(0, r.gold + gold - upG);
    r.income = gold - upG;
    // 명성 자연 증가/감소
    const fameDrift = Math.round(r.cities.length * 0.9 + (ruler ? ruler.cha / 30 : 0) - 1);
    r.fame = Math.max(0, r.fame + fameDrift);
    if (ruler) { ruler.fame += Math.max(0, Math.round(fameDrift * 0.4)); ruler.rankLv = rankFor(ruler.fame).lv; }
  }

  // ── 3. 도시 자연 변동 ──
  for (const c of g.cities) {
    const owned = !!c.realm;
    const offs = g.officersIn(c.id).filter(o => o.realm === c.realm);
    const famed = offs.some(o => o.traits.includes('famed'));
    // 인구
    const growth = (c.loyalty - 45) * 0.0004 + (c.order - 45) * 0.0003 + 0.002;
    c.pop = Math.max(3000, Math.min(c.maxPop, Math.round(c.pop * (1 + growth))));
    // 치안·민심 표류
    const drift = owned ? (offs.length ? 0 : -2) : -1;
    c.order = Math.max(0, Math.min(100, c.order + drift + (rng.percent(35) ? rng.range(-2, 2) : 0)));
    let loyDrift = drift + (famed ? 2 : 0);
    if (c.food <= 0) loyDrift -= 8;
    if (c.troops > c.pop * 0.20) loyDrift -= 3;
    c.loyalty = Math.max(0, Math.min(100, c.loyalty + loyDrift + (rng.percent(35) ? rng.range(-2, 2) : 0)));
    // 굶주림
    if (c.food <= 0 && c.troops > 0) {
      const lost = Math.round(c.troops * rng.range(6, 18) / 100);
      c.troops -= lost;
      c.morale = Math.max(0, c.morale - 12);
      if (owned) report.logs.push(g.pushLog(`${c.name}의 병량이 바닥나 병사 ${lost.toLocaleString()}이(가) 흩어졌다.`, 'bad', { city: c.id }));
    }
    // 창고 용량을 넘긴 병량은 쥐와 습기에 상한다
    const store = Math.round(c.maxAgri * 300 + 20000);
    if (c.food > store) c.food = store + Math.round((c.food - store) * 0.5);
    c.food = Math.round(c.food * 0.995);
    // 사기·훈련 표류
    c.morale = Math.max(0, Math.min(100, c.morale - (rng.percent(40) ? 1 : 0)));
    c.train = Math.max(0, Math.min(100, c.train - (rng.percent(30) ? 1 : 0)));
    // 무주공산 도시에 병력이 자연 증가
    if (!owned) c.troops = Math.min(Math.round(c.pop * 0.06), c.troops + rng.range(0, 60));
  }

  // ── 4. 무장 상태 ──
  for (const o of g.officers) {
    if (o.dead) continue;
    o.status = 'idle';
    o.fatigue = Math.max(0, o.fatigue - 20);
    const healRate = 6 + (o.traits.includes('healer') ? 10 : 0) + (g.eff(o).fx.healRate || 0) / 10;
    o.injury = Math.max(0, o.injury - healRate);
    if (o.realm) {
      const r = g.realmById[o.realm];
      if (!r || r.dead) { o.realm = null; continue; }
      const ruler = g.officerById[r.ruler];
      if (o.id === r.ruler) { o.loyalty = 100; continue; }
      if (o.traits.includes('loyalist')) { o.loyalty = Math.min(100, o.loyalty + 3); continue; }
      // 상성·명성·꿈에 따른 충성 표류
      const d = compatDistance(o.compat, ruler.compat);
      let dl = 0;
      if (d < 25) dl += 1; else if (d > 55) dl -= 1;
      if (r.fame > 500) dl += 1;
      if (o.dreamDone) dl += 1;
      if (o.ambition >= 8 && r.cities.length < 3) dl -= 1;
      const c = g.cityById[o.city];
      if (c && c.loyalty < 30) dl -= 1;
      dl += (g.eff(o).fx.loyalGain || 0) / 10;
      o.loyalty = Math.max(0, Math.min(100, o.loyalty + dl));
    }
  }

  // ── 4-b. 재야 무장의 유랑 ──
  //  일자리를 찾아 명성 높은 세력의 도시로 흘러간다.
  for (const o of g.officers) {
    if (o.dead || o.realm || o.prisoner || o.age < 15) continue;
    if (!rng.percent(o.personality === 'reclusive' ? 6 : 22)) continue;
    const here = g.cityById[o.city];
    if (!here) continue;
    const cand = here.links.map(l => g.cityById[l.to]).filter(Boolean);
    cand.push(here);
    const pick = rng.weighted(cand, c => {
      const r = c.realm ? g.realmById[c.realm] : null;
      if (!r || r.dead) return 4;
      // 명성이 높고 무장이 적은 세력이 매력적이다
      return 6 + r.fame / 90 + Math.max(0, 12 - g.officersOf(r.id).length);
    });
    if (pick && pick.id !== o.city) {
      removeFromCity(g, o);
      o.city = pick.id;
      pick.officers.push(o.id);
      g.freeOfficers.push(o.id);
    }
  }

  // ── 5. AI 행동 ──
  const attacks = [];
  for (const r of g.realms) {
    if (r.dead || r.isPlayer) continue;
    const out = runRealmAI(g, r);
    for (const item of out) {
      if (item.attack) attacks.push(item.attack);
      else if (item.text) report.logs.push(g.pushLog(item.text, item.kind || 'ai', { realm: r.id, quiet: true }));
    }
  }
  // 플레이어가 예약한 출진
  if (g.playerAttacks && g.playerAttacks.length) {
    attacks.push(...g.playerAttacks);
    g.playerAttacks = [];
  }

  // ── 6. 전투 해결 ──
  for (const atk of attacks) {
    const from = g.cityById[atk.from], to = g.cityById[atk.to];
    if (!from || !to) continue;
    const ar = g.realmById[atk.realm];
    if (!ar || ar.dead) continue;
    if (to.realm === atk.realm) continue;      // 이미 아군 소유
    const dr = to.realm ? g.realmById[to.realm] : null;
    const defenders = g.officersIn(to.id).filter(o => o.realm === to.realm && o.injury < 70).slice(0, 6);
    const setup = {
      attackerRealm: atk.realm, defenderRealm: to.realm, city: to,
      siege: to.wall > to.maxWall * 0.12,
      attackers: atk.officers.filter(id => { const o = g.officerById[id]; return o && !o.dead; }),
      defenders: defenders.map(o => o.id),
      attackerTroops: atk.troops, defenderTroops: to.troops,
      train: from.train, atkMorale: from.morale, defMorale: to.morale,
      food: atk.food,
    };
    if (!setup.attackers.length) continue;

    const involvesPlayer = ar.isPlayer || (dr && dr.isPlayer);
    if (involvesPlayer && hooks.onPlayerBattle) {
      report.playerBattle = { setup, atk };
      g.pendingBattle = { setup, atk };
      continue;   // 나머지는 전투 종료 후 처리
    }
    const b = autoResolve(g, setup);
    const res = finishBattle(g, b, setup, atk);
    report.battles.push(res);
    for (const l of res.logs) report.logs.push(g.pushLog(l.text, l.kind, l));
  }

  // ── 7. 랜덤 이벤트 ──
  const evs = rollEvents(g);
  for (const e of evs) {
    report.events.push(e);
    report.logs.push(g.pushLog(e.text, e.kind, e));
  }

  // ── 8. 세력 정리 ──
  for (const r of g.realms) {
    if (r.dead) continue;
    if (!r.cities.length) { g.destroyRealm(r); continue; }
    const ruler = g.officerById[r.ruler];
    // 군주가 죽었거나 · 포로가 되었거나 · 다른 세력으로 넘어갔으면 후계를 세운다
    if (!ruler || ruler.dead || ruler.prisoner || ruler.realm !== r.id) {
      if (ruler && !ruler.dead && ruler.realm !== r.id) {
        report.logs.push(g.pushLog(`《${r.name}》의 군주 ${ruler.name}이(가) 세력을 떠났다.`, 'ruler-lost', { realm: r.id }));
      }
      succeed(g, r, ruler || { id: null, bonds: {} });
    }
    if (!r.cities.includes(r.capital)) r.capital = r.cities[0];
  }

  // ── 9. 승리 판정 ──
  const alive = g.realms.filter(r => !r.dead);
  if (g.playerRealm) {
    const pr = g.realmById[g.playerRealm];
    if (!pr || pr.dead) g.gameOver = { win: false, reason: '세력이 멸망했다' };
    else if (alive.length === 1 && alive[0].id === g.playerRealm && !g.cities.some(c => !c.realm)) {
      g.gameOver = { win: true, reason: '천하를 통일했다' };
    }
  }

  // ── 10. 달력 ──
  g.month++;
  if (g.month >= 12) { g.month = 0; g.year++; }
  return report;
}

/**
 * 전투 결과를 대전략에 반영한다.
 */
export function finishBattle(g, battle, setup, atk) {
  const rng = g.rng;
  const logs = [];
  const from = g.cityById[atk.from], to = g.cityById[atk.to];
  const ar = g.realmById[atk.realm];
  const dr = to.realm ? g.realmById[to.realm] : null;
  const win = battle.result === 'atk';

  // 남은 병력 집계
  let atkLeft = 0, defLeft = 0;
  for (const u of battle.units) {
    if (u.side === 'atk') atkLeft += Math.max(0, u.troops);
    else defLeft += Math.max(0, u.troops);
  }
  const atkLoss = Math.max(0, setup.attackerTroops - atkLeft);
  const defLoss = Math.max(0, setup.defenderTroops - defLeft);

  // 무장 처리
  const captured = [];
  for (const u of battle.units) {
    const o = battle.officerOf(u);
    if (!o) continue;
    o.stats.battles++;
    o.exp.lead += 20;
    if ((u.side === 'atk') === win) { o.stats.wins++; o.fame += rng.range(8, 30); }
    if (u.dead) {
      // 전사 또는 포로
      if (rng.percent(22)) {
        killOfficer(g, o, '전사');
        logs.push({ text: `${o.name}이(가) 전장에서 목숨을 잃었다.`, kind: 'death', officer: o.id });
      } else if ((u.side === 'atk') !== win) {
        captured.push(o);
      } else {
        o.injury = Math.min(100, o.injury + rng.range(20, 50));
      }
    }
  }

  if (win) {
    to.troops = 0;
    const survivors = Math.round(atkLeft);
    if (dr) {
      dr.cities = dr.cities.filter(x => x !== to.id);
      dr.stats.battlesLost++;
      if (!dr.cities.length) g.destroyRealm(dr, ar.id);
    }
    ar.cities.push(to.id);
    ar.stats.battlesWon++; ar.stats.citiesTaken++;
    ar.fame += rng.range(30, 90);
    to.realm = atk.realm;
    to.troops = survivors;
    to.morale = Math.max(30, Math.round(battle.units.filter(u => u.side === 'atk' && !u.dead)
      .reduce((s, u) => s + u.morale, 0) / Math.max(1, battle.alive('atk').length)));
    to.loyalty = Math.max(5, to.loyalty - rng.range(10, 25));
    to.order = Math.max(5, to.order - rng.range(10, 25));
    to.food += atk.food || 0;
    if (battle.wallBroken) to.wall = Math.round(to.wall * 0.25);
    else to.wall = Math.max(0, battle.wallHp || to.wall);

    // 공격 무장을 점령 도시로 이동
    for (const id of setup.attackers) {
      const o = g.officerById[id];
      if (!o || o.dead) continue;
      removeFromCity(g, o);
      o.city = to.id; o.realm = atk.realm; to.officers.push(o.id);
    }
    // 도시의 보물은 점령자에게
    logs.push({ text: `《${ar.name}》이(가) ${to.name}을(를) 함락시켰다! (아군 -${atkLoss.toLocaleString()} / 적 -${defLoss.toLocaleString()})`,
      kind: 'conquest', city: to.id, realm: ar.id, sfx: 'victory', bgm: 'victory' });
  } else {
    to.troops = Math.max(0, defLeft);
    if (dr) dr.stats.battlesWon++;
    ar.stats.battlesLost++;
    ar.fame = Math.max(0, ar.fame - rng.range(10, 30));
    // 살아남은 공격군은 귀환
    from.troops += Math.round(atkLeft * 0.85);
    from.food += Math.round((atk.food || 0) * 0.5);
    for (const id of setup.attackers) {
      const o = g.officerById[id];
      if (!o || o.dead) continue;
      if (captured.includes(o)) continue;
      removeFromCity(g, o);
      o.city = from.id; from.officers.push(o.id);
    }
    logs.push({ text: `《${ar.name}》의 ${to.name} 공격이 막혔다. (아군 -${atkLoss.toLocaleString()} / 적 -${defLoss.toLocaleString()})`,
      kind: 'battle', city: to.id, realm: ar.id, sfx: 'defeat', bgm: 'defeat' });
  }

  // 포로 처리
  const captorRealm = win ? ar : dr;
  for (const o of captured) {
    if (!captorRealm) { o.realm = null; continue; }
    removeFromCity(g, o);
    o.prisoner = true;
    o.realm = captorRealm.id;
    o.city = win ? to.id : to.id;
    g.cityById[o.city].officers.push(o.id);
    logs.push({ text: `${o.name}이(가) 사로잡혔다.`, kind: 'capture', officer: o.id });
    // AI는 즉시 처분
    if (!captorRealm.isPlayer) {
      const ruler = g.officerById[captorRealm.ruler];
      const affinity = 75 - compatDistance(o.compat, ruler.compat);
      if (rng.percent(20 + affinity * 0.5 + o.ambition * 2)) {
        o.prisoner = false; o.loyalty = rng.range(40, 70);
        logs.push({ text: `${o.name}이(가) 《${captorRealm.name}》에 항복했다.`, kind: 'info', officer: o.id });
      } else if (rng.percent(28)) {
        killOfficer(g, o, '처형');
        logs.push({ text: `${o.name}이(가) 참수되었다.`, kind: 'death', officer: o.id });
      } else {
        o.prisoner = false; o.realm = null;
        removeFromCity(g, o);
        o.city = g.rng.pick(g.cities).id;
        g.cityById[o.city].officers.push(o.id);
        g.freeOfficers.push(o.id);
        logs.push({ text: `${o.name}이(가) 풀려났다.`, kind: 'info', officer: o.id });
      }
    }
  }

  return { win, logs, atkLoss, defLoss, city: to.id, captured: captured.map(o => o.id) };
}
