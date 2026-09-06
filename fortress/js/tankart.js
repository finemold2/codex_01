'use strict';
/* tankart.js — 전차 아트 공용 헬퍼 + 아트 레지스트리
 *
 * 각 전차의 그림은 tankart_set*.js 에서 TankArt.register(id, art) 로 등록합니다.
 *
 * 좌표 규약 (로컬 좌표, 캔버스 기준 +y 아래):
 *   원점 (0,0) = 궤도 바닥 중앙 = 지면과 닿는 점
 *   전차는 항상 오른쪽(+x)을 향하도록 그림 (좌향은 호출부가 scale(-1,1))
 *   본체 권장 범위: x ∈ [-26, 26], y ∈ [-34, 1]
 *
 * art = {
 *   pivot: [px, py],            // 포신 회전축 (로컬 좌표)
 *   barrelLen: 26,              // 포신 길이 기준값
 *   draw(ctx, s),               // 차체 + 궤도 + 포탑
 *   barrel(ctx, s),             // 포신: 원점에서 +x 방향으로 s.len 만큼 (호출부가 pivot 이동/회전 처리)
 * }
 * s = { p: 팔레트, color: 플레이어색, roll: 궤도 이동거리(px), t: 초, dead: bool,
 *       hpFrac: 0~1, len: 포신길이, charge: 0~1 }
 */
