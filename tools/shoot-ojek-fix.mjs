// Proof shot for the ojek bodywork and its tyre contact: a side and a rear close-up of a bike on
// the street it is parked on, plus the measured distance between each tyre and the surface under
// it.
//
// Two things this harness refuses to guess at:
//   - the contact. It raycasts down onto the built scene under each wheel (the bike's own meshes
//     excluded) because `city.groundHeightAt` is an analytic height while what a player sees is the
//     terrain mesh; quoting only the analytic number can call a floating bike grounded. Each tyre
//     is measured against its own lowest point, because the city now pitches a parked bike to the
//     grade between its axles so both treads touch: one whole-bike minimum cannot describe that.
//   - the camera. A close-up is useless if a warung counter or a lamp post stands between the lens
//     and the bike, or if a wall two metres behind the subject fills the frame, so every candidate
//     placement is tested against `city.colliders` and for a framed silhouette before it is used.
//
// usage: node tools/shoot-ojek-fix.mjs [baseUrl]
//   OUT (default screenshots/proof)   OJEK_PREFIX (default ojek-fix)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || process.argv[2] || 'http://127.0.0.1:8765';
const OUT = process.env.OUT || 'screenshots/proof';
const PREFIX = process.env.OJEK_PREFIX || 'ojek-fix';
/**
 * A tread more than MAX_FLOAT above the surface is a bike in the air. A tread BELOW it is not a
 * float: `city.groundHeightAt` is the analytic terrain, while the terrain mesh interpolates between
 * its vertices and can sit ~4 cm above that line, so a parked tyre reads as a couple of centimetres
 * into the asphalt on a slope. Sinking past MAX_SINK is still a placement error (a wheel buried in
 * the kerb), but a small sink is the tyre touching.
 */
