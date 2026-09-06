/* app.js — UI 조립, 게임 루프, 모드/설정/최고 기록 저장, 미션·피버·아이템·연출 */
(function () {
  'use strict';

  var KEY_BEST_LEGACY = 'tetris.best';
  var KEY_BEST = 'tetris.best.v2';     // { marathon: score, sprint: ms, ultra: score }
  var KEY_SETTINGS = 'tetris.settings';
  var KEY_PREFS = 'tetris.prefs';      // { mode, startLevel, track, lastAuto }
  var PREVIEW_CELL = 13;
  var NEXT_SLOTS = 3;
  var DANGER_ROWS = 6;   // 스택이 위에서 이 줄 수 안으로 들어오면 위험
  var MAX_ITEMS = 3;
  var SLOW_MS = 10000;

  var MODES = {
    marathon: { name: '마라톤', desc: '끝까지 버티며 최고 점수에 도전', bestLabel: '최고 점수' },
    sprint: { name: '40줄', desc: '40줄을 최대한 빨리 지우기 — 기록은 시간', bestLabel: '최고 기록' },
    ultra: { name: '2분', desc: '2분 동안 최대한 많은 점수 내기', bestLabel: '최고 점수' }
  };

  var ITEMS = {
    bomb: { icon: '💣', name: '폭탄', desc: '바닥 2줄 제거' },
    slow: { icon: '⏳', name: '슬로우', desc: '10초 동안 천천히' },
    nextI: { icon: '🎯', name: 'I 조각', desc: '다음 조각을 I로' }
  };
  var ITEM_IDS = ['bomb', 'slow', 'nextI'];

  var TRACK_SHORT = ['코로베이니키', '바흐 프렐류드', '엘리제를 위하여', '미뉴에트'];

  function $(id) { return document.getElementById(id); }

  // ----- 저장소 -----
  function loadJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
  }
  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) { /* ignore */ }
  }

  var settings = Object.assign({ sound: true, music: true, vibrate: true, ghost: true }, loadJSON(KEY_SETTINGS, {}));
  var prefs = Object.assign({ mode: 'marathon', startLevel: 1, track: -1, lastAuto: -1 }, loadJSON(KEY_PREFS, {}));
  if (!MODES[prefs.mode]) prefs.mode = 'marathon';
  var best = Object.assign({ marathon: 0, sprint: 0, ultra: 0 }, loadJSON(KEY_BEST, {}));
  var legacy = parseInt(loadJSON(KEY_BEST_LEGACY, 0), 10) || 0;
  if (legacy > best.marathon) { best.marathon = legacy; saveJSON(KEY_BEST, best); }

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ----- DOM -----
  var ids = [
    'play', 'board', 'boardWrap', 'holdCanvas', 'nextCanvas',
    'hudScoreLabel', 'hudScore', 'hudLevel', 'hudLines', 'hudAltLabel', 'hudAlt', 'hudAltItem',
    'toast', 'controls', 'btnPause',
    'feverBar', 'feverFill', 'mission', 'missionTitle', 'missionProg', 'missionTime',
    'itemBtn', 'itemIcon', 'itemCount',
    'ovStart', 'ovPause', 'ovOver', 'modeGroup', 'levelGroup', 'modeDesc', 'startBestLabel', 'startBest',
    'btnStart', 'btnResume', 'btnNextTrack', 'btnRestartPause', 'btnMenuPause', 'btnRestart', 'btnMenu',
    'trackBtn', 'nowPlaying',
    'overTitle', 'overRank', 'overRankMsg', 'overScore', 'overLines', 'overLevel', 'overTime',
    'overMissions', 'overFevers', 'overBestLabel', 'overBest', 'overNew'
  ];
  var els = {};
  ids.forEach(function (id) { els[id] = $(id); });

  var game = new Game();
  var renderer = new Renderer(els.board);
  var missions = new Missions(game);
  var inventory = [];

  // ----- 유틸 -----
  function vibrate(ms) {
    if (!settings.vibrate) return;
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (_) { /* ignore */ }
  }
  function sfx(name, arg) {
    if (settings.sound) Sound.play(name, arg);
  }
  function fmt(n) { return n.toLocaleString('ko-KR'); }
  function fmtTime(ms, tenths) {
    ms = Math.max(0, ms);
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    var sec = s % 60;
    var out = m + ':' + (sec < 10 ? '0' : '') + sec;
    if (tenths) out += '.' + Math.floor((ms % 1000) / 100);
    return out;
  }
  function bestText(mode) {
    var v = best[mode] || 0;
    if (mode === 'sprint') return v ? fmtTime(v, true) : '--';
    return fmt(v);
  }

  var toastTimer = null;
  function toast(text, cls, ms) {
    els.toast.textContent = text;
    els.toast.className = 'toast show' + (cls ? ' toast--' + cls : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.className = 'toast'; }, ms || 950);
  }

  // 화면 흔들림
  var shake = { t: 0, dur: 0, mag: 0 };
  function doShake(mag, dur) {
    if (reduceMotion) return;
    shake.t = dur;
    shake.dur = dur;
    shake.mag = mag;
  }
  function applyShake(dt) {
    if (shake.t <= 0) {
      if (els.boardWrap.style.transform) els.boardWrap.style.transform = '';
      return;
    }
    shake.t -= dt;
    var k = Math.max(0, shake.t / shake.dur) * shake.mag;
    var x = (Math.random() * 2 - 1) * k;
    var y = (Math.random() * 2 - 1) * k;
    els.boardWrap.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
  }

  // ----- HUD -----
  var hudCache = {};
  function setText(el, key, val) {
    if (hudCache[key] === val) return;
    hudCache[key] = val;
    el.textContent = val;
  }
  function updateHUD() {
    setText(els.hudScoreLabel, 'scoreLabel', game.fever.active ? '점수 ×2' : '점수');
    setText(els.hudScore, 'score', fmt(game.score));
    setText(els.hudLevel, 'level', game.isSlow() ? game.level + ' ⏳' : String(game.level));
    if (game.mode === 'sprint') {
      setText(els.hudLines, 'lines', Math.min(game.lines, Game.SPRINT_LINES) + '/' + Game.SPRINT_LINES);
      setText(els.hudAltLabel, 'altLabel', '시간');
      setText(els.hudAlt, 'alt', fmtTime(game.elapsed, true));
      els.hudAltItem.classList.remove('hud-item--warn');
    } else if (game.mode === 'ultra') {
      setText(els.hudLines, 'lines', String(game.lines));
      setText(els.hudAltLabel, 'altLabel', '남은 시간');
      var remain = Game.ULTRA_MS - game.elapsed;
      setText(els.hudAlt, 'alt', fmtTime(remain, remain < 10000));
      els.hudAltItem.classList.toggle('hud-item--warn', game.running && remain < 10000);
    } else {
      setText(els.hudLines, 'lines', String(game.lines));
      setText(els.hudAltLabel, 'altLabel', '최고');
      setText(els.hudAlt, 'alt', fmt(Math.max(best.marathon, game.score)));
      els.hudAltItem.classList.remove('hud-item--warn');
    }

    // 피버 게이지
    var gauge = Math.round(game.fever.gauge);
    if (hudCache.gauge !== gauge) {
      hudCache.gauge = gauge;
      els.feverFill.style.width = gauge + '%';
    }
    els.feverBar.classList.toggle('active', game.fever.active);
    els.boardWrap.classList.toggle('fever', game.fever.active);
    els.boardWrap.classList.toggle('slow', game.running && game.isSlow());

    // 미션 칩
    var m = missions.active;
    if (m) {
      setText(els.missionTitle, 'mTitle', m.title);
      setText(els.missionProg, 'mProg', Math.min(m.progress, m.goal) + '/' + m.goal);
      var left = Math.max(0, 1 - m.elapsed / m.limit);
      els.missionTime.style.width = (left * 100).toFixed(1) + '%';
      els.missionTime.style.background = left < 0.25 ? '#ff4d6d' : '';
      els.mission.classList.add('on');
    } else if (!missionHold) {
      setText(els.missionTitle, 'mTitle', game.running ? '다음 미션 준비 중…' : '게임을 시작하면 미션이 나와요');
      setText(els.missionProg, 'mProg', '');
      els.missionTime.style.width = '0%';
      els.mission.classList.remove('on');
    }
  }

  var previewKey = '';
  function drawPreviews(force) {
    var key = (game.holdType || '-') + (game.canHold ? '1' : '0') + game.nextTypes(NEXT_SLOTS).join('');
    if (!force && key === previewKey) return;
    previewKey = key;
    Renderer.drawPreview(els.holdCanvas, game.holdType ? [game.holdType] : [], PREVIEW_CELL, 1, !game.canHold);
    Renderer.drawPreview(els.nextCanvas, game.nextTypes(NEXT_SLOTS), PREVIEW_CELL, NEXT_SLOTS, false);
  }

  // ----- 레이아웃 -----
  function fit() {
    var rect = els.play.getBoundingClientRect();
    var style = getComputedStyle(els.play);
    var padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    var padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    var gap = parseFloat(style.columnGap || style.gap) || 0;
    var sideW = els.holdCanvas.parentElement.getBoundingClientRect().width;
    var extraH = els.feverBar.offsetHeight + els.mission.offsetHeight + 12; // 보드 아래 요소 + gap
    var availW = rect.width - padX - 2 * sideW - 2 * gap;
    var availH = rect.height - padY - extraH;
    var cell = Math.floor(Math.min(availW / Game.COLS, availH / Game.ROWS));
    cell = Math.max(10, cell);
    if (cell !== renderer.cell || els.board.width === 0) {
      renderer.resize(cell);
    }
    drawPreviews(true);
  }

  // ----- 오버레이 / 시작 화면 -----
  function showOverlay(el) {
    [els.ovStart, els.ovPause, els.ovOver].forEach(function (o) { o.hidden = o !== el; });
  }

  function trackLabel() {
    return '♫ ' + (prefs.track < 0 ? '자동 (매 판 바뀜)' : TRACK_SHORT[prefs.track]);
  }

  function refreshStartScreen() {
    var m = MODES[prefs.mode];
    els.modeDesc.textContent = m.desc;
    els.startBestLabel.textContent = m.bestLabel;
    els.startBest.textContent = bestText(prefs.mode);
    els.modeGroup.querySelectorAll('.seg').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-mode') === prefs.mode ? 'true' : 'false');
    });
    els.levelGroup.querySelectorAll('.seg').forEach(function (b) {
      b.setAttribute('aria-pressed', parseInt(b.getAttribute('data-level'), 10) === prefs.startLevel ? 'true' : 'false');
    });
    els.trackBtn.textContent = trackLabel();
  }

  els.modeGroup.addEventListener('click', function (e) {
    var b = e.target.closest('.seg');
    if (!b) return;
    prefs.mode = b.getAttribute('data-mode');
    saveJSON(KEY_PREFS, prefs);
    refreshStartScreen();
    sfx('move');
  });
  els.levelGroup.addEventListener('click', function (e) {
    var b = e.target.closest('.seg');
    if (!b) return;
    prefs.startLevel = parseInt(b.getAttribute('data-level'), 10) || 1;
    saveJSON(KEY_PREFS, prefs);
    refreshStartScreen();
    sfx('move');
  });
  els.trackBtn.addEventListener('click', function () {
    // -1(자동) → 0 → 1 → … → -1
    prefs.track = prefs.track + 1 >= Music.trackCount() ? -1 : prefs.track + 1;
    saveJSON(KEY_PREFS, prefs);
    refreshStartScreen();
    sfx('rotate');
  });

  function pickTrack() {
    if (prefs.track >= 0) return prefs.track;
    prefs.lastAuto = (prefs.lastAuto + 1) % Music.trackCount();
    saveJSON(KEY_PREFS, prefs);
    return prefs.lastAuto;
  }

  function goMenu() {
    Music.stop();
    input.stopAll();
    game.reset({ mode: prefs.mode, startLevel: prefs.startLevel });
    missions.reset();
    inventory = [];
    updateItemBtn();
    refreshStartScreen();
    showOverlay(els.ovStart);
    hudCache = {};
    updateHUD();
    drawPreviews(true);
  }

  function startGame() {
    Sound.unlock();
    game.reset({ mode: prefs.mode, startLevel: prefs.startLevel });
    renderer.particles = [];
    renderer.flash = 0;
    inventory = [];
    updateItemBtn();
    missionHold = false;
    els.mission.className = 'mission';
    game.start();
    hudCache = {};
    previewKey = '';
    showOverlay(null);
    updateHUD();
    drawPreviews(true);
    Music.setLevel(game.level);
    Music.setDanger(false);
    Music.setFever(false);
    var track = pickTrack();
    Music.start(track);
    toast(MODES[game.mode].name + ' 시작!', 'level');
    if (settings.music) {
      setTimeout(function () {
        if (game.running && !game.paused) toast('♫ ' + Music.trackName(track), 'music', 1600);
      }, 1100);
    }
  }

  function pauseGame() {
    if (!game.running || game.paused || game.over) return;
    game.paused = true;
    input.stopAll();
    Music.pause();
    els.nowPlaying.textContent = settings.music ? '♫ ' + Music.trackName() : '';
    showOverlay(els.ovPause);
  }

  function resumeGame() {
    if (!game.paused) return;
    game.paused = false;
    showOverlay(null);
    if (Music.isPlaying()) Music.resume();
    else Music.start(); // 일시정지 중 음악을 켠 경우
  }

  function togglePause() {
    if (game.paused) resumeGame();
    else pauseGame();
  }

  // ----- 아이템 -----
  function updateItemBtn() {
    if (!inventory.length) {
      els.itemBtn.hidden = true;
      return;
    }
    var it = ITEMS[inventory[0]];
    els.itemIcon.textContent = it.icon;
    els.itemCount.textContent = String(inventory.length);
    els.itemBtn.setAttribute('aria-label', it.name + ' 사용: ' + it.desc);
    els.itemBtn.hidden = false;
  }

  function giveItem() {
    if (inventory.length >= MAX_ITEMS) return null;
    var id = ITEM_IDS[Math.floor(Math.random() * ITEM_IDS.length)];
    inventory.push(id);
    updateItemBtn();
    return id;
  }

  function useItem() {
    if (!inventory.length || !game.running || game.paused || game.over) return false;
    var id = inventory[0];
    var ok = false;
    if (id === 'bomb') {
      ok = game.bomb();
      if (ok) { sfx('bomb'); vibrate([40, 30, 80]); doShake(8, 320); toast('💣 바닥 2줄 제거!', 'big'); }
      else toast('바닥에 블록이 없어요', '');
    } else if (id === 'slow') {
      ok = game.slow(SLOW_MS);
      if (ok) { sfx('item'); vibrate(15); toast('⏳ 10초 동안 천천히', 'level'); }
    } else if (id === 'nextI') {
      ok = game.injectNext('I');
      if (ok) { sfx('item'); vibrate(15); toast('🎯 다음 조각은 I!', 'level'); previewKey = ''; }
    }
    if (ok) {
      inventory.shift();
      updateItemBtn();
    }
    return ok;
  }

  els.itemBtn.addEventListener('click', useItem);

  // ----- 게임 이벤트 -----
  game.on('lock', function () {
    sfx('lock');
  });

  game.on('hold', function () {
    sfx('hold');
    vibrate(8);
  });

  game.on('clearStart', function (info) {
    renderer.burst(game, info.rows);
    if (game.fever.active) renderer.burst(game, info.rows);
  });

  game.on('bomb', function (info) {
    renderer.burst(game, info.rows);
    renderer.burst(game, info.rows);
  });

  game.on('clear', function (info) {
    var label = '';
    if (info.perfect) label = 'PERFECT CLEAR!';
    else if (info.tspin && info.lines > 0) label = 'T-SPIN ' + ['', 'SINGLE', 'DOUBLE', 'TRIPLE'][info.lines];
    else if (info.tspin) label = 'T-SPIN';
    else if (info.lines === 4) label = 'TETRIS!';
    else if (info.lines === 3) label = 'TRIPLE';
    else if (info.lines === 2) label = 'DOUBLE';

    var extra = [];
    if (info.b2b) extra.push('B2B');
    if (info.combo > 0) extra.push('COMBO ×' + info.combo);
    if (extra.length) label = (label ? label + '\n' : '') + extra.join(' · ');
    if (info.points > 0) label = (label ? label + '\n' : '') + '+' + fmt(info.points) + (info.fever ? ' (×2)' : '');

    if (label) toast(label, info.lines === 4 || info.perfect ? 'big' : info.tspin ? 'tspin' : '');

    if (info.lines === 4) { sfx('tetris'); vibrate([30, 40, 60]); doShake(7, 260); }
    else if (info.tspin) { sfx('tspin'); vibrate([20, 30, 20]); doShake(4, 200); }
    else if (info.lines > 0) { sfx('clear', info.lines); vibrate(20 + info.lines * 10); doShake(2 + info.lines, 160); }
  });

  game.on('levelup', function (lv) {
    sfx('levelup');
    vibrate([15, 30, 15, 30, 15]);
    renderer.flash = 1;
    Music.setLevel(lv);
    setTimeout(function () { toast('LEVEL ' + lv, 'level'); }, 350);
  });

  game.on('feverStart', function () {
    sfx('fever');
    vibrate([30, 30, 30, 30, 30, 30, 90]);
    renderer.flash = 1;
    Music.setFever(true);
    toast('FEVER TIME!\n점수 ×2', 'big', 1400);
  });

  game.on('feverEnd', function () {
    Music.setFever(false);
  });

  // ----- 미션 이벤트 -----
  var missionHold = false; // 성공/실패 표시 유지 중
  function holdMissionChip(cls, title, prog, ms) {
    missionHold = true;
    els.mission.className = 'mission on ' + cls;
    els.missionTitle.textContent = title;
    els.missionProg.textContent = prog;
    els.missionTime.style.width = '0%';
    hudCache.mTitle = title;
    hudCache.mProg = prog;
    setTimeout(function () {
      missionHold = false;
      els.mission.className = 'mission';
    }, ms);
  }

  missions.on('new', function (m) {
    els.mission.className = 'mission on pop';
    sfx('mission');
    toast('새 미션: ' + m.title, 'mission', 1300);
  });

  missions.on('complete', function (e) {
    game.score += e.reward;
    game.addFever(35);
    var item = giveItem();
    sfx('missionOk');
    vibrate([20, 30, 20, 30, 60]);
    renderer.flash = 0.6;
    var msg = '미션 성공!\n+' + fmt(e.reward);
    if (item) msg += '\n' + ITEMS[item].icon + ' ' + ITEMS[item].name + ' 획득';
    toast(msg, 'big', 1500);
    holdMissionChip('done', '성공! ' + e.mission.title, '+' + fmt(e.reward), 2200);
  });

  missions.on('fail', function (e) {
    sfx('fail');
    holdMissionChip('fail', e.reason === 'hold' ? '홀드를 써서 실패' : '시간 초과: ' + e.mission.title, '', 1800);
  });

  // ----- 게임 오버 / 등급 -----
  function rankOf(info) {
    var g, msgs;
    if (info.mode === 'sprint') {
      if (!info.won) return { g: '-', msg: '완주하면 등급이 매겨져요' };
      var sec = info.elapsed / 1000;
      g = sec < 120 ? 'S' : sec < 180 ? 'A' : sec < 270 ? 'B' : sec < 360 ? 'C' : 'D';
    } else if (info.mode === 'ultra') {
      g = info.score >= 30000 ? 'S' : info.score >= 15000 ? 'A' : info.score >= 7000 ? 'B' : info.score >= 2500 ? 'C' : 'D';
    } else {
      g = info.score >= 50000 ? 'S' : info.score >= 20000 ? 'A' : info.score >= 8000 ? 'B' : info.score >= 2500 ? 'C' : 'D';
    }
    msgs = {
      S: '전설의 테트리스 마스터!',
      A: '대단해요, 고수의 향기',
      B: '안정적인 실력이에요',
      C: '감 잡았어요, 한 판 더!',
      D: '워밍업 끝, 이제 시작이죠'
    };
    return { g: g, msg: msgs[g] };
  }

  game.on('gameover', function (info) {
    input.stopAll();
    Music.stop();
    Music.setFever(false);
    var mode = info.mode;
    var isNew = false;
    var value = mode === 'sprint' ? info.elapsed : info.score;

    if (info.won) {
      sfx('levelup');
      vibrate([40, 40, 40, 40, 80]);
      renderer.flash = 1;
    } else {
      sfx('gameover');
      vibrate([60, 50, 120]);
      doShake(5, 300);
    }

    if (mode === 'sprint') {
      if (info.won && (best.sprint === 0 || value < best.sprint)) { best.sprint = value; isNew = true; }
    } else if (value > (best[mode] || 0) && value > 0) {
      best[mode] = value;
      isNew = true;
    }
    if (isNew) saveJSON(KEY_BEST, best);

    if (info.reason === 'lines') els.overTitle.textContent = '40줄 완료! 🎉';
    else if (info.reason === 'time') els.overTitle.textContent = '시간 종료!';
    else els.overTitle.textContent = '게임 오버';

    var r = rankOf(info);
    els.overRank.textContent = r.g;
    els.overRank.className = 'rank-grade ' + r.g.toLowerCase();
    els.overRankMsg.textContent = r.msg;

    els.overScore.textContent = fmt(info.score);
    els.overLines.textContent = String(info.lines);
    els.overLevel.textContent = String(info.level);
    els.overTime.textContent = fmtTime(info.elapsed, true);
    els.overMissions.textContent = String(missions.completed);
    els.overFevers.textContent = String(info.stats.fevers);
    els.overBestLabel.textContent = MODES[mode].bestLabel;
    els.overBest.textContent = bestText(mode);
    els.overNew.hidden = !isNew;
    inventory = [];
    updateItemBtn();
    setTimeout(function () { showOverlay(els.ovOver); }, info.won ? 700 : 500);
  });

  // ----- 입력 -----
  var actions = {
    left: function () { if (game.move(-1)) sfx('move'); },
    right: function () { if (game.move(1)) sfx('move'); },
    rotCW: function () { if (game.rotate(1)) sfx('rotate'); },
    rotCCW: function () { if (game.rotate(-1)) sfx('rotate'); },
    softStart: function () { game.softDrop = true; },
    softStop: function () { game.softDrop = false; },
    softStep: function () { game.softStep(); },
    hard: function () {
      if (!game.canAct()) return;
      var n = game.hardDrop();
      sfx('hard');
      vibrate(12);
      if (n > 2) doShake(2, 90);
    },
    hold: function () { game.hold(); },
    item: function () { useItem(); },
    pause: function () {
      if (game.running || game.paused) togglePause();
    },
    tap: function () { actions.rotCW(); }
  };

  var input = new Input({
    actions: actions,
    buttons: els.controls,
    board: els.board,
    cellSize: function () { return renderer.cell; }
  });

  // ----- 설정 토글 -----
  function applySettings() {
    Sound.setEnabled(settings.sound);
    Music.setEnabled(settings.music);
    document.querySelectorAll('.toggle[data-setting]').forEach(function (btn) {
      var key = btn.getAttribute('data-setting');
      btn.setAttribute('aria-pressed', settings[key] ? 'true' : 'false');
    });
    saveJSON(KEY_SETTINGS, settings);
  }
  document.querySelectorAll('.toggle[data-setting]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var key = btn.getAttribute('data-setting');
      settings[key] = !settings[key];
      applySettings();
      if (key === 'sound' && settings.sound) { Sound.unlock(); sfx('rotate'); }
      if (key === 'vibrate' && settings.vibrate) vibrate(20);
      if (key === 'music' && settings.music && game.running && !game.paused) Music.start();
    });
  });
  applySettings();

  // ----- 버튼 -----
  els.btnStart.addEventListener('click', startGame);
  els.btnRestart.addEventListener('click', startGame);
  els.btnRestartPause.addEventListener('click', startGame);
  els.btnResume.addEventListener('click', resumeGame);
  els.btnMenu.addEventListener('click', goMenu);
  els.btnMenuPause.addEventListener('click', goMenu);
  els.btnNextTrack.addEventListener('click', function () {
    if (!settings.music) { settings.music = true; applySettings(); }
    var i = Music.next();
    els.nowPlaying.textContent = '♫ ' + Music.trackName(i);
    // 다음 곡은 일시정지 상태에서 시작되므로 바로 음소거 상태로 대기
    setTimeout(function () { if (game.paused) Music.pause(); }, 220);
  });
  els.btnPause.addEventListener('click', function () {
    if (game.running || game.paused) togglePause();
  });

  // 백그라운드로 가면 자동 일시정지
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) pauseGame();
  });
  window.addEventListener('blur', function () { pauseGame(); });

  // ----- 루프 -----
  var last = 0;
  var dangerCheck = 0;
  var danger = false;
  function frame(ts) {
    var dt = last ? Math.min(ts - last, 100) : 0;
    last = ts;
    game.update(dt);
    missions.update(dt);
    renderer.tick(dt);

    dangerCheck += dt;
    if (dangerCheck > 120) {
      dangerCheck = 0;
      var d = game.running && !game.over && game.stackHeight() >= Game.ROWS - DANGER_ROWS;
      if (d !== danger) { danger = d; Music.setDanger(d); }
    }

    renderer.draw(game, { ghost: settings.ghost, danger: danger, fever: game.fever.active });
    applyShake(dt);
    updateHUD();
    drawPreviews(false);
    requestAnimationFrame(frame);
  }

  // ----- 초기화 -----
  game.reset({ mode: prefs.mode, startLevel: prefs.startLevel });
  refreshStartScreen();
  updateHUD();
  updateItemBtn();
  showOverlay(els.ovStart);

  if (window.ResizeObserver) {
    new ResizeObserver(fit).observe(els.play);
  }
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', function () { setTimeout(fit, 150); });
  fit();
  requestAnimationFrame(frame);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* 오프라인 캐시 실패는 무시 */ });
    });
  }

  // 디버그/테스트용 노출
  window.__tetris = {
    game: game, renderer: renderer, missions: missions, settings: settings, prefs: prefs,
    start: startGame, useItem: useItem, giveItem: giveItem,
    inventory: function () { return inventory.slice(); }
  };
})();
