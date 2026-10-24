/**
 * The death card must own the input, and the respawn must not leave the session inside a shop.
 *
 * Reported shape (fixed here): pressing E during the 2.9 s card walked the player into the
 * nearest shop. `respawnAfterDeath` then teleported the body to the city spawn without clearing
 * `player.inInterior`, so after the card lifted the session reported `inInterior: true` with the
 * room 600+ m behind it, the prompt read "E — keluar toko (dekat pintu)", the room's colliders
 * replaced the city's (walk through buildings) and `if (!player.inInterior)` in the frame loop
 * kept every ped, traffic car and officer frozen until E was pressed a second time.
 *
 * This suite drives the real key path: a real `keydown` KeyE from Puppeteer, the real damage
 * function for the death, and measures the world afterwards instead of trusting a flag:
 * inInterior, the distance to the room origin, how many room shells are still visible, and
 * whether peds/traffic actually move during 1.2 s of game time.
 */
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}

/** stand 1.4 m outside a shop door, on its outward side, so `nearestShopDoor` accepts it */
function standAtDoor(page, index) {
  return page.evaluate((i) => {
    const g = window.__game;
    const doors = g.city.shopDoors;
    const d = doors[i % doors.length];
    g._test.teleport(d.x + d.nx * 1.4, d.z + d.nz * 1.4);
    return { name: d.name, kind: d.kind, x: +d.x.toFixed(1), z: +d.z.toFixed(1), doors: doors.length };
  }, index);
}

/** the facts the card is judged on, read from the live game rather than from a captured state */
function readSession(page) {
  return page.evaluate(() => {
    const g = window.__game;
    const p = g.player;
    const room = p.inInterior;
    return {
      inInterior: !!room,
      roomKind: room ? room.kind : null,
      roomDistance: room ? +p.pos.distanceTo(room.origin).toFixed(1) : null,
      visibleRooms: g.city.interiors.filter((r) => r.group.visible).length,
      savedPosArmed: p.savedPos !== undefined,
      pos: p.pos.toArray().map((n) => +n.toFixed(2)),
      spawnDistance: +p.pos.distanceTo(g.city.getSpawn()).toFixed(2),
      prompt: g.hud.el.prompt.textContent,
      hp: +p.hp.toFixed(0),
      cardOn: document.getElementById('wasted-screen').classList.contains('on'),
      dyingGate: !!document.body.classList.contains('wasted'),
      simTime: g.state.simTime,
    };
  });
}

/** one sample of every mover the interior gate freezes */
function sampleWorld(page) {
  return page.evaluate(() => {
    const g = window.__game;
    return {
      sim: g.state.simTime,
      peds: g.peds.peds.map((p) => [+p.pos.x.toFixed(2), +p.pos.z.toFixed(2)]),
      traffic: g.traffic.cars.map((e) => [+e.car.pos.x.toFixed(2), +e.car.pos.z.toFixed(2)]),
      police: g.police.cars.map((e) => [+e.car.pos.x.toFixed(2), +e.car.pos.z.toFixed(2)]),
    };
  });
}

function movedCount(a, b, min) {
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]) > min) n++;
  }
  return n;
}

