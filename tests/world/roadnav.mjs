// RoadNav has to hand a driver a route, not a stub.
//
// The failure this pins down: findPath() returned two points that were both near the start
// ("drive to the corner and back"), so a police cruiser had nothing to follow and a chase could
// never close. Two separate causes produced it, and both are asserted here:
//
//   1. reconstruction through a seed node, which has no parent, collapsed the whole route;
//   2. when the target sits off the network the fallback ranked candidates by
//      cost-so-far + distance, which is dominated by the length of the route - so the winner was
//      a node next to the START instead of the road point nearest the target.
//
// The graph is built straight from the map modules with vite's SSR loader: no browser, no
// random city layout, so the numbers below are the same on every run.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_LEG = 40; // the longest single leg a caller should ever receive
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${JSON.stringify(detail)}`);
};

const server = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true }, appType: 'custom' });
const { RoadNav } = await server.ssrLoadModule('/src/core/pathfinding.ts');
const { ARTERIALS } = await server.ssrLoadModule('/src/world/jakartamap.ts');

const read = (nav, n, buf) => {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([buf[i * 2], buf[i * 2 + 1]]);
  return pts;
};
const legs = (pts) => pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
const maxLeg = (pts) => (pts.length > 1 ? Math.max(...legs(pts)) : 0);

/** Every waypoint is on asphalt, except the final leg that was verified clear to the target. */
const offRoadTail = (nav, pts, target) => {
  let cut = pts.length;
  while (cut > 1 && !nav.onRoad(pts[cut - 1][0], pts[cut - 1][1])) cut--;
  const onRoad = pts.slice(0, cut).every(([x, z]) => nav.onRoad(x, z));
  // the off-road suffix has to point straight at the target: it is the last clear leg, not a jump
  let straight = true;
  const lastOn = pts[cut - 1];
  for (let i = cut; i < pts.length; i++) {
    const seg = Math.hypot(target[0] - lastOn[0], target[1] - lastOn[1]) || 1;
    const dev =
      Math.abs((pts[i][0] - lastOn[0]) * (target[1] - lastOn[1]) - (pts[i][1] - lastOn[1]) * (target[0] - lastOn[0])) / seg;
    if (dev > 1.5) straight = false;
  }
  return { onRoad, straight, offRoad: pts.length - cut };
};

// ---------------------------------------------------------------- graph health
const nav = new RoadNav([]);
const N = nav.nodeCount;
let degreeSum = 0;
let degreeMax = 0;
let isolated = 0;
for (let i = 0; i < N; i++) {
  const d = nav.adjStart[i + 1] - nav.adjStart[i];
  degreeSum += d;
  if (d > degreeMax) degreeMax = d;
  if (d === 0) isolated++;
}
const graph = { nodes: N, edges: degreeSum / 2, avgDegree: +(degreeSum / N).toFixed(2), maxDegree: degreeMax, isolated };
check('the road graph is connected and has no dead nodes', N > 1000 && isolated === 0, graph);

// ---------------------------------------------------------------- the reported queries
// Both of these returned two points before the fix.
const buf = [];
const cardCases = [
  { from: [0, 0], to: [300, 300] },
  { from: [-200, 150], to: [400, -100] },
];
for (const c of cardCases) {
  const n = nav.findPath(c.from[0], c.from[1], c.to[0], c.to[1], buf);
  const pts = read(nav, n, buf);
  const stats = { ...nav.lastStats, shortfall: +nav.lastStats.shortfall.toFixed(1) };
  const legsOk = maxLeg(pts) <= MAX_LEG;
  const tail = offRoadTail(nav, pts, c.to);
  check(
    `route ${c.from} -> ${c.to} is a drivable path, not a two-point stub`,
    n >= 5 && legsOk,
    { points: n, maxLeg: +maxLeg(pts).toFixed(1), length: +legs(pts).reduce((a, b) => a + b, 0).toFixed(1), ...stats },
  );
  check(`route ${c.from} -> ${c.to} follows asphalt`, tail.onRoad && tail.straight, tail);
}

// ---------------------------------------------------------------- a route between two roads
// > 300 m straight line, start and target on different arterials.
const a = ARTERIALS[0].path[2]; // Thamrin-Sudirman
const b = ARTERIALS[2].path[ARTERIALS[2].path.length - 1]; // Casablanca, eastern end
const straight = Math.hypot(b[0] - a[0], b[1] - a[1]);
{
  const n = nav.findPath(a[0], a[1], b[0], b[1], buf);
  const pts = read(nav, n, buf);
  const tail = offRoadTail(nav, pts, b);
  check(
    `a ${straight.toFixed(0)} m trip between two arterials yields at least 5 waypoints, none longer than ${MAX_LEG} m`,
    straight > 300 && n >= 5 && maxLeg(pts) <= MAX_LEG,
    {
      from: [ARTERIALS[0].name, a],
      to: [ARTERIALS[2].name, b],
      straightMetres: +straight.toFixed(1),
      points: n,
      maxLeg: +maxLeg(pts).toFixed(1),
      length: +legs(pts).reduce((x, y) => x + y, 0).toFixed(1),
      followsAsphalt: tail.onRoad && tail.straight,
    },
  );
}

// ---------------------------------------------------------------- target off the network
// The live failure: the player stands inside a block, so no node has a clear final leg and the
// A* fallback decides where the route ends. Find a real block interior (a spot more than 60 m
// from any road centre-line), wall it off so the final leg is always blocked, and demand that
// the route still drives to the road point nearest the target.
{
  let target = null;
  for (let x = -400; x <= 400 && !target; x += 5) {
    for (let z = -400; z <= 400 && !target; z += 5) {
      if (nav.roadOffset(x, z) > 62) target = [x, z];
    }
  }
  const start = [-420, -260];
  const box = 40;
  const walled = new RoadNav([
    { minX: target[0] - box / 2, maxX: target[0] + box / 2, minZ: target[1] - box / 2, maxZ: target[1] + box / 2, h: 12 },
  ]);
  const n = walled.findPath(start[0], start[1], target[0], target[1], buf);
  const pts = read(walled, n, buf);
  const last = pts[pts.length - 1] ?? [NaN, NaN];
  const toTarget = Math.hypot(last[0] - target[0], last[1] - target[1]);
  const toStart = Math.hypot(last[0] - start[0], last[1] - start[1]);
  const stats = { ...walled.lastStats, shortfall: +walled.lastStats.shortfall.toFixed(1) };
  const tail = offRoadTail(walled, pts, target);
  check(
    'an unreachable target still gets a route that stops next to it, not next to the start',
    stats.goalLeg === 0 &&
      toTarget > 25 &&
      n >= 5 &&
      Math.abs(toTarget - stats.shortfall) < 1 &&
      toTarget < toStart / 2 &&
      maxLeg(pts) <= MAX_LEG,
    {
      target,
      roadOffsetAtTarget: +walled.roadOffset(target[0], target[1]).toFixed(1),
      points: n,
      maxLeg: +maxLeg(pts).toFixed(1),
      endsAt: [+last[0].toFixed(1), +last[1].toFixed(1)],
      metresToTarget: +toTarget.toFixed(1),
      metresToStart: +toStart.toFixed(1),
      ...stats,
    },
  );
  check('the route that cannot reach the target still follows asphalt', tail.onRoad, tail);
}

// ---------------------------------------------------------------- buildings on a road
// The map draws a local street wherever the block pitch puts one, and some of those streets run
// under a building (measured in the city: 12% of the road samples). The graph must not offer a
// leg through the wall: a cruiser given one drove into it and reversed forever.
{
  const wall = { minX: -18, maxX: 18, minZ: 280, maxZ: 320, h: 14 };
  const blocked = new RoadNav([wall]);
  const crosses = (x1, z1, x2, z2, b) => {
    const dx = x2 - x1;
    const dz = z2 - z1;
    let t0 = 0;
    let t1 = 1;
    for (const [d, lo, hi] of [
      [dx, b.minX - x1, b.maxX - x1],
      [dz, b.minZ - z1, b.maxZ - z1],
    ]) {
      if (Math.abs(d) < 1e-9) {
        if (lo > 0 || hi < 0) return false;
        continue;
      }
      let ta = lo / d;
      let tb = hi / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 > t1) return false;
    }
    return true;
  };
  const n = blocked.findPath(0, 0, 0, 620, buf);
  const pts = read(blocked, n, buf);
  const through = pts.slice(1).filter((p, i) => crosses(pts[i][0], pts[i][1], p[0], p[1], wall)).length;
  check(
    'a route never runs through a building that stands on the road',
    n >= 5 && through === 0,
    {
      wallOnRoad: 'Thamrin-Sudirman, z 280-320',
      points: n,
      legsThroughTheWall: through,
      pathLength: +legs(pts).reduce((a, b) => a + b, 0).toFixed(1),
      stats: { ...blocked.lastStats, shortfall: +blocked.lastStats.shortfall.toFixed(1) },
    },
  );
}

await server.close();
const pass = results.filter((r) => r.ok).length;
console.log(`SUMMARY ${JSON.stringify({ pass, total: results.length })}`);
process.exit(pass === results.length ? 0 : 1);
