/**
 * NEON CITY - procedural sound effects.
 *
 * Every sound in the game is synthesised at runtime from oscillators, generated noise
 * buffers, filters, waveshapers and the shared convolution reverb owned by
 * {@link module:audio/audio.AudioEngine}. There are **no audio files** anywhere in this
 * project and nothing here loads one.
 *
 * Design notes:
 * - One-shots go through `AudioEngine.playSound`, which pools and caps voices per category
 *   and disposes every node when the sound is over.
 * - Continuous sounds (engines, sirens, screech, ambience, heartbeat) return a handle built
 *   on {@link ContinuousSound}: `setVolume`, `setPosition` and `stop` always exist, even
 *   when audio is disabled, so gameplay code never has to null-check.
 * - Any one-shot accepts an optional world position and is then spatialised through a
 *   panner with distance based air absorption.
 * - `Math.random` is used only for cosmetic jitter (grain timing, pitch variation), never
 *   for world generation.
 *
 * @module audio/sfx
 */

import {
  MIN_GAIN, MIN_FREQ, clampNum, clampFreq, safeValue,
  setAt, linTo, expTo, targetAt, holdAt, envAD,
} from './audio.js';

/** Scratch position handed to the engine; never retained by the caller. */
const _pos = new Float32Array(3);

/** Per weapon shot character. Frequencies in Hz, times in seconds. */
const GUN_PROFILES = {
  pistol: {
    gain: 0.8, crackHi: 3300, crackLo: 620, crackQ: 0.9, crackDecay: 0.085, drive: 3,
    bodyF: 168, bodyEnd: 62, bodyDecay: 0.13, bodyGain: 0.55,
    tailF: 950, tailDecay: 0.22, tailGain: 0.16, reverb: 0.24, slap: 0,
    clickF: 5200, action: 0.045, actionF: 2500, actionGain: 0.16,
  },
  smg: {
    gain: 0.66, crackHi: 3900, crackLo: 900, crackQ: 1.1, crackDecay: 0.055, drive: 2.6,
    bodyF: 195, bodyEnd: 84, bodyDecay: 0.08, bodyGain: 0.38,
    tailF: 1250, tailDecay: 0.14, tailGain: 0.11, reverb: 0.17, slap: 0,
    clickF: 6200, action: 0.032, actionF: 3100, actionGain: 0.18,
  },
  shotgun: {
    gain: 1, crackHi: 2500, crackLo: 240, crackQ: 0.55, crackDecay: 0.17, drive: 5,
    bodyF: 118, bodyEnd: 38, bodyDecay: 0.28, bodyGain: 0.9,
    tailF: 520, tailDecay: 0.5, tailGain: 0.3, reverb: 0.45, slap: 0.32,
    clickF: 4200, action: 0.055, actionF: 1500, actionGain: 0.22,
  },
  rifle: {
    gain: 0.94, crackHi: 5400, crackLo: 700, crackQ: 1.35, crackDecay: 0.075, drive: 4.2,
    bodyF: 146, bodyEnd: 52, bodyDecay: 0.18, bodyGain: 0.62,
    tailF: 820, tailDecay: 0.4, tailGain: 0.26, reverb: 0.42, slap: 0.24,
    clickF: 7200, action: 0.04, actionF: 3300, actionGain: 0.16,
  },
  sniper: {
    gain: 1.05, crackHi: 6200, crackLo: 420, crackQ: 1.5, crackDecay: 0.11, drive: 4.6,
    bodyF: 104, bodyEnd: 33, bodyDecay: 0.32, bodyGain: 0.95,
    tailF: 620, tailDecay: 0.8, tailGain: 0.34, reverb: 0.65, slap: 0.45,
    clickF: 8000, action: 0.06, actionF: 2000, actionGain: 0.24,
  },
};

/** Reload choreography per weapon: [time, event, frequency, gain]. */
const RELOAD_SEQ = {
  pistol: [[0, 'click', 2700, 0.4], [0.07, 'rustle', 2000, 0.5], [0.3, 'clunk', 480, 0.8],
    [0.52, 'clack', 1600, 0.7], [0.6, 'click', 3100, 0.5]],
  smg: [[0, 'click', 2900, 0.4], [0.05, 'rustle', 2200, 0.5], [0.24, 'clunk', 520, 0.85],
    [0.42, 'clack', 1800, 0.75], [0.48, 'click', 3300, 0.5]],
  shotgun: [[0, 'clack', 1200, 0.8], [0.22, 'shell', 3400, 0.6], [0.44, 'clack', 1000, 0.9],
    [0.62, 'shell', 3600, 0.55], [0.86, 'clack', 900, 1]],
  rifle: [[0, 'click', 2500, 0.4], [0.08, 'rustle', 1800, 0.55], [0.36, 'clunk', 420, 0.9],
    [0.62, 'clack', 1500, 0.8], [0.7, 'click', 2900, 0.5]],
  sniper: [[0, 'clack', 1400, 0.7], [0.3, 'clunk', 380, 0.8], [0.62, 'clack', 1250, 0.85],
    [0.9, 'click', 2600, 0.6]],
  fist: [[0, 'rustle', 1600, 0.4]],
};

/** Bullet impact character per surface. */
const IMPACT_PROFILES = {
  concrete: {
    gain: 0.6, noiseType: 'bandpass', freq: 1100, freqEnd: 420, q: 0.9, decay: 0.085,
    bodyF: 128, bodyDecay: 0.1, bodyGain: 0.4, ring: null, grains: 5, grainHi: 4200, reverb: 0.24,
  },
  metal: {
    gain: 0.55, noiseType: 'bandpass', freq: 2800, freqEnd: 1400, q: 1.4, decay: 0.06,
    bodyF: 190, bodyDecay: 0.05, bodyGain: 0.22,
    ring: { partials: [1, 2.41, 3.77, 5.12], base: 1450, decay: 0.34, gain: 0.3 },
    grains: 2, grainHi: 6500, reverb: 0.3,
  },
  glass: {
    gain: 0.5, noiseType: 'highpass', freq: 3600, freqEnd: 2600, q: 0.7, decay: 0.07,
    bodyF: 320, bodyDecay: 0.04, bodyGain: 0.14,
    ring: { partials: [1, 2.76, 5.4], base: 3200, decay: 0.22, gain: 0.24 },
    grains: 9, grainHi: 7800, reverb: 0.28,
  },
  flesh: {
    gain: 0.62, noiseType: 'lowpass', freq: 620, freqEnd: 260, q: 0.9, decay: 0.1,
    bodyF: 96, bodyDecay: 0.12, bodyGain: 0.5, ring: null, grains: 0, grainHi: 0, reverb: 0.1,
  },
  wood: {
    gain: 0.55, noiseType: 'bandpass', freq: 1500, freqEnd: 600, q: 1.1, decay: 0.07,
    bodyF: 150, bodyDecay: 0.09, bodyGain: 0.35,
    ring: { partials: [1, 2.1, 3.4], base: 230, decay: 0.16, gain: 0.22 },
    grains: 3, grainHi: 3200, reverb: 0.18,
  },
  dirt: {
    gain: 0.5, noiseType: 'lowpass', freq: 820, freqEnd: 300, q: 0.6, decay: 0.14,
    bodyF: 80, bodyDecay: 0.12, bodyGain: 0.3, ring: null, grains: 6, grainHi: 2200, reverb: 0.08,
  },
  water: {
    gain: 0.55, noiseType: 'bandpass', freq: 900, freqEnd: 2600, q: 0.8, decay: 0.12,
    bodyF: 700, bodyDecay: 0.09, bodyGain: 0.32,
    ring: { partials: [1, 1.9], base: 780, decay: 0.13, gain: 0.16 },
    grains: 4, grainHi: 5200, reverb: 0.2,
  },
};

/** Footstep spectra per ground surface. */
const FOOT_PROFILES = {
  concrete: { gain: 0.3, type: 'bandpass', freq: 1250, q: 1.3, decay: 0.055, click: 4200, clickGain: 0.16, ring: 0, tail: 0 },
  asphalt: { gain: 0.28, type: 'bandpass', freq: 1050, q: 1.1, decay: 0.06, click: 3600, clickGain: 0.13, ring: 0, tail: 0 },
  grass: { gain: 0.22, type: 'lowpass', freq: 2400, q: 0.7, decay: 0.08, click: 0, clickGain: 0, ring: 0, tail: 0.11 },
  metal: { gain: 0.3, type: 'bandpass', freq: 980, q: 1.6, decay: 0.05, click: 3800, clickGain: 0.15, ring: 1750, tail: 0 },
  water: { gain: 0.3, type: 'lowpass', freq: 900, q: 1.2, decay: 0.16, click: 0, clickGain: 0, ring: 0, tail: 0.14 },
  gravel: { gain: 0.26, type: 'bandpass', freq: 1900, q: 0.8, decay: 0.07, click: 5200, clickGain: 0.1, ring: 0, tail: 0.05 },
  dirt: { gain: 0.24, type: 'lowpass', freq: 1500, q: 0.8, decay: 0.075, click: 0, clickGain: 0, ring: 0, tail: 0.05 },
  sand: { gain: 0.22, type: 'lowpass', freq: 1900, q: 0.6, decay: 0.09, click: 0, clickGain: 0, ring: 0, tail: 0.08 },
  wood: { gain: 0.28, type: 'bandpass', freq: 780, q: 1.4, decay: 0.06, click: 3000, clickGain: 0.12, ring: 320, tail: 0 },
};

/** Horn voicings: [low Hz, high Hz], timbre and length. */
const HORN_PROFILES = {
  sedan: { a: 400, b: 500, type: 'sawtooth', gain: 0.34, dur: 0.42, drive: 3, cut: 3200, air: 0 },
  taxi: { a: 440, b: 554, type: 'square', gain: 0.34, dur: 0.5, drive: 3.4, cut: 3600, air: 0 },
  sports: { a: 466, b: 587, type: 'sawtooth', gain: 0.33, dur: 0.36, drive: 3.6, cut: 4200, air: 0 },
  muscle: { a: 370, b: 466, type: 'sawtooth', gain: 0.36, dur: 0.45, drive: 4, cut: 3000, air: 0 },
  police: { a: 415, b: 523, type: 'square', gain: 0.34, dur: 0.4, drive: 3.2, cut: 3400, air: 0 },
  suv: { a: 349, b: 440, type: 'sawtooth', gain: 0.35, dur: 0.45, drive: 3, cut: 2800, air: 0 },
  van: { a: 330, b: 415, type: 'sawtooth', gain: 0.35, dur: 0.48, drive: 3, cut: 2600, air: 0.1 },
  truck: { a: 155, b: 233, type: 'sawtooth', gain: 0.45, dur: 0.85, drive: 4.5, cut: 1800, air: 0.22 },
  bus: { a: 175, b: 262, type: 'sawtooth', gain: 0.44, dur: 0.75, drive: 4.2, cut: 1900, air: 0.2 },
  sportsbike: { a: 620, b: 784, type: 'square', gain: 0.24, dur: 0.3, drive: 2.4, cut: 5200, air: 0 },
};

/** Harmonic stacks used by the engine model: [ratio, gain, waveform, detune cents]. */
const HARM_SETS = {
  smooth: [[0.5, 0.32, 'sawtooth', -6], [1, 1, 'sawtooth', 4], [1, 0.5, 'sawtooth', -11],
    [1.5, 0.22, 'sawtooth', 7], [2, 0.3, 'sawtooth', -3], [3, 0.12, 'square', 9]],
  aggressive: [[0.5, 0.5, 'sawtooth', -8], [1, 1, 'sawtooth', 5], [1, 0.6, 'square', -13],
    [1.5, 0.34, 'sawtooth', 9], [2, 0.42, 'sawtooth', -5], [3, 0.22, 'square', 12]],
  diesel: [[0.5, 0.85, 'square', -7], [1, 1, 'sawtooth', 6], [1, 0.55, 'square', -14],
    [1.5, 0.3, 'sawtooth', 10], [2, 0.24, 'sawtooth', -4], [3, 0.1, 'square', 8]],
  bike: [[0.5, 0.28, 'sawtooth', -9], [1, 1, 'sawtooth', 6], [1, 0.55, 'sawtooth', -12],
    [2, 0.5, 'sawtooth', 4], [3, 0.3, 'square', -6], [4, 0.16, 'square', 10]],
};

/** Engine tuning per vehicle class. `fireMul` is cylinders/2 (four-stroke firing order). */
const ENGINE_PROFILES = {
  sedan: { fireMul: 2, idle: 780, max: 6200, gain: 0.5, noise: 0.22, drive: 2.2, wobble: 0.05, cutBase: 320, cutLoad: 2400, cutRpm: 2600, harm: 'smooth' },
  taxi: { fireMul: 2, idle: 800, max: 6000, gain: 0.5, noise: 0.26, drive: 2.6, wobble: 0.08, cutBase: 300, cutLoad: 2200, cutRpm: 2400, harm: 'smooth' },
  suv: { fireMul: 3, idle: 720, max: 5800, gain: 0.56, noise: 0.24, drive: 2.4, wobble: 0.06, cutBase: 300, cutLoad: 2300, cutRpm: 2300, harm: 'smooth' },
  van: { fireMul: 3, idle: 700, max: 5200, gain: 0.56, noise: 0.28, drive: 2.5, wobble: 0.09, cutBase: 280, cutLoad: 2000, cutRpm: 2000, harm: 'diesel' },
  sports: { fireMul: 3, idle: 900, max: 8200, gain: 0.62, noise: 0.28, drive: 3.4, wobble: 0.04, cutBase: 420, cutLoad: 3400, cutRpm: 3600, harm: 'aggressive' },
  muscle: { fireMul: 4, idle: 700, max: 6600, gain: 0.68, noise: 0.3, drive: 4.2, wobble: 0.09, cutBase: 300, cutLoad: 2600, cutRpm: 2400, harm: 'aggressive' },
  police: { fireMul: 4, idle: 820, max: 7000, gain: 0.6, noise: 0.26, drive: 3, wobble: 0.05, cutBase: 360, cutLoad: 3000, cutRpm: 3000, harm: 'aggressive' },
  truck: { fireMul: 3, idle: 620, max: 3200, gain: 0.75, noise: 0.38, drive: 2.6, wobble: 0.16, cutBase: 220, cutLoad: 1500, cutRpm: 1400, harm: 'diesel' },
  bus: { fireMul: 3, idle: 600, max: 3000, gain: 0.72, noise: 0.36, drive: 2.4, wobble: 0.15, cutBase: 210, cutLoad: 1400, cutRpm: 1300, harm: 'diesel' },
  sportsbike: { fireMul: 1, idle: 1400, max: 13500, gain: 0.5, noise: 0.2, drive: 3.8, wobble: 0.03, cutBase: 500, cutLoad: 4200, cutRpm: 4600, harm: 'bike' },
};

