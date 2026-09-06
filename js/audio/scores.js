/**
 * @file js/audio/scores.js
 * Public-domain classical repertoire for the NEON CITY radio, stored as note data.
 *
 * Note data only: this module imports nothing and has no runtime dependencies. The tables are
 * built once at import time by the small pure helpers below (allowed by the architecture rules
 * for constant tables) so that the transcriptions stay readable and cannot drift out of order.
 *
 * All works are unquestionably public domain (every composer died more than 100 years ago).
 *
 * Timing model: `time` and `dur` are in BEATS as floats. One beat is the tempo unit of the
 * score, i.e. a quarter note for the 4/4 and 2/4 pieces and a dotted quarter for the two 12/8
 * pieces (Moonlight Sonata, Chopin Nocturne) so their triplet subdivision is exactly 1/3 beat.
 * Seconds = beats * 60 / tempo, which is what {@link scoreDurationSeconds} returns.
 */

/* -------------------------------------------------------------------------------------------
 * Internal note-building helpers (not exported: scores.js stays a pure data module).
 * ----------------------------------------------------------------------------------------- */

/** Semitone offset of each natural note name inside an octave. @type {Object<string, number>} */
const SEMITONES = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** Rounds a beat value to microbeat precision so accumulated triplets never drift. */
function q(v) {
  return Math.round(v * 1e6) / 1e6;
}

/**
 * Converts a scientific pitch name to a MIDI note number (C4 = 60).
 * Accepts '#', 's', 'b' accidentals, e.g. 'C#4', 'Eb3', 'F##2', 'Bbb5'.
 * @param {string} name Pitch name.
 * @returns {number} MIDI note number.
 */
function m(name) {
  const letter = name[0].toLowerCase();
  let semi = SEMITONES[letter];
  let i = 1;
  while (i < name.length) {
    const c = name[i];
    if (c === '#' || c === 's') { semi += 1; i++; } else if (c === 'b') { semi -= 1; i++; } else break;
  }
  const octave = parseInt(name.slice(i), 10);
  return semi + (octave + 1) * 12;
}

/**
 * Builds a line of notes from compact tokens, advancing a beat cursor as it goes.
 * Each token is `[pitch, slot, velocity?, hold?]` where `pitch` is a pitch name, an array of
 * pitch names (a chord, polyphonic instruments only) or `null` for a rest, `slot` is the
 * rhythmic slot in beats, and `hold` is the fraction of the slot the note actually sounds
 * (1 = legato, 0.4 = staccato).
 * @param {number} start Beat position of the first token.
 * @param {Array<Array>} tokens Token list.
 * @param {number} [vel=0.7] Default velocity.
 * @param {number} [hold=0.94] Default hold fraction.
 * @returns {Array<Array<number>>} Note tuples `[time, pitch, dur, velocity]`.
 */
function line(start, tokens, vel = 0.7, hold = 0.94) {
  const out = [];
  let t = start;
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    const slot = tk[1];
    const p = tk[0];
    if (p !== null && p !== undefined) {
      const v = tk.length > 2 && tk[2] != null ? tk[2] : vel;
      const h = tk.length > 3 && tk[3] != null ? tk[3] : hold;
      const d = q(slot * h);
      if (Array.isArray(p)) {
        for (let j = 0; j < p.length; j++) out.push([q(t), m(p[j]), d, v]);
      } else {
        out.push([q(t), m(p), d, v]);
      }
    }
    t += slot;
  }
  return out;
}

/**
 * Emits a chord (one entry per pitch) at a single point in time.
 * @param {number} time Beat position.
 * @param {Array<string>} pitches Pitch names.
 * @param {number} dur Duration in beats.
 * @param {number} vel Velocity 0..1.
 * @returns {Array<Array<number>>} Note tuples.
 */
function chord(time, pitches, dur, vel) {
  const out = [];
  for (let i = 0; i < pitches.length; i++) out.push([q(time), m(pitches[i]), q(dur), vel]);
  return out;
}

/**
 * Repeats a figure of pitch names at a constant rhythmic step (arpeggios, ostinati, tremolo).
 * @param {number} start Beat position of the first note.
 * @param {Array<string>} pitches Pitch names cycled in order.
 * @param {number} step Beats between consecutive notes.
 * @param {number} count Total number of notes to emit.
 * @param {number} vel Velocity 0..1.
 * @param {number} [hold=0.96] Fraction of the step the note sounds for.
 * @returns {Array<Array<number>>} Note tuples.
 */
function figure(start, pitches, step, count, vel, hold = 0.96) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push([q(start + i * step), m(pitches[i % pitches.length]), q(step * hold), vel]);
  }
  return out;
}

/**
 * Copies a note list, offset in time and optionally transposed / re-shaded dynamically.
 * @param {Array<Array<number>>} notes Source notes.
 * @param {number} dt Beat offset.
 * @param {number} [semitones=0] Transposition.
 * @param {number} [velMul=1] Velocity multiplier (result is clamped to 0.02..1).
 * @returns {Array<Array<number>>} New note tuples.
 */
function copyAt(notes, dt, semitones = 0, velMul = 1) {
  const out = new Array(notes.length);
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    out[i] = [q(n[0] + dt), n[1] + semitones, n[2], Math.max(0.02, Math.min(1, n[3] * velMul))];
  }
  return out;
}

/**
 * Repeats a block of notes `times` times, each copy shifted by `period` beats.
 * @param {Array<Array<number>>} notes Block to repeat.
 * @param {number} times Number of copies (1 returns a plain copy).
 * @param {number} period Beat length of one copy.
 * @param {number} [semitoneStep=0] Transposition applied cumulatively per copy.
 * @param {number} [velStep=1] Velocity multiplier applied cumulatively per copy.
 * @returns {Array<Array<number>>} New note tuples.
 */
function repeatBlock(notes, times, period, semitoneStep = 0, velStep = 1) {
  let out = [];
  let semi = 0;
  let vel = 1;
  for (let i = 0; i < times; i++) {
    out = out.concat(copyAt(notes, i * period, semi, vel));
    semi += semitoneStep;
    vel *= velStep;
  }
  return out;
}

/**
 * Applies a linear crescendo/diminuendo across a note list based on note time.
 * @param {Array<Array<number>>} notes Notes to shade (modified copies are returned).
 * @param {number} fromBeat Beat where `v0` applies.
 * @param {number} toBeat Beat where `v1` applies.
 * @param {number} v0 Start velocity.
 * @param {number} v1 End velocity.
 * @returns {Array<Array<number>>} New note tuples.
 */
function cresc(notes, fromBeat, toBeat, v0, v1) {
  const span = Math.max(1e-6, toBeat - fromBeat);
  const out = new Array(notes.length);
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const t = Math.max(0, Math.min(1, (n[0] - fromBeat) / span));
    out[i] = [n[0], n[1], n[2], Math.max(0.02, Math.min(1, v0 + (v1 - v0) * t))];
  }
  return out;
}

/**
 * Concatenates note lists, sorts them by time then pitch, and wraps them in a track object.
 * Sorting here guarantees the "notes sorted by time" invariant for every score.
 * @param {string} instrument Instrument name from the architecture instrument list.
 * @param {number} gain Track gain 0..1.
 * @param {number} pan Stereo pan -1..1.
 * @param {...Array<Array<number>>} lists Note lists to merge.
 * @returns {{instrument: string, gain: number, pan: number, notes: Array<Array<number>>}} Track.
 */
function track(instrument, gain, pan, ...lists) {
  let notes = [];
  for (let i = 0; i < lists.length; i++) notes = notes.concat(lists[i]);
  notes.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  return { instrument, gain, pan, notes };
}

/**
 * Expands a per-bar table into evenly spaced notes (one row per bar, cells split the bar evenly).
 * A cell may be a pitch name, an array of pitch names (chord) or null for a rest.
 * @param {number} startBeat Beat of the first bar.
 * @param {number} barLen Bar length in beats.
 * @param {Array<Array<(string|Array<string>|null)>>} table Rows of cells.
 * @param {number} vel Velocity 0..1.
 * @param {number} [hold=0.95] Fraction of the cell the note sounds for.
 * @returns {Array<Array<number>>} Note tuples.
 */
