import * as THREE from 'three';
import { canvasTexture, roundedBox, shadowBlob } from '../core/utils';

/**
 * Jakarta bajaj — the three-wheeled orange auto-rickshaw that works the city's side streets.
 *
 * Reconstructed from two CC BY-SA 3.0 photographs (reference/assets/bajaj-gladok.jpg for the
 * front three-quarter, colours and trim; bajaj-street.jpg for the side proportions). Everything
 * is procedural: no GLB, no image assets — lathe, extrude, tube and canvas-drawn decals only.
 *
 * Frame: +Z forward, +Y up, origin on the road between the rear wheels, so the group drops
 * straight onto a road surface. One steered wheel on the centreline at z = +0.98, two rear
 * wheels at z = -0.82. That asymmetry is the whole silhouette: nothing here may break it.
 *
 * The body is two 100 mm side walls with a real aperture cut through each, plus a floor, a
 * dash bulkhead and a roof panel. A bajaj is doorless on both sides, so the cab has to be a
 * real hollow volume — extruding one solid slab leaves you looking at an orange wall.
 */

export const BAJAJ_DIMENSIONS = {
  /** nose to tail, metres */
  length: 2.62,
  /** widest point of the body, across the flanks */
  width: 1.3,
  /** road to the crown of the canvas canopy */
  height: 1.67,
  /** front axle to rear axle */
  wheelbase: 1.8,
  wheelRadius: 0.25,
  frontAxleZ: 0.98,
  rearAxleZ: -0.82,
  rearTrack: 1.2,
  /** arcade mass factor, roughly half a sedan */
  mass: 0.55,
} as const;

const PAINT = 0xe4571c;
const CANVAS = 0x1b1b1e;
const TRIM = 0x151518;
const CHROME = 0xc9cdd3;
const STEEL = 0x8e9299;
const TYRE = 0x141416;
const VINYL = 0x2b2a33;
const LENS = 0xf6efd2;
const LAMP_RED = 0xb4231c;

const W = BAJAJ_DIMENSIONS.width;
/** underside of the body sides */
const FLOOR = 0.34;
/** top of the body sides, where the canopy frame starts */
const SHOULDER = 1.4;
/** bottom edge of the doorless aperture */
const SILL = 0.55;
const FRONT_AXLE = BAJAJ_DIMENSIONS.frontAxleZ;
const REAR_AXLE = BAJAJ_DIMENSIONS.rearAxleZ;
const WHEEL_R = BAJAJ_DIMENSIONS.wheelRadius;
/** centre of the front cowl, and how shallow it is in Z versus X */
const COWL_Z = 0.955;
const COWL_ZSCALE = 0.52;

export interface BajajOptions {
  /** skip the small parts (spokes, vents, wipers, instrument) for background traffic */
  simple?: boolean;
  /** road-blob shadow under the vehicle; off when the scene uses real shadow maps */
  blob?: boolean;
  /** registration plate text */
  plate?: string;
}

interface WheelPart {
  /** steering / spin pivot: rotate this to animate the wheel */
  pivot: THREE.Group;
  /** the tyre mesh itself, spun about X */
  wheel: THREE.Object3D;
  front: boolean;
}

/** Rounded polygon path, corners eased with a quadratic of the given radius. */
function roundedPolygon(points: [number, number][], radius: number): THREE.Shape {
  const shape = new THREE.Shape();
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const cur = points[i];
    const next = points[(i + 1) % n];
    const inDir = new THREE.Vector2(prev[0] - cur[0], prev[1] - cur[1]).normalize();
    const outDir = new THREE.Vector2(next[0] - cur[0], next[1] - cur[1]).normalize();
    const a = new THREE.Vector2(cur[0] + inDir.x * radius, cur[1] + inDir.y * radius);
    const b = new THREE.Vector2(cur[0] + outDir.x * radius, cur[1] + outDir.y * radius);
    if (i === 0) shape.moveTo(a.x, a.y);
    else shape.lineTo(a.x, a.y);
    shape.quadraticCurveTo(cur[0], cur[1], b.x, b.y);
  }
  shape.closePath();
  return shape;
}

/**
 * Annular sector in the (z, y) plane, extruded along X. Mudguard, arch lips.
 * Angles are measured from +Z, so 0..PI is the upper half over a wheel.
 */
function archStrip(
  zc: number,
  yc: number,
  outer: number,
  inner: number,
  from: number,
  to: number,
  width: number
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    const z = zc + Math.cos(a) * outer;
    const y = yc + Math.sin(a) * outer;
    if (i === 0) shape.moveTo(z, y);
    else shape.lineTo(z, y);
  }
  for (let i = steps; i >= 0; i--) {
    const a = from + ((to - from) * i) / steps;
    shape.lineTo(zc + Math.cos(a) * inner, yc + Math.sin(a) * inner);
  }
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false, curveSegments: 4 });
  geo.rotateY(-Math.PI / 2);
  geo.translate(width / 2, 0, 0);
  return geo;
}

