import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { canvasTexture, shadowBlob } from '../core/utils';

/**
 * Jakarta ojek — an underbone scooter (Honda Beat / Vario class) with a rider in a green
 * jacket and a full-face helmet, a spare helmet hanging off the left mirror and a delivery
 * box on the rear rack.
 *
 * Reference: reference/assets/kurir-delivery-01.jpg and -02.jpg (CC BY-SA 4.0, Waqas1000000000,
 * via Wikimedia Commons) for the step-through proportions, the green courier kit and the rear
 * mounting of the insulated box. Both are recorded in CREDITS.md; the three ojek stills this
 * header used to name (bang-wandi, green-jacket, terminal-helmets) are not on disk and are not in
 * CREDITS, so nothing here claims to be measured against them.
 *
 * Budget: one ojek is <= 2000 triangles and 11 draw calls, because the street can hold a lot
 * of them. That rules out one mesh per part, so everything is authored into four material
 * buckets (gloss paint, matte cloth/rubber, alloy, and one textured graphic atlas) and merged
 * per bucket. Wheels stay separate so they can spin; the rider is its own pair of merged
 * meshes so it can lean without dragging the bike with it.
 */

const BODY = 0xb4342c;
const BODY_DARK = 0x8d2620;
const BLACK = 0x1c1d22;
const TRIM = 0x141519;
const TYRE = 0x101014;
const ALLOY = 0xb9bec6;
const DARK_METAL = 0x3c3f46;
const SEAT = 0x272a31;
const LENS = 0xe6edf2;
const TAIL_LENS = 0xc4231b;
/**
 * Instant-delivery box. Measured against reference/assets/kurir-delivery-01.jpg: the insulated
 * case stands about one wheel tall on the rack and its lid reaches the seated rider's shoulder,
 * and its face is a plain brand-green panel with a white logo plate. The first pass was a 0.27 m
 * dark case on the rack: it read as a top box (and vanished against the tail) at street distance,
 * and a dark box never says "courier" — green is what does that before any logo.
 */
const BOX_GREEN = 0x00b14f;
const BOX_LID = 0x008f3f;
/** local-space bounds of the cargo box, shared by the build and by the QA capture hook */
const CARGO = { w: 0.42, h: 0.40, d: 0.40, y: 1.104, z: -0.68 };
const JACKET = 0x1e8c4a;
const JACKET_PANEL = 0x146b37;
const PANTS = 0x232630;
const HELMET_DARK = 0x24262b;
const VISOR = 0x36434f;
const SPARE_HELMET = 0xd6dae0;
const SKIN = 0xb07a55;
const SANDAL = 0x3b2e26;
/** the rider figure is authored around the saddle; lifting the whole group seats it on top */
const RIDER_LIFT = 0.05;

type Bucket = 'gloss' | 'matte' | 'metal' | 'graphic';
type Space = 'bike' | 'rider' | 'wheelF' | 'wheelR';

// atlas halves: plate on the left, cowl decal on the right
const ATLAS = { plate: [0, 0], decal: [0.5, 0] };

function graphicTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 64, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    // rear number plate: white field, black characters
    c.fillStyle = '#f2f2ee';
    c.fillRect(2, 8, 60, 46);
    c.strokeStyle = '#1a1a1a';
    c.lineWidth = 1.5;
    c.strokeRect(2, 8, 60, 46);
    c.fillStyle = '#141414';
    c.font = '700 15px ui-sans-serif, system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('B 4891', 32, 24);
    c.fillText('OJK', 32, 41);
    // model decal: yellow swept blade on transparent, so it only shows as a stripe
    c.fillStyle = '#e8c33a';
    c.beginPath();
    c.moveTo(w * 0.58, h * 0.72);
    c.lineTo(w * 0.95, h * 0.30);
    c.lineTo(w * 0.97, h * 0.42);
    c.lineTo(w * 0.62, h * 0.82);
    c.closePath();
    c.fill();
    c.fillStyle = '#20232a';
    c.font = '700 13px ui-sans-serif, system-ui, sans-serif';
    c.fillText('BEAT', w * 0.79, h * 0.40);
  });
}

