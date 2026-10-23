/**
 * Facade archetypes: the six building types a Jakarta street is made of.
 *
 * The city used to build every building with one recipe — a box, one window texture, one shop band
 * on the ground floor — and then vary the height and the paint. At street level that reads as one
 * template repeated: the owner's complaint ("masih template sama semua") is about silhouette, not
 * about colour. A ruko, an office slab, a walk-up flat, a colonial shophouse, a warung and a
 * mid-rise differ in what they put ON the street: a roller shutter and a signboard, a ribbon of
 * glazing and a setback crown, rails and air-con boxes on every floor, an arcade and a cornice, a
 * canvas awning over a counter, a service core and a painted advertising wall.
 *
 * So each type is one reusable builder, built once here and then varied by height, wall colour and
 * sign — never by rebuilding the recipe. city.ts decides which type a lot gets (see ArchetypeMixer)
 * and owns the merge into draw calls; this module owns what the six types look like.
 *
 * Everything is built in LOCAL space: the building centre at the origin, ground at y = 0, the
 * street face towards -Z. The caller passes a matrix that puts it in the world, so a frontage
 * building on a rotated row and a block lot on the grid share one code path.
 */
import * as THREE from 'three';
import { rand, randInt, pick, canvasTexture } from '../core/utils';

/** Shrink the font until the word fits: shop names are long and the boards are small. */
function fitFont(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, startSize: number) {
  let size = startSize;
  ctx.font = `bold ${size}px ui-sans-serif, system-ui, sans-serif`;
  while (size > 8 && ctx.measureText(text).width > maxWidth) {
    size -= 2;
    ctx.font = `bold ${size}px ui-sans-serif, system-ui, sans-serif`;
  }
}

export type ArchetypeId = 'ruko' | 'office' | 'walkup' | 'colonial' | 'warung' | 'midrise';

export interface ArchetypeSpec {
  id: ArchetypeId;
  /** what the audit and the proof harness call it */
  label: string;
  /** height band, metres */
  h: [number, number];
  /** street frontage the type wants, metres */
  w: [number, number];
  /** depth behind the facade, metres */
  d: [number, number];
  walls: number[];
  trims: number[];
  /** how the top closes: a clay pitch, a concrete parapet, or a canvas lean-to */
  roof: 'tile' | 'parapet' | 'canvas';
  /** does the ground floor read as a shop (shutter, signboard, enterable door) */
  retail: boolean;
  /** the window tile this type paints on its wall */
  tile: FacadeTile;
}

export type FacadeTile = 'ruko' | 'ribbon' | 'balcony' | 'colonial' | 'warung' | 'punched' | 'strips' | 'blank';

export const ARCHETYPES: Record<ArchetypeId, ArchetypeSpec> = {
  ruko: {
    id: 'ruko',
    label: 'ruko',
    h: [6.6, 10.4],
    w: [6, 9],
    d: [12, 17],
    walls: [0xd9cdb4, 0xe4c9c2, 0xc9d8c4, 0xe8dfcb, 0xcfcfc8, 0xb8c4c9],
    trims: [0xefe9db, 0xf2f0e8, 0x9aa0a6],
    roof: 'parapet',
    retail: true,
    tile: 'ruko',
  },
  office: {
    id: 'office',
    label: 'office slab',
    h: [29, 47],
    w: [20, 30],
    d: [16, 24],
    walls: [0xb9c4cf, 0xa9b7c4, 0xc4cdd6, 0x9fa8ae],
    trims: [0xe6e9ec, 0x8b939b, 0xd4d8db],
    roof: 'parapet',
    retail: false,
    tile: 'ribbon',
  },
  walkup: {
    id: 'walkup',
    label: 'walk-up flats',
    h: [16, 26],
    w: [12, 19],
    d: [12, 16],
    walls: [0xd8d2c2, 0xc7bfae, 0xd5c9b6, 0xbfb6a4],
    trims: [0xe9e4d6, 0x8d8a80, 0xcfc8b6],
    roof: 'parapet',
    retail: false,
    tile: 'balcony',
  },
  colonial: {
    id: 'colonial',
    label: 'colonial shophouse',
    h: [8.2, 11.5],
    w: [8, 13],
    d: [14, 20],
    walls: [0xe9e3d3, 0xf1ece0, 0xded6c4],
    trims: [0xfbf7ec, 0xa8a08c, 0xd8cfba],
    roof: 'tile',
    retail: true,
    tile: 'colonial',
  },
  warung: {
    id: 'warung',
    label: 'warung kiosk',
    h: [3.4, 4.4],
    w: [4.6, 7],
    d: [4.6, 7],
    walls: [0xc8b99c, 0xd6c2a8, 0xcfa07a, 0xb8c4c9],
    trims: [0xe4d9c2, 0x8a7f6d, 0xf0ebe0],
    roof: 'canvas',
    retail: true,
    tile: 'warung',
  },
  midrise: {
    id: 'midrise',
    label: 'mid-rise',
    h: [24, 38],
    w: [14, 21],
    d: [14, 19],
    walls: [0xc4c2bc, 0xb5b0a6, 0xcbc3b4, 0xacb4b8],
    trims: [0xdedad0, 0x8f8b83, 0xcfc9bd],
    roof: 'parapet',
    retail: true,
    tile: 'punched',
  },
};

export const ARCHETYPE_IDS: ArchetypeId[] = ['ruko', 'office', 'walkup', 'colonial', 'warung', 'midrise'];

/**
 * District taste. Kota Tua is colonial shophouses, Thamrin is slabs and mid-rise, Glodok and Tanah
 * Abang are a wall of ruko. The list is a weighted bag: an id repeated is an id more likely.
 */
const DISTRICT_TASTE: Record<string, ArchetypeId[]> = {
  kotatua: ['colonial', 'colonial', 'colonial', 'colonial', 'ruko', 'ruko', 'midrise', 'warung'],
  glodok: ['ruko', 'ruko', 'ruko', 'ruko', 'warung', 'warung', 'colonial', 'walkup', 'midrise'],
  tanahabang: ['ruko', 'ruko', 'ruko', 'ruko', 'warung', 'warung', 'midrise', 'walkup'],
  blokm: ['ruko', 'ruko', 'midrise', 'midrise', 'office', 'walkup', 'warung', 'colonial'],
  thamrin: ['office', 'office', 'office', 'midrise', 'midrise', 'walkup', 'ruko'],
  monas: ['office', 'office', 'midrise', 'midrise', 'walkup', 'ruko'],
  gambir: ['office', 'midrise', 'midrise', 'walkup', 'ruko'],
  kemang: ['walkup', 'walkup', 'ruko', 'ruko', 'colonial', 'office', 'warung'],
  kampung: ['warung', 'ruko', 'ruko', 'walkup'],
};

