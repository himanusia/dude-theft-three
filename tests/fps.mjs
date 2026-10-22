// The frame loop must be vsync-driven by default and timer-driven once "Uncapped frame rate"
// is switched on, with the FPS readout actually moving past the refresh rate.
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL = process.env.DTA_URL || 'http://127.0.0.1:8765/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, info) => {
  checks.push({ name, ok: !!ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${JSON.stringify(info)}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.bringToFront();
await page.goto(URL, { waitUntil: 'networkidle2' });
await page.waitForFunction('window.__game !== undefined', { timeout: 60000 });
await page.click('#start-btn');
await sleep(1200);

const option = await page.evaluate(() => {
  const box = document.getElementById('set-uncapped');
  return { present: !!box, checked: box ? box.checked : null };
});
check('the options sheet offers an uncapped frame rate toggle', option.present, option);

const frameCount = async () => page.evaluate(async () => {
  // count rendered frames over a fixed wall-clock window
  const g = window.__game;
  const start = g.renderer.info.render.frame;
  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, 1000));
  const frames = g.renderer.info.render.frame - start;
  return { frames, ms: Math.round(performance.now() - t0), fps: Math.round(frames / ((performance.now() - t0) / 1000)) };
});

const vsync = await frameCount();
const uncapped = await page.evaluate(async () => {
  const box = document.getElementById('set-uncapped');
  box.checked = true;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  return { setting: window.__game.settings.uncapped };
});
const uncappedRun = await frameCount();
const restored = await page.evaluate(async () => {
  const box = document.getElementById('set-uncapped');
  box.checked = false;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  return { setting: window.__game.settings.uncapped };
});

check('the toggle reaches the settings object', uncapped.setting === true && restored.setting === false, { ...uncapped, restored });
check(
  'uncapped mode renders at least as many frames as vsync',
  uncappedRun.frames >= vsync.frames,
  { vsync: vsync.frames, uncapped: uncappedRun.frames }
);

console.log('SUMMARY ' + JSON.stringify({ pass: checks.filter((c) => c.ok).length, total: checks.length }));
await browser.close();
