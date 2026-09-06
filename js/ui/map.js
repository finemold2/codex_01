/**
 * NEON CITY — fullscreen city map.
 *
 * Draws the whole city from `game.world.minimapData` (with `game.city` as a fallback source for
 * districts and landmarks), supports drag-pan, wheel/pinch zoom and click-to-set-waypoint.
 * While open it blocks gameplay input but the game keeps rendering behind a blurred backdrop.
 *
 * The static city plan is rasterised into an offscreen canvas and only rebuilt when the view
 * actually changes, so an open map costs one blit plus a handful of blips per frame.
 */

import { clamp } from '../core/math.js';

/** Map palette (canvas 2d colour strings). */
const MC = Object.freeze({
  bg: 'rgba(6, 9, 15, 0.88)',   // translucent: the blurred game keeps rendering behind it
  water: '#0b2237',
  park: '#143520',
  beach: '#3d3a26',
  block: '#1b2130',
  blockEdge: 'rgba(120,150,200,0.08)',
  building: 'rgba(150,185,235,0.10)',
  roadCasing: '#10151f',
  road: '#39445a',
  avenue: '#5d6c92',
  roadCenter: 'rgba(255,255,255,0.10)',
  district: 'rgba(150,180,230,0.55)',
  label: '#cfe0f8',
  labelDim: 'rgba(200,220,255,0.55)',
  landmark: '#ffb648',
  player: '#00e5ff',
  police: '#4d8dff',
  mission: '#ffd24a',
  pickup: '#3ddc84',
  vehicle: '#8e9ab2',
  waypoint: '#ff2e88',
  grid: 'rgba(0,229,255,0.045)',
});

/** Legend entries: [colour, Korean label]. */
const LEGEND = Object.freeze([
  [MC.player, '플레이어'],
  [MC.mission, '미션'],
  [MC.police, '경찰'],
  [MC.waypoint, '목적지'],
  [MC.pickup, '아이템'],
  [MC.vehicle, '차량'],
  [MC.landmark, '랜드마크'],
]);

/** Dash patterns hoisted so the draw loop never allocates. */
const DASH_WP = [7, 6];
const DASH_NONE = [];

/**
 * Creates an element.
 * @param {string} tag Tag name.
 * @param {string} [cls] Class name.
 * @param {HTMLElement} [parent] Parent.
 * @param {string} [html] Inner HTML.
 * @returns {HTMLElement} New element.
 */
function el(tag, cls, parent, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined && html !== null) e.innerHTML = html;
  if (parent && parent.appendChild) parent.appendChild(e);
  return e;
}

/** @param {*} v Value. @param {number} f Fallback. @returns {number} Finite number. */
function num(v, f) {
  return typeof v === 'number' && Number.isFinite(v) ? v : f;
}

export class MapScreen {
  /**
   * @param {object} game Game instance (contract section 16).
   * @param {HTMLElement} rootElement `#map-root`.
   */
  constructor(game, rootElement) {
    this.game = game;
    this.root = rootElement;
    /** @type {boolean} True while the map is visible. */
    this.isOpen = false;

    // View: world-space centre + pixels per meter.
    this.cx = 0;
    this.cz = 0;
    this.scale = 0.35;
    this.minScale = 0.05;
    this.maxScale = 2.4;

    this._w = 1280;
    this._h = 720;
    this._dpr = 1;
    this._baseKey = '';
    this._needResize = true;
    this._pointers = new Map();
    this._drag = null;
    this._pinch = 0;
    this._pulse = 0;
    this._data = null;

    this._buildDom();
    this._bindEvents();
    if (this.root && this.root.classList) this.root.classList.add('hidden');
  }

  /* ---------------------------------------------------------------- dom */

