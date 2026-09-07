// ============================================================
//  초상화 렌더러 — 절차적 인물화
//  2배 슈퍼샘플링 + 흐림(blur) 기반 명암 레이어로
//  붓으로 칠한 듯한 결과를 만든다. 외부 이미지 없음.
//  얼굴 골격 · 이목구비 · 머리 · 수염 · 의복 · 색조가
//  모두 시드에서 파생되어 사실상 무한한 인물이 나온다.
// ============================================================
import { mulberry32 } from '../core/rng.js';

const DW = 240, DH = 300;      // 기준 도안
const SS = 2;                  // 슈퍼샘플 배율

// ── 피부 ─────────────────────────────────────────────────
const SKIN = [
  { b: '#f0cfa8', s: '#c9a077', d: '#9c7350', r: '#d98f78' },
  { b: '#e5bb92', s: '#bd8f66', d: '#8f6644', r: '#cf8168' },
  { b: '#d3a577', s: '#a97d52', d: '#7d5936', r: '#c17558' },
  { b: '#bd8b60', s: '#946640', d: '#6b4526', r: '#ac6446' },
  { b: '#f7dcbc', s: '#d0ae8b', d: '#a68463', r: '#dd9c85' },
  { b: '#ab7a54', s: '#835836', d: '#5e3c20', r: '#96593c' },
  { b: '#e8c9a5', s: '#c09a72', d: '#906d48', r: '#cf8b72' },
];
const HAIR_DARK = ['#17110d', '#1f1711', '#291d14', '#33241a', '#12100e', '#241b15'];
const HAIR_GREY = ['#544c44', '#726a60', '#948c82', '#b8b0a6', '#d2cbc1'];

const cache = new Map();

export function portraitCanvas(officer, size = 120) {
  const key = officer.id + ':' + size;
  const hit = cache.get(key);
  if (hit) return hit;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const h = Math.round(size * DH / DW);
  const cv = document.createElement('canvas');
  cv.width = Math.round(size * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.width = size + 'px';
  cv.style.height = h + 'px';

  // 2배로 그린 뒤 축소해 계단을 없앤다
  const big = document.createElement('canvas');
  big.width = DW * SS; big.height = DH * SS;
  const bctx = big.getContext('2d');
  bctx.scale(SS, SS);
  paint(bctx, officer);

  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(big, 0, 0, cv.width, cv.height);

  if (cache.size > 420) cache.clear();
  cache.set(key, cv);
  return cv;
}

export function clearPortraitCache() { cache.clear(); }

/** 외부에서 직접 그릴 때 (크게 보여주는 화면 등) */
export function drawPortrait(ctx, o, W, H) {
  const big = document.createElement('canvas');
  big.width = DW * SS; big.height = DH * SS;
  const b = big.getContext('2d');
  b.scale(SS, SS);
  paint(b, o);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(big, 0, 0, W, H);
}

// ============================================================
//  형질 추출
// ============================================================
function traits(o) {
  const a = o.appearance || {};
  const seed = (a.seed ?? 12345) >>> 0;
  const rnd = mulberry32(seed);
  const R = (lo, hi) => lo + rnd() * (hi - lo);
  const P = (p) => rnd() < p;
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const age = o.age ?? 30;
  const female = o.gender === 'F';
  const war = o.war ?? 50, int = o.int ?? 50, lead = o.lead ?? 50, cha = o.cha ?? 50;

  const martial = war > 66 || lead > 74;
  const scholar = int > 68 && war < 52;
  const greyT = Math.max(0, Math.min(1, (age - 40) / 32));
  const greyIdx = P(greyT * 1.05) ? Math.min(4, Math.floor((age - 40) / 9)) : -1;

  // 의복 배색 — 여러 배색 규칙 중 하나
  const hue = a.hue ?? Math.floor(rnd() * 360);
  const scheme = pick(['comp', 'gold', 'mono', 'analog', 'dark']);
  const sat = Math.max(14, Math.min(78, (a.sat ?? 40) + R(-10, 10)));
  let trimHue, trimSat, trimLit;
  if (scheme === 'comp') { trimHue = (hue + 180 + R(-20, 20)) % 360; trimSat = Math.min(46, sat + 8); trimLit = R(40, 50); }
  else if (scheme === 'gold') { trimHue = R(36, 48); trimSat = R(38, 54); trimLit = R(44, 55); }
  else if (scheme === 'mono') { trimHue = hue; trimSat = Math.min(52, sat + 12); trimLit = R(44, 54); }
  else if (scheme === 'analog') { trimHue = (hue + (P(0.5) ? 38 : -38) + 360) % 360; trimSat = Math.min(48, sat + 10); trimLit = R(40, 50); }
  else { trimHue = hue; trimSat = Math.max(6, sat - 20); trimLit = R(24, 33); }

  return {
    rnd, R, P, pick, age, female, martial, scholar,
    skin: SKIN[(a.skin ?? Math.floor(rnd() * SKIN.length)) % SKIN.length],
    hair: greyIdx >= 0 ? HAIR_GREY[greyIdx] : HAIR_DARK[(seed >> 3) % HAIR_DARK.length],
    grey: greyIdx >= 0,
    // 골격 — 비대칭까지 준다
    headW: R(0.93, 1.09) * (female ? 0.96 : 1) * (martial ? 1.05 : 1),
    headH: R(0.95, 1.05),
    jaw: R(0.84, 1.12) * (female ? 0.90 : 1) * (martial ? 1.08 : 1),
    chinLen: R(0.92, 1.08),
    cheekbone: R(0.90, 1.14),
    asym: R(-0.035, 0.035),
    // 이목구비
    eyeY: R(-0.03, 0.03),
    eyeSize: R(0.88, 1.16) * (female ? 1.08 : 1),
    eyeTilt: R(-0.10, 0.26),
    eyeGap: R(0.94, 1.08),
    eyeStyle: Math.floor(rnd() * 6),
    lidHeavy: R(0, 1),
    browThick: R(0.6, 1.7) * (female ? 0.65 : 1) * (martial ? 1.3 : 1),
    browTilt: R(-0.34, 0.28),
    browStyle: Math.floor(rnd() * 4),
    browGap: R(0.92, 1.10),
    noseLen: R(0.88, 1.14),
    noseW: R(0.82, 1.22),
    noseBridge: R(0.7, 1.3),
    mouthW: R(0.84, 1.16),
    mouthY: R(-0.02, 0.03),
    lip: R(0.75, 1.35) * (female ? 1.3 : 1),
    // 모발
    hairline: R(0, 1),
    hairStyle: Math.floor(rnd() * 5),
    balding: !female && age > 48 && P(0.30),
    beard: female ? 0 : (age < 19 ? 0 : (a.beard ?? Math.floor(rnd() * 7)) % 7),
    beardLen: R(0.7, 1.5),
    hat: (a.hat ?? Math.floor(rnd() * 9)) % 9,
    scar: a.scar ?? 0,
    // 의복
    hue, sat,
    robe: (l) => `hsl(${hue} ${Math.round(sat * 0.82)}% ${l}%)`,
    trim: (l = trimLit) => `hsl(${trimHue} ${trimSat}% ${l}%)`,
    pattern: pick(['none', 'none', 'dots', 'cloud', 'stripe', 'roundel']),
    armored: martial || (a.hat ?? 0) % 9 >= 5,
    collar: Math.floor(rnd() * 3),
    seed,
  };
}

// ============================================================
//  그리기 도구
// ============================================================
/** 흐린 그림자/하이라이트 도형 — 회화적 명암의 핵심 */
function soft(ctx, blur, mode, alpha, fn) {
  ctx.save();
  ctx.filter = `blur(${blur}px)`;
  ctx.globalCompositeOperation = mode;
  ctx.globalAlpha = alpha;
  fn(ctx);
  ctx.restore();
}

function ellipse(ctx, x, y, rx, ry, rot, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rot || 0, 0, Math.PI * 2);
  ctx.fill();
}

/** 시작이 굵고 끝이 가는 붓 자국 */
function brush(ctx, pts, w0, w1, color, alpha = 1, blur = 0) {
  if (pts.length < 2) return;
  ctx.save();
  if (blur) ctx.filter = `blur(${blur}px)`;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  const L = [], Rr = [];
  for (let i = 0; i < pts.length; i++) {
    const t = i / (pts.length - 1);
    const w = (w0 + (w1 - w0) * Math.pow(t, 0.8)) / 2;
    const p = pts[i];
    const pv = pts[Math.max(0, i - 1)], nx = pts[Math.min(pts.length - 1, i + 1)];
    const ang = Math.atan2(nx[1] - pv[1], nx[0] - pv[0]) + Math.PI / 2;
    L.push([p[0] + Math.cos(ang) * w, p[1] + Math.sin(ang) * w]);
    Rr.push([p[0] - Math.cos(ang) * w, p[1] - Math.sin(ang) * w]);
  }
  ctx.beginPath();
  ctx.moveTo(L[0][0], L[0][1]);
  for (const p of L) ctx.lineTo(p[0], p[1]);
  for (let i = Rr.length - 1; i >= 0; i--) ctx.lineTo(Rr[i][0], Rr[i][1]);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

function qpts(x0, y0, cx, cy, x1, y1, n = 12) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1]);
  }
  return out;
}

