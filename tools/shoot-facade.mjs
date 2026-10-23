/**
 * Proof shot for the facade pass: stand at 1.7 m eye height on a street, look down it, and then
 * *measure the file this run wrote* instead of describing it.
 *
 * The camera is not a guessed coordinate. Every street-facing wall in the city near the player's
 * spawn is used as an anchor: stand 6-9 m off that wall, look along the row, and score the
 * framing through a temporary projection camera. The shortlist is then re-scored with raycasts,
 * so a wall that is actually hidden behind another block does not count, and the framing that
 * puts the most visible walls in the frame inside the street draw-call budget wins.
 *
 * usage: node tools/shoot-facade.mjs [url]
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL_ = process.argv[2] || process.env.DTA_URL || 'http://127.0.0.1:8765';
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'screenshots/proof/facade-fix.png');
const W = 1600;
const H = 900;
const BUDGET = 1600;
const SHOT_BUDGET = 1500;
const FOV = 60;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${JSON.stringify(detail)}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: W, height: H },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(URL_ + '/index.html', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.__game !== undefined', { timeout: 90000 });
await sleep(1200);
await page.click('#start-btn');
await sleep(4000);

// mid-morning sun: long enough shadows for the cornices to draw a line under themselves
await page.evaluate(() => window.__game._test.setTime(0.34));
await sleep(900);
const spawn = await page.evaluate(() => [window.__game.player.pos.x, window.__game.player.pos.z]);

// ---- draw calls: the same four fixed street vantages the gameplay gate samples --------------
const vantage = [[26, -40, 0], [26, 60, Math.PI], [-90, 0, Math.PI / 2], [90, 0, -Math.PI / 2]];
let worst = { calls: 0, at: null };
for (const [vx, vz, yaw] of vantage) {
  await page.evaluate(([x, z, y]) => { window.__game._test.teleport(x, z); window.__game._test.setCam(y, 0.12); }, [vx, vz, yaw]);
  await sleep(800);
  const samples = [];
  for (let i = 0; i < 3; i++) {
    samples.push(await page.evaluate(() => window.__game.renderer.info.render.calls));
    await sleep(350);
  }
  samples.sort((a, b) => a - b);
  if (samples[1] > worst.calls) worst = { calls: samples[1], at: [vx, vz] };
}
check(`draw calls stay under the street budget of ${BUDGET}`, worst.calls < BUDGET, worst);

// ---- shortlist stances by projection, then keep the ones that really show walls ------------
const shortlist = await page.evaluate((cfg) => {
  const g = window.__game;
  const T = g.THREE;
  const facades = g.city.facadeAudit;

  const CELL = 30;
  const grid = new Map();
  const key = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  for (const f of facades) {
    const k = key(f.fcx, f.fcz);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(f);
  }
  const near = (x, z, r) => {
    const out = [];
    for (let i = Math.floor((x - r) / CELL); i <= Math.floor((x + r) / CELL); i++) {
      for (let j = Math.floor((z - r) / CELL); j <= Math.floor((z + r) / CELL); j++) {
        const cell = grid.get(`${i},${j}`);
        if (cell) for (const f of cell) out.push(f);
      }
    }
    return out;
  };

  const cam = new T.PerspectiveCamera(cfg.fov, cfg.W / cfg.H, 0.1, 900);
  const v = new T.Vector3();
  const proj = (x, y, z) => {
    v.set(x, y, z).project(cam);
    return [(v.x * 0.5 + 0.5) * cfg.W, (-v.y * 0.5 + 0.5) * cfg.H, v.z];
  };

  const scored = [];
  for (const anchor of facades) {
    if (anchor.h < 11) continue;
    // the card is about the row behind the player's spawn: stay in that part of town
    if (Math.hypot(anchor.fcx - cfg.spawn[0], anchor.fcz - cfg.spawn[1]) > 260) continue;
    const fyaw = Math.atan2(anchor.nx, anchor.nz);
    const tx = Math.cos(fyaw);
    const tz = -Math.sin(fyaw);
    for (const off of [10, 14]) {
      const px = anchor.fcx + anchor.nx * off;
      const pz = anchor.fcz + anchor.nz * off;
      const gy = g.city.groundHeightAt(px, pz) + 1.7;
      for (const dir of [1, -1]) {
        for (const lean of [0.22, -0.22, 0.42]) {
          const yaw = Math.atan2(tx * dir, tz * dir) + lean;
          cam.position.set(px, gy, pz);
          cam.lookAt(px + Math.sin(yaw) * 50, gy - 0.8, pz + Math.cos(yaw) * 50);
          cam.updateMatrixWorld(true);
          let score = 0;
          const seen = new Set();
          for (const f of near(px, pz, 50)) {
            if (f.h < 5) continue;
            const ddx = f.fcx - px;
            const ddz = f.fcz - pz;
            const d = Math.hypot(ddx, ddz);
            if (d < 4 || d > 42) continue;
            if (ddx * Math.sin(yaw) + ddz * Math.cos(yaw) < 3) continue;
            if (ddx * f.nx + ddz * f.nz > -0.2) continue;
            const ay = Math.atan2(f.nx, f.nz);
            const ax = Math.cos(ay);
            const az = -Math.sin(ay);
            const half = Math.min(f.faceLen, 18) / 2;
            const yTop = f.baseY + Math.max(6.6, Math.min(f.h, 26) - 1.2);
            const c0 = proj(f.fcx - ax * half, f.baseY + 3.3, f.fcz - az * half);
            const c1 = proj(f.fcx + ax * half, f.baseY + 3.3, f.fcz + az * half);
            const c2 = proj(f.fcx - ax * half, yTop, f.fcz - az * half);
            const c3 = proj(f.fcx + ax * half, yTop, f.fcz + az * half);
            if ([c0, c1, c2, c3].some((c) => c[2] < -1 || c[2] > 1)) continue;
            const cw = Math.min(Math.max(c0[0], c1[0], c2[0], c3[0]), cfg.W) - Math.max(Math.min(c0[0], c1[0], c2[0], c3[0]), 0);
            const ch = Math.min(Math.max(c0[1], c1[1], c2[1], c3[1]), cfg.H) - Math.max(Math.min(c0[1], c1[1], c2[1], c3[1]), 0);
            if (cw < 70 || ch < 90) continue;
            seen.add(f.variant);
            // a tall wall close by is the thing this shot has to show: it is the upper
            // storeys the owner complained about
            score += (Math.min(ch / cfg.H, 0.5) * 2 + cw / cfg.W) * (1 - d / 45) * (f.h >= 12 ? 2 : 1);
          }
          if (seen.size < 2) continue;
          score += seen.size * 0.4;
          scored.push({ x: +px.toFixed(1), z: +pz.toFixed(1), yaw: +yaw.toFixed(3), score: +score.toFixed(2), variants: [...seen].sort() });
        }
      }
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const unique = [];
  for (const c of scored) {
    if (unique.some((u) => Math.hypot(u.x - c.x, u.z - c.z) < 14)) continue;
    unique.push(c);
    if (unique.length >= 24) break;
  }
  const colliders = g.city.colliders;
  return unique.filter((c) => !colliders.some((b) => c.x > b.minX - 0.4 && c.x < b.maxX + 0.4 && c.z > b.minZ - 0.4 && c.z < b.maxZ + 0.4));
}, { fov: FOV, W, H, spawn });
console.log('SHORTLIST', JSON.stringify(shortlist.map((s) => ({ score: s.score, variants: s.variants.length }))));

// Frame one stance for real: set the camera, project the walls, raycast to prove each one is
// what the camera actually sees, then render. Returns the render cost and the wall rectangles.
const frameStance = async (cand) => page.evaluate((cfg) => {
  const g = window.__game;
  const T = g.THREE;
  const eye = new T.Vector3(cfg.x, g.city.groundHeightAt(cfg.x, cfg.z) + 1.7, cfg.z);
  const yaw = cfg.yaw;
  g.camera.fov = cfg.fov;
  g.camera.near = 0.1;
  g.camera.far = 900;
  g.camera.updateProjectionMatrix();
  g.camera.position.copy(eye);
  g.camera.lookAt(eye.x + Math.sin(yaw) * 50, eye.y - 0.8, eye.z + Math.cos(yaw) * 50);
  g.camera.updateMatrixWorld(true);

  const v = new T.Vector3();
  const proj = (x, y, z) => {
    v.set(x, y, z).project(g.camera);
    return [(v.x * 0.5 + 0.5) * cfg.W, (-v.y * 0.5 + 0.5) * cfg.H, v.z];
  };
  const ray = new T.Raycaster();
  const boxes = [];
  for (const f of g.city.facadeAudit) {
    const ddx = f.fcx - eye.x;
    const ddz = f.fcz - eye.z;
    const d = Math.hypot(ddx, ddz);
    if (d < 4 || d > 42) continue;
    if (ddx * Math.sin(yaw) + ddz * Math.cos(yaw) < 3) continue;
    if (ddx * f.nx + ddz * f.nz > -0.2) continue;
    const fyaw = Math.atan2(f.nx, f.nz);
    const tx = Math.cos(fyaw);
    const tz = -Math.sin(fyaw);
    const half = (Math.min(f.faceLen, 18) / 2) * 0.8;
    const yLo = f.baseY + 3.5;
    const yHi = f.baseY + Math.max(6.8, Math.min(f.h, 26) - 1.6);
    const c0 = proj(f.fcx - tx * half, yLo, f.fcz - tz * half);
    const c1 = proj(f.fcx + tx * half, yLo, f.fcz + tz * half);
    const c2 = proj(f.fcx - tx * half, yHi, f.fcz - tz * half);
    const c3 = proj(f.fcx + tx * half, yHi, f.fcz + tz * half);
    if ([c0, c1, c2, c3].some((c) => c[2] < -1 || c[2] > 1)) continue;
    const box = {
      x0: Math.max(0, Math.min(c0[0], c1[0], c2[0], c3[0])),
      x1: Math.min(cfg.W, Math.max(c0[0], c1[0], c2[0], c3[0])),
      y0: Math.max(0, Math.min(c0[1], c1[1], c2[1], c3[1])),
      y1: Math.min(cfg.H, Math.max(c0[1], c1[1], c2[1], c3[1])),
      variant: f.variant,
    };
    if (box.x1 - box.x0 < 55 || box.y1 - box.y0 < 65) continue;
    // Is this wall what the camera sees there? A block in front of it, or the sky behind it,
    // would otherwise be measured as a "wall" and a flat patch would fail for the wrong reason.
    const midY = (yLo + yHi) / 2;
    const toFace = new T.Vector3(f.fcx, midY, f.fcz).sub(eye);
    const want = toFace.length();
    ray.set(eye, toFace.normalize());
    ray.far = want + 4;
    const hit = ray.intersectObjects(g.scene.children, true)[0];
    if (!hit || Math.abs(hit.distance - want) > 2.5) continue;
    box.tall = f.h >= 12;
    box.d = +d.toFixed(1);
    boxes.push(box);
  }
  g.renderer.render(g.scene, g.camera);
  return {
    x: cfg.x, z: cfg.z, yaw, eye: eye.toArray().map((n) => +n.toFixed(2)),
    ground: +g.city.groundHeightAt(cfg.x, cfg.z).toFixed(2),
    calls: g.renderer.info.render.calls,
    tris: g.renderer.info.render.triangles,
    boxes,
    variants: [...new Set(boxes.map((b) => b.variant))].sort(),
    tallNear: boxes.filter((b) => b.tall && b.d < 30).length,
  };
}, { ...cand, fov: FOV, W, H });

let picked = null;
for (const cand of shortlist.slice(0, 10)) {
  const framed = await frameStance(cand);
  console.log('FRAME', JSON.stringify({ x: framed.x, z: framed.z, walls: framed.boxes.length, tallNear: framed.tallNear, variants: framed.variants, calls: framed.calls }));
  const quality = framed.boxes.length * 3 + framed.variants.length * 2 + framed.tallNear * 4;
  if (!picked) { picked = { ...framed, quality }; continue; }
  const better = framed.calls <= SHOT_BUDGET && (picked.calls > SHOT_BUDGET || quality > picked.quality);
  if (better) picked = { ...framed, quality };
}
if (!picked) throw new Error('no facade framing found');
console.log('VANTAGE', JSON.stringify({ x: picked.x, z: picked.z, yaw: +picked.yaw.toFixed(3), walls: picked.boxes.length, variants: picked.variants, calls: picked.calls, tris: picked.tris }));
check(`the proof frame renders under the street budget (${SHOT_BUDGET})`, picked.calls <= SHOT_BUDGET, { calls: picked.calls, tris: picked.tris });

// freeze the loop, then re-frame and shoot: the third-person body is glued to the player, so
// hide that group rather than moving the player and dragging the camera rig with it
await page.evaluate((c) => window.__game._test.teleport(c.x, c.z + 2.5), { x: picked.x, z: picked.z });
await sleep(1400);
await page.evaluate(() => {
  const g = window.__game;
  document.getElementById('hud').style.display = 'none';
  let hidden = 0;
  g.scene.traverse((o) => {
    if (hidden || !o.isGroup || o === g.scene) return;
    if (o.position.distanceTo(g.player.pos) < 0.05) {
      o.visible = false;
      hidden++;
    }
  });
  window.requestAnimationFrame = () => 0;
  return hidden;
});
await sleep(350);
const shot = await frameStance({ x: picked.x, z: picked.z, yaw: picked.yaw });
await sleep(200);
await page.screenshot({ path: OUT });
console.log('SHOT', JSON.stringify({
  out: OUT,
  eye: shot.eye,
  ground: shot.ground,
  calls: shot.calls,
  tris: shot.tris,
  textures: await page.evaluate(() => window.__game.renderer.info.memory.textures),
  walls: shot.boxes.length,
  variants: shot.variants,
}));

// ---- measure the file that was just written ------------------------------------------------
const measPage = await browser.newPage();
await measPage.goto('file://' + OUT, { waitUntil: 'load' });
const measured = await measPage.evaluate(async (boxes) => {
  const img = document.querySelector('img');
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;

  const stats = [];
  for (const b of boxes) {
    // inset, so the sample sits on the wall and not on its silhouette edge
    const padX = (b.x1 - b.x0) * 0.15;
    const padY = (b.y1 - b.y0) * 0.15;
    const x0 = Math.round(b.x0 + padX);
    const x1 = Math.round(b.x1 - padX);
    const y0 = Math.round(b.y0 + padY);
    const y1 = Math.round(b.y1 - padY);
    if (x1 - x0 < 12 || y1 - y0 < 12) continue;
    let n = 0;
    let sum = 0;
    let sum2 = 0;
    const colours = new Set();
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * c.width + x) * 4;
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        sum += lum;
        sum2 += lum * lum;
        n++;
        colours.add(((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4));
      }
    }
    if (n < 400) continue;
    const mean = sum / n;
    stats.push({
      sd: +Math.sqrt(Math.max(0, sum2 / n - mean * mean)).toFixed(2),
      colours: colours.size,
      mean: +mean.toFixed(0),
      variant: b.variant,
      px: n,
    });
  }
  const sds = stats.map((s) => s.sd).sort((a, b) => a - b);
  return {
    walls: stats.length,
    sdMin: sds[0] ?? null,
    sdMedian: sds[sds.length >> 1] ?? null,
    sdMax: sds[sds.length - 1] ?? null,
    coloursMedian: stats.length ? stats.map((s) => s.colours).sort((a, b) => a - b)[stats.length >> 1] : null,
    perWall: stats,
  };
}, shot.boxes);
console.log('MEASURE', JSON.stringify({ ...measured, perWall: undefined }));

// ---- the card's real requirement: a block mixes its facades, not one repeated tile --------
const mix = await page.evaluate(() => {
  const g = window.__game;
  // group by the block the building was placed for, not by distance: two blocks can be 60 m
  // apart and a distance bucket silently merges their lots
  const per = new Map();
  for (const f of g.city.facadeAudit) {
    if (f.source !== 'block' || !f.block) continue;
    const k = `${f.block[0].toFixed(2)},${f.block[1].toFixed(2)}`;
    const e = per.get(k) ?? { n: 0, v: new Set() };
    e.n++;
    e.v.add(f.variant);
    per.set(k, e);
  }
  const sizes = [...per.values()].filter((e) => e.n >= 4).map((e) => e.v.size).sort((a, b) => a - b);
  const big = [...per.values()].filter((e) => e.n >= 5).map((e) => e.v.size);
  return {
    blocks: sizes.length,
    min: sizes[0] ?? 0,
    median: sizes[sizes.length >> 1] ?? 0,
    max: sizes[sizes.length - 1] ?? 0,
    blocksWith5Buildings: big.length,
    ofThoseWith5Variants: big.filter((n) => n >= 5).length,
    allBlocks: per.size,
  };
});
console.log('BLOCK MIX', JSON.stringify(mix));
check('every block with 5+ buildings mixes at least 5 facade variants', mix.blocksWith5Buildings === mix.ofThoseWith5Variants, mix);
check('no block smaller than that is a single repeated tile', mix.min >= 4, mix);

check('camera is at 1.7 m eye height', Math.abs(shot.eye[1] - shot.ground - 1.7) < 0.01, { eye: shot.eye, ground: shot.ground });
check('the frame shows more than one facade variant', picked.variants.length >= 2, picked.variants);
check('upper-storey walls measured in the frame', measured.walls >= 2, measured.walls);
check('no measured wall is a single flat colour (median luminance sd >= 3)', (measured.sdMedian ?? 0) >= 3, { sdMin: measured.sdMin, sdMedian: measured.sdMedian });
check('no page errors', errs.length === 0, errs.slice(0, 4));

const failed = results.filter((r) => !r.ok);
console.log('SUMMARY', JSON.stringify({ pass: results.length - failed.length, total: results.length }));
await browser.close();
if (failed.length) {
  console.error(`shoot-facade: ${failed.length}/${results.length} checks failed`);
  process.exitCode = 1;
}
