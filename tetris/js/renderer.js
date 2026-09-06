/* renderer.js — 캔버스 렌더링 (보드, 고스트, 미리보기) */
(function (global) {
  'use strict';

  var T = global.Tetrominoes;
  var Game = global.Game;
  var COLS = Game.COLS;
  var ROWS = Game.ROWS;
  var HIDDEN = Game.HIDDEN;

  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function drawCell(ctx, x, y, s, color, alpha) {
    var pad = Math.max(1, s * 0.06);
    var inner = s - pad * 2;
    var r = Math.max(2, s * 0.18);
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.fillStyle = color;
    rr(ctx, x + pad, y + pad, inner, inner, r);
    ctx.fill();
    // 상단 하이라이트
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    rr(ctx, x + pad + inner * 0.12, y + pad + inner * 0.1, inner * 0.76, inner * 0.3, r * 0.6);
    ctx.fill();
    // 하단 그림자
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    rr(ctx, x + pad + inner * 0.12, y + pad + inner * 0.68, inner * 0.76, inner * 0.22, r * 0.6);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function drawGhostCell(ctx, x, y, s, color) {
    var pad = Math.max(1.5, s * 0.1);
    var inner = s - pad * 2;
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, s * 0.08);
    rr(ctx, x + pad, y + pad, inner, inner, Math.max(2, s * 0.16));
    ctx.stroke();
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function setupCanvas(canvas, cssW, cssH) {
    var dpr = Math.max(1, Math.min(3, global.devicePixelRatio || 1));
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function Renderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cell = 24;
    this.particles = [];
    this.flash = 0;
    this.time = 0;
  }

  Renderer.prototype.resize = function (cell) {
    this.cell = cell;
    this.ctx = setupCanvas(this.canvas, COLS * cell, ROWS * cell);
  };

  // 라인 클리어 파티클 생성 (보드에 아직 셀이 남아 있을 때 호출)
  Renderer.prototype.burst = function (game, rows) {
    var c = this.cell;
    for (var i = 0; i < rows.length; i++) {
      var by = rows[i];
      if (by < HIDDEN) continue;
      for (var bx = 0; bx < COLS; bx++) {
        var t = game.board[by][bx];
        if (!t) continue;
        var color = T.COLORS[t];
        for (var k = 0; k < 2; k++) {
          var dir = bx < COLS / 2 ? -1 : 1;
          this.particles.push({
            x: (bx + 0.5) * c,
            y: (by - HIDDEN + 0.5) * c,
            vx: (dir * (0.4 + Math.random() * 1.2) + (Math.random() - 0.5) * 0.6) * c * 6,
            vy: (-0.6 - Math.random() * 1.2) * c * 6,
            life: 520 + Math.random() * 260,
            age: 0,
            size: c * (0.22 + Math.random() * 0.2),
            color: color
          });
        }
      }
    }
    if (this.particles.length > 600) this.particles.splice(0, this.particles.length - 600);
  };

  Renderer.prototype.tick = function (dt) {
    this.time += dt;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt / 260);
    var g = this.cell * 22; // 중력 (px/s^2)
    var s = dt / 1000;
    var alive = [];
    for (var i = 0; i < this.particles.length; i++) {
      var p = this.particles[i];
      p.age += dt;
      if (p.age >= p.life) continue;
      p.vy += g * s;
      p.x += p.vx * s;
      p.y += p.vy * s;
      alive.push(p);
    }
    this.particles = alive;
  };

  Renderer.prototype.drawEffects = function (opts) {
    var ctx = this.ctx;
    var c = this.cell;
    var W = COLS * c;
    var H = ROWS * c;

    for (var i = 0; i < this.particles.length; i++) {
      var p = this.particles[i];
      var k = 1 - p.age / p.life;
      ctx.globalAlpha = Math.max(0, k);
      ctx.fillStyle = p.color;
      var sz = p.size * (0.4 + 0.6 * k);
      ctx.fillRect(p.x - sz / 2, p.y - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;

    if (opts.danger) {
      var pulse = 0.35 + 0.25 * Math.sin(this.time / 140);
      var grad = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.75);
      grad.addColorStop(0, 'rgba(255,60,90,0)');
      grad.addColorStop(1, 'rgba(255,60,90,' + pulse.toFixed(3) + ')');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }

    if (this.flash > 0) {
      ctx.fillStyle = 'rgba(255,255,255,' + (this.flash * 0.45).toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
    }
  };

  Renderer.prototype.draw = function (game, opts) {
    opts = opts || {};
    var ctx = this.ctx;
    var c = this.cell;
    var W = COLS * c;
    var H = ROWS * c;

    ctx.fillStyle = '#0d0f17';
    ctx.fillRect(0, 0, W, H);

    // 격자
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var gx = 1; gx < COLS; gx++) {
      ctx.moveTo(gx * c + 0.5, 0);
      ctx.lineTo(gx * c + 0.5, H);
    }
    for (var gy = 1; gy < ROWS; gy++) {
      ctx.moveTo(0, gy * c + 0.5);
      ctx.lineTo(W, gy * c + 0.5);
    }
    ctx.stroke();

    // 고정된 블록
    var board = game.board;
    for (var by = HIDDEN; by < board.length; by++) {
      for (var bx = 0; bx < COLS; bx++) {
        var t = board[by][bx];
        if (t) drawCell(ctx, bx * c, (by - HIDDEN) * c, c, T.COLORS[t]);
      }
    }

    var p = game.piece;
    if (p && !game.clearing) {
      var color = T.COLORS[p.type];
      // 고스트
      if (opts.ghost !== false) {
        var gyPos = game.ghostY();
        if (gyPos !== p.y) {
          for (var cy = 0; cy < p.cells.length; cy++) {
            for (var cx = 0; cx < p.cells[cy].length; cx++) {
              if (!p.cells[cy][cx]) continue;
              var ry = gyPos + cy - HIDDEN;
              if (ry < 0) continue;
              drawGhostCell(ctx, (p.x + cx) * c, ry * c, c, color);
            }
          }
        }
      }
      // 현재 조각
      for (var py = 0; py < p.cells.length; py++) {
        for (var px = 0; px < p.cells[py].length; px++) {
          if (!p.cells[py][px]) continue;
          var vy = p.y + py - HIDDEN;
          if (vy < 0) continue;
          drawCell(ctx, (p.x + px) * c, vy * c, c, color, game.over ? 0.6 : 1);
        }
      }
    }

    // 라인 클리어 연출
    if (game.clearing) {
      var prog = Math.min(1, game.clearing.t / Game.CLEAR_MS);
      var rows = game.clearing.rows;
      for (var i = 0; i < rows.length; i++) {
        var ry2 = rows[i] - HIDDEN;
        if (ry2 < 0) continue;
        ctx.globalAlpha = 1 - prog;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, ry2 * c, W, c);
        // 가운데서 바깥으로 사라지는 효과
        ctx.globalAlpha = prog;
        ctx.fillStyle = '#0d0f17';
        var half = (W / 2) * prog;
        ctx.fillRect(W / 2 - half, ry2 * c, half * 2, c);
        ctx.globalAlpha = 1;
      }
    }

    this.drawEffects(opts);

    // 게임 오버 어둡게
    if (game.over && !game.won) {
      ctx.fillStyle = 'rgba(8,9,14,0.45)';
      ctx.fillRect(0, 0, W, H);
    }
  };

  // 미리보기: types 배열을 세로로 슬롯(3칸 높이)마다 하나씩 그림
  Renderer.drawPreview = function (canvas, types, cell, slots, dim) {
    var w = 4 * cell;
    var h = slots * 3 * cell;
    var ctx = setupCanvas(canvas, w, h);
    ctx.clearRect(0, 0, w, h);
    for (var i = 0; i < types.length && i < slots; i++) {
      var t = types[i];
      if (!t) continue;
      var m = T.ROTATIONS[t][0];
      var minX = 9, maxX = -1, minY = 9, maxY = -1;
      for (var y = 0; y < m.length; y++) {
        for (var x = 0; x < m[y].length; x++) {
          if (!m[y][x]) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      var pw = maxX - minX + 1;
      var ph = maxY - minY + 1;
      var ox = ((4 - pw) / 2) * cell;
      var oy = i * 3 * cell + ((3 - ph) / 2) * cell;
      for (var yy = minY; yy <= maxY; yy++) {
        for (var xx = minX; xx <= maxX; xx++) {
          if (!m[yy][xx]) continue;
          drawCell(ctx, ox + (xx - minX) * cell, oy + (yy - minY) * cell, cell, T.COLORS[t], dim ? 0.35 : 1);
        }
      }
    }
  };

  global.Renderer = Renderer;
})(window);
