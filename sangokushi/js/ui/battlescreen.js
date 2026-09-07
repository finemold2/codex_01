// ============================================================
//  전투 화면 컨트롤러 — 플레이어가 직접 지휘한다
// ============================================================
import { el, modal, toast, shortNum, num } from './dom.js';
import { BattleView } from './battleview.js';
import { Battle, FORMATIONS, FORMATION_BY_ID, TACTICS, TACTIC_BY_ID, ARMS_CHART } from '../core/battle.js';
import { BT_BY_ID } from '../core/battlegen.js';
import { portraitCanvas } from './portrait.js';
import { duelDialog } from './dialogs.js';
import { TRAIT_BY_ID } from '../core/traits.js';
import { killOfficer } from '../core/events.js';

export class BattleScreen {
  constructor(app, setup, playerSide) {
    this.app = app;
    this.g = app.game;
    this.audio = app.audio;
    this.setup = setup;
    this.side = playerSide;             // 'atk' | 'def'
    this.battle = new Battle(this.g, setup);
    this.done = null;
    this.busy = false;
    this._build();
    this.view = new BattleView(this.canvas, this.battle, this.g);
    this.view.playerSide = playerSide;
    this._bind();
    this._refresh();
    const bf = this.battle.bf;
    this.audio.play(setup.siege ? 'siege' : 'battle', { force: true });
    this.audio.sfx('warDrum');
    this._banner(`${bf.name}`, `${bf.weather.name}${bf.night ? ' · 야간' : ''} — ${this.side === 'atk' ? '공격' : '방어'}`);
  }

  _build() {
    this.root = el('div', { class: 'battle-screen' });
    this.canvas = el('canvas', { class: 'battle-canvas' });
    this.info = el('div', { class: 'battle-info' });
    this.actions = el('div', { class: 'battle-actions' });
    this.logBox = el('div', { class: 'battle-log' });
    this.header = el('div', { class: 'battle-header' });

    this.root.appendChild(this.header);
    this.root.appendChild(el('div', { class: 'battle-main' }, [
      el('div', { class: 'battle-canvas-wrap' }, [this.canvas]),
      el('div', { class: 'battle-side' }, [this.info, this.actions, this.logBox]),
    ]));
    document.body.appendChild(this.root);
    requestAnimationFrame(() => this.root.classList.add('show'));
  }

  _banner(title, sub) {
    const b = el('div', { class: 'battle-banner' }, [
      el('div', { class: 'bb-title', text: title }),
      el('div', { class: 'bb-sub', text: sub }),
    ]);
    this.root.appendChild(b);
    requestAnimationFrame(() => b.classList.add('show'));
    setTimeout(() => { b.classList.remove('show'); setTimeout(() => b.remove(), 600); }, 2200);
  }

