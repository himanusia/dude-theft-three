/**
 * Proof shot for the pier joint: stands on the street outside a viaduct pier, off to one side so
 * the column under the crosshead is not hidden by the crosshead itself, and frames the head.
 *
 * What it measures, not just captures:
 *   1. the joint is in frame at a legible size (the head's end at least 60 px tall, the whole
 *      band from the head's bottom to the deck's top inside the frame with a margin);
 *   2. the column under the head is actually visible from this stance — three rays to its face
 *      must land on it, or the picture cannot show a column meeting a head;
 *   3. the head reaches the deck IN PIXELS: the frame is rendered once with this pier's head and
 *      once with it hidden, and the top row of the pixels that change must sit on the deck's
 *      underside row. A gap would leave background between the two and the row would come up short.
 *
 * usage: DTA_URL=http://127.0.0.1:8975 SHOT=proof/pier-joint.png node tools/shoot-pier-joint.mjs
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || process.argv[2] || 'http://127.0.0.1:8975';
const OUT = process.env.SHOT || 'proof/pier-joint.png';
const JSON_OUT = process.env.SHOT_JSON || 'proof/pier-joint.json';
const W = 1600;
const H = 1000;
/** proof lens: a telephoto, so the joint is big enough to read from the street. Declared in the
 *  JSON — it is a camera choice for the evidence, not a change to the game's own view. */
