// ============================================================
//  전투 엔진 — 진형 · 병과 상성 · 지형 · 계략 · 일기토
// ============================================================
import { generateBattlefield, BT, BT_BY_ID, tileAt, WEATHERS } from './battlegen.js';
import { APT_MULT } from './traits.js';
import { aggregateItems } from './itemgen.js';

// ── 진형 ───────────────────────────────────────────────
export const FORMATIONS = [
  { id: 'gyorin', name: '어린', hanja: '魚鱗', atk: 1.18, def: 0.95, move: 0, range: 0, desc: '중앙 돌파에 능하다' },
  { id: 'hakik',  name: '학익', hanja: '鶴翼', atk: 1.02, def: 1.10, move: 0, range: 1, desc: '포위와 사격에 유리' },
  { id: 'bangwon',name: '방원', hanja: '方圓', atk: 0.88, def: 1.32, move: -1, range: 0, desc: '농성·방어 최강' },
  { id: 'bongsi', name: '봉시', hanja: '鋒矢', atk: 1.30, def: 0.82, move: 1, range: 0, desc: '돌격 특화, 방어는 약하다' },
  { id: 'anhaeng',name: '안행', hanja: '雁行', atk: 1.05, def: 1.02, move: 0, range: 1, desc: '궁병 운용에 적합' },
  { id: 'chuhaeng',name: '추행', hanja: '錐行', atk: 1.08, def: 0.94, move: 2, range: 0, desc: '기동력이 뛰어나다' },
  { id: 'jangsa', name: '장사', hanja: '長蛇', atk: 1.00, def: 0.98, move: 1, range: 0, desc: '행군용, 매복에 약하다' },
  { id: 'jeongran',name: '정란', hanja: '井欄', atk: 0.95, def: 1.12, move: -1, range: 1, desc: '공성 병기 운용' },
];
export const FORMATION_BY_ID = Object.fromEntries(FORMATIONS.map(f => [f.id, f]));

// ── 병과 상성 (공격자 → 방어자 배율) ─────────────────────
export const ARMS_CHART = {
  보병: { 보병: 1.0, 기병: 1.15, 궁병: 1.10, 수군: 0.95, 병기: 1.20 },
  기병: { 보병: 0.90, 기병: 1.0, 궁병: 1.35, 수군: 0.80, 병기: 1.25 },
  궁병: { 보병: 1.15, 기병: 0.85, 궁병: 1.0, 수군: 1.05, 병기: 1.15 },
  수군: { 보병: 0.95, 기병: 1.05, 궁병: 0.95, 수군: 1.0, 병기: 1.0 },
  병기: { 보병: 0.85, 기병: 0.75, 궁병: 0.90, 수군: 0.85, 병기: 1.0 },
};
export const ARMS_RANGE = { 보병: 1, 기병: 1, 궁병: 3, 수군: 2, 병기: 4 };
export const ARMS_MOVE = { 보병: 4, 기병: 7, 궁병: 4, 수군: 5, 병기: 3 };

// ── 전장 계략 ──────────────────────────────────────────
export const TACTICS = [
  { id: 'fire',    name: '화계', cost: 2, range: 4, int: 55, desc: '불을 놓는다. 바람을 타면 번진다.' },
  { id: 'water',   name: '수계', cost: 3, range: 5, int: 70, desc: '둑을 터뜨려 저지대를 잠근다.' },
  { id: 'confuse', name: '혼란', cost: 2, range: 3, int: 60, desc: '적 부대를 혼란에 빠뜨린다.' },
  { id: 'ambush',  name: '매복', cost: 1, range: 0, int: 45, desc: '숲·산에 숨는다. 다음 공격이 기습이 된다.' },
  { id: 'rally',   name: '고무', cost: 1, range: 2, int: 30, desc: '아군의 사기를 회복시킨다.' },
  { id: 'taunt',   name: '도발', cost: 1, range: 3, int: 40, desc: '적을 끌어낸다. 일기토를 걸 수 있다.' },
  { id: 'trap',    name: '함정', cost: 2, range: 2, int: 55, desc: '지정한 칸에 함정을 판다.' },
  { id: 'heal',    name: '치료', cost: 2, range: 1, int: 50, desc: '부상병을 수습해 병력 일부를 되살린다.' },
];
export const TACTIC_BY_ID = Object.fromEntries(TACTICS.map(t => [t.id, t]));

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ============================================================
export class Battle {
  constructor(game, setup) {
    this.g = game;
    this.rng = game.rng;
    this.setup = setup;
    this.attackerRealm = setup.attackerRealm;
    this.defenderRealm = setup.defenderRealm;
    this.city = setup.city;
    this.siege = setup.siege;
    this.bf = generateBattlefield(this.rng, {
      world: game.world, city: setup.city, siege: setup.siege, month: game.month,
      W: setup.W ?? (22 + this.rng.int(8)), H: setup.H ?? (16 + this.rng.int(6)),
    });
    this.units = [];
    this.round = 1;
    this.maxRounds = setup.maxRounds ?? (this.siege ? 30 : 22);
    this.turnSide = 'atk';
    this.log = [];
    this.finished = false;
    this.result = null;
    this.pendingDuel = null;
    this._deploy();
  }

