/**
 * Do any two buildings occupy the same ground?
 *
 * The first version of this question was answered with world-space AABBs, and on a city whose
 * frontage is rotated to face the street that inflates every box: two shophouses standing 3 m
 * apart, angled differently, produce bounding boxes that overlap by 6 m. It reported 225
 * "collisions" that were mostly the metric, not the city.
 *
 * This measures oriented boxes: each candidate is rebuilt from its own axis, its corners are
 * pushed into the other building's frame, and the overlap is measured there.
 */
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || 'http://127.0.0.1:8765';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1000, height: 640 });
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.__game !== undefined', { timeout: 90000 });
await page.click('#start-btn');
await new Promise((r) => setTimeout(r, 4500));

const report = await page.evaluate(() => {
  const g = window.__game;
  const T = g.THREE || window.THREE;

  // building bodies only: upright boxes with a texture, between 4 and 120 m tall
  const items = [];
  g.scene.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh) return;
    const m = o.material;
    if (!m || Array.isArray(m) || !m.map) return;
    const geo = o.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const size = bb.getSize(new T.Vector3());
    if (size.y < 4 || size.y > 130) return;
    if (size.x < 3 || size.z < 3 || size.x > 60 || size.z > 60) return;
    const centre = bb.getCenter(new T.Vector3()).applyMatrix4(o.matrixWorld);
    items.push({ cx: centre.x, cz: centre.z, hx: size.x / 2, hz: size.z / 2, rot: o.rotation.y || 0 });
  });

  const cos = (a) => Math.cos(a);
  const sin = (a) => Math.sin(a);
  // corners of box a expressed in frame b, then an AABB in that frame
  const overlap = (a, b) => {
    const dx = a.cx - b.cx;
    const dz = a.cz - b.cz;
    // push the offset into b's frame
    const ox = dx * cos(-b.rot) - dz * sin(-b.rot);
    const oz = dx * sin(-b.rot) + dz * cos(-b.rot);
    const c = cos(a.rot - b.rot);
    const s = sin(a.rot - b.rot);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const px = sx * a.hx * c - sz * a.hz * s + ox;
        const pz = sx * a.hx * s + sz * a.hz * c + oz;
        minX = Math.min(minX, px); maxX = Math.max(maxX, px);
        minZ = Math.min(minZ, pz); maxZ = Math.max(maxZ, pz);
      }
    }
    const x = Math.min(maxX, b.hx) - Math.max(minX, -b.hx);
    const z = Math.min(maxZ, b.hz) - Math.max(minZ, -b.hz);
    return Math.min(x, z);
  };

  let pairs = 0;
  let worst = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const d = overlap(items[i], items[j]);
      if (d > 0.5) { pairs++; worst = Math.max(worst, d); }
    }
  }
  return { buildings: items.length, overlapPairs: pairs, worst: +worst.toFixed(2) };
});

console.log(JSON.stringify(report));
await browser.close();
const ok = report.overlapPairs === 0;
console.log(ok ? 'PASS no two buildings share ground' : `FAIL ${report.overlapPairs} pairs overlap, worst ${report.worst} m`);
process.exit(ok ? 0 : 1);
