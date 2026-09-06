'use strict';
/* game.js — 턴 상태 머신, 무기 동작, 물리, 렌더 파이프라인 */

const SUDDEN_DEATH_ROUND = 16;
const SUDDEN_DEATH_DMG = 7;
const TURN_SECONDS = 32;

/** Gfx/FX 모듈이 없어도 게임이 죽지 않도록 하는 최소 대체 구현 */
const HAS_GFX = typeof Gfx !== 'undefined' && Gfx && typeof Gfx.createScene === 'function';
const HAS_FX = typeof FX !== 'undefined' && FX && typeof FX.explosion === 'function';
const HAS_MUSIC = typeof Music !== 'undefined' && Music && typeof Music.start === 'function';

function gfxThemes() {
  if (HAS_GFX && Gfx.THEMES) return Gfx.THEMES;
  return { plain: { name: '초원' } };
}

function terrainStyleFor(key, theme) {
  if (theme && theme.terrain && Terrain.STYLES[theme.terrain]) return theme.terrain;
  const s = (key + ' ' + ((theme && theme.name) || '')).toLowerCase();
  if (/desert|sand|사막|dune/.test(s)) return 'dunes';
  if (/canyon|협곡|mesa|cliff|badland/.test(s)) return 'jagged';
  if (/volcan|화산|lava|magma|ash/.test(s)) return 'volcanic';
  if (/city|urban|도시|night|야간|neon/.test(s)) return 'urban';
  if (/snow|설원|ice|glacier|arctic|tundra/.test(s)) return 'plateau';
  return 'rolling';
}

class Game {
  /**
   * cfg: { players:[{name,isAI,team,color,typeId}], difficulty, theme, teamMode }
   * ui:  { onTurn, refresh, frame, banner, onGameOver }
   */
  constructor(canvas, cfg, ui) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cfg = cfg;
    this.ui = ui;
    this.difficulty = cfg.difficulty || 'normal';
    this.teamMode = !!cfg.teamMode;

    const themes = gfxThemes();
    const keys = Object.keys(themes);
    this.themeKey = cfg.theme && themes[cfg.theme] ? cfg.theme : keys[Math.floor(Math.random() * keys.length)];
    this.theme = themes[this.themeKey] || {};

    this.seed = (Math.random() * 1e9) >>> 0;
    this.ground = Terrain.generate(W, H, this.seed, terrainStyleFor(this.themeKey, this.theme));
    this.scene = HAS_GFX ? Gfx.createScene(this.seed, this.themeKey) : null;
    if (HAS_FX) { FX.reset(); FX.setWind && FX.setWind(0); }

    this.tanks = this.placeTanks(cfg.players);

    this.turnIdx = -1;
    this.round = 1;
    this.wind = 0;
    this.projectiles = [];
    this.pending = [];        // 지연 폭발 (연쇄탄 등)
    this.burns = [];          // 네이팜 불바다
    this.floaters = [];
    this.time = 0;
    this.stateT = 0;
    this.turnLeft = TURN_SECONDS;
    this.state = 'intro';
    this.input = { left: false, right: false, up: false, down: false, pup: false, pdown: false };
    this.charging = false;
    this.chargeDir = 1;
    this.winnerTeam = undefined;
    this.running = true;
    this.acc = 0;
    this.last = performance.now();
    this.stats = { shots: 0, totalDamage: 0 };

    this.nextTurn();
    this._loop = this.loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  destroy() {
    this.running = false;
    if (typeof Sfx !== 'undefined') { Sfx.chargeStop && Sfx.chargeStop(); Sfx.engine && Sfx.engine(false); }
  }

  /** 겹치지 않고 너무 가파르지 않은 자리에 배치 */
  placeTanks(players) {
    const n = players.length;
    const slots = Array.from({ length: n }, (_, i) => i).sort(() => Math.random() - 0.5);
    const used = [];
    return players.map((p, i) => {
      const k = slots[i];
      const lo = 70 + ((W - 140) * k) / n;
      const hi = 70 + ((W - 140) * (k + 1)) / n;
      let best = (lo + hi) / 2, bestScore = -Infinity;
      for (let a = 0; a < 26; a++) {
        const x = Math.round(lo + Math.random() * (hi - lo));
        const gl = Terrain.heightAt(this.ground, x - 14);
        const gr = Terrain.heightAt(this.ground, x + 14);
        let score = -Math.abs(gr - gl) * 3;
        for (const u of used) score -= Math.max(0, 150 - Math.abs(u - x));
        if (score > bestScore) { bestScore = score; best = x; }
      }
      used.push(best);
      return new Tank({
        id: i, name: p.name, color: p.color, team: p.team, isAI: p.isAI, typeId: p.typeId,
        x: best, y: Terrain.heightAt(this.ground, best), facing: best < W / 2 ? 1 : -1,
      });
    });
  }

  /* ─────────────────── 턴 관리 ─────────────────── */

