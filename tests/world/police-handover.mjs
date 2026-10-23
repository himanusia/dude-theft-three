// A stolen police cruiser must answer only to the player.
//
// Owner report: after the officers bail out of the cruiser, getting in and driving feels like
// something is still fighting the steering. Cause: main.ts runs updateDriving() and then
// police.update() in the same frame, and the cruiser's AI kept writing its own steer/throttle
// into the same car a frame later.
//
// This test stages that exact sequence (spawn police, let the crew get out, player gets in),
// then holds a full right lock for 2 s of game time twice on the same cruiser:
//   - "ai"    : the owner flag is forced back to 'ai', which is the pre-fix state
//   - "player": the state main.ts now leaves behind when the player takes the wheel
// and reports the yaw change in degrees plus how many AI writes reached the car.
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL = process.env.DTA_URL || 'http://localhost:8765/';
const HOLD = 2.0; // seconds of game time the right turn is held
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, info) => {
  checks.push({ name, ok: !!ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${JSON.stringify(info)}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.bringToFront();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__game !== undefined', { timeout: 60000 });
await page.click('#start-btn');
await sleep(900);

// 1. spawn police
const heat = await page.evaluate(() => {
  const g = window.__game;
  g.police.wanted = 4;
  return { wanted: g.police.wanted, stars: g.police.starCount };
});
await sleep(2600);
const spawned = await page.evaluate(() => ({ cars: window.__game.police.cars.length }));
check('heat spawns cruisers', spawned.cars >= 1, { ...heat, ...spawned });

// 2. park one cruiser next to the player, stopped, and let the crew get out
const parked = await page.evaluate(() => {
  const g = window.__game;
  g.police.wanted = 4;
  g._test.teleport(0, 6);
  const car = g.police.cars[0].car;
  const entry = g.police.cars.find((e) => e.car === car);
  // start from a clean squad: no crew left over from the drive-by that just happened
  for (const o of [...g.police.officers]) g.police.killOfficer(o);
  entry.crew = false;
  entry.stuck = 0;
  entry.reverse = 0;
  car.pos.x = g.player.pos.x + 3.2;
  car.pos.z = g.player.pos.z;
  car.speed = 0;
  car.vx = 0;
  car.vz = 0;
  car.steer = 0;
  window.__cruiser = car;
  return { cars: g.police.cars.length, owner: car.owner, isPolice: car.isPolice, officers: g.police.officers.length };
});
await sleep(1300);
const deployed = await page.evaluate(() => {
  const g = window.__game;
  const car = window.__cruiser;
  const entry = g.police.cars.find((e) => e.car === car);
  // one star from here on: two stars and the squad opens fire, which is not this card
  g.police.wanted = 1;
  // keep the frame to this cruiser: the cruisers that spawned meanwhile would ram the car we measure
  for (const e of [...g.police.cars]) {
    if (e.car === car) continue;
    e.car.dispose();
    g.police.cars.splice(g.police.cars.indexOf(e), 1);
  }
  const near = g.police.officers.filter((o) => Math.hypot(o.pos.x - car.pos.x, o.pos.z - car.pos.z) < 7).length;
  return { crew: !!entry.crew, officers: g.police.officers.length, near, cars: g.police.cars.length };
});
check('the officers get out and stand beside the cruiser', deployed.crew && deployed.near >= 2, { ...parked, ...deployed });

// 3. the player gets in
await page.evaluate(() => {
  const g = window.__game;
  const car = window.__cruiser;
  g._test.teleport(car.pos.x - 1.8, car.pos.z);
});
await sleep(350);
await page.keyboard.press('f');
await sleep(400);
const inside = await page.evaluate(() => {
  const g = window.__game;
  const car = window.__cruiser;
  const entry = g.police.cars.find((e) => e.car === car);
  return {
    inCar: g.player.inCar === car,
    owner: car.owner,
    driverHidden: car.driver ? car.driver.visible === false : null,
    cleared: { stuck: entry.stuck, reverse: entry.reverse, points: entry.points, path: entry.path.length },
  };
});
check('the player is in the cruiser and owns its controls', inside.inCar && inside.owner === 'player' && inside.driverHidden, inside);
check(
  'the AI chase state is dropped on handover',
  inside.cleared.stuck === 0 && inside.cleared.reverse === 0 && inside.cleared.points === 0 && inside.cleared.path === 0,
  inside.cleared
);

// 4. same car, same input, twice: AI attached (pre-fix) and AI detached (this fix)
async function turn(mode) {
  await page.evaluate((mode) => {
    const g = window.__game;
    const car = window.__cruiser;
    const entry = g.police.cars.find((e) => e.car === car);
    // identical starting state for both runs
    car.pos.set(0, 0, 0);
    car.yaw = 0;
    car.speed = 0;
    car.vx = 0;
    car.vz = 0;
    car.steer = 0;
    car.y = 0;
    car.vy = 0;
    car.roll = 0;
    car.pitch = 0;
    car.health = 100;
    car.wrecked = false;
    g.player.pos.set(0, 0, 0);
    g.player.y = 0;
    entry.stuck = 0;
    entry.reverse = 0;
    entry.timer = 0;
    entry.points = 0;
    entry.idx = 0;
    entry.path.length = 0;
    car.owner = mode;
    // The arc runs with the city's collision boxes out of the way. A wall would end the turn
    // early in one run and not in the other, so this measures the input, not the map. Both modes
    // use the same empty set, so the comparison stays fair.
    if (!window.__savedColliders) window.__savedColliders = g.city.colliders.splice(0, g.city.colliders.length);
    // count every write into this car's controls while the keys are held
    window.__calls = [];
    if (!car.__wrapped) {
      const real = car.update.bind(car);
      car.update = (dt, input, colliders, worldHalf) => {
        // updateDriving() always sends a handbrake field; the police AI never does
        window.__calls.push({ ai: !('handbrake' in (input || {})), steer: +(input?.steer ?? 0).toFixed(2) });
        return real(dt, input, colliders, worldHalf);
      };
      car.__wrapped = true;
    }
    const s = { t0: performance.now(), samples: [], frames: 0, on: true };
    window.__turn = s;
    const loop = () => {
      if (!s.on) return;
      s.frames++;
      // game time, not wall clock: dt is clamped at 50 ms, so a slow headless host runs the sim
      // below real time and a wall-clock window would measure the host's frame rate instead
      s.samples.push({ ms: Math.round(performance.now() - s.t0), sim: g.state.simTime, yaw: car.yaw, speed: car.speed });
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }, mode);

  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyD');
  await page.waitForFunction(
    `window.__turn && window.__turn.samples.length > 1 && window.__turn.samples[window.__turn.samples.length - 1].sim - window.__turn.samples[0].sim >= ${HOLD}`,
    { timeout: 30000, polling: 50 }
  );
  await page.keyboard.up('KeyD');
  await page.keyboard.up('KeyW');

  return page.evaluate((HOLD) => {
    const car = window.__cruiser;
    const s = window.__turn;
    s.on = false;
    const deg = (p, q) => +(((q.yaw - p.yaw) * 180) / Math.PI).toFixed(1);
    const at = (sec) => {
      let best = s.samples[0];
      for (const p of s.samples) if (Math.abs(p.sim - sec) < Math.abs(best.sim - sec)) best = p;
      return best;
    };
    const start = s.samples[0].sim;
    const q = [at(start), at(start + 0.5), at(start + 1.0), at(start + 1.5), at(start + HOLD)];
    const seg = q.slice(1).map((p, i) => deg(q[i], p));
    const calls = window.__calls;
    const playerCalls = calls.filter((c) => !c.ai);
    return {
      owner: car.owner,
      deg: deg(q[0], q[4]),
      degPer500ms: seg,
      simSeconds: +(q[4].sim - q[0].sim).toFixed(2),
      endSpeed: +q[4].speed.toFixed(1),
      health: +car.health.toFixed(1),
      frames: s.frames,
      calls: calls.length,
      aiCalls: calls.filter((c) => c.ai).length,
      callsPerFrame: +(calls.length / Math.max(1, s.frames)).toFixed(2),
      heldSteer: playerCalls.length ? Math.min(...playerCalls.map((c) => c.steer)) : null,
      lockedShare: +(playerCalls.filter((c) => c.steer <= -0.9).length / Math.max(1, playerCalls.length)).toFixed(2),
      msPerFrame: s.samples.length > 1 ? +((s.samples[s.samples.length - 1].ms - s.samples[0].ms) / (s.samples.length - 1)).toFixed(1) : 0,
    };
  }, HOLD);
}

const before = await turn('ai');
console.log('TURN before-fix (AI attached)', JSON.stringify(before));
check('pre-fix: the AI still writes to the car the player is driving', before.aiCalls > 0 && before.callsPerFrame > 1.5, before);
check('pre-fix: the same full right lock barely changes the yaw', Math.abs(before.deg) < 60, { deg: before.deg, aiCalls: before.aiCalls });

const after = await turn('player');
console.log('TURN fixed (AI detached)     ', JSON.stringify(after));
check('fixed: no AI write reaches the cruiser at all', after.aiCalls === 0 && after.callsPerFrame <= 1.05, after);
check('fixed: the held key really is a full right lock for the whole window', after.heldSteer === -1 && after.lockedShare >= 0.9, { heldSteer: after.heldSteer, lockedShare: after.lockedShare });
check('fixed: one full right lock turns the car hard', Math.abs(after.deg) >= 90, { deg: after.deg, simSeconds: after.simSeconds, endSpeed: after.endSpeed });
// "steady": the last three half-seconds of the arc turn at the same rate, in the same direction
const tail = after.degPer500ms.slice(1);
const tailMin = Math.min(...tail.map(Math.abs));
const tailMax = Math.max(...tail.map(Math.abs));
check(
  'fixed: the turn is steady, not a nudge',
  tail.every((d) => Math.sign(d) === Math.sign(tail[0])) && tailMin >= 20 && tailMax / Math.max(0.1, tailMin) <= 1.35,
  { degPer500ms: after.degPer500ms }
);
check('fixed: driving the cruiser does not damage it (it is not ramming itself)', after.health >= 99, { health: after.health, endSpeed: after.endSpeed });
check('fixed: the turn is far larger than with the AI attached', Math.abs(after.deg) >= Math.abs(before.deg) * 3, {
  before: before.deg,
  after: after.deg,
  ratio: +(Math.abs(after.deg) / Math.max(0.1, Math.abs(before.deg))).toFixed(1),
});

// the cruiser goes back to the police pool when the player steps out
await page.evaluate(() => {
  const g = window.__game;
  if (window.__savedColliders) {
    g.city.colliders.push(...window.__savedColliders);
    window.__savedColliders = null;
  }
});
await page.keyboard.press('f');
await sleep(400);
const released = await page.evaluate(() => {
  const g = window.__game;
  const car = window.__cruiser;
  const entry = g.police.cars.find((e) => e.car === car);
  return { inCar: !!g.player.inCar, owner: car.owner, entries: g.police.cars.length, carried: entry ? entry.path.length + entry.points + entry.reverse : -1 };
});
check('stepping out hands the cruiser back to the police AI', !released.inCar && released.owner === 'ai' && released.carried === 0, released);

const failed = checks.filter((c) => !c.ok);
console.log('SUMMARY ' + JSON.stringify({ pass: checks.length - failed.length, total: checks.length }));
await Promise.race([browser.close(), sleep(4000)]);
process.exit(failed.length ? 1 : 0);
