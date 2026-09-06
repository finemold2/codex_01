/* tetrominoes.js — 7가지 테트로미노 정의, SRS 회전 상태, 벽차기(kick) 테이블 */
(function (global) {
  'use strict';

  var TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

  // 스폰(0번) 회전 상태. SRS 규격 바운딩 박스 사용.
  var BASE = {
    I: [
      [0, 0, 0, 0],
      [1, 1, 1, 1],
      [0, 0, 0, 0],
      [0, 0, 0, 0]
    ],
    O: [
      [1, 1],
      [1, 1]
    ],
    T: [
      [0, 1, 0],
      [1, 1, 1],
      [0, 0, 0]
    ],
    S: [
      [0, 1, 1],
      [1, 1, 0],
      [0, 0, 0]
    ],
    Z: [
      [1, 1, 0],
      [0, 1, 1],
      [0, 0, 0]
    ],
    J: [
      [1, 0, 0],
      [1, 1, 1],
      [0, 0, 0]
    ],
    L: [
      [0, 0, 1],
      [1, 1, 1],
      [0, 0, 0]
    ]
  };

  var COLORS = {
    I: '#00e5ff',
    O: '#ffd60a',
    T: '#c77dff',
    S: '#3ddc84',
    Z: '#ff4d6d',
    J: '#4d7cff',
    L: '#ff9f1c'
  };

  // 시계 방향 90° 회전 (바운딩 박스 안에서 회전 → SRS와 동일)
  function rotateCW(m) {
    var n = m.length;
    var r = [];
    for (var y = 0; y < n; y++) {
      r[y] = [];
      for (var x = 0; x < n; x++) {
        r[y][x] = m[n - 1 - x][y];
      }
    }
    return r;
  }

  // 각 타입별 4가지 회전 상태 미리 계산
  var ROTATIONS = {};
  TYPES.forEach(function (t) {
    var m = BASE[t];
    var states = [m];
    for (var i = 1; i < 4; i++) {
      m = rotateCW(m);
      states.push(m);
    }
    ROTATIONS[t] = states;
  });

  // SRS 벽차기 테이블. 좌표는 (dx, dy)이며 dy는 "위쪽이 양수" 규약.
  // 적용 시 화면 좌표(아래가 양수)로 바꾸기 위해 dy를 반전한다.
  var KICKS_JLSTZ = {
    '0>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    '1>0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    '1>2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    '2>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    '2>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    '3>2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    '3>0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    '0>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]]
  };

  var KICKS_I = {
    '0>1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
    '1>0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
    '1>2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
    '2>1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
    '2>3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
    '3>2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
    '3>0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
    '0>3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]]
  };

  function kicksFor(type, from, to) {
    if (type === 'O') return [[0, 0]];
    var table = type === 'I' ? KICKS_I : KICKS_JLSTZ;
    return table[from + '>' + to] || [[0, 0]];
  }

  var api = {
    TYPES: TYPES,
    BASE: BASE,
    ROTATIONS: ROTATIONS,
    COLORS: COLORS,
    rotateCW: rotateCW,
    kicksFor: kicksFor
  };

  global.Tetrominoes = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
