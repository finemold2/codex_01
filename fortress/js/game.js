'use strict';
/* game.js — 턴 상태 머신, 물리, 렌더링 */
const SUDDEN_DEATH_ROUND = 20;
const SUDDEN_DEATH_DMG = 6;

class Game {
  /**
   * cfg: { players:[{name,isAI,team,color}], difficulty, theme, teamMode }
   * ui: { onTurn, refresh, frame, banner, onGameOver }
   */
  constructor(canvas, cfg, ui) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cfg = cfg;
    this.ui = ui;
    this.difficulty = cfg.difficulty || 'normal';
    this.teamMode = !!cfg.teamMode;

    const themeKeys = Object.keys(Terrain.THEMES);
    this.themeKey = cfg.theme && cfg.theme !== 'random' ? cfg.theme : themeKeys[Math.floor(Math.random() * themeKeys.length)];
    this.theme = Terrain.THEMES[this.themeKey];

    this.seed = (Math.random() * 1e9) >>> 0;
    this.ground = Terrain.generate(W, H, this.seed);
    this.farHills = this.makeFarHills();
    this.clouds = Array.from({ length: 6 }, (_, i) => ({ x: Math.random() * W, y: 40 + Math.random() * 160, s: 0.6 + Math.random() * 0.8, i }));

    // 탱크 배치 (위치를 섞어 같은 팀이 붙지 않게)
    const n = cfg.players.length;
    const slots = Array.from({ length: n }, (_, i) => i).sort(() => Math.random() - 0.5);
    this.tanks = cfg.players.map((p, i) => {
      const k = slots[i];
      const x = clamp(Math.round((W * (k + 1)) / (n + 1) + (Math.random() * 100 - 50)), 40, W - 40);
      return new Tank({
        id: i, name: p.name, color: p.color, team: p.team, isAI: p.isAI,
        x, y: Terrain.heightAt(this.ground, x), facing: x < W / 2 ? 1 : -1,
      });
    });

    this.turnIdx = -1;
    this.round = 1;
    this.wind = 0;
    this.projectiles = [];
    this.explosions = [];
    this.particles = [];
    this.floaters = [];
    this.shake = 0;
    this.time = 0;
    this.stateT = 0;
    this.input = { left: false, right: false, up: false, down: false, pup: false, pdown: false };
    this.charging = false;
    this.chargeTick = 0;
    this.winnerTeam = undefined;
    this.running = true;
    this.acc = 0;
    this.last = performance.now();

    this.nextTurn();
    this._loop = this.loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  destroy() { this.running = false; }

  /* ---------------- 턴 관리 ---------------- */

  setState(s) { this.state = s; this.stateT = 0; }

  aliveTeams() { return new Set(this.tanks.filter((t) => t.alive).map((t) => t.team)); }

  nextTurn() {
    const n = this.tanks.length;
    let i = this.turnIdx;
    for (let k = 0; k < n; k++) { i = (i + 1) % n; if (this.tanks[i].alive) break; }
    if (i <= this.turnIdx) {
      this.round++;
      if (this.round >= SUDDEN_DEATH_ROUND) {
        this.ui.banner(this.round === SUDDEN_DEATH_ROUND ? '☠ 서든데스! 매 라운드 체력 감소' : '☠ 서든데스', 1400);
        for (const t of this.tanks) if (t.alive) this.damage(t, SUDDEN_DEATH_DMG, null);
        if (this.checkWin()) return;
        // 사망자 반영해 다시 탐색
        for (let k = 0; k < n; k++) { if (this.tanks[i].alive) break; i = (i + 1) % n; }
      }
    }
    this.turnIdx = i;
    this.cur = this.tanks[i];
    this.cur.fuel = MAX_FUEL;
    if (!this.cur.hasAmmo(this.cur.weapon)) this.cur.weapon = 0;
    this.wind = Math.round(clamp(this.wind * 0.3 + (Math.random() * 2 - 1) * 10, -10, 10) * 10) / 10;
    this.charging = false;
    this.ai = this.cur.isAI ? { phase: 'wait', t: 0, plan: null, moved: 0 } : null;
    this.setState('intro');
    this.ui.banner(`${this.cur.name} 턴${this.cur.isAI ? '' : ' — 당신!'}`, 900);
    this.ui.onTurn(this);
  }

