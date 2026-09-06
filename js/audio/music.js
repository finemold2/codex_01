/**
 * NEON CITY - classical music sequencer and synthesiser.
 *
 * `MusicPlayer` turns the note data in `audio/scores.js` into a fully synthesised chamber
 * orchestra. Nothing is sampled: every note is built from oscillators, filtered noise and
 * envelopes at the moment it is scheduled.
 *
 * Signal flow:
 * ```
 *   voice osc/noise -> voice filters -> ADSR gain -> StereoPanner -+-> track gain -> deck sum
 *                                                                  |
 *                                                                  +-> reverb send -> deck send
 *   deck sum  -> deck crossfade gain -> music in -> master lowpass -> shelving EQ
 *             -> glue compressor -> music out -> audioEngine.buses.music
 *   deck send -> reverb in -> tone shaping -> convolver (generated IR) -> return -> compressor
 *   piano     -> resonance send -> comb delay (feedback + damping) -> return -> compressor
 * ```
 *
 * Timing is handled by a classic look-ahead scheduler: a 25 ms timer (backed up by `update()`
 * from the game loop) walks a merged, beat-sorted event list and hands every note an exact
 * `AudioContext` start time up to `LOOKAHEAD_SECONDS` in the future. The scheduler is driven
 * entirely by the audio clock, so a throttled tab, a long GC pause or a stalled frame can never
 * shift the music; when the gap grows too large the deck resynchronises silently instead of
 * dumping a burst of stale notes.
 *
 * All parameter automation goes through the guarded helpers from `audio/audio.js`, so an
 * exponential ramp can never reach zero and a schedule time can never be negative or NaN.
 *
 * @module audio/music
 */

import { SCORES, STATIONS, getScore } from './scores.js';
import {
  MIN_GAIN,
  clampNum,
  safeValue,
  safeTime,
  clampFreq,
  setAt,
  linTo,
  expTo,
  targetAt,
  holdAt,
} from './audio.js';

/* -------------------------------------------------------------------------------------------
 * Constants and pure tables
 * ----------------------------------------------------------------------------------------- */

/** Hard cap on simultaneously sounding synth voices. @type {number} */
export const MAX_VOICES = 48;

/** How far ahead of the audio clock notes are scheduled, in seconds. @type {number} */
export const LOOKAHEAD_SECONDS = 0.5;

/** Scheduler timer period in milliseconds. @type {number} */
export const TICK_MS = 25;

/** Crossfade length between two tracks, in seconds. @type {number} */
export const CROSSFADE_SECONDS = 1.2;

/** Maximum tempo increase applied at full action intensity (12%). @type {number} */
const INTENSITY_TEMPO = 0.12;

/** Peak deterministic timing jitter per note, in seconds (+/- 8 ms). @type {number} */
const HUMANIZE_SECONDS = 0.008;

/** Scheduling gap above which a deck resynchronises instead of catching up audibly. */
const RESYNC_GAP = 1.6;

/** Longest look-ahead the adaptive scheduler will stretch to under throttling. */
const MAX_HORIZON = 1.5;

/** MIDI note -> frequency table (A4 = 440 Hz). Pure constant table. @type {Float64Array} */
const MIDI_FREQ = new Float64Array(128);
for (let i = 0; i < 128; i++) MIDI_FREQ[i] = 440 * Math.pow(2, (i - 69) / 12);

/** Semitone offset of every natural note name, for parsing `score.key`. */
const KEY_SEMITONE = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** Detune multipliers for the string section oscillators (cents multipliers). */
const STRING_DETUNE = [0, -1, 1, 0.5];

/** Additive drawbar harmonics used by the organ. */
const ORGAN_HARMONICS = [1, 2, 3, 4, 6, 8];

/** Matching drawbar gains, descending. */
const ORGAN_GAINS = [1, 0.55, 0.38, 0.27, 0.17, 0.12];

/** Fallback station labels when a station table carries no display name. */
const DEFAULT_STATION_NAMES = {
  classic: { name: 'Classic FM', nameKo: '클래식 FM' },
  baroque: { name: 'Baroque Hall', nameKo: '바로크 홀' },
  romantic: { name: 'Romantic Nights', nameKo: '로맨틱 나이트' },
  opera: { name: 'Opera House', nameKo: '오페라 하우스' },
  action: { name: 'Neon Drive', nameKo: '네온 드라이브' },
};

/**
 * Per-instrument synthesis parameters. `family` selects the voice builder; everything else
 * tunes it. Unknown instrument names fall back to `piano`.
 * @type {Object<string, object>}
 */
const INSTRUMENTS = {
  piano: { family: 'piano', gain: 0.5, send: 1, decay: 6.2, res: 0.14 },
  harpsichord: { family: 'harpsichord', gain: 0.34, send: 1.1, decay: 1.5 },
  organ: { family: 'organ', gain: 0.22, send: 0.9, attack: 0.055 },
  strings: { family: 'strings', gain: 0.2, send: 1.15, body: 330, detune: 8, attack: 0.16, ens: 2, sub: 0 },
  violin: { family: 'strings', gain: 0.2, send: 1.1, body: 540, detune: 6, attack: 0.11, ens: 1, sub: 0 },
  viola: { family: 'strings', gain: 0.2, send: 1.1, body: 380, detune: 6, attack: 0.13, ens: 1, sub: 0 },
  cello: { family: 'strings', gain: 0.22, send: 1.05, body: 230, detune: 5, attack: 0.15, ens: 1, sub: 0.12 },
  bass: { family: 'strings', gain: 0.24, send: 0.8, body: 110, detune: 4, attack: 0.18, ens: 1, sub: 0.35 },
  pizzicato: { family: 'pizzicato', gain: 0.4, send: 1, decay: 0.75 },
  flute: { family: 'wind', gain: 0.24, send: 1.1, wave: 'flute', fallback: 'sine', breath: 0.1, attack: 0.075, vib: 5, cut: 3200 },
  oboe: { family: 'wind', gain: 0.19, send: 1.05, wave: 'oboe', fallback: 'sawtooth', breath: 0.05, attack: 0.05, vib: 5.4, cut: 2600 },
  clarinet: { family: 'wind', gain: 0.22, send: 1.05, wave: 'clarinet', fallback: 'square', breath: 0.045, attack: 0.06, vib: 4.8, cut: 2400 },
  horn: { family: 'brass', gain: 0.22, send: 1.15, formant: 760, q: 1.1, scoop: 0.968, attack: 0.085 },
  trumpet: { family: 'brass', gain: 0.2, send: 1.05, formant: 1250, q: 1.4, scoop: 0.984, attack: 0.045 },
  timpani: { family: 'timpani', gain: 0.45, send: 1.2, decay: 2.6 },
  harp: { family: 'bell', gain: 0.34, send: 1.15, ratio: 3.5, index: 2.2, decay: 2.7, bright: 1 },
  celesta: { family: 'bell', gain: 0.26, send: 1.2, ratio: 3.5, index: 3.6, decay: 1.8, bright: 2.3 },
};

/** Instrument used for the action-intensity octave doubling layer. */
const LAYER_BRASS = INSTRUMENTS.horn;

/** Instrument used for the action-intensity downbeat accents. */
const LAYER_TIMPANI = INSTRUMENTS.timpani;

/* -------------------------------------------------------------------------------------------
 * Small helpers
 * ----------------------------------------------------------------------------------------- */

/**
 * Deterministic 32-bit hash mapped to [0,1). Used for humanised timing and velocity so a
 * given note always "performs" the same way instead of jittering on every playback.
 * @param {number} a First integer key (usually the event index).
 * @param {number} b Second integer key (a per-purpose salt).
 * @returns {number} Pseudo-random value in [0,1).
 */
function hash01(a, b) {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Frame-rate independent smoothing factor.
 * @param {number} dt Delta time in seconds.
 * @param {number} tau Time constant in seconds.
 * @returns {number} Blend factor in [0,1].
 */
function smoothing(dt, tau) {
  if (!(dt > 0)) return 0;
  return 1 - Math.exp(-dt / Math.max(0.001, tau));
}

/**
 * Reads the tonic pitch class out of a key signature string such as `'D major'` or `'bb minor'`.
 * @param {string} key Key name.
 * @returns {number} Pitch class 0..11 (0 = C).
 */
function keyPitchClass(key) {
  if (typeof key !== 'string' || key.length === 0) return 0;
  const letter = key[0].toLowerCase();
  let pc = KEY_SEMITONE[letter];
  if (pc === undefined) return 0;
  const acc = key[1];
  if (acc === '#' || acc === 's') pc += 1;
  else if (acc === 'b' || acc === 'B') pc -= 1;
  return ((pc % 12) + 12) % 12;
}

/**
 * Creates a stereo panner, falling back to an equal-power PannerNode on browsers without
 * `StereoPannerNode` (older Safari).
 * @param {BaseAudioContext} ctx Audio context.
 * @param {number} pan Pan position -1..1.
 * @returns {AudioNode} The panning node.
 */
function makePanner(ctx, pan) {
  const p = clampNum(pan, -1, 1);
  if (typeof ctx.createStereoPanner === 'function') {
    const node = ctx.createStereoPanner();
    node.pan.value = p;
    return node;
  }
  const node = ctx.createPanner();
  node.panningModel = 'equalpower';
  node.distanceModel = 'linear';
  const z = -Math.sqrt(Math.max(0, 1 - p * p));
  if (node.positionX && typeof node.positionX.value === 'number') {
    node.positionX.value = p;
    node.positionY.value = 0;
    node.positionZ.value = z;
  } else if (typeof node.setPosition === 'function') {
    node.setPosition(p, 0, z);
  }
  return node;
}

/**
 * Writes a sustaining ADSR envelope, truncating the decay exactly on the natural curve when the
 * note is released early so a short note is indistinguishable from the start of a long one.
 * @param {AudioParam} param Gain parameter.
 * @param {number} t0 Note start time.
 * @param {number} peak Peak gain.
 * @param {number} attack Attack length in seconds.
 * @param {number} decay Decay length in seconds.
 * @param {number} sustain Sustain level as a fraction of `peak` (0..1).
 * @param {number} off Note-off time.
 * @param {number} release Release length in seconds.
 * @returns {number} Time at which the envelope reaches silence.
 */
function envADSR(param, t0, peak, attack, decay, sustain, off, release) {
  const p = Math.max(MIN_GAIN * 8, safeValue(peak, 0.2));
  const a = Math.max(0.0008, safeValue(attack, 0.01));
  const d = Math.max(0.01, safeValue(decay, 0.1));
  const s = Math.max(MIN_GAIN * 4, p * clampNum(sustain, 0.002, 1));
  const r = Math.max(0.02, safeValue(release, 0.1));
  const decayEnd = t0 + a + d;
  let offT = Math.max(safeValue(off, t0 + 0.2), t0 + a + 0.006);
  setAt(param, MIN_GAIN, t0);
  linTo(param, p, t0 + a);
  if (offT < decayEnd) {
    const k = (offT - (t0 + a)) / d;
    const vOff = Math.max(MIN_GAIN, p * Math.pow(s / p, k));
    expTo(param, vOff, offT);
    expTo(param, MIN_GAIN, offT + r);
    return offT + r;
  }
  expTo(param, s, decayEnd);
  if (offT > decayEnd) setAt(param, s, offT);
  else offT = decayEnd;
  expTo(param, MIN_GAIN, offT + r);
  return offT + r;
}

/**
 * Writes a struck/plucked envelope: fast attack, long exponential decay and an optional damper
 * when the key is released before the string has died away.
 * @param {AudioParam} param Gain parameter.
 * @param {number} t0 Note start time.
 * @param {number} peak Peak gain.
 * @param {number} attack Attack length in seconds.
 * @param {number} decay Natural decay length in seconds.
 * @param {number} off Note-off (damper) time; pass `Infinity` for an undamped instrument.
 * @param {number} release Damper length in seconds.
 * @returns {number} Time at which the envelope reaches silence.
 */
function envPluck(param, t0, peak, attack, decay, off, release) {
  const p = Math.max(MIN_GAIN * 8, safeValue(peak, 0.2));
  const a = Math.max(0.0006, safeValue(attack, 0.003));
  const d = Math.max(0.03, safeValue(decay, 0.6));
  const r = Math.max(0.02, safeValue(release, 0.12));
  const natEnd = t0 + a + d;
  setAt(param, MIN_GAIN, t0);
  linTo(param, p, t0 + a);
  const offT = Math.max(safeValue(off, natEnd), t0 + a + 0.01);
  if (offT < natEnd) {
    const k = (offT - (t0 + a)) / d;
    const vOff = Math.max(MIN_GAIN, p * Math.pow(MIN_GAIN / p, k));
    expTo(param, vOff, offT);
    expTo(param, MIN_GAIN, offT + r);
    return offT + r;
  }
  expTo(param, MIN_GAIN, natEnd);
  return natEnd;
}

/* -------------------------------------------------------------------------------------------
 * Voice bookkeeping
 * ----------------------------------------------------------------------------------------- */

let voiceIds = 0;

/**
 * One sounding note. Voices are pooled: `nodes` and `sources` keep their capacity between uses
 * so scheduling a note never grows the heap once the pool is warm.
 */
class MusicVoice {
  constructor() {
    /** @type {number} Unique id, useful for debugging. */
    this.id = 0;
    /** @type {AudioNode[]} Every node owned by this voice (disconnected on reap). */
    this.nodes = [];
    /** @type {AudioScheduledSourceNode[]} Nodes that need an explicit `stop()`. */
    this.sources = [];
    /** @type {GainNode|null} Envelope gain, the voice's output stage. */
    this.amp = null;
    /** @type {object|null} Owning deck. */
    this.deck = null;
    /** @type {number} Scheduled start time. */
    this.start = 0;
    /** @type {number} Time after which the voice may be disconnected. */
    this.end = 0;
    /** @type {number} Peak amplitude, used to pick the quietest voice when stealing. */
    this.peak = 0;
    /** @type {boolean} True once the voice has been force-released. */
    this.released = false;
  }

  /**
   * Registers a plain node with the voice.
   * @param {AudioNode} node Node to own.
   * @returns {AudioNode} The same node, for chaining.
   */
  own(node) {
    this.nodes.push(node);
    return node;
  }

  /**
   * Registers a scheduled source with the voice (it also gets `own()`ed).
   * @param {AudioScheduledSourceNode} node Source node.
   * @returns {AudioScheduledSourceNode} The same node, for chaining.
   */
  source(node) {
    this.sources.push(node);
    this.nodes.push(node);
    return node;
  }

  /**
   * Disconnects every node and empties the voice so it can go back into the pool.
   * @returns {void}
   */
  teardown() {
    const nodes = this.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      try {
        n.disconnect();
      } catch (err) {
        /* already disconnected */
      }
    }
    nodes.length = 0;
    this.sources.length = 0;
    this.amp = null;
    this.deck = null;
    this.released = false;
    this.peak = 0;
  }
}