/** Siren modes: LFO rates and pitch depths for wail / yelp / hi-lo. */
const SIREN_MODES = [
  { tri: 0.33, triDepth: 330, sq: 1.6, sqDepth: 0, center: 780, hold: 7.5 },
  { tri: 3.6, triDepth: 250, sq: 1.6, sqDepth: 0, center: 900, hold: 4.5 },
  { tri: 0.5, triDepth: 0, sq: 1.7, sqDepth: 150, center: 760, hold: 4 },
];

/** A minor pentatonic used for every UI blip, in MIDI note numbers. */
const UI_SCALE = [69, 72, 74, 76, 79, 81, 84];

/** Note sets for pickups: [midi notes], timbre. */
const PICKUP_NOTES = {
  health: { notes: [69, 76], type: 'triangle', bell: 0.3, gain: 0.32 },
  armor: { notes: [64, 71, 76], type: 'triangle', bell: 0.25, gain: 0.3 },
  money: { notes: [81, 88], type: 'sine', bell: 0.75, gain: 0.3 },
  ammo: { notes: [72], type: 'square', bell: 0.15, gain: 0.24 },
  weapon: { notes: [67, 74], type: 'sawtooth', bell: 0.2, gain: 0.26 },
};

/** UI blip recipes: notes and lengths. */
const UI_SOUNDS = {
  click: { notes: [81], dur: 0.075, gain: 0.22, type: 'triangle' },
  select: { notes: [79], dur: 0.08, gain: 0.22, type: 'triangle' },
  hover: { notes: [76], dur: 0.05, gain: 0.1, type: 'sine' },
  confirm: { notes: [76, 84], dur: 0.09, gain: 0.24, type: 'triangle' },
  back: { notes: [76, 69], dur: 0.08, gain: 0.2, type: 'triangle' },
  close: { notes: [74, 67], dur: 0.08, gain: 0.2, type: 'sine' },
  open: { notes: [72, 79], dur: 0.08, gain: 0.2, type: 'triangle' },
  toggle: { notes: [74], dur: 0.06, gain: 0.2, type: 'square' },
  error: { notes: [70, 69], dur: 0.14, gain: 0.2, type: 'triangle' },
  tick: { notes: [88], dur: 0.035, gain: 0.1, type: 'sine' },
};

/** Notification stingers. */
const NOTIFY_SOUNDS = {
  info: { notes: [76, 83], dur: 0.14, gain: 0.24, bell: 0.5 },
  warn: { notes: [72, 68], dur: 0.18, gain: 0.26, bell: 0.2 },
  money: { notes: [81, 88], dur: 0.16, gain: 0.26, bell: 0.8 },
  mission: { notes: [69, 74, 81], dur: 0.17, gain: 0.28, bell: 0.6 },
  wanted: { notes: [63, 62], dur: 0.22, gain: 0.3, bell: 0.1 },
};

/**
 * Converts a MIDI note number to a frequency.
 * @param {number} midi MIDI note (69 = A4 = 440 Hz).
 * @returns {number} Frequency in Hz.
 */
function mtof(midi) {
  return 440 * Math.pow(2, (safeValue(midi, 69) - 69) / 12);
}

/**
 * Returns `v` when finite, otherwise `d`.
 * @param {number} v Value.
 * @param {number} d Default.
 * @returns {number} A finite number.
 */
function num(v, d) {
  return Number.isFinite(v) ? v : d;
}

/**
 * Uniform random in a range (cosmetic jitter only).
 * @param {number} a Low bound.
 * @param {number} b High bound.
 * @returns {number} Random value.
 */
function rnd(a, b) {
  return a + Math.random() * (b - a);
}

/**
 * Normalises a position argument (`[x,y,z]`, `Float32Array` or `{x,y,z}`) into a scratch
 * vector accepted by the engine.
 * @param {ArrayLike<number>|{x:number,y:number,z:number}|null|undefined} p Position.
 * @returns {Float32Array|null} Scratch position, or null when there is none.
 */
function toPos(p) {
  if (!p || typeof p !== 'object') return null;
  const x = p[0] !== undefined ? p[0] : p.x;
  const y = p[1] !== undefined ? p[1] : p.y;
  const z = p[2] !== undefined ? p[2] : p.z;
  if (x === undefined && y === undefined && z === undefined) return null;
  _pos[0] = safeValue(x, 0);
  _pos[1] = safeValue(y, 0);
  _pos[2] = safeValue(z, 0);
  return _pos;
}

/**
 * Builds a teardown function that disconnects a list of nodes exactly once.
 * @param {AudioNode[]} nodes Nodes owned by a sound.
 * @returns {Function} Teardown callback.
 */
function disposer(nodes) {
  return () => {
    for (let i = 0; i < nodes.length; i++) {
      try {
        nodes[i].disconnect();
      } catch (err) {
        /* already gone */
      }
    }
    nodes.length = 0;
  };
}

/**
 * Schedules a filtered noise burst with an attack/decay envelope.
 * @param {import('./audio.js').AudioEngine} eng Engine.
 * @param {AudioNode} dest Destination node.
 * @param {number} t Start time.
 * @param {object} o Burst description.
 * @param {string} [o.kind] Noise colour (`white`|`pink`|`brown`).
 * @param {BiquadFilterType} [o.type] Filter type.
 * @param {number} o.freq Filter frequency.
 * @param {number} [o.freqEnd] Swept target frequency.
 * @param {number} [o.sweep] Sweep length (defaults to the decay).
 * @param {number} [o.q] Filter Q.
 * @param {number} [o.gain] Peak gain.
 * @param {number} [o.attack] Attack seconds.
 * @param {number} [o.decay] Decay seconds.
 * @param {number} [o.hp] Optional extra highpass.
 * @param {number} [o.drive] Optional waveshaper drive.
 * @param {number} [o.rate] Playback rate of the noise buffer.
 * @returns {number} Length of the burst in seconds.
 */
function noiseBurst(eng, dest, t, o) {
  const ctx = eng.ctx;
  const src = eng.noiseSource(o.kind || 'white', num(o.rate, 1));
  if (!src) return 0;
  const attack = Math.max(0.0004, num(o.attack, 0.002));
  const decay = Math.max(0.005, num(o.decay, 0.1));
  const filt = ctx.createBiquadFilter();
  filt.type = o.type || 'bandpass';
  filt.Q.value = clampNum(num(o.q, 1), 0.0001, 40);
  setAt(filt.frequency, clampFreq(num(o.freq, 1000)), t);
  if (Number.isFinite(o.freqEnd)) {
    expTo(filt.frequency, clampFreq(o.freqEnd), t + Math.max(0.005, num(o.sweep, decay)), MIN_FREQ);
  }
  const g = ctx.createGain();
  envAD(g.gain, num(o.gain, 0.4), t, attack, decay);
  const chain = [filt, g];
  src.connect(filt);
  let tail = filt;
  if (Number.isFinite(o.drive) && o.drive > 0) {
    const shaper = eng.createDistortion(o.drive);
    tail.connect(shaper);
    chain.push(shaper);
    tail = shaper;
  }
  tail.connect(g);
  let out = g;
  if (Number.isFinite(o.hp)) {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = clampFreq(o.hp);
    g.connect(hp);
    chain.push(hp);
    out = hp;
  }
  out.connect(dest);
  const dur = attack + decay + 0.02;
  const buf = src.buffer;
  eng.schedule(src, t, t + dur, chain, buf ? Math.random() * buf.duration * 0.9 : 0);
  return dur;
}

/**
 * Schedules a single enveloped oscillator, optionally gliding in pitch.
 * @param {import('./audio.js').AudioEngine} eng Engine.
 * @param {AudioNode} dest Destination node.
 * @param {number} t Start time.
 * @param {object} o Tone description.
 * @param {OscillatorType} [o.type] Waveform.
 * @param {number} o.freq Start frequency.
 * @param {number} [o.freqEnd] Glide target.
 * @param {number} [o.glide] Glide length (defaults to the decay).
 * @param {number} [o.detune] Detune in cents.
 * @param {number} [o.gain] Peak gain.
 * @param {number} [o.attack] Attack seconds.
 * @param {number} [o.decay] Decay seconds.
 * @param {number} [o.hold] Sustain length between attack and decay.
 * @param {number} [o.lp] Optional lowpass cutoff.
 * @param {number} [o.lpQ] Lowpass Q.
 * @returns {number} Length of the tone in seconds.
 */
function tone(eng, dest, t, o) {
  const ctx = eng.ctx;
  const osc = eng.createOsc(o.type || 'sine', num(o.freq, 220), num(o.detune, 0));
  if (!osc) return 0;
  const attack = Math.max(0.0005, num(o.attack, 0.004));
  const hold = Math.max(0, num(o.hold, 0));
  const decay = Math.max(0.005, num(o.decay, 0.2));
  setAt(osc.frequency, clampFreq(num(o.freq, 220)), t);
  if (Number.isFinite(o.freqEnd)) {
    expTo(osc.frequency, clampFreq(o.freqEnd), t + Math.max(0.005, num(o.glide, decay)), MIN_FREQ);
  }
  const g = ctx.createGain();
  const peak = Math.max(MIN_GAIN * 2, num(o.gain, 0.3));
  setAt(g.gain, MIN_GAIN, t);
  expTo(g.gain, peak, t + attack);
  if (hold > 0) setAt(g.gain, peak, t + attack + hold);
  expTo(g.gain, MIN_GAIN, t + attack + hold + decay);
  const chain = [g];
  osc.connect(g);
  let out = g;
  if (Number.isFinite(o.lp)) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = clampFreq(o.lp);
    lp.Q.value = clampNum(num(o.lpQ, 0.7), 0.0001, 30);
    g.connect(lp);
    chain.push(lp);
    out = lp;
  }
  out.connect(dest);
  const dur = attack + hold + decay + 0.02;
  eng.schedule(osc, t, t + dur, chain);
  return dur;
}

/**
 * Schedules an inharmonic partial cluster - the metallic "ring" after an impact.
 * @param {import('./audio.js').AudioEngine} eng Engine.
 * @param {AudioNode} dest Destination node.
 * @param {number} t Start time.
 * @param {number} base Base frequency.
 * @param {number[]} partials Frequency ratios.
 * @param {number} gain Peak gain of the first partial.
 * @param {number} decay Decay of the first partial.
 * @returns {number} Length in seconds.
 */
function ring(eng, dest, t, base, partials, gain, decay) {
  let longest = 0;
  for (let i = 0; i < partials.length; i++) {
    const f = base * partials[i] * rnd(0.99, 1.01);
    const d = decay * Math.pow(0.72, i);
    const g = gain * Math.pow(0.62, i);
    const len = tone(eng, dest, t, { type: 'sine', freq: f, gain: g, attack: 0.001, decay: d });
    if (len > longest) longest = len;
  }
  return longest;
}

/**
 * Builds a lowpassed feedback delay used for outdoor slap-back echoes.
 * @param {import('./audio.js').AudioEngine} eng Engine.
 * @param {AudioNode} dest Destination node.
 * @param {AudioNode[]} own Node list to append the delay chain to (for teardown).
 * @param {object} o Options.
 * @param {number} [o.time] Delay time in seconds.
 * @param {number} [o.feedback] Feedback amount 0..0.9.
 * @param {number} [o.gain] Send level.
 * @param {number} [o.cutoff] Feedback lowpass cutoff.
 * @returns {GainNode} Node to feed the echo with.
 */
function slapback(eng, dest, own, o) {
  const ctx = eng.ctx;
  const input = ctx.createGain();
  input.gain.value = clampNum(num(o.gain, 0.25), 0, 2);
  const delay = ctx.createDelay(1.5);
  delay.delayTime.value = clampNum(num(o.time, 0.22), 0.001, 1.4);
  const fb = ctx.createGain();
  fb.gain.value = clampNum(num(o.feedback, 0.28), 0, 0.85);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = clampFreq(num(o.cutoff, 1100));
  input.connect(delay);
  delay.connect(lp);
  lp.connect(fb);
  fb.connect(delay);
  lp.connect(dest);
  own.push(input, delay, fb, lp);
  return input;
}

/**
 * Schedules a brass-like detuned saw chord with a filter swell.
 * @param {import('./audio.js').AudioEngine} eng Engine.
 * @param {AudioNode} dest Destination node.
 * @param {number} t Start time.
 * @param {number[]} midis Chord notes.
 * @param {number} dur Chord length (sustain).
 * @param {number} gain Peak gain of the whole chord.
 * @param {object} [opts] Extra options.
 * @param {number} [opts.attack] Attack seconds.
 * @param {number} [opts.release] Release seconds.
 * @param {number} [opts.cut] Filter cutoff at the peak.
 * @param {OscillatorType} [opts.type] Waveform.
 * @returns {number} Total length in seconds.
 */
function brassChord(eng, dest, t, midis, dur, gain, opts) {
  const ctx = eng.ctx;
  const o = opts || {};
  const attack = Math.max(0.005, num(o.attack, 0.035));
  const release = Math.max(0.02, num(o.release, 0.35));
  const per = gain / Math.max(1, midis.length);
  for (let i = 0; i < midis.length; i++) {
    const f = mtof(midis[i]);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 1.1;
    setAt(lp.frequency, clampFreq(f * 2.2), t);
    expTo(lp.frequency, clampFreq(num(o.cut, 2600)), t + attack * 1.6, MIN_FREQ);
    expTo(lp.frequency, clampFreq(f * 3), t + attack + dur + release, MIN_FREQ);
    const g = ctx.createGain();
    setAt(g.gain, MIN_GAIN, t);
    expTo(g.gain, per, t + attack);
    setAt(g.gain, per, t + attack + dur);
    expTo(g.gain, MIN_GAIN, t + attack + dur + release);
    lp.connect(g);
    g.connect(dest);
    const detunes = [-9, 0, 8];
    for (let d = 0; d < detunes.length; d++) {
      const osc = eng.createOsc(o.type || 'sawtooth', f, detunes[d]);
      if (!osc) break;
      osc.connect(lp);
      eng.schedule(osc, t, t + attack + dur + release + 0.05, d === detunes.length - 1 ? [lp, g] : null);
    }
  }
  return attack + dur + release;
}

/**
 * Schedules a timpani hit: pitched membrane with a fast downward bend plus a noise thump.
 * @param {import('./audio.js').AudioEngine} eng Engine.
 * @param {AudioNode} dest Destination node.
 * @param {number} t Start time.
 * @param {number} midi Pitch.
 * @param {number} gain Peak gain.
 * @returns {number} Length in seconds.
 */
