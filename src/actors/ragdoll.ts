import * as THREE from 'three';
import { clamp } from '../core/utils';

const UP = new THREE.Vector3(0, 1, 0);
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();

/** Place a limb mesh between two point masses, scaled to the gap. */
function orient(mesh: any, a: THREE.Vector3, b: THREE.Vector3, sx: number, sz: number) {
  tmpV.subVectors(b, a);
  const len = Math.max(0.02, tmpV.length());
  mesh.position.addVectors(a, b).multiplyScalar(0.5);
  tmpQ.setFromUnitVectors(UP, tmpV.normalize());
  mesh.quaternion.copy(tmpQ);
  mesh.scale.set(sx, len, sz);
}

/**
 * Verlet ragdoll with a real skeleton: head, neck, chest, hips, shoulders, elbows, hands,
 * knees and feet (14 masses). Stiffening links keep the silhouette; limit links stop the
 * elbows and knees from hyper-extending, so a body folds like a body instead of a rope.
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
  declare materials: any[];
  declare headMesh: any;
  declare neckMesh: any;
  declare torsoMesh: any;
  declare pelvisMesh: any;
  declare upperArmL: any;
  declare upperArmR: any;
  declare foreArmL: any;
  declare foreArmR: any;
  declare handL: any;
  declare handR: any;
  declare thighL: any;
  declare thighR: any;
  declare shinL: any;
  declare shinR: any;
  declare footL: any;
  declare footR: any;
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

    const skinMat = new THREE.MeshStandardMaterial({ color: opts.skin ?? 0xe0b28d, roughness: 0.88, flatShading: true });
    const shirtMat = new THREE.MeshStandardMaterial({ color: opts.shirt ?? 0x3346a8, roughness: 0.9, flatShading: true });
    const pantsMat = new THREE.MeshStandardMaterial({ color: opts.pants ?? 0x2f3a52, roughness: 0.92, flatShading: true });
    this.materials = [skinMat, shirtMat, pantsMat];

    // unit-radius cylinder: orient() supplies the real radius through the scale
    const cyl = (mat: any, _r: number) => new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 8), mat);
    const box = (mat: any, x: number, y: number, z: number) => new THREE.Mesh(new THREE.BoxGeometry(x, y, z), mat);
    const addMesh = (m: any) => {
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    };

    const rs = 0.115 * scale; // arms were pencils at 0.095; the dudes are chunky
    this.headMesh = addMesh(box(skinMat, 0.42 * scale, 0.42 * scale, 0.42 * scale));
    this.neckMesh = addMesh(cyl(skinMat, 0.09 * scale));
    this.torsoMesh = addMesh(box(shirtMat, 1, 1, 1));
    this.pelvisMesh = addMesh(box(pantsMat, 1, 1, 1));
    this.upperArmL = addMesh(cyl(shirtMat, rs));
    this.upperArmR = addMesh(cyl(shirtMat, rs));
    this.foreArmL = addMesh(cyl(skinMat, rs * 0.92));
    this.foreArmR = addMesh(cyl(skinMat, rs * 0.92));
    this.handL = addMesh(box(skinMat, 0.16 * scale, 0.16 * scale, 0.16 * scale));
    this.handR = addMesh(box(skinMat, 0.16 * scale, 0.16 * scale, 0.16 * scale));
    this.thighL = addMesh(cyl(pantsMat, rs * 1.3));
    this.thighR = addMesh(cyl(pantsMat, rs * 1.3));
    this.shinL = addMesh(cyl(pantsMat, rs * 1.1));
    this.shinR = addMesh(cyl(pantsMat, rs * 1.1));
    this.footL = addMesh(box(pantsMat, 0.17 * scale, 0.11 * scale, 0.28 * scale));
    this.footR = addMesh(box(pantsMat, 0.17 * scale, 0.11 * scale, 0.28 * scale));

    if (opts.velocity) this.applyVelocity(opts.velocity);
    this.colliders = opts.colliders ?? [];
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
      this.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          const mat = mesh.material as THREE.Material & { opacity: number };
          mat.transparent = true;
          mat.opacity = f;
        }
      });
    }
    return this.life < this.maxLife;
  }

  /**
   * A mass rests at its radius, but a limb is a cylinder: lying at an angle its flank digs
   * below that radius, which is the "sunk into the road" look. Measure the real meshes and
   * lift the whole body by the deepest penetration instead of guessing per-point offsets.
   */
  liftOutOfGround() {
    let lowest = 0;
    const box = Ragdoll.box || (Ragdoll.box = new THREE.Box3());
    for (const child of this.group.children) {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) continue;
      mesh.updateMatrixWorld();
      box.setFromObject(mesh);
      if (box.min.y < lowest) lowest = box.min.y;
    }
    if (lowest < -0.001) {
      for (const pt of Object.values(this.points)) {
        pt.p.y -= lowest;
        pt.prev.y -= lowest;
      }
      this.syncMeshes();
    }
  }

  static box: any;

  syncMeshes() {
    const P = this.points;
    const s = this.scale;
    this.headMesh.position.copy(P.head.p);
    orient(this.neckMesh, P.neck.p, P.head.p, 0.09 * s, 0.09 * s);
    orient(this.torsoMesh, P.hips.p, P.chest.p, 0.46 * s, 0.29 * s);
    this.pelvisMesh.position.copy(P.hips.p);
    this.pelvisMesh.scale.set(0.42 * s, 0.2 * s, 0.3 * s);

    orient(this.upperArmL, P.shoulderL.p, P.elbowL.p, 0.13 * s, 0.13 * s);
    orient(this.upperArmR, P.shoulderR.p, P.elbowR.p, 0.13 * s, 0.13 * s);
    orient(this.foreArmL, P.elbowL.p, P.handL.p, 0.115 * s, 0.115 * s);
    orient(this.foreArmR, P.elbowR.p, P.handR.p, 0.115 * s, 0.115 * s);
    this.handL.position.copy(P.handL.p);
    this.handR.position.copy(P.handR.p);

    orient(this.thighL, P.hips.p, P.kneeL.p, 0.19 * s, 0.19 * s);
    orient(this.thighR, P.hips.p, P.kneeR.p, 0.19 * s, 0.19 * s);
    orient(this.shinL, P.kneeL.p, P.footL.p, 0.155 * s, 0.155 * s);
    orient(this.shinR, P.kneeR.p, P.footR.p, 0.155 * s, 0.155 * s);
    this.footL.position.copy(P.footL.p);
    this.footR.position.copy(P.footR.p);
    this.footL.position.y += 0.02 * s;
    this.footR.position.y += 0.02 * s;
  }

  dispose() {
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose();
        (mesh.material as THREE.Material)?.dispose?.();
      }
    });
    this.scene.remove(this.group);
  }
}
