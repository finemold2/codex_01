'use strict';
/* main.js — 메뉴, HUD, 입력 바인딩 */
(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const MODES = [
    { id: 'ffa', label: '개인전', teams: 0 },
    { id: 'team2', label: '팀전 (2팀)', teams: 2 },
    { id: 'team3', label: '팀전 (3팀)', teams: 3 },
  ];
  const DIFFS = [{ id: 'easy', label: '쉬움' }, { id: 'normal', label: '보통' }, { id: 'hard', label: '어려움' }];
  const THEMES = [{ id: 'random', label: '랜덤' }, { id: 'grass', label: '초원' }, { id: 'desert', label: '사막' }, { id: 'snow', label: '설원' }];

  const setup = { count: 3, mode: 'ffa', difficulty: 'normal', theme: 'random', slots: [] };
  let game = null;
  let lastCfg = null;

  /* ---------- 메뉴 ---------- */

  function teamCount() { return (MODES.find((m) => m.id === setup.mode) || MODES[0]).teams; }

  function seg(el, items, getter, setter) {
    el.innerHTML = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn' + (getter() === it.id ? ' is-active' : '');
      b.textContent = it.label;
      b.addEventListener('click', () => { setter(it.id); renderMenu(); });
      el.appendChild(b);
    }
  }

  function syncSlots() {
    const tc = teamCount();
    while (setup.slots.length < setup.count) {
      const i = setup.slots.length;
      setup.slots.push({ name: i === 0 ? '플레이어' : `AI ${i}`, type: i === 0 ? 'human' : 'ai', team: 0 });
    }
    setup.slots.length = setup.count;
    if (tc > 0) setup.slots.forEach((s, i) => { if (s.team >= tc) s.team = i % tc; });
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
      const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = PLAYER_COLORS[i];
      const name = document.createElement('input');
      name.value = s.name; name.maxLength = 10; name.placeholder = `플레이어 ${i + 1}`;
      name.addEventListener('input', () => { s.name = name.value; });
      const type = document.createElement('select');
      type.innerHTML = '<option value="human">사람</option><option value="ai">AI</option>';
      type.value = s.type;
      type.addEventListener('change', () => {
        s.type = type.value;
        if (s.type === 'ai' && /^플레이어/.test(s.name)) { s.name = `AI ${i}`; name.value = s.name; }
        if (s.type === 'human' && /^AI/.test(s.name)) { s.name = '플레이어'; name.value = s.name; }
        updateHint();
      });
      row.append(sw, name, type);
      if (tc > 0) {
        const team = document.createElement('select');
        team.className = 'team-sel';
        for (let k = 0; k < tc; k++) team.innerHTML += `<option value="${k}">${TEAM_LABELS[k]}팀</option>`;
        team.value = String(s.team);
        team.addEventListener('change', () => { s.team = +team.value; updateHint(); });
        row.appendChild(team);
      }
      wrap.appendChild(row);
    });
    updateHint();
  }

  function updateHint() {
    const humans = setup.slots.filter((s) => s.type === 'human').length;
    const tc = teamCount();
    let txt = humans === 0 ? '관전 모드 (AI vs AI)' : `사람 ${humans}명 · AI ${setup.count - humans}명`;
    if (tc > 0) {
      const sizes = Array.from({ length: tc }, (_, k) => setup.slots.filter((s) => s.team === k).length);
      txt += ' · ' + sizes.map((n, k) => `${TEAM_LABELS[k]}${n}`).join(' : ');
    }
    $('#slotsHint').textContent = txt;
  }

  function renderMenu() {
    syncSlots();
    seg($('#segCount'), [2, 3, 4, 5, 6].map((n) => ({ id: n, label: `${n}명` })), () => setup.count, (v) => { setup.count = v; syncSlots(); assignTeamsRoundRobin(); });
    seg($('#segMode'), MODES, () => setup.mode, (v) => { setup.mode = v; syncSlots(); assignTeamsRoundRobin(); });
    seg($('#segDiff'), DIFFS, () => setup.difficulty, (v) => { setup.difficulty = v; });
    seg($('#segTheme'), THEMES, () => setup.theme, (v) => { setup.theme = v; });
    renderSlots();
  }

  function buildConfig() {
    const tc = teamCount();
    const players = setup.slots.map((s, i) => ({
      name: (s.name || '').trim() || (s.type === 'ai' ? `AI ${i}` : `플레이어 ${i + 1}`),
      isAI: s.type === 'ai',
      team: tc > 0 ? s.team : i,
      color: PLAYER_COLORS[i],
    }));
    if (tc > 0) {
      const used = new Set(players.map((p) => p.team));
      if (used.size < 2) return { error: '팀전은 서로 다른 팀이 2개 이상 필요합니다.' };
    }
    return { players, difficulty: setup.difficulty, theme: setup.theme, teamMode: tc > 0, teamCount: tc };
  }

  $('#btnStart').addEventListener('click', () => {
    const cfg = buildConfig();
    const err = $('#menuError');
    if (cfg.error) { err.textContent = cfg.error; err.hidden = false; return; }
    err.hidden = true;
    startGame(cfg);
  });

  /* ---------- 게임 시작/종료 ---------- */

  function startGame(cfg) {
    lastCfg = cfg;
    if (game) game.destroy();
    $('#menu').hidden = true;
    $('#game').hidden = false;
    $('#gameover').hidden = true;
    fitCanvas();
    game = new Game($('#canvas'), cfg, ui);
    window.__game = game;   // 디버그/테스트용
    renderWeapons();
  }

  function quitToMenu() {
    if (game) game.destroy();
    game = null;
    $('#gameover').hidden = true;
    $('#game').hidden = true;
    $('#menu').hidden = false;
  }

  $('#btnQuit').addEventListener('click', () => { if (confirm('게임을 종료하고 메뉴로 돌아갈까요?')) quitToMenu(); });
  $('#goMenu').addEventListener('click', quitToMenu);
  $('#goAgain').addEventListener('click', () => { if (lastCfg) startGame(lastCfg); });
  $('#btnMute').addEventListener('click', () => { const m = Sfx.toggle(); $('#btnMute').textContent = m ? '🔇' : '🔊'; });

  /* ---------- 캔버스 크기 맞춤 ---------- */

  function fitCanvas() {
    const stage = $('#stage');
    const inner = $('#stageInner');
    const aw = stage.clientWidth, ah = stage.clientHeight;
    if (!aw || !ah) return;
    let w = aw, h = aw / 2;
    if (h > ah) { h = ah; w = ah * 2; }
    inner.style.width = `${Math.floor(w)}px`;
    inner.style.height = `${Math.floor(h)}px`;
  }
  window.addEventListener('resize', fitCanvas);

  /* ---------- HUD ---------- */

  let bannerTimer = null;
  const ui = {
    onTurn(g) {
      const t = g.cur;
      $('#hudDot').style.background = t.color;
      $('#hudName').textContent = t.name;
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
      $('#hudAngle').textContent = `${Math.round(t.elev)}°${t.facing === 1 ? ' →' : ' ←'}`;
      $('#hudPower').textContent = Math.round(t.power);
      $('#pfill').style.width = `${t.power}%`;
      $('#ffill').style.width = `${(t.fuel / MAX_FUEL) * 100}%`;
      drawWind(g.wind);
      $('#hudWind').textContent = `${Math.abs(g.wind).toFixed(1)}`;
    },
    banner(text, ms) {
      const b = $('#banner');
      b.textContent = text; b.hidden = false;
      b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop');
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => { b.hidden = true; }, ms);
    },
    onGameOver(g) {
      setTimeout(() => showGameOver(g), 900);
    },
  };

  function renderWeapons() {
    if (!game) return;
    const t = game.cur;
    const wrap = $('#weapons');
    wrap.innerHTML = '';
    WEAPONS.forEach((w, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      const ammo = t.ammo[w.id];
      b.className = 'wpn' + (t.weapon === i ? ' is-active' : '') + (ammo <= 0 ? ' is-empty' : '');
      b.innerHTML = `<span class="w-key">${i + 1}</span><span class="w-icon">${w.icon}</span><span class="w-name">${w.name}</span><span class="w-ammo">${ammo === Infinity ? '∞' : ammo}</span>`;
      b.addEventListener('click', () => game && game.selectWeapon(i));
      wrap.appendChild(b);
    });
  }

  function renderRoster() {
    if (!game) return;
    const r = $('#roster');
    r.innerHTML = '';
    const list = game.teamMode ? [...game.tanks].sort((a, b) => a.team - b.team || a.id - b.id) : game.tanks;
    let lastTeam = null;
    for (const t of list) {
      if (game.teamMode && t.team !== lastTeam) {
        lastTeam = t.team;
        const h = document.createElement('div'); h.className = 'roster-team'; h.textContent = `${TEAM_LABELS[t.team]}팀`;
        r.appendChild(h);
      }
      const row = document.createElement('div');
      row.className = 'roster-row' + (t === game.cur ? ' is-cur' : '') + (t.alive ? '' : ' is-dead');
      row.innerHTML = `<span class="dot" style="background:${t.color}"></span><span class="r-name">${escapeHtml(t.name)}${t.isAI ? '' : ' ★'}</span><span class="r-bar"><i style="width:${t.hp}%"></i></span><span class="r-hp">${t.alive ? t.hp : '✕'}</span>`;
      r.appendChild(row);
    }
  }

  function drawWind(wind) {
    const cv = $('#windCanvas'), c = cv.getContext('2d');
    c.clearRect(0, 0, cv.width, cv.height);
    const mid = cv.width / 2, y = cv.height / 2;
    c.strokeStyle = 'rgba(255,255,255,0.25)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(mid, 3); c.lineTo(mid, cv.height - 3); c.stroke();
    const len = (wind / 10) * (mid - 6);
    if (Math.abs(len) < 1) return;
    const col = Math.abs(wind) > 6 ? '#ff7b7b' : Math.abs(wind) > 3 ? '#ffd23f' : '#7fe0a0';
    c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 4; c.lineCap = 'round';
    c.beginPath(); c.moveTo(mid, y); c.lineTo(mid + len, y); c.stroke();
    const dir = Math.sign(len);
    c.beginPath(); c.moveTo(mid + len + dir * 6, y); c.lineTo(mid + len - dir * 4, y - 6); c.lineTo(mid + len - dir * 4, y + 6); c.closePath(); c.fill();
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
      title.textContent = g.teamMode ? `🏆 ${TEAM_LABELS[g.winnerTeam]}팀 승리!` : `🏆 ${winners[0].name} 승리!`;
      sub.textContent = g.teamMode
        ? `${winners.map((t) => t.name).join(', ')} · ${humanWon ? '축하합니다!' : 'AI가 이겼습니다…'}`
        : (humanWon ? '축하합니다!' : 'AI가 이겼습니다… 다시 도전해보세요!');
    }
    const body = $('#goBody');
    body.innerHTML = '';
    const ranked = [...g.tanks].sort((a, b) => (b.alive - a.alive) || (b.hp - a.hp) || (b.kills - a.kills));
    ranked.forEach((t, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i + 1}</td><td><span class="dot" style="background:${t.color}"></span>${escapeHtml(t.name)}${t.isAI ? '' : ' ★'}</td><td>${g.teamMode ? TEAM_LABELS[t.team] + '팀' : '-'}</td><td>${t.alive ? t.hp : '✕'}</td><td>${t.kills}</td>`;
      body.appendChild(tr);
    });
    m.hidden = false;
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }

  /* ---------- 입력 ---------- */

  const KEYMAP = { ArrowLeft: 'left', a: 'left', ArrowRight: 'right', d: 'right', ArrowUp: 'up', w: 'up', ArrowDown: 'down', s: 'down', PageUp: 'pup', PageDown: 'pdown' };

  window.addEventListener('keydown', (e) => {
    if (!game || $('#game').hidden || e.target.tagName === 'INPUT') return;
    const act = KEYMAP[e.key];
    if (act) { game.input[act] = true; e.preventDefault(); return; }
    if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) game.startCharge(); return; }
    if (e.key === 'Enter') { e.preventDefault(); game.fireNow(); return; }
    if (e.key === 'Tab') { e.preventDefault(); if (game.state === 'aim' && !game.cur.isAI) game.cycleWeapon(); return; }
    if (/^[1-4]$/.test(e.key)) { game.selectWeapon(+e.key - 1); }
  });
  window.addEventListener('keyup', (e) => {
    if (!game) return;
    const act = KEYMAP[e.key];
    if (act) game.input[act] = false;
    if (e.code === 'Space') game.releaseCharge();
  });
  window.addEventListener('blur', () => { if (game) { for (const k in game.input) game.input[k] = false; game.releaseCharge(); } });

  // 화면 패드
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