const DEFAULT_TASTE: ArchetypeId[] = ['ruko', 'ruko', 'ruko', 'walkup', 'walkup', 'midrise', 'office', 'colonial', 'warung'];

/**
 * Picks the type for each lot in a block or a street row, and refuses to repeat.
 *
 * "a block mixes archetypes, not repeats one" needs state: a weighted random draw happily returns
 * the same type four lots in a row, which is exactly the wall of identical boxes the owner keeps
 * photographing. The mixer remembers the last two picks and drops them from the bag, so the
 * shortest cycle is three lots; if a district's taste only has one type left, it relaxes to
 * "anything but the previous one" rather than returning nothing.
 */
export class ArchetypeMixer {
  private history: ArchetypeId[] = [];
  private readonly taste: ArchetypeId[];
  /**
   * When true every six consecutive picks contain ALL SIX types.
   *
   * A street wall is the city's public face: the owner's complaint was that a whole row reads as
   * one template, and a weighted draw over a district's taste (Thamrin is office-heavy) still
   * returns four types over twelve lots. A weighted permutation of the six, refilled when it runs
   * out, gives each district its own rhythm (its taste comes up early and often) while guaranteeing
   * that six neighbours are six different buildings.
   */
  private readonly full: boolean;
  private bag: ArchetypeId[] = [];

  constructor(district: string | null, full = false) {
    this.taste = DISTRICT_TASTE[district || ''] || DEFAULT_TASTE;
    this.full = full;
  }

  /** The type the next accepted lot will get, WITHOUT consuming it: a rejected lot must not burn
   *  a card, or a row of eight can come out with three types (see the gate in buildFrontage). */
  peek(fits: (spec: ArchetypeSpec) => boolean = () => true): ArchetypeSpec {
    if (this.full) {
      if (!this.bag.length) this.bag = this.cycle();
      const pickInBag = this.bag.find((id) => fits(ARCHETYPES[id]));
      if (pickInBag) return ARCHETYPES[pickInBag];
    }
    const banned = new Set(this.history.slice(-2));
    let bag = this.taste.filter((id) => !banned.has(id));
    let spec = this.draw(bag, fits);
    if (!spec) {
      bag = this.taste.filter((id) => id !== this.history[this.history.length - 1]);
      spec = this.draw(bag, fits);
    }
    if (!spec) spec = ARCHETYPES[pick(this.taste)];
    return spec;
  }

  commit(spec: ArchetypeSpec) {
    if (this.full) {
      const i = this.bag.indexOf(spec.id);
      if (i >= 0) this.bag.splice(i, 1);
    }
    this.history.push(spec.id);
    if (this.history.length > 4) this.history.shift();
  }

  next(fits: (spec: ArchetypeSpec) => boolean = () => true): ArchetypeSpec {
    const spec = this.peek(fits);
    this.commit(spec);
    return spec;
  }

  /** A weighted shuffle of all six ids: the district's taste tends to come first, but every six
   *  lots hold one of each. Rotated so it cannot open with the type that just closed the last one. */
  private cycle(): ArchetypeId[] {
    const ids = [...ARCHETYPE_IDS];
    const out: ArchetypeId[] = [];
    while (ids.length) {
      const weights = ids.map((id) => this.taste.filter((t) => t === id).length + 1);
      const total = weights.reduce((a, b) => a + b, 0);
      let r = rand(0, total);
      let i = 0;
      while (i < ids.length - 1 && r >= weights[i]) {
        r -= weights[i];
        i++;
      }
      out.push(ids.splice(i, 1)[0]);
    }
    const last = this.history[this.history.length - 1];
    if (last) {
      const j = out.findIndex((id) => id !== last);
      if (j > 0) [out[0], out[j]] = [out[j], out[0]];
    }
    return out;
  }

  private draw(bag: ArchetypeId[], fits: (spec: ArchetypeSpec) => boolean): ArchetypeSpec | null {
    const ok = [...new Set(bag)].filter((id) => fits(ARCHETYPES[id]));
    if (!ok.length) return null;
    // the bag is weighted, so draw from it rather than from the deduped list of fits
    const weighted = bag.filter((id) => ok.includes(id));
    return ARCHETYPES[pick(weighted)];
  }
}

