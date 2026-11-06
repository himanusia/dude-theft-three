/**
 * Touch-controls harness: emulates an iPhone, drives the on-screen layer with
 * synthetic pointer events, and proves geometry + behaviour.
 *
 *   node tests/touch.mjs                       # against http://127.0.0.1:8765
 *   DTA_URL=http://localhost:8793 node tests/touch.mjs
 *
 * Writes screenshots/touch-portrait.png and screenshots/touch-landscape.png.
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || 'http://127.0.0.1:8765';
const OUT = new URL('../../screenshots', import.meta.url).pathname;
const TMP = tmpdir();
mkdirSync(path.join(OUT, 'proof'), { recursive: true });
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

/**
 * Tap one on-screen control the way a finger does: a synthetic touch pointerdown /
 * pointerup on the element's own centre, plus the hit test at that point so an
 * element that is rendered but covered cannot be reported as reachable.
 */
const tapControl = (page, sel) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const ev = (type, buttons) =>
      new PointerEvent(type, {
        pointerId: 77,
        pointerType: 'touch',
        isPrimary: true,
        button: 0,
        buttons,
        clientX: cx,
        clientY: cy,
        bubbles: true,
        cancelable: true,
      });
    el.dispatchEvent(ev('pointerdown', 1));
    el.dispatchEvent(ev('pointerup', 0));
    return {
      found: true,
      // the control must be the topmost element at its own centre, not merely present
      hitSelf: hit === el || el.contains(hit),
      x: +r.x.toFixed(1),
      y: +r.y.toFixed(1),
      w: +r.width.toFixed(1),
      h: +r.height.toFixed(1),
    };
  }, sel);

