import * as THREE from 'three';
import { canvasTexture, mergeStaticChildren } from '../core/utils';

/**
 * The street kit: the vocabulary the city repeats most and had no shared words for.
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
 * v2 answers two defects the first pass shipped:
 *
 * 1. It only made intersections. A street consisted of its crossing point and four 13 m stubs, so
 *    everything between two junctions was bare ground. `buildStreetRun` is now a full cross-section
 *    of arbitrary length - carriageway, continuous lane markings, a kerb and a trotoar on both
 *    sides - with the interruptions a real street has: a bus bay cut into the walk, driveway
 *    aprons, and a zebra whose ramps are paved and sloped. `buildTIntersection` adds the three-arm
 *    case, so a side street can end on a through road the way most Jakarta gangs do.
 *
 * 2. The corner radius was not one rule. Two arms got a kerbed arc and two got a straight kerb laid
 *    across the middle of the walk, because the `runBox` call for the x-axis kerb passed its across
 *    and along arguments in the z-axis order - the corner looked rounded from one side of the
 *    junction and sharp from the other. A corner is now built by one function,
 *    `cornerReturn()`, called once per quadrant with the radius for the road class from
 *    `CORNER_RADIUS_M`, and the fillet between the kerb arc and the two kerb lines is asphalt (that
 *    is the area a turning bus sweeps) instead of a hole that showed the ground plane.
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

/**
 * THE corner-radius rule, one value per road class, and nothing else may round a corner.
 *
 * Jakarta signalised arterials turn on a short kerb radius - a bus or a truk can still take the
 * corner, and the pavement does not lose half its depth to the sweep. 6 m on the 20 m arterial,
 * 5 m on a 12 m collector, 3.5 m on an 8 m local street: local corners are tighter than arterials,
 * which is the one thing every reference photograph of a Jakarta junction agrees on.
 */
export const CORNER_RADIUS_M = { arterial: 6, collector: 5, local: 3.5 } as const;

/** trotoar, kerb stone, and how far the kerb stands proud of the carriageway (card numbers). */
export const WALK_WIDTH = 3.6;
export const KERB_WIDTH = 0.3;
export const KERB_PROUD = 0.12;

// ---------------------------------------------------------------- palette & textures

