/**
 * TransJakarta in service, traffic density, and the bus's own geometry.
 *
 *   node tests/world/tj.mjs            (DTA_URL, default http://127.0.0.1:8765)
 *
 * Runs against a server for the tree under test: `npm run build` then serve `dist/`, or
 * `npx vite preview`. Five checks:
 *   1. at least two TransJakarta buses are in service and actually moving on the loop
 *   2. the bus sits on the busway lane of the arterial, not on the pavement or a block
 *   3. the bus has no two faces on the same plane facing the same way (z-fighting)
 *   4. the bus stays inside its triangle / draw-call budget
 *   5. traffic crosses a fixed junction point in 30 s of play, and the first car arrives
 *      inside 15 s
 */
import { bootGame, measureBus, measureCrossings, measureService } from '../../tools/tj-measure.mjs';

const BASE = process.env.DTA_URL || 'http://127.0.0.1:8765';
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
};

const { browser, page, errors } = await bootGame(BASE);
try {
  // ---- the asset ----------------------------------------------------------------------------
  const bus = await measureBus(page);
  console.log('BUS', JSON.stringify({ ...bus, pairs: undefined }));
  check('bus has no overlapping coplanar faces', bus.fights === 0, {
    fightPairs: bus.pairs.filter((p) => p.kind === 'fight').slice(0, 6),
    seams: bus.seams,
  });
  check('bus inside its triangle / draw-call budget', bus.trianglesPerBus <= 3000 && bus.drawsPerBus <= 16, {
    triangles: bus.trianglesPerBus,
    draws: bus.drawsPerBus,
  });

  // ---- the service --------------------------------------------------------------------------
  const service = await measureService(page);
  console.log('SERVICE', JSON.stringify({ ...service, after: undefined }));
  check('at least two buses in service', service && service.count >= 2 && service.inService >= 2, {
    count: service?.count,
    travelled: service?.travelled,
    inService: service?.inService,
  });
  check('buses run the arterial busway lane', service && service.offLoop.every((d) => d <= 0.05) && service.onRoad.every(Boolean), {
    offLoop: service?.offLoop,
    onRoad: service?.onRoad,
  });

  // ---- the streets --------------------------------------------------------------------------
  const crossings = await measureCrossings(page, { seconds: 30 });
  console.log('TRAFFIC', JSON.stringify(crossings));
  check('a junction sees moving cars inside 15 s', crossings.firstAt !== null && crossings.firstAt <= 15, {
    firstAt: crossings.firstAt,
    cars: crossings.cars,
  });
  // measured 4 per 30 s before this change, 8-13 after across runs on this host; the gate below
  // asks for the density the owner can see, not for a specific sample
  check('traffic crosses a fixed point', crossings.cars >= 6, {
    cars: crossings.cars,
    simSeconds: crossings.simSeconds,
    firstAt: crossings.firstAt,
    types: crossings.crossings.map((c) => c.type),
  });
  check('no page errors', errors.length === 0, errors.slice(0, 4));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log('SUMMARY', JSON.stringify({ pass: results.length - failed.length, total: results.length }));
if (failed.length) {
  console.error(`tj: ${failed.length}/${results.length} checks failed`);
  process.exitCode = 1;
}
