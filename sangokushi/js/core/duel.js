// ============================================================
//  일기토(一騎討) — 무장 대 무장의 단기 접전
//  네 가지 수를 주고받으며 기력을 깎는다.
// ============================================================
export const DUEL_MOVES = [
  { id: 'slash', name: '참격', hanja: '斬', desc: '무난한 공격. 견제를 이긴다.' },
  { id: 'lethal', name: '필살', hanja: '必殺', desc: '큰 한 방. 방어에 되치기 당한다.' },
  { id: 'guard', name: '방어', hanja: '防', desc: '받아넘긴다. 필살을 되친다.' },
  { id: 'feint', name: '견제', hanja: '牽制', desc: '기력을 깎는다. 필살을 흘린다.' },
];

// [내 수][상대 수] → { me: 배율, foe: 배율 } (me = 내가 주는 피해)
const MATRIX = {
  slash:  { slash: { me: 1.0, foe: 1.0 }, lethal: { me: 0.7, foe: 1.5 }, guard: { me: 0.35, foe: 0.5 }, feint: { me: 1.4, foe: 0.3 } },
  lethal: { slash: { me: 1.5, foe: 0.7 }, lethal: { me: 1.6, foe: 1.6 }, guard: { me: 0.15, foe: 1.8 }, feint: { me: 0.5, foe: 0.9 } },
  guard:  { slash: { me: 0.5, foe: 0.35 }, lethal: { me: 1.8, foe: 0.15 }, guard: { me: 0.1, foe: 0.1 }, feint: { me: 0.2, foe: 0.7 } },
  feint:  { slash: { me: 0.3, foe: 1.4 }, lethal: { me: 0.9, foe: 0.5 }, guard: { me: 0.7, foe: 0.2 }, feint: { me: 0.6, foe: 0.6 } },
};

export class Duel {
  constructor(game, aId, bId, opt = {}) {
    this.g = game;
    this.a = game.officerById[aId];
    this.b = game.officerById[bId];
    this.opt = opt;
    const ea = game.eff(this.a), eb = game.eff(this.b);
    this.ea = ea; this.eb = eb;
    this.hpA = this.maxA = this._stam(this.a, ea);
    this.hpB = this.maxB = this._stam(this.b, eb);
    this.round = 1;
    this.maxRound = opt.maxRound ?? 12;
    this.log = [];
    this.finished = false;
    this.winner = null;
    this.fatal = false;
  }

  _stam(o, e) {
    return Math.round(62 + e.war * 0.55 + e.lead * 0.22 - Math.max(0, o.age - 42) * 1.2 - o.injury * 0.5
      + (o.traits.includes('monster') ? 30 : 0));
  }

  _atkVal(o, e) {
    let v = e.war * 1.0 + e.lead * 0.15;
    if (o.traits.includes('duelist')) v += 20;
    if (o.traits.includes('monster')) v += 30;
    if (o.traits.includes('lucky')) v += 8;
    v *= 1 + (e.fx.duelPow || 0) / 100;
    v *= 1 - o.injury / 260;
    if (o.age > 46) v *= 1 - (o.age - 46) * 0.008;
    return v;
  }

  /** AI 수 선택 */
  aiMove(o, e, myHp, foeHp) {
    const rng = this.g.rng;
    const w = [];
    const desperate = myHp / this.maxOf(o) < 0.3;
    const winning = myHp > foeHp * 1.5;
    w.push({ id: 'slash', w: 30 + (o.caution || 0) * 0.2 });
    w.push({ id: 'lethal', w: 18 + (o.aggr || 0) * 0.5 + (desperate ? 25 : 0) + (winning ? 10 : 0) });
    w.push({ id: 'guard', w: 16 + (o.caution || 0) * 0.6 + (desperate ? 18 : 0) });
    w.push({ id: 'feint', w: 20 + (e.int || 0) * 0.15 });
    return rng.weighted(w, x => Math.max(1, x.w)).id;
  }

  maxOf(o) { return o === this.a ? this.maxA : this.maxB; }

  /** 한 합을 겨룬다 */
  step(moveA, moveB = null) {
    if (this.finished) return null;
    const rng = this.g.rng;
    if (!moveB) moveB = this.aiMove(this.b, this.eb, this.hpB, this.hpA);
    const mA = MATRIX[moveA][moveB], mB = MATRIX[moveB][moveA];
    const pA = this._atkVal(this.a, this.ea), pB = this._atkVal(this.b, this.eb);

    let dmgB = Math.round(pA * 0.30 * mA.me * rng.jitter(1, 0.30));
    let dmgA = Math.round(pB * 0.30 * mB.me * rng.jitter(1, 0.30));
    // 상대의 방어 능력으로 경감
    dmgB = Math.max(0, Math.round(dmgB * (1 - this.eb.lead / 400)));
    dmgA = Math.max(0, Math.round(dmgA * (1 - this.ea.lead / 400)));

    this.hpB -= dmgB; this.hpA -= dmgA;
    const nA = DUEL_MOVES.find(m => m.id === moveA).name;
    const nB = DUEL_MOVES.find(m => m.id === moveB).name;
    const line = `제${this.round}합 — ${this.a.name}의 ${nA} vs ${this.b.name}의 ${nB}` +
      `  (${this.b.name} -${dmgB} / ${this.a.name} -${dmgA})`;
    this.log.push(line);

    const res = { line, moveA, moveB, dmgA, dmgB, hpA: this.hpA, hpB: this.hpB, crit: false };
    if (mA.me >= 1.5 || mB.me >= 1.5) res.crit = true;

    this.round++;
    if (this.hpA <= 0 || this.hpB <= 0 || this.round > this.maxRound) this._finish();
    return res;
  }

  _finish() {
    this.finished = true;
    const rng = this.g.rng;
    if (this.hpA <= 0 && this.hpB <= 0) this.winner = this.hpA >= this.hpB ? this.a : this.b;
    else if (this.hpA <= 0) this.winner = this.b;
    else if (this.hpB <= 0) this.winner = this.a;
    else this.winner = this.hpA / this.maxA >= this.hpB / this.maxB ? this.a : this.b;
    const loser = this.winner === this.a ? this.b : this.a;
    const decisive = (this.winner === this.a ? this.hpB : this.hpA) <= 0;

    this.winner.stats.duels++; this.winner.stats.duelWins++;
    loser.stats.duels++;
    this.winner.fame += rng.range(12, 40);
    this.winner.exp.war += 30;
    loser.exp.war += 12;
    loser.injury = Math.min(100, loser.injury + (decisive ? rng.range(30, 70) : rng.range(8, 28)));

    // 치명 — 전사
    if (decisive && rng.percent(this.opt.fatalChance ?? 16)) {
      this.fatal = true;
    }
    this.log.push(this.fatal
      ? `${this.winner.name}의 칼에 ${loser.name}이(가) 목숨을 잃었다!`
      : `${this.winner.name}의 승리. ${loser.name}은(는) 물러났다.`);
  }
}
