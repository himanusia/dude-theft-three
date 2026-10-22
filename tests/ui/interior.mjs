
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
  // the module can still be compiling shaders when the click lands, so wait for the run loop
  await page.waitForFunction(() => window.__game.state.started === true, { timeout: 30000 }).catch(() => {});
  const startedUp = await page.evaluate(() => window.__game.state.started === true && window.__game.state.paused === false);
  check('start button starts the game', startedUp);
  await sleep(1600);

  // leave any open room before walking to a different door
  const leaveInterior = async () => {
    for (let i = 0; i < 3; i++) {
      const inside = await page.evaluate(() => !!window.__game.player.inInterior);
      if (!inside) return true;
      await page.keyboard.press('e');
      await sleep(450);
    }
    return !(await page.evaluate(() => !!window.__game.player.inInterior));
  };

  // walk up to a shop door from the street: doors store their facade normal, so we
  // always stand on the street side instead of guessing an offset
  const approach = async (door) => {
    const nx = door.nx ?? 0;
    const nz = door.nz ?? 1;
    const tx = nz;
    const tz = -nx;
    const points = [
      [door.x + nx * 0.9, door.z + nz * 0.9],
      [door.x + nx * 1.6, door.z + nz * 1.6],
      [door.x + nx * 2.4, door.z + nz * 2.4],
      [door.x + nx * 1.2 + tx * 1.3, door.z + nz * 1.2 + tz * 1.3],
      [door.x + nx * 1.2 - tx * 1.3, door.z + nz * 1.2 - tz * 1.3],
    ];
    for (const [x, z] of points) {
      await page.evaluate(({ px, pz }) => window.__game._test.teleport(px, pz), { px: x, pz: z });
      await sleep(300);
      const text = await page.evaluate(() => document.getElementById('prompt').textContent);
      if (/masuk/i.test(text)) return text;
    }
    return null;
  };

  // a kind may have several doors; use the first one the player can actually reach
  const findDoor = async (kind) => {
    const doors = await page.evaluate((k) => window.__game.city.shopDoors
      .filter((s) => s.kind === k)
      .slice(0, 4)
      .map((s) => ({ x: s.x, z: s.z, nx: s.nx, nz: s.nz, kind: s.kind, name: s.name })), kind);
    for (const d of doors) {
      await leaveInterior();
      const text = await approach(d);
      if (text) return { door: d, prompt: text };
    }
    return { door: doors[0] ?? null, prompt: null };
  };

  const doors = await page.evaluate(() => window.__game.city.shopDoors.length);
  check('shop doors registered', doors > 5, { doors });

  const kinds = await page.evaluate(() => window.__game.city.interiors.map(r => ({ kind: r.kind, name: r.name, at: [r.origin.x, r.origin.z] })));
  check('reusable interiors built once per kind', kinds.length >= 4 && new Set(kinds.map(r => r.kind)).size === kinds.length, kinds);
  const kindList = kinds.map(r => r.kind);
  console.log('KINDS ' + JSON.stringify(kindList));
  check('apotek/laundry/salon interiors exist', ['apotek', 'laundry', 'salon'].every(k => kindList.includes(k)), kindList);

  // walk to the first door and enter
  const door = await page.evaluate(() => {
    const g = window.__game;
    const d = g.city.shopDoors[0];
    g._test.setCam(Math.PI, 0.1);
    return d;
  });
  const prompt = await approach(door);
  check('prompt offers to enter the shop', !!prompt, { prompt });
  // frame the shopfront from the street side of the door (facades face any direction)
  await page.evaluate((d) => {
    const nx = d.nx ?? 0;
    const nz = d.nz ?? 1;
    const tx = nz;
    const tz = -nx;
    window.__game._test.lookFrom(d.x + nx * 6.2 + tx * 1.6, 2.1, d.z + nz * 6.2 + tz * 1.6, d.x + nx * 0.1, 1.6, d.z + nz * 0.1);
  }, door);
  await sleep(350);
  await page.screenshot({ path: path.join(OUT, 'indo-shopfront.png') });
  await page.evaluate(() => window.__game._test.cinematic(false));
  await sleep(250);

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

  const exitedFirst = await leaveInterior();
  const outside = await page.evaluate(() => ({ pos: window.__game.player.pos.toArray().map(v => +v.toFixed(1)) }));
  check('E exits back outside', exitedFirst && outside.pos.length === 3, outside);

  // check every kind renders without errors, driving the loop from the live kind list
  for (const k of kindList) {
    const { door: found, prompt: doorPrompt } = await findDoor(k);
    check('shop door for ' + k, !!found, found);
    if (!found) continue;
    check('prompt for ' + k, !!doorPrompt, { doorPrompt });
    if (!doorPrompt) continue;
    await page.keyboard.press('e');
    await sleep(500);
    const state = await page.evaluate(() => ({ kind: window.__game.player.inInterior && window.__game.player.inInterior.kind }));
    check('enter ' + k, state.kind === k, state);
    const visible = await page.evaluate(() => window.__game.city.interiors.filter(r => r.group.visible).map(r => r.kind));
    check('only ' + k + ' room visible', visible.length === 1 && visible[0] === k, visible);
    // frame the room from the doorway corner so the layout is readable in the shot
    await page.evaluate(() => {
      const g = window.__game;
      const r = g.player.inInterior;
      if (!r) return;
      const hw = (r.bounds.maxX - r.bounds.minX) / 2;
      const hd = (r.bounds.maxZ - r.bounds.minZ) / 2;
      g._test.lookFrom(
        r.origin.x + hw - 1.1, 2.35, r.origin.z + hd - 1.2,
        r.origin.x - 0.5, 1.05, r.origin.z - hd + 0.5
      );
    });
    await sleep(450);
    await page.screenshot({ path: path.join(OUT, `indo-${k}.png`) });
    await page.evaluate(() => window.__game._test.cinematic(false));
    await sleep(250);
    const left = await leaveInterior();
    check('exit ' + k, left);
  }

  // street dressing: warung tenda, spanduk and the parked angkot in one shot
  const street = await page.evaluate(() => {
    const g = window.__game;
    const spots = g.city.dressingSpots || [];
    const warung = spots.find(s => s.type === 'warung');
    if (!warung) return null;
    const spanduk = spots.filter(s => s.type === 'spanduk').sort((a, b) => Math.hypot(a.x - warung.x, a.z - warung.z) - Math.hypot(b.x - warung.x, b.z - warung.z))[0];
    g._test.teleport(warung.x + 1.5, warung.z + 8);
    g._test.lookFrom(warung.x - 9.0, 3.1, warung.z + 10.7, warung.x + 5.0, 2.4, warung.z + 0.7);
    return { warung, spanduk, angkot: spots.filter(s => s.type === 'angkot').length, becak: spots.filter(s => s.type === 'becak').length };
  });
  check('street dressing placed', !!street && !!street.spanduk && street.angkot >= 1 && street.becak >= 1, street);
  await sleep(500);
  await page.screenshot({ path: path.join(OUT, 'indo-street-dressing.png') });
  await page.evaluate(() => window.__game._test.cinematic(false));
  const failed = results.filter(r => !r.ok);
  console.log('errors:', JSON.stringify(errs.slice(0, 5)));
  console.log('SUMMARY', JSON.stringify({ pass: results.length - failed.length, total: results.length }));
  await b.close();
  if (failed.length) {
    console.error(`interior: ${failed.length}/${results.length} checks failed`);
    process.exitCode = 1;
  }
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
