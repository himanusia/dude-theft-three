// Proof frames for the two halves of "you cannot see yourself in the car, and the people in it
// never get out".
//
//   proof/seated-in-car.png  the player's own body, visible in the driver's seat, hands on the
//                            wheel, head under the roof. The camera is chosen by measurement: a
//                            candidate is accepted only when the seated body is big enough on
//                            screen, inside the frame, and changes a real share of its own pixels
//                            when it is taken out of the scene. The delivered file is then
//                            re-checked against a body-hidden frame of the same shot.
//   proof/officer-exits.png  two officers who have just stepped out of the cruiser, standing at
//                            its doors. Same measurement, per body.
//
// usage: node tools/shoot-occupants.mjs [baseUrl]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || process.argv[2] || 'http://127.0.0.1:9453';
const OUT_SEATED = 'screenshots/proof/seated-in-car.png';
const OUT_OFFICER = 'screenshots/proof/officer-exits.png';
const HIDDEN_SEATED = '/tmp/occupants-seated-hidden.png';
const DRIFT_SEATED = '/tmp/occupants-seated-drift.png';
const HIDDEN_OFFICER = '/tmp/occupants-officer-hidden.png';
/** a seated body 4 m away is a few hundred pixels of head, shoulders and hands; 120 is readable */
const MIN_SEATED_PX = 120;
/** a standing officer at 5 m under the same lens is several hundred pixels tall */
const MIN_OFFICER_PX = 130;
/** a body that changes this little of its own rect is behind a pillar, not in the shot */
const MIN_SHARE = 0.1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(path.dirname(OUT_SEATED), { recursive: true });

// ---------------------------------------------------------------- png readback (no vision model)
function decodePng(file) {
  const buf = fs.readFileSync(file);
  let at = 8;
  let w = 0;
  let h = 0;
  let depth = 8;
  let color = 6;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      depth = body[8];
      color = body[9];
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') break;
    at += 12 + len;
  }
  if (depth !== 8 || (color !== 2 && color !== 6)) throw new Error(`unsupported png: depth ${depth} colour ${color}`);
  const channels = color === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
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
      cur[x] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const s = x * channels;
      const d = (y * w + x) * 4;
      out[d] = cur[s];
      out[d + 1] = cur[s + 1];
      out[d + 2] = cur[s + 2];
      out[d + 3] = channels === 4 ? cur[s + 3] : 255;
    }
    prev = cur;
  }
  return { w, h, data: out };
}

