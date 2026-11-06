// Every placed street-kit instance and the gap between it and the city's one ground measure.
//
//   DTA_URL=http://127.0.0.1:8991 node tools/probe-streetkit-seat.mjs
//   DTA_URL=... KIT_LOADS=4 node tools/probe-streetkit-seat.mjs     # repeat the randomised city
//
// Two independent gaps per instance, both of which must be under KIT_GAP_MAX (0.02 m):
//
//   row    - the audit row the piece published (`bottom - groundHeightAt(anchor)`), which is exactly
//            the number the playtest's "nothing floats" check reads.
//   drawn  - for the three SURFACE pieces (run, signal intersection, T): a ray down onto the piece's
//            own geometry at that same anchor, lowest upward face (the asphalt under the paint)
//            against the same measure. This is the surface a player stands on, measured from the
//            mesh that is on screen. Fittings have no ground face; their row is the seat.
//
// Exit 2 when any instance is out of tolerance or a street audit row belongs to no piece.
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || 'http://127.0.0.1:8991';
const LOADS = Number(process.env.KIT_LOADS || 1);
const GAP_MAX = Number(process.env.KIT_GAP_MAX || 0.02);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  defaultViewport: { width: 1100, height: 700 },
  protocolTimeout: 600000,
});

const all = [];
const errs = [];
let quads = 0;
let orphanRows = 0;
for (let load = 0; load < LOADS; load++) {
  const page = await b.newPage();
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 240000 });
  await page.waitForFunction('window.__game !== undefined', { timeout: 240000 });
  await sleep(1200);
  await page.click('#start-btn');
  await sleep(2200);

  const out = await page.evaluate((gapMax) => {
    const g = window.__game;
    const T = g.THREE;
    const city = g.city;
    const pieces = [];
    g.scene.traverse((o) => {
      if (o.isGroup && o.userData && o.userData.streetkit) pieces.push(o);
    });
    const rows = city.propAudit || [];
    const used = new Set();
    const ray = new T.Raycaster();
    const down = new T.Vector3(0, -1, 0);
    const nrm = new T.Vector3();
    const box = new T.Box3();

    const report = [];
    for (const grp of pieces) {
      const meta = grp.userData.streetkit;
      const name = `street:${meta.kind === 'run' ? `run-${meta.roadClass}` : meta.kind}`;
      const row = rows.find(
        (r) => r.name === name && Math.abs(r.x - grp.position.x) < 0.05 && Math.abs(r.z - grp.position.z) < 0.05
      );
      if (row) used.add(row);
      const x = row ? row.x : grp.position.x;
      const z = row ? row.z : grp.position.z;

      // The drawn ground of a SURFACE piece at its own anchor: the lowest UPWARD face, which is the
      // asphalt under the paint and the studs, and the walk under its kerb nose. A FITTING (signal,
      // pole, sign, bollard) has no ground face - its geometry starts on the ground - so its seat is
      // its audit row (`gy` at its own anchor); the row gap above is that measurement.
      grp.updateMatrixWorld(true);
      box.setFromObject(grp);
      let drawn = null;
      if (['run', 'signal-intersection', 't-intersection'].includes(meta.kind)) {
        ray.set(new T.Vector3(x, grp.position.y + 400, z), down);
        ray.far = 800;
        for (const h of ray.intersectObject(grp, true)) {
          if (!h.face) continue;
          nrm.copy(h.face.normal).transformDirection(h.object.matrixWorld);
          if (nrm.y < 0.5) continue;
          if (drawn === null || h.point.y < drawn) drawn = h.point.y;
        }
      }

      const ground = city.groundHeightAt(x, z);
      // for a row that is out of tolerance, say which layer of the measure won
      let layers = null;
      if (row && Math.abs(row.bottom - ground) >= gapMax) {
        const layers0 = [];
        for (const p of city.platesNear(x, z, 0)) {
          const inside = p.round !== undefined ? Math.hypot(x - p.x, z - p.z) <= p.round : Math.abs(x - p.x) <= p.hx && Math.abs(z - p.z) <= p.hz;
          if (inside) layers0.push({ layer: 'plate', kind: p.kind, y: +p.top.toFixed(3) });
        }
        const hq = (q) => {
          const t = (p0, p1, p2) => {
            const den = (p1.z - p2.z) * (p0.x - p2.x) + (p2.x - p1.x) * (p0.z - p2.z);
            if (Math.abs(den) < 1e-7) return null;
            const l0 = ((p1.z - p2.z) * (x - p2.x) + (p2.x - p1.x) * (z - p2.z)) / den;
            const l1 = ((p2.z - p0.z) * (x - p2.x) + (p0.x - p2.x) * (z - p2.z)) / den;
            const l2 = 1 - l0 - l1;
            if (l0 < -1e-4 || l1 < -1e-4 || l2 < -1e-4) return null;
            return l0 * p0.y + l1 * p1.y + l2 * p2.y;
          };
          return t(q.a, q.b, q.c) ?? t(q.c, q.b, q.d);
        };
        for (const q of city.groundQuads) {
          const y = hq(q);
          if (y !== null && y > ground - 1.5) layers0.push({ layer: 'cityQuad', kind: q.kind, y: +y.toFixed(3) });
        }
        for (const q of city.streetQuads) {
          const y = hq(q);
          if (y !== null && y > ground - 1.5) layers0.push({ layer: 'streetQuad', kind: q.kind, y: +y.toFixed(3) });
        }
        layers = { base: +city.baseGroundAt(x, z).toFixed(3), terrainMesh: +city.terrainMeshHeight(x, z).toFixed(3), top: layers0.sort((a, b) => b.y - a.y).slice(0, 6) };
      }
      report.push({
        kind: meta.kind,
        name,
        at: [+x.toFixed(1), +z.toFixed(1)],
        rowBottom: row ? +row.bottom.toFixed(3) : null,
        drawn: drawn === null ? null : +drawn.toFixed(3),
        ground: +ground.toFixed(3),
        rowGap: row ? +(row.bottom - ground).toFixed(3) : null,
        drawnGap: drawn === null ? null : +(drawn - ground).toFixed(3),
        layers,
      });
    }
    const streetRows = rows.filter((r) => String(r.name).startsWith('street:'));
    // what the measure costs now that the street kit is one of its layers: the player, every ped
    // and every car call this per frame, so the number that matters is the cost of one query
    const probe = (city.propAudit || []).find((a) => a.name === 'street:signal-intersection');
    let usPerQuery = null;
    if (probe) {
      const n = 20000;
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        const a = (i % 40) - 20;
        city.groundHeightAt(probe.x + a, probe.z + ((i * 7) % 40) - 20);
      }
      usPerQuery = +(((performance.now() - t0) * 1000) / n).toFixed(2);
    }
    return {
      report,
      usPerQuery,
      quads: (city.streetQuads || []).length,
      streetRows: streetRows.length,
      orphanRows: streetRows.filter((r) => !used.has(r)).length,
    };
  }, GAP_MAX);

  all.push(...out.report);
  quads = out.quads;
  orphanRows = Math.max(orphanRows, out.orphanRows);
  console.log(
    `load ${load + 1}: pieces=${out.report.length} streetRows=${out.streetRows} unownedRows=${out.orphanRows} registeredStreetQuads=${out.quads} groundQueryUs=${out.usPerQuery}`
  );
  if (process.env.KIT_VERBOSE) console.log(JSON.stringify(out.report, null, 1));
  await page.close();
}

