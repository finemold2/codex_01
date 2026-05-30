/* tracker.js — GPS 추적, 거리/페이스/칼로리 계산 엔진 */
(function (global) {
  'use strict';

  /* 두 좌표(위경도) 사이 거리(m) — Haversine */
  function haversine(a, b) {
    var R = 6371000;
    var dLat = (b.lat - a.lat) * Math.PI / 180;
    var dLon = (b.lng - a.lng) * Math.PI / 180;
    var lat1 = a.lat * Math.PI / 180;
    var lat2 = b.lat * Math.PI / 180;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /**
   * Tracker — 러닝 한 번의 상태를 관리.
   * 콜백:
   *   onTick(state)   매 갱신마다
   *   onStatus(text)  GPS 상태 메시지 (null이면 배너 숨김)
   *   onPoint(latlng) 새 좌표 추가 시 (지도용)
   */
  function Tracker(opts) {
    opts = opts || {};
    this.weightKg = opts.weightKg || 65;
    this.onTick = opts.onTick || function () {};
    this.onStatus = opts.onStatus || function () {};
    this.onPoint = opts.onPoint || function () {};
    this._reset();
  }

  Tracker.prototype._reset = function () {
    this.points = [];        // {lat,lng,t}
    this.distance = 0;       // m
    this.elapsed = 0;        // ms (정지시간 제외)
    this.startedAt = null;
    this.state = 'idle';     // idle | running | paused | stopped
    this._segStart = null;   // 현재 활성 구간 시작 시각
    this._watchId = null;
    this._timer = null;
    this._demo = null;
    this._lastAcc = null;
  };

  Tracker.prototype.isActive = function () {
    return this.state === 'running' || this.state === 'paused';
  };

  Tracker.prototype.start = function (demo) {
    if (this.isActive()) return;
    this._reset();
    this.startedAt = Date.now();
    this.state = 'running';
    this._segStart = Date.now();
    this._startClock();
    if (demo) {
      this._startDemo();
    } else {
      this._startGps();
    }
  };

  Tracker.prototype.pause = function () {
    if (this.state !== 'running') return;
    this.state = 'paused';
    if (this._segStart) { this.elapsed += Date.now() - this._segStart; this._segStart = null; }
    this.onStatus(null);
    this._emit();
  };

  Tracker.prototype.resume = function () {
    if (this.state !== 'paused') return;
    this.state = 'running';
    this._segStart = Date.now();
    this._emit();
  };

  /** 종료 → 완성된 run 객체 반환 (저장은 호출자가 결정) */
  Tracker.prototype.stop = function () {
    if (!this.isActive()) return null;
    if (this.state === 'running' && this._segStart) {
      this.elapsed += Date.now() - this._segStart;
    }
    this.state = 'stopped';
    this._stopGps();
    this._stopDemo();
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this.onStatus(null);

    var s = this.snapshot();
    return {
      startedAt: this.startedAt,
      durationMs: s.elapsed,
      distanceM: s.distance,
      paceSecPerKm: s.pace,
      calories: s.calories,
      path: this.points.map(function (p) { return [p.lat, p.lng]; })
    };
  };

  Tracker.prototype._startClock = function () {
    var self = this;
    this._timer = setInterval(function () {
      if (self.state === 'running') self._emit();
    }, 1000);
  };

  /* ---- 실제 GPS ---- */
  Tracker.prototype._startGps = function () {
    var self = this;
    if (!('geolocation' in navigator)) {
      this.onStatus('이 기기는 GPS를 지원하지 않아요. 데모 모드를 사용하세요.');
      return;
    }
    this.onStatus('GPS 신호를 찾는 중…');
    this._watchId = navigator.geolocation.watchPosition(
      function (pos) { self._onGps(pos); },
      function (err) {
        var msg = err.code === 1
          ? '위치 권한이 거부되었어요. 데모 모드를 사용해보세요.'
          : 'GPS 신호가 약해요…';
        self.onStatus(msg);
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
  };

  Tracker.prototype._onGps = function (pos) {
    var acc = pos.coords.accuracy;
    // 정확도 50m 초과는 노이즈로 보고 무시
    if (acc != null && acc > 50) {
      this.onStatus('GPS 정확도 향상 중… (±' + Math.round(acc) + 'm)');
      return;
    }
    this.onStatus(null);
    this._addPoint({ lat: pos.coords.latitude, lng: pos.coords.longitude, t: Date.now() });
  };

  Tracker.prototype._stopGps = function () {
    if (this._watchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(this._watchId);
      this._watchId = null;
    }
  };

  /* ---- 데모 모드 (GPS 없이 가상 경로 생성) ---- */
  Tracker.prototype._startDemo = function () {
    var self = this;
    this.onStatus('데모 모드 — 가상 러닝 중');
    // 서울 시청 부근에서 시작
    var lat = 37.5665, lng = 126.9780;
    var heading = Math.random() * Math.PI * 2;
    this._addPoint({ lat: lat, lng: lng, t: Date.now() });
    this._demo = setInterval(function () {
      if (self.state !== 'running') return;
      // ~3.3 m/s (약 5분/km) 기준 1초 이동 + 약간의 곡선
      heading += (Math.random() - 0.5) * 0.4;
      var stepM = 3.0 + Math.random() * 1.2;
      lat += (stepM * Math.cos(heading)) / 111111;
      lng += (stepM * Math.sin(heading)) / (111111 * Math.cos(lat * Math.PI / 180));
      self._addPoint({ lat: lat, lng: lng, t: Date.now() });
    }, 1000);
  };

  Tracker.prototype._stopDemo = function () {
    if (this._demo) { clearInterval(this._demo); this._demo = null; }
  };

  /* ---- 좌표 누적 ---- */
  Tracker.prototype._addPoint = function (p) {
    if (this.state !== 'running') return;
    var last = this.points[this.points.length - 1];
    if (last) {
      var d = haversine(last, p);
      if (d < 1) return;          // 1m 미만 떨림 무시
      if (d > 80) return;         // 비현실적 점프 무시
      this.distance += d;
    }
    this.points.push(p);
    this.onPoint([p.lat, p.lng]);
    this._emit();
  };

  /* ---- 현재 상태 스냅샷 ---- */
  Tracker.prototype.snapshot = function () {
    var elapsed = this.elapsed;
    if (this.state === 'running' && this._segStart) {
      elapsed += Date.now() - this._segStart;
    }
    var km = this.distance / 1000;
    var pace = km > 0.02 ? (elapsed / 1000) / km : 0; // 초/km
    var calories = this._calc(km, elapsed);
    return { distance: this.distance, elapsed: elapsed, pace: pace, calories: calories, state: this.state };
  };

  /* MET 기반 칼로리: 페이스에 따라 MET 추정 */
  Tracker.prototype._calc = function (km, elapsedMs) {
    var hours = elapsedMs / 3600000;
    if (hours <= 0) return 0;
    var speedKmh = km / hours;
    var met;
    if (speedKmh < 6) met = 6;
    else if (speedKmh < 8) met = 8.3;
    else if (speedKmh < 9.7) met = 9.8;
    else if (speedKmh < 11.3) met = 11;
    else if (speedKmh < 12.9) met = 11.8;
    else met = 12.8;
    return Math.round(met * this.weightKg * hours);
  };

  Tracker.prototype._emit = function () {
    this.onTick(this.snapshot());
  };

  Tracker.haversine = haversine;
  global.Tracker = Tracker;
})(window);