function timpani(eng, dest, t, midi, gain) {
  const f = mtof(midi);
  tone(eng, dest, t, { type: 'sine', freq: f * 1.09, freqEnd: f, glide: 0.09, gain: gain, attack: 0.004, decay: 0.85, lp: f * 6 });
  tone(eng, dest, t, { type: 'sine', freq: f * 1.52, gain: gain * 0.3, attack: 0.003, decay: 0.34 });
  tone(eng, dest, t, { type: 'sine', freq: f * 2.03, gain: gain * 0.18, attack: 0.003, decay: 0.22 });
  noiseBurst(eng, dest, t, { type: 'lowpass', freq: 360, q: 0.8, gain: gain * 0.5, attack: 0.002, decay: 0.11 });
  return 0.9;
}

/**
 * Schedules a soft bell/celesta note (sine partials, exponential decay).
 * @param {import('./audio.js').AudioEngine} eng Engine.
 * @param {AudioNode} dest Destination node.
 * @param {number} t Start time.
 * @param {number} midi Pitch.
 * @param {number} gain Peak gain.
 * @param {number} decay Decay of the fundamental.
 * @returns {number} Length in seconds.
 */
function bell(eng, dest, t, midi, gain, decay) {
  const f = mtof(midi);
  tone(eng, dest, t, { type: 'sine', freq: f, gain: gain, attack: 0.004, decay: decay });
  tone(eng, dest, t, { type: 'sine', freq: f * 2.01, gain: gain * 0.42, attack: 0.003, decay: decay * 0.6 });
  tone(eng, dest, t, { type: 'sine', freq: f * 3.02, gain: gain * 0.2, attack: 0.003, decay: decay * 0.4 });
  tone(eng, dest, t, { type: 'sine', freq: f * 5.4, gain: gain * 0.08, attack: 0.002, decay: decay * 0.25 });
  return decay + 0.05;
}

/**
 * Look-ahead scheduler for continuous sounds that need timed events (heartbeat, rain
 * droplets, distant horns, siren mode changes). Keeps the audio thread ahead of the timer.
 */
class EventScheduler {
  /**
   * @param {import('./audio.js').AudioEngine} eng Engine.
   * @param {number} horizon How far ahead to schedule, in seconds.
   * @param {(time: number) => number} cb Schedules one event at `time` and returns the
   *   gap in seconds until the next one.
   */
  constructor(eng, horizon, cb) {
    this.eng = eng;
    this.horizon = horizon;
    this.cb = cb;
    this.next = eng.now + 0.05;
    this.timer = 0;
  }

  /**
   * Starts ticking.
   * @param {number} [intervalMs] Timer period.
   * @returns {EventScheduler} This scheduler.
   */
  start(intervalMs = 200) {
    if (this.timer) return this;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.tick();
    return this;
  }

  /**
   * Schedules every event that falls inside the look-ahead horizon.
   * @returns {void}
   */
  tick() {
    const now = this.eng.now;
    if (!this.eng.enabled) return;
    if (this.next < now) this.next = now + 0.02;
    let guard = 0;
    while (this.next < now + this.horizon && guard++ < 64) {
      let gap = 1;
      try {
        gap = this.cb(this.next);
      } catch (err) {
        this.stop();
        return;
      }
      this.next += Math.max(0.02, safeValue(gap, 1));
    }
  }

  /**
   * Stops ticking.
   * @returns {void}
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = 0;
    }
  }
}

/**
 * A looping/continuous sound with its own output gain, optional 3D placement and a list of
 * owned nodes, sources and schedulers that are torn down together.
 */
class ContinuousSound {
  /**
   * @param {import('./audio.js').AudioEngine} eng Engine.
   * @param {string} bus Bus name.
   * @param {object} [opts] Options.
   * @param {ArrayLike<number>} [opts.pos] World position (omit for a 2D sound).
   * @param {number} [opts.gain] Target level.
   * @param {number} [opts.reverb] Reverb send 0..1.
   * @param {number} [opts.refDistance] Panner reference distance.
   * @param {number} [opts.maxDistance] Panner max distance.
   * @param {number} [opts.rolloff] Panner rolloff.
   */
  constructor(eng, bus, opts) {
    const o = opts || {};
    const ctx = eng.ctx;
    /** @type {import('./audio.js').AudioEngine} */
    this.eng = eng;
    /** @type {number} Target level once faded in. */
    this.level = clampNum(num(o.gain, 1), 0, 8);
    /** @type {GainNode} Connect the voice chain here. */
    this.out = ctx.createGain();
    this.out.gain.value = MIN_GAIN;
    /** @type {object|null} */
    this.spatial = null;
    /** @type {AudioNode[]} */
    this.nodes = [];
    /** @type {AudioScheduledSourceNode[]} */
    this.sources = [];
    /** @type {EventScheduler[]} */
    this.schedulers = [];
    /** @type {boolean} */
    this.alive = true;
    this._timer = 0;
    if (o.pos) {
      this.spatial = eng.createPositional(bus, {
        pos: o.pos,
        gain: 1,
        reverb: num(o.reverb, 0),
        refDistance: o.refDistance,
        maxDistance: o.maxDistance,
        rolloff: o.rolloff,
      });
      this.out.connect(this.spatial.input);
    } else {
      this.out.connect(eng.buses[bus] || eng.buses.sfx);
      if (num(o.reverb, 0) > 0) {
        const send = ctx.createGain();
        send.gain.value = clampNum(o.reverb, 0, 2);
        this.out.connect(send);
        send.connect(eng.reverbSend);
        this.nodes.push(send);
      }
    }
  }

  /**
   * Registers an owned node so it is disconnected on stop.
   * @template {AudioNode} T
   * @param {T} node Node to own.
   * @returns {T} The same node.
   */
  own(node) {
    this.nodes.push(node);
    return node;
  }

  /**
   * Starts and registers a source node.
   * @param {AudioScheduledSourceNode} src Source.
   * @param {number} [when] Start time.
   * @returns {AudioScheduledSourceNode} The same source.
   */
  play(src, when) {
    try {
      src.start(when === undefined ? this.eng.now : Math.max(0, when));
    } catch (err) {
      /* already started */
    }
    this.sources.push(src);
    return src;
  }

  /**
   * Registers a look-ahead scheduler.
   * @param {EventScheduler} sched Scheduler.
   * @returns {EventScheduler} The same scheduler.
   */
  schedule(sched) {
    this.schedulers.push(sched);
    return sched;
  }

  /**
   * Fades the output up to the target level.
   * @param {number} [seconds] Fade length.
   * @returns {void}
   */
  fadeIn(seconds = 0.4) {
    if (!this.alive) return;
    const t = this.eng.now;
    holdAt(this.out.gain, t);
    expTo(this.out.gain, Math.max(MIN_GAIN * 2, this.level), t + Math.max(0.01, seconds));
  }

  /**
   * Sets the target level.
   * @param {number} v Gain.
   * @param {number} [ramp] Ramp length.
   * @returns {void}
   */
  setVolume(v, ramp = 0.15) {
    if (!this.alive) return;
    this.level = clampNum(v, 0, 8);
    const t = this.eng.now;
    holdAt(this.out.gain, t);
    expTo(this.out.gain, Math.max(MIN_GAIN, this.level), t + Math.max(0.01, ramp));
  }

  /**
   * Moves the sound in the world (no-op for 2D sounds).
   * @param {number|ArrayLike<number>} x X or a position array.
   * @param {number} [y] Y.
   * @param {number} [z] Z.
   * @returns {void}
   */
  setPosition(x, y, z) {
    if (this.spatial) this.spatial.setPosition(x, y, z);
  }

  /**
   * Fades out, stops every source and disconnects every node. Idempotent.
   * @param {number} [fade] Fade length in seconds.
   * @returns {void}
   */
  stop(fade = 0.25) {
    if (!this.alive) return;
    this.alive = false;
    const eng = this.eng;
    const t = eng.now;
    const f = Math.max(0.01, safeValue(fade, 0.25));
    for (let i = 0; i < this.schedulers.length; i++) this.schedulers[i].stop();
    this.schedulers.length = 0;
    holdAt(this.out.gain, t);
    expTo(this.out.gain, MIN_GAIN, t + f);
    for (let i = 0; i < this.sources.length; i++) {
      try {
        this.sources[i].stop(t + f + 0.02);
      } catch (err) {
        /* already stopped */
      }
    }
    this._timer = setTimeout(() => {
      this._timer = 0;
      for (let i = 0; i < this.sources.length; i++) {
        try {
          this.sources[i].disconnect();
        } catch (err) {
          /* already gone */
        }
      }
      this.sources.length = 0;
      for (let i = 0; i < this.nodes.length; i++) {
        try {
          this.nodes[i].disconnect();
        } catch (err) {
          /* already gone */
        }
      }
      this.nodes.length = 0;
      try {
        this.out.disconnect();
      } catch (err) {
        /* already gone */
      }
      if (this.spatial) {
        this.spatial.stop(0, 0.02);
        this.spatial = null;
      }
    }, (f + 0.12) * 1000);
  }
}

/** Silent stand-in returned by handle-returning methods when audio is unavailable. */
const DEAD_HANDLE = Object.freeze({
  alive: false,
  setVolume() {},
  setPosition() {},
  setIntensity() {},
  setRate() {},
  setReverb() {},
  update() {},
  stop() {},
});

/**
 * Resolves the engine profile for a vehicle (accepts a Vehicle, a type object or a key).
 * @param {*} vehicle Vehicle-ish value.
 * @returns {object} An entry of `ENGINE_PROFILES`.
 */
function engineProfileFor(vehicle) {
  let key = 'sedan';
  if (vehicle) {
    if (typeof vehicle === 'string') {
      key = vehicle;
    } else if (typeof vehicle === 'object') {
      if (typeof vehicle.typeKey === 'string') key = vehicle.typeKey;
      else if (typeof vehicle.type === 'string') key = vehicle.type;
      else if (vehicle.type && typeof vehicle.type === 'object') {
        key = vehicle.type.key || vehicle.type.name || key;
      } else if (typeof vehicle.kind === 'string') {
        key = vehicle.kind;
      }
      if (vehicle.isPolice) key = 'police';
    }
  }
  key = String(key).toLowerCase();
  if (key === 'bike' || key === 'motorbike' || key === 'motorcycle') key = 'sportsbike';
  if (key === 'cop' || key === 'cruiser') key = 'police';
  if (ENGINE_PROFILES[key]) return ENGINE_PROFILES[key];
  // Display names such as "Police Cruiser" still resolve to the right engine.
  const names = Object.keys(ENGINE_PROFILES);
  for (let i = 0; i < names.length; i++) {
    if (key.indexOf(names[i]) >= 0) return ENGINE_PROFILES[names[i]];
  }
  return ENGINE_PROFILES.sedan;
}

/**
 * A running vehicle engine. Several detuned oscillators track the firing harmonics of the
 * motor, a noise layer adds intake/exhaust hiss, a waveshaper adds drive and a lowpass
 * opens with load. Everything is moved with `setTargetAtTime`, so `update` is click-free.
 */
export class EngineVoice {
  /**
   * @param {SFX} sfx Owning SFX instance.
   * @param {*} vehicle Vehicle (or type key) the engine belongs to.
   */
  constructor(sfx, vehicle) {
    const eng = sfx.engine;
    const ctx = eng.ctx;
    const p = engineProfileFor(vehicle);
    /** @type {object} Tuning profile in use. */
    this.profile = p;
    /** @type {import('./audio.js').AudioEngine} */
    this.eng = eng;
    /** @type {boolean} */
    this.alive = true;
    /** @type {number} Last rpm passed to update(). */
    this.rpm = p.idle;
    /** @type {number} Last load passed to update(). */
    this.load = 0;
    /** @type {number} Output trim applied on top of the model level. */
    this.trim = 1;

    const pos = (vehicle && vehicle.position) || null;
    const c = new ContinuousSound(eng, 'vehicle', {
      pos: toPos(pos) || _pos,
      gain: p.gain,
      reverb: 0.1,
      refDistance: 5,
      maxDistance: 190,
      rolloff: 1.25,
    });
    /** @type {ContinuousSound} */
    this.sound = c;

    // Base frequency bus: one constant source drives every harmonic through a gain ratio,
    // so a single param update retunes the whole engine without any zipper noise.
    const base = ctx.createConstantSource();
    base.offset.value = clampFreq((p.idle * p.fireMul) / 60);
    const baseSum = c.own(ctx.createGain());
    baseSum.gain.value = 1;
    base.connect(baseSum);
    /** @type {ConstantSourceNode} */
    this.base = base;

    // Idle wobble: a slow LFO detunes the whole stack, strongest at low rpm.
    const wobble = c.own(ctx.createOscillator());
    wobble.type = 'sine';
    wobble.frequency.value = 4.7;
    const wobbleDepth = c.own(ctx.createGain());
    wobbleDepth.gain.value = base.offset.value * p.wobble;
    wobble.connect(wobbleDepth);
    wobbleDepth.connect(baseSum);
    /** @type {GainNode} */
    this.wobbleDepth = wobbleDepth;

    const mix = c.own(ctx.createGain());
    mix.gain.value = 0.32;
    const harmonics = HARM_SETS[p.harm] || HARM_SETS.smooth;
    for (let i = 0; i < harmonics.length; i++) {
      const h = harmonics[i];
      const ratio = c.own(ctx.createGain());
      ratio.gain.value = h[0];
      baseSum.connect(ratio);
      const osc = ctx.createOscillator();
      osc.type = h[2];
      osc.frequency.value = 0; // driven entirely by the base bus
      osc.detune.value = h[3];
      ratio.connect(osc.frequency);
      const g = c.own(ctx.createGain());
      g.gain.value = h[1];
      osc.connect(g);
      g.connect(mix);
      c.play(osc, eng.now);
    }

    // Intake / exhaust noise layer.
    const noise = eng.noiseSource('brown', 1);
    const noiseFilter = c.own(ctx.createBiquadFilter());
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 320;
    noiseFilter.Q.value = 0.7;
    const noiseGain = c.own(ctx.createGain());
    noiseGain.gain.value = p.noise * 0.25;
    if (noise) {
      noise.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(mix);
      c.play(noise, eng.now);
    }
    /** @type {BiquadFilterNode} */
    this.noiseFilter = noiseFilter;
    /** @type {GainNode} */
    this.noiseGain = noiseGain;

    // Drive -> waveshaper -> tone filter -> output.
    const drive = c.own(ctx.createGain());
    drive.gain.value = 0.7;
    const shaper = c.own(eng.createDistortion(p.drive));
    const toneFilter = c.own(ctx.createBiquadFilter());
    toneFilter.type = 'lowpass';
    toneFilter.frequency.value = p.cutBase;
    toneFilter.Q.value = 0.9;
    const body = c.own(ctx.createBiquadFilter());
    body.type = 'peaking';
    body.frequency.value = 110;
    body.Q.value = 1.2;
    body.gain.value = 5;
    mix.connect(drive);
    drive.connect(shaper);
    shaper.connect(toneFilter);
    toneFilter.connect(body);
    body.connect(c.out);
    /** @type {GainNode} */
    this.drive = drive;
    /** @type {BiquadFilterNode} */
    this.toneFilter = toneFilter;

    c.play(base, eng.now);
    c.play(wobble, eng.now);
    c.fadeIn(0.35);
  }