/** A low-poly box whose top face can be narrower / shallower / shifted back than its base. */
function taperBox(w: number, h: number, d: number, topX = 1, topZ = 1, shearZ = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const f = p.getY(i) / h + 0.5; // 0 at the base, 1 at the top
    const sx = 1 + (topX - 1) * f;
    const sz = 1 + (topZ - 1) * f;
    p.setX(i, p.getX(i) * sx);
    p.setZ(i, p.getZ(i) * sz + shearZ * f);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

function tube(r1: number, r2: number, len: number, seg = 6): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(r2, r1, len, seg, 1, false);
}

/** Places a mesh between two points — used for limbs, forks, mirror stalks and the exhaust. */
function between(a: THREE.Vector3, b: THREE.Vector3): { mid: THREE.Vector3; quat: THREE.Quaternion; len: number } {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  return { mid: new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), quat, len };
}

class Kit {
  private readonly parts = new Map<string, THREE.BufferGeometry[]>();

  add(space: Space, bucket: Bucket, geo: THREE.BufferGeometry, color: number): void {
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
    const key = `${space}:${bucket}`;
    const list = this.parts.get(key);
    if (list) list.push(g);
    else this.parts.set(key, [g]);
  }

  /** Box helper: geometry, bucket, colour, centre, euler rotation. */
  box(
    space: Space,
    bucket: Bucket,
    color: number,
    size: [number, number, number],
    at: [number, number, number],
    rot: [number, number, number] = [0, 0, 0],
    geo?: THREE.BufferGeometry
  ): void {
    const g = geo ?? taperBox(size[0], size[1], size[2]);
    g.rotateX(rot[0]);
    g.rotateY(rot[1]);
    g.rotateZ(rot[2]);
    g.translate(at[0], at[1], at[2]);
    this.add(space, bucket, g, color);
  }

  /** Cylinder between two world-space points. */
  limb(
    space: Space,
    bucket: Bucket,
    color: number,
    a: [number, number, number],
    b: [number, number, number],
    r1: number,
    r2 = r1,
    seg = 6
  ): void {
    const pa = new THREE.Vector3(...a);
    const pb = new THREE.Vector3(...b);
    const { mid, quat, len } = between(pa, pb);
    const g = tube(r1, r2, len, seg);
    g.applyQuaternion(quat);
    g.translate(mid.x, mid.y, mid.z);
    this.add(space, bucket, g, color);
  }

  merge(space: Space, bucket: Bucket): THREE.BufferGeometry | null {
    const list = this.parts.get(`${space}:${bucket}`);
    if (!list || !list.length) return null;
    const merged = mergeGeometries(list, false);
    for (const g of list) g.dispose();
    merged?.computeBoundingSphere();
    return merged;
  }
}

export interface OjekOptions {
  /** jacket colour; the default is the Gojek green of the reference rider */
  jacket?: number;
  /** body paint */
  color?: number;
  /** hang a spare helmet off the left mirror (on by default — it is what makes it read as an ojek) */
  spareHelmet?: boolean;
  /** delivery box on the rear rack */
  cargoBox?: boolean;
}