let grainCanvas = null;
function grain(ctx, w, h, alpha) {
  if (!grainCanvas) {
    grainCanvas = document.createElement('canvas');
    grainCanvas.width = 128; grainCanvas.height = 128;
    const g = grainCanvas.getContext('2d');
    const img = g.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 110 + Math.random() * 70;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = alpha;
  const p = ctx.createPattern(grainCanvas, 'repeat');
  ctx.fillStyle = p;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// ============================================================
//  본체
// ============================================================
function paint(ctx, o) {
  const f = traits(o);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';

  // 머리 기준 치수
  const cx = DW / 2 + f.asym * 14;
  const cy = 120;                            // 얼굴 중심
  const hw = 63 * f.headW;                   // 반폭
  const hh = 66 * f.headH;                   // 반높이
  const chinY = cy + hh * 0.92 * f.chinLen;
  const G = { cx, cy, hw, hh, chinY };

  background(ctx, f, o);
  body(ctx, f, G);
  neck(ctx, f, G);
  hairBack(ctx, f, G);
  faceBase(ctx, f, G);
  faceShading(ctx, f, G);
  ears(ctx, f, G);
  brows(ctx, f, G);
  eyes(ctx, f, G);
  nose(ctx, f, G);
  mouth(ctx, f, G);
  beard(ctx, f, G);
  hairFront(ctx, f, G);
  headgear(ctx, f, G);
  finish(ctx, f, G, o);
}

// ── 배경 ──
function background(ctx, f, o) {
  const bh = (f.hue + 172) % 360;
  const g = ctx.createLinearGradient(0, 0, 0, DH);
  g.addColorStop(0, `hsl(${bh} 16% 26%)`);
  g.addColorStop(0.5, `hsl(${bh} 20% 17%)`);
  g.addColorStop(1, `hsl(${bh} 24% 9%)`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, DW, DH);

  // 수묵 얼룩 — 흐린 덩어리
  soft(ctx, 22, 'source-over', 0.30, (c) => {
    for (let i = 0; i < 5; i++) {
      const x = f.R(0, DW), y = f.R(0, DH), r = f.R(24, 70);
      ellipse(c, x, y, r, r * f.R(0.5, 1.1), f.R(0, 3), `hsl(${bh} ${f.R(10, 26)}% ${f.R(8, 22)}%)`);
    }
  });

  // 인물 뒤 후광
  soft(ctx, 26, 'lighter', 0.55, (c) => {
    ellipse(c, DW / 2, 118, 84, 96, 0, `hsl(${f.hue} ${Math.min(70, f.sat + 12)}% 22%)`);
  });

  // 먼 산
  ctx.save();
  ctx.globalAlpha = 0.22;
  for (let L = 0; L < 3; L++) {
    ctx.filter = `blur(${1 + L}px)`;
    ctx.fillStyle = `hsl(${bh} 14% ${7 + L * 4}%)`;
    ctx.beginPath();
    ctx.moveTo(-6, DH);
    const base = 150 + L * 26;
    for (let x = -6; x <= DW + 6; x += 12) {
      ctx.lineTo(x, base + Math.sin(x * 0.045 + L * 2.7) * (16 - L * 4) + Math.sin(x * 0.019 + L * 1.3) * 10);
    }
    ctx.lineTo(DW + 6, DH); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

// ── 몸통 · 의복 ──
function body(ctx, f, G) {
  const { cx, chinY } = G;
  const shY = chinY + 30;
  const robe = f.robe(30), robeD = f.robe(17), robeL = f.robe(42);

  // 어깨 실루엣 그림자 (배경에서 인물을 떼어낸다)
  soft(ctx, 12, 'source-over', 0.55, (c) => {
    c.fillStyle = '#0a0806';
    c.beginPath();
    c.moveTo(-6, DH); c.bezierCurveTo(6, shY + 30, 46, shY - 12, cx - 26, shY - 22);
    c.lineTo(cx + 26, shY - 22);
    c.bezierCurveTo(DW - 46, shY - 12, DW - 6, shY + 30, DW + 6, DH);
    c.closePath(); c.fill();
  });

  // 몸통
  ctx.fillStyle = robe;
  ctx.beginPath();
  ctx.moveTo(-2, DH);
  ctx.bezierCurveTo(10, shY + 28, 48, shY - 8, cx - 24, shY - 18);
  ctx.lineTo(cx + 24, shY - 18);
  ctx.bezierCurveTo(DW - 48, shY - 8, DW - 10, shY + 28, DW + 2, DH);
  ctx.closePath();
  ctx.save(); ctx.clip();

  // 옷 주름 — 흐린 곱하기 띠
  soft(ctx, 9, 'multiply', 0.55, (c) => {
    for (let i = 0; i < 7; i++) {
      const x = f.R(0, DW);
      c.fillStyle = robeD;
      c.beginPath();
      c.moveTo(x, shY - 20);
      c.quadraticCurveTo(x + f.R(-22, 22), (shY + DH) / 2, x + f.R(-30, 30), DH);
      c.lineTo(x + f.R(6, 20), DH);
      c.quadraticCurveTo(x + f.R(-14, 26), (shY + DH) / 2, x + f.R(4, 14), shY - 20);
      c.closePath(); c.fill();
    }
  });
  // 위→아래 어둠 / 좌측 광원
  let g = ctx.createLinearGradient(0, shY - 24, 0, DH);
  g.addColorStop(0, 'rgba(255,255,255,.13)');
  g.addColorStop(0.4, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,.42)');
  ctx.fillStyle = g; ctx.fillRect(0, shY - 30, DW, DH);
  g = ctx.createLinearGradient(0, 0, DW, 0);
  g.addColorStop(0, 'rgba(255,240,214,.14)');
  g.addColorStop(0.42, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,.30)');
  ctx.fillStyle = g; ctx.fillRect(0, shY - 30, DW, DH);

  // 무늬
  if (f.pattern !== 'none') {
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = f.trim(70);
    ctx.strokeStyle = f.trim(70);
    if (f.pattern === 'dots') {
      for (let y = shY; y < DH; y += 15) for (let x = 6; x < DW; x += 15) {
        ctx.beginPath(); ctx.arc(x + (y % 30 ? 7 : 0), y, 2.2, 0, Math.PI * 2); ctx.fill();
      }
    } else if (f.pattern === 'stripe') {
      ctx.lineWidth = 2;
      for (let x = -DH; x < DW + DH; x += 16) {
        ctx.beginPath(); ctx.moveTo(x, shY); ctx.lineTo(x + 60, DH); ctx.stroke();
      }
    } else if (f.pattern === 'cloud') {
      ctx.lineWidth = 1.8;
      for (let y = shY + 8; y < DH; y += 22) for (let x = 10; x < DW; x += 30) {
        ctx.beginPath();
        ctx.arc(x, y, 5, Math.PI * 0.9, Math.PI * 2.1);
        ctx.arc(x + 8, y + 2, 4, Math.PI * 1.0, Math.PI * 2.0);
        ctx.stroke();
      }
    } else {
      for (let y = shY + 22; y < DH; y += 42) for (let x = 22; x < DW; x += 46) {
        ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();
  }
  ctx.restore();

  if (f.armored) armor(ctx, f, G, shY, robeD, robeL);
  else collar(ctx, f, G, shY, robe, robeD, robeL);
}

function armor(ctx, f, G, shY, robeD, robeL) {
  const { cx } = G;
  const steel = (x0, y0, x1, y1) => {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, '#9b9384'); g.addColorStop(0.35, '#6c6558');
    g.addColorStop(0.7, '#474137'); g.addColorStop(1, '#2c2822');
    return g;
  };
  // 견갑
  for (const dir of [-1, 1]) {
    ctx.save();
    ctx.translate(cx + dir * 74, shY + 20);
    ctx.scale(dir, 1);
    const pauldron = (c) => {
      c.beginPath();
      c.moveTo(-34, -22);
      c.bezierCurveTo(-6, -34, 26, -26, 35, -2);
      c.bezierCurveTo(36, 22, 20, 36, 2, 40);
      c.lineTo(-34, 30); c.closePath();
    };
    soft(ctx, 8, 'multiply', 0.6, (c) => {
      c.fillStyle = '#0d0a07'; c.save(); c.translate(2, 6); pauldron(c); c.fill(); c.restore();
    });
    ctx.fillStyle = steel(-34, -28, 35, 38);
    pauldron(ctx); ctx.fill();
    // 미늘
    ctx.save(); pauldron(ctx); ctx.clip();
    for (let row = 0; row < 4; row++) {
      const y = -16 + row * 13;
      for (let i = -3; i < 4; i++) {
        const x = i * 11 + (row % 2 ? 5 : 0);
        ctx.fillStyle = `rgba(255,248,230,${0.05 + row * 0.012})`;
        ctx.beginPath(); ctx.ellipse(x, y, 6, 7, 0, Math.PI, 0); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.36)'; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.ellipse(x, y, 6, 7, 0, Math.PI, 0); ctx.stroke();
      }
    }
    ctx.restore();
    // 테두리 금장
    ctx.strokeStyle = f.trim(46); ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(-34, -22); ctx.bezierCurveTo(-6, -34, 26, -26, 35, -2);
    ctx.stroke();
    // 윤곽 먹선
    soft(ctx, 1, 'multiply', 0.45, (c) => {
      c.strokeStyle = '#100c08'; c.lineWidth = 2; pauldron(c); c.stroke();
    });
    // 역광
    soft(ctx, 3, 'lighter', 0.42, (c) => {
      c.strokeStyle = '#fff1cf'; c.lineWidth = 2.2;
      c.beginPath(); c.moveTo(-31, -21); c.bezierCurveTo(-6, -31, 24, -24, 32, -4); c.stroke();
    });
    ctx.restore();
  }
  // 흉갑
  ctx.fillStyle = steel(cx - 44, shY, cx + 44, DH);
  ctx.beginPath();
  ctx.moveTo(cx - 42, shY + 6);
  ctx.quadraticCurveTo(cx, shY - 6, cx + 42, shY + 6);
  ctx.lineTo(cx + 48, DH); ctx.lineTo(cx - 48, DH);
  ctx.closePath(); ctx.fill();
  ctx.save(); ctx.clip();
  for (let row = 0; row < 5; row++) {
    const y = shY + 18 + row * 16;
    ctx.strokeStyle = 'rgba(0,0,0,.38)'; ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cx - 48, y); ctx.quadraticCurveTo(cx, y - 8, cx + 48, y); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,246,224,.14)'; ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx - 48, y + 2); ctx.quadraticCurveTo(cx, y - 6, cx + 48, y + 2); ctx.stroke();
  }
  ctx.restore();
  // 흉갑 장식
  const cy2 = shY + 40;
  ctx.fillStyle = f.trim(52);
  ctx.beginPath(); ctx.arc(cx, cy2, 9, 0, Math.PI * 2); ctx.fill();
  soft(ctx, 2, 'source-over', 0.9, (c) => {
    c.fillStyle = 'rgba(0,0,0,.5)';
    c.beginPath(); c.arc(cx, cy2 + 1, 4.4, 0, Math.PI * 2); c.fill();
  });
  soft(ctx, 1.5, 'lighter', 0.7, (c) => {
    c.fillStyle = '#fff3d2';
    c.beginPath(); c.arc(cx - 3, cy2 - 3, 3, 0, Math.PI * 2); c.fill();
  });
  // 목가리개
  ctx.fillStyle = f.robe(24);
  ctx.beginPath();
  ctx.moveTo(cx - 30, shY - 2);
  ctx.quadraticCurveTo(cx, shY + 12, cx + 30, shY - 2);
  ctx.quadraticCurveTo(cx, shY - 18, cx - 30, shY - 2);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = f.trim(56); ctx.lineWidth = 1.8; ctx.stroke();
}

function collar(ctx, f, G, shY, robe, robeD, robeL) {
  const { cx } = G;
  // 안깃 (속옷)
  ctx.fillStyle = '#e6ddc9';
  ctx.beginPath();
  ctx.moveTo(cx - 22, shY - 16);
  ctx.quadraticCurveTo(cx, shY + 26, cx + 22, shY - 16);
  ctx.lineTo(cx + 14, shY - 20); ctx.quadraticCurveTo(cx, shY + 14, cx - 14, shY - 20);
  ctx.closePath(); ctx.fill();
  soft(ctx, 5, 'multiply', 0.5, (c) => {
    c.fillStyle = '#9d947e';
    c.beginPath();
    c.moveTo(cx - 22, shY - 16); c.quadraticCurveTo(cx, shY + 26, cx + 22, shY - 16);
    c.lineTo(cx + 14, shY - 20); c.quadraticCurveTo(cx, shY + 14, cx - 14, shY - 20);
    c.closePath(); c.fill();
  });
  // 교임 — 왼쪽 자락이 위로
  ctx.fillStyle = robeL;
  ctx.beginPath();
  ctx.moveTo(cx - 34, shY - 18);
  ctx.quadraticCurveTo(cx - 14, shY + 36, cx + 10, DH);
  ctx.lineTo(cx - 54, DH);
  ctx.quadraticCurveTo(cx - 52, shY + 12, cx - 34, shY - 18);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = robeD;
  ctx.beginPath();
  ctx.moveTo(cx + 34, shY - 18);
  ctx.quadraticCurveTo(cx + 14, shY + 36, cx - 10, DH);
  ctx.lineTo(cx + 54, DH);
  ctx.quadraticCurveTo(cx + 52, shY + 12, cx + 34, shY - 18);
  ctx.closePath(); ctx.fill();
  // 깃 선 (금선)
  const line = (dir) => {
    ctx.strokeStyle = f.trim(38); ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(cx + dir * 34, shY - 20);
    ctx.quadraticCurveTo(cx + dir * 14, shY + 34, cx - dir * 8, DH);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,250,232,.22)'; ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx + dir * 33, shY - 20);
    ctx.quadraticCurveTo(cx + dir * 13, shY + 34, cx - dir * 9, DH);
    ctx.stroke();
  };
  line(1); line(-1);
}

// ── 목 ──
function neck(ctx, f, G) {
  const { cx, chinY, hw } = G;
  const s = f.skin;
  const w = hw * 0.46;
  ctx.fillStyle = s.s;                      // 목은 얼굴보다 한 톤 어둡다
  ctx.beginPath();
  ctx.moveTo(cx - w, chinY - 18);
  ctx.bezierCurveTo(cx - w * 1.04, chinY + 8, cx - w * 1.26, chinY + 26, cx - w * 1.42, chinY + 46);
  ctx.lineTo(cx + w * 1.42, chinY + 46);
  ctx.bezierCurveTo(cx + w * 1.26, chinY + 26, cx + w * 1.04, chinY + 8, cx + w, chinY - 18);
  ctx.closePath(); ctx.fill();
  // 목 가운데만 살짝 밝게
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx - w, chinY - 18);
  ctx.bezierCurveTo(cx - w * 1.04, chinY + 8, cx - w * 1.26, chinY + 26, cx - w * 1.42, chinY + 46);
  ctx.lineTo(cx + w * 1.42, chinY + 46);
  ctx.bezierCurveTo(cx + w * 1.26, chinY + 26, cx + w * 1.04, chinY + 8, cx + w, chinY - 18);
  ctx.closePath(); ctx.clip();
  soft(ctx, 10, 'lighter', 0.20, (c) => {
    ellipse(c, cx - w * 0.25, chinY + 24, w * 0.55, 20, 0, '#5c4832');
  });
  ctx.restore();
  // 턱 그림자 — 목의 핵심
  soft(ctx, 11, 'multiply', 0.95, (c) => {
    ellipse(c, cx, chinY - 1, w * 1.15, 16, 0, s.d);
  });
  soft(ctx, 7, 'multiply', 0.5, (c) => {
    ellipse(c, cx + w * 0.6, chinY + 16, w * 0.5, 16, 0, s.s);
  });
  // 쇄골 부근 반사광
  soft(ctx, 6, 'lighter', 0.16, (c) => {
    ellipse(c, cx, chinY + 30, w * 0.9, 8, 0, s.b);
  });
  // 목 근육
  soft(ctx, 2.5, 'multiply', 0.4, (c) => {
    c.strokeStyle = s.s; c.lineWidth = 3;
    c.beginPath(); c.moveTo(cx - w * 0.5, chinY + 6); c.lineTo(cx - w * 0.16, chinY + 40); c.stroke();
    c.beginPath(); c.moveTo(cx + w * 0.5, chinY + 6); c.lineTo(cx + w * 0.16, chinY + 40); c.stroke();
  });
}