  /**
   * Drives the engine model. Safe to call every frame; allocates nothing.
   * @param {number} rpm Engine rpm.
   * @param {number} load Throttle load 0..1.
   * @param {number} speed Vehicle speed in m/s.
   * @param {ArrayLike<number>} [pos3] World position of the vehicle.
   * @returns {void}
   */
  update(rpm, load, speed, pos3) {
    if (!this.alive || !this.eng.enabled) return;
    const p = this.profile;
    const t = this.eng.now;
    const r = clampNum(rpm, 120, p.max * 1.15);
    const l = clampNum(load, 0, 1);
    const sp = clampNum(speed, 0, 120);
    const span = Math.max(1, p.max - p.idle);
    const rn = clampNum((r - p.idle) / span, 0, 1.2);
    this.rpm = r;
    this.load = l;

    targetAt(this.base.offset, clampFreq((r * p.fireMul) / 60), t, 0.045);
    targetAt(this.toneFilter.frequency, clampFreq(p.cutBase + p.cutLoad * l + p.cutRpm * rn), t, 0.06);
    targetAt(this.drive.gain, 0.55 + l * 0.9 + rn * 0.35, t, 0.08);
    targetAt(this.noiseGain.gain, p.noise * (0.22 + 0.78 * l) * (0.35 + 0.65 * rn), t, 0.08);
    targetAt(this.noiseFilter.frequency, clampFreq(240 + rn * 1700 + sp * 14), t, 0.08);
    targetAt(this.wobbleDepth.gain, Math.max(0.001, ((r * p.fireMul) / 60) * p.wobble * (1 - rn * 0.85)), t, 0.12);
    const level = p.gain * this.trim * (0.42 + 0.58 * l) * (0.55 + 0.45 * rn);
    targetAt(this.sound.out.gain, Math.max(MIN_GAIN, level), t, 0.05);
    if (pos3) this.sound.setPosition(toPos(pos3));
  }

  /**
   * Sets a static output trim (used to fade distant traffic). The trim multiplies the level
   * the model computes in {@link EngineVoice#update}.
   * @param {number} v Gain multiplier 0..4.
   * @returns {void}
   */
  setVolume(v) {
    this.trim = clampNum(num(v, 1), 0, 4);
    this.sound.setVolume(this.profile.gain * this.trim * (0.42 + 0.58 * this.load));
  }

  /**
   * Moves the engine sound.
   * @param {number|ArrayLike<number>} x X or a position array.
   * @param {number} [y] Y.
   * @param {number} [z] Z.
   * @returns {void}
   */
  setPosition(x, y, z) {
    this.sound.setPosition(x, y, z);
  }

  /**
   * Stops the engine and releases every node.
   * @returns {void}
   */
  stop() {
    if (!this.alive) return;
    this.alive = false;
    this.sound.stop(0.18);
  }
}

/**
 * Procedural sound effect bank. One instance per game; hold on to it via `game.sfx`.
 */
export class SFX {
  /**
   * @param {import('./audio.js').AudioEngine} audioEngine The shared audio engine.
   */
  constructor(audioEngine) {
    /** @type {import('./audio.js').AudioEngine} */
    this.engine = audioEngine;
    /** @type {import('./audio.js').AudioEngine} Alias used by some gameplay modules. */
    this.audio = audioEngine;
    /** @type {Map<string, ContinuousSound>} Active ambience beds keyed by kind. */
    this.ambiences = new Map();
    /** @type {Set<object>} Every live continuous handle (for stopAll). */
    this.active = new Set();
    /** @type {object|null} */
    this._heart = null;
    /** @type {number} Rolling index so repeated footsteps alternate feet. */
    this._footIndex = 0;
  }

  /** @returns {boolean} True when sounds can actually be scheduled. */
  get ready() {
    return !!this.engine && this.engine.enabled;
  }

  /** @returns {AudioContext|null} The shared audio context. */
  get ctx() {
    return this.engine ? this.engine.ctx : null;
  }

  /**
   * Registers a continuous handle so {@link SFX#stopAll} can reach it.
   * @param {object} handle Handle with a `stop` method.
   * @returns {object} The same handle.
   * @private
   */
  _track(handle) {
    this.active.add(handle);
    return handle;
  }

  /**
   * Stops every continuous sound this bank owns (ambience, sirens, engines, heartbeat).
   * @param {number} [fade] Fade length in seconds.
   * @returns {void}
   */
  stopAll(fade = 0.2) {
    this.active.forEach((h) => {
      try {
        h.stop(fade);
      } catch (err) {
        /* handle already dead */
      }
    });
    this.active.clear();
    this.ambiences.clear();
    this._heart = null;
    if (this.engine) this.engine.stopAllVoices();
  }

  // ------------------------------------------------------------------ weapons

  /**
   * A layered gunshot: click transient, swept noise crack, low body thump, room tail and a
   * mechanical action click a few tens of milliseconds later.
   * @param {string} [kind] `'pistol'|'smg'|'shotgun'|'rifle'|'sniper'`.
   * @param {ArrayLike<number>} [pos3] World position.
   * @param {object} [opts] Options: `{gain, suppressed}`.
   * @returns {object|null} Playback handle, or null when audio is off.
   */
  gunshot(kind, pos3, opts) {
    if (!this.ready) return null;
    const p = GUN_PROFILES[kind] || GUN_PROFILES.pistol;
    const o = opts || {};
    const suppressed = !!o.suppressed;
    const vol = clampNum(num(o.gain, 1), 0, 4) * (suppressed ? 0.45 : 1);
    const eng = this.engine;
    return eng.playSound((ctx, dest, t) => {
      const own = [];
      const sum = ctx.createGain();
      sum.gain.value = 1;
      sum.connect(dest);
      own.push(sum);
      let echo = null;
      if (p.slap > 0 && !suppressed) {
        echo = slapback(eng, dest, own, { time: 0.155, feedback: 0.3, gain: p.slap * 0.5, cutoff: 1300 });
        sum.connect(echo);
      }
      let dur = 0;

      // (c) firing-pin / muzzle click transient.
      dur = Math.max(dur, noiseBurst(eng, sum, t, {
        type: 'highpass', freq: p.clickF, q: 0.7, gain: 0.5 * p.gain * vol, attack: 0.0005, decay: 0.014,
      }));

      // (a) main crack: noise through a bandpass swept downward, driven into a soft clipper.
      dur = Math.max(dur, noiseBurst(eng, sum, t, {
        type: 'bandpass',
        freq: p.crackHi * rnd(0.95, 1.06),
        freqEnd: p.crackLo,
        sweep: p.crackDecay * 0.9,
        q: p.crackQ,
        gain: p.gain * vol * (suppressed ? 0.7 : 1),
        attack: 0.0008,
        decay: p.crackDecay,
        drive: suppressed ? 1.4 : p.drive,
        hp: suppressed ? 240 : 90,
      }));

      // (b) body: pitched thump with a fast downward bend, plus a sub octave.
      dur = Math.max(dur, tone(eng, sum, t, {
        type: 'triangle',
        freq: p.bodyF * 1.7,
        freqEnd: p.bodyEnd,
        glide: p.bodyDecay * 0.55,
        gain: p.bodyGain * p.gain * vol,
        attack: 0.0025,
        decay: p.bodyDecay,
        lp: 900,
      }));
      tone(eng, sum, t, {
        type: 'sine',
        freq: p.bodyF * 0.55,
        freqEnd: p.bodyEnd * 0.5,
        glide: p.bodyDecay,
        gain: p.bodyGain * p.gain * vol * 0.5,
        attack: 0.004,
        decay: p.bodyDecay * 1.5,
      });

      // (d) room tail whose length is weapon specific.
      dur = Math.max(dur, noiseBurst(eng, sum, t + 0.012, {
        kind: 'pink',
        type: 'bandpass',
        freq: p.tailF,
        freqEnd: p.tailF * 0.42,
        sweep: p.tailDecay,
        q: 0.6,
        gain: p.tailGain * vol * (suppressed ? 0.4 : 1),
        attack: 0.012,
        decay: p.tailDecay,
      }));

      // Mechanical action a few tens of milliseconds later.
      const at = t + p.action;
      noiseBurst(eng, sum, at, {
        type: 'highpass', freq: p.actionF, q: 0.8, gain: p.actionGain * vol, attack: 0.0008, decay: 0.026,
      });
      tone(eng, sum, at, {
        type: 'square', freq: p.actionF * 1.35, freqEnd: p.actionF * 0.85, glide: 0.03,
        gain: p.actionGain * 0.5 * vol, attack: 0.001, decay: 0.035, lp: 6000,
      });
      dur = Math.max(dur, p.action + 0.06);

      return { duration: dur + (echo ? 0.6 : 0.05), stop: disposer(own) };
    }, {
      bus: 'weapon',
      category: 'weapon',
      pos: toPos(pos3),
      gain: 0.9,
      reverb: suppressed ? p.reverb * 0.3 : p.reverb,
      refDistance: 9,
      maxDistance: 420,
      rolloff: 0.95,
    });
  }

  /**
   * The reload choreography for a weapon: magazine release, insertion and slide/bolt.
   * @param {string} [kind] Weapon key.
   * @param {ArrayLike<number>} [pos3] World position.
   * @returns {object|null} Playback handle, or null when audio is off.
   */
  reload(kind, pos3) {
    if (!this.ready) return null;
    const seq = RELOAD_SEQ[kind] || RELOAD_SEQ.pistol;
    const eng = this.engine;
    return eng.playSound((ctx, dest, t) => {
      let end = 0;
      for (let i = 0; i < seq.length; i++) {
        const ev = seq[i];
        const at = t + ev[0];
        const type = ev[1];
        const f = ev[2] * rnd(0.96, 1.05);
        const g = ev[3] * 0.5;
        if (type === 'click') {
          noiseBurst(eng, dest, at, { type: 'highpass', freq: f, q: 0.8, gain: g * 0.6, attack: 0.0006, decay: 0.02 });
          ring(eng, dest, at, f * 0.9, [1, 1.62], g * 0.25, 0.05);
        } else if (type === 'clack') {
          noiseBurst(eng, dest, at, { type: 'bandpass', freq: f, q: 2, gain: g * 0.8, attack: 0.0008, decay: 0.05 });
          tone(eng, dest, at, { type: 'triangle', freq: 210, freqEnd: 128, glide: 0.05, gain: g * 0.5, attack: 0.001, decay: 0.07 });
          ring(eng, dest, at, f * 0.75, [1, 1.74, 2.9], g * 0.22, 0.08);
        } else if (type === 'clunk') {
          noiseBurst(eng, dest, at, { type: 'bandpass', freq: f, q: 1.5, gain: g * 0.85, attack: 0.001, decay: 0.085 });
          tone(eng, dest, at, { type: 'triangle', freq: 158, freqEnd: 88, glide: 0.08, gain: g * 0.7, attack: 0.002, decay: 0.12, lp: 1200 });
        } else if (type === 'shell') {
          ring(eng, dest, at, f, [1, 1.47, 2.13], g * 0.2, 0.12);
          noiseBurst(eng, dest, at, { type: 'highpass', freq: 4200, q: 0.7, gain: g * 0.3, attack: 0.001, decay: 0.03 });
        } else {
          noiseBurst(eng, dest, at, { kind: 'pink', type: 'bandpass', freq: f, q: 0.8, gain: g * 0.28, attack: 0.012, decay: 0.13 });
        }
        end = Math.max(end, ev[0] + 0.16);
      }
      return end;
    }, { bus: 'weapon', category: 'weapon', pos: toPos(pos3), gain: 0.85, reverb: 0.12, refDistance: 5, maxDistance: 90 });
  }

  /**
   * A bullet hitting a surface: filtered noise plus the resonance of that material.
   * @param {string} [surface] `'concrete'|'metal'|'glass'|'flesh'|'wood'|'dirt'|'water'`.
   * @param {ArrayLike<number>} [pos3] World position.
   * @returns {object|null} Playback handle, or null when audio is off.
   */
  bulletImpact(surface, pos3) {
    if (!this.ready) return null;
    const p = IMPACT_PROFILES[surface] || IMPACT_PROFILES.concrete;
    const eng = this.engine;
    const jitter = rnd(0.88, 1.16);
    return eng.playSound((ctx, dest, t) => {
      let dur = noiseBurst(eng, dest, t, {
        type: p.noiseType,
        freq: p.freq * jitter,
        freqEnd: p.freqEnd * jitter,
        sweep: p.decay,
        q: p.q,
        gain: p.gain,
        attack: 0.0006,
        decay: p.decay,
        drive: 1.6,
      });
      if (p.bodyGain > 0) {
        dur = Math.max(dur, tone(eng, dest, t, {
          type: 'sine',
          freq: p.bodyF * jitter * 1.4,
          freqEnd: p.bodyF * jitter * 0.6,
          glide: p.bodyDecay,
          gain: p.bodyGain,
          attack: 0.001,
          decay: p.bodyDecay,
        }));
      }
      if (p.ring) {
        dur = Math.max(dur, ring(eng, dest, t + 0.004, p.ring.base * jitter, p.ring.partials, p.ring.gain, p.ring.decay));
      }
      for (let i = 0; i < p.grains; i++) {
        noiseBurst(eng, dest, t + rnd(0.01, 0.16), {
          type: 'bandpass',
          freq: rnd(p.grainHi * 0.45, p.grainHi),
          q: 2.5,
          gain: rnd(0.02, 0.07),
          attack: 0.0006,
          decay: rnd(0.012, 0.04),
        });
      }
      return Math.max(dur, p.grains > 0 ? 0.24 : 0.1);
    }, { bus: 'sfx', category: 'impact', pos: toPos(pos3), gain: 0.9, reverb: p.reverb, refDistance: 5, maxDistance: 140 });
  }

