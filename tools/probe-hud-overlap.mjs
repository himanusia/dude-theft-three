/**
 * HUD overlap probe — does the wanted row move the minimap when it appears?
 *
 * The reported defect: on a 390x844 phone the wanted stars sit ON the minimap, 118.8 x 10.4
 * CSS px, the moment a star is earned. The likely cause is a token, not a box: the narrow and
 * touch layouts anchor the map stack under `--hud-tr-h`, and that token was only ever published
 * inside Hud.layout(), which runs at boot and on resize. Earning a star adds the WANTED caption,
 * the row grows by ~15 px, nothing re-measures, and the map keeps its old top.
 *
 * So the probe measures exactly that transition, at the four viewports the card names:
 *
 *   1. clear the wanted level, force layout(), measure every HUD box;
 *   2. earn three stars through the police system (not through hud.setStars, which the next
 *      update tick overwrites -- that is how the old suite measured an empty row and stayed
 *      green), let it settle, measure again;
 *   3. report every pairwise overlap (parents excluded), the published --hud-tr-h, and the
 *      height of #topright and #wanted in both states;
 *   4. write screenshots/proof/hud-overlap-<label>.json, plus a phone screenshot with the
 *      stars up.
 *
 * usage: DTA_URL=http://127.0.0.1:8765 node tools/probe-hud-overlap.mjs before
 *        DTA_URL=http://127.0.0.1:8765 node tools/probe-hud-overlap.mjs after
 *
 *   exit 0 = no overlap in the wanted state, 2 = an overlap was measured, 1 = harness failure.
 *   HUD_VP=390x844,1280x760 measures a subset; HUD_SHOT=phone-wanted.png names the capture.
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';

const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || 'http://127.0.0.1:8765';
const LABEL = process.argv[2] || 'run';
const ROOT = new URL('..', import.meta.url).pathname;
const OUT = path.join(ROOT, 'screenshots/proof');
const JSON_OUT = process.env.HUD_JSON || path.join(OUT, `hud-overlap-${LABEL}.json`);
const SHOT = process.env.HUD_SHOT || `phone-wanted-${LABEL}.png`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ALL_VIEWPORTS = [
  { w: 390, h: 844, touch: true, label: 'phone portrait' },
  { w: 414, h: 896, touch: true, label: 'phone portrait (large)' },
  { w: 768, h: 1024, touch: true, label: 'tablet portrait' },
  { w: 1280, h: 760, touch: false, label: 'laptop' },
];
// a crash mid-sweep should not cost the whole set: HUD_VP re-measures only those viewports
const ONLY = (process.env.HUD_VP || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const VIEWPORTS = ONLY.length ? ALL_VIEWPORTS.filter((v) => ONLY.includes(`${v.w}x${v.h}`)) : ALL_VIEWPORTS;

function measure() {
  const vis = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) };
  };
  const SELEMS = [
    '#topright',
    '#wanted',
    '#stars',
    '#wanted-label',
    '#cash',
    '#minimap',
    '#ammo-wrap',
    '#objective',
    '#health-wrap',
    '#hints',
    '#toasts',
    '#help-btn',
  ];
  const panels = [];
  for (const sel of SELEMS) {
    const el = document.querySelector(sel);
    if (vis(el)) panels.push({ sel, el, ...rect(el) });
  }
  const pairs = [];
  for (let i = 0; i < panels.length; i++) {
    for (let j = i + 1; j < panels.length; j++) {
      const a = panels[i];
      const b = panels[j];
      // #topright holds #cash / #wanted / #stars: containment is not a collision
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const ox = +(Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)).toFixed(2);
      const oy = +(Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)).toFixed(2);
      if (ox > 0.5 && oy > 0.5) pairs.push({ a: a.sel, b: b.sel, ox, oy, area: +(ox * oy).toFixed(1) });
    }
  }
  return {
    vw: window.innerWidth,
    vh: window.innerHeight,
    mode: document.body.dataset.hudMode,
    scale: getComputedStyle(document.body).getPropertyValue('--hud-scale').trim(),
    trVar: getComputedStyle(document.body).getPropertyValue('--hud-tr-h').trim(),
    stars: document.getElementById('stars').dataset.n,
    wantedLabel: document.getElementById('wanted-label').textContent,
    layoutInfo: window.__game.hud.layoutInfo,
    panels: panels.map(({ el, ...p }) => p),
    overlaps: pairs,
    maxOverlapArea: pairs.reduce((m, p) => Math.max(m, p.area), 0),
  };
}

/**
 * Earn the stars through the game. hud.setStars() alone is undone by the next update() tick,
 * which republishes police.starCount; the wanted row then collapses back to its clean height
 * and any overlap check below measures a HUD that is not in the state the card is about.
 */
