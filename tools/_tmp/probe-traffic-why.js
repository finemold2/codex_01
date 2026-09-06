import { Game } from '/js/game.js';
function buildDom() {
  const mk = (id, cls) => { let el = document.getElementById(id);
    if (!el) { el = document.createElement('div'); el.id = id; document.body.appendChild(el); }
    if (cls) el.className = cls; return el; };
  const loading = mk('loading-screen');
  const fill = document.createElement('div'); fill.id = 'load-fill'; loading.appendChild(fill);
  const status = document.createElement('p'); status.id = 'load-status'; loading.appendChild(status);
  const tip = document.createElement('p'); tip.id = 'load-tip'; loading.appendChild(tip);
  const fatal = mk('fatal', 'hidden');
  const fatalMsg = document.createElement('p'); fatalMsg.id = 'fatal-msg'; fatal.appendChild(fatalMsg);
  return { hudRoot: mk('hud-root','layer'), menuRoot: mk('menu-root','layer'), mapRoot: mk('map-root','layer hidden'),
    loading, loadFill: fill, loadStatus: status, loadTip: tip, fatal, fatalMsg };
}
export default async function run({ canvas }) {
  const out = { notes: [] };
  const dom = buildDom(); dom.canvas = canvas;
  const game = new Game(canvas, dom);
  await game.init(() => {});
  game.startNewGame({ skipPointerLock: true });
  const T = game.traffic;

  // Instrument: record every limiter for one tracked car.
  const log = [];
  const origDrive = T._drive.bind(T);
  T._drive = function (v, ai, dt) {
    if (!v.__trace) return origDrive(v, ai, dt);
    const graph = this.lanes;
    const x = v.position[0], z = v.position[2], yaw = v.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const speed = v.forwardSpeed;
    origDrive(v, ai, dt);
    const lane = this.city.lanes[ai.laneId] || null;
    const laneLen = graph.length(ai.laneId);
    const stopDist = laneLen - ai.laneDist;
    const tl = lane ? this._lightFor(lane.toNode) : null;
    let lightState = 'none';
    if (tl) { graph.tangent(ai.laneId, laneLen, new Float32Array(2)); }
    const rec = {
      f: game.time.frame,
      sp: +speed.toFixed(2),
      thr: +v.input.throttle.toFixed(2),
      brk: +v.input.brake.toFixed(2),
      str: +v.input.steer.toFixed(2),
      lane: ai.laneId,
      laneDist: +ai.laneDist.toFixed(1),
      laneLen: +laneLen.toFixed(1),
      limit: lane ? lane.speedLimit : -1,
      kind: lane ? lane.kind : '?',
      toNode: lane ? lane.toNode : -1,
      hasLight: !!tl,
      lightX: tl ? tl.xState : '-',
      lightZ: tl ? tl.zState : '-',
      lead: +this._leadGap(v, x, z, fx, fz).toFixed(1),
      hazard: +this._hazardLimit(v, ai, x, z, fx, fz, speed).toFixed(1),
      yieldL: (lane && !tl) ? +this._yieldLimit(v, lane.toNode, x, z, yaw, stopDist).toFixed(1) : null,
      stuck: +ai.stuck.toFixed(1),
      lost: +ai.lost.toFixed(1),
      panic: +ai.panic.toFixed(1),
      cruise: +ai.cruise.toFixed(2),
    };
    if (log.length < 900) log.push(rec);
  };

  for (let i = 0; i < 120; i++) game.update(1/60);
  // pick 3 cars to trace
  const traced = T.vehicles.slice(0, 3);
  for (const v of traced) v.__trace = true;
  for (let i = 0; i < 600; i++) game.update(1/60);

  out.notes.push(`traced ${traced.length} cars, log ${log.length}`);
  // dump every 30th record
  out.sample = log.filter((_, i) => i % 24 === 0).slice(0, 26);
  // stats over all AI cars
  let stopped = 0, n = 0, sum = 0;
  const reasons = { lead0: 0, hazard0: 0, light: 0, yield: 0, none: 0 };
  for (const v of T.vehicles) {
    const ai = v.ai; if (!ai) continue;
    n++;
    const s = Math.hypot(v.velocity[0], v.velocity[2]); sum += s;
    if (s < 0.3) stopped++;
    const x = v.position[0], z = v.position[2], yaw = v.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const lead = T._leadGap(v, x, z, fx, fz);
    const hz = T._hazardLimit(v, ai, x, z, fx, fz, v.forwardSpeed);
    const lane = T.city.lanes[ai.laneId];
    const tl = lane ? T._lightFor(lane.toNode) : null;
    if (lead >= 0 && lead - 2.6 <= 0.2) reasons.lead0++;
    else if (hz < 1) reasons.hazard0++;
    else if (tl) reasons.light++;
    else reasons.none++;
  }
  out.notes.push(`live=${n} stopped=${stopped} mean=${(sum/Math.max(1,n)).toFixed(2)} reasons=${JSON.stringify(reasons)}`);
  out.notes.push(`lightsBuilt=${game.world.trafficLights ? game.world.trafficLights.length : 'n/a'} byNode=${game.world.trafficLightByNode ? game.world.trafficLightByNode.size : 'n/a'}`);
  return out;
}
