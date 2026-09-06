'use strict';
/* =====================================================================
 * music.js — 클래식 배경음악 재생 엔진 (외부 오디오 파일 없음)
 * ---------------------------------------------------------------------
 * 악보 데이터(MUSIC_TRACKS)는 musiclib*.js 에서 전역 배열로 들어옵니다.
 * 이 파일은 "연주기" 만 담당합니다.
 *
 *   Music.start()          셔플 재생 시작 (곡이 없으면 조용히 아무 일도 안 함)
 *   Music.stop()           페이드아웃 후 정지
 *   Music.next()           다음 곡으로 크로스페이드
 *   Music.pause() / Music.resume()
 *   Music.isPlaying()      bool
 *   Music.current()        { id, title, composer, mood } | null
 *   Music.onTrack = fn     곡이 실제로 시작되는 순간 호출되는 콜백
 *   Music.setIntensity(k)  0~1 전투 긴장도 (음량 / 음색 밝기 / 옥타브 보강)
 *
 * 구조:
 *   [노트 오실레이터] → [보이스 체인(게인·팬)] ─┬→ [플레이어 게인(크로스페이드)] → outDry → AudioCore.music()
 *                                              └→ [보내기] → [플레이어 웻] → outWet → AudioCore.reverbSend()
 *
 * 타이밍:
 *   setInterval(25ms) 로 깨어나 "지금 + 0.2초" 안에 시작하는 노트를 전부
 *   AudioContext 시각으로 미리 예약합니다. 렌더 프레임이 밀려도 박자는 밀리지 않습니다.
 * ===================================================================== */
