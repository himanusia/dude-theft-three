/**
 * Road surface probe — is the carriageway actually drawn, which way does every ribbon face, and is
 * the asphalt darker and rougher than the paving?
 *
 * The owner's report ("road and pavement cannot be told apart") is a question about what the
 * renderer kept, not about what the builders emitted: `city.ribbon()` used to push each quad's
 * four corners in DECREASING lateral order, so every carriageway, trotoar and river carried a
 * normal of (0,-1,0). `MeshStandardMaterial` is FrontSide, so those surfaces were culled from
 * above and the player saw the terrain plane instead of the street. A downward raycast separates
 * the two cases, because `THREE.Raycaster` honours `material.side` exactly like the renderer does:
 * a FrontSide triangle whose winding faces the ground is not hit from above.
 *
 * Three measurements come out of one page load:
 *
 *   1. RAYS   10 straight-down rays along the widest arterial, taken on the carriageway 2.6 m off
 *              the centre line (the centre line carries painted dashes and the lane edge line is
 *              at 7.8 m, so 2.6 m is bare asphalt). Reports `hit.object.name` for each: a road
 *              point that reads `terrain`/`plate` is the defect, `road-arterial` is the fix. The
 *              centre-line stack is printed separately so the lane dashes are visible as paint on
 *              top of the road rather than mistaken for a missing carriageway.
 *   2. WINDING per named surface: area-weighted up/down/vertical triangle normals and, for any
 *              surface with downward area, the largest offending triangle and the mesh's own
 *              material side. A flat ribbon with downward area is being culled from above; a
 *              closed box (a 12 mm lane dash) legitimately owns a bottom face.
 *   3. MATERIALS mean map luminance and roughness of asphalt vs paving, plus the kerb's per-column
 *              vertex tone, so "the road is darker and rougher than the walk" is a number.
 *
 * usage: DTA_URL=http://127.0.0.1:8981 node tools/probe-road-surface.mjs
 *        ROAD_PROBE=proof/road-surface.json  keep the report
 *        ROAD_GATE=1                         exit 2 unless 10/10 rays hit a road mesh
 *        (default: report only, so this same file can be pointed at the pre-fix build to produce
 *        the "before" numbers)
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || process.argv[2] || 'http://127.0.0.1:8981';
const JSON_OUT = process.env.ROAD_PROBE || '';
const GATE = process.env.ROAD_GATE === '1';
const POINTS = Number(process.env.ROAD_POINTS || 10);
const LATERAL = Number(process.env.ROAD_LATERAL || 2.6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  defaultViewport: { width: 1200, height: 800 },
  protocolTimeout: 300000,
});

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 240000 });
  await page.waitForFunction('window.__game !== undefined', { timeout: 120000 });
  await sleep(1500);

  const report = await page.evaluate((pointCount, lateral) => {
    const g = window.__game;
    const THREE = g.THREE;
    const city = g.city;

    // ------------------------------------------------------------------ which road, which metre
    // The widest arterial, sampled at fixed fractions of its own arc length: the city layout is
    // randomised per load (blocks, props, traffic), but the arterial paths are constants, so the
    // same ten metres of carriageway are measured on every build.
    const road = [...city.roads].sort((a, b) => b.width - a.width)[0];
    const p = road.path;
    const segs = [];
    let total = 0;
    for (let i = 1; i < p.length; i++) {
      const [x1, z1] = p[i - 1];
      const [x2, z2] = p[i];
      const len = Math.hypot(x2 - x1, z2 - z1);
      segs.push({ x1, z1, x2, z2, len, at: total, dx: (x2 - x1) / (len || 1), dz: (z2 - z1) / (len || 1) });
      total += len;
    }
    const sample = (d) => {
      const s = segs.find((q) => d >= q.at && d <= q.at + q.len) || segs[segs.length - 1];
      const t = Math.min(1, Math.max(0, (d - s.at) / (s.len || 1)));
      return { x: s.x1 + (s.x2 - s.x1) * t, z: s.z1 + (s.z2 - s.z1) * t, dx: s.dx, dz: s.dz };
    };

    // only meshes: a Sprite in the scene makes Raycaster.intersectObjects(scene.children) throw
    // (its raycast reads this.camera, which the bare raycaster does not set)
    const meshes = [];
    g.scene.traverse((o) => {
      if (o.isMesh && o.visible) meshes.push(o);
    });
    const ray = new THREE.Raycaster();
    ray.far = 30;
    const down = new THREE.Vector3(0, -1, 0);
    const chainOf = (o) => {
      const names = [];
      let q = o;
      while (q && names.length < 4) {
        names.push(q.name || q.type);
        q = q.parent;
      }
      return names.join('<');
    };
    const castAt = (x, z) => {
      const ground = g.terrainHeight(x, z);
      ray.set(new THREE.Vector3(x, ground + 1.6, z), down);
      return ray.intersectObjects(meshes, false).map((h) => ({
        name: h.object.name || '(unnamed)',
        chain: chainOf(h.object),
        type: h.object.geometry.type,
        mat: h.object.material && h.object.material.color ? `#${h.object.material.color.getHexString()}` : '?',
        side: h.object.material ? h.object.material.side : null,
        y: +h.point.y.toFixed(3),
        above: +(h.point.y - ground).toFixed(3),
        ny: h.face ? +h.face.normal.y.toFixed(3) : null,
      }));
    };

    const rays = [];
    const centre = [];
    for (let i = 0; i < pointCount; i++) {
      // 6% .. 94% of the arterial, so no sample sits inside a junction
      const d = total * (0.06 + (0.88 * i) / Math.max(1, pointCount - 1));
      const s = sample(d);
      // left normal (-dz, dx) is the sweep's +lateral direction
      const x = s.x + -s.dz * lateral;
      const z = s.z + s.dx * lateral;
      const stack = castAt(x, z);
      const top = stack[0] || null;
      const roadHit = stack.find((h) => /^road-/.test(h.name)) || null;
      rays.push({
        u: +d.toFixed(1),
        at: [+x.toFixed(2), +z.toFixed(2)],
        hit: top ? top.name : '(no hit)',
        hitY: top ? top.y : null,
        aboveTerrain: top ? top.above : null,
        faceNormalY: top ? top.ny : null,
        roadMesh: roadHit ? roadHit.name : null,
        road: !!roadHit,
        stack: stack.slice(0, 3),
      });
      // the same station on the centre line, where the painted lane dashes live
      const stackC = castAt(s.x, s.z);
      centre.push({
        u: +d.toFixed(1),
        hit: stackC[0] ? stackC[0].name : '(no hit)',
        above: stackC[0] ? stackC[0].above : null,
        roadUnder: (stackC.find((h) => /^road-/.test(h.name)) || {}).name || null,
      });
    }

    // ------------------------------------------------------------------ winding, per surface
    // Area-weighted triangle normals. A swept ribbon is an OPEN surface: if its winding is
    // inverted, the area that should face the sky faces the ground and the mesh is culled from
    // above. Vertical area is legitimate (the 24 cm kerb face); downward area on a flat ribbon is
    // not. A closed box (the 12 mm dash / zebra instance) owns a bottom face and is not a defect,
    // which is why the geometry type is reported next to the numbers.
    const v = new THREE.Vector3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const auditMesh = (mesh) => {
      const geo = mesh.geometry;
      const pos = geo.attributes.position;
      if (!pos) return null;
      const index = geo.index;
      const tri = index ? index.count / 3 : pos.count / 3;
      if (tri > 400000) return null; // terrain: 72k tris of heightfield, not a ribbon
      let up = 0;
      let down = 0;
      let vert = 0;
      let downWorst = null;
      const matrix = mesh.matrixWorld;
      const get = (k) => {
        const i = index ? index.getX(k) : k;
        return v.fromBufferAttribute(pos, i).applyMatrix4(matrix).clone();
      };
      for (let t = 0; t < tri; t++) {
        a.copy(get(t * 3));
        b.copy(get(t * 3 + 1));
        c.copy(get(t * 3 + 2));
        const ay = a.y;
        b.sub(a);
        c.sub(a);
        b.cross(c);
        const area2 = b.length();
        if (area2 < 1e-9) continue;
        const ny = b.y / area2;
        const area = area2 / 2;
        if (ny > 0.5) up += area;
        else if (ny < -0.5) {
          down += area;
          if (!downWorst || area > downWorst.area) {
            downWorst = {
              area: +area.toFixed(2),
              at: [+a.x.toFixed(1), +ay.toFixed(2), +a.z.toFixed(1)],
              normalY: +ny.toFixed(2),
              tris: t,
            };
          }
        } else vert += area;
      }
      const area = up + down + vert;
      const mat = mesh.material || {};
      return {
        name: mesh.name || '(unnamed)',
        parent: chainOf(mesh.parent),
        geometry: geo.type,
        material: mat.color ? `#${mat.color.getHexString()}` : '?',
        side: mat.side,
        vertexColors: !!mat.vertexColors,
        tris: tri,
        area: +area.toFixed(1),
        up: +up.toFixed(1),
        down: +down.toFixed(1),
        vertical: +vert.toFixed(1),
        downFrac: area > 0 ? +(down / area).toFixed(3) : 0,
        downWorst,
      };
    };

    // every ground-ish surface the city builds, by the name the code gives it
    const groundNames = [
      'road-local',
      'road-arterial',
      'road-shoulder',
      'lane-edge',
      'trotoar',
      'kerb',
      'gutter',
      'kerb-ramp',
      'river',
      'tactile',
      'crossing-stripes',
      'plate',
      'lawn',
      'lot',
    ];
    const rows = [];
    const others = [];
    g.scene.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.visible) return;
      const row = auditMesh(o);
      if (!row) return;
      if (groundNames.includes(row.name)) rows.push(row);
      else if (row.down > 1 && row.area > 4) others.push(row);
    });
    // Aggregate per name+geometry: a block group's kerb and plate are BoxGeometry solids (they own
    // a bottom face by construction), while a swept surface is one merged open strip and must have
    // no downward area at all. Reporting 700 identical boxes hides the one strip that matters.
    const groups = new Map();
    for (const r of rows) {
      const key = `${r.name}|${r.geometry}`;
      const g2 = groups.get(key) || {
        name: r.name,
        geometry: r.geometry,
        side: r.side,
        count: 0,
        tris: 0,
        area: 0,
        up: 0,
        down: 0,
        vertical: 0,
        maxDownFrac: 0,
        worst: null,
      };
      g2.count++;
      g2.tris += r.tris;
      g2.area += r.area;
      g2.up += r.up;
      g2.down += r.down;
      g2.vertical += r.vertical;
      const frac = r.area > 0 ? r.down / r.area : 0;
      if (frac > g2.maxDownFrac) {
        g2.maxDownFrac = +frac.toFixed(3);
        g2.worst = r.downWorst;
      }
      groups.set(key, g2);
    }
    const winding = [...groups.values()]
      .map((r) => ({
        ...r,
        area: +r.area.toFixed(1),
        up: +r.up.toFixed(1),
        down: +r.down.toFixed(1),
        vertical: +r.vertical.toFixed(1),
        downFrac: r.area > 0 ? +(r.down / r.area).toFixed(3) : 0,
      }))
      .sort((x, y) => y.down - x.down);
    const sweeps = rows
      .filter((r) => r.geometry !== 'BoxGeometry' && r.geometry !== 'PlaneGeometry')
      .sort((x, y) => y.down - x.down)
      .slice(0, 40);

    // ------------------------------------------------------------------ material contrast
    const materialRow = (mesh) => {
      if (!mesh) return null;
      const mat = mesh.material;
      if (!mat) return null;
      const row = { name: mesh.name, roughness: mat.roughness, metalness: mat.metalness };
      if (mat.map && mat.map.image) {
        const img = mat.map.image;
        const cv = document.createElement('canvas');
        cv.width = Math.min(64, img.width);
        cv.height = Math.min(64, img.height);
        const ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let r = 0;
        let g2 = 0;
        let b2 = 0;
        for (let i = 0; i < d.length; i += 4) {
          r += d[i];
          g2 += d[i + 1];
          b2 += d[i + 2];
        }
        const n = d.length / 4;
        row.mapMeanRGB = [Math.round(r / n), Math.round(g2 / n), Math.round(b2 / n)];
        row.mapLuma = +((0.2126 * r + 0.7152 * g2 + 0.0722 * b2) / n).toFixed(1);
      } else if (mat.color) {
        row.color = `#${mat.color.getHexString()}`;
        row.mapLuma = +(mat.color.r * 0.2126 * 255 + mat.color.g * 0.7152 * 255 + mat.color.b * 0.0722 * 255).toFixed(1);
      }
      // the kerb and gutter carry a per-column tone as vertex colours; report its range
      const col = mesh.geometry.getAttribute('color');
      if (col && col.count) {
        let lo = 1;
        let hi = 0;
        for (let i = 0; i < col.count; i++) {
          const t = col.getX(i);
          lo = Math.min(lo, t);
          hi = Math.max(hi, t);
        }
        row.tone = [+lo.toFixed(2), +hi.toFixed(2)];
      }
      return row;
    };
    const byName = (n) => {
      let found = null;
      g.scene.traverse((o) => {
        if (o.isMesh && o.name === n && !found) found = o;
      });
      return found;
    };
    const materials = ['road-arterial', 'road-local', 'road-shoulder', 'trotoar', 'kerb', 'gutter', 'tactile']
      .map((n) => {
        // the road buckets are ONE merged mesh per material, but the street kit and the blocks also
        // name their own kerbs; measure the mesh with the largest area under that name
        const candidates = [];
        g.scene.traverse((o) => {
          if (o.isMesh && o.name === n && o.visible) {
            const row = auditMesh(o);
            if (row) candidates.push({ o, row });
          }
        });
        candidates.sort((x, y) => y.row.area - x.row.area);
        return candidates.length ? materialRow(candidates[0].o) : null;
      })
      .filter(Boolean);
    const air = materials.find((m) => m.name === 'road-arterial');
    const walk = materials.find((m) => m.name === 'trotoar');
    const contrast = {
      walkOverRoadMap: air && walk && air.mapLuma ? +(walk.mapLuma / air.mapLuma).toFixed(2) : null,
      roughnessRoad: air ? air.roughness : null,
      roughnessWalk: walk ? walk.roughness : null,
    };

    // ------------------------------------------------------------------ crossings
    // The tactile pad is the thing a pedestrian reads at a crossing, and the dropped kerb is the
    // opening it stands in front of. Count the instances and raycast the first pad so "there is a
    // tactile strip at crossings" is a hit on the pad mesh, not a colour in a texture.
    const tactileMesh = byName('tactile');
    const stripeMesh = byName('crossing-stripes');
    const rampMesh = byName('kerb-ramp');
    const crossingRow = {
      planned: city.crossings ? city.crossings.length : null,
      tactilePads: tactileMesh && tactileMesh.isInstancedMesh ? tactileMesh.count : null,
      zebraBars: stripeMesh && stripeMesh.isInstancedMesh ? stripeMesh.count : null,
      rampVerts: rampMesh && rampMesh.geometry.attributes.position ? rampMesh.geometry.attributes.position.count : null,
      firstPad: null,
    };
    if (tactileMesh && tactileMesh.isInstancedMesh && tactileMesh.count) {
      const m = new THREE.Matrix4();
      tactileMesh.getMatrixAt(0, m);
      const at = new THREE.Vector3().setFromMatrixPosition(m);
      const stack = castAt(at.x, at.z);
      crossingRow.firstPad = {
        at: [+at.x.toFixed(2), +at.z.toFixed(2)],
        hit: stack[0] ? stack[0].name : '(no hit)',
        above: stack[0] ? stack[0].above : null,
        stack: stack.slice(0, 3).map((h) => `${h.name}@+${h.above}`),
      };
    }

    // ------------------------------------------------------------------ kerb face
    // The kerb is the one ribbon whose whole job is a 24 cm VERTICAL face. If the sweep's winding
    // were reversed, that face would point into the paving and be culled from the street: the road
    // would meet the pavement with no stone between them. A horizontal ray from 1.2 m inside the
    // carriageway, 15 cm up, must land on `kerb` and the face must look back at the road.
    const kerbFace = (() => {
      const d = total * 0.4;
      const s = sample(d);
      const nx = -s.dz;
      const nz = s.dx;
      const e = road.width / 2;
      const ox = s.x + nx * (e - 1.2);
      const oz = s.z + nz * (e - 1.2);
      const oy = g.terrainHeight(ox, oz) + 0.15;
      const dir = new THREE.Vector3(nx, 0, nz);
      ray.far = 3;
      ray.set(new THREE.Vector3(ox, oy, oz), dir);
      const hits = ray.intersectObjects(meshes, false);
      const top = hits[0] || null;
      let facing = null;
      if (top && top.face) {
        const n = top.face.normal.clone().transformDirection(top.object.matrixWorld);
        facing = +(-n.x * nx - n.z * nz).toFixed(3); // 1 = looks straight back at the road
      }
      return {
        at: [+ox.toFixed(2), +oz.toFixed(2)],
        hit: top ? top.object.name || '(unnamed)' : '(no hit)',
        distance: top ? +top.distance.toFixed(2) : null,
        height: top ? +(top.point.y - g.terrainHeight(ox, oz)).toFixed(3) : null,
        facesRoad: facing,
      };
    })();

    return {
      road: { name: road.name, width: road.width, length: +total.toFixed(1) },
      total,
      rays,
      centre,
      kerbFace,
      summary: {
        points: rays.length,
        roadHits: rays.filter((r) => r.road).length,
        nonRoad: rays.filter((r) => !r.road).map((r) => `${r.hit} @ ${r.at.join(',')}`),
      },
      winding,
      sweeps,
      others: others.sort((x, y) => y.down - x.down).slice(0, 12),
      materials,
      contrast,
      crossings: crossingRow,
    };
  }, POINTS, LATERAL);

  console.log('ROAD', JSON.stringify(report.road));
  console.log(`RAYS (${LATERAL} m off the centre line, straight down from terrain+1.6 m)`);
  for (const r of report.rays) {
    console.log(
      `  u=${String(r.u).padStart(6)}  at ${String(r.at[0]).padStart(8)},${String(r.at[1]).padStart(8)}  ` +
        `hit ${r.hit.padEnd(16)} y=${String(r.hitY).padStart(8)} (+${r.aboveTerrain} m)  ny=${r.faceNormalY}  road=${r.roadMesh}`
    );
    if (r.stack.length > 1) {
      console.log(`           stack: ${r.stack.map((h) => `${h.name}@+${h.above}`).join(' > ')}`);
    }
  }
  console.log('CENTRE LINE (paint over the same carriageway)');
  for (const c of report.centre) {
    console.log(`  u=${String(c.u).padStart(6)}  hit ${c.hit.padEnd(16)} +${c.above} m  road under ${c.roadUnder}`);
  }
  console.log('SUMMARY', JSON.stringify(report.summary));
  console.log('WINDING (grouped by surface name + geometry)');
  for (const w of report.winding) {
    console.log(
      `  ${w.name.padEnd(16)} ${w.geometry.padEnd(14)} side=${w.side} x${String(w.count).padStart(4)}  ` +
        `tris ${String(w.tris).padStart(7)}  up ${String(w.up).padStart(9)}  down ${String(w.down).padStart(9)}  ` +
        `vert ${String(w.vertical).padStart(8)}  downFrac ${w.downFrac}  maxFrac ${w.maxDownFrac}`
    );
  }
  console.log('SWEPT SURFACES (non-box, the ribbons themselves)');
  for (const s of report.sweeps) {
    console.log(
      `  ${s.name.padEnd(16)} ${s.geometry.padEnd(14)} mat ${String(s.material).padEnd(9)}  tris ${String(s.tris).padStart(7)}  ` +
        `up ${String(s.up).padStart(9)}  down ${String(s.down).padStart(9)}  vert ${String(s.vertical).padStart(8)}  ` +
        `downFrac ${s.downFrac}${s.downWorst ? `  worst ${JSON.stringify(s.downWorst)}` : ''}`
    );
  }
  if (report.others.length) {
    console.log('OTHER NAMED MESHES WITH DOWNWARD AREA (>1 m2, not a ground surface name)');
    for (const o of report.others) {
      console.log(`  ${o.name.padEnd(16)} ${o.parent.padEnd(28)} ${o.geometry.padEnd(14)} mat ${o.material}  down ${o.down} of ${o.area}`);
    }
  }
  console.log('MATERIALS', JSON.stringify(report.materials, null, 1));
  console.log('CONTRAST', JSON.stringify(report.contrast));
  console.log('CROSSINGS', JSON.stringify(report.crossings));
  console.log('KERB_FACE', JSON.stringify(report.kerbFace));
  if (pageErrors.length) console.log('PAGE_ERRORS', JSON.stringify(pageErrors.slice(0, 5)));

  if (JSON_OUT) {
    fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    fs.writeFileSync(JSON_OUT, JSON.stringify({ base: BASE, ...report }, null, 1));
    console.log('WROTE', JSON_OUT);
  }

  const bad = report.summary.points - report.summary.roadHits;
  // A swept ribbon (sweepSurface) is one merged BufferGeometry and an OPEN surface: a real
  // downward share means the renderer culls it from above. Boxes, cylinders, cones and planes are
  // closed primitives (block plates, kerb stones, tree canopies, the 12 mm dash) that own a bottom
  // face by construction, and they are not in this list.
  const sweeps = report.sweeps.filter((w) => w.geometry === 'BufferGeometry');
  const folds = sweeps.filter((w) => w.down > 0.2 && (w.area > 0 ? w.down / w.area : 0) <= 0.02);
  const flipped = sweeps.filter((w) => (w.area > 0 ? w.down / w.area : 0) > 0.02);
  if (bad) console.log(`FAIL ${bad}/${report.summary.points} road points did not hit a road mesh`);
  if (folds.length) {
    console.log(
      'NOTE self-intersection folds (tiny, at a bend, not a winding defect): ' +
        folds.map((w) => `${w.name} ${w.down}m2 at ${JSON.stringify(w.downWorst.at)}`).join('; ')
    );
  }
  if (flipped.length) console.log('FAIL surfaces with downward area: ' + flipped.map((w) => `${w.name}(${w.downFrac})`).join(', '));
  const kerbOk = report.kerbFace && report.kerbFace.hit === 'kerb' && report.kerbFace.facesRoad > 0.5;
  if (report.kerbFace && !kerbOk) {
    console.log(`FAIL the kerb face does not face the road: ${JSON.stringify(report.kerbFace)}`);
  }
  if (GATE && (bad || flipped.length || !kerbOk)) process.exitCode = 2;
} finally {
  await browser.close();
}