const MAX_FLOAT = 0.02;
const MAX_SINK = 0.08;
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
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
  });
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__game !== undefined', { timeout: 60000 });
  await sleep(1200);
  await page.click('#start-btn');
  await page.waitForFunction(() => window.__game.state.started === true, { timeout: 30000 }).catch(() => {});
  await sleep(1800);

  const plan = await page.evaluate(() => {
    const g = window.__game;
    const THREE = g.THREE;
    const city = g.city;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const hud = document.getElementById('hud');
    if (hud) hud.style.display = 'none'; // a clean frame: the HUD would sit over the bike
    g._test.cinematic(true); // stop the follow camera from taking the frame back

    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    const inBike = (obj, root) => {
      let o = obj;
      while (o) {
        if (o === root) return true;
        o = o.parent;
      }
      return false;
    };
    const surfaceAt = (x, z, root, fromY) => {
      ray.set(new THREE.Vector3(x, fromY, z), down);
      ray.far = 20;
      const hit = ray.intersectObject(g.scene, true).filter((h) => !inBike(h.object, root))[0];
      return hit ? hit.point.y : null;
    };

    const bikes = (city.ojeks || []).map((entry, i) => {
      const root = entry.group;
      // wheel pivots are the two child groups sitting off-centre on the wheelbase
      const pivots = root.children.filter((c) => c.isGroup && Math.abs(c.position.z) > 0.3);
      const wheels = pivots.map((pivot) => {
        const wp = new THREE.Vector3();
        pivot.getWorldPosition(wp);
        // THIS tyre's own lowest point, not the whole bike's: a machine pitched to the grade has
        // two different contact heights, and the whole-bike minimum can only describe one of them
        const tread = new THREE.Box3().setFromObject(pivot).min.y;
        const surface = surfaceAt(wp.x, wp.z, root, wp.y + 2);
        return {
          z: +pivot.position.z.toFixed(3),
          contactY: +tread.toFixed(4),
          surfaceY: surface === null ? null : +surface.toFixed(4),
          gap: surface === null ? null : +(tread - surface).toFixed(4),
        };
      });
      const worst = wheels.reduce((a, w) => Math.max(a, Math.abs(w.gap ?? 9)), 0);
      const neighbours = (city.ojeks || []).filter((o, j) => j !== i);
      const nearest = neighbours.reduce((a, o) => Math.min(a, Math.hypot(o.x - entry.x, o.z - entry.z)), 99);
      // the file header promises <= 2000 triangles and 11 draw calls per bike: say what it costs
      let tris = 0;
      let meshes = 0;
      root.traverse((o) => {
        if (o.isMesh && o.geometry?.attributes?.position) {
          tris += o.geometry.attributes.position.count / 3;
          meshes++;
        }
      });
      return {
        i,
        name: root.name,
        x: +entry.x.toFixed(2),
        z: +entry.z.toFixed(2),
        groupY: +root.position.y.toFixed(4),
        wheels,
        worst,
        nearest,
        tris: Math.round(tris),
        meshes,
      };
    });

    /** colliders that belong to this bike (and its rank partner's body) are not occluders */
    const ownColliders = (entry) =>
      city.colliders.filter(
        (c) => entry.x > c.minX - 1.6 && entry.x < c.maxX + 1.6 && entry.z > c.minZ - 1.6 && entry.z < c.maxZ + 1.6
      );
    const camera = () => g.camera;

    const build = (entry) => {
      const own = ownColliders(entry);
      const blocked = (x, y, z) =>
        city.colliders.some((c) => !own.includes(c) && x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ && y < (c.h ?? 3));
      const yaw = entry.group.rotation.y;
      const f = { x: Math.sin(yaw), z: Math.cos(yaw) }; // bike forward, local +Z
      const n = { x: f.z, z: -f.x }; // bike right, local +X
      const ground = city.groundHeightAt(entry.x, entry.z);
      const local = (x, y, z) => {
        const v = new THREE.Vector3(x, y, z);
        entry.group.localToWorld(v);
        return v;
      };
      // the lens has to see the machine's middle and both contact patches
      const aims = [local(0, 0.85, 0), local(0, 0.06, 0.74), local(0, 0.06, -0.53)];
      const clearSight = (cx, cy, cz) =>
        aims.every((aim) => {
          for (let i = 1; i <= 24; i++) {
            const t = i / 25;
            if (blocked(cx + (aim.x - cx) * t, cy + (aim.y - cy) * t, cz + (aim.z - cz) * t)) return false;
          }
          return true;
        });
      const project = (cam, v) => {
        const p = v.clone().project(cam);
        return { x: Math.round((p.x * 0.5 + 0.5) * W), y: Math.round((-p.y * 0.5 + 0.5) * H), behind: p.z > 1 };
      };
      // the frame has to hold the machine, both contacts and some asphalt around them
      const fit = (cam) => {
        const pts = [
          project(cam, local(0, 0.0005, 0.74)),
          project(cam, local(0, 0.0005, -0.53)),
          project(cam, local(0, 1.66, 0)),
          project(cam, local(0, 1.3, -0.68)),
          project(cam, local(0.4, 0.62, 0.66)),
          project(cam, local(-0.4, 0.62, 0.66)),
        ];
        const m = 22;
        return pts.every((p) => !p.behind && p.x > m && p.x < W - m && p.y > m && p.y < H - m);
      };

      const views = [];
      for (const name of ['side', 'rear']) {
        let found = null;
        for (const dist of name === 'side' ? [4.1, 4.7, 5.3, 6.0] : [3.3, 3.9, 4.5, 5.1]) {
          for (const lateral of name === 'side' ? [1, -1] : [0.34, -0.34, 0.56, -0.56]) {
            for (const along of name === 'side' ? [-0.45, 0.35, -1.2] : [0, -0.5]) {
              if (found) break;
              const off = lateral * dist;
              const fwd = name === 'side' ? along : -dist + along;
              const cx = entry.x + n.x * off + f.x * fwd;
              const cz = entry.z + n.z * off + f.z * fwd;
              const cy = ground + (name === 'side' ? 0.52 : 0.66);
              if (blocked(cx, cy, cz)) continue; // the lens is inside a stall or a wall
              if (!clearSight(cx, cy, cz)) continue;
              const cam = camera();
              cam.fov = name === 'side' ? 33 : 38;
              cam.updateProjectionMatrix();
              cam.position.set(cx, cy, cz);
              const aim = name === 'side' ? local(0, 0.55, 0) : local(0, 0.5, -0.2);
              cam.lookAt(aim);
              cam.updateMatrixWorld();
              cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
              if (!fit(cam)) continue;
              found = {
                name,
                camera: [+cx.toFixed(2), +cy.toFixed(2), +cz.toFixed(2)],
                fov: cam.fov,
                aim: name === 'side' ? [0, 0.55, 0] : [0, 0.5, -0.2],
                contact: {
                  front: project(cam, local(0, 0.0005, 0.74)),
                  rear: project(cam, local(0, 0.0005, -0.53)),
                },
              };
            }
          }
        }
        views.push(found);
      }
      return { views };
    };

    // Is the body still hollow? A ray across the machine's width at every point of a seam band that
    // used to be a hole must hit bodywork. The step-through band is the control: it has to stay
    // open, which is what proves a "closed" reading is not just a ray that never hits anything.
    const closure = (entry) => {
      const bands = [
        // the slot that used to be open: deck ends at z 0.45, apron bottom is y 0.54 / z 0.51, and
        // the old lower cowl only started at z 0.545
        { at: 'leg shield -> footwell', y: [0.34, 0.54], z: [0.46, 0.54], solid: true },
        { at: 'deck -> seat tunnel', y: [0.36, 0.7], z: [-0.2, 0.1], solid: true },
        { at: 'under pillion (rear void)', y: [0.58, 0.74], z: [-0.6, -0.22], solid: true },
        { at: 'step-through (control, must stay open)', y: [0.52, 0.72], z: [0.2, 0.4], solid: false },
      ];
      const side = new THREE.Raycaster();
      // the rider is its own child group at z 0; his shins occupy the step-through, so he is not
      // part of "is the bodywork closed"
      const body = entry.group.children.filter((c) => !(c.isGroup && Math.abs(c.position.z) < 0.3));
      return bands.map((band) => {
        let rays = 0;
        let hits = 0;
        for (let i = 0; i <= 6; i++) {
          const y = band.y[0] + ((band.y[1] - band.y[0]) * i) / 6;
          for (let j = 0; j <= 4; j++) {
            const z = band.z[0] + ((band.z[1] - band.z[0]) * j) / 4;
            // local -X to local +X across the machine's width, in world space
            const a = entry.group.localToWorld(new THREE.Vector3(-0.7, y, z));
            const b = entry.group.localToWorld(new THREE.Vector3(0.7, y, z));
            side.set(a, b.clone().sub(a).normalize());
            side.far = a.distanceTo(b);
            // the bike's own meshes only: the scene would just find the road or a wall
            rays++;
            if (side.intersectObjects(body, true).length) hits++;
          }
        }
        const solid = hits / rays;
        return {
          at: band.at,
          rays,
          hits,
          solid: +solid.toFixed(2),
          want: band.solid ? 'closed' : 'open',
          ok: band.solid ? solid === 1 : solid <= 0.2,
        };
      });
    };

    // candidate order: bikes that already clear the gate, room around them, smallest residual
    const target0 = bikes.filter((b) => b.wheels.length === 2 && b.nearest > 2.6).sort((a, b) => a.worst - b.worst || a.i - b.i);
    const rejected = [];
    for (const b of target0) {
      const built = build(city.ojeks[b.i]);
      if (built.views.every(Boolean)) {
        return { bikes, target: b.i, views: built.views, rejected, closure: closure(city.ojeks[b.i]) };
      }
      rejected.push({ bike: b.name, views: built.views.map((v) => v?.name ?? null) });
    }
    return { bikes, target: -1, views: [], rejected, closure: [] };
  });

  console.log('SURVEY', JSON.stringify(plan.bikes));
  if (plan.target < 0) throw new Error(`no ojek with a clear camera line: ${JSON.stringify(plan.rejected)}`);
  console.log('PLAN', JSON.stringify({ target: plan.target, views: plan.views }));
  console.log('CLOSURE', JSON.stringify(plan.closure));
  const hollow = plan.closure.filter((c) => !c.ok);

  for (const view of plan.views) {
    await page.evaluate(
      (index, view) => {
        const g = window.__game;
        const entry = g.city.ojeks[index];
        const cam = g.camera;
        cam.fov = view.fov;
        cam.updateProjectionMatrix();
        cam.position.set(...view.camera);
        const THREE = g.THREE;
        const aim = new THREE.Vector3(view.aim[0], view.aim[1], view.aim[2]);
        entry.group.localToWorld(aim);
        cam.lookAt(aim);
        cam.updateMatrixWorld();
        cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
        g.renderer.render(g.scene, cam);
      },
      plan.target,
      view
    );
    const file = `${OUT}/${PREFIX}-${view.name}.png`;
    await page.screenshot({ path: file });
    console.log('SHOT', JSON.stringify({ file, camera: view.camera, contact: view.contact }));
  }

  const chosen = plan.bikes[plan.target];
  const gaps = chosen.wheels.map((w) => (w.gap === null ? 9 : w.gap));
  const worstFloat = Math.max(...gaps);
  const worstSink = Math.max(...gaps.map((g) => -g));
  const contactOk = worstFloat <= MAX_FLOAT && worstSink <= MAX_SINK;
  console.log(
    'CONTACT',
    JSON.stringify({
      bike: chosen.name,
      wheels: chosen.wheels,
      worstFloatM: +worstFloat.toFixed(4),
      worstSinkM: +worstSink.toFixed(4),
      gateFloat: MAX_FLOAT,
      gateSink: MAX_SINK,
      pass: contactOk,
    })
  );
  if (errors.length) console.log('PAGE ERRORS', JSON.stringify(errors.slice(0, 4)));
  if (hollow.length) {
    console.error(`closure: still hollow at ${hollow.map((h) => h.at).join(', ')}`);
    process.exitCode = 1;
  }
  if (!contactOk) {
    console.error(`contact: ${chosen.name} floats ${worstFloat.toFixed(3)} m / sinks ${worstSink.toFixed(3)} m`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
