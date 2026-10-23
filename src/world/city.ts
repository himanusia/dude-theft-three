import { POIS } from './jakartamap';
import { buildHalte } from './halte';
import { buildKakiLima, buildSppg, buildKoperasi, KakiLimaKind } from './kakilima';
import { TransjakartaBus } from '../vehicles/transjakarta';
import { buildLayang } from './layang';
import { buildKrl } from './krl';
import { buildMinimarket } from './minimarket';
import { buildPosPolisi } from './pospolisi';
import { buildRumahPadang } from './rumahpadang';
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


/** Roller-shutter shopfront, shared by every frontage building. */
let shutterMat: THREE.MeshStandardMaterial | null = null;
function shopfrontMat(): THREE.MeshStandardMaterial {
  if (shutterMat) return shutterMat;
  const tex = canvasTexture(256, 128, (ctx, w, h) => {
    // painted fascia
    ctx.fillStyle = '#d8cfb8';
    ctx.fillRect(0, 0, w, h * 0.34);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(0, h * 0.34 - 3, w, 3);
    // roller door slats
    for (let y = h * 0.34; y < h; y += 7) {
      ctx.fillStyle = (Math.floor(y / 7) % 2) ? '#5a6068' : '#6b727b';
      ctx.fillRect(0, y, w, 5);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(0, y + 5, w, 2);
    }
    // uneven wear so the row is not one clean print
    for (let i = 0; i < 14; i++) {
      ctx.fillStyle = `rgba(0,0,0,${rand(0.03, 0.1)})`;
      ctx.fillRect(rand(0, w), rand(0, h), rand(4, 26), rand(3, 10));
    }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 1);
  shutterMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 });
  return shutterMat;
}

function windowTexture(wall: any, style = 'grid') {
  // A Jakarta facade is mostly wall: plaster, ceramic tile or painted concrete, with windows
  // punched into it. The first version painted glass over almost the whole tile, so every
  // building in the city read as the same dark curtain wall no matter what colour it was
  // given. One tile is now one floor, and the glass is an accent inside the wall.
  const map = canvasTexture(128, 128, (ctx, w, h) => {
    const c = typeof wall === 'number' ? `#${wall.toString(16).padStart(6, '0')}` : String(wall);
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, w, h);

    // grime and patina, so the wall is not a flat poster colour
    for (let i = 0; i < 30; i++) {
      ctx.fillStyle = `rgba(0,0,0,${rand(0.015, 0.05)})`;
      ctx.fillRect(rand(0, w), rand(0, h), rand(1, 6), rand(4, h));
    }

    const glass = (x: number, y: number, ww: number, wh: number) => {
      const g = ctx.createLinearGradient(x, y, x + ww, y + wh);
      g.addColorStop(0, '#7c9cb4');
      g.addColorStop(0.45, '#4d6b83');
      g.addColorStop(1, '#33495c');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, ww, wh);
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fillRect(x, y, ww, Math.max(1, wh * 0.22));
    };

    if (style === 'bands') {
      // ONE floor per tile. The tile used to hold four 32 px rows while the mesh mapped it to a
      // single 3.2 m floor, so the facade came out as horizontal stripes every 80 cm instead of
      // a window band per storey.
      // four panes with mullions, not one 8 m strip: a single opening read as a painted band
      const panes = 4;
      const gap = 10;
      const pw = (w - gap * (panes + 1)) / panes;
      for (let i = 0; i < panes; i++) {
        glass(gap + i * (pw + gap), h * 0.28, pw, h * 0.3);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.fillRect(0, h - 6, w, 6);
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(0, h - 8, w, 2);
      return;
    }
    if (style === 'strips') {
      // punched vertical windows between wide piers
      for (let x = 14; x < w - 18; x += 34) {
        glass(x, 10, 10, h - 22);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      ctx.fillRect(0, 0, w, 6);
      return;
    }
    // grid: small windows in plaster, the common shophouse/office look
    const cols = 3;
    const rows = 3;
    const cw = w / cols;
    const ch = h / rows;
    for (let x = 0; x < cols; x++) {
      for (let y = 0; y < rows; y++) {
        const ww = cw * 0.36;
        const wh = ch * 0.34;
        glass(x * cw + (cw - ww) / 2, y * ch + ch * 0.26, ww, wh);
        // frame
        ctx.strokeStyle = 'rgba(0,0,0,0.22)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x * cw + (cw - ww) / 2, y * ch + ch * 0.26, ww, wh);
      }
    }
  });
  return map;
}
function shopTexture(hue: any) {
  return canvasTexture(256, 64, (ctx, w, h) => {
    // facade base
    ctx.fillStyle = hue.wall;
    ctx.fillRect(0, 0, w, h);
    // awning stripe
    ctx.fillStyle = hue.awning;
    ctx.fillRect(0, 0, w, 12);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    for (let x = 0; x < w; x += 16) ctx.fillRect(x, 0, 8, 12);
    // shop windows
    const panes = 4;
    const pw = w / panes;
    for (let i = 0; i < panes; i++) {
      const x = i * pw + 6;
      const y = 16;
      const ww = pw - 12;
      const wh = h - y - 6;
      const g = ctx.createLinearGradient(x, y, x + ww, y + wh);
      g.addColorStop(0, 'rgba(255,226,160,0.95)');
      g.addColorStop(0.45, 'rgba(160,205,225,0.85)');
      g.addColorStop(1, 'rgba(70,95,115,0.95)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, ww, wh);
      // door frame on the second pane
      ctx.strokeStyle = 'rgba(20,22,26,0.85)';
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, ww, wh);
      if (i === 1) {
        ctx.fillStyle = 'rgba(30,34,40,0.9)';
        ctx.fillRect(x + ww * 0.3, y + wh * 0.1, ww * 0.4, wh * 0.9);
        ctx.fillStyle = 'rgba(200,220,235,0.5)';
        ctx.fillRect(x + ww * 0.33, y + wh * 0.15, ww * 0.34, wh * 0.5);
      }
    }
  });
}

