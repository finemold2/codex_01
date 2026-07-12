/* programs.js — 런데이식 "30분 달리기 도전" 8주 프로그램 데이터 + 세그먼트 엔진 */
(function (global) {
  'use strict';

  /* 주차별 인터벌 스펙: 워밍업/쿨다운 걷기 5분 + (달리기/걷기)×반복 */
  var WEEKS = [
    { week: 1, run: 60,  walk: 120, reps: 6, note: '1분 달리기부터 가볍게' },
    { week: 2, run: 90,  walk: 120, reps: 5, note: '조금 더 길게, 90초 달리기' },
    { week: 3, run: 120, walk: 120, reps: 5, note: '달리기와 걷기 1:1' },
    { week: 4, run: 180, walk: 120, reps: 4, note: '3분 달리기 도전' },
    { week: 5, run: 300, walk: 150, reps: 3, note: '5분 연속 달리기' },
    { week: 6, run: 480, walk: 120, reps: 2, note: '8분씩 두 번' },
    { week: 7, run: 600, walk: 90,  reps: 2, note: '10분씩 두 번' },
    { week: 8, run: 0,   walk: 0,   reps: 0, note: '드디어 30분 연속 달리기!' }
  ];

  /* 8주차는 세션마다 다르게 (25분 → 28분 → 30분) */
  var WEEK8_RUNS = [1500, 1680, 1800];

  var WARMUP = 300, COOLDOWN = 300;

  function sessionSegments(week, session) {
    var segs = [{ type: 'walk', sec: WARMUP, label: '워밍업' }];
    if (week === 8) {
      segs.push({ type: 'run', sec: WEEK8_RUNS[session - 1] || 1800, label: '달리기' });
    } else {
      var w = WEEKS[week - 1];
      for (var i = 0; i < w.reps; i++) {
        segs.push({ type: 'run', sec: w.run, label: '달리기' });
        if (i < w.reps - 1) segs.push({ type: 'walk', sec: w.walk, label: '걷기' });
      }
    }
    segs.push({ type: 'walk', sec: COOLDOWN, label: '쿨다운' });
    return segs;
  }

  function totalSec(segs) {
    return segs.reduce(function (a, s) { return a + s.sec; }, 0);
  }

  function sessionId(week, session) { return 'w' + week + 's' + session; }

  /**
   * ProgramEngine — 러닝 중 경과시간(ms)으로 현재 세그먼트를 판정.
   * 콜백: onSegment(seg, idx, total), onFinish()
   */
  function ProgramEngine(segments, cbs) {
    this.segments = segments;
    this.total = totalSec(segments);
    this._idx = -1;
    this._done = false;
    this.onSegment = (cbs && cbs.onSegment) || function () {};
    this.onFinish = (cbs && cbs.onFinish) || function () {};
  }

  /** elapsedMs 기준 상태 갱신, 화면용 상태 반환 */
  ProgramEngine.prototype.update = function (elapsedMs) {
    if (this._done) return null;
    var t = elapsedMs / 1000;
    var acc = 0;
    for (var i = 0; i < this.segments.length; i++) {
      var seg = this.segments[i];
      if (t < acc + seg.sec) {
        if (i !== this._idx) {
          this._idx = i;
          this.onSegment(seg, i, this.segments.length);
        }
        return {
          seg: seg,
          idx: i,
          count: this.segments.length,
          remainSec: Math.ceil(acc + seg.sec - t),
          next: this.segments[i + 1] || null,
          progress: Math.min(1, t / this.total)
        };
      }
      acc += seg.sec;
    }
    this._done = true;
    this.onFinish();
    return null;
  };

  global.Program = {
    id: 'run30',
    title: '30분 달리기 도전',
    desc: '8주 × 주 3회, 24번의 트레이닝으로 쉬지 않고 30분 달리기',
    weeks: WEEKS,
    sessionSegments: sessionSegments,
    sessionId: sessionId,
    totalSec: totalSec,
    Engine: ProgramEngine
  };
})(window);
