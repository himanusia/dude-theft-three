// Palette measurement harness: compares the built game against the DTW reference stills.
//
//   DTA_URL=http://localhost:8794 node tests/palette.mjs
//   DTA_URL=http://localhost:8794 SHOT_DIR=/tmp/before node tests/palette.mjs
//
// Prints mean RGB, brightness, HSV saturation and the R/G/B spread for both sides on a
// downscaled 160x90 grid (same sampling the orchestrator used), then gates the game
// numbers against the bands the texture pass has to land in.
import puppeteer from 'puppeteer-core';
import { inflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const ROOT = new URL('..', import.meta.url).pathname;
const SHOT_DIR = process.env.SHOT_DIR || path.join(ROOT, 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- minimal PNG reader
// puppeteer screenshots and the reference stills are 8-bit, non-interlaced PNGs.
export function decodePNG(buf) {
  let pos = 8;
  let w = 0, h = 0, depth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (depth !== 8) throw new Error('unsupported bit depth ' + depth);
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!ch) throw new Error('unsupported colour type ' + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    prev = cur;
  }
  return { w, h, ch, data: out };
}

// ---------------------------------------------------------------- stats
export function stats(png, gridW = 160, gridH = 90) {
  const { w, h, ch, data } = png;
  let r = 0, g = 0, b = 0, sat = 0;
  const cells = gridW * gridH;
  for (let gy = 0; gy < gridH; gy++) {
    const y0 = Math.floor((gy * h) / gridH);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * h) / gridH));
    for (let gx = 0; gx < gridW; gx++) {
      const x0 = Math.floor((gx * w) / gridW);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * w) / gridW));
      let cr = 0, cg = 0, cb = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        let i = (y * w + x0) * ch;
        for (let x = x0; x < x1; x++, i += ch) {
          cr += data[i];
          cg += data[i + 1];
          cb += data[i + 2];
          n++;
        }
      }
      cr /= n; cg /= n; cb /= n;
      r += cr; g += cg; b += cb;
      const mx = Math.max(cr, cg, cb), mn = Math.min(cr, cg, cb);
      sat += mx > 0 ? (mx - mn) / mx : 0;
    }
  }
  r /= cells; g /= cells; b /= cells; sat /= cells;
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  return {
    rgb: [+r.toFixed(1), +g.toFixed(1), +b.toFixed(1)],
    brightness: +(((r + g + b) / 3).toFixed(1)),
    sat: +sat.toFixed(3),
    spread: +spread.toFixed(1),
  };
}

// ---------------------------------------------------------------- bands
const BANDS = {
  brightness: [126, 136],
  sat: [0.4, 0.55],
  spread: [0, 12],
};
const inBand = (v, [lo, hi]) => v >= lo && v <= hi;

function report(label, s, gate) {
  const cells = [
    `bright ${s.brightness}${gate ? (inBand(s.brightness, BANDS.brightness) ? ' ok' : ' OFF') : ''}`,
    `sat ${s.sat}${gate ? (inBand(s.sat, BANDS.sat) ? ' ok' : ' OFF') : ''}`,
    `spread ${s.spread}${gate ? (inBand(s.spread, BANDS.spread) ? ' ok' : ' OFF') : ''}`,
  ];
  console.log(`${label.padEnd(26)} rgb=${JSON.stringify(s.rgb).padEnd(22)} ${cells.join('  ')}`);
}