const texCache: {
  pavers?: THREE.Texture;
  hazard?: THREE.Texture;
  tactile?: THREE.Texture;
} = {};
const matCache: {
  walk?: THREE.MeshStandardMaterial;
  slope?: THREE.MeshStandardMaterial;
  extrude?: THREE.MeshStandardMaterial;
  hazard?: THREE.MeshStandardMaterial;
  tactileBand?: THREE.MeshStandardMaterial;
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

/**
 * Tactile studs as a texture rather than 156 tiny boxes per crossing: the band is 60 cm wide and
 * reads at arm's length, which is the only distance a player ever sees it from.
 */
function tactileTex(): THREE.Texture {
  if (!texCache.tactile) {
    const tex = canvasTexture(64, 64, (ctx, w, h) => {
      ctx.fillStyle = '#c9a227';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#b08c1c';
      ctx.fillRect(0, 0, w, 2);
      ctx.fillRect(0, h - 2, w, 2);
      ctx.fillStyle = '#dcb643';
      for (let y = 6; y < h; y += 16) {
        for (let x = 6; x < w; x += 16) {
          ctx.beginPath();
          ctx.arc(x, y, 5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1 / 0.6, 1 / 0.6);
    texCache.tactile = tex;
  }
  return texCache.tactile;
}

const walkMaterial = (): THREE.MeshStandardMaterial =>
  (matCache.walk ??= new THREE.MeshStandardMaterial({ map: pavers(), roughness: 0.95 }));

/**
 * Ramps and aprons are quads with their own UVs in metres, so they need the pavers at one tile per
 * 1.8 m rather than one per face.
 */
const slopeMaterial = (): THREE.MeshStandardMaterial => {
  if (!matCache.slope) {
    const tex = pavers().clone();
    tex.needsUpdate = true;
    tex.repeat.set(1 / 1.8, 1 / 1.8);
    matCache.slope = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.96 });
  }
  return matCache.slope;
};

/**
 * The corner slab is an ExtrudeGeometry, and an extrusion is not indexed while every box and quad
 * here is. `mergeStaticChildren` buckets by material and refuses to merge a mixed bucket, which
 * silently drops the whole mesh - so the extrusion gets a material of its own, one extra draw call
 * per junction, and everything else stays merged.
 */
const slabMaterial = (): THREE.MeshStandardMaterial => {
  if (!matCache.extrude) {
    const tex = pavers().clone();
    tex.needsUpdate = true;
    tex.repeat.set(1 / 1.8, 1 / 1.8);
    matCache.extrude = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.96 });
  }
  return matCache.extrude;
};

const tactileMaterial = (): THREE.MeshStandardMaterial =>
  (matCache.tactileBand ??= new THREE.MeshStandardMaterial({ map: tactileTex(), roughness: 0.9 }));

const hazardMaterial = (): THREE.MeshStandardMaterial =>
  (matCache.hazard ??= new THREE.MeshStandardMaterial({ map: hazardTex(), roughness: 0.8 }));

// Extruded corner slabs are the one geometry the merge refuses to mix with boxes (an extrusion is
// not indexed), so they get a material of their own and their own draw call per junction.

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
  slope: slopeMaterial(),
  tactileBand: tactileMaterial(),
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

/**
 * A slab of ground between four explicit extents, cut into `step`-metre pieces along its length so
 * it follows the terrain. This is the workhorse the kerb, the trotoar and a bus bay are built from:
 * `across` is measured from the road edge outwards, `along` is the run direction.
 */
function slab(
  k: Kit,
  axis: 'x' | 'z',
  across0: number,
  across1: number,
  along0: number,
  along1: number,
  h0: number,
  h1: number,
  material: THREE.Material,
  step = 2.5
): void {
  if (across1 - across0 < 0.001 || along1 - along0 < 0.001) return;
  const n = Math.max(1, Math.ceil((along1 - along0) / step));
  const seg = (along1 - along0) / n;
  for (let s = 0; s < n; s++) {
    const a = along0 + s * seg;
    const b = a + seg;
    const ac = (across0 + across1) / 2;
    const al = (a + b) / 2;
    const lx = axis === 'z' ? ac : al;
    const lz = axis === 'z' ? al : ac;
    const box =
      axis === 'z'
        ? new THREE.BoxGeometry(across1 - across0, h1 - h0, seg + 0.02)
        : new THREE.BoxGeometry(seg + 0.02, h1 - h0, across1 - across0);
    const m = new THREE.Mesh(box, material);
    m.position.set(lx, k.gy(lx, lz) + (h0 + h1) / 2, lz);
    m.castShadow = true;
    m.receiveShadow = true;
    k.g.add(m);
  }
}

/**
 * A planar face with a height per corner, welded to the terrain under each corner. `pts` are local
 * (x, z) with the height above the ground at that point - a crossing ramp, a driveway apron and the
 * quarter-circle fillet at a junction corner are all this one primitive.
 *
 * Winding is resolved from the signed area, so a mirrored call (the same corner on the other side of
 * the road) still faces up. That is the bug class this kit shipped: a surface built with corners in
 * the wrong order is culled by FrontSide and the player sees the ground plane instead.
 */
function polyFace(
  k: Kit,
  pts: [number, number, number][],
  material: THREE.Material,
  uvScale = 1
): THREE.Mesh | null {
  if (pts.length < 3) return null;
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const list = area > 0 ? [...pts].reverse() : pts;
  const pos: number[] = [];
  const uv: number[] = [];
  for (const [lx, lz, h] of list) {
    pos.push(lx, k.gy(lx, lz) + h, lz);
    uv.push(lx * uvScale, lz * uvScale);
  }
  const idx: number[] = [];
  for (let i = 1; i < list.length - 1; i++) idx.push(0, i, i + 1);
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

/** The city draws its road ribbons 5 cm over the terrain; the kit matches that, or every surface
 *  coplanar with the ground mesh z-fights at distance. Everything on the carriageway stacks on it. */
const ROAD_LIFT = 0.05;

/** Paint: no thickness worth casting a shadow with, lifted just clear of the asphalt. */
const PAINT_LIFT = ROAD_LIFT + 0.022;

/** Top of the kerb stone and of the trotoar: 12 cm proud of the carriageway. */
const WALK_TOP = ROAD_LIFT + KERB_PROUD;

/** The two heights the city needs to seat the player and its props: the carriageway and the walk. */
export const ROAD_LIFT_M = ROAD_LIFT;
export const WALK_TOP_M = WALK_TOP;

/** How deep a crossing ramp or a driveway apron cuts into the walk. */
const RAMP_DEPTH = 1.2;

/** Width of the painted zebra and therefore of the ramp that lands on it. */
const ZEBRA_LEN = 3;

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

// ---------------------------------------------------------------- the cross-section

/** Where a run is measured from: along z (the default) or along x for the arm of a junction. */
type RunAxis = 'x' | 'z';

interface Across {
  axis: RunAxis;
  /** +1 keeps the walk on the +x (or +z) side of a z-aligned (x-aligned) road */
  side: -1 | 1;
}

/** local -> local after mirroring an across coordinate onto the chosen side */
function acrossPoint(o: Across, acrossM: number, along: number): [number, number] {
  const a = o.side * acrossM;
  return o.axis === 'z' ? [a, along] : [along, a];
}

/** One interruption of a trotoar: a ramp down to the road (crossing or driveway). */
interface WalkCut {
  /** centre, metres along the run */
  at: number;
  width: number;
  /** how far into the walk the ramp reaches */
  depth: number;
  /** paint the tactile stud band behind the ramp */
  tactile?: boolean;
}

/** A bus bay: the walk is pushed back and the carriageway widens into it. */
interface WalkBay {
  at: number;
  length: number;
  depth: number;
}

/**
 * One side of a street: kerb stone, trotoar, and the two things that interrupt them - a ramp where a
 * crossing or a driveway meets the walk, and a bus bay cut into it.
 *
 * The kerb face is at `half` (the road edge), the kerb stone is `KERB_WIDTH` wide behind it and the
 * walk runs another `walkWidthM` back, so the cross-section is the same for a run, a junction arm
 * and a T-junction mouth. That sameness is what makes the street read as one street.
 */
function pavementSide(
  k: Kit,
  o: Across & {
    half: number;
    z0: number;
    z1: number;
    walkW?: number;
    cuts?: WalkCut[];
    bays?: WalkBay[];
    /** draw the linear drain channel at the back of the walk */
    drain?: boolean;
  }
): void {
  const walkW = o.walkW ?? WALK_WIDTH;
  const cut = KERB_WIDTH;
  const outer = o.half + cut + walkW;
  const cuts = (o.cuts ?? []).map((c) => ({ ...c, from: c.at - c.width / 2, to: c.at + c.width / 2 }));
  const bays = (o.bays ?? []).map((b) => ({ ...b, from: b.at - b.length / 2, to: b.at + b.length / 2 }));

  const edges = new Set<number>([o.z0, o.z1]);
  for (const c of [...cuts, ...bays]) {
    edges.add(Math.max(o.z0, Math.min(o.z1, c.from)));
    edges.add(Math.max(o.z0, Math.min(o.z1, c.to)));
  }
  const stops = [...edges].sort((a, b) => a - b);

  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (b - a < 0.02) continue;
    const mid = (a + b) / 2;
    const hitCut = cuts.find((c) => mid > c.from && mid < c.to);
    const hitBay = bays.find((v) => mid > v.from && mid < v.to);
    // a bay makes the carriageway reach further out; a ramp does not move the kerb line, it slopes
    const inner = o.half + (hitBay ? hitBay.depth : 0);

    if (hitBay) {
      // the bay's floor is asphalt, laid from the road edge out to the pushed-back kerb
      slab2(k, o, o.half, inner, a, b, M.asphalt, ROAD_LIFT, ROAD_LIFT + 0.01);
    }

    if (hitCut) {
      // a dropped kerb: the walk starts `depth` metres back and a paver ramp climbs to it
      const rampOuter = inner + hitCut.depth;
      if (hitCut.tactile) {
        // stud band immediately behind the ramp, where a cane finds it before the kerb
        drawBand(k, o, inner + hitCut.depth, Math.min(outer, inner + hitCut.depth + 0.6), a, b, 0.006);
      }
      ramp(k, o, inner, rampOuter, a, b);
      slab2(k, o, rampOuter, outer, a, b);
    } else {
      // kerb stone, its lighter nose at the road face, then the walk
      slab2(k, o, inner, inner + cut, a, b, M.kerb);
      const nose = 0.1;
      slab2(k, o, inner, inner + nose, a, b, M.kerbNose, WALK_TOP - 0.03, WALK_TOP);
      slab2(k, o, inner + cut, outer, a, b);
    }
  }

  // the diagonal kerb return at each end of a bay, so it reads as a bay and not a widened road
  for (const bay of bays) {
    for (const end of [bay.from, bay.to]) {
      const dir = end === bay.from ? -1 : 1;
      const stone = new THREE.Mesh(new THREE.BoxGeometry(Math.hypot(bay.depth, bay.depth), KERB_PROUD, KERB_WIDTH), M.kerb);
      const [px, pz] = acrossPoint(o, o.half + bay.depth / 2, end + dir * bay.depth / 2);
      stone.rotation.y = o.axis === 'z' ? o.side * dir * (Math.PI / 4) : Math.PI / 2 - o.side * dir * (Math.PI / 4);
      k.plant(stone, px, pz, ROAD_LIFT + KERB_PROUD / 2);
    }
  }

  if (o.drain) {
    for (let d = o.z0 + 1; d < o.z1 - 1; d += 0.4) {
      const [px, pz] = acrossPoint(o, outer - 0.18, d);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.03, 0.05), M.iron);
      bar.rotation.y = o.axis === 'z' ? 0 : Math.PI / 2;
      k.plant(bar, px, pz, ROAD_LIFT + 0.012);
    }
  }
}

