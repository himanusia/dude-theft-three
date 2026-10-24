// Measures whether the city reacts to gunfire, and whether walkers stop at the food carts.
//
// Starts its own vite dev server (PROBE_PORT, default 9490) so the numbers always come from this
// working tree, drives the real game in headless Chrome, and prints:
//   BOOT       crowd size, where the player stands, how many peds are within earshot
//   GUNFIRE    14 trigger pulls: what the shot event hands the crowd system, flee/witness deltas,
//              wanted level and officers
//   GEO        per cart: how close the pavement lane runs to the cart centre and to the vendor
//   CARTS      45 s of wall-clock street life with the player standing at a warung: customers
//
// Usage: node tools/measure-npc-reaction.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = new URL('..', import.meta.url).pathname;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const PORT = Number(process.env.PROBE_PORT || 9490);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function viteBin() {
  let dir = ROOT;
  for (let i = 0; i < 5; i++) {
    const p = path.join(dir, 'node_modules/vite/bin/vite.js');
    if (fs.existsSync(p)) return p;
    dir = path.dirname(dir);
  }
  throw new Error('vite not found above ' + ROOT);
}

function waitForServer(url, timeoutMs = 40000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      http
        .get(url, (res) => {
          res.resume();
          if (res.statusCode && res.statusCode < 500) resolve(true);
          else retry();
        })
        .on('error', retry);
    };
    const retry = () => (Date.now() - started > timeoutMs ? reject(new Error('vite did not answer on ' + url)) : setTimeout(tick, 200));
    tick();
  });
}

const server = spawn(process.execPath, [viteBin(), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: ROOT,
  stdio: 'ignore',
});
const stop = () => {
  try {
    server.kill('SIGTERM');
  } catch (e) {}
};
process.on('exit', stop);

