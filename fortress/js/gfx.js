'use strict';
/* gfx.js — 하늘 / 원경 / 지형 표면 렌더링
 *
 * Gfx.THEMES                       테마 목록
 * Gfx.createScene(seed, key)       결정적 장면 생성 (미리 계산)
 * Gfx.drawSky(ctx, scene, t)       하늘 · 태양/달 · 구름 · 원경
 * Gfx.drawTerrain(ctx, scene, g,t) 지형 (지층 · 텍스처 · 표면 디테일)
 * Gfx.drawOverlay(ctx, scene, t)   날씨 · 비네팅 · 색보정
 */
const Gfx = (() => {

  /* ═════════ 테마 ═════════ */
  const THEMES = {
    meadow: {
      name: '초원', terrain: 'rolling',
      sky: [[0, '#0d1b38'], [0.34, '#2f6ab2'], [0.68, '#79bee0'], [1, '#cfe9f4']],
      light: { x: 0.76, y: 0.13, r: 40, core: '#fff8d8', glow: '#ffd77a', kind: 'sun' },
      hills: [
        { y: 0.44, amp: 74, f: 0.0038, color: '#2a4368', haze: 0.55 },
        { y: 0.52, amp: 52, f: 0.0061, color: '#2c5346', haze: 0.3 },
        { y: 0.59, amp: 34, f: 0.0098, color: '#26452f', haze: 0.12 },
      ],
      strata: [
        [0.00, '#6b4a2b'], [0.10, '#5b3d22'], [0.24, '#6a4a2c'],
        [0.44, '#4a341d'], [0.66, '#3a2818'], [1.00, '#241a10'],
      ],
      surface: { color: '#3d8e42', thick: 7, hi: '#7ed37e' },
      detail: 'grass', weather: 'none',
      fog: 'rgba(150,195,225,0.16)', vignette: 0.34, grade: null,
    },
    desert: {
      name: '사막', terrain: 'dunes',
      sky: [[0, '#3a1c3e'], [0.3, '#8e3c2e'], [0.6, '#d8813c'], [1, '#f6dda6']],
      light: { x: 0.22, y: 0.24, r: 54, core: '#fff2c0', glow: '#ff9a3c', kind: 'sun' },
      hills: [
        { y: 0.50, amp: 58, f: 0.0032, color: '#7a4030', haze: 0.5 },
        { y: 0.57, amp: 40, f: 0.0058, color: '#96603a', haze: 0.28 },
        { y: 0.63, amp: 26, f: 0.0091, color: '#a97245', haze: 0.1 },
      ],
      strata: [
        [0.00, '#d8ac6c'], [0.12, '#c8974f'], [0.3, '#b8853f'],
        [0.5, '#9d6c33'], [0.72, '#7d5327'], [1.00, '#553618'],
      ],
      surface: { color: '#dcb473', thick: 6.5, hi: '#f7e0ad' },
      detail: 'sand', weather: 'sand',
      fog: 'rgba(240,190,130,0.2)', vignette: 0.3, grade: 'rgba(255,160,60,0.07)',
    },
    snow: {
      name: '설원', terrain: 'plateau',
      sky: [[0, '#060f24'], [0.32, '#22406f'], [0.66, '#6b93bd'], [1, '#d3e5f2']],
      light: { x: 0.68, y: 0.15, r: 36, core: '#eef6ff', glow: '#b9d8f5', kind: 'sun' },
      hills: [
        { y: 0.42, amp: 86, f: 0.0035, color: '#1d2c4a', haze: 0.6 },
        { y: 0.52, amp: 60, f: 0.0057, color: '#2c3f5e', haze: 0.35, snowcap: true },
        { y: 0.60, amp: 32, f: 0.0094, color: '#3b4f6c', haze: 0.15, snowcap: true },
      ],
      strata: [
        [0.00, '#e8f1f8'], [0.07, '#b9cbdb'], [0.2, '#7d8fa3'],
        [0.42, '#5b6a7c'], [0.68, '#414c5c'], [1.00, '#242c38'],
      ],
      surface: { color: '#eef5fb', thick: 8.5, hi: '#ffffff' },
      detail: 'snow', weather: 'snow',
      fog: 'rgba(200,225,245,0.22)', vignette: 0.34, grade: 'rgba(120,180,255,0.06)',
    },
    volcano: {
      name: '화산', terrain: 'volcanic',
      sky: [[0, '#12040a'], [0.3, '#3d0f12'], [0.62, '#8c2c14'], [1, '#d4622a']],
      light: { x: 0.5, y: 0.2, r: 30, core: '#ffd9a0', glow: '#ff6a20', kind: 'sun' },
      hills: [
        { y: 0.46, amp: 78, f: 0.0031, color: '#2a1114', haze: 0.5, volcano: true },
        { y: 0.55, amp: 46, f: 0.0064, color: '#361718', haze: 0.28 },
        { y: 0.62, amp: 28, f: 0.0102, color: '#421d1a', haze: 0.1 },
      ],
      strata: [
        [0.00, '#4a3a37'], [0.09, '#33282a'], [0.26, '#3d2a24'],
        [0.46, '#2a1d1c'], [0.7, '#1e1414'], [1.00, '#120b0b'],
      ],
      surface: { color: '#3f2e2c', thick: 6.5, hi: '#6e4636', ember: true },
      detail: 'rock', weather: 'ash',
      fog: 'rgba(255,110,50,0.12)', vignette: 0.46, grade: 'rgba(255,80,20,0.07)',
    },
    canyon: {
      name: '협곡', terrain: 'jagged',
      sky: [[0, '#26183c'], [0.3, '#6b3f63'], [0.62, '#c9784f'], [1, '#f4cf93']],
      light: { x: 0.84, y: 0.2, r: 44, core: '#fff0c4', glow: '#ff9d55', kind: 'sun' },
      hills: [
        { y: 0.44, amp: 66, f: 0.0029, color: '#4b2f4a', haze: 0.55, mesa: true },
        { y: 0.53, amp: 46, f: 0.0052, color: '#6b3f3c', haze: 0.3, mesa: true },
        { y: 0.61, amp: 28, f: 0.0088, color: '#8a5039', haze: 0.12 },
      ],
      strata: [
        [0.00, '#c07348'], [0.08, '#a85c38'], [0.18, '#c98559'],
        [0.3, '#8f4a2e'], [0.46, '#a86341'], [0.62, '#773d28'], [1.00, '#4b2618'],
      ],
      surface: { color: '#bd7a4a', thick: 6, hi: '#e6b078' },
      detail: 'rock', weather: 'dust',
      fog: 'rgba(230,160,110,0.18)', vignette: 0.38, grade: 'rgba(255,140,70,0.05)',
    },
    night: {
      name: '야간 도시', terrain: 'urban',
      sky: [[0, '#02030a'], [0.34, '#080f28'], [0.68, '#152449'], [1, '#2b3d6b']],
      light: { x: 0.2, y: 0.16, r: 30, core: '#f2f6ff', glow: '#93b4e8', kind: 'moon' },
      hills: [
        { y: 0.47, amp: 40, f: 0.0033, color: '#0b1226', haze: 0.5 },
        { y: 0.56, amp: 22, f: 0.0072, color: '#111a33', haze: 0.25 },
      ],
      city: true,
      strata: [
        [0.00, '#4e5563'], [0.06, '#3a4150'], [0.2, '#2e343f'],
        [0.42, '#252a34'], [0.68, '#1b1f27'], [1.00, '#101319'],
      ],
      surface: { color: '#525a67', thick: 6, hi: '#7f8998' },
      detail: 'urban', weather: 'none',
      fog: 'rgba(70,110,190,0.14)', vignette: 0.5, grade: 'rgba(60,110,220,0.07)',
    },
  };

  /* ═════════ 장면 생성 ═════════ */

  function createScene(seed, key) {
    const th = THEMES[key] || THEMES.meadow;
    const r = Terrain.rng((seed ^ 0x5bf03635) >>> 0);
    const sc = { key, th, t0: 0, lastT: 0, grads: null, pattern: null };

    // 원경 능선 (8px 간격 높이 배열)
    sc.hills = th.hills.map((h, i) => {
      const pts = [];
      const p1 = r() * 9, p2 = r() * 9, p3 = r() * 9;
      const f2 = h.f * (2.1 + r() * 0.7), f3 = h.f * (4.3 + r());
      for (let x = 0; x <= W; x += 8) {
        let y = H * h.y
          + Math.sin(x * h.f + p1) * h.amp
          + Math.sin(x * f2 + p2) * h.amp * 0.42
          + Math.sin(x * f3 + p3) * h.amp * 0.18;
        pts.push(y);
      }
      // 메사(협곡): 능선 일부를 평평하게
      if (h.mesa) {
        for (let k = 0; k < 3 + Math.floor(r() * 3); k++) {
          const c = Math.floor(r() * pts.length);
          const wd = 8 + Math.floor(r() * 16);
          const lvl = pts[c];
          for (let i = Math.max(0, c - wd); i < Math.min(pts.length, c + wd); i++) pts[i] = lvl;
        }
      }
      return { pts, color: h.color, haze: h.haze, snowcap: h.snowcap, volcano: h.volcano, idx: i };
    });

    // 화산 원뿔
    if (th.hills.some((h) => h.volcano)) {
      sc.volcano = { x: W * (0.16 + r() * 0.14), base: H * 0.56, w: 360, h: 245 };
    }

    // 도시 스카이라인
    if (th.city) {
      sc.city = [];
      let x = -40;
      while (x < W + 40) {
        const bw = 34 + r() * 62;
        const bh = 70 + r() * 240;
        const wins = [];
        const cols = Math.max(1, Math.floor(bw / 13));
        const rows = Math.max(1, Math.floor(bh / 17));
        for (let cx = 0; cx < cols; cx++) {
          for (let cy = 0; cy < rows; cy++) {
            if (r() < 0.42) wins.push([6 + cx * 13, 10 + cy * 17, r() < 0.16 ? 1 : 0]);
          }
        }
        sc.city.push({ x, w: bw, h: bh, wins, tone: 0.6 + r() * 0.4, anten: r() < 0.3 });
        x += bw + 3 + r() * 12;
      }
    }

    // 별
    if (key === 'night') {
      sc.stars = [];
      for (let i = 0; i < 190; i++) {
        sc.stars.push({ x: r() * W, y: r() * H * 0.62, r: 0.5 + r() * 1.3, p: r() * 7, s: 0.6 + r() * 2 });
      }
    }

    // 구름 3겹
    sc.clouds = [];
    const cn = key === 'night' ? 5 : key === 'volcano' ? 7 : 9;
    for (let i = 0; i < cn; i++) {
      const layer = i % 3;
      sc.clouds.push({
        x: r() * (W + 400) - 200,
        y: 34 + r() * (H * 0.34),
        s: 0.5 + layer * 0.42 + r() * 0.4,
        v: (0.9 + layer * 1.5) * (0.6 + r() * 0.8),
        a: 0.2 + layer * 0.14 + r() * 0.16,
        lobes: Array.from({ length: 4 + Math.floor(r() * 3) }, () => [
          (r() * 2 - 1) * 46, (r() * 2 - 1) * 12, 22 + r() * 30, 11 + r() * 12,
        ]),
      });
    }

    // 지층 경계 흔들림 위상
    sc.strataPhase = th.strata.map(() => [r() * 9, 0.004 + r() * 0.006, 4 + r() * 9]);

    // 표면 디테일 위치 (지형이 파괴돼도 현재 높이에 맞춰 그림)
    sc.details = [];
    const gap = th.detail === 'urban' ? 44 : 26;
    for (let x = 12; x < W - 12; x += gap * (0.6 + r() * 0.9)) {
      sc.details.push({ x: Math.round(x), k: r(), h: 0.55 + r() * 0.9, f: r() < 0.5 ? 1 : -1 });
    }

    // 날씨 입자
    sc.weather = [];
    const wc = { snow: 200, sand: 170, ash: 130, dust: 90, none: 0 }[th.weather] || 0;
    for (let i = 0; i < wc; i++) {
      sc.weather.push({
        x: r() * W, y: r() * H,
        vx: (r() * 2 - 1), vy: 0.3 + r() * 1.4,
        r: 0.7 + r() * 2.1, a: 0.25 + r() * 0.6, p: r() * 7,
      });
    }

    sc.noise = makeNoise(seed);
    return sc;
  }

  /** 오프스크린 노이즈 텍스처 (패턴으로 재사용) */
  function makeNoise(seed) {
    const n = 128;
    const cv = document.createElement('canvas');
    cv.width = n; cv.height = n;
    const c = cv.getContext('2d');
    const r = Terrain.rng((seed ^ 0x1f2e3d4c) >>> 0);
    c.clearRect(0, 0, n, n);
    for (let i = 0; i < 1500; i++) {
      const v = r();
      c.fillStyle = v < 0.5 ? `rgba(0,0,0,${0.06 + r() * 0.13})` : `rgba(255,255,255,${0.03 + r() * 0.08})`;
      const s = 1 + r() * 2.6;
      c.fillRect(r() * n, r() * n, s, s);
    }
    for (let i = 0; i < 70; i++) {
      c.fillStyle = `rgba(0,0,0,${0.05 + r() * 0.1})`;
      c.beginPath();
      c.ellipse(r() * n, r() * n, 2 + r() * 6, 1.5 + r() * 4, r() * 3, 0, Math.PI * 2);
      c.fill();
    }
    return cv;
  }

  function grads(ctx, sc) {
    if (sc.grads) return sc.grads;
    const th = sc.th;
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    for (const [p, c] of th.sky) sky.addColorStop(p, c);
    const deep = ctx.createLinearGradient(0, H * 0.45, 0, H);
    deep.addColorStop(0, 'rgba(0,0,0,0)');
    deep.addColorStop(1, 'rgba(0,0,0,0.26)');
    const vig = ctx.createRadialGradient(W / 2, H * 0.45, H * 0.34, W / 2, H * 0.5, H * 1.02);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, `rgba(0,0,0,${th.vignette})`);
    sc.pattern = ctx.createPattern(sc.noise, 'repeat');
    sc.grads = { sky, deep, vig };
    return sc.grads;
  }

  /* ═════════ 하늘 ═════════ */

  function drawSky(ctx, sc, t) {
    if (!sc) return;
    const th = sc.th, g = grads(ctx, sc);
    ctx.save();
    ctx.fillStyle = g.sky;
    ctx.fillRect(-40, -40, W + 80, H + 80);

    if (sc.stars) {
      for (const s of sc.stars) {
        const tw = 0.45 + Math.abs(Math.sin(t * s.s + s.p)) * 0.55;
        ctx.globalAlpha = tw;
        ctx.fillStyle = '#eaf2ff';
        ctx.fillRect(s.x, s.y, s.r, s.r);
      }
      ctx.globalAlpha = 1;
    }

    // 태양 / 달
    const L = th.light;
    const lx = W * L.x, ly = H * L.y;
    const halo = ctx.createRadialGradient(lx, ly, L.r * 0.4, lx, ly, L.r * 6.5);
    halo.addColorStop(0, hexA(L.glow, 0.55));
    halo.addColorStop(0.35, hexA(L.glow, 0.17));
    halo.addColorStop(1, hexA(L.glow, 0));
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(lx, ly, L.r * 6.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = L.core;
    ctx.beginPath(); ctx.arc(lx, ly, L.r, 0, Math.PI * 2); ctx.fill();
    if (L.kind === 'moon') {
      ctx.fillStyle = 'rgba(150,175,215,0.5)';
      for (const [dx, dy, rr] of [[-9, -6, 7], [8, 5, 5], [2, -12, 4], [12, -8, 3]]) {
        ctx.beginPath(); ctx.arc(lx + dx, ly + dy, rr, 0, Math.PI * 2); ctx.fill();
      }
    }

    // 구름
    for (const c of sc.clouds) {
      const x = wrap(c.x + t * c.v * 6, -220, W + 220);
      ctx.globalAlpha = c.a;
      ctx.fillStyle = sc.key === 'night' ? '#5a6a92' : sc.key === 'volcano' ? '#5b3b34' : '#ffffff';
      ctx.beginPath();
      for (const [ox, oy, rw, rh] of c.lobes) {
        ctx.ellipse(x + ox * c.s, c.y + oy * c.s, rw * c.s, rh * c.s, 0, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.globalAlpha = c.a * 0.4;
      ctx.fillStyle = 'rgba(20,30,60,0.5)';
      ctx.beginPath();
      for (const [ox, oy, rw, rh] of c.lobes) {
        ctx.ellipse(x + ox * c.s, c.y + (oy + rh * 0.55) * c.s, rw * c.s * 0.85, rh * c.s * 0.45, 0, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // 화산 원뿔
    if (sc.volcano) drawVolcano(ctx, sc, t);

    // 원경 능선
    for (const h of sc.hills) {
      ctx.beginPath();
      ctx.moveTo(0, H + 40);
      for (let i = 0; i < h.pts.length; i++) ctx.lineTo(i * 8, h.pts[i]);
      ctx.lineTo(W, H + 40);
      ctx.closePath();
      ctx.fillStyle = h.color;
      ctx.fill();
      if (h.haze) {
        ctx.save(); ctx.clip();
        ctx.fillStyle = th.fog;
        ctx.globalAlpha = h.haze;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
      if (h.snowcap) {
        ctx.save(); ctx.clip();
        ctx.strokeStyle = 'rgba(240,248,255,0.75)';
        ctx.lineWidth = 5;
        ctx.beginPath();
        for (let i = 0; i < h.pts.length; i++) ctx.lineTo(i * 8, h.pts[i] + 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // 도시 스카이라인
    if (sc.city) drawCity(ctx, sc, t);
    ctx.restore();
  }

  function drawVolcano(ctx, sc, t) {
    const v = sc.volcano;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(v.x - v.w / 2, v.base);
    ctx.lineTo(v.x - 26, v.base - v.h);
    ctx.lineTo(v.x + 22, v.base - v.h);
    ctx.lineTo(v.x + v.w / 2, v.base);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, v.base - v.h, 0, v.base);
    g.addColorStop(0, '#43201c');
    g.addColorStop(1, '#200f10');
    ctx.fillStyle = g;
    ctx.fill();
    // 분화구 발광 + 흘러내리는 용암
    const pulse = 0.6 + Math.sin(t * 1.3) * 0.25;
    const cg = ctx.createRadialGradient(v.x, v.base - v.h, 2, v.x, v.base - v.h, 78);
    cg.addColorStop(0, `rgba(255,190,90,${0.9 * pulse})`);
    cg.addColorStop(0.4, `rgba(255,90,20,${0.35 * pulse})`);
    cg.addColorStop(1, 'rgba(255,60,0,0)');
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.arc(v.x, v.base - v.h, 78, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = `rgba(255,140,40,${0.75 * pulse})`;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(v.x - 6, v.base - v.h + 4);
    ctx.quadraticCurveTo(v.x - 30, v.base - v.h * 0.55, v.x - 18, v.base - 6);
    ctx.moveTo(v.x + 10, v.base - v.h + 4);
    ctx.quadraticCurveTo(v.x + 34, v.base - v.h * 0.5, v.x + 30, v.base - 6);
    ctx.stroke();
    // 화산재 기둥
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = '#2a1a1a';
    for (let i = 0; i < 7; i++) {
      const k = i / 7;
      const yy = v.base - v.h - 20 - k * 210;
      const rr = 22 + k * 92;
      ctx.beginPath();
      ctx.ellipse(v.x + Math.sin(t * 0.4 + i) * (12 + k * 44), yy, rr, rr * 0.62, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawCity(ctx, sc, t) {
    ctx.save();
    const base = H * 0.63;
    for (const b of sc.city) {
      ctx.fillStyle = `rgba(${Math.round(11 * b.tone)},${Math.round(17 * b.tone)},${Math.round(36 * b.tone)},1)`;
      ctx.fillRect(b.x, base - b.h, b.w, b.h + 40);
      ctx.strokeStyle = 'rgba(90,130,210,0.16)';
      ctx.lineWidth = 1;
      ctx.strokeRect(b.x + 0.5, base - b.h + 0.5, b.w - 1, b.h);
      for (const [wx, wy, blink] of b.wins) {
        if (wy > b.h - 8) continue;
        const on = blink ? (Math.sin(t * 1.6 + wx + wy) > -0.2) : true;
        if (!on) continue;
        ctx.fillStyle = blink ? 'rgba(255,215,140,0.9)' : 'rgba(255,236,180,0.62)';
        ctx.fillRect(b.x + wx, base - b.h + wy, 5, 7);
      }
      if (b.anten) {
        ctx.strokeStyle = 'rgba(120,150,220,0.5)';
        ctx.beginPath();
        ctx.moveTo(b.x + b.w / 2, base - b.h);
        ctx.lineTo(b.x + b.w / 2, base - b.h - 26);
        ctx.stroke();
        ctx.fillStyle = Math.sin(t * 3) > 0 ? '#ff5a5a' : 'rgba(255,90,90,0.25)';
        ctx.beginPath(); ctx.arc(b.x + b.w / 2, base - b.h - 28, 2.4, 0, Math.PI * 2); ctx.fill();
      }
    }
    // 도시 광해
    const g = ctx.createLinearGradient(0, base - 180, 0, base);
    g.addColorStop(0, 'rgba(120,150,230,0)');
    g.addColorStop(1, 'rgba(140,170,235,0.14)');
    ctx.fillStyle = g;
    ctx.fillRect(0, base - 180, W, 180);
    ctx.restore();
  }

  /* ═════════ 지형 ═════════ */

  function terrainPath(ctx, ground) {
    ctx.beginPath();
    ctx.moveTo(0, H + 60);
    ctx.lineTo(0, ground[0]);
    for (let x = 3; x < W; x += 3) ctx.lineTo(x, ground[x]);
    ctx.lineTo(W - 1, ground[W - 1]);
    ctx.lineTo(W, H + 60);
    ctx.closePath();
  }

  /** 지하 단면(지층·텍스처·심도)은 변하지 않으므로 오프스크린에 한 번만 그린다 */
  function underground(sc) {
    if (sc.under) return sc.under;
    const th = sc.th;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');

    const S = th.strata;
    const top = H * 0.2;
    const yOf = (i, x) => {
      const ph = sc.strataPhase[i];
      return top + (H - top) * S[i][0]
        + Math.sin(x * ph[1] + ph[0]) * ph[2]
        + Math.sin(x * ph[1] * 2.7) * ph[2] * 0.3;
    };

    for (let i = 0; i < S.length; i++) {
      const y1 = i + 1 < S.length ? top + (H - top) * S[i + 1][0] : H + 60;
      c.fillStyle = S[i][1];
      c.beginPath();
      c.moveTo(0, y1 + 2);
      for (let x = 0; x <= W; x += 14) c.lineTo(x, yOf(i, x));
      c.lineTo(W, y1 + 2);
      c.closePath();
      c.fill();
      // 층 경계선 — 파괴된 단면에서 지층이 드러나 보이게
      if (i > 0) {
        c.strokeStyle = 'rgba(0,0,0,0.3)';
        c.lineWidth = 1.6;
        c.beginPath();
        for (let x = 0; x <= W; x += 14) c.lineTo(x, yOf(i, x));
        c.stroke();
        c.strokeStyle = 'rgba(255,255,255,0.09)';
        c.lineWidth = 1;
        c.beginPath();
        for (let x = 0; x <= W; x += 14) c.lineTo(x, yOf(i, x) + 1.6);
        c.stroke();
      }
    }

    // 노이즈 텍스처
    const pat = c.createPattern(sc.noise, 'repeat');
    if (pat) {
      c.globalAlpha = 0.85;
      c.fillStyle = pat;
      c.fillRect(0, top - 20, W, H - top + 80);
      c.globalAlpha = 1;
    }

    // 깊이 어둡게
    const deep = c.createLinearGradient(0, H * 0.45, 0, H);
    deep.addColorStop(0, 'rgba(0,0,0,0)');
    deep.addColorStop(1, 'rgba(0,0,0,0.26)');
    c.fillStyle = deep;
    c.fillRect(0, H * 0.45, W, H);

    sc.under = cv;
    return cv;
  }

  function drawTerrain(ctx, sc, ground, t) {
    if (!sc) return;
    const th = sc.th;
    grads(ctx, sc);
    ctx.save();
    terrainPath(ctx, ground);
    ctx.clip();

    ctx.drawImage(underground(sc), 0, 0);

    // 화산: 갈라진 틈의 용암 발광
    if (th.surface.ember) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const pulse = 0.5 + Math.sin(t * 1.7) * 0.2;
      for (let i = 0; i < sc.details.length; i += 3) {
        const d = sc.details[i];
        const y = ground[d.x] + 12 + d.k * 40;
        const rg = ctx.createRadialGradient(d.x, y, 0, d.x, y, 26);
        rg.addColorStop(0, `rgba(255,120,30,${0.3 * pulse * d.h})`);
        rg.addColorStop(1, 'rgba(255,60,0,0)');
        ctx.fillStyle = rg;
        ctx.fillRect(d.x - 26, y - 26, 52, 52);
      }
      ctx.restore();
    }
    ctx.restore();

    // ── 표면층 ──
    const su = th.surface;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = su.color;
    ctx.lineWidth = su.thick;
    ctx.beginPath();
    for (let x = 0; x < W; x += 3) ctx.lineTo(x, ground[x] + su.thick * 0.34);
    ctx.stroke();
    ctx.strokeStyle = su.hi;
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    for (let x = 0; x < W; x += 3) ctx.lineTo(x, ground[x] + 0.6);
    ctx.stroke();
    ctx.restore();

    drawSurfaceDetail(ctx, sc, ground, t);
  }

  function drawSurfaceDetail(ctx, sc, ground, t) {
    const kind = sc.th.detail;
    ctx.save();
    for (const d of sc.details) {
      const x = d.x;
      const y = ground[x];
      // 경사가 급하면 생략
      const slope = Math.abs(ground[Math.min(W - 1, x + 6)] - ground[Math.max(0, x - 6)]) / 12;
      if (slope > 0.85) continue;

      if (kind === 'grass') {
        ctx.strokeStyle = d.k < 0.4 ? '#67cf67' : '#3f9c46';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        for (let b = -1; b <= 1; b++) {
          const bx = x + b * 2.4;
          const sway = Math.sin(t * 1.6 + x * 0.05 + b) * 1.6;
          ctx.moveTo(bx, y);
          ctx.quadraticCurveTo(bx + sway, y - 5 * d.h, bx + sway * 2 + b, y - 9 * d.h);
        }
        ctx.stroke();
        if (d.k > 0.87) {
          ctx.fillStyle = ['#ffd94a', '#ff8fb1', '#e6e6ff'][Math.floor(d.k * 100) % 3];
          ctx.beginPath(); ctx.arc(x + 1, y - 9 * d.h, 1.7, 0, Math.PI * 2); ctx.fill();
        }
      } else if (kind === 'sand') {
        ctx.strokeStyle = 'rgba(255,235,190,0.5)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x - 9, y + 3);
        ctx.quadraticCurveTo(x, y + 1, x + 9, y + 3);
        ctx.stroke();
        if (d.k > 0.9) {
          ctx.fillStyle = '#8a6a3c';
          ctx.beginPath(); ctx.ellipse(x, y - 2, 3.4 * d.h, 2.4 * d.h, 0, 0, Math.PI * 2); ctx.fill();
        }
      } else if (kind === 'snow') {
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.beginPath();
        ctx.ellipse(x, y - 1, 8 * d.h, 3.4 * d.h, 0, Math.PI, 0);
        ctx.fill();
        if (d.k > 0.82) {
          ctx.fillStyle = 'rgba(190,220,240,0.9)';
          ctx.beginPath();
          ctx.moveTo(x - 3, y);
          ctx.lineTo(x, y - 13 * d.h);
          ctx.lineTo(x + 3, y);
          ctx.closePath(); ctx.fill();
        }
      } else if (kind === 'rock') {
        const rr = 3 + d.k * 5;
        ctx.fillStyle = d.k < 0.5 ? 'rgba(60,45,40,0.85)' : 'rgba(120,90,70,0.7)';
        ctx.beginPath();
        ctx.moveTo(x - rr, y + 1);
        ctx.lineTo(x - rr * 0.5, y - rr * d.h);
        ctx.lineTo(x + rr * 0.4, y - rr * 0.8 * d.h);
        ctx.lineTo(x + rr, y + 1);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.13)';
        ctx.lineWidth = 1; ctx.stroke();
      } else if (kind === 'urban') {
        if (d.k < 0.3) {
          // 가로등
          ctx.strokeStyle = '#3c4351'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 26 * d.h); ctx.stroke();
          ctx.beginPath(); ctx.arc(x, y - 27 * d.h, 2.6, 0, Math.PI * 2);
          ctx.fillStyle = '#ffd98a'; ctx.fill();
          const g2 = ctx.createRadialGradient(x, y - 27 * d.h, 1, x, y - 27 * d.h, 34);
          g2.addColorStop(0, 'rgba(255,210,130,0.28)');
          g2.addColorStop(1, 'rgba(255,200,120,0)');
          ctx.fillStyle = g2;
          ctx.beginPath(); ctx.arc(x, y - 27 * d.h, 34, 0, Math.PI * 2); ctx.fill();
        } else if (d.k < 0.55) {
          ctx.fillStyle = 'rgba(45,52,64,0.9)';
          ctx.fillRect(x - 5, y - 8 * d.h, 10, 8 * d.h);
          ctx.fillStyle = 'rgba(90,100,118,0.7)';
          ctx.fillRect(x - 5, y - 8 * d.h, 10, 2);
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.09)';
          ctx.fillRect(x - 7, y + 2, 14, 2);
        }
      }
    }
    ctx.restore();
  }

  /* ═════════ 오버레이 ═════════ */

  function drawOverlay(ctx, sc, t) {
    if (!sc) return;
    const th = sc.th, g = grads(ctx, sc);
    const dt = Math.min(0.06, Math.max(0, t - sc.lastT));
    sc.lastT = t;

    if (sc.weather.length) {
      ctx.save();
      const kind = th.weather;
      for (const p of sc.weather) {
        p.x += (p.vx + (kind === 'sand' ? 4.2 : kind === 'ash' ? 0.8 : 0)) * dt * 60;
        p.y += p.vy * dt * 60 * (kind === 'ash' ? 0.5 : 1);
        if (p.y > H) { p.y = -6; p.x = Math.random() * W; }
        if (p.x > W + 8) p.x = -8;
        if (p.x < -8) p.x = W + 8;
        const sway = Math.sin(t * 1.4 + p.p) * (kind === 'snow' ? 9 : 3);
        ctx.globalAlpha = p.a * (kind === 'dust' ? 0.5 : 1);
        if (kind === 'snow') {
          ctx.fillStyle = '#ffffff';
          ctx.beginPath(); ctx.arc(p.x + sway, p.y, p.r, 0, Math.PI * 2); ctx.fill();
        } else if (kind === 'sand') {
          ctx.strokeStyle = 'rgba(240,205,150,0.7)';
          ctx.lineWidth = p.r * 0.7;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 16, p.y + 1.6); ctx.stroke();
        } else if (kind === 'ash') {
          ctx.fillStyle = p.a > 0.6 ? 'rgba(255,140,60,0.8)' : 'rgba(70,60,58,0.9)';
          ctx.fillRect(p.x + sway, p.y, p.r, p.r);
        } else {
          ctx.fillStyle = 'rgba(230,200,160,0.5)';
          ctx.beginPath(); ctx.arc(p.x + sway, p.y, p.r * 0.8, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    if (th.grade) {
      ctx.save();
      ctx.globalCompositeOperation = 'overlay';
      ctx.fillStyle = th.grade;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    ctx.save();
    ctx.fillStyle = g.vig;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  /* ═════════ 유틸 ═════════ */
  function wrap(v, lo, hi) {
    const span = hi - lo;
    return lo + (((v - lo) % span) + span) % span;
  }
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  return { THEMES, createScene, drawSky, drawTerrain, drawOverlay };
})();
