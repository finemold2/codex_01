// ============================================================
//  대화 상자 — 일기토 · 설전 · 이벤트 · 목록 화면
// ============================================================
import { el, modal, num, shortNum, bar, toast } from './dom.js';
import { portraitCanvas } from './portrait.js';
import { officerCard, officerDetail, itemRow, realmListPanel, slotName } from './panels.js';
import { Duel, DUEL_MOVES } from '../core/duel.js';
import { Debate, DEBATE_MOVES } from '../core/debate.js';
import { gradeOf, power } from '../core/officergen.js';
import { TRAIT_BY_ID } from '../core/traits.js';

// ------------------------------------------------------------
//  일기토
// ------------------------------------------------------------
export function duelDialog(g, audio, aId, bId, opt = {}) {
  return new Promise((resolve) => {
    const duel = new Duel(g, aId, bId, opt);
    const a = duel.a, b = duel.b;
    audio.play('battle', { force: false });
    audio.sfx('duel');

    const hpA = el('div', { class: 'duel-bar-fill a' });
    const hpB = el('div', { class: 'duel-bar-fill b' });
    const logBox = el('div', { class: 'duel-log' });
    const clash = el('div', { class: 'duel-clash' });
    const moveRow = el('div', { class: 'duel-moves' });

    const body = el('div', { class: 'duel' }, [
      el('div', { class: 'duel-arena' }, [
        fighter(a, 'a'), clash, fighter(b, 'b'),
      ]),
      el('div', { class: 'duel-bars' }, [
        el('div', { class: 'duel-bar' }, [hpA]),
        el('div', { class: 'duel-vs', text: '一騎討' }),
        el('div', { class: 'duel-bar rev' }, [hpB]),
      ]),
      logBox, moveRow,
    ]);

    const m = modal('일기토', body, [], { cls: 'duel-modal', dismissible: false, wide: true });

    function fighter(o, side) {
      const cv = portraitCanvas(o, 96);
      const w = el('div', { class: 'duel-fighter ' + side });
      const pw = el('div', { class: 'cvwrap' }); pw.appendChild(cv);
      w.appendChild(pw);
      w.appendChild(el('div', { class: 'df-name', text: o.name }));
      w.appendChild(el('div', { class: 'df-stat', text: `무력 ${g.eff(o).war}` }));
      const tr = o.traits.filter(t => ['duelist', 'monster', 'deadeye'].includes(t));
      if (tr.length) w.appendChild(el('div', { class: 'df-trait', text: tr.map(t => TRAIT_BY_ID[t].name).join(' ') }));
      return w;
    }

    function refresh() {
      hpA.style.width = Math.max(0, duel.hpA / duel.maxA * 100) + '%';
      hpB.style.width = Math.max(0, duel.hpB / duel.maxB * 100) + '%';
    }
    refresh();

    function renderMoves() {
      moveRow.innerHTML = '';
      if (duel.finished) {
        const winner = duel.winner;
        moveRow.appendChild(el('div', { class: 'duel-result' }, [
          el('b', { text: duel.fatal ? `${winner.name}의 승리 — 상대를 베었다!` : `${winner.name}의 승리` }),
        ]));
        moveRow.appendChild(el('button', {
          class: 'btn primary', onclick: () => { m.close(); resolve({ duel, winner, fatal: duel.fatal }); },
        }, ['확인']));
        return;
      }
      for (const mv of DUEL_MOVES) {
        moveRow.appendChild(el('button', {
          class: 'btn move', title: mv.desc,
          onclick: () => step(mv.id),
        }, [
          el('span', { class: 'mv-h', text: mv.hanja }),
          el('span', { class: 'mv-n', text: mv.name }),
        ]));
      }
    }

    function step(moveId) {
      const r = duel.step(moveId);
      if (!r) return;
      audio.sfx(r.crit ? 'clash' : 'sword');
      clash.textContent = r.crit ? '★' : '⚔';
      clash.classList.remove('hit'); void clash.offsetWidth; clash.classList.add('hit');
      const line = el('div', { class: 'dl-line' + (r.crit ? ' crit' : ''), text: r.line });
      logBox.appendChild(line);
      logBox.scrollTop = logBox.scrollHeight;
      refresh();
      if (duel.finished) {
        audio.sfx(duel.fatal ? 'death' : 'victory');
        logBox.appendChild(el('div', { class: 'dl-line final', text: duel.log[duel.log.length - 1] }));
        logBox.scrollTop = logBox.scrollHeight;
      }
      renderMoves();
    }
    renderMoves();
  });
}