// ── 얼굴 윤곽 ──
function facePath(ctx, f, G) {
  const { cx, cy, hw, hh, chinY } = G;
  const jw = hw * f.jaw;
  ctx.beginPath();
  ctx.moveTo(cx - hw, cy - hh * 0.20);
  // 광대 → 턱선
  ctx.bezierCurveTo(cx - hw * 1.02 * f.cheekbone, cy + hh * 0.22,
    cx - jw * 0.92, cy + hh * 0.60, cx - jw * 0.44, chinY - hh * 0.14);
  // 턱끝
  ctx.bezierCurveTo(cx - jw * 0.30, chinY + hh * 0.05, cx + jw * 0.30, chinY + hh * 0.05,
    cx + jw * 0.44, chinY - hh * 0.14);
  ctx.bezierCurveTo(cx + jw * 0.92, cy + hh * 0.60,
    cx + hw * 1.02 * f.cheekbone, cy + hh * 0.22, cx + hw, cy - hh * 0.20);
  // 관자놀이 → 이마 → 정수리
  ctx.bezierCurveTo(cx + hw * 1.01, cy - hh * 0.82, cx + hw * 0.72, cy - hh * 1.10, cx, cy - hh * 1.10);
  ctx.bezierCurveTo(cx - hw * 0.72, cy - hh * 1.10, cx - hw * 1.01, cy - hh * 0.82, cx - hw, cy - hh * 0.20);
  ctx.closePath();
}

function faceBase(ctx, f, G) {
  facePath(ctx, f, G);
  ctx.fillStyle = f.skin.b;
  ctx.fill();
}

function faceShading(ctx, f, G) {
  const { cx, cy, hw, hh, chinY } = G;
  const s = f.skin;
  ctx.save();
  facePath(ctx, f, G);
  ctx.clip();

  // ① 전체 방향광 (좌상단)
  let g = ctx.createLinearGradient(cx - hw, cy - hh, cx + hw * 1.1, cy + hh);
  g.addColorStop(0, 'rgba(255,246,228,.30)');
  g.addColorStop(0.40, 'rgba(255,255,255,0)');
  g.addColorStop(1, 'rgba(58,30,12,.42)');
  ctx.fillStyle = g;
  ctx.fillRect(cx - hw * 2, cy - hh * 2, hw * 4, hh * 4);

  // ② 코어 섀도 — 오른쪽 얼굴
  soft(ctx, 16, 'multiply', 0.68, (c) => {
    ellipse(c, cx + hw * 0.88, cy + hh * 0.05, hw * 0.52, hh * 0.88, 0.08, s.s);
  });
  // ③ 관자놀이
  for (const dir of [-1, 1]) {
    soft(ctx, 13, 'multiply', 0.42, (c) => {
      ellipse(c, cx + dir * hw * 0.84, cy - hh * 0.52, hw * 0.34, hh * 0.30, 0, s.s);
    });
  }
  // ④ 눈두덩 (안와)
  for (const dir of [-1, 1]) {
    soft(ctx, 9, 'multiply', 0.50, (c) => {
      ellipse(c, cx + dir * hw * 0.42 * f.eyeGap, cy - hh * (0.06 - f.eyeY), hw * 0.30, hh * 0.13,
        dir * f.eyeTilt * 0.7, s.s);
    });
  }
  // ⑤ 볼 아래 (광대 밑)
  for (const dir of [-1, 1]) {
    soft(ctx, 13, 'multiply', 0.34, (c) => {
      ellipse(c, cx + dir * hw * 0.62, cy + hh * 0.40, hw * 0.30, hh * 0.20, dir * 0.3, s.s);
    });
  }
  // ⑥ 턱 아래
  soft(ctx, 12, 'multiply', 0.45, (c) => {
    ellipse(c, cx, chinY - hh * 0.02, hw * 0.55, hh * 0.14, 0, s.s);
  });
  // ⑦ 혈색 (볼·코·귀)
  for (const [x, y, r, a] of [
    [cx - hw * 0.56, cy + hh * 0.18, hw * 0.34, 0.24],
    [cx + hw * 0.56, cy + hh * 0.18, hw * 0.34, 0.20],
    [cx, cy + hh * 0.26, hw * 0.16, 0.20],
  ]) {
    soft(ctx, 14, 'multiply', a, (c) => { ellipse(c, x, y, r, r * 0.72, 0, s.r); });
  }
  // ⑧ 하이라이트 — 이마 · 광대 · 콧등 · 턱
  soft(ctx, 14, 'lighter', 0.30, (c) => {
    ellipse(c, cx - hw * 0.22, cy - hh * 0.66, hw * 0.50, hh * 0.26, -0.1, '#5a4632');
  });
  soft(ctx, 10, 'lighter', 0.22, (c) => {
    ellipse(c, cx - hw * 0.52, cy + hh * 0.06, hw * 0.24, hh * 0.14, -0.3, '#4a3728');
  });
  soft(ctx, 8, 'lighter', 0.20, (c) => {
    ellipse(c, cx, chinY - hh * 0.18, hw * 0.20, hh * 0.10, 0, '#4a3728');
  });

  // ⑨ 나이 주름
  if (f.age > 44) {
    const a = Math.min(0.34, (f.age - 44) / 60);
    soft(ctx, 1.6, 'multiply', a, (c) => {
      c.strokeStyle = s.d; c.lineWidth = 1.6;
      for (let i = 0; i < 3; i++) {
        c.beginPath();
        c.moveTo(cx - hw * 0.52, cy - hh * 0.56 + i * 7);
        c.quadraticCurveTo(cx, cy - hh * 0.63 + i * 7, cx + hw * 0.52, cy - hh * 0.56 + i * 7);
        c.stroke();
      }
      for (const dir of [-1, 1]) {   // 팔자
        c.beginPath();
        c.moveTo(cx + dir * hw * 0.22, cy + hh * 0.30);
        c.quadraticCurveTo(cx + dir * hw * 0.48, cy + hh * 0.48, cx + dir * hw * 0.36, cy + hh * 0.64);
        c.stroke();
        // 눈가
        c.lineWidth = 1;
        for (let k = 0; k < 3; k++) {
          c.beginPath();
          c.moveTo(cx + dir * hw * 0.70, cy - hh * 0.10 + k * 5);
          c.lineTo(cx + dir * hw * 0.88, cy - hh * 0.16 + k * 6);
          c.stroke();
        }
      }
    });
  }
  // ⑩ 흉터
  if (f.scar) {
    soft(ctx, 1.2, 'multiply', 0.75, (c) => {
      c.strokeStyle = '#9a4636'; c.lineWidth = 2.4;
      c.beginPath();
      if (f.scar === 1) { c.moveTo(cx + hw * 0.56, cy - hh * 0.56); c.lineTo(cx + hw * 0.74, cy + hh * 0.10); }
      else if (f.scar === 2) { c.moveTo(cx - hw * 0.76, cy - hh * 0.28); c.lineTo(cx - hw * 0.34, cy + hh * 0.26); }
      else { c.moveTo(cx - hw * 0.58, cy + hh * 0.50); c.lineTo(cx + hw * 0.20, cy + hh * 0.72); }
      c.stroke();
    });
  }
  // ⑪ 피부 질감
  grain(ctx, DW, DH, 0.05);
  ctx.restore();
}

