/**
 * Point-blank shots must land on the body that is standing on the barrel.
 *
 * Reported shape (fixed here): with a pedestrian 0.02 m in front of the player, one round per pull
 * left him alive and the bullet hit the wall 1.6-1.9 m behind him. The shot ray started at the
 * camera and ignored every actor closer than MIN_T = 2.2 m, so the close body sat inside the blind
 * zone and was skipped. Two shots in the same run were spent on nothing because the third-person
 * boom had pushed the camera inside a building (ray-vs-collider answered 0, so every actor and the
 * wall were farther than the "wall" that the camera was already buried in).
 *
 * The suite is the measurement, not a reading of the code: 30 one-round shots, all at a body
 * 0.02 m away, half of them with a wall 1.8 m behind the body (a pass-through hits that wall), the
 * other half with the player's back against a building so the camera itself is inside geometry.
 * Every shot reports what the game says it hit (`window.__lastShot`) plus whether the body died.
 *
 * usage: node tests/world/pointblank-shots.mjs     (spawns its own vite on 9420)
 *        DTA_URL=http://127.0.0.1:9450 node tests/world/pointblank-shots.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = new URL('../..', import.meta.url).pathname; // tests/world/ -> repo root
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const PREFERRED_PORT = Number(process.env.HARNESS_PORT || 9420);
let PORT = PREFERRED_PORT;
let URL_BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = 30;
const BODY_GAP = 0.02; // the reported distance from the player to the body
const WALL_GAP = 1.8; // the wall the pass-through used to hit
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS ' : 'FAIL '}${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
}

function httpGet(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function portInUse(port) {
  try {
    await httpGet(`http://127.0.0.1:${port}/`);
    return true;
  } catch (e) {
    return false;
  }
}

async function pickPort() {
  for (let p = PREFERRED_PORT; p < PREFERRED_PORT + 10; p++) if (!(await portInUse(p))) return p;
  throw new Error('no free port in ' + PREFERRED_PORT + '..' + (PREFERRED_PORT + 9));
}

/** Make sure whoever answers on the port is vite serving *this* working tree. */
async function assertOwnServer(base) {
  const res = await httpGet(base + '/tests/world/pointblank-shots.mjs');
  const ours = res.status === 200 && res.body.includes('Point-blank shots must land');
  if (!ours) throw new Error('port ' + PORT + ' is not serving this worktree (status ' + res.status + ')');
}

/** Worktrees usually share the parent repo's node_modules; find vite by walking up. */
function viteBin() {
  let dir = ROOT;
  for (let i = 0; i < 5; i++) {
    const p = path.join(dir, 'node_modules/vite/bin/vite.js');
    if (fs.existsSync(p)) return p;
    dir = path.dirname(dir);
  }
  throw new Error('vite not installed (no node_modules/vite/bin/vite.js above ' + ROOT + ')');
}

function waitForServer(url, timeoutMs = 30000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const retry = () => {
      if (Date.now() - startedAt > timeoutMs) reject(new Error('vite did not answer on ' + url));
      else setTimeout(tick, 200);
    };
    const tick = () => {
      http
        .get(url, (res) => {
          res.resume();
          if (res.statusCode && res.statusCode < 500) resolve(true);
          else retry();
        })
        .on('error', retry);
    };
    tick();
  });
}

let server = null;
function stopServer() {
  if (!server) return;
  try {
    server.kill('SIGTERM');
  } catch (e) {
    /* already gone */
  }
  server = null;
}

/**
 * Pick two kinds of point-blank stand:
 *   `wall`   the player 1.8 m off a building face and facing it, so a shot that passes through the
 *            body hits that wall just behind it (the reported signature)
 *   `buried` the player 0.6 m off the same kind of face with his BACK to it, so the third-person
 *            boom is forced to 2.4 m and the camera ends up inside the building
 * Both spots are checked in-page before use: the stand point is outside every collider and the
 * ground under it is the pedestrian's ground, not a roof.
 */