/** a walk slab between two across coordinates, at the walk top */
function slab2(
  k: Kit,
  o: Across,
  a0: number,
  a1: number,
  along0: number,
  along1: number,
  material: THREE.Material = M.walk,
  h0 = ROAD_LIFT,
  h1 = WALK_TOP
): void {
  const [x0, z0] = acrossPoint(o, a0, along0);
  const [x1, z1] = acrossPoint(o, a1, along1);
  slab(k, o.axis, Math.min(x0, x1), Math.max(x0, x1), Math.min(z0, z1), Math.max(z0, z1), h0, h1, material);
}

/** the tactile stud band on top of the walk */
function drawBand(
  k: Kit,
  o: Across,
  a0: number,
  a1: number,
  along0: number,
  along1: number,
  lift: number
): void {
  const [x0, z0] = acrossPoint(o, a0, along0);
  const [x1, z1] = acrossPoint(o, a1, along1);
  const w = Math.abs(x1 - x0) || 0.6;
  const d = Math.abs(z1 - z0) || 0.6;
  const geo = o.axis === 'z' ? new THREE.BoxGeometry(w, 0.02, d) : new THREE.BoxGeometry(d, 0.02, w);
  const mesh = new THREE.Mesh(geo, M.tactileBand);
  k.plant(mesh, (x0 + x1) / 2, (z0 + z1) / 2, WALK_TOP + lift);
}

/**
 * The ramp itself: a paved slope from the carriageway up to the walk, which is what a kerb ramp is.
 * It replaces the flat white slab the first pass drew at every crossing.
 */
function ramp(k: Kit, o: Across, a0: number, a1: number, along0: number, along1: number): void {
  const pts: [number, number, number][] = [];
  for (const [acrossM, h] of [
    [a0, ROAD_LIFT + 0.008],
    [a1, WALK_TOP],
  ] as [number, number][]) {
    for (const along of [along0, along1]) {
      const [x, z] = acrossPoint(o, acrossM, along);
      pts.push([x, z, h]);
    }
  }
  polyFace(k, [pts[0], pts[1], pts[3], pts[2]], M.slope, 1);
}

// ---------------------------------------------------------------- carriageway + markings

interface RoadSurfaceOpts {
  half: number;
  length: number;
  lanes: number;
  median: 'none' | 'paint' | 'raised';
  /** intervals along the run where the markings must stop (a zebra sits there) */
  breaks?: [number, number][];
  centre?: boolean;
}

/**
 * A painted strip that follows the ground instead of a single flat plane.
 *
 * A 30 m plane planted at the height of its own midpoint is 2 cm below the asphalt at the ends of a
 * noticeable slope, and the asphalt - which conforms per vertex - buries it: the edge line vanished
 * for 16 m of a 68 m block on the first run of this, which is exactly the kind of break a player
 * reads as "the markings stop". Subdivide every 2 m and sample the ground per vertex instead.
 */
function paintStrip(k: Kit, acrossM: number, width: number, along0: number, along1: number): void {
  const d = along1 - along0;
  if (d <= 0.02) return;
  gridMesh(k, width, d, 1, Math.max(1, Math.round(d / 2)), PAINT_LIFT, M.paint, acrossM, (along0 + along1) / 2);
}

/** The same, for a strip that runs along x instead of along z (an x-aligned arm's zebra). */
function paintStripX(k: Kit, acrossM: number, width: number, along0: number, along1: number): void {
  const d = along1 - along0;
  if (d <= 0.02) return;
  gridMesh(k, d, width, Math.max(1, Math.round(d / 2)), 1, PAINT_LIFT, M.paint, (along0 + along1) / 2, acrossM);
}

