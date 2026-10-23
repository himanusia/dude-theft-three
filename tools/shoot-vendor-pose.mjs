// Proof shot + numbers for the vendor pose card: one pedagang at his own gerobak, close enough to
// read the arms and which way the body is turned.
//
// The behaviour is the real one: this boots the game headless, puts the player beside the cart so
// the crowd exists there at full LOD, runs the actual PedManager update, then freezes time for the
// capture only. Nothing is posed by hand.
//
// Two independent checks, because "it looks fine to me" is not evidence:
//   1. Pose geometry read off the live skeleton in the vendor's own frame: shoulder and hand world
//      positions decomposed into forward/lateral/height. A T-pose has the hands ~1.9 m apart at
//      shoulder height; this asserts they are in, forward and at worktop height, and that the body
//      is turned to its cart within a few degrees. Run over every cart, not just the photographed
//      one.
//   2. The saved PNG is measured: the same frame is written again with the vendor hidden and the
//      two files are diffed inside the vendor's projected rect, so the picture provably contains
//      the body it claims to.
// usage: node tools/shoot-vendor-pose.mjs [baseUrl]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || process.argv[2] || 'http://127.0.0.1:9470';
const OUT = process.env.VENDOR_POSE_SHOT || 'screenshots/proof/vendor-pose.png';
const HIDDEN = '/tmp/vendor-pose-hidden.png';
const STILL2 = '/tmp/vendor-pose-still.png';
/** the body has to be big enough to read arms, not a speck in the street */
const MIN_PED_PX = 300;
/** and a real silhouette: share of its rect that changes when the body is hidden */
const MIN_VISIBLE_SHARE = 0.12;
/** T-pose puts the hands ~1.9 m apart; a working pose keeps them over the pan */
const MAX_HAND_SPREAD = 0.8;
/** hands reach past the body toward the worktop, not hanging at the hips */
const MIN_HAND_FORWARD = 0.35;
/** degrees off the face of his own cart that he works */
const MAX_YAW_ERR = 12;
/** and off the line to the cart's centre: standing 0.22 m along a 1.5 m deck is not facing away */
const MAX_YAW_FROM_CENTRE = 20;
/** hands belong at the worktop: a man working a cart does not reach from across the pavement */
const MAX_HAND_GAP = 0.6;
/** a T-pose reads ~1.9 m across in the silhouette; this is the ceiling for a working pose */
const MAX_SILHOUETTE = 1.2;
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
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 90000 });
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
    const inCollider = (x, z) => g.city.colliders.some((c) => (c.h ?? 30) > 0.8 && x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ);
    const blocked = (ax, ay, az, bx, by, bz, ignore) => {
      for (let i = 1; i <= 24; i++) {
        const t = i / 25;
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        const z = az + (bz - az) * t;
        const hit = g.city.colliders.some((c) => {
          if (ignore && ignore(c)) return false;
          return x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ && y < (c.h ?? 30);
        });
        if (hit) return true;
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
    const inside = (r, m = 10) => !r.behind && r.x > m && r.y > m && r.x + r.w < W - m && r.y + r.h < H - m;

    // ---- the pose question, answered on the live skeleton in the body's own frame
    const v = new V3();
    const world = (obj) => { obj.getWorldPosition(v); return { x: v.x, y: v.y, z: v.z }; };
    const handOf = (arm) => world(arm.children[arm.children.length - 1]);
    const poseOf = (ped) => {
      const ch = ped.char;
      const yaw = ped.yaw;
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      const local = (p) => {
        const dx = p.x - ped.pos.x;
        const dz = p.z - ped.pos.z;
        // local +z is the way the body faces, local +x is its right
        return { fwd: dx * sin + dz * cos, lat: dx * cos - dz * sin, y: p.y - ped.pos.y };
      };
      const hl = local(handOf(ch.armL));
      const hr = local(handOf(ch.armR));
      const sl = local(world(ch.armL));
      const sr = local(world(ch.armR));
      return {
        state: ped.state,
        handSpread: +Math.abs(hl.lat - hr.lat).toFixed(3), // shoulder-to-shoulder span of the hands
        handForward: +((hl.fwd + hr.fwd) / 2).toFixed(3),
        handHeight: +((hl.y + hr.y) / 2).toFixed(3),
        handY: +Math.max(hl.y, hr.y).toFixed(3),
        shoulderHeight: +((sl.y + sr.y) / 2).toFixed(3),
        handOut: +Math.max(Math.abs(hl.lat), Math.abs(hr.lat)).toFixed(3),
        torsoPitch: +ch.torso.rotation.x.toFixed(3),
        headPitch: +ch.head.rotation.x.toFixed(3),
      };
    };

    // ---- where the hands are relative to the cart itself: the deck is 1.5 m x 0.9 m, its top at
    // 1.0 m, so "over the pan" is a short distance to that box in the cart's own frame
    const cartGroupOf = (post) =>
      (g.city.group?.children || []).find(
        (o) => Math.abs(o.position.x - post.cx) < 0.05 && Math.abs(o.position.z - post.cz) < 0.05
      );
    const deckHalf = { x: 0.75, z: 0.45, top: 1.0 };
    const handsVsCart = (post, ped) => {
      const cart = cartGroupOf(post);
      const cartYaw = cart ? cart.rotation.y : 0;
      const v2 = new V3();
      let mx = 0;
      let my = 0;
      let mz = 0;
      for (const arm of [ped.char.armL, ped.char.armR]) {
        arm.children[arm.children.length - 1].getWorldPosition(v2);
        mx += v2.x / 2;
        my += v2.y / 2;
        mz += v2.z / 2;
      }
      const dx = mx - post.cx;
      const dz = mz - post.cz;
      const cs = Math.sin(cartYaw);
      const cc = Math.cos(cartYaw);
      const local = { x: +(dx * cc - dz * cs).toFixed(3), y: +(my - g.city.groundHeightAt(post.cx, post.cz)).toFixed(3), z: +(dx * cs + dz * cc).toFixed(3) };
      const outX = Math.max(Math.abs(local.x) - deckHalf.x, 0);
      const outZ = Math.max(Math.abs(local.z) - deckHalf.z, 0);
      const gap = +Math.hypot(outX, outZ, Math.max(local.y - deckHalf.top, 0)).toFixed(3);
      // the face he is working: cart-local +z or -z, whichever side his body is on
      const bodyLocalZ = dx * cs + dz * cc;
      const side = bodyLocalZ >= 0 ? 1 : -1;
      const faceYaw = Math.atan2(-cs * side, -cc * side);
      let df = ((faceYaw - ped.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      return {
        cartYaw: +cartYaw.toFixed(3),
        face: side > 0 ? '+z' : '-z',
        local,
        gap,
        yawErrFaceDeg: +(df * (180 / Math.PI)).toFixed(1),
      };
    };

    // ---- every cart gets its vendor measured, not just the one in the photo
    const posts = g.peds.cartPosts || [];
    const poses = [];
    for (const post of posts) {
      const vendor = g.peds.peds.find((p) => !p.dead && p.vendor && p.postIndex === post.i);
      if (!vendor) continue;
      // stand the player near the cart: the ped only poses inside ANIM_LOD
      g._test.teleport(post.cx + 3.2, post.cz + 3.2);
      const ctx = g._test.pedContext();
      for (let s = 0; s < 30; s++) g.peds.update(1 / 60, ctx);
      const toCart = Math.atan2(post.cx - vendor.pos.x, post.cz - vendor.pos.z);
      const dyaw = ((toCart - vendor.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const vs = handsVsCart(post, vendor);
      poses.push({
        cart: post.cart,
        cartAt: [+post.cx.toFixed(2), +post.cz.toFixed(2)],
        vendorAt: [+vendor.pos.x.toFixed(2), +vendor.pos.z.toFixed(2)],
        distToCart: +Math.hypot(vendor.pos.x - post.cx, vendor.pos.z - post.cz).toFixed(2),
        yawErrDeg: +(dyaw * (180 / Math.PI)).toFixed(1),
        yawErrFaceDeg: vs.yawErrFaceDeg,
        face: vs.face,
        handCart: vs.local,
        handGapToDeck: vs.gap,
        ...poseOf(vendor),
      });
    }

    // ---- the cart the card names, then any cart with a vendor, for the frame
    const order = posts.slice().sort((a, b) => (b.cart === 'kaki5-bakso') - (a.cart === 'kaki5-bakso') || a.i - b.i);
    let staged = null;
    for (const post of order) {
      const vendor = g.peds.peds.find((p) => !p.dead && p.vendor && p.postIndex === post.i);
      if (!vendor) continue;
      g._test.teleport(post.cx + 3.2, post.cz + 3.2);
      const ctx = g._test.pedContext();
      for (let s = 0; s < 40; s++) g.peds.update(1 / 60, ctx);
      if (vendor.state !== 'vendor') continue;
      staged = { post, vendor };
      break;
    }
    if (!staged) return { ok: false, why: 'no cart has a vendor standing at it', posts: posts.length };
    const { post, vendor } = staged;

    // ---- hands against the cart itself: the cart's own yaw is read off its group in the scene, so
    // the hand position can be expressed in cart-local metres (deck half 0.75 x 0.43, top at 1.0 m)
    const cartGroup = cartGroupOf(post);
    const cartYaw = cartGroup ? cartGroup.rotation.y : 0;
    const stagedHands = handsVsCart(post, vendor);
    const handCart = stagedHands.local;
    const handGapToDeck = stagedHands.gap;

    // ---- camera: the shot a customer would see. The cart is in the foreground, the vendor behind
    // his own counter with both hands over it, so the arms and the body's turn both read. Candidates
    // are laid out in the CART's frame (front = the sign side customers read), then measured, not
    // guessed: the frame with the most vendor pixels actually visible wins.
    const cs2 = Math.sin(cartYaw);
    const cc2 = Math.cos(cartYaw);
    const front = { x: cs2, z: cc2 }; // cart-local +z: the sign side, where the customers stand
    const right = { x: cc2, z: -cs2 };
    const cartGround = g.city.groundHeightAt(post.cx, post.cz);
    const focus = new V3(post.cx - front.x * 0.9, cartGround + 1.15, post.cz - front.z * 0.9);
    const rows = [];
    const reject = { collider: 0, vendorOut: 0, cartOut: 0, blocked: 0, inCart: 0, sample: null };
    for (const dist of [3.8, 4.4, 5.0, 5.6, 6.2]) {
      for (const side of [-2.0, -1.2, -0.4, 0.4, 1.2, 2.0]) {
        for (const eye of [1.5, 1.8]) {
          const cx = post.cx + front.x * dist + right.x * side;
          const cz = post.cz + front.z * dist + right.z * side;
          const cy = g.city.groundHeightAt(cx, cz) + eye;
          if (inCollider(cx, cz)) { reject.collider++; continue; }
          cam.position.set(cx, cy, cz);
          cam.lookAt(focus);
          cam.updateMatrixWorld();
          cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
          const vr = projectBox(vendor.pos.x, vendor.pos.y, vendor.pos.z, 0.45, 1.84 * (vendor.char.scale ?? 1), 0.45);
          // the cart's work area (body + whatever is cooking on it), not the canopy overhead
          const kr = projectBox(post.cx, cartGround + 0.85, post.cz, 0.85, 0.55, 0.55);
          if (!inside(vr)) { reject.vendorOut++; continue; }
          if (!inside(kr, 30)) { reject.cartOut++; continue; }
          // the cart itself is what we are shooting over, so its own collider is not an obstruction
          const inCartBox = (c) => post.cx > c.minX && post.cx < c.maxX && post.cz > c.minZ && post.cz < c.maxZ;
          if (blocked(cx, cy, cz, vendor.pos.x, vendor.pos.y + 1.0, vendor.pos.z, inCartBox)) { reject.blocked++; continue; }
          rows.push({
            family: 'customer-side', dist, side, eye,
            cam: [+cx.toFixed(2), +cy.toFixed(2), +cz.toFixed(2)],
            target: focus.toArray().map((n) => +n.toFixed(2)),
            vendor: { x: +vr.x.toFixed(1), y: +vr.y.toFixed(1), w: +vr.w.toFixed(1), h: +vr.h.toFixed(1) },
            cart: { x: +kr.x.toFixed(1), y: +kr.y.toFixed(1), w: +kr.w.toFixed(1), h: +kr.h.toFixed(1) },
            size: Math.min(vr.h, vr.w * 2.2),
          });
        }
      }
    }
    // also try the vendor's own shoulder line: a profile keeps arms and the turn legible even when
    // the cart would sit between a customer-side camera and his body
    for (const along of [-1.2, -0.4, 0.4]) {
      for (const side of [3.6, 4.4, -3.6, -4.4]) {
        for (const eye of [1.4, 1.7]) {
          const tx = post.cx - vendor.pos.x;
          const tz = post.cz - vendor.pos.z;
          const tl = Math.hypot(tx, tz) || 1;
          const cx = vendor.pos.x + (tx / tl) * along + (tz / tl) * side;
          const cz = vendor.pos.z + (tz / tl) * along - (tx / tl) * side;
          const cy = g.city.groundHeightAt(cx, cz) + eye;
          if (inCollider(cx, cz)) { reject.collider++; continue; }
          cam.position.set(cx, cy, cz);
          cam.lookAt(focus);
          cam.updateMatrixWorld();
          cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
          const vr = projectBox(vendor.pos.x, vendor.pos.y, vendor.pos.z, 0.45, 1.84 * (vendor.char.scale ?? 1), 0.45);
          const kr = projectBox(post.cx, cartGround + 0.85, post.cz, 0.85, 0.55, 0.55);
          if (!inside(vr)) { reject.vendorOut++; if (!reject.sample) reject.sample = { along, side, eye, vr, W, H, cam: [+cx.toFixed(2), +cy.toFixed(2), +cz.toFixed(2)], focus: focus.toArray() }; continue; }
          if (!inside(kr, 30)) { reject.cartOut++; continue; }
          const inCartBox = (c) => post.cx > c.minX && post.cx < c.maxX && post.cz > c.minZ && post.cz < c.maxZ;
          if (blocked(cx, cy, cz, vendor.pos.x, vendor.pos.y + 1.0, vendor.pos.z, inCartBox)) { reject.blocked++; continue; }
          rows.push({
            family: 'profile', along, side, eye,
            cam: [+cx.toFixed(2), +cy.toFixed(2), +cz.toFixed(2)],
            target: focus.toArray().map((n) => +n.toFixed(2)),
            vendor: { x: +vr.x.toFixed(1), y: +vr.y.toFixed(1), w: +vr.w.toFixed(1), h: +vr.h.toFixed(1) },
            cart: { x: +kr.x.toFixed(1), y: +kr.y.toFixed(1), w: +kr.w.toFixed(1), h: +kr.h.toFixed(1) },
            size: Math.min(vr.h, vr.w * 2.2),
          });
        }
      }
    }
    // and from the far side of the cart: the cart sits in the foreground with the vendor behind it,
    // facing the camera, both arms reaching over the worktop. That is the frame the pose is for.
    {
      const vx = vendor.pos.x;
      const vz = vendor.pos.z;
      const dx = post.cx - vx;
      const dz = post.cz - vz;
      const dl = Math.hypot(dx, dz) || 1;
      const nx = dx / dl; // vendor -> cart
      const nz = dz / dl;
      const sx = -nz; // along the cart's face
      const sz = nx;
      const midTarget = new V3((vx + post.cx) / 2, cartGround + 1.15, (vz + post.cz) / 2);
      for (const past of [2.4, 3.0, 3.6]) {
        for (const side of [0, -0.8, 0.8, -1.6, 1.6]) {
          for (const eye of [1.5, 1.8]) {
            const cx = post.cx + nx * past + sx * side;
            const cz = post.cz + nz * past + sz * side;
            const cy = g.city.groundHeightAt(cx, cz) + eye;
            if (inCollider(cx, cz)) { reject.collider++; continue; }
            cam.position.set(cx, cy, cz);
            cam.lookAt(midTarget);
            cam.updateMatrixWorld();
            cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
            const vr = projectBox(vx, vendor.pos.y, vz, 0.45, 1.84 * (vendor.char.scale ?? 1), 0.45);
            const kr = projectBox(post.cx, cartGround + 0.85, post.cz, 0.85, 0.55, 0.55);
            if (!inside(vr)) { reject.vendorOut++; continue; }
            if (!inside(kr, 20)) { reject.cartOut++; continue; }
            rows.push({
              family: 'counter-side', past, side, eye,
              cam: [+cx.toFixed(2), +cy.toFixed(2), +cz.toFixed(2)],
              target: midTarget.toArray().map((n) => +n.toFixed(2)),
              vendor: { x: +vr.x.toFixed(1), y: +vr.y.toFixed(1), w: +vr.w.toFixed(1), h: +vr.h.toFixed(1) },
              cart: { x: +kr.x.toFixed(1), y: +kr.y.toFixed(1), w: +kr.w.toFixed(1), h: +kr.h.toFixed(1) },
              size: Math.min(vr.h, vr.w * 2.2),
            });
          }
        }
      }
    }
    if (!rows.length) return { ok: false, why: 'no camera candidate keeps the vendor and the cart in frame', reject };

    // measured visibility picks the frame: render with and without the vendor, count the pixels
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
    // a hand is legible only if it is actually in front of the body from the camera: its projected
    // box has to change when the vendor is hidden. Measuring that rejects the frame where the torso
    // covers the arms, which is the one thing this card is about.
    // measure the most promising frames from each family, so a first-in-the-array shot cannot win
    const shortlist = [];
    for (const fam of ['customer-side', 'counter-side', 'profile']) {
      const mine = rows.filter((r) => r.family === fam).sort((a, b) => b.vendor.h - a.vendor.h);
      shortlist.push(...mine.slice(0, 6));
    }
    for (const row of shortlist) {
      cam.position.set(row.cam[0], row.cam[1], row.cam[2]);
      cam.lookAt(new V3(row.target[0], row.target[1], row.target[2]));
      cam.updateMatrixWorld();
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
      // this camera's view of the two hands
      const hv = new V3();
      const handBoxes = [];
      for (const arm of [vendor.char.armL, vendor.char.armR]) {
        arm.children[arm.children.length - 1].getWorldPosition(hv);
        const p = hv.clone().project(cam);
        handBoxes.push({ x: (p.x * 0.5 + 0.5) * W - 26, y: (-p.y * 0.5 + 0.5) * H - 26, w: 52, h: 52 });
      }
      vendor.char.group.visible = true;
      g.renderer.render(g.scene, cam);
      const a = readRect(row.vendor);
      const ha = handBoxes.map((h) => readRect(h));
      vendor.char.group.visible = false;
      g.renderer.render(g.scene, cam);
      const b = readRect(row.vendor);
      const hb = handBoxes.map((h) => readRect(h));
      vendor.char.group.visible = true;
      row.visible = share(a, b);
      row.hands = ha.map((x, i) => share(x, hb[i]));
      row.handShare = Math.min(...row.hands);
    }
    // the pose is the point of the frame: the body has to be big and visible AND the hands legible
    const rank = (r) => r.visible * Math.min(1, r.vendor.h / 700) * (0.35 + 0.65 * Math.min(1, r.handShare / 0.3));
    shortlist.sort((a, b) => rank(b) - rank(a));
    const best = shortlist[0];
    cam.position.set(best.cam[0], best.cam[1], best.cam[2]);
    cam.lookAt(new V3(best.target[0], best.target[1], best.target[2]));
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();

    // freeze the world for the two captures only: the pose is the simulation's
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
    window.__hide = (on) => { vendor.char.group.visible = !on; };

    return {
      ok: true,
      carts: posts.length,
      cart: post.cart,
      cartAt: [+post.cx.toFixed(2), +post.cz.toFixed(2)],
      vendorAt: [+vendor.pos.x.toFixed(2), +vendor.pos.z.toFixed(2)],
      distToCart: +Math.hypot(vendor.pos.x - post.cx, vendor.pos.z - post.cz).toFixed(2),
      pose: poseOf(vendor),
      handCart,
      handGapToDeck,
      cartYaw: +cartYaw.toFixed(3),
      poses,
      candidates: rows.length,
      reject,
      best,
      shortlist: shortlist.map((r) => ({
        family: r.family, dist: r.dist, past: r.past, side: r.side, along: r.along, eye: r.eye,
        h: r.vendor.h, visible: r.visible, hands: r.hands, handShare: r.handShare,
      })),
    };
  });

  console.log('STAGE', JSON.stringify(stage, null, 1));
  if (!stage.ok) throw new Error(stage.why);

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
  const vendorDiff = diffRect(shown, hidden, stage.best.vendor, scale, 24);
  const vendorNoise = diffRect(shown, still, stage.best.vendor, scale, 24);
  const luma = meanLuma(shown);
  // the silhouette in the file, not just the rig: a T-pose is ~1.9 m across at chest height
  const silhouette = maskProfile(shown, hidden, stage.best.vendor, scale, 1.84);

  const proof = {
    file: OUT,
    size: [shown.width, shown.height],
    meanLuma: luma,
    pedPx: stage.best.vendor,
    cartPx: stage.best.cart,
    vendorChangedPx: vendorDiff.changed,
    vendorVisibleShare: vendorDiff.share,
    noiseShare: vendorNoise.share,
    silhouette,
    pose: stage.pose,
    yawErrDeg: stage.poses.find((p) => p.cart === stage.cart)?.yawErrDeg,
  };
  console.log('PROOF', JSON.stringify(proof, null, 1));

  // ---- verdict
  const failures = [];
  for (const p of stage.poses) {
    if (p.state !== 'vendor') failures.push(`${p.cart}: state ${p.state}, not standing at the counter`);
    if (p.handSpread > MAX_HAND_SPREAD) failures.push(`${p.cart}: hands ${p.handSpread} m apart (T-pose > ${MAX_HAND_SPREAD})`);
    if (p.handForward < MIN_HAND_FORWARD) failures.push(`${p.cart}: hands only ${p.handForward} m forward`);
    // turned into his own worktop: square to the face he works (the body may sit off-centre along
    // a 1.5 m deck, which reads as reaching for the pan, not as facing away)
    if (Math.abs(p.yawErrFaceDeg) > MAX_YAW_ERR) failures.push(`${p.cart}: body ${p.yawErrFaceDeg} deg off the face he works`);
    if (Math.abs(p.yawErrDeg) > MAX_YAW_FROM_CENTRE) failures.push(`${p.cart}: body ${p.yawErrDeg} deg off the line to the cart centre`);
    if (p.distToCart < 0.6) failures.push(`${p.cart}: vendor ${p.distToCart} m from the cart centre (inside it)`);
    if (p.handGapToDeck > MAX_HAND_GAP) failures.push(`${p.cart}: hands ${p.handGapToDeck} m off its deck (max ${MAX_HAND_GAP})`);
  }
  if (stage.best.vendor.h < MIN_PED_PX) failures.push(`vendor only ${stage.best.vendor.h} px tall in the frame`);
  if (vendorDiff.share < MIN_VISIBLE_SHARE) failures.push(`vendor covers ${vendorDiff.share} of its rect (needs ${MIN_VISIBLE_SHARE})`);
  if (vendorNoise.share > 0.02) failures.push(`frame noise ${vendorNoise.share} above 0.02`);
  if (stage.handGapToDeck > MAX_HAND_GAP) failures.push(`hands ${stage.handGapToDeck} m off the cart deck (max ${MAX_HAND_GAP})`);
  if (silhouette.widestMetres > MAX_SILHOUETTE) failures.push(`silhouette ${silhouette.widestMetres} m across at its widest (T-pose ~1.9 m)`);
  if (stage.best.cart.h < 120) failures.push(`cart only ${stage.best.cart.h} px tall in the frame`);
  if (luma < 20) failures.push(`frame is too dark (mean luma ${luma})`);
  if (errors.length) failures.push(`page errors: ${errors.slice(0, 3).join(' | ')}`);

  console.log('HANDS vs CART', `cart yaw ${stage.cartYaw} rad, hands at cart-local x ${stage.handCart.x} / y ${stage.handCart.y} / z ${stage.handCart.z} m, ${stage.handGapToDeck} m off the deck box`);
  console.log('SILHOUETTE', `body ${silhouette.bodyPx} px tall, widest ${silhouette.widestPx} px (${silhouette.widestMetres} m) at ${silhouette.widestBand} of its height; bands ${silhouette.bands.join('/')} px`);
  console.log('POSES');
  for (const p of stage.poses) {
    console.log(
      `  ${p.cart.padEnd(14)} ${p.distToCart}m from cart, ${p.face} face: ${p.yawErrFaceDeg}deg off it (${p.yawErrDeg}deg off centre), ` +
        `hands ${p.handSpread}m apart / ${p.handForward}m forward / ${p.handHeight}m up, ${p.handGapToDeck}m off the deck ` +
        `(shoulders ${p.shoulderHeight}m), torso ${p.torsoPitch} rad, head ${p.headPitch} rad`
    );
  }
  if (failures.length) throw new Error(`vendor pose is not acceptable:\n  - ${failures.join('\n  - ')}`);
  console.log(
    `OK ${OUT}: ${stage.best.vendor.w}x${stage.best.vendor.h} px body at ${stage.cart} (${stage.cartAt[0]},${stage.cartAt[1]}), ` +
      `${stage.distToCart} m from the cart, body ${stage.poses.find((p) => p.cart === stage.cart)?.yawErrFaceDeg} deg off the face it works, ` +
      `hands ${stage.pose.handSpread} m apart / ${stage.pose.handForward} m forward / ${stage.pose.handHeight} m up, ` +
      `${stage.handGapToDeck} m off the deck; silhouette ${silhouette.widestMetres} m at its widest (T-pose ~1.9 m); ` +
      `${vendorDiff.changed} px of the saved frame change when the body is hidden (${vendorDiff.share} of its rect, ` +
      `frame noise ${vendorNoise.changed} px), mean luma ${luma}`
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

/**
 * The silhouette a reader actually sees, measured on the two saved frames: the pixels inside the
 * body's rect that change when the body is hidden are the body. Widths are sampled in ten bands of
 * the body's own height and scaled with the body's known height, so the answer is in metres and a
 * T-pose (~1.9 m across) cannot pass as a working pose.
 */
function maskProfile(shown, hidden, rect, scale, bodyMetres) {
  const { width, height, channels } = shown;
  const x0 = Math.max(0, Math.round(rect.x * scale));
  const y0 = Math.max(0, Math.round(rect.y * scale));
  const x1 = Math.min(width, Math.round((rect.x + rect.w) * scale));
  const y1 = Math.min(height, Math.round((rect.y + rect.h) * scale));
  const rows = new Map();
  for (let y = y0; y < y1; y++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * channels;
      if (
        Math.abs(shown.data[i] - hidden.data[i]) > 24 ||
        Math.abs(shown.data[i + 1] - hidden.data[i + 1]) > 24 ||
        Math.abs(shown.data[i + 2] - hidden.data[i + 2]) > 24
      ) {
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    }
    if (hi > lo) rows.set(y, [lo, hi]);
  }
  if (!rows.size) return { bodyPx: 0, widestPx: 0, widestMetres: 0, widestBand: 0, bands: [] };
  const top = Math.min(...rows.keys());
  const bot = Math.max(...rows.keys());
  const bodyPx = bot - top;
  const bands = [];
  let widest = { w: 0, band: 0 };
  for (let k = 0; k < 10; k++) {
    const lo = bot - Math.round((bodyPx * (k + 1)) / 10);
    const hi = bot - Math.round((bodyPx * k) / 10);
    let w = 0;
    for (let y = lo; y < hi; y++) {
      const r = rows.get(y);
      if (r && r[1] - r[0] > w) w = r[1] - r[0];
    }
    bands.push(w);
    if (w > widest.w) widest = { w, band: k / 10 };
  }
  const mpp = bodyMetres / Math.max(1, bodyPx);
  return {
    bodyPx,
    widestPx: widest.w,
    widestMetres: +(widest.w * mpp).toFixed(2),
    widestBand: widest.band,
    bands,
  };
}