export class Ojek {
  readonly group = new THREE.Group();
  readonly rider = new THREE.Group();
  /** front wheel first; each pivot spins about local X */
  readonly wheels: { pivot: THREE.Group; front: boolean }[] = [];
  readonly size = { length: 1.86, width: 0.68, height: 1.63 };
  /**
   * Local-space bounds of the delivery box. The box is merged into the bike's gloss bucket for
   * the draw-call budget, so there is no node to query at runtime: this is the handle a capture
   * (or anything else) needs to aim at the box instead of guessing from the prop slot.
   * Null when the bike is built without a box.
   */
  cargoBoxBounds: { center: THREE.Vector3; size: THREE.Vector3 } | null = null;
  private readonly disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];

  constructor(opts: OjekOptions = {}) {
    const paint = opts.color ?? BODY;
    const jacket = opts.jacket ?? JACKET;
    const kit = new Kit();
    const spare = opts.spareHelmet !== false;
    const cargo = opts.cargoBox !== false;

    this.group.name = 'ojek';
    this.buildBike(kit, paint, spare, cargo);
    this.buildRider(kit, jacket);
    this.buildWheels(kit);
    if (cargo) {
      this.cargoBoxBounds = {
        center: new THREE.Vector3(0, CARGO.y, CARGO.z),
        size: new THREE.Vector3(CARGO.w, CARGO.h, CARGO.d),
      };
    }

    // one merged mesh per material bucket — this is what keeps the draw calls down
    const gloss = this.material(0xffffff, { vertexColors: true, roughness: 0.28, metalness: 0.14, flatShading: true });
    const matte = this.material(0xffffff, { vertexColors: true, roughness: 0.88, metalness: 0.02, flatShading: true });
    const metal = this.material(0xffffff, { vertexColors: true, roughness: 0.32, metalness: 0.78, flatShading: true });
    const atlas = this.material(0xffffff, {
      map: graphicTexture(),
      transparent: true,
      roughness: 0.55,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    const buckets: Record<Bucket, THREE.Material> = { gloss, matte, metal, graphic: atlas };

    for (const space of ['bike', 'rider'] as Space[]) {
      for (const bucket of ['gloss', 'matte', 'metal', 'graphic'] as Bucket[]) {
        const geo = kit.merge(space, bucket);
        if (!geo) continue;
        const mesh = new THREE.Mesh(geo, buckets[bucket]);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.disposables.push(geo, buckets[bucket]);
        if (space === 'rider') this.rider.add(mesh);
        else this.group.add(mesh);
      }
    }

    for (const [space, front] of [['wheelF', true], ['wheelR', false]] as [Space, boolean][]) {
      const pivot = new THREE.Group();
      pivot.position.set(0, 0.225, front ? 0.74 : -0.53);
      for (const bucket of ['matte', 'metal'] as Bucket[]) {
        const geo = kit.merge(space, bucket);
        if (!geo) continue;
        const mesh = new THREE.Mesh(geo, buckets[bucket]);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.disposables.push(geo);
        pivot.add(mesh);
      }
      this.group.add(pivot);
      this.wheels.push({ pivot, front });
    }

    // the same soft blob every other vehicle and ped in the game drops on the road
    const blob = shadowBlob(0.78, 1.9, 0.4);
    blob.position.set(0, 0.012, -0.05);
    this.group.add(blob);
    for (const m of [gloss, matte, metal, atlas]) this.disposables.push(m);
    const tex = atlas.map;
    if (tex) this.disposables.push(tex);

    this.rider.position.y = RIDER_LIFT;
    this.group.add(this.rider);
  }

  private material(color: number, params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, ...params });
    this.disposables.push(m);
    return m;
  }

  private buildBike(kit: Kit, paint: number, spare: boolean, cargo: boolean): void {
    const S: Space = 'bike';

    // --- step-through body ---------------------------------------------------------------
    // Apron: raked back 12 deg, narrower at the base, straight top edge at bar height. The
    // footwell in front of it is the single strongest "scooter, not moped" cue.
    // upper leg shield: wider at the top, raked back
    kit.box(S, 'gloss', paint, [0.34, 0.40, 0.14], [0, 0.74, 0.58], [0.12, 0, 0],
      taperBox(0.34, 0.40, 0.14, 1.18, 0.8, -0.06));
    // lower cowl: a separate, forward-leaning black plane — two planes read as a scooter
    // front end, one tall box reads as a slab
    kit.box(S, 'matte', 0x232529, [0.27, 0.20, 0.10], [0, 0.50, 0.625], [0.42, 0, 0],
      taperBox(0.27, 0.20, 0.10, 1.12, 0.8, 0.02));
    kit.box(S, 'matte', TRIM, [0.07, 0.34, 0.04], [0, 0.74, 0.655], [0.12, 0, 0]); // central spine
    // headlamp sits proud of the apron face, wide and low like the reference
    kit.box(S, 'matte', BLACK, [0.235, 0.14, 0.05], [0, 0.815, 0.635], [0.12, 0, 0]); // lamp surround
    kit.box(S, 'gloss', LENS, [0.205, 0.11, 0.045], [0, 0.815, 0.665], [0.12, 0, 0]); // lens
    kit.box(S, 'matte', BLACK, [0.22, 0.02, 0.03], [0, 0.748, 0.672], [0.12, 0, 0]); // lamp brow
    kit.box(S, 'gloss', TAIL_LENS, [0.04, 0.055, 0.03], [0.175, 0.76, 0.645], [0.12, 0, 0]); // indicator L
    kit.box(S, 'gloss', TAIL_LENS, [0.04, 0.055, 0.03], [-0.175, 0.76, 0.645], [0.12, 0, 0]); // indicator R

    // floorboard, low and open, with the side skirts that close the footwell
    kit.box(S, 'matte', BLACK, [0.38, 0.05, 0.46], [0, 0.30, 0.22]);
    kit.box(S, 'matte', BLACK, [0.035, 0.10, 0.44], [0.195, 0.305, 0.22]);
    kit.box(S, 'matte', BLACK, [0.035, 0.10, 0.44], [-0.195, 0.305, 0.22]);
    // heel plate and a floor mat line so the footwell is not one flat slab
    kit.box(S, 'matte', TRIM, [0.30, 0.012, 0.06], [0, 0.327, 0.05]);

    // saddle: rider pad stepped lower and narrower than the pillion pad behind it
    kit.box(S, 'matte', TRIM, [0.31, 0.07, 0.62], [0, 0.755, 0.10]); // saddle base
    kit.box(S, 'matte', SEAT, [0.33, 0.12, 0.50], [0, 0.815, 0.14], [0.02, 0, 0],
      taperBox(0.33, 0.12, 0.50, 0.8, 0.9, 0));
    kit.box(S, 'matte', SEAT, [0.32, 0.12, 0.44], [0, 0.845, -0.32], [0, 0, 0],
      taperBox(0.32, 0.12, 0.44, 0.88, 0.86, 0));

    // rear body: short cowls tucked under the pillion pad, leaving the frame area open
    kit.box(S, 'gloss', paint, [0.09, 0.22, 0.48], [0.225, 0.70, -0.40], [0, 0, 0],
      taperBox(0.09, 0.22, 0.48, 0.78, 0.84, 0));
    kit.box(S, 'gloss', paint, [0.09, 0.22, 0.48], [-0.225, 0.70, -0.40], [0, 0, 0],
      taperBox(0.09, 0.22, 0.48, 0.78, 0.84, 0));
    kit.box(S, 'gloss', paint, [0.26, 0.20, 0.26], [0, 0.73, -0.72], [-0.2, 0, 0],
      taperBox(0.26, 0.20, 0.26, 0.7, 0.8, 0.02)); // tail
    kit.box(S, 'gloss', TAIL_LENS, [0.16, 0.065, 0.035], [0, 0.805, -0.875], [-0.2, 0, 0]);
    kit.box(S, 'matte', BLACK, [0.20, 0.06, 0.20], [0, 0.60, -0.66], [0, 0, 0]); // undertail

    // --- cockpit --------------------------------------------------------------------------
    // handlebar cover above the apron, then the actual bar, grips and levers outside it
    kit.box(S, 'gloss', paint, [0.30, 0.15, 0.22], [0, 0.955, 0.50], [0, 0, 0],
      taperBox(0.30, 0.15, 0.22, 1.14, 0.78, -0.02));
    kit.box(S, 'matte', TRIM, [0.15, 0.065, 0.035], [0, 1.00, 0.405], [-0.4, 0, 0]); // dash
    kit.limb(S, 'metal', ALLOY, [0.11, 0.955, 0.46], [0.30, 0.955, 0.475], 0.017, 0.015, 5);
    kit.limb(S, 'metal', ALLOY, [-0.11, 0.955, 0.46], [-0.30, 0.955, 0.475], 0.017, 0.015, 5);
    kit.limb(S, 'matte', 0x3a3d45, [0.225, 0.955, 0.47], [0.305, 0.955, 0.478], 0.03, 0.03, 6);
    kit.limb(S, 'matte', 0x3a3d45, [-0.225, 0.955, 0.47], [-0.305, 0.955, 0.478], 0.03, 0.03, 6);
    kit.limb(S, 'metal', ALLOY, [0.238, 0.982, 0.50], [0.305, 0.99, 0.565], 0.011, 0.011, 4); // lever
    kit.limb(S, 'metal', ALLOY, [-0.238, 0.982, 0.50], [-0.305, 0.99, 0.565], 0.011, 0.011, 4);
    // mirrors: stalk out of the bar, oval head above and outboard
    kit.limb(S, 'matte', BLACK, [0.255, 0.975, 0.465], [0.315, 1.10, 0.45], 0.012, 0.011, 5);
    kit.limb(S, 'matte', BLACK, [-0.255, 0.975, 0.465], [-0.315, 1.10, 0.45], 0.012, 0.011, 5);
    kit.box(S, 'matte', BLACK, [0.10, 0.07, 0.028], [0.325, 1.115, 0.448], [0, 0, -0.14]);
    kit.box(S, 'matte', BLACK, [0.10, 0.07, 0.028], [-0.325, 1.115, 0.448], [0, 0, 0.14]);

    // front mudguard hugging the tyre, and the fork legs that show below the apron
    kit.box(S, 'gloss', paint, [0.15, 0.075, 0.33], [0, 0.435, 0.775], [0.04, 0, 0],
      taperBox(0.145, 0.075, 0.32, 1, 0.82, 0));
    kit.limb(S, 'metal', ALLOY, [0.072, 0.40, 0.735], [0.072, 0.235, 0.755], 0.026, 0.03, 6);
    kit.limb(S, 'metal', ALLOY, [-0.072, 0.40, 0.735], [-0.072, 0.235, 0.755], 0.026, 0.03, 6);
    kit.limb(S, 'metal', ALLOY, [0, 0.40, 0.74], [0, 0.62, 0.70], 0.03, 0.026, 6); // steering stem

    // --- drivetrain -----------------------------------------------------------------------
    // compact engine low and rearward: the open triangle under the seat is what reads as
    // an underbone frame rather than a solid moped body
    kit.box(S, 'matte', DARK_METAL, [0.15, 0.20, 0.26], [0.085, 0.31, -0.52], [0, 0, 0],
      taperBox(0.15, 0.20, 0.26, 0.84, 0.9, 0));
    kit.limb(S, 'metal', DARK_METAL, [0.115, 0.28, -0.44], [0.115, 0.245, -0.60], 0.036, 0.044, 6); // swingarm
    kit.limb(S, 'metal', DARK_METAL, [0.185, 0.26, -0.76], [0.185, 0.25, -0.52], 0.052, 0.056, 7); // muffler
    kit.limb(S, 'metal', ALLOY, [0.185, 0.25, -0.52], [0.185, 0.248, -0.47], 0.05, 0.042, 7); // heat shield
    kit.limb(S, 'metal', ALLOY, [0.135, 0.70, -0.30], [0.155, 0.32, -0.48], 0.017, 0.017, 5); // rear shock
    kit.box(S, 'matte', BLACK, [0.15, 0.04, 0.20], [0, 0.54, -0.60], [0.35, 0, 0]); // rear hugger

    // --- ojek kit: rack + cargo box + spare helmet ---------------------------------------
    if (cargo) {
      // tubular rack: rails on legs, so the box sits on something in the silhouette
      kit.limb(S, 'metal', ALLOY, [0.165, 0.885, -0.42], [0.165, 0.885, -0.87], 0.019, 0.019, 5);
      kit.limb(S, 'metal', ALLOY, [-0.165, 0.885, -0.42], [-0.165, 0.885, -0.87], 0.019, 0.019, 5);
      kit.limb(S, 'metal', ALLOY, [0.165, 0.885, -0.86], [-0.165, 0.885, -0.86], 0.019, 0.019, 5);
      kit.box(S, 'metal', ALLOY, [CARGO.w, 0.018, CARGO.d + 0.06], [0, 0.895, CARGO.z + 0.02]); // rack platform
      kit.limb(S, 'metal', ALLOY, [0.165, 0.885, -0.45], [0.15, 0.775, -0.56], 0.019, 0.019, 5); // leg L
      kit.limb(S, 'metal', ALLOY, [-0.165, 0.885, -0.45], [-0.15, 0.775, -0.56], 0.019, 0.019, 5); // leg R
      kit.limb(S, 'metal', BLACK, [0.125, 0.885, -0.49], [-0.125, 0.885, -0.49], 0.018, 0.018, 5);
      // insulated case: as wide as the rear body, lid up at the seated rider's shoulder
      kit.box(S, 'gloss', BOX_GREEN, [CARGO.w, CARGO.h, CARGO.d], [0, CARGO.y, CARGO.z], [0, 0, 0],
        taperBox(CARGO.w, CARGO.h, CARGO.d, 0.97, 0.95, 0));
      kit.box(S, 'gloss', BOX_LID, [CARGO.w + 0.012, 0.045, CARGO.d + 0.012], [0, CARGO.y + CARGO.h / 2 + 0.02, CARGO.z]); // lid
      kit.box(S, 'matte', TRIM, [0.055, 0.028, CARGO.d + 0.03], [0, CARGO.y + CARGO.h / 2 + 0.048, CARGO.z]); // strap over the lid
      // white logo plate on each flank (the ref box is mostly this plate), reflective band low on the rear face
      kit.box(S, 'matte', 0xe4e8e6, [0.008, 0.17, 0.26], [CARGO.w / 2 + 0.003, CARGO.y + 0.015, CARGO.z]);
      kit.box(S, 'matte', 0xe4e8e6, [0.008, 0.17, 0.26], [-CARGO.w / 2 - 0.003, CARGO.y + 0.015, CARGO.z]);
      kit.box(S, 'matte', 0xd8dde0, [0.28, 0.05, 0.008], [0, CARGO.y - 0.14, CARGO.z - CARGO.d / 2 - 0.003]);
    }
    if (spare) {
      // half-shell lid hooked over the left mirror stalk and hanging beside the leg shield
      const shell = new THREE.SphereGeometry(0.098, 8, 5);
      shell.scale(1, 0.92, 1.06);
      kit.box(S, 'gloss', SPARE_HELMET, [0.214, 0.19, 0.21], [0.315, 0.80, 0.60], [0.16, 0, 0.05], shell);
      kit.box(S, 'matte', TRIM, [0.212, 0.026, 0.04], [0.315, 0.717, 0.60], [0.16, 0, 0.05]); // rim
      // the opening faces outboard: a dark ellipse with a pale lip is what says "helmet"
      kit.box(S, 'matte', 0x111216, [0.03, 0.13, 0.145], [0.404, 0.795, 0.61], [0.16, 0, 0.05]);
      kit.limb(S, 'gloss', SPARE_HELMET, [0.402, 0.80, 0.60], [0.402, 0.80, 0.70], 0.012, 0.012, 4);
      kit.box(S, 'gloss', VISOR, [0.012, 0.05, 0.09], [0.41, 0.845, 0.66], [0.16, 0, 0.05]); // visor slot
      kit.limb(S, 'matte', BLACK, [0.315, 0.89, 0.60], [0.312, 0.985, 0.475], 0.012, 0.012, 4); // strap
    }

    // --- graphics: cowl decals both sides, rear plate, front plate ------------------------
    const decalL = new THREE.PlaneGeometry(0.30, 0.13);
    decalL.rotateY(Math.PI / 2);
    decalL.translate(0.272, 0.665, -0.42);
    this.setAtlasUv(decalL, ATLAS.decal, [0.5, 1]);
    kit.add(S, 'graphic', decalL, 0xffffff);
    const decalR = new THREE.PlaneGeometry(0.30, 0.13);
    decalR.rotateY(-Math.PI / 2);
    decalR.translate(-0.272, 0.665, -0.42);
    this.setAtlasUv(decalR, ATLAS.decal, [0.5, 1]);
    kit.add(S, 'graphic', decalR, 0xffffff);
    const plate = new THREE.PlaneGeometry(0.19, 0.115);
    plate.rotateY(Math.PI);
    plate.translate(0, 0.63, -0.885);
    this.setAtlasUv(plate, ATLAS.plate, [0, 0.5]);
    kit.add(S, 'graphic', plate, 0xffffff);
    const frontPlate = new THREE.PlaneGeometry(0.15, 0.09);
    frontPlate.rotateY(0);
    frontPlate.rotateX(-0.4);
    frontPlate.translate(0, 0.50, 0.675);
    this.setAtlasUv(frontPlate, ATLAS.plate, [0, 0.5]);
    kit.add(S, 'graphic', frontPlate, 0xffffff);
  }

  private buildRider(kit: Kit, jacket: number): void {
    const R: Space = 'rider';
    // hips on the saddle, torso pitched 12 degrees into the wind
    kit.box(R, 'matte', PANTS, [0.30, 0.19, 0.28], [0, 0.875, 0.03]);
    kit.box(R, 'gloss', jacket, [0.38, 0.46, 0.26], [0, 1.10, 0.06], [0.16, 0, 0], taperBox(0.38, 0.46, 0.26, 1.06, 0.92, 0));
    kit.box(R, 'matte', JACKET_PANEL, [0.30, 0.26, 0.02], [0, 1.12, -0.075], [0.16, 0, 0]); // back panel
    kit.box(R, 'gloss', 0xd0d4d8, [0.26, 0.035, 0.02], [0, 1.20, -0.09], [0.16, 0, 0]); // reflective stripe
    kit.limb(R, 'matte', SKIN, [0, 1.315, 0.10], [0, 1.375, 0.10], 0.048, 0.045, 6); // neck

    // helmet: shell, chin bar, visor band. 0.235 wide on a 0.40 shoulder span is a real
    // helmet-to-shoulder ratio, and the visor has to sit proud of the shell or it vanishes.
    const shell = new THREE.SphereGeometry(0.117, 9, 6);
    shell.scale(1, 1.05, 1.03);
    kit.box(R, 'gloss', HELMET_DARK, [0.234, 0.246, 0.24], [0, 1.475, 0.095], [0, 0, 0], shell);
    kit.box(R, 'gloss', HELMET_DARK, [0.185, 0.085, 0.09], [0, 1.425, 0.165], [0.1, 0, 0]); // chin bar
    kit.box(R, 'gloss', VISOR, [0.19, 0.085, 0.035], [0, 1.492, 0.185], [0.1, 0, 0],
      taperBox(0.19, 0.085, 0.035, 0.92, 0.92, -0.008));

    // arms: shoulders -> elbows -> wrists on the grips
    for (const s of [1, -1]) {
      kit.limb(R, 'gloss', jacket, [s * 0.185, 1.275, 0.075], [s * 0.245, 1.075, 0.26], 0.062, 0.052, 6);
      kit.limb(R, 'gloss', jacket, [s * 0.245, 1.075, 0.26], [s * 0.275, 0.965, 0.445], 0.05, 0.044, 6);
      kit.box(R, 'matte', 0x26292f, [0.088, 0.07, 0.082], [s * 0.274, 0.962, 0.478], [0, 0, 0]);
      kit.limb(R, 'gloss', JACKET, [s * 0.268, 0.975, 0.455], [s * 0.262, 1.005, 0.44], 0.042, 0.045, 5); // cuff
      kit.box(R, 'gloss', jacket, [0.10, 0.10, 0.07], [s * 0.195, 1.265, 0.075]); // shoulder cap
    }

    // legs: knees forward onto the footwell, feet flat on the floorboard
    for (const s of [1, -1]) {
      kit.limb(R, 'matte', PANTS, [s * 0.145, 0.865, 0.06], [s * 0.175, 0.705, 0.28], 0.082, 0.07, 6);
      kit.limb(R, 'matte', PANTS, [s * 0.175, 0.705, 0.28], [s * 0.185, 0.395, 0.30], 0.06, 0.048, 6);
      kit.box(R, 'matte', SANDAL, [0.098, 0.055, 0.215], [s * 0.185, 0.355, 0.345], [0, 0, 0], taperBox(0.10, 0.06, 0.23, 0.9, 0.85, 0));
    }
  }

  private buildWheels(kit: Kit): void {
    const build = (space: Space, width: number) => {
      const tyre = new THREE.TorusGeometry(0.155, 0.07, 4, 14);
      tyre.rotateY(Math.PI / 2);
      kit.add(space, 'matte', tyre, TYRE);
      const rim = new THREE.CylinderGeometry(0.145, 0.145, width * 0.55, 10);
      rim.rotateZ(Math.PI / 2);
      kit.add(space, 'metal', rim, ALLOY);
      const hub = new THREE.CylinderGeometry(0.042, 0.042, width, 8);
      hub.rotateZ(Math.PI / 2);
      kit.add(space, 'metal', hub, DARK_METAL);
      // three flat spokes per side, cheap and enough to read as a cast wheel
      for (let i = 0; i < 3; i++) {
        const spoke = new THREE.BoxGeometry(width * 0.5, 0.10, 0.026);
        spoke.rotateX((i * Math.PI) / 3);
        kit.add(space, 'metal', spoke, ALLOY);
      }
    };
    build('wheelF', 0.09);
    build('wheelR', 0.11);
    // front brake disc sits outboard on the axle
    const disc = new THREE.CylinderGeometry(0.105, 0.105, 0.008, 10);
    disc.rotateZ(Math.PI / 2);
    disc.translate(0.055, 0, 0);
    kit.add('wheelF', 'metal', disc, DARK_METAL);
  }

  private setAtlasUv(geo: THREE.BufferGeometry, origin: number[], size: [number, number]): void {
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, origin[0] + uv.getX(i) * size[0], origin[1] + uv.getY(i) * size[1]);
    }
    uv.needsUpdate = true;
  }

  /** Idle life: wheels roll with distance covered, rider breathes and leans a touch. */
  update(dt: number, speed = 0, time = 0): void {
    const spin = (speed * dt) / 0.225;
    for (const w of this.wheels) w.pivot.rotation.x += spin;
    const lean = Math.sin(time * 0.9) * 0.008;
    this.rider.rotation.z = lean;
    this.rider.position.y = RIDER_LIFT + Math.sin(time * 1.6) * 0.004;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

export function createOjek(opts: OjekOptions = {}): Ojek {
  return new Ojek(opts);
}
