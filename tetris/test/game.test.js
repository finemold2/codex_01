/* game.test.js — 코어 로직 단위 테스트 (node tetris/test/game.test.js) */
'use strict';

var assert = require('assert');
var T = require('../js/tetrominoes.js');
var Game = require('../js/game.js');

var COLS = Game.COLS, ROWS = Game.ROWS, HIDDEN = Game.HIDDEN, TOTAL = ROWS + HIDDEN;

function seeded(seed) {
  var s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function newGame(seed) {
  var g = new Game({ random: seeded(seed || 1) });
  g.start();
  return g;
}

function fillRow(g, y, exceptCols) {
  for (var x = 0; x < COLS; x++) {
    if (exceptCols && exceptCols.indexOf(x) !== -1) continue;
    g.board[y][x] = 'J';
  }
}

function forcePiece(g, type, x, y, rot) {
  g.piece = { type: type, rot: rot || 0, x: x, y: y, cells: T.ROTATIONS[type][rot || 0] };
  g.lowestY = y;
  g.lockTimer = 0;
  g.lockMoves = 0;
  g.lastMoveWasRotate = false;
  g.lastKick = 0;
}

var passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}

console.log('tetrominoes');

test('T 조각 시계 회전 상태가 SRS와 일치', function () {
  assert.deepStrictEqual(T.ROTATIONS.T[1], [[0, 1, 0], [0, 1, 1], [0, 1, 0]]);
  assert.deepStrictEqual(T.ROTATIONS.T[2], [[0, 0, 0], [1, 1, 1], [0, 1, 0]]);
  assert.deepStrictEqual(T.ROTATIONS.T[3], [[0, 1, 0], [1, 1, 0], [0, 1, 0]]);
});

test('I 조각 회전 상태 1은 세로', function () {
  assert.deepStrictEqual(T.ROTATIONS.I[1], [[0, 0, 1, 0], [0, 0, 1, 0], [0, 0, 1, 0], [0, 0, 1, 0]]);
});

test('벽차기 테이블 조회', function () {
  assert.strictEqual(T.kicksFor('T', 0, 1).length, 5);
  assert.strictEqual(T.kicksFor('I', 0, 1).length, 5);
  assert.deepStrictEqual(T.kicksFor('O', 0, 1), [[0, 0]]);
});

console.log('game');

test('7-bag: 처음 7개는 서로 다른 모든 조각', function () {
  var g = new Game({ random: seeded(42) });
  var types = [g.queue[0], g.queue[1], g.queue[2], g.queue[3], g.queue[4]];
  types.push(g.drawFromBag(), g.drawFromBag());
  assert.deepStrictEqual(types.slice().sort(), T.TYPES.slice().sort());
});

test('시작 시 조각이 스폰되고 화면 최상단에 진입', function () {
  var g = newGame(3);
  assert.ok(g.piece);
  assert.ok(g.running);
  // 스폰 직후 한 칸 낙하 → 조각의 가장 아래 셀은 화면(HIDDEN) 첫 줄
  var p = g.piece, maxY = -1;
  for (var cy = 0; cy < p.cells.length; cy++) {
    for (var cx = 0; cx < p.cells[cy].length; cx++) if (p.cells[cy][cx]) maxY = Math.max(maxY, p.y + cy);
  }
  assert.strictEqual(maxY, HIDDEN);
});

test('좌우 이동 및 벽 경계', function () {
  var g = newGame(3);
  forcePiece(g, 'O', 4, HIDDEN);
  for (var i = 0; i < 20; i++) g.move(-1);
  assert.strictEqual(g.piece.x, 0);
  for (var j = 0; j < 20; j++) g.move(1);
  assert.strictEqual(g.piece.x, COLS - 2);
});

test('하드 드롭은 바닥에 고정하고 2점/칸 가산', function () {
  var g = newGame(3);
  forcePiece(g, 'O', 4, HIDDEN);
  var before = g.score;
  var n = g.hardDrop();
  assert.strictEqual(n, ROWS - 2);
  assert.strictEqual(g.score - before, n * 2);
  assert.strictEqual(g.board[TOTAL - 1][4], 'O');
  assert.strictEqual(g.board[TOTAL - 1][5], 'O');
  assert.strictEqual(g.board[TOTAL - 2][4], 'O');
  assert.ok(g.piece, '다음 조각이 스폰됨');
});

test('고스트 Y는 낙하 지점', function () {
  var g = newGame(3);
  forcePiece(g, 'O', 4, HIDDEN);
  assert.strictEqual(g.ghostY(), TOTAL - 2);
});

test('중력으로 자동 낙하하고 락 딜레이 후 고정', function () {
  var g = newGame(3);
  forcePiece(g, 'O', 0, TOTAL - 3);
  g.update(g.gravityMs());
  assert.strictEqual(g.piece.y, TOTAL - 2, '한 칸 낙하');
  g.update(Game.LOCK_DELAY - 1);
  assert.ok(g.piece && g.piece.type === 'O', '아직 고정 전');
  g.update(2);
  assert.strictEqual(g.board[TOTAL - 1][0], 'O', '고정됨');
});

