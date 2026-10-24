
// Solid-landmark acceptance: walk the player at the pos ronda, the terminal shelter and a berthed
// TransJakarta, and report how close the body gets to the drawn surface before the object stops it.
//
// Why the closest approach rather than "the body froze": the collision resolver slides a body along
// a face, and a wall that is not square to the approach makes the body slide off a corner and keep
// walking. That is normal first-person behaviour; what is under test is how close the drawn object
// lets the body get. A missing collider reads as the body reaching ~0 m (or crossing the object),
// an oversized one as the body stopping 2-5 m out. So the run reports the minimum distance from the
// body to the object's own meshes over the whole walk, at the heights of a walking body, and
// separately whether the body ever stood inside the object's solid core.
//
// The core is the asset's solid part in the group's local frame: the pos ronda's raised platform,
// the terminal's boarding platform, the bus body. A body inside a core is inside the asset,
// whatever the ray says.
//
// Usage: DTA_URL=http://127.0.0.1:8765 node tests/world/colliders.mjs   (defaults to 8765)
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}

// The three landmarks, the solid core a body may not enter (local frame), and the heights the rays
// sample. A kerb a person steps over is below the lowest ray, so it cannot be mistaken for the wall
// that stops the body.
const SUBJECTS = [
  {
    key: 'ronda', name: 'pos ronda', audit: 'pos-ronda',
    // deck 0.5 m, painted kerb blocks 0.22 m: the lowest ray sees the blocks, which are the asset
    heights: [0.15, 0.3, 0.6, 0.9, 1.45],
    core: { x: 0, z: 0, hx: 2.3, hz: 1.6 },
  },
  {
    key: 'terminal', name: 'terminal shelter', audit: 'terminal',
    // apron lip 0.18 m and platform kerb 0.44 m are steps a body walks over; the queue rail, the
    // booth and the canopy stand above them
    heights: [0.5, 0.9, 1.45],
    core: { x: 0, z: -11.9, hx: 21, hz: 2.5 },
  },
  {
    key: 'bus', name: 'TransJakarta bus', audit: 'transjakarta', mesh: 'transjakarta-bus',
    heights: [0.15, 0.3, 0.6, 0.9, 1.45],
    core: { x: 0, z: 0, hx: 1.05, hz: 8.6 },
  },
];

// ---- in the page: find the landmark group, its local box, and an approach bearing on open ground
function collect(cfg) {
  const g = window.__game;
  const THREE = g.THREE;
  const audit = g.city.propAudit || [];
  const rows = audit.filter((a) => a.name === cfg.audit);
  if (!rows.length) return { error: 'no audit row ' + cfg.audit };
  const kids = g.city.group.children;
  let group = null;
  let best = Infinity;
  for (const child of kids) {
    if (!child.isGroup) continue;
    if (cfg.mesh && child.name !== cfg.mesh) continue;
    for (const row of rows) {
      const d = Math.hypot(child.position.x - row.x, child.position.z - row.z);
      if (d < best && (!cfg.mesh ? d < 0.05 : true)) { best = d; group = child; }
    }
  }
  if (!group) return { error: 'no group for ' + cfg.audit };
  group.updateMatrixWorld(true);
  const localBox = new THREE.Box3();
  {
    const inv = group.matrixWorld.clone().invert();
    const m = new THREE.Matrix4();
    group.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox.clone();
      m.multiplyMatrices(inv, o.matrixWorld);
      b.applyMatrix4(m);
      localBox.union(b);
    });
  }
  const worldBox = new THREE.Box3();
  {
    const v = new THREE.Vector3();
    for (const x of [localBox.min.x, localBox.max.x]) {
      for (const y of [localBox.min.y, localBox.max.y]) {
        for (const z of [localBox.min.z, localBox.max.z]) {
          v.set(x, y, z);
          group.localToWorld(v);
          worldBox.expandByPoint(v);
        }
      }
    }
  }
  const centre = group.localToWorld(localBox.getCenter(new THREE.Vector3()));
  const yaw = group.rotation.y;
  const colliders = g.city.colliders;
  // A collider belongs to this landmark when its centre sits in the drawn body: the object's own
  // boxes are small strips spread over the footprint, while a neighbour (a shophouse whose box
  // merely overlaps the bus) has its centre outside. Anything not own would stop the body before
  // it reaches the object under test.
  const own = (c) => {
    const cx = (c.minX + c.maxX) / 2;
    const cz = (c.minZ + c.maxZ) / 2;
    return cx > worldBox.min.x - 0.5 && cx < worldBox.max.x + 0.5
      && cz > worldBox.min.z - 0.5 && cz < worldBox.max.z + 0.5;
  };
  const blocker = (x, z, r = 0.45) => colliders.find((c) => !own(c)
    && x > c.minX - r && x < c.maxX + r && z > c.minZ - r && z < c.maxZ + r) || null;
  const halfX = Math.max(Math.abs(localBox.min.x), localBox.max.x);
  const halfZ = Math.max(Math.abs(localBox.min.z), localBox.max.z);
  const bearings = [[0, 1], [0, -1], [1, 0], [-1, 0], [0.707, 0.707], [-0.707, 0.707], [0.707, -0.707], [-0.707, -0.707]];
  for (const [lx, lz] of bearings) {
    const wx = Math.sin(yaw) * lz + Math.cos(yaw) * lx;
    const wz = Math.cos(yaw) * lz - Math.sin(yaw) * lx;
    const face = Math.min(
      Math.abs(lx) > 1e-3 ? halfX / Math.abs(lx) : Infinity,
      Math.abs(lz) > 1e-3 ? halfZ / Math.abs(lz) : Infinity,
    );
    if (!isFinite(face)) continue;
    let blocked = null;
    for (let s = face + 3; s > 1.6 && !blocked; s -= 0.5) blocked = blocker(centre.x + wx * s, centre.z + wz * s);
    if (blocked) continue;
    const id = cfg.key + '-' + group.id;
    window.__probeGroups = window.__probeGroups || {};
    window.__probeGroups[id] = group;
    return {
      id,
      bearing: [lx, lz],
      // the direction the body walks, from its start toward the object; the surface rays follow it
      // for the whole run, so crossing the object's mid-line cannot turn the measurement around
      dir: [+wx.toFixed(3), +wz.toFixed(3)],
      face: +face.toFixed(2),
      start: [+(centre.x + wx * (face + 3)).toFixed(2), +(centre.z + wz * (face + 3)).toFixed(2)],
      centre: [+centre.x.toFixed(2), +centre.z.toFixed(2)],
      localCentre: [+((localBox.min.x + localBox.max.x) / 2).toFixed(3), +((localBox.min.z + localBox.max.z) / 2).toFixed(3)],
      yaw: +yaw.toFixed(3),
      place: [+group.position.x.toFixed(2), +group.position.z.toFixed(2)],
      box: { min: localBox.min.toArray().map((n) => +n.toFixed(2)), max: localBox.max.toArray().map((n) => +n.toFixed(2)) },
      colliders: colliders.length,
    };
  }
  return { error: 'no clear approach bearing for ' + cfg.key };
}

