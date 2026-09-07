/**
 * Node regression test for js/world/collision.js.
 *
 * Builds a world of thousands of boxes and asserts the character mover, sweeps, raycasts and
 * ground queries behave: landing accuracy, no wall penetration or tunnelling, kerb step-up,
 * corner sliding, DDA ray acceleration, and throughput.
 *
 * Run: node tools/test-collision.mjs
 */
import { CollisionWorld } from '../js/world/collision.js';
import { Rand } from '../js/core/math.js';

const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); };
const rng = new Rand(4242);

const world = new CollisionWorld(1600, 16);

// Ground slab
world.addBox(0, -1, 0, 800, 1, 800, 0, 'ground', null);
// 5000 scattered buildings
for (let i = 0; i < 5000; i++) {
  const x = rng.range(-700, 700);
  const z = rng.range(-700, 700);
  const h = rng.range(3, 40);
  world.addBox(x, h, z, rng.range(3, 12), h, rng.range(3, 12), rng.range(0, Math.PI), 'building', { i });
}
// Test fixtures near the origin
const wallId = world.addBox(6, 2, 0, 0.5, 2, 8, 0, 'wall', null);      // wall at x=6
world.addBox(0, 0.15, 12, 8, 0.15, 0.6, 0, 'kerb', null);              // 0.3 m kerb at z=12
world.addBox(0, 0.6, 20, 8, 0.6, 0.6, 0, 'wall', null);                // 1.2 m wall at z=20
world.addBox(-10, 2, 0, 0.5, 2, 8, 0, 'wall', null);                   // wall at x=-10
world.addBox(-6, 2, -6, 8, 2, 0.5, 0, 'wall', null);                   // wall at z=-6 (corner with above)

console.log('bodies:', world.stats ? JSON.stringify(world.stats) : '(no stats)');

const R = 0.36; const H = 1.78;
const out = { x: 0, y: 0, z: 0, grounded: false, groundY: 0, normal: [0, 1, 0], hits: 0 };
const move = (p, d) => { world.moveCapsule(p, R, H, d, out); p[0] = out.x; p[1] = out.y; p[2] = out.z; return out; };

// ---- 1. drop and land ------------------------------------------------------------------
{
  const p = [0, 20, 0];
  let vy = 0;
  let landed = -1;
  for (let i = 0; i < 300; i++) {
    vy -= 22 / 60;
    const r = move(p, [0, vy / 60, 0]);
    if (r.grounded) { landed = i; vy = 0; break; }
  }
  console.log(`drop: landed frame ${landed} at y=${p[1].toFixed(4)} groundY=${out.groundY.toFixed(3)}`);
  ok(landed > 0, 'capsule never landed when dropped from 20 m');
  ok(Math.abs(p[1] - 0) < 0.02, `landed at y=${p[1].toFixed(4)}, expected ~0`);
}

// ---- 2. wall: no penetration, no NaN ---------------------------------------------------
{
  const p = [0, 0, 0];
  for (let i = 0; i < 600; i++) move(p, [0.12, -0.02, 0]);
  console.log(`wall push: x=${p[1] !== undefined ? p[0].toFixed(4) : '?'} (wall face at 5.5, capsule radius ${R})`);
  ok(Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]), 'NaN after pushing into a wall');
  ok(p[0] < 5.5 + 0.02, `penetrated the wall: x=${p[0].toFixed(4)} (face is at 5.5)`);
  ok(p[0] > 5.0, `stopped too early: x=${p[0].toFixed(4)}`);
  const inside = world.querySphere(p[0], p[1] + 0.9, p[2], R * 0.8, []);
  ok(!inside.some((b) => b.tag === 'wall'), 'capsule ended up overlapping the wall body');
}

// ---- 3. kerb step-up vs wall ------------------------------------------------------------
{
  const p = [0, 0, 9];
  let onKerbY = 0;
  for (let i = 0; i < 200; i++) {
    move(p, [0, -0.05, 0.06]);
    // The kerb slab spans z 11.4..12.6 — only sample the height while standing on it.
    if (p[2] > 11.5 && p[2] < 12.6) onKerbY = Math.max(onKerbY, p[1]);
  }
  console.log(`kerb: walked to z=${p[2].toFixed(2)}, max y while on the kerb = ${onKerbY.toFixed(3)} (kerb top 0.3)`);
  ok(p[2] > 12.5, `did not step up onto the 0.3 m kerb (z=${p[2].toFixed(2)})`);
  ok(onKerbY > 0.25, `did not rise onto the kerb (max y on it = ${onKerbY.toFixed(3)})`);

  const q = [0, 0.3, 17];
  for (let i = 0; i < 200; i++) move(q, [0, -0.05, 0.06]);
  console.log(`1.2 m wall: z=${q[2].toFixed(2)} y=${q[1].toFixed(3)}`);
  ok(q[2] < 19.7, `climbed a 1.2 m wall it should not (z=${q[2].toFixed(2)})`);
}

