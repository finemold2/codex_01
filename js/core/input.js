/**
 * @file js/core/input.js
 * NEON CITY — unified input manager: keyboard, mouse (pointer lock), gamepad and touch.
 *
 * Everything is expressed as *actions* ('forward', 'fire', 'enterVehicle', ...) that are bound to
 * one or more device *codes*. Codes are lower-cased strings:
 *
 *   keyboard : `KeyboardEvent.code` lower-cased  -> 'keyw', 'space', 'arrowup', 'digit1'
 *   mouse    : 'mouse0' (left), 'mouse1' (middle), 'mouse2' (right)
 *   gamepad  : 'pada'...'padguide' (standard mapping aliases) or 'pad0'...'pad16'
 *
 * The manager never allocates during `update()` / `endFrame()` / `axis()` / `isDown()`:
 * all state lives in objects created once in the constructor, and the per-frame edge sets are
 * `clear()`ed instead of being re-created.
 */

/** Camera radians per pixel of raw mouse movement at `sensitivity === 1`. @type {number} */
const MOUSE_RADIANS_PER_PIXEL = 0.0022;

/** Single-event movement clamp, kills the Chrome pointer-lock spike bug. @type {number} */
const MAX_MOUSE_DELTA = 200;

/** Radius in CSS pixels for a fully deflected virtual touch stick. @type {number} */
const TOUCH_STICK_RADIUS = 68;

/** Keyboard codes whose browser default we always swallow so the page never steals them. */
const ALWAYS_PREVENT = Object.freeze({
  tab: true, space: true, arrowup: true, arrowdown: true, arrowleft: true, arrowright: true,
  slash: true, quote: true,
});

/** DOM node names that own their own keyboard input (menus with text fields). */
const TEXT_INPUT_NODES = Object.freeze({ INPUT: true, TEXTAREA: true, SELECT: true });

/**
 * Standard-mapping gamepad button index -> canonical code.
 * @type {ReadonlyArray<string>}
 */
const PAD_BUTTON_CODES = Object.freeze([
  'pada', 'padb', 'padx', 'pady', 'padlb', 'padrb', 'padlt', 'padrt',
  'padback', 'padstart', 'padls', 'padrs', 'padup', 'paddown', 'padleft', 'padright', 'padguide',
]);

/** Standard-mapping gamepad button index -> key inside `gamepad.buttons`. */
const PAD_BUTTON_NAMES = Object.freeze([
  'a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt',
  'back', 'start', 'ls', 'rs', 'up', 'down', 'left', 'right', 'guide',
]);

/** Every accepted gamepad code -> button index. Built once at module load. */
const PAD_CODE_INDEX = (() => {
  /** @type {Record<string, number>} */
  const map = Object.create(null);
  for (let i = 0; i < PAD_BUTTON_CODES.length; i++) {
    map[PAD_BUTTON_CODES[i]] = i;
    map['pad' + i] = i;
  }
  // A few friendly synonyms so hand-written bindings do not surprise anyone.
  map.padcross = 0; map.padcircle = 1; map.padsquare = 2; map.padtriangle = 3;
  map.padl1 = 4; map.padr1 = 5; map.padl2 = 6; map.padr2 = 7;
  map.padselect = 8; map.padoptions = 9; map.padl3 = 10; map.padr3 = 11;
  map.paddpadup = 12; map.paddpaddown = 13; map.paddpadleft = 14; map.paddpadright = 15;
  return Object.freeze(map);
})();

