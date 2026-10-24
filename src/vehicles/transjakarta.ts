import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { canvasTexture, shadowBlob, clamp } from '../core/utils';
import { ARTERIALS } from '../world/jakartamap';

/**
 * TransJakarta articulated bus — the red-and-white city bus that runs the dedicated busway
 * lanes. 17.9 m over the articulation, 2.5 m wide, low floor at 0.40 m, two doors on the
 * right-hand (kerb) side, a destination board over the windscreen and a yellow plate.
 *
 * References (Wikimedia Commons, CC BY-SA, see CREDITS.md):
 *   reference/assets/transjakarta-articulated-harmoni.jpg — Zhongtong articulated buses at
 *   Harmoni: red body, the window band running unbroken to the joint, bellows, three axles,
 *   roof AC pod, white "transjakarta" script on the red flank.
 *   reference/assets/transjakarta-halte-rawasari.jpg — a Scania unit nose-on at a halte, for the
 *   windscreen rake, twin wipers, the low front valance and the plate position.
 *
 * The white skirt band is the brief's red-and-white livery; the red body, the yellow plate and
 * the layout of glass, doors and lamps come from those photographs.
 *
 * Frame: +Z forward, +Y up, origin on the road between the axles, so the group drops straight
 * onto a road surface. The right-hand side of the vehicle (the door side) is +X.
 *
 * Budget: < 3000 triangles and < 16 draw calls. One mesh per material bucket, merged; the only
 * separate meshes are the three axle pivots (so the wheels can roll) and the road blob.
 *
 * Overlap contract: no two parts may put faces on the same plane facing the same way, because
 * that is z-fighting. `new TransjakartaBus({ audit: true })` keeps every part separately named
 * (`bus.parts`) so `tests/world/tj.mjs` can measure the whole surface and fail on a pair instead
 * of waiting for the owner to see a shimmer. Neighbouring parts are built to share an edge or to
 * stand a few millimetres apart, never to occupy the same plane.
 */

export const TRANSJAKARTA_DIMENSIONS = {
  /** nose to tail, metres */
  length: 17.9,
  width: 2.5,
  height: 3.2,
  wheelbase: 12.4,
  wheelRadius: 0.52,
  /** arcade mass factor — the heaviest thing on the busway */
  mass: 2.4,
} as const;

const L = 8.95;           // half length
const W = 2.5;
const HW = W / 2;         // 1.25
const FLOOR = 0.4;        // low-floor deck
const BELT = 1.06;        // white skirt / red body split
const WIN_BOT = 1.66;
const WIN_TOP = 2.56;
const ROOF = 2.96;
const JOINT_F = -0.62;    // front section ends here
const JOINT_R = -1.42;    // rear section starts here

const RED = 0xc1121f;
const RED_DARK = 0x8e0d16;
const WHITE = 0xeceff1;
const WHITE_DIRTY = 0xd8dcdd;
const TRIM = 0x16181d;
const RUBBER = 0x101114;
const METAL = 0xb4bac1;
const DARK_METAL = 0x3b3f46;
const GLASS = 0x1e3038;
const AMBER = 0xd88a1c;
const LENS = 0xf3f1e6;
const TAIL = 0xb51f18;

type Bucket = 'paint' | 'white' | 'glass' | 'matte' | 'metal' | 'graphic';

/**
 * One named piece of the bus, kept only when the bus is built for measurement.
 * `geometry` is already in bus space except for the axles, whose `matrix` places them.
 */
export interface BusPart {
  tag: string;
  label: string;
  bucket: Bucket;
  matrix: THREE.Matrix4;
  geometry: THREE.BufferGeometry;
}

/**
 * Graphic atlas. Each cell is cut at the aspect ratio of the panel that samples it, so the
 * type never squashes: the destination board is 7.8:1, the wordmark 5:1, the plate 3.7:1.
 * Rectangles are pixels in a 1024x512 canvas, top-left origin.
 */
const ATLAS = {
  dest: [0, 0, 700, 90],
  mark: [0, 100, 640, 128],
  plate: [0, 240, 280, 76],
  badge: [300, 240, 76, 76],
} as const;

/** pixel rect -> [u0, v0, u1, v1] with the texture's V axis pointing up */
function uvRect(r: readonly [number, number, number, number]): [number, number, number, number] {
  return [r[0] / 1024, 1 - (r[1] + r[3]) / 512, (r[0] + r[2]) / 1024, 1 - r[1] / 512];
}

