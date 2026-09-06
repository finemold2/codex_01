/**
 * Standalone adversarial validator for js/world/citygen.js.
 *
 * Pure Node (no DOM, no WebGL): imports the module directly and asserts the
 * CityData contract from docs/ARCHITECTURE.md §7 plus the structural rules the
 * consumers (worldbuild / traffic / ped / map / missions) depend on.
 *
 * Run: node tools/test-citygen.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../js/world/citygen.js');
const mod = await import(SRC);
const { generateCity, laneAt, walkAt, isOnRoad, districtAt, cityStats } = mod;

let failures = 0;
let checks = 0;
const fail = (msg) => { failures++; console.log('FAIL  ' + msg); };
const ok = (msg) => { console.log('ok    ' + msg); };
const check = (cond, msg) => { checks++; if (cond) ok(msg); else fail(msg); };

/* ---------------------------------------------------------------- exports */
for (const n of ['generateCity', 'laneAt', 'walkAt', 'isOnRoad', 'districtAt', 'cityStats']) {
  check(typeof mod[n] === 'function', `export ${n} is a function`);
}
check(generateCity(11) && generateCity(11, {}), 'generateCity works with and without opts');

/* ------------------------------------------------------------ source scan */
const src = readFileSync(SRC, 'utf8');
check(!/Math\.random/.test(src), 'no Math.random in seeded generation');
check(!/\bTODO\b|\bFIXME\b|\bXXX\b/.test(src), 'no TODO/FIXME markers');
check(!/addEventListener|document\.|window\.|setInterval|setTimeout/.test(src),
  'no DOM / timer / listener use in a data module');

/* -------------------------------------------------------------- generate */
const t0 = Date.now();
const city = generateCity(20260906, {});
const genMs = Date.now() - t0;
console.log(`      generated in ${genMs} ms: ${JSON.stringify(cityStats(city))}`);
check(genMs < 4000, `generation under 4 s (${genMs} ms)`);

/* --------------------------------------------------------- determinism */
const stable = (c) => JSON.stringify({
  b: c.buildings, p: c.props, l: c.lanes, w: c.walks, n: c.nodes, r: c.roads,
  lo: c.lots, d: c.districts, s: c.spawns, m: c.landmarks, bo: c.bounds
});
check(stable(generateCity(20260906, {})) === stable(city), 'generateCity is bit-stable for a seed');
const other = generateCity(4242, {});
check(stable(other) !== stable(city), 'a different seed yields a different city');

/* ------------------------------------------------------ top-level shape */
for (const k of ['seed', 'blockSize', 'roadWidth', 'blocksX', 'blocksZ', 'bounds', 'districts',
  'roads', 'nodes', 'lanes', 'walks', 'lots', 'buildings', 'props', 'spawns', 'landmarks']) {
  check(city[k] !== undefined, `CityData.${k} present`);
}
check('waterLevel' in city, 'CityData.waterLevel present');
check(city.bounds.min.length === 2 && city.bounds.max.length === 2, 'bounds are [x,z] pairs');
check(city.bounds.max[0] > city.bounds.min[0] && city.bounds.max[1] > city.bounds.min[1],
  'bounds are non-degenerate');

/* ---------------------------------------------------------- finiteness */
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
let nan = 0;
const scanNum = (obj, path, depth = 0) => {
  if (obj === null || obj === undefined || depth > 6) return;
  if (typeof obj === 'number') { if (!Number.isFinite(obj)) { nan++; if (nan < 6) console.log('      non-finite at ' + path); } return; }
  if (Array.isArray(obj)) { for (let i = 0; i < obj.length; i++) scanNum(obj[i], path + '[' + i + ']', depth + 1); return; }
  if (typeof obj === 'object') { for (const k of Object.keys(obj)) scanNum(obj[k], path + '.' + k, depth + 1); }
};
scanNum(city, 'city');
check(nan === 0, `every number in CityData is finite (${nan} bad)`);

/* --------------------------------------------------- id == array index */
for (const [name, arr] of [['districts', city.districts], ['roads', city.roads],
  ['nodes', city.nodes], ['lanes', city.lanes], ['walks', city.walks],
  ['lots', city.lots], ['buildings', city.buildings], ['landmarks', city.landmarks]]) {
  let bad = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i].id !== i) bad++;
  check(bad === 0, `${name}[i].id === i (${bad} mismatches)`);
}

/* ------------------------------------------------------- record fields */
const need = (arr, name, keys, extra = () => null) => {
  const missing = new Set();
  let bad = 0;
  for (const o of arr) {
    for (const k of keys) if (o[k] === undefined) missing.add(k);
    const m = extra(o);
    if (m) { bad++; if (bad < 4) console.log('      ' + name + ' #' + o.id + ': ' + m); }
  }
  check(missing.size === 0, `${name} has all contract fields (missing: ${[...missing].join(',') || 'none'})`);
  check(bad === 0, `${name} records are self-consistent (${bad} bad)`);
};

need(city.districts, 'districts', ['id', 'name', 'kind', 'rect', 'palette'], (d) =>
  (!['downtown', 'midtown', 'residential', 'industrial', 'park', 'beach'].includes(d.kind) && `bad kind ${d.kind}`) ||
  (!finite(d.rect.x) || !finite(d.rect.z) || !(d.rect.w > 0) || !(d.rect.d > 0)) && 'bad rect' ||
  (!Array.isArray(d.palette) || d.palette.length === 0) && 'empty palette' ||
  (typeof d.name !== 'string' || !d.name) && 'no name');

