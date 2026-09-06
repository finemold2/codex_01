/* input.js — 키보드, 온스크린 버튼, 보드 터치 제스처
 *
 * 제스처(보드 위):
 *   좌우 드래그      → 한 칸 단위 이동
 *   탭               → 시계 방향 회전
 *   아래로 드래그    → 소프트 드롭 (한 칸 단위)
 *   아래로 빠른 스와이프 → 하드 드롭
 */
(function (global) {
  'use strict';

  var DAS = 160; // 자동 반복 시작 지연 (ms)
  var ARR = 45;  // 자동 반복 간격 (ms)

  function Repeater(fn) {
    this.fn = fn;
    this.t = null;
    this.i = null;
  }
  Repeater.prototype.start = function () {
    this.stop();
    this.fn();
    var self = this;
    this.t = setTimeout(function () {
      self.i = setInterval(self.fn, ARR);
    }, DAS);
  };
  Repeater.prototype.stop = function () {
    if (this.t) clearTimeout(this.t);
    if (this.i) clearInterval(this.i);
    this.t = null;
    this.i = null;
  };

  var KEYS = {
    ArrowLeft: 'left',
    ArrowRight: 'right',
    ArrowDown: 'soft',
    ArrowUp: 'rotCW',
    KeyX: 'rotCW',
    KeyZ: 'rotCCW',
    ControlLeft: 'rotCCW',
    ControlRight: 'rotCCW',
    Space: 'hard',
    KeyC: 'hold',
    ShiftLeft: 'hold',
    ShiftRight: 'hold',
    KeyP: 'pause',
    Escape: 'pause',
    KeyE: 'item'
  };

  function Input(cfg) {
    this.a = cfg.actions;
    this.cellSize = cfg.cellSize;
    this.rep = {
      left: new Repeater(this.a.left),
      right: new Repeater(this.a.right)
    };
    this.bindKeyboard();
    if (cfg.buttons) this.bindButtons(cfg.buttons);
    if (cfg.board) this.bindGestures(cfg.board);
  }

  Input.prototype.press = function (act) {
    switch (act) {
      case 'left':
      case 'right':
        this.rep[act].start();
        break;
      case 'soft':
        this.a.softStart();
        break;
      default:
        if (typeof this.a[act] === 'function') this.a[act]();
    }
  };

  Input.prototype.release = function (act) {
    if (act === 'left' || act === 'right') this.rep[act].stop();
    else if (act === 'soft') this.a.softStop();
  };

  Input.prototype.stopAll = function () {
    this.rep.left.stop();
    this.rep.right.stop();
    this.a.softStop();
  };

  Input.prototype.bindKeyboard = function () {
    var self = this;
    global.addEventListener('keydown', function (e) {
      var act = KEYS[e.code];
      if (!act) return;
      e.preventDefault();
      if (e.repeat) return;
      self.press(act);
    });
    global.addEventListener('keyup', function (e) {
      var act = KEYS[e.code];
      if (!act) return;
      self.release(act);
    });
    global.addEventListener('blur', function () { self.stopAll(); });
  };

  Input.prototype.bindButtons = function (container) {
    var self = this;
    var down = {}; // pointerId → action

    container.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    container.addEventListener('touchstart', function (e) { e.preventDefault(); }, { passive: false });

    container.addEventListener('pointerdown', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      try { btn.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      var act = btn.getAttribute('data-action');
      down[e.pointerId] = { act: act, btn: btn };
      btn.classList.add('is-down');
      self.press(act);
    });

    function up(e) {
      var d = down[e.pointerId];
      if (!d) return;
      delete down[e.pointerId];
      d.btn.classList.remove('is-down');
      self.release(d.act);
    }
    container.addEventListener('pointerup', up);
    container.addEventListener('pointercancel', up);
    container.addEventListener('lostpointercapture', up);
  };

  Input.prototype.bindGestures = function (canvas) {
    var self = this;
    var g = null;
    var TAP_MS = 300;
    var TAP_DIST = 10;
    var FLICK_MS = 260;

    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    canvas.addEventListener('touchstart', function (e) { e.preventDefault(); }, { passive: false });

    canvas.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (g) return; // 첫 손가락만 추적
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      g = {
        id: e.pointerId,
        x0: e.clientX, y0: e.clientY, t0: performance.now(),
        lastX: e.clientX, lastY: e.clientY,
        accX: 0, accY: 0,
        moved: false, dropped: 0
      };
    });

    canvas.addEventListener('pointermove', function (e) {
      if (!g || e.pointerId !== g.id) return;
      var cell = self.cellSize();
      var hStep = cell * 0.9;   // 가로 이동 감도
      var vStep = cell * 1.0;   // 세로(소프트 드롭) 감도
      g.accX += e.clientX - g.lastX;
      g.accY += e.clientY - g.lastY;
      g.lastX = e.clientX;
      g.lastY = e.clientY;

      // 처음 움직임의 방향을 정해 축 잠금 (사선 드래그로 오작동 방지)
      if (!g.axis) {
        var dx = e.clientX - g.x0, dy = e.clientY - g.y0;
        if (Math.abs(dx) > TAP_DIST || Math.abs(dy) > TAP_DIST) {
          g.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
        }
      }
      if (g.axis === 'x') {
        while (g.accX >= hStep) { self.a.right(); g.accX -= hStep; g.moved = true; }
        while (g.accX <= -hStep) { self.a.left(); g.accX += hStep; g.moved = true; }
        g.accY = 0;
      } else if (g.axis === 'y') {
        while (g.accY >= vStep) { self.a.softStep(); g.accY -= vStep; g.moved = true; g.dropped++; }
        if (g.accY < 0) g.accY = 0;
        g.accX = 0;
      }
    });

    function end(e) {
      if (!g || e.pointerId !== g.id) return;
      var cur = g;
      g = null;
      var dt = performance.now() - cur.t0;
      var dx = e.clientX - cur.x0;
      var dy = e.clientY - cur.y0;
      var cell = self.cellSize();

      if (!cur.moved && dt < TAP_MS && Math.abs(dx) < TAP_DIST && Math.abs(dy) < TAP_DIST) {
        self.a.tap(e);
        return;
      }
      if (cur.axis === 'y' && dy > cell * 1.2 && dt < FLICK_MS) {
        self.a.hard();
      }
    }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', function (e) { if (g && e.pointerId === g.id) g = null; });
  };

  global.Input = Input;
})(window);
