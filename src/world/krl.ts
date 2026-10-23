import * as THREE from 'three';
import { canvasTexture } from '../core/utils';

/**
 * KRL — the elevated commuter line.
 *
 * Jakarta's commuter railway runs on a viaduct for most of its length through the city, and it is
 * the one thing you see above the rooftops from any kampung. This builds the viaduct (two rails,
 * sleepers, piers, catenary masts), a station with a platform and a name board, and a three-car
 * train standing at it. Everything long is instanced.
 */
export interface KrlCtx {
  group: THREE.Group;
  colliders: { minX: number; maxX: number; minZ: number; maxZ: number; h: number }[];
  audit: { name: string; x: number; z: number; bottom: number }[];
  groundHeightAt: (x: number, z: number) => number;
}

export interface KrlOptions {
  /** rail head height above the street */
  y?: number;
  station?: boolean;
  stationName?: string;
}

export function buildKrl(ctx: KrlCtx, path: [number, number][], opts: KrlOptions = {}): void {
  const railY = opts.y ?? 12;
  const gauge = 1.07;                      // standard gauge, metres
  const steel = new THREE.MeshStandardMaterial({ color: 0x8d939a, metalness: 0.65, roughness: 0.4 });
  const concrete = new THREE.MeshStandardMaterial({ color: 0xa4a49c, roughness: 0.95 });
  const sleeperMat = new THREE.MeshStandardMaterial({ color: 0x6b6259, roughness: 0.98 });
  const mastMat = new THREE.MeshStandardMaterial({ color: 0x5c6670, metalness: 0.4, roughness: 0.6 });

  const up = new THREE.Vector3(0, 1, 0);
  const rails: THREE.Matrix4[] = [];
  const decks: THREE.Matrix4[] = [];
  const sleepers: THREE.Matrix4[] = [];
  const piers: THREE.Matrix4[] = [];
  const masts: THREE.Matrix4[] = [];

  for (let i = 0; i < path.length - 1; i++) {
    const [x1, z1] = path[i];
    const [x2, z2] = path[i + 1];
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz) || 1;
    const yaw = Math.atan2(dx, dz);
    const q = new THREE.Quaternion().setFromAxisAngle(up, yaw);
    const nx = -dz / len;
    const nz = dx / len;
    const mx = (x1 + x2) / 2;
    const mz = (z1 + z2) / 2;
    const ground = (ctx.groundHeightAt(x1, z1) + ctx.groundHeightAt(x2, z2)) / 2;
    const deckTop = ground + railY;

    // the viaduct box the track sits on
    decks.push(new THREE.Matrix4().compose(new THREE.Vector3(mx, deckTop - 0.9, mz), q, new THREE.Vector3(1, 1, len)));
    // two rails
    for (const side of [-1, 1]) {
      rails.push(
        new THREE.Matrix4().compose(
          new THREE.Vector3(mx + nx * side * (gauge / 2), deckTop + 0.18, mz + nz * side * (gauge / 2)),
          q,
          new THREE.Vector3(1, 1, len)
        )
      );
    }
    // sleepers and piers at fixed spacing
    const sleepersCount = Math.max(1, Math.round(len / 0.65));
    for (let k = 0; k < sleepersCount; k++) {
      const t = (k + 0.5) / sleepersCount;
      sleepers.push(
        new THREE.Matrix4().compose(
          new THREE.Vector3(x1 + dx * t, deckTop + 0.08, z1 + dz * t),
          q,
          new THREE.Vector3(1, 1, 1)
        )
      );
    }
    const piersCount = Math.max(1, Math.round(len / 26));
    for (let k = 0; k < piersCount; k++) {
      const t = (k + 0.5) / piersCount;
      const px = x1 + dx * t;
      const pz = z1 + dz * t;
      const g = ctx.groundHeightAt(px, pz);
      const h = deckTop - g - 1.8;
      piers.push(new THREE.Matrix4().compose(new THREE.Vector3(px, g + h / 2, pz), q, new THREE.Vector3(1, h, 1)));
      masts.push(new THREE.Matrix4().compose(new THREE.Vector3(px + nx * 2.6, deckTop + 2.2, pz + nz * 2.6), q, new THREE.Vector3(1, 1, 1)));
      ctx.colliders.push({ minX: px - 1.0, maxX: px + 1.0, minZ: pz - 1.0, maxZ: pz + 1.0, h });
    }
  }

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, mats: THREE.Matrix4[], shadow = true) => {
    if (!mats.length) return;
    const mesh = new THREE.InstancedMesh(geo, mat, mats.length);
    mats.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    ctx.group.add(mesh);
  };

  add(new THREE.BoxGeometry(7.4, 1.8, 1), concrete, decks);
  add(new THREE.BoxGeometry(0.14, 0.16, 1), steel, rails, false);
  add(new THREE.BoxGeometry(2.5, 0.16, 0.26), sleeperMat, sleepers, false);
  add(new THREE.BoxGeometry(1.7, 1, 1.7), concrete, piers);
  add(new THREE.BoxGeometry(0.22, 4.6, 0.22), mastMat, masts);

  // ---------------- station
  if (opts.station) {
    const i = Math.floor((path.length - 1) / 2);
    const [x1, z1] = path[i];
    const [x2, z2] = path[i + 1];
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz) || 1;
    const yaw = Math.atan2(dx, dz);
    const nx = -dz / len;
    const nz = dx / len;
    const cx = (x1 + x2) / 2 + nx * 5.6;
    const cz = (z1 + z2) / 2 + nz * 5.6;
    const ground = ctx.groundHeightAt(cx, cz);
    const deck = ground + railY;
    const station = new THREE.Group();

    const platformMat = new THREE.MeshStandardMaterial({ color: 0xb9b5aa, roughness: 0.95 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x37474f, metalness: 0.3, roughness: 0.7 });
    const plat = new THREE.Mesh(new THREE.BoxGeometry(9, 0.9, 34), platformMat);
    plat.position.set(0, 0.45, 0);
    plat.castShadow = true;
    plat.receiveShadow = true;
    station.add(plat);
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.24, 3.2, 0.24), roofMat);
      post.position.set(s * 3.4, 2.5, 0);
      station.add(post);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(10, 0.22, 36), roofMat);
    roof.position.set(0, 4.2, 0);
    roof.castShadow = true;
    station.add(roof);

    // name board: plesetan station names, like every other sign in this city
    const name = opts.stationName ?? 'STASIUN MANGGIS';
    const tex = canvasTexture(512, 128, (ctx2, w, h) => {
      ctx2.fillStyle = '#123c6e';
      ctx2.fillRect(0, 0, w, h);
      ctx2.fillStyle = '#f4f8ff';
      let size = 58;
      ctx2.font = `800 ${size}px system-ui, sans-serif`;
      while (ctx2.measureText(name).width > w - 40 && size > 20) {
        size -= 3;
        ctx2.font = `800 ${size}px system-ui, sans-serif`;
      }
      ctx2.textAlign = 'center';
      ctx2.textBaseline = 'middle';
      ctx2.fillText(name, w / 2, h / 2 + 2);
    });
    const board = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 1.6), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 }));
    board.position.set(0, 3.2, 8);
    station.add(board);

    station.position.set(cx, ground, cz);
    station.rotation.y = yaw + Math.PI / 2;
    ctx.group.add(station);
    ctx.audit.push({ name: 'stasiun', x: cx, z: cz, bottom: ground });
    ctx.colliders.push({ minX: cx - 5, maxX: cx + 5, minZ: cz - 17, maxZ: cz + 17, h: 4.4 });

    // a three-car train standing at the platform
    const train = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xd8dde2, metalness: 0.35, roughness: 0.45 });
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.6 });
    for (let c = 0; c < 3; c++) {
      const car = new THREE.Mesh(new THREE.BoxGeometry(2.9, 3.1, 18), bodyMat);
      car.position.set(nx * 0, 0, (c - 1) * 19.4);
      car.castShadow = true;
      train.add(car);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.5, 18), stripeMat);
      stripe.position.set(0, -0.6, (c - 1) * 19.4);
      train.add(stripe);
    }
    train.position.set(cx - nx * 5.4, ground + railY + 1.7, cz - nz * 5.4);
    train.rotation.y = yaw;
    ctx.group.add(train);
    ctx.audit.push({ name: 'krl', x: cx, z: cz, bottom: ground });
  }
}
