// End-to-end gameplay feel harness: measures acceleration, the real-mouse
// trigger, camera state and the floating-geometry audit against a live build.
// Run with: DTA_URL=http://localhost:8794 node tests/playtest.mjs

import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL_ = process.env.DTA_URL || 'http://localhost:8765';
const OUT = new URL('../../screenshots', import.meta.url).pathname;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = [];
const checks = [];
const note = (k, v) => { log.push({ k, v }); console.log(k.padEnd(26), JSON.stringify(v)); };
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox','--enable-unsafe-swiftshader','--mute-audio','--autoplay-policy=no-user-gesture-required'], defaultViewport: { width: 1500, height: 900 } });
const p = await b.newPage();
const errs = [];
p.on('pageerror', e => errs.push('pageerror: ' + e.message));
const IGNORE = /ERR_CONNECTION_RESET|ERR_SOCKET_NOT_CONNECTED|ERR_ABORTED|Failed to load resource: net::/;
p.on('console', m => { if (m.type() === 'error' && !IGNORE.test(m.text())) errs.push('console: ' + m.text()); });
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
await sleep(300);

// 2. sedan throttle sweep on a cleared straight (x = 26 is the centre of the
// north-south road, the corridor is emptied so the run is never interrupted)
const car = await p.evaluate(() => {
  const g = window.__game;
  const park = (c) => { c.pos.set(130, 0, 130); c.speed = 0; c.y = 0; c.mesh.position.copy(c.pos); };
  for (const c of [...g.cityCars, ...g.traffic.cars.map(e => e.car)]) park(c);
  const c = g.cityCars.find(x => x.type === 'sedan' && !x.wrecked) ?? g.cityCars[0];
  c.pos.set(26, 0, -170); c.yaw = 0; c.speed = 0; c.y = 0;
  c.mesh.position.copy(c.pos); c.mesh.rotation.y = 0;
  g._test.teleport(28.2, -169.6);
  return { type: c.type, maxSpeed: c.maxSpeed, accel: c.accel };
});
await sleep(400);
await p.keyboard.press('f');
await sleep(600);
const inCar = await p.evaluate(() => !!window.__game.player.inCar);
note('entered car', { inCar, type: car.type });

const samples = [];
const t0sim = await p.evaluate(() => window.__game.state.simTime);
const wall0 = Date.now();
await p.keyboard.down('w');
// sample on the game clock, not wall clock: headless frame-rate dips stretch
// real seconds without moving the physics any further
for (let i = 1; i <= 5; i++) {
  await p.waitForFunction((t) => window.__game.state.simTime >= t, { polling: 'raf' }, t0sim + i);
  samples.push(await p.evaluate(() => Math.round(window.__game.player.inCar?.kmh ?? 0)));
}
const wall5 = +((Date.now() - wall0) / 1000).toFixed(2);
note('speed 1..5s (km/h)', samples);
note('5s of game time took', wall5);
await shot('feel-drive.png');
const drive = await p.evaluate(() => {
  const box = document.getElementById('speedo');
  const val = document.getElementById('speed-val');
  const r = box.getBoundingClientRect();
  const cs = getComputedStyle(val);
  return {
    hud: val.textContent,
    visible: r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth,
    font: cs.fontSize,
    fov: window.__game.state.fov,
    kmh: window.__game.state.speedKmh,
  };
});
note('speedometer + fov', drive);
await p.waitForFunction((t) => window.__game.state.simTime >= t, { polling: 'raf' }, t0sim + 8);
const speed8 = await p.evaluate(() => Math.round(window.__game.player.inCar?.kmh ?? 0));
note('speed 8s (km/h)', speed8);

// camera: turning must move the yaw exposed on the debug handle
const yawBefore = await p.evaluate(() => window.__game.state.camYaw);
await p.keyboard.down('d'); await sleep(900); await p.keyboard.up('d');
await p.keyboard.up('w');
await sleep(700);
const cam = await p.evaluate(() => ({ yaw: window.__game.state.camYaw, pitch: window.__game.state.camPitch, fov: window.__game.state.fov }));
note('camera after turn', { before: yawBefore, ...cam, turned: cam.yaw !== yawBefore });
await sleep(1200);

// 3. on-foot shooting: a REAL mouse click must spend exactly one round
await p.keyboard.press('f'); // exit car
await sleep(700);
const ammo0 = await p.evaluate(() => window.__game.player.mag);
await p.mouse.click(750, 450);
await sleep(260);
const ammo1 = await p.evaluate(() => window.__game.player.mag);
note('ammo after 1 shot', { before: ammo0, after: ammo1 });
note('shot ray', await p.evaluate(() => ({ hit: window.__lastShot?.hitKind ?? null, dist: window.__lastShot?.bestDist ?? null })));