/* -------------------------------------------------------------------------------------------
 * Voice builders - one per instrument family
 * ----------------------------------------------------------------------------------------- */

/**
 * Creates the shared output stage of a voice: envelope gain -> stereo panner -> track gain,
 * with a parallel reverb send taken post-pan.
 * @param {MusicPlayer} mp Owning player.
 * @param {object} deck Deck the voice belongs to.
 * @param {object} ch Track channel.
 * @param {MusicVoice} v Voice being built.
 * @param {number} panOffset Extra pan applied on top of the track pan.
 * @returns {GainNode} The envelope gain node.
 */
function openVoice(mp, deck, ch, v, panOffset) {
  const ctx = mp.ctx;
  const amp = ctx.createGain();
  amp.gain.value = MIN_GAIN;
  const panner = makePanner(ctx, ch.pan + panOffset);
  amp.connect(panner);
  panner.connect(ch.dry);
  const send = ctx.createGain();
  send.gain.value = ch.send;
  panner.connect(send);
  send.connect(deck.sendGain);
  v.own(amp);
  v.own(panner);
  v.own(send);
  v.amp = amp;
  return amp;
}

/**
 * Adds a short filtered noise transient (hammer, pluck, chiff or mallet).
 * @param {MusicPlayer} mp Owning player.
 * @param {MusicVoice} v Voice being built.
 * @param {AudioNode} dest Destination node.
 * @param {number} t0 Start time.
 * @param {number} peak Peak gain.
 * @param {number} decay Decay length in seconds.
 * @param {number} freq Filter centre frequency.
 * @param {number} q Filter Q.
 * @param {string} type Filter type.
 * @returns {void}
 */
function addTransient(mp, v, dest, t0, peak, decay, freq, q, type) {
  const ctx = mp.ctx;
  const buf = mp.noiseBuffer();
  if (!buf) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const filt = ctx.createBiquadFilter();
  filt.type = type;
  filt.frequency.value = clampFreq(freq);
  filt.Q.value = clampNum(q, 0.1, 24);
  const g = ctx.createGain();
  g.gain.value = MIN_GAIN;
  setAt(g.gain, MIN_GAIN, t0);
  linTo(g.gain, Math.max(MIN_GAIN * 4, peak), t0 + 0.0012);
  expTo(g.gain, MIN_GAIN, t0 + 0.0012 + Math.max(0.004, decay));
  src.connect(filt);
  filt.connect(g);
  g.connect(dest);
  v.source(src);
  v.own(filt);
  v.own(g);
  // Cosmetic jitter only: a different slice of noise per hit keeps repeated notes alive.
  src.start(safeTime(t0), Math.random() * 1.4);
}

/**
 * Piano: three detuned oscillators (two triangles plus an octave sine), a struck-string
 * transient, velocity-dependent brightness, a pitch-dependent decay length, a damper on
 * release and a small sympathetic-resonance send.
 * @param {MusicPlayer} mp Owning player.
 * @param {object} deck Deck.
 * @param {object} ch Track channel.
 * @param {MusicVoice} v Voice.
 * @param {number} freq Fundamental in Hz.
 * @param {number} t0 Start time.
 * @param {number} dur Note length in seconds.
 * @param {number} vel Velocity 0..1.
 * @param {number} peak Peak amplitude.
 * @param {boolean} accent True for accented notes.
 * @returns {number} Envelope end time.
 */
function buildPiano(mp, deck, ch, v, freq, t0, dur, vel, peak, accent) {
  const ctx = mp.ctx;
  const p = ch.params;
  const amp = openVoice(mp, deck, ch, v, 0);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  const bright = 380 + freq * 3.2 + Math.pow(vel, 1.7) * 5200 * (accent ? 1.3 : 1);
  lp.frequency.value = clampFreq(bright);
  lp.Q.value = 0.6;
  lp.connect(amp);
  v.own(lp);

  const mix = ctx.createGain();
  mix.gain.value = 0.5;
  mix.connect(lp);
  v.own(mix);

  const o1 = ctx.createOscillator();
  o1.type = 'triangle';
  o1.frequency.value = clampFreq(freq);
  o1.detune.value = -3;
  const g1 = ctx.createGain();
  g1.gain.value = 1;
  o1.connect(g1);
  g1.connect(mix);

  const o2 = ctx.createOscillator();
  o2.type = 'triangle';
  o2.frequency.value = clampFreq(freq * 1.0009);
  o2.detune.value = 4;
  const g2 = ctx.createGain();
  g2.gain.value = 0.62;
  o2.connect(g2);
  g2.connect(mix);

  // Slightly stretched octave partial: real strings are inharmonic.
  const o3 = ctx.createOscillator();
  o3.type = 'sine';
  o3.frequency.value = clampFreq(freq * 2.004);
  const g3 = ctx.createGain();
  g3.gain.value = 0.24 + vel * 0.2;
  o3.connect(g3);
  g3.connect(mix);

  v.source(o1);
  v.source(o2);
  v.source(o3);
  v.own(g1);
  v.own(g2);
  v.own(g3);
  o1.start(safeTime(t0));
  o2.start(safeTime(t0));
  o3.start(safeTime(t0));

  addTransient(mp, v, lp, t0, peak * 0.85 * (0.35 + vel * 0.75), 0.012, clampFreq(freq * 2.6), 1.1, 'bandpass');

  const decay = clampNum(p.decay * Math.pow(freq / 261.626, -0.58), 0.32, 13);
  const end = envPluck(amp.gain, t0, peak, 0.004, decay, t0 + dur, 0.14);

  if (mp.resonanceIn) {
    const res = ctx.createGain();
    res.gain.value = clampNum(p.res * vel, 0, 0.5);
    amp.connect(res);
    res.connect(mp.resonanceIn);
    v.own(res);
  }
  return end;
}

/**
 * Harpsichord: bright pulse wave, instant attack, quick plucky decay, jack noise on release and
 * no dynamic response at all (the instrument cannot play louder).
 * @param {MusicPlayer} mp Owning player.
 * @param {object} deck Deck.
 * @param {object} ch Track channel.
 * @param {MusicVoice} v Voice.
 * @param {number} freq Fundamental in Hz.
 * @param {number} t0 Start time.
 * @param {number} dur Note length in seconds.
 * @param {number} vel Velocity 0..1 (ignored for dynamics).
 * @param {number} peak Peak amplitude.
 * @param {boolean} accent Unused; the harpsichord has no accents.
 * @returns {number} Envelope end time.
 */
function buildHarpsichord(mp, deck, ch, v, freq, t0, dur, vel, peak, accent) {
  const ctx = mp.ctx;
  const p = ch.params;
  const amp = openVoice(mp, deck, ch, v, 0);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = clampFreq(freq * 0.75);
  hp.Q.value = 0.7;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = clampFreq(2600 + freq * 4.5);
  lp.Q.value = 0.9;
  hp.connect(lp);
  lp.connect(amp);
  v.own(hp);
  v.own(lp);

  const wave = mp.wave('harpsichord');
  const o1 = ctx.createOscillator();
  if (wave) o1.setPeriodicWave(wave);
  else o1.type = 'square';
  o1.frequency.value = clampFreq(freq);
  const g1 = ctx.createGain();
  g1.gain.value = 0.75;
  o1.connect(g1);
  g1.connect(hp);

  // 4-foot register an octave up, the characteristic harpsichord glitter.
  const o2 = ctx.createOscillator();
  if (wave) o2.setPeriodicWave(wave);
  else o2.type = 'square';
  o2.frequency.value = clampFreq(freq * 2);
  o2.detune.value = 5;
  const g2 = ctx.createGain();
  g2.gain.value = 0.26;
  o2.connect(g2);
  g2.connect(hp);

  v.source(o1);
  v.source(o2);
  v.own(g1);
  v.own(g2);
  o1.start(safeTime(t0));
  o2.start(safeTime(t0));

  addTransient(mp, v, lp, t0, peak * 1.1, 0.006, clampFreq(freq * 5), 0.9, 'bandpass');

  // Fixed dynamics: the plectrum plucks the same way however hard the key is struck.
  const fixed = ch.params.gain * 0.86;
  v.peak = fixed * (ch.gain > 0 ? ch.gain : 1);
  const decay = clampNum(p.decay * Math.pow(freq / 261.626, -0.5), 0.18, 3.2);
  return envPluck(amp.gain, t0, fixed, 0.0015, decay, t0 + dur, 0.05);
}

