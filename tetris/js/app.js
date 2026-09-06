/* app.js — UI 조립, 게임 루프, 설정/최고점수 저장 */
(function () {
  'use strict';

  var KEY_BEST = 'tetris.best';
  var KEY_SETTINGS = 'tetris.settings';
  var PREVIEW_CELL = 13;
  var NEXT_SLOTS = 3;

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

  var settings = Object.assign({ sound: true, vibrate: true, ghost: true }, loadJSON(KEY_SETTINGS, {}));
  var best = parseInt(loadJSON(KEY_BEST, 0), 10) || 0;

  // ----- DOM -----
  var els = {
    play: $('play'),
    board: $('board'),
    hold: $('holdCanvas'),
    next: $('nextCanvas'),
    hudScore: $('hudScore'),
    hudLevel: $('hudLevel'),
    hudLines: $('hudLines'),
    hudBest: $('hudBest'),
    toast: $('toast'),
    controls: $('controls'),
    btnPause: $('btnPause'),
    ovStart: $('ovStart'),
    ovPause: $('ovPause'),
    ovOver: $('ovOver'),
    startBest: $('startBest'),
    btnStart: $('btnStart'),
    btnResume: $('btnResume'),
    btnRestartPause: $('btnRestartPause'),
    btnRestart: $('btnRestart'),
    overScore: $('overScore'),
    overLines: $('overLines'),
    overLevel: $('overLevel'),
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

  var toastTimer = null;
  function toast(text, cls) {
    els.toast.textContent = text;
    els.toast.className = 'toast show' + (cls ? ' toast--' + cls : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.className = 'toast'; }, 900);
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
    setText(els.hudLines, 'lines', String(game.lines));
    setText(els.hudBest, 'best', fmt(Math.max(best, game.score)));
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

  // ----- 오버레이 -----
  function showOverlay(el) {
    [els.ovStart, els.ovPause, els.ovOver].forEach(function (o) { o.hidden = o !== el; });
  }

  function startGame() {
    Sound.unlock();
    game.reset();
    game.start();
    hudCache = {};
    previewKey = '';
    showOverlay(null);
    updateHUD();
    drawPreviews(true);
  }

  function pauseGame() {
    if (!game.running || game.paused || game.over) return;
    game.paused = true;
    input.stopAll();
    showOverlay(els.ovPause);
  }

  function resumeGame() {
    if (!game.paused) return;
    game.paused = false;
    showOverlay(null);
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

    if (label) toast(label, info.lines === 4 || info.perfect ? 'big' : info.tspin ? 'tspin' : '');

    if (info.lines === 4) { sfx('tetris'); vibrate([30, 40, 60]); }
    else if (info.tspin) { sfx('tspin'); vibrate([20, 30, 20]); }
    else if (info.lines > 0) { sfx('clear', info.lines); vibrate(20 + info.lines * 10); }
  });

  game.on('levelup', function (lv) {
    sfx('levelup');
    vibrate([15, 30, 15, 30, 15]);
    setTimeout(function () { toast('LEVEL ' + lv, 'level'); }, 300);
  });

  game.on('gameover', function (info) {
    input.stopAll();
    sfx('gameover');
    vibrate([60, 50, 120]);
    var isNew = info.score > best && info.score > 0;
    if (isNew) {
      best = info.score;
      saveJSON(KEY_BEST, best);
    }
    els.overScore.textContent = fmt(info.score);
    els.overLines.textContent = String(info.lines);
    els.overLevel.textContent = String(info.level);
    els.overBest.textContent = fmt(best);
    els.overNew.hidden = !isNew;
    els.startBest.textContent = fmt(best);
    setTimeout(function () { showOverlay(els.ovOver); }, 500);
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
      game.hardDrop();
      sfx('hard');
      vibrate(12);
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
    });
  });
  applySettings();

  // ----- 버튼 -----
  els.btnStart.addEventListener('click', startGame);
  els.btnRestart.addEventListener('click', startGame);
  els.btnRestartPause.addEventListener('click', startGame);
  els.btnResume.addEventListener('click', resumeGame);
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
  function frame(ts) {
    var dt = last ? Math.min(ts - last, 100) : 0;
    last = ts;
    game.update(dt);
    renderer.draw(game, { ghost: settings.ghost });
    updateHUD();
    drawPreviews(false);
    requestAnimationFrame(frame);
  }

  // ----- 초기화 -----
  els.startBest.textContent = fmt(best);
  els.hudBest.textContent = fmt(best);
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
  window.__tetris = { game: game, renderer: renderer, settings: settings, start: startGame };
})();
