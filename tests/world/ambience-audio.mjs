// The nine licensed ambience assets the sourcing card landed were shipped but never played.
// This probe proves each one is served, decoded/opened by the mixer, and actually started by the
// game — read off the live audio graph and the director's own state, never off a JS flag the game
// could set without a sound.
//
// What it checks:
//  - all nine files answer 200 and the total bytes served, both by HEAD and on the wire;
//  - the menu cue (gamelan) plays from the title screen on the first gesture and stops for funk;
//  - the four beds crossfade with position: city crowd on an arterial, pasar inside a market
//    block, warung at a kaki lima cart, rain while the weather is raining;
//  - the four one-shots fire from geometry: a traffic car coming close honks, a moped pulling past
//    rings its horn and plays its pass-by, and a becak rings its bell when walked up to;
//  - every asset reports loaded:true and a play event inside 60 s of the run starting;
//  - one-shots are one-shots (never looped), the mute silences the whole street layer, and no
//    page error was raised.
//
// Run: node tests/world/ambience-audio.mjs        (starts its own vite on a free port)
//      DTA_URL=http://localhost:PORT node tests/world/ambience-audio.mjs   (use a server you own)
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const ROOT = new URL('../../', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}

const NINE = [
  'angkot_horn',
  'moped_horn',
  'moped_passby',
  'pedal_bell',
  'city_crowd',
  'pasar_market',
  'warung',
  'tropical_rain',
  'gamelan',
];
const FILES = {
  angkot_horn: 'audio/ambience/angkot-horn.ogg',
  moped_horn: 'audio/ambience/moped-horn.ogg',
  moped_passby: 'audio/ambience/moped-passby.ogg',
  pedal_bell: 'audio/ambience/pedal-bell.ogg',
  city_crowd: 'audio/ambience/city-crowd-ambience.ogg',
  pasar_market: 'audio/ambience/pasar-market-ambience.ogg',
  warung: 'audio/ambience/warung-ambience.ogg',
  tropical_rain: 'audio/ambience/tropical-rain.ogg',
  gamelan: 'audio/ambience/gamelan-menu-loop.ogg',
};

async function freePort() {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let server = null;
let base = process.env.DTA_URL;
if (!base) {
  const port = await freePort();
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(base + '/index.html');
      if (r.ok) break;
    } catch (e) {}
    await sleep(250);
  }
  console.log('SERVER ' + base);
}
base = base.replace(/\/$/, '');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errs.push('console: ' + m.text());
});

// wire accounting: every byte the page pulled from audio/ambience/, including media range reads
const client = await page.createCDPSession();
await client.send('Network.enable');
const reqUrl = new Map();
let wireBytes = 0;
client.on('Network.requestWillBeSent', (e) => reqUrl.set(e.requestId, e.request.url));
client.on('Network.dataReceived', (e) => {
  const url = reqUrl.get(e.requestId) || '';
  if (url.includes('/audio/ambience/')) wireBytes += e.dataLength;
});

const state = () => page.evaluate(() => window.__game._test.ambienceState());
const audioState = () => page.evaluate(() => window.__game.audio.ambienceState());

await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction('window.__game !== undefined', { timeout: 120000 });
await sleep(600);

// ---------------------------------------------------------------- menu cue
const menuAt = await page.evaluate(() => performance.now());
await page.mouse.click(8, 8);
await page.waitForFunction('window.__game.audio.ready === true', { timeout: 60000 });
await sleep(2200);
const menu = await audioState();
const menuGamelan = menu.assets.gamelan;
check(
  'the gamelan menu loop opens on the title screen and is playing',
  menuGamelan.loaded === true && menuGamelan.plays >= 1 && menuGamelan.playing === true && menuGamelan.volume > 0,
  menuGamelan
);
check('the menu loop is a loop, not a sting', menuGamelan.loop === true && menuGamelan.kind === 'menu-loop', {
  loop: menuGamelan.loop,
  kind: menuGamelan.kind,
});

