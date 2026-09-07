// ============================================================
//  패널 — 무장 카드 / 도시 정보 / 보물 / 세력 일람
// ============================================================
import { el, num, shortNum, bar, modal } from './dom.js';
import { portraitCanvas } from './portrait.js';
import { TRAIT_BY_ID, DREAMS, PERSONALITIES, rankFor, compatDistance, ARMS } from '../core/traits.js';
import { gradeOf, power } from '../core/officergen.js';
import { itemDescription, RARITY } from '../core/itemgen.js';

const APT_COLOR = { S: '#e8c15a', A: '#d68a5c', B: '#7fb3d5', C: '#9aa08e', D: '#7d8072', E: '#5f6157' };

/** 무장 미니 카드 */
export function officerCard(g, o, opt = {}) {
  const gr = gradeOf(o);
  const e = g.eff(o);
  const card = el('div', {
    class: 'off-card' + (opt.selected ? ' sel' : '') + (o.prisoner ? ' prisoner' : '')
      + (o.status === 'acted' ? ' acted' : ''),
    onclick: opt.onClick,
  }, [
    el('div', { class: 'oc-por' }, [wrapCanvas(portraitCanvas(o, 54))]),
    el('div', { class: 'oc-main' }, [
      el('div', { class: 'oc-row1' }, [
        el('span', { class: 'oc-name', text: o.name }),
        el('span', { class: 'oc-grade', style: { color: gr.c }, text: gr.g }),
        o.prisoner ? el('span', { class: 'tag danger', text: '포로' }) : null,
        o.injury > 40 ? el('span', { class: 'tag warn', text: '부상' }) : null,
        o.status === 'acted' ? el('span', { class: 'tag', text: '행동완료' }) : null,
      ]),
      el('div', { class: 'oc-stats' }, [
        miniStat('통', o.lead, e.lead), miniStat('무', o.war, e.war),
        miniStat('지', o.int, e.int), miniStat('정', o.pol, e.pol),
        miniStat('매', o.cha, e.cha),
      ]),
      el('div', { class: 'oc-row3' }, [
        el('span', { class: 'oc-sub', text: `${o.age}세 · ${o.archetypeName} · ${o.personalityName}` }),
        opt.showLoyalty !== false && o.realm
          ? el('span', { class: 'oc-loyal', text: `충성 ${o.loyalty}` }) : null,
      ]),
      o.traits.length ? el('div', { class: 'oc-traits' },
        o.traits.map(t => el('span', {
          class: 'trait r' + (TRAIT_BY_ID[t]?.rarity || 1),
          title: TRAIT_BY_ID[t]?.desc || '',
          text: TRAIT_BY_ID[t]?.name || t,
        }))) : null,
    ]),
  ]);
  return card;
}

function miniStat(k, base, effv) {
  const diff = effv - base;
  return el('span', { class: 'ms' }, [
    el('b', { text: k }),
    el('span', { class: diff > 0 ? 'up' : diff < 0 ? 'down' : '', text: String(effv) }),
  ]);
}

function wrapCanvas(cv) {
  const d = el('div', { class: 'cvwrap' });
  d.appendChild(cv);
  return d;
}

