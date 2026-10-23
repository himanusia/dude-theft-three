import * as THREE from 'three';
import { clamp } from '../core/utils';
import { Character } from './character';

// Place() has its own scratch vectors: the caller passes live verlet points (and its own ties
// such as the lateral axis), so sharing a temporary between the two would overwrite an anchor
// after it was read and put a limb somewhere else entirely.
const pDir = new THREE.Vector3();
const pUp = new THREE.Vector3();
const pX = new THREE.Vector3();
const pZ = new THREE.Vector3();
const pM = new THREE.Matrix4();
const tmpSpine = new THREE.Vector3();
const tmpLateral = new THREE.Vector3();
const tmpAnchor = new THREE.Vector3();
const tmpHipL = new THREE.Vector3();
const tmpHipR = new THREE.Vector3();

/**
 * Anchors measured inside the shared character asset (`character.ts`): its trunk group sits
 * 0.62 m below the head joint, an arm hangs 0.65 m from the shoulder to the middle of the hand and
 * a leg reaches 0.725 m from the hip to the middle of the shoe.
 *
 * The verlet skeleton below is its own (0.52 m from shoulder to hand mass, 0.84 m from hips to
 * foot mass), so each part is fitted along its own axis to the segment it rides. Fitting is what
 * keeps a hand on the road instead of hanging through it: a limb drawn at the asset's length on a
 * shorter segment leaves the far end 0.2 m below the mass that is supposed to rest on the ground.
 */
const PART = { trunkToHead: 0.62, shoulderToHand: 0.65, hipToShoe: 0.725, hipHalfWidth: 0.14 };

/**
 * Put one of the asset's own part groups on a verlet segment.
 *
 * The roll around the segment matters as much as its direction: `setFromUnitVectors` alone picks
 * an arbitrary twist, which would turn the face away from the shoulders (and the officer's cap
 * with it). The basis is built from the body's own lateral axis, so local +Z keeps pointing the
 * way the person was facing.
 */
function place(part: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, up: boolean, fit: number | null, scale: number, lateral: THREE.Vector3) {
  pDir.subVectors(to, from);
  const len = Math.max(0.02, pDir.length());
  pDir.multiplyScalar(1 / len);
  // local +Y is the way the part's own children grow: up for the trunk and the head, down (-Y)
  // for an arm or a leg
  pUp.copy(pDir);
  if (!up) pUp.negate();
  pX.copy(lateral).addScaledVector(pUp, -lateral.dot(pUp));
  if (pX.lengthSq() < 1e-6) pX.set(1, 0, 0); // a limb lying along the lateral axis
  pX.normalize();
  pZ.crossVectors(pX, pUp);
  pM.makeBasis(pX, pUp, pZ);
  part.quaternion.setFromRotationMatrix(pM);
  part.position.copy(from);
  part.scale.set(scale, fit ? len / fit : scale, scale);
}

/**
 * Verlet ragdoll with a real skeleton: head, neck, chest, hips, shoulders, elbows, hands,
 * knees and feet (14 masses). Stiffening links keep the silhouette; limit links stop the
 * elbows and knees from hyper-extending, so a body folds like a body instead of a rope.
 *
 * The skeleton is unchanged. The meshes used to be fresh boxes coloured with skin/shirt/pants;
 * now they are the character asset's own part groups, so the person who gets shot and the body on
 * the road are one model: same head with its face and hair, same shirt and collar, same hands and
 * shoes.
 *
 * Integration runs in fixed sub-steps (a 12 fps host no longer explodes the body) with
 * 8 relaxation passes per step, ground friction and building pushes.
 */
export class Ragdoll {
  /** where the ground is under a point; set by main from city.groundHeightAt */
  groundAt: ((x: number, z: number) => number) | null = null;
  declare scene: any;
  declare life: number;
  declare maxLife: any;
  declare group: THREE.Group;
  declare points: Record<string, { p: THREE.Vector3; prev: THREE.Vector3; r: number; name: string }>;
  declare constraints: { a: any; b: any; len: number; k: number }[];
  /** the asset's own part groups, driven by the masses */
  declare head: THREE.Object3D;
  declare trunk: THREE.Object3D;
  declare armL: THREE.Object3D;
  declare armR: THREE.Object3D;
  declare legL: THREE.Object3D;
  declare legR: THREE.Object3D;
  /** per-corpse material copies, because the asset's materials are shared city-wide */
  declare fadeMaterials: any[];
  declare colliders: any;
  declare scale: number;

