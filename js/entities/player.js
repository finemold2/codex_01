/**
 * On-foot player controller.
 *
 * Owns locomotion (accelerate / friction / sprint / jump / fall / swim), capsule collision
 * against the world, vehicle entry & exit, damage and death. Camera orientation lives in
 * game.js; this module only consumes `game.camera.yaw` / `game.player.pitch`.
 */
import { vec3, clamp, damp, angleDamp, wrapAngle, lerp } from '../core/math.js';

const WALK_SPEED = 2.5;
const RUN_SPEED = 5.2;
const SPRINT_SPEED = 8.1;
const AIM_SPEED = 2.0;
const CROUCH_SPEED = 1.7;
const SWIM_SPEED = 2.4;
const ACCEL_GROUND = 26;
const ACCEL_AIR = 6;
const FRICTION = 12;
const GRAVITY = 22;
const JUMP_VELOCITY = 7.4;
const COYOTE_TIME = 0.12;
const JUMP_BUFFER = 0.15;
const CAPSULE_RADIUS = 0.36;
const CAPSULE_HEIGHT = 1.78;
const CROUCH_HEIGHT = 1.2;
const MAX_STAMINA = 100;
const FALL_DAMAGE_SPEED = 14;
const ENTER_RANGE = 3.4;

const _move = vec3.create();
const _delta = vec3.create();
const _tmp = vec3.create();
const _tmp2 = vec3.create();
const _res = { x: 0, y: 0, z: 0, grounded: false, groundY: 0, normal: [0, 1, 0], hits: 0 };

export class Player {
  /**
   * @param {import('../game.js').Game} game
   * @param {object} character Character instance from entities/character.js
   */
  constructor(game, character) {
    this.game = game;
    this.character = character;

    this.position = vec3.fromValues(0, 1, 0);
    this.velocity = vec3.create();
    this.yaw = 0;                 // facing direction of the body
    this.pitch = 0;               // aim pitch, driven by the camera
    this.moveDir = vec3.create(); // desired world-space direction this frame

    this.health = 100;
    this.maxHealth = 100;
    this.armor = 0;
    this.maxArmor = 100;
    this.money = 500;
    this.stamina = MAX_STAMINA;

    this.vehicle = null;
    this.seat = 0;
    this.aiming = false;
    this.sprinting = false;
    this.crouching = false;
    this.grounded = true;
    this.inWater = false;
    this.dead = false;
    this.invincible = false;
    this.deadTimer = 0;

    this.kills = 0;
    this.damageDealt = 0;
    this.distanceTravelled = 0;

    this.radius = CAPSULE_RADIUS;
    this.height = CAPSULE_HEIGHT;
    this.speed = 0;

    this._coyote = 0;
    this._jumpBuffer = 0;
    this._stepPhase = 0;
    this._airTime = 0;
    this._peakFallSpeed = 0;
    this._enterCooldown = 0;
    this._regenTimer = 0;
    this._lastSurface = 'concrete';
  }

  /** @returns {number} eye height in metres above the feet. */
  get eyeHeight() { return (this.crouching ? CROUCH_HEIGHT : CAPSULE_HEIGHT) - 0.18; }

  reset(x, y, z, yaw) {
    vec3.set(this.position, x, y, z);
    vec3.set(this.velocity, 0, 0, 0);
    this.yaw = yaw || 0;
    this.health = this.maxHealth;
    this.dead = false;
    this.deadTimer = 0;
    this.vehicle = null;
    this.grounded = true;
    this.stamina = MAX_STAMINA;
  }

  // ------------------------------------------------------------------ update
  update(dt) {
    const game = this.game;
    this._enterCooldown = Math.max(0, this._enterCooldown - dt);

    if (this.dead) {
      this.deadTimer += dt;
      this.character.update(dt, { moveSpeed: 0, aiming: false, grounded: true, aimPitch: 0 });
      if (this.deadTimer > 3.2) game.respawnPlayer();
      return;
    }

    if (this.vehicle) { this._updateInVehicle(dt); return; }
    this._updateOnFoot(dt);
  }

  _updateInVehicle(dt) {
    const v = this.vehicle;
    if (!v || v.isDestroyed) { this.exitVehicle(true); return; }
    // Ride along with the seat so weapons/audio have a sane origin.
    v.getSeatPosition(this.seat, this.position);
    vec3.copy(this.velocity, v.velocity);
    this.yaw = v.yaw;
    this.grounded = true;
    this.character.update(dt, {
      moveSpeed: 0, aiming: false, grounded: true, aimPitch: 0,
      driving: true, steer: v.steer,
    });
    if (v.health <= 0) this.damage(dt * 24, null, 'fire');
  }