  setState(s) { this.state = s; this.stateT = 0; }
  aliveTeams() { return new Set(this.tanks.filter((t) => t.alive).map((t) => t.team)); }
  aliveTanks() { return this.tanks.filter((t) => t.alive); }

  nextTurn() {
    if (typeof Sfx !== 'undefined') { Sfx.chargeStop && Sfx.chargeStop(); Sfx.engine && Sfx.engine(false); }
    this.charging = false;
    this.applyBurns();
    if (this.checkWin()) return;

    const n = this.tanks.length;
    let i = this.turnIdx;
    let wrapped = false;
    for (let k = 0; k < n; k++) {
      i = (i + 1) % n;
      if (i <= this.turnIdx) wrapped = true;
      if (this.tanks[i].alive) break;
    }
    if (wrapped) {
      this.round++;
      if (this.round >= SUDDEN_DEATH_ROUND) {
        this.ui.banner(this.round === SUDDEN_DEATH_ROUND ? '☠ 서든데스 — 매 라운드 체력이 깎입니다' : '☠ 서든데스', 1600);
        if (typeof Sfx !== 'undefined' && Sfx.warning) Sfx.warning();
        for (const t of this.tanks) if (t.alive) this.damage(t, SUDDEN_DEATH_DMG, null, true);
        if (this.checkWin()) return;
        for (let k = 0; k < n; k++) { if (this.tanks[i].alive) break; i = (i + 1) % n; }
      }
    }

    this.turnIdx = i;
    this.cur = this.tanks[i];
    const t = this.cur;
    t.fuel = t.frozen > 0 ? Math.round(t.maxFuel * 0.3) : t.maxFuel;
    if (t.frozen > 0) t.frozen--;
    if (!t.hasAmmo(t.weapon)) {
      t.weapon = 0;
      for (let k = 0; k < t.weapons.length; k++) if (t.hasAmmo(k)) { t.weapon = k; break; }
    }
    this.wind = Math.round(clamp(this.wind * 0.35 + (Math.random() * 2 - 1) * 9.5, -10, 10) * 10) / 10;
    if (HAS_FX && FX.setWind) FX.setWind(this.wind);
    if (typeof Sfx !== 'undefined' && Sfx.windGust) Sfx.windGust(this.wind);
    this.turnLeft = TURN_SECONDS;
    this.ai = t.isAI ? { phase: 'wait', t: 0, plan: null, moved: 0 } : null;
    this.setState('intro');
    this.ui.banner(`${t.name} 턴${t.isAI ? '' : ' — 당신 차례!'}`, 1000);
    if (typeof Sfx !== 'undefined' && Sfx.turnStart) Sfx.turnStart(!t.isAI);
    this.updateMusicIntensity();
    this.ui.onTurn(this);
  }

  updateMusicIntensity() {
    if (!HAS_MUSIC || !Music.setIntensity) return;
    const alive = this.aliveTanks();
    if (!alive.length) return;
    const hpAvg = alive.reduce((s, t) => s + t.hp / t.maxHp, 0) / alive.length;
    const dead = 1 - alive.length / this.tanks.length;
    Music.setIntensity(clamp(dead * 0.6 + (1 - hpAvg) * 0.6, 0, 1));
  }

  checkWin() {
    if (this.state === 'over') return true;
    const teams = this.aliveTeams();
    if (teams.size <= 1) {
      this.winnerTeam = teams.size ? [...teams][0] : null;
      this.setState('over');
      if (typeof Sfx !== 'undefined') {
        const won = this.tanks.some((t) => t.alive && !t.isAI);
        if (won && Sfx.win) Sfx.win(); else if (Sfx.lose) Sfx.lose();
      }
      this.ui.onGameOver(this);
      return true;
    }
    return false;
  }

  /* ─────────────────── 이동 ─────────────────── */

  walk(x, y, dir, dist, climb) {
    let used = 0;
    const maxSlope = climb || 1.7;
    while (used < dist) {
      const step = Math.min(1, dist - used);
      const nx = x + dir * step;
      if (nx < 18 || nx > W - 18) break;
      const gy = Terrain.heightAt(this.ground, nx);
      if (y - gy > maxSlope * step) break;
      x = nx; y = gy; used += step;
    }
    return { x, y, used };
  }

  probeWalk(t, dx) {
    const r = this.walk(t.x, t.y, Math.sign(dx), Math.min(Math.abs(dx), t.fuel), t.type.climb);
    return { x: r.x, y: r.y };
  }

  moveTank(t, dir, dt) {
    t.facing = dir;
    if (t.fuel <= 0) return 0;
    const r = this.walk(t.x, t.y, dir, Math.min(MOVE_SPEED * dt, t.fuel), t.type.climb);
    const moved = r.used;
    t.x = r.x; t.y = r.y; t.fuel -= moved;
    t.roll += moved * dir;
    if (moved > 0.01 && HAS_FX) FX.dust(t.x - dir * 14 * t.type.size, t.y, -dir);
    return moved;
  }

