// ============================================================
//  전투 화면 렌더러 — 절차 전장을 타일로 그리고
//  부대 · 이동 범위 · 사거리 · 불 · 물 · 함정을 표시한다.
// ============================================================
import { BT, BT_BY_ID } from '../core/battlegen.js';
import { FORMATION_BY_ID } from '../core/battle.js';
import { mulberry32 } from '../core/rng.js';
import { roundRect, short } from './map.js';

const ARMS_GLYPH = { 보병: '步', 기병: '騎', 궁병: '弓', 수군: '船', 병기: '械' };

export class BattleView {
  constructor(canvas, battle, game) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.b = battle;
    this.g = game;
    this.tile = 30;
    this.ox = 0; this.oy = 0;
    this.sel = null;
    this.mode = 'idle';       // idle | move | attack | tactic
    this.reach = [];
    this.targets = [];
    this.hoverCell = null;
    this.effects = [];
    this.t = 0;
    this.decor = this._decor();
    this.fitView();
  }

  _decor() {
    const rnd = mulberry32(this.b.bf.W * 7919 + this.b.bf.H * 104729);
    const out = [];
    for (let y = 0; y < this.b.bf.H; y++) for (let x = 0; x < this.b.bf.W; x++) {
      out.push({ r: rnd(), r2: rnd(), r3: rnd() });
    }
    return out;
  }

  fitView() {
    const W = this.cv.clientWidth || 900, H = this.cv.clientHeight || 600;
    this.tile = Math.max(16, Math.floor(Math.min(W / (this.b.bf.W + 1), H / (this.b.bf.H + 1))));
    this.ox = Math.round((W - this.b.bf.W * this.tile) / 2);
    this.oy = Math.round((H - this.b.bf.H * this.tile) / 2);
  }

  cellAt(sx, sy) {
    const x = Math.floor((sx - this.ox) / this.tile);
    const y = Math.floor((sy - this.oy) / this.tile);
    if (x < 0 || y < 0 || x >= this.b.bf.W || y >= this.b.bf.H) return null;
    return [x, y];
  }

  addEffect(kind, x, y, opt = {}) {
    this.effects.push({ kind, x, y, t0: performance.now(), life: opt.life ?? 700, ...opt });
  }

  draw(dt = 16) {
    this.t += dt;
    const ctx = this.ctx;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = this.cv.clientWidth, H = this.cv.clientHeight;
    if (this.cv.width !== W * dpr || this.cv.height !== H * dpr) {
      this.cv.width = W * dpr; this.cv.height = H * dpr;
      this.fitView();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bf = this.b.bf;

    // 하늘/배경 — 날씨와 시간대에 따라
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    if (bf.night) { sky.addColorStop(0, '#1a2740'); sky.addColorStop(1, '#0b1220'); }
    else if (bf.weather.id === 'storm' || bf.weather.id === 'rain') { sky.addColorStop(0, '#33393f'); sky.addColorStop(1, '#191d21'); }
    else if (bf.weather.id === 'fog') { sky.addColorStop(0, '#54595b'); sky.addColorStop(1, '#2b2e30'); }
    else if (bf.weather.id === 'heat') { sky.addColorStop(0, '#4a3a24'); sky.addColorStop(1, '#241a10'); }
    else { sky.addColorStop(0, '#26313a'); sky.addColorStop(1, '#141a1f'); }
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);

    this._drawTiles(ctx);
    this._drawOverlay(ctx);
    this._drawUnits(ctx);
    this._drawEffects(ctx);
    this._drawWeather(ctx, W, H);
  }

  /** 전장 바닥 — 타일 경계를 흐트러뜨려 붓으로 칠한 지형처럼 */
  _buildGround() {
    const bf = this.b.bf, T = this.tile;
    const W = bf.W * T, H = bf.H * T;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    const rnd = mulberry32(bf.W * 7919 + bf.H * 104729 + T);
    const night = bf.night;

    const PAL = {
      [BT.PLAIN.id]:  ['#97a35c', '#86904f'],
      [BT.GRASS.id]:  ['#8b9954', '#7b8749'],
      [BT.FOREST.id]: ['#456a3c', '#375830'],
      [BT.HILL.id]:   ['#a08c52', '#8e7c48'],
      [BT.MOUNT.id]:  ['#786c5b', '#665c4e'],
      [BT.CLIFF.id]:  ['#4a433a', '#3c362f'],
      [BT.WATER.id]:  ['#2e5c7c', '#27506c'],
      [BT.FORD.id]:   ['#4a7b95', '#3f6b84'],
      [BT.MARSH.id]:  ['#4b5c44', '#3f4e3a'],
      [BT.ROAD.id]:   ['#a6976c', '#96885f'],
      [BT.WALL.id]:   ['#7f766a', '#6d655a'],
      [BT.GATE.id]:   ['#8a6a41', '#785c38'],
      [BT.INNER.id]:  ['#a89b7e', '#96896e'],
      [BT.TOWER.id]:  ['#918468', '#7f735a'],
      [BT.CAMP.id]:   ['#977a45', '#876c3c'],
      [BT.SAND.id]:   ['#c0aa79', '#b09a6c'],
      [BT.SNOW.id]:   ['#c8ced3', '#b6bcc1'],
      [BT.BRIDGE.id]: ['#9d8757', '#8c784c'],
      [BT.RUIN.id]:   ['#7d766a', '#6c665c'],
    };

    // 1) 바탕 — 칸 색을 깔고 통째로 흐려 경계를 녹인다
    const base = document.createElement('canvas');
    base.width = W; base.height = H;
    const bc = base.getContext('2d');
    for (let y = 0; y < bf.H; y++) {
      for (let x = 0; x < bf.W; x++) {
        const t = BT_BY_ID[bf.map[y * bf.W + x]];
        const pal = PAL[t.id] || ['#7f7f70', '#6f6f60'];
        bc.fillStyle = rnd() > 0.5 ? pal[0] : pal[1];
        bc.fillRect(x * T - T * 0.12, y * T - T * 0.12, T * 1.24, T * 1.24);
      }
    }
    for (let k = 0; k < bf.W * bf.H * 2; k++) {
      const gx = Math.floor(rnd() * bf.W), gy = Math.floor(rnd() * bf.H);
      const t = BT_BY_ID[bf.map[gy * bf.W + gx]];
      const pal = PAL[t.id] || ['#7f7f70', '#6f6f60'];
      bc.globalAlpha = 0.5;
      bc.fillStyle = rnd() > 0.5 ? pal[0] : pal[1];
      bc.beginPath();
      bc.ellipse(gx * T + rnd() * T, gy * T + rnd() * T,
        T * (0.3 + rnd() * 0.5), T * (0.25 + rnd() * 0.4), rnd() * 3, 0, Math.PI * 2);
      bc.fill();
    }
    bc.globalAlpha = 1;
    c.save();
    c.filter = `blur(${Math.max(2, T * 0.30)}px)`;
    c.drawImage(base, 0, 0);
    c.restore();
    c.save();
    c.globalAlpha = 0.06;
    for (let k = 0; k < W * H / 90; k++) {
      c.fillStyle = rnd() > 0.5 ? '#ffffff' : '#000000';
      c.fillRect(rnd() * W, rnd() * H, 1.5, 1.5);
    }
    c.restore();

    // 2) 지형별 세부
    for (let y = 0; y < bf.H; y++) {
      for (let x = 0; x < bf.W; x++) {
        const t = BT_BY_ID[bf.map[y * bf.W + x]];
        const px = x * T, py = y * T;
        c.save();
        if (t.id === BT.FOREST.id) {
          for (let k = 0; k < 4; k++) {
            const tx = px + T * (0.15 + rnd() * 0.7), ty = py + T * (0.2 + rnd() * 0.65);
            const r = T * (0.14 + rnd() * 0.12);
            c.globalAlpha = 0.5;
            c.fillStyle = '#22391f';
            c.beginPath(); c.ellipse(tx + 1.5, ty + 2, r * 1.1, r * 0.7, 0, 0, Math.PI * 2); c.fill();
            c.globalAlpha = 0.92;
            c.fillStyle = rnd() > 0.5 ? '#3d5c33' : '#4f7040';
            c.beginPath(); c.arc(tx, ty, r, 0, Math.PI * 2); c.fill();
            c.fillStyle = 'rgba(150,190,120,.30)';
            c.beginPath(); c.arc(tx - r * 0.3, ty - r * 0.35, r * 0.45, 0, Math.PI * 2); c.fill();
          }
        } else if (t.id === BT.MOUNT.id || t.id === BT.CLIFF.id) {
          c.globalAlpha = 0.95;
          const base = t.id === BT.CLIFF.id ? '#3b352d' : '#5e5548';
          c.fillStyle = base;
          c.beginPath();
          c.moveTo(px + T * 0.06, py + T * 0.92);
          c.lineTo(px + T * (0.35 + rnd() * 0.2), py + T * (0.08 + rnd() * 0.12));
          c.lineTo(px + T * 0.94, py + T * 0.92);
          c.closePath(); c.fill();
          c.fillStyle = 'rgba(226,224,216,.55)';
          c.beginPath();
          c.moveTo(px + T * 0.44, py + T * 0.14);
          c.lineTo(px + T * 0.30, py + T * 0.52);
          c.lineTo(px + T * 0.58, py + T * 0.48);
          c.closePath(); c.fill();
          c.strokeStyle = 'rgba(20,16,10,.45)'; c.lineWidth = 1;
          c.beginPath(); c.moveTo(px + T * 0.46, py + T * 0.12); c.lineTo(px + T * 0.70, py + T * 0.9); c.stroke();
        } else if (t.id === BT.HILL.id) {
          c.globalAlpha = 0.55;
          c.fillStyle = '#a8955c';
          c.beginPath(); c.ellipse(px + T * 0.5, py + T * 0.72, T * 0.42, T * 0.26, 0, Math.PI, 0); c.fill();
          c.fillStyle = 'rgba(60,48,24,.35)';
          c.beginPath(); c.ellipse(px + T * 0.62, py + T * 0.74, T * 0.26, T * 0.16, 0, Math.PI, 0); c.fill();
        } else if (t.water) {
          c.globalAlpha = 0.5;
          c.strokeStyle = '#bde4f6'; c.lineWidth = 1.2;
          for (let k = 0; k < 2; k++) {
            const wy = py + T * (0.28 + k * 0.34) + rnd() * 3;
            c.beginPath();
            c.moveTo(px + 2, wy);
            c.quadraticCurveTo(px + T * 0.5, wy - T * 0.14, px + T - 2, wy);
            c.stroke();
          }
        } else if (t.id === BT.MARSH.id) {
          c.globalAlpha = 0.6;
          c.strokeStyle = '#87a06b'; c.lineWidth = 1.1;
          for (let k = 0; k < 4; k++) {
            const gx2 = px + T * (0.2 + rnd() * 0.6), gy2 = py + T * 0.85;
            c.beginPath(); c.moveTo(gx2, gy2); c.lineTo(gx2 + (rnd() - 0.5) * 4, gy2 - T * 0.4); c.stroke();
          }
          c.fillStyle = 'rgba(40,64,52,.5)';
          c.beginPath(); c.ellipse(px + T * 0.4, py + T * 0.5, T * 0.2, T * 0.12, 0, 0, Math.PI * 2); c.fill();
        } else if (t.id === BT.SAND.id) {
          c.globalAlpha = 0.35;
          c.strokeStyle = '#e3d1a2'; c.lineWidth = 1.2;
          c.beginPath();
          c.moveTo(px, py + T * 0.6);
          c.quadraticCurveTo(px + T * 0.5, py + T * 0.3, px + T, py + T * 0.62);
          c.stroke();
        } else if (t.id === BT.SNOW.id) {
          c.globalAlpha = 0.5;
          c.fillStyle = '#ffffff';
          for (let k = 0; k < 3; k++) c.fillRect(px + rnd() * T, py + rnd() * T, 1.6, 1.6);
        } else if (t.id === BT.ROAD.id || t.id === BT.BRIDGE.id) {
          c.globalAlpha = 0.34;
          c.strokeStyle = '#6f6242'; c.lineWidth = 1;
          for (let k = 0; k < 3; k++) {
            const ry = py + T * (0.25 + k * 0.25);
            c.beginPath(); c.moveTo(px, ry + rnd() * 2); c.lineTo(px + T, ry + rnd() * 2); c.stroke();
          }
          if (t.id === BT.BRIDGE.id) {
            c.globalAlpha = 0.8;
            c.strokeStyle = '#5a4a2c'; c.lineWidth = 2;
            c.strokeRect(px + 1, py + 1, T - 2, T - 2);
          }
        } else if (t.wall || t.id === BT.TOWER.id) {
          // 성벽 — 돌 쌓기
          c.globalAlpha = 1;
          for (let row = 0; row < 3; row++) {
            for (let col2 = 0; col2 < 3; col2++) {
              const bx = px + col2 * (T / 3) + (row % 2 ? T / 6 : 0);
              const by = py + row * (T / 3);
              c.fillStyle = `rgba(${150 + rnd() * 26 | 0},${140 + rnd() * 24 | 0},${124 + rnd() * 20 | 0},.55)`;
              c.fillRect(bx + 1, by + 1, T / 3 - 2, T / 3 - 2);
              c.strokeStyle = 'rgba(30,24,16,.45)'; c.lineWidth = 1;
              c.strokeRect(bx + 1, by + 1, T / 3 - 2, T / 3 - 2);
            }
          }
          if (t.id === BT.TOWER.id) {
            c.fillStyle = '#6e6248';
            c.fillRect(px + T * 0.2, py + T * 0.06, T * 0.6, T * 0.88);
            c.fillStyle = '#8e7f5e';
            c.beginPath();
            c.moveTo(px + T * 0.08, py + T * 0.22);
            c.lineTo(px + T * 0.5, py - T * 0.06);
            c.lineTo(px + T * 0.92, py + T * 0.22);
            c.closePath(); c.fill();
          }
        } else if (t.gate) {
          c.fillStyle = '#4a3418';
          c.fillRect(px + T * 0.14, py + T * 0.16, T * 0.72, T * 0.84);
          c.strokeStyle = '#c9a349'; c.lineWidth = 1.6;
          c.strokeRect(px + T * 0.14, py + T * 0.16, T * 0.72, T * 0.84);
          c.fillStyle = 'rgba(201,163,73,.6)';
          for (let k = 0; k < 3; k++) c.fillRect(px + T * 0.2, py + T * (0.3 + k * 0.2), T * 0.6, 2);
        } else if (t.id === BT.CAMP.id) {
          c.fillStyle = 'rgba(230,214,168,.85)';
          c.beginPath();
          c.moveTo(px + T * 0.5, py + T * 0.14);
          c.lineTo(px + T * 0.9, py + T * 0.86);
          c.lineTo(px + T * 0.1, py + T * 0.86);
          c.closePath(); c.fill();
          c.strokeStyle = 'rgba(60,44,20,.6)'; c.lineWidth = 1; c.stroke();
          c.fillStyle = 'rgba(60,44,20,.5)';
          c.beginPath();
          c.moveTo(px + T * 0.5, py + T * 0.34);
          c.lineTo(px + T * 0.66, py + T * 0.86);
          c.lineTo(px + T * 0.34, py + T * 0.86);
          c.closePath(); c.fill();
        } else if (t.id === BT.RUIN.id) {
          c.globalAlpha = 0.75;
          c.fillStyle = '#575046';
          c.fillRect(px + T * 0.18, py + T * 0.5, T * 0.2, T * 0.4);
          c.fillRect(px + T * 0.52, py + T * 0.62, T * 0.16, T * 0.28);
          c.fillStyle = 'rgba(190,182,168,.4)';
          c.fillRect(px + T * 0.18, py + T * 0.5, T * 0.2, 3);
        } else if (t.id === BT.INNER.id) {
          // 성안 박석
          c.globalAlpha = 0.42;
          for (let r2 = 0; r2 < 2; r2++) for (let c2 = 0; c2 < 2; c2++) {
            const sxx = px + c2 * (T / 2) + (r2 % 2 ? T / 4 : 0);
            const syy = py + r2 * (T / 2);
            c.fillStyle = `rgba(${168 + rnd() * 22 | 0},${156 + rnd() * 20 | 0},${128 + rnd() * 18 | 0},.7)`;
            c.fillRect(sxx + 1, syy + 1, T / 2 - 2, T / 2 - 2);
            c.strokeStyle = 'rgba(50,42,28,.35)'; c.lineWidth = 1;
            c.strokeRect(sxx + 1, syy + 1, T / 2 - 2, T / 2 - 2);
          }
        }
        c.restore();
      }
    }

    // 3) 전체 명암 — 위에서 아래로 은근한 깊이
    const vg = c.createLinearGradient(0, 0, 0, H);
    vg.addColorStop(0, 'rgba(255,242,214,.10)');
    vg.addColorStop(1, 'rgba(0,0,0,.12)');
    c.fillStyle = vg; c.fillRect(0, 0, W, H);
    if (night) { c.fillStyle = 'rgba(22,32,64,.24)'; c.fillRect(0, 0, W, H); }

    this.ground = cv;
    this.groundTile = T;
  }

  _drawTiles(ctx) {
    const bf = this.b.bf, T = this.tile;
    if (!this.ground || this.groundTile !== T) this._buildGround();
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.55)';
    ctx.shadowBlur = 18; ctx.shadowOffsetY = 6;
    ctx.drawImage(this.ground, this.ox, this.oy);
    ctx.restore();

    // 격자 — 아주 옅게
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= bf.W; x++) {
      ctx.moveTo(this.ox + x * T + 0.5, this.oy);
      ctx.lineTo(this.ox + x * T + 0.5, this.oy + bf.H * T);
    }
    for (let y = 0; y <= bf.H; y++) {
      ctx.moveTo(this.ox, this.oy + y * T + 0.5);
      ctx.lineTo(this.ox + bf.W * T, this.oy + y * T + 0.5);
    }
    ctx.stroke();
    ctx.restore();

    // 불 · 물 · 함정 (매 프레임 변한다)
    for (let y = 0; y < bf.H; y++) {
      for (let x = 0; x < bf.W; x++) {
        const i = y * bf.W + x;
        const px = this.ox + x * T, py = this.oy + y * T;
        const fire = bf.fires[i];
        if (fire > 0) {
          const fl = 0.55 + Math.sin(this.t / 90 + i * 1.7) * 0.28;
          const grd = ctx.createRadialGradient(px + T / 2, py + T * 0.6, 1, px + T / 2, py + T / 2, T * 0.95);
          grd.addColorStop(0, `rgba(255,232,150,${0.80 * fl})`);
          grd.addColorStop(0.35, `rgba(248,140,40,${0.66 * fl})`);
          grd.addColorStop(0.7, `rgba(180,52,16,${0.34 * fl})`);
          grd.addColorStop(1, 'rgba(120,30,0,0)');
          ctx.fillStyle = grd;
          ctx.fillRect(px - T * 0.5, py - T * 0.5, T * 2, T * 2);
          // 불꽃 혀
          ctx.save();
          ctx.globalAlpha = 0.55 * fl;
          ctx.fillStyle = '#ffdc7a';
          for (let k = 0; k < 3; k++) {
            const fx = px + T * (0.3 + k * 0.2);
            const fh = T * (0.3 + Math.abs(Math.sin(this.t / 70 + k + i)) * 0.45);
            ctx.beginPath();
            ctx.moveTo(fx, py + T * 0.9);
            ctx.quadraticCurveTo(fx - T * 0.08, py + T * 0.9 - fh * 0.6, fx + T * 0.02, py + T * 0.9 - fh);
            ctx.quadraticCurveTo(fx + T * 0.1, py + T * 0.9 - fh * 0.5, fx + T * 0.14, py + T * 0.9);
            ctx.closePath(); ctx.fill();
          }
          ctx.restore();
        }
        if (bf.floods[i] > 0) {
          ctx.fillStyle = `rgba(56,124,176,${0.34 + Math.sin(this.t / 300 + i) * 0.08})`;
          ctx.fillRect(px, py, T, T);
          ctx.strokeStyle = 'rgba(190,230,250,.35)'; ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px + 2, py + T * 0.4 + Math.sin(this.t / 200 + x) * 2);
          ctx.lineTo(px + T - 2, py + T * 0.5 + Math.cos(this.t / 220 + y) * 2);
          ctx.stroke();
        }
      }
    }
    for (const tr of bf.traps) {
      if (tr.side !== this.playerSide) continue;
      const px = this.ox + tr.x * T, py = this.oy + tr.y * T;
      ctx.strokeStyle = 'rgba(232,182,64,.55)'; ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(px + T * 0.25, py + T * 0.25); ctx.lineTo(px + T * 0.75, py + T * 0.75);
      ctx.moveTo(px + T * 0.75, py + T * 0.25); ctx.lineTo(px + T * 0.25, py + T * 0.75);
      ctx.stroke();
    }
  }

  _drawOverlay(ctx) {
    const T = this.tile;
    if (this.mode === 'move') {
      ctx.fillStyle = 'rgba(90,180,255,.24)';
      ctx.strokeStyle = 'rgba(150,215,255,.55)'; ctx.lineWidth = 1.4;
      for (const [x, y] of this.reach) {
        ctx.fillRect(this.ox + x * T, this.oy + y * T, T, T);
        ctx.strokeRect(this.ox + x * T + 1, this.oy + y * T + 1, T - 2, T - 2);
      }
    } else if (this.mode === 'attack' || this.mode === 'tactic') {
      const col = this.mode === 'attack' ? 'rgba(230,70,50,' : 'rgba(180,110,230,';
      ctx.fillStyle = col + '.24)';
      ctx.strokeStyle = col + '.62)'; ctx.lineWidth = 1.4;
      for (const [x, y] of this.targets) {
        ctx.fillRect(this.ox + x * T, this.oy + y * T, T, T);
        ctx.strokeRect(this.ox + x * T + 1, this.oy + y * T + 1, T - 2, T - 2);
      }
    }
    if (this.hoverCell) {
      const [x, y] = this.hoverCell;
      ctx.strokeStyle = 'rgba(255,240,200,.85)'; ctx.lineWidth = 2;
      ctx.strokeRect(this.ox + x * T + 1, this.oy + y * T + 1, T - 2, T - 2);
    }
  }

  /** 부대 말(馬) — 세력 깃발과 병과 표식을 얹은 목패 */
  _drawUnits(ctx) {
    const T = this.tile;
    // 뒤에서 앞으로 그려 겹침이 자연스럽게
    const list = this.b.units.filter(u => !u.dead).sort((x, y) => x.y - y.y);
    for (const u of list) {
      const px = this.ox + u.x * T, py = this.oy + u.y * T;
      const cx = px + T / 2, cy = py + T / 2;
      const isSel = this.sel === u.id;
      const realm = this.g.realmById[u.side === 'atk' ? this.b.attackerRealm : this.b.defenderRealm];
      const col = realm ? realm.color : (u.side === 'atk' ? '#c8443c' : '#2f6fb5');
      const dark = shade(col, -62), lite = shade(col, 34);

      ctx.save();
      if (u.hidden) ctx.globalAlpha = 0.45;

      // 땅그림자
      ctx.fillStyle = 'rgba(0,0,0,.42)';
      ctx.beginPath();
      ctx.ellipse(cx + 1, py + T * 0.88, T * 0.34, T * 0.13, 0, 0, Math.PI * 2);
      ctx.fill();

      // 깃대 — 목패 위로 솟는다
      const poleTop = py - T * 0.30;
      const poleBot = py + T * 0.80;
      ctx.strokeStyle = '#39291a'; ctx.lineWidth = Math.max(1.2, T * 0.05);
      ctx.beginPath();
      ctx.moveTo(cx - T * 0.34, poleBot);
      ctx.lineTo(cx - T * 0.34, poleTop);
      ctx.stroke();
      // 깃발
      const wave = Math.sin(this.t / 240 + u.x * 1.3 + u.y) * T * 0.055;
      const fg = ctx.createLinearGradient(cx - T * 0.34, poleTop, cx + T * 0.26, poleTop + T * 0.3);
      fg.addColorStop(0, lite); fg.addColorStop(1, col);
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.moveTo(cx - T * 0.34, poleTop);
      ctx.quadraticCurveTo(cx - T * 0.04, poleTop + wave, cx + T * 0.26, poleTop + T * 0.05 + wave);
      ctx.lineTo(cx + T * 0.22, poleTop + T * 0.30);
      ctx.quadraticCurveTo(cx - T * 0.06, poleTop + T * 0.26 + wave, cx - T * 0.34, poleTop + T * 0.30);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.40)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#e8c15a';
      ctx.beginPath(); ctx.arc(cx - T * 0.34, poleTop - T * 0.04, T * 0.05, 0, Math.PI * 2); ctx.fill();

      // 목패 (부대 본체)
      const bw = T * 0.62, bh = T * 0.50;
      const bx = cx - bw * 0.42, by = py + T * 0.30;
      const g = ctx.createLinearGradient(bx, by, bx, by + bh);
      g.addColorStop(0, lite); g.addColorStop(0.45, col); g.addColorStop(1, dark);
      ctx.fillStyle = g;
      roundRect(ctx, bx, by, bw, bh, T * 0.08); ctx.fill();
      ctx.strokeStyle = 'rgba(16,10,4,.7)'; ctx.lineWidth = Math.max(1, T * 0.035);
      roundRect(ctx, bx, by, bw, bh, T * 0.08); ctx.stroke();
      // 위쪽 광
      ctx.fillStyle = 'rgba(255,244,214,.22)';
      roundRect(ctx, bx + 1.5, by + 1.5, bw - 3, bh * 0.32, T * 0.05); ctx.fill();

      // 병과 글자
      ctx.fillStyle = 'rgba(12,8,4,.55)';
      ctx.font = `700 ${Math.round(T * 0.30)}px "Noto Serif KR", serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(ARMS_GLYPH[u.arms] || '兵', bx + bw / 2 + 1, by + bh * 0.46 + 1);
      ctx.fillStyle = '#fdf6e4';
      ctx.fillText(ARMS_GLYPH[u.arms] || '兵', bx + bw / 2, by + bh * 0.46);

      // 병력 · 사기 막대
      const barW = T * 0.72, barX = cx - barW / 2, barY = py + T * 0.90;
      const hp = Math.max(0, u.troops / Math.max(1, u.maxTroops));
      ctx.fillStyle = 'rgba(0,0,0,.62)';
      roundRect(ctx, barX - 1, barY - 1, barW + 2, 6.5, 2); ctx.fill();
      ctx.fillStyle = hp > 0.5 ? '#6fc866' : hp > 0.25 ? '#dcb63c' : '#dc5440';
      ctx.fillRect(barX, barY, barW * hp, 3);
      ctx.fillStyle = '#6fa8d6';
      ctx.fillRect(barX, barY + 3.4, barW * (u.morale / 100), 2.2);

      // 상태 표식
      let sx2 = px + T - 5;
      const dot = (color) => {
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(sx2, py + 6, T * 0.075, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 1; ctx.stroke();
        sx2 -= T * 0.20;
      };
      if (u.confused > 0) dot('#c88ae0');
      if (u.routed) dot('#e0603c');
      if (u.ambush) dot('#8fd06a');
      if (u.taunted > 0) dot('#e8c15a');

      // 행동 완료
      if (u.acted) {
        ctx.fillStyle = 'rgba(6,4,2,.45)';
        roundRect(ctx, px + 2, py + 2, T - 4, T - 4, T * 0.1); ctx.fill();
      }
      // 선택 표시
      if (isSel) {
        const p2 = 1 + Math.sin(this.t / 190) * 0.06;
        ctx.strokeStyle = '#ffe9a8'; ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.ellipse(cx, py + T * 0.88, T * 0.42 * p2, T * 0.17 * p2, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,233,168,.35)'; ctx.lineWidth = 1.4;
        roundRect(ctx, px + 1, py + 1, T - 2, T - 2, T * 0.1); ctx.stroke();
      }
      ctx.restore();

      // 이름표
      if (T >= 24) {
        const fs = Math.max(9, Math.round(T * 0.28));
        ctx.font = `600 ${fs}px "Noto Sans KR", sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        const nm = u.name.length > 4 ? u.name.slice(0, 4) : u.name;
        const tw = ctx.measureText(nm).width;
        const ly = py + T + 1;
        ctx.fillStyle = 'rgba(8,6,3,.78)';
        roundRect(ctx, cx - tw / 2 - 4, ly, tw + 8, fs + 5, 2); ctx.fill();
        ctx.strokeStyle = u.side === 'atk' ? 'rgba(220,110,90,.5)' : 'rgba(110,160,220,.5)';
        ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = '#f4ead2';
        ctx.fillText(nm, cx, ly + 2);
      }
    }
  }

  _drawEffects(ctx) {
    const now = performance.now(), T = this.tile;
    this.effects = this.effects.filter(e => now - e.t0 < e.life);
    for (const e of this.effects) {
      const p = (now - e.t0) / e.life;
      const px = this.ox + e.x * T + T / 2, py = this.oy + e.y * T + T / 2;
      ctx.save();
      if (e.kind === 'hit') {
        ctx.globalAlpha = 1 - p;
        ctx.strokeStyle = '#ffd77a'; ctx.lineWidth = 3;
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 + p * 2;
          const r0 = T * 0.2 + p * T * 0.5, r1 = r0 + T * 0.3;
          ctx.beginPath();
          ctx.moveTo(px + Math.cos(a) * r0, py + Math.sin(a) * r0);
          ctx.lineTo(px + Math.cos(a) * r1, py + Math.sin(a) * r1);
          ctx.stroke();
        }
      } else if (e.kind === 'arrow') {
        ctx.globalAlpha = 1 - p;
        const fx = this.ox + e.fx * T + T / 2, fy = this.oy + e.fy * T + T / 2;
        ctx.strokeStyle = '#e8dcb8'; ctx.lineWidth = 1.6;
        for (let i = 0; i < 6; i++) {
          const t2 = Math.max(0, Math.min(1, p * 1.4 - i * 0.06));
          const x = fx + (px - fx) * t2, y = fy + (py - fy) * t2 - Math.sin(t2 * Math.PI) * T * 0.9;
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 6, y - 3); ctx.stroke();
        }
      } else if (e.kind === 'damage') {
        ctx.globalAlpha = 1 - p * p;
        ctx.font = `700 ${Math.round(T * 0.5)}px "Noto Sans KR", sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = e.color || '#ff8a6a';
        ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.lineWidth = 3;
        ctx.strokeText(e.text, px, py - p * T * 1.4);
        ctx.fillText(e.text, px, py - p * T * 1.4);
      } else if (e.kind === 'ring') {
        ctx.globalAlpha = 1 - p;
        ctx.strokeStyle = e.color || '#9fd6ff'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(px, py, T * 0.3 + p * T * 1.6, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }
  }

  _drawWeather(ctx, W, H) {
    const bf = this.b.bf;
    const wid = bf.weather.id;
    if (wid === 'rain' || wid === 'storm') {
      ctx.strokeStyle = 'rgba(180,210,235,.35)'; ctx.lineWidth = 1;
      const n = wid === 'storm' ? 160 : 90;
      for (let i = 0; i < n; i++) {
        const x = (i * 137 + this.t * (wid === 'storm' ? 1.4 : 0.8)) % W;
        const y = (i * 231 + this.t * (wid === 'storm' ? 2.6 : 1.7)) % H;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 4, y + 12); ctx.stroke();
      }
    } else if (wid === 'snow') {
      ctx.fillStyle = 'rgba(240,246,252,.6)';
      for (let i = 0; i < 90; i++) {
        const x = (i * 173 + Math.sin((this.t + i * 300) / 900) * 30 + this.t * 0.14) % W;
        const y = (i * 211 + this.t * 0.35) % H;
        ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill();
      }
    } else if (wid === 'fog') {
      ctx.fillStyle = 'rgba(190,196,200,.22)';
      ctx.fillRect(0, 0, W, H);
      for (let i = 0; i < 5; i++) {
        const y = (i * H / 5 + this.t * 0.02) % H;
        ctx.fillStyle = 'rgba(200,206,210,.10)';
        ctx.fillRect(0, y, W, H / 6);
      }
    } else if (wid === 'wind') {
      ctx.strokeStyle = 'rgba(230,224,200,.18)'; ctx.lineWidth = 1.4;
      for (let i = 0; i < 26; i++) {
        const y = (i * 89) % H;
        const x = (i * 211 + this.t * 0.5) % (W + 200) - 100;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 46, y - 6); ctx.stroke();
      }
    }
    if (bf.night) { ctx.fillStyle = 'rgba(12,20,44,.14)'; ctx.fillRect(0, 0, W, H); }
    if (wid === 'heat') { ctx.fillStyle = 'rgba(200,120,40,.10)'; ctx.fillRect(0, 0, W, H); }
  }
}

function shade(hex, amt) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  const c = [1, 2, 3].map(i => Math.max(0, Math.min(255, parseInt(m[i], 16) + amt)));
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
}
