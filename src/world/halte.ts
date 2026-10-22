import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { canvasTexture } from '../core/utils';

/**
 * TransJakarta halte — the kerbside BRT shelter: a raised platform, a red steel frame, a flat
 * roof that overhangs the platform edge, a glazed back wall, a route board, a bench and a
 * queue rail. Sits on the busway side of the carriageway and takes its passengers at the bus's
 * low floor height (0.36 m).
 *
 * References (Wikimedia Commons, CC BY-SA, see CREDITS.md):
 *   reference/assets/transjakarta-halte-rawasari.jpg — the shelter with a bus alongside: the
 *   platform edge, the fascia band, the glazed back wall and the roof overhang.
 *   reference/assets/transjakarta-halte-platform.jpg — the Bundaran HI platform interior, for
 *   the bench against the glass, the queue rail, the route board and the ceiling.
 *
 * The red steel frame is the older TransJakarta shelter palette (and the brief's); the modern
 * stations in the photos are grey. The geometry — 8.4 m platform, flat cantilevered roof, three
 * glazed bays, board, bench, rail — follows the photographs.
 *
 * Local frame: the shelter faces +Z (the busway), so the platform edge is the +Z face and the
 * glazed back wall is at -Z. buildHalte() drops it at (x, z) with a yaw and registers the
 * colliders and audit entry the rest of the world builders use.
 *
 * Budget: < 1200 triangles and < 10 draw calls — six merged meshes, one per material.
 */

export interface HalteCtx {
  group: THREE.Object3D;
  colliders: { minX: number; maxX: number; minZ: number; maxZ: number; h: number }[];
  audit: { name: string; x: number; z: number; bottom: number }[];
}

export const HALTE_DIMENSIONS = {
  length: 8.4,
  depth: 2.8,
  /** platform deck above the road */
  platform: 0.36,
  height: 3.02,
} as const;

const HL = HALTE_DIMENSIONS.length / 2;   // 4.2
const HD = HALTE_DIMENSIONS.depth / 2;    // 1.4
const DECK = HALTE_DIMENSIONS.platform;   // 0.36
const EAVE = 2.86;
const PITCH = 2.86;                        // column height, deck to underside of roof

const RED = 0xc1121f;
const RED_DARK = 0x8d0d16;
const CONCRETE = 0xb9b6ae;
const CONCRETE_DARK = 0x93908a;
const YELLOW = 0xe0b422;
const GLASS = 0xa8c8d2;
const STEEL = 0xb9bfc6;
const DARK = 0x2a2d31;
const ROOF_TOP = 0x9ea3a6;
const LAMP = 0xf2f0e2;

const ATLAS = {
  board: [0, 0, 420, 300],
  header: [440, 0, 560, 70],
  lamp: [440, 100, 120, 40],
} as const;

const ATLAS_W = 1024;
const ATLAS_H = 320;

function uvRect(r: readonly [number, number, number, number]): [number, number, number, number] {
  return [r[0] / ATLAS_W, 1 - (r[1] + r[3]) / ATLAS_H, (r[0] + r[2]) / ATLAS_W, 1 - r[1] / ATLAS_H];
}

