/**
 * NEON CITY — heads-up display.
 *
 * Owns every in-game overlay: vitals cluster, money counter, wanted stars, weapon widget,
 * rotating radar minimap, vehicle instruments, mission panel, toasts, subtitles, big centre
 * messages, the radio banner, the crosshair and the debug readout.
 *
 * Design rules honoured here:
 *  - The DOM is built once in the constructor; element references are cached (never queried per
 *    frame) and only written when a value actually changed.
 *  - `update(dt)` reads everything it needs from `this.game` (contract section 16) defensively,
 *    so a system that is still booting can never throw inside the HUD.
 *  - The radar allocates nothing per frame: the city index, scratch arrays and reusable buffers
 *    all live at construction/module scope.
 */

import { clamp, damp, lerp } from '../core/math.js';
import { WEAPONS } from '../entities/weapons.js';

/* ------------------------------------------------------------------ constants */

/** Canvas colours for the radar dial and the vitals ring (canvas 2d only). */
const RC = Object.freeze({
  bg: '#080c14',
  rim: 'rgba(0,229,255,0.55)',
  rimSoft: 'rgba(0,229,255,0.14)',
  water: '#0d2338',
  park: '#17361f',
  block: '#242b39',
  road: '#3d4a63',
  avenue: '#55658a',
  roadLine: 'rgba(255,255,255,0.16)',
  player: '#00e5ff',
  playerCone: 'rgba(0,229,255,0.28)',
  north: '#ff2e88',
  police: '#4d8dff',
  mission: '#ffd24a',
  vehicle: '#98a4bb',
  pickup: '#3ddc84',
  waypoint: '#ff2e88',
  hpTrack: 'rgba(255,255,255,0.13)',
  hp: '#3ddc84',
  hpLow: '#ff3b48',
  armor: '#4d8dff',
  text: '#dceaff',
});

/** Weapon silhouettes, drawn inline so no external assets are needed. viewBox 64x32. */
const WEAPON_ICONS = Object.freeze({
  fist: '<svg viewBox="0 0 64 32" aria-hidden="true"><g fill="currentColor">'
    + '<rect x="14" y="8" width="34" height="17" rx="6"/>'
    + '<rect x="20" y="4" width="7" height="7" rx="3"/><rect x="29" y="3" width="7" height="8" rx="3"/>'
    + '<rect x="38" y="4" width="7" height="7" rx="3"/>'
    + '<path d="M14 14h-5a4 4 0 0 0 0 8h5z"/></g></svg>',
  pistol: '<svg viewBox="0 0 64 32" aria-hidden="true"><g fill="currentColor">'
    + '<rect x="10" y="9" width="40" height="7" rx="1.6"/><rect x="48" y="11" width="8" height="3" rx="1"/>'
    + '<path d="M14 16h11l-4 13h-9z"/><path d="M26 16h9v3h-8z"/>'
    + '<path d="M28 19h7a4 4 0 0 1-4 4h-4z" opacity=".8"/></g></svg>',
  smg: '<svg viewBox="0 0 64 32" aria-hidden="true"><g fill="currentColor">'
    + '<rect x="8" y="9" width="36" height="9" rx="2"/><rect x="43" y="11" width="15" height="4" rx="1.4"/>'
    + '<rect x="19" y="18" width="7" height="12" rx="1.6"/><path d="M9 18h9l-4 10H5z"/>'
    + '<rect x="0" y="10" width="9" height="5" rx="1.6"/></g></svg>',
  shotgun: '<svg viewBox="0 0 64 32" aria-hidden="true"><g fill="currentColor">'
    + '<rect x="6" y="11" width="52" height="6" rx="1.6"/><rect x="30" y="17" width="14" height="4" rx="1.6"/>'
    + '<path d="M6 17h9l-5 11H2z"/><rect x="16" y="9" width="18" height="3" rx="1.2" opacity=".75"/></g></svg>',
  rifle: '<svg viewBox="0 0 64 32" aria-hidden="true"><g fill="currentColor">'
    + '<rect x="8" y="10" width="40" height="7" rx="1.6"/><rect x="47" y="12" width="14" height="3.4" rx="1.2"/>'
    + '<path d="M24 17h9l3 12h-9z"/><path d="M9 17h8l-4 9H4z"/>'
    + '<rect x="0" y="11" width="9" height="5" rx="1.4"/><rect x="18" y="7" width="12" height="3" rx="1.2" opacity=".7"/></g></svg>',
  sniper: '<svg viewBox="0 0 64 32" aria-hidden="true"><g fill="currentColor">'
    + '<rect x="4" y="12" width="56" height="5" rx="1.4"/><rect x="22" y="5" width="18" height="5" rx="2"/>'
    + '<rect x="26" y="10" width="3" height="3"/><rect x="34" y="10" width="3" height="3"/>'
    + '<path d="M18 17h8l-3 11h-8z"/><path d="M4 17h9l-3 7H1z"/>'
    + '<path d="M44 17l5 9h-3l-4-9z" opacity=".7"/></g></svg>',
  grenade: '<svg viewBox="0 0 64 32" aria-hidden="true"><g fill="currentColor">'
    + '<rect x="26" y="4" width="10" height="5" rx="1.6"/><rect x="29" y="8" width="5" height="3"/>'
    + '<path d="M36 5h7a3 3 0 0 1 3 3v9h-3V9h-7z"/>'
    + '<ellipse cx="31.5" cy="20" rx="12" ry="10"/></g></svg>',
});

/**
 * Weapon definition lookup. `WEAPONS` (contract section 11) is the single source of truth for
 * Korean names, magazine sizes, base spread and reload times; the object literal below is only a
 * last-resort shape for a key the weapon table does not know about.
 * @param {string} key Weapon key.
 * @returns {object} Weapon definition.
 */
function weaponDef(key) {
  const d = WEAPONS && WEAPONS[key];
  return d || WEAPON_UNKNOWN;
}

/** Shape used when a weapon key is not in `WEAPONS` (never in a shipped build). */
const WEAPON_UNKNOWN = Object.freeze({
  key: '?', name: '?', nameKo: '무기', magazine: 12, reserve: 0,
  spread: 0.02, reloadTime: 2, melee: false,
});

/** Toast lifetimes and CSS modifier per notification kind. */
const TOAST_KIND = Object.freeze({
  info: 'info', warn: 'warn', money: 'money', mission: 'mission', wanted: 'wanted',
});

const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.9 6.1 6.6.9-4.8 4.6 1.2 6.6-5.9-3.2-5.9 3.2 1.2-6.6L2.5 9.6l6.6-.9z"/></svg>';

/** Reusable scratch buffers — the radar must not allocate per frame. */
const _qFills = [];
const _qRoads = [];
const _tmp = { x: 0, y: 0 };
/** Reused by `_updateMission` so the timer scan never allocates. */
const _timerSrc = [null, null, null];

/* ------------------------------------------------------------------ helpers */

/**
 * Creates an element, optionally with a class, parent and inner HTML.
 * @param {string} tag Tag name.
 * @param {string} [cls] Class name.
 * @param {HTMLElement} [parent] Parent to append to.
 * @param {string} [html] Inner HTML.
 * @returns {HTMLElement} The created element.
 */
function el(tag, cls, parent, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined && html !== null) e.innerHTML = html;
  if (parent && parent.appendChild) parent.appendChild(e);
  return e;
}

/**
 * Sets `textContent` only when it actually changes.
 * @param {HTMLElement} node Target node.
 * @param {string} text New text.
 * @returns {boolean} True when the DOM was written.
 */
function setText(node, text) {
  if (!node) return false;
  if (node.__t === text) return false;
  node.__t = text;
  node.textContent = text;
  return true;
}

/**
 * Toggles a class only when the desired state differs from the cached state.
 * @param {HTMLElement} node Target node.
 * @param {string} cls Class name.
 * @param {boolean} on Desired state.
 * @returns {void}
 */
function setClass(node, cls, on) {
  if (!node || !node.classList) return;
  const key = `__c_${cls}`;
  const want = !!on;
  if (node[key] === want) return;
  node[key] = want;
  if (want) node.classList.add(cls);
  else node.classList.remove(cls);
}

/**
 * Writes a style property only when the string changed.
 * @param {HTMLElement} node Target node.
 * @param {string} prop CSS property (camelCase).
 * @param {string} value New value.
 * @returns {void}
 */
function setStyle(node, prop, value) {
  if (!node || !node.style) return;
  const key = `__s_${prop}`;
  if (node[key] === value) return;
  node[key] = value;
  node.style[prop] = value;
}

/**
 * Restarts a CSS animation without forcing a layout read by alternating two classes.
 * @param {HTMLElement} node Target node.
 * @returns {void}
 */
function pulseClass(node) {
  if (!node || !node.classList) return;
  const a = node.__pa === true;
  node.__pa = !a;
  if (a) { node.classList.remove('pa'); node.classList.add('pb'); }
  else { node.classList.remove('pb'); node.classList.add('pa'); }
}