/** share of the rect that actually differs between two decoded frames, and the pixel count */
function shareChanged(fa, fb, rect) {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(fa.w, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(fa.h, Math.ceil(rect.y + rect.h));
  let changed = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * fa.w + x) * 4;
      total++;
      if (
        Math.abs(fa.data[i] - fb.data[i]) > 20 ||
        Math.abs(fa.data[i + 1] - fb.data[i + 1]) > 20 ||
        Math.abs(fa.data[i + 2] - fb.data[i + 2]) > 20
      ) changed++;
    }
  }
  return { share: total ? +(changed / total).toFixed(3) : 0, changed };
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1600, height: 1000 },
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction('window.__game !== undefined', { timeout: 180000 });
  await sleep(1200);
  await page.click('#start-btn');
  await page.waitForFunction(() => window.__game.state.started === true, { timeout: 60000 }).catch(() => {});
  await sleep(1500);

  // in-page toolbox: project a body, read the framebuffer, and stage the camera by measurement
  await page.evaluate(() => {
    const g = window.__game;
    const T = {};
    g._test.cinematic(true);
    g.camera.fov = 42;
    g.camera.updateProjectionMatrix();
    const hud = document.getElementById('hud');
    if (hud) hud.style.display = 'none';
    g._test.setTime(0.32); // late morning: the cabin is lit, not a black hole

    const W = () => window.innerWidth;
    const H = () => window.innerHeight;
    T.rect = (box) => {
      const xs = [];
      const ys = [];
      for (const sx of [box.min.x, box.max.x]) {
        for (const sy of [box.min.y, box.max.y]) {
          for (const sz of [box.min.z, box.max.z]) {
            const v = new g.THREE.Vector3(sx, sy, sz).project(g.camera);
            xs.push((v.x * 0.5 + 0.5) * W());
            ys.push((-v.y * 0.5 + 0.5) * H());
          }
        }
      }
      return {
        x: +Math.min(...xs).toFixed(1),
        y: +Math.min(...ys).toFixed(1),
        w: +(Math.max(...xs) - Math.min(...xs)).toFixed(1),
        h: +(Math.max(...ys) - Math.min(...ys)).toFixed(1),
      };
    };
    T.inside = (r, m = 6) => r.x > m && r.y > m && r.x + r.w < W() - m && r.y + r.h < H() - m;
    T.box = (obj) => {
      obj.updateWorldMatrix(true, true);
      return new g.THREE.Box3().setFromObject(obj);
    };
    T.blocked = (ax, ay, az, bx, by, bz) => {
      for (let i = 1; i <= 30; i++) {
        const t = i / 31;
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        const z = az + (bz - az) * t;
        if (g.city.colliders.some((c) => x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ && y < (c.h ?? 30))) return true;
      }
      return false;
    };
    const gl = g.renderer.domElement;
    const probe = document.createElement('canvas');
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    T.readRect = (r) => {
      const sx = gl.width / W();
      const sy = gl.height / H();
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
    T.share = (a, b) => {
      if (!a || !b) return 0;
      let changed = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (Math.abs(a[i] - b[i]) > 20 || Math.abs(a[i + 1] - b[i + 1]) > 20 || Math.abs(a[i + 2] - b[i + 2]) > 20) changed++;
      }
      return +(changed / (a.length / 4)).toFixed(3);
    };
    T.look = (from, at) => {
      g.camera.position.set(from[0], from[1], from[2]);
      g.camera.lookAt(at[0], at[1], at[2]);
      g.camera.updateMatrixWorld();
      g.camera.matrixWorldInverse.copy(g.camera.matrixWorld).invert();
    };
    /** how much of a body's own rect changes when that body is taken out of the frame */
    T.presence = (roots, boxes) => {
      g.renderer.render(g.scene, g.camera);
      const rects = boxes.map((b) => T.rect(b));
      const before = rects.map((r) => T.readRect(r));
      const was = roots.map((r) => r.scale.x);
      roots.forEach((r) => r.scale.setScalar(0.0001));
      g.renderer.render(g.scene, g.camera);
      const after = rects.map((r) => T.readRect(r));
      roots.forEach((r, i) => r.scale.setScalar(was[i]));
      g.renderer.render(g.scene, g.camera);
      return { rects, shares: rects.map((_, i) => T.share(before[i], after[i])) };
    };
    window.__T = T;
  });

  // ---------------------------------------------------------------- A: the player seated
  const staged = await page.evaluate(() => {
    const g = window.__game;
    const T = window.__T;
    // a parked car with somebody in it, put in front of the player
    const car = g.cityCars.find((c) => !c.wrecked && c.driver && c.type !== 'angkot');
    if (!car) return { ok: false, why: 'no parked car with a driver' };
    g._test.teleport(car.pos.x - 1.2, car.pos.z + 1.5);
    g.player.pos.set(car.pos.x - 1.2, 0, car.pos.z + 1.5);
    g._test.toggleVehicle();
    if (g.player.inCar !== car) return { ok: false, why: 'the player did not take the car' };
    const body = car.driver;
    if (!body) return { ok: false, why: 'the seat is empty' };
    // the driver who stepped out of this car is not part of this frame
    const cleared = g._test.clearDriveOuts();

    // the world stops for the shot: a walking pedestrian inside the measured rect would be scored
    // as "the body changed those pixels"
    g.peds.update = () => {};
    if (g.traffic) g.traffic.update = () => {};
    if (g.city) g.city.update = () => {};
    g.police.update = () => {};

    car.mesh.updateWorldMatrix(true, true);
    const fwd = { x: Math.sin(car.yaw), z: Math.cos(car.yaw) };
    const left = { x: -Math.cos(car.yaw), z: Math.sin(car.yaw) }; // left-hand drive: the driver's door
    const box = T.box(body);
    const head = new g.THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y - 0.08, (box.min.z + box.max.z) / 2);
    const tried = [];
    let best = null;
    // from just outside the driver's door, 3-4 m back: close enough to read the face, far enough
    // that the whole car (and so "he is in that car") is in the frame
    for (const ahead of [2.4, 3.2]) {
      for (const across of [2.3, 3.1]) {
        for (const eye of [1.3, 1.6]) {
          const x = car.pos.x + fwd.x * ahead + left.x * across;
          const z = car.pos.z + fwd.z * ahead + left.z * across;
          const y = g.city.groundHeightAt(x, z) + eye;
          if (T.blocked(x, y, z, head.x, head.y, head.z)) continue;
          const shell = new g.THREE.Box3().setFromObject(car.mesh);
          const inCollider = g.city.colliders.some(
            (c) => x > c.minX - 0.4 && x < c.maxX + 0.4 && z > c.minZ - 0.4 && z < c.maxZ + 0.4 && y < (c.h ?? 30)
          );
          if (inCollider) continue;
          T.look([x, y, z], [head.x, head.y, head.z]);
          const m = T.presence([body], [box]);
          const r = m.rects[0];
          const sized = r.h >= 120 && T.inside(r);
          const rank = (sized ? 100 : 0) + Math.min(m.shares[0], 0.9) * 100;
          tried.push({ ahead, across, eye, h: r.h, share: m.shares[0], sized, rank: +rank.toFixed(1) });
          if (sized && (!best || rank > best.rank)) best = { ahead, across, eye, cam: [x, y, z], head: [head.x, head.y, head.z], rect: r, share: m.shares[0], rank, shell: [shell.min.y, shell.max.y] };
        }
      }
    }
    if (!best) return { ok: false, why: 'no camera keeps the seated body in frame', tried };
    T.look(best.cam, best.head);
    // freeze the delivered camera for the captures
    g._test.lookFrom(best.cam[0], best.cam[1], best.cam[2], best.head[0], best.head[1], best.head[2]);
    window.__seated = body;
    window.__seatedHide = (on) => {
      body.visible = !on;
    };
    const shell = new g.THREE.Box3();
    for (const child of car.mesh.children) {
      if (child === body) continue;
      shell.expandByObject(child);
    }
    const headBox = new g.THREE.Box3().setFromObject(body.children[1]);
    let meshes = 0;
    body.traverse((o) => {
      if (o.isMesh && o.visible) meshes++;
    });
    return {
      ok: true,
      type: car.type,
      cleared,
      cam: best.cam.map((v) => +v.toFixed(2)),
      rect: best.rect,
      share: best.share,
      meshes,
      shirt: '#' + body.children[0].material.color.getHexString(),
      headTop: +headBox.max.y.toFixed(3),
      roof: +shell.max.y.toFixed(3),
      clearance: +(shell.max.y - headBox.max.y).toFixed(3),
      candidates: tried.length,
      tried: tried.filter((t) => t.sized).slice(0, 4),
    };
  });
  if (!staged.ok) {
    console.log('TRIED', JSON.stringify(staged.tried || [], null, 1));
    throw new Error(staged.why);
  }
  console.log('SEATED', JSON.stringify({ ...staged }, null, 1));
  if (staged.clearance <= 0) throw new Error(`the seated head is above the roof by ${-staged.clearance} m`);

  await sleep(250);
  await page.screenshot({ path: OUT_SEATED });
  // a second frame of the same shot with nothing removed: whatever moved between the two captures
  // is the scene, not the body, and it has to be a small part of what the body changes
  await sleep(150);
  await page.screenshot({ path: DRIFT_SEATED });
  await page.evaluate(() => window.__seatedHide(true));
  await sleep(120);
  await page.screenshot({ path: HIDDEN_SEATED });
  await page.evaluate(() => window.__seatedHide(false));
  await sleep(120);

  // the file on disk is what gets reviewed: diff it against the body-hidden frame
  const seatedFile = decodePng(OUT_SEATED);
  const seatedHidden = decodePng(HIDDEN_SEATED);
  const seatedShare = shareChanged(seatedFile, seatedHidden, staged.rect);
  console.log('SEATED_FILE', JSON.stringify({ size: [seatedFile.w, seatedFile.h], rect: staged.rect, ...seatedShare }));
  if (seatedShare.share < MIN_SHARE || seatedShare.changed < 900) {
    throw new Error(`the delivered frame shows almost no seated body (${JSON.stringify(seatedShare)})`);
  }
  const seatedDrift = shareChanged(seatedFile, decodePng(DRIFT_SEATED), staged.rect);
  console.log('SEATED_DRIFT', JSON.stringify(seatedDrift));
  if (seatedDrift.share > 0.05 || seatedDrift.changed * 4 > seatedShare.changed) {
    throw new Error(`the seated frame is not still: ${JSON.stringify(seatedDrift)} against the body's ${seatedShare.changed} px`);
  }

  // ---------------------------------------------------------------- B: the officer steps out
  const officer = await page.evaluate(() => {
    const g = window.__game;
    const T = window.__T;
    // a cruiser of our own, on a road of its own, where the player is not in the shot
    const entry = g.police.spawnCar(g.player.pos, 0);
    if (!entry) return { ok: false, why: 'no cruiser spawned' };
    const car = entry.car;
    car.speed = 0;
    g.police.officers.length = 0;
    // the crew gets out: one body per door, and the seat empties
    const crew = g.police.exitCrew(car);
    g.police.update = () => {};
    car.mesh.updateWorldMatrix(true, true);
    const shell = new g.THREE.Box3().setFromObject(car.mesh);
    const mid = [(shell.min.x + shell.max.x) / 2, (shell.min.y + shell.max.y) / 2, (shell.min.z + shell.max.z) / 2];
    const fwd = { x: Math.sin(car.yaw), z: Math.cos(car.yaw) };
    const right = { x: Math.cos(car.yaw), z: -Math.sin(car.yaw) };
    const boxes = crew.map((o) => T.box(o.group));
    const tried = [];
    let best = null;
    // Both sides of the car are tried: the cruiser is dropped on a road lane and one side of it
    // is often the shop row. A low side view also puts the far officer behind the car, so the eye
    // height reaches above the roofline.
    for (const side of [-1, 1]) {
      for (const ahead of [-2.0, 4.0]) {
        for (const across of [7.5, 9.5]) {
        for (const eye of [1.75, 3.2]) {
          const x = mid[0] + fwd.x * ahead + right.x * across * side;
          const z = mid[2] + fwd.z * ahead + right.z * across * side;
          const y = g.city.groundHeightAt(x, z) + eye;
          const inCollider = g.city.colliders.some(
            (c) => x > c.minX - 0.4 && x < c.maxX + 0.4 && z > c.minZ - 0.4 && z < c.maxZ + 0.4 && y < (c.h ?? 30)
          );
          if (inCollider) {
            tried.push({ side, ahead, across, eye, blocked: 'inside a building' });
            continue;
          }
          if (T.blocked(x, y, z, mid[0], mid[1], mid[2])) {
            tried.push({ side, ahead, across, eye, blocked: 'line of sight crosses a building' });
            continue;
          }
          T.look([x, y, z], [mid[0], mid[1] + 0.15, mid[2]]);
          const m = T.presence(crew.map((o) => o.group), boxes);
          const sizes = m.rects.map((r) => r.h);
          const framed = m.rects.every((r) => T.inside(r));
          const sized = sizes.every((h) => h >= 130);
          // two officers standing at the two doors must not be one blob on the screen: a side-on
          // camera puts the far man behind the near one, and the frame then reads as one officer
          const [a, b] = m.rects;
          const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
          const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
          const smaller = Math.min(a.w * a.h, b.w * b.h);
          const overlap = smaller > 0 ? (ox * oy) / smaller : 0;
          const rank = (sized && framed ? 100 : 0) + Math.min(...m.shares) * 100 - overlap * 60;
          tried.push({ side, ahead, across, eye, sizes: sizes.map((v) => +v.toFixed(0)), shares: m.shares, sized, framed, rank: +rank.toFixed(1), blocked: false });
          if (sized && framed && (!best || rank > best.rank)) best = { cam: [x, y, z], sizes, shares: m.shares, rank, rects: m.rects };
        }
        }
      }
    }
    if (!best) return { ok: false, why: 'no camera keeps both officers at the doors in frame', tried };
    T.look(best.cam, [mid[0], mid[1] + 0.15, mid[2]]);
    g._test.lookFrom(best.cam[0], best.cam[1], best.cam[2], mid[0], mid[1] + 0.15, mid[2]);
    window.__crew = crew;
    window.__crewHide = (on) => crew.forEach((o) => {
      if (on) o.group.scale.setScalar(0.0001);
      else o.group.scale.setScalar(1);
    });
    // the union of both bodies' rects is what the delivered frame is checked against
    const rect = {
      x: Math.min(...best.rects.map((r) => r.x)),
      y: Math.min(...best.rects.map((r) => r.y)),
      w: Math.max(...best.rects.map((r) => r.x + r.w)) - Math.min(...best.rects.map((r) => r.x)),
      h: Math.max(...best.rects.map((r) => r.y + r.h)) - Math.min(...best.rects.map((r) => r.y)),
    };
    return {
      ok: true,
      cam: best.cam.map((v) => +v.toFixed(2)),
      rect,
      sizes: best.sizes,
      shares: best.shares,
      officers: crew.map((o) => ({
        at: [+o.pos.x.toFixed(2), +o.pos.z.toFixed(2)],
        lateral: +Math.hypot(o.pos.x - car.pos.x, o.pos.z - car.pos.z).toFixed(2),
        ground: +g.city.groundHeightAt(o.pos.x, o.pos.z).toFixed(2),
        y: +o.pos.y.toFixed(2),
        meshes: (() => {
          let n = 0;
          o.group.traverse((m) => {
            if (m.isMesh && m.visible) n++;
          });
          return n;
        })(),
      })),
      seat: !car.driver,
      doorGap: +(car.width * 0.5 + 0.55).toFixed(2),
    };
  });
  if (!officer.ok) {
    console.log('TRIED', JSON.stringify(officer.tried || [], null, 1));
    throw new Error(officer.why);
  }
  console.log('OFFICER', JSON.stringify({ ...officer, tried: undefined }, null, 1));
  if (!officer.seat) throw new Error('the cruiser still has a body in the seat after the crew got out');
  for (const o of officer.officers) {
    if (Math.abs(o.lateral - officer.doorGap) > 0.35) throw new Error(`an officer stands ${o.lateral} m from the car, not at a ${officer.doorGap} m door`);
    if (Math.abs(o.y - o.ground) > 0.2) throw new Error('an officer is not standing on the ground');
  }

  await sleep(200);
  await page.screenshot({ path: OUT_OFFICER });
  await page.evaluate(() => window.__crewHide(true));
  await sleep(120);
  await page.screenshot({ path: HIDDEN_OFFICER });
  await page.evaluate(() => window.__crewHide(false));
  await sleep(120);

  const officerFile = decodePng(OUT_OFFICER);
  const officerHidden = decodePng(HIDDEN_OFFICER);
  const officerShare = shareChanged(officerFile, officerHidden, officer.rect);
  console.log('OFFICER_FILE', JSON.stringify({ size: [officerFile.w, officerFile.h], rect: officer.rect, ...officerShare }));
  if (officerShare.share < MIN_SHARE || officerShare.changed < 1500) {
    throw new Error(`the delivered frame shows almost no officer (${JSON.stringify(officerShare)})`);
  }

  console.log(
    'SUMMARY ' +
      JSON.stringify({
        seated: { file: OUT_SEATED, changed: seatedShare.changed, clearance: staged.clearance, meshes: staged.meshes },
        officer: { file: OUT_OFFICER, changed: officerShare.changed, count: officer.officers.length },
        errors: errors.slice(0, 3),
      })
  );
  if (errors.length) throw new Error(`page errors: ${errors.slice(0, 2).join(' | ')}`);
} finally {
  await browser.close();
}
