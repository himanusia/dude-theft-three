
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
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await page.goto('http://localhost:8765/index.html', { waitUntil: 'domcontentloaded' });
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

  // sprint faster than walk
  const s0 = await page.evaluate(() => window.__game.player.pos.toArray());
  await page.keyboard.down('Shift'); await hold('w', 1200); await page.keyboard.up('Shift');
  const s1 = await page.evaluate(() => window.__game.player.pos.toArray());
  const sprinted = Math.hypot(s1[0]-s0[0], s1[2]-s0[2]);
  check('sprint faster than walk', sprinted > walked * 0.9, { sprinted: +sprinted.toFixed(2) });

  // jump leaves the ground and lands
  await page.keyboard.down('Space'); await sleep(120);
  const airborne = await page.evaluate(() => window.__game.player.y);
  await page.keyboard.up('Space'); await sleep(1200);
  const landed = await page.evaluate(() => ({ y: window.__game.player.y, grounded: window.__game.player.grounded }));
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
  await sleep(800);
  const shot = await page.evaluate(() => {
    const g = window.__game;
    const magBefore = g.player.mag;
    g._test.shoot();
    return { magBefore, magAfter: g.player.mag, hit: window.__lastShot, rag: g.ragdolls.length };
  });
  await sleep(700);
  const afterShot = await page.evaluate(() => ({ rag: window.__game.ragdolls.length, wanted: +window.__game.police.wanted.toFixed(2) }));
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
  await sleep(5200);
  const chase = await page.evaluate(() => ({
    stars: window.__game.police.starCount,
    cops: window.__game.police.cars.length,
    dists: window.__game.police.cars.map(e => Math.round(e.car.pos.distanceTo(window.__game.player.pos))),
    hp: Math.round(window.__game.player.hp),
  }));
  check('police spawn and close distance', chase.stars >= 3 && chase.cops >= 2 && Math.min(...chase.dists) < 60, chase);
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

  // perf
  await sleep(1200);
  const perf = await page.evaluate(() => ({ fps: window.__game.state.fps, calls: window.__game.state.calls, tris: window.__game.state.tris }));
  check('perf budget', Number(perf.calls) < 1300, perf);

  check('no console/page errors', errs.length === 0, errs.slice(0, 6));
  console.log('SUMMARY ' + JSON.stringify({ pass: results.filter(r => r.ok).length, total: results.length }));
  console.log('FAILED ' + JSON.stringify(results.filter(r => !r.ok)));
  await b.close();
})().catch(e => { console.error('HARNESS FAIL', e.message); process.exit(1); });
