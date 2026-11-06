// A crash must never fill the frame with one colour. This drives the real crash path (the car's
// own collision in Car.update) and samples what the renderer actually puts on screen for 2 s of
// game time after the hit.
//
//   node tests/world/crash-frame.mjs            one crash, the acceptance run
//   CRASH_SWEEP=1 node tests/world/crash-frame.mjs   sweep a matrix of crashes and report the worst
//
// A "blue" pixel is the sky/fog family (#35a8f0 and the blue paint that would fill the frame the
// same way): b >= 140, b - r >= 70, b - g >= 30. The frame must never be more than half blue.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL = process.env.DTA_URL || 'http://localhost:8765/';
const SWEEP = !!process.env.CRASH_SWEEP;
const PROOF = process.env.CRASH_PROOF || 'screenshots/proof/crash-frame.png';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, info) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info !== undefined ? ' :: ' + JSON.stringify(info) : ''}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage();
await page.setViewport({ width: 640, height: 360 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction('window.__game !== undefined', { timeout: 180000 });
await page.click('#start-btn');
await sleep(1500);

// ---- the sampler: one histogram per animation frame, installed once -------------------------
await page.evaluate(() => {
  const g = window.__game;
  const W = 160;
  const H = 90;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const st = { on: false, frames: [], t0: 0, hitAt: null };
  window.__crash = st;
  window.__startCrashSampler = () => {
    st.on = true;
    st.frames = [];
    st.t0 = g.state.simTime;
    st.hitAt = null;
    let prevSpeed = null;
    const loop = () => {
      if (!st.on) return;
      requestAnimationFrame(loop);
      ctx.drawImage(g.renderer.domElement, 0, 0, W, H);
      const d = ctx.getImageData(0, 0, W, H).data;
      const hist = new Map();
      let blue = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i];
        const gg = d[i + 1];
        const b = d[i + 2];
        const k = `${r >> 4},${gg >> 4},${b >> 4}`;
        hist.set(k, (hist.get(k) || 0) + 1);
        if (b >= 140 && b - r >= 70 && b - gg >= 30) blue++;
      }
      const total = W * H;
      const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([k, n]) => ({ colour: k.split(',').map((v) => (Number(v) << 4) + 8), share: +(n / total).toFixed(3) }));
      const ci = ((H >> 1) * W + (W >> 1)) * 4;
      const car = window.Car || null;
      const speed = car ? car.speed : 0;
      // is the camera inside a solid box? from in there every face is backfacing, so the frame
      // has nothing left but the sky (the "screen turns blue" report)
      const cx = g.camera.position.x;
      const cy = g.camera.position.y;
      const cz = g.camera.position.z;
      let inside = false;
      for (const b of g.city.colliders) {
        if (cy > (b.h ?? 30)) continue;
        if (cx > b.minX && cx < b.maxX && cz > b.minZ && cz < b.maxZ) { inside = true; break; }
      }
      const f = {
        sim: +g.state.simTime.toFixed(2),
        speed: +speed.toFixed(1),
        hp: Math.round(g.state.hp),
        blue: +(blue / total).toFixed(3),
        top,
        centre: [d[ci], d[ci + 1], d[ci + 2]],
        cam: [+cx.toFixed(1), +cy.toFixed(2), +cz.toFixed(1)],
        finite: Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(cz),
        inside,
        calls: g.renderer.info.render.calls,
      };
      st.frames.push(f);
      if (st.hitAt === null && prevSpeed !== null && Math.abs(prevSpeed) - Math.abs(speed) > 3) st.hitAt = st.frames.length - 1;
      prevSpeed = speed;
      if (st.frames.length > 1200) st.on = false;
    };
    requestAnimationFrame(loop);
  };
});

const box = await page.evaluate(() => {
  const g = window.__game;
  let b = null;
  for (const c of g.city.colliders) {
    const w = c.maxX - c.minX;
    const d = c.maxZ - c.minZ;
    if (!(c.h > 8) || w < 12 || d < 12) continue;
    if (!b || w * d > (b.maxX - b.minX) * (b.maxZ - b.minZ)) b = c;
  }
  return b;
});
if (!box) {
  console.log('FAIL no building collider in this map');
  await browser.close();
  process.exit(1);
}

