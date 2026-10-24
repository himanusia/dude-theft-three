// The ground contract, as a regression suite.
//
// The owner's report was "when I'm on the trotoar my feet sink, when I'm on the road my feet float".
// Both were real: `city.groundHeightAt` re-derived the surface from the terrain under the query
// point (a plate is a flat box lifted by the terrain under the BLOCK CENTRE, up to 7 m away from
// that), and the actors were planted by the shoe's centre minus half its height, which sinks the
// planted foot as soon as the leg swings. This suite measures the surface that is actually drawn -
// a ray cast down onto the built city, never `groundHeightAt` - and compares it with the sole of the
// player and of the crowd.
//
// Usage: node tests/world/ground.mjs            (spawns its own vite server, like the other suites)
//        DTA_URL=http://localhost:PORT node tests/world/ground.mjs
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOL = 0.02;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}

async function freePort() {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

let server = null;
let base = process.env.DTA_URL;
if (!base) {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(base + '/index.html');
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
}

const b = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  defaultViewport: { width: 1024, height: 700 },
  protocolTimeout: 600000,
});

try {
  const page = await b.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction('window.__game !== undefined', { timeout: 120000 });
  await sleep(1200);
  await page.click('#start-btn');
  await sleep(2000);

  const out = await page.evaluate(async () => {
    const g = window.__game;
    const T = g.THREE;
    const { terrainHeight } = await import('/src/world/terrain.ts');
    const ray = new T.Raycaster();
    const down = new T.Vector3(0, -1, 0);
    const box = new T.Box3();
    const GROUND = new Set(['terrain', 'plate', 'lawn', 'lot', 'trotoar', 'kerb', 'gutter', 'kerb-ramp', 'road-arterial', 'road-local', 'road-shoulder', 'crossing-stripes', 'tactile']);
    const meshes = [];
    g.city.group.traverse((o) => { if (o.isMesh && GROUND.has(o.name)) meshes.push(o); });

    const surfaceAt = (x, z, from = 120) => {
      ray.set(new T.Vector3(x, from, z), down);
      ray.far = from + 200;
      const hits = ray.intersectObjects(meshes, false).filter((h) => h.object.visible);
      if (!hits.length) return { top: null, what: 'none' };
      return { top: +hits[0].point.y.toFixed(4), what: hits[0].object.name };
    };

    const pedGroups = new Set(g.peds.peds.map((p) => p.char.group));
    const shoeGeo = g.peds.peds[0].char.legL.children[1].geometry.uuid;
    const findPlayerRoot = () => {
      for (const o of g.scene.children) {
        if (!o.isGroup || o === g.city.group || pedGroups.has(o)) continue;
        if (Math.abs(o.position.x - g.player.pos.x) < 0.08 && Math.abs(o.position.z - g.player.pos.z) < 0.08) return o;
      }
      return null;
    };
    const soleOf = (root) => {
      if (!root) return Infinity;
      let sole = Infinity;
      root.traverse((o) => {
        if (!o.isMesh || o.geometry.uuid !== shoeGeo) return;
        box.setFromObject(o);
        if (box.min.y < sole) sole = box.min.y;
      });
      return sole;
    };
    const settle = (n = 10) => new Promise((res) => {
      let i = 0;
      const f = () => (++i >= n ? res() : requestAnimationFrame(f));
      requestAnimationFrame(f);
    });

    const plates = [];
    g.city.group.traverse((o) => {
      if (o.name !== 'plate' || !o.geometry?.parameters) return;
      const p = new T.Vector3();
      o.getWorldPosition(p);
      plates.push({ x: p.x, z: p.z, top: +(p.y + 0.13).toFixed(4), half: o.geometry.parameters.width / 2 });
    });

    // the three places the owner named, chosen from the built geometry
    let walk = null;
    for (const pl of plates) {
      const inset = pl.half - 1.6;
      for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1], [0.4, 0.4], [-0.4, -0.4]]) {
        const x = pl.x + sx * inset;
        const z = pl.z + sz * inset;
        const s = surfaceAt(x, z);
        if (s.top === null || s.what !== 'plate' || Math.abs(s.top - pl.top) > 0.005) continue;
        const err = Math.abs(s.top - g.city.groundHeightAt(x, z));
        if (!walk || err > walk.err) walk = { x, z, s, err, plateTop: pl.top };
      }
    }
    let road = null;
    for (let i = 0; i < 90; i++) {
      const p = g.city.randomRoadPoint(null, 30);
      const s = surfaceAt(p.x, p.z);
      if (s.top === null || s.what !== 'road-arterial') continue;
      const err = Math.abs(s.top - g.city.groundHeightAt(p.x, p.z));
      if (!road || err > road.err) road = { x: p.x, z: p.z, s, err };
    }
    let ramp = null;
    let rampMesh = null;
    g.city.group.traverse((o) => { if (o.name === 'kerb-ramp' && !rampMesh) rampMesh = o; });
    if (rampMesh) {
      const pos = rampMesh.geometry.attributes.position;
      const index = rampMesh.geometry.index;
      const va = new T.Vector3(), vb = new T.Vector3(), vc = new T.Vector3(), e1 = new T.Vector3(), e2 = new T.Vector3(), n = new T.Vector3();
      const count = index ? index.count : pos.count;
      let bestErr = -1;
      for (let i = 0; i + 2 < count; i += 3) {
        va.fromBufferAttribute(pos, index ? index.getX(i) : i).applyMatrix4(rampMesh.matrixWorld);
        vb.fromBufferAttribute(pos, index ? index.getX(i + 1) : i + 1).applyMatrix4(rampMesh.matrixWorld);
        vc.fromBufferAttribute(pos, index ? index.getX(i + 2) : i + 2).applyMatrix4(rampMesh.matrixWorld);
        e1.copy(vb).sub(va); e2.copy(vc).sub(va); n.crossVectors(e1, e2).normalize();
        if (n.y < 0.5) continue;
        const cx = (va.x + vb.x + vc.x) / 3, cz = (va.z + vb.z + vc.z) / 3, cy = (va.y + vb.y + vc.y) / 3;
        const lift = cy - terrainHeight(cx, cz);
        if (lift < 0.12 || lift > 0.17) continue;
        const top = surfaceAt(cx, cz);
        if (top.what !== 'kerb-ramp' || Math.abs(top.top - cy) > 0.01) continue;
        const inside =
          surfaceAt(cx + 0.12, cz).what === 'kerb-ramp' &&
          surfaceAt(cx - 0.12, cz).what === 'kerb-ramp' &&
          surfaceAt(cx, cz + 0.12).what === 'kerb-ramp' &&
          surfaceAt(cx, cz - 0.12).what === 'kerb-ramp';
        if (!inside) continue;
        if (g.city.groundInfoAt && g.city.groundInfoAt(cx, cz).kind !== 'ramp') continue;
        const err = Math.abs(cy - g.city.groundHeightAt(cx, cz));
        if (err > bestErr) { bestErr = err; ramp = { x: cx, z: cz, s: { top: +cy.toFixed(4), what: 'kerb-ramp' }, err }; }
      }
    }

    const at = async (p) => {
      if (!p) return null;
      g._test.teleport(p.x, p.z);
      await settle(12);
      const sole = soleOf(findPlayerRoot());
      return { at: [+p.x.toFixed(2), +p.z.toFixed(2)], foot: +sole.toFixed(4), surface: p.s.top, what: p.s.what, delta: +(sole - p.s.top).toFixed(4) };
    };

    const rows = { asphalt: await at(road), trotoar: await at(walk), ramp: await at(ramp) };

    // the stride: the planted sole must stay on the measure under the player for every frame
    let stride = null;
    if (walk) {
      g._test.teleport(walk.x - 2.5, walk.z);
      await settle(6);
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
      let worst = 0;
      let frames = 0;
      const t0 = performance.now();
      await new Promise((res) => {
        const f = () => {
          const sole = soleOf(findPlayerRoot());
          if (sole !== Infinity) {
            const ground = g.city.groundHeightAt(g.player.pos.x, g.player.pos.z);
            worst = Math.max(worst, Math.abs(sole - ground));
            frames++;
          }
          if (performance.now() - t0 < 900) requestAnimationFrame(f); else res();
        };
        f();
      });
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
      await settle(6);
      stride = { frames, worst: +worst.toFixed(4) };
    }

    // the crowd and a sample of plate corners
    const peds = [];
    for (const p of g.peds.peds) {
      if (p.dead || peds.length >= 6) continue;
      await settle(2);
      const s = surfaceAt(p.pos.x, p.pos.z, 60);
      if (s.top === null) continue;
      peds.push(+(soleOf(p.char.group) - s.top).toFixed(3));
    }
    const corners = [];
    for (let i = 0; i < plates.length && corners.length < 20; i += Math.max(1, Math.floor(plates.length / 20))) {
      const pl = plates[i];
      const x = pl.x + (pl.half - 1.6);
      const z = pl.z + (pl.half - 1.6);
      const s = surfaceAt(x, z);
      if (s.top === null || s.what !== 'plate' || Math.abs(s.top - pl.top) > 0.005) continue;
      corners.push(+(g.city.groundHeightAt(x, z) - pl.top).toFixed(3));
    }

    return { rows, stride, peds, corners, plates: plates.length };
  });

  const { rows, stride, peds, corners } = out;
  const d = (k) => (rows[k] ? rows[k].delta : null);
  check('asphalt: the sole sits on the drawn road', rows.asphalt && Math.abs(d('asphalt')) <= TOL, rows.asphalt);
  check('trotoar: the sole sits on the drawn plate', rows.trotoar && Math.abs(d('trotoar')) <= TOL, rows.trotoar);
  check('crossing ramp: the sole sits on the drawn slope', rows.ramp && Math.abs(d('ramp')) <= TOL, rows.ramp);
  check('a walking stride never leaves the ground', stride && stride.worst <= 0.005, stride);
  check('every pedestrian stands on the drawn surface', peds.length > 0 && peds.every((g) => Math.abs(g) <= 0.03), peds);
  check('the measure agrees with the drawn plate at sampled corners', corners.length > 0 && corners.every((c) => Math.abs(c) <= TOL), corners);
  check('no page errors', errs.length === 0, errs.slice(0, 4));

  const failed = results.filter((r) => !r.ok);
  console.log('SUMMARY', JSON.stringify({ pass: results.length - failed.length, total: results.length }));
  if (failed.length) process.exitCode = 1;
} finally {
  await b.close();
  if (server) server.kill();
}
