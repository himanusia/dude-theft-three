// Proof for the look-up card: the follow camera has to reach the guideway underside and the sky.
//
// What this measures, all on a real build served over http:
//   1. The pitch stop, reached by INPUT (a drag on the touch look control, and pointer-locked
//      mousemove when the headless browser grants the lock). No `_test.setCam` is used to find
//      the limit: the limit is whatever the clamp stops the drag at.
//   2. The view pitch that stop produces, from `camera.getWorldDirection` after the boom settles.
//      That is the number the owner feels, and it is not the same as the boom elevation, because
//      the camera may not sink into the street.
//   3. The frame itself: a 25x17 grid of rays from the settled camera classifies every sample as
//      sky (nothing hit) or guideway (hit lands on the MRT deck), and the saved PNG is decoded and
//      compared sample by sample. The picture has to contain both, in the places the geometry
//      says they are, or the shot does not count.
//   4. Boom collision and near clip still work: the camera stands off the street, is not inside a
//      collider box, keeps its minimum boom, and the near plane is unchanged.
//
// usage: DTA_URL=http://127.0.0.1:8978 node tools/shoot-look-up.mjs [baseUrl]
// Gate (exit 1 when any of these miss): up stop >= 50 deg, view pitch >= 50 deg, sky samples and
// guideway samples both present, pixel agreement >= 0.9.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || process.argv[2] || 'http://127.0.0.1:8978';
const OUT = process.env.LOOKUP_SHOT || 'proof/look-up.png';
const JSON_OUT = process.env.LOOKUP_JSON || 'proof/look-up.json';
const REPORT = process.env.LOOKUP_ONLY_JSON === '1'; // measurement only, no new capture
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** the guideway this proof is about: buildMrt() lays a 12 m deck 8.5 m wide */
const DECK_Y = 12;
const DECK_T = 1.1;
const DECK_HALF = 8.5 / 2;
/** how far up the frame must reach: the owner asked for "about +55 degrees" */
const MIN_UP_DEG = 50;
/** a frame that shows the deck must also show sky above it */
const MIN_SKY_SAMPLES = 0.08;
const MIN_DECK_SAMPLES = 0.06;
const MIN_AGREEMENT = 0.9;
/** the camera may not sit in a collider, and the near plane is part of the contract */
const NEAR_PLANE = 0.1;

