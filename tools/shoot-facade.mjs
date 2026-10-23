// Proof shot for the facade card: a block building's street face, from the pavement, captured
// headless. Saves screenshots/proof/facade-fix.png and measures the saved pixels, because the
// claim being proved is visual: the ground floor has shopfront detail, the upper storeys are not
// one flat colour, and the windows are windows rather than one stretched slot.
//
// usage: node tools/shoot-facade.mjs [baseUrl]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || process.argv[2] || 'http://127.0.0.1:8765';
const OUT = process.env.FACADE_SHOT || 'screenshots/proof/facade-fix.png';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(path.dirname(OUT), { recursive: true });

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
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__game !== undefined', { timeout: 60000 });
  await sleep(1200);
  await page.click('#start-btn');
  await page.waitForFunction(() => window.__game.state.started === true, { timeout: 30000 }).catch(() => {});
  await sleep(1500);

  const stage = await page.evaluate(() => {
    const g = window.__game;
    const hud = document.getElementById('hud');
    if (hud) hud.style.display = 'none';
    g._test.cinematic(true);
    const cam = g.camera;
    cam.fov = 56;
    cam.updateProjectionMatrix();
    const V3 = g.player.pos.constructor;
    const T = g.THREE || window.THREE;
    const W = window.innerWidth;
    const H = window.innerHeight;

    // Building colliders are the exact per-building footprint and height: each is pushed by
    // makeBuilding with minX/maxX/minZ/maxZ/h. city.facades was tempting but a frontage row is
    // one 80 m deep record, and the scene meshes are merged per material per block, so neither
    // gives a single building to look at.
    const cands = g.city.colliders
      .filter((c) => c.h >= 10 && c.h <= 22)
      .map((c) => ({
        x: (c.minX + c.maxX) / 2,
        z: (c.minZ + c.maxZ) / 2,
        w: c.maxX - c.minX,
        d: c.maxZ - c.minZ,
        h: c.h - 0.2,
        ground: g.city.groundHeightAt((c.minX + c.maxX) / 2, (c.minZ + c.maxZ) / 2),
      }))
      .filter((b) => b.w >= 8 && b.w <= 26 && b.d >= 8 && b.d <= 26)
      .map((b) => ({ ...b, dist: Math.hypot(b.x - g.player.pos.x, b.z - g.player.pos.z) }))
      .filter((b) => b.dist < 350)
      .sort((a, b) => a.dist - b.dist);
    if (!cands.length) return { ok: false, why: 'no 10-22 m building with an 8-26 m footprint' };

    const inCollider = (x, z) =>
      g.city.colliders.some((c) => (c.h ?? 30) > 0.8 && x > c.minX - 0.6 && x < c.maxX + 0.6 && z > c.minZ - 0.6 && z < c.maxZ + 0.6);
    /** something tall between the camera and the wall means the shot is of that thing instead */
    const blocked = (ax, ay, az, bx, by, bz) => {
      for (let i = 1; i <= 24; i++) {
        const t = i / 25;
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        const z = az + (bz - az) * t;
        if (g.city.colliders.some((c) => x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ && y < (c.h ?? 30))) return true;
      }
      return false;
    };

    const rows = [];
    const fun = { shortFace: 0, facingWall: 0, camInWall: 0, blocked: 0, noWall: 0, raysOk: 0, framed: 0, dbg: [] };
    // A candidate only counts if the camera really sees that wall: raycast at three heights
    // against the live scene and require the first hit to land on the facing plane. A merged body
    // mesh spans a block, so geometry alone cannot tell us which building the lens is pointed at.
    const ray = new T.Raycaster();
    /** what the lens actually hits: distance, and the canvas size of the texture on it */
    const hitInfo = (cx, cy, cz, tx, ty, tz) => {
      const dir = new V3(tx - cx, ty - cy, tz - cz);
      const expect = dir.length();
      ray.set(new V3(cx, cy, cz), dir.normalize());
      const hit = ray.intersectObjects(g.scene.children, true).find((h) => h.object.isMesh && !h.object.isInstancedMesh && h.object.visible);
      if (!hit) return null;
      const mat = hit.object.material;
      const img = mat && !Array.isArray(mat) && mat.map && mat.map.image ? [mat.map.image.width, mat.map.image.height] : null;
      return { dist: +hit.distance.toFixed(2), expect: +expect.toFixed(2), img };
    };
    /** shopfrontMat() paints the ground floor on a 512x128 canvas; the window tile is 128x128. */
    const seesShopfront = (cx, cy, cz, tx, ty, tz) => {
      const h = hitInfo(cx, cy, cz, tx, ty, tz);
      return !!h && Math.abs(h.dist - h.expect) < 2.2 && !!h.img && h.img[0] === 512 && h.img[1] === 128;
    };
    const seesUpperWall = (cx, cy, cz, tx, ty, tz) => {
      const h = hitInfo(cx, cy, cz, tx, ty, tz);
      return !!h && Math.abs(h.dist - h.expect) < 2.2 && !!h.img && h.img[0] === 128;
    };
    for (let i = 0; i < Math.min(cands.length, 40); i++) {
      const f = cands[i];
      for (const [nx, nz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const faceW = nx === 0 ? f.w : f.d;
      const faceXpos = f.x + nx * (f.w / 2);
      const faceZpos = f.z + nz * (f.d / 2);
      if (inCollider(faceXpos + nx * 2.2, faceZpos + nz * 2.2)) { fun.facingWall++; continue; }   // facing a wall
      for (const dist of [11, 14, 18, 23, 28]) {
        const cx = faceXpos + nx * dist;
        const cz = faceZpos + nz * dist;
        if (inCollider(cx, cz)) { fun.camInWall++; continue; }
        const ground = g.city.groundHeightAt(cx, cz);
        for (const eye of [2.0, 3.0, 4.2]) {
          const cy = ground + eye;
          cam.position.set(cx, cy, cz);
          const at = new V3(f.x, f.ground + f.h * 0.45, f.z);
          cam.lookAt(at);
          cam.updateMatrixWorld();
          cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
          if (blocked(cx, cy, cz, faceXpos, f.ground + 1.8, faceZpos)) { fun.blocked++; continue; }
          // the shopfront at 1.6 m, the first floor, and the parapet: all three have to be the wall
          const wallX = faceXpos;
          const wallZ = faceZpos;
          // the ground floor has to be the shopfront plinth, and the storeys above the window tile
          if (
            !seesShopfront(cx, cy, cz, wallX, f.ground + 1.4, wallZ) ||
            !seesShopfront(cx, cy, cz, wallX, f.ground + 2.6, wallZ) ||
            !seesUpperWall(cx, cy, cz, wallX, f.ground + 5.2, wallZ) ||
            !seesUpperWall(cx, cy, cz, wallX, f.ground + f.h * 0.75, wallZ)
          ) {
            fun.noWall++;
            if (fun.dbg.length < 6) fun.dbg.push({ f: [f.x, f.z, f.w, f.d, f.h, f.faceX, f.dir], dist, eye, shop1: hitInfo(cx, cy, cz, wallX, f.ground + 1.4, wallZ), shop2: hitInfo(cx, cy, cz, wallX, f.ground + 2.6, wallZ), up1: hitInfo(cx, cy, cz, wallX, f.ground + 5.2, wallZ) });
            continue;
          }
          fun.raysOk++;
          // the whole face, plinth to parapet, has to be in frame
          const pts = [];
          for (const sx of [-1, 1]) for (const sy of [0, 1]) {
            const v = new V3(
              wallX + (nx === 0 ? sx * faceW / 2 : 0),
              f.ground + sy * (f.h + 0.4),
              wallZ + (nx === 0 ? 0 : sx * faceW / 2)
            );
            v.project(cam);
            pts.push({ x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, behind: v.z > 1 });
          }
          const xs = pts.map((p) => p.x);
          const ys = pts.map((p) => p.y);
          const rect = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
          if (fun.dbg.length < 4) fun.dbg.push({ f: [f.x, f.z, f.w, f.d, f.h, f.faceX, f.dir], dist, eye, rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.w), Math.round(rect.h)], behind: pts.filter((p) => p.behind).length, W, H });
          if (pts.some((p) => p.behind)) continue;
          if (rect.x < 4 || rect.y < 4 || rect.x + rect.w > W - 4 || rect.y + rect.h > H - 4) continue;
          if (rect.h < H * 0.35) continue;             // the facade has to fill the frame
          fun.framed++;
          rows.push({
            b: { size: [f.w, f.h, f.d], c: [f.x, f.ground + f.h / 2, f.z], min: [0, f.ground, 0], max: [0, f.ground + f.h, 0] },
            face: [nx, nz],
            dist,
            eye,
            rect,
            cam: [cx, cy, cz],
            at: at.toArray(),
            size: rect.h,
          });
        }
      }
      }
    }
    if (!rows.length) return { ok: false, why: 'no camera candidate frames a full facade', funnel: fun, cands: cands.length };
    rows.sort((a, b) => b.size - a.size);
    const best = rows[0];
    cam.position.set(best.cam[0], best.cam[1], best.cam[2]);
    cam.lookAt(new V3(best.at[0], best.at[1], best.at[2]));
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();

    // freeze the world so the capture is one frame of one scene
    const frozen = { peds: g.peds.update, traffic: g.traffic?.update, city: g.city?.update, police: g.police?.update };
    g.peds.update = () => {};
    if (g.traffic) g.traffic.update = () => {};
    if (g.city) g.city.update = () => {};
    if (g.police) g.police.update = () => {};

    return {
      ok: true,
      buildings: cands.length,
      candidates: rows.length,
      funnel: fun,
      best,
      // the two bands the measurements are taken from, as fractions of the facade rect
      bands: { ground: [0.0, 0.16], upper: [0.30, 0.92] },
      buildingsInView: g.city.footprints.length,
    };
  });

  console.log('STAGE', JSON.stringify(stage, null, 1));
  if (!stage.ok) throw new Error(stage.why);

  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(300);
  await page.screenshot({ path: OUT });

  const png = decodePng(fs.readFileSync(OUT));
  const scale = png.width / page.viewport().width;
  const rect = stage.best.rect;
  const r = {
    x: Math.round(rect.x * scale),
    y: Math.round(rect.y * scale),
    w: Math.round(rect.w * scale),
    h: Math.round(rect.h * scale),
  };
  const band = ([y0, y1]) => ({ y0: r.y + Math.round(r.h * y0), y1: r.y + Math.round(r.h * y1), x0: r.x, x1: r.x + r.w });
  const stats = (b) => colourStats(png, b.x0, b.y0, b.x1, b.y1);
  const upper = stats(band(stage.bands.upper));
  const ground = stats(band(stage.bands.ground));
  const luma = meanLuma(png);

  const proof = { file: OUT, size: [png.width, png.height], meanLuma: luma, upper, ground, face: stage.best.face, dist: stage.best.dist };
  console.log('PROOF', JSON.stringify(proof, null, 1));

  // Thresholds: the wall used to be one colour with one stretched window slot, which measures as
  // a handful of buckets and a luma spread under 4.
  const ok =
    luma >= 20 &&
    upper.colours >= 14 &&
    upper.std >= 7 &&
    ground.colours >= 14 &&
    ground.std >= 12;
  if (errors.length) throw new Error(`page errors: ${errors.slice(0, 3).join(' | ')}`);
  if (!ok) {
    throw new Error(
      `${OUT} does not prove an articulated facade: upper ${upper.colours} colours / std ${upper.std}, ` +
        `ground ${ground.colours} colours / std ${ground.std}, mean luma ${luma}`
    );
  }
  console.log(
    `OK ${OUT}: ${stage.best.b.size.map((n) => Math.round(n)).join('x')} m block, face ${stage.best.face} at ${stage.best.dist} m; ` +
      `upper storeys ${upper.colours} distinct colours (luma std ${upper.std}), ground floor ${ground.colours} colours (std ${ground.std}), mean luma ${luma}`
  );
} finally {
  await browser.close();
}

