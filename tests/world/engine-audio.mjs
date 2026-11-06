// The engine note: the repo ships audio/sfx/engine.ogg, so the car has to actually sound like
// one. Nothing here reads a flag the game could set without a sound: it reads the live AudioParam
// values of the graph the game built, three times, at three road speeds.
//
// The checks are: the asset is served, the buffer decoded into the mixer, one live looping node
// while seated, level and pitch climbing with road speed, the level falling when the pedal is
// released, an open cockpit louder than a closed cabin at the same idle, and the engine fading
// out (not cutting) when the player leaves the car or walks into a shop.
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL = process.env.DTA_URL || 'http://127.0.0.1:8765/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.bringToFront();
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction('window.__game !== undefined', { timeout: 60000 });
await page.click('#start-btn');
await page.waitForFunction('window.__game.audio.ready === true', { timeout: 90000 });
await sleep(600);

const state = () => page.evaluate(() => window.__game._test.audioState());

async function seatIn(type) {
  const picked = await page.evaluate((type) => {
    const g = window.__game;
    if (g.player.inCar) g._test.toggleVehicle();
    const car = g.cityCars.find((c) => c.type === type && !c.wrecked) || g.cityCars.find((c) => !c.wrecked);
    if (!car) return null;
    // stand beside it: `nearestCar` wants the body within 4.6 m of the player
    g._test.teleport(car.pos.x + 1.6, car.pos.z + 0.4);
    return car.type;
  }, type);
  await sleep(350);
  await page.keyboard.press('f');
  await sleep(350);
  return picked;
}

/** hold the pedal until the HUD speed reaches `minKmh`, then let the ramp settle */
async function driveUntil(minKmh, timeoutMs = 25000) {
  await page.keyboard.down('w');
  const t0 = Date.now();
  let s = await state();
  while (Date.now() - t0 < timeoutMs) {
    s = await state();
    if (s.kmh >= minKmh) break;
    await sleep(120);
  }
  await sleep(420); // two time constants of the gain ramp
  return state();
}

// ---------------------------------------------------------------- the asset and the buffer
const asset = await page.evaluate(async () => {
  const res = await fetch('audio/sfx/engine.ogg', { method: 'HEAD' });
  return { status: res.status, bytes: Number(res.headers.get('content-length') || 0) };
});
check('engine.ogg is served', asset.status === 200 && asset.bytes > 100000, asset);

const boot = await state();
check('the engine buffer is loaded into the mixer', boot.hasBuffer === true && boot.ready === true, {
  hasBuffer: boot.hasBuffer,
  ready: boot.ready,
});

// ---------------------------------------------------------------- seated: one live looping node
const seatedType = await seatIn('sedan');
const parked = await state();
check(
  'a live engine node exists while seated in a car',
  parked.inCar === true && parked.node === true && parked.loop === true && parked.ctxState === 'running',
  { carType: seatedType, inCar: parked.inCar, node: parked.node, loop: parked.loop, ctxState: parked.ctxState, nodeId: parked.nodeId }
);
check('the engine idles before the pedal is pressed', parked.kmh === 0 && parked.gain > 0.05, {
  kmh: parked.kmh,
  rpm01: parked.rpm01,
  gain: parked.gain,
  gainTarget: parked.gainTarget,
});

// ---------------------------------------------------------------- three samples on the road
const s1 = await driveUntil(22);
const s2 = await driveUntil(45);
const s3 = await driveUntil(70);
const samples = [s1, s2, s3].map((s) => ({ kmh: s.kmh, rpm01: s.rpm01, gain: s.gain, gainTarget: s.gainTarget, rate: s.rate, cutoff: s.cutoff }));
console.log('SAMPLES ' + JSON.stringify(samples));

check(
  'the engine gain rises with road speed (three samples)',
  s1.gain < s2.gain && s2.gain < s3.gain && s3.gain - s1.gain > 0.02,
  { kmh: [s1.kmh, s2.kmh, s3.kmh], gain: [s1.gain, s2.gain, s3.gain] }
);
check(
  'the note is pitched by the gear-stepped rpm',
  s1.rate < s2.rate && s2.rate < s3.rate && s3.cutoff > s1.cutoff,
  { rate: [s1.rate, s2.rate, s3.rate], cutoff: [s1.cutoff, s2.cutoff, s3.cutoff], rpm01: [s1.rpm01, s2.rpm01, s3.rpm01] }
);
check('the same node is retuned, never restarted', s1.nodeId === s2.nodeId && s2.nodeId === s3.nodeId && s3.nodeId > 0, {
  nodeIds: [s1.nodeId, s2.nodeId, s3.nodeId],
});

// ---------------------------------------------------------------- pedal fade
await page.keyboard.up('w');
await sleep(1600);
const coasting = await state();
check('releasing the pedal drops the level instead of holding a flat drone', coasting.gain < s3.gain - 0.03, {
  atSpeed: s3.gain,
  coasting: coasting.gain,
  kmh: coasting.kmh,
  rpm01: coasting.rpm01,
});

// ---------------------------------------------------------------- leaving the car
await page.keyboard.press('f');
await sleep(900);
const left = await state();
check('leaving the car fades the engine to silence', left.inCar === false && left.gainTarget === 0 && left.gain < 0.02, {
  inCar: left.inCar,
  gainTarget: left.gainTarget,
  gain: left.gain,
});

// ---------------------------------------------------------------- closed cabin vs open cockpit
// Same idle, same rpm, same pedal: only the bodywork in the way differs.
const closedIdle = parked;
const openedType = await seatIn('muscle');
const openIdle = await state();
await page.keyboard.press('f');
check(
  'the body is measured, not assumed from the model name',
  seatedType === 'sedan' && closedIdle.cabinClosed === true && openedType === 'muscle' && openIdle.cabinClosed === false,
  { sedan: closedIdle.cabinClosed, muscle: openIdle.cabinClosed }
);
check(
  'a closed cabin is quieter than an open cockpit at the same idle',
  openIdle.muffle === 0 && closedIdle.muffle > 0 && openIdle.gain > closedIdle.gain * 1.15,
  { closed: { muffle: closedIdle.muffle, gain: closedIdle.gain }, open: { muffle: openIdle.muffle, gain: openIdle.gain } }
);

// ---------------------------------------------------------------- the shop wall
const shop = await page.evaluate(() => {
  const g = window.__game;
  if (g.player.inCar) g._test.toggleVehicle();
  const d = g.city.shopDoors[0];
  g._test.teleport(d.x + d.nx * 1.4, d.z + d.nz * 1.4);
  return { name: d.name };
});
await sleep(400);
await page.keyboard.press('KeyE');
await sleep(500);
const indoors = await state();
await page.keyboard.press('KeyE');
check('inside a shop the engine is behind a wall, not in the room', indoors.inInterior === true && indoors.muffle >= 0.8, {
  shop: shop.name,
  inInterior: indoors.inInterior,
  muffle: indoors.muffle,
  gainTarget: indoors.gainTarget,
});

check('no page errors', errs.length === 0, errs.slice(0, 4));

const failed = results.filter((r) => !r.ok);
console.log('SUMMARY ' + JSON.stringify({ pass: results.length - failed.length, total: results.length }));
await browser.close();
if (failed.length) {
  console.error(`engine-audio: ${failed.length}/${results.length} checks failed`);
  process.exit(1);
}
