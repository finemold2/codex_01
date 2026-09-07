// ============================================================
//  설전(舌戰) — 말로 겨루는 승부
//  등용·항복 권유·외교에서 벌어진다.
// ============================================================
export const DEBATE_MOVES = [
  { id: 'logic',  name: '논파', hanja: '論破', desc: '이치로 몰아붙인다. 회유를 꺾는다.' },
  { id: 'appeal', name: '대의', hanja: '大義', desc: '명분으로 설득한다. 격론을 꺾는다.' },
  { id: 'lure',   name: '회유', hanja: '懷柔', desc: '이익으로 꾄다. 대의를 꺾는다.' },
  { id: 'heat',   name: '격론', hanja: '激論', desc: '기세로 밀어붙인다. 논파를 꺾는다.' },
];

const BEATS = { logic: 'lure', appeal: 'heat', lure: 'appeal', heat: 'logic' };

export class Debate {
  constructor(game, aId, bId, opt = {}) {
    this.g = game;
    this.a = game.officerById[aId];      // 설득하는 쪽
    this.b = game.officerById[bId];      // 설득당하는 쪽
    this.opt = opt;
    const ea = game.eff(this.a), eb = game.eff(this.b);
    this.ea = ea; this.eb = eb;
    this.hpA = this.maxA = Math.round(55 + ea.int * 0.42 + ea.cha * 0.35);
    this.hpB = this.maxB = Math.round(55 + eb.int * 0.42 + eb.cha * 0.35
      + (opt.difficulty ?? 0));
    this.round = 1;
    this.maxRound = opt.maxRound ?? 8;
    this.log = [];
    this.finished = false;
    this.winner = null;
  }

  _power(o, e, move) {
    let v;
    switch (move) {
      case 'logic': v = e.int * 1.1 + e.pol * 0.3; break;
      case 'appeal': v = e.cha * 1.0 + e.pol * 0.4 + o.virtue * 2; break;
      case 'lure': v = e.pol * 0.9 + e.int * 0.4 + o.greed * 0.5; break;
      default: v = e.cha * 0.7 + e.war * 0.5 + (o.aggr || 0) * 0.2; break;
    }
    if (o.traits.includes('psywar')) v += 25;
    if (o.traits.includes('envoy')) v += 15;
    if (o.traits.includes('sorcery')) v += 10;
    return v;
  }

  aiMove(o, e) {
    const rng = this.g.rng;
    return rng.weighted([
      { id: 'logic', w: 15 + e.int * 0.3 },
      { id: 'appeal', w: 15 + e.cha * 0.25 + o.virtue * 2 },
      { id: 'lure', w: 12 + e.pol * 0.25 + o.greed * 1.5 },
      { id: 'heat', w: 12 + (o.aggr || 0) * 0.4 + e.war * 0.15 },
    ], x => Math.max(1, x.w)).id;
  }

  step(moveA, moveB = null) {
    if (this.finished) return null;
    const rng = this.g.rng;
    if (!moveB) moveB = this.aiMove(this.b, this.eb);
    const pA = this._power(this.a, this.ea, moveA);
    const pB = this._power(this.b, this.eb, moveB);
    let mulA = 1, mulB = 1;
    if (BEATS[moveA] === moveB) mulA = 1.9;
    if (BEATS[moveB] === moveA) mulB = 1.9;
    if (moveA === moveB) { mulA *= 0.7; mulB *= 0.7; }

    const dB = Math.max(0, Math.round(pA * 0.24 * mulA * rng.jitter(1, 0.25)));
    const dA = Math.max(0, Math.round(pB * 0.24 * mulB * rng.jitter(1, 0.25)));
    this.hpB -= dB; this.hpA -= dA;

    const nA = DEBATE_MOVES.find(m => m.id === moveA).name;
    const nB = DEBATE_MOVES.find(m => m.id === moveB).name;
    const line = `제${this.round}합 — ${this.a.name}의 ${nA} vs ${this.b.name}의 ${nB}` +
      `  (${this.b.name} -${dB} / ${this.a.name} -${dA})`;
    this.log.push(line);
    const res = { line, moveA, moveB, dA, dB, hpA: this.hpA, hpB: this.hpB, crit: mulA > 1.5 || mulB > 1.5 };
    this.round++;
    if (this.hpA <= 0 || this.hpB <= 0 || this.round > this.maxRound) this._finish();
    return res;
  }

  _finish() {
    this.finished = true;
    if (this.hpB <= 0 && this.hpA > 0) this.winner = this.a;
    else if (this.hpA <= 0 && this.hpB > 0) this.winner = this.b;
    else this.winner = this.hpA / this.maxA >= this.hpB / this.maxB ? this.a : this.b;
    this.a.stats.debates++; this.b.stats.debates++;
    if (this.winner === this.a) { this.a.stats.debateWins++; this.a.exp.int += 20; this.a.fame += 8; }
    else { this.b.stats.debateWins++; this.b.exp.int += 20; }
    this.log.push(this.winner === this.a
      ? `${this.b.name}이(가) 말문이 막혔다. ${this.a.name}의 승리.`
      : `${this.a.name}이(가) 말문이 막혔다. 뜻을 이루지 못했다.`);
  }
}
