// Proof shot for the pedagang card: one vendor standing at its gerobak with a customer stopped
// beside it, captured from the street side.
//
// The behaviour is the real one: this boots the game headless, puts the player next to a cart so
// the crowd exists there, runs the actual PedManager update until a customer has stopped at the
// counter, then freezes time (peds/traffic/city/police update are no-ops for the capture only) and
// frames the pair. Nothing is posed by hand.
//
// The saved PNG is measured, not assumed: the same frame is saved again with the two characters
// hidden, and the two files are diffed inside each character's projected rect. If those pixels do
// not change, the picture does not contain them and this tool fails instead of shipping a lie.
// usage: node tools/shoot-pedagang.mjs [baseUrl]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || process.argv[2] || 'http://127.0.0.1:9450';
const OUT = process.env.PEDAGANG_SHOT || 'screenshots/proof/pedagang.png';
const HIDDEN = '/tmp/pedagang-hidden.png';
const STILL2 = '/tmp/pedagang-still.png';
/** a 1.8 m body at ~4 m under a 42 degree lens covers hundreds of pixels; 150 is a speck */
const MIN_PED_PX = 150;
/** and it has to read as a body, not a sliver behind its own cart: share of its rect that moves */
const MIN_VISIBLE_SHARE = 0.15;
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
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
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
    cam.fov = 42;
    cam.updateProjectionMatrix();

    const V3 = g.player.pos.constructor;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const dt = 1 / 60;
    const inCollider = (x, z) => g.city.colliders.some((c) => (c.h ?? 30) > 0.8 && x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ);
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
    const rectOf = (pts) => {
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      return {
        x: Math.min(...xs), y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
        behind: pts.some((p) => p.behind),
      };
    };
    const projectBox = (cx, cy, cz, hx, hy, hz) => {
      const pts = [];
      for (const sx of [-1, 1]) for (const sy of [0, 1]) for (const sz of [-1, 1]) {
        const v = new V3(cx + sx * hx, cy + sy * hy, cz + sz * hz);
        v.project(cam);
        pts.push({ x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, behind: v.z > 1 });
      }
      return rectOf(pts);
    };
    const pedRect = (p) => projectBox(p.pos.x, p.pos.y, p.pos.z, 0.35, 1.84 * (p.char.scale ?? 1), 0.35);
    const inside = (r, m = 18) => !r.behind && r.x > m && r.y > m && r.x + r.w < W - m && r.y + r.h < H - m;

    // ---- measured visibility: render with and without the two bodies, count the pixels that move
    const gl = g.renderer.domElement;
    const probe = document.createElement('canvas');
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    const readRect = (r) => {
      const sx = gl.width / W;
      const sy = gl.height / H;
      const x0 = Math.max(0, Math.floor(r.x * sx));
      const y0 = Math.max(0, Math.floor(r.y * sy));
      const w = Math.min(gl.width - x0, Math.max(1, Math.round(r.w * sx)));
      const h = Math.min(gl.height - y0, Math.max(1, Math.round(r.h * sy)));
      if (w < 3 || h < 3) return null;
      probe.width = w;
      probe.height = h;
      pctx.drawImage(gl, x0, y0, w, h, 0, 0, w, h);
      return pctx.getImageData(0, 0, w, h).data;
    };
    const share = (a, b) => {
      if (!a || !b) return 0;
      let changed = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (Math.abs(a[i] - b[i]) > 20 || Math.abs(a[i + 1] - b[i + 1]) > 20 || Math.abs(a[i + 2] - b[i + 2]) > 20) changed++;
      }
      return +(changed / (a.length / 4)).toFixed(3);
    };
    let people = [];
    const measure = (vr, cr) => {
      for (const p of people) p.char.group.visible = true;
      g.renderer.render(g.scene, cam);
      const va = readRect(vr);
      const ca = readRect(cr);
      for (const p of people) p.char.group.visible = false;
      g.renderer.render(g.scene, cam);
      const vb = readRect(vr);
      const cb = readRect(cr);
      for (const p of people) p.char.group.visible = true;
      return { vendor: share(va, vb), customer: share(ca, cb) };
    };

    // ---- find a cart whose counter has a live vendor, and stand the player next to it
    const posts = g.peds.cartPosts || [];
    const debug = [];
    let staged = null;
    for (let i = 0; i < posts.length && !staged; i++) {
      const post = posts[i];
      const vendor = g.peds.peds.find((p) => !p.dead && p.vendor && p.postIndex === post.i);
      if (!vendor) continue;
      // the player stands a few metres up the pavement, so the crowd is recycled around the cart
      const lane = g.peds.nearestLeg(post.x, post.z);
      const px = post.x + (post.cx - post.x) * 0.8 + 3.4;
      const pz = post.z + (post.cz - post.z) * 0.8 + 2.2;
      g._test.teleport(inCollider(px, pz) ? post.x + 5 : px, inCollider(px, pz) ? post.z + 5 : pz);
      const ctx = g._test.pedContext();
      let shopper = null;
      let shopFrames = 0;
      let minD = 999;
      // A walker only crosses a given cart a few times a minute (the pavement is 2 m wide and the
      // crowd is 40 people over the whole street network), so each cart gets 300 s of simulation
      // before this tool gives up on it. The stop itself is 3-6 s, which is plenty to catch.
      for (let s = 0; s < 54000 && !shopper; s++) {
        g.peds.update(dt, ctx);
        if (s < 90) continue; // let the recycling run first
        for (const p of g.peds.peds) {
          if (p.dead || p.vendor) continue;
          const d = Math.hypot(p.pos.x - post.cx, p.pos.z - post.cz);
          if (d < minD) minD = d;
          if (p.shopTimer > 0) shopFrames++;
          if (p.shopTimer > 1.5 && p.shopPost === post.i && d <= 4) {
            shopper = p;
            break;
          }
        }
      }
      debug.push({ i: post.i, cart: post.cart, player: [+g.player.pos.x.toFixed(1), +g.player.pos.z.toFixed(1)], customers: g.peds.stats.customers, shopFrames, minD: +minD.toFixed(2), found: !!shopper });
      if (!shopper) continue;
      staged = { post, vendor, shopper, lane };
    }
    if (!staged) return { ok: false, why: 'no customer stopped at any cart in 300 s of simulation per post', posts: posts.length, debug };

    const { post, vendor, shopper } = staged;
    people = [vendor, shopper];
    const mid = new V3((vendor.pos.x + shopper.pos.x) / 2, 0, (vendor.pos.z + shopper.pos.z) / 2);
    // look from the street toward the cart: out of the cart, away from the shop side
    let sx = mid.x - post.cx;
    let sz = mid.z - post.cz;
    const sl = Math.hypot(sx, sz) || 1;
    sx /= sl;
    sz /= sl;
    const perp = { x: sz, z: -sx };
    const target = new V3(mid.x, 1.05, mid.z);

    // Both sides of the pair: since the vendor is turned into his cart, the street side shows his
    // back. The cart side shows the working pose, which is the thing this shot has to prove.
    const rows = [];
    for (const facing of [1, -1]) for (const dist of [3.8, 4.4, 5.0, 5.6]) {
      for (const side of [-1.4, 0, 1.4]) {
        const cx = mid.x + sx * dist * facing + perp.x * side;
        const cz = mid.z + sz * dist * facing + perp.z * side;
        const ground = g.city.groundHeightAt(cx, cz);
        for (const eye of [1.6, 2.0, 2.4]) {
          const cy = ground + eye;
          if (inCollider(cx, cz)) continue;
          cam.position.set(cx, cy, cz);
          cam.lookAt(target);
          cam.updateMatrixWorld();
          cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
          const vr = pedRect(vendor);
          const cr = pedRect(shopper);
          const kr = projectBox(post.cx, g.city.groundHeightAt(post.cx, post.cz), post.cz, 1.1, 2.4, 0.9);
          if (!inside(vr) || !inside(cr)) continue;
          if (kr.behind || kr.x < -40 || kr.y < -40 || kr.x + kr.w > W + 40) continue;
          if (blocked(cx, cy, cz, mid.x, 1.05, mid.z)) continue;
          rows.push({
            dist, side, eye,
            cam: [+cx.toFixed(2), +cy.toFixed(2), +cz.toFixed(2)],
            ground: +ground.toFixed(2),
            target: target.toArray().map((n) => +n.toFixed(2)),
            vendor: { x: +vr.x.toFixed(1), y: +vr.y.toFixed(1), w: +vr.w.toFixed(1), h: +vr.h.toFixed(1) },
            customer: { x: +cr.x.toFixed(1), y: +cr.y.toFixed(1), w: +cr.w.toFixed(1), h: +cr.h.toFixed(1) },
            cart: { x: +kr.x.toFixed(1), y: +kr.y.toFixed(1), w: +kr.w.toFixed(1), h: +kr.h.toFixed(1) },
            // the bodies have to be big enough to read before measuring them is worth anything
            // both bodies have to be big enough on screen to judge a pose, not just to measure
            size: Math.min(vr.h, cr.h),
            big: Math.min(vr.h, cr.h) >= 240,
          });
        }
      }
    }
    // A pose cannot be judged from a 150 px figure, so prefer framings where both bodies are at
    // least 240 px tall; fall back to the largest available only when nothing that big fits.
    const bigRows = rows.filter((r) => r.big);
    bigRows.sort((a, b) => b.size - a.size);
    const shortlist = (bigRows.length ? bigRows : rows.sort((a, b) => b.size - a.size)).slice(0, 8);
    for (const row of shortlist) {
      cam.position.set(row.cam[0], row.cam[1], row.cam[2]);
      cam.lookAt(new V3(row.target[0], row.target[1], row.target[2]));
      cam.updateMatrixWorld();
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
      row.visible = measure(row.vendor, row.customer);
      row.score = Math.min(row.visible.vendor, row.visible.customer);
    }
    shortlist.sort((a, b) => b.score - a.score);
    const best = shortlist[0];
    if (!best) return { ok: false, why: 'no camera candidate keeps both people and the cart in frame' };

    cam.position.set(best.cam[0], best.cam[1], best.cam[2]);
    cam.lookAt(new V3(best.target[0], best.target[1], best.target[2]));
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();

    // freeze the world for the two captures only: the pose is the simulation's, not a still frame
    // we built by hand. Nothing else about the scene changes.
    const frozen = {
      peds: g.peds.update,
      traffic: g.traffic?.update,
      city: g.city?.update,
      police: g.police?.update,
    };
    g.peds.update = () => {};
    if (g.traffic) g.traffic.update = () => {};
    if (g.city) g.city.update = () => {};
    if (g.police) g.police.update = () => {};
    window.__thaw = () => {
      g.peds.update = frozen.peds;
      if (g.traffic && frozen.traffic) g.traffic.update = frozen.traffic;
      if (g.city && frozen.city) g.city.update = frozen.city;
      if (g.police && frozen.police) g.police.update = frozen.police;
    };
    window.__hide = (on) => {
      vendor.char.group.visible = !on;
      shopper.char.group.visible = !on;
    };
    window.__stage = { vendor, shopper };

    return {
      ok: true,
      carts: posts.length,
      cart: post.cart,
      cartAt: [+post.cx.toFixed(2), +post.cz.toFixed(2)],
      vendorAt: [+vendor.pos.x.toFixed(2), +vendor.pos.z.toFixed(2)],
      customerAt: [+shopper.pos.x.toFixed(2), +shopper.pos.z.toFixed(2)],
      vendorToCart: +Math.hypot(vendor.pos.x - post.cx, vendor.pos.z - post.cz).toFixed(2),
      customerToVendor: +Math.hypot(shopper.pos.x - vendor.pos.x, shopper.pos.z - vendor.pos.z).toFixed(2),
      customerToCart: +Math.hypot(shopper.pos.x - post.cx, shopper.pos.z - post.cz).toFixed(2),
      shopTimer: +shopper.shopTimer.toFixed(2),
      customerSpeed: shopper.speed,
      vendorState: vendor.state,
      // how far the vendor is turned away from his own cart: 0 deg means he faces it square on
      vendorFacesCartDeg: +(
        (Math.acos(
          Math.max(-1, Math.min(1,
            (Math.sin(vendor.yaw) * (post.cx - vendor.pos.x) + Math.cos(vendor.yaw) * (post.cz - vendor.pos.z)) /
              (Math.hypot(post.cx - vendor.pos.x, post.cz - vendor.pos.z) || 1)
          ))
        ) * 180) / Math.PI
      ).toFixed(1),
      vendorArms: {
        left: [+vendor.char.armL.rotation.x.toFixed(2), +vendor.char.armL.rotation.z.toFixed(2)],
        right: [+vendor.char.armR.rotation.x.toFixed(2), +vendor.char.armR.rotation.z.toFixed(2)],
      },
      vendorPostGap: +Math.hypot(vendor.pos.x - vendor.postX, vendor.pos.z - vendor.postZ).toFixed(2),
      player: [+g.player.pos.x.toFixed(1), +g.player.pos.z.toFixed(1)],
      candidates: rows.length,
      shortlist: shortlist.map((r) => ({ dist: r.dist, side: r.side, eye: r.eye, visible: r.visible, size: +r.size.toFixed(0) })),
      best,
      states: g.peds.peds.filter((p) => !p.dead).reduce((a, p) => ((a[p.state] = (a[p.state] || 0) + 1), a), {}),
    };
  });

  console.log('STAGE', JSON.stringify(stage, null, 1));
  if (!stage.ok) throw new Error(stage.why);

  // Two frames so the renderer and the compositor agree, then the delivered file. A second
  // identical frame follows: with the world frozen it must match the delivered one, which is what
  // separates "the characters changed those pixels" from "the frame drifted".
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(250);
  await page.screenshot({ path: OUT });
  await page.screenshot({ path: STILL2 });
  await page.evaluate(() => window.__hide(true));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(250);
  await page.screenshot({ path: HIDDEN });
  await page.evaluate(() => {
    window.__hide(false);
    window.__thaw();
  });

  const shown = decodePng(fs.readFileSync(OUT));
  const still = decodePng(fs.readFileSync(STILL2));
  const hidden = decodePng(fs.readFileSync(HIDDEN));
  const scale = shown.width / page.viewport().width;
  // strict threshold on the bodies (a real silhouette, not shading drift)
  const vendorDiff = diffRect(shown, hidden, stage.best.vendor, scale, 24);
  const customerDiff = diffRect(shown, hidden, stage.best.customer, scale, 24);
  // noise floor: the same two frames with nothing hidden
  const vendorNoise = diffRect(shown, still, stage.best.vendor, scale, 24);
  const customerNoise = diffRect(shown, still, stage.best.customer, scale, 24);
  const luma = meanLuma(shown);

  const proof = {
    file: OUT,
    size: [shown.width, shown.height],
    meanLuma: luma,
    pedPxHeight: { vendor: stage.best.vendor.h, customer: stage.best.customer.h },
    vendorChangedPx: vendorDiff.changed,
    customerChangedPx: customerDiff.changed,
    vendorVisibleShare: vendorDiff.share,
    customerVisibleShare: customerDiff.share,
    chosenByMeasurement: stage.best.visible,
    noiseShare: { vendor: vendorNoise.share, customer: customerNoise.share },
  };
  console.log('PROOF', JSON.stringify(proof, null, 1));

  const okLuma = luma >= 20;
  const okSizes = stage.best.vendor.h >= MIN_PED_PX && stage.best.customer.h >= MIN_PED_PX;
  const okDiff = vendorDiff.share >= MIN_VISIBLE_SHARE && customerDiff.share >= MIN_VISIBLE_SHARE;
  const okNoise = vendorNoise.share <= 0.02 && customerNoise.share <= 0.02;
  if (errors.length) throw new Error(`page errors: ${errors.slice(0, 3).join(' | ')}`);
  if (!okLuma || !okSizes || !okDiff || !okNoise) {
    throw new Error(
      `${OUT} does not prove the pair is in frame: luma ${luma}, ped heights ${stage.best.vendor.h}/${stage.best.customer.h}, ` +
        `visible share ${vendorDiff.share}/${customerDiff.share} of their rects (needs ${MIN_VISIBLE_SHARE}), ` +
        `frame noise ${vendorNoise.share}/${customerNoise.share}`
    );
  }
  console.log(
    `OK ${OUT}: vendor ${stage.best.vendor.w}x${stage.best.vendor.h}px and customer ${stage.best.customer.w}x${stage.best.customer.h}px in frame, ` +
      `${vendorDiff.changed}/${customerDiff.changed} px of the saved frame change when they are hidden ` +
      `(${vendorDiff.share}/${customerDiff.share} of their rects, frame noise ${vendorNoise.changed}/${customerNoise.changed} px), mean luma ${luma}; ` +
      `${stage.cart} at ${stage.cartAt}, vendor ${stage.vendorToCart} m from it, customer ${stage.customerToVendor} m from the vendor with ${stage.shopTimer}s of stop left`
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

/** Pixels inside `rect` that differ between the two saved frames, past `threshold` levels. */
function diffRect(a, b, rect, scale, threshold = 20) {
  const { width, height, channels } = a;
  const x0 = Math.max(0, Math.round(rect.x * scale));
  const y0 = Math.max(0, Math.round(rect.y * scale));
  const x1 = Math.min(width, Math.round((rect.x + rect.w) * scale));
  const y1 = Math.min(height, Math.round((rect.y + rect.h) * scale));
  let changed = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * channels;
      total++;
      if (
        Math.abs(a.data[i] - b.data[i]) > threshold ||
        Math.abs(a.data[i + 1] - b.data[i + 1]) > threshold ||
        Math.abs(a.data[i + 2] - b.data[i + 2]) > threshold
      ) changed++;
    }
  }
  return { changed, total, share: +(changed / Math.max(1, total)).toFixed(3) };
}
