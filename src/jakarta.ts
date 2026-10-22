import * as THREE from 'three';
import { PITCH } from './city';
import { canvasTexture, rand, pick } from './utils';

/** shrink a label until it fits the drawn width */
function fitFont(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, startSize: number) {
  let size = startSize;
  ctx.font = `700 ${size}px system-ui, sans-serif`;
  while (ctx.measureText(text).width > maxWidth && size > 10) {
    size -= 2;
    ctx.font = `700 ${size}px system-ui, sans-serif`;
  }
  return size;
}

/**
 * Jakarta, shrunk to a 7x7 block map the way Los Santos shrinks Los Angeles.
 *
 * Every district borrows the one thing you would recognise from a photo of it: the marble
 * obelisk and open square of Monas, the white column and fountain of Bundaran HI, the Dutch
 * town hall and cobbles of Kota Tua, the shuttered shophouses of Glodok, the tarpaulin
 * market canyons of Tanah Abang, the tiled roofs and laundry lines of a kampung, the glass
 * offices of Sudirman, the low cafe rows of Kemang and the waterfront of Ancol.
 */
export type DistrictId =
  | 'monas'
  | 'thamrin'
  | 'kotatua'
  | 'glodok'
  | 'tanahabang'
  | 'kampung'
  | 'blokm'
  | 'kemang'
  | 'ancol';

export interface DistrictStyle {
  name: string;
  /** building height range in metres */
  heights: [number, number];
  /** how many lots a block splits into */
  lots: [number, number];
  /** facade colours sampled for this district */
  walls: number[];
  roof: number;
  /** signage this district actually has */
  signs: string[];
}

export const DISTRICTS: Record<DistrictId, DistrictStyle> = {
  monas: {
    name: 'Gambir',
    heights: [10, 18],
    lots: [2, 3],
    walls: [0xd8d2c4, 0xcfc7b6, 0xe3ddd0],
    roof: 0x8d8377,
    signs: ['MUSEUM', 'TAMAN', 'PLAZA'],
  },
  thamrin: {
    name: 'Thamrin',
    heights: [40, 84],
    lots: [1, 2],
    walls: [0x8fb4d6, 0xa9c3da, 0x7f97ae, 0xb8c6d2],
    roof: 0x5b6470,
    signs: ['OFFICE', 'HOTEL', 'MALL', 'BANK'],
  },
  kotatua: {
    name: 'Kota Tua',
    heights: [8, 14],
    lots: [2, 3],
    walls: [0xe8e2d2, 0xdcd4c0, 0xefe8d8],
    roof: 0xa8442f,
    signs: ['MUSEUM', 'KEDAI KOPI', 'TOKO ANTIK', 'GALERI'],
  },
  glodok: {
    name: 'Glodok',
    heights: [7, 13],
    lots: [3, 3],
    walls: [0xc9a86a, 0xb98d55, 0xd7bb84],
    roof: 0x9c3b2e,
    signs: ['TOKO EMAS', 'OBAT CINA', 'ELEKTRONIK', 'BAKMI'],
  },
  tanahabang: {
    name: 'Tanah Abang',
    heights: [10, 22],
    lots: [2, 3],
    walls: [0xbfae95, 0xa9a08c, 0xd0c3a6],
    roof: 0x7a6f60,
    signs: ['GROSIR', 'KAIN', 'GROSIR KAOS', 'PASAR'],
  },
  kampung: {
    name: 'Kampung',
    heights: [4, 7],
    lots: [3, 3],
    walls: [0xe0cba8, 0xd6b48f, 0xcfc0a0, 0xdcae94],
    roof: 0xb1503a,
    signs: ['WARUNG', 'LAUNDRY', 'BENGKEL', 'KOS'],
  },
  blokm: {
    name: 'Blok M',
    heights: [8, 16],
    lots: [2, 3],
    walls: [0xd3c7b0, 0xc2b7a2, 0xdccfb6],
    roof: 0x86796a,
    signs: ['TERMINAL', 'DEPOT', 'KARAOKE', 'SATE'],
  },
  kemang: {
    name: 'Kemang',
    heights: [6, 11],
    lots: [2, 2],
    walls: [0xe4dcc8, 0xd8ccb2, 0xcbbfa8],
    roof: 0x6f6656,
    signs: ['CAFE', 'BAR', 'GALLERY', 'BRUNCH'],
  },
  ancol: {
    name: 'Ancol',
    heights: [6, 12],
    lots: [2, 3],
    walls: [0xcfdcc8, 0xbfd0c2, 0xe0e6d4],
    roof: 0x5f7f6a,
    signs: ['PANTAI', 'SEAFOOD', 'DUFAN', 'MARINA'],
  },
};

