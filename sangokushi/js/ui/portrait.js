// ============================================================
//  초상화 절차 생성 — 무장마다 다른 얼굴을 그린다
//  외부 이미지 없이 캔버스로 수묵채색풍 인물을 합성한다.
// ============================================================
import { mulberry32 } from '../core/rng.js';

const SKINS = ['#e8c39a', '#dcb187', '#c99a6f', '#b98a63', '#efd0ab'];
const HAIRS = ['#241c17', '#332620', '#1b1512', '#4a3a2c', '#6b6157', '#8d8880'];

const cache = new Map();

/** 무장 초상화를 캔버스로 반환 (캐시됨) */
export function portraitCanvas(officer, size = 120) {
  const key = officer.id + ':' + size;
  if (cache.has(key)) return cache.get(key);
  const cv = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = size * dpr; cv.height = Math.round(size * 1.25 * dpr);
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  drawPortrait(ctx, officer, size, size * 1.25);
  if (cache.size > 400) cache.clear();
  cache.set(key, cv);
  return cv;
}

export function clearPortraitCache() { cache.clear(); }

export function drawPortrait(ctx, o, W, H) {
  const a = o.appearance || { seed: 1, face: 0, eyes: 0, brow: 0, nose: 0, mouth: 0, beard: 0, hat: 0, skin: 0, scar: 0, hue: 30, sat: 40 };
  const rnd = mulberry32(a.seed >>> 0);
  const S = W / 120;                 // 기준 120px 도안
  ctx.save();
  ctx.scale(S, S);
  const w = 120, h = H / S;

  // ── 배경 ──
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  const bh = (a.hue + 180) % 360;
  bg.addColorStop(0, `hsl(${bh} 18% 22%)`);
  bg.addColorStop(1, `hsl(${bh} 22% 12%)`);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  // 후광
  const halo = ctx.createRadialGradient(60, 58, 6, 60, 58, 62);
  halo.addColorStop(0, `hsl(${a.hue} ${a.sat}% 40% / .45)`);
  halo.addColorStop(1, 'transparent');
  ctx.fillStyle = halo; ctx.fillRect(0, 0, w, h);
  // 종이결
  ctx.globalAlpha = 0.06;
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = rnd() > 0.5 ? '#fff' : '#000';
    ctx.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 2, 1);
  }
  ctx.globalAlpha = 1;

  const skin = SKINS[a.skin % SKINS.length];
  const hair = HAIRS[(a.seed >> 3) % HAIRS.length];
  const cloth = `hsl(${a.hue} ${a.sat}% 34%)`;
  const cloth2 = `hsl(${a.hue} ${a.sat}% 24%)`;
  const trim = `hsl(${(a.hue + 40) % 360} ${Math.min(80, a.sat + 25)}% 52%)`;

  // ── 몸통 / 의복 ──
  ctx.fillStyle = cloth;
  ctx.beginPath();
  ctx.moveTo(10, h);
  ctx.quadraticCurveTo(20, h - 46, 46, h - 54);
  ctx.lineTo(74, h - 54);
  ctx.quadraticCurveTo(100, h - 46, 110, h);
  ctx.closePath(); ctx.fill();
  // 갑옷 어깨
  const armored = a.hat >= 5 || o.war > 68;
  if (armored) {
    ctx.fillStyle = cloth2;
    for (const sx of [26, 94]) {
      ctx.beginPath(); ctx.ellipse(sx, h - 42, 17, 12, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = trim; ctx.lineWidth = 1.4; ctx.stroke();
      // 비늘
      ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 0.8;
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath(); ctx.arc(sx + i * 5, h - 40, 3.4, Math.PI, 0); ctx.stroke();
      }
    }
  }
  // 옷깃 (교차)
  ctx.fillStyle = cloth2;
  ctx.beginPath();
  ctx.moveTo(60, h - 52); ctx.lineTo(44, h - 20); ctx.lineTo(60, h - 26); ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(60, h - 52); ctx.lineTo(76, h - 20); ctx.lineTo(60, h - 26); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = trim; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(46, h - 50); ctx.lineTo(60, h - 27); ctx.lineTo(74, h - 50); ctx.stroke();

  // ── 목 ──
  ctx.fillStyle = shade(skin, -18);
  ctx.fillRect(50, h - 66, 20, 16);

  // ── 얼굴 ──
  const faceW = [22, 24, 21, 25, 23, 20][a.face % 6];
  const faceH = [29, 27, 31, 28, 30, 32][a.face % 6];
  const cxF = 60, cyF = 52;
  ctx.fillStyle = skin;
  ctx.beginPath();
  // 턱이 조금씩 다른 얼굴형
  ctx.moveTo(cxF - faceW, cyF - 4);
  ctx.bezierCurveTo(cxF - faceW, cyF + faceH * 0.75, cxF - faceW * 0.5, cyF + faceH, cxF, cyF + faceH);
  ctx.bezierCurveTo(cxF + faceW * 0.5, cyF + faceH, cxF + faceW, cyF + faceH * 0.75, cxF + faceW, cyF - 4);
  ctx.bezierCurveTo(cxF + faceW, cyF - faceH * 0.95, cxF - faceW, cyF - faceH * 0.95, cxF - faceW, cyF - 4);
  ctx.closePath(); ctx.fill();
  // 명암
  const sh = ctx.createLinearGradient(cxF - faceW, 0, cxF + faceW, 0);
  sh.addColorStop(0, 'rgba(0,0,0,.20)');
  sh.addColorStop(0.42, 'rgba(0,0,0,0)');
  sh.addColorStop(1, 'rgba(255,255,255,.10)');
  ctx.fillStyle = sh; ctx.fill();

  // 귀
  ctx.fillStyle = shade(skin, -8);
  ctx.beginPath(); ctx.ellipse(cxF - faceW - 1, cyF + 4, 3.4, 6.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(cxF + faceW + 1, cyF + 4, 3.4, 6.5, 0, 0, Math.PI * 2); ctx.fill();

  // ── 머리카락 ──
  ctx.fillStyle = hair;
  ctx.beginPath();
  ctx.moveTo(cxF - faceW - 1, cyF - 6);
  ctx.bezierCurveTo(cxF - faceW - 2, cyF - faceH, cxF + faceW + 2, cyF - faceH, cxF + faceW + 1, cyF - 6);
  ctx.lineTo(cxF + faceW - 2, cyF - 12);
  ctx.bezierCurveTo(cxF + 6, cyF - 22, cxF - 6, cyF - 22, cxF - faceW + 2, cyF - 12);
  ctx.closePath(); ctx.fill();
  // 상투
  if (a.hat < 6) {
    ctx.fillStyle = hair;
    ctx.beginPath(); ctx.ellipse(cxF, cyF - faceH + 2, 6, 7, 0, 0, Math.PI * 2); ctx.fill();
  }

  // ── 눈썹 ──
  ctx.strokeStyle = shade(hair, -10);
  ctx.lineCap = 'round';
  const browTypes = [
    (x, d) => { ctx.lineWidth = 2.4; ctx.beginPath(); ctx.moveTo(x - 7 * d, cyF - 9); ctx.lineTo(x + 6 * d, cyF - 11); ctx.stroke(); },
    (x, d) => { ctx.lineWidth = 3.4; ctx.beginPath(); ctx.moveTo(x - 8 * d, cyF - 8); ctx.quadraticCurveTo(x, cyF - 14, x + 7 * d, cyF - 9); ctx.stroke(); },
    (x, d) => { ctx.lineWidth = 2.0; ctx.beginPath(); ctx.moveTo(x - 7 * d, cyF - 11); ctx.lineTo(x + 6 * d, cyF - 8); ctx.stroke(); },   // 팔자
    (x, d) => { ctx.lineWidth = 4.2; ctx.beginPath(); ctx.moveTo(x - 8 * d, cyF - 9); ctx.lineTo(x + 7 * d, cyF - 12); ctx.stroke(); },   // 와잠
    (x, d) => { ctx.lineWidth = 2.6; ctx.beginPath(); ctx.moveTo(x - 7 * d, cyF - 12); ctx.quadraticCurveTo(x, cyF - 8, x + 6 * d, cyF - 12); ctx.stroke(); },
    (x, d) => { ctx.lineWidth = 3.0; ctx.beginPath(); ctx.moveTo(x - 8 * d, cyF - 7); ctx.lineTo(x + 7 * d, cyF - 13); ctx.stroke(); },   // 검미
  ];
  browTypes[a.brow % 6](cxF - 11, 1);
  ctx.save(); ctx.translate(cxF * 2, 0); ctx.scale(-1, 1);
  browTypes[a.brow % 6](cxF - 11, 1);
  ctx.restore();

  // ── 눈 ──
  const drawEye = (ex, flip) => {
    ctx.save();
    if (flip) { ctx.translate(ex * 2, 0); ctx.scale(-1, 1); }
    const t = a.eyes % 8;
    ctx.fillStyle = '#fbf6ee';
    ctx.strokeStyle = '#20180f'; ctx.lineWidth = 1.3;
    ctx.beginPath();
    if (t === 0) { ctx.ellipse(ex, cyF - 1, 6, 3.4, 0, 0, Math.PI * 2); }
    else if (t === 1) { ctx.ellipse(ex, cyF - 1, 6.5, 2.4, -0.14, 0, Math.PI * 2); }        // 실눈
    else if (t === 2) { ctx.ellipse(ex, cyF - 1, 5.4, 4.2, 0, 0, Math.PI * 2); }            // 큰 눈
    else if (t === 3) { ctx.ellipse(ex, cyF - 1, 7, 2.8, -0.22, 0, Math.PI * 2); }          // 봉안
    else if (t === 4) { ctx.ellipse(ex, cyF - 1, 5.8, 3.0, 0.16, 0, Math.PI * 2); }
    else if (t === 5) { ctx.moveTo(ex - 6, cyF); ctx.quadraticCurveTo(ex, cyF - 6, ex + 6, cyF); ctx.quadraticCurveTo(ex, cyF + 2, ex - 6, cyF); }
    else if (t === 6) { ctx.ellipse(ex, cyF - 1, 6.2, 3.6, -0.3, 0, Math.PI * 2); }
    else { ctx.ellipse(ex, cyF - 1, 4.8, 3.8, 0, 0, Math.PI * 2); }
    ctx.fill(); ctx.stroke();
    // 눈동자
    ctx.fillStyle = '#231a12';
    ctx.beginPath(); ctx.arc(ex + (t === 3 ? 1 : 0), cyF - 1, t === 1 ? 1.6 : 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.beginPath(); ctx.arc(ex - 0.9, cyF - 2.2, 0.8, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  };
  drawEye(cxF - 11, false);
  drawEye(cxF - 11, true);

  // ── 코 ──
  ctx.strokeStyle = shade(skin, -34); ctx.lineWidth = 1.5;
  ctx.beginPath();
  const nt = a.nose % 5;
  if (nt === 0) { ctx.moveTo(cxF - 1, cyF + 2); ctx.lineTo(cxF - 3, cyF + 9); ctx.lineTo(cxF + 2, cyF + 9); }
  else if (nt === 1) { ctx.moveTo(cxF, cyF + 1); ctx.quadraticCurveTo(cxF - 5, cyF + 8, cxF + 3, cyF + 10); }
  else if (nt === 2) { ctx.moveTo(cxF - 1, cyF + 3); ctx.lineTo(cxF - 4, cyF + 11); ctx.lineTo(cxF + 3, cyF + 11); }
  else if (nt === 3) { ctx.moveTo(cxF, cyF + 2); ctx.lineTo(cxF - 2, cyF + 8); ctx.lineTo(cxF + 1, cyF + 8); }
  else { ctx.moveTo(cxF - 2, cyF + 2); ctx.quadraticCurveTo(cxF - 4, cyF + 10, cxF + 4, cyF + 9); }
  ctx.stroke();

  // ── 입 ──
  ctx.strokeStyle = '#7d4238'; ctx.lineWidth = 1.6;
  ctx.beginPath();
  const mt = a.mouth % 5;
  if (mt === 0) { ctx.moveTo(cxF - 6, cyF + 16); ctx.quadraticCurveTo(cxF, cyF + 18, cxF + 6, cyF + 16); }
  else if (mt === 1) { ctx.moveTo(cxF - 5, cyF + 17); ctx.lineTo(cxF + 5, cyF + 17); }
  else if (mt === 2) { ctx.moveTo(cxF - 6, cyF + 17); ctx.quadraticCurveTo(cxF, cyF + 13, cxF + 6, cyF + 17); }  // 굳게 다문
  else if (mt === 3) { ctx.moveTo(cxF - 7, cyF + 16); ctx.quadraticCurveTo(cxF, cyF + 21, cxF + 7, cyF + 16); }
  else { ctx.moveTo(cxF - 4, cyF + 16); ctx.quadraticCurveTo(cxF, cyF + 19, cxF + 4, cyF + 16); }
  ctx.stroke();

  // ── 수염 ──
  if (a.beard > 0) {
    ctx.fillStyle = hair; ctx.strokeStyle = hair; ctx.lineCap = 'round';
    const b = a.beard % 7;
    if (b >= 1) {   // 콧수염
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(cxF - 9, cyF + 13); ctx.quadraticCurveTo(cxF, cyF + 11, cxF + 9, cyF + 13);
      ctx.stroke();
      if (b === 3 || b === 5) {  // 팔자 늘어짐
        ctx.lineWidth = 2.2;
        ctx.beginPath(); ctx.moveTo(cxF - 9, cyF + 13); ctx.quadraticCurveTo(cxF - 12, cyF + 22, cxF - 10, cyF + 28); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cxF + 9, cyF + 13); ctx.quadraticCurveTo(cxF + 12, cyF + 22, cxF + 10, cyF + 28); ctx.stroke();
      }
    }
    if (b >= 2) {   // 턱수염
      ctx.beginPath();
      const len = b >= 4 ? 26 : 12;
      ctx.moveTo(cxF - 9, cyF + 19);
      ctx.quadraticCurveTo(cxF, cyF + 22 + len, cxF + 9, cyF + 19);
      ctx.quadraticCurveTo(cxF, cyF + 26, cxF - 9, cyF + 19);
      ctx.fill();
      if (b === 6) {   // 미염공 — 아주 긴 수염
        ctx.beginPath();
        ctx.moveTo(cxF - 7, cyF + 24);
        ctx.quadraticCurveTo(cxF, cyF + 74, cxF + 7, cyF + 24);
        ctx.fill();
      }
    }
  }

  // ── 흉터 ──
  if (a.scar) {
    ctx.strokeStyle = 'rgba(150,60,50,.75)'; ctx.lineWidth = 1.4;
    ctx.beginPath();
    if (a.scar === 1) { ctx.moveTo(cxF + 12, cyF - 12); ctx.lineTo(cxF + 16, cyF + 6); }
    else if (a.scar === 2) { ctx.moveTo(cxF - 16, cyF - 6); ctx.lineTo(cxF - 8, cyF + 8); }
    else { ctx.moveTo(cxF - 14, cyF + 12); ctx.lineTo(cxF + 6, cyF + 20); }
    ctx.stroke();
  }

  // ── 관 / 투구 / 두건 ──
  drawHeadgear(ctx, a, cxF, cyF, faceW, faceH, cloth2, trim, hair);

  // 외곽 먹선
  ctx.strokeStyle = 'rgba(20,14,8,.55)'; ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(cxF - faceW, cyF - 4);
  ctx.bezierCurveTo(cxF - faceW, cyF + faceH * 0.75, cxF - faceW * 0.5, cyF + faceH, cxF, cyF + faceH);
  ctx.bezierCurveTo(cxF + faceW * 0.5, cyF + faceH, cxF + faceW, cyF + faceH * 0.75, cxF + faceW, cyF - 4);
  ctx.stroke();

  // 비네트
  const vg = ctx.createRadialGradient(60, 60, 30, 60, 60, 90);
  vg.addColorStop(0, 'transparent');
  vg.addColorStop(1, 'rgba(0,0,0,.42)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

function drawHeadgear(ctx, a, cx, cy, fw, fh, cloth, trim, hair) {
  const top = cy - fh + 2;
  switch (a.hat % 9) {
    case 0: break;                                   // 맨머리
    case 1: {                                        // 두건
      ctx.fillStyle = cloth;
      ctx.beginPath();
      ctx.moveTo(cx - fw - 2, cy - 8);
      ctx.quadraticCurveTo(cx, top - 8, cx + fw + 2, cy - 8);
      ctx.lineTo(cx + fw, cy - 13); ctx.quadraticCurveTo(cx, top - 2, cx - fw, cy - 13);
      ctx.closePath(); ctx.fill();
      break;
    }
    case 2: {                                        // 유건(선비 관)
      ctx.fillStyle = '#2c2b28';
      ctx.fillRect(cx - 13, top - 12, 26, 15);
      ctx.fillStyle = '#3a3936';
      ctx.fillRect(cx - 15, top + 1, 30, 4);
      ctx.strokeStyle = trim; ctx.lineWidth = 1; ctx.strokeRect(cx - 13, top - 12, 26, 15);
      break;
    }
    case 3: {                                        // 진현관
      ctx.fillStyle = '#26251f';
      ctx.beginPath();
      ctx.moveTo(cx - 14, top + 3); ctx.lineTo(cx - 10, top - 16);
      ctx.lineTo(cx + 10, top - 16); ctx.lineTo(cx + 14, top + 3);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = trim; ctx.fillRect(cx - 14, top + 1, 28, 3);
      break;
    }
    case 4: {                                        // 관모 + 끈
      ctx.fillStyle = '#31302b';
      ctx.beginPath(); ctx.ellipse(cx, top - 4, 15, 10, 0, Math.PI, 0); ctx.fill();
      ctx.fillRect(cx - 16, top - 4, 32, 4);
      ctx.strokeStyle = trim; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(cx - 15, top); ctx.lineTo(cx - 18, cy + 12); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx + 15, top); ctx.lineTo(cx + 18, cy + 12); ctx.stroke();
      break;
    }
    case 5: {                                        // 투구
      ctx.fillStyle = '#585349';
      ctx.beginPath(); ctx.ellipse(cx, top + 1, fw + 3, 15, 0, Math.PI, 0); ctx.fill();
      ctx.fillStyle = '#6b6558'; ctx.fillRect(cx - fw - 3, top - 1, (fw + 3) * 2, 5);
      ctx.strokeStyle = trim; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(cx, top - 14); ctx.lineTo(cx, top + 2); ctx.stroke();
      // 볼가리개
      ctx.fillStyle = '#4e493f';
      ctx.fillRect(cx - fw - 4, top + 3, 6, 16);
      ctx.fillRect(cx + fw - 2, top + 3, 6, 16);
      break;
    }
    case 6: {                                        // 투구 + 붉은 술
      ctx.fillStyle = '#4d4a42';
      ctx.beginPath(); ctx.ellipse(cx, top + 1, fw + 3, 16, 0, Math.PI, 0); ctx.fill();
      ctx.fillStyle = '#8f8272'; ctx.fillRect(cx - fw - 3, top - 1, (fw + 3) * 2, 5);
      ctx.fillStyle = '#b0402f';
      ctx.beginPath(); ctx.moveTo(cx - 4, top - 15); ctx.lineTo(cx + 4, top - 15);
      ctx.lineTo(cx + 8, top - 30); ctx.lineTo(cx - 8, top - 30); ctx.closePath(); ctx.fill();
      break;
    }
    case 7: {                                        // 깃털 관
      ctx.fillStyle = '#2f2e29';
      ctx.fillRect(cx - 12, top - 10, 24, 13);
      ctx.strokeStyle = '#d8d2c4'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx + 10, top - 8); ctx.quadraticCurveTo(cx + 26, top - 24, cx + 20, top - 34); ctx.stroke();
      break;
    }
    default: {                                       // 망건
      ctx.fillStyle = shade(hair, -12);
      ctx.fillRect(cx - fw - 1, top + 4, (fw + 1) * 2, 6);
      break;
    }
  }
}

function shade(hex, amt) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  const c = [1, 2, 3].map(i => Math.max(0, Math.min(255, parseInt(m[i], 16) + amt)));
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
}
