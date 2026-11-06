// Proof frame for card t_accfc928: the Blok M terminal and a pos ronda, seen from the street at
// eye height, with the level claim measured rather than eyeballed.
//
// Two owner reports produced this shot: "terminal blok m dan pos ronda miring" (both stood tilted)
// and "terminal blok m masih di tengah jalan" (the apron stood in the roadway). The picture is the
// artifact; the numbers beside it are the claim:
//
//   - the group's rotation is asserted to be exactly zero on X and Z (yaw is allowed),
//   - the apron top's four corners are asserted to sit on one plane, in world space,
//   - the apron's footprint is asserted to miss every carriageway in the map,
//   - the frame itself is verified: the subject has to be in frame, huge enough to read, and it has
//     to be what changed the pixels when it is taken out, with a drift control beside it, so an
//     empty or occluded frame cannot pass as proof.
//
// usage: node tools/shoot-terminal-level.mjs [baseUrl]
//   OUT (default screenshots/proof)   PREFIX (default terminal-level)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || process.argv[2] || 'http://127.0.0.1:8765';
const OUT = process.env.OUT || 'screenshots/proof';
const PREFIX = process.env.PREFIX || 'terminal-level';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  defaultViewport: { width: 1500, height: 950 },
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 240000 });
  await page.waitForFunction('window.__game !== undefined', { timeout: 180000 });
  await sleep(1200);
  await page.click('#start-btn');
  await page.waitForFunction(() => window.__game.state.started === true, { timeout: 60000 }).catch(() => {});
  await sleep(1800);

  const setup = await page.evaluate(() => {
    const g = window.__game;
    const THREE = g.THREE;
    const city = g.city;
    const W = g.renderer.domElement.width;
    const H = g.renderer.domElement.height;
    const hud = document.getElementById('hud');
    if (hud) hud.style.display = 'none';
    g._test.cinematic(true); // the follow camera must not take the frame back

    const distToPath = (x, z, path) => {
      let best = Infinity;
      for (let i = 1; i < path.length; i++) {
        const [x1, z1] = path[i - 1];
        const [x2, z2] = path[i];
        const dx = x2 - x1, dz = z2 - z1;
        const len2 = dx * dx + dz * dz || 1;
        let t = ((x - x1) * dx + (z - z1) * dz) / len2;
        t = Math.max(0, Math.min(1, t));
        best = Math.min(best, Math.hypot(x - (x1 + dx * t), z - (z1 + dz * t)));
      }
      return best;
    };
    const worldTilt = (o) => {
      o.updateWorldMatrix(true, false);
      const m = o.matrixWorld.elements;
      const l = Math.hypot(m[4], m[5], m[6]) || 1;
      return (Math.acos(Math.min(1, Math.max(-1, m[5] / l))) * 180) / Math.PI;
    };

    const audit = city.propAudit || [];
    const term = audit.find((a) => a.name === 'terminal');
    const group = city.group.getObjectByName('terminal');
    if (!term || !group) throw new Error('the terminal is not in the scene');
    const yaw = group.rotation.y;
    const f = { x: Math.sin(yaw), z: Math.cos(yaw) };   // apron / street side, local +Z
    const n = { x: f.z, z: -f.x };                     // local +X
    const WIDTH = 48, DEPTH = 32;
    const apronTop = group.position.y + (term.top ?? 0.22);
    const local = (lx, ly, lz) => new THREE.Vector3(lx, ly, lz).applyMatrix4(group.matrixWorld);

    // clearance of the whole footprint from every carriageway edge
    let clearance = Infinity, clearanceRoad = null;
    for (let i = 0; i <= 24; i++) {
      for (let k = 0; k <= 24; k++) {
        const lx = -WIDTH / 2 + (WIDTH * i) / 24, lz = -DEPTH / 2 + (DEPTH * k) / 24;
        const p = local(lx, 0, lz);
        for (const r of city.roads || []) {
          const c = distToPath(p.x, p.z, r.path) - r.width / 2;
          if (c < clearance) { clearance = c; clearanceRoad = r.name; }
        }
      }
    }
    // the apron top against the ground under it
    let poke = -Infinity, hang = -Infinity;
    for (let i = 0; i <= 12; i++) {
      for (let k = 0; k <= 12; k++) {
        const lx = -WIDTH / 2 + (WIDTH * i) / 12, lz = -DEPTH / 2 + (DEPTH * k) / 12;
        const p = local(lx, 0, lz);
        const gy = city.groundHeightAt(p.x, p.z);
        poke = Math.max(poke, gy - apronTop);
        hang = Math.max(hang, apronTop - gy);
      }
    }
    const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => local((sx * WIDTH) / 2, (term.top ?? 0.22), (sz * DEPTH) / 2).y);
    const geometry = {
      at: [+term.x.toFixed(2), +term.z.toFixed(2)],
      yaw: +yaw.toFixed(4),
      rotX: group.rotation.x,
      rotZ: group.rotation.z,
      worldTiltDeg: +worldTilt(group).toFixed(4),
      apronPlaneSpread: +(Math.max(...corners) - Math.min(...corners)).toFixed(6),
      clearance: +clearance.toFixed(2),
      clearanceRoad,
      groundPoke: +poke.toFixed(3),
      apronHang: +hang.toFixed(3),
      access: city.terminalAccess ? {
        length: +Math.hypot(city.terminalAccess.path[1][0] - city.terminalAccess.path[0][0], city.terminalAccess.path[1][1] - city.terminalAccess.path[0][1]).toFixed(1),
        startKerbGap: (() => {
          let b = Infinity;
          for (const r of city.roads || []) b = Math.min(b, distToPath(city.terminalAccess.path[0][0], city.terminalAccess.path[0][1], r.path) - r.width / 2);
          return +b.toFixed(2);
        })(),
      } : null,
      rondas: audit.filter((a) => a.name === 'pos-ronda').map((a) => {
        const o = city.group.children.find((c) => Math.abs(c.position.x - a.x) < 0.01 && Math.abs(c.position.z - a.z) < 0.01);
        return o ? { at: [+a.x.toFixed(1), +a.z.toFixed(1)], rotX: o.rotation.x, rotZ: o.rotation.z, tiltDeg: +worldTilt(o).toFixed(3) } : null;
      }).filter(Boolean),
    };

    // the camera: out on the apron side at eye height, standing on the ground, with a clear line
    const blocked = (x, y, z) =>
      city.colliders.some((c) => x > c.minX - 0.6 && x < c.maxX + 0.6 && z > c.minZ - 0.6 && z < c.maxZ + 0.6 && y < (c.h ?? 3));
    const cam = g.camera;
    const project = (v) => {
      const p = v.clone().project(cam);
      return { x: Math.round((p.x * 0.5 + 0.5) * W), y: Math.round((-p.y * 0.5 + 0.5) * H), behind: p.z > 1 };
    };
    const aims = [local(0, 2.2, 0), local(0, 4.4, -7.4), local(-20, 0.4, 14), local(20, 0.4, 14)];
    const clearSight = (cx, cy, cz) =>
      aims.every((aim) => {
        for (let i = 1; i <= 30; i++) {
          const t = i / 31;
          if (blocked(cx + (aim.x - cx) * t, cy + (aim.y - cy) * t, cz + (aim.z - cz) * t)) return false;
        }
        return true;
      });
    // the points the frame must hold: the apron's four corners, the canopy, the gantry board
    const framePoints = [local(-22, 0.25, 13), local(22, 0.25, 13), local(-22, 0.25, -13), local(22, 0.25, -13), local(0, 5.2, -7.4), local(0, 7.2, -6.2)];
    let view = null;
    const rejected = [];
    for (const dist of [30, 34, 38, 43, 48]) {
      for (const off of [0, 0.3, -0.3, 0.55, -0.55, 0.8, -0.8]) {
        if (view) break;
        const dx = f.x * Math.cos(off) + n.x * Math.sin(off);
        const dz = f.z * Math.cos(off) + n.z * Math.sin(off);
        const cx = term.x + dx * dist, cz = term.z + dz * dist;
        const cy = city.groundHeightAt(cx, cz) + 1.7;
        if (blocked(cx, cy, cz)) { rejected.push([dist, off, 'inside a collider']); continue; }
        if (!clearSight(cx, cy, cz)) { rejected.push([dist, off, 'sight line blocked']); continue; }
        cam.fov = 52;
        cam.updateProjectionMatrix();
        cam.position.set(cx, cy, cz);
        cam.lookAt(local(0, 3.4, -6));
        cam.updateMatrixWorld();
        cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
        const pts = framePoints.map(project);
        const m = 26;
        const inside = pts.every((p) => !p.behind && p.x > m && p.x < W - m && p.y > m && p.y < H - m);
        if (!inside) { rejected.push([dist, off, 'not framed']); continue; }
        const px = pts.map((p) => p.x), py = pts.map((p) => p.y);
        const area = ((Math.max(...px) - Math.min(...px)) * (Math.max(...py) - Math.min(...py))) / (W * H);
        if (area < 0.18) { rejected.push([dist, off, `too small ${area.toFixed(2)}`]); continue; }
        view = { camera: [+cx.toFixed(2), +cy.toFixed(2), +cz.toFixed(2)], dist, off, fov: 52, area: +area.toFixed(2) };
      }
    }
    if (!view) throw new Error(`no camera with a clean line to the terminal: ${JSON.stringify(rejected.slice(0, 8))}`);

    // the shot: hold the render, grab the framebuffer with the terminal in, then with it collapsed
    const grab = () => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      ctx.drawImage(g.renderer.domElement, 0, 0);
      return ctx.getImageData(0, 0, W, H).data;
    };
    const shoot = () => {
      cam.position.set(...view.camera);
      cam.fov = view.fov;
      cam.updateProjectionMatrix();
      cam.lookAt(local(0, 3.4, -6));
      cam.updateMatrixWorld();
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
      g.renderer.render(g.scene, cam);
      return grab();
    };
    const withSubject = shoot();
    const drift = shoot();                       // control: nothing changed between these two
    const savedScale = group.scale.clone();
    group.scale.set(0, 0, 0);                    // collapse, because the loop rewrites visibility
    const without = shoot();
    group.scale.copy(savedScale);
    shoot();
    const diff = (a, b) => {
      let changed = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (Math.abs(a[i] - b[i]) > 12 || Math.abs(a[i + 1] - b[i + 1]) > 12 || Math.abs(a[i + 2] - b[i + 2]) > 12) changed++;
      }
      return changed;
    };
    const total = W * H;
    const subject = diff(withSubject, without) / total;
    const noise = diff(withSubject, drift) / total;
    shoot();
    return { geometry, view, rejected: rejected.slice(0, 6), presence: +subject.toFixed(4), drift: +noise.toFixed(4), frame: [W, H] };
  });

  console.log('GEOMETRY', JSON.stringify(setup.geometry));
  console.log('CAMERA', JSON.stringify(setup.view));
  console.log('FRAME', JSON.stringify({ presence: setup.presence, drift: setup.drift, px: setup.frame }));

  const failures = [];
  const want = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${JSON.stringify(detail)}`);
    if (!ok) failures.push(name);
  };
  const geo = setup.geometry;
  want('terminal rotation is zero on X and Z', geo.rotX === 0 && geo.rotZ === 0, { rotX: geo.rotX, rotZ: geo.rotZ, yaw: geo.yaw });
  want('terminal stands level in world space', geo.worldTiltDeg < 0.01, geo.worldTiltDeg);
  want('the apron top is one plane', geo.apronPlaneSpread < 1e-6, geo.apronPlaneSpread);
  want('the apron clears every carriageway', geo.clearance > 0, { clearance: geo.clearance, road: geo.clearanceRoad });
  want('no ground rises through the apron', geo.groundPoke <= 0, geo.groundPoke);
  want('the apron is seated, not hanging past its skirt', geo.apronHang <= 0.75, geo.apronHang);
  want('the terminal has an access run to the kerb', !!geo.access && Math.abs(geo.access.startKerbGap) <= 1.5, geo.access);
  want('every pos ronda is level', geo.rondas.length > 0 && geo.rondas.every((r) => r.rotX === 0 && r.rotZ === 0 && r.tiltDeg < 0.01), geo.rondas);
  want('the frame is not empty', setup.presence >= 0.06, setup.presence);
  want('the frame changed because of the subject, not the scene', setup.drift <= 0.01 && setup.drift <= setup.presence / 4, { drift: setup.drift, presence: setup.presence });
  want('the page threw nothing', errors.length === 0, errors.slice(0, 3));

  const terminalShot = `${OUT}/${PREFIX}.png`;
  await page.evaluate(
    (view) => {
      const g = window.__game;
      const cam = g.camera;
      const group = g.city.group.getObjectByName('terminal');
      cam.fov = view.fov;
      cam.updateProjectionMatrix();
      cam.position.set(...view.camera);
      const aim = new g.THREE.Vector3(0, 3.2, -6).applyMatrix4(group.matrixWorld);
      cam.lookAt(aim);
      cam.updateMatrixWorld();
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
      g.renderer.render(g.scene, cam);
    },
    setup.view
  );
  await sleep(250);
  await page.screenshot({ path: terminalShot });
  console.log('SHOT', terminalShot);

  // the second half of the report: a pos ronda, shot the same way
  const ronda = await page.evaluate(() => {
    const g = window.__game;
    const THREE = g.THREE;
    const city = g.city;
    const W = g.renderer.domElement.width, H = g.renderer.domElement.height;
    const audit = (city.propAudit || []).filter((a) => a.name === 'pos-ronda');
    if (!audit.length) return null;
    const worldTilt = (o) => {
      o.updateWorldMatrix(true, false);
      const m = o.matrixWorld.elements;
      const l = Math.hypot(m[4], m[5], m[6]) || 1;
      return (Math.acos(Math.min(1, Math.max(-1, m[5] / l))) * 180) / Math.PI;
    };
    const cam = g.camera;
    let picked = null;
    for (const a of audit) {
      const o = city.group.children.find((c) => Math.abs(c.position.x - a.x) < 0.01 && Math.abs(c.position.z - a.z) < 0.01);
      if (!o || !o.isGroup) continue;   // the placed huts are groups; the dressing hut is loose meshes
      const yaw = o.rotation.y;
      const f = { x: Math.sin(yaw), z: Math.cos(yaw) };
      const blocked = (x, y, z) => city.colliders.some((c) => x > c.minX - 0.4 && x < c.maxX + 0.4 && z > c.minZ - 0.4 && z < c.maxZ + 0.4 && y < (c.h ?? 3));
      for (const dist of [6.5, 7.5, 8.5]) {
        for (const lat of [0, 0.5, -0.5, 0.9, -0.9]) {
          if (picked) break;
          const cx = a.x + (f.x * Math.cos(lat) + f.z * Math.sin(lat)) * dist;
          const cz = a.z + (f.z * Math.cos(lat) - f.x * Math.sin(lat)) * dist;
          const cy = city.groundHeightAt(cx, cz) + 1.62;
          if (blocked(cx, cy, cz)) continue;
          cam.fov = 40;
          cam.updateProjectionMatrix();
          cam.position.set(cx, cy, cz);
          cam.lookAt(new THREE.Vector3(a.x, o.position.y + 1.1, a.z));
          cam.updateMatrixWorld();
          cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
          const pts = [new THREE.Vector3(a.x, o.position.y, a.z), new THREE.Vector3(a.x, o.position.y + 2.7, a.z)].map((v) => {
            const p = v.clone().project(cam);
            return { x: (p.x * 0.5 + 0.5) * W, y: (-p.y * 0.5 + 0.5) * H };
          });
          const tall = Math.abs(pts[1].y - pts[0].y);
          if (tall < H * 0.25) continue;
          if (Math.min(...pts.map((p) => Math.min(p.x, W - p.x, p.y, H - p.y))) < 20) continue;
          picked = { at: [+a.x.toFixed(1), +a.z.toFixed(1)], camera: [+cx.toFixed(2), +cy.toFixed(2), +cz.toFixed(2)], fov: 40, heightPx: Math.round(tall), rotX: o.rotation.x, rotZ: o.rotation.z, tiltDeg: +worldTilt(o).toFixed(3) };
        }
      }
      if (picked) { picked.index = audit.indexOf(a); break; }
    }
    if (!picked) return null;
    const grab = () => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      ctx.drawImage(g.renderer.domElement, 0, 0);
      return ctx.getImageData(0, 0, W, H).data;
    };
    const shoot = () => {
      cam.position.set(...picked.camera);
      cam.fov = picked.fov;
      cam.updateProjectionMatrix();
      cam.lookAt(new THREE.Vector3(picked.at[0], 0, picked.at[1]));
      cam.updateMatrixWorld();
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
      g.renderer.render(g.scene, cam);
      return grab();
    };
    // frame the hut properly, then measure its own contribution
    const o = city.group.children.find((c) => Math.abs(c.position.x - picked.at[0]) < 0.2 && Math.abs(c.position.z - picked.at[1]) < 0.2);
    shoot();
    const withHut = grab();
    const drift = grab();
    const saved = o.scale.clone();
    o.scale.set(0, 0, 0);
    const without = shoot();
    o.scale.copy(saved);
    cam.lookAt(new THREE.Vector3(picked.at[0], o.position.y + 1.1, picked.at[1]));
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    g.renderer.render(g.scene, cam);
    const diff = (a, b) => {
      let n = 0;
      for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 12 || Math.abs(a[i + 1] - b[i + 1]) > 12 || Math.abs(a[i + 2] - b[i + 2]) > 12) n++;
      return n;
    };
    return { ...picked, presence: +(diff(withHut, without) / (W * H)).toFixed(4), drift: +(diff(withHut, drift) / (W * H)).toFixed(4) };
  });

  console.log('RONDA', JSON.stringify(ronda));
  if (ronda) {
    want('pos ronda rotation is zero on X and Z', ronda.rotX === 0 && ronda.rotZ === 0, { rotX: ronda.rotX, rotZ: ronda.rotZ });
    want('pos ronda stands level in world space', ronda.tiltDeg < 0.01, ronda.tiltDeg);
    want('the pos ronda frame is not empty', ronda.presence >= 0.04, ronda.presence);
    await page.evaluate(
      (r) => {
        const g = window.__game;
        const cam = g.camera;
        cam.fov = r.fov;
        cam.updateProjectionMatrix();
        cam.position.set(...r.camera);
        cam.lookAt(new g.THREE.Vector3(r.at[0], 0, r.at[1]));
        cam.updateMatrixWorld();
        cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
        g.renderer.render(g.scene, cam);
      },
      ronda
    );
    await sleep(250);
    // the aim above is at ground level, so re-centre on the hut's middle for the saved frame
    await page.evaluate(
      (r) => {
        const g = window.__game;
        const cam = g.camera;
        const o = g.city.group.children.find((c) => Math.abs(c.position.x - r.at[0]) < 0.2 && Math.abs(c.position.z - r.at[1]) < 0.2);
        cam.lookAt(new g.THREE.Vector3(r.at[0], o.position.y + 1.15, r.at[1]));
        cam.updateMatrixWorld();
        cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
        g.renderer.render(g.scene, cam);
      },
      ronda
    );
    await sleep(250);
    await page.screenshot({ path: `${OUT}/${PREFIX}-ronda.png` });
    console.log('SHOT', `${OUT}/${PREFIX}-ronda.png`);
  } else {
    want('a pos ronda was found to photograph', false, null);
  }

  console.log('SUMMARY', JSON.stringify({ pass: failures.length === 0 ? 'PASS' : 'FAIL', failures }));
  await browser.close();
  if (failures.length) process.exit(1);
} catch (e) {
  console.error('FAIL', e.message);
  await browser.close();
  process.exit(1);
}
