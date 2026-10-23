// Proof shots for the street kit: each builder alone in the asset viewer, then the junction as the
// city now builds it. Not part of the game; run against a served dist.
// usage: node tools/shoot-streetkit.mjs [baseUrl]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || process.argv[2] || 'http://127.0.0.1:8961';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync('screenshots/proof', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  defaultViewport: { width: 1600, height: 1000 },
});

const errors = [];
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
});

// ---- 1. each part on its own, neutral studio light
const parts = ['road', 'kerb', 'junction', 'signal', 'furniture', 'all'];
for (const part of parts) {
  const url = `${BASE}/tools/asset-viewer.html?kind=street&part=${part}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__viewer && window.__viewer.ready === true', { timeout: 60000 });
  await sleep(700);
  const out = `screenshots/proof/streetkit-${part}.png`;
  await page.screenshot({ path: out });
  console.log('SHOT', out);
}

// ---- 2. the junction where the city builds it, played through the real game
const game = await browser.newPage();
game.on('pageerror', (e) => errors.push('game: ' + e.message));
await game.setViewport({ width: 1600, height: 1000 });
await game.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 90000 });
await game.waitForFunction('window.__game !== undefined', { timeout: 90000 });
await game.click('#start-btn');
await sleep(2500);
const info = await game.evaluate(() => {
  const g = window.__game;
  g._test.cinematic(true);
  const hud = document.getElementById('hud');
  if (hud) hud.style.display = 'none';
  const audit = (g.city.propAudit || []).filter((a) => String(a.name).startsWith('street:'));
  return { audit, colliders: g.city.colliders.length };
});
console.log('KIT AUDIT', JSON.stringify(info.audit));

// cameras are low, on the carriageway, and framed on the part under test - the first pass put the
// junction camera behind a shopfront, which made a wall the subject
const views = [
  { name: 'streetkit', from: [82, 9.5, -134], at: [97, 1.0, -112] },
  { name: 'streetkit-junction-close', from: [90.5, 1.9, -131], at: [99, 1.0, -112] },
  { name: 'streetkit-kerb-close', from: [97.6, 1.35, -104.6], at: [101.4, 0.35, -109.4] },
  { name: 'streetkit-signal-close', from: [102.5, 3.2, -96.5], at: [104.6, 5.1, -104.2] },
  { name: 'streetkit-furniture-close', from: [100.2, 2.6, -102.2], at: [109, 4.2, -110.4] },
  { name: 'streetkit-road-close', from: [92.4, 1.8, -71.5], at: [96, 0.7, -92] },
];
for (const v of views) {
  await game.evaluate(
    ([px, py, pz, tx, ty, tz]) => window.__game._test.lookFrom(px, py, pz, tx, ty, tz),
    [...v.from, ...v.at]
  );
  await sleep(450);
  await game.screenshot({ path: `screenshots/proof/${v.name}.png` });
  console.log('SHOT', `screenshots/proof/${v.name}.png`);
}

console.log('ERRORS', JSON.stringify(errors.slice(0, 6)));
await browser.close();
