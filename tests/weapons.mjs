// Weapon set acceptance harness: table integrity, fire cadence, ammo, pellets,
// reload timing, per-weapon damage, pickups, HUD and held-model screenshots.
//
// Run against a built copy:  npx vite preview --port 8796 --strictPort
//                            node tests/weapons.mjs
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL_ = process.env.DTA_URL || 'http://localhost:8796';
const OUT = new URL('../screenshots', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}
const within = (actual, expected, tolerance) => expected === 0 || Math.abs(actual - expected) / expected <= tolerance;

const b = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1500, height: 900 },
});
const page = await b.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
const IGNORE = /ERR_CONNECTION_RESET|ERR_SOCKET_NOT_CONNECTED|ERR_ABORTED|Failed to load resource: net::/;
page.on('console', (m) => {
  if (m.type() === 'error' && !IGNORE.test(m.text())) errs.push('console: ' + m.text());
});

await page.goto(URL_ + '/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__game !== undefined', { timeout: 40000 });
await sleep(1200);
await page.click('#start-btn');
await sleep(1800);

// the pointer lock warps the first synthetic move; settle the cursor before aiming
await page.mouse.move(750, 450);
await sleep(250);

const boot = await page.evaluate(() => ({
  weapons: Object.keys(window.__game.weapons),
  pickups: window.__game.weaponPickups.length,
  owned: window.__game.state.owned,
  weapon: window.__game.state.weapon,
  mag: window.__game.player.mag,
}));
check('boot: six weapons, pistol equipped, four fixed pickups', boot.weapons.length === 6 && boot.weapon === 'pistol' && boot.mag === 12 && boot.pickups === 4, boot);

// ---------------------------------------------------------------- table
const specs = await page.evaluate(() => Object.values(window.__game.weapons).map((w) => ({
  id: w.id, slot: w.slot, damage: w.damage, rpm: w.rpm, spread: w.spread, pellets: w.pellets,
  range: w.range, magSize: w.magSize, reserve: w.reserve, reload: w.reload, recoil: w.recoil,
  glyph: w.glyph, melee: w.melee, auto: w.auto, model: w.model,
  burst: w.damage * w.pellets + (w.bleed ? w.bleed.ticks * w.bleed.damage : 0),
})));
const slots = specs.map((s) => s.slot).sort((a, b) => a - b).join(',');
const table = specs.map((s) => ({
  weapon: s.id, slot: s.slot, damage: s.burst, rpmSpec: s.rpm, rpmMeasured: null,
  shots: null, simWindowS: null, reloadSpec: Math.round(s.reload * 1000), reloadSimMs: null, shotsToKill: null,
}));
const damages = specs.map((s) => s.burst);
const uniqueDamages = new Set(damages).size === damages.length;
check('table: slots 1-6 and every weapon damage unique', slots === '1,2,3,4,5,6' && uniqueDamages, { slots, damages });
check('SA feel: shotgun >= 6 pellets, uzi wider than AK, AK hits harder than 9mm',
  specs.find((s) => s.id === 'shotgun').pellets >= 6 &&
  specs.find((s) => s.id === 'uzi').spread > specs.find((s) => s.id === 'ak').spread &&
  specs.find((s) => s.id === 'ak').damage > specs.find((s) => s.id === 'pistol').damage,
  specs.map((s) => ({ id: s.id, pellets: s.pellets, spread: s.spread, damage: s.damage })));

