/**
 * Shop signage census, one city load.
 *
 * The card it exists for: half the enterable shops had no name board, and the boards that did exist
 * came from a sixteen-cell poster atlas, so a bengkel door could read "BAKSO PAK TJE". The third
 * complaint was the frontage rows: a fascia, shutters and a canopy, and no door instance, so
 * pressing E did nothing.
 *
 * Everything here is measured on the built scene, not read from the source, and the same file runs
 * against the commit before the fix as well as after it:
 *
 *   enterable   city.shopDoors.length
 *   boards      city.shopSigns.length (the fix); before it, the 4.4 x 0.9 board meshes
 *   unmarked    enterable doors with no plate within BOARD_REACH of the door
 *   mismatch    the plate a door owns must carry the room name its own kind resolves to
 *   buried      the door instance must stand on its facade's street face, not inside the building
 *   frontage    a spread of frontage facades: a shop archetype must have a door instance in its
 *               street face; a non-shop archetype must not carry shop styling (`fascia`)
 *   draw calls  renderer.info.render.calls, from one fixed stance so two builds compare
 *
 * Usage: DTA_URL=http://localhost:8951/index.html node tools/probe-shop-boards.mjs [--json out.json]
 */
import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CHROME = '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL = process.env.DTA_URL || 'http://localhost:8951/index.html';
const SHOT = process.env.SHOT || '';
const JSON_OUT = (() => {
  const i = process.argv.indexOf('--json');
  return i > 0 ? process.argv[i + 1] : '';
})();
const BOARD_REACH = 3.2;   // a plate hangs over its own door
const FACE_REACH = 1.2;    // a door stands on the street face, within 1.2 m of it
// The archetype list is only a fallback for builds that predate `facadeAudit.retail`; the audit's
// own flag is what the builder decided, and it is the one the census must read.
const RETAIL = new Set(['ruko', 'colonial', 'warung', 'midrise', 'walkup']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  defaultViewport: { width: 1280, height: 800 },
  protocolTimeout: 300000,
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 240000 });
await page.waitForFunction('window.__game !== undefined', { timeout: 180000 });
await sleep(1500);
await page.click('#start-btn');
await sleep(3500);

