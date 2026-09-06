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
    this.stage = cfg.stage || 0;
    this.teamMode = !!cfg.teamMode;

    const themes = gfxThemes();
    const keys = Object.keys(themes);
    this.themeKey = cfg.theme && themes[cfg.theme] ? cfg.theme : keys[Math.floor(Math.random() * keys.length)];
    this.theme = themes[this.themeKey] || {};

    this.seed = (Math.random() * 1e9) >>> 0;
    this.ground = Terrain.generate(W, H, this.seed, terrainStyleFor(this.themeKey, this.theme));
    this.ground0 = Float32Array.from(this.ground);   // 지형 복원기용 원본
    this.scene = HAS_GFX ? Gfx.createScene(this.seed, this.themeKey) : null;
    if (HAS_FX) { FX.reset(); FX.setWind && FX.setWind(0); }

    this.tanks = this.placeTanks(cfg.players);

    // 원정 · 무한 모드 — 판이 올라갈수록 적이 강해집니다
    const sc = cfg.scaling;
    if (sc) {
      for (const t of this.tanks) {
        if (!t.isAI) continue;
        t.maxHp = Math.round(t.maxHp * sc.hp);
        t.hp = t.maxHp;
        t.buffs.damage = (t.buffs.damage || 1) * sc.dmg;
      }
    }

    this.turnIdx = -1;
    this.round = 1;
    this.wind = 0;
    this.windHold = 0;        // 몇 라운드 더 이 바람이 유지되는지
    this.windChanged = false; // 이번 턴 안내에 '바람이 바뀌었습니다' 를 붙일지
    this.windKind = 'both';   // 무엇이 바뀌었는지 — 'dir' 방향만 / 'speed' 세기만 / 'both' 둘 다
    this.projectiles = [];
    this.pending = [];        // 지연 폭발 (연쇄탄 등)
    this.burns = [];          // 네이팜 불바다
    this.floaters = [];
    this.crates = [];         // 보급 상자
    this.hoverCrate = null;   // 마우스가 올라간 상자
    this.hoverTank = null;    // 마우스가 올라간 전차
    this.crateScan = {};      // 팀별 상자 투시 여부 — 화물 투시기 / 상시 레이더
    this.mines = [];          // 매설된 지뢰
    this.planes = [];         // 보급기 / 폭격기
    this.bonusCredits = 0;    // 전리품 상자로 얻은 크레딧
    this.supplyIn = 2 + Math.floor(Math.random() * 3);   // 몇 라운드 뒤 첫 보급기가 오는지
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

    // 영구 장착 모듈 → 출전 장비 순으로 적용
    // (상자 투시·정찰 같은 전장 상태를 건드리므로 반드시 상태 초기화 뒤에 옵니다)
    const me = this.tanks.find((t) => !t.isAI);
    if (me) {
      if (cfg.modules && cfg.modules.length) for (const inst of cfg.modules) this.grantItem(me, inst, true);
      if (cfg.loadout && cfg.loadout.length) for (const inst of cfg.loadout) this.grantItem(me, inst, true);
    }

    this.rollWind(true);   // 첫 바람은 조용히 정합니다
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

  /* ── 정보 공개 범위 ──
   * 상자 내용물도, 적의 장비도 처음에는 보이지 않습니다.
   * 정찰 계열 아이템을 써야 열립니다.
   */

  /** 화면을 보는 쪽의 팀 — 사람이 없으면(관전) 지금 턴을 잡은 전차 기준 */
  viewTeam() {
    const me = this.tanks.find((t) => !t.isAI && t.alive) || this.tanks.find((t) => !t.isAI);
    if (me) return me.team;
    return this.cur ? this.cur.team : -1;
  }

  /** 상자 속을 볼 수 있는지 (화물 투시기 · 상시 레이더) */
  crateScanned() { return !!this.crateScan[this.viewTeam()]; }

  /** 그 전차의 장착 효과·소지품을 볼 수 있는지 — 우리 팀이거나 정찰당한 적 */
  canSeeKit(t) { return !!t && (t.team === this.viewTeam() || !!t.revealed); }

  /**
   * 바람은 매 턴이 아니라 몇 라운드에 한 번씩만 바뀝니다.
   * 한 번 불면 3~5 라운드 동안 그대로라, 그동안은 조준값을 그대로 써먹을 수 있습니다.
   */
  rollWind(silent) {
    const prev = this.wind;
    const mag = Math.abs(prev), sign = prev >= 0 ? 1 : -1;
    const q = (v) => Math.round(clamp(v, -10, 10) * 10) / 10;
    let w, kind, tries = 0;

    if (silent || mag < 0.6) {
      // 판을 열 때 / 무풍에서 시작할 때는 그냥 새로 뽑습니다
      w = q((Math.random() * 2 - 1) * 9.5);
      kind = 'both';
    } else {
      const r = Math.random();
      if (r < 0.30) {
        // 방향만 바뀝니다 — 세기는 그대로
        w = q(-prev);
        kind = 'dir';
      } else if (r < 0.62) {
        // 세기만 바뀝니다 — 방향은 그대로
        let m;
        do { m = 1 + Math.random() * 9; } while (Math.abs(m - mag) < 2 && ++tries < 8);
        w = q(sign * m);
        kind = 'speed';
      } else {
        // 둘 다 바뀝니다
        do { w = q((Math.random() * 2 - 1) * 9.8); } while ((Math.abs(w - prev) < 2.5 || Math.sign(w) === sign) && ++tries < 10);
        kind = 'both';
      }
    }

    this.wind = w;
    this.windKind = kind;
    this.windHold = 3 + Math.floor(Math.random() * 3);   // 3~5 라운드 유지
    if (HAS_FX && FX.setWind) FX.setWind(this.wind);
    if (HAS_GFX && Gfx.setWind) Gfx.setWind(this.wind);
    if (!silent) {
      this.windChanged = true;
      if (typeof Sfx !== 'undefined' && Sfx.windGust) Sfx.windGust(this.wind);
    }
  }
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

    // 라운드가 넘어갈 때 보급기 등장 / 바람이 바뀔 때가 됐는지 확인
    if (wrapped) {
      if (--this.supplyIn <= 0) {
        // 상자가 굴러다니고 있으면 굳이 더 뿌리지 않습니다
        if (this.crates.length < 2) this.callSupplyPlane(1 + (Math.random() < 0.18 ? 1 : 0));
        this.supplyIn = 4 + Math.floor(Math.random() * 4);
      }
      if (--this.windHold <= 0) this.rollWind(false);
    }

    this.turnIdx = i;
    this.cur = this.tanks[i];
    const t = this.cur;

    // 턴 시작 시 지속 효과
    if (t.buffs.regen) {
      const before = t.hp;
      t.hp = Math.min(t.maxHp, t.hp + t.buffs.regen);
      if (t.hp > before) this.floaters.push({ x: t.x, y: t.y - 60, text: `+${t.hp - before}`, t: 0, color: '#4fe07f' });
    }
    if (t.acid > 0 && !t.buffs.heatsink) {
      t.acid--;
      this.damage(t, 12, null, true);
      this.floaters.push({ x: t.x, y: t.y - 70, text: '산성비', t: 0, color: '#a8e05f' });
      if (!t.alive) { if (this.checkWin()) return; }
    } else if (t.acid > 0) {
      t.acid--;
    }
    if (t.buffs.smoke > 0) t.buffs.smoke--;

    let fuelMul = 1;
    if (t.frozen > 0) { fuelMul *= 0.3; t.frozen--; }
    if (t.oiled > 0) { fuelMul *= 0.5; t.oiled--; }
    t.fuel = Math.round(t.maxFuel * fuelMul);
    // 한 턴짜리 사격 강화는 턴이 시작될 때 초기화
    t.buffs.extraShot = 0;
    t.movedThisTurn = false;
    t.wasHitLastTurn = !!t.hitSinceTurn;
    t.hitSinceTurn = false;
    if (t.buffs.dome > 0) t.buffs.dome--;
    if (t.buffs.heatsink) {
      const before = t.hp;
      t.hp = Math.min(t.maxHp, t.hp + t.buffs.heatsink);
      if (t.hp > before) this.floaters.push({ x: t.x, y: t.y - 68, text: `+${t.hp - before}`, t: 0, color: '#ff9a5a' });
    }
    if (!t.hasAmmo(t.weapon)) {
      t.weapon = 0;
      for (let k = 0; k < t.weapons.length; k++) if (t.hasAmmo(k)) { t.weapon = k; break; }
    }
    this.turnLeft = TURN_SECONDS;
    this.ai = t.isAI ? { phase: 'wait', t: 0, plan: null, moved: 0 } : null;
    this.setState('intro');
    const windNote = { dir: '방향', speed: '세기' }[this.windKind] || '방향과 세기';
    this.ui.banner(
      `${t.name} 턴${t.isAI ? '' : ' — 당신 차례!'}${this.windChanged ? `  ·  🌬 바람 ${windNote}가 바뀌었습니다` : ''}`,
      this.windChanged ? 1700 : 1000,
    );
    this.windChanged = false;
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
    const r = this.walk(t.x, t.y, Math.sign(dx), Math.min(Math.abs(dx), t.fuel), t.climb);
    return { x: r.x, y: r.y };
  }

  moveTank(t, dir, dt) {
    t.facing = dir;
    if (t.fuel <= 0) return 0;
    const r = this.walk(t.x, t.y, dir, Math.min(MOVE_SPEED * dt, t.fuel), t.climb);
    const moved = r.used;
    t.x = r.x; t.y = r.y; t.fuel -= moved;
    t.roll += moved * dir;
    if (moved > 0.01 && HAS_FX) FX.dust(t.x - dir * 14 * t.type.size, t.y, -dir);
    if (moved > 0.01) { t.movedThisTurn = true; this.checkCratePickup(t); this.checkMineStep(t); }
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

  /** 아이템 효과가 반영된 발사체 옵션 */
  shotOpts(t) {
    return {
      powerMul: t.type.power * (t.buffs.power || 1),
      windK: t.buffs.wind != null ? t.buffs.wind : 1,
      g: t.buffs.lowGrav ? PHYS.G * 0.55 : PHYS.G,
      homing: t.buffs.homing ? 1 : 0,
      pierce: t.buffs.pierce || 0,
      bounce: t.buffs.bounce || 0,
      splitFuse: t.buffs.splitFuse || 0,
    };
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
    let offsets = w.count === 1 ? [0] : Array.from({ length: w.count }, (_, i) => (i - (w.count - 1) / 2) * w.spread);
    if (t.buffs.twinBarrel) offsets = offsets.concat(offsets.map((o) => o + 2.2));
    const opts = this.shotOpts(t);
    for (const off of offsets) {
      this.projectiles.push(makeProjectile(tip.x, tip.y, t.angle + off, t.power, t.id, w, opts));
    }
    // 한 발짜리 아이템 효과 소모
    for (const k of ['pierce', 'bounce', 'splitFuse', 'homing', 'lowGrav', 'overcharge']) {
      if (t.buffs[k]) t.buffs[k]--;
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
    const owner = ownerId != null && ownerId >= 0 ? this.tanks[ownerId] : null;
    const r = Math.round(w.radius * ((owner && owner.buffs.radius) || 1));
    let dmgMul = (owner && owner.buffs.damage) || 1;
    if (owner && owner.buffs.siege && !owner.movedThisTurn) dmgMul *= 1 + owner.buffs.siege / 100;
    if (r > 0) Terrain.crater(this.ground, x, y, r, H - 4);
    if (HAS_FX) {
      FX.explosion(x, y, r, w.kind || 'normal');
      FX.shake(clamp(r / 90, 0.15, 1));
      if (r > 60) FX.flash(clamp((r - 50) / 90, 0, 0.7), w.kind === 'nuke' ? '#fff3d0' : '#ffd9a0');
    }
    if (typeof Sfx !== 'undefined' && Sfx.explode) Sfx.explode(r, w.kind || 'normal');

    // 폭발은 지뢰와 보급 상자에도 영향을 줍니다
    this.blastCrates(x, y, r * 1.2);
    this.blastMines(x, y, r * 1.1, ownerId);

    const R = r * 1.35;
    if (R <= 0) return;
    for (const t of this.tanks) {
      if (!t.alive) continue;
      const d = Math.hypot(t.cx - x, t.cy - y);
      if (d < R) {
        let dmg = w.damage * (1 - d / R);
        if (d < r * 0.5) dmg = Math.max(dmg, w.damage * 0.88);
        dmg = dmg * dmgMul * t.type.armor * (t.buffs.armor || 1);
        if (t.buffs.bulwark) dmg *= 1 - t.buffs.bulwark;
        if (t.buffs.dome > 0) dmg *= 0.3;
        this.damage(t, Math.round(dmg), ownerId);
      }
    }
  }

  damage(t, dmg, srcId, silent) {
    if (dmg <= 0 || !t.alive) return;
    t.hitSinceTurn = true;   // 자리가 들켰다는 표시 — AI 가 다음 턴에 옮길지 판단합니다
    const src = srcId != null && srcId >= 0 ? this.tanks[srcId] : null;
    const friendly = src && src !== t && src.team === t.team;

    // ── 아이템 방어 단계 ──
    if (t.buffs.dodge > 0) {
      t.buffs.dodge--;
      this.floaters.push({ x: t.x, y: t.y - 62, text: '회피!', t: 0, color: '#9fe8ff' });
      if (typeof Sfx !== 'undefined' && Sfx.armorGraze) Sfx.armorGraze();
      this.ui.refresh(this);
      return;
    }
    if (t.buffs.shield > 0) {
      t.buffs.shield--;
      this.floaters.push({ x: t.x, y: t.y - 62, text: '방어막', t: 0, color: '#6fc8ff' });
      if (HAS_FX) FX.explosion(t.cx, t.cy, 26, 'ice');
      if (typeof Sfx !== 'undefined' && Sfx.armorGraze) Sfx.armorGraze();
      this.ui.refresh(this);
      return;
    }
    if (t.buffs.reactive > 0) {
      t.buffs.reactive--;
      dmg = Math.round(dmg * 0.5);
      this.floaters.push({ x: t.x + 24, y: t.y - 70, text: '반응장갑', t: 0, color: '#ffcc2e' });
    }

    t.hp = Math.max(0, t.hp - dmg);
    if (src && src !== t && !friendly) { src.damageDealt += dmg; src.hits++; }
    this.stats.totalDamage += dmg;
    this.floaters.push({
      x: t.x, y: t.y - 56, text: `-${dmg}`, t: 0,
      color: friendly ? '#ffb347' : src === t ? '#cccccc' : '#ffffff',
      big: dmg >= 40,
    });
    if (!silent && typeof Sfx !== 'undefined' && Sfx.metalHit) Sfx.metalHit(clamp(dmg / 60, 0.2, 1));

    // 흡혈 · 반사
    if (src && src !== t && !friendly && src.alive && src.buffs.leech) {
      const heal = Math.round(dmg * src.buffs.leech);
      if (heal > 0) {
        src.hp = Math.min(src.maxHp, src.hp + heal);
        this.floaters.push({ x: src.x, y: src.y - 62, text: `+${heal}`, t: 0, color: '#ff6f8f' });
      }
    }
    if (t.buffs.thorns && src && src !== t && !friendly && src.alive) {
      const back = Math.round(dmg * t.buffs.thorns);
      if (back > 0) {
        src.hp = Math.max(0, src.hp - back);
        this.floaters.push({ x: src.x, y: src.y - 56, text: `-${back}`, t: 0, color: '#a8e05f' });
        if (src.hp <= 0) this.destroyTank(src, t);
      }
    }

    // 극저온 코팅 — 내 공격에 맞은 적이 얼어붙습니다
    if (src && src !== t && !friendly && src.buffs.frostTouch && t.alive) {
      t.frozen = Math.max(t.frozen, src.buffs.frostTouch);
      this.floaters.push({ x: t.x + 22, y: t.y - 76, text: '빙결', t: 0, color: '#9fe8ff' });
    }
    // 자동 응급 나노 — 위험할 때 한 번 살려 줍니다
    if (t.alive && t.hp > 0 && t.buffs.autoMedic && t.hp < t.maxHp * 0.3) {
      const heal = t.buffs.autoMedic;
      t.buffs.autoMedic = 0;
      t.hp = Math.min(t.maxHp, t.hp + heal);
      this.floaters.push({ x: t.x, y: t.y - 84, text: `🚨 응급 회복 +${heal}`, t: 0, color: '#4fe07f', big: true });
    }

    if (t.hp <= 0) this.destroyTank(t, friendly ? null : src);
    this.ui.refresh(this);
  }

  destroyTank(t, killer) {
    if (!t.alive) return;
    // 불사조 회로 — 한 번 부활
    if (t.buffs.phoenix > 0) {
      t.buffs.phoenix--;
      t.hp = t.buffs.phoenixHp || 45;
      if (HAS_FX) { FX.explosion(t.x, t.cy, 52, 'fire'); FX.flash(0.4, '#ffb060'); }
      this.floaters.push({ x: t.x, y: t.y - 76, text: '부활!', t: 0, color: '#ff8a3d', big: true });
      this.ui.banner(`🔥 ${t.name} 부활!`, 1400);
      return;
    }
    t.alive = false;
    if (HAS_FX) { FX.explosion(t.x, t.cy, 44, 'tank'); FX.shake(0.8); }
    if (typeof Sfx !== 'undefined' && Sfx.destroy) Sfx.destroy();
    if (killer && killer !== t) {
      killer.kills++;
      if (killer.buffs.scavenger) {
        this.bonusCredits = (this.bonusCredits || 0) + killer.buffs.scavenger;
        this.floaters.push({ x: killer.x, y: killer.y - 90, text: `◈ +${killer.buffs.scavenger}`, t: 0, color: '#ffb02e' });
      }
    }
    // 자폭 장치
    if (t.buffs.deathBlast) {
      this.pending.push({
        delay: 0.25, x: t.x, y: t.cy,
        w: { radius: t.buffs.deathBlast, damage: Math.round(t.buffs.deathBlast * 0.75), kind: 'nuke' },
        owner: t.id,
      });
      this.floaters.push({ x: t.x, y: t.y - 96, text: '💀 자폭!', t: 0, color: '#ff5348', big: true });
    }
    // 파괴된 전차는 절반쯤 확률로 보급 상자를 남깁니다
    const dropped = Math.random() < 0.5;
    if (dropped) this.dropCrate(t.x, t.y - 30, rollDropItem(this.stage), true);
    this.ui.banner(`💥 ${t.name} 격파!${dropped ? ' — 보급품을 떨어뜨렸습니다' : ''}`, 1500);
  }

  /* ═════════════ 아이템 · 보급 ═════════════ */

  /** 전차에게 아이템 효과를 적용. silent=true 면 배너를 띄우지 않습니다 */
  grantItem(t, inst, silent) {
    if (typeof inst === 'string') inst = { id: inst, roll: 1 };
    const def = inst && itemDef(inst.id);
    if (!def || !t) return null;
    const v = itemValue(inst);
    let label;
    if (def.kind === 'active') {
      t.addItem(inst);
      label = `${def.name} ×${itemUses(inst)}`;
    } else {
      label = def.apply ? def.apply(this, t, v) : def.name;
    }
    if (!silent) {
      this.floaters.push({ x: t.x, y: t.y - 84, text: `${def.icon} ${itemName(inst)}`, t: 0, color: RARITY[def.rarity].color, big: true });
      if (label && label !== def.name) {
        this.floaters.push({ x: t.x, y: t.y - 64, text: label, t: 0, color: '#e9ecf4' });
      }
    }
    this.ui.refresh(this);
    return label;
  }

  /** 상자 하나 떨어뜨리기 (parachute=false 면 바로 지면에) */
  dropCrate(x, y, inst, withChute) {
    this.crates.push({
      x: clamp(x, 24, W - 24), y,
      vy: withChute ? 0.8 : 3,
      chute: !!withChute,
      landed: false,
      item: inst || rollCrateItem(this.stage),
      t: 0, bob: Math.random() * 6,
    });
  }

  /** 보급기가 화면을 가로지르며 상자를 떨굽니다 */
  callSupplyPlane(count) {
    const dir = Math.random() < 0.5 ? 1 : -1;
    const n = Math.max(1, count || 1);
    const drops = [];
    for (let i = 0; i < n; i++) drops.push(120 + Math.random() * (W - 240));
    drops.sort((a, b) => (dir > 0 ? a - b : b - a));
    this.planes.push({
      kind: 'supply', dir,
      x: dir > 0 ? -140 : W + 140,
      y: 90 + Math.random() * 70,
      speed: 210 * dir,
      drops, dropped: 0,
    });
    this.ui.banner('🛩 보급기 접근 — 상자를 떨어뜨립니다', 1600);
    if (typeof Sfx !== 'undefined' && Sfx.windGust) Sfx.windGust(6);
  }

  /** 폭격기 — 목표 좌표에 3연발 */
  callAirstrike(targetX, ownerId, count) {
    const dir = targetX > W / 2 ? -1 : 1;
    this.planes.push({
      kind: 'bomber', dir,
      x: dir > 0 ? -160 : W + 160,
      y: 120 + Math.random() * 40,
      speed: 280 * dir,
      target: clamp(targetX, 40, W - 40),
      owner: ownerId,
      bombs: Math.max(1, count || 3),
      dropped: 0,
    });
    this.ui.banner('✈ 폭격기 진입', 1500);
  }

  /** 유성우 */
  callMeteors(n, ownerId) {
    const w = { id: 'meteor', name: '유성', radius: 52, damage: 46, behavior: 'std', kind: 'nuke', fire: 'heavy', count: 1, spread: 0, speed: 1 };
    for (let i = 0; i < n; i++) {
      const x = 80 + Math.random() * (W - 160);
      this.pending.push({ delay: 0.35 * i + 0.2, x, y: Terrain.heightAt(this.ground, x), w, owner: ownerId, meteor: true });
    }
    if (typeof Sfx !== 'undefined' && Sfx.warning) Sfx.warning();
  }

  updatePlanes(dt) {
    for (let i = this.planes.length - 1; i >= 0; i--) {
      const pl = this.planes[i];
      const prev = pl.x;
      pl.x += pl.speed * dt;
      if (pl.kind === 'supply') {
        while (pl.dropped < pl.drops.length) {
          const dx = pl.drops[pl.dropped];
          const passed = pl.dir > 0 ? prev < dx && pl.x >= dx : prev > dx && pl.x <= dx;
          if (!passed) break;
          this.dropCrate(dx, pl.y + 10, rollCrateItem(this.stage), true);
          pl.dropped++;
        }
      } else if (pl.kind === 'bomber' && pl.dropped < (pl.bombs || 3)) {
        const dx = pl.target + (pl.dropped - (pl.bombs || 3) / 2) * 46 * pl.dir;
        const passed = pl.dir > 0 ? prev < dx && pl.x >= dx : prev > dx && pl.x <= dx;
        if (passed) {
          const w = { id: 'bomb', name: '폭탄', radius: 44, damage: 34, behavior: 'std', kind: 'normal', fire: 'heavy', count: 1, spread: 0, speed: 1 };
          this.projectiles.push(makeProjectile(pl.x, pl.y + 12, -90, 6, pl.owner != null ? pl.owner : -1, w, { powerMul: 1 }));
          pl.dropped++;
        }
      }
      if (pl.x < -260 || pl.x > W + 260) this.planes.splice(i, 1);
    }
  }

  updateCrates(dt) {
    for (let i = this.crates.length - 1; i >= 0; i--) {
      const c = this.crates[i];
      c.t += dt;
      const gy = Terrain.heightAt(this.ground, c.x) - 9;
      if (!c.landed) {
        c.vy = Math.min(c.chute ? 1.6 : 6.5, c.vy + (c.chute ? 0.06 : 0.35));
        c.y += c.vy * dt * 60;
        c.x = clamp(c.x + (c.chute ? this.wind * 0.16 * dt * 60 : 0), 16, W - 16);
        if (c.y >= gy) { c.y = gy; c.landed = true; if (HAS_FX) FX.dust(c.x, gy + 8, 0); }
      } else {
        c.y = gy;   // 지형이 깎이면 따라 내려옵니다
      }
      // 근처 전차가 자동으로 획득
      for (const t of this.tanks) {
        if (!t.alive) continue;
        const reach = 26 * t.type.size * (t.buffs.magnet || 1);
        if (Math.abs(t.x - c.x) < reach && Math.abs(t.y - c.y) < 70) {
          this.takeCrate(t, i);
          break;
        }
      }
    }
  }

  checkCratePickup(t) {
    for (let i = this.crates.length - 1; i >= 0; i--) {
      const c = this.crates[i];
      const reach = 26 * t.type.size * (t.buffs.magnet || 1);
      if (Math.abs(t.x - c.x) < reach && Math.abs(t.y - c.y) < 70) { this.takeCrate(t, i); return; }
    }
  }

  takeCrate(t, idx) {
    const c = this.crates[idx];
    if (!c) return;
    this.crates.splice(idx, 1);
    t.pickups++;
    const times = t.buffs.dupe ? 2 : 1;
    for (let k = 0; k < times; k++) {
      const inst = k === 0 ? c.item : rollCrateItem(this.stage);
      if (inst && t.buffs.luck) inst.roll = Math.round(Math.min(1.62, inst.roll * (1 + t.buffs.luck)) * 100) / 100;
      this.grantItem(t, inst);
    }
    if (typeof Sfx !== 'undefined' && Sfx.select) Sfx.select();
    if (HAS_FX) FX.spark(c.x, c.y, 10);
  }

  /** 지형 복원기 — 원본 높이맵으로 서서히 되돌립니다 */
  restoreTerrain(cx, half) {
    const x0 = Math.max(0, Math.floor(cx - half));
    const x1 = Math.min(W - 1, Math.ceil(cx + half));
    for (let x = x0; x <= x1; x++) {
      const k = 1 - Math.abs(x - cx) / half;
      this.ground[x] += (this.ground0[x] - this.ground[x]) * clamp(k, 0, 1);
    }
    if (HAS_FX) {
      for (let i = 0; i < 8; i++) FX.dust(cx + (Math.random() * 2 - 1) * half, Terrain.heightAt(this.ground, cx), 0);
    }
  }

  /** 폭발이 상자를 파괴 */
  blastCrates(x, y, r) {
    for (let i = this.crates.length - 1; i >= 0; i--) {
      const c = this.crates[i];
      if (Math.hypot(c.x - x, c.y - y) < r) {
        this.crates.splice(i, 1);
        if (HAS_FX) FX.debris(c.x, c.y, 8, '#8a6b42');
      }
    }
  }

  /* ── 지뢰 ── */

  checkMineStep(t) {
    for (let i = this.mines.length - 1; i >= 0; i--) {
      const m = this.mines[i];
      if (m.team === t.team) continue;
      if (Math.abs(t.x - m.x) < 20 && Math.abs(t.y - m.y) < 60) {
        this.mines.splice(i, 1);
        this.explode(m.x, m.y, { radius: 46, damage: m.dmg || 42, kind: 'normal' }, m.owner);
        return;
      }
    }
  }

  blastMines(x, y, r, ownerId) {
    for (let i = this.mines.length - 1; i >= 0; i--) {
      const m = this.mines[i];
      if (Math.hypot(m.x - x, m.y - y) < r) {
        this.mines.splice(i, 1);
        this.pending.push({
          delay: 0.1, x: m.x, y: m.y,
          w: { radius: 46, damage: m.dmg || 42, kind: 'normal' },
          owner: m.owner != null ? m.owner : ownerId,
        });
      }
    }
  }

  updateMines(dt) {
    for (const m of this.mines) { m.t += dt; m.y = Terrain.heightAt(this.ground, m.x) - 3; }
  }

  /** 전투 중 아이템 사용 */
  useItem(idx) {
    const t = this.cur;
    if (!t || this.state !== 'aim') return false;
    const slot = t.items[idx];
    if (!slot || slot.uses <= 0) return false;
    const def = itemDef(slot.id);
    if (!def || !def.apply) return false;
    const label = def.apply(this, t, itemValue(slot));
    if (label == null) return false;
    slot.uses--;
    if (slot.uses <= 0) t.items.splice(idx, 1);
    this.floaters.push({ x: t.x, y: t.y - 80, text: `${def.icon} ${label}`, t: 0, color: RARITY[def.rarity].color, big: true });
    if (typeof Sfx !== 'undefined' && Sfx.select) Sfx.select();
    this.ui.refresh(this);
    return true;
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
    this.updatePlanes(dt);
    this.updateCrates(dt);
    this.updateMines(dt);
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
        if (!this.projectiles.length && !this.pending.length && this.stateT > 0.25) {
          // 속사 장전기 — 같은 턴에 한 번 더
          if (this.cur && this.cur.alive && this.cur.buffs.extraShot > 0) {
            this.cur.buffs.extraShot--;
            this.turnLeft = Math.max(this.turnLeft, 14);
            this.ui.banner('⏩ 추가 사격!', 900);
            if (this.cur.isAI) this.ai = { phase: 'wait', t: 0, plan: null, moved: 0 };
            this.setState('aim');
          } else {
            this.setState('settle');
          }
        }
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
        // 주운 아이템을 상황 보고 씁니다 (한 턴에 최대 두 개 — 두 번째는 더 확실할 때만)
        if (!ai.usedItem && t.items.length && ai.t > 0.2) {
          ai.usedItem = true;
          for (let k = 0; k < 2 && t.items.length; k++) {
            const idx = AI.pickItem(this, t, this.difficulty, k === 0 ? 0 : 28);
            if (idx < 0) break;
            const slot = t.items[idx];
            const def = slot && itemDef(slot.id);
            if (!def || !def.apply) break;
            const label = def.apply(this, t, itemValue(slot));
            if (label == null) break;
            slot.uses--;
            if (slot.uses <= 0) t.items.splice(idx, 1);
            this.floaters.push({ x: t.x, y: t.y - 80 - k * 20, text: `${def.icon} ${label}`, t: 0, color: RARITY[def.rarity].color });
          }
        }
        if (ai.t > 0.45) {
          ai.plan = AI.plan(this, t);
          if (!ai.plan) { this.setState('settle'); return; }
          t.weapon = ai.plan.weapon;
          // 상자를 노리고 움직인다는 걸 눈에 보이게
          if (ai.plan.crate && Math.abs(ai.plan.dx) > 6) {
            this.floaters.push({ x: t.x, y: t.y - 72, text: '📦 보급품 확보', t: 0, color: '#ffd479' });
          }
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

      // 유도 장치 — 가장 가까운 적 쪽으로 살짝 휘어짐
      if (p.homing && p.t > 8) {
        const owner = this.tanks[p.owner];
        let best = null, bd = Infinity;
        for (const tk of this.tanks) {
          if (!tk.alive || (owner && tk.team === owner.team)) continue;
          const d = Math.hypot(tk.cx - p.x, tk.cy - p.y);
          if (d < bd) { bd = d; best = tk; }
        }
        if (best) {
          const dx = best.cx - p.x, dy = best.cy - p.y;
          const L = Math.hypot(dx, dy) || 1;
          p.vx += (dx / L) * 0.1;
          p.vy += (dy / L) * 0.07;
        }
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

      // 관통 탄심 — 지형을 한 겹 뚫고 지나갑니다
      if (c.type === 'ground' && p.pierce > 0) {
        p.pierce--;
        if (HAS_FX) { FX.debris(c.x, c.y, 7, '#6b4a2a'); FX.spark(c.x, c.y, 5); }
        for (let k = 0; k < 300; k++) {
          stepProjectile(p, this.wind);
          if (p.x < 0 || p.x > W || p.y > H + 40) break;
          if (p.y < Terrain.heightAt(this.ground, p.x)) break;
        }
        continue;
      }

      // 도탄 장치 — 지면에서 한 번 튕깁니다
      if (c.type === 'ground' && p.bounce > 0) {
        p.bounce--;
        const gl = Terrain.heightAt(this.ground, clamp(c.x - 6, 0, W - 1));
        const gr = Terrain.heightAt(this.ground, clamp(c.x + 6, 0, W - 1));
        const ang = Math.atan2(gr - gl, 12);
        const nx = Math.sin(ang), ny = -Math.cos(ang);
        const dot = p.vx * nx + p.vy * ny;
        p.vx = (p.vx - 2 * dot * nx) * 0.72;
        p.vy = (p.vy - 2 * dot * ny) * 0.72;
        p.x = c.x;
        p.y = Terrain.heightAt(this.ground, clamp(c.x, 0, W - 1)) - 5;
        if (HAS_FX) FX.spark(c.x, c.y, 7);
        if (typeof Sfx !== 'undefined' && Sfx.armorGraze) Sfx.armorGraze();
        continue;
      }

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
        // 분열 신관 — 착탄점 좌우로 연쇄 폭발
        if (p.splitFuse) {
          for (let k = 0; k < 2; k++) {
            const ox = clamp(c.x + (k === 0 ? -36 : 36), 6, W - 6);
            this.pending.push({
              delay: 0.13 * (k + 1), x: ox,
              y: Terrain.heightAt(this.ground, ox) - 4,
              w: p.weapon, owner: p.owner,
            });
          }
        }
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
    if (t.alive && drop > 50 && t.buffs.chute) {
      this.floaters.push({ x: t.x, y: t.y - 66, text: '낙하산', t: 0, color: '#9fe8ff' });
    } else if (t.alive && drop > 50) {
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
    this.drawMines(c);
    this.drawCrates(c);
    this.drawAimHint(c);

    for (const t of this.tanks) if (!t.alive) this.drawTank(c, t);
    for (const t of this.tanks) if (t.alive) this.drawTank(c, t);

    this.drawProjectiles(c);
    this.drawPlanes(c);
    this.drawMeteorWarnings(c);
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

  /* ── 보급 상자 · 지뢰 · 항공기 ── */

  drawCrates(c) {
    for (const cr of this.crates) {
      const def = cr.item && itemDef(cr.item.id);
      const col = def ? RARITY[def.rarity].color : '#8fa3bf';
      c.save();
      // 낙하산
      if (!cr.landed && cr.chute) {
        const sway = Math.sin(cr.t * 2.4) * 5;
        c.fillStyle = 'rgba(240,246,255,0.9)';
        c.beginPath();
        c.ellipse(cr.x + sway, cr.y - 26, 19, 13, 0, Math.PI, 0);
        c.fill();
        c.strokeStyle = 'rgba(200,215,235,0.85)';
        c.lineWidth = 1.2;
        c.beginPath();
        c.moveTo(cr.x + sway - 18, cr.y - 26); c.lineTo(cr.x - 6, cr.y - 8);
        c.moveTo(cr.x + sway + 18, cr.y - 26); c.lineTo(cr.x + 6, cr.y - 8);
        c.stroke();
      }
      const bob = cr.landed ? Math.sin(this.time * 3 + cr.bob) * 1.6 : 0;
      const y = cr.y + bob;
      // 상자
      TankArt.rr(c, cr.x - 9, y - 9, 18, 18, 3);
      const g = c.createLinearGradient(0, y - 9, 0, y + 9);
      g.addColorStop(0, '#b98f52');
      g.addColorStop(1, '#6d5027');
      c.fillStyle = g; c.fill();
      c.strokeStyle = '#3a2a14'; c.lineWidth = 1.2; c.stroke();
      c.fillStyle = col;
      c.fillRect(cr.x - 9, y - 2.4, 18, 4.8);
      c.strokeStyle = 'rgba(255,255,255,0.28)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(cr.x - 9, y - 5); c.lineTo(cr.x + 9, y - 5); c.stroke();
      // 발광
      if (cr.landed) {
        const pulse = 0.4 + Math.sin(this.time * 3.5 + cr.bob) * 0.25;
        const rg = c.createRadialGradient(cr.x, y, 2, cr.x, y, 30);
        rg.addColorStop(0, TankArt.alpha(col, 0.42 * pulse));
        rg.addColorStop(1, TankArt.alpha(col, 0));
        c.fillStyle = rg;
        c.beginPath(); c.arc(cr.x, y, 30, 0, Math.PI * 2); c.fill();
      }
      // 내용물은 주워 봐야 압니다 — 투시했을 때만 아이콘이 보입니다
      c.font = '12px system-ui, sans-serif';
      c.textAlign = 'center';
      if (def && this.crateScanned()) {
        c.fillText(def.icon, cr.x, y + 4);
      } else {
        c.fillStyle = 'rgba(255,255,255,0.72)';
        c.font = 'bold 12px system-ui, sans-serif';
        c.fillText('?', cr.x, y + 4);
      }
      // 마우스를 올린 상자는 테두리로 짚어 줍니다
      if (cr === this.hoverCrate) {
        c.strokeStyle = col;
        c.lineWidth = 1.6;
        c.setLineDash([4, 3]);
        c.lineDashOffset = -this.time * 18;
        c.beginPath(); c.arc(cr.x, y, 17, 0, Math.PI * 2); c.stroke();
        c.setLineDash([]);
      }
      c.restore();
    }
  }

  drawMines(c) {
    for (const m of this.mines) {
      c.save();
      c.fillStyle = '#22242a';
      c.beginPath(); c.ellipse(m.x, m.y, 7, 4, 0, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#4a4d55'; c.lineWidth = 1; c.stroke();
      const blink = Math.sin(m.t * 5) > 0.2;
      c.fillStyle = blink ? '#ff5348' : 'rgba(255,83,72,0.25)';
      c.beginPath(); c.arc(m.x, m.y - 3, 1.7, 0, Math.PI * 2); c.fill();
      c.restore();
    }
  }

  drawPlanes(c) {
    for (const pl of this.planes) {
      c.save();
      c.translate(pl.x, pl.y);
      c.scale(pl.dir, 1);
      const bomber = pl.kind === 'bomber';
      const col = bomber ? '#4a4f5c' : '#6b7686';
      // 동체
      c.fillStyle = col;
      c.beginPath();
      c.moveTo(-34, 0); c.lineTo(-24, -5); c.lineTo(20, -5);
      c.lineTo(34, 0); c.lineTo(20, 5); c.lineTo(-24, 5);
      c.closePath(); c.fill();
      c.strokeStyle = '#22262e'; c.lineWidth = 1.1; c.stroke();
      // 날개 · 꼬리
      c.fillStyle = TankArt.shade(col, -0.2);
      c.beginPath(); c.moveTo(-4, -3); c.lineTo(8, -20); c.lineTo(14, -20); c.lineTo(8, -3); c.closePath(); c.fill();
      c.beginPath(); c.moveTo(-4, 3); c.lineTo(8, 18); c.lineTo(14, 18); c.lineTo(8, 3); c.closePath(); c.fill();
      c.beginPath(); c.moveTo(-30, -2); c.lineTo(-24, -13); c.lineTo(-19, -13); c.lineTo(-22, -2); c.closePath(); c.fill();
      // 조종석 · 표식
      c.fillStyle = '#a8e4ff';
      c.beginPath(); c.ellipse(18, -2, 5, 2.6, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = bomber ? '#ff5348' : '#4fe07f';
      c.beginPath(); c.arc(0, 0, 2.6, 0, Math.PI * 2); c.fill();
      // 프로펠러 흐림
      c.strokeStyle = 'rgba(220,230,245,0.35)';
      c.lineWidth = 2;
      c.beginPath(); c.ellipse(34, 0, 2.5, 11, 0, 0, Math.PI * 2); c.stroke();
      c.restore();
    }
  }

  drawMeteorWarnings(c) {
    for (const q of this.pending) {
      if (!q.meteor) continue;
      const k = clamp(1 - q.delay / 0.6, 0, 1);
      c.save();
      c.globalAlpha = 0.35 + Math.sin(this.time * 18) * 0.25;
      c.strokeStyle = '#ff7b3d';
      c.lineWidth = 2.4;
      c.beginPath(); c.arc(q.x, q.y - 6, 44 * (1 - k * 0.55) + 12, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.moveTo(q.x, q.y - 6 - 40); c.lineTo(q.x, q.y - 6 - 14); c.stroke();
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

    // 탄도 컴퓨터 — 예상 궤적과 탄착점
    if (t.buffs.scope) {
      const p = makeProjectile(tip.x, tip.y, t.angle, t.power, t.id, t.weaponDef(), this.shotOpts(t));
      const pts = [];
      let hit = null;
      for (let i = 0; i < 1000; i++) {
        stepProjectile(p, this.wind);
        if (i % 3 === 0) pts.push(p.x, p.y);
        if (p.y > H + 40 || p.x < -240 || p.x > W + 240) break;
        if (p.x >= 0 && p.x < W && p.y >= Terrain.heightAt(this.ground, p.x)) { hit = { x: p.x, y: p.y }; break; }
      }
      c.save();
      c.setLineDash([2, 6]);
      c.strokeStyle = 'rgba(120,230,180,0.7)';
      c.lineWidth = 1.8;
      c.beginPath();
      for (let i = 0; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
      c.stroke();
      c.setLineDash([]);
      if (hit) {
        c.strokeStyle = 'rgba(120,230,180,0.9)';
        c.lineWidth = 2;
        c.beginPath(); c.arc(hit.x, hit.y, 9, 0, Math.PI * 2); c.stroke();
        c.beginPath();
        c.moveTo(hit.x - 13, hit.y); c.lineTo(hit.x + 13, hit.y);
        c.moveTo(hit.x, hit.y - 13); c.lineTo(hit.x, hit.y + 13);
        c.stroke();
      }
      c.restore();
    }
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

    // 정찰 상태 표시 — 들킨 적에게는 👁, 차폐 중이면 🕶
    if (t.alive && t.team !== this.viewTeam()) {
      const mark = t.buffs.cloak ? '🕶' : t.revealed ? '👁' : '';
      if (mark) {
        c.font = '11px system-ui, sans-serif';
        c.fillText(mark, bx + bw + 9, by + 5);
      }
    }

    // 마우스를 올린 전차는 테두리로 짚어 줍니다
    if (t === this.hoverTank && t.alive) {
      c.strokeStyle = t.color;
      c.lineWidth = 1.6;
      c.setLineDash([5, 4]);
      c.lineDashOffset = -this.time * 18;
      const r = 26 * s;
      c.beginPath(); c.ellipse(t.x, t.y - 12 * s, r, r * 0.85, 0, 0, Math.PI * 2); c.stroke();
      c.setLineDash([]);
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