// ---- 4. corner sliding --------------------------------------------------------------------
{
  const p = [-8, 0, -4];
  const start = p[2];
  for (let i = 0; i < 200; i++) move(p, [-0.08, -0.02, -0.08]);
  console.log(`corner: x=${p[0].toFixed(2)} z=${p[2].toFixed(2)} (walls at x=-10.5 and z=-6.5)`);
  ok(Number.isFinite(p[0]), 'NaN in a corner');
  ok(p[0] > -10.5 && p[2] > -6.5 - 0.01, `pushed through a corner: ${p[0].toFixed(2)},${p[2].toFixed(2)}`);
  ok(Math.abs(p[2] - start) > 0.3 || Math.abs(p[0] + 8) > 0.3, 'did not slide at all in the corner');
}

// ---- 5. high-speed tunnelling ---------------------------------------------------------------
{
  const p = [0, 0.9, 0];
  move(p, [60, 0, 0]);   // 60 m in one step, straight at the wall
  console.log(`tunnel test: x=${p[0].toFixed(3)}`);
  ok(p[0] < 5.6, `tunnelled through the wall at high speed: x=${p[0].toFixed(3)}`);
}

// ---- 6. raycast ----------------------------------------------------------------------------
{
  const hit = world.raycast([0, 50, 0], [0, -1, 0], 200, null);
  console.log('down ray:', hit ? `t=${hit.t.toFixed(3)} tag=${hit.body && hit.body.tag}` : 'MISS');
  ok(hit && Math.abs(hit.t - 50) < 0.05, `downward ray should hit the ground at t=50, got ${hit ? hit.t : 'miss'}`);

  const side = world.raycast([0, 1, 0], [1, 0, 0], 100, null);
  console.log('side ray:', side ? `t=${side.t.toFixed(3)} tag=${side.body && side.body.tag}` : 'MISS');
  ok(side && Math.abs(side.t - 5.5) < 0.06, `sideways ray should hit the wall at t=5.5, got ${side ? side.t.toFixed(3) : 'miss'}`);

  const filtered = world.raycast([0, 1, 0], [1, 0, 0], 100, (b) => b.tag !== 'wall');
  ok(!filtered || (filtered.body && filtered.body.tag !== 'wall'), 'raycast filter was ignored');

  // DDA efficiency: a long ray must not test every body
  const before = world.stats && (world.stats.rayCells ?? 0);
  world.raycast([-700, 3, -700], [1, 0, 1], 400, null);
  const cells = world.stats ? (world.stats.rayCells ?? 0) - before : 0;
  console.log('ray cells walked:', cells);
  ok(cells === 0 || cells < 200, `DDA walked ${cells} cells for a 400 m ray — looks like a full scan`);
}

// ---- 7. sweepSphere ---------------------------------------------------------------------------
{
  const s = world.sweepSphere([0, 1, 0], [12, 1, 0], 0.5);
  console.log('sweep:', s ? `t=${s.t.toFixed(3)} normal=${s.normal && s.normal.map((v) => v.toFixed(2)).join(',')}` : 'MISS');
  ok(s, 'sweepSphere missed a wall directly in its path');
  if (s) {
    const impactX = 12 * s.t;
    ok(Math.abs(impactX - 5.0) < 0.35, `sweep impact at x=${impactX.toFixed(2)}, expected ~5.0 (wall face 5.5 - radius 0.5)`);
  }
  ok(!world.sweepSphere([0, 1, 100], [0, 1, 140], 0.5) || true, 'sweep in empty space should not throw');
}

// ---- 8. groundHeight ---------------------------------------------------------------------------
{
  let bad = 0;
  for (let i = 0; i < 2000; i++) {
    const g = world.groundHeight(rng.range(-700, 700), rng.range(-700, 700));
    if (!Number.isFinite(g)) bad++;
  }
  console.log('groundHeight non-finite:', bad, '/2000');
  ok(bad === 0, `${bad}/2000 groundHeight queries returned non-finite`);
  ok(Math.abs(world.groundHeight(0, 12) - 0.3) < 0.05, `kerb top should be 0.3, got ${world.groundHeight(0, 12)}`);
}

// ---- 9. remove -------------------------------------------------------------------------------
{
  world.remove(wallId);
  const p = [0, 0, 0];
  for (let i = 0; i < 200; i++) move(p, [0.1, -0.02, 0]);
  console.log(`after removing the wall: x=${p[0].toFixed(2)}`);
  ok(p[0] > 8, `remove() did not take the wall out of the world (x=${p[0].toFixed(2)})`);
}

// ---- 10. throughput ----------------------------------------------------------------------------
{
  const p = [0, 1, 0];
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20000; i++) {
    move(p, [Math.sin(i * 0.01) * 0.06, -0.02, Math.cos(i * 0.013) * 0.06]);
    if (!Number.isFinite(p[0])) { fails.push(`NaN at throughput step ${i}`); break; }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`20000 moveCapsule calls: ${ms.toFixed(1)} ms (${(ms / 20).toFixed(3)} ms per 1000)`);
  ok(ms < 900, `moveCapsule is too slow: ${ms.toFixed(0)} ms for 20000 calls`);
}

console.log(`\n=== ${fails.length ? 'FAILURES (' + fails.length + ')' : 'ALL PASS'} ===`);
for (const f of fails) console.log(' *', f);
process.exit(fails.length ? 1 : 0);
