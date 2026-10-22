// Renders the Jakarta cartographic poster from the live module namespace.
//
// The drawing code lives in tools/map-poster.js and runs inside the game page, so the poster is
// built from src/world/jakartamap.ts + streets.ts + terrain.ts and cannot drift from the world.
//
//   npm run build && python3 serve.py 8871
//   node tools/render-map-design.mjs
//
// Writes docs/map-jakarta-design.png (2000x2000, whole city) and docs/map-jakarta-core.png
// (1600x1600, core at exactly 2x the poster scale).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL_ = process.env.DTA_URL || 'http://127.0.0.1:8871/';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio', '--force-color-profile=srgb'],
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.goto(URL_, { waitUntil: 'networkidle2' });
  await page.waitForFunction('window.__game !== undefined', { timeout: 60000 });
  const start = await page.$('#start-btn');
  if (start) {
    await start.click();
    await new Promise((r) => setTimeout(r, 1200));
  }

  const source = fs.readFileSync(path.join(HERE, 'map-poster.js'), 'utf8');
  const t0 = Date.now();
  const out = await page.evaluate(source);
  if (!out || !out.ok) throw new Error('renderer returned no panels');

  const write = (file, dataUrl) => {
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
    fs.writeFileSync(path.join(ROOT, file), buf);
    console.log(`${file}  ${(buf.length / 1024).toFixed(0)} kB`);
  };
  write('docs/map-jakarta-design.png', out.main);
  write('docs/map-jakarta-core.png', out.core);

  const km = (m) => (m / 1000).toFixed(2);
  console.log(`extent  ${km(out.dataW)} x ${km(out.dataH)} km   centre (${(out.bbox.x0 + out.bbox.x1) / 2}, ${(out.bbox.z0 + out.bbox.z1) / 2})`);
  console.log(`elevation  main ${out.mainMinH.toFixed(1)}..${out.mainMaxH.toFixed(1)} m   core ${out.coreMinH.toFixed(1)} m`);
  console.log(`scale  ${out.scale.toFixed(4)} px/m  core ${out.scale2.toFixed(4)} px/m = ${(out.scale2 / out.scale).toFixed(2)}x`);
  console.log(`rendered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} finally {
  await browser.close();
}