// ------------------------------------------------------------
//  설전
// ------------------------------------------------------------
export function debateDialog(g, audio, aId, bId, opt = {}) {
  return new Promise((resolve) => {
    const deb = new Debate(g, aId, bId, opt);
    const a = deb.a, b = deb.b;
    audio.sfx('debate');

    const hpA = el('div', { class: 'duel-bar-fill a' });
    const hpB = el('div', { class: 'duel-bar-fill b' });
    const logBox = el('div', { class: 'duel-log' });
    const moveRow = el('div', { class: 'duel-moves' });

    const body = el('div', { class: 'duel debate' }, [
      opt.intro ? el('div', { class: 'debate-intro', text: opt.intro }) : null,
      el('div', { class: 'duel-arena' }, [
        pfig(a, 'a'), el('div', { class: 'duel-clash', text: '舌' }), pfig(b, 'b'),
      ]),
      el('div', { class: 'duel-bars' }, [
        el('div', { class: 'duel-bar' }, [hpA]),
        el('div', { class: 'duel-vs', text: '舌戰' }),
        el('div', { class: 'duel-bar rev' }, [hpB]),
      ]),
      logBox, moveRow,
    ]);
    const m = modal(opt.title || '설전', body, [], { cls: 'duel-modal', dismissible: false, wide: true });

    function pfig(o, side) {
      const w = el('div', { class: 'duel-fighter ' + side });
      const pw = el('div', { class: 'cvwrap' }); pw.appendChild(portraitCanvas(o, 96));
      w.appendChild(pw);
      w.appendChild(el('div', { class: 'df-name', text: o.name }));
      w.appendChild(el('div', { class: 'df-stat', text: `지력 ${g.eff(o).int} · 매력 ${g.eff(o).cha}` }));
      return w;
    }
    function refresh() {
      hpA.style.width = Math.max(0, deb.hpA / deb.maxA * 100) + '%';
      hpB.style.width = Math.max(0, deb.hpB / deb.maxB * 100) + '%';
    }
    refresh();
    function renderMoves() {
      moveRow.innerHTML = '';
      if (deb.finished) {
        moveRow.appendChild(el('div', { class: 'duel-result' }, [
          el('b', { text: deb.winner === a ? '설득에 성공했다' : '설득에 실패했다' }),
        ]));
        moveRow.appendChild(el('button', {
          class: 'btn primary', onclick: () => { m.close(); resolve({ debate: deb, win: deb.winner === a }); },
        }, ['확인']));
        return;
      }
      for (const mv of DEBATE_MOVES) {
        moveRow.appendChild(el('button', {
          class: 'btn move', title: mv.desc, onclick: () => step(mv.id),
        }, [el('span', { class: 'mv-h', text: mv.hanja }), el('span', { class: 'mv-n', text: mv.name })]));
      }
    }
    function step(id) {
      const r = deb.step(id);
      if (!r) return;
      audio.sfx(r.crit ? 'confirm' : 'click');
      logBox.appendChild(el('div', { class: 'dl-line' + (r.crit ? ' crit' : ''), text: r.line }));
      logBox.scrollTop = logBox.scrollHeight;
      refresh();
      if (deb.finished) {
        logBox.appendChild(el('div', { class: 'dl-line final', text: deb.log[deb.log.length - 1] }));
        logBox.scrollTop = logBox.scrollHeight;
        audio.sfx(deb.winner === a ? 'levelup' : 'cancel');
      }
      renderMoves();
    }
    renderMoves();
  });
}

