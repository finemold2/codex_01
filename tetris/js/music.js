/* music.js — Web Audio 클래식 배경음악 (피아노·현악 음색 합성 + 리버브)
 *
 * 외부 음원 파일 없이 브라우저에서 실시간 합성한다.
 * 플레이리스트(모두 퍼블릭 도메인):
 *   1. 코로베이니키 (러시아 민요, 테트리스 테마)
 *   2. 바흐 — 프렐류드 C장조 BWV 846
 *   3. 베토벤 — 엘리제를 위하여
 *   4. 미뉴에트 G장조 (안나 막달레나 바흐 음악 노트)
 *
 * 템포는 레벨·위험·피버 상태에 따라 조금씩 빨라진다.
 */
(function (global) {
  'use strict';

  var NOTE = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

  function midi(name) {
    var m = /^([A-G][#b]?)(\d)$/.exec(name);
    return (parseInt(m[2], 10) + 1) * 12 + NOTE[m[1]];
  }
  function freqOfMidi(n) { return 440 * Math.pow(2, (n - 69) / 12); }
  function freq(name) { return freqOfMidi(midi(name)); }

  // "E5:1 B4:.5 R:1 E3+G3+B3:4" → [{notes:[...], beats}]  (기본 길이 0.25박)
  function parse(str) {
    var out = [];
    var toks = str.trim().split(/\s+/);
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (!t) continue;
      var parts = t.split(':');
      var beats = parts.length > 1 ? parseFloat(parts[1]) : 0.25;
      var notes = parts[0] === 'R' ? [] : parts[0].split('+');
      out.push({ notes: notes, beats: beats });
    }
    return out;
  }

  // 근음 이름 + 옥타브로 "근음, 5도" 붙박이 베이스 패턴 생성 (마디당 4박)
  function oompah(roots, oct) {
    var s = [];
    for (var i = 0; i < roots.length; i++) {
      var r = midi(roots[i] + oct);
      var f = r + 7;
      s.push({ notes: [r], beats: 1 }, { notes: [f], beats: 1 }, { notes: [r], beats: 1 }, { notes: [f], beats: 1 });
    }
    return s;
  }

  // ---------- 트랙 ----------
  var TRACKS = [];

  // 1. 코로베이니키
  (function () {
    var lead = parse(
      'E5:1 B4:.5 C5:.5 D5:1 C5:.5 B4:.5 ' +
      'A4:1 A4:.5 C5:.5 E5:1 D5:.5 C5:.5 ' +
      'B4:1.5 C5:.5 D5:1 E5:1 ' +
      'C5:1 A4:1 A4:1 R:1 ' +
      'R:.5 D5:1 F5:.5 A5:1 G5:.5 F5:.5 ' +
      'E5:1.5 C5:.5 E5:1 D5:.5 C5:.5 ' +
      'B4:1 B4:.5 C5:.5 D5:1 E5:1 ' +
      'C5:1 A4:1 A4:1 R:1 ' +
      'E5:2 C5:2 D5:2 B4:2 C5:2 A4:2 G#4:2 B4:1 R:1 ' +
      'E5:2 C5:2 D5:2 B4:2 C5:1 E5:1 A5:2 G#5:2 R:2'
    );
    var chords = [
      'E3+G3+B3', 'A3+C4+E4', 'B3+D#4+F#4', 'E3+G3+B3', 'A3+C4+E4', 'C4+E4+G4', 'B3+D#4+F#4', 'A3+C4+E4',
      'A3+C4+E4', 'G3+B3+D4', 'F3+A3+C4', 'E3+G#3+B3', 'A3+C4+E4', 'G3+B3+D4', 'A3+C4+E4', 'E3+G#3+B3'
    ];
    var pad = [];
    for (var i = 0; i < chords.length; i++) pad.push({ notes: chords[i].split('+'), beats: 4 });
    var bass = oompah(['E', 'A', 'B', 'E', 'A', 'C', 'B', 'A', 'A', 'G', 'F', 'E', 'A', 'G', 'A', 'E'], 2);
    TRACKS.push({
      name: '코로베이니키 (테트리스 테마)',
      bpm: 132,
      parts: [
        { voice: 'piano', vel: 1.0, seq: lead },
        { voice: 'strings', vel: 0.55, seq: pad },
        { voice: 'bass', vel: 0.8, seq: bass }
      ]
    });
  })();

  // 2. 바흐 — 프렐류드 C장조 (마디마다 5음 패턴 ×2)
  (function () {
    var bars = [
      'C4 E4 G4 C5 E5', 'C4 D4 A4 D5 F5', 'B3 D4 G4 D5 F5', 'C4 E4 G4 C5 E5',
      'C4 E4 A4 E5 A5', 'C4 D4 F#4 A4 D5', 'B3 D4 G4 D5 G5', 'B3 C4 E4 G4 C5',
      'A3 C4 E4 G4 C5', 'D3 A3 D4 F#4 C5', 'G3 B3 D4 G4 B4', 'G3 Bb3 E4 G4 C#5',
      'F3 A3 D4 A4 D5', 'F3 Ab3 D4 F4 B4', 'E3 G3 C4 G4 C5', 'E3 F3 A3 C4 F4',
      'D3 F3 A3 C4 F4', 'G2 D3 G3 B3 F4', 'C3 E3 G3 C4 E4', 'C3 G3 Bb3 C4 E4',
      'F2 F3 A3 C4 E4', 'F#2 C3 A3 C4 Eb4', 'Ab2 F3 B3 C4 D4', 'G2 F3 G3 B3 D4',
      'G2 E3 G3 C4 E4', 'G2 D3 G3 C4 F4', 'G2 D3 G3 B3 F4', 'G2 Eb3 A3 C4 F#4',
      'G2 E3 G3 C4 G4', 'G2 D3 G3 C4 F4', 'G2 D3 G3 B3 F4', 'C2 C3 G3 Bb3 E4',
      'C2 C3 E3 G3 C4'
    ];
    var upper = [];
    var lower = [];
    for (var i = 0; i < bars.length; i++) {
      var n = bars[i].split(' ');
      for (var rep = 0; rep < 2; rep++) {
        // 상성부: 3,4,5번째 음이 16분음표로 흐름 (1,2번째는 아래 성부가 길게)
        upper.push({ notes: [], beats: 0.5 });
        upper.push({ notes: [n[2]], beats: 0.25 }, { notes: [n[3]], beats: 0.25 }, { notes: [n[4]], beats: 0.25 });
        upper.push({ notes: [n[2]], beats: 0.25 }, { notes: [n[3]], beats: 0.25 }, { notes: [n[4]], beats: 0.25 });
        lower.push({ notes: [n[0]], beats: 0.25 }, { notes: [n[1]], beats: 1.75 });
      }
    }
    TRACKS.push({
      name: '바흐 — 프렐류드 C장조',
      bpm: 68,
      parts: [
        { voice: 'piano', vel: 0.85, seq: upper },
        { voice: 'piano', vel: 0.7, seq: lower }
      ]
    });
  })();

  // 3. 베토벤 — 엘리제를 위하여 (A 파트, 3/8 → 1마디 = 1.5박)
  (function () {
    var lead = parse(
      'E5 D#5 ' +
      'E5 D#5 E5 B4 D5 C5 ' +
      'A4:.5 R C4 E4 A4 ' +
      'B4:.5 R E4 G#4 B4 ' +
      'C5:.5 R E4 E5 D#5 ' +
      'E5 D#5 E5 B4 D5 C5 ' +
      'A4:.5 R C4 E4 A4 ' +
      'B4:.5 R E4 C5 B4 ' +
      'A4:.5 R E5 D#5 ' +
      'E5 D#5 E5 B4 D5 C5 ' +
      'A4:.5 R C4 E4 A4 ' +
      'B4:.5 R E4 G#4 B4 ' +
      'C5:.5 R E4 E5 D#5 ' +
      'E5 D#5 E5 B4 D5 C5 ' +
      'A4:.5 R C4 E4 A4 ' +
      'B4:.5 R E4 C5 B4 ' +
      'A4:.5 R B4 C5 D5 ' +
      'E5:.75 G4 F5 E5 ' +
      'D5:.75 F4 E5 D5 ' +
      'C5:.75 E4 D5 C5 ' +
      'B4:.5 R E4 E5:.5 ' +
      'R E5 E6 D#5 E5 D#5'
    );
    // 왼손: 멜로디 트릴 마디는 쉼, 나머지는 분산화음
    var bass = parse(
      'R:.5 ' +
      'R:1.5 ' +
      'A2:.5 E3:.5 A3:.5 ' +
      'E2:.5 E3:.5 G#3:.5 ' +
      'A2:.5 E3:.5 A3:.5 ' +
      'R:1.5 ' +
      'A2:.5 E3:.5 A3:.5 ' +
      'E2:.5 E3:.5 G#3:.5 ' +
      'A2:.5 E3:.5 R:.5 ' +
      'R:1.5 ' +
      'A2:.5 E3:.5 A3:.5 ' +
      'E2:.5 E3:.5 G#3:.5 ' +
      'A2:.5 E3:.5 A3:.5 ' +
      'R:1.5 ' +
      'A2:.5 E3:.5 A3:.5 ' +
      'E2:.5 E3:.5 G#3:.5 ' +
      'A2:.5 E3:.5 R:.5 ' +
      'C3:.5 G3:.5 C4:.5 ' +
      'G2:.5 G3:.5 B3:.5 ' +
      'A2:.5 E3:.5 A3:.5 ' +
      'E2:.5 E3:.5 R:.5 ' +
      'R:1.5'
    );
    TRACKS.push({
      name: '베토벤 — 엘리제를 위하여',
      bpm: 76,
      parts: [
        { voice: 'piano', vel: 0.95, seq: lead },
        { voice: 'piano', vel: 0.6, seq: bass }
      ]
    });
  })();

  // 4. 미뉴에트 G장조 (3/4)
  (function () {
    var lead = parse(
      'D5:1 G4:.5 A4:.5 B4:.5 C5:.5 ' +
      'D5:1 G4:1 G4:1 ' +
      'E5:1 C5:.5 D5:.5 E5:.5 F#5:.5 ' +
      'G5:1 G4:1 G4:1 ' +
      'C5:1 D5:.5 C5:.5 B4:.5 A4:.5 ' +
      'B4:1 C5:.5 B4:.5 A4:.5 G4:.5 ' +
      'F#4:1 G4:.5 A4:.5 B4:.5 G4:.5 ' +
      'B4:1 A4:2 ' +
      'D5:1 G4:.5 A4:.5 B4:.5 C5:.5 ' +
      'D5:1 G4:1 G4:1 ' +
      'E5:1 C5:.5 D5:.5 E5:.5 F#5:.5 ' +
      'G5:1 G4:1 G4:1 ' +
      'C5:1 D5:.5 C5:.5 B4:.5 A4:.5 ' +
      'B4:1 C5:.5 B4:.5 A4:.5 G4:.5 ' +
      'A4:1 B4:.5 A4:.5 G4:.5 F#4:.5 ' +
      'G4:3'
    );
    var chords = ['G', 'G', 'C', 'G', 'Am', 'G', 'D', 'D', 'G', 'G', 'C', 'G', 'Am', 'G', 'D', 'G'];
    var TRIAD = { G: ['G3', 'B3', 'D4'], C: ['C3', 'E3', 'G3'], Am: ['A3', 'C4', 'E4'], D: ['D3', 'F#3', 'A3'] };
    var bass = [];
    for (var i = 0; i < chords.length; i++) {
      var tri = TRIAD[chords[i]];
      bass.push({ notes: [tri[0]], beats: 1 }, { notes: [tri[1]], beats: 1 }, { notes: [tri[2]], beats: 1 });
    }
    TRACKS.push({
      name: '미뉴에트 G장조',
      bpm: 116,
      parts: [
        { voice: 'piano', vel: 0.95, seq: lead },
        { voice: 'piano', vel: 0.55, seq: bass }
      ]
    });
  })();

  // 각 트랙을 0.25박 슬롯 단위 이벤트 표로 컴파일
  var SLOT = 0.25;
  function compile(track) {
    var slots = {};
    var length = 0;
    for (var p = 0; p < track.parts.length; p++) {
      var part = track.parts[p];
      var pos = 0;
      for (var i = 0; i < part.seq.length; i++) {
        var ev = part.seq[i];
        var s = Math.round(pos / SLOT);
        for (var k = 0; k < ev.notes.length; k++) {
          var n = ev.notes[k];
          var f = typeof n === 'number' ? freqOfMidi(n) : freq(n);
          (slots[s] = slots[s] || []).push({ voice: part.voice, f: f, beats: ev.beats, vel: part.vel });
        }
        pos += ev.beats;
      }
      if (pos > length) length = pos;
    }
    track.slots = slots;
    track.totalSlots = Math.round(length / SLOT);
    return track;
  }
  for (var ti = 0; ti < TRACKS.length; ti++) compile(TRACKS[ti]);

  // ---------- 오디오 그래프 ----------
  var ctx = null;
  var master = null;   // 전체 볼륨 (페이드용)
  var dry = null;
  var wet = null;
  var enabled = true;
  var playing = false;
  var paused = false;
  var timer = null;
  var trackIndex = 0;
  var slot = 0;
  var nextTime = 0;
  var level = 1;
  var danger = false;
  var fever = false;

  var LOOKAHEAD = 0.15;
  var TICK = 30;

  function makeImpulse(seconds, decay) {
    var rate = ctx.sampleRate;
    var len = Math.floor(rate * seconds);
    var buf = ctx.createBuffer(2, len, rate);
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  function ensure() {
    if (!ctx) {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();

      var comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 20;
      comp.ratio.value = 4;
      comp.attack.value = 0.005;
      comp.release.value = 0.25;
      comp.connect(ctx.destination);

      master = ctx.createGain();
      master.gain.value = 0;
      master.connect(comp);

      dry = ctx.createGain();
      dry.gain.value = 0.8;
      dry.connect(master);

      var conv = ctx.createConvolver();
      conv.buffer = makeImpulse(2.4, 3.2);
      wet = ctx.createGain();
      wet.gain.value = 0.38;
      wet.connect(conv);
      conv.connect(master);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function out(node) {
    node.connect(dry);
    node.connect(wet);
  }

  // 피아노: 배음 3개 + 빠른 어택, 지수 감쇠, 짧은 릴리스 (댐퍼)
  function piano(f, t0, dur, vel) {
    var g = ctx.createGain();
    var peak = 0.22 * vel * Math.min(1, 900 / Math.max(f, 300)); // 고음은 살짝 작게
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
    var ringEnd = t0 + dur + 0.35;
    g.gain.setTargetAtTime(0.0001, t0 + 0.01, 0.55);           // 자연 감쇠
    g.gain.setTargetAtTime(0.0001, t0 + dur + 0.05, 0.09);     // 댐퍼 릴리스

    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(9000, f * 8), t0);
    lp.frequency.exponentialRampToValueAtTime(Math.max(600, f * 2), t0 + 0.9);
    lp.Q.value = 0.4;
    g.connect(lp);
    out(lp);

    var partials = [
      [1, 1.0, 'triangle', 0],
      [1, 0.55, 'sine', 1.5],
      [2, 0.28, 'sine', 0],
      [3, 0.1, 'sine', 0],
      [4, 0.05, 'sine', 0]
    ];
    for (var i = 0; i < partials.length; i++) {
      var o = ctx.createOscillator();
      o.type = partials[i][2];
      o.frequency.value = f * partials[i][0];
      if (partials[i][3]) o.detune.value = partials[i][3];
      var pg = ctx.createGain();
      pg.gain.value = partials[i][1];
      o.connect(pg);
      pg.connect(g);
      o.start(t0);
      o.stop(ringEnd + 0.6);
    }
  }

  // 현악 패드: 디튠된 톱니파 2개 + 저역 통과, 느린 어택/릴리스
  function strings(f, t0, dur, vel) {
    var g = ctx.createGain();
    var peak = 0.05 * vel;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.35);
    g.gain.setValueAtTime(peak, t0 + Math.max(0.35, dur - 0.3));
    g.gain.linearRampToValueAtTime(0.0001, t0 + dur + 0.1);
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    lp.Q.value = 0.7;
    g.connect(lp);
    out(lp);
    var det = [-7, 7];
    for (var i = 0; i < det.length; i++) {
      var o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = det[i];
      o.connect(g);
      o.start(t0);
      o.stop(t0 + dur + 0.3);
    }
  }

  // 베이스: 부드러운 삼각파 + 사인 배음
  function bass(f, t0, dur, vel) {
    var g = ctx.createGain();
    var peak = 0.16 * vel;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.01);
    g.gain.setTargetAtTime(0.0001, t0 + 0.02, 0.3);
    g.gain.setTargetAtTime(0.0001, t0 + dur, 0.06);
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    g.connect(lp);
    out(lp);
    var specs = [['triangle', 1, 1], ['sine', 2, 0.3]];
    for (var i = 0; i < specs.length; i++) {
      var o = ctx.createOscillator();
      o.type = specs[i][0];
      o.frequency.value = f * specs[i][1];
      var pg = ctx.createGain();
      pg.gain.value = specs[i][2];
      o.connect(pg);
      pg.connect(g);
      o.start(t0);
      o.stop(t0 + dur + 0.8);
    }
  }

  var VOICES = { piano: piano, strings: strings, bass: bass };

  function tempoScale() {
    var s = 1 + (Math.min(level, 20) - 1) * 0.03;
    if (danger) s *= 1.15;
    if (fever) s *= 1.1;
    return Math.min(s, 1.7);
  }

  function beatDur() {
    return 60 / (TRACKS[trackIndex].bpm * tempoScale());
  }

  function schedule() {
    if (!playing || !ctx || paused) return;
    var track = TRACKS[trackIndex];
    while (nextTime < ctx.currentTime + LOOKAHEAD) {
      var b = beatDur();
      var evs = track.slots[slot % track.totalSlots];
      if (evs) {
        for (var i = 0; i < evs.length; i++) {
          var e = evs[i];
          VOICES[e.voice](e.f, nextTime, e.beats * b, e.vel);
        }
      }
      nextTime += SLOT * b;
      slot++;
    }
  }

  function fadeTo(v, sec) {
    if (!master) return;
    var t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(v, t + (sec || 0.2));
  }

  global.Music = {
    TRACKS: TRACKS,
    trackName: function (i) { return TRACKS[i == null ? trackIndex : i].name; },
    trackCount: function () { return TRACKS.length; },
    currentTrack: function () { return trackIndex; },
    setEnabled: function (v) {
      enabled = !!v;
      if (!enabled) this.stop();
    },
    // 재생 시작 (i: 트랙 번호, 생략 시 현재 트랙)
    start: function (i) {
      if (!enabled) return;
      if (!ensure()) return;
      if (typeof i === 'number') trackIndex = ((i % TRACKS.length) + TRACKS.length) % TRACKS.length;
      playing = true;
      paused = false;
      slot = 0;
      nextTime = ctx.currentTime + 0.08;
      fadeTo(1, 0.6);
      clearInterval(timer);
      timer = setInterval(schedule, TICK);
      schedule();
    },
    next: function () {
      var i = (trackIndex + 1) % TRACKS.length;
      if (playing) {
        fadeTo(0, 0.15);
        var self = this;
        setTimeout(function () { self.start(i); }, 180);
      } else {
        trackIndex = i;
      }
      return i;
    },
    stop: function () {
      if (!playing) return;
      playing = false;
      paused = false;
      clearInterval(timer);
      timer = null;
      fadeTo(0, 0.5);
    },
    pause: function () {
      if (!playing || paused) return;
      paused = true;
      fadeTo(0, 0.15);
    },
    resume: function () {
      if (!playing || !paused) return;
      paused = false;
      if (ctx.state === 'suspended') ctx.resume();
      nextTime = Math.max(nextTime, ctx.currentTime + 0.08);
      fadeTo(1, 0.3);
    },
    setLevel: function (l) { level = l; },
    setDanger: function (d) { danger = !!d; },
    setFever: function (f) { fever = !!f; },
    isPlaying: function () { return playing; }
  };
})(window);