  checkWin() {
    const teams = this.aliveTeams();
    if (teams.size <= 1) {
      this.winnerTeam = teams.size ? [...teams][0] : null;
      this.setState('over');
      this.ui.onGameOver(this);
      return true;
    }
    return false;
  }

  /* ---------------- 이동 ---------------- */

  /** 순수 함수: (x,y)에서 dir 방향으로 dist만큼 걷기 */
  walk(x, y, dir, dist) {
    let used = 0;
    while (used < dist) {
      const step = Math.min(1, dist - used);
      const nx = x + dir * step;
      if (nx < 16 || nx > W - 16) break;
      const gy = Terrain.heightAt(this.ground, nx);
      if (y - gy > 1.7 * step) break;   // 60° 이상 오르막은 막힘
      x = nx; y = gy; used += step;
    }
    return { x, y, used };
  }

  probeWalk(t, dx) {
    const r = this.walk(t.x, t.y, Math.sign(dx), Math.min(Math.abs(dx), t.fuel));
    return { x: r.x, y: r.y };
  }

  moveTank(t, dir, dt) {
    t.facing = dir;
    if (t.fuel <= 0) return 0;
    const r = this.walk(t.x, t.y, dir, Math.min(MOVE_SPEED * dt, t.fuel));
    t.x = r.x; t.y = r.y; t.fuel -= r.used;
    return r.used;
  }

  /* ---------------- 사격 ---------------- */

  selectWeapon(idx) {
    if (this.state !== 'aim' || this.cur.isAI) return;
    if (!this.cur.hasAmmo(idx)) return;
    this.cur.weapon = idx;
    this.ui.refresh(this);
  }

  cycleWeapon() {
    const n = WEAPONS.length;
    for (let k = 1; k <= n; k++) {
      const idx = (this.cur.weapon + k) % n;
      if (this.cur.hasAmmo(idx)) { this.selectWeapon(idx); return; }
    }
  }

  startCharge() {
    if (this.state !== 'aim' || this.cur.isAI || this.charging) return;
    this.charging = true;
    this.cur.power = 0;
    this.chargeTick = 0;
  }

  releaseCharge() {
    if (!this.charging) return;
    this.charging = false;
    if (this.cur.power < 5) this.cur.power = 5;
    this.fire(this.cur);
  }

  fireNow() {
    if (this.state !== 'aim' || this.cur.isAI) return;
    this.charging = false;
    this.fire(this.cur);
  }

  fire(t) {
    if (this.state !== 'aim') return;
    if (!t.hasAmmo(t.weapon)) t.weapon = 0;
    const w = WEAPONS[t.weapon];
    if (w.ammo !== Infinity) t.ammo[w.id]--;
    const offsets = w.count === 1 ? [0] : [-w.spread, 0, w.spread];
    const tip = t.barrelTip;
    for (const off of offsets) {
      this.projectiles.push(makeProjectile(tip.x, tip.y, t.angle + off, t.power, t.id, w));
    }
    t.lastPower = t.power;
    t.lastTrail = [];
    this.muzzle = { x: tip.x, y: tip.y, t: 0 };
    Sfx.fire();
    this.setState('fire');
    this.ui.refresh(this);
  }

  explode(x, y, w, ownerId) {
    Terrain.crater(this.ground, x, y, w.radius, H - 6);
    this.explosions.push({ x, y, r: w.radius, t: 0, dur: 0.55 });
    for (let i = 0; i < 18 + w.radius / 3; i++) {
      const a = Math.random() * Math.PI, sp = 2 + Math.random() * (3 + w.radius / 15);
      this.particles.push({
        x, y, vx: Math.cos(a) * sp * (Math.random() < 0.5 ? 1 : -1), vy: -Math.sin(a) * sp * 1.4,
        life: 0.6 + Math.random() * 0.6, t: 0, r: 1.5 + Math.random() * 3,
        color: Math.random() < 0.6 ? this.theme.ground : this.theme.top,
      });
    }
    const R = w.radius * 1.35;
    for (const t of this.tanks) {
      if (!t.alive) continue;
      const d = Math.hypot(t.cx - x, t.cy - y);
      if (d < R) {
        let dmg = w.damage * (1 - d / R);
        if (d < w.radius * 0.5) dmg = Math.max(dmg, w.damage * 0.85);
        this.damage(t, Math.round(dmg), ownerId);
      }
    }
    this.shake = Math.max(this.shake, 0.18 + w.radius / 300);
    Sfx.boom(w.radius);
  }

