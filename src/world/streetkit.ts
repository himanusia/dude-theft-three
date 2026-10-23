import * as THREE from 'three';
import { canvasTexture, mergeStaticChildren } from '../core/utils';

/**
 * The street kit: the vocabulary the city repeats most and had no shared words for.
 *
 * Road, kerb, trotoar, signalised junction, traffic light and the furniture that repeats on every
 * Jakarta street are drawn inline in `city.ts` today - a dashed line here, an instanced traffic
 * mast there, a 26 cm plate somewhere else. This file is the one place that knows what a lane is,
 * what a kerb is proud of, how a signal hangs, and which of these things a player can walk into.
 *
 * Every builder has the same shape: `(ctx, x, z, yaw, opts?) => THREE.Group`. It
 *  - builds in a local frame (x across, z along the run, y up from the ground),
 *  - samples `opts.ground` in WORLD coordinates so the surface follows terrain instead of assuming
 *    a table (the map undulates 2-3 m across a district, and 20-30 cm across a single junction),
 *  - merges its static meshes with `mergeStaticChildren()` before adding itself to `ctx.group`,
 *  - pushes one audit row per part that stands on the ground, with the bottom it really has,
 *  - pushes a collider only where a body would actually be stopped: poles, cabinets, bollards.
 *    Paint, kerbs, manholes and grates get none - a 12 cm kerb is a step, not a wall.
 *
 * Widths are the map's own, never invented: arterial 20 m, collector 12 m, local 8 m. Where the map
 * measures a road differently (Gatot Subroto is 16 m in `jakartamap.ts`) pass `widthM` and say why.
 *
 * References this was modelled against, all Wikimedia Commons, recorded in CREDITS.md:
 *  1. marka jalan (white dashed centre line, ~10 cm, 3 m dash / 5 m gap)  - street-ref-1.jpg
 *  2. Jalan Sudirman (20 m arterial, raised planted median, kerbed edge) - street-ref-2.jpg
 *  3. trotoar paving (long rectangular pavers, yellow tactile guide strip, linear drain) - street-ref-3.jpg
 *  4. Lemabang junction, Palembang (4 arms, wide kerb return, black/yellow pole base, stop line) - street-ref-4.jpg
 *  5. APILL cantilever signal (vertical red/amber/green head, short lens hoods) - street-ref-5.jpg
 *  6. utility pole (concrete pole, steel crossarm, porcelain insulators, pole transformer,
 *     sagging jumper leads) - street-ref-6.jpg
 */

export interface StreetCollider {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  h: number;
}

export interface StreetCtx {
  group: THREE.Group;
  colliders: StreetCollider[];
  audit: { name: string; x: number; z: number; bottom: number }[];
}

/** world-space ground height; the kit conforms to it instead of floating on y = 0 */
export type StreetGround = (x: number, z: number) => number;

export interface StreetOpts {
  ground?: StreetGround;
}

/** the three carriageway classes the map builds, in metres. Do not add a fourth. */
export const ROAD_CLASS_WIDTH = { arterial: 20, collector: 12, local: 8 } as const;
export type RoadClass = keyof typeof ROAD_CLASS_WIDTH;

/** trotoar, kerb stone, and how far the kerb stands proud of the carriageway (card numbers). */
export const WALK_WIDTH = 3.6;
export const KERB_WIDTH = 0.3;
export const KERB_PROUD = 0.12;

// ---------------------------------------------------------------- palette & textures

const texCache: { pavers?: THREE.Texture; hazard?: THREE.Texture } = {};
const matCache: {
  walk?: THREE.MeshStandardMaterial;
  slab?: THREE.MeshStandardMaterial;
  hazard?: THREE.MeshStandardMaterial;
} = {};

