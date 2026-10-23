
import puppeteer from 'puppeteer-core';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox','--enable-unsafe-swiftshader','--mute-audio'], defaultViewport: { width: 1400, height: 900 } });
  const page = await b.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  // the scene builds the whole city before the module finishes evaluating, so a loaded machine
  // needs well over Chrome's 30 s default just to reach DOMContentLoaded
  await page.goto((process.env.DTA_URL || 'http://127.0.0.1:8765') + '/index.html', { waitUntil: 'domcontentloaded', timeout: 180000 });
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

  check('no floating pedestrians', report.peds.length === 0, report.peds.slice(0, 5));
  check('no floating ragdolls', report.ragdolls.length === 0, report.ragdolls.slice(0, 5));
  check('no floating cars', report.cars.length === 0, report.cars.slice(0, 5));
  check('no floating props', report.props.length === 0, report.props.slice(0, 5));
  check('no floating buildings', report.buildings.length === 0, report.buildings.slice(0, 5));
  check('no page errors', errs.length === 0, errs.slice(0, 4));

  const failed = results.filter(r => !r.ok);
  console.log('SUMMARY', JSON.stringify({ pass: results.length - failed.length, total: results.length }));
  await b.close();
  if (failed.length) {
    console.error(`audit: ${failed.length}/${results.length} checks failed`);
    process.exitCode = 1;
  }
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
