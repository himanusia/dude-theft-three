// Proof + measurement for the facade archetypes: how many DIFFERENT building types are actually
// legible in ONE frame, how many a sampled street holds, and what that frame costs the renderer.
//
// The old facade proof was a photo of one wall: it could not answer "are these the same building
// twice". This harness reads the city's own facade audit (city.facadeAudit, written by city.ts as
// each building is built), searches camera stances along the street, and keeps the one where the
// most types are LEGIBLE, where legible means ALL of:
//
//   * the building's ground point is in frame and it stands at least 70 px tall (7% of the frame),
//   * the lens sees its facade at 68 degrees or less off the normal (a wall at a grazing angle is a
//     sliver, not a facade),
//   * no other building's footprint crosses the sightline,
//   * a ray from the lens to its ground floor AND to 55% of its height lands on that facade.
//
// The measuring function is installed once in the page and used for BOTH the stance search and the
// verdict on the saved frame, so the picture and the number cannot disagree.
//
// The camera is derived from the audit, never from coordinates cached in this file: the layout is
// randomised per load and the ground is a heightfield, so a hard-coded vantage ends up inside a
// hill, inside a shop, or below the pavement.
//
// usage: DTA_URL=http://127.0.0.1:8991 node tools/shoot-facades.mjs [name]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || 'http://127.0.0.1:8991';
const OUT_NAME = process.argv[2] || 'facade-archetypes';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LEGIBLE_PX = 70;          // 7% of a 1000 px frame: enough to tell a shutter from an awning
const MIN_LEGIBLE = 5;          // the card: at least five distinct archetypes legible in one frame
const MAX_CALLS = 1600;         // the card: draw calls for that frame
fs.mkdirSync('screenshots/proof', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  defaultViewport: { width: 1600, height: 1000 },
  // the stance search runs hundreds of projections and a few hundred raycasts inside one evaluate:
  // the default 30 s protocol timeout cuts it off mid-search
  protocolTimeout: 300000,
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
await sleep(2500);

await page.evaluate(() => {
  window.__game._test.cinematic(true);
  const hud = document.getElementById('hud');
  if (hud) hud.style.display = 'none';
});

/**
 * Put the camera where the search says, from a PLAYER standing there.
 *
 * Block groups are toggled by distance from the player, not from the camera (see
 * city.updateCulling), so a cinematic camera 800 m from the player photographs blocks that are not
 * being drawn: a handful of draw calls and an empty field. Teleporting first makes the measured
 * frame the frame a player standing in the street actually gets.
 */
const setView = async (cam, at) => {
  await page.evaluate(
    ([px, py, pz, tx, ty, tz]) => {
      window.__game._test.teleport(px, pz);
      window.__game._test.lookFrom(px, py, pz, tx, ty, tz);
      window.__game.camera.fov = 72;
      window.__game.camera.updateProjectionMatrix();
    },
    [...cam, ...at]
  );
  await sleep(420);
};

/** Install the one measuring function both the search and the verdict use. */
const setup = await page.evaluate(() => {
  const g = window.__game;
  const T = g.THREE;
  const audit = g.city.facadeAudit || [];
  const H = g.renderer.domElement.height || window.innerHeight;
  const W = g.renderer.domElement.width || window.innerWidth;
  const cam = g.camera;

  // every mesh, visible or not: block groups are culled by distance from the PLAYER, who is still
  // at spawn while the search runs, and a visibility-filtered list raycasts against empty space
  const meshes = [];
  g.scene.traverse((o) => {
    if (o.isMesh) meshes.push(o);
  });
  const ray = new T.Raycaster();

  // A street frame has to hold half a dozen buildings, so the lens is wide (72 deg): at 40 m it
  // covers ~90 m of frontage, which is where six consecutive lots live. A 60 deg lens covers 60 m
  // and the sixth type falls off the edge.
  cam.fov = 72;
  cam.updateProjectionMatrix();

  // footprint grid, so a sightline is tested against the buildings it crosses and not all 2,600
  const CELL = 20;
  const grid = new Map();
  for (const f of audit) {
    for (let ix = Math.floor((f.x - f.w) / CELL); ix <= Math.floor((f.x + f.w) / CELL); ix++) {
      for (let iz = Math.floor((f.z - f.d) / CELL); iz <= Math.floor((f.z + f.d) / CELL); iz++) {
        const k = `${ix},${iz}`;
        const list = grid.get(k) || [];
        list.push(f);
        grid.set(k, list);
      }
    }
  }
  const nearPoint = (x, z, out) => {
    const ix = Math.floor(x / CELL);
    const iz = Math.floor(z / CELL);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        const list = grid.get(`${ix + a},${iz + b}`);
        if (list) for (const f of list) out.add(f);
      }
    }
  };
  const inRect = (px, pz, f, pad) => {
    const c = Math.cos(-f.yaw);
    const s = Math.sin(-f.yaw);
    const lx = (px - f.x) * c - (pz - f.z) * s;
    const lz = (px - f.x) * s + (pz - f.z) * c;
    return Math.abs(lx) <= f.w / 2 + pad && Math.abs(lz) <= f.d / 2 + pad;
  };
  /**
   * Is the sightline to this point cut by another building? It has to be cut at that HEIGHT: a
   * 40 m slab stands behind the ruko row and its upper floors are in plain view over their roofs,
   * so a height-blind footprint test declares half the tall buildings invisible.
   */
  const blocked2D = (ax, ay, az, bx, by, bz, target) => {
    const bucket = new Set();
    for (let i = 1; i <= 16; i++) nearPoint(ax + (bx - ax) * (i / 17), az + (bz - az) * (i / 17), bucket);
    for (const f of bucket) {
      if (f === target) continue;
      const roof = f.y + f.h + 0.4;
      for (let i = 1; i <= 8; i++) {
        const t = i / 9;
        const y = ay + (by - ay) * t;
        if (y > roof) continue;
        if (inRect(ax + (bx - ax) * t, az + (bz - az) * t, f, -0.2)) return true;
      }
    }
    return false;
  };
  /** Where a building identifies itself: the ground floor of a shophouse, the upper body of a tower. */
  const probesFor = (f) => (f.h <= 14 ? [f.y + 1.5, f.y + f.h * 0.55] : [f.y + f.h * 0.3, f.y + f.h * 0.7]);
  const facadeHit = (camPos, f) => {
    const fx = f.x - Math.sin(f.yaw) * (f.d / 2);
    const fz = f.z - Math.cos(f.yaw) * (f.d / 2);
    let hits = 0;
    for (const py of probesFor(f)) {
      const dir = new T.Vector3(fx - camPos[0], py - camPos[1], fz - camPos[2]);
      const expect = dir.length();
      ray.set(new T.Vector3(camPos[0], camPos[1], camPos[2]), dir.normalize());
      const hit = ray.intersectObjects(meshes, false)[0];
      if (hit && Math.abs(hit.distance - expect) < 2.5) hits++;
    }
    return hits === 2;
  };

  /**
   * What this exact lens sees. Sets the camera, projects every audited building, applies the four
   * legibility rules, then raycasts the surviving ones to prove the facade is the one on screen.
   */
  window.__facadeMeasure = (camPos, at, minPx, withRays = true) => {
    cam.position.set(camPos[0], camPos[1], camPos[2]);
    cam.lookAt(new T.Vector3(at[0], at[1], at[2]));
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const seen = new Map();
    const inFrameKinds = new Set();
    const reject = { dist: 0, behind: 0, frame: 0, px: 0, angle: 0, blocked: 0, ok: 0 };
    const trace = [];
    for (const f of audit) {
      const dx = f.x - camPos[0];
      const dz = f.z - camPos[2];
      const dist = Math.hypot(dx, dz);
      if (dist > 130) { reject.dist++; continue; }
      const lo = new T.Vector3(f.x, f.y, f.z).project(cam);
      if (lo.z > 1) { reject.behind++; continue; }
      const hi = new T.Vector3(f.x, f.y + f.h, f.z).project(cam);
      const px = (Math.min(hi.y, 0.94) - lo.y) * H * 0.5;
      if (Math.abs(lo.x) <= 0.92 && lo.y >= -0.9 && lo.y <= 0.9 && px >= minPx) inFrameKinds.add(f.archetype);
      if (Math.abs(lo.x) > 0.92 || lo.y < -0.9 || lo.y > 0.9) { reject.frame++; continue; }
      if (px < minPx) { reject.px++; continue; }
      const nx = -Math.sin(f.yaw);
      const nz = -Math.cos(f.yaw);
      const tx = Math.cos(f.yaw);
      const tz = -Math.sin(f.yaw);
      const yProbe = f.y + f.h * 0.3;
      const hw = f.w / 2;
      const c1 = new T.Vector3(f.x + nx * (f.d / 2) + tx * hw, yProbe, f.z + nz * (f.d / 2) + tz * hw).project(cam);
      const c2 = new T.Vector3(f.x + nx * (f.d / 2) - tx * hw, yProbe, f.z + nz * (f.d / 2) - tz * hw).project(cam);
      const widthPx = Math.abs(c1.x - c2.x) * (W * 0.5);
      // a facade the lens sees edge-on is a sliver, whatever its height; a street seen in perspective
      // still shows each frontage 45 px wide or more
      if (widthPx < 45) { reject.angle++; if (trace) trace.push({ k: f.archetype, d: Math.round(dist), px: Math.round(px), w: Math.round(widthPx), why: 'sliver' }); continue; }
      if (blocked2D(camPos[0], camPos[1], camPos[2], f.x + nx * (f.d / 2), f.y + f.h * 0.55, f.z + nz * (f.d / 2), f)) { reject.blocked++; if (trace) trace.push({ k: f.archetype, d: Math.round(dist), px: Math.round(px), w: Math.round(widthPx), why: 'blocked' }); continue; }
      reject.ok++;
      if (trace) trace.push({ k: f.archetype, d: Math.round(dist), px: Math.round(px), w: Math.round(widthPx), why: 'ok' });
      const cur = seen.get(f.archetype);
      if (!cur || cur.px < px) seen.set(f.archetype, { px: Math.round(px), dist: Math.round(dist), f });
    }
    const legible = {};
    const confirmed = {};
    for (const [kind, v] of seen) {
      legible[kind] = { px: v.px, dist: v.dist, at: [+v.f.x.toFixed(1), +v.f.z.toFixed(1)], h: +v.f.h.toFixed(1) };
      if (withRays && facadeHit(camPos, v.f)) confirmed[kind] = legible[kind];
    }
    return {
      legible,
      confirmed,
      legibleKinds: Object.keys(legible),
      confirmedKinds: Object.keys(confirmed),
      inFrameKinds: [...inFrameKinds],
      reject,
      trace,
    };
  };
  return { audit: audit.length };
});
console.log('WORLD', JSON.stringify(setup));