need(city.roads, 'roads', ['id', 'ax', 'az', 'bx', 'bz', 'width', 'axis', 'lanes'], (r) =>
  (!['x', 'z'].includes(r.axis) && `bad axis ${r.axis}`) ||
  (!(r.width > 0) && 'bad width') ||
  (!(r.lanes >= 1) && 'bad lane count') ||
  (Math.hypot(r.bx - r.ax, r.bz - r.az) < 0.01 && 'degenerate segment'));

need(city.nodes, 'nodes', ['id', 'x', 'z', 'roads', 'hasTrafficLight'], (n) =>
  (!Array.isArray(n.roads) && 'roads not an array') ||
  (typeof n.hasTrafficLight !== 'boolean' && 'hasTrafficLight not a boolean'));

need(city.lanes, 'lanes', ['id', 'pts', 'width', 'next', 'speedLimit', 'oneWay'], (l) =>
  (!('nodeId' in l) && 'nodeId key absent') ||
  (l.nodeId !== null && !(l.nodeId >= 0 && l.nodeId < city.nodes.length) && 'bad nodeId') ||
  (l.oneWay !== true && 'oneWay must be true') ||
  (!(l.width > 0) && 'bad width') ||
  (!(l.speedLimit > 0) && 'bad speedLimit') ||
  (l.pts.length < 2 && 'fewer than 2 points'));

need(city.walks, 'walks', ['id', 'pts', 'next', 'crossing'], (w) =>
  (typeof w.crossing !== 'boolean' && 'crossing not a boolean') ||
  (w.pts.length < 2 && 'fewer than 2 points'));

need(city.lots, 'lots', ['id', 'districtId', 'x', 'z', 'w', 'd', 'kind'], (l) =>
  (!['building', 'park', 'parking', 'plaza', 'water'].includes(l.kind) && `bad kind ${l.kind}`) ||
  (!(l.districtId >= 0 && l.districtId < city.districts.length) && 'bad districtId') ||
  (!(l.w > 0 && l.d > 0) && 'degenerate lot'));

const STYLES = ['tower', 'office', 'apartment', 'shop', 'warehouse', 'house'];
need(city.buildings, 'buildings', ['id', 'lotId', 'x', 'z', 'w', 'd', 'h', 'floors', 'style',
  'rot', 'palette', 'hasSetback', 'roofKind', 'signs'], (b) =>
  (!STYLES.includes(b.style) && `bad style ${b.style}`) ||
  (!(b.lotId >= 0 && b.lotId < city.lots.length) && 'bad lotId') ||
  (!(b.w > 2 && b.d > 2 && b.h > 2) && 'degenerate volume') ||
  (!(b.floors >= 1) && 'bad floor count') ||
  (Math.abs(b.floors - Math.round(b.h / 3.4)) > 1 && 'floors do not match height') ||
  (typeof b.hasSetback !== 'boolean' && 'hasSetback not a boolean') ||
  (!b.palette.wall || !b.palette.trim || !b.palette.glass) && 'incomplete palette' ||
  (!Array.isArray(b.signs) && 'signs not an array'));

const PROP_TYPES = ['streetlight', 'tree', 'palm', 'bench', 'hydrant', 'trafficlight', 'sign',
  'bin', 'busstop', 'billboard', 'barrier', 'cone', 'dumpster', 'planter', 'bollard', 'atm',
  'phonebox', 'streetvendor', 'lamp'];
{
  const seen = new Set();
  let bad = 0;
  for (const p of city.props) {
    seen.add(p.type);
    if (!finite(p.x) || !finite(p.y) || !finite(p.z) || !finite(p.rot) || !(p.scale > 0)) bad++;
    if (!('extra' in p)) bad++;
  }
  const unknown = [...seen].filter((t) => !PROP_TYPES.includes(t));
  check(unknown.length === 0, `prop types are all in the contract (unknown: ${unknown.join(',') || 'none'})`);
  check(bad === 0, `props have finite transforms and an extra key (${bad} bad)`);
}

/* ---------------------------------------------------------- density rules */
check(city.buildings.length >= 600, `>= 600 buildings (${city.buildings.length})`);
check(city.props.length >= 1500, `>= 1500 props (${city.props.length})`);

/* ----------------------------------------------------------- graph ids */
{
  let dangling = 0;
  for (const l of city.lanes) for (const n of l.next) if (!(n >= 0 && n < city.lanes.length)) dangling++;
  check(dangling === 0, `no dangling lane.next ids (${dangling})`);
  let dw = 0;
  for (const w of city.walks) for (const n of w.next) if (!(n >= 0 && n < city.walks.length)) dw++;
  check(dw === 0, `no dangling walk.next ids (${dw})`);
  let dr = 0;
  for (const n of city.nodes) for (const r of n.roads) if (!(r >= 0 && r < city.roads.length)) dr++;
  check(dr === 0, `no dangling node.roads ids (${dr})`);
  let dl = 0;
  for (const v of city.spawns.vehicles) if (!(v.laneId >= 0 && v.laneId < city.lanes.length)) dl++;
  check(dl === 0, `no dangling spawn laneId (${dl})`);
  let selfLoop = 0;
  for (const l of city.lanes) if (l.next.indexOf(l.id) >= 0) selfLoop++;
  check(selfLoop === 0, `no lane links to itself (${selfLoop})`);
  let dead = 0;
  for (const l of city.lanes) if (l.next.length === 0) dead++;
  check(dead === 0, `no lane dead-ends (${dead} lanes with empty next)`);
  let deadW = 0;
  for (const w of city.walks) if (w.next.length === 0) deadW++;
  check(deadW === 0, `no walk dead-ends (${deadW})`);
}

