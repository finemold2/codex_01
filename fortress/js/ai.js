'use strict';
/* ai.js — 탄도 시뮬레이션 기반 AI */
const AI = (() => {
  const DIFF = {
    easy:   { angleErr: 7.0, powerErr: 9.0, moveChance: 0.20, fine: false, targetNoise: 42, weaponNoise: 40, coarse: 3.0,
              crateChance: 0.30, crateSmart: false, itemChance: 0.45, itemSmart: false, itemBar: 30 },
    normal: { angleErr: 2.4, powerErr: 3.0, moveChance: 0.50, fine: true,  targetNoise: 16, weaponNoise: 18, coarse: 2.5,
              crateChance: 0.68, crateSmart: true,  itemChance: 0.75, itemSmart: true,  itemBar: 52 },
    hard:   { angleErr: 0.6, powerErr: 0.7, moveChance: 0.80, fine: true,  targetNoise: 5,  weaponNoise: 6,  coarse: 2.0,
              crateChance: 0.92, crateSmart: true,  itemChance: 0.92, itemSmart: true,  itemBar: 42 },
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

  /* ─────────────── 아이템 판단 ─────────────── */

  /** 특수탄이 얼마나 바닥났는지 0~1 */
  function ammoStarve(me) {
    let total = 0, empty = 0;
    for (const id of me.weapons) {
      const a = me.ammo[id];
      if (a === Infinity) continue;
      total++;
      if (a <= 0) empty++;
    }
    return total ? empty / total : 0;
  }

  function nearestEnemyDist(game, me) {
    let d = Infinity;
    for (const t of game.tanks) {
      if (!t.alive || t.team === me.team) continue;
      d = Math.min(d, Math.abs(t.x - me.x));
    }
    return d;
  }

  function hurtAlly(game, me) {
    for (const t of game.tanks) {
      if (t.alive && t !== me && t.team === me.team && t.hp < t.maxHp * 0.7) return true;
    }
    return false;
  }

  const CRATE_BASE = { common: 34, rare: 62, epic: 98, legend: 142 };

  /**
   * 상자 하나가 지금 나에게 얼마나 값어치가 있는지.
   * smart=false 면 내용물을 모르는 셈 치고 대충 값을 매깁니다 (쉬움 난이도).
   */
  function crateValue(game, me, c, smart) {
    if (!smart) return 40 + Math.random() * 26;
    const def = typeof itemDef === 'function' && c.item ? itemDef(c.item.id) : null;
    if (!def) return 42;
    const hurt = 1 - me.hp / me.maxHp;
    let v = (CRATE_BASE[def.rarity] || 40) * (0.75 + (c.item.roll || 1) * 0.3);
    switch (def.cat) {
      case 'heal':     v *= 0.28 + hurt * 2.2; break;                      // 멀쩡하면 굳이
      case 'defense':  v *= 0.62 + hurt * 1.05; break;
      case 'ammo':     v *= 0.72 + ammoStarve(me) * 1.15; break;
      case 'support':  v *= hurtAlly(game, me) ? 1.0 : 0.42; break;
      case 'mobility': v *= me.fuel < me.type.fuel * 0.5 ? 0.8 : 0.45; break;
      case 'eco':      v *= 0.38; break;
      case 'tactic':   v *= 0.95; break;
      default:         break;                                             // offense 는 그대로
    }
    if (c.item.perm) v *= 1.25;
    return v;
  }

  /** 지금 쓸 만한 사용형 아이템 고르기 → 인덱스 (없으면 -1) */
  function pickItem(game, me, difficulty) {
    const d = DIFF[difficulty] || DIFF.normal;
    if (!me.items || !me.items.length) return -1;
    if (Math.random() > d.itemChance) return -1;
    if (!d.itemSmart) return Math.floor(Math.random() * me.items.length);

    const hurt = 1 - me.hp / me.maxHp;
    const near = nearestEnemyDist(game, me);
    const ally = hurtAlly(game, me);
    const fuelLow = me.fuel < me.type.fuel * 0.4;

    let bi = -1, bs = -Infinity;
    for (let i = 0; i < me.items.length; i++) {
      const inst = me.items[i];
      const def = typeof itemDef === 'function' ? itemDef(inst.id) : null;
      if (!def || !def.apply) continue;
      let s;
      switch (inst.id) {
        // 이번 사격을 강하게 — 적이 사정권일 때만 값어치가 있습니다
        case 'homing':     s = 82; break;
        case 'double_tap': s = 78; break;
        case 'overcharge': s = 64; break;
        case 'splitfuse':  s = 62; break;
        case 'pierce':     s = 60; break;
        case 'lowgrav':    s = near > 620 ? 66 : 34; break;
        case 'bounce':     s = 46; break;
        // 직접 피해 — 언제든 좋습니다
        case 'strike': case 'meteor': case 'quakebomb': s = 86; break;
        case 'acid':       s = 74; break;
        // 방어 — 맞고 있을 때
        case 'shield':     s = 34 + hurt * 76; break;
        case 'dome':       s = 30 + hurt * 74; break;
        case 'dodge':      s = 28 + hurt * 62; break;
        case 'trench': case 'wall': s = 18 + hurt * 62; break;
        case 'smoke':      s = 20 + hurt * 54; break;
        // 방해 — 적이 가까울수록
        case 'mine': case 'minefield': case 'oil': s = near < 380 ? 62 : 24; break;
        case 'emp': case 'sabotage': s = 58; break;
        case 'windctl':    s = 30; break;
        case 'storm':      s = 22; break;
        // 기동
        case 'refuel':     s = fuelLow ? 58 : 6; break;
        case 'blink':      s = hurt > 0.6 || near < 220 ? 56 : 14; break;
        // 지원
        case 'medevac': case 'resupply': case 'command': s = ally ? 70 : 18; break;
        case 'airdrop':    s = 40; break;
        case 'shuffle':    s = hurt > 0.55 ? 48 : 16; break;
        case 'restore':    s = 20; break;
        default:
          s = def.cat === 'heal' ? 25 + hurt * 80 : def.cat === 'eco' ? 22 : 45;
      }
      s += (Math.random() * 2 - 1) * 12;
      if (s > bs) { bs = s; bi = i; }
    }
    return bs >= d.itemBar ? bi : -1;
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
    // { dx, bonus } — bonus 가 클수록 그 자리로 가려고 합니다
    const candidates = [{ dx: 0, bonus: 0 }];
    if (Math.random() < d.moveChance && fuel > 20) {
      for (const dx of [-fuel * 0.95, fuel * 0.95, -fuel * 0.5, fuel * 0.5]) candidates.push({ dx, bonus: 0 });
    }
    // 보급 상자 — 값어치를 따져 보고 주우러 갈지 정합니다
    const reach = 26 * me.type.size * (me.buffs.magnet || 1);
    if (game.crates && game.crates.length && Math.random() < d.crateChance) {
      for (const c of game.crates) {
        if (!c.landed) continue;
        const dx = c.x - me.x;
        const walk = Math.abs(dx) - reach * 0.8;
        if (walk > fuel) continue;                       // 연료로는 닿지 않습니다
        let bonus = crateValue(game, me, c, d.crateSmart);
        // 나보다 가까운 적이 있으면 먼저 뺏길 공산이 큽니다
        for (const e of tanks) {
          if (e.alive && e.team !== me.team && Math.abs(e.x - c.x) < Math.abs(dx) * 0.8) { bonus *= 0.55; break; }
        }
        // 이동 비용 — 멀수록, 그리고 체력이 없을수록 손해
        bonus -= Math.max(0, walk) * (0.05 + (1 - me.hp / me.maxHp) * 0.06);
        if (bonus > 10) candidates.push({ dx, bonus, crate: c });
      }
    }

    // 확실한 마무리 한 방이 보이면 상자는 나중에
    const lethal = target.hp <= (weapon.damage || 30) * 0.95;

    let best = null;
    for (const cand of candidates) {
      const dx = cand.dx;
      const pos = dx === 0 ? { x: me.x, y: me.y } : game.probeWalk(me, dx);
      let bonus = cand.bonus;
      if (cand.crate) {
        // 지형에 막혀 실제로는 상자까지 못 가는 경우가 있습니다
        if (Math.abs(pos.x - cand.crate.x) > reach) bonus = 0;
        else if (lethal && best && best.err < 5) bonus *= 0.25;
      }
      const ghost = {
        id: me.id, team: me.team, alive: true, x: pos.x, y: pos.y,
        cx: pos.x, cy: pos.y - 12 * me.type.size, hitR: me.hitR,
      };
      const simTanks = tanks.map((t) => (t === me ? ghost : t));
      const s = solve(ghost, target, game.wind, game.ground, simTanks, weapon, d, me.type.power * (me.buffs.power || 1), me.type.minElev, me.type.maxElev);
      s.dx = pos.x - me.x;
      s.adj = s.err - bonus;
      s.crate = cand.crate || null;
      if (!best || s.adj < best.adj - 9) best = s;
      // 제자리에서 완벽한 해가 나와도, 노려 볼 상자가 있으면 마저 따져 봅니다
      if (best.err < 3 && dx === 0 && !candidates.some((c) => c.crate)) break;
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
    return { dx: best.dx, angle, power, weapon: wIdx, target, err: best.err, crate: best.crate || null };
  }

  return { plan, pickItem, crateValue, DIFF, simulate };
})();