  /* ─────────────────── 사격 ─────────────────── */

  selectWeapon(idx) {
    const t = this.cur;
    if (this.state !== 'aim' || !t || t.isAI) return;
    if (idx < 0 || idx >= t.weapons.length || !t.hasAmmo(idx)) return;
    t.weapon = idx;
    if (typeof Sfx !== 'undefined' && Sfx.select) Sfx.select();
    this.ui.refresh(this);
  }

  cycleWeapon() {
    const t = this.cur;
    if (!t) return;
    for (let k = 1; k <= t.weapons.length; k++) {
      const idx = (t.weapon + k) % t.weapons.length;
      if (t.hasAmmo(idx)) { this.selectWeapon(idx); return; }
    }
  }

  startCharge() {
    if (this.state !== 'aim' || !this.cur || this.cur.isAI || this.charging) return;
    this.charging = true;
    this.cur.power = 0;
    this.chargeDir = 1;
  }

  releaseCharge() {
    if (!this.charging) return;
    this.charging = false;
    if (typeof Sfx !== 'undefined' && Sfx.chargeStop) Sfx.chargeStop();
    if (this.cur.power < 6) this.cur.power = 6;
    this.fire(this.cur);
  }

  fireNow() {
    if (this.state !== 'aim' || !this.cur || this.cur.isAI) return;
    this.charging = false;
    if (typeof Sfx !== 'undefined' && Sfx.chargeStop) Sfx.chargeStop();
    this.fire(this.cur);
  }

  /** 전차의 지면 기울기 (라디안) */
  tiltOf(t) {
    const s = t.type.size;
    const gl = Terrain.heightAt(this.ground, t.x - 13 * s);
    const gr = Terrain.heightAt(this.ground, t.x + 13 * s);
    return clamp(Math.atan2(gr - gl, 26 * s), -0.55, 0.55);
  }

  fire(t) {
    if (this.state !== 'aim') return;
    if (!t.hasAmmo(t.weapon)) {
      t.weapon = 0;
      if (!t.hasAmmo(0)) return;
    }
    const w = t.weaponDef();
    const id = w.id;
    if (t.ammo[id] !== Infinity) t.ammo[id]--;

    const tip = t.barrelTip;
    const offsets = w.count === 1 ? [0] : Array.from({ length: w.count }, (_, i) => (i - (w.count - 1) / 2) * w.spread);
    for (const off of offsets) {
      const p = makeProjectile(tip.x, tip.y, t.angle + off, t.power, t.id, w, { powerMul: t.type.power });
      this.projectiles.push(p);
    }
    t.lastPower = t.power;
    t.lastTrail = [];
    t.shots++;
    t.charge = 0;
    this.stats.shots++;

    if (HAS_FX) FX.muzzle(tip.x, tip.y, (-t.angle * Math.PI) / 180, t.power / 100);
    if (typeof Sfx !== 'undefined' && Sfx.fire) Sfx.fire(w.fire, t.power / 100);
    this.setState('fire');
    this.ui.refresh(this);
  }

  /* ─────────────────── 폭발 / 무기 동작 ─────────────────── */