function atlasTexture(): THREE.CanvasTexture {
  return canvasTexture(ATLAS_W, ATLAS_H, (c) => {
    c.clearRect(0, 0, ATLAS_W, ATLAS_H);

    // --- route board: the corridor list you read while you wait -------------------------------
    c.fillStyle = '#f2efe6';
    c.fillRect(0, 0, 420, 300);
    c.fillStyle = '#c1121f';
    c.fillRect(0, 0, 420, 66);
    c.fillStyle = '#ffffff';
    c.textBaseline = 'middle';
    c.textAlign = 'left';
    c.font = '700 30px ui-sans-serif, system-ui, sans-serif';
    c.fillText('HALTE', 16, 34);
    c.font = '700 22px ui-sans-serif, system-ui, sans-serif';
    c.fillText('HARMONI', 130, 34);
    c.fillStyle = '#1c1c1e';
    c.font = '700 20px ui-sans-serif, system-ui, sans-serif';
    const rows: [string, string][] = [
      ['1', 'KOTA - BLOK M'],
      ['2', 'PULO GADUNG'],
      ['3', 'KALIDERES'],
    ];
    rows.forEach(([n, dest], i) => {
      const y = 100 + i * 40;
      c.fillStyle = '#c1121f';
      c.fillRect(16, y - 15, 26, 30);
      c.fillStyle = '#ffffff';
      c.font = '700 20px ui-sans-serif, system-ui, sans-serif';
      c.textAlign = 'center';
      c.fillText(n, 29, y);
      c.textAlign = 'left';
      c.fillStyle = '#1c1c1e';
      c.font = '600 20px ui-sans-serif, system-ui, sans-serif';
      c.fillText(dest, 54, y);
    });
    c.strokeStyle = '#c1121f';
    c.lineWidth = 4;
    c.strokeRect(2, 2, 416, 296);

    // --- lamp diffuser: plain warm white ------------------------------------------------------
    c.fillStyle = '#f4f1e2';
    c.fillRect(440, 100, 120, 40);

    // --- roof header: white wordmark on red ----------------------------------------------------
    c.fillStyle = '#c1121f';
    c.fillRect(440, 0, 560, 70);
    c.fillStyle = '#ffffff';
    c.textAlign = 'center';
    c.font = 'italic 700 46px ui-sans-serif, system-ui, sans-serif';
    c.fillText('transjakarta', 720, 38);
  });
}

class Kit {
  private readonly parts = new Map<string, THREE.BufferGeometry[]>();

  add(bucket: string, geo: THREE.BufferGeometry, color: number, rect?: readonly [number, number, number, number]): void {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (!g.attributes.uv) {
      const count = (g.attributes.position as THREE.BufferAttribute).count;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    if (rect) {
      const [u0, v0, u1, v1] = uvRect(rect);
      const uv = g.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
      uv.needsUpdate = true;
    }
    const count = (g.attributes.position as THREE.BufferAttribute).count;
    const col = new THREE.Color(color);
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      arr[i * 3] = col.r;
      arr[i * 3 + 1] = col.g;
      arr[i * 3 + 2] = col.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    const list = this.parts.get(bucket);
    if (list) list.push(g);
    else this.parts.set(bucket, [g]);
  }

  box(bucket: string, color: number, size: [number, number, number], at: [number, number, number], rot: [number, number, number] = [0, 0, 0]): void {
    const g = new THREE.BoxGeometry(size[0], size[1], size[2]);
    if (rot[0]) g.rotateX(rot[0]);
    if (rot[1]) g.rotateY(rot[1]);
    if (rot[2]) g.rotateZ(rot[2]);
    g.translate(at[0], at[1], at[2]);
    this.add(bucket, g, color);
  }

  /** vertical panel facing ±Z */
  panel(bucket: string, color: number, x0: number, x1: number, y0: number, y1: number, z: number, sign: 1 | -1, rect?: readonly [number, number, number, number]): void {
    const g = new THREE.PlaneGeometry(x1 - x0, y1 - y0);
    if (sign < 0) g.rotateY(Math.PI);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, z);
    this.add(bucket, g, color, rect);
  }

  /** vertical panel facing ±X, for the end walls */
  side(bucket: string, color: number, z0: number, z1: number, y0: number, y1: number, x: number, sign: 1 | -1): void {
    const g = new THREE.PlaneGeometry(z1 - z0, y1 - y0);
    g.rotateY(sign > 0 ? Math.PI / 2 : -Math.PI / 2);
    g.translate(x, (y0 + y1) / 2, (z0 + z1) / 2);
    this.add(bucket, g, color);
  }

