// Screenshots the two TransJakarta assets from the built viewer and prints the measured
// triangle / draw-call counts the page reports from renderer.info.
// usage: node tools/shoot-tj.mjs [baseUrl]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.TJ_URL || process.argv[2] || 'http://127.0.0.1:8872';

fs.mkdirSync('screenshots/proof', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
});

for (const [subject, file] of [
  ['bus', 'screenshots/proof/transjakarta-3q.png'],
  ['halte', 'screenshots/proof/halte-3q.png'],
]) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error(`[${subject}] pageerror`, e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error(`[${subject}] console`, m.text());
  });
  await page.goto(`${BASE}/tools/tj-viewer.html?subject=${subject}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction('window.__tj && window.__tj.ready', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 350));
  const stats = await page.evaluate(() => window.__tj.stats);
  await page.screenshot({ path: file });
  console.log(`${subject}: ${JSON.stringify(stats)} -> ${file}`);
  await page.close();
}

await browser.close();
