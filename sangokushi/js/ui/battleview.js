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
    if (bf.night) { sky.addColorStop(0, '#101a2b'); sky.addColorStop(1, '#060a12'); }
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

  _drawTiles(ctx) {
    const bf = this.b.bf, T = this.tile;
    for (let y = 0; y < bf.H; y++) {
      for (let x = 0; x < bf.W; x++) {
        const i = y * bf.W + x;
        const t = BT_BY_ID[bf.map[i]];
        const px = this.ox + x * T, py = this.oy + y * T;
        const d = this.decor[i];
        let col = shade(t.color, Math.round((d.r - 0.5) * 14));
        if (bf.night) col = shade(col, -34);
        ctx.fillStyle = col;
        ctx.fillRect(px, py, T, T);

        // 지형 장식
        ctx.save();
        if (t.id === BT.FOREST.id) {
          ctx.fillStyle = 'rgba(20,40,18,.55)';
          for (let k = 0; k < 3; k++) {
            const tx = px + 4 + d.r * (T - 12) + k * 6, ty = py + 6 + d.r2 * (T - 14);
            ctx.beginPath();
            ctx.moveTo(tx, ty + 8); ctx.lineTo(tx + 3.5, ty); ctx.lineTo(tx + 7, ty + 8);
            ctx.closePath(); ctx.fill();
          }
        } else if (t.id === BT.MOUNT.id || t.id === BT.CLIFF.id) {
          ctx.fillStyle = t.id === BT.CLIFF.id ? 'rgba(24,20,16,.7)' : 'rgba(40,34,26,.5)';
          ctx.beginPath();
          ctx.moveTo(px + 2, py + T - 3); ctx.lineTo(px + T * 0.42, py + 4);
          ctx.lineTo(px + T - 2, py + T - 3); ctx.closePath(); ctx.fill();
          ctx.fillStyle = 'rgba(230,230,235,.30)';
          ctx.beginPath();
          ctx.moveTo(px + T * 0.42, py + 4); ctx.lineTo(px + T * 0.30, py + T * 0.36);
          ctx.lineTo(px + T * 0.56, py + T * 0.36); ctx.closePath(); ctx.fill();
        } else if (t.id === BT.HILL.id) {
          ctx.fillStyle = 'rgba(60,48,26,.35)';
          ctx.beginPath(); ctx.ellipse(px + T / 2, py + T * 0.72, T * 0.4, T * 0.24, 0, Math.PI, 0); ctx.fill();
        } else if (t.water) {
          ctx.strokeStyle = 'rgba(190,225,240,.28)'; ctx.lineWidth = 1;
          const off = Math.sin(this.t / 400 + x + y) * 2;
          ctx.beginPath();
          ctx.moveTo(px + 3, py + T * 0.4 + off);
          ctx.quadraticCurveTo(px + T / 2, py + T * 0.28 + off, px + T - 3, py + T * 0.4 + off);
          ctx.stroke();
        } else if (t.id === BT.MARSH.id) {
          ctx.fillStyle = 'rgba(30,50,30,.4)';
          ctx.beginPath(); ctx.arc(px + T * (0.3 + d.r * 0.4), py + T * (0.3 + d.r2 * 0.4), T * 0.14, 0, Math.PI * 2); ctx.fill();
        } else if (t.wall || t.gate || t.id === BT.TOWER.id) {
          ctx.strokeStyle = 'rgba(30,24,16,.55)'; ctx.lineWidth = 1;
          for (let k = 0; k < 3; k++) ctx.strokeRect(px + 1, py + 1 + k * (T / 3), T - 2, T / 3);
          if (t.gate) {
            ctx.fillStyle = 'rgba(60,36,16,.8)';
            ctx.fillRect(px + T * 0.2, py + T * 0.25, T * 0.6, T * 0.75);
          }
          if (t.id === BT.TOWER.id) {
            ctx.fillStyle = 'rgba(90,72,44,.9)';
            ctx.fillRect(px + T * 0.22, py + T * 0.1, T * 0.56, T * 0.8);
          }
        } else if (t.id === BT.CAMP.id) {
          ctx.fillStyle = 'rgba(200,180,120,.55)';
          ctx.beginPath();
          ctx.moveTo(px + T / 2, py + 4); ctx.lineTo(px + T - 4, py + T - 4);
          ctx.lineTo(px + 4, py + T - 4); ctx.closePath(); ctx.fill();
        } else if (t.id === BT.ROAD.id || t.id === BT.BRIDGE.id) {
          ctx.strokeStyle = 'rgba(90,72,42,.35)'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(px, py + T / 2); ctx.lineTo(px + T, py + T / 2); ctx.stroke();
        } else if (t.id === BT.RUIN.id) {
          ctx.fillStyle = 'rgba(40,36,30,.6)';
          ctx.fillRect(px + 4 + d.r * 6, py + T - 12, 6, 8);
          ctx.fillRect(px + T - 12 - d.r2 * 4, py + T - 10, 5, 6);
        }
        ctx.restore();

        // 격자
        ctx.strokeStyle = 'rgba(0,0,0,.16)';
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 0.5, py + 0.5, T - 1, T - 1);

        // 불 / 물
        const fire = bf.fires[i];
        if (fire > 0) {
          const fl = 0.5 + Math.sin(this.t / 90 + i) * 0.25;
          const grd = ctx.createRadialGradient(px + T / 2, py + T / 2, 1, px + T / 2, py + T / 2, T * 0.8);
          grd.addColorStop(0, `rgba(255,220,120,${0.75 * fl})`);
          grd.addColorStop(0.45, `rgba(240,120,30,${0.6 * fl})`);
          grd.addColorStop(1, 'rgba(120,30,0,0)');
          ctx.fillStyle = grd; ctx.fillRect(px - T * 0.3, py - T * 0.3, T * 1.6, T * 1.6);
        }
        if (bf.floods[i] > 0) {
          ctx.fillStyle = `rgba(60,130,180,${0.30 + Math.sin(this.t / 300 + i) * 0.08})`;
          ctx.fillRect(px, py, T, T);
        }
      }
    }
    // 함정 (아군 것만)
    for (const tr of bf.traps) {
      if (tr.side !== 'atk' && this.playerSide !== tr.side) continue;
      const px = this.ox + tr.x * T, py = this.oy + tr.y * T;
      ctx.strokeStyle = 'rgba(230,180,60,.6)'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(px + 6, py + 6); ctx.lineTo(px + T - 6, py + T - 6);
      ctx.moveTo(px + T - 6, py + 6); ctx.lineTo(px + 6, py + T - 6); ctx.stroke();
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

  _drawUnits(ctx) {
    const T = this.tile;
    for (const u of this.b.units) {
      if (u.dead) continue;
      const px = this.ox + u.x * T, py = this.oy + u.y * T;
      const isSel = this.sel === u.id;
      const side = u.side === 'atk' ? '#c8443c' : '#2f6fb5';
      const realm = this.g.realmById[u.side === 'atk' ? this.b.attackerRealm : this.b.defenderRealm];
      const col = realm ? realm.color : side;

      ctx.save();
      if (u.hidden) ctx.globalAlpha = 0.42;

      // 깃발 배경
      ctx.fillStyle = shade(col, -50);
      roundRect(ctx, px + 2, py + 2, T - 4, T - 4, 4); ctx.fill();
      ctx.fillStyle = col;
      roundRect(ctx, px + 3, py + 3, T - 6, (T - 6) * 0.62, 3); ctx.fill();

      // 병과 글자
      ctx.fillStyle = '#fdf5e2';
      ctx.font = `700 ${Math.round(T * 0.42)}px "Noto Serif KR", serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(ARMS_GLYPH[u.arms] || '兵', px + T / 2, py + T * 0.30);

      // 병력 바
      const hp = Math.max(0, u.troops / Math.max(1, u.maxTroops));
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(px + 3, py + T - 9, T - 6, 3.5);
      ctx.fillStyle = hp > 0.5 ? '#68c463' : hp > 0.25 ? '#d8b23c' : '#d8503c';
      ctx.fillRect(px + 3, py + T - 9, (T - 6) * hp, 3.5);
      // 사기 바
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(px + 3, py + T - 5, T - 6, 3);
      ctx.fillStyle = '#6fa8d6';
      ctx.fillRect(px + 3, py + T - 5, (T - 6) * (u.morale / 100), 3);

      // 상태 표식
      let sy = py + 3;
      if (u.confused > 0) { ctx.fillStyle = '#c88ae0'; ctx.beginPath(); ctx.arc(px + T - 6, sy + 3, 3, 0, 7); ctx.fill(); sy += 8; }
      if (u.routed) { ctx.fillStyle = '#e0603c'; ctx.beginPath(); ctx.arc(px + T - 6, sy + 3, 3, 0, 7); ctx.fill(); sy += 8; }
      if (u.ambush) { ctx.fillStyle = '#8fd06a'; ctx.beginPath(); ctx.arc(px + T - 6, sy + 3, 3, 0, 7); ctx.fill(); }
      if (u.acted) {
        ctx.fillStyle = 'rgba(0,0,0,.40)';
        roundRect(ctx, px + 2, py + 2, T - 4, T - 4, 4); ctx.fill();
      }
      // 선택
      if (isSel) {
        ctx.strokeStyle = '#ffe9a8'; ctx.lineWidth = 2.4;
        const p = 1 + Math.sin(this.t / 180) * 0.06;
        roundRect(ctx, px + 1, py + 1, (T - 2) * p, (T - 2) * p, 5); ctx.stroke();
      }
      ctx.restore();

      // 이름
      if (T >= 26) {
        ctx.font = `600 ${Math.max(9, Math.round(T * 0.30))}px "Noto Sans KR", sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        const nm = u.name.length > 4 ? u.name.slice(0, 4) : u.name;
        const tw = ctx.measureText(nm).width;
        ctx.fillStyle = 'rgba(10,8,5,.72)';
        roundRect(ctx, px + T / 2 - tw / 2 - 3, py + T + 1, tw + 6, 13, 2); ctx.fill();
        ctx.fillStyle = '#f2e7cf';
        ctx.fillText(nm, px + T / 2, py + T + 2);
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
    if (bf.night) { ctx.fillStyle = 'rgba(10,16,36,.30)'; ctx.fillRect(0, 0, W, H); }
    if (wid === 'heat') { ctx.fillStyle = 'rgba(200,120,40,.10)'; ctx.fillRect(0, 0, W, H); }
  }
}

function shade(hex, amt) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  const c = [1, 2, 3].map(i => Math.max(0, Math.min(255, parseInt(m[i], 16) + amt)));
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
}
