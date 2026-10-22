import { DISTRICTS, pointInPoly, type Pt } from './jakartamap';

/**
 * The streets *between* the blocks.
 *
 * Only the arterials and the ring existed, so a district was a field with buildings dropped in
 * it: blocks sat 112 m apart with 30 m of nothing between them, pedestrians had no kerb to walk
 * and a police cruiser had no road to within 50 m of most of the map. These are the local
 * streets, derived from the same 112 m pitch the blocks are laid on, so a street always runs
 * between two rows of blocks by construction.
 *
 * Coordinates are world metres, same space as src/world/jakartamap.ts.
 */

export const BLOCK_PITCH = 112;

export interface Street {
  path: Pt[];
  width: number;
}

/** Clip a straight line to the parts that run inside the polygon. */
function clipToPolygon(pts: Pt[], poly: Pt[]): Pt[][] {
  const runs: Pt[][] = [];
  let current: Pt[] = [];
  for (const p of pts) {
    if (pointInPoly(p[0], p[1], poly)) {
      current.push(p);
    } else if (current.length) {
      if (current.length > 1) runs.push(current);
      current = [];
    }
  }
  if (current.length > 1) runs.push(current);
  return runs;
}

function buildStreets(): Street[] {
  const streets: Street[] = [];
  for (const d of DISTRICTS) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const [x, z] of d.poly) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    // the streets sit halfway between block centres, which are on the 112 m pitch
    const firstX = Math.ceil(minX / BLOCK_PITCH) * BLOCK_PITCH + BLOCK_PITCH / 2;
    const firstZ = Math.ceil(minZ / BLOCK_PITCH) * BLOCK_PITCH + BLOCK_PITCH / 2;
    const step = 18; // sampling resolution for the clip
    for (let x = firstX; x <= maxX; x += BLOCK_PITCH) {
      const line: Pt[] = [];
      for (let z = minZ; z <= maxZ; z += step) line.push([x, z]);
      for (const run of clipToPolygon(line, d.poly)) streets.push({ path: run, width: 12 });
    }
    for (let z = firstZ; z <= maxZ; z += BLOCK_PITCH) {
      const line: Pt[] = [];
      for (let x = minX; x <= maxX; x += step) line.push([x, z]);
      for (const run of clipToPolygon(line, d.poly)) streets.push({ path: run, width: 12 });
    }
  }
  return streets;
}

export const LOCAL_STREETS: Street[] = buildStreets();