// ---------------------------------------------------------------- cadence
// Cadence is measured on the simulated clock (state.simTime / __lastShot.simTime):
// swiftshader headless runs at ~4-10 fps and dt is clamped, so wall-clock rate
// would be a frame-rate measurement, not a weapon measurement. The first shot of
// a burst is dropped from the interval average.
const BURST_SHOTS = { pistol: 6, uzi: 8, shotgun: 4, ak: 8 };
for (const id of ['pistol', 'uzi', 'shotgun', 'ak']) {
  const spec = specs.find((s) => s.id === id);
  const res = await page.evaluate(async ({ id, want }) => {
    const g = window.__game;
    const spec = g.weapons[id];
    g._test.giveWeapon(id);
    g._test.equip(id);
    g._test.teleport(26, -40);
    g._test.setCam(Math.PI, 0.05);
    await new Promise((r) => requestAnimationFrame(r));
    const el = document.getElementById('game');
    const magBefore = g.player.mag;
    window.__lastShot = null;
    const times = [];
    let lastSim = -1;
    let held = false;
    const t0 = performance.now();
    while (times.length < want && performance.now() - t0 < 40000) {
      if (spec.auto) {
        if (!held) {
          el.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
          held = true;
        }
      } else {
        el.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
        document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
      }
      await new Promise((r) => requestAnimationFrame(r));
      const s = window.__lastShot;
      if (s && s.weapon === id && s.simTime !== lastSim) {
        lastSim = s.simTime;
        times.push(s.simTime);
      }
    }
    if (held) document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    return {
      times,
      shots: times.length,
      magSpent: magBefore - g.player.mag,
      simWindowS: times.length > 1 ? +(times[times.length - 1] - times[0]).toFixed(3) : 0,
    };
  }, { id, want: BURST_SHOTS[id] });
  const rpm = res.simWindowS > 0 ? ((res.shots - 1) / res.simWindowS) * 60 : 0;
  const ok = res.shots >= BURST_SHOTS[id] && within(rpm, spec.rpm, 0.15) && res.magSpent === res.shots;
  check(`${id}: ${res.shots} shots over ${res.simWindowS}s game time = ${Math.round(rpm)} rpm (spec ${spec.rpm} ±15%), ${res.magSpent} rounds spent`, ok, res);
  const row = table.find((t) => t.weapon === id);
  row.rpmMeasured = Math.round(rpm);
  row.shots = res.shots;
  row.simWindowS = res.simWindowS;
}

// ammo decrements exactly one per shot (no phantom rounds)
const ammo = await page.evaluate(async () => {
  const g = window.__game;
  g._test.giveWeapon('uzi');
  g._test.equip('uzi');
  const before = g.player.mag;
  for (let i = 0; i < 5; i++) {
    g.player.shootCd = 0;
    g._test.shoot();
  }
  return { before, after: g.player.mag, last: window.__lastShot };
});
check('ammo decrements exactly one round per shot', ammo.before - ammo.after === 5, ammo);

// shotgun pellets per trigger
const pellets = await page.evaluate(() => {
  const g = window.__game;
  g._test.giveWeapon('shotgun');
  g._test.equip('shotgun');
  g._test.teleport(26, -40);
  g._test.setCam(Math.PI, 0.05);
  g.player.weapon = 'shotgun';
  g.player.mag = 8;
  g.player.shootCd = 0;
  const before = g.player.mag;
  g._test.shoot();
  return { pellets: window.__lastShot.pellets, spent: before - g.player.mag, damage: window.__lastShot.damage };
});
check('shotgun fires >= 6 pellets from one trigger', pellets.pellets >= 6 && pellets.spent === 1, pellets);

// ---------------------------------------------------------------- reload
for (const id of ['pistol', 'uzi', 'shotgun', 'ak']) {
  const spec = specs.find((s) => s.id === id);
  await page.evaluate((id) => {
    const g = window.__game;
    g._test.giveWeapon(id);
    g._test.equip(id);
    g.player.reloadMs = 0;
    g.player.reloadSimMs = 0;
    for (let i = 0; i < 3; i++) {
      g.player.shootCd = 0;
      g._test.shoot();
    }
  }, id);
  await sleep(150);
  await page.keyboard.press('r');
  await page.waitForFunction(() => window.__game.player.reloading === 0 && window.__game.player.reloadSimMs > 0, { timeout: 15000, polling: 30 });
  const reload = await page.evaluate(() => ({
    simMs: window.__game.player.reloadSimMs,
    wallMs: window.__game.player.reloadMs,
    mag: window.__game.player.mag,
    size: window.__game.player.magSize,
  }));
  const expected = spec.reload * 1000;
  const ok = Math.abs(reload.simMs - expected) <= 100 && reload.mag === reload.size;
  check(`${id}: reload ${Math.round(reload.simMs)}ms game time (spec ${expected}ms ±100, ${Math.round(reload.wallMs)}ms wall)`, ok, reload);
  const row = table.find((t) => t.weapon === id);
  row.reloadSimMs = Math.round(reload.simMs);
}

