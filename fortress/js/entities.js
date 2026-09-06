'use strict';
/* entities.js — 월드 상수, 무기, 탱크, 발사체 물리 */
const W = 1600, H = 800;
const MAX_FUEL = 140;       // 턴당 이동 가능 거리(px)
const MOVE_SPEED = 75;      // px/s
const TANK_HIT_R = 17;      // 피격 반경

const PHYS = { G: 0.22, WIND: 0.0045, SPEED: 0.165, MAX_STEPS: 1400 };

const PLAYER_COLORS = ['#ff5a5a', '#4d8dff', '#5ce08a', '#ffd23f', '#d76bff', '#3fd3ff'];
const TEAM_LABELS = ['A', 'B', 'C'];

const WEAPONS = [
  { id: 'shell',  name: '기본탄',   icon: '●', ammo: Infinity, radius: 34, damage: 38, count: 1, spread: 0 },
  { id: 'triple', name: '3연발',    icon: '☰', ammo: 3,        radius: 22, damage: 22, count: 3, spread: 4 },
  { id: 'nuke',   name: '대형폭탄', icon: '☢', ammo: 1,        radius: 70, damage: 75, count: 1, spread: 0 },
  { id: 'digger', name: '굴착탄',   icon: '▼', ammo: 2,        radius: 55, damage: 18, count: 1, spread: 0 },
];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const approach = (v, target, step) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step));

class Tank {
  constructor(o) {
    this.id = o.id;
    this.name = o.name;
    this.color = o.color;
    this.team = o.team;
    this.isAI = !!o.isAI;
    this.x = o.x;
    this.y = o.y;
    this.hp = 100;
    this.maxHp = 100;
    this.alive = true;
    this.facing = o.facing || 1;   // 1 = 오른쪽, -1 = 왼쪽
    this.elev = 55;                // 포신 고각 0~90
    this.power = 60;
    this.fuel = MAX_FUEL;
    this.weapon = 0;
    this.ammo = {};
    for (const w of WEAPONS) this.ammo[w.id] = w.ammo;
    this.kills = 0;
    this.damageDealt = 0;
    this.lastTrail = null;
    this.fallFrom = null;
  }
  /** 절대 각도 0(오른쪽)~180(왼쪽) */
  get angle() { return this.facing === 1 ? this.elev : 180 - this.elev; }
  set angle(a) {
    a = clamp(a, 0, 180);
    if (a > 90) { this.facing = -1; this.elev = 180 - a; }
    else { this.facing = 1; this.elev = a; }
  }
  get cx() { return this.x; }
  get cy() { return this.y - 10; }
  get barrelBase() { return { x: this.x, y: this.y - 16 }; }
  get barrelTip() {
    const a = (this.angle * Math.PI) / 180;
    return { x: this.x + Math.cos(a) * 26, y: this.y - 16 - Math.sin(a) * 26 };
  }
  hasAmmo(idx) { return this.ammo[WEAPONS[idx].id] > 0; }
}

/** 발사체 한 스텝 진행 */
function stepProjectile(p, wind) {
  p.vx += wind * PHYS.WIND;
  p.vy += PHYS.G;
  p.x += p.vx;
  p.y += p.vy;
  p.t++;
}

/** 충돌 판정: null | {type:'out'|'ground'|'tank', x, y, tank} */
function collideProjectile(p, ground, tanks, ownerId) {
  if (p.y > H + 60 || p.x < -300 || p.x > W + 300) return { type: 'out' };
  const pts = [[p.x - p.vx * 0.5, p.y - p.vy * 0.5], [p.x, p.y]];
  for (const [x, y] of pts) {
    if (x >= 0 && x < W && y >= Terrain.heightAt(ground, x)) return { type: 'ground', x, y };
    for (const t of tanks) {
      if (!t.alive) continue;
      if (t.id === ownerId && p.t < 8) continue;
      const dx = t.cx - x, dy = t.cy - y;
      if (dx * dx + dy * dy < TANK_HIT_R * TANK_HIT_R) return { type: 'tank', tank: t, x, y };
    }
  }
  return null;
}

function makeProjectile(sx, sy, angleDeg, power, ownerId, weapon) {
  const a = (angleDeg * Math.PI) / 180;
  return {
    x: sx, y: sy,
    vx: Math.cos(a) * power * PHYS.SPEED,
    vy: -Math.sin(a) * power * PHYS.SPEED,
    t: 0, owner: ownerId, weapon, trail: [],
  };
}
