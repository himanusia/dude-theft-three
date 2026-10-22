
import puppeteer from 'puppeteer-core';
import path from 'node:path';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const OUT = new URL('../screenshots', import.meta.url).pathname;
const results = [];
const check = (n, ok, d) => { results.push({ n, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' :: ' + JSON.stringify(d) : '')); };

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox','--enable-unsafe-swiftshader','--mute-audio'], defaultViewport: { width: 1500, height: 900 } });
  const page = await b.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto((process.env.DTA_URL || 'http://localhost:8765') + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__game !== undefined', { timeout: 60000 });
  await sleep(1500);
  await page.click('#start-btn');
  await sleep(2200);

  const doors = await page.evaluate(() => window.__game.city.shopDoors.length);
  check('shop doors registered', doors > 5, { doors });

  const kinds = await page.evaluate(() => window.__game.city.interiors.map(r => ({ kind: r.kind, name: r.name, at: [r.origin.x, r.origin.z] })));
  check('four reusable interiors built', kinds.length === 4, kinds);

  // walk to the first door and enter
  const door = await page.evaluate(() => {
    const g = window.__game;
    const d = g.city.shopDoors[0];
    g._test.teleport(d.x, d.z + 0.6);
    g._test.setCam(Math.PI, 0.1);
    return d;
  });
  await sleep(700);
  const prompt = await page.evaluate(() => document.getElementById('prompt').textContent);
  check('prompt offers to enter the shop', /masuk/i.test(prompt), { prompt });
  await page.screenshot({ path: path.join(OUT, 'indo-shopfront.png') });

  await page.keyboard.press('e');
  await sleep(900);
  const inside = await page.evaluate(() => {
    const g = window.__game;
    return g.player.inInterior ? { kind: g.player.inInterior.kind, name: g.player.inInterior.name, pos: g.player.pos.toArray().map(v => +v.toFixed(1)), prompt: document.getElementById('prompt').textContent } : null;
  });
  check('E teleports into the interior', !!inside, inside);
  await page.screenshot({ path: path.join(OUT, 'indo-interior.png') });

  // walk around inside, check we stay in the room
  await page.keyboard.down('w'); await sleep(900); await page.keyboard.up('w');
  const moved = await page.evaluate(() => {
    const g = window.__game;
    const r = g.player.inInterior;
    return r ? { inside: g.player.pos.x > r.origin.x - 7 && g.player.pos.x < r.origin.x + 7, pos: g.player.pos.toArray().map(v => +v.toFixed(1)) } : null;
  });
  check('player moves inside the room and stays inside', moved && moved.inside, moved);

  // audit while indoors (no floating actors should appear)
  const audit = await page.evaluate(() => window.__game._test.audit());
  check('audit clean indoors', audit.peds.length === 0 && audit.props.length === 0, { peds: audit.peds.length, props: audit.props.length });

  await page.keyboard.press('e');
  await sleep(800);
  const outside = await page.evaluate(() => ({ inside: !!window.__game.player.inInterior, pos: window.__game.player.pos.toArray().map(v => +v.toFixed(1)) }));
  check('E exits back outside', outside.inside === false, outside);

  // check every kind renders without errors
  for (const k of ['minimarket', 'warteg', 'bengkel', 'kopi']) {
    await page.evaluate((kind) => {
      const g = window.__game;
      const d = g.city.shopDoors.find(s => s.kind === kind);
      g._test.teleport(d.x, d.z + 0.4);
    }, k);
    await sleep(350);
    await page.keyboard.press('e');
    await sleep(500);
    const state = await page.evaluate(() => ({ kind: window.__game.player.inInterior && window.__game.player.inInterior.kind }));
    check('enter ' + k, state.kind === k, state);
    await page.screenshot({ path: path.join(OUT, `indo-${k}.png`) });
    await page.keyboard.press('e');
    await sleep(400);
  }

  const failed = results.filter(r => !r.ok);
  console.log('errors:', JSON.stringify(errs.slice(0, 5)));
  console.log('SUMMARY', JSON.stringify({ pass: results.length - failed.length, total: results.length }));
  await b.close();
  if (failed.length) {
    console.error(`interior: ${failed.length}/${results.length} checks failed`);
    process.exitCode = 1;
  }
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
