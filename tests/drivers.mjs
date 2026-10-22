// Every car on the street needs somebody behind the wheel, and the seat must empty while the
// player is driving it.
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
await sleep(900);

const census = await page.evaluate(() => {
  const g = window.__game;
  const cars = [...g.cityCars, ...g.traffic.cars.map((e) => e.car)];
  const withDriver = cars.filter((c) => c.driver && c.driver.visible).length;
  return { total: cars.length, withDriver, drivers: g.cityCars[0].driver?.children.length ?? 0 };
});
check('every parked and traffic car has a visible driver', census.withDriver === census.total && census.total > 10, census);
// three boxes: torso+arms, head, hair (kept lean because draw calls are the budget)
check('the driver is built from head, hair and torso+arms', census.drivers >= 3, { parts: census.drivers });

const seat = await page.evaluate(async () => {
  const g = window.__game;
  const car = g.cityCars.find((c) => !c.wrecked);
  g._test.teleport(car.pos.x + 1.6, car.pos.z + 0.6);
  await new Promise((r) => setTimeout(r, 120));
  window.__targetCar = car;
  return { x: car.pos.x, z: car.pos.z };
});
await sleep(400);
await page.keyboard.press('f');
await sleep(500);
const inside = await page.evaluate(() => ({
  inCar: !!window.__game.player.inCar,
  driverHidden: window.__targetCar.driver ? window.__targetCar.driver.visible === false : false,
}));
check('entering the car hides the driver', inside.inCar && inside.driverHidden, inside);

await page.keyboard.press('f');
await sleep(600);
const outside = await page.evaluate(() => ({
  inCar: !!window.__game.player.inCar,
  driverBack: window.__targetCar.driver ? window.__targetCar.driver.visible === true : false,
}));
check('leaving the car puts the driver back', !outside.inCar && outside.driverBack, outside);

const glass = await page.evaluate(() => {
  const g = window.__game;
  const car = g.cityCars[0];
  let opacity = null;
  car.mesh.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    if (m && m.transparent && m.opacity < 0.6) opacity = opacity === null ? m.opacity : Math.min(opacity, m.opacity);
  });
  return { opacity };
});
check('glass is see-through, so the driver reads from outside', glass.opacity !== null && glass.opacity <= 0.35, glass);

console.log('SUMMARY ' + JSON.stringify({ pass: checks.filter((c) => c.ok).length, total: checks.length }));
await browser.close();