  /** Builds the map DOM once. @returns {void} */
  _buildDom() {
    const root = this.root;
    if (!root) { this._e = {}; return; }
    root.innerHTML = '';
    const wrap = el('div', 'map', root);
    this._wrap = wrap;
    el('div', 'map-blur', wrap);
    const canvas = el('canvas', 'map-canvas', wrap);
    if (canvas.setAttribute) canvas.setAttribute('aria-label', '도시 지도');

    const head = el('header', 'map-head', wrap);
    el('h2', null, head, '도시 지도');
    el('p', 'map-hint', head,
      '드래그: 이동 · 휠: 확대/축소 · 좌클릭: 목적지 설정 · 우클릭: 목적지 해제 · Tab: 닫기');
    const close = el('button', 'map-close', head);
    close.type = 'button';
    close.textContent = '닫기';

    const legend = el('aside', 'map-legend', wrap);
    el('h3', null, legend, '범례');
    for (const item of LEGEND) {
      const row = el('div', 'lg-row', legend);
      const dot = el('i', 'lg-dot', row);
      if (dot.style) dot.style.background = item[0];
      const label = el('span', null, row);
      label.textContent = item[1];
    }

    const zoom = el('div', 'map-zoom', wrap);
    const zin = el('button', 'zb', zoom);
    zin.type = 'button';
    zin.textContent = '+';
    const zout = el('button', 'zb', zoom);
    zout.type = 'button';
    zout.textContent = '−';
    const zhome = el('button', 'zb home', zoom);
    zhome.type = 'button';
    zhome.textContent = '◎';

    const info = el('div', 'map-info', wrap);

    this._e = { canvas, close, zin, zout, zhome, info, legend };
    this._ctx = canvas.getContext ? canvas.getContext('2d') : null;
    this._base = typeof document !== 'undefined' && document.createElement
      ? document.createElement('canvas') : null;
    this._baseCtx = this._base && this._base.getContext ? this._base.getContext('2d') : null;
  }

  /** Attaches pointer/wheel/button listeners. @returns {void} */
  _bindEvents() {
    const e = this._e;
    if (!e || !e.canvas || !e.canvas.addEventListener) return;
    const c = e.canvas;

    c.addEventListener('pointerdown', (ev) => this._onPointerDown(ev));
    c.addEventListener('pointermove', (ev) => this._onPointerMove(ev));
    c.addEventListener('pointerup', (ev) => this._onPointerUp(ev));
    c.addEventListener('pointercancel', (ev) => this._onPointerUp(ev));
    c.addEventListener('pointerleave', (ev) => this._onPointerUp(ev));
    c.addEventListener('wheel', (ev) => this._onWheel(ev), { passive: false });
    c.addEventListener('contextmenu', (ev) => {
      if (ev && ev.preventDefault) ev.preventDefault();
      const g = this.game;
      if (g && typeof g.clearWaypoint === 'function') g.clearWaypoint();
      else if (g && g.hud && typeof g.hud.setWaypoint === 'function') g.hud.setWaypoint(null, null);
      this._setInfo('목적지를 해제했습니다.');
    });

    if (e.close && e.close.addEventListener) e.close.addEventListener('click', () => this.hide());
    if (e.zin && e.zin.addEventListener) e.zin.addEventListener('click', () => this._zoomBy(1.35));
    if (e.zout && e.zout.addEventListener) e.zout.addEventListener('click', () => this._zoomBy(1 / 1.35));
    if (e.zhome && e.zhome.addEventListener) e.zhome.addEventListener('click', () => this.centerOnPlayer());

    if (typeof window !== 'undefined' && window.addEventListener) {
      this._onResize = () => { this._needResize = true; this._baseKey = ''; };
      window.addEventListener('resize', this._onResize, false);
    }
  }

  /* ---------------------------------------------------------------- visibility */

  /** Toggles the map. @returns {void} */
  toggle() {
    if (this.isOpen) this.hide();
    else this.show();
  }

  /** Opens the map, blocking gameplay input. @returns {void} */
  show() {
    this.isOpen = true;
    if (this.root && this.root.classList) this.root.classList.remove('hidden');
    if (this._wrap && this._wrap.classList) this._wrap.classList.add('open');
    const g = this.game;
    if (g && g.input) g.input.blocked = true;
    this._needResize = true;
    this._baseKey = '';
    this.centerOnPlayer();
    this._setInfo('');
    this.update();
  }

  /** Closes the map and hands input back to the game. @returns {void} */
  hide() {
    this.isOpen = false;
    if (this.root && this.root.classList) this.root.classList.add('hidden');
    if (this._wrap && this._wrap.classList) this._wrap.classList.remove('open');
    this._pointers.clear();
    this._drag = null;
    const g = this.game;
    if (g && g.input) g.input.blocked = !!g.paused;
  }