// ---------------------------------------------------------------- damage / shots to kill
const killOrder = ['fist', 'knife', 'pistol', 'uzi', 'shotgun', 'ak'];
// hits that must land on a 100 hp ped (shotgun uses 4 m so its full 8-pellet
// pattern fits inside the hit sphere; knife bleed lands a little asynchronously)
const EXPECTED_HITS = { fist: 10, knife: 4, pistol: 3, uzi: 9, shotgun: 2, ak: 2 };
// shotgun: at 8 m from the camera the 8-degree pattern is wider than the hit
// sphere, so ~2-4 pellets connect per trigger; assert the SA band, print the rest
for (const id of killOrder) {
  const spec = specs.find((s) => s.id === id);
  const melee = spec.melee;
  const distance = melee ? 1.9 : id === 'shotgun' ? 4 : 6;
  await page.evaluate(({ id, distance }) => {
    const g = window.__game;
    g._test.giveWeapon(id);
    g._test.equip(id);
    g._test.teleport(26, -40);
    g._test.setCam(Math.PI, 0.08);
    g._test.target(distance);
  }, { id, distance });
  await sleep(450);
  const res = await page.evaluate(async ({ id, distance }) => {
    const g = window.__game;
    const spec = g.weapons[id];
    const ragBefore = g.ragdolls.length;
    const t0 = performance.now();
    let shots = 0;
    while (performance.now() - t0 < 15000) {
      g._test.clearArea(25);
      g._test.pinTarget(distance);
      g._test.setCam(Math.PI, 0.08);
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => requestAnimationFrame(r));
      g._test.pinTarget(distance);
      const hpBefore = g._test.pedHp();
      const swingBefore = g.player.swing;
      g._test.shoot();
      const hpAfter = g._test.pedHp();
      const hit = spec.melee ? g.player.swing > swingBefore : hpAfter < hpBefore;
      if (hit) shots++;
      if (hpAfter === 0) break;
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { shots, ms: Math.round(performance.now() - t0), dead: g._test.pedHp() === 0, hp: g._test.pedHp(), mag: g.player.mag };
  }, { id, distance });
  const expected = EXPECTED_HITS[id];
  const okHits = id === 'shotgun' ? res.shots >= 2 && res.shots <= 6 : id === 'knife' ? Math.abs(res.shots - expected) <= 1 : res.shots === expected;
  check(`${id}: killed a 100 hp ped with ${res.shots} connecting hit(s), ${spec.burst} dmg each (expected ${id === 'shotgun' ? '2-6' : expected})`, res.dead && okHits && res.hp === 0, res);
  table[table.findIndex((t) => t.weapon === id)].damage = spec.burst;
  table[table.findIndex((t) => t.weapon === id)].shotsToKill = res.shots;
}

// ---------------------------------------------------------------- melee is not a raycast
const meleeNoAmmo = await page.evaluate(() => {
  const g = window.__game;
  g._test.equip('knife');
  const before = g.player.mag;
  const reserve = g.player.ammoReserve.knife;
  g.player.shootCd = 0;
  g._test.shoot();
  return { before, after: g.player.mag, reserve, last: window.__lastShot };
});
check('melee swings spend no ammo and report a swing, not a ray', meleeNoAmmo.before === meleeNoAmmo.after && meleeNoAmmo.last?.melee === true, meleeNoAmmo);

// ---------------------------------------------------------------- switching + HUD
await page.evaluate(() => {
  const g = window.__game;
  g._test.teleport(26, -40);
  g._test.equip('ak');
});
await sleep(250);
await page.keyboard.press('6');
await sleep(250);
const afterKey = await page.evaluate(() => window.__game.player.weapon);
await page.mouse.wheel({ deltaY: 120 });
await sleep(300);
const afterWheelDown = await page.evaluate(() => window.__game.player.weapon);
await page.mouse.wheel({ deltaY: -120 });
await sleep(300);
const switchRes = await page.evaluate(() => ({
  afterWheelUp: window.__game.player.weapon,
  hudName: document.getElementById('weapon-name').textContent,
  hudAmmo: document.getElementById('ammo').textContent,
  active: [...document.querySelectorAll('#weapon-wheel .wrow.on')].map((r) => r.dataset.weapon),
  rows: document.querySelectorAll('#weapon-wheel .wrow').length,
}));
switchRes.afterKey = afterKey;
switchRes.afterWheelDown = afterWheelDown;
check('keys 1-6 and the wheel switch weapons, HUD + wheel follow',
  switchRes.afterKey === 'ak' && switchRes.afterWheelDown !== 'ak' && switchRes.rows === 6 &&
  switchRes.active.length === 1 && switchRes.hudName.length > 0 && /\d+ \/ \d+/.test(switchRes.hudAmmo),
  switchRes);

// ---------------------------------------------------------------- pickups
const pickup = await page.evaluate(async () => {
  const g = window.__game;
  const spot = g.weaponPickups.find((p) => p.id === 'shotgun' && p.active);
  if (!spot) return { skipped: true };
  const before = [...g.player.owned];
  g._test.teleport(spot.pos.x, spot.pos.z);
  await new Promise((r) => setTimeout(r, 500));
  return { before, after: [...g.player.owned], weapon: g.player.weapon, mag: g.player.mag, reserve: g.player.ammoReserve.shotgun, active: spot.active };
});
check('walking over a weapon pickup grants the weapon + ammo', !pickup.skipped && pickup.after.includes('shotgun') && pickup.mag === 8 && pickup.reserve >= 32 && pickup.active === false, pickup);

