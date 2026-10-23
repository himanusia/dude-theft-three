// Proves the carriageway and the trotoar read as two different places.
//
// usage: node tools/shoot-road-edge.mjs [baseUrl]
//
// The camera is put at a real pedestrian's eye (1.7 m above whatever surface it stands on) on
// the pavement of the widest arterial, looking along the street with a few degrees of yaw
// toward the road, so the kerb line runs out of the bottom of the frame instead of sitting
// parallel to the horizon where a raised edge reads as a painted stripe.
//
// The measurement is taken from the SAVED PNG, not from the live canvas: a headless capture can
// commit an empty WebGL buffer and an in-page readback would happily report on the frame that
// never reached the file. Every patch is a 20x20 px box around a known world point projected
// through the same camera, and the samples are printed so a human can re-check the numbers.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import zlib from 'node:zlib';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || process.argv[2] || 'http://127.0.0.1:8765';
const OUT = process.env.ROAD_SHOT || 'screenshots/proof/road-vs-walk.png';
/** the card's acceptance floor: walk patch must be at least this much brighter than the road */
const MIN_RATIO = 1.6;
const PATCH = 20; // px box side sampled around each projected world point
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- PNG -> pixels
/** Minimal 8-bit PNG reader: truecolour (2) and truecolour+alpha (6), filters 0-4. */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error(`bit depth ${data[8]} not supported`);
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (colorType !== 2 && colorType !== 6) throw new Error(`colour type ${colorType} not supported`);
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 3);
  const prev = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    raw.copy(line, 0, p, p + stride);
    p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`filter ${filter} unknown`);
      line[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      out[(y * width + x) * 3] = line[x * bpp];
      out[(y * width + x) * 3 + 1] = line[x * bpp + 1];
      out[(y * width + x) * 3 + 2] = line[x * bpp + 2];
    }
    line.copy(prev);
  }
  return { width, height, data: out };
}

/** Rec.709 luma of a 20x20 box, clamped to the frame. */
function patchLuma(img, cx, cy) {
  const half = PATCH / 2;
  const x0 = Math.max(0, Math.round(cx - half));
  const y0 = Math.max(0, Math.round(cy - half));
  const x1 = Math.min(img.width, Math.round(cx + half));
  const y1 = Math.min(img.height, Math.round(cy + half));
  let sum = 0;
  let n = 0;
  const rgb = [0, 0, 0];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 3;
      const lum = 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
      sum += lum;
      n++;
      for (let k = 0; k < 3; k++) rgb[k] += img.data[i + k];
    }
  }
  return {
    luma: +(sum / n).toFixed(1),
    rgb: rgb.map((v) => Math.round(v / n)),
    box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    px: n,
  };
}