  damage(t, dmg, srcId) {
    if (dmg <= 0 || !t.alive) return;
    t.hp = Math.max(0, t.hp - dmg);
    const src = srcId != null ? this.tanks[srcId] : null;
    const friendly = src && src !== t && src.team === t.team;
    if (src && src !== t && !friendly) src.damageDealt += dmg;
    this.floaters.push({ x: t.x, y: t.y - 48, text: `-${dmg}`, t: 0, color: friendly ? '#ffb347' : src === t ? '#bbb' : '#fff' });
    Sfx.hit();
    if (t.hp <= 0) {
      t.alive = false;
      this.explosions.push({ x: t.x, y: t.cy, r: 28, t: 0, dur: 0.7, death: true });
      if (src && src !== t && !friendly) src.kills++;
      this.ui.banner(`💥 ${t.name} 격파!`, 1100);
    }
    this.ui.refresh(this);
  }

  /* ---------------- 업데이트 ---------------- */

  loop(now) {
    if (!this.running) return;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.acc += dt;
    const step = 1 / 60;
    let n = 0;
    while (this.acc >= step && n < 6) { this.update(step); this.acc -= step; n++; }
    if (n === 6) this.acc = 0;
    this.render();
    this.ui.frame(this);
    requestAnimationFrame(this._loop);
  }

  update(dt) {
    this.time += dt;
    this.stateT += dt;
    this.updateEffects(dt);
    this.settleTanks();

    switch (this.state) {
      case 'intro':
        if (this.stateT > 0.9) this.setState('aim');
        break;
      case 'aim':
        if (this.cur.isAI) this.updateAI(dt); else this.updateHuman(dt);
        break;
      case 'fire':
        this.updateProjectiles();
        if (!this.projectiles.length) this.setState('settle');
        break;
      case 'settle': {
        const busy = this.tanks.some((t) => t.falling) || this.explosions.length > 0;
        if (!busy && this.stateT > 0.4) {
          if (!this.checkWin()) this.nextTurn();
        }
        break;
      }
      default:
        break;
    }
  }

  updateHuman(dt) {
    const t = this.cur, k = this.input;
    if (k.left) this.moveTank(t, -1, dt);
    if (k.right) this.moveTank(t, 1, dt);
    if (k.up) t.elev = clamp(t.elev + 45 * dt, 0, 90);
    if (k.down) t.elev = clamp(t.elev - 45 * dt, 0, 90);
    if (this.charging) {
      t.power = clamp(t.power + 62 * dt, 0, 100);
      this.chargeTick += dt;
      if (this.chargeTick > 0.08) { this.chargeTick = 0; Sfx.charge(t.power); }
      if (t.power >= 100) this.releaseCharge();
    } else {
      if (k.pup) t.power = clamp(t.power + 40 * dt, 5, 100);
      if (k.pdown) t.power = clamp(t.power - 40 * dt, 5, 100);
    }
  }

