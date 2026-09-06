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
