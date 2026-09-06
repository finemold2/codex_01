/* game.js — 테트리스 코어 로직 (렌더링/입력과 무관, Node에서도 테스트 가능)
 *
 * - 10×20 보드 + 상단 숨김 4줄
 * - 7-bag 랜덤, SRS 회전 + 벽차기, 홀드, 미리보기 큐, 고스트
 * - 락 딜레이(500ms, 이동 리셋 최대 15회), 소프트/하드 드롭
 * - 가이드라인 점수: 라인/T-스핀/백투백/콤보/퍼펙트 클리어
 */
(function (global) {
  'use strict';

  var T = global.Tetrominoes || (typeof require === 'function' ? require('./tetrominoes.js') : null);

  var COLS = 10;
  var ROWS = 20;
  var HIDDEN = 4;
  var TOTAL = ROWS + HIDDEN;

  var LOCK_DELAY = 500;      // ms
  var MAX_LOCK_MOVES = 15;
  var SOFT_DROP_MS = 35;     // 소프트 드롭 한 칸 간격
  var CLEAR_MS = 240;        // 라인 클리어 연출 시간
  var QUEUE_SIZE = 5;

  var SCORE_NORMAL = [0, 100, 300, 500, 800];
  var SCORE_TSPIN = [400, 800, 1200, 1600, 1600];
  var SCORE_MINI = [100, 200, 400, 400, 400];
  var SCORE_PERFECT = [0, 800, 1200, 1800, 2000];

  function emptyRow() {
    var r = [];
    for (var i = 0; i < COLS; i++) r.push(null);
    return r;
  }

  var SPRINT_LINES = 40;
  var ULTRA_MS = 120000;

  function Game(opts) {
    opts = opts || {};
    this.rng = opts.random || Math.random;
    this.listeners = {};
    this.reset(opts);
  }

  Game.COLS = COLS;
  Game.ROWS = ROWS;
  Game.HIDDEN = HIDDEN;
  Game.CLEAR_MS = CLEAR_MS;
  Game.LOCK_DELAY = LOCK_DELAY;
  Game.SPRINT_LINES = SPRINT_LINES;
  Game.ULTRA_MS = ULTRA_MS;

  var P = Game.prototype;

  // ----- 이벤트 -----
  P.on = function (ev, fn) {
    (this.listeners[ev] = this.listeners[ev] || []).push(fn);
    return this;
  };

  P.emit = function (ev, data) {
    var l = this.listeners[ev];
    if (!l) return;
    for (var i = 0; i < l.length; i++) l[i](data);
  };

  // ----- 상태 초기화 -----
  // opts.mode: 'marathon' | 'sprint'(40줄) | 'ultra'(2분), opts.startLevel: 1~
  P.reset = function (opts) {
    opts = opts || {};
    this.mode = opts.mode || 'marathon';
    this.startLevel = Math.max(1, opts.startLevel || 1);
    this.elapsed = 0;
    this.won = false;

    this.board = [];
    for (var y = 0; y < TOTAL; y++) this.board.push(emptyRow());

    this.bag = [];
    this.queue = [];
    while (this.queue.length < QUEUE_SIZE) this.queue.push(this.drawFromBag());

    this.holdType = null;
    this.canHold = true;
    this.piece = null;
    this.clearing = null;

    this.score = 0;
    this.lines = 0;
    this.level = this.startLevel;
    this.combo = -1;
    this.b2b = false;

    this.running = false;
    this.paused = false;
    this.over = false;

    this.softDrop = false;
    this.dropTimer = 0;
    this.lockTimer = 0;
    this.lockMoves = 0;
    this.lowestY = -1;
    this.lastMoveWasRotate = false;
    this.lastKick = 0;

    this.stats = { pieces: 0, tetris: 0, tspins: 0, maxCombo: 0 };
  };

  P.start = function () {
    this.running = true;
    this.spawn();
    this.emit('start');
  };

  // ----- 7-bag -----
  P.drawFromBag = function () {
    if (!this.bag.length) {
      this.bag = T.TYPES.slice();
      for (var i = this.bag.length - 1; i > 0; i--) {
        var j = Math.floor(this.rng() * (i + 1));
        var tmp = this.bag[i];
        this.bag[i] = this.bag[j];
        this.bag[j] = tmp;
      }
    }
    return this.bag.pop();
  };

  P.nextTypes = function (n) {
    return this.queue.slice(0, n);
  };

  // ----- 충돌 -----
  P.collides = function (cells, x, y) {
    for (var cy = 0; cy < cells.length; cy++) {
      for (var cx = 0; cx < cells[cy].length; cx++) {
        if (!cells[cy][cx]) continue;
        var bx = x + cx;
        var by = y + cy;
        if (bx < 0 || bx >= COLS || by < 0 || by >= TOTAL) return true;
        if (this.board[by][bx]) return true;
      }
    }
    return false;
  };

  P.canAct = function () {
    return this.running && !this.paused && !this.over && !!this.piece && !this.clearing;
  };

  P.isGrounded = function () {
    var p = this.piece;
    return !!p && this.collides(p.cells, p.x, p.y + 1);
  };

  P.ghostY = function () {
    var p = this.piece;
    if (!p) return 0;
    var y = p.y;
    while (!this.collides(p.cells, p.x, y + 1)) y++;
    return y;
  };

  // ----- 스폰 -----
  P.spawn = function (type) {
    var t = type;
    if (!t) {
      t = this.queue.shift();
      this.queue.push(this.drawFromBag());
    }
    var cells = T.ROTATIONS[t][0];
    var size = cells.length;
    var piece = {
      type: t,
      rot: 0,
      x: Math.floor((COLS - size) / 2),
      y: HIDDEN - 2, // 숨김 영역 안에서 스폰 → 첫 낙하로 화면에 진입
      cells: cells
    };

    this.piece = piece;
    if (this.collides(cells, piece.x, piece.y)) {
      this.gameOver();
      return;
    }

    this.lowestY = piece.y;
    this.lockTimer = 0;
    this.lockMoves = 0;
    this.dropTimer = 0;
    this.lastMoveWasRotate = false;
    this.lastKick = 0;
    this.stats.pieces++;

    // 가이드라인: 스폰 직후 가능하면 한 칸 즉시 낙하
    this.stepDown();
    this.emit('spawn', piece);
  };

  // 접지 상태에서의 이동/회전 → 락 타이머 리셋 (최대 15회)
  P.afterMove = function () {
    if (this.isGrounded() && this.lockMoves < MAX_LOCK_MOVES) {
      this.lockMoves++;
      this.lockTimer = 0;
    }
  };

  // ----- 조작 -----
  P.move = function (dx) {
    if (!this.canAct()) return false;
    var p = this.piece;
    if (this.collides(p.cells, p.x + dx, p.y)) return false;
    p.x += dx;
    this.lastMoveWasRotate = false;
    this.afterMove();
    return true;
  };

  P.rotate = function (dir) {
    if (!this.canAct()) return false;
    var p = this.piece;
    if (p.type === 'O') return true;
    var to = (p.rot + dir + 4) % 4;
    var cells = T.ROTATIONS[p.type][to];
    var kicks = T.kicksFor(p.type, p.rot, to);
    for (var i = 0; i < kicks.length; i++) {
      var nx = p.x + kicks[i][0];
      var ny = p.y - kicks[i][1];
      if (!this.collides(cells, nx, ny)) {
        p.x = nx;
        p.y = ny;
        p.rot = to;
        p.cells = cells;
        this.lastMoveWasRotate = true;
        this.lastKick = i;
        this.afterMove();
        return true;
      }
    }
    return false;
  };

  // 내부용: 한 칸 아래로 (성공 여부 반환)
  P.stepDown = function () {
    var p = this.piece;
    if (!p) return false;
    if (this.collides(p.cells, p.x, p.y + 1)) return false;
    p.y++;
    this.lastMoveWasRotate = false;
    if (p.y > this.lowestY) {
      this.lowestY = p.y;
      this.lockMoves = 0;
    }
    this.lockTimer = 0;
    return true;
  };

  // 수동 소프트 드롭 한 칸 (제스처용)
  P.softStep = function () {
    if (!this.canAct()) return false;
    if (!this.stepDown()) return false;
    this.score += 1;
    return true;
  };

  P.hardDrop = function () {
    if (!this.canAct()) return 0;
    var n = 0;
    while (this.stepDown()) n++;
    this.score += n * 2;
    this.lockPiece();
    return n;
  };

  P.hold = function () {
    if (!this.canAct() || !this.canHold) return false;
    var cur = this.piece.type;
    var prev = this.holdType;
    this.holdType = cur;
    this.canHold = false;
    this.piece = null;
    this.stats.pieces--; // spawn에서 다시 증가하므로 보정
    this.spawn(prev || undefined);
    this.emit('hold', { held: cur, released: prev });
    return true;
  };

  // ----- 고정 & 라인 클리어 -----
  P.lockPiece = function () {
    var p = this.piece;
    if (!p) return;
    var tspin = this.detectTSpin();
    var allHidden = true;

    for (var cy = 0; cy < p.cells.length; cy++) {
      for (var cx = 0; cx < p.cells[cy].length; cx++) {
        if (!p.cells[cy][cx]) continue;
        var bx = p.x + cx;
        var by = p.y + cy;
        if (by >= 0 && by < TOTAL && bx >= 0 && bx < COLS) {
          this.board[by][bx] = p.type;
          if (by >= HIDDEN) allHidden = false;
        }
      }
    }

    this.piece = null;
    this.canHold = true;
    this.emit('lock', { type: p.type, tspin: tspin });

    if (allHidden) {
      // 락 아웃: 화면 밖에서 고정되면 게임 오버
      this.gameOver();
      return;
    }

    var full = this.fullRows();
    if (full.length) {
      this.clearing = { rows: full, t: 0, tspin: tspin };
      this.emit('clearStart', { rows: full });
    } else {
      this.applyScore(0, tspin);
      if (!this.over) this.spawn();
    }
  };

  P.fullRows = function () {
    var rows = [];
    for (var y = 0; y < TOTAL; y++) {
      var full = true;
      for (var x = 0; x < COLS; x++) {
        if (!this.board[y][x]) { full = false; break; }
      }
      if (full) rows.push(y);
    }
    return rows;
  };

  P.removeRows = function (rows) {
    var set = {};
    for (var i = 0; i < rows.length; i++) set[rows[i]] = true;
    var nb = [];
    for (var y = 0; y < TOTAL; y++) {
      if (!set[y]) nb.push(this.board[y]);
    }
    while (nb.length < TOTAL) nb.unshift(emptyRow());
    this.board = nb;
  };

  P.isBoardEmpty = function () {
    for (var y = 0; y < TOTAL; y++) {
      for (var x = 0; x < COLS; x++) {
        if (this.board[y][x]) return false;
      }
    }
    return true;
  };

  // T-스핀 판정: 마지막 조작이 회전이고, T 중심 주변 4모서리 중 3개 이상이 막혀 있을 것
  P.detectTSpin = function () {
    var p = this.piece;
    if (!p || p.type !== 'T' || !this.lastMoveWasRotate) return null;
    var corners = [[0, 0], [2, 0], [0, 2], [2, 2]]; // TL, TR, BL, BR
    var FRONT = [[0, 1], [1, 3], [2, 3], [0, 2]];   // 회전 상태별 "앞쪽" 두 모서리
    var filled = [];
    var total = 0;
    for (var i = 0; i < 4; i++) {
      var bx = p.x + corners[i][0];
      var by = p.y + corners[i][1];
      var occ = bx < 0 || bx >= COLS || by >= TOTAL || (by >= 0 && !!this.board[by][bx]);
      filled.push(occ ? 1 : 0);
      total += occ ? 1 : 0;
    }
    if (total < 3) return null;
    var f = FRONT[p.rot];
    var frontCount = filled[f[0]] + filled[f[1]];
    if (frontCount === 2 || this.lastKick === 4) return 'full';
    return 'mini';
  };

  P.applyScore = function (n, tspin) {
    var base = tspin === 'full' ? SCORE_TSPIN[n] : tspin === 'mini' ? SCORE_MINI[n] : SCORE_NORMAL[n];
    var difficult = n === 4 || (!!tspin && n > 0);
    var pts = base * this.level;
    var b2bApplied = false;

    if (difficult && this.b2b) {
      pts *= 1.5;
      b2bApplied = true;
    }

    if (n > 0) {
      this.b2b = difficult;
      this.combo++;
      if (this.combo > 0) pts += 50 * this.combo * this.level;
      if (this.combo > this.stats.maxCombo) this.stats.maxCombo = this.combo;
    } else {
      this.combo = -1;
    }

    var perfect = n > 0 && this.isBoardEmpty();
    if (perfect) pts += SCORE_PERFECT[n] * this.level;

    pts = Math.floor(pts);
    this.score += pts;
    this.lines += n;
    if (n === 4) this.stats.tetris++;
    if (tspin) this.stats.tspins++;

    var newLevel = this.startLevel + Math.floor(this.lines / 10);
    var levelUp = newLevel > this.level;
    this.level = newLevel;

    if (n > 0 || tspin) {
      this.emit('clear', {
        lines: n,
        tspin: tspin,
        b2b: b2bApplied,
        combo: this.combo,
        perfect: perfect,
        points: pts
      });
    }
    if (levelUp) this.emit('levelup', this.level);

    if (this.mode === 'sprint' && this.lines >= SPRINT_LINES) this.finish('lines');
  };

  // 스택 높이: 화면 아래에서부터 가장 높은 블록까지의 줄 수
  P.stackHeight = function () {
    for (var y = HIDDEN; y < TOTAL; y++) {
      for (var x = 0; x < COLS; x++) {
        if (this.board[y][x]) return TOTAL - y;
      }
    }
    return 0;
  };

  P.summary = function (reason) {
    return {
      reason: reason,
      mode: this.mode,
      won: this.won,
      score: this.score,
      lines: this.lines,
      level: this.level,
      elapsed: this.elapsed,
      stats: this.stats
    };
  };

  // 목표 달성으로 종료 (스프린트 40줄, 울트라 시간 종료)
  P.finish = function (reason) {
    if (this.over) return;
    this.over = true;
    this.won = true;
    this.running = false;
    this.piece = null;
    this.clearing = null;
    this.emit('gameover', this.summary(reason));
  };

  P.gameOver = function () {
    this.over = true;
    this.running = false;
    this.emit('gameover', this.summary('topout'));
  };

  // 레벨별 중력 (가이드라인 공식), 최소 16ms
  P.gravityMs = function () {
    var l = Math.min(this.level, 20);
    return Math.max(16, Math.pow(0.8 - (l - 1) * 0.007, l - 1) * 1000);
  };

  // ----- 프레임 업데이트 -----
  P.update = function (dt) {
    if (!this.running || this.paused || this.over) return;

    this.elapsed += dt;
    if (this.mode === 'ultra' && this.elapsed >= ULTRA_MS) {
      this.elapsed = ULTRA_MS;
      this.finish('time');
      return;
    }

    if (this.clearing) {
      this.clearing.t += dt;
      if (this.clearing.t >= CLEAR_MS) {
        var c = this.clearing;
        this.clearing = null;
        this.removeRows(c.rows);
        this.applyScore(c.rows.length, c.tspin);
        if (!this.over) this.spawn();
      }
      return;
    }

    if (!this.piece) return;

    if (this.isGrounded()) {
      this.lockTimer += dt;
      this.dropTimer = 0;
      if (this.lockTimer >= LOCK_DELAY) this.lockPiece();
      return;
    }

    var g = this.gravityMs();
    var interval = this.softDrop ? Math.min(g, SOFT_DROP_MS) : g;
    this.dropTimer += dt;
    while (this.dropTimer >= interval) {
      this.dropTimer -= interval;
      if (!this.stepDown()) {
        this.dropTimer = 0;
        break;
      }
      if (this.softDrop) this.score += 1;
    }
  };

  global.Game = Game;
  if (typeof module !== 'undefined' && module.exports) module.exports = Game;
})(typeof window !== 'undefined' ? window : this);
