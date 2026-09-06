/**
 * End-to-end check of the death -> respawn loop through the real Game, player.js and
 * character.js. Before the fix, `playRagdoll` was irreversible, so the respawned player kept
 * the corpse rig for the rest of the session.
 */
import { Game } from '/js/game.js';

function buildDom() {
  const mk = (id, cls) => {
    let el = document.getElementById(id);
    if (!el) { el = document.createElement('div'); el.id = id; document.body.appendChild(el); }
    if (cls) el.className = cls;
    return el;
  };
  const loading = mk('loading-screen');
  const fill = document.createElement('div'); fill.id = 'load-fill'; loading.appendChild(fill);
  const status = document.createElement('p'); status.id = 'load-status'; loading.appendChild(status);
  const tip = document.createElement('p'); tip.id = 'load-tip'; loading.appendChild(tip);
  const fatal = mk('fatal', 'hidden');
  const fatalMsg = document.createElement('p'); fatalMsg.id = 'fatal-msg'; fatal.appendChild(fatalMsg);
  return { hudRoot: mk('hud-root', 'layer'), menuRoot: mk('menu-root', 'layer'),
    mapRoot: mk('map-root', 'layer hidden'), loading, loadFill: fill, loadStatus: status,
    loadTip: tip, fatal, fatalMsg };
}

export default async function run({ canvas }) {
  const out = { errors: [], notes: [] };
  const bad = (m) => out.errors.push(m);
  const dom = buildDom();
  dom.canvas = canvas;
  const game = new Game(canvas, dom);
  await game.init(() => {});
  game.startNewGame({ skipPointerLock: true });
  for (let i = 0; i < 40; i++) game.update(1 / 60);

  const p = game.player;
  const ch = p.character;
  const headOf = () => ch.getBoneMatrix('head')[13] - ch.position[1];
  out.notes.push(`alive: state=${ch.state} head ${headOf().toFixed(2)} m above the feet`);
  if (headOf() < 1.3) bad('the living player is not standing up');

  // --- kill the player and let the death timer run out into respawnPlayer() ---------------
  const diedAt = [p.position[0], p.position[2]];
  p.damage(9999, null, 'bullet');
  if (!p.dead) bad('player.damage(9999) did not kill the player');
  for (let i = 0; i < 40; i++) game.update(1 / 60);
  out.notes.push(`dead: state=${ch.state} ragdoll=${ch._ragActive} head ${headOf().toFixed(2)} m`);
  if (headOf() > 1.0) bad('the ragdoll did not drop the player');

  // 3.2 s of death timer + a little slack, then two more seconds of normal play.
  for (let i = 0; i < 60 * 6; i++) game.update(1 / 60);
  const movedAway = Math.hypot(p.position[0] - diedAt[0], p.position[2] - diedAt[1]);
  out.notes.push(`respawned ${movedAway.toFixed(0)} m away: player.dead=${p.dead} ` +
    `character.state=${ch.state} character.dead=${ch.dead} ragdoll=${ch._ragActive} ` +
    `head ${headOf().toFixed(2)} m above the feet`);
  if (p.dead) bad('player never respawned');
  if (ch._ragActive || ch.dead) bad('respawned player is still ragdolled');
  if (ch.state === 'die') bad(`respawned player is still in the 'die' state`);
  if (headOf() < 1.3) bad(`respawned player is still lying down (head at ${headOf().toFixed(2)} m)`);

  // --- walking after the respawn must animate normally ------------------------------------
  const before = [p.position[0], p.position[2]];
  game.input.injectKey('KeyW', true);
  for (let i = 0; i < 150; i++) game.update(1 / 60);
  game.input.injectKey('KeyW', false);
  const walked = Math.hypot(p.position[0] - before[0], p.position[2] - before[1]);
  out.notes.push(`walked ${walked.toFixed(2)} m after respawn, state=${ch.state}, head ${headOf().toFixed(2)} m`);
  if (walked < 1) bad(`respawned player cannot move (${walked.toFixed(2)} m)`);
  if (headOf() < 1.3) bad('respawned player collapsed again while walking');

  // --- a second death/respawn cycle must behave identically ---------------------------------
  p.damage(9999, null, 'bullet');
  for (let i = 0; i < 60 * 6; i++) game.update(1 / 60);
  out.notes.push(`2nd cycle: state=${ch.state} ragdoll=${ch._ragActive} head ${headOf().toFixed(2)} m`);
  if (ch._ragActive || headOf() < 1.3) bad('the second respawn left the player on the ground');

  let nan = 0;
  for (const b of ['root', 'pelvis', 'chest', 'head', 'handR', 'footL', 'footR']) {
    const m = ch.getBoneMatrix(b);
    for (let k = 0; k < 16; k++) if (!Number.isFinite(m[k])) nan++;
  }
  if (nan) bad(`${nan} non-finite bone matrix components after two death cycles`);
  return out;
}