  _updateOnFoot(dt) {
    const game = this.game;
    const input = game.input;
    const blocked = input.blocked;

    // --- desired direction, camera-relative ------------------------------------------------
    let ix = 0;
    let iz = 0;
    if (!blocked) {
      ix = input.axis('moveX');
      iz = input.axis('moveY');
    }
    const camYaw = game.camera.yaw;
    // forward = -Z rotated by yaw; right = +X rotated by yaw
    const fx = -Math.sin(camYaw);
    const fz = -Math.cos(camYaw);
    const rx = Math.cos(camYaw);
    const rz = -Math.sin(camYaw);
    _move[0] = fx * iz + rx * ix;
    _move[1] = 0;
    _move[2] = fz * iz + rz * ix;
    const inputMag = Math.min(1, Math.hypot(_move[0], _move[2]));
    if (inputMag > 1e-4) { _move[0] /= inputMag || 1; _move[2] /= inputMag || 1; }
    vec3.set(this.moveDir, _move[0], 0, _move[2]);

    // --- stance ------------------------------------------------------------------------------
    this.aiming = !blocked && input.isDown('aim') && this.game.weapons.canAim();
    this.crouching = !blocked && input.isDown('crouch') && this.grounded;
    const wantsSprint = !blocked && input.isDown('sprint') && inputMag > 0.3 && !this.aiming && !this.crouching;
    this.sprinting = wantsSprint && this.stamina > 1;

    if (this.sprinting) this.stamina = Math.max(0, this.stamina - dt * 17);
    else this.stamina = Math.min(MAX_STAMINA, this.stamina + dt * (this.grounded ? 13 : 5));

    // --- water --------------------------------------------------------------------------------
    const waterY = game.waterLevel;
    this.inWater = waterY !== null && this.position[1] < waterY - 0.25;

    // --- target speed --------------------------------------------------------------------------
    let target = RUN_SPEED;
    if (this.inWater) target = SWIM_SPEED;
    else if (this.aiming) target = AIM_SPEED;
    else if (this.crouching) target = CROUCH_SPEED;
    else if (this.sprinting) target = SPRINT_SPEED;
    else if (inputMag < 0.55) target = WALK_SPEED;
    target *= inputMag;

    // --- horizontal acceleration ---------------------------------------------------------------
    const accel = this.grounded || this.inWater ? ACCEL_GROUND : ACCEL_AIR;
    const desiredX = _move[0] * target;
    const desiredZ = _move[2] * target;
    this.velocity[0] += (desiredX - this.velocity[0]) * Math.min(1, accel * dt);
    this.velocity[2] += (desiredZ - this.velocity[2]) * Math.min(1, accel * dt);
    if (inputMag < 0.01 && this.grounded) {
      const f = Math.max(0, 1 - FRICTION * dt);
      this.velocity[0] *= f;
      this.velocity[2] *= f;
    }

    // --- vertical ------------------------------------------------------------------------------
    if (!blocked && input.justPressed('jump')) this._jumpBuffer = JUMP_BUFFER;
    this._jumpBuffer = Math.max(0, this._jumpBuffer - dt);
    this._coyote = this.grounded ? COYOTE_TIME : Math.max(0, this._coyote - dt);

    if (this.inWater) {
      // Buoyancy: float back to the surface, swim up while holding jump.
      const depth = waterY - this.position[1];
      this.velocity[1] += (depth * 6 - this.velocity[1] * 3.2) * dt;
      if (!blocked && input.isDown('jump')) this.velocity[1] += 9 * dt;
      this.velocity[1] = clamp(this.velocity[1], -4, 4);
      this._peakFallSpeed = 0;
    } else {
      if (this._jumpBuffer > 0 && this._coyote > 0 && !this.crouching) {
        this.velocity[1] = JUMP_VELOCITY;
        this._jumpBuffer = 0;
        this._coyote = 0;
        this.grounded = false;
        this.character.setState('jump');
        game.sfx.jump(this.position);
      }
      // Variable jump height: cut the rise short when the key is released.
      if (this.velocity[1] > 0 && (blocked || !input.isDown('jump'))) this.velocity[1] -= GRAVITY * 1.35 * dt;
      this.velocity[1] -= GRAVITY * dt;
      if (this.velocity[1] < -55) this.velocity[1] = -55;
      this._peakFallSpeed = Math.max(this._peakFallSpeed, -this.velocity[1]);
    }

    // --- integrate + collide --------------------------------------------------------------------
    _delta[0] = this.velocity[0] * dt;
    _delta[1] = this.velocity[1] * dt;
    _delta[2] = this.velocity[2] * dt;
    const wasGrounded = this.grounded;
    const h = this.crouching ? CROUCH_HEIGHT : CAPSULE_HEIGHT;
    game.collision.moveCapsule(this.position, CAPSULE_RADIUS, h, _delta, _res);

    const moved = Math.hypot(_res.x - this.position[0], _res.z - this.position[2]);
    this.distanceTravelled += moved;
    this.position[0] = _res.x;
    this.position[1] = _res.y;
    this.position[2] = _res.z;
    this.grounded = _res.grounded || this.inWater;

    // Kill sideways velocity we actually lost to a wall so we do not stick to it.
    if (_res.hits > 0 && moved < 1e-4 && inputMag > 0.1) {
      this.velocity[0] *= 0.2;
      this.velocity[2] *= 0.2;
    }
    if (this.grounded && this.velocity[1] < 0) this.velocity[1] = 0;

    // --- landing --------------------------------------------------------------------------------
    if (!wasGrounded && this.grounded) {
      const impact = this._peakFallSpeed;
      if (impact > FALL_DAMAGE_SPEED && !this.inWater) {
        const dmg = (impact - FALL_DAMAGE_SPEED) * 7.5;
        this.damage(dmg, null, 'fall');
      }
      if (impact > 3) game.sfx.land(this.position);
      this._peakFallSpeed = 0;
      this._airTime = 0;
    } else if (!this.grounded) {
      this._airTime += dt;
    }

    // --- facing ---------------------------------------------------------------------------------
    const planarSpeed = Math.hypot(this.velocity[0], this.velocity[2]);
    this.speed = planarSpeed;
    if (this.aiming) {
      this.yaw = angleDamp(this.yaw, camYaw, 18, dt);
    } else if (planarSpeed > 0.35) {
      const moveYaw = Math.atan2(-this.velocity[0], -this.velocity[2]);
      this.yaw = angleDamp(this.yaw, moveYaw, 11, dt);
    }
    this.pitch = game.camera.pitch;

    // --- animation ------------------------------------------------------------------------------
    let state = 'idle';
    if (this.inWater) state = 'swim';
    else if (!this.grounded) state = this.velocity[1] > 0.6 ? 'jump' : 'fall';
    else if (planarSpeed > 6.4) state = 'sprint';
    else if (planarSpeed > 2.9) state = 'run';
    else if (planarSpeed > 0.25) state = 'walk';
    if (this.aiming && this.grounded) state = planarSpeed > 0.25 ? 'aimWalk' : 'aim';
    if (this.crouching && this.grounded && !this.aiming) state = planarSpeed > 0.25 ? 'crouchWalk' : 'crouch';
    this.character.setState(state);
    vec3.copy(this.character.position, this.position);
    this.character.yaw = this.yaw;
    this.character.update(dt, {
      moveSpeed: planarSpeed,
      aiming: this.aiming,
      aimPitch: this.pitch,
      grounded: this.grounded,
      crouching: this.crouching,
      lookYaw: wrapAngle(camYaw - this.yaw),
    });

    // --- footsteps --------------------------------------------------------------------------------
    if (this.grounded && !this.inWater && planarSpeed > 0.4) {
      const cadence = planarSpeed > 6.4 ? 2.55 : planarSpeed > 2.9 ? 2.05 : 1.45;
      this._stepPhase += dt * cadence;
      if (this._stepPhase >= 1) {
        this._stepPhase -= 1;
        this._lastSurface = game.surfaceAt(this.position[0], this.position[2]);
        game.sfx.footstep(this._lastSurface, this.position, planarSpeed > 5);
        if (planarSpeed > 5) game.peds.alertNoise(this.position, 6);
      }
    } else {
      this._stepPhase = 0.6;
    }

    // --- vehicle entry ----------------------------------------------------------------------------
    if (!blocked && input.justPressed('enterVehicle') && this._enterCooldown <= 0) {
      const target2 = this.findNearestVehicle(ENTER_RANGE);
      if (target2) this.enterVehicle(target2, 0);
    }

    // --- health regeneration ------------------------------------------------------------------------
    this._regenTimer += dt;
    if (this._regenTimer > 8 && this.health < this.maxHealth * 0.5 && this.health > 0) {
      this.health = Math.min(this.maxHealth * 0.5, this.health + dt * 2.2);
    }
  }