/** The trim colour, pushed away from the wall so a building never reads as one flat colour. */
export function trimFor(spec: ArchetypeSpec, wall: number): number {
  const lum = (hex: number) => {
    const r = ((hex >> 16) & 255) / 255;
    const g = ((hex >> 8) & 255) / 255;
    const b = (hex & 255) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const wl = lum(wall);
  let best = spec.trims[0];
  let bestGap = -1;
  for (const t of spec.trims) {
    const gap = Math.abs(lum(t) - wl);
    if (gap > bestGap) {
      bestGap = gap;
      best = t;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Textures. One canvas per (colour, tile, repeat); the repeat is baked into the cache key, so the
// material that shares a canvas can also share its tiling.
// ---------------------------------------------------------------------------------------------

const windowTexCache = new Map<string, THREE.Texture>();

/**
 * One facade tile is ONE STOREY of the building's own type.
 *
 * The old tile was a 3x3 window grid mapped once onto the whole wall, so a 16 m ruko showed three
 * windows four metres wide and a 40 m tower showed three windows eleven metres tall: the flat slab
 * with one window slot. A tile per storey gives windows a fixed real size and gives the wall a
 * floor rhythm; how often it repeats is the building's own business (see tileBoxUV), so the canvas
 * can be shared by every building of that colour and type.
 */
export function windowTexture(wall: number | string, style: string = 'punched'): THREE.Texture {
  const key = `${wall}|${style}`;
  const hit = windowTexCache.get(key);
  if (hit) return hit;
  const map = canvasTexture(128, 128, (ctx, w, h) => {
    const c = typeof wall === 'number' ? `#${wall.toString(16).padStart(6, '0')}` : String(wall);
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, w, h);

    // plaster / concrete patina: vertical variation at 1-6 px, so the wall is never a poster colour
    for (let i = 0; i < 26; i++) {
      ctx.fillStyle = `rgba(0,0,0,${rand(0.015, 0.05)})`;
      ctx.fillRect(rand(0, w), rand(0, h), rand(1, 6), rand(4, h));
    }

    const glass = (x: number, y: number, ww: number, wh: number) => {
      const g = ctx.createLinearGradient(x, y, x + ww, y + wh);
      g.addColorStop(0, '#8aa6bc');
      g.addColorStop(0.45, '#4d6b83');
      g.addColorStop(1, '#2c3f4f');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, ww, wh);
      ctx.fillStyle = 'rgba(255,255,255,0.20)';
      ctx.fillRect(x, y, ww, Math.max(1, wh * 0.2));
    };
    const sill = (x: number, y: number, ww: number) => {
      ctx.fillStyle = 'rgba(255,255,255,0.30)';
      ctx.fillRect(x - 2, y, ww + 4, 3);
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      ctx.fillRect(x - 2, y + 3, ww + 4, 3);
    };
    const floorLine = (inset: number) => {
      // the slab edge: a light lip and the shadow it drops on the storey below
      ctx.fillStyle = 'rgba(255,255,255,0.20)';
      ctx.fillRect(0, h - 20, w, 4);
      ctx.fillStyle = 'rgba(0,0,0,0.24)';
      ctx.fillRect(0, h - 16, w, 6);
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      ctx.fillRect(inset, h - 10, w - inset * 2, 10);
    };

    if (style === 'ribbon') {
      // an office slab: one continuous glazed band behind a spandrel of a DIFFERENT tone, mullions
      // on a 3.2 m rhythm, and no vertical wall between the panes
      ctx.fillStyle = 'rgba(0,0,0,0.34)';
      ctx.fillRect(0, 10, w, 66);
      const panes = 4;
      const pw = w / panes;
      for (let i = 0; i < panes; i++) {
        glass(i * pw + 3, 14, pw - 6, 56);
        ctx.fillStyle = 'rgba(24,28,34,0.72)';
        ctx.fillRect(i * pw, 12, 3, 60);
      }
      // spandrel: the band above the glass gets the wall colour plus a hard shadow line
      ctx.fillStyle = 'rgba(0,0,0,0.26)';
      ctx.fillRect(0, 76, w, 5);
      ctx.fillStyle = 'rgba(255,255,255,0.24)';
      ctx.fillRect(0, 81, w, 3);
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.fillRect(0, 84, w, 22);
      floorLine(0);
      return;
    }
    if (style === 'balcony') {
      // a walk-up: a recessed opening with a rail across it and an air-con box beside it
      ctx.fillStyle = 'rgba(0,0,0,0.26)';
      ctx.fillRect(16, 20, 96, 62);
      ctx.fillStyle = 'rgba(32,38,44,0.9)';
      ctx.fillRect(22, 26, 84, 50);
      glass(26, 30, 76, 34);
      ctx.fillStyle = 'rgba(226,224,216,0.92)';
      ctx.fillRect(18, 62, 92, 4);
      ctx.fillStyle = 'rgba(70,74,80,0.75)';
      for (let bx = 20; bx < 108; bx += 7) ctx.fillRect(bx, 40, 2, 22);
      // air-con box bolted beside the opening, with its drip stain under it
      ctx.fillStyle = 'rgba(238,236,228,0.95)';
      ctx.fillRect(103, 70, 20, 14);
      ctx.fillStyle = 'rgba(120,126,132,0.95)';
      ctx.fillRect(105, 73, 16, 8);
      ctx.fillStyle = 'rgba(60,54,44,0.16)';
      ctx.fillRect(105, 84, 14, 30);
      floorLine(8);
      return;
    }
    if (style === 'ruko') {
      // a shophouse storey: two bays, a plaster surround, a window with a deep frame, an AC box
      const cw = w / 2;
      for (let i = 0; i < 2; i++) {
        const x = i * cw + cw * 0.24;
        const ww = cw * 0.52;
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.fillRect(x - 3, 24, ww + 6, 52);
        glass(x, 27, ww, 44);
        ctx.strokeStyle = 'rgba(30,32,36,0.55)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, 27, ww, 44);
        sill(x, 71, ww);
        if (i === 1) {
          ctx.fillStyle = 'rgba(236,234,226,0.95)';
          ctx.fillRect(x + ww + 3, 42, 18, 13);
          ctx.fillStyle = 'rgba(118,124,130,0.95)';
          ctx.fillRect(x + ww + 5, 45, 14, 7);
        }
      }
      floorLine(0);
      return;
    }
    if (style === 'colonial') {
      // tall arched openings with a white surround and a shutter leaf either side
      const bays = 2;
      const cw = w / bays;
      for (let i = 0; i < bays; i++) {
        const ww = cw * 0.44;
        const x = i * cw + (cw - ww) / 2;
        const top = 22;
        const bh = 60;
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fillRect(x - 4, top - 5, ww + 8, bh + 9);
        ctx.beginPath();
        ctx.moveTo(x, top + bh);
        ctx.lineTo(x, top + ww / 2);
        ctx.arc(x + ww / 2, top + ww / 2, ww / 2, Math.PI, 0);
        ctx.lineTo(x + ww, top + bh);
        ctx.closePath();
        ctx.fillStyle = '#33414d';
        ctx.fill();
        ctx.fillStyle = 'rgba(150,175,190,0.35)';
        ctx.fillRect(x + 2, top + 6, ww - 4, bh * 0.3);
        // shutter leaves, folded back against the reveal
        ctx.fillStyle = 'rgba(58,74,62,0.92)';
        ctx.fillRect(x - 10, top, 8, bh);
        ctx.fillStyle = 'rgba(58,74,62,0.72)';
        for (let y = top + 2; y < top + bh; y += 4) ctx.fillRect(x - 10, y, 8, 1.5);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.42)';
      ctx.fillRect(0, h - 16, w, 3);
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(0, h - 13, w, 4);
      return;
    }
    if (style === 'warung') {
      // a kiosk: mostly wall, a small window, a plywood panel and a painted band
      ctx.fillStyle = 'rgba(150,116,74,0.85)';
      ctx.fillRect(8, 62, 52, 46);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      for (let y = 66; y < 108; y += 9) ctx.fillRect(8, y, 52, 2);
      glass(76, 34, 40, 30);
      ctx.strokeStyle = 'rgba(40,36,30,0.55)';
      ctx.lineWidth = 2;
      ctx.strokeRect(76, 34, 40, 30);
      ctx.fillStyle = 'rgba(255,255,255,0.30)';
      ctx.fillRect(70, 24, 52, 4);
      return;
    }
    if (style === 'strips') {
      for (let x = 14; x < w - 18; x += 34) glass(x, 12, 10, h - 26);
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      ctx.fillRect(0, 0, w, 6);
      return;
    }
    if (style === 'blank') {
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(0, 0, w, 6);
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      ctx.fillRect(0, h - 8, w, 8);
      return;
    }
    // punched: the mid-rise / office-back grid — two rows of punched windows with sills
    const cols = 2;
    const rows = 2;
    const cw = w / cols;
    const ch = h / rows;
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const ww = cw * 0.46;
        const wh = ch * 0.34;
        const x = i * cw + (cw - ww) / 2;
        const y = j * ch + ch * 0.22;
        ctx.fillStyle = 'rgba(0,0,0,0.20)';
        ctx.fillRect(x - 2, y - 2, ww + 4, wh + 4);
        glass(x, y, ww, wh);
        sill(x, y + wh, ww);
      }
    }
    floorLine(0);
  });
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  // the tile stays 1x1: how many times it repeats is baked into each building's UVs instead, so a
  // 9 m ruko and a 40 m slab can share ONE material (and therefore one merged draw call)
  map.repeat.set(1, 1);
  windowTexCache.set(key, map);
  return map;
}

