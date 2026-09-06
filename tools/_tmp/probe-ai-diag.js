/** Diagnostic probe for ped/traffic/police behaviour. */
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
  const out = { notes: [], errors: [] };
  const dom = buildDom(); dom.canvas = canvas;
  const game = new Game(canvas, dom);
  await game.init(() => {});
  game.startNewGame({ skipPointerLock: true });
  const step = () => game.update(1 / 60);
  for (let i = 0; i < 60; i++) step();

  // ---------------------------------------------------------------- 1. cop friendly fire
  {
    game.police.clearWanted();
    game.police.addWanted(3, 'test');
    for (let i = 0; i < 60; i++) step();
    // force-create two cops next to each other
    const p = game.player.position;
    const u = game.police.cars[0];
    let a = null; let b = null;
    if (u) { game.police._deploy(u); }
    a = game.police.cops[0]; b = game.police.cops[1];
    if (!a || !b) {
      // fabricate by direct acquire
      a = game.police._acquireCop(false); b = game.police._acquireCop(false);
      if (a && b) {
        a.position.set([p[0] + 3, p[1], p[2]]); b.position.set([p[0] + 4, p[1], p[2]]);
        game.police.cops.push(a, b);
      }
    }
    if (a && b) {
      const before = game.police.wanted;
      const kills0 = game.player.kills;
      game.ext.aiShooter = a;              // cop A is shooting
      game.peds.damagePed(b, 9999, [1, 0, 0], false);   // no explicit attacker (weapons.applyHit path)
      game.ext.aiShooter = undefined;
      out.notes.push(`copFF: wanted ${before} -> ${game.police.wanted}, player.kills ${kills0} -> ${game.player.kills}, bDead=${b.dead}`);
    } else { out.notes.push('copFF: could not obtain two cops'); }
  }

  // ---------------------------------------------------------------- 2. police arrive + bust
  {
    game.police.clearWanted();
    for (let i = 0; i < 30; i++) step();
    const sp = game.city.spawns.missionPoints[2];
    game.player.reset(sp.x, game.worldToGround(sp.x, sp.z) + 0.1, sp.z, 0);
    for (let i = 0; i < 60; i++) step();
    game.police.addWanted(3, 'test');
    let firstCarNear = -1; let firstCop = -1; let busted = -1;
    const busts0 = game.police.busts;
    for (let i = 0; i < 60 * 60; i++) {
      step();
      const p = game.player.position;
      if (firstCarNear < 0) {
        for (const u of game.police.cars) {
          const v = u.vehicle; if (!v) continue;
          const d = Math.hypot(v.position[0] - p[0], v.position[2] - p[2]);
          if (d < 30) { firstCarNear = i; break; }
        }
      }
      if (firstCop < 0 && game.police.cops.length > 0) firstCop = i;
      if (busted < 0 && game.police.busts > busts0) { busted = i; break; }
    }
    out.notes.push(`pursuit: cruiser<30m at frame ${firstCarNear}, first cop at ${firstCop}, busted at ${busted}, cars=${game.police.cars.length}, cops=${game.police.cops.length}, wanted=${game.police.wanted}`);
  }

  // ---------------------------------------------------------------- 3. de-escalation
  {
    game.police.clearWanted();
    for (let i = 0; i < 30; i++) step();
    game.police.addWanted(2, 'test');
    let cleared = -1;
    for (let i = 0; i < 60 * 120; i++) {
      // teleport the player far away every 200 frames so nobody can see him
      if (i % 200 === 0) {
        const s = game.city.spawns.peds[(i / 200 * 37 + 11) % game.city.spawns.peds.length];
        game.player.reset(s.x, game.worldToGround(s.x, s.z) + 0.1, s.z, 0);
      }
      step();
      if (game.police.wanted === 0) { cleared = i; break; }
    }
    out.notes.push(`de-escalate from 2 stars: cleared at frame ${cleared} (${(cleared / 60).toFixed(1)}s), leftover cars=${game.police.cars.length} cops=${game.police.cops.length}`);
  }

  // ---------------------------------------------------------------- 4. ped health
  {
    game.police.clearWanted();
    const states = {}; const stuck = {}; let minSpeed = 1e9; let crossed = 0;
    const seenCross = new Set();
    const still = new Map();
    for (let i = 0; i < 60 * 60; i++) {
      step();
      for (const ped of game.peds.peds) {
        states[ped.state] = (states[ped.state] || 0) + 1;
        if (ped.state === 'cross' && ped.crossing) seenCross.add(ped.id);
        if (!ped.dead && (ped.state === 'walk')) {
          const k = ped.id;
          if (ped.speed < 0.05) still.set(k, (still.get(k) || 0) + 1);
          else still.set(k, 0);
        }
      }
    }
    let maxStill = 0;
    still.forEach((v) => { if (v > maxStill) maxStill = v; });
    out.notes.push(`ped states over 60s: ${JSON.stringify(states)}`);
    out.notes.push(`peds that stepped onto a crossing: ${seenCross.size}; longest 'walk' with ~0 speed: ${maxStill} frames`);
  }

  // ---------------------------------------------------------------- 5. traffic health
  {
    let n = 0; let sumSpeed = 0; let stopped = 0; let flipped = 0; let maxAbsRoll = 0;
    const stillFrames = new Map();
    let maxStill = 0;
    for (let i = 0; i < 60 * 60; i++) {
      step();
      for (const v of game.traffic.vehicles) {
        n++;
        const s = Math.hypot(v.velocity[0], v.velocity[2]);
        sumSpeed += s;
        if (s < 0.2) stopped++;
        const r = Math.abs(v.roll || 0);
        if (r > maxAbsRoll) maxAbsRoll = r;
        if (r > 1.2) flipped++;
        const k = v.ai ? v.ai.seed : 0;
        if (s < 0.2) stillFrames.set(k, (stillFrames.get(k) || 0) + 1);
        else stillFrames.set(k, 0);
        const c = stillFrames.get(k);
        if (c > maxStill) maxStill = c;
      }
    }
    out.notes.push(`traffic: samples=${n}, mean speed ${(sumSpeed / Math.max(1, n)).toFixed(2)} m/s, stopped ${(100 * stopped / Math.max(1, n)).toFixed(1)}%, flipped samples ${flipped}, maxRoll ${maxAbsRoll.toFixed(2)}, longest continuously-stopped run ${maxStill} frames`);
    out.notes.push(`traffic counts: live=${game.traffic.vehicles.length} wrecks=${game.traffic.wrecks.length} orphans=${game.traffic.orphans.length} pool=${JSON.stringify(Array.from(game.traffic._pool.entries()).map(([k, a]) => [k, a.length]))}`);
    out.notes.push(`game.vehicles=${game.vehicles.length}`);
  }

  // ---------------------------------------------------------------- 6. skating check
  {
    const bad = [];
    game.police.addWanted(4, 'test');
    for (let i = 0; i < 60 * 40; i++) {
      step();
      for (const cop of game.police.cops) {
        if (cop.dead || !cop.character) continue;
        if (cop.speed > 1.2 && (cop.character.state === 'aim' || cop.character.state === 'reload' || cop.character.state === 'idle')) {
          bad.push(`cop speed ${cop.speed.toFixed(2)} clip ${cop.character.state} state ${cop.state}`);
        }
      }
      for (const ped of game.peds.peds) {
        if (ped.dead || !ped.character) continue;
        if (ped.speed > 1.2 && (ped.character.state === 'aim' || ped.character.state === 'idle' || ped.character.state === 'crouch')) {
          bad.push(`ped speed ${ped.speed.toFixed(2)} clip ${ped.character.state} state ${ped.state}`);
        }
      }
      if (bad.length > 12) break;
    }
    out.notes.push(`skating samples (${bad.length}): ${JSON.stringify(bad.slice(0, 8))}`);
    game.police.clearWanted();
  }
  return out;
}