test('접지 상태에서 이동하면 락 타이머 리셋 (최대 15회)', function () {
  var g = newGame(3);
  forcePiece(g, 'O', 4, TOTAL - 2);
  g.update(400);
  g.move(-1);
  assert.strictEqual(g.lockTimer, 0);
  for (var i = 0; i < 20; i++) g.move(i % 2 ? -1 : 1);
  assert.strictEqual(g.lockMoves, 15);
  g.update(400);
  g.move(1);
  assert.strictEqual(g.lockTimer, 400, '15회 초과 시 리셋 안 됨');
});

test('더블 라인 클리어 + 퍼펙트 클리어 점수', function () {
  var g = newGame(3);
  fillRow(g, TOTAL - 1, [4, 5]);
  fillRow(g, TOTAL - 2, [4, 5]);
  forcePiece(g, 'O', 4, HIDDEN);
  g.hardDrop();
  assert.ok(g.clearing, '클리어 연출 중');
  assert.deepStrictEqual(g.clearing.rows, [TOTAL - 2, TOTAL - 1]);
  var events = [];
  g.on('clear', function (e) { events.push(e); });
  g.update(Game.CLEAR_MS);
  assert.strictEqual(g.lines, 2);
  assert.strictEqual(events[0].lines, 2);
  assert.strictEqual(events[0].points, 300 + 1200, '더블 300 + 퍼펙트 클리어(더블) 1200');
  assert.ok(events[0].perfect);
  assert.ok(g.isBoardEmpty());
});

test('테트리스 → 800 × 레벨, 백투백 ×1.5', function () {
  var g = newGame(3);
  for (var y = TOTAL - 4; y < TOTAL; y++) fillRow(g, y, [9]);
  // 왼쪽 열들도 채워서 퍼펙트 클리어가 되지 않게
  g.board[TOTAL - 5][0] = 'J';
  forcePiece(g, 'I', 6, HIDDEN, 1); // 세로 I, 채워진 열은 x+2 = 8 → 9로 이동
  g.move(1);
  g.hardDrop();
  g.update(Game.CLEAR_MS);
  var dropPts = (TOTAL - 4 - HIDDEN) * 2 + 0; // 하드 드롭 보너스
  assert.strictEqual(g.lines, 4);
  assert.strictEqual(g.stats.tetris, 1);
  assert.ok(g.b2b, '백투백 대기');
  var scoreAfterFirst = g.score;
  assert.strictEqual(scoreAfterFirst, 800 + dropPts);

  // 두 번째 테트리스
  for (var y2 = TOTAL - 4; y2 < TOTAL; y2++) fillRow(g, y2, [9]);
  g.board[TOTAL - 5][0] = 'J'; // 퍼펙트 클리어 방지
  forcePiece(g, 'I', 7, HIDDEN, 1);
  var s0 = g.score;
  var n = g.hardDrop();
  g.update(Game.CLEAR_MS);
  assert.strictEqual(g.score - s0 - n * 2, 1200 + 50 * 1 * 1, 'B2B 1200 + 콤보 50');
});

test('T-스핀 더블: 판정(풀) + 1200점', function () {
  var g = newGame(3);
  // 전형적인 TSD 형태
  //  row TOTAL-3:  . . . X . . . . . .   (열 3에 덮개)
  //  row TOTAL-2:  X X X . . . X X X X   (열 3,4,5 비움)
  //  row TOTAL-1:  X X X X . X X X X X   (열 4 비움)
  fillRow(g, TOTAL - 2, [3, 4, 5]);
  fillRow(g, TOTAL - 1, [4]);
  g.board[TOTAL - 3][3] = 'J';
  // T(rot 1, 오른쪽 향함)를 세로로 떨어뜨려 줄기가 열 4에 들어가게 함
  forcePiece(g, 'T', 3, HIDDEN, 1);
  while (g.stepDown()) { /* 바닥까지 */ }
  assert.strictEqual(g.piece.y, TOTAL - 3);
  assert.strictEqual(g.detectTSpin(), null, '회전 전에는 T-스핀 아님');
  // 제자리 회전 → 아래를 향하며 슬롯에 딱 맞음
  assert.ok(g.rotate(1));
  assert.strictEqual(g.piece.rot, 2);
  assert.strictEqual(g.detectTSpin(), 'full');

  var events = [];
  g.on('clear', function (e) { events.push(e); });
  var s0 = g.score;
  g.hardDrop();
  assert.ok(g.clearing && g.clearing.tspin === 'full');
  g.update(Game.CLEAR_MS);
  assert.strictEqual(events[0].lines, 2);
  assert.strictEqual(events[0].tspin, 'full');
  assert.strictEqual(g.score - s0, 1200);
  assert.strictEqual(g.stats.tspins, 1);
});

test('스폰 위치가 막히면 게임 오버', function () {
  var g = newGame(3);
  var over = false;
  g.on('gameover', function () { over = true; });
  for (var y = HIDDEN - 2; y < TOTAL; y++) fillRow(g, y);
  g.piece = null;
  g.spawn();
  assert.ok(over);
  assert.ok(g.over);
  assert.ok(!g.running);
});

