// Proof shot for the "one body in this city" card: the player and two pedestrians, standing in one
// frame at close range, built from the same Character asset.
//
// The claim is measured four ways, so the PNG is evidence and not decoration:
//   1. identity  - the player's body parts and each pedestrian's are the *same geometry objects*
//                  (equal geometry.uuid per part), the same skeleton height and the same scale;
//                  skin / shirt / pants colour is what differs
//   2. framing   - a candidate camera spot is accepted only if every one of the three bodies is
//                  big enough to read and changes a real share of its own screen rect when it is
//                  taken out of the frame. That is measured on the framebuffer, so a lamp post in
//                  front of a torso rejects the spot instead of shipping a body behind a pole
//   3. presence  - the delivered frame is captured again with the three bodies taken out, and the
//                  same pixel test is applied to the saved file
//   4. drift     - a second consecutive capture with nothing removed must match the delivered file,
//                  which separates "the body changed those pixels" from "the frame moved"
// usage: node tools/shoot-npc-same-asset.mjs [baseUrl]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || process.argv[2] || 'http://localhost:9420';
const OUT = process.env.NPC_SHOT || 'screenshots/proof/npc-same-asset.png';
const HIDDEN = '/tmp/npc-same-asset-hidden.png';
const STILL2 = '/tmp/npc-same-asset-still.png';
/** a 1.84 m body at ~4 m under a 42 degree lens is several hundred pixels tall; 220 is "close range" */
const MIN_BODY_PX = 220;
/** a body in frame changes a real share of its own rect, not a sliver behind a post or a shoulder */
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

  // In-page tools, installed once. Everything below works on the live scene, never on a rebuild.
  await page.evaluate(() => {
    const g = window.__game;
    const V3 = g.player.pos.constructor;
    const W = () => window.innerWidth;
    const H = () => window.innerHeight;
    g._test.cinematic(true);
    g.camera.fov = 42;
    g.camera.updateProjectionMatrix();
    const hud = document.getElementById('hud');
    if (hud) hud.style.display = 'none';
    g._test.setTime(0.3); // morning, so the bodies are lit rather than silhouetted

    const T = {};
    T.inCollider = (x, z) =>
      g.city.colliders.some((c) => (c.h ?? 30) > 0.8 && x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ);
    T.blocked = (ax, ay, az, bx, by, bz) => {
      for (let i = 1; i <= 24; i++) {
        const t = i / 25;
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        const z = az + (bz - az) * t;
        if (g.city.colliders.some((c) => x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ && y < (c.h ?? 30))) return true;
      }
      return false;
    };
    // a rect of the standing body, projected through the current camera
    T.rect = (pos) => {
      const xs = [];
      const ys = [];
      for (const sx of [-1, 1]) for (const sy of [0, 1]) for (const sz of [-1, 1]) {
        const v = new V3(pos.x + sx * 0.3, pos.y + sy * 1.84, pos.z + sz * 0.3);
        v.project(g.camera);
        xs.push((v.x * 0.5 + 0.5) * W());
        ys.push((-v.y * 0.5 + 0.5) * H());
      }
      return {
        x: +Math.min(...xs).toFixed(1),
        y: +Math.min(...ys).toFixed(1),
        w: +(Math.max(...xs) - Math.min(...xs)).toFixed(1),
        h: +(Math.max(...ys) - Math.min(...ys)).toFixed(1),
      };
    };
    T.inside = (r, m = 8) => r.x > m && r.y > m && r.x + r.w < W() - m && r.y + r.h < H() - m;

    // framebuffer readback: what share of a rect changes when a body is taken out of the scene
    const gl = g.renderer.domElement;
    const probe = document.createElement('canvas');
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    const readRect = (r) => {
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
    const share = (a, b) => {
      if (!a || !b) return 0;
      let changed = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (Math.abs(a[i] - b[i]) > 20 || Math.abs(a[i + 1] - b[i + 1]) > 20 || Math.abs(a[i + 2] - b[i + 2]) > 20) changed++;
      }
      return +(changed / (a.length / 4)).toFixed(3);
    };
    // the player's group.visible is rewritten every frame by the on-foot update, so a body is taken
    // out of the frame by collapsing its own scale, which nothing in the loop touches
    T.takeOut = (root, on) => root.scale.setScalar(on ? 0.0001 : 1);
    // average brightness of a rect, so a spot in deep shade can be rejected in favour of a lit one
    T.luma = (r) => {
      const d = readRect(r);
      if (!d) return 0;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      return +(sum / (d.length / 4)).toFixed(1);
    };
    T.measure = (roots) => {
      g.renderer.render(g.scene, g.camera);
      const before = roots.map((r) => readRect(T.rect(r.position)));
      roots.forEach((r) => T.takeOut(r, true));
      g.renderer.render(g.scene, g.camera);
      const after = roots.map((r) => readRect(T.rect(r.position)));
      roots.forEach((r) => T.takeOut(r, false));
      g.renderer.render(g.scene, g.camera);
      return roots.map((r, i) => share(before[i], after[i]));
    };
    window.__T = T;
  });

  const staged = await page.evaluate(() => {
    const g = window.__game;
    const T = window.__T;
    const V3 = g.player.pos.constructor;
    const dt = 1 / 60;

    const playerRoot = () => {
      const pedGroups = new Set(g.peds.peds.map((p) => p.char.group));
      return g.scene.children.find(
        (o) =>
          o.isGroup &&
          !pedGroups.has(o) &&
          Math.abs(o.position.x - g.player.pos.x) < 0.05 &&
          Math.abs(o.position.z - g.player.pos.z) < 0.05
      );
    };
    // resolved once, before anything is teleported: the game loop is what moves the player's body
    // group onto player.pos, and a teleport inside this function would leave it at the old spot
    const playerGroup = playerRoot();
    if (!playerGroup) return { ok: false, why: 'player body not found in the scene' };

    const live = g.peds.peds.filter((p) => !p.dead && !p.vendor && !p.leader && !p.partner);
    const candidates = [];
    for (const anchorPed of live) {
      if (candidates.length >= 40) break;
      const near = g.peds.nearestLeg(anchorPed.pos.x, anchorPed.pos.z);
      const L = g.peds.legs[near.leg];
      if (!L) continue;
      const others = live.filter((p) => p !== anchorPed);
      if (others.length < 2) continue;
      const anchor = { x: anchorPed.pos.x, z: anchorPed.pos.z };
      const slots = [
        { ped: anchorPed, x: anchor.x, z: anchor.z },
        { ped: others[0], x: anchor.x + L.ux * 1.3, z: anchor.z + L.uz * 1.3 },
        { ped: others[1], x: anchor.x - L.ux * 1.3, z: anchor.z - L.uz * 1.3 },
      ];
      if (slots.some((s) => T.inCollider(s.x, s.z))) continue;
      const ground = slots.map((s) => g.city.groundHeightAt(s.x, s.z));
      if (Math.max(...ground) - Math.min(...ground) > 0.25) continue; // one flat pavement, or heights mean nothing
      const mid = { x: (slots[0].x + slots[1].x + slots[2].x) / 3, z: (slots[0].z + slots[1].z + slots[2].z) / 3 };
      const g0 = g.city.groundHeightAt(mid.x, mid.z);
      // the pavement normal points at the street when `side` is right and at the shop row when not
      const nx = L.uz * L.side;
      const nz = -L.ux * L.side;
      for (const mul of [1, -1]) {
        for (const dist of [3.9, 4.4, 4.9]) {
          for (const eye of [1.35, 1.6]) {
            const cx = mid.x + nx * dist * mul;
            const cz = mid.z + nz * dist * mul;
            const cy = g.city.groundHeightAt(cx, cz) + eye;
            if (T.inCollider(cx, cz)) continue;
            if (slots.some((s) => T.blocked(cx, cy, cz, s.x, g0 + 1.0, s.z))) continue;
            candidates.push({ slots, mid, g0, cam: [cx, cy, cz], dist, eye, mul, faceYaw: Math.atan2(cx - mid.x, cz - mid.z) });
          }
        }
      }
    }
    if (!candidates.length) return { ok: false, why: 'no pavement spot gives a clear 4 m view of three bodies' };

    // the rest of the crowd leaves the frame: the trio must be the only bodies in it
    const hideCrowd = (trio) => {
      let n = 0;
      for (const p of g.peds.peds) {
        if (p.dead) continue;
        if (trio.has(p)) {
          p.char.group.visible = true;
          continue;
        }
        if (p.char.group.visible) {
          p.char.group.visible = false;
          n++;
        }
      }
      return n;
    };

    const tried = [];
    let best = null;
    for (const c of candidates.slice(0, 14)) {
      // stand the trio: the player in the middle, a pedestrian either side, all turned to the camera
      g._test.teleport(c.mid.x, c.mid.z);
      g.player.yaw = c.faceYaw;
      g.player.vel.set(0, 0, 0);
      g.player.y = g.city.groundHeightAt(c.mid.x, c.mid.z);
      for (const s of c.slots.slice(1)) {
        s.ped.pos.set(s.x, g.city.groundHeightAt(s.x, s.z), s.z);
        s.ped.yaw = c.faceYaw;
        s.ped.state = 'idle';
        s.ped.speed = 0;
        s.ped.target = s.ped.pos.clone();
        s.ped.char.group.position.copy(s.ped.pos);
        s.ped.char.group.rotation.y = s.ped.yaw;
        s.ped.char.animate(dt, 0);
      }
      g.camera.position.set(c.cam[0], c.cam[1], c.cam[2]);
      g.camera.lookAt(new V3(c.mid.x, c.g0 + 1.0, c.mid.z));
      g.camera.updateMatrixWorld();
      g.camera.matrixWorldInverse.copy(g.camera.matrixWorld).invert();
      const root = playerGroup;
      const trio = new Set(c.slots.map((s) => s.ped));
      const hiddenCrowd = hideCrowd(trio);
      // one frame so the player's body is on its new position before anything is measured
      root.position.set(g.player.pos.x, g.player.y, g.player.pos.z);
      root.rotation.y = g.player.yaw;
      const roots = [root, ...c.slots.slice(1).map((s) => s.ped.char.group)];
      const rects = roots.map((r) => T.rect(r.position));
      const shares = T.measure(roots);
      const luma = T.luma({
        x: Math.min(...rects.map((r) => r.x)),
        y: Math.min(...rects.map((r) => r.y)),
        w: Math.max(...rects.map((r) => r.x + r.w)) - Math.min(...rects.map((r) => r.x)),
        h: Math.max(...rects.map((r) => r.y + r.h)) - Math.min(...rects.map((r) => r.y)),
      });
      const score = Math.min(...shares);
      const sized = rects.every((r) => r.h >= 220) && rects.every((r) => T.inside(r));
      // a body has to be readable in the delivered file: an unlit pavement is a worse proof than
      // a lit one, so candidates in deep shade are only used when nothing else qualifies
      const rank = (sized ? 100 : 0) + (luma >= 85 ? 10 : 0) + Math.min(score, 0.9);
      tried.push({ cam: c.cam.map((v) => +v.toFixed(1)), dist: c.dist, eye: c.eye, sizes: rects.map((r) => r.h), shares, luma, rank: +rank.toFixed(3), sized });
      if (sized && (!best || rank > best.rank)) best = { ...c, root, roots, rects, shares, score, luma, rank, hiddenCrowd };
    }
    if (!best) return { ok: false, why: 'every candidate camera had a body too small, out of frame or hidden', tried };

    // a last frame with the winner's camera, in case the loop ended on a rejected candidate
    const { slots, mid, g0 } = best;
    g._test.teleport(mid.x, mid.z);
    g.player.yaw = best.faceYaw;
    g.player.vel.set(0, 0, 0);
    g.player.y = g.city.groundHeightAt(mid.x, mid.z);
    for (const s of slots.slice(1)) {
      s.ped.pos.set(s.x, g.city.groundHeightAt(s.x, s.z), s.z);
      s.ped.yaw = best.faceYaw;
      s.ped.state = 'idle';
      s.ped.speed = 0;
      s.ped.target = s.ped.pos.clone();
      s.ped.char.group.position.copy(s.ped.pos);
      s.ped.char.group.rotation.y = s.ped.yaw;
      s.ped.char.animate(dt, 0);
    }
    g.camera.position.set(best.cam[0], best.cam[1], best.cam[2]);
    g.camera.lookAt(new V3(mid.x, g0 + 1.0, mid.z));
    g.camera.updateMatrixWorld();
    g.camera.matrixWorldInverse.copy(g.camera.matrixWorld).invert();
    best.root.position.set(g.player.pos.x, g.player.y, g.player.pos.z);
    best.root.rotation.y = g.player.yaw;
    const crowdHidden = hideCrowd(new Set(slots.map((s) => s.ped)));

    // freeze the world for the captures only: the pose is the game's own idle animation
    const frozen = { peds: g.peds.update, traffic: g.traffic?.update, city: g.city?.update, police: g.police?.update };
    g.peds.update = () => {};
    if (g.traffic) g.traffic.update = () => {};
    if (g.city) g.city.update = () => {};
    if (g.police) g.police.update = () => {};

    window.__playerChar = best.root;
    window.__stagedPeds = slots.slice(1).map((s) => s.ped);
    window.__outOfFrame = (on) => {
      window.__T.takeOut(window.__playerChar, on);
      for (const p of window.__stagedPeds) window.__T.takeOut(p.char.group, on);
    };

    const finalRects = best.roots.map((r) => window.__T.rect(r.position));
    return {
      ok: true,
      cam: best.cam.map((v) => +v.toFixed(2)),
      dist: best.dist,
      eye: best.eye,
      streetSide: best.mul,
      mid: [+mid.x.toFixed(2), +mid.z.toFixed(2)],
      pedsAt: slots.slice(1).map((s) => [+s.x.toFixed(2), +s.z.toFixed(2)]),
      spacing: +Math.hypot(slots[1].x - slots[0].x, slots[1].z - slots[0].z).toFixed(2),
      hiddenCrowd: crowdHidden,
      luma: best.luma,
      candidates: candidates.length,
      tried: tried.filter((t) => t.sized).slice(0, 5),
      rects: finalRects,
      shares: best.shares,
    };
  });

  if (!staged.ok) {
    console.log('TRIED', JSON.stringify(staged.tried || [], null, 1));
    throw new Error(staged.why);
  }
  console.log('STAGE', JSON.stringify({ ...staged, tried: staged.tried.length }, null, 1));

  // ---- identity: same geometry objects, same skeleton height, same scale; colour is the variation
  const identity = await page.evaluate(() => {
    const g = window.__game;
    const V3 = g.player.pos.constructor;
    const playerRoot = window.__playerChar;
    // Both the player and a pedestrian are built by the same constructor, so the body is read off
    // each group by the same index path. The path is discovered once on a pedestrian's own
    // Character (which exposes the parts by name) and applied to all three groups.
    const ref = window.__stagedPeds[0].char;
    const at = (arr, obj) => arr.indexOf(obj);
    const torsoI = at(ref.group.children, ref.torso);
    const legLI = at(ref.group.children, ref.legL);
    const headI = at(ref.torso.children, ref.head);
    const armLI = at(ref.torso.children, ref.armL);
    const faceOf = (head) => head.children.find((c) => c.isMesh && c.geometry && c.geometry.type === 'PlaneGeometry');

    const parts = (root) => {
      const torso = root.children[torsoI];
      const head = torso.children[headI];
      const legL = root.children[legLI];
      const armL = torso.children[armLI];
      return {
        head: head.children[0].geometry.uuid,
        hair: head.children[1].geometry.uuid,
        face: faceOf(head).geometry.uuid,
        torso: torso.children[0].geometry.uuid,
        hips: torso.children[1].geometry.uuid,
        arm: armL.children[0].geometry.uuid,
        hand: armL.children[armL.children.length - 1].geometry.uuid,
        leg: legL.children[0].geometry.uuid,
        shoe: legL.children[1].geometry.uuid,
      };
    };
    const hex = (m) => '#' + m.color.getHexString();
    const colour = (root) => {
      const torso = root.children[torsoI];
      const legL = root.children[legLI];
      return { skin: hex(torso.children[headI].children[0].material), shirt: hex(torso.children[0].material), pants: hex(legL.children[0].material) };
    };
    const meshCount = (grp) => {
      let n = 0;
      grp.traverse((o) => {
        if (o.isMesh) n++;
      });
      return n;
    };
    // skeleton height in the body's own frame, with the idle breathing bob taken out, so a hair
    // style or a beanie cannot make two copies of one asset look taller than they are
    const skeleton = (root) => {
      const torso = root.children[torsoI];
      const head = new V3();
      torso.children[headI].children[0].getWorldPosition(head);
      const shoe = new V3();
      root.children[legLI].children[1].getWorldPosition(shoe);
      const base = root.position.y;
      return { headY: +(head.y - base - torso.position.y).toFixed(4), footY: +(shoe.y - base).toFixed(4), scale: +root.scale.x.toFixed(4) };
    };

    const bodies = [{ who: 'player', root: playerRoot }];
    for (const p of window.__stagedPeds) bodies.push({ who: 'pedestrian', root: p.char.group });
    const out = bodies.map((b) => ({ who: b.who, parts: parts(b.root), colour: colour(b.root), skeleton: skeleton(b.root), meshes: meshCount(b.root) }));
    const first = out[0].parts;
    const sameGeometry = out.every((c) => Object.keys(first).every((k) => c.parts[k] === first[k]));
    const headSpread = +(Math.max(...out.map((c) => c.skeleton.headY)) - Math.min(...out.map((c) => c.skeleton.headY))).toFixed(4);
    return { ok: true, bodies: out, sameGeometry, headSpread };
  });
  console.log('IDENTITY', JSON.stringify(identity, null, 1));
  if (!identity.ok) throw new Error(identity.why);
  if (!identity.sameGeometry) throw new Error('the three bodies do not share the same geometry objects');
  if (identity.headSpread > 0.002) throw new Error(`skeleton heights differ by ${identity.headSpread} m: not one asset`);

  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(250);
  await page.screenshot({ path: OUT });
  await page.screenshot({ path: STILL2 });

  await page.evaluate(() => window.__outOfFrame(true));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(250);
  await page.screenshot({ path: HIDDEN });
  await page.evaluate(() => window.__outOfFrame(false));

  const shown = decodePng(fs.readFileSync(OUT));
  const still = decodePng(fs.readFileSync(STILL2));
  const empty = decodePng(fs.readFileSync(HIDDEN));
  const scale = shown.width / page.viewport().width;
  const rects = staged.rects.map((r, i) => ({ who: ['player', 'pedestrian-A', 'pedestrian-B'][i], ...r }));
  const diffs = rects.map((b) => ({
    who: b.who,
    rect: [b.x, b.y, b.w, b.h],
    changed: diffRect(shown, empty, b, scale, 24),
    noise: diffRect(shown, still, b, scale, 24),
  }));

  const proof = {
    file: OUT,
    size: [shown.width, shown.height],
    meanLuma: meanLuma(shown),
    bodyHeightsPx: rects.map((b) => b.h),
    changedPx: diffs.map((d) => d.changed.changed),
    visibleShare: diffs.map((d) => d.changed.share),
    noiseShare: diffs.map((d) => d.noise.share),
  };
  console.log('PROOF', JSON.stringify(proof, null, 1));

  const luma = proof.meanLuma;
  const okLuma = luma >= 20;
  const okDiff = diffs.every((d) => d.changed.share >= MIN_VISIBLE_SHARE);
  // Drift: the pedestrians are frozen, but the player's idle breathing animation is driven by the
  // game loop and keeps running between the two identical captures, so a few edge pixels move even
  // when nothing is hidden. The test is therefore "the drift is small next to the body's own
  // footprint", not "the two frames are bit-identical".
  const noiseOf = (d) => +(d.noise.share / Math.max(d.changed.share, 1e-6)).toFixed(3);
  const okNoise = diffs.every((d) => d.noise.share <= 0.05 && noiseOf(d) <= 0.25);
  if (errors.length) throw new Error(`page errors: ${errors.slice(0, 3).join(' | ')}`);
  if (!okLuma || !okDiff || !okNoise) {
    throw new Error(
      `${OUT} does not prove the three bodies are in frame: luma ${luma}, ` +
        `visible share ${diffs.map((d) => d.changed.share).join('/')} (needs ${MIN_VISIBLE_SHARE}), ` +
        `frame noise ${diffs.map((d) => d.noise.share + ' (' + noiseOf(d) + ' of the body)').join('/')}`
    );
  }
  console.log(
    `OK ${OUT}: player ${rects[0].w}x${rects[0].h}px and two pedestrians ${rects[1].w}x${rects[1].h}, ${rects[2].w}x${rects[2].h} px ` +
      `(${staged.dist} m away, ${staged.spacing} m apart), ${diffs.map((d) => d.changed.changed).join('/')} px change when they leave frame ` +
      `(${diffs.map((d) => d.changed.share).join('/')} of their rects, drift ${diffs.map((d) => d.noise.changed + ' px = ' + noiseOf(d) + ' of the body').join('/')}), ` +
      `luma ${luma}; same geometry objects, skeleton head spread ${identity.headSpread} m`
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

/** Pixels inside a rect (CSS px coords) that differ by more than `tol` between two frames. */
function diffRect(a, b, rect, scale, tol) {
  const x0 = Math.max(0, Math.floor(rect.x * scale));
  const y0 = Math.max(0, Math.floor(rect.y * scale));
  const x1 = Math.min(a.width, Math.ceil((rect.x + rect.w) * scale));
  const y1 = Math.min(a.height, Math.ceil((rect.y + rect.h) * scale));
  let changed = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * a.channels;
      const j = (y * b.width + x) * b.channels;
      total++;
      if (
        Math.abs(a.data[i] - b.data[j]) > tol ||
        Math.abs(a.data[i + 1] - b.data[j + 1]) > tol ||
        Math.abs(a.data[i + 2] - b.data[j + 2]) > tol
      ) {
        changed++;
      }
    }
  }
  return { changed, total, share: total ? +(changed / total).toFixed(3) : 0 };
}

function meanLuma(img) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < img.data.length; i += img.channels) {
    sum += 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
    n++;
  }
  return +(sum / n).toFixed(1);
}
