'use strict';
/* entities.js — 월드 상수, 무기 정의, 전차, 발사체 물리 */

const W = 1600, H = 800;
const MOVE_SPEED = 78;            // px/s
const BASE_HIT_R = 16;            // 피격 반경 기준값 (전차 크기 배율이 곱해짐)

const PHYS = { G: 0.215, WIND: 0.0046, SPEED: 0.168, MAX_STEPS: 1500 };

const PLAYER_COLORS = ['#ff4d4d', '#3d8bff', '#3fd67e', '#ffcc2e', '#c96bff', '#2fd8e0'];
const TEAM_LABELS = ['A', 'B', 'C'];
const TEAM_COLORS = ['#ff5a5a', '#4d8dff', '#5ce08a'];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const approach = (v, target, step) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step));

/* ─────────────────────────── 무기 ─────────────────────────── */
/* behavior:
 *   std      착탄 즉시 폭발
 *   airburst 정점에서 공중 폭발
 *   split    정점에서 여러 발로 분열
 *   roller   지면에 닿으면 경사를 따라 굴러감
 *   drill    착탄점에 수직 갱도를 뚫음
 *   napalm   착탄점에 불바다 생성 (지속 피해)
 *   quake    넓고 얕게 지형을 무너뜨림
 *   bunker   착탄점에 흙벽을 세움 (피해 없음)
 *   teleport 발사자를 착탄점으로 이동 (피해 없음)
 *   chain    착탄점에서 전방으로 3연속 폭발
 *   frost    적을 얼려 다음 턴 이동력을 깎음
 */
const WEAPONS = {
  shell:    { name: '기본탄',   icon: '●', ammo: Infinity, radius: 34, damage: 38, behavior: 'std',      fire: 'cannon',  kind: 'normal', desc: '무제한. 안정적인 표준 포탄.' },
  twin:     { name: '이중포',   icon: '❙❙', ammo: 4,       radius: 26, damage: 25, behavior: 'std',      fire: 'cannon',  kind: 'normal', count: 2, spread: 3, desc: '두 발이 나란히 날아갑니다.' },
  multi3:   { name: '3연발',    icon: '☰',  ammo: 4,       radius: 22, damage: 20, behavior: 'std',      fire: 'gatling', kind: 'small',  count: 3, spread: 5, desc: '넓게 퍼지는 세 발.' },
  multi6:   { name: '6연발',    icon: '▤',  ammo: 3,       radius: 16, damage: 13, behavior: 'std',      fire: 'gatling', kind: 'small',  count: 6, spread: 3.2, desc: '전선을 뒤덮는 탄막.' },
  cluster:  { name: '클러스터', icon: '✳',  ammo: 3,       radius: 20, damage: 16, behavior: 'split',    fire: 'rocket',  kind: 'normal', split: { n: 5, spread: 1.5, radius: 22, damage: 19 }, desc: '정점에서 다섯 발로 갈라집니다.' },
  mirv:     { name: '미르브',   icon: '⁂',  ammo: 2,       radius: 26, damage: 20, behavior: 'split',    fire: 'rocket',  kind: 'normal', split: { n: 3, spread: 2.6, radius: 34, damage: 30 }, desc: '정점에서 세 발의 대형탄으로.' },
  roller:   { name: '롤러',     icon: '◍',  ammo: 3,       radius: 32, damage: 34, behavior: 'roller',   fire: 'mortar',  kind: 'normal', desc: '지면에 닿으면 경사를 따라 굴러갑니다.' },
  drill:    { name: '굴착탄',   icon: '⛏',  ammo: 3,       radius: 26, damage: 24, behavior: 'drill',    fire: 'heavy',   kind: 'quake',  desc: '땅을 뚫어 발밑을 무너뜨립니다.' },
  napalm:   { name: '네이팜',   icon: '♨',  ammo: 2,       radius: 30, damage: 18, behavior: 'napalm',   fire: 'rocket',  kind: 'fire',   desc: '불바다를 만들어 계속 태웁니다.' },
  quake:    { name: '지진탄',   icon: '≈',  ammo: 2,       radius: 92, damage: 24, behavior: 'quake',    fire: 'heavy',   kind: 'quake',  desc: '넓은 지형을 통째로 무너뜨립니다.' },
  nuke:     { name: '핵탄두',   icon: '☢',  ammo: 1,       radius: 78, damage: 88, behavior: 'std',      fire: 'heavy',   kind: 'nuke',   desc: '단 한 발. 전장을 지웁니다.' },
  bunker:   { name: '방어벽',   icon: '⛰',  ammo: 2,       radius: 0,  damage: 0,  behavior: 'bunker',   fire: 'mortar',  kind: 'small',  desc: '착탄점에 흙벽을 세웁니다.' },
  teleport: { name: '순간이동', icon: '⇄',  ammo: 2,       radius: 0,  damage: 0,  behavior: 'teleport', fire: 'laser',   kind: 'small',  desc: '착탄점으로 내 전차를 옮깁니다.' },
  sniper:   { name: '저격탄',   icon: '➤',  ammo: 3,       radius: 18, damage: 48, behavior: 'std',      fire: 'laser',   kind: 'small',  speed: 1.32, desc: '빠르고 곧게. 명중하면 아픕니다.' },
  flak:     { name: '공중폭발', icon: '✷',  ammo: 3,       radius: 46, damage: 32, behavior: 'airburst', fire: 'cannon',  kind: 'normal', desc: '정점에서 공중 폭발합니다.' },
  hail:     { name: '강우탄',   icon: '⁙',  ammo: 2,       radius: 14, damage: 10, behavior: 'split',    fire: 'rocket',  kind: 'small',  split: { n: 10, spread: 3.4, radius: 14, damage: 10 }, desc: '열 발이 비처럼 쏟아집니다.' },
  chain:    { name: '연쇄탄',   icon: '⋰',  ammo: 2,       radius: 28, damage: 20, behavior: 'chain',    fire: 'heavy',   kind: 'normal', desc: '착탄점에서 앞으로 세 번 연쇄 폭발.' },
  frost:    { name: '빙결탄',   icon: '❄',  ammo: 3,       radius: 40, damage: 26, behavior: 'frost',    fire: 'laser',   kind: 'ice',    desc: '적을 얼려 다음 턴 이동을 묶습니다.' },
};