// rows are z (north at the top), columns are x — the bay sits along the top edge
const GRID_MAP: DistrictId[][] = [
  ['ancol', 'ancol', 'kotatua', 'kotatua', 'ancol', 'ancol', 'ancol'],
  ['glodok', 'glodok', 'glodok', 'kotatua', 'ancol', 'ancol', 'ancol'],
  ['tanahabang', 'glodok', 'monas', 'monas', 'kemang', 'kemang', 'kemang'],
  ['tanahabang', 'tanahabang', 'monas', 'monas', 'kemang', 'kemang', 'kampung'],
  ['kampung', 'tanahabang', 'thamrin', 'thamrin', 'kampung', 'kampung', 'kampung'],
  ['kampung', 'kampung', 'thamrin', 'kampung', 'kampung', 'blokm', 'blokm'],
  ['kampung', 'kampung', 'blokm', 'blokm', 'blokm', 'kampung', 'kampung'],
];

export function districtAt(cx: number, cz: number): DistrictId {
  const gx = Math.round(cx / PITCH);
  const gz = Math.round(cz / PITCH);
  const row = GRID_MAP[Math.max(0, Math.min(GRID_MAP.length - 1, gz + 3))];
  return row[Math.max(0, Math.min(row.length - 1, gx + 3))];
}

/** Blocks that are a landmark instead of a normal lot. */
export function landmarkAt(cx: number, cz: number): 'monas' | 'bundaran' | 'kotatua' | null {
  const gx = Math.round(cx / PITCH);
  const gz = Math.round(cz / PITCH);
  if (gx === 0 && gz === 0) return 'monas';
  if (gx === 0 && gz === 1) return 'bundaran';
  if (gx === 0 && gz === -2) return 'kotatua';
  return null;
}

type Ctx = {
  group: any;
  colliders: any[];
  audit: { name: string; x: number; z: number; bottom: number }[];
};

function block(ctx: Ctx, mat: any, w: number, h: number, d: number, x: number, y: number, z: number) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  ctx.group.add(m);
  return m;
}

function solid(ctx: Ctx, w: number, d: number, x: number, z: number, h = 40) {
  ctx.colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, h });
}

/** Monas: marble plinth, tapering obelisk, gold flame, and the open square around it. */
export function buildMonas(ctx: Ctx, cx: number, cz: number) {
  const stone = new THREE.MeshStandardMaterial({ color: 0xe6e2d6, roughness: 0.72 });
  const marble = new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.5, metalness: 0.05 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xffcf4a, emissive: 0x7a5a12, emissiveIntensity: 0.5, metalness: 0.85, roughness: 0.28 });

  // paved square
  const plaza = new THREE.Mesh(new THREE.BoxGeometry(34, 0.14, 34), new THREE.MeshStandardMaterial({ color: 0xcfc9bc, roughness: 0.95 }));
  plaza.position.set(cx, 0.29, cz);
  plaza.receiveShadow = true;
  ctx.group.add(plaza);

  // the base: a wide stepped socle, like the real monument's goblet
  block(ctx, stone, 16, 1.2, 16, cx, 0.3, cz);
  block(ctx, marble, 11, 3.4, 11, cx, 1.5, cz);
  block(ctx, marble, 9, 1.1, 9, cx, 4.9, cz);

  // obelisk: four-sided taper, 26 m, matching the 132 m shaft scaled into this map
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 4.3, 24, 4), marble);
  shaft.position.set(cx, 6 + 12, cz);
  shaft.rotation.y = Math.PI / 4;
  shaft.castShadow = true;
  ctx.group.add(shaft);

  // flame: a gold cone sitting on a cup
  block(ctx, marble, 5.0, 1.5, 5.0, cx, 29.6, cz);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(2.0, 5.0, 6), gold);
  flame.position.set(cx, 31.1 + 2.6, cz);
  flame.castShadow = true;
  ctx.group.add(flame);
  solid(ctx, 11, 11, cx, cz, 40);

  // flag poles and hedges so the square is not an empty plate
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xd9d5cb, roughness: 0.6 });
  const hedge = new THREE.MeshStandardMaterial({ color: 0x3f7a3a, roughness: 0.95 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const px = cx + Math.cos(a) * 13.5;
    const pz = cz + Math.sin(a) * 13.5;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 7, 6), poleMat);
    pole.position.set(px, 3.8, pz);
    pole.castShadow = true;
    ctx.group.add(pole);
    block(ctx, hedge, 3.4, 0.8, 1.4, cx + Math.cos(a) * 15.5, 0.3, cz + Math.sin(a) * 15.5);
  }
}

