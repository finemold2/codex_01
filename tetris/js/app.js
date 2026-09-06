/* app.js — UI 조립, 게임 루프, 모드/설정/최고 기록 저장, 연출 */
(function () {
  'use strict';

  var KEY_BEST_LEGACY = 'tetris.best';
  var KEY_BEST = 'tetris.best.v2';     // { marathon: score, sprint: ms, ultra: score }
  var KEY_SETTINGS = 'tetris.settings';
  var KEY_PREFS = 'tetris.prefs';      // { mode, startLevel }
  var PREVIEW_CELL = 13;
  var NEXT_SLOTS = 3;
  var DANGER_ROWS = 6; // 스택이 위에서 이 줄 수 안으로 들어오면 위험

  var MODES = {
    marathon: { name: '마라톤', desc: '끝까지 버티며 최고 점수에 도전', bestLabel: '최고 점수' },
    sprint: { name: '40줄', desc: '40줄을 최대한 빨리 지우기 — 기록은 시간', bestLabel: '최고 기록' },
    ultra: { name: '2분', desc: '2분 동안 최대한 많은 점수 내기', bestLabel: '최고 점수' }
  };

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
  var prefs = Object.assign({ mode: 'marathon', startLevel: 1 }, loadJSON(KEY_PREFS, {}));
  if (!MODES[prefs.mode]) prefs.mode = 'marathon';
  var best = Object.assign({ marathon: 0, sprint: 0, ultra: 0 }, loadJSON(KEY_BEST, {}));
  // 이전 버전 최고 점수 이관
  var legacy = parseInt(loadJSON(KEY_BEST_LEGACY, 0), 10) || 0;
  if (legacy > best.marathon) { best.marathon = legacy; saveJSON(KEY_BEST, best); }

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ----- DOM -----
  var els = {
    play: $('play'),
    board: $('board'),
    boardWrap: $('boardWrap'),
    hold: $('holdCanvas'),
    next: $('nextCanvas'),
    hudScore: $('hudScore'),
    hudLevel: $('hudLevel'),
    hudLines: $('hudLines'),
    hudAltLabel: $('hudAltLabel'),
    hudAlt: $('hudAlt'),
    hudAltItem: $('hudAltItem'),
    toast: $('toast'),
    controls: $('controls'),
    btnPause: $('btnPause'),
    ovStart: $('ovStart'),
    ovPause: $('ovPause'),
    ovOver: $('ovOver'),
    modeGroup: $('modeGroup'),
    levelGroup: $('levelGroup'),
    modeDesc: $('modeDesc'),
    startBestLabel: $('startBestLabel'),
    startBest: $('startBest'),
    btnStart: $('btnStart'),
    btnResume: $('btnResume'),
    btnRestartPause: $('btnRestartPause'),
    btnMenuPause: $('btnMenuPause'),
    btnRestart: $('btnRestart'),
    btnMenu: $('btnMenu'),
    overTitle: $('overTitle'),
    overScore: $('overScore'),
    overLines: $('overLines'),
    overLevel: $('overLevel'),
    overTime: $('overTime'),
    overBestLabel: $('overBestLabel'),
    overBest: $('overBest'),
    overNew: $('overNew')
  };

  var game = new Game();
  var renderer = new Renderer(els.board);

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
  function toast(text, cls) {
    els.toast.textContent = text;
    els.toast.className = 'toast show' + (cls ? ' toast--' + cls : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.className = 'toast'; }, 950);
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
    setText(els.hudScore, 'score', fmt(game.score));
    setText(els.hudLevel, 'level', String(game.level));
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
  }

  var previewKey = '';
  function drawPreviews(force) {
    var key = (game.holdType || '-') + (game.canHold ? '1' : '0') + game.nextTypes(NEXT_SLOTS).join('');
    if (!force && key === previewKey) return;
    previewKey = key;
    Renderer.drawPreview(els.hold, game.holdType ? [game.holdType] : [], PREVIEW_CELL, 1, !game.canHold);
    Renderer.drawPreview(els.next, game.nextTypes(NEXT_SLOTS), PREVIEW_CELL, NEXT_SLOTS, false);
  }

  // ----- 레이아웃 -----
  function fit() {
    var rect = els.play.getBoundingClientRect();
    var style = getComputedStyle(els.play);
    var padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    var padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    var gap = parseFloat(style.columnGap || style.gap) || 0;
    var sideW = els.hold.parentElement.getBoundingClientRect().width;
    var availW = rect.width - padX - 2 * sideW - 2 * gap;
    var availH = rect.height - padY;
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

  function goMenu() {
    Music.stop();
    input.stopAll();
    game.reset({ mode: prefs.mode, startLevel: prefs.startLevel });
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
    game.start();
    hudCache = {};
    previewKey = '';
    showOverlay(null);
    updateHUD();
    drawPreviews(true);
    Music.setLevel(game.level);
    Music.setDanger(false);
    Music.start();
    toast(MODES[game.mode].name + ' 시작!', 'level');
  }

  function pauseGame() {
    if (!game.running || game.paused || game.over) return;
    game.paused = true;
    input.stopAll();
    Music.pause();
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
    if (info.points > 0) label = (label ? label + '\n' : '') + '+' + fmt(info.points);

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

  game.on('gameover', function (info) {
    input.stopAll();
    Music.stop();
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

    // 스프린트는 완주했을 때만 기록 (짧을수록 좋음)
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

    els.overScore.textContent = fmt(info.score);
    els.overLines.textContent = String(info.lines);
    els.overLevel.textContent = String(info.level);
    els.overTime.textContent = fmtTime(info.elapsed, true);
    els.overBestLabel.textContent = MODES[mode].bestLabel;
    els.overBest.textContent = bestText(mode);
    els.overNew.hidden = !isNew;
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
    renderer.tick(dt);

    dangerCheck += dt;
    if (dangerCheck > 120) {
      dangerCheck = 0;
      var d = game.running && !game.over && game.stackHeight() >= Game.ROWS - DANGER_ROWS;
      if (d !== danger) { danger = d; Music.setDanger(d); }
    }

    renderer.draw(game, { ghost: settings.ghost, danger: danger });
    applyShake(dt);
    updateHUD();
    drawPreviews(false);
    requestAnimationFrame(frame);
  }

  // ----- 초기화 -----
  game.reset({ mode: prefs.mode, startLevel: prefs.startLevel });
  refreshStartScreen();
  updateHUD();
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
  window.__tetris = { game: game, renderer: renderer, settings: settings, prefs: prefs, start: startGame };
})();
