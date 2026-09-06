/* audio.js — Web Audio 기반 간단 효과음 (외부 파일 없음) */
(function (global) {
  'use strict';

  var ctx = null;
  var enabled = true;

  function ensure() {
    if (!ctx) {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, dur, type, vol, delay, slideTo) {
    var c = ensure();
    if (!c) return;
    var t0 = c.currentTime + (delay || 0);
    var osc = c.createOscillator();
    var gain = c.createGain();
    osc.type = type || 'square';
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol || 0.08, t0 + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  var SFX = {
    move: function () { tone(220, 0.03, 'square', 0.03); },
    rotate: function () { tone(440, 0.05, 'triangle', 0.06); },
    hold: function () { tone(330, 0.08, 'sine', 0.07, 0, 500); },
    lock: function () { tone(140, 0.07, 'square', 0.06); },
    hard: function () { tone(120, 0.1, 'sawtooth', 0.07, 0, 60); },
    clear: function (n) {
      var notes = [523, 659, 784, 1047];
      for (var i = 0; i < Math.min(n, 4); i++) tone(notes[i], 0.12, 'triangle', 0.09, i * 0.06);
    },
    tetris: function () {
      var notes = [523, 659, 784, 1047, 1319];
      for (var i = 0; i < notes.length; i++) tone(notes[i], 0.16, 'square', 0.08, i * 0.07);
    },
    tspin: function () {
      tone(880, 0.1, 'triangle', 0.08);
      tone(1175, 0.16, 'triangle', 0.08, 0.08);
    },
    levelup: function () {
      var notes = [392, 523, 659, 784];
      for (var i = 0; i < notes.length; i++) tone(notes[i], 0.14, 'sine', 0.1, i * 0.09);
    },
    gameover: function () {
      var notes = [392, 349, 311, 262];
      for (var i = 0; i < notes.length; i++) tone(notes[i], 0.28, 'sawtooth', 0.07, i * 0.22);
    }
  };

  global.Sound = {
    unlock: ensure,
    setEnabled: function (v) { enabled = !!v; },
    play: function (name, arg) {
      if (!enabled) return;
      var fn = SFX[name];
      if (fn) {
        try { fn(arg); } catch (_) { /* 오디오 실패는 무시 */ }
      }
    }
  };
})(window);
