
import { launch, bootGate, crash, suiteStart } from '../_harness.mjs';

const SUITE = 'visual/bgm';
suiteStart(SUITE);
try {
// The chase cue has to be the tense track, servable, and it must tighten as the heat rises.

const CHROME = '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL = process.env.DTA_URL || 'http://127.0.0.1:8765/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, info) => {
  checks.push({ name, ok: !!ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${JSON.stringify(info)}`);
};

const browser = await launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.bringToFront();
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await bootGate(page);
await page.click('#start-btn');
await sleep(900);

// the file itself: served, long enough for a chase, and not the old comedy cue
const meta = await page.evaluate(async () => {
  const res = await fetch('audio/bgm/chase.mp3', { method: 'HEAD' });
  return { status: res.status, length: Number(res.headers.get('content-length') || 0), type: res.headers.get('content-type') };
});
check('chase track is served', meta.status === 200 && meta.length > 3_000_000, meta);

const cue = await page.evaluate(async () => {
  const g = window.__game;
  const el = g.audio.bgmEls?.chase;
  if (!el) return null;
  if (!Number.isFinite(el.duration)) {
    await new Promise((r) => {
      el.addEventListener('loadedmetadata', r, { once: true });
      setTimeout(r, 4000);
    });
  }
  return { duration: Math.round(el.duration), src: el.currentSrc.split('/').pop() };
});
check('chase cue is a long-form track, not a sting', cue && cue.duration > 150, cue);

const intensity = await page.evaluate(async () => {
  const g = window.__game;
  g.police.wanted = 5;
  await new Promise((r) => setTimeout(r, 1400));
  const el = g.audio.bgmEls.chase;
  return { mode: g.audio.bgmMode, rate: +Number(el.playbackRate).toFixed(3), played: !el.paused };
});
check('five stars switches to the chase cue', intensity.mode === 'chase', intensity);
check('the chase cue tightens with the heat', intensity.rate > 1.03, intensity);

const calm = await page.evaluate(async () => {
  const g = window.__game;
  g.police.wanted = 0;
  await new Promise((r) => setTimeout(r, 1400));
  const el = g.audio.bgmEls.funk;
  return { mode: g.audio.bgmMode, funkPlaying: !el.paused || el.volume > 0 };
});
check('clearing the heat returns to the cruising track', calm.mode === 'funk', calm);

console.log('SUMMARY ' + JSON.stringify({ pass: checks.filter((c) => c.ok).length, total: checks.length }));
await browser.close();

} catch (err) {
  await crash(SUITE, err);
}
