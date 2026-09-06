/**
 * NEON CITY - the Game object.
 *
 * Owns every subsystem, the fixed system update order, the camera rig and the small helper API
 * that gameplay modules are allowed to call (see docs/ARCHITECTURE.md section 16).
 */
import { createGLContext } from './core/gl.js';
import { box as boxGeo, cylinder as cylinderGeo, mergeGeometries } from './core/geometry.js';
import { Input } from './core/input.js';
import { vec3, mat4, clamp, damp, angleDamp, lerp, wrapAngle, Rand, smoothstep } from './core/math.js';
import { Renderer, Camera } from './render/renderer.js';
import { createMaterial, updateMaterial } from './render/materials.js';
import { buildTextureLibrary } from './render/textures.js';
import { generateCity, districtAt, laneAt } from './world/citygen.js';
import { buildWorld } from './world/worldbuild.js';
import { CollisionWorld } from './world/collision.js';
import { buildCharacterMeshes, Character } from './entities/character.js';
import { buildVehicleAssets, Vehicle, VEHICLE_TYPES } from './entities/vehicle.js';
import { Player } from './entities/player.js';
import { PedManager } from './entities/ped.js';
import { TrafficManager } from './entities/traffic.js';
import { PoliceSystem } from './entities/police.js';
import { WeaponSystem, WEAPONS } from './entities/weapons.js';
import { MissionManager } from './missions.js';
import { AudioEngine } from './audio/audio.js';
import { SFX } from './audio/sfx.js';
import { MusicPlayer } from './audio/music.js';
import { HUD } from './ui/hud.js';
import { Menu } from './ui/menu.js';
import { MapScreen } from './ui/map.js';

const BUILD = 'v1.0.0';
const SAVE_KEY = 'neoncity.save';

const _v = vec3.create();
const _v2 = vec3.create();
const _camPos = vec3.create();
const _camTarget = vec3.create();
const _rayDir = vec3.create();

/** Moonlight floor used at night so the city stays readable (see Game.render). */
const MOON_INTENSITY = 0.34;
const MOON_AMB_SKY = [0.040, 0.050, 0.078];
const MOON_AMB_GROUND = [0.014, 0.016, 0.024];
const _ambSky = [0, 0, 0];
const _ambGround = [0, 0, 0];
const _moonColor = [0.62, 0.72, 1.0];
const _sunDesc = {
  direction: null, color: null, intensity: 1, ambientSky: null, ambientGround: null,
};
const _m = mat4.create();
const _mouseDelta = { x: 0, y: 0 };

/** Camera boom ignores triggers, water and the player's own body. */
function cameraRayFilter(body) {
  return body.tag !== 'trigger' && body.tag !== 'water' && body.tag !== 'ped' && body.tag !== 'player';
}

/** Yield to the browser so the loading bar can actually paint between build steps. */
/** A chunky octagonal token: a ring around a solid core, readable from any angle. */
function roundedPickupGeometry() {
  return mergeGeometries([
    { geometry: cylinderGeo(0.34, 0.34, 0.1, 8, true) },
    { geometry: boxGeo(0.16, 0.42, 0.16) },
    { geometry: boxGeo(0.42, 0.16, 0.16) },
  ]);
}

const nextPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