  constructor(scene: THREE.Scene, opts: any = {}) {
    this.scene = scene;
    this.life = 0;
    this.maxLife = opts.maxLife ?? 11;
    this.groundAt = opts.groundAt ?? null;
    this.scale = opts.scale ?? 1;
    this.group = new THREE.Group();
    scene.add(this.group);

    const p = opts.position ?? new THREE.Vector3();
    const yaw = opts.yaw ?? 0;
    const scale: number = this.scale;
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const side = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const at = (dx: number, dy: number, dz: number) =>
      new THREE.Vector3(
        p.x + side.x * dx * scale + fwd.x * dz * scale,
        p.y + dy * scale,
        p.z + side.z * dx * scale + fwd.z * dz * scale
      );

    // proportions follow the 4.4-head character build (1.84 m tall)
    const defs: Record<string, { pos: THREE.Vector3; r: number }> = {
      // radii are the half-thickness of the mesh that hangs off each mass, not round numbers:
      // a limb lying on the road has to rest ON its geometry, otherwise half the body sinks
      head: { pos: at(0, 1.66, 0), r: 0.21 },
      neck: { pos: at(0, 1.44, 0), r: 0.1 },
      chest: { pos: at(0, 1.26, 0), r: 0.18 },
      hips: { pos: at(0, 0.94, 0), r: 0.17 },
      shoulderL: { pos: at(-0.3, 1.34, 0), r: 0.13 },
      shoulderR: { pos: at(0.3, 1.34, 0), r: 0.13 },
      elbowL: { pos: at(-0.36, 1.08, 0), r: 0.125 },
      elbowR: { pos: at(0.36, 1.08, 0), r: 0.125 },
      handL: { pos: at(-0.38, 0.82, 0), r: 0.09 },
      handR: { pos: at(0.38, 0.82, 0), r: 0.09 },
      kneeL: { pos: at(-0.15, 0.48, 0), r: 0.19 },
      kneeR: { pos: at(0.15, 0.48, 0), r: 0.19 },
      footL: { pos: at(-0.15, 0.1, 0), r: 0.13 },
      footR: { pos: at(0.15, 0.1, 0), r: 0.13 },
    };

    this.points = {};
    for (const [name, d] of Object.entries(defs)) {
      this.points[name] = { p: d.pos.clone(), prev: d.pos.clone(), r: d.r * scale, name };
    }

    const pair = (a: string, b: string, k = 1, shrink = 1) => {
      const len = this.points[a].p.distanceTo(this.points[b].p) * shrink;
      return { a: this.points[a], b: this.points[b], len, k };
    };

    this.constraints = [
      // spine
      pair('head', 'neck'),
      pair('neck', 'chest'),
      pair('chest', 'hips'),
      // arms
      pair('chest', 'shoulderL', 0.9),
      pair('shoulderL', 'elbowL'),
      pair('elbowL', 'handL'),
      pair('chest', 'shoulderR', 0.9),
      pair('shoulderR', 'elbowR'),
      pair('elbowR', 'handR'),
      // legs
      pair('hips', 'kneeL', 0.95),
      pair('kneeL', 'footL'),
      pair('hips', 'kneeR', 0.95),
      pair('kneeR', 'footR'),
      // bracing: keeps a body silhouette instead of letting it fold like a rope.
      // head-to-hips is the neck/spine bend limiter: without it the head jackknifes down
      // onto the pelvis and a corpse reads as a heap of boxes.
      pair('head', 'hips', 1, 1),
      pair('head', 'chest', 0.8, 0.99),
      pair('hips', 'chest', 0.85, 0.99),
      pair('shoulderL', 'shoulderR', 0.7),
      pair('hips', 'shoulderL', 0.6),
      pair('hips', 'shoulderR', 0.6),
      pair('kneeL', 'kneeR', 0.4),
      // joint limits: elbows and knees bend, never straighten past their rest angle
      pair('shoulderL', 'handL', 0.3, 0.97),
      pair('shoulderR', 'handR', 0.3, 0.97),
      pair('hips', 'footL', 0.3, 0.97),
      pair('hips', 'footR', 0.3, 0.97),
      // the hip cannot fold the legs up onto the chest either
      pair('chest', 'footL', 0.6, 0.95),
      pair('chest', 'footR', 0.6, 0.95),
    ];

    // The body is the city's character asset, not a second model: the same head, trunk, arms and
    // legs the pedestrian walked in with, only re-parented onto the masses above.
    const char = new Character({
      skin: opts.skin ?? 0xe0b28d,
      shirt: opts.shirt ?? 0x3346a8,
      pants: opts.pants ?? 0x2f3a52,
      hair: opts.hair ?? 'cap',
      face: opts.face ?? 'calm',
      scale,
    });
    // a corpse holds nothing
    char.armR.remove(char.gun);
    this.head = char.head;
    this.trunk = char.torso;
    this.armL = char.armL;
    this.armR = char.armR;
    this.legL = char.legL;
    this.legR = char.legR;
    const parts = [char.head, char.torso, char.armL, char.armR, char.legL, char.legR];
    // add() detaches each part from its parent, so the head and the arms stop riding the trunk
    for (const part of parts) this.group.add(part);

    // The asset's geometries and materials are shared by the player and every pedestrian, so this
    // body must not write to them: the fade at the end of its life gets its own material copies
    // (same texture, same colour) and the shared geometry is never disposed.
    const copies = new Map<any, any>();
    for (const part of parts) {
      part.traverse((o: any) => {
        if (!o.isMesh) return;
        let m = copies.get(o.material);
        if (!m) {
          m = o.material.clone();
          copies.set(o.material, m);
        }
        o.material = m;
        o.frustumCulled = false; // the masses move it every step, so its bounds are always stale
        o.castShadow = true;
        o.receiveShadow = true;
      });
    }
    this.fadeMaterials = [...copies.values()];

    if (opts.velocity) this.applyVelocity(opts.velocity);
    this.colliders = opts.colliders ?? [];
    this.syncMeshes();
  }