function ears(ctx, f, G) {
  const { cx, cy, hw } = G;
  const s = f.skin;
  for (const dir of [-1, 1]) {
    const ex = cx + dir * hw * 0.985;
    ctx.save();
    ctx.fillStyle = s.b;
    ctx.beginPath();
    ctx.ellipse(ex, cy + 8, hw * 0.095, hw * 0.185, dir * -0.10, 0, Math.PI * 2);
    ctx.fill();
    ctx.clip();
    soft(ctx, 5, 'multiply', 0.6, (c) => {
      ellipse(c, ex + dir * hw * 0.045, cy + 10, hw * 0.075, hw * 0.155, 0, s.s);
    });
    soft(ctx, 3, 'multiply', 0.7, (c) => {
      c.strokeStyle = s.d; c.lineWidth = 2.4;
      c.beginPath();
      c.ellipse(ex - dir * 1.6, cy + 7, hw * 0.040, hw * 0.10, dir * -0.10, 0, Math.PI * 2);
      c.stroke();
    });
    soft(ctx, 3, 'lighter', 0.2, (c) => {
      ellipse(c, ex - dir * 2, cy + 1, hw * 0.035, hw * 0.075, 0, '#5a4632');
    });
    ctx.restore();
  }
}

// ── 눈썹 ──
//  잔털을 흩뿌리면 지저분해진다. 굵기가 변하는 한 획으로 그린다.
function brows(ctx, f, G) {
  const { cx, cy, hw, hh } = G;
  const col = f.grey ? f.hair : shadeHex(f.hair, 6);
  const y = cy - hh * (0.28 - f.eyeY);
  for (const dir of [-1, 1]) {
    const x0 = cx + dir * hw * 0.19 * f.browGap;   // 눈썹 머리 (안쪽)
    const x1 = cx + dir * hw * 0.80;               // 눈썹 꼬리
    const tl = f.browTilt * dir;
    let cxp, cyp, y0, y1;
    switch (f.browStyle) {
      case 0: y0 = y + 3; cxp = cx + dir * hw * 0.50; cyp = y - 5 + tl * 7; y1 = y + tl * 10; break;
      case 1: y0 = y + 5; cxp = cx + dir * hw * 0.46; cyp = y - 10; y1 = y + 2 + tl * 7; break;   // 활
      case 2: y0 = y - 1; cxp = cx + dir * hw * 0.50; cyp = y + 4; y1 = y + 8 + tl * 5; break;    // 팔자
      default: y0 = y + 7; cxp = cx + dir * hw * 0.50; cyp = y - 5; y1 = y - 6 + tl * 7;          // 검미
    }
    const pts = qpts(x0, y0, cxp, cyp, x1, y1, 16);
    // 은은한 밑칠 — 피부에 스며든 느낌
    brush(ctx, pts, 3.2 + f.browThick * 3.0, 2.0, col, 0.30, 3.5);
    // 본획: 안쪽이 굵고 꼬리로 갈수록 가늘어진다
    const w0 = 2.6 + f.browThick * 3.2;
    brush(ctx, pts, w0, w0 * 0.18, col, 0.92);
    // 위쪽 가장자리에 얇은 광
    soft(ctx, 1.5, 'lighter', 0.10, (c) => {
      brush(c, pts.map(p => [p[0], p[1] - 1.2]), w0 * 0.35, 0.3, '#6a563c', 1);
    });
  }
}

// ── 눈 ──
function eyes(ctx, f, G) {
  const { cx, cy, hw, hh } = G;
  const eyY = cy - hh * (0.06 - f.eyeY);
  for (const dir of [-1, 1]) {
    const ex = cx + dir * hw * 0.42 * f.eyeGap;
    const w = hw * 0.25 * f.eyeSize;
    const h = hh * 0.085 * f.eyeSize;
    ctx.save();
    ctx.translate(ex, eyY);
    ctx.rotate(f.eyeTilt * dir);

    // 눈 구멍 모양
    const lid = () => {
      ctx.beginPath();
      switch (f.eyeStyle) {
        case 1:  // 실눈
          ctx.moveTo(-w, 0);
          ctx.quadraticCurveTo(0, -h * 1.0, w, -h * 0.1);
          ctx.quadraticCurveTo(0, h * 0.8, -w, 0); break;
        case 2:  // 큰 눈
          ctx.moveTo(-w, h * 0.1);
          ctx.quadraticCurveTo(-w * 0.2, -h * 2.0, w * 0.92, -h * 0.5);
          ctx.quadraticCurveTo(0, h * 1.7, -w, h * 0.1); break;
        case 3:  // 봉안
          ctx.moveTo(-w, h * 0.45);
          ctx.quadraticCurveTo(-w * 0.15, -h * 1.7, w * 1.10, -h * 0.85);
          ctx.quadraticCurveTo(0, h * 1.1, -w, h * 0.45); break;
        case 4:  // 처진 눈
          ctx.moveTo(-w, -h * 0.5);
          ctx.quadraticCurveTo(0, -h * 1.6, w, h * 0.35);
          ctx.quadraticCurveTo(0, h * 1.4, -w, -h * 0.5); break;
        case 5:  // 매서운 눈
          ctx.moveTo(-w, h * 0.2);
          ctx.quadraticCurveTo(w * 0.1, -h * 1.2, w * 1.02, -h * 0.75);
          ctx.quadraticCurveTo(0, h * 1.1, -w, h * 0.2); break;
        default:
          ctx.moveTo(-w, 0.5);
          ctx.quadraticCurveTo(0, -h * 1.75, w, -h * 0.15);
          ctx.quadraticCurveTo(0, h * 1.4, -w, 0.5);
      }
      ctx.closePath();
    };

    lid();
    ctx.fillStyle = '#f2ead9'; ctx.fill();
    ctx.save(); ctx.clip();
    // 흰자 명암
    soft(ctx, 5, 'multiply', 0.85, (c) => {
      ellipse(c, 0, -h * 1.5, w * 1.4, h * 1.5, 0, '#8a7a63');
    });
    soft(ctx, 4, 'multiply', 0.30, (c) => {
      ellipse(c, 0, h * 1.7, w * 1.4, h * 1.1, 0, '#a89880');
    });

    // 홍채
    const ir = Math.min(w * 0.56, h * 1.35);
    const ox = dir * w * 0.04, oy = h * 0.12;
    const ig = ctx.createRadialGradient(ox - ir * 0.3, oy - ir * 0.3, ir * 0.1, ox, oy, ir);
    ig.addColorStop(0, '#8a6437');
    ig.addColorStop(0.42, '#5a3f22');
    ig.addColorStop(0.82, '#2e2013');
    ig.addColorStop(1, '#120c07');
    ctx.fillStyle = ig;
    ctx.beginPath(); ctx.arc(ox, oy, ir, 0, Math.PI * 2); ctx.fill();
    // 홍채 결
    ctx.save();
    ctx.globalAlpha = 0.30; ctx.strokeStyle = '#c99a54'; ctx.lineWidth = 0.7;
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + f.seed % 7;
      ctx.beginPath();
      ctx.moveTo(ox + Math.cos(a) * ir * 0.34, oy + Math.sin(a) * ir * 0.34);
      ctx.lineTo(ox + Math.cos(a) * ir * 0.92, oy + Math.sin(a) * ir * 0.92);
      ctx.stroke();
    }
    ctx.restore();
    // 윤부(limbal ring)
    ctx.strokeStyle = 'rgba(14,9,5,.72)'; ctx.lineWidth = ir * 0.16;
    ctx.beginPath(); ctx.arc(ox, oy, ir * 0.93, 0, Math.PI * 2); ctx.stroke();
    // 동공
    ctx.fillStyle = '#0b0704';
    ctx.beginPath(); ctx.arc(ox, oy, ir * 0.42, 0, Math.PI * 2); ctx.fill();
    // 윗눈꺼풀 그림자
    soft(ctx, 4, 'multiply', 0.9, (c) => {
      ellipse(c, 0, -h * 1.9, w * 1.3, h * 1.35, 0, '#6b5a44');
    });
    // 반사광
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.beginPath(); ctx.arc(ox - ir * 0.36, oy - ir * 0.40, ir * 0.24, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.34)';
    ctx.beginPath(); ctx.arc(ox + ir * 0.34, oy + ir * 0.36, ir * 0.13, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // 속눈썹 · 눈꺼풀 선
    ctx.strokeStyle = 'rgba(24,15,8,.92)';
    ctx.lineWidth = 2.0 + (f.female ? 0.7 : 0) + f.lidHeavy * 0.9;
    ctx.beginPath();
    switch (f.eyeStyle) {
      case 3: ctx.moveTo(-w, h * 0.45); ctx.quadraticCurveTo(-w * 0.15, -h * 1.7, w * 1.10, -h * 0.85); break;
      case 4: ctx.moveTo(-w, -h * 0.5); ctx.quadraticCurveTo(0, -h * 1.6, w, h * 0.35); break;
      case 5: ctx.moveTo(-w, h * 0.2); ctx.quadraticCurveTo(w * 0.1, -h * 1.2, w * 1.02, -h * 0.75); break;
      default: ctx.moveTo(-w, 0.5); ctx.quadraticCurveTo(0, -h * 1.75, w, -h * 0.15);
    }
    ctx.stroke();
    // 아랫선
    ctx.strokeStyle = 'rgba(70,46,26,.45)'; ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(-w * 0.88, h * 0.25);
    ctx.quadraticCurveTo(0, h * 1.25, w * 0.9, h * 0.05);
    ctx.stroke();
    // 쌍꺼풀
    if (f.eyeStyle === 2 || f.female || f.lidHeavy > 0.6) {
      ctx.strokeStyle = 'rgba(130,94,60,.42)'; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-w * 0.78, -h * 1.1);
      ctx.quadraticCurveTo(0, -h * 2.5, w * 0.86, -h * 0.95);
      ctx.stroke();
    }
    // 눈머리 그늘
    soft(ctx, 2, 'multiply', 0.5, (c) => {
      ellipse(c, -dir * w * 0.9, h * 0.1, w * 0.16, h * 0.6, 0, f.skin.s);
    });
    ctx.restore();
  }
}

