// Proof shot for the kerb seating of a kaki lima cart: low 3/4 from the carriageway, the cart
// standing on the paving with the kerb drop and the road surface in the frame.
//
// Not part of the game; run against a served dist.
// usage: node tools/shoot-cart-kerb.mjs [baseUrl]
//
// The parent shot (tools/shoot-gerobak.mjs) framed the cart from its grounded side, which is exactly
// the side that hid the defect: the far tyre hung 26 cm over the road and no frame showed it. This
// one stands the camera ON the carriageway, 0.45 m up, so the road surface is in the foreground and
// the far tyre's contact patch is the thing in the middle of the picture.
//
// It refuses to save a frame that does not prove it: the far tyre must be in frame, nothing but the
// cart may block the ray to it, and the saved PNG is measured (mean luma, cart pixels in the
// projected box) rather than the live canvas, because a headless capture can commit an empty
// WebGL buffer.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import zlib from 'node:zlib';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || process.argv[2] || 'http://127.0.0.1:8981';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync('screenshots/proof', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  defaultViewport: { width: 1600, height: 1000 },
});
const errors = [];
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
});
await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.__game !== undefined', { timeout: 90000 });
await page.click('#start-btn');
await sleep(2200);
await page.evaluate(() => {
  const g = window.__game;
  g._test.cinematic(true);
  const hud = document.getElementById('hud');
  if (hud) hud.style.display = 'none';
});

// pick the cart that actually stands beside a kerb: the biggest drop between the surface under its
// contacts and the surface a metre further out is the cart with a road behind it
const pick = await page.evaluate(() => {
  const g = window.__game;
  const THREE = g.THREE;
  // `city.pavementBand` is gone: the ground is described by `groundInfoAt().kind` now, which reads
  // the drawn plates and ribbons. Paving is `walk` (trotoar) / `plate` (a block); the carriageway
  // is `road`; the bare verge is `terrain`.
  const PAVED = ['walk', 'plate', 'kerb', 'ramp'];
  const kindAt = (x, z) => g.city.groundInfoAt(x, z).kind;
  const isRoad = (x, z) => kindAt(x, z) === 'road';
  // every ground hit goes through this list, not the whole scene: a muzzle flash is a Sprite, and
  // `Sprite.raycast` throws when the raycaster has no camera
  const meshes = [];
  g.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const carts = [];
  g.scene.traverse((o) => {
    if (typeof o.name === 'string' && o.name.startsWith('kaki5-')) carts.push(o);
  });
  const groundUnder = (x, z) => {
    const near = g.city.groundHeightAt(x, z);
    const rc = new THREE.Raycaster(new THREE.Vector3(x, near + 1.6, z), new THREE.Vector3(0, -1, 0), 0, 3.2);
    for (const h of rc.intersectObjects(meshes, true)) {
      if (h.object.material && h.object.material.transparent) continue;
      if (h.face) {
        const n = h.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(h.object.matrixWorld)).normalize();
        if (n.y < 0.5) continue;
      }
      // the ground, not the cart: a ray down the cart's centre hits its worktop 1.03 m up
      if (Math.abs(h.point.y - near) > 0.35) continue;
      return h.point.y;
    }
    return near;
  };
  const out = [];
  carts.forEach((c, i) => {
    const at = groundUnder(c.position.x, c.position.z);
    // the shot is about a cart standing at a kerb, so the cart is chosen by how close the
    // carriageway comes to it, measured along the same azimuths the camera will use
    let kerbNear = Infinity;
    let outA = 0;
    let drop = 0;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      let hitD = null;
      for (let d = 0.4; d <= 6; d += 0.2) {
        const bx = c.position.x + Math.cos(a) * d;
        const bz = c.position.z + Math.sin(a) * d;
        if (!isRoad(bx, bz)) continue;
        if (!isRoad(bx + Math.cos(a) * 0.8, bz + Math.sin(a) * 0.8)) continue;
        hitD = d;
        break;
      }
      if (hitD === null) continue;
      if (hitD < kerbNear) {
        kerbNear = hitD;
        outA = a;
        drop = at - groundUnder(c.position.x + Math.cos(a) * d2(hitD), c.position.z + Math.sin(a) * d2(hitD));
      }
    }
    // on the raised paving, not in the gutter beside it: the cart's own base has to be at the
    // height `groundHeightAt` reports for that slot
    const raised = PAVED.includes(kindAt(c.position.x, c.position.z)) && Math.abs(at - g.city.groundHeightAt(c.position.x, c.position.z)) < 0.1;
    out.push({ i, name: c.name, x: c.position.x, y: c.position.y, z: c.position.z, yaw: c.rotation.y, at, drop, out: outA, kerbNear: +kerbNear.toFixed(2), raised });
  });
  function d2(v) { return v; }
  // deterministic: the cart that stands closest to a kerb, then the first in scene order
  // a cart on the paving first, then the one closest to a kerb, then scene order
  out.sort((a, b) => (b.raised ? 1 : 0) - (a.raised ? 1 : 0) || a.kerbNear - b.kerbNear || a.i - b.i);
  return out[0];
});