  // ------------------------------------------------------------------ vehicles
  /**
   * Finds the vehicle the player would board.
   *
   * An empty car always wins, but an occupied one is still a valid target - taking it is a
   * carjack, which {@link enterVehicle} handles by throwing the driver out and reporting the
   * crime. Skipping occupied cars outright would leave the player unable to board anything on a
   * street where the traffic system has a driver in almost every vehicle.
   *
   * @param {number} range Search radius in metres.
   * @returns {object|null} Nearest enterable vehicle, or null.
   */
  findNearestVehicle(range) {
    let best = null;
    let bestD = range * range;
    let bestOccupied = null;
    let bestOccupiedD = range * range;
    const list = this.game.vehicles;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v.isDestroyed) continue;
      const dx = v.position[0] - this.position[0];
      const dy = v.position[1] - this.position[1];
      const dz = v.position[2] - this.position[2];
      if (Math.abs(dy) > 2.6) continue;
      const d = dx * dx + dz * dz;
      if (v.driver) {
        if (v.driver !== this && d < bestOccupiedD) { bestOccupiedD = d; bestOccupied = v; }
      } else if (d < bestD) { bestD = d; best = v; }
    }
    return best || bestOccupied;
  }

  enterVehicle(vehicle, seat = 0) {
    if (!vehicle || vehicle.isDestroyed) return false;
    if (vehicle.driver && vehicle.driver !== this) {
      // Jack it: throw the current driver out.
      this.game.ejectDriver(vehicle);
      this.game.police.reportCrime('carjack', this.position);
    }
    this.vehicle = vehicle;
    this.seat = seat;
    vehicle.driver = this;
    vehicle.isPlayer = true;
    vehicle.engineOn = true;
    this.velocity[0] = 0; this.velocity[1] = 0; this.velocity[2] = 0;
    this._enterCooldown = 0.45;
    this.character.setState('drive');
    this.game.sfx.doorOpen(vehicle.position);
    this.game.setCameraMode('vehicle');
    this.game.emit('enteredVehicle', vehicle);
    this.game.hud.notify(`${vehicle.type.nameKo} 탑승`, 'info', 2);
    return true;
  }

  exitVehicle(forced = false) {
    const v = this.vehicle;
    if (!v) return;
    // Find a free spot beside the car.
    const side = Math.cos(v.yaw) * (v.type.width * 0.5 + 0.75);
    const side2 = -Math.sin(v.yaw) * (v.type.width * 0.5 + 0.75);
    let x = v.position[0] + side;
    let z = v.position[2] + side2;
    const y = this.game.worldToGround(x, z);
    if (!Number.isFinite(y)) { x = v.position[0]; z = v.position[2]; }
    vec3.set(this.position, x, Math.max(y, v.position[1]) + 0.05, z);
    this.yaw = v.yaw;
    vec3.set(this.velocity, v.velocity[0] * 0.35, 0, v.velocity[2] * 0.35);
    v.driver = null;
    v.isPlayer = false;
    v.input.throttle = 0;
    v.input.brake = forced ? 1 : 0.6;
    this.vehicle = null;
    this._enterCooldown = 0.45;
    this.grounded = false;
    this.game.sfx.doorClose(v.position);
    this.game.setCameraMode('thirdPerson');
    this.game.emit('exitedVehicle', v);
    if (forced) this.damage(12, null, 'crash');
  }

  // ------------------------------------------------------------------ combat
  /**
   * @param {number} amount
   * @param {number[]|null} dir direction the damage came from (world space)
   * @param {string} source
   */
  damage(amount, dir, source = 'bullet') {
    if (this.dead || this.invincible || amount <= 0) return;
    let remaining = amount;
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, remaining * 0.72);
      this.armor -= absorbed;
      remaining -= absorbed;
    }
    this.health -= remaining;
    this._regenTimer = 0;
    this.game.hud.flashDamage(amount, dir);
    this.game.emit('playerDamaged', { amount, source });
    if (source !== 'fall') this.game.shakeCamera(Math.min(0.5, amount * 0.012), 0.25);
    if (this.health <= 0) this.die(source);
  }

  heal(n) { this.health = Math.min(this.maxHealth, this.health + n); }
  addArmor(n) { this.armor = Math.min(this.maxArmor, this.armor + n); }

  addMoney(n) {
    this.money = Math.max(0, this.money + n);
    this.game.emit('moneyChanged', n);
  }

  die(source = 'bullet') {
    if (this.dead) return;
    this.dead = true;
    this.deadTimer = 0;
    this.health = 0;
    if (this.vehicle) this.exitVehicle(true);
    this.character.playRagdoll(this.velocity);
    this.game.sfx.bodyFall(this.position);
    this.game.hud.showWasted();
    this.game.emit('playerDied', { source });
  }

  submit(renderer) {
    if (this.vehicle && !this.dead) return; // driver is drawn by the vehicle
    this.character.submit(renderer);
  }
}
