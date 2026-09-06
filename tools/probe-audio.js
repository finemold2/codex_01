/**
 * Headless probe for the audio stack: AudioEngine -> SFX -> MusicPlayer + SCORES.
 *
 * Runs against a real (muted) AudioContext in Chromium. Verifies the bus graph, that every SFX
 * method is callable without throwing or feeding NaN/zero into an exponential ramp, that the
 * classical scores are well-formed, and that the music scheduler actually emits notes over time.
 *
 * Run: node tools/gl-probe.mjs tools/probe-audio.js
 */
import { AudioEngine } from '/js/audio/audio.js';
import { SFX } from '/js/audio/sfx.js';
import { MusicPlayer } from '/js/audio/music.js';
import { SCORES, STATIONS, getScore, scoreDurationSeconds } from '/js/audio/scores.js';

const ALLOWED = new Set(['piano', 'strings', 'cello', 'violin', 'harpsichord', 'organ', 'flute',
  'oboe', 'clarinet', 'horn', 'trumpet', 'timpani', 'harp', 'celesta', 'pizzicato', 'bass',
  'viola', 'violin2']);

export default async function run() {
  const out = { errors: [], notes: [] };
  const bad = (m) => out.errors.push(m);

  // ---------------------------------------------------------------- scores
  const ids = Object.keys(SCORES);
  out.notes.push(`scores: ${ids.length} — ${ids.join(', ')}`);
  if (ids.length < 10) bad(`expected at least 10 classical pieces, found ${ids.length}`);

  for (const id of ids) {
    const s = SCORES[id];
    if (!s.tracks || s.tracks.length < 2) { bad(`${id}: fewer than 2 tracks`); continue; }
    let maxEnd = 0;
    let notes = 0;
    for (const tr of s.tracks) {
      if (!ALLOWED.has(tr.instrument)) bad(`${id}: unknown instrument "${tr.instrument}"`);
      if (!tr.notes || !tr.notes.length) { bad(`${id}/${tr.instrument}: empty note list`); continue; }
      let prev = -1;
      for (const n of tr.notes) {
        const [time, pitch, dur, vel] = n;
        notes++;
        if (!Number.isFinite(time) || !Number.isFinite(dur)) { bad(`${id}: non-finite note timing`); break; }
        if (pitch !== null && (pitch < 21 || pitch > 108)) { bad(`${id}: pitch ${pitch} out of range`); break; }
        if (dur <= 0) { bad(`${id}: non-positive duration`); break; }
        if (vel !== undefined && (vel <= 0 || vel > 1)) { bad(`${id}: velocity ${vel} out of (0,1]`); break; }
        if (time < prev - 1e-6) { bad(`${id}/${tr.instrument}: notes not sorted by time`); break; }
        prev = time;
        maxEnd = Math.max(maxEnd, time + dur);
      }
    }
    if (!(s.lengthBeats >= maxEnd - 1e-6)) bad(`${id}: lengthBeats ${s.lengthBeats} < last note end ${maxEnd.toFixed(2)}`);
    if (s.lengthBeats < 64) bad(`${id}: only ${s.lengthBeats} beats long`);
    const secs = scoreDurationSeconds(s);
    if (!(secs > 40 && secs < 240)) bad(`${id}: duration ${secs.toFixed(1)} s outside 40-240 s`);
    out.notes.push(`  ${id}: ${notes} notes, ${s.tracks.length} tracks, ${s.lengthBeats} beats, ${secs.toFixed(0)} s @ ${s.tempo} bpm`);
    if (!getScore(id)) bad(`getScore("${id}") returned nothing`);
  }
  if (!STATIONS || STATIONS.length < 2) bad('expected at least 2 radio stations');
  for (const st of (STATIONS || [])) {
    for (const tid of (st.trackIds || st.tracks || [])) {
      if (!SCORES[tid]) bad(`station ${st.id} references unknown track ${tid}`);
    }
  }

  // ---------------------------------------------------------------- audio engine
  const engine = new AudioEngine();
  await engine.resume();
  if (!engine.ctx) { bad('AudioEngine has no AudioContext after resume()'); return out; }
  out.notes.push(`AudioContext state=${engine.ctx.state} rate=${engine.ctx.sampleRate}`);
  for (const bus of ['music', 'sfx', 'ui', 'ambience', 'vehicle', 'weapon', 'voice']) {
    if (!engine.buses || !engine.buses[bus]) bad(`missing audio bus: ${bus}`);
  }
  engine.setVolume('sfx', 0.0001);
  engine.setVolume('music', 0.0001);
  engine.setVolume('master', 0.0001);
  engine.setListener([0, 1.6, 0], [0, 0, -1], [0, 1, 0], [0, 0, 0]);

  // ---------------------------------------------------------------- sfx
  const sfx = new SFX(engine);
  const P = [3, 1, -4];
  const calls = [
    () => sfx.gunshot('pistol', P), () => sfx.gunshot('smg', P), () => sfx.gunshot('shotgun', P),
    () => sfx.gunshot('rifle', P), () => sfx.gunshot('sniper', P), () => sfx.reload('pistol', P),
    () => sfx.bulletImpact('concrete', P), () => sfx.bulletImpact('metal', P),
    () => sfx.bulletImpact('glass', P), () => sfx.bulletImpact('flesh', P),
    () => sfx.ricochet(P), () => sfx.footstep('concrete', P, false), () => sfx.footstep('grass', P, true),
    () => sfx.jump(P), () => sfx.land(P), () => sfx.punch(P), () => sfx.bodyFall(P),
    () => sfx.carCollision(18, P), () => sfx.glassBreak(P), () => sfx.explosion(P),
    () => sfx.horn(P, 'sedan'), () => sfx.doorOpen(P), () => sfx.doorClose(P),
    () => sfx.pickup('health'), () => sfx.uiClick('select'), () => sfx.wanted(3),
    () => sfx.missionSuccess(), () => sfx.missionFail(),
  ];
  for (let i = 0; i < calls.length; i++) {
    try { calls[i](); } catch (e) { bad(`sfx call #${i} threw: ${e.message}`); }
  }
  let screech = null; let siren = null; let amb = null; let engineVoice = null;
  try { screech = sfx.tireScreech(P, 0.8); } catch (e) { bad(`tireScreech threw: ${e.message}`); }
  try { siren = sfx.siren(P); } catch (e) { bad(`siren threw: ${e.message}`); }
  try { amb = sfx.ambience('city'); } catch (e) { bad(`ambience threw: ${e.message}`); }
  try {
    engineVoice = sfx.createEngine({ type: { key: 'sedan' }, position: P });
    for (let i = 0; i < 200; i++) engineVoice.update(900 + i * 30, i / 200, i * 0.4, P);
  } catch (e) { bad(`engine voice threw: ${e.message}`); }

  // ---------------------------------------------------------------- music
  const music = new MusicPlayer(engine);
  try {
    music.play();
  } catch (e) { bad(`music.play threw: ${e.message}`); }
  let changes = 0;
  music.onTrackChange = () => { changes++; };

  const t0 = performance.now();
  let ticks = 0;
  await new Promise((resolve) => {
    const id = setInterval(() => {
      try { music.update(0.05); } catch (e) { bad(`music.update threw: ${e.message}`); clearInterval(id); resolve(); return; }
      ticks++;
      if (performance.now() - t0 > 3500) { clearInterval(id); resolve(); }
    }, 25);
  });
  out.notes.push(`music ran ${ticks} update ticks over ~3.5 s; playing=${music.playing}`);
  if (!music.playing) bad('music.playing is false after play()');

  try { music.setIntensity(0.8); music.next(); music.nextStation(); music.update(0.05); }
  catch (e) { bad(`music transport threw: ${e.message}`); }
  try { music.pause(); music.resume(); music.stop(); } catch (e) { bad(`music lifecycle threw: ${e.message}`); }

  for (const h of [screech, siren, amb]) { try { if (h && h.stop) h.stop(); } catch (e) { bad(`handle.stop threw: ${e.message}`); } }
  try { if (engineVoice) engineVoice.stop(); } catch (e) { bad(`engine.stop threw: ${e.message}`); }

  out.notes.push(`track change callbacks: ${changes}`);
  return out;
}
