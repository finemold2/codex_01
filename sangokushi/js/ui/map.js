// ============================================================
//  대전략 지도 렌더러
//  절차 생성된 지형을 수묵 채색풍으로 그리고
//  도시 · 가도 · 세력 경계 · 부대 이동을 표시한다.
// ============================================================
import { TERRAIN, TERRAIN_BY_ID } from '../core/worldgen.js';
import { mulberry32 } from '../core/rng.js';

export class WorldMap {
  constructor(canvas, game) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.g = game;
    this.zoom = 1;
    this.minZoom = 0.45;
    this.maxZoom = 3.2;
    this.ox = 0; this.oy = 0;
    this.selected = null;
    this.hover = null;
    this.highlight = new Set();
    this.arrows = [];
    this.terrainLayer = null;
    this.labelMode = true;
    this.userMoved = false;         // 사용자가 직접 확대/이동했는가
    this._lastW = 0; this._lastH = 0;
    this.t = 0;
    this._buildTerrain();
    this.fit();
  }

  /** 지형을 오프스크린 캔버스에 한 번만 그려둔다 */
  _buildTerrain() {
    const w = this.g.world;
    const CS = 4;                       // 타일 하나당 픽셀
    const cv = document.createElement('canvas');
    cv.width = w.cols * CS; cv.height = w.rows * CS;
    const c = cv.getContext('2d');
    const rnd = mulberry32(this.g.seed ^ 0x5bf03);

    // 바다 바탕
    c.fillStyle = '#16334c';
    c.fillRect(0, 0, cv.width, cv.height);

    for (let y = 0; y < w.rows; y++) {
      for (let x = 0; x < w.cols; x++) {
        const i = y * w.cols + x;
        const t = TERRAIN_BY_ID[w.tiles[i]];
        if (!t) continue;
        let col = t.color;
        // 고도에 따른 명암 + 약간의 얼룩
        const e = w.elev[i];
        const lum = (e - w.seaLevel) * 55 + (rnd() - 0.5) * 9;
        col = shade(col, Math.round(lum));
        c.fillStyle = col;
        c.fillRect(x * CS, y * CS, CS, CS);
      }
    }

    // 해안선
    c.strokeStyle = 'rgba(210,225,235,.30)';
    c.lineWidth = 1;
    for (let y = 1; y < w.rows - 1; y++) for (let x = 1; x < w.cols - 1; x++) {
      const i = y * w.cols + x;
      const land = TERRAIN_BY_ID[w.tiles[i]].land;
      if (!land) continue;
      let edge = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!TERRAIN_BY_ID[w.tiles[(y + dy) * w.cols + (x + dx)]].land) { edge = true; break; }
      }
      if (edge) { c.fillStyle = 'rgba(226,238,246,.28)'; c.fillRect(x * CS, y * CS, CS, CS); }
    }

    // 하천 — 유량에 따라 굵기 변화
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (const path of w.riverPaths) {
      if (path.length < 4) continue;
      const maxAcc = path[path.length - 1][2] || 1;
      c.strokeStyle = 'rgba(70,140,180,.85)';
      for (let i = 1; i < path.length; i++) {
        const [x0, y0, a0] = path[i - 1], [x1, y1] = path[i];
        c.lineWidth = Math.max(1, Math.min(5, 1 + Math.sqrt(a0 / 60)));
        c.beginPath();
        c.moveTo(x0 * CS + CS / 2, y0 * CS + CS / 2);
        c.lineTo(x1 * CS + CS / 2, y1 * CS + CS / 2);
        c.stroke();
      }
    }

    // 산맥 음영 (햇빛 방향 NW)
    c.globalAlpha = 0.30;
    for (let y = 1; y < w.rows; y++) for (let x = 1; x < w.cols; x++) {
      const i = y * w.cols + x;
      if (!TERRAIN_BY_ID[w.tiles[i]].land) continue;
      const d = w.elev[i] - w.elev[(y - 1) * w.cols + (x - 1)];
      if (Math.abs(d) < 0.004) continue;
      c.fillStyle = d > 0 ? 'rgba(255,246,225,.9)' : 'rgba(20,14,8,.9)';
      c.fillRect(x * CS, y * CS, CS, CS);
    }
    c.globalAlpha = 1;

    this.terrainLayer = cv;
    this.tileScale = CS;
    this.worldW = w.cols * CS;
    this.worldH = w.rows * CS;
    this.unitToPx = CS / w.cellSize;
  }

  // ── 좌표 변환 ──
  w2s(x, y) {
    return [(x * this.unitToPx) * this.zoom + this.ox, (y * this.unitToPx) * this.zoom + this.oy];
  }
  s2w(sx, sy) {
    return [(sx - this.ox) / this.zoom / this.unitToPx, (sy - this.oy) / this.zoom / this.unitToPx];
  }

  fit() {
    const W = this.cv.clientWidth || this.cv.width;
    const H = this.cv.clientHeight || this.cv.height;
    this.zoom = Math.min(W / this.worldW, H / this.worldH) * 0.98;
    this.minZoom = this.zoom * 0.85;
    this.ox = (W - this.worldW * this.zoom) / 2;
    this.oy = (H - this.worldH * this.zoom) / 2;
  }

  centerOn(city, animate = true) {
    this.followCity = city;
    const W = this.cv.clientWidth, H = this.cv.clientHeight;
    const tx = W / 2 - city.x * this.unitToPx * this.zoom;
    const ty = H / 2 - city.y * this.unitToPx * this.zoom;
    if (!animate) { this.ox = tx; this.oy = ty; return; }
    this.panTarget = { x: tx, y: ty };
  }

  clampView() {
    const W = this.cv.clientWidth, H = this.cv.clientHeight;
    const mw = this.worldW * this.zoom, mh = this.worldH * this.zoom;
    if (mw < W) this.ox = (W - mw) / 2;
    else this.ox = Math.max(W - mw, Math.min(0, this.ox));
    if (mh < H) this.oy = (H - mh) / 2;
    else this.oy = Math.max(H - mh, Math.min(0, this.oy));
  }

  zoomAt(sx, sy, factor) {
    this.userMoved = true;
    const [wx, wy] = this.s2w(sx, sy);
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * factor));
    this.ox = sx - wx * this.unitToPx * this.zoom;
    this.oy = sy - wy * this.unitToPx * this.zoom;
    this.clampView();
  }

  cityAt(sx, sy) {
    let best = null, bd = 26;
    for (const c of this.g.cities) {
      const [x, y] = this.w2s(c.x, c.y);
      const d = Math.hypot(x - sx, y - sy);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  // ── 그리기 ──
  draw(dt = 16) {
    this.t += dt;
    const ctx = this.ctx;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = this.cv.clientWidth, H = this.cv.clientHeight;
    if (this.cv.width !== W * dpr || this.cv.height !== H * dpr) {
      this.cv.width = W * dpr; this.cv.height = H * dpr;
    }
    if (this.panTarget) {
      this.ox += (this.panTarget.x - this.ox) * 0.16;
      this.oy += (this.panTarget.y - this.oy) * 0.16;
      if (Math.abs(this.panTarget.x - this.ox) < 0.5) this.panTarget = null;
      this.clampView();
    }
    // 레이아웃이 잡히거나 창이 바뀌면 다시 맞춘다 (사용자가 직접 움직인 뒤에는 유지)
    if (W !== this._lastW || H !== this._lastH) {
      this._lastW = W; this._lastH = H;
      if (!this.userMoved) { this.fit(); if (this.followCity) this.centerOn(this.followCity, false); }
      else this.clampView();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d1a26';
    ctx.fillRect(0, 0, W, H);

    // 지형
    ctx.imageSmoothingEnabled = this.zoom < 1.6;
    ctx.drawImage(this.terrainLayer, this.ox, this.oy, this.worldW * this.zoom, this.worldH * this.zoom);

    this._drawBorders(ctx);
    this._drawRoads(ctx);
    this._drawArrows(ctx);
    this._drawCities(ctx);
    this._drawProvinceLabels(ctx);
  }

  /** 세력 영역 — 도시 주변을 부드럽게 물들인다 */
  _drawBorders(ctx) {
    const g = this.g;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    for (const r of g.realms) {
      if (r.dead || !r.cities.length) continue;
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = r.color;
      for (const cid of r.cities) {
        const c = g.cityById[cid];
        const [x, y] = this.w2s(c.x, c.y);
        const rad = (34 + c.pop / 9000) * this.zoom;
        const grd = ctx.createRadialGradient(x, y, rad * 0.2, x, y, rad);
        grd.addColorStop(0, r.color);
        grd.addColorStop(1, 'transparent');
        ctx.fillStyle = grd;
        ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
      }
      // 세력 내 도시를 잇는 굵은 선
      ctx.globalAlpha = 0.30;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = Math.max(2, 8 * this.zoom);
      ctx.lineCap = 'round';
      for (const cid of r.cities) {
        const c = g.cityById[cid];
        for (const l of c.links) {
          const o = g.cityById[l.to];
          if (!o || o.realm !== r.id || o.id < c.id) continue;
          const [x0, y0] = this.w2s(c.x, c.y), [x1, y1] = this.w2s(o.x, o.y);
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  _drawRoads(ctx) {
    const g = this.g;
    ctx.save();
    ctx.lineCap = 'round';
    for (const c of g.cities) {
      for (const l of c.links) {
        const o = g.cityById[l.to];
        if (!o || o.id < c.id) continue;
        const [x0, y0] = this.w2s(c.x, c.y), [x1, y1] = this.w2s(o.x, o.y);
        ctx.strokeStyle = l.kind === 'mountain' ? 'rgba(60,44,28,.55)'
          : l.kind === 'river' ? 'rgba(90,140,175,.55)' : 'rgba(232,214,170,.42)';
        ctx.lineWidth = Math.max(1, (l.kind === 'road' ? 2.4 : 1.8) * this.zoom);
        ctx.setLineDash(l.kind === 'mountain' ? [5 * this.zoom, 4 * this.zoom] : []);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
      for (const l of c.seaLinks) {
        const o = g.cityById[l.to];
        if (!o || o.id < c.id) continue;
        const [x0, y0] = this.w2s(c.x, c.y), [x1, y1] = this.w2s(o.x, o.y);
        ctx.strokeStyle = 'rgba(150,205,235,.40)';
        ctx.lineWidth = Math.max(1, 1.8 * this.zoom);
        ctx.setLineDash([3 * this.zoom, 5 * this.zoom]);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  _drawCities(ctx) {
    const g = this.g;
    const z = this.zoom;
    for (const c of g.cities) {
      const [x, y] = this.w2s(c.x, c.y);
      if (x < -60 || y < -60 || x > this.cv.clientWidth + 60 || y > this.cv.clientHeight + 60) continue;
      const r = g.realmById[c.realm];
      const col = r ? r.color : '#8b8578';
      const isSel = this.selected === c.id;
      const isHi = this.highlight.has(c.id);
      const size = (c.type === 'capital' ? 13 : c.type === 'fortress' ? 10 : 11) * Math.min(1.6, Math.max(0.65, z));

      // 강조 링
      if (isHi) {
        ctx.strokeStyle = 'rgba(255,214,120,.95)';
        ctx.lineWidth = 2.4;
        const pulse = 1 + Math.sin(this.t / 260) * 0.14;
        ctx.beginPath(); ctx.arc(x, y, size * 1.7 * pulse, 0, Math.PI * 2); ctx.stroke();
      }
      if (isSel) {
        ctx.strokeStyle = '#fff3d0'; ctx.lineWidth = 2.6;
        ctx.beginPath(); ctx.arc(x, y, size * 1.45, 0, Math.PI * 2); ctx.stroke();
      }

      // 성 아이콘
      ctx.save();
      ctx.translate(x, y);
      ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
      ctx.fillStyle = shade(col, -34);
      const s = size;
      if (c.type === 'fortress') {
        ctx.beginPath();
        ctx.moveTo(-s * .8, s * .6); ctx.lineTo(-s * .55, -s * .7); ctx.lineTo(s * .55, -s * .7);
        ctx.lineTo(s * .8, s * .6); ctx.closePath(); ctx.fill();
      } else if (c.type === 'port') {
        ctx.beginPath(); ctx.arc(0, 0, s * .72, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillRect(-s * .78, -s * .55, s * 1.56, s * 1.15);
      }
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      // 성벽 지붕
      ctx.fillStyle = col;
      if (c.type === 'fortress') {
        ctx.beginPath();
        ctx.moveTo(-s * .8, -s * .1); ctx.lineTo(0, -s * .95); ctx.lineTo(s * .8, -s * .1);
        ctx.closePath(); ctx.fill();
      } else if (c.type === 'port') {
        ctx.beginPath(); ctx.arc(0, 0, s * .48, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(-s * .95, -s * .5); ctx.lineTo(0, -s * 1.05); ctx.lineTo(s * .95, -s * .5);
        ctx.closePath(); ctx.fill();
        ctx.fillRect(-s * .5, -s * .35, s, s * .8);
      }
      // 수도 표식
      if (r && r.capital === c.id) {
        ctx.fillStyle = '#f5d97a';
        ctx.beginPath();
        for (let i = 0; i < 5; i++) {
          const ang = -Math.PI / 2 + i * Math.PI * 2 / 5;
          const rr = i % 2 ? s * .28 : s * .55;
          ctx.lineTo(Math.cos(ang) * rr, -s * 1.35 + Math.sin(ang) * rr);
          const ang2 = ang + Math.PI / 5;
          ctx.lineTo(Math.cos(ang2) * s * .24, -s * 1.35 + Math.sin(ang2) * s * .24);
        }
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();

      // 이름표
      if (this.labelMode && z > 0.55) {
        const fs = Math.max(10, Math.min(15, 11 * z));
        ctx.font = `600 ${fs}px "Noto Serif KR", serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        const label = c.name;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(16,12,8,.62)';
        roundRect(ctx, x - tw / 2 - 5, y + size + 3, tw + 10, fs + 5, 3);
        ctx.fill();
        ctx.fillStyle = r ? '#f6ecd6' : '#c2bcae';
        ctx.fillText(label, x, y + size + 5);
        if (z > 1.25) {
          ctx.font = `${Math.max(9, fs - 2)}px "Noto Sans KR", sans-serif`;
          ctx.fillStyle = 'rgba(230,220,196,.72)';
          ctx.fillText(`병 ${short(c.troops)}`, x, y + size + fs + 8);
        }
      }
    }
  }

  _drawProvinceLabels(ctx) {
    if (this.zoom > 1.1) return;
    ctx.save();
    ctx.font = `700 ${Math.max(14, 22 * this.zoom)}px "Noto Serif KR", serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const p of this.g.provinces) {
      const [x, y] = this.w2s(p.x, p.y);
      ctx.fillStyle = 'rgba(246,236,214,.14)';
      ctx.fillText(p.name, x, y - 26 * this.zoom);
    }
    ctx.restore();
  }

  _drawArrows(ctx) {
    const now = performance.now();
    this.arrows = this.arrows.filter(a => now - a.t0 < a.life);
    for (const a of this.arrows) {
      const from = this.g.cityById[a.from], to = this.g.cityById[a.to];
      if (!from || !to) continue;
      const p = Math.min(1, (now - a.t0) / (a.life * 0.55));
      const [x0, y0] = this.w2s(from.x, from.y);
      const [x1, y1] = this.w2s(to.x, to.y);
      const cx = x0 + (x1 - x0) * p, cy = y0 + (y1 - y0) * p;
      ctx.save();
      ctx.strokeStyle = a.color || '#e8b34a';
      ctx.lineWidth = 3.2; ctx.lineCap = 'round';
      ctx.setLineDash([9, 6]);
      ctx.lineDashOffset = -(now / 26) % 15;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(cx, cy); ctx.stroke();
      ctx.setLineDash([]);
      const ang = Math.atan2(y1 - y0, x1 - x0);
      ctx.translate(cx, cy); ctx.rotate(ang);
      ctx.fillStyle = a.color || '#e8b34a';
      ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-6, 6); ctx.lineTo(-6, -6); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  addArrow(from, to, color, life = 2600) {
    this.arrows.push({ from, to, color, t0: performance.now(), life });
  }
}

// ------------------------------------------------------------------
export function shade(hex, amt) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  const c = [1, 2, 3].map(i => Math.max(0, Math.min(255, parseInt(m[i], 16) + amt)));
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function short(n) {
  if (n >= 100000) return Math.round(n / 10000) + '만';
  if (n >= 10000) return (n / 10000).toFixed(1) + '만';
  return n.toLocaleString();
}
