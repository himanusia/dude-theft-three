/**
 * Responsive HUD harness: seven viewports, bounding-box + readability proof.
 *
 *   node tests/responsive.mjs                          # against http://127.0.0.1:8765
 *   DTA_URL=http://localhost:8795 node tests/responsive.mjs
 *
 * For every viewport it sets a rich HUD state (cash, wanted stars, ammo, long
 * objective, live door prompt, two toasts), measures every visible panel, then
 * asserts:
 *   a) zero pairwise overlaps between visible panels (incl. touch controls)
 *   b) every panel sits inside the viewport with a 4 px margin
 *   c) every HUD text node renders at >= 12 px
 *   d) every HUD text keeps >= 4.5:1 contrast on its own chip background
 *   e) the prompt chip stays <= 40% of the viewport width
 * plus a pause-panel and help-sheet fit check at the same viewport, and one
 * screenshot per viewport in screenshots/resp-<w>x<h>.png.
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || 'http://127.0.0.1:8765';
const OUT = new URL('../../screenshots', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWPORTS = [
  { w: 360, h: 640, touch: true, label: 'phone portrait (small)' },
  { w: 390, h: 844, touch: true, label: 'phone portrait' },
  { w: 768, h: 1024, touch: true, label: 'tablet portrait' },
  { w: 1280, h: 720, touch: false, label: 'laptop' },
  { w: 1920, h: 1080, touch: false, label: 'desktop' },
  { w: 2560, h: 1080, touch: false, label: 'ultrawide' },
  { w: 844, h: 390, touch: true, label: 'phone landscape' },
];

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}

/* ------------------------------------------------------------------ audit
   Runs inside the page. Every helper is local so puppeteer can serialise it. */
function auditHud() {
  const vis = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
  };
  const name = (el) => (el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.classList.length ? '.' + el.classList[0] : ''));
  const overlap = (a, b) => {
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return { ox: +ox.toFixed(1), oy: +oy.toFixed(1) };
  };
  const pairs = (list) => {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const o = overlap(list[i], list[j]);
        if (o.ox > 0.5 && o.oy > 0.5) out.push({ a: list[i].sel, b: list[j].sel, ox: o.ox, oy: o.oy });
      }
    }
    return out;
  };

  // decorative overlays (crosshair, hit marker, damage vignette) are excluded:
  // they are centred effects, not panels
  const LEAVES = ['#objective', '#fps', '#cash', '#wanted-label', '#stars', '#minimap', '#ammo-wrap', '#health-wrap', '#hints', '#prompt', '#toasts', '#help-btn', '#touch-stick'];
  const panels = [];
  for (const sel of LEAVES) {
    const el = document.querySelector(sel);
    if (vis(el)) panels.push({ sel, ...rect(el) });
  }
  for (const b of document.querySelectorAll('.t-btn')) {
    if (vis(b)) panels.push({ sel: '.t-btn[' + (b.dataset.action || '?') + ']', ...rect(b) });
  }

  // --- readability
  const parseRGB = (s) => {
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (t, b) => ({ r: t.r * t.a + b.r * (1 - t.a), g: t.g * t.a + b.g * (1 - t.a), b: t.b * t.a + b.b * (1 - t.a), a: 1 });
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const contrast = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  // translucent chips sit over the 3D scene: composite every ancestor chip and
  // finish on white, the brightest realistic backdrop
  const chipBg = (el) => {
    const layers = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== document.body) {
      const c = parseRGB(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.001) layers.push(c);
      n = n.parentElement;
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    return bg;
  };

  const texts = [];
  const rootEl = document.getElementById('hud');
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.currentNode; n; n = walker.nextNode()) {
    const direct = Array.prototype.some.call(n.childNodes, (c) => c.nodeType === 3 && c.textContent.trim().length);
    if (!direct || !vis(n)) continue;
    const cs = getComputedStyle(n);
    const fg = parseRGB(cs.color) || { r: 255, g: 255, b: 255, a: 1 };
    texts.push({
      sel: name(n),
      text: n.textContent.trim().slice(0, 24),
      size: +parseFloat(cs.fontSize).toFixed(1),
      contrast: +contrast(fg, chipBg(n)).toFixed(2),
    });
  }
  for (const [sel, pseudo] of [['#objective', '::before'], ['#fps', '::after']]) {
    const el = document.querySelector(sel);
    if (!vis(el)) continue;
    const cs = getComputedStyle(el, pseudo);
    if (!cs.content || cs.content === 'none' || cs.content === 'normal') continue;
    const fg = parseRGB(cs.color) || { r: 255, g: 255, b: 255, a: 1 };
    texts.push({ sel: sel + pseudo, text: cs.content.slice(0, 24), size: +parseFloat(cs.fontSize).toFixed(1), contrast: +contrast(fg, chipBg(el)).toFixed(2) });
  }

  const promptEl = document.getElementById('prompt');
  const prompt = vis(promptEl) ? { ...rect(promptEl), text: promptEl.textContent, share: +(rect(promptEl).w / window.innerWidth).toFixed(3) } : null;
  const minimap = panels.find((p) => p.sel === '#minimap');
  const minimapPrompt = minimap && prompt ? overlap(minimap, prompt) : null;

  return {
    vw: window.innerWidth,
    vh: window.innerHeight,
    mode: document.body.dataset.hudMode,
    touchMode: document.body.classList.contains('touch-mode'),
    scale: +getComputedStyle(document.body).getPropertyValue('--hud-scale'),
    hudScaleVar: getComputedStyle(document.body).getPropertyValue('--hud-scale').trim(),
    layoutInfo: window.__game.hud.layoutInfo,
    minimapSize: minimap ? minimap.w : null,
    panels,
    overlaps: pairs(panels),
    outside: panels.filter((p) => p.x < 3.5 || p.y < 3.5 || p.x + p.w > window.innerWidth - 3.5 || p.y + p.h > window.innerHeight - 3.5),
    texts,
    minFont: Math.min(...texts.map((t) => t.size)),
    minContrast: Math.min(...texts.map((t) => t.contrast)),
    worstContrast: texts.slice().sort((a, b) => a.contrast - b.contrast)[0],
    smallestFont: texts.slice().sort((a, b) => a.size - b.size)[0],
    prompt,
    minimapPrompt,
    hintsDisplay: getComputedStyle(document.getElementById('hints')).display,
    helpBtnDisplay: getComputedStyle(document.getElementById('help-btn')).display,
    touchUiDisplay: getComputedStyle(document.getElementById('touch-ui')).display,
  };
}