// ---------------------------------------------------------------- start the run
const t0 = await page.evaluate(() => performance.now());
await page.click('#start-btn');
await page.waitForFunction('window.__game.state.started === true', { timeout: 120000 });
await page.waitForFunction('window.__game.audio.ready === true', { timeout: 60000 });
await sleep(900);
const afterStart = await audioState();
check(
  'starting a run hands the menu over to the free-roam track',
  afterStart.assets.gamelan.plays === 1 && afterStart.assets.gamelan.volume < menuGamelan.volume,
  { plays: afterStart.assets.gamelan.plays, volume: afterStart.assets.gamelan.volume, was: menuGamelan.volume }
);

/** teleport and wait for a state predicate; returns the last state */
async function tour(x, z, pred, timeoutMs = 22000) {
  await page.evaluate((x, z) => window.__game._test.teleport(x, z), x, z);
  const began = Date.now();
  let last = await state();
  while (Date.now() - began < timeoutMs) {
    last = await state();
    if (pred(last)) break;
    await sleep(180);
  }
  return last;
}

// ---------------------------------------------------------------- the four beds
const arterial = await page.evaluate(() => {
  const g = window.__game;
  const p = g.jakartaMap.ARTERIALS[0].path;
  const [x, z] = p[Math.floor(p.length / 2)];
  return { name: g.jakartaMap.ARTERIALS[0].name, x, z };
});
const cityState = await tour(arterial.x, arterial.z, (s) => s.assets.city_crowd.plays >= 1);
check(
  'city crowd crosses in on an arterial and is audible',
  cityState.assets.city_crowd.plays >= 1 && cityState.assets.city_crowd.playing === true && cityState.scene.mix.city_crowd > 0.4,
  { road: arterial.name, mix: cityState.scene.mix, bed: cityState.assets.city_crowd }
);

const pasarPoi = await page.evaluate(() => {
  const p = window.__game.jakartaMap.POIS.find((poi) => poi.kind === 'pasar');
  return { name: p.name, x: p.x, z: p.z };
});
const pasarState = await tour(pasarPoi.x, pasarPoi.z, (s) => s.assets.pasar_market.plays >= 1);
check(
  'the market bed crosses in at a pasar and takes over from the crowd',
  pasarState.assets.pasar_market.plays >= 1 && pasarState.scene.mix.pasar_market > 0.4 && pasarState.scene.mix.pasar_market > pasarState.scene.mix.city_crowd,
  { pasar: pasarPoi.name, mix: pasarState.scene.mix, bed: pasarState.assets.pasar_market }
);

const cart = await page.evaluate(() => {
  const c = window.__game.city.cartSpots[0];
  return { x: c.x, z: c.z, kind: c.kind, count: window.__game.city.cartSpots.length };
});
const warungState = await tour(cart.x + 1.6, cart.z, (s) => s.assets.warung.plays >= 1);
check(
  'the warung bed crosses in at a kaki lima cart',
  warungState.assets.warung.plays >= 1 && warungState.scene.mix.warung > 0.4,
  { cart, mix: warungState.scene.mix, bed: warungState.assets.warung }
);

// the pedal bell belongs to the pedal vehicles: walk up to a becak
const becak = await page.evaluate(() => {
  const b = window.__game.city.dressingSpots.find((s) => s.type === 'becak');
  return { x: b.x, z: b.z };
});
const becakState = await tour(becak.x + 1.8, becak.z + 1.8, (s) => s.assets.pedal_bell.plays >= 1, 12000);
check(
  'walking up to a becak rings the pedal bell',
  becakState.assets.pedal_bell.plays >= 1,
  { becak, bell: becakState.assets.pedal_bell, lastEvent: becakState.scene.lastEvent }
);

// a traffic car that comes close honks
const car = await page.evaluate(() => {
  const g = window.__game;
  const cars = g.traffic.cars.map((e) => e.car).filter((c) => !c.wrecked);
  cars.sort((a, b) => a.pos.distanceTo(g.player.pos) - b.pos.distanceTo(g.player.pos));
  const c = cars[0];
  return { type: c.type, x: c.pos.x, z: c.pos.z };
});
const hornState = await tour(car.x + 3.2, car.z + 1.2, (s) => s.assets.angkot_horn.plays >= 1, 12000);
check(
  'a traffic car coming close honks',
  hornState.assets.angkot_horn.plays >= 1,
  { car, horn: hornState.assets.angkot_horn, lastEvent: hornState.scene.lastEvent }
);