/**
 * Default action -> device code bindings (keyboard + mouse), exactly as documented in
 * `docs/ARCHITECTURE.md` section 15. Codes are written in canonical `KeyboardEvent.code`
 * casing here; they are lower-cased when copied into a live binding table.
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
export const DEFAULT_BINDINGS = Object.freeze({
  forward: Object.freeze(['KeyW', 'ArrowUp']),
  back: Object.freeze(['KeyS', 'ArrowDown']),
  left: Object.freeze(['KeyA', 'ArrowLeft']),
  right: Object.freeze(['KeyD', 'ArrowRight']),
  sprint: Object.freeze(['ShiftLeft', 'ShiftRight']),
  jump: Object.freeze(['Space']),
  fire: Object.freeze(['Mouse0']),
  aim: Object.freeze(['Mouse2']),
  reload: Object.freeze(['KeyR']),
  interact: Object.freeze(['KeyE']),
  enterVehicle: Object.freeze(['KeyF']),
  map: Object.freeze(['Tab']),
  pause: Object.freeze(['Escape']),
  horn: Object.freeze(['KeyH']),
  lookBack: Object.freeze(['KeyC']),
  cameraMode: Object.freeze(['KeyV']),
  nextTrack: Object.freeze(['KeyM']),
  nextStation: Object.freeze(['KeyN']),
  photo: Object.freeze(['KeyP']),
  weapon1: Object.freeze(['Digit1']),
  weapon2: Object.freeze(['Digit2']),
  weapon3: Object.freeze(['Digit3']),
  weapon4: Object.freeze(['Digit4']),
  weapon5: Object.freeze(['Digit5']),
  handbrake: Object.freeze(['Space']),
  crouch: Object.freeze(['ControlLeft']),
  flashlight: Object.freeze(['KeyL']),
});

/**
 * Default gamepad bindings. Kept in a separate table so `getBindings()` keeps reporting exactly
 * the keyboard/mouse layout the settings screen edits, while a controller still works out of the
 * box. `setBinding()` may nevertheless include 'pad*' codes; they are honoured as well.
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
export const DEFAULT_GAMEPAD_BINDINGS = Object.freeze({
  forward: Object.freeze(['padup']),
  back: Object.freeze(['paddown']),
  left: Object.freeze(['padleft']),
  right: Object.freeze(['padright']),
  sprint: Object.freeze(['padls']),
  jump: Object.freeze(['pada']),
  handbrake: Object.freeze(['pada']),
  fire: Object.freeze(['padrt']),
  aim: Object.freeze(['padlt']),
  reload: Object.freeze(['padx']),
  interact: Object.freeze(['padb']),
  enterVehicle: Object.freeze(['pady']),
  horn: Object.freeze(['padls']),
  crouch: Object.freeze(['padrs']),
  lookBack: Object.freeze(['padlb']),
  cameraMode: Object.freeze(['padrb']),
  map: Object.freeze(['padback']),
  pause: Object.freeze(['padstart']),
});

/** Actions that keep working while `blocked` is true (menus / map open). */
const DEFAULT_UI_ACTIONS = Object.freeze(['pause', 'map']);

/** Human-readable labels for codes that would otherwise render badly in the controls menu. */
const CODE_LABELS = Object.freeze({
  space: 'Space', tab: 'Tab', escape: 'Esc', enter: 'Enter', backspace: 'Backspace',
  arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
  shiftleft: 'L-Shift', shiftright: 'R-Shift', controlleft: 'L-Ctrl', controlright: 'R-Ctrl',
  altleft: 'L-Alt', altright: 'R-Alt', slash: '/', quote: "'", semicolon: ';', comma: ',',
  period: '.', minus: '-', equal: '=', backquote: '`', bracketleft: '[', bracketright: ']',
  backslash: '\\', capslock: 'Caps',
  mouse0: 'LMB', mouse1: 'MMB', mouse2: 'RMB', mouse3: 'Mouse4', mouse4: 'Mouse5',
  pada: 'A', padb: 'B', padx: 'X', pady: 'Y', padlb: 'LB', padrb: 'RB', padlt: 'LT', padrt: 'RT',
  padback: 'Back', padstart: 'Start', padls: 'L3', padrs: 'R3', padup: 'D-Up', paddown: 'D-Down',
  padleft: 'D-Left', padright: 'D-Right', padguide: 'Guide',
});

/**
 * Applies a radial deadzone plus a smooth response curve to a single stick axis pair.
 * Writes the result into `out` (`out.x`, `out.y`) to avoid allocating.
 * @param {{x:number,y:number}} out destination
 * @param {number} x raw axis, -1..1
 * @param {number} y raw axis, -1..1
 * @param {number} deadzone 0..0.9
 * @returns {{x:number,y:number}} out
 */
function applyStick(out, x, y, deadzone) {
  const mag = Math.sqrt(x * x + y * y);
  if (mag <= deadzone || mag <= 1e-6) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  const clamped = mag > 1 ? 1 : mag;
  // Rescale so the stick reaches 1 at the rim, then bend the low end for fine aiming.
  let t = (clamped - deadzone) / (1 - deadzone);
  t = t * t * 0.65 + t * 0.35;
  const s = t / mag;
  out.x = x * s;
  out.y = y * s;
  return out;
}