/**
 * Organ: additive drawbar stack (harmonics 1, 2, 3, 4, 6, 8 with descending gains) rendered as
 * a single periodic wave, doubled and detuned for chorus, with a slow attack, full sustain and
 * a short chiff transient.
 * @param {MusicPlayer} mp Owning player.
 * @param {object} deck Deck.
 * @param {object} ch Track channel.
 * @param {MusicVoice} v Voice.
 * @param {number} freq Fundamental in Hz.
 * @param {number} t0 Start time.
 * @param {number} dur Note length in seconds.
 * @param {number} vel Velocity 0..1.
 * @param {number} peak Peak amplitude.
 * @param {boolean} accent True for accented notes.
 * @returns {number} Envelope end time.
 */
function buildOrgan(mp, deck, ch, v, freq, t0, dur, vel, peak, accent) {
  const ctx = mp.ctx;
  const p = ch.params;
  const amp = openVoice(mp, deck, ch, v, 0);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = clampFreq(1400 + freq * 2.2 + vel * 3600 * (accent ? 1.2 : 1));
  lp.Q.value = 0.5;
  lp.connect(amp);
  v.own(lp);

  const wave = mp.wave('organ');
  for (let i = 0; i < 2; i++) {
    const o = ctx.createOscillator();
    if (wave) o.setPeriodicWave(wave);
    else o.type = 'sawtooth';
    o.frequency.value = clampFreq(freq);
    o.detune.value = i === 0 ? -5 : 5;
    const g = ctx.createGain();
    g.gain.value = 0.5;
    o.connect(g);
    g.connect(lp);
    v.source(o);
    v.own(g);
    o.start(safeTime(t0 + i * 0.003));
  }

  addTransient(mp, v, lp, t0, peak * 0.35, 0.03, clampFreq(freq * 4), 2.2, 'bandpass');

  const attack = p.attack * (1.4 - vel * 0.5);
  return envADSR(amp.gain, t0, peak, attack, 0.12, 0.94, t0 + dur, 0.09);
}

/**
 * Strings: three or four detuned saws through a lowpass and a body resonance peak, with a slow
 * attack, a delayed 5.2 Hz vibrato and one or two ensemble voices detuned +/- 6 cents, delayed
 * and spread across the stereo field.
 * @param {MusicPlayer} mp Owning player.
 * @param {object} deck Deck.
 * @param {object} ch Track channel.
 * @param {MusicVoice} v Voice.
 * @param {number} freq Fundamental in Hz.
 * @param {number} t0 Start time.
 * @param {number} dur Note length in seconds.
 * @param {number} vel Velocity 0..1.
 * @param {number} peak Peak amplitude.
 * @param {boolean} accent True for accented notes.
 * @returns {number} Envelope end time.
 */
function buildStrings(mp, deck, ch, v, freq, t0, dur, vel, peak, accent) {
  const ctx = mp.ctx;
  const p = ch.params;
  const amp = openVoice(mp, deck, ch, v, 0);

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  const cut = 420 + freq * 1.7 + Math.pow(vel, 1.5) * 4200 * (accent ? 1.3 : 1);
  lp.frequency.value = clampFreq(cut);
  lp.Q.value = 0.7;
  const body = ctx.createBiquadFilter();
  body.type = 'peaking';
  body.frequency.value = clampFreq(p.body);
  body.Q.value = 1.15;
  body.gain.value = 5.5;
  lp.connect(body);
  body.connect(amp);
  v.own(lp);
  v.own(body);

  // Delayed vibrato: the bow settles first, then the hand starts to move.
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 5.2 + (freq > 500 ? 0.3 : 0);
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0;
  setAt(lfoGain.gain, 0, t0);
  setAt(lfoGain.gain, 0, t0 + 0.35);
  linTo(lfoGain.gain, 7 + vel * 6, t0 + 0.78);
  lfo.connect(lfoGain);
  v.source(lfo);
  v.own(lfoGain);
  lfo.start(safeTime(t0));

  const count = p.ens >= 2 ? 4 : 3;
  const norm = 0.85 / count;
  for (let i = 0; i < count; i++) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = clampFreq(freq);
    o.detune.value = STRING_DETUNE[i] * p.detune;
    lfoGain.connect(o.detune);
    const g = ctx.createGain();
    g.gain.value = norm;
    o.connect(g);
    g.connect(lp);
    v.source(o);
    v.own(g);
    o.start(safeTime(t0 + i * 0.004));
  }

  // Sub octave for the low strings, skipped when it would land below the audible band.
  if (p.sub > 0 && freq > 72) {
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = clampFreq(freq * 0.5);
    const sg = ctx.createGain();
    sg.gain.value = p.sub;
    sub.connect(sg);
    sg.connect(amp);
    v.source(sub);
    v.own(sg);
    sub.start(safeTime(t0));
  }

  const attack = clampNum(p.attack * (1.5 - vel * 0.6) * (accent ? 0.55 : 1), 0.03, 0.34);
  const end = envADSR(amp.gain, t0, peak, attack, 0.35, 0.82, t0 + dur, 0.2);

  // Ensemble: extra players, each slightly late, slightly out of tune and off to one side.
  const ens = p.ens | 0;
  for (let i = 0; i < ens; i++) {
    const side = i === 0 ? -1 : 1;
    const start = t0 + 0.012 + i * 0.011;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = clampFreq(freq);
    o.detune.value = side * 6;
    lfoGain.connect(o.detune);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = clampFreq(cut * 0.9);
    f.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.value = MIN_GAIN;
    const pan = makePanner(ctx, clampNum(ch.pan + side * 0.18, -1, 1));
    o.connect(f);
    f.connect(g);
    g.connect(pan);
    pan.connect(ch.dry);
    envADSR(g.gain, start, peak * 0.5, attack * 1.15, 0.35, 0.82, t0 + dur, 0.24);
    v.source(o);
    v.own(f);
    v.own(g);
    v.own(pan);
    o.start(safeTime(start));
  }
  return end + 0.08;
}

/**
 * Pizzicato: a short saw + triangle pluck with a noise transient and a fast decay.
 * @param {MusicPlayer} mp Owning player.
 * @param {object} deck Deck.
 * @param {object} ch Track channel.
 * @param {MusicVoice} v Voice.
 * @param {number} freq Fundamental in Hz.
 * @param {number} t0 Start time.
 * @param {number} dur Note length in seconds.
 * @param {number} vel Velocity 0..1.
 * @param {number} peak Peak amplitude.
 * @param {boolean} accent True for accented notes.
 * @returns {number} Envelope end time.
 */
function buildPizzicato(mp, deck, ch, v, freq, t0, dur, vel, peak, accent) {
  const ctx = mp.ctx;
  const p = ch.params;
  const amp = openVoice(mp, deck, ch, v, 0);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = clampFreq(700 + freq * 2.4 + Math.pow(vel, 1.5) * 3200 * (accent ? 1.25 : 1));
  lp.Q.value = 1.1;
  lp.connect(amp);
  v.own(lp);

  const o1 = ctx.createOscillator();
  o1.type = 'sawtooth';
  o1.frequency.value = clampFreq(freq);
  const g1 = ctx.createGain();
  g1.gain.value = 0.4;
  o1.connect(g1);
  g1.connect(lp);

  const o2 = ctx.createOscillator();
  o2.type = 'triangle';
  o2.frequency.value = clampFreq(freq);
  o2.detune.value = 6;
  const g2 = ctx.createGain();
  g2.gain.value = 0.6;
  o2.connect(g2);
  g2.connect(lp);

  v.source(o1);
  v.source(o2);
  v.own(g1);
  v.own(g2);
  o1.start(safeTime(t0));
  o2.start(safeTime(t0));

  addTransient(mp, v, lp, t0, peak * 1.2, 0.008, clampFreq(freq * 3.2), 1.4, 'bandpass');

  const decay = clampNum(p.decay * Math.pow(freq / 261.626, -0.42), 0.1, 1.1);
  return envPluck(amp.gain, t0, peak, 0.003, decay, t0 + dur + 0.05, 0.08);
}

/**
 * Woodwind: flute, oboe and clarinet share a periodic-wave core with breath noise, a gentle
 * delayed vibrato and a soft attack; the wave and the noise amount define the character.
 * @param {MusicPlayer} mp Owning player.
 * @param {object} deck Deck.
 * @param {object} ch Track channel.
 * @param {MusicVoice} v Voice.
 * @param {number} freq Fundamental in Hz.
 * @param {number} t0 Start time.
 * @param {number} dur Note length in seconds.
 * @param {number} vel Velocity 0..1.
 * @param {number} peak Peak amplitude.
 * @param {boolean} accent True for accented notes.
 * @returns {number} Envelope end time.
 */
function buildWind(mp, deck, ch, v, freq, t0, dur, vel, peak, accent) {
  const ctx = mp.ctx;
  const p = ch.params;
  const amp = openVoice(mp, deck, ch, v, 0);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = clampFreq(p.cut + freq * 1.5 + Math.pow(vel, 1.5) * 2600 * (accent ? 1.25 : 1));
  lp.Q.value = 0.8;
  lp.connect(amp);
  v.own(lp);

  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = p.vib;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0;
  setAt(lfoGain.gain, 0, t0);
  setAt(lfoGain.gain, 0, t0 + 0.28);
  linTo(lfoGain.gain, 5 + vel * 5, t0 + 0.7);
  lfo.connect(lfoGain);
  v.source(lfo);
  v.own(lfoGain);
  lfo.start(safeTime(t0));

  const wave = mp.wave(p.wave);
  const o = ctx.createOscillator();
  if (wave) o.setPeriodicWave(wave);
  else o.type = p.fallback;
  o.frequency.value = clampFreq(freq);
  lfoGain.connect(o.detune);
  const og = ctx.createGain();
  og.gain.value = 0.9;
  o.connect(og);
  og.connect(lp);
  v.source(o);
  v.own(og);
  o.start(safeTime(t0));

  // Breath: band-limited noise following the amplitude envelope loosely.
  const buf = mp.noiseBuffer();
  if (buf) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const bf = ctx.createBiquadFilter();
    bf.type = 'bandpass';
    bf.frequency.value = clampFreq(freq * 2.1);
    bf.Q.value = 1.6;
    const bg = ctx.createGain();
    bg.gain.value = MIN_GAIN;
    setAt(bg.gain, MIN_GAIN, t0);
    linTo(bg.gain, Math.max(MIN_GAIN * 4, p.breath * (0.5 + vel * 0.8)), t0 + 0.03);
    linTo(bg.gain, Math.max(MIN_GAIN * 4, p.breath * 0.45), t0 + Math.max(0.08, dur * 0.5));
    src.connect(bf);
    bf.connect(bg);
    bg.connect(lp);
    v.source(src);
    v.own(bf);
    v.own(bg);
    src.start(safeTime(t0), Math.random() * 1.4);
  }

  const attack = clampNum(p.attack * (1.35 - vel * 0.5) * (accent ? 0.6 : 1), 0.015, 0.2);
  return envADSR(amp.gain, t0, peak, attack, 0.2, 0.88, t0 + dur, 0.13);
}

/**
 * Brass: a pair of saws through a bandpass formant, with a pitch scoop into the attack and a
 * brightness that opens with velocity and during the swell.
 * @param {MusicPlayer} mp Owning player.
 * @param {object} deck Deck.
 * @param {object} ch Track channel.
 * @param {MusicVoice} v Voice.
 * @param {number} freq Fundamental in Hz.
 * @param {number} t0 Start time.
 * @param {number} dur Note length in seconds.
 * @param {number} vel Velocity 0..1.
 * @param {number} peak Peak amplitude.
 * @param {boolean} accent True for accented notes.
 * @returns {number} Envelope end time.
 */
