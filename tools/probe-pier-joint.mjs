/**
 * Pier joint probe — does the deck bear on the pier head, and does the column carry the head?
 *
 * The owner's report ("di jalan layang, tiang masih belum tersambung seamless") is a joint
 * question, so it is measured as a joint, on the built scene:
 *
 *   1. the vertical gap between each pier head's TOP plane and the underside of the deck it
 *      carries, straight off the two instances' world matrices;
 *   2. whether each column actually engages the head — its top is inside the head's volume and
 *      its footprint is under the head's footprint, not beside it;
 *   3. the pier head's triangle count, per instance and in total.
 *
 * usage: DTA_URL=http://127.0.0.1:8974 node tools/probe-pier-joint.mjs
 *        PIER_GATE=1 ... -> exit 1 when any joint is wrong (default: report only, so the same
 *        tool can be pointed at the pre-fix build for the "before" numbers)
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || process.argv[2] || 'http://127.0.0.1:8974';
const JSON_OUT = process.env.PIER_JSON || '';
const GATE = process.env.PIER_GATE === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** a bearing joint is zero-gap; 1 cm is the acceptance line the card quotes */
const MAX_GAP = 0.01;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  defaultViewport: { width: 1100, height: 700 },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 240000 });
await page.waitForFunction('window.__game !== undefined', { timeout: 120000 });
await sleep(1200);
await page.click('#start-btn');
await sleep(2000);

const report = await page.evaluate(() => {
  const g = window.__game;
  const THREE = g.THREE;

  // ------------------------------------------------------------------ read every instance
  // No assumed dimensions: the boxes are classified from their own geometry + instance scale, so
  // this same file measures the pre-fix build (a 0.7 m head) and the fixed one (a deeper head).
  const boxes = [];
  g.scene.traverse((o) => {
    if (!o.isInstancedMesh) return;
    const prm = o.geometry && o.geometry.parameters;
    if (!prm || prm.width === undefined) return;
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m);
      m.decompose(pos, quat, scl);
      const w = Math.abs(prm.width * scl.x);
      const h = Math.abs(prm.height * scl.y);
      const d = Math.abs(prm.depth * scl.z);
      const tris = o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3;
      boxes.push({
        name: o.name || '',
        tris,
        w,
        h,
        d,
        small: Math.min(w, d),
        big: Math.max(w, d),
        pos: pos.clone(),
        quat: quat.clone(),
        minY: pos.y - h / 2,
        maxY: pos.y + h / 2,
      });
    }
  });

  // deck slab: ~1.1 m thick and wide (the parapet is the same thickness but 0.35 m wide);
  // head: flat and wide; column: tall and slim
  const distToSpine = (path, x, z) => {
    let best = Infinity;
    for (let i = 1; i < path.length; i++) {
      const [x1, z1] = path[i - 1];
      const [x2, z2] = path[i];
      const dx = x2 - x1;
      const dz = z2 - z1;
      const l2 = dx * dx + dz * dz || 1;
      let t = ((x - x1) * dx + (z - z1) * dz) / l2;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(x - (x1 + dx * t), z - (z1 + dz * t)));
    }
    return best;
  };
  const tollSpine = g.city.layangSpine || [];
  const metroSpine = g.city.mrtSpine || [];
  const decks = boxes.filter((b) => b.h > 1.0 && b.h < 1.2 && b.w >= 6);
  // A pier head belongs to an elevated structure, so it has to stand on that structure's own
  // spine. Without this the flat wide boxes elsewhere in the city (stall roofs, awnings) count
  // as pier heads and the report reads like eighty broken viaducts.
  const caps = [];
  for (const b of boxes) {
    if (!(b.h >= 0.5 && b.h <= 1.6 && b.small >= 1.5 && b.small <= 4 && b.big >= 5)) continue;
    const dToll = distToSpine(tollSpine, b.pos.x, b.pos.z);
    const dMetro = distToSpine(metroSpine, b.pos.x, b.pos.z);
    const kind = dToll <= 14 ? 'toll' : dMetro <= 10 ? 'metro' : null;
    if (!kind) continue;
    b.kind = kind;
    caps.push(b);
  }
  const shafts = boxes.filter((b) => b.h > 4 && b.small <= 3);

  const localOf = (b, x, z) => {
    const v = new THREE.Vector3(x - b.pos.x, 0, z - b.pos.z).applyQuaternion(b.quat.clone().invert());
    return { x: v.x, z: v.z };
  };

  const piers = caps.map((cap) => {
    const [cx, cz] = [cap.pos.x, cap.pos.z];
    // the deck that carries over this head: the lowest slab whose footprint contains its centre
    let deck = null;
    for (const d of decks) {
      const l = localOf(d, cx, cz);
      if (Math.abs(l.x) > d.w / 2 || Math.abs(l.z) > d.d / 2) continue;
      // the slab this head is meant to carry: the nearest one in height, in either direction.
      // A wide window is deliberate — on the pre-fix build a head can sit a metre INSIDE the
      // deck or a metre under it, and hiding that behind a narrow window is the bug itself.
      if (Math.abs(d.minY - cap.maxY) > 3) continue;
      if (!deck || Math.abs(d.minY - cap.maxY) < Math.abs(deck.minY - cap.maxY)) deck = d;
    }
    const gap = deck ? deck.minY - cap.maxY : null;
    // the two columns this head rests on: footprint under the head, top inside its volume
    const cols = [];
    for (const s of shafts) {
      const l = localOf(cap, s.pos.x, s.pos.z);
      if (Math.abs(l.x) > cap.w / 2 + 1.5 || Math.abs(l.z) > cap.d / 2 + 1.5) continue;
      if (s.maxY < cap.minY - 2 || s.minY > cap.maxY + 2) continue;
      const underFootprint = Math.abs(l.x) + s.w / 2 <= cap.w / 2 + 1e-6;
      cols.push({
        side: l.x < 0 ? -1 : 1,
        at: [+s.pos.x.toFixed(2), +s.pos.z.toFixed(2)],
        topY: +s.maxY.toFixed(4),
        entersHeadBy: +(s.maxY - cap.minY).toFixed(4),
        headTopMinusColumnTop: +(cap.maxY - s.maxY).toFixed(4),
        underFootprint,
        topBelowDeck: deck ? +(deck.minY - s.maxY).toFixed(4) : null,
      });
    }
    return {
      headKind: cap.kind,
      at: [+cx.toFixed(2), +cz.toFixed(2)],
      headTopY: +cap.maxY.toFixed(4),
      headBottomY: +cap.minY.toFixed(4),
      headSize: [+cap.w.toFixed(2), +cap.h.toFixed(2), +cap.d.toFixed(2)],
      headTris: cap.tris,
      deckUndersideY: deck ? +deck.minY.toFixed(4) : null,
      gap: gap === null ? null : +gap.toFixed(4),
      columns: cols,
    };
  });

  // three named samples per structure, spread along the line, in station order
  const spread = (kind) => {
    const rows = piers.filter((p) => p.headKind === kind);
    if (rows.length <= 3) return rows;
    return [rows[0], rows[Math.floor(rows.length / 2)], rows[rows.length - 1]];
  };
  const gaps = piers.map((p) => p.gap).filter((v) => v !== null);
  return {
    headCount: piers.length,
    tollHeads: piers.filter((p) => p.headKind === 'toll').length,
    metroHeads: piers.filter((p) => p.headKind === 'metro').length,
    columnCount: shafts.length,
    deckCount: decks.length,
    headTrisPerInstance: piers.length ? piers[0].headTris : null,
    headTrisTotal: piers.reduce((n, p) => n + p.headTris, 0),
    gapMax: gaps.length ? +Math.max(...gaps).toFixed(4) : null,
    gapMin: gaps.length ? +Math.min(...gaps).toFixed(4) : null,
    samples: { toll: spread('toll'), metro: spread('metro') },
    allGaps: piers.map((p) => ({ kind: p.headKind, at: p.at, gap: p.gap })),
  };
});

