// The two halves of "you cannot see yourself in the car, and the people in it never get out".
//
//   A. the player takes a seat: a body wearing *the player's own clothes* is visible in the
//      driver's seat, its head under the roof, both hands on the wheel
//   B. the person who was already in that seat steps out of the car and walks off (they used to
//      blink out of existence the moment the player pressed F)
//   C. a police officer leaves a cruiser: exactly one officer body per door, standing on the road
//      at the car door (not at the world origin, which is what an unpositioned body looks like),
//      and the seat is empty afterwards
//
// usage: node tests/world/occupants.mjs      (honours DTA_URL, starts nothing itself)
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
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
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)));
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction('window.__game !== undefined', { timeout: 120000 });
await page.click('#start-btn');
await sleep(900);

// ---------------------------------------------------------------- A + B: the player's seat
const taken = await page.evaluate(() => {
  const g = window.__game;
  const car = g.cityCars.find((c) => !c.wrecked && c.driver);
  if (!car) return { error: 'no parked car with a driver' };
  g._test.teleport(car.pos.x + 1.3, car.pos.z);
  window.__car = car;
  const hadDriver = !!car.driver;
  g._test.toggleVehicle();
  return {
    hadDriver,
    inCar: g.player.inCar === car,
    type: car.type,
    car: { x: +car.pos.x.toFixed(2), z: +car.pos.z.toFixed(2), width: car.width },
    playerLook: g._test.playerLook(),
  };
});
await sleep(350);

const seated = await page.evaluate(() => {
  const g = window.__game;
  const T = g.THREE;
  const car = g.player.inCar;
  if (!car) return { error: 'not in the car' };
  const body = car.driver;
  if (!body) return { error: 'the seat is empty while the player is driving' };
  car.mesh.updateMatrixWorld(true);
  const meshes = [];
  body.traverse((o) => {
    if (o.isMesh && o.visible) meshes.push(o);
  });
  // the cabin shell is every child of the car body except the person in the seat
  const shell = new T.Box3();
  for (const child of car.mesh.children) {
    if (child === body) continue;
    shell.expandByObject(child);
  }
  const headBox = new T.Box3().setFromObject(body.children[1]);
  const hairBox = new T.Box3().setFromObject(body.children[2]);
  // the wheel, in the car body's own space, is where the two hands have to be
  const wheel = car.wheelAnchor ? car.wheelAnchor.clone().applyMatrix4(car.mesh.matrixWorld) : null;
  const hands = [];
  for (const m of meshes) {
    if (!m.userData.hand) {
      continue;
    }
    const p = new T.Vector3();
    m.getWorldPosition(p);
    hands.push({ toWheel: wheel ? +p.distanceTo(wheel).toFixed(3) : null, y: +p.y.toFixed(2) });
  }
  return {
    meshes: meshes.length,
    visible: body.visible === true,
    headTop: +headBox.max.y.toFixed(3),
    hairTop: +hairBox.max.y.toFixed(3),
    roof: +shell.max.y.toFixed(3),
    headClearance: +(shell.max.y - headBox.max.y).toFixed(3),
    hairClearance: +(shell.max.y - hairBox.max.y).toFixed(3),
    shirt: '#' + body.children[0].material.color.getHexString(),
    skin: '#' + body.children[1].material.color.getHexString(),
    hands,
    inCabin: shell.containsPoint(headBox.getCenter(new T.Vector3())),
  };
});

const look = taken.playerLook || [];
const shirtHex = '#' + (look[1] ?? 0).toString(16).padStart(6, '0');
const skinHex = '#' + (look[0] ?? 0).toString(16).padStart(6, '0');
check(
  'a body is visible in the driver seat while the player drives',
  taken.inCar && seated.visible && seated.meshes >= 3,
  { car: taken.car, type: taken.type, meshes: seated.meshes, visible: seated.visible }
);
check(
  'the seated body wears the player own shirt and skin',
  seated.shirt === shirtHex && seated.skin === skinHex,
  { seated: { shirt: seated.shirt, skin: seated.skin }, player: { shirt: shirtHex, skin: skinHex } }
);
check(
  'its head stays below the roof, with a measured clearance',
  seated.headClearance > 0 && seated.hairClearance > 0 && seated.inCabin,
  { headClearance: seated.headClearance, hairClearance: seated.hairClearance, headTop: seated.headTop, roof: seated.roof }
);
check(
  'both hands are on the wheel',
  seated.hands.length === 2 && seated.hands.every((h) => h.toWheel !== null && h.toWheel < 0.12),
  { hands: seated.hands }
);