  /**
   * A ricochet: two or three pitch-falling filtered sine sweeps through a feedback delay.
   * @param {ArrayLike<number>} [pos3] World position.
   * @returns {object|null} Playback handle, or null when audio is off.
   */
  ricochet(pos3) {
    if (!this.ready) return null;
    const eng = this.engine;
    return eng.playSound((ctx, dest, t) => {
      const own = [];
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2400;
      bp.Q.value = 1.4;
      bp.connect(dest);
      own.push(bp);
      const echo = slapback(eng, dest, own, { time: rnd(0.075, 0.12), feedback: 0.34, gain: 0.32, cutoff: 3200 });
      bp.connect(echo);

      const zings = Math.random() < 0.45 ? 3 : 2;
      let dur = 0;
      for (let i = 0; i < zings; i++) {
        const at = t + i * rnd(0.03, 0.075);
        const start = rnd(2600, 4300) * Math.pow(0.82, i);
        const end = rnd(620, 1050) * Math.pow(0.9, i);
        const decay = rnd(0.18, 0.34);
        const osc = eng.createOsc(i === 0 ? 'sine' : 'triangle', start);
        const g = ctx.createGain();
        setAt(osc.frequency, clampFreq(start), at);
        expTo(osc.frequency, clampFreq(end), at + decay, MIN_FREQ);
        envAD(g.gain, 0.24 * Math.pow(0.7, i), at, 0.002, decay);
        // Vibrato gives the classic western "zing" wobble.
        const vib = eng.createOsc('sine', rnd(24, 42));
        const vibGain = ctx.createGain();
        vibGain.gain.value = start * 0.02;
        vib.connect(vibGain);
        vibGain.connect(osc.frequency);
        osc.connect(g);
        g.connect(bp);
        eng.schedule(osc, at, at + decay + 0.03, [g]);
        eng.schedule(vib, at, at + decay + 0.03, [vibGain]);
        dur = Math.max(dur, i * 0.075 + decay);
      }
      noiseBurst(eng, bp, t, { type: 'bandpass', freq: 3600, freqEnd: 1400, q: 3, gain: 0.12, attack: 0.001, decay: 0.06 });
      return { duration: dur + 0.5, stop: disposer(own) };
    }, { bus: 'sfx', category: 'impact', pos: toPos(pos3), gain: 0.8, reverb: 0.3, refDistance: 6, maxDistance: 200 });
  }

  // ------------------------------------------------------------------ impacts

  /**
   * A full explosion: sub-bass drop, noise blast, crackle grains, debris tail, a long
   * reverb send and a distant slap-back echo.
   * @param {ArrayLike<number>} [pos3] World position.
   * @param {object} [opts] Options: `{gain, size}` where size scales the low end.
   * @returns {object|null} Playback handle, or null when audio is off.
   */
  explosion(pos3, opts) {
    if (!this.ready) return null;
    const o = opts || {};
    const size = clampNum(num(o.size, 1), 0.4, 2.2);
    const vol = clampNum(num(o.gain, 1), 0, 3);
    const eng = this.engine;
    return eng.playSound((ctx, dest, t) => {
      const own = [];
      const sum = ctx.createGain();
      sum.gain.value = vol;
      sum.connect(dest);
      own.push(sum);
      const echo = slapback(eng, dest, own, { time: 0.29, feedback: 0.33, gain: 0.4, cutoff: 900 });
      sum.connect(echo);

      // Sub-bass drop.
      tone(eng, sum, t, {
        type: 'sine', freq: 96 * size, freqEnd: 26, glide: 0.85 * size,
        gain: 1.0, attack: 0.006, decay: 1.15 * size,
      });
      // Main blast.
      noiseBurst(eng, sum, t, {
        type: 'lowpass', freq: 6800, freqEnd: 300, sweep: 0.9 * size, q: 0.9,
        gain: 0.95, attack: 0.004, decay: 1.25 * size, drive: 6,
      });
      // Mid punch.
      noiseBurst(eng, sum, t, {
        type: 'bandpass', freq: 240, q: 1.1, gain: 0.55, attack: 0.003, decay: 0.36,
      });
      // Crackle grains, denser at the start.
      for (let i = 0; i < 26; i++) {
        const at = t + Math.pow(Math.random(), 1.7) * 1.35 * size + 0.02;
        noiseBurst(eng, sum, at, {
          type: 'bandpass', freq: rnd(1400, 5200), q: 3.2,
          gain: rnd(0.04, 0.15), attack: 0.0006, decay: rnd(0.018, 0.07),
        });
      }
      // Debris / dust tail.
      noiseBurst(eng, sum, t + 0.06, {
        kind: 'brown', type: 'lowpass', freq: 900, freqEnd: 320, sweep: 1.4,
        q: 0.7, gain: 0.28, attack: 0.18, decay: 1.7,
      });
      return { duration: 2.4 * size, stop: disposer(own) };
    }, { bus: 'sfx', category: 'impact', pos: toPos(pos3), gain: 1, reverb: 0.9, refDistance: 14, maxDistance: 700, rolloff: 0.85 });
  }

  /**
   * Metal-on-metal car crash: several detuned noise bursts, a bent-metal resonance and a
   * low body thump. Debris and glass are added for heavy hits.
   * @param {number} force Impact strength (0..1 normalised, or a speed in m/s).
   * @param {ArrayLike<number>} [pos3] World position.
   * @returns {object|null} Playback handle, or null when audio is off.
   */
  carCollision(force, pos3) {
    if (!this.ready) return null;
    const raw = safeValue(force, 0.4);
    const f = clampNum(raw <= 1 ? raw : 1 - Math.exp(-raw / 10), 0.06, 1);
    const eng = this.engine;
    return eng.playSound((ctx, dest, t) => {
      const own = [];
      const sum = ctx.createGain();
      sum.gain.value = 0.35 + 0.65 * f;
      sum.connect(dest);
      own.push(sum);

      const bands = [380, 860, 2100, 3600];
      const decays = [0.13, 0.095, 0.06, 0.035];
      for (let i = 0; i < bands.length; i++) {
        noiseBurst(eng, sum, t + i * 0.004, {
          type: 'bandpass',
          freq: bands[i] * rnd(0.88, 1.14),
          q: 1.6 + i * 0.6,
          gain: (0.55 - i * 0.09) * (0.4 + 0.6 * f),
          attack: 0.001,
          decay: decays[i] * (0.6 + 0.6 * f),
          drive: 3,
        });
      }
      // Bent sheet metal: two resonant tones bending down, with a fast FM buzz.
      for (let i = 0; i < 2; i++) {
        const base = (i === 0 ? 330 : 520) * rnd(0.92, 1.1);
        const osc = eng.createOsc(i === 0 ? 'triangle' : 'sawtooth', base);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = base * 2;
        bp.Q.value = 6;
        const g = ctx.createGain();
        setAt(osc.frequency, clampFreq(base), t);
        expTo(osc.frequency, clampFreq(base * 0.72), t + 0.26, MIN_FREQ);
        envAD(g.gain, 0.22 * f, t, 0.004, 0.26 + 0.2 * f);
        const fm = eng.createOsc('sine', rnd(34, 58));
        const fmGain = ctx.createGain();
        fmGain.gain.value = base * 0.12;
        fm.connect(fmGain);
        fmGain.connect(osc.frequency);
        osc.connect(bp);
        bp.connect(g);
        g.connect(sum);
        eng.schedule(osc, t, t + 0.6, [bp, g]);
        eng.schedule(fm, t, t + 0.6, [fmGain]);
      }
      // Body thump.
      tone(eng, sum, t, {
        type: 'sine', freq: 92, freqEnd: 44, glide: 0.2, gain: 0.9 * f, attack: 0.003, decay: 0.24,
      });
      if (f > 0.5) {
        for (let i = 0; i < 8; i++) {
          noiseBurst(eng, sum, t + rnd(0.05, 0.45), {
            type: 'bandpass', freq: rnd(2600, 7200), q: 4,
            gain: rnd(0.02, 0.06) * f, attack: 0.0008, decay: rnd(0.02, 0.06),
          });
        }
      }
      return { duration: 0.9, stop: disposer(own) };
    }, { bus: 'vehicle', category: 'impact', pos: toPos(pos3), gain: 1, reverb: 0.28 * f, refDistance: 8, maxDistance: 300 });
  }

  /**
   * Breaking glass: an initial crash followed by a cloud of randomised shard grains and a
   * sparse tinkle tail.
   * @param {ArrayLike<number>} [pos3] World position.
   * @param {number} [amount] Density 0..1.
   * @returns {object|null} Playback handle, or null when audio is off.
   */
  glassBreak(pos3, amount) {
    if (!this.ready) return null;
    const a = clampNum(num(amount, 1), 0.2, 1);
    const eng = this.engine;
    return eng.playSound((ctx, dest, t) => {
      noiseBurst(eng, dest, t, {
        type: 'highpass', freq: 2300, q: 0.7, gain: 0.55 * a, attack: 0.001, decay: 0.14, drive: 2,
      });
      tone(eng, dest, t, { type: 'sine', freq: 140, freqEnd: 90, glide: 0.08, gain: 0.22 * a, attack: 0.002, decay: 0.1 });
      const shards = Math.round(16 + 14 * a);
      for (let i = 0; i < shards; i++) {
        const at = t + Math.pow(Math.random(), 1.5) * 0.55;
        const f = rnd(2200, 8200);
        tone(eng, dest, at, {
          type: Math.random() < 0.65 ? 'sine' : 'triangle',
          freq: f, freqEnd: f * rnd(0.72, 0.95), glide: rnd(0.02, 0.07),
          gain: rnd(0.025, 0.11) * a, attack: 0.0008, decay: rnd(0.02, 0.09),
        });
      }
      for (let i = 0; i < 9; i++) {
        const at = t + rnd(0.3, 1.1);
        bell(eng, dest, at, Math.round(rnd(88, 105)), rnd(0.012, 0.045) * a, rnd(0.06, 0.16));
      }
      noiseBurst(eng, dest, t + 0.25, {
        type: 'highpass', freq: 5200, q: 0.6, gain: 0.06 * a, attack: 0.05, decay: 0.6,
      });
      return 1.3;
    }, { bus: 'sfx', category: 'impact', pos: toPos(pos3), gain: 0.9, reverb: 0.3, refDistance: 6, maxDistance: 180 });
  }

  // --------------------------------------------------------------- continuous

  /**
   * Sustained tire screech. Returns a handle so the caller can follow the car and change
   * the slip intensity every frame.
   * @param {ArrayLike<number>} [pos3] World position.
   * @param {number} [intensity] Slip amount 0..1.
   * @returns {{setIntensity: Function, setPosition: Function, setVolume: Function, stop: Function, alive: boolean}}
   *   Screech handle (a silent stub when audio is off).
   */
  tireScreech(pos3, intensity) {
    if (!this.ready) return DEAD_HANDLE;
    const eng = this.engine;
    const ctx = eng.ctx;
    const i0 = clampNum(num(intensity, 0.5), 0, 1);
    const c = new ContinuousSound(eng, 'vehicle', {
      pos: toPos(pos3) || _pos,
      gain: 0.12 + 0.3 * i0,
      reverb: 0.16,
      refDistance: 6,
      maxDistance: 160,
      rolloff: 1.2,
    });
    const src = eng.noiseSource('white', 1);
    const bp = c.own(ctx.createBiquadFilter());
    bp.type = 'bandpass';
    bp.frequency.value = 1050 + i0 * 900;
    bp.Q.value = 5 + i0 * 5;
    const peak = c.own(ctx.createBiquadFilter());
    peak.type = 'peaking';
    peak.frequency.value = 2500;
    peak.Q.value = 2.5;
    peak.gain.value = 7;
    const hp = c.own(ctx.createBiquadFilter());
    hp.type = 'highpass';
    hp.frequency.value = 420;
    // Slight FM warble so the squeal never sounds like a static sine.
    const lfo = c.own(ctx.createOscillator());
    lfo.type = 'sine';
    lfo.frequency.value = 6.6;
    const lfoDepth = c.own(ctx.createGain());
    lfoDepth.gain.value = 110;
    lfo.connect(lfoDepth);
    lfoDepth.connect(bp.frequency);
    const wob = c.own(ctx.createOscillator());
    wob.type = 'sine';
    wob.frequency.value = 0.9;
    const wobDepth = c.own(ctx.createGain());
    wobDepth.gain.value = 0.14;
    const amp = c.own(ctx.createGain());
    amp.gain.value = 1;
    wob.connect(wobDepth);
    wobDepth.connect(amp.gain);
    if (src) {
      src.connect(hp);
      hp.connect(bp);
      bp.connect(peak);
      peak.connect(amp);
      amp.connect(c.out);
      c.play(src, eng.now);
    }
    c.play(lfo, eng.now);
    c.play(wob, eng.now);
    c.fadeIn(0.08);

    const self = this;
    const handle = {
      alive: true,
      sound: c,
      /**
       * Updates the slip intensity.
       * @param {number} v 0..1.
       * @returns {void}
       */
      setIntensity(v) {
        if (!c.alive) return;
        const i = clampNum(v, 0, 1);
        const t = eng.now;
        targetAt(bp.frequency, clampFreq(1050 + i * 900), t, 0.05);
        targetAt(bp.Q, 5 + i * 5, t, 0.08);
        targetAt(lfoDepth.gain, 70 + i * 120, t, 0.08);
        targetAt(c.out.gain, Math.max(MIN_GAIN, 0.06 + 0.36 * i), t, 0.06);
        c.level = 0.06 + 0.36 * i;
      },
      /**
       * Moves the screech.
       * @param {number|ArrayLike<number>} x X or a position array.
       * @param {number} [y] Y.
       * @param {number} [z] Z.
       * @returns {void}
       */
      setPosition(x, y, z) {
        c.setPosition(x, y, z);
      },
      /**
       * Sets the output level directly.
       * @param {number} v Gain.
       * @returns {void}
       */
      setVolume(v) {
        c.setVolume(v);
      },
      /**
       * Stops the screech.
       * @param {number} [fade] Fade length.
       * @returns {void}
       */
      stop(fade = 0.12) {
        handle.alive = false;
        c.stop(fade);
        self.active.delete(handle);
      },
    };
    return this._track(handle);
  }

  /**
   * Creates a vehicle engine voice.
   * @param {*} vehicle Vehicle instance, type object or type key.
   * @returns {EngineVoice|object} The engine voice (a silent stub when audio is off).
   */
  createEngine(vehicle) {
    if (!this.ready) return DEAD_HANDLE;
    const voice = new EngineVoice(this, vehicle);
    const self = this;
    const stop = voice.stop.bind(voice);
    voice.stop = () => {
      stop();
      self.active.delete(voice);
    };
    return this._track(voice);
  }