// mopeds ride the nearest arterial: the pass-by and the squeaker horn come from geometry
const mopedRoad = await page.evaluate(() => {
  const g = window.__game;
  const p = g.jakartaMap.ARTERIALS[2].path; // Casablanca: a wide, straight run
  const [x, z] = p[1];
  return { name: g.jakartaMap.ARTERIALS[2].name, x, z };
});
const mopedState = await tour(
  mopedRoad.x,
  mopedRoad.z,
  (s) => s.assets.moped_passby.plays >= 1 && s.assets.moped_horn.plays >= 1,
  30000
);
check(
  'a moped pulling past plays the pass-by and rings its horn',
  mopedState.assets.moped_passby.plays >= 1 && mopedState.assets.moped_horn.plays >= 1,
  { road: mopedRoad.name, passby: mopedState.assets.moped_passby, horn: mopedState.assets.moped_horn, mopeds: mopedState.scene.mopeds }
);

// rain: the weather cycle owns the bed, so it can only be heard while it is raining. The bed
// fades in over 3.5 s, so wait for the downpour itself (rain01 past 0.6) instead of the frame the
// state flipped — otherwise the probe reads the fade's first frame and calls a working bed silent.
const rainBefore = await state();
const rainState = await tour(
  mopedRoad.x,
  mopedRoad.z,
  (s) => s.scene.weather.state === 'rain' && s.scene.weather.rain01 > 0.6 && s.assets.tropical_rain.plays >= 1,
  45000
);
// and the same bed must fall silent on a clear sky; forcing it is the only deterministic way to
// see both halves of the contract inside one run. The fade-out is polled, not slept through: the
// scene runs at a few frames a second under swiftshader, so a fixed sleep can read mid-fade.
await page.evaluate(() => window.__game._test.setWeather('clear'));
let dryState = await state();
for (let i = 0; i < 40 && dryState.scene.weather.rain01 >= 0.02; i++) {
  await sleep(500);
  dryState = await state();
}
await page.evaluate(() => window.__game._test.setWeather(null));
check(
  'rain only plays while the weather is raining',
  rainState.assets.tropical_rain.plays >= 1 &&
    rainState.scene.weather.state === 'rain' &&
    rainState.scene.rain.visible === true &&
    rainState.scene.mix.tropical_rain > 0.5 &&
    dryState.scene.weather.state === 'clear' &&
    dryState.scene.weather.rain01 < 0.02 &&
    dryState.scene.rain.visible === false &&
    dryState.scene.mix.tropical_rain < 0.05,
  {
    before: rainBefore.scene.weather,
    wet: { weather: rainState.scene.weather, rainField: rainState.scene.rain, mix: rainState.scene.mix.tropical_rain, bed: rainState.assets.tropical_rain },
    dry: { weather: dryState.scene.weather, rainField: dryState.scene.rain, mix: dryState.scene.mix.tropical_rain, bed: dryState.assets.tropical_rain },
  }
);

// leaving the street crossfades the crowd back down instead of hard-cutting. The spawn is not a
// safe fixture for this: it can sit on an arterial, so search the map for the point that is
// furthest from every named road and walk the player there.
const quiet = await page.evaluate(() => {
  const g = window.__game;
  const roads = (g.city.roads ?? []).filter((r) => !String(r.name).startsWith('Local Street'));
  const roadDistance = (x, z) => {
    let best = Infinity;
    for (const road of roads) {
      const path = road.path;
      for (let i = 0; i < path.length - 1; i++) {
        const [x1, z1] = path[i];
        const [x2, z2] = path[i + 1];
        const vx = x2 - x1;
        const vz = z2 - z1;
        const len2 = vx * vx + vz * vz || 1;
        const t = Math.max(0, Math.min(1, ((x - x1) * vx + (z - z1) * vz) / len2));
        const d = Math.hypot(x - (x1 + vx * t), z - (z1 + vz * t));
        if (d < best) best = d;
      }
    }
    return best;
  };
  let best = { d: -1, x: 0, z: 0 };
  for (let x = -600; x <= 600; x += 20) {
    for (let z = -600; z <= 600; z += 20) {
      const d = roadDistance(x, z);
      if (d > best.d) best = { d, x, z };
    }
  }
  g._test.teleport(best.x, best.z);
  return { x: best.x, z: best.z, roadDistance: +best.d.toFixed(1) };
});
await sleep(2600);
const quietState = await state();
check(
  'the street beds follow the player: leaving the road drops the crowd layer',
  quiet.roadDistance > 58 &&
    cityState.scene.mix.city_crowd > 0.9 &&
    quietState.scene.mix.city_crowd < 0.1,
  { onRoad: cityState.scene.mix.city_crowd, away: quietState.scene.mix.city_crowd, at: quiet }
);

