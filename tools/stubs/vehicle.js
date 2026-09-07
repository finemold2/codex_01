/**
 * Integration-test stub for js/entities/vehicle.js.
 *
 * Used only by tools/probe-game.js through an import map, so the full Game boot path can be
 * exercised before the real vehicle module lands. Never imported by the game itself.
 */
import { box, cylinder, mergeGeometries } from '../../js/core/geometry.js';
import { mat4, vec3 } from '../../js/core/math.js';

export const VEHICLE_TYPES = {
  sedan: { name: 'Sedan', nameKo: '세단', mass: 1400, enginePower: 5200, brakeForce: 9000, maxSpeed: 52, grip: 1, steerMax: 0.6, length: 4.4, width: 1.9, height: 1.45, wheelBase: 2.7, wheelRadius: 0.34, seats: 4, sirens: false, price: 12000 },
  police: { name: 'Cruiser', nameKo: '경찰차', mass: 1600, enginePower: 6400, brakeForce: 10000, maxSpeed: 58, grip: 1.1, steerMax: 0.6, length: 4.8, width: 2.0, height: 1.5, wheelBase: 2.9, wheelRadius: 0.35, seats: 4, sirens: true, price: 0 },
};

export function buildVehicleAssets(gl, renderer) {
  const body = mergeGeometries([{ geometry: box(1.9, 0.9, 4.4) }, { geometry: box(1.6, 0.7, 2.2), matrix: mat4.fromTranslation(mat4.create(), [0, 0.75, -0.2]) }]);
  return {
    body: renderer.createMesh(body),
    wheel: renderer.createMesh(cylinder(0.34, 0.34, 0.24, 12, true)),
    material: renderer.createMaterial({ albedo: [0.6, 0.15, 0.15], roughness: 0.35, metallic: 0.6, name: 'stub-car' }),
  };
}

const _m = mat4.create();

export class Vehicle {
  constructor(assets, typeKey, opts = {}) {
    this.assets = assets;
    this.type = VEHICLE_TYPES[typeKey] || VEHICLE_TYPES.sedan;
    this.position = vec3.fromValues(opts.position ? opts.position[0] : 0, opts.position ? opts.position[1] : 0.5, opts.position ? opts.position[2] : 0);
    this.velocity = vec3.create();
    this.yaw = opts.yaw || 0;
    this.speed = 0; this.forwardSpeed = 0; this.rpm = 900; this.gear = 1; this.steer = 0;
    this.health = 1000; this.isDestroyed = false; this.driver = null; this.isPlayer = false;
    this.engineOn = false; this.visible = true; this.occupants = [];
    this.input = { throttle: 0, brake: 0, steer: 0, handbrake: false, horn: false };
    this.wheels = [];
  }

  update(dt, collision) {
    const accel = this.input.throttle * (this.type.enginePower / this.type.mass);
    this.forwardSpeed += accel * dt;
    this.forwardSpeed *= 1 - Math.min(1, (0.6 + this.input.brake * 6) * dt);
    this.forwardSpeed = Math.max(-12, Math.min(this.type.maxSpeed, this.forwardSpeed));
    this.yaw += this.input.steer * this.type.steerMax * dt * Math.min(1, Math.abs(this.forwardSpeed) / 8);
    const fx = -Math.sin(this.yaw); const fz = -Math.cos(this.yaw);
    this.velocity[0] = fx * this.forwardSpeed;
    this.velocity[2] = fz * this.forwardSpeed;
    this.position[0] += this.velocity[0] * dt;
    this.position[2] += this.velocity[2] * dt;
    if (collision && collision.groundHeight) {
      const g = collision.groundHeight(this.position[0], this.position[2]);
      if (Number.isFinite(g)) this.position[1] = g + 0.45;
    }
    this.speed = Math.abs(this.forwardSpeed) * 3.6;
    this.rpm = 900 + Math.abs(this.forwardSpeed) * 130;
  }

  applyDamage(n) { this.health = Math.max(0, this.health - n); if (this.health <= 0) this.isDestroyed = true; }
  getSeatMatrix(i, out) { mat4.fromRotationY(out || _m, this.yaw); const m = out || _m; m[12] = this.position[0]; m[13] = this.position[1] + 0.7; m[14] = this.position[2]; return m; }
  getSeatPosition(i, out) { out[0] = this.position[0]; out[1] = this.position[1] + 0.7; out[2] = this.position[2]; return out; }
  getDoorPosition(i, out) { out[0] = this.position[0] + Math.cos(this.yaw) * 1.2; out[1] = this.position[1]; out[2] = this.position[2] - Math.sin(this.yaw) * 1.2; return out; }
  setLights() {}
  explode() { this.isDestroyed = true; }
  submit(renderer) {
    mat4.fromRotationY(_m, this.yaw);
    _m[12] = this.position[0]; _m[13] = this.position[1]; _m[14] = this.position[2];
    renderer.submit(this.assets.body, this.assets.material, _m);
  }
}
