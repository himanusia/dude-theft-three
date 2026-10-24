// Shared harness for every suite under tests/.
//
// A gate that fails without saying why is worse than no gate: one run of run-all.mjs
// reported 12 broken suites and not a single reason, because each suite died on a
// puppeteer TimeoutError before its own reporter ever ran. This module fixes that at
// the only level that cannot be bypassed:
//
//   1. `try`/`catch` around the suite body -- every suite calls suiteStart(name) and
//      ends with `} catch (err) { await crash(SUITE, err); }`, so a crash always prints
//      `FAIL <suite> :: <error>` and a SUMMARY line. Process-level unhandled-rejection
//      and uncaught-exception hooks cover the paths a synchronous catch cannot see.
//   2. `launch()` / `bootGate()` own the browser budget. The game boot gate
//      (`window.__game !== undefined`) gets DTA_BOOT_TIMEOUT_MS (default 180 s) instead
//      of puppeteer's 30 s navigation default, so a loaded machine reads as slow
//      instead of broken. Ordinary action waits keep DTA_ACTION_TIMEOUT_MS (60 s).
//   3. A fixed world seed. Worldgen reads Math.random (directly and through
//      core/utils rand/randInt/pick), so the seed is installed on the document before
//      any bundle script runs: the same seed produces the same city, run to run.
import puppeteer from 'puppeteer-core';

export const CHROME =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

// Fixed by default so a gate run is reproducible; override to explore another city.
export const SEED = Number.parseInt(process.env.DTA_SEED ?? '1337', 10);
// Budget for the game boot: the machine can be at load 200 and still be honest.
export const BOOT_TIMEOUT = Number.parseInt(process.env.DTA_BOOT_TIMEOUT_MS ?? '180000', 10);
// Everything that is not the boot gate keeps a tighter, still generous, budget.
export const ACTION_TIMEOUT = Number.parseInt(process.env.DTA_ACTION_TIMEOUT_MS ?? '60000', 10);

const browsers = new Set();
let currentSuite = 'unknown';
let crashed = false;

// mulberry32, installed before the game bundle runs. Everything the city generator
// draws from Math.random is then a pure function of the seed.
const seedSource = `(() => {
  let s = ${SEED >>> 0};
  Math.random = function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  window.__DTA_SEED = ${SEED};
})();`;

export function suiteStart(name) {
  currentSuite = name;
  console.log(`SUITE ${name} seed=${SEED} boot=${BOOT_TIMEOUT}ms`);
}

/** Launch Chrome with the shared defaults, and make every page seeded and budgeted. */
export async function launch(options = {}) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    ...options,
    args: [
      '--no-sandbox',
      '--enable-unsafe-swiftshader',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      ...(options.args ?? []),
    ],
  });
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (pageOptions) => {
    const page = await newPage(pageOptions);
    // must be installed before goto(): the city is generated at module init
    await page.evaluateOnNewDocument(seedSource);
    page.setDefaultNavigationTimeout(BOOT_TIMEOUT);
    page.setDefaultTimeout(ACTION_TIMEOUT);
    return page;
  };
  browsers.add(browser);
  return browser;
}

/** The game boot gate, on the navigation budget rather than puppeteer's 30 s default. */
export function bootGate(page) {
  return page.waitForFunction('window.__game !== undefined', { timeout: BOOT_TIMEOUT });
}

export async function closeBrowsers() {
  await Promise.all(
    [...browsers].map(async (b) => {
      browsers.delete(b);
      try {
        await Promise.race([b.close(), new Promise((r) => setTimeout(r, 5000))]);
      } catch {
        /* already gone */
      }
    }),
  );
}

/** Print one parseable FAIL line, flush it, drop the browsers, exit non-zero. */
export async function crash(name, err) {
  if (crashed) return;
  crashed = true;
  const line = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.log(`FAIL ${name} :: ${line.split('\n')[0]}`);
  const frames = err instanceof Error ? String(err.stack ?? '').split('\n').slice(1, 7) : [];
  for (const frame of frames) console.log(frame);
  console.log(`SUMMARY ${JSON.stringify({ pass: 0, total: 1, crash: true })}`);
  console.error(`suite ${name} crashed: ${line.split('\n')[0]}`);
  await closeBrowsers();
  process.exitCode = 1;
  // give the piped stdout a tick to flush before the process goes away
  setTimeout(() => process.exit(1), 500);
}

process.on('unhandledRejection', (err) => {
  void crash(currentSuite, err);
});
process.on('uncaughtException', (err) => {
  void crash(currentSuite, err);
});