// ---------------------------------------------------------------- shot
fs.mkdirSync('screenshots/proof', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  defaultViewport: { width: 1600, height: 1000 },
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
  });
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__game !== undefined', { timeout: 60000 });
  await sleep(1200);
  await page.click('#start-btn');
  await page.waitForFunction(() => window.__game.state.started === true, { timeout: 30000 }).catch(() => {});
  await sleep(1200);

  const place = await page.evaluate(() => {
    const g = window.__game;
    const city = g.city;
    const cam = g.camera;
    const hud = document.getElementById('hud');
    if (hud) hud.style.display = 'none';
    g._test.cinematic(true);
    const V3 = g.player.pos.constructor;
    const W = window.innerWidth;
    const H = window.innerHeight;

    // widest arterial: the carriageway the owner is talking about
    const road = [...city.roads].sort((a, b) => b.width - a.width)[0];
    const path = road.path;
    const half = road.width / 2;

    /** arc-length resample of the centreline */
    const segs = [];
    let total = 0;
    for (let i = 1; i < path.length; i++) {
      const [x1, z1] = path[i - 1];
      const [x2, z2] = path[i];
      const len = Math.hypot(x2 - x1, z2 - z1);
      segs.push({ x1, z1, x2, z2, len, at: total });
      total += len;
    }
    const sample = (d) => {
      const s = segs.find((q) => d >= q.at && d <= q.at + q.len) || segs[segs.length - 1];
      const t = Math.min(1, (d - s.at) / (s.len || 1));
      return {
        x: s.x1 + (s.x2 - s.x1) * t,
        z: s.z1 + (s.z2 - s.z1) * t,
        dx: (s.x2 - s.x1) / (s.len || 1),
        dz: (s.z2 - s.z1) / (s.len || 1),
      };
    };

    const blocked = (x, y, z) =>
      city.colliders.some((c) => x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ && y < c.h);
    /** nothing solid between the lens and a point: a stall counter across the kerb would be
     *  sampled as if it were pavement */
    const clear = (from, to) => {
      const steps = 40;
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const x = from.x + (to.x - from.x) * t;
        const y = from.y + (to.y - from.y) * t;
        const z = from.z + (to.z - from.z) * t;
        if (blocked(x, y, z)) return false;
      }
      return true;
    };

    const terrain = (x, z) => g.terrainHeight(x, z);
    const rows = [];
    // sample stations along the street; the yaw toward the road is what puts the kerb across
    // the frame instead of parallel to it
    for (const frac of [0.24, 0.32, 0.4, 0.48, 0.56, 0.64]) {
      for (const side of [-1, 1]) {
        for (const yaw of [10, 14, 18]) {
          const d = total * frac;
          const s = sample(d);
          // left normal of the tangent
          const nx = -s.dz;
          const nz = s.dx;
          const lat = side * (half + 1.15); // standing on the pavement, 1.05 m behind the kerb
          const cx = s.x + nx * lat;
          const cz = s.z + nz * lat;
          const groundWalk = terrain(cx, cz) + 0.26;
          const cy = groundWalk + 1.7; // a person's eye
          if (blocked(cx, cy - 0.6, cz)) {
            rows.push({ frac, side, yaw, skipped: 'camera inside a collider' });
            continue;
          }
          // look down the street, swung `yaw` degrees toward the carriageway
          const ahead = 20;
          const towardRoad = lat - side * (2.6 + yaw * 0.12);
          const tx = s.x + s.dx * ahead + nx * towardRoad;
          const tz = s.z + s.dz * ahead + nz * towardRoad;
          const ty = terrain(tx, tz) + 1.1;
          cam.fov = 55;
          cam.updateProjectionMatrix();
          cam.position.set(cx, cy, cz);
          cam.lookAt(tx, ty, tz);
          cam.updateMatrixWorld();
          cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
          cam.updateProjectionMatrix();

          // the three patches, all at the same station 7 m ahead of the lens
          const station = (dist) => {
            const q = { x: s.x + s.dx * dist, z: s.z + s.dz * dist };
            return q;
          };
          const q = station(7.0);
          const roadPt = new V3(q.x + nx * side * (half - 3.2), terrain(q.x + nx * side * (half - 3.2), q.z + nz * side * (half - 3.2)) + 0.05, q.z + nz * side * (half - 3.2));
          const walkPt = new V3(q.x + nx * side * (half + 1.9), terrain(q.x + nx * side * (half + 1.9), q.z + nz * side * (half + 1.9)) + 0.26, q.z + nz * side * (half + 1.9));
          const kerbPt = new V3(q.x + nx * side * (half + 0.06), terrain(q.x, q.z) + 0.16, q.z + nz * side * (half + 0.06));

          const from = { x: cx, y: cy, z: cz };
          const reasons = [];
          if (!clear(from, roadPt)) reasons.push('something blocks the road patch');
          if (!clear(from, walkPt)) reasons.push('something blocks the walk patch');
          const project = (v) => {
            const p = v.clone().project(cam);
            return { x: (p.x * 0.5 + 0.5) * W, y: (-p.y * 0.5 + 0.5) * H, behind: p.z > 1 };
          };
          const pr = project(roadPt);
          const pw = project(walkPt);
          const pk = project(kerbPt);
          for (const [name, p] of [['road', pr], ['walk', pw], ['kerb', pk]]) {
            if (p.behind) reasons.push(`${name} patch is behind the lens`);
            else if (p.x < 40 || p.x > W - 40 || p.y < 40 || p.y > H - 40) reasons.push(`${name} patch leaves the frame`);
          }
          if (reasons.length) {
            rows.push({ frac, side, yaw, skipped: reasons.join('; ') });
            continue;
          }
          rows.push({
            frac, side, yaw,
            cam: [+cx.toFixed(2), +cy.toFixed(2), +cz.toFixed(2)],
            road: pr, walk: pw, kerb: pk,
            clear: true,
          });
        }
      }
    }
    // deterministic pick: the first candidate in scan order, so two runs photograph the same
    // metre of street even though the city is randomised per load
    const chosen = rows.find((r) => r.clear);
    if (!chosen) return { road: road.name, width: road.width, rows, chosen: null };
    const d = total * chosen.frac;
    const s = sample(d);
    const nx = -s.dz;
    const nz = s.dx;
    const lat = chosen.side * (half + 1.15);
    const cx = s.x + nx * lat;
    const cz = s.z + nz * lat;
    const cy = terrain(cx, cz) + 0.26 + 1.7;
    const ahead = 20;
    const towardRoad = lat - chosen.side * (2.6 + chosen.yaw * 0.12);
    const tx = s.x + s.dx * ahead + nx * towardRoad;
    const tz = s.z + s.dz * ahead + nz * towardRoad;
    cam.position.set(cx, cy, cz);
    cam.lookAt(tx, terrain(tx, tz) + 1.1, tz);
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    return {
      road: road.name,
      width: road.width,
      frac: chosen.frac,
      side: chosen.side,
      eye: [+cx.toFixed(2), +cy.toFixed(2), +cz.toFixed(2)],
      groundUnderEye: +(terrain(cx, cz) + 0.26).toFixed(3),
      roadPatch: chosen.road,
      walkPatch: chosen.walk,
      kerbPatch: chosen.kerb,
      candidates: rows.length,
      skipped: rows.filter((r) => r.skipped).length,
    };
  });
  console.log('PLACE', JSON.stringify(place, null, 1));
  if (!place.eye) throw new Error('no clear vantage found along the arterial');

  await sleep(600); // let the render loop commit the new camera
  // A throttled headless tab can commit one empty WebGL frame, and that single frame would be
  // measured as if the street were black. Retake before believing it.
  let img = null;
  let road, walk, kerb;
  for (let attempt = 1; attempt <= 4; attempt++) {
    await page.screenshot({ path: OUT });
    img = decodePng(fs.readFileSync(OUT));
    road = patchLuma(img, place.roadPatch.x, place.roadPatch.y);
    walk = patchLuma(img, place.walkPatch.x, place.walkPatch.y);
    kerb = patchLuma(img, place.kerbPatch.x, place.kerbPatch.y);
    if (Math.max(road.luma, walk.luma) >= 20) break;
    console.log(`RETRY ${attempt}: frame came back black (max patch luma ${Math.max(road.luma, walk.luma)})`);
    await page.evaluate(() => window.__game.renderer.render(window.__game.scene, window.__game.camera));
    await sleep(500);
  }
  const ratio = +(walk.luma / road.luma).toFixed(2);
  const kerbOverRoad = +(kerb.luma / road.luma).toFixed(2);
  console.log('IMAGE', JSON.stringify({ file: OUT, w: img.width, h: img.height }));
  console.log('PATCHES', JSON.stringify({ road, walk, kerb }, null, 1));
  console.log('RATIO', JSON.stringify({ walkOverRoad: ratio, kerbFaceOverRoad: kerbOverRoad, floor: MIN_RATIO }));
  if (errors.length) console.log('PAGE_ERRORS', JSON.stringify(errors.slice(0, 5)));
  const bright = Math.max(road.luma, walk.luma);
  if (bright < 20) throw new Error(`capture is black after 4 attempts (brightest patch luma ${bright})`);
  if (ratio < MIN_RATIO) {
    console.error(`road-vs-walk: ${ratio}x is under the ${MIN_RATIO}x floor`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
