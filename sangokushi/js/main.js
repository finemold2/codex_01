// ============================================================
//  삼국연의 난세기 — 애플리케이션 진입점
// ============================================================
import { Game, MONTH_NAMES, SEASONS } from './core/state.js';
import { advanceMonth, finishBattle, cityIncome, cityUpkeep } from './core/turn.js';
import { COMMANDS, COMMAND_BY_ID, execCommand, adjacentEnemyCities, enemyOfficersNear } from './core/commands.js';
import { autoResolve } from './core/battle.js';
import { combatRating, power, gradeOf } from './core/officergen.js';
import { rankFor, compatDistance, TRAIT_BY_ID } from './core/traits.js';
import { removeFromCity, killOfficer } from './core/events.js';
import { audio } from './audio/engine.js';
import { WorldMap } from './ui/map.js';
import { BattleScreen } from './ui/battlescreen.js';
import { el, $, clear, num, shortNum, bar, modal, toast, confirmBox } from './ui/dom.js';
import { officerCard, officerDetail, cityPanel, realmListPanel, itemRow } from './ui/panels.js';
import {
  duelDialog, debateDialog, reportDialog, officerListDialog,
  itemListDialog, realmDialog, chronicleDialog, assignItem,
} from './ui/dialogs.js';
import { portraitCanvas, clearPortraitCache } from './ui/portrait.js';
import { saveGame, loadGame, listSaves, deleteSave } from './core/save.js';

const SETTINGS_KEY = 'sgk6.settings';

class App {
  constructor() {
    this.game = null;
    this.map = null;
    this.battleScreen = null;
    this.audio = audio;
    this.settings = this.loadSettings();
    this.lastT = performance.now();
    this.screen = 'title';
    this.selectedCity = null;
    this.ordersLeft = 0;
    this.pendingAttacks = [];
    this._buildShell();
    this._loop();
    this.showTitle();
  }