// ── 코 ──
function nose(ctx, f, G) {
  const { cx, cy, hw, hh } = G;
  const s = f.skin;
  const tipY = cy + hh * 0.30 * f.noseLen;
  const nw = hw * 0.155 * f.noseW;

  ctx.save();
  facePath(ctx, f, G);
  ctx.clip();
  // 콧대 오른쪽 그림자
  soft(ctx, 7, 'multiply', 0.55, (c) => {
    c.fillStyle = s.s;
    c.beginPath();
    c.moveTo(cx + nw * 0.2, cy - hh * 0.22);
    c.quadraticCurveTo(cx + nw * 1.1, cy + hh * 0.06, cx + nw * 1.5, tipY + 2);
    c.lineTo(cx + nw * 0.2, tipY + 2);
    c.closePath(); c.fill();
  });
  // 콧대 하이라이트
  soft(ctx, 6, 'lighter', 0.26 * f.noseBridge, (c) => {
    c.fillStyle = '#5c4832';
    c.beginPath();
    c.moveTo(cx - nw * 0.55, cy - hh * 0.24);
    c.quadraticCurveTo(cx - nw * 0.2, cy + hh * 0.04, cx - nw * 0.1, tipY - 4);
    c.lineTo(cx + nw * 0.25, tipY - 4);
    c.quadraticCurveTo(cx + nw * 0.2, cy + hh * 0.02, cx - nw * 0.1, cy - hh * 0.24);
    c.closePath(); c.fill();
  });
  // 콧방울
  for (const dir of [-1, 1]) {
    soft(ctx, 3.5, 'multiply', 0.55, (c) => {
      ellipse(c, cx + dir * nw * 1.05, tipY - 1, nw * 0.55, nw * 0.42, dir * 0.25, s.s);
    });
  }
  // 코끝 그늘
  soft(ctx, 5, 'multiply', 0.42, (c) => {
    ellipse(c, cx, tipY + 4, nw * 1.5, nw * 0.5, 0, s.s);
  });
  // 코끝 하이라이트
  soft(ctx, 3.5, 'lighter', 0.30, (c) => {
    ellipse(c, cx - nw * 0.2, tipY - nw * 0.55, nw * 0.5, nw * 0.34, 0, '#5c4832');
  });
  ctx.restore();

  // 콧구멍
  ctx.fillStyle = 'rgba(52,28,15,.66)';
  ctx.beginPath(); ctx.ellipse(cx - nw * 0.55, tipY + 0.5, nw * 0.24, nw * 0.16, 0.35, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(cx + nw * 0.55, tipY + 0.5, nw * 0.24, nw * 0.16, -0.35, 0, Math.PI * 2); ctx.fill();
}

// ── 입 ──
function mouth(ctx, f, G) {
  const { cx, cy, hw, hh, chinY } = G;
  const my = cy + hh * (0.56 + f.mouthY);
  const w = hw * 0.28 * f.mouthW;
  const lip = 2.4 * f.lip;
  const smile = f.eyeStyle === 5 ? -1.2 : (f.eyeStyle === 2 ? 1.4 : 0.7);

  ctx.save();
  facePath(ctx, f, G);
  ctx.clip();
  // 입 주변 그늘
  soft(ctx, 8, 'multiply', 0.30, (c) => {
    ellipse(c, cx, my + lip * 2.6, w * 1.3, lip * 1.6, 0, f.skin.s);
  });
  ctx.restore();

  // 윗입술
  const upC = f.female ? '#a44a3c' : '#8a4638';
  ctx.fillStyle = upC;
  ctx.beginPath();
  ctx.moveTo(cx - w, my);
  ctx.quadraticCurveTo(cx - w * 0.52, my - lip * 1.6, cx - w * 0.13, my - lip * 0.55);
  ctx.quadraticCurveTo(cx, my - lip * 1.15, cx + w * 0.13, my - lip * 0.55);
  ctx.quadraticCurveTo(cx + w * 0.52, my - lip * 1.6, cx + w, my);
  ctx.quadraticCurveTo(cx, my + lip * 0.55, cx - w, my);
  ctx.closePath(); ctx.fill();
  // 아랫입술
  ctx.fillStyle = f.female ? '#b95a48' : '#9c5644';
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.94, my + 0.6);
  ctx.quadraticCurveTo(cx, my + lip * 2.3, cx + w * 0.94, my + 0.6);
  ctx.quadraticCurveTo(cx, my + lip * 0.6, cx - w * 0.94, my + 0.6);
  ctx.closePath(); ctx.fill();
  // 입술 명암
  soft(ctx, 3.5, 'multiply', 0.45, (c) => {
    ellipse(c, cx + w * 0.5, my + lip * 0.6, w * 0.5, lip * 1.2, 0, '#6d3226');
  });
  soft(ctx, 3, 'lighter', 0.30, (c) => {
    ellipse(c, cx - w * 0.14, my + lip * 1.25, w * 0.36, lip * 0.44, 0, '#7a4436');
  });
  // 입 선
  ctx.strokeStyle = 'rgba(48,22,14,.82)'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - w, my);
  ctx.quadraticCurveTo(cx - w * 0.4, my + smile, cx, my + 0.4);
  ctx.quadraticCurveTo(cx + w * 0.4, my + smile, cx + w, my);
  ctx.stroke();
  // 입꼬리
  soft(ctx, 2, 'multiply', 0.65, (c) => {
    ellipse(c, cx - w, my + 0.5, 2.4, 2, 0, '#5c2a1e');
    ellipse(c, cx + w, my + 0.5, 2.4, 2, 0, '#5c2a1e');
  });
  // 인중
  soft(ctx, 2.5, 'multiply', 0.35, (c) => {
    c.strokeStyle = f.skin.s; c.lineWidth = 2;
    c.beginPath();
    c.moveTo(cx - 1.6, my - lip * 1.7 - 6); c.lineTo(cx - 1.6, my - lip * 1.5);
    c.moveTo(cx + 1.6, my - lip * 1.7 - 6); c.lineTo(cx + 1.6, my - lip * 1.5);
    c.stroke();
  });
}

