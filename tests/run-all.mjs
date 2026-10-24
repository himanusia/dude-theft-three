// One entry point for every suite, grouped by what it protects:
//   gameplay  - the loop a player actually feels (drive, shoot, pause, frame rate)
//   world     - the city itself: geometry, traffic, pedestrians, police routing
//   ui        - interiors, touch controls, layout at every viewport, saved settings
//   visual    - screenshots and audio, run when the look changes
//
// Usage: node tests/run-all.mjs [group...]   (default: gameplay world ui)
//
// Every suite runs against one world seed (DTA_SEED, fixed by default) so a gate run is
// reproducible, and gets DTA_BOOT_TIMEOUT_MS (180 s) to boot the game before it is
// declared broken. A suite that dies before its own reporter still prints
// `FAIL <suite> :: <error>`; this file also names any suite that produced no SUMMARY at
// all, so "failed with no reason" cannot happen again.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { SEED, BOOT_TIMEOUT } from './_harness.mjs';

const GROUPS = {
  gameplay: ['qa', 'playtest', 'weapons-smoke', 'fps'],
  world: ['audit', 'floats', 'drivers', 'drift', 'police-path', 'npc-behavior', 'roadnav', 'overlap', 'placement'],
  ui: ['interior', 'touch', 'responsive', 'persistence'],
  visual: ['proof-shots', 'ragdoll-shots', 'bgm'],
};

const picked = process.argv.slice(2).filter((a) => GROUPS[a]);
const groups = picked.length ? picked : ['gameplay', 'world', 'ui'];

// Preflight. Every suite navigates to the same dev server, and when that server is down -- or
// when `vite build` is rewriting dist/ underneath a run -- every suite reports
// "Navigation timeout of 30000 ms exceeded" and the board looks like fifteen broken features
// instead of one broken prerequisite. Say which it is, and say it once.
const BASE = process.env.DTA_URL || 'http://127.0.0.1:8765';
try {
  const res = await fetch(BASE + '/', { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  // Vite emits <script type="module" crossorigin src="/assets/index-xxxx.js">, so the src
  // attribute is not immediately inside the tag: match the attribute, not the tag prefix
  const asset = html.match(/src="([^"]*\/assets\/[^"]+\.js)"/)?.[1];
  if (!asset) throw new Error('index.html has no built asset reference');
  // the reference may be absolute, root-relative or './assets/...': resolve it properly
  const assetUrl = new URL(asset, BASE + '/').toString();
  const assetRes = await fetch(assetUrl, { signal: AbortSignal.timeout(4000) });
  if (!assetRes.ok) {
    throw new Error(`index.html points at ${assetUrl} but that file is ${assetRes.status} -- a build is probably in progress`);
  }
} catch (err) {
  console.error(`PREFLIGHT FAILED against ${BASE}: ${err.message}`);
  console.error('Start the server (python3 serve.py 8765), and do not run `npm run build` while suites run.');
  process.exit(2);
}

const run = (file) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DTA_SEED: String(SEED) },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const clock = (ms) => `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`;

console.log(`SEED ${SEED} (fixed world seed, override with DTA_SEED)  boot budget ${secs(BOOT_TIMEOUT)}`);

let failed = 0;
let total = 0;
let totalMs = 0;
const rows = [];
for (const group of groups) {
  const dir = `tests/${group}`;
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
  for (const f of files) {
    const name = f.replace('.mjs', '');
    if (!GROUPS[group].includes(name)) continue;      // tests/*-shots are opt-in in their own group
    process.stdout.write(`${group}/${name} ... `);
    // give the previous suite's browser and server a moment to disappear: the frame-rate
    // suite measures against wall clock and a departing Chrome drags it down
    await new Promise((r) => setTimeout(r, 1500));
    const started = Date.now();
    const { code, out } = await run(`${dir}/${f}`);
    const ms = Date.now() - started;
    totalMs += ms;
    const m = out.match(/SUMMARY (\{[^}]*\})/g);
    const last = m ? JSON.parse(m[m.length - 1].slice(8)) : null;
    const pass = last ? last.pass : code === 0 ? 1 : 0;
    const count = last ? last.total : 1;
    total += count;
    if (code !== 0 || (last && last.pass < last.total)) failed++;
    const ok = code === 0 && (!last || last.pass === last.total);
    // when a suite fails, show which assertion failed instead of just the count
    const failedChecks = out
      .split('\n')
      .filter((l) => l.startsWith('FAIL ') && !l.startsWith('FAILED '))
      .map((l) => l.replace(/^FAIL /, '').slice(0, 160));
    // a suite that never reached its reporter gets its own line: the reason is the point
    const tail = out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('SUITE '))
      .slice(-3)
      .join(' | ')
      .slice(0, 300);
    const reason = last ? null : `no SUMMARY (exit ${code}): ${tail}`;
    rows.push({ group, name, pass, count, ok, ms, failedChecks, reason });
    console.log(`${pass}/${count} ${secs(ms)}${code === 0 ? '' : ' (exit ' + code + ')'}`);
  }
}

const w = (s, n) => String(s).padEnd(n);
const nameWidth = Math.max(...rows.map((r) => `${r.group}/${r.name}`.length), 5) + 2;
console.log(`\n${w('suite', nameWidth)}${w('checks', 10)}${w('time', 9)}status`);
console.log('-'.repeat(nameWidth + 10 + 9 + 6));
for (const r of rows) {
  console.log(
    w(`${r.group}/${r.name}`, nameWidth) +
      w(`${r.pass}/${r.count}`, 10) +
      w(secs(r.ms), 9) +
      (r.ok ? 'PASS' : 'FAIL'),
  );
}
console.log('-'.repeat(nameWidth + 10 + 9 + 6));
console.log(
  `${rows.filter((r) => r.ok).length}/${rows.length} suites green, ${total} checks, ` +
    `${clock(totalMs)} total, seed ${SEED}`,
);

for (const r of rows) {
  if (r.ok) continue;
  console.log(`\n  ${r.group}/${r.name}:`);
  if (r.reason) console.log(`    - ${r.reason}`);
  for (const c of r.failedChecks) console.log(`    - ${c}`);
}
process.exit(failed ? 1 : 0);
