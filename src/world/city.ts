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
  buildSignalIntersection,
  buildStreetRun,
  buildTIntersection,
  KERB_WIDTH,
  WALK_TOP_M,
  type StreetGround,
} from './streetkit';
import {
  ArchetypeMixer,
  FacadePlan,
  archetypeBody,
  buildFacadeDetail,
  facadeEmissiveKeys,
  facadeMaterial,
  tileBoxUV,
  trimFor,
  windowTexture,
} from './facade';

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

/**
 * Where an ojek rank stands, and how it is seated.
 *
 * The bike is 1.27 m between its axles (front 0.74 m ahead of the group origin, rear 0.53 m
 * behind) and parks nose-in at the kerb, so the whole machine needs 1.27 m of depth plus its
 * overhang. The generic kerbside slot `snapToVerge` hands out sits at half-width + 3.5 m, which is
 * 0.3 m short of the BACK edge of the 3.6 m trotoar: a nose-in bike therefore hung one tyre over
 * that edge, onto whatever was behind the paving - usually a crossing carriageway 0.2 m lower.
 * Pulling the slot 1.1 m toward the kerb leaves 0.66 m of paving behind the rear tyre and 1.4 m in
 * front of the front tyre, so both tyres stand on the slab for any yaw the random layout picks.
 */
const OJEK_FRONT = 0.74;
const OJEK_REAR = -0.53;
const OJEK_KERB_INSET = 1.1;
/** Fallback slot for paving that is not one plane: the kerbside lane, 2 m off the centre line. */
const OJEK_ROAD_INSET = 5.5;


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



/** The lit-window mask. One canvas for the whole city: the tiling comes from the geometry UVs. */
let emissiveTextureCache: THREE.Texture | null = null;

