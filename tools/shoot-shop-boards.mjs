/**
 * The picture for the shop-board card: shopfronts, each named over its own door, taken from a
 * stance the harness SEARCHES for on the built scene.
 *
 * The stance search is the point. Standing where a nice screenshot "should" be put the plates
 * edge-on or behind the camera, and a rect measured from a stale camera is a whole bug class in
 * this repo. So every candidate centre is projected through the real camera, and the winner is the
 * one where the most plates land in frame at a legible size, with the camera square on to a wall
 * rather than down it.
 *
 * The saved PNG is then measured: each plate's projected rect must contain bright ink.
 *
 * Usage: DTA_URL=http://localhost:8951/index.html node tools/shoot-shop-boards.mjs
 */
import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CHROME = '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL = process.env.DTA_URL || 'http://localhost:8951/index.html';
const OUT = process.env.OUT || 'proof/shop-boards.png';
const MIN_W = 45;   // px: a 2.5 m plate at 11 m is ~200 px, so this is "readable at a glance"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  defaultViewport: { width: 1400, height: 900 },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 240000 });
await page.waitForFunction('window.__game !== undefined', { timeout: 180000 });
await sleep(1500);
await page.click('#start-btn');
await sleep(3000);

const pick = await page.evaluate((MIN_W) => {
  const g = window.__game;
  const THREE = g.THREE;
  const city = g.city;
  const cam0 = g.camera;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const signs = city.shopSigns.map((s) => ({ ...s }));
  const facades = city.facadeAudit.filter((f) => f.source === 'frontage' && f.shop);
  // The stance search projects through the REAL camera: a probe clone that disagrees with the
  // render by an aspect or a matrix is exactly how a "plate out of frame" verdict gets invented.
  const cam0fov = cam0.fov;
  const cam0aspect = cam0.aspect;
  const v = new THREE.Vector3();
  const insideBox = (p, pad = 0.4) => city.colliders.some((c) => p.x > c.minX - pad && p.x < c.maxX + pad && p.z > c.minZ - pad && p.z < c.maxZ + pad);
  /** does the segment camera -> point pass through a building? (slab test on the XZ footprint) */
  const blocked = (a, b) => {
    for (const c of city.colliders) {
      let t0 = 0;
      let t1 = 1;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      for (const [p0, d, lo, hi] of [[a.x, dx, c.minX, c.maxX], [a.z, dz, c.minZ, c.maxZ]]) {
        if (Math.abs(d) < 1e-6) { if (p0 < lo || p0 > hi) { t0 = 2; break; } continue; }
        let ta = (lo - p0) / d;
        let tb = (hi - p0) / d;
        if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
        if (t0 > t1) break;
      }
      if (t0 <= t1 && t1 > 0.02 && t0 < 0.98) return true;
    }
    return false;
  };
  const countIn = (cam) => {
    cam0.fov = cam0fov;
    cam0.aspect = cam0aspect;
    cam0.position.set(cam.x, cam.y, cam.z);
    cam0.updateMatrixWorld(true);
    cam0.lookAt(cam.tx, cam.ty, cam.tz);
    cam0.updateMatrixWorld(true);
    const eye = new THREE.Vector3(cam.x, cam.y, cam.z);
    const near = [];
    for (const s of signs) {
      if (Math.abs(s.x - cam.x) > 36 || Math.abs(s.z - cam.z) > 36) continue;
      near.push(s);
    }
    const seen = [];
    for (const s of near) {
      const dist = Math.hypot(s.x - cam.x, s.z - cam.z);
      if (dist > 34 || dist < 6) continue;
      const depth = v.set(s.x, s.y, s.z).clone().applyMatrix4(cam0.matrixWorldInverse).z;
      if (depth > -2) continue;
      const c = v.set(s.x, s.y, s.z).project(cam0);
      // keep plates out of the frame's outer band: a plate at the bottom edge is behind the kerb
      // and a plate at the side edge is half a sign
      if (Math.abs(c.x) > 0.72 || Math.abs(c.y) > 0.6) continue;
      // projected width of a 2.5 m plate at this depth, in pixels
      const a = new THREE.Vector3(s.x - 1.25, s.y, s.z).project(cam0);
      const b = new THREE.Vector3(s.x + 1.25, s.y, s.z).project(cam0);
      const pxW = Math.abs((b.x - a.x) / 2) * W;
      if (pxW < MIN_W) continue;
      // the wall must be in sight: a plate behind the terrace across the road is not a proof
      if (blocked(eye, new THREE.Vector3(s.x, s.y, s.z))) continue;
      seen.push({ name: s.name, kind: s.kind, x: s.x, y: s.y, z: s.z, pxW: +pxW.toFixed(0) });
    }
    return seen;
  };
  let best = null;
  const stride = Math.max(1, Math.floor(facades.length / 220));
  for (let fi = 0; fi < facades.length; fi += stride) {
    const f = facades[fi];
    const outX = -Math.sin(f.yaw);
    const outZ = -Math.cos(f.yaw);
    const tanX = Math.cos(f.yaw);
    const tanZ = -Math.sin(f.yaw);
    // Stand back from the STREET FACE, not from the building centre: a frontage is 12-20 m deep,
    // so a centre-relative stance put the camera inside the wall it was meant to photograph.
    for (const back of [10, 14, 19]) {
      for (const side of [0, -5, 5, -9, 9]) {
        const stand = f.d / 2 + back;
        const cam = {
          x: f.x + outX * stand + tanX * side,
          y: f.y + 2.9,
          z: f.z + outZ * stand + tanZ * side,
          tx: f.x + tanX * side * 0.45,
          ty: f.y + 3.2,
          tz: f.z + tanZ * side * 0.45,
        };
        if (insideBox(cam)) continue;      // a stance inside a building photographs a wall
        const seen = countIn(cam);
        // more legible plates wins; then the bigger plates; then the stance nearest the spawn so
        // the same city load answers the same way twice
        const pixels = seen.reduce((a, s) => a + s.pxW, 0);
        const score = seen.length * 100000 + pixels * 10 - Math.hypot(cam.x, cam.z) * 0.01;
        if (!best || score > best.score) best = { cam, seen, score, archetype: f.archetype, at: [f.x, f.z] };
      }
    }
  }
  return { cam: best.cam, plates: best.seen, archetype: best.archetype, at: best.at, doors: city.shopDoors.length, boards: city.shopSigns.length };
}, MIN_W);

