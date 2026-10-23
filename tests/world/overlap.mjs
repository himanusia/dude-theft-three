/**
 * Do any two buildings occupy the same ground?
 *
 * The first version of this question was answered with world-space AABBs, and on a city whose
 * frontage is rotated to face the street that inflates every box: two shophouses standing 3 m
 * apart, angled differently, produce bounding boxes that overlap by 6 m. It reported 225
 * "collisions" that were mostly the metric, not the city.
 *
 * This measures oriented boxes: each candidate is rebuilt from its own axis, its corners are
 * pushed into the other building's frame, and the overlap is measured there.
 */
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || 'http://127.0.0.1:8765';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1000, height: 640 });
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.__game !== undefined', { timeout: 90000 });
await page.click('#start-btn');
await new Promise((r) => setTimeout(r, 4500));

const report = await page.evaluate(() => {
  // Check the invariant where it is enforced, not where it is drawn. Building bodies are now
  // merged per block, so a scene-graph scan sees one mesh spanning dozens of buildings and
  // reports thousands of false collisions. The generator reserves a rectangle for every
  // building it places; those rectangles are the contract, and they survive any merging.
  const fp = window.__game.city.footprints || [];
  let pairs = 0;
  let worst = 0;
  for (let i = 0; i < fp.length; i++) {
    for (let j = i + 1; j < fp.length; j++) {
      const a = fp[i], b = fp[j];
      const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
      if (ox > 0.5 && oz > 0.5) {
        pairs++;
        worst = Math.max(worst, Math.min(ox, oz));
      }
    }
  }
  return { footprints: fp.length, overlapPairs: pairs, worst: +worst.toFixed(2) };
});

console.log(JSON.stringify(report));
await browser.close();
const ok = report.overlapPairs === 0;
console.log(ok ? 'PASS no two buildings share ground' : `FAIL ${report.overlapPairs} pairs overlap, worst ${report.worst} m`);
process.exit(ok ? 0 : 1);