// ── 수염 ──
//  구레나룻 · 턱선 · 턱수염을 하나의 실루엣으로 잡고
//  그 안에서만 결을 낸다. 따로 그리면 턱끈처럼 보인다.
function beard(ctx, f, G) {
  if (!f.beard) return;
  const { cx, cy, hw, hh, chinY } = G;
  const col = f.hair;
  const my = cy + hh * 0.56;
  const b = f.beard;
  const long = b >= 4;
  const len = long ? hh * (0.42 + f.beardLen * 0.40) : hh * 0.16 * f.beardLen;
  const tipW = long ? hw * 0.20 : hw * 0.40;
  const full = b >= 2;                 // 턱수염이 있는가
  // 구레나룻은 광대뼈 아래에서 시작해야 한다. 위에서 시작하면 턱끈처럼 보인다.
  const bushy = b >= 4;
  const sideTop = cy + hh * (bushy ? 0.16 : 0.30);
  const outer = hw * (bushy ? 0.90 : 0.80);

  // 전체 실루엣 — 턱을 감싸되 볼은 비운다
  const sil = (c) => {
    c.beginPath();
    c.moveTo(cx - outer, sideTop);
    // 왼쪽 턱선
    c.bezierCurveTo(cx - outer * 1.02, cy + hh * 0.48, cx - hw * 0.66, cy + hh * 0.70, cx - hw * 0.48, my + hh * 0.06);
    c.bezierCurveTo(cx - hw * 0.50, chinY + len * 0.34, cx - tipW, chinY + len * 0.80, cx - tipW * 0.48, chinY + len);
    c.quadraticCurveTo(cx, chinY + len * 1.10, cx + tipW * 0.48, chinY + len);
    c.bezierCurveTo(cx + tipW, chinY + len * 0.80, cx + hw * 0.50, chinY + len * 0.34, cx + hw * 0.48, my + hh * 0.06);
    c.bezierCurveTo(cx + hw * 0.66, cy + hh * 0.70, cx + outer * 1.02, cy + hh * 0.48, cx + outer, sideTop);
    // 위쪽 경계 — 입 아래를 지난다
    c.bezierCurveTo(cx + outer * 0.86, cy + hh * 0.52, cx + hw * 0.40, my + hh * 0.20, cx, my + hh * 0.22);
    c.bezierCurveTo(cx - hw * 0.40, my + hh * 0.20, cx - outer * 0.86, cy + hh * 0.52, cx - outer, sideTop);
    c.closePath();
  };

  if (full) {
    // 피부에 닿는 경계를 흐리게 — 붙인 티가 나지 않도록
    soft(ctx, 6, 'source-over', 0.55, (c) => { c.fillStyle = shadeHex(col, -2); sil(c); c.fill(); });
    ctx.save();
    sil(ctx);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.clip();
    // 입체 — 오른쪽이 어둡고 가운데가 밝다
    soft(ctx, 14, 'multiply', f.grey ? 0.42 : 0.55, (c) => {
      ellipse(c, cx + hw * 0.52, cy + hh * 0.60, hw * 0.42, hh * 0.60, 0, f.grey ? '#544c42' : '#0a0806');
    });
    soft(ctx, 12, 'multiply', 0.35, (c) => {
      ellipse(c, cx - hw * 0.66, cy + hh * 0.40, hw * 0.24, hh * 0.34, 0, '#0a0806');
    });
    soft(ctx, 10, 'lighter', 0.16, (c) => {
      ellipse(c, cx - hw * 0.14, my + hh * 0.30, hw * 0.30, hh * 0.20, 0, '#5a4832');
    });
    // 결 — 턱 끝으로 모이는 부챗살
    for (let i = 0; i < 30; i++) {
      const t = (i / 29 - 0.5) * 2;
      const sx = cx + t * outer * 0.86;
      const sy = cy + hh * (0.44 + (1 - Math.abs(t)) * 0.20);
      const ex = cx + t * tipW * 1.3 + f.R(-2.5, 2.5);
      const ey = chinY + len * (0.66 + f.rnd() * 0.42);
      // 흰 수염은 어두운 결로, 검은 수염은 밝은 결로 대비를 만든다
      const tone = f.grey
        ? (i % 5 === 0 ? shadeHex(col, -58) : i % 3 === 0 ? shadeHex(col, -34) : shadeHex(col, -12))
        : (i % 6 === 0 ? shadeHex(col, 46) : i % 4 === 0 ? shadeHex(col, 22)
          : i % 3 === 0 ? shadeHex(col, -12) : col);
      brush(ctx, qpts(sx, sy, cx + t * hw * 0.48, chinY + len * 0.34, ex, ey),
        3.0, 0.4, tone, i % 6 === 0 ? 0.55 : 0.8);
    }
    // 윤곽 — 밝은 수염일수록 경계를 잡아줘야 덩어리로 보이지 않는다
    soft(ctx, 1.6, 'multiply', f.grey ? 0.62 : 0.34, (c) => {
      c.strokeStyle = f.grey ? '#4a443c' : '#0d0a07';
      c.lineWidth = 2.2; sil(c); c.stroke();
    });
    ctx.restore();
    // 실루엣 가장자리를 살짝 부수어 딱딱함을 없앤다
    ctx.save();
    sil(ctx); ctx.clip();
    for (let i = 0; i < 22; i++) {
      const a = Math.PI * (0.15 + f.rnd() * 0.7);
      const rx = cx + Math.cos(a + Math.PI) * hw * (0.5 + f.rnd() * 0.5);
      const ry = cy + hh * 0.3 + f.rnd() * len;
      brush(ctx, [[rx, ry], [rx + f.R(-6, 6), ry + f.R(4, 12)]], 2.2, 0.3, shadeHex(col, 16), 0.5);
    }
    ctx.restore();
  }

  if (b >= 1) {
    // 콧수염
    const mus = (c) => {
      c.beginPath();
      c.moveTo(cx - hw * 0.42, my - hh * 0.10);
      c.quadraticCurveTo(cx - hw * 0.16, my - hh * 0.20, cx, my - hh * 0.155);
      c.quadraticCurveTo(cx + hw * 0.16, my - hh * 0.20, cx + hw * 0.42, my - hh * 0.10);
      c.quadraticCurveTo(cx, my - hh * 0.015, cx - hw * 0.42, my - hh * 0.10);
      c.closePath();
    };
    soft(ctx, 3.5, 'source-over', 0.6, (c) => { c.fillStyle = shadeHex(col, -3); mus(c); c.fill(); });
    ctx.save();
    mus(ctx); ctx.fillStyle = col; ctx.fill(); ctx.clip();
    for (let i = 0; i < 20; i++) {
      const t = i / 19 - 0.5;
      brush(ctx, qpts(cx + t * hw * 0.10, my - hh * 0.135,
        cx + t * hw * 0.50, my - hh * 0.165,
        cx + t * hw * 0.98, my - hh * 0.05 + Math.abs(t) * 5),
        2.4, 0.5, i % 5 === 0 ? shadeHex(col, 40) : (i % 3 ? col : shadeHex(col, -10)), 0.85);
    }
    soft(ctx, 5, 'multiply', 0.4, (c) => {
      ellipse(c, cx + hw * 0.26, my - hh * 0.09, hw * 0.20, hh * 0.05, 0, '#0a0806');
    });
    soft(ctx, 3.5, 'lighter', 0.14, (c) => {
      ellipse(c, cx - hw * 0.16, my - hh * 0.155, hw * 0.18, hh * 0.025, 0, '#5a4832');
    });
    ctx.restore();

    // 늘어뜨린 팔자수염
    if (b === 3 || b === 5 || b === 6) {
      for (const dir of [-1, 1]) {
        const p0 = [cx + dir * hw * 0.40, my - hh * 0.07];
        const shape = (c) => {
          c.beginPath();
          c.moveTo(p0[0], p0[1]);
          c.quadraticCurveTo(cx + dir * hw * 0.60, my + hh * 0.20, cx + dir * hw * 0.46, my + hh * (0.44 + f.beardLen * 0.22));
          c.quadraticCurveTo(cx + dir * hw * 0.40, my + hh * 0.22, cx + dir * hw * 0.30, my - hh * 0.04);
          c.closePath();
        };
        soft(ctx, 3, 'source-over', 0.6, (c) => { c.fillStyle = shadeHex(col, -4); shape(c); c.fill(); });
        ctx.save(); shape(ctx); ctx.fillStyle = col; ctx.fill(); ctx.clip();
        for (let i = 0; i < 6; i++) {
          const k = i / 5;
          brush(ctx, qpts(cx + dir * hw * (0.34 + k * 0.08), my - hh * 0.05,
            cx + dir * hw * (0.56 + k * 0.04), my + hh * 0.20,
            cx + dir * hw * (0.42 + k * 0.05), my + hh * (0.44 + f.beardLen * 0.22)),
            2.4, 0.4, i % 3 ? col : shadeHex(col, 26), 0.8);
        }
        ctx.restore();
      }
    }
  }
}

// ── 머리 (뒤) ──
function hairBack(ctx, f, G) {
  const { cx, cy, hw, hh } = G;
  const col = shadeHex(f.hair, -12);
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.ellipse(cx, cy - hh * 0.36, hw * 1.10, hh * 1.00, 0, Math.PI, Math.PI * 2);
  ctx.fill();
  // 어깨로 흘러내린 머리
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + dir * hw * 1.06, cy - hh * 0.36);
    ctx.quadraticCurveTo(cx + dir * hw * 1.20, cy + hh * 0.44, cx + dir * hw * 0.98, cy + hh * 0.86);
    ctx.lineTo(cx + dir * hw * 0.80, cy + hh * 0.30);
    ctx.closePath(); ctx.fill();
  }
  soft(ctx, 8, 'multiply', 0.4, (c) => {
    ellipse(c, cx, cy - hh * 0.2, hw * 1.1, hh * 0.9, 0, '#0d0a07');
  });
}