/** Bundaran HI: white column on a round pool, the fountain ring at the centre of Jakarta. */
export function buildBundaran(ctx: Ctx, cx: number, cz: number) {
  const white = new THREE.MeshStandardMaterial({ color: 0xf4f2ec, roughness: 0.62 });
  const water = new THREE.MeshStandardMaterial({ color: 0x3fa9d8, roughness: 0.18, metalness: 0.25, transparent: true, opacity: 0.85 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xffd24a, emissive: 0x6b4d0d, emissiveIntensity: 0.45, metalness: 0.8, roughness: 0.3 });

  const grass = new THREE.Mesh(new THREE.CylinderGeometry(19, 19, 0.16, 32), new THREE.MeshStandardMaterial({ color: 0x4e8a44, roughness: 0.95 }));
  grass.position.set(cx, 0.28, cz);
  grass.receiveShadow = true;
  ctx.group.add(grass);

  const pool = new THREE.Mesh(new THREE.CylinderGeometry(8, 8.4, 0.9, 28), white);
  pool.position.set(cx, 0.75, cz);
  pool.castShadow = true;
  pool.receiveShadow = true;
  ctx.group.add(pool);

  const surface = new THREE.Mesh(new THREE.CylinderGeometry(7.2, 7.2, 0.2, 28), water);
  surface.position.set(cx, 1.2, cz);
  ctx.group.add(surface);

  // the Welcome Monument: a ring of columns holding a bowl, then a gold flame
  const base = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 4.2, 2.2, 20), white);
  base.position.set(cx, 2.2, cz);
  base.castShadow = true;
  ctx.group.add(base);

  const column = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.9, 12, 16), white);
  column.position.set(cx, 9, cz);
  column.castShadow = true;
  ctx.group.add(column);

  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(3.1, 2.1, 1.3, 20), white);
  bowl.position.set(cx, 15.6, cz);
  bowl.castShadow = true;
  ctx.group.add(bowl);

  const flame = new THREE.Mesh(new THREE.ConeGeometry(1.5, 3.4, 6), gold);
  flame.position.set(cx, 17.9, cz);
  flame.castShadow = true;
  ctx.group.add(flame);
  solid(ctx, 9, 9, cx, cz, 20);

  // a low ring of jets around the pool
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const jet = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.1, 5), water);
    jet.position.set(cx + Math.cos(a) * 10.5, 1.4, cz + Math.sin(a) * 10.5);
    ctx.group.add(jet);
  }
}