/* --------------------------------------------------- graph reachability */
const reachability = (items, startId) => {
  const seen = new Uint8Array(items.length);
  const stack = [startId];
  seen[startId] = 1;
  let count = 1;
  while (stack.length) {
    const cur = items[stack.pop()];
    for (const n of cur.next) if (!seen[n]) { seen[n] = 1; count++; stack.push(n); }
  }
  return { count, seen };
};
{
  const fwd = reachability(city.lanes, 0);
  check(fwd.count / city.lanes.length > 0.9,
    `lane graph forward-reachable from lane 0: ${(100 * fwd.count / city.lanes.length).toFixed(1)}%`);
  // Reverse reachability proves the graph is (nearly) strongly connected, i.e.
  // traffic can also get back to the start rather than draining into a sink.
  const rev = city.lanes.map((l) => ({ next: [] }));
  for (const l of city.lanes) for (const n of l.next) rev[n].next.push(l.id);
  const back = reachability(rev, 0);
  check(back.count / city.lanes.length > 0.9,
    `lane graph reverse-reachable to lane 0: ${(100 * back.count / city.lanes.length).toFixed(1)}%`);
  const wfwd = reachability(city.walks, 0);
  check(wfwd.count / city.walks.length > 0.9,
    `walk graph reachable from walk 0: ${(100 * wfwd.count / city.walks.length).toFixed(1)}%`);
}

/* ----------------------------------------------- lane / walk continuity */
{
  let broken = 0;
  for (const l of city.lanes) {
    const end = l.pts[l.pts.length - 1];
    for (const n of l.next) {
      const s = city.lanes[n].pts[0];
      if (Math.hypot(s[0] - end[0], s[1] - end[1]) > 1.2) broken++;
    }
  }
  check(broken === 0, `lane.next successors start where the lane ends (${broken} gaps > 1.2 m)`);
  let bw = 0;
  for (const w of city.walks) {
    const end = w.pts[w.pts.length - 1];
    for (const n of w.next) {
      const s = city.walks[n].pts[0];
      if (Math.hypot(s[0] - end[0], s[1] - end[1]) > 0.05) bw++;
    }
  }
  check(bw === 0, `walk.next successors start exactly where the walk ends (${bw} gaps)`);
}

/* ------------------------------------------- lanes obey right-hand rule */
{
  // For a straight two-way edge the forward bundle must sit on the right of
  // travel: cross(dir, laneCentre - edgeCentre) must be negative in XZ with
  // right = (-dz, dx).
  let wrong = 0;
  let tested = 0;
  const byEdge = new Map();
  for (const l of city.lanes) {
    if (l.edgeId === undefined || l.edgeId < 0) continue;
    let a = byEdge.get(l.edgeId);
    if (!a) { a = []; byEdge.set(l.edgeId, a); }
    a.push(l);
  }
  for (const [, ls] of byEdge) {
    for (const l of ls) {
      const d = [l.pts[1][0] - l.pts[0][0], l.pts[1][1] - l.pts[0][1]];
      const n = Math.hypot(d[0], d[1]) || 1;
      d[0] /= n; d[1] /= n;
      const opp = ls.find((o) => o.toNode === l.fromNode && o.fromNode === l.toNode);
      if (!opp) continue;
      tested++;
      const mid = [(l.pts[0][0] + l.pts[l.pts.length - 1][0]) * 0.5,
        (l.pts[0][1] + l.pts[l.pts.length - 1][1]) * 0.5];
      const omid = [(opp.pts[0][0] + opp.pts[opp.pts.length - 1][0]) * 0.5,
        (opp.pts[0][1] + opp.pts[opp.pts.length - 1][1]) * 0.5];
      const rx = -d[1];
      const rz = d[0];
      if ((omid[0] - mid[0]) * rx + (omid[1] - mid[1]) * rz > -0.2) wrong++;
    }
  }
  check(tested > 100 && wrong === 0,
    `right-hand traffic: opposing bundle is to the left (${wrong}/${tested} wrong)`);
}

/* ---------------------------------------- walks on both sides of a road */
{
  const sides = new Map();
  for (const w of city.walks) {
    if (w.crossing || w.edgeId === undefined || w.edgeId < 0) continue;
    sides.set(w.edgeId, (sides.get(w.edgeId) || 0) + 1);
  }
  // Each side contributes a forward/backward pair -> 4 walks per full edge.
  let short = 0;
  for (const [, n] of sides) if (n < 4) short++;
  check(sides.size > 0 && short === 0, `every edge with sidewalks has both sides (${short} one-sided)`);
  const crossings = city.walks.filter((w) => w.crossing).length;
  check(crossings > 100, `pedestrian crossings exist (${crossings})`);
  const lit = city.nodes.filter((n) => n.hasTrafficLight).length;
  check(lit > 10, `intersections with traffic lights (${lit})`);
  const signals = city.props.filter((p) => p.type === 'trafficlight').length;
  check(signals >= lit, `traffic-light props cover the signalled nodes (${signals} for ${lit})`);
}

