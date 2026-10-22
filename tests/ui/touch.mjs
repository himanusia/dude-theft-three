/**
 * Touch-controls harness: emulates an iPhone, drives the on-screen layer with
 * synthetic pointer events, and proves geometry + behaviour.
 *
 *   node tests/touch.mjs                       # against http://localhost:8765
 *   DTA_URL=http://localhost:8793 node tests/touch.mjs
 *
 * Writes screenshots/touch-portrait.png and screenshots/touch-landscape.png.
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || 'http://localhost:8765';
const OUT = new URL('../screenshots', import.meta.url).pathname;
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}

/** dispatch a touch pointer event on window (the page listens there) */
async function pointer(page, type, id, x, y) {
  await page.evaluate((type, id, x, y) => {
    window.dispatchEvent(new PointerEvent(type, {
      pointerId: id,
      pointerType: 'touch',
      isPrimary: id === 1,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      bubbles: true,
      cancelable: true,
    }));
  }, type, id, x, y);
}

/** geometry audit: every HUD/touch box inside the viewport, none of them overlapping */
const layout = (page) => page.evaluate(() => {
  const hud = window.__game.hud;
  // force a prompt so the chip has real text to measure
  hud.setPrompt('E — masuk Warung Kopi');
  const boxes = [];
  const push = (sel, el) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    boxes.push({ sel, x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) });
  };
  for (const sel of ['#objective', '#topright', '#help-btn', '#minimap', '#ammo-wrap', '#health-wrap', '#prompt', '#speedo', '#touch-stick']) {
    push(sel, document.querySelector(sel));
  }
  for (const btn of document.querySelectorAll('.t-btn')) {
    push(`.t-btn[data-action=${btn.dataset.action}]`, btn);
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const outside = boxes.filter((b) => b.x < -0.5 || b.y < -0.5 || b.x + b.w > vw + 0.5 || b.y + b.h > vh + 0.5);
  const overlaps = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 1 && oy > 1) overlaps.push({ a: a.sel, b: b.sel, ox: +ox.toFixed(1), oy: +oy.toFixed(1) });
    }
  }
  return {
    vw,
    vh,
    boxes,
    outside,
    overlaps,
    prompt: document.getElementById('prompt').textContent,
    stick: document.getElementById('touch-stick').getBoundingClientRect().toJSON(),
    buttons: [...document.querySelectorAll('.t-btn')].map((b) => ({
      action: b.dataset.action,
      label: b.querySelector('.t-btn-label').textContent,
      key: b.querySelector('.t-btn-key').textContent,
      w: +b.getBoundingClientRect().width.toFixed(1),
      h: +b.getBoundingClientRect().height.toFixed(1),
    })),
    hints: getComputedStyle(document.getElementById('hints')).display,
    helpBtn: getComputedStyle(document.getElementById('help-btn')).display,
    touchUi: getComputedStyle(document.getElementById('touch-ui')).display,
  };
});

