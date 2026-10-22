/**
 * Persistence harness: proves the localStorage save/load round trip, the settings
 * blob, the corrupt-payload guard and a clean in-place restart, and captures the
 * full-screen map for review.
 *
 *   node tests/persistence.mjs                    # starts its own vite on :8797
 *   DTA_URL=http://localhost:8797 node tests/persistence.mjs
 *
 * Writes screenshots/map-screen.png.
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const ROOT = new URL('..', import.meta.url).pathname;
const OUT = path.join(ROOT, 'screenshots');
const PORT = 8797;
const BASE = process.env.DTA_URL || `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}

/** Startup: reuse DTA_URL, otherwise serve the worktree on 8797 so the run is self-contained. */
async function ensureServer() {
  if (process.env.DTA_URL) return null;
  const child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${BASE}/index.html`);
      if (res.ok) return child;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  child.kill('SIGTERM');
  throw new Error(`vite did not answer on ${BASE}`);
}

const server = await ensureServer();

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1440, height: 900 },
});

try {
  const page = await browser.newPage();
  const errs = [];
  const warns = [];
  // media/range requests get aborted when a headless run reloads audio: transport
  // noise, not a page error. Real JS exceptions and console errors still fail.
  const IGNORE = /ERR_CONNECTION_RESET|ERR_SOCKET_NOT_CONNECTED|ERR_ABORTED|Failed to load resource: net::/;
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !IGNORE.test(m.text())) errs.push('console: ' + m.text());
    // puppeteer reports console.warn as 'warn' on some versions and 'warning' on others
    if (['warn', 'warning'].includes(m.type()) && m.text().includes('[dta]')) warns.push(m.text());
  });

  const boot = async () => {
    await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__game !== undefined', { timeout: 40000 });
    await sleep(900);
  };
  const state = () => page.evaluate(() => window.__game.state);
  const saveWarns = () => warns.filter((w) => w.includes('[dta]')).length;

  // ---------------------------------------------------------------- fresh boot
  await boot();
  await page.evaluate(() => localStorage.clear());
  errs.length = 0;
  warns.length = 0;
  await boot();

  const start = await page.evaluate(() => ({
    label: document.getElementById('start-btn').textContent.trim(),
    status: document.getElementById('save-status').textContent.trim(),
    hasSave: localStorage.getItem('dta.save.v1') !== null,
  }));
  check('fresh profile boots with no save and no console errors', errs.length === 0 && !start.hasSave && /start/i.test(start.label), {
    errs: errs.slice(0, 4),
    start,
  });

  // ---------------------------------------------------------------- play, change, pause-save
  await page.click('#start-btn');
  await sleep(1800);
  let st = await state();
  check('start unpauses', st.started === true && st.paused === false, { paused: st.paused });

  // walk so the saved position is somewhere other than the spawn point
  await page.evaluate(() => {
    const g = window.__game;
    g._test.teleport(26, -40);
    g._test.setCam(Math.PI, 0.1);
  });
  await sleep(400);
  await page.keyboard.down('w');
  await sleep(1100);
  await page.keyboard.up('w');
  await sleep(300);

  await page.evaluate(() => {
    const g = window.__game;
    g._test.addCash(1234);
    g._test.setTime(0.71);
    g.police.addWanted(2);
    g.equipWeapon('uzi'); // a non-default weapon proves the slot survives too
    g._test.shoot(); // spend ammo so "restored" is a number below the magazine
    g.objectives.drove = true; // objective progress must survive the round trip
  });
  await sleep(400);
  await page.evaluate(() => window.__game._test.shoot());
  await sleep(250);
  const before = await page.evaluate(() => {
    const g = window.__game;
    return {
      pos: g.player.pos.toArray().map((v) => +v.toFixed(3)),
      yaw: +g.player.yaw.toFixed(3),
      cash: g.player.cash,
      mag: g.player.mag,
      weapon: g.player.weapon,
      reserve: g.player.ammo[g.player.weapon]?.reserve ?? null,
      weapons: JSON.parse(JSON.stringify(g.player.ammo)),
      wanted: +g.police.wanted.toFixed(2),
      dayT: +g.state.dayT.toFixed(4),
      objectives: { ...g.objectives },
    };
  });

  // pausing is one of the two save triggers (the other is the 20 s autosave)
  await page.keyboard.press('Escape');
  await sleep(700);
  const rawSave = await page.evaluate(() => localStorage.getItem('dta.save.v1'));
  const parsed = rawSave ? JSON.parse(rawSave) : null;
  check(
    'pause writes a versioned dta.save.v1',
    !!parsed &&
      parsed.version === 1 &&
      typeof parsed.player?.x === 'number' &&
      typeof parsed.player?.camYaw === 'number' &&
      typeof parsed.cash === 'number' &&
      typeof parsed.dayT === 'number' &&
      typeof parsed.wanted === 'number' &&
      typeof parsed.ammo === 'number' &&
      typeof parsed.weapon === 'string' &&
      typeof parsed.weapons === 'object' &&
      Array.isArray(parsed.ownedWeapons) &&
      typeof parsed.objectives === 'object',
    parsed && {
      version: parsed.version,
      cash: parsed.cash,
      dayT: parsed.dayT,
      wanted: parsed.wanted,
      ammo: parsed.ammo,
      weapon: parsed.weapon,
      weapons: parsed.weapons,
    }
  );
  check('objective progress is saved', !!parsed && parsed.objectives.drove === true, parsed && parsed.objectives);
  check(
    'equipped weapon and its ammo are saved',
    !!parsed && parsed.weapon === before.weapon && parsed.ammo === before.mag && parsed.weapons?.[before.weapon]?.mag === before.mag,
    parsed && { weapon: parsed.weapon, ammo: parsed.ammo, weapons: parsed.weapons }
  );
  check('saved payload matches live state', !!parsed && parsed.cash === before.cash && Math.abs(parsed.dayT - before.dayT) < 0.01, {
    saved: parsed && { cash: parsed.cash, dayT: parsed.dayT },
    live: before,
  });

  // ---------------------------------------------------------------- reload, continue
  errs.length = 0;
  warns.length = 0;
  await boot();
  const offer = await page.evaluate(() => ({
    label: document.getElementById('start-btn').textContent.trim(),
    status: document.getElementById('save-status').textContent.trim(),
  }));
  check('start screen offers Continue when a save exists', /continue/i.test(offer.label) && /save/i.test(offer.status), offer);
  check('clean save boots without a persistence warning', saveWarns() === 0, { warns });

  await page.click('#start-btn');
  await sleep(1400);
  const after = await page.evaluate(() => {
    const g = window.__game;
    return {
      pos: g.player.pos.toArray().map((v) => +v.toFixed(3)),
      yaw: +g.player.yaw.toFixed(3),
      cash: g.player.cash,
      mag: g.player.mag,
      weapon: g.player.weapon,
      reserve: g.player.ammo[g.player.weapon]?.reserve ?? null,
      wanted: +g.police.wanted.toFixed(2),
      dayT: +g.state.dayT.toFixed(4),
      paused: g.state.paused,
      objectives: { ...g.objectives },
    };
  });
  const drift = Math.hypot(after.pos[0] - before.pos[0], after.pos[2] - before.pos[2]);
  check('player position restored', drift < 0.75, { drift: +drift.toFixed(3), before: before.pos, after: after.pos });
  check('player yaw restored', Math.abs(after.yaw - before.yaw) < 0.05, { before: before.yaw, after: after.yaw });
  check('cash restored exactly', after.cash === before.cash, { before: before.cash, after: after.cash });
  check('time of day restored within 0.02', Math.abs(after.dayT - before.dayT) < 0.02, { before: before.dayT, after: after.dayT });
  // the wanted meter keeps cooling down while the restore is in flight, so allow one decay tick
  check('wanted level restored', Math.abs(after.wanted - before.wanted) < 0.2, { before: before.wanted, after: after.wanted });
  check('ammo restored', after.mag === before.mag, { before: before.mag, after: after.mag });
  check(
    'equipped weapon and its reserve restored',
    after.weapon === before.weapon && before.weapon === 'uzi' && after.reserve === before.reserve && after.mag === before.mag,
    { before: { weapon: before.weapon, reserve: before.reserve, mag: before.mag }, after: { weapon: after.weapon, reserve: after.reserve, mag: after.mag } }
  );
  check('objective progress restored', after.objectives.drove === true && after.objectives.chaos === before.objectives.chaos, {
    before: before.objectives,
    after: after.objectives,
  });
  check('continue unpauses', after.paused === false, { paused: after.paused });
  check('no console errors during restore', errs.length === 0, errs.slice(0, 4));

  // ---------------------------------------------------------------- autosave beat
  const beat0 = await page.evaluate(() => JSON.parse(localStorage.getItem('dta.save.v1')).savedAt);
  await page.evaluate(() => {
    const g = window.__game;
    // park the chase so a fine/arrest cannot move the cash while we wait for the beat
    g.police.clearWanted();
    g.police.clearAll();
    g._test.addCash(77);
  });
  // poll instead of sleeping blind: a host that drops pointer lock auto-pauses, and a
  // paused sim legitimately stops autosaving. Only a save seen while running counts.
  let beat = null;
  let pauses = 0;
  for (let i = 0; i < 34; i++) {
    await sleep(1000);
    const s = await page.evaluate(() => ({
      paused: window.__game.state.paused,
      savedAt: JSON.parse(localStorage.getItem('dta.save.v1')).savedAt,
      cash: JSON.parse(localStorage.getItem('dta.save.v1')).cash,
    }));
    if (s.paused) {
      pauses++;
      await page.keyboard.press('Escape');
      continue;
    }
    if (s.savedAt > beat0) {
      beat = s;
      break;
    }
  }
  check('autosaves on the 20 s beat while playing', !!beat && beat.savedAt - beat0 >= 15000 && beat.cash > before.cash, {
    first: beat0,
    second: beat ? beat.savedAt : null,
    gapMs: beat ? beat.savedAt - beat0 : null,
    cash: beat ? beat.cash : null,
    unexpectedPauses: pauses,
  });

  // ---------------------------------------------------------------- settings round trip
  await page.evaluate(() => {
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('set-sens', 1.8);
    set('set-master', 0.5);
    set('set-sfx', 0.4);
    set('set-bgm', 0.25);
    set('set-scale', 0.8);
    for (const [id, on] of [['set-invert', true], ['set-fps-show', false]]) {
      const box = document.getElementById(id);
      box.checked = on;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await sleep(500);
  const live = await page.evaluate(() => {
    const g = window.__game;
    return {
      settings: { ...g.settings },
      masterVol: g.audio.masterVol,
      sfxVol: g.audio.sfxVol,
      bgmVol: g.audio.bgmVol,
      pixelRatio: +g.renderer.getPixelRatio().toFixed(3),
      pixelCap: g.state.pixelCap,
      fpsChip: getComputedStyle(document.getElementById('fps')).display,
      stored: JSON.parse(localStorage.getItem('dta.settings.v1') || 'null'),
    };
  });
  check(
    'settings applied live and wired to AudioSys',
    live.settings.sensitivity === 1.8 &&
      live.settings.invertY === true &&
      live.settings.showFps === false &&
      Math.abs(live.masterVol - 0.5) < 1e-6 &&
      Math.abs(live.sfxVol - 0.4) < 1e-6 &&
      Math.abs(live.bgmVol - 0.25) < 1e-6 &&
      live.fpsChip === 'none' &&
      live.pixelCap === 0.8 &&
      live.pixelRatio <= 0.8,
    live
  );
  check('settings written to dta.settings.v1', !!live.stored && live.stored.version === 1 && live.stored.sensitivity === 1.8, live.stored);

  await boot();
  const restored = await page.evaluate(() => ({
    settings: { ...window.__game.settings },
    stored: JSON.parse(localStorage.getItem('dta.settings.v1') || 'null'),
    fpsChip: getComputedStyle(document.getElementById('fps')).display,
  }));
  check(
    'settings restored on boot',
    restored.settings.sensitivity === 1.8 &&
      restored.settings.invertY === true &&
      restored.settings.showFps === false &&
      Math.abs(restored.settings.renderScale - 0.8) < 1e-6 &&
      restored.fpsChip === 'none',
    restored
  );

  // a corrupt options blob must not take the game down either
  await page.evaluate(() => localStorage.setItem('dta.settings.v1', 'not json at all'));
  warns.length = 0;
  errs.length = 0;
  await boot();
  const badSettings = await page.evaluate(() => ({
    sensitivity: window.__game.settings.sensitivity,
    showFps: window.__game.settings.showFps,
    key: localStorage.getItem('dta.settings.v1'),
  }));
  check('corrupt settings fall back to defaults with one warning', saveWarns() === 1 && badSettings.sensitivity === 1 && badSettings.showFps === true, {
    warns,
    badSettings,
  });
  check('no uncaught errors on corrupt settings', errs.length === 0, errs.slice(0, 4));

  // ---------------------------------------------------------------- corrupt payloads
  await page.evaluate(() => localStorage.setItem('dta.save.v1', '{ this is not json'));
  warns.length = 0;
  errs.length = 0;
  await boot();
  const corrupt = await page.evaluate(() => ({
    cash: window.__game.player.cash,
    pos: window.__game.player.pos.toArray().map((v) => +v.toFixed(2)),
    label: document.getElementById('start-btn').textContent.trim(),
    key: localStorage.getItem('dta.save.v1'),
  }));
  const spawn = await page.evaluate(() => window.__game.city.getSpawn().toArray().map((v) => +v.toFixed(2)));
  check('corrupt save falls back to a fresh game with one warning', saveWarns() === 1 && corrupt.cash === 250 && /start/i.test(corrupt.label), {
    warns,
    corrupt,
  });
  check('corrupt payload is dropped, not retried', corrupt.key === null, { key: corrupt.key });
  check('fresh spawn after corrupt save', Math.hypot(corrupt.pos[0] - spawn[0], corrupt.pos[2] - spawn[2]) < 1.5, { pos: corrupt.pos, spawn });
  check('no uncaught errors on corrupt boot', errs.length === 0, errs.slice(0, 4));

  await page.evaluate(() =>
    localStorage.setItem(
      'dta.save.v1',
      JSON.stringify({ version: 99, player: { x: 40, z: 40 }, cash: 9999, hp: 100, dayT: 0.2, objectives: {} })
    )
  );
  warns.length = 0;
  errs.length = 0;
  await boot();
  const unknown = await page.evaluate(() => ({ cash: window.__game.player.cash, key: localStorage.getItem('dta.save.v1') }));
  check('unknown schema version falls back with one warning', saveWarns() === 1 && unknown.cash === 250 && unknown.key === null, {
    warns,
    unknown,
  });
  check('no uncaught errors on version guard', errs.length === 0, errs.slice(0, 4));

  // ---------------------------------------------------------------- clean restart x3
  await page.click('#start-btn');
  await sleep(1600);
  // put transients in the scene first (cruisers, a corpse) so the restart has
  // something real to remove instead of a trivially empty diff
  await page.evaluate(() => {
    const g = window.__game;
    g.police.addWanted(3);
    const ped = g.peds.peds.find((p) => !p.dead);
    if (ped) g._test.punch();
  });
  await sleep(2200);
  const sceneBefore = await page.evaluate(() => ({
    children: window.__game.scene.children.length,
    peds: window.__game.peds.peds.length,
    cops: window.__game.police.cars.length,
    cash: window.__game.player.cash,
    pos: window.__game.player.pos.toArray().map((v) => +v.toFixed(1)),
  }));

  const restarts = [];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape');
    await sleep(500);
    await page.click('#pause-new-game');
    await sleep(900);
    restarts.push(
      await page.evaluate(() => ({
        children: window.__game.scene.children.length,
        peds: window.__game.peds.peds.length,
        cops: window.__game.police.cars.length,
        cash: window.__game.player.cash,
        hp: Math.round(window.__game.player.hp),
        weapon: window.__game.player.weapon,
        wanted: +window.__game.police.wanted.toFixed(2),
        dayT: +window.__game.state.dayT.toFixed(3),
        ragdolls: window.__game.state.ragdolls,
        key: localStorage.getItem('dta.save.v1') !== null,
        paused: window.__game.state.paused,
      }))
    );
  }
  console.log('RESTART scene children: before=' + sceneBefore.children + ' after=' + restarts.map((r) => r.children).join(','));
  const noGrowth = restarts.every((r) => r.children <= sceneBefore.children) && new Set(restarts.map((r) => r.children)).size === 1;
  check('scene does not grow after 3 restarts', noGrowth, { before: sceneBefore, restarts });
  check(
    'restart resets player, economy, wanted, time and crowd',
    restarts.every(
      (r) =>
        r.cash === 250 &&
        r.hp === 100 &&
        r.wanted === 0 &&
        r.weapon === 'pistol' &&
        Math.abs(r.dayT - 0.34) < 0.03 &&
        r.ragdolls === 0 &&
        r.peds === sceneBefore.peds
    ),
    restarts
  );
  check('restart leaves the run playable and saved', restarts.every((r) => r.paused === false && r.key === true), restarts);

  // ---------------------------------------------------------------- map screen
  errs.length = 0;
  await page.evaluate(() => {
    const g = window.__game;
    g._test.teleport(26, -40);
    g.police.addWanted(1);
  });
  await sleep(700);
  await page.keyboard.press('m');
  await sleep(900);
  const map = await page.evaluate(() => {
    const g = window.__game;
    const canvas = document.getElementById('bigmap');
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const dpr = canvas.width / window.innerWidth;
    const near = (r, g2, b, R, G, B, tol = 8) => Math.abs(r - R) <= tol && Math.abs(g2 - G) <= tol && Math.abs(b - B) <= tol;
    const count = (pred) => {
      let n = 0;
      for (let i = 0; i < img.length; i += 4) if (pred(img[i], img[i + 1], img[i + 2])) n++;
      return n;
    };
    // the player marker: sample a 9x9 CSS-pixel box around the projected position
    const proj = g.hud.mapProjection;
    const px = Math.round(proj.player[0] * dpr);
    const py = Math.round(proj.player[1] * dpr);
    const box = Math.round(4 * dpr);
    let marker = 0;
    for (let y = py - box; y <= py + box; y++) {
      for (let x = px - box; x <= px + box; x++) {
        if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue;
        const i = (y * canvas.width + x) * 4;
        if (img[i] > 220 && img[i + 1] > 160 && img[i + 2] < 110) marker++;
      }
    }
    return {
      open: g.state.mapOpen,
      paused: g.state.paused,
      rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      hudVisibility: getComputedStyle(document.getElementById('hud')).visibility,
      roads: count((r, g2, b) => near(r, g2, b, 22, 27, 34)),
      blocks: count((r, g2, b) => near(r, g2, b, 51, 58, 69)),
      parks: count((r, g2, b) => near(r, g2, b, 39, 75, 49)),
      shopPixels: count((r, g2, b) => near(r, g2, b, 255, 204, 51, 24)),
      markerPixels: marker,
      player: [px, py],
    };
  });
  check('M opens the map and pauses the sim', map.open === true && map.paused === true, { open: map.open, paused: map.paused });
  check(
    'map canvas covers the viewport and the HUD cannot overlap it',
    map.rect.w === map.viewport.w && map.rect.h === map.viewport.h && map.hudVisibility === 'hidden',
    { rect: map.rect, viewport: map.viewport, hudVisibility: map.hudVisibility }
  );
  check(
    'map draws roads, blocks, shops and the player marker',
    map.roads > 8000 && map.blocks > 8000 && map.parks > 500 && map.shopPixels > 200 && map.markerPixels > 20,
    map
  );
  check('no console errors while the map is open', errs.length === 0, errs.slice(0, 4));

  await page.screenshot({ path: path.join(OUT, 'map-screen.png') });

  await page.keyboard.press('Escape');
  await sleep(500);
  const closed = await page.evaluate(() => ({ open: window.__game.state.mapOpen, paused: window.__game.state.paused }));
  check('Esc closes the map and resumes the sim', closed.open === false && closed.paused === false, closed);

  // ---------------------------------------------------------------- full-run error tally
  check('no console/page errors in the whole run', errs.length === 0, errs.slice(0, 6));

  const failed = results.filter((r) => !r.ok);
  console.log('SUMMARY ' + JSON.stringify({ pass: results.length - failed.length, total: results.length }));
  console.log('FAILED ' + JSON.stringify(failed.map((f) => f.name)));
  if (failed.length) process.exitCode = 1;
} finally {
  await browser.close();
  if (server) server.kill('SIGTERM');
}
