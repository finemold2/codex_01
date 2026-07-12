/* storage.js — localStorage 기반 영속 계층 */
(function (global) {
  'use strict';

  var RUNS_KEY = 'runclub.runs.v1';
  var PREFS_KEY = 'runclub.prefs.v1';
  var PROGRAM_KEY = 'runclub.program.v1';
  var BADGES_KEY = 'runclub.badges.v1';

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      console.warn('storage read 실패', e);
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn('storage write 실패', e);
      return false;
    }
  }

  var Store = {
    /** 저장된 모든 러닝 (최신순) */
    getRuns: function () {
      var runs = read(RUNS_KEY, []);
      return runs.sort(function (a, b) { return b.startedAt - a.startedAt; });
    },

    getRun: function (id) {
      return this.getRuns().filter(function (r) { return r.id === id; })[0] || null;
    },

    /** 러닝 추가, 저장된 객체 반환 */
    addRun: function (run) {
      var runs = read(RUNS_KEY, []);
      run.id = run.id || ('run_' + Date.now() + '_' + Math.floor(Math.random() * 1e4));
      runs.push(run);
      write(RUNS_KEY, runs);
      return run;
    },

    deleteRun: function (id) {
      var runs = read(RUNS_KEY, []).filter(function (r) { return r.id !== id; });
      write(RUNS_KEY, runs);
    },

    /** 사용자 설정 (단위, 체중, 주간목표, 음성코치, 자동일시정지) */
    getPrefs: function () {
      var d = { unit: 'km', weightKg: 65, weeklyGoalKm: 20, voice: true, autoPause: true };
      var p = read(PREFS_KEY, {});
      for (var k in d) { if (d.hasOwnProperty(k) && p[k] === undefined) p[k] = d[k]; }
      return p;
    },

    setPrefs: function (patch) {
      var prefs = this.getPrefs();
      for (var k in patch) { if (patch.hasOwnProperty(k)) prefs[k] = patch[k]; }
      write(PREFS_KEY, prefs);
      return prefs;
    },

    /** 가이드 프로그램 진행: {"w1s1": ts, ...} */
    getProgram: function () {
      return read(PROGRAM_KEY, {});
    },

    completeSession: function (sessionId) {
      var p = read(PROGRAM_KEY, {});
      if (!p[sessionId]) p[sessionId] = Date.now();
      write(PROGRAM_KEY, p);
      return p;
    },

    /** 획득 업적: {"first-run": ts, ...} */
    getBadges: function () {
      return read(BADGES_KEY, {});
    },

    earnBadges: function (ids) {
      var b = read(BADGES_KEY, {});
      ids.forEach(function (id) { if (!b[id]) b[id] = Date.now(); });
      write(BADGES_KEY, b);
      return b;
    }
  };

  global.Store = Store;
})(window);
