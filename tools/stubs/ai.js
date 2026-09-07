/**
 * Integration-test stubs for ped.js / traffic.js / police.js, used only by tools/probe-game.js
 * through an import map so the Game boot path can be exercised before those modules land.
 */
export class PedManager {
  constructor(game) { this.game = game; this.peds = []; }
  spawnAround() {}
  update() {}
  alertGunshot() {}
  alertNoise() {}
  damagePed() {}
  explosionDamage() {}
  raycastPeds() { return null; }
  submit() {}
}

export class TrafficManager {
  constructor(game) { this.game = game; this.vehicles = []; }
  spawnAround() {}
  update() {}
  despawnFar() {}
  alert() {}
  onDriverEjected() {}
  submit() {}
}

export class PoliceSystem {
  constructor(game) { this.game = game; this.wanted = 0; this.cops = []; this.cars = []; this.searchTimer = 0; this.heatMeterVisible = false; }
  addWanted(n) { this.wanted = Math.max(0, Math.min(5, this.wanted + n)); }
  reportCrime() { this.addWanted(1); }
  clearWanted() { this.wanted = 0; }
  update() {}
  submit() {}
}