/**
 * Scale a box's UVs so the wall tile repeats (rx, ry) times.
 *
 * The repeat used to live on THREE.Texture.repeat, which meant the repeat had to be part of the
 * material cache key — so every building with its own width and height got its own material and
 * therefore its own draw call. Baking it into the geometry keeps one material per (wall, tile) and
 * lets the whole city's bodies merge, at the cost of a rewrite of 24 UV pairs per box.
 */
export function tileBoxUV(geo: THREE.BufferGeometry, rx: number, ry: number) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * rx, uv.getY(i) * ry);
  uv.needsUpdate = true;
}

// ---- sign + advertising atlases -------------------------------------------------------------

/** Plesetan, not real brands: the city's own shop names. */
export const SHOP_WORDS = [
  'ALFAMURTI', 'INDOMERET', 'WARTEG BAHARI', 'BAKSO PAK TJE', 'MIE GACUAN', 'SATE SENAYUN',
  'PULSA PERDANU', 'APOTEK SEHAT', 'BENGKEL AHOS', 'KOPI TUBRUK', 'TOKO EMAS MULYA', 'LAUNDRY KILAT',
  'PANGKAS RAMBUT', 'MARTABAK BANGKOK', 'NASI PADANG SELONGSOR', 'JAMU GENDONG', 'SERVIS AC',
  'TOKO BANGUNAN', 'OPTIK TERANG', 'FOTOKOPI JAYA', 'KREDIT MOTOR', 'SEMBAKO LANCAR', 'ES TEH MANIS',
  'GORENGAN BU TUTI', 'KUE BASAH', 'SALON AYU', 'CETAK SPANDUK', 'BATAGOR',
];

const SIGN_COLS = 4;
const SIGN_ROWS = 4;
const SIGN_BG = ['#e0b23c', '#c0392b', '#2f6f9f', '#3f7a4a', '#f0efe8', '#8a3ad9', '#e2663c', '#1f7a55'];
let signTex: THREE.Texture | null = null;

/**
 * Sixteen signboards in one canvas.
 *
 * Every building used to get its own 256x64 canvas and its own material for four sign meshes, so a
 * street of shops was dozens of materials and hundreds of draw calls for text you read once. One
 * atlas, one material, and the sign quad carries the UV of its cell: the whole city's signboards
 * are one draw call, and a block still has sixteen different names on it.
 */
export function signAtlas(): THREE.Texture {
  if (signTex) return signTex;
  signTex = canvasTexture(1024, 512, (ctx, w, h) => {
    const cw = w / SIGN_COLS;
    const ch = h / SIGN_ROWS;
    for (let r = 0; r < SIGN_ROWS; r++) {
      for (let c = 0; c < SIGN_COLS; c++) {
        const word = SHOP_WORDS[(r * SIGN_COLS + c) % SHOP_WORDS.length];
        const bg = SIGN_BG[(r * SIGN_COLS + c) % SIGN_BG.length];
        const x = c * cw;
        const y = r * ch;
        ctx.fillStyle = bg;
        ctx.fillRect(x, y, cw, ch);
        // painted metal: a lighter top edge and a shadow along the bottom
        ctx.fillStyle = 'rgba(255,255,255,0.16)';
        ctx.fillRect(x, y, cw, 4);
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.fillRect(x, y + ch - 10, cw, 10);
        const dark = bg === '#f0efe8';
        ctx.fillStyle = dark ? '#231f1a' : '#fff8e7';
        fitFont(ctx, word, cw - 18, 40);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(word, x + cw / 2, y + ch / 2 - 3);
      }
    }
  });
  signTex.wrapS = signTex.wrapT = THREE.ClampToEdgeWrapping;
  return signTex;
}

const AD_TEXT = [
  ['SEWA', 'RUANG', 'LANTAI 5'],
  ['PROMO', 'SPESIAL', 'HARI INI'],
  ['BUKA', '24 JAM', 'NONSTOP'],
  ['KREDIT', 'MOTOR', 'DP 500RB'],
];
const AD_BG = ['#b8452f', '#2f5f8f', '#c2952c', '#3f6b4a'];
let adTex: THREE.Texture | null = null;

/** Four painted advertising walls in one canvas: the giant hand-painted ad on a Jakarta flank wall. */
export function adAtlas(): THREE.Texture {
  if (adTex) return adTex;
  adTex = canvasTexture(1024, 512, (ctx, w, h) => {
    const cw = w / 4;
    for (let i = 0; i < 4; i++) {
      const text = AD_TEXT[i];
      const x = i * cw;
      ctx.fillStyle = AD_BG[i];
      ctx.fillRect(x, 0, cw, h);
      // whitewashed panel the letters are painted on, with the wall showing at the edges
      ctx.fillStyle = 'rgba(255,255,255,0.90)';
      ctx.fillRect(x + cw * 0.06, h * 0.08, cw * 0.88, h * 0.84);
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      ctx.fillRect(x + cw * 0.06, h * 0.08, cw * 0.88, 8);
      ctx.fillStyle = AD_BG[i];
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      text.forEach((line, k) => {
        fitFont(ctx, line, cw * 0.78, k === 0 ? 96 : 74);
        ctx.fillText(line, x + cw / 2, h * (0.28 + k * 0.24));
      });
      // the drips and overspray of a painted wall
      for (let d = 0; d < 26; d++) {
        ctx.fillStyle = `rgba(0,0,0,${0.02 + Math.random() * 0.05})`;
        ctx.fillRect(x + Math.random() * cw, Math.random() * h, 2, 10 + Math.random() * 40);
      }
    }
  });
  adTex.wrapS = adTex.wrapT = THREE.ClampToEdgeWrapping;
  return adTex;
}

/** Corrugated roller shutter: vertical ribs that catch the light, plus a rust stain at the kerb. */
let shutterTex: THREE.Texture | null = null;
export function shutterTexture(): THREE.Texture {
  if (shutterTex) return shutterTex;
  shutterTex = canvasTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#8d939a';
    ctx.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 6) {
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fillRect(x, 0, 3, h);
      ctx.fillStyle = 'rgba(0,0,0,0.24)';
      ctx.fillRect(x + 3, 0, 3, h);
    }
    // the ribs are horizontals on a real shutter, not verticals
    ctx.fillStyle = 'rgba(0,0,0,0.10)';
    for (let y = 0; y < h; y += 5) ctx.fillRect(0, y, w, 1);
    ctx.fillStyle = 'rgba(120,72,32,0.22)';
    ctx.fillRect(0, h - 22, w, 22);
  });
  shutterTex.wrapS = shutterTex.wrapT = THREE.RepeatWrapping;
  return shutterTex;
}