/**
 * Deadzone + curve for a single analog trigger.
 * @param {number} v raw 0..1
 * @param {number} deadzone
 * @returns {number} 0..1
 */
function applyTrigger(v, deadzone) {
  if (!(v > deadzone)) return 0;
  const t = (v - deadzone) / (1 - deadzone);
  return t > 1 ? 1 : t;
}

/**
 * Clamps a value into -1..1.
 * @param {number} v
 * @returns {number}
 */
function clamp1(v) {
  return v < -1 ? -1 : (v > 1 ? 1 : v);
}

/**
 * Unified input manager. One instance per game; owns all DOM listeners while attached.
 *
 * Typical frame:
 * ```js
 * input.update(dt);         // poll gamepad, decay touch, recompute axes
 * // ... gameplay reads isDown/justPressed/axis/consumeMouseDelta ...
 * input.endFrame();         // clear justPressed / justReleased edges
 * ```
 */
export class Input {
  /**
   * @param {HTMLCanvasElement} canvas canvas that owns pointer lock and touch controls
   * @param {object} [opts]
   * @param {number} [opts.sensitivity=1] mouse/stick look multiplier
   * @param {boolean} [opts.invertY=false] invert vertical look
   * @param {number} [opts.deadzone=0.18] gamepad stick radial deadzone
   * @param {number} [opts.triggerDeadzone=0.06] gamepad trigger deadzone
   * @param {number} [opts.mouseScale=0.0022] radians per pixel at sensitivity 1
   * @param {number} [opts.touchLookScale=1.35] gain applied to touch look drags
   * @param {boolean} [opts.pointerLockOnClick=true] grab pointer lock when the canvas is clicked
   * @param {boolean} [opts.enableTouch=true] install touch listeners
   * @param {string[]} [opts.uiActions] actions that survive `blocked` (default: pause, map)
   * @param {Window|HTMLElement} [opts.target=window] node used for window-level listeners
   */
  constructor(canvas, opts = {}) {
    /** @type {HTMLCanvasElement} */
    this.canvas = canvas || null;
    /** @type {Window|HTMLElement} */
    this.target = opts.target || (typeof window !== 'undefined' ? window : null);
    /** @type {Document|null} */
    this.doc = (this.canvas && this.canvas.ownerDocument)
      || (typeof document !== 'undefined' ? document : null);

    // ---------------------------------------------------------------- public state
    /** Currently held keyboard codes, lower-cased `KeyboardEvent.code`. @type {Set<string>} */
    this.keys = new Set();
    /** Accumulated raw pointer movement in pixels since the last `consumeMouseDelta()`. */
    this.mouseDX = 0;
    /** @type {number} */
    this.mouseDY = 0;
    /** Accumulated wheel movement, normalized to notches (1 notch = one detent). @type {number} */
    this.wheelDelta = 0;
    /** Mouse button state. @type {{left:boolean,right:boolean,middle:boolean}} */
    this.buttons = { left: false, right: false, middle: false };
    /** Pointer position relative to the canvas, in CSS pixels. @type {number} */
    this.mouseX = 0;
    /** @type {number} */
    this.mouseY = 0;
    /** True while the canvas owns pointer lock. @type {boolean} */
    this.pointerLocked = false;
    /**
     * Normalized gamepad snapshot, or null when no controller is connected. The object identity is
     * stable across frames (it is mutated in place).
     * @type {{index:number,id:string,lx:number,ly:number,rx:number,ry:number,lt:number,rt:number,
     *         buttons:Record<string,boolean>}|null}
     */
    this.gamepad = null;
    /**
     * Touch / virtual control state.
     * @type {{active:boolean, moveVec:{x:number,y:number}, lookDX:number, lookDY:number,
     *         buttons:Record<string,boolean>}}
     */
    this.touch = {
      active: false,
      moveVec: { x: 0, y: 0 },
      lookDX: 0,
      lookDY: 0,
      buttons: Object.create(null),
    };
    /** Look sensitivity multiplier. @type {number} */
    this.sensitivity = opts.sensitivity === undefined ? 1 : opts.sensitivity;
    /** Invert the vertical look axis. @type {boolean} */
    this.invertY = !!opts.invertY;
    /** When true, gameplay actions report false; UI actions (pause/map) still work. */
    this.blocked = false;
    /** True between `attach()` and `detach()`. @type {boolean} */
    this.attached = false;

    // ---------------------------------------------------------------- tuning
    /** @type {number} */
    this.deadzone = opts.deadzone === undefined ? 0.18 : opts.deadzone;
    /** @type {number} */
    this.triggerDeadzone = opts.triggerDeadzone === undefined ? 0.06 : opts.triggerDeadzone;
    /** @type {number} */
    this.mouseScale = opts.mouseScale === undefined ? MOUSE_RADIANS_PER_PIXEL : opts.mouseScale;
    /** @type {number} */
    this.touchLookScale = opts.touchLookScale === undefined ? 1.35 : opts.touchLookScale;
    /** @type {boolean} */
    this.pointerLockOnClick = opts.pointerLockOnClick !== false;
    /** @type {boolean} */
    this.enableTouch = opts.enableTouch !== false;

    // ---------------------------------------------------------------- bindings
    /** @type {Record<string, string[]>} */
    this._bindings = Object.create(null);
    /** @type {Record<string, string[]>} */
    this._gamepadBindings = Object.create(null);
    /** code -> actions, rebuilt whenever a binding changes. @type {Map<string, string[]>} */
    this._codeToActions = new Map();
    /** @type {Set<string>} */
    this._uiActions = new Set(opts.uiActions || DEFAULT_UI_ACTIONS);
    this.resetBindings();

    // ---------------------------------------------------------------- per-frame edges
    /** Codes that went down since the last `endFrame()`. @type {Set<string>} */
    this._pressed = new Set();
    /** Codes that went up since the last `endFrame()`. @type {Set<string>} */
    this._released = new Set();
    /** Virtual (touch) actions pressed this frame. @type {Set<string>} */
    this._touchPressed = new Set();
    /** Virtual (touch) actions released this frame. @type {Set<string>} */
    this._touchReleased = new Set();
    /** Actions currently held through on-screen buttons. @type {Set<string>} */
    this._touchActions = new Set();

    // ---------------------------------------------------------------- derived axes (reused)
    /** @type {{moveX:number,moveY:number,lookX:number,lookY:number,throttle:number,steer:number}} */
    this._axes = { moveX: 0, moveY: 0, lookX: 0, lookY: 0, throttle: 0, steer: 0 };
    /** Scratch returned by `consumeMouseDelta()` when the caller passes nothing. */
    this._deltaOut = { x: 0, y: 0 };
    /** Scratch used by the stick curve. */
    this._stickL = { x: 0, y: 0 };
    /** Scratch used by the stick curve. */
    this._stickR = { x: 0, y: 0 };

    // ---------------------------------------------------------------- gamepad internals
    /** Digital button state, index-aligned with `PAD_BUTTON_CODES`. @type {Uint8Array} */
    this._padDown = new Uint8Array(PAD_BUTTON_CODES.length);
    /** Reused gamepad snapshot so `this.gamepad` never reallocates. */
    this._padState = {
      index: -1,
      id: '',
      lx: 0,
      ly: 0,
      rx: 0,
      ry: 0,
      lt: 0,
      rt: 0,
      buttons: Object.create(null),
    };
    for (let i = 0; i < PAD_BUTTON_NAMES.length; i++) this._padState.buttons[PAD_BUTTON_NAMES[i]] = false;
    /** Index of the controller we currently track. @type {number} */
    this._padIndex = -1;
    /** Seconds until the next scan for a freshly connected controller. @type {number} */
    this._padScanTimer = 0;

    // ---------------------------------------------------------------- touch internals
    /** @type {Array<{id:string, action:string, x:number, y:number, w:number, h:number,
     *                rel:boolean, touchId:number}>} */
    this._touchButtons = [];
    /** identifier of the touch driving the virtual stick, -1 when idle. @type {number} */
    this._stickId = -1;
    /** @type {number} */
    this._stickOx = 0;
    /** @type {number} */
    this._stickOy = 0;
    /** identifier of the touch driving the look drag, -1 when idle. @type {number} */
    this._lookId = -1;
    /** @type {number} */
    this._lookLastX = 0;
    /** @type {number} */
    this._lookLastY = 0;
    /** Cached canvas rectangle so touch handling never calls getBoundingClientRect per move. */
    this._rectX = 0;
    this._rectY = 0;
    this._rectW = 1;
    this._rectH = 1;

    // ---------------------------------------------------------------- listeners
    /** @type {Map<string, Function[]>} */
    this._listeners = new Map();
    /** Timestamp (ms) before which pointer-lock requests are ignored after an error. */
    this._lockCooldown = 0;

    // Bind DOM handlers once; `attach()`/`detach()` reuse the same function identities.
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onKeyUp = this._handleKeyUp.bind(this);
    this._onMouseDown = this._handleMouseDown.bind(this);
    this._onMouseUp = this._handleMouseUp.bind(this);
    this._onMouseMove = this._handleMouseMove.bind(this);
    this._onWheel = this._handleWheel.bind(this);
    this._onContextMenu = this._handleContextMenu.bind(this);
    this._onPointerLockChange = this._handlePointerLockChange.bind(this);
    this._onPointerLockError = this._handlePointerLockError.bind(this);
    this._onBlur = this._handleBlur.bind(this);
    this._onVisibility = this._handleVisibility.bind(this);
    this._onTouchStart = this._handleTouchStart.bind(this);
    this._onTouchMove = this._handleTouchMove.bind(this);
    this._onTouchEnd = this._handleTouchEnd.bind(this);
    this._onResize = this._handleResize.bind(this);
  }