const shot = await page.evaluate(async ({ cand, width, height }) => {
  const g = window.__game;
  const THREE = g.THREE;
  // meshes only: an occlusion ray has to hit something with a face, and a Sprite without a camera
  // on the raycaster throws instead of returning a hit
  const meshes = [];
  g.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const groups = [];
  g.scene.traverse((o) => {
    // the city builds two carts of each kind, so the stance (not the name) is what identifies the
    // one this shot is about - the same rule city.propAudit and the vendor posts use
    if (o.name === cand.name && Math.abs(o.position.x - cand.x) < 0.05 && Math.abs(o.position.z - cand.z) < 0.05) groups.push(o);
  });
  const group = groups[0];
  if (!group) return { error: 'cart group not in scene' };

  // stand on the carriageway: walk out along the kerb drop, then a little crooked so it is a 3/4
  const yaw = group.rotation.y;
  const geo = (lx, lz) => {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return new THREE.Vector3(group.position.x + lx * c + lz * s, group.position.y, group.position.z - lx * s + lz * c);
  };
  const CONTACTS = [
    ['tyre+Z', 0.38, 0.5, -0.005],
    ['tyre-Z', 0.38, -0.5, -0.005],
    ['foot+Z', -0.6, 0.29, 0],
    ['foot-Z', -0.6, -0.29, 0],
  ];
  const rays = new THREE.Raycaster();
  const isMine = (o) => {
    let p = o;
    while (p) { if (p === group) return true; p = p.parent; }
    return false;
  };

  // the far tyre is the one on the other side of the camera, so the camera azimuth decides which
  // tyre the frame is about; try the four quarters off the drop direction and keep the first that
  // proves itself
  // how far out the carriageway starts, along the kerb side: the camera has to stand on the road
  // surface, or the frame proves nothing about the drop the old shots hid
  // the carriageway, not a 20 cm sliver: the band has to stay absent for 1.6 m past the first
  // non-band point, or the camera lands back on paving behind a crossing mouth
  // the camera has to stand on the carriageway itself: `groundInfoAt().kind` names the drawn
  // surface, so `road` is asphalt and not a lot, a gutter or the far side of a crossing mouth
  const isRoad = (ax, az) => g.city.groundInfoAt(ax, az).kind === 'road';
  const onRoad = (ax, az) => isRoad(ax, az);
  const roadDistance = (a) => {
    for (let d = 1.0; d <= 6.5; d += 0.2) {
      const px = group.position.x + Math.cos(a) * d;
      const pz = group.position.z + Math.sin(a) * d;
      if (!onRoad(px, pz)) continue;
      if (!onRoad(px + Math.cos(a) * 0.8, pz + Math.sin(a) * 0.8)) continue;
      if (!onRoad(px + Math.cos(a) * 1.6, pz + Math.sin(a) * 1.6)) continue;
      return d;
    }
    return null;
  };

  let best = null;
  // The frame has to show the FAR tyre, and from straight out at the cart's side the cabinet hides
  // it: the wheels are one per side, so the camera stands 35-60 deg off the cart's long axis. It
  // still stands on the carriageway (an arterial is 8-12 m wide), which is what puts the road
  // surface in the foreground.
  const longA = Math.atan2(-Math.sin(yaw), Math.cos(yaw));
  const azimuths = [
    ...[0.6, -0.6, 0.85, -0.85, 1.05, -1.05].map((s2) => longA + s2),
    ...[0.5, -0.5, 1.1, -1.1].map((s2) => cand.out + s2),
  ];
  // the camera stands on the carriageway, and high enough that the kerb stone does not clip the
  // sight line to the tyre: at 0.45 m the kerb cap (0.315 m proud) hides the contact patch, which is
  // the one thing the frame has to show. 0.95 m is still below the cart's worktop.
  for (const a of azimuths) {
    const kerbAt = roadDistance(a);
    if (kerbAt === null) continue;
    void 0;
    for (const reach of [1.15, 1.9, 2.7]) {
    for (const camHeight of [0.95, 1.3]) {
      const dist = kerbAt + reach;
      const cx = group.position.x + Math.cos(a) * dist;
      const cz = group.position.z + Math.sin(a) * dist;
      const camGround = g.city.groundHeightAt(cx, cz);
      const cam = new THREE.Vector3(cx, camGround + camHeight, cz);
      const target = new THREE.Vector3(group.position.x, group.position.y + 0.45, group.position.z);
      // the sun's shadow camera is parked on the player, so the player comes to the vantage first,
      // then the camera is placed and aimed from its NEW position: Object3D.lookAt aims from
      // matrixWorld, so a stale matrixWorld (the render loop just put the camera behind the player)
      // aims the frame somewhere else entirely
      g._test.teleport(cx, cz);
      await new Promise((r) => setTimeout(r, 120));
      const camera = g.camera;
      g._test.cinematic(true);
      camera.position.set(cam.x, cam.y, cam.z);
      camera.updateMatrixWorld(true);
      camera.lookAt(target);
      camera.updateMatrixWorld(true);
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      camera.updateProjectionMatrix();

      // the far tyre is the one on the other side of the camera; it is what the frame is about
      const tyres = CONTACTS.slice(0, 2).map(([name, lx, lz, ly]) => {
        const p = geo(lx, lz);
        const pt = new THREE.Vector3(p.x, p.y + ly, p.z);
        return { name, p: pt, d: cam.distanceTo(pt) };
      });
      tyres.sort((a2, b2) => b2.d - a2.d);
      const far = tyres[0];
      const blocked = [];
      const sight = [...CONTACTS.map(([name, lx, lz, ly]) => [name, lx, lz, ly + 0.16]), ['body', 0, 0, 0.9]];
      for (const [name, lx, lz, ly] of sight) {
        const p = geo(lx, lz);
        const pt = new THREE.Vector3(p.x, p.y + ly, p.z);
        const dir = pt.clone().sub(cam);
        const dd = dir.length();
        rays.set(cam, dir.normalize());
        const hit = rays.intersectObjects(meshes, true).find((h) => !(h.object.material && h.object.material.transparent));
        if (hit && hit.distance < dd - 0.08 && !isMine(hit.object)) blocked.push({ at: name, by: hit.object.name || hit.object.type, d: +hit.distance.toFixed(2) });
      }
      const proj = (v) => {
        const q = v.clone().project(camera);
        return [((q.x + 1) / 2) * width, ((1 - q.y) / 2) * height];
      };
      const box = [
        [-0.89, 0, -0.53], [-0.89, 0, 0.53], [0.89, 0, 0.53], [0.89, 0, -0.53], [0, 2.0, 0], [-1.06, 0, 0],
      ].map(([lx, ly, lz]) => proj(geo(lx, lz).setY(group.position.y + ly)));
      const xs = box.map((b) => b[0]);
      const ys = box.map((b) => b[1]);
      const rect = { x: Math.max(0, Math.min(...xs)), y: Math.max(0, Math.min(...ys)), w: 0, h: 0 };
      rect.w = Math.min(width, Math.max(...xs)) - rect.x;
      rect.h = Math.min(height, Math.max(...ys)) - rect.y;
      const inside = Math.min(...xs) > 16 && Math.max(...xs) < width - 16 && Math.min(...ys) > 16 && Math.max(...ys) < height - 16;
      // the far tyre is the subject, so its own shoulder has to be the surface the camera sees, not
      // the far side of the cabinet hiding it
      let farVisible = false;
      {
        const dir = far.p.clone().add(new THREE.Vector3(0, 0.16, 0)).sub(cam);
        const dd = dir.length();
        rays.set(cam, dir.normalize());
        const hit = rays.intersectObjects(meshes, true).find((h) => !(h.object.material && h.object.material.transparent));
        farVisible = !!hit && Math.abs(hit.distance - dd) < 0.4;
      }
      const farPt = proj(far.p);
      const inFrame = farPt[0] > 60 && farPt[0] < width - 60 && farPt[1] > 60 && farPt[1] < height - 80;
      const res = {
        cam: [+cam.x.toFixed(2), +cam.y.toFixed(2), +cam.z.toFixed(2)],
        camGround: +camGround.toFixed(3),
        camIsRoad: isRoad(cx, cz),
        kerbDistance: +kerbAt.toFixed(2),
        distance: +dist.toFixed(2),
        reach,
        camHeight,
        azimuth: +a.toFixed(3),
        farTyre: far.name,
        farTyrePx: farPt.map(Math.round),
        inFrame,
        inside,
        blocked,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) },
      };
      res.farVisible = farVisible;
      const ok = res.inFrame && res.inside && farVisible && res.blocked.length === 0 && res.camIsRoad && res.kerbDistance <= 4.5 && rect.h > 330 && rect.w > 230;
      if (ok) return { ...res, ok: true };
      const score = res.blocked.length * 10 + (res.inFrame ? 0 : 5) + (res.inside ? 0 : 5) + (farVisible ? 0 : 8);
      if (!best || score < best._score) best = { ...res, _score: score };
    }
    }
  }
  return { ...best, ok: false };
}, { cand: pick, width: 1600, height: 1000 });