const TankArt = (() => {
  const reg = Object.create(null);

  /* ---------- 색 유틸 ---------- */
  function rgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function hex(r, g, b) {
    const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return `#${c(r)}${c(g)}${c(b)}`;
  }
  function shade(color, amt) {
    const [r, g, b] = rgb(color);
    return amt >= 0
      ? hex(r + (255 - r) * amt, g + (255 - g) * amt, b + (255 - b) * amt)
      : hex(r * (1 + amt), g * (1 + amt), b * (1 + amt));
  }
  function mix(a, b, t) {
    const A = rgb(a), B = rgb(b);
    return hex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
  }
  function alpha(color, a) {
    const [r, g, b] = rgb(color);
    return `rgba(${r},${g},${b},${a})`;
  }

  /** 플레이어 색 → 도장 팔레트 */
  function pal(color) {
    const base = mix(color, '#79808f', 0.42);
    return {
      accent: color,
      accentHi: shade(color, 0.35),
      accentDim: shade(color, -0.3),
      hi: shade(base, 0.5),
      lite: shade(base, 0.26),
      base,
      mid: shade(base, -0.14),
      dark: shade(base, -0.4),
      deep: shade(base, -0.62),
      edge: shade(base, -0.8),
      steel: '#8d94a3',
      steelDark: '#3b414e',
      track: '#2b2f39',
      trackHi: '#565d6c',
      glass: '#a8e4ff',
      glow: shade(color, 0.55),
    };
  }

  /* ---------- 패스 유틸 ---------- */
  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function poly(ctx, pts, close) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    if (close !== false) ctx.closePath();
  }
  function bbox(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return [x0, y0, x1, y1];
  }

  /** 세로 금속 그라디언트 (y0 위 → y1 아래)
   * o.top/sheen/mid/bot 은 색 문자열일 때만 씁니다.
   * (plate/box 는 자기 옵션 객체를 그대로 넘기는데 그 sheen 은 불리언 플래그입니다.) */
  function metal(ctx, y0, y1, p, o) {
    o = o || {};
    const col = (v, d) => (typeof v === 'string' ? v : d);
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, col(o.top, p.lite));
    g.addColorStop(0.28, col(o.sheen, p.hi));
    g.addColorStop(0.55, col(o.mid, p.base));
    g.addColorStop(1, col(o.bot, p.dark));
    return g;
  }

  /**
   * 다각형 장갑판. pts = [[x,y],...]
   * o: { p, fill?, stroke?, sheen?(bool), ao?(bool), lw? }
   */
  function plate(ctx, pts, o) {
    const p = o.p;
    const [, y0, , y1] = bbox(pts);
    poly(ctx, pts);
    ctx.fillStyle = o.fill || metal(ctx, y0, y1, p, o);
    ctx.fill();
    if (o.sheen !== false) {
      ctx.save();
      ctx.clip();
      const g = ctx.createLinearGradient(0, y0, 0, y0 + (y1 - y0) * 0.42);
      g.addColorStop(0, alpha('#ffffff', 0.28));
      g.addColorStop(1, alpha('#ffffff', 0));
      ctx.fillStyle = g;
      ctx.fillRect(-60, y0, 120, (y1 - y0) * 0.42);
      const ag = ctx.createLinearGradient(0, y1 - (y1 - y0) * 0.35, 0, y1);
      ag.addColorStop(0, alpha('#000000', 0));
      ag.addColorStop(1, alpha('#000000', 0.35));
      ctx.fillStyle = ag;
      ctx.fillRect(-60, y1 - (y1 - y0) * 0.35, 120, (y1 - y0) * 0.35);
      ctx.restore();
    }
    poly(ctx, pts);
    ctx.lineWidth = o.lw || 1.1;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = o.stroke || p.edge;
    ctx.stroke();
  }

  /** 둥근 사각 장갑판 */
  function box(ctx, x, y, w, h, r, o) {
    const p = o.p;
    rr(ctx, x, y, w, h, r);
    ctx.fillStyle = o.fill || metal(ctx, y, y + h, p, o);
    ctx.fill();
    if (o.sheen !== false) {
      ctx.save(); ctx.clip();
      const g = ctx.createLinearGradient(0, y, 0, y + h * 0.45);
      g.addColorStop(0, alpha('#ffffff', 0.3));
      g.addColorStop(1, alpha('#ffffff', 0));
      ctx.fillStyle = g; ctx.fillRect(x, y, w, h * 0.45);
      ctx.restore();
    }
    rr(ctx, x, y, w, h, r);
    ctx.lineWidth = o.lw || 1.1;
    ctx.strokeStyle = o.stroke || p.edge;
    ctx.stroke();
  }

  /* ---------- 부품 ---------- */

  /**
   * 궤도. o: { x, y(바닥 y, 보통 0), w, h, roll, p, wheels, links, skirt }
   * 바닥이 y 에 닿도록 그립니다.
   */
  function tracks(ctx, o) {
    const p = o.p;
    const w = o.w != null ? o.w : 46;
    const h = o.h != null ? o.h : 13;
    const cx = o.x || 0;
    const by = o.y != null ? o.y : 0;
    const x0 = cx - w / 2, y0 = by - h;
    const r = h / 2;

    // 그림자
    ctx.fillStyle = alpha('#000000', 0.28);
    ctx.beginPath();
    ctx.ellipse(cx, by + 1.5, w * 0.52, 3.2, 0, 0, Math.PI * 2);
    ctx.fill();

    rr(ctx, x0, y0, w, h, r);
    const g = ctx.createLinearGradient(0, y0, 0, y0 + h);
    g.addColorStop(0, p.trackHi);
    g.addColorStop(0.4, p.track);
    g.addColorStop(1, '#171a21');
    ctx.fillStyle = g;
    ctx.fill();

    // 트레드 링크
    ctx.save();
    rr(ctx, x0, y0, w, h, r);
    ctx.clip();
    const step = o.links || 6;
    const off = ((-(o.roll || 0) % step) + step) % step;
    ctx.fillStyle = alpha('#0c0e13', 0.85);
    for (let lx = x0 - step; lx < x0 + w + step; lx += step) {
      ctx.fillRect(lx + off, y0, 2, h);
    }
    ctx.fillStyle = alpha('#ffffff', 0.1);
    for (let lx = x0 - step; lx < x0 + w + step; lx += step) {
      ctx.fillRect(lx + off + 2, y0, 1, h * 0.5);
    }
    ctx.restore();

    // 바퀴
    const n = o.wheels || 4;
    const wy = y0 + h / 2;
    for (let i = 0; i < n; i++) {
      const wx = x0 + r + ((w - h) * i) / Math.max(1, n - 1);
      const rad = h * 0.3;
      ctx.beginPath();
      ctx.arc(wx, wy, rad, 0, Math.PI * 2);
      const wg = ctx.createRadialGradient(wx - rad * 0.3, wy - rad * 0.3, rad * 0.1, wx, wy, rad);
      wg.addColorStop(0, p.steel);
      wg.addColorStop(1, p.steelDark);
      ctx.fillStyle = wg;
      ctx.fill();
      ctx.strokeStyle = '#14171d';
      ctx.lineWidth = 0.9;
      ctx.stroke();
      // 스포크
      ctx.save();
      ctx.translate(wx, wy);
      ctx.rotate((o.roll || 0) * 0.18);
      ctx.strokeStyle = alpha('#000000', 0.5);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-rad * 0.7, 0); ctx.lineTo(rad * 0.7, 0);
      ctx.moveTo(0, -rad * 0.7); ctx.lineTo(0, rad * 0.7);
      ctx.stroke();
      ctx.restore();
    }

    rr(ctx, x0, y0, w, h, r);
    ctx.strokeStyle = p.edge;
    ctx.lineWidth = 1.2;
    ctx.stroke();

    if (o.skirt) {
      box(ctx, x0 + 1, y0 - 1, w - 2, h * 0.52, 2, { p, sheen: true });
    }
  }

  /** 바퀴형 하부 (궤도 없는 차량) */
  function roadWheels(ctx, o) {
    const p = o.p;
    const n = o.n || 4;
    const w = o.w != null ? o.w : 42;
    const by = o.y != null ? o.y : 0;
    const rad = o.r || 6.5;
    ctx.fillStyle = alpha('#000000', 0.26);
    ctx.beginPath();
    ctx.ellipse(o.x || 0, by + 1.5, w * 0.5, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < n; i++) {
      const wx = (o.x || 0) - w / 2 + rad + ((w - rad * 2) * i) / Math.max(1, n - 1);
      const wy = by - rad;
      ctx.beginPath();
      ctx.arc(wx, wy, rad, 0, Math.PI * 2);
      ctx.fillStyle = '#1d2027';
      ctx.fill();
      ctx.strokeStyle = '#0e1015';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.save();
      ctx.translate(wx, wy);
      ctx.rotate((o.roll || 0) / rad);
      ctx.beginPath();
      ctx.arc(0, 0, rad * 0.5, 0, Math.PI * 2);
      const g = ctx.createRadialGradient(-rad * 0.2, -rad * 0.2, 0.5, 0, 0, rad * 0.5);
      g.addColorStop(0, p.hi);
      g.addColorStop(1, p.dark);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = alpha('#000000', 0.6);
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(-rad * 0.45, 0); ctx.lineTo(rad * 0.45, 0);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** 호버 스커트 (부양식) */
  function hoverSkirt(ctx, o) {
    const p = o.p;
    const w = o.w || 44, h = o.h || 10, by = o.y != null ? o.y : -3;
    const t = o.t || 0;
    box(ctx, -w / 2, by - h, w, h, h / 2, { p, sheen: true });
    ctx.save();
    ctx.globalAlpha = 0.55 + Math.sin(t * 9) * 0.12;
    const g = ctx.createLinearGradient(0, by, 0, by + 8);
    g.addColorStop(0, alpha(p.glow, 0.75));
    g.addColorStop(1, alpha(p.glow, 0));
    ctx.fillStyle = g;
    ctx.fillRect(-w / 2 + 2, by, w - 4, 8);
    ctx.restore();
  }

  /** 리벳 열 */
  function rivets(ctx, pts, p, r) {
    r = r || 1.15;
    for (const [x, y] of pts) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = p.hi;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x + 0.25, y + 0.3, r * 0.6, 0, Math.PI * 2);
      ctx.fillStyle = alpha('#000000', 0.4);
      ctx.fill();
    }
  }

  /** 통풍구 슬릿 */
  function vent(ctx, x, y, w, h, n, p) {
    ctx.save();
    rr(ctx, x, y, w, h, 1.5);
    ctx.fillStyle = p.deep;
    ctx.fill();
    ctx.clip();
    ctx.fillStyle = alpha('#ffffff', 0.16);
    const gap = w / n;
    for (let i = 0; i < n; i++) ctx.fillRect(x + i * gap + gap * 0.25, y, gap * 0.3, h);
    ctx.restore();
    rr(ctx, x, y, w, h, 1.5);
    ctx.strokeStyle = p.edge;
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }

  /** 패널 라인 */
  function panelLine(ctx, x0, y0, x1, y1, p) {
    ctx.strokeStyle = alpha('#000000', 0.35);
    ctx.lineWidth = 0.9;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.strokeStyle = alpha('#ffffff', 0.14);
    ctx.beginPath(); ctx.moveTo(x0, y0 + 0.9); ctx.lineTo(x1, y1 + 0.9); ctx.stroke();
  }

  /** 발광 점/램프 */
  function light(ctx, x, y, r, color, t, speed) {
    const pulse = 0.65 + Math.sin((t || 0) * (speed || 4)) * 0.35;
    ctx.save();
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3.2);
    g.addColorStop(0, alpha(color, 0.9 * pulse));
    g.addColorStop(1, alpha(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r * 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = shade(color, 0.55);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /** 캐노피/조종석 유리 */
  function canopy(ctx, x, y, w, h, p) {
    rr(ctx, x, y, w, h, Math.min(w, h) * 0.45);
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, alpha(p.glass, 0.95));
    g.addColorStop(0.5, alpha('#2a4a66', 0.9));
    g.addColorStop(1, alpha('#0e1b28', 0.95));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = p.edge;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.save();
    rr(ctx, x, y, w, h, Math.min(w, h) * 0.45);
    ctx.clip();
    ctx.fillStyle = alpha('#ffffff', 0.5);
    ctx.beginPath();
    ctx.ellipse(x + w * 0.32, y + h * 0.3, w * 0.22, h * 0.2, -0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** 배기관 */
  function exhaust(ctx, x, y, w, h, p) {
    box(ctx, x, y, w, h, w / 2, { p, fill: p.steelDark, sheen: false });
    ctx.fillStyle = '#0b0d11';
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y, w * 0.42, 1.4, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  /** 안테나 (바람에 흔들림) */
  function antenna(ctx, x, y, len, t, p) {
    ctx.save();
    ctx.strokeStyle = p.steelDark;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const sway = Math.sin((t || 0) * 2.2) * 3;
    ctx.quadraticCurveTo(x + sway * 0.4, y - len * 0.6, x + sway, y - len);
    ctx.stroke();
    ctx.fillStyle = p.accent;
    ctx.beginPath();
    ctx.arc(x + sway, y - len, 1.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** 표준 포신: 원점에서 +x 방향 */
  function barrelStd(ctx, s, o) {
    o = o || {};
    const p = s.p;
    const len = s.len || 26;
    const th = o.thick || 5;
    const g = ctx.createLinearGradient(0, -th / 2, 0, th / 2);
    g.addColorStop(0, p.hi);
    g.addColorStop(0.4, p.steel);
    g.addColorStop(1, p.steelDark);
    rr(ctx, -3, -th / 2, len + 3, th, th * 0.35);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = p.edge;
    ctx.lineWidth = 0.9;
    ctx.stroke();
    // 보강 링
    const rings = o.rings != null ? o.rings : 2;
    for (let i = 0; i < rings; i++) {
      const rx = len * (0.32 + i * 0.24);
      box(ctx, rx, -th / 2 - 1, 3, th + 2, 1, { p, fill: p.mid, sheen: false });
    }
    // 머즐 브레이크
    if (o.muzzle !== 'none') {
      const mw = o.muzzle === 'big' ? 7 : 5;
      box(ctx, len - mw * 0.5, -th / 2 - 1.6, mw, th + 3.2, 1.2, { p, fill: p.steelDark, sheen: false });
    }
    // 충전 발광
    if (s.charge > 0.02) {
      ctx.save();
      const cg = ctx.createRadialGradient(len + 2, 0, 0, len + 2, 0, 10 * s.charge + 3);
      cg.addColorStop(0, alpha('#ffd88a', 0.9 * s.charge));
      cg.addColorStop(1, alpha('#ff8a2a', 0));
      ctx.fillStyle = cg;
      ctx.beginPath(); ctx.arc(len + 2, 0, 10 * s.charge + 3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  /** 파괴 상태 팔레트 — 채도를 죽이고 어둡게 */
  function deadPal(p) {
    const g = (c) => mix(c, '#3c3c40', 0.74);
    const out = {};
    for (const k in p) out[k] = g(p[k]);
    out.track = '#22242a';
    out.trackHi = '#3a3d45';
    return out;
  }

  /** 피해 누적 시 그을음 / 균열 */
  function soot(ctx, hpFrac, seedX) {
    if (hpFrac > 0.62) return;
    const n = hpFrac < 0.3 ? 5 : 3;
    ctx.save();
    ctx.globalAlpha = (0.62 - hpFrac) * 1.1;
    ctx.fillStyle = '#141216';
    for (let i = 0; i < n; i++) {
      const a = (i * 2.399 + (seedX || 0)) % 6.283;
      const x = Math.cos(a) * 13, y = -14 + Math.sin(a) * 8;
      ctx.beginPath();
      ctx.ellipse(x, y, 4 + i * 1.2, 2.6 + i * 0.7, a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  return {
    register(id, art) { reg[id] = art; },
    deadPal, soot,
    get(id) { return reg[id] || null; },
    has(id) { return !!reg[id]; },
    ids() { return Object.keys(reg); },
    pal, shade, mix, alpha, rr, poly, bbox, metal, plate, box,
    tracks, roadWheels, hoverSkirt, rivets, vent, panelLine, light, canopy, exhaust, antenna,
    barrelStd,
  };
})();