(async () => {
  const b = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: null,
  });
  const errs = [];
  const mediaAborts = [];
  const page = await b.newPage();
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = typeof m.location === 'function' ? m.location() : null;
    const url = (loc && loc.url) || '';
    // python http.server drops a keep-alive socket while a media element is
    // still streaming audio/*.ogg|mp3; that is a static-server artefact, not an
    // app error, but it is reported in the summary rather than swallowed.
    if (/\/audio\//.test(url) && /Failed to load resource/.test(m.text())) {
      mediaAborts.push(url);
      return;
    }
    errs.push('console: ' + m.text() + (url ? ' @ ' + url : ''));
  });

  await page.emulate({
    viewport: { ...PORTRAIT, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    userAgent: IPHONE_UA,
  });
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__game !== undefined', { timeout: 40000 });
  await sleep(800);

  // ---- activation (coarse pointer on load, or the first touch)
  const boot = await page.evaluate(() => ({
    coarse: window.matchMedia('(pointer: coarse)').matches,
    touchMode: document.body.classList.contains('touch-mode'),
    active: window.__game.touch.state.active,
  }));
  check('touch layer active on a phone', boot.touchMode && boot.active, boot);

  await page.tap('#start-btn');
  await page.waitForFunction('window.__game.state.started === true', { timeout: 20000 });
  await sleep(600);

  const geo = await layout(page);
  const actions = geo.buttons.map((x) => x.action).sort();
  check(
    'stick + six action buttons rendered',
    actions.join(',') === 'fire,interact,jump,punch,sprint,vehicle' && geo.stick.width > 80,
    { actions, stick: { w: +geo.stick.width.toFixed(1), h: +geo.stick.height.toFixed(1) } },
  );
  check('buttons are thumb-sized (>= 44px)', geo.buttons.every((x) => x.w >= 44 && x.h >= 44), geo.buttons);
  check('keyboard hints hidden, "?" help shown', geo.hints === 'none' && geo.helpBtn === 'flex', { hints: geo.hints, helpBtn: geo.helpBtn });
  check('portrait: nothing overlaps or leaves the viewport', geo.overlaps.length === 0 && geo.outside.length === 0, {
    overlaps: geo.overlaps,
    outside: geo.outside,
    boxes: geo.boxes,
  });

  // ---- walk ~3 m with the stick
  await page.evaluate(() => {
    const g = window.__game;
    g._test.teleport(26, -40);
    g._test.setCam(Math.PI, 0.08);
  });
  await sleep(400);
  const before = await page.evaluate(() => window.__game.player.pos.toArray());
  await pointer(page, 'pointerdown', 1, 100, 700);
  await pointer(page, 'pointermove', 1, 100, 655);
  const stickState = await page.evaluate(() => ({ ...window.__game.touch.state, knob: document.getElementById('touch-stick-knob').style.transform }));
  await sleep(1400);
  const after = await page.evaluate(() => window.__game.player.pos.toArray());
  await pointer(page, 'pointerup', 1, 100, 655);
  await sleep(200);
  const walked = Math.hypot(after[0] - before[0], after[2] - before[2]);
  const rest = await page.evaluate(() => ({ ...window.__game.touch.state, floating: document.getElementById('touch-stick').classList.contains('floating') }));
  check('stick walks ~3 m (analog, full deflection)', walked > 2.5, { walked: +walked.toFixed(2), stickState, rest });
  check('stick axis is analog and releases to zero', stickState.magnitude > 0.9 && rest.magnitude === 0 && !rest.floating, { stickState, rest });

  // ---- look drag on the right half rotates the camera
  const yaw0 = await page.evaluate(() => window.__game._test.camYaw);
  await pointer(page, 'pointerdown', 2, 320, 420);
  for (let i = 1; i <= 5; i++) await pointer(page, 'pointermove', 2, 320 - i * 20, 420);
  await pointer(page, 'pointerup', 2, 220, 420);
  await sleep(300);
  const yaw1 = await page.evaluate(() => window.__game._test.camYaw);
  check('right-half drag orbits the camera', Math.abs(yaw1 - yaw0) > 0.15, { yaw0: +yaw0.toFixed(3), yaw1: +yaw1.toFixed(3) });

  // ---- FIRE taps a round
  const fireRes = await page.evaluate(() => {
    const g = window.__game;
    const btn = document.querySelector('.t-btn[data-action="fire"]');
    const r = btn.getBoundingClientRect();
    const before = g.player.mag;
    btn.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 9, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true,
    }));
    return { before, pressed: btn.classList.contains('active'), fire: g.touch.state.fire };
  });
  await sleep(100);
  const fireAfter = await page.evaluate(() => {
    const g = window.__game;
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, pointerType: 'touch', button: 0, buttons: 0, bubbles: true, cancelable: true }));
    return { mag: g.player.mag, fire: g.touch.state.fire, shot: !!window.__lastShot };
  });
  check('FIRE button spends exactly one round', fireRes.pressed && fireRes.fire && fireAfter.mag === fireRes.before - 1 && fireAfter.fire === false, {
    before: fireRes.before,
    after: fireAfter.mag,
    pressed: fireRes.pressed,
    released: fireAfter.fire === false,
    shot: fireAfter.shot,
  });

  // ---- portrait screenshot, standing at a shop door so the prompt chip is visible
  const shop = await page.evaluate(() => {
    const g = window.__game;
    const d = g.city.shopDoors.reduce((a, b) => (Math.hypot(b.x, b.z) < Math.hypot(a.x, a.z) ? b : a));
    g._test.teleport(d.x + 2.4, d.z + 0.6);
    g._test.face(d.x, d.z);
    g._test.setTime(0.36);
    return { name: d.name, x: +d.x.toFixed(1), z: +d.z.toFixed(1) };
  });
  await sleep(900);
  const promptNow = await page.evaluate(() => ({
    text: document.getElementById('prompt').textContent,
    shown: document.getElementById('prompt').classList.contains('show'),
  }));
  check('contextual prompt visible on touch (measured with the chip on screen)', promptNow.shown && promptNow.text.length > 0, { ...promptNow, shop });
  const geoPrompt = await layout(page);
  check('portrait: prompt chip overlaps nothing', geoPrompt.overlaps.length === 0, { overlaps: geoPrompt.overlaps, prompt: geoPrompt.prompt });
  await page.screenshot({ path: path.join(OUT, 'touch-portrait.png') });
  const portraitSize = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));

  // ---- two-finger tap pauses
  await pointer(page, 'pointerdown', 21, 200, 700);
  await pointer(page, 'pointerdown', 22, 260, 700);
  await pointer(page, 'pointerup', 21, 200, 700);
  await pointer(page, 'pointerup', 22, 260, 700);
  await sleep(250);
  const paused = await page.evaluate(() => ({ paused: window.__game.state.paused, overlay: !document.getElementById('pause-screen').classList.contains('hidden') }));
  check('two-finger tap pauses', paused.paused && paused.overlay, paused);
  await page.evaluate(() => document.getElementById('resume-btn').click());
  await sleep(500);
  const resumed = await page.evaluate(() => window.__game.state.paused === false);
  check('resume after touch pause', resumed);

  // ---- landscape
  await page.setViewport({ ...LANDSCAPE, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await sleep(900);
  const land = await layout(page);
  check('landscape: nothing overlaps or leaves the viewport', land.overlaps.length === 0 && land.outside.length === 0, {
    overlaps: land.overlaps,
    outside: land.outside,
    boxes: land.boxes,
  });
  const landPrompt = await page.evaluate(() => ({
    text: document.getElementById('prompt').textContent,
    shown: document.getElementById('prompt').classList.contains('show'),
  }));
  check('landscape: prompt chip still on screen and clear', landPrompt.shown && landPrompt.text.length > 0, landPrompt);
  await page.screenshot({ path: path.join(OUT, 'touch-landscape.png') });

  // ---- help sheet opens over the controls
  await page.evaluate(() => document.getElementById('help-btn').click());
  await sleep(200);
  const sheet = await page.evaluate(() => {
    const el = document.getElementById('help-sheet');
    const r = el.getBoundingClientRect();
    return { open: el.classList.contains('show'), display: getComputedStyle(el).display, h: +r.height.toFixed(0), expanded: document.getElementById('help-btn').getAttribute('aria-expanded') };
  });
  await page.evaluate(() => document.getElementById('help-close').click());
  await sleep(150);
  const sheetClosed = await page.evaluate(() => !document.getElementById('help-sheet').classList.contains('show'));
  check('"?" help sheet opens and closes', sheet.open && sheet.display === 'flex' && sheet.h > 100 && sheetClosed, { ...sheet, closed: sheetClosed });

  check('no console/page errors on touch', errs.length === 0, { errors: errs.slice(0, 6), mediaAborts });

  // ---- desktop must stay keyboard/mouse only
  const desktop = await b.newPage();
  await desktop.setViewport({ width: 1500, height: 900 });
  await desktop.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await desktop.waitForFunction('window.__game !== undefined', { timeout: 40000 });
  await sleep(500);
  const desk = await desktop.evaluate(() => ({
    touchMode: document.body.classList.contains('touch-mode'),
    active: window.__game.touch.state.active,
    ui: getComputedStyle(document.getElementById('touch-ui')).display,
    help: getComputedStyle(document.getElementById('help-btn')).display,
    hints: getComputedStyle(document.getElementById('hints')).display,
    testHook: typeof window.__game._test.shoot === 'function' && typeof window.__game._test.camYaw === 'number',
    yawBefore: window.__game._test.camYaw,
  }));
  await desktop.mouse.move(700, 450);
  await desktop.mouse.move(600, 450);
  const deskYaw = await desktop.evaluate(() => window.__game._test.camYaw);
  check('desktop never shows the touch layer', !desk.touchMode && !desk.active && desk.ui === 'none' && desk.help === 'none' && desk.hints !== 'none', desk);
  check('desktop pointer-lock look path intact (test hook)', desk.testHook && desk.yawBefore === deskYaw, { yawBefore: desk.yawBefore, yawAfter: deskYaw });

  console.log('SUMMARY ' + JSON.stringify({ pass: results.filter((r) => r.ok).length, total: results.length }));
  console.log('FAILED ' + JSON.stringify(results.filter((r) => !r.ok)));
  console.log('VIEWPORTS ' + JSON.stringify({ portrait: portraitSize, landscape: { w: land.vw, h: land.vh } }));
  await b.close();
  if (results.some((r) => !r.ok)) process.exit(1);
})().catch((e) => { console.error('HARNESS FAIL', e.message); process.exit(1); });
