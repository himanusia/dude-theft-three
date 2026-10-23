// Proof shots for the street kit: a block of street run, and one junction's four corners.
// Not part of the game; run against a served dist.
// usage: node tools/shoot-street.mjs [baseUrl]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || process.argv[2] || 'http://127.0.0.1:8977';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync('screenshots/proof', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  defaultViewport: { width: 1600, height: 1000 },
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

const scene = await page.evaluate(() => {
  const g = window.__game;
  g._test.cinematic(true);
  const hud = document.getElementById('hud');
  if (hud) hud.style.display = 'none';
  const kits = [];
  g.scene.traverse((o) => {
    if (o.userData && o.userData.streetkit) {
      kits.push({ ...o.userData.streetkit, x: o.position.x, y: o.position.y, z: o.position.z, yaw: o.rotation.y, uuid: o.uuid });
    }
  });
  const audit = (g.city.propAudit || []).filter((a) => String(a.name).startsWith('street:'));
  const junction = audit.find((a) => a.name === 'street:signal-intersection');
  const spines = (g.city.streetSpines || []).map((s) => ({ ...s, len: Math.hypot(s.bx - s.ax, s.bz - s.az) }));
  const report = g._test.audit();
  const streetProps = report.props.filter((p) => String(p.name).startsWith('street:'));
  return {
    kits,
    spines,
    junction: junction ? { x: junction.x, z: junction.z } : null,
    streetFailure: streetProps,
    allPropFailures: report.props.length,
    runs: kits.filter((k) => k.kind === 'run').length,
    ts: kits.filter((k) => k.kind === 't-intersection').length,
    drawCalls: g.renderer.info.render.calls,
    triangles: g.renderer.info.render.triangles,
  };
});
console.log('KITS', JSON.stringify(scene.kits.map((k) => ({ kind: k.kind, radius: k.cornerRadiusM, fill: k.corners && k.corners[0]?.fillM, len: k.lengthM }))));
console.log('JUNCTION', JSON.stringify(scene.junction), 'RUNS', scene.runs, 'T', scene.ts);
console.log('STREET PROP GAPS', JSON.stringify(scene.streetFailure));
console.log('ALL PROP FAILURES', scene.allPropFailures);

// corners: the four corner radii the junction actually built, and whether they agree
if (scene.junction) {
  const cornerCheck = await page.evaluate(() => {
    const g = window.__game;
    const kit = [];
    g.scene.traverse((o) => { if (o.userData?.streetkit?.kind === 'signal-intersection') kit.push(o.userData.streetkit); });
    if (!kit.length) return null;
    const k = kit[0];
    const radii = [...new Set(k.corners.map((c) => c.radius))];
    const fills = [...new Set(k.corners.map((c) => c.fillM))];
    const arcs = [...new Set(k.corners.map((c) => c.arcSteps))];
    // and the geometry: sample the pavement surface at the four corners, mirrored
    const T = g.THREE;
    const ray = new T.Raycaster();
    const down = new T.Vector3(0, -1, 0);
    // the kit's own surfaces only: a shopfront roof is not the corner pavement, and hitting one is
    // how a correct corner got reported as a 5 m slab
    const kitMeshes = [];
    g.scene.traverse((o) => {
      if (!o.userData?.streetkit) return;
      o.traverse((m) => { if (m.isMesh) kitMeshes.push(m); });
    });
    const audit = g.city.propAudit.find((a) => a.name === 'street:signal-intersection');
    const half = k.widthM / 2;
    // On the corner apron and clear of the crossing ramp, which occupies the first 1.2 m behind the
    // kerb line at the arm's end: the diagonal distance keeps the sample off both.
    const d = k.cornerRadiusM + 3.1;
    const samples = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const x = audit.x + sx * d;
        const z = audit.z + sz * d;
        ray.set(new T.Vector3(x, g.terrainHeight(x, z) + 6, z), down);
        const hit = ray.intersectObjects(kitMeshes, false)[0];
        samples.push({
          sx, sz,
          y: hit ? +hit.point.y.toFixed(3) : null,
          above: hit ? +(hit.point.y - g.terrainHeight(x, z)).toFixed(3) : null,
          colour: hit ? '#' + hit.object.material.color.getHexString() : null,
        });
      }
    }
    return { radii, fills, arcs, samples };
  });
  console.log('CORNERS', JSON.stringify(cornerCheck));
}

// draw calls. The cinematic loop stops drawing, so `renderer.info` only moves when a frame is drawn
// on purpose - and hiding a group only shows up in the count if the camera can see it. Measure with
// the camera pointed at the kit, rendering each case synchronously.
const calls = await page.evaluate(async () => {
  const g = window.__game;
  const j = (g.city.propAudit || []).find((a) => a.name === 'street:signal-intersection');
  const tagged = [];
  g.scene.traverse((o) => { if (o.userData?.streetkit) tagged.push(o); });
  const cam = g.camera;
  const keep = { pos: cam.position.clone(), quat: cam.quaternion.clone() };
  const aim = (x, y, z) => { cam.position.set(x + 18, y + 24, z + 18); cam.lookAt(x, y, z); cam.updateMatrixWorld(); };
  if (j) aim(j.x, 0, j.z);
  const renderer = g.renderer;
  renderer.info.autoReset = false;
  const measure = () => { renderer.info.reset(); renderer.render(g.scene, cam); return renderer.info.render.calls; };
  const all = measure();
  for (const t of tagged) t.visible = false;
  const without = measure();
  for (const t of tagged) t.visible = true;
  const runs = tagged.filter((t) => t.userData.streetkit.kind === 'run');
  const runOne = runs.reduce((a, b) => (b.userData.streetkit.lengthM > a.userData.streetkit.lengthM ? b : a), runs[0]);
  for (const t of tagged) t.visible = t === runOne;
  const oneRun = measure();
  for (const t of tagged) t.visible = t.userData.streetkit.kind === 'run';
  const runsOnly = measure();
  for (const t of tagged) t.visible = true;
  renderer.info.autoReset = true;
  cam.position.copy(keep.pos);
  cam.quaternion.copy(keep.quat);
  cam.updateMatrixWorld();
  return {
    sceneAll: all, sceneWithoutKit: without, kit: all - without,
    oneRunIsolated: oneRun - without, oneRunMeshCalls: oneRun,
    fourRunsIsolated: runsOnly - without,
    groups: tagged.length, runs: runs.length,
  };
});
console.log('DRAW CALLS', JSON.stringify(calls));