/** Canvas awning stripes, for the warung. */
const awningTexCache = new Map<number, THREE.Texture>();
export function awningTexture(colour: number): THREE.Texture {
  const hit = awningTexCache.get(colour);
  if (hit) return hit;
  const c = `#${colour.toString(16).padStart(6, '0')}`;
  const tex = canvasTexture(128, 64, (ctx, w, h) => {
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    for (let x = 0; x < w; x += 24) ctx.fillRect(x, 0, 12, h);
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    for (let y = 0; y < h; y += 8) ctx.fillRect(0, y, w, 1);
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  awningTexCache.set(colour, tex);
  return tex;
}

/** The grime band every Jakarta wall carries where the rain and the road throw dirt at it. */
let grimeTex: THREE.Texture | null = null;
export function grimeTexture(): THREE.Texture {
  if (grimeTex) return grimeTex;
  grimeTex = canvasTexture(64, 64, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(46,40,32,0.0)');
      g.addColorStop(1, `rgba(46,40,32,${rand(0.12, 0.34)})`);
      ctx.fillStyle = g;
      ctx.fillRect(rand(0, w), 0, rand(1, 4), h);
    }
    const g2 = ctx.createLinearGradient(0, 0, 0, h);
    g2.addColorStop(0, 'rgba(40,36,28,0.02)');
    g2.addColorStop(1, 'rgba(40,36,28,0.22)');
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, w, h);
  });
  grimeTex.wrapS = grimeTex.wrapT = THREE.RepeatWrapping;
  return grimeTex;
}

// ---------------------------------------------------------------------------------------------
// Shared materials, keyed so city.ts can merge every building's detail into one mesh per key.
// ---------------------------------------------------------------------------------------------

const matCache = new Map<string, THREE.Material>();

function std(key: string, make: () => THREE.MeshStandardMaterial): THREE.Material {
  const hit = matCache.get(key);
  if (hit) return hit;
  const m = make();
  matCache.set(key, m);
  return m;
}

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** The material for a detail bucket key. Keys are stable strings: they are the merge key. */
export function facadeMaterial(key: string): THREE.Material {
  return std(key, () => {
    const [kind, arg] = key.split(':');
    switch (kind) {
      case 'trim':
        return new THREE.MeshStandardMaterial({ color: parseInt(arg, 16), roughness: 0.86, metalness: 0.03 });
      case 'core':
        return new THREE.MeshStandardMaterial({ color: parseInt(arg, 16), roughness: 0.9, metalness: 0.02 });
      case 'shutter':
        return new THREE.MeshStandardMaterial({ map: shutterTexture(), roughness: 0.62, metalness: 0.35 });
      case 'rail':
        return new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.55, metalness: 0.45 });
      case 'ac':
        return new THREE.MeshStandardMaterial({ color: 0xe8e6de, roughness: 0.6, metalness: 0.15 });
      case 'glass':
        return new THREE.MeshStandardMaterial({ color: 0x2f4655, roughness: 0.22, metalness: 0.5 });
      case 'tile':
        return new THREE.MeshStandardMaterial({ color: 0xa7523c, roughness: 0.94 });
      case 'awning':
        // double-sided: a canvas awning over the pavement is seen from UNDERNEATH at street level,
        // and a single-sided plane is culled exactly where the player stands
        return new THREE.MeshStandardMaterial({ map: awningTexture(parseInt(arg, 16)), roughness: 0.85, side: THREE.DoubleSide });
      case 'grime':
        return new THREE.MeshStandardMaterial({
          map: grimeTexture(),
          transparent: true,
          roughness: 0.95,
          depthWrite: false,
        });
      case 'counter':
        return new THREE.MeshStandardMaterial({ color: 0xd8c9a8, roughness: 0.7 });
      case 'sign':
        return new THREE.MeshStandardMaterial({
          map: signAtlas(),
          roughness: 0.55,
          emissive: 0xffffff,
          emissiveMap: signAtlas(),
          emissiveIntensity: 0.05,
        });
      case 'ad':
        return new THREE.MeshStandardMaterial({
          map: adAtlas(),
          roughness: 0.8,
          emissive: 0xffffff,
          emissiveMap: adAtlas(),
          emissiveIntensity: 0.03,
        });
      default:
        return new THREE.MeshStandardMaterial({ color: 0x999999, roughness: 0.9 });
    }
  });
}

/** Materials that should light up after dark (signs, painted ads). */
export function facadeEmissiveKeys(): string[] {
  return ['sign', 'ad'];
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

type Sink = (key: string, geo: THREE.BufferGeometry) => void;

class Batch {
  constructor(private readonly push: Sink, private readonly m: THREE.Matrix4) {}

  /** an axis-aligned box in the building's local frame, stamped into the world */
  box(key: string, w: number, h: number, d: number, x: number, y: number, z: number, rz = 0) {
    const g = new THREE.BoxGeometry(Math.max(0.02, w), Math.max(0.02, h), Math.max(0.02, d));
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    g.applyMatrix4(this.m);
    this.push(key, g);
  }

  /** a flat panel on the street face (-Z), optionally lifting its UV into an atlas cell */
  face(key: string, w: number, h: number, x: number, y: number, z: number, cell?: [number, number, number, number]) {
    const g = new THREE.PlaneGeometry(w, h);
    if (cell) {
      const uv = g.attributes.uv;
      const [u0, v0, uw, vh] = cell;
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, u0 + uv.getX(i) * uw, v0 + uv.getY(i) * vh);
      }
      uv.needsUpdate = true;
    }
    g.rotateY(Math.PI); // plane normal +Z -> -Z, facing the street
    g.translate(x, y, z);
    g.applyMatrix4(this.m);
    this.push(key, g);
  }

  /** a panel laying flat (awning, ledge top) or tilted about X */
  tilted(key: string, w: number, d: number, x: number, y: number, z: number, rx: number) {
    const g = new THREE.PlaneGeometry(w, d);
    g.rotateX(-Math.PI / 2 + rx);
    g.translate(x, y, z);
    g.applyMatrix4(this.m);
    this.push(key, g);
  }
}

/** A UV cell for a panel in the sign atlas; the index is per building so neighbours differ. */
function signCell(seed: number): [number, number, number, number] {
  const i = Math.abs(Math.floor(seed)) % (SIGN_COLS * SIGN_ROWS);
  const c = i % SIGN_COLS;
  const r = Math.floor(i / SIGN_COLS);
  return [c / SIGN_COLS, 1 - (r + 1) / SIGN_ROWS, 1 / SIGN_COLS, 1 / SIGN_ROWS];
}

function adCell(seed: number): [number, number, number, number] {
  const i = Math.abs(Math.floor(seed)) % 4;
  return [i / 4, 0, 1 / 4, 1];
}

const trimKey = (c: number) => `trim:${c.toString(16)}`;
const coreKey = (c: number) => `core:${c.toString(16)}`;
const awningKey = (c: number) => `awning:${c.toString(16)}`;
const AWNINGS = [0xc0392b, 0x2f6f9f, 0xd9a02c, 0x3f7a4a];

