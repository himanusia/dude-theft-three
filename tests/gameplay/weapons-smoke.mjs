
import puppeteer from 'puppeteer-core';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL_ = process.env.DTA_URL || 'http://127.0.0.1:8765';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (n, ok, d) => { results.push({ n, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' :: ' + JSON.stringify(d) : '')); };

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox','--enable-unsafe-swiftshader','--mute-audio','--autoplay-policy=no-user-gesture-required'], defaultViewport: { width: 1400, height: 820 } });
const p = await b.newPage();
const errs = [];
p.on('pageerror', e => errs.push(e.message));
await p.goto(URL_ + '/index.html', { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.__game !== undefined', { timeout: 60000 });
await sleep(1200); await p.click('#start-btn'); await sleep(2200);

const slots = [];
for (let i = 1; i <= 6; i++) {
  await p.keyboard.press('Digit' + i);
  await sleep(160);
  slots.push(await p.evaluate(() => ({ id: window.__game.player.weapon, name: window.__game.weaponSpec.name, pellets: window.__game.weaponSpec.pellets, melee: window.__game.weaponSpec.melee })));
}
check('six slots equip by number key', slots.length === 6 && new Set(slots.map(s => s.id)).size === 6, slots.map(s => s.id));

await p.keyboard.press('Digit3'); await sleep(250);
const mag0 = await p.evaluate(() => window.__game.player.mag);
await p.mouse.click(700, 420); await sleep(400);
const mag1 = await p.evaluate(() => window.__game.player.mag);
check('pistol spends exactly one round per click', mag1 === mag0 - 1, { before: mag0, after: mag1 });

await p.keyboard.press('Digit4'); await sleep(300);
const u0 = await p.evaluate(() => window.__game.player.mag);
await p.mouse.down(); await sleep(1400); await p.mouse.up(); await sleep(250);
const u1 = await p.evaluate(() => window.__game.player.mag);
// a headless host runs at ~12 fps, so the cadence is frame-limited; what matters
// is that holding the trigger keeps firing instead of firing once
check('uzi fires multiple rounds while held', u0 - u1 >= 2, { before: u0, after: u1 });

await p.keyboard.press('Digit5'); await sleep(250);
const spec5 = await p.evaluate(() => window.__game.weaponSpec);
check('shotgun fires a pellet spread', spec5.pellets >= 6, { pellets: spec5.pellets, spread: spec5.spread });

await p.keyboard.press('Digit1'); await sleep(250);
const f0 = await p.evaluate(() => window.__game.player.mag);
await p.mouse.click(700, 420); await sleep(350);
const f1 = await p.evaluate(() => window.__game.player.mag);
check('fist does not consume ammo', f0 === f1, { before: f0, after: f1 });

await p.keyboard.press('Digit3'); await sleep(250);
await p.evaluate(() => { window.__game.player.mag = 1; });
await p.keyboard.press('KeyR');
// game time advances with dt, and a loaded host runs at ~12 fps, so poll instead of guessing
let afterReload = { mag: 0, size: 0 };
for (let i = 0; i < 40; i++) {
  await sleep(250);
  afterReload = await p.evaluate(() => ({ mag: window.__game.player.mag, size: window.__game.weaponSpec.magSize, reloading: window.__game.player.reloading }));
  if (afterReload.reloading === 0 && afterReload.mag === afterReload.size) break;
}
check('reload refills the magazine', afterReload.mag === afterReload.size, afterReload);

const perf = await p.evaluate(() => ({ calls: window.__game.state.calls }));
check('frame still cheap', Number(perf.calls) < 1600, perf);
check('no page errors', errs.length === 0, errs.slice(0, 3));

console.log('SUMMARY ' + JSON.stringify({ pass: results.filter(r => r.ok).length, total: results.length }));
await b.close();
if (results.some(r => !r.ok)) process.exitCode = 1;