const shot = async (name, cam, at, fov) => {
  await page.evaluate(([f, a, fov]) => {
    if (fov) {
      window.__game.camera.fov = fov;
      window.__game.camera.updateProjectionMatrix();
    }
    window.__game._test.lookFrom(f[0], f[1], f[2], a[0], a[1], a[2]);
  }, [cam, at, fov || 0]);
  await sleep(500);
  await page.screenshot({ path: `screenshots/proof/${name}.png` });
  console.log('SHOT', `screenshots/proof/${name}.png`);
};

const j = scene.junction;
// the block of street the shot is about: the longest run the kit laid (a run, never the T's stem)
const runs = scene.kits.filter((k) => k.kind === 'run').sort((a, b) => b.lengthM - a.lengthM);
const hero = runs[0];

if (j) {
  // four corners of one junction. High and wide enough that a shopfront cannot stand between the
  // lens and a corner: at 21 m and 45 degrees the near corner was hidden behind a roof and read
  // sharp, which is not what the geometry does (see the material boundary numbers in the report).
  await shot('corners', [j.x + 26, 36, j.z + 26], [j.x, 0.4, j.z], 50);
  await shot('corners-top', [j.x + 2, 52, j.z + 2], [j.x, 0.2, j.z], 40);
  await shot('corners-low', [j.x + 12, 7.5, j.z + 12], [j.x - 2, 0.1, j.z - 2], 62);
  // and the whole kit from the air: the junction, the four runs out of it and the T they meet
  await shot('street-kit-wide', [j.x + 40, 150, j.z + 40], [j.x, 0, j.z], 50);
}
if (hero) {
  const ux = Math.sin(hero.yaw);
  const uz = Math.cos(hero.yaw);
  const W = (across, along, y) => [hero.x + Math.cos(hero.yaw) * across + ux * along, y, hero.z - Math.sin(hero.yaw) * across + uz * along];
  // Stand at the cap end and look back down the block toward the junction: the shot then shows the
  // whole cross-section with the junction as its far end, instead of a dead end in the distance.
  const cam = W(1.9, hero.lengthM / 2 - 5, 2.0);
  const look = W(0, -hero.lengthM / 2 + 4, 1.1);
  await shot('street-run', cam, look, 62);
  await shot('street-run-wide', W(-4, -hero.lengthM / 2 + 5, 14), W(0, hero.lengthM / 2 - 4, 1.1), 55);
}

// surfaces: on the carriageway and on both walks, mid-run (not at the junction, where the arms cross)
const surfaces = await page.evaluate(() => {
  const g = window.__game;
  const T = g.THREE;
  const ray = new T.Raycaster();
  const down = new T.Vector3(0, -1, 0);
  const out = [];
  const spines = (g.city.streetSpines || []).map((s) => ({ ...s, len: Math.hypot(s.bx - s.ax, s.bz - s.az) }));
  spines.sort((a, b) => b.len - a.len);
  const s = spines[0];
  if (!s) return out;
  const ux = (s.bx - s.ax) / s.len, uz = (s.bz - s.az) / s.len;
  const nx = -uz, nz = ux;
  const probe = (label, t, across) => {
    const x = s.ax + ux * s.len * t + nx * across;
    const z = s.az + uz * s.len * t + nz * across;
    ray.set(new T.Vector3(x, g.terrainHeight(x, z) + 6, z), down);
    const hit = ray.intersectObjects(g.scene.children, true).find((h) => h.object.type === 'Mesh' && h.object.visible);
    out.push({
      label, t: +t.toFixed(2), across,
      y: hit ? +hit.point.y.toFixed(3) : null,
      terrain: +g.terrainHeight(x, z).toFixed(3),
      city: +g.city.groundHeightAt(x, z).toFixed(3),
      above: hit ? +(hit.point.y - g.terrainHeight(x, z)).toFixed(3) : null,
      colour: hit ? '#' + hit.object.material.color.getHexString() : null,
      map: hit ? !!hit.object.material.map : null,
    });
  };
  probe('road', 0.5, 0);
  probe('walk-east', 0.5, s.half + 0.3 + s.walkW / 2);
  probe('walk-west', 0.5, -(s.half + 0.3 + s.walkW / 2));
  probe('kerb-east', 0.5, s.half + 0.15);
  probe('bay', 0.78, s.half + 1.1);
  return out;
});
console.log('SURFACES', JSON.stringify(surfaces, null, 1));
console.log('ERRORS', JSON.stringify(errors.slice(0, 5)));
await browser.close();