/** Stage a car `gap` metres from the -Z face of `box`, at `speed` m/s, nose at the wall. */
async function stage({ gap, speed, yaw = 0, hp = 100, pitch = 0.2, type = null, colour = null }) {
  await page.evaluate((box, o) => {
    const g = window.__game;
    const car = g.cityCars.find((c) => !o.type || c.type === o.type) || g.cityCars[0];
    if (o.colour !== null) { car.color = o.colour; car.rebuild?.(); }
    const cx = (box.minX + box.maxX) / 2;
    const cz = box.minZ - o.gap;
    car.pos.set(cx, 0, cz);
    car.yaw = o.yaw;
    car.speed = 0;
    car.vx = 0; car.vz = 0; car.vy = 0; car.y = 0;
    car.health = 100; car.wrecked = false;
    car.y = g.city.groundHeightAt(cx, cz);
    car.pos.y = car.y;
    g.player.hp = o.hp;
    g._test.teleport(cx + 1.7, cz);
    g._test.setCam(undefined, o.pitch);
    window.Car = car;
    window.__car = car;
  }, box, { gap, speed, yaw, hp, pitch, type, colour });
  await sleep(250);
  if (!(await page.evaluate(() => !!window.__game.player.inCar))) {
    await page.keyboard.press('f');
    await sleep(350);
  }
}

/** Run one staged crash and return the sampled window around the hit. */
async function crash(opts, proofPath = null) {
  await stage(opts);
  // the sampler has to be running before the car is launched, or the hit lands inside the
  // staging sleeps and the window has no impact in it
  await page.evaluate((speed) => {
    window.__startCrashSampler();
    window.Car.speed = speed;
  }, opts.speed);
  const before = await page.evaluate(() => window.__crash.t0);
  // wait for the hit, then 2 s of game time after it
  try {
    await page.waitForFunction(
      () => window.__crash.hitAt !== null || window.__game.state.simTime > window.__crash.t0 + 4,
      { timeout: 60000, polling: 50 }
    );
  } catch (e) {
    /* a crash that never lands is reported by the caller through the sampled frames */
  }
  // the proof frame belongs to the impact itself, not to the settled aftermath
  if (proofPath) {
    fs.mkdirSync(proofPath.replace(/\/[^/]+$/, ''), { recursive: true });
    await page.screenshot({ path: proofPath });
    console.log('PROOF', proofPath);
  }
  try {
    await page.waitForFunction(
      () => {
        const s = window.__crash;
        const last = s.frames[s.frames.length - 1];
        return last && last.sim >= s.t0 + 2.6;
      },
      { timeout: 60000, polling: 50 }
    );
  } catch (e) {
    /* time-boxed: use whatever was sampled */
  }
  const out = await page.evaluate(() => {
    const s = window.__crash;
    s.on = false;
    return { frames: s.frames, hitAt: s.hitAt, t0: s.t0 };
  });
  return { ...out, before };
}

function window_after(res, seconds = 2.0) {
  const f = res.frames;
  const at = res.hitAt ?? Math.max(0, f.length - 1);
  const hitSim = f[at] ? f[at].sim : 0;
  return f.filter((x, i) => i >= at && x.sim <= hitSim + seconds);
}

// ---- the acceptance run --------------------------------------------------------------------
const main = await crash({ gap: 14, speed: 30 }, PROOF || null);
const win = window_after(main, 2.0);
const maxBlue = win.reduce((a, f) => Math.max(a, f.blue), 0);
const worst = win.reduce((a, f) => (f.blue > a.blue ? f : a), win[0] ?? { blue: 0 });
const hitFrame = main.frames[main.hitAt ?? 0];
console.log('CRASH', JSON.stringify({
  hitAt: main.hitAt,
  speedAtHit: hitFrame?.speed,
  hpAfter: hitFrame?.hp,
  frames: win.length,
  simWindow: win.length ? +(win[win.length - 1].sim - win[0].sim).toFixed(2) : 0,
  maxBlue,
  sample: win.filter((_, i) => i % Math.max(1, Math.floor(win.length / 6)) === 0).map((f) => ({ sim: f.sim, blue: f.blue, centre: f.centre, top: f.top[0] })),
}));