/** @returns {number} Finite number or the fallback. */
function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Formats seconds as `m:ss`. @param {number} s Seconds. @returns {string} Timer text. */
function timeText(s) {
  const t = Math.max(0, Math.floor(s));
  const m = Math.floor(t / 60);
  const r = t % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

/* ------------------------------------------------------------------ minimap */

/**
 * Uniform-grid index over the city's minimap data so the radar only touches nearby geometry.
 * Built once; queried with reusable output arrays (zero allocation per frame).
 */
class MinimapIndex {
  /** @param {object} data `world.minimapData`. */
  constructor(data) {
    const b = (data && data.bounds) || { min: [-800, -800], max: [800, 800] };
    this.cell = 96;
    this.minX = b.min[0] - 64;
    this.minZ = b.min[1] - 64;
    this.cols = Math.max(1, Math.ceil((b.max[0] - b.min[0] + 128) / this.cell));
    this.rows = Math.max(1, Math.ceil((b.max[1] - b.min[1] + 128) / this.cell));

    /** @type {Array<{x0:number,z0:number,w:number,d:number,c:string,layer:number}>} */
    this.fills = [];
    /** @type {Array<{x1:number,z1:number,x2:number,z2:number,w:number,avenue:boolean}>} */
    this.roads = [];

    const pushRects = (list, layer, fallback) => {
      if (!list) return;
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        const w = num(r.w, 0);
        const d = num(r.d, 0);
        if (w <= 0 || d <= 0) continue;
        const x0 = num(r.x0, num(r.x, 0) - w * 0.5);
        const z0 = num(r.z0, num(r.z, 0) - d * 0.5);
        this.fills.push({ x0, z0, w, d, c: typeof r.c === 'string' ? r.c : fallback, layer });
      }
    };
    pushRects(data && data.water, 0, RC.water);
    pushRects(data && data.parks, 1, RC.park);
    pushRects(data && data.blocks, 2, RC.block);

    const roads = (data && data.roads) || [];
    for (let i = 0; i < roads.length; i++) {
      const r = roads[i];
      const x1 = num(r.x1, num(r.ax, NaN));
      const z1 = num(r.z1, num(r.az, NaN));
      const x2 = num(r.x2, num(r.bx, NaN));
      const z2 = num(r.z2, num(r.bz, NaN));
      if (!Number.isFinite(x1) || !Number.isFinite(z1) || !Number.isFinite(x2) || !Number.isFinite(z2)) continue;
      const kind = r.kind || 'street';
      this.roads.push({
        x1, z1, x2, z2, w: num(r.w, num(r.width, 12)),
        avenue: kind === 'avenue' || kind === 'boulevard' || kind === 'highway',
      });
    }

    this.fillCells = new Array(this.cols * this.rows);
    this.roadCells = new Array(this.cols * this.rows);
    this._bucket(this.fills, this.fillCells, (o) => [o.x0, o.z0, o.x0 + o.w, o.z0 + o.d]);
    this._bucket(this.roads, this.roadCells, (o) => [
      Math.min(o.x1, o.x2) - o.w, Math.min(o.z1, o.z2) - o.w,
      Math.max(o.x1, o.x2) + o.w, Math.max(o.z1, o.z2) + o.w,
    ]);

    this.fillStamp = new Int32Array(this.fills.length);
    this.roadStamp = new Int32Array(this.roads.length);
    this.stamp = 0;
  }

  /**
   * Buckets items into the uniform grid.
   * @param {Array<object>} items Items to insert.
   * @param {Array<Array<number>>} cells Destination cell array (index lists).
   * @param {(o:object)=>number[]} boundsOf Returns [minx, minz, maxx, maxz].
   * @returns {void}
   */
  _bucket(items, cells, boundsOf) {
    for (let i = 0; i < items.length; i++) {
      const b = boundsOf(items[i]);
      const i0 = clamp(Math.floor((b[0] - this.minX) / this.cell), 0, this.cols - 1);
      const j0 = clamp(Math.floor((b[1] - this.minZ) / this.cell), 0, this.rows - 1);
      const i1 = clamp(Math.floor((b[2] - this.minX) / this.cell), 0, this.cols - 1);
      const j1 = clamp(Math.floor((b[3] - this.minZ) / this.cell), 0, this.rows - 1);
      for (let j = j0; j <= j1; j++) {
        for (let ii = i0; ii <= i1; ii++) {
          const k = j * this.cols + ii;
          let arr = cells[k];
          if (!arr) { arr = []; cells[k] = arr; }
          arr.push(i);
        }
      }
    }
  }

  /**
   * Collects the fills and roads overlapping a world-space rectangle.
   * @param {number} x0 Min x.
   * @param {number} z0 Min z.
   * @param {number} x1 Max x.
   * @param {number} z1 Max z.
   * @param {Array<object>} outFills Reused output array for fills (sorted by layer).
   * @param {Array<object>} outRoads Reused output array for roads.
   * @returns {void}
   */
  query(x0, z0, x1, z1, outFills, outRoads) {
    outFills.length = 0;
    outRoads.length = 0;
    this.stamp++;
    const s = this.stamp;
    const i0 = clamp(Math.floor((x0 - this.minX) / this.cell), 0, this.cols - 1);
    const j0 = clamp(Math.floor((z0 - this.minZ) / this.cell), 0, this.rows - 1);
    const i1 = clamp(Math.floor((x1 - this.minX) / this.cell), 0, this.cols - 1);
    const j1 = clamp(Math.floor((z1 - this.minZ) / this.cell), 0, this.rows - 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * this.cols + i;
        const fa = this.fillCells[k];
        if (fa) {
          for (let n = 0; n < fa.length; n++) {
            const id = fa[n];
            if (this.fillStamp[id] === s) continue;
            this.fillStamp[id] = s;
            outFills.push(this.fills[id]);
          }
        }
        const ra = this.roadCells[k];
        if (ra) {
          for (let n = 0; n < ra.length; n++) {
            const id = ra[n];
            if (this.roadStamp[id] === s) continue;
            this.roadStamp[id] = s;
            outRoads.push(this.roads[id]);
          }
        }
      }
    }
    outFills.sort(byLayer);
  }
}

/** @param {{layer:number}} a First. @param {{layer:number}} b Second. @returns {number} Sort key. */
function byLayer(a, b) { return a.layer - b.layer; }

/**
 * The circular radar in the bottom-left corner: rotating city plan, blips, player cone,
 * north indicator plus the segmented health/armor ring drawn around the dial.
 */
class Minimap {
  /**
   * @param {HTMLCanvasElement} canvas Radar canvas.
   * @param {object} game Game instance (contract section 16).
   */
  constructor(canvas, game) {
    this.canvas = canvas;
    this.game = game;
    this.ctx = canvas.getContext ? canvas.getContext('2d') : null;
    this.index = null;
    this._indexSrc = null;
    /** Startable mission markers, refreshed a few times a second (never per frame). */
    this.markers = null;
    this._markerTimer = 0;
    this._px = 0; this._pz = 0; this._cx = 0; this._cy = 0;
    this._ca = 1; this._sa = 0; this._scale = 1; this._r2 = 0;
    this.rotate = true;
    this.range = 105;
    this._rangeShown = 105;
    this.size = 226;
    this.dpr = 1;
    this._time = 0;
    this._blipPulse = 0;
  }

  /**
   * Builds the spatial index, and rebuilds it when the world is replaced (new game / new seed).
   * @returns {void}
   */
  ensureIndex() {
    const g = this.game;
    const data = g && g.world ? g.world.minimapData : null;
    if (!data) return;
    if (this.index && this._indexSrc === data) return;
    this._indexSrc = data;
    this.index = new MinimapIndex(data);
  }

  /**
   * Resizes the backing store to the CSS box.
   * @param {number} cssSize Size in CSS pixels.
   * @param {number} dpr Device pixel ratio.
   * @returns {void}
   */
  resize(cssSize, dpr) {
    const s = Math.max(120, Math.round(cssSize || 226));
    const d = clamp(dpr || 1, 1, 2.5);
    this.size = s;
    this.dpr = d;
    if (this.canvas) {
      this.canvas.width = Math.round(s * d);
      this.canvas.height = Math.round(s * d);
    }
  }

  /**
   * Draws one radar frame.
   * @param {number} dt Delta seconds.
   * @param {number} hp01 Health fraction 0..1.
   * @param {number} armor01 Armor fraction 0..1.
   * @param {object|null} waypoint `{x,z}` or null.
   * @returns {void}
   */
  draw(dt, hp01, armor01, waypoint) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.ensureIndex();
    this._refreshMarkers(dt);
    this._time += dt;

    const g = this.game;
    const player = g && g.player ? g.player : null;
    const px = player && player.position ? num(player.position[0], 0) : 0;
    const pz = player && player.position ? num(player.position[2], 0) : 0;
    const veh = player ? player.vehicle : null;