/** Minimal PNG reader: the tool has to measure the artifact, and the repo has no image library. */
function decodePng(buf) {
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colourType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : 0;
  if (depth !== 8 || !channels) throw new Error(`unsupported PNG (depth ${depth}, colour type ${colourType})`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

function meanLuma(png) {
  const { width, height, channels, data } = png;
  let sum = 0;
  for (let i = 0; i < width * height; i++) {
    sum += 0.2126 * data[i * channels] + 0.7152 * data[i * channels + 1] + 0.0722 * data[i * channels + 2];
  }
  return +(sum / (width * height)).toFixed(1);
}

/** Distinct 5-bit colours and luminance spread inside a rect: "one flat colour" vs a real facade. */
function colourStats(png, x0, y0, x1, y1) {
  const { width, channels, data } = png;
  const buckets = new Set();
  let n = 0;
  let sum = 0;
  let sum2 = 0;
  for (let y = Math.max(0, y0); y < y1; y++) {
    for (let x = Math.max(0, x0); x < x1; x++) {
      const i = (y * width + x) * channels;
      const rr = data[i];
      const gg = data[i + 1];
      const bb = data[i + 2];
      buckets.add(((rr >> 3) << 10) | ((gg >> 3) << 5) | (bb >> 3));
      const l = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
      sum += l;
      sum2 += l * l;
      n++;
    }
  }
  const mean = sum / Math.max(1, n);
  return {
    pixels: n,
    colours: buckets.size,
    meanLuma: +mean.toFixed(1),
    std: +Math.sqrt(Math.max(0, sum2 / Math.max(1, n) - mean * mean)).toFixed(1),
  };
}