function emissiveTexture() {
  return canvasTexture(128, 128, (ctx, w, h) => {
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
}

type InstancedAdder = (
  geo: THREE.BufferGeometry,
  material: THREE.Material,
  matrices: THREE.Matrix4[],
  cast?: boolean,
  name?: string,
  audit?: boolean
) => THREE.InstancedMesh | null;

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
  declare shopTextures: THREE.Texture[];
  declare shopMats: THREE.MeshStandardMaterial[];
  declare focusTarget: THREE.Vector3;
  declare daylight: number;
  declare rootGroup: THREE.Group;
  /** shopfront rings, merged into one mesh at the end of the block pass */
  declare shopfrontGeos: THREE.BufferGeometry[];
  declare propAudit: { name: string; x: number; z: number; bottom: number }[];
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
    const hemi = new THREE.HemisphereLight(0xbfe6ff, 0x59a05e, 1.15);
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
      const ctx = { group: lmGroup, colliders: this.colliders, audit: this.propAudit };
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
    this.buildKrlLine();

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
          this.dashMatrices.push(new THREE.Matrix4().compose(new THREE.Vector3(x, terrainHeight(x, z) + 0.075, z), q, new THREE.Vector3(1, 1, 1)));
        }
      }
    }
    const dashMesh = new THREE.InstancedMesh(dashGeo, dashMat, this.dashMatrices.length);
    this.dashMatrices.forEach((m, i) => dashMesh.setMatrixAt(i, m));
    dashMesh.instanceMatrix.needsUpdate = true;
    dashMesh.receiveShadow = true;
    dashMesh.frustumCulled = false;
    this.group.add(dashMesh);

    // crosswalks at intersections (instanced)
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0xe4e2ea, roughness: 0.85 });
    const stripeGeo = new THREE.BoxGeometry(0.7, 0.02, 3.2);
    const stripeMatrices = [];
    for (let i = -GRID - 1; i <= GRID; i++) {
      for (let j = -GRID - 1; j <= GRID; j++) {
        const x = (i + 0.5) * PITCH;
        const z = (j + 0.5) * PITCH;
        for (let k = -3; k <= 3; k++) {
          stripeMatrices.push(
            new THREE.Matrix4().makeTranslation(x + k * 1.7, 0.03, z + BLOCK * 0.5 + ROAD * 0.5 + 1.4)
          );
          const rot = new THREE.Matrix4().makeRotationY(Math.PI / 2);
          rot.setPosition(x + BLOCK * 0.5 + ROAD * 0.5 + 1.4, 0.03, z + k * 1.7);
          stripeMatrices.push(rot);
        }
      }
    }
    const stripeMesh = new THREE.InstancedMesh(stripeGeo, stripeMat, stripeMatrices.length);
    stripeMatrices.forEach((m, i) => stripeMesh.setMatrixAt(i, m));
    stripeMesh.instanceMatrix.needsUpdate = true;
    stripeMesh.frustumCulled = false;
    this.group.add(stripeMesh);

    this.buildEntranceInstances();
    this.buildLampInstances();
    this.buildTreeInstances();
    this.buildNightLights();
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
  snapToVerge(x: number, z: number): { x: number; z: number; yaw: number } | null {
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
    const off = best.half + 1.9 + 1.6;          // middle of the 3.6 m pavement
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
        if (free(px, pz) && !isWater(px, pz)) return { x: px, z: pz, yaw: best.yaw };
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
        const g = buildKakiLima(ctx, carts[placedCarts % carts.length], spot.x, spot.z, spot.yaw + Math.PI / 2);
        this.placeOnGround(g, spot.x, spot.z);
        placedCarts++;
      }
    }

    // the two institutions: a nutrition kitchen by the Blok M terminal, a koperasi in Kemang
    const blokM = POIS.find((p) => p.name.startsWith('Terminal Blok M'));
    if (blokM) {
      const spot = this.snapToVerge(blokM.x, blokM.z + 26);
      if (spot) {
        const g = buildSppg(ctx, spot.x + 4, spot.z, spot.yaw);
        this.placeOnGround(g, spot.x, spot.z);
      }
    }
    // One minimarket on a fixed, verifiable site: 22 m up the spawn street, facing back at the
    // player. Automatic placement put this asset in the wrong place five times, so the first one
    // is placed by hand and photographed before anything else uses snapToVerge.
    const sp = this.getSpawn();
    const mg = buildMinimarket(ctx, sp.x, sp.z + 22, Math.PI, 'INDOMERET');
    this.placeOnGround(mg, sp.x, sp.z + 22);
    // police post beside the minimarket, on the first slot that clears every collider
    for (const [dx, dz] of [[13, 0], [17, 0], [21, 0], [-13, 0], [-17, 0], [13, 12], [13, -12], [0, 16]]) {
      const cx = sp.x + dx, cz = sp.z + 22 + dz;
      if (this.nearLayang(cx, cz, 14)) continue;
      if (this.colliders.some((c) => cx > c.minX - 8 && cx < c.maxX + 8 && cz > c.minZ - 8 && cz < c.maxZ + 8)) continue;
      const pg = buildPosPolisi(ctx, cx, cz, 0);
      this.placeOnGround(pg, cx, cz);
      break;
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
      const cx = sp.x + dx, cz = sp.z + 22 + dz;
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
      { deckY: 9.5, width: 21, pierEvery: 26 }
    );
  }


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
    let placed = 0;
    for (const poi of POIS) {
      if (poi.kind !== 'kaki5' && poi.kind !== 'terminal') continue;
      if (placed >= 3) break;
      placed++;
      for (let i = 0; i < 2; i++) {
        const spot = this.snapToVerge(poi.x + i * 3.2 - 1.6, poi.z + 6);
        if (!spot) continue;
        const bike = new Ojek({ color: i === 0 ? 0xc0392b : 0x1f6f4a });
        bike.group.rotation.y = spot.yaw + Math.PI / 2 + i * 0.1;
        this.group.add(bike.group);
        this.propAudit.push({ name: 'ojek', x: spot.x, z: spot.z, bottom: 0 });
        this.placeOnGround(bike.group, spot.x, spot.z);
        this.colliders.push({ minX: spot.x - 0.55, maxX: spot.x + 0.55, minZ: spot.z - 1.1, maxZ: spot.z + 1.1, h: 1.6 });
      }
    }
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

  /** One flat ribbon per road and river: quad strips merged into a single geometry each. */
  /**
   * A road surface that follows the terrain.
   *
   * The heightfield is a coarse mesh, so a ribbon built one quad per path segment floats or sinks
   * wherever the ground bulges between its corners. Every segment is therefore cut into ~8 m
   * pieces and each piece samples the ground on both kerbs, which is what keeps the carriageway
   * visible instead of buried under the terrain.
   */
  ribbon(points: [number, number][], width: number, y: number): THREE.BufferGeometry {
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const [x1, z1] = points[i];
      const [x2, z2] = points[i + 1];
      const dx = x2 - x1;
      const dz = z2 - z1;
      const len = Math.hypot(dx, dz) || 1;
      const nx = (-dz / len) * (width / 2);
      const nz = (dx / len) * (width / 2);
      const steps = Math.max(1, Math.ceil(len / 8));
      for (let k = 0; k < steps; k++) {
        const t0 = k / steps;
        const t1 = (k + 1) / steps;
        const ax = x1 + dx * t0;
        const az = z1 + dz * t0;
        const bx = x1 + dx * t1;
        const bz = z1 + dz * t1;
        const base = pos.length / 3;
        pos.push(
          ax + nx, y + terrainHeight(ax + nx, az + nz), az + nz,
          ax - nx, y + terrainHeight(ax - nx, az - nz), az - nz,
          bx + nx, y + terrainHeight(bx + nx, bz + nz), bz + nz,
          bx - nx, y + terrainHeight(bx - nx, bz - nz), bz - nz
        );
        idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
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
    const asphalt = new THREE.MeshStandardMaterial({ color: 0x1b1f24, roughness: 1 });
    const ring = new THREE.MeshStandardMaterial({ color: 0x1e2228, roughness: 0.98 });
    const water = new THREE.MeshStandardMaterial({ color: 0x2f6577, roughness: 0.2, metalness: 0.35 });
    for (const st of LOCAL_STREETS) {
      const m = new THREE.Mesh(this.ribbon(st.path as [number, number][], st.width, 0.05), asphalt);
      m.receiveShadow = true;
      this.group.add(m);
    }
    for (const a of ARTERIALS) {
      const m = new THREE.Mesh(this.ribbon(a.path, a.width, 0.05), asphalt);
      m.receiveShadow = true;
      this.group.add(m);
    }
    const r = new THREE.Mesh(this.ribbon(RING_ROAD, 20, 0.06), ring);
    r.receiveShadow = true;
    this.group.add(r);

    // Pavements. Without a kerb the buildings meet the asphalt and every street reads as a
    // corridor between walls; Jakarta roads all have a raised trotoar with a kerb stone.
    const trotoar = new THREE.MeshStandardMaterial({ color: 0x9d988c, roughness: 0.98 });
    const kerbMat = new THREE.MeshStandardMaterial({ color: 0xd6d0c2, roughness: 0.95 });
    for (const road of [...ARTERIALS.map((a) => ({ path: a.path as [number, number][], width: a.width })), { path: RING_ROAD as [number, number][], width: 20 }]) {
      for (const side of [-1, 1]) {
        const walk = this.offsetPath(road.path, side * (road.width / 2 + 1.9));
        const m = new THREE.Mesh(this.ribbon(walk, 3.6, 0.26), trotoar);
        m.receiveShadow = true;
        this.group.add(m);
        // the kerb face itself, 12 cm proud of the walk
        const edge = this.offsetPath(road.path, side * (road.width / 2 + 0.15));
        const k = new THREE.Mesh(this.ribbon(edge, 0.3, 0.28), kerbMat);
        k.receiveShadow = true;
        this.group.add(k);
      }
    }
    for (const rv of RIVERS) {
      const m = new THREE.Mesh(this.ribbon(rv.path, rv.width, 0.05), water);
      m.receiveShadow = true;
      this.group.add(m);
    }
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
      const [lo, hi] = style.heights;
      const h = rand(lo, hi);
      this.makeBuilding(cx + ox, cz + oz, w, d, h, cx, cz, style);
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
        const wall = pick(style.walls);
        const tex = windowTexture(wall, 'strips');
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(1.4, 1.1);
        const body = new THREE.Mesh(
          new THREE.BoxGeometry(houseW, h, houseD),
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
   * Facade profile per district. A ruko in Glodok is a narrow shophouse with small windows and a
   * shutter; a tower in Thamrin is glass; Kota Tua is white plaster under clay tiles; a kampung
   * house is plaster with a couple of small openings. One recipe for the whole city is what made
   * every street look alike.
   */
  facadeProfile(district: string | null, h: number): { walls: number[]; style: 'grid' | 'strips' | 'bands'; shopfront: boolean } {
    switch (district) {
      case 'kotatua':
        return { walls: [0xe9e3d3, 0xf1ece0, 0xded6c4], style: 'grid', shopfront: true };
      case 'glodok':
      case 'blokm':
      case 'tanahabang':
        return { walls: [0xd9cfb8, 0xc8b99c, 0xb8c4c9, 0xd6c2a8, 0xc9a98f], style: 'grid', shopfront: true };
      case 'kampung':
        return { walls: [0xdcd2bd, 0xc9c3ae, 0xe4d9c2, 0xbfae95], style: 'grid', shopfront: false };
      case 'kemang':
        return { walls: [0xe3d9c4, 0xd3c6ad, 0xcbbfa6], style: 'grid', shopfront: true };
      case 'thamrin':
      case 'monas':
        return { walls: [0xb9c4cf, 0xa9b7c4, 0xc4cdd6], style: h > 30 ? 'bands' : 'strips', shopfront: false };
      default:
        return { walls: [0xd9cdb4, 0xc9d8c4, 0xe4c9c2], style: 'grid', shopfront: true };
    }
  }

  makeBuilding(x: number, z: number, w: number, d: number, h: number, blockX = x, blockZ = z, style: any = null) {
    const chromeLike = new THREE.MeshStandardMaterial({ color: 0xc9ccd2, roughness: 0.35, metalness: 0.7 });
    const prof = this.facadeProfile(districtAtPoint(x, z), h);
    const wall = pick(prof.walls);
    const facade = prof.style;
    const tex = windowTexture(wall, facade);
    const emis = emissiveTexture();
    const rx = Math.max(1, Math.round(w / 6.5));
    const ry = Math.max(1, Math.round(h / 6.5));
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    emis.wrapS = emis.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(rx, ry);
    emis.repeat.set(rx, ry);

    const sideMat = new THREE.MeshStandardMaterial({
      map: tex,
      emissive: 0xffffff,
      emissiveMap: emis,
      emissiveIntensity: 0,
      roughness: 0.82,
      metalness: 0.06,
    });
    this.emissiveMats.push(sideMat);
    const roofMat = new THREE.MeshStandardMaterial({ color: style ? style.roof : 0x4a4a4c, roughness: 0.95 });
    const mats = [sideMat, sideMat, roofMat, roofMat, sideMat, sideMat];

    // Shopfront plinth, added directly to the block group. The merged path produced a mesh that
    // existed in the scene and never drew, three attempts running; a plain mesh that hangs off
    // the same group as the body cannot fail that way. Cost: one draw call per building.
    if (h > 4 && d > 5) {
      const plinth = new THREE.Mesh(new THREE.BoxGeometry(w + 0.34, 3.2, d + 0.34), shopfrontMat());
      plinth.position.set(x, 1.9 + 0.2, z);
      plinth.castShadow = true;
      plinth.receiveShadow = true;
      this.group.add(plinth);
    }

    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats);
    b.position.set(x, h / 2 + 0.2, z);
    b.castShadow = true;
    b.receiveShadow = true;
    this.group.add(b);

    // Roofline by building type. A flat parapet on every box is what made the city read as
    // "all the same": a low shophouse in a kampung has a pitched clay roof, an office tower has
    // a parapet. The roof is the silhouette the eye uses to separate one street from another.
    if (h <= 14) {
      const tileMat = new THREE.MeshStandardMaterial({ color: style ? style.roof : 0x8c4a3a, roughness: 0.95 });
      const pitch = Math.min(2.6, w * 0.16);
      for (const sgn of [-1, 1]) {
        const slope = new THREE.Mesh(new THREE.BoxGeometry(w + 0.7, 0.18, Math.hypot(d / 2 + 0.5, pitch)), tileMat);
        slope.position.set(x, h + 0.2 + pitch / 2, z + sgn * (d / 4 + 0.1));
        slope.rotation.x = sgn * Math.atan2(pitch, d / 2 + 0.5);
        slope.castShadow = true;
        this.group.add(slope);
      }
      // ridge cap
      const ridge = new THREE.Mesh(new THREE.BoxGeometry(w + 0.8, 0.16, 0.34), tileMat);
      ridge.position.set(x, h + 0.2 + pitch, z);
      this.group.add(ridge);
    } else {
      const parapet = new THREE.Mesh(
        new THREE.BoxGeometry(w + 0.34, 0.42, d + 0.34),
        new THREE.MeshStandardMaterial({ color: 0xd2d0d8, roughness: 0.9 })
      );
      parapet.position.set(x, h + 0.12, z);
      parapet.castShadow = true;
      this.group.add(parapet);
    }

    // occasional billboard with real text, like the reference storefronts
    if (Math.random() < 0.6 && h < 34) {
      const words = style ? [...style.signs, 'DISKON', 'MURAH', 'BUKA 24 JAM'] : ['DISKON', 'MURAH', 'PROMO', 'GRATIS ONGKIR', 'BUKA 24 JAM', 'KOPI ENAK', 'SERVIS AC', 'KOSONG'];
      const word = pick(words);
      const bg = pick(['#e94f4f', '#2f6fd0', '#f2b134', '#39b54a', '#8a3ad9']);
      const boardTex = canvasTexture(256, 96, (ctx, cw, ch) => {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, cw, ch);
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(0, ch - 12, cw, 12);
        ctx.fillStyle = '#fff8e7';
        fitFont(ctx, word, cw - 24, 52);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(word, cw / 2, ch / 2);
      });
      const board = new THREE.Mesh(
        new THREE.BoxGeometry(Math.min(w * 0.8, 7), 2.3, 0.22),
        new THREE.MeshStandardMaterial({ map: boardTex, roughness: 0.6, emissive: 0xffffff, emissiveMap: boardTex, emissiveIntensity: 0.08 })
      );
      const faces = [
        [0, d / 2 + 0.12, 0],
        [0, -d / 2 - 0.12, Math.PI],
        [w / 2 + 0.12, 0, Math.PI / 2],
        [-w / 2 - 0.12, 0, -Math.PI / 2],
      ];
      const face = faces[Math.floor(rand(0, 4))];
      board.position.set(x + face[0], Math.min(h - 1.5, 8.5), z + face[1]);
      board.rotation.y = face[2];
      board.castShadow = true;
      this.group.add(board);
    }

    // roof furniture
    if (Math.random() < 0.7) {
      const ac = box(rand(1.5, 3), rand(0.8, 1.4), rand(1.5, 3), 0x6c6f74);
      ac.position.set(x + rand(-w / 3, w / 3), h + 0.2 + (ac.geometry as any).parameters.height / 2, z + rand(-d / 3, d / 3));
      this.group.add(ac);
    }
    if (h > 28 && Math.random() < 0.7) {
      const mast = box(0.22, rand(4, 10), 0.22, 0x8d9199, { metalness: 0.6, roughness: 0.4 });
      mast.position.set(x + rand(-w / 3, w / 3), h + 0.2 + (mast.geometry as any).parameters.height / 2, z + rand(-d / 3, d / 3));
      this.group.add(mast);
    }
    // ground-floor storefront wrap (all sides) + signs
    if (!this.shopTextures) {
      this.shopTextures = [
        shopTexture({ wall: '#5c5650', awning: '#a8352f' }),
        shopTexture({ wall: '#4d5560', awning: '#2f6f7a' }),
        shopTexture({ wall: '#635748', awning: '#b3892f' }),
        shopTexture({ wall: '#4a4f4a', awning: '#3f7a4a' }),
      ];
    }
    const shopTex = pick(this.shopTextures).clone();
    shopTex.needsUpdate = true;
    shopTex.wrapS = shopTex.wrapT = THREE.RepeatWrapping;
    shopTex.repeat.set(Math.max(1, Math.round(Math.max(w, d) / 9)), 1);
    const shopMat = new THREE.MeshStandardMaterial({ map: shopTex, roughness: 0.55, emissive: 0xffffff, emissiveMap: shopTex, emissiveIntensity: 0.06 });
    this.shopMats = this.shopMats || [];
    this.shopMats.push(shopMat);
    const band = new THREE.Mesh(new THREE.BoxGeometry(w + 0.24, 2.9, d + 0.24), shopMat);
    band.position.set(x, 1.45, z);
    band.castShadow = true;
    band.receiveShadow = true;
    this.group.add(band);

    // plesetan, bukan merek asli
    const shopWords = ['ALFAMURTI', 'INDOMERET', 'WARTEG BAHARI', 'BAKSO PAK TJE', 'MIE GACUAN', 'SATE SENAYUN',
      'PULSA PERDANU', 'APOTEK SEHAT', 'BENGKEL AHOS', 'KOPI TUBRUK', 'TOKO EMAS MULYA', 'LAUNDRY KILAT',
      'PANGKAS RAMBUT', 'MARTABAK BANGKOK', 'NASI PADANG SELONGSOR', 'JAMU GENDONG'];
    const word = pick(shopWords);
    const signColor = pick(['#ffd257', '#ff6b6b', '#64d2ff', '#a8ff8f', '#ff9f43', '#f2f2f6']);
    const signTex = canvasTexture(256, 64, (ctx, cw, ch) => {
      ctx.fillStyle = signColor;
      ctx.fillRect(0, 0, cw, ch);
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.fillRect(0, ch - 7, cw, 7);
      ctx.fillStyle = '#241f1a';
      fitFont(ctx, word, cw - 16, 34);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(word, cw / 2, ch / 2 - 1);
    });
    // entrance: the door sits on the facade that faces the street (away from the
    // block centre), so no shop is left facing a neighbour's wall
    const dx = x - blockX;
    const dz = z - blockZ;
    const faceX = Math.abs(dx) > Math.abs(dz);
    const outward = (faceX ? dx : dz) >= 0 ? 1 : -1;
    const nx = faceX ? outward : 0;
    const nz = faceX ? 0 : outward;
    const doorYaw = Math.atan2(nx, nz);
    const tx = nz; // tangent along the facade
    const tz = -nx;
    const doorX = faceX ? x + nx * (w / 2 + 0.02) : x + (w > d ? -w * 0.22 : 0);
    const doorZ = faceX ? z + (d > w ? -d * 0.22 : 0) : z + nz * (d / 2 + 0.02);
    this.doorMatrices.push(new THREE.Matrix4().makeRotationY(doorYaw).setPosition(doorX + nx * 0.06, 1.42, doorZ + nz * 0.06));
    this.handleMatrices.push(
      new THREE.Matrix4().makeTranslation(doorX + tx * 0.45 + nx * 0.14, 1.35, doorZ + tz * 0.45 + nz * 0.14)
    );
    // remember this entrance as an enterable shop
    if (w > 6.5 && d > 6.5) {
      const kind = SHOP_KINDS[this.shopDoorKindCursor++ % SHOP_KINDS.length];
      const room = this.roomFor(kind);
      if (room) {
        // two doors inside a few metres make "nearest shop" ambiguous, so only the first one
        // becomes enterable; the shopfront sign still goes up either way
        const ex = doorX + nx * 1.1;
        const ez = doorZ + nz * 1.1;
        const crowded = this.shopDoors.some((dd) => Math.hypot(dd.x - ex, dd.z - ez) < 8);
        if (!crowded) this.shopDoors.push({ x: ex, z: ez, nx, nz, kind, name: room.name });
        // physical shop sign above the door so the street reads Indonesian
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
          board.position.set(doorX + nx * 0.18, 3.55, doorZ + nz * 0.18);
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
      const m = new THREE.Matrix4().makeRotationY(doorYaw);
      m.setPosition(doorX + nx * (0.28 + s2 * 0.28), 0.2 + s2 * 0.13, doorZ + nz * (0.28 + s2 * 0.28));
      this.stepMatrices.push({ m, scale: 1.9 - s2 * 0.25 });
    }

    const signMat = new THREE.MeshStandardMaterial({
      map: signTex,
      emissive: 0xffffff,
      emissiveMap: signTex,
      emissiveIntensity: 0.12,
      roughness: 0.55,
    });
    for (const side of [1, -1]) {
      const signZ = new THREE.Mesh(new THREE.BoxGeometry(w * rand(0.3, 0.5), 0.72, 0.14), signMat);
      signZ.position.set(x, 3.3, z + side * (d / 2 + 0.2));
      this.group.add(signZ);
      const signX = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.72, d * rand(0.25, 0.4)), signMat);
      signX.position.set(x + side * (w / 2 + 0.2), 3.3, z);
      this.group.add(signX);
    }

    if (Math.random() < 0.5) {
      const awningMat = new THREE.MeshStandardMaterial({ color: pick([0xd94f4f, 0x3f8fbf, 0xe0a83f, 0x4fae6a]), roughness: 0.8 });
      const along = faceX ? d : w;
      const aw = new THREE.Mesh(new THREE.BoxGeometry(along * 0.7, 0.18, 1.6), awningMat);
      aw.position.set(doorX + nx * 0.8, 3.2, doorZ + nz * 0.8);
      aw.rotation.y = doorYaw;
      aw.castShadow = true;
      this.group.add(aw);
    }

    this.colliders.push({
      minX: x - w / 2,
      maxX: x + w / 2,
      minZ: z - d / 2,
      maxZ: z + d / 2,
      h: h + 0.2,
    });

    // remember which facade faces the street so spanduk banners can be strung there
    this.facades.push({ x, z, w, d, faceX, dir: outward });
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
      const trunk = new THREE.Matrix4().makeTranslation(tx, 1.8 * s + 0.26, tz);
      trunk.scale(new THREE.Vector3(s, s, s));
      this.treeTrunks.push(trunk);
      const crown = new THREE.Matrix4().makeTranslation(tx, 4.3 * s + 0.26, tz);
      crown.scale(new THREE.Vector3(s, s, s));
      this.treeCrowns.push(crown);
    }
  }

  tree(x: number, z: number, scale = 1) {
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22 * scale, 0.32 * scale, 3.2 * scale, 6),
      new THREE.MeshStandardMaterial({ color: 0x6b4f34, roughness: 1 })
    );
    trunk.position.set(x, 1.6 * scale + 0.28, z);
    trunk.castShadow = true;
    this.group.add(trunk);
    const leafMat = new THREE.MeshStandardMaterial({ color: pick([0x2bae4a, 0x1c7c3b, 0x39c455]), roughness: 1, flatShading: true });
    for (let i = 0; i < 2; i++) {
      const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(rand(1.5, 2.1) * scale, 0), leafMat);
      leaf.position.set(x + rand(-0.5, 0.5) * scale, (3.4 + i * 1.2) * scale, z + rand(-0.5, 0.5) * scale);
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
    const verge = this.snapToVerge(baseX, baseZ);
    if (verge) return new THREE.Vector3(verge.x, 0, verge.z);
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

  /**
   * A shopfront ring around every block building: the plinth that turns a slab into a ruko.
   * Collected as raw geometry and merged into one mesh, so the whole city's shopfronts cost a
   * single draw call.
   */
  flushShopfronts() {
    if (!this.shopfrontGeos || !this.shopfrontGeos.length) return;
    const merged = mergeGeometries(this.shopfrontGeos, false);
    if (merged) {
      const mesh = new THREE.Mesh(merged, shopfrontMat());
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      (this.rootGroup ?? this.group).add(mesh);
    }
    this.shopfrontGeos.forEach((g) => g.dispose());
    this.shopfrontGeos = [];
  }

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
          let t = 6;
          while (t < len - 6) {
            const w = rand(8, 26);        // frontage width along the street
            const d = rand(12, 20);       // depth behind the facade
            // A real row mixes shop-houses with towers. A 7-26 m band produced one flat
            // skyline; one in five is now a taller building and one in six a low shophouse.
            const r = rand(0, 1);
            const h = r < 0.16 ? rand(4.5, 7) : r < 0.8 ? rand(8, 22) : rand(24, 46);
            const px = x1 + dx * (t + w / 2) + nx * side * (road.width / 2 + 6.2 + d / 2);
            const pz = z1 + dz * (t + w / 2) + nz * side * (road.width / 2 + 6.2 + d / 2);
            const district = districtAtPoint(px, pz);
            const styleKey = (district === 'gambir' ? 'monas' : district) as keyof typeof DISTRICTS;
            const style = DISTRICTS[styleKey] || DISTRICTS.kampung;
            let onRoad = false;
            for (const other of roads) {
              if (this.distToPath(px, pz, other.path) < other.width / 2 + 2) { onRoad = true; break; }
            }
            if (!onRoad && !isWater(px, pz)) {
              const group = new THREE.Group();
              group.position.set(px, terrainHeight(px, pz), pz);
              group.rotation.y = Math.atan2(dx, dz);
              // Facade variety: Jakarta rows are cream, mint, pink and grey shophouses next to
              // tiled offices, not one glass curtain wall repeated. The material is per
              // building anyway, so mixing the palette and the window type costs no draw calls.
              const PASTELS = [0xd9cdb4, 0xe8dfcb, 0xc9d8c4, 0xe4c9c2, 0xb9c7d4, 0xd6c9a8, 0xcfcfc8, 0xb8a894];
              const wall = rand(0, 1) < 0.45 ? pick(PASTELS) : pick(style.walls);
              const facade = pick(['strips', 'grid', 'bands'] as const);
              const tex = windowTexture(wall, facade);
              tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
              // one tile is one floor: ~3.2 m tall, 8 m wide
              tex.repeat.set(Math.max(1, w / 8), Math.max(1, h / 3.2));
              const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 });
              const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
              body.position.y = h / 2 + 0.3;
              body.castShadow = true;
              body.receiveShadow = true;
              group.add(body);
              // a shopfront band at street level so the row is not one blank slab
              const base = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 3.2, 0.3), shopfrontMat());
              base.position.set(0, 1.9, -d / 2 - 0.16);
              group.add(base);

              this.group.add(group);
              // collider in world space (axis-aligned box around the rotated footprint)
              const halfX = (Math.abs(Math.cos(group.rotation.y)) * w + Math.abs(Math.sin(group.rotation.y)) * d) / 2;
              const halfZ = (Math.abs(Math.sin(group.rotation.y)) * w + Math.abs(Math.cos(group.rotation.y)) * d) / 2;
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
    let h = terrainHeight(x, z);
    for (const b of this.blocks) {
      const half = (b.size ?? BLOCK) / 2 + 1.2; // props stand at the plate edge, not the centre
      if (Math.abs(x - b.x) < half && Math.abs(z - b.z) < half) return h + 0.26;
    }
    return h;
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
    this.hemi.groundColor.setHex(daylight > 0.3 ? 0x59a05e : 0x2a2b33);

    this.daylight = daylight;
    const night = 1 - clamp((daylight - 0.05) / 0.4, 0, 1);
    for (const m of this.emissiveMats) m.emissiveIntensity = night * 0.9;
    if (this.shopMats) for (const m of this.shopMats) m.emissiveIntensity = 0.05 + night * 0.9;
    for (const m of this.lampMats) m.emissiveIntensity = 0.15 + night * 2.2;

    if (this.focusTarget) this.updateNightLights(dayT, this.focusTarget);

    const dist = 130;
    this.sun.position.set(sunX * dist, Math.max(8, sunY * 130), 42);
  }

}