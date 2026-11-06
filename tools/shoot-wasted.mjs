/**
 * Proof shot for the wasted card: kill the player and read the card at 0.3 s, 1.0 s and 2.5 s,
 * then prove the run comes back.
 *
 * Two passes, because a headless SwiftShader frame costs ~0.8 s and a wall-clock screenshot of a
 * 3 s sequence cannot land on a millisecond:
 *
 *   A. EXACT — `_test.wastedSeek(ms)` parks the SAME tracks on exactly 300 / 1000 / 2500 ms and
 *              the frame is captured there. No screenshot latency can move the frame, so
 *              "0.3 s after death" is the frame that says 0.3 s.
 *   B. LIVE  — the real fatal hit drives the real clock. The render loop is parked (the card is
 *              CSS-on-the-compositor, not a Three.js effect) so the page can be sampled every
 *              60 ms without the sample queueing behind a frame. This pass records when each
 *              track crosses its threshold, when the player is put back at the spawn and when
 *              the card lifts — i.e. that it plays, in real time, in under 3 s.
 *   C. RUN   — the loop is handed back and a whole card is played on a live loop, to prove the
 *              game resumes: health, money, the spawn point and a moving world.
 *
 * What it measures, not just captures: every stage's computed value at every capture, the
 * saturation of the frame before the hit against the 0.3 s frame, and a pixel diff of each pair.
 * The loop is parked for the captures, so a diff between two frames is the overlay and nothing
 * else: the world does not move under the evidence.
 *
 * usage: DTA_URL=http://127.0.0.1:8993 node tools/shoot-wasted.mjs
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || process.argv[2] || 'http://127.0.0.1:8993';
const OUT_DIR = process.env.SHOT_DIR || 'proof';
const JSON_OUT = process.env.SHOT_JSON || 'proof/wasted.json';
const W = 1400;
const H = 900;
/** the three instants the card is read at, in ms after the fatal hit */
const AT = [300, 1000, 2500];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const dir of new Set([OUT_DIR, path.dirname(JSON_OUT)])) fs.mkdirSync(dir, { recursive: true });

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}

/** computed state of every track of the card, plus the animation clock that produced it */
const readCard = () => {
  const card = document.getElementById('wasted-screen');
  const word = card.querySelector('.wasted-word');
  const rule = card.querySelector('.wasted-rule');
  const fill = card.querySelector('.wasted-rule i');
  const black = card.querySelector('.wasted-black');
  const scaleX = (el) => {
    const t = getComputedStyle(el).transform;
    if (!t || t === 'none') return 1; // scaleX(1) collapses to `none`
    const m = t.match(/matrix\(([^)]+)\)/);
    return m ? +m[1].split(',')[0] : null;
  };
  const tracks = document
    .getAnimations()
    .filter((a) => /^wasted-/.test(a.animationName || ''))
    .map((a) => ({
      name: a.animationName,
      ms: a.currentTime === null ? null : Math.round(a.currentTime),
      state: a.playState,
      duration: a.effect?.getTiming().duration,
    }));
  const tb = word.getBoundingClientRect();
  return {
    on: card.classList.contains('on'),
    body: document.body.classList.contains('wasted'),
    canvasFilter: getComputedStyle(document.getElementById('game')).filter,
    hudFilter: getComputedStyle(document.getElementById('hud')).filter,
    wordOpacity: +getComputedStyle(word).opacity,
    wordScale: scaleX(word),
    wordBox: { x: Math.round(tb.x), y: Math.round(tb.y), w: Math.round(tb.width), h: Math.round(tb.height) },
    ruleScaleX: scaleX(fill),
    ruleWidth: Math.round(rule.getBoundingClientRect().width),
    blackOpacity: +getComputedStyle(black).opacity,
    hpText: (document.getElementById('health-num') || {}).textContent,
    tracks,
  };
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio', `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H },
  protocolTimeout: 300000,
});