await b.close();

const surface = (r) => ['run', 'signal-intersection', 't-intersection'].includes(r.kind);
const bad = all.filter(
  (r) =>
    r.rowGap === null ||
    Math.abs(r.rowGap) >= GAP_MAX ||
    (surface(r) && (r.drawnGap === null || Math.abs(r.drawnGap) >= GAP_MAX))
);
const worstRow = all.reduce((a, r) => (a === null || Math.abs(r.rowGap) > Math.abs(a.rowGap) ? r : a), null);
const worstDrawn = all.filter(surface).reduce((a, r) => (a === null || Math.abs(r.drawnGap) > Math.abs(a.drawnGap) ? r : a), null);
const byKind = all.reduce((m, r) => ((m[r.kind] = (m[r.kind] || 0) + 1), m), {});
console.log(
  JSON.stringify(
    {
      sampled: all.length,
      byKind,
      registeredStreetQuads: quads,
      unownedStreetRows: orphanRows,
      worstRow,
      worstDrawn,
    },
    null,
    1
  )
);
if (bad.length) console.log('OUT OF TOLERANCE ' + JSON.stringify(bad, null, 1));
console.log(
  `RESULT ${bad.length === 0 && orphanRows === 0 ? 'PASS' : 'FAIL'} instances=${all.length} maxAbsRowGap=${
    worstRow ? Math.abs(worstRow.rowGap).toFixed(3) : 'n/a'
  } maxAbsDrawnGap=${worstDrawn ? Math.abs(worstDrawn.drawnGap).toFixed(3) : 'n/a'} tolerance=${GAP_MAX}m`
);
if (errs.length) console.log('PAGE ERRORS ' + JSON.stringify(errs.slice(0, 5)));
process.exit(bad.length || orphanRows ? 2 : 0);