  detonate(p, hit) {
    const w = p.child ? { ...p.weapon, radius: p.child.radius, damage: p.child.damage, behavior: 'std' } : p.weapon;
    const x = hit.x, y = hit.y;
    const owner = this.tanks[p.owner];

    switch (p.child ? 'std' : w.behavior) {
      case 'roller':
        // 지면에 닿으면 굴러가기 시작 (전차 직격이면 즉시 폭발)
        if (hit.type === 'ground' && !p.rolling) {
          p.rolling = true;
          p.rollT = 0;
          p.rollDir = p.vx >= 0 ? 1 : -1;
          p.rollSpeed = Math.max(1.6, Math.min(6, Math.abs(p.vx)));
          p.x = x; p.y = Terrain.heightAt(this.ground, x) - 3;
          return false;   // 아직 폭발하지 않음
        }
        this.explode(x, y, w, p.owner);
        return true;
      case 'drill': {
        this.explode(x, y, w, p.owner);
        Terrain.shaft(this.ground, x, 20, 190, H - 4);
        if (HAS_FX) { FX.debris(x, y, 16, '#6b4a2a'); FX.explosion(x, y + 60, 30, 'quake'); }
        return true;
      }
      case 'quake': {
        Terrain.collapse(this.ground, x, w.radius * 1.5, 46, H - 4);
        this.explode(x, y, w, p.owner);
        if (HAS_FX) { FX.shake(0.9); FX.explosion(x - w.radius * 0.6, y, w.radius * 0.5, 'quake'); FX.explosion(x + w.radius * 0.6, y, w.radius * 0.5, 'quake'); }
        return true;
      }
      case 'napalm': {
        this.explode(x, y, w, p.owner);
        this.burns.push({ x, y: Terrain.heightAt(this.ground, x), r: 62, turns: 3, owner: p.owner, t: 0 });
        return true;
      }
      case 'bunker': {
        Terrain.mound(this.ground, x, 62, 78, H * 0.2);
        if (HAS_FX) { FX.debris(x, y, 22, '#8a6b42'); FX.dust(x, y, 0); }
        if (typeof Sfx !== 'undefined' && Sfx.collapse) Sfx.collapse();
        this.floaters.push({ x, y: y - 30, text: '방어벽', t: 0, color: '#c9a227' });
        return true;
      }
      case 'teleport': {
        if (owner && owner.alive) {
          const nx = clamp(x, 24, W - 24);
          if (HAS_FX) FX.explosion(owner.x, owner.cy, 26, 'ice');
          owner.x = nx;
          owner.y = Terrain.heightAt(this.ground, nx);
          if (HAS_FX) FX.explosion(nx, owner.cy, 30, 'ice');
          if (typeof Sfx !== 'undefined' && Sfx.fire) Sfx.fire('laser', 0.5);
          this.floaters.push({ x: nx, y: owner.y - 46, text: '순간이동', t: 0, color: '#9fe8ff' });
        }
        return true;
      }
      case 'chain': {
        const dir = p.vx >= 0 ? 1 : -1;
        this.explode(x, y, w, p.owner);
        for (let i = 1; i <= 2; i++) {
          const cx = clamp(x + dir * 34 * i, 4, W - 4);
          this.pending.push({ delay: 0.14 * i, x: cx, y: Terrain.heightAt(this.ground, cx) - 4, w, owner: p.owner });
        }
        return true;
      }
      case 'frost': {
        this.explode(x, y, w, p.owner);
        const R = w.radius * 1.4;
        for (const t of this.tanks) {
          if (!t.alive) continue;
          if (Math.hypot(t.cx - x, t.cy - y) < R) {
            t.frozen = 2;
            this.floaters.push({ x: t.x, y: t.y - 62, text: '빙결!', t: 0, color: '#9fe8ff' });
          }
        }
        return true;
      }
      default:
        this.explode(x, y, w, p.owner);
        return true;
    }
  }

  explode(x, y, w, ownerId) {
    const r = w.radius;
    if (r > 0) Terrain.crater(this.ground, x, y, r, H - 4);
    if (HAS_FX) {
      FX.explosion(x, y, r, w.kind || 'normal');
      FX.shake(clamp(r / 90, 0.15, 1));
      if (r > 60) FX.flash(clamp((r - 50) / 90, 0, 0.7), w.kind === 'nuke' ? '#fff3d0' : '#ffd9a0');
    }
    if (typeof Sfx !== 'undefined' && Sfx.explode) Sfx.explode(r, w.kind || 'normal');

    const R = r * 1.35;
    if (R <= 0) return;
    for (const t of this.tanks) {
      if (!t.alive) continue;
      const d = Math.hypot(t.cx - x, t.cy - y);
      if (d < R) {
        let dmg = w.damage * (1 - d / R);
        if (d < r * 0.5) dmg = Math.max(dmg, w.damage * 0.88);
        this.damage(t, Math.round(dmg * t.type.armor), ownerId);
      }
    }
  }

  damage(t, dmg, srcId, silent) {
    if (dmg <= 0 || !t.alive) return;
    t.hp = Math.max(0, t.hp - dmg);
    const src = srcId != null && srcId >= 0 ? this.tanks[srcId] : null;
    const friendly = src && src !== t && src.team === t.team;
    if (src && src !== t && !friendly) { src.damageDealt += dmg; src.hits++; }
    this.stats.totalDamage += dmg;
    this.floaters.push({
      x: t.x, y: t.y - 56, text: `-${dmg}`, t: 0,
      color: friendly ? '#ffb347' : src === t ? '#cccccc' : '#ffffff',
      big: dmg >= 40,
    });
    if (!silent && typeof Sfx !== 'undefined' && Sfx.metalHit) Sfx.metalHit(clamp(dmg / 60, 0.2, 1));
    if (t.hp <= 0) {
      t.alive = false;
      if (HAS_FX) { FX.explosion(t.x, t.cy, 44, 'tank'); FX.shake(0.8); }
      if (typeof Sfx !== 'undefined' && Sfx.destroy) Sfx.destroy();
      if (src && src !== t && !friendly) src.kills++;
      this.ui.banner(`💥 ${t.name} 격파!`, 1300);
    }
    this.ui.refresh(this);
  }

  /** 턴 시작 시 불바다 피해 */
  applyBurns() {
    if (!this.burns.length) return;
    for (let i = this.burns.length - 1; i >= 0; i--) {
      const b = this.burns[i];
      for (const t of this.tanks) {
        if (!t.alive) continue;
        if (Math.hypot(t.cx - b.x, t.cy - b.y) < b.r) this.damage(t, 9, b.owner);
      }
      b.turns--;
      if (b.turns <= 0) this.burns.splice(i, 1);
    }
  }

  /* ─────────────────── 업데이트 ─────────────────── */