  /** Centres the view on the player at a comfortable zoom. @returns {void} */
  centerOnPlayer() {
    const p = this.game && this.game.player ? this.game.player.position : null;
    if (p) {
      this.cx = num(p[0], 0);
      this.cz = num(p[2], 0);
    }
    const data = this._mapData();
    if (data && data.bounds) {
      const w = data.bounds.max[0] - data.bounds.min[0];
      const h = data.bounds.max[1] - data.bounds.min[1];
      const fit = Math.min(this._w / Math.max(1, w), this._h / Math.max(1, h));
      this.minScale = Math.max(0.02, fit * 0.85);
      this.maxScale = Math.max(this.minScale * 12, fit * 9);
      this.scale = clamp(fit * 2.1, this.minScale, this.maxScale);
    }
    this._baseKey = '';
  }

  /* ---------------------------------------------------------------- input */

  /** @returns {DOMRect|null} Canvas rect, or null when unavailable. */
  _rect() {
    const c = this._e && this._e.canvas;
    if (!c || !c.getBoundingClientRect) return null;
    const r = c.getBoundingClientRect();
    if (!r || !Number.isFinite(r.width) || r.width <= 0) return null;
    return r;
  }

  /**
   * Converts a pointer event to canvas-local pixels.
   * @param {PointerEvent} ev Event.
   * @returns {{x:number,y:number}|null} Local position.
   */
  _local(ev) {
    const r = this._rect();
    if (!r) return null;
    const x = num(ev && ev.clientX, NaN);
    const y = num(ev && ev.clientY, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: x - r.left, y: y - r.top };
  }

  /** @param {PointerEvent} ev Event. @returns {void} */
  _onPointerDown(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    const p = this._local(ev);
    if (!p) return;
    const id = ev && ev.pointerId !== undefined ? ev.pointerId : 0;
    this._pointers.set(id, p);
    const c = this._e.canvas;
    if (c && c.setPointerCapture && ev && ev.pointerId !== undefined) {
      try { c.setPointerCapture(ev.pointerId); } catch (err) { /* capture is optional */ }
    }
    if (this._pointers.size === 2) {
      this._pinch = this._pointerDistance();
      this._drag = null;
      return;
    }
    if (ev && ev.button === 2) return;
    this._drag = { id, sx: p.x, sy: p.y, lx: p.x, ly: p.y, moved: 0 };
  }

  /** @param {PointerEvent} ev Event. @returns {void} */
  _onPointerMove(ev) {
    const id = ev && ev.pointerId !== undefined ? ev.pointerId : 0;
    const p = this._local(ev);
    if (!p) return;
    if (this._pointers.has(id)) this._pointers.set(id, p);
    this._hover = p;

    if (this._pointers.size === 2) {
      const d = this._pointerDistance();
      if (this._pinch > 4 && d > 4) {
        const k = d / this._pinch;
        this._pinch = d;
        const mid = this._pointerMidpoint();
        this._zoomAt(k, mid.x, mid.y);
      }
      return;
    }

    if (this._drag && this._drag.id === id) {
      const dx = p.x - this._drag.lx;
      const dy = p.y - this._drag.ly;
      this._drag.lx = p.x;
      this._drag.ly = p.y;
      this._drag.moved += Math.abs(dx) + Math.abs(dy);
      const s = Math.max(1e-4, this.scale);
      this.cx -= dx / s;
      this.cz -= dy / s;
      this._clampView();
      this._baseKey = '';
    }
    this._updateHoverInfo(p);
  }

  /** @param {PointerEvent} ev Event. @returns {void} */
  _onPointerUp(ev) {
    const id = ev && ev.pointerId !== undefined ? ev.pointerId : 0;
    const drag = this._drag;
    this._pointers.delete(id);
    if (this._pointers.size < 2) this._pinch = 0;
    if (!drag || drag.id !== id) { if (this._pointers.size === 0) this._drag = null; return; }
    this._drag = null;
    if (drag.moved > 6) return;
    if (ev && ev.button === 2) return;
    const p = this._local(ev) || { x: drag.sx, y: drag.sy };
    this._setWaypointFromScreen(p.x, p.y);
  }

  /** @param {WheelEvent} ev Event. @returns {void} */
  _onWheel(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    const p = this._local(ev) || { x: this._w * 0.5, y: this._h * 0.5 };
    const delta = num(ev && ev.deltaY, 0);
    const k = delta > 0 ? 1 / 1.18 : 1.18;
    this._zoomAt(k, p.x, p.y);
  }