// muzzle flash: hold the trigger and keep the frame that actually catches the
// flash (a 0.12 s sprite can fall between two screenshot captures otherwise)
const muzzleAt = await p.evaluate(() => {
  const g = window.__game;
  const V = g.camera.position.constructor;
  const yaw = g.state.camYaw;
  const v = new V(
    g.player.pos.x - Math.sin(yaw) * 0.75 - Math.cos(yaw) * 0.28,
    g.player.y + 1.32,
    g.player.pos.z - Math.cos(yaw) * 0.75 + Math.sin(yaw) * 0.28
  );
  v.project(g.camera);
  return { x: Math.round((v.x * 0.5 + 0.5) * window.innerWidth), y: Math.round((-v.y * 0.5 + 0.5) * window.innerHeight) };
});
// hold an automatic weapon so a flash is on screen in most frames, instead of racing a
// 0.12 s semi-auto flash against a screenshot
await p.keyboard.press('Digit4');
await sleep(350);
await p.mouse.move(750, 450);
await p.mouse.down();
let bestFlash = { px: -1, b64: null };
for (let i = 0; i < 10; i++) {
  const b64 = await p.screenshot({ encoding: 'base64' });
  const px = await p.evaluate(async ({ b64, cx, cy }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const rad = 140;
    const d = ctx.getImageData(Math.max(0, cx - rad), Math.max(0, cy - rad), rad * 2, rad * 2).data;
    let warm = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], bl = d[i + 2];
      if (r > 240 && g > 195 && bl < 205) warm++;
    }
    return warm;
  }, { b64, cx: muzzleAt.x, cy: muzzleAt.y });
  if (px > bestFlash.px) bestFlash = { px, b64 };
  if (bestFlash.px > 150) break;
}
await p.mouse.up();
if (bestFlash.b64) fs.writeFileSync(path.join(OUT, 'feel-shoot.png'), Buffer.from(bestFlash.b64, 'base64'));
const flash = { sprites: await p.evaluate(() => window.__game.scene.children.filter(o => o.isSprite).length), pixels: bestFlash.px };
await sleep(400);
note('muzzle flash', flash);
note('shake settled', await p.evaluate(() => window.__game.state.shake));

// 4. five stars + chase: poll until cruisers actually spawn, then measure the closest
const paused = await p.evaluate(() => window.__game.state.paused);
if (paused) { await p.click('#resume-btn'); await sleep(500); }
await p.evaluate(() => { window.__game.police.wanted = 5; window.__game.police.starCount = 5; });
let closest = 999, cops = 0;
for (let i = 0; i < 24; i++) {
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

// 5. interior: enter a shop on foot, look around, exit
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
await p.keyboard.press('e');
await sleep(500);
void door;

// 6. perf sample while driving at noon
const perf = await p.evaluate(async () => {
  const g = window.__game;
  g._test.setTime(0.5);
  await new Promise(r => setTimeout(r, 700));
  return { calls: g.renderer.info.render.calls, tris: g.renderer.info.render.triangles, fps: Math.round(g.state.fps ?? 0) };
});
note('perf noon', perf);

// 7. audit: nothing may float or sink
const audit = await p.evaluate(() => window.__game._test.audit());
note('audit', { peds: audit.peds.length, cars: audit.cars.length, player: audit.player, ragdolls: audit.ragdolls.length, props: audit.props.length, buildings: audit.buildings.length });
const ground = await p.evaluate(() => ({ y: window.__game.player.y, ground: window.__game.city.groundHeightAt(window.__game.player.pos.x, window.__game.player.pos.z) }));
note('ground clamp', { y: +ground.y.toFixed(3), ground: +ground.ground.toFixed(3), ok: ground.y >= ground.ground - 1e-6 });
note('errors', errs.slice(0, 4));

check('sedan accelerates past 100 km/h by 5 s', samples.length === 5 && samples[4] >= 100, samples);
check('sedan holds 105-112 km/h at 8 s', speed8 >= 105 && speed8 <= 112, { speed8 });
check('pointer-lock-free click spends one round', ammo0 === 12 && ammo1 === 11, { before: ammo0, after: ammo1 });
// Holding an automatic weapon keeps a flash on screen across frames, so the assertion is
// about the pixels at the muzzle, not about beating a 0.12 s timer with a screenshot.
check('muzzle flash visible in the captured frame', flash.pixels > 25, flash);
check('camera yaw exposed and turns', Number.isFinite(cam.yaw) && cam.yaw !== yawBefore, { before: yawBefore, after: cam.yaw });
check('player sole sits on the ground', audit.player === 0, { player: audit.player });
check('nothing floats', audit.peds.length === 0 && audit.cars.length === 0 && audit.props.length === 0 && audit.ragdolls.length === 0, audit);
check('police still close in', cops >= 2 && closest < 60, { cops, closest });
check('no console/page errors', errs.length === 0, errs.slice(0, 4));

console.log('SUMMARY ' + JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length }));
console.log('FAILED ' + JSON.stringify(checks.filter(c => !c.ok)));
await b.close();
if (checks.some(c => !c.ok)) process.exit(1);