for (const dir of new Set([path.dirname(OUT), path.dirname(JSON_OUT)])) fs.mkdirSync(dir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800'],
  defaultViewport: { width: 1280, height: 800 },
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

// ---------------------------------------------------------------- stance
// Stand on a pavement that the guideway crosses over: 9-16 m from its centreline, so the whole
// 8.5 m deck band sits in a 58 deg frame with the sky above its near edge. Pavement only exists
// along the arterial and ring ribbons, and the one the line follows is the only pavement whose
// own band is under the deck, so the good stances are where another arterial passes beneath it.
const stances = await page.evaluate((DECK_Y, DECK_T, DECK_HALF) => {
  const g = window.__game;
  const spine = g.city.mrtSpine || [];
  // nearest point on the guideway centreline: the stance aims at the FOOT of the perpendicular,
  // not at a spine vertex, so the deck is centred in the frame instead of running off to one side
  const nearestOnSpine = (x, z) => {
    let best = { d: Infinity, x: 0, z: 0 };
    for (let i = 1; i < spine.length; i++) {
      const [x1, z1] = spine[i - 1];
      const [x2, z2] = spine[i];
      const dx = x2 - x1;
      const dz = z2 - z1;
      const l2 = dx * dx + dz * dz || 1;
      let t = ((x - x1) * dx + (z - z1) * dz) / l2;
      t = Math.max(0, Math.min(1, t));
      const px = x1 + dx * t;
      const pz = z1 + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < best.d) best = { d, x: px, z: pz };
    }
    return best;
  };
  const out = [];
  for (let i = 0; i < spine.length; i++) {
    const [sx, sz] = spine[i];
    for (let ox = -44; ox <= 44; ox += 0.5) {
      for (let oz = -44; oz <= 44; oz += 0.5) {
        const r = Math.hypot(ox, oz);
        if (r < 8 || r > 30) continue; // cheap reject before the real distance
        const x = sx + ox;
        const z = sz + oz;
        if (!(g.city.pavementBand(x, z) > 0)) continue;
        const near0 = nearestOnSpine(x, z);
        const d = near0.d;
        if (d < 8.5 || d > 16) continue; // clear of the 4.25 m deck half-width, and not so far the deck drops out of frame
        const ground = g.city.groundHeightAt(x, z);
        const rise = ground + DECK_Y - DECK_T / 2 - (ground + 0.8); // underside above the camera eye
        const near = d - DECK_HALF;
        const far = d + DECK_HALF;
        if (near < 3.5) continue;
        const eNear = (Math.atan2(rise, near) * 180) / Math.PI; // near edge, the highest part of the deck
        const eFar = (Math.atan2(rise, far) * 180) / Math.PI; // far edge, the lowest part
        // frame at +55 deg with a 58 deg vertical fov covers 26..84 deg: keep the near edge under
        // 74 so 10 deg of sky sits above the deck, and the far edge above 34 so the soffit is in
        if (eNear > 74 || eFar < 34) continue;
        // yaw that points the view at the deck: the view direction is (-sin camYaw, -cos camYaw)
        out.push({
          i,
          d: +d.toFixed(2),
          x: +x.toFixed(2),
          z: +z.toFixed(2),
          ground: +ground.toFixed(2),
          deckX: +near0.x.toFixed(2),
          deckZ: +near0.z.toFixed(2),
          eNear: +eNear.toFixed(1),
          eFar: +eFar.toFixed(1),
          score: +(Math.min(eNear, 66) - Math.abs(eFar - 45) * 0.3).toFixed(2),
        });
      }
    }
  }
  out.sort((a, b) => b.score - a.score);
  return { best: out.slice(0, 8), total: out.length, spineLen: spine.length };
}, DECK_Y, DECK_T, DECK_HALF);
if (REPORT) console.log('STANCES', JSON.stringify(stances));
if (!stances.best?.length) throw new Error('no pavement stance near the guideway fits a 55 deg frame');

/** drag the touch look control to its stop: a finger travel of `dy` CSS px, up is negative */
async function touchDrag(dy) {
  return page.evaluate((dy) => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const x = W * 0.8;
    const y = H * 0.55;
    const opt = { pointerType: 'touch', pointerId: 7, bubbles: true, cancelable: true, clientX: x, clientY: y };
    window.dispatchEvent(new PointerEvent('pointerdown', opt));
    const steps = 30;
    for (let s = 1; s <= steps; s++) {
      window.dispatchEvent(
        new PointerEvent('pointermove', { ...opt, clientX: x, clientY: y + (dy * s) / steps })
      );
    }
    window.dispatchEvent(new PointerEvent('pointerup', { ...opt, clientY: y + dy }));
    return true;
  }, dy);
}

/** pointer-locked mousemove, if the headless browser grants the lock */
async function mouseDrag(dy) {
  return page.evaluate((dy) => {
    const locked = !!document.pointerLockElement;
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: dy, bubbles: true }));
    return locked;
  }, dy);
}

const pitchNow = () =>
  page.evaluate(() => {
    const g = window.__game;
    return +g.state.camPitch.toFixed(4);
  });

// ---------------------------------------------------------------- measure the stops
// Touch look goes up (finger travel negative), then all the way down, and the state is read back
// after the camera has consumed the deltas.
await touchDrag(-4000);
await sleep(500);
const upByTouch = await pitchNow();
await touchDrag(4000);
await sleep(500);
const downByTouch = await pitchNow();

// Desktop path: same two stops through pointer-locked mousemove. If the lock is refused the camera
// does not move at all and the touch numbers are the only input-driven ones, which the report says.
await touchDrag(-1); // nudge nothing, keep the control state clean
const lockGranted = await page.evaluate(() => !!document.pointerLockElement);
await mouseDrag(-4000);
await sleep(500);
const upByMouse = await pitchNow();
await mouseDrag(4000);
await sleep(500);
const downByMouse = await pitchNow();