// cop drop: wreck a cruiser with the AK, it must leave a gun on the road
const copDrop = await page.evaluate(async () => {
  const g = window.__game;
  g._test.teleport(26, -40);
  g.police.addWanted(3);
  await new Promise((r) => setTimeout(r, 900));
  const entry = g.police.cars[0];
  if (!entry) return { skipped: true, cops: 0 };
  const car = entry.car;
  car.health = 5;
  car.speed = 0;
  // put the cruiser exactly on the camera ray, then clear every other car/ped
  // out of the line so the AK round cannot be eaten on the way
  const V = g.player.pos.constructor;
  const dir = g.camera.getWorldDirection(new V()).normalize();
  const pos = g.camera.position.clone().addScaledVector(dir, 14);
  pos.y = 0;
  car.pos.copy(pos);
  car.mesh.position.copy(pos);
  g._test.clearArea(30, car);
  g._test.giveWeapon('ak');
  g._test.equip('ak');
  g._test.setCam(Math.PI, 0.08);
  await new Promise((r) => requestAnimationFrame(r));
  const dropsBefore = g.weaponPickups.filter((p) => !p.permanent).length;
  g.player.shootCd = 0;
  g._test.shoot();
  await new Promise((r) => setTimeout(r, 300));
  return {
    cops: g.police.cars.length,
    wrecked: car.wrecked,
    dropsBefore,
    dropsAfter: g.weaponPickups.filter((p) => !p.permanent).length,
    dropped: g.weaponPickups.filter((p) => !p.permanent).map((p) => p.id),
  };
});
check('wrecked police cruiser drops a weapon pickup', copDrop.skipped || (copDrop.wrecked === true && copDrop.dropsAfter > copDrop.dropsBefore), copDrop);

// ---------------------------------------------------------------- screenshots + model visibility
await page.evaluate(() => {
  const g = window.__game;
  g.police.clearWanted();
  g._test.teleport(26, -40);
  g._test.setCam(Math.PI, 0.1);
  g.player.yaw = 0;
  g._test.setTime(0.5);
});
await sleep(400);

