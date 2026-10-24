/**
 * Terminal + pos ronda placement law (card t_accfc928).
 *
 * Two owner reports, both measured here against the live scene rather than argued:
 *
 *   "terminal blok m dan pos ronda miring" -- both stood tilted. The group rotation is the claim a
 *   reader can check in one line, so it is asserted exactly (X and Z must be 0; yaw is fine). But a
 *   level group on ground that falls half a metre across the apron also reads as leaning, because
 *   the ground line then cuts across a level slab diagonally: that is why the ground fit is
 *   measured too, and why the apron skirt exists.
 *
 *   "terminal blok m masih di tengah jalan" -- the *centre* of the 48 x 32 m apron was clear of the
 *   kerb while the slab itself stood in a lane. `placement.mjs` samples the audit point, so it
 *   could not see that. This samples the footprint outline against every road the map carries, and
 *   requires the whole apron to miss every carriageway.
 *
 * ... and the apron now clears every carriageway, which would leave it an island, so the access run
 * is required to reach both the kerb and the apron edge.
 *
 * usage: node tests/world/terminal-level.mjs      (DTA_URL honoured, default :8765)
 */
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || 'http://127.0.0.1:8765';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1000, height: 640 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction('window.__game !== undefined', { timeout: 120000 });
await page.click('#start-btn');
await new Promise((r) => setTimeout(r, 4000));