function buildBrass(mp, deck, ch, v, freq, t0, dur, vel, peak, accent) {
  const ctx = mp.ctx;
  const p = ch.params;
  const amp = openVoice(mp, deck, ch, v, 0);

  const formant = ctx.createBiquadFilter();
  formant.type = 'bandpass';
  formant.frequency.value = clampFreq(p.formant * (0.85 + vel * 0.5));
  formant.Q.value = p.q;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  const openCut = 700 + freq * 2 + Math.pow(vel, 1.4) * 5200 * (accent ? 1.3 : 1);
  lp.frequency.value = clampFreq(openCut * 0.45);
  lp.Q.value = 0.7;
  setAt(lp.frequency, clampFreq(openCut * 0.45), t0);
  expTo(lp.frequency, clampFreq(openCut), t0 + Math.max(0.03, p.attack * 1.4), 20);
  const mix = ctx.createGain();
  mix.gain.value = 0.55;
  formant.connect(mix);
  mix.connect(lp);
  lp.connect(amp);
  // Keep some direct signal so the formant does not hollow the tone out completely.
  const direct = ctx.createGain();
  direct.gain.value = 0.45;
  direct.connect(lp);
  v.own(formant);
  v.own(lp);
  v.own(mix);
  v.own(direct);

  for (let i = 0; i < 2; i++) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.detune.value = i === 0 ? -4 : 6;
    const scoop = clampFreq(freq * p.scoop);
    setAt(o.frequency, scoop, t0);
    expTo(o.frequency, clampFreq(freq), t0 + 0.045, 20);
    const g = ctx.createGain();
    g.gain.value = 0.5;
    o.connect(g);
    g.connect(formant);
    g.connect(direct);
    v.source(o);
    v.own(g);
    o.start(safeTime(t0));
  }

  const attack = clampNum(p.attack * (1.3 - vel * 0.5) * (accent ? 0.6 : 1), 0.02, 0.16);
  return envADSR(amp.gain, t0, peak, attack, 0.28, 0.85, t0 + dur, 0.14);
}

/**
 * Timpani: a pitched sine with a fast downward pitch drop, a membrane partial, a mallet noise
 * burst and a long decay.
 * @param {MusicPlayer} mp Owning player.
 * @param {object} deck Deck.
 * @param {object} ch Track channel.
 * @param {MusicVoice} v Voice.
 * @param {number} freq Fundamental in Hz.
 * @param {number} t0 Start time.
 * @param {number} dur Note length in seconds.
 * @param {number} vel Velocity 0..1.
 * @param {number} peak Peak amplitude.
 * @param {boolean} accent True for accented notes.
 * @returns {number} Envelope end time.
 */
function buildTimpani(mp, deck, ch, v, freq, t0, dur, vel, peak, accent) {
  const ctx = mp.ctx;
  const p = ch.params;
  const amp = openVoice(mp, deck, ch, v, 0);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = clampFreq(240 + vel * 900 * (accent ? 1.3 : 1));
  lp.Q.value = 0.7;
  lp.connect(amp);
  v.own(lp);

  const o1 = ctx.createOscillator();
  o1.type = 'sine';
  setAt(o1.frequency, clampFreq(freq * 1.7), t0);
  expTo(o1.frequency, clampFreq(freq), t0 + 0.07, 20);
  const g1 = ctx.createGain();
  g1.gain.value = 0.85;
  o1.connect(g1);
  g1.connect(lp);

  const o2 = ctx.createOscillator();
  o2.type = 'sine';
  setAt(o2.frequency, clampFreq(freq * 2.6), t0);
  expTo(o2.frequency, clampFreq(freq * 1.5), t0 + 0.09, 20);
  const g2 = ctx.createGain();
  g2.gain.value = MIN_GAIN;
  setAt(g2.gain, 0.3, t0);
  expTo(g2.gain, MIN_GAIN, t0 + 0.45);
  o2.connect(g2);
  g2.connect(lp);

  v.source(o1);
  v.source(o2);
  v.own(g1);
  v.own(g2);
  o1.start(safeTime(t0));
  o2.start(safeTime(t0));

  addTransient(mp, v, amp, t0, peak * 0.5, 0.05, 320, 0.8, 'bandpass');

  const decay = clampNum(p.decay * (0.6 + vel * 0.7), 0.5, 4.5);
  const off = dur > decay ? Infinity : t0 + dur + 0.2;
  return envPluck(amp.gain, t0, peak, 0.003, decay, off, 0.25);
}

/**
 * Harp and celesta: bell-like FM with a 3.5x modulator, a fast index decay and a long carrier
 * decay. The celesta uses a higher index and an extra upper partial to sound brighter.
 * @param {MusicPlayer} mp Owning player.
 * @param {object} deck Deck.
 * @param {object} ch Track channel.
 * @param {MusicVoice} v Voice.
 * @param {number} freq Fundamental in Hz.
 * @param {number} t0 Start time.
 * @param {number} dur Note length in seconds.
 * @param {number} vel Velocity 0..1.
 * @param {number} peak Peak amplitude.
 * @param {boolean} accent True for accented notes.
 * @returns {number} Envelope end time.
 */
function buildBell(mp, deck, ch, v, freq, t0, dur, vel, peak, accent) {
  const ctx = mp.ctx;
  const p = ch.params;
  const amp = openVoice(mp, deck, ch, v, 0);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = clampFreq(900 * p.bright + freq * 3 + Math.pow(vel, 1.5) * 4200 * (accent ? 1.25 : 1));
  lp.Q.value = 0.6;
  lp.connect(amp);
  v.own(lp);

  const carrier = ctx.createOscillator();
  carrier.type = 'sine';
  carrier.frequency.value = clampFreq(freq);
  const cg = ctx.createGain();
  cg.gain.value = 0.85;
  carrier.connect(cg);
  cg.connect(lp);

  const mod = ctx.createOscillator();
  mod.type = 'sine';
  mod.frequency.value = clampFreq(freq * p.ratio);
  const modGain = ctx.createGain();
  const idx = freq * p.index * (0.45 + vel * 0.8);
  setAt(modGain.gain, idx, t0);
  expTo(modGain.gain, Math.max(MIN_GAIN, idx * 0.02), t0 + 0.45, MIN_GAIN);
  mod.connect(modGain);
  modGain.connect(carrier.frequency);

  const partial = ctx.createOscillator();
  partial.type = 'sine';
  partial.frequency.value = clampFreq(freq * (p.bright > 1.5 ? 4.02 : 2.01));
  const pg = ctx.createGain();
  pg.gain.value = MIN_GAIN;
  setAt(pg.gain, 0.18 * p.bright * vel, t0);
  expTo(pg.gain, MIN_GAIN, t0 + 0.6);
  partial.connect(pg);
  pg.connect(lp);

  v.source(carrier);
  v.source(mod);
  v.source(partial);
  v.own(cg);
  v.own(modGain);
  v.own(pg);
  carrier.start(safeTime(t0));
  mod.start(safeTime(t0));
  partial.start(safeTime(t0));

  const decay = clampNum(p.decay * Math.pow(freq / 261.626, -0.45), 0.2, 5);
  return envPluck(amp.gain, t0, peak, 0.002, decay, t0 + dur + 0.1, 0.12);
}

/** Dispatch table from instrument family to voice builder. */
const BUILDERS = {
  piano: buildPiano,
  harpsichord: buildHarpsichord,
  organ: buildOrgan,
  strings: buildStrings,
  pizzicato: buildPizzicato,
  wind: buildWind,
  brass: buildBrass,
  timpani: buildTimpani,
  bell: buildBell,
};

/* -------------------------------------------------------------------------------------------
 * Deck - one playing score with its own mixer strip and scheduling cursor
 * ----------------------------------------------------------------------------------------- */

/**
 * A deck plays exactly one score. Two decks are alive during a crossfade; each owns its track
 * channels, its crossfade gains and its own beat cursor into the prepared event list.
 */
class MusicDeck {
  /**
   * @param {MusicPlayer} mp Owning player.
   * @param {object} prepared Prepared score (see {@link MusicPlayer#_prepare}).
   */
  constructor(mp, prepared) {
    const ctx = mp.ctx;
    /** @type {MusicPlayer} */
    this.mp = mp;
    /** @type {object} */
    this.prepared = prepared;
    /** @type {object} */
    this.score = prepared.score;
    /** @type {number} */
    this.tempo = clampNum(safeValue(prepared.score.tempo, 96), 20, 320);
    // `score.rubato` is optional: when a score does not state one, slow pieces get a whisper of
    // give-and-take and quick pieces stay in strict time. A score may set 0 to force strict time.
    const rubato = prepared.score.rubato;
    /** @type {number} */
    this.rubato = Number.isFinite(rubato)
      ? clampNum(rubato, 0, 1)
      : (this.tempo < 80 ? 0.25 : (this.tempo < 110 ? 0.12 : 0));
    /** @type {number} */
    this.swing = clampNum(safeValue(prepared.score.swing, 0), 0, 1);
    /** @type {boolean} */
    this.looping = prepared.score.loop !== false;

    /** @type {GainNode} Sum of every track on this deck. */
    this.input = ctx.createGain();
    this.input.gain.value = 1;
    /** @type {GainNode} Crossfade gain for the dry signal. */
    this.gain = ctx.createGain();
    this.gain.gain.value = 1;
    /** @type {GainNode} Crossfade gain for the reverb send. */
    this.sendGain = ctx.createGain();
    this.sendGain.gain.value = 1;
    this.input.connect(this.gain);
    this.gain.connect(mp.musicIn);
    this.sendGain.connect(mp.reverbIn);

    /** @type {object[]} Per-track channels. */
    this.channels = [];
    const tracks = prepared.tracks;
    for (let i = 0; i < tracks.length; i++) {
      this.channels.push(this._makeChannel(tracks[i].params, tracks[i].gain, tracks[i].pan));
    }
    /** @type {object} Extra brass layer used at high action intensity. */
    this.brassCh = this._makeChannel(LAYER_BRASS, 0, -0.12);
    /** @type {object} Extra timpani layer used at high action intensity. */
    this.accentCh = this._makeChannel(LAYER_TIMPANI, 0, 0.1);

    /** @type {number} Index of the next event to schedule. */
    this.cursor = 0;
    /** @type {number} Beat position of the cursor. */
    this.beat = 0;
    /** @type {number} AudioContext time of the cursor. */
    this.time = 0;
    /** @type {number} Completed loops. */
    this.loops = 0;
    /** @type {boolean} True once a non-looping score has run out. */
    this.ended = false;
    /** @type {boolean} True while fading out before disposal. */
    this.stopping = false;
    /** @type {number} Time at which a stopping deck may be disposed. */
    this.fadeEnd = 0;
  }

  /**
   * Builds one mixer channel: track gain into the deck sum, plus the reverb send amount that
   * every voice on the channel uses.
   * @param {object} params Instrument parameters.
   * @param {number} gain Track gain 0..1.
   * @param {number} pan Track pan -1..1.
   * @returns {object} Channel record.
   * @private
   */
  _makeChannel(params, gain, pan) {
    const ctx = this.mp.ctx;
    const dry = ctx.createGain();
    dry.gain.value = clampNum(gain, 0, 4);
    dry.connect(this.input);
    const reverb = clampNum(safeValue(this.score.reverb, 0.35), 0, 1);
    return {
      params,
      family: params.family,
      dry,
      pan: clampNum(pan, -1, 1),
      send: clampNum(reverb * params.send * 0.85, 0, 1.4),
      gain: clampNum(gain, 0, 4),
    };
  }

  /**
   * Seconds between two beat positions, honouring the global tempo scale (action intensity) and
   * the score's rubato. Allocation free.
   * @param {number} fromBeat Start beat.
   * @param {number} toBeat End beat.
   * @returns {number} Duration in seconds (0 when `toBeat <= fromBeat`).
   */
  span(fromBeat, toBeat) {
    const d = toBeat - fromBeat;
    if (!(d > 0)) return 0;
    const spb = 60 / this.tempo / this.mp.tempoScale;
    return d * spb * this.rubatoAt((fromBeat + toBeat) * 0.5);
  }