function raiseWanted(n) {
  const g = window.__game;
  g.police.maxCars = 0; // the row is the subject, not the chase
  g.police.addWanted(n);
  g.hud.setStars(g.police.starCount);
  return {
    wanted: g.police.wanted,
    stars: g.police.starCount,
    label: document.getElementById('wanted-label').textContent,
  };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: null,
  });
  const report = { label: LABEL, url: BASE, base: process.env.BASE_COMMIT || null, viewports: [] };
  for (const vp of VIEWPORTS) {
    const tag = `${vp.w}x${vp.h}`;
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errs.push('console: ' + m.text());
    });
    await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1, isMobile: vp.touch, hasTouch: vp.touch });
    await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 240000 });
    await page.waitForFunction('window.__game !== undefined', { timeout: 120000 });
    await sleep(700);
    if (vp.touch) await page.tap('#start-btn');
    else await page.click('#start-btn');
    await page.waitForFunction('window.__game.state.started === true', { timeout: 30000 }).catch(() => {});
    await sleep(600);

    // a HUD with real content: wide cash, a long objective, a weapon, no wanted level yet
    await page.evaluate(() => {
      const g = window.__game;
      const h = g.hud;
      h.setCash(2450);
      h.setHealth(72);
      h.setAmmo(7, 12, false);
      h.setObjective('Drive to the warung before the cops arrive');
      g.police.clearWanted();
      h.setStars(0);
      h.layout();
    });
    await sleep(400);
    const clear = await page.evaluate(measure);

    // the wanted row appears: the right-hand stack grows and everything under it has to move
    const wantedState = await page.evaluate(raiseWanted, 3);
    await sleep(500);
    const wanted = await page.evaluate(measure);
    const atMeasure = await page.evaluate(() => ({
      stars: document.getElementById('stars').dataset.n,
      label: document.getElementById('wanted-label').textContent,
      policeStars: window.__game.police.starCount,
    }));

    const shots = [];
    if (vp.w === 390) {
      const p = path.join(OUT, SHOT);
      await page.screenshot({ path: p });
      shots.push(p);
    }

    const stack = (m, sel) => m.panels.find((p) => p.sel === sel) || null;
    const entry = {
      tag,
      label: vp.label,
      mode: wanted.mode,
      scale: wanted.scale,
      starsClear: {
        trVar: clear.trVar,
        topRight: stack(clear, '#topright'),
        wanted: stack(clear, '#wanted'),
        minimap: stack(clear, '#minimap'),
        overlaps: clear.overlaps.length,
      },
      wantedState: { ...wantedState, atMeasure },
      starsOn: {
        trVar: wanted.trVar,
        topRight: stack(wanted, '#topright'),
        wanted: stack(wanted, '#wanted'),
        minimap: stack(wanted, '#minimap'),
        overlaps: wanted.overlaps.length,
      },
      clearOverlaps: clear.overlaps,
      wantedOverlaps: wanted.overlaps,
      maxOverlapArea: wanted.maxOverlapArea,
      errors: errs.slice(0, 4),
      shots,
    };
    report.viewports.push(entry);

    const h = (v, k) => (v && v[k] !== undefined ? v[k] : '?');
    console.log(`\n== ${tag} ${vp.label} mode=${wanted.mode} scale=${wanted.scale}`);
    console.log(
      `   stars=0  tr-h=${clear.trVar} topright.h=${h(entry.starsClear.topRight, 'h')} wanted.h=${h(entry.starsClear.wanted, 'h')} minimap.y=${h(entry.starsClear.minimap, 'y')} overlaps=${clear.overlaps.length}`,
    );
    console.log(
      `   stars=3  tr-h=${wanted.trVar} topright.h=${h(entry.starsOn.topRight, 'h')} wanted.h=${h(entry.starsOn.wanted, 'h')} minimap.y=${h(entry.starsOn.minimap, 'y')} overlaps=${wanted.overlaps.length}`,
    );
    for (const o of wanted.overlaps) console.log(`   OVERLAP ${o.a} x ${o.b} = ${o.ox} x ${o.oy} px (${o.area} px2)`);
    if (errs.length) console.log('   ERRORS ' + JSON.stringify(errs.slice(0, 3)));
    await page.close();
  }
  // merge with an earlier partial sweep of the same label, so the evidence stays one file
  if (fs.existsSync(JSON_OUT)) {
    try {
      const prev = JSON.parse(fs.readFileSync(JSON_OUT, 'utf8'));
      if (prev.label === report.label) {
        const byTag = new Map(prev.viewports.map((v) => [v.tag, v]));
        for (const v of report.viewports) byTag.set(v.tag, v);
        report.viewports = ALL_VIEWPORTS.map((vp) => byTag.get(`${vp.w}x${vp.h}`)).filter(Boolean);
      }
    } catch {}
  }
  fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
  const worst = report.viewports.reduce((m, v) => Math.max(m, v.maxOverlapArea), 0);
  console.log(
    `\nSUMMARY ${JSON.stringify({ label: LABEL, viewports: report.viewports.length, maxOverlapArea: worst, json: JSON_OUT })}`,
  );
  await browser.close();
  process.exit(worst > 0.5 ? 2 : 0);
})().catch((e) => {
  console.error('HARNESS FAIL', e.message);
  process.exit(1);
});