  // ── 설정 ──
  loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      return { bgm: 0.55, sfx: 0.7, muted: false, autoReport: true, ...s };
    } catch (e) { return { bgm: 0.55, sfx: 0.7, muted: false, autoReport: true }; }
  }
  saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch (e) { /* 저장 불가 */ }
  }
  applyAudio() {
    this.audio.setBgmVolume(this.settings.bgm);
    this.audio.setSfxVolume(this.settings.sfx);
    this.audio.setMuted(this.settings.muted);
  }

  // ── 셸 ──
  _buildShell() {
    this.app = $('#app');
    this.layers = {
      title: el('div', { class: 'screen title-screen' }),
      play: el('div', { class: 'screen play-screen' }),
    };
    for (const k of Object.keys(this.layers)) this.app.appendChild(this.layers[k]);
  }

  show(name) {
    this.screen = name;
    for (const [k, v] of Object.entries(this.layers)) v.classList.toggle('on', k === name);
  }

  _loop() {
    const now = performance.now();
    const dt = Math.min(60, now - this.lastT);
    this.lastT = now;
    if (this.battleScreen) this.battleScreen.tick(dt);
    else if (this.map && this.screen === 'play') this.map.draw(dt);
    else if (this.titleFx) this.titleFx(dt);
    requestAnimationFrame(() => this._loop());
  }

  // ============================================================
  //  타이틀
  // ============================================================
  showTitle() {
    const L = this.layers.title;
    clear(L);
    const cv = el('canvas', { class: 'title-bg' });
    L.appendChild(cv);
    this._titleCanvas(cv);

    L.appendChild(el('div', { class: 'title-inner' }, [
      el('div', { class: 'title-mark', text: '三國' }),
      el('h1', { class: 'title-main' }, [
        el('span', { class: 'tm-1', text: '삼국연의' }),
        el('span', { class: 'tm-2', text: '亂 世 記' }),
      ]),
      el('p', { class: 'title-sub', text: '매번 새로 태어나는 중원 — 절차적 난세 시뮬레이션' }),
      el('div', { class: 'title-menu' }, [
        el('button', { class: 'btn big primary', onclick: () => { this.audio.init(); this.applyAudio(); this.audio.sfx('gong'); this.newGameDialog(); } }, ['새로운 난세']),
        el('button', { class: 'btn big', onclick: () => { this.audio.init(); this.applyAudio(); this.audio.sfx('click'); this.loadDialog(); } }, ['이어하기']),
        el('button', { class: 'btn big', onclick: () => { this.audio.init(); this.applyAudio(); this.audio.sfx('click'); this.settingsDialog(); } }, ['설정']),
        el('button', { class: 'btn big ghost', onclick: () => { this.audio.init(); this.applyAudio(); this.helpDialog(); } }, ['유람 안내']),
      ]),
      el('div', { class: 'title-foot', text: '배경음악: 비발디 · 바흐 · 베토벤 · 모차르트 · 홀스트 · 그리그 · 바그너 · 차이콥스키 · 쇼팽 · 드보르작 · 파헬벨 · 로시니 · 알비노니 · 베르디 (모두 퍼블릭 도메인, 실시간 합성)' }),
    ]));
    this.show('title');
    // 첫 상호작용 시 음악 시작
    const start = () => {
      this.audio.init(); this.applyAudio();
      this.audio.play('title');
      window.removeEventListener('pointerdown', start);
      window.removeEventListener('keydown', start);
    };
    window.addEventListener('pointerdown', start);
    window.addEventListener('keydown', start);
  }

  /** 타이틀 배경 — 수묵 산수 애니메이션 */
  _titleCanvas(cv) {
    const ctx = cv.getContext('2d');
    let t = 0;
    const layers = [];
    for (let i = 0; i < 5; i++) {
      const pts = [];
      for (let x = 0; x <= 40; x++) {
        pts.push(Math.sin(x * 0.35 + i * 2.1) * (18 - i * 2) + Math.sin(x * 0.13 + i) * (30 - i * 4));
      }
      layers.push(pts);
    }
    this.titleFx = (dt) => {
      t += dt;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = cv.clientWidth, H = cv.clientHeight;
      if (!W || !H) return;
      if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const sky = ctx.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, '#1b1410'); sky.addColorStop(0.55, '#2b2018'); sky.addColorStop(1, '#120d0a');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
      // 달
      ctx.fillStyle = 'rgba(240,225,190,.18)';
      ctx.beginPath(); ctx.arc(W * 0.78, H * 0.22, 70, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(245,232,200,.5)';
      ctx.beginPath(); ctx.arc(W * 0.78, H * 0.22, 46, 0, Math.PI * 2); ctx.fill();
      // 산 능선
      layers.forEach((pts, i) => {
        const baseY = H * (0.52 + i * 0.10);
        const alpha = 0.14 + i * 0.10;
        ctx.fillStyle = `rgba(${20 + i * 8},${16 + i * 6},${12 + i * 5},${alpha + 0.35})`;
        ctx.beginPath();
        ctx.moveTo(-20, H);
        for (let x = 0; x <= 40; x++) {
          const px = (x / 40) * (W + 40) - 20;
          const drift = Math.sin(t / (5000 + i * 1200) + x * 0.2) * 4;
          ctx.lineTo(px, baseY + pts[x] * 2.2 + drift);
        }
        ctx.lineTo(W + 20, H); ctx.closePath(); ctx.fill();
      });
      // 안개
      for (let i = 0; i < 4; i++) {
        const y = H * (0.55 + i * 0.09) + Math.sin(t / 3000 + i) * 6;
        ctx.fillStyle = `rgba(200,190,170,${0.030 + i * 0.006})`;
        ctx.fillRect(0, y, W, 34);
      }
      // 흩날리는 점 (눈/재)
      ctx.fillStyle = 'rgba(230,220,196,.30)';
      for (let i = 0; i < 60; i++) {
        const x = (i * 137 + t * 0.02 * (1 + (i % 3))) % W;
        const y = (i * 211 + t * 0.03 * (1 + (i % 4))) % H;
        ctx.fillRect(x, y, 1.6, 1.6);
      }
    };
  }

  // ============================================================
  //  새 게임
  // ============================================================
  newGameDialog() {
    const opts = { cityCount: 38, realmCount: 8, officerDensity: 6, difficulty: 2, seed: '' };
    const mk = (label, key, min, max, step, fmt) => {
      const val = el('span', { class: 'rng-val', text: fmt ? fmt(opts[key]) : String(opts[key]) });
      return el('div', { class: 'opt-row' }, [
        el('label', { text: label }),
        el('input', {
          type: 'range', min, max, step, value: opts[key],
          oninput: (e) => { opts[key] = +e.target.value; val.textContent = fmt ? fmt(opts[key]) : String(opts[key]); },
        }),
        val,
      ]);
    };
    const seedInput = el('input', { type: 'text', class: 'txt', placeholder: '비워두면 무작위', maxlength: 12 });
    const body = el('div', { class: 'newgame' }, [
      el('p', { class: 'hint', text: '세계·인물·보물·사건이 모두 새로 생성된다. 같은 시드를 넣으면 같은 난세가 다시 열린다.' }),
      mk('중원의 크기 (도시 수)', 'cityCount', 18, 52, 1),
      mk('할거하는 세력 수', 'realmCount', 3, 14, 1),
      mk('무장 밀도', 'officerDensity', 3, 10, 1, v => ['희박', '희박', '적음', '보통', '보통', '많음', '많음', '풍부', '풍부', '난립', '난립'][v]),
      mk('난이도', 'difficulty', 0, 4, 1, v => ['평온', '쉬움', '보통', '어려움', '난세'][v]),
      el('div', { class: 'opt-row' }, [el('label', { text: '시드' }), seedInput, el('span')]),
    ]);
    modal('새로운 난세', [body], [
      { label: '취소', cls: 'ghost' },
      { label: '천하를 열다', cls: 'primary', onClick: () => {
        let seed = seedInput.value.trim();
        let s = seed ? hashSeed(seed) : ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
        this.startNewGame({ ...opts, seed: s, seedText: seed });
      } },
    ], { wide: false });
  }

  startNewGame(opts) {
    this.audio.play('court', { force: true });
    const load = modal('천지가 열린다', [el('div', { class: 'loading' }, [
      el('div', { class: 'spinner' }), el('p', { text: '산과 강을 빚고, 성을 세우고, 사람을 부르는 중…' }),
    ])], [], { dismissible: false });

    setTimeout(() => {
      clearPortraitCache();
      this.game = new Game({
        seed: opts.seed,
        cityCount: opts.cityCount,
        realmCount: opts.realmCount,
        officerCount: Math.round(opts.cityCount * opts.officerDensity),
        difficulty: opts.difficulty,
      });
      load.close();
      this.chooseRuler();
    }, 60);
  }

  chooseRuler() {
    const g = this.game;
    const rows = g.realms.map(r => {
      const ruler = g.officerById[r.ruler];
      const p = g.realmPower(r);
      const cap = g.cityById[r.capital];
      const card = el('div', { class: 'ruler-card', onclick: () => { this.audio.sfx('seal'); pick(r); } }, [
        el('div', { class: 'rc-flag', style: { background: r.color } }, [r.name]),
        (() => { const w = el('div', { class: 'cvwrap' }); w.appendChild(portraitCanvas(ruler, 96)); return w; })(),
        el('div', { class: 'rc-body' }, [
          el('div', { class: 'rc-name' }, [
            el('b', { text: ruler.name }),
            el('span', { class: 'hanja', text: ruler.hanja }),
          ]),
          el('div', { class: 'rc-sub', text: `${ruler.courtesy} · ${ruler.age}세 · ${ruler.personalityName} · ${ruler.archetypeName}` }),
          el('div', { class: 'rc-stats' },
            [['통', ruler.lead], ['무', ruler.war], ['지', ruler.int], ['정', ruler.pol], ['매', ruler.cha]]
              .map(([k, v]) => el('span', { class: 'ms' }, [el('b', { text: k }), el('span', { text: String(v) })]))),
          el('div', { class: 'rc-nums' }, [
            el('span', { text: `도시 ${r.cities.length}` }),
            el('span', { text: `무장 ${g.officersOf(r.id).length}` }),
            el('span', { text: `본거 ${cap ? cap.name : '-'}` }),
            el('span', { text: `기풍 ${r.aiName}` }),
          ]),
          el('div', { class: 'rc-diff' }, [
            el('span', { text: '난이도' }),
            bar(Math.max(4, 100 - p / Math.max(1, Math.max(...g.realms.map(x => g.realmPower(x)))) * 100), 100, '#c8543a'),
          ]),
        ]),
      ]);
      return { card, p };
    }).sort((a, b) => b.p - a.p).map(x => x.card);

    const m = modal('군주를 고르시오', [
      el('p', { class: 'hint', text: '어느 기치 아래 천하를 도모하겠는가. 도시가 많을수록 수월하다.' }),
      el('div', { class: 'ruler-grid' }, rows),
    ], [{ label: '세계를 다시 빚는다', cls: 'ghost', onClick: () => this.showTitle() }],
      { wide: true, dismissible: false });

    const pick = (r) => {
      m.close();
      const g2 = this.game;
      r.isPlayer = true;
      g2.playerRealm = r.id;
      g2.playerOfficer = r.ruler;
      this.enterPlay();
    };
  }

  // ============================================================
  //  본편
  // ============================================================
  enterPlay() {
    const g = this.game;
    const L = this.layers.play;
    clear(L);

    this.mapCanvas = el('canvas', { class: 'world-canvas' });
    this.hud = el('div', { class: 'hud' });
    this.side = el('div', { class: 'sidebar' });
    this.bottom = el('div', { class: 'bottombar' });
    this.ticker = el('div', { class: 'ticker' });

    L.appendChild(el('div', { class: 'play-main' }, [
      el('div', { class: 'map-wrap' }, [this.mapCanvas, this.ticker]),
      this.side,
    ]));
    L.appendChild(this.hud);
    L.appendChild(this.bottom);
    this.show('play');

    this.map = new WorldMap(this.mapCanvas, g);
    this._bindMap();
    this.selectedCity = g.realmById[g.playerRealm].capital;
    this.map.selected = this.selectedCity;
    this.map.centerOn(g.cityById[this.selectedCity], false);
    this.newMonth();
    this.audio.play('gov', { force: true });
  }

  _bindMap() {
    const cv = this.mapCanvas;
    let drag = null;
    cv.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, ox: this.map.ox, oy: this.map.oy, moved: false };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      const r = cv.getBoundingClientRect();
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        this.map.ox = drag.ox + dx; this.map.oy = drag.oy + dy;
        this.map.panTarget = null;
        this.map.userMoved = true;
        this.map.clampView();
      } else {
        const c = this.map.cityAt(e.clientX - r.left, e.clientY - r.top);
        cv.style.cursor = c ? 'pointer' : 'grab';
      }
    });
    cv.addEventListener('pointerup', (e) => {
      const r = cv.getBoundingClientRect();
      if (drag && !drag.moved) {
        const c = this.map.cityAt(e.clientX - r.left, e.clientY - r.top);
        if (c) { this.selectCity(c.id); }
      }
      drag = null;
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      this.map.zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.14 : 1 / 1.14);
    }, { passive: false });
    window.addEventListener('resize', () => { if (this.map) this.map.clampView(); });
    window.addEventListener('keydown', (e) => {
      if (this.screen !== 'play' || this.battleScreen) return;
      if (e.key === 'Enter') { e.preventDefault(); this.nextMonth(); }
      if (e.key === 'f') { this.map.userMoved = false; this.map.fit(); }
      if (e.key === 'l') officerListDialog(this.game, this.audio);
      if (e.key === 'r') realmDialog(this.game, this.audio);
    });
  }

  selectCity(id) {
    this.selectedCity = id;
    this.map.selected = id;
    this.audio.sfx('click');
    this.renderSide();
  }

  newMonth() {
    const g = this.game;
    const r = g.realmById[g.playerRealm];
    if (r.income === undefined) {
      let inc = 0;
      for (const cid of r.cities) {
        const c = g.cityById[cid];
        inc += cityIncome(g, c) - cityUpkeep(g, c).gold;
      }
      r.income = inc;
    }
    this.ordersLeft = g.commandLimit(r);
    for (const o of g.officersOf(r.id)) o.status = 'idle';
    this.renderAll();
  }

  renderAll() { this.renderHud(); this.renderSide(); this.renderBottom(); }

  renderHud() {
    const g = this.game;
    const r = g.realmById[g.playerRealm];
    if (!r) return;
    const ruler = g.officerById[r.ruler];
    const cities = g.citiesOf(r.id);
    const food = cities.reduce((s, c) => s + c.food, 0);
    const troops = cities.reduce((s, c) => s + c.troops, 0);
    clear(this.hud);
    this.hud.appendChild(el('div', { class: 'hud-left' }, [
      el('div', { class: 'hud-date' }, [
        el('span', { class: 'hd-year', text: `${g.year}년` }),
        el('span', { class: 'hd-month', text: MONTH_NAMES[g.month] }),
        el('span', { class: 'hd-season', text: SEASONS[g.month] }),
      ]),
      el('div', { class: 'hud-realm', style: { borderColor: r.color } }, [
        el('span', { class: 'hr-flag', style: { background: r.color }, text: r.name }),
        el('span', { class: 'hr-ruler', text: ruler ? `${ruler.name} · ${rankFor(ruler.fame).name}` : '' }),
      ]),
    ]));
    this.hud.appendChild(el('div', { class: 'hud-stats' }, [
      hudStat('금', shortNum(r.gold), r.income >= 0 ? `+${shortNum(r.income || 0)}` : shortNum(r.income), '#d9b64e'),
      hudStat('병량', shortNum(food), '', '#8fae5e'),
      hudStat('병력', shortNum(troops), '', '#c8543a'),
      hudStat('도시', String(r.cities.length), `/${g.cities.length}`, '#6f9fd0'),
      hudStat('명성', num(Math.round(r.fame)), '', '#b07fd0'),
      hudStat('명령', `${this.ordersLeft}`, `/${g.commandLimit(r)}`, '#e0a24c'),
    ]));
    this.hud.appendChild(el('div', { class: 'hud-right' }, [
      el('button', { class: 'icon-btn', title: '무장 일람 (L)', onclick: () => { this.audio.sfx('page'); officerListDialog(g, this.audio); } }, ['人']),
      el('button', { class: 'icon-btn', title: '세력도 (R)', onclick: () => { this.audio.sfx('page'); realmDialog(g, this.audio); } }, ['勢']),
      el('button', { class: 'icon-btn', title: '보물', onclick: () => { this.audio.sfx('page'); itemListDialog(g, this.audio); } }, ['寶']),
      el('button', { class: 'icon-btn', title: '연대기', onclick: () => { this.audio.sfx('scroll'); chronicleDialog(g); } }, ['史']),
      el('button', { class: 'icon-btn', title: '설정', onclick: () => { this.audio.sfx('click'); this.settingsDialog(); } }, ['調']),
    ]));
  }

  renderSide() {
    const g = this.game;
    clear(this.side);
    const c = g.cityById[this.selectedCity];
    if (!c) return;
    const panel = cityPanel(g, c, {
      onOfficer: (o) => this.officerMenu(o, c),
      onItems: (city) => itemListDialog(g, this.audio, city),
    });
    this.side.appendChild(panel);

    // 도시 명령
    const mine = c.realm === g.playerRealm;
    const actions = el('div', { class: 'city-actions' });
    if (mine) {
      const enemies = adjacentEnemyCities(g, c, { realm: g.playerRealm });
      actions.appendChild(el('button', {
        class: 'btn wide primary', disabled: !enemies.length || c.troops < 500,
        onclick: () => this.sortieDialog(c),
      }, [enemies.length ? '출진 (出陣)' : '인접한 적이 없다']));
      actions.appendChild(el('button', {
        class: 'btn wide', onclick: () => this.transportDialog(c),
      }, ['수송 · 이동']));
    } else {
      actions.appendChild(el('div', { class: 'hint', text: '아군 도시가 아니다.' }));
    }
    this.side.appendChild(actions);
  }

  renderBottom() {
    const g = this.game;
    clear(this.bottom);
    this.bottom.appendChild(el('div', { class: 'bb-left' }, [
      el('button', { class: 'btn', onclick: () => { this.map.userMoved = false; this.map.fit(); this.audio.sfx('click'); } }, ['전도(全圖)']),
      el('button', { class: 'btn', onclick: () => { this.map.labelMode = !this.map.labelMode; this.audio.sfx('click'); } }, ['지명 표시']),
      el('button', { class: 'btn', onclick: () => this.saveDialog() }, ['저장']),
    ]));
    const r = g.realmById[g.playerRealm];
    const idle = g.officersOf(r.id).filter(o => o.status === 'idle' && o.injury < 60).length;
    this.bottom.appendChild(el('div', { class: 'bb-mid' }, [
      el('span', { class: 'bb-note', text: idle ? `대기 중인 무장 ${idle}명 · 남은 명령 ${this.ordersLeft}` : '모든 무장이 움직였다' }),
    ]));
    this.bottom.appendChild(el('div', { class: 'bb-right' }, [
      el('button', { class: 'btn big primary', onclick: () => this.nextMonth() }, ['다음 달 ▶ (Enter)']),
    ]));
  }

  tick(text, kind = 'info') {
    const line = el('div', { class: 'tick-line k-' + kind, text });
    this.ticker.appendChild(line);
    requestAnimationFrame(() => line.classList.add('show'));
    while (this.ticker.children.length > 5) this.ticker.firstChild.remove();
    setTimeout(() => { line.classList.remove('show'); setTimeout(() => line.remove(), 500); }, 5200);
  }

  // ── 무장 명령 ──
  officerMenu(o, city) {
    const g = this.game;
    if (o.realm !== g.playerRealm) {
      if (!o.realm) {
        // 재야 — 등용 시도
        const detail = officerDetail(g, o);
        return;
      }
      officerDetail(g, o);
      return;
    }
    if (o.prisoner) return this.prisonerMenu(o, city);

    const canAct = o.status === 'idle' && o.injury < 60 && this.ordersLeft > 0 && o.age >= 15;
    const grid = el('div', { class: 'cmd-grid' });
    const cats = [['gov', '내정'], ['mil', '군사'], ['per', '인사'], ['ploy', '계략']];
    for (const [cat, label] of cats) {
      const list = COMMANDS.filter(c => c.cat === cat);
      grid.appendChild(el('div', { class: 'cmd-cat' }, [
        el('h4', { text: label }),
        el('div', { class: 'cmd-btns' }, list.map(cmd => {
          const ok = (!cmd.can || cmd.can(g, city, o));
          const cost = cmd.cost ? cmd.cost(g, city, o) : {};
          const realm = g.realmById[g.playerRealm];
          const afford = (!cost.gold || realm.gold >= cost.gold) && (!cost.food || city.food >= cost.food);
          return el('button', {
            class: 'cmd-btn' + (!ok || !afford || !canAct ? ' dim' : ''),
            title: cmd.desc + (cost.gold ? `\n비용 ${cost.gold}금` : '') + (cost.food ? `\n병량 ${cost.food}` : ''),
            onclick: () => { if (ok && afford && canAct) this.runCommand(cmd, o, city, m); else this.audio.sfx('error'); },
          }, [
            el('span', { class: 'cb-icon', text: cmd.icon }),
            el('span', { class: 'cb-name', text: cmd.name }),
            el('span', { class: 'cb-cost', text: cost.gold ? `${cost.gold}금` : (cost.food ? `${shortNum(cost.food)}량` : '') }),
          ]);
        })),
      ]));
    }
    const e = g.eff(o);
    const m = modal(`${o.name} — 명령`, [
      el('div', { class: 'cmd-head' }, [
        (() => { const w = el('div', { class: 'cvwrap' }); w.appendChild(portraitCanvas(o, 72)); return w; })(),
        el('div', {}, [
          el('div', { class: 'ch-name', text: `${o.name} (${o.courtesy})` }),
          el('div', { class: 'ch-stats', text: `통 ${e.lead} · 무 ${e.war} · 지 ${e.int} · 정 ${e.pol} · 매 ${e.cha}` }),
          el('div', { class: 'ch-sub', text: `충성 ${o.loyalty} · 부상 ${Math.round(o.injury)}% · ${canAct ? '명령 가능' : (o.status !== 'idle' ? '이미 행동함' : o.injury >= 60 ? '부상 중' : '명령 횟수 소진')}` }),
        ]),
        el('button', { class: 'btn tiny', onclick: () => officerDetail(g, o) }, ['상세']),
      ]),
      grid,
    ], [{ label: '닫기', cls: 'ghost' }], { wide: true });
  }

  runCommand(cmd, o, city, m) {
    const g = this.game;
    // 대상이 필요한 명령
    if (cmd.needsTarget) {
      return this.targetPicker(cmd, o, city, (target) => {
        m.close();
        this._execute(cmd, o, city, target);
      });
    }
    m.close();
    this._execute(cmd, o, city, null);
  }

  _execute(cmd, o, city, target) {
    const g = this.game;
    // 등용은 설전으로
    if (cmd.id === 'recruit' && target) {
      const realm = g.realmById[g.playerRealm];
      const ruler = g.officerById[realm.ruler];
      const diff = Math.round(target.ambition * 3 + compatDistance(target.compat, ruler.compat) * 0.5
        - realm.fame * 0.02 + (target.personality === 'reclusive' ? 25 : 0));
      const cost = cmd.cost(g, city, o);
      if (realm.gold < (cost.gold || 0)) { toast('금이 부족하다.', 'warn'); return; }
      realm.gold -= cost.gold || 0;
      o.status = 'acted'; this.ordersLeft--;
      return debateDialog(g, this.audio, o.id, target.id, {
        title: `${target.name} 등용`, difficulty: diff,
        intro: `${o.name}이(가) ${target.name}을(를) 찾아가 뜻을 물었다.`,
      }).then(res => {
        if (res.win) {
          removeFromCity(g, target);
          target.realm = realm.id; target.city = city.id; city.officers.push(target.id);
          target.loyalty = Math.max(40, Math.min(100, 65 + (75 - compatDistance(target.compat, ruler.compat)) * 0.4));
          o.fame += 15;
          this.tick(`${target.name}이(가) 《${realm.name}》에 출사했다!`, 'good');
          this.audio.sfx('levelup');
        } else {
          this.tick(`${target.name}은(는) 응하지 않았다.`, 'bad');
        }
        this.renderAll();
      });
    }
    const res = execCommand(g, cmd.id, o, city, target);
    if (!res.ok) { toast(res.text, 'warn'); this.audio.sfx(res.sfx || 'error'); return; }
    this.ordersLeft--;
    this.audio.sfx(res.sfx || 'confirm');
    this.tick(res.text, res.kind || 'info');
    if (res.item) {
      const it = g.itemById[res.item];
      if (it) setTimeout(() => assignItem(g, this.audio, it, () => this.renderAll()), 320);
    }
    if (res.cityId) this.map.addArrow(city.id, res.cityId, '#b07fd0', 2000);
    this.renderAll();
  }

  targetPicker(cmd, o, city, onPick) {
    const g = this.game;
    let list = [], render = null, title = '대상 선택';
    if (cmd.needsTarget === 'freeOfficer') {
      list = g.officersIn(city.id).filter(x => !x.realm && !x.dead && x.age >= 15);
      title = '누구를 부를 것인가';
      render = (t) => officerCard(g, t, { onClick: () => { mm.close(); onPick(t); }, showLoyalty: false });
    } else if (cmd.needsTarget === 'ownOfficer') {
      list = g.officersIn(city.id).filter(x => x.realm === g.playerRealm && !x.prisoner);
      title = '누구에게 내릴 것인가';
      render = (t) => officerCard(g, t, { onClick: () => { mm.close(); onPick(t); } });
    } else if (cmd.needsTarget === 'enemyCity') {
      list = adjacentEnemyCities(g, city, o);
      title = '어느 성을 노리는가';
      render = (t) => {
        const r = t.realm ? g.realmById[t.realm] : null;
        return el('div', { class: 'pick-row', onclick: () => { mm.close(); onPick(t); } }, [
          el('span', { class: 'pr-flag', style: { background: r ? r.color : '#666' }, text: r ? r.name : '중립' }),
          el('b', { text: t.name }),
          el('span', { text: `병 ${shortNum(t.troops)} · 성벽 ${shortNum(t.wall)} · 민심 ${t.loyalty}` }),
        ]);
      };
    } else if (cmd.needsTarget === 'enemyOfficer') {
      list = enemyOfficersNear(g, city, o);
      title = '누구를 노리는가';
      render = (t) => {
        const r = t.realm ? g.realmById[t.realm] : null;
        const card = officerCard(g, t, { onClick: () => { mm.close(); onPick(t); }, showLoyalty: true });
        card.appendChild(el('div', { class: 'oc-where', text: (r ? r.name : '') + ' / ' + (g.cityById[t.city]?.name || '') }));
        return card;
      };
    }
    if (!list.length) { toast('대상이 없다.', 'warn'); return null; }
    const mm = modal(title, [el('div', { class: 'pick-list' }, list.map(render))],
      [{ label: '취소', cls: 'ghost' }], { wide: true });
    return mm;
  }

  prisonerMenu(o, city) {
    const g = this.game;
    const realm = g.realmById[g.playerRealm];
    const ruler = g.officerById[realm.ruler];
    modal(`포로 ${o.name}`, [
      el('div', { class: 'cmd-head' }, [
        (() => { const w = el('div', { class: 'cvwrap' }); w.appendChild(portraitCanvas(o, 72)); return w; })(),
        el('div', {}, [
          el('div', { class: 'ch-name', text: `${o.name} (${o.courtesy})` }),
          el('div', { class: 'ch-stats', text: `통 ${o.lead} · 무 ${o.war} · 지 ${o.int} · 정 ${o.pol} · 매 ${o.cha}` }),
          el('div', { class: 'ch-sub', text: `야망 ${o.ambition} · 의리 ${o.virtue} · 상성차 ${compatDistance(o.compat, ruler.compat)}` }),
        ]),
      ]),
    ], [
      { label: '등용한다', cls: 'primary', onClick: () => {
        const diff = Math.round(o.virtue * 4 + compatDistance(o.compat, ruler.compat) * 0.6 - realm.fame * 0.02);
        debateDialog(g, this.audio, ruler.id, o.id, {
          title: `${o.name} 항복 권유`, difficulty: diff,
          intro: `${ruler.name}이(가) 사로잡은 ${o.name}에게 뜻을 물었다.`,
        }).then(res => {
          if (res.win) {
            o.prisoner = false; o.realm = realm.id; o.loyalty = g.rng.range(45, 72);
            this.tick(`${o.name}이(가) 항복했다.`, 'good'); this.audio.sfx('levelup');
          } else {
            this.tick(`${o.name}은(는) 굽히지 않았다.`, 'bad');
          }
          this.renderAll();
        });
      } },
      { label: '풀어준다', cls: '', onClick: () => {
        o.prisoner = false; o.realm = null;
        removeFromCity(g, o);
        o.city = city.id; city.officers.push(o.id);
        g.freeOfficers.push(o.id);
        realm.fame += 15;
        this.tick(`${o.name}을(를) 풀어주었다. 의로움이 알려졌다. (명성 +15)`, 'info');
        this.audio.sfx('confirm'); this.renderAll();
      } },
      { label: '참한다', cls: 'danger', onClick: () => {
        killOfficer(g, o, '처형');
        realm.fame = Math.max(0, realm.fame - 25);
        for (const c of g.citiesOf(realm.id)) c.loyalty = Math.max(0, c.loyalty - 2);
        this.tick(`${o.name}을(를) 참했다. 인망이 상했다. (명성 -25)`, 'bad');
        this.audio.sfx('death'); this.renderAll();
      } },
      { label: '보류', cls: 'ghost' },
    ]);
  }

  // ── 출진 ──
  sortieDialog(city) {
    const g = this.game;
    const enemies = adjacentEnemyCities(g, city, { realm: g.playerRealm });
    const offs = g.officersIn(city.id).filter(o => o.realm === g.playerRealm && o.injury < 60 && !o.prisoner && o.age >= 15);
    if (!offs.length) { toast('출진할 무장이 없다.', 'warn'); return; }
    let target = enemies[0];
    let picked = new Set();
    let troops = Math.round(city.troops * 0.6);

    const tgtBox = el('div', { class: 'sortie-targets' });
    const offBox = el('div', { class: 'sortie-offs' });
    const summary = el('div', { class: 'sortie-sum' });
    const troopInput = el('input', {
      type: 'range', min: 500, max: Math.max(500, city.troops), step: 100, value: troops,
      oninput: (e) => { troops = +e.target.value; refresh(); },
    });

    function refresh() {
      tgtBox.innerHTML = '';
      for (const t of enemies) {
        const r = t.realm ? g.realmById[t.realm] : null;
        tgtBox.appendChild(el('div', {
          class: 'pick-row' + (t === target ? ' on' : ''),
          onclick: () => { target = t; refresh(); },
        }, [
          el('span', { class: 'pr-flag', style: { background: r ? r.color : '#666' }, text: r ? r.name : '중립' }),
          el('b', { text: t.name }),
          el('span', { text: `병 ${shortNum(t.troops)} · 성벽 ${shortNum(t.wall)} · 무장 ${g.officersIn(t.id).length}` }),
        ]));
      }
      offBox.innerHTML = '';
      for (const o of offs) {
        const card = officerCard(g, o, {
          selected: picked.has(o.id),
          onClick: () => {
            if (picked.has(o.id)) picked.delete(o.id);
            else if (picked.size < 6) picked.add(o.id);
            else toast('한 번에 여섯 명까지.', 'warn');
            refresh();
          },
        });
        offBox.appendChild(card);
      }
      const myPow = troops * (1 + city.train / 150) * (1 + city.morale / 200)
        + Array.from(picked).reduce((s, id) => s + combatRating(g.officerById[id]), 0) * 6;
      const defOff = g.officersIn(target.id);
      const foePow = target.troops * (1 + target.train / 150) * (1 + target.wall / 12000)
        + defOff.reduce((s, o) => s + combatRating(o), 0) * 6;
      const ratio = myPow / Math.max(1, foePow);
      const food = Math.round(troops * 25);
      summary.innerHTML = '';
      summary.appendChild(el('div', { class: 'ss-row' }, [
        el('span', { text: `투입 병력 ${num(troops)}` }),
        el('span', { text: `병량 소모 ${num(food)}` }),
        el('span', { text: `무장 ${picked.size}명` }),
      ]));
      summary.appendChild(el('div', { class: 'ss-odds' }, [
        el('span', { text: '전력비' }),
        bar(Math.min(100, ratio * 50), 100, ratio > 1.2 ? '#68c463' : ratio > 0.85 ? '#d8b23c' : '#d8503c'),
        el('b', { text: ratio >= 1.5 ? '압도적' : ratio >= 1.15 ? '우세' : ratio >= 0.85 ? '호각' : ratio >= 0.6 ? '열세' : '무모' }),
      ]));
      if (city.food < food) summary.appendChild(el('div', { class: 'warn-line', text: '병량이 부족하다!' }));
    }
    refresh();

    const m = modal(`${city.name} 출진`, [
      el('h4', { text: '목표' }), tgtBox,
      el('h4', { text: '출진 무장 (최대 6)' }), offBox,
      el('h4', { text: '병력' }),
      el('div', { class: 'troop-row' }, [troopInput]),
      summary,
    ], [
      { label: '취소', cls: 'ghost' },
      { label: '출진!', cls: 'primary', close: false, onClick: (close) => {
        if (!picked.size) { toast('무장을 골라야 한다.', 'warn'); return; }
        const food = Math.round(troops * 25);
        if (city.food < food) { toast('병량이 모자라 출진할 수 없다.', 'warn'); this.audio.sfx('error'); return; }
        if (this.ordersLeft <= 0) { toast('이 달의 명령을 다 썼다.', 'warn'); return; }
        city.troops -= troops; city.food -= food;
        for (const id of picked) { g.officerById[id].status = 'march'; }
        g.playerAttacks = g.playerAttacks || [];
        g.playerAttacks.push({
          realm: g.playerRealm, from: city.id, to: target.id,
          officers: Array.from(picked), troops, food,
        });
        this.ordersLeft--;
        this.map.addArrow(city.id, target.id, g.realmById[g.playerRealm].color, 60000);
        this.audio.sfx('horn');
        this.tick(`${city.name}에서 ${target.name}으로 출진했다. 이번 달 안에 전투가 벌어진다.`, 'good');
        close();
        this.renderAll();
      } },
    ], { wide: true });
  }

  transportDialog(city) {
    const g = this.game;
    const links = [...city.links, ...city.seaLinks]
      .map(l => g.cityById[l.to]).filter(c => c && c.realm === g.playerRealm);
    if (!links.length) { toast('연결된 아군 도시가 없다.', 'warn'); return; }
    let target = links[0];
    let gold = 0, food = 0, troops = 0;
    const picked = new Set();
    const box = el('div', {});

    const render = () => {
      box.innerHTML = '';
      box.appendChild(el('h4', { text: '보낼 곳' }));
      box.appendChild(el('div', { class: 'sortie-targets' }, links.map(t =>
        el('div', { class: 'pick-row' + (t === target ? ' on' : ''), onclick: () => { target = t; render(); } }, [
          el('b', { text: t.name }),
          el('span', { text: `병 ${shortNum(t.troops)} · 량 ${shortNum(t.food)}` }),
        ]))));
      box.appendChild(el('h4', { text: '물자' }));
      box.appendChild(sliderRow('병량', 0, city.food, food, v => { food = v; }));
      box.appendChild(sliderRow('병력', 0, Math.max(0, city.troops - 200), troops, v => { troops = v; }));
      box.appendChild(el('h4', { text: '동행 무장' }));
      box.appendChild(el('div', { class: 'sortie-offs' },
        g.officersIn(city.id).filter(o => o.realm === g.playerRealm && !o.prisoner).map(o =>
          officerCard(g, o, {
            selected: picked.has(o.id),
            onClick: () => { picked.has(o.id) ? picked.delete(o.id) : picked.add(o.id); render(); },
          }))));
    };
    function sliderRow(label, min, max, val, onch) {
      const v = el('span', { class: 'rng-val', text: shortNum(val) });
      return el('div', { class: 'opt-row' }, [
        el('label', { text: label }),
        el('input', {
          type: 'range', min, max: Math.max(min, max), value: val, step: Math.max(1, Math.round(max / 100)),
          oninput: (e) => { onch(+e.target.value); v.textContent = shortNum(+e.target.value); },
        }), v,
      ]);
    }
    render();
    modal(`${city.name} 수송 · 이동`, [box], [
      { label: '취소', cls: 'ghost' },
      { label: '보낸다', cls: 'primary', onClick: () => {
        if (this.ordersLeft <= 0) { toast('이 달의 명령을 다 썼다.', 'warn'); return; }
        const carrier = Array.from(picked)[0] ? g.officerById[Array.from(picked)[0]] : null;
        const logi = carrier && carrier.traits.includes('logistics');
        const lossRate = logi ? 0 : (g.rng.percent(12) ? g.rng.range(5, 20) / 100 : 0);
        const f = Math.round(food * (1 - lossRate)), t = Math.round(troops * (1 - lossRate));
        city.food -= food; city.troops -= troops;
        target.food += f; target.troops += t;
        for (const id of picked) {
          const o = g.officerById[id];
          removeFromCity(g, o); o.city = target.id; target.officers.push(o.id); o.status = 'acted';
        }
        this.ordersLeft--;
        this.map.addArrow(city.id, target.id, '#8fae5e', 2400);
        this.audio.sfx('confirm');
        this.tick(lossRate > 0
          ? `수송 중 도적을 만나 ${Math.round(lossRate * 100)}%를 잃었다.`
          : `${target.name}으로 물자를 보냈다.`, lossRate > 0 ? 'bad' : 'good');
        this.renderAll();
      } },
    ], { wide: true });
  }

  // ── 달 넘기기 ──
  nextMonth() {
    if (this.busy) return;
    const g = this.game;
    this.busy = true;
    this.audio.sfx('drum');
    const report = advanceMonth(g, { onPlayerBattle: true });

    const after = () => {
      this.busy = false;
      if (g.gameOver) return this.endGame();
      this.newMonth();
      // 계절 음악
      const r = g.realmById[g.playerRealm];
      const threat = g.realms.some(x => !x.dead && x !== r && g.realmPower(x) > g.realmPower(r) * 1.8);
      const mood = g.month === 0 ? 'newyear' : threat ? 'tense' : (g.month >= 8 ? 'night' : 'gov');
      this.audio.play(mood);
      this.renderAll();
    };

    const showReport = () => {
      if (this.settings.autoReport && (report.events.length || report.logs.some(l => !l.quiet))) {
        const bg = report.events.find(e => e.bgm);
        if (bg) this.audio.play(bg.bgm);
        reportDialog(g, this.audio, report, after);
      } else {
        for (const l of report.logs) if (!l.quiet) this.tick(l.text, l.kind);
        after();
      }
    };

    if (report.playerBattle) {
      const pb = report.playerBattle;
      const side = pb.setup.attackerRealm === g.playerRealm ? 'atk' : 'def';
      this.startBattle(pb.setup, pb.atk, side, showReport);
    } else {
      showReport();
    }
  }

  startBattle(setup, atk, side, onDone) {
    const g = this.game;
    const bs = new BattleScreen(this, setup, side);
    this.battleScreen = bs;
    bs.done = (battle) => {
      this.battleScreen = null;
      const res = finishBattle(g, battle, setup, atk);
      for (const l of res.logs) g.pushLog(l.text, l.kind, l);
      for (const l of res.logs) this.tick(l.text, l.kind);
      // 남은 AI 전투 처리
      if (g.pendingBattle) g.pendingBattle = null;
      this.audio.play('gov', { force: true });
      // 포로 처리
      const mine = res.captured.map(id => g.officerById[id]).filter(o => o && o.realm === g.playerRealm && o.prisoner);
      const proceed = () => { onDone && onDone(); };
      if (mine.length) {
        let i = 0;
        const nextP = () => {
          if (i >= mine.length) return proceed();
          const o = mine[i++];
          const c = g.cityById[o.city];
          this.prisonerMenu(o, c);
          setTimeout(nextP, 100);
        };
        nextP();
      } else proceed();
    };
  }

  endGame() {
    const g = this.game;
    const win = g.gameOver.win;
    this.audio.play(win ? 'unify' : 'fall', { force: true });
    this.audio.sfx(win ? 'cheer' : 'death');
    const r = g.realmById[g.playerRealm];
    modal(win ? '천하통일' : '멸망', [
      el('div', { class: 'ending ' + (win ? 'win' : 'lose') }, [
        el('div', { class: 'end-big', text: win ? '天下統一' : '滅' }),
        el('p', { text: g.gameOver.reason }),
        el('div', { class: 'end-stats' }, [
          el('div', { text: `${g.year}년 ${MONTH_NAMES[g.month]}` }),
          el('div', { text: `치세 ${g.turnNo}개월` }),
          el('div', { text: `승리 ${r?.stats.battlesWon ?? 0}회 · 함락 ${r?.stats.citiesTaken ?? 0}성` }),
          el('div', { text: `최종 명성 ${num(Math.round(r?.fame ?? 0))}` }),
        ]),
      ]),
    ], [
      { label: '연대기를 본다', cls: '', close: false, onClick: () => chronicleDialog(g) },
      { label: '처음으로', cls: 'primary', onClick: () => { this.game = null; this.map = null; this.showTitle(); } },
    ], { dismissible: false });
  }

  // ── 저장/불러오기 ──
  saveDialog() {
    const g = this.game;
    const slots = listSaves();
    const rows = [];
    for (let i = 0; i < 6; i++) {
      const s = slots[i];
      rows.push(el('div', { class: 'save-row' }, [
        el('div', { class: 'sr-info' }, [
          el('b', { text: `기록 ${i + 1}` }),
          el('span', { text: s ? `${s.label} · ${s.date}` : '— 비어 있음 —' }),
        ]),
        el('button', { class: 'btn tiny primary', onclick: () => {
          try {
            saveGame(i, g, `${g.year}년 ${MONTH_NAMES[g.month]} · ${g.realmById[g.playerRealm]?.name}`);
            toast('기록했다.', 'good'); this.audio.sfx('seal'); m.close();
          } catch (e) { toast('저장에 실패했다: ' + e.message, 'bad'); }
        } }, ['저장']),
        s ? el('button', { class: 'btn tiny danger', onclick: () => { deleteSave(i); m.close(); this.saveDialog(); } }, ['삭제']) : null,
      ]));
    }
    const m = modal('기록', rows, [{ label: '닫기', cls: 'ghost' }]);
  }

  loadDialog() {
    const slots = listSaves();
    const rows = [];
    for (let i = 0; i < 6; i++) {
      const s = slots[i];
      rows.push(el('div', { class: 'save-row' + (s ? '' : ' empty') }, [
        el('div', { class: 'sr-info' }, [
          el('b', { text: `기록 ${i + 1}` }),
          el('span', { text: s ? `${s.label} · ${s.date}` : '— 비어 있음 —' }),
        ]),
        s ? el('button', { class: 'btn tiny primary', onclick: () => {
          try {
            const g = loadGame(i);
            clearPortraitCache();
            this.game = g;
            m.close();
            this.enterPlay();
            toast('기록을 불러왔다.', 'good');
          } catch (e) { toast('불러오기 실패: ' + e.message, 'bad'); }
        } }, ['불러오기']) : null,
      ]));
    }
    const m = modal('이어하기', rows, [{ label: '닫기', cls: 'ghost' }]);
  }

  // ── 설정 ──
  settingsDialog() {
    const s = this.settings;
    const mkSlider = (label, key, onch) => {
      const val = el('span', { class: 'rng-val', text: Math.round(s[key] * 100) + '%' });
      return el('div', { class: 'opt-row' }, [
        el('label', { text: label }),
        el('input', {
          type: 'range', min: 0, max: 100, value: Math.round(s[key] * 100),
          oninput: (e) => {
            s[key] = +e.target.value / 100;
            val.textContent = e.target.value + '%';
            onch();
            this.saveSettings();
          },
        }),
        val,
      ]);
    };
    const nowPlaying = el('div', { class: 'now-playing' });
    const updateNP = () => {
      const c = this.audio.current;
      nowPlaying.textContent = c ? `연주 중 — ${c.score.composer} 「${c.score.title}」` : '연주 없음';
    };
    updateNP();
    this.audio.onTrackChange = updateNP;

    const trackList = el('div', { class: 'track-list' },
      (this.audio.constructor.name ? [] : []));
    import('./audio/scores.js').then(mod => {
      for (const sc of mod.SCORES) {
        trackList.appendChild(el('button', {
          class: 'track-btn', onclick: () => { this.audio.play(sc.id, { force: true }); updateNP(); },
        }, [
          el('b', { text: sc.title }),
          el('span', { text: sc.composer }),
        ]));
      }
    });

    modal('설정', [
      el('div', { class: 'settings' }, [
        el('h4', { text: '소리' }),
        mkSlider('배경음악', 'bgm', () => this.audio.setBgmVolume(s.bgm)),
        mkSlider('효과음', 'sfx', () => { this.audio.setSfxVolume(s.sfx); this.audio.sfx('click'); }),
        el('div', { class: 'opt-row' }, [
          el('label', { text: '전체 음소거' }),
          el('input', {
            type: 'checkbox', checked: s.muted ? 'checked' : null,
            onchange: (e) => { s.muted = e.target.checked; this.audio.setMuted(s.muted); this.saveSettings(); },
          }),
          el('span'),
        ]),
        el('div', { class: 'opt-row' }, [
          el('label', { text: '월간 보고 창' }),
          el('input', {
            type: 'checkbox', checked: s.autoReport ? 'checked' : null,
            onchange: (e) => { s.autoReport = e.target.checked; this.saveSettings(); },
          }),
          el('span'),
        ]),
        nowPlaying,
        el('h4', { text: '악곡 — 모두 퍼블릭 도메인 고전 음악을 실시간 합성' }),
        trackList,
      ]),
    ], [{ label: '닫기', cls: 'ghost' }], { wide: true });
  }

  helpDialog() {
    modal('유람 안내', [
      el('div', { class: 'help' }, [
        el('h4', { text: '이 게임은' }),
        el('p', { text: '매번 새로운 대륙이 생성된다. 산과 강, 성과 가도, 사람과 보물, 그리고 그들이 품은 꿈까지 전부 그때그때 만들어진다. 두 번 같은 천하는 없다.' }),
        el('h4', { text: '한 달의 흐름' }),
        el('p', { text: '① 도시를 골라 무장에게 명령을 내린다 (명령 횟수는 세력 명성에 따라 정해진다).\n② 인접한 적성을 노린다면 「출진」으로 군을 낸다.\n③ 「다음 달」을 누르면 명령이 실행되고, 각 세력의 AI가 움직이며, 사건이 일어난다.' }),
        el('h4', { text: '전투' }),
        el('p', { text: '전장은 그 성 주변 지형·계절·날씨에 따라 매번 새로 만들어진다. 진형과 병과 상성(기병>궁병>보병>기병)을 살피고, 지력이 높은 무장은 화계·수계·매복을 쓸 수 있다. 근접전에서는 일기토가 벌어지기도 한다.' }),
        el('h4', { text: '사람' }),
        el('p', { text: '무장은 저마다 상성·야망·의리·꿈을 지닌다. 군주와 상성이 맞으면 충성이 오르고, 꿈을 이루면 목숨을 걸고 따른다. 반대로 야망이 크고 충성이 낮으면 모반한다.' }),
        el('h4', { text: '단축키' }),
        el('p', { text: 'Enter 다음 달 · L 무장 일람 · R 세력도 · F 전도 · 마우스 휠 확대/축소 · 드래그 지도 이동' }),
      ]),
    ], [{ label: '닫기', cls: 'ghost' }], { wide: true });
  }
}

function hudStat(name, value, sub, color) {
  return el('div', { class: 'hud-stat' }, [
    el('span', { class: 'hs-n', text: name }),
    el('span', { class: 'hs-v', style: { color }, text: value }),
    sub ? el('span', { class: 'hs-s', text: sub }) : null,
  ]);
}

function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

window.addEventListener('DOMContentLoaded', () => { window.APP = new App(); });