try {
  await waitForServer(BASE + '/index.html');
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/ERR_CONNECTION_RESET|ERR_SOCKET_NOT_CONNECTED|ERR_ABORTED|net::/.test(m.text())) errs.push('console: ' + m.text());
  });
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction('window.__game !== undefined', { timeout: 120000 });
  await sleep(1200);
  await page.click('#start-btn');
  await sleep(3000);

  // ---------------------------------------------------------------- boot
  const boot = await page.evaluate(() => {
    const g = window.__game;
    const live = g.peds.peds.filter((p) => !p.dead);
    const d = live.map((p) => Math.hypot(p.pos.x - g.player.pos.x, p.pos.z - g.player.pos.z)).sort((a, b) => a - b);
    const states = {};
    for (const p of live) states[p.state] = (states[p.state] || 0) + 1;
    return {
      peds: g.peds.peds.length,
      player: [+g.player.pos.x.toFixed(1), +g.player.pos.z.toFixed(1)],
      nearestPed: +d[0]?.toFixed(2),
      tenthPed: +d[Math.min(9, d.length - 1)]?.toFixed(2),
      within18: live.filter((p) => Math.hypot(p.pos.x - g.player.pos.x, p.pos.z - g.player.pos.z) <= 18).length,
      cartPosts: g.peds.cartPosts.length,
      vendors: live.filter((p) => p.vendor).length,
      states,
    };
  });
  console.log('BOOT ' + JSON.stringify(boot));

  // the radii the street reacts with, printed before any number is measured
  const radii = await page.evaluate(() => window.__game.peds.radii);
  console.log('RADII ' + JSON.stringify(radii));

  // ---------------------------------------------------------------- gunfire at the spawn
  const shots = await page.evaluate(async () => {
    const g = window.__game;
    const calls = [];
    const orig = g.peds.onGunshot;
    g.peds.onGunshot = function (x, z, sawVictim) {
      calls.push({ x: +x.toFixed(2), z: +z.toFixed(2), sawVictim: !!sawVictim });
      return orig.call(this, x, z, sawVictim);
    };
    g.police.clearWanted();
    g._test.cinematic(false);
    const before = { ...g.peds.stats };
    const wantedBefore = g.police.wanted;
    const kinds = [];
    for (let i = 0; i < 14; i++) {
      g.player.mag = g.player.magSize;
      g.player.shootCd = 0;
      g.player.reloading = 0;
      g._test.shoot();
      kinds.push(window.__lastShot?.hitKind ?? null);
      await new Promise((r) => setTimeout(r, 120));
    }
    await new Promise((r) => setTimeout(r, 800));
    const live = g.peds.peds.filter((p) => !p.dead);
    const states = {};
    for (const p of live) states[p.state] = (states[p.state] || 0) + 1;
    g.peds.onGunshot = orig;
    const after = { ...g.peds.stats };
    const base = (k) => after[k] - (before[k] || 0);
    const d = live.map((p) => Math.hypot(p.pos.x - g.player.pos.x, p.pos.z - g.player.pos.z)).sort((a, b) => a - b);
    return {
      calls: calls.length,
      callArgs: calls.slice(0, 2),
      hitKinds: [...new Set(kinds)],
      delta: {
        fleeEvents: base('fleeEvents'),
        fleeSpreads: base('fleeSpreads'),
        witnessEvents: base('witnessEvents'),
        witnessWanted: base('witnessWanted'),
        cowerEvents: base('cowerEvents'),
      },
      wantedBefore: +wantedBefore.toFixed(2),
      wanted: +g.police.wanted.toFixed(2),
      officers: g.police.cars.length,
      states,
      nearestPed: +d[0]?.toFixed(2),
      within18: live.filter((p) => Math.hypot(p.pos.x - g.player.pos.x, p.pos.z - g.player.pos.z) <= 18).length,
    };
  });
  console.log('GUNFIRE ' + JSON.stringify(shots));

  // ---------------------------------------------------------------- cart geometry
  const geo = await page.evaluate(() => {
    const g = window.__game;
    const out = [];
    for (const post of g.peds.cartPosts) {
      let usable = 0;
      let minCentre = Infinity;
      let minVendor = Infinity;
      for (const L of g.peds.legs) {
        for (let t = 0; t <= L.len; t += 0.5) {
          const x = L.ax + L.ux * t;
          const z = L.az + L.uz * t;
          const dC = Math.hypot(x - post.cx, z - post.cz);
          if (dC > 3.2) continue;
          const dV = Math.hypot(x - post.x, z - post.z);
          minCentre = Math.min(minCentre, dC);
          minVendor = Math.min(minVendor, dV);
          if (dV > 1.1) usable++;
        }
      }
      out.push({ cart: post.cart, i: post.i, laneMinCentre: +minCentre.toFixed(2), laneMinVendor: +minVendor.toFixed(2), usableSamples: usable });
    }
    return out;
  });
  console.log('GEO ' + JSON.stringify(geo));

  // ---------------------------------------------------------------- carts, wall clock
  const target = await page.evaluate(() => {
    const g = window.__game;
    g.police.clearWanted();
    const post = g.peds.cartPosts[0];
    g._test.teleport(post.cx + 3, post.cz + 7);
    // sample the whole window, not just its last frame: how close did walkers actually get?
    window.__watch = { closest: Infinity, byCart: {}, customers: {} };
    window.__custBefore = g.peds.stats.customers;
    window.__watchTimer = setInterval(() => {
      for (const p of g.peds.peds) {
        if (p.dead || p.vendor) continue;
        for (const cart of g.peds.cartPosts) {
          const d = Math.hypot(p.pos.x - cart.cx, p.pos.z - cart.cz);
          if (d < (window.__watch.byCart[cart.i] ?? Infinity)) window.__watch.byCart[cart.i] = +d.toFixed(2);
          if (cart.i === 0 && d < window.__watch.closest) window.__watch.closest = +d.toFixed(2);
        }
      }
    }, 200);
    return { cx: +post.cx.toFixed(1), cz: +post.cz.toFixed(1) };
  });
  await sleep(45000);
  const carts = await page.evaluate(() => {
    const g = window.__game;
    clearInterval(window.__watchTimer);
    const post = g.peds.cartPosts[0];
    const live = g.peds.peds.filter((p) => !p.dead && !p.vendor);
    return {
      customers: g.peds.stats.customers - window.__custBefore,
      walkersWithin25: live.filter((p) => Math.hypot(p.pos.x - post.cx, p.pos.z - post.cz) < 25).length,
      closestWalker: window.__watch.closest,
      closestByCart: window.__watch.byCart,
      shoppersNow: g.peds.shoppers(),
    };
  });
  console.log('CARTS ' + JSON.stringify({ at: target, ...carts }));
  console.log('ERRORS ' + JSON.stringify(errs.slice(0, 5)));
  await browser.close();
} finally {
  stop();
}
