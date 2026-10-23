// Every car on the street needs somebody behind the wheel, the body you see in the seat has to be
// the person who is actually driving it, and the seat must not keep an occupant the player left
// behind.
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
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction('window.__game !== undefined', { timeout: 120000 });
await page.click('#start-btn');
await sleep(900);

const census = await page.evaluate(() => {
  const g = window.__game;
  const cars = [...g.cityCars, ...g.traffic.cars.map((e) => e.car)];
  const withDriver = cars.filter((c) => c.driver && c.driver.visible).length;
  return { total: cars.length, withDriver, drivers: g.cityCars[0].driver?.children.length ?? 0 };
});
check('every parked and traffic car has a visible driver', census.withDriver === census.total && census.total > 10, census);
// torso, head, hair, two sleeves, two hands (kept lean because draw calls are the budget)
check('the driver is built from head, hair, torso and two arms with hands on the wheel', census.drivers >= 7, { parts: census.drivers });

const seat = await page.evaluate(async () => {
  const g = window.__game;
  const car = g.cityCars.find((c) => !c.wrecked && c.driver);
  g._test.teleport(car.pos.x + 1.3, car.pos.z);
  await new Promise((r) => setTimeout(r, 120));
  window.__targetCar = car;
  return { x: car.pos.x, z: car.pos.z, look: g._test.playerLook() };
});
await sleep(300);
await page.keyboard.press('f');
await sleep(500);
const inside = await page.evaluate(() => {
  const car = window.__targetCar;
  const body = car.driver;
  return {
    inCar: !!window.__game.player.inCar,
    seated: !!body && body.visible === true,
    shirt: body ? '#' + body.children[0].material.color.getHexString() : null,
    steppedOut: window.__game._test.stepOuts().length,
  };
});
const shirtHex = '#' + (seat.look[1] ?? 0).toString(16).padStart(6, '0');
check(
  'entering the car puts the player own body in the seat and the old driver on the street',
  inside.inCar && inside.seated && inside.shirt === shirtHex && inside.steppedOut === 1,
  { ...inside, playerShirt: shirtHex }
);

await page.keyboard.press('f');
await sleep(600);
const outside = await page.evaluate(() => ({
  inCar: !!window.__game.player.inCar,
  seatEmpty: !window.__targetCar.driver,
}));
check('leaving the car leaves an empty seat (no ghost driver left in it)', !outside.inCar && outside.seatEmpty, outside);

const seated2 = await page.evaluate(() => {
  const g = window.__game;
  const T = g.THREE;
  const car = g.cityCars.find((c) => c.driver && c.type !== 'angkot');
  if (!car) return null;
  car.mesh.updateMatrixWorld(true);
  const shell = new T.Box3();
  for (const child of car.mesh.children) {
    if (child === car.driver) continue;
    shell.expandByObject(child);
  }
  const headBox = new T.Box3().setFromObject(car.driver.children[1]);
  return {
    inside: shell.containsPoint(headBox.getCenter(new T.Vector3())),
    headTop: +headBox.max.y.toFixed(2),
    top: +shell.max.y.toFixed(2),
    type: car.type,
  };
});
check('the driver sits inside the cabin, not through the roof', seated2 && seated2.inside && seated2.headTop < seated2.top, seated2);

console.log('SUMMARY ' + JSON.stringify({ pass: checks.filter((c) => c.ok).length, total: checks.length }));
await browser.close();
if (checks.some((c) => !c.ok)) process.exitCode = 1;