function pickSpots(page, maxSpots) {
  return page.evaluate(
    ({ wallGap, buriedGap, maxSpots }) => {
      const g = window.__game;
      const boxes = g.city.colliders.filter(
        (b) => (b.h ?? 30) >= 4 && b.maxX - b.minX >= 6 && b.maxZ - b.minZ >= 6
      );
      const inside = (x, z, pad) =>
        g.city.colliders.some(
          (b) => x > b.minX - pad && x < b.maxX + pad && z > b.minZ - pad && z < b.maxZ + pad && (b.h ?? 30) > 0.5
        );
      const wallSpots = [];
      const buriedSpots = [];
      for (const b of boxes) {
        const faces = [
          { nx: 0, nz: -1, x: (b.minX + b.maxX) / 2, z: b.minZ },
          { nx: 0, nz: 1, x: (b.minX + b.maxX) / 2, z: b.maxZ },
          { nx: -1, nz: 0, x: b.minX, z: (b.minZ + b.maxZ) / 2 },
          { nx: 1, nz: 0, x: b.maxX, z: (b.minZ + b.maxZ) / 2 },
        ];
        for (const f of faces) {
          const faceGround = g.city.groundHeightAt(f.x, f.z);
          // wall: stand off the face, facing it
          const wx = f.x + f.nx * wallGap;
          const wz = f.z + f.nz * wallGap;
          if (!inside(wx, wz, 0.9) && Math.abs(g.city.groundHeightAt(wx, wz) - faceGround) < 0.25) {
            // the wall has to be the first thing behind the body: nothing else within the gap
            let clear = true;
            for (let s = 0.2; s < wallGap; s += 0.2) {
              if (inside(f.x + f.nx * s, f.z + f.nz * s, 0.05)) {
                clear = false;
                break;
              }
            }
            if (clear) wallSpots.push({ x: wx, z: wz, yawTo: [f.x, f.z], nx: f.nx, nz: f.nz, h: b.h ?? 30 });
          }
          // buried: stand close, facing away from the face so the boom goes into it
          const bx = f.x + f.nx * buriedGap;
          const bz = f.z + f.nz * buriedGap;
          if (!inside(bx, bz, 0.2) && Math.abs(g.city.groundHeightAt(bx, bz) - faceGround) < 0.25) {
            buriedSpots.push({ x: bx, z: bz, yawAwayFrom: [f.x, f.z], nx: f.nx, nz: f.nz, h: b.h ?? 30 });
          }
        }
      }
      return { wallSpots: wallSpots.slice(0, maxSpots), buriedSpots: buriedSpots.slice(0, maxSpots) };
    },
    { wallGap: WALL_GAP, buriedGap: 0.6, maxSpots }
  );
}

/**
 * Stage one shot: a live pedestrian BODY_GAP metres in front of the player, camera pitched at his
 * chest (the way a player aims), one round in the magazine.
 */
function stageShot(page, spot, mode) {
  return page.evaluate(
    ({ spot, mode, gap }) => {
      const g = window.__game;
      const T = g.THREE;
      // a pedestrian that is not already a corpse, a vendor, or a queue leader (those are pinned
      // to a cart and would be re-staged by their own logic)
      const live = g.peds.peds.filter((p) => !p.dead && !p.vendor && !p.leader && !p.partner);
      if (!live.length) return { ok: false, why: 'no live pedestrians' };
      // one body per shot, never one that has already been shot at: the street flees after a
      // gunshot and the next round must not inherit that body's running target
      const victim = live[0];
      window.__probeVictim = victim;
      g._test.teleport(spot.x, spot.z);
      g.player.y = g.city.groundHeightAt(spot.x, spot.z);
      const ground = g.city.groundHeightAt(spot.x, spot.z);
      // face the wall (mode 'wall') or away from it (mode 'buried', camera into the building)
      const yawPoint = mode === 'wall' ? spot.yawTo : [spot.x + spot.nx * 4, spot.z + spot.nz * 4];
      g._test.face(yawPoint[0], yawPoint[1]);
      // the body sits on the line the player looks down, gap metres out
      const fx = Math.sin(g._test.camYaw) * -1;
      const fz = Math.cos(g._test.camYaw) * -1;
      const bodyAt = { x: spot.x + fx * gap, z: spot.z + fz * gap, y: ground };
      window.__probeBody = bodyAt;
      victim.pos.set(bodyAt.x, ground, bodyAt.z);
      victim.target = victim.pos.clone();
      victim.speed = 0;
      victim.char.group.position.set(bodyAt.x, ground, bodyAt.z);
      // one round ready, no reload or cooldown in the way
      g.equipWeapon('pistol');
      g.player.mag = 30;
      g.player.reloading = 0;
      g.player.shootCd = 0;
      // thirteen kills in a row bring the police, and a bust or a death teleports the player to
      // the station mid-round: the probe is measuring shots, not survival
      g.police.clearWanted();
      g.player.hp = 100;
      return {
        ok: true,
        why: null,
        victim: [bodyAt.x, ground, bodyAt.z].map((n) => +n.toFixed(2)),
        player: [g.player.pos.x, g.player.pos.z].map((n) => +n.toFixed(2)),
      };
    },
    { spot, mode, gap: BODY_GAP }
  );
}