// ---------------------------------------------------------------- assets, bytes, mute
const head = await page.evaluate(async (files) => {
  const out = {};
  for (const [name, url] of Object.entries(files)) {
    const res = await fetch(url, { method: 'HEAD' });
    out[name] = { status: res.status, bytes: Number(res.headers.get('content-length') || 0) };
  }
  return out;
}, FILES);
const served = NINE.filter((n) => head[n].status === 200 && head[n].bytes > 0);
check('all nine ambience assets are served', served.length === 9, head);
const totalBytes = NINE.reduce((sum, n) => sum + head[n].bytes, 0);
check('total audio bytes served', totalBytes === 8937322 && wireBytes > 0, {
  headBytes: totalBytes,
  wireBytes,
  files: NINE.length,
});

const final = await state();
const missing = NINE.filter((n) => final.assets[n].loaded !== true);
check('every one of the nine assets reports loaded:true', missing.length === 0, {
  missing,
  assets: Object.fromEntries(NINE.map((n) => [n, { loaded: final.assets[n].loaded, plays: final.assets[n].plays }])),
});

const late = NINE.filter((n) => {
  const a = final.assets[n];
  const from = n === 'gamelan' ? menuAt : t0;
  const secs = a.firstAt ? (a.firstAt - from) / 1000 : null;
  return !(a.plays >= 1 && secs !== null && secs >= 0 && secs <= 60);
});
check('every asset has a play event within 60 s', late.length === 0, {
  late,
  seconds: Object.fromEntries(NINE.map((n) => [n, final.assets[n].firstAt ? +((final.assets[n].firstAt - (n === 'gamelan' ? menuAt : t0)) / 1000).toFixed(1) : null])),
});

const loops = Object.fromEntries(NINE.map((n) => [n, final.assets[n].loop]));
check(
  'one-shots are never looped (beds and the menu cue are)',
  final.assets.angkot_horn.loop === false &&
    final.assets.moped_horn.loop === false &&
    final.assets.moped_passby.loop === false &&
    final.assets.pedal_bell.loop === false &&
    final.assets.city_crowd.loop === true &&
    final.assets.pasar_market.loop === true &&
    final.assets.warung.loop === true &&
    final.assets.tropical_rain.loop === true &&
    final.assets.gamelan.loop === true,
  loops
);

const muteProbe = await page.evaluate(() => {
  const g = window.__game;
  const beforePlays = g.audio.ambienceState().assets.pedal_bell.plays;
  const muted = g.audio.toggleMute();
  const silent = g.audio.ambienceState();
  g.audio.play('pedal_bell', { vol: 0.4 });
  const during = g.audio.ambienceState().assets.pedal_bell.plays;
  g.audio.toggleMute();
  const back = g.audio.ambienceState();
  return { muted, beforePlays, during, ambienceGain: silent.ambienceGain, restored: back.ambienceGain, sfxVol: back.volumes.sfx };
});
check(
  'the mute silences the street bus and no one-shot can start while muted',
  muteProbe.muted === true && muteProbe.ambienceGain === 0 && muteProbe.during === muteProbe.beforePlays && muteProbe.restored > 0,
  muteProbe
);

check('no page errors', errs.length === 0, errs.slice(0, 4));

const failed = results.filter((r) => !r.ok);
console.log('SUMMARY ' + JSON.stringify({ pass: results.length - failed.length, total: results.length, bytes: totalBytes, wireBytes }));
if (server) server.kill('SIGTERM');
await browser.close();
if (failed.length) {
  console.error(`ambience-audio: ${failed.length}/${results.length} checks failed`);
  process.exit(1);
}
