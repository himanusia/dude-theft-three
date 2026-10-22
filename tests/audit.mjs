
import puppeteer from 'puppeteer-core';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox','--enable-unsafe-swiftshader','--mute-audio'], defaultViewport: { width: 1400, height: 900 } });
  const page = await b.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto((process.env.DTA_URL || 'http://localhost:8765') + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__game !== undefined', { timeout: 40000 });
  await sleep(1500);
  await page.click('#start-btn');
  await sleep(2500);

  // spawn a few ragdolls + drive so the audit covers more systems
  await page.evaluate(() => {
    const g = window.__game;
    g._test.teleport(26, 6);
    for (let i = 0; i < 3; i++) {
      const ped = g.peds.peds[i];
      ped.pos.set(26 + i * 1.5, g.city.groundHeightAt(26 + i * 1.5, 9), 9);
      ped.target = ped.pos.clone(); ped.speed = 0.0001;
      g._test.punch();
    }
  });
  await sleep(3000);
  const report = await page.evaluate(() => window.__game._test.audit());
  console.log('AUDIT', JSON.stringify(report, null, 1));
  console.log('errors', JSON.stringify(errs.slice(0, 4)));
  await b.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
