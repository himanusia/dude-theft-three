// Proof shots for the three kaki lima carts: a 3/4 view from low down, framed on the wheel plane.
// Not part of the game; run against a served dist.
// usage: node tools/shoot-gerobak.mjs [baseUrl]
//
// The camera is derived from the built group (`kaki5-<kind>`), never from coordinates typed in from
// an earlier run: the city layout is randomised per load, so a cached position photographs nothing.
//
// Besides the framing it prints two numbers that a screenshot alone cannot settle:
//  - `sideAspect`: the wheel's silhouette seen from straight out along its own axle. 1.0 means the
//    disc lies in the X-Y plane (rolling along the cart's length); ~0.1 means the axle runs
//    front-to-back and the wheel is the "coin" the owner reported.
//  - `tyreGap`: the bottom of each tyre against `city.groundHeightAt` under it.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || process.argv[2] || 'http://127.0.0.1:8963';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync('screenshots/proof', { recursive: true });

const KINDS = ['bakso', 'nasgor', 'sate'];
// camera in the cart's own frame: behind the serving side and out at the handle end, 0.6 m up, so
// the near wheel is in the foreground and the handle is not hidden by the cabinet
// camera in the cart's own frame: out at the handle end and off to one long side, 1.0 m up (half
// the cart's height). The side is chosen per instance: the carts are seated on their slot, so one
// wheel can hang over the kerb, and the shot is taken from the side that is actually on the ground.
const CAM_XZ = [-2.45, 1.85];
const CAM_Y = 1.02;
const TARGET_LOCAL = [0, 0.62, 0];

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
await page.evaluate(() => {
  const g = window.__game;
  g._test.cinematic(true);
  const hud = document.getElementById('hud');
  if (hud) hud.style.display = 'none';
});
await sleep(300);

