'use strict';
/* fx.js — 파티클 · 폭발 · 화면 효과
 * 오프스크린 스프라이트 + 객체 풀. 매 프레임 새 그라디언트를 만들지 않습니다.
 */
const FX = (() => {
  const BACK_CAP = 260;
  const FRONT_CAP = 640;

  /* ═════════ 스프라이트 ═════════ */
  function sprite(size, paint) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    paint(cv.getContext('2d'), size);
    return cv;
  }

  function radial(size, stops) {
    return sprite(size, (c, s) => {
      const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      for (const [p, col] of stops) g.addColorStop(p, col);
      c.fillStyle = g;
      c.fillRect(0, 0, s, s);
    });
  }

  const SP = {};
  function buildSprites() {
    if (SP.built) return;
    SP.built = true;
    // 연기 — 톤별로 미리 렌더
    const smokeStops = (r, g, b) => [
      [0, `rgba(${r},${g},${b},0.92)`],
      [0.42, `rgba(${r},${g},${b},0.55)`],
      [0.75, `rgba(${r},${g},${b},0.18)`],
      [1, `rgba(${r},${g},${b},0)`],
    ];
    SP.smokeDark = radial(96, smokeStops(38, 36, 38));
    SP.smokeMid = radial(96, smokeStops(104, 100, 98));
    SP.smokeLite = radial(96, smokeStops(196, 194, 190));
    SP.smokeDirt = radial(96, smokeStops(124, 92, 58));
    SP.smokeSand = radial(96, smokeStops(206, 174, 120));
    SP.smokeIce = radial(96, smokeStops(168, 214, 242));
    // 화염 (가산합성용)
    SP.fire = radial(96, [
      [0, 'rgba(255,255,236,1)'],
      [0.22, 'rgba(255,224,150,0.95)'],
      [0.48, 'rgba(255,146,42,0.7)'],
      [0.78, 'rgba(190,52,10,0.25)'],
      [1, 'rgba(120,20,0,0)'],
    ]);
    SP.flashCore = radial(128, [
      [0, 'rgba(255,255,255,1)'],
      [0.3, 'rgba(255,246,214,0.8)'],
      [0.62, 'rgba(255,190,110,0.28)'],
      [1, 'rgba(255,140,60,0)'],
    ]);
    SP.iceCore = radial(96, [
      [0, 'rgba(255,255,255,1)'],
      [0.3, 'rgba(200,240,255,0.85)'],
      [0.65, 'rgba(110,190,240,0.3)'],
      [1, 'rgba(60,140,220,0)'],
    ]);
  }

  /* ═════════ 풀 ═════════ */
  function makePool(cap) {
    const a = new Array(cap);
    for (let i = 0; i < cap; i++) a[i] = { alive: false };
    return { a, i: 0, cap, live: 0 };
  }
  const back = makePool(BACK_CAP);
  const front = makePool(FRONT_CAP);

  function take(pool) {
    // 죽은 슬롯 우선, 없으면 라운드로빈으로 가장 오래된 것 재사용
    for (let k = 0; k < 12; k++) {
      const p = pool.a[pool.i];
      pool.i = (pool.i + 1) % pool.cap;
      if (!p.alive) { p.alive = true; pool.live++; return p; }
    }
    const p = pool.a[pool.i];
    pool.i = (pool.i + 1) % pool.cap;
    p.alive = true;
    return p;
  }

  function init(p, o) {
    p.type = o.type;
    p.x = o.x; p.y = o.y;
    p.vx = o.vx || 0; p.vy = o.vy || 0;
    p.age = 0; p.life = o.life;
    p.r0 = o.r0; p.r1 = o.r1 != null ? o.r1 : o.r0;
    p.rot = o.rot || 0; p.vr = o.vr || 0;
    p.grav = o.grav || 0;
    p.drag = o.drag != null ? o.drag : 0.86;
    p.alpha = o.alpha != null ? o.alpha : 1;
    p.color = o.color || '#ffffff';
    p.sprite = o.sprite || null;
    p.windK = o.windK != null ? o.windK : 1;
    return p;
  }

  let wind = 0;
  let shakeV = 0;
  let flashV = 0, flashColor = '#ffffff';

  /* ═════════ 스폰 API ═════════ */

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];

  function smokePuff(pool, x, y, r, life, spriteName, up, alpha) {
    init(take(pool), {
      type: 'smoke', x, y,
      vx: rand(-16, 16), vy: -up * rand(0.55, 1.25),
      life, r0: r * rand(0.5, 0.8), r1: r * rand(1.7, 2.7),
      rot: rand(0, 6.28), vr: rand(-0.5, 0.5),
      grav: -6, drag: 0.7, alpha: alpha != null ? alpha : rand(0.4, 0.72),
      sprite: SP[spriteName] || SP.smokeMid, windK: 1.5,
    });
  }

  function fireBlob(x, y, r, life, spd) {
    const a = rand(0, 6.283);
    init(take(front), {
      type: 'fire', x, y,
      vx: Math.cos(a) * spd, vy: Math.sin(a) * spd * 0.8 - spd * 0.25,
      life, r0: r * rand(0.7, 1.15), r1: r * rand(0.15, 0.4),
      grav: -30, drag: 0.5, alpha: 1, sprite: SP.fire, windK: 0.4,
    });
  }

  function explosion(x, y, radius, kind) {
    buildSprites();
    kind = kind || 'normal';
    const R = Math.max(6, radius);
    const k = R / 34;

    if (kind === 'small') {
      init(take(front), { type: 'fire', x, y, life: 0.26, r0: R * 1.5, r1: R * 0.4, sprite: SP.flashCore, alpha: 1, drag: 1, windK: 0 });
      for (let i = 0; i < 4; i++) fireBlob(x, y, R * 0.6, rand(0.16, 0.3), rand(30, 80));
      for (let i = 0; i < 3; i++) smokePuff(front, x, y, R * 0.7, rand(0.5, 0.9), 'smokeMid', 20);
      spark(x, y, 5);
      debris(x, y, 4, '#6b4a2a');
      return;
    }

    if (kind === 'fire') {
      for (let i = 0; i < 3; i++) fireBlob(x, y, R * 0.9, rand(0.3, 0.6), rand(8, 30));
      if (Math.random() < 0.4) smokePuff(front, x, y - 6, R * 0.9, rand(0.9, 1.6), 'smokeDark', 28, 0.32);
      if (Math.random() < 0.3) spark(x, y, 2);
      return;
    }

    if (kind === 'ice') {
      init(take(front), { type: 'fire', x, y, life: 0.34, r0: R * 1.9, r1: R * 0.5, sprite: SP.iceCore, alpha: 1, drag: 1, windK: 0 });
      for (let i = 0; i < 16 + k * 6; i++) {
        const a = rand(0, 6.283), sp = rand(60, 240) * (0.6 + k * 0.3);
        init(take(front), {
          type: 'shard', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40,
          life: rand(0.5, 1.1), r0: rand(2.5, 6), rot: rand(0, 6.28), vr: rand(-9, 9),
          grav: 420, drag: 0.92, color: pick(['#cfefff', '#9fdcff', '#ffffff', '#7ec8f0']), windK: 0.3,
        });
      }
      for (let i = 0; i < 6; i++) smokePuff(front, x, y, R * 0.9, rand(0.7, 1.3), 'smokeIce', 18, 0.4);
      return;
    }

    if (kind === 'quake') {
      for (let i = 0; i < 12 + k * 5; i++) {
        smokePuff(front, x + rand(-R, R), y + rand(-8, 14), R * rand(0.6, 1.1), rand(1.1, 2.1), 'smokeDirt', 14, rand(0.35, 0.6));
      }
      for (let i = 0; i < 4; i++) fireBlob(x, y, R * 0.35, rand(0.18, 0.3), rand(20, 60));
      debris(x, y, 14 + k * 4, '#6b4a2a');
      ring(x, y, R * 2.2, 0.5, 'rgba(180,150,110,0.5)');
      return;
    }

    const nuke = kind === 'nuke';
    const tank = kind === 'tank';

    // 1) 코어 섬광
    init(take(front), {
      type: 'fire', x, y, life: nuke ? 0.5 : 0.26,
      r0: R * (nuke ? 3.4 : 1.9), r1: R * 0.5,
      sprite: SP.flashCore, alpha: 1, drag: 1, windK: 0,
    });
    // 2) 화구
    const blobs = Math.round((nuke ? 17 : 10) + k * 4);
    for (let i = 0; i < blobs; i++) {
      fireBlob(x, y, R * rand(0.5, 0.95), rand(0.22, 0.5) * (nuke ? 1.8 : 1), rand(40, 140) * (0.5 + k * 0.4));
    }
    // 3) 충격파
    ring(x, y, R * (nuke ? 5 : 2.6), nuke ? 0.75 : 0.42, nuke ? 'rgba(255,235,190,0.7)' : 'rgba(255,220,170,0.55)');
    if (nuke) ring(x, y, R * 8, 1.1, 'rgba(255,180,120,0.35)');

    // 4) 연기
    const smokeN = Math.round((nuke ? 15 : 9) + k * 3);
    const tone = tank ? 'smokeDark' : nuke ? 'smokeDark' : pick(['smokeDark', 'smokeMid', 'smokeDirt']);
    for (let i = 0; i < smokeN; i++) {
      smokePuff(front, x + rand(-R * 0.6, R * 0.6), y + rand(-R * 0.4, R * 0.3),
        R * rand(0.55, 1.05), rand(1.0, 2.2) * (nuke ? 1.9 : 1), tone, nuke ? 55 : 26);
    }
    // 5) 핵: 버섯구름 (기둥 + 캡)
    if (nuke) {
      for (let i = 0; i < 10; i++) {
        const h = i / 10;
        init(take(front), {
          type: 'smoke', x: x + rand(-16, 16), y,
          vx: rand(-8, 8), vy: -rand(120, 190) * (1 - h * 0.35),
          life: 2.6 + h * 1.4, r0: R * 0.4, r1: R * (0.9 + h * 0.5),
          rot: rand(0, 6.28), vr: rand(-0.4, 0.4), grav: -8, drag: 0.82,
          alpha: 0.6, sprite: SP.smokeDark, windK: 0.7,
        });
      }
      for (let i = 0; i < 9; i++) {
        const a = rand(0, 6.283);
        init(take(front), {
          type: 'smoke', x, y,
          vx: Math.cos(a) * rand(50, 130), vy: -rand(150, 210),
          life: 3.4, r0: R * 0.6, r1: R * 1.9,
          rot: rand(0, 6.28), vr: rand(-0.3, 0.3), grav: -14, drag: 0.9,
          alpha: 0.55, sprite: SP.smokeMid, windK: 0.8,
        });
      }
    }
    // 6) 파편 · 스파크 · 지면 먼지
    debris(x, y, Math.round((tank ? 18 : 10) + k * 6), tank ? '#7a7f8c' : '#6b4a2a');
    spark(x, y, Math.round(8 + k * 6));
    for (let i = 0; i < 5 + k * 3; i++) {
      smokePuff(back, x + rand(-R, R), y + rand(0, 10), R * rand(0.7, 1.3), rand(0.8, 1.7), 'smokeDirt', 8, 0.4);
    }
  }

  function ring(x, y, r, life, color) {
    buildSprites();
    init(take(front), {
      type: 'ring', x, y, life, r0: r * 0.12, r1: r,
      color, alpha: 1, drag: 1, windK: 0,
    });
  }

  function debris(x, y, n, color) {
    buildSprites();
    for (let i = 0; i < n; i++) {
      const a = rand(-Math.PI, 0);
      const sp = rand(90, 340);
      init(take(front), {
        type: 'debris', x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: rand(0.7, 1.5), r0: rand(1.6, 4.4),
        rot: rand(0, 6.28), vr: rand(-14, 14),
        grav: 780, drag: 0.98, color, windK: 0.15,
      });
    }
  }

  function spark(x, y, n) {
    buildSprites();
    for (let i = 0; i < n; i++) {
      const a = rand(0, 6.283), sp = rand(120, 420);
      init(take(front), {
        type: 'spark', x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60,
        life: rand(0.25, 0.7), r0: rand(1, 2.2),
        grav: 520, drag: 0.9,
        color: pick(['#fff3c4', '#ffc14d', '#ff8a2a']), windK: 0.4,
      });
    }
  }

  function muzzle(x, y, angleRad, power) {
    buildSprites();
    const p = 0.5 + power * 0.9;
    init(take(front), {
      type: 'fire', x: x + Math.cos(angleRad) * 6, y: y + Math.sin(angleRad) * 6,
      life: 0.16, r0: 26 * p, r1: 6, sprite: SP.flashCore, alpha: 1, drag: 1, windK: 0,
    });
    for (let i = 0; i < 8; i++) {
      const a = angleRad + rand(-0.35, 0.35);
      const sp = rand(120, 340) * p;
      init(take(front), {
        type: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: rand(0.14, 0.34), r0: rand(1, 2.4), grav: 260, drag: 0.88,
        color: pick(['#fff6d0', '#ffcf6a']), windK: 0.3,
      });
    }
    for (let i = 0; i < 4; i++) {
      init(take(front), {
        type: 'smoke',
        x: x + Math.cos(angleRad) * rand(4, 26), y: y + Math.sin(angleRad) * rand(4, 26),
        vx: Math.cos(angleRad) * rand(20, 70), vy: Math.sin(angleRad) * rand(20, 70) - 12,
        life: rand(0.6, 1.1), r0: 9, r1: 30, rot: rand(0, 6.28), vr: rand(-1, 1),
        grav: -12, drag: 0.72, alpha: 0.42, sprite: SP.smokeLite, windK: 1.4,
      });
    }
  }

  let trailTick = 0;
  function trail(x, y, kind) {
    buildSprites();
    if (++trailTick % 3) return;
    const ice = kind === 'ice';
    init(take(back), {
      type: 'smoke', x, y, vx: rand(-8, 8), vy: rand(-14, -4),
      life: rand(0.35, 0.7), r0: 3.5, r1: 13,
      rot: rand(0, 6.28), vr: rand(-1, 1), grav: -10, drag: 0.8,
      alpha: 0.3, sprite: ice ? SP.smokeIce : SP.smokeLite, windK: 1.2,
    });
  }

  function dust(x, y, dir) {
    buildSprites();
    if (Math.random() > 0.4) return;
    init(take(back), {
      type: 'smoke', x, y, vx: (dir || 0) * rand(10, 40) + rand(-8, 8), vy: rand(-16, -4),
      life: rand(0.4, 0.8), r0: 5, r1: 17, rot: rand(0, 6.28), vr: rand(-1, 1),
      grav: -6, drag: 0.76, alpha: 0.32, sprite: SP.smokeSand, windK: 1.3,
    });
  }

  function smokeColumn(x, y, level) {
    buildSprites();
    init(take(front), {
      type: 'smoke', x: x + rand(-4, 4), y, vx: rand(-6, 6), vy: -rand(24, 46),
      life: rand(1.3, 2.4), r0: 6 * (level || 1), r1: 30 * (level || 1),
      rot: rand(0, 6.28), vr: rand(-0.6, 0.6), grav: -12, drag: 0.85,
      alpha: 0.38, sprite: SP.smokeDark, windK: 1.6,
    });
  }

  function shockwave(x, y, r) { ring(x, y, r, 0.5, 'rgba(255,230,190,0.5)'); }

  /* ═════════ 업데이트 ═════════ */

  function updatePool(pool, dt) {
    let live = 0;
    for (let i = 0; i < pool.cap; i++) {
      const p = pool.a[i];
      if (!p.alive) continue;
      p.age += dt;
      if (p.age >= p.life) { p.alive = false; continue; }
      live++;
      if (p.type !== 'ring') {
        p.vx += wind * 3.2 * p.windK * dt;
        p.vy += p.grav * dt;
        const d = Math.pow(p.drag, dt * 60);
        p.vx *= d; p.vy *= d;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
      }
    }
    pool.live = live;
  }

  function update(dt) {
    dt = Math.min(0.05, dt);
    updatePool(back, dt);
    updatePool(front, dt);
    shakeV = Math.max(0, shakeV - dt * 2.4);
    flashV = Math.max(0, flashV - dt * 3.4);
  }

  /* ═════════ 렌더 ═════════ */

  function drawSmokeLike(ctx, pool) {
    for (let i = 0; i < pool.cap; i++) {
      const p = pool.a[i];
      if (!p.alive) continue;
      const k = p.age / p.life;
      if (p.type === 'smoke') {
        const r = Math.min(120, p.r0 + (p.r1 - p.r0) * k);
        ctx.globalAlpha = p.alpha * (k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.drawImage(p.sprite, -r, -r, r * 2, r * 2);
        ctx.restore();
      } else if (p.type === 'debris') {
        ctx.globalAlpha = 1 - Math.max(0, k - 0.7) / 0.3;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.r0, -p.r0 * 0.62, p.r0 * 2, p.r0 * 1.24);
        ctx.restore();
      } else if (p.type === 'shard') {
        ctx.globalAlpha = 1 - k;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(0, -p.r0);
        ctx.lineTo(p.r0 * 0.62, p.r0);
        ctx.lineTo(-p.r0 * 0.62, p.r0 * 0.7);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawAdditive(ctx, pool) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < pool.cap; i++) {
      const p = pool.a[i];
      if (!p.alive) continue;
      const k = p.age / p.life;
      if (p.type === 'fire') {
        const r = p.r0 + (p.r1 - p.r0) * k;
        ctx.globalAlpha = (1 - k) * p.alpha;
        ctx.drawImage(p.sprite, p.x - r, p.y - r, r * 2, r * 2);
      } else if (p.type === 'spark') {
        ctx.globalAlpha = 1 - k;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.r0;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.016, p.y - p.vy * 0.016);
        ctx.stroke();
      } else if (p.type === 'ring') {
        const r = p.r0 + (p.r1 - p.r0) * Math.sqrt(k);
        ctx.globalAlpha = (1 - k) * 0.9;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(1, 7 * (1 - k));
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, r, r * 0.82, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function drawBack(ctx) {
    ctx.save();
    drawSmokeLike(ctx, back);
    drawAdditive(ctx, back);
    ctx.restore();
  }

  function drawFront(ctx) {
    ctx.save();
    drawSmokeLike(ctx, front);
    drawAdditive(ctx, front);
    ctx.restore();
  }

  /* ═════════ 화면 효과 ═════════ */
  function shake(v) { shakeV = Math.min(1.3, Math.max(shakeV, v)); }
  function flash(v, color) { if (v > flashV) { flashV = Math.min(1, v); flashColor = color || '#ffffff'; } }

  function reset() {
    for (const pool of [back, front]) {
      for (let i = 0; i < pool.cap; i++) pool.a[i].alive = false;
      pool.live = 0; pool.i = 0;
    }
    shakeV = 0; flashV = 0; wind = 0;
  }

  return {
    reset, update, drawBack, drawFront,
    explosion, muzzle, trail, debris, dust, smokeColumn, shockwave, spark, ring,
    flash, shake,
    setWind(w) { wind = w || 0; },
    shakeAmount() { return shakeV; },
    flashAmount() { return { a: flashV * 0.85, color: flashColor }; },
    count() { return back.live + front.live; },
  };
})();