  /**
   * Police siren: a two-tone wail that alternates between wail, yelp and hi-lo patterns.
   * @param {ArrayLike<number>} [pos3] World position.
   * @returns {{stop: Function, setPosition: Function, setVolume: Function, alive: boolean}}
   *   Siren handle (a silent stub when audio is off).
   */
  siren(pos3) {
    if (!this.ready) return DEAD_HANDLE;
    const eng = this.engine;
    const ctx = eng.ctx;
    const c = new ContinuousSound(eng, 'vehicle', {
      pos: toPos(pos3) || _pos,
      gain: 0.5,
      reverb: 0.35,
      refDistance: 12,
      maxDistance: 380,
      rolloff: 0.95,
    });

    const base = c.own(ctx.createConstantSource());
    base.offset.value = SIREN_MODES[0].center;
    const sum = c.own(ctx.createGain());
    sum.gain.value = 1;
    base.connect(sum);

    const lfoTri = c.own(ctx.createOscillator());
    lfoTri.type = 'triangle';
    lfoTri.frequency.value = SIREN_MODES[0].tri;
    const depthTri = c.own(ctx.createGain());
    depthTri.gain.value = SIREN_MODES[0].triDepth;
    lfoTri.connect(depthTri);
    depthTri.connect(sum);

    const lfoSq = c.own(ctx.createOscillator());
    lfoSq.type = 'square';
    lfoSq.frequency.value = SIREN_MODES[2].sq;
    const depthSq = c.own(ctx.createGain());
    depthSq.gain.value = 0;
    lfoSq.connect(depthSq);
    depthSq.connect(sum);

    const osc = c.own(ctx.createOscillator());
    osc.type = 'sawtooth';
    osc.frequency.value = 0;
    sum.connect(osc.frequency);
    const sub = c.own(ctx.createOscillator());
    sub.type = 'square';
    sub.frequency.value = 0;
    const half = c.own(ctx.createGain());
    half.gain.value = 0.5;
    sum.connect(half);
    half.connect(sub.frequency);

    const lp = c.own(ctx.createBiquadFilter());
    lp.type = 'lowpass';
    lp.frequency.value = 3400;
    lp.Q.value = 3.5;
    const hp = c.own(ctx.createBiquadFilter());
    hp.type = 'highpass';
    hp.frequency.value = 380;
    const subGain = c.own(ctx.createGain());
    subGain.gain.value = 0.18;
    const shaper = c.own(eng.createDistortion(2.2));
    osc.connect(lp);
    sub.connect(subGain);
    subGain.connect(lp);
    lp.connect(hp);
    hp.connect(shaper);
    shaper.connect(c.out);

    c.play(base, eng.now);
    c.play(lfoTri, eng.now);
    c.play(lfoSq, eng.now);
    c.play(osc, eng.now);
    c.play(sub, eng.now);
    c.fadeIn(0.3);

    let mode = 0;
    c.schedule(new EventScheduler(eng, 3, (time) => {
      const m = SIREN_MODES[mode % SIREN_MODES.length];
      mode++;
      holdAt(base.offset, time);
      linTo(base.offset, m.center, time + 0.18);
      setAt(lfoTri.frequency, m.tri, time);
      setAt(lfoSq.frequency, m.sq, time);
      holdAt(depthTri.gain, time);
      linTo(depthTri.gain, m.triDepth, time + 0.18);
      holdAt(depthSq.gain, time);
      linTo(depthSq.gain, m.sqDepth, time + 0.18);
      return m.hold;
    }).start(500));

    const self = this;
    const handle = {
      alive: true,
      sound: c,
      /**
       * Moves the siren.
       * @param {number|ArrayLike<number>} x X or a position array.
       * @param {number} [y] Y.
       * @param {number} [z] Z.
       * @returns {void}
       */
      setPosition(x, y, z) {
        c.setPosition(x, y, z);
      },
      /**
       * Sets the siren level.
       * @param {number} v Gain.
       * @returns {void}
       */
      setVolume(v) {
        c.setVolume(v);
      },
      /**
       * Stops the siren.
       * @param {number} [fade] Fade length.
       * @returns {void}
       */
      stop(fade = 0.25) {
        handle.alive = false;
        c.stop(fade);
        self.active.delete(handle);
      },
    };
    return this._track(handle);
  }

  // -------------------------------------------------------------------- body

  /**
   * A footstep with surface-specific spectra and randomised pitch so repeats never sound
   * identical.
   * @param {string} [surface] `'concrete'|'grass'|'metal'|'water'|'gravel'|...`.
   * @param {ArrayLike<number>} [pos3] World position.
   * @param {boolean} [running] Louder, brighter and shorter when true.
   * @returns {object|null} Playback handle, or null when audio is off.
   */
  footstep(surface, pos3, running) {
    if (!this.ready) return null;
    const p = FOOT_PROFILES[surface] || FOOT_PROFILES.concrete;
    const eng = this.engine;
    const run = !!running;
    this._footIndex++;
    // Alternating feet plus random jitter: no two steps are the same.
    const foot = this._footIndex & 1 ? 1.07 : 0.94;
    const j = rnd(0.9, 1.12) * foot;
    const gain = p.gain * (run ? 1.5 : 1);
    return eng.playSound((ctx, dest, t) => {
      let dur = noiseBurst(eng, dest, t, {
        type: p.type,
        freq: p.freq * j,
        freqEnd: p.freq * j * 0.55,
        sweep: p.decay,
        q: p.q,
        gain: gain,
        attack: 0.0015,
        decay: p.decay * (run ? 0.85 : 1),
      });
      // Low weight of the body.
      dur = Math.max(dur, tone(eng, dest, t, {
        type: 'sine', freq: 118 * j, freqEnd: 68, glide: 0.06,
        gain: gain * 0.55, attack: 0.002, decay: 0.075,
      }));
      if (p.clickGain > 0) {
        noiseBurst(eng, dest, t, {
          type: 'highpass', freq: p.click * j, q: 0.8, gain: p.clickGain * (run ? 1.4 : 1),
          attack: 0.0005, decay: 0.012,
        });
      }
      if (p.ring > 0) {
        dur = Math.max(dur, ring(eng, dest, t + 0.002, p.ring * j, [1, 2.3, 3.6], gain * 0.35, 0.16));
      }
      if (p.tail > 0) {
        dur = Math.max(dur, noiseBurst(eng, dest, t + 0.01, {
          kind: 'pink', type: 'highpass', freq: 3400 * j, q: 0.6,
          gain: gain * 0.5, attack: 0.008, decay: p.tail,
        }));
      }
      return dur;
    }, { bus: 'sfx', category: 'foot', pos: toPos(pos3), gain: run ? 1 : 0.8, reverb: 0.1, refDistance: 3, maxDistance: 45 });
  }

  /**
   * Push-off for a jump: cloth rustle plus a soft scuff.
   * @param {ArrayLike<number>} [pos3] World position.
   * @returns {object|null} Playback handle, or null when audio is off.
   */
  jump(pos3) {
    if (!this.ready) return null;
    const eng = this.engine;
    return eng.playSound((ctx, dest, t) => {
      noiseBurst(eng, dest, t, { kind: 'pink', type: 'bandpass', freq: 900, freqEnd: 2200, sweep: 0.12, q: 0.9, gain: 0.16, attack: 0.006, decay: 0.13 });
      noiseBurst(eng, dest, t, { type: 'bandpass', freq: 1500, q: 1.1, gain: 0.16, attack: 0.002, decay: 0.05 });
      tone(eng, dest, t, { type: 'sine', freq: 150, freqEnd: 95, glide: 0.08, gain: 0.2, attack: 0.003, decay: 0.09 });
      return 0.2;
    }, { bus: 'sfx', category: 'foot', pos: toPos(pos3), gain: 0.8, reverb: 0.08, refDistance: 3, maxDistance: 40 });
  }

  /**
   * Landing thud, scaled by the impact speed.
   * @param {ArrayLike<number>} [pos3] World position.
   * @param {number} [force] Impact speed in m/s (optional).
   * @returns {object|null} Playback handle, or null when audio is off.
   */
  land(pos3, force) {
    if (!this.ready) return null;
    const f = clampNum(num(force, 5) / 12, 0.25, 1.4);
    const eng = this.engine;
    return eng.playSound((ctx, dest, t) => {
      tone(eng, dest, t, { type: 'sine', freq: 105, freqEnd: 52, glide: 0.1, gain: 0.55 * f, attack: 0.002, decay: 0.16 });
      noiseBurst(eng, dest, t, { type: 'lowpass', freq: 1400, freqEnd: 500, sweep: 0.1, q: 0.8, gain: 0.34 * f, attack: 0.001, decay: 0.11 });
      noiseBurst(eng, dest, t + 0.008, { kind: 'pink', type: 'bandpass', freq: 2600, q: 0.8, gain: 0.1 * f, attack: 0.004, decay: 0.1 });
      return 0.3;
    }, { bus: 'sfx', category: 'foot', pos: toPos(pos3), gain: 0.9, reverb: 0.12, refDistance: 3, maxDistance: 60 });
  }

  /**
   * A punch: air whoosh, dull impact and a slap transient.
   * @param {ArrayLike<number>} [pos3] World position.
   * @param {boolean} [hit] True when the punch actually connects.
   * @returns {object|null} Playback handle, or null when audio is off.
   */
  punch(pos3, hit) {
    if (!this.ready) return null;
    const eng = this.engine;
    const connected = hit !== false;
    return eng.playSound((ctx, dest, t) => {
      // Whoosh of the arm.
      noiseBurst(eng, dest, t, {
        kind: 'pink', type: 'bandpass', freq: 1800, freqEnd: 500, sweep: 0.1, q: 1.4,
        gain: 0.18, attack: 0.02, decay: 0.1,
      });
      if (!connected) return 0.2;
      const at = t + 0.06;
      tone(eng, dest, at, { type: 'sine', freq: 128, freqEnd: 62, glide: 0.07, gain: 0.5, attack: 0.002, decay: 0.13 });
      noiseBurst(eng, dest, at, { type: 'lowpass', freq: 1200, q: 0.9, gain: 0.4, attack: 0.001, decay: 0.07, drive: 2.5 });
      noiseBurst(eng, dest, at, { type: 'bandpass', freq: 2600, q: 1.4, gain: 0.14, attack: 0.0006, decay: 0.03 });
      return 0.3;
    }, { bus: 'sfx', category: 'impact', pos: toPos(pos3), gain: 0.9, reverb: 0.12, refDistance: 3, maxDistance: 50 });
  }

  /**
   * A body hitting the ground: heavy soft thud plus secondary limb bumps and cloth.
   * @param {ArrayLike<number>} [pos3] World position.
   * @returns {object|null} Playback handle, or null when audio is off.
   */
  bodyFall(pos3) {
    if (!this.ready) return null;
    const eng = this.engine;
    return eng.playSound((ctx, dest, t) => {
      tone(eng, dest, t, { type: 'sine', freq: 88, freqEnd: 42, glide: 0.12, gain: 0.6, attack: 0.004, decay: 0.24 });
      noiseBurst(eng, dest, t, { type: 'lowpass', freq: 900, freqEnd: 300, sweep: 0.16, q: 0.7, gain: 0.42, attack: 0.003, decay: 0.2, drive: 2 });
      noiseBurst(eng, dest, t + 0.005, { kind: 'pink', type: 'bandpass', freq: 2400, q: 0.8, gain: 0.12, attack: 0.01, decay: 0.18 });
      // Secondary limb impacts.
      const bumps = 2 + (Math.random() < 0.5 ? 1 : 0);
      for (let i = 0; i < bumps; i++) {
        const at = t + rnd(0.09, 0.34);
        tone(eng, dest, at, { type: 'sine', freq: rnd(70, 120), freqEnd: 45, glide: 0.07, gain: rnd(0.1, 0.24), attack: 0.003, decay: 0.13 });
        noiseBurst(eng, dest, at, { type: 'lowpass', freq: rnd(600, 1200), q: 0.7, gain: rnd(0.06, 0.16), attack: 0.002, decay: 0.09 });
      }
      return 0.7;
    }, { bus: 'sfx', category: 'impact', pos: toPos(pos3), gain: 0.9, reverb: 0.18, refDistance: 4, maxDistance: 70 });
  }

  // ---------------------------------------------------------------- vehicles

  /**
   * Vehicle horn. Two detuned tones a musical interval apart through a resonant filter and
   * a soft clipper; trucks and buses get a low air horn instead.
   * @param {ArrayLike<number>} [pos3] World position.
   * @param {string} [type] Vehicle type key.
   * @returns {object|null} Playback handle, or null when audio is off.
   */
  horn(pos3, type) {
    if (!this.ready) return null;
    const key = String(type || 'sedan').toLowerCase();
    const p = HORN_PROFILES[key] || HORN_PROFILES.sedan;
    const eng = this.engine;
    return eng.playSound((ctx, dest, t) => {
      const own = [];
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = clampFreq(p.b * 2.2);
      bp.Q.value = 0.9;
      const peak = ctx.createBiquadFilter();
      peak.type = 'peaking';
      peak.frequency.value = clampFreq(p.cut);
      peak.Q.value = 1.4;
      peak.gain.value = 6;
      const shaper = eng.createDistortion(p.drive);
      const g = ctx.createGain();
      const attack = 0.012;
      const rel = 0.09;
      setAt(g.gain, MIN_GAIN, t);
      expTo(g.gain, p.gain, t + attack);
      setAt(g.gain, p.gain, t + p.dur);
      expTo(g.gain, MIN_GAIN, t + p.dur + rel);
      bp.connect(peak);
      peak.connect(shaper);
      shaper.connect(g);
      g.connect(dest);
      own.push(bp, peak, shaper, g);

      const freqs = [p.a, p.b, p.a * 2, p.b * 2];
      const gains = [1, 0.9, 0.35, 0.3];
      for (let i = 0; i < freqs.length; i++) {
        const osc = eng.createOsc(p.type, freqs[i], i % 2 ? 5 : -5);
        const og = ctx.createGain();
        og.gain.value = gains[i] * 0.32;
        osc.connect(og);
        og.connect(bp);
        eng.schedule(osc, t, t + p.dur + rel + 0.05, [og]);
      }
      if (p.air > 0) {
        noiseBurst(eng, g, t, { kind: 'pink', type: 'bandpass', freq: 1400, q: 0.7, gain: p.air, attack: 0.02, decay: p.dur });
      }
      return { duration: p.dur + rel + 0.05, stop: disposer(own) };
    }, { bus: 'vehicle', category: 'vehicle', pos: toPos(pos3), gain: 1, reverb: 0.3, refDistance: 10, maxDistance: 320 });
  }

  /**
   * Car door opening: latch click plus a short hinge creak.
   * @param {ArrayLike<number>} [pos3] World position.
   * @returns {object|null} Playback handle, or null when audio is off.
   */
  doorOpen(pos3) {
    if (!this.ready) return null;
    const eng = this.engine;
    return eng.playSound((ctx, dest, t) => {
      noiseBurst(eng, dest, t, { type: 'highpass', freq: 3000, q: 0.8, gain: 0.3, attack: 0.0008, decay: 0.03 });
      ring(eng, dest, t, 1300 * rnd(0.95, 1.06), [1, 1.83], 0.14, 0.06);
      // Hinge creak: a resonant band rising slowly.
      noiseBurst(eng, dest, t + 0.05, {
        kind: 'pink', type: 'bandpass', freq: 700, freqEnd: 1500, sweep: 0.22, q: 7,
        gain: 0.1, attack: 0.05, decay: 0.24,
      });
      tone(eng, dest, t + 0.02, { type: 'triangle', freq: 190, freqEnd: 140, glide: 0.1, gain: 0.16, attack: 0.006, decay: 0.16, lp: 900 });
      return 0.42;
    }, { bus: 'vehicle', category: 'vehicle', pos: toPos(pos3), gain: 0.85, reverb: 0.14, refDistance: 4, maxDistance: 70 });
  }