  loop(now) {
    if (!this.running) return;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.acc += dt;
    const step = 1 / 60;
    let n = 0;
    while (this.acc >= step && n < 5) { this.update(step); this.acc -= step; n++; }
    if (n === 5) this.acc = 0;
    if (HAS_FX) FX.update(dt);
    this.render();
    this.ui.frame(this);
    requestAnimationFrame(this._loop);
  }

  update(dt) {
    this.time += dt;
    this.stateT += dt;
    this.updateFloaters(dt);
    this.updatePending(dt);
    this.updateBurnVisual(dt);
    this.settleTanks();

    switch (this.state) {
      case 'intro':
        if (this.stateT > 0.85) this.setState('aim');
        break;
      case 'aim':
        this.turnLeft -= dt;
        if (this.turnLeft <= 0) {
          if (this.charging) this.releaseCharge();
          else if (!this.cur.isAI) this.fire(this.cur);
          else this.setState('settle');
          break;
        }
        if (this.cur.isAI) this.updateAI(dt); else this.updateHuman(dt);
        break;
      case 'fire':
        this.updateProjectiles();
        if (!this.projectiles.length && !this.pending.length && this.stateT > 0.25) this.setState('settle');
        break;
      case 'settle': {
        const busy = this.tanks.some((t) => t.falling) || this.pending.length > 0;
        // stateT 안전장치: 어떤 이유로든 정리가 끝나지 않아도 턴은 넘어갑니다
        if ((!busy && this.stateT > 0.55) || this.stateT > 6) this.nextTurn();
        break;
      }
      default:
        break;
    }
  }

  updateHuman(dt) {
    const t = this.cur, k = this.input;
    if (k.left !== k.right) {
      const moved = this.moveTank(t, k.left ? -1 : 1, dt);
      if (typeof Sfx !== 'undefined' && Sfx.engine) Sfx.engine(moved > 0.01);
    } else if (typeof Sfx !== 'undefined' && Sfx.engine) Sfx.engine(false);

    const lo = t.type.minElev, hi = t.type.maxElev;
    if (k.up) t.elev = clamp(t.elev + 42 * dt, lo, hi);
    if (k.down) t.elev = clamp(t.elev - 42 * dt, lo, hi);

    if (this.charging) {
      t.power += this.chargeDir * 68 * dt;
      if (t.power >= 100) { t.power = 100; this.chargeDir = -1; }
      if (t.power <= 0) { t.power = 0; this.chargeDir = 1; }
      t.charge = t.power / 100;
      if (typeof Sfx !== 'undefined' && Sfx.charge) Sfx.charge(t.power);
    } else {
      t.charge = approach(t.charge, 0, dt * 3);
      if (k.pup) t.power = clamp(t.power + 38 * dt, 5, 100);
      if (k.pdown) t.power = clamp(t.power - 38 * dt, 5, 100);
    }
  }

  updateAI(dt) {
    const ai = this.ai, t = this.cur;
    ai.t += dt;
    switch (ai.phase) {
      case 'wait':
        if (ai.t > 0.45) {
          ai.plan = AI.plan(this, t);
          if (!ai.plan) { this.setState('settle'); return; }
          t.weapon = ai.plan.weapon;
          ai.phase = 'move'; ai.t = 0; ai.moved = 0;
          this.ui.refresh(this);
        }
        break;
      case 'move': {
        const want = ai.plan.dx;
        if (Math.abs(want) < 1 || Math.abs(ai.moved) >= Math.abs(want) - 0.5 || t.fuel <= 0) {
          if (typeof Sfx !== 'undefined' && Sfx.engine) Sfx.engine(false);
          ai.phase = 'aim'; ai.t = 0; break;
        }
        const before = t.x;
        this.moveTank(t, Math.sign(want), dt);
        if (typeof Sfx !== 'undefined' && Sfx.engine) Sfx.engine(true);
        ai.moved += t.x - before;
        if (t.x === before) { if (typeof Sfx !== 'undefined' && Sfx.engine) Sfx.engine(false); ai.phase = 'aim'; ai.t = 0; }
        break;
      }
      case 'aim': {
        const ta = ai.plan.angle;
        const tf = ta > 90 ? -1 : 1;
        t.facing = tf;
        const te = clamp(tf === 1 ? ta : 180 - ta, t.type.minElev, t.type.maxElev);
        t.elev = approach(t.elev, te, 66 * dt);
        t.power = approach(t.power, ai.plan.power, 88 * dt);
        t.charge = t.power / 100 * 0.5;
        if (Math.abs(t.elev - te) < 1e-6 && Math.abs(t.power - ai.plan.power) < 1e-6) { ai.phase = 'pre'; ai.t = 0; }
        break;
      }
      case 'pre':
        if (ai.t > 0.3) this.fire(t);
        break;
      default:
        break;
    }
  }

  updateProjectiles() {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];

