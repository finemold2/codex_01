// ============================================================
//  오디오 엔진 — Web Audio 신시사이저
//   · BGM: 악보를 실시간 합성해 재생 (루프·크로스페이드)
//   · SFX: 전부 절차적으로 만들어낸다 (외부 파일 없음)
//   · 배경음/효과음 음량을 각각 조절
// ============================================================
import { SCORES, SCORE_BY_ID, INSTRUMENTS, parseScore, midiToFreq, scoresFor } from './scores.js';

const LOOKAHEAD = 0.12;      // 초 — 스케줄러 선행 시간
const TICK = 25;             // ms

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.bgmVol = 0.55;
    this.sfxVol = 0.7;
    this.muted = false;
    this.current = null;       // {score, tracks, startTime, len}
    this.next = null;
    this.timer = null;
    this.parsedCache = new Map();
    this.noiseBuf = null;
    this.playlistMood = null;
    this.onTrackChange = null;
  }

  // ── 초기화 (사용자 제스처 이후 호출) ──
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;
    // 잔향 (간이 컨볼루션)
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this._makeImpulse(2.4, 2.6);
    this.reverbGain = this.ctx.createGain();
    this.reverbGain.gain.value = 0.24;
    // 전체 압축 — 클리핑 방지
    this.comp = this.ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14; this.comp.knee.value = 22;
    this.comp.ratio.value = 5; this.comp.attack.value = 0.006; this.comp.release.value = 0.22;

    this.bgmGain = this.ctx.createGain();
    this.sfxGain = this.ctx.createGain();
    this.bgmGain.gain.value = this.bgmVol;
    this.sfxGain.gain.value = this.sfxVol;

    this.bgmGain.connect(this.master);
    this.sfxGain.connect(this.master);
    this.bgmGain.connect(this.reverbGain);
    this.sfxGain.connect(this.reverbGain);
    this.reverbGain.connect(this.reverb);
    this.reverb.connect(this.master);
    this.master.connect(this.comp);
    this.comp.connect(this.ctx.destination);

    this.noiseBuf = this._makeNoise(2.0);
    this.ready = true;
    this.timer = setInterval(() => this._schedule(), TICK);
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  _makeImpulse(dur, decay) {
    const sr = this.ctx.sampleRate, len = Math.floor(sr * dur);
    const buf = this.ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  _makeNoise(dur) {
    const sr = this.ctx.sampleRate, len = Math.floor(sr * dur);
    const buf = this.ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // ── 음량 ──
  setBgmVolume(v) {
    this.bgmVol = Math.max(0, Math.min(1, v));
    if (this.bgmGain) this.bgmGain.gain.setTargetAtTime(this.muted ? 0 : this.bgmVol, this.ctx.currentTime, 0.05);
  }
  setSfxVolume(v) {
    this.sfxVol = Math.max(0, Math.min(1, v));
    if (this.sfxGain) this.sfxGain.gain.setTargetAtTime(this.muted ? 0 : this.sfxVol, this.ctx.currentTime, 0.05);
  }
  setMuted(m) {
    this.muted = m;
    if (!this.ctx) return;
    this.bgmGain.gain.setTargetAtTime(m ? 0 : this.bgmVol, this.ctx.currentTime, 0.05);
    this.sfxGain.gain.setTargetAtTime(m ? 0 : this.sfxVol, this.ctx.currentTime, 0.05);
  }

  // ── BGM ──
  _parse(score) {
    if (this.parsedCache.has(score.id)) return this.parsedCache.get(score.id);
    const tracks = score.tracks.map(t => ({
      inst: INSTRUMENTS[t.inst] || INSTRUMENTS.strings,
      instName: t.inst,
      gain: t.gain ?? 1,
      ...parseScore(t.score),
    }));
    const len = Math.max(...tracks.map(t => t.length));
    const data = { tracks, len };
    this.parsedCache.set(score.id, data);
    return data;
  }

  /** 곡 재생 (id 또는 mood). 이미 같은 곡이면 무시 */
  play(idOrMood, opt = {}) {
    if (!this.ready) { this.pendingPlay = [idOrMood, opt]; return; }
    this.resume();
    let score = SCORE_BY_ID[idOrMood];
    if (!score) {
      const list = scoresFor(idOrMood);
      if (!list.length) return;
      this.playlistMood = idOrMood;
      score = list[Math.floor(Math.random() * list.length)];
      if (this.current && this.current.score.id === score.id && list.length > 1) {
        score = list[(list.indexOf(score) + 1) % list.length];
      }
    } else {
      this.playlistMood = null;
    }
    if (this.current && this.current.score.id === score.id && !opt.force) return;
    this._startScore(score, opt.fade ?? 1.2);
  }

  _startScore(score, fadeSec = 1.2) {
    const now = this.ctx.currentTime;
    if (this.current) {
      const old = this.current;
      old.gain.gain.cancelScheduledValues(now);
      old.gain.gain.setValueAtTime(old.gain.gain.value, now);
      old.gain.gain.linearRampToValueAtTime(0, now + fadeSec);
      old.stopAt = now + fadeSec + 0.1;
      old.fading = true;
      if (this.fadingOut) this._killVoice(this.fadingOut);
      this.fadingOut = old;
      setTimeout(() => { if (this.fadingOut === old) { this._killVoice(old); this.fadingOut = null; } }, (fadeSec + 0.3) * 1000);
    }
    const data = this._parse(score);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(1, now + Math.min(fadeSec, 1.0));
    g.connect(this.bgmGain);
    this.current = {
      score, data, gain: g,
      spb: 60 / score.bpm,
      startTime: now + 0.08,
      cursor: 0,            // 다음에 스케줄할 루프 회차
      trackPos: data.tracks.map(() => 0),
      loopCount: 0,
      nodes: [],
    };
    if (this.onTrackChange) this.onTrackChange(score);
  }

  _killVoice(v) {
    try { v.gain.disconnect(); } catch (e) { /* 이미 해제됨 */ }
    for (const n of v.nodes) { try { n.stop(); } catch (e) { /* 종료됨 */ } }
    v.nodes.length = 0;
  }

  stop(fade = 1.0) {
    if (!this.current) return;
    const now = this.ctx.currentTime;
    this.current.gain.gain.cancelScheduledValues(now);
    this.current.gain.gain.setValueAtTime(this.current.gain.gain.value, now);
    this.current.gain.gain.linearRampToValueAtTime(0, now + fade);
    const dead = this.current;
    this.current = null;
    setTimeout(() => this._killVoice(dead), (fade + 0.3) * 1000);
  }

  _schedule() {
    const cur = this.current;
    if (!cur || !this.ctx) return;
    const now = this.ctx.currentTime;
    const horizon = now + LOOKAHEAD + 0.4;
    const { data, spb } = cur;
    const loopLen = data.len * spb;

    while (cur.startTime + cur.loopCount * loopLen < horizon) {
      const loopStart = cur.startTime + cur.loopCount * loopLen;
      if (loopStart > horizon) break;
      if (!cur.scheduledLoops) cur.scheduledLoops = new Set();
      if (cur.scheduledLoops.has(cur.loopCount)) { cur.loopCount++; continue; }
      cur.scheduledLoops.add(cur.loopCount);
      for (const tr of data.tracks) {
        const reps = Math.max(1, Math.round(data.len / tr.length));
        for (let rep = 0; rep < reps; rep++) {
          const off = rep * tr.length * spb;
          for (const ev of tr.events) {
            const t = loopStart + off + ev.t * spb;
            if (t < now - 0.05) continue;
            if (t > horizon + loopLen) continue;
            for (const m of ev.notes) {
              this._voice(cur, tr.inst, m, t, ev.dur * spb, ev.vel * tr.gain);
            }
          }
        }
      }
      cur.loopCount++;
      // 재생목록 모드: 몇 번 돌면 다음 곡으로
      if (this.playlistMood && cur.loopCount >= (loopLen < 20 ? 4 : 2)) {
        const list = scoresFor(this.playlistMood).filter(s => s.id !== cur.score.id);
        if (list.length) {
          const nx = list[Math.floor(Math.random() * list.length)];
          const delay = Math.max(0.2, (loopStart + loopLen) - now - 1.0);
          setTimeout(() => {
            if (this.current === cur) { const mood = this.playlistMood; this._startScore(nx, 2.0); this.playlistMood = mood; }
          }, delay * 1000);
          this.playlistMood = null;
          setTimeout(() => { }, 0);
        }
      }
      break;   // 한 번에 한 루프만
    }
    // 오래된 노드 정리
    if (cur.nodes.length > 900) cur.nodes.splice(0, 400);
  }

  /** 한 음 합성 */
  _voice(owner, inst, midi, time, dur, vel = 1) {
    const ctx = this.ctx;
    const freq = midiToFreq(midi);
    const out = ctx.createGain();
    const peak = (inst.gain ?? 0.25) * vel;
    const a = inst.a, d = inst.d, s = inst.s, r = inst.r;
    const sus = Math.max(0.02, dur - a - d * 0.5);
    out.gain.setValueAtTime(0.0001, time);
    out.gain.linearRampToValueAtTime(peak, time + a);
    out.gain.linearRampToValueAtTime(peak * s + 0.0001, time + a + d);
    out.gain.setValueAtTime(peak * s + 0.0001, time + a + d + sus);
    out.gain.exponentialRampToValueAtTime(0.0001, time + a + d + sus + r);

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(Math.min(16000, inst.cutoff * 1.6), time);
    filt.frequency.exponentialRampToValueAtTime(Math.max(180, inst.cutoff), time + a + d + 0.1);
    filt.Q.value = inst.q;
    filt.connect(out);
    out.connect(owner.gain);

    const stopAt = time + a + d + sus + r + 0.05;
    const voices = inst.voices || 1;
    for (let v = 0; v < voices; v++) {
      const osc = ctx.createOscillator();
      osc.type = inst.wave;
      osc.frequency.value = freq;
      if (inst.detune) osc.detune.value = (v - (voices - 1) / 2) * inst.detune;
      // 현악기 비브라토
      if (inst.wave === 'sawtooth' && dur > 0.5) {
        const lfo = ctx.createOscillator(); const lg = ctx.createGain();
        lfo.frequency.value = 5.2 + Math.random() * 0.9;
        lg.gain.value = 3.2;
        lfo.connect(lg); lg.connect(osc.detune);
        lfo.start(time); lfo.stop(stopAt);
        owner.nodes.push(lfo);
      }
      osc.connect(filt);
      osc.start(time); osc.stop(stopAt);
      owner.nodes.push(osc);
    }
    // 오르간 배음
    if (inst.partials) {
      for (const p of inst.partials.slice(1)) {
        const o2 = ctx.createOscillator();
        o2.type = 'sine'; o2.frequency.value = freq * p;
        const g2 = ctx.createGain(); g2.gain.value = 1 / (p * 1.9);
        o2.connect(g2); g2.connect(filt);
        o2.start(time); o2.stop(stopAt);
        owner.nodes.push(o2);
      }
    }
    // 팀파니 타격음
    if (inst.noise) {
      const n = ctx.createBufferSource(); n.buffer = this.noiseBuf;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(peak * inst.noise, time);
      ng.gain.exponentialRampToValueAtTime(0.0001, time + 0.14);
      const nf = ctx.createBiquadFilter(); nf.type = 'bandpass';
      nf.frequency.value = freq * 3; nf.Q.value = 0.8;
      n.connect(nf); nf.connect(ng); ng.connect(owner.gain);
      n.start(time); n.stop(time + 0.2);
      owner.nodes.push(n);
    }
  }

  // ============================================================
  //  효과음 — 전부 절차 생성
  // ============================================================
  _now() { return this.ctx.currentTime + 0.005; }

  _tone({ freq = 440, type = 'sine', dur = 0.15, gain = 0.3, glideTo = null,
          attack = 0.005, cutoff = null, q = 1, delay = 0 }) {
    const ctx = this.ctx, t = this._now() + delay;
    const osc = ctx.createOscillator(); osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, glideTo), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = osc;
    if (cutoff) {
      const f = ctx.createBiquadFilter(); f.type = 'lowpass';
      f.frequency.value = cutoff; f.Q.value = q;
      osc.connect(f); node = f;
    }
    node.connect(g); g.connect(this.sfxGain);
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  _noise({ dur = 0.2, gain = 0.3, type = 'bandpass', freq = 1200, q = 1,
           sweepTo = null, delay = 0, attack = 0.002 }) {
    const ctx = this.ctx, t = this._now() + delay;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(Math.max(60, sweepTo), t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.sfxGain);
    src.start(t); src.stop(t + dur + 0.05);
  }

  sfx(name, opt = {}) {
    if (!this.ready || this.muted) return;
    this.resume();
    const R = (a, b) => a + Math.random() * (b - a);
    switch (name) {
      case 'click':
        this._tone({ freq: R(880, 980), type: 'triangle', dur: 0.05, gain: 0.10 });
        this._tone({ freq: R(1500, 1700), type: 'sine', dur: 0.035, gain: 0.06, delay: 0.012 });
        break;
      case 'hover':
        this._tone({ freq: R(1200, 1320), type: 'sine', dur: 0.03, gain: 0.035 });
        break;
      case 'confirm':
        this._tone({ freq: 660, type: 'triangle', dur: 0.10, gain: 0.14 });
        this._tone({ freq: 990, type: 'triangle', dur: 0.16, gain: 0.12, delay: 0.075 });
        break;
      case 'cancel':
        this._tone({ freq: 420, type: 'square', dur: 0.09, gain: 0.09, glideTo: 220, cutoff: 1400 });
        break;
      case 'error':
        this._tone({ freq: 180, type: 'square', dur: 0.22, gain: 0.12, cutoff: 900 });
        this._tone({ freq: 172, type: 'square', dur: 0.22, gain: 0.10, cutoff: 900, delay: 0.02 });
        break;
      case 'page':
        this._noise({ dur: 0.16, gain: 0.09, type: 'highpass', freq: 2200, sweepTo: 5200 });
        break;
      case 'coin':
        this._tone({ freq: 1320, type: 'square', dur: 0.07, gain: 0.09, cutoff: 4000 });
        this._tone({ freq: 1760, type: 'square', dur: 0.13, gain: 0.08, cutoff: 4000, delay: 0.05 });
        this._tone({ freq: 2640, type: 'sine', dur: 0.16, gain: 0.05, delay: 0.10 });
        break;
      case 'gong': {
        const base = R(150, 172);
        for (const [mul, g, d] of [[1, 0.22, 2.6], [1.51, 0.12, 2.1], [2.03, 0.09, 1.7], [2.71, 0.06, 1.3], [3.6, 0.04, 1.0]]) {
          this._tone({ freq: base * mul, type: 'sine', dur: d, gain: g, attack: 0.004 });
        }
        this._noise({ dur: 0.30, gain: 0.13, type: 'bandpass', freq: 900, q: 0.6, sweepTo: 300 });
        break;
      }
      case 'drum':
        this._tone({ freq: 150, type: 'sine', dur: 0.30, gain: 0.34, glideTo: 55 });
        this._noise({ dur: 0.11, gain: 0.16, type: 'lowpass', freq: 1400, sweepTo: 300 });
        break;
      case 'warDrum':
        for (let i = 0; i < 4; i++) {
          this._tone({ freq: 132, type: 'sine', dur: 0.26, gain: 0.28, glideTo: 52, delay: i * 0.19 });
          this._noise({ dur: 0.09, gain: 0.13, type: 'lowpass', freq: 1200, sweepTo: 260, delay: i * 0.19 });
        }
        break;
      case 'horn':
        for (const [f, d] of [[196, 0], [294, 0.16], [392, 0.32]]) {
          this._tone({ freq: f, type: 'sawtooth', dur: 0.55, gain: 0.14, cutoff: 1100, q: 2, attack: 0.05, delay: d });
        }
        break;
      case 'sword':
        this._noise({ dur: 0.13, gain: 0.26, type: 'bandpass', freq: 4200, q: 1.6, sweepTo: 1500 });
        this._tone({ freq: R(2400, 3200), type: 'triangle', dur: 0.20, gain: 0.10, glideTo: 900 });
        this._tone({ freq: R(3600, 4400), type: 'sine', dur: 0.30, gain: 0.05, delay: 0.01 });
        break;
      case 'clash':
        for (let i = 0; i < 3; i++) {
          this._noise({ dur: 0.10, gain: 0.20, type: 'bandpass', freq: R(3000, 5200), q: 2.2, sweepTo: 1200, delay: i * 0.075 });
        }
        this._tone({ freq: 5200, type: 'sine', dur: 0.5, gain: 0.05, delay: 0.15 });
        break;
      case 'arrow':
        this._noise({ dur: 0.22, gain: 0.14, type: 'bandpass', freq: 5000, q: 3, sweepTo: 800 });
        break;
      case 'volley':
        for (let i = 0; i < 7; i++) {
          this._noise({ dur: 0.20, gain: 0.09, type: 'bandpass', freq: R(3500, 6000), q: 3, sweepTo: 700, delay: i * 0.035 });
        }
        break;
      case 'gallop':
        for (let i = 0; i < 6; i++) {
          this._tone({ freq: R(110, 150), type: 'sine', dur: 0.09, gain: 0.13, glideTo: 60, delay: i * 0.11 });
          this._noise({ dur: 0.06, gain: 0.07, type: 'lowpass', freq: 800, delay: i * 0.11 + 0.02 });
        }
        break;
      case 'fire':
        this._noise({ dur: 1.5, gain: 0.20, type: 'lowpass', freq: 2600, sweepTo: 500, attack: 0.15 });
        this._noise({ dur: 0.9, gain: 0.10, type: 'bandpass', freq: 900, q: 0.5, sweepTo: 200, delay: 0.2 });
        break;
      case 'flood':
        this._noise({ dur: 2.0, gain: 0.22, type: 'lowpass', freq: 900, sweepTo: 2800, attack: 0.4 });
        this._tone({ freq: 60, type: 'sine', dur: 1.6, gain: 0.16, glideTo: 30 });
        break;
      case 'thunder':
        this._noise({ dur: 1.8, gain: 0.30, type: 'lowpass', freq: 3000, sweepTo: 120, attack: 0.004 });
        this._tone({ freq: 48, type: 'sine', dur: 1.4, gain: 0.22, glideTo: 22 });
        break;
      case 'quake':
        this._tone({ freq: 42, type: 'sine', dur: 2.2, gain: 0.28, glideTo: 20 });
        this._noise({ dur: 2.0, gain: 0.14, type: 'lowpass', freq: 260, sweepTo: 70, attack: 0.5 });
        break;
      case 'siege':
        this._tone({ freq: 90, type: 'square', dur: 0.45, gain: 0.22, glideTo: 40, cutoff: 500 });
        this._noise({ dur: 0.6, gain: 0.20, type: 'lowpass', freq: 1200, sweepTo: 180 });
        break;
      case 'wallBreak':
        this._noise({ dur: 1.1, gain: 0.26, type: 'lowpass', freq: 1800, sweepTo: 140 });
        this._tone({ freq: 70, type: 'sine', dur: 0.9, gain: 0.24, glideTo: 28 });
        break;
      case 'crowd':
        this._noise({ dur: 1.4, gain: 0.13, type: 'bandpass', freq: 700, q: 0.5, attack: 0.35 });
        this._noise({ dur: 1.1, gain: 0.08, type: 'bandpass', freq: 1400, q: 0.4, attack: 0.3, delay: 0.15 });
        break;
      case 'cheer':
        this._noise({ dur: 1.7, gain: 0.16, type: 'bandpass', freq: 1100, q: 0.4, attack: 0.25 });
        for (const f of [523, 659, 784, 1047]) this._tone({ freq: f, type: 'triangle', dur: 0.9, gain: 0.06, attack: 0.1 });
        break;
      case 'death':
        this._tone({ freq: 220, type: 'sine', dur: 1.6, gain: 0.15, glideTo: 55 });
        this._tone({ freq: 110, type: 'sine', dur: 2.0, gain: 0.12, glideTo: 40, delay: 0.15 });
        break;
      case 'victory':
        [523, 659, 784, 1047].forEach((f, i) =>
          this._tone({ freq: f, type: 'triangle', dur: 0.55, gain: 0.14, delay: i * 0.11 }));
        this._tone({ freq: 1568, type: 'sine', dur: 1.1, gain: 0.09, delay: 0.45 });
        break;
      case 'defeat':
        [392, 349, 311, 262].forEach((f, i) =>
          this._tone({ freq: f, type: 'sawtooth', dur: 0.65, gain: 0.11, cutoff: 900, delay: i * 0.19 }));
        break;
      case 'levelup':
        [659, 784, 988, 1319].forEach((f, i) =>
          this._tone({ freq: f, type: 'sine', dur: 0.4, gain: 0.11, delay: i * 0.07 }));
        break;
      case 'treasure':
        [784, 988, 1175, 1568, 1976].forEach((f, i) =>
          this._tone({ freq: f, type: 'triangle', dur: 0.55, gain: 0.09, delay: i * 0.065 }));
        this._noise({ dur: 0.7, gain: 0.04, type: 'highpass', freq: 6000, attack: 0.1 });
        break;
      case 'scroll':
        this._noise({ dur: 0.35, gain: 0.09, type: 'bandpass', freq: 2400, q: 0.7, sweepTo: 900 });
        break;
      case 'seal':
        this._tone({ freq: 260, type: 'square', dur: 0.09, gain: 0.16, cutoff: 900 });
        this._noise({ dur: 0.16, gain: 0.12, type: 'lowpass', freq: 700, sweepTo: 200, delay: 0.01 });
        break;
      case 'bell':
        for (const [m, g] of [[1, 0.13], [2.76, 0.07], [5.4, 0.04]])
          this._tone({ freq: 660 * m, type: 'sine', dur: 2.2, gain: g });
        break;
      case 'wind':
        this._noise({ dur: 2.6, gain: 0.10, type: 'bandpass', freq: 500, q: 0.3, sweepTo: 1600, attack: 0.8 });
        break;
      case 'rain':
        this._noise({ dur: 2.4, gain: 0.11, type: 'highpass', freq: 3000, attack: 0.5 });
        break;
      case 'plague':
        this._tone({ freq: 90, type: 'sawtooth', dur: 1.8, gain: 0.10, cutoff: 400, glideTo: 55 });
        this._noise({ dur: 1.6, gain: 0.07, type: 'bandpass', freq: 300, q: 0.6, attack: 0.4 });
        break;
      case 'duel':
        this._tone({ freq: 1400, type: 'sine', dur: 0.5, gain: 0.09 });
        this._noise({ dur: 0.35, gain: 0.16, type: 'bandpass', freq: 4600, q: 2.4, sweepTo: 1200, delay: 0.05 });
        break;
      case 'debate':
        [440, 554, 659].forEach((f, i) => this._tone({ freq: f, type: 'triangle', dur: 0.30, gain: 0.08, delay: i * 0.08 }));
        break;
      default:
        this._tone({ freq: 700, type: 'sine', dur: 0.06, gain: 0.08 });
    }
  }
}

export const audio = new AudioEngine();
export { SCORES, SCORE_BY_ID };
