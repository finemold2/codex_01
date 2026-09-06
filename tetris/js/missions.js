/* missions.js — 게임 중 랜덤 미션 (제한 시간 안에 목표 달성 → 보너스 점수·피버·아이템)
 *
 * 게임 이벤트(clear/lock/hold)를 구독해 진행도를 세고, update(dt)로 시간을 관리한다.
 * 렌더링과 무관하며 Node에서 테스트 가능.
 */
(function (global) {
  'use strict';

  var FIRST_DELAY = 6000;
  var COOLDOWN_OK = 8000;
  var COOLDOWN_FAIL = 6000;

  var TEMPLATES = [
    {
      id: 'lines', weight: 3,
      build: function (g) {
        var n = Math.min(8, 3 + Math.floor(g.level / 3));
        return { title: n + '줄 지우기', goal: n, limit: 26000 + n * 2500, key: 'lines', reward: 120 * n };
      }
    },
    {
      id: 'tetris', weight: 2,
      build: function () {
        return { title: '테트리스 1회', goal: 1, limit: 60000, key: 'tetris', reward: 1500 };
      }
    },
    {
      id: 'tspin', weight: 1, minLevel: 2,
      build: function () {
        return { title: 'T-스핀 라인 클리어', goal: 1, limit: 60000, key: 'tspin', reward: 1800 };
      }
    },
    {
      id: 'combo', weight: 2,
      build: function (g) {
        var n = g.level >= 5 ? 3 : 2;
        return { title: '콤보 ×' + n + ' 달성', goal: n, limit: 45000, key: 'combo', reward: 600 * n };
      }
    },
    {
      id: 'nohold', weight: 2,
      build: function (g) {
        var n = 6 + Math.min(6, g.level);
        return { title: '홀드 없이 ' + n + '개 놓기', goal: n, limit: 60000, key: 'pieces', failOnHold: true, reward: 80 * n };
      }
    },
    {
      id: 'harddrop', weight: 2,
      build: function () {
        return { title: '하드 드롭 8번', goal: 8, limit: 20000, key: 'hardDrops', reward: 500 };
      }
    },
    {
      id: 'multi', weight: 2,
      build: function () {
        return { title: '더블 이상 2번', goal: 2, limit: 40000, key: 'multi', reward: 900 };
      }
    }
  ];

  function Missions(game, opts) {
    opts = opts || {};
    this.game = game;
    this.rng = opts.random || Math.random;
    this.listeners = {};
    this.active = null;
    this.cooldown = FIRST_DELAY;
    this.lastId = null;
    this.completed = 0;
    this.failed = 0;

    var self = this;
    game.on('start', function () { self.reset(); });
    game.on('clear', function (e) {
      var m = self.active;
      if (!m) return;
      if (m.key === 'lines') m.progress += e.lines;
      else if (m.key === 'tetris' && e.lines === 4) m.progress++;
      else if (m.key === 'tspin' && e.tspin && e.lines > 0) m.progress++;
      else if (m.key === 'combo') m.progress = Math.max(m.progress, e.combo);
      else if (m.key === 'multi' && e.lines >= 2) m.progress++;
    });
    game.on('lock', function () {
      var m = self.active;
      if (!m) return;
      if (m.key === 'pieces') m.progress++;
      else if (m.key === 'hardDrops') m.progress = game.stats.hardDrops - m.baseHardDrops;
    });
    game.on('hold', function () {
      var m = self.active;
      if (m && m.failOnHold) self.fail('hold');
    });
  }

  var P = Missions.prototype;

  P.on = function (ev, fn) {
    (this.listeners[ev] = this.listeners[ev] || []).push(fn);
    return this;
  };
  P.emit = function (ev, data) {
    var l = this.listeners[ev];
    if (!l) return;
    for (var i = 0; i < l.length; i++) l[i](data);
  };

  P.reset = function () {
    this.active = null;
    this.cooldown = FIRST_DELAY;
    this.lastId = null;
    this.completed = 0;
    this.failed = 0;
  };

  P.pick = function () {
    var g = this.game;
    var pool = [];
    var total = 0;
    for (var i = 0; i < TEMPLATES.length; i++) {
      var t = TEMPLATES[i];
      if (t.id === this.lastId) continue;
      if (t.minLevel && g.level < t.minLevel) continue;
      pool.push(t);
      total += t.weight;
    }
    var r = this.rng() * total;
    for (var j = 0; j < pool.length; j++) {
      r -= pool[j].weight;
      if (r <= 0) return pool[j];
    }
    return pool[pool.length - 1];
  };

  P.spawn = function () {
    var t = this.pick();
    var m = t.build(this.game);
    m.id = t.id;
    m.progress = 0;
    m.elapsed = 0;
    m.baseHardDrops = this.game.stats.hardDrops;
    this.active = m;
    this.lastId = t.id;
    this.emit('new', m);
    return m;
  };

  P.complete = function () {
    var m = this.active;
    if (!m) return;
    var reward = Math.round(m.reward * (1 + (this.game.level - 1) * 0.15));
    this.active = null;
    this.cooldown = COOLDOWN_OK;
    this.completed++;
    this.emit('complete', { mission: m, reward: reward });
  };

  P.fail = function (reason) {
    var m = this.active;
    if (!m) return;
    this.active = null;
    this.cooldown = COOLDOWN_FAIL;
    this.failed++;
    this.emit('fail', { mission: m, reason: reason || 'time' });
  };

  P.update = function (dt) {
    var g = this.game;
    if (!g.running || g.paused || g.over) return;
    var m = this.active;
    if (m) {
      m.elapsed += dt;
      if (m.progress >= m.goal) this.complete();
      else if (m.elapsed >= m.limit) this.fail('time');
      return;
    }
    this.cooldown -= dt;
    if (this.cooldown <= 0) this.spawn();
  };

  Missions.TEMPLATES = TEMPLATES;
  global.Missions = Missions;
  if (typeof module !== 'undefined' && module.exports) module.exports = Missions;
})(typeof window !== 'undefined' ? window : this);