function emissiveTexture(): THREE.Texture {
  if (emissiveTextureCache) return emissiveTextureCache;
  const tex = canvasTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const cols = 4;
    const rows = 4;
    const pad = 6;
    const cw = w / cols;
    const ch = h / rows;
    for (let x = 0; x < cols; x++) {
      for (let y = 0; y < rows; y++) {
        if (Math.random() < 0.55) {
          ctx.fillStyle = `rgba(255,${randInt(180, 230)},${randInt(110, 170)},1)`;
          ctx.fillRect(x * cw + pad, y * ch + pad, cw - pad * 2, ch - pad * 2.2);
        }
      }
    }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  emissiveTextureCache = tex;
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

/**
 * A point where a prop meets the ground, in the prop's own frame.
 *
 * `x`/`z` are where the contact is; `y` is left out on purpose — it is measured back out of the
 * built mesh (see `contactBottom`), so a tread sunk 5 mm into the paving or a rubber foot on the
 * group origin both seat on the surface they actually touch instead of on a constant repeated from
 * the builder.
 */
interface GroundContact {
  x: number;
  z: number;
  /** contact patch radius: how far to look for the lowest vertex of this foot or tread */
  r: number;
}

/**
 * Where a gerobak touches the ground: both tyres and both braced feet (src/world/kakilima.ts).
 * The tyres sit at local x=0.38, outboard at z=±0.50, so the cart is 1.0 m across the track; the
 * feet are 1.16 m behind the axle at z=±0.29. Those four points are the reason one ground sample at
 * the slot cannot seat this prop: the kerbside slots sit on the pavement edge, and a 1.0 m track
 * across that edge puts one tyre 26 cm over the carriageway (t_3bbf1bce).
 */
const CART_CONTACTS: GroundContact[] = [
  { x: 0.38, z: 0.5, r: 0.2 },
  { x: 0.38, z: -0.5, r: 0.2 },
  { x: -0.6, z: 0.29, r: 0.2 },
  { x: -0.6, z: -0.29, r: 0.2 },
];

/**
 * Least-squares plane `e = d + a*x + b*z` through a prop's contact errors.
 *
 * Four contacts, three unknowns: a rigid body can lift and tilt but not bend, so the fit splits the
 * error the way a prop actually settles - half the residual at one corner goes into a tilt rather
 * than into one foot floating. Solved with Cramer's rule on the 3x3 normal equations, which is
 * stable here because the contacts span both axes (a prop with all four contacts on one line has no
 * tilt to fit and falls back to the mean).
 */
function fitContactPlane(xs: number[], zs: number[], es: number[]): { d: number; a: number; b: number } {
  const n = xs.length;
  let Sx = 0, Sz = 0, Sxx = 0, Sxz = 0, Szz = 0, Se = 0, Sxe = 0, Sze = 0;
  for (let i = 0; i < n; i++) {
    Sx += xs[i]; Sz += zs[i];
    Sxx += xs[i] * xs[i]; Sxz += xs[i] * zs[i]; Szz += zs[i] * zs[i];
    Se += es[i]; Sxe += xs[i] * es[i]; Sze += zs[i] * es[i];
  }
  const A = [[n, Sx, Sz], [Sx, Sxx, Sxz], [Sz, Sxz, Szz]];
  const rhs = [Se, Sxe, Sze];
  const det = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d0 = det(A);
  if (Math.abs(d0) < 1e-6) return { d: Se / n, a: 0, b: 0 };
  const swapped = (col: number) => A.map((row, i) => row.map((v, j) => (j === col ? rhs[i] : v)));
  return { d: det(swapped(0)) / d0, a: det(swapped(1)) / d0, b: det(swapped(2)) / d0 };
}



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
  declare focusTarget: THREE.Vector3;
  declare daylight: number;
  declare rootGroup: THREE.Group;
  /**
   * Placement audit rows. `x`/`z` are the slot the prop stands on; `bottom` is where its ground face
   * is. For a prop seated from one sample (`placeOnGround`) that is the slot's ground height. For a
   * prop seated on its contacts (`standOnContacts`, the kaki lima carts) it is the LOWEST contact,
   * and `bx`/`bz` are where that contact is, so the floating-prop check measures the gap under the
   * contact instead of under the slot: comparing a tyre 60 cm from the slot on a 12% grade against
   * the slot sample reports the slope as a gap and hides the straddle it is looking for.
   */
  declare propAudit: { name: string; x: number; z: number; bottom: number; bx?: number; bz?: number }[];

  declare streetSpines: { ax: number; az: number; bx: number; bz: number; half: number; walkW: number }[];

  /** the mapped roads as segments in a grid, built on first use by the street-kit site search */
  declare roadGrid: { grid: Map<string, number[]>; segs: number[]; CELL: number } | null;

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
  /** built surfaces a prop can be seated on; collected on first use (see surfaces()) */
  private surfaceCache: THREE.Object3D[] | null = null;

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
    for (const [group, bucket] of this.buildingBuckets) {
      for (const { mat, geos } of bucket.values()) {
        if (!geos.length) continue;
        const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
        if (!merged) continue;
        const mesh = new THREE.Mesh(merged, mat);
        mesh.name = 'building-body';
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
        for (const g of geos) g.dispose();
      }
    }
    this.buildingBuckets.clear();
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
    // named, so a prop that has to be seated on the built surface can ray this instead of the
    // analytic height: the plane is 190 segments over 3 km, so on a hill its triangles are up to
    // 0.3 m away from what terrainHeight() says, and a prop seated on the analytic number floats
    ground.name = 'terrain';
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
      plate.name = 'plate';        // a built walking surface, for contact seating (see contactGround)
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
    this.buildTerrainFeatures();
    this.buildRoadRibbons();
    this.buildWater();
    this.buildDistrictProps();
    this.buildStreetLife();
    this.buildOjekBases();
    this.buildLayangRoad();
    this.buildMrt();
    this.buildKrlLine();
    // The street goes in last of the world passes: its site search reads `this.blocks` to find a
    // corridor with room for a full cross-section, and the MRT, the layang and the landmarks all
    // push plates after the block loop. Built earlier it could pick ground that a later plate then
    // covered, which showed up as kit props standing 9 cm inside a 26 cm plate.
    this.buildStreetKit();

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
    this.finalizeFacadeDetails();
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
   *
   * `pushOffRoadOnce` resolves one road per pass, so at a junction it can hand the point from one
   * carriageway to the other and back: after six passes the masjid still stood 4.9 m from the
   * centreline of Gatot Subroto, i.e. in the inside lane, and `tests/world/placement.mjs` caught
   * it only on the loads where the random city put it there. So the pass loop now ends with a
   * proof instead of a hope: if the point is still on tarmac, search outward for the nearest slot
   * that clears every road in the map's list, and only then hand it back.
   */
  pushOffRoad(x: number, z: number, extra: number): { x: number; z: number } {
    let px = x, pz = z;
    for (let pass = 0; pass < 6; pass++) {
      const moved = this.pushOffRoadOnce(px, pz, extra);
      if (moved.x === px && moved.z === pz) break;
      px = moved.x; pz = moved.z;
    }
    if (!this.onAnyRoad(px, pz, extra)) return { x: px, z: pz };
    // still on tarmac: the slot is the nearest point that is not (the caller asked for `extra`
    // metres of clearance, so the rings start at that radius and walk outward)
    for (const r of [extra + 4, extra + 10, extra + 18, extra + 28, extra + 40]) {
      let best: { x: number; z: number; d: number } | null = null;
      for (let a = 0; a < 24; a++) {
        const t = (a / 24) * Math.PI * 2;
        const qx = px + Math.cos(t) * r;
        const qz = pz + Math.sin(t) * r;
        if (this.onAnyRoad(qx, qz, extra)) continue;
        const d = Math.hypot(qx - px, qz - pz);
        if (!best || d < best.d) best = { x: qx, z: qz, d };
      }
      if (best) return { x: best.x, z: best.z };
    }
    return { x: px, z: pz };
  }

  /** is (x,z) on any carriageway, with `margin` metres of kerb clearance? */
  onAnyRoad(x: number, z: number, margin = 0): boolean {
    const roads: { path: [number, number][]; half: number }[] = [
      ...ARTERIALS.map((a) => ({ path: a.path as [number, number][], half: a.width / 2 })),
      { path: RING_ROAD as [number, number][], half: 10 },
      ...LOCAL_STREETS.map((l) => ({ path: l.path as [number, number][], half: l.width / 2 })),
    ];
    for (const { path, half } of roads) {
      const need = half + margin;
      for (let i = 1; i < path.length; i++) {
        const [x1, z1] = path[i - 1];
        const [x2, z2] = path[i];
        const dx = x2 - x1, dz = z2 - z1;
        const l2 = dx * dx + dz * dz || 1;
        let t = ((x - x1) * dx + (z - z1) * dz) / l2;
        t = Math.max(0, Math.min(1, t));
        if (Math.hypot(x - (x1 + dx * t), z - (z1 + dz * t)) < need) return true;
      }
    }
    return false;
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

  /**
   * The kerbside slot nearest (x, z): on the paving, 0.3 m short of the shopfront line.
   *
   * `inset` moves the slot that many metres toward the kerb before it is tested. Everything that
   * just needs "on the pavement" leaves it at 0; a prop too deep for the 0.6 m of paving behind
   * that slot passes its own depth, so the collider test runs where the prop ends up rather than
   * at a slot it will not occupy.
   *
   * `accept` rejects a candidate slot the caller cannot use - the ojek rank needs both tyres on one
   * surface, and the paving is not one surface at a crossing mouth. The walk along the kerb is a
   * fixed order, so the slot a caller gets is deterministic for a given layout.
   */
  snapToVerge(
    x: number,
    z: number,
    inset = 0,
    accept?: (p: { x: number; z: number; yaw: number }) => boolean
  ): { x: number; z: number; yaw: number } | null {
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
    // The kerb cap ends at half+0.2 and the paving runs 3.6 m behind it, so this is 0.3 m short of
    // the shopfront line, not the middle of the slab: a prop deeper than 0.6 m has to inset itself.
    const off = best.half + 1.9 + 1.6 - inset;
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
        if (!free(px, pz) || isWater(px, pz)) continue;
        if (accept && !accept({ x: px, z: pz, yaw: best.yaw })) continue;
        return { x: px, z: pz, yaw: best.yaw };
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

  /**
   * The built walking surfaces a prop can be seated on, collected once.
   *
   * A contact seat costs one ray per contact per pass, so the ray has to be cheap and it has to
   * see ground and nothing else. Raying the whole city group instead picked up other props'
   * geometry (a cart's own tyres, a halte roof) and tested every instanced tree; the named surfaces
   * are the terrain, the block plates and the street kit's trotoar/kerb/gutter/road ribbons.
   */
  private surfaces(): THREE.Object3D[] {
    if (!this.surfaceCache) {
      const wanted = new Set(['terrain', 'plate', 'trotoar', 'kerb', 'gutter', 'kerb-ramp', 'road-arterial', 'road-local', 'road-shoulder']);
      this.surfaceCache = [];
      this.group.traverse((o) => {
        if (wanted.has(o.name)) this.surfaceCache!.push(o);
      });
    }
    return this.surfaceCache;
  }

  /**
   * The height of the built surface under (x, z), or null when nothing is under it.
   *
   * This is the contact target, and it has to be the built mesh rather than `groundHeightAt`: the
   * pavement ribbon is swept as a flat cross-section from the terrain at each path station, so on a
   * cross-slope the paving can sit 24 cm under the analytic `terrain + 0.26`, and a prop seated on
   * the analytic number floats over the paving the player can see (measured on the southern rise,
   * t_3bbf1bce). The window is wide because of that same slope, and narrow enough that a roof or a
   * wall two metres up cannot be mistaken for the street.
   */
  private contactGround(x: number, z: number): number | null {
    const near = this.groundHeightAt(x, z);
    const ray = new THREE.Raycaster(new THREE.Vector3(x, near + 1.2, z), new THREE.Vector3(0, -1, 0), 0, 2.4);
    const hits = ray.intersectObjects(this.surfaces(), true) as { point: THREE.Vector3; face: { normal: THREE.Vector3 } | null; object: THREE.Object3D }[];
    const n = new THREE.Vector3();
    const nm = new THREE.Matrix3();
    let best: number | null = null;
    for (const h of hits) {
      if (h.point.y > near + 0.32 || h.point.y < near - 0.6) continue;
      // only an upward face can be stood on. A ray that lands on the vertical back of a paving slab
      // returns a height anywhere between the slab and the ground under it, and that number seated
      // one cart 24 cm into the street; a prop rests on a face with a normal, not on an edge.
      if (h.face) {
        n.copy(h.face.normal).applyMatrix3(nm.getNormalMatrix(h.object.matrixWorld)).normalize();
        if (n.y < 0.5) continue;
      }
      if (best === null || h.point.y > best) best = h.point.y;
    }
    return best;
  }

  /** where a prop yawed by `yaw` and centred at (x, z) puts one contact (three.js Y-rotation) */
  private contactWorld(x: number, z: number, yaw: number, c: GroundContact) {
    const c1 = Math.cos(yaw);
    const s1 = Math.sin(yaw);
    return { x: x + c.x * c1 + c.z * s1, z: z - c.x * s1 + c.z * c1 };
  }

  /**
   * The height of a prop's contact face, read back out of the built mesh: the lowest vertex within
   * `r` of the contact, in the prop's own frame.
   *
   * Measuring beats repeating the builder's constants: the cart's tread is built 5 mm sunk into the
   * paving (a tangent tyre otherwise contacts on one anti-aliased pixel and reads as floating) and
   * its rubber feet sit on the group origin, so the two contact kinds do not share a y.
   */
  private contactBottom(g: THREE.Object3D, lx: number, lz: number, r: number): number {
    g.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(g.matrixWorld).invert();
    const v = new THREE.Vector3();
    const local = new THREE.Vector3();
    let best = Infinity;
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry || !m.geometry.attributes.position) return;
      if (Array.isArray(m.material) ? m.material.some((mm) => mm.transparent) : m.material?.transparent) return;
      const pos = m.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        local.copy(v).applyMatrix4(inv);
        if (Math.hypot(local.x - lx, local.z - lz) > r) continue;
        if (local.y < best) best = local.y;
      }
    });
    return best === Infinity ? 0 : best;
  }

  /**
   * A stance where a wide prop's four contacts all stand on the same surface.
   *
   * `placeOnGround` samples the slot once, which seats a narrow prop and mis-seats a wide one: the
   * kerbside slot sits on the pavement edge, a gerobak's track is 1.0 m across that edge, and one
   * tyre ended up 26 cm over the carriageway (measured, t_3bbf1bce). This walks the slot outward in
   * 30 cm rings and scores every candidate on two things: are the built heights under the four
   * contacts within 3 cm of each other (the largest spread a rigid prop can take and still have
   * every tyre and foot on the ground), and is each of them the surface `groundHeightAt` describes.
   * The first candidate that passes both, nearest the slot, is returned; failing that the flattest
   * stance on a slab, then any level ground, then the flattest place found - a cart parked in the
   * gutter under a kerb is still a cart on the ground, and the audit reports the gap either way.
   *
   * Returns a stance, not a correction: the caller builds the prop there, so the audit entry, the
   * collider and the mesh all describe the same place.
   */
  private wideStance(x: number, z: number, yaw: number, contacts: GroundContact[]) {
    const spreadOf = (g: number[]) => Math.max(...g) - Math.min(...g);
    const onPavement = (px: number, pz: number) => this.groundHeightAt(px, pz) - terrainHeight(px, pz) > 0.2;
    // a stance is only a stance when the built surface under each contact is the surface
    // `groundHeightAt` describes. On the verge that is not free: the plate is 26 cm high and
    // `groundHeightAt` carries a 1.2 m margin past its edge, so a cart can stand on the ground
    // beside a slab and read "on the pavement" analytically. Level, but in the gutter.
    const onTheSurface = (p: { x: number; z: number }, built: number) => Math.abs(built - this.groundHeightAt(p.x, p.z)) <= 0.08;
    let onSlab: { x: number; z: number; spread: number } | null = null;
    let levelAny: { x: number; z: number } | null = null;
    let flattest: { x: number; z: number; spread: number } | null = null;
    let rays = 0;
    for (const r of [0, 0.3, 0.6, 0.9, 1.2, 1.5]) {
      const steps = r === 0 ? 1 : 8;
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const cx = x + Math.cos(a) * r;
        const cz = z + Math.sin(a) * r;
        const pts = contacts.map((c) => this.contactWorld(cx, cz, yaw, c));
        const grounds: number[] = [];
        for (const p of pts) {
          const g = this.contactGround(p.x, p.z);
          if (g === null) break;
          grounds.push(g);
        }
        if (grounds.length < pts.length) continue;
        rays++;
        const spread = spreadOf(grounds);
        const slab = pts.every((p, k) => onTheSurface(p, grounds[k]));
        if (!flattest || spread < flattest.spread) flattest = { x: cx, z: cz, spread };
        if (slab && pts.every((p) => onPavement(p.x, p.z)) && spread <= 0.03) return { x: cx, z: cz };
        if (slab && (!onSlab || spread < onSlab.spread) && spread <= 0.16) onSlab = { x: cx, z: cz, spread };
        if (spread <= 0.03 && !levelAny) levelAny = { x: cx, z: cz };
        if (rays >= 80) break;
      }
      if (rays >= 80) break;
    }
    // a stance on the paving beats a level one in the gutter: the cart is a kerbside prop, and the
    // tilt in standOnContacts is there for exactly the grade a slab can have
    const pick = onSlab ?? levelAny ?? flattest;
    return pick ? { x: pick.x, z: pick.z } : { x, z };
  }

  /**
   * Put a wide prop down on its own contact plane.
   *
   * Two degrees of freedom are solved, the way `standOjek` solves two for a bike: the mean error
   * lifts or drops the group, and the slope of the errors across the footprint tilts it, so a cart
   * on a crossfall or on the southern rise has both tyres and both feet on the ground instead of
   * one end in the paving. The tilt is the ground's own fall, not a styling choice, and it is
   * capped: a stance is only accepted when its four contacts already agree within 3 cm, so anything
   * past the cap is a bad stance rather than a hill.
   *
   * `bottom` on the audit entry becomes the LOWEST contact, not the slot sample. That is what lets
   * `_test.audit()` see a straddling prop: a cart whose far tyre is down on the carriageway reports
   * 26 cm under the pavement its slot stands on, and the suite fails instead of passing.
   */
  private standOnContacts(g: THREE.Object3D, yaw: number, stance: { x: number; z: number }, contacts: GroundContact[]) {
    g.rotation.order = 'YXZ';
    g.rotation.set(0, yaw, 0);
    g.position.set(stance.x, 0, stance.z);
    g.updateMatrixWorld(true);
    const local = contacts.map((c) => ({ x: c.x, z: c.z, y: this.contactBottom(g, c.x, c.z, c.r) }));
    const p = new THREE.Vector3();
    const MAX_TILT = 0.2;       // 11.5 deg: the steepest grade the southern rise reaches
    for (let pass = 0; pass < 3; pass++) {
      g.updateMatrixWorld(true);
      const err = local.map((c) => {
        p.set(c.x, c.y, c.z);
        g.localToWorld(p);
        // analytic only when nothing is built there at all: no cart is dropped through a hole
        const ground = this.contactGround(p.x, p.z);
        return (ground === null ? this.groundHeightAt(p.x, p.z) : ground) - p.y;
      });
      const { d, a, b } = fitContactPlane(local.map((c) => c.x), local.map((c) => c.z), err);
      g.position.y += d;
      g.rotation.z = clamp(g.rotation.z + a, -MAX_TILT, MAX_TILT);   // about the prop's own x
      g.rotation.x = clamp(g.rotation.x - b, -MAX_TILT, MAX_TILT);   // about the prop's own z
    }
    g.updateMatrixWorld(true);
    let lowest = Infinity;
    let lowX = stance.x;
    let lowZ = stance.z;
    for (const c of local) {
      p.set(c.x, c.y, c.z);
      g.localToWorld(p);
      if (p.y < lowest) {
        lowest = p.y;
        lowX = p.x;
        lowZ = p.z;
      }
    }
    const last = this.propAudit[this.propAudit.length - 1];
    if (last) {
      last.bottom = lowest;
      last.bx = lowX;
      last.bz = lowZ;
    }
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
        const yaw = spot.yaw + Math.PI / 2;
        // a cart is 1.0 m across its tyres and the kerbside slot is on the pavement edge, so it is
        // built on a stance where all four contacts are on one surface, not on the slot itself
        const stance = this.wideStance(spot.x, spot.z, yaw, CART_CONTACTS);
        const g = buildKakiLima(ctx, carts[placedCarts % carts.length], stance.x, stance.z, yaw);
        this.standOnContacts(g, yaw, stance, CART_CONTACTS);
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

  /** every building footprint already placed, so two of them can never occupy the same ground */
  footprints: { minX: number; maxX: number; minZ: number; maxZ: number }[] = [];

  /**
   * Facade detail (ledges, rails, shutters, awnings, signs, painted walls) grouped by material key.
   * One merge per key at the end of generation, so six archetypes of detail cost a handful of draw
   * calls for the whole city instead of a handful per building.
   */
  facadeDetailBuckets = new Map<THREE.Group, Map<string, THREE.BufferGeometry[]>>();

  /**
   * What was actually built, so the proof harness can count distinct types in one frame instead of
   * trusting that the palette varied. Written by addFacade, read by tools/shoot-facades.mjs.
   */
  facadeAudit: { archetype: string; source: 'block' | 'frontage'; x: number; y: number; z: number; yaw: number; w: number; d: number; h: number; wall: number; trim: number }[] = [];

  /** per-block / per-row archetype pickers, so a run of lots never repeats one type */
  facadeMixers = new Map<string, ArchetypeMixer>();


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
    // and it must not stand in a carriageway: the line runs 5.5 m past the arterial edge, which at
    // a crossing with another arterial puts the hall in its inside lane (the placement audit found
    // it 1 m into Grogol-Pluit on a third of the random loads)
    const candidates = shifted.filter((pt) => stairClear(pt[0], pt[1]) && !this.onAnyRoad(pt[0], pt[1], 1.5));
    let mid = shifted[0], bestD = Infinity;
    for (const pt of candidates.length ? candidates : shifted) {
      const d = Math.hypot(pt[0] - sp.x, pt[1] - sp.z);
      if (d < bestD) { bestD = d; mid = pt; }
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
    // the built-street rays below read matrixWorld, and nothing has been rendered yet
    this.group.updateMatrixWorld(true);
    let placed = 0;
    for (const poi of POIS) {
      if (poi.kind !== 'kaki5' && poi.kind !== 'terminal') continue;
      if (placed >= 3) break;
      placed++;
      for (let i = 0; i < 2; i++) {
        const yawOf = (spotYaw: number) => spotYaw + Math.PI / 2 + i * 0.1;
        // A bike stands on ONE plane or it stands on neither: both tyres have to read the same
        // drawn surface, which is what the slot predicate below tests.
        const onOneSurface = (p: { x: number; z: number; yaw: number }) =>
          this.ojekContact(p.x, p.z, yawOf(p.yaw)) !== null;
        // The rank is pulled 1.1 m toward the kerb: the generic kerbside slot sits 0.3 m from the
        // BACK edge of the 3.6 m trotoar, so the 1.86 m nose-in machine always had one tyre over
        // the edge, 0.2 m above the crossing road. The inset is applied inside snapToVerge so the
        // kerbside-collider test runs on the spot the bike actually takes.
        const spot =
          this.snapToVerge(poi.x + i * 3.2 - 1.6, poi.z + 6, OJEK_KERB_INSET, onOneSurface) ??
          // no patch of paving here is one plane under the whole machine (a crossing mouth, a
          // driveway cut, a kerb return): draw the rank up on the carriageway instead, where the
          // asphalt is continuous, rather than drop a bike or straddle the kerb
          this.snapToVerge(poi.x + i * 3.2 - 1.6, poi.z + 6, OJEK_ROAD_INSET, onOneSurface);
        if (!spot) continue;
        const yaw = yawOf(spot.yaw);
        const contact = this.ojekContact(spot.x, spot.z, yaw);
        if (!contact) continue;
        const bike = new Ojek({ color: i === 0 ? 0xc0392b : 0x1f6f4a });
        // The bike has to stand at its slot. placeOnGround only sets the height, so a group left
        // at x=0/z=0 parked every ojek in the middle of the map: six slots audited as "on the
        // ground" while the meshes were somewhere nobody could ever see them.
        bike.group.name = `ojek-${this.ojeks.length}`;
        this.group.add(bike.group);
        this.standOjek(bike, spot, contact, yaw);
        this.ojeks.push({ group: bike.group, x: spot.x, z: spot.z, yaw, box: bike.cargoBoxBounds });
        // the audit row is the SLOT sample, not the tyre contact: it compares every prop against
        // the analytic ground (a 0.06 m band), while the tyres are seated on the drawn slab, and
        // on a grade the swept slab and `groundHeightAt` legitimately differ by more than that.
        // Tyre contact is proved by tools/shoot-ojek-fix.mjs, not by this row.
        this.propAudit.push({ name: 'ojek', x: spot.x, z: spot.z, bottom: this.groundHeightAt(spot.x, spot.z) });
        this.colliders.push({ minX: spot.x - 0.55, maxX: spot.x + 0.55, minZ: spot.z - 1.1, maxZ: spot.z + 1.1, h: 1.6 });
      }
    }
  }

  /**
   * Seat a bike on the plane both its tyres stand on.
   *
   * `placeOnGround` seats a prop from a single sample at its audit slot and assumes the group
   * origin is the contact plane; an ojek's origin is `contactY` above its tread, and the trotoar
   * follows the terrain grade, so the two axles sit at slightly different heights. The contact is
   * solved against the measured tread rather than a formula: each wheel's own bounding box is read
   * back, the gap to the surface under its axle is measured, and position plus pitch are corrected
   * until both treads are down. The pitch is about the bike's lateral axis because the Euler order
   * is YXZ (yaw first, then lean in the machine's own frame).
   */
  private standOjek(
    bike: Ojek,
    spot: { x: number; z: number },
    contact: { gF: number; gR: number },
    yaw: number
  ) {
    bike.group.rotation.order = 'YXZ';
    bike.group.rotation.y = yaw;
    bike.group.rotation.x = 0;
    bike.group.position.set(spot.x, (contact.gF + contact.gR) / 2 - bike.contactY, spot.z);
    const [frontPivot, rearPivot] = bike.wheels;
    const span = frontPivot.pivot.position.z - rearPivot.pivot.position.z || 1;
    for (let pass = 0; pass < 4; pass++) {
      bike.group.updateMatrixWorld(true);
      const tread = bike.wheels.map((w) => new THREE.Box3().setFromObject(w.pivot).min.y);
      const err = [contact.gF - tread[0], contact.gR - tread[1]];
      bike.group.position.y += (err[0] + err[1]) / 2;
      bike.group.rotation.x += -(err[0] - err[1]) / span;
    }
    bike.group.updateMatrixWorld(true);
  }

  /**
   * The plane the bike would stand on at this stance, or null when its tyres would straddle an edge.
   *
   * Each tyre is measured separately against the drawn street (`builtGround`), because a rigid prop
   * gets one pitch and the kerb is only 0.26 m high. A bike on a slope is pitched to the grade, so
   * a height difference alone is not a defect; a STEP is. The midpoint tells the two apart: on a
   * slope the ground under the middle of the machine sits between the axles' heights, while across
   * an edge it sits on one of them.
   */
  private ojekContact(x: number, z: number, yaw: number): { gF: number; gR: number } | null {
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    const at = (k: number) => this.builtGround(x + s * k, z + c * k);
    const gF = at(OJEK_FRONT);
    const gR = at(OJEK_REAR);
    const gM = at((OJEK_FRONT + OJEK_REAR) / 2);
    if (gF === null || gR === null || gM === null) return null;
    if (Math.abs(gM - (gF + gR) / 2) > 0.02) return null;
    // no street here is steeper than ~25% over 1.27 m; more than that is an edge, not a grade
    if (Math.abs(gF - gR) > 0.35) return null;
    return { gF, gR };
  }

  /**
   * The topmost drawn surface under (x, z), or null when there is none.
   *
   * This is what a player sees a tyre rest on, and the same thing the contact harness measures.
   * `pavementBand` is where paving is PLANNED: at a crossing mouth or a kerb return the analytic
   * height and the swept slab disagree by up to the kerb height, and a bike seated on the analytic
   * number floats 20 cm over the drawn street. The ray starts 0.6 m above the analytic ground so a
   * shop awning, a signboard or a cart deck three metres up cannot be mistaken for the ground.
   */
  private builtGround(x: number, z: number): number | null {
    const near = this.groundHeightAt(x, z);
    const ray = new THREE.Raycaster(new THREE.Vector3(x, near + 0.6, z), new THREE.Vector3(0, -1, 0), 0, 1.2);
    const hit = ray.intersectObject(this.group, true)[0];
    return hit ? hit.point.y : null;
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

  // ------------------------------------------------------------ the street kit, wired

  /**
   * The kit's own street, laid between two block rows.
   *
   * The map's local streets are 8 m ribbons with no trotoar, no kerb relief and no markings, and
   * `planBlockSites` lays blocks on a 90 m lattice, so a whole 25 m corridor between two rows of
   * blocks is bare ground - that is the "everything between the junctions is nothing" the owner
   * photographed. This finds a crossing of that lattice with enough clear ground for a full
   * cross-section, then builds a signalised junction, three street runs out of it and a T where a
   * side street ends on the cross corridor. Everything comes from `src/world/streetkit.ts`, so the
   * corner radius, the kerb height and the walk depth are the same as every other street the kit
   * will ever lay.
   */
  buildStreetKit() {
    const site = this.streetKitSite();
    if (!site) return;
    if (!this.propAudit) this.propAudit = [];
    if (!this.streetSpines) this.streetSpines = [];

    const ctx = { group: this.group, colliders: this.colliders, audit: this.propAudit };
    // surfaces sit on the terrain; anything standing on the trotoar sits 17 cm higher - unless the
    // city already draws a higher pavement there (an arterial's trotoar is 26 cm), in which case the
    // prop stands on that. Both numbers come from the same `groundHeightAt` the audit reads, so a
    // kit prop cannot report a 9 cm gap against the surface it is actually standing on.
    const bed: StreetGround = (x, z) => terrainHeight(x, z);
    const walkTop: StreetGround = (x, z) => Math.max(terrainHeight(x, z) + WALK_TOP_M, this.groundHeightAt(x, z));

    const WALK = 3.6;
    const HALF = 4; // the map's local class is 8 m
    const ARM = 14; // how far the junction's asphalt arms run out past its box
    const armEnd = HALF + ARM;

    buildSignalIntersection(ctx, site.x, site.z, 0, {
      roadClass: 'local',
      armsM: ARM,
      walkWidthM: WALK,
      lights: true,
      ground: bed,
      furnitureGround: walkTop,
    });
    // the junction's own cross-section, so the arms' walks are in groundHeightAt too
    this.streetSpines.push({ ax: site.x - armEnd, az: site.z, bx: site.x + armEnd, bz: site.z, half: HALF, walkW: WALK });
    this.streetSpines.push({ ax: site.x, az: site.z - armEnd, bx: site.x, bz: site.z + armEnd, half: HALF, walkW: WALK });

    /** one street run out of the junction, from `from` to `to` metres along the arm */
    const run = (dx: number, dz: number, from: number, to: number, features: Record<string, unknown>) => {
      const len = to - from;
      if (len < 16) return;
      const mid = (from + to) / 2;
      buildStreetRun(ctx, site.x + dx * mid, site.z + dz * mid, Math.atan2(dx, dz), {
        roadClass: 'local',
        lengthM: len,
        walkWidthM: WALK,
        ground: bed,
        furnitureGround: walkTop,
        ...features,
      });
      this.streetSpines.push({
        ax: site.x + dx * from,
        az: site.z + dz * from,
        bx: site.x + dx * to,
        bz: site.z + dz * to,
        half: HALF,
        walkW: WALK,
      });
    };

    // which arm, if any, ends on a cross corridor in a T? The one with the most room decides.
    const T_STEM = 16;
    const dirs = [
      { dx: 0, dz: -1, reach: site.n },
      { dx: 0, dz: 1, reach: site.s },
      { dx: 1, dz: 0, reach: site.e },
      { dx: -1, dz: 0, reach: site.w },
    ];
    const tSite = dirs.find((d) => {
      if (d.reach < 96) return false;
      const tx = site.x + d.dx * 90;
      const tz = site.z + d.dz * 90;
      const across = Math.min(this.streetReach(tx, tz, -d.dz, d.dx), this.streetReach(tx, tz, d.dz, -d.dx));
      return across >= 14;
    }) ?? null;

    // the runs. The one that ends in the T stops where the T's own stem asphalt begins; the rest run
    // out to whatever the city left clear, capped at a block.
    for (const d of dirs) {
      const isT = !!tSite && tSite.dx === d.dx && tSite.dz === d.dz;
      // An arm that ends at the T stops where the T's stem asphalt begins. Every other arm runs out
      // to the next crossing of the 90 m lattice and is closed with an end cap there: a block of
      // street, not a slice of asphalt that stops in the middle of the ground.
      const end = isT ? 90 - HALF - T_STEM : Math.min(d.reach - 3, 90 - HALF);
      if (end - armEnd < 16) continue;
      const mid = (armEnd + end) / 2;
      const span = end - armEnd;
      const features: Record<string, unknown> = {
        ...(isT ? {} : { capEnd: true }),
      };
      if (d.dz === -1) {
        // the hero run: a crossing mid-block, a bus bay cut into one trotoar, two driveway
        // aprons in the other, and the poles, blade and bollards that make it a street
        features.crossings = [{ at: 0 }];
        features.bays = [{ side: 1, at: span * 0.32, lengthM: 13, depthM: 2.2 }];
        features.driveways = [
          { side: -1, at: -span * 0.3, widthM: 3.6 },
          { side: -1, at: -span * 0.14, widthM: 3.0 },
        ];
      } else if (d.dz === 1) {
        features.crossings = [{ at: 0 }];
      }
      run(d.dx, d.dz, armEnd, end, features);
    }

    if (tSite) {
      const tx = site.x + tSite.dx * 90;
      const tz = site.z + tSite.dz * 90;
      const reachA = this.streetReach(tx, tz, -tSite.dz, tSite.dx);
      const reachB = this.streetReach(tx, tz, tSite.dz, -tSite.dx);
      const throughM = Math.max(11, Math.min(26, Math.min(reachA, reachB) - 2));
      // yaw puts the T's local +z (its stem) back down the arm it serves
      buildTIntersection(ctx, tx, tz, Math.atan2(-tSite.dx, -tSite.dz), {
        roadClass: 'local',
        widthM: HALF * 2,
        stemWidthM: HALF * 2,
        throughM,
        stemM: T_STEM,
        walkWidthM: WALK,
        ground: bed,
      });
      this.streetSpines.push({
        ax: tx + tSite.dz * throughM,
        az: tz - tSite.dx * throughM,
        bx: tx - tSite.dz * throughM,
        bz: tz + tSite.dx * throughM,
        half: HALF,
        walkW: WALK,
      });
      const stemFrom = 90 - HALF - T_STEM;
      this.streetSpines.push({
        ax: site.x + tSite.dx * stemFrom,
        az: site.z + tSite.dz * stemFrom,
        bx: tx - tSite.dx * HALF,
        bz: tz - tSite.dz * HALF,
        half: HALF,
        walkW: WALK,
      });
    }
  }

  /** distance from a point to one of the kit's street spines, and so to its kerb lines */
  private spineDistance(x: number, z: number, s: { ax: number; az: number; bx: number; bz: number }): number {
    const dx = s.bx - s.ax;
    const dz = s.bz - s.az;
    const l2 = dx * dx + dz * dz || 1;
    let t = ((x - s.ax) * dx + (z - s.az) * dz) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t));
  }

  /**
   * Is the ground here free of everything a street cannot cross? Blocks (a plate may not sit on the
   * carriageway), the map's own roads, the rivers, and the landmarks. `PAD` is half the kit's
   * cross-section - 8 m of carriageway plus a 3.6 m trotoar and its kerb - plus a kerb's grace.
   */
  streetClear(x: number, z: number) {
    const PAD = 8.6;
    for (const b of this.blocks) {
      const half = (b.size ?? BLOCK) / 2;
      if (Math.abs(x - b.x) < half + PAD && Math.abs(z - b.z) < half + PAD) return false;
    }
    const { grid, segs, CELL } = this.roadSegments();
    const list = grid.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL));
    if (list) {
      for (const i of list) {
        const b = i * 5;
        const x1 = segs[b];
        const z1 = segs[b + 1];
        const dx = segs[b + 2] - x1;
        const dz = segs[b + 3] - z1;
        const len2 = dx * dx + dz * dz || 1;
        let t = ((x - x1) * dx + (z - z1) * dz) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        if (Math.hypot(x - (x1 + dx * t), z - (z1 + dz * t)) < segs[b + 4] + PAD) return false;
      }
    }
    for (const lm of LANDMARKS) if (Math.hypot(x - lm.x, z - lm.z) < 34) return false;
    return true;
  }

  /**
   * Every mapped road and river as a segment in a 40 m grid. A clearance test then touches the ~20
   * segments near the point instead of all 4,000, which is the difference between a site search that
   * costs a second and one that costs a frame.
   */
  private roadSegments() {
    if (this.roadGrid) return this.roadGrid;
    const CELL = 40;
    const grid = new Map<string, number[]>();
    const segs: number[] = [];
    // A mapped arterial carries 3.8 m of trotoar beyond its kerb - further out than the carriageway
    // the road list measures. A street the kit lays has to clear that paving, not just the asphalt:
    // without the extra 3.9 m a run could stand its own trotoar inside the arterial's, and then
    // `groundHeightAt` answered 26 cm where the kit's props stood at 17.
    const walkPaths = new Set(WALK_ROADS.map((w) => w.path));
    const lanes: { path: [number, number][]; width: number; extra: number }[] = [
      ...this.roads.map((r) => ({ path: r.path as [number, number][], width: r.width, extra: walkPaths.has(r.path) ? 3.9 : 0 })),
      ...RIVERS.map((v) => ({ path: v.path as [number, number][], width: v.width, extra: 4 })),
    ];
    for (const r of lanes) {
      for (let s = 0; s < r.path.length - 1; s++) {
        const [x1, z1] = r.path[s];
        const [x2, z2] = r.path[s + 1];
        const clearance = r.width / 2 + r.extra;
        const i = segs.length;
        segs.push(x1, z1, x2, z2, clearance);
        const pad = clearance + 12;
        const i0 = Math.floor((Math.min(x1, x2) - pad) / CELL);
        const i1 = Math.floor((Math.max(x1, x2) + pad) / CELL);
        const j0 = Math.floor((Math.min(z1, z2) - pad) / CELL);
        const j1 = Math.floor((Math.max(z1, z2) + pad) / CELL);
        for (let a = i0; a <= i1; a++) {
          for (let b = j0; b <= j1; b++) {
            const k = a + ',' + b;
            const list = grid.get(k);
            if (list) list.push(i);
            else grid.set(k, [i]);
          }
        }
      }
    }
    this.roadGrid = { grid, segs, CELL };
    return this.roadGrid;
  }

  /** how far the ground stays clear of everything, walking out from (x, z) */
  streetReach(x: number, z: number, dx: number, dz: number, step = 3) {
    let d = 0;
    while (d <= 126 && this.streetClear(x + dx * d, z + dz * d)) d += step;
    return d;
  }

  /**
   * A crossing of the 90 m block lattice with enough clear ground for a junction and four runs.
   *
   * The corridor between two rows of blocks is 24-30 m wide and the map's local streets cut across it
   * every 112 m, so where a street fits is not where the lattice says it should: the search walks a
   * +-8 m lateral offset grid around each crossing and keeps the first site whose every approach is
   * clear far enough to be a street and not a stub. Deterministic for a given city - the lattice is
   * fixed, only block sizes and their +-3 m jitter move.
   */
  streetKitSite() {
    const PITCH_BLOCK = 90;
    const xs = new Set<number>();
    const zs = new Set<number>();
    for (const b of this.blocks) {
      xs.add(Math.round(b.x / PITCH_BLOCK) * PITCH_BLOCK + PITCH_BLOCK / 2);
      zs.add(Math.round(b.z / PITCH_BLOCK) * PITCH_BLOCK + PITCH_BLOCK / 2);
    }
    const spots: { x: number; z: number; d: number }[] = [];
    for (const ox of [0, 4, -4, 8, -8]) {
      for (const oz of [0, 4, -4, 8, -8]) {
        for (const x of xs) {
          for (const z of zs) {
            const px = x + ox;
            const pz = z + oz;
            const d = Math.hypot(px, pz);
            if (d > 760) continue;
            if (!this.streetClear(px, pz)) continue;
            spots.push({ x: px, z: pz, d });
          }
        }
      }
    }
    spots.sort((a, b) => a.d - b.d);
    // coarse pass: rank by how much room there is, and prefer the site squeezed between two block
    // rows (a 9-15 m margin either side) over one standing in a void - a street with no blocks on it
    // is a road in a field
    const coarse = spots.map((s) => {
      const m = Math.min(
        this.streetReach(s.x, s.z, 1, 0, 12),
        this.streetReach(s.x, s.z, -1, 0, 12),
        this.streetReach(s.x, s.z, 0, -1, 12),
        this.streetReach(s.x, s.z, 0, 1, 12)
      );
      let gap = 999;
      for (const b of this.blocks) {
        const half = (b.size ?? BLOCK) / 2;
        gap = Math.min(gap, Math.max(Math.abs(s.x - b.x) - half, Math.abs(s.z - b.z) - half));
      }
      return { ...s, m, gap };
    });
    const usable = coarse.filter((s) => s.m >= 36).sort((a, b) => a.gap - b.gap || a.d - b.d);
    let fallback: { x: number; z: number; e: number; w: number; n: number; s: number; min: number } | null = null;
    for (const s of usable.slice(0, 8)) {
      const e = this.streetReach(s.x, s.z, 1, 0);
      const w = this.streetReach(s.x, s.z, -1, 0);
      const n = this.streetReach(s.x, s.z, 0, -1);
      const so = this.streetReach(s.x, s.z, 0, 1);
      const min = Math.min(e, w, n, so);
      if (min >= 40) return { x: s.x, z: s.z, e, w, n, s: so };
      if (min >= 26 && (!fallback || min > fallback.min)) fallback = { x: s.x, z: s.z, e, w, n, s: so, min };
    }
    return fallback;
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
    for (const [ox, oz, w, d] of cells) {
      // no height here: the archetype decides how tall its lot may be, and the mixer decides the
      // archetype, so one block cannot come out as one height band. Full-cycle mode: six
      // consecutive lots hold six different buildings, so a block with eight lots is a mix and not
      // a repeat (the fits filter drops what the lot is too small for).
      this.makeBuilding(cx + ox, cz + oz, w, d, cx, cz);
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
        const wall = pick(style.walls as number[]);
        // the tile is per storey already; do NOT mutate tex.repeat here, the texture is cached and
        // shared with every other 'strips' wall in the city
        const tex = windowTexture(wall, 'strips');
        const houseGeo = new THREE.BoxGeometry(houseW, h, houseD);
        tileBoxUV(houseGeo, 1, Math.max(1, Math.round(h / 3.2)));
        const body = new THREE.Mesh(
          houseGeo,
          [new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 }), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 }),
           new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.95 }), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 }),
           new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 }), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 })]
        );
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
   * The archetype picker for one block or one street row.
   *
   * A weighted draw per lot happily returns the same type four lots running, which is the wall of
   * identical boxes this card is about; the mixer bans its last two picks, so the shortest cycle is
   * three lots and a block is a mix by construction. State lives per block (or per row), because
   * the point is that NEIGHBOURS differ — two corners of the map may legitimately be the same type.
   */
  mixerFor(scope: string, district: string | null, full = false): ArchetypeMixer {
    let m = this.facadeMixers.get(scope);
    if (!m) {
      m = new ArchetypeMixer(district, full);
      this.facadeMixers.set(scope, m);
    }
    return m;
  }

  /** Detail geometry, bucketed by the block group it belongs to and the material it will draw with. */
  pushFacadeDetail(key: string, geo: THREE.BufferGeometry) {
    let perGroup = this.facadeDetailBuckets.get(this.group);
    if (!perGroup) {
      perGroup = new Map();
      this.facadeDetailBuckets.set(this.group, perGroup);
    }
    const list = perGroup.get(key) ?? [];
    list.push(geo);
    perGroup.set(key, list);
  }

  /**
   * One building: its mass, then the street of its archetype.
   *
   * The body merges into a mesh per wall material per block (so a block still culls by distance);
   * the detail merges into one mesh per detail material for the whole block. That is what lets six
   * archetypes with rails, cornices, awnings and shutters cost a handful of draw calls instead of
   * tens per building.
   */
  addFacade(plan: FacadePlan) {
    const { wall, spec } = plan;
    // one tile is about one storey of one bay, tiled through the geometry's UVs (tileBoxUV) rather
    // than the texture's repeat: the material key stays (wall, type), so bodies still merge
    const tex = windowTexture(wall, spec.tile);
    const emis = emissiveTexture();
    const matKey = `${wall}|${spec.tile}`;
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

    const bucket = this.buildingBuckets.get(this.group) ?? new Map();
    const entry = bucket.get(matKey) ?? { mat: sideMat, geos: [] };
    const m = new THREE.Matrix4().makeRotationY(plan.yaw).setPosition(plan.x, plan.y, plan.z);
    for (const b of archetypeBody(plan)) {
      const g = new THREE.BoxGeometry(b.w, b.h, b.d);
      tileBoxUV(g, Math.max(1, Math.round(b.w / 3.4)), Math.max(1, Math.round(b.h / 3.4)));
      g.translate(b.x, b.y, b.z);
      g.applyMatrix4(m);
      entry.geos.push(g);
    }
    bucket.set(matKey, entry);
    this.buildingBuckets.set(this.group, bucket);

    buildFacadeDetail(plan, (key, geo) => this.pushFacadeDetail(key, geo));
    this.facadeAudit.push({
      archetype: spec.id,
      source: plan.source || 'block',
      x: plan.x,
      // plan.y is local to the group the geometry merges into, and a block group is lifted to its
      // terrain height: the audit has to carry the WORLD ground height or a proof camera aims at a
      // facade one hill-height too low
      y: plan.y + this.group.position.y,
      z: plan.z,
      yaw: plan.yaw,
      w: plan.w,
      d: plan.d,
      h: plan.h,
      wall,
      trim: plan.trim,
    });
  }

  /** Merge every detail bucket once the city is laid out: one mesh per material per block group. */
  finalizeFacadeDetails() {
    for (const [group, perGroup] of this.facadeDetailBuckets) {
      for (const [key, geos] of perGroup) {
        if (!geos.length) continue;
        const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
        if (!merged) continue;
        const mesh = new THREE.Mesh(merged, facadeMaterial(key));
        mesh.name = `facade-detail:${key}`;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
        for (const g of geos) g.dispose();
      }
    }
    this.facadeDetailBuckets.clear();
    // signs and painted walls are lit after dark, like the windows they sit between
    for (const key of facadeEmissiveKeys()) {
      const mat = facadeMaterial(key);
      if (mat instanceof THREE.MeshStandardMaterial) this.emissiveMats.push(mat);
    }
  }

  makeBuilding(x: number, z: number, w: number, d: number, blockX = x, blockZ = z) {
    // One gate for every placement path. Block lots and street frontage both come through
    // here and each used to check only its own clearance: 462 pairs of buildings were
    // interpenetrating, the worst by 20 m, some sites used twice at identical coordinates.
    const rect = { minX: x - w / 2 - 0.4, maxX: x + w / 2 + 0.4, minZ: z - d / 2 - 0.4, maxZ: z + d / 2 + 0.4 };
    for (const f of this.footprints) {
      if (rect.minX < f.maxX && rect.maxX > f.minX && rect.minZ < f.maxZ && rect.maxZ > f.minZ) return null;
    }
    if (this.onRoad(x, z, 5.4)) return null;   // 3.6 m trotoar + ~1.8 m setback
    this.footprints.push(rect);

    // The type comes first, then its height and colour: a district's taste picks the archetype, and
    // the archetype decides how tall the lot may be. A warung in a 16 m cell is not a warung.
    const district = districtAtPoint(x, z);
    const spec = this.mixerFor(`block:${Math.round(blockX)}:${Math.round(blockZ)}`, district, true).next(
      (s) => s.w[0] <= w + 4 && (s.id !== 'warung' || w <= 9)
    );
    const fw = Math.min(w, rand(spec.w[0], spec.w[1]));
    const fd = Math.min(d, rand(spec.d[0], spec.d[1]));
    const fh = rand(spec.h[0], spec.h[1]);
    const wall = pick(spec.walls);
    const trim = trimFor(spec, wall);

    // the entrance, and therefore the street facade, faces away from the block centre
    const dx = x - blockX;
    const dz = z - blockZ;
    const faceX = Math.abs(dx) > Math.abs(dz);
    const outward = (faceX ? dx : dz) >= 0 ? 1 : -1;
    const nx = faceX ? outward : 0;
    const nz = faceX ? 0 : outward;
    const doorYaw = Math.atan2(nx, nz);
    const tx = nz; // tangent along the facade
    const tz = -nx;
    // a shop's door is in the middle of its frontage; anything else gets a side entrance
    const offAlong = spec.retail ? 0 : faceX ? -fd * 0.22 : -fw * 0.22;
    const doorX = faceX ? x + nx * (fw / 2 + 0.02) : x + offAlong;
    const doorZ = faceX ? z + offAlong : z + nz * (fd / 2 + 0.02);

    // local -Z is the street face, so the row is turned by the outward normal
    this.addFacade({
      x,
      y: 0.2,
      z,
      yaw: Math.atan2(-nx, -nz),
      w: fw,
      d: fd,
      h: fh,
      wall,
      trim,
      spec,
      seed: Math.round(x * 7 + z * 13),
      source: 'block',
    });

    this.doorMatrices.push(new THREE.Matrix4().makeRotationY(doorYaw).setPosition(doorX + nx * 0.06, 1.42, doorZ + nz * 0.06));
    this.handleMatrices.push(
      new THREE.Matrix4().makeTranslation(doorX + tx * 0.45 + nx * 0.14, 1.35, doorZ + tz * 0.45 + nz * 0.14)
    );
    // remember this entrance as an enterable shop
    if (spec.retail && fw > 6.5 && fd > 6.5) {
      const kind = SHOP_KINDS[this.shopDoorKindCursor++ % SHOP_KINDS.length];
      const room = this.roomFor(kind);
      if (room) {
        // two doors inside a few metres make "nearest shop" ambiguous, so only the first one
        // becomes enterable; the shopfront sign still goes up either way
        const ex = doorX + nx * 1.1;
        const ez = doorZ + nz * 1.1;
        const crowded = this.shopDoors.some((dd) => Math.hypot(dd.x - ex, dd.z - ez) < 8);
        if (!crowded) this.shopDoors.push({ x: ex, z: ez, nx, nz, kind, name: room.name });
        // physical shop sign above the door so the street reads Indonesian, and so the shop you
        // are about to enter is named on the wall
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
          board.position.set(doorX + nx * 0.2, 2.95, doorZ + nz * 0.2);
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
      const m2 = new THREE.Matrix4().makeRotationY(doorYaw);
      m2.setPosition(doorX + nx * (0.28 + s2 * 0.28), 0.2 + s2 * 0.13, doorZ + nz * (0.28 + s2 * 0.28));
      this.stepMatrices.push({ m: m2, scale: 1.9 - s2 * 0.25 });
    }

    this.colliders.push({
      minX: x - fw / 2,
      maxX: x + fw / 2,
      minZ: z - fd / 2,
      maxZ: z + fd / 2,
      h: fh + 0.2,
    });

    // remember which facade faces the street so spanduk banners can be strung there
    this.facades.push({ x, z, w: fw, d: fd, faceX, dir: outward });
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
      // the block group is lifted to the terrain at its centre, and this tree stands at the edge:
      // sample the surface under the trunk and convert it into the group's frame
      const gy = this.localGroundY(tx, tz);
      const trunk = new THREE.Matrix4().makeTranslation(tx, gy + 1.8 * s, tz);
      trunk.scale(new THREE.Vector3(s, s, s));
      this.treeTrunks.push(trunk);
      const crown = new THREE.Matrix4().makeTranslation(tx, gy + 4.3 * s, tz);
      crown.scale(new THREE.Vector3(s, s, s));
      this.treeCrowns.push(crown);
    }
  }

  /**
   * The ground under (x,z), expressed in the local frame of the group currently being built.
   *
   * `this.group` is swapped to a block group while the city generates, and that group is lifted to
   * `terrainHeight` at the block's CENTRE (see buildBlocks). A prop 13 m away therefore sees a
   * local zero that is not the ground under its own footprint: the trees in the parks and lots
   * stood a fixed 0.28 m over that local zero, which is 0.4-0.7 m of daylight on a slope.
   * `tests/world/placement.mjs` reports it as a floating pier, because a 3 m trunk is a thin tall
   * column. Anything added to a lifted group has to convert the world height back into local.
   */
  private localGroundY(x: number, z: number): number {
    let y = 0;
    for (let g: THREE.Object3D | null = this.group; g; g = g.parent) y += g.position.y;
    return this.groundHeightAt(x, z) - y;
  }

  /**
   * A tree, seated on the ground under its own trunk.
   *
   * A block group is lifted to the terrain height at the block's CENTRE, and the park/lot tree
   * stands up to 13 m away, so the group's local zero is not the ground under this trunk. The
   * previous build put every trunk at a fixed 0.28 m over that local zero, which on a hillside is
   * up to 1.2 m of daylight under the bark - `tests/world/placement.mjs` reports it as a floating
   * pier because a 4 m trunk is a thin tall column.
   */
  tree(x: number, z: number, scale = 1) {
    const base = this.localGroundY(x, z);
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22 * scale, 0.32 * scale, 3.2 * scale, 6),
      new THREE.MeshStandardMaterial({ color: 0x6b4f34, roughness: 1 })
    );
    trunk.position.set(x, base + 1.6 * scale, z);
    trunk.castShadow = true;
    this.group.add(trunk);
    const leafMat = new THREE.MeshStandardMaterial({ color: pick([0x2bae4a, 0x1c7c3b, 0x39c455]), roughness: 1, flatShading: true });
    for (let i = 0; i < 2; i++) {
      const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(rand(1.5, 2.1) * scale, 0), leafMat);
      leaf.position.set(x + rand(-0.5, 0.5) * scale, base + (3.4 + i * 1.2) * scale, z + rand(-0.5, 0.5) * scale);
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
        for (const side of [-1, 1]) {
          // one mixing run per road side, in full-cycle mode: six neighbours are six types, which is
          // the mix a street wall needs (a block interior keeps a plain weighted draw)
          const mixer = this.mixerFor(`row:${road.path[i]}:${i}:${side}`, districtAtPoint(x1 + nx * side * 12, z1 + nz * side * 12), true);
          let t = 6;
          while (t < len - 6) {
            // The type decides the lot: a warung wants 5 m of frontage and a slab wants 30, which
            // is why the row used to be a uniform band of one width and one height. peek(), not
            // next(): a lot rejected by the gates below must not spend the type.
            const spec = mixer.peek();
            const w = rand(spec.w[0], spec.w[1]);      // frontage width along the street
            const d = rand(spec.d[0], spec.d[1]);      // depth behind the facade
            const h = rand(spec.h[0], spec.h[1]);
            const px = x1 + dx * (t + w / 2) + nx * side * (road.width / 2 + 6.2 + d / 2);
            const pz = z1 + dz * (t + w / 2) + nz * side * (road.width / 2 + 6.2 + d / 2);
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
              mixer.commit(spec);
              const wall = pick(spec.walls);
              const trim = trimFor(spec, wall);
              // local -Z must face the road, or the frontage turns its back on the street: the old
              // row was rotated by the direction of travel, so every shopfront plate and window
              // faced down the road and the street saw a blank flank.
              const yaw = Math.atan2(side * nx, side * nz);
              this.addFacade({
                x: px,
                y: terrainHeight(px, pz) + 0.3,
                z: pz,
                yaw,
                w,
                d,
                h,
                wall,
                trim,
                spec,
                seed: Math.round(px * 7 + pz * 13),
                source: 'frontage',
              });
              // collider in world space (axis-aligned box around the rotated footprint)
              const halfX = (Math.abs(Math.cos(yaw)) * w + Math.abs(Math.sin(yaw)) * d) / 2;
              const halfZ = (Math.abs(Math.sin(yaw)) * w + Math.abs(Math.cos(yaw)) * d) / 2;
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
    // and then the kit's trotoar, which is its own raised band along the streets it laid: a player,
    // a prop or an audit row standing on it is WALK_TOP_M above the terrain, not inside the slab
    for (const s of this.streetSpines ?? []) {
      const d = this.spineDistance(x, z, s);
      if (d <= s.half) break; // on the carriageway: the terrain, as every other road here
      if (d <= s.half + KERB_WIDTH + s.walkW) return h + WALK_TOP_M;
    }
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
    for (const m of this.lampMats) m.emissiveIntensity = 0.15 + night * 2.2;

    if (this.focusTarget) this.updateNightLights(dayT, this.focusTarget);

    const dist = 130;
    this.sun.position.set(sunX * dist, Math.max(8, sunY * 130), 42);
  }

}