// ------------------------------------------------------------
//  월간 보고 (이벤트 모음)
// ------------------------------------------------------------
export function reportDialog(g, audio, report, onDone) {
  const items = [];
  for (const e of report.events) items.push(e);
  for (const l of report.logs) {
    if (l.quiet) continue;
    if (report.events.some(e => e.text === l.text)) continue;
    items.push(l);
  }
  if (!items.length) { onDone && onDone(); return null; }

  const list = el('div', { class: 'report-list' }, items.map(e => {
    const kind = e.kind || 'info';
    const row = el('div', { class: 'rep-row k-' + kind }, [
      e.focus && g.officerById[e.focus]
        ? (() => { const w = el('div', { class: 'cvwrap small' }); w.appendChild(portraitCanvas(g.officerById[e.focus], 44)); return w; })()
        : el('div', { class: 'rep-icon', text: iconFor(kind, e.tag) }),
      el('div', { class: 'rep-text' }, [
        e.name ? el('b', { text: e.name }) : null,
        el('span', { text: e.text }),
      ]),
    ]);
    return row;
  }));

  // 대표 효과음
  const first = items.find(i => i.sfx);
  if (first) audio.sfx(first.sfx);
  const bgmEvent = items.find(i => i.bgm);

  return modal(`${g.year}년 ${g.month === 0 ? 12 : g.month}월의 보고`, [list],
    [{ label: '확인', cls: 'primary', onClick: () => onDone && onDone() }],
    { wide: true, dismissible: false });
}

function iconFor(kind, tag) {
  if (tag === 'disaster') return '雨';
  if (tag === 'blessing') return '禾';
  if (tag === 'person') return '人';
  if (tag === 'treasure') return '寶';
  if (tag === 'unrest') return '亂';
  if (tag === 'military') return '兵';
  if (tag === 'court') return '朝';
  if (tag === 'legend') return '奇';
  if (tag === 'omen') return '星';
  if (kind === 'conquest') return '陷';
  if (kind === 'death') return '喪';
  return '報';
}

// ------------------------------------------------------------
//  무장 일람
// ------------------------------------------------------------
export function officerListDialog(g, audio, opt = {}) {
  let scope = opt.scope || 'mine';
  let sortKey = 'power';
  const listBox = el('div', { class: 'off-list' });

  function render() {
    listBox.innerHTML = '';
    let list = g.officers.filter(o => !o.dead && o.age >= 14);
    if (scope === 'mine') list = list.filter(o => o.realm === g.playerRealm && !o.prisoner);
    else if (scope === 'free') list = list.filter(o => !o.realm);
    else if (scope === 'prisoner') list = list.filter(o => o.prisoner && o.realm === g.playerRealm);
    const key = { power: o => power(o), lead: o => o.lead, war: o => o.war, int: o => o.int,
      pol: o => o.pol, cha: o => o.cha, fame: o => o.fame, loyal: o => o.loyalty, age: o => -o.age }[sortKey];
    list.sort((a, b) => key(b) - key(a));
    if (!list.length) { listBox.appendChild(el('div', { class: 'empty', text: '해당하는 무장이 없다.' })); return; }
    for (const o of list.slice(0, 300)) {
      const city = g.cityById[o.city];
      const card = officerCard(g, o, { onClick: () => officerDetail(g, o), showLoyalty: o.realm === g.playerRealm });
      card.appendChild(el('div', { class: 'oc-where', text: city ? city.name : '—' }));
      listBox.appendChild(card);
    }
  }

  const tabs = el('div', { class: 'tabs' }, [
    tabBtn('아군', 'mine'), tabBtn('재야', 'free'), tabBtn('포로', 'prisoner'), tabBtn('전체', 'all'),
  ]);
  function tabBtn(label, id) {
    return el('button', {
      class: 'tab' + (scope === id ? ' on' : ''),
      onclick: (ev) => {
        scope = id; audio.sfx('page');
        tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
        ev.currentTarget.classList.add('on');
        render();
      },
    }, [label]);
  }
  const sortSel = el('select', {
    class: 'sel', onchange: (e) => { sortKey = e.target.value; render(); },
  }, [['power', '종합'], ['lead', '통솔'], ['war', '무력'], ['int', '지력'], ['pol', '정치'],
      ['cha', '매력'], ['fame', '명성'], ['loyal', '충성'], ['age', '나이']]
    .map(([v, n]) => el('option', { value: v }, [n])));

  render();
  return modal('무장 일람', [
    el('div', { class: 'list-head' }, [tabs, sortSel]),
    listBox,
  ], [{ label: '닫기', cls: 'ghost' }], { wide: true });
}