/** Asphalt with the markings a Jakarta carriageway actually carries. */
function roadSurface(k: Kit, o: RoadSurfaceOpts): void {
  const len = o.length;
  const z0 = -len / 2;
  const z1 = len / 2;
  gridMesh(k, o.half * 2, len, 4, Math.max(4, Math.round(len / 4)), ROAD_LIFT, M.asphalt);

  const spans = subtract(z0, z1, o.breaks ?? []);
  const laneW = (o.half * 2) / o.lanes;

  for (const [a, b] of spans) {
    // continuous edge line, 30 cm in from the kerb face
    for (const side of [-1, 1]) paintStrip(k, side * (o.half - 0.3), 0.15, a, b);
    // lane dividers, skipping the centreline which the median owns
    for (let i = 1; i < o.lanes; i++) {
      const lx = -o.half + laneW * i;
      if (Math.abs(lx) < laneW * 0.5 + 0.01) continue;
      for (let d = a + 1.5; d + 3 < b; d += 8) paintStrip(k, lx, 0.12, d, d + 3);
    }
    if (o.median === 'paint' && o.centre !== false) {
      for (const off of [-0.14, 0.14]) paintStrip(k, off, 0.12, a, b);
    }
  }

  if (o.median === 'raised') {
    const mw = 1.5;
    for (const side of [-1, 1]) {
      runBox(k, 'z', 0.2, 0.34, len, side * (mw / 2 - 0.1), 0, M.kerb, 2.5, ROAD_LIFT);
    }
    gridMesh(k, mw - 0.4, len, 2, Math.max(2, Math.round(len / 6)), ROAD_LIFT + 0.3, M.soil);
    for (let d = z0 + 3; d < z1 - 3; d += 2.6) {
      const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 0), M.shrub);
      bush.scale.set(1, 0.62, 1);
      bush.castShadow = true;
      k.plant(bush, Math.sin(d * 1.7) * 0.28, d, ROAD_LIFT + 0.42);
    }
    k.collider(0, 0, mw / 2, len / 2, 0.34);
  }
}

/** [a, b] minus the given intervals, in order. */
function subtract(a: number, b: number, holes: [number, number][]): [number, number][] {
  const sorted = [...holes].filter(([x, y]) => y > a && x < b).sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  let cursor = a;
  for (const [x, y] of sorted) {
    if (x > cursor) out.push([cursor, Math.min(x, b)]);
    cursor = Math.max(cursor, Math.min(y, b));
  }
  if (cursor < b) out.push([cursor, b]);
  return out;
}

/** The painted zebra: white bars across the carriageway, longitudinal to travel. */
function zebra(k: Kit, axis: RunAxis, half: number, at: number, len = ZEBRA_LEN): void {
  const stripeW = 0.45;
  const bars = Math.floor((half * 2 - 0.8) / (stripeW * 2));
  for (let i = 0; i < bars; i++) {
    const off = -((bars - 1) / 2) * stripeW * 2 + i * stripeW * 2;
    if (axis === 'z') paintStrip(k, off, stripeW, at - len / 2, at + len / 2);
    else paintStripX(k, off, stripeW, at - len / 2, at + len / 2);
  }
}

// ---------------------------------------------------------------- 1. road segment

export interface RoadSegmentOpts extends StreetOpts {
  roadClass?: RoadClass;
  /** a width taken from the map for a road that is not one of the three classes (e.g. 16 m) */
  widthM?: number;
  lengthM?: number;
  /** lanes across the whole carriageway; default arterial 6, collector 4, local 2 */
  lanes?: number;
  median?: 'none' | 'paint' | 'raised';
}

export function defaultLanes(cls: RoadClass): number {
  return cls === 'local' ? 2 : cls === 'arterial' ? 6 : 4;
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
  roadSurface(k, {
    half: width / 2,
    length,
    lanes: opts.lanes ?? defaultLanes(cls),
    median: opts.median ?? (cls === 'arterial' ? 'raised' : 'paint'),
  });
  k.finish(`street:road-${cls}`, 0, 0);
  return k.g;
}

// ---------------------------------------------------------------- 2. kerb + trotoar

export interface KerbWalkOpts extends StreetOpts {
  lengthM?: number;
  walkWidthM?: number;
  /** tactile studs at a crossing, 60 cm band as in street-ref-3 */
  tactile?: boolean;
  /** where along the run the crossing sits */
  crossingAt?: number;
  /** linear drain channel along the outer edge */
  drain?: boolean;
}

/**
 * A single kerb + trotoar module, for a caller that wants one side only.
 *
 * Local frame: the kerb face is at x = 0 and the walk runs to x = +walkWidthM, so a caller mirrors it
 * with yaw = PI. `buildStreetRun` uses the same machinery for both sides at once.
 */
export function buildKerbWalk(ctx: StreetCtx, x: number, z: number, yaw: number, opts: KerbWalkOpts = {}): THREE.Group {
  const k = kit(ctx, x, z, yaw, opts);
  const length = opts.lengthM ?? 30;
  const walkW = opts.walkWidthM ?? WALK_WIDTH;
  pavementSide(k, {
    axis: 'z',
    side: 1,
    // no carriageway in this module: the kerb face is the module's own origin
    half: 0,
    z0: -length / 2,
    z1: length / 2,
    walkW,
    drain: opts.drain,
    cuts:
      opts.tactile === false
        ? []
        : [{ at: opts.crossingAt ?? 0, width: ZEBRA_LEN - 0.4, depth: RAMP_DEPTH, tactile: true }],
  });
  k.finish('street:kerb-walk', 0, 0);
  return k.g;
}

// ---------------------------------------------------------------- 3. the street between junctions

export interface StreetRunFeature {
  /** metres along the run from its centre */
  at: number;
}

export interface StreetRunOpts extends StreetOpts {
  roadClass?: RoadClass;
  widthM?: number;
  lengthM?: number;
  lanes?: number;
  median?: 'none' | 'paint' | 'raised';
  walkWidthM?: number;
  walk?: 'both' | 'none';
  /** bus bays cut into the walk */
  bays?: (StreetRunFeature & { side: -1 | 1; lengthM?: number; depthM?: number })[];
  /** driveway aprons: a dropped kerb where a gate opens onto the street */
  driveways?: (StreetRunFeature & { side: -1 | 1; widthM?: number })[];
  /** zebra crossings; both pavements get a paved ramp at the kerb */
  crossings?: (StreetRunFeature & { widthM?: number })[];
  /** utility poles, the name blade, bollards at the crossing */
  furniture?: boolean;
  /** ground for the things that stand on the trotoar, which is 17 cm above the carriageway */
  furnitureGround?: StreetGround;
  /** false when the map has already drawn this carriageway (the kit then adds the edges only) */
  asphalt?: boolean;
  /** close the +z end with a kerb across the road and a band of pavement behind it */
  capEnd?: boolean;
  /** close the -z end the same way (a run that does not join anything must not end on a slice) */
  capStart?: boolean;
  /** how deep the end pavement is; the default is one kerb ramp plus a step */
  capDepthM?: number;
}

