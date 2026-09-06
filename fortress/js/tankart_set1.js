'use strict';
/* tankart_set1.js — 전차 아트 8종
 * 새턴 / 코브라 / 타이탄 / 스콜피온 / 팔콘 / 골리앗 / 마스토돈 / 밴시
 *
 * 좌표: 원점 = 궤도 바닥 중앙, +x 오른쪽(정면), +y 아래.
 * 본체 범위 x ∈ [-26,26], y ∈ [-34,1]
 */
(() => {
  const A = TankArt;
  const P = (s) => (s.dead ? A.deadPal(s.p) : s.p);

  /* ═══════════ 새턴 — 반구 포탑 + 방열 링 ═══════════ */
  A.register('saturn', {
    pivot: [1, -22], barrelLen: 27,
    draw(ctx, s) {
      const p = P(s);
      A.tracks(ctx, { p, w: 46, h: 13, roll: s.roll, wheels: 5 });
      // 차체 — 앞으로 살짝 기운 사다리꼴
      A.plate(ctx, [[-21, -12], [-18, -22], [16, -22], [22, -15], [22, -12]], { p });
      A.vent(ctx, -17, -20, 11, 5, 5, p);
      A.panelLine(ctx, -4, -22, -4, -12, p);
      A.rivets(ctx, [[-19, -14], [-19, -18], [18, -14], [14, -20]], p);
      // 포탑 반구
      ctx.beginPath();
      ctx.arc(1, -22, 12, Math.PI, 0);
      ctx.lineTo(13, -22); ctx.lineTo(-11, -22); ctx.closePath();
      ctx.fillStyle = A.metal(ctx, -34, -22, p, { top: p.accentHi, sheen: p.accent, mid: p.accent, bot: p.accentDim });
      ctx.fill();
      ctx.strokeStyle = p.edge; ctx.lineWidth = 1.1; ctx.stroke();
      // 토성 고리
      ctx.save();
      ctx.translate(1, -23);
      ctx.rotate(-0.22);
      ctx.strokeStyle = p.steel; ctx.lineWidth = 2.6;
      ctx.beginPath(); ctx.ellipse(0, 0, 17, 5, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = p.hi; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(0, 0, 17, 5, 0, Math.PI * 0.1, Math.PI * 0.9); ctx.stroke();
      ctx.restore();
      A.light(ctx, 9, -25, 1.5, p.glow, s.t, 3);
      if (!s.dead) A.antenna(ctx, -13, -22, 13, s.t, p);
      A.soot(ctx, s.hpFrac, 1);
    },
    barrel(ctx, s) { A.barrelStd(ctx, s, { thick: 5.4, rings: 2, muzzle: 'big' }); },
  });

  /* ═══════════ 코브라 — 낮고 긴 차체, 앞으로 숙인 포탑 ═══════════ */
  A.register('cobra', {
    pivot: [4, -19], barrelLen: 31,
    draw(ctx, s) {
      const p = P(s);
      A.tracks(ctx, { p, w: 48, h: 10, roll: s.roll, wheels: 6, links: 5 });
      // 측면 스커트
      A.box(ctx, -24, -15, 48, 6, 2, { p, fill: p.mid });
      // 낮고 길쭉한 차체
      A.plate(ctx, [[-24, -13], [-20, -19], [12, -20], [23, -14], [23, -13]], { p });
      A.panelLine(ctx, -12, -19, -12, -13, p);
      A.panelLine(ctx, 2, -20, 2, -13, p);
      A.vent(ctx, -21, -18, 8, 4, 4, p);
      // 뱀 머리 포탑 — 앞으로 숙임
      A.plate(ctx, [[-6, -19], [-3, -25], [10, -24], [16, -19], [8, -17], [-4, -17]],
        { p, fill: A.metal(ctx, -25, -17, p, { top: p.accentHi, sheen: p.accent, mid: p.accent, bot: p.accentDim }) });
      // 눈 (독니 램프)
      A.light(ctx, 12, -21, 1.6, '#ff5a3c', s.t, 5);
      ctx.fillStyle = p.deep;
      ctx.beginPath(); ctx.moveTo(15, -19); ctx.lineTo(19, -17); ctx.lineTo(15, -17.5); ctx.closePath(); ctx.fill();
      A.rivets(ctx, [[-22, -15], [-16, -18], [18, -15]], p, 1);
      A.soot(ctx, s.hpFrac, 2);
    },
    barrel(ctx, s) { A.barrelStd(ctx, s, { thick: 3.8, rings: 3, muzzle: 'small' }); },
  });

  /* ═══════════ 타이탄 — 각진 요새, 이중 포신 ═══════════ */
  A.register('titan', {
    pivot: [0, -24], barrelLen: 25,
    draw(ctx, s) {
      const p = P(s);
      A.tracks(ctx, { p, w: 52, h: 16, roll: s.roll, wheels: 6, links: 7, skirt: true });
      // 경사 전면 장갑 + 상자 차체
      A.plate(ctx, [[-24, -14], [-24, -25], [10, -25], [24, -18], [24, -14]], { p });
      A.plate(ctx, [[10, -25], [24, -18], [24, -22], [14, -27]], { p, fill: p.dark, sheen: false });
      A.vent(ctx, -22, -23, 13, 6, 6, p);
      A.panelLine(ctx, -8, -25, -8, -14, p);
      A.panelLine(ctx, 4, -25, 4, -14, p);
      A.rivets(ctx, [[-21, -16], [-21, -21], [-14, -24], [17, -16], [20, -20]], p, 1.3);
      // 포탑 — 두꺼운 각진 상자
      A.plate(ctx, [[-13, -25], [-10, -33], [9, -33], [15, -26], [15, -25]],
        { p, fill: A.metal(ctx, -33, -25, p, { top: p.accentHi, sheen: p.accent, mid: p.accent, bot: p.accentDim }) });
      A.box(ctx, -6, -36, 9, 4, 1.5, { p, fill: p.steelDark, sheen: false });
      A.light(ctx, 11, -29, 1.7, p.glow, s.t, 2.4);
      A.soot(ctx, s.hpFrac, 3);
    },
    barrel(ctx, s) {
      const p = P(s);
      // 이중 포신
      for (const dy of [-3.6, 3.6]) {
        ctx.save();
        ctx.translate(0, dy);
        A.box(ctx, -3, -2.4, (s.len || 25) + 3, 4.8, 1.6, { p, fill: p.steel });
        A.box(ctx, (s.len || 25) - 3, -3.4, 6, 6.8, 1.4, { p, fill: p.steelDark, sheen: false });
        ctx.restore();
      }
      A.box(ctx, 4, -7, 5, 14, 2, { p, fill: p.mid });
      if (s.charge > 0.02) {
        ctx.save();
        const L = (s.len || 25) + 3;
        const g = ctx.createRadialGradient(L, 0, 0, L, 0, 13 * s.charge + 4);
        g.addColorStop(0, `rgba(255,214,138,${0.9 * s.charge})`);
        g.addColorStop(1, 'rgba(255,120,30,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(L, 0, 13 * s.charge + 4, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    },
  });

  /* ═══════════ 스콜피온 — 위로 휘어 올라간 꼬리 포신 ═══════════ */
  A.register('scorpion', {
    pivot: [-9, -30], barrelLen: 22,
    draw(ctx, s) {
      const p = P(s);
      A.tracks(ctx, { p, w: 44, h: 12, roll: s.roll, wheels: 5 });
      // 둥근 갑각 차체
      A.plate(ctx, [[-20, -12], [-16, -20], [10, -21], [20, -15], [20, -12]], { p });
      A.panelLine(ctx, -6, -21, -6, -12, p);
      // 집게 (앞쪽)
      const cl = Math.sin(s.t * 1.6) * 1.6;
      ctx.save();
      ctx.strokeStyle = p.mid; ctx.lineWidth = 3.4; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(18, -16); ctx.quadraticCurveTo(25, -19 - cl, 22, -23 - cl);
      ctx.moveTo(18, -14); ctx.quadraticCurveTo(25, -12 + cl, 22, -8 + cl);
      ctx.stroke();
      ctx.strokeStyle = p.accent; ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(18, -16); ctx.quadraticCurveTo(25, -19 - cl, 22, -23 - cl);
      ctx.stroke();
      ctx.restore();
      // 꼬리 — 마디 3개가 위로
      const seg = [[-14, -20], [-16, -25], [-12, -29]];
      ctx.strokeStyle = p.dark; ctx.lineWidth = 7; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(-8, -19);
      for (const [x, y] of seg) ctx.lineTo(x, y);
      ctx.lineTo(-9, -30);
      ctx.stroke();
      ctx.strokeStyle = p.accent; ctx.lineWidth = 3.4;
      ctx.beginPath();
      ctx.moveTo(-8, -19);
      for (const [x, y] of seg) ctx.lineTo(x, y);
      ctx.lineTo(-9, -30);
      ctx.stroke();
      for (const [x, y] of seg) {
        ctx.fillStyle = p.hi;
        ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fill();
      }
      A.light(ctx, 14, -19, 1.5, '#a8ff6a', s.t, 3.4);
      A.soot(ctx, s.hpFrac, 4);
    },
    barrel(ctx, s) {
      const p = P(s);
      A.box(ctx, -4, -3.4, (s.len || 22) + 4, 6.8, 3, { p, fill: p.mid });
      A.box(ctx, (s.len || 22) - 2, -4.4, 6, 8.8, 2, { p, fill: p.accentDim, sheen: false });
      ctx.fillStyle = p.deep;
      ctx.beginPath(); ctx.ellipse((s.len || 22) + 4, 0, 1.6, 3.4, 0, 0, Math.PI * 2); ctx.fill();
      if (s.charge > 0.02) A.light(ctx, (s.len || 22) + 5, 0, 2 + s.charge * 4, '#b6ff6a', s.t, 12);
    },
  });

  /* ═══════════ 팔콘 — 쐐기형 스텔스 + 날개 스포일러 ═══════════ */
  A.register('falcon', {
    pivot: [2, -17], barrelLen: 25,
    draw(ctx, s) {
      const p = P(s);
      A.tracks(ctx, { p, w: 42, h: 9, roll: s.roll, wheels: 5, links: 5, skirt: true });
      // 쐐기 차체
      A.plate(ctx, [[-22, -11], [-18, -18], [6, -19], [23, -12], [23, -11]], { p });
      // 날개 스포일러 (뒤로 젖혀짐)
      A.plate(ctx, [[-22, -18], [-26, -26], [-14, -24], [-11, -19]],
        { p, fill: p.accent, sheen: true });
      A.plate(ctx, [[-20, -12], [-25, -9], [-13, -11]], { p, fill: p.dark, sheen: false });
      // 낮은 포탑
      A.plate(ctx, [[-6, -19], [-3, -23], [9, -23], [14, -18], [-2, -18]],
        { p, fill: A.metal(ctx, -24, -18, p, { top: p.accentHi, sheen: p.accent, mid: p.accent, bot: p.accentDim }) });
      A.canopy(ctx, 0, -22, 8, 3.6, p);
      // 제트 노즐
      A.box(ctx, -24, -16, 5, 4, 1.5, { p, fill: p.steelDark, sheen: false });
      if (!s.dead) {
        const j = 0.5 + Math.sin(s.t * 14) * 0.2;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const g = ctx.createLinearGradient(-24, 0, -38, 0);
        g.addColorStop(0, `rgba(120,200,255,${0.75 * j})`);
        g.addColorStop(1, 'rgba(60,140,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(-38, -16, 14, 4);
        ctx.restore();
      }
      A.panelLine(ctx, -8, -19, -8, -11, p);
      A.soot(ctx, s.hpFrac, 5);
    },
    barrel(ctx, s) { A.barrelStd(ctx, s, { thick: 4, rings: 1, muzzle: 'small' }); },
  });

  /* ═══════════ 골리앗 — 도저 블레이드 + 굴뚝 ═══════════ */
  A.register('goliath', {
    pivot: [-3, -26], barrelLen: 23,
    draw(ctx, s) {
      const p = P(s);
      A.tracks(ctx, { p, w: 50, h: 17, roll: s.roll, wheels: 6, links: 7 });
      // 육중한 차체
      A.plate(ctx, [[-24, -15], [-24, -27], [12, -27], [20, -20], [20, -15]], { p });
      // 경고 줄무늬
      ctx.save();
      ctx.beginPath(); A.rr(ctx, -22, -19, 30, 5, 1); ctx.clip();
      ctx.fillStyle = '#1a1a1c'; ctx.fillRect(-22, -19, 30, 5);
      ctx.fillStyle = p.accent;
      for (let x = -24; x < 10; x += 8) { ctx.beginPath(); ctx.moveTo(x, -14); ctx.lineTo(x + 4, -20); ctx.lineTo(x + 8, -20); ctx.lineTo(x + 4, -14); ctx.closePath(); ctx.fill(); }
      ctx.restore();
      // 도저 블레이드
      A.plate(ctx, [[19, -8], [27, -13], [27, -26], [20, -22], [19, -14]],
        { p, fill: A.metal(ctx, -26, -8, p, { top: p.hi, sheen: p.steel, mid: p.mid, bot: p.deep }) });
      A.plate(ctx, [[19, -8], [27, -13], [27, -10], [19, -6]], { p, fill: p.steelDark, sheen: false });
      ctx.strokeStyle = p.mid; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(14, -18); ctx.lineTo(21, -16); ctx.stroke();
      // 굴뚝 2개
      A.exhaust(ctx, -20, -34, 5, 8, p);
      A.exhaust(ctx, -12, -32, 4.5, 6, p);
      if (!s.dead) {
        ctx.save();
        ctx.globalAlpha = 0.28 + Math.sin(s.t * 2.6) * 0.1;
        ctx.fillStyle = '#3a3a3e';
        ctx.beginPath(); ctx.arc(-18, -39 - (s.t * 6 % 5), 4, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      // 짧은 포탑
      A.plate(ctx, [[-12, -27], [-9, -32], [6, -32], [10, -27]],
        { p, fill: A.metal(ctx, -32, -27, p, { top: p.accentHi, sheen: p.accent, mid: p.accent, bot: p.accentDim }) });
      A.rivets(ctx, [[-21, -17], [-21, -24], [15, -17], [24, -16], [24, -22]], p, 1.3);
      A.soot(ctx, s.hpFrac, 6);
    },
    barrel(ctx, s) { A.barrelStd(ctx, s, { thick: 6.4, rings: 1, muzzle: 'big' }); },
  });

  /* ═══════════ 마스토돈 — 이중 포탑 + 상아 램 ═══════════ */
  A.register('mastodon', {
    pivot: [-2, -28], barrelLen: 25,
    draw(ctx, s) {
      const p = P(s);
      A.tracks(ctx, { p, w: 50, h: 15, roll: s.roll, wheels: 6, links: 6 });
      // 상자 차체
      A.plate(ctx, [[-24, -14], [-24, -24], [14, -24], [22, -18], [22, -14]], { p });
      A.vent(ctx, -21, -22, 12, 6, 6, p);
      A.panelLine(ctx, 0, -24, 0, -14, p);
      // 상아 (전면 램)
      ctx.save();
      ctx.strokeStyle = '#e8e2d0'; ctx.lineWidth = 3.4; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(19, -13); ctx.quadraticCurveTo(27, -13, 26, -19);
      ctx.moveTo(19, -17); ctx.quadraticCurveTo(26, -18, 25, -23);
      ctx.stroke();
      ctx.restore();
      // 하부 부포탑
      A.plate(ctx, [[6, -24], [8, -28], [17, -28], [19, -24]], { p, fill: p.dark });
      A.box(ctx, 14, -27, 11, 2.6, 1.2, { p, fill: p.steel, sheen: false });
      // 주 포탑
      A.plate(ctx, [[-14, -24], [-11, -32], [8, -32], [12, -25], [12, -24]],
        { p, fill: A.metal(ctx, -32, -24, p, { top: p.accentHi, sheen: p.accent, mid: p.accent, bot: p.accentDim }) });
      // 배기 굴뚝 2개
      A.exhaust(ctx, -22, -31, 4.4, 7, p);
      A.exhaust(ctx, -16, -30, 4, 6, p);
      A.light(ctx, 8, -28, 1.6, p.glow, s.t, 2.8);
      A.rivets(ctx, [[-21, -16], [-13, -23], [18, -16]], p, 1.2);
      A.soot(ctx, s.hpFrac, 7);
    },
    barrel(ctx, s) { A.barrelStd(ctx, s, { thick: 5.6, rings: 2, muzzle: 'big' }); },
  });

  /* ═══════════ 밴시 — 호버 부양 + 발광 코어 ═══════════ */
  A.register('banshee', {
    pivot: [0, -22], barrelLen: 24,
    draw(ctx, s) {
      const p = P(s);
      const bob = s.dead ? 0 : Math.sin(s.t * 2.2) * 1.4;
      ctx.save();
      ctx.translate(0, bob);
      if (!s.dead) A.hoverSkirt(ctx, { p, w: 46, h: 10, y: -4, t: s.t });
      else A.box(ctx, -23, -14, 46, 10, 5, { p, fill: p.dark });
      // 얇고 유선형인 차체
      A.plate(ctx, [[-22, -14], [-16, -23], [10, -24], [21, -16], [21, -14]], { p });
      A.plate(ctx, [[-16, -23], [-11, -28], [6, -28], [10, -24]],
        { p, fill: A.metal(ctx, -28, -24, p, { top: p.accentHi, sheen: p.accent, mid: p.accent, bot: p.accentDim }) });
      // 에어 벤트
      A.vent(ctx, -19, -20, 9, 4, 5, p);
      A.vent(ctx, 12, -21, 7, 4, 4, p);
      // 발광 코어
      const pulse = 0.6 + Math.sin(s.t * 3.4) * 0.35;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(-2, -22, 0, -2, -22, 13);
      g.addColorStop(0, `rgba(180,240,255,${0.8 * pulse})`);
      g.addColorStop(0.5, `rgba(90,190,255,${0.32 * pulse})`);
      g.addColorStop(1, 'rgba(60,140,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(-2, -22, 13, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.fillStyle = s.dead ? '#4a4d55' : '#d8f6ff';
      ctx.beginPath(); ctx.arc(-2, -22, 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = p.steel; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(-2, -22, 5.6, 0, Math.PI * 2); ctx.stroke();
      A.light(ctx, 17, -19, 1.4, '#9fe8ff', s.t, 4);
      A.soot(ctx, s.hpFrac, 8);
      ctx.restore();
    },
    barrel(ctx, s) {
      const p = P(s);
      const L = s.len || 24;
      A.box(ctx, -3, -2.2, L + 3, 4.4, 2, { p, fill: p.steel });
      A.box(ctx, L - 6, -3.6, 5, 7.2, 1.6, { p, fill: p.accentDim, sheen: false });
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const a = 0.25 + (s.charge || 0) * 0.7;
      const g = ctx.createLinearGradient(0, 0, L, 0);
      g.addColorStop(0, 'rgba(140,220,255,0)');
      g.addColorStop(1, `rgba(160,235,255,${a})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, -1.2, L + 3, 2.4);
      ctx.restore();
    },
  });
})();
