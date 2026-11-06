// Per-contact probe for the kaki lima carts: every tyre and every foot, against the surface that
// is actually under it, plus how far the rank parks from the kerb line.
//
// Not part of the game; run against a served dist.
// usage: node tools/probe-cart-contacts.mjs [baseUrl]
// env:   LOADS=3 CONTACT_LIMIT=0.03 KERB_MIN=0.2 KERB_MAX=0.7
//
// Why this exists: `city.propAudit[i].bottom` used to be one sample at the prop's slot, so the
// floating-prop audit could not see a cart parked across a kerb -- the slot read the pavement while
// one tyre hung 26 cm over the carriageway. The probe measures the three things that audit skips:
//  1. the SURFACE, by casting a ray straight down at each contact and reporting which mesh it hits
//     (trotoar / plate / terrain), not by trusting `city.groundHeightAt`;
//  2. the CART's own lowest vertex within 20 cm of that contact, read out of the merged geometry,
//     so the number is the built tyre and not a constant repeated from the builder;
//  3. the KERB, as `distToPath` against the arterial the cart stands beside minus that road's
//     half-width: 0 is the edge of the asphalt, 0.2 m is the end of the kerb cap, and the paving
//     runs to 3.8 m. A cart reads as a kerbside prop when its OUTERMOST tyre is 0.2-0.7 m out.
// A contact is reported as `gap = bottom - surface`, so positive floats, negative sinks.
//
// It gates, it does not just report: a contact further than CONTACT_LIMIT from the surface, a tyre
// outside the kerb band, or a cart standing on the bare verge with paving within 2.5 m all exit 1.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || process.argv[2] || 'http://127.0.0.1:8981';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIMIT = Number(process.env.CONTACT_LIMIT || 0.03);
const KERB_MIN = Number(process.env.KERB_MIN || 0.2);
const KERB_MAX = Number(process.env.KERB_MAX || 0.7);
const LOADS = Number(process.env.LOADS || 1);
// the paving search radius: a cart on the verge with a walk this close is the defect (t_6cd9aa18)
const PAVING_REACH = 2.5;
fs.mkdirSync('screenshots/proof', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  defaultViewport: { width: 1400, height: 900 },
});
const errors = [];