/** Front cowl section, radius against height. Index 0 and last collapse to a point. */
const COWL_PROFILE: [number, number][] = [
  [0.0, 0.47],
  [0.34, 0.47],
  [0.5, 0.52],
  [0.585, 0.62],
  [0.62, 0.76],
  [0.625, 0.88],
  [0.6, 0.97],
  [0.52, 1.028],
  [0.34, 1.055],
  [0.0, 1.06],
];

/**
 * Surface of revolution with a superellipse cross-section instead of a circle: a squircle of
 * squareness 2.6 has a broad, nearly flat face that rounds off hard at the corners, which is
 * what a bajaj shield looks like. A circular lathe of the same profile reads as an egg.
 */
function shieldGeometry(
  profile: [number, number][],
  zScale: number,
  squareness = 4.0,
  segments = 32
): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const exponent = 2 / squareness;
  for (const [r, y] of profile) {
    for (let j = 0; j < segments; j++) {
      const t = (j / segments) * Math.PI * 2;
      const ct = Math.cos(t);
      const st = Math.sin(t);
      positions.push(
        r * Math.sign(ct) * Math.abs(ct) ** exponent,
        y,
        r * Math.sign(st) * Math.abs(st) ** exponent * zScale
      );
    }
  }
  for (let i = 0; i < profile.length - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * segments + j;
      const b = i * segments + ((j + 1) % segments);
      const c = (i + 1) * segments + j;
      const d = (i + 1) * segments + ((j + 1) % segments);
      // wound so the normals face outward; the closed end rings sit at the profile extremes
      indices.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Radius of the cowl at a given height, linearly interpolated over the profile. */
function cowlRadiusAt(y: number): number {
  for (let i = 1; i < COWL_PROFILE.length; i++) {
    const [r1, y1] = COWL_PROFILE[i];
    const [r0, y0] = COWL_PROFILE[i - 1];
    if (y <= y1) {
      const t = (y - y0) / Math.max(1e-6, y1 - y0);
      return r0 + (r1 - r0) * THREE.MathUtils.clamp(t, 0, 1);
    }
  }
  return 0;
}

/** Front surface of the cowl at (x, y): where a lamp, plate or vent has to sit to be seen. */
function cowlSurfaceZ(x: number, y: number, inset = 0): number {
  const r = cowlRadiusAt(y);
  if (r <= 0.001) return COWL_Z;
  const exponent = 2 / 4.0;
  const c = Math.min(1, Math.abs(x) / r) ** (1 / exponent);
  const s = Math.sqrt(Math.max(0, 1 - c * c));
  return COWL_Z + r * s ** exponent * COWL_ZSCALE - inset;
}

/** Cylinder between two points — pillars, struts, fork legs, exhaust. */
function strut(a: THREE.Vector3, b: THREE.Vector3, radius: number, segments = 7): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const geo = new THREE.CylinderGeometry(radius, radius, len, segments, 1);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  geo.applyQuaternion(q);
  geo.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return geo;
}

export class Bajaj {
  readonly root: THREE.Group;
  readonly wheels: WheelPart[] = [];
  readonly dimensions = BAJAJ_DIMENSIONS;

  private readonly simple: boolean;
  private readonly materials: Record<string, THREE.MeshStandardMaterial> = {};
  private readonly geometries: THREE.BufferGeometry[] = [];
  private steerPivot: THREE.Group | null = null;
  private steer = 0;

  constructor(opts: BajajOptions = {}) {
    this.simple = opts.simple ?? false;
    this.root = new THREE.Group();
    this.root.name = 'bajaj';
    this.buildMaterials();
    this.build(opts);
  }