try {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 240000 });
  await page.waitForFunction('window.__game !== undefined', { timeout: 120000 });
  await sleep(1200);
  await page.click('#start-btn');
  await sleep(2500);

  const pre = await page.evaluate(() => {
    const g = window.__game;
    return { cash: g.player.cash, hp: g.player.hp, pos: g.player.pos.toArray(), spawn: g.city.getSpawn().toArray() };
  });

  // Park the loop FIRST, so the reference frame and every frame after it are the same picture:
  // a diff between them is then the card and nothing else. The card is CSS on the compositor,
  // not a Three.js effect, so parking the loop does not park the sequence.
  await page.evaluate(() => window.__game._test.freezeLoop(true));
  await sleep(600);
  // a toast from the start screen would sit in the middle of the frame; it is not part of the card
  await page.evaluate(() => document.getElementById('toasts').replaceChildren());
  const beforeFile = path.join(OUT_DIR, 'wasted-before.png');
  await page.screenshot({ path: beforeFile });

  // ---------------------------------------------------------------- pass A: exact frames
  const frames = [];
  for (let i = 0; i < AT.length; i++) {
    await page.evaluate((t) => window.__game._test.wastedSeek(t), AT[i]);
    await sleep(120); // one compositor beat so the parked style is what gets painted
    const state = await page.evaluate(readCard);
    const file = path.join(OUT_DIR, `wasted-${i}.png`);
    await page.screenshot({ path: file });
    frames.push({ i, targetMs: AT[i], file, state });
    console.log('FRAME', i, JSON.stringify({ target: AT[i], state }));
  }

  // the run back: colour, HUD, player at the spawn
  await page.evaluate(() => window.__game._test.wastedSeek(null));
  await sleep(200);
  const afterFile = path.join(OUT_DIR, 'wasted-after.png');
  await page.screenshot({ path: afterFile });

  // ---------------------------------------------------------------- pass B: live timeline
  // The exact instants (card lift, respawn) come from MutationObserver, not from the 60 ms
  // sample loop: "under 3 s" must not be decided by how often we happened to look.
  const t0 = await page.evaluate(() => {
    window.__probe = { cardOffAt: null, bodyOffAt: null, hpBackAt: null };
    const card = document.getElementById('wasted-screen');
    const hp = document.getElementById('health-num');
    new MutationObserver(() => {
      if (window.__probe.cardOffAt === null && !card.classList.contains('on')) {
        window.__probe.cardOffAt = performance.now();
      }
    }).observe(card, { attributes: true, attributeFilter: ['class'] });
    new MutationObserver(() => {
      if (window.__probe.bodyOffAt === null && !document.body.classList.contains('wasted')) {
        window.__probe.bodyOffAt = performance.now();
      }
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    new MutationObserver(() => {
      if (window.__probe.hpBackAt === null && hp.textContent === '100') {
        window.__probe.hpBackAt = performance.now();
      }
    }).observe(hp, { childList: true, characterData: true, subtree: true });
    const t = performance.now();
    window.__game._test.hurt(999); // the real fatal hit, through the real damage path
    return t;
  });

  const timeline = [];
  let atSpawn = null;
  let cardClearedAt = null;
  let wordFullAt = null;
  let ruleDoneAt = null;
  let blackFullAt = null;
  let lastKey = '';
  const deadline = 4200;
  while (true) {
    const s = await page.evaluate(
      (t) => {
        const g = window.__game;
        const card = document.getElementById('wasted-screen');
        const word = card.querySelector('.wasted-word');
        const fill = card.querySelector('.wasted-rule i');
        const black = card.querySelector('.wasted-black');
        const sx = (el) => {
          const tr = getComputedStyle(el).transform;
          if (!tr || tr === 'none') return 1;
          const m = tr.match(/matrix\(([^)]+)\)/);
          return m ? +m[1].split(',')[0] : null;
        };
        return {
          ms: Math.round(performance.now() - t),
          on: card.classList.contains('on'),
          body: document.body.classList.contains('wasted'),
          word: +getComputedStyle(word).opacity,
          rule: sx(fill),
          black: +getComputedStyle(black).opacity,
          hp: Math.round(g.player.hp),
          pos: g.player.pos.toArray().map((v) => +v.toFixed(2)),
        };
      },
      t0
    );
    const key = `${s.on}|${s.word.toFixed(2)}|${s.rule.toFixed(2)}|${s.black.toFixed(2)}|${s.hp}`;
    if (key !== lastKey) {
      timeline.push(s);
      lastKey = key;
    }
    if (wordFullAt === null && s.word > 0.97) wordFullAt = s.ms;
    if (ruleDoneAt === null && s.rule > 0.99) ruleDoneAt = s.ms;
    if (blackFullAt === null && s.black > 0.97) blackFullAt = s.ms;
    if (atSpawn === null && s.hp === 100 && Math.hypot(s.pos[0] - pre.spawn[0], s.pos[2] - pre.spawn[2]) < 1.5) atSpawn = s.ms;
    if (cardClearedAt === null && !s.on && !s.body) cardClearedAt = s.ms;
    if (s.ms > deadline && (cardClearedAt !== null || s.ms > deadline)) break;
    await sleep(60);
  }
  console.log('LIVE', JSON.stringify({ wordFullAt, ruleDoneAt, blackFullAt, atSpawn, cardClearedAt, samples: timeline.length }));
  const exact = await page.evaluate(
    (t) => ({
      cardOffAt: window.__probe.cardOffAt === null ? null : Math.round(window.__probe.cardOffAt - t),
      bodyOffAt: window.__probe.bodyOffAt === null ? null : Math.round(window.__probe.bodyOffAt - t),
      hpBackAt: window.__probe.hpBackAt === null ? null : Math.round(window.__probe.hpBackAt - t),
    }),
    t0
  );
  console.log('EXACT', JSON.stringify(exact));

  // ---------------------------------------------------------------- pass C: real loop, real clock
  await page.evaluate(() => window.__game._test.freezeLoop(false));
  await sleep(600);
  const t1 = await page.evaluate(() => {
    const cash = window.__game.player.cash;
    window.__game._test.wasted();
    return { t: performance.now(), cash };
  });
  await sleep(3400);
  const live = await page.evaluate(
    (t) => {
      const g = window.__game;
      return {
        elapsedMs: Math.round(performance.now() - t),
        hp: g.player.hp,
        cash: g.player.cash,
        pos: g.player.pos.toArray().map((v) => +v.toFixed(2)),
        cardOn: document.getElementById('wasted-screen').classList.contains('on'),
        bodyWasted: document.body.classList.contains('wasted'),
        canvasFilter: getComputedStyle(document.getElementById('game')).filter,
        simTime: g.state.simTime,
      };
    },
    t1.t
  );
  live.cashBefore = t1.cash;
  console.log('LIVE-RUN', JSON.stringify(live));

  // ---------------------------------------------------------------- pixel evidence
  const files = [beforeFile, ...frames.map((f) => f.file), afterFile];
  const b64 = files.map((f) => fs.readFileSync(f).toString('base64'));
  const wordBox = frames[1].state.wordBox;
  const measurePage = await browser.newPage();
  await measurePage.goto('about:blank');
  const px = await measurePage.evaluate(
    async (list, box) => {
      const load = (s) =>
        new Promise((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = rej;
          im.src = 'data:image/png;base64,' + s;
        });
      const ims = [];
      for (const s of list) ims.push(await load(s));
      const grid = (im) => {
        const c = document.createElement('canvas');
        c.width = im.width;
        c.height = im.height;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(im, 0, 0);
        return { w: c.width, h: c.height, d: x.getImageData(0, 0, c.width, c.height).data };
      };
      const gs = ims.map(grid);
      const stats = (g) => {
        let luma = 0;
        let sat = 0;
        let n = 0;
        for (let i = 0; i < g.d.length; i += 4 * 11) {
          const r = g.d[i];
          const gg = g.d[i + 1];
          const b = g.d[i + 2];
          luma += 0.2126 * r + 0.7152 * gg + 0.0722 * b;
          sat += Math.max(r, gg, b) - Math.min(r, gg, b);
          n++;
        }
        return { w: g.w, h: g.h, meanLuma: +(luma / n).toFixed(2), meanSat: +(sat / n).toFixed(2) };
      };
      const diff = (a, b) => {
        let changed = 0;
        let total = 0;
        let sum = 0;
        for (let i = 0; i < a.d.length; i += 4) {
          const d = Math.max(
            Math.abs(a.d[i] - b.d[i]),
            Math.abs(a.d[i + 1] - b.d[i + 1]),
            Math.abs(a.d[i + 2] - b.d[i + 2])
          );
          if (d > 8) changed++;
          sum += d;
          total++;
        }
        return { changedPx: changed, fraction: +(changed / total).toFixed(4), meanDelta: +(sum / total).toFixed(2) };
      };
      /** pixels inside the word's own box that got brighter: with the world parked, that is the type */
      const gain = (a, b, x0, y0, w, h) => {
        let hit = 0;
        for (let y = Math.max(0, y0); y < Math.min(a.h, y0 + h); y++) {
          for (let x = Math.max(0, x0); x < Math.min(a.w, x0 + w); x++) {
            const i = (y * a.w + x) * 4;
            if (b.d[i] - a.d[i] > 40) hit++;
          }
        }
        return hit;
      };
      return {
        frames: gs.map(stats),
        diffs: {
          before_to_300: diff(gs[0], gs[1]),
          '300_to_1000': diff(gs[1], gs[2]),
          '1000_to_2500': diff(gs[2], gs[3]),
          '2500_to_after': diff(gs[3], gs[4]),
        },
        wordInk: gain(gs[0], gs[2], box.x, box.y, box.w, box.h),
        wordInkAt300: gain(gs[0], gs[1], box.x, box.y, box.w, box.h),
        box,
      };
    },
    b64,
    wordBox
  );
  await measurePage.close();

  // ---------------------------------------------------------------- verdict
  const [beforeStats, s0, s1, s2, sAfter] = px.frames;
  const d = px.diffs;
  const f0 = frames[0];
  const f1 = frames[1];
  const f2 = frames[2];
  const near = (a, b, tol) => a !== null && Math.abs(a - b) <= tol;
  const trackNames = [...new Set(f1.state.tracks.map((t) => t.name))];

  check(
    'the card runs four tracks on one 2.9 s clock',
    trackNames.length === 4 && f1.state.tracks.every((t) => t.duration === 2900),
    f1.state.tracks.map((t) => `${t.name}@${t.duration}`)
  );
  check(
    'exact captures: 0.3 / 1.0 / 2.5 s',
    f0.state.tracks.every((t) => t.ms === 300) &&
      f1.state.tracks.every((t) => t.ms === 1000) &&
      f2.state.tracks.every((t) => t.ms === 2500),
    frames.map((f) => f.state.tracks.map((t) => t.ms).join('/'))
  );
  check(
    'live: the four stages land in order on the real clock',
    wordFullAt !== null &&
      ruleDoneAt !== null &&
      blackFullAt !== null &&
      wordFullAt < ruleDoneAt &&
      ruleDoneAt < blackFullAt &&
      near(blackFullAt, 2410, 260) &&
      near(exact.cardOffAt, 2900, 160),
    { wordFullAt, ruleDoneAt, blackFullAt, ...exact }
  );
  check('live: the whole card is over inside 3 s', exact.cardOffAt !== null && exact.cardOffAt < 3000, exact.cardOffAt);
  check('live: the player is put back at the spawn under the black', near(exact.hpBackAt, 2610, 220), exact.hpBackAt);
  check(
    '0.3 s: the frame has lost most of its colour, the word is still arriving, no rule yet',
    s0.meanSat < beforeStats.meanSat * 0.55 &&
      f0.state.wordOpacity > 0.15 &&
      f0.state.wordOpacity < 0.9 &&
      f0.state.ruleScaleX < 0.05,
    {
      satBefore: beforeStats.meanSat,
      satAt300: s0.meanSat,
      ratio: +(s0.meanSat / beforeStats.meanSat).toFixed(2),
      word: f0.state.wordOpacity,
      scale: f0.state.wordScale,
      rule: f0.state.ruleScaleX,
    }
  );
  check(
    '1.0 s: the frame is grey, the word is up and the hairline rule is drawn under it',
    f1.state.wordOpacity >= 0.99 &&
      f1.state.ruleScaleX >= 0.99 &&
      f1.state.ruleWidth > 200 &&
      /saturate\(0\.0/.test(f1.state.canvasFilter) &&
      px.wordInk > 6000,
    { word: f1.state.wordOpacity, scale: f1.state.wordScale, rule: f1.state.ruleScaleX, ink: px.wordInk }
  );
  check(
    '2.5 s: the screen is black and the rule is complete',
    f2.state.blackOpacity >= 0.95 && s2.meanLuma < 24 && f2.state.ruleScaleX > 0.99,
    { black: f2.state.blackOpacity, meanLuma: s2.meanLuma }
  );
  check('0.3 s -> 1.0 s changed the picture', d['300_to_1000'].fraction > 0.01, d['300_to_1000']);
  check('1.0 s -> 2.5 s changed the picture', d['1000_to_2500'].fraction > 0.5, d['1000_to_2500']);
  check('either side of the hit is visibly different', d.before_to_300.fraction > 0.2, d.before_to_300);
  check(
    'the card owns the health readout while it is up',
    frames.every((f) => f.state.hpText === '0'),
    frames.map((f) => f.state.hpText)
  );
  check(
    'drift control: card cleared returns the SAME frame, in colour',
    d['2500_to_after'].fraction > 0.5 &&
      Math.abs(sAfter.meanSat - beforeStats.meanSat) < 0.6 &&
      Math.abs(sAfter.meanLuma - beforeStats.meanLuma) < 2,
    { diff: d['2500_to_after'], satBefore: beforeStats.meanSat, satAfter: sAfter.meanSat, lumaBefore: beforeStats.meanLuma, lumaAfter: sAfter.meanLuma }
  );
  check(
    'live run: card gone, health back, bill charged once, world running',
    !live.cardOn && !live.bodyWasted && live.hp === 100 && live.cash === Math.max(0, live.cashBefore - 100) && live.simTime > 1,
    live
  );
  check('no page errors', errs.length === 0, errs.slice(0, 3));

  const failed = checks.filter((c) => !c.ok);
  const report = {
    url: BASE,
    viewport: { w: W, h: H },
    before: { file: beforeFile, ...beforeStats },
    captureNote:
      'frames are parked with _test.wastedSeek(ms) because a headless SwiftShader screenshot costs ~0.8 s; ' +
      'the live pass records the same tracks crossing their thresholds on the real clock.',
    frames: frames.map((f, i) => ({ ...f, pixels: [s0, s1, s2][i] })),
    after: { file: afterFile, ...sAfter },
    diffs: d,
    wordInk: { at1000: px.wordInk, at300: px.wordInkAt300, box: px.box },
    liveTimeline: { wordFullAt, ruleDoneAt, blackFullAt, atSpawn, cardClearedAt, exact, samples: timeline },
    liveRun: live,
    checks,
    summary: { pass: checks.length - failed.length, total: checks.length },
  };
  fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
  console.log('SUMMARY', JSON.stringify(report.summary));
  console.log('WROTE', JSON_OUT, files.join(' '));
  if (failed.length) process.exitCode = 1;
} finally {
  await browser.close();
}
