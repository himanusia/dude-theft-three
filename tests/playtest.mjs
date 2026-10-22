
import puppeteer from 'puppeteer-core';
import path from 'node:path';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL_ = process.env.DTA_URL || 'http://localhost:8765';
const OUT = path.join(process.cwd(), 'screenshots');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = [];
const note = (k, v) => { log.push({ k, v }); console.log(k.padEnd(26), JSON.stringify(v)); };

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox','--enable-unsafe-swiftshader','--mute-audio','--autoplay-policy=no-user-gesture-required'], defaultViewport: { width: 1500, height: 900 } });
const p = await b.newPage();
const errs = [];
p.on('pageerror', e => errs.push('pageerror: ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.goto(URL_ + '/index.html', { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.__game !== undefined', { timeout: 60000 });
await sleep(1200);
await p.click('#start-btn');
await sleep(2500);
const shot = async (name) => p.screenshot({ path: path.join(OUT, name) });

// 1. on-foot walk + sprint distance
const t0 = await p.evaluate(() => window.__game.player.pos.toArray());
await p.keyboard.down('w'); await sleep(1600); await p.keyboard.up('w');
const t1 = await p.evaluate(() => window.__game.player.pos.toArray());
note('walk distance 1.6s', +Math.hypot(t1[0]-t0[0], t1[2]-t0[2]).toFixed(2));

// 2. car: enter, accelerate, top speed, brake
const car = await p.evaluate(() => {
  const g = window.__game;
  const c = g.cityCars[0];
  g._test.teleport(c.pos.x + 2.2, c.pos.z + 0.4);
  return { x: c.pos.x, z: c.pos.z, type: c.type };
});
await sleep(400);
await p.keyboard.press('f');
await sleep(600);
const inCar = await p.evaluate(() => !!window.__game.player.inCar);
note('entered car', { inCar, type: car.type });
const samples = [];
await p.keyboard.down('w');
for (let i = 0; i < 5; i++) { await sleep(1000); samples.push(await p.evaluate(() => Math.round((window.__game.player.inCar ? window.__game.player.inCar.speed : 0) * 3.6))); }
note('speed 1..5s (km/h)', samples);
await shot('qa-drive.png');
await p.keyboard.down('d'); await sleep(900); await p.keyboard.up('d');
await p.keyboard.up('w');
await sleep(1200);
const cam = await p.evaluate(() => ({ yaw: +window.__game.player.camYaw?.toFixed?.(2), state: window.__game.state.camYaw ?? null }));
note('camera after turn', cam);

// 3. crash into a pedestrian: ragdoll + wanted
const hit = await p.evaluate(async () => {
  const g = window.__game;
  const ped = g.peds.peds.find(x => !x.dead);
  if (!ped) return null;
  g._test.teleport(ped.pos.x, ped.pos.z + 1.2);
  return { ped: [ped.pos.x, ped.pos.z] };
});
note('ped target', hit);

// 4. on foot shooting: ammo decrement + recoil/crosshair
await p.keyboard.press('f'); // exit car
await sleep(500);
const ammo0 = await p.evaluate(() => window.__game.player.mag);
await p.mouse.click(750, 450);
await sleep(250);
const ammo1 = await p.evaluate(() => window.__game.player.mag);
note('ammo after 1 shot', { before: ammo0, after: ammo1 });
await shot('qa-shoot.png');

// 5. five stars + chase, measure police distance over 12s
await p.evaluate(() => { window.__game.police.wanted = 5; window.__game.police.starCount = 5; });
let closest = 999, cops = 0;
for (let i = 0; i < 12; i++) {
  await sleep(1000);
  const s = await p.evaluate(() => ({
    cops: window.__game.police.cars.length,
    d: window.__game.police.cars.map(c => c.car.pos.distanceTo(window.__game.player.pos)),
    hp: Math.round(window.__game.player.hp),
  }));
  cops = Math.max(cops, s.cops);
  if (s.d.length) closest = Math.min(closest, ...s.d);
}
note('police 12s', { cops, closest: Math.round(closest) });
await shot('qa-chase.png');

// 6. interior: enter a shop on foot, look around, exit
const door = await p.evaluate(() => {
  const g = window.__game;
  const d = g.city.shopDoors[0];
  g._test.teleport(d.x, d.z + 0.6);
  return d;
});
await sleep(600);
await p.keyboard.press('e');
await sleep(900);
const inside = await p.evaluate(() => ({ kind: window.__game.player.inInterior?.kind ?? null }));
note('interior', inside);
await shot('qa-interior.png');
await p.keyboard.press('e');
await sleep(500);

// 7. perf sample while driving at noon
const perf = await p.evaluate(async () => {
  const g = window.__game;
  g._test.setTime(0.5);
  await new Promise(r => setTimeout(r, 700));
  return { calls: g.renderer.info.render.calls, tris: g.renderer.info.render.triangles, fps: Math.round(g.state.fps ?? 0) };
});
note('perf noon', perf);

// 8. audit
const audit = await p.evaluate(() => window.__game._test.audit());
note('audit', { peds: audit.peds.length, cars: audit.cars.length, player: audit.player, ragdolls: audit.ragdolls.length, props: audit.props.length, buildings: audit.buildings.length });
note('errors', errs.slice(0, 4));
await b.close();