export interface FacadePlan {
  /** building centre in world space, at ground level */
  x: number;
  y: number;
  z: number;
  /** rotation about Y: local -Z is the street face */
  yaw: number;
  w: number;
  d: number;
  h: number;
  wall: number;
  trim: number;
  spec: ArchetypeSpec;
  /** stable per-building number: picks the sign cell, the ad cell, the side the core is on */
  seed: number;
  /** which generator placed it: a block lot or a street frontage row (for the mix audit) */
  source?: 'block' | 'frontage';
}

/** Local -> world for this building. */
export function facadeMatrix(p: FacadePlan): THREE.Matrix4 {
  return new THREE.Matrix4().makeRotationY(p.yaw).setPosition(p.x, p.y, p.z);
}

/**
 * The building's mass, in local space. Most types are one box; an office slab loses a fifth of its
 * footprint at the top, and a mid-rise carries its service core as a proud volume, so the silhouette
 * is not the same rectangle for all six.
 */
export function archetypeBody(p: FacadePlan): { w: number; h: number; d: number; x: number; y: number; z: number }[] {
  const { w, d, h, spec } = p;
  if (spec.id === 'office') {
    const main = h * 0.82;
    return [
      { w, h: main, d, x: 0, y: main / 2, z: 0 },
      { w: w * 0.78, h: h - main, d: d * 0.8, x: 0, y: main + (h - main) / 2, z: 0 },
    ];
  }
  if (spec.id === 'midrise') {
    // the core is a full-height strip on one flank: solid wall, no windows, a different colour
    const coreW = Math.min(4.2, w * 0.26);
    const side = p.seed % 2 === 0 ? 1 : -1;
    return [
      { w: w - coreW, h, d, x: -side * coreW / 2, y: h / 2, z: 0 },
      { w: coreW, h: h * 1.01, d: d * 0.98, x: side * (w - coreW) / 2, y: h * 1.005 / 2, z: 0 },
    ];
  }
  if (spec.id === 'colonial') {
    // two storeys of wall behind an arcade; the verandah is added as trim, this is the mass
    return [{ w, h, d, x: 0, y: h / 2, z: 0 }];
  }
  return [{ w, h, d, x: 0, y: h / 2, z: 0 }];
}

/**
 * Everything that is not the wall itself: the street floor of the type, its ledges, rails, air-con
 * boxes, cornice, awning, service core trim and painted wall, and the way the top closes.
 */
export function buildFacadeDetail(p: FacadePlan, sink: Sink) {
  const b = new Batch(sink, facadeMatrix(p));
  const { w, d, h, spec, trim } = p;
  const front = -d / 2; // the street face
  const T = trimKey(trim);

  // --- every type carries these three: a base course, the grime the road throws up, a floor ledge
  // the base course runs round all four sides, not just the street face: a building seen from the
  // side or from a corner otherwise plunges into the pavement with window tiles down to the ground
  b.box(T, w + 0.14, 0.52, d + 0.14, 0, 0.26, 0);
  b.box(T, w + 0.16, 0.22, d + 0.16, 0, 0.6, 0);
  b.face('grime', w * 0.99, 1.15, 0, 1.28, front - 0.012);
  // the shop line: a hard shadow where the ground floor meets the floors above
  b.box(T, w + 0.1, 0.14, 0.3, 0, 3.1, front + 0.02);

  switch (spec.id) {
    case 'ruko':
      buildRuko(b, p, T, front);
      break;
    case 'office':
      buildOffice(b, p, T, front);
      break;
    case 'walkup':
      buildWalkUp(b, p, T, front);
      break;
    case 'colonial':
      buildColonial(b, p, T, front);
      break;
    case 'warung':
      buildWarung(b, p, T, front);
      break;
    case 'midrise':
      buildMidrise(b, p, T, front);
      break;
  }

  // --- the top closes differently per type
  if (spec.roof === 'tile') {
    const pitch = Math.min(2.4, w * 0.16);
    const half = Math.hypot(d / 2 + 0.4, pitch);
    const slope = new THREE.BoxGeometry(w + 0.7, 0.16, half);
    slope.rotateX(Math.atan2(pitch, d / 2 + 0.4));
    slope.translate(0, h + pitch / 2 + 0.1, d / 4);
    slope.applyMatrix4(facadeMatrix(p));
    sink('tile', slope);
    const slope2 = new THREE.BoxGeometry(w + 0.7, 0.16, half);
    slope2.rotateX(-Math.atan2(pitch, d / 2 + 0.4));
    slope2.translate(0, h + pitch / 2 + 0.1, -d / 4);
    slope2.applyMatrix4(facadeMatrix(p));
    sink('tile', slope2);
    b.box('tile', w + 0.8, 0.15, 0.3, 0, h + pitch + 0.1, 0);
  } else if (spec.roof === 'canvas') {
    // a single-pitch corrugated roof leaning back off the front, with a lip over the street
    b.tilted(T, w + 0.5, d + 0.7, 0, h + 0.16, 0, 0.16);
    b.box(T, w + 0.5, 0.12, 0.18, 0, h + 0.24, front - 0.3);
  } else {
    // parapet: four rims, not a lid, so the roofline is a wall you can see the sky through
    const ph = Math.min(0.85, 0.3 + h * 0.012);
    b.box(T, w + 0.2, ph, 0.22, 0, h + ph / 2, front - 0.04);
    b.box(T, w + 0.2, ph, 0.22, 0, h + ph / 2, -front + 0.04);
    b.box(T, 0.22, ph, d + 0.2, w / 2 + 0.04, h + ph / 2, 0);
    b.box(T, 0.22, ph, d + 0.2, -w / 2 - 0.04, h + ph / 2, 0);
  }
}

// ---------------------------------------------------------------------------------------------
// 1. Ruko: 2-3 storeys, roller shutter on the ground floor, signboard band, water tank on the roof
// ---------------------------------------------------------------------------------------------
function buildRuko(b: Batch, p: FacadePlan, T: string, front: number) {
  const { w, d, h, seed } = p;
  const storey = 3.3;
  // roller shutters: two bays, one of them half-open with the shop dark inside
  const bayW = w * 0.34;
  for (const side of [-1, 1]) {
    const x = side * w * 0.22;
    b.box('shutter', bayW, 2.75, 0.12, x, 1.45, front - 0.03);
  }
  b.box('glass', w * 0.2, 2.4, 0.1, 0, 1.4, front - 0.02);
  // the signboard band: a backing board with the name plate in front of it
  b.box(T, w * 0.96, 1.05, 0.16, 0, 3.55, front - 0.06);
  b.face('sign', Math.min(w * 0.88, 3.1), Math.min(0.92, w * 0.13), 0, 3.55, front - 0.15, signCell(seed * 7 + 3));
  // a projecting canopy over the pavement, as every ruko in Jakarta has
  b.tilted(T, w * 0.92, 1.7, 0, 4.15, front - 0.75, 0.18);
  // slab edges on the floors above, which is what gives a row of ruko its horizontal rhythm
  for (let f = 1; f * storey < h - 1; f++) {
    b.box(T, w + 0.08, 0.16, 0.34, 0, f * storey, front + 0.02);
  }
  // air-con boxes: the detail that says "someone lives above the shop"
  for (let f = 1; f * storey < h - 1; f++) {
    if ((f + seed) % 2 === 0) b.box('ac', 0.78, 0.56, 0.42, (seed % 2 ? 1 : -1) * w * 0.24, f * storey + 1.9, front - 0.24);
  }
  // roof: a water tank, because every ruko roof in Jakarta has one
  b.box('ac', 1.7, 1.4, 1.7, w * 0.22, h + 0.9, -d * 0.18);
}

