/**
 * NEON CITY — main menu, pause menu, settings, controls and credits.
 *
 * The menu owns nothing but its own DOM inside `#menu-root`. It never touches pointer lock:
 * it calls `onStart` / `onResume` / `onQuit` and lets `game.js` decide what to grab.
 *
 * Settings are persisted to `localStorage['neoncity.settings']` and pushed live to the game
 * through `onChange` / `onSettingsChanged`.
 */

import { clamp } from '../core/math.js';

/** localStorage key for persisted settings. */
const STORE_KEY = 'neoncity.settings';

/** Build banner shown on the main menu. */
const BUILD_LINE = 'NEON CITY v1.0 · WebGL2 + Web Audio · 무설치 · 무의존성';

/** Default settings; also the schema used when sanitising a stored blob. */
const DEFAULTS = Object.freeze({
  quality: 'high',
  masterVolume: 0.85,
  musicVolume: 0.6,
  sfxVolume: 0.9,
  sensitivity: 1,
  invertY: false,
  fov: 62,
  cameraShake: 1,
  showFps: false,
  motionBlur: false,
  minimapRotate: true,
  language: 'ko',
});

/** Quality presets with Korean labels. */
const QUALITY_OPTIONS = Object.freeze([
  { value: 'low', label: '낮음' },
  { value: 'medium', label: '보통' },
  { value: 'high', label: '높음' },
  { value: 'ultra', label: '울트라' },
]);

/** Control reference, rendered as a two-column list. */
const CONTROL_GROUPS = Object.freeze([
  {
    title: '이동 · 카메라',
    rows: [
      ['W A S D', '이동'],
      ['Shift', '질주 (스태미나 소모)'],
      ['Space', '점프 / 차량 핸드브레이크'],
      ['Ctrl', '앉기'],
      ['마우스', '시점 회전'],
      ['C', '뒤돌아보기'],
      ['V', '카메라 모드 전환'],
      ['P', '사진 모드'],
    ],
  },
  {
    title: '전투 · 상호작용',
    rows: [
      ['좌클릭', '발사 / 주먹'],
      ['우클릭', '조준 (어깨너머 시점)'],
      ['R', '재장전'],
      ['1 – 5 / 휠', '무기 교체'],
      ['F', '차량 탑승 · 하차'],
      ['E', '상호작용'],
      ['H', '경적'],
      ['Tab', '도시 지도'],
      ['M / N', '다음 곡 / 다음 방송국'],
      ['Esc', '일시정지'],
    ],
  },
]);

/** Credits block (all music is public domain). */
const CREDITS = Object.freeze([
  ['개발', '순수 자바스크립트 · WebGL2 · Web Audio API로 제작. 외부 라이브러리 0개.'],
  ['그래픽', 'PBR 포워드 렌더러, 캐스케이드 그림자, HDR 블룸, ACES 톤매핑, 절차적 텍스처.'],
  ['도시', '시드 기반 절차 생성 — 도로망, 차선, 인도, 건물, 소품 전부 코드로 생성.'],
  ['음악', '전부 실시간 합성. J.S. 바흐 · 베토벤 · 모차르트 · 비발디 · 그리그 · 오펜바흐 · 쇼팽 · 차이콥스키 (퍼블릭 도메인).'],
  ['사운드', '총성, 엔진, 사이렌, 발소리까지 100% 절차적 신디사이즈.'],
]);

/* ------------------------------------------------------------------ helpers */

/**
 * Creates an element with an optional class, parent and inner HTML.
 * @param {string} tag Tag name.
 * @param {string} [cls] Class name.
 * @param {HTMLElement} [parent] Parent node.
 * @param {string} [html] Inner HTML.
 * @returns {HTMLElement} The new element.
 */
function el(tag, cls, parent, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined && html !== null) e.innerHTML = html;
  if (parent && parent.appendChild) parent.appendChild(e);
  return e;
}

/**
 * Adds or removes a class.
 * @param {HTMLElement} node Node.
 * @param {string} cls Class.
 * @param {boolean} on State.
 * @returns {void}
 */