function grid(startBeat, barLen, table, vel, hold = 0.95) {
  const out = [];
  for (let b = 0; b < table.length; b++) {
    const row = table[b];
    const step = barLen / row.length;
    for (let i = 0; i < row.length; i++) {
      const cell = row[i];
      if (cell == null) continue;
      const t = q(startBeat + b * barLen + i * step);
      const d = q(step * hold);
      if (Array.isArray(cell)) {
        for (let j = 0; j < cell.length; j++) out.push([t, m(cell[j]), d, vel]);
      } else {
        out.push([t, m(cell), d, vel]);
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------------------------------
 * 1. J.S. Bach - Air on the G String (Orchestral Suite No. 3 in D, BWV 1068, 2nd movement)
 * D major, 4/4, 32 bars. Violin I carries the long-breathed melody over the famous continuo
 * that leaps in octaves on the tonic before walking down the scale.
 * ----------------------------------------------------------------------------------------- */

const AIR_MELODY = line(0, [
  ['A5', 4, 0.52], // 1  the long opening note
  ['D6', 3, 0.62], ['C#6', 1, 0.58], // 2  rising fourth, the signature gesture
  ['B5', 2, 0.58], ['C#6', 1, 0.6], ['D6', 1, 0.62], // 3
  ['C#6', 2, 0.6], ['B5', 1, 0.56], ['A5', 1, 0.54], // 4
  ['G5', 2, 0.56], ['F#5', 1, 0.54], ['E5', 1, 0.52], // 5
  ['F#5', 2, 0.55], ['E5', 1, 0.53], ['D5', 1, 0.5], // 6
  ['E5', 2, 0.56], ['A5', 1, 0.62], ['G#5', 1, 0.6], // 7
  ['A5', 4, 0.58], // 8  cadence in the dominant
  ['C#6', 2, 0.64], ['B5', 1, 0.6], ['A5', 1, 0.58], // 9
  ['D6', 3, 0.66], ['C#6', 1, 0.62], // 10
  ['B5', 2, 0.6], ['A5', 1, 0.58], ['G5', 1, 0.56], // 11
  ['F#5', 2, 0.56], ['G5', 1, 0.58], ['A5', 1, 0.6], // 12
  ['B5', 2, 0.62], ['A5', 1, 0.6], ['G5', 1, 0.58], // 13
  ['F#5', 2, 0.58], ['E5', 1, 0.55], ['D5', 1, 0.53], // 14
  ['E5', 2, 0.56], ['F#5', 1, 0.58], ['G5', 1, 0.6], // 15
  ['F#5', 3, 0.56], ['E5', 1, 0.54], // 16
  ['G5', 1, 0.6], ['A5', 1, 0.62], ['B5', 2, 0.66], // 17 middle section, warmer
  ['C#6', 2, 0.68], ['B5', 1, 0.64], ['A5', 1, 0.62], // 18
  ['B5', 4, 0.66], // 19 suspension over the bass
  ['A5', 2, 0.62], ['G5', 1, 0.6], ['F#5', 1, 0.58], // 20
  ['G5', 1, 0.6], ['F#5', 1, 0.58], ['E5', 2, 0.56], // 21
  ['A5', 2, 0.64], ['G5', 1, 0.6], ['F#5', 1, 0.58], // 22
  ['E5', 2, 0.58], ['F#5', 1, 0.6], ['G5', 1, 0.62], // 23
  ['F#5', 4, 0.6], // 24
  ['A5', 4, 0.56], // 25 reprise
  ['D6', 3, 0.64], ['C#6', 1, 0.6], // 26
  ['B5', 2, 0.6], ['C#6', 1, 0.62], ['D6', 1, 0.64], // 27
  ['C#6', 2, 0.62], ['B5', 1, 0.58], ['A5', 1, 0.56], // 28
  ['G5', 2, 0.56], ['F#5', 1, 0.54], ['E5', 1, 0.52], // 29
  ['F#5', 2, 0.54], ['E5', 1, 0.52], ['D5', 1, 0.5], // 30
  ['E5', 2, 0.52], ['C#5', 2, 0.5], // 31
  ['D5', 4, 0.46] // 32 final tonic
], 0.6, 0.99);

/** Walking continuo, four quarter notes per bar; bars 1 and 25 keep the octave leaps. */
const AIR_BASS_TABLE = [
  ['D2', 'D3', 'D2', 'D3'], ['D2', 'D3', 'C#3', 'A2'], ['B2', 'B3', 'G2', 'G3'], ['A2', 'A3', 'E3', 'A2'],
  ['G2', 'G3', 'F#2', 'F#3'], ['E2', 'E3', 'A2', 'A3'], ['A2', 'C#3', 'E3', 'G3'], ['A2', 'A3', 'A2', 'A3'],
  ['A2', 'A3', 'A2', 'A3'], ['D3', 'D2', 'F#2', 'A2'], ['G2', 'G3', 'E3', 'E2'], ['D2', 'D3', 'A2', 'A3'],
  ['G2', 'G3', 'D3', 'D2'], ['A2', 'A3', 'D3', 'D2'], ['C#3', 'C#2', 'B2', 'B3'], ['A2', 'E3', 'A2', 'A3'],
  ['E2', 'E3', 'G2', 'G3'], ['A2', 'A3', 'F#2', 'F#3'], ['B2', 'B3', 'B2', 'B3'], ['E2', 'E3', 'A2', 'A3'],
  ['D2', 'D3', 'G2', 'G3'], ['F#2', 'F#3', 'B2', 'B3'], ['E2', 'E3', 'A2', 'A3'], ['D2', 'D3', 'A2', 'A3'],
  ['D2', 'D3', 'D2', 'D3'], ['D2', 'D3', 'C#3', 'A2'], ['B2', 'B3', 'G2', 'G3'], ['A2', 'A3', 'E3', 'A2'],
  ['G2', 'G3', 'F#2', 'F#3'], ['E2', 'E3', 'A2', 'A3'], ['A2', 'A3', 'A2', 'G3'], ['D2', 'D3', 'D2', 'D3']
];

/** Second violin, two half notes per bar. */
const AIR_VOICE2_TABLE = [
  ['A4', 'A4'], ['A4', 'A4'], ['F#4', 'B4'], ['A4', 'A4'], ['B4', 'A4'], ['G4', 'A4'], ['A4', 'A4'], ['A4', 'A4'],
  ['A4', 'A4'], ['A4', 'A4'], ['B4', 'B4'], ['A4', 'A4'], ['B4', 'B4'], ['A4', 'A4'], ['A4', 'B4'], ['A4', 'A4'],
  ['B4', 'B4'], ['A4', 'A4'], ['B4', 'B4'], ['A4', 'A4'], ['G4', 'G4'], ['A4', 'A4'], ['G4', 'G4'], ['A4', 'A4'],
  ['A4', 'A4'], ['A4', 'A4'], ['F#4', 'B4'], ['A4', 'A4'], ['B4', 'A4'], ['G4', 'A4'], ['A4', 'A4'], ['A4', 'A4']
];

/** Viola, two half notes per bar. */
const AIR_VIOLA_TABLE = [
  ['F#4', 'F#4'], ['F#4', 'E4'], ['D4', 'D4'], ['E4', 'E4'], ['G4', 'F#4'], ['E4', 'E4'], ['E4', 'G4'], ['E4', 'E4'],
  ['E4', 'E4'], ['F#4', 'F#4'], ['G4', 'G4'], ['F#4', 'F#4'], ['G4', 'G4'], ['F#4', 'F#4'], ['E4', 'D4'], ['E4', 'C#4'],
  ['G4', 'G4'], ['F#4', 'F#4'], ['F#4', 'F#4'], ['F#4', 'D4'], ['E4', 'E4'], ['F#4', 'D4'], ['E4', 'C#4'], ['D4', 'D4'],
  ['F#4', 'F#4'], ['F#4', 'E4'], ['D4', 'D4'], ['E4', 'E4'], ['G4', 'F#4'], ['E4', 'E4'], ['E4', 'G4'], ['F#4', 'D4']
];

/** Cello, a singing tenor line in half notes an octave above the continuo. */
const AIR_CELLO_TABLE = [
  ['D3', 'F#3'], ['D3', 'A3'], ['B3', 'G3'], ['A3', 'C#4'], ['B3', 'A3'], ['G3', 'A3'], ['C#4', 'E4'], ['A3', 'C#4'],
  ['C#4', 'A3'], ['D4', 'A3'], ['B3', 'G3'], ['A3', 'F#3'], ['B3', 'G3'], ['A3', 'F#3'], ['A3', 'G3'], ['A3', 'E3'],
  ['E3', 'B3'], ['A3', 'D4'], ['D4', 'B3'], ['A3', 'C#4'], ['B3', 'G3'], ['A3', 'F#3'], ['B3', 'A3'], ['A3', 'F#3'],
  ['D3', 'F#3'], ['D3', 'A3'], ['B3', 'G3'], ['A3', 'C#4'], ['B3', 'A3'], ['G3', 'A3'], ['C#4', 'E4'], ['A3', 'F#3']
];

/** @type {Object} Air on the G String. */
const bach_air = {
  id: 'bach_air',
  title: 'Air on the G String',
  titleKo: 'G선상의 아리아',
  composer: 'J.S. Bach',
  year: 1731,
  tempo: 62,
  timeSig: [4, 4],
  key: 'D major',
  swing: 0,
  reverb: 0.52,
  station: 'baroque',
  loop: true,
  lengthBeats: 128,
  sections: [{ name: 'A', startBeat: 0 }, { name: 'A2', startBeat: 32 }, { name: 'B', startBeat: 64 },
    { name: 'A3', startBeat: 96 }],
  tracks: [
    track('violin', 0.9, -0.18, AIR_MELODY),
    track('strings', 0.42, 0.22, grid(0, 4, AIR_VOICE2_TABLE, 0.34, 0.99)),
    track('strings', 0.36, 0.4, grid(0, 4, AIR_VIOLA_TABLE, 0.3, 0.99)),
    track('cello', 0.55, -0.35, grid(0, 4, AIR_CELLO_TABLE, 0.4, 0.97)),
    track('bass', 0.6, 0.05, grid(0, 4, AIR_BASS_TABLE, 0.44, 0.86))
  ]
};

/* -------------------------------------------------------------------------------------------
 * 2. J.S. Bach - Prelude No. 1 in C major (Well-Tempered Clavier I, BWV 846)
 * The whole piece is one figuration: per half bar the five chord tones are played as
 * 1 2 3 4 5 3 4 5 in semiquavers, the lower two held. Each row below is one bar's chord.
 * ----------------------------------------------------------------------------------------- */

/** @type {Array<Array<string>>} Five voiced chord tones per bar, low to high. */
const PRELUDE_CHORDS = [
  ['C3', 'E3', 'G3', 'C4', 'E4'], // 1  C
  ['C3', 'D3', 'A3', 'D4', 'F4'], // 2  Dm7/C
  ['B2', 'D3', 'G3', 'D4', 'F4'], // 3  G7/B
  ['C3', 'E3', 'G3', 'C4', 'E4'], // 4  C
  ['C3', 'E3', 'A3', 'E4', 'A4'], // 5  Am/C
  ['C3', 'D3', 'F#3', 'A3', 'D4'], // 6  D7/C
  ['B2', 'D3', 'G3', 'D4', 'G4'], // 7  G
  ['B2', 'C3', 'E3', 'G3', 'C4'], // 8  C/B
  ['A2', 'C3', 'E3', 'G3', 'C4'], // 9  Am7
  ['D2', 'A2', 'D3', 'F#3', 'C4'], // 10 D7
  ['G2', 'B2', 'D3', 'G3', 'B3'], // 11 G
  ['G2', 'Bb2', 'E3', 'G3', 'C#4'], // 12 A7/G
  ['F2', 'A2', 'D3', 'A3', 'D4'], // 13 Dm/F
  ['F2', 'Ab2', 'D3', 'F3', 'B3'], // 14 B dim7/F
  ['E2', 'G2', 'C3', 'G3', 'C4'], // 15 C/E
  ['E2', 'F2', 'A2', 'C3', 'F3'], // 16 F/E
  ['D2', 'F2', 'A2', 'C3', 'F3'], // 17 Dm7
  ['G2', 'D3', 'G3', 'B3', 'F4'], // 18 G7
  ['C2', 'E3', 'G3', 'C4', 'E4'], // 19 C
  ['C2', 'E3', 'G3', 'C4', 'E4'], // 20 C
  ['C2', 'D3', 'F#3', 'A3', 'C4'], // 21 D7/C
  ['G2', 'B2', 'D3', 'G3', 'B3'], // 22 dominant pedal begins
  ['G2', 'C3', 'E3', 'G3', 'C4'], // 23 C/G
  ['G2', 'B2', 'D3', 'G3', 'B3'], // 24 G
  ['G2', 'A2', 'C3', 'F#3', 'A3'], // 25 D7/G
  ['G2', 'B2', 'D3', 'F3', 'A3'], // 26 G9
  ['G2', 'C3', 'E3', 'G3', 'C4'], // 27 C/G
  ['G2', 'B2', 'D3', 'F3', 'B3'], // 28 G7
  ['G2', 'B2', 'F3', 'G3', 'D4'], // 29 G7 wide
  ['C2', 'E3', 'G3', 'C4', 'E4'], // 30 tonic pedal
  ['C2', 'D3', 'F3', 'Ab3', 'B3'], // 31 B dim7/C
  ['C2', 'E3', 'G3', 'C4', 'E4'], // 32 C
  ['C2', 'D3', 'F3', 'G3', 'B3'], // 33 G7/C
  ['C2', 'E3', 'G3', 'C4', 'E4'] // 34 C
];

/**
 * Builds the BWV 846 semiquaver figuration and its two sustained lower voices.
 * @param {Array<Array<string>>} chords Bar chords, five voiced tones each.
 * @returns {{fig: Array<Array<number>>, low: Array<Array<number>>, ped: Array<Array<number>>}} Voices.
 */
function buildPrelude(chords) {
  const fig = [];
  const low = [];
  const ped = [];
  for (let bar = 0; bar < chords.length; bar++) {
    const c = chords[bar];
    // Gentle terraced dynamics: opening calm, dominant pedal firmer, close softening again.
    let vel = 0.44;
    if (bar >= 9 && bar < 18) vel = 0.5;
    if (bar >= 21 && bar < 29) vel = 0.58;
    if (bar >= 29) vel = 0.5 - (bar - 29) * 0.025;
    const base = bar * 4;
    ped.push([q(base), m(c[0]) - 12, 3.85, vel * 0.5]);
    for (let half = 0; half < 2; half++) {
      const t = base + half * 2;
      low.push([q(t), m(c[0]), 1.9, vel * 0.92]);
      low.push([q(t + 0.25), m(c[1]), 1.65, vel * 0.8]);
      const order = [2, 3, 4, 2, 3, 4];
      for (let i = 0; i < 6; i++) {
        const accent = i === 0 ? 1.08 : (i === 3 ? 0.94 : 1);
        fig.push([q(t + 0.5 + i * 0.25), m(c[order[i]]), 0.46, Math.min(1, vel * accent)]);
      }
    }
  }
  // Final bar: the whole chord rolled and held.
  const end = chords.length * 4;
  low.push([q(end), m('C2'), 5.6, 0.5], [q(end + 0.06), m('C3'), 5.5, 0.44]);
  fig.push([q(end + 0.12), m('E3'), 5.4, 0.4], [q(end + 0.18), m('G3'), 5.35, 0.4],
    [q(end + 0.24), m('C4'), 5.3, 0.42], [q(end + 0.3), m('E4'), 5.2, 0.44]);
  ped.push([q(end), m('C1'), 5.6, 0.3]);
  return { fig, low, ped };
}

const PRELUDE = buildPrelude(PRELUDE_CHORDS);

/** @type {Object} Prelude No. 1 in C major. */
const bach_prelude_c = {
  id: 'bach_prelude_c',
  title: 'Prelude No. 1 in C major',
  titleKo: '평균율 1번 프렐류드 C장조',
  composer: 'J.S. Bach',
  year: 1722,
  tempo: 72,
  timeSig: [4, 4],
  key: 'C major',
  swing: 0,
  reverb: 0.4,
  station: 'baroque',
  loop: true,
  lengthBeats: 142,
  sections: [{ name: 'opening', startBeat: 0 }, { name: 'sequence', startBeat: 36 },
    { name: 'dominant pedal', startBeat: 84 }, { name: 'close', startBeat: 116 }],
  tracks: [
    track('piano', 0.82, -0.12, PRELUDE.fig),
    track('piano', 0.76, 0.12, PRELUDE.low),
    track('harpsichord', 0.18, 0.4, PRELUDE.fig),
    track('bass', 0.24, -0.35, PRELUDE.ped)
  ]
};

/* -------------------------------------------------------------------------------------------
 * 3. J.S. Bach - Toccata and Fugue in D minor, BWV 565 (opening toccata + fugue subject)
 * Three mordent flourishes an octave apart, the great chord, the toccata figuration, the
 * diminished-seventh sweep, the cadential chords, then the fugue subject as a coda.
 * ----------------------------------------------------------------------------------------- */

/**
 * One BWV 565 opening flourish: mordent on the fifth, held, then the descending scale to the
 * tonic. Written at pitch for the given octave suffix.
 * @param {number} start Beat position.
 * @param {number} oct Octave of the starting A.
 * @param {number} vel Velocity 0..1.
 * @returns {Array<Array<number>>} Note tuples (exactly four beats long).
 */
function toccataFlourish(start, oct, vel) {
  return line(start, [
    ['A' + oct, 0.125, vel], ['G' + oct, 0.125, vel * 0.92], ['A' + oct, 1.25, vel, 0.92],
    [null, 0.125],
    ['G' + oct, 0.125, vel * 0.9], ['F' + oct, 0.125, vel * 0.9], ['E' + oct, 0.125, vel * 0.92],
    ['D' + oct, 0.125, vel * 0.94], ['C#' + oct, 0.125, vel * 0.96],
    ['D' + oct, 1.5, vel, 0.9], [null, 0.25]
  ], vel, 0.95);
}

/** Right-hand toccata figuration: four broken-chord semiquavers repeated across a bar. */
function toccataBar(bar, pitches, vel) {
  return figure(bar * 4, pitches, 0.25, 16, vel, 0.9);
}

const TOCCATA_RH = [].concat(
  toccataFlourish(0, 5, 0.95),
  toccataFlourish(4, 4, 0.8),
  // bar 3 belongs to the pedal alone
  chord(12, ['D4', 'F4', 'A4', 'D5'], 3.8, 0.92),
  toccataBar(4, ['A5', 'F5', 'D5', 'F5'], 0.62),
  toccataBar(5, ['G5', 'E5', 'C5', 'E5'], 0.6),
  toccataBar(6, ['F5', 'D5', 'Bb4', 'D5'], 0.62),
  toccataBar(7, ['E5', 'C#5', 'A4', 'C#5'], 0.66),
  toccataBar(8, ['Bb5', 'G5', 'D5', 'G5'], 0.68),
  toccataBar(9, ['C#6', 'A5', 'E5', 'A5'], 0.72),
  toccataBar(10, ['D6', 'A5', 'F5', 'A5'], 0.76),
  figure(44, ['C#6', 'A5', 'G5', 'E5'], 0.25, 8, 0.8, 0.9),
  figure(46, ['Bb5', 'G5', 'E5', 'C#5'], 0.25, 8, 0.84, 0.9),
  // diminished-seventh sweep down two octaves and back up
  figure(48, ['Bb5', 'G5', 'E5', 'C#5', 'Bb4', 'G4', 'E4', 'C#4'], 0.25, 16, 0.86, 0.9),
  figure(52, ['C#4', 'E4', 'G4', 'Bb4', 'C#5', 'E5', 'G5', 'Bb5'], 0.25, 12, 0.9, 0.9),
  chord(55, ['C#5', 'E5', 'G5', 'Bb5'], 1, 0.95),
  // cadential chords
  chord(56, ['Bb4', 'D5', 'G5'], 1.4, 0.9), chord(57.5, ['A4', 'C#5', 'G5'], 1.4, 0.92),
  chord(59, ['D5', 'F5', 'A5'], 0.9, 0.94), chord(60, ['C#5', 'E5', 'A5'], 1.8, 0.9),
  chord(62, ['D5', 'F5', 'A5', 'D6'], 2, 0.98)
);

/** The fugue subject in semiquavers, alternating the pedal tone A with a descending line. */
const TOCCATA_FUGUE = [].concat(
  line(64, [
    ['A4', 0.25, 0.8], ['G4', 0.25, 0.74], ['A4', 0.5, 0.82], [null, 0.25],
    ['E4', 0.25, 0.72], ['A4', 0.25, 0.66], ['F4', 0.25, 0.74], ['A4', 0.25, 0.66],
    ['D4', 0.25, 0.76], ['A4', 0.25, 0.66], ['C#4', 0.25, 0.78], ['A4', 0.25, 0.66],
    ['D4', 0.25, 0.8], ['E4', 0.25, 0.72], ['F4', 0.25, 0.74], ['E4', 0.25, 0.7],
    ['D4', 0.25, 0.76], ['C#4', 0.25, 0.72], ['D4', 0.5, 0.8], [null, 0.25],
    ['F4', 0.25, 0.72], ['E4', 0.25, 0.7], ['F4', 0.25, 0.74], ['G4', 0.25, 0.72],
    ['A4', 0.25, 0.8], ['G4', 0.25, 0.72], ['F4', 0.25, 0.74], ['E4', 0.25, 0.72],
    ['D4', 0.5, 0.78], ['C#4', 0.5, 0.76], ['D4', 1, 0.84]
  ], 0.75, 0.92),
  // answer, a fifth higher, with the same shape
  line(72, [
    ['E5', 0.25, 0.82], ['D5', 0.25, 0.76], ['E5', 0.5, 0.84], [null, 0.25],
    ['B4', 0.25, 0.74], ['E5', 0.25, 0.68], ['C5', 0.25, 0.76], ['E5', 0.25, 0.68],
    ['A4', 0.25, 0.78], ['E5', 0.25, 0.68], ['G#4', 0.25, 0.8], ['E5', 0.25, 0.68],
    ['A4', 0.25, 0.82], ['B4', 0.25, 0.74], ['C5', 0.25, 0.76], ['B4', 0.25, 0.72],
    ['A4', 0.25, 0.78], ['G#4', 0.25, 0.74], ['A4', 0.5, 0.82], [null, 0.25],
    ['C5', 0.25, 0.74], ['B4', 0.25, 0.72], ['C5', 0.25, 0.76], ['D5', 0.25, 0.74],
    ['E5', 0.25, 0.84], ['D5', 0.25, 0.76], ['C5', 0.25, 0.78], ['B4', 0.25, 0.74],
    ['A4', 0.5, 0.82], ['G#4', 0.5, 0.8], ['A4', 1, 0.88]
  ], 0.78, 0.92)
);

const TOCCATA_CODA = [].concat(
  toccataFlourish(80, 5, 1),
  toccataFlourish(84, 4, 0.86),
  toccataBar(22, ['D6', 'A5', 'F5', 'A5'], 0.8),
  toccataBar(23, ['C#6', 'A5', 'G5', 'E5'], 0.84),
  figure(96, ['Bb5', 'G5', 'E5', 'C#5', 'Bb4', 'G4', 'E4', 'C#4'], 0.25, 16, 0.88, 0.9),
  chord(100, ['C#5', 'E5', 'G5', 'Bb5'], 2, 0.94),
  chord(102, ['D5', 'F5', 'A5'], 2, 0.9),
  chord(104, ['G4', 'Bb4', 'E5'], 1.5, 0.9), chord(105.5, ['A4', 'C#5', 'E5'], 1.5, 0.92),
  chord(107, ['D4', 'F4', 'A4', 'D5'], 1, 0.96),
  chord(108, ['C#5', 'E5', 'A5'], 2, 0.9), chord(110, ['D5', 'F5', 'A5', 'D6'], 2, 1),
  chord(112, ['D4', 'F4', 'A4', 'D5'], 8, 0.86),
  // one last flourish, then the final chord of the toccata
  toccataFlourish(120, 5, 0.92),
  chord(124, ['D4', 'F4', 'A4', 'D5'], 4, 0.98)
);

const TOCCATA_LH = [].concat(
  chord(12, ['D3', 'A3'], 3.8, 0.8),
  grid(16, 4, [['D3', 'D3'], ['C3', 'C3'], ['Bb2', 'Bb2'], ['A2', 'A2'], ['G3', 'G3'], ['A3', 'A3'],
    ['D3', 'D3'], ['A2', 'A2']], 0.5, 0.95),
  chord(48, ['E3', 'G3'], 3.8, 0.62), chord(52, ['C#3', 'G3'], 2.8, 0.66),
  chord(56, ['G3', 'Bb3'], 1.4, 0.7), chord(57.5, ['E3', 'G3'], 1.4, 0.72),
  chord(59, ['D3', 'F3'], 0.9, 0.74), chord(60, ['E3', 'A3'], 1.8, 0.72),
  chord(62, ['D3', 'A3'], 2, 0.78),
  grid(64, 4, [['D3', 'A3'], ['D3', 'F3'], ['E3', 'A3'], ['A2', 'A3'],
    ['A3', 'E3'], ['A3', 'C4'], ['B3', 'E3'], ['E3', 'A3']], 0.42, 0.9),
  chord(96, ['C#3', 'G3'], 3.8, 0.72),
  chord(100, ['E3', 'G3'], 2, 0.76), chord(102, ['D3', 'A3'], 2, 0.74),
  chord(104, ['G3', 'Bb3'], 1.5, 0.76), chord(105.5, ['E3', 'A3'], 1.5, 0.78),
  chord(107, ['D3', 'F3'], 1, 0.82), chord(108, ['E3', 'A3'], 2, 0.78),
  chord(110, ['D3', 'A3'], 2, 0.86), chord(112, ['D3', 'A3', 'D4'], 8, 0.76),
  chord(124, ['D3', 'A3', 'D4'], 4, 0.86)
);

const TOCCATA_PEDAL = [].concat(
  toccataFlourish(8, 2, 0.85),
  line(12, [['D2', 4, 0.95, 0.95]]),
  grid(16, 4, [['D2'], ['C2'], ['Bb1'], ['A1'], ['G1'], ['A1'], ['D2'], ['A1']], 0.72, 0.97),
  line(48, [['Bb1', 4, 0.8, 0.97], ['A1', 4, 0.82, 0.97], ['G1', 3, 0.8, 0.96], ['A1', 1, 0.82],
    ['D2', 2, 0.86, 0.95], ['A1', 2, 0.84, 0.95]]),
  line(64, [['D2', 4, 0.6, 0.97], ['D2', 4, 0.58, 0.97], ['A1', 4, 0.6, 0.97], ['A1', 4, 0.58, 0.97],
    ['A1', 4, 0.6, 0.97], ['A1', 4, 0.58, 0.97], ['E2', 4, 0.62, 0.97], ['A1', 4, 0.6, 0.97]]),
  line(96, [['C#2', 4, 0.86, 0.97], ['A1', 2, 0.84, 0.95], ['D2', 2, 0.88, 0.95],
    ['G1', 1.5, 0.86], ['A1', 1.5, 0.88], ['D2', 1, 0.92],
    ['A1', 2, 0.88, 0.95], ['D2', 2, 0.94, 0.95], ['D1', 8, 0.9, 0.98],
    ['A1', 4, 0.86, 0.95], ['D1', 4, 0.96, 0.98]])
);

/** @type {Object} Toccata and Fugue in D minor. */
const bach_toccata = {
  id: 'bach_toccata',
  title: 'Toccata and Fugue in D minor',
  titleKo: '토카타와 푸가 D단조',
  composer: 'J.S. Bach',
  year: 1704,
  tempo: 80,
  timeSig: [4, 4],
  key: 'D minor',
  swing: 0,
  reverb: 0.72,
  station: 'action',
  loop: true,
  lengthBeats: 128,
  sections: [{ name: 'flourishes', startBeat: 0 }, { name: 'toccata', startBeat: 16 },
    { name: 'diminished sweep', startBeat: 48 }, { name: 'fugue subject', startBeat: 64 },
    { name: 'coda', startBeat: 80 }, { name: 'final cadence', startBeat: 120 }],
  tracks: [
    track('organ', 0.9, -0.1, TOCCATA_RH, TOCCATA_FUGUE, TOCCATA_CODA),
    track('organ', 0.55, 0.18, TOCCATA_LH),
    track('organ', 0.7, 0, TOCCATA_PEDAL)
  ]
};

/* -------------------------------------------------------------------------------------------
 * 4. Beethoven - Piano Sonata No. 14 "Moonlight", Op. 27 No. 2, 1st movement
 * Notated here in 12/8 read as four dotted-quarter beats per bar, so the endless triplet
 * arpeggios fall exactly on thirds of a beat. Melody enters in bar 5 with the dotted figure.
 * ----------------------------------------------------------------------------------------- */

/**
 * @type {Array<Array>} One row per bar: [arpeggio for the first half, arpeggio for the second
 * half, bass note of the first half, bass note of the second half]. The bass is doubled an
 * octave above, exactly as Beethoven writes it.
 */
const MOON_BARS = [
  [['G#3', 'C#4', 'E4'], ['G#3', 'C#4', 'E4'], 'C#2', 'C#2'], // 1
  [['G#3', 'C#4', 'E4'], ['G#3', 'C#4', 'E4'], 'C#2', 'C#2'], // 2
  [['A3', 'D4', 'F#4'], ['G#3', 'B3', 'E4'], 'A1', 'B1'], // 3
  [['G#3', 'C#4', 'E4'], ['F#3', 'B#3', 'D#4'], 'C#2', 'B#1'], // 4
  [['G#3', 'C#4', 'E4'], ['G#3', 'C#4', 'E4'], 'C#2', 'C#2'], // 5  melody enters
  [['G#3', 'C#4', 'E4'], ['G#3', 'C#4', 'E4'], 'C#2', 'C#2'], // 6
  [['A3', 'D4', 'F#4'], ['G#3', 'B3', 'E4'], 'A1', 'B1'], // 7
  [['G#3', 'C#4', 'E4'], ['F#3', 'B#3', 'D#4'], 'C#2', 'B#1'], // 8
  [['G#3', 'C#4', 'E4'], ['G#3', 'C#4', 'E4'], 'C#2', 'C#2'], // 9
  [['A3', 'C#4', 'E4'], ['A3', 'C#4', 'E4'], 'A1', 'A1'], // 10
  [['G#3', 'B3', 'E4'], ['G#3', 'B3', 'E4'], 'E1', 'E1'], // 11
  [['F#3', 'A3', 'D#4'], ['F#3', 'A3', 'D#4'], 'B1', 'B1'], // 12
  [['G#3', 'B3', 'E4'], ['G#3', 'B3', 'E4'], 'E1', 'E1'], // 13
  [['F#3', 'B3', 'D#4'], ['F#3', 'B3', 'D#4'], 'B1', 'B1'], // 14
  [['G#3', 'B3', 'E4'], ['G#3', 'B3', 'E4'], 'E1', 'E1'], // 15 E major episode
  [['G#3', 'B3', 'E4'], ['G#3', 'B3', 'E4'], 'E1', 'E1'], // 16
  [['A3', 'C#4', 'E4'], ['A3', 'C#4', 'E4'], 'A1', 'A1'], // 17
  [['G#3', 'B3', 'E4'], ['G#3', 'B3', 'E4'], 'E1', 'E1'], // 18
  [['F#3', 'A#3', 'C#4'], ['F#3', 'A#3', 'C#4'], 'F#1', 'F#1'], // 19
  [['F#3', 'B3', 'D#4'], ['F#3', 'B3', 'D#4'], 'B1', 'B1'], // 20
  [['G#3', 'B3', 'E4'], ['G#3', 'B3', 'E4'], 'E1', 'E1'], // 21
  [['F#3', 'B3', 'D#4'], ['F#3', 'B3', 'D#4'], 'B1', 'B1'], // 22
  [['G#3', 'C#4', 'E4'], ['G#3', 'C#4', 'E4'], 'C#2', 'C#2'], // 23 return
  [['G#3', 'C#4', 'E4'], ['G#3', 'C#4', 'E4'], 'C#2', 'C#2'], // 24
  [['A3', 'D4', 'F#4'], ['G#3', 'B3', 'E4'], 'A1', 'B1'], // 25
  [['G#3', 'C#4', 'E4'], ['F#3', 'B#3', 'D#4'], 'C#2', 'B#1'], // 26
  [['G#3', 'C#4', 'E4'], ['G#3', 'C#4', 'E4'], 'C#2', 'C#2'], // 27
  [['G#3', 'C#4', 'E4'], ['G#3', 'C#4', 'E4'], 'C#2', 'C#2'], // 28
  [['F#3', 'A3', 'C#4'], ['F#3', 'A3', 'C#4'], 'F#1', 'F#1'], // 29
  [['G#3', 'B#3', 'D#4'], ['G#3', 'B#3', 'D#4'], 'G#1', 'G#1'], // 30
  [['G#3', 'C#4', 'E4'], ['G#3', 'C#4', 'E4'], 'C#2', 'C#2'], // 31
  [['G#3', 'C#4', 'E4'], ['G#3', 'C#4', 'E4'], 'C#2', 'C#2'], // 32
  [['A3', 'C#4', 'E4'], ['A3', 'C#4', 'E4'], 'A1', 'A1'], // 33 coda
  [['G#3', 'C#4', 'E4'], ['G#3', 'C#4', 'E4'], 'C#2', 'C#2'], // 34
  [['F#3', 'B#3', 'D#4'], ['F#3', 'B#3', 'D#4'], 'G#1', 'G#1'], // 35
  [['G#3', 'C#4', 'E4'], ['G#3', 'C#4', 'E4'], 'C#2', 'C#2'], // 36
  [['G#3', 'C#4', 'E4'], ['G#3', 'C#4', 'E4'], 'C#2', 'C#2'], // 37
  [['F#3', 'B#3', 'D#4'], ['F#3', 'B#3', 'D#4'], 'G#1', 'G#1'], // 38
  [['G#3', 'C#4', 'E4'], ['G#3', 'C#4', 'E4'], 'C#2', 'C#2'], // 39
  [['G#3', 'C#4', 'E4'], ['G#3', 'C#4', 'E4'], 'C#2', 'C#2'] // 40
];

/**
 * Expands the Moonlight bar table into the triplet arpeggio voice and the octave bass.
 * @param {Array<Array>} bars Bar table.
 * @returns {{arp: Array<Array<number>>, bass: Array<Array<number>>}} Voices.
 */
function buildMoonlight(bars) {
  const arp = [];
  const bass = [];
  for (let b = 0; b < bars.length; b++) {
    const row = bars[b];
    const base = b * 4;
    let v = 0.3;
    if (b < 4) v = 0.26 + b * 0.012; // the four bars of introduction stay very quiet
    else if (b < 14) v = 0.3;
    else if (b < 23) v = 0.35; // E major episode opens out
    else if (b < 32) v = 0.32;
    else v = Math.max(0.16, 0.3 - (b - 32) * 0.018); // dying away
    for (let half = 0; half < 2; half++) {
      const set = row[half];
      const t0 = base + half * 2;
      for (let i = 0; i < 6; i++) {
        const accent = i === 0 ? 1.15 : 1;
        arp.push([q(t0 + i / 3), m(set[i % 3]), 0.33, Math.min(1, v * accent)]);
      }
      const bn = m(row[2 + half]);
      const bv = Math.min(1, v * 1.35);
      bass.push([q(t0), bn, 1.92, bv], [q(t0), bn + 12, 1.92, bv * 0.85]);
    }
  }
  return { arp, bass };
}

const MOON = buildMoonlight(MOON_BARS);

/** Dotted melody: long - short - long in every bar, exactly as the sonata notates it. */
const MOON_MELODY = line(16, [
  ['G#4', 1.5, 0.5], ['G#4', 0.5, 0.44], ['G#4', 2, 0.52], // 5
  ['G#4', 1.5, 0.5], ['G#4', 0.5, 0.44], ['G#4', 2, 0.52], // 6
  ['A4', 1.5, 0.55], ['A4', 0.5, 0.48], ['A4', 2, 0.56], // 7
  ['G#4', 1.5, 0.52], ['G#4', 0.5, 0.46], ['F#4', 2, 0.5], // 8
  ['G#4', 1.5, 0.5], ['G#4', 0.5, 0.44], ['G#4', 2, 0.5], // 9
  ['A4', 1.5, 0.54], ['A4', 0.5, 0.48], ['A4', 2, 0.55], // 10
  ['G#4', 1.5, 0.52], ['G#4', 0.5, 0.46], ['B4', 2, 0.58], // 11
  ['A#4', 2, 0.56], ['B4', 2, 0.58], // 12
  ['B4', 1.5, 0.56], ['B4', 0.5, 0.5], ['B4', 2, 0.58], // 13
  ['B4', 1.5, 0.56], ['A#4', 0.5, 0.5], ['B4', 2, 0.58], // 14
  ['B4', 1.5, 0.58], ['B4', 0.5, 0.5], ['B4', 2, 0.6], // 15
  ['E5', 1.5, 0.64], ['D#5', 0.5, 0.56], ['B4', 2, 0.58], // 16
  ['C#5', 1.5, 0.62], ['C#5', 0.5, 0.54], ['C#5', 2, 0.62], // 17
  ['B4', 1.5, 0.58], ['B4', 0.5, 0.52], ['G#4', 2, 0.54], // 18
  ['A#4', 1.5, 0.58], ['A#4', 0.5, 0.52], ['C#5', 2, 0.62], // 19
  ['B4', 1.5, 0.6], ['B4', 0.5, 0.52], ['D#5', 2, 0.64], // 20
  ['E5', 1.5, 0.66], ['E5', 0.5, 0.56], ['B4', 2, 0.56], // 21
  ['D#5', 2, 0.6], ['B4', 2, 0.54], // 22
  ['G#4', 1.5, 0.52], ['G#4', 0.5, 0.46], ['G#4', 2, 0.52], // 23
  ['G#4', 1.5, 0.52], ['G#4', 0.5, 0.46], ['G#4', 2, 0.52], // 24
  ['A4', 1.5, 0.56], ['A4', 0.5, 0.48], ['G#4', 2, 0.54], // 25
  ['G#4', 1.5, 0.52], ['G#4', 0.5, 0.46], ['F#4', 2, 0.5], // 26
  ['E4', 2, 0.48], ['G#4', 2, 0.52], // 27
  ['C#5', 1.5, 0.6], ['B#4', 0.5, 0.54], ['C#5', 2, 0.62], // 28
  ['C#5', 1.5, 0.58], ['C#5', 0.5, 0.5], ['A4', 2, 0.54], // 29
  ['B#4', 1.5, 0.56], ['B#4', 0.5, 0.5], ['D#5', 2, 0.6], // 30
  ['C#5', 4, 0.56], // 31
  ['G#4', 4, 0.48], // 32
  ['A4', 2, 0.44], ['C#5', 2, 0.46], // 33
  ['G#4', 4, 0.42], // 34
  ['F#4', 2, 0.4], ['D#4', 2, 0.38], // 35
  ['E4', 4, 0.36], // 36
  ['G#4', 2, 0.34], ['E4', 2, 0.32], // 37
  ['D#4', 2, 0.3], ['F#4', 2, 0.3], // 38
  ['C#4', 4, 0.28], // 39
  ['C#4', 4, 0.24] // 40
], 0.5, 0.96);

/** @type {Object} Moonlight Sonata, first movement. */
const beethoven_moonlight = {
  id: 'beethoven_moonlight',
  title: 'Moonlight Sonata, Op. 27 No. 2 - I',
  titleKo: '월광 소나타 1악장',
  composer: 'L. van Beethoven',
  year: 1801,
  tempo: 54,
  timeSig: [12, 8],
  key: 'C# minor',
  swing: 0,
  reverb: 0.6,
  station: 'classic',
  loop: true,
  lengthBeats: 160,
  sections: [{ name: 'intro', startBeat: 0 }, { name: 'theme', startBeat: 16 },
    { name: 'E major', startBeat: 56 }, { name: 'return', startBeat: 88 },
    { name: 'coda', startBeat: 128 }],
  tracks: [
    track('piano', 0.86, -0.12, MOON_MELODY),
    track('piano', 0.6, 0.14, MOON.arp),
    track('piano', 0.66, 0, MOON.bass)
  ]
};

/* -------------------------------------------------------------------------------------------
 * 5. Beethoven - Symphony No. 5 in C minor, Op. 67, 1st movement (opening)
 * 2/4 Allegro con brio. The motto is three quavers and a fermata: G G G Eb, then F F F D.
 * Everything that follows is built from that four-note cell.
 * ----------------------------------------------------------------------------------------- */

/**
 * The famous four-note cell: a quaver rest, three repeated quavers and one long note.
 * @param {number} start Beat position of the rest.
 * @param {string} rep Repeated pitch name.
 * @param {string} long Long pitch name.
 * @param {number} vel Velocity 0..1.
 * @param {number} [longDur=2] Length of the final note in beats (fermatas are longer).
 * @returns {Array<Array<number>>} Note tuples spanning `2 + longDur` beats.
 */
function fateMotif(start, rep, long, vel, longDur = 2) {
  return line(start, [
    [null, 0.5], [rep, 0.5, vel, 0.8], [rep, 0.5, vel, 0.8], [rep, 0.5, vel, 0.8],
    [long, longDur, Math.min(1, vel * 1.05), 0.94]
  ], vel, 0.8);
}

const FIFTH_VIOLIN = [].concat(
  fateMotif(0, 'G4', 'Eb4', 0.9, 3), // motto, fermata
  fateMotif(5, 'F4', 'D4', 0.9, 4), // motto answer, longer fermata
  fateMotif(12, 'G4', 'Eb4', 0.45),
  fateMotif(16, 'F4', 'D4', 0.47),
  fateMotif(20, 'Ab4', 'F4', 0.5),
  fateMotif(24, 'Bb4', 'G4', 0.54),
  line(28, [['C5', 0.5], ['Bb4', 0.5], ['Ab4', 0.5], ['G4', 0.5],
    ['F4', 0.5], ['Eb4', 0.5], ['D4', 0.5], ['C4', 0.5]], 0.58, 0.9),
  line(32, [['G4', 0.5], ['Ab4', 0.5], ['Bb4', 0.5], ['C5', 0.5],
    ['D5', 0.5], ['Eb5', 0.5], ['F5', 0.5], ['G5', 0.5]], 0.62, 0.9),
  fateMotif(36, 'G5', 'Eb5', 0.7),
  fateMotif(40, 'F5', 'D5', 0.72),
  fateMotif(44, 'G5', 'Eb5', 0.95, 3), // tutti restatement
  fateMotif(49, 'F5', 'D5', 0.95, 4),
  fateMotif(56, 'G5', 'Eb5', 0.8),
  fateMotif(60, 'F5', 'D5', 0.8),
  line(64, [['Eb5', 0.5], ['D5', 0.5], ['C5', 0.5], ['Bb4', 0.5],
    ['Ab4', 0.5], ['G4', 0.5], ['F4', 0.5], ['Eb4', 0.5],
    ['D4', 0.5], ['Eb4', 0.5], ['F4', 0.5], ['G4', 0.5],
    ['Ab4', 0.5], ['Bb4', 0.5], ['C5', 0.5], ['D5', 0.5]], 0.66, 0.9),
  line(72, [['Eb5', 0.5], ['F5', 0.5], ['G5', 0.5], ['Ab5', 0.5],
    ['G5', 0.5], ['F5', 0.5], ['Eb5', 0.5], ['D5', 0.5],
    ['C5', 0.5], ['D5', 0.5], ['Eb5', 0.5], ['F5', 0.5],
    ['G5', 0.5], ['Ab5', 0.5], ['Bb5', 0.5], ['C6', 0.5]], 0.72, 0.9),
  fateMotif(80, 'C6', 'Ab5', 0.86),
  fateMotif(84, 'Bb5', 'G5', 0.9),
  // Eb major second subject, the lyrical relief after the horn call
  line(92, [['Eb5', 1, 0.5], ['D5', 0.5, 0.46], ['C5', 0.5, 0.46], ['Bb4', 2, 0.5]], 0.5, 0.95),
  line(96, [['Bb4', 1, 0.5], ['C5', 0.5, 0.48], ['D5', 0.5, 0.48], ['Eb5', 2, 0.54]], 0.5, 0.95),
  line(100, [['F5', 1, 0.56], ['Eb5', 0.5, 0.5], ['D5', 0.5, 0.5], ['C5', 2, 0.54]], 0.54, 0.95),
  line(104, [['Bb4', 1.5, 0.5], ['Ab4', 0.5, 0.46], ['G4', 2, 0.48]], 0.5, 0.95),
  line(108, [['G5', 1, 0.6], ['F5', 0.5, 0.54], ['Eb5', 0.5, 0.54], ['D5', 2, 0.58]], 0.58, 0.95),
  line(112, [['C5', 1, 0.56], ['D5', 0.5, 0.52], ['Eb5', 0.5, 0.52], ['F5', 2, 0.58]], 0.56, 0.95),
  line(116, [['Eb5', 2, 0.6], ['Bb4', 2, 0.52]], 0.56, 0.95),
  fateMotif(120, 'G5', 'Eb5', 0.7),
  fateMotif(124, 'F5', 'D5', 0.74),
  fateMotif(128, 'Ab5', 'F5', 0.78),
  fateMotif(132, 'G5', 'Eb5', 0.82),
  cresc(line(136, [['C5', 0.5], ['D5', 0.5], ['Eb5', 0.5], ['F5', 0.5],
    ['G5', 0.5], ['Ab5', 0.5], ['Bb5', 0.5], ['C6', 0.5],
    ['Bb5', 0.5], ['Ab5', 0.5], ['G5', 0.5], ['F5', 0.5],
    ['Eb5', 0.5], ['D5', 0.5], ['C5', 0.5], ['B4', 0.5]], 0.8, 0.9), 136, 144, 0.74, 0.92),
  fateMotif(144, 'C6', 'Ab5', 0.92),
  fateMotif(148, 'Bb5', 'G5', 0.94),
  fateMotif(152, 'Ab5', 'F5', 0.96),
  fateMotif(156, 'G5', 'Eb5', 1),
  line(160, [['G5', 0.5, 0.98, 0.8], ['G5', 0.5, 0.98, 0.8], ['G5', 0.5, 0.98, 0.8],
    ['Eb5', 1.5, 1, 0.9], [null, 0.5], ['C5', 1.5, 1, 0.9], [null, 0.5], ['C5', 2.5, 1, 0.9]], 1, 0.9)
);

/** Roots for the low strings, one whole note per four-beat unit. */
const FIFTH_ROOTS = [
  ['C2'], ['G2'], ['Ab2'], ['Eb2'], ['C2'], ['G2'], ['C2'], ['G2'],
  ['C2'], ['C2'], ['G2'], ['C2'], ['G2'], ['C2'], ['F2'], ['Bb2'],
  ['Eb2'], ['Ab2'], ['G2'], ['Eb2'], ['Eb2'], ['Bb2'], ['Eb2'], ['Ab2'],
  ['Bb2'], ['Eb2'], ['Bb2'], ['C2'], ['G2'], ['Ab2'], ['C2'], ['F2'],
  ['G2'], ['C2'], ['G2'], ['Ab2'], ['G2'], ['C2'], ['C2']
];

/** Inner harmony for the second violins and violas, one note per four-beat unit. */
const FIFTH_INNER = [
  ['Eb4'], ['D4'], ['C4'], ['G4'], ['Eb4'], ['D4'], ['Eb4'], ['D4'],
  ['Eb5'], ['Eb5'], ['D5'], ['G4'], ['D4'], ['Eb4'], ['F4'], ['D4'],
  ['G4'], ['C5'], ['B4'], ['G4'], ['G4'], ['F4'], ['G4'], ['C5'],
  ['D5'], ['G4'], ['F4'], ['Eb4'], ['D4'], ['C5'], ['Eb5'], ['F4'],
  ['D5'], ['Eb5'], ['D5'], ['C5'], ['D5'], ['Eb5'], ['C5']
];

const FIFTH_CELLO = [].concat(
  fateMotif(0, 'G3', 'Eb3', 0.8, 3),
  fateMotif(5, 'F3', 'D3', 0.8, 4),
  grid(12, 4, FIFTH_ROOTS.slice(0, 20).map((r) => [r[0].replace(/(\d)$/, (d) => String(+d + 1))]), 0.45, 0.9),
  // under the Eb second subject the cellos keep hammering the rhythm of the motto
  fateMotif(92, 'Eb3', 'Eb3', 0.4), fateMotif(96, 'Bb2', 'Bb2', 0.4),
  fateMotif(100, 'Eb3', 'Eb3', 0.42), fateMotif(104, 'Ab2', 'Ab2', 0.42),
  fateMotif(108, 'Bb2', 'Bb2', 0.44), fateMotif(112, 'Eb3', 'Eb3', 0.44),
  fateMotif(116, 'Bb2', 'Bb2', 0.46),
  grid(120, 4, [['C3'], ['G3'], ['Ab3'], ['C4'], ['F3'], ['G3'], ['C4'], ['G3'], ['Ab3'], ['G3']], 0.6, 0.9),
  line(160, [['G3', 0.5, 0.9, 0.8], ['G3', 0.5, 0.9, 0.8], ['G3', 0.5, 0.9, 0.8],
    ['Eb3', 1.5, 0.95, 0.9], [null, 0.5], ['C3', 1.5, 0.95, 0.9], [null, 0.5], ['C3', 2.5, 0.95, 0.9]], 0.9, 0.9)
);

const FIFTH_HORN = [].concat(
  chord(44, ['C4'], 5, 0.6), chord(49, ['B3'], 4, 0.6),
  fateMotif(88, 'Bb3', 'Eb4', 0.85), // the horn call that opens the door to Eb major
  chord(92, ['G3'], 3.8, 0.34), chord(96, ['Eb3'], 3.8, 0.34), chord(100, ['G3'], 3.8, 0.36),
  chord(104, ['Eb3'], 3.8, 0.36), chord(108, ['F3'], 3.8, 0.38), chord(112, ['Bb3'], 3.8, 0.38),
  chord(116, ['G3'], 3.8, 0.36),
  chord(144, ['C4'], 3.8, 0.7), chord(148, ['B3'], 3.8, 0.72), chord(152, ['C4'], 3.8, 0.76),
  chord(156, ['D4'], 3.8, 0.8),
  line(160, [['G3', 0.5, 0.9, 0.8], ['G3', 0.5, 0.9, 0.8], ['G3', 0.5, 0.9, 0.8],
    ['Eb4', 1.5, 0.95, 0.9], [null, 0.5], ['C4', 1.5, 0.95, 0.9], [null, 0.5], ['C4', 2.5, 0.95, 0.9]], 0.9, 0.9)
);

const FIFTH_TIMPANI = [].concat(
  fateMotif(44, 'C2', 'C2', 0.8, 3), fateMotif(49, 'G1', 'G1', 0.8, 4),
  line(136, [['C2', 0.5], ['C2', 0.5], ['C2', 0.5], ['C2', 0.5], ['G1', 0.5], ['G1', 0.5],
    ['G1', 0.5], ['G1', 0.5], ['C2', 0.5], ['C2', 0.5], ['C2', 0.5], ['C2', 0.5],
    ['G1', 0.5], ['G1', 0.5], ['G1', 0.5], ['G1', 0.5]], 0.5, 0.7),
  fateMotif(144, 'C2', 'C2', 0.8), fateMotif(148, 'G1', 'G1', 0.82),
  fateMotif(152, 'C2', 'C2', 0.86), fateMotif(156, 'G1', 'G1', 0.9),
  line(160, [['C2', 0.5, 0.95, 0.7], ['C2', 0.5, 0.95, 0.7], ['C2', 0.5, 0.95, 0.7],
    ['C2', 1.5, 1, 0.8], [null, 0.5], ['G1', 1.5, 1, 0.8], [null, 0.5], ['C2', 2.5, 1, 0.85]], 1, 0.8)
);

/** @type {Object} Symphony No. 5, first movement opening. */
const beethoven_5th = {
  id: 'beethoven_5th',
  title: 'Symphony No. 5 in C minor - I',
  titleKo: '교향곡 5번 운명 1악장',
  composer: 'L. van Beethoven',
  year: 1808,
  tempo: 108,
  timeSig: [2, 4],
  key: 'C minor',
  swing: 0,
  reverb: 0.5,
  station: 'action',
  loop: true,
  lengthBeats: 168,
  sections: [{ name: 'motto', startBeat: 0 }, { name: 'theme', startBeat: 12 },
    { name: 'tutti', startBeat: 44 }, { name: 'horn call', startBeat: 88 },
    { name: 'second subject', startBeat: 92 }, { name: 'coda', startBeat: 120 }],
  tracks: [
    track('violin', 0.88, -0.2, FIFTH_VIOLIN),
    track('strings', 0.42, 0.25, grid(12, 4, FIFTH_INNER, 0.34, 0.92)),
    track('cello', 0.6, -0.3, FIFTH_CELLO),
    track('bass', 0.55, 0.1, grid(12, 4, FIFTH_ROOTS, 0.42, 0.9)),
    track('horn', 0.5, 0.35, FIFTH_HORN),
    track('timpani', 0.55, 0, FIFTH_TIMPANI)
  ]
};

/* -------------------------------------------------------------------------------------------
 * 6. Mozart - Serenade No. 13 "Eine kleine Nachtmusik", K. 525, 1st movement
 * G major, 4/4 Allegro. The whole ensemble hammers out the opening rocket in octaves:
 * G-D-G / D-G-B / D-G, answered a fifth higher: D-A-D / A-D-F# / A-D.
 * ----------------------------------------------------------------------------------------- */

/** Bars 1-4: the two unison rockets. */
const NACHT_ROCKET = line(0, [
  ['G4', 0.5, 0.9], ['D4', 0.5, 0.82], ['G4', 1, 0.92, 0.7], // 1
  ['D4', 0.5, 0.82], ['G4', 0.5, 0.86], ['B4', 1, 0.92, 0.7],
  ['D5', 1, 0.94, 0.7], ['G5', 1, 0.96, 0.7], [null, 2], // 2
  ['D5', 0.5, 0.9], ['A4', 0.5, 0.82], ['D5', 1, 0.92, 0.7], // 3
  ['A4', 0.5, 0.82], ['D5', 0.5, 0.86], ['F#5', 1, 0.92, 0.7],
  ['A5', 1, 0.94, 0.7], ['D6', 1, 0.96, 0.7], [null, 2] // 4
], 0.9, 0.72);

/** Bars 5-12: the running continuation and the cadence with repeated quavers. */
const NACHT_CONT = line(16, [
  ['G5', 0.5, 0.5], ['F#5', 0.5, 0.48], ['G5', 0.5, 0.5], ['A5', 0.5, 0.52], // 5
  ['B5', 0.5, 0.54], ['A5', 0.5, 0.5], ['B5', 0.5, 0.54], ['C6', 0.5, 0.56],
  ['D6', 0.5, 0.6], ['C6', 0.5, 0.56], ['B5', 0.5, 0.54], ['A5', 0.5, 0.52], // 6
  ['G5', 0.5, 0.52], ['F#5', 0.5, 0.5], ['E5', 0.5, 0.5], ['D5', 0.5, 0.5],
  ['C5', 0.5, 0.6], ['D5', 0.5, 0.6], ['E5', 0.5, 0.62], ['F#5', 0.5, 0.64], // 7
  ['G5', 0.5, 0.66], ['A5', 0.5, 0.68], ['B5', 0.5, 0.7], ['C6', 0.5, 0.72],
  ['D6', 1, 0.76], ['B5', 1, 0.7], ['G5', 2, 0.66], // 8
  ['D5', 0.5, 0.62, 0.6], ['D5', 0.5, 0.58, 0.6], ['D5', 0.5, 0.6, 0.6], ['D5', 0.5, 0.58, 0.6], // 9
  ['D5', 0.5, 0.62, 0.6], ['D5', 0.5, 0.58, 0.6], ['D5', 0.5, 0.6, 0.6], ['D5', 0.5, 0.58, 0.6],
  ['G5', 0.5, 0.66, 0.6], ['G5', 0.5, 0.6, 0.6], ['G5', 0.5, 0.62, 0.6], ['G5', 0.5, 0.6, 0.6], // 10
  ['B5', 0.5, 0.68, 0.6], ['B5', 0.5, 0.62, 0.6], ['B5', 0.5, 0.64, 0.6], ['B5', 0.5, 0.62, 0.6],
  ['A5', 0.5, 0.68, 0.6], ['A5', 0.5, 0.62, 0.6], ['A5', 0.5, 0.64, 0.6], ['A5', 0.5, 0.62, 0.6], // 11
  ['D5', 0.5, 0.68, 0.6], ['D5', 0.5, 0.62, 0.6], ['D5', 0.5, 0.64, 0.6], ['D5', 0.5, 0.62, 0.6],
  ['G5', 1, 0.74], ['B5', 1, 0.7], ['G5', 2, 0.66] // 12
], 0.6, 0.9);

/** Bars 17-32: the graceful second subject in D major and the chattering closing group. */
const NACHT_SECOND = line(64, [
  ['A5', 0.75, 0.5], ['B5', 0.25, 0.44], ['A5', 0.5, 0.48], ['G5', 0.5, 0.46], // 17
  ['F#5', 1, 0.5], ['E5', 1, 0.46],
  ['D5', 1, 0.5], ['F#5', 1, 0.5], ['A5', 2, 0.54], // 18
  ['G5', 0.75, 0.52], ['A5', 0.25, 0.46], ['G5', 0.5, 0.5], ['F#5', 0.5, 0.48], // 19
  ['E5', 1, 0.5], ['C#5', 1, 0.48],
  ['D5', 2, 0.52], ['A4', 2, 0.46], // 20
  ['A5', 0.5, 0.54], ['A5', 0.5, 0.5], ['B5', 0.5, 0.54], ['A5', 0.5, 0.5], // 21
  ['G5', 0.5, 0.52], ['F#5', 0.5, 0.5], ['E5', 0.5, 0.5], ['D5', 0.5, 0.48],
  ['C#5', 1, 0.5], ['E5', 1, 0.52], ['A5', 2, 0.56], // 22
  ['B5', 0.5, 0.56], ['A5', 0.5, 0.52], ['G5', 0.5, 0.52], ['F#5', 0.5, 0.5], // 23
  ['E5', 0.5, 0.5], ['D5', 0.5, 0.48], ['C#5', 0.5, 0.48], ['B4', 0.5, 0.46],
  ['A4', 2, 0.5], [null, 2], // 24
  ['A5', 0.25, 0.62], ['B5', 0.25, 0.56], ['A5', 0.25, 0.58], ['G5', 0.25, 0.56], // 25
  ['F#5', 0.25, 0.58], ['G5', 0.25, 0.54], ['F#5', 0.25, 0.56], ['E5', 0.25, 0.54],
  ['D5', 1, 0.6], ['A4', 1, 0.54],
  ['A5', 0.25, 0.62], ['B5', 0.25, 0.56], ['A5', 0.25, 0.58], ['G5', 0.25, 0.56], // 26
  ['F#5', 0.25, 0.58], ['G5', 0.25, 0.54], ['F#5', 0.25, 0.56], ['E5', 0.25, 0.54],
  ['D5', 1, 0.6], ['A4', 1, 0.54],
  ['E5', 0.5, 0.58], ['G5', 0.5, 0.58], ['B5', 0.5, 0.6], ['G5', 0.5, 0.56], // 27
  ['A5', 1, 0.62], ['C#5', 1, 0.56],
  ['D5', 1, 0.62], ['F#5', 1, 0.6], ['A5', 2, 0.64], // 28
  ['A5', 0.5, 0.64, 0.6], ['A5', 0.5, 0.58, 0.6], ['A5', 0.5, 0.6, 0.6], ['A5', 0.5, 0.58, 0.6], // 29
  ['B5', 0.5, 0.62], ['A5', 0.5, 0.58], ['G5', 0.5, 0.58], ['F#5', 0.5, 0.56],
  ['E5', 0.5, 0.6, 0.6], ['E5', 0.5, 0.56, 0.6], ['E5', 0.5, 0.58, 0.6], ['E5', 0.5, 0.56, 0.6], // 30
  ['G5', 0.5, 0.6], ['E5', 0.5, 0.56], ['C#5', 0.5, 0.58], ['A4', 0.5, 0.54],
  ['D5', 0.5, 0.64], ['F#5', 0.5, 0.62], ['A5', 0.5, 0.66], ['D6', 0.5, 0.7], // 31
  ['C#6', 1, 0.68], ['A5', 1, 0.62],
  ['D6', 1, 0.72], ['A5', 1, 0.66], ['D5', 2, 0.7] // 32
], 0.56, 0.9);

/** Bars 45-48: the closing tag back to the tonic. */
const NACHT_TAG = line(176, [
  ['G5', 0.5, 0.72], ['A5', 0.5, 0.68], ['B5', 0.5, 0.72], ['C6', 0.5, 0.7],
  ['D6', 0.5, 0.78], ['B5', 0.5, 0.72], ['G5', 0.5, 0.74], ['D5', 0.5, 0.7],
  ['A5', 0.5, 0.74], ['F#5', 0.5, 0.7], ['D5', 0.5, 0.72], ['A4', 0.5, 0.68],
  ['D5', 1, 0.74], ['F#5', 1, 0.72],
  ['G5', 0.5, 0.8], ['B5', 0.5, 0.76], ['D6', 0.5, 0.82], ['B5', 0.5, 0.76],
  ['A5', 1, 0.8], ['F#5', 1, 0.76],
  ['G5', 1, 0.9], ['D5', 1, 0.82], ['G5', 2, 0.86]
], 0.75, 0.86);

/**
 * @type {Array<Array<(string|null)>>} Per bar: [pulse pitch first half, pulse pitch second half,
 * bass first half, bass second half]. Null rows are the unison bars where only the tune sounds.
 */
const NACHT_HARM = [
  null, null, null, null,
  ['B4', 'A4', 'G2', 'D2'], ['A4', 'B4', 'D2', 'G2'], ['E4', 'A4', 'C3', 'D3'], ['B4', 'B4', 'G2', 'G2'],
  ['A4', 'C5', 'D2', 'D2'], ['B4', 'D5', 'G2', 'G2'], ['A4', 'C5', 'D2', 'D2'], ['B4', 'B4', 'G2', 'G2'],
  null, null, null, null,
  ['A4', 'A4', 'D3', 'D3'], ['A4', 'A4', 'D3', 'A2'], ['B4', 'A4', 'E3', 'A2'], ['A4', 'A4', 'D3', 'D3'],
  ['A4', 'A4', 'D3', 'D3'], ['A4', 'C#5', 'A2', 'A2'], ['B4', 'A4', 'E3', 'A2'], ['A4', 'A4', 'D3', 'D3'],
  ['D5', 'C#5', 'D3', 'A2'], ['D5', 'C#5', 'D3', 'A2'], ['B4', 'A4', 'E3', 'A2'], ['A4', 'A4', 'D3', 'D3'],
  ['D5', 'D5', 'D3', 'D3'], ['C#5', 'C#5', 'A2', 'A2'], ['D5', 'C#5', 'D3', 'A2'], ['D5', 'D5', 'D3', 'D3'],
  null, null, null, null,
  ['B4', 'A4', 'G2', 'D2'], ['A4', 'B4', 'D2', 'G2'], ['E4', 'A4', 'C3', 'D3'], ['B4', 'B4', 'G2', 'G2'],
  ['A4', 'C5', 'D2', 'D2'], ['B4', 'D5', 'G2', 'G2'], ['A4', 'C5', 'D2', 'D2'], ['B4', 'B4', 'G2', 'G2'],
  ['B4', 'A4', 'G2', 'D2'], ['A4', 'B4', 'D2', 'D2'], ['B4', 'A4', 'G2', 'D2'], ['B4', 'B4', 'G2', 'G2']
];

/**
 * Builds the classical accompaniment: repeated quavers in the inner strings, a viola voice a
 * third below and the walking bass in crotchets.
 * @param {Array<Array<(string|null)>>} table Harmony table, one row per bar.
 * @returns {{pulse: Array<Array<number>>, viola: Array<Array<number>>, bass: Array<Array<number>>}} Voices.
 */
function buildNachtAccomp(table) {
  const pulse = [];
  const viola = [];
  const bass = [];
  for (let b = 0; b < table.length; b++) {
    const row = table[b];
    if (!row) continue;
    const base = b * 4;
    for (let i = 0; i < 8; i++) {
      const p = m(i < 4 ? row[0] : row[1]);
      const v = (i % 2 === 0) ? 0.36 : 0.3;
      pulse.push([q(base + i * 0.5), p, 0.34, v]);
      viola.push([q(base + i * 0.5), p - 12, 0.34, v * 0.9]);
    }
    for (let i = 0; i < 4; i++) {
      const bn = m(i < 2 ? row[2] : row[3]);
      bass.push([q(base + i), bn, 0.8, i === 0 ? 0.5 : 0.42]);
    }
  }
  return { pulse, viola, bass };
}

const NACHT_ACC = buildNachtAccomp(NACHT_HARM);

/** @type {Object} Eine kleine Nachtmusik, first movement. */
const mozart_nachtmusik = {
  id: 'mozart_nachtmusik',
  title: 'Eine kleine Nachtmusik, K. 525 - I',
  titleKo: '아이네 클라이네 나흐트무지크 1악장',
  composer: 'W.A. Mozart',
  year: 1787,
  tempo: 132,
  timeSig: [4, 4],
  key: 'G major',
  swing: 0,
  reverb: 0.42,
  station: 'classic',
  loop: true,
  lengthBeats: 192,
  sections: [{ name: 'theme', startBeat: 0 }, { name: 'bridge', startBeat: 16 },
    { name: 'second subject', startBeat: 64 }, { name: 'closing', startBeat: 96 },
    { name: 'reprise', startBeat: 128 }],
  tracks: [
    track('violin', 0.9, -0.22, NACHT_ROCKET, NACHT_CONT, NACHT_SECOND,
      copyAt(NACHT_ROCKET, 48, 0, 0.85), copyAt(NACHT_ROCKET, 128, 0, 1),
      copyAt(NACHT_CONT, 128, 0, 1.05), NACHT_TAG),
    track('strings', 0.4, 0.28, NACHT_ACC.pulse),
    track('strings', 0.32, 0.42, NACHT_ACC.viola),
    track('cello', 0.5, -0.32, copyAt(NACHT_ROCKET, 0, -24, 0.9), copyAt(NACHT_ROCKET, 48, -24, 0.8),
      copyAt(NACHT_ROCKET, 128, -24, 0.95), NACHT_ACC.bass),
    track('bass', 0.5, 0.06, copyAt(NACHT_ROCKET, 0, -36, 0.85), copyAt(NACHT_ROCKET, 48, -36, 0.75),
      copyAt(NACHT_ROCKET, 128, -36, 0.9), copyAt(NACHT_ACC.bass, 0, -12, 0.9))
  ]
};

/* -------------------------------------------------------------------------------------------
 * 7. Mozart - Rondo alla Turca (Piano Sonata No. 11, K. 331, 3rd movement)
 * 2/4 Allegretto. The rondo theme is four semiquavers turning around A, each group answered by
 * a quaver a third higher: B-A-G#-A-C / D-C-B-C-E / F-E-D#-E-B / C-B-A-G#-A.
 * ----------------------------------------------------------------------------------------- */

/** The eight-bar A minor rondo theme. */
const TURCA_THEME = line(0, [
  ['B4', 0.25], ['A4', 0.25], ['G#4', 0.25], ['A4', 0.25], ['C5', 0.5, null, 0.55], [null, 0.5], // 1
  ['D5', 0.25], ['C5', 0.25], ['B4', 0.25], ['C5', 0.25], ['E5', 0.5, null, 0.55], [null, 0.5], // 2
  ['F5', 0.25], ['E5', 0.25], ['D#5', 0.25], ['E5', 0.25], ['B5', 0.5, null, 0.55], [null, 0.5], // 3
  ['C6', 0.25], ['B5', 0.25], ['A5', 0.25], ['G#5', 0.25], ['A5', 0.5, null, 0.55], [null, 0.5], // 4
  ['B4', 0.25], ['A4', 0.25], ['G#4', 0.25], ['A4', 0.25], ['C5', 0.5, null, 0.55], [null, 0.5], // 5
  ['D5', 0.25], ['C5', 0.25], ['B4', 0.25], ['C5', 0.25], ['E5', 0.5, null, 0.55], [null, 0.5], // 6
  ['F5', 0.25], ['E5', 0.25], ['D#5', 0.25], ['E5', 0.25], ['B5', 0.5, null, 0.55], [null, 0.5], // 7
  ['C6', 0.25], ['B5', 0.25], ['A5', 0.25], ['G#5', 0.25], ['A5', 1, null, 0.7] // 8
], 0.62, 0.92);

/** Left hand of the rondo theme: bass note then three staccato chords per bar. */
const TURCA_THEME_LH = (function buildTurcaLh() {
  const bars = [
    ['A2', ['A3', 'C4', 'E4']], ['E2', ['G#3', 'B3', 'D4']], ['E2', ['G#3', 'B3', 'E4']],
    ['A2', ['A3', 'C4', 'E4']], ['A2', ['A3', 'C4', 'E4']], ['E2', ['G#3', 'B3', 'D4']],
    ['E2', ['G#3', 'B3', 'E4']], ['A2', ['A3', 'C4', 'E4']]
  ];
  let out = [];
  for (let b = 0; b < bars.length; b++) {
    const t = b * 2;
    out = out.concat(chord(t, [bars[b][0]], 0.42, 0.5));
    out = out.concat(chord(t + 0.5, bars[b][1], 0.32, 0.34));
    out = out.concat(chord(t + 1, bars[b][1], 0.32, 0.38));
    out = out.concat(chord(t + 1.5, bars[b][1], 0.32, 0.32));
  }
  return out;
})();

/** The A major march episode. */
const TURCA_MARCH = line(32, [
  ['A5', 0.5, 0.72], ['A5', 0.25, 0.6], ['B5', 0.25, 0.6], ['C#6', 0.5, 0.74], ['A5', 0.5, 0.64], // 17
  ['B5', 0.5, 0.72], ['B5', 0.25, 0.6], ['C#6', 0.25, 0.62], ['D6', 0.5, 0.76], ['B5', 0.5, 0.64], // 18
  ['C#6', 0.5, 0.74], ['B5', 0.25, 0.62], ['A5', 0.25, 0.6], ['B5', 0.5, 0.66], ['G#5', 0.5, 0.62], // 19
  ['A5', 1, 0.78], [null, 1], // 20
  ['E6', 0.5, 0.8], ['D6', 0.25, 0.66], ['C#6', 0.25, 0.66], ['B5', 0.5, 0.7], ['A5', 0.5, 0.66], // 21
  ['G#5', 0.5, 0.66], ['A5', 0.25, 0.62], ['B5', 0.25, 0.64], ['C#6', 0.5, 0.72], ['E5', 0.5, 0.6], // 22
  ['D6', 0.5, 0.74], ['C#6', 0.25, 0.66], ['B5', 0.25, 0.64], ['A5', 0.5, 0.7], ['G#5', 0.5, 0.64], // 23
  ['A5', 1, 0.8], [null, 1] // 24
], 0.7, 0.85);

/** Left hand of the march: octave bass and off-beat chords. */
const TURCA_MARCH_LH = (function buildTurcaMarchLh() {
  const bars = [
    ['A2', ['A3', 'C#4', 'E4']], ['E2', ['G#3', 'B3', 'E4']], ['E2', ['G#3', 'B3', 'D4']],
    ['A2', ['A3', 'C#4', 'E4']], ['A2', ['A3', 'C#4', 'E4']], ['E2', ['G#3', 'B3', 'E4']],
    ['E2', ['G#3', 'B3', 'D4']], ['A2', ['A3', 'C#4', 'E4']]
  ];
  let out = [];
  for (let b = 0; b < bars.length; b++) {
    const t = 32 + b * 2;
    out = out.concat(chord(t, [bars[b][0]], 0.45, 0.6));
    out = out.concat(chord(t + 0.5, bars[b][1], 0.35, 0.4));
    out = out.concat(chord(t + 1, [bars[b][0].replace(/2$/, '3')], 0.45, 0.5));
    out = out.concat(chord(t + 1.5, bars[b][1], 0.35, 0.38));
  }
  return out;
})();

/** The stormy A minor arpeggio episode. */
const TURCA_EPISODE = [].concat(
  figure(80, ['A4', 'C5', 'E5', 'A5', 'C6', 'A5', 'E5', 'C5'], 0.25, 8, 0.6, 0.9),
  figure(82, ['E4', 'G#4', 'B4', 'E5', 'G#5', 'E5', 'B4', 'G#4'], 0.25, 8, 0.6, 0.9),
  figure(84, ['A4', 'C5', 'E5', 'A5', 'C6', 'A5', 'E5', 'C5'], 0.25, 8, 0.62, 0.9),
  figure(86, ['D5', 'F5', 'A5', 'D6', 'F6', 'D6', 'A5', 'F5'], 0.25, 8, 0.64, 0.9),
  figure(88, ['G#4', 'B4', 'D5', 'G#5', 'B5', 'G#5', 'D5', 'B4'], 0.25, 8, 0.66, 0.9),
  figure(90, ['A4', 'C5', 'E5', 'A5', 'C6', 'A5', 'E5', 'C5'], 0.25, 8, 0.68, 0.9),
  figure(92, ['B4', 'D#5', 'F#5', 'B5', 'D#6', 'B5', 'F#5', 'D#5'], 0.25, 8, 0.7, 0.9),
  line(94, [['E5', 0.25, 0.72], ['G#5', 0.25, 0.72], ['B5', 0.25, 0.74], ['E6', 0.25, 0.76],
    ['D6', 0.25, 0.74], ['B5', 0.25, 0.72], ['G#5', 0.25, 0.7], ['E5', 0.25, 0.68]], 0.72, 0.9)
);

/** Brilliant A major coda: octave chords, running scales and the closing hammer strokes. */
const TURCA_CODA = [].concat(
  line(112, [
    ['A5', 0.5, 0.82], ['C#6', 0.25, 0.7], ['E6', 0.25, 0.72], ['A6', 0.5, 0.86], ['E6', 0.5, 0.74],
    ['C#6', 0.5, 0.78], ['A5', 0.25, 0.7], ['C#6', 0.25, 0.7], ['E6', 0.5, 0.82], ['C#6', 0.5, 0.72],
    ['B5', 0.5, 0.76], ['D6', 0.25, 0.68], ['F#6', 0.25, 0.7], ['E6', 0.5, 0.8], ['B5', 0.5, 0.7],
    ['A5', 1, 0.84], [null, 1]
  ], 0.78, 0.8),
  line(120, [
    ['E6', 0.25, 0.8], ['D6', 0.25, 0.74], ['C#6', 0.25, 0.74], ['B5', 0.25, 0.72],
    ['A5', 0.25, 0.76], ['G#5', 0.25, 0.7], ['F#5', 0.25, 0.7], ['E5', 0.25, 0.68],
    ['D5', 0.25, 0.72], ['E5', 0.25, 0.7], ['F#5', 0.25, 0.72], ['G#5', 0.25, 0.72],
    ['A5', 0.25, 0.78], ['B5', 0.25, 0.76], ['C#6', 0.25, 0.78], ['D6', 0.25, 0.8],
    ['E6', 0.5, 0.86], ['C#6', 0.5, 0.76], ['A5', 0.5, 0.8], ['E5', 0.5, 0.72],
    ['A5', 1, 0.88], [null, 1]
  ], 0.78, 0.88),
  chord(128, ['A4', 'C#5', 'E5', 'A5'], 0.45, 0.86), chord(129, ['A4', 'C#5', 'E5', 'A5'], 0.45, 0.8),
  chord(130, ['E4', 'B4', 'E5', 'G#5'], 0.45, 0.84), chord(131, ['E4', 'B4', 'E5', 'G#5'], 0.45, 0.78),
  chord(132, ['A4', 'C#5', 'E5', 'A5'], 0.45, 0.88), chord(133, ['A4', 'C#5', 'E5', 'A5'], 0.45, 0.8),
  chord(134, ['E4', 'B4', 'E5', 'G#5'], 0.45, 0.86), chord(135, ['E4', 'B4', 'E5', 'G#5'], 0.45, 0.8),
  line(136, [['A5', 0.25, 0.86], ['B5', 0.25, 0.8], ['C#6', 0.25, 0.84], ['D6', 0.25, 0.82],
    ['E6', 0.5, 0.9], ['C#6', 0.5, 0.8],
    ['A5', 0.25, 0.86], ['B5', 0.25, 0.8], ['C#6', 0.25, 0.84], ['D6', 0.25, 0.82],
    ['E6', 0.5, 0.9], ['E5', 0.5, 0.8]], 0.84, 0.88),
  chord(140, ['A4', 'C#5', 'E5', 'A5'], 0.9, 0.92), chord(141, ['E4', 'A4', 'C#5', 'E5'], 0.9, 0.86),
  chord(142, ['A3', 'A4', 'C#5', 'E5', 'A5'], 1.9, 0.95)
);

/** Left hand for the episode and the coda. */
const TURCA_LOW = (function buildTurcaLow() {
  let out = [];
  const epi = [['A2', 'A3'], ['E2', 'E3'], ['A2', 'A3'], ['D2', 'D3'], ['E2', 'E3'], ['A2', 'A3'],
    ['B2', 'B3'], ['E2', 'E3']];
  for (let b = 0; b < epi.length; b++) {
    const t = 80 + b * 2;
    out = out.concat(chord(t, [epi[b][0]], 0.45, 0.55), chord(t + 0.5, [epi[b][1]], 0.4, 0.4),
      chord(t + 1, [epi[b][0]], 0.45, 0.5), chord(t + 1.5, [epi[b][1]], 0.4, 0.4));
  }
  const coda = [['A2', ['A3', 'C#4', 'E4']], ['A2', ['A3', 'C#4', 'E4']], ['E2', ['G#3', 'B3', 'E4']],
    ['A2', ['A3', 'C#4', 'E4']], ['E2', ['G#3', 'B3', 'E4']], ['A2', ['A3', 'C#4', 'E4']],
    ['E2', ['G#3', 'B3', 'D4']], ['A2', ['A3', 'C#4', 'E4']], ['A2', ['A3', 'C#4', 'E4']],
    ['E2', ['G#3', 'B3', 'E4']], ['A2', ['A3', 'C#4', 'E4']], ['E2', ['G#3', 'B3', 'E4']],
    ['A2', ['A3', 'C#4', 'E4']], ['A2', ['A3', 'C#4', 'E4']]];
  for (let b = 0; b < coda.length; b++) {
    const t = 112 + b * 2;
    out = out.concat(chord(t, [coda[b][0]], 0.45, 0.65), chord(t + 0.5, coda[b][1], 0.35, 0.45),
      chord(t + 1, [coda[b][0].replace(/2$/, '3')], 0.45, 0.55), chord(t + 1.5, coda[b][1], 0.35, 0.42));
  }
  out = out.concat(chord(140, ['A2', 'E3'], 0.9, 0.8), chord(141, ['E2', 'E3'], 0.9, 0.76),
    chord(142, ['A1', 'A2', 'E3'], 1.9, 0.9));
  return out;
})();

/** Janissary percussion colouring the A major sections. */
const TURCA_DRUM = [].concat(
  figure(32, ['A2', 'E2', 'A2', 'E2'], 0.5, 64, 0.3, 0.5),
  figure(112, ['A2', 'E2', 'A2', 'E2'], 0.5, 56, 0.4, 0.5),
  chord(140, ['A2'], 0.4, 0.7), chord(141, ['E2'], 0.4, 0.7), chord(142, ['A2'], 0.9, 0.85)
);

/** @type {Object} Rondo alla Turca. */
const mozart_turca = {
  id: 'mozart_turca',
  title: 'Rondo alla Turca, K. 331 - III',
  titleKo: '터키 행진곡',
  composer: 'W.A. Mozart',
  year: 1783,
  tempo: 126,
  timeSig: [2, 4],
  key: 'A minor',
  swing: 0,
  reverb: 0.34,
  station: 'classic',
  loop: true,
  lengthBeats: 144,
  sections: [{ name: 'rondo A', startBeat: 0 }, { name: 'march B', startBeat: 32 },
    { name: 'rondo A', startBeat: 64 }, { name: 'episode', startBeat: 80 },
    { name: 'rondo A', startBeat: 96 }, { name: 'coda', startBeat: 112 }],
  tracks: [
    track('piano', 0.88, -0.1, TURCA_THEME, copyAt(TURCA_THEME, 16, 0, 0.85), TURCA_MARCH,
      copyAt(TURCA_MARCH, 16, 0, 0.92), copyAt(TURCA_THEME, 64, 0, 0.95), TURCA_EPISODE,
      copyAt(TURCA_THEME, 96, 0, 1), TURCA_CODA),
    track('piano', 0.68, 0.14, TURCA_THEME_LH, copyAt(TURCA_THEME_LH, 16, 0, 0.9), TURCA_MARCH_LH,
      copyAt(TURCA_MARCH_LH, 16, 0, 0.95), copyAt(TURCA_THEME_LH, 64, 0, 0.95), TURCA_LOW,
      copyAt(TURCA_THEME_LH, 96, 0, 1)),
    track('timpani', 0.3, 0, TURCA_DRUM)
  ]
};

/* -------------------------------------------------------------------------------------------
 * 8. Vivaldi - The Four Seasons, Violin Concerto in E major "La primavera" (Spring), 1st mvt
 * The ritornello states its motif on B, echoes it piano, restates it on G#, then the solo
 * violin answers with the birdsong episode.
 * ----------------------------------------------------------------------------------------- */

/** Ritornello, first half (bars 1-4). */
const SPRING_RIT = line(0, [
  ['B4', 0.5, 0.78], ['B4', 0.5, 0.72], ['B4', 1, 0.8, 0.6], // 1
  ['B4', 0.5, 0.76], ['B4', 0.5, 0.72], ['B4', 1, 0.8, 0.6],
  ['B4', 0.5, 0.78], ['C#5', 0.5, 0.76], ['B4', 0.5, 0.74], ['A4', 0.5, 0.72], // 2
  ['G#4', 2, 0.8, 0.85],
  ['G#4', 0.5, 0.76], ['G#4', 0.5, 0.72], ['G#4', 1, 0.78, 0.6], // 3
  ['G#4', 0.5, 0.74], ['G#4', 0.5, 0.72], ['G#4', 1, 0.78, 0.6],
  ['G#4', 0.5, 0.76], ['A4', 0.5, 0.74], ['G#4', 0.5, 0.74], ['F#4', 0.5, 0.72], // 4
  ['E4', 2, 0.8, 0.85]
], 0.76, 0.9);

/** Ritornello, second half (bars 9-12): the turning quaver figure and its cadence. */
const SPRING_RIT2 = line(32, [
  ['B4', 0.5, 0.72], ['E5', 0.5, 0.78], ['D#5', 0.5, 0.72], ['E5', 0.5, 0.76], // 9
  ['F#5', 0.5, 0.78], ['E5', 0.5, 0.74], ['D#5', 0.5, 0.72], ['E5', 0.5, 0.76],
  ['F#5', 0.5, 0.78], ['G#5', 0.5, 0.8], ['A5', 0.5, 0.82], ['G#5', 0.5, 0.78], // 10
  ['F#5', 1, 0.8], ['B4', 1, 0.72],
  ['B4', 0.5, 0.72], ['E5', 0.5, 0.78], ['D#5', 0.5, 0.72], ['E5', 0.5, 0.76], // 11
  ['F#5', 0.5, 0.78], ['E5', 0.5, 0.74], ['G#5', 0.5, 0.8], ['F#5', 0.5, 0.76],
  ['E5', 0.5, 0.82], ['D#5', 0.5, 0.76], ['E5', 1, 0.84], ['B4', 1, 0.74], ['E5', 1, 0.8] // 12
], 0.76, 0.9);

/** Solo violin birdsong episode (bars 17-24): trilled thirds, chirps and rapid repeats. */
const SPRING_BIRDS = line(64, [
  ['E6', 0.25, 0.68], ['F#6', 0.25, 0.62], ['E6', 0.25, 0.66], ['F#6', 0.25, 0.62], // 17
  ['E6', 0.5, 0.7, 0.5], [null, 0.5],
  ['B5', 0.25, 0.64], ['C#6', 0.25, 0.6], ['B5', 0.25, 0.62], ['C#6', 0.25, 0.6],
  ['B5', 0.5, 0.66, 0.5], [null, 0.5],
  ['G#5', 0.25, 0.66], ['A5', 0.25, 0.62], ['G#5', 0.25, 0.64], ['A5', 0.25, 0.62], // 18
  ['G#5', 0.5, 0.68, 0.5], ['E5', 0.5, 0.6, 0.5],
  ['F#5', 0.25, 0.64], ['G#5', 0.25, 0.62], ['F#5', 0.25, 0.62], ['G#5', 0.25, 0.62],
  ['F#5', 0.5, 0.66, 0.5], [null, 0.5],
  ['E6', 0.125, 0.7], ['D#6', 0.125, 0.64], ['E6', 0.125, 0.68], ['D#6', 0.125, 0.64], // 19
  ['E6', 0.125, 0.7], ['D#6', 0.125, 0.64], ['E6', 0.125, 0.68], ['B5', 0.125, 0.64],
  ['E6', 0.5, 0.74, 0.6], [null, 0.5], ['B5', 1, 0.66, 0.6], [null, 1],
  ['C#6', 0.25, 0.68], ['B5', 0.25, 0.64], ['A5', 0.25, 0.66], ['G#5', 0.25, 0.64], // 20
  ['F#5', 0.25, 0.66], ['E5', 0.25, 0.64], ['D#5', 0.25, 0.64], ['E5', 0.25, 0.66],
  ['B5', 1, 0.72], ['E5', 1, 0.66],
  ['E6', 0.25, 0.72], ['F#6', 0.25, 0.66], ['E6', 0.25, 0.7], ['F#6', 0.25, 0.66], // 21
  ['E6', 0.5, 0.74, 0.5], [null, 0.5],
  ['G#6', 0.25, 0.76], ['F#6', 0.25, 0.68], ['E6', 0.25, 0.72], ['D#6', 0.25, 0.68],
  ['E6', 0.5, 0.74, 0.6], [null, 0.5],
  ['B5', 0.25, 0.68], ['E6', 0.25, 0.72], ['B5', 0.25, 0.66], ['E6', 0.25, 0.72], // 22
  ['B5', 0.25, 0.66], ['E6', 0.25, 0.72], ['B5', 0.25, 0.66], ['G#5', 0.25, 0.68],
  ['A5', 0.5, 0.7], ['G#5', 0.5, 0.68], ['F#5', 0.5, 0.68], ['E5', 0.5, 0.66],
  ['D#5', 0.25, 0.66], ['E5', 0.25, 0.68], ['F#5', 0.25, 0.68], ['G#5', 0.25, 0.7], // 23
  ['A5', 0.25, 0.72], ['B5', 0.25, 0.74], ['C#6', 0.25, 0.74], ['D#6', 0.25, 0.76],
  ['E6', 1, 0.8], ['B5', 1, 0.7],
  ['F#5', 0.5, 0.72], ['A5', 0.5, 0.74], ['G#5', 0.5, 0.74], ['F#5', 0.5, 0.7], // 24
  ['E5', 1, 0.78], ['B4', 1, 0.7]
], 0.7, 0.85);

/** The brook: rippling semiquavers (bars 33-36). */
const SPRING_BROOK = [].concat(
  figure(128, ['E5', 'F#5', 'G#5', 'A5', 'B5', 'A5', 'G#5', 'F#5'], 0.25, 8, 0.62, 0.9),
  figure(130, ['E5', 'F#5', 'G#5', 'A5', 'B5', 'C#6', 'D#6', 'E6'], 0.25, 8, 0.66, 0.9),
  figure(132, ['D#6', 'C#6', 'B5', 'A5', 'G#5', 'F#5', 'E5', 'D#5'], 0.25, 8, 0.68, 0.9),
  figure(134, ['E5', 'G#5', 'B5', 'E6', 'D#6', 'B5', 'G#5', 'F#5'], 0.25, 8, 0.7, 0.9),
  figure(136, ['E5', 'F#5', 'G#5', 'A5', 'B5', 'A5', 'G#5', 'F#5'], 0.25, 8, 0.72, 0.9),
  figure(138, ['G#5', 'A5', 'B5', 'C#6', 'D#6', 'C#6', 'B5', 'A5'], 0.25, 8, 0.74, 0.9),
  line(140, [['B5', 0.25, 0.76], ['A5', 0.25, 0.72], ['G#5', 0.25, 0.74], ['F#5', 0.25, 0.72],
    ['E5', 0.25, 0.74], ['F#5', 0.25, 0.72], ['G#5', 0.25, 0.74], ['A5', 0.25, 0.74],
    ['B5', 1, 0.8], ['F#5', 1, 0.72]], 0.74, 0.9)
);

/** Ripieno strings doubling the ritornello an octave below. */
const SPRING_RIPIENO = [].concat(
  copyAt(SPRING_RIT, 0, -12, 0.68), copyAt(SPRING_RIT, 16, -12, 0.42),
  copyAt(SPRING_RIT2, 0, -12, 0.6), copyAt(SPRING_RIT2, 16, -12, 0.38),
  copyAt(SPRING_RIT, 96, -12, 0.75), copyAt(SPRING_RIT2, 80, -12, 0.7),
  copyAt(SPRING_RIT, 144, -12, 0.72)
);

/** Continuo bass, four crotchets per bar. */
const SPRING_BASS_TABLE = [
  ['E2', 'E2', 'E2', 'E2'], ['E2', 'E2', 'B2', 'B2'], ['E2', 'E2', 'E2', 'E2'], ['B2', 'B2', 'E2', 'E2'],
  ['E2', 'E2', 'E2', 'E2'], ['E2', 'E2', 'B2', 'B2'], ['E2', 'E2', 'E2', 'E2'], ['B2', 'B2', 'E2', 'E2'],
  ['E2', 'E2', 'B2', 'B2'], ['B2', 'B2', 'E2', 'E2'], ['E2', 'E2', 'B2', 'B2'], ['B2', 'B2', 'E2', 'E2'],
  ['E2', 'E2', 'B2', 'B2'], ['B2', 'B2', 'E2', 'E2'], ['E2', 'E2', 'B2', 'B2'], ['B2', 'B2', 'E2', 'E2'],
  ['E2', null, 'E2', null], ['E2', null, 'E2', null], ['E2', null, 'B2', null], ['E2', null, 'B2', null],
  ['E2', null, 'E2', null], ['A2', null, 'A2', null], ['B2', null, 'B2', null], ['E2', null, 'B2', null],
  ['E2', 'E2', 'E2', 'E2'], ['E2', 'E2', 'B2', 'B2'], ['E2', 'E2', 'E2', 'E2'], ['B2', 'B2', 'E2', 'E2'],
  ['E2', 'E2', 'B2', 'B2'], ['B2', 'B2', 'E2', 'E2'], ['E2', 'E2', 'B2', 'B2'], ['B2', 'B2', 'E2', 'E2'],
  ['E2', 'B2', 'E2', 'B2'], ['E2', 'B2', 'E2', 'B2'], ['A2', 'A2', 'B2', 'B2'], ['E2', 'E2', 'B2', 'B2'],
  ['E2', 'E2', 'E2', 'E2'], ['E2', 'E2', 'B2', 'B2'], ['E2', 'E2', 'E2', 'E2'], ['B2', 'B2', 'E2', 'E2']
];

/** Continuo chords for the harpsichord, two per bar. */
const SPRING_CONTINUO_TABLE = [
  [['G#3', 'B3', 'E4'], ['G#3', 'B3', 'E4']], [['G#3', 'B3', 'E4'], ['F#3', 'A3', 'D#4']],
  [['G#3', 'B3', 'E4'], ['G#3', 'B3', 'E4']], [['F#3', 'A3', 'D#4'], ['G#3', 'B3', 'E4']],
  [['G#3', 'B3', 'E4'], ['G#3', 'B3', 'E4']], [['G#3', 'B3', 'E4'], ['F#3', 'A3', 'D#4']],
  [['G#3', 'B3', 'E4'], ['G#3', 'B3', 'E4']], [['F#3', 'A3', 'D#4'], ['G#3', 'B3', 'E4']],
  [['G#3', 'B3', 'E4'], ['F#3', 'A3', 'D#4']], [['F#3', 'A3', 'D#4'], ['G#3', 'B3', 'E4']],
  [['G#3', 'B3', 'E4'], ['F#3', 'A3', 'D#4']], [['F#3', 'A3', 'D#4'], ['G#3', 'B3', 'E4']],
  [['G#3', 'B3', 'E4'], ['F#3', 'A3', 'D#4']], [['F#3', 'A3', 'D#4'], ['G#3', 'B3', 'E4']],
  [['G#3', 'B3', 'E4'], ['F#3', 'A3', 'D#4']], [['F#3', 'A3', 'D#4'], ['G#3', 'B3', 'E4']],
  [['G#3', 'B3', 'E4'], null], [['G#3', 'B3', 'E4'], null],
  [['F#3', 'A3', 'D#4'], null], [['F#3', 'A3', 'D#4'], null],
  [['G#3', 'B3', 'E4'], null], [['A3', 'C#4', 'E4'], null],
  [['F#3', 'A3', 'D#4'], null], [['G#3', 'B3', 'E4'], null],
  [['G#3', 'B3', 'E4'], ['G#3', 'B3', 'E4']], [['G#3', 'B3', 'E4'], ['F#3', 'A3', 'D#4']],
  [['G#3', 'B3', 'E4'], ['G#3', 'B3', 'E4']], [['F#3', 'A3', 'D#4'], ['G#3', 'B3', 'E4']],
  [['G#3', 'B3', 'E4'], ['F#3', 'A3', 'D#4']], [['F#3', 'A3', 'D#4'], ['G#3', 'B3', 'E4']],
  [['G#3', 'B3', 'E4'], ['F#3', 'A3', 'D#4']], [['F#3', 'A3', 'D#4'], ['G#3', 'B3', 'E4']],
  [['G#3', 'B3', 'E4'], ['G#3', 'B3', 'E4']], [['G#3', 'B3', 'E4'], ['G#3', 'B3', 'E4']],
  [['A3', 'C#4', 'E4'], ['F#3', 'A3', 'D#4']], [['G#3', 'B3', 'E4'], ['F#3', 'A3', 'D#4']],
  [['G#3', 'B3', 'E4'], ['G#3', 'B3', 'E4']], [['G#3', 'B3', 'E4'], ['F#3', 'A3', 'D#4']],
  [['G#3', 'B3', 'E4'], ['G#3', 'B3', 'E4']], [['F#3', 'A3', 'D#4'], ['G#3', 'B3', 'E4']]
];

/** @type {Object} Spring, first movement. */
const vivaldi_spring = {
  id: 'vivaldi_spring',
  title: 'The Four Seasons: Spring - I',
  titleKo: '사계 봄 1악장',
  composer: 'A. Vivaldi',
  year: 1725,
  tempo: 110,
  timeSig: [4, 4],
  key: 'E major',
  swing: 0,
  reverb: 0.45,
  station: 'baroque',
  loop: true,
  lengthBeats: 160,
  sections: [{ name: 'ritornello', startBeat: 0 }, { name: 'echo', startBeat: 16 },
    { name: 'ritornello 2', startBeat: 32 }, { name: 'birdsong', startBeat: 64 },
    { name: 'tutti', startBeat: 96 }, { name: 'brook', startBeat: 128 },
    { name: 'close', startBeat: 144 }],
  tracks: [
    track('violin', 0.9, -0.2, SPRING_RIT, copyAt(SPRING_RIT, 16, 0, 0.55), SPRING_RIT2,
      copyAt(SPRING_RIT2, 16, 0, 0.55), SPRING_BIRDS, copyAt(SPRING_RIT, 96, 0, 1.12),
      copyAt(SPRING_RIT2, 80, 0, 1.1), SPRING_BROOK, copyAt(SPRING_RIT, 144, 0, 1.08)),
    track('strings', 0.45, 0.25, SPRING_RIPIENO),
    track('harpsichord', 0.3, 0.4, grid(0, 4, SPRING_CONTINUO_TABLE, 0.3, 0.9)),
    track('cello', 0.5, -0.3, grid(0, 4, SPRING_BASS_TABLE, 0.42, 0.85)),
    track('bass', 0.45, 0.08, copyAt(grid(0, 4, SPRING_BASS_TABLE, 0.4, 0.8), 0, -12, 1))
  ]
};

/* -------------------------------------------------------------------------------------------
 * 9. Grieg - In the Hall of the Mountain King (Peer Gynt Suite No. 1)
 * B minor. One eight-bar theme, stated five times: first crawling in augmentation, then in
 * quavers, each statement adding octaves, brass and timpani until the trolls are running.
 * ----------------------------------------------------------------------------------------- */

/**
 * @type {Array<(string|Array|null)>} The theme, one entry per quaver slot (8 per bar).
 * An entry may be `[pitch, slots]` to hold a note across several slots.
 */
const KING_TOKENS = [
  'B3', 'C#4', 'D4', 'E4', 'F#4', 'D4', 'F#4', null, // 1
  'F4', 'D4', 'F4', 'E4', 'C#4', 'E4', 'C#4', null, // 2  the creeping chromatic answer
  'B3', 'C#4', 'D4', 'E4', 'F#4', 'D4', 'F#4', null, // 3
  'A4', 'F#4', 'A4', ['B4', 5], null, null, null, null, // 4
  'B3', 'C#4', 'D4', 'E4', 'F#4', 'D4', 'F#4', null, // 5
  'F4', 'D4', 'F4', 'E4', 'C#4', 'E4', 'C#4', null, // 6
  'B3', 'C#4', 'D4', 'E4', 'G4', 'E4', 'G4', null, // 7
  'F#4', 'D4', ['B3', 6], null, null, null, null, null // 8
];

/**
 * Renders a statement of the Mountain King theme.
 * @param {number} start Beat position.
 * @param {number} slot Beats per quaver slot (1 = augmented, 0.5 = at tempo).
 * @param {number} count Number of slots to render.
 * @param {number} semis Transposition in semitones.
 * @param {number} v0 Velocity at the start of the statement.
 * @param {number} v1 Velocity at the end of the statement.
 * @param {number} [hold=0.55] Staccato factor.
 * @returns {Array<Array<number>>} Note tuples.
 */
function kingStatement(start, slot, count, semis, v0, v1, hold = 0.55) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const tok = KING_TOKENS[i % KING_TOKENS.length];
    if (!tok) continue;
    const name = Array.isArray(tok) ? tok[0] : tok;
    const mult = Array.isArray(tok) ? tok[1] : 1;
    const t = i / count;
    const accent = (i % 8 === 0) ? 1.1 : 1;
    const vel = Math.max(0.02, Math.min(1, (v0 + (v1 - v0) * t) * accent));
    out.push([q(start + i * slot), m(name) + semis, q(slot * mult * hold), vel]);
  }
  return out;
}

/** Staccato drone pulses under the theme. */
function kingPulse(start, beats, step, pitches, v0, v1) {
  const count = Math.round(beats / step);
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = i / count;
    out.push([q(start + i * step), m(pitches[i % pitches.length]),
      q(step * 0.45), Math.max(0.02, Math.min(1, v0 + (v1 - v0) * t))]);
  }
  return out;
}

const KING_LOW = [].concat(
  kingStatement(0, 1, 32, -12, 0.22, 0.3), // augmented, barely audible
  kingStatement(32, 0.5, 64, -12, 0.34, 0.44),
  kingStatement(64, 0.5, 64, -12, 0.5, 0.58),
  kingStatement(96, 0.5, 64, -12, 0.66, 0.76),
  kingStatement(128, 0.5, 64, -12, 0.84, 1)
);

const KING_BASS = [].concat(
  kingStatement(0, 1, 32, -24, 0.18, 0.26),
  kingPulse(32, 32, 1, ['B1', 'F#2', 'B1', 'F#2'], 0.3, 0.4),
  kingStatement(64, 0.5, 64, -24, 0.46, 0.54),
  kingPulse(96, 32, 0.5, ['B1', 'B1', 'F#2', 'F#2'], 0.6, 0.7),
  kingStatement(128, 0.5, 64, -24, 0.8, 0.96)
);

const KING_PIZZ = [].concat(
  kingPulse(0, 32, 2, ['B3', 'F#3'], 0.16, 0.22),
  kingPulse(32, 32, 1, ['B3', 'D4', 'F#3', 'D4'], 0.26, 0.34),
  kingPulse(64, 32, 0.5, ['B3', 'D4', 'F#4', 'D4'], 0.4, 0.5),
  kingPulse(96, 32, 0.5, ['B3', 'D4', 'F#4', 'D4'], 0.55, 0.66),
  kingPulse(128, 32, 0.25, ['B3', 'D4', 'F#4', 'B4'], 0.6, 0.8)
);

const KING_STRINGS = [].concat(
  kingStatement(64, 0.5, 64, 0, 0.44, 0.54),
  kingStatement(96, 0.5, 64, 0, 0.6, 0.72),
  kingStatement(128, 0.5, 64, 0, 0.8, 0.96)
);

const KING_VIOLIN = [].concat(
  kingStatement(96, 0.5, 64, 12, 0.58, 0.72),
  kingStatement(128, 0.5, 64, 12, 0.82, 1)
);

const KING_HORN = [].concat(
  kingPulse(96, 32, 2, ['B2', 'F#3'], 0.5, 0.62),
  kingStatement(128, 0.5, 64, -12, 0.7, 0.9, 0.5)
);

const KING_TIMP = [].concat(
  kingPulse(64, 32, 2, ['B1'], 0.3, 0.42),
  kingPulse(96, 32, 1, ['B1', 'F#2'], 0.45, 0.62),
  kingPulse(128, 28, 0.5, ['B1', 'B1', 'F#2', 'B1'], 0.6, 0.9),
  line(156, [['B1', 0.5, 0.9, 0.6], ['B1', 0.5, 0.92, 0.6], ['B1', 0.5, 0.94, 0.6],
    ['B1', 0.5, 0.96, 0.6], ['B1', 0.5, 0.98, 0.6], ['B1', 0.5, 1, 0.6],
    ['F#2', 0.5, 1, 0.6], ['B1', 0.5, 1, 0.8]], 0.95, 0.6)
);

/** @type {Object} In the Hall of the Mountain King. */
const grieg_mountain_king = {
  id: 'grieg_mountain_king',
  title: 'In the Hall of the Mountain King',
  titleKo: '산왕의 궁전에서',
  composer: 'E. Grieg',
  year: 1875,
  tempo: 120,
  timeSig: [4, 4],
  key: 'B minor',
  swing: 0,
  reverb: 0.48,
  station: 'action',
  loop: true,
  lengthBeats: 160,
  sections: [{ name: 'creeping', startBeat: 0 }, { name: 'statement 2', startBeat: 32 },
    { name: 'statement 3', startBeat: 64 }, { name: 'statement 4', startBeat: 96 },
    { name: 'finale', startBeat: 128 }],
  tracks: [
    track('cello', 0.7, -0.25, KING_LOW),
    track('bass', 0.6, 0.1, KING_BASS),
    track('pizzicato', 0.45, 0.3, KING_PIZZ),
    track('strings', 0.6, -0.35, KING_STRINGS),
    track('violin', 0.72, 0.22, KING_VIOLIN),
    track('horn', 0.5, 0.4, KING_HORN),
    track('timpani', 0.6, 0, KING_TIMP)
  ]
};

/* -------------------------------------------------------------------------------------------
 * 10. Offenbach - Infernal Galop ("Can-Can") from Orphee aux enfers
 * D major, 2/4 presto. Trumpet fanfare, then the galop over a relentless oom-pah.
 * ----------------------------------------------------------------------------------------- */

/** Fanfare (bars 1-4). */
const CANCAN_FANFARE = line(0, [
  ['D5', 0.5, 0.86], ['F#5', 0.5, 0.86], ['A5', 0.5, 0.9], ['D6', 0.5, 0.94],
  ['A5', 1, 0.9], ['F#5', 1, 0.86],
  ['D6', 0.5, 0.94], ['C#6', 0.5, 0.9], ['B5', 0.5, 0.9], ['A5', 0.5, 0.88],
  ['G5', 0.5, 0.88], ['E5', 0.5, 0.86], ['A5', 1, 0.92]
], 0.9, 0.8);

/** The galop theme (bars 5-12). */
const CANCAN_A = line(8, [
  ['A5', 0.5, 0.82], ['F#5', 0.5, 0.74], ['A5', 0.5, 0.8], ['F#5', 0.5, 0.74], // 5
  ['A5', 0.5, 0.82], ['F#5', 0.5, 0.74], ['D5', 1, 0.86], // 6
  ['G5', 0.5, 0.8], ['E5', 0.5, 0.74], ['G5', 0.5, 0.8], ['E5', 0.5, 0.74], // 7
  ['G5', 0.5, 0.8], ['E5', 0.5, 0.74], ['C#5', 1, 0.84], // 8
  ['A5', 0.5, 0.84], ['F#5', 0.5, 0.76], ['A5', 0.5, 0.82], ['F#5', 0.5, 0.76], // 9
  ['A5', 0.5, 0.84], ['F#5', 0.5, 0.76], ['D6', 1, 0.9], // 10
  ['C#6', 0.5, 0.86], ['A5', 0.5, 0.78], ['B5', 0.5, 0.82], ['G5', 0.5, 0.78], // 11
  ['A5', 0.5, 0.84], ['F#5', 0.5, 0.78], ['D5', 1, 0.9] // 12
], 0.8, 0.7);

/** The kicking second strain (bars 21-28). */
const CANCAN_B = line(40, [
  ['D6', 0.25, 0.86], ['C#6', 0.25, 0.78], ['B5', 0.25, 0.8], ['A5', 0.25, 0.78], // 21
  ['G5', 0.25, 0.8], ['F#5', 0.25, 0.76], ['E5', 0.25, 0.78], ['D5', 0.25, 0.76],
  ['A5', 0.5, 0.84], ['A5', 0.5, 0.78], ['A5', 1, 0.86], // 22
  ['D6', 0.25, 0.86], ['C#6', 0.25, 0.78], ['B5', 0.25, 0.8], ['A5', 0.25, 0.78], // 23
  ['G5', 0.25, 0.8], ['F#5', 0.25, 0.76], ['E5', 0.25, 0.78], ['C#5', 0.25, 0.76],
  ['E5', 0.5, 0.82], ['A5', 0.5, 0.84], ['A5', 1, 0.88], // 24
  ['D5', 0.5, 0.86], ['D6', 0.5, 0.9], ['D5', 0.5, 0.84], ['D6', 0.5, 0.9], // 25
  ['B5', 0.5, 0.84], ['G5', 0.5, 0.8], ['E5', 1, 0.84], // 26
  ['A5', 0.5, 0.86], ['C#6', 0.5, 0.88], ['E6', 0.5, 0.92], ['C#6', 0.5, 0.86], // 27
  ['D6', 1, 0.94], ['A5', 1, 0.86] // 28
], 0.84, 0.72);

/** Whirling coda (bars 53-68). */
const CANCAN_CODA = [].concat(
  figure(104, ['D5', 'F#5', 'A5', 'D6', 'A5', 'F#5', 'A5', 'D6'], 0.25, 16, 0.84, 0.85),
  figure(108, ['C#5', 'E5', 'A5', 'C#6', 'A5', 'E5', 'A5', 'C#6'], 0.25, 16, 0.86, 0.85),
  copyAt(CANCAN_A, 104, 0, 1.05),
  figure(128, ['D6', 'C#6', 'B5', 'A5', 'G5', 'F#5', 'E5', 'D5'], 0.25, 16, 0.88, 0.85),
  figure(132, ['A5', 'B5', 'C#6', 'D6', 'E6', 'D6', 'C#6', 'B5'], 0.25, 16, 0.9, 0.85)
);

/** The final strain and the closing chords (bars 69-80). */
const CANCAN_FINALE = line(136, [
  ['A5', 0.5, 0.9], ['A5', 0.5, 0.84], ['A5', 0.5, 0.88], ['A5', 0.5, 0.84], // 69
  ['A5', 0.5, 0.9], ['A5', 0.5, 0.84], ['D6', 1, 0.94], // 70
  ['A5', 0.5, 0.9], ['A5', 0.5, 0.84], ['A5', 0.5, 0.88], ['A5', 0.5, 0.84], // 71
  ['A5', 0.5, 0.9], ['A5', 0.5, 0.84], ['D6', 1, 0.94], // 72
  ['D6', 0.25, 0.92], ['C#6', 0.25, 0.84], ['B5', 0.25, 0.86], ['A5', 0.25, 0.84], // 73
  ['G5', 0.25, 0.86], ['F#5', 0.25, 0.82], ['E5', 0.25, 0.84], ['D5', 0.25, 0.82],
  ['A5', 0.5, 0.9], ['F#5', 0.5, 0.84], ['D5', 1, 0.92], // 74
  ['E5', 0.5, 0.86], ['G5', 0.5, 0.86], ['B5', 0.5, 0.9], ['G5', 0.5, 0.86], // 75
  ['A5', 0.5, 0.9], ['C#6', 0.5, 0.92], ['E6', 1, 0.96], // 76
  ['D6', 0.5, 0.96], ['A5', 0.5, 0.88], ['F#5', 0.5, 0.88], ['D5', 0.5, 0.86], // 77
  ['D6', 0.5, 0.96], ['A5', 0.5, 0.88], ['F#5', 0.5, 0.88], ['D5', 0.5, 0.86], // 78
  ['A5', 0.5, 0.94], ['A5', 0.5, 0.9], ['A5', 0.5, 0.94], ['A5', 0.5, 0.9], // 79
  ['D6', 1, 1], ['D5', 1, 0.96] // 80
], 0.9, 0.72);

/** @type {Object<string, Array>} Chord voicings used by the galop accompaniment. */
const CANCAN_VOICES = {
  D: ['D2', ['F#3', 'A3', 'D4'], 'A2'],
  A7: ['A2', ['C#4', 'E4', 'G4'], 'E3'],
  G: ['G2', ['B3', 'D4', 'G4'], 'D3'],
  Bm: ['B2', ['D4', 'F#4', 'B4'], 'F#3']
};

/** @type {Array<string>} One chord symbol per bar, eighty bars of galop. */
const CANCAN_PROG = [].concat(
  ['D', 'D', 'A7', 'D'],
  ['D', 'D', 'A7', 'A7', 'D', 'D', 'A7', 'D'],
  ['D', 'D', 'A7', 'A7', 'D', 'D', 'A7', 'D'],
  ['D', 'D', 'A7', 'A7', 'G', 'G', 'A7', 'D'],
  ['D', 'D', 'A7', 'A7', 'G', 'G', 'A7', 'D'],
  ['D', 'D', 'A7', 'A7', 'D', 'D', 'A7', 'D'],
  ['D', 'D', 'A7', 'A7', 'D', 'D', 'A7', 'D'],
  ['D', 'D', 'A7', 'A7', 'D', 'D', 'A7', 'D'],
  ['G', 'G', 'D', 'D', 'A7', 'A7', 'D', 'D'],
  ['D', 'A7', 'D', 'A7', 'D', 'D', 'A7', 'A7'],
  ['D', 'D', 'A7', 'D']
);

/**
 * Builds the oom-pah accompaniment: bass on the beats, chords on the off-beats.
 * @param {Array<string>} prog Chord symbol per bar.
 * Each voice stays monophonic; the chord is spread over the strings, horn and cello tracks.
 * @returns {{bass: Array<Array<number>>, off: Array<Array<number>>, mid: Array<Array<number>>,
 *   inner: Array<Array<number>>, drum: Array<Array<number>>}} Voices.
 */
function buildCancan(prog) {
  const bass = [];
  const off = [];
  const mid = [];
  const inner = [];
  const drum = [];
  for (let b = 0; b < prog.length; b++) {
    const v = CANCAN_VOICES[prog[b]];
    const t = b * 2;
    const loud = b >= 52 ? 0.62 : (b >= 20 ? 0.55 : 0.5);
    bass.push([q(t), m(v[0]), 0.4, loud], [q(t + 1), m(v[2]), 0.4, loud * 0.86]);
    off.push([q(t + 0.5), m(v[1][2]), 0.36, loud * 0.6], [q(t + 1.5), m(v[1][2]), 0.36, loud * 0.55]);
    mid.push([q(t + 0.5), m(v[1][1]), 0.36, loud * 0.55], [q(t + 1.5), m(v[1][1]), 0.36, loud * 0.5]);
    inner.push([q(t + 0.5), m(v[1][0]) - 12, 0.36, loud * 0.5],
      [q(t + 1.5), m(v[1][0]) - 12, 0.36, loud * 0.46]);
    drum.push([q(t), m(prog[b] === 'A7' ? 'A1' : 'D2'), 0.3, loud * 0.8]);
    if (b >= 52) drum.push([q(t + 1), m('A1'), 0.3, loud * 0.6]);
  }
  return { bass, off, mid, inner, drum };
}

const CANCAN_ACC = buildCancan(CANCAN_PROG);

/** @type {Object} Infernal Galop. */
const offenbach_cancan = {
  id: 'offenbach_cancan',
  title: 'Infernal Galop (Can-Can)',
  titleKo: '천국과 지옥 서곡 (캉캉)',
  composer: 'J. Offenbach',
  year: 1858,
  tempo: 136,
  timeSig: [2, 4],
  key: 'D major',
  swing: 0,
  reverb: 0.36,
  station: 'action',
  loop: true,
  lengthBeats: 160,
  sections: [{ name: 'fanfare', startBeat: 0 }, { name: 'galop', startBeat: 8 },
    { name: 'second strain', startBeat: 40 }, { name: 'reprise', startBeat: 72 },
    { name: 'coda', startBeat: 104 }, { name: 'finale', startBeat: 136 }],
  tracks: [
    track('trumpet', 0.82, -0.15, CANCAN_FANFARE, CANCAN_A, copyAt(CANCAN_A, 16, 0, 0.95),
      CANCAN_B, copyAt(CANCAN_B, 16, 0, 1), copyAt(CANCAN_A, 64, 0, 1.02),
      copyAt(CANCAN_A, 80, 0, 1.05), CANCAN_CODA, CANCAN_FINALE),
    track('violin', 0.55, 0.2, copyAt(CANCAN_A, 0, -12, 0.75), copyAt(CANCAN_A, 16, -12, 0.72),
      copyAt(CANCAN_B, 0, -12, 0.78), copyAt(CANCAN_B, 16, -12, 0.78),
      copyAt(CANCAN_A, 64, -12, 0.8), copyAt(CANCAN_A, 80, -12, 0.82),
      copyAt(CANCAN_CODA, 0, -12, 0.8), copyAt(CANCAN_FINALE, 0, -12, 0.85)),
    track('strings', 0.5, 0.32, CANCAN_ACC.off),
    track('horn', 0.4, 0.42, CANCAN_ACC.mid),
    track('cello', 0.42, -0.32, CANCAN_ACC.inner),
    track('bass', 0.62, 0.05, CANCAN_ACC.bass),
    track('timpani', 0.5, 0, CANCAN_ACC.drum)
  ]
};

/* -------------------------------------------------------------------------------------------
 * 11. Chopin - Nocturne in Eb major, Op. 9 No. 2
 * 12/8 read as four dotted-quarter beats per bar. Bel canto melody over the wide-spaced left
 * hand: bass note then two chords in every beat.
 * ----------------------------------------------------------------------------------------- */

/** Melody, bars 1-8 (theme and its ornamented repeat). */
const NOCTURNE_A = line(0, [
  ['Bb4', 1, 0.46], ['Eb5', 0.667, 0.5], ['D5', 0.333, 0.44], // 1
  ['Eb5', 0.667, 0.5], ['F5', 0.333, 0.46], ['G5', 1, 0.54],
  ['F5', 1.5, 0.5], ['Eb5', 0.5, 0.44], ['D5', 0.667, 0.46], ['Eb5', 0.333, 0.44], ['F5', 1, 0.48], // 2
  ['G5', 1, 0.54], ['Ab5', 0.667, 0.56], ['G5', 0.333, 0.5], ['F5', 1, 0.5], ['Eb5', 1, 0.46], // 3
  ['D5', 2, 0.44], ['Bb4', 2, 0.4], // 4
  ['Bb4', 1, 0.48], ['Eb5', 0.667, 0.52], ['D5', 0.333, 0.46], // 5
  ['Eb5', 0.5, 0.52], ['F5', 0.25, 0.46], ['G5', 0.25, 0.48], ['Ab5', 1, 0.58],
  ['G5', 1, 0.56], ['F5', 0.667, 0.5], ['Eb5', 0.333, 0.46], ['D5', 1, 0.48], ['F5', 1, 0.5], // 6
  ['Eb5', 1, 0.52], ['G5', 0.667, 0.54], ['F5', 0.333, 0.48], // 7
  ['Eb5', 0.667, 0.5], ['D5', 0.333, 0.46], ['C5', 1, 0.46],
  ['Bb4', 2.5, 0.44], ['Bb4', 1.5, 0.4] // 8
], 0.5, 0.94);

/** Melody, bars 9-16: the second strain with the chromatic descent. */
const NOCTURNE_B = line(32, [
  ['F5', 1, 0.52], ['Bb5', 0.667, 0.6], ['Ab5', 0.333, 0.52], // 9
  ['G5', 0.667, 0.54], ['F5', 0.333, 0.48], ['Eb5', 1, 0.5],
  ['F5', 1.5, 0.54], ['G5', 0.5, 0.5], ['Ab5', 1, 0.58], ['F5', 1, 0.5], // 10
  ['Eb5', 1, 0.5], ['Db5', 0.667, 0.52], ['C5', 0.333, 0.46], ['Db5', 1, 0.52], ['F5', 1, 0.54], // 11
  ['Eb5', 2, 0.5], ['Bb4', 2, 0.42], // 12
  ['F5', 1, 0.54], ['Bb5', 0.667, 0.62], ['Ab5', 0.333, 0.54], // 13
  ['G5', 0.667, 0.56], ['F5', 0.333, 0.5], ['Eb5', 1, 0.52],
  ['Ab5', 1, 0.62], ['G5', 0.5, 0.56], ['F5', 0.5, 0.52], ['Eb5', 1, 0.54], ['C5', 1, 0.48], // 14
  ['Bb5', 0.25, 0.6], ['A5', 0.25, 0.54], ['Ab5', 0.25, 0.56], ['G5', 0.25, 0.54], // 15
  ['Gb5', 0.25, 0.52], ['F5', 0.25, 0.52], ['E5', 0.25, 0.5], ['Eb5', 0.25, 0.52],
  ['D5', 1, 0.5], ['F5', 1, 0.52],
  ['Eb5', 2.5, 0.5], ['Bb4', 1.5, 0.4] // 16
], 0.52, 0.94);

/** Coda: the cadenza-like flourish and the final plagal cadence. */
const NOCTURNE_CODA = [].concat(
  line(96, [
    ['Bb4', 1, 0.46], ['Eb5', 0.667, 0.5], ['D5', 0.333, 0.44], // 25
    ['Eb5', 0.667, 0.5], ['F5', 0.333, 0.46], ['G5', 1, 0.54],
    ['F5', 1.5, 0.5], ['Eb5', 0.5, 0.44], ['D5', 0.667, 0.46], ['Eb5', 0.333, 0.44], ['F5', 1, 0.48], // 26
    ['G5', 1, 0.56], ['Ab5', 0.667, 0.58], ['G5', 0.333, 0.52], ['F5', 1, 0.52], ['Eb5', 1, 0.48], // 27
    ['D5', 2, 0.46], ['Bb4', 2, 0.42] // 28
  ], 0.5, 0.94),
  // bar 29: senza tempo flourish over the dominant
  figure(112, ['Bb4', 'C5', 'D5', 'Eb5', 'F5', 'G5', 'Ab5', 'Bb5'], 0.1667, 12, 0.46, 0.9),
  figure(114, ['C6', 'Bb5', 'Ab5', 'G5', 'F5', 'Eb5', 'D5', 'C5'], 0.1667, 12, 0.5, 0.9),
  line(116, [['Bb5', 1.5, 0.52], ['Ab5', 0.5, 0.46], ['G5', 1, 0.5], ['F5', 1, 0.46], // 30
    ['Eb5', 1.5, 0.48], ['D5', 0.5, 0.42], ['Eb5', 2, 0.46], // 31
    ['Bb4', 2, 0.4], ['Eb5', 2, 0.36] // 32
  ], 0.46, 0.95)
);

/** @type {Object<string, Array>} Left-hand voicings: [bass, chord]. */
const NOCTURNE_VOICES = {
  Eb: ['Eb2', ['Bb2', 'Eb3', 'G3']],
  Bb7: ['Bb1', ['Ab2', 'D3', 'F3']],
  Ab: ['Ab1', ['Ab2', 'C3', 'Eb3']],
  Fm: ['F2', ['Ab2', 'C3', 'F3']],
  Eb7: ['Eb2', ['Bb2', 'Db3', 'G3']],
  Cm: ['C2', ['Eb2', 'G2', 'C3']]
};

/** @type {Array<Array<string>>} Four chords per bar, thirty-two bars. */
const NOCTURNE_PROG = [
  ['Eb', 'Eb', 'Eb', 'Eb'], ['Bb7', 'Bb7', 'Eb', 'Eb'], ['Eb', 'Ab', 'Eb', 'Bb7'], ['Bb7', 'Bb7', 'Eb', 'Eb'],
  ['Eb', 'Eb', 'Eb', 'Eb'], ['Bb7', 'Bb7', 'Eb', 'Bb7'], ['Eb', 'Eb', 'Fm', 'Bb7'], ['Bb7', 'Bb7', 'Eb', 'Eb'],
  ['Bb7', 'Bb7', 'Eb', 'Eb'], ['Bb7', 'Bb7', 'Ab', 'Fm'], ['Eb', 'Eb7', 'Ab', 'Bb7'], ['Bb7', 'Bb7', 'Eb', 'Eb'],
  ['Bb7', 'Bb7', 'Eb', 'Eb'], ['Ab', 'Ab', 'Eb', 'Cm'], ['Eb7', 'Eb7', 'Ab', 'Bb7'], ['Bb7', 'Bb7', 'Eb', 'Eb'],
  ['Eb', 'Eb', 'Eb', 'Eb'], ['Bb7', 'Bb7', 'Eb', 'Eb'], ['Eb', 'Ab', 'Eb', 'Bb7'], ['Bb7', 'Bb7', 'Eb', 'Eb'],
  ['Eb', 'Eb', 'Eb', 'Eb'], ['Bb7', 'Bb7', 'Eb', 'Bb7'], ['Eb', 'Eb', 'Fm', 'Bb7'], ['Bb7', 'Bb7', 'Eb', 'Eb'],
  ['Eb', 'Eb', 'Eb', 'Eb'], ['Bb7', 'Bb7', 'Eb', 'Eb'], ['Eb', 'Ab', 'Eb', 'Bb7'], ['Bb7', 'Bb7', 'Eb', 'Eb'],
  ['Bb7', 'Bb7', 'Bb7', 'Bb7'], ['Bb7', 'Bb7', 'Eb', 'Eb'], ['Ab', 'Ab', 'Eb', 'Eb'], ['Eb', 'Eb', 'Eb', 'Eb']
];

/**
 * Builds the nocturne accompaniment: bass note then two chords inside every beat.
 * @param {Array<Array<string>>} prog Four chord symbols per bar.
 * @returns {{lh: Array<Array<number>>, pad: Array<Array<number>>}} Left hand and the soft pad.
 */
function buildNocturne(prog) {
  const lh = [];
  const pad = [];
  for (let b = 0; b < prog.length; b++) {
    for (let beat = 0; beat < 4; beat++) {
      const v = NOCTURNE_VOICES[prog[b][beat]];
      const t = b * 4 + beat;
      lh.push([q(t), m(v[0]), 0.32, 0.4]);
      for (let i = 0; i < v[1].length; i++) {
        lh.push([q(t + 1 / 3), m(v[1][i]), 0.3, 0.26], [q(t + 2 / 3), m(v[1][i]), 0.3, 0.24]);
      }
    }
    const first = NOCTURNE_VOICES[prog[b][0]];
    pad.push([q(b * 4), m(first[0]) + 12, 3.8, 0.18]);
  }
  return { lh, pad };
}

const NOCTURNE_ACC = buildNocturne(NOCTURNE_PROG);

/** @type {Object} Nocturne Op. 9 No. 2. */
const chopin_nocturne = {
  id: 'chopin_nocturne',
  title: 'Nocturne in Eb major, Op. 9 No. 2',
  titleKo: '녹턴 Op.9 No.2',
  composer: 'F. Chopin',
  year: 1832,
  tempo: 66,
  timeSig: [12, 8],
  key: 'Eb major',
  swing: 0,
  reverb: 0.55,
  station: 'romantic',
  loop: true,
  lengthBeats: 128,
  sections: [{ name: 'A', startBeat: 0 }, { name: 'B', startBeat: 32 },
    { name: 'A return', startBeat: 64 }, { name: 'coda', startBeat: 96 }],
  tracks: [
    track('piano', 0.88, -0.1, NOCTURNE_A, NOCTURNE_B, copyAt(NOCTURNE_A, 64, 0, 1.05),
      NOCTURNE_CODA),
    track('piano', 0.62, 0.12, NOCTURNE_ACC.lh),
    track('strings', 0.14, 0.3, NOCTURNE_ACC.pad)
  ]
};

/* -------------------------------------------------------------------------------------------
 * 12. Tchaikovsky - Dance of the Sugar Plum Fairy (The Nutcracker)
 * E minor, 2/4. Staccato celesta over pizzicato strings, carried by the chromatic descending
 * bass E - D# - D - C# and answered by the bass clarinet.
 * ----------------------------------------------------------------------------------------- */

/** Celesta theme (bars 3-10). */
const PLUM_A = line(4, [
  ['B4', 0.25, 0.52, 0.5], ['E5', 0.25, 0.56, 0.5], ['G5', 0.25, 0.58, 0.5], ['B5', 0.25, 0.62, 0.5], // 3
  ['B5', 0.5, 0.64, 0.45], ['G5', 0.5, 0.56, 0.45],
  ['A4', 0.25, 0.52, 0.5], ['D#5', 0.25, 0.56, 0.5], ['F#5', 0.25, 0.58, 0.5], ['A5', 0.25, 0.6, 0.5], // 4
  ['A5', 0.5, 0.62, 0.45], ['F#5', 0.5, 0.54, 0.45],
  ['G4', 0.25, 0.5, 0.5], ['B4', 0.25, 0.54, 0.5], ['E5', 0.25, 0.56, 0.5], ['G5', 0.25, 0.58, 0.5], // 5
  ['G5', 0.5, 0.6, 0.45], ['E5', 0.5, 0.52, 0.45],
  ['C#5', 0.25, 0.5, 0.5], ['E5', 0.25, 0.54, 0.5], ['G5', 0.25, 0.56, 0.5], ['A5', 0.25, 0.6, 0.5], // 6
  ['A5', 0.5, 0.6, 0.45], ['G5', 0.5, 0.54, 0.45],
  ['C5', 0.25, 0.54, 0.5], ['E5', 0.25, 0.56, 0.5], ['G5', 0.25, 0.6, 0.5], ['C6', 0.25, 0.64, 0.5], // 7
  ['B5', 0.5, 0.62, 0.45], ['G5', 0.5, 0.56, 0.45],
  ['F#5', 0.25, 0.56, 0.5], ['D#5', 0.25, 0.54, 0.5], ['B4', 0.25, 0.52, 0.5], ['D#5', 0.25, 0.56, 0.5], // 8
  ['F#5', 0.5, 0.6, 0.45], ['A5', 0.5, 0.62, 0.45],
  ['E5', 0.25, 0.6, 0.5], ['G5', 0.25, 0.62, 0.5], ['B5', 0.25, 0.66, 0.5], ['E6', 0.25, 0.7, 0.5], // 9
  ['B5', 0.5, 0.64, 0.45], ['G5', 0.5, 0.56, 0.45],
  ['F#5', 0.5, 0.56, 0.5], ['D#5', 0.5, 0.54, 0.5], ['E5', 1, 0.6, 0.6] // 10
], 0.58, 0.5);

/** Contrasting strain in G major (bars 19-26). */
const PLUM_B = line(36, [
  ['G5', 0.25, 0.56, 0.5], ['A5', 0.25, 0.56, 0.5], ['B5', 0.25, 0.6, 0.5], ['C6', 0.25, 0.62, 0.5], // 19
  ['D6', 0.5, 0.66, 0.5], ['B5', 0.5, 0.58, 0.5],
  ['C6', 0.25, 0.6, 0.5], ['B5', 0.25, 0.58, 0.5], ['A5', 0.25, 0.56, 0.5], ['G5', 0.25, 0.56, 0.5], // 20
  ['F#5', 0.5, 0.58, 0.5], ['D5', 0.5, 0.52, 0.5],
  ['E5', 0.25, 0.54, 0.5], ['F#5', 0.25, 0.56, 0.5], ['G5', 0.25, 0.58, 0.5], ['A5', 0.25, 0.6, 0.5], // 21
  ['B5', 0.5, 0.64, 0.5], ['G5', 0.5, 0.56, 0.5],
  ['A5', 0.5, 0.6, 0.5], ['F#5', 0.5, 0.56, 0.5], ['D5', 1, 0.58, 0.6], // 22
  ['B5', 0.25, 0.62, 0.5], ['C6', 0.25, 0.62, 0.5], ['B5', 0.25, 0.6, 0.5], ['A5', 0.25, 0.58, 0.5], // 23
  ['G5', 0.5, 0.6, 0.5], ['E5', 0.5, 0.54, 0.5],
  ['A5', 0.25, 0.58, 0.5], ['G5', 0.25, 0.56, 0.5], ['F#5', 0.25, 0.56, 0.5], ['E5', 0.25, 0.54, 0.5], // 24
  ['D#5', 0.5, 0.56, 0.5], ['B4', 0.5, 0.5, 0.5],
  ['E5', 0.25, 0.56, 0.5], ['G5', 0.25, 0.58, 0.5], ['B5', 0.25, 0.62, 0.5], ['G5', 0.25, 0.58, 0.5], // 25
  ['F#5', 0.5, 0.58, 0.5], ['A5', 0.5, 0.6, 0.5],
  ['G5', 0.5, 0.58, 0.5], ['F#5', 0.5, 0.56, 0.5], ['E5', 1, 0.6, 0.6] // 26
], 0.58, 0.5);

/** Cascading strain (bars 35-42). */
const PLUM_C = [].concat(
  figure(68, ['B5', 'A5', 'G5', 'F#5', 'E5', 'D5', 'C5', 'B4'], 0.25, 8, 0.56, 0.5),
  figure(70, ['A5', 'G5', 'F#5', 'D#5', 'B4', 'D#5', 'F#5', 'A5'], 0.25, 8, 0.58, 0.5),
  figure(72, ['G5', 'F#5', 'E5', 'D5', 'B4', 'D5', 'E5', 'G5'], 0.25, 8, 0.58, 0.5),
  figure(74, ['A5', 'G5', 'E5', 'C#5', 'A4', 'C#5', 'E5', 'G5'], 0.25, 8, 0.6, 0.5),
  figure(76, ['C6', 'B5', 'A5', 'G5', 'E5', 'G5', 'A5', 'C6'], 0.25, 8, 0.62, 0.5),
  figure(78, ['B5', 'A5', 'F#5', 'D#5', 'B4', 'D#5', 'F#5', 'A5'], 0.25, 8, 0.62, 0.5),
  figure(80, ['E6', 'D5', 'B5', 'G5', 'E5', 'G5', 'B5', 'E6'], 0.25, 8, 0.66, 0.5),
  line(82, [['F#5', 0.5, 0.6, 0.5], ['D#5', 0.5, 0.58, 0.5], ['E5', 1, 0.64, 0.6]], 0.6, 0.5)
);

/** Coda (bars 51-64): the theme once more, the falling celesta cascade and the last chords. */
const PLUM_CODA = [].concat(
  copyAt(PLUM_A, 96, 0, 1.05),
  figure(116, ['E6', 'D6', 'C6', 'B5', 'A5', 'G5', 'F#5', 'E5'], 0.25, 8, 0.66, 0.5),
  figure(118, ['D5', 'C5', 'B4', 'A4', 'G4', 'F#4', 'E4', 'B4'], 0.25, 8, 0.6, 0.5),
  line(120, [['E5', 0.25, 0.62, 0.5], ['G5', 0.25, 0.64, 0.5], ['B5', 0.25, 0.66, 0.5],
    ['E6', 0.25, 0.72, 0.5], ['B5', 0.5, 0.64, 0.5], ['G5', 0.5, 0.58, 0.5],
    ['F#5', 0.5, 0.58, 0.5], ['D#5', 0.5, 0.56, 0.5], ['E5', 1, 0.66, 0.6],
    [null, 2],
    ['E5', 0.5, 0.6, 0.4], ['B4', 0.5, 0.56, 0.4], ['E4', 1, 0.62, 0.6]], 0.6, 0.5)
);

/** @type {Object<string, Array>} Bass note and the two pizzicato answers per bar. */
const PLUM_VOICES = {
  Em: ['E2', 'E3', 'B3'],
  B7D: ['D#2', 'F#3', 'B3'],
  EmD: ['D2', 'G3', 'B3'],
  A7C: ['C#2', 'E3', 'G3'],
  C: ['C2', 'E3', 'G3'],
  B7: ['B1', 'F#3', 'A3'],
  G: ['G2', 'B3', 'D4'],
  D7: ['D2', 'F#3', 'C4'],
  Am: ['A2', 'E3', 'A3']
};

/** @type {Array<string>} One harmony per bar, sixty-four bars. */
const PLUM_PROG = [].concat(
  ['Em', 'Em'],
  ['Em', 'B7D', 'EmD', 'A7C', 'C', 'B7', 'Em', 'B7'],
  ['Em', 'B7D', 'EmD', 'A7C', 'C', 'B7', 'Em', 'B7'],
  ['G', 'D7', 'G', 'D7', 'C', 'A7C', 'B7', 'Em'],
  ['Em', 'B7D', 'EmD', 'A7C', 'C', 'B7', 'Em', 'B7'],
  ['Em', 'B7D', 'EmD', 'A7C', 'C', 'B7', 'Em', 'B7'],
  ['Em', 'B7D', 'EmD', 'A7C', 'C', 'B7', 'Em', 'B7'],
  ['Em', 'B7D', 'EmD', 'A7C', 'C', 'B7', 'Em', 'Em', 'Am', 'B7', 'Em', 'B7', 'Em', 'Em']
);

/**
 * Builds the pizzicato accompaniment, the walking bass and the bass-clarinet counter-line.
 * @param {Array<string>} prog Harmony per bar.
 * @returns {{pizz: Array<Array<number>>, bass: Array<Array<number>>, reed: Array<Array<number>>}} Voices.
 */
function buildSugarPlum(prog) {
  const pizz = [];
  const bass = [];
  const reed = [];
  for (let b = 0; b < prog.length; b++) {
    const v = PLUM_VOICES[prog[b]];
    const t = b * 2;
    pizz.push([q(t), m(v[1]), 0.3, 0.38], [q(t + 1), m(v[2]), 0.3, 0.34]);
    pizz.push([q(t + 0.5), m(v[2]), 0.24, 0.22], [q(t + 1.5), m(v[1]), 0.24, 0.2]);
    bass.push([q(t), m(v[0]), 0.5, 0.44], [q(t + 1), m(v[0]) + 12, 0.4, 0.32]);
    // the bass clarinet answers at the end of each four-bar group
    if (b % 4 === 3) {
      reed.push([q(t), m(v[1]) - 12, 0.45, 0.3], [q(t + 0.5), m(v[2]) - 12, 0.45, 0.28],
        [q(t + 1), m(v[1]) - 12, 0.9, 0.3]);
    }
  }
  return { pizz, bass, reed };
}

const PLUM_ACC = buildSugarPlum(PLUM_PROG);

/** Harp arpeggios colouring the contrasting strain and the coda. */
const PLUM_HARP = [].concat(
  figure(36, ['G3', 'B3', 'D4', 'G4'], 0.5, 8, 0.24, 0.9),
  figure(40, ['D3', 'F#3', 'A3', 'D4'], 0.5, 8, 0.24, 0.9),
  figure(44, ['C3', 'E3', 'G3', 'C4'], 0.5, 8, 0.24, 0.9),
  figure(48, ['B2', 'D#3', 'F#3', 'A3'], 0.5, 8, 0.24, 0.9),
  figure(116, ['E3', 'G3', 'B3', 'E4'], 0.5, 8, 0.26, 0.9),
  figure(120, ['B2', 'D#3', 'F#3', 'A3'], 0.5, 4, 0.26, 0.9),
  chord(122, ['E3', 'G3', 'B3', 'E4'], 1.8, 0.3),
  chord(126, ['E2', 'B2', 'E3', 'G3'], 1.9, 0.34)
);

/** @type {Object} Dance of the Sugar Plum Fairy. */
const tchaikovsky_sugarplum = {
  id: 'tchaikovsky_sugarplum',
  title: 'Dance of the Sugar Plum Fairy',
  titleKo: '사탕 요정의 춤',
  composer: 'P.I. Tchaikovsky',
  year: 1892,
  tempo: 104,
  timeSig: [2, 4],
  key: 'E minor',
  swing: 0,
  reverb: 0.46,
  station: 'romantic',
  loop: true,
  lengthBeats: 128,
  sections: [{ name: 'intro', startBeat: 0 }, { name: 'A', startBeat: 4 },
    { name: 'B', startBeat: 36 }, { name: 'cascades', startBeat: 68 },
    { name: 'coda', startBeat: 100 }],
  tracks: [
    track('celesta', 0.85, -0.12, PLUM_A, copyAt(PLUM_A, 16, 0, 0.9), PLUM_B,
      copyAt(PLUM_A, 48, 0, 1), PLUM_C, copyAt(PLUM_A, 80, 0, 1.05), PLUM_CODA),
    track('pizzicato', 0.5, 0.28, PLUM_ACC.pizz),
    track('bass', 0.5, 0, PLUM_ACC.bass),
    track('clarinet', 0.35, 0.4, PLUM_ACC.reed),
    track('harp', 0.3, -0.35, PLUM_HARP)
  ]
};

/* -------------------------------------------------------------------------------------------
 * Public API
 * ----------------------------------------------------------------------------------------- */

/**
 * @typedef {Array<number>} ScoreNote A note as `[timeBeats, midiPitch, durBeats, velocity]`.
 */

/**
 * @typedef {Object} ScoreTrack
 * @property {string} instrument One of piano, strings, cello, violin, harpsichord, organ, flute,
 *   oboe, clarinet, horn, trumpet, timpani, harp, celesta, pizzicato, bass.
 * @property {number} gain Track gain 0..1.
 * @property {number} pan Stereo position -1..1.
 * @property {Array<ScoreNote>} notes Notes sorted by time.
 */

/**
 * @typedef {Object} Score
 * @property {string} id Unique score id, also the key inside {@link SCORES}.
 * @property {string} title English title.
 * @property {string} titleKo Korean title for the HUD.
 * @property {string} composer Composer name.
 * @property {number} year Year of composition.
 * @property {number} tempo Beats per minute of the score's beat unit.
 * @property {Array<number>} timeSig Time signature as [beats, unit].
 * @property {string} key Key name.
 * @property {number} swing Swing amount (always 0: this is classical repertoire).
 * @property {number} reverb Suggested reverb mix 0..1.
 * @property {string} station Coarse category: baroque, classic, romantic, opera or action.
 * @property {boolean} loop Whether the sequencer should loop the score.
 * @property {number} lengthBeats Loop length in beats.
 * @property {Array<{name: string, startBeat: number}>} sections Rehearsal marks.
 * @property {Array<ScoreTrack>} tracks Instrumental tracks.
 */

/**
 * Every transcribed score, keyed by id. All works are public domain.
 * @type {Object<string, Score>}
 */
export const SCORES = {
  bach_air,
  bach_prelude_c,
  bach_toccata,
  beethoven_moonlight,
  beethoven_5th,
  mozart_nachtmusik,
  mozart_turca,
  vivaldi_spring,
  grieg_mountain_king,
  offenbach_cancan,
  chopin_nocturne,
  tchaikovsky_sugarplum
};

/**
 * Radio stations for the car radio. A track may appear on more than one station; the HUD shows
 * `nameKo`. Station ids are the radio dial, while `Score.station` is the coarse category used by
 * the music player when it needs a single label for a piece.
 * @type {Array<{id: string, name: string, nameKo: string, composer: string, description: string,
 *   descriptionKo: string, trackIds: Array<string>}>}
 */
export const STATIONS = [
  {
    id: 'baroque',
    name: 'Baroque FM',
    nameKo: '바로크 FM',
    composer: 'Bach, Vivaldi',
    description: 'Counterpoint, harpsichord continuo and endless motion.',
    descriptionKo: '대위법과 하프시코드 통주저음, 멈추지 않는 움직임.',
    trackIds: ['bach_air', 'bach_prelude_c', 'vivaldi_spring', 'bach_toccata']
  },
  {
    id: 'classical',
    name: 'Classic FM',
    nameKo: '클래식 FM',
    composer: 'Mozart, Beethoven',
    description: 'Vienna at its most elegant, from serenade to sonata.',
    descriptionKo: '세레나데부터 소나타까지, 가장 우아한 빈의 밤.',
    trackIds: ['mozart_nachtmusik', 'mozart_turca', 'beethoven_moonlight', 'beethoven_5th']
  },
  {
    id: 'romantic',
    name: 'Romance FM',
    nameKo: '낭만 FM',
    composer: 'Chopin, Tchaikovsky, Grieg',
    description: 'Nocturnes, celesta and moonlit boulevards.',
    descriptionKo: '녹턴과 첼레스타, 달빛이 내린 대로.',
    trackIds: ['chopin_nocturne', 'tchaikovsky_sugarplum', 'beethoven_moonlight',
      'grieg_mountain_king', 'offenbach_cancan']
  },
  {
    id: 'dramatic',
    name: 'Dramatic FM',
    nameKo: '드라마틱 FM',
    composer: 'Bach, Beethoven, Grieg, Offenbach',
    description: 'Sirens behind you? This is the soundtrack.',
    descriptionKo: '사이렌이 따라붙을 때 듣는 음악.',
    trackIds: ['bach_toccata', 'beethoven_5th', 'grieg_mountain_king', 'offenbach_cancan',
      'mozart_turca']
  }
];

/**
 * Looks a score up by id.
 * @param {string} id Score id.
 * @returns {Score|null} The score, or null when the id is unknown.
 */
export function getScore(id) {
  return Object.prototype.hasOwnProperty.call(SCORES, id) ? SCORES[id] : null;
}

/**
 * Duration of one pass through a score in seconds.
 * @param {Score|string} score A score object or a score id.
 * @returns {number} Length in seconds, 0 when the score is unknown or malformed.
 */
export function scoreDurationSeconds(score) {
  const s = typeof score === 'string' ? getScore(score) : score;
  if (!s || !s.tempo || !s.lengthBeats) return 0;
  return (s.lengthBeats * 60) / s.tempo;
}