  _bind() {
    this.canvas.addEventListener('mousemove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.view.hoverCell = this.view.cellAt(e.clientX - r.left, e.clientY - r.top);
    });
    this.canvas.addEventListener('mouseleave', () => { this.view.hoverCell = null; });
    this.canvas.addEventListener('click', (e) => {
      if (this.busy) return;
      const r = this.canvas.getBoundingClientRect();
      const cell = this.view.cellAt(e.clientX - r.left, e.clientY - r.top);
      if (cell) this._onCell(cell[0], cell[1]);
    });
    this._key = (e) => {
      if (e.key === 'Escape') { this.view.mode = 'idle'; this._refresh(); }
      if (e.key === ' ') { e.preventDefault(); this._endTurn(); }
    };
    window.addEventListener('keydown', this._key);
  }

  get mySide() { return this.side; }
  myUnits() { return this.battle.alive(this.side); }
  selUnit() { return this.battle.units.find(u => u.id === this.view.sel); }

  _onCell(x, y) {
    const b = this.battle;
    const u = b.unitAt(x, y);
    const sel = this.selUnit();

    if (this.view.mode === 'move' && sel) {
      if (this.view.reach.some(([rx, ry]) => rx === x && ry === y)) {
        sel.x = x; sel.y = y; sel.moved = true;
        this.audio.sfx(sel.arms === '기병' ? 'gallop' : 'click');
        // 함정 판정
        this.view.mode = 'idle';
        this._afterAction(sel);
        return;
      }
    }
    if (this.view.mode === 'attack' && sel) {
      if (this.view.targets.some(([tx, ty]) => tx === x && ty === y)) {
        const foe = b.unitAt(x, y);
        const tile = b.tile(x, y);
        if (foe) { this._doAttack(sel, foe); return; }
        if (tile && (tile.wall || tile.gate)) { this._doWall(sel, x, y); return; }
      }
    }
    if (this.view.mode === 'tactic' && sel && this.pendingTactic) {
      if (this.view.targets.some(([tx, ty]) => tx === x && ty === y)) {
        const res = b.useTactic(sel, this.pendingTactic, x, y);
        if (!res.ok) { toast(res.lines[0] || '실패', 'warn'); return; }
        this.audio.sfx(res.sfx || 'confirm');
        this.view.addEffect('ring', x, y, { color: '#c88ae0', life: 800 });
        for (const l of res.lines) this._log(l);
        this.view.mode = 'idle'; this.pendingTactic = null;
        this._afterAction(sel, true);
        return;
      }
    }
    // 선택
    if (u && u.side === this.side && !u.dead) {
      this.view.sel = u.id;
      this.view.mode = 'idle';
      this.audio.sfx('click');
    } else if (u) {
      this.view.sel = u.id;   // 적 부대 정보 열람
    }
    this._refresh();
  }

  _doAttack(sel, foe) {
    const b = this.battle;
    const ranged = b.dist(sel, foe) > 1;
    this.audio.sfx(ranged ? (sel.arms === '궁병' ? 'volley' : 'arrow') : 'clash');
    if (ranged) this.view.addEffect('arrow', foe.x, foe.y, { fx: sel.x, fy: sel.y, life: 620 });
    else this.view.addEffect('hit', foe.x, foe.y, { life: 560 });
    const before = foe.troops;
    const r = b.attack(sel, foe, { ranged });
    this.view.addEffect('damage', foe.x, foe.y, { text: '-' + shortNum(before - foe.troops), life: 900 });
    for (const l of r.lines) this._log(l);
    this.view.mode = 'idle';
    // 일기토 기회
    const so = b.officerOf(sel), fo = b.officerOf(foe);
    if (!ranged && so && fo && !foe.dead && !sel.dead &&
        this.g.rng.percent(14 + (so.traits.includes('duelist') ? 15 : 0) + (sel.taunted ? 25 : 0))) {
      this.busy = true;
      duelDialog(this.g, this.audio, so.id, fo.id).then(res => {
        this.busy = false;
        this._resolveDuel(sel, foe, res);
      });
      return;
    }
    this._afterAction(sel, true);
  }

  _resolveDuel(uA, uB, res) {
    const b = this.battle;
    const winnerIsA = res.winner === b.officerOf(uA);
    const wu = winnerIsA ? uA : uB, lu = winnerIsA ? uB : uA;
    lu.morale = Math.max(0, lu.morale - 25);
    wu.morale = Math.min(100, wu.morale + 12);
    const loss = Math.round(lu.troops * 0.12);
    lu.troops = Math.max(0, lu.troops - loss);
    this._log(`일기토 — ${res.winner.name}의 승리. ${lu.name} 사기 대폭 하락 (-${shortNum(loss)})`);
    if (res.fatal) {
      const lo = b.officerOf(lu);
      if (lo) {
        killOfficer(this.g, lo, '일기토');
        this._log(`${lo.name}이(가) 전사했다!`);
        lu.dead = true; lu.troops = 0;
        this.audio.sfx('death');
      }
    }
    b._checkRout(lu, []);
    this._afterAction(uA, true);
  }

  _doWall(sel, x, y) {
    const r = this.battle.attackWall(sel, x, y);
    if (!r) return;
    this.audio.sfx(this.battle.wallBroken ? 'wallBreak' : 'siege');
    this.view.addEffect('hit', x, y, { life: 600 });
    this.view.addEffect('damage', x, y, { text: '-' + shortNum(r.dmg), color: '#ffd07a' });
    for (const l of r.lines) this._log(l);
    this.view.mode = 'idle';
    this._afterAction(sel, true);
  }

  _afterAction(u, consume = false) {
    if (consume) u.acted = true;
    // 함정 즉시 판정
    for (const tr of this.battle.bf.traps.slice()) {
      if (tr.x === u.x && tr.y === u.y && tr.side !== u.side) {
        const loss = Math.round(u.troops * tr.power);
        u.troops = Math.max(0, u.troops - loss);
        u.morale = Math.max(0, u.morale - 14);
        this._log(`${u.name}이(가) 함정에 빠졌다! -${shortNum(loss)}`);
        this.audio.sfx('siege');
        this.battle.bf.traps.splice(this.battle.bf.traps.indexOf(tr), 1);
      }
    }
    if (this.battle.checkEnd()) { this._finish(); return; }
    this._refresh();
    // 모든 부대가 행동을 마치면 자동으로 적 차례
    if (this.myUnits().every(x => x.acted || x.dead)) {
      setTimeout(() => this._endTurn(), 420);
    }
  }

  _endTurn() {
    if (this.busy || this.battle.finished) return;
    this.busy = true;
    this.view.mode = 'idle';
    const b = this.battle;
    const foes = b.alive(this.side === 'atk' ? 'def' : 'atk');
    let i = 0;
    const step = () => {
      if (b.finished || i >= foes.length) {
        const lines = b.endRound();
        for (const l of lines) this._log(l);
        this.busy = false;
        if (b.checkEnd()) { this._finish(); return; }
        this._refresh();
        this._flashRound();
        return;
      }
      const u = foes[i++];
      if (!u.dead) {
        const before = { x: u.x, y: u.y };
        const lines = b.aiAct(u);
        for (const l of lines) this._log(l);
        if (lines.length) {
          this.audio.sfx(u.arms === '궁병' ? 'arrow' : 'sword');
          this.view.addEffect('ring', u.x, u.y, { color: '#e07a5a', life: 500 });
        }
      }
      this._refresh();
      if (b.checkEnd()) { this._finish(); return; }
      setTimeout(step, 210);
    };
    this._refresh();
    setTimeout(step, 260);
  }

  _flashRound() {
    const b = this.battle;
    const f = el('div', { class: 'round-flash', text: `제 ${b.round} 진(陣)` });
    this.root.appendChild(f);
    requestAnimationFrame(() => f.classList.add('show'));
    setTimeout(() => { f.remove(); }, 1100);
  }

  _log(text) {
    const line = el('div', { class: 'bl-line', text });
    this.logBox.appendChild(line);
    while (this.logBox.children.length > 120) this.logBox.firstChild.remove();
    this.logBox.scrollTop = this.logBox.scrollHeight;
  }

  // ── 화면 갱신 ──
  _refresh() {
    const b = this.battle;
    const bf = b.bf;
    this.header.innerHTML = '';
    const myT = b.alive(this.side).reduce((s, u) => s + u.troops, 0);
    const foT = b.alive(this.side === 'atk' ? 'def' : 'atk').reduce((s, u) => s + u.troops, 0);
    const ar = this.g.realmById[b.attackerRealm];
    const dr = b.defenderRealm ? this.g.realmById[b.defenderRealm] : null;
    this.header.appendChild(el('div', { class: 'bh-left' }, [
      el('span', { class: 'bh-name', text: bf.name }),
      el('span', { class: 'bh-tag', text: `제${b.round}/${b.maxRounds}진` }),
      el('span', { class: 'bh-tag', text: bf.weather.name }),
      bf.night ? el('span', { class: 'bh-tag night', text: '야간' }) : null,
    ]));
    this.header.appendChild(el('div', { class: 'bh-mid' }, [
      el('div', { class: 'force atk', style: { borderColor: ar?.color } }, [
        el('b', { text: ar?.name || '공격' }),
        el('span', { text: shortNum(b.alive('atk').reduce((s, u) => s + u.troops, 0)) }),
      ]),
      bf.castle ? el('div', { class: 'wallmeter' }, [
        el('span', { text: '성벽' }),
        el('div', { class: 'wm-bar' }, [el('div', {
          class: 'wm-fill', style: { width: Math.max(0, b.wallHp / b.maxWallHp * 100) + '%' },
        })]),
      ]) : null,
      el('div', { class: 'force def', style: { borderColor: dr?.color } }, [
        el('b', { text: dr?.name || '수비' }),
        el('span', { text: shortNum(b.alive('def').reduce((s, u) => s + u.troops, 0)) }),
      ]),
    ]));
    this.header.appendChild(el('div', { class: 'bh-right' }, [
      el('button', { class: 'btn', onclick: () => this._endTurn() }, ['턴 종료 (Space)']),
      el('button', { class: 'btn ghost', onclick: () => this._retreat() }, ['퇴각']),
    ]));

    // 부대 정보
    this.info.innerHTML = '';
    const sel = this.selUnit();
    if (sel) {
      const o = b.officerOf(sel);
      const f = FORMATION_BY_ID[sel.formation];
      const box = el('div', { class: 'unit-info ' + sel.side }, [
        o ? (() => { const w = el('div', { class: 'cvwrap' }); w.appendChild(portraitCanvas(o, 72)); return w; })() : null,
        el('div', { class: 'ui-main' }, [
          el('div', { class: 'ui-name' }, [
            el('b', { text: sel.name }),
            el('span', { class: 'tag', text: sel.arms + ' ' + sel.apt }),
            el('span', { class: 'tag', text: f ? f.name + '진' : '' }),
          ]),
          el('div', { class: 'ui-nums' }, [
            kv('병력', shortNum(sel.troops) + ' / ' + shortNum(sel.maxTroops)),
            kv('사기', String(sel.morale)),
            kv('피로', String(Math.round(sel.fatigue))),
            o ? kv('통/무/지', `${sel.lead}/${sel.war}/${sel.int}`) : null,
          ]),
          el('div', { class: 'ui-terrain', text: `지형: ${(b.tile(sel.x, sel.y) || {}).name || '-'}` }),
          o && o.traits.length ? el('div', { class: 'ui-traits' },
            o.traits.map(t => el('span', { class: 'trait r' + (TRAIT_BY_ID[t]?.rarity || 1), title: TRAIT_BY_ID[t]?.desc, text: TRAIT_BY_ID[t]?.name }))) : null,
        ]),
      ]);
      this.info.appendChild(box);
    } else {
      this.info.appendChild(el('div', { class: 'empty', text: '부대를 고르시오.' }));
    }

    // 명령
    this.actions.innerHTML = '';
    if (sel && sel.side === this.side && !sel.dead && !sel.acted) {
      const o = b.officerOf(sel);
      this.actions.appendChild(actBtn('이동', '移', () => {
        this.view.mode = 'move'; this.view.reach = b.reachable(sel).map(c => [c[0], c[1]]);
        this.audio.sfx('click'); this._refresh();
      }, sel.moved));
      this.actions.appendChild(actBtn('공격', '攻', () => {
        this.view.mode = 'attack';
        const rng = b.attackRange(sel);
        const t = [];
        for (const f of b.alive(this.side === 'atk' ? 'def' : 'atk')) {
          if (b.dist(f, sel) <= rng) t.push([f.x, f.y]);
        }
        if (bf.castle && this.side === 'atk') {
          for (let dy = -rng; dy <= rng; dy++) for (let dx = -rng; dx <= rng; dx++) {
            if (Math.abs(dx) + Math.abs(dy) > rng) continue;
            const tt = b.tile(sel.x + dx, sel.y + dy);
            if (tt && (tt.wall || tt.gate)) t.push([sel.x + dx, sel.y + dy]);
          }
        }
        this.view.targets = t;
        if (!t.length) toast('사거리 안에 적이 없다.', 'warn');
        this.audio.sfx('click'); this._refresh();
      }));
      if (o) {
        this.actions.appendChild(actBtn('계략', '計', () => this._tacticMenu(sel)));
        this.actions.appendChild(actBtn('진형', '陣', () => this._formationMenu(sel)));
      }
      this.actions.appendChild(actBtn('대기', '待', () => {
        sel.morale = Math.min(100, sel.morale + 4);
        sel.fatigue = Math.max(0, sel.fatigue - 12);
        this._log(`${sel.name}이(가) 진을 정비했다.`);
        this._afterAction(sel, true);
      }));
    } else if (sel && sel.acted) {
      this.actions.appendChild(el('div', { class: 'empty', text: '이미 행동했다.' }));
    }

    // 부대 목록
    const roster = el('div', { class: 'roster' }, this.myUnits().map(u =>
      el('button', {
        class: 'roster-btn' + (u.acted ? ' done' : '') + (this.view.sel === u.id ? ' sel' : ''),
        onclick: () => { this.view.sel = u.id; this.view.mode = 'idle'; this.audio.sfx('click'); this._refresh(); },
      }, [
        el('span', { class: 'rb-name', text: u.name }),
        el('span', { class: 'rb-troop', text: shortNum(u.troops) }),
      ])));
    this.actions.appendChild(roster);
  }

  _tacticMenu(u) {
    const b = this.battle;
    const o = b.officerOf(u);
    const rows = TACTICS.map(t => {
      const usable = u.int >= t.int - 25;
      return el('button', {
        class: 'tactic-btn' + (usable ? '' : ' weak'),
        onclick: () => {
          m.close();
          this.pendingTactic = t.id;
          this.view.mode = 'tactic';
          const list = [];
          if (t.range === 0) list.push([u.x, u.y]);
          else {
            for (let dy = -t.range; dy <= t.range; dy++) for (let dx = -t.range; dx <= t.range; dx++) {
              if (Math.abs(dx) + Math.abs(dy) > t.range) continue;
              const x = u.x + dx, y = u.y + dy;
              if (x < 0 || y < 0 || x >= b.bf.W || y >= b.bf.H) continue;
              list.push([x, y]);
            }
          }
          this.view.targets = list;
          this.audio.sfx('scroll');
          this._refresh();
        },
      }, [
        el('b', { text: t.name }),
        el('span', { class: 'tb-req', text: `요구 지력 ${t.int}` }),
        el('span', { class: 'tb-desc', text: t.desc }),
      ]);
    });
    const m = modal(`${u.name} — 계략`, [
      el('div', { class: 'tactic-list' }, rows),
      el('div', { class: 'hint', text: `현재 지력 ${u.int} · 날씨 ${b.bf.weather.name} (화계 배율 ×${b.bf.weather.fire})` }),
    ], [{ label: '취소', cls: 'ghost' }]);
  }

  _formationMenu(u) {
    const rows = FORMATIONS.map(f => el('button', {
      class: 'tactic-btn' + (u.formation === f.id ? ' on' : ''),
      onclick: () => {
        u.formation = f.id;
        this._log(`${u.name}이(가) ${f.name}진으로 바꾸었다.`);
        this.audio.sfx('drum');
        m.close();
        this._afterAction(u, true);
      },
    }, [
      el('b', { text: `${f.name}진 (${f.hanja})` }),
      el('span', { class: 'tb-req', text: `공 ×${f.atk} · 방 ×${f.def} · 이동 ${f.move >= 0 ? '+' : ''}${f.move}` }),
      el('span', { class: 'tb-desc', text: f.desc }),
    ]));
    const m = modal(`${u.name} — 진형 변경`, [el('div', { class: 'tactic-list' }, rows)],
      [{ label: '취소', cls: 'ghost' }]);
  }

  _retreat() {
    modal('퇴각', [el('p', { text: '군을 물리겠는가? 병력의 일부를 잃고 물러난다.' })], [
      { label: '아니오', cls: 'ghost' },
      { label: '퇴각한다', cls: 'danger', onClick: () => {
        for (const u of this.battle.alive(this.side)) { u.troops = Math.round(u.troops * 0.7); u.routed = true; }
        this.battle.finished = true;
        this.battle.result = this.side === 'atk' ? 'def' : 'atk';
        this._finish();
      } },
    ]);
  }

  _finish() {
    if (this._finished) return;
    this._finished = true;
    const b = this.battle;
    const won = b.result === this.side;
    this.audio.sfx(won ? 'victory' : 'defeat');
    this.audio.play(won ? 'victory' : 'defeat', { force: true });
    const myLoss = b.units.filter(u => u.side === this.side).reduce((s, u) => s + (u.maxTroops - Math.max(0, u.troops)), 0);
    const foLoss = b.units.filter(u => u.side !== this.side).reduce((s, u) => s + (u.maxTroops - Math.max(0, u.troops)), 0);
    setTimeout(() => {
      modal(won ? '승리' : '패배', [
        el('div', { class: 'battle-result ' + (won ? 'win' : 'lose') }, [
          el('div', { class: 'br-big', text: won ? '勝' : '敗' }),
          el('div', { class: 'br-lines' }, [
            el('div', { text: `아군 손실 ${num(myLoss)}` }),
            el('div', { text: `적군 손실 ${num(foLoss)}` }),
            el('div', { text: `${b.round}진에 결착` }),
          ]),
        ]),
      ], [{ label: '확인', cls: 'primary', onClick: () => this.close() }], { dismissible: false });
    }, 700);
  }

  close() {
    window.removeEventListener('keydown', this._key);
    this.root.classList.remove('show');
    setTimeout(() => this.root.remove(), 320);
    if (this.done) this.done(this.battle);
  }

  tick(dt) { this.view.draw(dt); }
}

function kv(k, v) {
  return el('div', { class: 'kv' }, [el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v })]);
}

function actBtn(label, glyph, onClick, disabled = false) {
  return el('button', { class: 'act-btn' + (disabled ? ' dim' : ''), onclick: onClick }, [
    el('span', { class: 'ab-g', text: glyph }),
    el('span', { class: 'ab-l', text: label }),
  ]);
}
