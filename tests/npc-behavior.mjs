// NPC behaviour: sidewalk navigation, crosswalk crossings, reactions and group panic.
//
// Self-contained: starts its own vite dev server on 8795 (so the assertions always
// run against the working tree, not a stale dist), drives the real game in headless
// Chrome and measures the numbers the acceptance criteria name:
//   a) a shot fired 12 m from a pedestrian puts >= 90% of the peds within 18 m in
//      `flee` within 2 s
//   b) 60 s of simulation with no pedestrian centre ever inside a collider taller
//      than 3 m (i.e. a building)
//   c) >= 60% of the observed road crossings happen inside a crosswalk strip
//   d) a `witness` event raises the wanted level by 1
//   e) `audit().peds` is empty (nobody floats, nobody sinks below the pavement)
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = new URL('..', import.meta.url).pathname;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const PORT = 8795;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(ROOT, 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// City spec constants: crosswalk membership is measured with the test's own maths,
// not with the pedestrian code's helper, so the result does not depend on the fix.
const PITCH = 52;
const BLOCK = 38;
const HALF_ROAD = (PITCH - BLOCK) / 2; // 7
const STRIP_DEPTH = 3.4;
const bands = [];
for (let i = -3; i < 3; i++) {
  for (let j = -3; j < 3; j++) {
    const x0 = (i + 0.5) * PITCH;
    const z0 = (j + 0.5) * PITCH;
    bands.push({ minX: x0 - HALF_ROAD, maxX: x0 + HALF_ROAD, minZ: z0 + HALF_ROAD, maxZ: z0 + HALF_ROAD + STRIP_DEPTH });
    bands.push({ minX: x0 - HALF_ROAD, maxX: x0 + HALF_ROAD, minZ: z0 - HALF_ROAD - STRIP_DEPTH, maxZ: z0 - HALF_ROAD });
    bands.push({ minX: x0 + HALF_ROAD, maxX: x0 + HALF_ROAD + STRIP_DEPTH, minZ: z0 - HALF_ROAD, maxZ: z0 + HALF_ROAD });
    bands.push({ minX: x0 - HALF_ROAD - STRIP_DEPTH, maxX: x0 - HALF_ROAD, minZ: z0 - HALF_ROAD, maxZ: z0 + HALF_ROAD });
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}

// ---------------------------------------------------------------- dev server
function waitForServer(url, timeoutMs = 30000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const retry = () => {
      if (Date.now() - startedAt > timeoutMs) reject(new Error('vite did not answer on ' + url));
      else setTimeout(tick, 200);
    };
    const tick = () => {
      http
        .get(url, (res) => {
          res.resume();
          if (res.statusCode && res.statusCode < 500) resolve(true);
          else retry();
        })
        .on('error', retry);
    };
    tick();
  });
}

let server = null;
function stopServer() {
  if (!server) return;
  try {
    server.kill('SIGTERM');
  } catch (e) {
    /* already gone */
  }
  server = null;
}