// park the player at the stance so the shadow camera follows, then freeze the loop
await page.evaluate(({ cam }) => {
  window.__game._test.teleport(cam.x, cam.z);
  window.__game._test.face(cam.tx, cam.tz);
}, { cam: pick.cam });
await sleep(600);
await page.evaluate(() => { window.__game._test.freezeLoop(true); });
await sleep(400);
const shot = await page.evaluate(({ cam, plates }) => {
  const g = window.__game;
  for (const el of document.body.children) {
    if (el.tagName !== 'CANVAS') el.style.visibility = 'hidden';
  }
  // the frame is the shopfront, not the traffic: park the player's own body and every car within
  // 25 m, the same rule the other proof tools use for a clean wall
  const near = (o) => o && o.position && Math.hypot(o.position.x - cam.x, o.position.z - cam.z) < 25;
  // the player's own body: the rig is the group standing at player.pos
  const pp = g.player.pos;
  g.scene.traverse((o) => {
    if (o.isGroup && Math.abs(o.position.x - pp.x) < 0.05 && Math.abs(o.position.z - pp.z) < 0.05) o.visible = false;
  });
  for (const list of [g.cityCars || [], (g.traffic?.cars || []).map((e) => e.car)]) {
    for (const c of list) {
      const mesh = c?.mesh || c?.group;
      if (mesh && near(mesh)) mesh.visible = false;
    }
  }
  const c = g.camera;
  c.position.set(cam.x, cam.y, cam.z);
  c.updateMatrixWorld(true);
  c.lookAt(cam.tx, cam.ty, cam.tz);
  c.updateMatrixWorld(true);
  g.renderer.render(g.scene, g.camera);
  const v = new g.THREE.Vector3();
  const rects = plates.map((p) => {
    const pts = [];
    let behind = false;
    for (const [dx, dy] of [[-1.25, -0.34], [1.25, -0.34], [1.25, 0.34], [-1.25, 0.34]]) {
      v.set(p.x + dx, p.y + dy, p.z);
      const back = v.clone().applyMatrix4(g.camera.matrixWorldInverse).z;
      if (back > -0.5) behind = true;
      v.project(g.camera);
      pts.push([(v.x + 1) / 2 * window.innerWidth, (1 - v.y) / 2 * window.innerHeight]);
    }
    return { name: p.name, kind: p.kind, rect: pts, behind };
  });
  const cvRect = g.renderer.domElement.getBoundingClientRect();
  return {
    plates: rects,
    w: window.innerWidth,
    h: window.innerHeight,
    canvas: { x: cvRect.x, y: cvRect.y, w: cvRect.width, h: cvRect.height, glW: g.renderer.domElement.width, glH: g.renderer.domElement.height },
  };
}, { cam: pick.cam, plates: pick.plates });