function pavers(): THREE.Texture {
  if (!texCache.pavers) {
    const tex = canvasTexture(256, 256, (ctx, w, h) => {
      // long rectangular pavers in bands, like the trotoar in street-ref-3. The mean stays on the
      // city's 0x9d988c walk colour; the joints carry the detail a close-up needs.
      ctx.fillStyle = '#9d988c';
      ctx.fillRect(0, 0, w, h);
      const rows = 4;
      const cols = 2;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = (c * w) / cols + (r % 2 ? w / (cols * 2) : 0);
          const y = (r * h) / rows;
          const v = 0.9 + ((r * 7 + c * 3) % 5) * 0.04;
          ctx.fillStyle = `rgb(${Math.round(157 * v)},${Math.round(152 * v)},${Math.round(140 * v)})`;
          ctx.fillRect(x + 1.5, y + 1.5, w / cols - 3, h / rows - 3);
        }
      }
      // joints: a dark bed line and a light chamfer above it, which is what makes paving read as
      // paving at two metres instead of as one grey slab
      for (let r = 0; r <= rows; r++) {
        const y = (r * h) / rows;
        ctx.strokeStyle = 'rgba(84,80,72,0.95)';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(226,222,210,0.35)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, y - 3);
        ctx.lineTo(w, y - 3);
        ctx.stroke();
      }
      for (let c = 0; c <= cols; c++) {
        const x = (c * w) / cols;
        ctx.strokeStyle = 'rgba(84,80,72,0.9)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let i = 0; i < 260; i++) {
        ctx.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '70,66,60'},0.05)`;
        ctx.fillRect(Math.random() * w, Math.random() * h, 3, 2);
      }
    });
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    texCache.pavers = tex;
  }
  return texCache.pavers;
}

function hazardTex(): THREE.Texture {
  if (!texCache.hazard) {
    const tex = canvasTexture(128, 128, (ctx, w, h) => {
      ctx.fillStyle = '#f2c14e';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#1b1b1b';
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(-Math.PI / 4);
      for (let i = -3; i <= 3; i++) ctx.fillRect(i * 40 - 12, -h, 24, h * 2);
      ctx.restore();
    });
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    texCache.hazard = tex;
  }
  return texCache.hazard;
}

const walkMaterial = (): THREE.MeshStandardMaterial =>
  (matCache.walk ??= new THREE.MeshStandardMaterial({ map: pavers(), roughness: 0.95 }));

/**
 * The corner slab is an ExtrudeGeometry, whose UVs are the shape's own metres, so it needs the same
 * pavers at 1.8 m per tile instead of 1 per face.
 */
const slabMaterial = (): THREE.MeshStandardMaterial => {
  if (!matCache.slab) {
    const tex = pavers().clone();
    tex.needsUpdate = true;
    tex.repeat.set(1 / 1.8, 1 / 1.8);
    matCache.slab = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.96 });
  }
  return matCache.slab;
};

const hazardMaterial = (): THREE.MeshStandardMaterial =>
  (matCache.hazard ??= new THREE.MeshStandardMaterial({ map: hazardTex(), roughness: 0.8 }));

const M = {
  asphalt: new THREE.MeshStandardMaterial({ color: 0x1b1f24, roughness: 1 }),
  paint: new THREE.MeshStandardMaterial({ color: 0xe6e4ec, roughness: 0.92 }),
  kerb: new THREE.MeshStandardMaterial({ color: 0xd6d0c2, roughness: 0.95 }),
  kerbNose: new THREE.MeshStandardMaterial({ color: 0xbdb7a9, roughness: 0.95 }),
  tactile: new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.9 }),
  drain: new THREE.MeshStandardMaterial({ color: 0x6d6961, roughness: 0.98 }),
  iron: new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.72, metalness: 0.35 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x8f979e, roughness: 0.45, metalness: 0.6 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0x9a9a92, roughness: 0.95 }),
  housing: new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.85 }),
  lensRed: new THREE.MeshStandardMaterial({ color: 0x9c2418, emissive: 0xd8452f, emissiveIntensity: 0.85, roughness: 0.45 }),
  lensAmberLit: new THREE.MeshStandardMaterial({ color: 0x8a5c12, emissive: 0xf2a41d, emissiveIntensity: 0.85, roughness: 0.45 }),
  lensGreenLit: new THREE.MeshStandardMaterial({ color: 0x14502f, emissive: 0x2fd470, emissiveIntensity: 0.85, roughness: 0.45 }),
  lensOff: new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.5 }),
  black: new THREE.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.8 }),
  yellow: new THREE.MeshStandardMaterial({ color: 0xf2c14e, roughness: 0.8 }),
  soil: new THREE.MeshStandardMaterial({ color: 0x3f3a30, roughness: 1 }),
  shrub: new THREE.MeshStandardMaterial({ color: 0x2f7a3a, roughness: 1, flatShading: true }),
  porcelain: new THREE.MeshStandardMaterial({ color: 0x5a4636, roughness: 0.4, metalness: 0.1 }),
  cable: new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.9 }),
  walk: walkMaterial(),
  hazard: hazardMaterial(),
};

// ---------------------------------------------------------------- geometry helpers

/**
 * A flat face that follows the ground. The city's roads are ribbons that sample terrain per vertex;
 * a kit that assumes y = 0 either sinks at one end or floats at the other, and that is exactly the
 * defect a close-up screenshot exposes.
 */
function gridMesh(
  k: Kit,
  w: number,
  d: number,
  nx: number,
  nz: number,
  lift: number,
  material: THREE.Material,
  cx = 0,
  cz = 0
): THREE.Mesh {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const lx = cx - w / 2 + (i / nx) * w;
      const lz = cz - d / 2 + (j / nz) * d;
      pos.push(lx, k.gy(lx, lz) + lift, lz);
      uv.push(lx, lz);
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 2;
      const dd = a + nx + 1;
      idx.push(a, c, b, a, dd, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  k.g.add(mesh);
  return mesh;
}

/** One box per `step` metres along a run, each planted on the ground under it. */
function runBox(
  k: Kit,
  axis: 'x' | 'z',
  across: number,
  h: number,
  length: number,
  atAcross: number,
  atAlong: number,
  material: THREE.Material,
  step = 2.5,
  lift = 0
): void {
  const n = Math.max(1, Math.ceil(length / step));
  const seg = length / n;
  for (let s = 0; s < n; s++) {
    const along = atAlong - length / 2 + (s + 0.5) * seg;
    const lx = axis === 'z' ? atAcross : along;
    const lz = axis === 'z' ? along : atAcross;
    const box =
      axis === 'z'
        ? new THREE.BoxGeometry(across, h, seg + 0.02)
        : new THREE.BoxGeometry(seg + 0.02, h, across);
    const m = new THREE.Mesh(box, material);
    m.position.set(lx, k.gy(lx, lz) + lift + h / 2, lz);
    m.castShadow = true;
    m.receiveShadow = true;
    k.g.add(m);
  }
}

/** The city draws its road ribbons 5 cm over the terrain; the kit matches that, or every surface
 *  coplanar with the ground mesh z-fights at distance. Everything on the carriageway stacks on it. */
const ROAD_LIFT = 0.05;

/** Paint: no thickness worth casting a shadow with, lifted just clear of the asphalt. */
const PAINT_LIFT = ROAD_LIFT + 0.022;

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, start: number): number {
  let size = start;
  ctx.font = `700 ${size}px system-ui, sans-serif`;
  while (ctx.measureText(text).width > maxWidth && size > 9) {
    size -= 1;
    ctx.font = `700 ${size}px system-ui, sans-serif`;
  }
  return size;
}

class Kit {
  readonly g = new THREE.Group();
  readonly ground: StreetGround;
  constructor(
    readonly ctx: StreetCtx,
    readonly x: number,
    readonly z: number,
    readonly yaw: number,
    opts?: StreetOpts
  ) {
    this.ground = opts?.ground ?? (() => 0);
    this.g.position.set(x, 0, z);
    this.g.rotation.y = yaw;
  }

  /** local -> world, same convention as `THREE.Object3D.rotation.y` */
  world(lx: number, lz: number): [number, number] {
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    return [this.x + lx * c + lz * s, this.z - lx * s + lz * c];
  }

  /**
   * Ground height under a local point. Groups sit at y = 0 and every mesh carries its own world y,
   * so a rotated kit still lands on the terrain instead of on a tilted plane of its own.
   */
  gy(lx: number, lz: number): number {
    const [wx, wz] = this.world(lx, lz);
    return this.ground(wx, wz);
  }

  /** add a mesh anchored on the ground at local (lx, lz), `lift` metres above it */
  plant(mesh: THREE.Object3D, lx: number, lz: number, lift = 0): THREE.Object3D {
    mesh.position.set(lx, this.gy(lx, lz) + lift, lz);
    this.g.add(mesh);
    return mesh;
  }

  collider(lx: number, lz: number, halfX: number, halfZ: number, h: number): void {
    const pts = [
      [lx - halfX, lz - halfZ],
      [lx + halfX, lz - halfZ],
      [lx - halfX, lz + halfZ],
      [lx + halfX, lz + halfZ],
    ].map(([a, b]) => this.world(a, b));
    const xs = pts.map((p) => p[0]);
    const zs = pts.map((p) => p[1]);
    this.ctx.colliders.push({
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minZ: Math.min(...zs),
      maxZ: Math.max(...zs),
      h,
    });
  }

  finish(name: string, anchorLx = 0, anchorLz = 0): void {
    mergeStaticChildren(this.g);
    this.ctx.group.add(this.g);
    const [wx, wz] = this.world(anchorLx, anchorLz);
    this.ctx.audit.push({ name, x: wx, z: wz, bottom: this.gy(anchorLx, anchorLz) });
  }
}

function kit(ctx: StreetCtx, x: number, z: number, yaw: number, opts?: StreetOpts): Kit {
  return new Kit(ctx, x, z, yaw, opts);
}

// ---------------------------------------------------------------- 1. road segment

export interface RoadSegmentOpts extends StreetOpts {
  roadClass?: RoadClass;
  /** a width taken from the map for a road that is not one of the three classes (e.g. 16 m) */
  widthM?: number;
  lengthM?: number;
  /** lanes across the whole carriageway; default arterial 4, collector 4, local 2 */
  lanes?: number;
  median?: 'none' | 'paint' | 'raised';
}

/**
 * Carriageway with lane markings, edge line and an optional median.
 *
 * The asphalt is the city's own 0x1b1f24, so a segment laid over the existing road reads as the same
 * surface rather than a patch. Paint is white: Indonesian centre lines are white, not yellow
 * (street-ref-1), dashed 3 m on / 5 m off, 12 cm wide.
 */
export function buildRoadSegment(
  ctx: StreetCtx,
  x: number,
  z: number,
  yaw: number,
  opts: RoadSegmentOpts = {}
): THREE.Group {
  const k = kit(ctx, x, z, yaw, opts);
  const cls = opts.roadClass ?? 'collector';
  const width = opts.widthM ?? ROAD_CLASS_WIDTH[cls];
  const length = opts.lengthM ?? 40;
  const half = width / 2;
  // 20 m of asphalt with a 1.5 m median is three 3.3 m lanes a side, which is what the photo of
  // Sudirman (street-ref-2) shows once you discount the busway; a collector is two a side.
  const lanes = opts.lanes ?? (cls === 'local' ? 2 : cls === 'arterial' ? 6 : 4);
  const median = opts.median ?? (cls === 'arterial' ? 'raised' : 'paint');

  gridMesh(k, width, length, 4, Math.max(4, Math.round(length / 4)), ROAD_LIFT, M.asphalt);

  // continuous edge line, 30 cm in from the kerb face
  for (const side of [-1, 1]) {
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(0.15, length), M.paint);
    strip.rotation.x = -Math.PI / 2;
    k.plant(strip, side * (half - 0.3), 0, PAINT_LIFT);
  }

  // lane dividers: dashes, skipping the centreline (that is the median's business)
  const laneW = width / lanes;
  for (let i = 1; i < lanes; i++) {
    const lx = -half + laneW * i;
    if (Math.abs(lx) < laneW * 0.5 + 0.01) continue;
    for (let d = -length / 2 + 3; d < length / 2 - 3; d += 8) {
      const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 3), M.paint);
      dash.rotation.x = -Math.PI / 2;
      k.plant(dash, lx, d, PAINT_LIFT);
    }
  }

  if (median === 'paint') {
    // double centre line on the narrower classes
    for (const off of [-0.14, 0.14]) {
      const line = new THREE.Mesh(new THREE.PlaneGeometry(0.12, length), M.paint);
      line.rotation.x = -Math.PI / 2;
      k.plant(line, off, 0, PAINT_LIFT);
    }
  } else if (median === 'raised') {
    // a planted median, kerbed both sides (street-ref-2). 1.5 m is the narrow end of what the photo
    // shows; the fill is soil with low clipped shrubs, not lawn.
    const mw = 1.5;
    for (const side of [-1, 1]) {
      runBox(k, 'z', 0.2, 0.34, length, side * (mw / 2 - 0.1), 0, M.kerb, 2.5, ROAD_LIFT);
    }
    gridMesh(k, mw - 0.4, length, 2, Math.max(2, Math.round(length / 6)), ROAD_LIFT + 0.3, M.soil);
    for (let d = -length / 2 + 3; d < length / 2 - 3; d += 2.6) {
      const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 0), M.shrub);
      bush.scale.set(1, 0.62, 1);
      bush.castShadow = true;
      k.plant(bush, Math.sin(d * 1.7) * 0.28, d, ROAD_LIFT + 0.42);
    }
    k.collider(0, 0, mw / 2, length / 2, 0.34);
  }

  k.finish(`street:road-${cls}`, 0, 0);
  return k.g;
}

// ---------------------------------------------------------------- 2. kerb + trotoar

export interface KerbWalkOpts extends StreetOpts {
  lengthM?: number;
  /** tactile studs at a crossing, 60 cm band as in street-ref-3 */
  tactile?: boolean;
  /** where along the run the crossing sits */
  crossingAt?: number;
  /** linear drain channel along the outer edge */
  drain?: boolean;
}

/**
 * Kerb + trotoar module. The kerb stone is 30 cm wide and stands 12 cm proud of the carriageway;
 * the walk behind it is 3.6 m. Local frame: the kerb face is at x = -0.3, the walk runs to x = +3.9,
 * so a caller mirrors it with yaw = PI.
 */
export function buildKerbWalk(ctx: StreetCtx, x: number, z: number, yaw: number, opts: KerbWalkOpts = {}): THREE.Group {
  const k = kit(ctx, x, z, yaw, opts);
  const length = opts.lengthM ?? 30;
  const crossingAt = opts.crossingAt ?? 0;

  // kerb stone: the exposed band between asphalt and walk, 12 cm of it
  runBox(k, 'z', KERB_WIDTH, KERB_PROUD, length, -KERB_WIDTH / 2, 0, M.kerb, 2.5, ROAD_LIFT);
  // a lighter 10 cm cap along the road edge, which is what a kerb looks like from a car
  runBox(k, 'z', 0.1, 0.03, length, -KERB_WIDTH + 0.05, 0, M.kerbNose, 2.5, ROAD_LIFT + KERB_PROUD - 0.03);

  // walk: one textured slab per 2.5 m, flush behind the kerb, following the ground under it
  runBox(k, 'z', WALK_WIDTH, KERB_PROUD, length, WALK_WIDTH / 2, 0, M.walk, 2.5, ROAD_LIFT);

  // tactile studs where the crossing meets the walk: 60 cm band of truncated domes
  if (opts.tactile !== false) {
    const bandZ = crossingAt;
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 26; j++) {
        const stud = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.014, 0.055), M.tactile);
        k.plant(stud, 0.25 + i * 0.1, bandZ - 1.56 + j * 0.12, ROAD_LIFT + KERB_PROUD + 0.007);
      }
    }
    // a directional bar strip leads out of the studs, like the guidance strip in street-ref-3
    for (let j = 0; j < 8; j++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.012, 0.07), M.tactile);
      k.plant(bar, 1.05, bandZ - 1.54 + j * 0.44, ROAD_LIFT + KERB_PROUD + 0.006);
    }
    // painted hazard on the kerb face either side of the crossing mouth
    for (const side of [-1, 1]) {
      const guard = new THREE.Mesh(new THREE.BoxGeometry(0.02, KERB_PROUD - 0.01, 2.2), M.hazard);
      k.plant(guard, -KERB_WIDTH - 0.01, bandZ + side * 2.4, ROAD_LIFT + KERB_PROUD / 2);
    }
  }

  if (opts.drain !== false) {
    // linear drain channel at the back of the walk, with a grate bar every 40 cm
    runBox(k, 'z', 0.36, 0.05, length, WALK_WIDTH + 0.18, 0, M.drain, 2.5, ROAD_LIFT - 0.03);
    for (let d = -length / 2 + 1; d < length / 2 - 1; d += 0.4) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.03, 0.05), M.iron);
      k.plant(bar, WALK_WIDTH + 0.18, d, ROAD_LIFT + 0.012);
    }
  }

  k.finish('street:kerb-walk', WALK_WIDTH / 2, 0);
  return k.g;
}

// ---------------------------------------------------------------- 4. traffic light

export interface TrafficLightOpts extends StreetOpts {
  /** which aspect is lit; the head always carries all three lenses */
  lit?: 'red' | 'amber' | 'green';
  /** arm length over the carriageway, metres */
  armM?: number;
}

const LENS_R = 0.145;

/**
 * Cantilever signal, after street-ref-5 (vertical three-lens head, short hoods, slim tubular arm)
 * and street-ref-4 (black/yellow base guard, controller cabinet on the pavement, ~6 m to the head).
 *
 * Local frame: pole base at the origin, the arm reaches +x over the carriageway, and the head faces
 * +z - towards a driver travelling -z. Placed at the left kerb of an approach it reads correctly
 * for left-hand traffic.
 */
export function buildTrafficLight(ctx: StreetCtx, x: number, z: number, yaw: number, opts: TrafficLightOpts = {}): THREE.Group {
  const k = kit(ctx, x, z, yaw, opts);
  const armM = opts.armM ?? 5.6;
  const lit = opts.lit ?? 'red';

  // concrete footing, striped guard, then the mast
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.16, 0.78), M.concrete);
  k.plant(plinth, 0, 0, 0.08);

  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.46, 1.0, 0.46), M.hazard);
  k.plant(guard, 0, 0, 0.16 + 0.5);

  const guardCap = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.07, 0.52), M.iron);
  k.plant(guardCap, 0, 0, 1.2);

  const poleH = 6.4;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.115, poleH, 10), M.steel);
  k.plant(pole, 0, 0, 1.16 + poleH / 2);

  for (const cy of [1.9, 3.4]) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.135, 0.07, 10), M.iron);
    k.plant(ring, 0, 0, cy);
  }

  // cantilever arm: straight tubular steel with a diagonal brace back to the mast
  const armY = 6.28;
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.062, armM, 8), M.steel);
  arm.rotation.z = Math.PI / 2;
  k.plant(arm, armM / 2, 0, armY);
  const braceRun = armM * 0.42;
  const braceRise = 1.5;
  const braceLen = Math.hypot(braceRun, braceRise);
  const brace = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, braceLen, 6), M.steel);
  // a Y-axis cylinder rotated about Z by th points (-sin th, cos th): solve for (+run, +rise)
  brace.rotation.z = Math.atan2(-braceRun, braceRise);
  k.plant(brace, braceRun / 2, 0, armY - braceRise / 2);

  // the head: three lenses, hooded, hanging under the arm
  const headX = armM - 0.5;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.16, 0.26), M.housing);
  k.plant(head, headX, 0, armY - 0.72);
  const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.2, 0.07), M.steel);
  k.plant(bracket, headX, 0, armY - 0.1);

  const rows: { key: 'red' | 'amber' | 'green'; y: number; mat: THREE.Material }[] = [
    { key: 'red', y: armY - 0.3, mat: lit === 'red' ? M.lensRed : M.lensOff },
    { key: 'amber', y: armY - 0.72, mat: lit === 'amber' ? M.lensAmberLit : M.lensOff },
    { key: 'green', y: armY - 1.14, mat: lit === 'green' ? M.lensGreenLit : M.lensOff },
  ];
  for (const row of rows) {
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(LENS_R, LENS_R, 0.06, 14), row.mat);
    lens.rotation.x = Math.PI / 2;
    k.plant(lens, headX, 0.15, row.y);
    // the hood: these are what make a signal read as a signal. A half tube is invisible from the
    // front, so each lens gets a recessed eye ring and a flat visor plate over it.
    const eye = new THREE.Mesh(new THREE.TorusGeometry(LENS_R + 0.014, 0.024, 5, 16), M.housing);
    k.plant(eye, headX, 0.158, row.y);
    // hood: a sun visor over the lens with a cheek each side, so it reads from the front and from
    // the side instead of disappearing into the face
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.055, 0.27), M.housing);
    k.plant(visor, headX, 0.07, row.y + 0.175);
    for (const cheek of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.19, 0.27), M.housing);
      k.plant(wall, headX + cheek * 0.178, 0.07, row.y + 0.115);
    }
  }

  // pedestrian head lower on the mast, facing the same way
  const pedHousing = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.62, 0.2), M.housing);
  k.plant(pedHousing, 0.02, 0.16, 2.62);
  const pedRed = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.19, 0.03), M.lensRed);
  k.plant(pedRed, 0.02, 0.27, 2.78);
  const pedGreen = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.19, 0.03), M.lensOff);
  k.plant(pedGreen, 0.02, 0.27, 2.46);
  const pedVisor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.04, 0.2), M.housing);
  k.plant(pedVisor, 0.02, 0.28, 2.93);
  const pedBracket = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.18), M.steel);
  k.plant(pedBracket, 0.02, 0.05, 2.62);

  // controller cabinet on the pavement beside the mast, on its own plinth
  const ctrlX = -1.25;
  const ctrlZ = 0.95;
  const plinthC = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.12, 0.48), M.concrete);
  k.plant(plinthC, ctrlX, ctrlZ, 0.06);
  const cabinet = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.12, 0.36), M.steel);
  k.plant(cabinet, ctrlX, ctrlZ, 0.12 + 0.56);
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.94, 0.03), M.concrete);
  k.plant(door, ctrlX, ctrlZ + 0.18, 0.12 + 0.56);
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.1, 0.02), M.yellow);
  k.plant(plate, ctrlX, ctrlZ + 0.19, 1.06);

  k.collider(0, 0, 0.42, 0.42, 1.3);
  k.collider(ctrlX, ctrlZ, 0.3, 0.24, 1.3);
  k.finish('street:traffic-light', 0, 0);
  return k.g;
}

// ---------------------------------------------------------------- 3. signalised intersection

export interface IntersectionOpts extends StreetOpts {
  roadClass?: RoadClass;
  widthM?: number;
  /** how far each arm runs out from the junction box */
  armsM?: number;
  /** kerb return radius at each corner */
  cornerRadiusM?: number;
  zebra?: boolean;
  /** compose a traffic light on each corner (reuses buildTrafficLight) */
  lights?: boolean;
}

/**
 * A four-arm signalised junction: carriageway, zebra crossings on every arm, stop lines, and the
 * corner radius filled with kerbed pavement.
 *
 * The kerb return is the detail that makes a junction read as a junction: the kerb line leaves the
 * arm, sweeps an arc of `cornerRadiusM`, and joins the crossing arm. Outside that arc is pavement;
 * inside it is the asphalt a turning bus needs (street-ref-4).
 */
export function buildSignalIntersection(
  ctx: StreetCtx,
  x: number,
  z: number,
  yaw: number,
  opts: IntersectionOpts = {}
): THREE.Group {
  const k = kit(ctx, x, z, yaw, opts);
  const cls = opts.roadClass ?? 'collector';
  const width = opts.widthM ?? ROAD_CLASS_WIDTH[cls];
  const half = width / 2;
  const arms = opts.armsM ?? 14;
  const R = opts.cornerRadiusM ?? 8;

  // asphalt: the junction box plus four arms, all conforming to the ground
  gridMesh(k, width, width, 3, 3, ROAD_LIFT, M.asphalt);
  for (const [nx, nz] of [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ]) {
    const cx = nx * (half + arms / 2);
    const cz = nz * (half + arms / 2);
    if (nx) gridMesh(k, arms, width, 4, 3, ROAD_LIFT, M.asphalt, cx, cz);
    else gridMesh(k, width, arms, 3, 4, ROAD_LIFT, M.asphalt, cx, cz);
  }

  // paint per arm: zebra stripes longitudinal to travel, stop line across the inbound half
  const stripeW = 0.45;
  const zebraFrom = half + 2.2;
  const zebraLen = 3.6;
  const stopD = zebraFrom + zebraLen + 1.4;
  const perArm = Math.floor((width - 0.8) / (stripeW * 2));
  // arm 0 extends +z (traffic travels -z), and so on round the junction. Left-hand traffic: the
  // inbound half sits to the left of the direction of travel, which is `up x forward`.
  const armDefs = [
    { axis: 'z', dir: 1, inbound: -half / 2 },
    { axis: 'z', dir: -1, inbound: half / 2 },
    { axis: 'x', dir: 1, inbound: half / 2 },
    { axis: 'x', dir: -1, inbound: -half / 2 },
  ] as const;
  for (const arm of armDefs) {
    const along = arm.dir * (zebraFrom + zebraLen / 2);
    if (opts.zebra !== false) {
      for (let i = 0; i < perArm; i++) {
        const off = -((perArm - 1) / 2) * stripeW * 2 + i * stripeW * 2;
        const stripe =
          arm.axis === 'z'
            ? new THREE.Mesh(new THREE.PlaneGeometry(stripeW, zebraLen), M.paint)
            : new THREE.Mesh(new THREE.PlaneGeometry(zebraLen, stripeW), M.paint);
        stripe.rotation.x = -Math.PI / 2;
        if (arm.axis === 'z') k.plant(stripe, off, along, PAINT_LIFT);
        else k.plant(stripe, along, off, PAINT_LIFT);
      }
    }
    const stop =
      arm.axis === 'z'
        ? new THREE.Mesh(new THREE.PlaneGeometry(half - 0.15, 0.3), M.paint)
        : new THREE.Mesh(new THREE.PlaneGeometry(0.3, half - 0.15), M.paint);
    stop.rotation.x = -Math.PI / 2;
    if (arm.axis === 'z') k.plant(stop, arm.inbound, arm.dir * stopD, PAINT_LIFT);
    else k.plant(stop, arm.dir * stopD, arm.inbound, PAINT_LIFT);

    // the arm past the stop line still needs its edge lines and a lane divider, or the junction
    // reads as a painted box dropped on empty asphalt
    const from = stopD + 1.2;
    const to = half + arms;
    const mid = arm.dir * ((from + to) / 2);
    const span = to - from;
    for (const side of [-1, 1]) {
      const edge =
        arm.axis === 'z'
          ? new THREE.Mesh(new THREE.PlaneGeometry(0.12, span), M.paint)
          : new THREE.Mesh(new THREE.PlaneGeometry(span, 0.12), M.paint);
      edge.rotation.x = -Math.PI / 2;
      if (arm.axis === 'z') k.plant(edge, side * (half - 0.3), mid, PAINT_LIFT);
      else k.plant(edge, mid, side * (half - 0.3), PAINT_LIFT);
    }
    for (let d = from; d + 3 < to; d += 6) {
      const dash =
        arm.axis === 'z'
          ? new THREE.Mesh(new THREE.PlaneGeometry(0.12, 3), M.paint)
          : new THREE.Mesh(new THREE.PlaneGeometry(3, 0.12), M.paint);
      dash.rotation.x = -Math.PI / 2;
      if (arm.axis === 'z') k.plant(dash, 0, arm.dir * (d + 1.5), PAINT_LIFT);
      else k.plant(dash, arm.dir * (d + 1.5), 0, PAINT_LIFT);
    }
  }

  // four kerbed corner pavements: a square with the quarter-circle kerb return cut out of it
  const inner = half;
  const outer = half + arms;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      // the shape is built in (x, -z) so a -90 deg lay-down maps shape y onto world z
      const shape = new THREE.Shape();
      const P = (px: number, pz: number) => [px, -pz] as [number, number];
      const p1 = P(sx * inner, sz * (inner + R));
      shape.moveTo(p1[0], p1[1]);
      const Cx = sx * (inner + R);
      const Cz = sz * (inner + R);
      const arcSteps = 12;
      for (let i = 1; i <= arcSteps; i++) {
        const th = (i / arcSteps) * (Math.PI / 2);
        const ax = Cx - sx * R * Math.cos(th);
        const az = Cz - sz * R * Math.sin(th);
        const p = P(ax, az);
        shape.lineTo(p[0], p[1]);
      }
      for (const p of [P(sx * outer, sz * inner), P(sx * outer, sz * outer), P(sx * inner, sz * outer)]) {
        shape.lineTo(p[0], p[1]);
      }
      shape.closePath();

      const depth = KERB_PROUD + 0.1;
      const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
      const slab = new THREE.Mesh(geo, slabMaterial());
      slab.rotation.x = -Math.PI / 2;
      const gx = k.gy(sx * (inner + arms * 0.5), sz * (inner + arms * 0.5));
      slab.position.set(0, gx - 0.1 + ROAD_LIFT, 0);
      slab.receiveShadow = true;
      slab.castShadow = true;
      k.g.add(slab);

      // the kerb on the arc: stones stepped along the return
      const arcLen = (Math.PI / 2) * R;
      const steps = Math.max(8, Math.ceil(arcLen / 0.55));
      const stoneW = arcLen / steps + 0.02;
      for (let i = 0; i < steps; i++) {
        const th = ((i + 0.5) / steps) * (Math.PI / 2);
        const px = Cx - sx * (R - KERB_WIDTH / 2) * Math.cos(th);
        const pz = Cz - sz * (R - KERB_WIDTH / 2) * Math.sin(th);
        const stone = new THREE.Mesh(new THREE.BoxGeometry(stoneW, KERB_PROUD + 0.015, KERB_WIDTH), M.kerb);
        // tangent of the arc at this angle
        stone.rotation.y = Math.atan2(sz * Math.sin(th), -sx * Math.cos(th)) + Math.PI / 2;
        k.plant(stone, px, pz, ROAD_LIFT + (KERB_PROUD + 0.015) / 2);
      }
      // kerb returns along both arms, so the pavement edge does not stop in mid air
      runBox(
        k,
        'z',
        KERB_WIDTH,
        KERB_PROUD + 0.015,
        arms - R,
        sx * (inner + KERB_WIDTH / 2),
        sz * (inner + R + (arms - R) / 2),
        M.kerb,
        2.5,
        ROAD_LIFT
      );
      runBox(
        k,
        'x',
        KERB_WIDTH,
        KERB_PROUD + 0.015,
        arms - R,
        sz * (inner + R + (arms - R) / 2),
        sx * (inner + KERB_WIDTH / 2),
        M.kerb,
        2.5,
        ROAD_LIFT
      );
    }
  }

  if (opts.lights !== false) {
    // one mast per approach, on the left kerb of that approach, arm over the carriageway
    const lx = half + 1.6;
    const lz = zebraFrom + zebraLen + 2.6;
    const corners: [number, number, number, 'red' | 'green'][] = [
      [-lx, lz, 0, 'green'],
      [lx, -lz, Math.PI, 'green'],
      [lz, lx, Math.PI / 2, 'red'],
      [-lz, -lx, -Math.PI / 2, 'red'],
    ];
    for (const [ax, az, ayaw, lit] of corners) {
      const [wx, wz] = k.world(ax, az);
      buildTrafficLight(ctx, wx, wz, yaw + ayaw, { ground: opts.ground, lit });
    }
  }

  k.finish('street:signal-intersection', 0, 0);
  return k.g;
}

// ---------------------------------------------------------------- 5. street furniture

export interface UtilityPoleOpts extends StreetOpts {
  spanM?: number;
  cables?: boolean;
}

/**
 * Utility pole with the cables that define a Jakarta skyline: concrete pole, steel crossarm,
 * porcelain insulators, a pole transformer, and catenary spans that sag (street-ref-6). Cables run
 * `spanM` along the local +x, so two poles placed that far apart in the arm direction read as one
 * line - which is the point of making them one object.
 */
export function buildUtilityPole(ctx: StreetCtx, x: number, z: number, yaw: number, opts: UtilityPoleOpts = {}): THREE.Group {
  const k = kit(ctx, x, z, yaw, opts);
  const span = opts.spanM ?? 18;
  const H = 9.2;

  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.4, 0.28, 8), M.concrete);
  k.plant(foot, 0, 0, 0.14);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.185, H, 8), M.concrete);
  k.plant(pole, 0, 0, H / 2);

  const arm = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.1, 0.11), M.steel);
  k.plant(arm, 0, 0, H - 0.55);
  for (const ox of [-0.85, 0, 0.85]) {
    const ins = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.075, 0.26, 8), M.porcelain);
    k.plant(ins, ox, 0, H - 0.37);
  }
  // pole-mounted transformer on a bracket - the thing that makes the pole read as distribution
  const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.07, 0.5), M.steel);
  k.plant(bracket, 0.42, 0, 6.05);
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.92, 10), M.steel);
  k.plant(drum, 0.55, 0, 6.62);
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.06, 10), M.iron);
  k.plant(lid, 0.55, 0, 7.11);
  for (const ox of [-0.28, 0.28]) {
    const cut = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.3, 6), M.porcelain);
    k.plant(cut, ox + 0.3, 0, 7.5);
  }

  if (opts.cables !== false) {
    const catenary = (a: THREE.Vector3, b: THREE.Vector3, sag: number, r: number) => {
      const mid = a.clone().lerp(b, 0.5);
      mid.y -= sag;
      const curve = new THREE.CatmullRomCurve3([a, mid, b]);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 10, r, 4, false), M.cable);
      tube.castShadow = true;
      k.g.add(tube);
    };
    const baseY = k.gy(0, 0);
    const spans: [number, number, number][] = [
      [-0.85, H - 0.2, 0.9],
      [0, H - 0.18, 0.95],
      [0.85, H - 0.2, 1.0],
    ];
    for (const [ox, oy, sag] of spans) {
      catenary(new THREE.Vector3(ox, baseY + oy, 0), new THREE.Vector3(ox + span, baseY + oy, 0), sag, 0.022);
    }
    // telecom bundle, lower and slacker
    for (const oy of [6.9, 6.7]) {
      catenary(new THREE.Vector3(0.12, baseY + oy, 0.1), new THREE.Vector3(0.12 + span, baseY + oy, 0.1), 1.5, 0.017);
    }
  }

  k.collider(0, 0, 0.28, 0.28, 2.4);
  k.finish('street:utility-pole', 0, 0);
  return k.g;
}

export interface StreetSignOpts extends StreetOpts {
  /** plesetan, never a real street name */
  upper?: string;
  lower?: string;
}

function plateTexture(upper: string, lower: string): THREE.Texture {
  return canvasTexture(512, 128, (ctx, w, h) => {
    ctx.fillStyle = '#1f6b3a';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#f2f4f0';
    ctx.lineWidth = 6;
    ctx.strokeRect(8, 8, w - 16, h - 16);
    ctx.fillStyle = '#f7faf5';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const size = fitText(ctx, upper, w - 60, 58);
    ctx.font = `700 ${size}px system-ui, sans-serif`;
    ctx.fillText(upper, w / 2, h * 0.4);
    ctx.font = '600 25px system-ui, sans-serif';
    ctx.fillText(lower, w / 2, h * 0.76);
  });
}

/** Street name blade on a post: green plate, white border, grey pole, two blades at right angles. */
export function buildStreetNameSign(ctx: StreetCtx, x: number, z: number, yaw: number, opts: StreetSignOpts = {}): THREE.Group {
  const k = kit(ctx, x, z, yaw, opts);
  const upper = opts.upper ?? 'JL. TAMRIN RAYA';
  const lower = opts.lower ?? 'KEC. TAMAN SARI';

  const foot = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.1, 0.28), M.concrete);
  k.plant(foot, 0, 0, 0.05);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 3.1, 8), M.steel);
  k.plant(post, 0, 0, 1.55);

  const blade = new THREE.Mesh(
    new THREE.BoxGeometry(2.0, 0.42, 0.045),
    new THREE.MeshStandardMaterial({ map: plateTexture(upper, lower), roughness: 0.6 })
  );
  k.plant(blade, 0.9, 0, 2.85 + 0.21);

  const cross = new THREE.Mesh(
    new THREE.BoxGeometry(1.5, 0.36, 0.045),
    new THREE.MeshStandardMaterial({ map: plateTexture('GANG KELINCI', 'RT 004 / RW 002'), roughness: 0.6 })
  );
  cross.rotation.y = Math.PI / 2;
  k.plant(cross, 0, 0, 2.38 + 0.18);

  for (const oy of [2.12, 3.08]) {
    const clamp = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.07, 8), M.iron);
    k.plant(clamp, 0, 0, oy);
  }

  k.collider(0, 0, 0.16, 0.16, 3.1);
  k.finish('street:street-name-sign', 0, 0);
  return k.g;
}

/**
 * Manhole cover: a cast-iron lid in its ring, flush with the asphalt, with the lift lugs and the
 * cross-hatch a close-up needs. No collider - you walk over it.
 */
export function buildManhole(ctx: StreetCtx, x: number, z: number, yaw: number, opts: StreetOpts = {}): THREE.Group {
  const k = kit(ctx, x, z, yaw, opts);
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.07, 18), M.iron);
  k.plant(ring, 0, 0, ROAD_LIFT + 0.035);
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.05, 18), M.iron);
  k.plant(lid, 0, 0, ROAD_LIFT + 0.075);

  for (const r of [0.28, 0.16]) {
    const arc = new THREE.Mesh(new THREE.TorusGeometry(r, 0.014, 4, 20), M.iron);
    arc.rotation.x = -Math.PI / 2;
    k.plant(arc, 0, 0, ROAD_LIFT + 0.1);
  }
  for (let i = 0; i < 4; i++) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.012, 0.035), M.iron);
    bar.rotation.y = (i * Math.PI) / 4;
    k.plant(bar, 0, 0, ROAD_LIFT + 0.1);
  }
  for (const side of [-1, 1]) {
    const lug = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.02, 0.04), M.iron);
    k.plant(lug, side * 0.12, 0, ROAD_LIFT + 0.105);
  }

  k.finish('street:manhole-cover', 0, 0);
  return k.g;
}

/** Drain grate: cast frame with nine bars, sunk into the gutter. No collider. */
export function buildDrainGrate(ctx: StreetCtx, x: number, z: number, yaw: number, opts: StreetOpts = {}): THREE.Group {
  const k = kit(ctx, x, z, yaw, opts);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.1, 0.98), M.drain);
  k.plant(frame, 0, 0, ROAD_LIFT + 0.05);
  const recess = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.06, 0.86), M.black);
  k.plant(recess, 0, 0, ROAD_LIFT + 0.08);
  for (let i = 0; i < 9; i++) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.035, 0.035), M.iron);
    k.plant(bar, 0, -0.38 + i * 0.095, ROAD_LIFT + 0.105);
  }
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.045, 0.05), M.iron);
    k.plant(rail, 0, side * 0.41, ROAD_LIFT + 0.105);
  }
  k.finish('street:drain-grate', 0, 0);
  return k.g;
}

/** Bollard: black post, two reflective bands, concrete collar. The one thing here you cannot pass. */
export function buildBollard(ctx: StreetCtx, x: number, z: number, yaw: number, opts: StreetOpts = {}): THREE.Group {
  const k = kit(ctx, x, z, yaw, opts);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.17, 0.12, 10), M.concrete);
  k.plant(collar, 0, 0, 0.06);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.09, 0.82, 10), M.black);
  k.plant(post, 0, 0, 0.12 + 0.41);
  for (const oy of [0.36, 0.72]) {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.092, 0.092, 0.1, 10), M.yellow);
    k.plant(band, 0, 0, oy);
  }
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.088, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), M.black);
  k.plant(cap, 0, 0, 0.94);
  k.collider(0, 0, 0.18, 0.18, 0.95);
  k.finish('street:bollard', 0, 0);
  return k.g;
}
