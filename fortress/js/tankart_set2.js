'use strict';
/* tankart_set2.js — 전차 아트 8종
 * 하베스터 / 라이노 / 제피르 / 볼케이노 / 글레이셔 / 미라주 / 템페스트 / 오베론
 */
(() => {
  const A = TankArt;
  const P = (s) => (s.dead ? A.deadPal(s.p) : s.p);

  /* ═══════════ 하베스터 — 회전 드릴 헤드 ═══════════ */
  A.register('harvester', {
    pivot: [-4, -24], barrelLen: 22,
    draw(ctx, s) {
      const p = P(s);
      A.tracks(ctx, { p, w: 48, h: 15, roll: s.roll, wheels: 5, links: 7 });
      // 산업용 차체
      A.plate(ctx, [[-23, -14], [-23, -25], [8, -25], [16, -19], [16, -14]], { p });
      // 노란 경고 줄무늬 띠
      ctx.save();
      ctx.beginPath(); A.rr(ctx, -21, -24, 26, 5, 1); ctx.clip();
      ctx.fillStyle = '#141416'; ctx.fillRect(-21, -24, 26, 5);
      ctx.fillStyle = '#f0c419';
      for (let x = -23; x < 8; x += 7) { ctx.beginPath(); ctx.moveTo(x, -19); ctx.lineTo(x + 3.5, -24); ctx.lineTo(x + 7, -24); ctx.lineTo(x + 3.5, -19); ctx.closePath(); ctx.fill(); }
      ctx.restore();
      // 측면 컨베이어
      ctx.save();
      ctx.strokeStyle = p.steelDark; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-20, -17); ctx.lineTo(12, -17); ctx.stroke();
      ctx.strokeStyle = p.hi; ctx.lineWidth = 1;
      const off = ((-s.roll * 0.5) % 5 + 5) % 5;
      for (let x = -20 + off; x < 12; x += 5) { ctx.beginPath(); ctx.moveTo(x, -19); ctx.lineTo(x, -15); ctx.stroke(); }
      ctx.restore();
      // 드릴 헤드 (회전)
      ctx.save();
      ctx.translate(20, -15);
      const spin = s.dead ? 0 : s.t * 6;
      A.plate(ctx, [[-4, -8], [7, -1], [-4, 6]], { p, fill: p.steel });
      ctx.strokeStyle = p.accent; ctx.lineWidth = 1.8;
      for (let i = 0; i < 4; i++) {
        const ph = spin + i * 1.57;
        const k = (Math.sin(ph) + 1) / 2;
        ctx.beginPath();
        ctx.moveTo(-4 + i * 2.4, -7 + i * 1.6 + k * 1.4);
        ctx.lineTo(-4 + i * 2.4, 5 - i * 1.6 - k * 1.4);
        ctx.stroke();
      }
      ctx.fillStyle = p.hi;
      ctx.beginPath(); ctx.arc(7, -1, 1.6, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      // 포탑 (크레인형)
      A.plate(ctx, [[-14, -25], [-11, -31], [3, -31], [6, -25]],
        { p, fill: A.metal(ctx, -31, -25, p, { top: p.accentHi, sheen: p.accent, mid: p.accent, bot: p.accentDim }) });
      A.light(ctx, -12, -33, 1.6, '#ffb020', s.t, 6);
      A.rivets(ctx, [[-20, -16], [-20, -22], [12, -16]], p, 1.2);
      A.soot(ctx, s.hpFrac, 9);
    },
    barrel(ctx, s) {
      const p = P(s);
      const L = s.len || 22;
      A.box(ctx, -3, -3.2, L, 6.4, 2, { p, fill: p.steel });
      // 나선 홈
      ctx.save();
      ctx.strokeStyle = p.deep; ctx.lineWidth = 1.2;
      for (let x = 0; x < L - 2; x += 4) {
        ctx.beginPath(); ctx.moveTo(x, -3); ctx.lineTo(x + 2.5, 3); ctx.stroke();
      }
      ctx.restore();
      A.plate(ctx, [[L - 3, -4.4], [L + 6, 0], [L - 3, 4.4]], { p, fill: p.hi });
    },
  });

  /* ═══════════ 라이노 — 전면 뿔 + 두꺼운 장갑 ═══════════ */
  A.register('rhino', {
    pivot: [-4, -26], barrelLen: 22,
    draw(ctx, s) {
      const p = P(s);
      A.tracks(ctx, { p, w: 50, h: 16, roll: s.roll, wheels: 6, links: 7, skirt: true });
      A.plate(ctx, [[-23, -15], [-23, -26], [8, -26], [21, -19], [21, -15]], { p });
      // 두꺼운 전면 장갑판
      A.plate(ctx, [[13, -25], [22, -19], [22, -13], [13, -13]], { p, fill: p.dark });
      A.rivets(ctx, [[16, -16], [16, -21], [20, -18]], p, 1.4);
      // 뿔
      ctx.save();
      ctx.fillStyle = '#ddd6c4';
      ctx.beginPath();
      ctx.moveTo(19, -22);
      ctx.quadraticCurveTo(28, -25, 26, -33);
      ctx.quadraticCurveTo(24, -27, 17, -25);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#9a9078'; ctx.lineWidth = 1; ctx.stroke();
      ctx.restore();
      A.vent(ctx, -20, -24, 11, 5, 5, p);
      A.panelLine(ctx, -4, -26, -4, -15, p);
      // 낮고 넓은 포탑
      A.plate(ctx, [[-14, -26], [-12, -32], [4, -32], [8, -26]],
        { p, fill: A.metal(ctx, -32, -26, p, { top: p.accentHi, sheen: p.accent, mid: p.accent, bot: p.accentDim }) });
      A.light(ctx, 5, -29, 1.5, p.glow, s.t, 2.2);
      A.soot(ctx, s.hpFrac, 10);
    },
    barrel(ctx, s) { A.barrelStd(ctx, s, { thick: 6.8, rings: 1, muzzle: 'big' }); },
  });

  /* ═══════════ 제피르 — 큰 바퀴 4개 ═══════════ */
  A.register('zephyr', {
    pivot: [2, -19], barrelLen: 29,
    draw(ctx, s) {
      const p = P(s);
      A.roadWheels(ctx, { p, w: 44, n: 4, r: 7, roll: s.roll });
      // 노출 서스펜션
      ctx.save();
      ctx.strokeStyle = p.steelDark; ctx.lineWidth = 2;
      for (const x of [-16, -5, 6, 17]) { ctx.beginPath(); ctx.moveTo(x, -7); ctx.lineTo(x * 0.75, -13); ctx.stroke(); }
      ctx.strokeStyle = p.accent; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(-18, -13); ctx.lineTo(18, -13); ctx.stroke();
      ctx.restore();
      // 가벼운 프레임 차체
      A.plate(ctx, [[-20, -12], [-17, -19], [8, -20], [19, -14], [19, -12]], { p });
      A.panelLine(ctx, -8, -19, -8, -12, p);
      // 개방형 조종석
      A.canopy(ctx, -2, -24, 10, 5, p);
      A.plate(ctx, [[-14, -20], [-11, -24], [-3, -24], [-1, -20]], { p, fill: p.accent });
      A.vent(ctx, 9, -18, 8, 4, 4, p);
      if (!s.dead) { A.antenna(ctx, -18, -19, 20, s.t, p); A.antenna(ctx, -15, -19, 13, s.t + 1, p); }
      A.light(ctx, 15, -17, 1.4, p.glow, s.t, 4);
      A.soot(ctx, s.hpFrac, 11);
    },
    barrel(ctx, s) { A.barrelStd(ctx, s, { thick: 3.4, rings: 2, muzzle: 'small' }); },
  });

  /* ═══════════ 볼케이노 — 위를 향한 분화구 박격포 ═══════════ */
  A.register('volcano', {
    pivot: [-1, -24], barrelLen: 20,
    draw(ctx, s) {
      const p = P(s);
      A.tracks(ctx, { p, w: 46, h: 14, roll: s.roll, wheels: 5, links: 6 });
      A.plate(ctx, [[-22, -13], [-22, -23], [10, -23], [20, -17], [20, -13]], { p });
      // 붉게 달아오른 틈새
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const glow = s.dead ? 0.12 : 0.45 + Math.sin(s.t * 2.4) * 0.22;
      for (const [x0, y0, x1, y1] of [[-18, -20, -6, -18], [2, -21, 12, -19], [-14, -16, -2, -15]]) {
        const g = ctx.createLinearGradient(x0, y0, x1, y1);
        g.addColorStop(0, `rgba(255,90,20,${glow})`);
        g.addColorStop(0.5, `rgba(255,190,80,${glow})`);
        g.addColorStop(1, `rgba(255,80,10,${glow * 0.4})`);
        ctx.strokeStyle = g; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
      ctx.restore();
      // 냉각 핀
      A.vent(ctx, 12, -22, 7, 5, 4, p);
      // 분화구 받침
      A.plate(ctx, [[-13, -23], [-11, -29], [9, -29], [11, -23]],
        { p, fill: A.metal(ctx, -29, -23, p, { top: p.accentHi, sheen: p.accent, mid: p.accent, bot: p.accentDim }) });
      A.rivets(ctx, [[-19, -15], [-19, -21], [16, -15]], p, 1.2);
      A.soot(ctx, s.hpFrac, 12);
    },
    barrel(ctx, s) {
      const p = P(s);
      const L = s.len || 20;
      // 넓은 주둥이의 박격포
      A.plate(ctx, [[-4, -5], [L - 5, -8.5], [L + 1, -10], [L + 1, 10], [L - 5, 8.5], [-4, 5]],
        { p, fill: A.metal(ctx, -10, 10, p, { top: p.hi, sheen: p.steel, mid: p.mid, bot: p.deep }) });
      ctx.fillStyle = '#1a0f0a';
      ctx.beginPath(); ctx.ellipse(L + 1, 0, 2.2, 9, 0, 0, Math.PI * 2); ctx.fill();
      const heat = 0.3 + (s.charge || 0) * 0.7;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(L, 0, 1, L, 0, 14);
      g.addColorStop(0, `rgba(255,170,60,${heat})`);
      g.addColorStop(1, 'rgba(255,60,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(L, 0, 14, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    },
  });

  /* ═══════════ 글레이셔 — 얼음 결정 장갑 ═══════════ */
  A.register('glacier', {
    pivot: [0, -24], barrelLen: 26,
    draw(ctx, s) {
      const p = P(s);
      A.tracks(ctx, { p, w: 48, h: 14, roll: s.roll, wheels: 5, links: 6 });
      A.plate(ctx, [[-23, -13], [-19, -24], [11, -24], [21, -16], [21, -13]], { p });
      // 반투명 결정 패널
      ctx.save();
      ctx.globalAlpha = 0.55;
      for (const pts of [
        [[-17, -23], [-9, -25], [-6, -19], [-14, -17]],
        [[-4, -24], [5, -25], [8, -18], [-2, -17]],
        [[10, -23], [18, -18], [15, -14], [8, -17]],
      ]) {
        A.plate(ctx, pts, { p, fill: '#bfe8ff', stroke: '#7fc4e8', sheen: false, lw: 1 });
      }
      ctx.restore();
      // 냉각 파이프
      ctx.save();
      ctx.strokeStyle = p.steel; ctx.lineWidth = 2.2; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-21, -19); ctx.lineTo(-15, -19); ctx.lineTo(-15, -15); ctx.lineTo(-8, -15);
      ctx.stroke();
      ctx.strokeStyle = '#dff2ff'; ctx.lineWidth = 0.9;
      ctx.stroke();
      ctx.restore();
      // 결정 포탑
      A.plate(ctx, [[-13, -24], [-8, -32], [6, -33], [12, -25], [12, -24]],
        { p, fill: A.metal(ctx, -33, -24, p, { top: p.accentHi, sheen: p.accent, mid: p.accent, bot: p.accentDim }) });
      // 서리 결정 돌기
      ctx.save();
      ctx.fillStyle = 'rgba(215,242,255,0.9)';
      for (const [x, y, h] of [[-6, -33, 6], [1, -34, 8], [7, -31, 5]]) {
        ctx.beginPath(); ctx.moveTo(x - 2, y); ctx.lineTo(x, y - h); ctx.lineTo(x + 2, y); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      A.light(ctx, 9, -28, 1.6, '#9fe8ff', s.t, 2);
      A.soot(ctx, s.hpFrac, 13);
    },
    barrel(ctx, s) {
      const p = P(s);
      const L = s.len || 26;
      A.box(ctx, -3, -2.8, L + 3, 5.6, 2, { p, fill: p.steel });
      A.box(ctx, L - 7, -4.2, 7, 8.4, 1.6, { p, fill: '#a8d8f0', sheen: true });
      ctx.fillStyle = 'rgba(200,240,255,0.85)';
      for (const x of [L * 0.4, L * 0.65]) {
        ctx.beginPath(); ctx.moveTo(x, -4.6); ctx.lineTo(x + 2, -2.8); ctx.lineTo(x - 2, -2.8); ctx.closePath(); ctx.fill();
      }
      if (s.charge > 0.02) A.light(ctx, L + 3, 0, 2 + s.charge * 4, '#a8e8ff', s.t, 10);
    },
  });

  /* ═══════════ 미라주 — 평면 스텔스 ═══════════ */
  A.register('mirage', {
    pivot: [3, -17], barrelLen: 29,
    draw(ctx, s) {
      const p = P(s);
      A.tracks(ctx, { p, w: 44, h: 8, roll: s.roll, wheels: 6, links: 4, skirt: true });
      // 각진 평면들 — 무광
      A.plate(ctx, [[-24, -11], [-19, -17], [4, -18], [24, -12], [24, -11]],
        { p, fill: p.mid, sheen: false });
      A.plate(ctx, [[-19, -17], [4, -18], [1, -21], [-13, -20]],
        { p, fill: p.dark, sheen: false });
      A.plate(ctx, [[4, -18], [24, -12], [16, -12], [2, -16]],
        { p, fill: p.base, sheen: false });
      // 낮은 각진 포탑
      A.plate(ctx, [[-9, -20], [-5, -24], [8, -23], [13, -18], [-3, -18]],
        { p, fill: p.accentDim, sheen: false });
      A.plate(ctx, [[-5, -24], [8, -23], [5, -21], [-3, -21]],
        { p, fill: p.accent, sheen: false });
      // 스텔스 패널 라인
      A.panelLine(ctx, -14, -19, 2, -16, p);
      A.panelLine(ctx, 6, -17, 20, -13, p);
      // 은신 시머
      if (!s.dead) {
        ctx.save();
        ctx.globalAlpha = 0.12 + Math.sin(s.t * 1.5) * 0.08;
        ctx.fillStyle = '#9fd8ff';
        A.poly(ctx, [[-24, -11], [-19, -17], [4, -18], [24, -12], [24, -11]]);
        ctx.fill();
        ctx.restore();
      }
      A.light(ctx, 11, -20, 1.2, '#6affc4', s.t, 1.6);
      A.soot(ctx, s.hpFrac, 14);
    },
    barrel(ctx, s) { A.barrelStd(ctx, s, { thick: 3.6, rings: 0, muzzle: 'small' }); },
  });

  /* ═══════════ 템페스트 — 다연장 로켓 포드 ═══════════ */
  A.register('tempest', {
    pivot: [-2, -23], barrelLen: 24,
    draw(ctx, s) {
      const p = P(s);
      A.tracks(ctx, { p, w: 46, h: 13, roll: s.roll, wheels: 5, links: 6 });
      A.plate(ctx, [[-22, -12], [-22, -22], [10, -22], [20, -16], [20, -12]], { p });
      A.vent(ctx, 11, -21, 8, 5, 4, p);
      A.panelLine(ctx, -6, -22, -6, -12, p);
      // 작은 조준 포탑
      A.plate(ctx, [[6, -22], [8, -27], [16, -27], [18, -22]], { p, fill: p.dark });
      A.canopy(ctx, 9, -26, 7, 3.2, p);
      // 로켓 포드 격자 (뒤쪽 상단)
      const px = -21, py = -32, cw = 5.4, ch = 4.6;
      A.box(ctx, px - 1.5, py - 1.5, cw * 4 + 3, ch * 2 + 3, 2, { p, fill: p.accentDim });
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 4; c++) {
          const x = px + c * cw, y = py + r * ch;
          ctx.fillStyle = p.deep;
          ctx.beginPath(); ctx.ellipse(x + cw / 2, y + ch / 2, cw * 0.36, ch * 0.36, 0, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = p.hi; ctx.lineWidth = 0.7; ctx.stroke();
        }
      }
      // 포드 지지대
      ctx.strokeStyle = p.steelDark; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(-14, -22); ctx.lineTo(-12, -28); ctx.stroke();
      A.light(ctx, -22, -34, 1.4, '#ff7b3d', s.t, 5);
      A.rivets(ctx, [[-19, -14], [-19, -20], [16, -14]], p, 1.1);
      A.soot(ctx, s.hpFrac, 15);
    },
    barrel(ctx, s) {
      const p = P(s);
      const L = s.len || 24;
      // 로켓 레일 런처
      A.box(ctx, -3, -4.6, L + 3, 3.4, 1.2, { p, fill: p.mid });
      A.box(ctx, -3, 1.2, L + 3, 3.4, 1.2, { p, fill: p.mid });
      ctx.strokeStyle = p.steelDark; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(2, 0); ctx.lineTo(L, 0); ctx.stroke();
      // 장전된 로켓
      A.plate(ctx, [[L - 12, -2], [L - 1, -2], [L + 3, 0], [L - 1, 2], [L - 12, 2]],
        { p, fill: s.charge > 0.02 ? '#ffb347' : p.accent, sheen: false });
    },
  });

  /* ═══════════ 오베론 — 왕관 포탑 ═══════════ */
  A.register('oberon', {
    pivot: [-1, -27], barrelLen: 26,
    draw(ctx, s) {
      const p = P(s);
      A.tracks(ctx, { p, w: 52, h: 16, roll: s.roll, wheels: 6, links: 7, skirt: true });
      A.plate(ctx, [[-24, -15], [-24, -26], [12, -26], [22, -19], [22, -15]], { p });
      // 황동 장식 띠
      ctx.save();
      ctx.strokeStyle = '#d8a840'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-22, -21); ctx.lineTo(18, -21); ctx.stroke();
      ctx.fillStyle = '#e8c46a';
      for (let x = -18; x < 18; x += 9) {
        ctx.beginPath();
        ctx.moveTo(x, -23); ctx.lineTo(x + 3, -21); ctx.lineTo(x, -19); ctx.lineTo(x - 3, -21);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      A.vent(ctx, -21, -25, 10, 4, 5, p);
      // 포탑
      A.plate(ctx, [[-15, -26], [-12, -34], [8, -34], [13, -27], [13, -26]],
        { p, fill: A.metal(ctx, -34, -26, p, { top: p.accentHi, sheen: p.accent, mid: p.accent, bot: p.accentDim }) });
      // 왕관
      ctx.save();
      ctx.fillStyle = s.dead ? '#6a6552' : '#f0cf72';
      ctx.beginPath();
      ctx.moveTo(-12, -34);
      for (let i = 0; i < 5; i++) {
        const x = -12 + i * 5;
        ctx.lineTo(x + 2.5, -40);
        ctx.lineTo(x + 5, -34);
      }
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#a8842e'; ctx.lineWidth = 0.9; ctx.stroke();
      ctx.fillStyle = s.dead ? '#5a5548' : p.accent;
      for (let i = 0; i < 5; i++) {
        ctx.beginPath(); ctx.arc(-9.5 + i * 5, -39, 1.3, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      A.rivets(ctx, [[-21, -17], [-14, -24], [18, -17], [18, -22]], p, 1.3);
      A.soot(ctx, s.hpFrac, 16);
    },
    barrel(ctx, s) {
      const p = P(s);
      A.barrelStd(ctx, s, { thick: 6, rings: 3, muzzle: 'big' });
      // 황동 링
      const L = s.len || 26;
      ctx.strokeStyle = '#e0b455'; ctx.lineWidth = 1.4;
      for (const k of [0.24, 0.5, 0.76]) {
        ctx.beginPath(); ctx.moveTo(L * k, -3.4); ctx.lineTo(L * k, 3.4); ctx.stroke();
      }
    },
  });
})();