function toggle(node, cls, on) {
  if (!node || !node.classList) return;
  if (on) node.classList.add(cls);
  else node.classList.remove(cls);
}

/** @param {*} v Value. @param {number} f Fallback. @returns {number} Finite number. */
function num(v, f) {
  return typeof v === 'number' && Number.isFinite(v) ? v : f;
}

/** @param {number} v 0..1. @returns {string} Percent label. */
function pct(v) { return `${Math.round(clamp(v, 0, 1) * 100)}%`; }

/* ------------------------------------------------------------------ Menu */

export class Menu {
  /**
   * @param {object} game Game instance (may be a partially built game during boot).
   * @param {HTMLElement} rootElement `#menu-root`.
   */
  constructor(game, rootElement) {
    this.game = game;
    this.root = rootElement;

    /** @type {boolean} True while any menu screen is visible. */
    this.isOpen = false;
    /** @type {null|(()=>void)} Called when the player starts a new game. */
    this.onStart = null;
    /** @type {null|(()=>void)} Called when the player resumes from pause. */
    this.onResume = null;
    /** @type {null|(()=>void)} Called when the player quits to the main menu. */
    this.onQuit = null;
    /** @type {null|((s:object)=>void)} Settings change callback (contract alias). */
    this.onChange = null;
    /** @type {null|((s:object)=>void)} Settings change callback used by game.js. */
    this.onSettingsChanged = null;

    /** @type {object} Live settings object. */
    this.settings = this.loadSettings();

    this._screen = '';
    this._back = 'main';
    this._controls = [];
    this._focus = [];
    this._focusIndex = 0;
    this._drag = null;

    this._buildDom();
    this._refreshControls();
    this._bindGlobalKeys();
    this.hide();
  }

  /* ---------------------------------------------------------------- persistence */