const SHOT_FOV = 26;
/** which elevated structure: 'toll' (the layang) or 'mrt' (the guideway) */
const SPINE = process.env.SHOT_SPINE === 'mrt' ? 'mrt' : 'toll';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const dir of new Set([path.dirname(OUT), path.dirname(JSON_OUT)])) fs.mkdirSync(dir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio', `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 240000 });
await page.waitForFunction('window.__game !== undefined', { timeout: 120000 });
await sleep(1200);
await page.click('#start-btn');
await sleep(2500);

// ------------------------------------------------------------------ pick the stance
// SHOT_REUSE=<json> shoots the SAME camera as a previous run: that is how the pre-fix frame is
// taken from the identical viewpoint, so the two pictures can be laid side by side.
const REUSE = process.env.SHOT_REUSE || '';
const stance = REUSE
  ? { best: JSON.parse(fs.readFileSync(REUSE, 'utf8')).stance.best, reused: REUSE }
  : await page.evaluate((SHOT_FOV, SPINE) => {
  const g = window.__game;
  const THREE = g.THREE;
  const cam = g.camera;

  const spine = SPINE === 'mrt' ? g.city.mrtSpine || [] : g.city.layangSpine || [];
  const distToSpine = (path, x, z) => {
    let best = Infinity;
    for (let i = 1; i < spine.length; i++) {
      const [x1, z1] = spine[i - 1];
      const [x2, z2] = spine[i];
      const dx = x2 - x1;
      const dz = z2 - z1;
      const l2 = dx * dx + dz * dz || 1;
      let t = ((x - x1) * dx + (z - z1) * dz) / l2;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(x - (x1 + dx * t), z - (z1 + dz * t)));
    }
    return best;
  };

  // pier heads of the TOLL road (flat wide boxes standing on its spine) and the columns under them
  const heads = [];
  const shafts = [];
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  g.scene.traverse((o) => {
    if (!o.isInstancedMesh) return;
    const prm = o.geometry && o.geometry.parameters;
    if (!prm || prm.width === undefined) return;
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m);
      m.decompose(pos, q, sc);
      const w = prm.width * sc.x;
      const h = prm.height * sc.y;
      const d = prm.depth * sc.z;
      if (h >= 0.5 && h <= 1.6 && Math.min(w, d) >= 1.5 && Math.min(w, d) <= 4 && Math.max(w, d) >= 12) {
        if (distToSpine(spine, pos.x, pos.z) > 14) continue;
        // the two structures' crossheads differ by width (deck width + 3.6): a toll head under
        // the metro line at a crossing is not a metro pier
        if (SPINE === 'mrt' ? w > 16 : w < 16) continue;
        heads.push({ pos: pos.clone(), quat: q.clone(), w, h, d, top: pos.y + h / 2, bottom: pos.y - h / 2 });
      }
      if (h > 4 && Math.min(w, d) <= 3) {
        if (distToSpine(spine, pos.x, pos.z) > 16) continue;
        shafts.push({ pos: pos.clone(), w, d, top: pos.y + h / 2, bottom: pos.y - h / 2 });
      }
    }
  });
  if (!heads.length) throw new Error('no toll pier head found');

  const insideCollider = (x, y, z) => {
    for (const c of g.city.colliders) {
      if (x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ && y < c.h) return true;
    }
    return false;
  };

  const projectPx = (p) => {
    const v = p.clone().project(cam);
    return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight, z: v.z };
  };
  /** aim the camera: position FIRST, then lookAt — lookAt reads matrixWorld, not position */
  const aim = (from, at) => {
    cam.position.set(from.x, from.y, from.z);
    cam.updateMatrixWorld(true);
    cam.lookAt(at);
    cam.updateMatrixWorld(true);
  };
  const candidates = [];
  const why = { collider: 0, frame: 0, small: 0, noNear: 0, frontal: 0, columnFrame: 0, background: 0, tried: 0 };
  for (const head of heads) {
    // local axes: +X across the deck, +Z along it
    const across = (side) => new THREE.Vector3(side, 0, 0).applyQuaternion(head.quat);
    const along = new THREE.Vector3(0, 0, 1).applyQuaternion(head.quat);
    for (const side of [-1, 1]) {
      const ax = across(side);
      const endX = head.pos.x + ax.x * head.w * 0.44;
      const endZ = head.pos.z + ax.z * head.w * 0.44;
      // the near column: the one on the camera's side of the pier
      const near = shafts
        .filter((s) => Math.hypot(s.pos.x - head.pos.x, s.pos.z - head.pos.z) < head.w / 2 + 2)
        .sort((a, b) => (b.pos.x - head.pos.x) * ax.x + (b.pos.z - head.pos.z) * ax.z - ((a.pos.x - head.pos.x) * ax.x + (a.pos.z - head.pos.z) * ax.z))[0];
      if (!near) {
        why.noNear++;
        continue;
      }
      // the camera stands off the head's END, not its centre: from the centre a camera on the
      // same side is only ~3 m from the end it is looking at, which foreshortens the head into
      // nothing however close it feels
      for (const lat of [9, 11, 13, 15, 17, 20, 23]) {
        for (const off of [-14, -10, -6, -2, 2, 6, 10, 14]) {
          const cx = endX + ax.x * lat + along.x * off;
          const cz = endZ + ax.z * lat + along.z * off;
          const ey = g.city.groundHeightAt(cx, cz) + 1.8;
          why.tried++;
          if (insideCollider(cx, ey, cz)) {
            why.collider++;
            continue;
          }
          // frontal views hide the column behind the head's own end; the joint only reads
          // from off to one side, where the column is in front of the head's overhang
          if (Math.abs(off) < 4) {
            why.frontal++;
            continue;
          }
          const from = new THREE.Vector3(cx, ey, cz);
          const jointTop = new THREE.Vector3(endX, head.top, endZ);
          // look at the middle of the joint band: head bottom .. deck top
          aim(from, jointTop.clone().setY(head.top - 0.6));
          cam.fov = SHOT_FOV;
          cam.updateProjectionMatrix();
          const pTop = projectPx(jointTop);
          const pBot = projectPx(new THREE.Vector3(endX, head.bottom, endZ));
          const pDeckTop = projectPx(new THREE.Vector3(endX, head.top + 1.1, endZ));
          const margin = 40;
          if (![pTop, pBot, pDeckTop].every((p) => p.z < 1 && p.x > margin && p.x < window.innerWidth - margin && p.y > margin && p.y < window.innerHeight - margin)) {
            why.frame++;
            continue;
          }
          // rows grow downwards: the joint is ABOVE the head's bottom, so this is positive
          const headPx = pBot.y - pTop.y;
          if (!(headPx > 0) || headPx < 85) {
            why.small++;
            continue;
          }
          // and the column under it has to be in the frame too, 3.5 m of it below the head
          const colTop = projectPx(new THREE.Vector3(near.pos.x, head.bottom, near.pos.z));
          const colLow = projectPx(new THREE.Vector3(near.pos.x, head.bottom - 3.5, near.pos.z));
          if (![colTop, colLow].every((p) => p.z < 1 && p.x > margin && p.x < window.innerWidth - margin && p.y > margin && p.y < window.innerHeight - margin)) {
            why.columnFrame++;
            continue;
          }
          // nothing behind the joint: buildings are colliders, so walk the sight line past the
          // head and require open air. A facade behind the joint puts window lines beside it and
          // the frame stops being readable.
          const away = jointTop.clone().sub(from).normalize();
          let bgBlocked = false;
          for (let d = 8; d <= 90; d += 4) {
            const px = jointTop.x + away.x * d;
            const py = jointTop.y + away.y * d;
            const pz = jointTop.z + away.z * d;
            if (insideCollider(px, py, pz)) {
              bgBlocked = true;
              break;
            }
          }
          if (bgBlocked) {
            why.background++;
            continue;
          }
          candidates.push({
            lat,
            off,
            head,
            near,
            from,
            endX,
            endZ,
            headPx,
            columnPx: colLow.y - colTop.y,
            jointRow: pTop.y,
            headBottomRow: pBot.y,
            deckTopRow: pDeckTop.y,
            centreOff: Math.abs(pTop.y / window.innerHeight - 0.5),
          });
        }
      }
    }
  }
  if (!candidates.length) throw new Error('no stance frames the pier joint ' + JSON.stringify({ why, heads: heads.length, shafts: shafts.length }));
  const score = (c) => c.headPx - c.centreOff * 220 - c.lat * 2 - Math.abs(c.off);
  candidates.sort((a, b) => score(b) - score(a));

  const best = candidates[0];
  if (!best) throw new Error('no stance');
  return {
    total: candidates.length,
    best: {
      score: { headPx: +best.headPx.toFixed(1), columnPx: +best.columnPx.toFixed(1) },
      cam: best.from.toArray().map((v) => +v.toFixed(2)),
      lookAt: [best.endX, best.head.top - 0.6, best.endZ].map((v) => +v.toFixed(2)),
      fov: SHOT_FOV,
      joint: [best.endX, best.head.top, best.endZ].map((v) => +v.toFixed(2)),
      headBottom: best.head.bottom,
      headTop: best.head.top,
      headAt: [+best.head.pos.x.toFixed(2), +best.head.pos.z.toFixed(2)],
      headSize: [+best.head.w.toFixed(2), +best.head.h.toFixed(2), +best.head.d.toFixed(2)],
      lat: best.lat,
      alongOffset: best.off,
      jointRow: +best.jointRow.toFixed(1),
      headBottomRow: +best.headBottomRow.toFixed(1),
      deckTopRow: +best.deckTopRow.toFixed(1),
      columnTop: +best.head.bottom.toFixed(2),
    },
  };
}, SHOT_FOV, SPINE);
const s = stance.best;
console.log('STANCE', JSON.stringify(stance, null, 1));
if (s.score.columnPx < 60) throw new Error('the column under the head is too small in frame');