const steppedOut = await page.evaluate(() => {
  const g = window.__game;
  const car = window.__car;
  const outs = g._test.stepOuts();
  const dx = (o) => Math.hypot(o.x - car.pos.x, o.z - car.pos.z);
  const dxFrom = (o) => Math.hypot(o.fromX - car.pos.x, o.fromZ - car.pos.z);
  return {
    count: outs.length,
    out: outs.map((o) => ({
      doorDist: +dxFrom(o).toFixed(2),
      dist: +dx(o).toFixed(2),
      // the sole, not the group origin: the walk cycle lifts the body off the road on purpose
      soleGap: +(o.sole - g.city.groundHeightAt(o.x, o.z)).toFixed(3),
    })),
    doorGap: +(car.width * 0.5 + 0.55).toFixed(2),
    seat: !car.driver,
  };
});
// A headless tab runs at a handful of frames a second on this scene, so waiting on wall clock
// measures swiftshader, not the walk: step the game's own update instead (same function the
// frame loop calls) and check the body actually travels away from the door.
const walked = await page.evaluate(() => {
  const g = window.__game;
  const car = window.__car;
  const d = (o) => Math.hypot(o.x - car.pos.x, o.z - car.pos.z);
  const before = g._test.stepOuts().map(d);
  g._test.tickDriveOuts(60, 1 / 60);
  const after = g._test.stepOuts().map(d);
  return { count: after.length, before: before.map((v) => +v.toFixed(2)), after: after.map((v) => +v.toFixed(2)) };
});
check(
  'the driver who was in the seat steps out at the door instead of vanishing',
  steppedOut.count === 1 &&
    Math.abs(steppedOut.out[0].doorDist - steppedOut.doorGap) < 0.05 &&
    Math.abs(steppedOut.out[0].soleGap) < 0.06,
  steppedOut
);
check(
  'that driver walks away from the car',
  walked.count === 1 && walked.after[0] > walked.before[0] + 1.5,
  walked
);

// ---------------------------------------------------------------- C: the officer leaves the car
const crew = await page.evaluate(async () => {
  const g = window.__game;
  const T = g.THREE;
  // a cruiser of our own, parked where the player is standing
  const entry = g.police.spawnCar(g.player.pos, 0);
  if (!entry) return { error: 'no cruiser' };
  const car = entry.car;
  car.speed = 0;
  for (const o of [...g.police.officers]) g.police.killOfficer(o);
  const seatBefore = !!car.driver;
  // no frame between the exit and the measurement: the officers walk off the door on later frames
  const officers = g.police.exitCrew(car);
  // a body stands at a front door: beside the hull, on the road, near the car
  const doorGap = car.width * 0.5 + 0.55;
  const bodies = g.police.officers.map((o) => {
    const lateral = Math.hypot(o.pos.x - car.pos.x, o.pos.z - car.pos.z);
    return {
      lateral: +lateral.toFixed(2),
      y: +o.pos.y.toFixed(2),
      ground: +g.city.groundHeightAt(o.pos.x, o.pos.z).toFixed(2),
      origin: +Math.hypot(o.pos.x, o.pos.z).toFixed(2),
      inScene: o.group.parent === g.scene,
      meshes: (() => {
        let n = 0;
        o.group.traverse((m) => {
          if (m.isMesh && m.visible) n++;
        });
        return n;
      })(),
    };
  });
  // ... and one officer for one door, which is the check the card asks for
  const solo = g.police.exitOfficerFromDoor(car, 1);
  const soloCount = g.police.officers.length;
  const soloLateral = Math.hypot(solo.pos.x - car.pos.x, solo.pos.z - car.pos.z);
  void T;
  return {
    seatBefore,
    seatAfter: !car.driver,
    doorGap: +doorGap.toFixed(2),
    made: officers.length,
    bodies,
    soloCount,
    soloLateral: +soloLateral.toFixed(2),
    soloY: +solo.pos.y.toFixed(2),
  };
});

const atDoor = (b, gap) => Math.abs(b.lateral - gap) < 0.35 && b.origin > 1.0 && Math.abs(b.y - b.ground) < 0.35;
check(
  'a police officer who leaves the cruiser has a body standing at the car door',
  crew.bodies && crew.bodies.length >= 1 && crew.bodies.every((b) => b.inScene && b.meshes >= 12 && atDoor(b, crew.doorGap)),
  { doorGap: crew.doorGap, bodies: crew.bodies }
);
check(
  'one door, one officer body: not zero, not a body left at the origin',
  crew.soloCount === crew.made + 1 && Math.abs(crew.soloLateral - crew.doorGap) < 0.35,
  { made: crew.made, soloCount: crew.soloCount, soloLateral: crew.soloLateral, doorGap: crew.doorGap }
);
check(
  'the cruiser seat empties when the crew gets out',
  crew.seatBefore && crew.seatAfter,
  { seatBefore: crew.seatBefore, seatAfter: crew.seatAfter }
);

console.log('SUMMARY ' + JSON.stringify({ pass: checks.filter((c) => c.ok).length, total: checks.length }));
await browser.close();
if (checks.some((c) => !c.ok)) process.exitCode = 1;
