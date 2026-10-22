// Officers must actually leave the cruiser and come at the player on foot once it stops, and
// must be killable from the player's gun.
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
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)));
await page.goto(URL, { waitUntil: 'networkidle2' });
await page.waitForFunction('window.__game !== undefined', { timeout: 60000 });
await page.click('#start-btn');
await sleep(700);

// raise the wanted level and park a cruiser right next to the player, stopped
const setup = await page.evaluate(() => {
  const g = window.__game;
  g.police.wanted = 4;
  g._test.teleport(0, 6);
  return { wanted: g.police.wanted };
});
await sleep(2500);

const deployed = await page.evaluate(() => {
  const g = window.__game;
  // freeze every cruiser so the deployment condition (stopped, close, player on foot) holds
  for (const e of g.police.cars) {
    e.car.speed = 0;
    e.car.pos.x = g.player.pos.x + 4;
    e.car.pos.z = g.player.pos.z;
  }
  return { cars: g.police.cars.length };
});
await sleep(1600);

const after = await page.evaluate(() => {
  const g = window.__game;
  return {
    officers: g.police.officers.length,
    crew: g.police.cars.filter((e) => e.crew).length,
    first: g.police.officers[0]
      ? { distance: +Math.hypot(g.police.officers[0].pos.x - g.player.pos.x, g.police.officers[0].pos.z - g.player.pos.z).toFixed(1) }
      : null,
  };
});
check('cruisers deploy two officers each when they stop nearby', after.officers >= 2 && after.crew >= 1, { ...setup, ...deployed, ...after });

const approach = await page.evaluate(async () => {
  const g = window.__game;
  // stand back so the arrest check does not fire, and keep the heat on: the wanted level
  // decays while the test waits, and at zero the squad walks away
  g.police.wanted = 4;
  g.player.pos.x -= 22;
  // nearest officer: the list order changes as cruisers keep arriving
  const nearest = () => g.police.officers.reduce((a, b) => {
    const da = Math.hypot(a.pos.x - g.player.pos.x, a.pos.z - g.player.pos.z);
    const db = Math.hypot(b.pos.x - g.player.pos.x, b.pos.z - g.player.pos.z);
    return da < db ? a : b;
  });
  if (!g.police.officers.length) return null;
  const o = nearest();
  const before = Math.hypot(o.pos.x - g.player.pos.x, o.pos.z - g.player.pos.z);
  await new Promise((r) => setTimeout(r, 1800));
  g.police.wanted = 4;
  if (!g.police.officers.length) return { before: +before.toFixed(1), now: null, gone: true, wanted: +g.police.wanted.toFixed(2), inCar: !!g.player.inCar };
  const o2 = nearest();
  const now = Math.hypot(o2.pos.x - g.player.pos.x, o2.pos.z - g.player.pos.z);
  return { before: +before.toFixed(1), now: +now.toFixed(1), n: g.police.officers.length, wanted: +g.police.wanted.toFixed(2) };
});
check('officers close the distance on foot', approach && approach.now < approach.before, approach);

const shot = await page.evaluate(() => {
  const g = window.__game;
  g.police.wanted = 4;
  const before = { officers: g.police.officers.length, ragdolls: g.ragdolls.length, cash: g.player.cash };
  let raycastHit = 0;
  // aim and fire a few times: an officer walks towards the player, so a single frame can miss
  for (let i = 0; i < 4 && g.police.officers.length === before.officers; i++) {
    const o = g.police.officers.find((x) => !x.dead);
    if (!o) break;
    g._test.lookFrom(o.pos.x, o.pos.y + 1.4, o.pos.z + 3.0, o.pos.x, o.pos.y + 1.1, o.pos.z);
    const dir = g.THREE ? null : null;
    void dir;
    const ray = g.police.raycastOfficer(
      new g.THREE.Vector3(o.pos.x, o.pos.y + 1.4, o.pos.z + 3.0),
      new g.THREE.Vector3(0, -0.1, -1).normalize(),
      30
    );
    if (ray) raycastHit++;
    g._test.shoot();
  }
  return { before, raycastHit, after: { officers: g.police.officers.length, ragdolls: g.ragdolls.length, cash: g.player.cash } };
});
check('shooting an officer takes them down', shot && shot.after.officers === shot.before.officers - 1 && shot.after.ragdolls > shot.before.ragdolls, shot);

const recall = await page.evaluate(async () => {
  const g = window.__game;
  const before = g.police.officers.length;
  g.police.wanted = 0;
  await new Promise((r) => setTimeout(r, 1800));
  return { before, after: g.police.officers.length };
});
check('officers go away when the wanted level clears', recall.after < recall.before || recall.before === 0, recall);

console.log('SUMMARY ' + JSON.stringify({ pass: checks.filter((c) => c.ok).length, total: checks.length }));
await browser.close();