const pick = await page.evaluate((cfg) => {
  const { MIN_PX } = cfg;
  const g = window.__game;
  const audit = g.city.facadeAudit || [];
  const measure = window.__facadeMeasure;
  if (!audit.length) return { ok: false, reason: 'city.facadeAudit is empty' };

  // ---- stance search -------------------------------------------------------------------------
  // Standing in front of a building is what makes its neighbours visible, so the anchors are the
  // buildings themselves: for a sample of them, stand across the street at five setbacks and three
  // heights, aim at the anchor, and let the measuring function say what is legible. No wall
  // grouping is imposed: a street corner is two walls at once, and the frame should not care.
  const inCollider = (x, z, y, ground) =>
    g.city.colliders.some((c) => x > c.minX - 1.5 && z > c.minZ - 1.5 && x < c.maxX + 1.5 && z < c.maxZ + 1.5 && y < ground + (c.h ?? 30));

  const cheap = [];
  let maxLeg = { n: 0 };
  const stride = Math.max(1, Math.floor(audit.length / 220));
  for (let i = 0; i < audit.length; i += stride) {
    const a = audit[i];
    const nx = -Math.sin(a.yaw);
    const nz = -Math.cos(a.yaw);
    const tx = Math.cos(a.yaw);
    const tz = -Math.sin(a.yaw);
    const faceX = a.x + nx * (a.d / 2);
    const faceZ = a.z + nz * (a.d / 2);
    for (const back of [14, 20, 28, 38, 48]) {
      for (const off of [-20, -10, 0, 10, 20]) {
        for (const eye of [1.7, 3.5, 7]) {
          const px = faceX + nx * back + tx * off;
          const pz = faceZ + nz * back + tz * off;
          const ground = g.city.groundHeightAt(px, pz);
          const cy = ground + eye;
          if (inCollider(px, pz, cy, ground)) continue;
          const at = [a.x, ground + Math.min(8, Math.max(3, a.h * 0.4)), a.z];
          const m = measure([px, cy, pz], at, MIN_PX, false);
          if (m.legibleKinds.length > maxLeg.n) maxLeg = { n: m.legibleKinds.length, m, cam: [px, cy, pz], at, back, eye, off };
          if (m.legibleKinds.length < 5) continue;
          cheap.push({ cam: [px, cy, pz], at, back, eye, off, measure: m, anchor: a });
        }
      }
    }
  }
  if (!cheap.length) return { ok: false, reason: 'no stance shows 5 legible archetypes', maxLeg };

  // ---- the projection is not proof: the rays decide ------------------------------------------
  cheap.sort((a, b) => b.measure.legibleKinds.length - a.measure.legibleKinds.length);
  const results = [];
  const seenCams = [];
  for (const c of cheap) {
    // one stance per 12 m of street: near-duplicates all measure the same picture
    if (seenCams.some((p) => Math.hypot(p[0] - c.cam[0], p[1] - c.cam[2]) < 12)) continue;
    seenCams.push(c.cam);
    const m = measure(c.cam, c.at, MIN_PX, true);
    if (m.confirmedKinds.length < 4) continue;
    results.push({
      score: m.confirmedKinds.length * 1000 + m.legibleKinds.length * 10 + Math.max(0, 7 - c.eye) + Math.min(3, Math.round(m.confirmedKinds.reduce((a, k) => a + m.confirmed[k].px, 0) / 800)),
      ...c,
      measure: m,
    });
    if (results.length >= 12) break;
  }
  if (!results.length) return { ok: false, reason: 'no stance confirms 4 archetypes with a raycast', cheap: cheap.length, maxLeg };
  results.sort((a, b) => b.score - a.score);
  const best = results[0];

  // ---- the sampled street: the buildings in the shot's own frontage plane --------------------
  const a = best.anchor;
  const nx = -Math.sin(a.yaw);
  const nz = -Math.cos(a.yaw);
  const street = [];
  for (const o of audit) {
    if (Math.sin(a.yaw) * Math.sin(o.yaw) + Math.cos(a.yaw) * Math.cos(o.yaw) < 0.94) continue;
    const dx = o.x - a.x;
    const dz = o.z - a.z;
    if (Math.abs(dx * nx + dz * nz) > 9) continue;
    if (Math.abs(dx * Math.cos(a.yaw) - dz * Math.sin(a.yaw)) > 120) continue;
    street.push(o);
  }
  const streetKinds = [...new Set(street.map((f) => f.archetype))];
  return {
    ok: true,
    buildings: audit.length,
    stances: cheap.length,
    tested: results.length,
    street: streetKinds,
    streetBuildings: street.length,
    anchorKind: a.archetype,
    atPick: best.measure,
    cam: best.cam,
    at: best.at,
    back: best.back,
    eye: best.eye,
    off: best.off,
    alternatives: results.slice(0, 5).map((r) => ({ cam: r.cam, at: r.at, back: r.back, eye: r.eye, off: r.off })),
  };
}, { MIN_PX: LEGIBLE_PX });

