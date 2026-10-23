import { POIS } from './jakartamap';
import { buildHalte } from './halte';
import { buildKakiLima, buildSppg, buildKoperasi, KakiLimaKind } from './kakilima';
import { TransjakartaBus } from '../vehicles/transjakarta';
import { buildLayang } from './layang';
import { buildMrtLine, buildMrtStation } from './mrt';
import { buildKrl } from './krl';
import { buildMinimarket } from './minimarket';
import { buildPosPolisi } from './pospolisi';
import { buildRumahPadang } from './rumahpadang';
import { buildMasjid } from './masjid';
import { buildPasar } from './pasar';
import { buildRonda } from './ronda';
import { buildTerminal } from './terminal';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, lerp, rand, randInt, pick, TAU, box, canvasTexture, AABB } from '../core/utils';
import { districtAt, landmarkAt, DISTRICTS, buildMonas, buildBundaran, buildKotaTua, buildMarketStalls, buildGlodokGate, buildAncolShore } from './jakarta';
import { COASTLINE, ISLANDS, RIVERS, RING_ROAD, ARTERIALS, LANDMARKS, DISTRICTS as JKT_DISTRICTS, districtAtPoint, isWater, pointInPoly } from './jakartamap';
import { buildInterior, Interior, InteriorKind, PlacedInterior } from './interior';
import { terrainHeight } from './terrain';
import { LOCAL_STREETS } from './streets';
import { Car, driverLook } from '../vehicles/car';
import { Ojek } from '../vehicles/ojek';
import {
  buildRoadSegment,
  buildKerbWalk,
  buildSignalIntersection,
  buildUtilityPole,
  buildStreetNameSign,
  buildManhole,
  buildDrainGrate,
  buildBollard,
} from './streetkit';

// City-block scale. A block is 140 m and the pitch is 170 m, so the street between two
// blocks is 30 m of asphalt and pavement - close to a real Jakarta block, and wide enough
// that a 22 m arterial no longer looks like a motorway through a village.
export const PITCH = 170;
export const BLOCK = 140;
export const ROAD = PITCH - BLOCK;
export const GRID = 7; // blocks from -7..7 on each axis: a 2.5 km city
export const WORLD_HALF = GRID * PITCH + BLOCK * 0.5;

// light panels + blue glass, like the reference city blocks
const WALLS = ['#e9e7ef', '#dfe6ee', '#f2e7d8', '#d9e4e6', '#efe3ea', '#e6ecdf'];
const NIGHT = 0x0a0d18;

/**
 * The roads that carry a raised trotoar: the arterials and the ring.
 *
 * One list, because four things have to agree about it - the kerb that is swept along it, the
 * paving behind that kerb, where a pedestrian can cross it, and the ground height anything
 * standing on it needs. Local streets are asphalt only, so they are not here.
 */
const WALK_ROADS = [
  ...ARTERIALS.map((a) => ({ path: a.path as [number, number][], width: a.width })),
  { path: RING_ROAD as [number, number][], width: 20 },
];


// Every interior kind is built once; shop doors cycle through this pool, so all
// seven rooms are reachable no matter how the city is randomised.
const SHOP_KINDS: InteriorKind[] = ['minimarket', 'warteg', 'kopi', 'bengkel', 'apotek', 'laundry', 'salon'];

const KIND_SIGN: Record<InteriorKind, string> = {
  minimarket: '#c0392b',
  warteg: '#2f5d3a',
  bengkel: '#2f5d3a',
  kopi: '#3f2a1d',
  apotek: '#1f7a55',
  laundry: '#2f6f9f',
  salon: '#8a4a5f',
};

const KIND_MAT: Record<InteriorKind, number> = {
  minimarket: 0xc0392b,
  warteg: 0x3f6b4a,
  bengkel: 0x4a4f55,
  kopi: 0x5d4037,
  apotek: 0x2f8f6a,
  laundry: 0x2f6f9f,
  salon: 0x8a4a5f,
};

function fitFont(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, startSize: number) {
  let size = startSize;
  ctx.font = `bold ${size}px ui-sans-serif, system-ui, sans-serif`;
  while (size > 10 && ctx.measureText(text).width > maxWidth) {
    size -= 2;
    ctx.font = `bold ${size}px ui-sans-serif, system-ui, sans-serif`;
  }
}


/** Roller-shutter shopfront, shared by every frontage building. */
let shutterMat: THREE.MeshStandardMaterial | null = null;
const shopfrontCache: THREE.MeshStandardMaterial[] = [];

/**
 * The ground floor of a ruko, after reference/assets/ruko-ref-0.jpg (Komplek Pertokoan
 * Jalan Pekiringan, Cirebon; Wikimedia, CC BY-SA 4.0). What the photo actually shows along the
 * pavement: banner signs in flat strong colours strung across the frontage, some bays shuttered
 * and some glazed with the shop lit inside, striped awnings over the walk, air-con units bolted
 * to the wall, and paint that has run at the kerb line.
 *
 * Three variants so a row of buildings is not one print repeated. One tile spans four bays.
 */
function shopfrontMat(variant = 0): THREE.MeshStandardMaterial {
  const cached = shopfrontCache[variant];
  if (cached) return cached;

  const fascias = ['#c9302c', '#e8b91d', '#1f7a4d', '#f2efe6', '#2b4c7e'];
  const awnings = ['#e2622a', '#2f6fb3', '#c0392b', '#3f7d3a'];
  const glassGlow = ['#f6d98a', '#f3e6c8', '#dce9f2'];

  const tex = canvasTexture(512, 128, (ctx, w, h) => {
    ctx.fillStyle = '#cfc7b4';
    ctx.fillRect(0, 0, w, h);

    const bay = w / 4;
    for (let i = 0; i < 4; i++) {
      const x0 = i * bay;
      const kind = (i + variant) % 3;      // 0 = shuttered, 1 = glazed & lit, 2 = half-glazed

      // glazing or shutter -------------------------------------------------------------
      if (kind === 0) {
        ctx.fillStyle = '#5f666e';
        ctx.fillRect(x0 + 4, 34, bay - 8, h - 34);
        for (let y = 40; y < h - 6; y += 9) {
          ctx.fillStyle = '#767d85';
          ctx.fillRect(x0 + 4, y, bay - 8, 5);
          ctx.fillStyle = 'rgba(0,0,0,0.22)';
          ctx.fillRect(x0 + 4, y + 5, bay - 8, 3);
        }
      } else {
        // interior first, then the mullions over it
        ctx.fillStyle = glassGlow[(i + variant) % 3];
        ctx.fillRect(x0 + 4, 34, bay - 8, h - 34);
        ctx.fillStyle = 'rgba(90,70,40,0.35)';
        ctx.fillRect(x0 + 4, 34, bay - 8, 26);              // shelving in shadow
        if (kind === 2) {                                    // half shuttered
          ctx.fillStyle = '#666d75';
          ctx.fillRect(x0 + 4, 34, (bay - 8) / 2, h - 34);
        }
        ctx.fillStyle = '#2f353b';
        for (let mx = x0 + 4; mx < x0 + bay - 4; mx += 26) ctx.fillRect(mx, 34, 3, h - 34);
        ctx.fillRect(x0 + 4, 62, bay - 8, 3);
        ctx.fillRect(x0 + 4, 96, bay - 8, 3);
        // a door in the middle of the open bay
        ctx.fillStyle = '#20262c';
        ctx.fillRect(x0 + bay / 2 - 9, 58, 18, h - 58);
      }

      // awnings: a striped band that overhangs the walk
      const aw = awnings[(i + variant * 2) % awnings.length];
      ctx.fillStyle = aw;
      ctx.fillRect(x0 + 2, 20, bay - 4, 14);
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      for (let sx = x0 + 2; sx < x0 + bay - 4; sx += 18) ctx.fillRect(sx, 20, 9, 14);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(x0 + 2, 32, bay - 4, 4);

      // banner sign above the awning, one flat colour per bay
      ctx.fillStyle = fascias[(i * 2 + variant) % fascias.length];
      ctx.fillRect(x0 + 2, 4, bay - 4, 15);
      // letter-like blocks: signage reads at this scale without spelling anything
      const ink = ctx.fillStyle === '#f2efe6' ? '#20262c' : '#ffffff';
      ctx.fillStyle = ink;
      for (let gx = x0 + 10; gx < x0 + bay - 12; gx += 11) {
        const bh = 7 + ((gx * 7 + i * 13) % 4);
        ctx.fillRect(gx, 8 + (9 - bh) / 2, 7, bh);
      }

      // an air-con box bolted beside the bay, as on every ruko in the photo
      if ((i + variant) % 2 === 0) {
        ctx.fillStyle = '#e8e8e3';
        ctx.fillRect(x0 + bay - 26, 46, 20, 14);
        ctx.fillStyle = '#9aa0a6';
        ctx.fillRect(x0 + bay - 24, 49, 16, 8);
      }

      // paint run and kerb grime
      const grad = ctx.createLinearGradient(0, h - 26, 0, h);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(30,24,16,0.45)');
      ctx.fillStyle = grad;
      ctx.fillRect(x0, h - 26, bay, 26);
    }

    // dirt streaks down the whole face
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(40,34,24,${rand(0.02, 0.09)})`;
      ctx.fillRect(rand(0, w), rand(20, h - 30), rand(2, 7), rand(10, 40));
    }
  });

  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 1);
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.88 });
  shopfrontCache[variant] = mat;
  return mat;
}

// ---------------------------------------------------------------------------
// Upper-storey facades.
//
// One tile is one storey: 4.2 m of wall by 3.2 m of height. A building stretches that tile with
// its own UVs (facadeUV) instead of owning a texture, because the old path baked the repeat into
// the cache key -- one canvas per (colour, style, repeat-x, repeat-y) -- and the city was paying
// for ~1,400 textures. Now the key is (colour, style, variant): a few hundred at most, shared.
//
// Every tile carries the three things that stop a wall reading as one flat fill: a slab join at
// the storey line, a window with a frame, a recessed reveal and a sill, and a trim colour that is
// deliberately not the wall colour. The fittings you can walk under -- cornices, ledges, balcony
// rails, pipes, AC boxes, penthouses, painted sign bands -- are geometry (addFacadeDetail), so
// they cast their own shadow line under the sun.
// ---------------------------------------------------------------------------

export type FacadeVariant = 'plain' | 'ledge' | 'balcony' | 'pipes' | 'ac' | 'penthouse' | 'signband';

/** The ruko fittings, in the order one block mixes them. */
export const FACADE_VARIANTS: FacadeVariant[] = ['plain', 'ledge', 'balcony', 'pipes', 'ac', 'penthouse', 'signband'];

const FACADE_TILE_W = 4.2; // metres of wall in one tile, horizontally
const FACADE_TILE_H = 3.2; // one storey

/** Trims are a fixed three, so the tile key stays `wall|style|variant` instead of exploding. */
const TRIM_COLORS = [0xefe7d6, 0x8b8377, 0x4b4239];
const SIGN_BAND_COLORS = [0xc8452f, 0x1f6f8b, 0xd8a02a, 0x2f7a4f, 0x8a2f6b];

const hexOf = (c: any): string => (typeof c === 'number' ? `#${c.toString(16).padStart(6, '0')}` : String(c));

function wallLuminance(wall: any): number {
  const h = hexOf(wall).replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** A light wall gets the dark trim and a dark wall the light one: the trim has to be seen. */
function trimFor(wall: any): number {
  const lum = wallLuminance(wall);
  return lum > 0.66 ? TRIM_COLORS[2] : lum > 0.46 ? TRIM_COLORS[1] : TRIM_COLORS[0];
}

/** One window: recessed reveal, trim frame, transom, glass with a sky band, lit sill. */
function paintWindow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  ww: number,
  wh: number,
  trim: string,
  mullion = true
) {
  // the opening is cut back into the wall, so its top and left reveal sit in shadow
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.fillRect(x - 3, y - 3, ww + 6, wh + 7);
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.fillRect(x + ww + 3, y - 3, 2, wh + 7); // right reveal catches the light
  const g = ctx.createLinearGradient(x, y, x + ww, y + wh);
  g.addColorStop(0, '#93b2c6');
  g.addColorStop(0.45, '#527086');
  g.addColorStop(1, '#2b3b49');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, ww, wh);
  ctx.fillStyle = 'rgba(232,246,255,0.34)'; // sky reflected in the head of the glass
  ctx.fillRect(x, y, ww, Math.max(2, wh * 0.16));
  ctx.fillStyle = 'rgba(250,238,214,0.14)'; // a curtain behind the panes
  ctx.fillRect(x + ww * 0.08, y + wh * 0.22, ww * 0.3, wh * 0.78);
  ctx.fillStyle = trim;
  if (mullion) ctx.fillRect(x + ww / 2 - 1, y, 2, wh);
  ctx.fillRect(x, y + wh * 0.38, ww, 2);
  ctx.strokeStyle = trim;
  ctx.lineWidth = 3;
  ctx.strokeRect(x - 1.5, y - 1.5, ww + 3, wh + 3);
  ctx.fillStyle = trim; // sill, then the shadow it drops
  ctx.fillRect(x - 5, y + wh + 3, ww + 10, 4);
  ctx.fillStyle = 'rgba(0,0,0,0.24)';
  ctx.fillRect(x - 5, y + wh + 7, ww + 10, 3);
}

const facadeTileCache = new Map<string, THREE.Texture>();

function windowTexture(wall: any, style = 'grid', variant: FacadeVariant = 'plain'): THREE.Texture {
  const key = `${wall}|${style}|${variant}`;
  const hit = facadeTileCache.get(key);
  if (hit) return hit;
  const trim = hexOf(trimFor(wall));
  const map = canvasTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = hexOf(wall);
    ctx.fillRect(0, 0, w, h);

    // plaster: large value shifts and streak grime, so a "single colour" wall never is one
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = Math.random() < 0.5 ? 'rgba(255,252,240,0.10)' : 'rgba(20,16,10,0.10)';
      ctx.fillRect(rand(0, w * 0.8), rand(0, h * 0.7), rand(18, w * 0.6), rand(12, h * 0.5));
    }
    // water stains running down from the slab line: the single biggest tell that a wall is
    // plaster and not a filled rectangle, and it costs nothing at draw time
    for (let i = 0; i < 9; i++) {
      const sx = rand(0, w);
      const sw = rand(3, 11);
      const len = rand(h * 0.25, h * 0.9);
      const grad = ctx.createLinearGradient(0, 4, 0, 4 + len);
      grad.addColorStop(0, 'rgba(38,32,24,0.20)');
      grad.addColorStop(1, 'rgba(38,32,24,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(sx, 4, sw, len);
    }
    for (let i = 0; i < 22; i++) {
      ctx.fillStyle = `rgba(0,0,0,${rand(0.03, 0.09)})`;
      ctx.fillRect(rand(0, w), rand(0, h - 8), rand(1, 5), rand(8, h * 0.6));
    }

    // the slab join, at the top of every storey, with the light catching its lower edge and a
    // shadow falling out of it onto the wall below
    ctx.fillStyle = 'rgba(0,0,0,0.40)';
    ctx.fillRect(0, 0, w, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.26)';
    ctx.fillRect(0, 3, w, 1);
    const under = ctx.createLinearGradient(0, 4, 0, 22);
    under.addColorStop(0, 'rgba(0,0,0,0.16)');
    under.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = under;
    ctx.fillRect(0, 4, w, 18);
    // floor line at the foot of the storey, so the tile never butts into the next one flat
    ctx.fillStyle = 'rgba(0,0,0,0.13)';
    ctx.fillRect(0, h - 2, w, 2);

    // a ledge course is a shadow-catcher: band in trim, then the shadow it throws
    if (variant === 'ledge') {
      ctx.fillStyle = trim;
      ctx.fillRect(0, 4, w, 5);
      ctx.fillStyle = 'rgba(0,0,0,0.20)';
      ctx.fillRect(0, 9, w, 3);
    }

    if (style === 'bands') {
      paintWindow(ctx, 12, 38, w - 24, 44, trim, false);
      ctx.fillStyle = trim;
      ctx.fillRect((w - 24) / 3 - 1, 38, 2, 44);
      ctx.fillRect((2 * (w - 24)) / 3 - 1, 38, 2, 44);
    } else if (style === 'strips') {
      for (const x of [14, 55, 96]) paintWindow(ctx, x, 20, 18, 78, trim, false);
    } else {
      paintWindow(ctx, 14, 34, 42, 56, trim);
      paintWindow(ctx, 72, 34, 42, 56, trim);
    }

    if (variant === 'balcony') {
      // the railing that closes in every ruko balcony, and the slab shadow under it
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      ctx.fillRect(0, 90, w, 2);
      ctx.fillStyle = trim;
      ctx.fillRect(0, 82, w, 3);
      for (let x = 4; x < w; x += 9) {
        ctx.fillStyle = 'rgba(30,34,38,0.75)';
        ctx.fillRect(x, 84, 2, 8);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(0, 92, w, 8);
    }

    if (variant === 'pipes') {
      // service pipes run the height of the wall, so the tile continues from storey to storey
      for (const px of [4, w - 8]) {
        ctx.fillStyle = '#8d9298';
        ctx.fillRect(px, 0, 4, h);
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.fillRect(px + 4, 0, 1, h);
        for (let y = 18; y < h - 8; y += 34) {
          ctx.fillStyle = '#6f747a';
          ctx.fillRect(px - 2, y, 8, 3);
        }
      }
      ctx.fillStyle = 'rgba(94,58,36,0.14)'; // rust bleed under the brackets
      ctx.fillRect(2, 20, 10, 70);
    }

    if (variant === 'ac') {
      // split-unit condenser bolted beside the window, with its drip stain on the plaster
      const ax = 86;
      const ay = 46;
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(ax - 1, ay - 1, 26, 20);
      ctx.fillStyle = '#d9dad4';
      ctx.fillRect(ax, ay, 24, 18);
      ctx.fillStyle = '#9aa0a6';
      for (let i = 0; i < 5; i++) ctx.fillRect(ax + 2, ay + 3 + i * 3, 20, 1);
      ctx.fillStyle = 'rgba(40,34,24,0.16)';
      ctx.fillRect(ax + 6, ay + 18, 6, 36);
    }

    if (variant === 'signband') {
      // the painted band is geometry (one storey, not every storey): here only the ghost of
      // where the old paint was stripped off
      ctx.fillStyle = 'rgba(0,0,0,0.05)';
      ctx.fillRect(10, 6, w - 20, 16);
    }
  });
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(1, 1);
  facadeTileCache.set(key, map);
  return map;
}

/**
 * Scale a box's face UVs so one tile is FACADE_TILE_W x FACADE_TILE_H metres, instead of one
 * tile per face. `phase` shifts the columns per building so no two neighbours line up.
 */
function facadeUV(geo: THREE.BufferGeometry, w: number, h: number, d: number, phase: number) {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z, four vertices each
  const spans: [number, number, number][] = [
    [d, h, phase], [d, h, phase + 0.41],
    [w, d, 0], [w, d, 0],
    [w, h, phase + 0.13], [w, h, phase + 0.13],
  ];
  for (let f = 0; f < 6; f++) {
    const [spanW, spanH, off] = spans[f];
    const su = Math.max(1, Math.round(spanW / FACADE_TILE_W));
    const sv = Math.max(1, Math.round(spanH / FACADE_TILE_H));
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setX(k, uv.getX(k) * su + off);
      uv.setY(k, uv.getY(k) * sv);
    }
  }
  uv.needsUpdate = true;
}

/** Vertex colours on a box, so every fitting in the city can share one material. */
function paintGeometry(geo: THREE.BufferGeometry, hex: number) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

/** Deterministic 0..1 from a position, so a building's phase and palette survive a reload. */
function hash01(x: number, z: number, salt = 0): number {
  const s = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

let facadeDetailMat: THREE.MeshStandardMaterial | null = null;

/** One material for every fitting in the city: the colour is per-vertex, not per-material. */
function facadeDetailMaterial(): THREE.MeshStandardMaterial {
  if (!facadeDetailMat) {
    facadeDetailMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.04 });
  }
  return facadeDetailMat;
}

/**
 * A shuffled deck of the facade variants, drawn one per building. A block gets its own deck, so
 * every block carries at least five different facades instead of one tile repeated, and two
 * buildings side by side are never the same variant until the deck runs out.
 */
function facadeDeck(): FacadeVariant[] {
  const deck = [...FACADE_VARIANTS];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function shopTexture(hue: any) {
  return canvasTexture(256, 64, (ctx, w, h) => {
    // facade base
    ctx.fillStyle = hue.wall;
    ctx.fillRect(0, 0, w, h);
    // awning stripe
    ctx.fillStyle = hue.awning;
    ctx.fillRect(0, 0, w, 12);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    for (let x = 0; x < w; x += 16) ctx.fillRect(x, 0, 8, 12);
    // shop windows
    const panes = 4;
    const pw = w / panes;
    for (let i = 0; i < panes; i++) {
      const x = i * pw + 6;
      const y = 16;
      const ww = pw - 12;
      const wh = h - y - 6;
      const g = ctx.createLinearGradient(x, y, x + ww, y + wh);
      g.addColorStop(0, 'rgba(255,226,160,0.95)');
      g.addColorStop(0.45, 'rgba(160,205,225,0.85)');
      g.addColorStop(1, 'rgba(70,95,115,0.95)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, ww, wh);
      // door frame on the second pane
      ctx.strokeStyle = 'rgba(20,22,26,0.85)';
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, ww, wh);
      if (i === 1) {
        ctx.fillStyle = 'rgba(30,34,40,0.9)';
        ctx.fillRect(x + ww * 0.3, y + wh * 0.1, ww * 0.4, wh * 0.9);
        ctx.fillStyle = 'rgba(200,220,235,0.5)';
        ctx.fillRect(x + ww * 0.33, y + wh * 0.15, ww * 0.34, wh * 0.5);
      }
    }
  });
}

const emissiveCache = new Map<string, THREE.Texture>();

function emissiveTexture(style = 'grid'): THREE.Texture {
  // One glow mask per window layout. It has to line up with the openings the diffuse tile
  // painted, otherwise a lit window at night appears on a blank patch of plaster -- which is
  // exactly what the old 4x4 random grid did.
  const hit = emissiveCache.get(style);
  if (hit) return hit;
  const tex = canvasTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const lit = (x: number, y: number, ww: number, wh: number) => {
      ctx.fillStyle = `rgba(255,${randInt(190, 236)},${randInt(120, 176)},1)`;
      ctx.fillRect(x, y, ww, wh);
    };
    if (style === 'bands') {
      if (Math.random() < 0.8) lit(14, 40, w - 28, 40);
    } else if (style === 'strips') {
      for (const x of [16, 57, 98]) if (Math.random() < 0.6) lit(x, 22, 14, 74);
    } else {
      if (Math.random() < 0.7) lit(17, 37, 36, 50);
      if (Math.random() < 0.55) lit(75, 37, 36, 50);
    }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 1);
  emissiveCache.set(style, tex);
  return tex;
}
type InstancedAdder = (
  geo: THREE.BufferGeometry,
  material: THREE.Material,
  matrices: THREE.Matrix4[],
  cast?: boolean,
  name?: string,
  audit?: boolean
) => THREE.InstancedMesh | null;

export class City {
  declare scene: any;
  declare colliders: any[];
  declare blockGroups: { x: number; z: number; group: any }[];
  declare blocks: any[];
  declare roadLines: any[];
  declare roads: { name: string; width: number; path: [number, number][] }[];
  declare jumpPads: any[];
  declare parkedSpots: any[];
  declare emissiveMats: any[];
  declare lampMats: any[];
  declare group: THREE.Group;
  declare shopTextures: THREE.Texture[];
  declare shopMats: THREE.MeshStandardMaterial[];
  declare focusTarget: THREE.Vector3;
  declare daylight: number;
  declare rootGroup: THREE.Group;
  /** shopfront rings, merged into one mesh at the end of the block pass */
  declare shopfrontGeos: THREE.BufferGeometry[];
  declare propAudit: { name: string; x: number; z: number; bottom: number }[];
  /**
   * Live ojeks, so a capture or a game system can find one without reverse-engineering a
   * propAudit slot: the group is where the mesh actually stands, and box is the delivery box's
   * local bounds (null when a bike is built without one).
   */
  declare ojeks: {
    group: THREE.Group;
    x: number;
    z: number;
    yaw: number;
    box: { center: THREE.Vector3; size: THREE.Vector3 } | null;
  }[];
  declare shopDoors: { x: number; z: number; nx: number; nz: number; kind: InteriorKind; name: string }[];
  declare interiors: PlacedInterior[];
  declare clouds: THREE.Group;
  declare starMat: THREE.PointsMaterial;
  declare lampPositions: THREE.Vector3[];
  declare lanternMats: THREE.Matrix4[];
  declare washMats: THREE.Matrix4[];
  declare lanternWireMats: THREE.Matrix4[];
  declare dayT: any;
  declare hemi: any;
  declare fill: any;
  declare sun: any;
  declare skyTop: THREE.Color;
  declare skyBottom: THREE.Color;
  declare dashMatrices: any[];
  /** [roadIndex, distanceAlongRoad] for every pedestrian crossing the network implies. */
  crossings: { road: number; u: number }[] = [];

