'use strict';
/* main.js — 설정 화면, 전차 격납고, 게임 HUD, 입력 */
(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const MODES = [
    { id: 'ffa', label: '개인전', teams: 0 },
    { id: 'team2', label: '2팀전', teams: 2 },
    { id: 'team3', label: '3팀전', teams: 3 },
  ];
  const DIFFS = [
    { id: 'easy', label: '쉬움' },
    { id: 'normal', label: '보통' },
    { id: 'hard', label: '어려움' },
  ];

  const setup = { count: 4, mode: 'ffa', difficulty: 'normal', theme: 'random', slots: [] };
  let game = null;
  let lastCfg = null;
  let activePilot = 0;
  let detailId = TANK_TYPES[0].id;
  let clsFilter = 'all';
  let detailRaf = 0;
  let audioStarted = false;

  /* ─────────────── 오디오 시동 (첫 클릭) ─────────────── */
  function bootAudio() {
    if (audioStarted) return;
    audioStarted = true;
    AudioCore.resume();
    if (typeof Music !== 'undefined' && Music.start) {
      Music.onTrack = (tr) => { const el = $('#npText'); if (el && tr) el.textContent = `${tr.title} · ${tr.composer}`; };
      Music.start();
    }
  }
  window.addEventListener('pointerdown', bootAudio, { once: true });
  window.addEventListener('keydown', bootAudio, { once: true });

  /* ═══════════════ 설정 화면 ═══════════════ */

  function themeOptions() {
    const list = [{ id: 'random', label: '무작위' }];
    const themes = (typeof Gfx !== 'undefined' && Gfx.THEMES) ? Gfx.THEMES : {};
    for (const k in themes) list.push({ id: k, label: themes[k].name || k });
    return list;
  }

  function teamCount() { return (MODES.find((m) => m.id === setup.mode) || MODES[0]).teams; }

  function seg(el, items, getter, setter) {
    if (!el) return;
    el.innerHTML = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn' + (getter() === it.id ? ' is-active' : '');
      b.textContent = it.label;
      b.addEventListener('click', () => { setter(it.id); if (typeof Sfx !== 'undefined' && Sfx.click) Sfx.click(); renderMenu(); });
      el.appendChild(b);
    }
  }

  function syncSlots() {
    const tc = teamCount();
    while (setup.slots.length < setup.count) {
      const i = setup.slots.length;
      setup.slots.push({
        name: i === 0 ? '플레이어' : `AI ${i}`,
        type: i === 0 ? 'human' : 'ai',
        team: 0,
        tank: TANK_TYPES[Math.floor(Math.random() * TANK_TYPES.length)].id,
      });
    }
    setup.slots.length = setup.count;
    if (tc > 0) setup.slots.forEach((s, i) => { if (s.team >= tc) s.team = i % tc; });
    if (activePilot >= setup.count) activePilot = 0;
  }

  function assignTeamsRoundRobin() {
    const tc = teamCount();
    if (tc > 0) setup.slots.forEach((s, i) => { s.team = i % tc; });
  }

  function renderSlots() {
    const tc = teamCount();
    const wrap = $('#slots');
    wrap.innerHTML = '';
    setup.slots.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'slot';

      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = PLAYER_COLORS[i];

      const name = document.createElement('input');
      name.value = s.name;
      name.maxLength = 10;
      name.placeholder = `플레이어 ${i + 1}`;
      name.addEventListener('input', () => { s.name = name.value; renderPilots(); });

      const type = document.createElement('select');
      type.innerHTML = '<option value="human">사람</option><option value="ai">AI</option>';
      type.value = s.type;
      type.addEventListener('change', () => {
        s.type = type.value;
        if (s.type === 'ai' && /^플레이어/.test(s.name)) { s.name = `AI ${i}`; name.value = s.name; }
        if (s.type === 'human' && /^AI/.test(s.name)) { s.name = '플레이어'; name.value = s.name; }
        updateHint(); renderPilots();
      });

      row.append(sw, name, type);

      if (tc > 0) {
        const team = document.createElement('select');
        for (let k = 0; k < tc; k++) {
          const o = document.createElement('option');
          o.value = String(k); o.textContent = `${TEAM_LABELS[k]}팀`;
          team.appendChild(o);
        }
        team.value = String(s.team);
        team.addEventListener('change', () => { s.team = +team.value; updateHint(); renderPilots(); });
        row.appendChild(team);
      }
      wrap.appendChild(row);
    });
    updateHint();
  }

  function updateHint() {
    const humans = setup.slots.filter((s) => s.type === 'human').length;
    const tc = teamCount();
    let txt = humans === 0 ? '관전 모드 (AI 대 AI)' : `사람 ${humans} · AI ${setup.count - humans}`;
    if (tc > 0) {
      const sizes = Array.from({ length: tc }, (_, k) => setup.slots.filter((s) => s.team === k).length);
      txt += ' · ' + sizes.map((n, k) => `${TEAM_LABELS[k]}${n}`).join(':');
    }
    $('#slotsHint').textContent = txt;
  }

  function renderMenu() {
    syncSlots();
    seg($('#segCount'), [2, 3, 4, 5, 6].map((n) => ({ id: n, label: `${n}인` })), () => setup.count,
      (v) => { setup.count = v; syncSlots(); assignTeamsRoundRobin(); });
    seg($('#segMode'), MODES, () => setup.mode,
      (v) => { setup.mode = v; syncSlots(); assignTeamsRoundRobin(); });
    seg($('#segDiff'), DIFFS, () => setup.difficulty, (v) => { setup.difficulty = v; });
    seg($('#segTheme'), themeOptions(), () => setup.theme, (v) => { setup.theme = v; });
    renderSlots();
  }

  function validate() {
    const tc = teamCount();
    if (tc > 0) {
      const used = new Set(setup.slots.map((s) => s.team));
      if (used.size < 2) return '팀전은 서로 다른 팀이 2개 이상 필요합니다.';
      if (setup.count < 2) return '2명 이상이어야 합니다.';
    }
    return null;
  }

  /* ═══════════════ 격납고 (전차 선택) ═══════════════ */

  function drawTankInto(cv, typeId, color, opts) {
    const c = cv.getContext('2d');
    const type = tankType(typeId);
    const art = TankArt.get(typeId);
    opts = opts || {};
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cv.width, cv.height);

    const scale = (opts.scale || 2) * type.size;
    const gy = cv.height * (opts.groundY || 0.74);

    // 바닥 그림자 + 받침대
    c.save();
    c.fillStyle = 'rgba(0,0,0,0.4)';
    c.beginPath();
    c.ellipse(cv.width / 2, gy + 3, 34 * scale * 0.55, 6 * scale * 0.35, 0, 0, Math.PI * 2);
    c.fill();
    c.restore();

    c.save();
    c.translate(cv.width / 2, gy);
    c.scale(scale, scale);
    const st = {
      p: TankArt.pal(color), color, roll: opts.roll || 0, t: opts.t || 0,
      dead: false, hpFrac: 1, charge: opts.charge || 0,
      len: (art && art.barrelLen) || type.barrel,
    };
    try {
      if (art && art.draw) art.draw(c, st);
      else { TankArt.box(c, -16, -12, 32, 12, 4, { p: st.p }); TankArt.box(c, -12, -23, 24, 12, 5, { p: st.p, fill: color }); }
      c.save();
      const piv = (art && art.pivot) || [2, -19];
      c.translate(piv[0], piv[1]);
      c.rotate((-(opts.elev != null ? opts.elev : 32) * Math.PI) / 180);
      if (art && art.barrel) art.barrel(c, st);
      else TankArt.barrelStd(c, st, {});
      c.restore();
    } catch (e) {
      c.restore();
      c.fillStyle = color;
      c.fillRect(-14, -20, 28, 20);
      return;
    }
    c.restore();
  }

  function statBars(type) {
    const norm = (v, lo, hi) => clamp((v - lo) / (hi - lo), 0.04, 1);
    return [
      { key: '체력', v: norm(type.hp, 76, 148), text: String(type.hp) },
      { key: '방어', v: norm(1.24 - type.armor, 0, 0.46), text: `${Math.round((1.24 - type.armor) * 220)}` },
      { key: '기동', v: norm(type.fuel, 80, 215), text: String(type.fuel) },
      { key: '사거리', v: norm(type.power, 0.93, 1.09), text: `${Math.round(type.power * 100)}` },
    ];
  }

  function renderPilots() {
    const strip = $('#pilotStrip');
    strip.innerHTML = '';
    setup.slots.forEach((s, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pilot' + (i === activePilot ? ' is-active' : '');
      const tt = tankType(s.tank);
      b.innerHTML =
        `<span class="dot" style="background:${PLAYER_COLORS[i]}"></span>` +
        `<span><span class="p-name">${esc(s.name)}</span><br><span class="p-tank">${esc(tt.name)}</span></span>` +
        `<span class="p-kind">${s.type === 'ai' ? 'AI' : '사람'}</span>`;
      b.addEventListener('click', () => {
        activePilot = i;
        detailId = s.tank;
        renderPilots(); renderGrid(); renderDetail();
        if (typeof Sfx !== 'undefined' && Sfx.click) Sfx.click();
      });
      strip.appendChild(b);
    });
  }

  function renderFilter() {
    const wrap = $('#clsFilter');
    wrap.innerHTML = '';
    const opts = [{ id: 'all', label: `전체 ${TANK_TYPES.length}종` }].concat(
      Object.keys(TANK_CLASSES).map((k) => ({ id: k, label: TANK_CLASSES[k].label }))
    );
    for (const o of opts) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn' + (clsFilter === o.id ? ' is-active' : '');
      b.textContent = o.label;
      b.addEventListener('click', () => { clsFilter = o.id; renderFilter(); renderGrid(); });
      wrap.appendChild(b);
    }
  }

  function renderGrid() {
    const grid = $('#tankGrid');
    grid.innerHTML = '';
    const color = PLAYER_COLORS[activePilot];
    const list = TANK_TYPES.filter((t) => clsFilter === 'all' || t.cls === clsFilter);
    for (const type of list) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'tank-card' + (type.id === detailId ? ' is-sel' : '');
      card.dataset.id = type.id;

      const cv = document.createElement('canvas');
      cv.width = 220; cv.height = 132;
      card.appendChild(cv);

      const cls = TANK_CLASSES[type.cls];
      const nm = document.createElement('span');
      nm.className = 'c-name';
      nm.textContent = type.name;
      const meta = document.createElement('span');
      meta.className = 'c-meta';
      meta.innerHTML = `<span class="cls-chip" style="background:${cls.color}">${cls.label}</span>` +
        `<span class="p-tank">${type.weapons.slice(1).map((w) => WEAPONS[w].icon).join(' ')}</span>`;
      card.append(nm, meta);

      const takenBy = setup.slots.map((s, i) => (s.tank === type.id ? i : -1)).filter((i) => i >= 0);
      if (takenBy.length) {
        const tag = document.createElement('span');
        tag.className = 'c-taken';
        tag.style.color = PLAYER_COLORS[takenBy[0]];
        tag.textContent = takenBy.map((i) => `P${i + 1}`).join(',');
        card.appendChild(tag);
      }

      card.addEventListener('click', () => pickTank(type.id, true));
      card.addEventListener('mouseenter', () => { detailId = type.id; renderDetail(); markSelected(); });
      grid.appendChild(card);
      drawTankInto(cv, type.id, color, { scale: 2.05, elev: 30, groundY: 0.78 });
    }
  }

  function markSelected() {
    $$('#tankGrid .tank-card').forEach((c) => c.classList.toggle('is-sel', c.dataset.id === detailId));
  }

  function renderDetail() {
    const type = tankType(detailId);
    const cls = TANK_CLASSES[type.cls];
    $('#detailName').textContent = type.name;
    $('#detailDesc').textContent = type.desc + (type.traits.length ? `  [${type.traits.join(' · ')}]` : '');
    const chip = $('#detailCls');
    chip.textContent = cls.label;
    chip.style.background = cls.color;

    const sl = $('#detailStats');
    sl.innerHTML = '';
    for (const s of statBars(type)) {
      const d = document.createElement('div');
      d.className = 'stat';
      d.innerHTML = `<span>${s.key}</span><span class="stat-bar"><i style="width:${(s.v * 100).toFixed(0)}%"></i></span><b>${s.text}</b>`;
      sl.appendChild(d);
    }

    const wl = $('#detailWeapons');
    wl.innerHTML = '';
    for (const id of type.weapons) {
      const w = WEAPONS[id];
      const d = document.createElement('div');
      d.className = 'wpn-row';
      d.innerHTML = `<span class="w-ico">${w.icon}</span>` +
        `<span class="w-txt"><b>${w.name}</b><small>${esc(w.desc)}</small></span>` +
        `<span class="w-amt">${w.ammo === Infinity ? '∞' : w.ammo + '발'}</span>`;
      wl.appendChild(d);
    }
    markSelected();
  }

  function animateDetail() {
    cancelAnimationFrame(detailRaf);
    const cv = $('#detailCanvas');
    const t0 = performance.now();
    const step = (now) => {
      if (!$('#garage').classList.contains('is-active')) return;
      const t = (now - t0) / 1000;
      drawTankInto(cv, detailId, PLAYER_COLORS[activePilot], {
        scale: 3.5, elev: 28 + Math.sin(t * 0.9) * 16, roll: t * 26, t, groundY: 0.8,
      });
      detailRaf = requestAnimationFrame(step);
    };
    detailRaf = requestAnimationFrame(step);
  }

  function pickTank(id, advance) {
    setup.slots[activePilot].tank = id;
    detailId = id;
    if (typeof Sfx !== 'undefined' && Sfx.select) Sfx.select();
    if (advance) {
      const next = (activePilot + 1) % setup.count;
      activePilot = next;
    }
    renderPilots(); renderGrid(); renderDetail();
  }

  function openGarage() {
    const err = validate();
    if (err) { const e = $('#menuError'); e.textContent = err; e.hidden = false; return; }
    $('#menuError').hidden = true;
    activePilot = 0;
    detailId = setup.slots[0].tank;
    showScreen('garage');
    renderPilots(); renderFilter(); renderGrid(); renderDetail(); animateDetail();
  }

  function randomizeAll() {
    for (const s of setup.slots) s.tank = TANK_TYPES[Math.floor(Math.random() * TANK_TYPES.length)].id;
    detailId = setup.slots[activePilot].tank;
    if (typeof Sfx !== 'undefined' && Sfx.select) Sfx.select();
    renderPilots(); renderGrid(); renderDetail();
  }

  /* ═══════════════ 화면 전환 ═══════════════ */

  function showScreen(id) {
    for (const s of ['menu', 'garage', 'game']) {
      $('#' + s).classList.toggle('is-active', s === id);
    }
    if (id !== 'garage') cancelAnimationFrame(detailRaf);
  }

  function buildConfig() {
    const tc = teamCount();
    return {
      players: setup.slots.map((s, i) => ({
        name: (s.name || '').trim() || (s.type === 'ai' ? `AI ${i}` : `플레이어 ${i + 1}`),
        isAI: s.type === 'ai',
        team: tc > 0 ? s.team : i,
        color: PLAYER_COLORS[i],
        typeId: s.tank,
      })),
      difficulty: setup.difficulty,
      theme: setup.theme === 'random' ? null : setup.theme,
      teamMode: tc > 0,
    };
  }

  function startGame(cfg) {
    lastCfg = cfg;
    if (game) game.destroy();
    showScreen('game');
    $('#gameover').hidden = true;
    fitCanvas();
    game = new Game($('#canvas'), cfg, ui);
    window.__game = game;
    renderWeapons();
  }

  function quitToMenu() {
    if (game) { game.destroy(); game = null; }
    $('#gameover').hidden = true;
    showScreen('menu');
    renderMenu();
  }

  /* ═══════════════ 캔버스 크기 ═══════════════ */

  function fitCanvas() {
    const stage = $('#stage'), inner = $('#stageInner');
    const aw = stage.clientWidth, ah = stage.clientHeight;
    if (!aw || !ah) return;
    let w = aw, h = aw / 2;
    if (h > ah) { h = ah; w = ah * 2; }
    inner.style.width = `${Math.floor(w)}px`;
    inner.style.height = `${Math.floor(h)}px`;
  }
  window.addEventListener('resize', fitCanvas);

  /* ═══════════════ 게임 HUD ═══════════════ */

  let bannerTimer = null;

  const ui = {
    onTurn(g) {
      const t = g.cur;
      $('#hudDot').style.background = t.color;
      $('#hudName').textContent = t.name;
      $('#hudTank').textContent = t.type.name;
      $('#hudRound').textContent = g.round;
      const tb = $('#hudTeam');
      tb.hidden = !g.teamMode;
      if (g.teamMode) { tb.textContent = `${TEAM_LABELS[t.team]}팀`; tb.style.background = t.color; }
      $('#hudYou').hidden = t.isAI;
      $('#pmark').style.left = `${t.lastPower != null ? t.lastPower : -10}%`;
      $('#pad').classList.toggle('is-disabled', t.isAI);
      renderWeapons();
      renderRoster();
    },
    refresh() { renderWeapons(); renderRoster(); },
    frame(g) {
      const t = g.cur;
      if (!t) return;
      $('#hudAngle').textContent = `${Math.round(t.elev)}° ${t.facing === 1 ? '▶' : '◀'}`;
      $('#hudPower').textContent = Math.round(t.power);
      $('#pfill').style.width = `${t.power}%`;
      $('#ffill').style.width = `${(t.fuel / t.maxFuel) * 100}%`;
      drawWind(g.wind);
      $('#hudWind').textContent = Math.abs(g.wind).toFixed(1);
      const left = Math.max(0, Math.ceil(g.turnLeft));
      $('#hudTimer').textContent = left;
      $('#timerRing').style.strokeDashoffset = (97.4 * (1 - Math.max(0, g.turnLeft) / TURN_SECONDS)).toFixed(1);
      $('.timer-box').classList.toggle('is-low', left <= 6);
    },
    banner(text, ms) {
      const b = $('#banner');
      b.textContent = text;
      b.hidden = false;
      b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop');
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => { b.hidden = true; }, ms);
    },
    onGameOver(g) { setTimeout(() => showGameOver(g), 1000); },
  };

  function renderWeapons() {
    if (!game || !game.cur) return;
    const t = game.cur;
    const wrap = $('#weapons');
    wrap.innerHTML = '';
    t.weapons.forEach((id, i) => {
      const w = WEAPONS[id];
      const ammo = t.ammo[id];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wpn' + (t.weapon === i ? ' is-active' : '') + (ammo <= 0 ? ' is-empty' : '');
      b.title = `${w.name} — ${w.desc}`;
      b.innerHTML = `<span class="w-key">${i + 1}</span><span class="w-icon">${w.icon}</span>` +
        `<span class="w-name">${w.name}</span><span class="w-ammo">${ammo === Infinity ? '∞' : ammo}</span>`;
      b.addEventListener('click', () => game && game.selectWeapon(i));
      wrap.appendChild(b);
    });
  }

  function renderRoster() {
    if (!game) return;
    const r = $('#roster');
    r.innerHTML = '';
    const list = game.teamMode
      ? [...game.tanks].sort((a, b) => a.team - b.team || a.id - b.id)
      : game.tanks;
    let lastTeam = null;
    for (const t of list) {
      if (game.teamMode && t.team !== lastTeam) {
        lastTeam = t.team;
        const h = document.createElement('div');
        h.className = 'roster-team';
        h.textContent = `${TEAM_LABELS[t.team]}팀`;
        r.appendChild(h);
      }
      const row = document.createElement('div');
      row.className = 'roster-row' + (t === game.cur ? ' is-cur' : '') + (t.alive ? '' : ' is-dead');
      const pct = Math.max(0, (t.hp / t.maxHp) * 100);
      row.innerHTML =
        `<span class="dot" style="background:${t.color}"></span>` +
        `<span class="r-name">${esc(t.name)}${t.isAI ? '' : ' ★'}</span>` +
        `<span class="r-bar"><i style="width:${pct}%;background:${pct > 50 ? '#4fe07f' : pct > 25 ? '#ffcc2e' : '#ff5348'}"></i></span>` +
        `<span class="r-hp">${t.alive ? t.hp : '✕'}</span>`;
      r.appendChild(row);
    }
  }

  function drawWind(wind) {
    const cv = $('#windCanvas'), c = cv.getContext('2d');
    c.clearRect(0, 0, cv.width, cv.height);
    const mid = cv.width / 2, y = cv.height / 2;
    c.strokeStyle = 'rgba(255,255,255,0.18)';
    c.lineWidth = 1;
    for (let i = -2; i <= 2; i++) {
      const x = mid + i * (mid - 8) / 2;
      c.beginPath(); c.moveTo(x, y - 5); c.lineTo(x, y + 5); c.stroke();
    }
    const len = (wind / 10) * (mid - 9);
    if (Math.abs(len) < 1.5) return;
    const col = Math.abs(wind) > 6.5 ? '#ff7b7b' : Math.abs(wind) > 3.5 ? '#ffcc2e' : '#7fe0a0';
    c.strokeStyle = col; c.fillStyle = col;
    c.lineWidth = 3.5; c.lineCap = 'round';
    c.beginPath(); c.moveTo(mid, y); c.lineTo(mid + len, y); c.stroke();
    const dir = Math.sign(len);
    c.beginPath();
    c.moveTo(mid + len + dir * 6, y);
    c.lineTo(mid + len - dir * 4, y - 5.5);
    c.lineTo(mid + len - dir * 4, y + 5.5);
    c.closePath(); c.fill();
  }

  function showGameOver(g) {
    const m = $('#gameover');
    const title = $('#goTitle'), sub = $('#goSub');
    if (g.winnerTeam == null) {
      title.textContent = '무승부';
      sub.textContent = '모든 전차가 파괴되었습니다.';
    } else {
      const winners = g.tanks.filter((t) => t.team === g.winnerTeam);
      const humanWon = winners.some((t) => !t.isAI);
      title.textContent = g.teamMode ? `${TEAM_LABELS[g.winnerTeam]}팀 승리` : `${winners[0].name} 승리`;
      sub.textContent = (g.teamMode ? winners.map((t) => `${t.name}(${t.type.name})` ).join(', ') + ' · ' : '')
        + (humanWon ? '축하합니다!' : 'AI가 이겼습니다. 다시 도전해보세요.');
    }
    const body = $('#goBody');
    body.innerHTML = '';
    const ranked = [...g.tanks].sort((a, b) => (b.alive - a.alive) || (b.hp - a.hp) || (b.kills - a.kills) || (b.damageDealt - a.damageDealt));
    ranked.forEach((t, i) => {
      const tr = document.createElement('tr');
      if (t.team === g.winnerTeam) tr.className = 'is-win';
      tr.innerHTML =
        `<td>${i + 1}</td>` +
        `<td><span class="dot" style="background:${t.color}"></span>${esc(t.name)}${t.isAI ? '' : ' ★'}</td>` +
        `<td>${esc(t.type.name)}</td>` +
        `<td>${g.teamMode ? TEAM_LABELS[t.team] + '팀' : '-'}</td>` +
        `<td class="num">${t.alive ? t.hp : '✕'}</td>` +
        `<td class="num">${t.kills}</td>` +
        `<td class="num">${t.damageDealt}</td>`;
      body.appendChild(tr);
    });
    m.hidden = false;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ═══════════════ 버튼 배선 ═══════════════ */

  $('#btnToGarage').addEventListener('click', openGarage);
  $('#btnBackMenu').addEventListener('click', () => { showScreen('menu'); renderMenu(); });
  $('#btnRandomAll').addEventListener('click', randomizeAll);
  $('#btnPick').addEventListener('click', () => pickTank(detailId, true));
  $('#btnStart').addEventListener('click', () => startGame(buildConfig()));
  $('#goMenu').addEventListener('click', quitToMenu);
  $('#goGarage').addEventListener('click', () => {
    if (game) { game.destroy(); game = null; }
    $('#gameover').hidden = true;
    openGarage();
  });
  $('#goAgain').addEventListener('click', () => { if (lastCfg) startGame(lastCfg); });
  $('#btnNextTrack').addEventListener('click', (e) => {
    e.stopPropagation();
    bootAudio();
    if (typeof Music !== 'undefined' && Music.next) Music.next();
  });
  $('#btnMute').addEventListener('click', () => {
    const m = !AudioCore.isMuted();
    AudioCore.setMuted(m);
    $('#btnMute').textContent = m ? '🔇' : '🔊';
  });

  let quitArmed = null;
  $('#btnQuit').addEventListener('click', () => {
    if (quitArmed) { clearTimeout(quitArmed); quitArmed = null; quitToMenu(); return; }
    ui.banner('한 번 더 누르면 메뉴로 나갑니다', 2400);
    quitArmed = setTimeout(() => { quitArmed = null; }, 2400);
  });

  /* ═══════════════ 입력 ═══════════════ */

  const KEYMAP = {
    ArrowLeft: 'left', a: 'left', A: 'left',
    ArrowRight: 'right', d: 'right', D: 'right',
    ArrowUp: 'up', w: 'up', W: 'up',
    ArrowDown: 'down', s: 'down', S: 'down',
    PageUp: 'pup', PageDown: 'pdown',
  };

  function inGame() { return $('#game').classList.contains('is-active') && game && $('#gameover').hidden; }

  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;

    if (e.key === 'm' || e.key === 'M') { $('#btnMute').click(); return; }
    if (e.key === 'n' || e.key === 'N') { $('#btnNextTrack').click(); return; }

    // 격납고 키보드 조작
    if ($('#garage').classList.contains('is-active')) {
      const cards = $$('#tankGrid .tank-card');
      if (!cards.length) return;
      let idx = cards.findIndex((c) => c.dataset.id === detailId);
      if (idx < 0) idx = 0;
      const gridEl = $('#tankGrid');
      const cw = cards[0].offsetWidth + 10;
      const cols = Math.max(1, Math.round(gridEl.clientWidth / cw));
      let ni = idx;
      if (e.key === 'ArrowRight') ni = Math.min(cards.length - 1, idx + 1);
      else if (e.key === 'ArrowLeft') ni = Math.max(0, idx - 1);
      else if (e.key === 'ArrowDown') ni = Math.min(cards.length - 1, idx + cols);
      else if (e.key === 'ArrowUp') ni = Math.max(0, idx - cols);
      else if (e.key === 'Enter') { pickTank(detailId, true); e.preventDefault(); return; }
      else if (e.key === 'Tab') {
        activePilot = (activePilot + (e.shiftKey ? setup.count - 1 : 1)) % setup.count;
        detailId = setup.slots[activePilot].tank;
        renderPilots(); renderGrid(); renderDetail();
        e.preventDefault(); return;
      } else return;
      e.preventDefault();
      detailId = cards[ni].dataset.id;
      renderDetail();
      cards[ni].scrollIntoView({ block: 'nearest' });
      return;
    }

    if (!inGame()) return;
    const act = KEYMAP[e.key];
    if (act) { game.input[act] = true; e.preventDefault(); return; }
    if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) game.startCharge(); return; }
    if (e.key === 'Enter') { e.preventDefault(); game.fireNow(); return; }
    if (e.key === 'Tab') { e.preventDefault(); if (game.state === 'aim' && !game.cur.isAI) game.cycleWeapon(); return; }
    if (/^[1-9]$/.test(e.key)) game.selectWeapon(+e.key - 1);
  });

  window.addEventListener('keyup', (e) => {
    if (!game) return;
    const act = KEYMAP[e.key];
    if (act) game.input[act] = false;
    if (e.code === 'Space') game.releaseCharge();
  });

  window.addEventListener('blur', () => {
    if (!game) return;
    for (const k in game.input) game.input[k] = false;
    game.releaseCharge();
  });

  $$('#pad .pad-btn').forEach((b) => {
    const act = b.dataset.act;
    const on = (e) => { e.preventDefault(); if (game) game.input[act] = true; b.classList.add('is-down'); };
    const off = () => { if (game) game.input[act] = false; b.classList.remove('is-down'); };
    b.addEventListener('pointerdown', on);
    b.addEventListener('pointerup', off);
    b.addEventListener('pointercancel', off);
    b.addEventListener('pointerleave', off);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  });

  const fireBtn = $('#btnFire');
  fireBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); if (game) game.startCharge(); fireBtn.classList.add('is-down'); });
  const fireOff = () => { if (game) game.releaseCharge(); fireBtn.classList.remove('is-down'); };
  fireBtn.addEventListener('pointerup', fireOff);
  fireBtn.addEventListener('pointercancel', fireOff);
  fireBtn.addEventListener('pointerleave', fireOff);
  fireBtn.addEventListener('contextmenu', (e) => e.preventDefault());

  renderMenu();
})();