// ---------------------------------------------------------------------------------------------
// 2. Office slab: ribbon glazing (the tile), a setback crown, piers, a lobby and a plant room
// ---------------------------------------------------------------------------------------------
function buildOffice(b: Batch, p: FacadePlan, T: string, front: number) {
  const { w, d, h, trim, seed } = p;
  const main = h * 0.82;
  // piers at the corners: the vertical edges a glass slab needs to read as a building
  b.box(T, 0.72, main, 0.72, w / 2 - 0.36, main / 2, front + 0.36);
  b.box(T, 0.72, main, 0.72, -w / 2 + 0.36, main / 2, front + 0.36);
  // one spandrel ledge every three storeys: horizontal banding at a readable scale
  for (let y = 3.6; y < main - 1; y += 10.2) {
    b.box(T, w + 0.12, 0.26, 0.5, 0, y, front - 0.2);
  }
  // lobby: a glazed ground floor, recessed under the first ledge, with a canopy
  b.box('glass', w * 0.82, 4.0, 0.16, 0, 2.2, front - 0.05);
  b.box(T, w * 0.9, 0.35, 1.1, 0, 4.45, front - 0.5);
  b.box(T, 0.34, 4.2, 0.34, w * 0.34, 2.1, front - 0.7);
  b.box(T, 0.34, 4.2, 0.34, -w * 0.34, 2.1, front - 0.7);
  // the setback: the upper fifth steps back, and the step shows as a shadowed ledge
  b.box(coreKey(trim), w * 0.84, 0.5, d * 0.84, 0, main + 0.2, 0);
  // plant room + two masts on the setback
  b.box(coreKey(trim), w * 0.34, 2.1, d * 0.3, w * 0.14, h + 1.05, 0);
  b.box('rail', 0.16, 6.5, 0.16, -w * 0.2, h + 3.2, 0);
  b.box('rail', 0.16, 4.4, 0.16, w * 0.34, h + 2.2, -d * 0.2);
  // one green-washed floor: a block of colour against the glass, like a rented-out storey
  if (seed % 3 === 0) b.box(coreKey(0x7f9a86), w * 0.99, 3.2, 0.1, 0, main * 0.52, front - 0.04);
}

// ---------------------------------------------------------------------------------------------
// 3. Walk-up flat: balcony slabs with rails, air-con boxes, a stair entrance on one side
// ---------------------------------------------------------------------------------------------
function buildWalkUp(b: Batch, p: FacadePlan, T: string, front: number) {
  const { w, d, h, seed } = p;
  const storey = 3.0;
  const floors = Math.max(2, Math.floor((h - 0.6) / storey));
  const bw = w * 0.9;
  for (let f = 1; f <= floors; f++) {
    const y = f * storey;
    // the slab: a real ledge with a soffit shadow, not a painted line
    b.box(T, bw, 0.2, 1.1, 0, y - 0.1, front - 0.55);
    // rail: two horizontal bars and posts, dark painted steel
    b.box('rail', bw, 0.06, 0.06, 0, y + 0.95, front - 1.05);
    b.box('rail', bw, 0.06, 0.06, 0, y + 0.55, front - 1.05);
    const posts = Math.max(3, Math.round(bw / 1.5));
    for (let i = 0; i <= posts; i++) {
      const x = -bw / 2 + (bw * i) / posts;
      b.box('rail', 0.06, 1.05, 0.06, x, y + 0.52, front - 1.05);
    }
    // the air-con box hanging off the slab, with its bracket
    if ((f + seed) % 2 === 1) {
      b.box('ac', 0.82, 0.6, 0.44, (f % 2 ? 1 : -1) * bw * 0.3, y + 0.42, front - 0.78);
    }
    // a laundry pole strung across some balconies: the cheapest way a flat looks lived in
    if ((f + seed) % 3 === 0) b.box('rail', bw * 0.7, 0.05, 0.05, 0, y + 1.55, front - 0.9);
  }
  // ground floor: a stair core with a canopy, two unit doors and a warung shutter in the corner bay
  // (the base of a Jakarta walk-up is never blank wall: it is where the laundry, the shop and the
  // meter cupboard are)
  b.box(coreKey(0x9a958a), w * 0.24, storey, 0.5, w * 0.3, storey / 2, front + 0.1);
  b.box('glass', 1.7, 2.3, 0.12, w * 0.3, 1.25, front - 0.1);
  b.box(T, 3.0, 0.22, 1.5, w * 0.3, 2.85, front - 0.6);
  b.face('sign', 2.3, 0.7, -w * 0.28, 2.6, front - 0.06, signCell(seed * 5 + 11));
  // unit doors on the ground floor, with a step and a meter cupboard beside each
  for (let i = 0; i < 2; i++) {
    const dx = -w * 0.28 + i * w * 0.22;
    b.box(coreKey(0x6a5a44), 1.05, 2.1, 0.12, dx, 1.05, front - 0.05);
    b.box('rail', 0.06, 0.16, 0.06, dx + 0.38, 1.15, front - 0.14);
    b.box(coreKey(0x8d8a80), 0.5, 0.9, 0.16, dx + 0.95, 0.45, front - 0.06);
  }
  // one bay of the base is a shop: a roller shutter and its awning, so the block meets the street
  b.box('shutter', w * 0.26, 2.2, 0.1, -w * 0.06, 1.2, front - 0.02);
  b.tilted(T, w * 0.3, 1.1, -w * 0.06, 2.55, front - 0.5, 0.16);
  // roof: two water tanks, because every rooftop in Jakarta has them
  b.box('ac', 1.5, 1.3, 1.5, -w * 0.2, h + 1.0, -d * 0.2);
  b.box('ac', 1.2, 1.1, 1.2, w * 0.12, h + 0.9, d * 0.14);
}

