'use strict';
/* sfx.js — WebAudio 합성 효과음 엔진 (외부 오디오 파일 없음)
 * 모든 출력은 AudioCore.sfx() 버스로, 잔향은 AudioCore.reverbSend() 로 갑니다.
 */
const Sfx = (() => {
  const MAX_VOICES = 30;
  let voices = 0;

  const C = () => AudioCore.ctx();
  const now = () => AudioCore.now();

  function busy(prio) { return voices > MAX_VOICES - (prio ? 0 : 8); }

  function cleanup(src, nodes) {
    voices++;
    src.onended = () => {
      voices = Math.max(0, voices - 1);
      for (const n of nodes) { try { n.disconnect(); } catch (e) { /* 이미 정리됨 */ } }
    };
  }

  /** 출력 연결: [pan] → sfx 버스, 선택적으로 리버브 센드 */
  function wire(c, node, o) {
    o = o || {};
    let tail = node;
    if (o.pan && c.createStereoPanner) {
      const p = c.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, o.pan));
      tail.connect(p);
      tail = p;
    }
    const bus = AudioCore.sfx();
    if (bus) tail.connect(bus);
    if (o.verb) {
      const send = AudioCore.reverbSend();
      if (send) {
        const g = c.createGain();
        g.gain.value = o.verb;
        tail.connect(g);
        g.connect(send);
        return [tail, g];
      }
    }
    return [tail];
  }

  /** 오실레이터 한 발 */
  function osc(type, f0, f1, t0, dur, peak, o) {
    const c = C();
    if (!c || busy(o && o.prio)) return;
    o = o || {};
    const s = c.createOscillator();
    s.type = type;
    s.frequency.setValueAtTime(Math.max(1, f0), t0);
    if (f1 !== f0) s.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    if (o.detune) s.detune.value = o.detune;

    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + (o.atk != null ? o.atk : 0.005));
    if (o.hold) g.gain.setValueAtTime(peak, t0 + o.hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    let chain = g;
    const extra = [];
    if (o.filter) {
      const f = c.createBiquadFilter();
      f.type = o.filter;
      f.frequency.setValueAtTime(o.ff0 || 1000, t0);
      if (o.ff1) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.ff1), t0 + dur);
      if (o.q) f.Q.value = o.q;
      g.connect(f);
      chain = f;
      extra.push(f);
    }
    s.connect(g);
    const outs = wire(c, chain, o);
    s.start(t0);
    s.stop(t0 + dur + 0.03);
    cleanup(s, [s, g].concat(extra, outs));
  }

  /** 노이즈 버스트 */
  function noise(t0, dur, peak, o) {
    const c = C();
    if (!c || busy(o && o.prio)) return;
    o = o || {};
    const buf = AudioCore.noise(Math.min(3, Math.max(0.05, dur)));
    if (!buf) return;
    const s = c.createBufferSource();
    s.buffer = buf;
    if (o.rate) s.playbackRate.value = o.rate;

    const f = c.createBiquadFilter();
    f.type = o.filter || 'lowpass';
    f.frequency.setValueAtTime(Math.max(20, o.ff0 || 1200), t0);
    if (o.ff1) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.ff1), t0 + dur);
    if (o.q) f.Q.value = o.q;

    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + (o.atk != null ? o.atk : 0.006));
    if (o.hold) g.gain.setValueAtTime(peak, t0 + o.hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    s.connect(f).connect(g);
    const outs = wire(c, g, o);
    s.start(t0);
    s.stop(t0 + dur + 0.03);
    cleanup(s, [s, f, g].concat(outs));
  }

  const R = (a, b) => a + Math.random() * (b - a);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  /* ══════════ 발사 ══════════ */

  function fire(kind, power) {
    const c = C(); if (!c) return;
    AudioCore.resume();
    const t = now();
    const p = clamp01(power == null ? 0.6 : power);
    const k = 0.55 + p * 0.8;

    switch (kind) {
      case 'heavy':
        osc('sine', 150 * k, 28, t, 0.55, 0.85, { prio: 1, atk: 0.002 });
        noise(t, 0.34, 0.5, { filter: 'lowpass', ff0: 1400, ff1: 90, verb: 0.3, prio: 1 });
        noise(t, 0.09, 0.35, { filter: 'highpass', ff0: 2200 });
        osc('triangle', 320, 70, t, 0.2, 0.3, {});
        break;
      case 'rocket':
        noise(t, 0.62, 0.42, { filter: 'bandpass', ff0: 400, ff1: 3000, q: 1.4, verb: 0.28, prio: 1 });
        osc('sawtooth', 140, 520, t, 0.5, 0.16, { filter: 'lowpass', ff0: 900, ff1: 3200 });
        noise(t, 0.07, 0.3, { filter: 'highpass', ff0: 1800 });
        break;
      case 'gatling':
        for (let i = 0; i < 7; i++) {
          const tt = t + i * 0.043;
          noise(tt, 0.05, 0.32, { filter: 'bandpass', ff0: 1700, q: 2.2 });
          osc('square', 220, 90, tt, 0.05, 0.16, {});
        }
        break;
      case 'mortar':
        osc('sine', 190 * k, 52, t, 0.34, 0.7, { prio: 1, atk: 0.006 });
        noise(t, 0.2, 0.26, { filter: 'lowpass', ff0: 700, ff1: 120, verb: 0.25 });
        break;
      case 'laser':
        osc('sawtooth', 2100, 240, t, 0.26, 0.24, { filter: 'bandpass', ff0: 2400, ff1: 500, q: 5, prio: 1 });
        osc('sine', 1400, 180, t, 0.22, 0.18, {});
        noise(t, 0.14, 0.2, { filter: 'highpass', ff0: 2600, ff1: 900, verb: 0.3 });
        break;
      default: // cannon
        noise(t, 0.11, 0.55, { filter: 'highpass', ff0: 2400, ff1: 700, prio: 1 });
        osc('sine', 190 * k, 42, t, 0.4, 0.75, { prio: 1, atk: 0.002 });
        noise(t, 0.28, 0.36, { filter: 'lowpass', ff0: 1600, ff1: 120, verb: 0.28 });
        osc('square', 420, 110, t, 0.12, 0.16, {});
    }
  }

  /* ══════════ 폭발 ══════════ */

  function explode(radius, kind) {
    const c = C(); if (!c) return;
    const t = now();
    const r = Math.max(6, radius || 34);
    const k = Math.min(2.6, r / 34);

    if (kind === 'small') {
      noise(t, 0.2, 0.4, { filter: 'lowpass', ff0: 1800, ff1: 180, verb: 0.3 });
      osc('sine', 220, 60, t, 0.22, 0.4, {});
      return;
    }

    if (kind === 'fire') {
      noise(t, 0.5, 0.16, { filter: 'bandpass', ff0: 700, ff1: 260, q: 0.9, verb: 0.35 });
      return;
    }

    if (kind === 'ice') {
      noise(t, 0.34, 0.42, { filter: 'highpass', ff0: 3200, ff1: 1200, verb: 0.5, prio: 1 });
      osc('sine', 120, 46, t, 0.4, 0.5, { prio: 1 });
      for (let i = 0; i < 6; i++) {
        osc('sine', R(1600, 3400), R(900, 2200), t + i * 0.035, 0.3, 0.11, { verb: 0.6 });
      }
      return;
    }

    if (kind === 'quake') {
      osc('sine', 70, 22, t, 1.5 * k, 0.9, { prio: 1, atk: 0.02 });
      noise(t, 1.3 * k, 0.45, { filter: 'lowpass', ff0: 420, ff1: 55, verb: 0.4, prio: 1 });
      for (let i = 0; i < 10; i++) {
        noise(t + R(0.05, 0.9), R(0.05, 0.16), 0.16, { filter: 'bandpass', ff0: R(300, 1300), q: 1.6 });
      }
      return;
    }

    const nuke = kind === 'nuke';
    // 서브 임팩트
    osc('sine', nuke ? 110 : 130 * k, nuke ? 16 : 26, t, nuke ? 2.4 : 0.7 * k, 1, { prio: 1, atk: 0.002 });
    if (nuke) osc('sine', 60, 12, t + 0.1, 3.2, 0.8, { prio: 1, atk: 0.05 });
    // 중역 크랙
    noise(t, nuke ? 0.22 : 0.13, nuke ? 0.75 : 0.55, { filter: 'highpass', ff0: 2600, ff1: 600, prio: 1 });
    // 본체 + 테일
    noise(t, nuke ? 2.6 : 0.75 * k, nuke ? 0.8 : 0.6, {
      filter: 'lowpass', ff0: nuke ? 2600 : 1900, ff1: nuke ? 45 : 90, verb: nuke ? 0.7 : 0.42, prio: 1,
    });
    // 파편 소리
    const shards = Math.round(6 + k * 5) * (nuke ? 3 : 1);
    for (let i = 0; i < shards; i++) {
      noise(t + R(0.04, nuke ? 1.4 : 0.5), R(0.03, 0.12), R(0.08, 0.2), {
        filter: 'bandpass', ff0: R(700, 3600), q: 2.4, pan: R(-0.8, 0.8),
      });
    }
    // 핵: 이어지는 럼블
    if (nuke) {
      noise(t + 0.5, 3.4, 0.4, { filter: 'lowpass', ff0: 320, ff1: 40, verb: 0.8, prio: 1 });
      osc('sawtooth', 42, 18, t + 0.3, 2.6, 0.22, { filter: 'lowpass', ff0: 200, ff1: 60 });
    }
  }

  /* ══════════ 타격 · 파괴 ══════════ */

  function metalHit(power) {
    const t = now();
    const p = clamp01(power == null ? 0.6 : power);
    noise(t, 0.09, 0.4 + p * 0.3, { filter: 'bandpass', ff0: 2400, q: 1.2, prio: 1 });
    osc('square', 900 + p * 500, 300, t, 0.12, 0.18, {});
    osc('triangle', 1650, 900, t, 0.32, 0.13, { verb: 0.4 });
    osc('sine', 180, 70, t, 0.2, 0.3 * (0.5 + p), {});
  }

  function armorGraze() {
    const t = now();
    noise(t, 0.16, 0.24, { filter: 'bandpass', ff0: 3200, ff1: 1400, q: 3 });
    osc('sine', 2400, 700, t, 0.18, 0.1, { verb: 0.4 });
  }

  function destroy() {
    const t = now();
    explode(56, 'normal');
    osc('sawtooth', 300, 44, t + 0.05, 0.8, 0.3, { filter: 'lowpass', ff0: 1400, ff1: 180, verb: 0.4, prio: 1 });
    for (let i = 0; i < 9; i++) {
      noise(t + R(0.1, 0.8), R(0.04, 0.12), 0.2, { filter: 'bandpass', ff0: R(900, 3000), q: 3, pan: R(-0.7, 0.7) });
    }
    osc('triangle', 520, 130, t + 0.18, 0.5, 0.12, { verb: 0.5 });
  }

  function collapse() {
    const t = now();
    noise(t, 0.75, 0.4, { filter: 'lowpass', ff0: 900, ff1: 80, verb: 0.35, prio: 1 });
    osc('sine', 95, 34, t, 0.5, 0.4, {});
    for (let i = 0; i < 12; i++) {
      noise(t + R(0, 0.55), R(0.02, 0.07), 0.13, { filter: 'bandpass', ff0: R(500, 2400), q: 3, pan: R(-0.6, 0.6) });
    }
  }

  /* ══════════ 충전 (지속음 하나 유지) ══════════ */

  let chargeNodes = null;

  function charge(level) {
    const c = C(); if (!c) return;
    const l = Math.max(0, Math.min(100, level || 0));
    if (!chargeNodes) {
      const o1 = c.createOscillator(); o1.type = 'sawtooth';
      const o2 = c.createOscillator(); o2.type = 'square'; o2.detune.value = 8;
      const f = c.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 6;
      const g = c.createGain(); g.gain.value = 0.0001;
      o1.connect(f); o2.connect(f); f.connect(g);
      const bus = AudioCore.sfx();
      if (bus) g.connect(bus);
      o1.start(); o2.start();
      chargeNodes = { o1, o2, f, g };
      g.gain.setTargetAtTime(0.12, c.currentTime, 0.05);
    }
    const n = chargeNodes;
    const hz = 130 + l * 6.4;
    const tt = c.currentTime;
    n.o1.frequency.setTargetAtTime(hz, tt, 0.03);
    n.o2.frequency.setTargetAtTime(hz * 2, tt, 0.03);
    n.f.frequency.setTargetAtTime(hz * 3 + 200, tt, 0.05);
    n.g.gain.setTargetAtTime(0.07 + (l / 100) * 0.11, tt, 0.06);
  }

  function chargeStop() {
    const c = C();
    if (!chargeNodes || !c) return;
    const n = chargeNodes;
    chargeNodes = null;
    const t = c.currentTime;
    n.g.gain.cancelScheduledValues(t);
    n.g.gain.setValueAtTime(Math.max(0.0001, n.g.gain.value), t);
    n.g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    try { n.o1.stop(t + 0.12); n.o2.stop(t + 0.12); } catch (e) { /* 이미 정지 */ }
    n.o1.onended = () => {
      for (const k in n) { try { n[k].disconnect(); } catch (e) { /* noop */ } }
    };
  }

  /* ══════════ 엔진 (지속 루프) ══════════ */

  let engineNodes = null;

  function engine(on) {
    const c = C(); if (!c) return;
    if (on) {
      if (engineNodes) return;
      const buf = AudioCore.noise(1.2);
      if (!buf) return;
      const s = c.createBufferSource();
      s.buffer = buf; s.loop = true; s.playbackRate.value = 0.5;
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 380; f.Q.value = 3;
      const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 58;
      const og = c.createGain(); og.gain.value = 0.05;
      const lfo = c.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 7.5;
      const lg = c.createGain(); lg.gain.value = 22;
      const g = c.createGain(); g.gain.value = 0.0001;
      lfo.connect(lg).connect(o.frequency);
      s.connect(f).connect(g);
      o.connect(og).connect(g);
      const bus = AudioCore.sfx();
      if (bus) g.connect(bus);
      s.start(); o.start(); lfo.start();
      g.gain.setTargetAtTime(0.12, c.currentTime, 0.08);
      engineNodes = { s, f, o, og, lfo, lg, g };
    } else if (engineNodes) {
      const n = engineNodes;
      engineNodes = null;
      const t = c.currentTime;
      n.g.gain.cancelScheduledValues(t);
      n.g.gain.setValueAtTime(Math.max(0.0001, n.g.gain.value), t);
      n.g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      try { n.s.stop(t + 0.16); n.o.stop(t + 0.16); n.lfo.stop(t + 0.16); } catch (e) { /* 이미 정지 */ }
      n.s.onended = () => {
        for (const k in n) { try { n[k].disconnect(); } catch (e) { /* noop */ } }
      };
    }
  }

  /* ══════════ UI · 알림 ══════════ */

  function turnStart(isYou) {
    const t = now();
    if (isYou) {
      osc('triangle', 660, 660, t, 0.14, 0.2, { verb: 0.4, atk: 0.008 });
      osc('triangle', 990, 990, t + 0.1, 0.26, 0.2, { verb: 0.5, atk: 0.008 });
      osc('sine', 1320, 1320, t + 0.2, 0.3, 0.12, { verb: 0.5, atk: 0.01 });
    } else {
      osc('sine', 420, 380, t, 0.18, 0.11, { verb: 0.3, atk: 0.01 });
    }
  }

  function select() {
    const t = now();
    osc('square', 720, 900, t, 0.07, 0.1, {});
    osc('sine', 1440, 1600, t + 0.03, 0.09, 0.06, { verb: 0.3 });
  }

  function click() { osc('square', 520, 420, now(), 0.05, 0.07, {}); }
  function hover() { osc('sine', 900, 940, now(), 0.04, 0.035, {}); }
  function tick() { noise(now(), 0.03, 0.08, { filter: 'bandpass', ff0: 3000, q: 4 }); }

  function warning() {
    const t = now();
    for (let i = 0; i < 2; i++) {
      osc('sawtooth', 520, 500, t + i * 0.22, 0.16, 0.16, { filter: 'lowpass', ff0: 1600, verb: 0.3 });
      osc('sawtooth', 392, 380, t + i * 0.22, 0.16, 0.14, { filter: 'lowpass', ff0: 1400 });
    }
  }

  function windGust(strength) {
    const s = Math.abs(strength || 0);
    if (s < 2) return;
    const t = now();
    noise(t, 1.4, 0.03 + (s / 10) * 0.07, {
      filter: 'bandpass', ff0: 420 + s * 60, ff1: 260, q: 0.7,
      pan: Math.max(-0.9, Math.min(0.9, (strength || 0) / 10)), verb: 0.4, atk: 0.5,
    });
  }

  function fanfare(notes, type, gain) {
    const t = now();
    notes.forEach((n, i) => {
      const f = 440 * Math.pow(2, (n - 69) / 12);
      const tt = t + i * 0.13;
      osc(type, f, f, tt, 0.5, gain, { filter: 'lowpass', ff0: 3200, verb: 0.55, atk: 0.012, prio: 1 });
      osc(type, f * 2, f * 2, tt, 0.35, gain * 0.4, { verb: 0.4, atk: 0.012 });
    });
  }

  function win() { fanfare([60, 64, 67, 72], 'sawtooth', 0.17); }
  function lose() { fanfare([67, 63, 60, 56], 'triangle', 0.15); }

  return {
    fire, explode, metalHit, armorGraze, charge, chargeStop, engine,
    turnStart, select, click, hover, tick, collapse, destroy, win, lose,
    windGust, warning,
    // 구버전 호환
    boom: (r) => explode(r, 'normal'),
    hit: () => metalHit(0.6),
    toggle() { AudioCore.setMuted(!AudioCore.isMuted()); return AudioCore.isMuted(); },
    get muted() { return AudioCore.isMuted(); },
  };
})();
