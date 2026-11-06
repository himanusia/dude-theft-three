// Proof shot for the ground contract: the signalised intersection, seen from the carriageway, with
// the measured seat printed next to the picture.
//
//   DTA_URL=http://127.0.0.1:8991 node tools/shoot-street-seated.mjs
//
// Writes proof/intersection-seated.png and proof/intersection-seated.json. The numbers in the JSON
// are the claim in the card: the kit's carriageway at the junction anchor, the city's measure there,
// and the player standing on it - not a picture that merely looks flat.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || process.argv[2] || 'http://127.0.0.1:8991';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync('proof', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  defaultViewport: { width: 1600, height: 1000 },
  protocolTimeout: 600000,
});
const errors = [];
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 240000 });
await page.waitForFunction('window.__game !== undefined', { timeout: 240000 });
await sleep(1500);
await page.click('#start-btn');
await sleep(2500);

const scene = await page.evaluate(() => {
  const g = window.__game;
  g._test.cinematic(true);
  const hud = document.getElementById('hud');
  if (hud) hud.style.display = 'none';
  const junction = (g.city.propAudit || []).find((a) => a.name === 'street:signal-intersection');
  const kit = [];
  g.scene.traverse((o) => { if (o.userData?.streetkit?.kind === 'signal-intersection') kit.push(o); });
  if (!junction || !kit.length) return null;
  const grp = kit[0];
  grp.updateMatrixWorld(true);
  const T = g.THREE;
  const box = new T.Box3().setFromObject(grp);
  // the drawn carriageway at the anchor: lowest upward face (under the paint)
  const ray = new T.Raycaster(new T.Vector3(junction.x, box.max.y + 40, junction.z), new T.Vector3(0, -1, 0));
  ray.far = 400;
  let drawn = null;
  for (const h of ray.intersectObject(grp, true)) {
    if (!h.face) continue;
    const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
    if (n.y < 0.5) continue;
    if (drawn === null || h.point.y < drawn) drawn = h.point.y;
  }
  // the same face on the walk at the junction's north-east corner, and at the T's through road
  const ground = g.city.groundHeightAt(junction.x, junction.z);
  const walk = g.city.groundInfoAt(junction.x + 5.6, junction.z + 5.6);
  const t = (g.city.propAudit || []).find((a) => a.name === 'street:t-intersection');
  const tGround = t ? g.city.groundHeightAt(t.x, t.z) : null;

  // stand the player on the junction: the body must sit on the surface, not 23 cm inside it
  g._test.teleport(junction.x, junction.z);
  const player = { y: g.player.y, ground: g.city.groundHeightAt(g.player.pos.x, g.player.pos.z) };

  return {
    anchor: { x: junction.x, z: junction.z },
    auditBottom: +junction.bottom.toFixed(3),
    measure: +ground.toFixed(3),
    drawnAsphalt: drawn === null ? null : +drawn.toFixed(3),
    seatGap: drawn === null ? null : +(drawn - ground).toFixed(3),
    walk: { y: +walk.y.toFixed(3), kind: walk.kind },
    tAnchor: t ? { x: t.x, z: t.z, bottom: +t.bottom.toFixed(3), measure: +tGround.toFixed(3) } : null,
    player: { y: +player.y.toFixed(3), ground: +player.ground.toFixed(3), gap: +(player.y - player.ground).toFixed(3) },
    streetRows: (g.city.propAudit || []).filter((a) => String(a.name).startsWith('street:')).length,
  };
});

if (!scene) {
  console.error('no signal intersection in this city');
  await browser.close();
  process.exit(1);
}
console.log('SEAT ' + JSON.stringify(scene));

// two views of the same junction: from the carriageway looking across the box, and a low view along
// the kerb line where the walk, the kerb stone and the asphalt meet the ground in one frame
const shot = async (name, cam, at, fov) => {
  await page.evaluate(([f, a, fov]) => {
    if (fov) {
      window.__game.camera.fov = fov;
      window.__game.camera.updateProjectionMatrix();
    }
    window.__game._test.lookFrom(f[0], f[1], f[2], a[0], a[1], a[2]);
  }, [cam, at, fov || 0]);
  await sleep(600);
  await page.screenshot({ path: `proof/${name}.png` });
  console.log('SHOT', `proof/${name}.png`);
};

const { x, z } = scene.anchor;
const gy = scene.measure;
// Pick the stance from the geometry, not a constant: a camera at `anchor + (13, 11)` stands inside a
// shopfront on some layouts, and the "grey patchwork" in the first proof shot was a facade's window
// grid seen from behind. Walk the ring, keep a position whose sight line to the junction is clear.
const stance = await page.evaluate(([x, z, gy]) => {
  const g = window.__game;
  const T = g.THREE;
  const colliders = g.city.colliders || [];
  const inside = (px, py, pz) => colliders.some((c) => px >= c.minX && px <= c.maxX && pz >= c.minZ && pz <= c.maxZ && py <= c.h);
  const clear = (a, b) => {
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const px = a[0] + (b[0] - a[0]) * t;
      const py = a[1] + (b[1] - a[1]) * t;
      const pz = a[2] + (b[2] - a[2]) * t;
      if (inside(px, py, pz)) return false;
    }
    return true;
  };
  const target = [x, gy + 0.4, z];
  const candidates = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    for (const [d, h] of [[14, 4.2], [17, 5.0], [11, 3.2], [20, 6.5], [9, 2.6]]) {
      const p = [x + Math.cos(a) * d, gy + h, z + Math.sin(a) * d];
      if (inside(p[0], p[1], p[2])) continue;
      if (!clear(p, target)) continue;
      candidates.push({ p, a: +a.toFixed(2), d, h });
    }
  }
  // prefer a low, close three-quarter view: the junction fills the frame and the kerb line reads
  candidates.sort((m, n) => m.d - n.d || m.h - n.h);
  const chosen = candidates[0];
  if (!chosen) return null;
  const cam = g.camera;
  cam.position.set(chosen.p[0], chosen.p[1], chosen.p[2]);
  cam.lookAt(new T.Vector3(target[0], target[1], target[2]));
  cam.updateMatrixWorld(true);
  cam.fov = 60;
  cam.updateProjectionMatrix();
  return { at: chosen.p.map((v) => +v.toFixed(1)), fov: 60, candidates: candidates.length };
}, [x, z, gy]);
const chosen = stance ? stance.at : [x + 13, gy + 3.2, z + 11];
console.log('STANCE ' + JSON.stringify(stance));
await shot('intersection-seated', chosen, [x, gy + 0.4, z], 60);

fs.writeFileSync(
  'proof/intersection-seated.json',
  JSON.stringify({ ...scene, errors: errors.slice(0, 4), url: BASE }, null, 1) + '\n'
);
console.log('JSON proof/intersection-seated.json errors=' + errors.length);
await browser.close();
if (errors.length) process.exit(2);