// ---- in the page: walk in, sampling how close the body gets to the drawn meshes -----------------
function walk(args) {
  const { id, core, heights, simBudget } = args;
  const g = window.__game;
  const THREE = g.THREE;
  const group = window.__probeGroups[id];
  if (!group) return Promise.resolve({ error: 'no group ' + id });
  const plan = window.__probePlan;
  const p = g.player.pos;
  const ray = new THREE.Raycaster();
  const from = new THREE.Vector3();
  const aim = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const localOf = (x, z) => {
    const v = group.worldToLocal(tmp.set(x, g.player.y, z));
    return [v.x, v.z];
  };
  const inCore = (lx, lz) => Math.abs(lx - core.x) < core.hx && Math.abs(lz - core.z) < core.hz;
  const surfaceAt = () => {
    aim.set(-plan.dir[0], 0, -plan.dir[1]);
    let best = null;
    for (const h of heights) {
      from.set(p.x, g.player.y + h, p.z);
      ray.set(from, aim);
      ray.far = 32;
      const hit = ray.intersectObject(group, true).filter((r) => r.distance > 0.01)[0];
      if (hit && (best === null || hit.distance < best)) best = hit.distance;
    }
    return best;
  };

  g._test.teleport(plan.start[0], plan.start[1]);
  g._test.face(plan.centre[0], plan.centre[1]);
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
  const t0 = g.state.simTime;
  let minSurface = null;
  let minLocal = null;
  let minAt = null;
  let penetrated = false;
  let lastSample = -1;
  let travelled = 0;
  let lastP = [p.x, p.z];
  const trace = [];
  return new Promise((resolve) => {
    const step = () => {
      const t = g.state.simTime;
      const local = localOf(p.x, p.z);
      if (inCore(local[0], local[1])) penetrated = true;
      if (t - lastSample >= 0.08) {
        lastSample = t;
        const d = surfaceAt();
        if (d !== null && d < (minSurface === null ? Infinity : minSurface)) {
          minSurface = d;
          minLocal = [+local[0].toFixed(2), +local[1].toFixed(2)];
          minAt = +(t - t0).toFixed(2);
        }
        if (trace.length < 40) trace.push([+local[0].toFixed(2), +local[1].toFixed(2), d === null ? null : +d.toFixed(2)]);
        travelled += Math.hypot(p.x - lastP[0], p.z - lastP[1]);
        lastP = [p.x, p.z];
      }
      if (t - t0 >= simBudget) {
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));
        const end = localOf(p.x, p.z);
        resolve({
          surface: minSurface === null ? null : +minSurface.toFixed(3),
          local: minLocal,
          at: minAt,
          penetrated,
          travelled: +travelled.toFixed(2),
          endLocal: [+end[0].toFixed(2), +end[1].toFixed(2)],
          sim: +(t - t0).toFixed(2),
          trace,
        });
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

async function runSubject(page, cfg) {
  const plan = await page.evaluate(collect, cfg);
  if (plan.error) return { plan, run: { error: plan.error } };
  await page.evaluate((payload) => { window.__probePlan = payload; }, plan);
  const run = await page.evaluate(walk, { id: plan.id, core: cfg.core, heights: cfg.heights, simBudget: 9 });
  return { plan, run };
}

const b = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await b.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
try {
  await page.goto((process.env.DTA_URL || 'http://127.0.0.1:8765') + '/index.html', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction('window.__game !== undefined', { timeout: 60000 });
  await sleep(1500);
  await page.click('#start-btn');
  await sleep(2000);

  const berthed = await page.evaluate(() => {
    const g = window.__game;
    const rows = (g.city.propAudit || []).filter((a) => a.name === 'transjakarta');
    const buses = g.city.group.children.filter((c) => c.isGroup && c.name === 'transjakarta-bus');
    return {
      rows: rows.length,
      buses: buses.length,
      offsets: buses.map((bus) => {
        let best = Infinity;
        for (const row of rows) best = Math.min(best, Math.hypot(bus.position.x - row.x, bus.position.z - row.z));
        return +best.toFixed(2);
      }),
      colliders: g.city.colliders.length,
    };
  });
  console.log('BOOT', JSON.stringify(berthed));
  check('every berthed bus stands where the world placed it', berthed.buses > 0 && berthed.offsets.every((d) => d < 1.5), berthed);

  const only = process.env.ONLY;
  for (const cfg of SUBJECTS) {
    if (only && cfg.key !== only) continue;
    const { plan, run } = await runSubject(page, cfg);
    if (run.error) {
      check(cfg.name + ': the body can walk up to it and is stopped within 1.5 m', false, { plan: plan.error || plan, run });
      continue;
    }
    const ok = !run.penetrated && run.surface !== null && run.surface > 0.02 && run.surface < 1.5;
    check(cfg.name + ': the body can walk up to it and is stopped within 1.5 m', ok, {
      blockedAt: run.surface, local: run.local, afterSim: run.at, walked: run.travelled,
      walkThrough: run.penetrated, approach: plan.bearing, face: plan.face, endLocal: run.endLocal,
    });
  }

  // the bus collider has to travel with the bus, not with the halte it was parked at
  const busCfg = SUBJECTS.find((s) => s.key === 'bus');
  if (!only || only === 'bus') {
    const busPlan = await page.evaluate(collect, busCfg);
    if (busPlan.error) {
      check('the moving bus keeps its collider', false, { error: busPlan.error });
    } else {
      // Move the bus 6 m and walk at it again from a fresh approach. A 6 m shove can drop the body
      // against a shophouse on a random map, so a few directions are tried: the claim under test is
      // that the collider travels with the bus, not that this particular berth has open ground.
      const moves = [
        ['along +6', 0, 6], ['along -6', 0, -6], ['side +6', 6, 0], ['side -6', -6, 0],
      ];
      let moved = null;
      let run = { error: 'not run' };
      for (const [label, side, along] of moves) {
        moved = await page.evaluate(({ busId, side, along }) => {
          const group = window.__probeGroups[busId];
          const yaw = group.rotation.y;
          group.position.x += Math.cos(yaw) * side + Math.sin(yaw) * along;
          group.position.z += -Math.sin(yaw) * side + Math.cos(yaw) * along;
          group.updateMatrixWorld(true);
          return { how: 'move ' + (+side) + ', ' + (+along), after: [+group.position.x.toFixed(2), +group.position.z.toFixed(2)] };
        }, { busId: busPlan.id, side, along });
        await sleep(400);
        // the plan is recomputed against the bus's new place, then walked fresh
        const attempt = await runSubject(page, busCfg);
        run = attempt.run;
        if (!run.error) break;
      }
      const ok = !run.error && !run.penetrated && run.surface !== null && run.surface > 0.02 && run.surface < 1.5;
      check('the moving bus keeps its collider: the body is still stopped within 1.5 m after a move', ok, {
        moved, blockedAt: run.surface, local: run.local, walkThrough: run.penetrated, error: run.error,
        trace: ok ? undefined : run.trace,
      });
    }
  }

  check('no page errors', errs.length === 0, errs.slice(0, 4));
} catch (e) {
  check('suite ran to the end', false, { error: e.message });
} finally {
  await b.close();
}

const failed = results.filter((r) => !r.ok);
console.log('SUMMARY', JSON.stringify({ pass: results.length - failed.length, total: results.length }));
if (failed.length) process.exitCode = 1;
