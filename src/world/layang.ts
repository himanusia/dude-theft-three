import * as THREE from 'three';

/**
 * Jalan layang — the elevated toll road that cuts over Jakarta.
 *
 * The city reads flat because every structure in it is a box standing on the same plane. An
 * elevated deck does more for the silhouette than any number of buildings: it gives the sky a
 * second road level, throws a shadow across the carriageway, and is the one piece of Jakarta
 * infrastructure you can see from anywhere in the city.
 *
 * Drawn with two InstancedMeshes (deck segments and piers), so the whole viaduct costs two draw
 * calls no matter how long it is.
 */
export interface LayangCtx {
  group: THREE.Group;
  colliders: { minX: number; maxX: number; minZ: number; maxZ: number; h: number }[];
  audit: { name: string; x: number; z: number; bottom: number }[];
  groundHeightAt: (x: number, z: number) => number;
}

export interface LayangOptions {
  /** height of the deck underside above the street */
  deckY?: number;
  /** deck width, kerb to kerb */
  width?: number;
  pierEvery?: number;
}

export function buildLayang(ctx: LayangCtx, path: [number, number][], opts: LayangOptions = {}): void {
  const deckY = opts.deckY ?? 9.5;
  const width = opts.width ?? 15;
  const pierEvery = opts.pierEvery ?? 28;

  const concrete = new THREE.MeshStandardMaterial({ color: 0x9a9a94, roughness: 0.95 });
  const deckMat = new THREE.MeshStandardMaterial({ color: 0x6f7377, roughness: 0.98 });
  const railMat = new THREE.MeshStandardMaterial({ color: 0xc9c6bc, roughness: 0.9 });

  const deckM: THREE.Matrix4[] = [];
  const railM: THREE.Matrix4[] = [];
  const pierM: THREE.Matrix4[] = [];
  const pierCapM: THREE.Matrix4[] = [];
  const up = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i < path.length - 1; i++) {
    const [x1, z1] = path[i];
    const [x2, z2] = path[i + 1];
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz) || 1;
    const yaw = Math.atan2(dx, dz);
    const q = new THREE.Quaternion().setFromAxisAngle(up, yaw);
    const ground = (ctx.groundHeightAt(x1, z1) + ctx.groundHeightAt(x2, z2)) / 2;

    // deck: one segment per span, centred on the span
    deckM.push(
      new THREE.Matrix4().compose(
        new THREE.Vector3((x1 + x2) / 2, ground + deckY, (z1 + z2) / 2),
        q,
        new THREE.Vector3(1, 1, len)
      )
    );
    // parapets on both edges
    const nx = -dz / len;
    const nz = dx / len;
    for (const side of [-1, 1]) {
      railM.push(
        new THREE.Matrix4().compose(
          new THREE.Vector3((x1 + x2) / 2 + nx * side * (width / 2 - 0.25), ground + deckY + 0.75, (z1 + z2) / 2 + nz * side * (width / 2 - 0.25)),
          q,
          new THREE.Vector3(1, 1, len)
        )
      );
    }

    // Piers stand in two rows just inside the deck edges, not down the middle: a viaduct over a
    // live carriageway cannot have columns in the traffic lanes, and the deck still needs
    // support across its whole width.
    const piers = Math.max(1, Math.round(len / pierEvery));
    for (let k = 0; k < piers; k++) {
      const t = (k + 0.5) / piers;
      const px = x1 + dx * t;
      const pz = z1 + dz * t;
      const h = deckY - 1.2;
      for (const side of [-1, 1]) {
        const qx = px + nx * side * (width / 2 + 0.6);
        const qz = pz + nz * side * (width / 2 + 0.6);
        const g = ctx.groundHeightAt(qx, qz);
        pierM.push(new THREE.Matrix4().compose(new THREE.Vector3(qx, g + h / 2, qz), q, new THREE.Vector3(1, h, 1)));
        ctx.colliders.push({ minX: qx - 0.95, maxX: qx + 0.95, minZ: qz - 0.95, maxZ: qz + 0.95, h });
      }
      const gCap = ctx.groundHeightAt(px, pz);
      pierCapM.push(new THREE.Matrix4().compose(new THREE.Vector3(px, gCap + h + 0.3, pz), q, new THREE.Vector3(1, 1, 1)));
    }
  }

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, matrices: THREE.Matrix4[], name: string) => {
    if (!matrices.length) return;
    const mesh = new THREE.InstancedMesh(geo, mat, matrices.length);
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    ctx.group.add(mesh);
    void name;
  };

  add(new THREE.BoxGeometry(width, 1.1, 1), deckMat, deckM, 'layang-deck');
  add(new THREE.BoxGeometry(0.35, 1.3, 1), railMat, railM, 'layang-rail');
  add(new THREE.BoxGeometry(1.9, 1, 1.9), concrete, pierM, 'layang-pier');
  add(new THREE.BoxGeometry(width * 0.92, 0.7, 2.4), concrete, pierCapM, 'layang-cap');
}
