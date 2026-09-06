'use strict';
/* tankart_set3.js — 전차 아트 8종
 * 노바 / 크라켄 / 세이버 / 아이언벅 / 워든 / 페가수스 / 리바이어던 / 스팅어
 */
(() => {
  const A = TankArt;
  const P = (s) => (s.dead ? A.deadPal(s.p) : s.p);

  /* ═══════════ 노바 — 구형 에너지 코어 + 회전 링 ═══════════ */
  A.register('nova', {
    pivot: [0, -23], barrelLen: 25,
    draw(ctx, s) {
      const p = P(s);
      A.tracks(ctx, { p, w: 46, h: 12, roll: s.roll, wheels: 5, links: 5, skirt: true });
      // 매끈한 유선형 차체
      A.plate(ctx, [[-22, -12], [-18, -20], [8, -21], [21, -14], [21, -12]], { p });
      A.panelLine(ctx, -8, -20, -8, -12, p);
      A.panelLine(ctx, 4, -21, 4, -12, p);
      A.vent(ctx, -19, -19, 9, 4, 5, p);
      // 코어 구체
      const pulse = s.dead ? 0.1 : 0.55 + Math.sin(s.t * 3) * 0.3;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(0, -23, 0, 0, -23, 16);
      g.addColorStop(0, `rgba(255,240,200,${0.9 * pulse})`);
      g.addColorStop(0.4, `rgba(255,170,90,${0.45 * pulse})`);
      g.addColorStop(1, 'rgba(255,110,40,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, -23, 16, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      const cg = ctx.createRadialGradient(-2, -25, 1, 0, -23, 8);
      cg.addColorStop(0, s.dead ? '#5a5a60' : '#fff6d8');
      cg.addColorStop(1, s.dead ? '#33343a' : p.accent);
      ctx.fillStyle = cg;
      ctx.beginPath(); ctx.arc(0, -23, 8, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = p.edge; ctx.lineWidth = 1; ctx.stroke();
      // 회전하는 링 2개
      ctx.save();
      ctx.translate(0, -23);
      for (let i = 0; i < 2; i++) {
        const rot = s.dead ? 0.4 * i : s.t * (i ? -1.1 : 1.6) + i * 1.2;
        ctx.save();
        ctx.rotate(rot);
        ctx.strokeStyle = i ? p.steel : p.accentHi;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(0, 0, 13 - i * 2, 4.5, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = p.hi;
        ctx.beginPath(); ctx.arc(13 - i * 2, 0, 1.4, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      ctx.restore();
      // 코어 지지대
      A.box(ctx, -9, -21, 18, 4, 1.6, { p, fill: p.dark });
      A.soot(ctx, s.hpFrac, 17);
    },
    barrel(ctx, s) {
      const p = P(s);
      const L = s.len || 25;
      A.box(ctx, -3, -2.4, L, 4.8, 2.2, { p, fill: p.steel });
      // 에너지 방출구 — 갈라진 발톱 형태
      A.plate(ctx, [[L - 4, -5.5], [L + 5, -2.5], [L + 5, -1], [L - 4, -1]], { p, fill: p.accentDim, sheen: false });
      A.plate(ctx, [[L - 4, 5.5], [L + 5, 2.5], [L + 5, 1], [L - 4, 1]], { p, fill: p.accentDim, sheen: false });
      const a = 0.3 + (s.charge || 0) * 0.7;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(L + 3, 0, 0, L + 3, 0, 9 + (s.charge || 0) * 9);
      g.addColorStop(0, `rgba(255,236,190,${a})`);
      g.addColorStop(1, 'rgba(255,140,40,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(L + 3, 0, 9 + (s.charge || 0) * 9, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    },
  });

  /* ═══════════ 크라켄 — 다관절 팔 ═══════════ */
  A.register('kraken', {
    pivot: [-2, -25], barrelLen: 24,
    draw(ctx, s) {
      const p = P(s);
      // 촉수 (뒤쪽 — 차체보다 먼저)
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (let i = 0; i < 3; i++) {
        const ph = s.dead ? 0 : s.t * 1.3 + i * 2.1;
        const bx = -14 + i * 12, by = -16;
        const sw = Math.sin(ph) * 4;
        ctx.strokeStyle = p.dark; ctx.lineWidth = 5 - i * 0.6;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.quadraticCurveTo(bx - 9 + sw, by - 9, bx - 15 + sw * 1.6, by - 3 + sw);
        ctx.stroke();
        ctx.strokeStyle = p.accentDim; ctx.lineWidth = 2 - i * 0.2;
        ctx.stroke();
      }
      ctx.restore();
      A.tracks(ctx, { p, w: 48, h: 14, roll: s.roll, wheels: 5, links: 6 });
      // 유기적 곡선 차체
      ctx.beginPath();
      ctx.moveTo(-23, -13);
      ctx.quadraticCurveTo(-20, -24, -4, -25);
      ctx.quadraticCurveTo(12, -26, 21, -16);
      ctx.lineTo(21, -13);
      ctx.closePath();
      ctx.fillStyle = A.metal(ctx, -26, -13, p, { top: p.lite, sheen: p.base, mid: p.mid, bot: p.deep });
      ctx.fill();
      ctx.strokeStyle = p.edge; ctx.lineWidth = 1.1; ctx.stroke();
      // 흡반 무늬
      ctx.fillStyle = p.accent;
      for (const [x, y, r] of [[-14, -18, 2.2], [-6, -20, 2.6], [3, -20, 2.4], [11, -18, 2]]) {
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = p.deep;
        ctx.beginPath(); ctx.arc(x, y, r * 0.45, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = p.accent;
      }
      // 눈
      A.light(ctx, 16, -19, 2, '#7bffcf', s.t, 2.2);
      A.light(ctx, 12, -22, 1.4, '#7bffcf', s.t + 1, 2.2);
      // 앞쪽 관절 팔 2개
      ctx.save();
      ctx.lineCap = 'round';
      for (let i = 0; i < 2; i++) {
        const ph = s.dead ? 0 : s.t * 1.7 + i * 2.6;
        const sw = Math.sin(ph) * 3;
        ctx.strokeStyle = p.mid; ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(16 - i * 4, -20 + i * 5);
        ctx.quadraticCurveTo(24, -22 + sw, 22 + i, -28 + sw + i * 3);
        ctx.stroke();
        ctx.strokeStyle = p.accent; ctx.lineWidth = 1.6; ctx.stroke();
      }
      ctx.restore();
      A.soot(ctx, s.hpFrac, 18);
    },
    barrel(ctx, s) {
      const p = P(s);
      const L = s.len || 24;
      // 촉수형 포신
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = p.dark; ctx.lineWidth = 6.5;
      ctx.beginPath(); ctx.moveTo(-3, 0); ctx.lineTo(L, 0); ctx.stroke();
      ctx.strokeStyle = p.mid; ctx.lineWidth = 4; ctx.stroke();
      ctx.fillStyle = p.accent;
      for (let x = 3; x < L - 2; x += 5) {
        ctx.beginPath(); ctx.arc(x, 2.6, 1.3, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      A.box(ctx, L - 4, -4.4, 6, 8.8, 2, { p, fill: p.accentDim, sheen: false });
      if (s.charge > 0.02) A.light(ctx, L + 3, 0, 2 + s.charge * 5, '#7bffcf', s.t, 11);
    },
  });

  /* ═══════════ 세이버 — 초장포신 저차체 ═══════════ */
  A.register('saber', {
    pivot: [0, -17], barrelLen: 33,
    draw(ctx, s) {
      const p = P(s);
      A.tracks(ctx, { p, w: 46, h: 9, roll: s.roll, wheels: 6, links: 4, skirt: true });
      // 스포츠카형 낮은 곡선 차체
      ctx.beginPath();
      ctx.moveTo(-23, -11);
      ctx.quadraticCurveTo(-20, -19, -2, -20);
      ctx.quadraticCurveTo(14, -21, 23, -13);
      ctx.lineTo(23, -11);
      ctx.closePath();
      ctx.fillStyle = A.metal(ctx, -21, -11, p, { top: p.accentHi, sheen: p.accent, mid: p.base, bot: p.dark });
      ctx.fill();
      ctx.strokeStyle = p.edge; ctx.lineWidth = 1.1; ctx.stroke();
      // 레이싱 스트라이프
      ctx.save();
      ctx.strokeStyle = p.hi; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(-20, -15); ctx.quadraticCurveTo(0, -17.5, 20, -14); ctx.stroke();
      ctx.restore();
      A.canopy(ctx, -4, -24, 11, 4.6, p);
      // 후방 스포일러
      A.plate(ctx, [[-24, -20], [-14, -22], [-14, -20], [-24, -18]], { p, fill: p.accentDim, sheen: false });
      ctx.strokeStyle = p.steelDark; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(-19, -20); ctx.lineTo(-19, -15); ctx.stroke();
      A.vent(ctx, 9, -19, 8, 3.4, 5, p);
      A.light(ctx, 19, -15, 1.4, '#ffe08a', s.t, 3);
      A.soot(ctx, s.hpFrac, 19);
    },
    barrel(ctx, s) {
      const p = P(s);
      const L = s.len || 33;
      // 아주 길고 가는 저격포
      A.box(ctx, -3, -1.9, L + 4, 3.8, 1.6, { p, fill: p.steel });
      A.box(ctx, 2, -3, 5, 6, 1.4, { p, fill: p.mid });
      for (const k of [0.45, 0.68]) A.box(ctx, L * k, -2.7, 2.4, 5.4, 1, { p, fill: p.mid, sheen: false });
      A.box(ctx, L - 1, -3.2, 6, 6.4, 1.4, { p, fill: p.steelDark, sheen: false });
      // 조준경
      A.box(ctx, 0, -6.5, 9, 3, 1.4, { p, fill: p.dark });
      ctx.fillStyle = '#8ad8ff';
      ctx.beginPath(); ctx.arc(8.6, -5, 1.2, 0, Math.PI * 2); ctx.fill();
      if (s.charge > 0.02) A.light(ctx, L + 5, 0, 1.5 + s.charge * 4, '#ffd28a', s.t, 12);
    },
  });

  /* ═══════════ 아이언벅 — 곤충 다리 6개 ═══════════ */
  A.register('ironbug', {
    pivot: [0, -21], barrelLen: 23,
    draw(ctx, s) {
      const p = P(s);
      // 다리 6개 (걷기)
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (let i = 0; i < 6; i++) {
        const side = i % 2 ? 1 : -1;
        const bx = -14 + Math.floor(i / 2) * 13;
        const ph = s.dead ? 1.2 : (s.roll * 0.09) + i * 1.05;
        const lift = s.dead ? 0 : Math.max(0, Math.sin(ph)) * 4;
        const sw = s.dead ? 0 : Math.cos(ph) * 4;
        ctx.strokeStyle = side > 0 ? p.dark : p.steelDark;
        ctx.lineWidth = side > 0 ? 2.6 : 2;
        ctx.beginPath();
        ctx.moveTo(bx, -12);
        ctx.lineTo(bx + sw * 0.5 + side * 3, -18 - lift * 0.4);
        ctx.lineTo(bx + sw + side * 5, -1 - lift);
        ctx.stroke();
        ctx.fillStyle = p.mid;
        ctx.beginPath(); ctx.arc(bx + sw * 0.5 + side * 3, -18 - lift * 0.4, 1.6, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      // 둥근 등껍질
      ctx.beginPath();
      ctx.ellipse(0, -18, 21, 10, 0, Math.PI, 0);
      ctx.lineTo(21, -11); ctx.lineTo(-21, -11); ctx.closePath();
      ctx.fillStyle = A.metal(ctx, -28, -11, p, { top: p.accentHi, sheen: p.accent, mid: p.accent, bot: p.accentDim });
      ctx.fill();
      ctx.strokeStyle = p.edge; ctx.lineWidth = 1.1; ctx.stroke();
      // 등껍질 분할선
      ctx.save();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1.2;
      for (const x of [-9, 0, 9]) {
        ctx.beginPath(); ctx.moveTo(x, -27.4); ctx.lineTo(x, -11); ctx.stroke();
      }
      ctx.restore();
      // 머리 + 더듬이
      A.plate(ctx, [[16, -22], [23, -19], [23, -14], [15, -15]], { p, fill: p.dark });
      A.light(ctx, 20, -18, 1.5, '#ff9a3c', s.t, 4);
      if (!s.dead) {
        ctx.save();
        ctx.strokeStyle = p.steelDark; ctx.lineWidth = 1.1;
        for (const d of [0, 1]) {
          const sw = Math.sin(s.t * 2.4 + d) * 3;
          ctx.beginPath();
          ctx.moveTo(20, -21);
          ctx.quadraticCurveTo(25 + sw, -26, 22 + sw, -31 + d * 3);
          ctx.stroke();
        }
        ctx.restore();
      }
      A.soot(ctx, s.hpFrac, 20);
    },
    barrel(ctx, s) {
      const p = P(s);
      const L = s.len || 23;
      A.box(ctx, -3, -2.6, L, 5.2, 2.4, { p, fill: p.steel });
      A.plate(ctx, [[L - 3, -3.6], [L + 5, -1.2], [L + 5, 1.2], [L - 3, 3.6]], { p, fill: p.accentDim, sheen: false });
      ctx.fillStyle = p.deep;
      ctx.beginPath(); ctx.ellipse(L + 4, 0, 1.2, 1.6, 0, 0, Math.PI * 2); ctx.fill();
    },
  });

  /* ═══════════ 워든 — 전개된 방패 ═══════════ */
  A.register('warden', {
    pivot: [-4, -26], barrelLen: 22,
    draw(ctx, s) {
      const p = P(s);
      A.tracks(ctx, { p, w: 52, h: 17, roll: s.roll, wheels: 6, links: 8, skirt: true });
      // 요새형 각진 차체
      A.plate(ctx, [[-24, -15], [-24, -27], [10, -27], [18, -21], [18, -15]], { p });
      A.vent(ctx, -21, -25, 12, 5, 6, p);
      A.panelLine(ctx, -6, -27, -6, -15, p);
      // 대형 방패 (전면 전개)
      A.plate(ctx, [[15, -6], [24, -12], [25, -30], [16, -26], [15, -14]],
        { p, fill: A.metal(ctx, -30, -6, p, { top: p.accentHi, sheen: p.accent, mid: p.accent, bot: p.accentDim }), lw: 1.4 });
      // 방패 문양
      ctx.save();
      ctx.strokeStyle = p.hi; ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(20, -25); ctx.lineTo(20, -10);
      ctx.moveTo(17, -18); ctx.lineTo(23, -18);
      ctx.stroke();
      ctx.restore();
      A.rivets(ctx, [[18, -24], [18, -12], [23, -18], [23, -26]], p, 1.4);
      // 방패 지지 암
      ctx.strokeStyle = p.steelDark; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(12, -20); ctx.lineTo(17, -19); ctx.stroke();
      // 낮고 두꺼운 포탑
      A.plate(ctx, [[-16, -27], [-13, -33], [4, -33], [8, -27]], { p, fill: p.dark });
      A.box(ctx, -12, -36, 8, 3.4, 1.2, { p, fill: p.steelDark, sheen: false });
      A.light(ctx, 5, -30, 1.5, p.glow, s.t, 1.8);
      A.soot(ctx, s.hpFrac, 21);
    },
    barrel(ctx, s) { A.barrelStd(ctx, s, { thick: 6.2, rings: 2, muzzle: 'big' }); },
  });

  /* ═══════════ 페가수스 — 날개 라디에이터 + 제트 ═══════════ */
  A.register('pegasus', {
    pivot: [1, -20], barrelLen: 25,
    draw(ctx, s) {
      const p = P(s);
      A.tracks(ctx, { p, w: 44, h: 10, roll: s.roll, wheels: 5, links: 5, skirt: true });
      // 날개 (뒤쪽 아래 레이어)
      const flap = s.dead ? 0 : Math.sin(s.t * 1.8) * 2;
      for (const dir of [1, -1]) {
        ctx.save();
        ctx.translate(-6, -20);
        ctx.rotate(dir * 0.12 + flap * 0.02);
        A.plate(ctx, [[0, dir * 1], [-13, -6 * dir - 3], [-20, -3 * dir - 6], [-6, dir * 2]],
          { p, fill: dir > 0 ? p.accent : p.accentDim, sheen: true });
        ctx.strokeStyle = p.hi; ctx.lineWidth = 0.9;
        for (let i = 1; i < 4; i++) {
          ctx.beginPath();
          ctx.moveTo(-2 - i * 1.5, dir * 1);
          ctx.lineTo(-8 - i * 3, -4 * dir - 3);
          ctx.stroke();
        }
        ctx.restore();
      }
      // 유선형 차체
      ctx.beginPath();
      ctx.moveTo(-21, -12);
      ctx.quadraticCurveTo(-18, -21, -2, -22);
      ctx.quadraticCurveTo(13, -23, 21, -15);
      ctx.lineTo(21, -12);
      ctx.closePath();
      ctx.fillStyle = A.metal(ctx, -23, -12, p, { top: p.lite, sheen: p.hi, mid: p.base, bot: p.dark });
      ctx.fill();
      ctx.strokeStyle = p.edge; ctx.lineWidth = 1.1; ctx.stroke();
      A.canopy(ctx, 2, -26, 10, 4.4, p);
      // 제트 노즐 2개
      for (const y of [-19, -14]) {
        A.box(ctx, -25, y, 6, 4, 1.6, { p, fill: p.steelDark, sheen: false });
        if (!s.dead) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const j = 0.45 + Math.sin(s.t * 12 + y) * 0.2;
          const g = ctx.createLinearGradient(-25, 0, -37, 0);
          g.addColorStop(0, `rgba(150,220,255,${0.7 * j})`);
          g.addColorStop(1, 'rgba(80,150,255,0)');
          ctx.fillStyle = g;
          ctx.fillRect(-37, y + 0.5, 12, 3);
          ctx.restore();
        }
      }
      A.light(ctx, 17, -17, 1.4, '#bfe8ff', s.t, 3.4);
      A.soot(ctx, s.hpFrac, 22);
    },
    barrel(ctx, s) { A.barrelStd(ctx, s, { thick: 4.4, rings: 2, muzzle: 'small' }); },
  });

  /* ═══════════ 리바이어던 — 3중 궤도 초중량 ═══════════ */
  A.register('leviathan', {
    pivot: [-3, -28], barrelLen: 31,
    draw(ctx, s) {
      const p = P(s);
      // 3중 궤도
      A.tracks(ctx, { p, x: -17, y: 0, w: 22, h: 14, roll: s.roll, wheels: 3, links: 5 });
      A.tracks(ctx, { p, x: 1, y: 0, w: 22, h: 14, roll: s.roll, wheels: 3, links: 5 });
      A.tracks(ctx, { p, x: 18, y: 0, w: 20, h: 14, roll: s.roll, wheels: 3, links: 5 });
      // 하부 연결 빔
      A.box(ctx, -25, -17, 51, 5, 1.5, { p, fill: p.deep, sheen: false });
      // 초대형 차체
      A.plate(ctx, [[-25, -16], [-25, -28], [12, -28], [24, -21], [24, -16]], { p });
      A.vent(ctx, -22, -26, 14, 6, 7, p);
      A.panelLine(ctx, -6, -28, -6, -16, p);
      A.panelLine(ctx, 6, -28, 6, -16, p);
      A.rivets(ctx, [[-22, -18], [-22, -23], [-12, -27], [16, -18], [21, -22]], p, 1.5);
      // 함선형 상부 구조물
      A.plate(ctx, [[-18, -28], [-15, -35], [2, -35], [6, -29], [6, -28]],
        { p, fill: A.metal(ctx, -35, -28, p, { top: p.accentHi, sheen: p.accent, mid: p.accent, bot: p.accentDim }) });
      A.box(ctx, -12, -40, 9, 5.4, 1.6, { p, fill: p.dark });
      A.canopy(ctx, -10, -39, 5, 2.6, p);
      if (!s.dead) A.antenna(ctx, -16, -35, 16, s.t, p);
      A.light(ctx, 3, -32, 1.8, p.glow, s.t, 1.6);
      A.light(ctx, -13, -41, 1.3, '#ff5a5a', s.t, 3);
      A.soot(ctx, s.hpFrac, 23);
    },
    barrel(ctx, s) {
      const p = P(s);
      const L = s.len || 31;
      // 거대 함포
      A.box(ctx, -5, -4.6, L + 5, 9.2, 3, { p, fill: p.steel });
      A.box(ctx, 3, -6, 7, 12, 2, { p, fill: p.mid });
      for (const k of [0.42, 0.62]) A.box(ctx, L * k, -5.6, 4, 11.2, 1.5, { p, fill: p.mid, sheen: false });
      A.box(ctx, L - 3, -6.4, 9, 12.8, 2, { p, fill: p.steelDark, sheen: false });
      ctx.fillStyle = '#0d0f13';
      ctx.beginPath(); ctx.ellipse(L + 5.6, 0, 1.8, 5, 0, 0, Math.PI * 2); ctx.fill();
      if (s.charge > 0.02) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const g = ctx.createRadialGradient(L + 5, 0, 0, L + 5, 0, 16 * s.charge + 5);
        g.addColorStop(0, `rgba(255,220,150,${0.9 * s.charge})`);
        g.addColorStop(1, 'rgba(255,110,20,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(L + 5, 0, 16 * s.charge + 5, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    },
  });

  /* ═══════════ 스팅어 — 소형 + 상부 유탄 발사기 ═══════════ */
  A.register('stinger', {
    pivot: [2, -18], barrelLen: 21,
    draw(ctx, s) {
      const p = P(s);
      A.tracks(ctx, { p, w: 38, h: 10, roll: s.roll, wheels: 4, links: 5 });
      // 작고 단단한 차체
      A.plate(ctx, [[-18, -11], [-15, -18], [8, -19], [17, -13], [17, -11]], { p });
      // 벌 줄무늬
      ctx.save();
      ctx.beginPath(); A.poly(ctx, [[-18, -11], [-15, -18], [8, -19], [17, -13], [17, -11]]); ctx.clip();
      ctx.fillStyle = 'rgba(20,18,14,0.85)';
      for (let x = -16; x < 18; x += 9) {
        ctx.beginPath();
        ctx.moveTo(x, -19); ctx.lineTo(x + 4, -19); ctx.lineTo(x - 1, -10); ctx.lineTo(x - 5, -10);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      // 상부 유탄 발사기
      A.box(ctx, -14, -26, 13, 7, 2, { p, fill: p.dark });
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = p.deep;
        ctx.beginPath(); ctx.arc(-11 + i * 4, -22.5, 1.5, 0, Math.PI * 2); ctx.fill();
      }
      A.box(ctx, -9, -28, 4, 2.4, 1, { p, fill: p.accent, sheen: false });
      // 작은 포탑
      A.plate(ctx, [[-4, -19], [-1, -23], [8, -23], [11, -19]],
        { p, fill: A.metal(ctx, -23, -19, p, { top: p.accentHi, sheen: p.accent, mid: p.accent, bot: p.accentDim }) });
      A.light(ctx, 13, -15, 1.3, '#ffe066', s.t, 5);
      if (!s.dead) A.antenna(ctx, -16, -18, 11, s.t, p);
      A.soot(ctx, s.hpFrac, 24);
    },
    barrel(ctx, s) {
      const p = P(s);
      const L = s.len || 21;
      // 침처럼 가늘어지는 포신
      A.plate(ctx, [[-3, -2.6], [L - 4, -1.6], [L + 4, -0.4], [L + 4, 0.4], [L - 4, 1.6], [-3, 2.6]],
        { p, fill: p.steel });
      A.box(ctx, 1, -3.4, 4, 6.8, 1.4, { p, fill: p.mid });
      if (s.charge > 0.02) A.light(ctx, L + 4, 0, 1.4 + s.charge * 3.6, '#ffe066', s.t, 13);
    },
  });
})();