const report = [];
for (const kind of KINDS) {
  const candidates = await page.evaluate((k) => {
    const g = window.__game;
    const out = [];
    g.scene.traverse((o) => {
      if (o.name === 'kaki5-' + k) out.push({ x: o.position.x, y: o.position.y, z: o.position.z, yaw: o.rotation.y });
    });
    return out;
  }, kind);
  if (!candidates.length) {
    console.log('MISSING', kind);
    report.push({ kind, ok: false, reason: 'group not found in scene' });
    continue;
  }

  let best = null;
  for (let i = 0; i < candidates.length; i++) {
    for (const side of [1, -1]) {
    const camLocal = [CAM_XZ[0], CAM_Y, CAM_XZ[1] * side];
    const res = await page.evaluate(
      ({ cand, index, camLocal, targetLocal, side, width, height }) => {
        const g = window.__game;
        const THREE = g.THREE;
        const groups = [];
        g.scene.traverse((o) => {
          if (o.name === 'kaki5-' + cand.kind) groups.push(o);
        });
        const group = groups[index];
        const W = (lx, ly, lz) => {
          const c = Math.cos(cand.yaw);
          const s = Math.sin(cand.yaw);
          return new THREE.Vector3(cand.x + lx * c + lz * s, cand.y + ly, cand.z - lx * s + lz * c);
        };

        const cam = W(...camLocal);
        const target = W(...targetLocal);
        g._test.lookFrom(cam.x, cam.y, cam.z, target.x, target.y, target.z);
        const camera = g.camera;
        camera.updateMatrixWorld(true);
        camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
        camera.updateProjectionMatrix();

        // occlusion: the first thing a ray to the cart meets must be the cart itself
        const rc = new THREE.Raycaster();
        const isMine = (o) => {
          let p = o;
          while (p) {
            if (p === group) return true;
            p = p.parent;
          }
          return false;
        };
        const blocked = [];
        for (const s of [[0.38, 0.33, 0.5], [0.38, 0.6, 0.5], [0.38, 0.33, -0.5], [0, 0.9, 0], [0, 1.9, 0], [-1.06, 0.96, 0]]) {
          const p = W(...s);
          const dir = p.clone().sub(cam);
          const dist = dir.length();
          rc.set(cam, dir.normalize());
          const hit = rc.intersectObjects(g.scene.children, true)[0];
          if (hit && hit.distance < dist - 0.05 && !isMine(hit.object)) {
            blocked.push({ at: s, by: hit.object.name || hit.object.type });
          }
        }

        const proj = (v, c, w = width, h = height) => {
          const q = v.clone().project(c);
          return [((q.x + 1) / 2) * w, ((1 - q.y) / 2) * h];
        };
        // the near wheel is the one the shot is about, so every measurement below follows `side`
        const WZ = side * 0.5;
        const hub = proj(W(0.38, 0.33, WZ), camera);
        const top = proj(W(0.38, 0.66, WZ), camera);
        const bottom = proj(W(0.38, 0.0, WZ), camera);
        const fore = proj(W(0.71, 0.33, WZ), camera);
        const aft = proj(W(0.05, 0.33, WZ), camera);
        const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
        const vertical = d2(top, bottom);
        const foreAft = d2(fore, aft);
        const corners = [
          [-0.89, 0, -0.53], [-0.89, 0, 0.53], [0.89, 0, -0.53], [0.89, 0, 0.53], [-1.06, 0, 0], [0, 2.0, 0],
        ].map((s) => proj(W(...s), camera));
        const pad = 16;
        const onScreen =
          hub[0] > pad && hub[0] < width - pad && hub[1] > pad && hub[1] < height - pad &&
          corners.every((p) => p[0] > 0 && p[0] < width && p[1] > 0 && p[1] < height);

        // the decisive test: stand straight out along the wheel's axle (+Z) and look at the hub.
        // A wheel that rolls along X projects a circle here (aspect ~1); the old axle-along-X build
        // projected a sliver, because its disc lay in the Y-Z plane.
        const sideCam = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
        sideCam.position.copy(W(0.38, 0.33, WZ + side * 2.4));
        sideCam.lookAt(W(0.38, 0.33, WZ));
        sideCam.updateMatrixWorld(true);
        sideCam.matrixWorldInverse.copy(sideCam.matrixWorld).invert();
        sideCam.updateProjectionMatrix();
        // square mapping, so a horizontal and a vertical pixel span are the same length
        const sq = (v) => proj(v, sideCam, 1000, 1000);
        const sideHub = sq(W(0.38, 0.33, WZ));
        const sideFore = sq(W(0.71, 0.33, WZ));
        const sideTop = sq(W(0.38, 0.66, WZ));
        const sideAspect = d2(sideFore, sideHub) / d2(sideTop, sideHub);

        // every point that is supposed to be on the ground: both tyres and both feet. A cart
        // parked across a kerb passes the prop audit (it samples the slot only) while one wheel
        // hangs 26 cm over the road, so the framing has to check all four.
        const gapAt = (lx, lz) => {
          const p = W(lx, 0, lz);
          return +(p.y - g.city.groundHeightAt(p.x, p.z)).toFixed(3);
        };
        const gaps = { tyres: [gapAt(0.38, 0.5), gapAt(0.38, -0.5)], feet: [gapAt(-0.6, 0.29), gapAt(-0.6, -0.29)] };
        const level = Math.max(...gaps.tyres.map(Math.abs), ...gaps.feet.map(Math.abs)) <= 0.06;

        return {
          blocked,
          onScreen,
          cam: [cam.x, cam.y, cam.z].map((n) => +n.toFixed(2)),
          hub: hub.map((n) => Math.round(n)),
          vertical: Math.round(vertical),
          foreAft: Math.round(foreAft),
          ratio: +(foreAft / vertical).toFixed(2),
          sideAspect: +sideAspect.toFixed(2),
          gaps,
          level,
        };
      },
      { cand: { ...candidates[i], kind }, index: i, camLocal, targetLocal: TARGET_LOCAL, side, width: 1600, height: 1000 }
    );
    console.log('TRY', kind, i, side > 0 ? '+Z' : '-Z', JSON.stringify(res));
    // the near wheel is the one the shot is about: it has to be the one on the ground
    const nearGap = side > 0 ? res.gaps.tyres[0] : res.gaps.tyres[1];
    const ok = res.onScreen && res.blocked.length === 0 && Math.abs(nearGap) <= 0.06;
    if (ok) {
      best = { candidate: i, side, ...res };
      break;
    }
    const score = res.blocked.length * 10 + Math.abs(nearGap) + (res.onScreen ? 0 : 100);
    if (!best || score < best._score) best = { candidate: i, side, _score: score, ...res };
    }
    if (best && best.ok !== false && best.gaps && Math.abs(best.side > 0 ? best.gaps.tyres[0] : best.gaps.tyres[1]) <= 0.06) break;
  }

  await sleep(500);
  const out = `screenshots/proof/gerobak-${kind}.png`;
  await page.screenshot({ path: out });
  console.log('SHOT', out, JSON.stringify(best));
  report.push({ kind, file: out, ok: best.onScreen && best.blocked.length === 0, ...best });
}

fs.writeFileSync('screenshots/proof/gerobak-framing.json', JSON.stringify(report, null, 1));
console.log('ERRORS', JSON.stringify(errors.slice(0, 6)));
await browser.close();