const census = await page.evaluate(({ BOARD_REACH, FACE_REACH, RETAIL_LIST }) => {
  const g = window.__game;
  const THREE = g.THREE;
  const city = g.city;
  const retail = new Set(RETAIL_LIST);

  // ---- door instances, in world space, as the player sees them
  const doors = city.doorMatrices.map((m) => {
    const v = new THREE.Vector3().setFromMatrixPosition(m);
    return { x: v.x, y: v.y, z: v.z };
  });

  // ---- plates: the recorded ones when the fix is in, else the old 4.4 x 0.9 board meshes
  const signs = [];
  const legacyBoards = [];
  if (Array.isArray(city.shopSigns)) {
    for (const s of city.shopSigns) signs.push({ x: s.x, y: s.y, z: s.z, name: s.name, kind: s.kind });
  } else {
    city.group.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh) return;
      const p = o.geometry && o.geometry.parameters;
      if (!p) return;
      if (Math.abs(p.width - 4.4) < 1e-6 && Math.abs(p.height - 0.9) < 1e-6) {
        legacyBoards.push({ x: o.position.x, y: o.position.y, z: o.position.z });
      }
    });
  }
  const boardPts = signs.length ? signs : legacyBoards;

  // ---- every enterable door: its own room's name, the plate nearest to it, and whether a door
  //      instance actually stands on that facade
  const roomName = {};
  for (const r of city.interiors) roomName[r.kind] = r.name;
  /**
   * The facade a door stands on: within its frontage width and on its street face, not simply the
   * nearest building centre. A door 15 m from the nearest audit row is a door whose own facade the
   * audit did not see, and calling that "buried 15 m deep" invents a defect.
   */
  const facadeOf = (x, z) => {
    let f = null;
    let score = 1e9;
    let nearby = 0;
    for (const a of city.facadeAudit) {
      if (Math.abs(a.x - x) > 30 || Math.abs(a.z - z) > 30) continue;
      const outX = -Math.sin(a.yaw);
      const outZ = -Math.cos(a.yaw);
      const tanX = Math.cos(a.yaw);
      const tanZ = -Math.sin(a.yaw);
      const along = (x - a.x) * tanX + (z - a.z) * tanZ;
      const outward = (x - a.x) * outX + (z - a.z) * outZ;
      nearby++;
      if (Math.abs(along) > a.w / 2 + 1.0) continue;
      const err = Math.abs(outward - a.d / 2);
      if (err < 1.6 && err < score) { score = err; f = a; }
    }
    return { f, nearby };
  };
  const shops = city.shopDoors.map((d, i) => {
    let best = null;
    let bd = 1e9;
    for (const b of boardPts) {
      const dist = Math.hypot(b.x - d.x, b.z - d.z);
      if (dist < bd) { bd = dist; best = b; }
    }
    // the marker stands 1.1 m outside the door; the door instance is one step back inward
    const { f, nearby } = facadeOf(d.x, d.z);
    let buried = null;
    if (f) {
      const outX = -Math.sin(f.yaw);
      const outZ = -Math.cos(f.yaw);
      const back = { x: d.x - outX * 1.1, z: d.z - outZ * 1.1 };
      let inst = null;
      let id = 1e9;
      for (const dd of doors) {
        const dist = Math.hypot(dd.x - back.x, dd.z - back.z);
        if (dist < id) { id = dist; inst = dd; }
      }
      if (inst) buried = +(f.d / 2 - ((inst.x - f.x) * outX + (inst.z - f.z) * outZ)).toFixed(2);
    }
    return {
      i,
      x: +d.x.toFixed(2),
      z: +d.z.toFixed(2),
      kind: d.kind,
      name: d.name,
      roomName: roomName[d.kind],
      archetype: f ? f.archetype : null,
      source: f ? f.source : null,
      facadeSeen: !!f,
      nearby,
      boardDist: +bd.toFixed(2),
      boardName: best && best.name !== undefined ? best.name : null,
      buried,
    };
  });
  const unmarked = shops.filter((s) => s.boardDist > BOARD_REACH);
  const marked = shops.filter((s) => s.boardDist <= BOARD_REACH);
  const mismatched = shops.filter((s) => s.boardName !== null && s.boardName !== s.roomName);
  const nameMismatch = shops.filter((s) => s.name !== s.roomName);
  const buriedDoors = shops.filter((s) => s.buried !== null && s.buried > 0.3);

  const spread = (list, n) => {
    const out = [];
    if (!list.length) return out;
    const stride = Math.max(1, Math.floor(list.length / n));
    for (let k = 0; k < n && k * stride < list.length; k++) out.push(list[k * stride]);
    return out;
  };
  const sample20 = spread([...marked].sort((a, b) => (a.z - b.z) || (a.x - b.x)), 20).map((s) => ({
    x: s.x,
    z: s.z,
    kind: s.kind,
    roomName: s.roomName,
    boardName: s.boardName,
    ok: s.boardName === s.roomName,
    boardDist: s.boardDist,
  }));

  // ---- frontage facades, in their own frame: a shop needs a door instance on its street face.
  // The published scene calls a lot a shop when it got one (`facadeAudit[i].shop`); the commit
  // before this fix has no such field, so the archetype's own contract is the fallback and the
  // "styled but not a shop" column is reported as unknown rather than invented.
  const hasShopFlag = city.facadeAudit.length > 0 && 'shop' in city.facadeAudit[0];
  const frontage = city.facadeAudit.map((f, i) => ({ ...f, i })).filter((f) => f.source === 'frontage');
  const frontRows = frontage.map((f) => {
    const outX = -Math.sin(f.yaw);
    const outZ = -Math.cos(f.yaw);
    const tanX = Math.cos(f.yaw);
    const tanZ = -Math.sin(f.yaw);
    const fx = f.x + outX * (f.d / 2);
    const fz = f.z + outZ * (f.d / 2);
    let doorOnFace = false;
    let bestOut = 1e9;
    for (const d of doors) {
      const rx = d.x - f.x;
      const rz = d.z - f.z;
      const along = rx * tanX + rz * tanZ;
      const outward = rx * outX + rz * outZ;
      if (Math.abs(along) <= f.w / 2 && Math.abs(outward - f.d / 2) <= FACE_REACH) {
        doorOnFace = true;
        bestOut = Math.min(bestOut, Math.abs(outward - f.d / 2));
      }
    }
    return {
      i: f.i,
      archetype: f.archetype,
      // the archetype's own contract, and what the lot actually got
      retail: hasShopFlag ? !!f.retail : retail.has(f.archetype),
      shop: hasShopFlag ? !!f.shop : retail.has(f.archetype),
      fascia: hasShopFlag ? !!f.shop : null,
      x: +f.x.toFixed(2),
      z: +f.z.toFixed(2),
      faceX: +fx.toFixed(2),
      faceZ: +fz.toFixed(2),
      hasDoor: doorOnFace,
      doorGap: bestOut === 1e9 ? null : +bestOut.toFixed(2),
    };
  });
  const shopRows = frontRows.filter((f) => f.retail);
  const plainRows = frontRows.filter((f) => !f.retail);
  const frontageSample = spread([...shopRows].sort((a, b) => (a.z - b.z) || (a.x - b.x)), 30).map((f) => ({
    archetype: f.archetype,
    x: f.x,
    z: f.z,
    hasDoor: f.hasDoor,
    doorGap: f.doorGap,
  }));

  // ---- draw calls from a fixed stance, and the same frame again with the shop signage hidden.
  // Two builds on two random city loads cannot be compared by their total call count alone (the
  // visible set of blocks moves the number by hundreds); the signage delta on ONE load can.
  const scene = g.scene;
  const prev = { x: g.player.pos.x, z: g.player.pos.z };
  g._test.teleport(0, 40);
  g._test.face(0, 0);
  const sample = () => {
    const c = [];
    const t = [];
    for (let i = 0; i < 5; i++) {
      g.renderer.render(scene, g.camera);
      c.push(g.renderer.info.render.calls);
      t.push(g.renderer.info.render.triangles);
    }
    c.sort((a, b) => a - b);
    t.sort((a, b) => a - b);
    return { calls: c[2], tris: t[2] };
  };
  const full = sample();
  // every mesh that exists only because of shop signage: the old 4.4 x 0.9 boards and 2 m mats,
  // or the merged plate and mat meshes that replaced them
  const signMeshes = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    if (o.name === 'facade-detail:shopname' || o.name === 'shop-mats') signMeshes.push(o);
  });
  if (!signMeshes.length) {
    scene.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh) return;
      const p = o.geometry && o.geometry.parameters;
      if (!p) return;
      if ((Math.abs(p.width - 4.4) < 1e-6 && Math.abs(p.height - 0.9) < 1e-6) ||
          (Math.abs(p.width - 2.0) < 1e-6 && Math.abs(p.height - 0.04) < 1e-6)) signMeshes.push(o);
    });
  }
  // The frame above sees only a few blocks, so "how many signage calls are in this view" depends
  // on where the player happens to stand. Price it on the block that carries the most signage:
  // that number is what every visible shop block costs, and it is the same measurement on both
  // builds instead of a lottery.
  let busiest = null;
  for (const b of city.blockGroups) {
    let n = 0;
    for (const m of signMeshes) {
      let o = m;
      while (o && o !== b.group) o = o.parent;
      if (o === b.group) n++;
    }
    if (!busiest || n > busiest.n) busiest = { n, b };
  }
  let blockSignCalls = null;
  if (busiest && busiest.n) {
    // one stance, two renders: the only difference between them is the shop signage
    g._test.teleport(busiest.b.x, busiest.b.z + 42);
    busiest.b.group.visible = true;
    g.camera.position.set(busiest.b.x, 30, busiest.b.z + 42);
    g.camera.updateMatrixWorld(true);
    g.camera.lookAt(busiest.b.x, 2, busiest.b.z);
    g.camera.updateMatrixWorld(true);
    const withSigns = sample();
    const vis = signMeshes.map((m) => m.visible);
    for (const m of signMeshes) m.visible = false;
    const noSigns = sample();
    for (let i = 0; i < signMeshes.length; i++) signMeshes[i].visible = vis[i];
    blockSignCalls = {
      blockMeshes: busiest.n,
      frameCalls: withSigns.calls,
      signCalls: withSigns.calls - noSigns.calls,
    };
  }
  g._test.teleport(prev.x, prev.z);
  const vis2 = signMeshes.map((m) => m.visible);
  for (const m of signMeshes) m.visible = false;
  const without = sample();
  for (let i = 0; i < signMeshes.length; i++) signMeshes[i].visible = vis2[i];
  const calls = [full.calls];
  const tris = [full.tris];
  g._test.teleport(prev.x, prev.z);

  return {
    enterable: city.shopDoors.length,
    doors: doors.length,
    boards: boardPts.length,
    legacyBoards: legacyBoards.length,
    signsRecorded: signs.length,
    unmarked: unmarked.length,
    unmarkedSample: unmarked.slice(0, 8),
    mismatched: mismatched.length,
    mismatchSample: mismatched.slice(0, 8),
    doorNameMismatch: nameMismatch.length,
    buriedDoors: buriedDoors.length,
    buriedWorst: buriedDoors.reduce((a, s) => Math.max(a, s.buried), 0),
    sample20,
    sample20Ok: sample20.filter((s) => s.ok).length,
    frontage: {
      total: frontRows.length,
      shop: shopRows.length,
      shopWithDoor: shopRows.filter((f) => f.hasDoor).length,
      shopPlated: shopRows.filter((f) => f.fascia).length,
      plain: plainRows.length,
      plainWithShopStyling: hasShopFlag ? plainRows.filter((f) => f.fascia).length : null,
      sample30: frontageSample,
      sample30Ok: frontageSample.filter((f) => f.hasDoor).length,
    },
    drawCalls: calls[0],
    triangles: tris[0],
    signMeshes: signMeshes.length,
    signCalls: full.calls - without.calls,
    signBlock: blockSignCalls,
    facadeCount: city.facadeAudit.length,
  };
}, { BOARD_REACH, FACE_REACH, RETAIL_LIST: [...RETAIL] });