  /**
   * Car door closing: heavy thunk, latch click and a short body ring.
   * @param {ArrayLike<number>} [pos3] World position.
   * @returns {object|null} Playback handle, or null when audio is off.
   */
  doorClose(pos3) {
    if (!this.ready) return null;
    const eng = this.engine;
    return eng.playSound((ctx, dest, t) => {
      tone(eng, dest, t, { type: 'sine', freq: 132, freqEnd: 62, glide: 0.09, gain: 0.5, attack: 0.002, decay: 0.16 });
      noiseBurst(eng, dest, t, { type: 'lowpass', freq: 1100, freqEnd: 380, sweep: 0.1, q: 0.8, gain: 0.42, attack: 0.001, decay: 0.13, drive: 2.4 });
      noiseBurst(eng, dest, t + 0.028, { type: 'highpass', freq: 3400, q: 0.9, gain: 0.16, attack: 0.0006, decay: 0.02 });
      ring(eng, dest, t + 0.01, 620 * rnd(0.95, 1.05), [1, 2.4, 3.9], 0.1, 0.12);
      return 0.4;
    }, { bus: 'vehicle', category: 'vehicle', pos: toPos(pos3), gain: 0.9, reverb: 0.16, refDistance: 4, maxDistance: 80 });
  }

  // ---------------------------------------------------------------------- ui

  /**
   * Pickup jingle. Short, musical and different per pickup kind.
   * @param {string} [kind] `'health'|'armor'|'money'|'ammo'|'weapon'`.
   * @param {ArrayLike<number>} [pos3] Optional world position.
   * @returns {object|null} Playback handle, or null when audio is off.
   */
  pickup(kind, pos3) {
    if (!this.ready) return null;
    const p = PICKUP_NOTES[kind] || PICKUP_NOTES.health;
    const eng = this.engine;
    return eng.playSound((ctx, dest, t) => {
      let end = 0;
      for (let i = 0; i < p.notes.length; i++) {
        const at = t + i * 0.075;
        if (p.bell > 0) bell(eng, dest, at, p.notes[i], p.gain * p.bell, 0.42);
        tone(eng, dest, at, {
          type: p.type, freq: mtof(p.notes[i]), gain: p.gain * (1 - p.bell * 0.5),
          attack: 0.006, hold: 0.02, decay: 0.22, lp: 5200,
        });
        end = i * 0.075 + 0.48;
      }
      if (kind === 'weapon') {
        for (let i = 0; i < 3; i++) {
          noiseBurst(eng, dest, t + i * 0.035, { type: 'bandpass', freq: 2200 + i * 500, q: 3, gain: 0.1, attack: 0.0008, decay: 0.03 });
        }
      }
      if (kind === 'money') {
        noiseBurst(eng, dest, t, { type: 'highpass', freq: 6200, q: 0.7, gain: 0.08, attack: 0.001, decay: 0.05 });
      }
      return end;
    }, { bus: 'ui', category: 'ui', pos: toPos(pos3), gain: 1, reverb: 0.12 });
  }

  /**
   * A crisp, musical UI blip drawn from a small pentatonic set.
   * @param {string} [kind] `'click'|'hover'|'confirm'|'back'|'error'|'toggle'|'open'|'close'|'tick'|'select'`.
   * @returns {object|null} Playback handle, or null when audio is off.
   */
  uiClick(kind) {
    if (!this.ready) return null;
    const p = UI_SOUNDS[kind] || UI_SOUNDS.click;
    const eng = this.engine;
    const isError = kind === 'error';
    return eng.playSound((ctx, dest, t) => {
      let end = 0;
      for (let i = 0; i < p.notes.length; i++) {
        const at = t + i * (p.dur * 0.75);
        const f = mtof(p.notes[i]);
        tone(eng, dest, at, {
          type: p.type, freq: f, gain: p.gain, attack: 0.003, decay: p.dur, lp: isError ? 2600 : 6800,
        });
        // A quiet octave above keeps the blip bright without being harsh.
        tone(eng, dest, at, { type: 'sine', freq: f * 2, gain: p.gain * 0.25, attack: 0.002, decay: p.dur * 0.6, lp: 9000 });
        if (isError) tone(eng, dest, at, { type: 'triangle', freq: f * 1.06, gain: p.gain * 0.5, attack: 0.004, decay: p.dur, lp: 2200 });
        end = i * (p.dur * 0.75) + p.dur + 0.04;
      }
      noiseBurst(eng, dest, t, { type: 'highpass', freq: 5200, q: 0.6, gain: p.gain * 0.12, attack: 0.0005, decay: 0.008 });
      return end;
    }, { bus: 'ui', category: 'ui', gain: 1, reverb: 0.05 });
  }

  /**
   * Notification sting used by the HUD toasts.
   * @param {string} [kind] `'info'|'warn'|'money'|'mission'|'wanted'`.
   * @returns {object|null} Playback handle, or null when audio is off.
   */
  notify(kind) {
    if (!this.ready) return null;
    const p = NOTIFY_SOUNDS[kind] || NOTIFY_SOUNDS.info;
    const eng = this.engine;
    return eng.playSound((ctx, dest, t) => {
      let end = 0;
      for (let i = 0; i < p.notes.length; i++) {
        const at = t + i * p.dur;
        bell(eng, dest, at, p.notes[i], p.gain * p.bell, 0.55);
        tone(eng, dest, at, {
          type: kind === 'warn' ? 'sawtooth' : 'triangle',
          freq: mtof(p.notes[i]), gain: p.gain * 0.6, attack: 0.008, hold: 0.03, decay: 0.3, lp: 4200,
        });
        end = i * p.dur + 0.6;
      }
      return end;
    }, { bus: 'ui', category: 'ui', gain: 1, reverb: 0.2 });
  }

  /**
   * The tense "wanted level up" sting: brass cluster, timpani, noise riser and a sub drop.
   * @param {number} [level] New wanted level 1..5.
   * @returns {object|null} Playback handle, or null when audio is off.
   */
  wanted(level) {
    if (!this.ready) return null;
    const lv = clampNum(Math.round(num(level, 1)), 1, 5);
    const eng = this.engine;
    const root = 40 + lv; // rises with the heat
    return eng.playSound((ctx, dest, t) => {
      const chord = [root, root + 3, root + 7, root + 12];
      if (lv >= 3) chord.push(root + 6); // tritone bite for high heat
      if (lv >= 5) chord.push(root + 15);
      brassChord(eng, dest, t + 0.02, chord, 0.55 + lv * 0.05, 0.5, { attack: 0.03, release: 0.5, cut: 1800 + lv * 320 });
      timpani(eng, dest, t, root - 12, 0.6);
      timpani(eng, dest, t + 0.3, root - 12, 0.36);
      // Rising noise riser.
      noiseBurst(eng, dest, t, {
        kind: 'pink', type: 'highpass', freq: 300, freqEnd: 6500, sweep: 0.6, q: 0.8,
        gain: 0.22, attack: 0.4, decay: 0.35,
      });
      // Sub drop underneath.
      tone(eng, dest, t + 0.02, { type: 'sine', freq: mtof(root) * 0.5, freqEnd: mtof(root) * 0.25, glide: 0.9, gain: 0.4, attack: 0.02, decay: 1 });
      return 1.6;
    }, { bus: 'ui', category: 'voice', gain: 1, reverb: 0.5 });
  }

  /**
   * Mission complete: a I - V - I cadence in C major on a brass stack with timpani and a
   * celesta sparkle on the final chord.
   * @returns {object|null} Playback handle, or null when audio is off.
   */
  missionSuccess() {
    if (!this.ready) return null;
    const eng = this.engine;
    return eng.playSound((ctx, dest, t) => {
      const I = [48, 52, 55, 60];
      const V = [43, 47, 50, 55];
      const I2 = [48, 52, 55, 60, 64];
      brassChord(eng, dest, t, I, 0.26, 0.42, { attack: 0.025, release: 0.12, cut: 2600 });
      brassChord(eng, dest, t + 0.34, V, 0.26, 0.42, { attack: 0.025, release: 0.12, cut: 2800 });
      brassChord(eng, dest, t + 0.68, I2, 1.15, 0.5, { attack: 0.03, release: 0.7, cut: 3200 });
      timpani(eng, dest, t, 36, 0.5);
      timpani(eng, dest, t + 0.34, 43, 0.42);
      timpani(eng, dest, t + 0.68, 36, 0.55);
      timpani(eng, dest, t + 0.86, 36, 0.28);
      const sparkle = [72, 76, 79, 84];
      for (let i = 0; i < sparkle.length; i++) {
        bell(eng, dest, t + 0.72 + i * 0.075, sparkle[i], 0.16, 0.9);
      }
      return 2.6;
    }, { bus: 'ui', category: 'voice', gain: 1, reverb: 0.55 });
  }

  /**
   * Mission failed: a dark i - bVI - i cadence in C minor with a timpani roll and a slow
   * sub-bass fall.
   * @returns {object|null} Playback handle, or null when audio is off.
   */
  missionFail() {
    if (!this.ready) return null;
    const eng = this.engine;
    return eng.playSound((ctx, dest, t) => {
      const i1 = [48, 51, 55, 60];
      const bVI = [44, 51, 56, 60];
      const i2 = [36, 43, 48, 51];
      brassChord(eng, dest, t, i1, 0.3, 0.4, { attack: 0.04, release: 0.16, cut: 1800 });
      brassChord(eng, dest, t + 0.42, bVI, 0.3, 0.4, { attack: 0.05, release: 0.18, cut: 1500 });
      brassChord(eng, dest, t + 0.86, i2, 1.4, 0.46, { attack: 0.08, release: 0.9, cut: 1100 });
      // Timpani roll into the final chord.
      for (let i = 0; i < 5; i++) {
        timpani(eng, dest, t + 0.55 + i * 0.07, 36, 0.12 + i * 0.05);
      }
      timpani(eng, dest, t + 0.86, 36, 0.55);
      tone(eng, dest, t + 0.86, { type: 'sine', freq: 92, freqEnd: 38, glide: 1.4, gain: 0.42, attack: 0.05, decay: 1.6 });
      return 3;
    }, { bus: 'ui', category: 'voice', gain: 1, reverb: 0.6 });
  }

  /**
   * Police radio squelch and static, used for wanted-level chatter.
   * @param {ArrayLike<number>} [pos3] Optional world position.
   * @returns {object|null} Playback handle, or null when audio is off.
   */
  radioStatic(pos3) {
    if (!this.ready) return null;
    const eng = this.engine;
    return eng.playSound((ctx, dest, t) => {
      const own = [];
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1800;
      bp.Q.value = 1.6;
      const shaper = eng.createDistortion(3.5);
      bp.connect(shaper);
      shaper.connect(dest);
      own.push(bp, shaper);
      // Squelch chirp.
      tone(eng, bp, t, { type: 'square', freq: 1800, freqEnd: 900, glide: 0.05, gain: 0.16, attack: 0.002, decay: 0.06 });
      // Static bed with random band jumps.
      const src = eng.noiseSource('white', 1);
      const g = ctx.createGain();
      setAt(g.gain, MIN_GAIN, t);
      expTo(g.gain, 0.2, t + 0.02);
      setAt(g.gain, 0.2, t + 0.4);
      expTo(g.gain, MIN_GAIN, t + 0.55);
      if (src) {
        src.connect(g);
        g.connect(bp);
        eng.schedule(src, t, t + 0.6, [g]);
      }
      for (let i = 0; i < 7; i++) {
        setAt(bp.frequency, clampFreq(rnd(900, 2600)), t + 0.05 + i * 0.06);
      }
      // Closing squelch.
      tone(eng, bp, t + 0.5, { type: 'square', freq: 1200, freqEnd: 2000, glide: 0.04, gain: 0.12, attack: 0.002, decay: 0.05 });
      return { duration: 0.75, stop: disposer(own) };
    }, { bus: 'voice', category: 'voice', pos: toPos(pos3), gain: 1, reverb: 0.12, refDistance: 4, maxDistance: 60 });
  }

  /**
   * Low-health heartbeat. Returns a handle; calling it again only updates the rate.
   * @param {number} [rate] Beats per minute (values below 10 are treated as Hz).
   * @returns {{setRate: Function, setVolume: Function, stop: Function, alive: boolean}}
   *   Heartbeat handle (a silent stub when audio is off).
   */
  heartbeat(rate) {
    if (!this.ready) return DEAD_HANDLE;
    const bpm = clampNum(num(rate, 70) < 10 ? num(rate, 1.2) * 60 : num(rate, 70), 30, 220);
    if (this._heart && this._heart.alive) {
      this._heart.setRate(bpm);
      return this._heart;
    }
    const eng = this.engine;
    const ctx = eng.ctx;
    const c = new ContinuousSound(eng, 'sfx', { gain: 0.9, reverb: 0.05 });
    const lp = c.own(ctx.createBiquadFilter());
    lp.type = 'lowpass';
    lp.frequency.value = 190;
    lp.Q.value = 1.1;
    lp.connect(c.out);
    c.fadeIn(0.2);

    let period = 60 / bpm;
    const self = this;

    /**
     * Schedules one "lub-dub" pair.
     * @param {number} at Start time.
     * @returns {number} Seconds until the next beat.
     */
    const beat = (at) => {
      const gap = period;
      tone(eng, lp, at, { type: 'sine', freq: 64, freqEnd: 34, glide: 0.09, gain: 0.85, attack: 0.006, decay: 0.2 });
      noiseBurst(eng, lp, at, { kind: 'brown', type: 'lowpass', freq: 220, q: 0.8, gain: 0.35, attack: 0.004, decay: 0.11 });
      const dub = at + Math.min(0.22, gap * 0.32);
      tone(eng, lp, dub, { type: 'sine', freq: 56, freqEnd: 30, glide: 0.1, gain: 0.55, attack: 0.008, decay: 0.24 });
      noiseBurst(eng, lp, dub, { kind: 'brown', type: 'lowpass', freq: 190, q: 0.8, gain: 0.22, attack: 0.005, decay: 0.12 });
      return gap;
    };
    c.schedule(new EventScheduler(eng, 1.2, beat).start(200));

    const handle = {
      alive: true,
      sound: c,
      /**
       * Changes the beat rate.
       * @param {number} v Beats per minute (or Hz below 10).
       * @returns {void}
       */
      setRate(v) {
        const b = clampNum(num(v, 70) < 10 ? num(v, 1.2) * 60 : num(v, 70), 30, 220);
        period = 60 / b;
      },
      /**
       * Sets the heartbeat level.
       * @param {number} v Gain.
       * @returns {void}
       */
      setVolume(v) {
        c.setVolume(v);
      },
      /**
       * Stops the heartbeat.
       * @param {number} [fade] Fade length.
       * @returns {void}
       */
      stop(fade = 0.3) {
        handle.alive = false;
        c.stop(fade);
        self.active.delete(handle);
        if (self._heart === handle) self._heart = null;
      },
    };
    this._heart = handle;
    return this._track(handle);
  }