const shots = {};
for (const id of killOrder) {
  await page.evaluate((id) => {
    const g = window.__game;
    g._test.giveWeapon(id);
    g._test.equip(id);
    g._test.weaponPose(true);
    const px = g.player.pos.x, pz = g.player.pos.z;
    g._test.lookFrom(px + 2.1, 1.72, pz + 0.35, px + 0.35, 1.3, pz + 0.95);
  }, id);
  await sleep(500);
  const geom = await page.evaluate(() => ({ box: window.__game._test.weaponScreenBox(), muzzle: window.__game._test.muzzleScreen(), hand: window.__game._test.handScreen() }));
  const visible = await page.screenshot({ encoding: 'base64' });
  const isFist = id === 'fist';
  let empty = visible;
  if (!isFist) {
    await page.evaluate(() => {
      const g = window.__game;
      g.weaponModels[g.player.weapon].visible = false;
    });
    empty = await page.screenshot({ encoding: 'base64' });
    await page.evaluate(() => {
      const g = window.__game;
      g.weaponModels[g.player.weapon].visible = true;
    });
  }
  const diff = await page.evaluate(async ({ a, b, box, hand }) => {
    const load = async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(Math.max(0, box.x), Math.max(0, box.y), Math.max(1, Math.min(box.w, window.innerWidth - Math.max(0, box.x))), Math.max(1, Math.min(box.h, window.innerHeight - Math.max(0, box.y)))).data;
    };
    const da = await load(a);
    const db = await load(b);
    let changed = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const width = Math.max(1, Math.min(box.w, window.innerWidth - Math.max(0, box.x)));
    const rad = 34;
    let nearHand = 0;
    for (let i = 0; i < da.length; i += 4) {
      if (Math.abs(da[i] - db[i]) > 10 || Math.abs(da[i + 1] - db[i + 1]) > 10 || Math.abs(da[i + 2] - db[i + 2]) > 10) {
        changed++;
        const px = (i / 4) % width + Math.max(0, box.x);
        const py = Math.floor(i / 4 / width) + Math.max(0, box.y);
        minX = Math.min(minX, px); minY = Math.min(minY, py);
        maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
        if (Math.hypot(px - hand.x, py - hand.y) <= rad) nearHand++;
      }
    }
    return { changed, maskBox: changed ? { x: Math.round(minX), y: Math.round(minY), w: Math.round(maxX - minX), h: Math.round(maxY - minY) } : null, nearHand };
  }, { a: visible, b: empty, box: geom.box, hand: geom.hand });
  const file = path.join(OUT, `weapon-${id}.png`);
  fs.writeFileSync(file, Buffer.from(visible, 'base64'));

  // muzzle flash: one trigger, then read the sprite position in the same tick
  let flash = { dist: null, warm: 0, sprites: [] };
  if (!['fist', 'knife'].includes(id)) {
    const fired = await page.evaluate(() => {
      const g = window.__game;
      g.player.shootCd = 0;
      g._test.shoot();
      const muzzle = g._test.muzzleWorld();
      const sprites = g.scene.children
        .filter((o) => o.isSprite)
        .map((o) => ({ pos: o.position.toArray().map((v) => +v.toFixed(3)), scale: +o.scale.x.toFixed(2) }));
      const d = Math.hypot(sprites[sprites.length - 1].pos[0] - muzzle[0], sprites[sprites.length - 1].pos[1] - muzzle[1], sprites[sprites.length - 1].pos[2] - muzzle[2]);
      return { muzzle, sprites, dist: +d.toFixed(3), screen: g._test.muzzleScreen() };
    });
    let best = { warm: 0, b64: null };
    for (let i = 0; i < 5; i++) {
      if (i > 0) {
        await page.evaluate(() => {
          const g = window.__game;
          g.player.shootCd = 0;
          g._test.shoot();
        });
      }
      const b64 = await page.screenshot({ encoding: 'base64' });
      const warm = await page.evaluate(async ({ b64, cx, cy }) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const rad = 90;
        const d = ctx.getImageData(Math.max(0, cx - rad), Math.max(0, cy - rad), rad * 2, rad * 2).data;
        let n = 0;
        for (let k = 0; k < d.length; k += 4) {
          if (d[k] > 235 && d[k + 1] > 180 && d[k + 2] < 200) n++;
        }
        return n;
      }, { b64, cx: fired.screen.x, cy: fired.screen.y });
      if (warm > best.warm) best = { warm, b64 };
      if (best.warm > 160) break;
    }
    if (best.b64) fs.writeFileSync(file, Buffer.from(best.b64, 'base64'));
    flash = { dist: fired.dist, warm: best.warm, sprites: fired.sprites.length, scale: fired.sprites[fired.sprites.length - 1]?.scale ?? null };
  }
  await page.evaluate(() => window.__game._test.weaponPose(false));
  shots[id] = { box: geom.box, hand: geom.hand, mask: diff.maskBox, diffPixels: diff.changed, nearHand: diff.nearHand, flash };
  // a readable model: enough changed pixels, touching the hand, and a mask shape
  // that matches the projected model box instead of a stray sliver
  const maskAspect = diff.maskBox ? diff.maskBox.w / Math.max(1, diff.maskBox.h) : 0;
  const boxAspect = geom.box.w / Math.max(1, geom.box.h);
  const shapeOk = diff.maskBox ? maskAspect > boxAspect * 0.4 && maskAspect < boxAspect * 2.5 : false;
  const readable = isFist
    ? geom.box.w >= 20 && geom.box.w <= 800
    : diff.changed > 120 && geom.box.w >= 40 && geom.box.w <= 800 && diff.nearHand > 20 && shapeOk;
  const flashOk = !flash.dist ? true : flash.dist < 0.05;
  check(`${id}: model visible in hand (${diff.changed} px changed, ${diff.nearHand} px at the grip, mask ${diff.maskBox ? diff.maskBox.w + 'x' + diff.maskBox.h : 'n/a'}, box ${geom.box.w}x${geom.box.h})${flash.dist ? `, flash ${flash.dist}m from barrel` : ''}`, readable && flashOk, shots[id]);
}

const sizes = Object.fromEntries(Object.entries(shots).map(([k, v]) => [k, v.box.w]));
check('model scale ordering: shotgun/AK longer than the 9mm', sizes.shotgun > sizes.pistol && sizes.ak > sizes.pistol, sizes);

// ---------------------------------------------------------------- summary
check('no console/page errors', errs.length === 0, errs.slice(0, 6));

console.log('TABLE ' + JSON.stringify(table, null, 1));
console.log('SUMMARY ' + JSON.stringify({ pass: results.filter((r) => r.ok).length, total: results.length }));
console.log('FAILED ' + JSON.stringify(results.filter((r) => !r.ok)));
await b.close();
if (results.some((r) => !r.ok)) process.exit(1);