/** 무장 상세 창 */
export function officerDetail(g, o) {
  const e = g.eff(o);
  const dream = DREAMS.find(d => d.id === o.dream);
  const realm = o.realm ? g.realmById[o.realm] : null;
  const rank = rankFor(o.fame);
  const items = g.itemsOf(o);
  const bonds = Object.entries(o.bonds)
    .map(([id, k]) => ({ o: g.officerById[id], k }))
    .filter(b => b.o && !b.o.dead).slice(0, 8);
  const bondName = { brother: '의형제', kin: '혈연', master: '스승', pupil: '제자', friend: '지기', hate: '원한', spouse: '배필' };

  const body = el('div', { class: 'detail' }, [
    el('div', { class: 'dt-head' }, [
      wrapCanvas(portraitCanvas(o, 132)),
      el('div', { class: 'dt-id' }, [
        el('div', { class: 'dt-name' }, [
          el('span', { class: 'big', text: o.name }),
          el('span', { class: 'hanja', text: o.hanja }),
        ]),
        el('div', { class: 'dt-courtesy', text: `자(字) ${o.courtesy} · ${o.age}세 · ${o.gender === 'F' ? '여' : '남'}` }),
        el('div', { class: 'dt-realm', text: realm ? `《${realm.name}》 ${rank.name}` : '재야' }),
        el('div', { class: 'dt-tags' }, [
          el('span', { class: 'tag', text: o.archetypeName }),
          el('span', { class: 'tag', text: o.originName + ' 출신' }),
          el('span', { class: 'tag', text: o.personalityName }),
          el('span', { class: 'tag', text: o.growthName }),
          o.prisoner ? el('span', { class: 'tag danger', text: '포로' }) : null,
        ]),
      ]),
    ]),
    el('div', { class: 'dt-stats' },
      [['통솔', 'lead'], ['무력', 'war'], ['지력', 'int'], ['정치', 'pol'], ['매력', 'cha']].map(([n, k]) =>
        el('div', { class: 'dt-stat' }, [
          el('div', { class: 'dts-n', text: n }),
          el('div', { class: 'dts-v' }, [
            el('span', { class: 'cur', text: String(e[k]) }),
            e[k] !== o[k] ? el('span', { class: e[k] > o[k] ? 'delta up' : 'delta down', text: (e[k] > o[k] ? '+' : '') + (e[k] - o[k]) }) : null,
            el('span', { class: 'pot', text: `/${o.pot[k]}` }),
          ]),
          bar(e[k], 110, statColor(k)),
        ]))),
    el('div', { class: 'dt-grid' }, [
      infoRow('명성', num(o.fame) + ` (${rank.name})`),
      infoRow('충성', realm ? String(o.loyalty) : '—'),
      infoRow('야망', '★'.repeat(Math.ceil(o.ambition / 2)) + ` (${o.ambition})`),
      infoRow('의리', '★'.repeat(Math.ceil(o.virtue / 2)) + ` (${o.virtue})`),
      infoRow('상성', String(o.compat)),
      infoRow('부상', o.injury > 0 ? `${Math.round(o.injury)}%` : '없음'),
      infoRow('전공', `${o.stats.wins}승 / ${o.stats.battles}전`),
      infoRow('일기토', `${o.stats.duelWins}승 / ${o.stats.duels}회`),
    ]),
    el('div', { class: 'dt-sec' }, [
      el('h4', { text: '병과 적성' }),
      el('div', { class: 'apt-row' }, ARMS.map(a =>
        el('div', { class: 'apt' }, [
          el('span', { class: 'apt-n', text: a }),
          el('span', { class: 'apt-v', style: { color: APT_COLOR[o.apt[a]] || '#999' }, text: o.apt[a] }),
        ]))),
    ]),
    o.traits.length ? el('div', { class: 'dt-sec' }, [
      el('h4', { text: '특기' }),
      el('div', { class: 'trait-list' }, o.traits.map(t => {
        const tr = TRAIT_BY_ID[t];
        return el('div', { class: 'trait-full r' + (tr?.rarity || 1) }, [
          el('b', { text: tr?.name || t }),
          el('span', { text: tr?.desc || '' }),
        ]);
      })),
    ]) : null,
    el('div', { class: 'dt-sec' }, [
      el('h4', { text: '꿈(夢)' }),
      el('div', { class: 'dream' + (o.dreamDone ? ' done' : '') }, [
        el('b', { text: dream?.name || '—' }),
        el('span', { text: dream?.desc || '' }),
        o.dreamDone ? el('span', { class: 'tag good', text: '성취' }) : null,
      ]),
    ]),
    items.length ? el('div', { class: 'dt-sec' }, [
      el('h4', { text: '소지 보물' }),
      el('div', { class: 'item-list' }, items.map(it => itemRow(it))),
    ]) : null,
    bonds.length ? el('div', { class: 'dt-sec' }, [
      el('h4', { text: '인연' }),
      el('div', { class: 'bond-list' }, bonds.map(b =>
        el('span', { class: 'bond ' + (b.k === 'hate' ? 'bad' : 'good') },
          [`${b.o.name} — ${bondName[b.k] || b.k}`]))),
    ]) : null,
  ]);
  return modal(`${o.name} (${o.courtesy})`, body, [{ label: '닫기', cls: 'ghost' }], { wide: true });
}

function statColor(k) {
  return { lead: '#c8a24a', war: '#c8543a', int: '#5a9bd5', pol: '#5aab72', cha: '#b57fd0' }[k];
}

function infoRow(k, v) {
  return el('div', { class: 'info-row' }, [
    el('span', { class: 'ir-k', text: k }),
    el('span', { class: 'ir-v', text: v }),
  ]);
}

export function itemRow(it, opt = {}) {
  return el('div', {
    class: 'item-row' + (it.legend ? ' legend' : ''),
    style: { borderColor: it.color },
    onclick: opt.onClick,
  }, [
    el('div', { class: 'it-head' }, [
      el('span', { class: 'it-name', style: { color: it.color }, text: it.name }),
      el('span', { class: 'it-rar', text: it.rarityName }),
      el('span', { class: 'it-slot', text: slotName(it.slot) }),
    ]),
    el('div', { class: 'it-desc', text: itemDescription(it) }),
    it.lore ? el('div', { class: 'it-lore', text: it.lore }) : null,
  ]);
}

export function slotName(s) {
  return { weapon: '무기', armor: '방어구', horse: '명마', book: '병서', treasure: '보물', relic: '신물' }[s] || s;
}