  // ==================================================================== lifecycle

  /**
   * Installs every DOM listener. Safe to call twice (the second call is a no-op).
   * @returns {void}
   */
  attach() {
    if (this.attached) return;
    const win = this.target;
    const doc = this.doc;
    const canvas = this.canvas;
    if (!win || !doc) return;
    this.attached = true;

    win.addEventListener('keydown', this._onKeyDown, false);
    win.addEventListener('keyup', this._onKeyUp, false);
    win.addEventListener('mouseup', this._onMouseUp, false);
    win.addEventListener('mousemove', this._onMouseMove, false);
    win.addEventListener('blur', this._onBlur, false);
    win.addEventListener('resize', this._onResize, false);
    doc.addEventListener('visibilitychange', this._onVisibility, false);
    doc.addEventListener('pointerlockchange', this._onPointerLockChange, false);
    doc.addEventListener('mozpointerlockchange', this._onPointerLockChange, false);
    doc.addEventListener('webkitpointerlockchange', this._onPointerLockChange, false);
    doc.addEventListener('pointerlockerror', this._onPointerLockError, false);
    doc.addEventListener('mozpointerlockerror', this._onPointerLockError, false);
    doc.addEventListener('webkitpointerlockerror', this._onPointerLockError, false);

    if (canvas) {
      canvas.addEventListener('mousedown', this._onMouseDown, false);
      canvas.addEventListener('wheel', this._onWheel, { passive: false });
      canvas.addEventListener('contextmenu', this._onContextMenu, false);
      if (this.enableTouch) {
        canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });
        canvas.addEventListener('touchmove', this._onTouchMove, { passive: false });
        canvas.addEventListener('touchend', this._onTouchEnd, { passive: false });
        canvas.addEventListener('touchcancel', this._onTouchEnd, { passive: false });
      }
      this._updateCanvasRect();
    }
  }

  /**
   * Removes every DOM listener and clears all held state.
   * @returns {void}
   */
  detach() {
    if (!this.attached) return;
    const win = this.target;
    const doc = this.doc;
    const canvas = this.canvas;
    this.attached = false;

    if (win) {
      win.removeEventListener('keydown', this._onKeyDown, false);
      win.removeEventListener('keyup', this._onKeyUp, false);
      win.removeEventListener('mouseup', this._onMouseUp, false);
      win.removeEventListener('mousemove', this._onMouseMove, false);
      win.removeEventListener('blur', this._onBlur, false);
      win.removeEventListener('resize', this._onResize, false);
    }
    if (doc) {
      doc.removeEventListener('visibilitychange', this._onVisibility, false);
      doc.removeEventListener('pointerlockchange', this._onPointerLockChange, false);
      doc.removeEventListener('mozpointerlockchange', this._onPointerLockChange, false);
      doc.removeEventListener('webkitpointerlockchange', this._onPointerLockChange, false);
      doc.removeEventListener('pointerlockerror', this._onPointerLockError, false);
      doc.removeEventListener('mozpointerlockerror', this._onPointerLockError, false);
      doc.removeEventListener('webkitpointerlockerror', this._onPointerLockError, false);
    }
    if (canvas) {
      canvas.removeEventListener('mousedown', this._onMouseDown, false);
      canvas.removeEventListener('wheel', this._onWheel, { passive: false });
      canvas.removeEventListener('contextmenu', this._onContextMenu, false);
      canvas.removeEventListener('touchstart', this._onTouchStart, { passive: false });
      canvas.removeEventListener('touchmove', this._onTouchMove, { passive: false });
      canvas.removeEventListener('touchend', this._onTouchEnd, { passive: false });
      canvas.removeEventListener('touchcancel', this._onTouchEnd, { passive: false });
    }
    this._clearAll();
  }

  // ==================================================================== pointer lock

  /**
   * Asks the browser for pointer lock on the canvas. Must be called from a user gesture;
   * failures are swallowed and retried on the next canvas click.
   * @returns {void}
   */
  requestPointerLock() {
    const canvas = this.canvas;
    if (!canvas || this.pointerLocked) return;
    if (typeof canvas.requestPointerLock !== 'function') return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now < this._lockCooldown) return;
    try {
      // `unadjustedMovement` disables OS mouse acceleration where supported (Chromium).
      const res = canvas.requestPointerLock({ unadjustedMovement: true });
      if (res && typeof res.then === 'function') {
        res.then(null, () => {
          try {
            canvas.requestPointerLock();
          } catch (err) {
            this._lockCooldown = now + 1200;
          }
        });
      }
    } catch (err) {
      try {
        canvas.requestPointerLock();
      } catch (err2) {
        this._lockCooldown = now + 1200;
      }
    }
  }

  /**
   * Releases pointer lock if this canvas owns it.
   * @returns {void}
   */
  exitPointerLock() {
    const doc = this.doc;
    if (!doc || typeof doc.exitPointerLock !== 'function') return;
    if (doc.pointerLockElement !== this.canvas) return;
    try {
      doc.exitPointerLock();
    } catch (err) {
      /* the browser already dropped the lock */
    }
    this.pointerLocked = false;
  }

  // ==================================================================== per-frame

  /**
   * Polls the gamepad, decays touch state and recomputes the derived axes.
   * Call once at the start of every game frame, before reading any action.
   * @param {number} dt frame time in seconds
   * @returns {void}
   */
  update(dt) {
    const step = dt > 0 && dt < 1 ? dt : 1 / 60;
    this._pollGamepad(step);
    this._decayTouch(step);
    this._computeAxes();
  }

  /**
   * Clears the `justPressed` / `justReleased` edges. Call once at the END of every game frame.
   * @returns {void}
   */
  endFrame() {
    if (this._pressed.size) this._pressed.clear();
    if (this._released.size) this._released.clear();
    if (this._touchPressed.size) this._touchPressed.clear();
    if (this._touchReleased.size) this._touchReleased.clear();
  }

  // ==================================================================== queries

  /**
   * Is the action currently held on any bound device?
   * Returns false for gameplay actions while `blocked` is true.
   * @param {string} action action name, e.g. 'forward'
   * @returns {boolean}
   */
  isDown(action) {
    if (this.blocked && !this._uiActions.has(action)) return false;
    return this._rawDown(action);
  }

  /**
   * Did the action go down since the last `endFrame()`? Auto-repeat never triggers this.
   * @param {string} action action name
   * @returns {boolean}
   */
  justPressed(action) {
    if (this.blocked && !this._uiActions.has(action)) return false;
    if (this._touchPressed.has(action)) return true;
    return this._anyEdge(action, this._pressed);
  }

  /**
   * Did the action go up since the last `endFrame()`?
   * @param {string} action action name
   * @returns {boolean}
   */
  justReleased(action) {
    if (this.blocked && !this._uiActions.has(action)) return false;
    if (this._touchReleased.has(action)) return true;
    return this._anyEdge(action, this._released);
  }

  /**
   * Derived analog axis in -1..1. Returns 0 while `blocked`.
   * `moveY` and `throttle` are positive forward, `moveX` / `steer` positive right,
   * `lookX` positive right and `lookY` positive up (before `invertY`).
   * @param {'moveX'|'moveY'|'lookX'|'lookY'|'throttle'|'steer'} name
   * @returns {number}
   */
  axis(name) {
    if (this.blocked) return 0;
    return this.rawAxis(name);
  }

  /**
   * Same as `axis()` but ignores `blocked` — used by menus that navigate with a stick.
   * @param {'moveX'|'moveY'|'lookX'|'lookY'|'throttle'|'steer'} name
   * @returns {number}
   */
  rawAxis(name) {
    const a = this._axes;
    switch (name) {
      case 'moveX': return a.moveX;
      case 'moveY': return a.moveY;
      case 'lookX': return a.lookX;
      case 'lookY': return a.lookY;
      case 'throttle': return a.throttle;
      case 'steer': return a.steer;
      default: return 0;
    }
  }

  /**
   * Returns the accumulated look delta in radians and zeroes the accumulator.
   * Sensitivity and `invertY` are applied here, so callers just do `yaw -= out.x`.
   * @param {{x:number,y:number}} [out] optional destination, reused to avoid allocation
   * @returns {{x:number,y:number}} out
   */
  consumeMouseDelta(out) {
    const dst = out || this._deltaOut;
    const scale = this.mouseScale * this.sensitivity;
    dst.x = this.mouseDX * scale;
    dst.y = this.mouseDY * scale * (this.invertY ? -1 : 1);
    this.mouseDX = 0;
    this.mouseDY = 0;
    return dst;
  }

  /**
   * Returns the accumulated wheel movement in notches and zeroes the accumulator.
   * Positive means "wheel down / towards the user".
   * @returns {number}
   */
  consumeWheel() {
    const w = this.wheelDelta;
    this.wheelDelta = 0;
    return w;
  }

  // ==================================================================== bindings

  /**
   * Rebinds an action. Codes may be keyboard (`KeyboardEvent.code`), 'Mouse0'..'Mouse4' or
   * 'padA'/'pad0' style gamepad codes; casing is irrelevant.
   * @param {string} action action name
   * @param {string|string[]} codes new code list (replaces the old one)
   * @returns {void}
   */
  setBinding(action, codes) {
    const list = Array.isArray(codes) ? codes : [codes];
    /** @type {string[]} */
    const keyCodes = [];
    /** @type {string[]} */
    const padCodes = [];
    for (let i = 0; i < list.length; i++) {
      const code = Input.normalizeCode(list[i]);
      if (!code) continue;
      if (PAD_CODE_INDEX[code] !== undefined) padCodes.push(code);
      else keyCodes.push(code);
    }
    this._bindings[action] = keyCodes;
    if (padCodes.length) this._gamepadBindings[action] = padCodes;
    this._rebuildReverseMap();
  }

  /**
   * The live keyboard/mouse binding table (`action -> lower-cased code[]`).
   * Treat it as read-only; change bindings through `setBinding()`.
   * @returns {Record<string, string[]>}
   */
  getBindings() {
    return this._bindings;
  }

  /**
   * The live gamepad binding table (`action -> lower-cased pad code[]`).
   * @returns {Record<string, string[]>}
   */
  getGamepadBindings() {
    return this._gamepadBindings;
  }

  /**
   * Restores the shipped default bindings for every action.
   * @returns {void}
   */
  resetBindings() {
    const b = this._bindings;
    for (const key in b) delete b[key];
    for (const action in DEFAULT_BINDINGS) {
      const src = DEFAULT_BINDINGS[action];
      const dst = new Array(src.length);
      for (let i = 0; i < src.length; i++) dst[i] = Input.normalizeCode(src[i]);
      b[action] = dst;
    }
    const g = this._gamepadBindings;
    for (const key in g) delete g[key];
    for (const action in DEFAULT_GAMEPAD_BINDINGS) {
      const src = DEFAULT_GAMEPAD_BINDINGS[action];
      const dst = new Array(src.length);
      for (let i = 0; i < src.length; i++) dst[i] = Input.normalizeCode(src[i]);
      g[action] = dst;
    }
    this._rebuildReverseMap();
  }

  /**
   * Registers an event-style hook fired the moment an action goes down.
   * @param {string} action action name
   * @param {(action: string, input: Input) => void} callback
   * @returns {() => void} unsubscribe function
   */
  onAction(action, callback) {
    if (typeof callback !== 'function') return () => {};
    let list = this._listeners.get(action);
    if (!list) {
      list = [];
      this._listeners.set(action, list);
    }
    list.push(callback);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const i = list.indexOf(callback);
      if (i >= 0) list.splice(i, 1);
    };
  }

  // ==================================================================== touch controls

  /**
   * Registers (or replaces) an on-screen button hit area. Rect coordinates are CSS pixels relative
   * to the canvas; set `rect.rel = true` to give them as 0..1 fractions of the canvas size, which
   * keeps the layout correct on every screen size.
   * @param {string} id unique id, used to replace or remove the button later
   * @param {{x:number,y:number,w:number,h:number,rel?:boolean}} rect hit area
   * @param {string} action action the button drives
   * @returns {void}
   */
  registerTouchButton(id, rect, action) {
    if (!rect) return;
    const entry = {
      id: String(id),
      action,
      x: rect.x || 0,
      y: rect.y || 0,
      w: rect.w || 0,
      h: rect.h || 0,
      rel: !!rect.rel,
      touchId: -1,
    };
    for (let i = 0; i < this._touchButtons.length; i++) {
      if (this._touchButtons[i].id === entry.id) {
        this._touchButtons[i] = entry;
        this.touch.buttons[action] = false;
        return;
      }
    }
    this._touchButtons.push(entry);
    this.touch.buttons[action] = false;
  }

  /**
   * Removes a previously registered on-screen button.
   * @param {string} id id passed to `registerTouchButton`
   * @returns {void}
   */
  unregisterTouchButton(id) {
    const key = String(id);
    for (let i = 0; i < this._touchButtons.length; i++) {
      if (this._touchButtons[i].id !== key) continue;
      const entry = this._touchButtons[i];
      this.touch.buttons[entry.action] = false;
      this._touchActions.delete(entry.action);
      this._touchButtons.splice(i, 1);
      return;
    }
  }

  /**
   * Drops every registered on-screen button.
   * @returns {void}
   */
  clearTouchButtons() {
    for (let i = 0; i < this._touchButtons.length; i++) {
      const entry = this._touchButtons[i];
      this.touch.buttons[entry.action] = false;
      this._touchActions.delete(entry.action);
    }
    this._touchButtons.length = 0;
  }

  // ==================================================================== test / debug hooks

  /**
   * Injects a synthetic key event. Used by the headless smoke test and by replay tooling.
   * @param {string} code `KeyboardEvent.code` (any casing)
   * @param {boolean} down true for keydown, false for keyup
   * @returns {void}
   */
  injectKey(code, down) {
    const norm = Input.normalizeCode(code);
    if (!norm) return;
    if (down) this._pressCode(norm, this.keys);
    else this._releaseCode(norm, this.keys);
  }

  /**
   * Injects raw pointer movement in pixels (pointer lock is unavailable in headless runs).
   * @param {number} dx horizontal pixels
   * @param {number} dy vertical pixels
   * @returns {void}
   */
  injectMouseDelta(dx, dy) {
    this.mouseDX += dx;
    this.mouseDY += dy;
  }

  /**
   * Injects a mouse button change, bypassing the DOM.
   * @param {number} button 0 left, 1 middle, 2 right
   * @param {boolean} down
   * @returns {void}
   */
  injectMouseButton(button, down) {
    this._setMouseButton(button | 0, !!down);
  }

  /**
   * Human-readable label for a device code, for the controls screen.
   * @param {string} code device code (any casing)
   * @returns {string}
   */
  static describeCode(code) {
    const c = Input.normalizeCode(code);
    if (!c) return '';
    const label = CODE_LABELS[c];
    if (label) return label;
    if (c.length === 4 && c.indexOf('key') === 0) return c.charAt(3).toUpperCase();
    if (c.indexOf('digit') === 0) return c.slice(5);
    if (c.indexOf('numpad') === 0) return 'Num ' + c.slice(6);
    return c.charAt(0).toUpperCase() + c.slice(1);
  }

  /**
   * Normalizes any code spelling to the internal lower-case form.
   * @param {string} code raw code
   * @returns {string} normalized code, '' when the input was not a string
   */
  static normalizeCode(code) {
    if (typeof code !== 'string' || code.length === 0) return '';
    return code.toLowerCase();
  }
