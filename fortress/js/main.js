'use strict';
/* main.js — 설정 화면, 전차 격납고, 게임 HUD, 입력 */
(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const MODES = [
    { id: 'ffa', label: '개인전', teams: 0 },
    { id: 'team2', label: '2팀전', teams: 2 },
    { id: 'team3', label: '3팀전', teams: 3 },
  ];
  const DIFFS = [
    { id: 'easy', label: '쉬움' },
    { id: 'normal', label: '보통' },
    { id: 'hard', label: '어려움' },
  ];

  const setup = { count: 4, mode: 'ffa', difficulty: 'normal', theme: 'random', runMode: 'single', slots: [] };
  let game = null;
  let lastCfg = null;
  let run = null;          // { mode, stage, cfg, done }
  let shopStock = null;
  let activePilot = 0;
  let detailId = TANK_TYPES[0].id;
  let clsFilter = 'all';
  let detailRaf = 0;
  let audioStarted = false;

  /* ─────────────── 오디오 시동 (첫 클릭) ─────────────── */
  function bootAudio() {
    if (audioStarted) return;
    audioStarted = true;
    AudioCore.resume();
    if (typeof Music !== 'undefined' && Music.start) {
      Music.onTrack = (tr) => { const el = $('#npText'); if (el && tr) el.textContent = `${tr.title} · ${tr.composer}`; };
      Music.start();
    }
  }
  window.addEventListener('pointerdown', bootAudio, { once: true });
  window.addEventListener('keydown', bootAudio, { once: true });

  /* ═══════════════ 설정 화면 ═══════════════ */

  function themeOptions() {
    const list = [{ id: 'random', label: '무작위' }];
    const themes = (typeof Gfx !== 'undefined' && Gfx.THEMES) ? Gfx.THEMES : {};
    for (const k in themes) list.push({ id: k, label: themes[k].name || k });
    return list;
  }

  function teamCount() { return (MODES.find((m) => m.id === setup.mode) || MODES[0]).teams; }

  function seg(el, items, getter, setter) {
    if (!el) return;
    el.innerHTML = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn' + (getter() === it.id ? ' is-active' : '');
      b.textContent = it.label;
      b.addEventListener('click', () => { setter(it.id); if (typeof Sfx !== 'undefined' && Sfx.click) Sfx.click(); renderMenu(); });
      el.appendChild(b);
    }
  }

  function syncSlots() {
    const tc = teamCount();
    while (setup.slots.length < setup.count) {
      const i = setup.slots.length;
      setup.slots.push({
        name: i === 0 ? '플레이어' : `AI ${i}`,
        type: i === 0 ? 'human' : 'ai',
        team: 0,
        tank: TANK_TYPES[Math.floor(Math.random() * TANK_TYPES.length)].id,
      });
    }
    setup.slots.length = setup.count;
    if (tc > 0) setup.slots.forEach((s, i) => { if (s.team >= tc) s.team = i % tc; });
    if (activePilot >= setup.count) activePilot = 0;
  }

  function assignTeamsRoundRobin() {
    const tc = teamCount();
    if (tc > 0) setup.slots.forEach((s, i) => { s.team = i % tc; });
  }

  function renderSlots() {
    const tc = teamCount();
    const wrap = $('#slots');
    wrap.innerHTML = '';
    setup.slots.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'slot';

      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = PLAYER_COLORS[i];

      const name = document.createElement('input');
      name.value = s.name;
      name.maxLength = 10;
      name.placeholder = `플레이어 ${i + 1}`;
      name.addEventListener('input', () => { s.name = name.value; renderPilots(); });

      const type = document.createElement('select');
      type.innerHTML = '<option value="human">사람</option><option value="ai">AI</option>';
      type.value = s.type;
      type.addEventListener('change', () => {
        s.type = type.value;
        if (s.type === 'ai' && /^플레이어/.test(s.name)) { s.name = `AI ${i}`; name.value = s.name; }
        if (s.type === 'human' && /^AI/.test(s.name)) { s.name = '플레이어'; name.value = s.name; }
        updateHint(); renderPilots();
      });

      row.append(sw, name, type);

      if (tc > 0) {
        const team = document.createElement('select');
        for (let k = 0; k < tc; k++) {
          const o = document.createElement('option');
          o.value = String(k); o.textContent = `${TEAM_LABELS[k]}팀`;
          team.appendChild(o);
        }
        team.value = String(s.team);
        team.addEventListener('change', () => { s.team = +team.value; updateHint(); renderPilots(); });
        row.appendChild(team);
      }
      wrap.appendChild(row);
    });
    updateHint();
  }

  function updateHint() {
    const humans = setup.slots.filter((s) => s.type === 'human').length;
    const tc = teamCount();
    let txt = humans === 0 ? '관전 모드 (AI 대 AI)' : `사람 ${humans} · AI ${setup.count - humans}`;
    if (tc > 0) {
      const sizes = Array.from({ length: tc }, (_, k) => setup.slots.filter((s) => s.team === k).length);
      txt += ' · ' + sizes.map((n, k) => `${TEAM_LABELS[k]}${n}`).join(':');
    }
    $('#slotsHint').textContent = txt;
  }

  function renderWallet() {
    $('#walletVal').textContent = Profile.credits.toLocaleString();
    $('#invCount').textContent = Profile.inventory.length;
    const s = Profile.stats;
    const parts = [`전적 ${s.wins}승 / ${s.matches}판`, `격파 ${s.kills}`, `모듈 ${Profile.modules.length}/${Profile.MOD_MAX}`];
    if (s.bestEndless) parts.push(`무한 최고 ${s.bestEndless}판`);
    $('#walletStats').textContent = parts.join(' · ');
  }

  function renderMenu() {
    syncSlots();
    const modes = Object.keys(Profile.MODES).map((k) => ({ id: k, label: Profile.MODES[k].label }));
    seg($('#segRun'), modes, () => setup.runMode, (v) => { setup.runMode = v; });
    $('#runDesc').textContent = Profile.MODES[setup.runMode].desc;
    seg($('#segCount'), [2, 3, 4, 5, 6].map((n) => ({ id: n, label: `${n}인` })), () => setup.count,
      (v) => { setup.count = v; syncSlots(); assignTeamsRoundRobin(); });
    seg($('#segMode'), MODES, () => setup.mode,
      (v) => { setup.mode = v; syncSlots(); assignTeamsRoundRobin(); });
    seg($('#segDiff'), DIFFS, () => setup.difficulty, (v) => { setup.difficulty = v; });
    seg($('#segTheme'), themeOptions(), () => setup.theme, (v) => { setup.theme = v; });
    renderSlots();
    renderWallet();
  }

  function validate() {
    const tc = teamCount();
    if (tc > 0) {
      const used = new Set(setup.slots.map((s) => s.team));
      if (used.size < 2) return '팀전은 서로 다른 팀이 2개 이상 필요합니다.';
      if (setup.count < 2) return '2명 이상이어야 합니다.';
    }
    return null;
  }

  /* ═══════════════ 격납고 (전차 선택) ═══════════════ */

  function drawTankInto(cv, typeId, color, opts) {
    const c = cv.getContext('2d');
    const type = tankType(typeId);
    const art = TankArt.get(typeId);
    opts = opts || {};
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cv.width, cv.height);

    const scale = (opts.scale || 2) * type.size;
    const gy = cv.height * (opts.groundY || 0.74);

    // 바닥 그림자 + 받침대
    c.save();
    c.fillStyle = 'rgba(0,0,0,0.4)';
    c.beginPath();
    c.ellipse(cv.width / 2, gy + 3, 34 * scale * 0.55, 6 * scale * 0.35, 0, 0, Math.PI * 2);
    c.fill();
    c.restore();

    c.save();
    c.translate(cv.width / 2, gy);
    c.scale(scale, scale);
    const st = {
      p: TankArt.pal(color), color, roll: opts.roll || 0, t: opts.t || 0,
      dead: false, hpFrac: 1, charge: opts.charge || 0,
      len: (art && art.barrelLen) || type.barrel,
    };
    try {
      if (art && art.draw) art.draw(c, st);
      else { TankArt.box(c, -16, -12, 32, 12, 4, { p: st.p }); TankArt.box(c, -12, -23, 24, 12, 5, { p: st.p, fill: color }); }
      c.save();
      const piv = (art && art.pivot) || [2, -19];
      c.translate(piv[0], piv[1]);
      c.rotate((-(opts.elev != null ? opts.elev : 32) * Math.PI) / 180);
      if (art && art.barrel) art.barrel(c, st);
      else TankArt.barrelStd(c, st, {});
      c.restore();
    } catch (e) {
      c.restore();
      c.fillStyle = color;
      c.fillRect(-14, -20, 28, 20);
      return;
    }
    c.restore();
  }

  function statBars(type) {
    const norm = (v, lo, hi) => clamp((v - lo) / (hi - lo), 0.04, 1);
    return [
      { key: '체력', v: norm(type.hp, 76, 148), text: String(type.hp) },
      { key: '방어', v: norm(1.24 - type.armor, 0, 0.46), text: `${Math.round((1.24 - type.armor) * 220)}` },
      { key: '기동', v: norm(type.fuel, 80, 215), text: String(type.fuel) },
      { key: '사거리', v: norm(type.power, 0.93, 1.09), text: `${Math.round(type.power * 100)}` },
    ];
  }

  function randomTankId() {
    return TANK_TYPES[Math.floor(Math.random() * TANK_TYPES.length)].id;
  }

  /** 사람이 직접 고를 수 있는 슬롯 — 전원 AI(관전)일 때만 모든 슬롯이 대상 */
  function selectableSlots() {
    const humans = setup.slots.map((s, i) => (s.type === 'human' ? i : -1)).filter((i) => i >= 0);
    return humans.length ? humans : setup.slots.map((_, i) => i);
  }

  function renderPilots() {
    const strip = $('#pilotStrip');
    const sel = selectableSlots();
    strip.innerHTML = '';
    setup.slots.forEach((s, i) => {
      const pickable = sel.indexOf(i) >= 0;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pilot' + (i === activePilot ? ' is-active' : '') + (pickable ? '' : ' is-locked');
      b.title = pickable ? '이 참가자의 전차를 고릅니다' : 'AI 전차는 무작위로 배정됩니다';
      const tt = tankType(s.tank);
      b.innerHTML =
        `<span class="dot" style="background:${PLAYER_COLORS[i]}"></span>` +
        `<span><span class="p-name">${esc(s.name)}</span><br><span class="p-tank">${esc(tt.name)}</span></span>` +
        `<span class="p-kind">${s.type === 'ai' ? '무작위' : '선택'}</span>`;
      if (pickable) {
        b.addEventListener('click', () => {
          activePilot = i;
          detailId = s.tank;
          renderPilots(); renderGrid(); renderDetail();
          if (typeof Sfx !== 'undefined' && Sfx.click) Sfx.click();
        });
      } else {
        b.disabled = true;
      }
      strip.appendChild(b);
    });
  }

  function renderFilter() {
    const wrap = $('#clsFilter');
    wrap.innerHTML = '';
    const opts = [{ id: 'all', label: `전체 ${TANK_TYPES.length}종` }].concat(
      Object.keys(TANK_CLASSES).map((k) => ({ id: k, label: TANK_CLASSES[k].label }))
    );
    for (const o of opts) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn' + (clsFilter === o.id ? ' is-active' : '');
      b.textContent = o.label;
      b.addEventListener('click', () => { clsFilter = o.id; renderFilter(); renderGrid(); });
      wrap.appendChild(b);
    }
  }

  function renderGrid() {
    const grid = $('#tankGrid');
    grid.innerHTML = '';
    const color = PLAYER_COLORS[activePilot];
    const list = TANK_TYPES.filter((t) => clsFilter === 'all' || t.cls === clsFilter);
    for (const type of list) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'tank-card' + (type.id === detailId ? ' is-sel' : '');
      card.dataset.id = type.id;

      const cv = document.createElement('canvas');
      cv.width = 220; cv.height = 132;
      card.appendChild(cv);

      const cls = TANK_CLASSES[type.cls];
      const nm = document.createElement('span');
      nm.className = 'c-name';
      nm.textContent = type.name;
      const meta = document.createElement('span');
      meta.className = 'c-meta';
      meta.innerHTML = `<span class="cls-chip" style="background:${cls.color}">${cls.label}</span>` +
        `<span class="p-tank">${type.weapons.slice(1).map((w) => WEAPONS[w].icon).join(' ')}</span>`;
      card.append(nm, meta);

      const takenBy = setup.slots.map((s, i) => (s.tank === type.id ? i : -1)).filter((i) => i >= 0);
      if (takenBy.length) {
        const tag = document.createElement('span');
        tag.className = 'c-taken';
        tag.style.color = PLAYER_COLORS[takenBy[0]];
        tag.textContent = takenBy.map((i) => `P${i + 1}`).join(',');
        card.appendChild(tag);
      }

      card.addEventListener('click', () => pickTank(type.id, true));
      card.addEventListener('mouseenter', () => { detailId = type.id; renderDetail(); markSelected(); });
      grid.appendChild(card);
      drawTankInto(cv, type.id, color, { scale: 2.05, elev: 30, groundY: 0.78 });
    }
  }

  function markSelected() {
    $$('#tankGrid .tank-card').forEach((c) => c.classList.toggle('is-sel', c.dataset.id === detailId));
  }

  function renderDetail() {
    const type = tankType(detailId);
    const cls = TANK_CLASSES[type.cls];
    $('#detailName').textContent = type.name;
    $('#detailDesc').textContent = type.desc + (type.traits.length ? `  [${type.traits.join(' · ')}]` : '');
    const chip = $('#detailCls');
    chip.textContent = cls.label;
    chip.style.background = cls.color;

    const sl = $('#detailStats');
    sl.innerHTML = '';
    for (const s of statBars(type)) {
      const d = document.createElement('div');
      d.className = 'stat';
      d.innerHTML = `<span>${s.key}</span><span class="stat-bar"><i style="width:${(s.v * 100).toFixed(0)}%"></i></span><b>${s.text}</b>`;
      sl.appendChild(d);
    }

    const wl = $('#detailWeapons');
    wl.innerHTML = '';
    for (const id of type.weapons) {
      const w = WEAPONS[id];
      const d = document.createElement('div');
      d.className = 'wpn-row';
      d.innerHTML = `<span class="w-ico">${w.icon}</span>` +
        `<span class="w-txt"><b>${w.name}</b><small>${esc(w.desc)}</small></span>` +
        `<span class="w-amt">${w.ammo === Infinity ? '∞' : w.ammo + '발'}</span>`;
      wl.appendChild(d);
    }
    markSelected();
  }

  function animateDetail() {
    cancelAnimationFrame(detailRaf);
    const cv = $('#detailCanvas');
    const t0 = performance.now();
    const step = (now) => {
      if (!$('#garage').classList.contains('is-active')) return;
      const t = (now - t0) / 1000;
      drawTankInto(cv, detailId, PLAYER_COLORS[activePilot], {
        scale: 3.5, elev: 28 + Math.sin(t * 0.9) * 16, roll: t * 26, t, groundY: 0.8,
      });
      detailRaf = requestAnimationFrame(step);
    };
    detailRaf = requestAnimationFrame(step);
  }

  function pickTank(id, advance) {
    setup.slots[activePilot].tank = id;
    detailId = id;
    if (typeof Sfx !== 'undefined' && Sfx.select) Sfx.select();
    // 사람이 여러 명일 때만 다음 사람으로 넘어갑니다 (AI 슬롯은 건너뜁니다)
    if (advance) {
      const sel = selectableSlots();
      if (sel.length > 1) {
        const k = sel.indexOf(activePilot);
        activePilot = sel[(k + 1) % sel.length];
      }
    }
    renderPilots(); renderGrid(); renderDetail();
  }

  function openGarage() {
    const err = validate();
    if (err) { const e = $('#menuError'); e.textContent = err; e.hidden = false; return; }
    $('#menuError').hidden = true;
    // AI 전차는 자동으로 무작위 배정 — 사람은 자기 전차만 고릅니다
    const sel = selectableSlots();
    setup.slots.forEach((s, i) => { if (sel.indexOf(i) < 0) s.tank = randomTankId(); });
    activePilot = sel[0];
    detailId = setup.slots[activePilot].tank;
    showScreen('garage');
    renderPilots(); renderFilter(); renderGrid(); renderDetail(); animateDetail();
  }

  /** AI 전차만 다시 뽑습니다 (사람이 고른 전차는 유지) */
  function randomizeAll() {
    const sel = selectableSlots();
    setup.slots.forEach((s, i) => { if (sel.indexOf(i) < 0) s.tank = randomTankId(); });
    if (typeof Sfx !== 'undefined' && Sfx.select) Sfx.select();
    renderPilots(); renderGrid(); renderDetail();
  }

  /* ═══════════════ 화면 전환 ═══════════════ */

  function showScreen(id) {
    for (const s of ['menu', 'garage', 'shop', 'game']) {
      $('#' + s).classList.toggle('is-active', s === id);
    }
    if (id !== 'garage') cancelAnimationFrame(detailRaf);
    $('#audioPanel').hidden = true;
  }

  /* ═══════════════ 설명 툴팁 ═══════════════ */

  let tipEl = null;
  function tip() { if (!tipEl) tipEl = $('#tip'); return tipEl; }

  function tipShow(html, accent, ev) {
    const el = tip();
    el.innerHTML = html;
    el.style.borderLeftColor = accent || 'var(--line)';
    el.hidden = false;
    tipMove(ev);
  }
  function tipMove(ev) {
    const el = tip();
    if (el.hidden || !ev) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    let x = ev.clientX + 16, y = ev.clientY + 16;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - 14;
    if (y + h > window.innerHeight - 8) y = ev.clientY - h - 14;
    el.style.left = `${Math.max(8, x)}px`;
    el.style.top = `${Math.max(8, y)}px`;
  }
  function tipHide() { tip().hidden = true; }

  /** 요소에 툴팁 붙이기 — build() 는 {html, accent} 를 돌려줍니다 */
  function attachTip(el, build) {
    el.addEventListener('mouseenter', (e) => { const b = build(); if (b) tipShow(b.html, b.accent, e); });
    el.addEventListener('mousemove', tipMove);
    el.addEventListener('mouseleave', tipHide);
  }

  /** 아이템 인스턴스 → 툴팁 HTML */
  function itemTipHtml(inst, extra) {
    const def = itemDef(inst.id);
    if (!def) return null;
    const r = RARITY[def.rarity];
    const q = qualityOf(inst.roll != null ? inst.roll : 1);
    const dur = durationOf(inst);
    const tags =
      `<span class="tag" style="background:${r.color}">${r.label}</span>` +
      `<span class="tag" style="background:${q.color}">${q.label}</span>` +
      `<span class="tag ${inst.perm ? 'tag--perm' : 'tag--dur'}">${DURATION_LABEL[dur]}</span>` +
      `<span class="tag tag--cat">${ITEM_CATS[def.cat] || ''}</span>`;
    const meta = [];
    if (def.kind === 'active') meta.push(`사용 <b>${extra && extra.uses != null ? extra.uses : itemUses(inst)}회</b>`);
    if (inst.price) meta.push(`가치 <b>◈${inst.price}</b>`);
    meta.push(`성능 <b>${Math.round((inst.roll != null ? inst.roll : 1) * 100)}%</b>`);
    return {
      accent: inst.perm ? '#c07bff' : r.color,
      html:
        `<div class="tip-head"><span class="tip-ico">${def.icon}</span><span class="tip-name">${esc(itemName(inst))}</span></div>` +
        `<div class="tip-tags">${tags}</div>` +
        `<div class="tip-desc">${esc(itemDesc(inst))}</div>` +
        `<div class="tip-meta">${meta.join(' · ')}</div>`,
    };
  }

  /* ═══════════════ 진행(런) ═══════════════ */

  function stageLabel() {
    if (!run) return '';
    const total = Profile.MODES[run.mode].total;
    return Number.isFinite(total) ? `${run.stage + 1} / ${total}판` : `${run.stage + 1}판째`;
  }

  function startRun() {
    run = { mode: setup.runMode, stage: 0, cfg: buildConfig(), done: false };
    startStage();
  }

  function startStage() {
    if (!run) { startRun(); return; }
    const sc = Profile.scaling(run.stage);
    const cfg = Object.assign({}, run.cfg, {
      difficulty: Profile.tierUp(run.cfg.difficulty, sc.tier),
      theme: setup.theme === 'random' ? null : setup.theme,
      scaling: run.stage > 0 ? sc : null,
      loadout: Profile.inventory.slice(),
      modules: Profile.modules.slice(),
      stage: run.stage,
    });
    Profile.consumeAll();     // 출전과 함께 장비를 소모합니다
    startGame(cfg);
  }

  /* ═══════════════ 보급 상점 ═══════════════ */

  function ensureStock(force) {
    if (force || !shopStock) {
      const st = run ? run.stage : 0;
      shopStock = { supply: rollShopStock(6, st), mods: rollModuleStock(3, st) };
    }
    return shopStock;
  }

  function openShop() {
    ensureStock(false);
    showScreen('shop');
    $('#shopStage').textContent = run && !run.done
      ? `${Profile.MODES[run.mode].label} · 다음은 ${stageLabel()}`
      : Profile.MODES[setup.runMode].label;
    $('#btnShopGo').textContent = run && !run.done ? `다음 판 출격 →` : '전차 선택 →';
    renderShop();
  }

  function shopCard(entry, opts) {
    const def = itemDef(entry.id);
    if (!def) return null;
    const r = RARITY[def.rarity];
    const q = qualityOf(entry.roll);
    const dur = durationOf(entry);
    const card = document.createElement('div');
    card.className = 'shop-card' + (entry.bought ? ' is-bought' : '') + (entry.perm ? ' is-perm' : '');
    card.style.borderLeftColor = entry.perm ? '#c07bff' : r.color;
    card.innerHTML =
      `<div class="sc-head"><div class="sc-icon">${def.icon}</div><div>` +
      `<div class="sc-name">${esc(itemName(entry))}</div>` +
      `<div class="sc-tags">` +
      `<span class="tag" style="background:${r.color}">${r.label}</span>` +
      `<span class="tag" style="background:${q.color}">${q.label}</span>` +
      `<span class="tag ${entry.perm ? 'tag--perm' : 'tag--dur'}">${DURATION_LABEL[dur]}</span>` +
      `<span class="tag tag--cat">${ITEM_CATS[def.cat] || ''}</span>` +
      `${def.kind === 'active' ? `<span class="tag tag--cat">사용 ${itemUses(entry)}회</span>` : ''}` +
      `</div></div></div>` +
      `<div class="sc-desc">${esc(itemDesc(entry))}</div>`;
    attachTip(card, () => itemTipHtml(entry));

    const buy = document.createElement('button');
    buy.type = 'button';
    buy.className = 'sc-buy';
    const afford = Profile.credits >= entry.price;
    const room = opts.room();
    buy.disabled = !!entry.bought || !afford || !room;
    buy.innerHTML = entry.bought ? '구매함'
      : !room ? opts.fullText
        : `<span class="w-coin" style="color:var(--brass)">◈</span> ${entry.price}`;
    buy.addEventListener('click', () => {
      if (entry.bought || !opts.room()) return;
      if (!Profile.spend(entry.price)) return;
      opts.take(entry);
      entry.bought = true;
      if (typeof Sfx !== 'undefined' && Sfx.select) Sfx.select();
      renderShop(); renderWallet();
    });
    card.appendChild(buy);
    return card;
  }

  function invRow(inst, opts) {
    const def = itemDef(inst.id);
    if (!def) return null;
    const r = RARITY[def.rarity];
    const q = qualityOf(inst.roll);
    const row = document.createElement('div');
    row.className = 'inv-row' + (inst.perm ? ' is-perm' : '');
    row.style.borderLeftColor = inst.perm ? '#c07bff' : r.color;
    row.innerHTML =
      `<span class="i-ico">${def.icon}</span>` +
      `<span><b>${esc(itemName(inst))}</b>` +
      `<small style="color:${q.color}">${q.label} · ${DURATION_LABEL[durationOf(inst)]}</small>` +
      `<small>${esc(itemDesc(inst))}</small></span>`;
    attachTip(row, () => itemTipHtml(inst));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'inv-sell';
    btn.textContent = `${opts.label} ◈${opts.back}`;
    btn.addEventListener('click', opts.onClick);
    row.appendChild(btn);
    return row;
  }

  function renderShop() {
    $('#shopWallet').textContent = Profile.credits.toLocaleString();
    $('#invSlots').textContent = `${Profile.inventory.length}/${Profile.INV_MAX}`;
    $('#modSlots').textContent = `${Profile.modules.length}/${Profile.MOD_MAX}`;

    const stock = ensureStock(false);

    const grid = $('#shopGrid');
    grid.innerHTML = '';
    for (const entry of stock.supply) {
      const card = shopCard(entry, {
        room: () => Profile.canHold(),
        fullText: '장비 칸 가득',
        take: (e) => Profile.addItem(e),
      });
      if (card) grid.appendChild(card);
    }

    const mgrid = $('#modGrid');
    mgrid.innerHTML = '';
    for (const entry of stock.mods) {
      const card = shopCard(entry, {
        room: () => Profile.canInstall(),
        fullText: '슬롯 가득',
        take: (e) => Profile.installModule(e),
      });
      if (card) mgrid.appendChild(card);
    }

    const mlist = $('#modList');
    mlist.innerHTML = '';
    if (!Profile.modules.length) {
      mlist.innerHTML = '<p class="inv-empty">장착된 모듈이 없습니다. 비싸지만 한 번 사면 계속 쓸 수 있습니다.</p>';
    }
    Profile.modules.forEach((inst, i) => {
      const back = Math.round((inst.price || itemDef(inst.id).price) * 0.5);
      const row = invRow(inst, {
        label: '해체', back,
        onClick: () => { Profile.removeModule(i); Profile.addCredits(back); renderShop(); renderWallet(); },
      });
      if (row) mlist.appendChild(row);
    });

    const inv = $('#invList');
    inv.innerHTML = '';
    if (!Profile.inventory.length) {
      inv.innerHTML = '<p class="inv-empty">아직 보급품이 없습니다. 재고에서 사거나 전장에서 상자를 주우세요.</p>';
    }
    Profile.inventory.forEach((inst, i) => {
      const back = Math.round((inst.price || itemDef(inst.id).price) * 0.4);
      const row = invRow(inst, {
        label: '판매', back,
        onClick: () => { Profile.removeItem(i); Profile.addCredits(back); renderShop(); renderWallet(); },
      });
      if (row) inv.appendChild(row);
    });
  }

  function buildConfig() {
    const tc = teamCount();
    return {
      players: setup.slots.map((s, i) => ({
        name: (s.name || '').trim() || (s.type === 'ai' ? `AI ${i}` : `플레이어 ${i + 1}`),
        isAI: s.type === 'ai',
        team: tc > 0 ? s.team : i,
        color: PLAYER_COLORS[i],
        typeId: s.tank,
      })),
      difficulty: setup.difficulty,
      theme: setup.theme === 'random' ? null : setup.theme,
      teamMode: tc > 0,
    };
  }

  function startGame(cfg) {
    lastCfg = cfg;
    if (game) game.destroy();
    showScreen('game');
    $('#gameover').hidden = true;
    fitCanvas();
    game = new Game($('#canvas'), cfg, ui);
    window.__game = game;
    lastWind = game.wind;   // 판 시작의 첫 바람은 번쩍이지 않습니다
    const tag = $('#hudStage');
    if (run && Profile.MODES[run.mode].total !== 1) {
      tag.hidden = false;
      tag.textContent = `${Profile.MODES[run.mode].label} ${stageLabel()}`;
    } else {
      tag.hidden = true;
    }
    shopStock = null;   // 판이 바뀌면 상점 재고도 새로 뽑습니다
    renderWeapons();
    renderItems();
  }

  function quitToMenu() {
    if (game) { game.destroy(); game = null; }
    run = null;
    $('#gameover').hidden = true;
    showScreen('menu');
    renderMenu();
  }

  /* ═══════════════ 캔버스 크기 ═══════════════ */

  function fitCanvas() {
    const stage = $('#stage'), inner = $('#stageInner');
    const aw = stage.clientWidth, ah = stage.clientHeight;
    if (!aw || !ah) return;
    let w = aw, h = aw / 2;
    if (h > ah) { h = ah; w = ah * 2; }
    inner.style.width = `${Math.floor(w)}px`;
    inner.style.height = `${Math.floor(h)}px`;
  }
  window.addEventListener('resize', fitCanvas);

  /* 전장 위 보급 상자에 마우스를 올리면 내용물을 보여 줍니다 */
  (() => {
    const cv = $('#canvas');
    if (!cv) return;
    let hover = null;

    function worldAt(ev) {
      const r = cv.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: (ev.clientX - r.left) * (cv.width / r.width), y: (ev.clientY - r.top) * (cv.height / r.height) };
    }
    function crateAt(p) {
      if (!game || !game.crates) return null;
      let best = null, bd = 26;
      for (const c of game.crates) {
        const d = Math.hypot(c.x - p.x, c.y - p.y);
        if (d < bd) { bd = d; best = c; }
      }
      return best;
    }

    cv.addEventListener('mousemove', (ev) => {
      const p = worldAt(ev);
      const c = p ? crateAt(p) : null;
      if (c !== hover) {
        hover = c;
        if (game) game.hoverCrate = c;
        const b = c && c.item ? itemTipHtml(c.item) : null;
        if (b) tipShow(b.html, b.accent, ev); else tipHide();
      } else if (c) {
        tipMove(ev);
      }
    });
    cv.addEventListener('mouseleave', () => {
      hover = null;
      if (game) game.hoverCrate = null;
      tipHide();
    });
  })();

  /* ═══════════════ 게임 HUD ═══════════════ */

  let bannerTimer = null;
  let lastWind = null;

  const ui = {
    onTurn(g) {
      const t = g.cur;
      $('#hudDot').style.background = t.color;
      $('#hudName').textContent = t.name;
      $('#hudTank').textContent = t.type.name;
      $('#hudRound').textContent = g.round;
      const tb = $('#hudTeam');
      tb.hidden = !g.teamMode;
      if (g.teamMode) { tb.textContent = `${TEAM_LABELS[t.team]}팀`; tb.style.background = t.color; }
      $('#hudYou').hidden = t.isAI;
      $('#pmark').style.left = `${t.lastPower != null ? t.lastPower : -10}%`;
      $('#pad').classList.toggle('is-disabled', t.isAI);
      renderWeapons();
      renderItems();
      renderBuffs();
      renderRoster();
    },
    refresh() { renderWeapons(); renderItems(); renderBuffs(); renderRoster(); },
    frame(g) {
      const t = g.cur;
      if (!t) return;
      $('#hudAngle').textContent = `${Math.round(t.elev)}° ${t.facing === 1 ? '▶' : '◀'}`;
      $('#hudPower').textContent = Math.round(t.power);
      $('#pfill').style.width = `${t.power}%`;
      $('#ffill').style.width = `${(t.fuel / t.maxFuel) * 100}%`;
      drawWind(g.wind);
      $('#hudWind').textContent = Math.abs(g.wind).toFixed(1);
      // 바람은 몇 라운드에 한 번만 바뀝니다 — 바뀐 순간에만 표시를 번쩍입니다
      if (g.wind !== lastWind) {
        lastWind = g.wind;
        const box = $('.wind-box');
        box.classList.remove('is-shift');
        void box.offsetWidth;          // 애니메이션 재시작
        box.classList.add('is-shift');
      }
      const left = Math.max(0, Math.ceil(g.turnLeft));
      $('#hudTimer').textContent = left;
      $('#timerRing').style.strokeDashoffset = (97.4 * (1 - Math.max(0, g.turnLeft) / TURN_SECONDS)).toFixed(1);
      $('.timer-box').classList.toggle('is-low', left <= 6);
    },
    banner(text, ms) {
      const b = $('#banner');
      b.textContent = text;
      b.hidden = false;
      b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop');
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => { b.hidden = true; }, ms);
    },
    onGameOver(g) { setTimeout(() => showGameOver(g), 1000); },
  };

  function renderWeapons() {
    if (!game || !game.cur) return;
    const t = game.cur;
    const wrap = $('#weapons');
    wrap.innerHTML = '';
    t.weapons.forEach((id, i) => {
      const w = WEAPONS[id];
      const ammo = t.ammo[id];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wpn' + (t.weapon === i ? ' is-active' : '') + (ammo <= 0 ? ' is-empty' : '');
      b.innerHTML = `<span class="w-key">${i + 1}</span><span class="w-icon">${w.icon}</span>` +
        `<span class="w-name">${w.name}</span><span class="w-ammo">${ammo === Infinity ? '∞' : ammo}</span>`;
      attachTip(b, () => ({
        accent: '#f0a63c',
        html: `<div class="tip-head"><span class="tip-ico">${w.icon}</span><span class="tip-name">${esc(w.name)}</span></div>` +
          `<div class="tip-desc">${esc(w.desc)}</div>` +
          `<div class="tip-meta">피해 <b>${w.damage}</b> · 폭발 반경 <b>${w.radius}</b>` +
          `${w.count > 1 ? ` · <b>${w.count}발</b>` : ''} · 남은 탄약 <b>${ammo === Infinity ? '무제한' : ammo + '발'}</b></div>`,
      }));
      b.addEventListener('click', () => game && game.selectWeapon(i));
      wrap.appendChild(b);
    });
  }

  const ITEM_KEYS = ['Z', 'X', 'C', 'V'];

  function renderItems() {
    const bar = $('#itemBar');
    bar.innerHTML = '';
    const t = game && game.cur;
    if (!t || t.isAI || !t.items.length) return;
    t.items.slice(0, 4).forEach((slot, i) => {
      const def = itemDef(slot.id);
      if (!def) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'item-btn';
      b.disabled = game.state !== 'aim';
      attachTip(b, () => itemTipHtml(slot, { uses: slot.uses }));
      b.style.borderLeftColor = RARITY[def.rarity].color;
      b.innerHTML =
        `<span class="i-key">${ITEM_KEYS[i]}</span>` +
        `<span class="i-ico">${def.icon}</span>` +
        `<span class="i-name">${esc(itemName(slot))}</span>` +
        `<span class="i-use">×${slot.uses}</span>`;
      b.addEventListener('click', () => { if (game) game.useItem(i); });
      bar.appendChild(b);
    });
  }

  const BUFF_CHIPS = [
    ['shield', '🔵', (v) => `방어막 ×${v}`, '다음에 받는 피해를 통째로 막습니다. 한 번 막을 때마다 하나씩 소모됩니다.'],
    ['dodge', '💨', (v) => `회피 ×${v}`, '다음 공격이 아예 빗나갑니다.'],
    ['reactive', '🧱', (v) => `반응장갑 ×${v}`, '피격 시 그 피해를 절반으로 줄입니다.'],
    ['phoenix', '🔥', (v) => `부활 ×${v}`, '파괴되는 순간 체력을 회복하며 되살아납니다.'],
    ['smoke', '🌫', (v) => `연막 ${v}턴`, '연막이 걷힐 때까지 적 AI의 명중률이 크게 떨어집니다.'],
    ['overcharge', '🔋', () => '과충전', '다음 사격의 파워 상한이 135까지 올라갑니다.'],
    ['pierce', '🔻', (v) => `관통 ×${v}`, '다음 사격이 지형을 한 겹 뚫고 지나갑니다.'],
    ['bounce', '🔄', (v) => `도탄 ×${v}`, '다음 사격이 지면에 맞으면 한 번 튕겨 나갑니다.'],
    ['splitFuse', '✳', (v) => `분열 ×${v}`, '다음 사격이 착탄 지점에서 세 번 연쇄 폭발합니다.'],
    ['homing', '📶', (v) => `유도 ×${v}`, '다음 사격이 비행 중 가까운 적 쪽으로 휘어집니다.'],
    ['lowGrav', '🌙', (v) => `저중력 ×${v}`, '다음 사격 동안 중력이 약해져 포탄이 훨씬 멀리 날아갑니다.'],
    ['extraShot', '⏩', (v) => `추가 사격 ×${v}`, '이번 턴에 한 번 더 쏠 수 있습니다.'],
    ['regen', '💠', (v) => `재생 +${v}`, '매 턴 시작마다 체력이 회복됩니다.'],
    ['leech', '🩸', () => '흡혈', '적에게 입힌 피해의 일부만큼 체력을 회복합니다.'],
    ['thorns', '🌵', () => '반사', '받은 피해의 일부를 공격자에게 되돌려 줍니다.'],
    ['scope', '🎯', () => '탄도 예측', '조준할 때 예상 탄착 궤적과 착탄점이 표시됩니다.'],
    ['chute', '🪂', () => '낙하 무효', '높은 곳에서 떨어져도 낙하 피해를 받지 않습니다.'],
    ['magnet', '🧲', () => '수집기', '보급 상자를 훨씬 먼 거리에서 끌어당겨 줍습니다.'],
    ['dupe', '♊', () => '복제', '줍는 보급 상자가 두 개 분량이 됩니다.'],
    ['twinBarrel', '⚌', () => '쌍둥이 포신', '모든 사격이 두 발로 나갑니다. 탄약은 한 발만 씁니다.'],
    ['deathBlast', '💀', (v) => `자폭 ${v}`, '파괴되는 순간 주변에 대폭발을 일으킵니다.'],
    ['heatsink', '🌡', (v) => `흡열 +${v}`, '불바다·산성비 피해를 받지 않고 오히려 회복합니다.'],
    ['frostTouch', '🧊', (v) => `빙결 부여 ${v}턴`, '내 공격에 맞은 적이 얼어붙습니다.'],
    ['autoMedic', '🚨', (v) => `응급 ${v}`, '체력이 30% 밑으로 떨어지면 자동으로 회복합니다. (1회)'],
    ['scavenger', '🏴', (v) => `약탈 +${v}`, '적을 격파할 때마다 크레딧을 추가로 챙깁니다.'],
    ['luck', '🍀', () => '행운', '보급 상자에서 나오는 아이템 성능이 좋아집니다.'],
    ['siege', '🏰', (v) => `요새 +${v}%`, '이번 턴에 움직이지 않았다면 피해가 올라갑니다.'],
    ['bulwark', '🚧', () => '방폭 격벽', '폭발로 받는 피해가 줄어듭니다.'],
    ['dome', '⛺', (v) => `보호 돔 ${v}턴`, '폭발 피해를 70% 줄여 줍니다.'],
    ['anchor', '⚓', () => '고정', '낙하 피해를 받지 않고 밀리지 않습니다.'],
    ['insurance', '📜', () => '전투 보험', '져도 크레딧을 상당 부분 지킵니다.'],
  ];

  function renderBuffs() {
    const bar = $('#buffBar');
    bar.innerHTML = '';
    const t = game && game.cur;
    if (!t) return;
    const add = (icon, text, color, note) => {
      const d = document.createElement('div');
      d.className = 'buff-chip';
      d.style.color = color || 'var(--text-dim)';
      d.innerHTML = `<span>${icon}</span><span>${esc(text)}</span>`;
      attachTip(d, () => ({
        accent: color || '#8fa3bf',
        html: `<div class="tip-head"><span class="tip-ico">${icon}</span><span class="tip-name">${esc(text)}</span></div>` +
          `<div class="tip-desc">${esc(note || '지금 걸려 있는 효과입니다.')}</div>`,
      }));
      bar.appendChild(d);
    };
    for (const [key, icon, fmt, note] of BUFF_CHIPS) {
      const v = t.buffs[key];
      if (v) add(icon, fmt(v), '#e9ecf4', note);
    }
    if ((t.buffs.armor || 1) !== 1) add('🛡', `방어 ${Math.round((1 - t.buffs.armor) * 100)}%`, '#7fd8ff', '받는 피해가 이만큼 조정됩니다.');
    if ((t.buffs.damage || 1) !== 1) add('🔺', `화력 +${Math.round((t.buffs.damage - 1) * 100)}%`, '#ffcc2e', '주는 피해가 늘어납니다.');
    if ((t.buffs.radius || 1) !== 1) add('💥', `반경 +${Math.round((t.buffs.radius - 1) * 100)}%`, '#ff9a5a', '모든 폭발 반경이 커집니다.');
    if ((t.buffs.power || 1) !== 1) add('🧨', `사거리 +${Math.round((t.buffs.power - 1) * 100)}%`, '#ffcc2e', '포구 초속이 올라 더 멀리 날아갑니다.');
    if ((t.buffs.wind != null && t.buffs.wind < 1)) add('🧭', `바람 저항 ${Math.round((1 - t.buffs.wind) * 100)}%`, '#9fe8ff', '바람이 탄도에 주는 영향이 줄어듭니다.');
    if (t.acid > 0) add('🌧', `산성비 ${t.acid}턴`, '#a8e05f', '매 턴 시작마다 피해를 입습니다.');
    if (t.oiled > 0) add('🛢', `유막 ${t.oiled}턴`, '#c9a227', '이동력이 절반으로 떨어집니다.');
    if (t.frozen > 0) add('❄', `빙결 ${t.frozen}턴`, '#9fe8ff', '이동이 거의 묶입니다.');
  }

  function renderRoster() {
    if (!game) return;
    const r = $('#roster');
    r.innerHTML = '';
    const list = game.teamMode
      ? [...game.tanks].sort((a, b) => a.team - b.team || a.id - b.id)
      : game.tanks;
    let lastTeam = null;
    for (const t of list) {
      if (game.teamMode && t.team !== lastTeam) {
        lastTeam = t.team;
        const h = document.createElement('div');
        h.className = 'roster-team';
        h.textContent = `${TEAM_LABELS[t.team]}팀`;
        r.appendChild(h);
      }
      const row = document.createElement('div');
      row.className = 'roster-row' + (t === game.cur ? ' is-cur' : '') + (t.alive ? '' : ' is-dead');
      const pct = Math.max(0, (t.hp / t.maxHp) * 100);
      row.innerHTML =
        `<span class="dot" style="background:${t.color}"></span>` +
        `<span class="r-name">${esc(t.name)}${t.isAI ? '' : ' ★'}</span>` +
        `<span class="r-bar"><i style="width:${pct}%;background:${pct > 50 ? '#4fe07f' : pct > 25 ? '#ffcc2e' : '#ff5348'}"></i></span>` +
        `<span class="r-hp">${t.alive ? t.hp : '✕'}</span>`;
      r.appendChild(row);
    }
  }

  function drawWind(wind) {
    const cv = $('#windCanvas'), c = cv.getContext('2d');
    c.clearRect(0, 0, cv.width, cv.height);
    const mid = cv.width / 2, y = cv.height / 2;
    c.strokeStyle = 'rgba(255,255,255,0.18)';
    c.lineWidth = 1;
    for (let i = -2; i <= 2; i++) {
      const x = mid + i * (mid - 8) / 2;
      c.beginPath(); c.moveTo(x, y - 5); c.lineTo(x, y + 5); c.stroke();
    }
    const len = (wind / 10) * (mid - 9);
    if (Math.abs(len) < 1.5) return;
    const col = Math.abs(wind) > 6.5 ? '#ff7b7b' : Math.abs(wind) > 3.5 ? '#ffcc2e' : '#7fe0a0';
    c.strokeStyle = col; c.fillStyle = col;
    c.lineWidth = 3.5; c.lineCap = 'round';
    c.beginPath(); c.moveTo(mid, y); c.lineTo(mid + len, y); c.stroke();
    const dir = Math.sign(len);
    c.beginPath();
    c.moveTo(mid + len + dir * 6, y);
    c.lineTo(mid + len - dir * 4, y - 5.5);
    c.lineTo(mid + len - dir * 4, y + 5.5);
    c.closePath(); c.fill();
  }

  function showGameOver(g) {
    const m = $('#gameover');
    const title = $('#goTitle'), sub = $('#goSub');

    /* ── 전투 수당 정산 ── */
    const me = g.tanks.find((t) => !t.isAI) || null;
    const rw = Profile.reward(g, me, { stage: run ? run.stage : 0 });
    Profile.addCredits(rw.total);
    Profile.recordMatch(g, me, rw.won);

    const lines = $('#payoutLines');
    lines.innerHTML = '';
    for (const [label, v] of rw.lines) {
      const d = document.createElement('div');
      d.innerHTML = `<span>${esc(label)}</span><b class="${v < 0 ? 'neg' : ''}">${v > 0 ? '+' : ''}${v}</b>`;
      lines.appendChild(d);
    }
    $('#payoutTotal').textContent = `◈${rw.total.toLocaleString()}`;
    $('#payoutWallet').innerHTML = `보유 <b>◈${Profile.credits.toLocaleString()}</b>`;

    /* ── 진행 상태 ── */
    const again = $('#goAgain');
    if (run) {
      if (rw.won) {
        run.stage++;
        const total = Profile.MODES[run.mode].total;
        if (run.mode === 'endless') Profile.recordEndless(run.stage);
        run.done = run.stage >= total;
      } else {
        if (run.mode === 'endless') Profile.recordEndless(run.stage);
        run.done = true;
      }
      again.textContent = run.done ? '새 판 시작' : `다음 판 (${stageLabel()}) →`;
    } else {
      again.textContent = '다시하기';
    }
    renderWallet();
    if (g.winnerTeam == null) {
      title.textContent = '무승부';
      sub.textContent = '모든 전차가 파괴되었습니다.';
    } else {
      const winners = g.tanks.filter((t) => t.team === g.winnerTeam);
      const humanWon = winners.some((t) => !t.isAI);
      title.textContent = g.teamMode ? `${TEAM_LABELS[g.winnerTeam]}팀 승리` : `${winners[0].name} 승리`;
      let extra = humanWon ? '축하합니다!' : 'AI가 이겼습니다. 다시 도전해보세요.';
      if (run && humanWon) {
        const total = Profile.MODES[run.mode].total;
        extra = run.done && Number.isFinite(total)
          ? `${total}판 원정 완주! 🏆`
          : `${Profile.MODES[run.mode].label} — ${stageLabel()} 돌파`;
      }
      sub.textContent = (g.teamMode ? winners.map((t) => `${t.name}(${t.type.name})`).join(', ') + ' · ' : '') + extra;
    }
    const body = $('#goBody');
    body.innerHTML = '';
    const ranked = [...g.tanks].sort((a, b) => (b.alive - a.alive) || (b.hp - a.hp) || (b.kills - a.kills) || (b.damageDealt - a.damageDealt));
    ranked.forEach((t, i) => {
      const tr = document.createElement('tr');
      if (t.team === g.winnerTeam) tr.className = 'is-win';
      tr.innerHTML =
        `<td>${i + 1}</td>` +
        `<td><span class="dot" style="background:${t.color}"></span>${esc(t.name)}${t.isAI ? '' : ' ★'}</td>` +
        `<td>${esc(t.type.name)}</td>` +
        `<td>${g.teamMode ? TEAM_LABELS[t.team] + '팀' : '-'}</td>` +
        `<td class="num">${t.alive ? t.hp : '✕'}</td>` +
        `<td class="num">${t.kills}</td>` +
        `<td class="num">${t.damageDealt}</td>`;
      body.appendChild(tr);
    });
    m.hidden = false;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ═══════════════ 버튼 배선 ═══════════════ */

  $('#btnToGarage').addEventListener('click', openGarage);
  $('#btnBackMenu').addEventListener('click', () => { showScreen('menu'); renderMenu(); });
  $('#btnRandomAll').addEventListener('click', randomizeAll);
  $('#btnPick').addEventListener('click', () => pickTank(detailId, true));
  $('#btnStart').addEventListener('click', () => startRun());
  $('#goMenu').addEventListener('click', quitToMenu);
  $('#goShop').addEventListener('click', () => {
    if (game) { game.destroy(); game = null; }
    $('#gameover').hidden = true;
    openShop();
  });
  $('#goAgain').addEventListener('click', () => {
    if (game) { game.destroy(); game = null; }
    $('#gameover').hidden = true;
    if (run && !run.done) startStage();
    else { run = null; startRun(); }
  });

  $('#btnToShop').addEventListener('click', () => {
    const err = validate();
    if (err) { const e = $('#menuError'); e.textContent = err; e.hidden = false; return; }
    openShop();
  });
  $('#btnShopBack').addEventListener('click', () => { showScreen('menu'); renderMenu(); });
  $('#btnRestock').addEventListener('click', () => {
    if (!Profile.spend(60)) return;
    ensureStock(true);
    if (typeof Sfx !== 'undefined' && Sfx.click) Sfx.click();
    renderShop(); renderWallet();
  });
  $('#btnShopGo').addEventListener('click', () => {
    if (run && !run.done) startStage();
    else openGarage();
  });
  $('#btnNextTrack').addEventListener('click', (e) => {
    e.stopPropagation();
    bootAudio();
    if (typeof Music !== 'undefined' && Music.next) Music.next();
  });
  /* ═══════════════ 소리 설정 ═══════════════ */

  const VK = { sfx: 'fortress.vol.sfx', music: 'fortress.vol.music', muted: 'fortress.muted' };

  function readStore(key, def) {
    try { const v = localStorage.getItem(key); return v == null ? def : v; } catch (e) { return def; }
  }
  function writeStore(key, v) {
    try { localStorage.setItem(key, String(v)); } catch (e) { /* 저장이 막힌 브라우저 */ }
  }
  function readVol(key, def) {
    const n = parseInt(readStore(key, String(def)), 10);
    return Number.isFinite(n) ? clamp(n, 0, 100) : def;
  }

  let volSfx = readVol(VK.sfx, 85);
  let volMusic = readVol(VK.music, 40);
  let muted = readStore(VK.muted, '0') === '1';

  function applyAudio() {
    AudioCore.setSfxVolume(volSfx / 100);
    AudioCore.setMusicVolume(volMusic / 100);
    AudioCore.setMuted(muted);

    $('#volSfx').value = volSfx;
    $('#volSfxVal').textContent = volSfx;
    $('#volMusic').value = volMusic;
    $('#volMusicVal').textContent = volMusic;

    const mb = $('#btnMuteAll');
    mb.classList.toggle('is-on', muted);
    mb.innerHTML = `${muted ? '음소거 해제' : '전체 음소거'} <span class="ap-key">M</span>`;
    $('#audioPanel').classList.toggle('is-muted', muted);

    const icon = muted ? '🔇' : (volSfx === 0 && volMusic === 0) ? '🔈' : '🔊';
    for (const id of ['#btnMute', '#btnAudioMenu', '#btnAudioGarage']) {
      const el = $(id);
      if (el) el.textContent = icon;
    }
  }

  function openAudioPanel(anchor) {
    const p = $('#audioPanel');
    if (!p.hidden && p.dataset.anchor === anchor.id) { p.hidden = true; return; }
    p.hidden = false;
    p.dataset.anchor = anchor.id;
    const r = anchor.getBoundingClientRect();
    const w = p.offsetWidth || 244, h = p.offsetHeight || 180;
    const left = clamp(r.right - w, 8, Math.max(8, window.innerWidth - w - 8));
    const top = r.bottom + 8 + h > window.innerHeight ? Math.max(8, r.top - h - 8) : r.bottom + 8;
    p.style.left = `${left}px`;
    p.style.top = `${top}px`;
  }

  function setMuted(v) {
    muted = v;
    writeStore(VK.muted, muted ? '1' : '0');
    applyAudio();
  }

  for (const id of ['#btnMute', '#btnAudioMenu', '#btnAudioGarage']) {
    const el = $(id);
    if (el) el.addEventListener('click', (e) => { e.stopPropagation(); bootAudio(); openAudioPanel(el); });
  }

  $('#volSfx').addEventListener('input', (e) => {
    volSfx = clamp(+e.target.value, 0, 100);
    writeStore(VK.sfx, volSfx);
    if (muted && volSfx > 0) { muted = false; writeStore(VK.muted, '0'); }
    applyAudio();
  });
  $('#volSfx').addEventListener('change', () => { bootAudio(); if (typeof Sfx !== 'undefined' && Sfx.select) Sfx.select(); });

  $('#volMusic').addEventListener('input', (e) => {
    volMusic = clamp(+e.target.value, 0, 100);
    writeStore(VK.music, volMusic);
    if (muted && volMusic > 0) { muted = false; writeStore(VK.muted, '0'); }
    applyAudio();
  });
  $('#volMusic').addEventListener('change', bootAudio);

  $('#btnMuteAll').addEventListener('click', (e) => { e.stopPropagation(); setMuted(!muted); });
  $('#audioPanel').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('pointerdown', (e) => {
    const p = $('#audioPanel');
    if (p.hidden) return;
    if (p.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.icon-btn')) return;
    p.hidden = true;
  });

  applyAudio();

  let quitArmed = null;
  $('#btnQuit').addEventListener('click', () => {
    if (quitArmed) { clearTimeout(quitArmed); quitArmed = null; quitToMenu(); return; }
    ui.banner('한 번 더 누르면 메뉴로 나갑니다', 2400);
    quitArmed = setTimeout(() => { quitArmed = null; }, 2400);
  });

  /* ═══════════════ 입력 ═══════════════ */

  const KEYMAP = {
    ArrowLeft: 'left', a: 'left', A: 'left',
    ArrowRight: 'right', d: 'right', D: 'right',
    ArrowUp: 'up', w: 'up', W: 'up',
    ArrowDown: 'down', s: 'down', S: 'down',
    PageUp: 'pup', PageDown: 'pdown',
  };

  function inGame() { return $('#game').classList.contains('is-active') && game && $('#gameover').hidden; }

  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;

    if (e.key === 'm' || e.key === 'M') { setMuted(!muted); return; }
    if (e.key === 'n' || e.key === 'N') { $('#btnNextTrack').click(); return; }

    // 격납고 키보드 조작
    if ($('#garage').classList.contains('is-active')) {
      const cards = $$('#tankGrid .tank-card');
      if (!cards.length) return;
      let idx = cards.findIndex((c) => c.dataset.id === detailId);
      if (idx < 0) idx = 0;
      const gridEl = $('#tankGrid');
      const cw = cards[0].offsetWidth + 10;
      const cols = Math.max(1, Math.round(gridEl.clientWidth / cw));
      let ni = idx;
      if (e.key === 'ArrowRight') ni = Math.min(cards.length - 1, idx + 1);
      else if (e.key === 'ArrowLeft') ni = Math.max(0, idx - 1);
      else if (e.key === 'ArrowDown') ni = Math.min(cards.length - 1, idx + cols);
      else if (e.key === 'ArrowUp') ni = Math.max(0, idx - cols);
      else if (e.key === 'Enter') { pickTank(detailId, true); e.preventDefault(); return; }
      else if (e.key === 'Tab') {
        const sel = selectableSlots();
        const k = sel.indexOf(activePilot);
        activePilot = sel[(k + (e.shiftKey ? sel.length - 1 : 1)) % sel.length];
        detailId = setup.slots[activePilot].tank;
        renderPilots(); renderGrid(); renderDetail();
        e.preventDefault(); return;
      } else return;
      e.preventDefault();
      detailId = cards[ni].dataset.id;
      renderDetail();
      cards[ni].scrollIntoView({ block: 'nearest' });
      return;
    }

    if (!inGame()) return;
    const act = KEYMAP[e.key];
    if (act) { game.input[act] = true; e.preventDefault(); return; }
    if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) game.startCharge(); return; }
    if (e.key === 'Enter') { e.preventDefault(); game.fireNow(); return; }
    if (e.key === 'Tab') { e.preventDefault(); if (game.state === 'aim' && !game.cur.isAI) game.cycleWeapon(); return; }
    const ik = ITEM_KEYS.indexOf(e.key.toUpperCase());
    if (ik >= 0) { e.preventDefault(); if (!game.cur.isAI) game.useItem(ik); return; }
    if (/^[1-9]$/.test(e.key)) game.selectWeapon(+e.key - 1);
  });

  window.addEventListener('keyup', (e) => {
    if (!game) return;
    const act = KEYMAP[e.key];
    if (act) game.input[act] = false;
    if (e.code === 'Space') game.releaseCharge();
  });

  window.addEventListener('blur', () => {
    if (!game) return;
    for (const k in game.input) game.input[k] = false;
    game.releaseCharge();
  });

  $$('#pad .pad-btn').forEach((b) => {
    const act = b.dataset.act;
    const on = (e) => { e.preventDefault(); if (game) game.input[act] = true; b.classList.add('is-down'); };
    const off = () => { if (game) game.input[act] = false; b.classList.remove('is-down'); };
    b.addEventListener('pointerdown', on);
    b.addEventListener('pointerup', off);
    b.addEventListener('pointercancel', off);
    b.addEventListener('pointerleave', off);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  });

  const fireBtn = $('#btnFire');
  fireBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); if (game) game.startCharge(); fireBtn.classList.add('is-down'); });
  const fireOff = () => { if (game) game.releaseCharge(); fireBtn.classList.remove('is-down'); };
  fireBtn.addEventListener('pointerup', fireOff);
  fireBtn.addEventListener('pointercancel', fireOff);
  fireBtn.addEventListener('pointerleave', fireOff);
  fireBtn.addEventListener('contextmenu', (e) => e.preventDefault());

  renderMenu();
})();
