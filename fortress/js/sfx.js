'use strict';
/* sfx.js — WebAudio 합성 효과음 (외부 파일 없음) */
const Sfx = (() => {
  let ctx = null;
  let muted = false;

  function ensure() {
    if (muted) return null;
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function noise(c, dur, gain, filterFreq, filterEnd) {
    const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = 'lowpass';
    f.frequency.setValueAtTime(filterFreq, c.currentTime);
    f.frequency.exponentialRampToValueAtTime(filterEnd, c.currentTime + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(gain, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
    src.connect(f).connect(g).connect(c.destination);
    src.start();
  }

  function tone(c, f0, f1, dur, gain, type) {
    const o = c.createOscillator(); o.type = type || 'sine';
    o.frequency.setValueAtTime(f0, c.currentTime);
    o.frequency.exponentialRampToValueAtTime(f1, c.currentTime + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(gain, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
    o.connect(g).connect(c.destination);
    o.start(); o.stop(c.currentTime + dur);
  }

  return {
    fire() { const c = ensure(); if (!c) return; noise(c, 0.18, 0.5, 3000, 300); tone(c, 220, 60, 0.25, 0.25, 'triangle'); },
    boom(radius) {
      const c = ensure(); if (!c) return;
      const k = clamp(radius / 34, 0.6, 2.2);
      noise(c, 0.5 * k, 0.8, 900, 60);
      tone(c, 90, 30, 0.5 * k, 0.5, 'sine');
    },
    hit() { const c = ensure(); if (!c) return; tone(c, 600, 200, 0.15, 0.2, 'square'); },
    charge(level) { const c = ensure(); if (!c) return; tone(c, 200 + level * 6, 200 + level * 6, 0.04, 0.05, 'square'); },
    toggle() { muted = !muted; return muted; },
    get muted() { return muted; },
  };
})();