  private buildMaterials() {
    const std = (
      color: number,
      roughness: number,
      metalness: number,
      extra: Partial<THREE.MeshStandardMaterialParameters> = {}
    ) => new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });

    this.materials.paint = std(PAINT, 0.38, 0.16);
    this.materials.canvas = std(CANVAS, 0.94, 0.02);
    this.materials.trim = std(TRIM, 0.74, 0.1);
    this.materials.chrome = std(CHROME, 0.26, 0.85);
    this.materials.steel = std(STEEL, 0.48, 0.6);
    this.materials.tyre = std(TYRE, 0.94, 0.0);
    this.materials.vinyl = std(VINYL, 0.8, 0.05);
    this.materials.lens = std(LENS, 0.12, 0.3, { emissive: 0xfff2cf, emissiveIntensity: 0.16 });
    this.materials.tail = std(LAMP_RED, 0.32, 0.1, { emissive: 0x6d120c, emissiveIntensity: 0.4 });
    // open cylinder arc for the centre panel, so it needs both faces
    this.materials.panel = std(TRIM, 0.74, 0.1, { side: THREE.DoubleSide });
    this.materials.glass = new THREE.MeshStandardMaterial({
      color: 0xd2e4ee,
      roughness: 0.07,
      metalness: 0.12,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    });
  }

  private track<T extends THREE.BufferGeometry>(geo: T): T {
    this.geometries.push(geo);
    return geo;
  }

  /** Mesh helper: keeps shadow flags and parenting boilerplate out of the build code. */
  private mesh(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    parent: THREE.Object3D,
    pos: [number, number, number] = [0, 0, 0],
    rot: [number, number, number] = [0, 0, 0]
  ): THREE.Mesh {
    const m = new THREE.Mesh(this.track(geo), mat);
    m.position.set(pos[0], pos[1], pos[2]);
    m.rotation.set(rot[0], rot[1], rot[2]);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  /** Side silhouette with the doorless aperture cut through it and the rear wheel arch. */
  private sideWallGeometry(): THREE.BufferGeometry {
    const shape = new THREE.Shape();
    shape.moveTo(0.42, FLOOR);
    shape.lineTo(0.58, FLOOR + 0.12);
    shape.lineTo(0.66, 1.02);
    shape.lineTo(0.6, SHOULDER);
    shape.lineTo(-1.18, SHOULDER);
    shape.lineTo(-1.26, 1.3);
    shape.lineTo(-1.26, 0.44);
    shape.lineTo(-1.15, FLOOR);
    // arch over the rear wheel: the tyre sits in this opening, it does not float on the panel
    shape.absarc(REAR_AXLE, WHEEL_R, 0.34, (165 * Math.PI) / 180, (15 * Math.PI) / 180, true);
    shape.lineTo(0.42, FLOOR);

    const aperture: [number, number][] = [
      [0.34, 1.3],
      [-0.74, 1.3],
      [-0.74, SILL],
      [0.44, SILL],
    ];
    shape.holes.push(roundedPolygon(aperture, 0.07));

    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: 0.1,
      bevelEnabled: true,
      bevelSize: 0.012,
      bevelThickness: 0.012,
      bevelSegments: 2,
      curveSegments: 5,
    });
    geo.rotateY(-Math.PI / 2);
    geo.translate(0.1, 0, 0);
    return geo;
  }

  private build(opts: BajajOptions) {
    const root = this.root;
    const paint = this.materials.paint;
    const trimMat = this.materials.trim;

    const body = new THREE.Group();
    body.name = 'body';
    root.add(body);

    // ---------------------------------------------------------------- side walls
    const wallGeo = this.sideWallGeometry();
    for (const sx of [-1, 1]) {
      this.mesh(wallGeo, paint, body, [sx > 0 ? 0.55 : -0.65, 0, 0]);
    }

    // cab structure between the walls: roof panel, floor, front bulkhead, sill band
    this.mesh(roundedBox(1.14, 0.07, 1.84, 0.02, 1), paint, body, [0, 1.365, -0.27]);
    this.mesh(roundedBox(1.14, 0.12, 1.86, 0.02, 1), paint, body, [0, 0.4, -0.27]);
    this.mesh(roundedBox(1.16, 0.76, 0.1, 0.03, 1), paint, body, [0, 0.68, 0.62]);
    this.mesh(roundedBox(1.08, 0.04, 1.5, 0.015, 1), this.materials.vinyl, body, [0, 0.47, -0.24]);
    this.mesh(roundedBox(1.1, 0.03, 1.7, 0.01, 1), this.materials.vinyl, body, [0, 1.325, -0.27]);

    // black rocker strip along the sill line
    for (const sx of [-1, 1]) {
      this.mesh(roundedBox(0.045, 0.06, 1.6, 0.012, 1), trimMat, body, [sx * 0.655, 0.375, -0.34]);
    }

    // ---------------------------------------------------------------- front cowl
    const cowl = new THREE.Group();
    cowl.name = 'front-cowl';
    body.add(cowl);

    // wide shield at lamp height, tapering hard to the wheel
    const cowlGeo = shieldGeometry(COWL_PROFILE, COWL_ZSCALE);
    this.mesh(cowlGeo, paint, cowl, [0, 0, COWL_Z]);

    // black centre panel splitting the shield, following the cowl's curvature
    const panelGeo = new THREE.CylinderGeometry(0.627, 0.5, 0.56, 10, 1, true, -0.14, 0.28);
    panelGeo.scale(1, 1, COWL_ZSCALE);
    const panel = this.mesh(panelGeo, this.materials.panel, cowl, [0, 0.79, COWL_Z]);
    panel.castShadow = false;

    // vent slits low on the face, and the black apron closing the nose underneath
    if (!this.simple) {
      for (let i = 0; i < 3; i++) {
        const y = 0.6 + i * 0.055;
        for (const sx of [-1, 1]) {
          this.mesh(new THREE.BoxGeometry(0.12, 0.016, 0.03), trimMat, cowl, [sx * 0.21, y, cowlSurfaceZ(0.21, y, 0.006)]);
        }
      }
    }
    this.mesh(roundedBox(0.4, 0.12, 0.26, 0.035, 1), trimMat, cowl, [0, 0.41, 1.08]);
    this.mesh(roundedBox(0.44, 0.11, 0.13, 0.03, 1), trimMat, cowl, [0, 0.32, 1.21]);

    // yellow commercial plate with black characters, above the lamps
    const plateTex = canvasTexture(256, 96, (c, cw, ch) => {
      c.fillStyle = '#e8c43a';
      c.fillRect(0, 0, cw, ch);
      c.strokeStyle = '#151518';
      c.lineWidth = 5;
      c.strokeRect(6, 6, cw - 12, ch - 12);
      c.fillStyle = '#151518';
      c.font = '700 50px ui-monospace, Menlo, monospace';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(opts.plate ?? 'B 2718 BJJ', cw / 2, ch / 2 + 2);
    });
    const plateMat = new THREE.MeshStandardMaterial({ map: plateTex, roughness: 0.55, metalness: 0.05 });
    this.mesh(roundedBox(0.32, 0.13, 0.035, 0.01, 1), trimMat, cowl, [0, 0.93, cowlSurfaceZ(0, 0.93, -0.028)]);
    this.mesh(new THREE.PlaneGeometry(0.3, 0.11), plateMat, cowl, [0, 0.93, cowlSurfaceZ(0, 0.93, -0.048)]);

    // round headlamps on chrome bezels, angled with the shield, indicators below
    for (const sx of [-1, 1]) {
      const lamp = new THREE.Group();
      lamp.position.set(sx * 0.29, 0.79, cowlSurfaceZ(0.29, 0.79, 0.012));
      lamp.rotation.y = sx * 0.36;
      cowl.add(lamp);
      this.mesh(new THREE.CylinderGeometry(0.098, 0.098, 0.045, 18), this.materials.chrome, lamp, [0, 0, 0], [Math.PI / 2, 0, 0]);
      this.mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.05, 18), this.materials.lens, lamp, [0, 0, 0.012], [Math.PI / 2, 0, 0]);
      this.mesh(new THREE.TorusGeometry(0.072, 0.006, 5, 18), this.materials.trim, lamp, [0, 0, 0.03]);
      this.mesh(new THREE.TorusGeometry(0.096, 0.012, 6, 18), this.materials.chrome, lamp, [0, 0, 0.026]);

      const ind = new THREE.Group();
      ind.position.set(sx * 0.32, 0.62, cowlSurfaceZ(0.32, 0.62, -0.012));
      ind.rotation.y = sx * 0.4;
      cowl.add(ind);
      this.mesh(new THREE.CylinderGeometry(0.046, 0.046, 0.03, 12), this.materials.chrome, ind, [0, 0, 0], [Math.PI / 2, 0, 0]);
      this.mesh(new THREE.CylinderGeometry(0.037, 0.037, 0.035, 12), this.materials.lens, ind, [0, 0, 0.008], [Math.PI / 2, 0, 0]);
    }

    // brow: the cowl's top edge, visible as a lip where the shield meets the screen base
    this.mesh(roundedBox(1.02, 0.05, 0.18, 0.02, 2), paint, cowl, [0, 1.03, 0.63], [0.16, 0, 0]);
    // horizontal panel seam across the shield, the reference has a clear press line here
    this.mesh(new THREE.BoxGeometry(0.92, 0.012, 0.02), trimMat, cowl, [0, 0.96, cowlSurfaceZ(0, 0.96, 0.004)]);

    // front mudguard: an arc over the tyre with a black rubber lip on its trailing edge
    const mud = this.mesh(archStrip(FRONT_AXLE, WHEEL_R, 0.35, 0.295, 0.1 * Math.PI, 0.9 * Math.PI, 0.2), paint, cowl);
    mud.name = 'front-mudguard';
    this.mesh(archStrip(FRONT_AXLE, WHEEL_R, 0.357, 0.34, 0.16 * Math.PI, 0.84 * Math.PI, 0.215), trimMat, cowl);

    // ---------------------------------------------------------------- windshield
    const glassGroup = new THREE.Group();
    glassGroup.name = 'windshield';
    body.add(glassGroup);
    const screenPts: [number, number][] = [
      [-0.55, 0],
      [0.55, 0],
      [0.525, 0.5],
      [-0.525, 0.5],
    ];
    const sealPts: [number, number][] = [
      [-0.59, -0.04],
      [0.59, -0.04],
      [0.565, 0.53],
      [-0.565, 0.53],
    ];
    // the seal is a frame, not a filled slab: extruding the outer outline solid puts a black
    // panel in front of the glass and the windscreen reads opaque from every angle
    const sealShape = roundedPolygon(sealPts, 0.06);
    sealShape.holes.push(roundedPolygon(screenPts, 0.05));
    const sealGeo = new THREE.ExtrudeGeometry(sealShape, { depth: 0.03, bevelEnabled: false, curveSegments: 5 });
    this.mesh(sealGeo, trimMat, glassGroup, [0, 1.04, 0.665], [-0.25, 0, 0]);
    const glassGeo = new THREE.ExtrudeGeometry(roundedPolygon(screenPts, 0.05), { depth: 0.008, bevelEnabled: false, curveSegments: 5 });
    const glass = this.mesh(glassGeo, this.materials.glass, glassGroup, [0, 1.06, 0.695], [-0.25, 0, 0]);
    glass.castShadow = false;
    glass.renderOrder = 2;

    // header rail, wiper and the permit sticker
    this.mesh(roundedBox(1.16, 0.05, 0.08, 0.015, 1), trimMat, glassGroup, [0, 1.55, 0.575], [-0.25, 0, 0]);
    if (!this.simple) {
      this.mesh(new THREE.BoxGeometry(0.42, 0.012, 0.016), trimMat, glassGroup, [0.12, 1.075, 0.7], [0, 0, -0.05]);
      this.mesh(new THREE.PlaneGeometry(0.07, 0.06), new THREE.MeshStandardMaterial({ color: 0xf2f2ec, roughness: 0.8 }), glassGroup, [-0.33, 1.45, 0.63], [-0.25, 0, 0]);
    }

    // ---------------------------------------------------------------- canopy
    const canopy = new THREE.Group();
    canopy.name = 'canopy';
    body.add(canopy);

    const canopyGeo = roundedBox(1.4, 0.06, 1.94, 0.085, 4);
    {
      const pos = canopyGeo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        const crown = 0.05 * Math.max(0, 1 - (x / 0.7) ** 2) * Math.max(0, 1 - (z / 0.97) ** 2);
        pos.setY(i, pos.getY(i) + crown);
      }
      pos.needsUpdate = true;
      canopyGeo.computeVertexNormals();
    }
    this.mesh(canopyGeo, this.materials.canvas, canopy, [0, 1.575, -0.27]);

    // centre seam following the crown
    {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 6; i++) {
        const z = 0.67 - (i / 6) * 1.88;
        const crown = 0.05 * Math.max(0, 1 - ((z + 0.27) / 0.97) ** 2);
        pts.push(new THREE.Vector3(0, 1.612 + crown, z));
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      this.mesh(new THREE.TubeGeometry(curve, 10, 0.011, 4, false), this.materials.canvas, canopy);
    }

    // two frame ribs pressing up through the canvas, the giveaway that the roof is fabric
    for (const zRib of [0.18, -0.72]) {
      const ribs: THREE.Vector3[] = [];
      for (let i = 0; i <= 4; i++) {
        const x = -0.66 + (i / 4) * 1.32;
        const crown = 0.05 * Math.max(0, 1 - (x / 0.7) ** 2) * Math.max(0, 1 - ((zRib + 0.27) / 0.97) ** 2);
        ribs.push(new THREE.Vector3(x, 1.605 + crown, zRib));
      }
      this.mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ribs), 8, 0.016, 4, false), this.materials.canvas, canopy);
    }

    // visor lip over the header, canopy side skirts and the black tube frame
    this.mesh(roundedBox(1.36, 0.024, 0.1, 0.01, 1), this.materials.canvas, canopy, [0, 1.59, 0.66], [0.14, 0, 0]);
    for (const sx of [-1, 1]) {
      this.mesh(roundedBox(0.018, 0.05, 1.88, 0.007, 1), this.materials.canvas, canopy, [sx * 0.69, 1.555, -0.27]);
      // canvas valance: the soft top hangs down to the shoulder, it is not a floating slab
      this.mesh(roundedBox(0.02, 0.11, 1.7, 0.008, 1), this.materials.canvas, canopy, [sx * 0.678, 1.485, -0.26]);
      this.mesh(strut(new THREE.Vector3(sx * 0.6, 1.36, 0.615), new THREE.Vector3(sx * 0.665, 1.565, 0.63), 0.021), trimMat, canopy);
      this.mesh(strut(new THREE.Vector3(sx * 0.6, 1.34, -1.04), new THREE.Vector3(sx * 0.66, 1.565, -1.1), 0.025), trimMat, canopy);
      this.mesh(strut(new THREE.Vector3(sx * 0.665, 1.57, 0.62), new THREE.Vector3(sx * 0.665, 1.57, -1.1), 0.017), trimMat, canopy);
    }

    // ---------------------------------------------------------------- aperture beading
    const beadShape = roundedPolygon(
      [
        [0.34, 1.3],
        [-0.74, 1.3],
        [-0.74, SILL],
        [0.44, SILL],
      ],
      0.07
    );
    const beadInner = roundedPolygon(
      [
        [0.305, 1.27],
        [-0.705, 1.27],
        [-0.705, SILL + 0.03],
        [0.41, SILL + 0.03],
      ],
      0.06
    );
    beadShape.holes.push(beadInner);
    const beadGeo = new THREE.ExtrudeGeometry(beadShape, { depth: 0.022, bevelEnabled: false, curveSegments: 5 });
    beadGeo.rotateY(-Math.PI / 2);
    beadGeo.translate(0.011, 0, 0);
    for (const sx of [-1, 1]) {
      this.mesh(beadGeo, trimMat, body, [sx > 0 ? 0.638 : -0.66, 0, 0]);
    }

    // ---------------------------------------------------------------- interior
    const interior = new THREE.Group();
    interior.name = 'cab';
    body.add(interior);
    // rear bench, driver squab (right-hand drive: driver sits at -X), back bulkhead card
    this.mesh(roundedBox(0.98, 0.13, 0.4, 0.035, 2), this.materials.vinyl, interior, [0, 0.62, -0.62]);
    this.mesh(roundedBox(0.98, 0.48, 0.1, 0.03, 2), this.materials.vinyl, interior, [0, 0.85, -0.84], [0.12, 0, 0]);
    this.mesh(roundedBox(0.46, 0.11, 0.38, 0.03, 2), this.materials.vinyl, interior, [-0.26, 0.61, 0.1]);
    this.mesh(roundedBox(0.46, 0.42, 0.09, 0.03, 2), this.materials.vinyl, interior, [-0.26, 0.82, -0.07], [0.1, 0, 0]);
    this.mesh(roundedBox(1.08, 0.86, 0.05, 0.02, 1), this.materials.vinyl, interior, [0, 0.9, -1.13]);
    // grab rail along the bench back, a bajaj fixture passengers hold
    this.mesh(strut(new THREE.Vector3(-0.46, 1.12, -0.72), new THREE.Vector3(0.46, 1.12, -0.72), 0.014, 6), this.materials.chrome, interior);

    // handlebar, grips, column and instrument pod, all inside the screen
    const barY = 1.02;
    const barZ = 0.58;
    this.mesh(strut(new THREE.Vector3(-0.28, barY, barZ), new THREE.Vector3(0.28, barY, barZ), 0.017, 8), trimMat, interior);
    for (const sx of [-1, 1]) {
      this.mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.1, 8), this.materials.vinyl, interior, [sx * 0.25, barY, barZ], [0, 0, Math.PI / 2]);
    }
    this.mesh(strut(new THREE.Vector3(0, 0.62, 0.72), new THREE.Vector3(0, barY, barZ), 0.026, 8), trimMat, interior);
    this.mesh(roundedBox(0.18, 0.09, 0.1, 0.025, 1), trimMat, interior, [0, 0.99, 0.68]);
    if (!this.simple) {
      this.mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.01, 12), this.materials.steel, interior, [0, 1.02, 0.735], [Math.PI / 2, 0, 0]);
    }

    // ---------------------------------------------------------------- mirrors
    for (const sx of [-1, 1]) {
      this.mesh(strut(new THREE.Vector3(sx * 0.6, 1.24, 0.6), new THREE.Vector3(sx * 0.69, 1.27, 0.57), 0.011), trimMat, body);
      this.mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.028, 12), trimMat, body, [sx * 0.695, 1.27, 0.56], [Math.PI / 2, 0, 0]);
    }

    // ---------------------------------------------------------------- rear
    const rear = new THREE.Group();
    rear.name = 'rear';
    body.add(rear);
    this.mesh(roundedBox(1.2, 0.94, 0.1, 0.04, 2), paint, rear, [0, 0.83, -1.22]);
    for (const sx of [-1, 1]) {
      this.mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.04, 14), this.materials.chrome, rear, [sx * 0.38, 0.62, -1.27], [Math.PI / 2, 0, 0]);
      this.mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.05, 14), this.materials.tail, rear, [sx * 0.38, 0.62, -1.28], [Math.PI / 2, 0, 0]);
    }
    this.mesh(new THREE.PlaneGeometry(0.26, 0.1), plateMat, rear, [0, 0.95, -1.276], [0, Math.PI, 0]);
    this.mesh(roundedBox(1.04, 0.11, 0.13, 0.03, 1), trimMat, rear, [0, 0.44, -1.26]);
    this.mesh(roundedBox(1.34, 0.15, 0.028, 0.012, 1), this.materials.canvas, rear, [0, 1.45, -1.22]);

    // flank badge: black oval, white ring, red woven centre
    const decalTex = canvasTexture(256, 192, (c, w, h) => {
      c.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2;
      c.fillStyle = '#141414';
      c.beginPath();
      c.ellipse(cx, cy, w * 0.47, h * 0.46, 0, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = '#f0efe6';
      c.lineWidth = 6;
      c.beginPath();
      c.ellipse(cx, cy, w * 0.37, h * 0.33, 0, 0, Math.PI * 2);
      c.stroke();
      c.fillStyle = '#b8342a';
      c.beginPath();
      c.ellipse(cx, cy, w * 0.27, h * 0.23, 0, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#f0efe6';
      for (let y = 0; y < 5; y++) {
        for (let x = 0; x < 6; x++) {
          c.beginPath();
          c.arc(cx - w * 0.19 + x * w * 0.076, cy - h * 0.14 + y * h * 0.07, 2.2, 0, Math.PI * 2);
          c.fill();
        }
      }
      c.font = '700 18px ui-sans-serif, system-ui, sans-serif';
      c.textAlign = 'center';
      c.fillText('BAJAJ', cx, cy + h * 0.4);
    });
    const decalMat = new THREE.MeshStandardMaterial({
      map: decalTex,
      roughness: 0.52,
      metalness: 0.06,
      transparent: true,
      alphaTest: 0.4,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    for (const sx of [-1, 1]) {
      this.mesh(new THREE.PlaneGeometry(0.42, 0.31), decalMat, body, [sx * 0.657, 0.45, -0.24], [0, (sx * Math.PI) / 2, 0]);
    }

    // ---------------------------------------------------------------- wheels
    const front = this.buildFrontWheel();
    this.steerPivot = front.steer;
    body.add(front.steer);

    for (const sx of [-1, 1]) {
      this.mesh(archStrip(REAR_AXLE, WHEEL_R, 0.335, 0.3, 0.1 * Math.PI, 0.9 * Math.PI, 0.03), trimMat, body, [sx * 0.655, 0, 0]);
      this.buildRearWheel(sx, body);
    }
    // rear axle tube between the wheels
    this.mesh(strut(new THREE.Vector3(-0.56, WHEEL_R, REAR_AXLE), new THREE.Vector3(0.56, WHEEL_R, REAR_AXLE), 0.042, 8), this.materials.trim, body);

    // ---------------------------------------------------------------- underbody
    const chassis = new THREE.Group();
    chassis.name = 'chassis';
    body.add(chassis);
    this.mesh(roundedBox(0.92, 0.14, 2.05, 0.03, 1), this.materials.trim, chassis, [0, 0.42, -0.16]);
    this.mesh(strut(new THREE.Vector3(0.2, 0.37, 0.86), new THREE.Vector3(0.2, 0.37, -0.42), 0.028, 7), this.materials.chrome, chassis);
    if (!this.simple) {
      for (const sx of [-1, 1]) {
        this.mesh(roundedBox(0.07, 0.035, 0.6, 0.012, 1), this.materials.trim, chassis, [sx * 0.12, 0.4, 0.84]);
      }
    }

    if (opts.blob !== false) {
      const blob = shadowBlob(W * 1.4, BAJAJ_DIMENSIONS.length * 1.05, 0.42);
      blob.position.set(0, 0.02, 0.04);
      root.add(blob);
    }
  }

  private buildFrontWheel(): { steer: THREE.Group } {
    // the steering pivot sits on the front axle, so its children are in axle-local space
    const steer = new THREE.Group();
    steer.name = 'front-steer';
    steer.position.set(0, 0, FRONT_AXLE);

    const pivot = new THREE.Group();
    pivot.position.set(0, WHEEL_R, 0);
    steer.add(pivot);

    const tyre = this.mesh(
      new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.1, 20, 1),
      this.materials.tyre,
      pivot,
      [0, 0, 0],
      [0, 0, Math.PI / 2]
    );
    // shoulder ribs, like a motorcycle tyre
    for (const sx of [-1, 1]) {
      this.mesh(new THREE.TorusGeometry(WHEEL_R - 0.014, 0.013, 5, 18), this.materials.tyre, pivot, [sx * 0.042, 0, 0], [0, Math.PI / 2, 0]);
    }
    // rim, hub, spokes
    this.mesh(new THREE.TorusGeometry(0.19, 0.021, 6, 18), this.materials.chrome, pivot, [0, 0, 0], [0, Math.PI / 2, 0]);
    this.mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.12, 10), this.materials.steel, pivot, [0, 0, 0], [0, 0, Math.PI / 2]);
    if (!this.simple) {
      const spokes = 6;
      for (let i = 0; i < spokes; i++) {
        const a = (i / spokes) * Math.PI * 2;
        const spoke = this.mesh(new THREE.BoxGeometry(0.012, 0.2, 0.02), this.materials.chrome, pivot, [0, 0, 0], [a, 0, 0]);
        spoke.position.y = Math.cos(a) * 0.095;
        spoke.position.z = Math.sin(a) * 0.095;
      }
    }
    // brake drum on the vehicle's left face of the hub
    this.mesh(new THREE.CylinderGeometry(0.082, 0.082, 0.03, 14), this.materials.steel, pivot, [0.06, 0, 0], [0, 0, Math.PI / 2]);

    // fork legs run from the axle up to the crown, then the column disappears into the cowl
    for (const sx of [-1, 1]) {
      this.mesh(
        strut(new THREE.Vector3(sx * 0.135, WHEEL_R + 0.02, -0.035), new THREE.Vector3(sx * 0.135, 0.68, -0.1), 0.022, 8),
        this.materials.trim,
        steer
      );
    }
    this.mesh(roundedBox(0.31, 0.06, 0.09, 0.02, 1), this.materials.trim, steer, [0, 0.68, -0.1], [0.08, 0, 0]);
    // axle stub through the hub, so the wheel is visibly carried by something
    this.mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.32, 8), this.materials.chrome, steer, [0, WHEEL_R, 0], [0, 0, Math.PI / 2]);
    this.mesh(strut(new THREE.Vector3(0, 0.66, -0.09), new THREE.Vector3(0, 0.98, -0.3), 0.028, 8), this.materials.trim, steer);

    this.wheels.push({ pivot, wheel: tyre, front: true });
    return { steer };
  }

  private buildRearWheel(sx: number, body: THREE.Group) {
    const pivot = new THREE.Group();
    pivot.name = sx > 0 ? 'rear-wheel-left' : 'rear-wheel-right';
    pivot.position.set(sx * 0.6, WHEEL_R, REAR_AXLE);
    body.add(pivot);

    const tyre = this.mesh(
      new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.15, 20, 1),
      this.materials.tyre,
      pivot,
      [0, 0, 0],
      [0, 0, Math.PI / 2]
    );
    this.mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.153, 18), this.materials.steel, pivot, [0, 0, 0], [0, 0, Math.PI / 2]);
    this.mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.16, 12), this.materials.chrome, pivot, [0, 0, 0], [0, 0, Math.PI / 2]);
    if (!this.simple) {
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        this.mesh(
          new THREE.CylinderGeometry(0.013, 0.013, 0.012, 6),
          this.materials.chrome,
          pivot,
          [sx * 0.077, Math.cos(a) * 0.1, Math.sin(a) * 0.1],
          [0, 0, Math.PI / 2]
        );
      }
    }
    this.wheels.push({ pivot, wheel: tyre, front: false });
  }

  /** Steering angle in radians, applied to the front wheel and fork. */
  setSteer(angle: number) {
    this.steer = angle;
    if (this.steerPivot) this.steerPivot.rotation.y = angle;
  }

  /**
   * Animate like the Car class: forward speed in m/s, steering input -1..1.
   * The front wheel both steers and spins; the rears only spin.
   */
  update(dt: number, speed: number, steerInput = 0) {
    this.setSteer(this.steer + (steerInput * 0.5 - this.steer) * Math.min(1, dt * 9));
    for (const w of this.wheels) {
      w.wheel.rotation.x -= (speed * dt) / WHEEL_R;
    }
  }

  dispose() {
    for (const geo of this.geometries) geo.dispose();
    for (const mat of Object.values(this.materials)) {
      mat.map?.dispose();
      mat.dispose();
    }
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const m = o.material as THREE.MeshStandardMaterial;
        if (!Object.values(this.materials).includes(m)) {
          m?.map?.dispose();
          m?.dispose();
        }
      }
    });
    this.root.removeFromParent();
  }
}

/** Convenience factory for callers that only need the group: `scene.add(createBajaj().root)`. */
export function createBajaj(opts: BajajOptions = {}): Bajaj {
  return new Bajaj(opts);
}