  applyVelocity(v: THREE.Vector3) {
    // shift prev backwards so verlet integration produces velocity v (m/s)
    const dt = 1 / 120;
    for (const pt of Object.values(this.points)) {
      pt.prev.addScaledVector(v, -dt);
    }
  }

  get center() {
    return this.points.hips.p;
  }

  step(dt: number) {
    const h = Math.min(1 / 60, dt);
    const g = -22 * h * h;
    const damp = 0.992;

    for (const pt of Object.values(this.points)) {
      const vx = (pt.p.x - pt.prev.x) * damp;
      const vy = (pt.p.y - pt.prev.y) * damp;
      const vz = (pt.p.z - pt.prev.z) * damp;
      pt.prev.copy(pt.p);
      pt.p.x += vx;
      pt.p.y += vy + g;
      pt.p.z += vz;
    }

    for (let it = 0; it < 10; it++) {
      for (const c of this.constraints) {
        const dx = c.b.p.x - c.a.p.x;
        const dy = c.b.p.y - c.a.p.y;
        const dz = c.b.p.z - c.a.p.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-5;
        const diff = ((d - c.len) / d) * 0.5 * c.k;
        c.a.p.x += dx * diff;
        c.a.p.y += dy * diff;
        c.a.p.z += dz * diff;
        c.b.p.x -= dx * diff;
        c.b.p.y -= dy * diff;
        c.b.p.z -= dz * diff;
      }

    }

    // ground: clamp to the terrain under each point (not to y = 0), then scrub horizontal
    // speed once per step so a body slides to a stop
    for (const pt of Object.values(this.points)) {
      const floor = (this.groundAt ? this.groundAt(pt.p.x, pt.p.z) : 0) + pt.r;
      if (pt.p.y < floor) {
        pt.p.y = floor;
        pt.prev.x += (pt.p.x - pt.prev.x) * 0.12;
        pt.prev.z += (pt.p.z - pt.prev.z) * 0.12;
      }
    }

    // buildings (only below their height)
    for (const b of this.colliders) {
      for (const pt of Object.values(this.points)) {
        if (pt.p.y > (b.h ?? 30)) continue;
        const cx = clamp(pt.p.x, b.minX, b.maxX);
        const cz = clamp(pt.p.z, b.minZ, b.maxZ);
        const dx = pt.p.x - cx;
        const dz = pt.p.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 < pt.r * pt.r) {
          const d = Math.sqrt(d2) || 1e-4;
          const push = pt.r - d;
          pt.p.x += (dx / d) * push;
          pt.p.z += (dz / d) * push;
        }
      }
    }