/** geometry audit: every HUD/touch box inside the viewport, none of them overlapping */
const layout = (page) => page.evaluate(() => {
  const hud = window.__game.hud;
  // force the longest realistic prompt so the chip has real text to measure
  hud.setPrompt('tap USE — masuk WARTEG BAHARI');
  const boxes = [];
  const push = (sel, el) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    boxes.push({ sel, x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) });
  };
  // the weapon picker deliberately covers the bottom-centre lane, so those two chips are
  // out of the collision audit *while it is open* and only then
  const pickerUp = document.body.classList.contains('touch-weapons');
  for (const sel of ['#objective', '#topright', '#help-btn', '#minimap', '#ammo-wrap', '#health-wrap', '#prompt', '#speedo', '#touch-stick', '#touch-rail']) {
    if (pickerUp && (sel === '#prompt' || sel === '#speedo')) continue;
    push(sel, document.querySelector(sel));
  }
  for (const btn of document.querySelectorAll('.t-btn')) {
    push(`.t-btn[data-action=${btn.dataset.action}]`, btn);
  }
  for (const btn of document.querySelectorAll('.t-mini')) {
    push(`.t-mini[data-tool=${btn.dataset.tool}]`, btn);
  }
  // the picker only has a box while it is open
  if (document.getElementById('touch-weapons')?.classList.contains('open')) {
    push('#touch-weapons', document.getElementById('touch-weapons'));
    for (const btn of document.querySelectorAll('.t-slot')) push(`.t-slot[slot=${btn.dataset.slot}]`, btn);
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const outside = boxes.filter((b) => b.x < -0.5 || b.y < -0.5 || b.x + b.w > vw + 0.5 || b.y + b.h > vh + 0.5);
  const overlaps = [];
  const contains = (a, b) => a.x <= b.x + 0.5 && a.y <= b.y + 0.5 && a.x + a.w >= b.x + b.w - 0.5 && a.y + a.h >= b.y + b.h - 0.5;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      // a container and its own child (the rail and its chips) are not a collision
      if (contains(a, b) || contains(b, a)) continue;
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
  // the city is generated synchronously on load, and this box runs several lanes at once:
  // the default 30 s navigation timeout reports "HARNESS FAIL" before a single assertion
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 180000 });
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

  // ---- secondary rail: reload, weapon picker, map and mute are each one tap
  const rail = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('.t-mini')];
    return {
      tools: chips.map((c) => c.dataset.tool),
      labels: chips.map((c) => c.querySelector('.t-mini-label').textContent),
      sizes: chips.map((c) => ({ w: +c.getBoundingClientRect().width.toFixed(1), h: +c.getBoundingClientRect().height.toFixed(1) })),
      wpnSlot: document.querySelector('.t-mini[data-tool=weapon] .t-mini-state').textContent,
    };
  });
  check(
    'rail offers the weapon picker, reload, map and mute',
    rail.tools.join(',') === 'weapon,reload,map,mute' && rail.labels.join(',') === 'WPN,RLD,MAP,SND',
    rail,
  );
  check('rail chips are finger-sized (>= 38px)', rail.sizes.every((s) => s.w >= 38 && s.h >= 38), rail.sizes);

  // ---- reload: the shot above left the 9mm one short
  const magBefore = await page.evaluate(() => window.__game.player.mag);
  const rldTap = await tapControl(page, '.t-mini[data-tool=reload]');
  const reloading = await page.evaluate(() => ({
    reloading: window.__game.player.reloading > 0,
    ammoLabel: document.getElementById('ammo').textContent,
  }));
  // the HUD prints RELOADING on the next frame, and the reload itself runs on SIM time,
  // so poll both instead of sleeping: a SwiftShader frame here is ~0.25 s of wall clock
  const sawReloading = await page
    .waitForFunction(() => document.getElementById('ammo').textContent === 'RELOADING', { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  const refilled = await page
    .waitForFunction((want) => window.__game.player.mag === want, { timeout: 20000 }, magBefore + 1)
    .then(() => true)
    .catch(() => false);
  const magAfter = await page.evaluate(() => window.__game.player.mag);
  check(
    'RLD chip starts a reload and the magazine refills',
    rldTap.hitSelf && reloading.reloading && sawReloading && refilled && magAfter === magBefore + 1,
    { tap: rldTap, before: magBefore, after: magAfter, reloading, sawReloading, refilled },
  );

  // ---- weapon picker: six slots, one tap each
  const pickerSlots = await page.evaluate(() =>
    [...document.querySelectorAll('.t-slot')].map((s) => ({
      slot: +s.dataset.slot,
      weapon: s.dataset.weapon,
      name: s.querySelector('.t-slot-name').textContent,
      on: s.classList.contains('on'),
    })),
  );
  const wpnTap = await tapControl(page, '.t-mini[data-tool=weapon]');
  const pickerOpen = await page.evaluate(() => ({
    open: document.getElementById('touch-weapons').classList.contains('open'),
    pickerOpen: window.__game.touch.weaponPickerOpen,
    aria: document.getElementById('touch-weapons').getAttribute('aria-hidden'),
    lit: [...document.querySelectorAll('.t-slot.on')].map((s) => +s.dataset.slot),
    held: window.__game.weaponSpec.slot,
  }));
  check(
    'WPN opens a six-slot picker with the held weapon lit',
    wpnTap.hitSelf && pickerSlots.length === 6 && pickerSlots.every((s) => /^\d$/.test(String(s.slot))) && pickerOpen.open && pickerOpen.pickerOpen && pickerOpen.aria === 'false' && pickerOpen.lit.join(',') === String(pickerOpen.held),
    { tap: wpnTap, slots: pickerSlots, ...pickerOpen },
  );

  const equipped = [];
  for (const slot of [1, 2, 3, 4, 5, 6]) {
    // the picker hands the screen back on select, so a test has to reopen it
    if (!(await page.evaluate(() => window.__game.touch.weaponPickerOpen))) await tapControl(page, '.t-mini[data-tool=weapon]');
    const tap = await tapControl(page, `.t-slot[data-slot="${slot}"]`);
    await sleep(80);
    const st = await page.evaluate(() => ({
      slot: window.__game.weaponSpec.slot,
      weapon: window.__game.player.weapon,
      pickerOpen: window.__game.touch.weaponPickerOpen,
      chip: document.querySelector('.t-mini[data-tool=weapon] .t-mini-state').textContent,
      plate: document.querySelector('#ammo-wrap small').textContent,
    }));
    equipped.push({ tapped: slot, hitSelf: tap.hitSelf, ...st });
  }
  check(
    'every picker slot equips its weapon and the WPN chip follows',
    equipped.every((e, i) => e.slot === i + 1 && e.hitSelf && e.chip === String(i + 1) && !e.pickerOpen && e.plate.startsWith(`${i + 1} ·`)),
    equipped,
  );
  check('the picker is closed again after a select', await page.evaluate(() => !document.querySelector('#touch-weapons.open') && !document.body.classList.contains('touch-weapons')));

  // ---- mute
  const muteTap = await tapControl(page, '.t-mini[data-tool=mute]');
  const muted = await page.evaluate(() => ({
    audio: window.__game.audio.muted,
    state: window.__game.touch.state.muted,
    aria: document.querySelector('.t-mini[data-tool=mute]').getAttribute('aria-pressed'),
    readout: document.querySelector('.t-mini[data-tool=mute] .t-mini-state').textContent,
    lit: document.querySelector('.t-mini[data-tool=mute]').classList.contains('on'),
  }));
  check('SND chip mutes the game and says so', muteTap.hitSelf && muted.audio && muted.state && muted.aria === 'true' && muted.readout === 'OFF' && muted.lit, muted);
  await tapControl(page, '.t-mini[data-tool=mute]');
  const unmuted = await page.evaluate(() => ({ audio: window.__game.audio.muted, state: window.__game.touch.state.muted, aria: document.querySelector('.t-mini[data-tool=mute]').getAttribute('aria-pressed') }));
  check('SND chip unmutes on the second tap', unmuted.audio === false && unmuted.state === false && unmuted.aria === 'false', unmuted);

  // ---- map: the chip is the way in AND the way out on a touch screen
  const mapTap = await tapControl(page, '.t-mini[data-tool=map]');
  await sleep(300);
  const mapOn = await page.evaluate(() => {
    const chip = document.querySelector('.t-mini[data-tool=map]');
    const r = chip.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      open: window.__game.hud.mapOpen,
      bodyClass: document.body.classList.contains('map-open'),
      lit: chip.classList.contains('on'),
      chipOnTop: hit === chip || chip.contains(hit),
      canvasShown: getComputedStyle(document.getElementById('bigmap')).display,
      stickHidden: getComputedStyle(document.getElementById('touch-stick')).display === 'none',
    };
  });
  check(
    'MAP chip opens the city map and stays tappable above it',
    mapTap.hitSelf && mapOn.open && mapOn.bodyClass && mapOn.lit && mapOn.chipOnTop && mapOn.canvasShown !== 'none' && mapOn.stickHidden,
    mapOn,
  );
  const mapClose = await tapControl(page, '.t-mini[data-tool=map]');
  await sleep(300);
  const mapOff = await page.evaluate(() => ({
    open: window.__game.hud.mapOpen,
    paused: window.__game.state.paused,
    lit: document.querySelector('.t-mini[data-tool=map]').classList.contains('on'),
  }));
  check('tapping MAP again closes the map and gives the sim back', mapClose.hitSelf && !mapOff.open && !mapOff.paused && !mapOff.lit, { tap: mapClose, ...mapOff });

  // ---- prompts name the control the player has, never a keyboard key
  const promptSweep = [];
  const readPrompt = async (label) => {
    await sleep(260);
    const p = await page.evaluate(() => ({
      text: document.getElementById('prompt').textContent,
      shown: document.getElementById('prompt').classList.contains('show'),
    }));
    promptSweep.push({ label, ...p });
    return p;
  };
  const shop = await page.evaluate(() => {
    const g = window.__game;
    const d = g.city.shopDoors.reduce((a, b) => (Math.hypot(b.x, b.z) < Math.hypot(a.x, a.z) ? b : a));
    // stand on the shopfront's own outward side: a door only counts when the player is in
    // front of it, so a fixed offset lands behind half the doors
    const nx = d.nx ?? 0;
    const nz = d.nz ?? 1;
    g._test.teleport(d.x + nx * 2.2, d.z + nz * 2.2);
    g._test.face(d.x, d.z);
    g._test.setTime(0.36);
    return { name: d.name, x: +d.x.toFixed(1), z: +d.z.toFixed(1) };
  });
  await page.waitForFunction(() => document.getElementById('prompt').classList.contains('show'), { timeout: 4000 }).catch(() => {});
  const shopPrompt = await readPrompt('shop door');
  check('contextual prompt visible on touch (measured with the chip on screen)', shopPrompt.shown && shopPrompt.text.length > 0, { ...shopPrompt, shop });

  // walk up to a car: the same branch that used to print "F — enter vehicle"
  const carSpot = await page.evaluate(() => {
    const g = window.__game;
    const car = g.cityCars.find((c) => !c.isPolice && !c.isBus) ?? g.cityCars[0];
    g._test.teleport(car.pos.x + 2.1, car.pos.z + 1.1);
    g._test.face(car.pos.x, car.pos.z);
    return { x: +car.pos.x.toFixed(1), z: +car.pos.z.toFixed(1) };
  });
  const carPrompt = await readPrompt('next to a car');
  const carTap = await tapControl(page, '.t-btn[data-action=vehicle]');
  await sleep(320);
  const inCarPrompt = await readPrompt('in a car');
  const inCar = await page.evaluate(() => window.__game.state.inCar);
  check('CAR button still gets the player into the car while the prompts move', carTap.hitSelf && inCar && carPrompt.text.length > 0 && inCarPrompt.text.length > 0, { carSpot, car: carPrompt.text, seated: inCarPrompt.text, inCar });
  await page.evaluate(() => window.__game._test.toggleVehicle());
  await sleep(320);

  // tap USE at the shop door: this is the "E — masuk …" branch
  await page.evaluate((s) => {
    const g = window.__game;
    g._test.teleport(s.x, s.z);
  }, { x: shop.x, z: shop.z });
  await sleep(260);
  await page.evaluate((name) => {
    const g = window.__game;
    const d = g.city.shopDoors.find((x) => x.name === name) ?? g.city.shopDoors[0];
    g._test.teleport(d.x + (d.nx ?? 0) * 2.2, d.z + (d.nz ?? 1) * 2.2);
    g._test.face(d.x, d.z);
  }, shop.name);
  await readPrompt('back at the shop door');
  const useTap = await tapControl(page, '.t-btn[data-action=interact]');
  await sleep(420);
  const insidePrompt = await readPrompt('inside a shop');
  const inside = await page.evaluate(() => !!window.__game.player.inInterior);
  check('USE button enters the shop and the prompt inside names USE', useTap.hitSelf && inside && insidePrompt.text.length > 0, { tap: useTap, inside, prompt: insidePrompt.text });
  await tapControl(page, '.t-btn[data-action=interact]');
  await sleep(400);

  const KEY_TOKEN = (text) => text.split(/[^A-Za-z]+/).filter(Boolean);
  const keyed = promptSweep.filter((p) => KEY_TOKEN(p.text).some((t) => t === 'E' || t === 'F'));
  check(
    'no touch prompt names a keyboard key (E / F)',
    promptSweep.length >= 3 && keyed.length === 0,
    { observed: promptSweep.map((p) => `${p.label}: ${p.text}`), offenders: keyed },
  );
  const objective = await page.evaluate(() => ({ text: document.getElementById('objective').textContent, hint: document.getElementById('hints').textContent }));
  check(
    'objective line is key-free too, and the keyboard hint chip is hidden',
    !KEY_TOKEN(objective.text).some((t) => t === 'E' || t === 'F') && !/\bpress [EF]\b/i.test(objective.text),
    objective,
  );
  const geoPrompt = await layout(page);
  check('portrait: prompt chip overlaps nothing', geoPrompt.overlaps.length === 0, { overlaps: geoPrompt.overlaps, prompt: geoPrompt.prompt });
  await page.screenshot({ path: path.join(OUT, 'touch-portrait.png') });
  const portraitSize = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));

  // ---- proof pair: the phone HUD at rest, and the weapon picker open. One PNG, two
  // frames, so the artifact shows both states and the plate the picker adds.
  const frame = async (name) => {
    const file = path.join(TMP, name);
    await page.screenshot({ path: file });
    return { file, data: 'data:image/png;base64,' + readFileSync(file).toString('base64') };
  };
  const restFrame = await frame('phone-rest.png');
  await tapControl(page, '.t-mini[data-tool=weapon]');
  await sleep(280);
  const geoPicker = await layout(page);
  check(
    'portrait: picker open, nothing overlaps or leaves the viewport',
    geoPicker.overlaps.length === 0 && geoPicker.outside.length === 0,
    { overlaps: geoPicker.overlaps, outside: geoPicker.outside, boxes: geoPicker.boxes },
  );
  const openShot = await frame('phone-picker.png', 'picker');
  const composited = await page.evaluate(
    async (a, b) => {
      const load = (src) =>
        new Promise((res, rej) => {
          const img = new Image();
          img.onload = () => res(img);
          img.onerror = rej;
          img.src = src;
        });
      const [i1, i2] = await Promise.all([load(a), load(b)]);
      const pad = 14;
      const cap = 26;
      const w = i1.width + i2.width + pad * 3;
      const h = Math.max(i1.height, i2.height) + pad + cap;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#07090c';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(i1, pad, pad);
      ctx.drawImage(i2, pad * 2 + i1.width, pad);
      ctx.font = '600 15px monospace';
      ctx.fillStyle = 'rgba(255,255,255,.72)';
      ctx.fillText('390x844 — HUD at rest', pad, h - 8);
      ctx.fillText('390x844 — weapon picker (WPN)', pad * 2 + i1.width, h - 8);
      return c.toDataURL('image/png').split(',')[1];
    },
    restFrame.data,
    openShot.data,
  );
  const proof = path.join(OUT, 'proof', 'phone-controls.png');
  writeFileSync(proof, Buffer.from(composited, 'base64'));
  const proofSize = readFileSync(proof).length;
  check('proof/phone-controls.png holds both states', proofSize > 30000, { path: 'screenshots/proof/phone-controls.png', bytes: proofSize });
  await tapControl(page, '.t-mini[data-tool=weapon]'); // close again for the rest of the suite
  await sleep(200);

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
  await desktop.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 180000 });
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
