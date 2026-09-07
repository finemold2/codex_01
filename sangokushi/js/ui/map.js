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
    this.maxZoom = 2.6;
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

  /** 지형을 오프스크린 캔버스에 한 번만 그려둔다 (회화적 채색 지도) */
  _buildTerrain() {
    const w = this.g.world;
    const CS = 9;                       // 타일 하나당 픽셀 (확대해도 뭉개지지 않게)
    const W = w.cols * CS, H = w.rows * CS;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    const rnd = mulberry32(this.g.seed ^ 0x5bf03);
    const T = TERRAIN, TB = TERRAIN_BY_ID;
    const at = (x, y) => y * w.cols + x;
    const inb = (x, y) => x >= 0 && y >= 0 && x < w.cols && y < w.rows;

    // ── 1~2. 픽셀 단위 채색 ──
    //  칸마다 사각형을 칠하면 확대했을 때 모자이크가 된다.
    //  고도를 이중선형 보간해 픽셀마다 색과 음영을 계산한다.
    const PAL = {
      [T.PLAIN.id]:  [140, 154, 88],
      [T.GRASS.id]:  [154, 164, 94],
      [T.FOREST.id]: [ 78, 107, 62],
      [T.HILL.id]:   [160, 138, 85],
      [T.MOUNT.id]:  [125, 114,  99],
      [T.PEAK.id]:   [164, 156, 146],
      [T.DESERT.id]: [201, 176, 119],
      [T.SNOW.id]:   [211, 216, 220],
      [T.MARSH.id]:  [ 91, 107,  74],
      [T.RIVER.id]:  [ 74, 125, 158],
      [T.LAKE.id]:   [ 44,  90, 120],
    };
    const cols = w.cols, rows = w.rows;
    const elev = w.elev, tiles = w.tiles, sl = w.seaLevel;
    const img = c.createImageData(W, H);
    const D = img.data;
    const eAt = (x, y) => elev[Math.max(0, Math.min(rows - 1, y)) * cols + Math.max(0, Math.min(cols - 1, x))];
    const bilerp = (gx, gy) => {
      const x0 = Math.floor(gx), y0 = Math.floor(gy);
      const tx = gx - x0, ty = gy - y0;
      const a0 = eAt(x0, y0), a1 = eAt(x0 + 1, y0), a2 = eAt(x0, y0 + 1), a3 = eAt(x0 + 1, y0 + 1);
      return (a0 * (1 - tx) + a1 * tx) * (1 - ty) + (a2 * (1 - tx) + a3 * tx) * ty;
    };
    // 경계를 자연스럽게 흐트러뜨릴 잡음
    const jit = new Float32Array(4096);
    for (let i = 0; i < jit.length; i++) jit[i] = rnd() - 0.5;

    let p = 0;
    for (let py = 0; py < H; py++) {
      const gy = py / CS;
      for (let px = 0; px < W; px++, p += 4) {
        const gx = px / CS;
        const jn = jit[((py * 7 + px * 13) & 4095)];
        const e = bilerp(gx, gy);
        // 타일 종류는 살짝 흔들어 뽑아 경계를 자연스럽게
        const sx = Math.max(0, Math.min(cols - 1, Math.round(gx + jn * 0.55)));
        const sy = Math.max(0, Math.min(rows - 1, Math.round(gy + jit[((py * 3 + px * 29) & 4095)] * 0.55)));
        const tid = tiles[sy * cols + sx];
        const land = TB[tid].land || tid === T.LAKE.id;
        let r, g2, b2;
        if (!land) {
          // 바다 — 깊이에 따라
          const t = Math.min(1, Math.max(0, (sl - e)) / 0.16);
          r = 58 + (12 - 58) * t; g2 = 116 + (38 - 116) * t; b2 = 148 + (62 - 148) * t;
          // 잔물결
          // 잔물결 — 규칙적인 격자무늬가 보이지 않도록 여러 주기를 섞는다
          const wv = Math.sin(gx * 0.31 + gy * 0.19) * 0.5
            + Math.sin(gx * 0.13 - gy * 0.47) * 0.3
            + jn * 0.5;
          r += wv * 2.4; g2 += wv * 3.4; b2 += wv * 4.6;
        } else {
          const pal = PAL[tid] || [138, 138, 122];
          // 고도 명암
          const lum = (e - sl) * 62 + jn * 9;
          // 북서 광원 힐셰이딩
          const dz = e - bilerp(gx - 0.9, gy - 0.9);
          const hs = Math.max(-0.55, Math.min(0.55, dz * 26));
          const add = lum + hs * 130;
          r = pal[0] + add; g2 = pal[1] + add * 0.96; b2 = pal[2] + add * 0.88;
        }
        D[p] = r < 0 ? 0 : r > 255 ? 255 : r;
        D[p + 1] = g2 < 0 ? 0 : g2 > 255 ? 255 : g2;
        D[p + 2] = b2 < 0 ? 0 : b2 > 255 ? 255 : b2;
        D[p + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);

    // 해류 결
    c.save(); c.globalAlpha = 0.035; c.strokeStyle = '#bfe3f5'; c.lineWidth = 1;
    for (let k = 0; k < 150; k++) {
      const x = rnd() * W, y = rnd() * H;
      const gx = Math.floor(x / CS), gy = Math.floor(y / CS);
      if (inb(gx, gy) && TB[w.tiles[at(gx, gy)]].land) continue;
      c.beginPath();
      c.moveTo(x, y);
      c.bezierCurveTo(x + 18, y - 4, x + 34, y + 4, x + 52, y);
      c.stroke();
    }
    c.restore();

    // ── 3. 생태별 질감 붓질 ──
    c.save();
    for (let y = 0; y < w.rows; y++) for (let x = 0; x < w.cols; x++) {
      const i = at(x, y);
      const tid = w.tiles[i];
      const px = x * CS, py = y * CS;
      if (tid === T.FOREST.id) {
        // 나무 우듬지 점묘
        for (let k = 0; k < 4; k++) {
          const ox = px + rnd() * CS, oy = py + rnd() * CS;
          c.globalAlpha = 0.35 + rnd() * 0.3;
          c.fillStyle = rnd() > 0.45 ? '#3a5730' : '#5f7f45';
          c.beginPath(); c.arc(ox, oy, 1.4 + rnd() * 2.0, 0, Math.PI * 2); c.fill();
        }
      } else if (tid === T.MOUNT.id || tid === T.PEAK.id) {
        // 능선 붓질
        c.globalAlpha = 0.30 + rnd() * 0.25;
        c.strokeStyle = rnd() > 0.5 ? '#4e463c' : '#b5aca0';
        c.lineWidth = 1.3;
        c.beginPath();
        c.moveTo(px + rnd() * CS, py + CS);
        c.lineTo(px + CS * 0.5, py + rnd() * CS * 0.4);
        c.stroke();
      } else if (tid === T.HILL.id) {
        c.globalAlpha = 0.20;
        c.strokeStyle = '#6f5f38'; c.lineWidth = 0.8;
        c.beginPath();
        c.arc(px + CS / 2, py + CS * 0.8, CS * 0.5, Math.PI * 1.1, Math.PI * 1.9);
        c.stroke();
      } else if (tid === T.DESERT.id) {
        c.globalAlpha = 0.22;
        c.strokeStyle = '#e0cb94'; c.lineWidth = 0.9;
        c.beginPath();
        c.moveTo(px, py + CS * 0.6);
        c.quadraticCurveTo(px + CS * 0.5, py + CS * 0.2, px + CS, py + CS * 0.6);
        c.stroke();
      } else if (tid === T.MARSH.id) {
        c.globalAlpha = 0.30;
        c.strokeStyle = '#7d9364'; c.lineWidth = 0.8;
        c.beginPath();
        c.moveTo(px + CS * 0.3, py + CS); c.lineTo(px + CS * 0.4, py + CS * 0.3);
        c.moveTo(px + CS * 0.7, py + CS); c.lineTo(px + CS * 0.6, py + CS * 0.4);
        c.stroke();
      } else if (tid === T.SNOW.id) {
        c.globalAlpha = 0.25;
        c.fillStyle = '#ffffff';
        c.fillRect(px + rnd() * CS * 0.6, py + rnd() * CS * 0.6, 1.4, 1.4);
      } else if (tid === T.PLAIN.id || tid === T.GRASS.id) {
        if (rnd() > 0.72) {
          c.globalAlpha = 0.22;
          c.strokeStyle = rnd() > 0.5 ? '#6d7a3f' : '#a8b26a'; c.lineWidth = 0.8;
          c.beginPath();
          c.moveTo(px + rnd() * CS, py + CS * 0.9);
          c.lineTo(px + rnd() * CS, py + CS * 0.3);
          c.stroke();
        }
      }
    }
    c.restore();

    // ── 5. 해안선: 물거품과 모래톱 ──
    for (let y = 1; y < w.rows - 1; y++) for (let x = 1; x < w.cols - 1; x++) {
      const i = at(x, y);
      if (!TB[w.tiles[i]].land) continue;
      let edge = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!TB[w.tiles[at(x + dx, y + dy)]].land) { edge = true; break; }
      }
      if (!edge) continue;
      c.fillStyle = 'rgba(226,210,168,.55)';
      c.fillRect(x * CS, y * CS, CS, CS);
    }
    // 바다쪽 파도 띠
    c.save(); c.globalAlpha = 0.30;
    for (let y = 1; y < w.rows - 1; y++) for (let x = 1; x < w.cols - 1; x++) {
      const i = at(x, y);
      if (TB[w.tiles[i]].land) continue;
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (inb(x + dx, y + dy) && TB[w.tiles[at(x + dx, y + dy)]].land) { near = true; break; }
      }
      if (!near) continue;
      c.fillStyle = '#a8d8ef';
      c.fillRect(x * CS, y * CS, CS, CS);
    }
    c.restore();

    // ── 하천: 격자 계단을 없애고 부드러운 곡선으로 ──
    c.lineCap = 'round'; c.lineJoin = 'round';
    const smoothPath = (path) => {
      // 격자점을 솎아낸 뒤 중점을 잇는 곡선으로 만든다
      const pts = [];
      for (let i = 0; i < path.length; i += 2) {
        pts.push([path[i][0] * CS + CS / 2, path[i][1] * CS + CS / 2, path[i][2] || 1]);
      }
      const last = path[path.length - 1];
      pts.push([last[0] * CS + CS / 2, last[1] * CS + CS / 2, last[2] || 1]);
      return pts;
    };
    const strokeRiver = (pts, color, widthFn) => {
      if (pts.length < 3) return;
      // 구간마다 굵기가 달라지므로 조각내어 그린다
      for (let i = 1; i < pts.length - 1; i++) {
        const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
        const m0 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
        const m1 = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
        c.strokeStyle = color;
        c.lineWidth = widthFn(p1[2]);
        c.beginPath();
        c.moveTo(m0[0], m0[1]);
        c.quadraticCurveTo(p1[0], p1[1], m1[0], m1[1]);
        c.stroke();
      }
    };
    const wid = (acc) => Math.max(1.6, Math.min(9, 1.6 + Math.sqrt((acc || 1) / 44) * 1.5));
    for (const path of w.riverPaths) {
      if (path.length < 6) continue;
      const pts = smoothPath(path);
      strokeRiver(pts, 'rgba(126,166,138,.34)', (a2) => wid(a2) + 5);   // 물가 풀밭
      strokeRiver(pts, 'rgba(38,86,118,.85)', (a2) => wid(a2) + 1.6);   // 깊은 물
      strokeRiver(pts, 'rgba(96,166,206,.92)', (a2) => wid(a2));        // 수면
      strokeRiver(pts, 'rgba(190,232,250,.34)', (a2) => Math.max(0.8, wid(a2) * 0.35));  // 반짝임
    }

    // ── 7. 종이결 · 고지도 색조 ──
    c.save();
    c.globalCompositeOperation = 'overlay';
    c.globalAlpha = 0.10;
    for (let i = 0; i < 16000; i++) {
      c.fillStyle = rnd() > 0.5 ? '#ffffff' : '#000000';
      c.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2, 1);
    }
    c.restore();
    c.save();
    c.globalCompositeOperation = 'soft-light';
    c.globalAlpha = 0.30;
    const tone = c.createLinearGradient(0, 0, W, H);
    tone.addColorStop(0, '#ffdca8');
    tone.addColorStop(1, '#2a4468');
    c.fillStyle = tone; c.fillRect(0, 0, W, H);
    c.restore();

    // 육지 마스크 (세력 영역을 육지에만 칠하기 위해)
    const mk = document.createElement('canvas');
    mk.width = W; mk.height = H;
    const mc = mk.getContext('2d');
    mc.fillStyle = '#fff';
    for (let y = 0; y < w.rows; y++) for (let x = 0; x < w.cols; x++) {
      if (TB[w.tiles[at(x, y)]].land) mc.fillRect(x * CS, y * CS, CS, CS);
    }
    this.landMask = mk;

    this.terrainLayer = cv;
    this.tileScale = CS;
    this.worldW = W;
    this.worldH = H;
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
    if (!animate) { this.ox = tx; this.oy = ty; this.clampView(); return; }
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
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.terrainLayer, this.ox, this.oy, this.worldW * this.zoom, this.worldH * this.zoom);

    this._drawBorders(ctx);
    this._drawRoads(ctx);
    this._drawArrows(ctx);
    this._drawCities(ctx);
    this._drawProvinceLabels(ctx);
  }

  /** 세력 영역 — 육지에만 은은하게 물들인다 */
  _drawBorders(ctx) {
    const g = this.g;
    const z = this.zoom;
    const W = this.cv.clientWidth, H = this.cv.clientHeight;
    if (!this._terrBuf || this._terrBuf.width !== W || this._terrBuf.height !== H) {
      this._terrBuf = document.createElement('canvas');
      this._terrBuf.width = Math.max(1, W); this._terrBuf.height = Math.max(1, H);
    }
    const b = this._terrBuf.getContext('2d');
    b.clearRect(0, 0, W, H);

    // 도시를 중심으로 한 영향권을 흐릿하게 칠한다
    b.save();
    b.filter = `blur(${Math.max(4, 10 * z)}px)`;
    for (const r of g.realms) {
      if (r.dead || !r.cities.length) continue;
      b.fillStyle = r.color;
      b.strokeStyle = r.color;
      b.lineCap = 'round';
      b.lineWidth = 22 * z;
      b.beginPath();
      for (const cid of r.cities) {
        const c = g.cityById[cid];
        const [x, y] = this.w2s(c.x, c.y);
        const rad = (16 + Math.sqrt(Math.max(0, c.pop)) / 26) * z;
        b.moveTo(x + rad, y);
        b.arc(x, y, rad, 0, Math.PI * 2);
      }
      b.fill();
      // 같은 세력 도시를 잇는 회랑
      b.beginPath();
      for (const cid of r.cities) {
        const c = g.cityById[cid];
        for (const l of c.links) {
          const o = g.cityById[l.to];
          if (!o || o.realm !== r.id || o.id < c.id) continue;
          const [x0, y0] = this.w2s(c.x, c.y), [x1, y1] = this.w2s(o.x, o.y);
          b.moveTo(x0, y0); b.lineTo(x1, y1);
        }
      }
      b.stroke();
    }
    b.restore();

    // 바다는 지운다
    b.save();
    b.globalCompositeOperation = 'destination-in';
    b.drawImage(this.landMask, this.ox, this.oy, this.worldW * z, this.worldH * z);
    b.restore();

    ctx.save();
    ctx.globalAlpha = 0.34;
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(this._terrBuf, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.18;
    ctx.drawImage(this._terrBuf, 0, 0);
    ctx.restore();
  }

  _drawRoads(ctx) {
    const g = this.g;
    const z = this.zoom;
    ctx.save();
    ctx.lineCap = 'round';
    // 가도는 두 번 그린다 — 어두운 테두리 위에 밝은 노면
    for (const pass of [0, 1]) {
      for (const c of g.cities) {
        for (const l of c.links) {
          const o = g.cityById[l.to];
          if (!o || o.id < c.id) continue;
          const [x0, y0] = this.w2s(c.x, c.y), [x1, y1] = this.w2s(o.x, o.y);
          // 살짝 휘어진 길
          const mx = (x0 + x1) / 2 + (y1 - y0) * 0.06;
          const my = (y0 + y1) / 2 - (x1 - x0) * 0.06;
          if (pass === 0) {
            ctx.strokeStyle = 'rgba(30,22,12,.45)';
            ctx.lineWidth = Math.max(1.5, (l.kind === 'road' ? 4.2 : 3.4) * z);
            ctx.setLineDash([]);
          } else {
            ctx.strokeStyle = l.kind === 'mountain' ? 'rgba(186,160,116,.62)'
              : l.kind === 'river' ? 'rgba(150,196,225,.60)' : 'rgba(232,214,168,.72)';
            ctx.lineWidth = Math.max(0.8, (l.kind === 'road' ? 2.2 : 1.6) * z);
            ctx.setLineDash(l.kind === 'mountain' ? [5 * z, 4 * z] : []);
          }
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.quadraticCurveTo(mx, my, x1, y1);
          ctx.stroke();
        }
      }
    }
    // 해로
    ctx.setLineDash([3 * z, 6 * z]);
    ctx.strokeStyle = 'rgba(168,216,239,.50)';
    ctx.lineWidth = Math.max(1, 1.8 * z);
    for (const c of g.cities) {
      for (const l of c.seaLinks) {
        const o = g.cityById[l.to];
        if (!o || o.id < c.id) continue;
        const [x0, y0] = this.w2s(c.x, c.y), [x1, y1] = this.w2s(o.x, o.y);
        const mx = (x0 + x1) / 2 + (y1 - y0) * 0.14;
        const my = (y0 + y1) / 2 - (x1 - x0) * 0.14;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(mx, my, x1, y1); ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  /** 성곽 스프라이트 — 지붕·성벽·망루·깃발을 그린다 */
  _drawCities(ctx) {
    const g = this.g;
    const z = this.zoom;
    const W = this.cv.clientWidth, H = this.cv.clientHeight;
    for (const c of g.cities) {
      const [x, y] = this.w2s(c.x, c.y);
      if (x < -80 || y < -80 || x > W + 80 || y > H + 80) continue;
      const r = g.realmById[c.realm];
      const col = r ? r.color : '#8d8578';
      const isSel = this.selected === c.id;
      const isHi = this.highlight.has(c.id);
      const S = Math.max(9, Math.min(26, 13 * z)) * (c.type === 'fortress' ? 1.05 : c.type === 'port' ? 0.95 : 1);
      const isCap = r && r.capital === c.id;

      // 강조 고리
      if (isHi) {
        const pulse = 1 + Math.sin(this.t / 260) * 0.12;
        ctx.strokeStyle = 'rgba(255,214,120,.9)'; ctx.lineWidth = 2.4;
        ctx.beginPath(); ctx.arc(x, y, S * 1.8 * pulse, 0, Math.PI * 2); ctx.stroke();
      }
      if (isSel) {
        ctx.strokeStyle = 'rgba(255,243,208,.95)'; ctx.lineWidth = 2.6;
        ctx.beginPath(); ctx.arc(x, y, S * 1.5, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,243,208,.35)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, S * 1.9, 0, Math.PI * 2); ctx.stroke();
      }

      ctx.save();
      ctx.translate(x, y);

      // 땅그림자
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = '#100c06';
      ctx.beginPath(); ctx.ellipse(2, S * 0.62, S * 0.92, S * 0.30, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      const wallH = S * 0.62, wallW = S * 0.92;
      const dark = shade(col, -58), mid = shade(col, -26), lite = shade(col, 22);

      if (c.type === 'port') {
        // 부두 — 낮은 창고와 돛
        ctx.fillStyle = dark;
        ctx.fillRect(-wallW, -wallH * 0.2, wallW * 2, wallH * 0.9);
        ctx.fillStyle = mid;
        ctx.beginPath();
        ctx.moveTo(-wallW * 1.1, -wallH * 0.2);
        ctx.lineTo(0, -wallH * 0.85);
        ctx.lineTo(wallW * 1.1, -wallH * 0.2);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(245,238,214,.9)';
        ctx.beginPath();
        ctx.moveTo(wallW * 0.2, -wallH * 0.3);
        ctx.lineTo(wallW * 0.2, -wallH * 1.7);
        ctx.lineTo(wallW * 1.0, -wallH * 0.5);
        ctx.closePath(); ctx.fill();
      } else if (c.type === 'fortress') {
        // 관(關) — 좁고 높은 성문
        ctx.fillStyle = dark;
        ctx.fillRect(-wallW * 0.85, -wallH * 0.6, wallW * 1.7, wallH * 1.2);
        ctx.fillStyle = mid;
        for (const tx of [-wallW * 0.85, wallW * 0.35]) {
          ctx.fillRect(tx, -wallH * 1.25, wallW * 0.5, wallH * 1.85);
        }
        ctx.fillStyle = lite;
        for (const tx of [-wallW * 0.95, wallW * 0.25]) {
          ctx.beginPath();
          ctx.moveTo(tx, -wallH * 1.25);
          ctx.lineTo(tx + wallW * 0.35, -wallH * 1.75);
          ctx.lineTo(tx + wallW * 0.70, -wallH * 1.25);
          ctx.closePath(); ctx.fill();
        }
        ctx.fillStyle = 'rgba(20,14,8,.8)';
        ctx.fillRect(-wallW * 0.22, -wallH * 0.2, wallW * 0.44, wallH * 0.8);
      } else {
        // 성 — 성벽 + 문루 + 모서리 망루
        ctx.fillStyle = dark;
        ctx.fillRect(-wallW, -wallH * 0.35, wallW * 2, wallH * 1.0);
        // 성가퀴
        ctx.fillStyle = mid;
        const merlons = 5;
        for (let i = 0; i < merlons; i++) {
          const bw = (wallW * 2) / (merlons * 2 - 1);
          ctx.fillRect(-wallW + i * bw * 2, -wallH * 0.55, bw, wallH * 0.24);
        }
        ctx.fillRect(-wallW, -wallH * 0.38, wallW * 2, wallH * 0.14);
        // 문루 지붕
        ctx.fillStyle = lite;
        ctx.beginPath();
        ctx.moveTo(-wallW * 0.78, -wallH * 0.55);
        ctx.quadraticCurveTo(0, -wallH * 1.55, wallW * 0.78, -wallH * 0.55);
        ctx.quadraticCurveTo(0, -wallH * 0.95, -wallW * 0.78, -wallH * 0.55);
        ctx.closePath(); ctx.fill();
        // 처마 끝 반전
        ctx.strokeStyle = shade(col, 46); ctx.lineWidth = Math.max(1, z * 0.9);
        ctx.beginPath();
        ctx.moveTo(-wallW * 0.86, -wallH * 0.62);
        ctx.quadraticCurveTo(0, -wallH * 1.5, wallW * 0.86, -wallH * 0.62);
        ctx.stroke();
        // 성문
        ctx.fillStyle = 'rgba(24,16,8,.85)';
        ctx.beginPath();
        ctx.moveTo(-wallW * 0.20, wallH * 0.65);
        ctx.lineTo(-wallW * 0.20, -wallH * 0.06);
        ctx.quadraticCurveTo(0, -wallH * 0.34, wallW * 0.20, -wallH * 0.06);
        ctx.lineTo(wallW * 0.20, wallH * 0.65);
        ctx.closePath(); ctx.fill();
        // 모서리 망루
        ctx.fillStyle = mid;
        for (const tx of [-wallW * 1.12, wallW * 0.82]) {
          ctx.fillRect(tx, -wallH * 0.7, wallW * 0.30, wallH * 1.35);
          ctx.fillStyle = lite;
          ctx.beginPath();
          ctx.moveTo(tx - wallW * 0.10, -wallH * 0.70);
          ctx.lineTo(tx + wallW * 0.15, -wallH * 1.06);
          ctx.lineTo(tx + wallW * 0.40, -wallH * 0.70);
          ctx.closePath(); ctx.fill();
          ctx.fillStyle = mid;
        }
      }

      // 명암
      const gg = ctx.createLinearGradient(-wallW, -wallH * 1.6, wallW, wallH);
      gg.addColorStop(0, 'rgba(255,244,214,.22)');
      gg.addColorStop(0.5, 'rgba(0,0,0,0)');
      gg.addColorStop(1, 'rgba(0,0,0,.38)');
      ctx.fillStyle = gg;
      ctx.fillRect(-wallW * 1.4, -wallH * 2, wallW * 2.8, wallH * 3);

      // 깃발 — 세력색
      if (r) {
        const fx = wallW * 0.05, fy = -wallH * (c.type === 'city' ? 1.55 : 1.8);
        ctx.strokeStyle = '#2a2018'; ctx.lineWidth = Math.max(1, z * 0.8);
        ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx, fy + S * 0.85); ctx.stroke();
        const wave = Math.sin(this.t / 340 + c.gx) * S * 0.10;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(fx + S * 0.72, fy + wave + S * 0.10);
        ctx.lineTo(fx + S * 0.60, fy + S * 0.30);
        ctx.lineTo(fx, fy + S * 0.34);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 0.8; ctx.stroke();
      }
      // 수도 표식
      if (isCap) {
        ctx.fillStyle = '#f5d97a';
        ctx.strokeStyle = 'rgba(60,40,10,.7)'; ctx.lineWidth = 0.8;
        const sy = -wallH * 2.05;
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const ang = -Math.PI / 2 + i * Math.PI / 5;
          const rr = i % 2 ? S * 0.20 : S * 0.44;
          const px = Math.cos(ang) * rr, py = sy + Math.sin(ang) * rr;
          i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      ctx.restore();

      // 이름표
      if (this.labelMode && z > 0.5) {
        const fs = Math.max(11, Math.min(17, 12 * z));
        ctx.font = `700 ${fs}px "Noto Serif KR", serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        const label = c.name;
        const tw = ctx.measureText(label).width;
        const ly = y + S * 0.85;
        ctx.fillStyle = 'rgba(14,10,6,.72)';
        roundRect(ctx, x - tw / 2 - 6, ly, tw + 12, fs + 6, 3);
        ctx.fill();
        ctx.strokeStyle = r ? 'rgba(255,255,255,.20)' : 'rgba(255,255,255,.10)';
        ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = 'rgba(0,0,0,.7)';
        ctx.fillText(label, x + 1, ly + 4);
        ctx.fillStyle = r ? '#f8efd9' : '#c6c0b2';
        ctx.fillText(label, x, ly + 3);
        if (z > 1.2) {
          ctx.font = `${Math.max(10, fs - 3)}px "Noto Sans KR", sans-serif`;
          ctx.fillStyle = 'rgba(236,226,202,.78)';
          ctx.fillText(`병 ${short(c.troops)}`, x, ly + fs + 8);
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