  /**
   * Loads settings from localStorage, filling in defaults for anything missing.
   * @returns {object} Sanitised settings object.
   */
  loadSettings() {
    const out = {};
    for (const k of Object.keys(DEFAULTS)) out[k] = DEFAULTS[k];
    let raw = null;
    try {
      raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORE_KEY) : null;
    } catch (err) { raw = null; }
    if (raw) {
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (err) { parsed = null; }
      if (parsed && typeof parsed === 'object') {
        for (const k of Object.keys(DEFAULTS)) {
          const v = parsed[k];
          if (v === undefined || v === null) continue;
          if (typeof DEFAULTS[k] === 'boolean') out[k] = !!v;
          else if (typeof DEFAULTS[k] === 'number') out[k] = num(v, DEFAULTS[k]);
          else if (typeof v === 'string') out[k] = v;
        }
      }
    }
    out.quality = QUALITY_OPTIONS.some((o) => o.value === out.quality) ? out.quality : DEFAULTS.quality;
    out.masterVolume = clamp(out.masterVolume, 0, 1);
    out.musicVolume = clamp(out.musicVolume, 0, 1);
    out.sfxVolume = clamp(out.sfxVolume, 0, 1);
    out.sensitivity = clamp(out.sensitivity, 0.2, 3);
    out.fov = clamp(out.fov, 50, 100);
    out.cameraShake = clamp(out.cameraShake, 0, 2);
    if (out.language !== 'ko' && out.language !== 'en') out.language = 'ko';
    return out;
  }

  /**
   * Persists the current settings.
   * @returns {boolean} True when the write succeeded.
   */
  saveSettings() {
    try {
      if (typeof localStorage === 'undefined') return false;
      localStorage.setItem(STORE_KEY, JSON.stringify(this.settings));
      return true;
    } catch (err) {
      return false;
    }
  }

  /** Restores factory defaults and applies them live. @returns {void} */
  resetSettings() {
    for (const k of Object.keys(DEFAULTS)) this.settings[k] = DEFAULTS[k];
    this._refreshControls();
    this._emitChange();
  }

  /** Saves and notifies the game that settings changed. @returns {void} */
  _emitChange() {
    this.saveSettings();
    if (typeof this.onChange === 'function') this.onChange(this.settings);
    if (typeof this.onSettingsChanged === 'function') this.onSettingsChanged(this.settings);
  }

  /* ---------------------------------------------------------------- DOM */

  /** Builds every screen once. @returns {void} */
  _buildDom() {
    const root = this.root;
    if (!root) { this._screens = {}; return; }
    root.innerHTML = '';
    const wrap = el('div', 'menu', root);
    this._wrap = wrap;

    // Animated neon backdrop (CSS only).
    el('div', 'menu-bg', wrap,
      '<i class="orb o1"></i><i class="orb o2"></i><i class="orb o3"></i>'
      + '<span class="grid"></span><span class="skyline"></span><span class="scan"></span>');

    this._screens = {
      main: this._buildMain(wrap),
      pause: this._buildPause(wrap),
      settings: this._buildSettings(wrap),
      controls: this._buildControls(wrap),
      credits: this._buildCredits(wrap),
    };
  }

  /**
   * @param {HTMLElement} wrap Menu wrapper.
   * @returns {HTMLElement} The main screen.
   */
  _buildMain(wrap) {
    const s = el('section', 'screen screen-main', wrap);
    const inner = el('div', 'screen-inner', s);
    el('h1', 'brand', inner, 'NEON<span>CITY</span>');
    el('p', 'brand-sub', inner, '오픈월드 액션 · 네온 느와르 도시');
    const nav = el('nav', 'nav', inner);

    const hasSave = !!(this.game && typeof this.game.hasSave === 'function' && this.game.hasSave());
    this._btn(nav, '게임 시작', () => this._start(false), 'primary');
    this._continueBtn = this._btn(nav, '이어하기', () => this._start(true));
    if (!hasSave) this._setDisabled(this._continueBtn, true);
    this._btn(nav, '설정', () => this.showSettings('main'));
    this._btn(nav, '조작법', () => this.showControls('main'));
    this._btn(nav, '크레딧', () => this.showCredits('main'));

    el('p', 'build', inner, BUILD_LINE);
    el('p', 'hint', inner, '마우스를 클릭하면 시점이 잠깁니다 · Esc 로 언제든 일시정지');
    s.__focus = this._collect(nav);
    return s;
  }

  /**
   * @param {HTMLElement} wrap Menu wrapper.
   * @returns {HTMLElement} The pause screen.
   */
  _buildPause(wrap) {
    const s = el('section', 'screen screen-pause', wrap);
    const inner = el('div', 'screen-inner', s);
    el('h2', 'title', inner, '일시정지');
    const nav = el('nav', 'nav', inner);
    this._btn(nav, '계속하기', () => this._resume(), 'primary');
    this._btn(nav, '설정', () => this.showSettings('pause'));
    this._btn(nav, '조작법', () => this.showControls('pause'));
    this._btn(nav, '메인 메뉴로', () => this._quit());
    el('p', 'hint', inner, 'Esc 를 다시 누르면 게임으로 돌아갑니다.');
    s.__focus = this._collect(nav);
    return s;
  }

  /**
   * @param {HTMLElement} wrap Menu wrapper.
   * @returns {HTMLElement} The settings screen.
   */
  _buildSettings(wrap) {
    const s = el('section', 'screen screen-settings', wrap);
    const inner = el('div', 'screen-inner wide', s);
    el('h2', 'title', inner, '설정');
    const cols = el('div', 'cols', inner);

    const gfx = el('div', 'col', cols);
    el('h3', 'col-title', gfx, '그래픽');
    this._options(gfx, 'quality', '품질 프리셋', QUALITY_OPTIONS);
    this._slider(gfx, 'fov', '시야각 (FOV)', 50, 100, 1, (v) => `${Math.round(v)}°`);
    this._toggle(gfx, 'motionBlur', '모션 블러');
    this._toggle(gfx, 'showFps', 'FPS 표시');
    this._options(gfx, 'minimapRotate', '미니맵 방향', [
      { value: true, label: '진행 방향' },
      { value: false, label: '북쪽 고정' },
    ]);

    const aud = el('div', 'col', cols);
    el('h3', 'col-title', aud, '사운드');
    this._slider(aud, 'masterVolume', '마스터 볼륨', 0, 1, 0.01, pct);
    this._slider(aud, 'musicVolume', '음악 볼륨', 0, 1, 0.01, pct);
    this._slider(aud, 'sfxVolume', '효과음 볼륨', 0, 1, 0.01, pct);

    const ctl = el('div', 'col', cols);
    el('h3', 'col-title', ctl, '조작 · 카메라');
    this._slider(ctl, 'sensitivity', '마우스 감도', 0.2, 3, 0.05, (v) => `${v.toFixed(2)}×`);
    this._toggle(ctl, 'invertY', 'Y축 반전');
    this._slider(ctl, 'cameraShake', '카메라 흔들림', 0, 2, 0.05, (v) => `${Math.round(v * 100)}%`);
    this._options(ctl, 'language', '언어 (Language)', [
      { value: 'ko', label: '한국어' },
      { value: 'en', label: 'English' },
    ], '영어 번역은 준비 중입니다. 현재 모든 문구는 한국어로 표시됩니다.');

    const foot = el('div', 'foot', inner);
    this._btn(foot, '기본값으로', () => this.resetSettings());
    this._btn(foot, '뒤로', () => this._backOut(), 'primary');
    s.__focus = this._collect(inner);
    return s;
  }

  /**
   * @param {HTMLElement} wrap Menu wrapper.
   * @returns {HTMLElement} The controls screen.
   */
  _buildControls(wrap) {
    const s = el('section', 'screen screen-controls', wrap);
    const inner = el('div', 'screen-inner wide', s);
    el('h2', 'title', inner, '조작법');
    const cols = el('div', 'cols keys', inner);
    for (const group of CONTROL_GROUPS) {
      const col = el('div', 'col', cols);
      el('h3', 'col-title', col, group.title);
      const dl = el('dl', 'keylist', col);
      for (const row of group.rows) {
        el('dt', null, dl, `<kbd>${row[0]}</kbd>`);
        const dd = el('dd', null, dl);
        dd.textContent = row[1];
      }
    }
    const foot = el('div', 'foot', inner);
    this._btn(foot, '뒤로', () => this._backOut(), 'primary');
    s.__focus = this._collect(foot);
    return s;
  }

  /**
   * @param {HTMLElement} wrap Menu wrapper.
   * @returns {HTMLElement} The credits screen.
   */
  _buildCredits(wrap) {
    const s = el('section', 'screen screen-credits', wrap);
    const inner = el('div', 'screen-inner wide', s);
    el('h2', 'title', inner, '크레딧');
    const list = el('dl', 'credits', inner);
    for (const row of CREDITS) {
      el('dt', null, list).textContent = row[0];
      el('dd', null, list).textContent = row[1];
    }
    el('p', 'build', inner, BUILD_LINE);
    const foot = el('div', 'foot', inner);
    this._btn(foot, '뒤로', () => this._backOut(), 'primary');
    s.__focus = this._collect(foot);
    return s;
  }

  /* ---------------------------------------------------------------- widgets */

  /**
   * Creates a menu button.
   * @param {HTMLElement} parent Parent node.
   * @param {string} label Korean label.
   * @param {()=>void} action Click handler.
   * @param {string} [variant] Extra class.
   * @returns {HTMLElement} The button.
   */
  _btn(parent, label, action, variant) {
    const b = el('button', `btn${variant ? ` ${variant}` : ''}`, parent);
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('tabindex', '0');
    b.__action = action;
    b.__kind = 'button';
    if (b.addEventListener) {
      b.addEventListener('click', (ev) => {
        if (ev && ev.preventDefault) ev.preventDefault();
        if (b.__disabled) return;
        this._click();
        action();
      });
      b.addEventListener('mouseenter', () => this._focusNode(b, false));
    }
    return b;
  }

  /**
   * Disables/enables a button.
   * @param {HTMLElement} b Button.
   * @param {boolean} on Disabled state.
   * @returns {void}
   */
  _setDisabled(b, on) {
    if (!b) return;
    b.__disabled = !!on;
    toggle(b, 'disabled', !!on);
    if (b.setAttribute) {
      b.setAttribute('aria-disabled', on ? 'true' : 'false');
      b.setAttribute('tabindex', on ? '-1' : '0');
    }
  }

  /**
   * Builds a labelled settings row.
   * @param {HTMLElement} parent Column.
   * @param {string} label Korean label.
   * @param {string} [hint] Optional hint line.
   * @returns {{row:HTMLElement, body:HTMLElement, value:HTMLElement}} Row parts.
   */
  _row(parent, label, hint) {
    const row = el('div', 'row', parent);
    const head = el('div', 'row-head', row);
    const l = el('span', 'row-label', head);
    l.textContent = label;
    const value = el('span', 'row-value', head);
    const body = el('div', 'row-body', row);
    if (hint) {
      const h = el('p', 'row-hint', row);
      h.textContent = hint;
    }
    return { row, body, value };
  }

  /**
   * Segmented option picker bound to a settings key.
   * @param {HTMLElement} parent Column.
   * @param {string} key Settings key.
   * @param {string} label Korean label.
   * @param {Array<{value:*, label:string}>} options Options.
   * @param {string} [hint] Optional hint.
   * @returns {void}
   */
  _options(parent, key, label, options, hint) {
    const { body } = this._row(parent, label, hint);
    const group = el('div', 'seg', body);
    if (group.setAttribute) {
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('tabindex', '0');
      group.setAttribute('aria-label', label);
    }
    const items = [];
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const b = el('button', 'seg-item', group);
      b.type = 'button';
      b.textContent = opt.label;
      if (b.setAttribute) b.setAttribute('tabindex', '-1');
      if (b.addEventListener) {
        b.addEventListener('click', (ev) => {
          if (ev && ev.preventDefault) ev.preventDefault();
          this._click();
          this.settings[key] = opt.value;
          this._refreshControls();
          this._emitChange();
          this._focusNode(group, false);
        });
      }
      items.push({ el: b, value: opt.value });
    }
    const ctrl = {
      kind: 'options', key, el: group, items,
      apply: () => {
        for (let i = 0; i < items.length; i++) {
          const on = items[i].value === this.settings[key];
          toggle(items[i].el, 'on', on);
          if (items[i].el.setAttribute) items[i].el.setAttribute('aria-checked', on ? 'true' : 'false');
        }
      },
      step: (dir) => {
        let idx = items.findIndex((it) => it.value === this.settings[key]);
        if (idx < 0) idx = 0;
        idx = clamp(idx + dir, 0, items.length - 1);
        if (items[idx].value === this.settings[key]) return;
        this.settings[key] = items[idx].value;
        ctrl.apply();
        this._emitChange();
      },
      activate: () => ctrl.step(1),
    };
    group.__ctrl = ctrl;
    group.__kind = 'control';
    if (group.addEventListener) group.addEventListener('mouseenter', () => this._focusNode(group, false));
    this._controls.push(ctrl);
  }

  /**
   * Custom slider (no native input element anywhere in the UI).
   * @param {HTMLElement} parent Column.
   * @param {string} key Settings key.
   * @param {string} label Korean label.
   * @param {number} min Minimum.
   * @param {number} max Maximum.
   * @param {number} step Step size.
   * @param {(v:number)=>string} fmt Value formatter.
   * @returns {void}
   */
  _slider(parent, key, label, min, max, step, fmt) {
    const { body, value } = this._row(parent, label);
    const track = el('div', 'slider', body);
    const fill = el('i', 'fill', track);
    const knob = el('b', 'knob', track);
    if (track.setAttribute) {
      track.setAttribute('role', 'slider');
      track.setAttribute('tabindex', '0');
      track.setAttribute('aria-label', label);
      track.setAttribute('aria-valuemin', String(min));
      track.setAttribute('aria-valuemax', String(max));
    }

    const setFromFraction = (f) => {
      const raw = min + clamp(f, 0, 1) * (max - min);
      const snapped = Math.round(raw / step) * step;
      const v = clamp(Number(snapped.toFixed(4)), min, max);
      if (v === this.settings[key]) return;
      this.settings[key] = v;
      ctrl.apply();
      this._emitChange();
    };

    const fractionFromEvent = (ev) => {
      if (!track.getBoundingClientRect) return null;
      const r = track.getBoundingClientRect();
      if (!r || !r.width) return null;
      const x = num(ev && ev.clientX, NaN);
      if (!Number.isFinite(x)) return null;
      return (x - r.left) / r.width;
    };

    if (track.addEventListener) {
      track.addEventListener('pointerdown', (ev) => {
        if (ev && ev.preventDefault) ev.preventDefault();
        this._focusNode(track, true);
        const f = fractionFromEvent(ev);
        if (f !== null) setFromFraction(f);
        this._drag = { track, fractionFromEvent, setFromFraction };
        if (track.setPointerCapture && ev && ev.pointerId !== undefined) {
          try { track.setPointerCapture(ev.pointerId); } catch (err) { /* not critical */ }
        }
      });
      track.addEventListener('pointermove', (ev) => {
        if (!this._drag || this._drag.track !== track) return;
        const f = fractionFromEvent(ev);
        if (f !== null) setFromFraction(f);
      });
      track.addEventListener('pointerup', () => { this._drag = null; });
      track.addEventListener('pointercancel', () => { this._drag = null; });
      track.addEventListener('mouseenter', () => this._focusNode(track, false));
      track.addEventListener('wheel', (ev) => {
        if (ev && ev.preventDefault) ev.preventDefault();
        const d = ev && ev.deltaY > 0 ? -1 : 1;
        ctrl.step(d);
      }, { passive: false });
    }

    const ctrl = {
      kind: 'slider', key, el: track, min, max, step,
      apply: () => {
        const v = clamp(num(this.settings[key], min), min, max);
        const f = (v - min) / (max - min || 1);
        if (fill.style) fill.style.transform = `scaleX(${f.toFixed(4)})`;
        if (knob.style) knob.style.left = `${(f * 100).toFixed(2)}%`;
        value.textContent = fmt(v);
        if (track.setAttribute) {
          track.setAttribute('aria-valuenow', String(v));
          track.setAttribute('aria-valuetext', fmt(v));
        }
      },
      step: (dir) => {
        const v = clamp(num(this.settings[key], min) + dir * step, min, max);
        const snapped = clamp(Number((Math.round(v / step) * step).toFixed(4)), min, max);
        if (snapped === this.settings[key]) return;
        this.settings[key] = snapped;
        ctrl.apply();
        this._emitChange();
      },
      activate: () => { /* sliders are adjusted with left/right */ },
    };
    track.__ctrl = ctrl;
    track.__kind = 'control';
    this._controls.push(ctrl);
  }

  /**
   * On/off switch bound to a boolean settings key.
   * @param {HTMLElement} parent Column.
   * @param {string} key Settings key.
   * @param {string} label Korean label.
   * @returns {void}
   */
  _toggle(parent, key, label) {
    const { body, value } = this._row(parent, label);
    const sw = el('button', 'switch', body, '<i></i>');
    sw.type = 'button';
    if (sw.setAttribute) {
      sw.setAttribute('tabindex', '0');
      sw.setAttribute('aria-label', label);
    }
    const ctrl = {
      kind: 'toggle', key, el: sw,
      apply: () => {
        const on = !!this.settings[key];
        toggle(sw, 'on', on);
        if (sw.setAttribute) sw.setAttribute('aria-pressed', on ? 'true' : 'false');
        value.textContent = on ? '켜짐' : '꺼짐';
      },
      step: (dir) => {
        const on = dir > 0;
        if (!!this.settings[key] === on) return;
        this.settings[key] = on;
        ctrl.apply();
        this._emitChange();
      },
      activate: () => {
        this.settings[key] = !this.settings[key];
        ctrl.apply();
        this._emitChange();
      },
    };
    sw.__ctrl = ctrl;
    sw.__kind = 'control';
    if (sw.addEventListener) {
      sw.addEventListener('click', (ev) => {
        if (ev && ev.preventDefault) ev.preventDefault();
        this._click();
        ctrl.activate();
        this._focusNode(sw, false);
      });
      sw.addEventListener('mouseenter', () => this._focusNode(sw, false));
    }
    this._controls.push(ctrl);
  }

  /**
   * Collects focusable nodes (buttons + custom controls) inside a container.
   * @param {HTMLElement} node Container.
   * @returns {HTMLElement[]} Focusable elements in DOM order.
   */
  _collect(node) {
    const out = [];
    const walk = (n) => {
      if (!n) return;
      const kids = n.children;
      if (!kids) return;
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i];
        if (c.__kind === 'button' || c.__kind === 'control') out.push(c);
        else walk(c);
      }
    };
    walk(node);
    return out;
  }

  /** Pushes every settings value into its widget. @returns {void} */
  _refreshControls() {
    for (let i = 0; i < this._controls.length; i++) this._controls[i].apply();
  }

  /* ---------------------------------------------------------------- navigation */

  /** Plays the UI click if the audio system is up. @returns {void} */
  _click() {
    const g = this.game;
    if (g && g.sfx && typeof g.sfx.uiClick === 'function') {
      try { g.sfx.uiClick('click'); } catch (err) { /* audio may be suspended */ }
    }
  }

  /**
   * Moves the highlight to a node.
   * @param {HTMLElement} node Target.
   * @param {boolean} [force] Also call `focus()`.
   * @returns {void}
   */
  _focusNode(node, force) {
    if (!node) return;
    const list = this._focus;
    const idx = list.indexOf(node);
    if (idx >= 0) this._focusIndex = idx;
    for (let i = 0; i < list.length; i++) toggle(list[i], 'focused', list[i] === node);
    if (force && typeof node.focus === 'function') {
      try { node.focus({ preventScroll: true }); } catch (err) { node.focus(); }
    }
  }

  /**
   * Moves focus by a delta within the current screen.
   * @param {number} dir -1 up, +1 down.
   * @returns {void}
   */
  _moveFocus(dir) {
    const list = this._focus;
    if (!list.length) return;
    let i = this._focusIndex;
    for (let n = 0; n < list.length; n++) {
      i = (i + dir + list.length) % list.length;
      if (!list[i].__disabled) break;
    }
    this._focusNode(list[i], true);
  }

  /** @returns {HTMLElement|null} The currently highlighted node. */
  _current() {
    const list = this._focus;
    if (!list.length) return null;
    return list[clamp(this._focusIndex, 0, list.length - 1)] || null;
  }

  /** Installs the capture-phase key handler used for full keyboard navigation. @returns {void} */
  _bindGlobalKeys() {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    this._onKey = (ev) => this._handleKey(ev);
    window.addEventListener('keydown', this._onKey, true);
    this._onPointerUp = () => { this._drag = null; };
    window.addEventListener('pointerup', this._onPointerUp, true);
  }

  /**
   * Keyboard navigation. Escape only bubbles to the game when the pause/main root is showing,
   * so the game keeps ownership of pause/resume.
   * @param {KeyboardEvent} ev Key event.
   * @returns {void}
   */
  _handleKey(ev) {
    if (!this.isOpen || !ev) return;
    const code = ev.code || ev.key;
    let handled = true;
    switch (code) {
      case 'ArrowDown':
      case 'KeyS':
        this._moveFocus(1);
        break;
      case 'ArrowUp':
      case 'KeyW':
        this._moveFocus(-1);
        break;
      case 'ArrowLeft':
      case 'KeyA': {
        const n = this._current();
        if (n && n.__ctrl) n.__ctrl.step(-1);
        else handled = false;
        break;
      }
      case 'ArrowRight':
      case 'KeyD': {
        const n = this._current();
        if (n && n.__ctrl) n.__ctrl.step(1);
        else handled = false;
        break;
      }
      case 'Enter':
      case 'Space':
      case 'NumpadEnter': {
        const n = this._current();
        if (!n || n.__disabled) { handled = false; break; }
        this._click();
        if (n.__ctrl) n.__ctrl.activate();
        else if (typeof n.__action === 'function') n.__action();
        break;
      }
      case 'Escape': {
        if (this._screen === 'settings' || this._screen === 'controls' || this._screen === 'credits') {
          this._backOut();
        } else {
          handled = false; // let game.js toggle pause
        }
        break;
      }
      default:
        handled = false;
    }
    if (handled) {
      if (ev.preventDefault) ev.preventDefault();
      if (ev.stopPropagation) ev.stopPropagation();
    }
  }

  /* ---------------------------------------------------------------- screens */

  /**
   * Shows one screen and hides the others.
   * @param {string} name Screen key.
   * @returns {void}
   */
  _show(name) {
    if (!this._screens) return;
    this._screen = name;
    this.isOpen = true;
    for (const key of Object.keys(this._screens)) {
      toggle(this._screens[key], 'on', key === name);
    }
    toggle(this.root, 'hidden', false);
    toggle(this._wrap, 'open', true);
    toggle(this._wrap, 'ingame', name !== 'main');
    const screen = this._screens[name];
    this._focus = (screen && screen.__focus) || [];
    this._focusIndex = 0;
    this._refreshControls();
    const first = this._focus.find((n) => !n.__disabled) || this._focus[0];
    if (first) this._focusNode(first, true);
  }

  /** Shows the main menu. @returns {void} */
  showMain() {
    const hasSave = !!(this.game && typeof this.game.hasSave === 'function' && this.game.hasSave());
    this._setDisabled(this._continueBtn, !hasSave);
    this._back = 'main';
    this._show('main');
  }

  /** Shows the pause menu. @returns {void} */
  showPause() {
    this._back = 'pause';
    this._show('pause');
  }

  /**
   * Shows the settings screen.
   * @param {string} [back] Screen to return to.
   * @returns {void}
   */
  showSettings(back) {
    if (back) this._back = back;
    this._show('settings');
  }

  /**
   * Shows the controls reference.
   * @param {string} [back] Screen to return to.
   * @returns {void}
   */
  showControls(back) {
    if (back) this._back = back;
    this._show('controls');
  }

  /**
   * Shows the credits.
   * @param {string} [back] Screen to return to.
   * @returns {void}
   */
  showCredits(back) {
    if (back) this._back = back;
    this._show('credits');
  }

  /** Hides every menu screen. @returns {void} */
  hide() {
    this.isOpen = false;
    this._screen = '';
    this._focus = [];
    this._drag = null;
    if (this._screens) {
      for (const key of Object.keys(this._screens)) toggle(this._screens[key], 'on', false);
    }
    toggle(this._wrap, 'open', false);
    toggle(this.root, 'hidden', true);
    if (typeof document !== 'undefined' && document.activeElement
      && typeof document.activeElement.blur === 'function'
      && this._wrap && this._wrap.contains && this._wrap.contains(document.activeElement)) {
      document.activeElement.blur();
    }
  }

  /** Returns from a sub-screen to whatever opened it. @returns {void} */
  _backOut() {
    if (this._back === 'pause') this.showPause();
    else this.showMain();
  }

  /**
   * Starts (or continues) a game. The game owns pointer lock.
   * @param {boolean} loadSave True for 이어하기.
   * @returns {void}
   */
  _start(loadSave) {
    this.hide();
    if (typeof this.onStart === 'function') this.onStart();
    if (loadSave && this.game && typeof this.game.load === 'function') {
      const ok = this.game.load();
      if (this.game.hud && typeof this.game.hud.notify === 'function') {
        this.game.hud.notify(ok ? '저장된 게임을 불러왔습니다.' : '저장 데이터를 찾을 수 없습니다.',
          ok ? 'info' : 'warn', 3);
      }
    }
  }

  /** Resumes gameplay. @returns {void} */
  _resume() {
    this.hide();
    if (typeof this.onResume === 'function') this.onResume();
  }

  /** Quits to the main menu. @returns {void} */
  _quit() {
    if (typeof this.onQuit === 'function') this.onQuit();
    else this.showMain();
  }

  /** Removes listeners and DOM. @returns {void} */
  dispose() {
    if (typeof window !== 'undefined' && window.removeEventListener) {
      if (this._onKey) window.removeEventListener('keydown', this._onKey, true);
      if (this._onPointerUp) window.removeEventListener('pointerup', this._onPointerUp, true);
    }
    this._onKey = null;
    this._onPointerUp = null;
    if (this.root) this.root.innerHTML = '';
  }
}