  _deploy() {
    const mk = (offId, side, troops, zone, i) => {
      const o = this.g.officerById[offId];
      if (!o) return null;
      const e = this.g.eff(o);
      const arms = pickArms(this.g, o, this.bf);
      const pos = zone[Math.min(zone.length - 1, Math.floor(i * Math.max(1, zone.length / 8)) % zone.length)]
        || zone[this.rng.int(zone.length)] || [0, 0];
      const u = {
        id: 'u' + side + i, officer: offId, side,
        name: o.name, x: pos[0], y: pos[1],
        troops, maxTroops: troops,
        morale: side === 'atk' ? (this.setup.atkMorale ?? 75) : (this.setup.defMorale ?? 75),
        fatigue: 0,
        arms, apt: o.apt[arms] || 'C',
        formation: pickFormation(this.g, o, arms, side, this.siege, this.rng),
        moved: false, acted: false, hidden: false, confused: 0, ambush: false,
        routed: false, lead: e.lead, war: e.war, int: e.int, cha: e.cha, fx: e.fx,
        kills: 0, dead: false,
      };
      return u;
    };
    const azone = this.rng.shuffle(this.bf.attackerZone.slice());
    const dzone = this.rng.shuffle(this.bf.defenderZone.slice());
    const aTroops = this.setup.attackers.length
      ? Math.floor(this.setup.attackerTroops / this.setup.attackers.length) : 0;
    this.setup.attackers.forEach((id, i) => {
      const u = mk(id, 'atk', Math.max(100, aTroops), azone, i);
      if (u) this.units.push(u);
    });
    const dTroops = this.setup.defenders.length
      ? Math.floor(this.setup.defenderTroops / this.setup.defenders.length) : 0;
    this.setup.defenders.forEach((id, i) => {
      const u = mk(id, 'def', Math.max(100, dTroops), dzone, i);
      if (u) this.units.push(u);
    });
    // 방어측이 무장 없이 병력만 있을 때 — 수비대
    if (!this.setup.defenders.length && this.setup.defenderTroops > 0) {
      const pos = dzone[0] || [this.bf.W - 2, Math.floor(this.bf.H / 2)];
      this.units.push({
        id: 'udef_garrison', officer: null, side: 'def', name: '수비대',
        x: pos[0], y: pos[1], troops: this.setup.defenderTroops, maxTroops: this.setup.defenderTroops,
        morale: 60, fatigue: 0, arms: '보병', apt: 'C', formation: 'bangwon',
        moved: false, acted: false, hidden: false, confused: 0, ambush: false,
        routed: false, lead: 45, war: 40, int: 30, cha: 30, fx: {}, kills: 0, dead: false,
      });
    }
    this.wallHp = this.bf.castle ? this.bf.castle.hp : 0;
    this.maxWallHp = this.bf.castle ? Math.max(1, this.bf.castle.maxHp) : 1;
  }