function atlasTexture(): THREE.CanvasTexture {
  return canvasTexture(1024, 512, (c) => {
    c.clearRect(0, 0, 1024, 512);
    // --- destination board: amber LED on black, Corridor 1 (Blok M - Kota) ------------------
    c.fillStyle = '#0a0a0b';
    c.fillRect(0, 0, 700, 90);
    c.fillStyle = '#e8a821';
    c.textBaseline = 'middle';
    c.textAlign = 'left';
    c.font = '700 62px ui-sans-serif, system-ui, sans-serif';
    c.fillText('1', 16, 46);
    c.font = '700 34px ui-sans-serif, system-ui, sans-serif';
    c.fillText('KOTA', 74, 30);
    c.fillText('BLOK M', 74, 64);
    c.font = '700 22px ui-sans-serif, system-ui, sans-serif';
    c.fillStyle = '#8a6414';
    c.fillText('TRANSJAKARTA', 470, 46);
    c.strokeStyle = 'rgba(0,0,0,0.5)';
    c.lineWidth = 2;
    for (let y = 0; y < 90; y += 4) {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(700, y);
      c.stroke();
    }

    // --- side wordmark: white script on transparent ------------------------------------------
    c.fillStyle = '#ffffff';
    c.font = 'italic 700 96px ui-sans-serif, system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('transjakarta', 380, 168);
    c.beginPath();
    c.arc(64, 168, 34, 0, Math.PI * 2);
    c.lineWidth = 8;
    c.strokeStyle = '#ffffff';
    c.stroke();
    c.font = '700 34px ui-sans-serif, system-ui, sans-serif';
    c.fillText('TJ', 64, 170);

    // --- yellow number plate ------------------------------------------------------------------
    c.fillStyle = '#f0c93c';
    c.fillRect(0, 240, 280, 76);
    c.strokeStyle = '#2a2416';
    c.lineWidth = 3;
    c.strokeRect(2, 242, 276, 72);
    c.fillStyle = '#1a1710';
    c.font = '700 42px ui-sans-serif, system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillText('B 7249 TJC', 140, 280);

    // --- corridor badge: white numeral in a red box -------------------------------------------
    c.fillStyle = '#c1121f';
    c.fillRect(300, 240, 76, 76);
    c.fillStyle = '#ffffff';
    c.font = '700 58px ui-sans-serif, system-ui, sans-serif';
    c.fillText('1', 338, 280);
  });
}

class Kit {
  private readonly parts = new Map<Bucket, THREE.BufferGeometry[]>();
  /** where named parts go when the caller asked for an auditable bus */
  private readonly sink: BusPart[] | null;
  private readonly matrix: THREE.Matrix4;
  /** every part added while this tag is set shares the name */
  tag = 'body';
  private seq = 0;

  constructor(sink: BusPart[] | null = null, matrix = new THREE.Matrix4()) {
    this.sink = sink;
    this.matrix = matrix;
  }

  add(bucket: Bucket, geo: THREE.BufferGeometry, color: number): void {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (!g.attributes.uv) {
      const count = (g.attributes.position as THREE.BufferAttribute).count;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
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
    if (this.sink) {
      this.sink.push({ tag: this.tag, label: `${this.tag}#${this.seq++}`, bucket, matrix: this.matrix, geometry: g });
    }
  }

  box(
    bucket: Bucket,
    color: number,
    size: [number, number, number],
    at: [number, number, number],
    rot: [number, number, number] = [0, 0, 0]
  ): void {
    const g = new THREE.BoxGeometry(size[0], size[1], size[2]);
    g.rotateX(rot[0]);
    g.rotateY(rot[1]);
    g.rotateZ(rot[2]);
    g.translate(at[0], at[1], at[2]);
    this.add(bucket, g, color);
  }

  /** Cylinder between two points — mirror arms, grab poles, exhaust. */
  limb(bucket: Bucket, color: number, a: [number, number, number], b: [number, number, number], r: number, seg = 6): void {
    const pa = new THREE.Vector3(...a);
    const pb = new THREE.Vector3(...b);
    const dir = new THREE.Vector3().subVectors(pb, pa);
    const len = dir.length();
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
    g.translate((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, (pa.z + pb.z) / 2);
    this.add(bucket, g, color);
  }

  /** Outward-facing vertical panel on the side of the body (plane at x, facing ±X). */
  side(bucket: Bucket, color: number, y0: number, y1: number, z0: number, z1: number, x: number, sign: 1 | -1): void {
    const g = new THREE.PlaneGeometry(Math.abs(z1 - z0), y1 - y0);
    g.rotateY(sign > 0 ? Math.PI / 2 : -Math.PI / 2);
    g.translate(x, (y0 + y1) / 2, (z0 + z1) / 2);
    this.add(bucket, g, color);
  }

  /** Panel facing +Z (front) or -Z (rear). */
  face(bucket: Bucket, color: number, x0: number, x1: number, y0: number, y1: number, z: number, sign: 1 | -1, tilt = 0): void {
    const g = new THREE.PlaneGeometry(x1 - x0, y1 - y0);
    if (sign < 0) g.rotateY(Math.PI);
    if (tilt) g.rotateX(tilt);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, z);
    this.add(bucket, g, color);
  }

  /** Textured panel sampled from an atlas rect (pixels in the 1024x512 canvas). */
  graphic(rect: readonly [number, number, number, number], geo: THREE.BufferGeometry): void {
    const [u0, v0, u1, v1] = uvRect(rect);
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    }
    uv.needsUpdate = true;
    this.add('graphic', geo, 0xffffff);
  }

  merge(bucket: Bucket): THREE.BufferGeometry | null {
    const list = this.parts.get(bucket);
    if (!list || !list.length) return null;
    const merged = mergeGeometries(list, false);
    for (const g of list) g.dispose();
    merged?.computeBoundingSphere();
    return merged;
  }
}

