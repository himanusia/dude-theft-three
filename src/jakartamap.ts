/**
 * Simplified Jakarta: the shapes that make the city legible, not a 1:1 survey.
 *
 * Coordinates are world metres with +x east, +z south, so the bay is at negative z and the
 * south of the city (Blok M, Kemang) at positive z. Everything here is hand-drawn from the
 * real city's structure: the bay with its reclaimed island chain, the Ciliwung and the two
 * flood canals, the inner ring toll road, the radial arterials, and district polygons that
 * follow those roads instead of a grid.
 *
 * The point of this file is that the map, the road network and the generator all read the
 * same data: if a district is shaped like this on the poster, it is shaped like this in game.
 */

export type Pt = [number, number];

/** the bay: everything north of this line is water */
export const COASTLINE: Pt[] = [
  [-210, -150], [-150, -146], [-110, -152], [-70, -148], [-30, -158],
  [10, -150], [50, -156], [95, -150], [140, -158], [180, -150], [210, -148],
];

/** reclaimed islands off the north shore (the real ones are apartment blocks, so: slabs) */
export const ISLANDS: Pt[][] = [
  [[-92, -176], [-64, -176], [-64, -164], [-92, -164]],
  [[-24, -184], [4, -184], [4, -170], [-24, -170]],
  [[44, -178], [72, -178], [72, -166], [44, -166]],
];

/** rivers and canals: the Ciliwung, Banjir Kanal Barat, Banjir Kanal Timur, Sunter */
export const RIVERS: { name: string; width: number; path: Pt[] }[] = [
  {
    name: 'Ciliwung',
    width: 9,
    path: [[-26, 200], [-34, 150], [-24, 108], [-38, 64], [-28, 20], [-44, -28], [-38, -74], [-52, -110], [-46, -148]],
  },
  {
    name: 'Banjir Kanal Barat',
    width: 12,
    path: [[-168, 120], [-140, 92], [-132, 40], [-120, -4], [-104, -52], [-92, -104], [-84, -148]],
  },
  {
    name: 'Banjir Kanal Timur',
    width: 11,
    path: [[138, 168], [128, 116], [130, 60], [116, 12], [104, -44], [96, -102], [90, -150]],
  },
  {
    name: 'Sunter',
    width: 7,
    path: [[176, 40], [166, -16], [172, -72], [160, -118], [150, -150]],
  },
];

/** the inner ring toll road: a lumpy loop, not a rectangle */
export const RING_ROAD: Pt[] = [
  [-138, -96], [-92, -112], [-30, -116], [40, -110], [96, -96],
  [132, -52], [140, 10], [124, 66], [86, 112], [30, 132],
  [-34, 130], [-96, 112], [-136, 62], [-152, 4], [-150, -56], [-138, -96],
];

/** arterials: the spine, plus the radials that carry the city's traffic */
export const ARTERIALS: { name: string; width: number; path: Pt[] }[] = [
  { name: 'Thamrin–Sudirman', width: 22, path: [[0, -96], [-4, -40], [0, 18], [2, 74], [0, 130]] },
  { name: 'Gatot Subroto', width: 18, path: [[-104, -30], [-48, -18], [8, -12], [66, -4], [126, -14]] },
  { name: 'Casablanca', width: 15, path: [[6, 30], [50, 22], [92, 4], [128, -22]] },
  { name: 'Grogol–Pluit', width: 15, path: [[-146, -18], [-104, -30], [-72, -74], [-60, -120]] },
  { name: 'Fatmawati–Blok M', width: 15, path: [[4, 96], [16, 130], [46, 156], [92, 168]] },
  { name: 'Kota Tua–Ancol', width: 14, path: [[-104, -120], [-56, -128], [4, -126], [62, -134], [116, -126]] },
  { name: 'Kemang–Pasar Minggu', width: 12, path: [[26, 106], [44, 130], [58, 164]] },
];

export type DistrictId =
  | 'kotatua'
  | 'glodok'
  | 'ancol'
  | 'gambir'
  | 'thamrin'
  | 'tanahabang'
  | 'kemang'
  | 'blokm'
  | 'kampung';

export interface DistrictShape {
  id: DistrictId;
  name: string;
  color: string;
  /** a rough polygon in world metres; blocks are typed by point-in-polygon */
  poly: Pt[];
}

/**
 * District outlines. They are deliberately irregular and follow the roads: Kota Tua hugs the
 * bay corner, Glodok wraps the canal, Tanah Abang is pinched between two arterials, the
 * kampung splinters around the eastern arterials.
 */
