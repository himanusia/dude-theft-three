/**
 * Measurement library for the TransJakarta / traffic card.
 *
 * Everything here is measured from the running page, not from the source: triangle and
 * draw-call counts come from `renderer.info`, the bus overlap report from the geometry the
 * builder actually produced (with `audit: true`), and the vehicle count from driving the real
 * `Traffic.update` in the real game loop and watching the cars cross a fixed point.
 *
 * Used by `tools/measure-tj.mjs` (before/after numbers) and `tests/world/tj.mjs` (the gate).
 */
import puppeteer from 'puppeteer-core';

export const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

/** Boot the game, start it, and hand back the page. */
export async function bootGame(base, { width = 900, height = 560, viewportScale = 1 } = {}) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
    defaultViewport: { width, height, deviceScaleFactor: viewportScale },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction('window.__game !== undefined', { timeout: 180000 });
  await page.click('#start-btn');
  await new Promise((r) => setTimeout(r, 2500));
  return { browser, page, errors };
}

/**
 * Measure the bus on its own: triangles, draw calls, and every pair of parts that puts two
 * faces on the same plane facing the same way (z-fighting) or back to back (a hidden seam).
 */
export async function measureBus(page) {
  return page.evaluate(async () => {
    const g = window.__game;
    const THREE = g.THREE;
    const Bus = g._test.busClass;
    if (!Bus) throw new Error('window.__game._test.busClass is missing: cannot audit the bus');
    const bus = new Bus({ audit: true, blob: false });
    const scene = new THREE.Scene();
    scene.add(bus.group);
    const cam = new THREE.PerspectiveCamera(38, 16 / 10, 0.1, 400);
    cam.position.set(13.5, 6.2, 15.5);
    cam.lookAt(0, 1.55, 0.4);
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setPixelRatio(1);
    renderer.setSize(320, 200);
    renderer.render(scene, cam);
    const info = renderer.info.render;
    let meshes = 0;
    bus.group.traverse((o) => {
      if (o.isMesh) meshes++;
    });
    const stats = { triangles: info.triangles, calls: info.calls, meshes };

    // ---- overlap audit ---------------------------------------------------------------------
    const EPS_PLANE = 5e-4;   // 0.5 mm: two faces closer than this are the same plane
    const MIN_AREA = 1e-4;    // 1 cm^2: below this a shared edge is not an overlap
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const norm = (v) => {
      const l = Math.hypot(v[0], v[1], v[2]) || 1;
      return [v[0] / l, v[1] / l, v[2] / l];
    };

    const tris = [];
    for (const part of bus.parts) {
      const pos = part.geometry.attributes.position.array;
      const m = part.matrix ? part.matrix.elements : null;
      const pt = (i) => {
        const x = pos[i], y = pos[i + 1], z = pos[i + 2];
        if (!m) return [x, y, z];
        return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
      };
      for (let i = 0; i + 8 < pos.length; i += 9) {
        const a = pt(i), b = pt(i + 3), c = pt(i + 6);
        const n = cross(sub(b, a), sub(c, a));
        if (Math.hypot(n[0], n[1], n[2]) < 1e-9) continue;
        const nn = norm(n);
        const min = [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.min(a[2], b[2], c[2])];
        const max = [Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1]), Math.max(a[2], b[2], c[2])];
        tris.push({ part: part.label, tag: part.tag, bucket: part.bucket, a, b, c, n: nn, d: dot(nn, a), min, max });
      }
    }

    // clip polygon `poly` (list of [u,v]) against the convex triangle `clip`
    const clipPoly = (poly, clip) => {
      let out = poly;
      for (let i = 0; i < 3 && out.length; i++) {
        const p1 = clip[i];
        const p2 = clip[(i + 1) % 3];
        const ex = p2[0] - p1[0];
        const ey = p2[1] - p1[1];
        const side = (p) => ex * (p[1] - p1[1]) - ey * (p[0] - p1[0]);
        const next = [];
        for (let k = 0; k < out.length; k++) {
          const cur = out[k];
          const prev = out[(k + out.length - 1) % out.length];
          const sc = side(cur);
          const sp = side(prev);
          if (sc >= 0) {
            if (sp < 0) {
              const t = sp / (sp - sc);
              next.push([prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t]);
            }
            next.push(cur);
          } else if (sp >= 0) {
            const t = sp / (sp - sc);
            next.push([prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t]);
          }
        }
        out = next;
      }
      return out;
    };
    const area2 = (poly) => {
      let s = 0;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        s += a[0] * b[1] - b[0] * a[1];
      }
      return Math.abs(s) / 2;
    };

    const found = new Map();
    for (let i = 0; i < tris.length; i++) {
      const t1 = tris[i];
      for (let j = i + 1; j < tris.length; j++) {
        const t2 = tris[j];
        if (t1.part === t2.part) continue;
        // cheap reject
        if (t1.max[0] < t2.min[0] - EPS_PLANE || t2.max[0] < t1.min[0] - EPS_PLANE) continue;
        if (t1.max[1] < t2.min[1] - EPS_PLANE || t2.max[1] < t1.min[1] - EPS_PLANE) continue;
        if (t1.max[2] < t2.min[2] - EPS_PLANE || t2.max[2] < t1.min[2] - EPS_PLANE) continue;
        const facing = dot(t1.n, t2.n);
        if (Math.abs(facing) < 0.9999) continue;                         // not parallel
        const off = dot(t1.n, sub(t2.a, t1.a));
        if (Math.abs(off) > EPS_PLANE) continue;                          // not coplanar
        // project onto t1's plane basis
        const u = norm(sub(t1.b, t1.a));
        const v = cross(t1.n, u);
        const p2d = (p) => [dot(sub(p, t1.a), u), dot(sub(p, t1.a), v)];
        const tri1 = [p2d(t1.a), p2d(t1.b), p2d(t1.c)];
        const tri2 = [p2d(t2.a), p2d(t2.b), p2d(t2.c)];
        const clipped = clipPoly(tri2, tri1);
        const area = clipped.length >= 3 ? area2(clipped) : 0;
        if (area < MIN_AREA) continue;
        const kind = facing > 0 ? 'fight' : 'seam';
        const key = `${t1.part}|${t2.part}|${kind}`;
        const prev = found.get(key);
        if (!prev) {
          found.set(key, {
            a: t1.part, b: t2.part, aTag: t1.tag, bTag: t2.tag, kind,
            overlaps: 1, area: area,
            plane: t1.n.map((n) => +n.toFixed(3)),
            at: [+t1.a[0].toFixed(3), +t1.a[1].toFixed(3), +t1.a[2].toFixed(3)],
          });
        } else {
          prev.overlaps++;
          if (area > prev.area) {
            prev.area = area;
            prev.plane = t1.n.map((n) => +n.toFixed(3));
            prev.at = [+t1.a[0].toFixed(3), +t1.a[1].toFixed(3), +t1.a[2].toFixed(3)];
          }
        }
      }
    }
    const pairs = [...found.values()]
      .map((p) => ({ ...p, area: +p.area.toFixed(5) }))
      .sort((x, y) => y.area - x.area);
    const fights = pairs.filter((p) => p.kind === 'fight');
    const seams = pairs.filter((p) => p.kind === 'seam');

    renderer.dispose();
    bus.dispose();

    return {
      stats,
      trianglesPerBus: stats.triangles,
      drawsPerBus: stats.calls,
      parts: bus.parts.length,
      triangles: tris.length,
      fights: fights.length,
      fightArea: +fights.reduce((s, p) => s + p.area, 0).toFixed(4),
      seams: seams.length,
      pairs,
    };
  });
}