const Music = (function () {

  /* ===================== 상수 ===================== */
  const TICK_MS    = 25;    // 스케줄러 주기(ms)
  const LOOKAHEAD  = 0.20;  // 미리 예약할 시간(초)
  const MAX_VOICES = 32;    // 동시 발음 상한
  const XFADE      = 1.5;   // 곡 전환 크로스페이드(초)
  const XFADE_MAN  = 1.0;   // 수동 next() 크로스페이드(초)
  const TARGET_SEC = 88;    // 곡당 목표 재생 길이(초) — 루프 반복 횟수 결정
  const MAX_PLAYERS = 3;    // 동시에 살아있는 트랙 플레이어 상한

  /* 악기별 기본값
   *   verb : 리버브 보내기 양 (건반/베이스는 적게, 패드/현/오르간은 많이)
   *   trim : 음량 보정 (합성 방식마다 소리 크기가 달라서 맞춰줌)
   *   gate : 표기 길이 대비 실제 발음 길이 (지속음은 거의 1, 타건음은 짧게) */
  const INST = {
    piano:   { verb: 0.11, trim: 0.72, gate: 0.94 },
    strings: { verb: 0.38, trim: 0.34, gate: 1.00 },
    flute:   { verb: 0.28, trim: 0.46, gate: 0.97 },
    pluck:   { verb: 0.18, trim: 0.60, gate: 0.95 },
    organ:   { verb: 0.42, trim: 0.30, gate: 1.00 },
    bell:    { verb: 0.46, trim: 0.40, gate: 1.00 },
    brass:   { verb: 0.24, trim: 0.33, gate: 0.96 },
    reed:    { verb: 0.22, trim: 0.34, gate: 0.97 },
    bass:    { verb: 0.07, trim: 0.70, gate: 0.92 },
    pad:     { verb: 0.55, trim: 0.22, gate: 1.00 },
    harp:    { verb: 0.34, trim: 0.52, gate: 0.98 },
    timpani: { verb: 0.40, trim: 0.70, gate: 1.00 },
  };

  /* 분위기별 음색 밝기 보정 */
  const MOOD_BRIGHT = { calm: 0.93, grand: 1.00, tense: 1.07, playful: 1.03, march: 1.02 };

  /* ===================== 상태 ===================== */
  let ctx = null;              // AudioContext (AudioCore 것)
  let outDry = null;           // 전체 드라이 출력 (음소거/일시정지/긴장도 음량)
  let outWet = null;           // 전체 리버브 보내기
  let timer = 0;               // setInterval 핸들

  let playing = false;         // 재생 중 (일시정지 포함)
  let paused = false;
  let intensity = 0;           // 0~1

  let compiled = [];           // 검증/정렬 끝난 트랙 목록
  let srcLen = -1;             // MUSIC_TRACKS 길이 캐시 (재컴파일 판단용)
  let queue = [];              // 셔플 대기열 (compiled 인덱스)

  let players = [];            // 활성 트랙 플레이어 (크로스페이드 중엔 2개)
  let notes = [];              // 활성 보이스 기록 (상한 관리용)
  let cur = null;              // 현재 곡 (announce 시점에 갱신)

  let killToken = 0;           // 지연 정리 취소용 토큰
  let pausedTrack = null, pausedBeat = 0, pausedLoops = 0;
  let wantStart = false, retryLeft = 0, retryTimer = 0;

  /* ===================== 작은 유틸 ===================== */
  function cl(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function rnd(a, b) { return a + Math.random() * (b - a); }

  /* ===================== 오디오 초기화 ===================== */
  function init() {
    if (ctx) return true;
    if (typeof AudioCore === 'undefined' || !AudioCore) return false;
    let c = null;
    try { c = AudioCore.ctx(); } catch (e) { c = null; }
    if (!c) return false;
    let mus = null, rv = null;
    try { mus = AudioCore.music(); rv = AudioCore.reverbSend(); } catch (e) { mus = null; }
    if (!mus) return false;

    ctx = c;
    outDry = ctx.createGain();
    outDry.gain.value = 0;
    outDry.connect(mus);
    outWet = ctx.createGain();
    outWet.gain.value = 0;
    if (rv) outWet.connect(rv);
    return true;
  }

  /** 전체 음량(드라이+웻)을 같은 곡선으로 램프 */
  function rampMaster(v, dur) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const gs = [outDry.gain, outWet.gain];
    for (let i = 0; i < gs.length; i++) {
      const g = gs[i];
      let held = false;
      if (g.cancelAndHoldAtTime) {
        try { g.cancelAndHoldAtTime(t); held = true; } catch (e) { held = false; }
      }
      if (!held) {
        try { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); } catch (e) { /* 구형 브라우저 */ }
      }
      g.linearRampToValueAtTime(v, t + Math.max(0.02, dur));
    }
  }

  /** 긴장도에 따른 전체 음량 */
  function masterLevel() { return 0.78 + 0.34 * intensity; }

  /* ===================== 트랙 컴파일 ===================== */
  /** MUSIC_TRACKS 를 읽어 검증/정렬. 아직 없으면 조용히 빈 목록. */
  function ensureTracks() {
    let src = null;
    try {
      if (typeof MUSIC_TRACKS !== 'undefined' && MUSIC_TRACKS && MUSIC_TRACKS.length) src = MUSIC_TRACKS;
    } catch (e) { src = null; }
    if (!src) {
      if (srcLen !== 0) { compiled = []; queue = []; srcLen = 0; }
      return;
    }
    if (src.length === srcLen) return;
    srcLen = src.length;
    const out = [];
    for (let i = 0; i < src.length; i++) {
      let t = null;
      try { t = compileTrack(src[i]); } catch (e) { t = null; }
      if (t) out.push(t);
    }
    compiled = out;
    queue = [];
  }

  /** 트랙 하나를 안전한 형태로 변환 (잘못된 값은 버림) */
  function compileTrack(t) {
    if (!t || typeof t !== 'object' || !t.voices || !t.voices.length) return null;
    const bpm = cl(num(t.bpm, 100), 30, 300);
    const voices = [];
    let maxEnd = 0;

    for (let i = 0; i < t.voices.length; i++) {
      const v = t.voices[i];
      if (!v || !v.notes || !v.notes.length) continue;
      const inst = (typeof v.inst === 'string' && INST[v.inst]) ? v.inst : 'piano';
      const ns = [];
      for (let j = 0; j < v.notes.length; j++) {
        const n = v.notes[j];
        if (!n || n.length < 3) continue;
        const st = num(n[0], -1), du = num(n[1], 0), mi = Math.round(num(n[2], -1));
        if (st < 0 || du <= 0 || mi < 12 || mi > 120) continue;
        const ve = cl(num(n[3], 0.8), 0.05, 1.4);
        ns.push([st, du, mi, ve]);
        if (st + du > maxEnd) maxEnd = st + du;
      }
      if (!ns.length) continue;
      ns.sort(function (a, b) { return a[0] - b[0]; });
      voices.push({
        name: String(v.name || ('voice' + i)),
        inst: inst,
        gain: cl(num(v.gain, 0.8), 0, 1.5),
        pan: cl(num(v.pan, 0), -1, 1),
        notes: ns,
      });
    }
    if (!voices.length) return null;

    let loopBeats = num(t.loopBeats, 0);
    if (loopBeats <= 0) loopBeats = Math.max(4, Math.ceil(maxEnd));
    const mood = (typeof t.mood === 'string' && MOOD_BRIGHT[t.mood]) ? t.mood : 'calm';

    return {
      id: String(t.id || ('track' + Math.floor(Math.random() * 1e6))),
      title: String(t.title || ''),
      composer: String(t.composer || ''),
      bpm: bpm, loopBeats: loopBeats, mood: mood,
      bright: MOOD_BRIGHT[mood],
      voices: voices,
    };
  }

  /* ===================== 셔플 ===================== */
  function reshuffle(exceptId) {
    queue = [];
    for (let i = 0; i < compiled.length; i++) queue.push(i);
    for (let i = queue.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const tmp = queue[i]; queue[i] = queue[j]; queue[j] = tmp;
    }
    // 같은 곡이 연속되지 않게 첫 곡을 뒤로 보냄
    if (queue.length > 1 && exceptId && compiled[queue[0]].id === exceptId) {
      const first = queue.shift();
      queue.push(first);
    }
  }

  /** 다음에 재생할 트랙 (같은 곡 연속 금지) */
  function pickNext(exceptId) {
    ensureTracks();
    if (!compiled.length) return null;
    if (compiled.length === 1) return compiled[0];
    if (!queue.length) reshuffle(exceptId);
    let t = compiled[queue.shift()];
    if (t && exceptId && t.id === exceptId) {
      // 대기열의 마지막 한 곡이 방금 나온 곡이면 새로 섞어서 다른 곡을 뽑는다
      if (!queue.length) reshuffle(exceptId);
      if (queue.length) {
        const back = compiled.indexOf(t);
        t = compiled[queue.shift()];
        if (back >= 0) queue.push(back);
      }
    }
    return t || null;
  }

  /* ===================== 보이스(노트) 관리 ===================== */
  function pruneNotes(now) {
    let w = 0;
    for (let i = 0; i < notes.length; i++) {
      const r = notes[i];
      if (r.end > now + 0.01) notes[w++] = r;
    }
    notes.length = w;
  }

  /** 상한 초과 시 가장 오래된 보이스부터 스틸 */
  function stealIfNeeded(now) {
    while (notes.length >= MAX_VOICES) {
      let best = -1, bt = Infinity;
      for (let i = 0; i < notes.length; i++) {
        const r = notes[i];
        if (r.killed) { best = i; break; }
        if (r.start < bt) { bt = r.start; best = i; }
      }
      if (best < 0) { notes.shift(); continue; }
      killNote(notes[best], now);
      notes.splice(best, 1);
    }
  }

  /** 노트를 즉시 급속 페이드아웃시키고 소스를 정지 */
  function killNote(rec, t) {
    if (rec.killed) return;
    rec.killed = true;
    const g = rec.gain.gain;
    let held = false;
    if (g.cancelAndHoldAtTime) {
      try { g.cancelAndHoldAtTime(t); held = true; } catch (e) { held = false; }
    }
    if (!held) {
      try { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); } catch (e) { /* 무시 */ }
    }
    try { g.linearRampToValueAtTime(0, t + 0.05); } catch (e) { /* 무시 */ }
    const st = t + 0.07;
    for (let i = 0; i < rec.srcs.length; i++) { try { rec.srcs[i].stop(st); } catch (e) { } }
    rec.end = st;
    // 시작 전 정지된 소스는 onended 가 안 올 수도 있어 보험용 정리 타이머를 건다
    setTimeout(function () { cleanup(rec); }, Math.max(80, (st - t) * 1000 + 160));
  }

  /** 노드 연결 해제 (누수 방지) */
  function cleanup(rec) {
    if (rec.cleaned) return;
    rec.cleaned = true;
    const ns = rec.nodes;
    for (let i = 0; i < ns.length; i++) { try { ns[i].disconnect(); } catch (e) { } }
    ns.length = 0;
    rec.srcs.length = 0;
  }

  /** 소스 일괄 start/stop + onended 정리 등록 */
  function finish(rec, stopT) {
    const t0 = rec.start;
    const end = Math.max(stopT, t0 + 0.05);
    for (let i = 0; i < rec.srcs.length; i++) {
      const s = rec.srcs[i];
      try { s.start(t0); } catch (e) { }
      try { s.stop(end); } catch (e) { }
    }
    rec.end = end;
    const main = rec.main || rec.srcs[0];
    if (main) main.onended = function () { cleanup(rec); };
    else cleanup(rec);
  }

  /* ===================== 노드 생성 헬퍼 ===================== */
  function mkOsc(rec, type, freq, detune) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = cl(freq, 8, 18000);
    if (detune) o.detune.value = detune;
    rec.srcs.push(o); rec.nodes.push(o);
    return o;
  }
  function mkGain(rec, v) {
    const g = ctx.createGain();
    g.gain.value = (v === undefined) ? 1 : v;
    rec.nodes.push(g);
    return g;
  }
  function mkFilter(rec, type, freq, q) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = cl(freq, 20, 20000);
    if (q !== undefined) f.Q.value = q;
    rec.nodes.push(f);
    return f;
  }
  function mkNoise(rec, dur) {
    let buf = null;
    try { buf = AudioCore.noise(Math.max(0.05, dur)); } catch (e) { buf = null; }
    if (!buf) return null;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    rec.srcs.push(s); rec.nodes.push(s);
    return s;
  }

  /** ADSR 엔벨로프. 반환값 = 소리가 완전히 끝나는 시각 */
  function adsr(par, when, off, a, d, s, r, peak) {
    const pk = Math.max(0.0006, peak);
    par.setValueAtTime(0.0001, when);
    par.linearRampToValueAtTime(pk, when + a);
    const dEnd = when + a + d;
    par.linearRampToValueAtTime(pk * s, dEnd);
    const offT = Math.max(off, dEnd + 0.01);
    par.setValueAtTime(pk * s, offT);
    par.linearRampToValueAtTime(0, offT + r);
    return offT + r + 0.02;
  }

  /** 타건 악기용 지수 감쇠 */
  function decay(par, when, peak, atk, dec) {
    const pk = Math.max(0.0006, peak);
    par.setValueAtTime(0.0001, when);
    par.exponentialRampToValueAtTime(pk, when + atk);
    par.exponentialRampToValueAtTime(0.0001, when + Math.max(atk + 0.03, dec));
  }

  /** 타건 악기의 댐퍼(건반을 떼면 잔향이 멎음). 반환 = 끝나는 시각 */
  function damper(rec, when, dur, dec, tail) {
    const g = rec.gain.gain;
    const offT = when + Math.max(0.06, dur);
    if (offT < when + dec) {
      g.setValueAtTime(1, when);
      g.setValueAtTime(1, offT);
      g.linearRampToValueAtTime(0, offT + tail);
      return offT + tail + 0.02;
    }
    return when + dec + 0.02;
  }

  /** 비브라토 LFO 를 만들어 여러 오실레이터의 detune 에 물린다 */
  function vibrato(rec, targets, when, rate, cents, delaySec) {
    if (!targets.length) return;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = rate;
    const amt = ctx.createGain();
    amt.gain.setValueAtTime(0.0001, when);
    amt.gain.linearRampToValueAtTime(cents, when + delaySec);
    lfo.connect(amt);
    for (let i = 0; i < targets.length; i++) amt.connect(targets[i].detune);
    rec.srcs.push(lfo); rec.nodes.push(lfo, amt);
  }

  /* ===================== 악기 합성 =====================
   * 각 함수는 rec.gain 에 소리를 연결하고, 소리가 끝나는 시각을 반환한다.
   * rec.gain 은 기본값 1 이며 타건 악기는 댐퍼로 사용한다.
   * ================================================== */

  /** 피아노 — 배음 5개 + 살짝 디튠된 복제 + 해머 노이즈 + 음역별 감쇠 */
  function synthPiano(rec, f, when, dur, amp, bright, midi) {
    const dec = cl(9.0 * Math.pow(2, -(midi - 36) / 20), 0.65, 6.5);
    const lp = mkFilter(rec, 'lowpass', cl(f * 9 + 1400, 1300, 11000) * bright, 0.4);
    lp.connect(rec.gain);

    const RAT = [1, 2.001, 3.004, 4.013, 5.03];
    const AMP = [1, 0.46, 0.25, 0.13, 0.07];
    const DEC = [1, 0.74, 0.55, 0.40, 0.30];
    for (let i = 0; i < RAT.length; i++) {
      const o = mkOsc(rec, i === 0 ? 'triangle' : 'sine', f * RAT[i], i === 0 ? -2 : 0);
      const g = mkGain(rec, 0);
      decay(g.gain, when, amp * AMP[i] * 0.36, 0.004 + i * 0.0012, dec * DEC[i]);
      o.connect(g); g.connect(lp);
      if (i === 0) rec.main = o;
    }
    // 아주 살짝 어긋난 복제음 — 실제 피아노의 복현(複弦) 맥놀이
    const o2 = mkOsc(rec, 'sine', f, 5.5);
    const g2 = mkGain(rec, 0);
    decay(g2.gain, when, amp * 0.26, 0.006, dec * 0.9);
    o2.connect(g2); g2.connect(lp);

    // 해머 타격음
    const nz = mkNoise(rec, 0.1);
    if (nz) {
      const bp = mkFilter(rec, 'bandpass', cl(f * 3.4, 200, 9000), 1.1);
      const ng = mkGain(rec, 0);
      decay(ng.gain, when, amp * 0.16, 0.002, 0.05);
      nz.connect(bp); bp.connect(ng); ng.connect(rec.gain);
    }
    return damper(rec, when, dur, dec, 0.17);
  }

  /** 현악 앙상블 — 톱니 3개 디튠 + 사인 보디 + 느린 어택 + 비브라토 */
  function synthStrings(rec, f, when, dur, amp, bright, midi, k) {
    const cutoff = cl((f * 4.6 + 900) * bright, 700, 6000);
    const lp = mkFilter(rec, 'lowpass', cutoff, 0.8);
    lp.connect(rec.gain);
    const a = Math.min(0.12, Math.max(0.035, dur * 0.3));
    const off = when + Math.max(0.08, dur);

    const DET = [-9, 1.5, 8.5];
    const oscs = [];
    for (let i = 0; i < DET.length; i++) {
      const o = mkOsc(rec, 'sawtooth', f, DET[i] + rnd(-1.5, 1.5));
      const g = mkGain(rec, 0.34);
      o.connect(g); g.connect(lp);
      oscs.push(o);
      if (i === 0) rec.main = o;
    }
    // 저역 보디 (앙상블의 두께)
    const ob = mkOsc(rec, 'sine', f, -3);
    const gb = mkGain(rec, 0.30);
    ob.connect(gb); gb.connect(lp);
    oscs.push(ob);

    // 긴장도가 높으면 옥타브 위를 보강해 날을 세운다
    if (k > 0.45) {
      const oh = mkOsc(rec, 'sawtooth', f * 2, 4);
      const gh = mkGain(rec, 0.13 * (k - 0.45) / 0.55);
      oh.connect(gh); gh.connect(lp);
      oscs.push(oh);
    }
    vibrato(rec, oscs, when, 5.1 + Math.random() * 0.5, 5.5, Math.min(0.45, a + 0.2));

    // 필터가 어택 동안 살짝 열림 (활이 현에 걸리는 느낌)
    lp.frequency.setValueAtTime(cutoff * 0.6, when);
    lp.frequency.linearRampToValueAtTime(cutoff, when + a + 0.1);

    return adsr(rec.gain.gain, when, off, a, 0.12, 0.87, 0.34, amp);
  }

  /** 플루트 — 사인 + 약한 2배음 + 숨소리 노이즈 + 늦게 걸리는 비브라토 */
  function synthFlute(rec, f, when, dur, amp, bright, midi) {
    const lp = mkFilter(rec, 'lowpass', cl(f * 5 + 1800, 900, 8000) * bright, 0.6);
    lp.connect(rec.gain);
    const o1 = mkOsc(rec, 'sine', f, 0);
    const g1 = mkGain(rec, 1);
    o1.connect(g1); g1.connect(lp);
    rec.main = o1;

    const o2 = mkOsc(rec, 'sine', f * 2, 3);
    const g2 = mkGain(rec, 0.13);
    o2.connect(g2); g2.connect(lp);

    const o3 = mkOsc(rec, 'triangle', f * 3, -4);
    const g3 = mkGain(rec, 0.05);
    o3.connect(g3); g3.connect(lp);

    const nz = mkNoise(rec, 0.4);
    if (nz) {
      nz.loop = true;                       // 숨소리는 음이 끝날 때까지 이어짐
      const bp = mkFilter(rec, 'bandpass', cl(f * 1.8, 200, 9000), 1.4);
      const ng = mkGain(rec, 0);
      const off0 = when + Math.max(0.08, dur);
      ng.gain.setValueAtTime(0.0001, when);
      ng.gain.linearRampToValueAtTime(amp * 0.10, when + 0.03);
      ng.gain.linearRampToValueAtTime(amp * 0.035, when + 0.16);
      ng.gain.setValueAtTime(amp * 0.035, off0);
      ng.gain.linearRampToValueAtTime(0, off0 + 0.1);
      nz.connect(bp); bp.connect(ng); ng.connect(rec.gain);
    }
    vibrato(rec, [o1, o2, o3], when, 5.4, 11, Math.min(0.6, Math.max(0.14, dur * 0.5)));

    const a = Math.min(0.07, Math.max(0.02, dur * 0.3));
    return adsr(rec.gain.gain, when, when + Math.max(0.08, dur), a, 0.08, 0.92, 0.13, amp);
  }

  /** 플럭 — 밝은 배음 + 빠른 필터 하강 + 픽 노이즈 */
  function synthPluck(rec, f, when, dur, amp, bright, midi) {
    const dec = cl(2.6 * Math.pow(2, -(midi - 48) / 26), 0.28, 2.4);
    const lp = mkFilter(rec, 'lowpass', 1000, 1.1);
    lp.frequency.setValueAtTime(cl(f * 10, 400, 12000) * bright, when);
    lp.frequency.exponentialRampToValueAtTime(cl(f * 2.6, 200, 8000) * bright, when + 0.32);
    lp.connect(rec.gain);

    const RAT = [1, 2, 3.01, 4.04, 5.1];
    const AMP = [1, 0.52, 0.28, 0.14, 0.07];
    for (let i = 0; i < RAT.length; i++) {
      const o = mkOsc(rec, i === 0 ? 'triangle' : 'sine', f * RAT[i], i === 1 ? 4 : 0);
      const g = mkGain(rec, 0);
      decay(g.gain, when, amp * AMP[i] * 0.5, 0.003, dec * (1 - i * 0.11));
      o.connect(g); g.connect(lp);
      if (i === 0) rec.main = o;
    }
    const nz = mkNoise(rec, 0.06);
    if (nz) {
      const bp = mkFilter(rec, 'bandpass', cl(f * 4.5, 300, 9000), 0.9);
      const ng = mkGain(rec, 0);
      decay(ng.gain, when, amp * 0.2, 0.002, 0.035);
      nz.connect(bp); bp.connect(ng); ng.connect(rec.gain);
    }
    return damper(rec, when, dur + 0.14, dec, 0.1);
  }

  /** 오르간 — 드로바 배음 스택 + 미세 디튠 코러스 + 은은한 트레몰로 */
  function synthOrgan(rec, f, when, dur, amp, bright, midi, k) {
    // 레슬리 느낌의 얕은 트레몰로 (배음 스택 → 로우패스 → 트레몰로 → 노트 게인)
    const trem = mkGain(rec, 1);
    trem.connect(rec.gain);
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 5.6;
    const lg = ctx.createGain();
    lg.gain.value = 0.06;
    lfo.connect(lg); lg.connect(trem.gain);
    rec.srcs.push(lfo); rec.nodes.push(lfo, lg);

    const lp = mkFilter(rec, 'lowpass', cl((f * 7 + 1800) * bright, 1200, 11000), 0.5);
    lp.connect(trem);
    const RAT = [1, 2, 3.001, 4, 6.01];
    const AMP = [1, 0.58, 0.30, 0.42, 0.14];
    for (let i = 0; i < RAT.length; i++) {
      const o = mkOsc(rec, 'sine', f * RAT[i], (i === 2 || i === 4) ? 6 : 0);
      const g = mkGain(rec, AMP[i] * 0.32);
      o.connect(g); g.connect(lp);
      if (i === 0) rec.main = o;
    }
    if (k > 0.45) { // 긴장도 — 슈퍼옥타브 보강
      const oh = mkOsc(rec, 'sine', f * 8, -5);
      const gh = mkGain(rec, 0.09 * (k - 0.45) / 0.55);
      oh.connect(gh); gh.connect(lp);
    }
    return adsr(rec.gain.gain, when, when + Math.max(0.07, dur), 0.018, 0.05, 0.95, 0.09, amp);
  }

  /** 벨 — FM(비정수 배음비) + 긴 감쇠 + 저역 험 */
  function synthBell(rec, f, when, dur, amp, bright, midi) {
    const dec = cl(5.0 * Math.pow(2, -(midi - 60) / 26), 0.9, 5.2);
    const lp = mkFilter(rec, 'lowpass', cl(f * 8 + 2200, 1500, 12000) * bright, 0.5);
    lp.connect(rec.gain);

    const car = mkOsc(rec, 'sine', f, 0);
    rec.main = car;
    const cg = mkGain(rec, 0);
    decay(cg.gain, when, amp * 0.5, 0.003, dec);
    car.connect(cg); cg.connect(lp);

    // FM 모듈레이터 — 인덱스가 빠르게 줄어 금속성 어택을 만든다
    const mod = mkOsc(rec, 'sine', f * 1.41, 0);
    const mg = mkGain(rec, 0);
    mg.gain.setValueAtTime(f * 3.4 * amp, when);
    mg.gain.exponentialRampToValueAtTime(f * 0.02, when + Math.min(0.9, dec * 0.35));
    mod.connect(mg); mg.connect(car.frequency);

    // 비정수 부분음
    const P = [[2.76, 0.34, 0.55], [5.40, 0.13, 0.32], [0.5, 0.22, 1.15]];
    for (let i = 0; i < P.length; i++) {
      const o = mkOsc(rec, 'sine', f * P[i][0], rnd(-4, 4));
      const g = mkGain(rec, 0);
      decay(g.gain, when, amp * P[i][1] * 0.5, 0.004, dec * P[i][2]);
      o.connect(g); g.connect(lp);
    }
    // 벨은 손으로 막지 않으면 계속 울린다 (표기 길이 + 여운)
    const end = Math.min(when + dec, when + dur + 2.6);
    const g = rec.gain.gain;
    g.setValueAtTime(1, when);
    g.setValueAtTime(1, Math.max(when + 0.05, end - 0.2));
    g.linearRampToValueAtTime(0, end + 0.06);
    return end + 0.08;
  }

  /** 금관 — 톱니 2개 + 상승하는 필터 엔벨로프 + 살짝의 스퀘어 바이트 */
  function synthBrass(rec, f, when, dur, amp, bright, midi, k) {
    const base = cl(f * 1.3, 60, 3000);
    const top = cl(f * 7.5, 500, 11000) * bright;
    const lp = mkFilter(rec, 'lowpass', base, 3.4);
    lp.connect(rec.gain);
    const a = Math.min(0.06, Math.max(0.018, dur * 0.28));
    lp.frequency.setValueAtTime(base, when);
    lp.frequency.linearRampToValueAtTime(top, when + a + 0.05);
    lp.frequency.linearRampToValueAtTime(cl(f * 4.6, 400, 9000) * bright, when + a + 0.35);

    const oscs = [];
    const o1 = mkOsc(rec, 'sawtooth', f, -6); rec.main = o1;
    const g1 = mkGain(rec, 0.5); o1.connect(g1); g1.connect(lp); oscs.push(o1);
    const o2 = mkOsc(rec, 'sawtooth', f, 7);
    const g2 = mkGain(rec, 0.42); o2.connect(g2); g2.connect(lp); oscs.push(o2);
    const o3 = mkOsc(rec, 'square', f, 0);
    const g3 = mkGain(rec, 0.14); o3.connect(g3); g3.connect(lp); oscs.push(o3);
    if (k > 0.45) {
      const oh = mkOsc(rec, 'sawtooth', f * 2, 3);
      const gh = mkGain(rec, 0.16 * (k - 0.45) / 0.55);
      oh.connect(gh); gh.connect(lp); oscs.push(oh);
    }
    if (dur > 0.8) vibrato(rec, oscs, when, 5.3, 6, Math.min(1.0, dur * 0.55));

    const par = rec.gain.gain;
    const pk = Math.max(0.0006, amp);
    par.setValueAtTime(0.0001, when);
    par.linearRampToValueAtTime(pk * 1.08, when + a);       // 살짝의 오버슛
    par.linearRampToValueAtTime(pk * 0.86, when + a + 0.13);
    const off = Math.max(when + Math.max(0.09, dur), when + a + 0.16);
    par.setValueAtTime(pk * 0.86, off);
    par.linearRampToValueAtTime(0, off + 0.15);
    return off + 0.17;
  }

  /** 목관(리드) — 사각파 + 로우패스 + 코 소리를 내는 피킹 필터 */
  function synthReed(rec, f, when, dur, amp, bright, midi) {
    const pk = mkFilter(rec, 'peaking', cl(f * 3, 200, 9000), 1.6);
    pk.gain.value = 8;
    const lp = mkFilter(rec, 'lowpass', cl(f * 3.6 + 600, 500, 7000) * bright, 1.4);
    lp.connect(pk); pk.connect(rec.gain);

    // 리드는 독주 악기라 복제음을 얇게 — 맥놀이가 심하면 음정이 흔들려 들린다
    const o1 = mkOsc(rec, 'square', f, -2); rec.main = o1;
    const g1 = mkGain(rec, 0.54); o1.connect(g1); g1.connect(lp);
    const o2 = mkOsc(rec, 'square', f, 3);
    const g2 = mkGain(rec, 0.16); o2.connect(g2); g2.connect(lp);
    const o3 = mkOsc(rec, 'sine', f * 2, 0);
    const g3 = mkGain(rec, 0.12); o3.connect(g3); g3.connect(lp);
    if (dur > 0.6) vibrato(rec, [o1, o2, o3], when, 5.0, 7, Math.min(0.8, dur * 0.5));

    const a = Math.min(0.035, Math.max(0.012, dur * 0.25));
    return adsr(rec.gain.gain, when, when + Math.max(0.08, dur), a, 0.09, 0.90, 0.12, amp);
  }

  /** 베이스 — 사인/삼각 저역 + 정의감을 주는 2배음 + 어택 클릭 */
  function synthBass(rec, f, when, dur, amp, bright, midi) {
    const lp = mkFilter(rec, 'lowpass', cl(f * 6 + 200, 180, 1600) * (0.9 + 0.35 * intensity), 0.9);
    lp.connect(rec.gain);

    const o1 = mkOsc(rec, 'sine', f, 0); rec.main = o1;
    o1.frequency.setValueAtTime(f * 1.03, when);
    o1.frequency.exponentialRampToValueAtTime(f, when + 0.035);
    const g1 = mkGain(rec, 0.9); o1.connect(g1); g1.connect(lp);

    const o2 = mkOsc(rec, 'triangle', f, 4);
    const g2 = mkGain(rec, 0.42); o2.connect(g2); g2.connect(lp);

    const o3 = mkOsc(rec, 'sawtooth', f * 2, -3);
    const g3 = mkGain(rec, 0.13); o3.connect(g3); g3.connect(lp);

    const nz = mkNoise(rec, 0.06);
    if (nz) {
      const hp = mkFilter(rec, 'highpass', 1100, 0.7);
      const ng = mkGain(rec, 0);
      decay(ng.gain, when, amp * 0.09, 0.002, 0.03);
      nz.connect(hp); hp.connect(ng); ng.connect(rec.gain);
    }
    const a = Math.min(0.016, Math.max(0.006, dur * 0.2));
    return adsr(rec.gain.gain, when, when + Math.max(0.07, dur), a, 0.13, 0.82, 0.1, amp);
  }

  /** 패드 — 톱니 4개 디튠 + 서브 + 아주 느린 어택 + 필터 LFO */
  function synthPad(rec, f, when, dur, amp, bright, midi) {
    const lp = mkFilter(rec, 'lowpass', cl(f * 3 + 550, 400, 3000) * bright, 0.7);
    lp.connect(rec.gain);
    const DET = [-14, -5, 6, 13];
    for (let i = 0; i < DET.length; i++) {
      const o = mkOsc(rec, 'sawtooth', f, DET[i] + rnd(-2, 2));
      const g = mkGain(rec, 0.24);
      o.connect(g); g.connect(lp);
      if (i === 0) rec.main = o;
    }
    const sub = mkOsc(rec, 'sine', f * 0.5, 0);
    const sg = mkGain(rec, 0.3); sub.connect(sg); sg.connect(lp);

    // 아주 느린 필터 흔들림
    const lfo = ctx.createOscillator();
    lfo.type = 'sine'; lfo.frequency.value = 0.16 + Math.random() * 0.1;
    const lg = ctx.createGain(); lg.gain.value = cl(f * 0.9, 60, 700);
    lfo.connect(lg); lg.connect(lp.frequency);
    rec.srcs.push(lfo); rec.nodes.push(lfo, lg);

    const a = Math.min(1.1, Math.max(0.25, dur * 0.45));
    return adsr(rec.gain.gain, when, when + Math.max(0.2, dur), a, 0.3, 0.85, 0.9, amp);
  }

  /** 하프 — 밝은 배음 다수 + 아주 빠른 어택 + 긴 여운 */
  function synthHarp(rec, f, when, dur, amp, bright, midi) {
    const dec = cl(4.2 * Math.pow(2, -(midi - 48) / 26), 0.5, 4.0);
    const hp = mkFilter(rec, 'highpass', 90, 0.6);
    const lp = mkFilter(rec, 'lowpass', cl(f * 11 + 2200, 1800, 13000) * bright, 0.4);
    hp.connect(lp); lp.connect(rec.gain);

    const RAT = [1, 2, 3, 4.02, 5.05, 6.1];
    const AMP = [1, 0.5, 0.3, 0.17, 0.09, 0.05];
    for (let i = 0; i < RAT.length; i++) {
      const o = mkOsc(rec, 'sine', f * RAT[i], i === 1 ? 3 : 0);
      const g = mkGain(rec, 0);
      decay(g.gain, when, amp * AMP[i] * 0.46, 0.004, dec * (1 - i * 0.09));
      o.connect(g); g.connect(hp);
      if (i === 0) rec.main = o;
    }
    const nz = mkNoise(rec, 0.06);
    if (nz) {
      const bp = mkFilter(rec, 'bandpass', cl(f * 5, 300, 10000), 1.2);
      const ng = mkGain(rec, 0);
      decay(ng.gain, when, amp * 0.12, 0.002, 0.03);
      nz.connect(bp); bp.connect(ng); ng.connect(rec.gain);
    }
    return damper(rec, when, dur + 0.45, dec, 0.22);
  }

  /** 팀파니 — 피치 드롭 사인 + 막 진동 모드 + 말렛 노이즈 */
  function synthTimpani(rec, f, when, dur, amp, bright, midi, k) {
    const dec = cl(2.4 + (60 - midi) * 0.035, 0.9, 3.2);
    const lp = mkFilter(rec, 'lowpass', cl(f * 9 + 300, 220, 2600) * (0.9 + 0.4 * k), 0.8);
    lp.connect(rec.gain);
    const boost = 1 + 0.25 * k;

    const o1 = mkOsc(rec, 'sine', f, 0); rec.main = o1;
    o1.frequency.setValueAtTime(f * 1.6, when);
    o1.frequency.exponentialRampToValueAtTime(f, when + 0.055);
    const g1 = mkGain(rec, 0);
    decay(g1.gain, when, amp * 0.9 * boost, 0.004, dec);
    o1.connect(g1); g1.connect(lp);

    const MODE = [[1.5, 0.26, 0.5], [1.99, 0.15, 0.34], [2.44, 0.08, 0.22]];
    for (let i = 0; i < MODE.length; i++) {
      const o = mkOsc(rec, 'sine', f * MODE[i][0], rnd(-6, 6));
      const g = mkGain(rec, 0);
      decay(g.gain, when, amp * MODE[i][1] * boost, 0.004, dec * MODE[i][2]);
      o.connect(g); g.connect(lp);
    }
    const nz = mkNoise(rec, 0.15);
    if (nz) {
      const bp = mkFilter(rec, 'lowpass', 1100, 0.9);
      const ng = mkGain(rec, 0);
      decay(ng.gain, when, amp * 0.4 * boost, 0.002, 0.09);
      nz.connect(bp); bp.connect(ng); ng.connect(rec.gain);
    }
    const end = Math.min(when + dec, when + dur + 1.8);
    const g = rec.gain.gain;
    g.setValueAtTime(1, when);
    g.setValueAtTime(1, Math.max(when + 0.05, end - 0.15));
    g.linearRampToValueAtTime(0, end + 0.05);
    return end + 0.07;
  }

  /* ===================== 노트 예약 ===================== */
  function playNote(p, chain, inst, when, dur, midi, vel) {
    const now = ctx.currentTime;
    stealIfNeeded(now);

    const spec = INST[inst] || INST.piano;
    const f = mtof(midi);
    const bright = (0.82 + 0.46 * intensity) * p.track.bright;
    const amp = cl(vel * spec.trim, 0.002, 1.6);

    const g = ctx.createGain();
    g.gain.value = 1;
    g.connect(chain.in);

    const rec = {
      start: when, end: when + dur + 1, gain: g, srcs: [], nodes: [g],
      main: null, killed: false, cleaned: false, pl: p,
    };

    let stopT;
    try {
      switch (inst) {
        case 'strings': stopT = synthStrings(rec, f, when, dur, amp, bright, midi, intensity); break;
        case 'flute':   stopT = synthFlute(rec, f, when, dur, amp, bright, midi); break;
        case 'pluck':   stopT = synthPluck(rec, f, when, dur, amp, bright, midi); break;
        case 'organ':   stopT = synthOrgan(rec, f, when, dur, amp, bright, midi, intensity); break;
        case 'bell':    stopT = synthBell(rec, f, when, dur, amp, bright, midi); break;
        case 'brass':   stopT = synthBrass(rec, f, when, dur, amp, bright, midi, intensity); break;
        case 'reed':    stopT = synthReed(rec, f, when, dur, amp, bright, midi); break;
        case 'bass':    stopT = synthBass(rec, f, when, dur, amp, bright, midi); break;
        case 'pad':     stopT = synthPad(rec, f, when, dur, amp, bright, midi); break;
        case 'harp':    stopT = synthHarp(rec, f, when, dur, amp, bright, midi); break;
        case 'timpani': stopT = synthTimpani(rec, f, when, dur, amp, bright, midi, intensity); break;
        default:        stopT = synthPiano(rec, f, when, dur, amp, bright, midi); break;
      }
    } catch (e) {
      cleanup(rec);
      return;
    }
    if (!isFinite(stopT)) stopT = when + dur + 0.3;
    finish(rec, stopT);
    notes.push(rec);
  }

  /* ===================== 트랙 플레이어 ===================== */
  function buildChain(p, v) {
    const spec = INST[v.inst] || INST.piano;
    const inG = ctx.createGain();
    inG.gain.value = v.gain;
    const nodes = [inG];
    let tail = inG;
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = v.pan;
      inG.connect(pan);
      nodes.push(pan);
      tail = pan;
    }
    tail.connect(p.gain);
    const send = ctx.createGain();
    send.gain.value = spec.verb;
    tail.connect(send);
    send.connect(p.wet);
    nodes.push(send);
    return { in: inG, nodes: nodes };
  }

  function createPlayer(track) {
    const p = {
      track: track,
      spb: 60 / track.bpm,
      loopStart: 0,
      scan: 0,
      loops: 0,
      totalLoops: 2,
      idx: [],
      chains: [],
      gain: ctx.createGain(),
      wet: ctx.createGain(),
      silentAfter: 0,
      stopAt: 0,
      queued: false,
      dead: false,
    };
    p.gain.gain.value = 0;
    p.wet.gain.value = 0;
    p.gain.connect(outDry);
    p.wet.connect(outWet);
    for (let i = 0; i < track.voices.length; i++) {
      p.idx.push(0);
      p.chains.push(buildChain(p, track.voices[i]));
    }
    return p;
  }

  function destroyPlayer(p) {
    const t = ctx ? ctx.currentTime : 0;
    for (let i = notes.length - 1; i >= 0; i--) {
      if (notes[i].pl === p) { killNote(notes[i], t); notes.splice(i, 1); }
    }
    for (let i = 0; i < p.chains.length; i++) {
      const ns = p.chains[i].nodes;
      for (let j = 0; j < ns.length; j++) { try { ns[j].disconnect(); } catch (e) { } }
    }
    try { p.gain.disconnect(); } catch (e) { }
    try { p.wet.disconnect(); } catch (e) { }
    p.chains.length = 0;
  }

  /** 루프 안 beat 위치로 각 성부의 노트 포인터를 맞춘다 */
  function seekIdx(p, beat) {
    const vs = p.track.voices;
    for (let i = 0; i < vs.length; i++) {
      const ns = vs[i].notes;
      let lo = 0, hi = ns.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ns[mid][0] < beat) lo = mid + 1; else hi = mid;
      }
      p.idx[i] = lo;
    }
  }

  function startPlayer(track, at, fadeIn, beatOffset) {
    if (!track || !ctx) return null;
    const p = createPlayer(track);
    const bo = cl(num(beatOffset, 0), 0, Math.max(0, track.loopBeats - 0.001));
    p.loopStart = at - bo * p.spb;
    p.scan = bo;
    seekIdx(p, bo);

    const loopSec = track.loopBeats * p.spb;
    p.totalLoops = cl(Math.round(TARGET_SEC / Math.max(6, loopSec)), 1, 8);
    if (loopSec < 34 && p.totalLoops < 2) p.totalLoops = 2;

    const gd = p.gain.gain, gw = p.wet.gain;
    if (fadeIn > 0.02) {
      gd.setValueAtTime(0.0001, at); gd.linearRampToValueAtTime(1, at + fadeIn);
      gw.setValueAtTime(0.0001, at); gw.linearRampToValueAtTime(1, at + fadeIn);
    } else {
      gd.setValueAtTime(1, at);
      gw.setValueAtTime(1, at);
    }
    players.push(p);
    while (players.length > MAX_PLAYERS) {
      const old = players.shift();
      destroyPlayer(old);
    }
    announce(track, at);
    return p;
  }

  function fadePlayerOut(p, at, dur) {
    p.queued = true;
    p.silentAfter = at + dur;
    p.stopAt = at + dur + 0.35;
    const gs = [p.gain.gain, p.wet.gain];
    for (let i = 0; i < gs.length; i++) {
      const g = gs[i];
      let held = false;
      if (g.cancelAndHoldAtTime) {
        // at 시점의 값을 그대로 유지한 채 이후 예약만 취소 (페이드인 중이어도 자연스럽게 이어짐)
        try { g.cancelAndHoldAtTime(at); held = true; } catch (e) { held = false; }
      }
      if (!held) {
        try { g.cancelScheduledValues(at); g.setValueAtTime(g.value, at); } catch (e) { }
      }
      g.linearRampToValueAtTime(0, at + dur);
    }
  }

  /** 곡이 실제로 시작하는 시각에 맞춰 콜백/현재곡 갱신 */
  function announce(track, at) {
    const delay = Math.max(0, (at - ctx.currentTime) * 1000);
    setTimeout(function () {
      if (!playing) return;
      const same = (cur === track);
      cur = track;
      if (same) return;                 // 같은 곡의 재개/반복은 알리지 않음
      const fn = API.onTrack;
      if (typeof fn === 'function') {
        try { fn({ id: track.id, title: track.title, composer: track.composer, mood: track.mood }); }
        catch (e) { /* 콜백 오류가 재생을 막지 않게 */ }
      }
    }, delay);
  }

  /** 가장 최근에 시작한(=페이드아웃 중이 아닌) 플레이어 */
  function topPlayer() {
    for (let i = players.length - 1; i >= 0; i--) if (!players[i].queued) return players[i];
    return players.length ? players[players.length - 1] : null;
  }

  function nextBeatTime(p, from) {
    const b = Math.ceil((from - p.loopStart) / p.spb - 1e-6);
    return p.loopStart + b * p.spb;
  }

  /* ===================== 스케줄러 ===================== */
  function startTimer() {
    if (timer) return;
    timer = setInterval(tick, TICK_MS);
  }
  function stopTimer() {
    if (!timer) return;
    clearInterval(timer);
    timer = 0;
  }

  function tick() {
    if (!ctx) return;
    const now = ctx.currentTime;
    pruneNotes(now);

    for (let i = players.length - 1; i >= 0; i--) {
      const p = players[i];
      try { advance(p, now); } catch (e) { p.dead = true; }
      if (p.dead || (p.stopAt && now > p.stopAt)) {
        destroyPlayer(p);
        players.splice(i, 1);
      }
    }
    // 재생 중인데 남은 플레이어가 없으면 다음 곡을 이어붙인다
    if (playing && !paused && !players.length) {
      const t = pickNext(cur ? cur.id : null);
      if (t) startPlayer(t, now + 0.08, 0.8, 0);
      else { playing = false; cur = null; stopTimer(); }
    }
    if (!playing && !players.length && !notes.length) stopTimer();
  }

  /** 한 플레이어를 now+LOOKAHEAD 까지 예약 */
  function advance(p, now) {
    const T = p.track, spb = p.spb;
    const loopSec = T.loopBeats * spb;
    const horizon = now + LOOKAHEAD;

    // 탭이 멈췄다 돌아온 경우 등 — 현재 시각으로 재동기화 (박자 밀림 방지)
    if (now - (p.loopStart + loopSec) > 0.5) {
      const skipped = Math.floor((now - p.loopStart) / loopSec);
      if (skipped > 0) {
        p.loops += skipped;
        p.loopStart += skipped * loopSec;
        p.scan = cl((now - p.loopStart) / spb, 0, T.loopBeats);
        seekIdx(p, p.scan);
      }
    }

    let guard = 0;
    while (guard++ < 16) {
      const endBeat = Math.min(T.loopBeats, (horizon - p.loopStart) / spb);
      if (endBeat > p.scan) {
        scheduleRange(p, p.scan, endBeat);
        p.scan = endBeat;
      }
      if (p.scan < T.loopBeats - 1e-9) break;

      // 루프 한 바퀴 완주
      const loopEnd = p.loopStart + loopSec;
      p.loops++;
      p.loopStart = loopEnd;
      p.scan = 0;
      for (let i = 0; i < p.idx.length; i++) p.idx[i] = 0;

      if (!p.queued && p.loops >= p.totalLoops) {
        queueTransition(p, loopEnd);
        if (p.queued) break;
      }
    }
  }

  function scheduleRange(p, b0, b1) {
    const T = p.track, base = p.loopStart, spb = p.spb;
    for (let vi = 0; vi < T.voices.length; vi++) {
      const V = T.voices[vi];
      const chain = p.chains[vi];
      if (!chain) continue;
      const ns = V.notes;
      const gate = (INST[V.inst] || INST.piano).gate;
      let i = p.idx[vi];
      while (i < ns.length) {
        const n = ns[i];
        if (n[0] >= b1) break;
        if (n[0] >= b0 - 1e-9) {
          const when = base + n[0] * spb;
          if (!p.silentAfter || when <= p.silentAfter) {
            const dur = Math.max(0.05, n[1] * spb * gate);
            playNote(p, chain, V.inst, when, dur, n[2], n[3]);
          }
        }
        i++;
      }
      p.idx[vi] = i;
    }
  }

  /** 곡 끝 — 1.5초 크로스페이드로 다음 곡 */
  function queueTransition(p, at) {
    if (!playing || paused) { p.totalLoops += 2; return; }
    ensureTracks();
    if (compiled.length <= 1) {
      // 곡이 하나뿐이면 그대로 계속 반복
      p.totalLoops += Math.max(2, p.totalLoops);
      return;
    }
    const nt = pickNext(p.track.id);
    if (!nt) { p.totalLoops += 2; return; }
    fadePlayerOut(p, at, XFADE);
    startPlayer(nt, at, XFADE, 0);
  }

  /* ===================== 전체 정리 ===================== */
  function killAll() {
    const t = ctx ? ctx.currentTime : 0;
    for (let i = 0; i < notes.length; i++) killNote(notes[i], t);
    notes.length = 0;
    for (let i = 0; i < players.length; i++) destroyPlayer(players[i]);
    players.length = 0;
  }

  /** 지연 정리 예약 (중간에 다른 조작이 오면 토큰으로 취소됨) */
  function deferKill(ms) {
    const tk = ++killToken;
    setTimeout(function () {
      if (tk !== killToken) return;
      killAll();
      stopTimer();
    }, ms);
  }

  /* ===================== 곡 없을 때 재시도 ===================== */
  function scheduleRetry() {
    if (retryTimer || retryLeft <= 0) return;
    retryTimer = setTimeout(function () {
      retryTimer = 0;
      retryLeft--;
      if (wantStart && !playing) API.start();
    }, 400);
  }

  /* ===================== 공개 API ===================== */
  const API = {
    /** 곡이 바뀔 때 호출되는 콜백 (외부에서 대입) */
    onTrack: null,

    /** 셔플 재생 시작. 사용자 제스처 이후에 호출할 것. */
    start: function () {
      ensureTracks();
      if (!compiled.length) {           // 아직 곡 데이터가 없으면 조용히 대기
        wantStart = true;
        if (retryLeft <= 0) retryLeft = 12;
        scheduleRetry();
        return false;
      }
      if (typeof AudioCore !== 'undefined' && AudioCore) {
        try { AudioCore.resume(); } catch (e) { }
      }
      if (!init()) return false;
      if (playing && !paused) return true;
      if (playing && paused) return API.resume();

      killToken++;                      // 예약된 지연 정리 취소
      killAll();
      playing = true; paused = false; wantStart = false; retryLeft = 0;
      pausedTrack = null; pausedBeat = 0; pausedLoops = 0;
      rampMaster(masterLevel(), 0.5);
      const t = pickNext(cur ? cur.id : null);
      if (!t) { playing = false; return false; }
      startPlayer(t, ctx.currentTime + 0.08, 0.9, 0);
      startTimer();
      return true;
    },

    /** 페이드아웃 후 정지 */
    stop: function () {
      wantStart = false; retryLeft = 0;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = 0; }
      if (!ctx) { playing = false; paused = false; cur = null; return; }
      playing = false; paused = false; cur = null;
      pausedTrack = null;
      rampMaster(0, 1.0);
      deferKill(1200);
    },

    /** 다음 곡으로 크로스페이드 */
    next: function () {
      if (!ctx || !playing || paused) return false;
      ensureTracks();
      if (!compiled.length) return false;
      const now = ctx.currentTime;
      const p = topPlayer();
      const at = p ? Math.max(now + 0.05, nextBeatTime(p, now + 0.05)) : now + 0.05;
      const t = pickNext(p ? p.track.id : (cur ? cur.id : null));
      if (!t) return false;
      if (p) fadePlayerOut(p, at, XFADE_MAN);
      startPlayer(t, at, XFADE_MAN, 0);
      startTimer();
      return true;
    },

    /** 일시정지 (재생 위치 기억) */
    pause: function () {
      if (!ctx || !playing || paused) return;
      paused = true;
      const p = topPlayer();
      if (p) {
        pausedTrack = p.track;
        pausedBeat = cl((ctx.currentTime - p.loopStart) / p.spb, 0, p.track.loopBeats - 0.001);
        pausedLoops = p.loops;
      }
      rampMaster(0, 0.3);
      deferKill(420);
    },

    /** 일시정지 해제 (기억한 위치에서 이어서) */
    resume: function () {
      if (!playing) return API.start();
      if (!paused) return true;
      if (typeof AudioCore !== 'undefined' && AudioCore) {
        try { AudioCore.resume(); } catch (e) { }
      }
      if (!init()) return false;
      killToken++;
      killAll();
      paused = false;
      const t = pausedTrack || pickNext(cur ? cur.id : null);
      if (!t) { playing = false; return false; }
      const p = startPlayer(t, ctx.currentTime + 0.06, 0.4, pausedBeat);
      if (p) p.loops = pausedLoops;
      rampMaster(masterLevel(), 0.35);
      startTimer();
      return true;
    },

    /** 재생 중인가 (일시정지는 false) */
    isPlaying: function () { return playing && !paused; },

    /** 현재 곡 정보 */
    current: function () {
      if (!cur) return null;
      return { id: cur.id, title: cur.title, composer: cur.composer, mood: cur.mood };
    },

    /**
     * 전투 긴장도 0~1.
     * 템포는 그대로 두고 음량·음색 밝기·옥타브 보강·타악 세기로 긴장감을 만든다.
     */
    setIntensity: function (k) {
      const v = cl(num(k, 0), 0, 1);
      if (Math.abs(v - intensity) < 0.005) return;
      intensity = v;
      if (ctx && playing && !paused) rampMaster(masterLevel(), 0.6);
    },
    intensity: function () { return intensity; },

    /** 특정 곡을 바로 재생 (id). 없으면 false */
    playTrack: function (id) {
      ensureTracks();
      if (!compiled.length) return false;
      let t = null;
      for (let i = 0; i < compiled.length; i++) if (compiled[i].id === id) { t = compiled[i]; break; }
      if (!t) return false;
      if (!playing || paused) {
        if (!API.start()) return false;
      }
      if (!ctx) return false;
      const now = ctx.currentTime;
      const p = topPlayer();
      const at = p ? Math.max(now + 0.05, nextBeatTime(p, now + 0.05)) : now + 0.05;
      if (p) fadePlayerOut(p, at, XFADE_MAN);
      startPlayer(t, at, XFADE_MAN, 0);
      startTimer();
      return true;
    },

    /** 재생 목록 (메뉴/디버그용) */
    list: function () {
      ensureTracks();
      const out = [];
      for (let i = 0; i < compiled.length; i++) {
        const t = compiled[i];
        out.push({ id: t.id, title: t.title, composer: t.composer, mood: t.mood, bpm: t.bpm });
      }
      return out;
    },

    /** 현재 울리고 있는 보이스 수 (디버그) */
    voiceCount: function () { return notes.length; },
  };

  return API;
})();