  // ------------------------------------------------------------------ beds

  /**
   * Looping generated ambience bed. Calling it twice for the same kind returns the handle
   * that already exists instead of stacking beds.
   * @param {string} [kind] `'city'|'wind'|'rain'|'seaside'|'crowd'`.
   * @param {object} [opts] Options: `{gain}`.
   * @returns {{setVolume: Function, stop: Function, alive: boolean}} Ambience handle
   *   (a silent stub when audio is off).
   */
  ambience(kind, opts) {
    if (!this.ready) return DEAD_HANDLE;
    const key = String(kind || 'city').toLowerCase();
    const existing = this.ambiences.get(key);
    if (existing && existing.alive) return existing;
    const eng = this.engine;
    const ctx = eng.ctx;
    const o = opts || {};
    const level = clampNum(num(o.gain, 1), 0, 4);
    const c = new ContinuousSound(eng, 'ambience', { gain: level * 0.6, reverb: 0.12 });

    if (key === 'wind') {
      this._buildWind(c, level);
    } else if (key === 'rain') {
      this._buildRain(c, level);
    } else if (key === 'seaside') {
      this._buildSeaside(c, level);
    } else if (key === 'crowd') {
      this._buildCrowd(c, level);
    } else {
      this._buildCity(c, level);
    }
    c.fadeIn(1.5);

    const self = this;
    const handle = {
      alive: true,
      kind: key,
      sound: c,
      /**
       * Sets the bed level.
       * @param {number} v Gain.
       * @param {number} [ramp] Ramp length.
       * @returns {void}
       */
      setVolume(v, ramp) {
        c.setVolume(clampNum(v, 0, 4) * 0.6, num(ramp, 0.5));
      },
      /**
       * Stops and unregisters the bed.
       * @param {number} [fade] Fade length.
       * @returns {void}
       */
      stop(fade = 1.2) {
        handle.alive = false;
        c.stop(fade);
        self.ambiences.delete(key);
        self.active.delete(handle);
      },
    };
    this.ambiences.set(key, handle);
    return this._track(handle);
  }

  /**
   * City bed: brown-noise traffic rumble, a slow swell, a faint electrical hum and distant
   * horns scheduled at random intervals.
   * @param {ContinuousSound} c Container.
   * @param {number} level Level multiplier.
   * @returns {void}
   * @private
   */
  _buildCity(c, level) {
    const eng = this.engine;
    const ctx = eng.ctx;
    const src = eng.noiseSource('brown', 1);
    const lp = c.own(ctx.createBiquadFilter());
    lp.type = 'lowpass';
    lp.frequency.value = 520;
    lp.Q.value = 0.7;
    const hp = c.own(ctx.createBiquadFilter());
    hp.type = 'highpass';
    hp.frequency.value = 55;
    const g = c.own(ctx.createGain());
    g.gain.value = 0.5;
    if (src) {
      src.connect(hp);
      hp.connect(lp);
      lp.connect(g);
      g.connect(c.out);
      c.play(src, eng.now);
    }
    // Slow traffic swells.
    const swell = c.own(ctx.createOscillator());
    swell.type = 'sine';
    swell.frequency.value = 0.045;
    const swellDepth = c.own(ctx.createGain());
    swellDepth.gain.value = 0.18;
    swell.connect(swellDepth);
    swellDepth.connect(g.gain);
    c.play(swell, eng.now);
    // Faint mains hum from the neon signs.
    const hum = c.own(ctx.createOscillator());
    hum.type = 'sawtooth';
    hum.frequency.value = 60;
    const humLp = c.own(ctx.createBiquadFilter());
    humLp.type = 'lowpass';
    humLp.frequency.value = 240;
    const humGain = c.own(ctx.createGain());
    humGain.gain.value = 0.012 * level;
    hum.connect(humLp);
    humLp.connect(humGain);
    humGain.connect(c.out);
    c.play(hum, eng.now);
    // A high air layer so the bed is not purely low end.
    const air = eng.noiseSource('pink', 1);
    const airBp = c.own(ctx.createBiquadFilter());
    airBp.type = 'bandpass';
    airBp.frequency.value = 1800;
    airBp.Q.value = 0.5;
    const airGain = c.own(ctx.createGain());
    airGain.gain.value = 0.03 * level;
    if (air) {
      air.connect(airBp);
      airBp.connect(airGain);
      airGain.connect(c.out);
      c.play(air, eng.now);
    }
    // Distant horns.
    const horns = c.own(ctx.createGain());
    horns.gain.value = 0.5 * level;
    const hornLp = c.own(ctx.createBiquadFilter());
    hornLp.type = 'lowpass';
    hornLp.frequency.value = 900;
    horns.connect(hornLp);
    hornLp.connect(c.out);
    c.schedule(new EventScheduler(eng, 3, (at) => {
      const a = rnd(300, 520);
      const dur = rnd(0.18, 0.7);
      tone(eng, horns, at, { type: 'sawtooth', freq: a, gain: 0.05, attack: 0.02, hold: dur, decay: 0.12, lp: 1400 });
      tone(eng, horns, at, { type: 'sawtooth', freq: a * 1.26, gain: 0.04, attack: 0.02, hold: dur, decay: 0.12, lp: 1400 });
      if (Math.random() < 0.35) {
        tone(eng, horns, at + dur + 0.2, { type: 'sawtooth', freq: a, gain: 0.04, attack: 0.02, hold: dur * 0.6, decay: 0.12, lp: 1400 });
      }
      return rnd(4, 13);
    }).start(1000));
  }

  /**
   * Wind bed: pink noise through a drifting resonant band plus slow gusts.
   * @param {ContinuousSound} c Container.
   * @param {number} level Level multiplier.
   * @returns {void}
   * @private
   */
  _buildWind(c, level) {
    const eng = this.engine;
    const ctx = eng.ctx;
    const src = eng.noiseSource('pink', 1);
    const bp = c.own(ctx.createBiquadFilter());
    bp.type = 'bandpass';
    bp.frequency.value = 620;
    bp.Q.value = 1.6;
    const lp = c.own(ctx.createBiquadFilter());
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    const g = c.own(ctx.createGain());
    g.gain.value = 0.5 * level;
    if (src) {
      src.connect(bp);
      bp.connect(lp);
      lp.connect(g);
      g.connect(c.out);
      c.play(src, eng.now);
    }
    // Two detuned LFOs drift the band so gusts never repeat exactly.
    const l1 = c.own(ctx.createOscillator());
    l1.type = 'sine';
    l1.frequency.value = 0.07;
    const d1 = c.own(ctx.createGain());
    d1.gain.value = 320;
    l1.connect(d1);
    d1.connect(bp.frequency);
    const l2 = c.own(ctx.createOscillator());
    l2.type = 'sine';
    l2.frequency.value = 0.031;
    const d2 = c.own(ctx.createGain());
    d2.gain.value = 0.3;
    l2.connect(d2);
    d2.connect(g.gain);
    c.play(l1, eng.now);
    c.play(l2, eng.now);
  }

  /**
   * Rain bed: hiss through a resonant filter, a low rumble and droplet grains.
   * @param {ContinuousSound} c Container.
   * @param {number} level Level multiplier.
   * @returns {void}
   * @private
   */
  _buildRain(c, level) {
    const eng = this.engine;
    const ctx = eng.ctx;
    const src = eng.noiseSource('white', 1);
    const hp = c.own(ctx.createBiquadFilter());
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const bp = c.own(ctx.createBiquadFilter());
    bp.type = 'bandpass';
    bp.frequency.value = 3400;
    bp.Q.value = 0.55;
    const g = c.own(ctx.createGain());
    g.gain.value = 0.42 * level;
    if (src) {
      src.connect(hp);
      hp.connect(bp);
      bp.connect(g);
      g.connect(c.out);
      c.play(src, eng.now);
    }
    // Low rumble of rain on the street.
    const rum = eng.noiseSource('brown', 1);
    const rumLp = c.own(ctx.createBiquadFilter());
    rumLp.type = 'lowpass';
    rumLp.frequency.value = 380;
    const rumGain = c.own(ctx.createGain());
    rumGain.gain.value = 0.28 * level;
    if (rum) {
      rum.connect(rumLp);
      rumLp.connect(rumGain);
      rumGain.connect(c.out);
      c.play(rum, eng.now);
    }
    // Droplet grains.
    const drops = c.own(ctx.createGain());
    drops.gain.value = 0.5 * level;
    drops.connect(c.out);
    c.schedule(new EventScheduler(eng, 0.6, (at) => {
      const f = rnd(1800, 6200);
      tone(eng, drops, at, { type: 'sine', freq: f, freqEnd: f * 0.6, glide: 0.03, gain: rnd(0.01, 0.05), attack: 0.001, decay: rnd(0.02, 0.06) });
      return rnd(0.03, 0.16);
    }).start(200));
    /** @type {BiquadFilterNode} Exposed so `rain()` can change the character. */
    c.rainBand = bp;
    /** @type {GainNode} */
    c.rainDrops = drops;
  }

  /**
   * Seaside bed: wave wash-in/wash-out swells, wind and occasional gulls.
   * @param {ContinuousSound} c Container.
   * @param {number} level Level multiplier.
   * @returns {void}
   * @private
   */
  _buildSeaside(c, level) {
    const eng = this.engine;
    const ctx = eng.ctx;
    const src = eng.noiseSource('white', 1);
    const bp = c.own(ctx.createBiquadFilter());
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 0.5;
    const g = c.own(ctx.createGain());
    g.gain.value = 0.2 * level;
    if (src) {
      src.connect(bp);
      bp.connect(g);
      g.connect(c.out);
      c.play(src, eng.now);
    }
    // Wave swell: amplitude and brightness move together.
    const wave = c.own(ctx.createOscillator());
    wave.type = 'sine';
    wave.frequency.value = 0.085;
    const waveAmp = c.own(ctx.createGain());
    waveAmp.gain.value = 0.16 * level;
    const waveFreq = c.own(ctx.createGain());
    waveFreq.gain.value = 700;
    wave.connect(waveAmp);
    waveAmp.connect(g.gain);
    wave.connect(waveFreq);
    waveFreq.connect(bp.frequency);
    c.play(wave, eng.now);
    // Low sea rumble.
    const rum = eng.noiseSource('brown', 1);
    const rumLp = c.own(ctx.createBiquadFilter());
    rumLp.type = 'lowpass';
    rumLp.frequency.value = 260;
    const rumGain = c.own(ctx.createGain());
    rumGain.gain.value = 0.22 * level;
    if (rum) {
      rum.connect(rumLp);
      rumLp.connect(rumGain);
      rumGain.connect(c.out);
      c.play(rum, eng.now);
    }
    // Gulls.
    const gulls = c.own(ctx.createGain());
    gulls.gain.value = 0.35 * level;
    gulls.connect(c.out);
    c.schedule(new EventScheduler(eng, 3, (at) => {
      const calls = 2 + Math.floor(Math.random() * 3);
      const base = rnd(900, 1500);
      for (let i = 0; i < calls; i++) {
        const ct = at + i * rnd(0.16, 0.3);
        const f = base * rnd(0.9, 1.15);
        tone(eng, gulls, ct, { type: 'triangle', freq: f * 0.7, freqEnd: f * 1.35, glide: 0.06, gain: 0.055, attack: 0.02, decay: 0.16, lp: 4200 });
        tone(eng, gulls, ct + 0.06, { type: 'sine', freq: f * 1.5, freqEnd: f * 0.9, glide: 0.1, gain: 0.03, attack: 0.01, decay: 0.14 });
      }
      return rnd(5, 14);
    }).start(1000));
  }

  /**
   * Crowd bed: filtered noise babble with slowly moving formants.
   * @param {ContinuousSound} c Container.
   * @param {number} level Level multiplier.
   * @returns {void}
   * @private
   */
  _buildCrowd(c, level) {
    const eng = this.engine;
    const ctx = eng.ctx;
    const src = eng.noiseSource('pink', 1);
    const g = c.own(ctx.createGain());
    g.gain.value = 0.3 * level;
    g.connect(c.out);
    const formants = [420, 900, 2100];
    for (let i = 0; i < formants.length; i++) {
      const bp = c.own(ctx.createBiquadFilter());
      bp.type = 'bandpass';
      bp.frequency.value = formants[i];
      bp.Q.value = 3 + i;
      const fg = c.own(ctx.createGain());
      fg.gain.value = 0.4 / (i + 1);
      if (src) {
        src.connect(bp);
        bp.connect(fg);
        fg.connect(g);
      }
      const lfo = c.own(ctx.createOscillator());
      lfo.type = 'sine';
      lfo.frequency.value = 0.13 + i * 0.07;
      const depth = c.own(ctx.createGain());
      depth.gain.value = formants[i] * 0.12;
      lfo.connect(depth);
      depth.connect(bp.frequency);
      c.play(lfo, eng.now);
    }
    if (src) c.play(src, eng.now);
    // Babble grains: short bursts that read as individual voices.
    c.schedule(new EventScheduler(eng, 1, (at) => {
      noiseBurst(eng, g, at, {
        kind: 'pink', type: 'bandpass', freq: rnd(500, 2200), q: 5,
        gain: rnd(0.02, 0.07), attack: 0.04, decay: rnd(0.1, 0.3),
      });
      return rnd(0.15, 0.7);
    }).start(300));
  }

  /**
   * Starts, updates or stops the rain bed.
   * @param {number} intensity 0 stops the rain, 1 is a downpour.
   * @returns {object} The rain ambience handle (a silent stub when audio is off).
   */
  rain(intensity) {
    const i = clampNum(num(intensity, 0), 0, 1);
    const existing = this.ambiences.get('rain');
    if (i <= 0.001) {
      if (existing && existing.alive) existing.stop(1.5);
      return existing || DEAD_HANDLE;
    }
    if (!this.ready) return DEAD_HANDLE;
    const handle = existing && existing.alive ? existing : this.ambience('rain');
    handle.setVolume(0.25 + 0.95 * i, 1.2);
    const c = handle.sound;
    if (c && c.rainBand) {
      const t = this.engine.now;
      targetAt(c.rainBand.frequency, clampFreq(2200 + i * 2600), t, 0.8);
      targetAt(c.rainDrops.gain, 0.2 + i * 0.9, t, 0.8);
    }
    return handle;
  }
}