/** The junction of two arterial polylines, solved in world space. */
export async function junctionOf(page, a = 0, b = 1) {
  return page.evaluate(
    ({ a, b }) => {
      const roads = window.__game.jakartaMap.ARTERIALS;
      const A = roads[a].path;
      const B = roads[b].path;
      for (let i = 0; i < A.length - 1; i++) {
        for (let j = 0; j < B.length - 1; j++) {
          const [x1, z1] = A[i], [x2, z2] = A[i + 1];
          const [x3, z3] = B[j], [x4, z4] = B[j + 1];
          const den = (x2 - x1) * (z4 - z3) - (z2 - z1) * (x4 - x3);
          if (Math.abs(den) < 1e-9) continue;
          const t = ((x3 - x1) * (z4 - z3) - (z3 - z1) * (x4 - x3)) / den;
          const u = ((x3 - x1) * (z2 - z1) - (z3 - z1) * (x2 - x1)) / den;
          if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
            return { name: `${roads[a].name} x ${roads[b].name}`, x: x1 + (x2 - x1) * t, z: z1 + (z2 - z1) * t };
          }
        }
      }
      return null;
    },
    { a, b }
  );
}

/**
 * Stand the player 18 m off a junction and count how many vehicles cross a 15 m circle around
 * it, over `seconds` of simulated time. Returns the count, the crossing list, and how long the
 * player waited for the first one.
 */
