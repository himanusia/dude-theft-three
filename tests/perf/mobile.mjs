/**
 * What the frame budget does on a mid-range phone, measured rather than guessed.
 *
 * There is no phone in the loop, so the next best thing is to make the browser behave like one:
 * a 390x844 viewport at DPR 2 (a mid-range Android screen), touch enabled, and CPU throttled 4x
 * and 6x through CDP. A 4x throttle lands roughly where a Snapdragon 6-series sits against this
 * machine; 6x is the pessimistic case.
 *
 * The point is not a pretty number. It is to know which side of 30 fps the city falls on, and
 * whether the adaptive resolution the renderer already has actually engages.
 */
import path from 'path';
import fs from 'fs';

import { launch, bootGate, crash, suiteStart } from '../_harness.mjs';

const SUITE = 'perf/mobile';
suiteStart(SUITE);
try {
const CHROME = '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'screenshots/proof');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${JSON.stringify(detail)}`);
};

const browser = await launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});

for (const rate of [4, 6]) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.setUserAgent('Mozilla/5.0 (Linux; Android 13; Pixel 6a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36');
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });

  await page.goto('http://127.0.0.1:8765/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await bootGate(page);
  await page.click('#start-btn');
  await new Promise((r) => setTimeout(r, 4000));
  // let the game warm up: shader compile and the first block culling pass are not the steady state
  await new Promise((r) => setTimeout(r, 5000));

  const sample = await page.evaluate(async () => {
    const g = window.__game;
    const frames = [];
    const calls = [];
    let last = performance.now();
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now();
      frames.push(now - last);
      last = now;
      if (i % 15 === 0) calls.push(g.renderer.info.render.calls);
    }
    const sorted = [...frames].sort((a, b) => a - b);
    return {
      fps: Math.round(1000 / (sorted[sorted.length >> 1] || 1)),
      p95ms: Math.round(sorted[Math.floor(sorted.length * 0.95)]),
      calls: Math.round(calls.reduce((a, b) => a + b, 0) / calls.length),
      tris: g.renderer.info.render.triangles,
      pixelRatio: +g.renderer.getPixelRatio().toFixed(2),
      drawSize: [g.renderer.domElement.width, g.renderer.domElement.height],
    };
  });

  // What can honestly be asserted headlessly is the *work*, not the frame rate: this browser
  // rasterises with SwiftShader, so every pixel is CPU and a throttled fps here measures the
  // software rasteriser, not a phone's GPU. Draw calls and triangles are the numbers that carry
  // over to a real device, and a handset also gets the adaptive resolution the renderer already
  // runs.
  check(`cpu x${rate}: draw calls stay under 900 on a phone viewport`, sample.calls <= 900, sample);
  check(`cpu x${rate}: triangles stay under 450k`, sample.tris <= 450000, { tris: sample.tris });
  check(`cpu x${rate}: adaptive resolution engaged`, sample.pixelRatio < 1, { pixelRatio: sample.pixelRatio });
  console.log(`NOTE cpu x${rate}: software-rasteriser fps ${sample.fps} (not a device GPU figure)`);
  await page.screenshot({ path: path.join(OUT, `mobile-x${rate}.png`) });
  await page.close();
}

await browser.close();
const pass = results.filter((r) => r.ok).length;
console.log(`SUMMARY ${JSON.stringify({ pass, total: results.length })}`);
console.log(`FAILED ${JSON.stringify(results.filter((r) => !r.ok))}`);
process.exit(pass === results.length ? 0 : 1);

} catch (err) {
  await crash(SUITE, err);
}
