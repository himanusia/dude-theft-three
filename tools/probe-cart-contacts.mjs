// Per-contact probe for the kaki lima carts: every tyre and every foot, against the surface that
// is actually under it.
//
// Not part of the game; run against a served dist.
// usage: node tools/probe-cart-contacts.mjs [baseUrl]
//
// Why this exists: `city.propAudit[i].bottom` used to be one sample at the prop's slot, so the
// floating-prop audit could not see a cart parked across a kerb -- the slot read the pavement while
// one tyre hung 26 cm over the carriageway. This probe measures the two things that audit skipped:
//  1. the SURFACE, by casting a ray straight down at each contact and reporting which mesh it hits
//     (trotoar / road-arterial / terrain), not by trusting `city.groundHeightAt`;
//  2. the CART's own lowest vertex within 20 cm of that contact, read out of the merged geometry,
//     so the number is the built tyre and not a constant repeated from the builder.
// A contact is reported as `gap = bottom - surface`, so positive floats, negative sinks.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || process.argv[2] || 'http://127.0.0.1:8981';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIMIT = Number(process.env.CONTACT_LIMIT || 0.03);
fs.mkdirSync('screenshots/proof', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  defaultViewport: { width: 1400, height: 900 },
});
const errors = [];
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
});
await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.__game !== undefined', { timeout: 90000 });
await page.click('#start-btn');
await sleep(2000);

const report = await page.evaluate(() => {
  const g = window.__game;
  const THREE = g.THREE;

  // the four places a gerobak touches the ground (src/world/kakilima.ts: AXLE_X/WHEEL_Z and the
  // braced feet). Kept here, not imported, because this is an independent check of the build.
  const CONTACTS = [
    { name: 'tyre+Z', l: [0.38, 0.5], r: 0.2 },
    { name: 'tyre-Z', l: [0.38, -0.5], r: 0.2 },
    { name: 'foot+Z', l: [-0.6, 0.29], r: 0.2 },
    { name: 'foot-Z', l: [-0.6, -0.29], r: 0.2 },
  ];

  const carts = [];
  g.scene.traverse((o) => {
    if (typeof o.name === 'string' && o.name.startsWith('kaki5-')) carts.push(o);
  });

  // the built surface under a point: the topmost upward-facing hit within 35 cm of the analytic
  // ground, so the vertical back of a paving slab, a tree or a bench overhead cannot be mistaken
  // for the street a tyre stands on
  const surfaceAt = (x, z, skip) => {
    const near = g.city.groundHeightAt(x, z);
    const rc = new THREE.Raycaster(new THREE.Vector3(x, near + 2.0, z), new THREE.Vector3(0, -1, 0), 0, 4.0);
    const hits = rc.intersectObjects(g.scene.children, true);
    const n = new THREE.Vector3();
    const nm = new THREE.Matrix3();
    for (const h of hits) {
      let p = h.object;
      let mine = false;
      while (p) { if (p === skip) { mine = true; break; } p = p.parent; }
      if (mine) continue;                                             // the prop's own geometry
      if (h.object.material && h.object.material.transparent) continue; // contact-patch decals
      if (Math.abs(h.point.y - near) > 0.35) continue;
      if (h.face) {
        n.copy(h.face.normal).applyMatrix3(nm.getNormalMatrix(h.object.matrixWorld)).normalize();
        if (n.y < 0.5) continue;                                      // a face, not an edge
      }
      return { y: h.point.y, mesh: h.object.name || h.object.type, analytic: near };
    }
    return { y: near, mesh: 'NONE(near miss)', analytic: near };
  };

  // the cart's own bottom near a contact: lowest opaque vertex within `r` of the contact in XZ
  const bottomAt = (group, lx, lz, r) => {
    let best = Infinity;
    const v = new THREE.Vector3();
    group.updateMatrixWorld(true);
    // filter in the cart's own frame (so a yawed cart still clips on its own footprint) and read
    // the height in world space (so a pitched cart reports where the tyre really is)
    const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
    const local = new THREE.Vector3();
    group.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
      if (o.material && o.material.transparent) return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        local.copy(v).applyMatrix4(inv);
        if (Math.hypot(local.x - lx, local.z - lz) > r) continue;
        if (v.y < best) best = v.y;
      }
    });
    return best === Infinity ? null : best;
  };

  const out = [];
  for (const group of carts) {
    group.updateMatrixWorld(true);
    const contacts = CONTACTS.map((c) => {
      const p = group.localToWorld(new THREE.Vector3(c.l[0], 0, c.l[1]));
      const s = surfaceAt(p.x, p.z, group);
      const bottom = bottomAt(group, c.l[0], c.l[1], c.r);
      return {
        contact: c.name,
        x: +p.x.toFixed(2),
        z: +p.z.toFixed(2),
        surface: +s.y.toFixed(3),
        mesh: s.mesh,
        bottom: bottom === null ? null : +bottom.toFixed(3),
        gap: bottom === null ? null : +(bottom - s.y).toFixed(3),
      };
    });
    const gaps = contacts.map((c) => c.gap).filter((n) => n !== null);
    out.push({
      name: group.name,
      slot: [+group.position.x.toFixed(2), +group.position.y.toFixed(3), +group.position.z.toFixed(2)],
      pitch: [+group.rotation.x.toFixed(3), +group.rotation.z.toFixed(3)],
      contacts,
      on_kerb: contacts.some((c) => c.mesh === 'trotoar') && contacts.some((c) => c.mesh !== 'trotoar'),
      maxGap: gaps.length ? +Math.max(...gaps.map(Math.abs)).toFixed(3) : null,
      worst: gaps.length ? gaps.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a)) : null,
    });
  }
  return { carts: out, propAudit: (g.city.propAudit || []).filter((p) => String(p.name).startsWith('kaki5-')) };
});

let fails = 0;
for (const c of report.carts) {
  const bad = c.maxGap === null || c.maxGap > LIMIT;
  if (bad) fails++;
  console.log(`\n${bad ? 'FAIL' : 'PASS'} ${c.name} slot=(${c.slot.join(', ')}) tilt=(${c.pitch.join(', ')}) maxGap=${c.maxGap}`);
  for (const k of c.contacts) {
    const flag = k.gap === null || Math.abs(k.gap) > LIMIT ? ' <-- off the ground' : '';
    console.log(`   ${k.contact.padEnd(7)} at (${k.x}, ${k.z})  surface ${k.surface.toFixed(3)} via ${k.mesh.padEnd(14)} bottom ${k.bottom === null ? 'none' : k.bottom.toFixed(3)}  gap ${k.gap === null ? 'none' : (k.gap > 0 ? '+' : '') + k.gap.toFixed(3)}${flag}`);
  }
}
console.log('\nAUDIT', JSON.stringify(report.propAudit.map((p) => ({ name: p.name, x: +p.x.toFixed(2), z: +p.z.toFixed(2), bottom: +p.bottom.toFixed(3) }))));
console.log('SUMMARY', JSON.stringify({
  carts: report.carts.length,
  off: fails,
  limit: LIMIT,
  worst: report.carts.map((c) => c.maxGap),
  pageErrors: errors.slice(0, 4),
}));
fs.writeFileSync('screenshots/proof/gerobak-contacts.json', JSON.stringify({ limit: LIMIT, ...report }, null, 1));
await browser.close();
if (fails || report.carts.length === 0 || errors.length) process.exitCode = 1;
