/* achievements.js — 업적 배지, NRC식 레벨, 개인기록(PR), 스트릭 */
(function (global) {
  'use strict';

  /* ---- NRC식 누적 거리 레벨 ---- */
  var LEVELS = [
    { name: '옐로',  km: 0,     color: '#ffd60a' },
    { name: '오렌지', km: 50,    color: '#ff9f0a' },
    { name: '그린',  km: 250,   color: '#30d158' },
    { name: '블루',  km: 1000,  color: '#0a84ff' },
    { name: '퍼플',  km: 2500,  color: '#bf5af2' },
    { name: '블랙',  km: 5000,  color: '#8e8e93' },
    { name: '볼트',  km: 15000, color: '#c6ff00' }
  ];

  function levelOf(totalKm) {
    var cur = LEVELS[0], next = null;
    for (var i = 0; i < LEVELS.length; i++) {
      if (totalKm >= LEVELS[i].km) cur = LEVELS[i];
      else { next = LEVELS[i]; break; }
    }
    var progress = next ? (totalKm - cur.km) / (next.km - cur.km) : 1;
    return { level: cur, next: next, progress: Math.max(0, Math.min(1, progress)) };
  }

  /* ---- 스트릭: 러닝한 연속 일수 (기준일 포함, 최신 러닝 기준) ---- */
  function dayKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function streak(runs) {
    if (!runs.length) return 0;
    var days = {};
    runs.forEach(function (r) { days[dayKey(r.startedAt)] = true; });
    var latest = Math.max.apply(null, runs.map(function (r) { return r.startedAt; }));
    var count = 0;
    var cursor = new Date(latest);
    while (days[dayKey(cursor.getTime())]) {
      count++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return count;
  }

  /* ---- 개인기록 (PR) ---- */
  function personalRecords(runs) {
    var pr = { longestM: 0, bestPace: 0, longestMs: 0 };
    runs.forEach(function (r) {
      if ((r.distanceM || 0) > pr.longestM) pr.longestM = r.distanceM;
      if ((r.durationMs || 0) > pr.longestMs) pr.longestMs = r.durationMs;
      if (r.paceSecPerKm > 0 && (r.distanceM || 0) >= 1000) {
        if (!pr.bestPace || r.paceSecPerKm < pr.bestPace) pr.bestPace = r.paceSecPerKm;
      }
    });
    return pr;
  }

  /* ---- 업적 배지 정의 ---- */
  /* ctx: { run, runs, totalKm, streak, hour, sessionCompleted, programFinished, weekKm, weeklyGoalKm } */
  var BADGES = [
    { id: 'first-run',   icon: '👟', name: '첫 발걸음',    desc: '첫 러닝 완료',
      test: function (c) { return c.runs.length >= 1; } },
    { id: 'run-5k',      icon: '🏃', name: '5K 러너',      desc: '한 번에 5km 달리기',
      test: function (c) { return c.run.distanceM >= 5000; } },
    { id: 'run-10k',     icon: '🔥', name: '10K 파이터',   desc: '한 번에 10km 달리기',
      test: function (c) { return c.run.distanceM >= 10000; } },
    { id: 'run-half',    icon: '🏅', name: '하프 마라토너', desc: '한 번에 21.1km 달리기',
      test: function (c) { return c.run.distanceM >= 21100; } },
    { id: 'total-10',    icon: '🌱', name: '누적 10K',     desc: '총 10km 달성',
      test: function (c) { return c.totalKm >= 10; } },
    { id: 'total-50',    icon: '🌿', name: '누적 50K',     desc: '총 50km 달성',
      test: function (c) { return c.totalKm >= 50; } },
    { id: 'total-100',   icon: '🌳', name: '누적 100K',    desc: '총 100km 달성',
      test: function (c) { return c.totalKm >= 100; } },
    { id: 'total-500',   icon: '⛰️', name: '누적 500K',    desc: '총 500km 달성',
      test: function (c) { return c.totalKm >= 500; } },
    { id: 'streak-3',    icon: '📆', name: '3일 연속',     desc: '3일 연속 러닝',
      test: function (c) { return c.streak >= 3; } },
    { id: 'streak-7',    icon: '🗓️', name: '위클리 스트릭', desc: '7일 연속 러닝',
      test: function (c) { return c.streak >= 7; } },
    { id: 'early-bird',  icon: '🌅', name: '얼리버드',     desc: '오전 6시 이전 러닝',
      test: function (c) { return c.hour < 6; } },
    { id: 'night-owl',   icon: '🌙', name: '나이트 러너',   desc: '밤 9시 이후 러닝',
      test: function (c) { return c.hour >= 21; } },
    { id: 'speedy',      icon: '⚡', name: '스피드 데몬',   desc: '5\'00"/km 이하로 3km+',
      test: function (c) { return c.run.distanceM >= 3000 && c.run.paceSecPerKm > 0 && c.run.paceSecPerKm <= 300; } },
    { id: 'weekly-goal', icon: '🎯', name: '주간 목표 달성', desc: '주간 목표 거리 채우기',
      test: function (c) { return c.weeklyGoalKm > 0 && c.weekKm >= c.weeklyGoalKm; } },
    { id: 'coach-first', icon: '🎧', name: '코치와 함께',   desc: '가이드 세션 첫 완료',
      test: function (c) { return !!c.sessionCompleted; } },
    { id: 'coach-done',  icon: '🏆', name: '30분의 기적',   desc: '30분 달리기 도전 완주',
      test: function (c) { return !!c.programFinished; } }
  ];

  /** 이번 러닝으로 새로 획득한 배지 반환 (earned: {id:ts}) */
  function evaluate(ctx, earned) {
    var fresh = [];
    BADGES.forEach(function (b) {
      if (earned[b.id]) return;
      var ok = false;
      try { ok = !!b.test(ctx); } catch (e) { ok = false; }
      if (ok) fresh.push(b);
    });
    return fresh;
  }

  global.Achieve = {
    LEVELS: LEVELS,
    BADGES: BADGES,
    levelOf: levelOf,
    streak: streak,
    personalRecords: personalRecords,
    evaluate: evaluate
  };
})(window);
