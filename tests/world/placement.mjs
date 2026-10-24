
import { launch, bootGate, crash, suiteStart } from '../_harness.mjs';

const SUITE = 'world/placement';
suiteStart(SUITE);
try {
/**
 * Placement law. Every one of these failures reached the owner's screen before this file existed:
 *
 *   - the minimarket stood in the middle of the carriageway, because it was placed at the spawn
 *     point and the spawn point is the arterial centreline
 *   - the toll deck's piers floated above the ground instead of meeting it
 *   - buildings poked up through the elevated deck
 *
 * Each was found by eye, after the fact, one at a time. These are the same questions asked by a
 * machine, against the live scene, so the next placement path cannot reintroduce them quietly.
 */

const CHROME = '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || 'http://127.0.0.1:8765';

const browser = await launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1000, height: 640 });
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await bootGate(page);
await page.click('#start-btn');
await new Promise((r) => setTimeout(r, 5000));

const report = await page.evaluate(() => {
  const g = window.__game;
  const city = g.city;
const boxOf = (o) => {
  // THREE is not exposed on the built bundle, so bounds are computed from the geometry and the
  // world matrix directly. Relying on window.THREE made this suite crash on a fresh build.
  const g = o.geometry;
  if (!g) return null;
  if (!g.boundingBox) g.computeBoundingBox();
  const bb = g.boundingBox;
  if (!bb) return null;
  const m = o.matrixWorld.elements;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? bb.max.x : bb.min.x;
    const y = i & 2 ? bb.max.y : bb.min.y;
    const z = i & 4 ? bb.max.z : bb.min.z;
    const tx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const ty = m[1] * x + m[5] * y + m[9] * z + m[13];
    const tz = m[2] * x + m[6] * y + m[10] * z + m[14];
    if (tx < minX) minX = tx; if (tx > maxX) maxX = tx;
    if (ty < minY) minY = ty; if (ty > maxY) maxY = ty;
    if (tz < minZ) minZ = tz; if (tz > maxZ) maxZ = tz;
  }
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
};


  // ---- 1. named, hand-placed assets must not stand on a carriageway ---------------------
  // Uses the same road list the generator builds from, so a wider road is caught too.
  const roads = city.roads || [];
  const distToPath = (x, z, path) => {
    let best = Infinity;
    for (let i = 1; i < path.length; i++) {
      const [x1, z1] = path[i - 1];
      const [x2, z2] = path[i];
      const dx = x2 - x1, dz = z2 - z1;
      const len2 = dx * dx + dz * dz || 1;
      let t = ((x - x1) * dx + (z - z1) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(x - (x1 + dx * t), z - (z1 + dz * t)));
    }
    return best;
  };
  const onRoad = (x, z) =>
    roads.some((r) => distToPath(x, z, r.path) < r.width / 2) ? roads.find((r) => distToPath(x, z, r.path) < r.width / 2) : null;

  const named = (city.propAudit || []).filter((a) =>
    ['minimarket', 'pos-polisi', 'rumah-padang', 'masjid', 'pasar', 'terminal', 'mrt-station', 'pos-ronda'].includes(a.name)
  );
  const onCarriageway = [];
  for (const a of named) {
    const r = onRoad(a.x, a.z);
    if (r) onCarriageway.push({ name: a.name, at: [Math.round(a.x), Math.round(a.z)], road: r.name });
  }

  // ---- 2. every elevated pier must actually reach the ground ---------------------------
  // A pier whose base is above the terrain leaves the deck hanging in the air.
  const floatingPiers = [];
  let box = null;
  g.scene.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh) return;
    const m = o.material;
    if (!m || Array.isArray(m)) return;
    box = boxOf(o);
    if (!box) return;
    const size = { x: box.max.x - box.min.x, y: box.max.y - box.min.y, z: box.max.z - box.min.z };
    // A pier under the elevated deck: thin, and its top lands in the deck's height band.
    // Without the top constraint this also matched minarets and sign poles eighty metres up,
    // which are not piers and made the report read like forty broken bridges.
    if (size.y < 4 || size.y > 20) return;
    if (Math.max(size.x, size.z) > 3.5) return;
    if (box.max.y < 8 || box.max.y > 20) return;
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    const ground = city.groundHeightAt(cx, cz);
    if (box.min.y - ground > 0.35) floatingPiers.push({ at: [Math.round(cx), Math.round(cz)], gap: +(box.min.y - ground).toFixed(2) });
  });

  // ---- 3. buildings must not reach into the elevated deck ------------------------------
  // Anything whose top is above the deck underside and whose footprint is under the deck
  // is a building growing through a road.
  const deckTop = (city.propAudit || []).find((a) => a.name === 'layang');
  const clips = [];
  if (deckTop) {
    const spine = city.layangSpine || [];
    g.scene.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh) return;
      const m = o.material;
      if (!m || Array.isArray(m) || !m.map) return;
      box = boxOf(o);
      if (!box) return;
      const size = { x: box.max.x - box.min.x, y: box.max.y - box.min.y, z: box.max.z - box.min.z };
      if (size.y < 6 || size.y > 130) return;
      const cx = (box.min.x + box.max.x) / 2;
      const cz = (box.min.z + box.max.z) / 2;
      const d = distToPath(cx, cz, spine);
      if (d < 10 && box.max.y > 9) clips.push({ at: [Math.round(cx), Math.round(cz)], top: Math.round(box.max.y), side: Math.round(d) });
    });
  }

  return {
    named: named.length,
    onCarriageway,
    floatingPiers: floatingPiers.slice(0, 8),
    floatingPierCount: floatingPiers.length,
    deckClips: clips.slice(0, 8),
    deckClipCount: clips.length,
  };
});

const checks = [
  ['no hand-placed asset stands on a carriageway', report.onCarriageway.length === 0, report.onCarriageway],
  ['no elevated pier floats above the ground', report.floatingPierCount === 0, report.floatingPiers],
  ['no building grows through the elevated deck', report.deckClipCount === 0, report.deckClips],
];

let pass = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${JSON.stringify(detail).slice(0, 400)}`);
  if (ok) pass++;
}
console.log('SUMMARY', JSON.stringify({ pass, total: checks.length, named: report.named }));
await browser.close();
process.exit(pass === checks.length ? 0 : 1);

} catch (err) {
  await crash(SUITE, err);
}