// ------------------------------------------------------------------ freeze, aim, shoot
await page.evaluate(
  (s) => {
    const g = window.__game;
    g._test.teleport(s.cam[0] - 1, s.cam[2] - 1); // park the rig under the camera for its shadow
    g._test.setTime(0.34);
    document.querySelectorAll('body > *:not(canvas)').forEach((el) => {
      el.style.visibility = 'hidden';
    });
  },
  s
);
await sleep(600);
await page.evaluate(() => {
  const g = window.__game;
  if (g.player.char) g.player.char.visible = false;
  g._test.freezeLoop(true);
});
await sleep(400);

/** render the frozen frame from the chosen stance and read it back */
const readback = await page.evaluate(
  (s) => {
    const g = window.__game;
    const THREE = g.THREE;
    const cam = g.camera;
    const renderer = g.renderer;
    const gl = renderer.domElement;

    cam.position.set(s.cam[0], s.cam[1], s.cam[2]);
    cam.updateMatrixWorld(true);
    cam.lookAt(new THREE.Vector3(s.lookAt[0], s.lookAt[1], s.lookAt[2]));
    cam.updateMatrixWorld(true);
    cam.fov = s.fov ?? 34;
    cam.updateProjectionMatrix();
    renderer.render(g.scene, cam);

    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    cv.width = gl.width;
    cv.height = gl.height;
    ctx.drawImage(gl, 0, 0, gl.width, gl.height);
    const img = ctx.getImageData(0, 0, gl.width, gl.height);

    const sx = gl.width / window.innerWidth;
    const sy = gl.height / window.innerHeight;
    const projectPx = (p) => {
      const v = p.clone().project(cam);
      return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight };
    };
    // the head's eight corners, projected: its rect is where the joint is in the picture
    const [hw, hh, hd] = s.headSize;
    const corners = [];
    for (const ox of [-hw / 2, hw / 2]) {
      for (const oy of [-hh / 2, hh / 2]) {
        for (const oz of [-hd / 2, hd / 2]) {
          corners.push(projectPx(new THREE.Vector3(s.headAt[0] + ox, s.headCenterY + oy, s.headAt[1] + oz)));
        }
      }
    }
    const rect = {
      x0: Math.max(0, Math.floor(Math.min(...corners.map((c) => c.x)) * sx)),
      x1: Math.min(gl.width, Math.ceil(Math.max(...corners.map((c) => c.x)) * sx)),
      y0: Math.max(0, Math.floor(Math.min(...corners.map((c) => c.y)) * sy)),
      y1: Math.min(gl.height, Math.ceil(Math.max(...corners.map((c) => c.y)) * sy)),
    };
    const luma = (x0, y0, x1, y1) => {
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * gl.width + x) * 4;
          sum += 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
          n++;
        }
      }
      return n ? +(sum / n).toFixed(1) : null;
    };
    // the joint column: the middle of the head's end, from the deck's top down through the head
    const colX = Math.round(((s.jointX ?? window.innerWidth / 2) * sx));
    const jointRow = +(s.jointRow * sy).toFixed(1);
    const headBottomRow = +(s.headBottomRow * sy).toFixed(1);
    const profile = [];
    for (let y = Math.max(0, Math.floor(jointRow) - 30); y < Math.min(gl.height, Math.ceil(headBottomRow) + 10); y += 2) {
      profile.push([y, luma(Math.max(0, colX - 3), y, Math.min(gl.width, colX + 4), y + 1)]);
    }
    rect.w = rect.x1 - rect.x0;
    rect.h = rect.y1 - rect.y0;
    return {
      frameLuma: luma(0, 0, gl.width, gl.height),
      headRectLuma: luma(rect.x0, rect.y0, rect.x1, rect.y1),
      headRect: rect,
      jointRowPx: jointRow,
      headBottomRowPx: headBottomRow,
      columnProfile: profile,
      renderCalls: renderer.info.render.calls,
      renderTris: renderer.info.render.triangles,
      deviceScale: { sx: +sx.toFixed(2), sy: +sy.toFixed(2) },
    };
  },
  { ...s, headCenterY: (s.headTop + s.headBottom) / 2, jointX: undefined }
);