/**
 * The head of a run: a kerb across the carriageway and a band of pavement behind it, flush with both
 * trotoar. A run of arbitrary length has to end somewhere; ending on a slice of asphalt open to the
 * ground plane is the same defect as a corner that does not close, and it is what a block of street
 * looks like when nothing joins its end.
 *
 * `dir` is +1 for the +z end of the run and -1 for the -z end, so the pavement always sits behind
 * the kerb, never on the road side.
 */
function endCap(k: Kit, half: number, walkW: number, at: number, dir: 1 | -1, depth = 2.2): void {
  const outer = half + KERB_WIDTH + walkW;
  // kerb line across the carriageway, at the same height as every other kerb stone
  const kz0 = dir > 0 ? at : at - KERB_WIDTH;
  const kz1 = dir > 0 ? at + KERB_WIDTH : at;
  slab(k, 'z', -half, half, kz0, kz1, ROAD_LIFT, WALK_TOP, M.kerb);
  // pavement behind it, the full width of the cross-section so it also closes the two trotoar
  const wz0 = dir > 0 ? at + KERB_WIDTH : at - depth;
  const wz1 = dir > 0 ? at + depth : at - KERB_WIDTH;
  slab(k, 'z', -outer, outer, wz0, wz1, ROAD_LIFT, WALK_TOP, M.walk);
  // the outer edge of that pavement gets a kerb stone too, so the head reads as a wall of paving
  const oz0 = dir > 0 ? at + depth : at - depth - KERB_WIDTH;
  const oz1 = dir > 0 ? at + depth + KERB_WIDTH : at - depth;
  slab(k, 'z', -outer, outer, oz0, oz1, ROAD_LIFT, WALK_TOP, M.kerb);
}

/**
 * A STREET, not a crossing: an arbitrary length of carriageway with continuous markings and a kerb
 * and trotoar on both sides, plus the interruptions a real street has - a bus bay, driveway aprons,
 * and a zebra whose ramps are paved and sloped.
 *
 * This is the builder the city was missing. A junction with four 13 m stubs is a model of a
 * junction; a run between two of them makes a street out of it.
 */
export function buildStreetRun(
  ctx: StreetCtx,
  x: number,
  z: number,
  yaw: number,
  opts: StreetRunOpts = {}
): THREE.Group {
  const k = kit(ctx, x, z, yaw, opts);
  const cls = opts.roadClass ?? 'collector';
  const width = opts.widthM ?? ROAD_CLASS_WIDTH[cls];
  const half = width / 2;
  const length = opts.lengthM ?? 60;
  const walkW = opts.walkWidthM ?? WALK_WIDTH;
  const z0 = -length / 2;
  const z1 = length / 2;
  const crossings = (opts.crossings ?? []).map((c) => ({
    ...c,
    width: c.widthM ?? ZEBRA_LEN,
  }));

  if (opts.asphalt !== false) {
    roadSurface(k, {
      half,
      length,
      lanes: opts.lanes ?? defaultLanes(cls),
      median: opts.median ?? (cls === 'arterial' ? 'raised' : 'paint'),
      breaks: crossings.map((c) => [c.at - c.width / 2 - 0.4, c.at + c.width / 2 + 0.4] as [number, number]),
    });
  }

  for (const c of crossings) zebra(k, 'z', half, c.at, c.width);

  if (opts.walk !== 'none') {
    for (const side of [-1, 1] as const) {
      const cuts: WalkCut[] = [];
      for (const c of crossings) {
        cuts.push({ at: c.at, width: c.width - 0.4, depth: RAMP_DEPTH, tactile: true });
      }
      for (const d of opts.driveways ?? []) {
        if (d.side !== side) continue;
        cuts.push({ at: d.at, width: d.widthM ?? 3.6, depth: RAMP_DEPTH });
      }
      const bays: WalkBay[] = (opts.bays ?? [])
        .filter((b) => b.side === side)
        .map((b) => ({ at: b.at, length: b.lengthM ?? 15, depth: b.depthM ?? 2.6 }));
      pavementSide(k, { axis: 'z', side, half, z0, z1, walkW, cuts, bays });
    }
  }

  if (opts.capStart) endCap(k, half, walkW, z0, -1, opts.capDepthM);
  if (opts.capEnd) endCap(k, half, walkW, z1, 1, opts.capDepthM);

  if (opts.furniture !== false) {
    const fg = opts.furnitureGround ?? opts.ground;
    // poles on the kerb line, one span between them along the run
    const span = Math.max(18, Math.min(34, length / 2));
    const pz1 = z0 + 4;
    const pz2 = Math.min(z1 - 4, pz1 + span);
    const px = half + KERB_WIDTH + 0.5;
    const [w1x, w1z] = k.world(px, pz1);
    const [w2x, w2z] = k.world(px, pz2);
    buildUtilityPole(ctx, w1x, w1z, yaw + Math.PI / 2, {
      ground: fg,
      spanM: pz2 - pz1,
    });
    buildUtilityPole(ctx, w2x, w2z, yaw + Math.PI / 2, {
      ground: fg,
      spanM: pz2 - pz1,
      cables: false,
    });
    const [sx, sz] = k.world(half + KERB_WIDTH + 1.1, (crossings[0]?.at ?? 0) - 4.2);
    buildStreetNameSign(ctx, sx, sz, yaw, { ground: fg });
    for (const at of [(crossings[0]?.at ?? 0) + 1.4, (crossings[0]?.at ?? 0) - 1.4]) {
      const [bx, bz] = k.world(half + 0.9, at);
      buildBollard(ctx, bx, bz, yaw, { ground: fg });
    }
  }

  k.g.userData.streetkit = {
    kind: 'run',
    roadClass: cls,
    widthM: width,
    lengthM: length,
    walkWidthM: walkW,
    crossings: crossings.length,
    bays: (opts.bays ?? []).length,
    driveways: (opts.driveways ?? []).length,
    caps: (opts.capStart ? 1 : 0) + (opts.capEnd ? 1 : 0),
  };
  k.finish(`street:run-${cls}`, 0, 0);
  return k.g;
}

// ---------------------------------------------------------------- 4. the corner return

interface CornerSpec {
  halfX: number;
  halfZ: number;
  radius: number;
  walkW: number;
  /** how far the corner apron reaches back along both kerb lines */
  fill: number;
  /** ramps on the two kerb lines that face a crossing, as [near, far] along that line */
  jogX?: [number, number];
  jogZ?: [number, number];
  sx: -1 | 1;
  sz: -1 | 1;
}

