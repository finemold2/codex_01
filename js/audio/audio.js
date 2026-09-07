/**
 * NEON CITY - Web Audio engine.
 *
 * Owns the single `AudioContext`, the mixer buses, the master limiter, the shared
 * convolution reverb, the 3D listener and a small voice pool used to cap how many
 * one-shots can be alive at once.
 *
 * Everything in NEON CITY is synthesised at runtime (see `audio/sfx.js` and
 * `audio/music.js`); this project ships **no audio files** at all.
 *
 * Signal flow:
 * ```
 *   source -> voice gain -> [air-absorption lowpass -> panner] -> bus gain
 *          -> [bus compressor] -> master -> subsonic filter -> limiter -> destination
 *   voice / panner -> reverb send -> reverb EQ -> convolver -> reverb return -> master
 * ```
 *
 * The `AudioContext` is created lazily on the first {@link AudioEngine#resume} call because
 * every browser blocks audio until a user gesture happens. Until then every entry point is a
 * safe no-op, so gameplay code never has to check whether audio exists.
 *
 * All parameter automation goes through the guarded helpers exported here
 * ({@link setAt}, {@link linTo}, {@link expTo}, {@link targetAt}, {@link envAD}) which clamp
 * NaN/Infinity, keep exponential ramps away from zero and never pass a negative time, so
 * Firefox and Safari cannot throw on edge cases.
 *
 * @module audio/audio
 */

/** Smallest value that may legally be fed to an exponential ramp. @type {number} */
export const MIN_GAIN = 0.0001;

/** Lowest frequency accepted by filters/oscillators. @type {number} */
export const MIN_FREQ = 10;

/** Highest frequency accepted by filters/oscillators (safe below any sane Nyquist). @type {number} */
export const MAX_FREQ = 19000;

/** Mixer bus names, in build order. @type {string[]} */
export const BUS_NAMES = ['music', 'sfx', 'ui', 'ambience', 'vehicle', 'weapon', 'voice'];

/** Default bus volumes (0..1). `master` is included even though it is not a bus. */
const DEFAULT_VOLUMES = {
  master: 0.85,
  music: 0.55,
  sfx: 0.9,
  ui: 0.7,
  ambience: 0.45,
  vehicle: 0.8,
  weapon: 0.95,
  voice: 1,
};

/** Buses that get their own glue compressor (only where it actually helps). */
const BUS_COMPRESSORS = {
  sfx: { threshold: -16, knee: 10, ratio: 3, attack: 0.004, release: 0.18 },
  weapon: { threshold: -12, knee: 6, ratio: 4, attack: 0.002, release: 0.12 },
  vehicle: { threshold: -18, knee: 14, ratio: 2.5, attack: 0.02, release: 0.3 },
};

/** Maximum simultaneous voices per category; the oldest voice is stolen past the limit. */
const VOICE_LIMITS = {
  default: 24,
  weapon: 20,
  impact: 24,
  foot: 14,
  ui: 10,
  vehicle: 16,
  ambience: 8,
  voice: 6,
  music: 96,
};

/** Early-reflection taps used when generating the reverb impulse (seconds, gain). */
const REVERB_TAPS = [
  [0.0091, 0.52], [0.0143, 0.44], [0.0217, 0.36], [0.0298, 0.3],
  [0.0411, 0.24], [0.0563, 0.19], [0.0724, 0.14], [0.0938, 0.1],
];

let voiceIdCounter = 0;

/**
 * Clamps a number into a range, mapping non-finite input to `lo`.
 * @param {number} v Value.
 * @param {number} lo Lower bound.
 * @param {number} hi Upper bound.
 * @returns {number} Clamped value.
 */
export function clampNum(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : (v > hi ? hi : v);
}

/**
 * Replaces NaN/Infinity with a fallback.
 * @param {number} v Value.
 * @param {number} [fallback] Replacement for non-finite input.
 * @returns {number} A finite number.
 */