      // 굴러가는 롤러탄
      if (p.rolling) {
        p.rollT += 1 / 60;
        const nx = p.x + p.rollDir * p.rollSpeed;
        if (nx < 6 || nx > W - 6 || p.rollT > 4) {
          this.projectiles.splice(i, 1);
          this.explode(clamp(nx, 6, W - 6), Terrain.heightAt(this.ground, clamp(nx, 6, W - 6)), p.weapon, p.owner);
          continue;
        }
        const gyNow = Terrain.heightAt(this.ground, p.x);
        const gyNext = Terrain.heightAt(this.ground, nx);
        const slope = gyNext - gyNow;
        if (slope < -2.2) {   // 오르막이 너무 가파르면 멈춤
          this.projectiles.splice(i, 1);
          this.explode(p.x, gyNow, p.weapon, p.owner);
          continue;
        }
        p.rollSpeed = clamp(p.rollSpeed + slope * 0.16 - 0.012, 0.5, 9);
        p.x = nx;
        p.y = gyNext - 3;
        p.trail.push(p.x, p.y);
        let hitTank = null;
        for (const t of this.tanks) {
          if (!t.alive || t.id === p.owner) continue;
          if (Math.hypot(t.cx - p.x, t.cy - p.y) < t.hitR + 4) { hitTank = t; break; }
        }
        if (hitTank || p.rollSpeed < 0.55) {
          this.projectiles.splice(i, 1);
          this.explode(p.x, p.y, p.weapon, p.owner);
        }
        continue;
      }

      stepProjectile(p, this.wind);
      if (p.t % 2 === 0) p.trail.push(p.x, p.y);
      if (HAS_FX) FX.trail(p.x, p.y, p.weapon ? p.weapon.kind : 'normal');

      // 정점 처리 (분열 / 공중폭발)
      if (!p.peaked && p.vy >= 0 && p.t > 6) {
        p.peaked = true;
        if (p.airburst) {
          this.projectiles.splice(i, 1);
          this.explode(p.x, p.y, p.weapon, p.owner);
          continue;
        }
        if (p.split && p.weapon.split) {
          const sp = p.weapon.split;
          this.projectiles.splice(i, 1);
          if (HAS_FX) FX.spark(p.x, p.y, 12);
          if (typeof Sfx !== 'undefined' && Sfx.fire) Sfx.fire('rocket', 0.35);
          for (let k = 0; k < sp.n; k++) {
            const c = {
              x: p.x, y: p.y,
              vx: p.vx + (k - (sp.n - 1) / 2) * sp.spread,
              vy: p.vy - 0.4 - Math.random() * 0.6,
              t: 8, owner: p.owner, weapon: p.weapon,
              child: { radius: sp.radius, damage: sp.damage },
              split: false, airburst: false, rolling: false, peaked: true, trail: [],
            };
            this.projectiles.push(c);
          }
          continue;
        }
      }

      const c = collideProjectile(p, this.ground, this.tanks, p.owner);
      if (!c) continue;

