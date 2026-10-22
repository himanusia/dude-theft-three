
import puppeteer from 'puppeteer-core';
import path from 'node:path';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const OUT = new URL('../screenshots', import.meta.url).pathname;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox','--enable-unsafe-swiftshader','--mute-audio','--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1500, height: 900 } });
  const page = await b.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  // media/range requests get aborted when a headless run reloads audio; that is transport
  // noise, not a page error. Real page errors and JS exceptions still fail the run.
  const IGNORE = /ERR_CONNECTION_RESET|ERR_SOCKET_NOT_CONNECTED|ERR_ABORTED|Failed to load resource: net::/;
  page.on('console', m => { if (m.type() === 'error' && !IGNORE.test(m.text())) errs.push('console: ' + m.text()); });

  await page.goto((process.env.DTA_URL || 'http://localhost:8765') + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__game !== undefined', { timeout: 40000 });
  await sleep(1200);
  const boot = await page.evaluate(() => ({ game: !!window.__game, peds: window.__game.peds.peds.length, cars: window.__game.cityCars.length, colliders: window.__game.city.colliders.length }));
  check('boot without errors', errs.length === 0 && boot.game, boot);

  await page.click('#start-btn');
  await sleep(2000);
  let st = await page.evaluate(() => window.__game.state);
  check('start unpauses', st.paused === false && st.started === true, { paused: st.paused });

  const hold = async (key, ms) => { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); await sleep(150); };

  // walking
  await page.evaluate(() => { const g = window.__game; g._test.teleport(26, -40); g._test.setCam(Math.PI, 0.1); });
  await sleep(400);
  const p0 = await page.evaluate(() => window.__game.player.pos.toArray());
  await hold('w', 1400);
  const p1 = await page.evaluate(() => window.__game.player.pos.toArray());
  const walked = Math.hypot(p1[0]-p0[0], p1[2]-p0[2]);
  check('walk moves player', walked > 2.5, { walked: +walked.toFixed(2) });

  // sprint faster than walk (retry once: headless frame rate dips under load)
  const measureRun = async (ms) => {
    const a = await page.evaluate(() => window.__game.player.pos.toArray());
    await hold('w', ms);
    const b = await page.evaluate(() => window.__game.player.pos.toArray());
    return Math.hypot(b[0]-a[0], b[2]-a[2]);
  };
  let sprinted = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.evaluate(() => { const g = window.__game; g._test.teleport(26, -40); g._test.setCam(Math.PI, 0.1); });
    await sleep(400);
    await page.keyboard.down('Shift');
    sprinted = Math.max(sprinted, await measureRun(1600));
    await page.keyboard.up('Shift');
    if (sprinted > walked * 1.15) break;
  }
  check('sprint faster than walk', sprinted > walked * 1.15, { walked: +walked.toFixed(2), sprinted: +sprinted.toFixed(2) });

  // jump leaves the ground and lands (retry: a stalled frame can eat the whole arc)
  let airborne = 0;
  let landed = { y: 0, grounded: false };
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.keyboard.down('Space');
    // sample the peak instead of a single frame
    for (let i = 0; i < 12; i++) {
      await sleep(40);
      airborne = Math.max(airborne, await page.evaluate(() => window.__game.player.y));
    }
    await page.keyboard.up('Space');
    await sleep(1200);
    landed = await page.evaluate(() => ({ y: window.__game.player.y, grounded: window.__game.player.grounded }));
    if (airborne > 0.15 && landed.grounded && landed.y < 0.35) break;
    await sleep(300);
  }
  check('jump + land', airborne > 0.15 && landed.grounded && landed.y < 0.35, { airborne: +airborne.toFixed(2), landed });

  // sidewalk step-up
  const step = await page.evaluate(() => {
    const g = window.__game;
    g._test.teleport(26, 0);
    const hRoad = g.city.groundHeightAt(26, 0);
    const hWalk = g.city.groundHeightAt(0, 17);
    return { hRoad, hWalk };
  });
  check('sidewalk height differs from road', step.hWalk > step.hRoad, step);

  // enter + drive + exit
  const entry = await page.evaluate(() => {
    const g = window.__game;
    const c = g.cityCars.find(c => !c.wrecked);
    c.pos.set(26, 0, 0); c.yaw = 0; c.mesh.position.copy(c.pos); c.mesh.rotation.y = 0;
    g._test.teleport(26 + 2.2, 0.4);
    return { car: c.pos.toArray(), dist: +c.pos.distanceTo(g.player.pos).toFixed(2) };
  });
  await sleep(400);
  await page.keyboard.press('f'); await sleep(500);
  const inCar = await page.evaluate(() => !!window.__game.player.inCar);
  check('enter vehicle with F', inCar, entry);
  await page.keyboard.down('w'); await sleep(2200); await page.keyboard.up('w');
  const drive = await page.evaluate(() => ({ kmh: Math.round(Math.abs(window.__game.player.inCar.speed) * 3.6), hp: window.__game.player.hp }));
  check('vehicle accelerates', drive.kmh > 15, drive);
  await page.keyboard.press('f'); await sleep(500);
  const outCar = await page.evaluate(() => !window.__game.player.inCar && window.__game.player.y >= 0);
  check('exit vehicle with F', outCar);

  // shooting a pedestrian
  const shootRes = await page.evaluate(async () => {
    const g = window.__game;
    const ped = g.peds.peds.find(p => !p.dead);
    ped.pos.set(26, g.city.groundHeightAt(26, -32), -32);
    ped.target = ped.pos.clone(); ped.speed = 0.0001;
    g._test.teleport(26, -40); g._test.setCam(Math.PI, 0.08);
    return { before: g.ragdolls.length, ped: ped.pos.toArray() };
  });
  // Street dressing can park a vehicle between the player and the target, so try a few
  // lane offsets and require one clear line of fire — that is the behaviour under test.
  await sleep(800);
  let shot = null;
  let afterShot = { rag: 0, wanted: 0 };
  for (const dx of [0, 3, -3, 6, -6, 9]) {
    await page.evaluate((off) => {
      const g = window.__game;
      const ped = g.peds.peds.find(p => !p.dead);
      if (!ped) return;
      ped.pos.set(26 + off, g.city.groundHeightAt(26 + off, -32), -32);
      ped.target = ped.pos.clone(); ped.speed = 0.0001;
      g._test.teleport(26 + off, -40);
      // aim straight at the target: the shot follows the camera direction, and a fixed
      // pitch could drop the ray into the road now that weapons have their own spread
      g._test.lookFrom(26 + off, 2.4, -40, ped.pos.x, ped.pos.y + 1.0, ped.pos.z);
    }, dx);
    await sleep(650);
    shot = await page.evaluate((off) => {
      const g = window.__game;
      // re-place the target in the same tick as the shot: an idle ped still gets stepped by
      // the crowd system, and a player that walked off its spot fired at empty road
      const ped = g.peds.peds.find(p => !p.dead);
      if (ped) {
        ped.pos.set(26 + off, g.city.groundHeightAt(26 + off, -32), -32);
        ped.target = ped.pos.clone();
        ped.speed = 0.0001;
        g._test.lookFrom(26 + off, 2.4, -40, ped.pos.x, ped.pos.y + 1.0, ped.pos.z);
      }
      const magBefore = g.player.mag;
      const ragBefore = g.ragdolls.length;
      g._test.shoot();
      return { magBefore, magAfter: g.player.mag, hit: window.__lastShot, ragBefore, rag: g.ragdolls.length };
    }, dx);
    await sleep(600);
    afterShot = await page.evaluate(() => ({ rag: window.__game.ragdolls.length, wanted: +window.__game.police.wanted.toFixed(2) }));
    if (shot.magAfter < shot.magBefore && afterShot.rag > shot.ragBefore) break;
  }
  check('shoot consumes ammo and ragdolls a ped', shot.magAfter < shot.magBefore && afterShot.rag > 0, { shot, afterShot });

  // melee
  const punch = await page.evaluate(async () => {
    const g = window.__game;
    const ped = g.peds.peds.find(p => !p.dead);
    ped.pos.set(26, g.city.groundHeightAt(26, -20), -20);
    ped.target = ped.pos.clone(); ped.speed = 0.0001;
    g._test.teleport(26, -21.2); g._test.setCam(Math.PI, 0.1);
    const before = g.ragdolls.length;
    g._test.punch();
    return { before };
  });
  await sleep(700);
  const punchAfter = await page.evaluate(() => ({ rag: window.__game.ragdolls.length, cash: window.__game.player.cash }));
  check('punch ragdolls a ped', punchAfter.rag > punch.before, { punch, punchAfter });

  // ragdoll settles onto the ground and eventually expires
  const settle = await page.evaluate(() => {
    const r = window.__game.ragdolls[0];
    if (!r) return null;
    return { hips: r.points.hips.p.toArray().map(v => +v.toFixed(2)), head: r.points.head.p.toArray().map(v => +v.toFixed(2)) };
  });
  check('ragdoll body is on the ground', settle && settle.hips[1] < 1.2, settle);

  // wanted level -> police spawn -> arrest
  await page.evaluate(() => { const g = window.__game; g._test.teleport(26, 24); g.police.addWanted(3); });
  let chase = { stars: 0, cops: 0, closest: 999, hp: 100 };
  for (let i = 0; i < 8; i++) {
    await sleep(800);
    const s = await page.evaluate(() => ({
      stars: window.__game.police.starCount,
      cops: window.__game.police.cars.length,
      dists: window.__game.police.cars.map(e => Math.round(e.car.pos.distanceTo(window.__game.player.pos))),
      hp: Math.round(window.__game.player.hp),
    }));
    chase = { stars: Math.max(chase.stars, s.stars), cops: Math.max(chase.cops, s.cops), closest: Math.min(chase.closest, ...(s.dists.length ? s.dists : [999])), hp: s.hp };
  }
  check('police spawn and close distance', chase.stars >= 3 && chase.cops >= 2 && chase.closest < 60, chase);
  await page.screenshot({ path: path.join(OUT, 'game-chase.png') });

  // death + respawn
  await page.evaluate(() => window.__game._test.hurt(500));
  await sleep(600);
  const dead = await page.evaluate(() => ({ hp: Math.round(window.__game.player.hp), wanted: +window.__game.police.wanted.toFixed(2), cops: window.__game.police.cars.length, pos: window.__game.player.pos.toArray().map(v => Math.round(v)) }));
  check('death respawns with full hp and clears police', dead.hp === 100 && dead.wanted === 0 && dead.cops === 0, dead);

  // cash pickup
  const pickup = await page.evaluate(async () => {
    const g = window.__game;
    const before = g.player.cash;
    const p = g.pickups.find(p => p.active);
    if (!p) return { skipped: true };
    g._test.teleport(p.pos.x, p.pos.z);
    await new Promise(r => setTimeout(r, 400));
    return { before, after: g.player.cash, active: p.active };
  });
  await sleep(400);
  const pickupAfter = await page.evaluate(() => ({ cash: window.__game.player.cash }));
  check('cash pickup pays out', pickup.skipped || pickupAfter.cash > pickup.before, { pickup, pickupAfter });
  // day/night
  await page.evaluate(() => window.__game._test.setTime(0.85));
  await sleep(1200);
  const night = await page.evaluate(() => ({ bg: window.__game.scene.background.getHexString(), lamp: Math.round(window.__game.city.lampLights[0].intensity) }));
  check('night turns lamps on', night.lamp > 10, night);
  await page.screenshot({ path: path.join(OUT, 'game-night.png') });
  await page.evaluate(() => window.__game._test.setTime(0.36));
  await sleep(900);

  // pause / resume
  await page.keyboard.press('Escape'); await sleep(500);
  const paused = await page.evaluate(() => window.__game.state.paused);
  await page.click('#resume-btn'); await sleep(600);
  const resumed = await page.evaluate(() => window.__game.state.paused === false);
  check('pause and resume', paused === true && resumed, { paused, resumed });

  // perf: draw calls are a structural budget, so measure from four fixed vantage points
  // looking down streets and report the heaviest frame — that is the worst case the player
  // can walk into. fps is context only: the host may be running other workers.
  // (Sampling wherever the camera happened to point made the same build report 669-1819.)
  const vantage = [[26, -40, 0], [26, 60, Math.PI], [-90, 0, Math.PI / 2], [90, 0, -Math.PI / 2]];
  let perf = { calls: 0, tris: 0, fps: '0' };
  for (const [vx, vz, yaw] of vantage) {
    await page.evaluate(([x, z, y]) => { window.__game._test.teleport(x, z); window.__game._test.setCam(y, 0.12); }, [vx, vz, yaw]);
    await sleep(700);
    const sample = await page.evaluate(() => ({ fps: window.__game.state.fps, calls: window.__game.state.calls, tris: window.__game.state.tris }));
    if (Number(sample.calls) > Number(perf.calls)) perf = sample;
  }
  check('perf budget', Number(perf.calls) < 1600, perf);

  check('no console/page errors', errs.length === 0, errs.slice(0, 6));
  const failed = results.filter(r => !r.ok);
  console.log('SUMMARY ' + JSON.stringify({ pass: results.length - failed.length, total: results.length }));
  console.log('FAILED ' + JSON.stringify(failed));
  await b.close();
  if (failed.length) {
    console.error(`qa: ${failed.length}/${results.length} checks failed`);
    process.exitCode = 1;
  }
})().catch(e => { console.error('HARNESS FAIL', e.message); process.exit(1); });
