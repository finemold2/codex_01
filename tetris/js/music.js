/* music.js — Web Audio 칩튠 배경음악 (코로베이니키 / 테트리스 테마 A)
 *
 * 외부 파일 없이 오실레이터로 시퀀싱한다.
 * - 레벨이 오르면 템포가 빨라지고, 위험(스택이 높음) 상태에서는 더 빨라진다.
 * - 일시정지 시 음소거, 게임 오버 시 정지.
 */
(function (global) {
  'use strict';

  var NOTE = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };

  function freq(name) {
    var m = /^([A-G]#?)(\d)$/.exec(name);
    var midi = (parseInt(m[2], 10) + 1) * 12 + NOTE[m[1]];
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  // 멜로디: [음, 박자(4분음표=1)] — null은 쉼표. 16마디 = 64박.
  var LEAD = [
    // A 파트
    ['E5', 1], ['B4', 0.5], ['C5', 0.5], ['D5', 1], ['C5', 0.5], ['B4', 0.5],
    ['A4', 1], ['A4', 0.5], ['C5', 0.5], ['E5', 1], ['D5', 0.5], ['C5', 0.5],
    ['B4', 1.5], ['C5', 0.5], ['D5', 1], ['E5', 1],
    ['C5', 1], ['A4', 1], ['A4', 1], [null, 1],
    [null, 0.5], ['D5', 1], ['F5', 0.5], ['A5', 1], ['G5', 0.5], ['F5', 0.5],
    ['E5', 1.5], ['C5', 0.5], ['E5', 1], ['D5', 0.5], ['C5', 0.5],
    ['B4', 1], ['B4', 0.5], ['C5', 0.5], ['D5', 1], ['E5', 1],
    ['C5', 1], ['A4', 1], ['A4', 1], [null, 1],
    // B 파트
    ['E5', 2], ['C5', 2],
    ['D5', 2], ['B4', 2],
    ['C5', 2], ['A4', 2],
    ['G#4', 2], ['B4', 1], [null, 1],
    ['E5', 2], ['C5', 2],
    ['D5', 2], ['B4', 2],
    ['C5', 1], ['E5', 1], ['A5', 2],
    ['G#5', 2], [null, 2]
  ];

  // 마디별 베이스 근음 (16마디)
  var BASS = ['E', 'A', 'B', 'E', 'A', 'C', 'B', 'E', 'A', 'G', 'F', 'E', 'A', 'G', 'A', 'E'];

  // 8분음표 슬롯 단위로 멜로디 시작 지점을 미리 계산
  var SLOTS = 16 * 8;
  var leadAt = new Array(SLOTS);
  (function () {
    var pos = 0;
    for (var i = 0; i < LEAD.length; i++) {
      var slot = Math.round(pos * 2);
      if (LEAD[i][0]) leadAt[slot] = { f: freq(LEAD[i][0]), slots: LEAD[i][1] * 2 };
      pos += LEAD[i][1];
    }
  })();

  var ctx = null;
  var master = null;
  var enabled = true;
  var playing = false;
  var paused = false;
  var timer = null;
  var slot = 0;
  var nextTime = 0;
  var level = 1;
  var danger = false;

  var LOOKAHEAD = 0.12; // s
  var TICK = 25;        // ms

  function ensure() {
    if (!ctx) {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0;
      // 살짝 로우패스로 날카로움 완화
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 4200;
      master.connect(lp);
      lp.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function bpm() {
    var b = 148 + (Math.min(level, 20) - 1) * 4;
    if (danger) b *= 1.22;
    return Math.min(b, 230);
  }

  function slotDur() {
    return 60 / bpm() / 2;
  }

  function playLead(f, t0, dur) {
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = f;
    var a = 0.055;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(a, t0 + 0.008);
    g.gain.setValueAtTime(a, t0 + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * 0.95);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur);
  }

  function playBass(f, t0, dur) {
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.09, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * 0.9);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur);
  }

  function schedule() {
    if (!playing || !ctx) return;
    while (nextTime < ctx.currentTime + LOOKAHEAD) {
      var d = slotDur();
      var s = slot % SLOTS;
      var lead = leadAt[s];
      if (lead) playLead(lead.f, nextTime, d * lead.slots);
      var root = BASS[Math.floor(s / 8)];
      var oct = (s % 2 === 0) ? 2 : 3;
      playBass(freq(root + oct), nextTime, d);
      nextTime += d;
      slot++;
    }
  }

  function fadeTo(v, sec) {
    if (!master) return;
    var t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(v, t + (sec || 0.15));
  }

  global.Music = {
    setEnabled: function (v) {
      enabled = !!v;
      if (!enabled) this.stop();
    },
    start: function () {
      if (!enabled) return;
      if (!ensure()) return;
      if (playing) { paused = false; fadeTo(1, 0.2); return; }
      playing = true;
      paused = false;
      slot = 0;
      nextTime = ctx.currentTime + 0.05;
      fadeTo(1, 0.3);
      clearInterval(timer);
      timer = setInterval(schedule, TICK);
      schedule();
    },
    stop: function () {
      if (!playing) return;
      playing = false;
      paused = false;
      clearInterval(timer);
      timer = null;
      fadeTo(0, 0.4);
    },
    pause: function () {
      if (!playing || paused) return;
      paused = true;
      fadeTo(0, 0.15);
      if (ctx && ctx.suspend) setTimeout(function () { if (paused && ctx) ctx.suspend(); }, 200);
    },
    resume: function () {
      if (!playing || !paused) return;
      paused = false;
      if (ctx.state === 'suspended') ctx.resume();
      nextTime = Math.max(nextTime, ctx.currentTime + 0.05);
      fadeTo(1, 0.2);
    },
    setLevel: function (l) { level = l; },
    setDanger: function (d) { danger = !!d; },
    isPlaying: function () { return playing; }
  };
})(window);