      const owner = this.tanks[p.owner];
      if (c.type === 'out') {
        this.projectiles.splice(i, 1);
        if (owner && owner.lastTrail) owner.lastTrail.push(p.trail);
        this.floaters.push({ x: clamp(p.x, 50, W - 50), y: 70, text: '장외', t: 0, color: '#cccccc' });
        continue;
      }
      const done = this.detonate(p, c);
      if (done) {
        this.projectiles.splice(i, 1);
        if (owner && owner.lastTrail) owner.lastTrail.push(p.trail);
      }
    }
  }

  updatePending(dt) {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const q = this.pending[i];
      q.delay -= dt;
      if (q.delay <= 0) {
        this.pending.splice(i, 1);
        this.explode(q.x, q.y, q.w, q.owner);
      }
    }
  }

  updateBurnVisual(dt) {
    for (const b of this.burns) {
      b.t += dt;
      b.y = Terrain.heightAt(this.ground, b.x);
      if (HAS_FX && Math.random() < 0.55) {
        FX.explosion(b.x + (Math.random() * 2 - 1) * b.r * 0.7, b.y - 4, 9 + Math.random() * 8, 'fire');
      }
    }
  }

  settleTanks() {
    for (const t of this.tanks) {
      const gy = Terrain.heightAt(this.ground, t.x);
      if (t.y < gy - 0.5) {
        if (!t.falling) { t.falling = true; t.fallFrom = t.y; t.vy = 0; }
        t.vy += PHYS.G * 1.6;
        t.y = Math.min(gy, t.y + t.vy);
        if (t.y >= gy - 0.001) this.landTank(t, gy);
      } else {
        // 지면에 붙어 있음 — 낙하 중이었다면 여기서 착지 처리 (사각지대 방지)
        t.y = gy;
        if (t.falling) this.landTank(t, gy);
      }
    }
  }

  landTank(t, gy) {
    t.y = gy;
    if (!t.falling) return;
    t.falling = false;
    t.vy = 0;
    const drop = t.y - (t.fallFrom != null ? t.fallFrom : t.y);
    if (t.alive && drop > 50) {
      this.damage(t, Math.round((drop - 50) * 0.32), null);
      if (HAS_FX) { FX.dust(t.x, t.y, 0); FX.debris(t.x, t.y, 8, '#6b4a2a'); }
      if (typeof Sfx !== 'undefined' && Sfx.collapse) Sfx.collapse();
    }
    t.fallFrom = null;
  }

  updateFloaters(dt) {
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.t += dt;
      f.y -= 26 * dt;
      if (f.t > 1.3) this.floaters.splice(i, 1);
    }
  }

  /* ─────────────────── 렌더링 ─────────────────── */

  render() {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, W, H);

    const shake = HAS_FX ? FX.shakeAmount() : 0;
    c.save();
    if (shake > 0.001) c.translate((Math.random() - 0.5) * shake * 26, (Math.random() - 0.5) * shake * 26);

    if (HAS_GFX) Gfx.drawSky(c, this.scene, this.time);
    else this.fallbackSky(c);

    if (HAS_FX) FX.drawBack(c);

    if (HAS_GFX) Gfx.drawTerrain(c, this.scene, this.ground, this.time);
    else this.fallbackTerrain(c);

    this.drawBurns(c);
    this.drawAimHint(c);

    for (const t of this.tanks) if (!t.alive) this.drawTank(c, t);
    for (const t of this.tanks) if (t.alive) this.drawTank(c, t);

    this.drawProjectiles(c);
    if (HAS_FX) FX.drawFront(c);
    for (const t of this.tanks) this.drawNamePlate(c, t);
    this.drawFloaters(c);

    if (HAS_GFX && Gfx.drawOverlay) Gfx.drawOverlay(c, this.scene, this.time);

    if (HAS_FX) {
      const f = FX.flashAmount();
      if (f && f.a > 0.002) {
        c.fillStyle = f.color || '#ffffff';
        c.globalAlpha = Math.min(0.85, f.a);
        c.fillRect(-40, -40, W + 80, H + 80);
        c.globalAlpha = 1;
      }
    }
    c.restore();
  }

  fallbackSky(c) {
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#14213d'); g.addColorStop(0.6, '#3d6fb8'); g.addColorStop(1, '#a6d3f2');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
  }

  fallbackTerrain(c) {
    const g = this.ground;
    const gr = c.createLinearGradient(0, H * 0.3, 0, H);
    gr.addColorStop(0, '#5a3b24'); gr.addColorStop(1, '#241708');
    c.fillStyle = gr;
    c.beginPath(); c.moveTo(0, H + 40);
    for (let x = 0; x < W; x += 2) c.lineTo(x, g[x]);
    c.lineTo(W, H + 40); c.closePath(); c.fill();
    c.strokeStyle = '#4caf50'; c.lineWidth = 7; c.lineJoin = 'round';
    c.beginPath(); for (let x = 0; x < W; x += 2) c.lineTo(x, g[x] + 2); c.stroke();
  }

  drawBurns(c) {
    for (const b of this.burns) {
      const k = 0.55 + Math.sin(this.time * 7 + b.x) * 0.12;
      const g = c.createRadialGradient(b.x, b.y, 2, b.x, b.y, b.r);
      g.addColorStop(0, `rgba(255,220,120,${0.55 * k})`);
      g.addColorStop(0.45, `rgba(255,120,30,${0.4 * k})`);
      g.addColorStop(1, 'rgba(120,20,0,0)');
      c.save();
      c.globalCompositeOperation = 'lighter';
      c.fillStyle = g;
      c.beginPath(); c.ellipse(b.x, b.y - 6, b.r, b.r * 0.55, 0, 0, Math.PI * 2); c.fill();
      c.restore();
    }
  }

  /** 조준 보조: 이전 사격 궤적 + 포구 방향선 */
  drawAimHint(c) {
    const t = this.cur;
    if (!t || t.isAI || this.state !== 'aim') return;
    if (t.lastTrail && t.lastTrail.length) {
      c.save();
      c.setLineDash([4, 9]);
      c.strokeStyle = 'rgba(255,255,255,0.4)';
      c.lineWidth = 2;
      for (const tr of t.lastTrail) {
        c.beginPath();
        for (let i = 0; i < tr.length; i += 2) c.lineTo(tr[i], tr[i + 1]);
        c.stroke();
      }
      c.restore();
    }
    const tip = t.barrelTip;
    const a = (-t.angle * Math.PI) / 180;
    c.save();
    c.strokeStyle = 'rgba(255,255,255,0.5)';
    c.setLineDash([3, 7]);
    c.lineWidth = 1.6;
    c.beginPath();
    c.moveTo(tip.x, tip.y);
    c.lineTo(tip.x + Math.cos(a) * 62, tip.y + Math.sin(a) * 62);
    c.stroke();
    c.restore();
  }

  drawTank(c, t) {
    const art = t.art;
    const s = t.type.size;
    const tilt = this.tiltOf(t);
    const st = {
      p: t.pal, color: t.color, roll: t.roll, t: this.time, dead: !t.alive,
      hpFrac: t.hp / t.maxHp, charge: t.charge || 0,
      len: (art && art.barrelLen) || t.type.barrel,
    };

    c.save();
    c.translate(t.x, t.y);
    c.rotate(tilt);
    c.scale(s * t.facing, s);

    if (art && art.draw) {
      art.draw(c, st);
    } else {
      // 아트가 없을 때의 대체 그림
      TankArt.box(c, -16, -12, 32, 12, 4, { p: t.pal });
      TankArt.box(c, -12, -22, 24, 11, 5, { p: t.pal, fill: t.color });
    }

    const piv = (art && art.pivot) || [2, -19];
    c.save();
    c.translate(piv[0], piv[1]);
    c.rotate(-((t.elev * Math.PI) / 180 + t.facing * tilt));
    if (art && art.barrel) art.barrel(c, st);
    else TankArt.barrelStd(c, st, {});
    c.restore();

    c.restore();
  }

  drawNamePlate(c, t) {
    const s = t.type.size;
    const top = t.y - 34 * s;
    const bw = 48, bx = t.x - bw / 2, by = top - 12;

    c.save();
    c.fillStyle = 'rgba(0,0,0,0.55)';
    TankArt.rr(c, bx - 1.5, by - 1.5, bw + 3, 8, 4); c.fill();
    if (t.alive) {
      const k = t.hp / t.maxHp;
      c.fillStyle = k > 0.5 ? '#4fe07f' : k > 0.25 ? '#ffcc2e' : '#ff5a5a';
      TankArt.rr(c, bx, by, bw * k, 5, 2.5); c.fill();
      if (t.frozen > 0) {
        c.fillStyle = 'rgba(150,225,255,0.6)';
        TankArt.rr(c, bx, by, bw, 5, 2.5); c.fill();
      }
    }

    c.font = 'bold 13px system-ui, -apple-system, sans-serif';
    c.textAlign = 'center';
    const label = t.name;
    c.lineWidth = 3;
    c.strokeStyle = 'rgba(0,0,0,0.75)';
    c.strokeText(label, t.x, by - 5);
    c.fillStyle = t.alive ? '#ffffff' : '#8b93a7';
    c.fillText(label, t.x, by - 5);

    if (this.teamMode) {
      c.font = 'bold 10px system-ui, sans-serif';
      c.strokeText(`${TEAM_LABELS[t.team]}팀`, t.x, by - 18);
      c.fillStyle = t.color;
      c.fillText(`${TEAM_LABELS[t.team]}팀`, t.x, by - 18);
    }

    if (t === this.cur && t.alive && this.state !== 'over') {
      const bob = Math.sin(this.time * 6) * 4;
      const ay = by - (this.teamMode ? 32 : 20) + bob;
      c.fillStyle = t.color;
      c.beginPath();
      c.moveTo(t.x - 9, ay - 11); c.lineTo(t.x + 9, ay - 11); c.lineTo(t.x, ay);
      c.closePath(); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 1.2; c.stroke();
    }

    // 파괴된 전차의 연기
    if (!t.alive && HAS_FX && Math.random() < 0.14) FX.smokeColumn(t.x, t.y - 14 * s, 1);
    c.restore();
  }

  drawProjectiles(c) {
    for (const p of this.projectiles) {
      const tr = p.trail;
      if (tr.length > 4) {
        c.save();
        c.strokeStyle = 'rgba(255,255,255,0.3)';
        c.lineWidth = 2;
        c.beginPath();
        const start = Math.max(0, tr.length - 48);
        for (let i = start; i < tr.length; i += 2) c.lineTo(tr[i], tr[i + 1]);
        c.stroke();
        c.restore();
      }
      const big = p.weapon && (p.weapon.id === 'nuke' || p.weapon.id === 'quake');
      const r = p.child ? 3.5 : big ? 7 : 4.8;
      c.save();
      c.fillStyle = '#15171c';
      c.beginPath(); c.arc(p.x, p.y, r, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#ffb347';
      c.beginPath(); c.arc(p.x - p.vx * 0.15, p.y - p.vy * 0.15, r * 0.5, 0, Math.PI * 2); c.fill();
      c.restore();
    }
  }

  drawFloaters(c) {
    c.save();
    c.textAlign = 'center';
    for (const f of this.floaters) {
      c.globalAlpha = 1 - Math.max(0, f.t - 0.7) / 0.6;
      c.font = `bold ${f.big ? 27 : 21}px system-ui, sans-serif`;
      c.lineWidth = 4;
      c.strokeStyle = 'rgba(0,0,0,0.7)';
      c.strokeText(f.text, f.x, f.y);
      c.fillStyle = f.color;
      c.fillText(f.text, f.x, f.y);
    }
    c.globalAlpha = 1;
    c.restore();
  }
}