/** Kota Tua: cobbled square, the white town hall with its clock tower, shophouses behind. */
export function buildKotaTua(ctx: Ctx, cx: number, cz: number) {
  const white = new THREE.MeshStandardMaterial({ color: 0xf0ead9, roughness: 0.78 });
  const tile = new THREE.MeshStandardMaterial({ color: 0xa8442f, roughness: 0.9 });
  const cobble = new THREE.MeshStandardMaterial({ color: 0x9a958c, roughness: 0.98 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2a28, roughness: 0.7 });

  const square = new THREE.Mesh(new THREE.BoxGeometry(34, 0.12, 30), cobble);
  square.position.set(cx, 0.28, cz);
  square.receiveShadow = true;
  ctx.group.add(square);

  // Stadhuis: long white facade, hipped red roof, central clock tower
  block(ctx, white, 22, 7.2, 9, cx, 0.3, cz - 12);
  block(ctx, tile, 23.4, 1.5, 11.2, cx, 7.5, cz - 12);
  const tower = block(ctx, white, 7, 12.5, 7, cx, 0.3, cz - 12);
  void tower;
  const towerRoof = new THREE.Mesh(new THREE.ConeGeometry(5.4, 4.2, 4), tile);
  towerRoof.position.set(cx, 14.9, cz - 12);
  towerRoof.rotation.y = Math.PI / 4;
  towerRoof.castShadow = true;
  ctx.group.add(towerRoof);
  const clockTex = canvasTexture(128, 128, (c, w, h) => {
    c.fillStyle = '#f7f2e4';
    c.beginPath(); c.arc(w / 2, h / 2, w / 2 - 4, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#2b2a28'; c.lineWidth = 5; c.stroke();
    c.strokeStyle = '#2b2a28'; c.lineWidth = 6; c.lineCap = 'round';
    c.beginPath(); c.moveTo(w / 2, h / 2); c.lineTo(w / 2, h * 0.24); c.stroke();
    c.lineWidth = 4;
    c.beginPath(); c.moveTo(w / 2, h / 2); c.lineTo(w * 0.74, h * 0.56); c.stroke();
  });
  const clock = new THREE.Mesh(new THREE.CircleGeometry(1.05, 24), new THREE.MeshStandardMaterial({ map: clockTex, roughness: 0.6 }));
  clock.position.set(cx, 11.4, cz - 8.4);
  ctx.group.add(clock);
  solid(ctx, 23.4, 11.2, cx, cz - 12, 16);

  // shophouses along one side of the square
  for (let i = 0; i < 4; i++) {
    const sx = cx - 13.5 + i * 9;
    block(ctx, white, 8, 6.4, 8, sx, 0.3, cz + 12);
    block(ctx, tile, 8.8, 1.1, 8.8, sx, 6.7, cz + 12);
    const awning = block(ctx, new THREE.MeshStandardMaterial({ color: i % 2 ? 0x8f3b2a : 0x355a7a, roughness: 0.9 }), 8, 0.22, 2.2, sx, 3.3, cz + 8.2);
    awning.castShadow = true;
    solid(ctx, 8.4, 8.4, sx, cz + 12, 12);
  }

  // the old cannon and a couple of benches make the square feel used
  const bronze = new THREE.MeshStandardMaterial({ color: 0x4a4a3a, metalness: 0.5, roughness: 0.6 });
  const cannon = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.75, 3.6, 10), bronze);
  cannon.position.set(cx + 8, 1.1, cz + 1);
  cannon.rotation.z = Math.PI / 2;
  cannon.castShadow = true;
  ctx.group.add(cannon);

  // a canvas sign over the town hall so the name reads in-game
  const signTex = canvasTexture(512, 128, (c, w, h) => {
    c.fillStyle = '#1d2a3a';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#f4efe0';
    fitFont(c, 'MUSEUM KOTA TUA', w - 40, 62);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('MUSEUM KOTA TUA', w / 2, h / 2);
  });
  const sign = new THREE.Mesh(new THREE.BoxGeometry(14, 2.4, 0.3), new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.7, emissive: 0xffffff, emissiveMap: signTex, emissiveIntensity: 0.12 }));
  sign.position.set(cx, 9.4, cz - 6.9);
  ctx.group.add(sign);
}