/**
 * Aim the camera at the body's chest the way a player does: nudge the pitch, let the boom follow
 * for a frame, and measure the miss distance again. The boom direction is coupled to the pitch
 * (a down-look also drops the camera), so this cannot be solved in one shot of maths: it converges
 * over frames until the aimed ray actually crosses the chest.
 */
async function aimAtBody(page) {
  let last = null;
  for (let i = 0; i < 12; i++) {
    last = await page.evaluate(() => {
      const g = window.__game;
      const T = g.THREE;
      const at = window.__probeBody;
      const cam = g.camera.position.clone();
      const chest = new T.Vector3(at.x, at.y + 1.0, at.z);
      const dir = g.camera.getWorldDirection(new T.Vector3());
      const to = chest.clone().sub(cam);
      const depth = to.dot(dir);
      const offAxis = to.clone().addScaledVector(dir, -depth).length();
      const flat = Math.hypot(chest.x - cam.x, chest.z - cam.z);
      // camPitch is the BOOM elevation, and the view turns the other way: a positive pitch puts the
      // camera overhead and looks down. Aiming at a chest that sits below the camera is therefore
      // +atan2(drop, flat), not the plain atan2 of the drop.
      const pitch = Math.atan2(cam.y - chest.y, Math.max(0.001, flat));
      g._test.setCam(undefined, pitch);
      return {
        camToBody: +to.length().toFixed(2),
        depth: +depth.toFixed(2),
        offAxis: +offAxis.toFixed(3),
        pitch: +pitch.toFixed(3),
        cam: [cam.x, cam.y, cam.z].map((n) => +n.toFixed(2)),
      };
    });
    if (last.offAxis < 0.15) break;
    await sleep(170);
  }
  return last;
}

/** Fire once through the game's own trigger path and read back what the shot says it hit. */
function fireOnce(page) {
  return page.evaluate(() => {
    const g = window.__game;
    const victim = window.__probeVictim || null;
    const at = window.__probeBody;
    // seat the body on the barrel again, then pull the trigger in the same tick
    if (victim && at) {
      victim.pos.set(at.x, at.y, at.z);
      victim.target = victim.pos.clone();
      victim.speed = 0;
      victim.char.group.position.set(at.x, at.y, at.z);
    }
    const cam = g.camera.position;
    const camInside = g.city.colliders.some(
      (b) => cam.x > b.minX && cam.x < b.maxX && cam.z > b.minZ && cam.z < b.maxZ && cam.y < (b.h ?? 30)
    );
    const dir = g.camera.getWorldDirection(new g.THREE.Vector3());
    const toBody = new g.THREE.Vector3(at.x - cam.x, at.y + 1.0 - cam.y, at.z - cam.z);
    const aim = {
      camToBody: +toBody.length().toFixed(2),
      // depth of the body's centre along the aim axis, and how far off that axis it sits
      depth: +toBody.dot(dir).toFixed(2),
      offAxis: +toBody.clone().addScaledVector(dir, -toBody.dot(dir)).length().toFixed(2),
    };
    const before = { dead: victim ? victim.dead : null, ragdolls: g.ragdolls.length };
    g.police.clearWanted();
    g.player.hp = 100;
    g.player.mag = 30;
    g.player.reloading = 0;
    g.player.shootCd = 0;
    g._test.shoot();
    const shot = window.__lastShot || null;
    const after = { dead: victim ? victim.dead : null, ragdolls: g.ragdolls.length };
    // how far the reported hit landed from the body: > 1 m means the shot went past him
    let past = null;
    if (shot && victim) {
      past = Math.hypot(shot.hitPoint[0] - at.x, shot.hitPoint[2] - at.z);
    }
    // where the body was relative to where the player actually stands: the game can move the
    // player itself (a bust, a respawn), and a round like that is not a point-blank shot at all
    const drift = Math.hypot(at.x - g.player.pos.x, at.z - g.player.pos.z);
    return {
      shot,
      camInside,
      cam: [cam.x, cam.y, cam.z].map((n) => +n.toFixed(2)),
      aim,
      drift: +drift.toFixed(2),
      before,
      after,
      past: past === null ? null : +past.toFixed(2),
      victimAt: victim ? [victim.pos.x, victim.pos.z].map((n) => +n.toFixed(2)) : null,
    };
  });
}

