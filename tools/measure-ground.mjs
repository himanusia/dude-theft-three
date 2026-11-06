// Ground contract measurement: where does an actor's sole sit compared with the surface
// that is actually drawn, and with the game's own ground measure?
//
// The three walkable places the owner named: the asphalt, the trotoar (pavement) and the kerb
// ramp where a crossing meets the walk. The drawn surface is never read from `groundHeightAt`;
// it is a ray cast down onto the built city, so the measure cannot agree with itself and hide
// the bug it is being measured against.
//
// Usage: DTA_URL=http://localhost:PORT node tools/measure-ground.mjs [--json]
//        (start the dev server from the tree you want to measure)
// Exit code 1 when any of the three foot-to-surface deltas is further than 0.02 m from zero.
import puppeteer from 'puppeteer-core';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOL = 0.02;

(async () => {
  const b = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
    defaultViewport: { width: 1024, height: 700 },
    protocolTimeout: 600000,
  });
  const page = await b.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto((process.env.DTA_URL || 'http://localhost:8765') + '/index.html', {
    waitUntil: 'domcontentloaded',
    timeout: 180000,
  });
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

    // the drawn ground only: the terrain, the plates and the street kit's ribbons. Raying the
    // whole city would test every prop and every instanced tree for a height.
    const GROUND = new Set(['terrain', 'plate', 'lawn', 'lot', 'trotoar', 'kerb', 'gutter', 'kerb-ramp', 'road-arterial', 'road-local', 'road-shoulder', 'crossing-stripes', 'tactile']);
    const groundMeshes = [];
    g.city.group.traverse((o) => { if (o.isMesh && GROUND.has(o.name)) groundMeshes.push(o); });

    // the drawn surface: straight down onto the city, never through groundHeightAt
    const surfaceAt = (x, z, from = 120) => {
      ray.set(new T.Vector3(x, from, z), down);
      ray.far = from + 200;
      const hits = ray.intersectObjects(groundMeshes, false).filter((h) => h.object.visible);
      if (!hits.length) return { top: null, what: 'none' };
      const h = hits[0];
      return { top: +h.point.y.toFixed(4), what: h.object.name || h.object.geometry?.type || '?' };
    };

    // the player body is not exported: it is the scene group standing on player.pos that is not
    // the city and not a pedestrian, and its shoes are the shared shoe geometry
    const pedGroups = new Set(g.peds.peds.map((p) => p.char.group));
    const shoeGeo = g.peds.peds[0].char.legL.children[1].geometry.uuid;
    const findPlayerRoot = () => {
      for (const o of g.scene.children) {
        if (!o.isGroup || o === g.city.group || pedGroups.has(o)) continue;
        if (Math.abs(o.position.x - g.player.pos.x) < 0.08 && Math.abs(o.position.z - g.player.pos.z) < 0.08) return o;
      }
      return null;
    };
    const soleOf = () => {
      const root = findPlayerRoot();
      if (!root) return { sole: Infinity, shoes: 0 };
      let sole = Infinity;
      let shoes = 0;
      root.traverse((o) => {
        if (!o.isMesh || o.geometry.uuid !== shoeGeo) return;
        shoes += 1;
        box.setFromObject(o);
        if (box.min.y < sole) sole = box.min.y;
      });
      return { sole, shoes };
    };
    const settle = (n = 10) => new Promise((res) => {
      let i = 0;
      const f = () => (++i >= n ? res() : requestAnimationFrame(f));
      requestAnimationFrame(f);
    });

    // ---- find the three places from the geometry that was built -------------------------
    // trotoar: a block plate. The plate is a flat box lifted by the terrain at the block
    // centre, so the corner of a plate is where an analytic measure can disagree most.
    const plates = [];
    g.city.group.traverse((o) => {
      if (o.name !== 'plate' || !o.geometry?.parameters) return;
      const p = new T.Vector3();
      o.getWorldPosition(p);
      const { width } = o.geometry.parameters;
      plates.push({ x: p.x, z: p.z, top: p.y + 0.13, half: width / 2 });
    });
    let walk = null;
    for (const pl of plates) {
      const inset = pl.half - 1.6;
      for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1], [0.4, 0.4], [-0.4, -0.4]]) {
        const x = pl.x + sx * inset;
        const z = pl.z + sz * inset;
        const s = surfaceAt(x, z);
        // the ray has to land on THIS plate: a corner can be covered by the neighbour's kerb ring
        if (s.top === null || s.what !== 'plate' || Math.abs(s.top - pl.top) > 0.005) continue;
        const err = Math.abs(s.top - g.city.groundHeightAt(x, z));
        if (!walk || err > walk.err) walk = { x, z, s, err, plateTop: pl.top, centre: [pl.x, pl.z] };
      }
    }

    // asphalt: a carriageway point on an arterial ribbon, where the ribbon is swept from the
    // terrain at the station rather than at the query point
    let road = null;
    for (let i = 0; i < 90; i++) {
      const p = g.city.randomRoadPoint(null, 30);
      const s = surfaceAt(p.x, p.z);
      if (s.top === null || s.what !== 'road-arterial') continue;
      const err = Math.abs(s.top - g.city.groundHeightAt(p.x, p.z));
      if (!road || err > road.err) road = { x: p.x, z: p.z, s, err };
    }

    // the kerb ramp: a triangle centroid halfway down the ramp's own slope
    let ramp = null;
    let rampMesh = null;
    g.city.group.traverse((o) => { if (o.name === 'kerb-ramp' && !rampMesh) rampMesh = o; });
    if (rampMesh) {
      const pos = rampMesh.geometry.attributes.position;
      const index = rampMesh.geometry.index;
      const a = new T.Vector3();
      const b2 = new T.Vector3();
      const c = new T.Vector3();
      const va = new T.Vector3();
      const vb = new T.Vector3();
      const vc = new T.Vector3();
      const count = index ? index.count : pos.count;
      let bestErr = -1;
      for (let i = 0; i + 2 < count; i += 3) {
        const ia = index ? index.getX(i) : i;
        const ib = index ? index.getX(i + 1) : i + 1;
        const ic = index ? index.getX(i + 2) : i + 2;
        va.fromBufferAttribute(pos, ia).applyMatrix4(rampMesh.matrixWorld);
        vb.fromBufferAttribute(pos, ib).applyMatrix4(rampMesh.matrixWorld);
        vc.fromBufferAttribute(pos, ic).applyMatrix4(rampMesh.matrixWorld);
        a.copy(vb).sub(va);
        b2.copy(vc).sub(va);
        c.crossVectors(a, b2).normalize();
        if (c.y < 0.5) continue;                       // only a face you can stand on
        const cx = (va.x + vb.x + vc.x) / 3;
        const cz = (va.z + vb.z + vc.z) / 3;
        const cy = (va.y + vb.y + vc.y) / 3;
        const lift = cy - terrainHeight(cx, cz);
        if (lift < 0.12 || lift > 0.17) continue;      // mid-slope, clear of both seams
        // the ramp has to be the topmost drawn surface there, or the point is under a plate, and the
        // point has to be well inside it: a triangle centroid can sit on the seam where the trotoar
        // starts, and that seam is not the slope the owner walks down
        const top = surfaceAt(cx, cz);
        if (top.what !== 'kerb-ramp' || Math.abs(top.top - cy) > 0.01) continue;
        const inside =
          surfaceAt(cx + 0.12, cz).what === 'kerb-ramp' &&
          surfaceAt(cx - 0.12, cz).what === 'kerb-ramp' &&
          surfaceAt(cx, cz + 0.12).what === 'kerb-ramp' &&
          surfaceAt(cx, cz - 0.12).what === 'kerb-ramp';
        if (!inside) continue;
        // and the surface under it must be the ramp, not a second surface drawn over a buried one
        // (two crossings can overlap; an older tree has no `groundInfoAt`, so it keeps its answer)
        if (g.city.groundInfoAt && g.city.groundInfoAt(cx, cz).kind !== 'ramp') continue;
        const err = Math.abs(cy - g.city.groundHeightAt(cx, cz));
        if (err > bestErr) { bestErr = err; ramp = { x: cx, z: cz, s: { top: +cy.toFixed(4), what: 'kerb-ramp' }, err, lift: +lift.toFixed(3) }; }
      }
    }

    // ---- measure the player at each place ---------------------------------------------
    const at = async (label, p) => {
      if (!p) return { label, missing: true };
      g._test.teleport(p.x, p.z);
      await settle(12);
      const { sole, shoes } = soleOf();
      // `groundInfoAt` names the surface; an older tree only has the height
      const info = g.city.groundInfoAt ? g.city.groundInfoAt(p.x, p.z) : { y: g.city.groundHeightAt(p.x, p.z), kind: '?' };
      const measure = info.y;
      return {
        label,
        at: [+p.x.toFixed(2), +p.z.toFixed(2)],
        shoes,
        footY: +sole.toFixed(4),
        surfaceY: p.s.top,
        surfaceWhat: p.s.what,
        measureY: +measure.toFixed(4),
        measureKind: info.kind,
        terrainY: +terrainHeight(p.x, p.z).toFixed(4),
        playerY: +g.player.y.toFixed(4),
        footVsSurface: +(sole - p.s.top).toFixed(4),
        surfaceVsMeasure: +(p.s.top - measure).toFixed(4),
        ...(p.lift !== undefined ? { rampLift: p.lift } : {}),
      };
    };

    const rows = [
      await at('asphalt', road),
      await at('trotoar', walk),
      await at('crossing ramp', ramp),
    ];

    // ---- walking: the planted foot must not dip under the plate -------------------------
    let walkAnim = null;
    if (walk) {
      const surface = surfaceAt(walk.x, walk.z).top;
      g._test.teleport(walk.x - 2.5, walk.z);
      await settle(6);
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
      let lo = Infinity;
      let hi = -Infinity;
      let frames = 0;
      // the stride is the point: the planted sole must stay on the measure under the player for
      // every frame of the walk cycle, not only in a standing pose
      const t0 = performance.now();
      await new Promise((res) => {
        const f = () => {
          const { sole } = soleOf();
          const ground = g.city.groundHeightAt(g.player.pos.x, g.player.pos.z);
          if (sole !== Infinity) { lo = Math.min(lo, sole - ground); hi = Math.max(hi, sole - ground); frames++; }
          if (performance.now() - t0 < 900) requestAnimationFrame(f); else res();
        };
        f();
      });
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
      await settle(6);
      walkAnim = {
        frames,
        surface,
        soleMin: +lo.toFixed(4),
        soleMax: +hi.toFixed(4),
        worstVsGround: +(lo < 0 ? lo : hi > 0 ? hi : Math.max(Math.abs(lo), Math.abs(hi))).toFixed(4),
      };
    }

    // ---- how far off the drawn plate is the measure, across a sample of plates -----------
    // (the three rows above are the acceptance; this is the size of the population the bug hits)
    const plateSample = [];
    for (let i = 0; i < plates.length && plateSample.length < 24; i += Math.max(1, Math.floor(plates.length / 24))) {
      const pl = plates[i];
      const inset = pl.half - 1.6;
      const x = pl.x + inset;
      const z = pl.z + inset;
      const s = surfaceAt(x, z);
      if (s.top === null || s.what !== 'plate' || Math.abs(s.top - pl.top) > 0.005) continue;
      plateSample.push(+(g.city.groundHeightAt(x, z) - pl.top).toFixed(3));
    }

    // ---- the crowd, same question -------------------------------------------------------
    const peds = [];
    for (const p of g.peds.peds) {
      if (p.dead || peds.length >= 6) continue;
      await settle(2);
      const s = surfaceAt(p.pos.x, p.pos.z, 60);
      if (s.top === null) continue;
      let sole = Infinity;
      for (const shoe of [p.char.legL.children[1], p.char.legR.children[1]]) {
        box.setFromObject(shoe);
        sole = Math.min(sole, box.min.y);
      }
      peds.push({ gap: +(sole - s.top).toFixed(3), what: s.what, measureGap: +(s.top - g.city.groundHeightAt(p.pos.x, p.pos.z)).toFixed(3) });
    }

    const off = plateSample.filter((d) => Math.abs(d) > 0.02);
    return {
      rows,
      walkAnim,
      peds,
      plates: plates.length,
      plateSample: { checked: plateSample.length, off: off.length, worst: plateSample.length ? plateSample.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a)) : 0 },
    };
  });

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...out, errors: errs.slice(0, 3) }, null, 1));
  } else {
    console.log('label'.padEnd(15) + 'at'.padEnd(20) + 'foot'.padEnd(9) + 'surface'.padEnd(9) + 'measure'.padEnd(9) + 'terrain'.padEnd(9) + 'foot-surface  surface-measure');
    for (const r of out.rows) {
      if (r.missing) { console.log(r.label.padEnd(15) + 'NOT FOUND'); continue; }
      console.log(
        r.label.padEnd(15) +
        String(r.at).padEnd(20) +
        String(r.footY).padEnd(9) +
        String(r.surfaceY).padEnd(9) +
        String(r.measureY + ' ' + (r.measureKind ?? '')).padEnd(16) +
        String(r.terrainY).padEnd(9) +
        String(r.footVsSurface).padEnd(14) +
        String(r.surfaceVsMeasure)
      );
    }
    if (out.walkAnim) console.log('WALK ON TROTOAR', JSON.stringify(out.walkAnim));
    console.log('PEDS', JSON.stringify(out.peds));
    console.log('PLATE CORNERS', JSON.stringify(out.plateSample), '(measure minus the drawn plate top)');
    console.log('plates', out.plates, 'ERRORS', JSON.stringify(errs.slice(0, 3)));
  }
  await b.close();

  const required = ['asphalt', 'trotoar', 'crossing ramp'];
  for (const r of out.rows) {
    if (!required.includes(r.label)) continue;
    const ok = !r.missing && r.footVsSurface !== undefined && Math.abs(r.footVsSurface) <= TOL;
    console.log((ok ? 'PASS ' : 'FAIL ') + r.label + ' foot-to-surface ' + (r.missing ? 'missing' : r.footVsSurface + ' m'));
  }
  const bad = out.rows.filter((r) => required.includes(r.label) && (r.missing || r.footVsSurface === undefined || Math.abs(r.footVsSurface) > TOL));
  if (bad.length) process.exitCode = 1;
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