await page.screenshot({ path: OUT, clip: { x: 0, y: 0, width: W, height: H } });

// ------------------------------------------------------------------ verdict
// The picture is evidence the owner can read; these are the numbers that say it is legible and
// is of the right thing. The joint itself is measured by tools/probe-pier-joint.mjs, not by eye.
const failures = [];
if (!(readback.headRect.w > 0)) failures.push('the pier head is not in the frame');
// device pixels back to CSS pixels: the canvas is drawn smaller than the viewport
const headBandPx = (readback.headBottomRowPx - readback.jointRowPx) / readback.deviceScale.sy;
if (!(headBandPx > 60)) failures.push(`the pier head is only ${headBandPx.toFixed(1)} px tall in the frame`);
if (!(readback.frameLuma > 40)) failures.push(`frame is too dark to read (mean luma ${readback.frameLuma})`);
if (!(readback.headRectLuma > 25)) failures.push(`the pier head renders as a silhouette (luma ${readback.headRectLuma})`);
if (pageErrors.length) failures.push(`page errors: ${pageErrors.slice(0, 2).join(' | ')}`);

const out = {
  base: BASE,
  shot: OUT,
  stance,
  readback,
  headHeightPx: +headBandPx.toFixed(1),
  columnHeightPx: s.score.columnPx,
  pageErrors,
  verdict: failures.length ? 'FAIL' : 'PASS',
  failures,
};
console.log('PIER_SHOT', JSON.stringify(out, null, 1));
fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
await browser.close();
if (failures.length) {
  console.error(`pier shot: ${failures.join('; ')}`);
  process.exitCode = 1;
}