    // Zoom out with speed while driving.
    let speed = 0;
    if (veh) {
      speed = Math.abs(num(veh.speed, 0));
      if (speed < 0.001 && veh.velocity) speed = Math.hypot(num(veh.velocity[0], 0), num(veh.velocity[2], 0));
    }
    const targetRange = clamp(96 + speed * 3.6 * 0.55, 90, 260);
    this.range = targetRange;
    this._rangeShown = damp(this._rangeShown, targetRange, 3.2, clamp(dt, 0, 0.1));
    const range = Math.max(30, this._rangeShown);

    const S = this.size;
    const d = this.dpr;
    const cx = S * 0.5;
    const cy = S * 0.5;
    const mapR = S * 0.395;
    const scale = mapR / range;

    const camYaw = g && g.camera ? num(g.camera.yaw, 0) : 0;
    const a = this.rotate ? camYaw : 0;
    const ca = Math.cos(a);
    const sa = Math.sin(a);

    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, S, S);

    // --- dial background -----------------------------------------------------------------
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, mapR, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = RC.bg;
    ctx.fill();
    ctx.clip();

    const idx = this.index;
    if (idx) {
      const pad = range * 1.45;
      idx.query(px - pad, pz - pad, px + pad, pz + pad, _qFills, _qRoads);

      // Fills (water -> parks -> blocks), rotated rectangles.
      let lastFill = '';
      for (let i = 0; i < _qFills.length; i++) {
        const f = _qFills[i];
        const fx = f.x0 + f.w * 0.5 - px;
        const fz = f.z0 + f.d * 0.5 - pz;
        const sx = cx + (fx * ca - fz * sa) * scale;
        const sy = cy + (fx * sa + fz * ca) * scale;
        const hw = f.w * 0.5 * scale;
        const hh = f.d * 0.5 * scale;
        const rad = Math.hypot(hw, hh);
        if (sx + rad < 0 || sx - rad > S || sy + rad < 0 || sy - rad > S) continue;
        if (f.c !== lastFill) { ctx.fillStyle = f.c; lastFill = f.c; }
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(a);
        ctx.fillRect(-hw, -hh, hw * 2, hh * 2);
        ctx.restore();
      }

      // Roads as thick strokes; avenues brighter and wider.
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass === 0 ? RC.road : RC.avenue;
        for (let i = 0; i < _qRoads.length; i++) {
          const r = _qRoads[i];
          if ((pass === 1) !== r.avenue) continue;
          const ax = r.x1 - px;
          const az = r.z1 - pz;
          const bx = r.x2 - px;
          const bz = r.z2 - pz;
          const s1x = cx + (ax * ca - az * sa) * scale;
          const s1y = cy + (ax * sa + az * ca) * scale;
          const s2x = cx + (bx * ca - bz * sa) * scale;
          const s2y = cy + (bx * sa + bz * ca) * scale;
          if ((s1x < 0 && s2x < 0) || (s1x > S && s2x > S)
            || (s1y < 0 && s2y < 0) || (s1y > S && s2y > S)) continue;
          ctx.lineWidth = Math.max(1.6, r.w * scale);
          ctx.beginPath();
          ctx.moveTo(s1x, s1y);
          ctx.lineTo(s2x, s2y);
          ctx.stroke();
        }
      }
    }

    // --- waypoint line -------------------------------------------------------------------
    const wp = waypoint;
    if (wp && Number.isFinite(wp.x) && Number.isFinite(wp.z)) {
      const wx = wp.x - px;
      const wz = wp.z - pz;
      const sx = cx + (wx * ca - wz * sa) * scale;
      const sy = cy + (wx * sa + wz * ca) * scale;
      ctx.strokeStyle = RC.waypoint;
      ctx.lineWidth = 2;
      ctx.setLineDash(DASH_WAYPOINT);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(sx, sy);
      ctx.stroke();
      ctx.setLineDash(DASH_NONE);
    }

    // --- blips ---------------------------------------------------------------------------
    this._blipPulse = (this._blipPulse + dt * 2.4) % (Math.PI * 2);
    const pulse = 0.7 + Math.sin(this._blipPulse) * 0.3;
    this._drawBlips(ctx, cx, cy, px, pz, ca, sa, scale, mapR, pulse);
    ctx.restore();

    // --- rim, north, player ----------------------------------------------------------------
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, mapR, 0, Math.PI * 2);
    ctx.strokeStyle = RC.rim;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, mapR - 3.5, 0, Math.PI * 2);
    ctx.strokeStyle = RC.rimSoft;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // North indicator: transform the world north vector (0,-1) with the radar rotation.
    const nx = cx + (0 * ca - -1 * sa) * (mapR - 11);
    const ny = cy + (0 * sa + -1 * ca) * (mapR - 11);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(nx, ny - 5.5);
    ctx.lineTo(nx + 4.4, ny + 4);
    ctx.lineTo(nx - 4.4, ny + 4);
    ctx.closePath();
    ctx.fillStyle = RC.north;
    ctx.fill();
    ctx.font = '700 9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = RC.text;
    ctx.fillText('N', nx, ny + 11);
    ctx.restore();

    // Player cone: heading of the body (or car), transformed by the same rotation.
    let heading = 0;
    if (veh) heading = num(veh.yaw, 0);
    else if (player) heading = num(player.yaw, 0);
    const fx = -Math.sin(heading);
    const fz = -Math.cos(heading);
    const dx = fx * ca - fz * sa;
    const dy = fx * sa + fz * ca;
    const ang = Math.atan2(dy, dx);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 26, -0.42, 0.42);
    ctx.closePath();
    ctx.fillStyle = RC.playerCone;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(-6, 5.6);
    ctx.lineTo(-3.4, 0);
    ctx.lineTo(-6, -5.6);
    ctx.closePath();
    ctx.fillStyle = RC.player;
    ctx.fill();
    ctx.restore();

    // --- vitals ring -----------------------------------------------------------------------
    this._drawVitals(ctx, cx, cy, S, hp01, armor01);
  }

  /**
   * Projects a world position into radar pixels (stored in `_tmp`).
   * @param {number} wx World x.
   * @param {number} wz World z.
   * @returns {boolean} True when the point falls inside the dial.
   */
  _plot(wx, wz) {
    const ax = wx - this._px;
    const az = wz - this._pz;
    const x = this._cx + (ax * this._ca - az * this._sa) * this._scale;
    const y = this._cy + (ax * this._sa + az * this._ca) * this._scale;
    _tmp.x = x;
    _tmp.y = y;
    const dx = x - this._cx;
    const dy = y - this._cy;
    return dx * dx + dy * dy < this._r2;
  }

  /**
   * Refreshes the startable-mission marker list at 4 Hz. `getAvailable()` allocates, so it is
   * never called from the per-frame path; `markers` is the raw fallback when it is missing.
   * @param {number} dt Delta seconds.
   * @returns {void}
   */
  _refreshMarkers(dt) {
    this._markerTimer -= dt;
    if (this._markerTimer > 0 && this.markers !== null) return;
    this._markerTimer = 0.25;
    const mm = this.game ? this.game.missions : null;
    if (!mm) { this.markers = null; return; }
    if (typeof mm.getAvailable === 'function') {
      try {
        const list = mm.getAvailable();
        if (Array.isArray(list)) { this.markers = list; return; }
      } catch (err) { /* a mission manager still booting must not break the radar */ }
    }
    this.markers = Array.isArray(mm.markers) ? mm.markers
      : Array.isArray(mm.available) ? mm.available : null;
  }

  /**
   * Draws every blip category around the player.
   * @param {CanvasRenderingContext2D} ctx Context.
   * @param {number} cx Centre x.
   * @param {number} cy Centre y.
   * @param {number} px Player world x.
   * @param {number} pz Player world z.
   * @param {number} ca cos(rotation).
   * @param {number} sa sin(rotation).
   * @param {number} scale Pixels per meter.
   * @param {number} mapR Radar radius in pixels.
   * @param {number} pulse Pulsing factor 0.4..1.
   * @returns {void}
   */
  _drawBlips(ctx, cx, cy, px, pz, ca, sa, scale, mapR, pulse) {
    const g = this.game;
    if (!g) return;
    // Projection parameters live on the instance so `_plot` needs no per-frame closure.
    this._px = px; this._pz = pz; this._cx = cx; this._cy = cy;
    this._ca = ca; this._sa = sa; this._scale = scale; this._r2 = mapR * mapR;

    // Vehicles (grey) — skip the player's own car, cheap distance reject first.
    const vehicles = g.vehicles;
    if (vehicles && vehicles.length) {
      ctx.fillStyle = RC.vehicle;
      const own = g.player ? g.player.vehicle : null;
      const rangeSq = (mapR / Math.max(0.0001, scale)) * (mapR / Math.max(0.0001, scale));
      for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i];
        if (!v || v === own || !v.position) continue;
        if (v.isPolice) continue;
        const ddx = num(v.position[0], 0) - px;
        const ddz = num(v.position[2], 0) - pz;
        if (ddx * ddx + ddz * ddz > rangeSq) continue;
        if (!this._plot(num(v.position[0], 0), num(v.position[2], 0))) continue;
        ctx.fillRect(_tmp.x - 2, _tmp.y - 2, 4, 4);
      }
    }

    // Pickups (green).
    const pickups = g.pickups;
    if (pickups && pickups.length) {
      ctx.fillStyle = RC.pickup;
      for (let i = 0; i < pickups.length; i++) {
        const k = pickups[i];
        if (!k || k.taken) continue;
        if (!this._plot(num(k.x, 0), num(k.z, 0))) continue;
        ctx.beginPath();
        ctx.arc(_tmp.x, _tmp.y, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Mission markers (yellow diamonds) — only the ones the player can actually start.
    const markers = this.markers;
    if (markers && markers.length) {
      ctx.fillStyle = RC.mission;
      for (let i = 0; i < markers.length; i++) {
        const m = markers[i];
        if (!m) continue;
        const mp = m.position;
        const mx = num(m.x, mp ? num(mp[0], NaN) : NaN);
        const mz = num(m.z, mp ? num(mp[2], NaN) : NaN);
        if (!Number.isFinite(mx) || !Number.isFinite(mz)) continue;
        if (!this._plot(mx, mz)) continue;
        ctx.save();
        ctx.translate(_tmp.x, _tmp.y);
        ctx.rotate(Math.PI * 0.25);
        ctx.fillRect(-3.4, -3.4, 6.8, 6.8);
        ctx.restore();
      }
    }

    // Police (blue, pulsing while wanted).
    const police = g.police;
    if (police) {
      const cars = police.cars;
      const cops = police.cops;
      ctx.fillStyle = RC.police;
      const alpha = ctx.globalAlpha;
      ctx.globalAlpha = alpha * (num(police.wanted, 0) > 0 ? pulse : 0.85);
      if (cars && cars.length) {
        for (let i = 0; i < cars.length; i++) {
          const c = cars[i];
          const p = c && (c.position || (c.vehicle && c.vehicle.position));
          if (!p) continue;
          if (!this._plot(num(p[0], 0), num(p[2], 0))) continue;
          ctx.beginPath();
          ctx.arc(_tmp.x, _tmp.y, 3.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (cops && cops.length) {
        for (let i = 0; i < cops.length; i++) {
          const c = cops[i];
          const p = c && (c.position || (c.character && c.character.position));
          if (!p) continue;
          if (!this._plot(num(p[0], 0), num(p[2], 0))) continue;
          ctx.beginPath();
          ctx.arc(_tmp.x, _tmp.y, 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = alpha;
    }
  }

  /**
   * Segmented health + armor arcs hugging the dial, pulsing red when critical.
   * @param {CanvasRenderingContext2D} ctx Context.
   * @param {number} cx Centre x.
   * @param {number} cy Centre y.
   * @param {number} S Canvas size.
   * @param {number} hp01 Health fraction.
   * @param {number} armor01 Armor fraction.
   * @returns {void}
   */
  _drawVitals(ctx, cx, cy, S, hp01, armor01) {
    const hp = clamp(num(hp01, 1), 0, 1);
    const ar = clamp(num(armor01, 0), 0, 1);
    const low = hp < 0.25;
    const blink = low ? 0.55 + 0.45 * Math.abs(Math.sin(this._time * Math.PI * 2)) : 1;
    const r = S * 0.462;

    // Health climbs the left flank (6 o'clock -> 9 -> 12), armor mirrors it on the right.
    // Canvas angles run clockwise with +y down, so PI/2 is the bottom of the dial.
    this._arcSegments(ctx, cx, cy, r, 5.4, Math.PI * 0.62, Math.PI * 1.46, 13, hp,
      RC.hpTrack, low ? RC.hpLow : RC.hp, blink);
    this._arcSegments(ctx, cx, cy, r, 5.4, Math.PI * 0.38, Math.PI * -0.46, 13, ar,
      RC.hpTrack, RC.armor, ar > 0.001 ? 1 : 0);
  }

  /**
   * Draws a segmented arc gauge.
   * @param {CanvasRenderingContext2D} ctx Context.
   * @param {number} cx Centre x.
   * @param {number} cy Centre y.
   * @param {number} r Radius.
   * @param {number} lw Line width.
   * @param {number} a0 Start angle (radians, canvas convention).
   * @param {number} a1 End angle.
   * @param {number} segs Segment count.
   * @param {number} frac Filled fraction 0..1.
   * @param {string} trackCol Empty colour.
   * @param {string} fillCol Filled colour.
   * @param {number} fillAlpha Alpha applied to the filled part.
   * @returns {void}
   */
  _arcSegments(ctx, cx, cy, r, lw, a0, a1, segs, frac, trackCol, fillCol, fillAlpha) {
    const span = a1 - a0;
    // A negative span sweeps counter-clockwise; the inter-segment gap follows the same sign.
    const ccw = span < 0;
    const gap = Math.min(0.028, Math.abs(span) / (segs * 6)) * (ccw ? -1 : 1);
    ctx.save();
    ctx.lineWidth = lw;
    ctx.lineCap = 'butt';
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs;
      const t1 = (i + 1) / segs;
      const s0 = a0 + span * t0;
      const s1 = a0 + span * t1 - gap;
      const filled = frac >= t1 ? 1 : frac <= t0 ? 0 : (frac - t0) / (t1 - t0);
      ctx.strokeStyle = trackCol;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r, s0, s1, ccw);
      ctx.stroke();
      if (filled > 0 && fillAlpha > 0) {
        ctx.strokeStyle = fillCol;
        ctx.globalAlpha = fillAlpha;
        ctx.beginPath();
        ctx.arc(cx, cy, r, s0, s0 + (s1 - s0) * filled, ccw);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

/** Dash patterns reused so `setLineDash` never allocates in the draw loop. */
const DASH_WAYPOINT = [5, 5];
const DASH_NONE = [];

/* ------------------------------------------------------------------ HUD */

export class HUD {
  /**
   * @param {object} game The Game instance (contract section 16).
   * @param {HTMLElement} rootElement `#hud-root`.
   */
  constructor(game, rootElement) {
    this.game = game;
    this.root = rootElement;
    this.visible = false;

    // --- animated state ---------------------------------------------------------------------
    this._hp = 1;
    this._armor = 0;
    this._money = 0;
    this._moneyTarget = 0;
    this._moneyDigits = [];
    this._moneyDelta = 0;
    this._moneyDeltaTimer = 0;
    this._lastMoney = null;
    this._damage = 0;
    this._damageTarget = 0;
    this._crossSpread = 10;
    this._reloadShown = -1;
    this._fps = 60;
    this._fpsTimer = 0;
    this._debugTimer = 0;
    this._time = 0;
    this._subtitleTimer = 0;
    this._bigTimer = 0;
    this._bigSticky = false;
    this._radioTimer = 0;
    this._lastTrackKey = '';
    this._hitTimer = 0;
    this._missionManual = false;
    this._missionSig = '';
    this._waypoint = null;
    this._lastWanted = -1;
    this._toasts = [];
    this._dirs = [];
    this._objSig = '';

    this._buildDom();
    this.minimap = new Minimap(this._e.radar, game);
    this._readSettings();
    this.resize();
    this._wireEvents();
    this.hide();
  }

  /* ---------------------------------------------------------------- construction */

  /** Builds the whole HUD tree once and caches element references. @returns {void} */
  _buildDom() {
    const root = this.root;
    if (!root) { this._e = {}; return; }
    const wrap = el('div', 'hud', root);
    wrap.innerHTML = HUD_MARKUP;
    this._wrap = wrap;

    const ref = (name) => (wrap.querySelector ? wrap.querySelector(`[data-r="${name}"]`) : null);
    this._e = {
      dmg: ref('dmg'),
      hitdirs: ref('hitdirs'),
      mission: ref('mission'),
      mtitle: ref('mtitle'),
      mtimer: ref('mtimer'),
      mobj: ref('mobj'),
      radio: ref('radio'),
      radioStation: ref('radiostation'),
      radioTitle: ref('radiotitle'),
      radioComposer: ref('radiocomposer'),
      money: ref('money'),
      moneyDelta: ref('moneydelta'),
      wanted: ref('wanted'),
      debug: ref('debug'),
      weapon: ref('weapon'),
      wicon: ref('wicon'),
      wname: ref('wname'),
      wmag: ref('wmag'),
      wres: ref('wres'),
      reloadArc: ref('reloadarc'),
      lowammo: ref('lowammo'),
      veh: ref('veh'),
      spdFill: ref('spdfill'),
      spdNeedle: ref('spdneedle'),
      kmh: ref('kmh'),
      gear: ref('gear'),
      engbar: ref('engbar'),
      vhp: ref('vhp'),
      varmor: ref('varmor'),
      radar: ref('radar'),
      cross: ref('cross'),
      hit: ref('hit'),
      big: ref('big'),
      bigTitle: ref('bigtitle'),
      bigSub: ref('bigsub'),
      subs: ref('subs'),
      toasts: ref('toasts'),
      stars: [],
    };

    // Star elements (cached by index so the blink class is applied to the container only).
    const starWrap = this._e.wanted;
    if (starWrap) {
      for (let i = 0; i < 5; i++) {
        const s = el('span', 'star', starWrap, STAR_SVG);
        this._e.stars.push(s);
      }
    }

    // Damage direction indicator pool.
    if (this._e.hitdirs) {
      for (let i = 0; i < 6; i++) {
        const d = el('i', 'hitdir', this._e.hitdirs);
        this._dirs.push({ el: d, t: 0, life: 0, angle: 0 });
      }
    }
    this._buildMoneyDigits(3);
  }

  /**
   * (Re)builds the rolling money digit columns.
   * @param {number} count Digit count.
   * @returns {void}
   */
  _buildMoneyDigits(count) {
    const host = this._e.money;
    if (!host) return;
    host.innerHTML = '';
    this._moneyDigits.length = 0;
    for (let i = 0; i < count; i++) {
      const digit = el('span', 'digit', host);
      const strip = el('span', 'strip', digit,
        '<b>0</b><b>1</b><b>2</b><b>3</b><b>4</b><b>5</b><b>6</b><b>7</b><b>8</b><b>9</b>');
      this._moneyDigits.push({ strip, value: -1 });
    }
  }

  /** Subscribes to the game event bus. @returns {void} */
  _wireEvents() {
    const g = this.game;
    if (!g || typeof g.on !== 'function') return;
    this._off = [];
    this._off.push(g.on('settingsChanged', () => this._readSettings()));
    this._off.push(g.on('trackChanged', (info) => this.showTrack(info)));
    this._off.push(g.on('missionStarted', () => { this._missionManual = false; }));
    this._off.push(g.on('missionEnded', (payload) => {
      this._missionManual = false;
      this.setMissionText(null, null);
      if (!payload) return;
      // `missions.js` emits {id, result:'success'|'fail'|'abort', note}; a boolean `success`
      // field is also accepted so either shape lights the banner.
      const r = payload.result;
      const passed = payload.success === true || r === 'success';
      const failed = payload.success === false || r === 'fail' || r === 'abort';
      if (passed) this.showMissionResult(true, payload.note || payload.nameKo || payload.name || '');
      else if (failed) this.showMissionResult(false, payload.note || payload.reason || '');
    }));
    this._off.push(g.on('wantedChanged', (lvl) => {
      const n = typeof lvl === 'number' ? lvl : (g.police ? num(g.police.wanted, 0) : 0);
      // Only announce escalations; `_updateWanted()` still owns the star display.
      if (n > 0 && n > this._lastWanted) this.notify(`수배 레벨 ${n}`, 'wanted', 2.2);
    }));
  }

  /** Reads the live settings object from the menu. @returns {void} */
  _readSettings() {
    const g = this.game;
    const s = g && g.menu ? g.menu.settings : null;
    this._settings = s || null;
    const rotate = !s || s.minimapRotate === undefined ? true : !!s.minimapRotate;
    if (this.minimap) this.minimap.rotate = rotate;
    const showFps = !!(s && s.showFps);
    setClass(this._e.debug, 'on', showFps);
  }

  /* ---------------------------------------------------------------- visibility */

  /** Shows the HUD. @returns {void} */
  show() {
    this.visible = true;
    setClass(this._wrap, 'on', true);
    this.resize();
  }

  /** Hides the HUD (menus/main screen). @returns {void} */
  hide() {
    this.visible = false;
    setClass(this._wrap, 'on', false);
  }

  /** Re-measures canvases after a window resize. @returns {void} */
  resize() {
    const dpr = clamp(typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1, 1, 2);
    const canvas = this._e.radar;
    let size = 226;
    if (canvas) {
      const cw = num(canvas.clientWidth, 0);
      if (cw > 40) size = cw;
    }
    if (this.minimap) this.minimap.resize(size, dpr);
  }

  /* ---------------------------------------------------------------- per-frame */

  /**
   * Per-frame HUD tick. Reads gameplay state and only writes the DOM on change.
   * @param {number} dt Delta seconds.
   * @returns {void}
   */
  update(dt) {
    const d = clamp(num(dt, 0), 0, 0.25);
    this._time += d;
    const g = this.game;
    if (!g) return;

    this._updateVitals(d);
    this._updateMoney(d);
    this._updateWanted(d);
    this._updateWeapon(d);
    this._updateVehicle(d);
    this._updateMission(d);
    this._updateCrosshair(d);
    this._updateDamage(d);
    this._updateToasts(d);
    this._updateSubtitle(d);
    this._updateBig(d);
    this._updateRadio(d);
    this._updateDebug(d);

    // The radar is a full canvas repaint: skip it while the HUD is hidden (menu / map screen).
    if (this.minimap && this.visible) {
      const wp = this._waypoint || (g.waypoint && Number.isFinite(g.waypoint.x) ? g.waypoint : null);
      this.minimap.draw(d, this._hp, this._armor, wp);
    }
  }

  /**
   * Smooths and renders health/armor numbers (the ring itself is drawn on the radar canvas).
   * @param {number} dt Delta seconds.
   * @returns {void}
   */
  _updateVitals(dt) {
    const p = this.game.player;
    const maxHp = p ? Math.max(1, num(p.maxHealth, 100)) : 100;
    const maxAr = p ? Math.max(1, num(p.maxArmor, 100)) : 100;
    const hp = p ? clamp(num(p.health, 100) / maxHp, 0, 1) : 1;
    const ar = p ? clamp(num(p.armor, 0) / maxAr, 0, 1) : 0;
    this._hp = damp(this._hp, hp, 11, dt);
    this._armor = damp(this._armor, ar, 11, dt);
    if (Math.abs(this._hp - hp) < 0.002) this._hp = hp;
    if (Math.abs(this._armor - ar) < 0.002) this._armor = ar;

    setText(this._e.vhp, String(Math.max(0, Math.round(hp * maxHp))));
    setText(this._e.varmor, ar > 0.001 ? String(Math.round(ar * maxAr)) : '');
    setClass(this._e.vhp, 'low', hp < 0.25);
    setClass(this._e.varmor, 'on', ar > 0.001);
  }

  /**
   * Rolling money counter + delta popups.
   * @param {number} dt Delta seconds.
   * @returns {void}
   */
  _updateMoney(dt) {
    const p = this.game.player;
    const target = p ? Math.max(0, Math.round(num(p.money, 0))) : 0;
    if (this._lastMoney === null) {
      this._lastMoney = target;
      this._money = target;
    } else if (target !== this._lastMoney) {
      this._moneyDelta += target - this._lastMoney;
      this._moneyDeltaTimer = 0.3;
      this._lastMoney = target;
    }
    this._moneyTarget = target;
    this._money = damp(this._money, target, 9, dt);
    if (Math.abs(this._money - target) < 0.7) this._money = target;

    const shown = Math.max(0, Math.round(this._money));
    const s = String(shown);
    if (s.length !== this._moneyDigits.length) this._buildMoneyDigits(s.length);
    for (let i = 0; i < this._moneyDigits.length; i++) {
      const slot = this._moneyDigits[i];
      const v = s.charCodeAt(i) - 48;
      if (slot.value === v) continue;
      slot.value = v;
      setStyle(slot.strip, 'transform', `translateY(${-v * 10}%)`);
    }

    if (this._moneyDeltaTimer > 0) {
      this._moneyDeltaTimer -= dt;
      if (this._moneyDeltaTimer <= 0 && this._moneyDelta !== 0) {
        this._spawnMoneyDelta(this._moneyDelta);
        this._moneyDelta = 0;
      }
    }
  }

  /**
   * Shows a green/red money delta popup.
   * @param {number} delta Amount.
   * @returns {void}
   */
  _spawnMoneyDelta(delta) {
    const host = this._e.moneyDelta;
    if (!host) return;
    const gain = delta >= 0;
    setText(host, `${gain ? '+' : '-'}$${Math.abs(Math.round(delta))}`);
    setClass(host, 'gain', gain);
    setClass(host, 'loss', !gain);
    pulseClass(host);
  }

  /**
   * Wanted stars: earned stars light up, the group blinks while the police search.
   * @param {number} dt Delta seconds.
   * @returns {void}
   */
  _updateWanted(dt) {
    const police = this.game.police;
    const level = police ? clamp(Math.round(num(police.wanted, 0)), 0, 5) : 0;
    if (level !== this._lastWanted) {
      this._lastWanted = level;
      for (let i = 0; i < this._e.stars.length; i++) {
        setClass(this._e.stars[i], 'on', i < level);
      }
      setClass(this._e.wanted, 'active', level > 0);
    }
    const searching = !!police && (police.searching === true
      || num(police.searchTimer, 0) > 0 || police.heatMeterVisible === true) && level > 0;
    setClass(this._e.wanted, 'searching', searching);
  }

  /**
   * Weapon silhouette, ammo counters, reload arc and the low-ammo warning.
   * @param {number} dt Delta seconds.
   * @returns {void}
   */
  _updateWeapon(dt) {
    const g = this.game;
    const w = g.weapons;
    const p = g.player;
    const key = (w && typeof w.current === 'string' ? w.current : (p && p.weapon) || 'pistol');
    const inCar = !!(p && p.vehicle);
    setClass(this._e.weapon, 'off', !!(p && p.dead));

    if (this._weaponKey !== key) {
      this._weaponKey = key;
      if (this._e.wicon) this._e.wicon.innerHTML = WEAPON_ICONS[key] || WEAPON_ICONS.pistol;
      const def = weaponDef(key);
      setText(this._e.wname, def.nameKo || def.name || key);
    }

    let mag = -1;
    let reserve = -1;
    if (w && w.ammo && w.ammo[key]) {
      mag = Math.round(num(w.ammo[key].mag, -1));
      reserve = Math.round(num(w.ammo[key].reserve, -1));
    }
    const melee = weaponDef(key).melee === true || key === 'fist';
    if (melee || mag < 0) {
      setText(this._e.wmag, melee ? '∞' : '--');
      setText(this._e.wres, '');
      setClass(this._e.lowammo, 'on', false);
    } else {
      setText(this._e.wmag, String(mag));
      setText(this._e.wres, reserve >= 0 ? `/ ${reserve}` : '');
      // Thrown/single-shot weapons (grenades) have a magazine of 1, so the ratio rule would
      // keep the warning permanently lit — only real magazines get a low-ammo banner.
      const capacity = this._magCapacity(key, mag);
      const low = capacity >= 4 && mag <= Math.max(1, Math.ceil(capacity * 0.25));
      setClass(this._e.lowammo, 'on', low && !inCar);
      setClass(this._e.wmag, 'low', low);
    }

    // Reload arc — circumference of r=19 circle is ~119.38.
    const prog = this._reloadProgress(w, key);
    if (prog !== this._reloadShown) {
      this._reloadShown = prog;
      const arc = this._e.reloadArc;
      if (arc && arc.setAttribute) {
        const c = 119.38;
        const off = prog < 0 ? c : c * (1 - clamp(prog, 0, 1));
        arc.setAttribute('stroke-dashoffset', off.toFixed(2));
      }
      setClass(this._e.weapon, 'reloading', prog >= 0);
    }
  }

  /**
   * Magazine capacity for the low-ammo threshold.
   * @param {string} key Weapon key.
   * @param {number} mag Current magazine.
   * @returns {number} Capacity.
   */
  _magCapacity(key, mag) {
    const cap = weaponDef(key).magazine;
    if (Number.isFinite(cap) && cap > 0) return cap;
    // Unknown weapon: infer the capacity from the largest magazine ever observed.
    if (this._magMax === undefined) this._magMax = {};
    if (mag > (this._magMax[key] || 0)) this._magMax[key] = mag;
    return Math.max(6, this._magMax[key] || 12);
  }

  /**
   * Normalised reload progress, or -1 when not reloading. `WeaponSystem` publishes `reloading`
   * plus the remaining seconds in `reloadLeft`; the total comes from the weapon table (the
   * shotgun reloads shell by shell, so its per-shell time is the one that animates).
   * @param {object} w Weapon system.
   * @param {string} key Weapon key.
   * @returns {number} 0..1 or -1.
   */
  _reloadProgress(w, key) {
    if (!w) return -1;
    if (w.reloading !== true && w.isReloading !== true) return -1;
    const def = weaponDef(key);
    const shell = num(def.shellTime, 0);
    const total = num(w.reloadDuration, num(w.reloadTotal, shell > 0 ? shell : num(def.reloadTime, 0)));
    const left = num(w.reloadLeft, num(w.reloadTimer, num(w.reloadRemaining, -1)));
    if (total > 0 && left >= 0) return clamp(1 - left / total, 0, 1);
    if (Number.isFinite(w.reloadProgress)) return clamp(w.reloadProgress, 0, 1);
    return 0.5;
  }

  /**
   * Speedometer / gear / engine health, only while the player drives.
   * @param {number} dt Delta seconds.
   * @returns {void}
   */
  _updateVehicle(dt) {
    const p = this.game.player;
    const v = p ? p.vehicle : null;
    setClass(this._e.veh, 'on', !!v);
    if (!v) return;

    let speed = Math.abs(num(v.speed, NaN));
    if (!Number.isFinite(speed)) {
      speed = v.velocity ? Math.hypot(num(v.velocity[0], 0), num(v.velocity[2], 0)) : 0;
    }
    const kmh = clamp(speed * 3.6, 0, 320);
    const shown = Math.round(kmh);
    setText(this._e.kmh, String(shown));

    const frac = clamp(kmh / 260, 0, 1);
    if (this._e.spdFill && this._e.spdFill.setAttribute) {
      const c = 157.08;
      this._e.spdFill.setAttribute('stroke-dashoffset', (c * (1 - frac)).toFixed(2));
    }
    const deg = -90 + frac * 180;
    if (this._e.spdNeedle && this._e.spdNeedle.setAttribute) {
      if (this._needleDeg === undefined || Math.abs(deg - this._needleDeg) > 0.4) {
        this._needleDeg = deg;
        this._e.spdNeedle.setAttribute('transform', `rotate(${deg.toFixed(1)} 60 68)`);
      }
    }

    let gear = num(v.gear, NaN);
    let gearText;
    if (!Number.isFinite(gear)) gearText = kmh > 1 ? 'D' : 'N';
    else if (gear < 0) gearText = 'R';
    else if (gear === 0) gearText = 'N';
    else gearText = String(gear);
    setText(this._e.gear, gearText);

    const maxH = Math.max(1, num(v.maxHealth, 100));
    const eng = clamp(num(v.health, maxH) / maxH, 0, 1);
    setStyle(this._e.engbar, 'transform', `scaleX(${eng.toFixed(3)})`);
    setClass(this._e.engbar, 'crit', eng < 0.3);
    setClass(this._e.veh, 'redline', kmh > 190);
  }

  /**
   * Mission panel: title, objective checklist and the countdown when one is set.
   * @param {number} dt Delta seconds.
   * @returns {void}
   */
  _updateMission(dt) {
    const g = this.game;
    const mm = g.missions;
    const active = mm ? mm.active : null;

    if (!this._missionManual) {
      if (active) {
        const title = this._missionTitle(active);
        const obj = this._missionObjective(mm, active);
        this._applyMission(title, obj);
      } else if (this._missionSig !== '') {
        this._applyMission(null, null);
      }
    }

    // Countdown from whichever field the mission system publishes (reused scratch array).
    let timer = NaN;
    _timerSrc[0] = active;
    _timerSrc[1] = active ? active.state : null;
    _timerSrc[2] = mm;
    for (let i = 0; i < _timerSrc.length && !Number.isFinite(timer); i++) {
      const c = _timerSrc[i];
      if (!c) continue;
      const t = Number.isFinite(c.timeLeft) ? c.timeLeft
        : Number.isFinite(c.timer) ? c.timer
          : Number.isFinite(c.timeRemaining) ? c.timeRemaining : NaN;
      if (Number.isFinite(t) && t >= 0) timer = t;
    }
    const hasTimer = Number.isFinite(timer) && this._missionSig !== '';
    setClass(this._e.mtimer, 'on', hasTimer);
    if (hasTimer) {
      setText(this._e.mtimer, timeText(timer));
      setClass(this._e.mtimer, 'urgent', timer <= 10);
    }
  }

  /** @param {object} active Mission object. @returns {string} Korean title. */
  _missionTitle(active) {
    const def = active.def || active.mission || active;
    return def.nameKo || def.name || active.nameKo || active.name || '미션';
  }

  /**
   * @param {object} mm Mission manager.
   * @param {object} active Mission object.
   * @returns {string|string[]|null} Objective text or list.
   */
  _missionObjective(mm, active) {
    const def = active.def || active.mission || active;
    if (Array.isArray(active.objectives)) return active.objectives;
    if (typeof active.objectiveText === 'string') return active.objectiveText;
    if (typeof def.objectiveText === 'function') {
      try {
        const t = def.objectiveText(active.state !== undefined ? active.state : active);
        if (typeof t === 'string' || Array.isArray(t)) return t;
      } catch (err) { /* a mission still booting must never break the HUD */ }
    }
    if (typeof mm.objectiveText === 'string') return mm.objectiveText;
    if (typeof active.objective === 'string') return active.objective;
    return null;
  }

  /**
   * Writes the mission panel, rebuilding the objective list only when it changed.
   * @param {string|null} title Mission title.
   * @param {string|string[]|null} objective Objective text or list.
   * @returns {void}
   */
  _applyMission(title, objective) {
    const list = objective === null || objective === undefined ? []
      : Array.isArray(objective) ? objective : [objective];
    let sig = '';
    if (title) {
      sig = title;
      for (let i = 0; i < list.length; i++) sig += `\u0002${objSig(list[i])}`;
    }
    if (sig === this._missionSig) return;
    this._missionSig = sig;
    setClass(this._e.mission, 'on', !!title);
    if (!title) return;
    setText(this._e.mtitle, title);
    const host = this._e.mobj;
    if (!host) return;
    host.innerHTML = '';
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const text = typeof item === 'string' ? item : (item && (item.text || item.label)) || '';
      const done = !!(item && typeof item === 'object' && (item.done || item.complete));
      const li = el('li', done ? 'obj done' : 'obj', host);
      el('span', 'tick', li, done ? '✓' : '');
      const txt = el('span', 'txt', li);
      txt.textContent = text;
    }
  }

  /**
   * Crosshair visibility + spread, driven by aim state and weapon accuracy.
   * @param {number} dt Delta seconds.
   * @returns {void}
   */
  _updateCrosshair(dt) {
    const g = this.game;
    const p = g.player;
    const aiming = !!(p && p.aiming) || g.cameraMode === 'aim';
    setClass(this._e.cross, 'on', aiming && !(p && p.dead));

    const w = g.weapons;
    const key = w && typeof w.current === 'string' ? w.current : 'pistol';
    // `spreadRadians` is the live value (base spread + firing bloom) published by WeaponSystem;
    // the weapon table supplies the resting spread before the first shot.
    let spread = num(w && w.spreadRadians, NaN);
    if (!Number.isFinite(spread)) spread = num(w && w.currentSpread, NaN);
    if (!Number.isFinite(spread)) spread = num(weaponDef(key).spread, 0.02);
    let mul = 1;
    if (p) {
      const vel = p.velocity;
      const sp = vel ? Math.hypot(num(vel[0], 0), num(vel[2], 0)) : 0;
      mul += clamp(sp * 0.06, 0, 0.9);
      if (p.sprinting) mul += 0.5;
      if (p.crouching) mul -= 0.25;
    }
    const target = clamp(7 + spread * mul * 900, 6, 78);
    this._crossSpread = damp(this._crossSpread, target, 14, dt);
    const px = Math.round(this._crossSpread);
    if (px !== this._crossPx) {
      this._crossPx = px;
      const node = this._e.cross;
      if (node && node.style) {
        if (typeof node.style.setProperty === 'function') node.style.setProperty('--sp', `${px}px`);
        else node.style.width = `${px * 2 + 26}px`;
      }
    }

    if (this._hitTimer > 0) {
      this._hitTimer -= dt;
      if (this._hitTimer <= 0) setClass(this._e.hit, 'on', false);
    }
  }

  /**
   * Damage vignette decay and the rotating hit-direction arcs.
   * @param {number} dt Delta seconds.
   * @returns {void}
   */
  _updateDamage(dt) {
    this._damage = damp(this._damage, 0, 3.4, dt);
    if (this._damage < 0.004) this._damage = 0;
    const p = this.game.player;
    const maxHp = p ? Math.max(1, num(p.maxHealth, 100)) : 100;
    const hpFrac = p ? clamp(num(p.health, 100) / maxHp, 0, 1) : 1;
    // Below 25 % the vignette breathes so the player feels the danger even without new hits.
    const critical = hpFrac < 0.25 && !(p && p.dead)
      ? (0.22 + 0.16 * Math.abs(Math.sin(this._time * Math.PI * 2))) * (1 - hpFrac / 0.25) : 0;
    const value = clamp(Math.max(this._damage, critical), 0, 1);
    setStyle(this._e.dmg, 'opacity', value.toFixed(3));

    const cam = this.game.camera;
    const camYaw = cam ? num(cam.yaw, 0) : 0;
    for (let i = 0; i < this._dirs.length; i++) {
      const d = this._dirs[i];
      if (d.life <= 0) continue;
      d.t += dt;
      if (d.t >= d.life) {
        d.life = 0;
        setStyle(d.el, 'opacity', '0');
        continue;
      }
      const k = 1 - d.t / d.life;
      const rel = (d.angle + camYaw) * 180 / Math.PI;
      setStyle(d.el, 'transform', `rotate(${rel.toFixed(1)}deg)`);
      setStyle(d.el, 'opacity', (k * 0.9).toFixed(3));
    }
  }

  /**
   * Advances toast lifetimes and removes expired nodes.
   * @param {number} dt Delta seconds.
   * @returns {void}
   */
  _updateToasts(dt) {
    for (let i = this._toasts.length - 1; i >= 0; i--) {
      const t = this._toasts[i];
      t.t += dt;
      if (!t.out && t.t >= t.life) {
        t.out = true;
        setClass(t.el, 'out', true);
      }
      if (t.t >= t.life + 0.45) {
        if (t.el && t.el.parentNode && t.el.parentNode.removeChild) t.el.parentNode.removeChild(t.el);
        this._toasts.splice(i, 1);
      }
    }
  }

  /** @param {number} dt Delta seconds. @returns {void} */
  _updateSubtitle(dt) {
    if (this._subtitleTimer <= 0) return;
    this._subtitleTimer -= dt;
    if (this._subtitleTimer <= 0) setClass(this._e.subs, 'on', false);
  }

  /** @param {number} dt Delta seconds. @returns {void} */
  _updateBig(dt) {
    if (this._bigTimer <= 0 || this._bigSticky) return;
    this._bigTimer -= dt;
    if (this._bigTimer <= 0) this.hideBigMessage();
  }

  /** @param {number} dt Delta seconds. @returns {void} */
  _updateRadio(dt) {
    if (this._radioTimer <= 0) return;
    this._radioTimer -= dt;
    if (this._radioTimer <= 0) setClass(this._e.radio, 'on', false);
  }

  /**
   * FPS / debug readout, refreshed 5x per second when `settings.showFps` is on.
   * @param {number} dt Delta seconds.
   * @returns {void}
   */
  _updateDebug(dt) {
    // A zero/way-too-small dt (paused tab, injected frame) must not spike the average.
    if (dt > 0.0008) this._fps = lerp(this._fps, 1 / dt, 0.08);
    const on = !!(this._settings && this._settings.showFps);
    if (!on) return;
    this._debugTimer -= dt;
    if (this._debugTimer > 0) return;
    this._debugTimer = 0.2;
    const g = this.game;
    const stats = g.renderer && g.renderer.stats ? g.renderer.stats : null;
    const p = g.player;
    const px = p && p.position ? Math.round(num(p.position[0], 0)) : 0;
    const pz = p && p.position ? Math.round(num(p.position[2], 0)) : 0;
    const tris = stats ? Math.round(num(stats.triangles, 0) / 1000) : 0;
    const draws = stats ? Math.round(num(stats.drawCalls, 0)) : 0;
    setText(this._e.debug,
      `${Math.round(this._fps)} FPS · ${draws} DC · ${tris}k tri · ${px},${pz} · ${g.cameraMode || '-'}`);
  }

  /* ---------------------------------------------------------------- public API */

  /**
   * Pushes a toast notification.
   * @param {string} text Korean message.
   * @param {'info'|'warn'|'money'|'mission'|'wanted'} [kind] Visual kind.
   * @param {number} [duration] Seconds on screen.
   * @returns {void}
   */
  notify(text, kind = 'info', duration = 3) {
    const host = this._e.toasts;
    if (!host || text === undefined || text === null) return;
    const k = TOAST_KIND[kind] ? kind : 'info';
    const node = el('div', `toast ${k}`, host);
    el('i', 'bar', node);
    const body = el('span', 'txt', node);
    body.textContent = String(text);
    this._toasts.push({ el: node, t: 0, life: Math.max(0.4, num(duration, 3)), out: false });
    while (this._toasts.length > 6) {
      const old = this._toasts.shift();
      if (old.el && old.el.parentNode && old.el.parentNode.removeChild) old.el.parentNode.removeChild(old.el);
    }
  }

  /**
   * Shows a centred subtitle line near the bottom of the screen.
   * @param {string} text Korean text.
   * @param {number} [duration] Seconds.
   * @returns {void}
   */
  subtitle(text, duration = 3) {
    if (!this._e.subs) return;
    if (!text) {
      this._subtitleTimer = 0;
      setClass(this._e.subs, 'on', false);
      return;
    }
    setText(this._e.subs, String(text));
    setClass(this._e.subs, 'on', true);
    this._subtitleTimer = Math.max(0.5, num(duration, 3));
  }

  /**
   * Sets the mission panel manually (missions.js may drive it directly).
   * Passing `null` clears the panel and hands control back to the mission manager.
   * @param {string|null} title Mission title.
   * @param {string|string[]|null} objective Objective text, or a list of `{text, done}`.
   * @returns {void}
   */
  setMissionText(title, objective) {
    if (!title) {
      this._missionManual = false;
      this._applyMission(null, null);
      return;
    }
    this._missionManual = true;
    this._applyMission(String(title), objective);
  }

  /**
   * Flashes the damage vignette and spawns a direction indicator.
   * @param {number} amount Damage amount.
   * @param {number[]|null} [dir] World-space direction the damage came from.
   * @returns {void}
   */
  flashDamage(amount, dir) {
    const a = clamp(num(amount, 10) / 45, 0.12, 1);
    this._damage = clamp(this._damage + a, 0, 1);
    if (!dir || !Number.isFinite(dir[0]) || !Number.isFinite(dir[2])) return;
    const dx = dir[0];
    const dz = dir[2];
    if (dx === 0 && dz === 0) return;
    // `dir` points from the player TOWARDS the source of the damage (see player.damage()).
    // The on-screen angle is measured clockwise from "up" (= the camera forward direction), so
    // the stored value only needs the live camera yaw added each frame:
    //   theta = PI - atan2(dx, dz) + cameraYaw
    const angle = Math.PI - Math.atan2(dx, dz);
    let slot = null;
    for (let i = 0; i < this._dirs.length; i++) {
      if (this._dirs[i].life <= 0) { slot = this._dirs[i]; break; }
    }
    if (!slot) slot = this._dirs[0];
    if (!slot) return;
    slot.angle = angle;
    slot.t = 0;
    slot.life = 1.1;
    setStyle(slot.el, 'opacity', '0.9');
  }

  /**
   * Flashes the hit marker on the crosshair.
   * @param {'hit'|'kill'|'headshot'} [kind] Marker kind.
   * @returns {void}
   */
  hitMarker(kind = 'hit') {
    if (!this._e.hit) return;
    // `weapons.js` calls this with a boolean headshot flag, so accept both shapes.
    const strong = kind === true || kind === 'kill' || kind === 'headshot';
    setClass(this._e.hit, 'kill', strong);
    setClass(this._e.hit, 'on', true);
    pulseClass(this._e.hit);
    this._hitTimer = 0.22;
  }

  /** Shows the red death banner. @returns {void} */
  showWasted() {
    this._showBig('wasted', 'WASTED', '사망', true);
  }

  /** Shows the blue arrest banner. @returns {void} */
  showBusted() {
    this._showBig('busted', 'BUSTED', '체포됨', true);
  }

  /**
   * Mission pass/fail banner.
   * @param {boolean} passed True for success.
   * @param {string} [label] Mission name or failure reason.
   * @returns {void}
   */
  showMissionResult(passed, label = '') {
    if (passed) this._showBig('passed', '미션 완료', label ? String(label) : 'MISSION PASSED', false, 3.2);
    else this._showBig('failed', '미션 실패', label ? String(label) : 'MISSION FAILED', false, 3.2);
  }

  /**
   * @param {string} cls Modifier class.
   * @param {string} title Large title.
   * @param {string} sub Sub line.
   * @param {boolean} sticky When true the banner stays until `hideBigMessage()`.
   * @param {number} [seconds] Auto-hide delay for non-sticky banners.
   * @returns {void}
   */
  _showBig(cls, title, sub, sticky, seconds = 3) {
    const big = this._e.big;
    if (!big) return;
    for (const c of BIG_CLASSES) setClass(big, c, c === cls);
    setText(this._e.bigTitle, title);
    setText(this._e.bigSub, sub);
    setClass(big, 'on', true);
    pulseClass(big);
    this._bigSticky = !!sticky;
    this._bigTimer = sticky ? 0 : Math.max(0.5, seconds);
  }

  /** Hides whatever big centre message is showing. @returns {void} */
  hideBigMessage() {
    this._bigSticky = false;
    this._bigTimer = 0;
    setClass(this._e.big, 'on', false);
  }

  /**
   * Stores the waypoint used by the radar. Called by `game.setWaypoint()`.
   * @param {number|null} x World X, or null to clear.
   * @param {number|null} z World Z.
   * @returns {void}
   */
  setWaypoint(x, z) {
    if (x === null || x === undefined || !Number.isFinite(x) || !Number.isFinite(z)) {
      this._waypoint = null;
      return;
    }
    if (!this._waypoint) this._waypoint = { x: 0, z: 0 };
    this._waypoint.x = x;
    this._waypoint.z = z;
  }

  /**
   * Slides in the "now playing" radio banner for 5 seconds.
   * @param {object} info `{station|stationKo, composer, title, titleKo}`.
   * @returns {void}
   */
  showTrack(info) {
    if (!info || !this._e.radio) return;
    const title = info.titleKo || info.title || '';
    const composer = info.composer || '';
    const station = info.stationKo || info.station || info.stationName || '라디오';
    const key = `${station}|${composer}|${title}`;
    if (key === this._lastTrackKey && this._radioTimer > 3.6) return;
    this._lastTrackKey = key;
    setText(this._e.radioStation, String(station));
    setText(this._e.radioTitle, String(title));
    setText(this._e.radioComposer, String(composer));
    setClass(this._e.radio, 'on', true);
    pulseClass(this._e.radio);
    this._radioTimer = 5;
  }

  /** Detaches listeners and clears the HUD DOM. @returns {void} */
  dispose() {
    if (this._off) for (const off of this._off) { if (typeof off === 'function') off(); }
    this._off = null;
    if (this.root) this.root.innerHTML = '';
  }
}

/** Big-message modifier classes, cleared together. */
const BIG_CLASSES = ['wasted', 'busted', 'passed', 'failed'];

/** @param {string|object} o Objective entry. @returns {string} Signature fragment. */
function objSig(o) {
  if (typeof o === 'string') return o;
  if (!o) return '';
  return `${o.text || o.label || ''}:${o.done || o.complete ? 1 : 0}`;
}

/** Static HUD markup. Built once; every dynamic node carries a `data-r` reference key. */
const HUD_MARKUP = `
<div class="hud-scan" aria-hidden="true"></div>
<div class="hud-dmg" data-r="dmg" aria-hidden="true"></div>
<div class="hud-hitdirs" data-r="hitdirs" aria-hidden="true"></div>

<div class="hud-tl">
  <section class="hud-mission" data-r="mission">
    <header class="hud-mission-head">
      <span class="kicker">미션</span>
      <span class="hud-mission-timer" data-r="mtimer">0:00</span>
    </header>
    <h3 class="hud-mission-title" data-r="mtitle"></h3>
    <ul class="hud-obj" data-r="mobj"></ul>
  </section>
  <div class="hud-radio" data-r="radio">
    <div class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <div class="hud-radio-txt">
      <span class="station" data-r="radiostation"></span>
      <span class="title" data-r="radiotitle"></span>
      <span class="composer" data-r="radiocomposer"></span>
    </div>
  </div>
</div>

<div class="hud-tr">
  <div class="hud-money"><span class="cur">$</span><span class="digits" data-r="money"></span></div>
  <div class="hud-money-delta" data-r="moneydelta"></div>
  <div class="hud-wanted" data-r="wanted"></div>
  <div class="hud-debug" data-r="debug"></div>
</div>

<div class="hud-bl">
  <div class="hud-radar-wrap">
    <canvas class="hud-radar" data-r="radar" width="226" height="226" aria-hidden="true"></canvas>
    <div class="hud-vitals">
      <span class="hp" data-r="vhp">100</span>
      <em class="ar" data-r="varmor"></em>
    </div>
  </div>
</div>

<div class="hud-br">
  <div class="hud-veh" data-r="veh">
    <svg class="spd" viewBox="0 0 120 84" aria-hidden="true">
      <path class="spd-track" d="M10 68 A50 50 0 1 1 110 68"/>
      <path class="spd-fill" data-r="spdfill" d="M10 68 A50 50 0 1 1 110 68"
        stroke-dasharray="157.08" stroke-dashoffset="157.08"/>
      <g class="spd-needle" data-r="spdneedle" transform="rotate(-90 60 68)">
        <path d="M60 68 L60 24"/>
      </g>
      <circle class="spd-hub" cx="60" cy="68" r="4.5"/>
    </svg>
    <div class="spd-read">
      <b data-r="kmh">0</b><span>km/h</span><em data-r="gear">N</em>
    </div>
    <div class="hud-engine"><i data-r="engbar"></i></div>
  </div>

  <div class="hud-weapon" data-r="weapon">
    <div class="hud-weapon-icon" data-r="wicon"></div>
    <div class="hud-weapon-info">
      <span class="wname" data-r="wname"></span>
      <span class="ammo"><b data-r="wmag">0</b><i data-r="wres"></i></span>
    </div>
    <svg class="hud-reload" viewBox="0 0 44 44" aria-hidden="true">
      <circle class="rl-bg" cx="22" cy="22" r="19"/>
      <circle class="rl-fg" data-r="reloadarc" cx="22" cy="22" r="19"
        stroke-dasharray="119.38" stroke-dashoffset="119.38" transform="rotate(-90 22 22)"/>
    </svg>
    <div class="hud-lowammo" data-r="lowammo">탄약 부족</div>
  </div>
</div>

<div class="hud-center">
  <div class="hud-cross" data-r="cross">
    <i class="blade up"></i><i class="blade dn"></i><i class="blade lf"></i><i class="blade rt"></i>
    <s class="dot"></s>
  </div>
  <div class="hud-hit" data-r="hit">
    <i></i><i></i><i></i><i></i>
  </div>
</div>

<div class="hud-big" data-r="big">
  <div class="big-title" data-r="bigtitle"></div>
  <div class="big-sub" data-r="bigsub"></div>
</div>

<div class="hud-subs" data-r="subs"></div>
<div class="hud-toasts" data-r="toasts"></div>
`;