  // ── 조회 ────────────────────────────────────────────
  unitAt(x, y) { return this.units.find(u => !u.dead && u.x === x && u.y === y); }
  alive(side) { return this.units.filter(u => !u.dead && u.side === side); }
  officerOf(u) { return u.officer ? this.g.officerById[u.officer] : null; }
  tile(x, y) { return tileAt(this.bf, x, y); }

  moveRange(u) {
    const f = FORMATION_BY_ID[u.formation];
    let m = ARMS_MOVE[u.arms] + (f?.move || 0) + (u.fx?.moveBonus || 0);
    if (this.officerOf(u)?.traits.includes('guerilla')) m += 2;
    if (this.officerOf(u)?.traits.includes('rider')) m += 1;
    m = Math.round(m * (this.bf.weather.move ?? 1));
    if (u.fatigue > 60) m -= 1;
    if (u.confused > 0) m = Math.max(1, m - 2);
    return Math.max(1, m);
  }

  attackRange(u) {
    const f = FORMATION_BY_ID[u.formation];
    return ARMS_RANGE[u.arms] + (u.arms === '궁병' || u.arms === '병기' ? (f?.range || 0) : 0);
  }

  /** 도달 가능한 칸 (다익스트라) */
  reachable(u) {
    const { W, H } = this.bf;
    const budget = this.moveRange(u);
    const cost = new Float32Array(W * H).fill(Infinity);
    const start = u.y * W + u.x;
    cost[start] = 0;
    const q = [[u.x, u.y, 0]];
    const out = [];
    while (q.length) {
      q.sort((a, b) => a[2] - b[2]);
      const [x, y, c] = q.shift();
      if (c > cost[y * W + x]) continue;
      if (!(x === u.x && y === u.y)) out.push([x, y, c]);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const t = this.tile(nx, ny);
        if (!t || t.block) {
          if (!(t && t.gate)) continue;
        }
        if (this.unitAt(nx, ny)) continue;
        let mc = t.move;
        if (t.water && u.arms !== '수군') mc *= 1.6;
        if (u.arms === '수군' && t.water) mc = 1;
        const nc = c + mc;
        if (nc > budget + 0.001) continue;
        if (nc < cost[ny * W + nx]) { cost[ny * W + nx] = nc; q.push([nx, ny, nc]); }
      }
    }
    return out;
  }

  // ── 전투력 계산 ─────────────────────────────────────
  unitPower(u, mode = 'atk') {
    const t = this.tile(u.x, u.y) || BT.PLAIN;
    const f = FORMATION_BY_ID[u.formation] || FORMATIONS[0];
    const o = this.officerOf(u);
    const aptM = APT_MULT[u.apt] || 1;
    let base = u.troops * (0.55 + u.morale / 180) * (0.7 + (this.setup.train ?? 60) / 200);
    if (mode === 'atk') {
      let v = base * (1 + u.war / 130) * aptM * f.atk * (1 + (t.atk || 0) / 100);
      if (o) {
        if (o.traits.includes('charge') && u.arms === '기병') v *= 1.3;
        if (o.traits.includes('berserk')) v *= 1 + (1 - u.troops / u.maxTroops) * 0.6;
        if (o.traits.includes('vanguard') && this.round === 1) v *= 1.4;
        if (o.traits.includes('nightraid') && this.bf.night) v *= 1.4;
        if (o.traits.includes('naval') && t.water) v *= 1.35;
        if (o.traits.includes('formation')) v *= 1.15;
        if (o.traits.includes('monster')) v *= 1.25;
      }
      if (u.fx?.chargePow && u.arms === '기병') v *= 1 + u.fx.chargePow / 100;
      if (u.ambush) v *= 1.8;
      if (u.confused > 0) v *= 0.55;
      if (this.bf.night) v *= 0.9;
      return v;
    }
    let v = base * (1 + u.lead / 130) * aptM * f.def * (1 + (t.def || 0) / 100);
    if (o) {
      if (o.traits.includes('phalanx')) v *= 1.25;
      if (o.traits.includes('ironwall') && t.wall) v *= 1.4;
      if (o.traits.includes('formation')) v *= 1.15;
    }
    if (u.fx?.defense) v *= 1 + u.fx.defense / 100;
    if (u.confused > 0) v *= 0.7;
    return v;
  }

  /** 실제 공격 처리 */
  attack(att, def, opt = {}) {
    const rng = this.rng;
    const ranged = opt.ranged ?? (this.dist(att, def) > 1);
    let A = this.unitPower(att, 'atk');
    let D = this.unitPower(def, 'def');
    A *= ARMS_CHART[att.arms]?.[def.arms] ?? 1;
    if (ranged) {
      A *= 0.75 * (this.bf.weather.arrow ?? 1);
      if (att.arms === '궁병' && this.officerOf(att)?.traits.includes('volley')) A *= 1.6;
    }
    // 측·후방 공격
    A *= rng.jitter(1, 0.16);
    D *= rng.jitter(1, 0.16);
    const ratio = A / (A + D);
    const k = ranged ? 0.10 : 0.19;
    let dLoss = Math.round(att.troops * ratio * k * (0.7 + rng.next() * 0.7));
    let aLoss = ranged ? 0 : Math.round(def.troops * (1 - ratio) * k * 0.72 * (0.7 + rng.next() * 0.7));
    dLoss = Math.min(def.troops, Math.max(1, dLoss));
    aLoss = Math.min(att.troops, Math.max(0, aLoss));

    def.troops -= dLoss; att.troops -= aLoss;
    att.kills += dLoss; def.kills += aLoss;
    const mKeep = 1 - (def.fx?.moraleKeep || 0) / 100;
    def.morale = clamp(def.morale - Math.round((5 + ratio * 16) * mKeep), 0, 100);
    att.morale = clamp(att.morale - Math.round((1 - ratio) * 8) + (ratio > 0.6 ? 3 : 0), 0, 100);
    att.fatigue = Math.min(100, att.fatigue + 8);
    att.ambush = false;
    att.hidden = false;

    const lines = [`${att.name}이(가) ${def.name}을(를) 쳤다. 적 -${dLoss.toLocaleString()}${aLoss ? ` / 아군 -${aLoss.toLocaleString()}` : ''}`];

    // 적장 부상
    const ao = this.officerOf(att), dof = this.officerOf(def);
    if (dof && rng.percent(ao?.traits.includes('deadeye') ? 12 : 4)) {
      dof.injury = Math.min(100, dof.injury + rng.range(10, 35));
      lines.push(`${dof.name}이(가) 부상을 입었다!`);
    }
    // 유린
    if (ao?.traits.includes('trample') && dLoss > def.troops * 0.5) {
      for (const n of this.neighbors(def)) {
        if (n.side !== def.side || n.dead) continue;
        const spl = Math.round(dLoss * 0.25);
        n.troops = Math.max(0, n.troops - spl);
        lines.push(`유린! ${n.name} -${spl.toLocaleString()}`);
      }
    }
    this._checkRout(def, lines);
    this._checkRout(att, lines);
    if (ao) ao.exp.war += 6;
    if (dof) dof.exp.lead += 5;
    return { lines, dLoss, aLoss, ranged };
  }

  neighbors(u) {
    const out = [];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = this.unitAt(u.x + dx, u.y + dy);
      if (n) out.push(n);
    }
    return out;
  }

  _checkRout(u, lines) {
    if (u.dead) return;
    if (u.troops <= 0) {
      u.dead = true; u.troops = 0;
      lines.push(`${u.name}의 부대가 궤멸했다!`);
      const o = this.officerOf(u);
      if (o) {
        o.injury = Math.min(100, o.injury + this.rng.range(20, 60));
        this.capturedCandidates = this.capturedCandidates || [];
        this.capturedCandidates.push({ officer: o.id, side: u.side });
      }
      return;
    }
    if (u.morale <= 5 && !u.routed) {
      u.routed = true;
      lines.push(`${u.name}의 부대가 무너져 달아난다!`);
    }
  }

  dist(a, b) { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); }

  /** 성벽 공격 */
  attackWall(u, x, y) {
    const t = this.tile(x, y);
    if (!t || (!t.wall && !t.gate)) return null;
    const o = this.officerOf(u);
    let dmg = u.troops * 0.05 * (1 + u.war / 150);
    if (u.arms === '병기') dmg *= 2.2;
    if (o?.traits.includes('siege')) dmg *= 2;
    if (u.fx?.siegePow) dmg *= 1 + u.fx.siegePow / 100;
    dmg = Math.round(dmg * this.rng.jitter(1, 0.25));
    this.wallHp = Math.max(0, this.wallHp - dmg);
    u.fatigue = Math.min(100, u.fatigue + 10);
    const lines = [`${u.name}이(가) 성벽을 두드렸다. 성벽 내구 -${dmg.toLocaleString()}`];
    if (this.wallHp <= 0) {
      // 성문 파괴 — 벽 일부가 무너진다
      const c = this.bf.castle;
      lines.push('성벽이 무너졌다!');
      this.bf.map[y * this.bf.W + x] = BT.RUIN.id;
      if (c) {
        const gy = c.gate[1];
        this.bf.map[gy * this.bf.W + c.gate[0]] = BT.RUIN.id;
      }
      this.wallBroken = true;
    } else if (t.gate && this.wallHp < this.maxWallHp * 0.25) {
      this.bf.map[y * this.bf.W + x] = BT.RUIN.id;
      lines.push('성문이 부서졌다!');
    }
    return { lines, dmg };
  }

  // ── 전장 계략 ───────────────────────────────────────
  useTactic(u, tacticId, tx, ty) {
    const t = TACTIC_BY_ID[tacticId];
    const o = this.officerOf(u);
    if (!t || !o) return { ok: false, lines: ['쓸 수 없다.'] };
    const lines = [];
    const rng = this.rng;
    let p = 25 + (u.int - t.int) * 1.3 + (u.fx?.ployRate || 0);
    if (tacticId === 'fire' && o.traits.includes('firelord')) p += 35;
    if (tacticId === 'water' && o.traits.includes('flood')) p += 35;
    if (tacticId === 'confuse' && o.traits.includes('confuse')) p += 35;
    if (tacticId === 'trap' && o.traits.includes('trap')) p += 35;
    if (tacticId === 'ambush' && o.traits.includes('ambusher')) p += 40;
    if (o.traits.includes('sorcery')) p += 20;
    p = clamp(p, 5, 95);

    // 적장의 간파
    const target = this.unitAt(tx, ty);
    if (target && target.side !== u.side) {
      const to = this.officerOf(target);
      if (to && (to.traits.includes('insight') || (to.fx?.ployGuard || 0) > 0)) {
        p -= (to.traits.includes('insight') ? 35 : 0) + (to.fx?.ployGuard || 0);
      }
      if (to && rng.percent(clamp((to.int - u.int) * 0.6 + 8, 2, 60))) {
        lines.push(`${to.name}이(가) ${t.name}을(를) 간파했다!`);
        if (to.traits.includes('counter')) {
          u.morale = clamp(u.morale - 20, 0, 100);
          lines.push(`반계! ${u.name}의 사기가 크게 떨어졌다.`);
        }
        u.acted = true;
        return { ok: true, lines, sfx: 'cancel' };
      }
    }
    if (!rng.percent(p)) {
      lines.push(`${u.name}의 ${t.name}이(가) 실패했다. (성공률 ${Math.round(p)}%)`);
      u.acted = true;
      return { ok: true, lines, sfx: 'cancel' };
    }
    o.exp.int += 12;

    switch (tacticId) {
      case 'fire': {
        const w = this.bf.weather.fire ?? 1;
        const power = (0.7 + u.int / 140) * w * (o.traits.includes('firelord') ? 1.6 : 1);
        this._ignite(tx, ty, power, lines);
        lines.push(`${u.name}이(가) 불을 놓았다! (${this.bf.weather.name})`);
        return { ok: true, lines, sfx: 'fire' };
      }
      case 'water': {
        let hit = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const x = tx + dx, y = ty + dy;
          const tt = this.tile(x, y);
          if (!tt || tt.high || tt.wall) continue;
          this.bf.floods[y * this.bf.W + x] = 3;
          const vu = this.unitAt(x, y);
          if (vu) {
            const loss = Math.round(vu.troops * (0.10 + u.int / 500) * rng.jitter(1, 0.3));
            vu.troops = Math.max(0, vu.troops - loss);
            vu.morale = clamp(vu.morale - 18, 0, 100);
            hit++;
            lines.push(`${vu.name}이(가) 물에 휩쓸렸다. -${loss.toLocaleString()}`);
            this._checkRout(vu, lines);
          }
        }
        lines.unshift(`${u.name}이(가) 둑을 터뜨렸다! (${hit}개 부대 피해)`);
        return { ok: true, lines, sfx: 'flood' };
      }
      case 'confuse': {
        if (!target) return { ok: false, lines: ['대상이 없다.'] };
        target.confused = rng.range(2, 4);
        target.morale = clamp(target.morale - 12, 0, 100);
        lines.push(`${target.name}이(가) 혼란에 빠졌다! (${target.confused}턴)`);
        return { ok: true, lines, sfx: 'debate' };
      }
      case 'ambush': {
        const tt = this.tile(u.x, u.y);
        if (!tt?.hide && !tt?.high) return { ok: false, lines: ['숨을 곳이 없다.'] };
        u.hidden = true; u.ambush = true;
        lines.push(`${u.name}이(가) 자취를 감췄다.`);
        return { ok: true, lines, sfx: 'scroll' };
      }
      case 'rally': {
        let n = 0;
        for (const a of this.alive(u.side)) {
          if (this.dist(a, u) > t.range) continue;
          a.morale = clamp(a.morale + Math.round(10 + u.cha / 8), 0, 100);
          a.confused = 0; a.routed = false; n++;
        }
        lines.push(`${u.name}이(가) 삼군을 고무했다. (${n}개 부대 사기 회복)`);
        return { ok: true, lines, sfx: 'horn' };
      }
      case 'taunt': {
        if (!target) return { ok: false, lines: ['대상이 없다.'] };
        target.taunted = 3;
        target.morale = clamp(target.morale - 6, 0, 100);
        lines.push(`${u.name}이(가) ${target.name}을(를) 도발했다!`);
        return { ok: true, lines, sfx: 'debate' };
      }
      case 'trap': {
        this.bf.traps.push({ x: tx, y: ty, side: u.side, power: 0.10 + u.int / 600 });
        lines.push(`${u.name}이(가) 함정을 팠다.`);
        return { ok: true, lines, sfx: 'seal' };
      }
      case 'heal': {
        const back = Math.round(u.maxTroops * (0.05 + u.int / 900));
        u.troops = Math.min(u.maxTroops, u.troops + back);
        u.fatigue = Math.max(0, u.fatigue - 25);
        lines.push(`${u.name}이(가) 부상병을 수습했다. +${back.toLocaleString()}`);
        return { ok: true, lines, sfx: 'confirm' };
      }
    }
    return { ok: false, lines: [] };
  }

  _ignite(x, y, power, lines) {
    const { W, H } = this.bf;
    const r = 1 + Math.round(power);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const t = this.tile(nx, ny);
      if (!t || t.water) continue;
      const burnable = t.id === BT.FOREST.id || t.id === BT.GRASS.id || t.id === BT.CAMP.id
        || t.id === BT.INNER.id || t.id === BT.RUIN.id || t.id === BT.PLAIN.id;
      if (!burnable && this.rng.percent(50)) continue;
      this.bf.fires[ny * W + nx] = Math.max(this.bf.fires[ny * W + nx], 2 + this.rng.int(3));
    }
  }

  /** 라운드 종료 시 환경 효과 */
  endRound() {
    const lines = [];
    const { W, H } = this.bf;
    // 불 — 피해 및 확산
    const spread = [];
    for (let i = 0; i < this.bf.fires.length; i++) {
      if (this.bf.fires[i] <= 0) continue;
      const x = i % W, y = (i / W) | 0;
      const u = this.unitAt(x, y);
      if (u && !u.dead) {
        const loss = Math.round(u.troops * (0.07 + this.rng.next() * 0.08));
        u.troops = Math.max(0, u.troops - loss);
        u.morale = clamp(u.morale - 12, 0, 100);
        lines.push(`${u.name}이(가) 불길에 휩싸였다. -${loss.toLocaleString()}`);
        this._checkRout(u, lines);
      }
      this.bf.fires[i] -= 1;
      if (this.bf.fires[i] > 0 && this.rng.percent(28 * (this.bf.weather.fire ?? 1))) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const t = this.tile(nx, ny);
          if (t && !t.water && this.bf.fires[ny * W + nx] <= 0) spread.push(ny * W + nx);
        }
      }
    }
    for (const i of spread) this.bf.fires[i] = 2;
    // 수몰
    for (let i = 0; i < this.bf.floods.length; i++) if (this.bf.floods[i] > 0) this.bf.floods[i] -= 1;
    // 함정
    for (const tr of this.bf.traps.slice()) {
      const u = this.unitAt(tr.x, tr.y);
      if (u && u.side !== tr.side) {
        const loss = Math.round(u.troops * tr.power);
        u.troops = Math.max(0, u.troops - loss);
        u.morale = clamp(u.morale - 14, 0, 100);
        lines.push(`${u.name}이(가) 함정에 빠졌다! -${loss.toLocaleString()}`);
        this._checkRout(u, lines);
        this.bf.traps.splice(this.bf.traps.indexOf(tr), 1);
      }
    }
    // 상태 회복
    for (const u of this.units) {
      if (u.dead) continue;
      if (u.confused > 0) u.confused--;
      if (u.taunted > 0) u.taunted--;
      u.fatigue = Math.max(0, u.fatigue - 4);
      const o = this.officerOf(u);
      if (o?.traits.includes('rally')) u.morale = clamp(u.morale + 3, 0, 100);
      if (u.routed && u.morale > 20) u.routed = false;
      // 병량 소모로 인한 사기 저하
      if (this.round > this.maxRounds * 0.7) u.morale = clamp(u.morale - 2, 0, 100);
      u.moved = false; u.acted = false;
    }
    this.round++;
    return lines;
  }

  /** 승패 판정 */
  checkEnd() {
    const a = this.alive('atk').filter(u => !u.routed);
    const d = this.alive('def').filter(u => !u.routed);
    if (!d.length) { this.finished = true; this.result = 'atk'; return 'atk'; }
    if (!a.length) { this.finished = true; this.result = 'def'; return 'def'; }
    // 성 점령
    if (this.bf.castle) {
      const c = this.bf.castle;
      const inside = a.filter(u => u.x > c.x0 && u.x < c.x0 + c.w - 1 && u.y > c.y0 && u.y < c.y0 + c.h - 1);
      const defInside = d.filter(u => u.x >= c.x0 && u.x <= c.x0 + c.w - 1 && u.y >= c.y0 && u.y <= c.y0 + c.h - 1);
      if (inside.length && !defInside.length) { this.finished = true; this.result = 'atk'; return 'atk'; }
    }
    if (this.round > this.maxRounds) {
      this.finished = true;
      this.result = 'def';   // 시간 초과 = 수비 성공
      return 'def';
    }
    return null;
  }

  /** 방어측(또는 AI측) 한 부대의 행동 */
  aiAct(u) {
    const lines = [];
    if (u.dead || u.acted) return lines;
    const foes = this.alive(u.side === 'atk' ? 'def' : 'atk');
    if (!foes.length) return lines;
    const o = this.officerOf(u);

    // 패주 — 도망
    if (u.routed) {
      const back = u.side === 'atk' ? -1 : 1;
      const cells = this.reachable(u);
      const best = cells.sort((a, b) => (b[0] - a[0]) * back - (a[0] - a[0]))[0];
      if (best) { u.x = best[0]; u.y = best[1]; }
      u.acted = true; u.moved = true;
      return lines;
    }

    // 계략 우선 판단
    if (o && u.int > 62 && this.rng.percent(30)) {
      const near = foes.filter(f => this.dist(f, u) <= 4);
      if (near.length) {
        const tgt = near.sort((a, b) => b.troops - a.troops)[0];
        const opts = [];
        if (this.bf.weather.fire > 0.5) opts.push('fire');
        if (o.traits.includes('flood')) opts.push('water');
        if (u.int > 70) opts.push('confuse');
        if (opts.length) {
          const r = this.useTactic(u, this.rng.pick(opts), tgt.x, tgt.y);
          if (r.ok) { u.acted = true; return r.lines; }
        }
      }
    }
    // 사기가 낮으면 고무
    if (u.morale < 40 && o && this.rng.percent(35)) {
      const r = this.useTactic(u, 'rally', u.x, u.y);
      if (r.ok) { u.acted = true; return r.lines; }
    }

    // 공격 대상 탐색
    const range = this.attackRange(u);
    let target = null, bestScore = -Infinity;
    for (const f of foes) {
      const d = this.dist(f, u);
      let sc = -d * 3 + (f.troops < u.troops ? 25 : 0) + (100 - f.morale) * 0.25;
      sc += (ARMS_CHART[u.arms]?.[f.arms] ?? 1) * 20;
      if (u.taunted && f.tauntedBy === u.id) sc += 100;
      if (sc > bestScore) { bestScore = sc; target = f; }
    }
    if (!target) { u.acted = true; return lines; }

    if (this.dist(target, u) <= range) {
      const r = this.attack(u, target);
      lines.push(...r.lines);
      u.acted = true; u.moved = true;
      return lines;
    }
    // 이동 — 공성측은 성벽도 노린다
    const cells = this.reachable(u);
    if (cells.length) {
      let best = null, bd = Infinity;
      for (const [x, y] of cells) {
        const d = Math.abs(x - target.x) + Math.abs(y - target.y);
        const t = this.tile(x, y);
        let score = d - (t.def || 0) / 30;
        if (this.bf.fires[y * this.bf.W + x] > 0) score += 20;
        if (score < bd) { bd = score; best = [x, y]; }
      }
      if (best) { u.x = best[0]; u.y = best[1]; u.moved = true; }
    }
    // 이동 후 사거리에 들어오면 공격
    if (this.dist(target, u) <= range) {
      const r = this.attack(u, target);
      lines.push(...r.lines);
    } else if (this.bf.castle && u.side === 'atk') {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const t = this.tile(u.x + dx, u.y + dy);
        if (t && (t.wall || t.gate)) {
          const r = this.attackWall(u, u.x + dx, u.y + dy);
          if (r) lines.push(...r.lines);
          break;
        }
      }
    }
    u.acted = true;
    return lines;
  }
}