const out = { url: URL, at: new Date().toISOString(), errors, ...census };
console.log(JSON.stringify({
  enterable: out.enterable,
  boards: out.boards,
  unmarked: out.unmarked,
  mismatched: out.mismatched,
  buriedDoors: out.buriedDoors,
  buriedWorst: out.buriedWorst,
  sample20Ok: `${out.sample20Ok}/20`,
  frontageShop: out.frontage.shop,
  frontageShopWithDoor: out.frontage.shopWithDoor,
  frontageSample30Ok: `${out.frontage.sample30Ok}/30`,
  plainFrontage: out.frontage.plain,
  plainFrontageWithShopStyling: out.frontage.plainWithShopStyling,
  drawCalls: out.drawCalls,
  signMeshes: out.signMeshes,
  signCalls: out.signCalls,
  signBlock: out.signBlock,
  triangles: out.triangles,
  errors: out.errors.length,
}, null, 2));

if (SHOT) {
  fs.mkdirSync(SHOT.replace(/\/[^/]+$/, ''), { recursive: true });
  await page.screenshot({ path: SHOT });
  console.log(`shot ${SHOT}`);
}
if (JSON_OUT) {
  fs.mkdirSync(JSON_OUT.replace(/\/[^/]+$/, ''), { recursive: true });
  fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  console.log(`json ${JSON_OUT}`);
}
if (out.unmarked > 0 || out.mismatched > 0 || out.buriedDoors > 0 || out.frontage.shopWithDoor < out.frontage.shop) {
  console.log('FAIL');
  process.exitCode = 2;
}
await browser.close();
