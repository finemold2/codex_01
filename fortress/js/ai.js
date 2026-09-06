'use strict';
/* ai.js — 탄도 시뮬레이션 기반 AI */
const AI = (() => {
  const DIFF = {
    easy:   { angleErr: 7,   powerErr: 9,   moveChance: 0.2, fine: false, targetNoise: 40 },
    normal: { angleErr: 2.5, powerErr: 3,   moveChance: 0.5, fine: true,  targetNoise: 15 },
    hard:   { angleErr: 0.6, powerErr: 0.7, moveChance: 0.8, fine: true,  targetNoise: 5 },
  };

  function simulate(sx, sy, angle, power, wind, ground, tanks, ownerId) {
    const p = makeProjectile(sx, sy, angle, power, ownerId, null);
    for (let i = 0; i < PHYS.MAX_STEPS; i++) {
      stepProjectile(p, wind);
      const c = collideProjectile(p, ground, tanks, ownerId);
      if (c) return c;
    }
    return { type: 'out' };
  }

  function pickTarget(me, tanks, noise) {
    const enemies = tanks.filter((t) => t.alive && t.team !== me.team);
    if (!enemies.length) return null;
    let best = null, bs = -Infinity;
    for (const e of enemies) {
      const d = Math.abs(e.x - me.x);
      const s = (100 - e.hp) * 0.6 - d * 0.05 + Math.random() * noise;
      if (s > bs) { bs = s; best = e; }
    }
    return best;
  }

  /** 주어진 위치(shooter)에서 target을 맞추는 (각도, 파워) 탐색 */
  function solve(shooter, target, wind, ground, tanks, weapon, fine) {
    const allies = tanks.filter((t) => t.alive && t.team === shooter.team);
    const R = weapon.radius * 1.4;

    function score(ang, pow) {
      const a = (ang * Math.PI) / 180;
      const sx = shooter.x + Math.cos(a) * 26, sy = shooter.y - 16 - Math.sin(a) * 26;
      const r = simulate(sx, sy, ang, pow, wind, ground, tanks, shooter.id);
      if (r.type === 'out') return Infinity;
      let err = Math.hypot(r.x - target.cx, r.y - target.cy);
      if (r.type === 'tank' && r.tank === target) err = 0;
      for (const al of allies) {
        const d = Math.hypot(r.x - al.cx, r.y - al.cy);
        if (d < R) err += (R - d) * 3 + 40;   // 아군/자기 피해 회피
      }
      return err;
    }

    let best = { err: Infinity, ang: 45, pow: 50 };
    for (let ang = 5; ang <= 175; ang += 2.5) {
      for (let pow = 15; pow <= 100; pow += 2.5) {
        const err = score(ang, pow);
        if (err < best.err) { best = { err, ang, pow }; if (err < 1) return best; }
      }
    }
    if (fine && best.err < 200) {
      const b0 = best;
      for (let da = -2.5; da <= 2.5; da += 0.5) {
        for (let dp = -2.5; dp <= 2.5; dp += 0.5) {
          const ang = b0.ang + da, pow = clamp(b0.pow + dp, 10, 100);
          if (ang < 0 || ang > 180) continue;
          const err = score(ang, pow);
          if (err < best.err) { best = { err, ang, pow }; if (err < 1) return best; }
        }
      }
    }
    return best;
  }

  function chooseWeapon(me, target, enemyCount) {
    if (me.ammo.nuke > 0 && (target.hp > 45 || enemyCount >= 3) && Math.random() < 0.7) return 2;
    if (me.ammo.triple > 0 && Math.random() < 0.45) return 1;
    if (me.ammo.digger > 0 && Math.random() < 0.15) return 3;
    return 0;
  }

  /**
   * 턴 계획: { dx, angle, power, weapon, target } 또는 null(적 없음)
   * game.probeWalk(tank, dx) → {x, y} 실제 도달 가능 위치
   */
  function plan(game, me) {
    const d = DIFF[game.difficulty] || DIFF.normal;
    const tanks = game.tanks;
    const target = pickTarget(me, tanks, d.targetNoise);
    if (!target) return null;

    const enemyCount = tanks.filter((t) => t.alive && t.team !== me.team).length;
    const wIdx = chooseWeapon(me, target, enemyCount);
    const weapon = WEAPONS[wIdx];

    const candidates = [0];
    if (Math.random() < d.moveChance) {
      candidates.push(-MAX_FUEL * 0.95, MAX_FUEL * 0.95, -MAX_FUEL * 0.5, MAX_FUEL * 0.5);
    }

    let best = null;
    for (const dx of candidates) {
      const pos = dx === 0 ? { x: me.x, y: me.y } : game.probeWalk(me, dx);
      const ghost = { id: me.id, team: me.team, alive: true, x: pos.x, y: pos.y, cx: pos.x, cy: pos.y - 10 };
      const simTanks = tanks.map((t) => (t === me ? ghost : t));
      const s = solve(ghost, target, game.wind, game.ground, simTanks, weapon, d.fine);
      s.dx = pos.x - me.x;
      if (!best || s.err < best.err - 8) best = s;   // 이동은 확실히 나을 때만
      if (best.err < 2 && dx === 0) break;
    }

    const angle = clamp(best.ang + (Math.random() * 2 - 1) * d.angleErr, 1, 179);
    const power = clamp(best.pow + (Math.random() * 2 - 1) * d.powerErr, 10, 100);
    return { dx: best.dx, angle, power, weapon: wIdx, target, err: best.err };
  }

  return { plan, DIFF };
})();
