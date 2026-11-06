// Does a kaki-lima cart get customers while the player just stands there?
//
// Boots the game headless, stands the player at the spawn (or at the counter with `site`), then
// counts every stop a walker makes at every cart over the requested window. Two ways to spend the
// window: `spawn`/`site` step the real PedManager update at a fixed 60 Hz with a fresh context
// every frame (deterministic game time), `live` leaves the actual render loop running and samples
// it, so the counts come from the shipped frame path with traffic and police moving.
//
// usage: node tools/probe-cart-customers.mjs [seconds] [spawn|site|live]
//   DTA_URL=http://127.0.0.1:<vite port>   (default http://127.0.0.1:9471)
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = process.env.DTA_URL || 'http://127.0.0.1:9471';
const SECONDS = Number(process.argv[2] || 90);
const MODE = process.argv[3] || 'spawn';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  defaultViewport: { width: 1280, height: 800 },
});

/** Where the carts are and where the player is standing, in both modes. */
const stage = () => {
  const g = window.__game;
  const sp = g.city.getSpawn();
  const posts = g.peds.cartPosts;
  const dists = posts.map((p) => +Math.hypot(p.cx - sp.x, p.cz - sp.z).toFixed(2));
  let nearest = 0;
  for (let i = 1; i < dists.length; i++) if (dists[i] < dists[nearest]) nearest = i;
  return { spawn: [sp.x, sp.z], posts: posts.map((p) => ({ i: p.i, cart: p.cart, cx: p.cx, cz: p.cz })), dists, nearest };
};

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction('window.__game !== undefined', { timeout: 120000 });
  await sleep(1500);
  await page.click('#start-btn');
  await sleep(1800);

  const info = await page.evaluate(stage);
  const post = info.posts[info.nearest];
  const at = MODE === 'site' ? post : { cx: info.spawn[0], cz: info.spawn[1] };
  await page.evaluate((x, z) => window.__game._test.teleport(x, z), at.cx, at.cz);

  // the crowd as it stands: how many bodies, how far the nearest walker is from the nearest cart
  const before = await page.evaluate(() => {
    const g = window.__game;
    const posts = g.peds.cartPosts;
    const walkers = g.peds.peds.filter((p) => !p.vendor && !p.dead);
    const nearestPerCart = posts.map((P) => {
      let best = Infinity;
      for (const p of walkers) best = Math.min(best, Math.hypot(p.pos.x - P.cx, p.pos.z - P.cz));
      return +best.toFixed(2);
    });
    return {
      peds: g.peds.peds.length,
      walkers: walkers.length,
      vendors: g.peds.peds.filter((p) => p.vendor).length,
      nearestPerCart,
      cars: g.traffic.cars.length + g.cityCars.length,
    };
  });

  let out;
  if (MODE === 'live') {
    // real loop: sample what the shipped frame path does, no manual stepping
    const t0 = Date.now();
    const stops = info.posts.map(() => 0);
    const stopsAt = info.posts.map(() => []);
    const live = new Set();
    let samples = 0;
    let simLast = 0;
    const sim0 = await page.evaluate(() => window.__game.state.simTime);
    while (Date.now() - t0 < SECONDS * 1000) {
      const snap = await page.evaluate(() => {
        const g = window.__game;
        return {
          shops: g.peds.peds.filter((p) => !p.vendor && !p.dead && p.shopTimer > 0 && p.shopPost >= 0).map((p) => p.id + ':' + p.shopPost),
          t: g.state.simTime,
        };
      });
      simLast = snap.t;
      const now = new Set(snap.shops);
      for (const key of now) {
        if (live.has(key)) continue;
        const i = Number(key.split(':')[1]);
        stops[i] += 1;
        stopsAt[i].push(+(Date.now() - t0) / 1000);
      }
      live.clear();
      for (const key of now) live.add(key);
      samples += 1;
      await sleep(200);
    }
    out = { stops, stopsAt, simSeconds: +(simLast - sim0).toFixed(1), samples };
  } else {
    out = await page.evaluate((seconds) => {
      const g = window.__game;
      const posts = g.peds.cartPosts;
      const walkers = () => g.peds.peds.filter((p) => !p.vendor && !p.dead);
      const dt = 1 / 60;
      const frames = Math.round(seconds / dt);
      const stops = posts.map(() => 0);
      const stopsAt = posts.map(() => []);
      const reachFrames = posts.map(() => 0);
      const prev = new Map();
      const regs = walkers()
        .filter((p) => p.regular >= 0)
        .map((p) => ({ p, travel: 0, stuck: 0, maxD: 0 }));
      for (let f = 0; f < frames; f++) {
        g.peds.update(dt, g._test.pedContext());
        for (const p of walkers()) {
          const was = prev.get(p) || 0;
          if (p.shopTimer > 0 && was <= 0 && p.shopPost >= 0) {
            stops[p.shopPost] += 1;
            stopsAt[p.shopPost].push(+(f * dt).toFixed(1));
          }
          prev.set(p, p.shopTimer);
        }
        for (const r of regs) {
          const P = posts[r.p.regular];
          r.maxD = Math.max(r.maxD, Math.hypot(r.p.pos.x - P.cx, r.p.pos.z - P.cz));
          r.travel += r.p.moved || 0;
          if (r.p.state === 'walk' && r.p.shopTimer <= 0 && (r.p.moved || 0) < 0.004) r.stuck += 1;
        }
        for (let i = 0; i < posts.length; i++) {
          const P = posts[i];
          for (const p of walkers()) if (Math.hypot(p.pos.x - P.cx, p.pos.z - P.cz) <= 3.2) reachFrames[i] += 1;
        }
      }
      return {
        stops,
        stopsAt,
        reachFrames,
        simSeconds: +(frames / 60).toFixed(1),
        regulars: regs.map((r) => ({
          cart: r.p.regular,
          travel: +r.travel.toFixed(1),
          stuckFrames: r.stuck,
          maxD: +r.maxD.toFixed(2),
          nowD: +Math.hypot(r.p.pos.x - posts[r.p.regular].cx, r.p.pos.z - posts[r.p.regular].cz).toFixed(2),
        })),
      };
    }, SECONDS);
  }

  const report = {
    mode: MODE,
    seconds: SECONDS,
    ...out,
    player: await page.evaluate(() => [+window.__game.player.pos.x.toFixed(1), +window.__game.player.pos.z.toFixed(1)]),
    carts: info.posts.length,
    distsFromSpawn: info.dists,
    nearestCart: info.nearest,
    nearestCartStops: out.stops[info.nearest],
    nearestCartStopsAt: out.stopsAt[info.nearest],
    before,
    after: await page.evaluate(() => {
      const g = window.__game;
      const pp = g.player.pos;
      const walkers = g.peds.peds.filter((p) => !p.vendor && !p.dead);
      const near = walkers.filter((p) => p.pos.distanceTo(pp) <= 80);
      return {
        peds: g.peds.peds.length,
        customers: g.peds.stats.customers,
        cars: g.traffic.cars.length + g.cityCars.length,
        walkers: walkers.length,
        regulars: walkers.filter((p) => p.regular >= 0).length,
        walkersWithin80mOfPlayer: near.length,
        nearestWalkerToPlayer: +Math.min(...walkers.map((p) => p.pos.distanceTo(pp))).toFixed(2),
      };
    }),
    errors: errors.slice(0, 5),
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