const stops = {
  upByTouch,
  downByTouch,
  lockGranted,
  upByMouse,
  downByMouse,
  upTouchDeg: +((upByTouch * 180) / Math.PI).toFixed(1),
  downTouchDeg: +((downByTouch * 180) / Math.PI).toFixed(1),
  upMouseDeg: +((upByMouse * 180) / Math.PI).toFixed(1),
  downMouseDeg: +((downByMouse * 180) / Math.PI).toFixed(1),
};
console.log('STOPS', JSON.stringify(stops));

/** camera state + a ray grid classifying the frame: sky samples vs guideway samples */
async function frameReadback(stance) {
  return page.evaluate(
    (stance, DECK_Y, DECK_T, DECK_HALF) => {
      const g = window.__game;
      const THREE = g.THREE;
      const cam = g.camera;
      const dirV = new THREE.Vector3();
      cam.getWorldDirection(dirV);
      const p = g.player;
      // Sampling by geometry instead of by raycasting the whole scene: the guideway is a known
      // ribbon (its 11.45 m soffit plane bounds it), and everything that could block the view is
      // already published as a collider box. 300 rays against several thousand merged meshes is
      // minutes of SwiftShader; this is arithmetic.
      const rayT = (o, d, c) => {
        let tmin = 0;
        let tmax = 400;
        for (const axis of [['x', 'minX', 'maxX'], ['y', null, null], ['z', 'minZ', 'maxZ']]) {
          const k = axis[0];
          if (k === 'y') {
            // colliders stand on the street and stop at h
            if (Math.abs(d.y) < 1e-6) {
              if (o.y > c.h) return null;
              continue;
            }
            const t1 = (0 - o.y) / d.y;
            const t2 = (c.h - o.y) / d.y;
            tmin = Math.max(tmin, Math.min(t1, t2));
            tmax = Math.min(tmax, Math.max(t1, t2));
            continue;
          }
          if (Math.abs(d[k]) < 1e-6) {
            if (o[k] < c[axis[1]] || o[k] > c[axis[2]]) return null;
            continue;
          }
          const t1 = (c[axis[1]] - o[k]) / d[k];
          const t2 = (c[axis[2]] - o[k]) / d[k];
          tmin = Math.max(tmin, Math.min(t1, t2));
          tmax = Math.min(tmax, Math.max(t1, t2));
          if (tmin > tmax) return null;
        }
        return tmin > 0.01 ? tmin : null;
      };

      // The MRT deck as the builder laid it: each instance is a BoxGeometry(8.5, 1.1, span)
      // placed at its span midpoint, yawed along the line. Reading the planes off the built
      // instances beats assuming `ground + 12`, because a span is lifted to the AVERAGE ground of
      // its two ends, which on this terrain is up to a metre away from the pavement's height.
      const spans = [];
      g.scene.traverse((o) => {
        if (!o.isInstancedMesh) return;
        const prm = o.geometry && o.geometry.parameters;
        if (!prm) return;
        if (Math.abs((prm.width ?? 0) - DECK_HALF * 2) > 0.05 || Math.abs((prm.height ?? 0) - DECK_T) > 0.05) return;
        const m = new THREE.Matrix4();
        for (let i = 0; i < o.count; i++) {
          o.getMatrixAt(i, m);
          const pos = new THREE.Vector3();
          const quat = new THREE.Quaternion();
          const scl = new THREE.Vector3();
          m.decompose(pos, quat, scl);
          spans.push({ pos, inv: quat.clone().invert(), halfW: prm.width / 2, halfLen: scl.z / 2 });
        }
      });

      const NX = 21;
      const NY = 15;
      const samples = [];
      const o = cam.position;
      const local = new THREE.Vector3();
      for (let iy = 0; iy < NY; iy++) {
        for (let ix = 0; ix < NX; ix++) {
          const nx = -1 + ((ix + 0.5) / NX) * 2;
          const ny = -1 + ((iy + 0.5) / NY) * 2;
          const d = new THREE.Vector3(nx, ny, 0.5).unproject(cam).sub(o).normalize();
          let kind = 'sky';
          // the deck: where the ray crosses a span's soffit plane inside that span's footprint
          let tDeck = null;
          if (d.y > 1e-4) {
            for (const s of spans) {
              const t = (s.pos.y - DECK_T / 2 - o.y) / d.y;
              if (t <= 0.05 || (tDeck !== null && t >= tDeck)) continue;
              local.set(o.x + d.x * t - s.pos.x, 0, o.z + d.z * t - s.pos.z).applyQuaternion(s.inv);
              if (Math.abs(local.x) <= s.halfW && Math.abs(local.z) <= s.halfLen) tDeck = t;
            }
          }
          let tCol = null;
          for (const c of g.city.colliders) {
            const t = rayT(o, d, c);
            if (t !== null && (tCol === null || t < tCol)) tCol = t;
          }
          // the player's own body is in front of the camera and is not a collider
          const bodyBox = { minX: p.pos.x - 0.45, maxX: p.pos.x + 0.45, minZ: p.pos.z - 0.45, maxZ: p.pos.z + 0.45, h: p.y + 1.85 };
          const tBody = rayT(o, d, bodyBox);
          if (tBody !== null && (tCol === null || tBody < tCol)) tCol = tBody;
          if (tDeck !== null && (tCol === null || tDeck < tCol)) kind = 'deck';
          else if (tCol !== null) kind = 'other';
          // a ray pointing at or below the horizon lands on the street, the pavement or a hill:
          // that is geometry the collider list does not carry, and it is certainly not sky
          else if (d.y <= 0.03) kind = 'other';
          samples.push({ nx: +nx.toFixed(3), ny: +ny.toFixed(3), kind });
        }
      }

      // is the camera itself legal: above the street, outside every collider box, boom not collapsed
      const ground = g.city.groundHeightAt(cam.position.x, cam.position.z);
      let inside = null;
      for (const c of g.city.colliders) {
        if (cam.position.x > c.minX && cam.position.x < c.maxX && cam.position.z > c.minZ && cam.position.z < c.maxZ && cam.position.y < c.h) {
          inside = { minX: +c.minX.toFixed(1), maxX: +c.maxX.toFixed(1), minZ: +c.minZ.toFixed(1), maxZ: +c.maxZ.toFixed(1), h: c.h };
          break;
        }
      }
      return {
        camPitch: +g.state.camPitch.toFixed(4),
        camPitchDeg: +((g.state.camPitch * 180) / Math.PI).toFixed(1),
        viewPitchDeg: +((Math.asin(Math.max(-1, Math.min(1, dirV.y))) * 180) / Math.PI).toFixed(2),
        viewYawDeg: +((Math.atan2(dirV.x, dirV.z) * 180) / Math.PI).toFixed(1),
        camY: +cam.position.y.toFixed(2),
        camGroundGap: +(cam.position.y - ground).toFixed(2),
        camToPlayer: +cam.position.distanceTo(new THREE.Vector3(p.pos.x, p.y + 1.55, p.pos.z)).toFixed(2),
        near: cam.near,
        fov: cam.fov,
        deckSpans: spans.map((s) => +s.pos.y.toFixed(2)),
        deckSpanCount: spans.length,
        insideCollider: inside,
        samples,
        counts: {
          sky: samples.filter((s) => s.kind === 'sky').length,
          deck: samples.filter((s) => s.kind === 'deck').length,
          other: samples.filter((s) => s.kind === 'other').length,
        },
        skyHex: '#' + g.city.scene.background.getHexString(),
      };
    },
    stance,
    DECK_Y,
    DECK_T,
    DECK_HALF
  );
}

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
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

