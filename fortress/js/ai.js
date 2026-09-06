'use strict';
/* ai.js — 탄도 시뮬레이션 기반 AI */
const AI = (() => {
  const DIFF = {
    easy:   { angleErr: 7.0, powerErr: 9.0, moveChance: 0.20, fine: false, targetNoise: 42, weaponNoise: 40, coarse: 3.0 },
    normal: { angleErr: 2.4, powerErr: 3.0, moveChance: 0.50, fine: true,  targetNoise: 16, weaponNoise: 18, coarse: 2.5 },
    hard:   { angleErr: 0.6, powerErr: 0.7, moveChance: 0.80, fine: true,  targetNoise: 5,  weaponNoise: 6,  coarse: 2.0 },
  };

  /** 발사 결과 시뮬레이션 — 착탄점과 정점을 함께 반환 */
  function simulate(sx, sy, angle, power, powerMul, wind, ground, tanks, ownerId, weapon) {
    const p = makeProjectile(sx, sy, angle, power, ownerId, weapon, { powerMul });
    let apexX = sx, apexY = sy, peaked = false;
    for (let i = 0; i < PHYS.MAX_STEPS; i++) {
      stepProjectile(p, wind);
      if (!peaked && p.vy >= 0 && p.t > 6) { peaked = true; apexX = p.x; apexY = p.y; }
      const c = collideProjectile(p, ground, tanks, ownerId);
      if (c) { c.apexX = apexX; c.apexY = apexY; c.peaked = peaked; return c; }
    }
    return { type: 'out', x: p.x, y: p.y, apexX, apexY, peaked };
  }

  function pickTarget(me, tanks, noise) {
    const enemies = tanks.filter((t) => t.alive && t.team !== me.team);
    if (!enemies.length) return null;
    let best = null, bs = -Infinity;
    for (const e of enemies) {
      const d = Math.abs(e.x - me.x);
      const s = (e.maxHp - e.hp) * 0.55 - d * 0.045 + (e.hp < 35 ? 40 : 0) + Math.random() * noise;
      if (s > bs) { bs = s; best = e; }
    }
    return best;
  }

  /** 무기 선호도 */
  function weaponScore(id, me, target, dist, enemyCount, noise) {
    const w = WEAPONS[id];
    if (!w) return -1;
    const ammo = me.ammo[id];
    if (ammo !== Infinity && ammo <= 0) return -1;

    let s;
    switch (id) {
      case 'shell': s = 42; break;
      case 'nuke': s = (target.hp > 55 || enemyCount >= 3) ? 140 : 62; break;
      case 'quake': s = 78 + (dist < 420 ? 14 : 0); break;
      case 'mirv': s = 88; break;
      case 'cluster': s = 76; break;
      case 'sniper': s = dist > 480 ? 92 : 66; break;
      case 'flak': s = 84; break;
      case 'napalm': s = target.hp > 30 ? 82 : 48; break;
      case 'chain': s = 74; break;
      case 'roller': s = 72; break;
      case 'drill': s = 62; break;
      case 'frost': s = 80; break;
      case 'hail': s = 66; break;
      case 'multi6': s = 70; break;
      case 'multi3': s = 62; break;
      case 'twin': s = 60; break;
      case 'bunker': s = me.hp < me.maxHp * 0.4 ? 46 : 4; break;
      case 'teleport': s = 6; break;
      default: s = 50;
    }
    // 탄약이 적으면 아껴 쓴다
    if (ammo !== Infinity && ammo <= 1) s *= 0.8;
    return s + (Math.random() * 2 - 1) * noise;
  }

  function chooseWeapon(me, target, dist, enemyCount, noise) {
    let bi = 0, bs = -Infinity;
    for (let i = 0; i < me.weapons.length; i++) {
      const s = weaponScore(me.weapons[i], me, target, dist, enemyCount, noise);
      if (s > bs) { bs = s; bi = i; }
    }
    return bi;
  }

  /** 사격 해 탐색 */
  function solve(shooter, target, wind, ground, tanks, weapon, d, powerMul, minElev, maxElev) {
    const allies = tanks.filter((t) => t.alive && t.team === shooter.team);
    const avoidR = Math.max(28, weapon.radius * 1.4);
    const airburst = weapon.behavior === 'airburst';

    function score(ang, pow) {
      const a = (ang * Math.PI) / 180;
      const sx = shooter.x + Math.cos(a) * 26;
      const sy = shooter.y - 18 - Math.sin(a) * 26;
      const r = simulate(sx, sy, ang, pow, powerMul, wind, ground, tanks, shooter.id, weapon);
      let hx = r.x, hy = r.y;
      if (airburst && r.peaked) { hx = r.apexX; hy = r.apexY; }
      else if (r.type === 'out') return Infinity;
      let err = Math.hypot(hx - target.cx, hy - target.cy);
      if (r.type === 'tank' && r.tank === target) err = 0;
      for (const al of allies) {
        const dd = Math.hypot(hx - al.cx, hy - al.cy);
        if (dd < avoidR) err += (avoidR - dd) * 3.2 + 45;
      }
      return err;
    }

    // 유효 절대 각도 구간 (오른쪽 조준 / 왼쪽 조준)
    const ranges = [[Math.max(1, minElev), Math.min(179, maxElev)], [Math.max(1, 180 - maxElev), Math.min(179, 180 - minElev)]];
    let best = { err: Infinity, ang: 45, pow: 55 };
    for (const [a0, a1] of ranges) {
      for (let ang = a0; ang <= a1; ang += d.coarse) {
        for (let pow = 14; pow <= 100; pow += 2.5) {
          const err = score(ang, pow);
          if (err < best.err) { best = { err, ang, pow }; if (err < 1) return best; }
        }
      }
    }
    if (d.fine && best.err < 240) {
      const b0 = best;
      for (let da = -d.coarse; da <= d.coarse; da += 0.4) {
        for (let dp = -2.5; dp <= 2.5; dp += 0.4) {
          const ang = b0.ang + da, pow = clamp(b0.pow + dp, 10, 100);
          if (ang < 1 || ang > 179) continue;
          const err = score(ang, pow);
          if (err < best.err) { best = { err, ang, pow }; if (err < 1) return best; }
        }
      }
    }
    return best;
  }

  /**
   * 턴 계획 → { dx, angle, power, weapon, target, err } 또는 null
   */
  function plan(game, me) {
    const d = DIFF[game.difficulty] || DIFF.normal;
    const tanks = game.tanks;
    const target = pickTarget(me, tanks, d.targetNoise);
    if (!target) return null;

    const enemyCount = tanks.filter((t) => t.alive && t.team !== me.team).length;
    const dist = Math.abs(target.x - me.x);
    let wIdx = chooseWeapon(me, target, dist, enemyCount, d.weaponNoise);
    let weapon = WEAPONS[me.weapons[wIdx]];

    const fuel = me.fuel;
    const candidates = [0];
    if (Math.random() < d.moveChance && fuel > 20) {
      candidates.push(-fuel * 0.95, fuel * 0.95, -fuel * 0.5, fuel * 0.5);
    }

    let best = null;
    for (const dx of candidates) {
      const pos = dx === 0 ? { x: me.x, y: me.y } : game.probeWalk(me, dx);
      const ghost = {
        id: me.id, team: me.team, alive: true, x: pos.x, y: pos.y,
        cx: pos.x, cy: pos.y - 12 * me.type.size, hitR: me.hitR,
      };
      const simTanks = tanks.map((t) => (t === me ? ghost : t));
      const s = solve(ghost, target, game.wind, game.ground, simTanks, weapon, d, me.type.power, me.type.minElev, me.type.maxElev);
      s.dx = pos.x - me.x;
      if (!best || s.err < best.err - 9) best = s;
      if (best.err < 3 && dx === 0) break;
    }

    // 아무리 해도 못 맞추면: 순간이동이 있으면 적 쪽으로 도약
    if (best.err > 150 && me.ammo.teleport > 0 && me.weapons.indexOf('teleport') >= 0) {
      const tIdx = me.weapons.indexOf('teleport');
      const jumpX = clamp(me.x + Math.sign(target.x - me.x) * (240 + Math.random() * 220), 40, W - 40);
      const jump = { cx: jumpX, cy: Terrain.heightAt(game.ground, jumpX) - 12, team: -1, alive: true, id: -9, x: jumpX };
      const s = solve(me, jump, game.wind, game.ground, tanks, WEAPONS.teleport, d, me.type.power, me.type.minElev, me.type.maxElev);
      if (s.err < best.err) {
        return { dx: 0, angle: clamp(s.ang, 1, 179), power: clamp(s.pow, 10, 100), weapon: tIdx, target, err: s.err };
      }
    }

    const angle = clamp(best.ang + (Math.random() * 2 - 1) * d.angleErr, 1, 179);
    const power = clamp(best.pow + (Math.random() * 2 - 1) * d.powerErr, 10, 100);
    return { dx: best.dx, angle, power, weapon: wIdx, target, err: best.err };
  }

  return { plan, DIFF, simulate };
})();