  /**
   * Tempo multiplier from the score's rubato: phrases breathe out at their cadence and lean
   * forward through the middle. Values stay within +/- 6 %.
   * @param {number} beat Beat position.
   * @returns {number} Seconds-per-beat multiplier.
   */
  rubatoAt(beat) {
    const r = this.rubato;
    if (r <= 0) return 1;
    const phrase = this.prepared.phraseBeats;
    let ph = (beat % phrase) / phrase;
    if (ph < 0) ph += 1;
    return 1 + r * 0.06 * Math.cos(ph * Math.PI * 2);
  }

  /**
   * Advances the scheduling cursor up to `horizon`, spawning voices as it goes.
   * @param {number} horizon Absolute AudioContext time to schedule up to.
   * @param {boolean} silent True to skip events instead of sounding them (resync catch-up).
   * @param {number} budget Maximum events processed in this call.
   * @returns {void}
   */
  schedule(horizon, silent, budget) {
    if (this.ended || this.stopping) return;
    const mp = this.mp;
    const events = this.prepared.events;
    const n = events.length;
    let guard = budget;
    while (guard-- > 0) {
      if (this.cursor >= n) {
        const endTime = this.time + this.span(this.beat, this.prepared.lengthBeats);
        if (endTime > horizon) return;
        this.time = endTime;
        this.beat = 0;
        this.cursor = 0;
        if (this.looping) {
          this.loops++;
          continue;
        }
        this.ended = true;
        return;
      }
      const ev = events[this.cursor];
      const t = this.time + this.span(this.beat, ev.beat);
      if (t > horizon) return;
      this.beat = ev.beat;
      this.time = t;
      this.cursor++;
      if (!silent) mp._spawnEvent(this, ev, t);
    }
  }

  /**
   * Starts the crossfade-in ramp.
   * @param {number} t Start time.
   * @param {number} dur Fade length in seconds.
   * @returns {void}
   */
  fadeIn(t, dur) {
    setAt(this.gain.gain, 0, t);
    linTo(this.gain.gain, 1, t + dur);
    setAt(this.sendGain.gain, 0, t);
    linTo(this.sendGain.gain, 1, t + dur);
  }

  /**
   * Starts the crossfade-out ramp and marks the deck for disposal.
   * @param {number} t Start time.
   * @param {number} dur Fade length in seconds.
   * @returns {void}
   */
  fadeOut(t, dur) {
    if (this.stopping) return;
    this.stopping = true;
    holdAt(this.gain.gain, t);
    linTo(this.gain.gain, 0, t + dur);
    holdAt(this.sendGain.gain, t);
    linTo(this.sendGain.gain, 0, t + dur);
    this.fadeEnd = t + dur + 0.05;
  }

  /**
   * Disconnects every node owned by the deck.
   * @returns {void}
   */
  dispose() {
    for (let i = 0; i < this.channels.length; i++) {
      try {
        this.channels[i].dry.disconnect();
      } catch (err) {
        /* already gone */
      }
    }
    const extra = [this.brassCh, this.accentCh];
    for (let i = 0; i < extra.length; i++) {
      try {
        extra[i].dry.disconnect();
      } catch (err) {
        /* already gone */
      }
    }
    try {
      this.input.disconnect();
      this.gain.disconnect();
      this.sendGain.disconnect();
    } catch (err) {
      /* already gone */
    }
  }
}

/* -------------------------------------------------------------------------------------------
 * MusicPlayer
 * ----------------------------------------------------------------------------------------- */

/**
 * The NEON CITY radio: a look-ahead scheduler plus a synthesised chamber orchestra playing the
 * public-domain scores from `audio/scores.js` into `audioEngine.buses.music`.
 */
export class MusicPlayer {
  /**
   * @param {object} audioEngine The shared {@link AudioEngine}.
   * @param {Object<string, object>} [scores] Score table (injectable for tests).
   * @param {Array<object>|Object<string, object>} [stations] Station table (injectable for tests).
   */
  constructor(audioEngine, scores = SCORES, stations = STATIONS) {
    /** @type {object} Audio engine that owns the AudioContext and the mixer buses. */
    this.engine = audioEngine || null;
    /** @type {AudioContext|null} Cached context; null until the engine has been resumed. */
    this.ctx = null;
    /** @type {Object<string, object>} Score table keyed by score id. */
    this.scores = scores && typeof scores === 'object' ? scores : {};
    /**
     * Radio stations, normalised to {id, name, nameKo, composer, description, descriptionKo,
     * tracks:[scoreId]}. Input entries may name the playlist `tracks` or `trackIds`.
     * @type {Array<object>}
     */
    this.stations = this._buildStations(stations);
    /** @type {string|null} Id of the current station. */
    this.currentStation = this.stations.length > 0 ? this.stations[0].id : null;
    /** @type {string|null} Id of the current track (score). */
    this.currentTrack = null;
    /** @type {boolean} True while the radio is on (even when paused). */
    this.playing = false;
    /** @type {((info: object) => void)|null} "Now playing" callback for the HUD. */
    this.onTrackChange = null;

    /** @type {GainNode|null} Head of the music chain. */
    this.musicIn = null;
    /** @type {BiquadFilterNode|null} Master lowpass, opened by action intensity. */
    this.masterFilter = null;
    /** @type {BiquadFilterNode|null} Low shelf. */
    this.lowShelf = null;
    /** @type {BiquadFilterNode|null} High shelf. */
    this.highShelf = null;
    /** @type {DynamicsCompressorNode|null} Gentle bus glue compressor. */
    this.compressor = null;
    /** @type {GainNode|null} Final music output feeding the music bus. */
    this.musicOut = null;
    /** @type {GainNode|null} Reverb send bus. */
    this.reverbIn = null;
    /** @type {ConvolverNode|null} Algorithmic reverb. */
    this.reverb = null;
    /** @type {GainNode|null} Reverb return. */
    this.reverbReturn = null;
    /** @type {GainNode|null} Sympathetic resonance send (piano). */
    this.resonanceIn = null;

    /** @type {MusicDeck[]} Live decks (two during a crossfade). */
    this._decks = [];
    /** @type {MusicVoice[]} Sounding voices. */
    this._voices = [];
    /** @type {MusicVoice[]} Stolen/stopped voices still fading out before teardown. */
    this._dying = [];
    /** @type {MusicVoice[]} Recycled voice records. */
    this._pool = [];
    /** @type {Map<string, object>} Prepared score cache. */
    this._prepared = new Map();
    /** @type {Object<string, PeriodicWave|null>} Cached periodic waves. */
    this._waves = null;
    /** @type {AudioBuffer|null} Cached noise buffer. */
    this._noise = null;
    /** @type {Object<string, number>} Remembered track index per station. */
    this._stationTrack = {};

    /** @type {number} Master music volume 0..1. */
    this._volume = 0.85;
    /** @type {number} Smoothed action intensity. */
    this._intensity = 0;
    /** @type {number} Target action intensity. */
    this._intensityTarget = 0;
    /** @type {number} Current tempo multiplier derived from the intensity. */
    this.tempoScale = 1;
    /** @type {number} Humanisation amount (0 disables timing jitter). */
    this._humanize = 1;
    /** @type {number} Voice builds that failed and were dropped (diagnostics only). */
    this.voiceErrors = 0;

    this._timer = 0;
    this._paused = false;
    this._pauseTime = 0;
    this._lastPump = 0;
    this._gap = TICK_MS / 1000;
    this._pendingStation = null;
    this._pendingTrack = null;
    this._readyHooked = false;
    this._advancing = false;
    this._tick = this._tick.bind(this);
  }

  /* --------------------------------------------------------------------- station handling */