export function safeValue(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Clamps a schedule time so it is finite and never negative (negative times throw).
 * @param {number} t Time in AudioContext seconds.
 * @returns {number} A legal schedule time.
 */
export function safeTime(t) {
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/**
 * Clamps a frequency into the audible/legal range.
 * @param {number} hz Frequency in Hz.
 * @returns {number} Clamped frequency.
 */
export function clampFreq(hz) {
  return clampNum(hz, MIN_FREQ, MAX_FREQ);
}

/**
 * Guarded `setValueAtTime`.
 * @param {AudioParam} param Target param.
 * @param {number} value Value.
 * @param {number} time Schedule time.
 * @returns {AudioParam} The param, for chaining.
 */
export function setAt(param, value, time) {
  param.setValueAtTime(safeValue(value, 0), safeTime(time));
  return param;
}

/**
 * Guarded `linearRampToValueAtTime`.
 * @param {AudioParam} param Target param.
 * @param {number} value Target value.
 * @param {number} time End time of the ramp.
 * @returns {AudioParam} The param, for chaining.
 */
export function linTo(param, value, time) {
  param.linearRampToValueAtTime(safeValue(value, 0), safeTime(time));
  return param;
}

/**
 * Guarded `exponentialRampToValueAtTime`. Exponential ramps may never touch or cross zero,
 * so the target is clamped to `floor`.
 * @param {AudioParam} param Target param.
 * @param {number} value Target value.
 * @param {number} time End time of the ramp.
 * @param {number} [floor] Minimum magnitude (use {@link MIN_FREQ} for frequency params).
 * @returns {AudioParam} The param, for chaining.
 */
export function expTo(param, value, time, floor = MIN_GAIN) {
  const f = Math.max(MIN_GAIN, safeValue(floor, MIN_GAIN));
  let v = safeValue(value, f);
  if (v < f) v = f;
  param.exponentialRampToValueAtTime(v, safeTime(time));
  return param;
}

/**
 * Guarded `setTargetAtTime` - the click-free way to move a param that is already sounding.
 * @param {AudioParam} param Target param.
 * @param {number} value Target value.
 * @param {number} time Start time.
 * @param {number} [tc] Exponential time constant in seconds.
 * @returns {AudioParam} The param, for chaining.
 */
export function targetAt(param, value, time, tc = 0.02) {
  param.setTargetAtTime(safeValue(value, 0), safeTime(time), Math.max(0.001, safeValue(tc, 0.02)));
  return param;
}

/**
 * Cancels pending automation while holding the value the param has right now.
 * Uses `cancelAndHoldAtTime` where available and falls back for older Firefox/Safari.
 * @param {AudioParam} param Target param.
 * @param {number} time Time to cancel from.
 * @returns {AudioParam} The param, for chaining.
 */
export function holdAt(param, time) {
  const t = safeTime(time);
  if (typeof param.cancelAndHoldAtTime === 'function') {
    param.cancelAndHoldAtTime(t);
  } else {
    const v = safeValue(param.value, 0);
    param.cancelScheduledValues(t);
    param.setValueAtTime(v, t);
  }
  return param;
}

/**
 * Writes a percussive attack/decay envelope (exponential in both directions).
 * @param {AudioParam} param Usually a gain param.
 * @param {number} peak Peak value.
 * @param {number} start Start time.
 * @param {number} attack Attack length in seconds.
 * @param {number} decay Decay length in seconds.
 * @param {number} [floor] Silence floor.
 * @returns {number} Total envelope length in seconds.
 */
export function envAD(param, peak, start, attack, decay, floor = MIN_GAIN) {
  const f = Math.max(MIN_GAIN, safeValue(floor, MIN_GAIN));
  const a = Math.max(0.0005, safeValue(attack, 0.002));
  const d = Math.max(0.005, safeValue(decay, 0.1));
  const p = Math.max(f * 2, safeValue(peak, f * 2));
  setAt(param, f, start);
  expTo(param, p, start + a, f);
  expTo(param, f, start + a + d, f);
  return a + d;
}

/**
 * One pooled one-shot slot. Sounds connect their nodes to {@link Voice#output}; the engine
 * tears the voice down when its scheduled end is reached or when it gets stolen.
 */
class Voice {
  /**
   * @param {AudioEngine} engine Owning engine.
   * @param {string} category Pool category.
   * @param {AudioNode} dest Node the voice output feeds.
   * @param {number} gain Initial voice gain.
   */
  constructor(engine, category, dest, gain) {
    const ctx = engine.ctx;
    /** @type {AudioEngine} */
    this.engine = engine;
    /** @type {string} */
    this.category = category;
    /** @type {number} */
    this.id = ++voiceIdCounter;
    /** @type {number} */
    this.startTime = ctx.currentTime;
    /** @type {number} */
    this.endTime = this.startTime + 1;
    /** @type {boolean} */
    this.active = true;
    /** @type {GainNode} Connect sound chains here. */
    this.output = ctx.createGain();
    this.output.gain.value = clampNum(gain, 0, 8);
    /** @type {AudioNode} */
    this.dest = dest;
    this.output.connect(dest);
    /** @type {AudioNode[]} Extra nodes disposed with the voice. */
    this.extras = [];
    /** @type {Function|null} Called once when the voice is torn down. */
    this.onStop = null;
    /** @type {object|null} Positional chain owned by this voice, if any. */
    this.spatial = null;
    /** @type {ConstantSourceNode|null} */
    this.keepAlive = null;
    /** @type {*} */
    this.timer = 0;
  }

  /**
   * Schedules the moment the voice is released.
   * @param {number} when AudioContext time.
   * @returns {void}
   */
  scheduleEnd(when) {
    const ctx = this.engine.ctx;
    const end = Math.max(ctx.currentTime + 0.01, safeValue(when, ctx.currentTime + 1));
    this.endTime = end;
    if (!this.keepAlive && typeof ctx.createConstantSource === 'function') {
      // A silent source keeps a sample-accurate handle on the end of the voice, so cleanup
      // still happens when timers are throttled in a background tab.
      const keep = ctx.createConstantSource();
      keep.offset.value = 0;
      keep.connect(this.output);
      keep.onended = () => this.dispose();
      try {
        keep.start(safeTime(this.startTime));
      } catch (err) {
        /* already started */
      }
      this.keepAlive = keep;
    }
    if (this.keepAlive) {
      try {
        this.keepAlive.stop(safeTime(end));
      } catch (err) {
        /* stop already scheduled earlier */
      }
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.dispose(), Math.max(0, (end - ctx.currentTime) * 1000) + 120);
  }

  /**
   * Fades the voice out and releases it.
   * @param {number} [when] AudioContext time to start the fade.
   * @param {number} [fade] Fade length in seconds.
   * @returns {void}
   */
  stop(when, fade = 0.03) {
    if (!this.active) return;
    const ctx = this.engine.ctx;
    const t = Math.max(ctx.currentTime, safeValue(when, ctx.currentTime));
    const f = Math.max(0.005, safeValue(fade, 0.03));
    holdAt(this.output.gain, t);
    expTo(this.output.gain, MIN_GAIN, t + f);
    this.scheduleEnd(t + f + 0.01);
  }

  /**
   * Immediately steals the voice for a newer sound (short fade to avoid a click).
   * @returns {void}
   */
  steal() {
    if (!this.active) return;
    const t = this.engine.ctx.currentTime;
    holdAt(this.output.gain, t);
    expTo(this.output.gain, MIN_GAIN, t + 0.035);
    this.scheduleEnd(t + 0.045);
  }

  /**
   * Disconnects everything the voice owns. Idempotent.
   * @returns {void}
   */
  dispose() {
    if (!this.active) return;
    this.active = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = 0;
    }
    if (this.onStop) {
      const fn = this.onStop;
      this.onStop = null;
      try {
        fn();
      } catch (err) {
        /* a broken sound must never break the mixer */
      }
    }
    if (this.keepAlive) {
      try {
        this.keepAlive.disconnect();
      } catch (err) {
        /* already gone */
      }
      this.keepAlive = null;
    }
    for (let i = 0; i < this.extras.length; i++) {
      try {
        this.extras[i].disconnect();
      } catch (err) {
        /* already gone */
      }
    }
    this.extras.length = 0;
    try {
      this.output.disconnect();
    } catch (err) {
      /* already gone */
    }
    if (this.spatial) {
      this.spatial.stop(0, 0.01);
      this.spatial = null;
    }
    this.engine.releaseVoice(this);
  }
}

/**
 * The game's audio engine: mixer, reverb, listener and voice pool.
 *
 * Construction is cheap and allocates no `AudioContext`; call {@link AudioEngine#resume}
 * from a user gesture to actually start the audio hardware.
 */
export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} Created lazily on the first resume(). */
    this.ctx = null;
    /** @type {GainNode|null} Master gain (before the limiter). */
    this.master = null;
    /** @type {BiquadFilterNode|null} Subsonic cleanup before the limiter. */
    this.masterFilter = null;
    /** @type {DynamicsCompressorNode|null} Brickwall limiter feeding the destination. */
    this.limiter = null;
    /** @type {Object<string, GainNode>} Bus input gains keyed by bus name. */
    this.buses = {};
    /** @type {Object<string, DynamicsCompressorNode>} Per-bus glue compressors. */
    this.busCompressors = {};
    /** @type {GainNode|null} Shared reverb send - connect anything here. */
    this.reverbSend = null;
    /** @type {ConvolverNode|null} Shared reverb. */
    this.reverb = null;
    /** @type {GainNode|null} Reverb return into the master bus. */
    this.reverbReturn = null;
    /** @type {Object<string, number>} Stored bus volumes (survive across context builds). */
    this.volumes = Object.assign({}, DEFAULT_VOLUMES);
    /** @type {Object<string, number>} Per-category voice caps. */
    this.voiceLimits = Object.assign({}, VOICE_LIMITS);
    /** @type {'hrtf'|'equalpower'} Panner model actually used. */
    this.spatialQuality = 'hrtf';
    /** @type {Float32Array} Last listener position. */
    this.listenerPos = new Float32Array(3);
    /** @type {Float32Array} Last listener forward vector. */
    this.listenerFwd = Float32Array.from([0, 0, -1]);
    /** @type {Float32Array} Last listener up vector. */
    this.listenerUp = Float32Array.from([0, 1, 0]);
    /** @type {Float32Array} Last listener velocity. */
    this.listenerVel = new Float32Array(3);
    /** @type {boolean} True when the mixer is muted (master forced to silence). */
    this.muted = false;

    /** @type {Map<string, Voice[]>} */
    this._voices = new Map();
    /** @type {Map<string, AudioBuffer>} */
    this._noise = new Map();
    /** @type {Map<number, Float32Array>} */
    this._curves = new Map();
    /** @type {Function[]} */
    this._readyCbs = [];
    this._built = false;
    this._failed = false;
    this._enabled = false;
    this._duck = 1;
    this._duckTimer = 0;
    this._voiceCount = 0;
  }

  /** @returns {number} Current AudioContext time (0 before the context exists). */
  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** @returns {boolean} True when audio is built, unmuted and actually running. */
  get enabled() {
    return this._built && this._enabled && !!this.ctx && this.ctx.state === 'running';
  }

  /**
   * Enables or disables audio (setter form of {@link AudioEngine#resume} / {@link AudioEngine#suspend}).
   * @param {boolean} v Desired state.
   */
  set enabled(v) {
    if (v) this.resume();
    else this.suspend();
  }

  /** @returns {number} Number of pooled voices currently alive. */
  get activeVoices() {
    return this._voiceCount;
  }

  /** @returns {number} Output sample rate (0 before the context exists). */
  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : 0;
  }

  /**
   * Creates the AudioContext and the whole mixer graph. Safe to call repeatedly.
   * @returns {boolean} True when the graph exists.
   * @private
   */
  _build() {
    if (this._built) return true;
    if (this._failed) return false;
    const scope = typeof globalThis !== 'undefined' ? globalThis : null;
    const Ctor = scope ? (scope.AudioContext || scope.webkitAudioContext) : null;
    if (!Ctor) {
      this._failed = true;
      return false;
    }
    let ctx = null;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch (err) {
      try {
        ctx = new Ctor();
      } catch (err2) {
        this._failed = true;
        return false;
      }
    }
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : this.volumes.master;
    const sub = ctx.createBiquadFilter();
    sub.type = 'highpass';
    sub.frequency.value = 22;
    sub.Q.value = 0.5;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    master.connect(sub);
    sub.connect(limiter);
    limiter.connect(ctx.destination);
    this.master = master;
    this.masterFilter = sub;
    this.limiter = limiter;

    for (let i = 0; i < BUS_NAMES.length; i++) {
      const name = BUS_NAMES[i];
      const gain = ctx.createGain();
      gain.gain.value = name === 'music' ? this.volumes.music * this._duck : this.volumes[name];
      const cfg = BUS_COMPRESSORS[name];
      if (cfg) {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = cfg.threshold;
        comp.knee.value = cfg.knee;
        comp.ratio.value = cfg.ratio;
        comp.attack.value = cfg.attack;
        comp.release.value = cfg.release;
        gain.connect(comp);
        comp.connect(master);
        this.busCompressors[name] = comp;
      } else {
        gain.connect(master);
      }
      this.buses[name] = gain;
    }

    this._buildReverb();

    const cores = (typeof navigator !== 'undefined' && navigator && navigator.hardwareConcurrency) || 4;
    this.spatialQuality = cores >= 4 ? 'hrtf' : 'equalpower';

    if ('onstatechange' in ctx) {
      ctx.onstatechange = () => {
        if (ctx.state === 'running') this._enabled = true;
      };
    }

    this._built = true;
    this._enabled = true;
    const cbs = this._readyCbs;
    this._readyCbs = [];
    for (let i = 0; i < cbs.length; i++) {
      try {
        cbs[i](this);
      } catch (err) {
        /* a listener must not break the boot */
      }
    }
    return true;
  }

  /**
   * Builds the shared reverb send chain.
   * @returns {void}
   * @private
   */
  _buildReverb() {
    const ctx = this.ctx;
    const send = ctx.createGain();
    send.gain.value = 1;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 6400;
    lp.Q.value = 0.6;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 180;
    hp.Q.value = 0.6;
    const conv = ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = this.createImpulseResponse(2.2);
    const ret = ctx.createGain();
    ret.gain.value = 0.85;
    send.connect(lp);
    lp.connect(hp);
    hp.connect(conv);
    conv.connect(ret);
    ret.connect(this.master);
    this.reverbSend = send;
    this.reverb = conv;
    this.reverbReturn = ret;
  }

  /**
   * Generates a stereo impulse response: exponentially decaying, progressively darkened
   * noise with a short pre-delay and a set of early reflections.
   *
   * The result is normalised by **energy**, not by peak. The convolver runs with
   * `normalize = false`, where the wet output level is the input times `sqrt(sum(h^2))`;
   * for a tail this long that is ~25 dB above unity if the buffer is only peak-normalised,
   * which would drown the dry mix and pin the master limiter. Scaling by the RMS instead
   * gives the reverb unity wet gain, so a send of `x` means `x` times the dry level.
   * @param {number} [seconds] Tail length (-60 dB point).
   * @returns {AudioBuffer} The impulse response.
   */
  createImpulseResponse(seconds = 2.2) {
    const ctx = this.ctx;
    const sr = ctx.sampleRate || 48000;
    const dur = clampNum(seconds, 0.2, 8);
    const len = Math.max(64, Math.floor(sr * dur));
    const buf = ctx.createBuffer(2, len, sr);
    const preDelay = Math.floor(sr * 0.011);
    const decay = 6.9 / dur;
    let peak = 0;
    let energy = 0;
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      const skew = ch === 0 ? 1 : 1.07;
      let lp = 0;
      for (let i = 0; i < len; i++) {
        if (i < preDelay) {
          data[i] = 0;
          continue;
        }
        const t = (i - preDelay) / sr;
        const n = Math.random() * 2 - 1;
        // Damping increases with time: the tail gets darker as it decays.
        const a = 0.26 + 0.5 * Math.exp(-t * 1.3);
        lp += (n - lp) * a;
        data[i] = lp * Math.exp(-decay * t * skew);
      }
      for (let k = 0; k < REVERB_TAPS.length; k++) {
        const tap = REVERB_TAPS[k];
        const idx = preDelay + Math.floor(tap[0] * skew * sr);
        const width = Math.max(8, Math.floor(sr * 0.0016));
        const g = tap[1] * (ch === 0 ? 1 : 0.88);
        for (let j = 0; j < width && idx + j < len; j++) {
          data[idx + j] += (Math.random() * 2 - 1) * g * Math.exp(-j / (width * 0.35));
        }
      }
      for (let i = 0; i < len; i++) {
        const v = data[i] < 0 ? -data[i] : data[i];
        if (v > peak) peak = v;
        energy += data[i] * data[i];
      }
    }
    // Unity convolution gain: divide by the per-channel RMS sum, then make sure no single
    // sample can still clip the convolver.
    const rms = Math.sqrt(energy / 2);
    let norm = rms > 1e-9 ? 1 / rms : 1;
    if (peak * norm > 1) norm = peak > 0 ? 1 / peak : 1;
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) data[i] *= norm;
    }
    return buf;
  }

  /**
   * Registers a callback fired once the AudioContext and mixer exist (immediately when
   * they already do). Used by music.js/sfx.js to build their own chains.
   * @param {(engine: AudioEngine) => void} fn Callback.
   * @returns {void}
   */
  onReady(fn) {
    if (typeof fn !== 'function') return;
    if (this._built) fn(this);
    else this._readyCbs.push(fn);
  }

  /**
   * Creates the AudioContext if needed and resumes it. Must be called from a user gesture.
   * @returns {Promise<boolean>} True when the context is running.
   */
  async resume() {
    if (!this._build()) return false;
    this._enabled = true;
    const ctx = this.ctx;
    if (ctx.state !== 'running' && typeof ctx.resume === 'function') {
      try {
        await ctx.resume();
      } catch (err) {
        return false;
      }
    }
    return ctx.state === 'running';
  }

  /**
   * Suspends the audio hardware (silences everything, keeps the graph).
   * @returns {Promise<void>} Resolves once suspended.
   */
  async suspend() {
    this._enabled = false;
    if (!this.ctx || typeof this.ctx.suspend !== 'function') return;
    try {
      await this.ctx.suspend();
    } catch (err) {
      /* nothing to suspend */
    }
  }

  /**
   * Sets a bus volume. `'master'` is accepted alongside the seven bus names.
   * @param {string} bus Bus name.
   * @param {number} v01 Volume, 0..1 (up to 2 is allowed as a boost).
   * @returns {void}
   */
  setVolume(bus, v01) {
    const name = bus === 'master' || BUS_NAMES.indexOf(bus) >= 0 ? bus : null;
    if (!name) return;
    this.volumes[name] = clampNum(v01, 0, 2);
    this._applyVolume(name);
  }

  /**
   * Reads a stored bus volume.
   * @param {string} bus Bus name (or `'master'`).
   * @returns {number} Volume 0..2.
   */
  getVolume(bus) {
    const v = this.volumes[bus];
    return Number.isFinite(v) ? v : 0;
  }

  /**
   * Mutes or unmutes the master bus without touching the stored volumes.
   * @param {boolean} muted True to silence everything.
   * @returns {void}
   */
  setMuted(muted) {
    this.muted = !!muted;
    this._applyVolume('master');
  }

  /**
   * Pushes a stored volume onto the live graph with a short ramp.
   * @param {string} name Bus name or `'master'`.
   * @returns {void}
   * @private
   */
  _applyVolume(name) {
    if (!this._built) return;
    const node = name === 'master' ? this.master : this.buses[name];
    if (!node) return;
    let v = this.volumes[name];
    if (name === 'music') v *= this._duck;
    if (name === 'master' && this.muted) v = 0;
    const t = this.ctx.currentTime;
    holdAt(node.gain, t);
    linTo(node.gain, clampNum(v, 0, 2), t + 0.03);
  }

  /**
   * Ducks the music bus, e.g. while a mission line plays.
   * @param {number} amount Target multiplier (1 = no duck, 0.4 = -8 dB).
   * @param {number} [seconds] Ramp length.
   * @param {number} [hold] When > 0, automatically ramps back to 1 after this many seconds.
   * @returns {void}
   */
  duck(amount, seconds = 0.25, hold = 0) {
    this._duck = clampNum(amount, 0, 1);
    if (this._duckTimer) {
      clearTimeout(this._duckTimer);
      this._duckTimer = 0;
    }
    if (!this._built) return;
    const bus = this.buses.music;
    if (!bus) return;
    const t = this.ctx.currentTime;
    const dur = Math.max(0.01, safeValue(seconds, 0.25));
    holdAt(bus.gain, t);
    linTo(bus.gain, clampNum(this.volumes.music * this._duck, 0, 2), t + dur);
    const h = safeValue(hold, 0);
    if (h > 0) {
      this._duckTimer = setTimeout(() => {
        this._duckTimer = 0;
        this.duck(1, 0.4);
      }, (h + dur) * 1000);
    }
  }

  /**
   * Updates the 3D listener. Uses the modern AudioParam interface when present and falls
   * back to the deprecated `setPosition`/`setOrientation` pair otherwise.
   * @param {ArrayLike<number>} position3 World position.
   * @param {ArrayLike<number>} forward3 Forward vector (need not be normalised).
   * @param {ArrayLike<number>} up3 Up vector.
   * @param {ArrayLike<number>} [velocity3] Listener velocity (stored, used for engine doppler feel).
   * @returns {void}
   */
  setListener(position3, forward3, up3, velocity3) {
    if (!this._built || !this.ctx) return;
    const p = this.listenerPos;
    const f = this.listenerFwd;
    const u = this.listenerUp;
    const v = this.listenerVel;
    if (position3) {
      p[0] = safeValue(position3[0], p[0]);
      p[1] = safeValue(position3[1], p[1]);
      p[2] = safeValue(position3[2], p[2]);
    }
    if (forward3) {
      const fx = safeValue(forward3[0], 0);
      const fy = safeValue(forward3[1], 0);
      const fz = safeValue(forward3[2], -1);
      const fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
      if (fl > 1e-5) {
        f[0] = fx / fl;
        f[1] = fy / fl;
        f[2] = fz / fl;
      }
    }
    if (up3) {
      const ux = safeValue(up3[0], 0);
      const uy = safeValue(up3[1], 1);
      const uz = safeValue(up3[2], 0);
      const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
      if (ul > 1e-5) {
        u[0] = ux / ul;
        u[1] = uy / ul;
        u[2] = uz / ul;
      }
    }
    if (velocity3) {
      v[0] = safeValue(velocity3[0], 0);
      v[1] = safeValue(velocity3[1], 0);
      v[2] = safeValue(velocity3[2], 0);
    }
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (l.positionX && typeof l.positionX.setTargetAtTime === 'function') {
      targetAt(l.positionX, p[0], t, 0.015);
      targetAt(l.positionY, p[1], t, 0.015);
      targetAt(l.positionZ, p[2], t, 0.015);
      targetAt(l.forwardX, f[0], t, 0.015);
      targetAt(l.forwardY, f[1], t, 0.015);
      targetAt(l.forwardZ, f[2], t, 0.015);
      targetAt(l.upX, u[0], t, 0.02);
      targetAt(l.upY, u[1], t, 0.02);
      targetAt(l.upZ, u[2], t, 0.02);
    } else {
      if (typeof l.setPosition === 'function') l.setPosition(p[0], p[1], p[2]);
      if (typeof l.setOrientation === 'function') l.setOrientation(f[0], f[1], f[2], u[0], u[1], u[2]);
    }
  }

  /**
   * Builds a positional chain: air-absorption lowpass -> panner -> output gain -> bus,
   * with a parallel reverb send.
   * @param {string} bus Destination bus name.
   * @param {object} [opts] Options.
   * @param {ArrayLike<number>} [opts.pos] Initial world position.
   * @param {number} [opts.gain] Output gain.
   * @param {number} [opts.reverb] Reverb send amount 0..1.
   * @param {number} [opts.refDistance] Panner reference distance.
   * @param {number} [opts.maxDistance] Panner max distance.
   * @param {number} [opts.rolloff] Panner rolloff factor.
   * @param {number} [opts.occlusion] 0 = clear line of sight, 1 = fully muffled.
   * @param {boolean} [opts.airAbsorption] Set false to bypass the distance lowpass.
   * @returns {{input: GainNode, node: PannerNode, output: GainNode, send: GainNode,
   *   setPosition: Function, setVolume: Function, setOcclusion: Function, stop: Function, alive: boolean}}
   *   The positional handle, or a silent stub when audio is unavailable.
   */
  createPositional(bus, opts) {
    if (!this._built && !this._build()) return makeDeadPositional();
    const ctx = this.ctx;
    const o = opts || EMPTY_OPTS;
    const dest = this.buses[bus] || this.buses.sfx;
    const input = ctx.createGain();
    input.gain.value = 1;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = MAX_FREQ;
    filter.Q.value = 0.4;
    const panner = ctx.createPanner();
    try {
      panner.panningModel = this.spatialQuality === 'hrtf' ? 'HRTF' : 'equalpower';
    } catch (err) {
      panner.panningModel = 'equalpower';
    }
    panner.distanceModel = 'inverse';
    panner.refDistance = Number.isFinite(o.refDistance) ? clampNum(o.refDistance, 0.5, 2000) : 6;
    panner.maxDistance = Number.isFinite(o.maxDistance) ? clampNum(o.maxDistance, 10, 20000) : 260;
    panner.rolloffFactor = Number.isFinite(o.rolloff) ? clampNum(o.rolloff, 0.05, 8) : 1.1;
    panner.coneInnerAngle = 360;
    panner.coneOuterAngle = 360;
    panner.coneOuterGain = 1;
    const output = ctx.createGain();
    output.gain.value = Number.isFinite(o.gain) ? clampNum(o.gain, 0, 8) : 1;
    const send = ctx.createGain();
    send.gain.value = clampNum(o.reverb, 0, 4);

    input.connect(filter);
    filter.connect(panner);
    panner.connect(output);
    output.connect(dest);
    output.connect(send);
    send.connect(this.reverbSend);

    const engine = this;
    let occlusion = clampNum(o.occlusion, 0, 1);
    let disposed = false;
    let timer = 0;
    const airAbsorption = o.airAbsorption !== false;

    /**
     * Recomputes the air-absorption cutoff from the current distance and occlusion.
     * @param {number} x World X.
     * @param {number} y World Y.
     * @param {number} z World Z.
     * @returns {void}
     */
    function updateFilter(x, y, z) {
      const lp = engine.listenerPos;
      const dx = x - lp[0];
      const dy = y - lp[1];
      const dz = z - lp[2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      let cut = airAbsorption ? 18000 * Math.exp(-d / 95) : MAX_FREQ;
      cut *= 1 - 0.82 * occlusion;
      targetAt(filter.frequency, clampFreq(cut), engine.ctx.currentTime, 0.06);
    }

    const handle = {
      input,
      node: panner,
      output,
      send,
      alive: true,
      /**
       * Moves the sound. Accepts `(x, y, z)` or a single vec3-like argument.
       * @param {number|ArrayLike<number>} x X, or a position array.
       * @param {number} [y] Y.
       * @param {number} [z] Z.
       * @returns {void}
       */
      setPosition(x, y, z) {
        if (disposed) return;
        let px = x;
        let py = y;
        let pz = z;
        if (x !== null && typeof x === 'object') {
          px = x[0];
          py = x[1];
          pz = x[2];
        }
        px = safeValue(px, 0);
        py = safeValue(py, 0);
        pz = safeValue(pz, 0);
        const t = engine.ctx.currentTime;
        if (panner.positionX && typeof panner.positionX.setTargetAtTime === 'function') {
          targetAt(panner.positionX, px, t, 0.02);
          targetAt(panner.positionY, py, t, 0.02);
          targetAt(panner.positionZ, pz, t, 0.02);
        } else if (typeof panner.setPosition === 'function') {
          panner.setPosition(px, py, pz);
        }
        updateFilter(px, py, pz);
      },
      /**
       * Sets the output level.
       * @param {number} v Gain.
       * @param {number} [ramp] Ramp length in seconds.
       * @returns {void}
       */
      setVolume(v, ramp = 0.03) {
        if (disposed) return;
        const t = engine.ctx.currentTime;
        holdAt(output.gain, t);
        linTo(output.gain, clampNum(v, 0, 8), t + Math.max(0.005, safeValue(ramp, 0.03)));
      },
      /**
       * Sets how muffled the sound is (walls between source and listener).
       * @param {number} v 0..1.
       * @returns {void}
       */
      setOcclusion(v) {
        occlusion = clampNum(v, 0, 1);
      },
      /**
       * Sets the reverb send amount.
       * @param {number} v 0..1.
       * @returns {void}
       */
      setReverb(v) {
        if (disposed) return;
        const t = engine.ctx.currentTime;
        holdAt(send.gain, t);
        linTo(send.gain, clampNum(v, 0, 4), t + 0.05);
      },
      /**
       * Fades out and disconnects the chain.
       * @param {number} [when] Start time.
       * @param {number} [fade] Fade length.
       * @returns {void}
       */
      stop(when, fade = 0.05) {
        if (disposed) return;
        disposed = true;
        handle.alive = false;
        const t = Math.max(engine.ctx.currentTime, safeValue(when, 0));
        const f = Math.max(0.005, safeValue(fade, 0.05));
        holdAt(output.gain, t);
        expTo(output.gain, MIN_GAIN, t + f);
        timer = setTimeout(() => {
          timer = 0;
          const nodes = [input, filter, panner, output, send];
          for (let i = 0; i < nodes.length; i++) {
            try {
              nodes[i].disconnect();
            } catch (err) {
              /* already gone */
            }
          }
        }, (t + f - engine.ctx.currentTime) * 1000 + 80);
      },
    };

    if (o.pos) handle.setPosition(o.pos[0], o.pos[1], o.pos[2]);
    else handle.setPosition(0, 0, 0);
    return handle;
  }

  /**
   * Allocates a pooled one-shot voice, stealing the oldest voice of the category when the
   * cap is reached.
   * @param {string} [category] Pool category (defaults to `'sfx'`).
   * @param {object} [opts] Options.
   * @param {number} [opts.gain] Initial voice gain.
   * @param {AudioNode} [opts.dest] Destination node (defaults to the sfx bus).
   * @returns {Voice|null} The voice, or null when audio is unavailable.
   */
  allocVoice(category = 'sfx', opts = null) {
    if (!this._built && !this._build()) return null;
    const cat = category || 'sfx';
    let list = this._voices.get(cat);
    if (!list) {
      list = [];
      this._voices.set(cat, list);
    }
    for (let i = list.length - 1; i >= 0; i--) {
      if (!list[i].active) list.splice(i, 1);
    }
    const limit = this.voiceLimits[cat] || this.voiceLimits.default;
    while (list.length >= limit) {
      const oldest = list.shift();
      this._voiceCount = Math.max(0, this._voiceCount - 1);
      oldest.steal();
    }
    const dest = (opts && opts.dest) || this.buses[cat] || this.buses.sfx;
    const gain = opts && Number.isFinite(opts.gain) ? opts.gain : 1;
    const voice = new Voice(this, cat, dest, gain);
    list.push(voice);
    this._voiceCount++;
    return voice;
  }

  /**
   * Removes a voice from its pool. Called by {@link Voice#dispose}.
   * @param {Voice} voice Voice to release.
   * @returns {void}
   */
  releaseVoice(voice) {
    const list = this._voices.get(voice.category);
    if (list) {
      const i = list.indexOf(voice);
      if (i >= 0) {
        list.splice(i, 1);
        this._voiceCount = Math.max(0, this._voiceCount - 1);
      }
    }
  }

  /**
   * Schedules a source node, stopping it and disconnecting it (plus an optional chain)
   * in `onended` so no node ever leaks.
   * @param {AudioScheduledSourceNode} source Oscillator / buffer source / constant source.
   * @param {number} when Start time.
   * @param {number} stopAt Stop time.
   * @param {AudioNode[]} [chain] Extra nodes disconnected together with the source.
   * @param {number} [offset] Buffer offset in seconds (buffer sources only).
   * @returns {AudioScheduledSourceNode} The source, for chaining.
   */
  schedule(source, when, stopAt, chain = null, offset = 0) {
    const t = safeTime(when);
    try {
      const buf = source.buffer;
      if (offset > 0 && buf && buf.duration > 0) source.start(t, offset % buf.duration);
      else source.start(t);
    } catch (err) {
      /* already started */
    }
    const end = safeValue(stopAt, t + 1);
    if (end > t) {
      try {
        source.stop(end);
      } catch (err) {
        /* already stopped */
      }
    }
    source.onended = () => {
      try {
        source.disconnect();
      } catch (err) {
        /* already gone */
      }
      if (chain) {
        for (let i = 0; i < chain.length; i++) {
          try {
            chain[i].disconnect();
          } catch (err) {
            /* already gone */
          }
        }
      }
    };
    return source;
  }

  /**
   * Plays a synthesised one-shot. The factory receives the context, the node it should
   * connect to, the start time and the engine, and returns the sound length in seconds
   * (or `{duration, stop}` when it owns nodes that must be released).
   *
   * @param {(ctx: BaseAudioContext, dest: AudioNode, time: number, engine: AudioEngine) =>
   *   (number|{duration: number, stop?: Function}|void)} nodeFactory Sound builder.
   * @param {object} [opts] Routing options.
   * @param {string} [opts.bus] Bus name (default `'sfx'`).
   * @param {string} [opts.category] Voice pool category (defaults to the bus name).
   * @param {ArrayLike<number>} [opts.pos] World position; when given the sound is spatialised.
   * @param {number} [opts.gain] Voice gain.
   * @param {number} [opts.reverb] Reverb send 0..1.
   * @param {number} [opts.delay] Delay before the sound starts, in seconds.
   * @param {number} [opts.duration] Explicit duration when the factory returns nothing.
   * @param {number} [opts.tail] Extra release time kept after the duration.
   * @param {number} [opts.pan] Stereo pan -1..1 for non-positional sounds.
   * @param {number} [opts.occlusion] Occlusion 0..1 for positional sounds.
   * @param {number} [opts.refDistance] Panner reference distance.
   * @param {number} [opts.maxDistance] Panner max distance.
   * @param {number} [opts.rolloff] Panner rolloff.
   * @returns {{voice: *, output: GainNode, spatial: *, stop: Function,
   *   setPosition: Function, setVolume: Function}|null} A handle, or null when audio is off.
   */
  playSound(nodeFactory, opts) {
    if (!this.enabled || typeof nodeFactory !== 'function') return null;
    const o = opts || EMPTY_OPTS;
    const ctx = this.ctx;
    const busName = this.buses[o.bus] ? o.bus : 'sfx';
    const category = o.category || busName;

    // Build the routing first so the voice can be connected straight to its destination.
    let spatial = null;
    let panner = null;
    let dest = this.buses[busName];
    if (o.pos) {
      spatial = this.createPositional(busName, {
        pos: o.pos,
        gain: 1,
        reverb: Number.isFinite(o.reverb) ? o.reverb : 0,
        refDistance: o.refDistance,
        maxDistance: o.maxDistance,
        rolloff: o.rolloff,
        occlusion: o.occlusion,
      });
      dest = spatial.input;
    } else if (Number.isFinite(o.pan) && typeof ctx.createStereoPanner === 'function') {
      panner = ctx.createStereoPanner();
      panner.pan.value = clampNum(o.pan, -1, 1);
      panner.connect(this.buses[busName]);
      dest = panner;
    }

    const voice = this.allocVoice(category, {
      gain: Number.isFinite(o.gain) ? o.gain : 1,
      dest,
    });
    if (!voice) {
      if (spatial) spatial.stop(0, 0.01);
      if (panner) panner.disconnect();
      return null;
    }
    voice.spatial = spatial;
    if (panner) voice.extras.push(panner);
    if (!spatial && Number.isFinite(o.reverb) && o.reverb > 0) {
      const send = ctx.createGain();
      send.gain.value = clampNum(o.reverb, 0, 4);
      voice.output.connect(send);
      send.connect(this.reverbSend);
      voice.extras.push(send);
    }

    const start = ctx.currentTime + Math.max(0, safeValue(o.delay, 0)) + 0.002;
    let result = null;
    try {
      result = nodeFactory(ctx, voice.output, start, this);
    } catch (err) {
      voice.dispose();
      throw err;
    }
    let duration = safeValue(o.duration, 0.5);
    let stopFn = null;
    if (typeof result === 'number') duration = result;
    else if (result && typeof result === 'object') {
      if (Number.isFinite(result.duration)) duration = result.duration;
      if (typeof result.stop === 'function') stopFn = result.stop;
    }
    voice.onStop = stopFn;
    const tail = Math.max(0, safeValue(o.tail, 0.08));
    voice.scheduleEnd(start + Math.max(0.02, duration) + tail);

    const handle = {
      voice,
      spatial,
      output: voice.output,
      /**
       * Stops the sound early.
       * @param {number} [when] Start of the fade.
       * @param {number} [fade] Fade length.
       * @returns {void}
       */
      stop(when, fade) {
        voice.stop(when, fade);
      },
      /**
       * Moves a positional sound.
       * @param {number|ArrayLike<number>} x X or a position array.
       * @param {number} [y] Y.
       * @param {number} [z] Z.
       * @returns {void}
       */
      setPosition(x, y, z) {
        if (spatial) spatial.setPosition(x, y, z);
      },
      /**
       * Sets the voice level.
       * @param {number} v Gain.
       * @returns {void}
       */
      setVolume(v) {
        const t = ctx.currentTime;
        holdAt(voice.output.gain, t);
        linTo(voice.output.gain, clampNum(v, 0, 8), t + 0.03);
      },
    };
    return handle;
  }

  /**
   * Returns a cached noise buffer. Buffers are stereo and generated once per kind.
   * @param {'white'|'pink'|'brown'} [kind] Noise colour.
   * @param {number} [seconds] Buffer length.
   * @returns {AudioBuffer|null} The buffer, or null when audio is unavailable.
   */
  getNoiseBuffer(kind = 'white', seconds = 3) {
    if (!this._built && !this._build()) return null;
    const dur = clampNum(seconds, 0.1, 10);
    const key = kind + ':' + dur.toFixed(2);
    const cached = this._noise.get(key);
    if (cached) return cached;
    const ctx = this.ctx;
    const sr = ctx.sampleRate || 48000;
    const len = Math.max(128, Math.floor(sr * dur));
    const buf = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      if (kind === 'pink') {
        let b0 = 0;
        let b1 = 0;
        let b2 = 0;
        let b3 = 0;
        let b4 = 0;
        let b5 = 0;
        let b6 = 0;
        for (let i = 0; i < len; i++) {
          const w = Math.random() * 2 - 1;
          b0 = 0.99886 * b0 + w * 0.0555179;
          b1 = 0.99332 * b1 + w * 0.0750759;
          b2 = 0.969 * b2 + w * 0.153852;
          b3 = 0.8665 * b3 + w * 0.3104856;
          b4 = 0.55 * b4 + w * 0.5329522;
          b5 = -0.7616 * b5 - w * 0.016898;
          d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
          b6 = w * 0.115926;
        }
      } else if (kind === 'brown') {
        let last = 0;
        for (let i = 0; i < len; i++) {
          const w = Math.random() * 2 - 1;
          last = (last + 0.02 * w) / 1.02;
          d[i] = last * 3.5;
        }
      } else {
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
    }
    this._noise.set(key, buf);
    return buf;
  }

  /**
   * Creates a looping noise source from the cached buffers.
   * @param {'white'|'pink'|'brown'} [kind] Noise colour.
   * @param {number} [rate] Playback rate.
   * @param {boolean} [loop] Loop flag.
   * @returns {AudioBufferSourceNode|null} The source, or null when audio is unavailable.
   */
  noiseSource(kind = 'white', rate = 1, loop = true) {
    if (!this._built && !this._build()) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = this.getNoiseBuffer(kind);
    src.loop = !!loop;
    src.playbackRate.value = Number.isFinite(rate) ? clampNum(rate, 0.05, 8) : 1;
    return src;
  }

  /**
   * Creates a soft-clipping waveshaper (tanh curve), cached per drive bucket.
   * @param {number} [drive] Drive amount; 1 is gentle, 12 is aggressive.
   * @returns {WaveShaperNode|null} The shaper, or null when audio is unavailable.
   */
  createDistortion(drive = 2) {
    if (!this._built && !this._build()) return null;
    const d = Number.isFinite(drive) ? clampNum(drive, 0.1, 40) : 2;
    const key = Math.round(d * 4);
    let curve = this._curves.get(key);
    if (!curve) {
      const n = 2048;
      curve = new Float32Array(n);
      const k = key / 4;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * k) / Math.tanh(k);
      }
      this._curves.set(key, curve);
    }
    const shaper = this.ctx.createWaveShaper();
    shaper.curve = curve;
    shaper.oversample = '2x';
    return shaper;
  }

  /**
   * Convenience biquad factory.
   * @param {BiquadFilterType} type Filter type.
   * @param {number} freq Cutoff/centre frequency.
   * @param {number} [q] Q factor.
   * @param {number} [gainDb] Peaking/shelf gain in dB.
   * @returns {BiquadFilterNode|null} The filter, or null when audio is unavailable.
   */
  createFilter(type, freq, q = 1, gainDb = 0) {
    if (!this._built && !this._build()) return null;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = clampFreq(freq);
    f.Q.value = Number.isFinite(q) ? clampNum(q, 0.0001, 40) : 1;
    if (Number.isFinite(gainDb) && gainDb !== 0) f.gain.value = clampNum(gainDb, -40, 40);
    return f;
  }

  /**
   * Convenience gain factory.
   * @param {number} [value] Initial gain.
   * @returns {GainNode|null} The gain node, or null when audio is unavailable.
   */
  createGain(value = 1) {
    if (!this._built && !this._build()) return null;
    const g = this.ctx.createGain();
    g.gain.value = Number.isFinite(value) ? clampNum(value, -8, 8) : 1;
    return g;
  }

  /**
   * Convenience oscillator factory (not started).
   * @param {OscillatorType} [type] Waveform.
   * @param {number} [freq] Frequency in Hz.
   * @param {number} [detune] Detune in cents.
   * @returns {OscillatorNode|null} The oscillator, or null when audio is unavailable.
   */
  createOsc(type = 'sine', freq = 440, detune = 0) {
    if (!this._built && !this._build()) return null;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = clampFreq(freq);
    if (Number.isFinite(detune) && detune !== 0) o.detune.value = clampNum(detune, -2400, 2400);
    return o;
  }

  /**
   * Stops every pooled voice at once (used on pause / quit).
   * @returns {void}
   */
  stopAllVoices() {
    this._voices.forEach((list) => {
      for (let i = list.length - 1; i >= 0; i--) list[i].stop(this.now, 0.05);
    });
  }

  /**
   * Closes the AudioContext and drops the graph.
   * @returns {void}
   */
  dispose() {
    this.stopAllVoices();
    if (this._duckTimer) {
      clearTimeout(this._duckTimer);
      this._duckTimer = 0;
    }
    if (this.ctx && typeof this.ctx.close === 'function') {
      try {
        this.ctx.close();
      } catch (err) {
        /* already closed */
      }
    }
    this.ctx = null;
    this.master = null;
    this.buses = {};
    this.busCompressors = {};
    this.reverb = null;
    this.reverbSend = null;
    this.reverbReturn = null;
    this._noise.clear();
    this._curves.clear();
    this._voices.clear();
    this._voiceCount = 0;
    this._built = false;
    this._enabled = false;
  }
}

/** Shared empty options object so callers never allocate one just to read defaults. */
const EMPTY_OPTS = Object.freeze({});

/**
 * Builds a do-nothing positional handle used when there is no audio context.
 * @returns {object} A stub with the same shape as a real positional handle.
 */
function makeDeadPositional() {
  return {
    input: null,
    node: null,
    output: null,
    send: null,
    alive: false,
    setPosition() {},
    setVolume() {},
    setOcclusion() {},
    setReverb() {},
    stop() {},
  };
}