  /** tube between two points, for the queue rail */
  rail(a: [number, number, number], b: [number, number, number], r: number, seg = 6): void {
    const pa = new THREE.Vector3(...a);
    const pb = new THREE.Vector3(...b);
    const dir = new THREE.Vector3().subVectors(pb, pa);
    const len = dir.length();
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
    g.translate((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, (pa.z + pb.z) / 2);
    this.add('steel', g, STEEL);
  }

  merge(bucket: string): THREE.BufferGeometry | null {
    const list = this.parts.get(bucket);
    if (!list || !list.length) return null;
    const merged = mergeGeometries(list, false);
    for (const g of list) g.dispose();
    merged?.computeBoundingSphere();
    return merged;
  }
}

export interface HalteOptions {
  /** drop the bench slats, lights and queue rail for a background shelter */
  simple?: boolean;
}

/** Build one halte into an existing world builder context. */
export function buildHalte(ctx: HalteCtx, x: number, z: number, yaw: number, opts: HalteOptions = {}): THREE.Group {
  const simple = opts.simple ?? false;
  const kit = new Kit();

  // --- platform -----------------------------------------------------------------------------
  kit.box('concrete', CONCRETE, [HL * 2, DECK, HD * 2], [0, DECK / 2, 0]);
  kit.box('concrete', CONCRETE_DARK, [HL * 2 + 0.02, 0.1, HD * 2 + 0.02], [0, 0.05, 0]); // kerb
  // yellow tactile strip + white edge line on the busway edge
  kit.box('concrete', YELLOW, [HL * 2 - 0.1, 0.02, 0.32], [0, DECK + 0.008, HD - 0.3]);
  kit.box('concrete', 0xe8e6de, [HL * 2 - 0.1, 0.018, 0.12], [0, DECK + 0.008, HD - 0.06]);
  // grey deck slabs, so the floor is not one flat pour
  for (let i = 0; i < 3; i++) {
    kit.box('concrete', CONCRETE_DARK, [HL * 2 - 0.3, 0.012, 0.05], [0, DECK + 0.006, -0.55 + i * 0.62]);
  }

  // --- frame ---------------------------------------------------------------------------------
  for (const px of [-HL + 0.45, -1.25, 1.25, HL - 0.45]) {
    kit.box('red', RED, [0.14, PITCH, 0.14], [px, DECK + PITCH / 2, -HD + 0.22]);
  }
  // head beams over the columns and the roof edge beam in front
  kit.box('red', RED_DARK, [HL * 2 - 0.7, 0.18, 0.16], [0, EAVE - 0.09, -HD + 0.22]);
  kit.box('red', RED, [HL * 2 - 0.7, 0.2, 0.12], [0, EAVE - 0.1, HD - 0.5]);
  for (const px of [-HL + 0.45, HL - 0.45]) {
    // rafter tying the front beam back to the wall
    kit.box('red', RED, [0.1, 0.14, HD * 2 - 0.6], [px, EAVE - 0.12, -0.16]);
  }

  // --- roof: flat, overhanging the platform edge ---------------------------------------------
  kit.box('matte', ROOF_TOP, [HL * 2 + 0.5, 0.1, HD * 2 + 0.6], [0, EAVE + 0.06, 0.12]);
  kit.box('matte', 0xc9cdcf, [HL * 2 + 0.52, 0.05, HD * 2 + 0.62], [0, EAVE + 0.005, 0.12]);
  // red fascia all the way round
  kit.box('red', RED, [HL * 2 + 0.5, 0.26, 0.08], [0, EAVE + 0.02, HD + 0.42]);
  kit.box('red', RED, [HL * 2 + 0.5, 0.26, 0.08], [0, EAVE + 0.02, -HD - 0.18]);
  for (const s of [1, -1] as const) {
    kit.box('red', RED, [0.08, 0.26, HD * 2 + 0.6], [s * (HL + 0.25), EAVE + 0.02, 0.12]);
  }
  // header wordmark on the fascia over the platform edge
  kit.panel('graphic', 0xffffff, -1.7, 1.7, EAVE - 0.09, EAVE + 0.13, HD + 0.465, 1, ATLAS.header);

  // --- glazed back wall ---------------------------------------------------------------------
  const glassTop = 2.55;
  for (const [x0, x1] of [[-HL + 0.52, -1.32], [-1.18, 1.18], [1.32, HL - 0.52]] as [number, number][]) {
    kit.panel('glass', GLASS, x0, x1, DECK + 0.2, glassTop, -HD + 0.235, 1);
    // glazing bars: a mid rail and two vertical mullions, so the wall reads as a window
    kit.box('steel', STEEL, [x1 - x0, 0.05, 0.07], [(x0 + x1) / 2, 1.62, -HD + 0.245]);
    const mid = (x0 + x1) / 2;
    for (const mx of [x0 + (mid - x0) * 0.5, mid + (x1 - mid) * 0.5]) {
      kit.box('steel', STEEL, [0.05, glassTop - DECK - 0.2, 0.07], [mx, (glassTop + DECK) / 2 + 0.1, -HD + 0.245]);
    }
    // frame: bottom rail, top rail, mullions at both ends
    kit.box('red', RED, [x1 - x0, 0.2, 0.1], [(x0 + x1) / 2, DECK + 0.1, -HD + 0.22]);
    kit.box('red', RED, [x1 - x0, 0.12, 0.1], [(x0 + x1) / 2, glassTop + 0.06, -HD + 0.22]);
    for (const mx of [x0, x1]) kit.box('red', RED_DARK, [0.08, glassTop - DECK, 0.1], [mx, (glassTop + DECK) / 2, -HD + 0.22]);
  }
  // a pale reflection sweep across the glass, so it is not a hole in the render
  kit.panel('glass', 0xe4eef2, -HL + 0.6, -1.4, 1.75, 2.2, -HD + 0.25, 1);
  kit.panel('glass', 0xe4eef2, 1.4, HL - 0.6, 1.7, 2.05, -HD + 0.25, 1);
  // the wall panel behind the bench, so you cannot see through the shelter to the buildings
  kit.box('matte', 0xd9d4c6, [HL * 2 - 1.1, 0.5, 0.06], [0, glassTop + 0.3, -HD + 0.24]);

  // --- route board on the back wall -----------------------------------------------------------
  kit.box('red', RED, [1.42, 1.12, 0.07], [2.5, 1.78, -HD + 0.27]);
  kit.box('matte', DARK, [1.28, 1.0, 0.04], [2.5, 1.78, -HD + 0.31]);
  kit.panel('graphic', 0xffffff, 1.86, 3.14, 1.28, 2.28, -HD + 0.335, 1, ATLAS.board);

  // --- glazed end walls ---------------------------------------------------------------------
  // A BRT halte is a box, not a canopy: the ends are glazed too, which is most of why it reads
  // as a station from the far side of the road. The +Z end stops short of the platform edge so
  // there is a way in.
  for (const s of [1, -1] as const) {
    const x = s * (HL - 0.08);
    kit.side('glass', GLASS, -HD + 0.3, HD - 0.95, DECK + 0.2, glassTop, x, s);
    kit.box('red', RED, [0.14, PITCH, 0.14], [x, DECK + PITCH / 2, -HD + 0.24]);
    kit.box('red', RED, [0.12, 0.24, 0.14], [x, EAVE - 0.12, HD - 0.9]);
    kit.box('red', RED, [0.12, glassTop - DECK, 0.09], [x, (glassTop + DECK) / 2, HD - 0.92]);
    kit.box('red', RED, [0.12, 0.16, HD * 2 - 1.1], [x, glassTop + 0.06, -0.28]);
    kit.box('steel', STEEL, [0.06, glassTop - DECK - 0.2, 0.05], [x, (glassTop + DECK) / 2 + 0.1, -0.3]);
  }

  // --- bench against the glass ----------------------------------------------------------------
  // seat: three slats on a red underframe, backrest of two slats against the glass
  for (let i = 0; i < 3; i++) {
    kit.box('steel', STEEL, [2.24, 0.05, 0.13], [-0.2, DECK + 0.46, -HD + 0.46 + i * 0.15]);
  }
  kit.box('red', RED, [2.3, 0.06, 0.5], [-0.2, DECK + 0.4, -HD + 0.6]);
  for (let i = 0; i < 2; i++) {
    kit.box('steel', STEEL, [2.24, 0.15, 0.05], [-0.2, DECK + 0.72 + i * 0.19, -HD + 0.32], [-0.22, 0, 0]);
  }
  kit.box('red', RED, [2.3, 0.05, 0.06], [-0.2, DECK + 1.05, -HD + 0.29], [-0.22, 0, 0]);
  for (const lx of [-1.2, 0.82]) {
    for (const lz of [-HD + 0.42, -HD + 0.8]) {
      kit.box('steel', STEEL, [0.06, 0.4, 0.06], [lx, DECK + 0.2, lz]);
    }
  }

  // --- queue rail along the platform edge ------------------------------------------------------
  if (!simple) {
    const zr = HD - 0.55;
    for (const px of [-2.6, -0.9, 0.8, 2.5]) {
      kit.box('steel', STEEL, [0.06, 1.0, 0.06], [px, DECK + 0.5, zr]);
    }
    kit.rail([-2.6, DECK + 0.98, zr], [2.5, DECK + 0.98, zr], 0.028);
    kit.rail([-2.6, DECK + 0.58, zr], [2.5, DECK + 0.58, zr], 0.026);
  }

  // --- ceiling lights under the roof -----------------------------------------------------------
  for (const px of [-2.4, 2.4]) {
    const g = new THREE.PlaneGeometry(1.1, 0.18);
    g.rotateX(Math.PI / 2);
    g.translate(px, EAVE - 0.02, 0.1);
    kit.add('graphic', g, LAMP, ATLAS.lamp);
  }

  // --- assemble --------------------------------------------------------------------------------
  const materials: Record<string, THREE.MeshStandardMaterial> = {
    red: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.44, metalness: 0.24 }),
    concrete: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.02 }),
    glass: new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.08,
      metalness: 0.35,
      transparent: true,
      opacity: 0.44,
      side: THREE.DoubleSide,
    }),
    steel: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.78 }),
    matte: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.08 }),
    graphic: new THREE.MeshStandardMaterial({
      map: atlasTexture(),
      vertexColors: true,
      roughness: 0.55,
      transparent: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    }),
  };

  const group = new THREE.Group();
  group.name = 'halte';
  for (const [bucket, mat] of Object.entries(materials)) {
    const geo = kit.merge(bucket);
    if (!geo) continue;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = bucket !== 'glass' && bucket !== 'graphic';
    mesh.receiveShadow = true;
    if (bucket === 'glass' || bucket === 'graphic') mesh.renderOrder = 2;
    group.add(mesh);
  }

  group.position.set(x, 0, z);
  group.rotation.y = yaw;
  ctx.group.add(group);

  // colliders: the platform (kerb height, stepped over by peds) and the glazed back wall, as
  // axis-aligned boxes rotated with the shelter
  const push = (hx: number, hz: number, cx: number, cz: number, h: number) => {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const wx = cx * c + cz * s;
    const wz = -cx * s + cz * c;
    const ex = Math.abs(c) * hx + Math.abs(s) * hz;
    const ez = Math.abs(s) * hx + Math.abs(c) * hz;
    ctx.colliders.push({ minX: x + wx - ex, maxX: x + wx + ex, minZ: z + wz - ez, maxZ: z + wz + ez, h });
  };
  push(HL, HD, 0, 0, 0.42);
  push(HL - 0.5, 0.12, 0, -HD + 0.22, 2.8);

  ctx.audit.push({ name: 'halte', x, z, bottom: 0 });
  return group;
}