await sleep(400);
const out = 'screenshots/proof/gerobak-kerb.png';
await page.screenshot({ path: out });

const png = decodePng(fs.readFileSync(out));
const luma = meanLuma(png);
const cartPx = pxInRect(png, shot.rect, (r, g2, b) => Math.abs(r - g2) < 18 && Math.abs(g2 - b) < 18 && r > 90 && r < 235);
const proof = {
  file: out,
  cart: { name: pick.name, at: [pick.x.toFixed(2), pick.y.toFixed(3), pick.z.toFixed(2)], yaw: +pick.yaw.toFixed(3), kerbDrop: +pick.drop.toFixed(3), kerbNear: pick.kerbNear },
  camera: shot,
  png: { width: png.width, height: png.height, luma, cartPxRatio: +cartPx.toFixed(3) },
  ok: !!shot.ok && luma > 60 && cartPx > 0.08,
  errors: errors.slice(0, 4),
};
fs.writeFileSync('screenshots/proof/gerobak-kerb.json', JSON.stringify(proof, null, 1));
console.log('SHOT', JSON.stringify(proof));
await browser.close();
if (!proof.ok) process.exitCode = 1;

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

/** fraction of the box's projected rect that reads as painted cart panel, measured on the PNG */
function pxInRect(png, rect, test) {
  const { width, height, channels, data } = png;
  const x0 = Math.max(0, rect.x | 0), y0 = Math.max(0, rect.y | 0);
  const x1 = Math.min(width, (rect.x + rect.w) | 0), y1 = Math.min(height, (rect.y + rect.h) | 0);
  let hit = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * channels;
      total++;
      if (test(data[i], data[i + 1], data[i + 2])) hit++;
    }
  }
  return total ? hit / total : 0;
}