/**
 * ONE corner of ONE junction. Every corner of every arm is this call with the four sign combinations,
 * so a junction physically cannot have a rounded corner on one side and a sharp one on the other -
 * the defect the owner photographed.
 *
 * It draws the four things a corner is: the pavement slab that fills the corner, the kerb stones
 * following the arc, the straight kerbs that pick the two kerb lines up again, and a paved ramp
 * wherever a zebra lands on it. The area between the kerb arc and the two kerb lines is left to the
 * carriageway (the fillet a turning bus sweeps), so nothing shows the ground plane through the
 * corner.
 */
function cornerReturn(k: Kit, c: CornerSpec): void {
  const { halfX, halfZ, radius: R, walkW, fill, sx, sz } = c;
  const kw = KERB_WIDTH;
  const P = (x: number, z: number): [number, number] => [sx * x, sz * z];
  const arcSteps = 16;

  // --- the pavement: a quarter disc's worth of corner, minus the kerb band, minus the ramps
  const pts: [number, number][] = [];
  const cx = halfX + R;
  const cz = halfZ + R;
  pts.push(P(halfX + kw, halfZ + R));
  for (let i = 1; i <= arcSteps; i++) {
    const t = (i / arcSteps) * (Math.PI / 2);
    pts.push(P(cx - (R - kw) * Math.cos(t), cz - (R - kw) * Math.sin(t)));
  }
  // along the +x arm's kerb line, out to the corner's fill
  if (c.jogX) {
    const [j0, j1] = c.jogX;
    pts.push(P(j0, halfZ + kw), P(j0, halfZ + RAMP_DEPTH), P(j1, halfZ + RAMP_DEPTH), P(j1, halfZ + kw));
  }
  pts.push(P(halfX + fill, halfZ + kw));
  pts.push(P(halfX + fill, halfZ + fill));
  pts.push(P(halfX + kw, halfZ + fill));
  if (c.jogZ) {
    const [j0, j1] = c.jogZ;
    pts.push(P(halfX + kw, j1), P(halfX + RAMP_DEPTH, j1), P(halfX + RAMP_DEPTH, j0), P(halfX + kw, j0));
  }

  const depth = KERB_PROUD + 0.1;
  const shape = new THREE.Shape(pts.map(([px, pz]) => new THREE.Vector2(px, -pz)));
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
  const slabMesh = new THREE.Mesh(geo, slabMaterial());
  slabMesh.rotation.x = -Math.PI / 2;
  const [gx, gz] = P((halfX + fill) * 0.6, (halfZ + fill) * 0.6);
  slabMesh.position.set(0, k.gy(gx, gz) + ROAD_LIFT - 0.1, 0);
  slabMesh.receiveShadow = true;
  slabMesh.castShadow = true;
  k.g.add(slabMesh);

  // --- kerb stones following the arc, at the same angles as the slab's own arc
  const arcLen = (Math.PI / 2) * R;
  const stones = arcSteps;
  const stoneW = arcLen / stones + 0.02;
  for (let i = 0; i < stones; i++) {
    const t = ((i + 0.5) / stones) * (Math.PI / 2);
    const [px, pz] = P(cx - (R - kw / 2) * Math.cos(t), cz - (R - kw / 2) * Math.sin(t));
    const stone = new THREE.Mesh(new THREE.BoxGeometry(stoneW, KERB_PROUD + 0.015, kw), M.kerb);
    // tangent of the arc at t, mirrored with the quadrant
    const tx = -Math.sin(t) * sx;
    const tz = -Math.cos(t) * sz;
    stone.rotation.y = Math.atan2(-tz, tx);
    k.plant(stone, px, pz, ROAD_LIFT + (KERB_PROUD + 0.015) / 2);
  }

  // --- the two straight kerbs, from the arc's tangent points out to the corner's fill, with the
  //     dropped section where a ramp is
  const kerbX: [number, number][] = [[halfZ + R, halfZ + fill]];
  if (c.jogX) kerbX.push([c.jogX[0], c.jogX[1]]);
  for (const [a, b] of intervals([halfZ + R, halfZ + fill], kerbX.slice(1))) {
    const [x0, z0] = P(halfX, a);
    const [x1, z1] = P(halfX + kw, b);
    slab(k, 'z', Math.min(x0, x1), Math.max(x0, x1), Math.min(z0, z1), Math.max(z0, z1), ROAD_LIFT, WALK_TOP, M.kerb);
  }
  const kerbZ: [number, number][] = [[halfX + R, halfX + fill]];
  if (c.jogZ) kerbZ.push([c.jogZ[0], c.jogZ[1]]);
  for (const [a, b] of intervals([halfX + R, halfX + fill], kerbZ.slice(1))) {
    const [x0, z0] = P(a, halfZ);
    const [x1, z1] = P(b, halfZ + kw);
    slab(k, 'x', Math.min(z0, z1), Math.max(z0, z1), Math.min(x0, x1), Math.max(x0, x1), ROAD_LIFT, WALK_TOP, M.kerb);
  }

  // --- the ramps a crossing lands on
  if (c.jogX) {
    const [j0, j1] = c.jogX;
    const [x0, z0] = P(halfX, j0);
    const [x1, z1] = P(halfX + RAMP_DEPTH, j1);
    polyFace(
      k,
      [
        [Math.min(x0, x1), Math.min(z0, z1), ROAD_LIFT + 0.008],
        [Math.min(x0, x1), Math.max(z0, z1), ROAD_LIFT + 0.008],
        [Math.max(x0, x1), Math.max(z0, z1), WALK_TOP],
        [Math.max(x0, x1), Math.min(z0, z1), WALK_TOP],
      ],
      M.slope
    );
  }
  if (c.jogZ) {
    const [j0, j1] = c.jogZ;
    const [x0, z0] = P(j0, halfZ);
    const [x1, z1] = P(j1, halfZ + RAMP_DEPTH);
    polyFace(
      k,
      [
        [Math.min(x0, x1), Math.min(z0, z1), ROAD_LIFT + 0.008],
        [Math.max(x0, x1), Math.min(z0, z1), ROAD_LIFT + 0.008],
        [Math.max(x0, x1), Math.max(z0, z1), WALK_TOP],
        [Math.min(x0, x1), Math.max(z0, z1), WALK_TOP],
      ],
      M.slope
    );
  }

  // --- the asphalt fillet between the corner point and the arc: a turning bus sweeps this, and
  //     leaving it unpainted is what showed the ground plane as a white wedge at every corner
  const fillet: [number, number, number][] = [];
  {
    const [px, pz] = P(halfX, halfZ);
    fillet.push([px, pz, ROAD_LIFT]);
  }
  for (let i = 0; i <= arcSteps; i++) {
    const t = (Math.PI / 2) * (i / arcSteps);
    const [px, pz] = P(cx - R * Math.cos(t), cz - R * Math.sin(t));
    fillet.push([px, pz, ROAD_LIFT]);
  }
  polyFace(k, fillet, M.asphalt);
}