console.log('STREET PICK', JSON.stringify(pick));
if (!pick.ok) {
  console.log('FACADE-PICK FAIL', pick.reason);
  await browser.close();
  process.exit(1);
}

const out = `screenshots/proof/${OUT_NAME}.png`;

/** Measure whatever the camera is pointed at now, plus the block mix of the whole city. */
const measureFrame = () =>
  page.evaluate((cfg) => {
    const { MIN_PX } = cfg;
    const g = window.__game;
    const cam = g.camera;
    const pos = cam.position.toArray();
    const dir = new g.THREE.Vector3();
    cam.getWorldDirection(dir);
    const at = [pos[0] + dir.x * 20, pos[1] + dir.y * 20, pos[2] + dir.z * 20];
    // Block mixing: the card's other rule is "a block mixes archetypes, not repeats one". Snap every
    // block LOT (frontage rows are their own runs along a road, not blocks) to the 170 m block pitch
    // and count the types in each cell.
    const audit = g.city.facadeAudit || [];
    const cells = new Map();
    for (const f of audit) {
      if (f.source !== 'block') continue;
      const k = `${Math.round(f.x / 170)},${Math.round(f.z / 170)}`;
      const c = cells.get(k) || { n: 0, kinds: new Set() };
      c.n++;
      c.kinds.add(f.archetype);
      cells.set(k, c);
    }
    const blocks = [...cells.values()].map((c) => ({ n: c.n, distinct: c.kinds.size, kinds: [...c.kinds] })).filter((b) => b.n >= 5);
    blocks.sort((a, b) => a.distinct - b.distinct);
    // The sampled street: the road the camera is standing on, then every audited building within
    // 150 m of the camera along it. A street, not a plane: both sides and the corner count.
    const roads = g.city.roads || [];
    let road = null;
    for (const r of roads) {
      for (let i = 0; i < r.path.length - 1; i++) {
        const [x1, z1] = r.path[i];
        const [x2, z2] = r.path[i + 1];
        const len2 = (x2 - x1) ** 2 + (z2 - z1) ** 2 || 1;
        const t = Math.max(0, Math.min(1, ((pos[0] - x1) * (x2 - x1) + (pos[2] - z1) * (z2 - z1)) / len2));
        const px = x1 + (x2 - x1) * t;
        const pz = z1 + (z2 - z1) * t;
        const d = Math.hypot(pos[0] - px, pos[2] - pz);
        if (!road || d < road.d) road = { d, x: px, z: pz, r };
      }
    }
    const street = road
      ? audit.filter(
          (f) =>
            Math.hypot(f.x - road.x, f.z - road.z) < 150 &&
            g.city.distToPath(f.x, f.z, road.r.path) < road.r.width / 2 + 30
        )
      : [];
    const streetKinds = [...new Set(street.map((f) => f.archetype))];
    return {
      measure: window.__facadeMeasure(pos, at, MIN_PX),
      camPos: pos.map((v) => +v.toFixed(1)),
      calls: g.state.calls,
      tris: g.state.tris,
      textures: g.renderer.info.memory.textures,
      geometries: g.renderer.info.memory.geometries,
      street: { road: road ? road.r.name || null : null, buildings: street.length, kinds: streetKinds },
      blocks: {
        sampled: blocks.length,
        minDistinct: blocks.length ? blocks[0].distinct : 0,
        medianDistinct: blocks.length ? blocks[Math.floor(blocks.length / 2)].distinct : 0,
        meanBuildings: blocks.length ? +(blocks.reduce((a, b) => a + b.n, 0) / blocks.length).toFixed(1) : 0,
        shareWith4: blocks.length ? +(blocks.filter((b) => b.distinct >= 4).length / blocks.length).toFixed(2) : 0,
        histogram: blocks.reduce((acc, b) => {
          acc[b.distinct] = (acc[b.distinct] || 0) + 1;
          return acc;
        }, {}),
        thinnest: blocks.slice(0, 3),
      },
    };
  }, { MIN_PX: LEGIBLE_PX });