(async () => {
  if (!process.env.DTA_URL) {
    const free = !(await portInUse(PREFERRED_PORT));
    PORT = free ? PREFERRED_PORT : await pickPort();
    URL_BASE = `http://127.0.0.1:${PORT}`;
    if (!free) console.log('port ' + PREFERRED_PORT + ' busy (sibling worktree?), using ' + PORT);
    server = spawn(process.execPath, [viteBin(), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    await waitForServer(URL_BASE + '/index.html');
    await assertOwnServer(URL_BASE);
    console.log('server ' + URL_BASE);
  } else {
    URL_BASE = process.env.DTA_URL.replace(/\/$/, '');
    console.log('server ' + URL_BASE + ' (DTA_URL)');
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
    defaultViewport: { width: 1280, height: 720 },
  });
  let summary = null;
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text());
    });
    await page.goto(URL_BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 300000 });
    const bootAt = Date.now();
    try {
      await page.waitForFunction('window.__game !== undefined', { timeout: 300000, polling: 500 });
    } catch (e) {
      throw new Error(
        'game never booted in ' + Math.round((Date.now() - bootAt) / 1000) + 's :: ' + errors.slice(0, 5).join(' | ')
      );
    }
    console.log('booted in ' + Math.round((Date.now() - bootAt) / 1000) + 's');
    await sleep(1200);
    await page.click('#start-btn');
    await page.waitForFunction(() => window.__game.state.started === true, { timeout: 120000, polling: 500 });
    await sleep(2500);
    // hold the aim (right mouse): that is the stance a player uses at arm's length, and it is the
    // one that puts the third-person camera ~1.4 m behind the head, i.e. inside the old blind zone
    await page.mouse.move(640, 360);
    await page.mouse.down({ button: 'right' });
    await sleep(900);

    const spots = await pickSpots(page, SHOTS);
    const wall = spots.wallSpots;
    const buried = spots.buriedSpots;
    console.log(
      'SPOTS :: ' +
        JSON.stringify({ wall: wall.length, buried: buried.length, wallSample: wall[0], buriedSample: buried[0] })
    );
    check('found wall stand-offs for the pass-through case', wall.length >= SHOTS / 2, { wall: wall.length });
    check('found back-to-wall stands for the camera-in-geometry case', buried.length >= SHOTS / 2, {
      buried: buried.length,
    });
    if (wall.length < SHOTS / 2 || buried.length < SHOTS / 2) throw new Error('not enough staging spots');

    const runs = [];
    for (let i = 0; i < SHOTS; i++) {
      // even rounds: wall behind the body. odd rounds: camera buried in the building behind you.
      const mode = i % 2 === 0 ? 'wall' : 'buried';
      const spot = mode === 'wall' ? wall[Math.floor(i / 2)] : buried[Math.floor(i / 2)];
      let staged = null;
      let aim = null;
      let res = null;
      let retries = 0;
      // a round is only counted when the body and the player really are where they were staged:
      // the street can move the player itself (a bust, a respawn), and that is not point-blank
      for (let attempt = 0; attempt < 3; attempt++) {
        staged = await stageShot(page, spot, mode);
        if (!staged.ok) throw new Error(staged.why);
        await sleep(420); // let the boom settle after the teleport
        aim = await aimAtBody(page); // converge the crosshair onto his chest
        res = await fireOnce(page);
        if (res.drift < 1) break;
        retries++;
        console.log(`RETRY ${i + 1}/${SHOTS} ${mode} :: drift ${res.drift} m, re-staging`);
      }
      runs.push({ i, mode, spot, staged, aim, retries, ...res });
      console.log(
        `SHOT ${i + 1}/${SHOTS} ${mode} :: ` +
          JSON.stringify({
            hitKind: res.shot ? res.shot.hitKind : null,
            bestDist: res.shot ? res.shot.bestDist : null,
            past: res.past,
            camInside: res.camInside,
            camToBody: res.aim.camToBody,
            offAxis: res.aim.offAxis,
            drift: res.drift,
            retries,
            dead: res.after.dead,
            kill: res.after.ragdolls > res.before.ragdolls,
          })
      );
      await sleep(260);
    }

    const hitBody = runs.filter((r) => r.shot && r.shot.hitKind === 'ped' && r.after.dead);
    const kills = runs.filter((r) => r.after.dead && r.after.ragdolls > r.before.ragdolls);
    const passedThrough = runs.filter((r) => r.shot && r.shot.hitKind !== 'ped');
    // a zero-length shot is a shot spent inside the geometry the camera was buried in: it hit
    // nothing real, whatever `hitKind` the wall test labelled it with
    const lostZero = runs.filter((r) => !r.shot || r.shot.bestDist <= 0);
    const buriedShots = runs.filter((r) => r.camInside);
    const wallRuns = runs.filter((r) => r.mode === 'wall');
    const nearCam = wallRuns.filter((r) => r.aim && r.aim.camToBody < 2.4);

    // the stance has to sit inside the old blind zone for the measurement to mean anything: a
    // camera 5.8 m back never had one to fall into
    check('every wall round was a real point-blank stance (camera under 2.4 m from the body)', nearCam.length === wallRuns.length, {
      near: nearCam.length,
      of: wallRuns.length,
      worst: Math.max(...wallRuns.map((r) => (r.aim ? r.aim.camToBody : 99))),
    });

    check(`${SHOTS}/${SHOTS} shots hit the body`, hitBody.length === SHOTS, {
      hit: hitBody.length,
      of: SHOTS,
      missed: passedThrough.slice(0, 6).map((r) => ({ i: r.i, mode: r.mode, hitKind: r.shot && r.shot.hitKind, bestDist: r.shot && r.shot.bestDist, past: r.past })),
    });
    check(`${SHOTS}/${SHOTS} shots killed the body`, kills.length === SHOTS, { kills: kills.length, of: SHOTS });
    check('no shot passed through the body', passedThrough.length === 0, { passed: passedThrough.length });
    check('no shot lost to bestDist 0', lostZero.length === 0, {
      lost: lostZero.map((r) => ({ i: r.i, mode: r.mode, bestDist: r.shot && r.shot.bestDist, hitKind: r.shot && r.shot.hitKind })),
    });
    // the camera-in-geometry half has to be exercised, otherwise that criterion proves nothing
    check('the camera really was inside a building on the buried rounds', buriedShots.length >= 5, {
      buriedShots: buriedShots.length,
      buriedRounds: runs.filter((r) => r.mode === 'buried').length,
    });
    check('every buried-camera shot still hit the body', buriedShots.every((r) => r.shot && r.shot.hitKind === 'ped' && r.after.dead), {
      buried: buriedShots.length,
      hit: buriedShots.filter((r) => r.shot && r.shot.hitKind === 'ped' && r.after.dead).length,
    });
    check('no page errors', errors.length === 0, errors.slice(0, 4));

    const failed = results.filter((r) => !r.ok);
    summary = {
      pass: results.length - failed.length,
      total: results.length,
      hits: hitBody.length,
      kills: kills.length,
      passedThrough: passedThrough.length,
      lostZero: lostZero.length,
      buriedCameraShots: buriedShots.length,
      retries: runs.reduce((n, r) => n + r.retries, 0),
    };
  } finally {
    await browser.close();
    stopServer();
  }
  console.log('SUMMARY ' + JSON.stringify(summary));
  if (summary && summary.pass !== summary.total) {
    console.error(`pointblank-shots: ${summary.total - summary.pass}/${summary.total} checks failed`);
    process.exitCode = 1;
  }
})().catch((e) => {
  console.error('FAIL', e.message);
  stopServer();
  process.exit(1);
});