(async () => {
  server = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  await waitForServer(URL_BASE + '/index.html');
  console.log('server ' + URL_BASE);

  const b = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1500, height: 900 },
  });
  const page = await b.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  const IGNORE = /ERR_CONNECTION_RESET|ERR_SOCKET_NOT_CONNECTED|ERR_ABORTED|Failed to load resource: net::/;
  page.on('console', (m) => {
    if (m.type() === 'error' && !IGNORE.test(m.text())) errs.push('console: ' + m.text());
  });

  await page.goto(URL_BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__game !== undefined', { timeout: 60000 });
  await sleep(1200);
  await page.click('#start-btn');
  await sleep(1800);

  const boot = await page.evaluate(() => {
    const g = window.__game;
    return {
      peds: g.peds.peds.length,
      idlers: g.peds.peds.filter((p) => p.idler).length,
      paused: g.state.paused,
      buildings: g.city.colliders.filter((c) => (c.h ?? 30) > 3).length,
      strips: g.peds.strips.length,
    };
  });
  check('boot: crowd spawned and running', boot.paused === false && boot.peds > 0 && boot.peds <= 34, boot);

  // ---------------------------------------------------------------- (b) 60 s of walking
  const walk = await page.evaluate(() => {
    const g = window.__game;
    const ctx = g._test.pedContext();
    const buildings = g.city.colliders.filter((c) => (c.h ?? 30) > 3);
    const dt = 1 / 60;
    let violations = 0;
    let worst = null;
    let sawCross = 0;
    for (let s = 0; s < 3600; s++) {
      g.peds.update(dt, ctx);
      if (s % 6 !== 0) continue;
      for (const p of g.peds.peds) {
        if (p.dead) continue;
        if (p.mode === 'cross') sawCross++;
        for (const c of buildings) {
          if (p.pos.x > c.minX && p.pos.x < c.maxX && p.pos.z > c.minZ && p.pos.z < c.maxZ) {
            violations++;
            if (!worst) worst = { at: +g.peds.simTime.toFixed(1), x: +p.pos.x.toFixed(1), z: +p.pos.z.toFixed(1), state: p.state };
          }
        }
      }
    }
    const live = g.peds.peds.filter((p) => !p.dead);
    const seen = {};
    for (const p of live) seen[p.state] = (seen[p.state] || 0) + 1;
    return { simTime: +g.peds.simTime.toFixed(1), violations, worst, sawCross, states: seen, stats: { ...g.peds.stats }, peds: g.peds.peds.length };
  });
  check('60 s simulation: no ped centre inside a building', walk.violations === 0, {
    simSeconds: walk.simTime,
    violations: walk.violations,
    worst: walk.worst,
  });

  // ---------------------------------------------------------------- (c) crosswalk share
  const crossings = await page.evaluate((bandsJson) => {
    const g = window.__game;
    const bands = JSON.parse(bandsJson);
    const inBand = (x, z) => {
      for (const b of bands) if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) return true;
      return false;
    };
    const log = g.peds.crossingLog;
    let observed = 0;
    let clean = 0;
    const samples = [];
    for (const e of log) {
      if (!e.samples || !e.samples.length) continue;
      observed++;
      let on = 0;
      const total = e.samples.length / 2;
      for (let i = 0; i < e.samples.length; i += 2) if (inBand(e.samples[i], e.samples[i + 1])) on++;
      const share = on / total;
      if (share >= 0.9) clean++;
      if (samples.length < 4) samples.push({ t: e.t, share: +share.toFixed(2), pts: e.samples.slice(0, 4) });
    }
    return { observed, clean, share: observed ? +(clean / observed).toFixed(3) : 0, stats: { ...g.peds.stats }, samples };
  }, JSON.stringify(bands));
  check('crossings: >=60% inside a crosswalk strip', crossings.observed > 0 && crossings.share >= 0.6, crossings);

  // ---------------------------------------------------------------- crossing screenshot
  let crossShot = null;
  for (let attempt = 0; attempt < 3 && !crossShot; attempt++) {
    crossShot = await page.evaluate(() => {
      const g = window.__game;
      const ctx = g._test.pedContext();
      const dt = 1 / 60;
      for (let s = 0; s < 4000; s++) {
        g.peds.update(dt, ctx);
        if (s % 4 !== 0) continue;
        for (const p of g.peds.peds) {
          if (p.dead || p.mode !== 'cross' || p.waiting) continue;
          if (g.city.groundHeightAt(p.pos.x, p.pos.z) > 0.1) continue; // must be on the asphalt
          if (p.crossT < 1.2) continue;
          return { x: p.pos.x, z: p.pos.z, dx: p.crossDx, dz: p.crossDz, state: p.state };
        }
      }
      return null;
    });
  }
  check('a pedestrian is caught mid-crossing for the screenshot', !!crossShot, crossShot);
  if (crossShot) {
    const camX = crossShot.x - crossShot.dz * 9 - crossShot.dx * 5;
    const camZ = crossShot.z + crossShot.dx * 9 - crossShot.dz * 5;
    crossShot.framing = await page.evaluate((c) => {
      const g = window.__game;
      g._test.lookFrom(c.camX, 3.6, c.camZ, c.x + c.dx * 3, 1.0, c.z + c.dz * 3);
      const cam = g.camera;
      cam.updateMatrixWorld(true);
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
      const w = window.innerWidth;
      const h = window.innerHeight;
      const v = cam.position.clone();
      const out = [];
      for (const p of g.peds.peds) {
        if (p.dead) continue;
        if (Math.hypot(p.pos.x - c.x, p.pos.z - c.z) > 4) continue;
        v.set(p.pos.x, p.pos.y, p.pos.z);
        v.project(cam);
        const feet = Math.round((-v.y * 0.5 + 0.5) * h);
        const sx = Math.round((v.x * 0.5 + 0.5) * w);
        v.set(p.pos.x, p.pos.y + 1.84 * p.char.scale, p.pos.z);
        v.project(cam);
        const head = Math.round((-v.y * 0.5 + 0.5) * h);
        out.push({ x: sx, feet, px: Math.abs(feet - head) });
      }
      return { viewport: [w, h], peds: out };
    }, { camX, camZ, x: crossShot.x, z: crossShot.z, dx: crossShot.dx, dz: crossShot.dz });
    await sleep(300);
    await page.screenshot({ path: path.join(OUT, 'npc-cross.png') });
  }

  // ---------------------------------------------------------------- (a) gunshot panic
  // The victim is put on the camera's actual sight line a frame before the trigger
  // pull, so the 12 m shot lands on it instead of depending on the shoulder offset.
  // A busy stretch of street: eleven bystanders inside 18 m (all off the sight line)
  // plus the victim, which is placed on the camera axis just before the shot.
  const FIXTURE = [
    [21.5, -6],
    [30.5, -6],
    [21.5, -11],
    [30.5, -11],
    [21.5, -16],
    [30.5, -16],
    [24, -5],
    [28, -5],
    [24, -17.5],
    [28, -17.5],
    [23, -13],
    [20.5, -8],
    [31.5, -8],
  ];

  let flee = null;
  for (let attempt = 0; attempt < 3 && !(flee && flee.ok); attempt++) {
    flee = await page.evaluate(async (fixture) => {
      const g = window.__game;
      // clear the street of vehicles so nothing eats the bullet
      for (const e of g.traffic.cars) {
        e.car.pos.set(240, 0, 240);
        e.car.mesh.position.copy(e.car.pos);
      }
      for (const c of g.cityCars) {
        c.pos.set(250, 0, 250);
        c.mesh.position.copy(c.pos);
      }
      g.police.clearWanted();
      g._test.cinematic(false);
      g._test.teleport(26, 0);
      g._test.setCam(0, 0.02); // camera behind the player, looking down -z
      g.player.mag = g.player.magSize;
      g.player.shootCd = 0;
      g.player.reloading = 0;

      const reset = (p, x, z, speed) => {
        p.pos.set(x, g.city.groundHeightAt(x, z), z);
        p.char.group.position.copy(p.pos);
        p.fleeTimer = 0;
        p.witnessTimer = 0;
        p.cowerTimer = 0;
        p.cowerCd = 0;
        p.idleTimer = 0;
        p.state = 'walk';
        p.mode = 'walk';
        p.waiting = false;
        p.speed = speed;
        p.repath();
        p.__fixture = true;
      };

      const alive = g.peds.peds.filter((p) => !p.dead);
      for (let i = 0; i < fixture.length && i < alive.length; i++) {
        reset(alive[i], fixture[i][0], fixture[i][1], alive[i].walkSpeed);
      }
      await new Promise((r) => setTimeout(r, 400)); // let the camera settle behind the player

      const camPos = g.camera.position;
      const fwd = g.camera.getWorldDirection(g.player.pos.clone());
      const t = 17.8;
      const victim = g.peds.peds.filter((p) => !p.dead && !p.__fixture)[0];
      const vx = camPos.x + fwd.x * t;
      const vz = camPos.z + fwd.z * t;
      reset(victim, vx, vz, 0.0001); // pinned on the sight line

      const shotAt = { x: g.player.pos.x, z: g.player.pos.z };
      const watch = [];
      for (const p of g.peds.peds) {
        if (!p.__fixture) continue;
        watch.push({ ped: p, d: Math.hypot(p.pos.x - shotAt.x, p.pos.z - shotAt.z), victim: p === victim });
      }
      // the shot itself: a real trigger pull down the camera axis
      g._test.shoot();
      const last = window.__lastShot;
      const t0 = performance.now();
      let fled = 0;
      let counted = 0;
      while (performance.now() - t0 < 2000) {
        await new Promise((r) => setTimeout(r, 100));
        fled = 0;
        counted = 0;
        for (const w of watch) {
          if (w.victim || w.d > 18) continue;
          if (w.ped.dead) continue;
          counted++;
          if (w.ped.state === 'flee') fled++;
        }
        if (counted > 0 && fled / counted >= 0.9) break;
      }
      return {
        hitKind: last && last.hitKind,
        victimDistance: last ? +Math.hypot(last.hitPoint[0] - shotAt.x, last.hitPoint[2] - shotAt.z).toFixed(2) : null,
        fled,
        counted,
        share: counted ? +(fled / counted).toFixed(3) : 0,
        states: g.peds.peds.filter((p) => p.__fixture && !p.dead).map((p) => p.state),
      };
    }, FIXTURE);
    flee.ok = flee.hitKind === 'ped' && flee.counted > 0 && flee.share >= 0.9;
    if (!flee.ok) console.log('  retry: shot did not land on the fixture ped', JSON.stringify(flee));
  }
  check('gunshot: >=90% of peds within 18 m flee within 2 s', flee && flee.ok, {
    fled: flee?.fled,
    counted: flee?.counted,
    share: flee?.share,
    hitKind: flee?.hitKind,
    victimDistance: flee?.victimDistance,
    states: flee?.states,
  });

  // Flee screenshot: a second, tighter scare so the hands-up pose fills the frame.
  // Five people stand in front of the player, one real trigger pull, then the camera
  // is placed 5.5 m from the running group.
  const fleeShot = await page.evaluate(async () => {
    const g = window.__game;
    g.police.clearWanted();
    g._test.cinematic(false);
    g._test.teleport(26, 0);
    g._test.setCam(0, 0.02);
    g.player.mag = g.player.magSize;
    g.player.shootCd = 0;
    g.player.reloading = 0;
    const spots = [
      [24.6, -5.4],
      [27.4, -5.2],
      [23.2, -7.6],
      [28.8, -7.4],
      [26, -9.4],
    ];
    const alive = g.peds.peds.filter((p) => !p.dead);
    for (let i = 0; i < spots.length && i < alive.length; i++) {
      const p = alive[i];
      const [x, z] = spots[i];
      p.pos.set(x, g.city.groundHeightAt(x, z), z);
      p.char.group.position.copy(p.pos);
      p.fleeTimer = 0;
      p.witnessTimer = 0;
      p.cowerTimer = 0;
      p.cowerCd = 0;
      p.idleTimer = 0;
      p.state = 'walk';
      p.mode = 'walk';
      p.waiting = false;
      p.speed = p.walkSpeed;
      p.repath();
      p.__shot = true;
    }
    await new Promise((r) => setTimeout(r, 400));
    g._test.shoot();
    await new Promise((r) => setTimeout(r, 650));
    let sx = 0;
    let sz = 0;
    let n = 0;
    for (const p of g.peds.peds) {
      if (!p.__shot || p.dead || p.state !== 'flee') continue;
      sx += p.pos.x;
      sz += p.pos.z;
      n++;
    }
    if (!n) return null;
    const cx = sx / n;
    const cz = sz / n;
    // three-quarter front view: the crowd runs away from the shooter, toward this camera
    g._test.lookFrom(cx - 3.9, 2.4, cz - 3.6, cx, 1.05, cz);
    const cam = g.camera;
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const w = window.innerWidth;
    const h = window.innerHeight;
    const v = cam.position.clone();
    const framed = [];
    for (const p of g.peds.peds) {
      if (!p.__shot || p.dead || p.state !== 'flee') continue;
      v.set(p.pos.x, p.pos.y, p.pos.z);
      v.project(cam);
      const feet = Math.round((-v.y * 0.5 + 0.5) * h);
      const sx = Math.round((v.x * 0.5 + 0.5) * w);
      v.set(p.pos.x, p.pos.y + 1.84 * p.char.scale, p.pos.z);
      v.project(cam);
      const head = Math.round((-v.y * 0.5 + 0.5) * h);
      framed.push({ x: sx, feet, px: Math.abs(feet - head) });
    }
    return { n, cx: +cx.toFixed(1), cz: +cz.toFixed(1), states: g.peds.peds.filter((p) => p.__shot).map((p) => p.state), viewport: [w, h], framed };
  });
  await sleep(80);
  await page.screenshot({ path: path.join(OUT, 'npc-flee.png') });
  console.log('FLEE_SHOT ' + JSON.stringify(fleeShot));
  const fleeFramed = (fleeShot?.framed || []).filter((f) => f.px >= 120 && f.x > 0 && f.x < 1500 && f.feet > 0 && f.feet < 900);
  check('flee screenshot: >=3 fleeing peds on screen at readable size', fleeFramed.length >= 3, { onScreen: fleeFramed.length, framed: fleeShot?.framed });
  const crossFramed = (crossShot?.framing?.peds || []).filter((f) => f.px >= 120 && f.x > 0 && f.x < 1500 && f.feet > 0 && f.feet < 900);
  check('cross screenshot: the crossing ped is on screen at readable size', crossFramed.length >= 1, crossShot?.framing);

  // ---------------------------------------------------------------- (d) witness raises wanted
  const witness = await page.evaluate(async () => {
    const g = window.__game;
    g._test.cinematic(false);
    g.police.clearWanted();
    g._test.teleport(26, 0);
    g._test.setCam(0, 0.02);
    g.player.mag = g.player.magSize;
    g.player.shootCd = 0;
    g.player.reloading = 0;
    for (const e of g.traffic.cars) {
      e.car.pos.set(240, 0, 240);
      e.car.mesh.position.copy(e.car.pos);
    }
    for (const c of g.cityCars) {
      c.pos.set(250, 0, 250);
      c.mesh.position.copy(c.pos);
    }
    const reset = (p, x, z, speed) => {
      p.pos.set(x, g.city.groundHeightAt(x, z), z);
      p.char.group.position.copy(p.pos);
      p.fleeTimer = 0;
      p.witnessTimer = 0;
      p.cowerTimer = 0;
      p.cowerCd = 0;
      p.witnessFired = false;
      p.idleTimer = 0;
      p.state = 'walk';
      p.mode = 'walk';
      p.waiting = false;
      p.speed = speed;
      p.repath();
      p.__witnessFixture = true;
    };
    // four bystanders around the shooter, then one victim on the sight line
    const fixture = [
      [21.5, -8],
      [30.5, -9],
      [22.5, -14],
      [29.5, -14.5],
    ];
    const alive = g.peds.peds.filter((p) => !p.dead);
    for (let i = 0; i < fixture.length && i < alive.length; i++) {
      reset(alive[i], fixture[i][0], fixture[i][1], alive[i].walkSpeed);
    }
    await new Promise((r) => setTimeout(r, 400));
    const camPos = g.camera.position;
    const fwd = g.camera.getWorldDirection(g.player.pos.clone());
    const victim = g.peds.peds.filter((p) => !p.dead && !p.__witnessFixture)[0];
    reset(victim, camPos.x + fwd.x * 17.8, camPos.z + fwd.z * 17.8, 0.0001);

    const before = g.police.wanted;
    const beforeStats = { ...g.peds.stats };
    const nearby = g.peds.peds.filter((p) => !p.dead && p.pos.distanceTo(g.player.pos) < 18).length;
    g._test.shoot();
    const shot = window.__lastShot;
    await new Promise((r) => setTimeout(r, 900));
    const witnessPed = g.peds.peds.find((p) => !p.dead && p.state === 'witness');
    return {
      before: +before.toFixed(2),
      after: +g.police.wanted.toFixed(2),
      delta: +(g.police.wanted - before).toFixed(2),
      hitKind: shot && shot.hitKind,
      nearby,
      witnesses: g.peds.peds.filter((p) => !p.dead && p.state === 'witness').length,
      witnessRunsForCops: witnessPed ? witnessPed.witnessTimer > 0 : false,
      witnessEvents: g.peds.stats.witnessEvents - beforeStats.witnessEvents,
      witnessWanted: g.peds.stats.witnessWanted - beforeStats.witnessWanted,
      cops: g.police.cars.length,
    };
  });
  check(
    'witness: seeing a murder raises wanted by 1',
    witness.hitKind === 'ped' && witness.witnessEvents >= 1 && witness.witnessWanted >= 1 && witness.delta >= 1 && witness.nearby >= 5 && witness.witnesses >= 1,
    witness
  );

  // ---------------------------------------------------------------- (e) nobody floats or sinks
  await sleep(1200);
  const audit = await page.evaluate(() => window.__game._test.audit());
  check('audit: no pedestrian floating or below ground', audit.peds.length === 0, audit.peds.slice(0, 4));

  // ---------------------------------------------------------------- extras
  const idle = await page.evaluate(() => {
    const g = window.__game;
    const live = g.peds.peds.filter((p) => !p.dead);
    return { idlers: live.filter((p) => p.idler).length, live: live.length, states: live.reduce((acc, p) => ((acc[p.state] = (acc[p.state] || 0) + 1), acc), {}) };
  });
  check('idle life exists (8% of the crowd idles)', idle.idlers >= 1 && idle.idlers / idle.live < 0.2, idle);

  const states = await page.evaluate(() => {
    const g = window.__game;
    const live = g.peds.peds.filter((p) => !p.dead);
    const seen = {};
    for (const p of live) seen[p.state] = (seen[p.state] || 0) + 1;
    return { seen, pairs: g.peds.pairs, strips: g.peds.strips.length, crossingStats: { ...g.peds.stats }, calls: g.state.calls };
  });
  console.log('STATES ' + JSON.stringify(states));
  check('walk state still populated after the walk phase', (walk.states.walk || 0) > 0, walk.states);
  check('perf: draw calls under the existing 1600 budget', Number(states.calls) < 1600, { calls: states.calls });

  check('no console/page errors', errs.length === 0, errs.slice(0, 5));

  const numbers = {
    fleeShare: flee?.share,
    fleeFled: flee?.fled,
    fleeCounted: flee?.counted,
    buildingViolations: walk.violations,
    simSeconds: walk.simTime,
    crossingsObserved: crossings.observed,
    crossingsOnStrip: crossings.clean,
    crossingShare: crossings.share,
    witnessDelta: witness.delta,
    witnessWanted: witness.witnessWanted,
    auditPeds: audit.peds.length,
  };
  console.log('NUMBERS ' + JSON.stringify(numbers));
  console.log('SUMMARY ' + JSON.stringify({ pass: results.filter((r) => r.ok).length, total: results.length }));
  console.log('FAILED ' + JSON.stringify(results.filter((r) => !r.ok)));
  await b.close();
  stopServer();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})().catch((e) => {
  console.error('HARNESS FAIL', e.message);
  stopServer();
  process.exit(1);
});

process.on('exit', stopServer);
process.on('SIGINT', () => {
  stopServer();
  process.exit(130);
});