export const DISTRICTS: DistrictShape[] = [
  {
    id: 'kotatua', name: 'Kota Tua', color: '#c9714f',
    poly: [[-160, -148], [-56, -150], [-52, -116], [-96, -108], [-140, -112], [-162, -128]],
  },
  {
    id: 'ancol', name: 'Ancol', color: '#4f7e74',
    poly: [[-48, -150], [180, -150], [176, -108], [96, -100], [24, -104], [-30, -110], [-48, -120]],
  },
  {
    id: 'glodok', name: 'Glodok', color: '#b08a3e',
    poly: [[-150, -104], [-96, -104], [-46, -114], [-40, -74], [-70, -52], [-128, -60], [-152, -80]],
  },
  {
    id: 'gambir', name: 'Gambir', color: '#c9c3b2',
    poly: [[-44, -74], [44, -80], [52, -24], [30, 20], [-26, 22], [-46, -20]],
  },
  {
    id: 'thamrin', name: 'Thamrin', color: '#5b7f9e',
    poly: [[26, 22], [78, 16], [96, 70], [72, 118], [26, 122], [4, 76]],
  },
  {
    id: 'tanahabang', name: 'Tanah Abang', color: '#9c8f74',
    poly: [[-140, -46], [-74, -46], [-40, -18], [-46, 40], [-96, 62], [-136, 34]],
  },
  {
    id: 'kemang', name: 'Kemang', color: '#7d8a6a',
    poly: [[-40, 46], [22, 40], [34, 104], [8, 150], [-46, 142], [-62, 96]],
  },
  {
    id: 'blokm', name: 'Blok M', color: '#8f8a74',
    poly: [[36, 126], [98, 120], [126, 150], [110, 186], [46, 184], [22, 156]],
  },
  {
    id: 'kampung', name: 'Kampung', color: '#a9855f',
    poly: [[100, -96], [176, -96], [186, 40], [150, 92], [104, 74], [92, 10]],
  },
];

/** Landmarks the map promises; each one is an asset the world has to build. */
export interface LandmarkSlot {
  id: string;
  name: string;
  x: number;
  z: number;
  district: DistrictId;
  /** what it is, in one line, for the asset list */
  brief: string;
}

export const LANDMARKS: LandmarkSlot[] = [
  { id: 'monas', name: 'Monas', x: 0, z: -46, district: 'gambir', brief: 'marble obelisk with a gold flame on an open square' },
  { id: 'bundaran-hi', name: 'Bundaran HI', x: 2, z: 8, district: 'thamrin', brief: 'roundabout with the Welcome Monument and its fountain ring' },
  { id: 'stadhuis', name: 'Stadhuis', x: -104, z: -130, district: 'kotatua', brief: 'white colonial town hall, red clay roof, clock tower, cobbled square' },
  { id: 'glodok-gate', name: 'Gapura Glodok', x: -70, z: -96, district: 'glodok', brief: 'paifang over the road: grey pillars, tiled roof, three plaques' },
  { id: 'ancol-beach', name: 'Pantai Ancol', x: 96, z: -140, district: 'ancol', brief: 'sand, calm water, timber pier, feather flags, ferris wheel silhouette' },
  { id: 'tanahabang-market', name: 'Pasar Tanah Abang', x: -88, z: 8, district: 'tanahabang', brief: 'multi-storey textile market under tarpaulin canopies' },
  { id: 'blokm-terminal', name: 'Terminal Blok M', x: 74, z: 152, district: 'blokm', brief: 'bus terminal shed with angkot bays' },
  { id: 'kemang-row', name: 'Kemang', x: -6, z: 96, district: 'kemang', brief: 'low cafe row with verandas and street trees' },
];

export function pointInPoly(x: number, z: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    const hit = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

/** which district owns a world point; falls back to the nearest by centre */
export function districtAtPoint(x: number, z: number): DistrictId {
  for (const d of DISTRICTS) if (pointInPoly(x, z, d.poly)) return d.id;
  let best: DistrictId = 'kampung';
  let bestD = Infinity;
  for (const d of DISTRICTS) {
    const cx = d.poly.reduce((s, p) => s + p[0], 0) / d.poly.length;
    const cz = d.poly.reduce((s, p) => s + p[1], 0) / d.poly.length;
    const dist = Math.hypot(cx - x, cz - z);
    if (dist < bestD) { bestD = dist; best = d.id; }
  }
  return best;
}

/** true when a point is water: the bay, or inside one of the reclaimed islands' channels */
export function isWater(x: number, z: number): boolean {
  if (z < -150) return true;
  return false;
}