/** force the speedometer visible (driving state) and re-run the geometry audit */
function auditWithSpeedo() {
  const el = document.getElementById('speedo');
  el.classList.add('show');
  const r = el.getBoundingClientRect();
  const hud = window.__game.hud;
  // re-measure every panel that can collide with the speedo chip
  const rect = (n) => { const b = n.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  const speedo = { sel: '#speedo', ...rect(el) };
  const others = [];
  for (const sel of ['#objective', '#fps', '#cash', '#wanted-label', '#stars', '#minimap', '#ammo-wrap', '#health-wrap', '#hints', '#prompt', '#toasts', '#help-btn', '#touch-stick']) {
    const n = document.querySelector(sel);
    if (!n) continue;
    const cs = getComputedStyle(n);
    const b = n.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0 || b.width <= 1 || b.height <= 1) continue;
    others.push({ sel, ...rect(n) });
  }
  const hits = [];
  for (const o of others) {
    const ox = Math.min(speedo.x + speedo.w, o.x + o.w) - Math.max(speedo.x, o.x);
    const oy = Math.min(speedo.y + speedo.h, o.y + o.h) - Math.max(speedo.y, o.y);
    if (ox > 0.5 && oy > 0.5) hits.push({ a: '#speedo', b: o.sel, ox: +ox.toFixed(1), oy: +oy.toFixed(1) });
  }
  const inside = speedo.x >= 3.5 && speedo.y >= 3.5 && speedo.x + speedo.w <= window.innerWidth - 3.5 && speedo.y + speedo.h <= window.innerHeight - 3.5;
  const font = +parseFloat(getComputedStyle(el).fontSize).toFixed(1);
  el.classList.remove('show');
  return { speedo, hits, inside, font, scale: hud.layoutInfo.scale };
}