// Try the best stance, then the next best if the saved camera confirms fewer types than the search
// promised. The saved frame is the authority: the pick is a projection, the verdict is the scene.
let shotTris = 0;
let verdict = null;
let chosen = pick;
for (const cand of [pick, ...(pick.alternatives || [])]) {
  await setView(cand.cam, cand.at);
  // When the camera jumps hundreds of metres, headless can screenshot the PREVIOUS compositor frame
  // (a whole empty block of land where the street should be). Retake until the retained shot is a
  // frame with geometry in it.
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.screenshot({ path: out });
    shotTris = await page.evaluate(() => window.__game.state.tris);
    if (shotTris > 250000) break;
    console.log('RETAKE', OUT_NAME, 'frame drew only', shotTris, 'triangles');
    await setView(cand.cam, cand.at);
  }
  verdict = await measureFrame();
  chosen = cand;
  console.log('STANCE', JSON.stringify({ cam: cand.cam.map((v) => +v.toFixed(1)), confirmed: verdict.measure.confirmedKinds }));
  if (verdict.measure.confirmedKinds.length >= MIN_LEGIBLE) break;
}

const m = verdict.measure;
const problems = [];
if (m.confirmedKinds.length < MIN_LEGIBLE) problems.push(`only ${m.confirmedKinds.length} archetypes confirmed by raycast in the saved frame: ${m.confirmedKinds.join(', ')}`);
if (m.legibleKinds.length < MIN_LEGIBLE) problems.push(`only ${m.legibleKinds.length} archetypes are legible (>= ${LEGIBLE_PX} px) in the frame: ${m.legibleKinds.join(', ')}`);
if (verdict.calls >= MAX_CALLS) problems.push(`${verdict.calls} draw calls, budget ${MAX_CALLS}`);
if (verdict.street.kinds.length < MIN_LEGIBLE) problems.push(`the sampled street (${verdict.street.road}) only holds ${verdict.street.kinds.length} types over ${verdict.street.buildings} buildings`);
if (verdict.blocks.sampled && (verdict.blocks.medianDistinct < 4 || verdict.blocks.shareWith4 < 0.7))
  problems.push(`block mix is thin: median ${verdict.blocks.medianDistinct} types, ${Math.round(verdict.blocks.shareWith4 * 100)}% of ${verdict.blocks.sampled} blocks hold 4+`);