  /** @returns {number} Distance between the two active pointers. */
  _pointerDistance() {
    const it = this._pointers.values();
    const a = it.next().value;
    const b = it.next().value;
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /** @returns {{x:number,y:number}} Midpoint of the two active pointers. */
  _pointerMidpoint() {
    const it = this._pointers.values();
    const a = it.next().value;
    const b = it.next().value;
    if (!a || !b) return { x: this._w * 0.5, y: this._h * 0.5 };
    return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
  }

  /**
   * Zooms about the view centre.
   * @param {number} k Zoom factor.
   * @returns {void}
   */
  _zoomBy(k) {
    this._zoomAt(k, this._w * 0.5, this._h * 0.5);
  }

  /**
   * Zooms while keeping the world point under (px, py) fixed.
   * @param {number} k Zoom factor.
   * @param {number} px Screen x.
   * @param {number} py Screen y.
   * @returns {void}
   */
  _zoomAt(k, px, py) {
    const before = this.screenToWorld(px, py);
    this.scale = clamp(this.scale * num(k, 1), this.minScale, this.maxScale);
    const after = this.screenToWorld(px, py);
    if (before && after) {
      this.cx += before.x - after.x;
      this.cz += before.z - after.z;
    }
    this._clampView();
    this._baseKey = '';
  }

  /** Keeps the view centre inside a padded city rectangle. @returns {void} */
  _clampView() {
    const data = this._mapData();
    if (!data || !data.bounds) return;
    const pad = 260;
    this.cx = clamp(this.cx, data.bounds.min[0] - pad, data.bounds.max[0] + pad);
    this.cz = clamp(this.cz, data.bounds.min[1] - pad, data.bounds.max[1] + pad);
  }

  /**
   * Screen (canvas-local px) -> world.
   * @param {number} px Local x.
   * @param {number} py Local y.
   * @returns {{x:number,z:number}} World position.
   */
  screenToWorld(px, py) {
    const s = Math.max(1e-4, this.scale);
    return { x: this.cx + (px - this._w * 0.5) / s, z: this.cz + (py - this._h * 0.5) / s };
  }

  /**
   * World -> screen x.
   * @param {number} x World x.
   * @returns {number} Local pixel x.
   */
  _sx(x) { return (x - this.cx) * this.scale + this._w * 0.5; }

  /**
   * World -> screen y.
   * @param {number} z World z.
   * @returns {number} Local pixel y.
   */
  _sy(z) { return (z - this.cz) * this.scale + this._h * 0.5; }

  /**
   * Sets the waypoint from a click.
   * @param {number} px Local x.
   * @param {number} py Local y.
   * @returns {void}
   */
  _setWaypointFromScreen(px, py) {
    const w = this.screenToWorld(px, py);
    if (!Number.isFinite(w.x) || !Number.isFinite(w.z)) return;
    const g = this.game;
    if (g && typeof g.setWaypoint === 'function') g.setWaypoint(w.x, w.z);
    else if (g && g.hud && typeof g.hud.setWaypoint === 'function') g.hud.setWaypoint(w.x, w.z);
    this._setInfo(`목적지 설정 · ${Math.round(w.x)}, ${Math.round(w.z)}`);
  }

  /**
   * Shows the district / coordinate readout under the cursor.
   * @param {{x:number,y:number}} p Local pointer position.
   * @returns {void}
   */
  _updateHoverInfo(p) {
    const w = this.screenToWorld(p.x, p.y);
    const d = this._districtAt(w.x, w.z);
    const label = d ? `${d} · ` : '';
    this._setInfo(`${label}${Math.round(w.x)}, ${Math.round(w.z)}`);
  }

  /**
   * @param {string} text Info line.
   * @returns {void}
   */
  _setInfo(text) {
    const node = this._e && this._e.info;
    if (!node) return;
    if (node.__t === text) return;
    node.__t = text;
    node.textContent = text;
  }

  /**
   * @param {number} x World x.
   * @param {number} z World z.
   * @returns {string} District name or ''.
   */
  _districtAt(x, z) {
    const data = this._mapData();
    const list = data && data.districts;
    if (!list) return '';
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      const x0 = num(d.x0, num(d.x, 0) - num(d.w, 0) * 0.5);
      const z0 = num(d.z0, num(d.z, 0) - num(d.d, 0) * 0.5);
      if (x >= x0 && x <= x0 + num(d.w, 0) && z >= z0 && z <= z0 + num(d.d, 0)) return d.name || '';
    }
    return '';
  }