/* -------------------------------------- buildings never overlap asphalt */
const obb = (ax, az, ahx, ahz, arot, bx, bz, bhx, bhz, brot, margin) => {
  const A = [[Math.cos(arot), Math.sin(arot)], [-Math.sin(arot), Math.cos(arot)]];
  const B = [[Math.cos(brot), Math.sin(brot)], [-Math.sin(brot), Math.cos(brot)]];
  const AH = [ahx + margin, ahz + margin];
  const BH = [bhx + margin, bhz + margin];
  const dx = bx - ax;
  const dz = bz - az;
  for (const axis of [A[0], A[1], B[0], B[1]]) {
    const ra = AH[0] * Math.abs(axis[0] * A[0][0] + axis[1] * A[0][1]) +
      AH[1] * Math.abs(axis[0] * A[1][0] + axis[1] * A[1][1]);
    const rb = BH[0] * Math.abs(axis[0] * B[0][0] + axis[1] * B[0][1]) +
      BH[1] * Math.abs(axis[0] * B[1][0] + axis[1] * B[1][1]);
    if (ra + rb - Math.abs(axis[0] * dx + axis[1] * dz) <= 0) return false;
  }
  return true;
};
{
  let onRoad = 0;
  let firstMsg = '';
  for (const b of city.buildings) {
    for (const r of city.roads) {
      const len = Math.hypot(r.bx - r.ax, r.bz - r.az);
      const rot = Math.atan2(r.bz - r.az, r.bx - r.ax);
      if (Math.hypot((r.ax + r.bx) * 0.5 - b.x, (r.az + r.bz) * 0.5 - b.z) > len * 0.5 + r.width + 60) continue;
      if (obb(b.x, b.z, b.w * 0.5, b.d * 0.5, b.rot,
        (r.ax + r.bx) * 0.5, (r.az + r.bz) * 0.5, len * 0.5, r.width * 0.5, rot, 0)) {
        onRoad++;
        if (!firstMsg) firstMsg = `building ${b.id} @(${b.x.toFixed(1)},${b.z.toFixed(1)}) on road ${r.id}`;
        break;
      }
    }
  }
  check(onRoad === 0, `no building overlaps a carriageway (${onRoad}) ${firstMsg}`);
}
{
  // Sidewalk keep-out: the contract says buildings clear the sidewalk too.
  let onWalk = 0;
  for (const b of city.buildings) {
    for (const r of city.roads) {
      const len = Math.hypot(r.bx - r.ax, r.bz - r.az);
      const rot = Math.atan2(r.bz - r.az, r.bx - r.ax);
      if (Math.hypot((r.ax + r.bx) * 0.5 - b.x, (r.az + r.bz) * 0.5 - b.z) > len * 0.5 + r.width + 60) continue;
      if (obb(b.x, b.z, b.w * 0.5, b.d * 0.5, b.rot,
        (r.ax + r.bx) * 0.5, (r.az + r.bz) * 0.5, len * 0.5, r.width * 0.5 + city.sidewalkWidth, rot, 0)) {
        onWalk++;
        break;
      }
    }
  }
  check(onWalk === 0, `no building overlaps a sidewalk (${onWalk})`);
}
{
  // Buildings must not intersect each other.
  const cell = 40;
  const grid = new Map();
  const key = (i, j) => i + ',' + j;
  let overlaps = 0;
  let firstMsg = '';
  for (const b of city.buildings) {
    const ex = Math.abs(b.w * 0.5 * Math.cos(b.rot)) + Math.abs(b.d * 0.5 * Math.sin(b.rot));
    const ez = Math.abs(b.w * 0.5 * Math.sin(b.rot)) + Math.abs(b.d * 0.5 * Math.cos(b.rot));
    const i0 = Math.floor((b.x - ex) / cell); const i1 = Math.floor((b.x + ex) / cell);
    const j0 = Math.floor((b.z - ez) / cell); const j1 = Math.floor((b.z + ez) / cell);
    const cand = new Set();
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const arr = grid.get(key(i, j));
      if (arr) for (const o of arr) cand.add(o);
    }
    for (const o of cand) {
      if (obb(b.x, b.z, b.w * 0.5, b.d * 0.5, b.rot, o.x, o.z, o.w * 0.5, o.d * 0.5, o.rot, 0)) {
        overlaps++;
        if (!firstMsg) firstMsg = `#${b.id} vs #${o.id} @(${b.x.toFixed(1)},${b.z.toFixed(1)})`;
        break;
      }
    }
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = key(i, j);
      let arr = grid.get(k);
      if (!arr) { arr = []; grid.set(k, arr); }
      arr.push(b);
    }
  }
  check(overlaps === 0, `no two buildings intersect (${overlaps}) ${firstMsg}`);
}

