// One entry point for every suite, grouped by what it protects:
//   gameplay  - the loop a player actually feels (drive, shoot, pause, frame rate)
//   world     - the city itself: geometry, traffic, pedestrians, police routing
//   ui        - interiors, touch controls, layout at every viewport, saved settings
//   visual    - screenshots and audio, run when the look changes
//
// Usage: node tests/run-all.mjs [group...]   (default: gameplay world ui)
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';

const GROUPS = {
  gameplay: ['qa', 'playtest', 'weapons-smoke', 'fps'],
  world: ['audit', 'floats', 'drivers', 'drift', 'police-path', 'npc-behavior'],
  ui: ['interior', 'touch', 'responsive', 'persistence'],
  visual: ['proof-shots', 'ragdoll-shots', 'bgm'],
};

const picked = process.argv.slice(2).filter((a) => GROUPS[a]);
const groups = picked.length ? picked : ['gameplay', 'world', 'ui'];

const run = (file) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });

let failed = 0;
let total = 0;
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
    const { code, out } = await run(`${dir}/${f}`);
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
      .map((l) => l.replace(/^FAIL /, '').slice(0, 120));
    rows.push({ group, name, pass, count, ok, failedChecks });
    console.log(`${pass}/${count}${code === 0 ? '' : ' (exit ' + code + ')'}`);
  }
}

console.log('\n' + rows.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.group}/${r.name} ${r.pass}/${r.count}`).join('\n'));
for (const r of rows) {
  if (r.ok || !r.failedChecks.length) continue;
  console.log(`\n  ${r.group}/${r.name}:`);
  for (const c of r.failedChecks) console.log(`    - ${c}`);
}
console.log(`\n${rows.filter((r) => r.ok).length}/${rows.length} suites green, ${total} checks`);
process.exit(failed ? 1 : 0);