  /* ---------------------------------------------------------------- data */

  /**
   * The city plan used for drawing, assembled from the world (preferred) or `game.city`.
   * @returns {object|null} Minimap data.
   */
  _mapData() {
    const g = this.game;
    if (!g) return null;
    if (g.world && g.world.minimapData) {
      this._data = g.world.minimapData;
      return this._data;
    }
    if (this._data) return this._data;
    const city = g.city;
    if (!city) return null;
    // Fallback: derive a light-weight plan straight from CityData.
    const roads = [];
    const list = city.roads || [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      roads.push({
        x1: num(r.ax, 0), z1: num(r.az, 0), x2: num(r.bx, 0), z2: num(r.bz, 0),
        w: num(r.width, 12), kind: r.kind || 'street',
      });
    }
    const blocks = [];
    const water = [];
    const parks = [];
    const lots = city.lots || [];
    for (let i = 0; i < lots.length; i++) {
      const l = lots[i];
      const rect = {
        x: num(l.x, 0), z: num(l.z, 0), w: num(l.w, 0), d: num(l.d, 0),
        x0: num(l.x0, num(l.x, 0) - num(l.w, 0) * 0.5),
        z0: num(l.z0, num(l.z, 0) - num(l.d, 0) * 0.5),
      };
      if (l.kind === 'water') water.push(rect);
      else if (l.kind === 'park') parks.push(rect);
      else blocks.push(rect);
    }
    const districts = [];
    const dl = city.districts || [];
    for (let i = 0; i < dl.length; i++) {
      const d = dl[i];
      const r = d.rect || {};
      const x0 = num(r.x0, num(r.x, 0));
      const z0 = num(r.z0, num(r.z, 0));
      districts.push({
        name: d.name, kind: d.kind, x0, z0, w: num(r.w, 0), d: num(r.d, 0),
        x: x0 + num(r.w, 0) * 0.5, z: z0 + num(r.d, 0) * 0.5,
      });
    }
    this._data = {
      bounds: city.bounds || { min: [-600, -600], max: [600, 600] },
      roads, blocks, water, parks, districts,
      buildings: city.buildings || [],
      landmarks: city.landmarks || [],
    };
    return this._data;
  }

  /* ---------------------------------------------------------------- drawing */

  /** Re-measures the canvas backing store. @returns {void} */
  _resize() {
    const c = this._e && this._e.canvas;
    if (!c) return;
    const dpr = clamp(typeof window !== 'undefined' && window.devicePixelRatio
      ? window.devicePixelRatio : 1, 1, 2);
    let w = num(c.clientWidth, 0);
    let h = num(c.clientHeight, 0);
    if (w < 32 || h < 32) {
      w = typeof window !== 'undefined' ? num(window.innerWidth, 1280) : 1280;
      h = typeof window !== 'undefined' ? num(window.innerHeight, 720) : 720;
    }
    this._w = Math.max(320, Math.round(w));
    this._h = Math.max(240, Math.round(h));
    this._dpr = dpr;
    c.width = Math.round(this._w * dpr);
    c.height = Math.round(this._h * dpr);
    if (this._base) {
      this._base.width = c.width;
      this._base.height = c.height;
    }
    this._needResize = false;
    this._baseKey = '';
  }

  /**
   * Draws one map frame: cached city plan + live blips.
   * @returns {void}
   */
  update() {
    if (!this.isOpen) return;
    if (this._needResize) this._resize();
    const ctx = this._ctx;
    if (!ctx) return;

    const key = `${this._w}x${this._h}|${this.cx.toFixed(1)}|${this.cz.toFixed(1)}|${this.scale.toFixed(4)}`;
    if (key !== this._baseKey) {
      this._baseKey = key;
      this._drawBase();
    }

    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    if (this._base && this._baseCtx) {
      ctx.clearRect(0, 0, this._w, this._h);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this._base, 0, 0);
      ctx.restore();
    } else {
      ctx.clearRect(0, 0, this._w, this._h);
      ctx.fillStyle = MC.bg;
      ctx.fillRect(0, 0, this._w, this._h);
    }

