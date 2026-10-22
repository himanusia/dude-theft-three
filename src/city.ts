import * as THREE from 'three';
import { clamp, lerp, rand, randInt, pick, TAU, box, canvasTexture, AABB } from './utils';
import { buildInterior, Interior, InteriorKind, PlacedInterior } from './interior';
import { Car } from './car';

export const PITCH = 52;
export const BLOCK = 38;
export const ROAD = PITCH - BLOCK;
export const GRID = 3; // blocks from -3..3 on each axis
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

function windowTexture(wall: any, style = 'grid') {
  const map = canvasTexture(128, 128, (ctx, w, h) => {
    if (style === 'bands') {
      // horizontal ribbon windows, common on the reference city blocks
      ctx.fillStyle = wall;
      ctx.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 32) {
        const g = ctx.createLinearGradient(0, y + 6, 0, y + 26);
        g.addColorStop(0, '#8fb6d8');
        g.addColorStop(0.5, '#5c86a8');
        g.addColorStop(1, '#3f5f7d');
        ctx.fillStyle = g;
        ctx.fillRect(4, y + 6, w - 8, 20);
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        for (let x = 6; x < w - 6; x += 16) ctx.fillRect(x, y + 6, 3, 20);
        ctx.fillStyle = 'rgba(0,0,0,0.16)';
        ctx.fillRect(0, y + 27, w, 5);
      }
      return;
    }
    if (style === 'strips') {
      // vertical glass strips with concrete piers
      ctx.fillStyle = wall;
      ctx.fillRect(0, 0, w, h);
      for (let x = 8; x < w - 8; x += 24) {
        const g = ctx.createLinearGradient(x, 0, x + 14, h);
        g.addColorStop(0, '#9dc4e0');
        g.addColorStop(0.5, '#5f8aa8');
        g.addColorStop(1, '#43637f');
        ctx.fillStyle = g;
        ctx.fillRect(x, 4, 14, h - 8);
        ctx.fillStyle = 'rgba(0,0,0,0.12)';
        for (let y = 6; y < h; y += 18) ctx.fillRect(x, y, 14, 3);
      }
      return;
    }
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, w, h);
    // subtle vertical grime
    for (let i = 0; i < 24; i++) {
      ctx.fillStyle = `rgba(0,0,0,${rand(0.02, 0.07)})`;
      ctx.fillRect(rand(0, w), 0, rand(1, 5), h);
    }
    const cols = 4;
    const rows = 4;
    const pad = 6;
    const cw = w / cols;
    const ch = h / rows;
    for (let x = 0; x < cols; x++) {
      for (let y = 0; y < rows; y++) {
        const wx = x * cw + pad;
        const wy = y * ch + pad;
        const ww = cw - pad * 2;
        const wh = ch - pad * 2.2;
        ctx.fillStyle = '#5c86a8';
        ctx.fillRect(wx, wy, ww, wh);
        // glass sheen
        const g = ctx.createLinearGradient(wx, wy, wx + ww, wy + wh);
        g.addColorStop(0, 'rgba(195,225,255,0.55)');
        g.addColorStop(0.5, 'rgba(110,140,170,0.18)');
        g.addColorStop(1, 'rgba(225,245,255,0.42)');
        ctx.fillStyle = g;
        ctx.fillRect(wx, wy, ww, wh);
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(wx, wy, ww, wh);
        if (Math.random() < 0.35) {
          ctx.fillStyle = 'rgba(255,214,140,0.55)';
          ctx.fillRect(wx + 1, wy + 1, ww - 2, wh - 2);
        }
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
  declare blocks: any[];
  declare roadLines: any[];
  declare jumpPads: any[];
  declare parkedSpots: any[];
  declare emissiveMats: any[];
  declare lampMats: any[];
  declare group: THREE.Group;
  declare shopTextures: THREE.Texture[];
  declare shopMats: THREE.MeshStandardMaterial[];
  declare focusTarget: THREE.Vector3;
  declare daylight: number;
  declare propAudit: { name: string; x: number; z: number; bottom: number }[];
  declare shopDoors: { x: number; z: number; nx: number; nz: number; kind: InteriorKind; name: string }[];
  declare interiors: PlacedInterior[];
  declare clouds: THREE.Group;
  declare starMat: THREE.PointsMaterial;
  declare lampPositions: THREE.Vector3[];
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
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400), asphalt);
    ground.rotation.x = -Math.PI / 2;
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

    for (let i = -GRID; i <= GRID; i++) {
      for (let j = -GRID; j <= GRID; j++) {
        const cx = i * PITCH;
        const cz = j * PITCH;
        const isPark = Math.random() < 0.13;
        const isLot = !isPark && Math.random() < 0.16;

        const plate = new THREE.Mesh(new THREE.BoxGeometry(BLOCK, 0.26, BLOCK), sidewalkMat);
        plate.position.set(cx, 0.13, cz);
        plate.receiveShadow = true;
        plate.castShadow = false;
        this.group.add(plate);

        // curb ring
        const curb = new THREE.Mesh(new THREE.BoxGeometry(BLOCK + 0.9, 0.16, BLOCK + 0.9), curbMat);
        curb.position.set(cx, 0.08, cz);
        curb.receiveShadow = true;
        this.group.add(curb);

        if (isPark) {
          const lawn = new THREE.Mesh(new THREE.BoxGeometry(BLOCK - 6, 0.12, BLOCK - 6), parkMat);
          lawn.position.set(cx, 0.28, cz);
          lawn.receiveShadow = true;
          this.group.add(lawn);
          this.decoratePark(cx, cz);
          this.blocks.push({ x: cx, z: cz, type: 'park' });
        } else if (isLot) {
          const lot = new THREE.Mesh(new THREE.BoxGeometry(BLOCK - 6, 0.1, BLOCK - 6), lotMat);
          lot.position.set(cx, 0.28, cz);
          lot.receiveShadow = true;
          this.group.add(lot);
          this.decorateLot(cx, cz);
          this.blocks.push({ x: cx, z: cz, type: 'lot' });
        } else {
          this.buildBuildings(cx, cz);
          this.blocks.push({ x: cx, z: cz, type: 'city' });
        }

        this.decorateBlockEdge(cx, cz);
      }
    }

    // road markings (instanced)
    const half = GRID * PITCH;
    const mtx = new THREE.Matrix4();
    for (let i = -GRID; i < GRID; i++) {
      const rc = (i + 0.5) * PITCH;
      for (let t = -half; t <= half; t += 7) {
        // skip intersections
        const nearCross = Math.abs(((t / PITCH) % 1 + 1) % 1 - 0.5) < 0.2;
        if (nearCross) continue;
        this.dashMatrices.push(mtx.clone().makeTranslation(rc, 0.02, t));
        this.dashMatrices.push(mtx.clone().makeTranslation(t, 0.02, rc));
      }
      this.roadLines.push({ axis: 'x', coord: rc });
      this.roadLines.push({ axis: 'z', coord: rc });
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
    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 2.8, 6);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4f34, roughness: 1 });
    const crownGeo = new THREE.IcosahedronGeometry(1.7, 0);
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

  buildBuildings(cx: any, cz: any) {
    const count = Math.random() < 0.45 ? 1 : randInt(2, 3);
    const area = BLOCK - 9;
    const cells = count === 1 ? [[0, 0, area, area]] : this.splitLots(area, count, cx, cz);
    for (const [ox, oz, w, d] of cells) {
      const h = count === 1 ? rand(14, 46) : rand(7, 24);
      this.makeBuilding(cx + ox, cz + oz, w, d, h, cx, cz);
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

  makeBuilding(x: number, z: number, w: number, d: number, h: number, blockX = x, blockZ = z) {
    const chromeLike = new THREE.MeshStandardMaterial({ color: 0xc9ccd2, roughness: 0.35, metalness: 0.7 });
    const wall = pick(WALLS);
    const style = pick(['grid', 'bands', 'strips']);
    const tex = windowTexture(wall, style);
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
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x4a4a4c, roughness: 0.95 });
    const mats = [sideMat, sideMat, roofMat, roofMat, sideMat, sideMat];

    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats);
    b.position.set(x, h / 2 + 0.2, z);
    b.castShadow = true;
    b.receiveShadow = true;
    this.group.add(b);

    // parapet so the roofline is not a razor edge
    const parapet = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.34, 0.42, d + 0.34),
      new THREE.MeshStandardMaterial({ color: 0xd2d0d8, roughness: 0.9 })
    );
    parapet.position.set(x, h + 0.12, z);
    parapet.castShadow = true;
    this.group.add(parapet);

    // occasional billboard with real text, like the reference storefronts
    if (Math.random() < 0.6 && h < 34) {
      const words = ['DISKON', 'MURAH', 'PROMO', 'GRATIS ONGKIR', 'BUKA 24 JAM', 'KOPI ENAK', 'SERVIS AC', 'KOSONG'];
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
    if (w > 8 && d > 8) {
      const kind = SHOP_KINDS[this.shopDoorKindCursor++ % SHOP_KINDS.length];
      const room = this.roomFor(kind);
      if (room) {
        this.shopDoors.push({ x: doorX + nx * 1.1, z: doorZ + nz * 1.1, nx, nz, kind, name: room.name });
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
      const trunk = new THREE.Matrix4().makeTranslation(tx, 1.4 * s + 0.26, tz);
      trunk.scale(new THREE.Vector3(s, s, s));
      this.treeTrunks.push(trunk);
      const crown = new THREE.Matrix4().makeTranslation(tx, 3.5 * s + 0.26, tz);
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
        lightM.push(new THREE.Matrix4().makeTranslation(cx, 2.26, cz));    // 0.26 (kerb top) → 4.26
        lightArmM.push(new THREE.Matrix4().makeTranslation(cx, 4.24, cz)); // arm on top
        lightLampM.push(new THREE.Matrix4().makeTranslation(cx, 3.58, cz + 0.17));
      }
    }
    this.propAudit = [];
    const addInstanced = (geo: any, material: any, matrices: THREE.Matrix4[], cast = true, name = 'prop', audit = true) => {
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
      const px = b.x + stallAlong[i % stallAlong.length];
      const pz = b.z + BLOCK / 2 - 2.7;
      const yaw = 0; // faces the street (+z)
      const g = this.groundHeightAt(px, pz);
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
      const angkot = new Car(this.scene, { type: 'van', color: i === 0 ? 0x2f6fd0 : 0x2fa89a, position: new THREE.Vector3(px, g, pz), yaw });
      for (const sx of [-1, 1]) {
        const decal = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.6), angkotMat);
        decal.position.set(sx * 0.96, 1.02, 0.1);
        decal.rotation.y = (sx * Math.PI) / 2;
        angkot.mesh.add(decal);
      }
      this.propAudit.push({ name: 'angkot', x: px, z: pz, bottom: g });
      this.colliders.push({ minX: px - 2.9, maxX: px + 2.9, minZ: pz - 1.2, maxZ: pz + 1.2, h: 2.2 });
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
      { x: anchors[0].x - 3.4, z: anchors[0].z + BLOCK / 2 - 3.2, yaw: Math.PI / 2 },
      { x: anchors[1].x + 5.2, z: anchors[1].z + BLOCK / 2 - 3.2, yaw: Math.PI / 2 },
    ];
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

  getSpawn() {
    return new THREE.Vector3(PITCH * 0.5, 0, PITCH * 0.5 + 4);
  }

  // sidewalk plate height (blocks sit ~26cm above the asphalt)
  groundHeightAt(x: number, z: number) {
    const half = BLOCK / 2 - 0.6;
    for (const b of this.blocks) {
      if (Math.abs(x - b.x) < half && Math.abs(z - b.z) < half) return 0.26;
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
    const axis = Math.random() < 0.5 ? 'x' : 'z';
    const line = pick(this.roadLines.filter((l) => l.axis === axis));
    const along = rand(-GRID * PITCH + 12, GRID * PITCH - 12);
    const side = Math.random() < 0.5 ? -1 : 1;
    const off = 4.2;
    const pos =
      axis === 'x'
        ? new THREE.Vector3(line.coord + side * off, 0, along)
        : new THREE.Vector3(along, 0, line.coord + side * off);
    const yaw = axis === 'x' ? (side > 0 ? -Math.PI / 2 : Math.PI / 2) : side > 0 ? Math.PI : 0;
    return { pos, yaw };
  }

  randomSidewalkPointAround(centre: any, minR = 14, maxR = 48) {
    // pick a block in the requested ring, then a point on its sidewalk
    const candidates = this.blocks.filter((b) => {
      const d = Math.hypot(b.x - centre.x, b.z - centre.z);
      return d >= minR && d <= maxR;
    });
    if (!candidates.length) return this.randomSidewalkPointNear(maxR + 20);
    const b = pick(candidates);
    const half = BLOCK / 2 - 2.2;
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
    const b = pick(this.blocks);
    const edge = Math.floor(rand(0, 4));
    const off = BLOCK / 2 - 2.2;
    const t = rand(-BLOCK / 2 + 2, BLOCK / 2 - 2);
    if (edge === 0) return new THREE.Vector3(b.x + t, 0, b.z - off);
    if (edge === 1) return new THREE.Vector3(b.x + t, 0, b.z + off);
    if (edge === 2) return new THREE.Vector3(b.x - off, 0, b.z + t);
    return new THREE.Vector3(b.x + off, 0, b.z + t);
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