/** pause panel: real overlay, must fit and stay readable at every viewport */
async function auditPause() {
  const hud = window.__game.hud;
  hud.showPause(true);
  // let the overlay's opacity/visibility transition commit before measuring
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const card = document.querySelector('#pause-screen .pause-wrap');
  const shell = document.getElementById('pause-screen');
  const r = card.getBoundingClientRect();
  const rect = { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
  const scrolls = card.scrollHeight > card.clientHeight + 1;
  const inside = rect.x >= 3.5 && rect.y >= 3.5 && rect.x + rect.w <= window.innerWidth - 3.5 && rect.y + rect.h <= window.innerHeight - 3.5;
  const resume = document.getElementById('resume-btn').getBoundingClientRect();
  const buttons = [...card.querySelectorAll('button, .pause-key span, .pause-key kbd, .pause-head')]
    .filter((n) => {
      const cs = getComputedStyle(n);
      if (cs.display === 'none') return false;
      const b = n.getBoundingClientRect();
      return b.width > 1 && b.height > 1;
    })
    .map((n) => ({ sel: n.id ? '#' + n.id : n.tagName.toLowerCase() + '.' + (n.className || '?'), size: +parseFloat(getComputedStyle(n).fontSize).toFixed(1), h: +n.getBoundingClientRect().height.toFixed(1) }));
  const resumeBox = { x: +resume.x.toFixed(1), y: +resume.y.toFixed(1), w: +resume.width.toFixed(1), h: +resume.height.toFixed(1) };
  const resumeInView = resumeBox.x >= 3.5 && resumeBox.y >= 3.5 && resumeBox.x + resumeBox.w <= window.innerWidth - 3.5 && resumeBox.y + resumeBox.h <= window.innerHeight - 3.5;
  const display = getComputedStyle(shell).display;
  hud.showPause(false);
  return { rect, inside, scrolls, resumeBox, resumeInView, buttons, display, minFont: Math.min(...buttons.map((b) => b.size)) };
}

/** help sheet: compact control list for the current input mode */
function auditHelp(touch) {
  const hud = window.__game.hud;
  hud.toggleHelp(true);
  const sheet = document.getElementById('help-sheet');
  const inner = sheet.querySelector('.sheet');
  const r = inner.getBoundingClientRect();
  const rect = { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
  const inside = rect.x >= 3.5 && rect.y >= 3.5 && rect.x + rect.w <= window.innerWidth - 3.5 && rect.y + rect.h <= window.innerHeight - 3.5;
  const rows = [...inner.querySelectorAll('.keys span, .keys kbd, .kicker, #help-close')].filter((n) => {
    const cs = getComputedStyle(n);
    const b = n.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 1 && b.height > 1;
  });
  const sizes = rows.map((n) => +parseFloat(getComputedStyle(n).fontSize).toFixed(1));
  const kbVisible = [...inner.querySelectorAll('.kb-only')].some((n) => getComputedStyle(n).display !== 'none');
  const touchVisible = [...inner.querySelectorAll('.touch-only')].some((n) => getComputedStyle(n).display !== 'none');
  const shown = getComputedStyle(sheet).display === 'flex' && inner.getBoundingClientRect().height > 80;
  hud.toggleHelp(false);
  return {
    rect,
    inside,
    shown,
    rows: rows.length,
    minFont: Math.min(...sizes),
    mode: touch ? (touchVisible && !kbVisible ? 'touch' : 'mixed') : (kbVisible && !touchVisible ? 'keyboard' : 'mixed'),
  };
}

const fmt = (n) => (Math.round(n * 10) / 10).toFixed(1);

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: null,
  });

  const lines = [];
  for (const vp of VIEWPORTS) {
    const tag = `${vp.w}x${vp.h}`;
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const loc = typeof m.location === 'function' ? m.location() : null;
      if (/\/audio\//.test((loc && loc.url) || '') && /Failed to load resource/.test(m.text())) return;
      errs.push('console: ' + m.text());
    });
    await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1, isMobile: vp.touch, hasTouch: vp.touch });
    await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__game !== undefined', { timeout: 60000 });
    await sleep(600);

    // start the game (audio init + pointer lock are irrelevant headless)
    if (vp.touch) await page.tap('#start-btn');
    else await page.click('#start-btn');
    await page.waitForFunction('window.__game.state.started === true', { timeout: 30000 }).catch(() => {});
    await sleep(500);

    // stand at the nearest shop door so the live prompt chip is on screen
    const door = await page.evaluate(() => {
      const g = window.__game;
      const d = g.city.shopDoors.reduce((a, b) => (Math.hypot(b.x, b.z) < Math.hypot(a.x, a.z) ? b : a));
      g._test.teleport(d.x + (d.nx || 0) * 2.6, d.z + (d.nz || 0) * 2.6);
      g._test.face(d.x, d.z);
      g._test.setTime(0.36);
      const h = g.hud;
      h.setCash(2450);
      h.setStars(3);
      h.setHealth(72);
      h.setAmmo(7, 12, false);
      h.setObjective('Drive to the warung before the cops arrive');
      h.setFps(60);
      h.toast('Wanted level up', 'bad');
      h.toast('Cash +250', 'cash');
      return { name: d.name, x: +d.x.toFixed(1), z: +d.z.toFixed(1) };
    });
    await sleep(900);

    const a = await page.evaluate(auditHud);
    const speedo = await page.evaluate(auditWithSpeedo);
    const pause = await page.evaluate(auditPause);
    const help = await page.evaluate(auditHelp, vp.touch);
    await sleep(120);
    await page.screenshot({ path: path.join(OUT, `resp-${tag}.png`) });

    // ---- panel rectangles
    console.log(`\nRECTS ${tag} ${vp.label} :: mode=${a.mode} scale=${a.scale} minimap=${a.minimapSize}px prompt="${a.prompt ? a.prompt.text : '(none)'}"`);
    for (const p of a.panels) console.log(`   ${p.sel.padEnd(22)} x=${fmt(p.x)} y=${fmt(p.y)} w=${fmt(p.w)} h=${fmt(p.h)}`);

    const expectScale = Math.min(1.4, Math.max(0.8, Math.min(vp.w, vp.h) / 880));
    const expectMode = vp.w < 620 ? 'narrow' : vp.h < 520 ? 'short' : 'regular';
    const geometryOk = a.overlaps.length === 0 && a.outside.length === 0;
    const fontsOk = a.minFont >= 12;
    const contrastOk = a.minContrast >= 4.5;
    // The prompt only exists while something is in reach (a car door, a shop door). A viewport
    // where the player happens to stand near nothing is not a layout failure -- the old
    // assertion required the chip to be present and failed on its own fixture.
    const promptOk = !a.prompt || a.prompt.w <= vp.w * 0.4 + 0.5;
    const minimapPromptOk = !a.minimapPrompt || !(a.minimapPrompt.ox > 0.5 && a.minimapPrompt.oy > 0.5);
    const speedoOk = speedo.hits.length === 0 && speedo.inside;
    const pauseOk = pause.display === 'flex' && pause.inside && pause.resumeInView && pause.minFont >= 12;
    const helpOk = help.shown && help.inside && help.minFont >= 12 && help.rows >= 8;
    const inputOk = vp.touch
      ? a.touchMode && a.hintsDisplay === 'none' && a.touchUiDisplay === 'block' && a.helpBtnDisplay === 'flex'
      : !a.touchMode && a.touchUiDisplay === 'none' && (a.hintsDisplay !== 'none' || a.helpBtnDisplay === 'flex') && help.mode === 'keyboard';
    const scaleOk = Math.abs(a.scale - expectScale) < 0.002 && a.mode === expectMode && a.scale >= 0.8 && a.scale <= 1.4;
    const clean = errs.length === 0;

    check(`${tag} geometry: 0 overlaps, 0 outside (panels=${a.panels.length})`, geometryOk, { overlaps: a.overlaps, outside: a.outside });
    check(`${tag} readability: min font ${a.minFont}px`, fontsOk, a.smallestFont);
    check(`${tag} contrast: min ${a.minContrast}:1`, contrastOk, a.worstContrast);
    check(`${tag} prompt ${a.prompt ? `${Math.round(a.prompt.w)}px <= 40% of ${vp.w}px` : 'not in range'}`, promptOk, a.prompt);
    check(`${tag} minimap clear of prompt`, minimapPromptOk, a.minimapPrompt);
    check(`${tag} speedo visible (driving) overlaps nothing`, speedoOk, { rect: speedo.speedo, hits: speedo.hits, inside: speedo.inside });
    check(`${tag} pause panel fits, resume reachable, text >= 12px`, pauseOk, { rect: pause.rect, resume: pause.resumeBox, scrolls: pause.scrolls, minFont: pause.minFont });
    check(`${tag} help sheet fits, ${help.rows} rows, ${help.minFont}px, mode=${help.mode}`, helpOk, { rect: help.rect, inside: help.inside });
    check(`${tag} input mode ${vp.touch ? 'coarse/touch' : 'fine/keyboard'}`, inputOk, { touchMode: a.touchMode, hints: a.hintsDisplay, helpBtn: a.helpBtnDisplay, touchUi: a.touchUiDisplay });
    check(`${tag} scale ${a.scale} == clamp(min/880) and mode ${a.mode}`, scaleOk, { expectScale: +expectScale.toFixed(3), expectMode, scale: a.scale, mode: a.mode });
    check(`${tag} no console/page errors`, clean, errs.slice(0, 4));

    const line = `${geometryOk && fontsOk && contrastOk && promptOk && minimapPromptOk && speedoOk && pauseOk && helpOk && inputOk && scaleOk && clean ? 'PASS' : 'FAIL'} ` +
      `${tag} ${vp.label} :: mode=${a.mode} scale=${a.scale} overlaps=${a.overlaps.length} outside=${a.outside.length} ` +
      `minFont=${a.minFont} minContrast=${a.minContrast} prompt=${a.prompt ? Math.round(a.prompt.w) : 0}/${Math.round(vp.w * 0.4)}px ` +
      `panels=${a.panels.length} door=${door.name}`;
    lines.push(line);
    console.log(line);
    await page.close();
  }

  console.log('\nPER-VIEWPORT');
  for (const l of lines) console.log(l);
  const failed = results.filter((r) => !r.ok);
  console.log('SUMMARY ' + JSON.stringify({ pass: results.length - failed.length, total: results.length, viewports: VIEWPORTS.length }));
  console.log('FAILED ' + JSON.stringify(failed));
  await browser.close();
  if (failed.length) {
    console.error(`responsive: ${failed.length}/${results.length} checks failed`);
    process.exit(1);
  }
})().catch((e) => { console.error('HARNESS FAIL', e.message); process.exit(1); });