export interface TransjakartaBusOptions {
  /** drop mirrors, wipers, roof kit and door hardware for background traffic */
  simple?: boolean;
  /** soft road blob; off when the scene draws real shadows */
  blob?: boolean;
  /** plate text is baked into the shared atlas, so this only changes the number on the texture */
  bodyColor?: number;
  /** keep every part separately named in `parts`, so an overlap audit can see them */
  audit?: boolean;
}

interface Axle {
  pivot: THREE.Group;
  z: number;
}

export class TransjakartaBus {
  readonly group = new THREE.Group();
  readonly size = {
    length: TRANSJAKARTA_DIMENSIONS.length,
    width: W,
    height: TRANSJAKARTA_DIMENSIONS.height,
  };
  readonly wheels: Axle[] = [];
  /** every add() call, in build order, when `audit` was asked for */
  readonly parts: BusPart[] = [];
  private readonly auditMode: boolean;
  private readonly disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];

  constructor(opts: TransjakartaBusOptions = {}) {
    const simple = opts.simple ?? false;
    const paint = opts.bodyColor ?? RED;
    this.auditMode = opts.audit ?? false;
    this.group.name = 'transjakarta-bus';
    const kit = this.kit();

    this.buildShell(kit, paint);
    this.buildWindows(kit, simple);
    this.buildDoors(kit, simple);
    this.buildFront(kit, simple, paint);
    this.buildRear(kit, simple, paint);
    this.buildRoof(kit, simple);
    this.buildLivery(kit);

    const materials: Record<Bucket, THREE.MeshStandardMaterial> = {
      paint: this.material({ vertexColors: true, roughness: 0.34, metalness: 0.16 }),
      white: this.material({ vertexColors: true, roughness: 0.42, metalness: 0.05 }),
      glass: this.material({
        vertexColors: true,
        roughness: 0.07,
        metalness: 0.62,
        transparent: true,
        opacity: 0.94,
      }),
      matte: this.material({ vertexColors: true, roughness: 0.86, metalness: 0.04 }),
      metal: this.material({ vertexColors: true, roughness: 0.3, metalness: 0.72 }),
      graphic: this.material({
        map: atlasTexture(),
        transparent: true,
        roughness: 0.45,
        metalness: 0.0,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      }),
    };

    for (const bucket of ['paint', 'white', 'glass', 'matte', 'metal', 'graphic'] as Bucket[]) {
      const geo = kit.merge(bucket);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, materials[bucket]);
      mesh.castShadow = bucket !== 'glass' && bucket !== 'graphic';
      mesh.receiveShadow = true;
      if (bucket === 'glass' || bucket === 'graphic') mesh.renderOrder = 2;
      this.disposables.push(geo);
      this.group.add(mesh);
    }

    for (const z of [6.15, -0.55, -6.45]) this.addAxle(z, simple);

    if (opts.blob !== false) {
      const blob = shadowBlob(3.4, 17.4, 0.4);
      blob.position.set(0, 0.014, 0);
      this.group.add(blob);
    }

    for (const m of Object.values(materials)) this.disposables.push(m);
    const tex = materials.graphic.map;
    if (tex) this.disposables.push(tex);
  }

  private kit(matrix?: THREE.Matrix4): Kit {
    return new Kit(this.auditMode ? this.parts : null, matrix ?? new THREE.Matrix4());
  }

  private material(params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, ...params });
    this.disposables.push(m);
    return m;
  }

  // ---------------------------------------------------------------------------------------------
  private buildShell(kit: Kit, paint: number): void {
    const sections: [number, number][] = [
      [L, JOINT_F],
      [JOINT_R, -L],
    ];
    for (const [zF, zR] of sections) {
      const len = zF - zR;
      const cz = (zF + zR) / 2;
      // white skirt band, red body above it, white roof cap
      kit.tag = 'shell/skirt';
      kit.box('white', WHITE, [W, BELT - FLOOR, len], [0, (BELT + FLOOR) / 2, cz]);
      kit.tag = 'shell/body';
      kit.box('paint', paint, [W, ROOF - BELT, len], [0, (ROOF + BELT) / 2, cz]);
      kit.tag = 'shell/roof-cap';
      kit.box('white', WHITE_DIRTY, [W - 0.16, 0.08, len - 0.02], [0, ROOF + 0.04, cz]);
      // dark underside so the bus is not lit from below like a floating box
      kit.tag = 'shell/underside';
      kit.box('matte', TRIM, [W - 0.3, 0.12, len - 0.1], [0, FLOOR - 0.06, cz]);
      // sills: a black rub strip along the bottom of each side, the strongest read of a bus flank
      for (const s of [1, -1] as const) {
        kit.tag = 'shell/sill-rubber';
        kit.box('matte', RUBBER, [0.03, 0.09, len - 0.12], [s * (HW + 0.005), FLOOR + 0.05, cz]);
        kit.tag = 'shell/sill-belt';
        kit.box('matte', TRIM, [0.02, 0.05, len - 0.06], [s * (HW + 0.012), BELT - 0.02, cz]);
      }
    }
    // Bellows between the two halves: dark, ribbed, and wider than the body, because a joint
    // narrower than the body reads as a hole between three separate buses from any three-quarter
    // view. It starts just above the road so the gap under the joint cannot show daylight — the
    // joint skirt that used to be a second box on the bellow's own plane is gone.
    const jointLen = JOINT_F - JOINT_R;
    const jointMid = (JOINT_F + JOINT_R) / 2;
    kit.tag = 'joint/bellow';
    kit.box('matte', 0x2a2c30, [W + 0.03, ROOF - 0.10, jointLen], [0, (ROOF + 0.10) / 2, jointMid]);
    for (let i = 0; i < 6; i++) {
      const z = JOINT_R + 0.06 + i * (jointLen - 0.12) / 5;
      kit.tag = 'joint/rib';
      kit.box('matte', 0x1b1d20, [W + 0.05, ROOF - 0.24, 0.06], [0, (ROOF + 0.2) / 2, z]);
    }
    // wheel wells: a dark panel on the flank behind each tyre, so the wheel sits in an arch.
    // The panel stops 2 cm below the belt line: a lip strip used to sit on top of it, sharing its
    // flank plane with the sill, the door post and the bellows, and every one of those pairs
    // shimmered. The dark panel alone reads as the arch.
    for (const z of [6.15, -0.55, -6.45]) {
      for (const s of [1, -1] as const) {
        kit.tag = 'shell/wheel-well';
        kit.box('matte', 0x0b0c0e, [0.02, 1.06, 1.52], [s * (HW + 0.002), 0.51, z]);
      }
    }
    // a dark collar over the joint, so the roof does not open a hole to the sky. It sits on the
    // bellows' top edge (bottom face at ROOF) and is narrower than the roof caps, so no two faces
    // share a plane and the joint does not shimmer when the bus drives past.
    kit.tag = 'joint/collar';
    kit.box('matte', 0x24262a, [W - 0.22, 0.16, jointLen], [0, ROOF + 0.08, jointMid]);
  }

  private buildWindows(kit: Kit, simple: boolean): void {
    const pane = (x: number, sign: 1 | -1, z0: number, z1: number) => {
      kit.tag = 'win/pane';
      kit.side('glass', GLASS, WIN_BOT, WIN_TOP, z0, z1, x, sign);
      // bright reflection strip near the top of each pane
      kit.tag = 'win/glint';
      kit.side('glass', 0x5a7280, WIN_TOP - 0.13, WIN_TOP - 0.04, z0 + 0.05, z1 - 0.05, x + sign * 0.004, sign);
    };
    // the door surrounds are 1.34 m wide on the kerb side, so the gap a pane must keep clear of
    // them is the surround plus half a pane: a window that ends three centimetres inside the door
    // post reads as glass growing out of the door
    const run = (sign: 1 | -1, zStart: number, zEnd: number, gaps: [number, number][]) => {
      const x = sign * (HW + 0.006);
      let z = zStart;
      const step = 1.36;
      while (z > zEnd) {
        const z1 = Math.max(zEnd, z - step);
        const mid = (z + z1) / 2;
        const blocked = gaps.some(([g0, g1]) => mid + 0.62 > g1 && mid - 0.62 < g0);
        if (!blocked) pane(x, sign, z1 + 0.075, z - 0.075);
        z = z1;
      }
    };
    // door gaps: front door and trailer door, kerb side only — kerbed side gets the gap on +X
    const doors: [number, number][] = [
      [5.22, 3.88],
      [-4.93, -6.27],
    ];
    run(1, L - 0.42, JOINT_F + 0.05, doors);
    run(-1, L - 0.42, JOINT_F + 0.05, []);
    run(1, JOINT_R - 0.05, -L + 0.5, doors);
    run(-1, JOINT_R - 0.05, -L + 0.5, []);
    if (!simple) {
      // thin black waist rail under the glass, so the band has an edge at speed
      kit.tag = 'win/rail';
      for (const s of [1, -1] as const) {
        kit.box('matte', TRIM, [0.02, 0.035, L * 2 - 1.2], [s * (HW + 0.008), WIN_BOT - 0.03, 0]);
      }
    }
  }

  private buildDoors(kit: Kit, simple: boolean): void {
    const door = (zc: number) => {
      const x = HW + 0.004;
      // white surround, then the dark door recess, then the two leaves
      kit.tag = 'door/surround';
      kit.box('white', WHITE, [0.03, WIN_TOP - FLOOR + 0.1, 1.34], [x, (WIN_TOP + FLOOR) / 2 + 0.03, zc]);
      kit.tag = 'door/recess';
      kit.box('matte', 0x1a1c20, [0.02, WIN_TOP - FLOOR - 0.04, 1.18], [x + 0.014, (WIN_TOP + FLOOR) / 2, zc]);
      for (const s of [1, -1] as const) {
        kit.tag = 'door/leaf';
        kit.side('glass', GLASS, 1.28, WIN_TOP - 0.1, zc + s * 0.06, zc + s * 0.55, x + 0.026, 1);
      }
      kit.tag = 'door/divider';
      kit.box('paint', RED_DARK, [0.02, WIN_TOP - 1.28, 0.1], [x + 0.03, (WIN_TOP + 1.28) / 2, zc]);
      kit.tag = 'door/skirt-top';
      kit.box('white', WHITE, [0.024, 0.1, 1.2], [x + 0.026, 1.24, zc]);
      kit.tag = 'door/skirt-bottom';
      kit.box('white', WHITE, [0.024, 0.07, 1.2], [x + 0.026, FLOOR + 0.08, zc]);
      if (!simple) {
        // door-open button plate beside the front door
        kit.tag = 'door/button';
        kit.box('matte', 0x2c2f34, [0.03, 0.16, 0.14], [x + 0.01, 1.45, zc + 0.72]);
        kit.box('glass', 0x66d18a, [0.012, 0.05, 0.05], [x + 0.028, 1.47, zc + 0.72]);
      }
    };
    door(4.55);
    door(-5.6);
  }

  private buildFront(kit: Kit, simple: boolean, paint: number): void {
    // nose: slightly narrower at the top, with the windscreen raked back
    kit.tag = 'front/upper';
    kit.face('paint', paint, -HW + 0.02, HW - 0.02, BELT, ROOF, L + 0.005, 1);
    kit.tag = 'front/lower';
    kit.face('white', WHITE, -HW + 0.02, HW - 0.02, FLOOR, BELT, L + 0.005, 1);
    // windscreen, split by a centre pillar
    kit.tag = 'front/screen';
    for (const s of [1, -1] as const) {
      kit.face('glass', GLASS, s > 0 ? 0.06 : -HW + 0.1, s > 0 ? HW - 0.1 : -0.06, 1.58, 2.55, L + 0.018, 1, -0.05);
    }
    kit.tag = 'front/pillar';
    kit.box('matte', TRIM, [0.1, 1.0, 0.04], [0, 2.06, L + 0.012]);
    kit.box('matte', TRIM, [2.36, 0.06, 0.03], [0, 2.57, L + 0.014]);
    kit.box('matte', TRIM, [2.36, 0.05, 0.03], [0, 1.56, L + 0.014]);
    // wipers
    if (!simple) {
      kit.tag = 'front/wiper';
      for (const s of [1, -1] as const) {
        kit.box('matte', 0x14151a, [0.035, 0.62, 0.02], [s * 0.5, 1.92, L + 0.045], [0, 0, s * 0.55]);
      }
    }
    // destination board: black housing with the amber LED panel recessed inside it
    kit.tag = 'front/board-housing';
    kit.box('matte', 0x0d0e10, [2.34, 0.36, 0.08], [0, 2.77, L + 0.015]);
    kit.tag = 'front/board';
    const dest = new THREE.PlaneGeometry(2.22, 0.29);
    dest.translate(0, 2.77, L + 0.062);
    kit.graphic(ATLAS.dest, dest);
    // bumper, headlamps, fogs, plate
    kit.tag = 'front/bumper';
    kit.box('matte', 0x24262b, [W - 0.02, 0.36, 0.14], [0, 0.46, L + 0.04]);
    kit.box('matte', 0x1a1c1f, [W - 0.14, 0.06, 0.06], [0, 0.66, L + 0.05]);
    for (const s of [1, -1] as const) {
      // headlamp cluster: dark housing, bright lens, amber indicator outboard
      kit.tag = 'front/lamp-housing';
      kit.box('matte', 0x14161a, [0.52, 0.24, 0.06], [s * 0.78, 0.9, L + 0.03]);
      kit.tag = 'front/lamp-lens';
      kit.box('glass', LENS, [0.44, 0.17, 0.05], [s * 0.78, 0.9, L + 0.062]);
      kit.tag = 'front/lamp-amber';
      kit.box('paint', AMBER, [0.11, 0.13, 0.04], [s * 1.1, 0.9, L + 0.058]);
      kit.tag = 'front/fog';
      kit.box('glass', 0xdfe4e6, [0.13, 0.1, 0.04], [s * 0.6, 0.7, L + 0.05]);
    }
    kit.tag = 'front/plate';
    const plate = new THREE.PlaneGeometry(0.56, 0.15);
    plate.translate(0, 0.6, L + 0.115);
    kit.graphic(ATLAS.plate, plate);
    // mirrors on long arms, because a bus mirror hangs out over the lane
    if (!simple) {
      kit.tag = 'front/mirror';
      for (const s of [1, -1] as const) {
        kit.limb('matte', 0x1b1d21, [s * (HW - 0.05), 2.5, L - 0.18], [s * (HW + 0.34), 2.28, L + 0.12], 0.032, 5);
        kit.box('matte', 0x1b1d21, [0.1, 0.46, 0.22], [s * (HW + 0.38), 2.16, L + 0.14]);
        kit.box('glass', 0x2b3942, [0.03, 0.4, 0.18], [s * (HW + 0.435), 2.16, L + 0.14]);
      }
    }
    // driver's sun visor above the screen
    kit.tag = 'front/visor';
    kit.box('white', WHITE_DIRTY, [2.3, 0.06, 0.16], [0, 2.9, L - 0.06]);
  }

  private buildRear(kit: Kit, simple: boolean, paint: number): void {
    kit.tag = 'rear/upper';
    kit.face('paint', paint, -HW + 0.02, HW - 0.02, BELT, ROOF, -L - 0.005, -1);
    kit.tag = 'rear/lower';
    kit.face('white', WHITE, -HW + 0.02, HW - 0.02, FLOOR, BELT, -L - 0.005, -1);
    // rear screen sits inside the red panel
    kit.tag = 'rear/screen';
    kit.face('glass', GLASS, -1.0, 1.0, 1.62, 2.42, -L - 0.012, -1);
    kit.tag = 'rear/rail';
    kit.box('matte', TRIM, [W - 0.1, 0.09, 0.06], [0, 1.55, -L - 0.01]);
    // engine grille + lamps
    kit.tag = 'rear/grille';
    kit.box('matte', 0x24262b, [1.4, 0.42, 0.06], [0, 1.18, -L - 0.01]);
    for (let i = 0; i < 3; i++) kit.box('matte', 0x141519, [1.36, 0.05, 0.03], [0, 1.02 + i * 0.14, -L - 0.045]);
    for (const s of [1, -1] as const) {
      kit.tag = 'rear/lamp';
      kit.box('paint', TAIL, [0.26, 0.5, 0.06], [s * 0.92, 0.92, -L - 0.02]);
      // the lens and the indicator sit proud of the cluster's back face and 1 cm inside its
      // flanks: sharing either plane made the lamp shimmer at speed
      kit.box('paint', LENS, [0.24, 0.12, 0.05], [s * 0.92, 0.72, -L - 0.045]);
      kit.box('paint', AMBER, [0.24, 0.1, 0.05], [s * 0.92, 1.18, -L - 0.045]);
    }
    kit.tag = 'rear/bumper';
    kit.box('matte', 0x24262b, [W - 0.04, 0.3, 0.12], [0, 0.56, -L - 0.03]);
    if (!simple) {
      kit.tag = 'rear/plate';
      const plate = new THREE.PlaneGeometry(0.56, 0.15);
      plate.rotateY(Math.PI);
      plate.translate(0, 0.64, -L - 0.1);
      kit.graphic(ATLAS.plate, plate);
    }
  }

  private buildRoof(kit: Kit, simple: boolean): void {
    // AC pod over the front half, a vent hatch over the trailer — the give-away roof silhouette
    kit.tag = 'roof/ac';
    kit.box('white', 0xd3d7d9, [1.7, 0.24, 2.7], [0, ROOF + 0.16, 3.9]);
    kit.tag = 'roof/ac-top';
    kit.box('matte', 0x9aa0a4, [1.5, 0.05, 2.5], [0, ROOF + 0.29, 3.9]);
    if (!simple) {
      kit.tag = 'roof/hatch';
      kit.box('white', 0xd3d7d9, [1.1, 0.12, 1.3], [0, ROOF + 0.1, -5.2]);
      // the marker lamp sits on the roof cap, not 4 cm above it
      kit.tag = 'roof/marker';
      kit.box('matte', 0x2d2f33, [0.5, 0.06, 0.5], [0.62, ROOF + 0.07, 0.9]);
      // CNG bottles under a cowl on the tractor roof line
      kit.tag = 'roof/cng';
      kit.box('white', 0xdadde0, [1.9, 0.2, 0.34], [0, ROOF + 0.14, 6.6]);
    }
  }

  private buildLivery(kit: Kit): void {
    // side wordmark, a third of the way back on each half
    for (const s of [1, -1] as const) {
      for (const z of [1.35, -3.35]) {
        kit.tag = 'livery/mark';
        const g = new THREE.PlaneGeometry(2.4, 0.48);
        if (s > 0) g.rotateY(Math.PI / 2);
        else g.rotateY(-Math.PI / 2);
        g.translate(s * (HW + 0.012), 1.36, z);
        kit.graphic(ATLAS.mark, g);
      }
    }
    // corridor badge beside the front door
    for (const s of [1, -1] as const) {
      kit.tag = 'livery/badge';
      const g = new THREE.PlaneGeometry(0.3, 0.3);
      if (s > 0) g.rotateY(Math.PI / 2);
      else g.rotateY(-Math.PI / 2);
      g.translate(s * (HW + 0.014), 1.42, L - 1.25);
      kit.graphic(ATLAS.badge, g);
    }
    // front wordmark under the screen, right above the bumper line
    kit.tag = 'livery/front-mark';
    const front = new THREE.PlaneGeometry(1.5, 0.3);
    front.translate(0, 1.29, L + 0.022);
    kit.graphic(ATLAS.mark, front);
  }

  private addAxle(z: number, simple: boolean): void {
    const pivot = new THREE.Group();
    pivot.position.set(0, TRANSJAKARTA_DIMENSIONS.wheelRadius, z);
    const matrix = new THREE.Matrix4().makeTranslation(0, TRANSJAKARTA_DIMENSIONS.wheelRadius, z);
    const kit = this.kit(matrix);
    const r = TRANSJAKARTA_DIMENSIONS.wheelRadius;
    for (const s of [1, -1] as const) {
      const x = s * (HW - 0.1);
      kit.tag = 'axle/tyre';
      const tyre = new THREE.CylinderGeometry(r, r, 0.36, simple ? 8 : 12, 1);
      tyre.rotateZ(Math.PI / 2);
      tyre.translate(x, 0, 0);
      kit.add('matte', tyre, RUBBER);
      kit.tag = 'axle/hub';
      const hub = new THREE.CylinderGeometry(r * 0.58, r * 0.58, 0.375, simple ? 8 : 10, 1);
      hub.rotateZ(Math.PI / 2);
      hub.translate(x, 0, 0);
      kit.add('metal', hub, METAL);
      if (!simple) {
        kit.tag = 'axle/cap';
        const cap = new THREE.CylinderGeometry(r * 0.2, r * 0.2, 0.39, 6, 1);
        cap.rotateZ(Math.PI / 2);
        cap.translate(x, 0, 0);
        kit.add('metal', cap, DARK_METAL);
      }
    }
    const mat = this.material({ vertexColors: true, roughness: 0.92, metalness: 0.02 });
    const met = this.material({ vertexColors: true, roughness: 0.36, metalness: 0.72 });
    for (const b of ['matte', 'metal'] as Bucket[]) {
      const geo = kit.merge(b);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, b === 'matte' ? mat : met);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.disposables.push(geo);
      pivot.add(mesh);
    }
    this.group.add(pivot);
    this.wheels.push({ pivot, z });
  }

  /** Idle life: wheels roll with distance covered. */
  update(dt: number, speed = 0): void {
    const spin = (speed * dt) / TRANSJAKARTA_DIMENSIONS.wheelRadius;
    for (const w of this.wheels) w.pivot.rotation.x += spin;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

// ===============================================================================================
// Service: the corridor 1 loop
// ===============================================================================================

/** Lateral offset of the busway lane from the arterial centreline, metres. */
export const TJ_LANE = 1.85;
/** Cruising speed on the busway, metres per second (~32 km/h, which is what a TJ averages). */
export const TJ_SPEED = 9;

export interface RoutePoint {
  x: number;
  z: number;
}

/**
 * A closed two-way loop along a road polyline: out on one side of the centreline, back on the
 * other, with a semicircle at each terminus. The bus drives it like a corridor bus — down the
 * spine and back — instead of being spawned on a random road and driven by car physics, which a
 * 17.9 m articulated bus cannot do without clipping every kerb.
 */
export function buswayLoop(path: readonly (readonly [number, number])[], lane = TJ_LANE): RoutePoint[] {
  const pts = path.map(([x, z]) => ({ x, z }));
  const n = pts.length;
  if (n < 2) return pts;
  // left-hand normal of every segment
  const normals: RoutePoint[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    const dz = pts[i + 1].z - pts[i].z;
    const len = Math.hypot(dx, dz) || 1;
    normals.push({ x: -dz / len, z: dx / len });
  }
  // verts = a point offset to `side` metres on the left of travel, mitred at each corner
  const verts = (side: number): RoutePoint[] => {
    const out: RoutePoint[] = [];
    for (let i = 0; i < n; i++) {
      const n0 = normals[Math.max(0, i - 1)];
      const n1 = normals[Math.min(n - 2, i)];
      const mx = n0.x + n1.x;
      const mz = n0.z + n1.z;
      const mlen = Math.hypot(mx, mz);
      if (mlen < 1e-6) {
        // a 180 degree kink: keep both endpoints instead of collapsing them
        out.push({ x: pts[i].x + n1.x * side, z: pts[i].z + n1.z * side });
        continue;
      }
      const k = 1 / Math.max(0.35, (mx * n1.x + mz * n1.z) / mlen);
      out.push({ x: pts[i].x + (mx / mlen) * side * k, z: pts[i].z + (mz / mlen) * side * k });
    }
    return out;
  };
  const out = verts(lane);
  const back = verts(-lane).reverse();

  const arc = (from: RoutePoint, centre: RoutePoint, ahead: RoutePoint): RoutePoint[] => {
    const v = { x: from.x - centre.x, z: from.z - centre.z };
    const w = { x: ahead.x - centre.x, z: ahead.z - centre.z };
    const res: RoutePoint[] = [];
    for (let i = 1; i <= 8; i++) {
      const t = i / 9;
      const a = Math.PI * t;
      res.push({
        x: centre.x + v.x * Math.cos(a) + w.x * Math.sin(a),
        z: centre.z + v.z * Math.cos(a) + w.z * Math.sin(a),
      });
    }
    return res;
  };
  const dirEnd = { x: pts[n - 1].x - pts[n - 2].x, z: pts[n - 1].z - pts[n - 2].z };
  const dlen = Math.hypot(dirEnd.x, dirEnd.z) || 1;
  const aheadEnd = { x: pts[n - 1].x + (dirEnd.x / dlen) * lane, z: pts[n - 1].z + (dirEnd.z / dlen) * lane };
  const dirStart = { x: pts[0].x - pts[1].x, z: pts[0].z - pts[1].z };
  const slen = Math.hypot(dirStart.x, dirStart.z) || 1;
  const aheadStart = { x: pts[0].x + (dirStart.x / slen) * lane, z: pts[0].z + (dirStart.z / slen) * lane };

  return [
    ...out,
    ...arc(out[n - 1], pts[n - 1], aheadEnd),
    ...back,
    ...arc(back[n - 1], pts[0], aheadStart),
  ];
}

export interface TransjakartaServiceOptions {
  /** how many buses are in service on the loop */
  count?: number;
  /** road the corridor runs along; defaults to Thamrin–Sudirman, the spine of the map */
  path?: readonly (readonly [number, number])[];
  speed?: number;
  simple?: boolean;
  blob?: boolean;
}

/**
 * The busway in service: `count` articulated buses sharing one closed loop, evenly spaced, at a
 * constant cruise. They are visible from normal play because the loop runs the map's own spine
 * through the spawn junction.
 */
export class TransjakartaService {
  readonly buses: TransjakartaBus[] = [];
  readonly route: RoutePoint[];
  /** cumulative distance at each route vertex, plus the loop length at the end */
  private readonly marks: number[] = [];
  private readonly s: number[] = [];
  private readonly speed: number;
  private readonly city: any;
  private readonly total: number;

  constructor(scene: THREE.Scene, city: any, opts: TransjakartaServiceOptions = {}) {
    this.city = city;
    this.speed = opts.speed ?? TJ_SPEED;
    const count = Math.max(1, opts.count ?? 3);
    this.route = buswayLoop(opts.path ?? ARTERIALS[0].path);
    let acc = 0;
    this.marks.push(0);
    for (let i = 1; i <= this.route.length; i++) {
      const a = this.route[i - 1];
      const b = this.route[i % this.route.length];
      acc += Math.hypot(b.x - a.x, b.z - a.z);
      this.marks.push(acc);
    }
    this.total = acc;
    for (let i = 0; i < count; i++) {
      const bus = new TransjakartaBus({ simple: opts.simple ?? false, blob: opts.blob ?? true });
      bus.group.rotation.order = 'YXZ';
      scene.add(bus.group);
      this.buses.push(bus);
      this.s[i] = (this.total * i) / count;
      this.place(i);
    }
  }

  /** Road position and heading at distance `d` along the loop. */
  private at(d: number): { x: number; z: number; tx: number; tz: number } {
    const dist = ((d % this.total) + this.total) % this.total;
    let i = 0;
    while (i < this.route.length - 1 && this.marks[i + 1] < dist) i++;
    const a = this.route[i];
    const b = this.route[(i + 1) % this.route.length];
    const segLen = this.marks[i + 1] - this.marks[i] || 1;
    const t = (dist - this.marks[i]) / segLen;
    const tx = (b.x - a.x) / segLen;
    const tz = (b.z - a.z) / segLen;
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, tx, tz };
  }

  /** Distance from a world point to the loop, and the loop's own length. */
  nearest(x: number, z: number): { distance: number; along: number } {
    let best = Infinity;
    let along = 0;
    for (let i = 0; i < this.route.length; i++) {
      const a = this.route[i];
      const b = this.route[(i + 1) % this.route.length];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz || 1;
      const t = ((x - a.x) * dx + (z - a.z) * dz) / len2;
      const ct = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = a.x + dx * ct;
      const pz = a.z + dz * ct;
      const d = Math.hypot(x - px, z - pz);
      if (d < best) {
        best = d;
        along = this.marks[i] + (this.marks[i + 1] - this.marks[i]) * ct;
      }
    }
    return { distance: best, along };
  }

  private place(i: number): void {
    const bus = this.buses[i];
    const here = this.at(this.s[i]);
    const yaw = Math.atan2(here.tx, here.tz);
    const ahead = this.at(this.s[i] + 6);
    const behind = this.at(this.s[i] - 6);
    const ground = (x: number, z: number) => (this.city?.groundHeightAt ? this.city.groundHeightAt(x, z) : 0);
    const yFront = ground(ahead.x, ahead.z);
    const yBack = ground(behind.x, behind.z);
    bus.group.position.set(here.x, (yFront + yBack) / 2, here.z);
    bus.group.rotation.y = yaw;
    // the body follows the grade of the road it is on, so an 18 m bus does not plough
    bus.group.rotation.x = Math.atan2(yBack - yFront, 12);
    bus.group.updateMatrixWorld();
  }

  update(dt: number): void {
    for (let i = 0; i < this.buses.length; i++) {
      this.s[i] = (this.s[i] + this.speed * dt) % this.total;
      this.place(i);
      this.buses[i].update(dt, this.speed);
    }
  }

  /** Where bus `i` is, for the HUD/tests. */
  positionOf(i: number): THREE.Vector3 {
    return this.buses[i].group.position;
  }

  /** Snap bus `i` to a distance along the loop (used by the proof shot). */
  warp(i: number, along: number): void {
    this.s[i] = clamp(along, 0, this.total);
    this.place(i);
  }
}