export class Game {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Record<string, HTMLElement>} dom
   */
  constructor(canvas, dom) {
    this.canvas = canvas;
    this.dom = dom;
    this.gl = createGLContext(canvas, {});
    if (!this.gl) throw new Error('이 브라우저/기기에서 WebGL2를 사용할 수 없습니다.');

    this.rng = new Rand(0xC17E5EED);
    this.time = { now: 0, dt: 0, scale: 1, elapsed: 0, frame: 0, hours: 9.5, daySpeed: 0.02 };
    this.paused = true;
    this.started = false;
    this.over = false;

    this.cameraMode = 'thirdPerson';
    this.camera = new Camera(62, 0.12, 1600);
    this.camera.yaw = 0;
    this.camera.pitch = -0.12;

    this._listeners = new Map();
    this.ext = {};
    this.waypoint = null;
    this.pickups = [];
    this.vehicles = [];
    this.waterLevel = null;

    // Camera rig state
    this._camDist = 5.4;
    this._camDistTarget = 5.4;
    this._camShoulder = 0.62;
    this._camPos = vec3.fromValues(0, 3, 8);
    this._camLook = vec3.create();
    this._shake = 0;
    this._shakeTime = 0;
    this._shakeSeed = 0;
    this._fovCurrent = 62;
    this._lookBack = 0;
    this._recoilPitch = 0;
    this._recoilYaw = 0;

    this._resizeHandler = () => this.resize();
    this._accumFps = 0;
    this._fps = 0;
    this._fpsFrames = 0;
  }

  // =============================================================== boot
  /** @param {(p:number,label:string)=>void} onProgress */
  async init(onProgress) {
    const step = async (p, label, fn) => {
      onProgress(p, label);
      await nextPaint();
      return fn ? fn() : undefined;
    };

    await step(0.02, '렌더러 초기화 중…');
    this.renderer = new Renderer(this.gl, this.canvas, {});
    this._patchRendererCompat(this.renderer);
    this._applyArtDirection();
    this.particles = this.renderer.particles;
    this.resize();
    window.addEventListener('resize', this._resizeHandler);

    await step(0.08, '텍스처 생성 중…');
    this.textures = buildTextureLibrary(this.gl, { size: 512 });
    this.renderer.textures = this.textures;

    await step(0.26, '도시 설계 중…');
    this.city = generateCity(20260906, {});
    this.waterLevel = this.city.waterLevel;

    await step(0.36, '충돌 지오메트리 구축 중…');
    this.collision = new CollisionWorld(
      Math.max(this.city.bounds.max[0] - this.city.bounds.min[0],
        this.city.bounds.max[1] - this.city.bounds.min[1]) + 400, 16);

    await step(0.42, '도시 건설 중…');
    this.world = buildWorld(this.gl, this.renderer, this.textures, this.city, {
      collision: this.collision,
    });
    if (this.world && this.world.collision) this.collision = this.world.collision;

    await step(0.66, '차량 준비 중…');
    this.vehicleAssets = buildVehicleAssets(this.gl, this.renderer, this.textures);

    this._buildPickupAssets();

    await step(0.72, '시민 생성 중…');
    this.characterAssets = buildCharacterMeshes(this.gl, this.renderer, this.textures);

    await step(0.78, '오디오 엔진 구성 중…');
    this.audio = new AudioEngine();
    this.sfx = new SFX(this.audio);
    this.music = new MusicPlayer(this.audio);

    await step(0.84, '게임 시스템 연결 중…');

    const spawn = this.city.spawns.player;
    const playerChar = new Character(this.characterAssets, {
      kind: 'player', shirt: [0.13, 0.16, 0.22], pants: [0.09, 0.09, 0.11],
      skin: [0.72, 0.55, 0.44], hair: [0.09, 0.07, 0.06],
    });
    this.player = new Player(this, playerChar);
    this.player.reset(spawn.x, spawn.y + 0.1, spawn.z, spawn.yaw || 0);
    vec3.copy(this._camPos, this.player.position);

    this.weapons = new WeaponSystem(this);
    this.peds = new PedManager(this);
    this.traffic = new TrafficManager(this);
    this.police = new PoliceSystem(this);
    this.missions = new MissionManager(this);

    await step(0.90, '인터페이스 구성 중…');
    this.input = new Input(this.canvas, {});
    this.input.attach();
    this.hud = new HUD(this, this.dom.hudRoot);
    this.menu = new Menu(this, this.dom.menuRoot);
    this.mapScreen = new MapScreen(this, this.dom.mapRoot);
    this._applyCompat();
    this._wireMenu();
    this._wireEvents();
    this.applySettings(this.menu.settings);

    await step(0.96, '월드 채우는 중…');
    this.traffic.spawnAround(this.player.position, 26);
    this.peds.spawnAround(this.player.position, 40);
    this._spawnParkedVehicles(34);
    this._spawnPickups();

    this.hud.hide();
    onProgress(1, '준비 완료');
    this._ready = true;
    return this;
  }

  /**
   * Modules are written against docs/ARCHITECTURE.md, but a few gameplay call sites use richer
   * helpers. Patch in safe fallbacks once, at boot, rather than sprinkling `?.` everywhere in the
   * hot path.
   */
  /**
   * Art direction for the post chain.
   *
   * The engine ships neutral defaults (exposure 1.0, grain 0.03, chromatic 0.35). Measured against
   * real frames those crush shadows to pure black, make dark surfaces boil with grain, and put
   * visible rainbow fringes on every high-contrast edge near the screen border. These values were
   * tuned by rendering the city at street level and comparing.
   * @param {object} [over] Optional overrides (used by the settings screen).
   */
  _applyArtDirection(over) {
    const r = this.renderer;
    if (!r) return;
    if (r.setExposure) r.setExposure((over && over.exposure) || 1.45);
    const p = r.postParams;
    if (!p) return;
    p.grain = over && over.grain !== undefined ? over.grain : 0.008;
    p.chromatic = over && over.chromatic !== undefined ? over.chromatic : 0.07;
    p.vignette = over && over.vignette !== undefined ? over.vignette : 0.26;
    p.bloomStrength = 0.5;
    p.bloomThreshold = 1.15;
    p.saturation = 1.07;
    p.contrast = 1.03;
  }

  /**
   * The contract exposes material creation on the renderer (section 5) while the implementation
   * keeps it in render/materials.js. Bridge the two before anything builds geometry, because
   * world/worldbuild.js and the pickup assets both call renderer.createMaterial().
   * @param {Renderer} renderer
   */
  _patchRendererCompat(renderer) {
    if (typeof renderer.createMaterial !== 'function') {
      renderer.createMaterial = (desc) => createMaterial(desc);
    }
    if (typeof renderer.updateMaterial !== 'function') {
      renderer.updateMaterial = (mat, patch) => updateMaterial(mat, patch);
    }
    if (typeof renderer.setEnvironment !== 'function') {
      renderer.setEnvironment = (desc) => {
        if (!desc) return;
        if (desc.exposure !== undefined && renderer.setExposure) renderer.setExposure(desc.exposure);
        if (desc.fogColor || desc.fogDensity !== undefined) {
          renderer.setFog({ color: desc.fogColor, density: desc.fogDensity });
        }
      };
    }
  }

  /**
   * Modules are written against docs/ARCHITECTURE.md, but the integration layer calls a handful of
   * richer helpers. Patch in safe fallbacks once, at boot, instead of sprinkling optional chaining
   * through the hot path. Every fallback is a real behaviour, never a silent no-op that would hide
   * a missing feature from the player.
   */
  _applyCompat() {
    const missing = [];
    const need = (obj, name, impl) => {
      if (!obj) return;
      if (typeof obj[name] !== 'function') { obj[name] = impl; missing.push(name); }
    };

    // --- Vehicle -----------------------------------------------------------------------------
    const VP = Vehicle.prototype;
    if (typeof VP.getSeatPosition !== 'function') {
      const m = mat4.create();
      VP.getSeatPosition = function getSeatPosition(index, out) {
        if (typeof this.getSeatMatrix === 'function') {
          this.getSeatMatrix(index, m);
          out[0] = m[12]; out[1] = m[13]; out[2] = m[14];
        } else {
          out[0] = this.position[0];
          out[1] = this.position[1] + (this.type ? this.type.height * 0.45 : 0.7);
          out[2] = this.position[2];
        }
        return out;
      };
      missing.push('Vehicle.getSeatPosition');
    }
    if (typeof VP.collideWith !== 'function') {
      VP.collideWith = function collideWith() { /* handled inside update() by this build */ };
    }
    for (const key of Object.keys(VEHICLE_TYPES)) {
      const t = VEHICLE_TYPES[key];
      if (!t.key) t.key = key;
      if (!t.nameKo) t.nameKo = t.name || key;
      if (!Number.isFinite(t.width)) t.width = 1.9;
      if (!Number.isFinite(t.length)) t.length = 4.4;
      if (!Number.isFinite(t.height)) t.height = 1.45;
    }

    // --- systems that the render pass drives --------------------------------------------------
    for (const sys of [this.weapons, this.peds, this.police, this.missions, this.traffic]) {
      need(sys, 'submit', () => {});
    }

    // --- weapons ------------------------------------------------------------------------------
    need(this.weapons, 'canAim', function canAim() {
      return this.current !== 'fist' && this.current !== 'grenade';
    });
    need(this.weapons, 'addAmmo', function addAmmo(key, n) {
      const a = this.ammo && this.ammo[key];
      if (a) a.reserve += n;
    });
    need(this.weapons, 'giveWeapon', function giveWeapon(key, n) {
      if (this.switchTo) this.switchTo(key);
      if (this.addAmmo) this.addAmmo(key, n);
    });

    // --- peds ---------------------------------------------------------------------------------
    need(this.peds, 'alertNoise', function alertNoise(pos, r) {
      if (this.alertGunshot) this.alertGunshot(pos, r);
    });
    need(this.peds, 'alertGunshot', () => {});
    need(this.peds, 'explosionDamage', () => {});
    need(this.peds, 'raycastPeds', () => null);

    // --- police -------------------------------------------------------------------------------
    need(this.police, 'reportCrime', function reportCrime(kind) {
      const table = { carjack: 1, pedKill: 2, copKill: 3, shooting: 1, hitPolice: 2, speeding: 0 };
      this.addWanted(table[kind] ?? 1, kind);
    });

    // --- traffic ------------------------------------------------------------------------------
    need(this.traffic, 'onDriverEjected', () => {});
    need(this.traffic, 'alert', () => {});

    // --- hud / menu ---------------------------------------------------------------------------
    need(this.hud, 'showTrack', function showTrack(info) {
      if (info && info.title) this.notify(`♪ ${info.composer} — ${info.titleKo || info.title}`, 'info', 4.5);
    });
    need(this.hud, 'hideBigMessage', () => {});
    need(this.hud, 'setWaypoint', () => {});
    need(this.hud, 'hitMarker', () => {});
    need(this.hud, 'resize', () => {});

    if (this.menu && !this.menu.onSettingsChanged && this.menu.onChange === undefined) {
      // Menu implementations vary in the callback name; support both.
      this.menu.onChange = null;
    }

    // --- music --------------------------------------------------------------------------------
    need(this.music, 'setIntensity', () => {});
    need(this.music, 'trackCount', function trackCount() {
      // Count distinct pieces across every station, not the number of stations.
      if (this.scores) return Object.keys(this.scores).length;
      if (!this.stations) return 0;
      const ids = new Set();
      for (const st of this.stations) {
        for (const id of (st.trackIds || st.tracks || [])) ids.add(id);
      }
      return ids.size;
    });

    if (missing.length) console.warn('[compat] patched fallbacks for:', missing.join(', '));
  }

  /** Small spinning icons for world pickups (health / armor / money / ammo). */
  _buildPickupAssets() {
    const geo = roundedPickupGeometry();
    this._pickupMesh = this.renderer.createMesh(geo);
    const mk = (albedo, emissive) => this.renderer.createMaterial({
      albedo, emissive, emissiveStrength: 2.2, roughness: 0.35, metallic: 0.1,
      name: 'pickup',
    });
    this._pickupMats = {
      health: mk([0.15, 0.9, 0.35], [0.1, 0.85, 0.3]),
      armor: mk([0.25, 0.55, 1.0], [0.15, 0.4, 0.95]),
      money: mk([0.25, 0.95, 0.45], [0.2, 0.8, 0.35]),
      ammo: mk([1.0, 0.75, 0.2], [0.9, 0.6, 0.12]),
      weapon: mk([0.85, 0.85, 0.9], [0.5, 0.5, 0.6]),
    };
  }

  _wireMenu() {
    this.menu.onStart = () => this.startNewGame();
    this.menu.onResume = () => this.resume();
    this.menu.onQuit = () => this.quitToMenu();
    this.menu.onSettingsChanged = (s) => this.applySettings(s);
  }

  _wireEvents() {
    if (this.music && 'onTrackChange' in this.music) {
      this.music.onTrackChange = (info) => {
        this.emit('trackChanged', info);
        if (this.hud && this.hud.showTrack) this.hud.showTrack(info);
      };
    }
  }

  applySettings(s) {
    if (!s) return;
    if (this.renderer && s.quality) {
      this.renderer.setQuality(s.quality);
      this._applyArtDirection();
    }
    if (this.audio) {
      this.audio.setVolume('master', s.masterVolume ?? 0.85);
      this.audio.setVolume('music', s.musicVolume ?? 0.6);
      for (const bus of ['sfx', 'ui', 'ambience', 'vehicle', 'weapon', 'voice']) {
        this.audio.setVolume(bus, s.sfxVolume ?? 0.9);
      }
    }
    if (this.input) {
      this.input.sensitivity = s.sensitivity ?? 1;
      this.input.invertY = !!s.invertY;
    }
    this._baseFov = s.fov ?? 62;
    this._shakeScale = s.cameraShake ?? 1;
    this.emit('settingsChanged', s);
  }

  buildInfo() {
    const dbg = this.gl.getExtension('WEBGL_debug_renderer_info');
    return {
      build: BUILD,
      renderer: dbg ? this.gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
      buildings: this.city ? this.city.buildings.length : 0,
      props: this.city ? this.city.props.length : 0,
      lanes: this.city ? this.city.lanes.length : 0,
      tracks: this.music && this.music.trackCount ? this.music.trackCount() : 0,
      quality: this.renderer ? this.renderer.quality.name : '?',
    };
  }

  // =============================================================== lifecycle
  startNewGame(opts = {}) {
    this.started = true;
    this.over = false;
    this.paused = false;
    this.menu.hide();
    this.hud.show();
    const spawn = this.city.spawns.player;
    this.player.reset(spawn.x, spawn.y + 0.1, spawn.z, spawn.yaw || 0);
    this.camera.yaw = spawn.yaw || 0;
    this.camera.pitch = -0.1;
    this.setCameraMode('thirdPerson');
    this.weapons.giveWeapon('pistol', 60);
    this.weapons.switchTo('pistol');
    if (!opts.skipPointerLock) this.input.requestPointerLock();
    this._startAudio();
    this.hud.notify('네온 시티에 온 것을 환영합니다.', 'info', 4);
    this.hud.subtitle('노란 마커를 찾아 미션을 시작하세요.', 5);
  }

  async _startAudio() {
    try {
      await this.audio.resume();
      this.sfx.ambience('city');
      this.music.play();
    } catch (err) {
      console.warn('audio start failed', err);
    }
  }

  pause() {
    if (!this.started || this.paused) return;
    this.paused = true;
    this.input.exitPointerLock();
    this.input.blocked = true;
    this.menu.showPause();
    if (this.audio && this.audio.duck) this.audio.duck(0.45, 0.2);
  }

  resume() {
    if (!this.started) return;
    this.paused = false;
    this.input.blocked = false;
    this.menu.hide();
    this.input.requestPointerLock();
    if (this.audio && this.audio.duck) this.audio.duck(1, 0.3);
  }

  quitToMenu() {
    this.paused = true;
    this.started = false;
    this.input.exitPointerLock();
    this.input.blocked = true;
    this.hud.hide();
    this.menu.showMain();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(320, Math.floor(this.canvas.clientWidth || window.innerWidth));
    const h = Math.max(240, Math.floor(this.canvas.clientHeight || window.innerHeight));
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    if (this.renderer) this.renderer.resize(this.canvas.width, this.canvas.height);
    if (this.hud && this.hud.resize) this.hud.resize();
  }

  // =============================================================== simulation
  /** @param {number} dt seconds, already clamped by main.js */
  update(dt) {
    this.time.dt = dt;
    this.time.now += dt;
    this.time.frame++;
    this.input.update(dt);

    this._handleGlobalKeys();

    if (!this.started || this.paused) {
      this._updateCamera(dt, true);
      if (this.music) this.music.update(dt);
      this.input.endFrame();
      return;
    }

    const sdt = dt * this.time.scale;
    this.time.elapsed += sdt;
    this.time.hours = (this.time.hours + sdt * this.time.daySpeed) % 24;

    // --- player / vehicle -------------------------------------------------------------------
    if (this.player.vehicle) this._updateVehicleControl(sdt);
    this.player.update(sdt);

    // --- world systems ----------------------------------------------------------------------
    this.weapons.update(sdt);
    this.traffic.update(sdt, this.player.position);
    this.peds.update(sdt, this.player.position);
    this.police.update(sdt);
    this.missions.update(sdt);
    this._updateVehicles(sdt);
    this._updatePickups(sdt);
    if (this.world && this.world.update) this.world.update(sdt, this.time.hours, this.camera);

    // --- presentation ------------------------------------------------------------------------
    this._updateCamera(sdt, false);
    this._updateAudio(sdt);
    this.renderer.particles.update(sdt, this.camera);
    this.hud.update(dt);
    if (this.mapScreen.isOpen) this.mapScreen.update();

    this.input.endFrame();
  }

  _handleGlobalKeys() {
    const input = this.input;
    if (input.justPressed('pause')) {
      if (this.mapScreen.isOpen) this.mapScreen.hide();
      else if (!this.started) { /* main menu already visible */ }
      else if (this.paused) this.resume();
      else this.pause();
    }
    if (!this.started) return;

    if (input.justPressed('map')) {
      this.mapScreen.toggle();
      this.input.blocked = this.mapScreen.isOpen || this.paused;
      if (this.mapScreen.isOpen) this.input.exitPointerLock();
      else this.input.requestPointerLock();
    }
    if (this.paused || this.mapScreen.isOpen) return;

    if (input.justPressed('cameraMode')) {
      const order = this.player.vehicle ? ['vehicle', 'cinematic'] : ['thirdPerson', 'cinematic'];
      const i = order.indexOf(this.cameraMode);
      this.setCameraMode(order[(i + 1) % order.length]);
    }
    if (input.justPressed('nextTrack') && this.music) this.music.next();
    if (input.justPressed('nextStation') && this.music) this.music.nextStation();
  }

  _updateVehicleControl(dt) {
    const v = this.player.vehicle;
    const input = this.input;
    const blocked = input.blocked;
    v.input.throttle = blocked ? 0 : clamp(input.axis('moveY'), -1, 1);
    v.input.steer = blocked ? 0 : clamp(input.axis('moveX'), -1, 1);
    v.input.handbrake = !blocked && input.isDown('jump');
    v.input.brake = v.input.throttle < -0.05 && v.forwardSpeed > 1.5 ? 1 : 0;
    v.input.horn = !blocked && input.isDown('horn');
    if (v.input.horn && !this._hornWasDown) this.sfx.horn(v.position, v.type.key);
    this._hornWasDown = v.input.horn;

    if (!blocked && input.justPressed('enterVehicle')) this.player.exitVehicle();
  }

  _updateVehicles(dt) {
    const list = this.vehicles;
    const px = this.player.position[0];
    const pz = this.player.position[2];
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const dx = v.position[0] - px;
      const dz = v.position[2] - pz;
      const d2 = dx * dx + dz * dz;
      // Vehicles far away simulate at a lower rate; the player's car always runs full rate.
      v.lodSkip = v === this.player.vehicle ? 0 : d2 > 90000 ? 3 : d2 > 22500 ? 1 : 0;
      if (v.lodSkip && (this.time.frame % (v.lodSkip + 1)) !== 0) continue;
      v.update(dt * (v.lodSkip ? v.lodSkip + 1 : 1), this.collision, this);
    }
  }

  _updatePickups(dt) {
    const p = this.player.position;
    for (let i = 0; i < this.pickups.length; i++) {
      const k = this.pickups[i];
      if (k.taken) {
        k.respawn -= dt;
        if (k.respawn <= 0) k.taken = false;
        continue;
      }
      const dx = k.x - p[0];
      const dy = k.y - p[1];
      const dz = k.z - p[2];
      if (dx * dx + dy * dy + dz * dz < 1.7 * 1.7) this._collectPickup(k);
    }
  }

  _collectPickup(k) {
    k.taken = true;
    k.respawn = 45;
    switch (k.kind) {
      case 'health': this.player.heal(k.value); this.hud.notify(`체력 +${k.value}`, 'info', 2); break;
      case 'armor': this.player.addArmor(k.value); this.hud.notify(`방탄복 +${k.value}`, 'info', 2); break;
      case 'money': this.player.addMoney(k.value); this.hud.notify(`$${k.value}`, 'money', 2); break;
      case 'ammo': this.weapons.addAmmo(this.weapons.current, k.value); this.hud.notify(`탄약 +${k.value}`, 'info', 2); break;
      case 'weapon': this.weapons.giveWeapon(k.weapon, k.value); this.hud.notify(`${WEAPONS[k.weapon].nameKo} 획득`, 'info', 3); break;
      default: break;
    }
    this.sfx.pickup(k.kind);
    this.emit('pickupCollected', k);
  }

  // =============================================================== camera
  /**
   * Third-person spring arm with wall avoidance, aim/vehicle variants, look-back, recoil and
   * frame-rate independent smoothing.
   */
  _updateCamera(dt, idle) {
    const cam = this.camera;
    const input = this.input;

    // --- look input ---------------------------------------------------------------------------
    if (!input.blocked && this.started && !this.paused) {
      const d = input.consumeMouseDelta(_mouseDelta);
      cam.yaw -= d.x;
      cam.pitch -= d.y;
      const lx = input.axis('lookX');
      const ly = input.axis('lookY');
      if (lx || ly) {
        cam.yaw -= lx * 2.9 * dt;
        cam.pitch -= ly * 2.1 * dt;
      }
    }
    cam.pitch = clamp(cam.pitch, -1.44, 1.44);
    cam.yaw = wrapAngle(cam.yaw);

    // recoil recovery
    this._recoilPitch = damp(this._recoilPitch, 0, 7, dt);
    this._recoilYaw = damp(this._recoilYaw, 0, 7, dt);

    const player = this.player;
    const veh = player ? player.vehicle : null;
    const aiming = player ? player.aiming : false;

    // --- look-back ------------------------------------------------------------------------------
    const wantBack = !input.blocked && input.isDown('lookBack') ? 1 : 0;
    this._lookBack = damp(this._lookBack, wantBack, 12, dt);

    // --- pivot ------------------------------------------------------------------------------------
    let pivotX; let pivotY; let pivotZ;
    let distTarget; let shoulderTarget; let fovTarget; let followLambda;

    if (veh) {
      const speed = Math.abs(veh.forwardSpeed || 0);
      pivotX = veh.position[0];
      pivotY = veh.position[1] + veh.type.height * 0.72 + 0.55;
      pivotZ = veh.position[2];
      distTarget = veh.type.length * 0.95 + 3.1 + speed * 0.055;
      shoulderTarget = 0;
      fovTarget = this._baseFov + clamp(speed * 0.55, 0, 16);
      followLambda = 7.5;
      // Auto-align behind the car when driving and the player is not steering the camera.
      const autoAlign = speed > 3.5 && !input.isDown('lookBack');
      if (autoAlign) {
        const behind = veh.forwardSpeed < -0.5 ? wrapAngle(veh.yaw + Math.PI) : veh.yaw;
        cam.yaw = angleDamp(cam.yaw, behind, clamp(speed * 0.13, 0.6, 3.2), dt);
      }
    } else {
      const crouch = player && player.crouching;
      pivotX = player.position[0];
      pivotY = player.position[1] + (crouch ? 1.05 : 1.47);
      pivotZ = player.position[2];
      distTarget = aiming ? 1.95 : 5.05;
      shoulderTarget = aiming ? 0.68 : 0.38;
      fovTarget = this._baseFov + (aiming ? -12 : 0) + (player.sprinting ? 6 : 0);
      followLambda = aiming ? 26 : 16;
    }
    if (this.cameraMode === 'cinematic') {
      distTarget += 4.5;
      fovTarget -= 8;
      followLambda = 3.2;
    }

    this._camDistTarget = distTarget;
    this._camDist = damp(this._camDist, this._camDistTarget, 9, dt);
    this._camShoulder = damp(this._camShoulder, shoulderTarget, 12, dt);
    this._fovCurrent = damp(this._fovCurrent, fovTarget, 6, dt);

    // --- orbit position ------------------------------------------------------------------------------
    const yaw = cam.yaw + this._lookBack * Math.PI;
    const pitch = clamp(cam.pitch + this._recoilPitch, -1.44, 1.44);
    const cp = Math.cos(pitch);
    const fx = -Math.sin(yaw) * cp;
    const fy = Math.sin(pitch);
    const fz = -Math.cos(yaw) * cp;
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);

    let dist = this._camDist;
    // Wall avoidance: sweep from the pivot towards where the camera wants to be.
    _rayDir[0] = -fx; _rayDir[1] = -fy; _rayDir[2] = -fz;
    _v[0] = pivotX + rx * this._camShoulder;
    _v[1] = pivotY;
    _v[2] = pivotZ + rz * this._camShoulder;
    const hit = this.collision.raycast(_v, _rayDir, dist + 0.45, cameraRayFilter);
    if (hit && hit.t > 0) dist = Math.max(0.75, hit.t - 0.42);

    const desiredX = _v[0] - fx * dist;
    const desiredY = _v[1] - fy * dist;
    const desiredZ = _v[2] - fz * dist;

    this._camPos[0] = damp(this._camPos[0], desiredX, followLambda, dt);
    this._camPos[1] = damp(this._camPos[1], desiredY, followLambda * 1.35, dt);
    this._camPos[2] = damp(this._camPos[2], desiredZ, followLambda, dt);
    // Never let smoothing push the camera through the wall we just avoided.
    const dx = this._camPos[0] - _v[0];
    const dy = this._camPos[1] - _v[1];
    const dz = this._camPos[2] - _v[2];
    const dlen = Math.hypot(dx, dy, dz);
    if (dlen > dist + 0.02) {
      const s = dist / dlen;
      this._camPos[0] = _v[0] + dx * s;
      this._camPos[1] = _v[1] + dy * s;
      this._camPos[2] = _v[2] + dz * s;
    }

    // --- shake ------------------------------------------------------------------------------------
    let shakeX = 0; let shakeY = 0; let shakeZ = 0;
    if (this._shakeTime > 0) {
      this._shakeTime -= dt;
      const k = Math.max(0, this._shakeTime) * this._shake * (this._shakeScale ?? 1);
      this._shakeSeed += dt * 47;
      shakeX = Math.sin(this._shakeSeed * 1.7) * k;
      shakeY = Math.sin(this._shakeSeed * 2.31 + 1.3) * k;
      shakeZ = Math.sin(this._shakeSeed * 1.13 + 2.7) * k * 0.5;
    }

    cam.position[0] = this._camPos[0] + shakeX;
    cam.position[1] = this._camPos[1] + shakeY;
    cam.position[2] = this._camPos[2] + shakeZ;
    cam.yawView = yaw;
    cam.pitchView = pitch;
    cam.fov = this._fovCurrent;

    // Camera.update() builds the view matrix from position/yaw/pitch; feed the view-space angles.
    const savedYaw = cam.yaw;
    const savedPitch = cam.pitch;
    cam.yaw = yaw + this._recoilYaw;
    cam.pitch = pitch;
    cam.update(this.canvas.width / Math.max(1, this.canvas.height));
    cam.yaw = savedYaw;
    cam.pitch = savedPitch;
  }

  setCameraMode(mode) {
    this.cameraMode = mode;
    if (mode === 'aim') this._camDistTarget = 1.95;
  }

  shakeCamera(amount, duration = 0.35) {
    this._shake = Math.max(this._shake * 0.6, amount);
    this._shakeTime = Math.max(this._shakeTime, duration);
  }

  /** Weapon recoil pushes the view; it recovers automatically. */
  addRecoil(pitch, yaw) {
    this._recoilPitch += pitch;
    this._recoilYaw += yaw;
  }

  // =============================================================== audio
  _updateAudio(dt) {
    const cam = this.camera;
    _v[0] = -Math.sin(cam.yaw) * Math.cos(cam.pitch);
    _v[1] = Math.sin(cam.pitch);
    _v[2] = -Math.cos(cam.yaw) * Math.cos(cam.pitch);
    _v2[0] = 0; _v2[1] = 1; _v2[2] = 0;
    this.audio.setListener(cam.position, _v, _v2, this.player.velocity);
    this.music.update(dt);
    const chase = this.police.wanted > 0 ? clamp(this.police.wanted / 4, 0, 1) : 0;
    if (this.music.setIntensity) this.music.setIntensity(chase);
  }

  // =============================================================== render
  render(dt) {
    const r = this.renderer;
    const sky = r.sky;
    if (sky) {
      sky.setTimeOfDay(this.time.hours);
      sky.update(dt, 0);

      // The sky's night values are physically faithful (ambient 0.010/0.002, key light 0.055) but
      // at those levels the city is simply invisible - only the pool under a streetlight reads.
      // Lift a cool moonlight floor in proportion to nightFactor so silhouettes, roads and traffic
      // stay legible, the way a night scene is lit in a game rather than in a light meter.
      const nf = sky.nightFactor || 0;
      const key = _sunDesc;
      key.direction = sky.sunDirection;
      key.color = sky.sunColor;
      key.intensity = sky.sunIntensity;
      key.ambientSky = sky.ambientSky;
      key.ambientGround = sky.ambientGround;
      if (nf > 0.01) {
        key.intensity = Math.max(sky.sunIntensity, lerp(sky.sunIntensity, MOON_INTENSITY, nf));
        key.color = _moonColor;
        _ambSky[0] = lerp(sky.ambientSky[0], MOON_AMB_SKY[0], nf);
        _ambSky[1] = lerp(sky.ambientSky[1], MOON_AMB_SKY[1], nf);
        _ambSky[2] = lerp(sky.ambientSky[2], MOON_AMB_SKY[2], nf);
        _ambGround[0] = lerp(sky.ambientGround[0], MOON_AMB_GROUND[0], nf);
        _ambGround[1] = lerp(sky.ambientGround[1], MOON_AMB_GROUND[1], nf);
        _ambGround[2] = lerp(sky.ambientGround[2], MOON_AMB_GROUND[2], nf);
        key.ambientSky = _ambSky;
        key.ambientGround = _ambGround;
        // Blend the daylight sun colour towards moonlight rather than snapping at dusk.
        _moonColor[0] = lerp(sky.sunColor[0], 0.62, nf);
        _moonColor[1] = lerp(sky.sunColor[1], 0.72, nf);
        _moonColor[2] = lerp(sky.sunColor[2], 1.0, nf);
      }
      r.setSun(key);
      r.setFog({ color: sky.fogColor, density: 0.0016 + nf * 0.0007, heightFalloff: 0.018 });
    }

    // Dynamic entities
    this.player.submit(r);
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      if (!v.visible) continue;
      v.submit(r, dt);
    }
    this.peds.submit(r, dt);
    this.police.submit(r, dt);
    this.weapons.submit(r, dt);
    this.missions.submit(r, dt);
    this._submitPickups(r);

    r.render(this.camera, dt);

    this._fpsFrames++;
    this._accumFps += dt;
    if (this._accumFps > 0.5) {
      this._fps = this._fpsFrames / this._accumFps;
      this._accumFps = 0;
      this._fpsFrames = 0;
    }
  }

  _submitPickups(r) {
    if (!this._pickupMesh) return;
    for (let i = 0; i < this.pickups.length; i++) {
      const k = this.pickups[i];
      if (k.taken) continue;
      const spin = this.time.now * 1.7 + i;
      mat4.identity(_m);
      _m[12] = k.x; _m[13] = k.y + Math.sin(this.time.now * 2 + i) * 0.09; _m[14] = k.z;
      mat4.rotateY(_m, _m, spin);
      r.submit(this._pickupMesh, this._pickupMats[k.kind] || this._pickupMats.health, _m);
      r.submitLight(k.x, k.y + 0.4, k.z, k.light[0], k.light[1], k.light[2], 4.5, 1.4);
    }
  }

  // =============================================================== helper API (contract §16)
  notify(text, kind = 'info', duration = 3) { this.hud.notify(text, kind, duration); }
  subtitle(text, duration = 3) { this.hud.subtitle(text, duration); }

  setWaypoint(x, z) {
    this.waypoint = { x, z };
    this.hud.setWaypoint(x, z);
    this.hud.notify('목적지가 설정되었습니다.', 'info', 2);
  }

  clearWaypoint() {
    this.waypoint = null;
    if (this.hud.setWaypoint) this.hud.setWaypoint(null, null);
  }

  /** @returns {Vehicle} */
  spawnVehicle(typeKey, x, z, yaw = 0, opts = {}) {
    const y = opts.y !== undefined ? opts.y : this.worldToGround(x, z);
    const v = new Vehicle(this.vehicleAssets, typeKey, {
      position: [x, y + 0.45, z], yaw, color: opts.color, isPolice: !!opts.isPolice, game: this,
    });
    this.vehicles.push(v);
    return v;
  }

  removeVehicle(vehicle) {
    const i = this.vehicles.indexOf(vehicle);
    if (i >= 0) this.vehicles.splice(i, 1);
    if (vehicle.dispose) vehicle.dispose();
    if (this.player.vehicle === vehicle) this.player.exitVehicle(true);
  }

  ejectDriver(vehicle) {
    if (!vehicle.driver || vehicle.driver === this.player) return;
    const ai = vehicle.driver;
    vehicle.driver = null;
    if (this.traffic.onDriverEjected) this.traffic.onDriverEjected(vehicle, ai);
    else if (ai && ai.character) ai.state = 'flee';
  }

  spawnPickup(kind, x, y, z, value = 25, weapon = null) {
    const k = {
      id: `p${this.pickups.length}`, kind, x, y, z, value, weapon, taken: false, respawn: 0,
      light: kind === 'health' ? [0.2, 1, 0.4] : kind === 'armor' ? [0.3, 0.6, 1]
        : kind === 'money' ? [0.3, 1, 0.5] : [1, 0.8, 0.25],
    };
    this.pickups.push(k);
    return k;
  }

  explosionAt(x, y, z, radius = 8, damage = 120, source = null) {
    this.sfx.explosion([x, y, z]);
    this.renderer.particles.burst('fire', x, y, z, 40, { power: radius });
    this.renderer.particles.burst('smoke', x, y + 1, z, 26, { power: radius });
    this.renderer.particles.burst('debris', x, y, z, 18, { power: radius });
    const d = this.distanceToPlayer(x, y, z);
    this.shakeCamera(clamp(1.4 - d / (radius * 2.4), 0, 1.2), 0.6);
    if (d < radius) this.player.damage(damage * (1 - d / radius), [x - this.player.position[0], 0, z - this.player.position[2]], 'explosion');
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      const vd = Math.hypot(v.position[0] - x, v.position[1] - y, v.position[2] - z);
      if (vd < radius * 1.3 && v.applyDamage) {
        v.applyDamage(damage * (1 - vd / (radius * 1.3)), [x, y, z], [(v.position[0] - x) * 30, 220, (v.position[2] - z) * 30]);
      }
    }
    if (this.peds.explosionDamage) this.peds.explosionDamage(x, y, z, radius, damage);
    this.emit('explosion', { x, y, z, radius, source });
  }

  worldToGround(x, z) {
    const g = this.collision.groundHeight(x, z);
    return Number.isFinite(g) ? g : 0;
  }

  /** @returns {'concrete'|'asphalt'|'grass'|'sand'|'metal'|'water'} */
  surfaceAt(x, z) {
    if (this.waterLevel !== null && this.worldToGround(x, z) < this.waterLevel) return 'water';
    const d = districtAt(this.city, x, z);
    if (d && d.kind === 'park') return 'grass';
    if (d && d.kind === 'beach') return 'sand';
    return this.city && this.city.isOnRoadCache ? 'asphalt' : 'concrete';
  }

  nearestRoadPoint(x, z, out = { x: 0, z: 0, laneId: -1 }) {
    const r = laneAt(this.city, x, z);
    if (!r) { out.x = x; out.z = z; out.laneId = -1; return out; }
    out.x = r.point[0];
    out.z = r.point[1];
    out.laneId = r.lane.id;
    return out;
  }

  distanceToPlayer(x, y, z) {
    const p = this.player.position;
    return Math.hypot(p[0] - x, p[1] - y, p[2] - z);
  }

  isNight() { return this.time.hours < 6.4 || this.time.hours > 19.2; }

  respawnPlayer() {
    const s = this.city.spawns.player;
    let best = s;
    let bestD = Infinity;
    for (const m of this.city.spawns.missionPoints) {
      const d = Math.hypot(m.x - this.player.position[0], m.z - this.player.position[2]);
      if (d < bestD) { bestD = d; best = m; }
    }
    this.player.reset(best.x, this.worldToGround(best.x, best.z) + 0.1, best.z, this.rng.range(0, 6.28));
    this.player.health = this.player.maxHealth * 0.6;
    this.player.addMoney(-Math.min(this.player.money, 250));
    this.police.clearWanted();
    this.hud.hideBigMessage();
    this.hud.notify('병원에서 깨어났습니다. 치료비 $250', 'warn', 4);
    this.setCameraMode('thirdPerson');
    vec3.copy(this._camPos, this.player.position);
  }

  // --- event bus -------------------------------------------------------------------------------
  on(event, fn) {
    let arr = this._listeners.get(event);
    if (!arr) { arr = []; this._listeners.set(event, arr); }
    arr.push(fn);
    return () => {
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  emit(event, payload) {
    const arr = this._listeners.get(event);
    if (!arr) return;
    for (let i = 0; i < arr.length; i++) {
      try { arr[i](payload); } catch (err) { console.warn(`listener for ${event} threw`, err); }
    }
  }

  // --- persistence ------------------------------------------------------------------------------
  save() {
    try {
      const data = {
        v: 1,
        money: this.player.money,
        health: this.player.health,
        armor: this.player.armor,
        hours: this.time.hours,
        completed: Array.from(this.missions.completed || []),
        weapons: this.weapons.serialize ? this.weapons.serialize() : null,
        pos: [this.player.position[0], this.player.position[1], this.player.position[2]],
        stats: { kills: this.player.kills, distance: Math.round(this.player.distanceTravelled) },
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
      return true;
    } catch (err) { console.warn('save failed', err); return false; }
  }

  load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      const d = JSON.parse(raw);
      if (!d || d.v !== 1) return false;
      this.player.money = d.money ?? 500;
      this.player.health = d.health ?? 100;
      this.player.armor = d.armor ?? 0;
      this.time.hours = d.hours ?? 9.5;
      if (d.pos) this.player.reset(d.pos[0], d.pos[1], d.pos[2], 0);
      if (d.completed && this.missions.completed) {
        for (const id of d.completed) this.missions.completed.add(id);
      }
      if (d.weapons && this.weapons.deserialize) this.weapons.deserialize(d.weapons);
      return true;
    } catch (err) { console.warn('load failed', err); return false; }
  }

  hasSave() {
    try { return !!localStorage.getItem(SAVE_KEY); } catch { return false; }
  }

  // =============================================================== world population
  _spawnParkedVehicles(count) {
    const spots = this.city.spawns.vehicles;
    const keys = Object.keys(VEHICLE_TYPES).filter((k) => k !== 'police');
    for (let i = 0; i < Math.min(count, spots.length); i++) {
      const s = spots[(i * 7) % spots.length];
      const key = keys[this.rng.int(0, keys.length - 1)];
      const v = this.spawnVehicle(key, s.x, s.z, s.yaw, { y: s.y });
      v.parked = true;
    }
  }

  _spawnPickups() {
    const pts = this.city.spawns.missionPoints;
    const geo = this._pickupGeometry;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const kinds = ['health', 'armor', 'money', 'ammo'];
      const kind = kinds[i % kinds.length];
      this.spawnPickup(kind, p.x + 3, this.worldToGround(p.x + 3, p.z) + 0.8, p.z, kind === 'money' ? 250 : 35);
    }
    for (let i = 0; i < 26; i++) {
      const s = this.city.spawns.peds[(i * 13) % this.city.spawns.peds.length];
      const kind = i % 3 === 0 ? 'health' : i % 3 === 1 ? 'money' : 'ammo';
      this.spawnPickup(kind, s.x, this.worldToGround(s.x, s.z) + 0.8, s.z, kind === 'money' ? 120 : 30);
    }
  }

  // =============================================================== debug / test surface
  debugStats() {
    const r = this.renderer.stats || {};
    return {
      fps: Math.round(this._fps),
      drawCalls: r.drawCalls | 0,
      triangles: r.triangles | 0,
      vehicles: this.vehicles.length,
      peds: this.peds.peds ? this.peds.peds.length : 0,
      particles: this.renderer.particles.count || 0,
      wanted: this.police.wanted,
      hours: Math.round(this.time.hours * 10) / 10,
      pos: [Math.round(this.player.position[0]), Math.round(this.player.position[1]), Math.round(this.player.position[2])],
      mode: this.cameraMode,
    };
  }

  /** Battery of runtime assertions used by tools/smoke-test.mjs. */
  selfTest() {
    const failures = [];
    const ok = (cond, msg) => { if (!cond) failures.push(msg); };
    const finite3 = (a) => a && Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);

    ok(this.city.buildings.length > 300, `too few buildings: ${this.city.buildings.length}`);
    ok(this.city.props.length > 800, `too few props: ${this.city.props.length}`);
    ok(this.city.lanes.length > 50, `too few lanes: ${this.city.lanes.length}`);
    ok(finite3(this.player.position), 'player position not finite');
    ok(finite3(this.camera.position), 'camera position not finite');
    for (let i = 0; i < 16; i++) ok(Number.isFinite(this.camera.viewProj[i]), 'viewProj has NaN');

    // ground under the player
    const g = this.worldToGround(this.player.position[0], this.player.position[2]);
    ok(Number.isFinite(g), 'groundHeight not finite');
    ok(this.player.position[1] > g - 3, `player fell through the world (y=${this.player.position[1]}, ground=${g})`);

    // movement actually moves
    const before = [this.player.position[0], this.player.position[2]];
    this.input.injectKey('KeyW', true);
    for (let i = 0; i < 30; i++) this.update(1 / 60);
    this.input.injectKey('KeyW', false);
    const moved = Math.hypot(this.player.position[0] - before[0], this.player.position[2] - before[1]);
    ok(moved > 0.4, `player did not move on W (moved ${moved.toFixed(3)} m)`);

    // camera rotation
    const yaw0 = this.camera.yaw;
    this.input.injectMouseDelta(220, 0);
    this.update(1 / 60);
    ok(Math.abs(wrapAngle(this.camera.yaw - yaw0)) > 0.02, 'mouse look did not rotate the camera');

    // renderer produced work
    this.render(1 / 60);
    ok((this.renderer.stats.drawCalls | 0) > 5, `renderer made only ${this.renderer.stats.drawCalls} draw calls`);
    ok((this.renderer.stats.triangles | 0) > 5000, `only ${this.renderer.stats.triangles} triangles submitted`);

    // audio graph
    ok(!!this.music, 'music player missing');
    ok(this.music.trackCount ? this.music.trackCount() >= 8 : true, 'expected at least 8 classical tracks');

    return { failures, stats: this.debugStats() };
  }

  /** Drives the major gameplay flows once so the harness can catch exceptions. */
  exerciseFlows() {
    const errors = [];
    const run = (name, fn) => { try { fn(); } catch (err) { errors.push(`${name}: ${err.message}`); } };

    run('weapon-fire', () => {
      this.weapons.switchTo('pistol');
      for (let i = 0; i < 20; i++) {
        this.weapons.tryFire(this.camera.position, this.camera.forward, true, 1);
        this.update(1 / 30);
      }
      this.weapons.reload();
      for (let i = 0; i < 60; i++) this.update(1 / 60);
    });

    run('weapon-switch', () => {
      for (const k of ['smg', 'shotgun', 'rifle', 'sniper', 'grenade', 'fist']) {
        this.weapons.giveWeapon(k, 40);
        this.weapons.switchTo(k);
        this.update(1 / 60);
      }
      this.weapons.switchTo('pistol');
    });

    run('vehicle', () => {
      const v = this.spawnVehicle('sedan', this.player.position[0] + 2.5, this.player.position[2], 0, {});
      this.player.enterVehicle(v, 0);
      this.input.injectKey('KeyW', true);
      for (let i = 0; i < 180; i++) this.update(1 / 60);
      this.input.injectKey('KeyW', false);
      const speed = Math.hypot(v.velocity[0], v.velocity[2]);
      if (!(speed > 1)) errors.push(`vehicle did not accelerate (speed ${speed.toFixed(2)} m/s)`);
      if (!Number.isFinite(v.position[0])) errors.push('vehicle position became NaN');
      this.player.exitVehicle();
      for (let i = 0; i < 30; i++) this.update(1 / 60);
    });

    run('police', () => {
      this.police.addWanted(2, 'test');
      for (let i = 0; i < 120; i++) this.update(1 / 60);
      this.police.clearWanted();
    });

    run('mission', () => {
      const list = this.missions.getAvailable ? this.missions.getAvailable() : [];
      if (list.length) {
        this.missions.start(list[0].id);
        for (let i = 0; i < 120; i++) this.update(1 / 60);
        this.missions.abort();
      }
      for (let i = 0; i < 30; i++) this.update(1 / 60);
    });

    run('ui', () => {
      this.mapScreen.show();
      this.mapScreen.update();
      this.mapScreen.hide();
      this.hud.notify('테스트', 'info', 1);
      this.hud.showWasted();
      this.hud.hideBigMessage();
      this.pause();
      this.update(1 / 60);
      this.resume();
    });

    run('radio', () => {
      this.music.nextStation();
      this.music.next();
      this.update(1 / 60);
    });

    run('damage-respawn', () => {
      this.player.damage(500, [0, 0, 1], 'test');
      for (let i = 0; i < 240; i++) this.update(1 / 60);
      if (this.player.dead) errors.push('player never respawned after death');
    });

    run('render-after-flows', () => { this.render(1 / 60); });

    return { errors, stats: this.debugStats() };
  }

  /** Reads back the framebuffer so the harness can prove the frame is not blank. */
  readPixelStats() {
    const gl = this.gl;
    this.render(1 / 60);
    const w = Math.min(160, gl.drawingBufferWidth);
    const h = Math.min(90, gl.drawingBufferHeight);
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const seen = new Set();
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) {
      seen.add((px[i] >> 3) << 10 | (px[i + 1] >> 3) << 5 | (px[i + 2] >> 3));
      sum += px[i] + px[i + 1] + px[i + 2];
    }
    return { unique: seen.size, meanLuma: Math.round(sum / (px.length / 4) / 3), w, h };
  }

  dispose() {
    window.removeEventListener('resize', this._resizeHandler);
    if (this.input) this.input.detach();
    if (this.world && this.world.dispose) this.world.dispose();
  }
}