// ------------------------------------------------------------
//  보물 일람
// ------------------------------------------------------------
export function itemListDialog(g, audio, city = null) {
  const box = el('div', { class: 'item-grid' });
  let items;
  if (city) items = city.items.map(u => g.itemById[u]).filter(Boolean);
  else {
    items = g.items.filter(it => {
      if (it.owner) { const o = g.officerById[it.owner]; return o && !o.dead && o.realm === g.playerRealm; }
      if (it.city) { const c = g.cityById[it.city]; return c && c.realm === g.playerRealm; }
      return false;
    });
  }
  items.sort((a, b) => b.rarity - a.rarity || b.value - a.value);
  if (!items.length) box.appendChild(el('div', { class: 'empty', text: '보물이 없다.' }));
  for (const it of items) {
    const owner = it.owner ? g.officerById[it.owner] : null;
    const row = itemRow(it, {
      onClick: () => assignItem(g, audio, it, () => { audio.sfx('confirm'); }),
    });
    row.appendChild(el('div', { class: 'it-owner', text: owner ? `소지: ${owner.name}` : (it.city ? `보관: ${g.cityById[it.city]?.name}` : '—') }));
    box.appendChild(row);
  }
  return modal(city ? `${city.name}의 보물` : '보물 일람', [box], [{ label: '닫기', cls: 'ghost' }], { wide: true });
}

/** 보물을 무장에게 하사 */
export function assignItem(g, audio, item, onDone) {
  const cand = g.officers.filter(o => !o.dead && o.realm === g.playerRealm && !o.prisoner)
    .sort((a, b) => power(b) - power(a));
  const list = el('div', { class: 'off-list compact' }, cand.slice(0, 200).map(o =>
    officerCard(g, o, {
      onClick: () => {
        // 기존 소지자에게서 회수
        if (item.owner) {
          const prev = g.officerById[item.owner];
          if (prev) prev.items = prev.items.filter(u => u !== item.uid);
        }
        if (item.city) {
          const c = g.cityById[item.city];
          if (c) c.items = c.items.filter(u => u !== item.uid);
          item.city = null;
        }
        if (o.items.length >= 4) { toast('한 무장은 보물을 넷까지만 지닌다.', 'warn'); return; }
        o.items.push(item.uid); item.owner = o.id;
        audio.sfx('treasure');
        toast(`${o.name}에게 「${item.name}」을(를) 내렸다.`, 'good');
        mm.close(); onDone && onDone();
      },
    })));
  const mm = modal(`「${item.name}」 하사`, [
    itemRow(item),
    el('h4', { text: '누구에게 내릴 것인가' }),
    list,
  ], [
    { label: '창고로', cls: 'ghost', onClick: () => {
      if (item.owner) { const p = g.officerById[item.owner]; if (p) p.items = p.items.filter(u => u !== item.uid); }
      item.owner = null;
      const cap = g.cityById[g.realmById[g.playerRealm].capital];
      if (cap) { cap.items.push(item.uid); item.city = cap.id; }
      onDone && onDone();
    } },
    { label: '닫기', cls: 'ghost' },
  ], { wide: true });
  return mm;
}

// ------------------------------------------------------------
//  세력도
// ------------------------------------------------------------
export function realmDialog(g, audio) {
  return modal('세력도', [realmListPanel(g)], [{ label: '닫기', cls: 'ghost' }], { wide: true });
}

// ------------------------------------------------------------
//  연대기
// ------------------------------------------------------------
export function chronicleDialog(g) {
  const rows = g.log.slice(-260).reverse().map(l =>
    el('div', { class: 'chron-row k-' + (l.kind || 'info') }, [
      el('span', { class: 'ch-date', text: `${l.y}년 ${l.m + 1}월` }),
      el('span', { class: 'ch-text', text: l.text }),
    ]));
  return modal('연대기', [el('div', { class: 'chronicle' }, rows.length ? rows : [el('div', { class: 'empty', text: '아직 기록이 없다.' })])],
    [{ label: '닫기', cls: 'ghost' }], { wide: true });
}
