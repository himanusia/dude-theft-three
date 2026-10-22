// Renders a ragdoll mid-fall and after it settles, on the road the player stands on, so limb
// thickness and the fold of the body can be checked by eye instead of trusted.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL = process.env.DTA_URL || 'http://127.0.0.1:8765/';
fs.mkdirSync('screenshots/proof', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,720'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.bringToFront();
await page.goto(URL, { waitUntil: 'networkidle2' });
await page.waitForFunction('window.__game !== undefined', { timeout: 60000 });
await page.click('#start-btn');
await new Promise(r => setTimeout(r, 600));
await page.evaluate(() => window.__game._test.cinematic(true));

// drop the body a few metres in front of wherever the player spawned (always open street)
const spawn = await page.evaluate(() => {
  const g = window.__game;
  const px = g.player.pos.x;
  const pz = g.player.pos.z;
  g._test.ragdollAt(px + 0.4, 1.5, pz - 3.4, -1.0, -2.6);
  return { px: +px.toFixed(2), pz: +pz.toFixed(2) };
});

async function shot(name, wait, eye, back) {
  await new Promise(r => setTimeout(r, wait));
  await page.evaluate((h, b, sp) => {
    window.__game._test.lookFrom(sp.px + 0.7, h, sp.pz - 0.4 + b, sp.px + 0.4, 0.3, sp.pz - 3.4);
  }, eye, back, spawn);
  await new Promise(r => setTimeout(r, 150));
  await page.screenshot({ path: `screenshots/proof/${name}.png` });
  return page.evaluate(() => {
    const g = window.__game;
    const r = g.ragdolls[g.ragdolls.length - 1];
    if (!r) return null;
    const P = r.points;
    const d = (a, b) => +Math.hypot(P[a].p.x - P[b].p.x, P[a].p.y - P[b].p.y, P[a].p.z - P[b].p.z).toFixed(2);
    const grounded = Object.values(P).filter(p => p.p.y <= p.r + 0.04).length;
    return {
      n: Object.keys(P).length,
      headY: +P.head.p.y.toFixed(2),
      grounded,
      headToFoot: d('head', 'footL'),
      hands: d('handL', 'handR'),
      pts: Object.fromEntries(['head', 'chest', 'hips', 'kneeL', 'footL'].map(k => [k, [P[k].p.x, P[k].p.y, P[k].p.z].map(v => +v.toFixed(2))])),
      seg: { torso: d('hips', 'chest'), thigh: d('hips', 'kneeL'), shin: d('kneeL', 'footL') },
      sunk: (() => {
        // lowest point of every limb mesh versus the road: negative means it dug in
        const b = new g.THREE.Box3();
        let worst = 0;
        r.group.traverse((o) => {
          if (!o.isMesh) return;
          b.setFromObject(o);
          worst = Math.min(worst, b.min.y);
        });
        return +worst.toFixed(3);
      })(),
    };
  });
}

const air = await shot('rag-01-air', 180, 2.3, -1.6);
const settled = await shot('rag-02-settled', 2000, 1.9, 0);
const close = await shot('rag-03-closeup', 250, 1.1, 1.4);

console.log(JSON.stringify({ spawn, air, settled, close }));
await browser.close();