/* ------------------------------------------------------- signs on walls */
{
  let bad = 0;
  let firstMsg = '';
  for (const b of city.buildings) {
    for (const s of b.signs) {
      const halfOut = (s.face === 0 || s.face === 2) ? b.w * 0.5 : b.d * 0.5;
      const halfAlong = (s.face === 0 || s.face === 2) ? b.d * 0.5 : b.w * 0.5;
      const problem =
        (!finite(s.x) || !finite(s.z) || !finite(s.y)) ? 'non-finite' :
        (s.y - s.h * 0.5 < 0) ? 'sign below ground' :
        (s.y + s.h * 0.5 > b.h + 0.05) ? `sign above roof (y=${s.y.toFixed(1)} h=${b.h})` :
        (s.w * 0.5 > halfAlong + 0.05) ? 'sign wider than the wall' :
        (Math.abs(Math.abs(s.x - b.x) - (s.nx ? halfOut + 0.12 : 0)) > 0.2 &&
         Math.abs(Math.abs(s.z - b.z) - (s.nz ? halfOut + 0.12 : 0)) > 0.2) ? 'sign off the wall plane' :
        (!Array.isArray(s.color) || s.color.length !== 3) ? 'bad colour' :
        (typeof s.text !== 'string' || !s.text) ? 'no text' : null;
      if (problem) { bad++; if (!firstMsg) firstMsg = `building ${b.id} sign: ${problem}`; }
    }
  }
  check(bad === 0, `building signs sit on their wall within the facade (${bad}) ${firstMsg}`);
}

/* --------------------------------------------------------------- spawns */
{
  const s = city.spawns;
  check(s.player && finite(s.player.x) && finite(s.player.y) && finite(s.player.z) && finite(s.player.yaw),
    'spawns.player is a finite {x,y,z,yaw}');
  check(s.vehicles.length > 60, `vehicle spawns (${s.vehicles.length})`);
  check(s.peds.length > 100, `ped spawns (${s.peds.length})`);
  check(s.police.length >= 4, `police spawns (${s.police.length})`);
  check(s.missionPoints.length >= 6, `mission points (${s.missionPoints.length})`);
  let named = 0;
  for (const m of s.missionPoints) if (typeof m.name === 'string' && m.name) named++;
  check(named === s.missionPoints.length, 'every mission point is named');

  const inside = (x, z) => city.buildings.some((b) =>
    obb(x, z, 0.4, 0.4, 0, b.x, b.z, b.w * 0.5, b.d * 0.5, b.rot, 0));
  check(!inside(s.player.x, s.player.z), 'player does not spawn inside a building');
  check(!isOnRoad(city, s.player.x, s.player.z), 'player does not spawn on a carriageway');
  let vehBad = 0;
  for (const v of s.vehicles) if (!isOnRoad(city, v.x, v.z)) vehBad++;
  check(vehBad === 0, `every vehicle spawn is on a carriageway (${vehBad} off-road)`);
  let vehInside = 0;
  for (const v of s.vehicles) if (inside(v.x, v.z)) vehInside++;
  check(vehInside === 0, `no vehicle spawns inside a building (${vehInside})`);
  let pedBad = 0;
  for (const p of s.peds) if (isOnRoad(city, p.x, p.z)) pedBad++;
  check(pedBad === 0, `no pedestrian spawns on a carriageway (${pedBad})`);
  let pedInside = 0;
  for (const p of s.peds) if (inside(p.x, p.z)) pedInside++;
  check(pedInside === 0, `no pedestrian spawns inside a building (${pedInside})`);
  let mBad = 0;
  for (const m of s.missionPoints) if (inside(m.x, m.z)) mBad++;
  check(mBad === 0, `no mission point is inside a building (${mBad})`);
  let polBad = 0;
  for (const p of s.police) if (inside(p.x, p.z)) polBad++;
  check(polBad === 0, `no police spawn is inside a building (${polBad})`);
  const inb = (p) => p.x >= city.bounds.min[0] && p.x <= city.bounds.max[0] &&
    p.z >= city.bounds.min[1] && p.z <= city.bounds.max[1];
  let oob = 0;
  for (const p of [s.player, ...s.vehicles, ...s.peds, ...s.police, ...s.missionPoints]) if (!inb(p)) oob++;
  check(oob === 0, `every spawn is inside bounds (${oob} outside)`);
  const dedup = new Set(s.missionPoints.map((m) => m.name));
  check(dedup.size === s.missionPoints.length, 'mission point names are unique');
  let coincident = 0;
  for (let i = 0; i < s.missionPoints.length; i++) {
    for (let j = i + 1; j < s.missionPoints.length; j++) {
      const a = s.missionPoints[i]; const b = s.missionPoints[j];
      if (Math.hypot(a.x - b.x, a.z - b.z) < 12) coincident++;
    }
  }
  check(coincident === 0, `mission points are spread out (${coincident} pairs < 12 m apart)`);
}

/* ------------------------------------------------------------ landmarks */
{
  check(city.landmarks.length >= 8, `landmarks (${city.landmarks.length})`);
  let bad = 0;
  for (const m of city.landmarks) {
    if (!finite(m.x) || !finite(m.z) || typeof m.name !== 'string' || !m.name || !m.kind) bad++;
  }
  check(bad === 0, `landmarks are complete (${bad} bad)`);
  const kinds = new Set(city.landmarks.map((m) => m.kind));
  check(kinds.has('tower') && kinds.has('park') && kinds.has('police'),
    `landmark kinds cover tower/park/police (${[...kinds].join(',')})`);
}

