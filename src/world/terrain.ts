import { RIVERS, SHORE_Z } from './jakartamap';

/**
 * Terrain for the Jakarta map.
 *
 * The real city is a delta plain: it sits 2-8 m above the sea over almost its whole area, so
 * "hills everywhere" would be wrong. What it does have, and what a flat plane cannot show:
 *
 *  - the land climbing inland toward Depok and Bogor at the southern edge (the city is a
 *    coastal plain pressed against the Bogor highlands),
 *  - raised banks - tanggul - along every flood canal, the reason the canals read as
 *    embankments rather than ditches,
 *  - a beach slope where the north shore meets Jakarta Bay,
 *  - a metre of drainage undulation across the plain, which is what stops the ground from
 *    looking like a table.
 *
 * Everything is a pure function of (x, z) so physics, props and the road mesh all agree.
 */

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Deterministic value noise: same point always the same height, no texture lookups. */
function hash(ix: number, iz: number): number {
  let h = ix * 374761393 + iz * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) & 0xffff) / 0xffff;
}

function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz);
  const b = hash(ix + 1, iz);
  const c = hash(ix, iz + 1);
  const d = hash(ix + 1, iz + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

function distToPath(x: number, z: number, pts: [number, number][]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, z1] = pts[i];
    const [x2, z2] = pts[i + 1];
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / len2));
    const d = Math.hypot(x - (x1 + dx * t), z - (z1 + dz * t));
    if (d < best) best = d;
  }
  return best;
}

export function terrainHeight(x: number, z: number): number {
  let h = 0;

  // the plain climbs toward the Bogor highlands in the south
  h += smoothstep(520, 1240, z) * 52;          // the Bogor foothills at the map edge
  h += smoothstep(980, 1240, z) * 26;          // and a second, steeper band behind them

  // drainage undulation across the delta: two octaves, a little over a metre
  h += (valueNoise(x / 240, z / 240) - 0.5) * 2.6;
  h += (valueNoise(x / 70, z / 70) - 0.5) * 0.5;

  // tanggul: a raised bank either side of every canal, crest about 9 m off the water
  for (const r of RIVERS) {
    const d = distToPath(x, z, r.path) - r.width / 2;
    if (d > -3 && d < 30) {
      const crest = 1 - Math.abs(d - 9) / 14;
      if (crest > 0) h += crest * 3.2;
    }
  }

  // the north shore dips into Jakarta Bay
  h -= smoothstep(SHORE_Z + 60, SHORE_Z - 10, z) * 2.2;

  return h;
}

/** True for the bay: the ground mesh leaves a hole and the water plane covers it. */
export function isSea(x: number, z: number): boolean {
  return z < SHORE_Z - 6;
}