export async function measureCrossings(page, { seconds = 30, radius = 15, standOff = 18, wallCapMs = 260000 } = {}) {
  const junction = await junctionOf(page);
  if (!junction) throw new Error('no arterial junction found from the map');
  const placed = await page.evaluate(
    ({ jx, jz, standOff }) => {
      const g = window.__game;
      // a spot on the pavement near the junction: not on a carriageway, not inside a solid
      let best = null;
      for (let ring = 0; ring < 8 && !best; ring++) {
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          const x = jx + Math.cos(a) * (standOff + ring * 4);
          const z = jz + Math.sin(a) * (standOff + ring * 4);
          if (g.city.onAnyRoad(x, z, 1)) continue;
          const solid = g.city.colliders.some((c) => x > c.minX - 1 && x < c.maxX + 1 && z > c.minZ - 1 && z < c.maxZ + 1);
          if (solid) continue;
          best = { x, z };
          break;
        }
      }
      if (!best) best = { x: jx + standOff, z: jz + standOff };
      g._test.teleport(best.x, best.z);
      g._test.face(jx, jz);
      return { x: +best.x.toFixed(1), z: +best.z.toFixed(1) };
    },
    { jx: junction.x, jz: junction.z, standOff }
  );

  const result = await page.evaluate(
    ({ jx, jz, radius, seconds, wallCapMs }) =>
      new Promise((resolve) => {
        const g = window.__game;
        const seen = new Map();
        const crossings = [];
        const busCrossings = [];
        const t0 = performance.now();
        const startSim = g.state.simTime;
        let firstAt = null;
        const inside = (p) => Math.hypot(p.x - jx, p.z - jz) <= radius;
        let prevCars = g.traffic.cars.map((e) => inside(e.car.pos));
        const tjBuses = g.tj ? g.tj.buses : [];
        let prevBuses = tjBuses.map((b) => inside(b.group.position));
        const speedSeen = new Map();
        function frame() {
          const sim = g.state.simTime - startSim;
          const cars = g.traffic.cars;
          for (let i = 0; i < cars.length; i++) {
            const car = cars[i].car;
            const now = inside(car.pos);
            if (now && !prevCars[i]) {
              const key = `${cars[i].car.type}@${Math.round(car.pos.x)},${Math.round(car.pos.z)}`;
              if (!seen.has(key)) {
                seen.set(key, true);
                crossings.push({ type: cars[i].car.type, speed: +Math.abs(car.speed).toFixed(1), sim: +sim.toFixed(1) });
                speedSeen.set(cars[i].car.type, (speedSeen.get(cars[i].car.type) || 0) + 1);
                if (firstAt === null) firstAt = sim;
              }
            }
            prevCars[i] = now;
          }
          const buses = tjBuses;
          for (let i = 0; i < buses.length; i++) {
            const now = inside(buses[i].group.position);
            if (now && !prevBuses[i]) busCrossings.push({ bus: i, sim: +sim.toFixed(1) });
            prevBuses[i] = now;
          }
          if (sim >= seconds) {
            resolve({
              simSeconds: +sim.toFixed(2),
              wallSeconds: +((performance.now() - t0) / 1000).toFixed(1),
              cars: crossings.length,
              crossings,
              firstAt: firstAt === null ? null : +firstAt.toFixed(1),
              buses: busCrossings.length,
              busCrossings,
              fps: g.state.fps,
              carsInScene: g.traffic.cars.length,
              // how much of the local population is actually rolling, and how much is stuck
              nearby: g.traffic.cars.filter((e) => e.car.pos.distanceTo(g.player.pos) < 120).length,
              stoppedNearby: g.traffic.cars.filter((e) => e.car.pos.distanceTo(g.player.pos) < 120 && Math.abs(e.car.speed) < 0.5).length,
            });
            return;
          }
          if (performance.now() - t0 > wallCapMs) {
            resolve({ simSeconds: +sim.toFixed(2), aborted: 'wall cap', cars: crossings.length, crossings, firstAt, buses: busCrossings.length });
            return;
          }
          requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
      }),
    { jx: junction.x, jz: junction.z, radius, seconds, wallCapMs }
  );

  return { junction, stand: placed, ...result };
}

/** Where the buses are, whether they are moving, and how far they sit off the loop. */
export async function measureService(page) {
  const before = await page.evaluate(() => {
    const g = window.__game;
    if (!g.tj) return null;
    const running = new Set(g.tj.buses.map((b) => b.group.uuid));
    const parked = [];
    g.scene.traverse((o) => {
      if (o.name !== 'transjakarta-bus' || running.has(o.uuid)) return;
      const p = o.getWorldPosition(new g.THREE.Vector3());
      const near = g.tj.nearest(p.x, p.z);
      parked.push({ x: +p.x.toFixed(1), z: +p.z.toFixed(1), offLoop: +near.distance.toFixed(2) });
    });
    return {
      count: g.tj.buses.length,
      routeLength: +g.tj.route.length,
      loopMetres: +g.tj.total?.toFixed?.(1) || null,
      positions: g.tj.buses.map((b) => b.group.position.toArray().map((n) => +n.toFixed(2))),
      offLoop: g.tj.buses.map((b) => +g.tj.nearest(b.group.position.x, b.group.position.z).distance.toFixed(3)),
      onRoad: g.tj.buses.map((b) => g.city.onAnyRoad(b.group.position.x, b.group.position.z, 0)),
      visible: g.tj.buses.map((b) => b.group.visible),
      parked,
    };
  });
  if (!before) return null;
  await new Promise((r) => setTimeout(r, 6000));
  const after = await page.evaluate(() => {
    const g = window.__game;
    return {
      positions: g.tj.buses.map((b) => b.group.position.toArray().map((n) => +n.toFixed(2))),
      wheels: g.tj.buses.map((b) => +b.wheels[0].pivot.rotation.x.toFixed(2)),
    };
  });
  const travelled = before.positions.map((p, i) => +Math.hypot(after.positions[i][0] - p[0], after.positions[i][2] - p[2]).toFixed(2));
  const moved = travelled.map((d) => d > 8);
  return { ...before, after: after.positions, travelled, moved, wheels: after.wheels, inService: moved.filter(Boolean).length };
}