// ------------------------------------------------------------------
function pickArms(g, o, bf) {
  const best = Object.entries(o.apt).sort((a, b) =>
    (APT_MULT[b[1]] || 1) - (APT_MULT[a[1]] || 1));
  let arms = best[0][0];
  // 강이 많은 전장이 아니면 수군은 지양
  if (arms === '수군') {
    let water = 0;
    for (let i = 0; i < bf.map.length; i++) if (BT_BY_ID[bf.map[i]]?.water) water++;
    if (water / bf.map.length < 0.10) arms = best[1] ? best[1][0] : '보병';
  }
  return arms;
}

function pickFormation(g, o, arms, side, siege, rng) {
  const cand = [];
  if (side === 'def') { cand.push('bangwon', 'bangwon', 'hakik', 'anhaeng'); }
  else { cand.push('gyorin', 'bongsi', 'chuhaeng'); if (siege) cand.push('jeongran', 'jeongran'); }
  if (arms === '궁병') cand.push('anhaeng', 'hakik');
  if (arms === '기병') cand.push('bongsi', 'chuhaeng');
  if (arms === '병기') cand.push('jeongran');
  if (o.traits.includes('phalanx')) cand.push('bangwon');
  return rng.pick(cand);
}

/** AI 대 AI 전투 자동 해결 (플레이어가 관여하지 않는 전투) */
export function autoResolve(game, setup) {
  const b = new Battle(game, setup);
  let guard = 0;
  while (!b.finished && guard++ < 400) {
    for (const u of b.units) {
      if (u.dead) continue;
      b.aiAct(u);
      if (b.checkEnd()) break;
    }
    if (b.finished) break;
    b.endRound();
    b.checkEnd();
  }
  return b;
}