function pixelAt(png, px, py) {
  const x = Math.max(0, Math.min(png.width - 1, Math.round(px)));
  const y = Math.max(0, Math.min(png.height - 1, Math.round(py)));
  const i = y * png.width * png.channels + x * png.channels;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}

/**
 * The picture is measured, not the canvas: a headless screenshot can commit an empty buffer.
 *
 * Three frames are taken from the settled camera and compared:
 *   A  the proof frame
 *   B  the same frame with the MRT deck hidden  -> the pixels A has and B does not ARE the deck
 *   C  the same frame with every scene child hidden -> a pure background swatch, so the sky
 *      colour is read as rendered instead of assumed (the background is a Color, the compositor
 *      is the authority on what reaches the PNG)
 * A sample the geometry calls sky has to look like C; a sample it calls deck has to be inside
 * the region that disappears with the deck. Anything else is the picture disagreeing with the
 * scene, which is the failure mode this whole file exists to catch.
 */
function measure(pngA, pngB, pngC, readback) {
  const total = pngA.width * pngA.height;
  const skyRef = [0, 0, 0];
  for (let i = 0; i < total; i += 7) {
    for (let c = 0; c < 3; c++) skyRef[c] += pngC.data[i * pngC.channels + c];
  }
  const n = Math.ceil(total / 7);
  for (let c = 0; c < 3; c++) skyRef[c] = Math.round(skyRef[c] / n);

  const changed = (x, y) => {
    const i = y * pngA.width * pngA.channels + x * pngA.channels;
    const j = y * pngB.width * pngB.channels + x * pngB.channels;
    return (
      Math.abs(pngA.data[i] - pngB.data[j]) +
        Math.abs(pngA.data[i + 1] - pngB.data[j + 1]) +
        Math.abs(pngA.data[i + 2] - pngB.data[j + 2]) >
      22
    );
  };
  const isSkyRef = (rgb) =>
    Math.abs(rgb[0] - skyRef[0]) + Math.abs(rgb[1] - skyRef[1]) + Math.abs(rgb[2] - skyRef[2]) < 26;

  let luma = 0;
  for (let i = 0; i < total; i++) {
    luma += 0.2126 * pngA.data[i * pngA.channels] + 0.7152 * pngA.data[i * pngA.channels + 1] + 0.0722 * pngA.data[i * pngA.channels + 2];
  }
  // frame-level deck coverage: pixels the deck actually owns, independent of any sampling
  let deckFramePx = 0;
  for (let y = 0; y < pngA.height; y += 2) {
    for (let x = 0; x < pngA.width; x += 2) if (changed(x, y)) deckFramePx++;
  }
  const deckFrameShare = +((deckFramePx * 4) / total).toFixed(3);

  let agree = 0;
  let graded = 0;
  let skyPx = 0;
  let deckPx = 0;
  const wrong = [];
  for (const s of readback.samples) {
    const px = Math.round(((s.nx + 1) / 2) * (pngA.width - 1));
    const py = Math.round(((1 - s.ny) / 2) * (pngA.height - 1));
    const rgb = pixelAt(pngA, px, py);
    if (s.kind === 'sky') {
      graded++;
      if (isSkyRef(rgb) && !changed(px, py)) {
        agree++;
        skyPx++;
      } else if (wrong.length < 8) wrong.push({ ...s, got: rgb, deckChanged: changed(px, py) });
    } else if (s.kind === 'deck') {
      graded++;
      if (changed(px, py)) {
        agree++;
        deckPx++;
      } else if (wrong.length < 8) wrong.push({ ...s, got: rgb, deckChanged: false });
    }
  }
  return {
    width: pngA.width,
    height: pngA.height,
    meanLuma: +(luma / total).toFixed(1),
    skyRef: `rgb(${skyRef.join(',')})`,
    skySamples: readback.counts.sky,
    deckSamples: readback.counts.deck,
    otherSamples: readback.counts.other,
    skyShare: +(readback.counts.sky / readback.samples.length).toFixed(3),
    deckShare: +(readback.counts.deck / readback.samples.length).toFixed(3),
    deckFrameShare,
    agreement: graded ? +(agree / graded).toFixed(3) : 0,
    skyPixels: skyPx,
    deckPixels: deckPx,
    wrong,
  };
}