const report = await page.evaluate(() => {
  const city = window.__game.city;
  const roads = city.roads || [];
  const distToPath = (x, z, path) => {
    let best = Infinity;
    for (let i = 1; i < path.length; i++) {
      const [x1, z1] = path[i - 1];
      const [x2, z2] = path[i];
      const dx = x2 - x1, dz = z2 - z1;
      const len2 = dx * dx + dz * dz || 1;
      let t = ((x - x1) * dx + (z - z1) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(x - (x1 + dx * t), z - (z1 + dz * t)));
    }
    return best;
  };
  const worldTilt = (o) => {
    o.updateWorldMatrix(true, false);
    const m = o.matrixWorld.elements;
    const l = Math.hypot(m[4], m[5], m[6]) || 1;
    return (Math.acos(Math.min(1, Math.max(-1, m[5] / l))) * 180) / Math.PI;
  };

  const W = 48, D = 32;
  const audit = city.propAudit || [];
  const term = audit.find((a) => a.name === 'terminal');
  const termGroup = city.group.children.find((o) => o.name === 'terminal') || null;
  let terminal = null;
  if (term && termGroup) {
    const yaw = termGroup.rotation.y;
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const world = (lx, lz) => ({ x: term.x + lx * cs + lz * sn, z: term.z - lx * sn + lz * cs });
    // clearance of the whole footprint from every carriageway edge
    let clear = Infinity, clearRoad = null;
    for (let i = 0; i <= 24; i++) {
      for (let k = 0; k <= 24; k++) {
        const lx = -W / 2 + (W * i) / 24, lz = -D / 2 + (D * k) / 24;
        const p = world(lx, lz);
        for (const r of roads) {
          const c = distToPath(p.x, p.z, r.path) - r.width / 2;
          if (c < clear) { clear = c; clearRoad = r.name; }
        }
      }
    }
    // level seating: the apron top against the ground under the whole slab. `term.top` is the
    // apron's own thickness, published by the builder so this test cannot drift from the slab.
    const apronTop = termGroup.position.y + (term.top ?? 0.22);
    let poke = -Infinity, hang = -Infinity;
    for (let i = 0; i <= 12; i++) {
      for (let k = 0; k <= 12; k++) {
        const lx = -W / 2 + (W * i) / 12, lz = -D / 2 + (D * k) / 12;
        const p = world(lx, lz);
        const g = city.groundHeightAt(p.x, p.z);
        poke = Math.max(poke, g - apronTop);
        hang = Math.max(hang, apronTop - g);
      }
    }
    const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => {
      const p = world((sx * W) / 2, (sz * D) / 2);
      return +(termGroup.position.y + (term.top ?? 0.22)).toFixed(6);
    });
    // the acceptance quotes the audit point: distance to the nearest centreline minus that
    // road's half width. Reported beside the footprint number, because the point was always
    // clear and the slab was not.
    let centreClear = Infinity, centreRoad = null;
    for (const r of roads) {
      const c = distToPath(term.x, term.z, r.path) - r.width / 2;
      if (c < centreClear) { centreClear = c; centreRoad = r.name; }
    }
    terminal = {
      at: [+term.x.toFixed(2), +term.z.toFixed(2)],
      centreClearance: +centreClear.toFixed(2),
      centreClearanceRoad: centreRoad,
      y: +termGroup.position.y.toFixed(3),
      rot: { x: termGroup.rotation.x, y: termGroup.rotation.y, z: termGroup.rotation.z },
      worldTiltDeg: +worldTilt(termGroup).toFixed(4),
      apronTopPlaneSpread: Math.max(...corners) - Math.min(...corners),
      clearance: +clear.toFixed(2),
      clearanceRoad: clearRoad,
      groundPoke: +poke.toFixed(3),
      apronHang: +hang.toFixed(3),
      auditGap: +(term.bottom - city.groundHeightAt(term.x, term.z)).toFixed(3),
    };
  }

  const rondas = audit.filter((a) => a.name === 'pos-ronda').map((a) => {
    const g = city.group.children.find((o) => Math.abs(o.position.x - a.x) < 0.01 && Math.abs(o.position.z - a.z) < 0.01);
    if (!g) return { at: [+a.x.toFixed(1), +a.z.toFixed(1)], missing: true };
    const yaw = g.rotation.y, cs = Math.cos(yaw), sn = Math.sin(yaw);
    // the 2.4 m platform core both hut types share, and how far the lowest ground under it sits
    // below the base: the plinth under the deck is what has to reach that ground
    const gs = [[-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]]
      .map(([lx, lz]) => city.groundHeightAt(a.x + lx * cs + lz * sn, a.z - lx * sn + lz * cs));
    return {
      at: [+a.x.toFixed(1), +a.z.toFixed(1)],
      rot: { x: g.rotation.x, z: g.rotation.z },
      worldTiltDeg: +worldTilt(g).toFixed(4),
      seatGap: +(a.bottom - city.groundHeightAt(a.x, a.z)).toFixed(3),
      coreSpread: +(Math.max(...gs) - Math.min(...gs)).toFixed(3),
      hang: +(a.bottom - Math.min(...gs)).toFixed(3),
    };
  });

  // the access run: from a kerb to the apron edge
  const access = city.terminalAccess || null;
  let accessInfo = null;
  if (access && access.path && access.path.length >= 2) {
    const [start, end] = [access.path[0], access.path[access.path.length - 1]];
    let kerbGap = Infinity;
    for (const r of roads) kerbGap = Math.min(kerbGap, distToPath(start[0], start[1], r.path) - r.width / 2);
    const mesh = city.group.getObjectByName('road-access');
    let apronGap = Infinity;
    if (terminal) {
      const yaw = termGroup.rotation.y, cs = Math.cos(yaw), sn = Math.sin(yaw);
      const dx = end[0] - terminal.at[0], dz = end[1] - terminal.at[1];
      const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
      const outX = Math.max(0, Math.abs(lx) - W / 2), outZ = Math.max(0, Math.abs(lz) - D / 2);
      apronGap = Math.hypot(outX, outZ);
    }
    accessInfo = {
      length: +Math.hypot(end[0] - start[0], end[1] - start[1]).toFixed(1),
      kerbGap: +kerbGap.toFixed(2),
      apronGap: +apronGap.toFixed(2),
      mesh: !!mesh,
    };
  }

  return { terminal, rondas, access: accessInfo, roads: roads.length, errors: [] };
});

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${JSON.stringify(detail)}`);
};

const t = report.terminal;
check('the terminal is placed', !!t, t && t.at);
check('the terminal group has zero X and Z rotation', t && t.rot.x === 0 && t.rot.z === 0, t && t.rot);
check('the terminal stands level in world space', t && t.worldTiltDeg < 0.01, t && `${t.worldTiltDeg} deg`);
check('the apron top is one level plane', t && t.apronTopPlaneSpread < 1e-6, t && t.apronTopPlaneSpread);
check('the apron clears every carriageway', t && t.clearance > 0, t && `${t.clearance} m to ${t.clearanceRoad}`);
check('no ground rises through the apron', t && t.groundPoke <= 0, t && `${t.groundPoke} m`);
check('the apron skirt meets the ground on every side', t && t.apronHang <= 0.75, t && `${t.apronHang} m`);
check('the terminal audit seat matches the ground under it', t && Math.abs(t.auditGap) <= 0.06, t && t.auditGap);

// Every hut, including the street-dressing one, must be level; seating is measured on the 2.4 m
// platform core both hut types share (the dressing hut is a 2.4 m box, the placed one 4.6 x 3.2).
const rondaTilted = report.rondas.filter((r) => r.missing || r.rot.x !== 0 || r.rot.z !== 0 || r.worldTiltDeg >= 0.01);
check('every pos ronda stands level', report.rondas.length > 0 && rondaTilted.length === 0, { count: report.rondas.length, bad: rondaTilted });
const rondaUnseated = report.rondas.filter((r) => r.missing || Math.abs(r.seatGap) > 0.06 || r.hang > 0.55);
check('every pos ronda is seated on its plinth', report.rondas.length > 0 && rondaUnseated.length === 0, { count: report.rondas.length, bad: rondaUnseated });

const a = report.access;
check('the terminal has an access run to the kerb', !!a, a);
check('the access run starts at a carriageway edge', a && Math.abs(a.kerbGap) <= 1.5, a && a.kerbGap);
check('the access run reaches the apron', a && a.apronGap <= 1.5, a && a.apronGap);
check('the access run is drawn', a && a.mesh, a && a.mesh);

console.log('DETAIL', JSON.stringify({ terminal: t, rondas: report.rondas, access: a }));
const failed = checks.filter((c) => !c.ok);
console.log('SUMMARY', JSON.stringify({ pass: checks.length - failed.length, total: checks.length }));
await browser.close();
if (failed.length) {
  console.error(`terminal-level: ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