  /**
   * Normalises the injected station table (array or map) and drops tracks that do not exist,
   * deriving stations from `score.station` when no table is supplied.
   * @param {Array<object>|Object<string, object>|null} stations Raw station table.
   * @returns {Array<object>} Normalised stations.
   * @private
   */
  _buildStations(stations) {
    const out = [];
    let list = null;
    if (Array.isArray(stations)) list = stations;
    else if (stations && typeof stations === 'object') {
      list = [];
      const keys = Object.keys(stations);
      for (let i = 0; i < keys.length; i++) {
        const s = stations[keys[i]];
        if (s && typeof s === 'object') list.push(s.id ? s : Object.assign({ id: keys[i] }, s));
      }
    }
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (!s || typeof s !== 'object') continue;
        const id = typeof s.id === 'string' ? s.id : String(i);
        // The playlist field is `tracks` in the module contract; `trackIds` is accepted too.
        const list2 = Array.isArray(s.tracks) ? s.tracks : (Array.isArray(s.trackIds) ? s.trackIds : null);
        const raw = list2 || [];
        const tracks = [];
        for (let k = 0; k < raw.length; k++) {
          const tid = typeof raw[k] === 'string' ? raw[k] : (raw[k] && raw[k].id);
          if (tid && this._resolveScore(tid)) tracks.push(tid);
        }
        if (tracks.length === 0) continue;
        const fallback = DEFAULT_STATION_NAMES[id];
        out.push({
          id,
          name: s.name || (fallback ? fallback.name : id),
          nameKo: s.nameKo || (fallback ? fallback.nameKo : s.name || id),
          composer: s.composer || '',
          description: s.description || '',
          descriptionKo: s.descriptionKo || '',
          tracks,
        });
      }
    }
    if (out.length > 0) return out;

    // No usable table: group the scores by their own `station` field.
    const ids = Object.keys(this.scores);
    const byStation = {};
    const order = [];
    for (let i = 0; i < ids.length; i++) {
      const sc = this.scores[ids[i]];
      if (!sc || typeof sc !== 'object') continue;
      const key = typeof sc.station === 'string' && sc.station ? sc.station : 'classic';
      if (!byStation[key]) {
        byStation[key] = [];
        order.push(key);
      }
      byStation[key].push(sc.id || ids[i]);
    }
    for (let i = 0; i < order.length; i++) {
      const key = order[i];
      const fallback = DEFAULT_STATION_NAMES[key];
      out.push({
        id: key,
        name: fallback ? fallback.name : key,
        nameKo: fallback ? fallback.nameKo : key,
        composer: '',
        description: '',
        descriptionKo: '',
        tracks: byStation[key],
      });
    }
    return out;
  }

  /**
   * Looks a score up by id, using the injected table first and the `getScore` helper second.
   * @param {string} id Score id.
   * @returns {object|null} The score, or null when unknown.
   * @private
   */
  _resolveScore(id) {
    if (typeof id !== 'string') return null;
    const local = this.scores[id];
    if (local && typeof local === 'object') return local;
    if (typeof getScore === 'function') {
      const s = getScore(id);
      if (s && typeof s === 'object') return s;
    }
    return null;
  }

  /**
   * Finds a station record by id.
   * @param {string} id Station id.
   * @returns {object|null} Station or null.
   * @private
   */
  _station(id) {
    for (let i = 0; i < this.stations.length; i++) {
      if (this.stations[i].id === id) return this.stations[i];
    }
    return null;
  }

  /* ------------------------------------------------------------------------ audio graph */

  /**
   * Builds the music mixer chain once the engine has an AudioContext.
   * @returns {boolean} True when the graph is ready.
   * @private
   */
  _ensureGraph() {
    if (this.musicOut && this.ctx) return true;
    const engine = this.engine;
    if (!engine || !engine.ctx || !engine.buses || !engine.buses.music) return false;
    const ctx = engine.ctx;
    this.ctx = ctx;

    const musicIn = ctx.createGain();
    musicIn.gain.value = 1;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 6800;
    filter.Q.value = 0.4;
    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 180;
    low.gain.value = 1.8;
    const high = ctx.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 5200;
    high.gain.value = 1.2;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 14;
    comp.ratio.value = 2.5;
    comp.attack.value = 0.012;
    comp.release.value = 0.28;
    const out = ctx.createGain();
    out.gain.value = this._volume;

    musicIn.connect(filter);
    filter.connect(low);
    low.connect(high);
    high.connect(comp);
    comp.connect(out);
    out.connect(engine.buses.music);

    // Reverb: shaped send into a generated impulse response.
    const revIn = ctx.createGain();
    revIn.gain.value = 1;
    const revLp = ctx.createBiquadFilter();
    revLp.type = 'lowpass';
    revLp.frequency.value = 7200;
    revLp.Q.value = 0.5;
    const revHp = ctx.createBiquadFilter();
    revHp.type = 'highpass';
    revHp.frequency.value = 160;
    revHp.Q.value = 0.6;
    const conv = ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = this._impulseResponse(2.9);
    const revOut = ctx.createGain();
    revOut.gain.value = 0.9;
    revIn.connect(revLp);
    revLp.connect(revHp);
    revHp.connect(conv);
    conv.connect(revOut);
    revOut.connect(comp);

    // Sympathetic resonance: a damped comb that the piano feeds a little signal into.
    const resIn = ctx.createGain();
    resIn.gain.value = 0.5;
    const delay = ctx.createDelay(0.5);
    delay.delayTime.value = 0.0193;
    const fb = ctx.createGain();
    fb.gain.value = 0.55;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 2400;
    damp.Q.value = 0.4;
    const resOut = ctx.createGain();
    resOut.gain.value = 0.32;
    resIn.connect(delay);
    delay.connect(damp);
    damp.connect(fb);
    fb.connect(delay);
    damp.connect(resOut);
    resOut.connect(comp);

    this.musicIn = musicIn;
    this.masterFilter = filter;
    this.lowShelf = low;
    this.highShelf = high;
    this.compressor = comp;
    this.musicOut = out;
    this.reverbIn = revIn;
    this.reverb = conv;
    this.reverbReturn = revOut;
    this.resonanceIn = resIn;
    this._waves = this._buildWaves(ctx);
    return true;
  }

  /**
   * Generates the reverb impulse response: exponentially decaying, progressively darkened noise
   * with a short pre-delay and a set of early reflections.
   * @param {number} seconds Tail length.
   * @returns {AudioBuffer|null} The impulse response.
   * @private
   */
  _impulseResponse(seconds) {
    const ctx = this.ctx;
    if (!ctx || typeof ctx.createBuffer !== 'function') return null;
    const sr = ctx.sampleRate || 48000;
    const dur = clampNum(seconds, 0.3, 6);
    const len = Math.max(256, Math.floor(sr * dur));
    const buf = ctx.createBuffer(2, len, sr);
    const pre = Math.floor(sr * 0.014);
    const decay = 6.9 / dur;
    let state = 0x1f123bb5;
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      const skew = ch === 0 ? 1 : 1.06;
      let lp = 0;
      for (let i = 0; i < len; i++) {
        if (i < pre) {
          data[i] = 0;
          continue;
        }
        state ^= state << 13;
        state |= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state |= 0;
        const n = state / 2147483648;
        const t = (i - pre) / sr;
        const a = 0.22 + 0.5 * Math.exp(-t * 1.4);
        lp += (n - lp) * a;
        data[i] = lp * Math.exp(-decay * t * skew);
      }
      // Early reflections give the hall a size before the tail takes over.
      for (let k = 0; k < 8; k++) {
        const idx = pre + Math.floor((0.009 + k * 0.0121) * skew * sr);
        const g = 0.5 / (1 + k * 0.55);
        const width = Math.max(8, Math.floor(sr * 0.0018));
        for (let j = 0; j < width && idx + j < len; j++) {
          state ^= state << 13;
          state |= 0;
          state ^= state >>> 17;
          state ^= state << 5;
          state |= 0;
          data[idx + j] += (state / 2147483648) * g * Math.exp(-j / (width * 0.35));
        }
      }
    }
    let peak = 0;
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const v = data[i] < 0 ? -data[i] : data[i];
        if (v > peak) peak = v;
      }
    }
    const norm = peak > 0 ? 0.42 / peak : 1;
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) data[i] *= norm;
    }
    return buf;
  }

  /**
   * Builds the periodic waves used by the organ, harpsichord and woodwinds.
   * @param {BaseAudioContext} ctx Audio context.
   * @returns {Object<string, PeriodicWave|null>} Wave table.
   * @private
   */
  _buildWaves(ctx) {
    const waves = {};
    if (typeof ctx.createPeriodicWave !== 'function') return waves;
    const make = (harmonics) => {
      const n = harmonics.length + 1;
      const real = new Float32Array(n);
      const imag = new Float32Array(n);
      for (let i = 0; i < harmonics.length; i++) imag[i + 1] = harmonics[i];
      try {
        return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
      } catch (err) {
        try {
          return ctx.createPeriodicWave(real, imag);
        } catch (err2) {
          return null;
        }
      }
    };
    const organ = new Array(9).fill(0);
    for (let i = 0; i < ORGAN_HARMONICS.length; i++) organ[ORGAN_HARMONICS[i] - 1] = ORGAN_GAINS[i];
    waves.organ = make(organ);
    const pulse = [];
    for (let n = 1; n <= 16; n++) pulse.push((2 / (n * Math.PI)) * Math.sin(n * Math.PI * 0.28));
    waves.harpsichord = make(pulse);
    waves.oboe = make([1, 0.75, 0.9, 0.6, 0.45, 0.32, 0.25, 0.18, 0.12, 0.08]);
    waves.clarinet = make([1, 0.04, 0.42, 0.03, 0.26, 0.02, 0.16, 0.01, 0.09]);
    waves.flute = make([1, 0.22, 0.07, 0.025, 0.01]);
    return waves;
  }

  /**
   * Returns a cached periodic wave.
   * @param {string} name Wave name.
   * @returns {PeriodicWave|null} The wave, or null when unavailable.
   */
  wave(name) {
    if (!this._waves) return null;
    return this._waves[name] || null;
  }

  /**
   * Returns the shared (deterministically generated) white noise buffer.
   * @returns {AudioBuffer|null} Noise buffer.
   */
  noiseBuffer() {
    if (this._noise) return this._noise;
    const ctx = this.ctx;
    if (!ctx || typeof ctx.createBuffer !== 'function') return null;
    const sr = ctx.sampleRate || 48000;
    const len = Math.max(1024, Math.floor(sr * 2));
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    let state = 0x9e3779b9;
    for (let i = 0; i < len; i++) {
      state ^= state << 13;
      state |= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state |= 0;
      d[i] = (state / 2147483648) * 0.92;
    }
    this._noise = buf;
    return buf;
  }

  /* -------------------------------------------------------------------- score preparation */

  /**
   * Flattens a score into one beat-sorted event list (notes plus synthetic downbeat markers)
   * and works out the derived data the scheduler needs. Cached per score id.
   * @param {object} score Score to prepare.
   * @returns {object|null} Prepared score, or null when the score is unusable.
   * @private
   */
  _prepare(score) {
    if (!score || typeof score !== 'object') return null;
    const id = typeof score.id === 'string' ? score.id : '';
    const cached = this._prepared.get(id);
    if (cached && cached.score === score) return cached;

    const sig = Array.isArray(score.timeSig) ? score.timeSig : [4, 4];
    const num = clampNum(safeValue(sig[0], 4), 1, 32);
    const den = clampNum(safeValue(sig[1], 4), 1, 32);
    const beatsPerBar = Math.max(1, num * 4 / den);

    const rawTracks = Array.isArray(score.tracks) ? score.tracks : [];
    const tracks = [];
    const events = [];
    let maxBeat = 0;
    let lead = -1;
    let leadPitch = -1;

    for (let ti = 0; ti < rawTracks.length; ti++) {
      const tr = rawTracks[ti] || {};
      const name = typeof tr.instrument === 'string' ? tr.instrument : 'piano';
      const params = INSTRUMENTS[name] || INSTRUMENTS.piano;
      tracks.push({
        instrument: name,
        params,
        gain: clampNum(safeValue(tr.gain, 0.8), 0, 4),
        pan: clampNum(safeValue(tr.pan, 0), -1, 1),
      });
      const notes = Array.isArray(tr.notes) ? tr.notes : [];
      let sum = 0;
      let count = 0;
      for (let ni = 0; ni < notes.length; ni++) {
        const n = notes[ni];
        if (!n || n.length < 2) continue;
        const pitchRaw = n[1];
        if (pitchRaw === null || pitchRaw === undefined) continue;
        const pitch = Math.round(clampNum(safeValue(pitchRaw, 60), 0, 127));
        const beat = Math.max(0, safeValue(n[0], 0));
        let dur = safeValue(n[2], 0.5);
        if (!(dur > 0)) dur = 0.25;
        const vel = clampNum(safeValue(n[3], 0.7), 0.03, 1);
        const art = typeof n[4] === 'string' ? n[4] : '';
        events.push({ beat, kind: 0, track: ti, pitch, dur, vel, art, idx: 0 });
        if (beat + dur > maxBeat) maxBeat = beat + dur;
        sum += pitch;
        count++;
      }
      // The melody layer for the action doubling: highest average pitch, no percussion/bass.
      if (count > 0 && params.family !== 'timpani' && name !== 'bass') {
        const avg = sum / count;
        if (avg > leadPitch) {
          leadPitch = avg;
          lead = ti;
        }
      }
    }

    let lengthBeats = safeValue(score.lengthBeats, 0);
    if (!(lengthBeats > 0)) lengthBeats = Math.ceil(Math.max(beatsPerBar, maxBeat) / beatsPerBar) * beatsPerBar;
    if (lengthBeats < maxBeat) lengthBeats = maxBeat;
    if (!(lengthBeats > 0)) lengthBeats = beatsPerBar;

    const tonic = keyPitchClass(score.key);
    const timpBase = 40 + ((tonic - 4 + 12) % 12);
    for (let b = 0, bar = 0; b < lengthBeats - 1e-6; b += beatsPerBar, bar++) {
      events.push({ beat: b, kind: 1, track: -1, pitch: bar % 2 === 0 ? timpBase : timpBase + 7, dur: 1, vel: 0.7, art: '', idx: 0 });
    }

    events.sort((a, b) => (a.beat - b.beat) || (a.kind - b.kind) || (a.track - b.track) || (a.pitch - b.pitch));
    for (let i = 0; i < events.length; i++) events[i].idx = i;

    let phraseBeats = beatsPerBar * 2;
    const sections = Array.isArray(score.sections) ? score.sections : null;
    if (sections && sections.length > 1) {
      const first = safeValue(sections[0].startBeat, 0);
      const second = safeValue(sections[1].startBeat, 0);
      const d = second - first;
      // A phrase should breathe over one to four bars; longer sections are subdivided.
      if (d > 0) phraseBeats = clampNum(d, beatsPerBar, beatsPerBar * 4);
    }

    const prepared = {
      score,
      tracks,
      events,
      lengthBeats,
      beatsPerBar,
      phraseBeats,
      leadTrack: lead,
      tonic,
    };
    if (id) this._prepared.set(id, prepared);
    return prepared;
  }

  /* -------------------------------------------------------------------------- transport */

  /**
   * Starts the radio. With no argument it resumes the current station (or the first one).
   * Calling it while the same track is already playing is a no-op.
   * @param {string|null} [stationId] Station to tune to.
   * @returns {void}
   */
  play(stationId = null) {
    if (this.stations.length === 0) return;
    let station = stationId ? this._station(stationId) : null;
    if (!station) station = this._station(this.currentStation) || this.stations[0];
    const switching = station.id !== this.currentStation;
    this.currentStation = station.id;
    if (this._paused) this.resume();
    // Already on air on this station: play() is idempotent.
    if (this.playing && !switching && this.currentTrack && (this._decks.length > 0 || this._pendingTrack)) return;
    const idx = this._stationTrack[station.id] || 0;
    const trackId = station.tracks[idx % station.tracks.length];
    this.playing = true;
    this._paused = false;
    this._startTrack(trackId, this._decks.length > 0);
  }

  /**
   * Stops playback. Voices fade out over 80 ms so nothing clicks and nothing sticks.
   * Idempotent.
   * @returns {void}
   */
  stop() {
    this.playing = false;
    this._paused = false;
    this._pendingStation = null;
    this._pendingTrack = null;
    this.currentTrack = null;
    if (!this.ctx) {
      this._decks.length = 0;
      this._stopTimer();
      return;
    }
    const now = this.ctx.currentTime;
    this._killAllVoices(now, 0.08);
    for (let i = 0; i < this._decks.length; i++) {
      const d = this._decks[i];
      if (!d.stopping) d.fadeOut(now, 0.08);
    }
    this._pump();
  }

  /**
   * Pauses playback, silencing every sounding voice without losing the position. Idempotent.
   * @returns {void}
   */
  pause() {
    if (!this.playing || this._paused) return;
    this._paused = true;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this._pauseTime = now;
    this._killAllVoices(now, 0.09);
    if (this.musicOut) {
      holdAt(this.musicOut.gain, now);
      linTo(this.musicOut.gain, 0, now + 0.09);
    }
  }

  /**
   * Resumes after {@link MusicPlayer#pause}. Idempotent, and a no-op when nothing was playing.
   * @returns {void}
   */
  resume() {
    if (!this._paused) return;
    this._paused = false;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const shift = Math.max(0, now - this._pauseTime);
    for (let i = 0; i < this._decks.length; i++) {
      const d = this._decks[i];
      d.time += shift;
      if (d.stopping) d.fadeEnd += shift;
    }
    if (this.musicOut) {
      holdAt(this.musicOut.gain, now);
      linTo(this.musicOut.gain, this._volume * (1 + 0.12 * this._intensity), now + 0.12);
    }
    this._lastPump = 0;
    this._startTimer();
    this._pump();
  }

  /**
   * Crossfades to the next track of the current station.
   * @returns {void}
   */
  next() {
    this._step(1);
  }

  /**
   * Crossfades to the previous track of the current station.
   * @returns {void}
   */
  prev() {
    this._step(-1);
  }

  /**
   * Moves the station playlist cursor and starts the resulting track.
   * @param {number} dir +1 or -1.
   * @returns {void}
   * @private
   */
  _step(dir) {
    const station = this._station(this.currentStation);
    if (!station || station.tracks.length === 0) return;
    const n = station.tracks.length;
    let idx = station.tracks.indexOf(this.currentTrack);
    if (idx < 0) idx = this._stationTrack[station.id] || 0;
    idx = ((idx + dir) % n + n) % n;
    this._stationTrack[station.id] = idx;
    this.playing = true;
    this._paused = false;
    this._startTrack(station.tracks[idx], true);
  }

  /**
   * Tunes to a station, crossfading into its remembered track.
   * @param {string} id Station id.
   * @returns {void}
   */
  setStation(id) {
    const station = this._station(id);
    if (!station) return;
    const same = this.currentStation === station.id;
    this.currentStation = station.id;
    if (!this.playing) return;
    if (same && this.currentTrack) return;
    const idx = this._stationTrack[station.id] || 0;
    this.playing = true;
    this._paused = false;
    this._startTrack(station.tracks[idx % station.tracks.length], true);
  }

  /**
   * Tunes to the next station in the list.
   * @returns {void}
   */
  nextStation() {
    if (this.stations.length === 0) return;
    let i = 0;
    for (let k = 0; k < this.stations.length; k++) {
      if (this.stations[k].id === this.currentStation) {
        i = k;
        break;
      }
    }
    const station = this.stations[(i + 1) % this.stations.length];
    this.currentStation = station.id;
    if (!this.playing) {
      this._fireTrackChange();
      return;
    }
    const idx = this._stationTrack[station.id] || 0;
    this._startTrack(station.tracks[idx % station.tracks.length], true);
  }

  /**
   * Tunes to the previous station in the list.
   * @returns {void}
   */
  prevStation() {
    if (this.stations.length === 0) return;
    let i = 0;
    for (let k = 0; k < this.stations.length; k++) {
      if (this.stations[k].id === this.currentStation) {
        i = k;
        break;
      }
    }
    const station = this.stations[(i - 1 + this.stations.length) % this.stations.length];
    this.setStation(station.id);
  }

  /**
   * Plays a specific score by id, whatever station it belongs to.
   * @param {string} trackId Score id.
   * @param {boolean} [crossfade] Crossfade instead of starting instantly.
   * @returns {void}
   */
  setTrack(trackId, crossfade = true) {
    if (!this._resolveScore(trackId)) return;
    for (let i = 0; i < this.stations.length; i++) {
      const idx = this.stations[i].tracks.indexOf(trackId);
      if (idx >= 0) {
        this.currentStation = this.stations[i].id;
        this._stationTrack[this.stations[i].id] = idx;
        break;
      }
    }
    this.playing = true;
    this._paused = false;
    this._startTrack(trackId, crossfade && this._decks.length > 0);
  }

  /**
   * Creates a deck for a track and crossfades (or cuts) into it.
   * @param {string} trackId Score id.
   * @param {boolean} crossfade True to crossfade out whatever is playing.
   * @returns {void}
   * @private
   */
  _startTrack(trackId, crossfade) {
    if (!this._ensureGraph()) {
      // The AudioContext does not exist yet (no user gesture): start as soon as it does.
      this._pendingTrack = trackId;
      this._pendingStation = this.currentStation;
      if (!this._readyHooked && this.engine && typeof this.engine.onReady === 'function') {
        this._readyHooked = true;
        this.engine.onReady(() => {
          this._readyHooked = false;
          const pending = this._pendingTrack;
          const station = this._pendingStation;
          this._pendingTrack = null;
          this._pendingStation = null;
          if (station) this.currentStation = station;
          if (this.playing && pending) this._startTrack(pending, false);
        });
      }
      return;
    }
    const score = this._resolveScore(trackId);
    const prepared = this._prepare(score);
    if (!prepared) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const deck = new MusicDeck(this, prepared);
    deck.time = now + 0.06;
    deck.beat = 0;
    deck.cursor = 0;
    if (crossfade) {
      deck.fadeIn(now, CROSSFADE_SECONDS * 0.8);
      for (let i = 0; i < this._decks.length; i++) {
        const d = this._decks[i];
        if (!d.stopping) d.fadeOut(now, CROSSFADE_SECONDS);
      }
    } else {
      deck.fadeIn(now, 0.35);
      for (let i = 0; i < this._decks.length; i++) {
        const d = this._decks[i];
        if (!d.stopping) d.fadeOut(now, 0.12);
      }
    }
    this._decks.push(deck);
    this.currentTrack = trackId;
    if (this.musicOut) {
      holdAt(this.musicOut.gain, now);
      linTo(this.musicOut.gain, this._volume * (1 + 0.12 * this._intensity), now + 0.12);
    }
    this._applyIntensity(now);
    this._lastPump = 0;
    this._startTimer();
    this._fireTrackChange();
    this._pump();
  }

  /**
   * Builds the "now playing" payload and hands it to {@link MusicPlayer#onTrackChange}.
   * @returns {object|null} The info object that was dispatched.
   * @private
   */
  _fireTrackChange() {
    const info = this.getTrackInfo();
    if (info && typeof this.onTrackChange === 'function') {
      try {
        this.onTrackChange(info);
      } catch (err) {
        /* a HUD listener must never break playback */
      }
    }
    return info;
  }

  /**
   * Current "now playing" information.
   * @returns {{id:string, title:string, titleKo:string, composer:string, station:string,
   *   stationName:string}|null} Track info, or null when nothing is tuned in.
   */
  getTrackInfo() {
    const station = this._station(this.currentStation);
    const score = this.currentTrack ? this._resolveScore(this.currentTrack) : null;
    if (!score) return null;
    return {
      id: score.id || this.currentTrack,
      title: score.title || '',
      titleKo: score.titleKo || score.title || '',
      composer: score.composer || '',
      station: station ? station.id : '',
      stationName: station ? (station.nameKo || station.name) : '',
    };
  }

  /* ---------------------------------------------------------------------------- mixing */

  /**
   * Sets the music player's own output level (on top of the music bus volume).
   * @param {number} v01 Volume 0..1.
   * @returns {void}
   */
  setVolume(v01) {
    this._volume = clampNum(v01, 0, 1);
    if (this.musicOut && this.ctx && !this._paused) {
      targetAt(this.musicOut.gain, this._volume * (1 + 0.12 * this._intensity), this.ctx.currentTime, 0.05);
    }
  }

  /**
   * Sets the action intensity used during police chases: the tempo rises by up to 12 %, the
   * master filter opens, a brass octave layer doubles the melody and the timpani mark the
   * downbeats. Everything ramps smoothly; the piece never restarts.
   * @param {number} x Intensity 0..1.
   * @returns {void}
   */
  setIntensity(x) {
    this._intensityTarget = clampNum(x, 0, 1);
  }

  /**
   * Pushes the smoothed intensity into the audio graph.
   * @param {number} now Current AudioContext time.
   * @returns {void}
   * @private
   */
  _applyIntensity(now) {
    const k = this._intensity;
    this.tempoScale = 1 + INTENSITY_TEMPO * k;
    if (this.masterFilter) targetAt(this.masterFilter.frequency, clampFreq(6800 + 9600 * k), now, 0.35);
    if (this.highShelf) targetAt(this.highShelf.gain, 1.2 + 2.2 * k, now, 0.4);
    if (this.musicOut && !this._paused) targetAt(this.musicOut.gain, this._volume * (1 + 0.12 * k), now, 0.35);
    for (let i = 0; i < this._decks.length; i++) {
      const d = this._decks[i];
      if (d.stopping) continue;
      targetAt(d.brassCh.dry.gain, 0.42 * k, now, 0.4);
      targetAt(d.accentCh.dry.gain, 0.6 * k, now, 0.4);
    }
  }

  /* -------------------------------------------------------------------------- scheduling */

  /**
   * Starts the look-ahead timer.
   * @returns {void}
   * @private
   */
  _startTimer() {
    if (this._timer) return;
    if (typeof setInterval !== 'function') return;
    this._timer = setInterval(this._tick, TICK_MS);
  }

  /**
   * Stops the look-ahead timer.
   * @returns {void}
   * @private
   */
  _stopTimer() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = 0;
  }

  /**
   * Timer callback: pumps the scheduler and shuts the timer down once everything is idle.
   * @returns {void}
   * @private
   */
  _tick() {
    this._pump();
    if (!this.playing && this._voices.length === 0 && this._decks.length === 0) this._stopTimer();
  }

  /**
   * Called once per frame by the game loop. Allocation free; it simply pumps the same
   * scheduler the timer uses, which keeps the music alive even if timers are throttled.
   * @param {number} dt Frame delta in seconds (unused: the audio clock is authoritative).
   * @returns {void}
   */
  update(dt) {
    void dt;
    this._pump();
  }

  /**
   * The scheduler heartbeat: smooths the intensity, reaps dead voices, retires finished decks
   * and schedules every event that falls inside the look-ahead window.
   * @returns {void}
   * @private
   */
  _pump() {
    const ctx = this.ctx;
    if (!ctx) {
      // The context may have appeared since the last attempt (the first user gesture).
      if (this.playing && this._ensureGraph()) {
        const pending = this._pendingTrack || this.currentTrack;
        this._pendingTrack = null;
        if (pending) this._startTrack(pending, false);
      }
      return;
    }
    const now = ctx.currentTime;
    let dt = this._lastPump > 0 ? now - this._lastPump : TICK_MS / 1000;
    if (!(dt > 0)) dt = 0;
    if (dt > 2) dt = 2;
    this._lastPump = now;

    this._reap(now);

    if (this._intensity !== this._intensityTarget) {
      const k = smoothing(dt, 0.9);
      this._intensity += (this._intensityTarget - this._intensity) * k;
      if (Math.abs(this._intensity - this._intensityTarget) < 0.002) this._intensity = this._intensityTarget;
      this._applyIntensity(now);
    }

    // Retire decks whose crossfade has finished.
    for (let i = this._decks.length - 1; i >= 0; i--) {
      const d = this._decks[i];
      if (d.stopping && now >= d.fadeEnd) {
        this._killDeckVoices(d, now, 0.02);
        d.dispose();
        this._decks.splice(i, 1);
      }
    }

    if (!this.playing || this._paused) return;

    // Adaptive horizon: a throttled tab gets a longer window instead of a gap.
    this._gap = Math.max(this._gap * 0.92, dt);
    let look = LOOKAHEAD_SECONDS + this._gap;
    if (look > MAX_HORIZON) look = MAX_HORIZON;
    const horizon = now + look;

    let ended = false;
    for (let i = 0; i < this._decks.length; i++) {
      const d = this._decks[i];
      if (d.stopping || d.ended) {
        if (d.ended && !d.stopping) ended = true;
        continue;
      }
      // Resync: after tab throttling the cursor can be far in the past. Skip forward silently
      // rather than firing hundreds of stale notes at once.
      if (d.time < now - RESYNC_GAP) {
        d.schedule(now - 0.02, true, 400000);
        d.time = Math.max(d.time, now);
      }
      d.schedule(horizon, false, 512);
      if (d.ended) ended = true;
    }

    if (ended && !this._advancing) {
      this._advancing = true;
      this.next();
      this._advancing = false;
    }
  }

  /**
   * Spawns whatever an event asks for: a note, or an intensity-driven downbeat accent.
   * @param {MusicDeck} deck Deck the event belongs to.
   * @param {object} ev Prepared event.
   * @param {number} when Scheduled AudioContext time.
   * @returns {void}
   * @private
   */
  _spawnEvent(deck, ev, when) {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;

    if (ev.kind === 1) {
      if (this._intensity < 0.15) return;
      const vel = clampNum(0.35 + this._intensity * 0.45, 0.05, 1);
      const t = Math.max(when, now + 0.0015);
      this._voiceFor(deck, deck.accentCh, MIDI_FREQ[clampNum(ev.pitch, 24, 72) | 0], t, 0.6, vel, true);
      return;
    }

    const ch = deck.channels[ev.track];
    if (!ch || ch.gain <= 0) return;

    let t0 = when + (hash01(ev.idx, 0x51ed) - 0.5) * 2 * HUMANIZE_SECONDS * this._humanize;
    if (deck.swing > 0) {
      const frac = ev.beat - Math.floor(ev.beat);
      if (Math.abs(frac - 0.5) < 0.02) t0 += deck.swing * (60 / deck.tempo / this.tempoScale) * 0.16;
    }
    if (t0 < now + 0.0015) t0 = now + 0.0015;

    let vel = ev.vel * (0.94 + hash01(ev.idx, 0x2f1b) * 0.12);
    let durBeats = ev.dur;
    let accent = false;
    const art = ev.art;
    if (art === 'staccato') durBeats *= 0.5;
    else if (art === 'legato') durBeats *= 1.06;
    else if (art === 'tenuto') durBeats *= 1.02;
    else if (art === 'accent' || art === 'marcato') {
      vel *= 1.22;
      accent = true;
    }
    vel = clampNum(vel, 0.03, 1);

    let dur = deck.span(ev.beat, ev.beat + durBeats);
    if (!(dur > 0.035)) dur = 0.035;
    const freq = MIDI_FREQ[ev.pitch] * (1 + (hash01(ev.idx, 0x77) - 0.5) * 0.0016);
    this._voiceFor(deck, ch, freq, t0, dur, vel, accent);

    // Action layer: brass doubling the melody an octave down (or in unison when already low).
    if (this._intensity > 0.12 && ev.track === deck.prepared.leadTrack && vel > 0.3) {
      const p = ev.pitch >= 66 ? ev.pitch - 12 : ev.pitch;
      if (p >= 34 && p <= 84) {
        this._voiceFor(deck, deck.brassCh, MIDI_FREQ[p], t0 + 0.007, dur, clampNum(vel * 0.85, 0.05, 1), accent);
      }
    }
  }

  /**
   * Builds one voice, stealing another first when the cap has been reached.
   * @param {MusicDeck} deck Owning deck.
   * @param {object} ch Channel to play on.
   * @param {number} freq Frequency in Hz.
   * @param {number} t0 Start time.
   * @param {number} dur Note length in seconds.
   * @param {number} vel Velocity 0..1.
   * @param {boolean} accent True for accented notes.
   * @returns {MusicVoice|null} The voice, or null when it could not be built.
   * @private
   */
  _voiceFor(deck, ch, freq, t0, dur, vel, accent) {
    const ctx = this.ctx;
    if (!ctx || !ch || !Number.isFinite(freq) || freq <= 0) return null;
    if (this._voices.length >= MAX_VOICES) this._stealVoice(ctx.currentTime);
    if (this._voices.length >= MAX_VOICES) return null;
    const builder = BUILDERS[ch.family] || BUILDERS.piano;
    const peak = ch.params.gain * (0.06 + 0.94 * Math.pow(vel, 1.45));
    const v = this._acquire();
    v.deck = deck;
    v.start = t0;
    v.peak = peak * (ch.gain > 0 ? ch.gain : 1);
    let end = t0 + dur + 0.3;
    try {
      end = builder(this, deck, ch, v, freq, t0, dur, vel, peak, accent);
    } catch (err) {
      // A malformed note must never take the whole radio down.
      this.voiceErrors++;
      v.teardown();
      this._pool.push(v);
      return null;
    }
    if (!Number.isFinite(end) || end < t0) end = t0 + dur + 0.3;
    v.end = end + 0.03;
    const sources = v.sources;
    for (let i = 0; i < sources.length; i++) {
      try {
        sources[i].stop(safeTime(v.end));
      } catch (err) {
        /* some stubs do not implement stop */
      }
    }
    this._voices.push(v);
    return v;
  }

  /**
   * Takes a voice record from the pool (or makes a new one).
   * @returns {MusicVoice} A clean voice record.
   * @private
   */
  _acquire() {
    const v = this._pool.length > 0 ? this._pool.pop() : new MusicVoice();
    v.id = ++voiceIds;
    v.released = false;
    v.start = 0;
    v.end = 0;
    v.peak = 0;
    return v;
  }

  /**
   * Releases the quietest / oldest voice to make room for a new one.
   * @param {number} now Current AudioContext time.
   * @returns {void}
   * @private
   */
  _stealVoice(now) {
    const voices = this._voices;
    let worst = -1;
    let worstScore = Infinity;
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i];
      const age = now - v.start;
      const s = (v.peak * (v.released ? 0.15 : 1)) / (1 + (age > 0 ? age : 0) * 0.7);
      if (s < worstScore) {
        worstScore = s;
        worst = i;
      }
    }
    if (worst < 0) return;
    const v = voices[worst];
    this._releaseVoice(v, now, 0.045);
    // Free the slot immediately so the cap is a hard cap: the node graph tears down on reap.
    voices[worst] = voices[voices.length - 1];
    voices.length -= 1;
    this._dying.push(v);
  }

  /**
   * Force-releases a voice with a short fade.
   * @param {MusicVoice} v Voice to release.
   * @param {number} now Current AudioContext time.
   * @param {number} fade Fade length in seconds.
   * @returns {void}
   * @private
   */
  _releaseVoice(v, now, fade) {
    if (v.released) return;
    v.released = true;
    if (v.amp) {
      holdAt(v.amp.gain, now);
      expTo(v.amp.gain, MIN_GAIN, now + fade);
    }
    const end = now + fade + 0.02;
    if (end < v.end) v.end = end;
    const sources = v.sources;
    for (let i = 0; i < sources.length; i++) {
      try {
        sources[i].stop(safeTime(v.end));
      } catch (err) {
        /* already stopped */
      }
    }
  }

  /**
   * Releases every voice belonging to one deck.
   * @param {MusicDeck} deck Deck.
   * @param {number} now Current AudioContext time.
   * @param {number} fade Fade length in seconds.
   * @returns {void}
   * @private
   */
  _killDeckVoices(deck, now, fade) {
    for (let i = 0; i < this._voices.length; i++) {
      const v = this._voices[i];
      if (v.deck === deck) this._releaseVoice(v, now, fade);
    }
    for (let i = 0; i < this._dying.length; i++) {
      const v = this._dying[i];
      if (v.deck === deck) this._releaseVoice(v, now, fade);
    }
  }

  /**
   * Releases every sounding voice.
   * @param {number} now Current AudioContext time.
   * @param {number} fade Fade length in seconds.
   * @returns {void}
   * @private
   */
  _killAllVoices(now, fade) {
    for (let i = 0; i < this._voices.length; i++) this._releaseVoice(this._voices[i], now, fade);
    for (let i = 0; i < this._dying.length; i++) this._releaseVoice(this._dying[i], now, fade);
  }

  /**
   * Disconnects and pools every voice whose envelope has finished. Allocation free.
   * @param {number} now Current AudioContext time.
   * @returns {void}
   * @private
   */
  _reap(now) {
    const voices = this._voices;
    let w = 0;
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i];
      if (v.end > now) {
        voices[w++] = v;
        continue;
      }
      v.teardown();
      if (this._pool.length < 96) this._pool.push(v);
    }
    voices.length = w;
    const dying = this._dying;
    w = 0;
    for (let i = 0; i < dying.length; i++) {
      const v = dying[i];
      if (v.end > now) {
        dying[w++] = v;
        continue;
      }
      v.teardown();
      if (this._pool.length < 96) this._pool.push(v);
    }
    dying.length = w;
  }

  /* ------------------------------------------------------------------------------ misc */

  /** @returns {number} Number of voices currently sounding. */
  get voiceCount() {
    return this._voices.length + this._dying.length;
  }

  /** @returns {boolean} True while playback is paused. */
  get paused() {
    return this._paused;
  }

  /** @returns {number} Smoothed action intensity 0..1. */
  get intensity() {
    return this._intensity;
  }

  /**
   * Tears the whole player down: stops the timer, kills every voice and disconnects the chain.
   * @returns {void}
   */
  dispose() {
    this.stop();
    this._stopTimer();
    for (let i = 0; i < this._voices.length; i++) this._voices[i].teardown();
    for (let i = 0; i < this._dying.length; i++) this._dying[i].teardown();
    this._voices.length = 0;
    this._dying.length = 0;
    for (let i = 0; i < this._decks.length; i++) this._decks[i].dispose();
    this._decks.length = 0;
    const chain = [this.musicIn, this.masterFilter, this.lowShelf, this.highShelf, this.compressor,
      this.musicOut, this.reverbIn, this.reverb, this.reverbReturn, this.resonanceIn];
    for (let i = 0; i < chain.length; i++) {
      const n = chain[i];
      if (!n) continue;
      try {
        n.disconnect();
      } catch (err) {
        /* already gone */
      }
    }
    this.musicIn = null;
    this.masterFilter = null;
    this.lowShelf = null;
    this.highShelf = null;
    this.compressor = null;
    this.musicOut = null;
    this.reverbIn = null;
    this.reverb = null;
    this.reverbReturn = null;
    this.resonanceIn = null;
    this._prepared.clear();
    this._noise = null;
    this._waves = null;
    this.ctx = null;
  }
}

export default MusicPlayer;
