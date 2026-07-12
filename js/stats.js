/* stats.js — 포맷 헬퍼 + 통계 집계 */
(function (global) {
  'use strict';

  var Fmt = {
    /** ms → "MM:SS" 또는 "H:MM:SS" */
    duration: function (ms) {
      var s = Math.floor(ms / 1000);
      var h = Math.floor(s / 3600);
      var m = Math.floor((s % 3600) / 60);
      var sec = s % 60;
      var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
      return h > 0 ? h + ':' + pad(m) + ':' + pad(sec) : pad(m) + ':' + pad(sec);
    },

    /** 초/km → 음성 안내용 "5분 30초" */
    paceSpoken: function (secPerKm) {
      if (!secPerKm || !isFinite(secPerKm) || secPerKm <= 0) return '측정 중';
      var m = Math.floor(secPerKm / 60);
      var s = Math.round(secPerKm % 60);
      if (s === 60) { m += 1; s = 0; }
      return m + '분 ' + (s ? s + '초' : '');
    },

    /** 초 → "5:00" (세그먼트 카운트다운용) */
    clock: function (sec) {
      var m = Math.floor(sec / 60), s = sec % 60;
      return m + ':' + (s < 10 ? '0' + s : s);
    },

    /** 초/km → "M'SS\"" */
    pace: function (secPerKm) {
      if (!secPerKm || !isFinite(secPerKm) || secPerKm <= 0) return "--'--\"";
      var m = Math.floor(secPerKm / 60);
      var s = Math.round(secPerKm % 60);
      if (s === 60) { m += 1; s = 0; }
      return m + "'" + (s < 10 ? '0' + s : s) + '"';
    },

    /** m → 거리 문자열 (단위에 따라 km/mi) */
    distance: function (m, unit) {
      if (unit === 'mi') return (m / 1609.344).toFixed(2);
      return (m / 1000).toFixed(2);
    },

    distanceUnitLabel: function (unit) {
      return unit === 'mi' ? '마일' : '킬로미터';
    },

    /** 날짜 → "5월 30일 (금) · 오전 7:24" */
    dateLabel: function (ts) {
      var d = new Date(ts);
      var days = ['일', '월', '화', '수', '목', '금', '토'];
      var hh = d.getHours();
      var ampm = hh < 12 ? '오전' : '오후';
      var h12 = hh % 12; if (h12 === 0) h12 = 12;
      var mm = d.getMinutes(); mm = mm < 10 ? '0' + mm : mm;
      return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + days[d.getDay()] + ') · ' +
        ampm + ' ' + h12 + ':' + mm;
    }
  };

  var Stats = {
    /** 전체 러닝 집계 */
    summary: function (runs) {
      var totalM = 0, totalMs = 0, best = Infinity;
      runs.forEach(function (r) {
        totalM += r.distanceM || 0;
        totalMs += r.durationMs || 0;
        if (r.paceSecPerKm && r.paceSecPerKm > 0 && (r.distanceM || 0) > 400) {
          best = Math.min(best, r.paceSecPerKm);
        }
      });
      return {
        totalM: totalM,
        totalMs: totalMs,
        count: runs.length,
        bestPace: best === Infinity ? 0 : best
      };
    },

    /** 최근 7일 일별 거리(km) 배열 [월..일 today 기준 마지막 7일] */
    last7Days: function (runs) {
      var buckets = [];
      var labels = ['일', '월', '화', '수', '목', '금', '토'];
      var now = new Date();
      for (var i = 6; i >= 0; i--) {
        var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        buckets.push({ label: labels[d.getDay()], start: d.getTime(), end: d.getTime() + 86400000, km: 0 });
      }
      runs.forEach(function (r) {
        for (var j = 0; j < buckets.length; j++) {
          if (r.startedAt >= buckets[j].start && r.startedAt < buckets[j].end) {
            buckets[j].km += (r.distanceM || 0) / 1000;
            break;
          }
        }
      });
      return buckets;
    },

    /** 이번 주(최근 7일) 합계 km */
    weekKm: function (runs) {
      return this.last7Days(runs).reduce(function (a, b) { return a + b.km; }, 0);
    },

    /** 이번 달(1일~) 합계 km — 월간 챌린지용 */
    monthKm: function (runs) {
      var now = new Date();
      var start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      return runs.reduce(function (a, r) {
        return a + (r.startedAt >= start ? (r.distanceM || 0) / 1000 : 0);
      }, 0);
    }
  };

  global.Fmt = Fmt;
  global.Stats = Stats;
})(window);