test('홀드: 교체 후 같은 조각 연속 홀드 불가', function () {
  var g = newGame(3);
  var first = g.piece.type;
  var next = g.queue[0];
  assert.ok(g.hold());
  assert.strictEqual(g.holdType, first);
  assert.strictEqual(g.piece.type, next);
  assert.ok(!g.hold(), '연속 홀드 불가');
  g.hardDrop();
  assert.ok(g.canHold);
});

test('레벨 업: 10줄마다, 중력 증가', function () {
  var g = newGame(3);
  var g1 = g.gravityMs();
  g.lines = 9;
  g.level = 1;
  fillRow(g, TOTAL - 1, [4, 5]);
  g.board[TOTAL - 2][0] = 'J';
  forcePiece(g, 'O', 4, HIDDEN);
  var lv = 0;
  g.on('levelup', function (l) { lv = l; });
  g.hardDrop();
  g.update(Game.CLEAR_MS);
  assert.strictEqual(g.level, 2);
  assert.strictEqual(lv, 2);
  assert.ok(g.gravityMs() < g1);
});

test('일시정지 중에는 update가 상태를 바꾸지 않음', function () {
  var g = newGame(3);
  var y = g.piece.y;
  g.paused = true;
  g.update(5000);
  assert.strictEqual(g.piece.y, y);
  assert.ok(!g.move(1));
});

test('I 조각 벽차기: 벽 옆에서 회전 가능', function () {
  var g = newGame(3);
  forcePiece(g, 'I', 0, HIDDEN, 1); // 세로 I, 열 2
  g.move(-1); g.move(-1); // 열 0으로
  assert.strictEqual(g.piece.x, -2);
  assert.ok(g.rotate(1), '벽차기로 회전 성공');
  assert.ok(g.piece.x >= 0);
});

test('시작 레벨: 레벨과 중력에 반영, 10줄마다 +1', function () {
  var g = new Game({ random: seeded(3), startLevel: 10 });
  g.start();
  assert.strictEqual(g.level, 10);
  assert.ok(g.gravityMs() < new Game({ random: seeded(3) }).gravityMs());
  g.lines = 9;
  fillRow(g, TOTAL - 1, [4, 5]);
  g.board[TOTAL - 2][0] = 'J';
  forcePiece(g, 'O', 4, HIDDEN);
  g.hardDrop();
  g.update(Game.CLEAR_MS);
  assert.strictEqual(g.level, 11);
});

test('스프린트: 40줄 달성 시 승리 종료 + 경과 시간 기록', function () {
  var g = new Game({ random: seeded(3), mode: 'sprint' });
  g.start();
  var ended = null;
  g.on('gameover', function (e) { ended = e; });
  g.update(1234);
  g.lines = 38;
  fillRow(g, TOTAL - 1, [4, 5]);
  fillRow(g, TOTAL - 2, [4, 5]);
  g.board[TOTAL - 3][0] = 'J';
  forcePiece(g, 'O', 4, HIDDEN);
  g.hardDrop();
  g.update(Game.CLEAR_MS);
  assert.ok(ended, '종료 이벤트');
  assert.strictEqual(ended.reason, 'lines');
  assert.ok(ended.won);
  assert.strictEqual(ended.lines, 40);
  assert.ok(ended.elapsed >= 1234 + Game.CLEAR_MS);
  assert.ok(g.over && !g.running);
  assert.strictEqual(g.piece, null);
});

test('울트라: 2분 경과 시 종료, 그 전에는 진행', function () {
  var g = new Game({ random: seeded(3), mode: 'ultra' });
  g.start();
  var ended = null;
  g.on('gameover', function (e) { ended = e; });
  for (var i = 0; i < 1199; i++) {
    // 조작 없이 쌓여서 탑아웃되지 않도록 보드를 비워 둔다
    for (var y = 0; y < TOTAL; y++) for (var x = 0; x < COLS; x++) g.board[y][x] = null;
    g.update(100);
  }
  assert.strictEqual(ended, null);
  assert.ok(g.elapsed < Game.ULTRA_MS);
  g.update(100);
  assert.ok(ended);
  assert.strictEqual(ended.reason, 'time');
  assert.strictEqual(ended.elapsed, Game.ULTRA_MS);
});

test('마라톤: 탑아웃 시 reason=topout, won=false', function () {
  var g = newGame(3);
  var ended = null;
  g.on('gameover', function (e) { ended = e; });
  for (var y = HIDDEN - 2; y < TOTAL; y++) fillRow(g, y);
  g.piece = null;
  g.spawn();
  assert.strictEqual(ended.reason, 'topout');
  assert.ok(!ended.won);
});

test('스택 높이 계산', function () {
  var g = newGame(3);
  assert.strictEqual(g.stackHeight(), 0);
  g.board[TOTAL - 1][0] = 'J';
  assert.strictEqual(g.stackHeight(), 1);
  g.board[TOTAL - 14][9] = 'J';
  assert.strictEqual(g.stackHeight(), 14);
});

console.log('\n' + passed + ' tests passed');