let fails = 0;
let placed = 0;
let loadsRun = 0;
const perLoad = [];
const allLoads = [];
for (let load = 0; load < LOADS; load++) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
  });
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction('window.__game !== undefined', { timeout: 180000 });
  await page.click('#start-btn');
  await sleep(2000);

  const report = await page.evaluate((PAVING_REACH) => {
    const g = window.__game;
    const THREE = g.THREE;

    // the four places a gerobak touches the ground (src/world/kakilima.ts: AXLE_X/WHEEL_Z and the
    // braced feet). Kept here, not imported, because this is an independent check of the build.
    const CONTACTS = [
      { name: 'tyre+Z', l: [0.38, 0.5], r: 0.2, tyre: true },
      { name: 'tyre-Z', l: [0.38, -0.5], r: 0.2, tyre: true },
      { name: 'foot+Z', l: [-0.6, 0.29], r: 0.2 },
      { name: 'foot-Z', l: [-0.6, -0.29], r: 0.2 },
    ];
    // the surfaces a cart can stand on. The list is the game's own (`city.surfaces()`), named here
    // so the probe reads the drawn street rather than every object in the scene: a muzzle flash is
    // a Sprite whose raycast throws, and a cart's own tyres are not ground.
    const GROUND = ['terrain', 'plate', 'lawn', 'lot', 'trotoar', 'kerb', 'gutter', 'kerb-ramp', 'road-arterial', 'road-local', 'road-shoulder'];
    const PAVED_MESHES = ['plate', 'trotoar', 'kerb', 'kerb-ramp'];
    // `city.groundInfoAt` names the same surfaces by KIND, and a kind is not a mesh name: paving is
    // `walk` (the trotoar ribbon) and `plate` (a block), while the meshes are called trotoar/plate.
    const PAVED_KINDS = ['plate', 'walk', 'kerb', 'ramp'];
    const surfaces = [];
    g.scene.traverse((o) => { if (o.isMesh && GROUND.includes(o.name)) surfaces.push(o); });

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
      const hits = rc.intersectObjects(surfaces, true);
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

    // the carriageway a contact stands beside: the nearest arterial, and the ring road
    const roads = [
      ...(g.jakartaMap?.ARTERIALS || []).map((a) => ({ name: a.name || 'arterial', path: a.path, half: a.width / 2 })),
      { name: 'ring-road', path: g.jakartaMap.RING_ROAD, half: 10 },
    ];
    const kerbOf = (x, z) => {
      let best = null;
      for (const r of roads) {
        const d = g.city.distToPath(x, z, r.path) - r.half;
        if (!best || d < best.kerb) best = { kerb: d, road: r.name, half: r.half };
      }
      return best;
    };

    // how far is the nearest paving from a point? Sampled on the analytic ground the game places
    // with, in 25 cm rings out to `reach`; null means nothing paved inside the reach at all.
    const pavingNear = (x, z, reach) => {
      for (let r = 0; r <= reach + 1e-6; r += 0.25) {
        const steps = r < 1e-6 ? 1 : 16;
        for (let i = 0; i < steps; i++) {
          const a = (i / steps) * Math.PI * 2;
          const kind = g.city.groundInfoAt(x + Math.cos(a) * r, z + Math.sin(a) * r).kind;
          if (PAVED_KINDS.includes(kind)) return +r.toFixed(2);
        }
      }
      return null;
    };

    const out = [];
    for (const group of carts) {
      group.updateMatrixWorld(true);
      const contacts = CONTACTS.map((c) => {
        const p = group.localToWorld(new THREE.Vector3(c.l[0], 0, c.l[1]));
        const s = surfaceAt(p.x, p.z, group);
        const bottom = bottomAt(group, c.l[0], c.l[1], c.r);
        const k = kerbOf(p.x, p.z);
        return {
          contact: c.name,
          tyre: !!c.tyre,
          x: +p.x.toFixed(2),
          z: +p.z.toFixed(2),
          surface: +s.y.toFixed(3),
          mesh: s.mesh,
          meshPaved: PAVED_MESHES.includes(s.mesh),
          kind: g.city.groundInfoAt(p.x, p.z).kind,
          bottom: bottom === null ? null : +bottom.toFixed(3),
          gap: bottom === null ? null : +(bottom - s.y).toFixed(3),
          kerb: +k.kerb.toFixed(3),
          road: k.road,
          half: k.half,
        };
      });
      const gaps = contacts.map((c) => c.gap).filter((n) => n !== null);
      const tyres = contacts.filter((c) => c.tyre);
      const bare = contacts.filter((c) => !PAVED_KINDS.includes(c.kind));
      out.push({
        name: group.name,
        slot: [+group.position.x.toFixed(2), +group.position.y.toFixed(3), +group.position.z.toFixed(2)],
        pitch: [+group.rotation.x.toFixed(3), +group.rotation.z.toFixed(3)],
        contacts,
        on_kerb: contacts.some((c) => c.mesh === 'trotoar') && contacts.some((c) => c.mesh !== 'trotoar'),
        // the tyre nearest the kerb line: this is the number the card is about
        outerTyre: +Math.min(...tyres.map((t) => t.kerb)).toFixed(3),
        innerTyre: +Math.max(...tyres.map((t) => t.kerb)).toFixed(3),
        kinds: contacts.map((c) => c.kind),
        bareContacts: bare.map((c) => `${c.contact}:${c.kind}`),
        pavingWithin: bare.length ? pavingNear(group.position.x, group.position.z, PAVING_REACH) : 0,
        maxGap: gaps.length ? +Math.max(...gaps.map(Math.abs)).toFixed(3) : null,
        worst: gaps.length ? gaps.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a)) : null,
      });
    }
    return { carts: out, propAudit: (g.city.propAudit || []).filter((p) => String(p.name).startsWith('kaki5-')) };
  }, PAVING_REACH);

  loadsRun++;
  let loadFails = 0;
  console.log(`\n===== LOAD ${load} ===== carts ${report.carts.length}  kerb band ${KERB_MIN}-${KERB_MAX} m  gap limit ${LIMIT} m`);
  for (const c of report.carts) {
    placed++;
    const badGap = c.maxGap === null || c.maxGap > LIMIT;
    const badKerb = !(c.outerTyre >= KERB_MIN && c.outerTyre <= KERB_MAX);
    const badGround = c.bareContacts.length > 0 && c.pavingWithin !== null;
    // the seated mesh and the analytic kind have to agree: a contact over `terrain` while the
    // analytic ground calls it paving is a cart in the gutter with a green audit row
    const offMesh = c.contacts.filter((k) => !k.meshPaved && !String(k.mesh).startsWith('NONE'));
    if (badGap) loadFails++;
    if (badKerb) loadFails++;
    if (badGround) loadFails++;
    if (offMesh.length) loadFails++;
    console.log(
      `\n${badGap || badKerb || badGround || offMesh.length ? 'FAIL' : 'PASS'} ${c.name} slot=(${c.slot.join(', ')}) tilt=(${c.pitch.join(', ')}) maxGap=${c.maxGap}` +
        `  outerTyre=${c.outerTyre} m innerTyre=${c.innerTyre} m${badKerb ? ' <-- outside the kerb band' : ''}` +
        `${offMesh.length ? ` <-- seated off the paving: ${offMesh.map((k) => k.mesh).join(',')}` : ''}`
    );
    for (const k of c.contacts) {
      const flag = k.gap === null || Math.abs(k.gap) > LIMIT ? ' <-- off the ground' : '';
      console.log(
        `   ${k.contact.padEnd(7)} at (${k.x}, ${k.z})  surface ${k.surface.toFixed(3)} via ${k.mesh.padEnd(14)} kind ${String(k.kind).padEnd(8)}` +
          ` bottom ${k.bottom === null ? 'none' : k.bottom.toFixed(3)}  gap ${k.gap === null ? 'none' : (k.gap > 0 ? '+' : '') + k.gap.toFixed(3)}` +
          `  kerb ${k.kerb.toFixed(3)} m (${k.road}, half ${k.half})${flag}`
      );
    }
    if (c.bareContacts.length) {
      console.log(
        `   bare verdict: ${c.bareContacts.join(', ')}  nearest paving ${c.pavingWithin === null ? '> 2.5 m' : c.pavingWithin + ' m'}` +
          `${badGround ? ' <-- paving within reach, the cart is in the gutter' : ' (nothing paved within 2.5 m)'}`
      );
    }
  }
  fails += loadFails;
  const loadRec = {
    load,
    carts: report.carts.length,
    outerTyre: report.carts.map((c) => c.outerTyre),
    maxGap: report.carts.map((c) => c.maxGap),
    kinds: report.carts.map((c) => c.kinds),
    bare: report.carts.filter((c) => c.bareContacts.length).map((c) => ({ name: c.name, contacts: c.bareContacts, pavingWithin: c.pavingWithin })),
    fails: loadFails,
  };
  perLoad.push(loadRec);
  console.log('\nAUDIT', JSON.stringify(report.propAudit.map((p) => ({ name: p.name, x: +p.x.toFixed(2), z: +p.z.toFixed(2), bottom: +p.bottom.toFixed(3) }))));
  console.log('LOADSUMMARY', JSON.stringify(loadRec));
  // the artifact keeps every contact of every cart on every load: this is the number the card is
  // about, so it is written once for the whole run rather than per load
  allLoads.push({ load, carts: report.carts, propAudit: report.propAudit });
  await page.close();
}
fs.writeFileSync('screenshots/proof/gerobak-contacts.json', JSON.stringify({ limit: LIMIT, kerb: [KERB_MIN, KERB_MAX], pavingReach: PAVING_REACH, loads: allLoads }, null, 1));

console.log('\nSUMMARY', JSON.stringify({
  loads: loadsRun,
  carts: placed,
  off: fails,
  limit: LIMIT,
  kerbBand: [KERB_MIN, KERB_MAX],
  perLoad: perLoad.map((l) => ({ load: l.load, carts: l.carts, outerTyre: l.outerTyre, maxGap: l.maxGap, fails: l.fails })),
  pageErrors: errors.slice(0, 4),
}));
await browser.close();
if (fails || placed === 0 || errors.length) process.exitCode = 1;
