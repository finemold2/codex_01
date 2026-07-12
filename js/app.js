/* app.js — UI 조립 및 이벤트 흐름 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var prefs = Store.getPrefs();
  var mapView, summaryMap, detailMap, tracker;
  var pendingRun = null;      // 종료 후 저장 대기 중인 run
  var pendingBadges = [];     // 이번 러닝으로 획득한 배지 (저장 시 확정)

  /* 러닝 유형 상태 */
  var runType = 'free';       // free | distance | time
  var DIST_GOALS = [1, 3, 5, 10, 21.1];
  var TIME_GOALS = [10, 20, 30, 45, 60];
  var distIdx = 2, timeIdx = 2;

  /* 가이드 세션 상태 */
  var activeSession = null;   // {week, session, id, segments}
  var programEngine = null;
  var goalAnnounced = { half: false, done: false };

  Coach.enabled = prefs.voice !== false;

  /* ---------- 뷰 전환 ---------- */
  function switchView(name) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('is-active'); });
    $('view-' + name).classList.add('is-active');
    document.querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('is-active', t.dataset.view === name);
    });
    if (name === 'run' && mapView) mapView.invalidate();
    if (name === 'coach') renderCoach();
    if (name === 'history') renderHistory();
    if (name === 'stats') renderStats();
    if (name === 'profile') renderProfile();
  }

  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () { switchView(t.dataset.view); });
  });

  /* ---------- 단위 ---------- */
  function adjPace(secPerKm) {
    if (!secPerKm) return 0;
    return prefs.unit === 'mi' ? secPerKm * 1.609344 : secPerKm;
  }
  function unitShort() { return prefs.unit === 'mi' ? 'mi' : 'km'; }

  /* ---------- 실시간 렌더 ---------- */
  function renderLive(s) {
    $('mDistance').textContent = Fmt.distance(s.distance, prefs.unit);
    $('mTime').textContent = Fmt.duration(s.elapsed);
    $('mPace').textContent = Fmt.pace(adjPace(s.pace));
    $('mCal').textContent = s.calories;
    updateGoalLive(s);
    updateProgram(s);
  }

  function resetLive() {
    renderLive({ distance: 0, elapsed: 0, pace: 0, calories: 0 });
    $('goalLive').hidden = true;
    $('segBanner').hidden = true;
  }

  function setGpsBanner(text) {
    var b = $('gpsBanner');
    if (text) { $('gpsBannerText').textContent = text; b.hidden = false; }
    else { b.hidden = true; }
  }

  /* ---------- 러닝 유형 선택 ---------- */
  function goalValue() {
    if (runType === 'distance') return DIST_GOALS[distIdx];
    if (runType === 'time') return TIME_GOALS[timeIdx];
    return null;
  }

  function renderTypeBar() {
    document.querySelectorAll('.type-chip[data-type]').forEach(function (c) {
      c.classList.toggle('is-active', c.dataset.type === runType);
    });
    var chip = $('goalValueChip');
    if (runType === 'distance') { chip.hidden = false; chip.textContent = DIST_GOALS[distIdx] + 'K'; }
    else if (runType === 'time') { chip.hidden = false; chip.textContent = TIME_GOALS[timeIdx] + '분'; }
    else chip.hidden = true;
  }

  document.querySelectorAll('.type-chip[data-type]').forEach(function (c) {
    c.addEventListener('click', function () { runType = c.dataset.type; renderTypeBar(); });
  });
  $('goalValueChip').addEventListener('click', function () {
    if (runType === 'distance') distIdx = (distIdx + 1) % DIST_GOALS.length;
    else if (runType === 'time') timeIdx = (timeIdx + 1) % TIME_GOALS.length;
    renderTypeBar();
  });

  /* ---------- 목표 진행 (러닝 중) ---------- */
  function updateGoalLive(s) {
    if (!tracker || !tracker.isActive() || runType === 'free' || activeSession) return;
    var box = $('goalLive');
    box.hidden = false;
    var ratio = 0, label = '';
    if (runType === 'distance') {
      var targetM = DIST_GOALS[distIdx] * 1000;
      ratio = s.distance / targetM;
      label = '목표 ' + DIST_GOALS[distIdx] + ' km';
    } else {
      var targetMs = TIME_GOALS[timeIdx] * 60000;
      ratio = s.elapsed / targetMs;
      label = '목표 ' + TIME_GOALS[timeIdx] + '분';
    }
    $('goalLiveFill').style.width = Math.min(100, ratio * 100) + '%';
    $('goalLiveText').textContent = label + ' · ' + Math.min(100, Math.round(ratio * 100)) + '%';
    if (!goalAnnounced.half && ratio >= 0.5 && ratio < 1) { goalAnnounced.half = true; Coach.goalHalf(); }
    if (!goalAnnounced.done && ratio >= 1) { goalAnnounced.done = true; Coach.goalDone(); }
  }

  /* ---------- 가이드 세션 (러닝 중) ---------- */
  function updateProgram(s) {
    if (!programEngine || !tracker || !tracker.isActive()) return;
    var st = programEngine.update(s.elapsed);
    if (!st) return; // 완료 콜백에서 처리
    $('segBanner').hidden = false;
    var typeEl = $('segType');
    typeEl.textContent = st.seg.label;
    typeEl.className = 'seg-type ' + (st.seg.type === 'run' ? 'is-run' : 'is-walk');
    $('segRemain').textContent = Fmt.clock(st.remainSec);
    $('segFill').style.width = (st.progress * 100) + '%';
    $('segNext').textContent = st.next
      ? '다음: ' + st.next.label + ' ' + Fmt.clock(st.next.sec) + ' · ' + (st.idx + 1) + '/' + st.count
      : '마지막 구간이에요!';
  }

  /* ---------- 컨트롤 ---------- */
  function setControls(state) {
    var map = {
      idle:    { start: true,  pause: false, resume: false, stop: false, demo: true,  type: true },
      running: { start: false, pause: true,  resume: false, stop: true,  demo: false, type: false },
      paused:  { start: false, pause: false, resume: true,  stop: true,  demo: false, type: false }
    };
    var c = map[state] || map.idle;
    $('btnStart').hidden = !c.start;
    $('btnPause').hidden = !c.pause;
    $('btnResume').hidden = !c.resume;
    $('btnStop').hidden = !c.stop;
    $('btnDemo').style.visibility = c.demo ? 'visible' : 'hidden';
    $('typeBar').hidden = !c.type;
  }

  function makeTracker() {
    return new Tracker({
      weightKg: prefs.weightKg,
      autoPause: prefs.autoPause !== false,
      onTick: renderLive,
      onStatus: setGpsBanner,
      onPoint: function (latlng) { mapView.addPoint(latlng); },
      onSplit: function (split) {
        Coach.split(split.km, Fmt.paceSpoken(split.ms / 1000));
      },
      onAutoPause: function () { Coach.runAutoPause(); setControls('paused'); },
      onAutoResume: function () { Coach.runResume(); setControls('running'); }
    });
  }

  /* ---------- 카운트다운 → 시작 ---------- */
  function countdownThenStart(demo) {
    Coach.init();
    var overlay = $('countdownOverlay');
    var numEl = $('countdownNum');
    var n = 3;
    overlay.hidden = false;
    numEl.textContent = n;
    Coach.countTick(n);
    var iv = setInterval(function () {
      n--;
      if (n > 0) {
        numEl.textContent = n;
        Coach.countTick(n);
      } else {
        clearInterval(iv);
        numEl.textContent = 'GO!';
        Coach.countTick(0);
        setTimeout(function () {
          overlay.hidden = true;
          beginRun(demo);
        }, 500);
      }
    }, 1000);
  }

  function beginRun(demo) {
    mapView.reset();
    goalAnnounced = { half: false, done: false };
    tracker = makeTracker();
    tracker.start(demo);
    setControls('running');
    renderLive(tracker.snapshot());
    if (activeSession) {
      programEngine = new Program.Engine(activeSession.segments, {
        onSegment: function (seg) { Coach.segment(seg); },
        onFinish: onSessionFinish
      });
      updateProgram(tracker.snapshot());
    } else {
      Coach.runStart();
    }
  }

  function onSessionFinish() {
    Coach.sessionDone();
    Store.completeSession(activeSession.id);
    finishRun(true);
  }

  $('btnStart').addEventListener('click', function () { activeSession = null; countdownThenStart(false); });
  $('btnDemo').addEventListener('click', function () { activeSession = null; countdownThenStart(true); });
  $('btnPause').addEventListener('click', function () { Coach.runPause(); tracker.pause(); setControls('paused'); });
  $('btnResume').addEventListener('click', function () { Coach.runResume(); tracker.resume(); setControls('running'); });
  $('btnStop').addEventListener('click', function () { finishRun(false); });

  function finishRun(sessionDone) {
    var run = tracker.stop();
    setControls('idle');
    setGpsBanner(null);
    programEngine = null;
    $('segBanner').hidden = true;
    $('goalLive').hidden = true;

    if (!run || run.distanceM < 5) {
      activeSession = null;
      resetLive();
      mapView.reset();
      return;
    }
    if (!sessionDone) Coach.runFinish();

    /* 러닝 메타 붙이기 */
    if (activeSession) {
      run.type = 'coach';
      run.sessionId = activeSession.id;
      run.title = Program.title + ' · ' + activeSession.week + '주차 ' + activeSession.session + '회';
    } else if (runType === 'distance') {
      run.type = 'distance'; run.goal = DIST_GOALS[distIdx];
    } else if (runType === 'time') {
      run.type = 'time'; run.goal = TIME_GOALS[timeIdx];
    } else {
      run.type = 'free';
    }

    /* 업적 판정 (저장 가정으로 미리 계산) */
    pendingBadges = evaluateBadges(run, !!sessionDone);
    pendingRun = run;
    activeSession = null;
    openSummary(run, pendingBadges);
  }

  /* ---------- 업적 판정 ---------- */
  function evaluateBadges(run, sessionCompleted) {
    var runs = Store.getRuns().concat([run]);
    var totalKm = runs.reduce(function (a, r) { return a + (r.distanceM || 0) / 1000; }, 0);
    var progress = Store.getProgram();
    var doneCount = Object.keys(progress).length;
    var ctx = {
      run: run,
      runs: runs,
      totalKm: totalKm,
      streak: Achieve.streak(runs),
      hour: new Date(run.startedAt).getHours(),
      sessionCompleted: sessionCompleted,
      programFinished: doneCount >= 24,
      weekKm: Stats.weekKm(runs),
      weeklyGoalKm: prefs.weeklyGoalKm
    };
    return Achieve.evaluate(ctx, Store.getBadges());
  }

  /* ---------- 요약 모달 ---------- */
  function renderSplits(el, splits) {
    if (!splits || !splits.length) { el.hidden = true; return; }
    el.hidden = false;
    var best = Math.min.apply(null, splits.map(function (s) { return s.ms; }));
    var worst = Math.max.apply(null, splits.map(function (s) { return s.ms; }));
    var html = '<div class="splits-title">킬로미터 스플릿</div>';
    splits.forEach(function (s) {
      var pct = worst > 0 ? Math.max(25, (best / s.ms) * 100) : 100;
      html += '<div class="split-row">' +
        '<span class="split-km">' + s.km + '</span>' +
        '<span class="split-bar-wrap"><span class="split-bar' + (s.ms === best ? ' is-best' : '') +
          '" style="width:' + pct + '%;display:block"></span></span>' +
        '<span class="split-pace">' + Fmt.pace(s.ms / 1000) + '</span>' +
      '</div>';
    });
    el.innerHTML = html;
  }

  function openSummary(run, badges) {
    $('summaryTitle').textContent = run.type === 'coach' ? '트레이닝 완료! 🎧' : '러닝 완료! 🎉';
    $('sumDistance').textContent = Fmt.distance(run.distanceM, prefs.unit);
    $('sumTime').textContent = Fmt.duration(run.durationMs);
    $('sumPace').textContent = Fmt.pace(adjPace(run.paceSecPerKm));
    $('sumCal').textContent = run.calories;
    renderSplits($('sumSplits'), run.splits);

    var bBox = $('sumBadges');
    if (badges.length) {
      bBox.hidden = false;
      bBox.innerHTML = badges.map(function (b) {
        return '<div class="sum-badge"><span class="sum-badge-icon">' + b.icon + '</span>' +
          '<span><div class="sum-badge-name">새 업적 · ' + b.name + '</div>' +
          '<div class="sum-badge-desc">' + b.desc + '</div></span></div>';
      }).join('');
      if (badges[0]) Coach.badge(badges[0].name);
    } else {
      bBox.hidden = true;
    }

    $('summaryModal').hidden = false;
    if (!summaryMap) summaryMap = new MapView('summaryMap');
    summaryMap.showPath(run.path);
  }

  function closeSummary() { $('summaryModal').hidden = true; }

  $('sumSave').addEventListener('click', function () {
    if (pendingRun) {
      Store.addRun(pendingRun);
      if (pendingBadges.length) {
        Store.earnBadges(pendingBadges.map(function (b) { return b.id; }));
      }
      pendingRun = null; pendingBadges = [];
    }
    closeSummary();
    resetLive();
    mapView.reset();
    switchView('history');
  });

  $('sumDiscard').addEventListener('click', function () {
    pendingRun = null; pendingBadges = [];
    closeSummary();
    resetLive();
    mapView.reset();
  });

  /* ---------- 코치 (프로그램) ---------- */
  function nextSessionId(progress) {
    for (var w = 1; w <= 8; w++) {
      for (var s = 1; s <= 3; s++) {
        var id = Program.sessionId(w, s);
        if (!progress[id]) return id;
      }
    }
    return null;
  }

  function renderCoach() {
    var progress = Store.getProgram();
    var done = Object.keys(progress).length;
    $('programTitle').textContent = Program.title;
    $('programDesc').textContent = Program.desc;
    $('programFill').style.width = (done / 24 * 100) + '%';
    $('programProgress').textContent = done + ' / 24 세션 완료' + (done >= 24 ? ' · 완주! 🏆' : '');

    var next = nextSessionId(progress);
    var list = $('weekList');
    list.innerHTML = '';
    Program.weeks.forEach(function (w) {
      var card = document.createElement('div');
      card.className = 'week-card';
      var chips = '';
      for (var s = 1; s <= 3; s++) {
        var id = Program.sessionId(w.week, s);
        var cls = progress[id] ? ' is-done' : (id === next ? ' is-next' : '');
        var mark = progress[id] ? '✓ ' : '';
        chips += '<button class="session-chip' + cls + '" data-id="' + id + '" data-week="' + w.week +
          '" data-session="' + s + '">' + mark + s + '회</button>';
      }
      card.innerHTML =
        '<div class="week-head"><span class="week-title">' + w.week + '주차</span>' +
        '<span class="week-note">' + w.note + '</span></div>' +
        '<div class="week-sessions">' + chips + '</div>';
      list.appendChild(card);
    });

    list.querySelectorAll('.session-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        openSessionSheet(parseInt(chip.dataset.week, 10), parseInt(chip.dataset.session, 10));
      });
    });
  }

  /* 세션 시작 시트 */
  var sheetSession = null;
  function openSessionSheet(week, session) {
    var segs = Program.sessionSegments(week, session);
    sheetSession = { week: week, session: session, id: Program.sessionId(week, session), segments: segs };
    $('sessionTitle').textContent = week + '주차 · ' + session + '회';
    var total = Program.totalSec(segs);
    var runSec = segs.reduce(function (a, s) { return a + (s.type === 'run' ? s.sec : 0); }, 0);
    $('sessionDesc').textContent = '총 ' + Math.round(total / 60) + '분 · 달리기 ' + Math.round(runSec / 60) +
      '분 · 음성 코치가 구간마다 안내해드려요.';
    $('sessionSegs').innerHTML = segs.map(function (s) {
      return '<span class="session-seg' + (s.type === 'run' ? ' is-run' : '') + '">' +
        s.label + ' ' + Fmt.clock(s.sec) + '</span>';
    }).join('');
    $('sessionModal').hidden = false;
  }

  $('sessionCancel').addEventListener('click', function () { $('sessionModal').hidden = true; });
  $('sessionStart').addEventListener('click', function () { startSession(false); });
  $('sessionDemo').addEventListener('click', function () { startSession(true); });

  function startSession(demo) {
    activeSession = sheetSession;
    $('sessionModal').hidden = true;
    switchView('run');
    countdownThenStart(demo);
  }

  /* ---------- 기록 ---------- */
  var TYPE_ICON = { free: '🏃', distance: '🎯', time: '⏱️', coach: '🎧' };

  function renderHistory() {
    var runs = Store.getRuns();
    var list = $('historyList');
    list.innerHTML = '';
    $('historyEmpty').hidden = runs.length > 0;

    runs.forEach(function (r) {
      var card = document.createElement('div');
      card.className = 'history-card';
      var sub = Fmt.duration(r.durationMs) + ' · ' + Fmt.pace(adjPace(r.paceSecPerKm)) +
        ' /' + unitShort() + ' · ' + r.calories + ' kcal';
      card.innerHTML =
        '<div class="history-thumb">' + (TYPE_ICON[r.type] || '🏃') + '</div>' +
        '<div class="history-main">' +
          '<div class="history-date">' + (r.title ? r.title + ' · ' : '') + Fmt.dateLabel(r.startedAt) + '</div>' +
          '<div class="history-dist">' + Fmt.distance(r.distanceM, prefs.unit) +
            ' <small>' + unitShort() + '</small></div>' +
          '<div class="history-sub">' + sub + '</div>' +
        '</div>' +
        '<button class="history-del" aria-label="삭제">✕</button>';

      card.querySelector('.history-del').addEventListener('click', function (e) {
        e.stopPropagation();
        if (confirm('이 러닝 기록을 삭제할까요?')) { Store.deleteRun(r.id); renderHistory(); }
      });
      card.addEventListener('click', function () { openDetail(r); });
      list.appendChild(card);
    });
  }

  /* ---------- 러닝 상세 ---------- */
  function openDetail(r) {
    $('detailDate').textContent = (r.title ? r.title + ' · ' : '') + Fmt.dateLabel(r.startedAt);
    $('detDistance').textContent = Fmt.distance(r.distanceM, prefs.unit);
    $('detTime').textContent = Fmt.duration(r.durationMs);
    $('detPace').textContent = Fmt.pace(adjPace(r.paceSecPerKm));
    $('detCal').textContent = r.calories;
    renderSplits($('detSplits'), r.splits);
    $('detailModal').hidden = false;
    if (!detailMap) detailMap = new MapView('detailMap');
    detailMap.showPath(r.path);
  }
  $('detailClose').addEventListener('click', function () { $('detailModal').hidden = true; });

  /* ---------- 통계 ---------- */
  function renderStats() {
    var runs = Store.getRuns();
    var sum = Stats.summary(runs);

    $('sTotalDistance').textContent = (sum.totalM / 1000).toFixed(1);
    $('sTotalRuns').textContent = sum.count;
    var mins = Math.round(sum.totalMs / 60000);
    $('sTotalTime').textContent = mins >= 60
      ? Math.floor(mins / 60) + '시간 ' + (mins % 60) + '분'
      : mins + '분';
    $('sStreak').textContent = Achieve.streak(runs) + '일';

    var week = Stats.last7Days(runs);
    var maxKm = Math.max.apply(null, week.map(function (d) { return d.km; }).concat([1]));
    var chart = $('weeklyChart');
    chart.innerHTML = '';
    week.forEach(function (d) {
      var col = document.createElement('div');
      col.className = 'bar-col';
      var hPct = Math.max(2, (d.km / maxKm) * 100);
      col.innerHTML =
        '<div class="bar' + (d.km === 0 ? ' bar--empty' : '') + '" style="height:' + hPct + '%" ' +
          'title="' + d.km.toFixed(2) + ' km"></div>' +
        '<div class="bar-label">' + d.label + '</div>';
      chart.appendChild(col);
    });

    var weekKm = Stats.weekKm(runs);
    var target = prefs.weeklyGoalKm || 20;
    $('goalCurrent').textContent = weekKm.toFixed(1);
    $('goalTarget').textContent = target;
    $('goalFill').style.width = Math.min(100, (weekKm / target) * 100) + '%';

    /* 월간 챌린지 (주간목표 × 4) */
    var monthTarget = target * 4;
    var monthKm = Stats.monthKm(runs);
    var now = new Date();
    $('challengeName').textContent = (now.getMonth() + 1) + '월 ' + monthTarget + 'K 챌린지';
    $('challengeCurrent').textContent = monthKm.toFixed(1);
    $('challengeTarget').textContent = monthTarget;
    $('challengeFill').style.width = Math.min(100, (monthKm / monthTarget) * 100) + '%';
  }

  /* ---------- 프로필 ---------- */
  function renderProfile() {
    var runs = Store.getRuns();
    var totalKm = runs.reduce(function (a, r) { return a + (r.distanceM || 0) / 1000; }, 0);

    /* 레벨 */
    var lv = Achieve.levelOf(totalKm);
    $('levelName').textContent = lv.level.name + ' 레벨';
    $('levelRing').style.borderColor = lv.level.color;
    $('levelRing').style.boxShadow = '0 0 24px ' + lv.level.color + '44';
    $('levelFill').style.width = (lv.progress * 100) + '%';
    $('levelFill').style.background = lv.level.color;
    $('levelSub').textContent = lv.next
      ? '총 ' + totalKm.toFixed(1) + ' km · ' + lv.next.name + ' 레벨까지 ' + (lv.next.km - totalKm).toFixed(1) + ' km'
      : '총 ' + totalKm.toFixed(1) + ' km · 최고 레벨 달성!';

    /* PR */
    var pr = Achieve.personalRecords(runs);
    $('prLongest').textContent = pr.longestM ? Fmt.distance(pr.longestM, prefs.unit) + ' ' + unitShort() : '-';
    $('prPace').textContent = pr.bestPace ? Fmt.pace(adjPace(pr.bestPace)) : '-';
    $('prDuration').textContent = pr.longestMs ? Fmt.duration(pr.longestMs) : '-';

    /* 업적 그리드 */
    var earned = Store.getBadges();
    $('badgeGrid').innerHTML = Achieve.BADGES.map(function (b) {
      return '<div class="badge' + (earned[b.id] ? ' is-earned' : '') + '" title="' + b.desc + '">' +
        '<div class="badge-icon">' + b.icon + '</div>' +
        '<div class="badge-name">' + b.name + '</div></div>';
    }).join('');

    /* 설정 값 반영 */
    $('setVoice').checked = prefs.voice !== false;
    $('setAutoPause').checked = prefs.autoPause !== false;
    $('setWeight').value = prefs.weightKg;
    $('setWeeklyGoal').value = prefs.weeklyGoalKm;
    $('unitToggle').textContent = prefs.unit;
  }

  /* ---------- 설정 ---------- */
  $('setVoice').addEventListener('change', function () {
    prefs = Store.setPrefs({ voice: this.checked });
    Coach.enabled = this.checked;
    syncVoiceButton();
  });
  $('setAutoPause').addEventListener('change', function () {
    prefs = Store.setPrefs({ autoPause: this.checked });
    if (tracker) tracker.autoPause = this.checked;
  });
  $('setWeight').addEventListener('change', function () {
    var v = Math.max(30, Math.min(200, parseInt(this.value, 10) || 65));
    this.value = v;
    prefs = Store.setPrefs({ weightKg: v });
    if (tracker) tracker.weightKg = v;
  });
  $('setWeeklyGoal').addEventListener('change', function () {
    var v = Math.max(1, Math.min(200, parseInt(this.value, 10) || 20));
    this.value = v;
    prefs = Store.setPrefs({ weeklyGoalKm: v });
  });
  $('unitToggle').addEventListener('click', function () {
    prefs = Store.setPrefs({ unit: prefs.unit === 'km' ? 'mi' : 'km' });
    $('unitToggle').textContent = prefs.unit;
    $('mDistanceUnit').textContent = Fmt.distanceUnitLabel(prefs.unit);
    if (tracker) renderLive(tracker.snapshot());
  });

  /* 헤더 음성 토글 */
  function syncVoiceButton() {
    $('voiceToggle').style.opacity = Coach.enabled ? '1' : '0.35';
  }
  $('voiceToggle').addEventListener('click', function () {
    prefs = Store.setPrefs({ voice: !Coach.enabled });
    Coach.enabled = prefs.voice;
    if (!Coach.enabled) Coach.stopSpeaking();
    syncVoiceButton();
  });

  /* ---------- 페이지 이탈 보호 ---------- */
  window.addEventListener('beforeunload', function (e) {
    if (tracker && tracker.isActive()) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ---------- 부트스트랩 ---------- */
  function init() {
    mapView = new MapView('map');
    mapView.invalidate();
    setControls('idle');
    renderTypeBar();
    syncVoiceButton();
    $('mDistanceUnit').textContent = Fmt.distanceUnitLabel(prefs.unit);
    resetLive();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