/** 도시 정보 패널 (사이드바용) */
export function cityPanel(g, c, handlers = {}) {
  const realm = c.realm ? g.realmById[c.realm] : null;
  const offs = g.officersIn(c.id);
  const mine = realm && realm.id === g.playerRealm;
  const known = mine || c.spied > g.turnNo || !c.realm;

  const wrap = el('div', { class: 'city-panel' }, [
    el('div', { class: 'cp-head', style: { borderColor: realm ? realm.color : '#6d675c' } }, [
      el('div', { class: 'cp-title' }, [
        el('span', { class: 'cp-name', text: c.name }),
        el('span', { class: 'cp-hanja', text: c.hanja }),
      ]),
      el('div', { class: 'cp-sub' }, [
        el('span', { class: 'tag', style: { background: realm ? realm.color : '#4c4740' }, text: realm ? realm.name : '중립' }),
        el('span', { class: 'tag', text: c.typeName }),
        g.provinces.find(p => p.id === c.province)
          ? el('span', { class: 'tag ghost', text: g.provinces.find(p => p.id === c.province).name }) : null,
        realm && realm.capital === c.id ? el('span', { class: 'tag gold', text: '수도' }) : null,
      ]),
    ]),
    c.resource ? el('div', { class: 'cp-res' }, [
      el('b', { text: c.resource.name }), el('span', { text: c.resource.desc }),
    ]) : null,
    el('div', { class: 'cp-stats' }, known ? [
      devRow('인구', c.pop, c.maxPop, '#8fae83'),
      devRow('농업', c.agri, c.maxAgri, '#7fa85e'),
      devRow('상업', c.comm, c.maxComm, '#d0a94a'),
      devRow('기술', c.tech, c.maxTech, '#6f9fd0'),
      devRow('치수', c.flood, c.maxFlood, '#5aa8c0'),
      devRow('성벽', c.wall, c.maxWall, '#a4907a'),
      devRow('치안', c.order, 100, '#b98ade'),
      devRow('민심', c.loyalty, 100, '#d0787a'),
    ] : [el('div', { class: 'cp-unknown', text: '정보가 없다. 첩보를 보내야 안을 들여다볼 수 있다.' })]),
    el('div', { class: 'cp-army' }, [
      armyBox('병력', known ? shortNum(c.troops) : '?'),
      armyBox('훈련', known ? c.train : '?'),
      armyBox('사기', known ? c.morale : '?'),
      armyBox('병량', known ? shortNum(c.food) : '?'),
    ]),
    el('div', { class: 'cp-off-head' }, [
      el('h4', { text: `주둔 무장 (${offs.length})` }),
      c.items.length && mine ? el('button', {
        class: 'btn tiny', onclick: () => handlers.onItems && handlers.onItems(c),
      }, [`보물 ${c.items.length}`]) : null,
    ]),
    el('div', { class: 'cp-offs' }, offs.length
      ? offs.map(o => officerCard(g, o, {
        onClick: () => handlers.onOfficer && handlers.onOfficer(o),
        showLoyalty: mine,
      }))
      : [el('div', { class: 'empty', text: '주둔한 무장이 없다.' })]),
  ]);
  return wrap;
}

function devRow(name, v, max, color) {
  return el('div', { class: 'dev-row' }, [
    el('span', { class: 'dv-n', text: name }),
    bar(v, Math.max(1, max), color),
    el('span', { class: 'dv-v', text: max === 100 ? String(Math.round(v)) : `${shortNum(v)}/${shortNum(max)}` }),
  ]);
}

function armyBox(n, v) {
  return el('div', { class: 'army-box' }, [
    el('span', { class: 'ab-n', text: n }),
    el('span', { class: 'ab-v', text: String(v) }),
  ]);
}

/** 세력 일람 */
export function realmListPanel(g) {
  const rows = g.realms.filter(r => !r.dead)
    .map(r => ({ r, p: g.realmPower(r) }))
    .sort((a, b) => b.p - a.p);
  const maxP = rows[0]?.p || 1;
  return el('div', { class: 'realm-list' }, rows.map(({ r, p }) => {
    const ruler = g.officerById[r.ruler];
    return el('div', { class: 'realm-row' + (r.id === g.playerRealm ? ' mine' : '') }, [
      el('div', { class: 'rr-flag', style: { background: r.color } }, [r.name]),
      el('div', { class: 'rr-body' }, [
        el('div', { class: 'rr-top' }, [
          el('span', { class: 'rr-ruler', text: ruler ? `${ruler.name} (${rankFor(ruler.fame).name})` : '—' }),
          el('span', { class: 'rr-style', text: r.aiName }),
        ]),
        el('div', { class: 'rr-nums' }, [
          el('span', { text: `도시 ${r.cities.length}` }),
          el('span', { text: `무장 ${g.officersOf(r.id).length}` }),
          el('span', { text: `금 ${shortNum(r.gold)}` }),
          el('span', { text: `명성 ${num(Math.round(r.fame))}` }),
        ]),
        bar(p, maxP, r.color),
      ]),
    ]);
  }));
}