/** Market tarpaulins for Tanah Abang and Glodok: cheap awnings over a dense block. */
export function buildMarketStalls(ctx: Ctx, cx: number, cz: number, count = 2) {
  const tarp = [0xd94f4f, 0x2f6fd0, 0xf2b134, 0x39b54a, 0xe07b2a];
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x8a8a86, roughness: 0.8 });
  for (let i = 0; i < count; i++) {
    const x = cx + rand(-11, 11);
    const z = cz + rand(-11, 11);
    const m = new THREE.MeshStandardMaterial({ color: pick(tarp), roughness: 0.92 });
    const roof = block(ctx, m, rand(3, 5), 0.16, rand(2.6, 4), x, 2.4, z);
    roof.rotation.y = rand(-0.3, 0.3);
    const table = block(ctx, poleMat, 2.4, 0.9, 1.8, x, 0.3, z);
    table.castShadow = true;
    ctx.audit.push({ name: 'stall', x, z, bottom: 0.3 });
  }
}

/**
 * Glodok gateway: a paifang over the road, modelled from the Pancoran Chinatown arch —
 * grey carved pillars, a terracotta roof with upturned eaves, and three gold-on-brown
 * signboards reading SELAMAT DATANG / KAWASAN GLODOK / PECINAN JAKARTA.
 */
export function buildGlodokGate(ctx: Ctx, cx: number, cz: number) {
  const stone = new THREE.MeshStandardMaterial({ color: 0x9a9791, roughness: 0.85 });
  const darkStone = new THREE.MeshStandardMaterial({ color: 0x6f6c67, roughness: 0.9 });
  const tile = new THREE.MeshStandardMaterial({ color: 0xa34a30, roughness: 0.88 });
  const bronze = new THREE.MeshStandardMaterial({ color: 0x5b4632, roughness: 0.7, metalness: 0.25 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xe8c464, roughness: 0.45, metalness: 0.55 });

  const span = 8.2; // half the clear width: the road is 14 m, the pillars sit on the kerbs
  for (const sx of [-1, 1]) {
    const base = block(ctx, darkStone, 2.2, 0.7, 2.2, cx + sx * span, 0.3, cz);
    base.castShadow = true;
    const pillar = block(ctx, stone, 1.5, 6.4, 1.5, cx + sx * span, 1.0, cz);
    pillar.castShadow = true;
    // carved band near the top of each pillar
    block(ctx, bronze, 1.75, 0.34, 1.75, cx + sx * span, 6.1, cz);
    solid(ctx, 2.2, 2.2, cx + sx * span, cz, 12);
  }

  // lintel + the three plaques
  block(ctx, stone, span * 2 + 2.2, 1.5, 1.7, cx, 7.4, cz);
  const plaques: [string, number, number][] = [
    ['SELAMAT DATANG', 7.0, 0.9],
    ['KAWASAN GLODOK', 8.5, 1.0],
    ['PECINAN JAKARTA', 10.0, 0.9],
  ];
  for (const [text, y, hgt] of plaques) {
    const tex = canvasTexture(512, 128, (c, w, h) => {
      c.fillStyle = '#4a3222';
      c.fillRect(0, 0, w, h);
      c.strokeStyle = '#c9a24a';
      c.lineWidth = 8;
      c.strokeRect(6, 6, w - 12, h - 12);
      c.fillStyle = '#f0d27a';
      fitFont(c, text, w - 46, 58);
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(text, w / 2, h / 2);
    });
    const plaque = new THREE.Mesh(
      new THREE.BoxGeometry(6.4, hgt, 0.18),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.16 })
    );
    plaque.position.set(cx, y, cz - 0.95);
    ctx.group.add(plaque);
    const backPlaque = plaque.clone();
    backPlaque.position.z = cz + 0.95;
    backPlaque.rotation.y = Math.PI;
    ctx.group.add(backPlaque);
  }

  // roof: two slabs meeting at a raised ridge, with the eaves kicked up at the corners
  for (const dir of [-1, 1]) {
    const slope = new THREE.Mesh(new THREE.BoxGeometry(span * 2 + 4.4, 0.3, 3.4), tile);
    slope.position.set(cx, 10.9, cz + dir * 1.35);
    slope.rotation.x = dir * 0.34;
    slope.castShadow = true;
    ctx.group.add(slope);
  }
  const ridge = block(ctx, tile, span * 2 + 4.8, 0.42, 0.6, cx, 11.5, cz);
  ridge.castShadow = true;
  // side roofs stepping down over the outer bays
  for (const sx of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.26, 3.8), tile);
    side.position.set(cx + sx * (span + 1.9), 8.3, cz);
    side.rotation.z = sx * 0.12;
    side.castShadow = true;
    ctx.group.add(side);
  }
  // gold finials on the ridge ends
  for (const sx of [-1, 1]) {
    const finial = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.9, 6), gold);
    finial.position.set(cx + sx * (span + 2.2), 11.9, cz);
    ctx.group.add(finial);
  }
}

