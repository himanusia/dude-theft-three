
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL_ = process.env.DTA_URL || 'http://127.0.0.1:8765';
const OUT = '/Users/mac/Code/dude-theft-three/screenshots/proof';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox','--enable-unsafe-swiftshader','--mute-audio','--autoplay-policy=no-user-gesture-required'], defaultViewport: { width: 1600, height: 900 } });
const p = await b.newPage();
const errs = [];
p.on('pageerror', e => errs.push(e.message));
await p.goto(URL_ + '/index.html', { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.__game !== undefined', { timeout: 60000 });
await sleep(1200);
await p.click('#start-btn');
await sleep(3000);

const shot = async (name) => { await p.screenshot({ path: path.join(OUT, name) }); console.log('shot', name); };

// 1. street with Indonesian signage + crowd
await p.evaluate(() => {
  const g = window.__game;
  const door = g.city.shopDoors[0];
  g._test.teleport(door.x + 6, door.z + 14);
  g._test.setCam(0.2, 0.1);
  g._test.setTime(0.45);
});
await sleep(1500);
await shot('01-street.png');

// 2. weapon in hand (uzi) aimed down the street
await p.keyboard.press('Digit4');
await sleep(400);
await p.mouse.down(); await sleep(120); await p.mouse.up();
await sleep(120);
await shot('02-weapon.png');

// 3. driving at speed
await p.evaluate(() => {
  const g = window.__game;
  const c = g.cityCars[0];
  g._test.teleport(c.pos.x + 2.3, c.pos.z + 0.4);
});
await sleep(600);
await p.keyboard.press('f');
await sleep(700);
await p.keyboard.down('w');
await sleep(3200);
await shot('03-driving.png');
await p.keyboard.up('w');
await sleep(400);
await p.keyboard.press('f');
await sleep(500);

// 4. inside a minimarket
await p.evaluate(() => {
  const g = window.__game;
  const d = g.city.shopDoors.find(s => s.kind === 'minimarket') || g.city.shopDoors[0];
  g._test.teleport(d.x, d.z + 0.6);
});
await sleep(700);
await p.keyboard.press('e');
await sleep(1200);
await shot('04-interior.png');
await p.keyboard.press('e');
await sleep(600);

// 5. map screen
await p.keyboard.press('m');
await sleep(900);
await shot('05-map.png');
await p.keyboard.press('Escape');
await sleep(600);

// 6. crowd / npc behaviour: shoot near a group, catch the flee
await p.evaluate(() => {
  const g = window.__game;
  const ped = g.peds.peds.find(x => !x.dead);
  g._test.teleport(ped.pos.x, ped.pos.z + 6);
  g._test.setCam(0, 0.08);
});
await sleep(800);
await p.keyboard.press('Digit3');
await sleep(300);
await p.mouse.click(800, 450);
await sleep(700);
await shot('06-crowd.png');

// 7. night
await p.evaluate(() => window.__game._test.setTime(0.86));
await sleep(1600);
await shot('07-night.png');

const state = await p.evaluate(() => ({
  weapon: window.__game.player.weapon,
  cash: window.__game.player.cash,
  wanted: window.__game.police.wanted,
  calls: window.__game.state.calls,
  fps: window.__game.state.fps,
  peds: window.__game.state.peds,
}));
console.log('STATE', JSON.stringify(state), 'errors', JSON.stringify(errs.slice(0,2)));
await b.close();
