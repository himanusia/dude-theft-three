/**
 * Simplified Jakarta: the shapes that make the city legible, not a 1:1 survey.
 *
 * Coordinates are world metres with +x east, +z south, so the bay is at negative z and the
 * south of the city (Blok M, Kemang) at positive z. Everything here is hand-drawn from the
 * real city's structure: the bay with its reclaimed island chain, the Ciliwung and the two
 * flood canals, the inner ring toll road, the radial arterials, and district polygons that
 * follow those roads instead of a grid.
 *
 * The shapes are sketched in a compact space and stretched by SCALE into the world the game
 * actually builds. At 1x the whole city was 380 m across, which made a 22 m arterial look
 * like a motorway through a village; at 5.7x the map spans 2.4 km, a block runs 120-150 m,
 * and the road widths below are real Jakarta widths.
 */

export type Pt = [number, number];

/** Stretch factor from sketch space to world metres. */
export const SCALE = 5.7;

const S = (pts: Pt[]): Pt[] => pts.map(([x, z]): Pt => [+(x * SCALE).toFixed(1), +(z * SCALE).toFixed(1)]);

/** the bay: everything north of this line is water */
export const COASTLINE: Pt[] = S([
  [-210, -150], [-150, -146], [-110, -152], [-70, -148], [-30, -158],
  [10, -150], [50, -156], [95, -150], [140, -158], [180, -150], [210, -148],
]);

/** reclaimed islands off the north shore (the real ones are apartment blocks, so: slabs) */
export const ISLANDS: Pt[][] = [
  S([[-92, -176], [-64, -176], [-64, -164], [-92, -164]]),
  S([[-24, -184], [4, -184], [4, -170], [-24, -170]]),
  S([[44, -178], [72, -178], [72, -166], [44, -166]]),
];

/** rivers and canals: Ciliwung, Banjir Kanal Barat, Banjir Kanal Timur, Sunter */
export const RIVERS: { name: string; width: number; path: Pt[] }[] = [
  {
    name: 'Ciliwung',
    width: 22,
    path: S([[-26, 200], [-34, 150], [-24, 108], [-38, 64], [-28, 20], [-44, -28], [-38, -74], [-52, -110], [-46, -148]]),
  },
  {
    name: 'Banjir Kanal Barat',
    width: 30,
    path: S([[-168, 120], [-140, 92], [-132, 40], [-120, -4], [-104, -52], [-92, -104], [-84, -148]]),
  },
  {
    name: 'Banjir Kanal Timur',
    width: 26,
    path: S([[138, 168], [128, 116], [130, 60], [116, 12], [104, -44], [96, -102], [90, -150]]),
  },
  {
    name: 'Sunter',
    width: 18,
    path: S([[176, 40], [166, -16], [172, -72], [160, -118], [150, -150]]),
  },
];

/** the inner ring toll road: a lumpy loop, not a rectangle */
export const RING_ROAD: Pt[] = S([
  [-138, -96], [-92, -112], [-30, -116], [40, -110], [96, -96],
  [132, -52], [140, 10], [124, 66], [86, 112], [30, 132],
  [-34, 130], [-96, 112], [-136, 62], [-152, 4], [-150, -56], [-138, -96],
]);

/**
 * Arterials: the spine plus the radials that carry the city's traffic. Widths are the real
 * thing, in metres - Thamrin-Sudirman is a 22 m cross-section, a neighbourhood radial is 12.
 */