// ---------------------------------------------------------------- shoot
const HIDE_CHROME = () =>
  document.querySelectorAll('body > *:not(canvas)').forEach((el) => {
    el.style.display = 'none';
  });

const attempts = [];
let accepted = null;
for (const stance of stances.best) {
  await page.evaluate((s) => {
    const g = window.__game;
    g._test.teleport(s.x, s.z);
    g._test.face(s.deckX, s.deckZ);
  }, stance);
  await sleep(500);
  // climb with the same touch control the player uses, to the stop, then let the boom settle
  await touchDrag(-900);
  await sleep(1000);
  const readback = await frameReadback(stance);
  // HUD, hints, minimap and the touch chrome are furniture: the frame under test is the world
  await page.evaluate(HIDE_CHROME);
  await sleep(500);
  await page.screenshot({ path: OUT });
  const deckHidden = await page.evaluate(() => {
    const g = window.__game;
    const deck = [];
    g.scene.traverse((o) => {
      const prm = o.isInstancedMesh && o.geometry && o.geometry.parameters;
      if (prm && Math.abs((prm.width ?? 0) - 8.5) < 0.05 && Math.abs((prm.height ?? 0) - 1.1) < 0.05) deck.push(o);
    });
    deck.forEach((m) => { m.visible = false; });
    window.__deckMeshes = deck;
    return deck.length;
  });
  await sleep(700);
  await page.screenshot({ path: '/tmp/look-deck-hidden.png' });
  await page.evaluate(() => {
    window.__hidden = [];
    window.__game.scene.children.forEach((c) => {
      if (c.visible) { window.__hidden.push(c); c.visible = false; }
    });
  });
  await sleep(700);
  await page.screenshot({ path: '/tmp/look-sky-ref.png' });
  await page.evaluate(() => {
    window.__hidden.forEach((c) => { c.visible = true; });
    (window.__deckMeshes || []).forEach((m) => { m.visible = true; });
    window.__deckMeshes = null;
  });
  await sleep(300);
  const m = measure(
    decodePng(fs.readFileSync(OUT)),
    decodePng(fs.readFileSync('/tmp/look-deck-hidden.png')),
    decodePng(fs.readFileSync('/tmp/look-sky-ref.png')),
    readback
  );
  const ok =
    m.skyShare >= MIN_SKY_SAMPLES &&
    m.deckShare >= MIN_DECK_SAMPLES &&
    m.agreement >= MIN_AGREEMENT &&
    m.meanLuma >= 40 &&
    readback.viewPitchDeg >= MIN_UP_DEG;
  attempts.push({ stance, readback: { ...readback, samples: undefined }, measure: m, deckMeshes: deckHidden, ok });
  console.log(
    'ATTEMPT',
    JSON.stringify({
      d: stance.d,
      view: readback.viewPitchDeg,
      sky: m.skyShare,
      deck: m.deckShare,
      deckFrame: m.deckFrameShare,
      agree: m.agreement,
      luma: m.meanLuma,
      spans: deckHidden,
      ok,
      inside: readback.insideCollider,
    })
  );
  if (ok) {
    accepted = { stance, readback, measure: m };
    break;
  }
}