    this._pulse = (this._pulse + 0.06) % (Math.PI * 2);
    this._drawDynamic(ctx);
    this._drawScaleBar(ctx);
  }

  /** Rasterises the static city plan into the offscreen canvas. @returns {void} */
  _drawBase() {
    const ctx = this._baseCtx;
    if (!ctx) return;
    const data = this._mapData();
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, this._w, this._h);
    ctx.fillStyle = MC.bg;
    ctx.fillRect(0, 0, this._w, this._h);
    if (!data) return;

    const s = this.scale;
    const W = this._w;
    const H = this._h;
    const x0 = this.cx - W / (2 * s);
    const z0 = this.cz - H / (2 * s);
    const x1 = this.cx + W / (2 * s);
    const z1 = this.cz + H / (2 * s);

    // Faint coordinate grid every 100 m keeps large zoom levels readable.
    ctx.strokeStyle = MC.grid;
    ctx.lineWidth = 1;
    const gridStep = s > 0.5 ? 50 : s > 0.18 ? 100 : 250;
    ctx.beginPath();
    for (let gx = Math.ceil(x0 / gridStep) * gridStep; gx < x1; gx += gridStep) {
      const px = Math.round(this._sx(gx)) + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, H);
    }
    for (let gz = Math.ceil(z0 / gridStep) * gridStep; gz < z1; gz += gridStep) {
      const py = Math.round(this._sy(gz)) + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(W, py);
    }
    ctx.stroke();

    const rects = (list, colour) => {
      if (!list || !list.length) return;
      ctx.fillStyle = colour;
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        const w = num(r.w, 0);
        const d = num(r.d, 0);
        if (w <= 0 || d <= 0) continue;
        const rx = num(r.x0, num(r.x, 0) - w * 0.5);
        const rz = num(r.z0, num(r.z, 0) - d * 0.5);
        if (rx > x1 || rz > z1 || rx + w < x0 || rz + d < z0) continue;
        const sx = this._sx(rx);
        const sy = this._sy(rz);
        ctx.fillStyle = typeof r.c === 'string' ? r.c : colour;
        ctx.fillRect(sx, sy, Math.max(1, w * s), Math.max(1, d * s));
      }
    };

    rects(data.water, MC.water);
    rects(data.blocks, MC.block);
    rects(data.parks, MC.park);

    // Building footprints, only once they are big enough to read.
    const buildings = data.buildings;
    if (buildings && buildings.length && s > 0.09) {
      ctx.fillStyle = MC.building;
      for (let i = 0; i < buildings.length; i++) {
        const b = buildings[i];
        const bx = num(b.x, 0);
        const bz = num(b.z, 0);
        const bw = num(b.w, 0);
        const bd = num(b.d, 0);
        if (bw <= 0 || bd <= 0) continue;
        if (bx - bw > x1 || bz - bd > z1 || bx + bw < x0 || bz + bd < z0) continue;
        const rot = num(b.rot, 0);
        const sx = this._sx(bx);
        const sy = this._sy(bz);
        if (Math.abs(rot) < 0.02) {
          ctx.fillRect(sx - bw * 0.5 * s, sy - bd * 0.5 * s, Math.max(1, bw * s), Math.max(1, bd * s));
        } else {
          ctx.save();
          ctx.translate(sx, sy);
          ctx.rotate(rot);
          ctx.fillRect(-bw * 0.5 * s, -bd * 0.5 * s, Math.max(1, bw * s), Math.max(1, bd * s));
          ctx.restore();
        }
      }
    }

    // Roads: dark casing pass, then the surface, avenues wider and brighter.
    const roads = data.roads || [];
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < roads.length; i++) {
        const r = roads[i];
        const ax = num(r.x1, num(r.ax, 0));
        const az = num(r.z1, num(r.az, 0));
        const bx = num(r.x2, num(r.bx, 0));
        const bz = num(r.z2, num(r.bz, 0));
        if (Math.max(ax, bx) < x0 || Math.min(ax, bx) > x1
          || Math.max(az, bz) < z0 || Math.min(az, bz) > z1) continue;
        const kind = r.kind || 'street';
        const avenue = kind === 'avenue' || kind === 'boulevard' || kind === 'highway';
        const width = Math.max(1.2, num(r.w, num(r.width, 12)) * s);
        ctx.lineWidth = pass === 0 ? width + 2.4 : width;
        ctx.strokeStyle = pass === 0 ? MC.roadCasing : (avenue ? MC.avenue : MC.road);
        ctx.beginPath();
        ctx.moveTo(this._sx(ax), this._sy(az));
        ctx.lineTo(this._sx(bx), this._sy(bz));
        ctx.stroke();
      }
    }

    // District names, big and faded, then landmark labels.
    const districts = data.districts || [];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = MC.district;
    const dFont = clamp(Math.round(13 + s * 26), 12, 30);
    ctx.font = `600 ${dFont}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
    for (let i = 0; i < districts.length; i++) {
      const d = districts[i];
      const dx = num(d.x, num(d.x0, 0) + num(d.w, 0) * 0.5);
      const dz = num(d.z, num(d.z0, 0) + num(d.d, 0) * 0.5);
      if (dx < x0 || dx > x1 || dz < z0 || dz > z1) continue;
      if (!d.name) continue;
      ctx.fillText(String(d.name), this._sx(dx), this._sy(dz));
    }

    const landmarks = data.landmarks || [];
    if (s > 0.12) {
      ctx.font = `600 ${clamp(Math.round(9 + s * 6), 10, 15)}px system-ui, -apple-system, sans-serif`;
      for (let i = 0; i < landmarks.length; i++) {
        const m = landmarks[i];
        const mx = num(m.x, NaN);
        const mz = num(m.z, NaN);
        if (!Number.isFinite(mx) || !Number.isFinite(mz)) continue;
        if (mx < x0 || mx > x1 || mz < z0 || mz > z1) continue;
        const px = this._sx(mx);
        const py = this._sy(mz);
        ctx.fillStyle = MC.landmark;
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = MC.labelDim;
        ctx.fillText(String(m.name || ''), px, py - 10);
      }
    }
  }

  /**
   * Draws live entities on top of the cached plan.
   * @param {CanvasRenderingContext2D} ctx Visible context.
   * @returns {void}
   */
  _drawDynamic(ctx) {
    const g = this.game;
    if (!g) return;
    const pulse = 0.65 + 0.35 * Math.sin(this._pulse * 2);

    // Pickups.
    const pickups = g.pickups;
    if (pickups && this.scale > 0.14) {
      ctx.fillStyle = MC.pickup;
      for (let i = 0; i < pickups.length; i++) {
        const k = pickups[i];
        if (!k || k.taken) continue;
        const px = this._sx(num(k.x, 0));
        const py = this._sy(num(k.z, 0));
        if (px < -8 || py < -8 || px > this._w + 8 || py > this._h + 8) continue;
        ctx.beginPath();
        ctx.arc(px, py, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Parked / traffic vehicles.
    const vehicles = g.vehicles;
    if (vehicles && this.scale > 0.3) {
      ctx.fillStyle = MC.vehicle;
      const own = g.player ? g.player.vehicle : null;
      for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i];
        if (!v || !v.position || v === own || v.isPolice) continue;
        const px = this._sx(num(v.position[0], 0));
        const py = this._sy(num(v.position[2], 0));
        if (px < -8 || py < -8 || px > this._w + 8 || py > this._h + 8) continue;
        ctx.fillRect(px - 2, py - 2, 4, 4);
      }
    }

    // Mission markers.
    const mm = g.missions;
    const markers = mm ? (Array.isArray(mm.markers) ? mm.markers
      : Array.isArray(mm.available) ? mm.available : null) : null;
    if (markers) {
      for (let i = 0; i < markers.length; i++) {
        const m = markers[i];
        if (!m) continue;
        const mp = m.position;
        const mx = num(m.x, mp ? num(mp[0], NaN) : NaN);
        const mz = num(m.z, mp ? num(mp[2], NaN) : NaN);
        if (!Number.isFinite(mx) || !Number.isFinite(mz)) continue;
        const px = this._sx(mx);
        const py = this._sy(mz);
        if (px < -20 || py < -20 || px > this._w + 20 || py > this._h + 20) continue;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(Math.PI * 0.25);
        ctx.fillStyle = MC.mission;
        ctx.fillRect(-5, -5, 10, 10);
        ctx.restore();
        const label = m.nameKo || m.name || (m.def && (m.def.nameKo || m.def.name)) || '';
        if (label && this.scale > 0.2) {
          ctx.fillStyle = MC.label;
          ctx.font = '600 12px system-ui, -apple-system, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(String(label), px, py - 12);
        }
      }
    }

    // Police.
    const police = g.police;
    if (police) {
      ctx.fillStyle = MC.police;
      const alpha = ctx.globalAlpha;
      ctx.globalAlpha = alpha * (num(police.wanted, 0) > 0 ? pulse : 0.9);
      const groups = [police.cars, police.cops];
      for (let gi = 0; gi < groups.length; gi++) {
        const arr = groups[gi];
        if (!arr || !arr.length) continue;
        for (let i = 0; i < arr.length; i++) {
          const c = arr[i];
          const p = c && (c.position || (c.vehicle && c.vehicle.position)
            || (c.character && c.character.position));
          if (!p) continue;
          const px = this._sx(num(p[0], 0));
          const py = this._sy(num(p[2], 0));
          if (px < -8 || py < -8 || px > this._w + 8 || py > this._h + 8) continue;
          ctx.beginPath();
          ctx.arc(px, py, gi === 0 ? 4.2 : 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = alpha;
    }

    // Waypoint + line from the player.
    const wp = g.waypoint;
    const player = g.player;
    const ppos = player ? player.position : null;
    if (wp && Number.isFinite(wp.x) && Number.isFinite(wp.z)) {
      const wx = this._sx(wp.x);
      const wy = this._sy(wp.z);
      if (ppos) {
        ctx.strokeStyle = MC.waypoint;
        ctx.lineWidth = 1.6;
        ctx.setLineDash(DASH_WP);
        ctx.beginPath();
        ctx.moveTo(this._sx(num(ppos[0], 0)), this._sy(num(ppos[2], 0)));
        ctx.lineTo(wx, wy);
        ctx.stroke();
        ctx.setLineDash(DASH_NONE);
      }
      ctx.fillStyle = MC.waypoint;
      ctx.beginPath();
      ctx.moveTo(wx, wy);
      ctx.lineTo(wx - 7, wy - 14);
      ctx.lineTo(wx + 7, wy - 14);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(wx, wy, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Player arrow.
    if (ppos) {
      const px = this._sx(num(ppos[0], 0));
      const py = this._sy(num(ppos[2], 0));
      const veh = player.vehicle;
      const yaw = veh ? num(veh.yaw, 0) : num(player.yaw, 0);
      ctx.save();
      ctx.translate(px, py);
      // World forward under yaw is (-sin, -cos); on the map +z is down, so rotate by -yaw.
      ctx.rotate(-yaw);
      ctx.beginPath();
      ctx.moveTo(0, -11);
      ctx.lineTo(7.5, 8);
      ctx.lineTo(0, 4);
      ctx.lineTo(-7.5, 8);
      ctx.closePath();
      ctx.fillStyle = MC.player;
      ctx.fill();
      ctx.strokeStyle = 'rgba(5,7,13,0.85)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * Bottom-left scale bar (metres).
   * @param {CanvasRenderingContext2D} ctx Context.
   * @returns {void}
   */
  _drawScaleBar(ctx) {
    const targetPx = 120;
    const metres = targetPx / Math.max(1e-4, this.scale);
    const steps = [10, 25, 50, 100, 200, 500, 1000, 2000];
    let pick = steps[steps.length - 1];
    for (let i = 0; i < steps.length; i++) {
      if (steps[i] >= metres) { pick = steps[i]; break; }
    }
    const px = pick * this.scale;
    const x = 28;
    const y = this._h - 34;
    ctx.strokeStyle = 'rgba(220,235,255,0.75)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + px, y);
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x, y + 5);
    ctx.moveTo(x + px, y - 5);
    ctx.lineTo(x + px, y + 5);
    ctx.stroke();
    ctx.fillStyle = 'rgba(220,235,255,0.85)';
    ctx.font = '600 12px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${pick} m`, x, y - 8);
  }

  /** Removes listeners and DOM. @returns {void} */
  dispose() {
    if (typeof window !== 'undefined' && window.removeEventListener && this._onResize) {
      window.removeEventListener('resize', this._onResize, false);
    }
    this._onResize = null;
    if (this.root) this.root.innerHTML = '';
  }
}