check('the car actually hit the wall (a crash happened)', main.hitAt !== null, { hitAt: main.hitAt, frames: main.frames.length });
check('the sample covers 2 s of game time after the impact', win.length > 4 && win[win.length - 1].sim - win[0].sim >= 1.8, {
  covered: win.length ? +(win[win.length - 1].sim - win[0].sim).toFixed(2) : 0,
});
check('blue never takes more than half the frame', maxBlue <= 0.5, { maxBlue, worst: worst.top?.[0] });
check('the camera never leaves the scene', win.every((f) => f.finite), { nonFinite: win.filter((f) => !f.finite).length });
check(
  'the camera is never inside a wall for the 2 s after the hit',
  win.every((f) => !f.inside),
  { framesInside: win.filter((f) => f.inside).length, first: win.find((f) => f.inside) }
);
check('the renderer keeps drawing the world', win.every((f) => f.calls > 20), { minCalls: Math.min(...win.map((f) => f.calls)) });
check('the centre pixel is not the sky/fog colour', !(worst.centre[2] >= 140 && worst.centre[2] - worst.centre[0] >= 70), { centre: worst.centre });
check('the frame stays a scene, not one flat colour', (worst.top?.[0]?.share ?? 1) <= 0.85, { top: worst.top });
check('no page errors during the crash', errors.length === 0, errors.slice(0, 3));

// ---- the crash that puts the wall BEHIND the car -------------------------------------------
// Reversing into a wall is the shape that squeezes the boom against the hard part of the world:
// the car's tail is on the wall, so the camera's own 8.4 m of boom points INTO it.
const back = await crash({ gap: 12, speed: -14, yaw: Math.PI });
const bwin = window_after(back, 2.0);
const bMaxBlue = bwin.reduce((a, f) => Math.max(a, f.blue), 0);
console.log('BACKING', JSON.stringify({
  hitAt: back.hitAt,
  frames: bwin.length,
  maxBlue: bMaxBlue,
  framesInside: bwin.filter((f) => f.inside).length,
  first: bwin.find((f) => f.inside),
}));
check('a crash with the wall behind the car still lands', back.hitAt !== null, { hitAt: back.hitAt });
check('backing into a wall does not leave the camera inside it', bwin.every((f) => !f.inside), {
  framesInside: bwin.filter((f) => f.inside).length,
  first: bwin.find((f) => f.inside),
});
check('backing into a wall stays under half blue', bMaxBlue <= 0.5, { bMaxBlue });

// ---- the sweep: the same crash from many angles, gaps and states ---------------------------
if (SWEEP) {
  const rows = [];
  for (const gap of [6, 14, 26]) {
    for (const yaw of [0, 0.5, -0.7, Math.PI]) {
      for (const pitch of [-0.5, 0.2]) {
        const r = await crash({ gap, speed: 30, yaw, pitch });
        const w = window_after(r, 2.0);
        const b = w.reduce((a, f) => Math.max(a, f.blue), 0);
        rows.push({ gap, yaw, pitch, hit: r.hitAt !== null, n: w.length, maxBlue: +b.toFixed(3) });
        if (b > 0.4) console.log('SUSPECT', JSON.stringify({ gap, yaw, pitch, maxBlue: b, sample: w.slice(0, 6) }));
      }
    }
  }
  rows.sort((a, b) => b.maxBlue - a.maxBlue);
  console.log('SWEEP', JSON.stringify(rows.slice(0, 12)));
}

console.log('SUMMARY ' + JSON.stringify({ pass, total: pass + fail }));
await browser.close();
process.exit(fail ? 1 : 0);
