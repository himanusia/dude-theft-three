/**
 * Before/after numbers for the TransJakarta / traffic card.
 *
 * usage: node tools/measure-tj.mjs [--out file.json]
 *        DTA_URL=http://127.0.0.1:8765 (a server for this tree: dist/ or vite preview)
 *
 * Prints one JSON blob: bus triangles/draw calls, the coplanar part pairs, the vehicles that
 * cross a 15 m circle around the Thamrin x Gatot Subroto junction per 30 s of simulated play,
 * and whether any TransJakarta bus is actually in service.
 */
import fs from 'node:fs';
import { bootGame, measureBus, measureCrossings, measureService } from './tj-measure.mjs';

const BASE = process.env.DTA_URL || 'http://127.0.0.1:8765';
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : null;

const { browser, page, errors } = await bootGame(BASE);
const report = { url: BASE, at: new Date().toISOString() };

report.bus = await measureBus(page);
report.service = await measureService(page);
report.crossings = await measureCrossings(page, { seconds: 30 });
report.state = await page.evaluate(() => {
  const s = window.__game.state;
  return { tris: s.tris, calls: s.calls, fps: s.fps, carsNear: s.carsNear, simTime: s.simTime };
});
report.pageErrors = errors.slice(0, 5);

console.log(JSON.stringify(report, null, 1));
if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
await browser.close();