    for (const pt of Object.values(this.points)) {
      pt.p.x = clamp(pt.p.x, -230, 230);
      pt.p.z = clamp(pt.p.z, -230, 230);
    }
  }

  update(dt: number, colliders: any) {
    if (colliders) this.colliders = colliders;
    this.life += dt;
    // fixed sub-steps keep the body stable when the host renders slowly
    const sub = Math.min(4, Math.max(1, Math.ceil(dt * 120)));
    const h = dt / sub;
    for (let i = 0; i < sub; i++) this.step(h);
    this.syncMeshes();
    this.liftOutOfGround();
    if (this.life > this.maxLife - 2) {
      const f = clamp((this.maxLife - this.life) / 2, 0, 1);
      for (const mat of this.fadeMaterials) {
        if (!mat.transparent) {
          mat.transparent = true;
          mat.needsUpdate = true;
        }
        mat.opacity = f;
      }
    }
    return this.life < this.maxLife;
  }

  /**
   * A mass rests at its radius, but a limb is not a sphere: lying at an angle its flank digs
   * below that radius, which is the "sunk into the road" look. Measure the real meshes and
   * lift the whole body by the deepest penetration instead of guessing per-point offsets.
   */
  liftOutOfGround() {
    // Reference is the terrain under the body, not the world origin. Measured against zero,
    // a body resting correctly on a slope below y = 0 was lifted until its lowest mesh
    // reached zero - which is why a collapsed ragdoll hovered 2.4 m over the road.
    const pts = Object.values(this.points);
    const cx = pts.reduce((a, p) => a + p.p.x, 0) / pts.length;
    const cz = pts.reduce((a, p) => a + p.p.z, 0) / pts.length;
    const ground = this.groundAt ? this.groundAt(cx, cz) : 0;
    let lowest = ground;
    const box = Ragdoll.box || (Ragdoll.box = new THREE.Box3());
    for (const part of this.group.children) {
      if (!(part as THREE.Object3D).visible) continue;
      part.updateMatrixWorld(true);
      box.setFromObject(part);
      if (box.isEmpty()) continue;
      if (box.min.y < lowest) lowest = box.min.y;
    }
    if (lowest < ground - 0.001) {
      const shift = ground - lowest;
      for (const pt of Object.values(this.points)) {
        pt.p.y += shift;
        pt.prev.y += shift;
      }
      this.syncMeshes();
    }
  }

  static box: any;

  syncMeshes() {
    const P = this.points;
    const s = this.scale;

    // the body's own lateral axis, which every part's roll is aligned to
    tmpLateral.subVectors(P.shoulderR.p, P.shoulderL.p);
    if (tmpLateral.lengthSq() < 1e-6) tmpLateral.set(1, 0, 0);
    tmpLateral.normalize();

    // The trunk is rigid in the asset, so it hangs off the neck joint - where the asset puts its
    // head - and points down the spine. That keeps the asset's own shoulders (0.52 m below its
    // head joint) on the shoulder masses instead of somewhere inside the chest.
    tmpSpine.subVectors(P.neck.p, P.hips.p);
    if (tmpSpine.lengthSq() < 1e-6) tmpSpine.subVectors(P.chest.p, P.hips.p);
    tmpSpine.normalize();
    tmpAnchor.copy(P.neck.p).addScaledVector(tmpSpine, -PART.trunkToHead * s);
    place(this.trunk, tmpAnchor, P.neck.p, true, null, s, tmpLateral);

    // the skull sits 0.22 m up the head joint, which is the neck-to-head mass distance
    place(this.head, P.neck.p, P.head.p, true, null, s, tmpLateral);
    // the asset hangs its arms and legs down its own -Y, and both are fitted to their segment
    place(this.armL, P.shoulderL.p, P.handL.p, false, PART.shoulderToHand, s, tmpLateral);
    place(this.armR, P.shoulderR.p, P.handR.p, false, PART.shoulderToHand, s, tmpLateral);
    // the legs leave the pelvis at the asset's own hip width, not from the centre line, or the
    // two thighs overlap into one blob
    tmpHipL.copy(P.hips.p).addScaledVector(tmpLateral, -PART.hipHalfWidth * s);
    tmpHipR.copy(P.hips.p).addScaledVector(tmpLateral, PART.hipHalfWidth * s);
    place(this.legL, tmpHipL, P.footL.p, false, PART.hipToShoe, s, tmpLateral);
    place(this.legR, tmpHipR, P.footR.p, false, PART.hipToShoe, s, tmpLateral);
  }

  dispose() {
    // The geometries and the texture maps belong to the shared character asset; only the material
    // copies made for this corpse are this body's own.
    for (const mat of this.fadeMaterials) mat.dispose?.();
    this.scene.remove(this.group);
  }
}
