
import { launch, bootGate, crash, suiteStart } from '../_harness.mjs';

const SUITE = 'gameplay/d1-regression';
suiteStart(SUITE);
try {
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL_ = process.env.DTA_URL || 'http://127.0.0.1:8765';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const b = await launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox','--enable-unsafe-swiftshader','--mute-audio','--autoplay-policy=no-user-gesture-required'], defaultViewport: { width: 1400, height: 820 } });
const p = await b.newPage();
const errs = [];
p.on('pageerror', e => errs.push(e.message));
await p.goto(URL_ + '/index.html', { waitUntil: 'domcontentloaded' });
await bootGate(p);
await sleep(1000); await p.click('#start-btn'); await sleep(2000);

// get into a car, then park it right on a shop door and press E
const setup = await p.evaluate(() => {
  const g = window.__game;
  const c = g.cityCars[0];
  const door = g.city.shopDoors[0];
  c.pos.set(door.x, 0, door.z + 1.0);
  c.speed = 0;
  g._test.teleport(door.x, door.z + 1.4);
  return { door: door.name, car: c.type };
});
await sleep(500);
await p.keyboard.press('f'); // enter car
await sleep(700);
const before = await p.evaluate(() => ({ inCar: !!window.__game.player.inCar, inInterior: !!window.__game.player.inInterior }));
await p.keyboard.press('e'); // try to enter shop while seated
await sleep(700);
const after = await p.evaluate(() => ({ inCar: !!window.__game.player.inCar, inInterior: !!window.__game.player.inInterior, prompt: document.getElementById('prompt')?.textContent || '' }));
console.log(JSON.stringify({ setup, before, after, errs }, null, 1));
await b.close();

} catch (err) {
  await crash(SUITE, err);
}