/** [from, to] minus the given holes, in order. */
function intervals(span: [number, number], holes: [number, number][]): [number, number][] {
  const [a, b] = span;
  return subtract(a, b, holes.map(([x, y]) => [Math.max(a, x), Math.min(b, y)] as [number, number]));
}

// ---------------------------------------------------------------- 5. signalised intersection

export interface IntersectionOpts extends StreetOpts {
  roadClass?: RoadClass;
  widthM?: number;
  /** how far each arm's asphalt runs out from the junction box */
  armsM?: number;
  /** overrides CORNER_RADIUS_M[roadClass]; only for a road the map measures differently */
  cornerRadiusM?: number;
  walkWidthM?: number;
  zebra?: boolean;
  /** compose a traffic light on each corner (reuses buildTrafficLight) */
  lights?: boolean;
  /** paved ramps where each zebra lands on the corner pavement */
  ramps?: boolean;
  /** ground for the signals, which stand on the corner pavement rather than in the road */
  furnitureGround?: StreetGround;
}

/**
 * A four-arm signalised junction: carriageway, a zebra on every arm, stop lines, and one corner
 * return per quadrant with the radius the road class calls for.
 *
 * v1 filled the corner with a square that had the quarter disc cut out of it and then laid the
 * straight kerb of the x-axis arms across the middle of the walk, because the runBox call passed its
 * across and along arguments in the other axis's order. From one side of the junction the corner was
 * rounded; from the other it was sharp. v2 builds every quadrant from `cornerReturn()`, so the four
 * corners are the same code with the same numbers.
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
  const arms = opts.armsM ?? 20;
  const R = opts.cornerRadiusM ?? CORNER_RADIUS_M[cls];
  const walkW = opts.walkWidthM ?? WALK_WIDTH;
  const armEnd = half + arms;

  // the corner apron has to be deep enough to carry the crossing ramp, or the ramp falls off the
  // end of the slab and shows the ground through the gap
  const fill = Math.max(walkW + KERB_WIDTH + 0.5, R + 3.8);
  const zebraFrom = half + R + 0.8;
  const zebraLen = ZEBRA_LEN;
  const rampAt: [number, number] = [zebraFrom + 0.2, zebraFrom + zebraLen - 0.2];
  const stopD = zebraFrom + zebraLen + 1.2;

  // asphalt: the junction box plus four arms, all conforming to the ground
  gridMesh(k, width, width, 3, 3, ROAD_LIFT, M.asphalt);
  const armDefs = [
    { axis: 'z', dir: 1, inbound: -half / 2 },
    { axis: 'z', dir: -1, inbound: half / 2 },
    { axis: 'x', dir: 1, inbound: half / 2 },
    { axis: 'x', dir: -1, inbound: -half / 2 },
  ] as const;
  for (const arm of armDefs) {
    const mid = arm.dir * (half + arms / 2);
    if (arm.axis === 'z') gridMesh(k, width, arms, 3, Math.max(3, Math.round(arms / 4)), ROAD_LIFT, M.asphalt, 0, mid);
    else gridMesh(k, arms, width, Math.max(3, Math.round(arms / 4)), 3, ROAD_LIFT, M.asphalt, mid, 0);
  }

  for (const arm of armDefs) {
    const along = arm.dir * (zebraFrom + zebraLen / 2);
    if (opts.zebra !== false) {
      const stripeW = 0.45;
      const bars = Math.floor((width - 0.8) / (stripeW * 2));
      for (let i = 0; i < bars; i++) {
        const off = -((bars - 1) / 2) * stripeW * 2 + i * stripeW * 2;
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

    // past the stop line the arm is a street: edge lines, a centre line and lane dashes
    const from = stopD + 1;
    const to = armEnd;
    const midSpan = arm.dir * ((from + to) / 2);
    const span = to - from;
    for (const side of [-1, 1]) {
      const edge =
        arm.axis === 'z'
          ? new THREE.Mesh(new THREE.PlaneGeometry(0.15, span), M.paint)
          : new THREE.Mesh(new THREE.PlaneGeometry(span, 0.15), M.paint);
      edge.rotation.x = -Math.PI / 2;
      if (arm.axis === 'z') k.plant(edge, side * (half - 0.3), midSpan, PAINT_LIFT);
      else k.plant(edge, midSpan, side * (half - 0.3), PAINT_LIFT);
    }
    for (const off of [-0.14, 0.14]) {
      const centre =
        arm.axis === 'z'
          ? new THREE.Mesh(new THREE.PlaneGeometry(0.12, span), M.paint)
          : new THREE.Mesh(new THREE.PlaneGeometry(span, 0.12), M.paint);
      centre.rotation.x = -Math.PI / 2;
      if (arm.axis === 'z') k.plant(centre, off, midSpan, PAINT_LIFT);
      else k.plant(centre, midSpan, off, PAINT_LIFT);
    }
  }

  // four identical corner returns
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      cornerReturn(k, {
        halfX: half,
        halfZ: half,
        radius: R,
        walkW,
        fill,
        jogX: opts.ramps === false ? undefined : rampAt,
        jogZ: opts.ramps === false ? undefined : rampAt,
        sx,
        sz,
      });
    }
  }

  // the walk continues along each arm, from the corner apron out to the arm end
  for (const axis of ['z', 'x'] as const) {
    for (const dir of [1, -1] as const) {
      for (const side of [-1, 1] as const) {
        pavementSide(k, {
          axis,
          side,
          half,
          // the corner apron already owns the pavement out to half + fill; the arm picks it up there
          z0: dir * (half + fill),
          z1: dir * armEnd,
          walkW,
          cuts: [],
        });
      }
    }
  }

  if (opts.lights !== false) {
    const lx = half + 1.6;
    const lz = stopD + 2.6;
    const corners: [number, number, number, 'red' | 'green'][] = [
      [-lx, lz, 0, 'green'],
      [lx, -lz, Math.PI, 'green'],
      [lz, lx, Math.PI / 2, 'red'],
      [-lz, -lx, -Math.PI / 2, 'red'],
    ];
    for (const [ax, az, ayaw, lit] of corners) {
      const [wx, wz] = k.world(ax, az);
      buildTrafficLight(ctx, wx, wz, yaw + ayaw, {
        ground: opts.furnitureGround ?? opts.ground,
        lit,
      });
    }
  }

  // the corners this junction actually built - the numeric handle a harness can assert on
  k.g.userData.streetkit = {
    kind: 'signal-intersection',
    roadClass: cls,
    widthM: width,
    cornerRadiusM: R,
    corners: ([-1, 1] as const).flatMap((sx) =>
      ([-1, 1] as const).map((sz) => ({ sx, sz, radius: R, arcSteps: 16, fillM: fill }))
    ),
    zebraFromM: zebraFrom,
  };
  k.finish('street:signal-intersection', 0, 0);
  return k.g;
}

// ---------------------------------------------------------------- 6. T junction

export interface TOpts extends StreetOpts {
  /** the through road */
  roadClass?: RoadClass;
  widthM?: number;
  /** the stem, when it is a narrower side street */
  stemWidthM?: number;
  /** half the length of the through road the junction dresses */
  throughM?: number;
  /** how far the stem's asphalt runs out of the junction */
  stemM?: number;
  cornerRadiusM?: number;
  walkWidthM?: number;
  lights?: boolean;
}

