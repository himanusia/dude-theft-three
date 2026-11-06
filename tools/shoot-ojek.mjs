// Proves the ojek cargo box is on screen: finds a live ojek in the built scene, aims a camera at
// the box from the road side at eye height over city.groundHeightAt, and captures it.
// usage: node tools/shoot-ojek.mjs [baseUrl]
//
// The box is merged into the bike's gloss bucket for the draw-call budget, so there is no node
// called "cargo box" to aim at and the propAudit slot is a placement coordinate, not the mesh.
// city.ojeks exposes each live bike with its box bounds; every camera candidate is scored by how
// much brand green lands inside the box's projected rect, so the shot is the best of a measured
// set instead of a guess that photographs empty road.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import zlib from 'node:zlib';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || process.argv[2] || 'http://127.0.0.1:8765';
const OUT = process.env.OJEK_SHOT || 'screenshots/proof/kurir.png';
/** a box seen at street distance should cover at least this share of its own rect in brand green */
const MIN_GREEN = 0.12;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  /** requests that never completed: a dropped audio socket is noise, a dropped script is not */
  const failed = [];
  page.on('requestfailed', (r) => failed.push({ url: r.url(), err: r.failure()?.errorText }));
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // the browser repeats a requestfailed as an anonymous console error; the URL is in `failed`
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
  });
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__game !== undefined', { timeout: 60000 });
  await sleep(1200);
  await page.click('#start-btn');
  await page.waitForFunction(() => window.__game.state.started === true, { timeout: 30000 }).catch(() => {});
  await sleep(1500);

  const inventory = await page.evaluate(() => {
    const g = window.__game;
    const c = document.getElementById('hud');
    if (c) c.style.display = 'none'; // a clean frame: the HUD would sit over the bike
    g._test.cinematic(true); // stop the follow camera from taking the frame back
    return {
      ojeks: (g.city.ojeks || []).map((o, i) => ({
        i,
        name: o.group.name,
        x: +o.x.toFixed(1),
        z: +o.z.toFixed(1),
        box: o.box ? { center: o.box.center.toArray().map((n) => +n.toFixed(2)), size: o.box.size.toArray().map((n) => +n.toFixed(2)) } : null,
      })),
    };
  });
  console.log('INVENTORY', JSON.stringify(inventory));
  if (!inventory.ojeks.length) throw new Error('no live ojek exposed on city.ojeks');

  // Score every (bike, side, distance) candidate by how much brand green lands on the box rect.
  const scan = await page.evaluate(() => {
    const g = window.__game;
    const city = g.city;
    const cam = g.camera;
    const renderer = g.renderer;
    const scene = g.scene;
    const V3 = g.player.pos.constructor;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const gl = renderer.domElement;
    const probe = document.createElement('canvas');
    const ctx = probe.getContext('2d', { willReadFrequently: true });

    // A proof detail shot, not a gameplay wide: 58 deg puts the bike at 10% of the frame.
    cam.fov = 32;
    cam.updateProjectionMatrix();

    const inCollider = (x, z) => city.colliders.some((c) => x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ);
    /**
     * Nothing solid between the lens and the bike. A stall counter or a wall corner across the
     * front wheel looks like a cropped bike, and the first capture of this card was a good
     * example of a shot nobody could judge. The bike's own collider is excluded, or every
     * candidate would report itself blocked.
     */
    const clearSight = (entry, camPos, target) => {
      const own = new Set(
        city.colliders.filter(
          (c) =>
            entry.x > c.minX - 1.3 && entry.x < c.maxX + 1.3 && entry.z > c.minZ - 1.3 && entry.z < c.maxZ + 1.3
        )
      );
      const blocked = (x, y, z) =>
        city.colliders.some((c) => !own.has(c) && x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ && y < c.h);
      for (const aim of [target, entry.group.localToWorld(new V3(0, 0.75, 0))]) {
        for (let i = 1; i <= 24; i++) {
          const t = i / 25;
          const x = camPos[0] + (aim.x - camPos[0]) * t;
          const y = camPos[1] + (aim.y - camPos[1]) * t;
          const z = camPos[2] + (aim.z - camPos[2]) * t;
          if (blocked(x, y, z)) return false;
        }
      }
      return true;
    };
    // the rank parks bikes a few metres apart: a camera that lands on the neighbour frames its
    // cargo box across the whole shot, which is how a "giant floating box" got into a capture
    const clearOfOtherBikes = (x, z, index) =>
      (city.ojeks || []).every((o, i) => i === index || Math.hypot(o.x - x, o.z - z) > 2.2);
    // and no second bike parked on the lens side of the subject: a rank partner sitting behind
    // the subject overlaps its silhouette and the shot reads as a pile of scooters
    const noBikeBehindSubject = (entry, index, camPos) => {
      const dx = camPos[0] - entry.x;
      const dz = camPos[2] - entry.z;
      const len = Math.hypot(dx, dz) || 1;
      return (city.ojeks || []).every((o, i) => {
        if (i === index) return true;
        const ox = o.x - entry.x;
        const oz = o.z - entry.z;
        const dist = Math.hypot(ox, oz);
        return dist > 12 || (ox * dx + oz * dz) / len < 1.5;
      });
    };

    const place = (entry, side, dist) => {
      const yaw = entry.group.rotation.y;
      const f = { x: Math.sin(yaw), z: Math.cos(yaw) }; // bike forward, local +Z (front wheel forward)
      const n = { x: f.z, z: -f.x }; // bike right, local +X
      const cx = entry.x + n.x * side * dist - f.x * 1.4;
      const cz = entry.z + n.z * side * dist - f.z * 1.4;
      const ground = city.groundHeightAt(cx, cz);
      const cy = ground + 1.3; // eye height over the road the camera stands on
      const target = new V3(0, 0.95, -0.28); // halfway between the rider's shoulder and the box
      entry.group.localToWorld(target);
      cam.position.set(cx, cy, cz);
      cam.lookAt(target);
      cam.updateMatrixWorld();
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
      return { cx, cy, cz, ground, target };
    };

    const projectLocal = (entry, corners) =>
      corners.map((c) => {
        const v = new V3(c[0], c[1], c[2]);
        entry.group.localToWorld(v);
        v.project(cam);
        return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, behind: v.z > 1 };
      });

    const rectOf = (pts) => {
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      return {
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs),
        h: Math.max(...ys) - Math.min(...ys),
        x1: Math.max(...xs),
        y1: Math.max(...ys),
        behind: pts.some((p) => p.behind),
      };
    };

    const boxRect = (entry) => {
      const { center, size } = entry.box;
      const corners = [];
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          for (const sz of [-1, 1]) {
            corners.push([center.x + (sx * size.x) / 2, center.y + (sy * size.y) / 2, center.z + (sz * size.z) / 2]);
          }
        }
      }
      return rectOf(projectLocal(entry, corners));
    };

    // the bike and its rider have to sit inside the frame, not slide off an edge
    const bikeCorners = [];
    for (const sx of [-0.36, 0.36]) {
      for (const sy of [0, 1.66]) {
        for (const sz of [-0.95, 0.95]) bikeCorners.push([sx, sy, sz]);
      }
    }

    // brand green: clearly green and clearly not the grey road / red or green bike paint
    const measure = (rect) => {
      renderer.render(scene, cam);
      const sx = gl.width / W;
      const sy = gl.height / H;
      const x0 = Math.max(0, Math.floor(rect.x * sx));
      const y0 = Math.max(0, Math.floor(rect.y * sy));
      const w = Math.min(gl.width - x0, Math.max(1, Math.round(rect.w * sx)));
      const h = Math.min(gl.height - y0, Math.max(1, Math.round(rect.h * sy)));
      if (w < 3 || h < 3) return { green: 0, total: 0, ratio: 0 };
      probe.width = w;
      probe.height = h;
      ctx.drawImage(gl, x0, y0, w, h, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      let green = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i];
        const gg = d[i + 1];
        const b = d[i + 2];
        if (gg > 60 && gg > r * 1.3 && gg > b * 1.4) green++;
      }
      return { green, total: w * h, ratio: +(green / (w * h)).toFixed(3) };
    };

    const rows = [];
    for (const [index, entry] of (city.ojeks || []).entries()) {
      if (!entry.box) continue;
      // closest framing that still keeps the whole bike inside the frame wins the sort below, so
      // the box is as large on screen as the lens allows instead of a speck in a wide shot
      for (const side of [1, -1]) {
        for (const dist of [3.6, 4.2, 4.8]) {
          const p = place(entry, side, dist);
          if (inCollider(p.cx, p.cz)) {
            rows.push({ index, side, dist, skipped: 'camera inside a collider' });
            continue;
          }
          if (!clearOfOtherBikes(p.cx, p.cz, index)) {
            rows.push({ index, side, dist, skipped: 'camera lands on another bike' });
            continue;
          }
          if (!noBikeBehindSubject(entry, index, [p.cx, p.cy, p.cz])) {
            rows.push({ index, side, dist, skipped: 'another bike sits behind the subject' });
            continue;
          }
          if (!clearSight(entry, [p.cx, p.cy, p.cz], p.target)) {
            rows.push({ index, side, dist, skipped: 'something solid blocks the bike' });
            continue;
          }
          const whole = rectOf(projectLocal(entry, bikeCorners));
          if (whole.behind || whole.x < 16 || whole.y < 16 || whole.x1 > W - 16 || whole.y1 > H - 16) {
            rows.push({ index, side, dist, skipped: 'bike touches the frame edge' });
            continue;
          }
          // A rank partner sharing the frame reads as a second rider sitting on the subject: the
          // first framing of this card did exactly that. The subject has to own its own silhouette,
          // so a neighbour's projected body may not overlap it.
          const intruder = (city.ojeks || []).find((o, i) => {
            if (i === index) return false;
            const r = rectOf(
              bikeCorners.map((c) => {
                const v = new V3(c[0], c[1], c[2]);
                o.group.localToWorld(v);
                v.project(cam);
                return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, behind: v.z > 1 };
              })
            );
            if (r.behind) return false;
            return r.x < whole.x1 + 8 && r.x1 > whole.x - 8 && r.y < whole.y1 + 8 && r.y1 > whole.y - 8;
          });
          if (intruder) {
            rows.push({ index, side, dist, skipped: 'a rank partner shares the frame' });
            continue;
          }
          const rect = boxRect(entry);
          if (rect.behind || rect.w < 8 || rect.h < 8) {
            rows.push({ index, side, dist, skipped: 'box off screen' });
            continue;
          }
          const px = measure(rect);
          rows.push({
            index,
            name: entry.group.name,
            side,
            dist,
            cam: [+p.cx.toFixed(2), +p.cy.toFixed(2), +p.cz.toFixed(2)],
            ground: +p.ground.toFixed(2),
            target: p.target.toArray().map((n) => +n.toFixed(2)),
            rect: { x: +rect.x.toFixed(1), y: +rect.y.toFixed(1), w: +rect.w.toFixed(1), h: +rect.h.toFixed(1) },
            bike: { x: +whole.x.toFixed(1), y: +whole.y.toFixed(1), w: +whole.w.toFixed(1), h: +whole.h.toFixed(1) },
            ...px,
          });
        }
      }
    }
    // The box has to read as the box (not a few green pixels of terrain). Among the framings that
    // prove it, the closest lens wins: a stable key, so a re-run picks the same bike instead of
    // whichever one the passing traffic happened to leave the most green pixels on.
    const usable = rows.filter((r) => !r.skipped && r.ratio >= 0.3);
    usable.sort((a, b) => a.dist - b.dist || a.index - b.index || b.side - a.side);
    const why = {};
    for (const r of rows) if (r.skipped) why[r.skipped] = (why[r.skipped] || 0) + 1;
    return { best: usable[0], rows: usable.slice(0, 6), total: rows.length, why, skipped: rows.filter((r) => r.skipped).length };
  });

  console.log('SCAN', JSON.stringify(scan, null, 1));
  const best = scan.best;
  if (!best || best.skipped) throw new Error('no usable camera candidate');

  await page.evaluate((b) => {
    window.__game._test.lookFrom(b.cam[0], b.cam[1], b.cam[2], b.target[0], b.target[1], b.target[2]);
  }, best);

  // The proof has to be the file that lands on disk, not a frame read back inside the page: a
  // headless screenshot can commit an empty WebGL buffer (flat clear colour), and an in-page
  // measurement then happily describes a picture nobody can look at.
  let proof = null;
  for (let attempt = 1; attempt <= 4 && !proof; attempt++) {
    // two frames: one to render with the new camera, one for the compositor to pick it up
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await sleep(200);
    await page.screenshot({ path: OUT });
    const png = decodePng(fs.readFileSync(OUT));
    const scale = png.width / page.viewport().width;
    const measured = boxGreen(png, best.rect, scale);
    const brightness = meanLuma(png);
    if (brightness >= 20 && measured.ratio >= MIN_GREEN) proof = { attempt, brightness, ...measured };
    else console.log(`RETRY ${attempt}: frame ${brightness} mean luma, box ${measured.ratio} green (empty-buffer capture)`);
  }

  console.log('SHOT', JSON.stringify({ file: OUT, cam: best.cam, ground: best.ground, rect: best.rect, bike: best.bike, errors, failed, proof }));
  if (errors.length) throw new Error(`page errors: ${errors.slice(0, 3).join(' | ')}`);
  // an audio clip dropping its socket does not change a frame; a missing bundle does
  const broken = failed.filter((f) => !/\.(mp3|ogg|wav|m4a)(\?|$)/i.test(f.url));
  if (broken.length) throw new Error(`resources failed to load: ${broken.slice(0, 3).map((f) => `${f.url} ${f.err}`).join(' | ')}`);
  if (!proof) throw new Error(`${OUT} does not show a green cargo box (last attempt below ${MIN_GREEN})`);
  console.log(
    `OK ${OUT}: ${proof.green}/${proof.total} brand-green px in the ${best.rect.w}x${best.rect.h} box rect (${proof.ratio}), ` +
      `frame mean luma ${proof.brightness}, camera on the ground at y=${best.ground}`
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

/** Brand green inside the box's projected rect, measured on the saved frame. */
function boxGreen(png, rect, scale) {
  const { width, height, channels, data } = png;
  const x0 = Math.max(0, Math.round(rect.x * scale));
  const y0 = Math.max(0, Math.round(rect.y * scale));
  const x1 = Math.min(width, Math.round((rect.x + rect.w) * scale));
  const y1 = Math.min(height, Math.round((rect.y + rect.h) * scale));
  let green = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      total++;
      if (g > 60 && g > r * 1.3 && g > b * 1.4) green++;
    }
  }
  return { green, total, ratio: +(green / Math.max(1, total)).toFixed(3), rectPx: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}