// ---------------------------------------------------------------------------------------------
// 4. Colonial shophouse: arcaded ground floor, shuttered windows, a cornice over the lot line
// ---------------------------------------------------------------------------------------------
function buildColonial(b: Batch, p: FacadePlan, T: string, front: number) {
  const { w, d, h, seed } = p;
  const arcadeH = 3.6;
  const pier = 0.44;
  const bays = Math.max(3, Math.round(w / 3.1));
  // the arcade: piers out on the pavement line, the wall set back behind them, a beam across
  for (let i = 0; i <= bays; i++) {
    const x = -w / 2 + (w * i) / bays;
    b.box(T, pier, arcadeH, pier, x, arcadeH / 2, front - 1.15);
  }
  b.box(T, w + 0.5, 0.5, 0.62, 0, arcadeH + 0.2, front - 1.15);
  b.box(T, w + 0.6, 0.22, 1.5, 0, 0.12, front - 0.75);
  // the wall between the piers is recessed and glazed: a shop behind the arcade
  b.box('shutter', w * 0.86, 2.5, 0.1, 0, 1.45, front - 0.06);
  b.face('sign', Math.min(w * 0.62, 4.0), 0.72, 0, 3.0, front - 0.12, signCell(seed * 3 + 5));
  // upper floor: shuttered windows with a white surround and a lintel over each
  const wins = Math.max(2, bays);
  const wy = arcadeH + 1.5;
  for (let i = 0; i < wins; i++) {
    const x = -w / 2 + (w * (i + 0.5)) / wins;
    b.box(T, 1.5, 2.35, 0.14, x, wy, front + 0.02);
    b.box('glass', 1.1, 1.95, 0.1, x, wy, front - 0.06);
    for (const s of [-1, 1]) b.box('shutter', 0.42, 1.9, 0.1, x + s * 0.78, wy, front - 0.1);
    b.box(T, 1.85, 0.2, 0.3, x, wy + 1.28, front - 0.1);
    b.face('grime', 1.5, 0.7, x, wy - 1.5, front - 0.08);
  }
  // the cornice: two stepped bands with dentils under them — the silhouette of Kota Tua
  b.box(T, w + 1.35, 0.36, d + 1.1, 0, h - 0.18, 0);
  b.box(T, w + 0.9, 0.3, d + 0.7, 0, h - 0.5, 0);
  const dentils = Math.max(4, Math.round(w / 1.05));
  for (let i = 0; i < dentils; i++) {
    const x = -w / 2 + (w * (i + 0.5)) / dentils;
    b.box(T, 0.26, 0.3, 0.34, x, h - 0.78, front - 0.24);
  }
  // a string course between the two floors
  b.box(T, w + 0.24, 0.22, 0.34, 0, arcadeH + 0.05, front - 0.08);
}

// ---------------------------------------------------------------------------------------------
// 5. Warung / corner kiosk: canvas awning over a counter, crates stacked at the side
// ---------------------------------------------------------------------------------------------
function buildWarung(b: Batch, p: FacadePlan, T: string, front: number) {
  const { w, seed } = p;
  const A = awningKey(pick(AWNINGS));
  // canvas awning, tilted out over the counter, with two poles holding its outer edge and a valance
  // hanging off the front lip: without the valance the canvas reads as a hard slab from the street
  b.tilted(A, w * 0.98, 2.4, 0, 2.95, front - 0.95, 0.26);
  b.box(A, w * 0.98, 0.34, 0.06, 0, 2.62, front - 2.14);
  b.box(T, w * 0.99, 0.12, 0.14, 0, 2.72, front - 2.1);
  b.box('rail', 0.07, 2.7, 0.07, -w * 0.44, 1.35, front - 2.05);
  b.box('rail', 0.07, 2.7, 0.07, w * 0.44, 1.35, front - 2.05);
  // the counter and its glass display case, lit
  b.box('counter', w * 0.78, 1.05, 0.55, 0, 0.55, front - 0.28);
  b.box('glass', w * 0.7, 0.5, 0.4, 0, 1.35, front - 0.28);
  // hand-painted name plate on the fascia, and the shop's own colours on the shutters
  b.face('sign', Math.min(w * 0.82, 2.6), 0.62, 0, 2.62, front - 2.18, signCell(seed * 11 + 7));
  b.box('shutter', w * 0.34, 1.9, 0.1, -w * 0.28, 1.15, front - 0.02);
  // crates stacked against the wall — the thing every warung has outside it
  for (let i = 0; i < 2 + (seed % 3); i++) {
    b.box(T, 0.55, 0.4, 0.5, w * 0.34 + (i % 2) * 0.2, 0.2 + Math.floor(i / 2) * 0.42, front - 0.5);
  }
}

// ---------------------------------------------------------------------------------------------
// 6. Mid-rise: a service core down one flank, and a wall painted with an advertisement
// ---------------------------------------------------------------------------------------------
function buildMidrise(b: Batch, p: FacadePlan, T: string, front: number) {
  const { w, d, h, seed, trim } = p;
  const coreW = Math.min(4.2, w * 0.26);
  const side = seed % 2 === 0 ? 1 : -1;
  // the core is proud of the facade and carries the risers, so it reads as a solid stripe
  b.box(coreKey(trim), coreW + 0.24, h * 0.99, 0.34, side * (w - coreW) / 2, h * 0.5, front + 0.12);
  b.box('rail', 0.22, h * 0.9, 0.22, side * (w - coreW) / 2 + coreW * 0.28, h * 0.47, front - 0.1);
  b.box('rail', 0.1, h * 0.86, 0.1, side * (w - coreW) / 2 - coreW * 0.22, h * 0.45, front - 0.08);
  // the painted advertising wall: a blank panel from the fourth floor up, taken out of the glass
  const adW = Math.min(w * 0.62, 11);
  const adH = Math.min(h * 0.36, 11);
  b.box(coreKey(trim), adW + 0.5, adH + 0.5, 0.18, -side * w * 0.04, h * 0.58, front + 0.02);
  b.face('ad', adW, adH, -side * w * 0.04, h * 0.58, front - 0.14, adCell(seed));
  // ground floor: lobby behind a canopy, and a signboard at the first-floor line
  b.box('glass', w * 0.6, 3.9, 0.14, -side * w * 0.08, 2.1, front - 0.04);
  b.box(T, w * 0.72, 0.3, 1.4, -side * w * 0.08, 4.3, front - 0.6);
  b.face('sign', Math.min(w * 0.5, 4.2), 0.8, -side * w * 0.08, 3.65, front - 0.12, signCell(seed * 13 + 2));
  // floor bands every four storeys: the horizontal that stops a 30 m wall reading as one slab
  for (let y = 12.5; y < h - 2; y += 12.5) b.box(T, w + 0.1, 0.2, 0.3, 0, y, front - 0.06);
  // lift overrun on the roof
  b.box(coreKey(trim), 3.0, 2.4, 3.0, side * (w * 0.2), h + 1.2, 0);
}