  declare doorMatrices: THREE.Matrix4[];
  declare handleMatrices: THREE.Matrix4[];
  declare stepMatrices: { m: THREE.Matrix4; scale: number }[];
  declare shopDoorKindCursor: number;
  declare facades: { x: number; z: number; w: number; d: number; faceX: boolean; dir: number }[];
  declare dressingSpots: { type: string; x: number; z: number; yaw: number }[];
  declare treeTrunks: any[];
  declare treeCrowns: any[];
  declare lampPoles: any[];
  declare lampArms: any[];
  declare lampHeads: any[];
  declare lampLights: any[];
  declare lamplightFactor: number;
  declare stars: THREE.Points;
  declare starlightOpacity: any;
  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.colliders = [];
    this.blockGroups = [];
    this.blocks = [];
    this.roadLines = [];
    this.jumpPads = [];
    this.parkedSpots = [];
    this.emissiveMats = [];
    this.lampMats = [];
    this.group = new THREE.Group();
    scene.add(this.group);

    this.shopDoors = [];
    this.interiors = [];
    this.facades = [];
    this.dressingSpots = [];
    this.shopDoorKindCursor = randInt(0, SHOP_KINDS.length - 1);
    this.buildInteriors();
    this.dayT = 0.32; // 0..1, 0.25 = sunrise, 0.5 = noon
    this.buildLights();
    this.buildClouds();
    this.buildGround();
    this.buildSky();
    this.update(0, 0.32);
  }

  buildLights() {
    // bounce light in a Jakarta street is warm concrete, not grass: a saturated green ground
    // colour painted every underside in the city mossy, worst of all the toll deck soffit
    const hemi = new THREE.HemisphereLight(0xbfe6ff, 0x8a8377, 1.15);
    this.scene.add(hemi);
    this.hemi = hemi;

    // shadowless fill from the opposite side so shaded facades never go black
    const fill = new THREE.DirectionalLight(0xffe9cf, 0.42);
    fill.position.set(-80, 55, -60);
    this.scene.add(fill);
    this.fill = fill;

    const sun = new THREE.DirectionalLight(0xfff0d0, 2.1);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 260;
    sun.shadow.camera.left = -62;
    sun.shadow.camera.right = 62;
    sun.shadow.camera.top = 62;
    sun.shadow.camera.bottom = -62;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;
  }

  buildInteriors() {
    SHOP_KINDS.forEach((kind, i) => {
      const room = buildInterior(kind);
      const origin = new THREE.Vector3(600 + i * 60, 0, 0);
      room.group.position.copy(origin);
      room.group.visible = false; // only rendered while the player is inside
      this.scene.add(room.group);
      // world-space colliders (walls + furniture) so the player and camera stay inside
      const hw = (room.bounds.maxX - room.bounds.minX) / 2;
      const hd = (room.bounds.maxZ - room.bounds.minZ) / 2;
      const wallH = room.bounds.h ?? 3.4;
      const walls: AABB[] = [
        { minX: -hw - 0.4, maxX: hw + 0.4, minZ: -hd - 0.4, maxZ: -hd, h: wallH },
        { minX: -hw - 0.4, maxX: -hw, minZ: -hd, maxZ: hd, h: wallH },
        { minX: hw, maxX: hw + 0.4, minZ: -hd, maxZ: hd, h: wallH },
      ];
      const local = [...room.colliders, ...walls];
      room.colliders = local.map((c) => ({
        minX: c.minX + origin.x,
        maxX: c.maxX + origin.x,
        minZ: c.minZ + origin.z,
        maxZ: c.maxZ + origin.z,
        h: c.h,
      }));
      this.interiors.push({ ...room, origin });
    });
  }

  roomFor(kind: InteriorKind) {
    return this.interiors.find((r) => r.kind === kind);
  }

  /**
   * Merge the collected ground-floor plinths into one mesh per texture variant. Called once,
   * after every block and frontage row has been laid out.
   */
  /**
   * Clear the spawn square of street furniture, whoever placed it.
   *
   * Props come from half a dozen paths -- becak, benches, crates, ojek ranks, carts, parking --
   * and each was allowed to ignore where the player starts. Every guard added so far fixed one
   * path and left the others, so the player kept starting with a gerobak or a becak inside him.
   * This sweeps once, at the end, over small ground-level objects near the spawn point.
   */
  finalizeSpawnClearance() {
    const sp = this.getSpawn();
    const doomed: THREE.Object3D[] = [];
    const box = new THREE.Box3();
    for (const child of this.group.children) {
      if ((child as any).isLight) continue;
      box.setFromObject(child);
      const size = box.getSize(new THREE.Vector3());
      if (size.y > 4 || Math.max(size.x, size.z) > 6) continue;      // buildings and decks stay
      const c = box.getCenter(new THREE.Vector3());
      if (Math.hypot(c.x - sp.x, c.z - sp.z) > 7) continue;
      doomed.push(child);
    }
    for (const o of doomed) o.removeFromParent();
    // and the colliders that belonged to them
    this.colliders = this.colliders.filter((c) => {
      const cx = (c.minX + c.maxX) / 2, cz = (c.minZ + c.maxZ) / 2;
      const w = c.maxX - c.minX, d = c.maxZ - c.minZ;
      if (Math.max(w, d) > 8 || c.h > 4) return true;                 // buildings stay
      return Math.hypot(cx - sp.x, cz - sp.z) > 7;
    });
  }

  /** Merge every collected building body into one mesh per material, per block group. */
  finalizeBuildings() {
    for (const { mat, geos } of this.frontageBuckets.values()) {
      if (!geos.length) continue;
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      for (const g of geos) g.dispose();
    }
    this.frontageBuckets.clear();

    for (const [group, bucket] of this.buildingBuckets) {
      for (const { mat, geos } of bucket.values()) {
        if (!geos.length) continue;
        const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
        if (!merged) continue;
        const mesh = new THREE.Mesh(merged, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
        for (const g of geos) g.dispose();
      }
    }
    this.buildingBuckets.clear();

    // One mesh per block for every cornice, ledge, rail, pipe and AC box in it. The material is
    // a single shared instance and the colours ride on the vertices, so this is one draw call
    // for the fittings of a whole city block.
    for (const [group, geos] of this.detailBuckets) {
      if (!geos.length) continue;
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, facadeDetailMaterial());
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      for (const g of geos) g.dispose();
    }
    this.detailBuckets.clear();
  }

  finalizePlinths() {
    for (let v = 0; v < this.plinthGeos.length; v++) {
      const list = this.plinthGeos[v];
      if (!list.length) continue;
      const merged = mergeGeometries(list, false);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, shopfrontMat(v));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      for (const g of list) g.dispose();
      list.length = 0;
    }
  }

  buildClouds() {
    const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92, fog: false, depthWrite: false });
    this.clouds = new THREE.Group();
    for (let i = 0; i < 18; i++) {
      const cluster = new THREE.Group();
      const puffs = 3 + Math.floor(rand(0, 3));
      for (let k = 0; k < puffs; k++) {
        const r = rand(6, 11);
        const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), cloudMat);
        puff.position.set(k * rand(6, 10) - puffs * 3.5, rand(-1.5, 1.5), rand(-3, 3));
        puff.scale.y = rand(0.45, 0.65);
        cluster.add(puff);
      }
      const ang = rand(0, Math.PI * 2);
      const rad = rand(95, 210);
      cluster.position.set(Math.cos(ang) * rad, rand(48, 78), Math.sin(ang) * rad);
      cluster.rotation.y = rand(0, Math.PI);
      this.clouds.add(cluster);
    }
    this.scene.add(this.clouds);
  }

  buildSky() {
    this.skyTop = new THREE.Color();
    this.skyBottom = new THREE.Color();
    this.scene.background = new THREE.Color(0x35a8f0);
    this.scene.fog = new THREE.Fog(0x35a8f0, 130, 360);
  }

  buildGround() {
    // asphalt base
    const asphaltTex = canvasTexture(256, 256, (ctx, w, h) => {
      ctx.fillStyle = '#8a84a2';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 2600; i++) {
        const v = rand(0.75, 1.15);
        ctx.fillStyle = `rgba(${Math.round(120 * v)},${Math.round(114 * v)},${Math.round(140 * v)},0.5)`;
        ctx.fillRect(rand(0, w), rand(0, h), rand(1, 3), rand(1, 3));
      }
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = 'rgba(90,86,110,0.32)';
        ctx.beginPath();
        ctx.ellipse(rand(0, w), rand(0, h), rand(12, 42), rand(8, 26), rand(0, 3), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(70,66,88,0.45)';
      ctx.lineWidth = 1.4;
      for (let i = 0; i < 8; i++) {
        ctx.beginPath();
        let x = rand(0, w);
        let y = rand(0, h);
        ctx.moveTo(x, y);
        for (let k = 0; k < 4; k++) {
          x += rand(-26, 26);
          y += rand(-26, 26);
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    });
    asphaltTex.wrapS = asphaltTex.wrapT = THREE.RepeatWrapping;
    asphaltTex.repeat.set(70, 70);
    const asphalt = new THREE.MeshStandardMaterial({ map: asphaltTex, roughness: 0.96 });
    // The plane is the *pavement*, not the road: asphalt is drawn on top as a ribbon with the
    // real width of each road, so the strip between the kerb and the asphalt reads as sidewalk
    // instead of one 30 m sheet of tarmac.
    const concreteTex = canvasTexture(256, 256, (ctx, w, h) => {
      ctx.fillStyle = '#b7b2a8';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 900; i++) {
        const g = Math.round(176 + Math.random() * 26);
        ctx.fillStyle = `rgba(${g},${g - 3},${g - 9},0.5)`;
        ctx.fillRect(Math.random() * w, Math.random() * h, 2 + Math.random() * 3, 1 + Math.random() * 2);
      }
    });
    concreteTex.wrapS = concreteTex.wrapT = THREE.RepeatWrapping;
    concreteTex.repeat.set(90, 90);
    const pavement = new THREE.MeshStandardMaterial({ map: concreteTex, roughness: 0.97 });
    const groundGeo = new THREE.PlaneGeometry(WORLD_HALF * 2 + 900, WORLD_HALF * 2 + 900, 190, 190);
    groundGeo.rotateX(-Math.PI / 2);
    {
      // displace the plane with the terrain function: the shore, the canal banks and the
      // southern rise all come from src/world/terrain.ts, the same function physics uses
      const pos = groundGeo.attributes.position as any;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        pos.setY(i, terrainHeight(x, z));
      }
      groundGeo.computeVertexNormals();
    }
    const ground = new THREE.Mesh(groundGeo, pavement);
    // geometry was rotated and displaced already; rotating the mesh again stood the city on
    // its edge and left the sky showing where the ground should be
    ground.receiveShadow = true;
    this.group.add(ground);

    // sidewalk plates + block contents
    const pavingTex = canvasTexture(128, 128, (ctx, w, h) => {
      ctx.fillStyle = '#cbcbd4';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(150,150,164,0.7)';
      ctx.lineWidth = 2;
      for (let x = 0; x <= w; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
      for (let y = 0; y <= h; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
      for (let i = 0; i < 320; i++) {
        ctx.fillStyle = `rgba(120,120,134,${rand(0.03, 0.08)})`;
        ctx.fillRect(rand(0, w), rand(0, h), rand(1, 4), rand(1, 4));
      }
    });
    pavingTex.wrapS = pavingTex.wrapT = THREE.RepeatWrapping;
    pavingTex.repeat.set(BLOCK / 4, BLOCK / 4);
    const sidewalkMat = new THREE.MeshStandardMaterial({ map: pavingTex, roughness: 0.9 });
    const curbMat = new THREE.MeshStandardMaterial({ color: 0xb4b4be, roughness: 0.9 });
    const parkMat = new THREE.MeshStandardMaterial({ color: 0x37c24a, roughness: 1 });
    const lotMat = new THREE.MeshStandardMaterial({ color: 0x9a94b0, roughness: 0.95 });

    const dashMat = new THREE.MeshStandardMaterial({ color: 0xf7f5e8, roughness: 0.6 });
    const dashGeo = new THREE.BoxGeometry(0.42, 0.02, 2.6);
    this.dashMatrices = [];
    this.crossings = [];
    this.doorMatrices = [];
    this.handleMatrices = [];
    this.stepMatrices = [];
    this.treeTrunks = [];
    this.treeCrowns = [];
    this.lampPoles = [];
    this.lampPositions = [];
    this.lampArms = [];
    this.lampHeads = [];
    this.lanternMats = [];
    this.washMats = [];
    this.lanternWireMats = [];

    // Blocks follow the road network from the Jakarta map instead of a lattice: candidate
    // sites are generated on a coarse scatter, then rejected if they land in the bay, on a
    // river, in a road corridor or on top of a landmark.
    const sites = this.planBlockSites();
    const blockLayer = this.group;
    this.rootGroup = this.group;
    for (const site of sites) {
      const { x: cx, z: cz, size } = site;
      const district = districtAtPoint(cx, cz);
      // One group per block: a 2.5 km city cannot draw every block, so each block toggles by
      // distance (see updateCulling). Everything the block owns goes into its own group.
      const blockGroup = new THREE.Group();
      blockGroup.position.y = terrainHeight(cx, cz);
      blockLayer.add(blockGroup);
      this.group = blockGroup;
      this.blockGroups.push({ x: cx, z: cz, group: blockGroup });
      const isPark = Math.random() < 0.13;
      const isLot = !isPark && Math.random() < 0.18;

      const plate = new THREE.Mesh(new THREE.BoxGeometry(size, 0.26, size), sidewalkMat);
      plate.position.set(cx, 0.13, cz);
      plate.receiveShadow = true;
      this.group.add(plate);

      const curb = new THREE.Mesh(new THREE.BoxGeometry(size + 0.9, 0.16, size + 0.9), curbMat);
      curb.position.set(cx, 0.08, cz);
      curb.receiveShadow = true;
      this.group.add(curb);

      if (isPark) {
        const lawn = new THREE.Mesh(new THREE.BoxGeometry(size - 6, 0.12, size - 6), parkMat);
        lawn.position.set(cx, 0.28, cz);
        lawn.receiveShadow = true;
        this.group.add(lawn);
        this.decoratePark(cx, cz);
        this.blocks.push({ x: cx, z: cz, type: 'park', size });
      } else if (isLot) {
        const lot = new THREE.Mesh(new THREE.BoxGeometry(size - 6, 0.1, size - 6), lotMat);
        lot.position.set(cx, 0.28, cz);
        lot.receiveShadow = true;
        this.group.add(lot);
        this.decorateLot(cx, cz);
        this.blocks.push({ x: cx, z: cz, type: 'lot', size });
      } else {
        this.buildBuildings(cx, cz, size, district);
        this.blocks.push({ x: cx, z: cz, type: 'city', size });
      }

      this.decorateBlockEdge(cx, cz);
      this.collectDistrictProps(district, cx, cz);
      this.group = blockLayer;
    }

    // Landmarks sit exactly where the map puts them
    for (const lm of LANDMARKS) {
      if (!this.propAudit) this.propAudit = [];
      // landmarks are modelled on a flat origin, so they get a parent lifted to their ground
      const lmGroup = new THREE.Group();
      lmGroup.position.y = terrainHeight(lm.x, lm.z);
      this.group.add(lmGroup);
      const ctx = { group: lmGroup, colliders: this.colliders, audit: this.propAudit, groundHeightAt: (x: number, z: number) => this.groundHeightAt(x, z) };
      if (lm.id === 'monas') buildMonas(ctx, lm.x, lm.z);
      else if (lm.id === 'bundaran-hi') buildBundaran(ctx, lm.x, lm.z);
      else if (lm.id === 'stadhuis') buildKotaTua(ctx, lm.x, lm.z);
      else if (lm.id === 'glodok-gate') buildGlodokGate(ctx, lm.x, lm.z);
      else if (lm.id === 'ancol-beach') buildAncolShore(ctx, lm.x, lm.z, 40);
      this.blocks.push({ x: lm.x, z: lm.z, type: 'landmark', landmark: lm.id, size: 40 });
    }

    this.buildFrontage();
    this.buildStreetKitCorner();
    this.buildTerrainFeatures();
    this.buildRoadRibbons();
    this.buildWater();
    this.buildDistrictProps();
    this.buildStreetLife();
    this.buildOjekBases();
    this.buildLayangRoad();
    this.buildMrt();
    this.buildKrlLine();

    // road markings (instanced): dashed centre lines along the roads the map defines
    const mtx = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const dashRoads = [...ARTERIALS.map((a) => ({ pts: a.path, width: a.width })), { pts: RING_ROAD, width: 20 }];
    for (const road of dashRoads) {
      for (let i = 0; i < road.pts.length - 1; i++) {
        const [x1, z1] = road.pts[i];
        const [x2, z2] = road.pts[i + 1];
        const len = Math.hypot(x2 - x1, z2 - z1);
        const yaw = Math.atan2(x2 - x1, z2 - z1);
        const steps = Math.floor(len / 9);
        for (let k = 0; k < steps; k++) {
          const t = (k + 0.5) / steps;
          const x = x1 + (x2 - x1) * t;
          const z = z1 + (z2 - z1) * t;
          q.setFromAxisAngle(up, yaw);
          this.dashMatrices.push(new THREE.Matrix4().compose(new THREE.Vector3(x, terrainHeight(x, z) + 0.056, z), q, new THREE.Vector3(1, 1, 1)));
        }
      }
    }
    const dashMesh = new THREE.InstancedMesh(dashGeo, dashMat, this.dashMatrices.length);
    this.dashMatrices.forEach((m, i) => dashMesh.setMatrixAt(i, m));
    dashMesh.instanceMatrix.needsUpdate = true;
    dashMesh.receiveShadow = true;
    dashMesh.frustumCulled = false;
    this.group.add(dashMesh);

    // Crossings are built from the road network in buildRoadRibbons(); the old stripes here were
    // instanced on the (i+0.5)*PITCH block lattice at y=0.03, which is inside blocks now that
    // districts are polygons, and under the carriageway even where it was on a road.

    this.buildEntranceInstances();
    this.buildLampInstances();
    this.buildTreeInstances();
    this.buildNightLights();
    this.finalizeBuildings();
    this.finalizePlinths();
    this.finalizeSpawnClearance();
  }

  buildNightLights() {
    // four point lights get parked on the nearest street lamps each frame
    this.lampLights = [];
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffc98a, 0, 26, 2);
      l.position.set(0, 5, 0);
      this.scene.add(l);
      this.lampLights.push(l);
    }
    this.lamplightFactor = 0;

    // star dome
    const starGeo = new THREE.BufferGeometry();
    const pts = [];
    for (let i = 0; i < 700; i++) {
      const theta = rand(0, Math.PI * 2);
      const phi = rand(0.05, Math.PI * 0.48);
      const r = 500;
      pts.push(Math.cos(theta) * Math.cos(phi) * r, Math.sin(phi) * r + 40, Math.sin(theta) * Math.cos(phi) * r);
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.starMat = new THREE.PointsMaterial({ color: 0xdfe8ff, size: 2.2, transparent: true, opacity: 0, depthWrite: false });
    this.stars = new THREE.Points(starGeo, this.starMat);
    this.scene.add(this.stars);
  }

  updateNightLights(dayT: any, focus: any) {
    const night = 1 - clamp((this.daylight - 0.05) / 0.4, 0, 1);
    this.starlightOpacity = night;
    this.starMat.opacity = night * 0.9;
    this.stars.rotation.y = dayT * Math.PI * 2;
    if (this.clouds) {
      this.clouds.rotation.y = dayT * Math.PI * 0.6;
      this.clouds.visible = this.daylight > 0.18;
    }

    // pick the 4 lamps closest to the action
    const sorted = this.lampPositions
      .map((p) => ({ p, d: (p.x - focus.x) ** 2 + (p.z - focus.z) ** 2 }))
      .sort((a, b) => a.d - b.d);
    for (let i = 0; i < this.lampLights.length; i++) {
      const l = this.lampLights[i];
      const entry = sorted[i];
      if (entry) {
        l.position.copy(entry.p);
        l.position.y = 4.6;
        l.intensity = night * 55;
      } else {
        l.intensity = 0;
      }
    }
  }

  buildTreeInstances() {
    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 3.6, 6);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4f34, roughness: 1 });
    const crownGeo = new THREE.IcosahedronGeometry(1.45, 0);
    const crownMat = new THREE.MeshStandardMaterial({ color: 0x2bae4a, roughness: 1, flatShading: true });

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, this.treeTrunks.length);
    this.treeTrunks.forEach((m, i) => trunks.setMatrixAt(i, m));
    trunks.instanceMatrix.needsUpdate = true;
    trunks.castShadow = true;
    trunks.frustumCulled = false;
    this.group.add(trunks);

    const crowns = new THREE.InstancedMesh(crownGeo, crownMat, this.treeCrowns.length);
    this.treeCrowns.forEach((m, i) => crowns.setMatrixAt(i, m));
    crowns.instanceMatrix.needsUpdate = true;
    crowns.castShadow = true;
    crowns.frustumCulled = false;
    this.group.add(crowns);
  }

  buildEntranceInstances() {
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x2b3a4a, roughness: 0.5, metalness: 0.2 });
    const chromeMat = new THREE.MeshStandardMaterial({ color: 0xc9ccd2, roughness: 0.35, metalness: 0.7 });
    const stepMat = new THREE.MeshStandardMaterial({ color: 0xbfbfc8, roughness: 0.9 });

    const doors = new THREE.InstancedMesh(new THREE.BoxGeometry(1.35, 2.3, 0.12), doorMat, this.doorMatrices.length);
    this.doorMatrices.forEach((m, i) => doors.setMatrixAt(i, m));
    doors.instanceMatrix.needsUpdate = true;
    doors.frustumCulled = false;
    this.group.add(doors);

    const handles = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 0.3, 0.08), chromeMat, this.handleMatrices.length);
    this.handleMatrices.forEach((m, i) => handles.setMatrixAt(i, m));
    handles.instanceMatrix.needsUpdate = true;
    handles.frustumCulled = false;
    this.group.add(handles);

    // steps differ in width, so one instanced mesh per row
    for (const row of [0, 1]) {
      const items = this.stepMatrices.filter((_, i) => i % 2 === row);
      if (!items.length) continue;
      const geo = new THREE.BoxGeometry(items[0].scale, 0.13, 0.5);
      const mesh = new THREE.InstancedMesh(geo, stepMat, items.length);
      items.forEach((it, i) => mesh.setMatrixAt(i, it.m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
  }

  /** Street dressing that makes a district legible at ground level, batched into one mesh
   *  per prop type so the draw-call budget survives it. */
  collectDistrictProps(id: string, cx: number, cz: number) {
    const m = new THREE.Matrix4();
    const half = BLOCK / 2 - 1.2;
    if (id === 'glodok') {
      // red lanterns strung along the shopfronts of the Chinese quarter
      for (let i = 0; i < 5; i++) {
        const x = cx - half + (i / 4) * (half * 2);
        const z = cz - half - 0.6;
        this.lanternMats.push(m.clone().makeTranslation(x, 4.1 + rand(-0.1, 0.1), z));
        this.lanternMats.push(m.clone().makeTranslation(cx + half + 0.6, 4.1, cz - half + (i / 4) * (half * 2)));
      }
      // the cord they hang from, so they read as strung lanterns and not floating boxes
      this.lanternWireMats.push(m.clone().makeTranslation(cx, 4.4, cz - half - 0.6));
      const rot = new THREE.Matrix4().makeRotationY(Math.PI / 2);
      this.lanternWireMats.push(new THREE.Matrix4().makeTranslation(cx + half + 0.6, 4.4, cz).multiply(rot));
    } else if (id === 'kampung') {
      // laundry lines between the tight houses
      for (let i = 0; i < 2; i++) {
        const z = cz + (i ? half + 0.9 : -half - 0.9);
        this.washMats.push(m.clone().makeTranslation(cx, 3.1 + i * 0.2, z));
      }
    }
  }


  /**
   * TransJakarta haltes, where the map says they are: on the verge of the arterial they serve,
   * parallel to it, roof over the platform and the tactile edge facing the carriageway.
   */
  buildHaltes() {
    let buses = 0;
    for (const poi of POIS) {
      if (poi.kind !== 'halte') continue;
      let best = { d: Infinity, yaw: 0, nx: 0, nz: 1, half: 10 };
      for (const a of ARTERIALS) {
        for (let i = 0; i < a.path.length - 1; i++) {
          const [x1, z1] = a.path[i];
          const [x2, z2] = a.path[i + 1];
          const dx = x2 - x1;
          const dz = z2 - z1;
          const len2 = dx * dx + dz * dz || 1;
          const t = clamp(((poi.x - x1) * dx + (poi.z - z1) * dz) / len2, 0, 1);
          const cx = x1 + dx * t;
          const cz = z1 + dz * t;
          const d = Math.hypot(poi.x - cx, poi.z - cz);
          if (d < best.d) {
            const len = Math.sqrt(len2) || 1;
            best = { d, yaw: Math.atan2(dx, dz), nx: -dz / len, nz: dx / len, half: a.width / 2 };
          }
        }
      }
      if (best.d > 90) continue;
      // stand it on the verge on the far side of the kerb, never in a traffic lane
      const off = best.half + 3.4;
      const px = poi.x + best.nx * off;
      const pz = poi.z + best.nz * off;
      const g = buildHalte({ group: this.group, colliders: this.colliders, audit: this.propAudit }, px, pz, best.yaw);
      g.position.y = terrainHeight(px, pz);
    }
  }


  /**
   * Ojek pangkalan: the row of motorbikes waiting for a fare on the kerb. Two per stop, angled
   * to the street, only at the POIs the map marks as passenger/food places, because a bike is
   * 11 draw calls and the frame has a budget to hold.
   */

  /**
   * Put something on the pavement instead of on a map coordinate.
   *
   * Every POI in the map is a point on a district, not a kerbside slot, which is why the first
   * halte and the first row of ojeks ended up inside a frontage wall. This projects the point
   * onto the nearest arterial, walks out to the middle of that road's pavement, and picks the
   * side that is actually free.
   */
  /** the player's start, cached so street furniture can keep out of it */
  spawnCache: { x: number; z: number } | null = null;

  /** true when a proposed prop slot would land on the player's spawn */
  tooCloseToSpawn(x: number, z: number, pad = 6): boolean {
    if (!this.spawnCache) this.spawnCache = this.getSpawn();
    return Math.hypot(x - this.spawnCache.x, z - this.spawnCache.z) < pad;
  }

  /**
   * Push a point out of every carriageway.
   *
   * Hero assets were placed relative to getSpawn(), and the spawn sits on the arterial
   * centreline, so six of them ended up standing in the road. This projects the point onto the
   * nearest road and moves it to the far side of the kerb, which is where a building belongs.
   */
  pushOffRoad(x: number, z: number, extra: number): { x: number; z: number } {
    let px = x, pz = z;
    for (let pass = 0; pass < 6; pass++) {
      const moved = this.pushOffRoadOnce(px, pz, extra);
      if (moved.x === px && moved.z === pz) return { x: px, z: pz };
      px = moved.x; pz = moved.z;
    }
    return { x: px, z: pz };
  }

  private pushOffRoadOnce(x: number, z: number, extra: number): { x: number; z: number } {
    const roads: { path: [number, number][]; half: number }[] = [
      ...ARTERIALS.map((a) => ({ path: a.path as [number, number][], half: a.width / 2 })),
      { path: RING_ROAD as [number, number][], half: 10 },
      ...LOCAL_STREETS.map((l) => ({ path: l.path as [number, number][], half: l.width / 2 })),
    ];
    for (const { path, half } of roads) {
      for (let i = 1; i < path.length; i++) {
        const [x1, z1] = path[i - 1];
        const [x2, z2] = path[i];
        const dx = x2 - x1, dz = z2 - z1;
        const len = Math.hypot(dx, dz) || 1;
        let t = ((x - x1) * dx + (z - z1) * dz) / (len * len);
        t = Math.max(0, Math.min(1, t));
        const px = x1 + dx * t, pz = z1 + dz * t;
        const dist = Math.hypot(x - px, z - pz);
        const need = half + extra;
        if (dist < need) {
          const nx = (x - px) / (dist || 1);
          const nz = (z - pz) / (dist || 1);
          return { x: px + nx * need, z: pz + nz * need };
        }
      }
    }
    return { x, z };
  }

  snapToVerge(x: number, z: number): { x: number; z: number; yaw: number } | null {
    let best: { d: number; cx: number; cz: number; nx: number; nz: number; yaw: number; half: number } | null = null;
    for (const a of [...ARTERIALS, { path: RING_ROAD, width: 20 } as any]) {
      const pts = a.path as [number, number][];
      for (let i = 0; i < pts.length - 1; i++) {
        const [x1, z1] = pts[i];
        const [x2, z2] = pts[i + 1];
        const dx = x2 - x1;
        const dz = z2 - z1;
        const len2 = dx * dx + dz * dz || 1;
        const t = clamp(((x - x1) * dx + (z - z1) * dz) / len2, 0, 1);
        const cx = x1 + dx * t;
        const cz = z1 + dz * t;
        const d = Math.hypot(x - cx, z - cz);
        if (!best || d < best.d) {
          const len = Math.sqrt(len2) || 1;
          best = { d, cx, cz, nx: -dz / len, nz: dx / len, yaw: Math.atan2(dx, dz), half: a.width / 2 };
        }
      }
    }
    if (!best) return null;
    const off = best.half + 1.9 + 1.6;          // middle of the 3.6 m pavement
    const free = (px: number, pz: number) =>
      this.colliders.every((c) => px < c.minX - 1.2 || px > c.maxX + 1.2 || pz < c.minZ - 1.2 || pz > c.maxZ + 1.2);
    // walk along the kerb as well as across it: one POI can land where a shopfront juts out, and
    // the slot two doors down is still on the same pavement
    const dirX = best.nz;
    const dirZ = -best.nx;
    for (const along of [0, 12, -12, 24, -24, 36, -36, 48, -48]) {
      for (const side of [1, -1]) {
        const px = best.cx + dirX * along + best.nx * off * side;
        const pz = best.cz + dirZ * along + best.nz * off * side;
        if (free(px, pz) && !isWater(px, pz)) return { x: px, z: pz, yaw: best.yaw };
      }
    }
    return null;
  }

  /** Haltes, food carts, the nutrition kitchen and the village cooperative, all kerbside. */

  /** Place a street item on the ground and make its audit entry say the same height. */
  private placeOnGround(g: THREE.Object3D, x: number, z: number) {
    const y = this.groundHeightAt(x, z);
    g.position.y = y;
    const last = this.propAudit[this.propAudit.length - 1];
    if (last) last.bottom = y;
  }

  buildStreetLife() {
    const ctx = { group: this.group, colliders: this.colliders, audit: this.propAudit };
    let buses = 0;

    for (const poi of POIS) {
      if (poi.kind !== 'halte') continue;
      const spot = this.snapToVerge(poi.x, poi.z);
      if (!spot) continue;
      const g = buildHalte(ctx, spot.x, spot.z, spot.yaw);
      this.placeOnGround(g, spot.x, spot.z);
      // a bus berthed beside the first two haltes, so the street shows the busway running
      if (buses < 2) {
        const bus = new TransjakartaBus({ simple: false });
        const bx = spot.x - Math.sin(spot.yaw + Math.PI / 2) * 3.4;
        const bz = spot.z - Math.cos(spot.yaw + Math.PI / 2) * 3.4;
        bus.group.rotation.y = spot.yaw;
        this.group.add(bus.group);
        this.propAudit.push({ name: 'transjakarta', x: bx, z: bz, bottom: 0 });
        this.placeOnGround(bus.group, bx, bz);
        this.colliders.push({ minX: bx - 1.4, maxX: bx + 1.4, minZ: bz - 9, maxZ: bz + 9, h: 3.2 });
        buses++;
      }
    }

    const carts: KakiLimaKind[] = ['bakso', 'nasgor', 'sate'];
    let placedCarts = 0;
    for (const poi of POIS) {
      if (poi.kind !== 'kaki5') continue;
      for (let i = 0; i < 3 && placedCarts < 6; i++) {
        const spot = this.snapToVerge(poi.x + (i - 1) * 9, poi.z + (i - 1) * 4);
        if (!spot) continue;
        const g = buildKakiLima(ctx, carts[placedCarts % carts.length], spot.x, spot.z, spot.yaw + Math.PI / 2);
        this.placeOnGround(g, spot.x, spot.z);
        placedCarts++;
      }
    }

    // the two institutions: a nutrition kitchen by the Blok M terminal, a koperasi in Kemang
    const blokM = POIS.find((p) => p.name.startsWith('Terminal Blok M'));
    if (blokM) {
      const spot = this.snapToVerge(blokM.x, blokM.z + 26);
      if (spot) {
        // the kitchen stands 4 m off its slot, so it has to be seated on the ground under that
        // spot: sampling at the slot left a 26 cm gap to the pavement it actually stands on
        const g = buildSppg(ctx, spot.x + 4, spot.z, spot.yaw);
        this.placeOnGround(g, spot.x + 4, spot.z);
      }
    }
    // One minimarket on a fixed, verifiable site: 22 m up the spawn street, facing back at the
    // player. Automatic placement put this asset in the wrong place five times, so the first one
    // is placed by hand and photographed before anything else uses snapToVerge.
    const sp = this.getSpawn();
    const mmSpot = this.pushOffRoad(sp.x, sp.z + 22, 3.6 + 5.5);
    const mg = buildMinimarket(ctx, mmSpot.x, mmSpot.z, Math.PI, 'INDOMERET');
    this.placeOnGround(mg, mmSpot.x, mmSpot.z);
    // police post beside the minimarket, on the first slot that clears every collider
    for (const [dx, dz] of [[13, 0], [17, 0], [21, 0], [-13, 0], [-17, 0], [13, 12], [13, -12], [0, 16]]) {
      const raw = { x: sp.x + dx, z: sp.z + 22 + dz };
      const spot = this.pushOffRoad(raw.x, raw.z, 3.6 + 4);
      const cx = spot.x, cz = spot.z;
      if (this.nearLayang(cx, cz, 14)) continue;
      if (this.colliders.some((c) => cx > c.minX - 8 && cx < c.maxX + 8 && cz > c.minZ - 8 && cz < c.maxZ + 8)) continue;
      const pg = buildPosPolisi(ctx, cx, cz, 0);
      this.placeOnGround(pg, cx, cz);
      break;
    }
    // pos ronda: small, repeated three times, on the first clear verge slots found
    {
      let placed = 0;
      for (const r of [18, 26, 34, 44, 56, 70, 86, 104]) {
        for (let a = 0; a < 12 && placed < 3; a++) {
          const t = (a / 12) * Math.PI * 2 + placed;
          const raw = { x: sp.x + Math.cos(t) * r, z: sp.z + 22 + Math.sin(t) * r };
          const spot = this.pushOffRoad(raw.x, raw.z, 3.6 + 5);
          const cx = spot.x, cz = spot.z;
          if (this.nearLayang(cx, cz, 8)) continue;
          if (this.colliders.some((c) => cx > c.minX - 5 && cx < c.maxX + 5 && cz > c.minZ - 5 && cz < c.maxZ + 5)) continue;
          const rg = buildRonda(ctx, cx, cz, Math.atan2(sp.x - cx, sp.z - cz));
          this.placeOnGround(rg, cx, cz);
          placed++;
        }
        if (placed >= 3) break;
      }
    }

    // pasar daerah, on a wide clear lot a little further out than the mosque
    for (const r of [46, 58, 72, 88, 104, 120]) {
      let placed = false;
      for (let a = 0; a < 18; a++) {
        const t = (a / 18) * Math.PI * 2;
        const raw = { x: sp.x + Math.cos(t) * r, z: sp.z + 22 + Math.sin(t) * r };
      const spot = this.pushOffRoad(raw.x, raw.z, 3.6 + 10);
      const cx = spot.x, cz = spot.z;
        if (this.nearLayang(cx, cz, 26)) continue;
        if (this.mrtSpine.some((pt) => Math.hypot(pt[0] - cx, pt[1] - cz) < 30)) continue;
        // it is 28 x 20 m: it needs more room than the shops
        if (this.colliders.some((c) => cx > c.minX - 17 && cx < c.maxX + 17 && cz > c.minZ - 17 && cz < c.maxZ + 17)) continue;
        const pg = buildPasar(ctx, cx, cz, Math.atan2(sp.x - cx, sp.z - cz));
        this.placeOnGround(pg, cx, cz);
        placed = true;
        break;
      }
      if (placed) break;
    }

    // terminal bus: 48 x 32 m of apron, canopy and bays needs a lot nothing else wants. The two
    // elevated spines are only assigned by buildLayangRoad/buildMrt, which run *after* this pass,
    // so clearance is measured against the same map paths those builders use -- nearLayang() and
    // mrtSpine[] are still empty here and would pass every candidate (a check that cannot fail is
    // not a clearance). 26 m from the layang deck, 30 m from the metro guideway, 17 m from every
    // collider, and the exact footprint must clear every building rectangle.
    {
      const tollPath = ARTERIALS[0].path as [number, number][];
      const metroPath = ARTERIALS[1].path as [number, number][];
      const metroOffset = (ARTERIALS[1].width ?? 20) / 2 + 5.5;   // guideway runs beside the artery
      const TW = 48, TD = 32;
      for (const r of [58, 72, 88, 106, 124, 144]) {
        let done = false;
        for (let a = 0; a < 24 && !done; a++) {
          const t = (a / 24) * Math.PI * 2 + 0.13;
          const cx = sp.x + Math.cos(t) * r, cz = sp.z + 22 + Math.sin(t) * r;
          if (this.distToPath(cx, cz, tollPath) < 26) continue;
          if (this.distToPath(cx, cz, metroPath) < 30 + metroOffset) continue;
          if (this.onRoad(cx, cz, 8) || isWater(cx, cz)) continue;
          if (this.colliders.some((c) => cx > c.minX - 17 && cx < c.maxX + 17 && cz > c.minZ - 17 && cz < c.maxZ + 17)) continue;
          const yaw = Math.atan2(sp.x - cx, sp.z - cz);
          const halfX = Math.abs(Math.cos(yaw)) * (TW / 2) + Math.abs(Math.sin(yaw)) * (TD / 2);
          const halfZ = Math.abs(Math.sin(yaw)) * (TW / 2) + Math.abs(Math.cos(yaw)) * (TD / 2);
          // the apron is flat and cannot follow a hill: four corner samples have to agree
          const corners = [[cx - halfX, cz - halfZ], [cx + halfX, cz - halfZ], [cx - halfX, cz + halfZ], [cx + halfX, cz + halfZ]]
            .map(([qx, qz]) => this.groundHeightAt(qx, qz));
          if (Math.max(...corners) - Math.min(...corners) > 0.6) continue;
          const foot = { minX: cx - halfX, maxX: cx + halfX, minZ: cz - halfZ, maxZ: cz + halfZ };
          if (this.footprints.some((f) => foot.minX < f.maxX && foot.maxX > f.minX && foot.minZ < f.maxZ && foot.maxZ > f.minZ)) continue;
          // the block-edge tree pass ran before this one, so trunks already stand on most verges.
          // A tree in the middle of the apron is the one thing a reserved lot cannot have.
          if (this.treeTrunks.some((m: THREE.Matrix4) => {
            const tx = m.elements[12], tz = m.elements[14];
            return tx > foot.minX && tx < foot.maxX && tz > foot.minZ && tz < foot.maxZ;
          })) continue;
          const tg = buildTerminal(ctx, cx, cz, yaw);
          this.placeOnGround(tg, cx, cz);
          // reserve the lot, so nothing built later can stand on the apron
          this.footprints.push(foot);
          done = true;
        }
        if (done) break;
      }
    }

    // masjid kampung, on the widest clear slot near the spawn
    for (const r of [30, 40, 52, 64, 78, 92]) {
      let placed = false;
      for (let a = 0; a < 16; a++) {
        const t = (a / 16) * Math.PI * 2;
        const raw = { x: sp.x + Math.cos(t) * r, z: sp.z + 22 + Math.sin(t) * r };
        const spot = this.pushOffRoad(raw.x, raw.z, 3.6 + 8);
        const cx = spot.x, cz = spot.z;
        if (this.nearLayang(cx, cz, 24)) continue;
        if (this.mrtSpine.some((pt) => Math.hypot(pt[0] - cx, pt[1] - cz) < 26)) continue;
        if (this.colliders.some((c) => cx > c.minX - 11 && cx < c.maxX + 11 && cz > c.minZ - 11 && cz < c.maxZ + 11)) continue;
        const mg = buildMasjid(ctx, cx, cz, Math.atan2(sp.x - cx, sp.z - cz));
        this.placeOnGround(mg, cx, cz);
        placed = true;
        break;
      }
      if (placed) break;
    }

    // rumah makan Padang, same street, first slot that clears every collider
    const ring: [number, number][] = [];
    for (const r of [26, 34, 42, 50, 60, 72]) {
      for (let a = 0; a < 12; a++) {
        const t = (a / 12) * Math.PI * 2;
        ring.push([Math.round(Math.cos(t) * r), Math.round(Math.sin(t) * r)]);
      }
    }
    for (const [dx, dz] of ring) {
      const raw = { x: sp.x + dx, z: sp.z + 22 + dz };

      const spot = this.pushOffRoad(raw.x, raw.z, 3.6 + 11);

      const cx = spot.x, cz = spot.z;
      if (this.nearLayang(cx, cz, 16)) continue;
      if (this.colliders.some((c) => cx > c.minX - 9 && cx < c.maxX + 9 && cz > c.minZ - 9 && cz < c.maxZ + 9)) continue;
      const rg = buildRumahPadang(ctx, cx, cz, 0);
      this.placeOnGround(rg, cx, cz);
      break;
    }

    const kemang = POIS.find((p) => p.kind === 'minimarket');
    if (kemang) {
      const spot = this.snapToVerge(kemang.x, kemang.z + 18);
      if (spot) {
        const g = buildKoperasi(ctx, spot.x, spot.z, spot.yaw);
        this.placeOnGround(g, spot.x, spot.z);
      }
    }
  }


  /**
   * Jakarta's elevated toll: a deck running beside Thamrin on its own piers, so the skyline has a
   * second road level. Piers stand on the block edge, never in a traffic lane.
   */
  /** the deck the layang was built on, so a shop never ends up underneath it */
  layangSpine: [number, number][] = [];

  /** facade materials shared by colour, style and repeat, so their geometry can be merged */
  buildingMatCache = new Map<string, THREE.MeshStandardMaterial>();

  /** geometry waiting to be merged, bucketed per block group and material */
  buildingBuckets = new Map<THREE.Group, Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[] }>>();

  /** frontage bodies live outside the block groups, so they merge into one set for the root */
  frontageBuckets = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[] }>();

  /**
   * Facade fittings (cornices, ledges, rails, pipes, ACs, penthouses, sign bands) waiting to be
   * merged: one geometry list per block group. They go into one mesh with one vertex-coloured
   * material, so a block pays one extra draw call for all of its cornices.
   */
  detailBuckets = new Map<THREE.Group, THREE.BufferGeometry[]>();

  /**
   * Every facade that got built, with the variant and trim it was given. The screenshot harness
   * reads this to prove a block really mixes its facades instead of asserting it in prose.
   */
  facadeAudit: {
    x: number; z: number; h: number; variant: FacadeVariant; trim: number;
    fcx: number; fcz: number; nx: number; nz: number; faceLen: number; baseY: number;
    source: 'block' | 'frontage';
    block: [number, number] | null;
  }[] = [];

  /** every building footprint already placed, so two of them can never occupy the same ground */
  footprints: { minX: number; maxX: number; minZ: number; maxZ: number }[] = [];

  /** ground-floor plinth geometry, bucketed by texture variant, merged at the end of generation */
  plinthGeos: THREE.BufferGeometry[][] = [[], [], []];

  /**
   * true when (x, z) lies within `margin` metres of the *edge* of any arterial or the ring.
   *
   * The margin is what makes a pavement possible. A building needs road half-width + 3.6 m of
   * trotoar + ~2 m of setback, and the first version only asked for half the building's own
   * width, which put frontage 0.5 m from the kerb and left the sidewalk ribbon nowhere to go --
   * the reason a street and its pavement looked like one flat surface.
   */
  onRoad(x: number, z: number, margin: number): boolean {
    const roads: { path: [number, number][]; half: number }[] = [
      ...ARTERIALS.map((a) => ({ path: a.path as [number, number][], half: a.width / 2 })),
      { path: RING_ROAD, half: 10 },
    ];
    for (const { path, half } of roads) {
      const pad = half + margin;
      for (let i = 1; i < path.length; i++) {
        const [x1, z1] = path[i - 1];
        const [x2, z2] = path[i];
        const dx = x2 - x1, dz = z2 - z1;
        const len2 = dx * dx + dz * dz || 1;
        let t = ((x - x1) * dx + (z - z1) * dz) / len2;
        t = Math.max(0, Math.min(1, t));
        if (Math.hypot(x - (x1 + dx * t), z - (z1 + dz * t)) < pad) return true;
      }
    }
    return false;
  }

  /** true when (x, z) is within `pad` metres of the elevated deck's centreline */
  nearLayang(x: number, z: number, pad: number): boolean {
    for (let i = 1; i < this.layangSpine.length; i++) {
      const [x1, z1] = this.layangSpine[i - 1];
      const [x2, z2] = this.layangSpine[i];
      const dx = x2 - x1, dz = z2 - z1;
      const len2 = dx * dx + dz * dz || 1;
      let t = ((x - x1) * dx + (z - z1) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
      if (Math.hypot(x - (x1 + dx * t), z - (z1 + dz * t)) < pad) return true;
    }
    return false;
  }

  buildLayangRoad() {
    const spine = ARTERIALS[0].path as [number, number][];
    this.layangSpine = spine;
    // over the artery itself, which is where a Jakarta layang actually runs
    const shifted = spine;
    buildLayang(
      {
        group: this.group,
        colliders: this.colliders,
        audit: this.propAudit,
        groundHeightAt: (x, z) => this.groundHeightAt(x, z),
      },
      shifted,
      { deckY: 13.2, width: 16.5, pierEvery: 28 }
    );
  }


  /**
   * The MRT: the third elevated structure in the city, and the one that reads as modern —
   * narrower guideway, slimmer piers, glass stations instead of concrete.
   */
  buildMrt() {
    const spine = ARTERIALS[1]?.path as [number, number][] | undefined;
    if (!spine || spine.length < 2) return;
    // Run the line beside the artery, not over it: the toll already owns the centre, and a
    // guideway dropped straight onto the artery centreline puts its piers in the traffic lanes.
    const shifted: [number, number][] = spine.map(([x, z], i) => {
      const [ax, az] = spine[Math.max(0, i - 1)];
      const [bx, bz] = spine[Math.min(spine.length - 1, i + 1)];
      const dx = bx - ax, dz = bz - az;
      const len = Math.hypot(dx, dz) || 1;
      // Over the pavement, not 24 m inside the blocks: an elevated metro in Jakarta runs above
      // the verge at the road edge, and that is also the only place its piers and its stairs
      // can stand without a building underneath.
      const off = (ARTERIALS[1].width ?? 20) / 2 + 5.5;
      return [x + (dz / len) * off, z - (dx / len) * off] as [number, number];
    });
    buildMrtLine(
      {
        group: this.group,
        colliders: this.colliders,
        audit: this.propAudit,
        groundHeightAt: (x, z) => this.groundHeightAt(x, z),
      },
      shifted
    );
    this.mrtSpine = shifted;
    // A station belongs on its own guideway, so it is not displaced for clearance: the first
    // version asked for 20 m of empty ground beside a line whose own piers are colliders, and
    // every candidate was rejected, which is why the MRT line had no station at all.
    // A station is only usable if you can walk to it. Pick the point on the line nearest the
    // spawn *whose stair foot is clear*, rather than the nearest point full stop -- the first
    // version put the hall and its stairs inside a block and it was invisible from the street.
    const sp = this.getSpawn();
    const stairClear = (x: number, z: number) =>
      this.colliders.every((c) => x < c.minX - 6 || x > c.maxX + 6 || z + 20 < c.minZ - 6 || z + 26 > c.maxZ + 6);
    let mid = shifted[0], bestD = Infinity;
    for (const pt of shifted) {
      const d = Math.hypot(pt[0] - sp.x, pt[1] - sp.z);
      if (d < bestD && stairClear(pt[0], pt[1])) { bestD = d; mid = pt; }
    }
    const sg = buildMrtStation(
      { group: this.group, colliders: this.colliders, audit: this.propAudit, groundHeightAt: (x, z) => this.groundHeightAt(x, z) },
      mid[0], mid[1], 0
    );
    // the station was built against y = 0 while the ground under it sits 1.2 m lower, so the
    // stair landing hung in the air until the audit caught it
    this.placeOnGround(sg, mid[0], mid[1]);
  }

  /** the MRT line this city built, so nothing else is placed underneath it */
  mrtSpine: [number, number][] = [];

  /**
   * The commuter line: a viaduct crossing the city east to west, above the rooftops, with one
   * station where the deck meets the kampung. This is the structure that makes the skyline read
   * as Jakarta rather than as a set of boxes.
   */
  buildKrlLine() {
    const z = -300;
    const path: [number, number][] = [];
    for (let x = -820; x <= 820; x += 105) path.push([x, z + Math.sin(x / 260) * 26]);
    buildKrl(
      {
        group: this.group,
        colliders: this.colliders,
        audit: this.propAudit,
        groundHeightAt: (x, zz) => this.groundHeightAt(x, zz),
      },
      path,
      { y: 12.5, station: true, stationName: 'STASIUN MANGGIS' }
    );
  }

  buildOjekBases() {
    if (!this.ojeks) this.ojeks = [];
    let placed = 0;
    for (const poi of POIS) {
      if (poi.kind !== 'kaki5' && poi.kind !== 'terminal') continue;
      if (placed >= 3) break;
      placed++;
      for (let i = 0; i < 2; i++) {
        const spot = this.snapToVerge(poi.x + i * 3.2 - 1.6, poi.z + 6);
        if (!spot) continue;
        const bike = new Ojek({ color: i === 0 ? 0xc0392b : 0x1f6f4a });
        // The bike has to stand at its slot. placeOnGround only sets the height, so a group left
        // at x=0/z=0 parked every ojek in the middle of the map: six slots audited as "on the
        // ground" while the meshes were somewhere nobody could ever see them.
        bike.group.position.set(spot.x, 0, spot.z);
        bike.group.rotation.y = spot.yaw + Math.PI / 2 + i * 0.1;
        bike.group.name = `ojek-${this.ojeks.length}`;
        this.group.add(bike.group);
        this.ojeks.push({ group: bike.group, x: spot.x, z: spot.z, yaw: bike.group.rotation.y, box: bike.cargoBoxBounds });
        this.propAudit.push({ name: 'ojek', x: spot.x, z: spot.z, bottom: 0 });
        this.placeOnGround(bike.group, spot.x, spot.z);
        this.colliders.push({ minX: spot.x - 0.55, maxX: spot.x + 0.55, minZ: spot.z - 1.1, maxZ: spot.z + 1.1, h: 1.6 });
      }
    }
  }

  buildDistrictProps() {
    if (this.lanternMats.length) {
      const mat = new THREE.MeshStandardMaterial({ color: 0xd8352a, emissive: 0x7a120c, emissiveIntensity: 0.5, roughness: 0.7 });
      const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.34, 0.5, 0.34), mat, this.lanternMats.length);
      this.lanternMats.forEach((mm, i) => mesh.setMatrixAt(i, mm));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      this.group.add(mesh);

      if (this.lanternWireMats.length) {
        const wireMat = new THREE.MeshStandardMaterial({ color: 0x2a2320, roughness: 0.9 });
        const wire = new THREE.InstancedMesh(new THREE.BoxGeometry(BLOCK - 2, 0.035, 0.035), wireMat, this.lanternWireMats.length);
        this.lanternWireMats.forEach((mm, i) => wire.setMatrixAt(i, mm));
        wire.instanceMatrix.needsUpdate = true;
        wire.frustumCulled = false;
        this.group.add(wire);
      }
    }
    if (this.washMats.length) {
      const line = new THREE.MeshStandardMaterial({ color: 0xe8e4d8, roughness: 0.9 });
      const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(BLOCK - 12, 0.06, 0.06), line, this.washMats.length);
      this.washMats.forEach((mm, i) => mesh.setMatrixAt(i, mm));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      // the washing itself: a row of small cloths under each line
      const cloth = new THREE.MeshStandardMaterial({ color: 0xdcd6c2, roughness: 0.95 });
      const cloths = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.6, 0.05), cloth, this.washMats.length * 4);
      let k = 0;
      for (const mm of this.washMats) {
        const base = new THREE.Vector3().setFromMatrixPosition(mm);
        for (let i = 0; i < 4; i++) {
          const t = new THREE.Matrix4().makeTranslation(base.x - 8 + i * 5.4 + rand(-0.4, 0.4), base.y - 0.36, base.z + rand(-0.1, 0.1));
          cloths.setMatrixAt(k++, t);
        }
      }
      cloths.instanceMatrix.needsUpdate = true;
      cloths.frustumCulled = false;
      this.group.add(cloths);
    }
  }

  buildLampInstances() {
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x3b3f45, metalness: 0.5, roughness: 0.5 });
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0xfff1c4,
      emissive: 0xffd98a,
      emissiveIntensity: 0.2,
      roughness: 0.4,
    });
    this.lampMats.push(lampMat);

    const poleMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 5.2, 0.16), poleMat, this.lampPoles.length);
    this.lampPoles.forEach((m, i) => poleMesh.setMatrixAt(i, m));
    poleMesh.instanceMatrix.needsUpdate = true;
    poleMesh.castShadow = true;
    poleMesh.frustumCulled = false;
    this.group.add(poleMesh);

    const armMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.4, 0.14, 0.14), poleMat, this.lampArms.length);
    this.lampArms.forEach((m, i) => armMesh.setMatrixAt(i, m));
    armMesh.instanceMatrix.needsUpdate = true;
    armMesh.frustumCulled = false;
    this.group.add(armMesh);

    const headMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.7, 0.22, 0.45), lampMat, this.lampHeads.length);
    this.lampHeads.forEach((m, i) => headMesh.setMatrixAt(i, m));
    headMesh.instanceMatrix.needsUpdate = true;
    headMesh.frustumCulled = false;
    this.group.add(headMesh);
  }



  /** Pull a point onto the nearest block plate, so street props always have a kerb. */
  nudgeOntoKerb(x: number, z: number) {
    let best = null as any;
    let bd = Infinity;
    for (const b of this.blocks) {
      const d = Math.hypot(b.x - x, b.z - z);
      if (d < bd) { bd = d; best = b; }
    }
    if (!best) return { x, z };
    const half = ((best.size ?? BLOCK) / 2) - 2.4;
    return {
      x: clamp(x, best.x - half, best.x + half),
      z: clamp(z, best.z - half, best.z + half),
    };
  }

  /** Distance from a point to a polyline, in world metres. */
  distToPath(x: number, z: number, pts: [number, number][]): number {
    let best = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, z1] = pts[i];
      const [x2, z2] = pts[i + 1];
      const dx = x2 - x1;
      const dz = z2 - z1;
      const len2 = dx * dx + dz * dz || 1;
      const t = clamp(((x - x1) * dx + (z - z1) * dz) / len2, 0, 1);
      best = Math.min(best, Math.hypot(x - (x1 + dx * t), z - (z1 + dz * t)));
    }
    return best;
  }

  /**
   * Candidate block sites. A jittered scatter, then a filter: no water, no river, no road
   * corridor, no landmark footprint. The result is a city that follows the arterials and the
   * ring instead of sitting on a lattice.
   */
  /**
   * Candidate block sites on a city-block pitch, jittered a little, then filtered against
   * water, the road corridors and the landmark footprints. A block is 110-150 m, so the
   * streets between them are 20-60 m of asphalt and pavement - the width a real Jakarta
   * block has, not the 30 m road that made the old 380 m city look like a village.
   */
  /** Half extent of the built world, so actors clamp to the city and not to a stale constant. */
  get bound() {
    return WORLD_HALF;
  }

  planBlockSites() {
    // Fill each district, not the whole map on one lattice. A global grid leaves holes wherever
    // a site is rejected (and the player could stand 180 m from the nearest building); tiling
    // inside the district polygon keeps the street wall continuous.
    const sites: { x: number; z: number; size: number }[] = [];
    const PITCH_BLOCK = 90;
    const SIZE = 64;
    // Block centres sit on multiples of the pitch, which is where src/world/streets.ts draws the
    // local streets: halfway between two centres. Offsetting the lattice by the district's own
    // bounding box (the old code) put streets straight through blocks - 12% of the road samples
    // ended up under a footprint, and a police route handed such a leg drove into the wall.
    for (const d of JKT_DISTRICTS) {
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
      const firstX = Math.ceil((minX + SIZE / 2) / PITCH_BLOCK) * PITCH_BLOCK;
      const firstZ = Math.ceil((minZ + SIZE / 2) / PITCH_BLOCK) * PITCH_BLOCK;
      for (let x = firstX; x <= maxX + SIZE / 2; x += PITCH_BLOCK) {
        for (let z = firstZ; z <= maxZ + SIZE / 2; z += PITCH_BLOCK) {
          const jx = x + rand(-3, 3);
          const jz = z + rand(-3, 3);
          // the block centre has to be inside the district, and its corners too, so a block
          // never spills into the bay or the next district's park
          if (!pointInPoly(jx, jz, d.poly)) continue;
          if (!pointInPoly(jx - SIZE * 0.45, jz - SIZE * 0.45, d.poly)) continue;
          if (!pointInPoly(jx + SIZE * 0.45, jz + SIZE * 0.45, d.poly)) continue;
          if (isWater(jx, jz)) continue;
          let blocked = false;
          // the roads come first: a block may not sit on an arterial, or the street the player
          // spawns on has a building in the middle of it
          for (const a of ARTERIALS) {
            if (this.distToPath(jx, jz, a.path) < a.width / 2 + (SIZE / 2) * 1.42 + 2) { blocked = true; break; }
          }
          if (blocked) continue;
          if (this.distToPath(jx, jz, RING_ROAD) < 12 + (SIZE / 2) * 1.42 + 2) continue;
          for (const lm of LANDMARKS) {
            if (Math.hypot(jx - lm.x, jz - lm.z) < SIZE / 2 + 34) { blocked = true; break; }
          }
          if (blocked) continue;
          for (const r of RIVERS) {
            if (this.distToPath(jx, jz, r.path) < r.width / 2 + SIZE * 0.42) { blocked = true; break; }
          }
          if (blocked) continue;
          // a plate may not grow past half the gap to the street line (56 - 6), or its outer
          // buildings stand on the carriageway
          sites.push({ x: jx, z: jz, size: SIZE + rand(-6, 2) });
        }
      }
    }
    // Second pass: the districts are polygons, and the ground between them used to stay empty -
    // which is the void you could walk into a hundred metres from the spawn. Fill the land
    // inside the ring on the same lattice, taking the style of the nearest district.
    const near = (x: number, z: number) =>
      sites.some((s) => Math.hypot(s.x - x, s.z - z) < PITCH_BLOCK * 0.62);
    const half = WORLD_HALF - 120;
    for (let x = -half; x <= half; x += PITCH_BLOCK) {
      for (let z = -half; z <= half; z += PITCH_BLOCK) {
        const jx = x + rand(-3, 3);
        const jz = z + rand(-3, 3);
        if (near(jx, jz)) continue;
        if (isWater(jx, jz)) continue;
        if (Math.abs(jx) > half || Math.abs(jz) > half) continue;
        let blocked = false;
        for (const a of ARTERIALS) {
          if (this.distToPath(jx, jz, a.path) < a.width / 2 + (SIZE / 2) * 1.42 + 2) { blocked = true; break; }
        }
        if (blocked) continue;
        if (this.distToPath(jx, jz, RING_ROAD) < 12 + (SIZE / 2) * 1.42 + 2) continue;
        for (const lm of LANDMARKS) {
          if (Math.hypot(jx - lm.x, jz - lm.z) < SIZE / 2 + 34) { blocked = true; break; }
        }
        if (blocked) continue;
        for (const r of RIVERS) {
          if (this.distToPath(jx, jz, r.path) < r.width / 2 + SIZE * 0.42) { blocked = true; break; }
        }
        if (blocked) continue;
        sites.push({ x: jx, z: jz, size: SIZE + rand(-6, 2) });
      }
    }
    return sites;
  }

  /** A flat ribbon of `width` at height `y` above the terrain, sampled every ~8 m. */
  ribbon(points: [number, number][], width: number, y: number): THREE.BufferGeometry {
    return this.sweepSurface(points, [[-width / 2, y], [width / 2, y]], 1);
  }

  /**
   * A path resampled every `step` metres, carrying its left normal and the distance travelled.
   *
   * Road, gutter, kerb and pavement are all swept from the same stations, so their edges line up
   * to the millimetre instead of drifting apart wherever two sweeps bend differently.
   */
  private samplePath(points: [number, number][], step = 8) {
    const out: { x: number; z: number; nx: number; nz: number; u: number; dx: number; dz: number }[] = [];
    let u = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const [x1, z1] = points[i];
      const [x2, z2] = points[i + 1];
      const dx = x2 - x1;
      const dz = z2 - z1;
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len;
      const nz = dx / len;
      const steps = Math.max(1, Math.ceil(len / step));
      // start at k=1 on later segments: repeating the joint vertex makes a zero-width quad,
      // which is a degenerate triangle and a NaN normal
      for (let k = i === 0 ? 0 : 1; k <= steps; k++) {
        const t = k / steps;
        out.push({ x: x1 + dx * t, z: z1 + dz * t, nx, nz, u: u + len * t, dx: dx / len, dz: dz / len });
      }
      u += len;
    }
    return out;
  }

  /** The station at a given distance along a sampled path, interpolated between samples. */
  private stationAt(stations: ReturnType<City['samplePath']>, u: number) {
    if (u <= stations[0].u) return stations[0];
    const last = stations[stations.length - 1];
    if (u >= last.u) return last;
    let i = 1;
    while (i < stations.length - 1 && stations[i].u < u) i++;
    const p = stations[i - 1];
    const q = stations[i];
    const t = q.u > p.u ? (u - p.u) / (q.u - p.u) : 0;
    return {
      x: p.x + (q.x - p.x) * t,
      z: p.z + (q.z - p.z) * t,
      nx: p.nx + (q.nx - p.nx) * t,
      nz: p.nz + (q.nz - p.nz) * t,
      dx: p.dx + (q.dx - p.dx) * t,
      dz: p.dz + (q.dz - p.dz) * t,
      u,
    };
  }

  /**
   * Quad strip from cross-sections: rows advance along the path, columns across it, UVs are in
   * metres divided by the tile size so a texture lands at a real-world scale.
   *
   * Winding is the whole point. With the columns ordered by increasing lateral offset and the
   * rows advancing along the path, the triangle (row, col), (row, col+1), (row+1, col) faces the
   * sky. The old ribbon() pushed the same four corners in *decreasing* lateral order, so every
   * carriageway, pavement and river in the city carried a normal of (0,-1,0): FrontSide culled
   * them from above and what the player actually saw was the concrete ground plane. That is the
   * "carriageway and pavement are one surface" the owner reported twice - the carriageway was
   * not drawn at all.
   */
  private stripGeometry(rows: THREE.Vector3[][], us: number[], vs: number[], tone?: number[]): THREE.BufferGeometry {
    const cols = vs.length;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      for (let j = 0; j < cols; j++) {
        const p = rows[i][j];
        pos.push(p.x, p.y, p.z);
        uv.push(us[i], vs[j]);
      }
    }
    for (let i = 0; i < rows.length - 1; i++) {
      for (let j = 0; j < cols - 1; j++) {
        const a = i * cols + j;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        idx.push(a, b, c, c, b, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    if (tone) {
      // per-column tone, multiplied into the map: this is how the foot of a kerb stone gets its
      // grime and the chamfer under the cap gets its line of light, at mesh resolution instead
      // of at texture resolution
      const col: number[] = [];
      for (let i = 0; i < rows.length; i++) for (let j = 0; j < cols; j++) col.push(tone[j], tone[j], tone[j]);
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    }
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /**
   * Sweep a cross-section along a path.
   *
   * `profile` is [lateralOffset, heightAboveTerrain] in metres ordered by increasing lateral
   * offset (positive = the path's left normal); `tile` is how many metres one texture repeat
   * covers; `gaps` are [from, to] distances along the path where the surface is cut open, which
   * is how a dropped kerb gets its opening.
   */
  private sweepSurface(
    points: [number, number][],
    profile: [number, number, number?][],
    tile: number,
    gaps: [number, number][] = []
  ): THREE.BufferGeometry {
    const ordered = [...profile].sort((a, b) => a[0] - b[0]);
    const ton = ordered.map((p) => p[2]);
    // v is the 3D distance travelled along the section, not the lateral offset: a 25 cm kerb face
    // that spans 2 cm of offset would otherwise get 2 cm of UV and stretch the concrete into
    // stripes over the one surface that has to catch the light.
    const vs: number[] = [0];
    for (let j = 1; j < ordered.length; j++) {
      const dl = ordered[j][0] - ordered[j - 1][0];
      const dh = ordered[j][1] - ordered[j - 1][1];
      vs.push(vs[j - 1] + Math.hypot(dl, dh) / tile);
    }
    const stations = this.samplePath(points);
    const total = stations[stations.length - 1].u;
    const runs: [number, number][] = [];
    let cursor = 0;
    for (const [from, to] of [...gaps].sort((a, b) => a[0] - b[0])) {
      if (from > cursor) runs.push([cursor, Math.min(from, total)]);
      cursor = Math.max(cursor, to);
    }
    if (cursor < total) runs.push([cursor, total]);
    if (!runs.length) runs.push([0, total]);
    const parts: THREE.BufferGeometry[] = [];
    for (const [a, b] of runs) {
      if (b - a < 0.05) continue;
      const rows: THREE.Vector3[][] = [];
      const us: number[] = [];
      const first = this.stationAt(stations, a);
      const last = this.stationAt(stations, b);
      const pick: typeof stations = [first];
      for (const s of stations) if (s.u > a + 0.01 && s.u < b - 0.01) pick.push(s);
      pick.push(last);
      for (const st of pick) {
        const row: THREE.Vector3[] = [];
        for (const [at, h] of ordered) {
          const x = st.x + st.nx * at;
          const z = st.z + st.nz * at;
          row.push(new THREE.Vector3(x, terrainHeight(x, z) + h, z));
        }
        rows.push(row);
        us.push(st.u / tile);
      }
      if (rows.length > 1) parts.push(this.stripGeometry(rows, us, vs, ton.some((t) => t !== undefined) ? ton.map((t) => t ?? 1) : undefined));
    }
    if (parts.length === 1) return parts[0];
    return mergeGeometries(parts) ?? parts[0];
  }


  /** A path pushed sideways by `dist`: used for the pavements that flank every road. */
  offsetPath(path: [number, number][], dist: number): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 0; i < path.length; i++) {
      const [x, z] = path[i];
      const prev = path[Math.max(0, i - 1)];
      const next = path[Math.min(path.length - 1, i + 1)];
      const dx = next[0] - prev[0];
      const dz = next[1] - prev[1];
      const len = Math.hypot(dx, dz) || 1;
      out.push([x - (dz / len) * dist, z + (dx / len) * dist]);
    }
    return out;
  }

  buildRoadRibbons() {
    // The road network as data, so actors (pedestrians) navigate the streets the map draws
    // instead of a lattice constant. One list, one width per road.
    this.roads = [
      ...ARTERIALS.map((a) => ({ name: a.name, width: a.width, path: a.path as [number, number][] })),
      { name: 'Ring Road', width: 20, path: RING_ROAD as [number, number][] },
      ...LOCAL_STREETS.map((s, i) => ({ name: `Local Street ${i}`, width: s.width, path: s.path as [number, number][] })),
    ];
    const mats = this.roadMaterials();
    const geo = {
      local: [] as THREE.BufferGeometry[],
      arterial: [] as THREE.BufferGeometry[],
      ring: [] as THREE.BufferGeometry[],
      walk: [] as THREE.BufferGeometry[],
      kerb: [] as THREE.BufferGeometry[],
      gutter: [] as THREE.BufferGeometry[],
      line: [] as THREE.BufferGeometry[],
      shoulder: [] as THREE.BufferGeometry[],
      water: [] as THREE.BufferGeometry[],
      ramp: [] as THREE.BufferGeometry[],
    };

    for (const st of LOCAL_STREETS) {
      geo.local.push(this.sweepSurface(st.path as [number, number][], [[-st.width / 2, 0.05], [st.width / 2, 0.05]], 4));
    }

    const arterialRoads = [
      ...ARTERIALS.map((a) => ({ path: a.path as [number, number][], width: a.width })),
      { path: RING_ROAD as [number, number][], width: 20 },
    ];
    // Crossings are planned before anything is swept: the kerb has to know where its openings
    // are, or the dropped kerb would be a second surface laid over a solid stone.
    this.crossings = this.planCrossings();
    const gapsByRoad = arterialRoads.map((_, ri) =>
      this.crossings.filter((c) => c.road === ri).map((c) => [c.u - 1.2, c.u + 1.2] as [number, number])
    );

    for (let ri = 0; ri < arterialRoads.length; ri++) {
      const road = arterialRoads[ri];
      const e = road.width / 2;
      const asphalt = this.sweepSurface(road.path, [[-(e - 0.58), 0.05], [e - 0.58, 0.05]], 4);
      geo.arterial.push(asphalt);
      // 1.5 m of shoulder on the twice-lane arterials; the lane edge line marks its inner edge
      const shoulder = road.width >= 16;
      const inner = shoulder ? 2.08 : 0.70;
      for (const side of [-1, 1]) {
        /**
         * The kerb, as a cross-section rather than a painted stripe.
         *
         * gutter (dark concrete, 4 cm below the carriageway):
         *   e-0.58  0.050  lip, flush with the asphalt
         *   e-0.55  0.026  the step down
         *   e-0.12  0.010  invert: the wet line that runs beside every Jakarta kerb
         *   e-0.06  0.016  the channel climbs to the foot of the stone
         *
         * stone (toned by column, so the face is darker than the cap):
         *   e+0.00  0.060  0.55  foot, in shadow and grime
         *   e+0.02  0.300  0.80  24 cm of vertical face: this is what casts the shadow line
         *   e+0.05  0.315  1.00  chamfer that catches the light
         *   e+0.17  0.315  0.97  12 cm of cap, proud of the paving
         *   e+0.20  0.260  0.90  chamfer down onto the trotoar
         *
         * 30 cm of stone, 12 cm proud, on a 4 cm gutter channel.
         */
        geo.gutter.push(
          this.sweepSurface(
            road.path,
            [
              [side * (e - 0.58), 0.05, 0.92], // lip: same concrete as the asphalt edge, so the join is not a line
              [side * (e - 0.55), 0.026, 0.6], // the step down
              [side * (e - 0.12), 0.01, 0.42], // invert: the dark wet line
              [side * (e - 0.06), 0.016, 0.62], // climbs to the foot of the stone
            ],
            1.2,
            gapsByRoad[ri]
          )
        );
        geo.kerb.push(
          this.sweepSurface(
            road.path,
            [
              [side * (e - 0.06), 0.016, 0.55],
              [side * (e + 0.0), 0.06, 0.58],
              [side * (e + 0.02), 0.3, 0.8],
              [side * (e + 0.05), 0.315, 1.0],
              [side * (e + 0.17), 0.315, 0.97],
              [side * (e + 0.2), 0.26, 0.9],
            ],
            1.2,
            gapsByRoad[ri]
          )
        );
        // 3.6 m of paving behind the stone, its inner edge exactly on the kerb cap chamfer, and a
        // back face so the slab is not a sheet hovering 26 cm over the ground behind it
        geo.walk.push(
          this.sweepSurface(
            road.path,
            [
              [side * (e + 0.2), 0.26],
              [side * (e + 3.8), 0.26],
              [side * (e + 3.8), 0.0],
            ],
            2.4
          )
        );
        geo.line.push(
          this.sweepSurface(
            road.path,
            [[side * (e - inner - 0.15), 0.056], [side * (e - inner), 0.056]],
            1
          )
        );
        if (shoulder) {
          // older, paler asphalt between the lane line and the gutter: the shoulder
          geo.shoulder.push(
            this.sweepSurface(road.path, [[side * (e - 0.585), 0.0525], [side * (e - inner), 0.0525]], 2)
          );
        }
      }
    }

    for (const rv of RIVERS) {
      geo.water.push(this.sweepSurface(rv.path, [[-rv.width / 2, 0.05], [rv.width / 2, 0.05]], 1));
    }

    // one mesh per material: the old code made a mesh per road per side and paid ~40 draw calls
    // for what is one continuous surface
    const buckets: { geos: THREE.BufferGeometry[]; mat: THREE.Material; name: string; receive: boolean }[] = [
      { geos: geo.local, mat: mats.asphalt, name: 'road-local', receive: true },
      { geos: geo.arterial, mat: mats.asphalt, name: 'road-arterial', receive: true },
      { geos: geo.shoulder, mat: mats.shoulder, name: 'road-shoulder', receive: true },
      { geos: geo.line, mat: mats.line, name: 'lane-edge', receive: false },
      { geos: geo.walk, mat: mats.walk, name: 'trotoar', receive: true },
      { geos: geo.kerb, mat: mats.kerb, name: 'kerb', receive: true },
      { geos: geo.gutter, mat: mats.gutter, name: 'gutter', receive: true },
      { geos: geo.ramp, mat: mats.kerb, name: 'kerb-ramp', receive: true },
      { geos: geo.water, mat: mats.water, name: 'river', receive: false },
    ];
    for (const b of buckets) {
      if (!b.geos.length) continue;
      const merged = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, b.mat);
      mesh.name = b.name;
      mesh.receiveShadow = b.receive;
      this.group.add(mesh);
    }

    this.buildCrossingDressing(arterialRoads, mats);
  }

  /**
   * Carriageway and pavement, as materials drawn at a real-world scale.
   *
   * The asphalt is a 4 m tile of value-only grain (1.5-4.5 cm specks), so at 1.7 m the eye reads
   * grain instead of a flat fill; the trotoar is 30 cm pavers with a joint, a bevel and its own
   * value per paver on a 2.4 m tile; the kerb carries a 1.2 m stone joint and a gradient that
   * darkens it towards the gutter. Every variation is in value, never in hue: a warm patch on the
   * road reads as a stain at eye height, which is what the last texture pass had to undo.
   */
  private roadMaterials() {
    const asphaltTex = canvasTexture(256, 256, (ctx, w, h) => {
      ctx.fillStyle = '#282c32';
      ctx.fillRect(0, 0, w, h);
      // aggregate. light and dark specks are balanced so the tile mean stays on the base colour
      for (let i = 0; i < 4200; i++) {
        const g = Math.round(44 + rand(-13, 13));
        ctx.fillStyle = `rgb(${g - 3},${g},${g + 5})`;
        ctx.fillRect(rand(0, w), rand(0, h), rand(1, 3), rand(1, 3));
      }
      // resurfacing ghosts, 40-90 cm across, kept very faint: at eye height a stronger oval reads
      // as a stain on the road, which is the defect the last texture pass had to undo
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = i % 2 ? 'rgba(20,22,26,0.07)' : 'rgba(60,64,70,0.06)';
        ctx.beginPath();
        ctx.ellipse(rand(0, w), rand(0, h), rand(26, 58), rand(18, 40), rand(0, 3), 0, Math.PI * 2);
        ctx.fill();
      }
      // hairline cracks: one every couple of metres, never dead straight
      ctx.strokeStyle = 'rgba(16,18,21,0.5)';
      ctx.lineWidth = 1.1;
      for (let i = 0; i < 4; i++) {
        let x = rand(0, w);
        let y = rand(0, h);
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let k = 0; k < 5; k++) {
          x += rand(-16, 16);
          y += rand(-16, 16);
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    });
    asphaltTex.wrapS = asphaltTex.wrapT = THREE.RepeatWrapping;

    const walkTex = canvasTexture(1024, 1024, (ctx, w, h) => {
      const n = 8; // 30 cm pavers on a 2.4 m tile
      const cell = w / n;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          // each paver its own value: a uniform grid of one grey is exactly what the trotoar was
          const v = rand(-10, 10);
          ctx.fillStyle = `rgb(${Math.round(172 + v)},${Math.round(167 + v)},${Math.round(155 + v * 0.8)})`;
          ctx.fillRect(i * cell, j * cell, cell, cell);
          // grain inside the paver
          for (let k = 0; k < 90; k++) {
            const g = Math.round(128 + rand(-20, 26));
            ctx.fillStyle = `rgba(${g},${g - 4},${g - 12},0.20)`;
            ctx.fillRect(i * cell + rand(0, cell), j * cell + rand(0, cell), rand(1, 3), rand(1, 3));
          }
          // bevelled edges: light on the top-left, shadow on the bottom-right
          ctx.fillStyle = 'rgba(255,255,255,0.15)';
          ctx.fillRect(i * cell + 3, j * cell + 3, cell - 6, 3);
          ctx.fillStyle = 'rgba(0,0,0,0.10)';
          ctx.fillRect(i * cell + 3, j * cell + cell - 6, cell - 6, 3);
        }
      }
      // joints: dark, 3 px, i.e. 7 mm at this scale
      ctx.fillStyle = 'rgba(84,80,72,0.85)';
      for (let k = 0; k <= n; k++) {
        ctx.fillRect(Math.min(w - 3, k * cell - 1), 0, 3, h);
        ctx.fillRect(0, Math.min(h - 3, k * cell - 1), w, 3);
      }
      // chips and the odd stain, so the grid does not read as a spreadsheet
      for (let i = 0; i < 26; i++) {
        ctx.fillStyle = `rgba(${rand(0, 1) > 0.4 ? '92,88,80' : '206,200,188'},${rand(0.08, 0.22)})`;
        ctx.beginPath();
        ctx.ellipse(rand(0, w), rand(0, h), rand(3, 16), rand(3, 12), rand(0, 3), 0, Math.PI * 2);
        ctx.fill();
      }
    });
    walkTex.wrapS = walkTex.wrapT = THREE.RepeatWrapping;

    const kerbTex = canvasTexture(128, 256, (ctx, w, h) => {
      // v runs from the gutter (bottom of the canvas) to the cap, so a vertical gradient is the
      // grime: the foot of the stone is dirty, the cap is washed by the rain
      const grad = ctx.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0, '#8d8880');
      grad.addColorStop(0.45, '#b6b0a4');
      grad.addColorStop(1, '#d6d0c0');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 900; i++) {
        const g = Math.round(188 + rand(-18, 18));
        ctx.fillStyle = `rgba(${g},${g - 5},${g - 16},0.35)`;
        ctx.fillRect(rand(0, w), rand(0, h), rand(1, 4), rand(1, 3));
      }
      // stone joints every 1.2 m along the kerb
      ctx.fillStyle = 'rgba(64,60,54,0.55)';
      ctx.fillRect(0, 0, 3, h);
      ctx.fillRect(w - 4, 0, 3, h);
    });
    kerbTex.wrapS = kerbTex.wrapT = THREE.RepeatWrapping;

    const tactileTex = canvasTexture(128, 128, (ctx, w, h) => {
      ctx.fillStyle = '#c4941a';
      ctx.fillRect(0, 0, w, h);
      const n = 6; // 5 cm domes on a 30 cm tile
      const cell = w / n;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const cx = i * cell + cell / 2;
          const cy = j * cell + cell / 2;
          const g = ctx.createRadialGradient(cx - 2, cy - 3, 1, cx, cy, cell * 0.42);
          g.addColorStop(0, '#e8c04a');
          g.addColorStop(0.7, '#b8860f');
          g.addColorStop(1, '#8c6408');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(cx, cy, cell * 0.32, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });
    tactileTex.wrapS = tactileTex.wrapT = THREE.RepeatWrapping;

    const shoulderTex = canvasTexture(256, 256, (ctx, w, h) => {
      ctx.fillStyle = '#31353b';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 3400; i++) {
        const g = Math.round(54 + rand(-14, 16));
        ctx.fillStyle = `rgba(${g},${g + 1},${g + 5},0.5)`;
        ctx.fillRect(rand(0, w), rand(0, h), rand(1, 3), rand(1, 3));
      }
      // patch repairs: the shoulder is the oldest asphalt on a Jakarta road
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = i % 2 ? 'rgba(28,30,34,0.16)' : 'rgba(78,82,88,0.10)';
        ctx.fillRect(rand(0, w), rand(0, h), rand(30, 90), rand(20, 60));
      }
    });
    shoulderTex.wrapS = shoulderTex.wrapT = THREE.RepeatWrapping;

    const gutterTex = canvasTexture(128, 128, (ctx, w, h) => {
      // the channel is wet concrete: dark, cool, and never uniform
      ctx.fillStyle = '#57544e';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 700; i++) {
        const g = Math.round(88 + rand(-16, 18));
        ctx.fillStyle = `rgba(${g},${g - 2},${g - 6},0.5)`;
        ctx.fillRect(rand(0, w), rand(0, h), rand(1, 4), rand(1, 2));
      }
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = 'rgba(30,32,34,0.35)';
        ctx.beginPath();
        ctx.ellipse(rand(0, w), rand(0, h), rand(8, 30), rand(4, 14), rand(0, 3), 0, Math.PI * 2);
        ctx.fill();
      }
    });
    gutterTex.wrapS = gutterTex.wrapT = THREE.RepeatWrapping;

    return {
      // the road is darker and rougher than the walk: 0.97 against 0.86, so it takes the light
      // as a matte surface and the paving keeps a little sheen
      asphalt: new THREE.MeshStandardMaterial({ map: asphaltTex, roughness: 0.97 }),
      shoulder: new THREE.MeshStandardMaterial({ map: shoulderTex, roughness: 0.98 }),
      walk: new THREE.MeshStandardMaterial({ map: walkTex, roughness: 0.86 }),
      // the kerb stone carries a per-column tone (dark foot, bright chamfer) as vertex colours
      kerb: new THREE.MeshStandardMaterial({ map: kerbTex, roughness: 0.8, vertexColors: true }),
      gutter: new THREE.MeshStandardMaterial({ map: gutterTex, roughness: 0.92, vertexColors: true }),
      line: new THREE.MeshStandardMaterial({ color: 0xe8e4d6, roughness: 0.7 }),
      tactile: new THREE.MeshStandardMaterial({ map: tactileTex, roughness: 0.78 }),
      water: new THREE.MeshStandardMaterial({ color: 0x2f6577, roughness: 0.2, metalness: 0.35 }),
    };
  }

  /** Parameter along the first segment where two centrelines cross, or null when they miss. */
  private segmentCross(p1: [number, number], p2: [number, number], p3: [number, number], p4: [number, number]) {
    const d1x = p2[0] - p1[0];
    const d1z = p2[1] - p1[1];
    const d2x = p4[0] - p3[0];
    const d2z = p4[1] - p3[1];
    const den = d1x * d2z - d1z * d2x;
    if (Math.abs(den) < 1e-6) return null; // parallel
    const t = ((p3[0] - p1[0]) * d2z - (p3[1] - p1[1]) * d2x) / den;
    const s = ((p3[0] - p1[0]) * d1z - (p3[1] - p1[1]) * d1x) / den;
    if (t < 0 || t > 1 || s < 0 || s > 1) return null;
    return { t };
  }

  /** Distance along a polyline of the point `t` of segment `i`. */
  private distanceAt(path: [number, number][], i: number, t: number) {
    let u = 0;
    for (let k = 1; k < i; k++) u += Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]);
    return u + t * Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  }

  /**
   * Where a pedestrian can actually cross, derived from the road network.
   *
   * The old stripes were instanced on the (i+0.5)*PITCH block lattice, which stopped matching
   * the streets when the city moved to organic districts; they also sat at y=0.03, under the
   * carriageway, so they were invisible as well as misplaced. A crossing is now a place where
   * an arterial meets another road, set clear of the junction, and it exists only where there is
   * a kerb to step off.
   */
  planCrossings() {
    const arterialRoads = [
      ...ARTERIALS.map((a) => ({ path: a.path as [number, number][], width: a.width })),
      { path: RING_ROAD as [number, number][], width: 20 },
    ];
    const others = [
      ...LOCAL_STREETS.map((s) => ({ path: s.path as [number, number][], width: s.width })),
      ...arterialRoads,
    ];
    const out: { road: number; u: number }[] = [];
    const seen: [number, number][] = [];
    for (let ri = 0; ri < arterialRoads.length; ri++) {
      const a = arterialRoads[ri];
      const stations = this.samplePath(a.path, 4);
      const total = stations[stations.length - 1].u;
      for (const b of others) {
        if (a.path === b.path) continue;
        for (let i = 1; i < a.path.length; i++) {
          for (let j = 1; j < b.path.length; j++) {
            const hit = this.segmentCross(a.path[i - 1], a.path[i], b.path[j - 1], b.path[j]);
            if (!hit) continue;
            const u = this.distanceAt(a.path, i, hit.t);
            for (const side of [-1, 1]) {
              // clear of the other carriageway, so the stripes are not painted inside a junction
              const at = u + side * (b.width / 2 + 3.4);
              if (at < 8 || at > total - 8) continue;
              const st = this.stationAt(stations, at);
              if (seen.some(([x, z]) => Math.hypot(x - st.x, z - st.z) < 9)) continue;
              seen.push([st.x, st.z]);
              out.push({ road: ri, u: at });
            }
          }
        }
      }
    }
    return out.sort((p, q) => p.road - q.road || p.u - q.u);
  }

  /** A dropped kerb: the pavement edge ramps down to the gutter across a crossing. */
  private rampGeometry(
    st: { x: number; z: number; nx: number; nz: number; dx: number; dz: number },
    side: number,
    e: number
  ) {
    const nx = st.nx * side;
    const nz = st.nz * side;
    const at = (along: number, lat: number, h: number) => {
      const x = st.x + st.dx * along + nx * lat;
      const z = st.z + st.dz * along + nz * lat;
      return new THREE.Vector3(x, terrainHeight(x, z) + h, z);
    };
    // rows advance from the pavement toward the road, columns along it: the top faces the sky
    const top = this.stripGeometry(
      [
        [at(-1.2, e + 0.2, 0.26), at(1.2, e + 0.2, 0.26)],
        [at(-1.2, e - 0.58, 0.05), at(1.2, e - 0.58, 0.05)],
      ],
      [0, 1],
      [0, 1],
      [0.9, 0.9]
    );
    // a wall under the back edge, so the opening reads as a shadow instead of a hole
    const wall = this.stripGeometry(
      [
        [at(-1.2, e + 0.2, 0.26), at(1.2, e + 0.2, 0.26)],
        [at(-1.2, e + 0.2, -0.02), at(1.2, e + 0.2, -0.02)],
      ],
      [0, 1],
      [0, 1],
      [0.7, 0.7]
    );
    return mergeGeometries([top, wall]) ?? top;
  }

  /**
   * Zebra, tactile pad and dropped kerb, one set per planned crossing.
   *
   * The three belong together: the pad marks the crossing, the ramp is the opening in the kerb
   * behind it, and the stripes say which way to walk. A tactile strip with nothing to step off is
   * a painted rectangle.
   */
  private buildCrossingDressing(
    arterialRoads: { path: [number, number][]; width: number }[],
    mats: ReturnType<City['roadMaterials']>
  ) {
    if (!this.crossings.length) return;
    const stripes: THREE.Matrix4[] = [];
    const pads: THREE.Matrix4[] = [];
    const ramps: THREE.BufferGeometry[] = [];
    const padGeo = new THREE.PlaneGeometry(0.6, 2.4);
    {
      // one texture tile per 30 cm: 2 x 8 repeats across a 60 x 240 cm pad
      const uv = padGeo.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * 8);
      uv.needsUpdate = true;
      padGeo.rotateX(-Math.PI / 2);
    }
    for (const c of this.crossings) {
      const road = arterialRoads[c.road];
      const st = this.stationAt(this.samplePath(road.path, 4), c.u);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(st.dx, st.dz));
      const e = road.width / 2;
      // bars parallel to the traffic, stepping across the carriageway
      for (let lat = -(e - 0.95); lat <= e - 0.95 + 0.01; lat += 0.95) {
        const x = st.x + st.nx * lat;
        const z = st.z + st.nz * lat;
        stripes.push(new THREE.Matrix4().compose(new THREE.Vector3(x, terrainHeight(x, z) + 0.056, z), q, new THREE.Vector3(1, 1, 1)));
      }
      for (const side of [-1, 1]) {
        const x = st.x + st.nx * side * (e + 0.55);
        const z = st.z + st.nz * side * (e + 0.55);
        pads.push(new THREE.Matrix4().compose(new THREE.Vector3(x, terrainHeight(x, z) + 0.2665, z), q, new THREE.Vector3(1, 1, 1)));
        ramps.push(this.rampGeometry(st, side, e));
      }
    }
    const stripeGeo = new THREE.BoxGeometry(0.45, 0.012, 3);
    const stripeMesh = new THREE.InstancedMesh(stripeGeo, mats.line, stripes.length);
    stripes.forEach((m, i) => stripeMesh.setMatrixAt(i, m));
    stripeMesh.instanceMatrix.needsUpdate = true;
    stripeMesh.name = 'crossing-stripes';
    this.group.add(stripeMesh);

    const padMesh = new THREE.InstancedMesh(padGeo, mats.tactile, pads.length);
    pads.forEach((m, i) => padMesh.setMatrixAt(i, m));
    padMesh.instanceMatrix.needsUpdate = true;
    padMesh.receiveShadow = true;
    padMesh.name = 'tactile';
    this.group.add(padMesh);

    const rampGeo = mergeGeometries(ramps) ?? ramps[0];
    if (rampGeo) {
      const rampMesh = new THREE.Mesh(rampGeo, mats.kerb);
      rampMesh.name = 'kerb-ramp';
      rampMesh.receiveShadow = true;
      this.group.add(rampMesh);
    }
  }

  /**
   * The street kit, wired: one four-arm local junction, its pavements, and the furniture line that
   * repeats along it, all from `src/world/streetkit.ts`.
   *
   * This is the kit's first tenant, not a replacement of the inline road code yet. It stands on open
   * ground east of the Thamrin corridor (96, -116) because that is the nearest 34 m square the
   * generator leaves free of block plates, local-street ribbons and arterial pavement - checked
   * against `this.blocks` and `this.roads`, not guessed. The four arms are the map's local class
   * (8 m) and the kerbs are the kit's 30 cm / 12 cm trotoar module, so a later pass can lift the
   * rest of the network onto the same vocabulary.
   */
  buildStreetKitCorner() {
    const kx = 96;
    const kz = -116;
    const ground = (x: number, z: number) => terrainHeight(x, z);
    const ctx = { group: this.group, colliders: this.colliders, audit: this.propAudit };

    buildSignalIntersection(ctx, kx, kz, 0, { roadClass: 'local', armsM: 13, cornerRadiusM: 7, ground });

    // the north approach continues past the junction as a road segment, so the carriageway, edge
    // lines and double centre line come from the same builder the junction's arms use
    buildRoadSegment(ctx, kx, kz + 30, 0, { roadClass: 'local', lengthM: 26, median: 'paint', ground });

    // trotoar up the north arm and along the west arm, one module each side
    buildKerbWalk(ctx, kx + 4.3, kz + 8.65, 0, { lengthM: 8.7, crossingAt: -0.5, ground });
    buildKerbWalk(ctx, kx - 4.3, kz + 8.65, Math.PI, { lengthM: 8.7, crossingAt: -0.5, ground });
    buildKerbWalk(ctx, kx - 10.5, kz + 4.3, -Math.PI / 2, { lengthM: 13, tactile: false, ground });
    buildKerbWalk(ctx, kx - 10.5, kz - 4.3, Math.PI / 2, { lengthM: 13, tactile: false, ground });

    // the furniture that repeats: two poles with one sagging span between them, the name blade on
    // the corner, the bollards at the crossing mouth, and the covers in the carriageway
    buildUtilityPole(ctx, kx + 8.6, kz + 6.0, 0, { spanM: 12, ground });
    buildUtilityPole(ctx, kx + 20.6, kz + 6.0, 0, { spanM: 12, cables: false, ground });
    buildStreetNameSign(ctx, kx + 5.7, kz + 5.2, Math.PI / 2, { ground });
    buildBollard(ctx, kx + 4.5, kz + 5.6, 0, { ground });
    buildBollard(ctx, kx + 4.5, kz + 7.0, 0, { ground });
    buildManhole(ctx, kx + 1.2, kz + 14.0, 0, { ground });
    buildDrainGrate(ctx, kx - 2.4, kz + 15.0, 0, { ground });
  }

  buildWater() {
    const shape = new THREE.Shape();
    shape.moveTo(-WORLD_HALF - 900, -WORLD_HALF - 900);
    COASTLINE.forEach(([x, z], i) => (i ? shape.lineTo(x, -z) : shape.lineTo(x, -z)));
    shape.lineTo(WORLD_HALF + 900, -WORLD_HALF - 900);
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);
    const sea = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x24505f, roughness: 0.15, metalness: 0.45 }));
    sea.rotation.x = Math.PI / 2;
    sea.position.y = 0.02;
    sea.receiveShadow = true;
    this.group.add(sea);
    // reclaimed islands as low slabs
    const islMat = new THREE.MeshStandardMaterial({ color: 0x4a5560, roughness: 0.9 });
    for (const poly of ISLANDS) {
      const sp = new THREE.Shape();
      poly.forEach(([x, z], i) => (i ? sp.lineTo(x, -z) : sp.moveTo(x, -z)));
      sp.closePath();
      const slab = new THREE.Mesh(new THREE.ExtrudeGeometry(sp, { depth: 1.6, bevelEnabled: false }), islMat);
      slab.rotation.x = Math.PI / 2;
      slab.position.y = 1.6;
      slab.receiveShadow = true;
      this.group.add(slab);
    }
  }

  buildBuildings(cx: any, cz: any, size = BLOCK, district = null as any) {
    // A block belongs to a Jakarta district, and the district decides how tall, how dense and
    // what colour it is: Thamrin towers, a kampung is single storey with tiled roofs, Kota Tua
    // is white plaster under red clay, Tanah Abang is a wall of awnings.
    const id = district || districtAtPoint(cx, cz);
    const styleKey = (id === 'gambir' ? 'monas' : id) as keyof typeof DISTRICTS;
    const style = DISTRICTS[styleKey] || DISTRICTS.kampung;
    // A kampung is not a lot with one big box on it: it is houses packed along a narrow gang,
    // which is the shape you actually walk through in Jakarta.
    if (id === 'kampung') {
      this.buildKampungRow(cx, cz, style);
      return;
    }
    const area = size - 9;
    // A block is a grid of lots with alleys between them, not three boxes on an empty plate.
    // The plate used to read as a plaza because the lots were 25 m wide; 17-19 m lots with a
    // 3.4 m gang give the fabric a street wall and still leave the block walkable.
    const n = Math.max(2, Math.round(area / 18));
    const alley = 3.4;
    const cell = (area - alley * (n - 1)) / n;
    const cells: [number, number, number, number][] = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        // one lot in eight is left empty: a courtyard, a parking bay, a warung yard
        if (Math.random() < 0.12) continue;
        cells.push([
          -area / 2 + cell / 2 + i * (cell + alley),
          -area / 2 + cell / 2 + j * (cell + alley),
          cell,
          cell,
        ]);
      }
    }
    const deck = facadeDeck();
    for (const [ox, oz, w, d] of cells) {
      const [lo, hi] = style.heights;
      const h = rand(lo, hi);
      this.makeBuilding(cx + ox, cz + oz, w, d, h, cx, cz, style, deck);
    }
    // market districts get tarpaulin stalls spilled onto the pavement
    if (id === 'tanahabang' || id === 'glodok') {
      if (!this.propAudit) this.propAudit = [];
      buildMarketStalls({ group: this.group, colliders: this.colliders, audit: this.propAudit }, cx, cz, 2);
    }
  }

  /** Six small houses facing a 4 m gang: the alley is walkable, the houses are solid. */
  buildKampungRow(cx: number, cz: number, style: any) {
    const gangHalf = 2.0;
    const houseW = 6.4;
    const houseD = 8.2;
    const gapZ = 3.6; // real gaps: houses must read as separate homes, not one barracks
    const roofMat = new THREE.MeshStandardMaterial({ color: style.roof, roughness: 0.95 });
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x5a3b28, roughness: 0.9 });
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const h = rand(style.heights[0], style.heights[1]) - (i % 2) * 0.6;
        const x = cx + side * (gangHalf + houseW / 2);
        const z = cz - houseD - gapZ * 1.5 + i * (houseD + gapZ);
        const wall = pick(style.walls);
        const tex = windowTexture(wall, 'strips');
        // the tile is one storey; the house's own UVs say how many storeys it is
        const body = new THREE.Mesh(
          new THREE.BoxGeometry(houseW, h, houseD),
          [new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 }), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 }),
           new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.95 }), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 }),
           new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 }), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 })]
        );
        facadeUV(body.geometry, houseW, h, houseD, hash01(x, z, 3));
        body.position.set(x, h / 2 + 0.3, z);
        body.castShadow = true;
        body.receiveShadow = true;
        this.group.add(body);
        // gable roof: two slabs leaning into a ridge along the house depth
        for (const dir of [-1, 1]) {
          const slope = new THREE.Mesh(new THREE.BoxGeometry(houseW * 0.62, 0.18, houseD + 0.6), roofMat);
          slope.position.set(x + dir * houseW * 0.26, h + 0.55, z);
          slope.rotation.z = dir * 0.42;
          slope.castShadow = true;
          this.group.add(slope);
        }
        // door and two windows facing the gang
        const face = x - side * (houseW / 2 + 0.02);
        const door = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.0, 0.9), doorMat);
        door.position.set(face, 1.3, z + rand(-1.6, 1.6));
        this.group.add(door);
        const glassMat = new THREE.MeshStandardMaterial({ color: 0x2b3a46, roughness: 0.3, metalness: 0.2 });
        for (const dz of [-2.4, 2.4]) {
          const win = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.9, 1.0), glassMat);
          win.position.set(face, 1.9, z + dz);
          this.group.add(win);
        }
        this.colliders.push({
          minX: x - houseW / 2, maxX: x + houseW / 2,
          minZ: z - houseD / 2, maxZ: z + houseD / 2, h,
        });
      }
    }
  }

  splitLots(area: any, count: any, cx: any, cz: any) {
    if (count === 2) {
      if (Math.random() < 0.5) {
        const w = area * rand(0.42, 0.55);
        return [
          [-area / 2 + w / 2, 0, w, area],
          [area / 2 - w / 2, 0, w, area],
        ];
      }
      const d = area * rand(0.42, 0.55);
      return [
        [0, -area / 2 + d / 2, area, d],
        [0, area / 2 - d / 2, area, d],
      ];
    }
    const w = area * rand(0.42, 0.5);
    const d = area * rand(0.42, 0.5);
    return [
      [-area / 2 + w / 2, -area / 2 + d / 2, w, d],
      [area / 2 - w / 2, -area / 2 + d / 2, w, d * rand(0.9, 1)],
      [0, area / 2 - d / 2, area * rand(0.7, 0.95), d],
    ].slice(0, count);
  }

  /**
   * Facade profile per district. A ruko in Glodok is a narrow shophouse with small windows and a
   * shutter; a tower in Thamrin is glass; Kota Tua is white plaster under clay tiles; a kampung
   * house is plaster with a couple of small openings. One recipe for the whole city is what made
   * every street look alike.
   */
  facadeProfile(district: string | null, h: number): { walls: number[]; style: 'grid' | 'strips' | 'bands'; shopfront: boolean } {
    switch (district) {
      case 'kotatua':
        return { walls: [0xe9e3d3, 0xf1ece0, 0xded6c4], style: 'grid', shopfront: true };
      case 'glodok':
      case 'blokm':
      case 'tanahabang':
        return { walls: [0xd9cfb8, 0xc8b99c, 0xb8c4c9, 0xd6c2a8, 0xc9a98f], style: 'grid', shopfront: true };
      case 'kampung':
        return { walls: [0xdcd2bd, 0xc9c3ae, 0xe4d9c2, 0xbfae95], style: 'grid', shopfront: false };
      case 'kemang':
        return { walls: [0xe3d9c4, 0xd3c6ad, 0xcbbfa6], style: 'grid', shopfront: true };
      case 'thamrin':
      case 'monas':
        return { walls: [0xb9c4cf, 0xa9b7c4, 0xc4cdd6], style: h > 30 ? 'bands' : 'strips', shopfront: false };
      default:
        return { walls: [0xd9cdb4, 0xc9d8c4, 0xe4c9c2], style: 'grid', shopfront: true };
    }
  }

  /**
   * Fittings for one street-facing facade: the roofline cornice, a ledge at every other slab,
   * and the equipment that makes a variant recognisable in silhouette.
   *
   * Everything is a plain box with vertex colours, collected per block group and merged into one
   * mesh at the end of generation, so the entire city's fittings cost one extra draw call per
   * block rather than one per building. The boxes exist because the brief is a *shadow* line
   * under the sun: a painted ledge cannot cast one.
   */
  addFacadeDetail(o: {
    x: number; z: number; w: number; d: number; h: number; yaw: number;
    baseY: number;
    fcx: number; fcz: number;   // centre of the street-facing face, world space
    faceLen: number;            // how wide that face is
    nx: number; nz: number;     // its outward normal
    variant: FacadeVariant; trim: number; accent: number; seed: number;
    source: 'block' | 'frontage';
    /** the block centre this building was placed for; null for a frontage row */
    block: [number, number] | null;
  }) {
    const { x, z, w, d, h, yaw, baseY, fcx, fcz, faceLen, nx, nz, variant, trim, accent, seed, source, block } = o;
    this.facadeAudit.push({ x, z, h, variant, trim, fcx, fcz, nx, nz, faceLen, baseY, source, block });
    if (h < 4.5 || faceLen < 4) return;
    const geos: THREE.BufferGeometry[] = [];
    const tx = Math.cos(yaw);
    const tz = -Math.sin(yaw);
    const floors = Math.max(1, Math.round(h / FACADE_TILE_H));

    const part = (along: number, y: number, out: number, la: number, lu: number, lo: number, color: number) => {
      const g = new THREE.BoxGeometry(la, lu, lo);
      paintGeometry(g, color);
      g.applyMatrix4(
        new THREE.Matrix4()
          .makeRotationY(yaw)
          .setPosition(fcx + tx * along + nx * out, baseY + y, fcz + tz * along + nz * out)
      );
      geos.push(g);
    };

    // Roofline cornice: one ring around the box, so the top of the wall drops a shadow line
    // onto the top storey instead of meeting the parapet flat.
    const ring = new THREE.BoxGeometry(w + 0.55, 0.28, d + 0.55);
    paintGeometry(ring, trim);
    ring.applyMatrix4(new THREE.Matrix4().makeRotationY(yaw).setPosition(x, baseY + h - 0.55, z));
    geos.push(ring);

    // Ledge courses at the slab edges: shallow, and only on the street face, which is the face
    // the player walks past. Every other slab, capped at four, so a 14-storey tower does not
    // pay for a ledge per floor.
    const every = floors > 8 ? 3 : 2;
    let ledges = 0;
    for (let f = every; f <= floors - 1 && ledges < 4; f += every) {
      part(0, f * FACADE_TILE_H, 0.15, faceLen + 0.4, 0.16, 0.3, trim);
      ledges++;
    }

    if (variant === 'balcony' && floors >= 2) {
      // A slab and a closed rail across two bays of the facade, like the ruko balconies in the
      // reference pack. One level only: at street level the eye reads the rail, not the count.
      const railLen = Math.min(faceLen * 0.86, 7.5);
      const depth = 0.85;
      const f = Math.min(2, floors - 1);
      const y = f * FACADE_TILE_H + 0.06;
      part(0, y, depth / 2, railLen, 0.12, depth, trim);
      part(0, y + 1.02, depth - 0.06, railLen, 0.06, 0.06, trim);
      part(0, y + 0.16, depth - 0.06, railLen, 0.05, 0.05, trim);
      const posts = Math.min(7, Math.max(3, Math.round(railLen / 2.2)));
      for (let i = 0; i < posts; i++) {
        const along = -railLen / 2 + (railLen * i) / (posts - 1);
        part(along, y + 0.6, depth - 0.06, 0.05, 1.0, 0.05, 0x3a3f45);
      }
    } else if (variant === 'pipes' && floors >= 1) {
      // Service pipes running the height of the wall, with their brackets and a drip shadow.
      const along = -faceLen / 2 + 0.8;
      const bottom = 2.6;
      const top = Math.max(bottom + 1, h - 0.9);
      const len = top - bottom;
      part(along, bottom + len / 2, 0.13, 0.16, len, 0.16, 0x8d9298);
      part(along - 0.26, bottom + len / 2, 0.08, 0.12, len, 0.12, 0x6f747a);
      for (let i = 0; i < 3; i++) {
        part(along, bottom + len * (0.25 + i * 0.3), 0.11, 0.42, 0.1, 0.22, 0x4c5055);
      }
    } else if (variant === 'ac') {
      // Condensers bolted to the wall on two floors, the way a ruko fills up with them.
      const n = Math.min(2, Math.max(1, floors - 1));
      for (let i = 0; i < n; i++) {
        const f = 1 + i * 2;
        if (f >= floors) break;
        part(faceLen * 0.24, f * FACADE_TILE_H + 0.62, 0.25, 0.82, 0.55, 0.46, 0xd9dad4);
      }
    } else if (variant === 'penthouse' && h > 9) {
      // Setback penthouse: the roof gets a second, smaller volume instead of a flat lid.
      const pw = Math.min(w * 0.58, w - 1.5);
      const pd = Math.min(d * 0.5, d - 1.5);
      const body = new THREE.BoxGeometry(pw, 2.7, pd);
      paintGeometry(body, 0xe6dfce);
      body.applyMatrix4(new THREE.Matrix4().makeRotationY(yaw).setPosition(x - nx * 0.4, baseY + h + 1.35, z - nz * 0.4));
      geos.push(body);
      const stub = new THREE.BoxGeometry(1.7, 2.0, 1.7);
      paintGeometry(stub, 0xcfc7b8);
      stub.applyMatrix4(
        new THREE.Matrix4().makeRotationY(yaw).setPosition(x + tx * (w * 0.26), baseY + h + 1.0, z + tz * (w * 0.26))
      );
      geos.push(stub);
    } else if (variant === 'signband') {
      // One painted band, on the second storey only. A tile cannot do this: the tile repeats
      // on every floor, so a band baked into it would stripe the whole building.
      const y = FACADE_TILE_H * 1.55;
      part(0, y, 0.07, faceLen * 0.94, 0.8, 0.14, accent);
      part(0, y - 0.47, 0.06, faceLen * 0.94, 0.08, 0.1, 0x3b342b);
      // a second, thinner band under it, so it reads as painted signage and not a stripe
      part(0, y + 0.5, 0.06, faceLen * 0.7, 0.16, 0.12, 0xf1e9d8);
    }
    void seed;

    const bucket = this.detailBuckets.get(this.group) ?? [];
    for (const g of geos) bucket.push(g);
    this.detailBuckets.set(this.group, bucket);
  }

  makeBuilding(x: number, z: number, w: number, d: number, h: number, blockX = x, blockZ = z, style: any = null, deck: FacadeVariant[] | null = null) {
    // One gate for every placement path. Block lots and street frontage both come through
    // here and each used to check only its own clearance: 462 pairs of buildings were
    // interpenetrating, the worst by 20 m, some sites used twice at identical coordinates.
    const rect = { minX: x - w / 2 - 0.4, maxX: x + w / 2 + 0.4, minZ: z - d / 2 - 0.4, maxZ: z + d / 2 + 0.4 };
    for (const f of this.footprints) {
      if (rect.minX < f.maxX && rect.maxX > f.minX && rect.minZ < f.maxZ && rect.maxZ > f.minZ) return null;
    }
    if (this.onRoad(x, z, 5.4)) return null;   // 3.6 m trotoar + ~1.8 m setback
    this.footprints.push(rect);

    // Draw the facade variant only now that the lot is really being built: a rejected site
    // used to consume a deck card, which is how a block of eight buildings could end up with
    // three distinct facades instead of seven.
    const facadeVariant: FacadeVariant = deck && deck.length ? deck.pop()! : pick(FACADE_VARIANTS);
    const variant = randInt(0, 2);
    const prof = this.facadeProfile(districtAtPoint(x, z), h);
    const wall = pick(prof.walls);
    const facade = prof.style;
    // One tile is one storey now, and the tile is stretched by the body's own UVs, so the
    // material key no longer carries a repeat: neighbouring buildings can share the canvas
    // instead of each owning a copy of it.
    const tex = windowTexture(wall, facade, facadeVariant);
    const emis = emissiveTexture(facade);

    const matKey = `${wall}|${facade}|${facadeVariant}`;
    let sideMat = this.buildingMatCache.get(matKey);
    if (!sideMat) {
      sideMat = new THREE.MeshStandardMaterial({
        map: tex,
        emissive: 0xffffff,
        emissiveMap: emis,
        emissiveIntensity: 0,
        roughness: 0.82,
        metalness: 0.06,
      });
      this.buildingMatCache.set(matKey, sideMat);
      this.emissiveMats.push(sideMat);
    }
    const roofMat = new THREE.MeshStandardMaterial({ color: style ? style.roof : 0x4a4a4c, roughness: 0.95 });
    const mats = [sideMat, sideMat, roofMat, roofMat, sideMat, sideMat];

    // Shopfront plinth, added directly to the block group. The merged path produced a mesh that
    // existed in the scene and never drew, three attempts running; a plain mesh that hangs off
    // the same group as the body cannot fail that way. Cost: one draw call per building.
    if (h > 4 && d > 5) {
      // One plinth mesh per building is one draw call per building: ~1,400 of them against the
      // whole rest of the frame. They share three materials, so the geometry is collected here
      // and merged into three meshes once the city is laid out.
      const pg = new THREE.BoxGeometry(w + 0.34, 3.2, d + 0.34);
      pg.translate(x, 1.9 + 0.2, z);
      this.plinthGeos[variant].push(pg);
    }

    // One draw call per building was the single largest cost in the frame. Bodies that share a
    // material come back as one mesh per block group, so distance culling still works per block
    // while the block itself costs a handful of calls instead of dozens.
    const bodyGeo = new THREE.BoxGeometry(w, h, d);
    bodyGeo.translate(x, h / 2 + 0.2, z);
    // per-building UV phase: no two neighbours' window columns line up
    facadeUV(bodyGeo, w, h, d, hash01(x, z, 3));
    const bucket = this.buildingBuckets.get(this.group) ?? new Map();
    const entry = bucket.get(matKey) ?? { mat: sideMat, geos: [] };
    // the roof faces use a separate material, so they stay a separate merged bucket
    entry.geos.push(bodyGeo);
    bucket.set(matKey, entry);
    this.buildingBuckets.set(this.group, bucket);
    void mats;

    // Roofline by building type. A flat parapet on every box is what made the city read as
    // "all the same": a low shophouse in a kampung has a pitched clay roof, an office tower has
    // a parapet. The roof is the silhouette the eye uses to separate one street from another.
    if (h <= 14) {
      const tileMat = new THREE.MeshStandardMaterial({ color: style ? style.roof : 0x8c4a3a, roughness: 0.95 });
      const pitch = Math.min(2.6, w * 0.16);
      for (const sgn of [-1, 1]) {
        const slope = new THREE.Mesh(new THREE.BoxGeometry(w + 0.7, 0.18, Math.hypot(d / 2 + 0.5, pitch)), tileMat);
        slope.position.set(x, h + 0.2 + pitch / 2, z + sgn * (d / 4 + 0.1));
        slope.rotation.x = sgn * Math.atan2(pitch, d / 2 + 0.5);
        slope.castShadow = true;
        this.group.add(slope);
      }
      // ridge cap
      const ridge = new THREE.Mesh(new THREE.BoxGeometry(w + 0.8, 0.16, 0.34), tileMat);
      ridge.position.set(x, h + 0.2 + pitch, z);
      this.group.add(ridge);
    } else {
      const parapet = new THREE.Mesh(
        new THREE.BoxGeometry(w + 0.34, 0.42, d + 0.34),
        new THREE.MeshStandardMaterial({ color: 0xd2d0d8, roughness: 0.9 })
      );
      parapet.position.set(x, h + 0.12, z);
      parapet.castShadow = true;
      this.group.add(parapet);
    }

    // occasional billboard with real text, like the reference storefronts
    if (Math.random() < 0.6 && h < 34) {
      const words = style ? [...style.signs, 'DISKON', 'MURAH', 'BUKA 24 JAM'] : ['DISKON', 'MURAH', 'PROMO', 'GRATIS ONGKIR', 'BUKA 24 JAM', 'KOPI ENAK', 'SERVIS AC', 'KOSONG'];
      const word = pick(words);
      const bg = pick(['#e94f4f', '#2f6fd0', '#f2b134', '#39b54a', '#8a3ad9']);
      const boardTex = canvasTexture(256, 96, (ctx, cw, ch) => {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, cw, ch);
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(0, ch - 12, cw, 12);
        ctx.fillStyle = '#fff8e7';
        fitFont(ctx, word, cw - 24, 52);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(word, cw / 2, ch / 2);
      });
      const board = new THREE.Mesh(
        new THREE.BoxGeometry(Math.min(w * 0.8, 7), 2.3, 0.22),
        new THREE.MeshStandardMaterial({ map: boardTex, roughness: 0.6, emissive: 0xffffff, emissiveMap: boardTex, emissiveIntensity: 0.08 })
      );
      const faces = [
        [0, d / 2 + 0.12, 0],
        [0, -d / 2 - 0.12, Math.PI],
        [w / 2 + 0.12, 0, Math.PI / 2],
        [-w / 2 - 0.12, 0, -Math.PI / 2],
      ];
      const face = faces[Math.floor(rand(0, 4))];
      board.position.set(x + face[0], Math.min(h - 1.5, 8.5), z + face[1]);
      board.rotation.y = face[2];
      board.castShadow = true;
      this.group.add(board);
    }

    // roof furniture
    if (Math.random() < 0.7) {
      const ac = box(rand(1.5, 3), rand(0.8, 1.4), rand(1.5, 3), 0x6c6f74);
      ac.position.set(x + rand(-w / 3, w / 3), h + 0.2 + (ac.geometry as any).parameters.height / 2, z + rand(-d / 3, d / 3));
      this.group.add(ac);
    }
    if (h > 28 && Math.random() < 0.7) {
      const mast = box(0.22, rand(4, 10), 0.22, 0x8d9199, { metalness: 0.6, roughness: 0.4 });
      mast.position.set(x + rand(-w / 3, w / 3), h + 0.2 + (mast.geometry as any).parameters.height / 2, z + rand(-d / 3, d / 3));
      this.group.add(mast);
    }
    // ground-floor storefront wrap (all sides) + signs
    if (!this.shopTextures) {
      this.shopTextures = [
        shopTexture({ wall: '#5c5650', awning: '#a8352f' }),
        shopTexture({ wall: '#4d5560', awning: '#2f6f7a' }),
        shopTexture({ wall: '#635748', awning: '#b3892f' }),
        shopTexture({ wall: '#4a4f4a', awning: '#3f7a4a' }),
      ];
    }
    const shopTex = pick(this.shopTextures).clone();
    shopTex.needsUpdate = true;
    shopTex.wrapS = shopTex.wrapT = THREE.RepeatWrapping;
    shopTex.repeat.set(Math.max(1, Math.round(Math.max(w, d) / 9)), 1);
    const shopMat = new THREE.MeshStandardMaterial({ map: shopTex, roughness: 0.55, emissive: 0xffffff, emissiveMap: shopTex, emissiveIntensity: 0.06 });
    this.shopMats = this.shopMats || [];
    this.shopMats.push(shopMat);
    const band = new THREE.Mesh(new THREE.BoxGeometry(w + 0.24, 2.9, d + 0.24), shopMat);
    band.position.set(x, 1.45, z);
    band.castShadow = true;
    band.receiveShadow = true;
    this.group.add(band);

    // plesetan, bukan merek asli
    const shopWords = ['ALFAMURTI', 'INDOMERET', 'WARTEG BAHARI', 'BAKSO PAK TJE', 'MIE GACUAN', 'SATE SENAYUN',
      'PULSA PERDANU', 'APOTEK SEHAT', 'BENGKEL AHOS', 'KOPI TUBRUK', 'TOKO EMAS MULYA', 'LAUNDRY KILAT',
      'PANGKAS RAMBUT', 'MARTABAK BANGKOK', 'NASI PADANG SELONGSOR', 'JAMU GENDONG'];
    const word = pick(shopWords);
    const signColor = pick(['#ffd257', '#ff6b6b', '#64d2ff', '#a8ff8f', '#ff9f43', '#f2f2f6']);
    const signTex = canvasTexture(256, 64, (ctx, cw, ch) => {
      ctx.fillStyle = signColor;
      ctx.fillRect(0, 0, cw, ch);
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.fillRect(0, ch - 7, cw, 7);
      ctx.fillStyle = '#241f1a';
      fitFont(ctx, word, cw - 16, 34);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(word, cw / 2, ch / 2 - 1);
    });
    // entrance: the door sits on the facade that faces the street (away from the
    // block centre), so no shop is left facing a neighbour's wall
    const dx = x - blockX;
    const dz = z - blockZ;
    const faceX = Math.abs(dx) > Math.abs(dz);
    const outward = (faceX ? dx : dz) >= 0 ? 1 : -1;
    const nx = faceX ? outward : 0;
    const nz = faceX ? 0 : outward;
    const doorYaw = Math.atan2(nx, nz);
    const tx = nz; // tangent along the facade
    const tz = -nx;
    const doorX = faceX ? x + nx * (w / 2 + 0.02) : x + (w > d ? -w * 0.22 : 0);
    const doorZ = faceX ? z + (d > w ? -d * 0.22 : 0) : z + nz * (d / 2 + 0.02);
    // Upper-storey fittings on the face that actually meets the street: cornice, ledge course
    // and the variant's own hardware. Same normal as the door, so the shop and its balconies
    // are on the same side of the building.
    const faceHalf = Math.abs(nx) * (w / 2) + Math.abs(nz) * (d / 2);
    this.addFacadeDetail({
      x, z, w, d, h,
      yaw: doorYaw,
      baseY: 0.2,
      fcx: x + nx * faceHalf,
      fcz: z + nz * faceHalf,
      faceLen: Math.abs(nx) * d + Math.abs(nz) * w,
      nx,
      nz,
      variant: facadeVariant,
      trim: trimFor(wall),
      accent: SIGN_BAND_COLORS[Math.floor(hash01(x, z, 7) * SIGN_BAND_COLORS.length)],
      seed: hash01(x, z, 11),
      source: 'block',
      block: [blockX, blockZ],
    });
    this.doorMatrices.push(new THREE.Matrix4().makeRotationY(doorYaw).setPosition(doorX + nx * 0.06, 1.42, doorZ + nz * 0.06));
    this.handleMatrices.push(
      new THREE.Matrix4().makeTranslation(doorX + tx * 0.45 + nx * 0.14, 1.35, doorZ + tz * 0.45 + nz * 0.14)
    );
    // remember this entrance as an enterable shop
    if (w > 6.5 && d > 6.5) {
      const kind = SHOP_KINDS[this.shopDoorKindCursor++ % SHOP_KINDS.length];
      const room = this.roomFor(kind);
      if (room) {
        // two doors inside a few metres make "nearest shop" ambiguous, so only the first one
        // becomes enterable; the shopfront sign still goes up either way
        const ex = doorX + nx * 1.1;
        const ez = doorZ + nz * 1.1;
        const crowded = this.shopDoors.some((dd) => Math.hypot(dd.x - ex, dd.z - ez) < 8);
        if (!crowded) this.shopDoors.push({ x: ex, z: ez, nx, nz, kind, name: room.name });
        // physical shop sign above the door so the street reads Indonesian
        const boardTex = canvasTexture(512, 96, (ctx, cw, ch) => {
          ctx.fillStyle = KIND_SIGN[kind];
          ctx.fillRect(0, 0, cw, ch);
          ctx.fillStyle = '#ffffff';
          fitFont(ctx, room.name, cw - 40, 46);
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(room.name, cw / 2, ch / 2 + 1);
        });
        const withBoard = Math.random() < 0.5;
        const board = new THREE.Mesh(
          new THREE.BoxGeometry(4.4, 0.9, 0.16),
          new THREE.MeshStandardMaterial({ map: boardTex, emissive: 0xffffff, emissiveMap: boardTex, emissiveIntensity: 0.25, roughness: 0.55 })
        );
        if (withBoard) {
          board.position.set(doorX + nx * 0.18, 3.55, doorZ + nz * 0.18);
          board.rotation.y = doorYaw;
          board.castShadow = true;
          this.group.add(board);
        }
        // welcome mat
        const mat2 = new THREE.Mesh(
          new THREE.BoxGeometry(2.0, 0.04, 0.8),
          new THREE.MeshStandardMaterial({ color: KIND_MAT[kind], roughness: 0.95 })
        );
        if (withBoard) {
          mat2.position.set(doorX + nx * 0.55, 0.29, doorZ + nz * 0.55);
          mat2.rotation.y = doorYaw;
          this.group.add(mat2);
        }
      }
    }

    for (let s2 = 0; s2 < 2; s2++) {
      const m = new THREE.Matrix4().makeRotationY(doorYaw);
      m.setPosition(doorX + nx * (0.28 + s2 * 0.28), 0.2 + s2 * 0.13, doorZ + nz * (0.28 + s2 * 0.28));
      this.stepMatrices.push({ m, scale: 1.9 - s2 * 0.25 });
    }

    const signMat = new THREE.MeshStandardMaterial({
      map: signTex,
      emissive: 0xffffff,
      emissiveMap: signTex,
      emissiveIntensity: 0.12,
      roughness: 0.55,
    });
    for (const side of [1, -1]) {
      const signZ = new THREE.Mesh(new THREE.BoxGeometry(w * rand(0.3, 0.5), 0.72, 0.14), signMat);
      signZ.position.set(x, 3.3, z + side * (d / 2 + 0.2));
      this.group.add(signZ);
      const signX = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.72, d * rand(0.25, 0.4)), signMat);
      signX.position.set(x + side * (w / 2 + 0.2), 3.3, z);
      this.group.add(signX);
    }

    if (Math.random() < 0.5) {
      const awningMat = new THREE.MeshStandardMaterial({ color: pick([0xd94f4f, 0x3f8fbf, 0xe0a83f, 0x4fae6a]), roughness: 0.8 });
      const along = faceX ? d : w;
      const aw = new THREE.Mesh(new THREE.BoxGeometry(along * 0.7, 0.18, 1.6), awningMat);
      aw.position.set(doorX + nx * 0.8, 3.2, doorZ + nz * 0.8);
      aw.rotation.y = doorYaw;
      aw.castShadow = true;
      this.group.add(aw);
    }

    this.colliders.push({
      minX: x - w / 2,
      maxX: x + w / 2,
      minZ: z - d / 2,
      maxZ: z + d / 2,
      h: h + 0.2,
    });

    // remember which facade faces the street so spanduk banners can be strung there
    this.facades.push({ x, z, w, d, faceX, dir: outward });
  }

  decorateBlockEdge(cx: any, cz: any) {
    const half = BLOCK / 2 - 1.6;
    const lamps = [
      [-half, -half],
      [half, half],
    ];
    for (const [ox, oz] of lamps) {
      this.lampPoles.push(new THREE.Matrix4().makeTranslation(cx + ox, 2.6, cz + oz));
      this.lampArms.push(new THREE.Matrix4().makeTranslation(cx + ox + (ox > 0 ? -0.7 : 0.7), 5.15, cz + oz));
      this.lampHeads.push(new THREE.Matrix4().makeTranslation(cx + ox + (ox > 0 ? -1.3 : 1.3), 5.05, cz + oz));
      this.lampPositions.push(new THREE.Vector3(cx + ox + (ox > 0 ? -1.3 : 1.3), 5.05, cz + oz));
    }
    // one sidewalk tree per block
    if (Math.random() < 0.75) {
      const s = rand(0.85, 1.25);
      const tx = cx + pick([-half, half]) + rand(-1, 1);
      const tz = cz + pick([-half, half]) + rand(-1, 1);
      const trunk = new THREE.Matrix4().makeTranslation(tx, 1.8 * s + 0.26, tz);
      trunk.scale(new THREE.Vector3(s, s, s));
      this.treeTrunks.push(trunk);
      const crown = new THREE.Matrix4().makeTranslation(tx, 4.3 * s + 0.26, tz);
      crown.scale(new THREE.Vector3(s, s, s));
      this.treeCrowns.push(crown);
    }
  }

  tree(x: number, z: number, scale = 1) {
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22 * scale, 0.32 * scale, 3.2 * scale, 6),
      new THREE.MeshStandardMaterial({ color: 0x6b4f34, roughness: 1 })
    );
    trunk.position.set(x, 1.6 * scale + 0.28, z);
    trunk.castShadow = true;
    this.group.add(trunk);
    const leafMat = new THREE.MeshStandardMaterial({ color: pick([0x2bae4a, 0x1c7c3b, 0x39c455]), roughness: 1, flatShading: true });
    for (let i = 0; i < 2; i++) {
      const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(rand(1.5, 2.1) * scale, 0), leafMat);
      leaf.position.set(x + rand(-0.5, 0.5) * scale, (3.4 + i * 1.2) * scale, z + rand(-0.5, 0.5) * scale);
      leaf.castShadow = true;
      this.group.add(leaf);
    }
  }

  decoratePark(cx: any, cz: any) {
    for (let i = 0; i < 6; i++) {
      this.tree(cx + rand(-13, 13), cz + rand(-13, 13), rand(0.8, 1.3));
    }
    const benchMat = new THREE.MeshStandardMaterial({ color: 0x8a5f33, roughness: 1 });
    for (let i = 0; i < 3; i++) {
      const seat = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.16, 0.7), benchMat);
      const bx = cx + rand(-12, 12);
      const bz = cz + rand(-12, 12);
      seat.position.set(bx, 0.85, bz);
      seat.castShadow = true;
      this.group.add(seat);
      this.colliders.push({ minX: bx - 1.1, maxX: bx + 1.1, minZ: bz - 0.35, maxZ: bz + 0.35, h: 0.9 });
    }
  }

  decorateLot(cx: any, cz: any) {
    const mat = new THREE.MeshStandardMaterial({ color: pick([0x8d3f3f, 0x3f5f8d, 0xd8d2c4, 0x3f7a45, 0xc07a2a]) });
    for (let i = 0; i < 4; i++) {
      const car = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.7, 4.2), mat);
      body.position.y = 0.72;
      body.castShadow = true;
      car.add(body);
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.62, 1.9), new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.3, metalness: 0.1 }));
      cabin.position.set(0, 1.32, -0.15);
      cabin.castShadow = true;
      car.add(cabin);
      const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 10);
      const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1b1b1e, roughness: 0.9 });
      for (const [wx, wz] of [[-0.95, 1.35], [0.95, 1.35], [-0.95, -1.35], [0.95, -1.35]]) {
        const w = new THREE.Mesh(wheelGeo, wheelMat);
        w.rotation.z = Math.PI / 2;
        w.position.set(wx, 0.36, wz);
        car.add(w);
      }
      const px = cx + rand(-11, 11);
      const pz = cz + rand(-11, 11);
      car.position.set(px, 0.28, pz);
      car.rotation.y = Math.random() < 0.5 ? 0 : Math.PI / 2;
      this.group.add(car);
      this.colliders.push({
        minX: px - 1.2,
        maxX: px + 1.2,
        minZ: pz - 1.6,
        maxZ: pz + 1.6,
        h: 1.6,
      });
    }
    this.tree(cx - 13, cz - 13, 1);
  }

  addProps() {
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x9a6b3a, roughness: 0.95 });
    const barrelMat = new THREE.MeshStandardMaterial({ color: 0xc0453d, roughness: 0.7, metalness: 0.3 });
    for (let i = 0; i < 26; i++) {
      const p = this.randomSidewalkPoint();
      const isBarrel = Math.random() < 0.5;
      const m = new THREE.Mesh(
        isBarrel
          ? new THREE.CylinderGeometry(0.45, 0.45, 1.3, 10)
          : new THREE.BoxGeometry(1.1, 1.1, 1.1),
        isBarrel ? barrelMat : crateMat
      );
      m.position.set(p.x, isBarrel ? 0.9 : 0.8, p.z);
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
      this.colliders.push({
        minX: p.x - 0.6,
        maxX: p.x + 0.6,
        minZ: p.z - 0.6,
        maxZ: p.z + 0.6,
        h: 1.4,
      });
    }
    // street furniture (instanced: one draw call per prop type)
    const binMat = new THREE.MeshStandardMaterial({ color: 0x3f7a4a, roughness: 0.9 });
    const hydrantMat = new THREE.MeshStandardMaterial({ color: 0xd93b3b, roughness: 0.7 });
    const benchMat = new THREE.MeshStandardMaterial({ color: 0x9a6b3a, roughness: 0.95 });
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x2c2f36, roughness: 0.8 });
    const binGeo = new THREE.CylinderGeometry(0.3, 0.26, 0.85, 8);
    const hydrantGeo = new THREE.CylinderGeometry(0.16, 0.19, 0.62, 8);
    const benchGeo = new THREE.BoxGeometry(1.9, 0.14, 0.55);
    const lightGeo = new THREE.BoxGeometry(0.28, 0.34, 0.28);

    const binM = [], hydM = [], benchM = [], lightM = [], lightLampM = [], lightArmM = [], lightBaseM = [];
    for (let i = 0; i < 34; i++) {
      const pt = this.randomSidewalkPoint();
      const which = Math.random();
      const m = new THREE.Matrix4();
      if (which < 0.4) {
        m.makeTranslation(pt.x, 0.69, pt.z);
        binM.push(m);
      } else if (which < 0.75) {
        m.makeTranslation(pt.x, 0.57, pt.z);
        hydM.push(m);
      } else {
        const rot = new THREE.Matrix4().makeRotationY(Math.random() < 0.5 ? 0 : Math.PI / 2);
        rot.setPosition(pt.x, 0.72, pt.z);
        benchM.push(rot);
      }
    }
    // traffic lights on the corner of each block
    for (let i = -GRID; i <= GRID; i++) {
      for (let j = -GRID; j <= GRID; j++) {
        const cx = i * PITCH + BLOCK / 2 - 1.2;
        const cz = j * PITCH + BLOCK / 2 - 1.2;
        lightBaseM.push(new THREE.Matrix4().makeTranslation(cx, 3.9, cz));
        lightM.push(new THREE.Matrix4().makeTranslation(cx, 2.0, cz));     // road surface → 4.0
        lightArmM.push(new THREE.Matrix4().makeTranslation(cx, 4.24, cz)); // arm on top
        lightLampM.push(new THREE.Matrix4().makeTranslation(cx, 3.58, cz + 0.17));
      }
    }
    // Drop only the entries this pass re-places. Clearing the whole list (the old behaviour)
    // made the haltes and carts invisible to the audit, but keeping the stale stall entries
    // flagged them against the terrain instead of the kerb they were later moved onto.
    const REPLACED = new Set(['bin', 'hydrant', 'bench', 'bench-leg', 'traffic-mast', 'traffic-arm', 'traffic-lens', 'traffic-housing', 'stall']);
    this.propAudit = this.propAudit.filter((e) => !REPLACED.has(e.name));
    // Ground props used to assume a kerb wherever the old grid said there was one. With
    // organic blocks a kerb exists only on real plates, so drop the instances that land on
    // asphalt and lift the rest onto the plate they actually stand on.
    const ON_KERB = new Set(['bin', 'hydrant', 'bench', 'bench-leg', 'traffic-mast', 'traffic-arm', 'traffic-lens', 'traffic-housing']);
    const addInstanced = (geo: any, material: any, rawMatrices: THREE.Matrix4[], cast = true, name = 'prop', audit = true) => {
      let matrices = rawMatrices;
      if (ON_KERB.has(name)) {
        const kept: THREE.Matrix4[] = [];
        for (const m of rawMatrices) {
          const pos = new THREE.Vector3().setFromMatrixPosition(m);
          if (this.groundHeightAt(pos.x, pos.z) <= 0) continue;
          // One contract: a prop's base sits on the ground under it. The matrices were authored
          // against two different floors (road-level for traffic lights, kerb-level 0.26 for the
          // rest), so the correction is the delta between the real ground and that assumed
          // floor - not the raw terrain height, which double-counts the kerb on a plate.
          const assumedBase = name.startsWith('traffic-') ? 0 : 0.26;
          const lifted = m.clone();
          lifted.elements[13] += this.groundHeightAt(pos.x, pos.z) - assumedBase;
          kept.push(lifted);
        }
        matrices = kept;
      }
      if (!matrices.length) return null;
      const mesh = new THREE.InstancedMesh(geo, material, matrices.length);
      matrices.forEach((m: THREE.Matrix4, i: number) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = cast;
      mesh.frustumCulled = false;
      mesh.name = name;
      this.group.add(mesh);
      if (!audit) return mesh;
      geo.computeBoundingBox();
      const localBottom = geo.boundingBox.min.y;
      matrices.forEach((m: THREE.Matrix4) => {
        const p = new THREE.Vector3().setFromMatrixPosition(m);
        this.propAudit.push({ name, x: p.x, z: p.z, bottom: p.y + localBottom });
      });
      return mesh;
    };
    addInstanced(binGeo, binMat, binM, true, 'bin');
    addInstanced(hydrantGeo, hydrantMat, hydM, true, 'hydrant');
    addInstanced(benchGeo, benchMat, benchM, true, 'bench');
    addInstanced(
      new THREE.BoxGeometry(0.11, 0.42, 0.45),
      new THREE.MeshStandardMaterial({ color: 0x2c2f36, roughness: 0.9 }),
      benchM.flatMap((m) => {
        const p = new THREE.Vector3().setFromMatrixPosition(m);
        const rot = new THREE.Euler().setFromRotationMatrix(m);
        return [-0.72, 0.72].map((off) => {
          const t = new THREE.Matrix4().makeRotationY(rot.y);
          t.setPosition(p.x + Math.cos(rot.y) * off, 0.47, p.z - Math.sin(rot.y) * off);
          return t;
        });
      }),
      true,
      'bench-leg'
    );
    addInstanced(new THREE.BoxGeometry(0.26, 4.0, 0.26), poleMat, lightM, true, 'traffic-mast');
    addInstanced(new THREE.BoxGeometry(0.9, 0.12, 0.12), poleMat, lightArmM, true, 'traffic-arm');
    addInstanced(new THREE.BoxGeometry(0.34, 0.86, 0.3), lightGeo, lightBaseM.map((m) => {
      const t = m.clone();
      const p = new THREE.Vector3().setFromMatrixPosition(m);
      t.makeTranslation(p.x, 4.0, p.z);
      return t;
    }), true, 'traffic-housing');
    addInstanced(new THREE.BoxGeometry(0.3, 0.2, 0.3), new THREE.MeshStandardMaterial({ color: 0xffd24a, emissive: 0xffb020, emissiveIntensity: 0.6 }), lightLampM, false, 'traffic-lens');

    // Indonesian street dressing sits on top of the generic props
    this.addStreetDressing(addInstanced);

    // stunt ramps on straight road segments
    this.addRamp(-PITCH * 1.5, 6, 0);
    this.addRamp(PITCH * 1.5, -PITCH * 2, Math.PI);
    this.addRamp(-PITCH * 2, -PITCH * 1.5, Math.PI / 2);
    this.addRamp(PITCH * 2.5, PITCH * 2.5, -Math.PI / 2);
  }

  /**
   * Indonesian street dressing, placed procedurally and sunk to `groundHeightAt`:
   * warung tenda (tarp, table, benches, hanging banner), parked angkot, becak,
   * spanduk strung on shop facades, a pos ronda and parkir boards.
   *
   * Repeated parts are batched into one InstancedMesh per part, so the whole layer
   * costs a few dozen draw calls instead of hundreds of individual meshes.
   */
  addStreetDressing(add: InstancedAdder) {
    const yAxis = new THREE.Vector3(0, 1, 0);
    // local -> world, rotated by yaw around the prop origin, y is absolute
    const place = (px: number, pz: number, yaw: number, lx: number, ly: number, lz: number) => {
      const off = new THREE.Vector3(lx, 0, lz).applyAxisAngle(yAxis, yaw);
      return new THREE.Matrix4().compose(
        new THREE.Vector3(px + off.x, ly, pz + off.z),
        new THREE.Quaternion().setFromAxisAngle(yAxis, yaw),
        new THREE.Vector3(1, 1, 1)
      );
    };
    const facing = (px: number, pz: number, yaw: number, lx: number, ly: number, lz: number) =>
      new THREE.Matrix4().compose(
        new THREE.Vector3(px + lx, ly, pz + lz),
        new THREE.Quaternion().setFromAxisAngle(yAxis, yaw),
        new THREE.Vector3(1, 1, 1)
      );

    const cityBlocks = this.blocks.filter((b) => b.type === 'city');
    const nearBlocks = cityBlocks
      .filter((b) => Math.abs(b.x) <= PITCH && Math.abs(b.z) <= PITCH)
      .sort((a, b) => Math.abs(a.x) + Math.abs(a.z) - (Math.abs(b.x) + Math.abs(b.z)));
    const anchors = (nearBlocks.length >= 3 ? nearBlocks : cityBlocks).slice(0, 4);
    if (!anchors.length) return;

    // ------------------------------------------------------------ warung tenda
    const stripes = canvasTexture(64, 64, (ctx, w, h) => {
      ctx.fillStyle = '#f6f9fd';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#2f6fd0';
      for (let x = 0; x < w; x += 16) ctx.fillRect(x, 0, 8, h);
      ctx.fillStyle = 'rgba(0,0,0,0.09)';
      for (let x = 0; x < w; x += 16) ctx.fillRect(x + 8, 0, 2, h);
    });
    stripes.wrapS = stripes.wrapT = THREE.RepeatWrapping;
    stripes.repeat.set(4, 1);
    const tarpMat = new THREE.MeshStandardMaterial({ map: stripes, roughness: 0.88, side: THREE.DoubleSide });
    const tentWood = new THREE.MeshStandardMaterial({ color: 0x9a6b3a, roughness: 0.95 });
    const tentBench = new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.85 });
    const tentSteel = new THREE.MeshStandardMaterial({ color: 0x8f959d, roughness: 0.45, metalness: 0.55 });
    const bannerMat = (text: string, bg: string, fg = '#fffaf0') =>
      new THREE.MeshStandardMaterial({
        map: canvasTexture(512, 96, (ctx, w, h) => {
          ctx.fillStyle = bg;
          ctx.fillRect(0, 0, w, h);
          ctx.fillStyle = 'rgba(0,0,0,0.15)';
          ctx.fillRect(0, h - 9, w, 9);
          ctx.fillStyle = fg;
          ctx.font = 'bold 54px ui-sans-serif, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(text, w / 2, h / 2 + 2);
        }),
        roughness: 0.8,
        side: THREE.DoubleSide,
      });

    const stallLegs: THREE.Matrix4[] = [];
    const stallRoofs: THREE.Matrix4[] = [];
    const stallValance: THREE.Matrix4[] = [];
    const stallTable: THREE.Matrix4[] = [];
    const stallTableLeg: THREE.Matrix4[] = [];
    const stallBench: THREE.Matrix4[] = [];
    const stallBenchLeg: THREE.Matrix4[] = [];
    const stallPot: THREE.Matrix4[] = [];
    const stallBanners: THREE.Matrix4[][] = [[], [], []];
    const stallTexts: [string, string][] = [['WARUNG KOPI', '#c0392b'], ['MIE INSTAN', '#e0a83f'], ['PROMO', '#2f6f9f']];
    const stallBannerMats = stallTexts.map(([text, bg]) => bannerMat(text, bg));

    const stallAlong = [-7, 2.5, 8];
    for (let i = 0; i < Math.min(3, anchors.length); i++) {
      const b = anchors[i];
      let px = b.x + stallAlong[i % stallAlong.length];
      let pz = b.z + ((b.size ?? BLOCK) / 2) - 2.7;
      const yaw = 0; // faces the street (+z)
      // a stall needs a kerb under it: if the spot landed on asphalt, pull it onto the nearest
      // block instead of dropping it, so the street keeps its warungs
      const nudged = this.nudgeOntoKerb(px, pz);
      const g = this.groundHeightAt(nudged.x, nudged.z);
      if (g <= 0) continue;
      px = nudged.x;
      pz = nudged.z;
      this.dressingSpots.push({ type: 'warung', x: px, z: pz, yaw });
      for (const [lx, lz] of [[-1.55, -1.15], [1.55, -1.15], [-1.55, 1.15], [1.55, 1.15]]) {
        stallLegs.push(place(px, pz, yaw, lx, g + 1.05, lz));
      }
      stallRoofs.push(place(px, pz, yaw, 0, g + 2.16, 0));
      stallValance.push(place(px, pz, yaw, 0, g + 1.99, 1.42));
      stallTable.push(place(px, pz, yaw, 0, g + 0.79, 0.15));
      for (const [lx, lz] of [[-0.62, -0.2], [0.62, -0.2], [-0.62, 0.5], [0.62, 0.5]]) {
        stallTableLeg.push(place(px, pz, yaw, lx, g + 0.37, lz));
      }
      for (const bz of [-0.4, 0.7]) {
        stallBench.push(place(px, pz, yaw, 0, g + 0.46, bz));
        for (const lx of [-0.62, 0.62]) stallBenchLeg.push(place(px, pz, yaw, lx, g + 0.23, bz));
      }
      stallPot.push(place(px, pz, yaw, 0.45, g + 0.9, 0.15));
      // one banner across the front valance, a second one hanging on the side
      stallBanners[i % 3].push(facing(px, pz, yaw, 0, g + 1.62, 1.46));
      stallBanners[(i + 1) % 3].push(
        new THREE.Matrix4().compose(
          new THREE.Vector3(px + 1.52, g + 1.62, pz + 0.1),
          new THREE.Quaternion().setFromAxisAngle(yAxis, Math.PI / 2),
          new THREE.Vector3(1, 1, 1)
        )
      );
      // table + benches are solid, the space under the tarp stays walkable
      this.colliders.push({ minX: px - 0.85, maxX: px + 0.85, minZ: pz - 0.25, maxZ: pz + 0.55, h: 0.9 });
      for (const bz of [-0.4, 0.7]) {
        this.colliders.push({ minX: px - 0.8, maxX: px + 0.8, minZ: pz + bz - 0.18, maxZ: pz + bz + 0.18, h: 0.6 });
      }
    }
    add(new THREE.BoxGeometry(0.08, 2.1, 0.08), tentSteel, stallLegs, true, 'warung-leg');
    add(new THREE.BoxGeometry(3.6, 0.1, 2.9), tarpMat, stallRoofs, true, 'warung-tarp', false);
    add(new THREE.BoxGeometry(3.6, 0.34, 0.06), tarpMat, stallValance, true, 'warung-valance', false);
    add(new THREE.BoxGeometry(1.5, 0.08, 0.75), tentWood, stallTable, true, 'warung-table', false);
    add(new THREE.BoxGeometry(0.07, 0.74, 0.07), tentSteel, stallTableLeg, true, 'warung-table-leg');
    add(new THREE.BoxGeometry(1.5, 0.08, 0.34), tentBench, stallBench, true, 'warung-bench', false);
    add(new THREE.BoxGeometry(0.06, 0.46, 0.06), tentSteel, stallBenchLeg, true, 'warung-bench-leg');
    add(new THREE.BoxGeometry(0.22, 0.2, 0.22), new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.6 }), stallPot, true, 'warung-kettle', false);
    stallBannerMats.forEach((mat, i) => add(new THREE.PlaneGeometry(2.7, 0.5), mat, stallBanners[i], false, 'warung-banner', false));

    // ------------------------------------------------------------ parked angkot
    const angkotTex = canvasTexture(512, 128, (ctx, w, h) => {
      ctx.fillStyle = '#2f6fd0';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#f7fbff';
      ctx.fillRect(0, 0, w, 14);
      ctx.fillStyle = '#f7fbff';
      ctx.font = 'bold 82px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('ANGKOT', w / 2, h / 2 + 4);
    });
    const angkotMat = new THREE.MeshStandardMaterial({ map: angkotTex, roughness: 0.55 });
    for (let i = 0; i < 2; i++) {
      const b = anchors[i];
      const px = b.x + (i === 0 ? 1.5 : -8);
      const pz = b.z + BLOCK / 2 + 3.6; // first lane against the curb
      const yaw = Math.PI / 2;
      const g = this.groundHeightAt(px, pz);
      const angkot = new Car(this.scene, { type: 'angkot', color: i === 0 ? 0x2f6fd0 : 0x2fa89a, position: new THREE.Vector3(px, g, pz), yaw });
      angkot.addDriver(...driverLook());
      for (const sx of [-1, 1]) {
        const decal = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.44), angkotMat);
        decal.position.set(sx * 0.87, 0.95, 0.05);
        decal.rotation.y = (sx * Math.PI) / 2;
        angkot.mesh.add(decal);
      }
      this.propAudit.push({ name: 'angkot', x: px, z: pz, bottom: g });
      this.colliders.push({ minX: px - 2.3, maxX: px + 2.3, minZ: pz - 1.1, maxZ: pz + 1.1, h: 2.1 });
      this.dressingSpots.push({ type: 'angkot', x: px, z: pz, yaw });
    }

    // ------------------------------------------------------------ becak
    const becakBody = new THREE.MeshStandardMaterial({ color: 0x2f6f9f, roughness: 0.6, metalness: 0.2 });
    const becakSeat = new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.9 });
    const becakHood = new THREE.MeshStandardMaterial({ color: 0xf2b134, roughness: 0.85, side: THREE.DoubleSide });
    const rearWheelGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.12, 12);
    rearWheelGeo.rotateZ(Math.PI / 2);
    const frontWheelGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.1, 12);
    frontWheelGeo.rotateZ(Math.PI / 2);
    const becakSpots = [
      { x: anchors[0].x - 3.4, z: anchors[0].z + ((anchors[0].size ?? BLOCK) / 2) - 3.2, yaw: Math.PI / 2 },
      { x: anchors[1].x + 5.2, z: anchors[1].z + ((anchors[1].size ?? BLOCK) / 2) - 3.2, yaw: Math.PI / 2 },
    ].map((sp) => {
      const n = this.nudgeOntoKerb(sp.x, sp.z);
      return { x: n.x, z: n.z, yaw: sp.yaw };
    });
    const bFrame: THREE.Matrix4[] = [], bSeat: THREE.Matrix4[] = [], bBack: THREE.Matrix4[] = [];
    const bHood: THREE.Matrix4[] = [], bPost: THREE.Matrix4[] = [], bBoard: THREE.Matrix4[] = [];
    const bRear: THREE.Matrix4[] = [], bFront: THREE.Matrix4[] = [];
    const bDriver: THREE.Matrix4[] = [], bBar: THREE.Matrix4[] = [];
    for (const s of becakSpots) {
      const g = this.groundHeightAt(s.x, s.z);
      this.dressingSpots.push({ type: 'becak', x: s.x, z: s.z, yaw: s.yaw });
      for (const sx of [-1, 1]) bRear.push(place(s.x, s.z, s.yaw, sx * 0.62, g + 0.4, -0.25));
      bFront.push(place(s.x, s.z, s.yaw, 0, g + 0.3, 0.95));
      bFrame.push(place(s.x, s.z, s.yaw, 0, g + 0.52, -0.2));
      bSeat.push(place(s.x, s.z, s.yaw, 0, g + 0.74, -0.05));
      bBack.push(place(s.x, s.z, s.yaw, 0, g + 1.0, -0.34));
      bHood.push(place(s.x, s.z, s.yaw, 0, g + 1.78, 0.05));
      for (const [lx, lz] of [[-0.55, -0.42], [0.55, -0.42], [-0.55, 0.52], [0.55, 0.52]]) {
        bPost.push(place(s.x, s.z, s.yaw, lx, g + 1.34, lz));
      }
      bBoard.push(place(s.x, s.z, s.yaw, 0, g + 0.44, 0.62));
      bDriver.push(place(s.x, s.z, s.yaw, 0, g + 0.74, 0.42));
      bBar.push(place(s.x, s.z, s.yaw, 0, g + 1.02, 0.86));
      this.colliders.push({ minX: s.x - 1.15, maxX: s.x + 1.15, minZ: s.z - 0.75, maxZ: s.z + 0.75, h: 1.8 });
    }
    add(new THREE.BoxGeometry(1.15, 0.12, 0.6), becakBody, bFrame, true, 'becak-frame', false);
    add(new THREE.BoxGeometry(0.98, 0.12, 0.52), becakSeat, bSeat, true, 'becak-seat', false);
    add(new THREE.BoxGeometry(0.98, 0.46, 0.1), becakSeat, bBack, true, 'becak-back', false);
    add(new THREE.BoxGeometry(1.16, 0.08, 1.2), becakHood, bHood, true, 'becak-canopy', false);
    add(new THREE.BoxGeometry(0.05, 1.0, 0.05), tentSteel, bPost, true, 'becak-post', false);
    add(new THREE.BoxGeometry(1.0, 0.08, 0.36), tentWood, bBoard, true, 'becak-footboard', false);
    add(new THREE.BoxGeometry(0.42, 0.1, 0.4), becakSeat, bDriver, true, 'becak-driver-seat', false);
    add(new THREE.BoxGeometry(0.52, 0.05, 0.05), tentSteel, bBar, true, 'becak-handlebar', false);
    add(rearWheelGeo, new THREE.MeshStandardMaterial({ color: 0x1b1b1e, roughness: 0.9 }), bRear, true, 'becak-wheel', true);
    add(frontWheelGeo, new THREE.MeshStandardMaterial({ color: 0x1b1b1e, roughness: 0.9 }), bFront, true, 'becak-wheel', true);

    // ------------------------------------------------------------ spanduk on facades
    const spandukTexts: [string, string][] = [['SEDANG PROMO', '#c0392b'], ['DISKON 20%', '#e0a83f'], ['BUKA 24 JAM', '#2f6f9f']];
    const spandukMats = spandukTexts.map(([text, bg]) => bannerMat(text, bg));
    const spanduk: THREE.Matrix4[][] = [[], [], []];
    const spandukRope: THREE.Matrix4[] = [];
    const spandukStrap: THREE.Matrix4[] = [];
    const nearFacades = this.facades
      .filter((f) => Math.abs(f.x) < PITCH * 1.8 && Math.abs(f.z) < PITCH * 1.8)
      .sort((a, b) => Math.hypot(a.x - anchors[0].x, a.z - anchors[0].z) - Math.hypot(b.x - anchors[0].x, b.z - anchors[0].z));
    nearFacades.forEach((f, i) => {
      // the three facades closest to the first warung always get a banner, so the
      // street around spawn reads Indonesian from any angle
      if (i >= 3 && i % 2 === 1) return;
      const along = f.faceX ? f.d : f.w;
      const width = Math.min(5.6, Math.max(3.2, along * 0.8));
      const px = f.faceX ? f.x + f.dir * (f.w / 2 + 0.32) : f.x;
      const pz = f.faceX ? f.z : f.z + f.dir * (f.d / 2 + 0.32);
      const yaw = f.faceX ? (f.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : f.dir > 0 ? 0 : Math.PI;
      const g = this.groundHeightAt(px, pz);
      const y = g + 4.7;
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(px, y, pz),
        new THREE.Quaternion().setFromAxisAngle(yAxis, yaw),
        new THREE.Vector3(width / 5.2, 1, 1)
      );
      spanduk[i % 3].push(m);
      // rope above the cloth + two straps, so it reads as strung on the facade
      spandukRope.push(place(px, pz, yaw, 0, y + 0.6, 0));
      for (const sx of [-1, 1]) spandukStrap.push(place(px, pz, yaw, (sx * width) / 2.6, y + 0.3, 0));
      this.dressingSpots.push({ type: 'spanduk', x: px, z: pz, yaw });
    });
    spandukMats.forEach((mat, i) => add(new THREE.PlaneGeometry(5.2, 0.86), mat, spanduk[i], false, 'spanduk', false));
    add(new THREE.BoxGeometry(5.6, 0.05, 0.05), tentSteel, spandukRope, false, 'spanduk-rope', false);
    add(new THREE.BoxGeometry(0.04, 0.62, 0.04), tentSteel, spandukStrap, false, 'spanduk-strap', false);

    // ------------------------------------------------------------ pos ronda + parkir
    const rondaBlock = anchors[0];
    const rx = rondaBlock.x + BLOCK / 2 - 4.2;
    const rz = rondaBlock.z - BLOCK / 2 + 4.2;
    const rg = this.groundHeightAt(rx, rz);
    const hutRoof = new THREE.MeshStandardMaterial({ color: 0x9a5a3a, roughness: 0.85 });
    const hutBase = box(2.4, 0.16, 2.4, 0xb4aea0);
    hutBase.position.set(rx, rg + 0.08, rz);
    this.group.add(hutBase);
    this.propAudit.push({ name: 'pos-ronda', x: rx, z: rz, bottom: rg });
    const hutBack = box(2.2, 2.0, 0.14, 0xe8e2d2);
    hutBack.position.set(rx, rg + 1.16, rz - 1.12);
    this.group.add(hutBack);
    for (const sx of [-1, 1]) {
      const side = box(0.14, 2.0, 2.2, 0xd8d2c2);
      side.position.set(rx + sx * 1.12, rg + 1.16, rz);
      this.group.add(side);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.16, 2.9), hutRoof);
    roof.position.set(rx, rg + 2.26, rz);
    roof.castShadow = true;
    this.group.add(roof);
    const hutBench = box(1.7, 0.12, 0.5, 0x9a6b3a);
    hutBench.position.set(rx, rg + 0.66, rz - 0.7);
    this.group.add(hutBench);
    const rondaTex = canvasTexture(256, 96, (ctx, w, h) => {
      ctx.fillStyle = '#2f5d3a';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#f4ffe9';
      ctx.font = 'bold 40px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('POS RONDA', w / 2, h / 2 + 2);
    });
    const rondaSign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.7, 0.55),
      new THREE.MeshStandardMaterial({ map: rondaTex, roughness: 0.7, side: THREE.DoubleSide })
    );
    rondaSign.position.set(rx, rg + 1.95, rz + 1.2);
    this.group.add(rondaSign);
    this.colliders.push({ minX: rx - 1.2, maxX: rx + 1.2, minZ: rz - 1.2, maxZ: rz - 0.2, h: 2.3 });
    this.dressingSpots.push({ type: 'pos-ronda', x: rx, z: rz, yaw: 0 });

    const parkirTex = canvasTexture(256, 128, (ctx, w, h) => {
      ctx.fillStyle = '#1d4f8f';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#eaf2ff';
      ctx.lineWidth = 8;
      ctx.strokeRect(6, 6, w - 12, h - 12);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 58px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('PARKIR', w / 2, h / 2 + 2);
    });
    const parkirMat = new THREE.MeshStandardMaterial({ map: parkirTex, roughness: 0.6, side: THREE.DoubleSide });
    const parkirPost: THREE.Matrix4[] = [];
    const parkirBoard: THREE.Matrix4[] = [];
    for (const b of anchors.slice(1, 3)) {
      const px = b.x - BLOCK / 2 + 5.4;
      const pz = b.z + BLOCK / 2 - 2.4;
      const yaw = Math.PI / 2;
      const g = this.groundHeightAt(px, pz);
      parkirPost.push(place(px, pz, yaw, 0, g + 0.9, 0));
      parkirBoard.push(place(px, pz, yaw, 0, g + 1.85, 0));
      this.dressingSpots.push({ type: 'parkir', x: px, z: pz, yaw });
      this.colliders.push({ minX: px - 0.3, maxX: px + 0.3, minZ: pz - 0.3, maxZ: pz + 0.3, h: 1.9 });
    }
    add(new THREE.BoxGeometry(0.08, 1.8, 0.08), tentSteel, parkirPost, true, 'parkir-post');
    add(new THREE.BoxGeometry(1.0, 0.55, 0.05), parkirMat, parkirBoard, true, 'parkir-board', false);
  }

  addRamp(x: number, z: number, rotY: any) {
    const g = new THREE.Group();
    const geo = new THREE.BoxGeometry(5, 0.4, 9);
    const mat = new THREE.MeshStandardMaterial({ color: 0xe0b23a, roughness: 0.7 });
    const ramp = new THREE.Mesh(geo, mat);
    ramp.rotation.x = -0.32;
    ramp.position.y = 1.4;
    ramp.castShadow = true;
    ramp.receiveShadow = true;
    g.add(ramp);
    g.position.set(x, 0, z);
    g.rotation.y = rotY;
    this.group.add(g);
    this.jumpPads.push({
      pos: new THREE.Vector3(x, 0, z),
      dir: new THREE.Vector3(Math.sin(rotY), 0, Math.cos(rotY)),
      radius: 3.4,
    });
  }

  /**
   * Start on the Thamrin-Sudirman spine just north of Bundaran HI: a real street in the
   * dense part of the map, so the first thing the player sees is the city, not a field.
   */
  getSpawn() {
    const spine = ARTERIALS[0].path;
    const [ax, az] = spine[1];
    const [bx, bz] = spine[2];
    const t = 0.55;
    const baseX = ax + (bx - ax) * t;
    const baseZ = az + (bz - az) * t;
    const inside = (x: number, z: number) =>
      this.colliders.some((c) => x > c.minX - 1 && x < c.maxX + 1 && z > c.minZ - 1 && z < c.maxZ + 1);
    // walk along the spine until a point is free: spawning inside a wall made the camera start
    // inside a building and every shot hit a wall at zero distance
    // the spawn guard has to look clear of street furniture too: a halte platform, a cart or a
    // parked ojek on the kerb is enough to pin the player, which is what "walked 1 m" was
    const clearOf = (x: number, z: number) =>
      this.colliders.every((c) => x < c.minX - 3 || x > c.maxX + 3 || z < c.minZ - 3 || z > c.maxZ + 3);
    // Start on the carriageway, not on a plate. snapToVerge pulls a point onto the nearest
    // block plate so props have a kerb to stand on -- using it here put the player on a park
    // lawn at y = 0.56 m, two metres from the asphalt, which is why the street looked like a
    // plain pale surface with no road under him.
    if (clearOf(baseX, baseZ)) return new THREE.Vector3(baseX, 0, baseZ);
    for (const d of [3, -3, 6, -6, 9, -9, 12, -12, 18, -18, 24, -24]) {
      for (const dz of [0, 6, -6, 12, -12, 20, -20]) {
        const x = baseX + d;
        const z = baseZ + dz;
        if (!inside(x, z) && clearOf(x, z)) return new THREE.Vector3(x, 0, z);
      }
    }
    return new THREE.Vector3(baseX, 0, baseZ);
  }

  /**
   * Show only the blocks near the player. The city is 2.5 km across, so drawing all of it
   * costs ~2k draw calls; at street level the player sees a 400 m bubble anyway.
   */
  updateCulling(x: number, z: number, radius = 220) {
    const r2 = radius * radius;
    for (const b of this.blockGroups) {
      const dx = b.x - x;
      const dz = b.z - z;
      b.group.visible = dx * dx + dz * dz < r2;
    }
  }


  /**
   * Street frontage: buildings that line the roads, facing them.
   *
   * Square blocks on a lattice always leave a ~60 m empty margin along a road (the corridor
   * the block centre has to clear), which is what made the city read as a wide empty plain
   * with buildings in the distance. A city is a wall of buildings with a road in front, so
   * the rows are laid along each road here: depth behind, facade toward the asphalt.
   */

  /**
   * A shopfront ring around every block building: the plinth that turns a slab into a ruko.
   * Collected as raw geometry and merged into one mesh, so the whole city's shopfronts cost a
   * single draw call.
   */
  flushShopfronts() {
    if (!this.shopfrontGeos || !this.shopfrontGeos.length) return;
    const merged = mergeGeometries(this.shopfrontGeos, false);
    if (merged) {
      const mesh = new THREE.Mesh(merged, shopfrontMat());
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      (this.rootGroup ?? this.group).add(mesh);
    }
    this.shopfrontGeos.forEach((g) => g.dispose());
    this.shopfrontGeos = [];
  }

  buildFrontage() {
    const roads = [...ARTERIALS.map((a) => ({ path: a.path, width: a.width })), { path: RING_ROAD, width: 20 }];
    for (const road of roads) {
      for (let i = 0; i < road.path.length - 1; i++) {
        const [x1, z1] = road.path[i];
        const [x2, z2] = road.path[i + 1];
        const len = Math.hypot(x2 - x1, z2 - z1);
        const dx = (x2 - x1) / len;
        const dz = (z2 - z1) / len;
        const nx = -dz;
        const nz = dx;
        // one deck per street segment: the row mixes its facades instead of repeating one tile
        const segmentDeck = facadeDeck();
        for (const side of [-1, 1]) {
          let t = 6;
          while (t < len - 6) {
            const w = rand(8, 26);        // frontage width along the street
            const d = rand(12, 20);       // depth behind the facade
            // A real row mixes shop-houses with towers. A 7-26 m band produced one flat
            // skyline; one in five is now a taller building and one in six a low shophouse.
            const r = rand(0, 1);
            const h = r < 0.16 ? rand(4.5, 7) : r < 0.8 ? rand(8, 22) : rand(24, 46);
            const px = x1 + dx * (t + w / 2) + nx * side * (road.width / 2 + 6.2 + d / 2);
            const pz = z1 + dz * (t + w / 2) + nz * side * (road.width / 2 + 6.2 + d / 2);
            const district = districtAtPoint(px, pz);
            const styleKey = (district === 'gambir' ? 'monas' : district) as keyof typeof DISTRICTS;
            const style = DISTRICTS[styleKey] || DISTRICTS.kampung;
            let onRoad = false;
            for (const other of roads) {
              if (this.distToPath(px, pz, other.path) < other.width / 2 + 2) { onRoad = true; break; }
            }
            // The frontage row never asked whether the ground was already taken, so it built
            // straight through block lots: 462 pairs of interpenetrating buildings, worst 20 m.
            // It also never checked its own footprint against the road it faces.
            const foot = {
              minX: px - Math.max(w, d) / 2 - 0.4, maxX: px + Math.max(w, d) / 2 + 0.4,
              minZ: pz - Math.max(w, d) / 2 - 0.4, maxZ: pz + Math.max(w, d) / 2 + 0.4,
            };
            const taken = this.footprints.some((f) => foot.minX < f.maxX && foot.maxX > f.minX && foot.minZ < f.maxZ && foot.maxZ > f.minZ);
            if (!onRoad && !isWater(px, pz) && !taken) {
              this.footprints.push(foot);
              const fv = segmentDeck.length ? segmentDeck.pop()! : pick(FACADE_VARIANTS);
              const group = new THREE.Group();
              group.position.set(px, terrainHeight(px, pz), pz);
              group.rotation.y = Math.atan2(dx, dz);
              // Facade variety: Jakarta rows are cream, mint, pink and grey shophouses next to
              // tiled offices, not one glass curtain wall repeated. The material is per
              // building anyway, so mixing the palette and the window type costs no draw calls.
              const PASTELS = [0xd9cdb4, 0xe8dfcb, 0xc9d8c4, 0xe4c9c2, 0xb9c7d4, 0xd6c9a8, 0xcfcfc8, 0xb8a894];
              const wall = rand(0, 1) < 0.45 ? pick(PASTELS) : pick(style.walls);
              const facade = pick(['strips', 'grid', 'bands'] as const);
              // One tile is one storey. The repeat lives in the body's UVs, so the material --
              // and the canvas behind it -- is shared with every other building that landed on
              // the same colour, layout and variant.
              const tex = windowTexture(wall, facade, fv);
              const fkey = `frontage|${wall}|${facade}|${fv}`;
              let mat = this.buildingMatCache.get(fkey);
              if (!mat) {
                mat = new THREE.MeshStandardMaterial({
                  map: tex,
                  emissive: 0xffffff,
                  emissiveMap: emissiveTexture(facade),
                  emissiveIntensity: 0,
                  roughness: 0.9,
                });
                this.buildingMatCache.set(fkey, mat);
                this.emissiveMats.push(mat);
              }
              // world transform of the body: rotate by the row angle, then move to its slot
              const frontY = terrainHeight(px, pz) + 0.3;
              const bodyGeo = new THREE.BoxGeometry(w, h, d);
              facadeUV(bodyGeo, w, h, d, hash01(px, pz, 3));
              bodyGeo.rotateY(group.rotation.y);
              bodyGeo.translate(px, frontY + h / 2, pz);
              const fe = this.frontageBuckets.get(fkey) ?? { mat, geos: [] };
              fe.geos.push(bodyGeo);
              this.frontageBuckets.set(fkey, fe);
              // the same fittings the block lots get, on the face that meets the street
              const fYaw = group.rotation.y;
              const fnx = -Math.sin(fYaw);
              const fnz = -Math.cos(fYaw);
              this.addFacadeDetail({
                x: px, z: pz, w, d, h,
                yaw: fYaw,
                baseY: frontY,
                fcx: px + fnx * (d / 2),
                fcz: pz + fnz * (d / 2),
                faceLen: w,
                nx: fnx,
                nz: fnz,
                variant: fv,
                trim: trimFor(wall),
                accent: SIGN_BAND_COLORS[Math.floor(hash01(px, pz, 7) * SIGN_BAND_COLORS.length)],
                seed: hash01(px, pz, 11),
                source: 'frontage',
                block: null,
              });
              // a shopfront band at street level so the row is not one blank slab
              const base = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 3.2, 0.3), shopfrontMat());
              base.position.set(0, 1.9, -d / 2 - 0.16);
              group.add(base);

              this.group.add(group);
              // collider in world space (axis-aligned box around the rotated footprint)
              const halfX = (Math.abs(Math.cos(group.rotation.y)) * w + Math.abs(Math.sin(group.rotation.y)) * d) / 2;
              const halfZ = (Math.abs(Math.sin(group.rotation.y)) * w + Math.abs(Math.cos(group.rotation.y)) * d) / 2;
              this.colliders.push({ minX: px - halfX, maxX: px + halfX, minZ: pz - halfZ, maxZ: pz + halfZ, h });
            }
            t += w + rand(1.5, 4.5);
          }
        }
      }
    }
  }


  /**
   * The landforms that make the horizon read as Jakarta: the Bogor foothills sitting behind
   * the southern edge of the map, and the raised tanggul that run along every flood canal.
   *
   * The heightfield in src/world/terrain.ts gives the ground its shape, but a displaced plane
   * is still a plane: at 18 m per quad the rise is invisible. These are real geometry with
   * silhouettes, and they are what tells the eye the city sits on land that goes somewhere.
   */
  buildTerrainFeatures() {
    // 1. the foothills: low, wide ridges beyond the last row of blocks
    const hillMat = new THREE.MeshStandardMaterial({ color: 0x4a5f45, roughness: 1, flatShading: true });
    const hillMatFar = new THREE.MeshStandardMaterial({ color: 0x51657f, roughness: 1, flatShading: true });
    const edge = WORLD_HALF;
    for (let i = 0; i < 9; i++) {
      const x = -edge + 200 + i * (edge * 2 - 400) / 8 + rand(-70, 70);
      const r = rand(150, 260);
      const h = rand(50, 100);
      // outside the last block, not on top of it: a 400 m cone centred at the edge
      // reaches 400 m into town and reads as a green slab hanging over the street
      const z = edge + r * rand(0.55, 0.95);
      const geo = new THREE.ConeGeometry(r, h, 7, 1);
      const hill = new THREE.Mesh(geo, i % 3 === 0 ? hillMatFar : hillMat);
      hill.position.set(x, terrainHeight(x, Math.min(z, edge - 1)) + h / 2 - 10, z);
      hill.rotation.y = rand(0, Math.PI);
      hill.scale.set(1, 1, rand(0.6, 1.1));
      this.group.add(hill);
    }

    // 2. the canals themselves: water in the middle, a concrete tanggul either side. The
    // heightfield cannot cut a channel this narrow at 18 m per quad, so it is a mesh.
    const bankMat = new THREE.MeshStandardMaterial({ color: 0x7d786a, roughness: 0.95 });
    const waterMat = new THREE.MeshStandardMaterial({ color: 0x2b5a63, roughness: 0.22, metalness: 0.35 });
    for (const river of RIVERS) {
      const surf = new THREE.Mesh(this.ribbon(river.path, river.width - 3, 0.3), waterMat);
      surf.receiveShadow = true;
      this.group.add(surf);
      for (const side of [-1, 1]) {
        const offsets: [number, number][] = [];
        const pts = river.path;
        for (let i = 0; i < pts.length - 1; i++) {
          const [x1, z1] = pts[i];
          const [x2, z2] = pts[i + 1];
          const len = Math.hypot(x2 - x1, z2 - z1) || 1;
          const nx = -(z2 - z1) / len;
          const nz = (x2 - x1) / len;
          const off = river.width / 2 + 3.2;
          offsets.push([x1 + nx * off * side, z1 + nz * off * side]);
          offsets.push([x2 + nx * off * side, z2 + nz * off * side]);
        }
        const band = new THREE.Mesh(this.ribbon(offsets, 6.4, 0.42), bankMat);
        band.receiveShadow = true;
        band.castShadow = true;
        this.group.add(band);
      }
    }
  }

  // sidewalk plate height (blocks sit ~26cm above the asphalt)
  groundHeightAt(x: number, z: number) {
    // terrain first, then the kerb: the city sits on ground that is no longer a table
    const h = terrainHeight(x, z);
    for (const b of this.blocks) {
      const half = (b.size ?? BLOCK) / 2 + 1.2; // props stand at the plate edge, not the centre
      if (Math.abs(x - b.x) < half && Math.abs(z - b.z) < half) return h + 0.26;
    }
    // the trotoar beside every arterial is the same 26 cm of concrete as a block plate, and
    // everything places itself through this function: without this test every halte, cart and
    // ojek on the pavement stood 26 cm inside the slab the moment it became visible
    const band = this.pavementBand(x, z);
    if (band) return h + band;
    return h;
  }

  /**
   * How far above the terrain the pavement is at (x, z), 0 when there is none.
   *
   * Only the arterials and the ring carry a trotoar ribbon (3.6 m of paving behind a 30 cm kerb);
   * a local street is asphalt and nothing else, so a point beside one is just ground.
   */
  pavementBand(x: number, z: number): number {
    for (const road of WALK_ROADS) {
      const d = this.distToPath(x, z, road.path);
      const e = road.width / 2;
      // the kerb cap ends at half+0.20, the paving runs 3.6 m behind it
      if (d >= e + 0.2 && d <= e + 3.8) return 0.26;
    }
    return 0;
  }

  randomRoadPoint(minDistFrom = null, min = 40) {
    for (let tries = 0; tries < 60; tries++) {
      const i = randInt(-GRID, GRID);
      const axis = Math.random() < 0.5 ? 'x' : 'z';
      const along = rand(-GRID * PITCH, GRID * PITCH);
      const across = (i + 0.5) * PITCH;
      const p = axis === 'x' ? new THREE.Vector3(across, 0, along) : new THREE.Vector3(along, 0, across);
      const off = rand(-ROAD * 0.35, ROAD * 0.35);
      if (axis === 'x') p.x += off;
      else p.z += off;
      if (!minDistFrom || p.distanceTo(minDistFrom) > min) return p;
    }
    return new THREE.Vector3(0, 0, 0);
  }

  randomParkingSpot() {
    // Park along the roads that exist (the arterials and the ring), not the retired grid.
    // A spot has to sit on asphalt and stay clear of kerbs, stalls and landmarks: a car
    // spawned wedged against a collider cannot move, which showed up as
    // "vehicle accelerates :: 0 km/h" and as cars hanging 26 cm over a kerb plate.
    for (let attempt = 0; attempt < 24; attempt++) {
      const road = pick([...ARTERIALS, { path: RING_ROAD, width: 20 } as any]);
      const pts: [number, number][] = road.path;
      const seg = randInt(0, pts.length - 2);
      const [x1, z1] = pts[seg];
      const [x2, z2] = pts[seg + 1];
      const t = rand(0.12, 0.88);
      const bx = x1 + (x2 - x1) * t;
      const bz = z1 + (z2 - z1) * t;
      const dx = x2 - x1;
      const dz = z2 - z1;
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len;
      const nz = dx / len;
      const side = Math.random() < 0.5 ? -1 : 1;
      const off = road.width / 2 - 2.6;
      const pos = new THREE.Vector3(bx + nx * off * side, 0, bz + nz * off * side);
      if (this.distToPath(pos.x, pos.z, pts) > road.width / 2 - 1.6) continue;
      if (this.groundHeightAt(pos.x, pos.z) > 0) continue;      // must be on the road
      const yaw = Math.atan2(dx, dz) + (side > 0 ? 0 : Math.PI);
      const clear = this.colliders.every((b) => {
        const cx = Math.max(b.minX, Math.min(pos.x, b.maxX));
        const cz = Math.max(b.minZ, Math.min(pos.z, b.maxZ));
        return Math.hypot(pos.x - cx, pos.z - cz) > 3.0;
      });
      if (clear) return { pos, yaw };
    }
    // last resort: middle of the spine, which is always drivable
    return { pos: new THREE.Vector3(0, 0, rand(-70, 90)), yaw: Math.PI };
  }

  randomSidewalkPointAround(centre: any, minR = 14, maxR = 48) {
    // pick a block in the requested ring, then a point on its sidewalk
    const candidates = this.blocks.filter((b) => {
      const d = Math.hypot(b.x - centre.x, b.z - centre.z);
      return d >= minR && d <= maxR;
    });
    if (!candidates.length) return this.randomSidewalkPointNear(maxR + 20);
    const b = pick(candidates);
    // every block has its own footprint now, so the sidewalk ring has to follow it instead of
    // assuming the old 38 m cell
    // the pavement ring runs *outside* the block: frontage buildings line the block edge,
    // so a ring at size/2 - 2.2 walks pedestrians through the shop row
    const half = ((b.size ?? BLOCK) / 2) + 3.4;
    const t = rand(-half, half);
    const side = randInt(0, 3);
    if (side === 0) return new THREE.Vector3(b.x + t, 0, b.z - half);
    if (side === 1) return new THREE.Vector3(b.x + t, 0, b.z + half);
    if (side === 2) return new THREE.Vector3(b.x - half, 0, b.z + t);
    return new THREE.Vector3(b.x + half, 0, b.z + t);
  }

  randomSidewalkPointNear(maxR = 120) {
    for (let i = 0; i < 18; i++) {
      const p = this.randomSidewalkPoint();
      if (p.length() <= maxR) return p;
    }
    return this.randomSidewalkPoint();
  }

  randomSidewalkPoint() {
    // A pavement point is only useful if something can stand on it. Crates, barrels and cash
    // pickups are all placed with this call, and a point inside a bench or a halte produced a
    // pickup nobody could reach: the player is pushed out of the collider before the 1.7 m
    // radius is ever satisfied.
    let last = new THREE.Vector3();
    for (let attempt = 0; attempt < 14; attempt++) {
      const b = pick(this.blocks);
      const edge = Math.floor(rand(0, 4));
      const size = b.size ?? BLOCK;
      const off = size / 2 + 3.4;
      const t = rand(-size / 2 + 2, size / 2 - 2);
      if (edge === 0) last.set(b.x + t, 0, b.z - off);
      else if (edge === 1) last.set(b.x + t, 0, b.z + off);
      else if (edge === 2) last.set(b.x - off, 0, b.z + t);
      else last.set(b.x + off, 0, b.z + t);
      if (this.nearLayang(last.x, last.z, 6)) continue;
      const blocked = this.colliders.some(
        (c) => last.x > c.minX - 1.2 && last.x < c.maxX + 1.2 && last.z > c.minZ - 1.2 && last.z < c.maxZ + 1.2
      );
      if (!blocked) return last.clone();
    }
    return last;
  }

  update(dt: number, dayT: any) {
    this.dayT = dayT;
    const ang = dayT * TAU - Math.PI / 2;
    const sunY = Math.sin(ang);
    const sunX = Math.cos(ang);
    const elevation = clamp(sunY, -1, 1);
    const daylight = clamp(elevation * 1.6 + 0.25, 0, 1);

    const dayCol = new THREE.Color(0x35a8f0);
    const duskCol = new THREE.Color(0xff8a4a);
    const nightCol = new THREE.Color(0x0b1220);
    const sky = new THREE.Color();
    if (daylight > 0.55) {
      sky.copy(duskCol).lerp(dayCol, (daylight - 0.55) / 0.45);
    } else if (daylight > 0.12) {
      sky.copy(nightCol).lerp(duskCol, (daylight - 0.12) / 0.43);
    } else {
      sky.copy(nightCol);
    }
    this.scene.background.copy(sky);
    this.scene.fog.color.copy(sky);

    this.sun.intensity = 0.32 + daylight * 2.9;
    this.fill.intensity = 0.3 + daylight * 0.35;
    this.sun.color.setRGB(
      lerp(0.55, 1, daylight),
      lerp(0.65, 0.95, daylight),
      lerp(1.0, 0.85, daylight)
    );
    this.hemi.intensity = lerp(0.78, 0.95, daylight);
    this.hemi.color.setHex(daylight > 0.3 ? 0xbfd8ff : 0x4a5f8a);
    this.hemi.groundColor.setHex(daylight > 0.3 ? 0x8a8377 : 0x2a2b33);

    this.daylight = daylight;
    const night = 1 - clamp((daylight - 0.05) / 0.4, 0, 1);
    for (const m of this.emissiveMats) m.emissiveIntensity = night * 0.9;
    if (this.shopMats) for (const m of this.shopMats) m.emissiveIntensity = 0.05 + night * 0.9;
    for (const m of this.lampMats) m.emissiveIntensity = 0.15 + night * 2.2;

    if (this.focusTarget) this.updateNightLights(dayT, this.focusTarget);

    const dist = 130;
    this.sun.position.set(sunX * dist, Math.max(8, sunY * 130), 42);
  }

}