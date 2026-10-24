// Proof for the shot effects: a 60 ms muzzle flash at the barrel tip, an impact puff sized by the
// surface the ray landed on, and both of them pooled — firing must not build a single object.
//
// usage: node tools/proof-bullets.mjs [baseUrl]
//
// Phases, in this order so the framed shots happen before the 20-shot run alarms the street:
//   1. flash frame  -> screenshots/proof/muzzle-flash.png   (camera parked on the barrel, one shot)
//   2. impact frame -> screenshots/proof/bullet-impact.png  (wall hit, camera 2 m off the face)
//   3. flash window -> how long the flash stays alive after one shot
//   4. pool run     -> 20 shots: peak live particles, allocations, scene/GPU object deltas
//
// Every image claim is measured on the saved PNG, against a second capture of the same camera with
// the effects cleared: the difference IS the effect, so a bright wall cannot fake a pass.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || process.argv[2] || 'http://127.0.0.1:8983';
const SHOTS = 20;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-fx-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
}

fs.mkdirSync('screenshots/proof', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  defaultViewport: { width: 1600, height: 1000 },
  protocolTimeout: 300000,
});

let summary = null;
try {
  const page = await browser.newPage();
  const errors = [];
  const failed = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('requestfailed', (r) => failed.push({ url: r.url(), err: r.failure()?.errorText }));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
  });
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 240000 });
  await page.waitForFunction('window.__game !== undefined', { timeout: 120000 });
  await sleep(1200);
  await page.click('#start-btn');
  await page.waitForFunction(() => window.__game.state.started === true, { timeout: 90000 });
  await sleep(2500);
  await page.evaluate(() => {
    const hud = document.getElementById('hud');
    if (hud) hud.style.display = 'none'; // the HUD would sit over the barrel
    // daylight for the captures: dayT runs 0.25 (sunrise) .. 0.78 (night) and the clock advances
    // as the harness waits, so an unfixed time can photograph the same effect in the dark
    window.__game._test.setTime(0.34);
  });
  await sleep(400);

  // ------------------------------------------------------------------ 1. flash at the barrel
  const flash = await page.evaluate(async () => {
    const g = window.__game;
    const THREE = g.THREE;
    g.player.ammo.pistol = { mag: 40, reserve: 120 };
    g.equipWeapon('pistol');
    const spawn = g.city.getSpawn();
    g._test.teleport(spawn.x, spawn.z);
    g.player.aimHold = 9; // hold the arm up, the pose a trigger pull puts it in
    await new Promise((r) => setTimeout(r, 500));

    const spec = g.weaponSpec;
    const model = g.scene.getObjectByName(spec.model);
    if (!model) return { error: `no held model ${spec.model}` };
    model.updateWorldMatrix(true, false);
    const tip = model.localToWorld(new THREE.Vector3(...spec.muzzle));
    const yaw = g.player.yaw;
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const cam = g.camera;
    // a 3/4 on the barrel: off the muzzle's right shoulder, slightly behind the tip, eye level
    const camPos = tip.clone().addScaledVector(right, 1.25).addScaledVector(fwd, -0.55).setY(tip.y + 0.12);
    cam.fov = 34;
    cam.updateProjectionMatrix();
    cam.position.copy(camPos);
    cam.updateMatrixWorld(true);
    cam.lookAt(tip);
    cam.updateMatrixWorld(true);
    g._test.freezeLoop(true); // freeze: the 60 ms flash must not expire mid-capture
    await new Promise((r) => setTimeout(r, 250));
    g.player.shootCd = 0;
    g._test.shoot();
    // the loop is frozen: draw the parked frame ourselves, or the canvas still holds the last
    // follow-camera frame and the capture would photograph the wrong view
    g.renderer.render(g.scene, cam);
    const sprite = (() => {
      let live = null;
      g.scene.traverse((o) => {
        if (o.name === 'muzzle-flash' && o.visible) live = o;
      });
      return live;
    })();
    const p = tip.clone().project(cam);
    return {
      tip: tip.toArray().map((n) => +n.toFixed(3)),
      flashPos: sprite ? sprite.position.toArray().map((n) => +n.toFixed(3)) : null,
      offsetFromTip: sprite ? +sprite.position.distanceTo(tip).toFixed(4) : null,
      scale: sprite ? +sprite.scale.x.toFixed(2) : null,
      cam: camPos.toArray().map((n) => +n.toFixed(2)),
      camDist: +camPos.distanceTo(tip).toFixed(2),
      screen: { x: Math.round((p.x * 0.5 + 0.5) * innerWidth), y: Math.round((-p.y * 0.5 + 0.5) * innerHeight) },
      stats: g._test.shotFx(),
    };
  });
  if (flash.error) throw new Error(flash.error);
  console.log('FLASH', JSON.stringify(flash));
  check('flash sits on the barrel tip', flash.offsetFromTip !== null && flash.offsetFromTip < 0.05, flash.offsetFromTip);
  check('flash is inside the frame', flash.screen.x > 80 && flash.screen.x < 1520 && flash.screen.y > 80 && flash.screen.y < 920, flash.screen);

  const flashProof = await captureEffect(page, 'screenshots/proof/muzzle-flash.png', flash.screen, 260);
  check('muzzle-flash.png shows the flash (pixels that vanish when the effect is cleared)', flashProof.hot >= 400, {
    changed: flashProof.changed, hot: flashProof.hot, drift: flashProof.drift, meanLuma: flashProof.meanLuma, cleanLuma: flashProof.cleanLuma,
  });
  const hb = flashProof.hotBox;
  const scale = 1600 / 1600;
  check('the hot core sits on the barrel tip', hb !== null && Math.abs(hb.x + hb.w / 2 - flash.screen.x) <= 900 && flash.screen.x >= hb.x - 60 && flash.screen.x <= hb.x + hb.w + 60 && flash.screen.y >= hb.y - 60 && flash.screen.y <= hb.y + hb.h + 60, {
    hotBox: hb, barrelOnScreen: flash.screen, scale,
  });

  // ------------------------------------------------------------------ 2. impact on a wall
  const impact = await page.evaluate(async () => {
    const g = window.__game;
    const THREE = g.THREE;
    g._test.freezeLoop(false); // resume the loop so the player and camera settle
    g.equipWeapon('pistol');
    const cols = (g.city.colliders || []).filter((c) => (c.h ?? 30) > 6 && c.maxX - c.minX > 6 && c.maxZ - c.minZ > 6);
    if (!cols.length) return { error: 'no building colliders' };
    const spawn = g.city.getSpawn();
    // nearest big blocks to the spawn first
    cols.sort((a, b) => {
      const da = Math.hypot((a.minX + a.maxX) / 2 - spawn.x, (a.minZ + a.maxZ) / 2 - spawn.z);
      const db = Math.hypot((b.minX + b.maxX) / 2 - spawn.x, (b.minZ + b.maxZ) / 2 - spawn.z);
      return da - db;
    });
    await new Promise((r) => setTimeout(r, 200));
    // The shot ray leaves the follow camera, which looks down at the player's head from a boom
    // that never drops below y = 0.75 while the colliders stand on y = 0. Past ~9 m the ray is
    // under the collider floor and every wall "misses", so the approach distance is part of the
    // search instead of a constant: stand close enough that the ray reaches the facade.
    const distances = [1.6, 2.2, 2.8, 3.4, 4.2];
    let picked = null;
    const tried = [];
    for (const c of cols.slice(0, 5)) {
      const cx = (c.minX + c.maxX) / 2;
      const cz = (c.minZ + c.maxZ) / 2;
      const hx = (c.maxX - c.minX) / 2;
      const hz = (c.maxZ - c.minZ) / 2;
      for (const face of ['+x', '-x', '+z', '-z']) {
        for (const dist of distances) {
          const px = face === '+x' ? cx + hx + dist : face === '-x' ? cx - hx - dist : cx;
          const pz = face === '+z' ? cz + hz + dist : face === '-z' ? cz - hz - dist : cz;
          g._test.teleport(px, pz);
          g._test.face(cx, cz);
          g._test.setCam(g._test.camYaw, 0);
          await new Promise((r) => setTimeout(r, 200));
          g.player.mag = 60; // the search spends rounds: a reload would silently skip the shot
          g.player.shootCd = 0;
          g._test.shoot();
          const shot = window.__lastShot;
          if (shot && shot.hitKind === 'wall') {
            // freeze in the same tick as the shot that hit: no frame can move the camera or age
            // the puff between the hit and the capture
            g._test.freezeLoop(true);
            picked = { shot, face: { px: +px.toFixed(1), pz: +pz.toFixed(1), dist }, box: { cx: +cx.toFixed(1), cz: +cz.toFixed(1) } };
            break;
          }
          tried.push({ face, dist, kind: shot?.hitKind ?? null, bestDist: shot?.bestDist ?? null });
          g._test.fxReset();
        }
        if (picked) break;
      }
      if (picked) break;
    }
    if (!picked) return { error: 'could not hit a wall from any approach', tried: tried.slice(0, 12) };

    const shot = picked.shot;
    // the effect is exactly one frame old; step a fixed 72 ms so the dust has expanded.
    // Wall-clock waits are useless here: under SwiftShader a "110 ms" wait is 1-2 frames, and
    // sometimes zero, depending on machine load.
    for (let i = 0; i < 4; i++) g._test.stepFx(0.018); // ~72 ms: chips up, dust open, flash done
    const hp = new THREE.Vector3(...shot.hitPoint);
    const dir = new THREE.Vector3(...shot.dir);
    const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    // The player stands ~1.6 m off the wall and the boom camera sits behind them, so a lens on the
    // shot line photographs the player's back instead of the impact (that capture is why this
    // frame has candidates now). Step off to the side and prove the sight line is empty.
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const solidAt = (x, y, z) => g.city.colliders.some((c) => x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ && y < (c.h ?? 30) && y > -2);
    const clearLine = (a, b) => {
      for (let i = 1; i < 14; i++) {
        const t = (i / 15) * 0.92;
        if (solidAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t)) return false;
      }
      // and the shooter's own body may not sit in front of the wall
      const chest = new THREE.Vector3(g.player.pos.x, g.player.y + 1.2, g.player.pos.z);
      const seg = b.clone().sub(a);
      const t = clamp01(chest.clone().sub(a).dot(seg) / seg.lengthSq());
      const closest = a.clone().addScaledVector(seg, t);
      return closest.distanceTo(chest) > 0.55;
    };
    // close and slightly off-axis: a longer boom puts street furniture (a post, a cart) between
    // the lens and the wall, and a wide lens shrinks the puff to a handful of pixels
    const candidates = [
      { back: 1.9, side: 1.15, up: 0.3 },
      { back: 1.9, side: -1.15, up: 0.3 },
      { back: 1.5, side: 0.95, up: 0.28 },
      { back: 1.5, side: -0.95, up: 0.28 },
    ];
    let framed = null;
    const rejected = [];
    for (const c of candidates) {
      const pos = hp.clone().addScaledVector(dir, -c.back).addScaledVector(side, c.side).add(new THREE.Vector3(0, c.up, 0));
      if (!clearLine(pos, hp)) { rejected.push(c); continue; }
      framed = { pos, c };
      break;
    }
    const camPos = (framed ? framed.pos : hp.clone().addScaledVector(dir, -1.9).addScaledVector(side, 1.15).add(new THREE.Vector3(0, 0.3, 0))).clone();
    const cam = g.camera;
    cam.fov = 32;
    cam.updateProjectionMatrix();
    cam.position.copy(camPos);
    cam.updateMatrixWorld(true);
    cam.lookAt(hp);
    cam.updateMatrixWorld(true);
    g.renderer.render(g.scene, cam); // frozen loop: draw the parked frame ourselves
    const p = hp.clone().project(cam);
    const stats = g._test.shotFx();
    return {
      face: picked.face,
      hitPoint: picked.shot.hitPoint,
      hitKind: picked.shot.hitKind,
      cam: camPos.toArray().map((n) => +n.toFixed(2)),
      camDist: +camPos.distanceTo(hp).toFixed(2),
      screen: { x: Math.round((p.x * 0.5 + 0.5) * innerWidth), y: Math.round((-p.y * 0.5 + 0.5) * innerHeight) },
      stats,
      framing: framed ? framed.c : 'fallback',
      rejected,
    };
  });
  if (impact.error) throw new Error(impact.error);
  console.log('IMPACT', JSON.stringify({ ...impact, stats: undefined }));
  check('impact landed on a wall', impact.hitKind === 'wall', impact.hitKind);
  check('impact particles are live in the frame', impact.stats.liveParticles >= 8, impact.stats);

  const impactProof = await captureEffect(page, 'screenshots/proof/bullet-impact.png', impact.screen, 300);
  check('bullet-impact.png shows the puff (pixels that vanish when the effect is cleared)', impactProof.changed >= 800 && impactProof.hot >= 40, {
    changed: impactProof.changed, hot: impactProof.hot, drift: impactProof.drift, meanLuma: impactProof.meanLuma, cleanLuma: impactProof.cleanLuma,
  });
  check('the puff covers the point the ray hit', impactProof.atHit >= 120, {
    changedAtHitPoint: impactProof.atHit, hitOnScreen: impact.screen, changedBox: impactProof.changedBox,
  });

  // ------------------------------------------------------------------ 3. flash window
  const flashWindow = await page.evaluate(async () => {
    const g = window.__game;
    g._test.freezeLoop(true);
    g.player.ammo.pistol = { mag: 60, reserve: 120 };
    g.equipWeapon('pistol');
    await new Promise((r) => setTimeout(r, 120));
    g.player.mag = 60;
    g.player.shootCd = 0;
    g._test.shoot();
    const alive = [];
    let ms = 0;
    const step = 8; // ms of simulation per sample, well under the flash's own lifetime
    for (let i = 0; i < 40; i++) {
      const s = g._test.shotFx();
      alive.push(s.liveFlashes);
      if (s.liveFlashes === 0 && i > 0) break;
      g._test.stepFx(step / 1000);
      ms += step;
    }
    // the flash is visible from the shot until the step that takes it below zero
    return { ms: ms - step, samples: alive.join(''), steps: alive.length, configured: 60 };
  });
  console.log('FLASH-WINDOW', JSON.stringify(flashWindow));
  check('flash lives ~60 ms (stepped at 8 ms)', flashWindow.ms >= 48 && flashWindow.ms <= 88, flashWindow);

  // ------------------------------------------------------------------ 4. pool run: 20 shots
  // The world is frozen for this run on purpose. Traffic and the police keep building new car
  // geometry while the loop runs, which buries the effect's own footprint and made an earlier
  // version of this check read idle traffic as "firing allocates". Frozen + a manual frame per
  // shot isolates it: any object the effect builds now cannot be blamed on the street.
  const pool = await page.evaluate(async (shots) => {
    const g = window.__game;
    const THREE = g.THREE;
    g.player.ammo.uzi = { mag: 300, reserve: 300 };
    g.equipWeapon('uzi');
    g._test.freezeLoop(true);
    g._test.fxReset();
    await new Promise((r) => setTimeout(r, 150));
    const census = () => {
      const c = { flash: 0, tracer: 0, sparks: 0, dust: 0 };
      g.scene.traverse((o) => {
        if (o.name === 'muzzle-flash') c.flash++;
        else if (o.name === 'shot-tracer') c.tracer++;
        else if (o.name === 'shot-sparks') c.sparks++;
        else if (o.name === 'shot-dust') c.dust++;
      });
      return c;
    };
    const counters = () => ({
      objects: (() => { let n = 0; g.scene.traverse(() => n++); return n; })(),
      sceneChildren: g.scene.children.length,
      geometries: g.renderer.info.memory.geometries,
      textures: g.renderer.info.memory.textures,
      programs: g.renderer.info.programs.length,
      peds: g.peds.peds.length,
      policeCars: g.police.cars.length,
      trafficCars: g.traffic.cars.length,
      ragdolls: g.ragdolls.length,
    });
    const frame = () => g.renderer.render(g.scene, g.camera);
    // warm-up: 14 shots, because the tracer pool holds 12 lines and the flash pool 4 sprites.
    // Their geometries upload to the GPU the first time each slot is DRAWN, so a shorter warm-up
    // leaves 8 one-time uploads inside the measured window and they read as "firing allocates".
    for (let i = 0; i < 14; i++) {
      g.player.mag = 300;
      g.player.shootCd = 0;
      g._test.shoot();
      g._test.stepFx(0.033);
      frame();
    }
    g._test.fxReset();
    g._test.stepFx(0.6); // let the warm-up particles die: the pool must be empty for the peak count
    frame();
    // control: 20 frames of war with no shots. Anything that grows here is the renderer, not us.
    const idleBefore = counters();
    for (let i = 0; i < 20; i++) {
      g._test.stepFx(0.033);
      frame();
    }
    const idleAfter = counters();
    const warm = { ...g._test.shotFx(), ...counters(), census: census() };

    let peakObserved = 0;
    let liveParticlesMax = 0;
    let liveFlashesMax = 0;
    const perShot = [];
    g.police.addWanted(-99);
    for (let i = 0; i < shots; i++) {
      g.player.mag = 300;
      g.player.shootCd = 0;
      g._test.shoot();
      g.police.addWanted(-99);
      g._test.stepFx(0.033);
      frame();
      const s = g._test.shotFx();
      perShot.push(s.live);
      if (s.live > peakObserved) peakObserved = s.live;
      if (s.liveParticles > liveParticlesMax) liveParticlesMax = s.liveParticles;
      if (s.liveFlashes > liveFlashesMax) liveFlashesMax = s.liveFlashes;
    }
    const after = { ...g._test.shotFx(), ...counters(), census: census() };
    // and the pool drains when the firing stops
    for (let i = 0; i < 40; i++) g._test.stepFx(0.033);
    const drained = g._test.shotFx();
    return { shots, warm, after, idle: { before: idleBefore, after: idleAfter }, peakObserved, liveParticlesMax, liveFlashesMax, perShot, capacity: after.capacity, drained };
  }, SHOTS);
  console.log('POOL', JSON.stringify(pool, null, 1));
  summary = pool;

  check(`fired ${SHOTS} shots`, pool.shots === SHOTS);
  const idleDelta = {
    objects: pool.idle.after.objects - pool.idle.before.objects,
    sceneChildren: pool.idle.after.sceneChildren - pool.idle.before.sceneChildren,
    geometries: pool.idle.after.geometries - pool.idle.before.geometries,
    textures: pool.idle.after.textures - pool.idle.before.textures,
  };
  check('the control frames allocate nothing (counters are trustworthy)', Object.values(idleDelta).every((v) => v === 0), idleDelta);
  check('no objects allocated per shot', pool.after.allocations === pool.warm.allocations, {
    warm: pool.warm.allocations,
    after: pool.after.allocations,
  });
  check('the same pooled sprites/lines/points are reused', JSON.stringify(pool.warm.census) === JSON.stringify(pool.after.census), {
    warm: pool.warm.census,
    after: pool.after.census,
  });
  check('scene objects do not grow while firing',
    pool.after.objects === pool.warm.objects && pool.after.sceneChildren === pool.warm.sceneChildren,
    { objects: [pool.warm.objects, pool.after.objects], sceneChildren: [pool.warm.sceneChildren, pool.after.sceneChildren] });
  check('GPU geometries/textures/programs do not grow while firing', idleDelta.objects === 0 &&
    pool.after.geometries === pool.warm.geometries && pool.after.textures === pool.warm.textures && pool.after.programs === pool.warm.programs,
    {
      geometries: [pool.warm.geometries, pool.after.geometries],
      textures: [pool.warm.textures, pool.after.textures],
      programs: [pool.warm.programs, pool.after.programs],
    });
  check('peak live particles stay inside the pool',
    pool.peakObserved > 0 && pool.peakObserved <= pool.capacity.particles + pool.capacity.flashes + pool.capacity.tracers,
    { peakObserved: pool.peakObserved, liveParticles: pool.liveParticlesMax, liveFlashes: pool.liveFlashesMax, capacity: pool.capacity, perShot: pool.perShot });
  check('the pool drains after the firing stops', pool.drained.live === 0, pool.drained);

  check('no page errors', errors.length === 0, errors.slice(0, 3));
  const broken = failed.filter((f) => !/\.(mp3|ogg|wav|m4a)(\?|$)/i.test(f.url));
  check('no failed resources', broken.length === 0, broken.slice(0, 3));

  console.log('\nSUMMARY', JSON.stringify({
    shots: SHOTS,
    peakLive: pool.peakObserved,
    peakLiveInternal: pool.after.peakLive,
    liveParticlesPeak: pool.liveParticlesMax,
    drained: pool.drained.live,
    allocations: { warm: pool.warm.allocations, after: pool.after.allocations, controlDelta: idleDelta },
    pooled: pool.after.pooled,
    flashOffsetFromBarrel: flash.offsetFromTip,
    flashWindowMs: flashWindow.ms,
    flashHotPixels: flashProof.hot,
    impactPixels: impactProof.changed,
    artifacts: ['screenshots/proof/muzzle-flash.png', 'screenshots/proof/bullet-impact.png'],
  }, null, 1));

  const failedChecks = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failedChecks.length}/${results.length} checks`);
  if (failedChecks.length) throw new Error(`failed: ${failedChecks.map((r) => r.name).join(', ')}`);
  console.log('OK bullets: pooled flash + impact proven');
} finally {
  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

/**
 * Screenshot the live effect, then the same camera with the effects cleared, and report how many
 * pixels the effect actually owns. The saved PNG is measured, not the in-page canvas: a headless
 * capture can commit an empty WebGL buffer.
 */
async function captureEffect(page, out, screen, radius) {
  const clean = path.join(TMP, `clean-${path.basename(out)}`);
  const control = path.join(TMP, `control-${path.basename(out)}`);
  const draw = () => page.evaluate(() => {
    const g = window.__game;
    g.renderer.render(g.scene, g.camera);
  });
  // 1: the effect, 2: the same frame again (catches capture drift), 3: effect cleared.
  // The loop is frozen for all three, so the only allowed difference is the effect itself.
  await draw();
  await sleep(150);
  await page.screenshot({ path: out });
  await draw();
  await sleep(150);
  await page.screenshot({ path: control });
  await page.evaluate(() => {
    const g = window.__game;
    g._test.fxReset();
    g.renderer.render(g.scene, g.camera);
  });
  await sleep(150);
  await page.screenshot({ path: clean });
  const a = decodePng(fs.readFileSync(out));
  const a2 = decodePng(fs.readFileSync(control));
  const b = decodePng(fs.readFileSync(clean));
  if (a.channels !== b.channels || a.channels !== a2.channels) {
    throw new Error(`capture format drifted: ${a.channels}/${a2.channels}/${b.channels} channels`);
  }
  const scale = a.width / page.viewport().width;
  const rect = {
    x: Math.max(0, Math.round((screen.x - radius) * scale)),
    y: Math.max(0, Math.round((screen.y - radius) * scale)),
    w: Math.round(radius * 2 * scale),
    h: Math.round(radius * 2 * scale),
  };
  const diff = countDiff(a, b, rect);
  // pixels the effect owns in a 40 px window on the hit point itself
  const near = {
    x: Math.max(0, Math.round((screen.x - 40) * scale)),
    y: Math.max(0, Math.round((screen.y - 40) * scale)),
    w: Math.round(80 * scale),
    h: Math.round(80 * scale),
  };
  const atHit = countDiff(a, b, near).changed;
  return {
    file: out,
    rect,
    changed: diff.changed,
    warm: diff.warm,
    hot: diff.hot,
    hotBox: diff.hotBox,
    changedBox: diff.changedBox,
    atHit,
    drift: countDiff(a, a2, rect).changed,
    meanLuma: meanLuma(a),
    cleanLuma: meanLuma(b),
  };
}

function countDiff(a, b, rect) {
  let changed = 0;
  let warm = 0;
  let hot = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let cMinX = Infinity, cMinY = Infinity, cMaxX = -Infinity, cMaxY = -Infinity;
  const { width, channels, data } = a;
  const bd = b.data;
  const x1 = Math.min(a.width, rect.x + rect.w);
  const y1 = Math.min(a.height, rect.y + rect.h);
  for (let y = rect.y; y < y1; y++) {
    for (let x = rect.x; x < x1; x++) {
      const i = (y * width + x) * channels;
      const d = Math.abs(data[i] - bd[i]) + Math.abs(data[i + 1] - bd[i + 1]) + Math.abs(data[i + 2] - bd[i + 2]);
      if (d > 26) {
        changed++;
        if (x < cMinX) cMinX = x;
        if (x > cMaxX) cMaxX = x;
        if (y < cMinY) cMinY = y;
        if (y > cMaxY) cMaxY = y;
        if (data[i] > 150 && data[i] >= data[i + 2]) warm++;
        // hot = the effect's own core: bright and warm, and only where the cleared frame was dark
        if (data[i] > 170 && data[i + 1] > 130 && data[i] - bd[i] > 30) {
          hot++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  }
  const changedBox = changed ? { x: cMinX, y: cMinY, w: cMaxX - cMinX, h: cMaxY - cMinY } : null;
  return { changed, warm, hot, changedBox, hotBox: hot ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null };
}

function meanLuma(png) {
  const { width, height, channels, data } = png;
  let sum = 0;
  for (let i = 0; i < width * height; i++) {
    sum += 0.2126 * data[i * channels] + 0.7152 * data[i * channels + 1] + 0.0722 * data[i * channels + 2];
  }
  return +(sum / (width * height)).toFixed(1);
}

/** Minimal PNG reader: the repo has no image library. */
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