await page.screenshot({ path: OUT });

const png = fs.readFileSync(OUT).toString('base64');
const measure = await page.evaluate(async ({ png, plates }) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + png;
  await img.decode();
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let luma = 0;
  for (let i = 0; i < data.length; i += 4 * 97) luma += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  luma /= data.length / (4 * 97);
  const rows = [];
  for (const p of plates) {
    const xs = p.rect.map((q) => q[0]);
    const ys = p.rect.map((q) => q[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...xs)));
    const x1 = Math.min(cv.width, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const y1 = Math.min(cv.height, Math.ceil(Math.max(...ys)));
    if (p.behind) { rows.push({ name: p.name, ok: false, why: 'behind camera' }); continue; }
    if (x1 - x0 < 20 || y1 - y0 < 6) { rows.push({ name: p.name, ok: false, why: 'out of frame', w: x1 - x0, h: y1 - y0 }); continue; }
    // Ink is contrast, not a whitescale value: a plate in the shade still reads, its letters are
    // just grey. Count the pixels that stand well above this rect's own median luma.
    const ls = [];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * cv.width + x) * 4;
        ls.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
      }
    }
    ls.sort((a, b) => a - b);
    const p50 = ls[Math.floor(ls.length * 0.5)];
    const p90 = ls[Math.floor(ls.length * 0.9)];
    const ink = ls.filter((l) => l > p50 + 30).length;
    rows.push({
      name: p.name,
      kind: p.kind,
      ok: ink > 0.03 * ls.length,
      inkPct: +(100 * ink / ls.length).toFixed(1),
      lum: [Math.round(ls[0]), Math.round(p50), Math.round(p90), Math.round(ls[ls.length - 1])],
      w: x1 - x0,
      h: y1 - y0,
    });
  }
  return { luma: +luma.toFixed(1), width: cv.width, height: cv.height, rows };
}, { png, plates: shot.plates });

console.log(JSON.stringify({
  shot: OUT,
  stanceFrom: `${pick.archetype}@${pick.at.map((n) => n.toFixed(0)).join(',')}`,
  cam: Object.fromEntries(Object.entries(pick.cam).map(([k, v]) => [k, +v.toFixed(1)])),
  doors: pick.doors,
  boards: pick.boards,
  frame: { w: measure.width, h: measure.height, luma: measure.luma },
  canvas: shot.canvas,
  rects: shot.plates.map((p) => ({ name: p.name, x0: Math.round(Math.min(...p.rect.map((q) => q[0]))), y0: Math.round(Math.min(...p.rect.map((q) => q[1]))), x1: Math.round(Math.max(...p.rect.map((q) => q[0]))), y1: Math.round(Math.max(...p.rect.map((q) => q[1]))) })),
  plates: measure.rows,
  errors,
}, null, 1));
const legible = measure.rows.filter((r) => r.ok).length;
console.log(`legible plates: ${legible}/${measure.rows.length}`);
if (legible < 2 || measure.luma < 60) process.exitCode = 2;
await browser.close();
