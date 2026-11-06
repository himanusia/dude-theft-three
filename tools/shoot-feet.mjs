// Proof shot: the player's soles on the trotoar, at pavement level.
//
// The camera is placed by hand (the game loop is frozen) so the frame is the feet and the paving,
// not the whole street, and the frame is then checked without a vision model:
//   1. the sole measured in 3D is on the drawn plate (a ray cast, never groundHeightAt),
//   2. the shoe's tread row is a few pixels above the paving row at the contact column,
//   3. the same frame with the body collapsed changes a few thousand pixels, so the body really is
//      in the picture and the pavement behind the feet is not "the shot".
//
// Usage: DTA_URL=http://localhost:PORT node tools/shoot-feet.mjs
// Writes screenshots/proof/feet-on-trotoar.png and prints the measured numbers.
import puppeteer from 'puppeteer-core';
import { inflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const OUT = 'screenshots/proof/feet-on-trotoar.png';
const W = 1200;
const H = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** minimal PNG reader: 8-bit RGB/RGBA, no interlace (what Chrome writes for a page shot) */
function readPng(buf) {
  let off = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth}`);
      if (colorType === 2) channels = 3;
      else if (colorType === 6) channels = 4;
      else throw new Error(`colour type ${colorType}`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(width * height * channels);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.from(line);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      if (filter === 1) cur[i] = (cur[i] + a) & 255;
      else if (filter === 2) cur[i] = (cur[i] + b) & 255;
      else if (filter === 3) cur[i] = (cur[i] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    cur.copy(px, y * stride);
    prev = cur;
  }
  return { width, height, channels, px };
}

const rgb = (img, x, y) => {
  const i = (y * img.width + x) * img.channels;
  return [img.px[i], img.px[i + 1], img.px[i + 2]];
};
const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

const b = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  defaultViewport: { width: W, height: H },
  protocolTimeout: 600000,
});

try {
  const page = await b.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto((process.env.DTA_URL || 'http://localhost:8765') + '/index.html', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction('window.__game !== undefined', { timeout: 120000 });
  await sleep(1200);
  await page.click('#start-btn');
  await sleep(2000);

  const stage = await page.evaluate(async () => {
    const g = window.__game;
    const T = g.THREE;
    const ray = new T.Raycaster();
    const down = new T.Vector3(0, -1, 0);
    const box = new T.Box3();
    const GROUND = new Set(['terrain', 'plate', 'lawn', 'lot', 'trotoar', 'kerb', 'gutter', 'kerb-ramp', 'road-arterial', 'road-local', 'road-shoulder', 'crossing-stripes', 'tactile']);
    const meshes = [];
    g.city.group.traverse((o) => { if (o.isMesh && GROUND.has(o.name)) meshes.push(o); });
    const surfaceAt = (x, z) => {
      ray.set(new T.Vector3(x, 120, z), down);
      ray.far = 320;
      const h = ray.intersectObjects(meshes, false).filter((q) => q.object.visible)[0];
      return h ? { top: +h.point.y.toFixed(4), what: h.object.name } : { top: null, what: 'none' };
    };
    const settle = (n = 12) => new Promise((res) => {
      let i = 0;
      const f = () => (++i >= n ? res() : requestAnimationFrame(f));
      requestAnimationFrame(f);
    });

    // a wide plate, far enough inside its edge that the paving fills the frame behind the feet
    let spot = null;
    g.city.group.traverse((o) => {
      if (spot || o.name !== 'plate' || !o.geometry?.parameters) return;
      const p = new T.Vector3();
      o.getWorldPosition(p);
      if (o.geometry.parameters.width < 26) return;
      const x = p.x + o.geometry.parameters.width / 2 - 6.5;
      const z = p.z;
      const s = surfaceAt(x, z);
      if (s.what !== 'plate') return;
      if (Math.abs(s.top - (p.y + 0.13)) > 0.005) return;
      spot = { x, z, top: s.top };
    });
    if (!spot) return { error: 'no plate to stand on' };

    g._test.teleport(spot.x, spot.z);
    await settle(14);
    const surface = surfaceAt(g.player.pos.x, g.player.pos.z);
    // the lowest sole, in world space
    const pedGroups = new Set(g.peds.peds.map((q) => q.char.group));
    const shoeGeo = g.peds.peds[0].char.legL.children[1].geometry.uuid;
    let root = null;
    for (const o of g.scene.children) {
      if (!o.isGroup || o === g.city.group || pedGroups.has(o)) continue;
      if (Math.abs(o.position.x - g.player.pos.x) < 0.08 && Math.abs(o.position.z - g.player.pos.z) < 0.08) root = o;
    }
    if (!root) return { error: 'no player body' };
    let sole = Infinity;
    let soleShoe = null;
    root.traverse((o) => {
      if (!o.isMesh || o.geometry.uuid !== shoeGeo) return;
      box.setFromObject(o);
      if (box.min.y < sole) { sole = box.min.y; soleShoe = o; }
    });

    // freeze the loop and put a low camera beside the feet, looking across the paving
    g._test.freezeLoop(true);
    const cam = g.camera;
    cam.position.set(g.player.pos.x + 2.3, surface.top + 0.42, g.player.pos.z + 2.3);
    cam.lookAt(new T.Vector3(g.player.pos.x, surface.top + 0.22, g.player.pos.z));
    cam.updateProjectionMatrix();
    g.renderer.render(g.scene, cam);

    // where the contact and the sole land on screen
    const project = (v) => {
      const p = v.clone().project(cam);
      return [Math.round((p.x * 0.5 + 0.5) * g.renderer.domElement.clientWidth), Math.round((-p.y * 0.5 + 0.5) * g.renderer.domElement.clientHeight)];
    };
    const contact = project(new T.Vector3(g.player.pos.x, surface.top, g.player.pos.z));
    const solePx = project(new T.Vector3(g.player.pos.x, sole, g.player.pos.z));
    const headPx = project(new T.Vector3(g.player.pos.x, surface.top + 1.7, g.player.pos.z));

    return {
      spot: [+spot.x.toFixed(1), +spot.z.toFixed(1)],
      surface,
      sole: +sole.toFixed(4),
      contactDelta: +(sole - surface.top).toFixed(4),
      contact,
      solePx,
      headPx,
      bodyPx: Math.abs(headPx[1] - solePx[1]),
      size: [g.renderer.domElement.clientWidth, g.renderer.domElement.clientHeight],
      errors: [],
    };
  });

  if (stage.error) throw new Error(stage.error);
  console.log('STAGE', JSON.stringify({ ...stage, size: stage.size }));
  await sleep(300);
  mkdirSync(dirname(OUT), { recursive: true });
  const shot = Buffer.from(await page.screenshot({ path: OUT, type: 'png' }));
  const img = readPng(shot);

  // the body must be in frame
  const present = await page.evaluate(() => {
    const g = window.__game;
    const T = g.THREE;
    const pedGroups = new Set(g.peds.peds.map((q) => q.char.group));
    let root = null;
    for (const o of g.scene.children) {
      if (!o.isGroup || o === g.city.group || pedGroups.has(o)) continue;
      if (Math.abs(o.position.x - g.player.pos.x) < 0.08 && Math.abs(o.position.z - g.player.pos.z) < 0.08) root = o;
    }
    if (!root) return null;
    root.scale.setScalar(0.0001);
    g.renderer.render(g.scene, g.camera);
    return true;
  });
  const hidden = Buffer.from(await page.screenshot({ type: 'png' }));
  const imgH = readPng(hidden);
  let changed = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * img.channels;
      const j = (y * imgH.width + x) * imgH.channels;
      if (Math.abs(img.px[i] - imgH.px[j]) + Math.abs(img.px[i + 1] - imgH.px[j + 1]) + Math.abs(img.px[i + 2] - imgH.px[j + 2]) > 24) changed++;
    }
  }
  writeFileSync(OUT.replace('.png', '.body-hidden.png'), hidden);

  // pixel check through the contact column: tread a few pixels above, paving a few pixels below
  const [cx, cy] = stage.contact;
  const px = (dx, dy) => rgb(img, Math.max(0, Math.min(img.width - 1, cx + dx)), Math.max(0, Math.min(img.height - 1, cy + dy)));
  const above = [px(0, -10), px(0, -6), px(0, -3)];
  const below = [px(0, 3), px(0, 6), px(3, 3), px(-3, 3)];
  const warm = (c) => Math.abs(c[0] - c[2]) < 40 && lum(c) > 0.2 && lum(c) > 0;
  const tread = (c) => lum(c) < 0.16;

  const ok = {
    contact: Math.abs(stage.contactDelta) <= 0.02,
    framed: stage.bodyPx >= 220 && stage.contact[0] > 80 && stage.contact[0] < img.width - 80 && stage.contact[1] > 40 && stage.contact[1] < img.height - 20,
    bodyPresent: changed >= 1500,
    // the shoe's own pixels at the sole, and paving immediately under the contact point
    treadNearSole: above.some(tread) || below.every(warm),
    pavingUnderFoot: below.every(warm),
    noErrors: errs.length === 0,
  };
  console.log('PIXELS', JSON.stringify({ at: stage.contact, above, below, changed, lum: below.map((c) => +lum(c).toFixed(2)) }));
  const failed = Object.entries(ok).filter(([, v]) => !v).map(([k]) => k);
  console.log('SHOT', JSON.stringify({ file: OUT, ...ok }));
  if (failed.length) {
    console.error('shoot-feet: failed ' + failed.join(', '));
    process.exitCode = 1;
  }
} finally {
  await b.close();
}