report.pageErrors = pageErrors;

// ---------------------------------------------------------------- verdict
const joints = [...report.samples.toll, ...report.samples.metro];
const failures = [];
for (const p of joints) {
  if (p.gap === null) failures.push(`${p.headKind} @ ${p.at} has no deck above it`);
  else if (p.gap < -1e-6) failures.push(`${p.headKind} @ ${p.at} gap ${p.gap} (deck inside the head)`);
  else if (p.gap >= MAX_GAP) failures.push(`${p.headKind} @ ${p.at} gap ${p.gap} (>= ${MAX_GAP})`);
  if (p.columns.length !== 2) failures.push(`${p.headKind} @ ${p.at} has ${p.columns.length} columns under it`);
  for (const c of p.columns) {
    if (!c.underFootprint) failures.push(`${p.headKind} @ ${p.at} column ${c.side} stands beside the head, not under it`);
    if (c.entersHeadBy <= 0) failures.push(`${p.headKind} @ ${p.at} column ${c.side} stops ${-c.entersHeadBy} below the head`);
  }
}
for (const g of report.allGaps) {
  if (g.gap === null || g.gap < -1e-6 || g.gap >= MAX_GAP) failures.push(`un-sampled pier gap ${g.gap} at ${g.at}`);
}
if (report.pageErrors.length) failures.push(`page errors: ${report.pageErrors.slice(0, 2).join(' | ')}`);

report.samples3 = joints.map((p) => ({
  kind: p.headKind,
  at: p.at,
  gap: p.gap,
  headTop: p.headTopY,
  deckUnderside: p.deckUndersideY,
  columnEntersHeadBy: p.columns.map((c) => c.entersHeadBy),
}));
report.verdict = failures.length ? 'FAIL' : 'PASS';
report.failures = failures;

console.log('PIER_JOINT', JSON.stringify(report, null, 1));
if (JSON_OUT) {
  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
}
await browser.close();
if (GATE && failures.length) {
  console.error(`pier joint: ${failures.length} failures`);
  process.exit(1);
}