(async () => {
  const b = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
    defaultViewport: { width: 1400, height: 900 },
  });
  const page = await b.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto((process.env.DTA_URL || 'http://127.0.0.1:8765') + '/index.html', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction('window.__game !== undefined', { timeout: 40000 });
  await sleep(1500);
  await page.click('#start-btn');
  await sleep(2500);

  // ---------------------------------------------------------------- control: E still works when alive
  const door = await standAtDoor(page, 0);
  await sleep(300);
  await page.keyboard.press('KeyE');
  await sleep(250);
  let alive = await readSession(page);
  check('E enters a shop while alive', alive.inInterior, { door: door.name, inInterior: alive.inInterior });
  await page.keyboard.press('KeyE');
  await sleep(250);
  const walked = await readSession(page);
  check('E leaves the shop while alive', !walked.inInterior, { inInterior: walked.inInterior, rooms: walked.visibleRooms });

  // ---------------------------------------------------------------- die beside the shop, press E during the card
  const door2 = await standAtDoor(page, 1);
  await sleep(300);
  await page.keyboard.press('KeyE');
  await sleep(250);
  await page.keyboard.press('KeyE'); // leave again: death must happen in the street, beside the door
  await sleep(250);
  const street = await readSession(page);
  const deathAt = Date.now();
  await page.evaluate(() => window.__game._test.hurt(500));
  await sleep(180);
  const cardUp = await readSession(page);
  check('the death card is up before E is pressed', cardUp.cardOn && cardUp.hp === 0, { cardOn: cardUp.cardOn, hp: cardUp.hp, door: door2.name });

  await page.keyboard.press('KeyE');
  const pressedAt = Date.now() - deathAt;
  await sleep(180);
  const midCard = await readSession(page);
  check(
    'E during the card does not enter the shop',
    !midCard.inInterior,
    { msAfterDeath: pressedAt, cardStillOn: midCard.cardOn, inInterior: midCard.inInterior, roomDistance: midCard.roomDistance },
  );
  check('the card is still up when the key is read', midCard.cardOn, { msAfterDeath: pressedAt, cardOn: midCard.cardOn });

  // the respawn runs under the black at 2.61 s, the card lifts at 2.9 s
  await page.waitForFunction(() => !document.getElementById('wasted-screen').classList.contains('on'), { timeout: 20000 });
  await sleep(400);
  const after = await readSession(page);

  check('respawn leaves no interior reference', !after.inInterior, { inInterior: after.inInterior, roomKind: after.roomKind, roomDistance: after.roomDistance });
  check('respawn shows no room shell', after.visibleRooms === 0, { visibleRooms: after.visibleRooms });
  check('respawn drops the door-side anchor', !after.savedPosArmed, { savedPosArmed: after.savedPosArmed });
  check('respawn puts the body back on the street spawn', after.spawnDistance < 1.0, { pos: after.pos, spawnDistance: after.spawnDistance });
  check('the shop exit prompt is gone', !/keluar toko/i.test(after.prompt), { prompt: after.prompt });

  // ---------------------------------------------------------------- the world must run again
  const s1 = await sampleWorld(page);
  await page.waitForFunction((s) => window.__game.state.simTime >= s + 1.2, { timeout: 30000 }, s1.sim);
  const s2 = await sampleWorld(page);
  const movedPeds = movedCount(s1.peds, s2.peds, 0.05);
  const movedTraffic = movedCount(s1.traffic, s2.traffic, 0.2);
  const movedPolice = movedCount(s1.police, s2.police, 0.2);
  check('peds move again after respawn', movedPeds > 0, { movedPeds, peds: s1.peds.length, simulatedSeconds: +(s2.sim - s1.sim).toFixed(2) });
  check('traffic moves again after respawn', movedTraffic > 0, { movedTraffic, cars: s1.traffic.length, policeMoved: movedPolice });

  console.log('SESSION', JSON.stringify({
    pressedDuringCard: { interrupted: !midCard.inInterior, msAfterDeath: pressedAt },
    afterRespawn: {
      inInterior: after.inInterior,
      roomDistance: after.roomDistance,
      visibleRooms: after.visibleRooms,
      pedsFrozen: movedPeds === 0,
      trafficFrozen: movedTraffic === 0,
      movedPeds,
      movedTraffic,
      prompt: after.prompt,
    },
  }));

  // ---------------------------------------------------------------- busted takes the same teleport-out rule
  const door3 = await standAtDoor(page, 2);
  await sleep(300);
  await page.keyboard.press('KeyE');
  await sleep(250);
  const inShop = await readSession(page);
  check('a shop can still be entered after a respawn', inShop.inInterior, { door: door3.name, inInterior: inShop.inInterior });
  await page.evaluate(() => window.__game._test.busted());
  await sleep(250);
  const arrested = await readSession(page);
  check('busted clears the interior', !arrested.inInterior && arrested.visibleRooms === 0, { inInterior: arrested.inInterior, visibleRooms: arrested.visibleRooms });

  check('no page errors', errs.length === 0, errs.slice(0, 4));

  const failed = results.filter((r) => !r.ok);
  console.log('SUMMARY', JSON.stringify({ pass: results.length - failed.length, total: results.length }));
  await b.close();
  if (failed.length) {
    console.error(`death-interior: ${failed.length}/${results.length} checks failed`);
    process.exitCode = 1;
  }
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