for (const id in WEAPONS) {
  const w = WEAPONS[id];
  w.id = id;
  w.count = w.count || 1;
  w.spread = w.spread || 0;
  w.speed = w.speed || 1;
}

/* ─────────────────────────── 전차 ─────────────────────────── */

class Tank {
  constructor(o) {
    this.id = o.id;
    this.name = o.name;
    this.color = o.color;
    this.team = o.team;
    this.isAI = !!o.isAI;
    this.type = tankType(o.typeId);
    this.pal = TankArt.pal(o.color);

    this.x = o.x;
    this.y = o.y;
    this.maxHp = this.type.hp;
    this.hp = this.maxHp;
    this.alive = true;
    this.facing = o.facing || 1;
    this.elev = clamp(52, this.type.minElev, this.type.maxElev);
    this.power = 60;
    this.maxFuel = this.type.fuel;
    this.fuel = this.maxFuel;
    this.roll = 0;
    this.frozen = 0;
    this.burning = 0;

    this.weapons = this.type.weapons.slice();
    this.weapon = 0;
    this.ammo = {};
    for (const id of this.weapons) this.ammo[id] = WEAPONS[id].ammo;

    this.kills = 0;
    this.damageDealt = 0;
    this.shots = 0;
    this.hits = 0;
    this.lastTrail = null;
    this.lastPower = null;
    this.fallFrom = null;
    this.charge = 0;
  }

  get hitR() { return BASE_HIT_R * this.type.size; }
  get cx() { return this.x; }
  get cy() { return this.y - 12 * this.type.size; }
  /** 절대 각도 0(오른쪽) ~ 180(왼쪽) */
  get angle() { return this.facing === 1 ? this.elev : 180 - this.elev; }
  set angle(a) {
    a = clamp(a, 0, 180);
    if (a > 90) { this.facing = -1; this.elev = 180 - a; }
    else { this.facing = 1; this.elev = a; }
  }
  get art() { return TankArt.get(this.type.id); }
  get barrelPivot() {
    const a = this.art;
    const s = this.type.size;
    const p = a && a.pivot ? a.pivot : [2, -19];
    return { x: this.x + p[0] * s * this.facing, y: this.y + p[1] * s };
  }
  get barrelLen() {
    const a = this.art;
    return ((a && a.barrelLen) || this.type.barrel) * this.type.size;
  }
  get barrelTip() {
    const piv = this.barrelPivot;
    const r = (this.angle * Math.PI) / 180;
    const L = this.barrelLen + 4;
    return { x: piv.x + Math.cos(r) * L, y: piv.y - Math.sin(r) * L };
  }
  weaponId(i) { return this.weapons[i != null ? i : this.weapon]; }
  weaponDef(i) { return WEAPONS[this.weaponId(i)]; }
  hasAmmo(i) { const id = this.weapons[i]; return id != null && this.ammo[id] > 0; }
  muzzleSpeed() { return this.power * PHYS.SPEED * this.type.power; }
}

/* ───────────────────────── 발사체 ───────────────────────── */

function makeProjectile(sx, sy, angleDeg, power, ownerId, weapon, opts) {
  const a = (angleDeg * Math.PI) / 180;
  const sp = power * PHYS.SPEED * ((opts && opts.powerMul) || 1) * (weapon ? weapon.speed : 1);
  return {
    x: sx, y: sy,
    vx: Math.cos(a) * sp,
    vy: -Math.sin(a) * sp,
    t: 0,
    owner: ownerId,
    weapon,
    child: (opts && opts.child) || null,   // 분열탄 자식 설정
    split: !!(weapon && weapon.behavior === 'split') && !(opts && opts.child),
    airburst: !!(weapon && weapon.behavior === 'airburst') && !(opts && opts.child),
    rolling: false,
    rollT: 0,
    trail: [],
  };
}

function stepProjectile(p, wind) {
  p.vx += wind * PHYS.WIND;
  p.vy += PHYS.G;
  p.x += p.vx;
  p.y += p.vy;
  p.t++;
}

/** 충돌 판정: null | {type:'out'|'ground'|'tank', x, y, tank} */
function collideProjectile(p, ground, tanks, ownerId) {
  if (p.y > H + 80 || p.x < -400 || p.x > W + 400) return { type: 'out' };
  const steps = 2;
  for (let i = 1; i <= steps; i++) {
    const x = p.x - p.vx * (1 - i / steps);
    const y = p.y - p.vy * (1 - i / steps);
    if (x >= 0 && x < W && y >= Terrain.heightAt(ground, x)) return { type: 'ground', x, y };
    for (let k = 0; k < tanks.length; k++) {
      const t = tanks[k];
      if (!t.alive) continue;
      if (t.id === ownerId && p.t < 9) continue;
      const r = t.hitR || BASE_HIT_R;
      const dx = t.cx - x, dy = t.cy - y;
      if (dx * dx + dy * dy < r * r) return { type: 'tank', tank: t, x, y };
    }
  }
  return null;
}