const gate = {
  upStopDeg: stops.upTouchDeg,
  upStopOk: Math.abs(stops.upTouchDeg) >= MIN_UP_DEG,
  touchMatchesMouse: !stops.lockGranted || Math.abs(stops.upTouchDeg - stops.upMouseDeg) < 0.6,
  viewPitchOk: !!accepted,
  nearOk: accepted ? accepted.readback.near === NEAR_PLANE : false,
  boomOk: accepted ? accepted.readback.camGroundGap >= 0 && !accepted.readback.insideCollider && accepted.readback.camToPlayer >= 2.3 : false,
};
const report = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  shot: OUT,
  stops,
  attempts: attempts.map((a) => ({ stance: a.stance, viewPitchDeg: a.readback.viewPitchDeg, camY: a.readback.camY, camGroundGap: a.readback.camGroundGap, near: a.readback.near, insideCollider: a.readback.insideCollider, measure: a.measure, ok: a.ok })),
  accepted: accepted ? { stance: accepted.stance, viewPitchDeg: accepted.readback.viewPitchDeg, camPitchDeg: accepted.readback.camPitchDeg, camY: accepted.readback.camY, camGroundGap: accepted.readback.camGroundGap, camToPlayer: accepted.readback.camToPlayer, near: accepted.readback.near, fov: accepted.readback.fov, counts: accepted.readback.counts, measure: accepted.measure } : null,
  gate,
  pageErrors,
};
fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
console.log('REPORT', JSON_OUT);
console.log('GATE', JSON.stringify(gate));
await browser.close();
const pass = gate.upStopOk && gate.touchMatchesMouse && gate.viewPitchOk && gate.nearOk && gate.boomOk;
console.log(pass ? 'LOOK-UP PASS' : 'LOOK-UP FAIL');
process.exit(pass ? 0 : 1);
