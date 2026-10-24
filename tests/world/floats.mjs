
import { launch, bootGate, crash, suiteStart } from '../_harness.mjs';

const SUITE = 'world/floats';
suiteStart(SUITE);
try {
// No part of a car may float away from the body: every mesh has to touch, or overlap, at
// least one other mesh. This is the check that catches "komponen mobil melayang".

const CHROME = '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL = process.env.DTA_URL || 'http://127.0.0.1:8765/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 700 });
await page.bringToFront();
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await bootGate(page);
await page.click('#start-btn');
await sleep(700);

const report = await page.evaluate(() => {
  const g = window.__game;
  const T = g.THREE;
  const cars = [...g.cityCars, ...g.traffic.cars.map((e) => e.car), ...g.police.cars.map((e) => e.car)];
  const seen = new Set();
  const out = [];
  for (const c of cars) {
    if (seen.has(c.type)) continue;
    seen.add(c.type);
    c.mesh.updateMatrixWorld(true);
    const boxes = [];
    c.mesh.traverse((o) => {
      if (o.isMesh) boxes.push(new T.Box3().setFromObject(o));
    });
    let worst = 0;
    let worstSize = null;
    for (let i = 0; i < boxes.length; i++) {
      let minGap = Infinity;
      for (let j = 0; j < boxes.length; j++) {
        if (i === j) continue;
        const a = boxes[i];
        const b = boxes[j];
        const dx = Math.max(0, Math.max(a.min.x - b.max.x, b.min.x - a.max.x));
        const dy = Math.max(0, Math.max(a.min.y - b.max.y, b.min.y - a.max.y));
        const dz = Math.max(0, Math.max(a.min.z - b.max.z, b.min.z - a.max.z));
        minGap = Math.min(minGap, Math.hypot(dx, dy, dz));
      }
      if (minGap > worst) {
        worst = minGap;
        worstSize = boxes[i].getSize(new T.Vector3()).toArray().map((v) => +v.toFixed(2));
      }
    }
    out.push({ car: c.type, parts: boxes.length, worstGap: +worst.toFixed(3), worstSize });
  }
  return out;
});

const checks = [];
const check = (name, ok, info) => {
  checks.push({ name, ok: !!ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${JSON.stringify(info)}`);
};

for (const row of report) {
  check(`${row.car}: every part touches the car`, row.worstGap <= 0.04, row);
}
check('all car types were inspected', report.length >= 5, { types: report.map((r) => r.car) });

console.log('SUMMARY ' + JSON.stringify({ pass: checks.filter((c) => c.ok).length, total: checks.length }));
await browser.close();

} catch (err) {
  await crash(SUITE, err);
}