if (errors.length) problems.push(`page errors: ${errors.slice(0, 3).join(' | ')}`);
if (shotTris < 250000) problems.push(`the captured frame drew only ${shotTris} triangles (camera or compositor problem)`);

const report = {
  file: out,
  legibleArchetypes: m.legible,
  legibleCount: m.legibleKinds.length,
  confirmedArchetypes: m.confirmed,
  confirmedCount: m.confirmedKinds.length,
  inFrameKinds: m.inFrameKinds,
  sampledStreet: verdict.street,
  blocks: verdict.blocks,
  drawCalls: verdict.calls,
  triangles: verdict.tris,
  textures: verdict.textures,
  geometries: verdict.geometries,
  stance: { back: chosen.back, eye: chosen.eye, off: chosen.off, cam: verdict.camPos },
};
console.log('MEASURED', JSON.stringify(report));
fs.writeFileSync(out.replace(/\.png$/, '.json'), JSON.stringify(report, null, 1) + '\n');

if (problems.length) {
  console.log('FACADE-PROOF FAIL');
  for (const p of problems) console.log(' -', p);
  await browser.close();
  process.exit(1);
}
console.log(
  `OK ${out}: ${m.confirmedKinds.length}/${MIN_LEGIBLE} archetypes legible and raycast-confirmed in one frame ` +
    `(${m.confirmedKinds.join(', ')}); ${verdict.street.kinds.length} distinct across ${verdict.street.buildings} buildings ` +
    `on ${verdict.street.road} (${verdict.street.kinds.join(', ')}); ${verdict.calls} draw calls, ${verdict.tris} triangles`
);
await browser.close();
