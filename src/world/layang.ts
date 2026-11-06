import * as THREE from 'three';

/**
 * Jalan layang — the elevated toll road that cuts over Jakarta.
 *
 * The city reads flat because every structure in it is a box standing on the same plane. An
 * elevated deck does more for the silhouette than any number of buildings: it gives the sky a
 * second road level, throws a shadow across the carriageway, and is the one piece of Jakarta
 * infrastructure you can see from anywhere in the city.
 *
 * Every span is one deck slab resting on a crosshead (the pier head), carried by two columns.
 * The joint is real geometry, derived from one number: the crosshead's TOP plane IS the span's
 * soffit plane, and each column runs up INSIDE the crosshead instead of stopping below it.
 * All three parts of that were wrong and each one showed as the seam the owner reported: the
 * crosshead was placed from the ground under its own centre while the deck sat on the average
 * ground of the span's two ends (so a grade opened a gap or buried the head), the head hung
 * between two columns that touched neither it nor the deck, and the columns stood outside the
 * deck edge with nothing over them.
 *
 * Drawn with four InstancedMeshes (deck, parapets, columns, pier heads), so the whole viaduct
 * still costs four draw calls no matter how long it is.
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

/** deck slab thickness; the soffit plane is deckY - DECK_T / 2 above the span's ground */
const DECK_T = 1.1;
/** column section, both ways */
const SHAFT = 1.9;
/** how far the column runs up inside the pier head, so no face of the two can coincide */
const CAP_EMBED = 0.5;

export function buildLayang(ctx: LayangCtx, path: [number, number][], opts: LayangOptions = {}): void {
  const deckY = opts.deckY ?? 9.5;
  const width = opts.width ?? 15;
  const pierEvery = opts.pierEvery ?? 28;

  // Pier head proportions come from the deck, so the toll road and the metro guideway get the
  // SAME joint: a crosshead deep enough to carry the deck it bears on, reaching 0.3 m past each
  // column's outer face (the column's top is inside the head, its sides never coplanar with it).
  const capH = THREE.MathUtils.clamp(width * 0.085, 0.9, 1.4);
  const capD = 2.2;
  const shaftOff = width / 2 + 0.6;
  const capHalf = shaftOff + SHAFT / 2 + 0.3;
  /** column top, measured DOWN from the crosshead's top plane: the shaft ends inside the head */
  const shaftTopBelowCapTop = capH - CAP_EMBED;

  const concrete = new THREE.MeshStandardMaterial({ color: 0x9a9a94, roughness: 0.95 });
  // the soffit faces down, so the hemisphere light's ground colour is all it ever sees;
  // a mid grey came out mossy green. Dark concrete keeps it a shadowed underside.
  // the soffit sees only bounce light; without a little self-emission it renders as a black
  // slab across the top of every frame taken under the deck
  const deckMat = new THREE.MeshStandardMaterial({ color: 0x6d7175, roughness: 0.98, emissive: 0x1b1e21, emissiveIntensity: 0.6 });
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
    // A span is lifted to the AVERAGE ground of its two ends, so this number, not the ground
    // under an individual footing, is where the deck's underside actually is.
    const ground = (ctx.groundHeightAt(x1, z1) + ctx.groundHeightAt(x2, z2)) / 2;

    // The span's soffit plane: the one surface every pier head under this span has to meet.
    const soffit = ground + deckY - DECK_T / 2;

    // deck: one segment per span, centred on the span
    deckM.push(
      new THREE.Matrix4().compose(
        new THREE.Vector3((x1 + x2) / 2, soffit + DECK_T / 2, (z1 + z2) / 2),
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
          new THREE.Vector3((x1 + x2) / 2 + nx * side * (width / 2 - 0.25), soffit + DECK_T / 2 + 0.75, (z1 + z2) / 2 + nz * side * (width / 2 - 0.25)),
          q,
          new THREE.Vector3(1, 1, len)
        )
      );
    }

    // Piers stand in two rows just outside the deck edges, not down the middle: a viaduct over a
    // live carriageway cannot have columns in the traffic lanes. What carries the deck is the
    // crosshead between them: its top face is the soffit plane, so the deck bears on it with no
    // gap and without the deck's own volume being pushed into the pier, and its ends cantilever
    // past the columns that hold it up.
    const piers = Math.max(1, Math.round(len / pierEvery));
    for (let k = 0; k < piers; k++) {
      const t = (k + 0.5) / piers;
      const px = x1 + dx * t;
      const pz = z1 + dz * t;
      const capTop = soffit;
      pierCapM.push(new THREE.Matrix4().compose(new THREE.Vector3(px, capTop - capH / 2, pz), q, new THREE.Vector3(1, 1, 1)));
      const shaftTop = capTop - shaftTopBelowCapTop;
      for (const side of [-1, 1]) {
        const qx = px + nx * side * shaftOff;
        const qz = pz + nz * side * shaftOff;
        const g = ctx.groundHeightAt(qx, qz);
        const h = Math.max(0.8, shaftTop - g);
        pierM.push(new THREE.Matrix4().compose(new THREE.Vector3(qx, g + h / 2, qz), q, new THREE.Vector3(1, h, 1)));
        ctx.colliders.push({ minX: qx - 0.95, maxX: qx + 0.95, minZ: qz - 0.95, maxZ: qz + 0.95, h: g + h });
      }
    }
  }

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, matrices: THREE.Matrix4[], name: string) => {
    if (!matrices.length) return;
    const mesh = new THREE.InstancedMesh(geo, mat, matrices.length);
    mesh.name = name;
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    ctx.group.add(mesh);
  };

  add(new THREE.BoxGeometry(width, DECK_T, 1), deckMat, deckM, 'layang-deck');
  add(new THREE.BoxGeometry(0.35, 1.3, 1), railMat, railM, 'layang-rail');
  add(new THREE.BoxGeometry(SHAFT, 1, SHAFT), concrete, pierM, 'layang-pier');
  add(new THREE.BoxGeometry(capHalf * 2, capH, capD), concrete, pierCapM, 'layang-cap');
}
