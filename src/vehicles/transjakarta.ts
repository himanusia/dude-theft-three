import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { canvasTexture, shadowBlob } from '../core/utils';

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
  private readonly disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];

  constructor(opts: TransjakartaBusOptions = {}) {
    const simple = opts.simple ?? false;
    const paint = opts.bodyColor ?? RED;
    this.group.name = 'transjakarta-bus';
    const kit = new Kit();

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
      kit.box('white', WHITE, [W, BELT - FLOOR, len], [0, (BELT + FLOOR) / 2, cz]);
      kit.box('paint', paint, [W, ROOF - BELT, len], [0, (ROOF + BELT) / 2, cz]);
      kit.box('white', WHITE_DIRTY, [W - 0.16, 0.08, len - 0.02], [0, ROOF + 0.04, cz]);
      // dark underside so the bus is not lit from below like a floating box
      kit.box('matte', TRIM, [W - 0.3, 0.12, len - 0.1], [0, FLOOR - 0.06, cz]);
      // sills: a black rub strip along the bottom of each side, the strongest read of a bus flank
      for (const s of [1, -1] as const) {
        kit.box('matte', RUBBER, [0.03, 0.09, len - 0.12], [s * (HW + 0.005), FLOOR + 0.05, cz]);
        kit.box('matte', TRIM, [0.02, 0.05, len - 0.06], [s * (HW + 0.012), BELT - 0.02, cz]);
      }
    }
    // bellows between the two halves: dark, ribbed, and narrower than the body
    // The bellows has to stand proud of the bodywork, not sink inside it: a joint narrower than
    // the body reads as a hole between three separate buses from any three-quarter view.
    const jointLen = JOINT_F - JOINT_R;
    const jointMid = (JOINT_F + JOINT_R) / 2;
    kit.box('matte', 0x2a2c30, [W + 0.03, ROOF - 0.16, jointLen], [0, (ROOF + 0.16) / 2, jointMid]);
    for (let i = 0; i < 6; i++) {
      const z = JOINT_R + 0.06 + i * (jointLen - 0.12) / 5;
      kit.box('matte', 0x1b1d20, [W + 0.05, ROOF - 0.24, 0.06], [0, (ROOF + 0.2) / 2, z]);
    }
    // skirt so the gap under the joint does not show daylight
    for (const s of [1, -1] as const) {
      kit.box('matte', 0x1b1d20, [W + 0.04, 0.42, jointLen], [0, 0.24, jointMid]);
    }
    // wheel wells: a dark panel on the flank behind each tyre, so the wheel sits in an arch
    for (const z of [6.15, -0.55, -6.45]) {
      for (const s of [1, -1] as const) {
        kit.box('matte', 0x0b0c0e, [0.02, 1.08, 1.52], [s * (HW + 0.002), 0.52, z]);
        kit.box('matte', 0x0b0c0e, [0.025, 0.09, 1.56], [s * (HW + 0.004), 1.07, z]);
      }
    }
    // a dark collar above and below the bellows so the joint does not open a hole to the sky
    kit.box('matte', 0x24262a, [W - 0.16, 0.16, JOINT_F - JOINT_R + 0.1], [0, ROOF + 0.02, (JOINT_F + JOINT_R) / 2]);
  }

  private buildWindows(kit: Kit, simple: boolean): void {
    const pane = (x: number, sign: 1 | -1, z0: number, z1: number) => {
      kit.side('glass', GLASS, WIN_BOT, WIN_TOP, z0, z1, x, sign);
      // bright reflection strip near the top of each pane
      kit.side('glass', 0x5a7280, WIN_TOP - 0.13, WIN_TOP - 0.04, z0 + 0.05, z1 - 0.05, x + sign * 0.004, sign);
    };
    const run = (sign: 1 | -1, zStart: number, zEnd: number, gaps: [number, number][]) => {
      const x = sign * (HW + 0.006);
      let z = zStart;
      const step = 1.36;
      while (z > zEnd) {
        const z1 = Math.max(zEnd, z - step);
        const mid = (z + z1) / 2;
        const blocked = gaps.some(([g0, g1]) => mid < g0 && mid > g1);
        if (!blocked) pane(x, sign, z1 + 0.075, z - 0.075);
        z = z1;
      }
    };
    // door gaps: front door and trailer door, kerb side only — kerbed side gets the gap on +X
    run(1, L - 0.42, JOINT_F + 0.05, [
      [5.3, 3.8],
      [-4.85, -6.35],
    ]);
    run(-1, L - 0.42, JOINT_F + 0.05, []);
    run(1, JOINT_R - 0.05, -L + 0.5, [
      [5.3, 3.8],
      [-4.85, -6.35],
    ]);
    run(-1, JOINT_R - 0.05, -L + 0.5, []);
    if (!simple) {
      // thin black waist rail under the glass, so the band has an edge at speed
      for (const s of [1, -1] as const) {
        kit.box('matte', TRIM, [0.02, 0.035, L * 2 - 1.2], [s * (HW + 0.008), WIN_BOT - 0.03, 0]);
      }
    }
  }

  private buildDoors(kit: Kit, simple: boolean): void {
    const door = (zc: number) => {
      const x = HW + 0.004;
      // white surround, then the dark door recess, then the two leaves
      kit.box('white', WHITE, [0.03, WIN_TOP - FLOOR + 0.1, 1.34], [x, (WIN_TOP + FLOOR) / 2 + 0.03, zc]);
      kit.box('matte', 0x1a1c20, [0.02, WIN_TOP - FLOOR - 0.04, 1.18], [x + 0.014, (WIN_TOP + FLOOR) / 2, zc]);
      for (const s of [1, -1] as const) {
        kit.side('glass', GLASS, 1.28, WIN_TOP - 0.1, zc + s * 0.06, zc + s * 0.55, x + 0.026, 1);
      }
      kit.box('paint', RED_DARK, [0.02, WIN_TOP - 1.28, 0.1], [x + 0.03, (WIN_TOP + 1.28) / 2, zc]);
      kit.box('white', WHITE, [0.024, 0.1, 1.2], [x + 0.026, 1.24, zc]);
      kit.box('white', WHITE, [0.024, 0.07, 1.2], [x + 0.026, FLOOR + 0.08, zc]);
      if (!simple) {
        // door-open button plate beside the front door
        kit.box('matte', 0x2c2f34, [0.03, 0.16, 0.14], [x + 0.01, 1.45, zc + 0.72]);
        kit.box('glass', 0x66d18a, [0.012, 0.05, 0.05], [x + 0.028, 1.47, zc + 0.72]);
      }
    };
    door(4.55);
    door(-5.6);
  }

  private buildFront(kit: Kit, simple: boolean, paint: number): void {
    // nose: slightly narrower at the top, with the windscreen raked back
    kit.face('paint', paint, -HW + 0.02, HW - 0.02, BELT, ROOF, L + 0.005, 1);
    kit.face('white', WHITE, -HW + 0.02, HW - 0.02, FLOOR, BELT, L + 0.005, 1);
    // windscreen, split by a centre pillar
    for (const s of [1, -1] as const) {
      kit.face('glass', GLASS, s > 0 ? 0.06 : -HW + 0.1, s > 0 ? HW - 0.1 : -0.06, 1.58, 2.55, L + 0.018, 1, -0.05);
    }
    kit.box('matte', TRIM, [0.1, 1.0, 0.04], [0, 2.06, L + 0.012]);
    kit.box('matte', TRIM, [2.36, 0.06, 0.03], [0, 2.57, L + 0.014]);
    kit.box('matte', TRIM, [2.36, 0.05, 0.03], [0, 1.56, L + 0.014]);
    // wipers
    if (!simple) {
      for (const s of [1, -1] as const) {
        kit.box('matte', 0x14151a, [0.035, 0.62, 0.02], [s * 0.5, 1.92, L + 0.045], [0, 0, s * 0.55]);
      }
    }
    // destination board: black housing with the amber LED panel recessed inside it
    kit.box('matte', 0x0d0e10, [2.34, 0.38, 0.08], [0, 2.77, L + 0.015]);
    const dest = new THREE.PlaneGeometry(2.22, 0.29);
    dest.translate(0, 2.77, L + 0.062);
    kit.graphic(ATLAS.dest, dest);
    // bumper, headlamps, fogs, plate
    kit.box('matte', 0x24262b, [W - 0.02, 0.36, 0.14], [0, 0.46, L + 0.04]);
    kit.box('matte', 0x1a1c1f, [W - 0.14, 0.06, 0.06], [0, 0.66, L + 0.05]);
    for (const s of [1, -1] as const) {
      // headlamp cluster: dark housing, bright lens, amber indicator outboard
      kit.box('matte', 0x14161a, [0.52, 0.24, 0.06], [s * 0.78, 0.9, L + 0.03]);
      kit.box('glass', LENS, [0.44, 0.17, 0.05], [s * 0.78, 0.9, L + 0.062]);
      kit.box('paint', AMBER, [0.11, 0.13, 0.04], [s * 1.1, 0.9, L + 0.058]);
      kit.box('glass', 0xdfe4e6, [0.13, 0.1, 0.04], [s * 0.6, 0.7, L + 0.05]);
    }
    const plate = new THREE.PlaneGeometry(0.56, 0.15);
    plate.translate(0, 0.6, L + 0.115);
    kit.graphic(ATLAS.plate, plate);
    // mirrors on long arms, because a bus mirror hangs out over the lane
    if (!simple) {
      for (const s of [1, -1] as const) {
        kit.limb('matte', 0x1b1d21, [s * (HW - 0.05), 2.5, L - 0.18], [s * (HW + 0.34), 2.28, L + 0.12], 0.032, 5);
        kit.box('matte', 0x1b1d21, [0.1, 0.46, 0.22], [s * (HW + 0.38), 2.16, L + 0.14]);
        kit.box('glass', 0x2b3942, [0.03, 0.4, 0.18], [s * (HW + 0.435), 2.16, L + 0.14]);
      }
    }
    // driver's sun visor above the screen
    kit.box('white', WHITE_DIRTY, [2.3, 0.06, 0.16], [0, 2.9, L - 0.06]);
  }

  private buildRear(kit: Kit, simple: boolean, paint: number): void {
    kit.face('paint', paint, -HW + 0.02, HW - 0.02, BELT, ROOF, -L - 0.005, -1);
    kit.face('white', WHITE, -HW + 0.02, HW - 0.02, FLOOR, BELT, -L - 0.005, -1);
    // rear screen sits inside the red panel
    kit.face('glass', GLASS, -1.0, 1.0, 1.62, 2.42, -L - 0.012, -1);
    kit.box('matte', TRIM, [W - 0.1, 0.09, 0.06], [0, 1.55, -L - 0.01]);
    // engine grille + lamps
    kit.box('matte', 0x24262b, [1.4, 0.42, 0.06], [0, 1.18, -L - 0.01]);
    for (let i = 0; i < 3; i++) kit.box('matte', 0x141519, [1.36, 0.05, 0.03], [0, 1.02 + i * 0.14, -L - 0.045]);
    for (const s of [1, -1] as const) {
      kit.box('paint', TAIL, [0.26, 0.5, 0.06], [s * 0.92, 0.92, -L - 0.02]);
      kit.box('paint', LENS, [0.26, 0.12, 0.04], [s * 0.92, 0.72, -L - 0.05]);
      kit.box('paint', AMBER, [0.26, 0.1, 0.04], [s * 0.92, 1.18, -L - 0.05]);
    }
    kit.box('matte', 0x24262b, [W - 0.04, 0.3, 0.12], [0, 0.55, -L - 0.03]);
    if (!simple) {
      const plate = new THREE.PlaneGeometry(0.56, 0.15);
      plate.rotateY(Math.PI);
      plate.translate(0, 0.64, -L - 0.09);
      kit.graphic(ATLAS.plate, plate);
    }
  }

  private buildRoof(kit: Kit, simple: boolean): void {
    // AC pod over the front half, a vent hatch over the trailer — the give-away roof silhouette
    kit.box('white', 0xd3d7d9, [1.7, 0.24, 2.7], [0, ROOF + 0.16, 3.9]);
    kit.box('matte', 0x9aa0a4, [1.5, 0.05, 2.5], [0, ROOF + 0.29, 3.9]);
    if (!simple) {
      kit.box('white', 0xd3d7d9, [1.1, 0.12, 1.3], [0, ROOF + 0.1, -5.2]);
      kit.box('matte', 0x2d2f33, [0.5, 0.06, 0.5], [0.62, ROOF + 0.11, 0.9]);
      // CNG bottles under a cowl on the tractor roof line
      kit.box('white', 0xdadde0, [1.9, 0.2, 0.34], [0, ROOF + 0.14, 6.6]);
    }
  }

  private buildLivery(kit: Kit): void {
    // side wordmark, a third of the way back on each half
    for (const s of [1, -1] as const) {
      for (const z of [1.35, -3.35]) {
        const g = new THREE.PlaneGeometry(2.4, 0.48);
        if (s > 0) g.rotateY(Math.PI / 2);
        else g.rotateY(-Math.PI / 2);
        g.translate(s * (HW + 0.012), 1.36, z);
        kit.graphic(ATLAS.mark, g);
      }
    }
    // corridor badge beside the front door
    for (const s of [1, -1] as const) {
      const g = new THREE.PlaneGeometry(0.3, 0.3);
      if (s > 0) g.rotateY(Math.PI / 2);
      else g.rotateY(-Math.PI / 2);
      g.translate(s * (HW + 0.014), 1.42, L - 1.25);
      kit.graphic(ATLAS.badge, g);
    }
    // front wordmark under the screen, right above the bumper line
    const front = new THREE.PlaneGeometry(1.5, 0.3);
    front.translate(0, 1.29, L + 0.022);
    kit.graphic(ATLAS.mark, front);
  }

  private addAxle(z: number, simple: boolean): void {
    const pivot = new THREE.Group();
    pivot.position.set(0, TRANSJAKARTA_DIMENSIONS.wheelRadius, z);
    const kit = new Kit();
    const r = TRANSJAKARTA_DIMENSIONS.wheelRadius;
    for (const s of [1, -1] as const) {
      const x = s * (HW - 0.1);
      const tyre = new THREE.CylinderGeometry(r, r, 0.36, simple ? 8 : 12, 1);
      tyre.rotateZ(Math.PI / 2);
      tyre.translate(x, 0, 0);
      kit.add('matte', tyre, RUBBER);
      const hub = new THREE.CylinderGeometry(r * 0.58, r * 0.58, 0.375, simple ? 8 : 10, 1);
      hub.rotateZ(Math.PI / 2);
      hub.translate(x, 0, 0);
      kit.add('metal', hub, METAL);
      if (!simple) {
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