  updateAI(dt) {
    const ai = this.ai, t = this.cur;
    ai.t += dt;
    switch (ai.phase) {
      case 'wait':
        if (ai.t > 0.5) {
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
          ai.phase = 'aim'; ai.t = 0; break;
        }
        const before = t.x;
        this.moveTank(t, Math.sign(want), dt);
        ai.moved += t.x - before;
        if (t.x === before) { ai.phase = 'aim'; ai.t = 0; }
        break;
      }
      case 'aim': {
        const ta = ai.plan.angle;
        const tf = ta > 90 ? -1 : 1;
        t.facing = tf;
        const te = tf === 1 ? ta : 180 - ta;
        t.elev = approach(t.elev, te, 70 * dt);
        t.power = approach(t.power, ai.plan.power, 90 * dt);
        if (Math.abs(t.elev - te) < 1e-6 && Math.abs(t.power - ai.plan.power) < 1e-6) { ai.phase = 'pre'; ai.t = 0; }
        break;
      }
      case 'pre':
        if (ai.t > 0.35) this.fire(t);
        break;
      default:
        break;
    }
  }

  updateProjectiles() {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      stepProjectile(p, this.wind);
      if (p.t % 2 === 0) p.trail.push(p.x, p.y);
      const c = collideProjectile(p, this.ground, this.tanks, p.owner);
      if (!c) continue;
      this.projectiles.splice(i, 1);
      const owner = this.tanks[p.owner];
      if (owner && owner.lastTrail) owner.lastTrail.push(p.trail);
      if (c.type === 'out') { this.floaters.push({ x: clamp(p.x, 40, W - 40), y: 60, text: '장외', t: 0, color: '#ccc' }); continue; }
      this.explode(c.x, c.y, p.weapon, p.owner);
    }
  }

  settleTanks() {
    for (const t of this.tanks) {
      const gy = Terrain.heightAt(this.ground, t.x);
      if (t.y < gy - 0.5) {
        if (!t.falling) { t.falling = true; t.fallFrom = t.y; t.vy = 0; }
        t.vy += PHYS.G * 1.5;
        t.y = Math.min(gy, t.y + t.vy);
        if (t.y >= gy) {
          t.falling = false;
          const drop = t.y - t.fallFrom;
          if (t.alive && drop > 45) this.damage(t, Math.round((drop - 45) * 0.35), null);
        }
      } else if (t.y > gy) {
        t.y = gy;
      }
    }
  }

  updateEffects(dt) {
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i]; e.t += dt;
      if (e.t > e.dur) this.explosions.splice(i, 1);
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]; p.t += dt;
      p.vy += 0.25; p.x += p.vx; p.y += p.vy;
      if (p.t > p.life) this.particles.splice(i, 1);
    }
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i]; f.t += dt; f.y -= 25 * dt;
      if (f.t > 1.2) this.floaters.splice(i, 1);
    }
    if (this.muzzle) { this.muzzle.t += dt; if (this.muzzle.t > 0.12) this.muzzle = null; }
    for (const c of this.clouds) { c.x += (this.wind * 3 + 4) * c.s * dt; if (c.x > W + 150) c.x = -150; if (c.x < -150) c.x = W + 150; }
    this.shake = Math.max(0, this.shake - dt);
  }

  /* ---------------- 렌더링 ---------------- */

  makeFarHills() {
    const r = Terrain.rng(this.seed ^ 0x9e3779b9);
    const pts = [];
    const f1 = 0.004 + r() * 0.003, f2 = 0.011 + r() * 0.005, p1 = r() * 6, p2 = r() * 6;
    for (let x = 0; x <= W; x += 8) {
      pts.push(H * 0.42 + Math.sin(x * f1 + p1) * 70 + Math.sin(x * f2 + p2) * 30);
    }
    return pts;
  }

  render() {
    const c = this.ctx, th = this.theme;
    c.save();
    if (this.shake > 0) c.translate((Math.random() - 0.5) * this.shake * 22, (Math.random() - 0.5) * this.shake * 22);

    // 하늘
    const sky = c.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, th.sky[0]); sky.addColorStop(0.55, th.sky[1]); sky.addColorStop(1, th.sky[2]);
    c.fillStyle = sky; c.fillRect(-30, -30, W + 60, H + 60);

    // 태양
    c.fillStyle = th.sun; c.globalAlpha = 0.9;
    c.beginPath(); c.arc(W * 0.8, 110, 38, 0, Math.PI * 2); c.fill();
    c.globalAlpha = 1;

    // 구름
    c.fillStyle = 'rgba(255,255,255,0.75)';
    for (const cl of this.clouds) {
      c.beginPath();
      c.ellipse(cl.x, cl.y, 55 * cl.s, 18 * cl.s, 0, 0, Math.PI * 2);
      c.ellipse(cl.x + 30 * cl.s, cl.y - 10 * cl.s, 35 * cl.s, 20 * cl.s, 0, 0, Math.PI * 2);
      c.ellipse(cl.x - 30 * cl.s, cl.y - 5 * cl.s, 30 * cl.s, 16 * cl.s, 0, 0, Math.PI * 2);
      c.fill();
    }

    // 원경 산
    c.fillStyle = th.far;
    c.beginPath(); c.moveTo(0, H);
    this.farHills.forEach((y, i) => c.lineTo(i * 8, y));
    c.lineTo(W, H); c.closePath(); c.fill();

    // 지형
    const g = this.ground;
    const grd = c.createLinearGradient(0, H * 0.3, 0, H);
    grd.addColorStop(0, th.ground); grd.addColorStop(1, th.groundDark);
    c.fillStyle = grd;
    c.beginPath(); c.moveTo(0, H + 40);
    for (let x = 0; x < W; x += 2) c.lineTo(x, g[x]);
    c.lineTo(W - 1, g[W - 1]); c.lineTo(W, H + 40); c.closePath(); c.fill();
    c.strokeStyle = th.top; c.lineWidth = 9; c.lineJoin = 'round';
    c.beginPath(); for (let x = 0; x < W; x += 2) c.lineTo(x, g[x] + 3); c.stroke();
    c.strokeStyle = th.topLine; c.lineWidth = 2.5;
    c.beginPath(); for (let x = 0; x < W; x += 2) c.lineTo(x, g[x]); c.stroke();

    // 이전 사격 궤적 (현재 사람 플레이어)
    if (this.state === 'aim' && !this.cur.isAI && this.cur.lastTrail) {
      c.setLineDash([4, 8]); c.strokeStyle = 'rgba(255,255,255,0.45)'; c.lineWidth = 2;
      for (const tr of this.cur.lastTrail) {
        c.beginPath();
        for (let i = 0; i < tr.length; i += 2) c.lineTo(tr[i], tr[i + 1]);
        c.stroke();
      }
      c.setLineDash([]);
    }

    // 탱크
    for (const t of this.tanks) this.drawTank(c, t);

    // 발사체
    for (const p of this.projectiles) {
      c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = 2;
      c.beginPath();
      const tr = p.trail, start = Math.max(0, tr.length - 40);
      for (let i = start; i < tr.length; i += 2) c.lineTo(tr[i], tr[i + 1]);
      c.stroke();
      c.fillStyle = '#222'; c.beginPath(); c.arc(p.x, p.y, p.weapon.id === 'nuke' ? 7 : 4.5, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#ffb347'; c.beginPath(); c.arc(p.x, p.y, p.weapon.id === 'nuke' ? 3.5 : 2, 0, Math.PI * 2); c.fill();
    }
    if (this.muzzle) {
      c.fillStyle = 'rgba(255,220,120,0.9)';
      c.beginPath(); c.arc(this.muzzle.x, this.muzzle.y, 10 * (1 - this.muzzle.t / 0.12), 0, Math.PI * 2); c.fill();
    }

    // 폭발
    for (const e of this.explosions) {
      const k = e.t / e.dur;
      const r = e.r * (0.4 + 0.9 * Math.sqrt(k));
      c.globalAlpha = 1 - k;
      c.fillStyle = e.death ? '#ff8a3d' : '#ffcc55';
      c.beginPath(); c.arc(e.x, e.y, r, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#fff'; c.globalAlpha = (1 - k) * 0.8;
      c.beginPath(); c.arc(e.x, e.y, r * 0.5, 0, Math.PI * 2); c.fill();
      c.globalAlpha = 1;
    }
    // 파편
    for (const p of this.particles) {
      c.globalAlpha = 1 - p.t / p.life; c.fillStyle = p.color;
      c.beginPath(); c.arc(p.x, p.y, p.r, 0, Math.PI * 2); c.fill();
    }
    c.globalAlpha = 1;
    // 데미지 텍스트
    c.font = 'bold 22px system-ui, sans-serif'; c.textAlign = 'center';
    for (const f of this.floaters) {
      c.globalAlpha = 1 - Math.max(0, f.t - 0.6) / 0.6;
      c.fillStyle = 'rgba(0,0,0,0.6)'; c.fillText(f.text, f.x + 2, f.y + 2);
      c.fillStyle = f.color; c.fillText(f.text, f.x, f.y);
    }
    c.globalAlpha = 1;
    c.restore();
  }

  drawTank(c, t) {
    const g = this.ground;
    const gl = Terrain.heightAt(g, t.x - 10), gr = Terrain.heightAt(g, t.x + 10);
    const tilt = Math.atan2(gr - gl, 20);
    const dead = !t.alive;

    c.save();
    c.translate(t.x, t.y);
    c.rotate(tilt);
    // 궤도
    c.fillStyle = dead ? '#2a2a2a' : '#1e1e24';
    roundRect(c, -17, -8, 34, 8, 4); c.fill();
    c.fillStyle = dead ? '#444' : '#55555f';
    for (let i = -12; i <= 12; i += 8) { c.beginPath(); c.arc(i, -4, 2.2, 0, Math.PI * 2); c.fill(); }
    // 차체
    c.fillStyle = dead ? '#4a4a4a' : t.color;
    roundRect(c, -14, -17, 28, 10, 4); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.18)';
    roundRect(c, -12, -16, 24, 3, 2); c.fill();
    // 포탑
    c.fillStyle = dead ? '#3a3a3a' : shade(t.color, -25);
    c.beginPath(); c.arc(0, -17, 7, 0, Math.PI * 2); c.fill();
    c.restore();

    // 포신
    if (!dead) {
      const a = (t.angle * Math.PI) / 180;
      const b = t.barrelBase;
      c.strokeStyle = '#d8d8e0'; c.lineWidth = 4.5; c.lineCap = 'round';
      c.beginPath(); c.moveTo(b.x, b.y); c.lineTo(b.x + Math.cos(a) * 26, b.y - Math.sin(a) * 26); c.stroke();
    } else {
      // 잔해 연기
      c.fillStyle = 'rgba(60,60,60,0.5)';
      const s = (this.time * 1.5) % 1;
      c.beginPath(); c.arc(t.x + Math.sin(this.time * 3) * 4, t.y - 26 - s * 22, 5 + s * 6, 0, Math.PI * 2); c.fill();
    }

    // HP 바 + 이름
    const bw = 44, bx = t.x - bw / 2, by = t.y - 36;
    c.fillStyle = 'rgba(0,0,0,0.55)'; roundRect(c, bx - 1, by - 1, bw + 2, 7, 3); c.fill();
    if (t.alive) {
      const hpk = t.hp / t.maxHp;
      c.fillStyle = hpk > 0.5 ? '#5ce08a' : hpk > 0.25 ? '#ffd23f' : '#ff5a5a';
      roundRect(c, bx, by, bw * hpk, 5, 2); c.fill();
    }
    c.font = 'bold 13px system-ui, sans-serif'; c.textAlign = 'center';
    c.fillStyle = 'rgba(0,0,0,0.7)'; c.fillText(t.name, t.x + 1, by - 5);
    c.fillStyle = dead ? '#999' : '#fff'; c.fillText(t.name, t.x, by - 6);
    if (this.teamMode) {
      c.font = 'bold 11px system-ui, sans-serif';
      c.fillStyle = t.color;
      c.fillText(TEAM_LABELS[t.team] + '팀', t.x, by - 19);
    }

    // 현재 턴 표시
    if (t === this.cur && this.state !== 'over' && t.alive) {
      const bob = Math.sin(this.time * 6) * 4;
      const ty = by - (this.teamMode ? 40 : 28) + bob;
      c.fillStyle = t.color;
      c.beginPath(); c.moveTo(t.x - 8, ty - 10); c.lineTo(t.x + 8, ty - 10); c.lineTo(t.x, ty); c.closePath(); c.fill();
    }
  }
}

function roundRect(c, x, y, w, h, r) {
  r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp((n >> 16) + amt, 0, 255), g = clamp(((n >> 8) & 255) + amt, 0, 255), b = clamp((n & 255) + amt, 0, 255);
  return `rgb(${r},${g},${b})`;
}