export const ARTERIALS: { name: string; width: number; path: Pt[] }[] = [
  { name: 'Thamrin–Sudirman', width: 20, path: S([[0, -96], [-4, -40], [0, 18], [2, 74], [0, 130]]) },
  { name: 'Gatot Subroto', width: 16, path: S([[-104, -30], [-48, -18], [8, -12], [66, -4], [126, -14]]) },
  { name: 'Casablanca', width: 13, path: S([[6, 30], [50, 22], [92, 4], [128, -22]]) },
  { name: 'Grogol–Pluit', width: 13, path: S([[-146, -18], [-104, -30], [-72, -74], [-60, -120]]) },
  { name: 'Fatmawati–Blok M', width: 13, path: S([[4, 96], [16, 130], [46, 156], [92, 168]]) },
  { name: 'Kota Tua–Ancol', width: 12, path: S([[-104, -120], [-56, -128], [4, -126], [62, -134], [116, -126]]) },
  { name: 'Kemang–Pasar Minggu', width: 10, path: S([[26, 106], [44, 130], [58, 164]]) },
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
    poly: S([[-160, -148], [-56, -150], [-52, -116], [-96, -108], [-140, -112], [-162, -128]]),
  },
  {
    id: 'ancol', name: 'Ancol', color: '#4f7e74',
    poly: S([[-48, -150], [180, -150], [176, -108], [96, -100], [24, -104], [-30, -110], [-48, -120]]),
  },
  {
    id: 'glodok', name: 'Glodok', color: '#b08a3e',
    poly: S([[-150, -104], [-96, -104], [-46, -114], [-40, -74], [-70, -52], [-128, -60], [-152, -80]]),
  },
  {
    id: 'gambir', name: 'Gambir', color: '#c9c3b2',
    poly: S([[-44, -74], [44, -80], [52, -24], [30, 20], [-26, 22], [-46, -20]]),
  },
  {
    id: 'thamrin', name: 'Thamrin', color: '#5b7f9e',
    poly: S([[26, 22], [78, 16], [96, 70], [72, 118], [26, 122], [4, 76]]),
  },
  {
    id: 'tanahabang', name: 'Tanah Abang', color: '#9c8f74',
    poly: S([[-140, -46], [-74, -46], [-40, -18], [-46, 40], [-96, 62], [-136, 34]]),
  },
  {
    id: 'kemang', name: 'Kemang', color: '#7d8a6a',
    poly: S([[-40, 46], [22, 40], [34, 104], [8, 150], [-46, 142], [-62, 96]]),
  },
  {
    id: 'blokm', name: 'Blok M', color: '#8f8a74',
    poly: S([[36, 126], [98, 120], [126, 150], [110, 186], [46, 184], [22, 156]]),
  },
  {
    id: 'kampung', name: 'Kampung', color: '#a9855f',
    poly: S([[100, -96], [176, -96], [186, 40], [150, 92], [104, 74], [92, 10]]),
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

const LM = (x: number, z: number): [number, number] => [+(x * SCALE).toFixed(1), +(z * SCALE).toFixed(1)];

export const LANDMARKS: LandmarkSlot[] = [
  { id: 'monas', name: 'Monas', ...lm(0, -46), district: 'gambir', brief: 'marble obelisk with a gold flame on an open square' },
  { id: 'bundaran-hi', name: 'Bundaran HI', ...lm(2, 8), district: 'thamrin', brief: 'roundabout with the Welcome Monument and its fountain ring' },
  { id: 'stadhuis', name: 'Stadhuis', ...lm(-104, -130), district: 'kotatua', brief: 'white colonial town hall, red clay roof, clock tower, cobbled square' },
  { id: 'glodok-gate', name: 'Gapura Glodok', ...lm(-70, -96), district: 'glodok', brief: 'paifang over the road: grey pillars, tiled roof, three plaques' },
  { id: 'ancol-beach', name: 'Pantai Ancol', ...lm(96, -140), district: 'ancol', brief: 'sand, calm water, timber pier, feather flags, ferris wheel silhouette' },
  { id: 'tanahabang-market', name: 'Pasar Tanah Abang', ...lm(-88, 8), district: 'tanahabang', brief: 'multi-storey textile market under tarpaulin canopies' },
  { id: 'blokm-terminal', name: 'Terminal Blok M', ...lm(74, 152), district: 'blokm', brief: 'bus terminal shed with angkot bays' },
  { id: 'kemang-row', name: 'Kemang', ...lm(-6, 96), district: 'kemang', brief: 'low cafe row with verandas and street trees' },
];

function lm(x: number, z: number): { x: number; z: number } {
  const [sx, sz] = LM(x, z);
  return { x: sx, z: sz };
}


/** Street life the map has to show, not just monuments. */
export type PoiKind = 'halte' | 'terminal' | 'pasar' | 'minimarket' | 'pos' | 'masjid' | 'kaki5';

export interface Poi {
  kind: PoiKind;
  name: string;
  x: number;
  z: number;
}

export const POIS: Poi[] = [
  { kind: 'terminal', name: 'Terminal Blok M', ...lm(74, 152) },
  { kind: 'terminal', name: 'Terminal Tanah Abang', ...lm(-96, 26) },
  { kind: 'halte', name: 'Halte Bundaran HI', ...lm(4, 12) },
  { kind: 'halte', name: 'Halte Sarinah', ...lm(-1, -18) },
  { kind: 'halte', name: 'Halte Harmoni', ...lm(-6, -58) },
  { kind: 'halte', name: 'Halte Kota', ...lm(-88, -104) },
  { kind: 'pasar', name: 'Pasar Tanah Abang', ...lm(-88, 8) },
  { kind: 'pasar', name: 'Pasar Glodok', ...lm(-78, -88) },
  { kind: 'minimarket', name: 'ALFAMURTI', ...lm(18, 42) },
  { kind: 'minimarket', name: 'INDOMERET', ...lm(34, -14) },
  { kind: 'masjid', name: 'Masjid Istiqlal', ...lm(-24, -74) },
  { kind: 'pos', name: 'Pos Polisi Bundaran HI', ...lm(14, 4) },
  { kind: 'kaki5', name: 'PKL Thamrin', ...lm(10, 30) },
  { kind: 'kaki5', name: 'PKL Blok M', ...lm(60, 140) },
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

/** the shoreline in world metres: north of it is the bay */
export const SHORE_Z = -150 * SCALE;

/** true when a point is water */
export function isWater(x: number, z: number): boolean {
  return z < SHORE_Z;
}
