/* app.js — UI 조립 및 이벤트 흐름 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var prefs = Store.getPrefs();
  var mapView, summaryMap, tracker;
  var pendingRun = null; // 종료 후 저장 대기 중인 run

  /* ---------- 뷰 전환 ---------- */
  function switchView(name) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('is-active'); });
    $('view-' + name).classList.add('is-active');
    document.querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('is-active', t.dataset.view === name);
    });
    if (name === 'run' && mapView) mapView.invalidate();
    if (name === 'history') renderHistory();
    if (name === 'stats') renderStats();
  }

  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () { switchView(t.dataset.view); });
  });

  /* ---------- 실시간 통계 렌더 ---------- */
  function renderLive(s) {
    $('mDistance').textContent = Fmt.distance(s.distance, prefs.unit);
    $('mTime').textContent = Fmt.duration(s.elapsed);
    $('mPace').textContent = Fmt.pace(adjPace(s.pace));
    $('mCal').textContent = s.calories;
  }

  // 마일 단위면 페이스도 마일 기준으로 환산
  function adjPace(secPerKm) {
    if (!secPerKm) return 0;
    return prefs.unit === 'mi' ? secPerKm * 1.609344 : secPerKm;
  }

  function setGpsBanner(text) {
    var b = $('gpsBanner');
    if (text) { $('gpsBannerText').textContent = text; b.hidden = false; }
    else { b.hidden = true; }
  }

  /* ---------- 컨트롤 버튼 상태 ---------- */
  function setControls(state) {
    var map = {
      idle:    { start: true,  pause: false, resume: false, stop: false, demo: true },
      running: { start: false, pause: true,  resume: false, stop: true,  demo: false },
      paused:  { start: false, pause: false, resume: true,  stop: true,  demo: false }
    };
    var c = map[state] || map.idle;
    $('btnStart').hidden = !c.start;
    $('btnPause').hidden = !c.pause;
    $('btnResume').hidden = !c.resume;
    $('btnStop').hidden = !c.stop;
    $('btnDemo').style.visibility = c.demo ? 'visible' : 'hidden';
  }

  /* ---------- Tracker 초기화 ---------- */
  function makeTracker() {
    return new Tracker({
      weightKg: prefs.weightKg,
      onTick: renderLive,
      onStatus: setGpsBanner,
      onPoint: function (latlng) { mapView.addPoint(latlng); }
    });
  }

  function beginRun(demo) {
    mapView.reset();
    tracker = makeTracker();
    tracker.start(demo);
    setControls('running');
    renderLive(tracker.snapshot());
  }

  $('btnStart').addEventListener('click', function () { beginRun(false); });
  $('btnDemo').addEventListener('click', function () { beginRun(true); });
  $('btnPause').addEventListener('click', function () { tracker.pause(); setControls('paused'); });
  $('btnResume').addEventListener('click', function () { tracker.resume(); setControls('running'); });
  $('btnStop').addEventListener('click', function () { finishRun(); });

  function finishRun() {
    var run = tracker.stop();
    setControls('idle');
    setGpsBanner(null);
    if (!run || run.distanceM < 5) {
      // 의미 없는 러닝은 버림
      renderLive({ distance: 0, elapsed: 0, pace: 0, calories: 0 });
      mapView.reset();
      return;
    }
    pendingRun = run;
    openSummary(run);
  }

  /* ---------- 요약 모달 ---------- */
  function openSummary(run) {
    $('sumDistance').textContent = Fmt.distance(run.distanceM, prefs.unit);
    $('sumTime').textContent = Fmt.duration(run.durationMs);
    $('sumPace').textContent = Fmt.pace(adjPace(run.paceSecPerKm));
    $('sumCal').textContent = run.calories;
    $('summaryModal').hidden = false;
    if (!summaryMap) summaryMap = new MapView('summaryMap');
    summaryMap.showPath(run.path);
  }

  function closeSummary() { $('summaryModal').hidden = true; }

  $('sumSave').addEventListener('click', function () {
    if (pendingRun) { Store.addRun(pendingRun); pendingRun = null; }
    closeSummary();
    renderLive({ distance: 0, elapsed: 0, pace: 0, calories: 0 });
    mapView.reset();
    switchView('history');
  });

  $('sumDiscard').addEventListener('click', function () {
    pendingRun = null;
    closeSummary();
    renderLive({ distance: 0, elapsed: 0, pace: 0, calories: 0 });
    mapView.reset();
  });

  /* ---------- 기록 ---------- */
  function renderHistory() {
    var runs = Store.getRuns();
    var list = $('historyList');
    list.innerHTML = '';
    $('historyEmpty').hidden = runs.length > 0;

    runs.forEach(function (r) {
      var card = document.createElement('div');
      card.className = 'history-card';
      card.innerHTML =
        '<div class="history-thumb">🏃</div>' +
        '<div class="history-main">' +
          '<div class="history-date">' + Fmt.dateLabel(r.startedAt) + '</div>' +
          '<div class="history-dist">' + Fmt.distance(r.distanceM, prefs.unit) +
            ' <small>' + (prefs.unit === 'mi' ? 'mi' : 'km') + '</small></div>' +
          '<div class="history-sub">' + Fmt.duration(r.durationMs) + ' · ' +
            Fmt.pace(adjPace(r.paceSecPerKm)) + ' /' + (prefs.unit === 'mi' ? 'mi' : 'km') +
            ' · ' + r.calories + ' kcal</div>' +
        '</div>' +
        '<button class="history-del" aria-label="삭제">✕</button>';

      card.querySelector('.history-del').addEventListener('click', function (e) {
        e.stopPropagation();
        if (confirm('이 러닝 기록을 삭제할까요?')) { Store.deleteRun(r.id); renderHistory(); }
      });
      list.appendChild(card);
    });
  }

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
    $('sBestPace').textContent = Fmt.pace(adjPace(sum.bestPace));

    // 주간 막대 그래프
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

    // 목표
    var weekKm = Stats.weekKm(runs);
    var target = prefs.weeklyGoalKm || 20;
    $('goalCurrent').textContent = weekKm.toFixed(1);
    $('goalTarget').textContent = target;
    $('goalFill').style.width = Math.min(100, (weekKm / target) * 100) + '%';
  }

  /* ---------- 단위 토글 ---------- */
  function syncUnitButton() {
    $('unitToggle').textContent = prefs.unit;
    $('mDistanceUnit').textContent = Fmt.distanceUnitLabel(prefs.unit);
  }
  $('unitToggle').addEventListener('click', function () {
    prefs = Store.setPrefs({ unit: prefs.unit === 'km' ? 'mi' : 'km' });
    syncUnitButton();
    if (tracker) renderLive(tracker.snapshot());
    var active = document.querySelector('.tab.is-active');
    if (active) switchView(active.dataset.view);
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
    syncUnitButton();
    renderLive({ distance: 0, elapsed: 0, pace: 0, calories: 0 });

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
