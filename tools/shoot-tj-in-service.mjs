/**
 * proof/tj-in-service.png — a TransJakarta bus running the corridor past the player, at the
 * Thamrin x Gatot Subroto junction, with the traffic that is supposed to be there around it.
 *
 * The frame is verified without a vision model: the same camera is rendered twice, once with the
 * buses visible and once with them collapsed, and the changed pixels prove the bus is actually in
 * the shot (and how much of it). The red share of the frame is reported as a second, independent
 * read that a grey-street frame cannot pass.
 *
 *   DTA_URL=http://127.0.0.1:8765 node tools/shoot-tj-in-service.mjs
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { bootGame, junctionOf } from './tj-measure.mjs';

const OUT = 'screenshots/proof/tj-in-service.png';
const BASE = process.env.DTA_URL || 'http://127.0.0.1:8765';
fs.mkdirSync('screenshots/proof', { recursive: true });

const { browser, page, errors } = await bootGame(BASE, { width: 1400, height: 900 });
const junction = await junctionOf(page);

// stand on the pavement right beside the busway at the junction, looking down the corridor
const staged = await page.evaluate(
  ({ jx, jz }) => {
    const g = window.__game;
    const near = g.tj.nearest(jx, jz);
    // the point on the loop closest to the junction, then walk to the first non-road spot beside it
    let stand = null;
    for (let ring = 0; ring < 10 && !stand; ring++) {
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const x = jx + Math.cos(a) * (2.5 + ring * 1.5);
        const z = jz + Math.sin(a) * (2.5 + ring * 1.5);
        if (g.city.onAnyRoad(x, z, 0.4)) continue;
        const solid = g.city.colliders.some((c) => x > c.minX - 0.6 && x < c.maxX + 0.6 && z > c.minZ - 0.6 && z < c.maxZ + 0.6);
        if (solid) continue;
        if (g.tj.nearest(x, z).distance > 7) continue;
        stand = { x, z };
        break;
      }
    }
    if (!stand) stand = { x: jx + 6, z: jz + 6 };
    g._test.teleport(stand.x, stand.z);
    // put bus 0 twenty metres short of the stand and look along the corridor it comes down
    const busAlong = g.tj.nearest(stand.x, stand.z).along - 20;
    g.tj.warp(0, busAlong);
    const ahead = g.tj.buses[0].group.position;
    g._test.face(ahead.x, ahead.z);
    const camYaw = Math.atan2(-(ahead.x - stand.x), -(ahead.z - stand.z));
    g._test.setCam(camYaw, 0.05);
    return { stand: { x: +stand.x.toFixed(1), z: +stand.z.toFixed(1) }, along: +near.along.toFixed(1), loop: +g.tj.total.toFixed(1) };
  },
  { jx: junction.x, jz: junction.z }
);

// let the bus drive up to the junction (and the traffic settle) before the shutter
const arrived = await page.evaluate(
  ({ sx, sz }) =>
    new Promise((resolve) => {
      const g = window.__game;
      const t0 = performance.now();
      const tick = () => {
        const bus = g.tj.buses[0].group.position;
        const d = Math.hypot(bus.x - sx, bus.z - sz);
        if (d < 7.5 || performance.now() - t0 > 40000) {
          // keep the camera on it: it is closing on the stand at 9 m/s
          g._test.face(bus.x, bus.z);
          g._test.setCam(Math.atan2(-(bus.x - sx), -(bus.z - sz)), 0.05);
          resolve({ busToStand: +d.toFixed(1), sim: +g.state.simTime.toFixed(1), fps: g.state.fps });
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    }),
  { sx: staged.stand.x, sz: staged.stand.z }
);

// the frame check: render twice, with and without the buses, and keep the frame in which the
// livery actually reads red (a bus in the sun's shadow is still proof of presence, but not of a
// red TransJakarta bus, so the tool picks the light instead of trusting the first frame)
const frameAt = (time) =>
  page.evaluate((t) => {
    const g = window.__game;
    const gl = g.renderer.domElement;
    const c2 = document.createElement('canvas');
    c2.width = gl.width;
    c2.height = gl.height;
    const ctx = c2.getContext('2d', { willReadFrequently: true });
    const grab = () => {
      g.renderer.render(g.scene, g.camera);
      ctx.drawImage(gl, 0, 0, c2.width, c2.height);
      return ctx.getImageData(0, 0, c2.width, c2.height).data;
    };
    const withBuses = grab();
    const saved = g.tj.buses.map((b) => b.group.scale.x);
    for (const b of g.tj.buses) b.group.scale.setScalar(0.0001);
    const without = grab();
    g.tj.buses.forEach((b, i) => b.group.scale.setScalar(saved[i]));
    g.renderer.render(g.scene, g.camera);

    let changed = 0;
    let red = 0;
    const total = c2.width * c2.height;
    for (let i = 0; i < withBuses.length; i += 4) {
      const r = withBuses[i];
      const gg = withBuses[i + 1];
      const bb = withBuses[i + 2];
      if (r > 95 && r - gg > 55 && r - bb > 45) red++;
      const d = Math.abs(r - without[i]) + Math.abs(gg - without[i + 1]) + Math.abs(bb - without[i + 2]);
      if (d > 36) changed++;
    }
    return {
      time: t,
      pixels: total,
      busPixels: changed,
      busShare: +((changed / total) * 100).toFixed(2),
      redPixels: red,
      redShare: +((red / total) * 100).toFixed(2),
      size: [c2.width, c2.height],
    };
  }, time);

const frames = [];
// where the bus was when the shutter condition was met: every candidate frame is shot from that
// exact pose, so the only thing that changes between them is the light
const pose = await page.evaluate(() => {
  const g = window.__game;
  const b = g.tj.buses[0].group.position;
  const p = { x: b.x, z: b.z, along: g.tj.nearest(b.x, b.z).along };
  // hold the fleet still for the photograph: the motion itself is measured by tests/world/tj.mjs
  g.tj.update = () => {};
  return p;
});
for (const t of [0.28, 0.34, 0.42, 0.5, 0.62]) {
  // the lights follow dayT in the game loop, so the frame is only lit for `t` after a beat
  await page.evaluate(
    ({ time, along, sx, sz, px, pz }) => {
      const g = window.__game;
      g._test.setTime(time);
      g.tj.warp(0, along);
      g._test.face(px, pz);
      g._test.setCam(Math.atan2(-(px - sx), -(pz - sz)), 0.05);
    },
    { time: t, along: pose.along, sx: staged.stand.x, sz: staged.stand.z, px: pose.x, pz: pose.z }
  );
  await new Promise((r) => setTimeout(r, 450));
  frames.push(await frameAt(t));
}
const vision = frames.reduce((best, f) => (f.redShare > best.redShare ? f : best), frames[0]);
await page.evaluate((t) => window.__game._test.setTime(t), vision.time);
await new Promise((r) => setTimeout(r, 400));

await page.screenshot({ path: OUT });
console.log(JSON.stringify({ junction, staged, arrived, frames, vision, pageErrors: errors.slice(0, 4) }, null, 1));
await browser.close();

// a frame that does not contain the bus is not proof: fail instead of shipping it
const ok = vision.busShare >= 5 && vision.redShare >= 1.5;
console.log(ok ? `PASS bus in frame: ${vision.busShare}% of pixels, ${vision.redShare}% livery red -> ${OUT}` : `FAIL the bus does not read: ${vision.busShare}% changed, ${vision.redShare}% livery red`);
process.exitCode = ok ? 0 : 1;