/* ---------------------------------------------------------- districts */
{
  const kinds = new Set(city.districts.map((d) => d.kind));
  check(kinds.has('downtown'), 'a downtown district exists');
  check(kinds.has('park') || city.lots.some((l) => l.kind === 'park'), 'a park exists');
  check(kinds.has('beach') || city.lots.some((l) => l.surface === 'sand'), 'a waterfront exists');
  // Downtown must be central and the tallest.
  const avgH = {};
  for (const b of city.buildings) {
    const k = city.districts[city.lots[b.lotId].districtId].kind;
    (avgH[k] = avgH[k] || []).push(b.h);
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  check(mean(avgH.downtown) > mean(avgH.midtown) && mean(avgH.midtown) > mean(avgH.residential),
    `skyline steps down: downtown ${mean(avgH.downtown).toFixed(0)} > midtown ` +
    `${mean(avgH.midtown).toFixed(0)} > residential ${mean(avgH.residential).toFixed(0)} m`);
  const dc = city.districts.filter((d) => d.kind === 'downtown');
  const cen = Math.min(...dc.map((d) => Math.hypot(d.rect.cx, d.rect.cz)));
  check(cen < 200, `downtown sits near the world centre (${cen.toFixed(0)} m)`);
  check(Math.max(...city.buildings.map((b) => b.h)) > 100,
    `tallest tower is a real skyscraper (${Math.max(...city.buildings.map((b) => b.h)).toFixed(0)} m)`);
  // Rectangles must partition without overlapping.
  let ov = 0;
  for (let i = 0; i < city.districts.length; i++) {
    for (let j = i + 1; j < city.districts.length; j++) {
      const a = city.districts[i].rect; const b = city.districts[j].rect;
      if (a.x0 < b.x1 - 0.01 && b.x0 < a.x1 - 0.01 && a.z0 < b.z1 - 0.01 && b.z0 < a.z1 - 0.01) ov++;
    }
  }
  check(ov === 0, `district rectangles do not overlap (${ov})`);
}

/* --------------------------------------------------------------- lots */
{
  let ov = 0;
  let firstMsg = '';
  for (let i = 0; i < city.lots.length; i++) {
    for (let j = i + 1; j < city.lots.length; j++) {
      const a = city.lots[i]; const b = city.lots[j];
      if (a.x0 < b.x1 - 0.01 && b.x0 < a.x1 - 0.01 && a.z0 < b.z1 - 0.01 && b.z0 < a.z1 - 0.01) {
        ov++;
        if (!firstMsg) firstMsg = `lots ${a.id}(${a.kind}) / ${b.id}(${b.kind})`;
      }
    }
  }
  check(ov === 0, `lots do not overlap (${ov}) ${firstMsg}`);
  check(city.lots.some((l) => l.kind === 'water') === (city.waterLevel !== null),
    'water lots exist exactly when waterLevel is set');
}

/* ------------------------------------------------------------- helpers */
{
  const r = laneAt(city, city.spawns.player.x, city.spawns.player.z);
  check(r && r.lane && finite(r.dist) && r.point.length === 2, 'laneAt returns a lane sample');
  const w = walkAt(city, city.spawns.player.x, city.spawns.player.z);
  check(w && w.walk && finite(w.dist), 'walkAt returns a walk sample');
  check(w.dist < 6, `walkAt near the player spawn is close (${w ? w.dist.toFixed(2) : '?'} m)`);
  const reuse = { lane: null, walk: null, t: 0, point: [0, 0], x: 0, z: 0, dist: 0 };
  const a1 = laneAt(city, 12, 34, reuse);
  check(a1 === reuse, 'laneAt writes into the caller-supplied out object');
  check(districtAt(city, 0, 0) !== null, 'districtAt resolves the world centre');
  check(districtAt(city, city.bounds.min[0] - 5000, 0) === null, 'districtAt returns null outside bounds');
  let onRoadCount = 0;
  for (const r2 of city.roads) {
    if (isOnRoad(city, (r2.ax + r2.bx) * 0.5, (r2.az + r2.bz) * 0.5)) onRoadCount++;
  }
  check(onRoadCount === city.roads.length, `isOnRoad is true at every road midpoint (${onRoadCount}/${city.roads.length})`);
  // Far outside the city there is no asphalt.
  check(!isOnRoad(city, city.bounds.min[0] - 500, city.bounds.min[1] - 500), 'isOnRoad is false off the map');
  const st = cityStats(city);
  check(st.buildings === city.buildings.length && st.props === city.props.length && st.area > 0,
    'cityStats matches the data');
  // Query cost: the accelerated index must not degrade to a linear scan.
  const t1 = Date.now();
  for (let i = 0; i < 20000; i++) {
    laneAt(city, city.bounds.min[0] + (i % 997) * 1.7, city.bounds.min[1] + (i % 811) * 2.3, reuse);
  }
  const qms = Date.now() - t1;
  check(qms < 3000, `20k laneAt queries in ${qms} ms`);
}

/* ------------------------------------------ nearest-point index integrity */
{
  // Brute-force a sample of queries against the accelerated index.
  let worst = 0;
  const out = { lane: null, walk: null, t: 0, point: [0, 0], x: 0, z: 0, dist: 0 };
  for (let s = 0; s < 200; s++) {
    const x = city.bounds.min[0] + ((s * 613) % 1000) / 1000 * (city.bounds.max[0] - city.bounds.min[0]);
    const z = city.bounds.min[1] + ((s * 311) % 1000) / 1000 * (city.bounds.max[1] - city.bounds.min[1]);
    const got = laneAt(city, x, z, out);
    let best = Infinity;
    for (const l of city.lanes) {
      for (let i = 0; i + 1 < l.pts.length; i++) {
        const ax = l.pts[i][0]; const az = l.pts[i][1];
        const dx = l.pts[i + 1][0] - ax; const dz = l.pts[i + 1][1] - az;
        const l2 = dx * dx + dz * dz;
        let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
        if (d < best) best = d;
      }
    }
    worst = Math.max(worst, (got ? got.dist : Infinity) - best);
  }
  check(worst < 0.001, `laneAt matches a brute-force nearest search (worst error ${worst.toFixed(4)} m)`);
}

/* ------------------------------------------------------------- options */
{
  const small = generateCity(7, { blocksX: 6, blocksZ: 6, blockSize: 48, roadWidth: 14, seaSide: false });
  check(small.blocksX === 6 && small.blocksZ === 6 && small.blockSize === 48 && small.roadWidth === 14,
    'opts are honoured');
  check(small.waterLevel === null && !small.lots.some((l) => l.kind === 'water'),
    'seaSide:false produces no water');
  check(small.buildings.length > 40 && small.props.length > 200,
    `small city still populated (${small.buildings.length} buildings, ${small.props.length} props)`);
  let d2 = 0;
  for (const l of small.lanes) for (const n of l.next) if (!(n >= 0 && n < small.lanes.length)) d2++;
  check(d2 === 0, 'small city lane graph has no dangling ids');
  check(small.spawns.player !== null, 'small city has a player spawn');
  const tiny = generateCity(9, { blocksX: 4, blocksZ: 4 });
  check(tiny.buildings.length > 0 && tiny.lanes.length > 0 && tiny.spawns.player !== null,
    'minimum 4x4 city still generates');
  const nan2 = [];
  scanNum(small, 'small');
  scanNum(tiny, 'tiny');
  check(nan === 0, 'option variants contain no non-finite numbers');
}

/* --------------------------------- long polylines are fully indexed */
{
  // The nearest-point index used to pack (polyline, segment) into one integer
  // with a 128-wide stride, silently dropping every segment past the 127th.
  // Feed it a long lane and check the far end is still found.
  const pts = [];
  for (let i = 0; i <= 400; i++) pts.push([i * 3, 0]);
  const fake = {
    bounds: { min: [-10, -10], max: [1300, 10] },
    lanes: [{ id: 0, pts, width: 3, next: [], nodeId: null, speedLimit: 10, oneWay: true }],
    walks: [{ id: 0, pts, next: [], crossing: false }],
    roads: [], districts: []
  };
  const r1 = laneAt(fake, 1195, 4);
  check(r1 !== null && Math.abs(r1.dist - 4) < 0.01,
    `laneAt indexes segments past the old 128 limit (dist ${r1 ? r1.dist.toFixed(2) : 'null'})`);
  const r2 = walkAt(fake, 900, -3);
  check(r2 !== null && Math.abs(r2.dist - 3) < 0.01,
    `walkAt indexes segments past the old 128 limit (dist ${r2 ? r2.dist.toFixed(2) : 'null'})`);
}

/* ------------------------------------------------- multi-seed regression */
{
  // The defects fixed in this module (footprints shoved across a road by the
  // clip pass, street furniture standing in traffic lanes, props growing
  // through each other, signage stranded after a height change) were all
  // seed-dependent, so re-check the invariants over a spread of seeds.
  const PROP_R = {
    streetlight: 0.45, tree: 1.5, palm: 1.3, bench: 1.0, hydrant: 0.35,
    trafficlight: 0.45, sign: 0.25, bin: 0.45, busstop: 2.2, billboard: 1.8,
    barrier: 1.1, cone: 0.3, dumpster: 1.3, planter: 0.9, bollard: 0.25,
    atm: 0.6, phonebox: 0.7, streetvendor: 1.2, lamp: 0.4
  };
  const totals = { keepout: 0, overlap: 0, outOfLot: 0, signs: 0, onRoad: 0, clash: 0, dangling: 0 };
  const seeds = [20260906, 4242, 7, 1337, 99, 555, 31337, 2, 1000003];
  for (const seed of seeds) {
    const c = generateCity(seed, {});
    const rects = c.roads.map((r) => {
      const len = Math.hypot(r.bx - r.ax, r.bz - r.az);
      return {
        x: (r.ax + r.bx) * 0.5, z: (r.az + r.bz) * 0.5,
        hx: len * 0.5, hz: r.width * 0.5, rot: Math.atan2(r.bz - r.az, r.bx - r.ax)
      };
    });
    for (const b of c.buildings) {
      for (const rc of rects) {
        if (Math.hypot(rc.x - b.x, rc.z - b.z) > rc.hx + rc.hz + 60) continue;
        if (obb(b.x, b.z, b.w * 0.5, b.d * 0.5, b.rot,
          rc.x, rc.z, rc.hx, rc.hz + c.sidewalkWidth, rc.rot, 0)) { totals.keepout++; break; }
      }
      const lot = c.lots[b.lotId];
      if (b.x - b.w * 0.5 < lot.x0 - 0.5 || b.x + b.w * 0.5 > lot.x1 + 0.5 ||
        b.z - b.d * 0.5 < lot.z0 - 0.5 || b.z + b.d * 0.5 > lot.z1 + 0.5) totals.outOfLot++;
      for (const sg of b.signs) {
        const halfAlong = (sg.face === 0 || sg.face === 2) ? b.d * 0.5 : b.w * 0.5;
        if (sg.w * 0.5 > halfAlong + 0.05 || sg.y + sg.h * 0.5 > b.h + 0.05 ||
          sg.y - sg.h * 0.5 < 0) totals.signs++;
      }
    }
    const cell = 40;
    const grid = new Map();
    for (const b of c.buildings) {
      const ex = Math.abs(b.w * 0.5 * Math.cos(b.rot)) + Math.abs(b.d * 0.5 * Math.sin(b.rot));
      const ez = Math.abs(b.w * 0.5 * Math.sin(b.rot)) + Math.abs(b.d * 0.5 * Math.cos(b.rot));
      const keys = new Set();
      for (let i = Math.floor((b.x - ex) / cell); i <= Math.floor((b.x + ex) / cell); i++) {
        for (let j = Math.floor((b.z - ez) / cell); j <= Math.floor((b.z + ez) / cell); j++) keys.add(i + ',' + j);
      }
      for (const k of keys) {
        for (const o of (grid.get(k) || [])) {
          if (obb(b.x, b.z, b.w * 0.5, b.d * 0.5, b.rot, o.x, o.z, o.w * 0.5, o.d * 0.5, o.rot, 0)) {
            totals.overlap++; break;
          }
        }
      }
      for (const k of keys) {
        let arr = grid.get(k);
        if (!arr) { arr = []; grid.set(k, arr); }
        arr.push(b);
      }
    }
    const onWall = (p) => p.type === 'billboard' && p.extra && p.extra.onWall;
    for (const p of c.props) {
      if (p.type === 'cone' || p.type === 'barrier' || onWall(p)) continue;
      for (const rc of rects) {
        if (Math.hypot(rc.x - p.x, rc.z - p.z) > rc.hx + rc.hz + 5) continue;
        if (obb(p.x, p.z, 0.25, 0.25, 0, rc.x, rc.z, rc.hx, rc.hz, rc.rot, 0)) { totals.onRoad++; break; }
      }
    }
    const pc = 6;
    const pg = new Map();
    for (let i = 0; i < c.props.length; i++) {
      const p = c.props[i];
      const k = Math.floor(p.x / pc) + ',' + Math.floor(p.z / pc);
      let arr = pg.get(k);
      if (!arr) { arr = []; pg.set(k, arr); }
      arr.push(i);
    }
    for (let i = 0; i < c.props.length; i++) {
      const p = c.props[i];
      if (p.type === 'cone' || onWall(p)) continue;
      const bi = Math.floor(p.x / pc);
      const bj = Math.floor(p.z / pc);
      for (let a = bi - 1; a <= bi + 1; a++) {
        for (let b2 = bj - 1; b2 <= bj + 1; b2++) {
          for (const j of (pg.get(a + ',' + b2) || [])) {
            if (j <= i) continue;
            const q = c.props[j];
            if (q.type === 'cone' || onWall(q)) continue;
            const need = ((PROP_R[p.type] || 0.3) * p.scale + (PROP_R[q.type] || 0.3) * q.scale) * 0.75;
            if (Math.hypot(p.x - q.x, p.z - q.z) < need) totals.clash++;
          }
        }
      }
    }
    for (const l of c.lanes) for (const n of l.next) if (!(n >= 0 && n < c.lanes.length)) totals.dangling++;
    if (c.buildings.length < 600 || c.props.length < 1500) fail(`seed ${seed} is too sparse`);
  }
  check(totals.keepout === 0, `${seeds.length} seeds: no building on a road or sidewalk (${totals.keepout})`);
  check(totals.overlap === 0, `${seeds.length} seeds: no building intersects another (${totals.overlap})`);
  check(totals.outOfLot === 0, `${seeds.length} seeds: every building stays inside its lot (${totals.outOfLot})`);
  check(totals.signs === 0, `${seeds.length} seeds: every sign fits its facade (${totals.signs})`);
  check(totals.onRoad === 0, `${seeds.length} seeds: no street furniture in a traffic lane (${totals.onRoad})`);
  check(totals.clash === 0, `${seeds.length} seeds: no two props interpenetrate (${totals.clash})`);
  check(totals.dangling === 0, `${seeds.length} seeds: no dangling lane ids (${totals.dangling})`);
}

/* -------------------------------------------------------------- summary */
console.log(`\n${checks - failures}/${checks} checks passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
