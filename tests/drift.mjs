// Proves the car model has lateral slip, measured on the physics step itself (no traffic, no
// kerbs): a hard turn keeps most of its momentum and slides a little, the handbrake slides a
// lot, and straight-line input still tracks dead straight.
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL = process.env.DTA_URL || 'http://127.0.0.1:8765/';
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
await page.goto(URL, { waitUntil: 'networkidle2' });
await page.waitForFunction('window.__game !== undefined', { timeout: 60000 });
await page.click('#start-btn');
await sleep(600);

const seated = await page.evaluate(() => {
  const g = window.__game;
  const car = g.cityCars.find((c) => !c.wrecked) || g.cityCars[0];
  g._test.teleport(car.pos.x + 1.6, car.pos.z + 0.6);
  return !!car;
});
await sleep(400);
await page.keyboard.press('f');
await sleep(400);
check('seated in a car', await page.evaluate(() => !!window.__game.player.inCar), { seated });

// Drive the car's own update() in a loop with an empty world, so the numbers describe the
// handling model and not whatever happened to be parked nearby.
const sim = await page.evaluate(() => {
  const g = window.__game;
  const c = g.player.inCar;
  if (!c) return null;
  const run = ({ steer = 0, throttle = 1, handbrake = false, steps = 90, speed0 = 18 }) => {
    c.pos.x = 0; c.pos.z = 0; c.yaw = 0; c.vx = 0; c.vz = 0; c.steer = 0;
    c.speed = speed0;
    const trail = [];
    for (let i = 0; i < steps; i++) {
      c.update(1 / 60, { throttle, steer, handbrake }, [], 400);
      if (i % 15 === 0) trail.push(+c.slip.toFixed(3));
    }
    const velYaw = Math.atan2(c.vx, c.vz);
    let delta = velYaw - c.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    return {
      kmh: +(Math.hypot(c.vx, c.vz) * 3.6).toFixed(1),
      slip: +c.slip.toFixed(3),
      yawDeg: +(c.yaw * 180 / Math.PI).toFixed(1),
      headingVsTravelDeg: +(delta * 180 / Math.PI).toFixed(1),
      lateralMoved: +Math.abs(c.pos.x).toFixed(2),
      forwardMoved: +c.pos.z.toFixed(2),
      trail,
    };
  };
  return {
    straight: run({ steer: 0, steps: 90 }),
    grip: run({ steer: 0.6, steps: 90 }),
    handbrake: run({ steer: 0.6, handbrake: true, steps: 90 }),
  };
});

check('straight input keeps the car straight', Math.abs(sim.straight.lateralMoved) < 0.05 && sim.straight.forwardMoved > 20, sim.straight);
check('a grip turn keeps most of its speed', sim.grip.kmh > sim.straight.kmh * 0.6, { straight: sim.straight.kmh, grip: sim.grip.kmh });
check('a grip turn barely slides', Math.abs(sim.grip.slip) < 0.25, sim.grip);
check(
  'the handbrake slides far more than a grip turn',
  Math.abs(sim.handbrake.slip) > Math.abs(sim.grip.slip) + 0.15,
  { grip: sim.grip.slip, handbrake: sim.handbrake.slip }
);
check(
  'while drifting the nose points away from the direction of travel',
  Math.abs(sim.handbrake.headingVsTravelDeg) > 10,
  sim.handbrake
);
check('the handbrake keeps the car rolling', sim.handbrake.kmh > 25, { kmh: sim.handbrake.kmh });

console.log('SUMMARY ' + JSON.stringify({ pass: checks.filter((c) => c.ok).length, total: checks.length }));
await browser.close();