// ---------------------------------------------------------------- shots
const SHOTS = [
  {
    name: 'street',
    setup: async (page) => {
      await page.evaluate(() => {
        const g = window.__game;
        g._test.teleport(26, -46);
        g._test.setCam(Math.PI, 0.09);
      });
      await sleep(1400);
    },
  },
  {
    name: 'driving',
    setup: async (page) => {
      await page.evaluate(() => {
        const g = window.__game;
        const c = g.cityCars.find((c) => !c.wrecked);
        c.pos.set(26, 0, -40); c.yaw = 0; c.mesh.position.copy(c.pos); c.mesh.rotation.y = 0;
        g._test.teleport(28.2, -40);
      });
      await sleep(400);
      await page.keyboard.press('f');
      await sleep(400);
      // Park the car in a fixed spot before the shot. Driving for a fixed number of
      // milliseconds made the frame depend on frame rate (the car covered 20-40 m
      // depending on machine load), which moved brightness by +/-6 between runs.
      await page.evaluate(() => {
        const g = window.__game;
        const c = g.player.inCar;
        if (!c) return;
        c.pos.set(26, 0, -40);
        c.yaw = 0;
        c.mesh.position.copy(c.pos);
        c.mesh.rotation.y = 0;
        if (c.vel && c.vel.set) c.vel.set(0, 0, 0);
      });
      await sleep(900);
    },
  },
];

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const base = process.env.DTA_URL || 'http://localhost:8765';
  // Prove the server is actually serving the build in this worktree before any pixel is
  // trusted: another lane's serve.py on the same port silently served a stale bundle once.
  const distIndex = fs.readFileSync(path.join(ROOT, 'dist/index.html'), 'utf8');
  const wantHash = (distIndex.match(/assets\/main-([\w-]+)\.js/) || [])[1];
  const servedIndex = await (await fetch(base + '/index.html')).text();
  const gotHash = (servedIndex.match(/assets\/main-([\w-]+)\.js/) || [])[1];
  if (wantHash !== gotHash) {
    console.error(`HARNESS FAIL served build ${gotHash} != local dist ${wantHash}; rebuild or point DTA_URL at this worktree`);
    process.exit(1);
  }
  console.log(`build ${gotHash} (matches local dist)`);
  const ROUNDS = Number(process.env.ROUNDS || 3);
  // the city is procedural: one load gives one random layout, so average a few loads
  const all = new Map();
  let perf = null;
  for (let round = 0; round < ROUNDS; round++) {
    const url = base + '/index.html?round=' + round;
    const b = await puppeteer.launch({
      executablePath: CHROME,
      headless: 'new',
      args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
      defaultViewport: { width: 1500, height: 900 },
    });
    const page = await b.newPage();
    // Seed Math.random *before* the bundle runs: the city layout is procedural, and an
    // unseeded load swung the frame mean by ~20 RGB just from which block the camera
    // happened to face. Each round is therefore a repeatable layout, not a coin flip.
    await page.evaluateOnNewDocument((s) => {
      let a = s >>> 0;
      Math.random = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }, 1000 + round * 7919);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__game !== undefined', { timeout: 40000 });
    await page.click('#start-btn');
    await sleep(1500);
    await page.evaluate(() => window.__game._test.setTime(0.5)); // noon
    await sleep(1200);

    for (const shot of SHOTS) {
      await shot.setup(page);
      const file = path.join(SHOT_DIR, `palette-${shot.name}-r${round}.png`);
      await page.screenshot({ path: file });
      const s = stats(decodePNG(fs.readFileSync(file)));
      if (!all.has(shot.name)) all.set(shot.name, []);
      all.get(shot.name).push(s);
      console.log(`round ${round} ${shot.name.padEnd(8)} rgb=${JSON.stringify(s.rgb)} bright ${s.brightness} sat ${s.sat} spread ${s.spread}`);
    }
    perf = await page.evaluate(() => ({ fps: window.__game.state.fps, calls: window.__game.state.calls, tris: window.__game.state.tris }));
    await b.close();
    if (round === 0) {
      // keep the first-round frames as the committed evidence set
      for (const shot of SHOTS) fs.copyFileSync(path.join(SHOT_DIR, `palette-${shot.name}-r0.png`), path.join(SHOT_DIR, `palette-${shot.name}.png`));
    }
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const game = [...all.entries()].map(([name, xs]) => ({
    name,
    s: {
      rgb: [0, 1, 2].map((i) => +mean(xs.map((x) => x.rgb[i])).toFixed(1)),
      brightness: +mean(xs.map((x) => x.brightness)).toFixed(1),
      sat: +mean(xs.map((x) => x.sat)).toFixed(3),
      spread: +mean(xs.map((x) => x.spread)).toFixed(1),
    },
  }));

  console.log(`\nDTA_URL ${base}  rounds ${ROUNDS}`);
  console.log('--- game (after, mean of rounds) ---');
  for (const g of game) report(g.name, g.s, true);

  console.log('--- reference targets ---');
  const refDir = path.join(ROOT, 'reference');
  const refs = ['dtw-02.png', 'dtw-03.png'];
  let missing = 0;
  for (const r of refs) {
    const p = path.join(refDir, r);
    if (!fs.existsSync(p)) { console.log(`${r.padEnd(26)} not present (gitignored reference stills)`); missing++; continue; }
    report(r, stats(decodePNG(fs.readFileSync(p))), false);
  }

  const fails = [];
  for (const g of game) {
    if (!inBand(g.s.brightness, BANDS.brightness)) fails.push(`${g.name} brightness ${g.s.brightness} outside ${BANDS.brightness}`);
    if (!inBand(g.s.sat, BANDS.sat)) fails.push(`${g.name} saturation ${g.s.sat} outside ${BANDS.sat}`);
    if (!inBand(g.s.spread, BANDS.spread)) fails.push(`${g.name} rgb spread ${g.s.spread} outside ${BANDS.spread}`);
  }
  console.log(`\nperf ${JSON.stringify(perf)}`);
  console.log(`SUMMARY ${JSON.stringify({ pass: game.length * 3 - fails.length, total: game.length * 3, refs_missing: missing })}`);
  for (const f of fails) console.log('OFF-BAND ' + f);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('HARNESS FAIL', e); process.exit(1); });
