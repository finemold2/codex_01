// ============================================================
//  악보 데이터 — 전부 퍼블릭 도메인 고전 음악
//  표기법:  "c#4:1  bb3:.5  r:2  [c4,e4,g4]:2  a4:1@0.6"
//    이름:박자   r=쉼표   [..]=화음   @=세기(0~1)
// ============================================================

const NOTE_OFFSET = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** "c#4" → MIDI 번호 */
export function noteToMidi(s) {
  const m = /^([a-gA-G])([#b]?)(-?\d)$/.exec(s.trim());
  if (!m) return null;
  let v = NOTE_OFFSET[m[1].toLowerCase()];
  if (m[2] === '#') v += 1; else if (m[2] === 'b') v -= 1;
  return v + (parseInt(m[3], 10) + 1) * 12;
}

export function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

/** 표기 문자열 → 이벤트 배열 [{t, notes:[midi], dur, vel}] */
export function parseScore(str) {
  const out = [];
  let t = 0;
  const tokens = str.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  for (const tok of tokens) {
    let body = tok, vel = 1;
    const at = body.lastIndexOf('@');
    if (at > 0) { vel = parseFloat(body.slice(at + 1)); body = body.slice(0, at); }
    const ci = body.lastIndexOf(':');
    const pitchPart = ci >= 0 ? body.slice(0, ci) : body;
    const dur = ci >= 0 ? parseFloat(body.slice(ci + 1)) : 1;
    if (pitchPart === 'r' || pitchPart === 'R') { t += dur; continue; }
    let notes;
    if (pitchPart.startsWith('[')) {
      notes = pitchPart.slice(1, -1).split(',').map(noteToMidi).filter(n => n != null);
    } else {
      const n = noteToMidi(pitchPart);
      notes = n == null ? [] : [n];
    }
    if (notes.length) out.push({ t, notes, dur, vel });
    t += dur;
  }
  return { events: out, length: t };
}

// ------------------------------------------------------------------
//  악기 프리셋
// ------------------------------------------------------------------
export const INSTRUMENTS = {
  strings:  { wave: 'sawtooth', a: 0.09, d: 0.18, s: 0.72, r: 0.35, cutoff: 2400, q: 0.7, detune: 7, voices: 2, gain: 0.30 },
  violin:   { wave: 'sawtooth', a: 0.05, d: 0.12, s: 0.78, r: 0.25, cutoff: 3400, q: 1.2, detune: 5, voices: 2, gain: 0.26 },
  cello:    { wave: 'sawtooth', a: 0.07, d: 0.20, s: 0.70, r: 0.40, cutoff: 1300, q: 0.8, detune: 4, voices: 2, gain: 0.30 },
  organ:    { wave: 'sine',     a: 0.02, d: 0.05, s: 0.95, r: 0.18, cutoff: 5200, q: 0.4, detune: 0, voices: 3, gain: 0.20, partials: [1, 2, 3, 4] },
  harpsi:   { wave: 'square',   a: 0.002, d: 0.34, s: 0.06, r: 0.16, cutoff: 4200, q: 0.9, detune: 3, voices: 1, gain: 0.17 },
  piano:    { wave: 'triangle', a: 0.004, d: 0.55, s: 0.12, r: 0.30, cutoff: 3800, q: 0.6, detune: 2, voices: 2, gain: 0.30 },
  flute:    { wave: 'sine',     a: 0.07, d: 0.10, s: 0.85, r: 0.20, cutoff: 4200, q: 0.3, detune: 2, voices: 1, gain: 0.24 },
  brass:    { wave: 'sawtooth', a: 0.035, d: 0.14, s: 0.80, r: 0.20, cutoff: 1900, q: 1.5, detune: 8, voices: 2, gain: 0.24 },
  horn:     { wave: 'triangle', a: 0.06, d: 0.16, s: 0.78, r: 0.28, cutoff: 1500, q: 1.0, detune: 5, voices: 2, gain: 0.26 },
  pizz:     { wave: 'triangle', a: 0.002, d: 0.16, s: 0.0,  r: 0.10, cutoff: 3000, q: 0.8, detune: 3, voices: 1, gain: 0.28 },
  bass:     { wave: 'triangle', a: 0.01, d: 0.20, s: 0.70, r: 0.25, cutoff: 700,  q: 0.7, detune: 0, voices: 1, gain: 0.34 },
  timpani:  { wave: 'sine',     a: 0.002, d: 0.42, s: 0.0,  r: 0.20, cutoff: 400,  q: 1.0, detune: 0, voices: 1, gain: 0.5, noise: 0.35 },
  choir:    { wave: 'sawtooth', a: 0.20, d: 0.25, s: 0.80, r: 0.55, cutoff: 1500, q: 0.6, detune: 11, voices: 3, gain: 0.20 },
  guqin:    { wave: 'triangle', a: 0.003, d: 0.70, s: 0.03, r: 0.45, cutoff: 2600, q: 1.4, detune: 4, voices: 1, gain: 0.26 },
};

// ------------------------------------------------------------------
//  악곡 — mood 로 상황에 맞게 골라 쓴다
// ------------------------------------------------------------------
export const SCORES = [
  // ── 1. 비발디 「봄」 ── 평시 내정
  {
    id: 'spring', title: '사계 「봄」 제1악장', composer: '비발디', bpm: 116, mood: ['peace', 'gov', 'spring'],
    tracks: [
      { inst: 'violin', gain: 1.0, score:
        `e5:.5 e5:.5 e5:1 b4:.5 b4:.5 b4:1 c#5:.5 c#5:.5 c#5:1 b4:2
         a4:.5 a4:.5 a4:1 g#4:.5 g#4:.5 g#4:1 a4:.5 a4:.5 a4:1 g#4:2
         e5:.5 e5:.5 e5:1 b4:.5 b4:.5 b4:1 c#5:.5 c#5:.5 c#5:1 b4:2
         e5:.25 f#5:.25 g#5:.25 f#5:.25 e5:.5 d#5:.5 e5:.25 f#5:.25 g#5:.25 f#5:.25 e5:1
         b4:.5 c#5:.5 d#5:.5 e5:.5 f#5:1 e5:1 e5:.5 d#5:.5 e5:2
         f#5:1 e5:1 d#5:1 e5:2` },
      { inst: 'strings', gain: 0.55, score:
        `[b3,e4]:2 [b3,e4]:2 [b3,d#4]:2 [b3,e4]:2
         [a3,c#4]:2 [b3,d#4]:2 [a3,c#4]:2 [b3,d#4]:2
         [b3,e4]:2 [b3,e4]:2 [b3,d#4]:2 [b3,e4]:2
         [b3,e4]:2 [a3,c#4]:2 [b3,d#4]:2 [b3,e4]:2
         [g#3,b3]:2 [a3,c#4]:2 [b3,d#4]:2 [b3,e4]:2` },
      { inst: 'bass', gain: 0.8, score:
        `e2:1 e2:1 e2:1 e2:1 b2:1 b2:1 e2:1 e2:1
         a2:1 a2:1 b2:1 b2:1 a2:1 a2:1 e2:1 e2:1
         e2:1 e2:1 e2:1 e2:1 b2:1 b2:1 e2:1 e2:1
         e2:1 e2:1 a2:1 a2:1 b2:1 b2:1 e2:1 e2:1
         e2:1 e2:1 a2:1 a2:1 b2:1 b2:1 e2:2` },
    ],
  },
  // ── 2. 비발디 「겨울」 ── 위기·긴장
  {
    id: 'winter', title: '사계 「겨울」 제1악장', composer: '비발디', bpm: 100, mood: ['tense', 'crisis', 'winter'],
    tracks: [
      { inst: 'strings', gain: 0.9, score:
        `f4:.25@.4 f4:.25@.4 f4:.25@.5 f4:.25@.5 f4:.25@.6 f4:.25@.6 f4:.25@.7 f4:.25@.7
         f4:.25@.5 f4:.25@.5 f4:.25@.6 f4:.25@.6 f4:.25@.7 f4:.25@.7 f4:.25@.8 f4:.25@.8
         ab4:.25 ab4:.25 ab4:.25 ab4:.25 ab4:.25 ab4:.25 ab4:.25 ab4:.25
         g4:.25 g4:.25 g4:.25 g4:.25 g4:.25 g4:.25 g4:.25 g4:.25` },
      { inst: 'violin', gain: 0.85, score:
        `r:8 c5:.5 db5:.5 c5:.5 bb4:.5 ab4:1 g4:1
         f4:2 c5:1 ab4:1 g4:.5 f4:.5 e4:.5 f4:.5 c5:2 r:2
         db5:1 c5:1 bb4:1 ab4:1 g4:2 f4:2 f4:2` },
      { inst: 'cello', gain: 0.8, score:
        `f2:2 f2:2 f2:2 f2:2 ab2:2 ab2:2 g2:2 c3:2
         f2:2 f2:2 ab2:2 g2:2 c3:2 c3:2 f2:4` },
    ],
  },
  // ── 3. 바흐 「G선상의 아리아」 ── 평화·궁정
  {
    id: 'air', title: 'G선상의 아리아', composer: '바흐', bpm: 62, mood: ['peace', 'court', 'gov'],
    tracks: [
      { inst: 'violin', gain: 1.0, score:
        `f#5:4 g5:1.5 f#5:.5 e5:1 d5:1 c#5:2 b4:1 a4:1
         d5:3 e5:1 f#5:2 g5:1 f#5:1 e5:4
         a5:2 g5:1 f#5:1 e5:2 d5:1 c#5:1 b4:4
         d5:1 e5:1 f#5:1 g5:1 a5:2 g5:1 f#5:1 e5:2 d5:2` },
      { inst: 'strings', gain: 0.5, score:
        `[a4,d5]:4 [b4,d5]:4 [a4,c#5]:4 [a4,d5]:4
         [f#4,a4]:4 [g4,b4]:4 [a4,c#5]:4 [g4,b4]:4
         [a4,c#5]:4 [g4,b4]:4 [f#4,a4]:4 [g4,b4]:4` },
      { inst: 'bass', gain: 0.9, score:
        `d2:1 d2:1 d3:1 c#3:1 b2:1 b2:1 g2:1 g2:1
         a2:1 a2:1 f#2:1 f#2:1 g2:1 g2:1 a2:1 a2:1
         d2:1 d2:1 e2:1 e2:1 f#2:1 f#2:1 g2:1 g2:1
         a2:1 a2:1 b2:1 b2:1 g2:1 a2:1 d2:2
         d2:1 d2:1 e2:1 e2:1 f#2:1 f#2:1 g2:1 a2:1
         d2:2 a2:2 d2:4` },
    ],
  },
  // ── 4. 바흐 「토카타와 푸가」 ── 파멸·흉조
  {
    id: 'toccata', title: '토카타와 푸가 d단조', composer: '바흐', bpm: 84, mood: ['doom', 'crisis', 'death'],
    tracks: [
      { inst: 'organ', gain: 1.0, score:
        `a5:.5 g5:.25 a5:1.75 r:.5
         g5:.25 f5:.25 e5:.25 d5:.25 c#5:.5 d5:2 r:1
         a4:.5 g4:.25 a4:1.75 r:.5
         g4:.25 f4:.25 e4:.25 d4:.25 c#4:.5 d4:2 r:1
         [d4,f4,a4]:2 [c#4,e4,a4]:2 [d4,f4,a4]:4
         r:1 [c#4,e4,g4,bb4]:2 [d4,f4,a4]:3 r:3` },
      { inst: 'organ', gain: 0.7, score:
        `r:8 r:8
         a3:.5 g3:.25 a3:1.75 r:.5
         g3:.25 f3:.25 e3:.25 d3:.25 c#3:.5 d3:2 r:1
         [d3,a3]:2 [e3,a3]:2 [d3,a3]:4 r:.5` },
      { inst: 'bass', gain: 0.9, score:
        `d2:4 d2:4 a1:4 a1:4 d2:4 d2:4 bb1:2 a1:2 d2:4` },
    ],
  },
  // ── 5. 베토벤 교향곡 5번 「운명」 ── 전투 개시
  {
    id: 'fate', title: '교향곡 5번 「운명」', composer: '베토벤', bpm: 108, mood: ['battle', 'war', 'crisis'],
    tracks: [
      { inst: 'strings', gain: 1.0, score:
        `r:.5 g4:.5 g4:.5 g4:.5 eb4:3 r:1
         r:.5 f4:.5 f4:.5 f4:.5 d4:3 r:1
         r:.5 g4:.5 g4:.5 g4:.5 eb4:1.5 f4:.5 g4:.5 ab4:.5 g4:.5 f4:.5 eb4:2
         r:.5 d4:.5 d4:.5 d4:.5 bb3:1.5 c4:.5 d4:.5 eb4:.5 d4:.5 c4:.5 bb3:2` },
      { inst: 'cello', gain: 0.85, score:
        `r:.5 g3:.5 g3:.5 g3:.5 eb3:3 r:1
         r:.5 f3:.5 f3:.5 f3:.5 d3:3 r:1
         r:.5 eb3:.5 eb3:.5 eb3:.5 c3:3 r:1
         r:.5 d3:.5 d3:.5 d3:.5 bb2:3 r:1
         g2:2 bb2:2` },
      { inst: 'timpani', gain: 0.7, score:
        `c2:4 r:2 c2:4 r:2 g1:4 r:2 c2:4 r:2 g1:2 c2:2` },
    ],
  },
  // ── 6. 베토벤 「엘리제를 위하여」 ── 인재·등용
  {
    id: 'elise', title: '엘리제를 위하여', composer: '베토벤', bpm: 74, mood: ['person', 'gov', 'gentle'],
    tracks: [
      { inst: 'piano', gain: 1.0, score:
        `e5:.5 d#5:.5 e5:.5 d#5:.5 e5:.5 b4:.5 d5:.5 c5:.5 a4:1.5
         c4:.5 e4:.5 a4:.5 b4:1.5 e4:.5 g#4:.5 b4:.5 c5:1.5
         e4:.5 e5:.5 d#5:.5 e5:.5 d#5:.5 e5:.5 b4:.5 d5:.5 c5:.5 a4:1.5
         c4:.5 e4:.5 a4:.5 b4:1.5 e4:.5 c5:.5 b4:.5 a4:2` },
      { inst: 'piano', gain: 0.6, score:
        `[a2,e3]:3 [e2,e3]:3 [a2,e3]:3 [a2,e3]:3
         [a2,e3]:3 [e2,b2]:3 [a2,e3]:3 [a2,e3]:3
         [a2,e3]:3 [e2,e3]:3 [a2,e3]:3 [a2,e3]:3
         [a2,e3]:3 [e2,b2]:3 [e2,b2]:3 [a2,e3]:3` },
    ],
  },
  // ── 7. 베토벤 「월광」 1악장 ── 밤·사색·죽음
  {
    id: 'moonlight', title: '피아노 소나타 「월광」', composer: '베토벤', bpm: 54, mood: ['night', 'death', 'sad'],
    tracks: [
      { inst: 'piano', gain: 0.75, score:
        `g#3:0.3333333 c#4:.333 e4:.333 g#3:.333 c#4:.333 e4:.333
         g#3:.333 c#4:.333 e4:.333 g#3:.333 c#4:.333 e4:.333
         a3:.333 c#4:.333 e4:.333 a3:.333 c#4:.333 e4:.333
         a3:.333 d4:.333 f#4:.333 a3:.333 d4:.333 f#4:.333
         g#3:.333 b#3:.333 f#4:.333 g#3:.333 c#4:.333 e4:.333
         g#3:.333 c#4:.333 e4:.333 g#3:.333 c#4:.333 d#4:.333` },
      { inst: 'flute', gain: 0.8, score:
        `r:2 g#4:1 g#4:1 g#4:1 g#4:1
         r:2 a4:2 g#4:2 g#4:1 f#4:1 e4:2 d#4:2 c#4:2 r:2
         r:2` },
      { inst: 'bass', gain: 0.9, score:
        `c#2:2 c#2:2 b1:2 b1:2 a1:2 a1:2 f#1:2 g#1:2 c#2:4 g#1:2 c#2:2` },
    ],
  },
  // ── 8. 모차르트 「아이네 클라이네 나흐트무지크」 ── 타이틀·평시
  {
    id: 'nacht', title: '아이네 클라이네 나흐트무지크', composer: '모차르트', bpm: 132, mood: ['title', 'peace', 'bright'],
    tracks: [
      { inst: 'violin', gain: 1.0, score:
        `g4:.5 d4:.5 g4:.25 d4:.25 g4:.25 b4:.25 d5:.5 r:.5
         c5:.5 a4:.5 f#4:.25 a4:.25 c5:.25 a4:.25 d4:.5 r:.5
         g4:.25 a4:.25 b4:.25 c5:.25 d5:.5 g5:.5 e5:.5 c5:.5 a4:.5 f#4:.5 g4:1
         d5:.5 b4:.5 g4:.5 d5:.5 b4:.5 g4:.5 d4:1
         a4:.5 b4:.5 c5:.5 a4:.5 g4:1` },
      { inst: 'strings', gain: 0.55, score:
        `[b3,d4]:1 [b3,d4]:1 [b3,d4]:1 [b3,d4]:1
         [a3,c4]:1 [a3,c4]:1 [a3,c4]:1 [f#3,a3]:1
         [b3,d4]:1 [b3,d4]:1 [c4,e4]:1 [b3,d4]:1 [a3,c4]:1 [b3,d4]:1
         [b3,d4]:1 [b3,d4]:1 [a3,c4]:1 [b3,d4]:1` },
      { inst: 'bass', gain: 0.9, score:
        `g2:1 g2:1 g2:1 g2:1 d2:1 d2:1 d2:1 d2:1
         g2:1 g2:1 c3:1 g2:1 d3:1 g2:1 g2:1 g2:1 d2:1 g2:1` },
    ],
  },
  // ── 9. 모차르트 「터키 행진곡」 ── 전투·추격
  {
    id: 'turkish', title: '터키 행진곡', composer: '모차르트', bpm: 128, mood: ['battle', 'chase', 'bright'],
    tracks: [
      { inst: 'piano', gain: 1.0, score:
        `b4:.25 a4:.25 g#4:.25 a4:.25 c5:1
         d5:.25 c5:.25 b4:.25 c5:.25 e5:1
         f5:.25 e5:.25 d#5:.25 e5:.25 b5:.25 a5:.25 g#5:.25 a5:.25 b5:.25 a5:.25 g#5:.25 a5:.25 c6:1
         a5:.5 c6:.5 b5:.5 a5:.5 g#5:.5 a5:.5 b5:.5 a5:.5 g#5:.5 a5:1.5
         b4:.25 a4:.25 g#4:.25 a4:.25 c5:1` },
      { inst: 'pizz', gain: 0.8, score:
        `[a2,e3]:1 [a2,e3]:1 [a2,e3]:1 [a2,e3]:1
         [a2,e3]:1 [a2,e3]:1 [e2,b2]:1 [e2,b2]:1
         [a2,e3]:1 [a2,e3]:1 [e2,b2]:1 [a2,e3]:1
         [a2,e3]:1 [e2,b2]:1 [e2,b2]:1 [a2,e3]:1` },
    ],
  },
  // ── 10. 모차르트 「라크리모사」 ── 장례·군주 사망
  {
    id: 'lacrimosa', title: '레퀴엠 「라크리모사」', composer: '모차르트', bpm: 56, mood: ['death', 'sad', 'ceremony'],
    tracks: [
      { inst: 'choir', gain: 1.0, score:
        `r:3 a4:1.5 a4:.5 bb4:1 a4:1 g4:1 f4:1.5 g4:.5
         a4:1 bb4:1 c5:2 d5:1.5 c5:.5 bb4:1 a4:1 g4:2
         d5:1 e5:1 f5:2 e5:1.5 d5:.5 c5:1 d5:1 a4:3 r:2 f4:1.5 g4:.5 a4:1` },
      { inst: 'strings', gain: 0.55, score:
        `[d4,f4]:3 [d4,f4]:3 [c4,e4]:3 [d4,f4]:3
         [bb3,d4]:3 [a3,c4]:3 [d4,f4]:3 [g3,bb3]:3
         [a3,c4]:3 [d4,f4]:3 [g3,bb3]:3 [a3,c#4]:3` },
      { inst: 'bass', gain: 0.9, score:
        `d2:1.5 d2:1.5 d2:1.5 d2:1.5 c2:1.5 c2:1.5 d2:1.5 d2:1.5
         bb1:1.5 bb1:1.5 a1:1.5 a1:1.5 d2:3 g1:3 a1:3 d2:3 d2:3 a1:3` },
    ],
  },
  // ── 11. 홀스트 「화성, 전쟁을 부르는 자」 ── 대규모 전투
  {
    id: 'mars', title: '행성 「화성」', composer: '홀스트', bpm: 132, mood: ['war', 'battle', 'siege'],
    tracks: [
      { inst: 'timpani', gain: 1.0, score:
        `g1:1 g1:1 g1:.5 g1:.5 g1:1 g1:1
         g1:1 g1:1 g1:.5 g1:.5 g1:1 g1:1
         g1:1 g1:1 g1:.5 g1:.5 g1:1 g1:1
         g1:1 g1:1 g1:.5 g1:.5 g1:1 g1:1` },
      { inst: 'brass', gain: 0.9, score:
        `[g2,d3]:1 [g2,d3]:1 [g2,d3]:.5 [g2,d3]:.5 [g2,d3]:1 [g2,d3]:1
         [ab2,eb3]:1 [ab2,eb3]:1 [ab2,eb3]:.5 [ab2,eb3]:.5 [g2,d3]:1 [g2,d3]:1
         [c3,g3]:2.5 [bb2,f3]:2.5
         [ab2,eb3]:2.5 [g2,d3]:2.5` },
      { inst: 'horn', gain: 0.7, score:
        `r:5 r:5
         g3:1 bb3:1 c4:.5 db4:.5 c4:1 bb3:1
         ab3:2.5 g3:2.5` },
    ],
  },
  // ── 12. 그리그 「산왕의 궁전에서」 ── 계략·음모
  {
    id: 'mountainking', title: '산왕의 궁전에서', composer: '그리그', bpm: 112, mood: ['scheme', 'tense', 'night'],
    tracks: [
      { inst: 'pizz', gain: 1.0, score:
        `b2:.5 c#3:.5 d3:.5 e3:.5 f#3:.5 d3:.5 f#3:1
         f3:.5 d3:.5 f3:1 e3:.5 c#3:.5 e3:1
         b2:.5 c#3:.5 d3:.5 e3:.5 f#3:.5 d3:.5 f#3:1
         f#3:.5 a3:.5 g#3:.5 e3:.5 g#3:.5 e3:.5 g#3:1` },
      { inst: 'bass', gain: 0.85, score:
        `b1:2 b1:2 b1:2 b1:2 b1:2 b1:2 b1:2 e2:2` },
      { inst: 'cello', gain: 0.5, score:
        `r:4 r:4
         b3:.5 c#4:.5 d4:.5 e4:.5 f#4:.5 d4:.5 f#4:1
         f4:.5 d4:.5 f4:1 e4:.5 c#4:.5 e4:1` },
    ],
  },
  // ── 13. 그리그 「아침의 기분」 ── 새해·봄·희망
  {
    id: 'morning', title: '「페르 귄트」 아침의 기분', composer: '그리그', bpm: 68, mood: ['newyear', 'peace', 'spring'],
    tracks: [
      { inst: 'flute', gain: 1.0, score:
        `e5:.5 c#5:.5 b4:.5 a4:.5 b4:.5 c#5:.5
         e5:.5 c#5:.5 b4:.5 c#5:.5 e5:.5 c#5:.5
         e5:.5 f#5:.5 c#5:1 c#5:.5 a4:.5 g#4:.5 f#4:.5 g#4:.5 a4:.5
         c#5:.5 a4:.5 g#4:.5 a4:.5 c#5:.5 a4:.5 c#5:2
         b4:.5 g#4:.5 f#4:.5 g#4:.5 b4:.5 g#4:.5 e4:.5 f#4:.5 g#4:.5 a4:.5 b4:.5 c#5:.5 e5:2` },
      { inst: 'strings', gain: 0.6, score:
        `[e4,g#4]:3 [e4,g#4]:3 [e4,a4]:3 [e4,g#4]:3
         [a3,c#4]:3 [a3,c#4]:3 [b3,d#4]:3 [e4,g#4]:3` },
      { inst: 'bass', gain: 0.8, score:
        `e2:3 e2:3 e2:3 e2:3 a2:3 a2:3 b2:3 e2:3` },
    ],
  },
  // ── 14. 바그너 「발키리의 기행」 ── 출진
  {
    id: 'valkyrie', title: '발키리의 기행', composer: '바그너', bpm: 92, mood: ['march', 'war', 'sortie'],
    tracks: [
      { inst: 'brass', gain: 1.0, score:
        `b3:.75 f#4:.25 b4:1.5 r:.5
         b3:.75 f#4:.25 b4:.75 d5:.25 b4:1
         d5:.75 b4:.25 f#4:1.5 r:.5
         b3:.75 f#4:.25 b4:1.5 r:.5
         d4:.75 a4:.25 d5:1.5 r:.5
         d4:.75 a4:.25 d5:.75 f#5:.25 d5:1
         b4:.75 f#4:.25 b3:1.5 r:.5 b3:.75 f#4:.25 b4:2` },
      { inst: 'timpani', gain: 0.75, score:
        `b1:1 b1:1 b1:1 b1:1 b1:1 b1:1 b1:1 b1:1
         d2:1 d2:1 d2:1 d2:1 b1:1 b1:1 b1:1 b1:1
         f#1:1 f#1:1 f#1:1 f#1:1 b1:1 b1:1 b1:1 b1:1` },
      { inst: 'horn', gain: 0.55, score:
        `[b2,d3]:2 [b2,d3]:2 [b2,f#3]:2 [b2,d3]:2
         [d3,f#3]:2 [d3,f#3]:2 [b2,d3]:2 [b2,d3]:2
         [f#2,a2]:2 [f#2,a2]:2 [b2,d3]:2 [b2,d3]:2` },
    ],
  },
  // ── 15. 차이콥스키 「백조의 호수」 ── 비장·패퇴
  {
    id: 'swan', title: '백조의 호수', composer: '차이콥스키', bpm: 76, mood: ['sad', 'defeat', 'ceremony'],
    tracks: [
      { inst: 'violin', gain: 1.0, score:
        `b4:1.5 f#5:.5 a5:.5 g5:.5 f#5:1 e5:.5 d5:.5 e5:.5 f#5:.5 b4:2
         b4:1.5 f#5:.5 a5:.5 g5:.5 f#5:1 e5:.5 d5:.5 c#5:.5 d5:.5 b4:2
         d5:1 e5:1 f#5:1 g5:1 a5:2 g5:1 f#5:1 b4:4` },
      { inst: 'strings', gain: 0.6, score:
        `[d4,f#4]:2 [d4,f#4]:2 [b3,d4]:2 [b3,d4]:2
         [d4,f#4]:2 [d4,f#4]:2 [a3,c#4]:2 [b3,d4]:2
         [b3,d4]:2 [d4,f#4]:2 [c#4,e4]:2 [b3,d4]:2 [f#3,a3]:2 [b3,d4]:2` },
      { inst: 'bass', gain: 0.9, score:
        `b1:2 b1:2 f#1:2 b1:2 b1:2 d2:2 f#1:2 b1:2
         g1:2 a1:2 b1:2 f#1:2 b1:4` },
    ],
  },
  // ── 16. 쇼팽 「녹턴 op.9-2」 ── 야간 내정·연회
  {
    id: 'nocturne', title: '녹턴 op.9 no.2', composer: '쇼팽', bpm: 60, mood: ['night', 'feast', 'gentle'],
    tracks: [
      { inst: 'piano', gain: 1.0, score:
        `bb4:1.5 g5:.5 f5:.5 eb5:.5 bb4:1
         c5:1.5 c5:.5 bb4:.5 ab4:.5 bb4:1
         bb4:1 eb5:1 d5:.5 c5:.5 bb4:.5 ab4:.5 g4:1
         ab4:.5 bb4:.5 c5:.5 d5:.5 eb5:1 bb4:1 bb4:1
         g5:1.5 f5:.5 eb5:1 d5:1 c5:1 bb4:1` },
      { inst: 'piano', gain: 0.5, score:
        `[eb2,bb2]:1 [g3,bb3]:1 [g3,bb3]:1
         [bb1,f2]:1 [d3,ab3]:1 [d3,ab3]:1
         [eb2,bb2]:1 [g3,bb3]:1 [g3,bb3]:1
         [ab1,eb2]:1 [c3,ab3]:1 [c3,ab3]:1
         [eb2,bb2]:1 [g3,bb3]:1 [g3,bb3]:1
         [bb1,f2]:1 [d3,ab3]:1 [d3,ab3]:1
         [eb2,bb2]:1 [g3,bb3]:1 [g3,bb3]:1
         [eb2,bb2]:1 [g3,bb3]:1 [g3,bb3]:1` },
    ],
  },
  // ── 17. 쇼팽 「장송 행진곡」 ── 국장·멸망
  {
    id: 'funeral', title: '장송 행진곡', composer: '쇼팽', bpm: 52, mood: ['death', 'fall', 'ceremony'],
    tracks: [
      { inst: 'piano', gain: 1.0, score:
        `bb3:1.5 bb3:.5 bb3:1 bb3:1
         db4:1.5 c4:.5 c4:1 bb3:1
         bb3:1.5 ab3:.5 ab3:1 g3:1
         g3:1.5 ab3:.5 bb3:1 bb3:1 bb3:4` },
      { inst: 'organ', gain: 0.55, score:
        `[bb2,db3,f3]:2 [bb2,db3,f3]:2
         [gb2,bb2,db3]:2 [f2,ab2,c3]:2
         [bb2,db3,f3]:2 [eb2,gb2,bb2]:2
         [f2,ab2,c3]:2 [bb2,db3,f3]:2 [bb2,db3,f3]:4` },
      { inst: 'timpani', gain: 0.55, score:
        `bb1:2 bb1:2 bb1:2 bb1:2 bb1:2 bb1:2 f1:2 bb1:2 bb1:4` },
    ],
  },
  // ── 18. 드보르작 「신세계로부터」 라르고 ── 엔딩·회상
  {
    id: 'newworld', title: '「신세계로부터」 라르고', composer: '드보르작', bpm: 58, mood: ['ending', 'sad', 'peace'],
    tracks: [
      { inst: 'horn', gain: 1.0, score:
        `e4:1.5 g4:.5 g4:2 e4:1.5 d4:.5 c4:2
         d4:1 e4:1 g4:1 e4:1 d4:4
         e4:1.5 g4:.5 g4:2 e4:1.5 d4:.5 c4:2
         d4:1 e4:1 d4:1 c4:1 c4:4` },
      { inst: 'strings', gain: 0.55, score:
        `[c4,e4]:4 [c4,e4]:4 [a3,c4]:4 [g3,c4]:4
         [g3,b3]:4 [c4,e4]:4 [g3,b3]:4 [c4,e4]:4
         [c4,e4]:4 [c4,e4]:4 [a3,c4]:4 [g3,c4]:4
         [f3,a3]:4 [g3,b3]:4 [g3,b3]:4 [c4,e4]:4` },
      { inst: 'bass', gain: 0.85, score:
        `c2:4 c2:4 a1:4 g1:4 g1:4 c2:4 g1:4 c2:4
         c2:4 c2:4 a1:4 g1:4 f1:4 g1:4 g1:4 c2:4` },
    ],
  },
  // ── 19. 파헬벨 「캐논」 ── 통일·대업
  {
    id: 'canon', title: '캐논 D장조', composer: '파헬벨', bpm: 68, mood: ['victory', 'ending', 'peace'],
    tracks: [
      { inst: 'violin', gain: 1.0, score:
        `f#5:2 e5:2 d5:2 c#5:2 b4:2 a4:2 b4:2 c#5:2
         d5:1 c#5:1 b4:1 a4:1 g4:1 f#4:1 g4:1 e4:1
         d4:.5 f#4:.5 a4:.5 g4:.5 f#4:.5 d4:.5 f#4:.5 e4:.5
         d4:.5 b3:.5 d4:.5 a4:.5 g4:.5 b4:.5 a4:.5 g4:.5
         f#4:.5 d4:.5 e4:.5 c#4:.5 d4:.5 f#4:.5 a4:.5 g4:.5
         f#4:.5 a4:.5 d5:.5 c#5:.5 d5:.5 f#5:.5 a5:.5 g5:.5
         f#5:.5 d5:.5 e5:.5 c#5:.5 d5:.5 a4:.5 d5:.5 c#5:.5
         b4:.5 g4:.5 b4:.5 a4:.5 g4:.5 b4:.5 d5:.5 c#5:.5` },
      { inst: 'guqin', gain: 0.6, score:
        `r:16
         f#5:2 e5:2 d5:2 c#5:2 b4:2 a4:2 b4:2 c#5:2
         d5:1 c#5:1 b4:1 a4:1 g4:1 f#4:1 g4:1 e4:1
         d4:2 f#4:2 a4:2 g4:2` },
      { inst: 'bass', gain: 0.95, score:
        `d2:2 a1:2 b1:2 f#1:2 g1:2 d1:2 g1:2 a1:2
         d2:2 a1:2 b1:2 f#1:2 g1:2 d1:2 g1:2 a1:2
         d2:2 a1:2 b1:2 f#1:2 g1:2 d1:2 g1:2 a1:2` },
    ],
  },
  // ── 20. 베토벤 「환희의 송가」 ── 천하통일
  {
    id: 'joy', title: '환희의 송가', composer: '베토벤', bpm: 104, mood: ['victory', 'unify', 'ending'],
    tracks: [
      { inst: 'brass', gain: 1.0, score:
        `e4:1 e4:1 f4:1 g4:1 g4:1 f4:1 e4:1 d4:1
         c4:1 c4:1 d4:1 e4:1 e4:1.5 d4:.5 d4:2
         e4:1 e4:1 f4:1 g4:1 g4:1 f4:1 e4:1 d4:1
         c4:1 c4:1 d4:1 e4:1 d4:1.5 c4:.5 c4:2` },
      { inst: 'choir', gain: 0.7, score:
        `[c3,g3]:2 [c3,a3]:2 [c3,g3]:2 [b2,g3]:2
         [c3,g3]:2 [g2,d3]:2 [c3,g3]:2 [g2,b2]:2
         [c3,g3]:2 [c3,a3]:2 [c3,g3]:2 [b2,g3]:2
         [c3,g3]:2 [g2,d3]:2 [g2,b2]:2 [c3,g3]:2` },
      { inst: 'timpani', gain: 0.6, score:
        `c2:2 c2:2 g1:2 g1:2 c2:2 g1:2 c2:2 c2:2
         c2:2 c2:2 g1:2 g1:2 c2:2 g1:2 g1:2 c2:2` },
    ],
  },
  // ── 21. 로시니 「윌리엄 텔」 ── 추격·기병 돌격
  {
    id: 'tell', title: '「윌리엄 텔」 서곡 피날레', composer: '로시니', bpm: 148, mood: ['chase', 'battle', 'cavalry'],
    tracks: [
      { inst: 'brass', gain: 1.0, score:
        `e4:.25 e4:.25 e4:.5 e4:.25 e4:.25 e4:.5 e4:.25 e4:.25 e4:.5 e4:.5 e4:.5
         e4:.25 e4:.25 e4:.5 e4:.25 e4:.25 e4:.5 e4:.25 e4:.25 e4:.5 e4:.5 e4:.5
         b4:.25 b4:.25 b4:.5 b4:.25 b4:.25 b4:.5 b4:.25 b4:.25 b4:.5 b4:.5 b4:.5
         e5:.25 e5:.25 e5:.5 c#5:.25 c#5:.25 c#5:.5 b4:.25 b4:.25 b4:.5 a4:.5 g#4:.5` },
      { inst: 'timpani', gain: 0.7, score:
        `e2:.5 e2:.5 e2:.5 e2:.5 e2:.5 e2:.5 e2:.5 e2:.5
         e2:.5 e2:.5 e2:.5 e2:.5 e2:.5 e2:.5 e2:.5 e2:.5
         b1:.5 b1:.5 b1:.5 b1:.5 b1:.5 b1:.5 b1:.5 b1:.5
         e2:.5 e2:.5 e2:.5 e2:.5 e2:.5 e2:.5 e2:.5 e2:.5` },
      { inst: 'horn', gain: 0.5, score:
        `[e3,g#3]:2 [e3,g#3]:2 [e3,g#3]:2 [e3,g#3]:2
         [b2,f#3]:2 [b2,f#3]:2 [e3,g#3]:2 [e3,g#3]:2` },
    ],
  },
  // ── 22. 알비노니 「아다지오」 ── 패배·상실
  {
    id: 'adagio', title: '아다지오 g단조', composer: '알비노니', bpm: 50, mood: ['defeat', 'sad', 'fall'],
    tracks: [
      { inst: 'organ', gain: 0.75, score:
        `[g3,bb3,d4]:4 [d3,g3,bb3]:4 [eb3,g3,c4]:4 [d3,f#3,c4]:4
         [g3,bb3,d4]:4 [c3,eb3,g3]:4 [d3,f#3,a3]:4 [g3,bb3,d4]:4` },
      { inst: 'violin', gain: 1.0, score:
        `d5:2 c5:1 bb4:1 a4:2 bb4:1 c5:1
         d5:3 c5:1 bb4:2 a4:2
         g4:2 bb4:1 d5:1 c5:2 bb4:1 a4:1 bb4:4 g4:4` },
      { inst: 'bass', gain: 0.9, score:
        `g1:4 d2:4 c2:4 d2:4 g1:4 c2:4 d2:4 g1:4` },
    ],
  },
  // ── 23. 베토벤 교향곡 7번 2악장 ── 행군·소모전
  {
    id: 'allegretto', title: '교향곡 7번 제2악장', composer: '베토벤', bpm: 76, mood: ['march', 'siege', 'sad'],
    tracks: [
      { inst: 'cello', gain: 1.0, score:
        `e4:1 e4:.5 e4:.5 f4:1 g4:1 a4:1 a4:.5 a4:.5 g4:1 f4:1
         e4:1 e4:.5 e4:.5 d4:1 c4:1 b3:1 b3:.5 b3:.5 c4:1 d4:1
         e4:1 e4:.5 e4:.5 f4:1 g4:1 a4:1 a4:.5 a4:.5 g4:1 f4:1
         e4:1 e4:.5 e4:.5 d4:1 c4:1 b3:2 a3:2` },
      { inst: 'strings', gain: 0.5, score:
        `[a3,c4]:2 [a3,c4]:2 [a3,c4]:2 [a3,c4]:2
         [g3,b3]:2 [e3,g3]:2 [e3,g3]:2 [a3,c4]:2
         [a3,c4]:2 [a3,c4]:2 [a3,c4]:2 [a3,c4]:2
         [g3,b3]:2 [e3,g3]:2 [e3,gs3]:2 [a3,c4]:2` },
      { inst: 'bass', gain: 0.85, score:
        `a1:2 a1:2 a1:2 a1:2 e1:2 e1:2 e1:2 a1:2
         a1:2 a1:2 a1:2 a1:2 e1:2 e1:2 e1:2 a1:2` },
    ],
  },
  // ── 24. 베르디 「진노의 날」 ── 재해·천변
  {
    id: 'diesirae', title: '레퀴엠 「진노의 날」', composer: '베르디', bpm: 144, mood: ['disaster', 'crisis', 'doom'],
    tracks: [
      { inst: 'timpani', gain: 1.0, score:
        `g1:.5 g1:.5 g1:.5 g1:.5 g1:.5 g1:.5 g1:.5 g1:.5
         g1:.5 g1:.5 g1:.5 g1:.5 g1:.5 g1:.5 g1:.5 g1:.5` },
      { inst: 'choir', gain: 0.9, score:
        `[g4,bb4,d5]:1 [g4,bb4,d5]:1 [f4,ab4,c5]:1 [f4,ab4,c5]:1
         [eb4,g4,bb4]:1 [d4,f#4,a4]:1 [g4,bb4,d5]:2
         g5:.5 f5:.5 eb5:.5 d5:.5 c5:.5 bb4:.5 a4:.5 g4:.5
         [g4,bb4,d5]:2 [d4,f#4,a4]:2` },
      { inst: 'bass', gain: 1.0, score:
        `g1:1 g1:1 f1:1 f1:1 eb1:1 d1:1 g1:2 g1:4 g1:2 d1:2` },
    ],
  },
];

export const SCORE_BY_ID = Object.fromEntries(SCORES.map(s => [s.id, s]));

/** 상황(mood)에 맞는 곡 목록 */
export function scoresFor(mood) {
  return SCORES.filter(s => s.mood.includes(mood));
}