// ── 머리 (앞) ──
function hairFront(ctx, f, G) {
  const { cx, cy, hw, hh } = G;
  const col = f.hair;
  const crown = cy - hh * 1.10;
  const brow = cy - hh * (0.80 + (f.balding ? 0.14 : 0));   // 헤어라인 — 이마가 드러나야 한다

  ctx.save();
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(cx - hw * 1.05, cy - hh * 0.14);
  ctx.bezierCurveTo(cx - hw * 1.12, crown + hh * 0.14, cx - hw * 0.54, crown - hh * 0.10, cx, crown - hh * 0.09);
  ctx.bezierCurveTo(cx + hw * 0.54, crown - hh * 0.10, cx + hw * 1.12, crown + hh * 0.14, cx + hw * 1.05, cy - hh * 0.14);
  // 헤어라인
  const hs = f.balding ? 1 : f.hairStyle;
  if (hs === 0) {
    ctx.bezierCurveTo(cx + hw * 0.94, brow - 4, cx + hw * 0.44, brow - 12, cx, brow - 11);
    ctx.bezierCurveTo(cx - hw * 0.44, brow - 12, cx - hw * 0.94, brow - 4, cx - hw * 1.05, cy - hh * 0.14);
  } else if (hs === 1) {          // M자
    ctx.bezierCurveTo(cx + hw * 0.98, brow - 1, cx + hw * 0.70, brow - 20, cx + hw * 0.36, brow - 5);
    ctx.quadraticCurveTo(cx, brow - 20, cx - hw * 0.36, brow - 5);
    ctx.bezierCurveTo(cx - hw * 0.70, brow - 20, cx - hw * 0.98, brow - 1, cx - hw * 1.05, cy - hh * 0.14);
  } else if (hs === 2) {          // 한쪽 가르마
    ctx.bezierCurveTo(cx + hw * 0.92, brow - 2, cx + hw * 0.18, brow - 18, cx - hw * 0.58, brow - 4);
    ctx.quadraticCurveTo(cx - hw * 0.92, brow + 3, cx - hw * 1.05, cy - hh * 0.14);
  } else if (hs === 3) {          // 앞머리
    ctx.bezierCurveTo(cx + hw * 0.92, brow + 9, cx + hw * 0.42, brow + 3, cx, brow + 10);
    ctx.bezierCurveTo(cx - hw * 0.42, brow + 3, cx - hw * 0.92, brow + 9, cx - hw * 1.05, cy - hh * 0.14);
  } else {                        // 높은 이마
    ctx.bezierCurveTo(cx + hw * 0.96, brow - 12, cx + hw * 0.46, brow - 22, cx, brow - 21);
    ctx.bezierCurveTo(cx - hw * 0.46, brow - 22, cx - hw * 0.96, brow - 12, cx - hw * 1.05, cy - hh * 0.14);
  }
  ctx.closePath();
  ctx.fill();

  ctx.save(); ctx.clip();
  // 입체
  soft(ctx, 14, 'multiply', 0.55, (c) => {
    ellipse(c, cx + hw * 0.8, cy - hh * 0.62, hw * 0.6, hh * 0.6, 0, '#0b0907');
  });
  // 머리 아랫단 — 이마에 지는 그늘 (머리가 얼굴 위에 얹힌 느낌)
  soft(ctx, 7, 'multiply', 0.55, (c) => {
    c.fillStyle = '#0e0b08';
    c.beginPath();
    c.moveTo(cx - hw * 1.1, brow + 10);
    c.bezierCurveTo(cx - hw * 0.5, brow - 6, cx + hw * 0.5, brow - 6, cx + hw * 1.1, brow + 10);
    c.lineTo(cx + hw * 1.1, brow - 16);
    c.lineTo(cx - hw * 1.1, brow - 16);
    c.closePath(); c.fill();
  });
  soft(ctx, 12, 'lighter', 0.16, (c) => {
    ellipse(c, cx - hw * 0.30, crown + hh * 0.26, hw * 0.55, hh * 0.20, -0.15, '#6a5a44');
  });
  // 결
  for (let i = 0; i < 26; i++) {
    const t = i / 25 - 0.5;
    const c1 = i % 5 === 0 ? shadeHex(col, 46) : (i % 3 ? shadeHex(col, 16) : shadeHex(col, -14));
    brush(ctx, qpts(cx + t * hw * 0.42, crown + hh * 0.02,
      cx + t * hw * 1.25, cy - hh * 0.66,
      cx + t * hw * 2.0, cy - hh * 0.10),
      2.0, 0.4, c1, i % 5 === 0 ? 0.36 : 0.24);
  }
  ctx.restore();
  ctx.restore();

  // 상투
  if (f.hat === 0 || f.hat === 8) {
    const ty = crown - hh * 0.02;
    ctx.fillStyle = shadeHex(col, -4);
    ctx.beginPath(); ctx.ellipse(cx, ty - 8, hw * 0.20, hh * 0.15, 0, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.beginPath(); ctx.ellipse(cx, ty - 8, hw * 0.20, hh * 0.15, 0, 0, Math.PI * 2); ctx.clip();
    soft(ctx, 5, 'lighter', 0.22, (c) => { ellipse(c, cx - 5, ty - 13, hw * 0.10, hh * 0.06, 0, '#6a5a44'); });
    soft(ctx, 5, 'multiply', 0.5, (c) => { ellipse(c, cx + 7, ty - 3, hw * 0.10, hh * 0.08, 0, '#0d0a07'); });
    ctx.restore();
    // 비녀
    ctx.strokeStyle = f.trim(46); ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.moveTo(cx - hw * 0.26, ty - 11); ctx.lineTo(cx + hw * 0.26, ty - 5); ctx.stroke();
    soft(ctx, 1.5, 'lighter', 0.5, (c) => {
      c.strokeStyle = '#fff0c8'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(cx - hw * 0.22, ty - 11); c.lineTo(cx + hw * 0.20, ty - 6); c.stroke();
    });
  }
}

// ── 관 · 투구 ──
function headgear(ctx, f, G) {
  const { cx, cy, hw, hh } = G;
  const crown = cy - hh * 1.10;
  const band = cy - hh * 0.86;      // 헤어라인 바로 위
  const bw = hw * 0.93;
  const dark = '#211f1a';

  const grad = (x0, y0, x1, y1, a, b, c) => {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, a); g.addColorStop(0.42, b); g.addColorStop(1, c);
    return g;
  };
  const rimlight = (path) => soft(ctx, 2.5, 'lighter', 0.38, (c) => {
    c.strokeStyle = '#fff2cd'; c.lineWidth = 2.2;
    c.beginPath();                    // ← 경로를 새로 열지 않으면 앞의 도형과 이어진다
    path(c); c.stroke();
  });
  const dropShadow = (path) => soft(ctx, 7, 'multiply', 0.55, (c) => {
    c.fillStyle = '#141008'; c.save(); c.translate(3, 6); path(c); c.fill(); c.restore();
  });

  switch (f.hat) {
    case 0: break;
    case 1: {   // 두건
      const p = (c) => {
        c.beginPath();
        c.moveTo(cx - bw * 1.02, band + 16);
        c.bezierCurveTo(cx - bw * 1.10, crown - 10, cx + bw * 1.10, crown - 10, cx + bw * 1.02, band + 16);
        c.quadraticCurveTo(cx, band - 2, cx - bw * 1.02, band + 16);
        c.closePath();
      };
      dropShadow(p);
      // 뒤 자락
      ctx.fillStyle = f.robe(19);
      ctx.beginPath();
      ctx.moveTo(cx - bw * 0.92, crown + hh * 0.28);
      ctx.quadraticCurveTo(cx - bw * 1.6, crown + hh * 0.12, cx - bw * 1.3, crown + hh * 0.76);
      ctx.quadraticCurveTo(cx - bw * 1.02, crown + hh * 0.52, cx - bw * 0.92, crown + hh * 0.28);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = grad(cx - bw, crown, cx + bw, band, f.robe(38), f.robe(27), f.robe(15));
      p(ctx); ctx.fill();
      // 천 주름
      soft(ctx, 4, 'multiply', 0.4, (c) => {
        c.strokeStyle = f.robe(12); c.lineWidth = 3;
        for (let i = -2; i <= 2; i++) {
          c.beginPath();
          c.moveTo(cx + i * bw * 0.32, band + 4);
          c.quadraticCurveTo(cx + i * bw * 0.22, crown + hh * 0.16, cx + i * bw * 0.10, crown + 2);
          c.stroke();
        }
      });
      ctx.strokeStyle = f.trim(40); ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(cx - bw * 1.02, band + 15); ctx.quadraticCurveTo(cx, band - 1, cx + bw * 1.02, band + 15); ctx.stroke();
      rimlight((c) => { c.moveTo(cx - bw * 0.9, band); c.bezierCurveTo(cx - bw * 0.9, crown + 2, cx - bw * 0.2, crown - 5, cx + bw * 0.1, crown - 5); });
      break;
    }
    case 2: {   // 유건
      const top = crown - hh * 0.10;
      const p = (c) => {
        c.beginPath();
        c.moveTo(cx - bw * 0.98, band + 8);
        c.lineTo(cx - bw * 0.90, top);
        c.lineTo(cx + bw * 0.90, top);
        c.lineTo(cx + bw * 0.98, band + 8);
        c.closePath();
      };
      dropShadow(p);
      ctx.fillStyle = grad(cx - bw, top, cx + bw, band, '#3d3a33', '#2a2823', '#17150f');
      p(ctx); ctx.fill();
      // 접힘
      soft(ctx, 3, 'multiply', 0.5, (c) => {
        c.strokeStyle = '#0f0d0a'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(cx - bw * 0.36, top + 2); c.lineTo(cx - bw * 0.30, band + 6); c.stroke();
        c.beginPath(); c.moveTo(cx + bw * 0.36, top + 2); c.lineTo(cx + bw * 0.30, band + 6); c.stroke();
      });
      ctx.fillStyle = grad(cx - bw, band, cx + bw, band + 12, '#4a463c', '#332f28', '#1c1a15');
      ctx.beginPath();
      ctx.moveTo(cx - bw * 1.04, band + 2); ctx.lineTo(cx + bw * 1.04, band + 2);
      ctx.lineTo(cx + bw * 1.00, band + 12); ctx.lineTo(cx - bw * 1.00, band + 12);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = f.trim(); ctx.lineWidth = 1.6; ctx.stroke();
      rimlight((c) => { c.moveTo(cx - bw * 0.94, band + 4); c.lineTo(cx - bw * 0.88, top + 2); c.lineTo(cx + bw * 0.4, top + 2); });
      break;
    }
    case 3: {   // 진현관
      const top = crown - hh * 0.18;
      const p = (c) => {
        c.beginPath();
        c.moveTo(cx - bw * 0.99, band + 6);
        c.quadraticCurveTo(cx - bw * 0.82, top + hh * 0.14, cx - bw * 0.50, top);
        c.lineTo(cx + bw * 0.88, top + hh * 0.24);
        c.lineTo(cx + bw * 0.99, band + 6);
        c.closePath();
      };
      dropShadow(p);
      ctx.fillStyle = grad(cx - bw, top, cx + bw, band, '#35322b', '#232019', '#131109');
      p(ctx); ctx.fill();
      ctx.fillStyle = f.trim();
      ctx.fillRect(cx - bw * 1.04, band + 2, bw * 2.08, 5);
      soft(ctx, 1.5, 'lighter', 0.4, (c) => {
        c.fillStyle = '#fff0c8'; c.fillRect(cx - bw * 1.04, band + 2, bw * 2.08, 1.6);
      });
      rimlight((c) => { c.moveTo(cx - bw * 0.96, band + 2); c.quadraticCurveTo(cx - bw * 0.80, top + hh * 0.14, cx - bw * 0.50, top + 2); });
      break;
    }
    case 4: {   // 관모 + 갓끈
      const p = (c) => {
        c.beginPath();
        c.ellipse(cx, crown + hh * 0.12, bw * 0.94, hh * 0.32, 0, Math.PI, 0);
        c.closePath();
      };
      dropShadow(p);
      ctx.fillStyle = grad(cx - bw, crown, cx + bw, band, '#3a352c', '#26231c', '#141209');
      p(ctx); ctx.fill();
      ctx.fillStyle = grad(cx - bw, crown, cx + bw, crown + 14, '#4d473c', '#332f27', '#1b1813');
      ctx.fillRect(cx - bw * 1.06, crown + hh * 0.08, bw * 2.12, 9);
      ctx.strokeStyle = 'rgba(30,24,16,.55)'; ctx.lineWidth = 1.3;
      for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(cx + dir * bw * 0.94, crown + hh * 0.22);
        ctx.quadraticCurveTo(cx + dir * bw * 1.10, cy + hh * 0.10, cx + dir * bw * 0.96, cy + hh * 0.62);
        ctx.stroke();
      }
      rimlight((c) => { c.ellipse(cx, crown + hh * 0.12, bw * 0.90, hh * 0.30, 0, Math.PI * 1.05, Math.PI * 1.6); });
      break;
    }
    case 5:
    case 6: {   // 투구
      const top = crown - hh * 0.02;
      const hb = band + hh * 0.16;         // 투구 아래끝
      const p = (c) => {
        c.beginPath();
        c.moveTo(cx - bw * 1.10, hb);
        c.bezierCurveTo(cx - bw * 1.12, top + hh * 0.10, cx + bw * 1.12, top + hh * 0.10, cx + bw * 1.10, hb);
        c.closePath();
      };
      dropShadow(p);
      ctx.fillStyle = grad(cx - bw, top, cx + bw, hb, '#a49a88', '#6b6456', '#332f27');
      p(ctx); ctx.fill();
      ctx.save(); p(ctx); ctx.clip();
      // 금속 반사
      soft(ctx, 9, 'lighter', 0.30, (c) => {
        ellipse(c, cx - bw * 0.34, top + hh * 0.30, bw * 0.26, hh * 0.34, -0.2, '#8e8676');
      });
      soft(ctx, 8, 'multiply', 0.45, (c) => {
        ellipse(c, cx + bw * 0.66, hb - hh * 0.10, bw * 0.4, hh * 0.4, 0, '#171410');
      });
      // 마루
      ctx.strokeStyle = 'rgba(255,248,222,.28)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(cx, top + 2); ctx.lineTo(cx, hb - 4); ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,.30)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx + 3.5, top + 3); ctx.lineTo(cx + 3.5, hb - 4); ctx.stroke();
      // 리벳
      ctx.fillStyle = 'rgba(255,244,214,.32)';
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath(); ctx.arc(cx + i * bw * 0.36, hb - 10, 2, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      // 챙
      ctx.fillStyle = grad(cx - bw, hb - 8, cx + bw, hb + 8, '#b3a996', '#78705f', '#3d3830');
      ctx.beginPath();
      ctx.moveTo(cx - bw * 1.18, hb - 4);
      ctx.quadraticCurveTo(cx, hb - 18, cx + bw * 1.18, hb - 4);
      ctx.lineTo(cx + bw * 1.10, hb + 6);
      ctx.quadraticCurveTo(cx, hb - 5, cx - bw * 1.10, hb + 6);
      ctx.closePath(); ctx.fill();
      // 볼가리개
      for (const dir of [-1, 1]) {
        ctx.fillStyle = grad(cx + dir * bw, band, cx + dir * bw * 0.7, cy + hh * 0.6, '#4a453c', '#332f28', '#1d1a15');
        ctx.beginPath();
        ctx.moveTo(cx + dir * bw * 1.06, hb + 2);
        ctx.quadraticCurveTo(cx + dir * bw * 1.16, cy + hh * 0.10, cx + dir * bw * 1.04, cy + hh * 0.34);
        ctx.lineTo(cx + dir * bw * 0.94, cy + hh * 0.04);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 1.2; ctx.stroke();
      }
      if (f.hat === 6) {   // 붉은 술
        const tg = ctx.createLinearGradient(cx - 12, top - hh * 0.44, cx + 12, top);
        tg.addColorStop(0, '#d8503a'); tg.addColorStop(0.5, '#ad3427'); tg.addColorStop(1, '#7a2119');
        ctx.fillStyle = tg;
        ctx.beginPath();
        ctx.moveTo(cx - 6, top + hh * 0.05);
        ctx.lineTo(cx + 6, top + hh * 0.05);
        ctx.quadraticCurveTo(cx + 18, top - hh * 0.32, cx, top - hh * 0.46);
        ctx.quadraticCurveTo(cx - 18, top - hh * 0.32, cx - 6, top + hh * 0.05);
        ctx.closePath(); ctx.fill();
        soft(ctx, 3, 'lighter', 0.3, (c) => {
          ellipse(c, cx - 4, top - hh * 0.18, 3.5, 11, 0.15, '#ff9a7a');
        });
        ctx.fillStyle = f.trim(54);
        ctx.beginPath(); ctx.arc(cx, top + hh * 0.06, 5.5, 0, Math.PI * 2); ctx.fill();
      }
      rimlight((c) => { c.moveTo(cx - bw * 1.06, hb - 6); c.bezierCurveTo(cx - bw * 1.08, top + hh * 0.14, cx - bw * 0.3, top + hh * 0.02, cx, top + hh * 0.02); });
      break;
    }
    case 7: {   // 깃털 관
      const top = crown - hh * 0.02;
      const p = (c) => {
        c.beginPath();
        c.moveTo(cx - bw * 0.94, band + 8);
        c.lineTo(cx - bw * 0.86, top);
        c.lineTo(cx + bw * 0.86, top);
        c.lineTo(cx + bw * 0.94, band + 8);
        c.closePath();
      };
      dropShadow(p);
      // 꿩깃
      for (let i = 0; i < 3; i++) {
        const pts = qpts(cx + bw * 0.70, top + 6,
          cx + bw * (1.5 + i * 0.14), crown - hh * (0.32 + i * 0.05),
          cx + bw * (1.10 + i * 0.16), crown - hh * (0.76 + i * 0.06));
        brush(ctx, pts, 5.5, 0.8, ['#eae2cc', '#c8bfa8', '#a89f8a'][i], 0.94);
      }
      ctx.fillStyle = grad(cx - bw, top, cx + bw, band, '#38352d', '#25231c', '#141209');
      p(ctx); ctx.fill();
      ctx.fillStyle = f.trim(); ctx.fillRect(cx - bw * 1.0, band + 2, bw * 2.0, 5);
      rimlight((c) => { c.moveTo(cx - bw * 0.90, band + 4); c.lineTo(cx - bw * 0.84, top + 2); c.lineTo(cx + bw * 0.3, top + 2); });
      break;
    }
    default: {  // 망건
      ctx.fillStyle = grad(cx - bw, band, cx + bw, band + 18, shadeHex(f.hair, 6), shadeHex(f.hair, -14), shadeHex(f.hair, -30));
      ctx.beginPath();
      ctx.moveTo(cx - bw * 0.99, band + 10);
      ctx.quadraticCurveTo(cx, band - 7, cx + bw * 0.99, band + 10);
      ctx.lineTo(cx + bw * 0.97, band + 19);
      ctx.quadraticCurveTo(cx, band + 4, cx - bw * 0.97, band + 19);
      ctx.closePath(); ctx.fill();
      soft(ctx, 2, 'lighter', 0.18, (c) => {
        c.strokeStyle = '#8a7a60'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(cx - bw * 0.9, band + 7); c.quadraticCurveTo(cx, band - 5, cx + bw * 0.9, band + 7); c.stroke();
      });
      break;
    }
  }
}

