'use strict';
/* audiocore.js — 공용 오디오 컨텍스트 / 버스 / 리버브
 * Sfx(효과음)와 Music(배경음악)이 이 위에서 동작합니다. 외부 오디오 파일 없음.
 *
 * 버스 구조:
 *   sfxBus  ─┐
 *   musicBus ─┼→ master → compressor → destination
 *   reverb  ─┘
 */
const AudioCore = (() => {
  let ctx = null;
  let master = null, comp = null, sfxBus = null, musicBus = null, verb = null, verbIn = null;
  let sfxVol = 0.85, musicVol = 0.4, muted = false;
  const noiseCache = new Map();

  function build() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { return null; }

    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 22;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.22;
    comp.connect(ctx.destination);

    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(comp);

    sfxBus = ctx.createGain();
    sfxBus.gain.value = sfxVol;
    sfxBus.connect(master);

    musicBus = ctx.createGain();
    musicBus.gain.value = musicVol;
    musicBus.connect(master);

    // 공용 리버브 (합성 임펄스)
    verb = ctx.createConvolver();
    verb.buffer = impulse(2.6, 2.4);
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.9;
    verb.connect(verbOut).connect(master);
    verbIn = ctx.createGain();
    verbIn.gain.value = 1;
    verbIn.connect(verb);

    return ctx;
  }

  /** 지수 감쇠 스테레오 임펄스 응답 */
  function impulse(dur, decay) {
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) {
        const t = i / n;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (1 - t * 0.2);
      }
    }
    return buf;
  }

  /** 화이트 노이즈 버퍼 (길이별 캐시) */
  function noise(dur) {
    const key = Math.round(dur * 20) / 20;
    if (noiseCache.has(key)) return noiseCache.get(key);
    if (!build()) return null;
    const n = Math.max(64, Math.floor(ctx.sampleRate * key));
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(key, buf);
    return buf;
  }

  return {
    /** AudioContext (없으면 null) */
    ctx() { return build(); },
    /** 사용자 제스처 이후 호출 — 브라우저 자동재생 정책 해제 */
    resume() {
      const c = build();
      if (c && c.state === 'suspended') c.resume().catch(() => {});
      return c;
    },
    ready() { return !!ctx && ctx.state === 'running'; },
    now() { const c = build(); return c ? c.currentTime : 0; },
    /** 효과음 버스 (GainNode) */
    sfx() { build(); return sfxBus; },
    /** 음악 버스 (GainNode) */
    music() { build(); return musicBus; },
    /** 리버브 입력 (여기로 보내면 잔향이 걸림) */
    reverbSend() { build(); return verbIn; },
    noise,
    setSfxVolume(v) { sfxVol = Math.max(0, Math.min(1, v)); if (sfxBus) sfxBus.gain.value = sfxVol; },
    setMusicVolume(v) { musicVol = Math.max(0, Math.min(1, v)); if (musicBus) musicBus.gain.value = musicVol; },
    sfxVolume() { return sfxVol; },
    musicVolume() { return musicVol; },
    setMuted(b) {
      muted = !!b;
      if (master) {
        const c = ctx;
        master.gain.cancelScheduledValues(c.currentTime);
        master.gain.setTargetAtTime(muted ? 0 : 1, c.currentTime, 0.05);
      }
    },
    isMuted() { return muted; },
  };
})();