/**
 * A T: a side street ends on a through road. Two corner returns (one either side of the mouth) and a
 * kerb line that runs unbroken along the far side, which is the shape most Jakarta gangs make when
 * they meet a collector.
 *
 * Local frame: the through road runs along x with its kerbs at z = ±half; the stem leaves toward +z.
 */
export function buildTIntersection(
  ctx: StreetCtx,
  x: number,
  z: number,
  yaw: number,
  opts: TOpts = {}
): THREE.Group {
  const k = kit(ctx, x, z, yaw, opts);
  const cls = opts.roadClass ?? 'collector';
  const width = opts.widthM ?? ROAD_CLASS_WIDTH[cls];
  const stemW = opts.stemWidthM ?? ROAD_CLASS_WIDTH.local;
  const half = width / 2;
  const halfStem = stemW / 2;
  const through = opts.throughM ?? 40;
  const stemM = opts.stemM ?? 20;
  const R = opts.cornerRadiusM ?? CORNER_RADIUS_M[cls];
  const walkW = opts.walkWidthM ?? WALK_WIDTH;
  const fill = Math.max(walkW + KERB_WIDTH + 0.5, R + 3.8);

  // asphalt: through road, the stem, and the two fillets the turning bus sweeps
  gridMesh(k, through * 2, width, Math.max(4, Math.round(through / 4)), 3, ROAD_LIFT, M.asphalt);
  gridMesh(k, stemW, stemM, 3, Math.max(3, Math.round(stemM / 4)), ROAD_LIFT, M.asphalt, 0, half + stemM / 2);

  // paint on the through road: edge lines and a centre line, broken at the mouth
  for (const side of [-1, 1] as const) {
    const spans = side === -1 ? [[-through, through]] : [[-through, -halfStem], [halfStem, through]];
    for (const [a, b] of spans) {
      const edge = new THREE.Mesh(new THREE.PlaneGeometry(b - a, 0.15), M.paint);
      edge.rotation.x = -Math.PI / 2;
      k.plant(edge, (a + b) / 2, side * (half - 0.3), PAINT_LIFT);
    }
    for (const off of [-0.14, 0.14]) {
      const centre = new THREE.Mesh(new THREE.PlaneGeometry(through * 2, 0.12), M.paint);
      centre.rotation.x = -Math.PI / 2;
      k.plant(centre, 0, off, PAINT_LIFT);
    }
  }
  for (const side of [-1, 1]) {
    const edge = new THREE.Mesh(new THREE.PlaneGeometry(0.15, stemM), M.paint);
    edge.rotation.x = -Math.PI / 2;
    k.plant(edge, side * (halfStem - 0.3), half + stemM / 2, PAINT_LIFT);
  }
  const stop = new THREE.Mesh(new THREE.PlaneGeometry(halfStem - 0.15, 0.3), M.paint);
  stop.rotation.x = -Math.PI / 2;
  k.plant(stop, -halfStem / 2, half + 1.2, PAINT_LIFT);

  // the two corners at the mouth, from the same corner return the four-arm junction uses
  for (const sx of [-1, 1] as const) {
    cornerReturn(k, {
      halfX: halfStem,
      halfZ: half,
      radius: R,
      walkW,
      fill,
      sx,
      sz: 1,
    });
  }

  // the pavement on the far side of the through road, unbroken
  pavementSide(k, { axis: 'x', side: -1, half, z0: -through, z1: through, walkW });
  // and the two walks on the mouth side, from the corner aprons out to the ends
  for (const side of [-1, 1] as const) {
    pavementSide(k, { axis: 'x', side: 1, half, z0: side > 0 ? halfStem + fill : -through, z1: side > 0 ? through : -halfStem - fill, walkW });
  }
  // the stem's own walks, from the corner apron down the side street
  for (const side of [-1, 1] as const) {
    pavementSide(k, { axis: 'z', side, half: halfStem, z0: half + fill, z1: half + stemM, walkW });
  }

  k.g.userData.streetkit = {
    kind: 't-intersection',
    roadClass: cls,
    widthM: width,
    stemWidthM: stemW,
    cornerRadiusM: R,
    corners: [
      { sx: -1, sz: 1, radius: R, arcSteps: 16, fillM: fill },
      { sx: 1, sz: 1, radius: R, arcSteps: 16, fillM: fill },
    ],
  };
  k.finish('street:t-intersection', 0, 0);
  return k.g;
}

// ---------------------------------------------------------------- 7. traffic light

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

// ---------------------------------------------------------------- 8. street furniture

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