// ── 마무리 ──
function finish(ctx, f, G, o) {
  const { cx, cy, hw, hh, chinY } = G;

  // 좌측 역광 — 얼굴 안쪽만
  ctx.save();
  facePath(ctx, f, G);
  ctx.clip();
  soft(ctx, 6, 'lighter', 0.30, (c) => {
    c.fillStyle = '#5f4a30';
    c.beginPath();
    c.moveTo(cx - hw * 1.02, cy - hh * 0.4);
    c.quadraticCurveTo(cx - hw * 1.06, cy + hh * 0.4, cx - hw * 0.55, chinY - hh * 0.06);
    c.lineTo(cx - hw * 0.78, chinY - hh * 0.12);
    c.quadraticCurveTo(cx - hw * 0.92, cy + hh * 0.3, cx - hw * 0.88, cy - hh * 0.4);
    c.closePath(); c.fill();
  });
  ctx.restore();

  // 윤곽 먹선 (아래턱만 은근히)
  soft(ctx, 1.2, 'multiply', 0.30, (c) => {
    const jw = hw * f.jaw;
    c.strokeStyle = '#3a2414'; c.lineWidth = 2;
    c.beginPath();
    c.moveTo(cx - hw * 0.99, cy - hh * 0.06);
    c.bezierCurveTo(cx - hw * 1.02 * f.cheekbone, cy + hh * 0.24,
      cx - jw * 0.92, cy + hh * 0.60, cx - jw * 0.44, chinY - hh * 0.14);
    c.bezierCurveTo(cx - jw * 0.22, chinY + hh * 0.04, cx + jw * 0.22, chinY + hh * 0.04,
      cx + jw * 0.44, chinY - hh * 0.14);
    c.bezierCurveTo(cx + jw * 0.92, cy + hh * 0.60,
      cx + hw * 1.02 * f.cheekbone, cy + hh * 0.24, cx + hw * 0.99, cy - hh * 0.06);
    c.stroke();
  });

  // 전체 색조 통일
  ctx.save();
  ctx.globalCompositeOperation = 'soft-light';
  ctx.globalAlpha = 0.24;
  const tg = ctx.createLinearGradient(0, 0, 0, DH);
  tg.addColorStop(0, '#ffd9a0');
  tg.addColorStop(1, '#2a3a5a');
  ctx.fillStyle = tg; ctx.fillRect(0, 0, DW, DH);
  ctx.restore();

  // 비네트
  const vg = ctx.createRadialGradient(DW / 2, DH * 0.40, DW * 0.26, DW / 2, DH * 0.46, DW * 0.80);
  vg.addColorStop(0, 'transparent');
  vg.addColorStop(1, 'rgba(0,0,0,.55)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, DW, DH);

  // 종이 결
  grain(ctx, DW, DH, 0.055);

  // 낙관
  ctx.save();
  ctx.globalAlpha = 0.62;
  ctx.fillStyle = '#a63428';
  const sx = DW - 34, sy = DH - 40;
  roundRectPath(ctx, sx, sy, 24, 24, 2); ctx.fill();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.font = '700 15px "Noto Serif KR",serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText((o.hanja || o.name || '將')[0], sx + 12, sy + 13);
  ctx.restore();

  // 금테
  ctx.strokeStyle = 'rgba(201,163,73,.32)';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(2.5, 2.5, DW - 5, DH - 5);
  ctx.strokeStyle = 'rgba(0,0,0,.5)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, DW - 1, DH - 1);
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function shadeHex(hex, amt) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  const c = [1, 2, 3].map(i => Math.max(0, Math.min(255, parseInt(m[i], 16) + amt)));
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
}