/**
 * Ancol waterfront, from the beach reference: tan sand, calm murky water, a timber pier on
 * pilings with a tall mast, and the yellow/blue feather flags that line the shore.
 */
export function buildAncolShore(ctx: Ctx, cx: number, cz: number, half = 38) {
  const sand = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, 16), new THREE.MeshStandardMaterial({ color: 0xd8c49a, roughness: 0.96 }));
  sand.rotation.x = -Math.PI / 2;
  sand.position.set(cx, 0.3, cz - 22);
  sand.receiveShadow = true;
  ctx.group.add(sand);

  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(520, 150),
    new THREE.MeshStandardMaterial({ color: 0x4a6b74, roughness: 0.12, metalness: 0.5, transparent: true, opacity: 0.94 })
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(cx, 0.22, cz - 100);
  ctx.group.add(water);

  // the seawall: keeps the player on the beach instead of walking on the sea
  ctx.colliders.push({ minX: cx - half, maxX: cx + half, minZ: cz - 31, maxZ: cz - 29, h: 40 });

  // timber pier on pilings, with the tall mast from the reference
  const wood = new THREE.MeshStandardMaterial({ color: 0x8a6f4e, roughness: 0.92 });
  const deck = block(ctx, wood, 3.4, 0.22, 26, cx + 8, 1.15, cz - 40);
  deck.castShadow = true;
  for (let i = 0; i < 6; i++) {
    for (const sx of [-1, 1]) {
      const pile = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.6, 6), wood);
      pile.position.set(cx + 8 + sx * 1.5, 0.75, cz - 29 - i * 4.4);
      ctx.group.add(pile);
    }
  }
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 12, 6), new THREE.MeshStandardMaterial({ color: 0xb9b6ae, roughness: 0.6, metalness: 0.4 }));
  mast.position.set(cx + 8, 6.4, cz - 30);
  ctx.group.add(mast);

  // feather flags: yellow and blue, the strongest colour anchor on the real beach
  const flags = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.5, 1.9),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, side: THREE.DoubleSide }),
    16
  );
  const color = new THREE.Color();
  const mtx = new THREE.Matrix4();
  for (let i = 0; i < 16; i++) {
    const x = cx - 16 + i * 2.1;
    mtx.makeTranslation(x, 1.55, cz - 20);
    flags.setMatrixAt(i, mtx);
    flags.setColorAt(i, color.setHex(i % 2 ? 0x2f6fd0 : 0xf2c43a));
  }
  flags.instanceMatrix.needsUpdate = true;
  if (flags.instanceColor) flags.instanceColor.needsUpdate = true;
  ctx.group.add(flags);

  // a tree line behind the sand, like the coastal pines in the photo
  const trunk = new THREE.MeshStandardMaterial({ color: 0x6b5236, roughness: 0.95 });
  const leaf = new THREE.MeshStandardMaterial({ color: 0x2f5c33, roughness: 0.95 });
  for (let i = 0; i < 10; i++) {
    const x = cx - 30 + i * 6.6;
    const z = cz - 12;
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 3.2, 5), trunk);
    t.position.set(x, 1.9, z);
    ctx.group.add(t);
    const crown = new THREE.Mesh(new THREE.ConeGeometry(2.1, 4.2, 6), leaf);
    crown.position.set(x, 5.2, z);
    crown.castShadow = true;
    ctx.group.add(crown);
  }
}
