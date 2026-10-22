import * as THREE from 'three';
import { clamp } from './utils.js';

const UP = new THREE.Vector3(0, 1, 0);
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();

function orient(mesh, a, b, sx, sz) {
  tmpV.subVectors(b, a);
  const len = Math.max(0.02, tmpV.length());
  mesh.position.addVectors(a, b).multiplyScalar(0.5);
  tmpQ.setFromUnitVectors(UP, tmpV.normalize());
  mesh.quaternion.copy(tmpQ);
  mesh.scale.set(sx, len, sz);
}

// Verlet ragdoll: 11 point masses, distance constraints, ground + building collision.
export class Ragdoll {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.life = 0;
    this.maxLife = opts.maxLife ?? 11;
    this.group = new THREE.Group();
    scene.add(this.group);

    const p = opts.position ?? new THREE.Vector3();
    const yaw = opts.yaw ?? 0;
    const scale = opts.scale ?? 1;
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const side = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));

    const at = (dx, dy, dz) =>
      new THREE.Vector3(p.x + side.x * dx * scale + fwd.x * dz * scale, p.y + dy * scale, p.z + side.z * dx * scale + fwd.z * dz * scale);

    const defs = {
      head: { pos: at(0, 1.68, 0), r: 0.19 },
      chest: { pos: at(0, 1.32, 0), r: 0.16 },
      hips: { pos: at(0, 0.96, 0), r: 0.16 },
      elbowL: { pos: at(-0.36, 1.16, 0), r: 0.09 },
      handL: { pos: at(-0.4, 0.86, 0), r: 0.08 },
      elbowR: { pos: at(0.36, 1.16, 0), r: 0.09 },
      handR: { pos: at(0.4, 0.86, 0), r: 0.08 },
      kneeL: { pos: at(-0.14, 0.48, 0), r: 0.1 },
      footL: { pos: at(-0.14, 0.08, 0), r: 0.09 },
      kneeR: { pos: at(0.14, 0.48, 0), r: 0.1 },
      footR: { pos: at(0.14, 0.08, 0), r: 0.09 },
    };

    this.points = {};
    for (const [name, d] of Object.entries(defs)) {
      this.points[name] = {
        p: d.pos.clone(),
        prev: d.pos.clone(),
        r: d.r * scale,
        name,
      };
    }

    const pair = (a, b) => ({
      a: this.points[a],
      b: this.points[b],
      len: this.points[a].p.distanceTo(this.points[b].p),
    });

    this.constraints = [
      pair('head', 'chest'),
      pair('chest', 'hips'),
      pair('chest', 'elbowL'),
      pair('elbowL', 'handL'),
      pair('chest', 'elbowR'),
      pair('elbowR', 'handR'),
      pair('hips', 'kneeL'),
      pair('kneeL', 'footL'),
      pair('hips', 'kneeR'),
      pair('kneeR', 'footR'),
      // stiffeners so it keeps a body-ish silhouette
      pair('head', 'hips'),
      pair('elbowL', 'hips'),
      pair('elbowR', 'hips'),
      pair('kneeL', 'kneeR'),
      pair('handL', 'handR'),
      { a: this.points.head, b: this.points.handR, len: this.points.head.p.distanceTo(this.points.handR.p) },
    ];

    const skinMat = new THREE.MeshStandardMaterial({ color: opts.skin ?? 0xe0b28d, roughness: 0.88, flatShading: true });
    const shirtMat = new THREE.MeshStandardMaterial({ color: opts.shirt ?? 0x3346a8, roughness: 0.9, flatShading: true });
    const pantsMat = new THREE.MeshStandardMaterial({ color: opts.pants ?? 0x2f3a52, roughness: 0.92, flatShading: true });
    this.materials = [skinMat, shirtMat, pantsMat];

    const cyl = (mat, r) => new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 7), mat);
    const addMesh = (m, cast = true) => {
      m.castShadow = cast;
      m.receiveShadow = true;
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    };

    const rs = 0.095 * scale;
    this.headMesh = addMesh(new THREE.Mesh(new THREE.BoxGeometry(0.4 * scale, 0.4 * scale, 0.4 * scale), skinMat));
    this.torsoMesh = addMesh(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), shirtMat));
    this.pelvisMesh = addMesh(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), pantsMat));
    this.upperArmL = addMesh(cyl(shirtMat, rs));
    this.upperArmR = addMesh(cyl(shirtMat, rs));
    this.foreArmL = addMesh(cyl(skinMat, rs * 0.85));
    this.foreArmR = addMesh(cyl(skinMat, rs * 0.85));
    this.thighL = addMesh(cyl(pantsMat, rs * 1.15));
    this.thighR = addMesh(cyl(pantsMat, rs * 1.15));
    this.shinL = addMesh(cyl(pantsMat, rs));
    this.shinR = addMesh(cyl(pantsMat, rs));

    if (opts.velocity) this.applyVelocity(opts.velocity);
    this.colliders = opts.colliders ?? [];
  }

  applyVelocity(v) {
    // shift prev backwards so verlet integration produces velocity v (m/s)
    const dt = 1 / 120;
    for (const pt of Object.values(this.points)) {
      pt.prev.addScaledVector(v, -dt);
    }
  }

  get center() {
    return this.points.hips.p;
  }

  step(dt) {
    const g = -24 * dt * dt;
    const damp = 0.985;
    for (const pt of Object.values(this.points)) {
      const vx = (pt.p.x - pt.prev.x) * damp;
      const vy = (pt.p.y - pt.prev.y) * damp;
      const vz = (pt.p.z - pt.prev.z) * damp;
      pt.prev.copy(pt.p);
      pt.p.x += vx;
      pt.p.y += vy + g;
      pt.p.z += vz;
    }

    for (let it = 0; it < 6; it++) {
      for (const c of this.constraints) {
        const dx = c.b.p.x - c.a.p.x;
        const dy = c.b.p.y - c.a.p.y;
        const dz = c.b.p.z - c.a.p.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-5;
        const diff = (d - c.len) / d;
        const k = 0.5 * diff;
        c.a.p.x += dx * k;
        c.a.p.y += dy * k;
        c.a.p.z += dz * k;
        c.b.p.x -= dx * k;
        c.b.p.y -= dy * k;
        c.b.p.z -= dz * k;
      }
    }

    // ground
    for (const pt of Object.values(this.points)) {
      if (pt.p.y < pt.r) {
        pt.p.y = pt.r;
        // ground friction
        pt.prev.x += (pt.p.x - pt.prev.x) * 0.55;
        pt.prev.z += (pt.p.z - pt.prev.z) * 0.55;
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

    // world bounds
    for (const pt of Object.values(this.points)) {
      pt.p.x = clamp(pt.p.x, -230, 230);
      pt.p.z = clamp(pt.p.z, -230, 230);
    }
  }

  update(dt, colliders) {
    if (colliders) this.colliders = colliders;
    this.life += dt;
    const sub = Math.min(3, Math.max(1, Math.round(dt * 120)));
    const h = dt / sub;
    for (let i = 0; i < sub; i++) this.step(h);
    this.syncMeshes();
    if (this.life > this.maxLife - 2) {
      const f = clamp((this.maxLife - this.life) / 2, 0, 1);
      this.group.traverse((o) => {
        if (o.isMesh) {
          o.material.transparent = true;
          o.material.opacity = f;
        }
      });
    }
    return this.life < this.maxLife;
  }

  syncMeshes() {
    const P = this.points;
    this.headMesh.position.copy(P.head.p);
    orient(this.torsoMesh, P.hips.p, P.chest.p, 0.5, 0.3);
    this.pelvisMesh.position.copy(P.hips.p);
    this.pelvisMesh.scale.set(0.48, 0.22, 0.32);
    orient(this.upperArmL, P.chest.p, P.elbowL.p, 0.12, 0.12);
    orient(this.upperArmR, P.chest.p, P.elbowR.p, 0.12, 0.12);
    orient(this.foreArmL, P.elbowL.p, P.handL.p, 0.1, 0.1);
    orient(this.foreArmR, P.elbowR.p, P.handR.p, 0.1, 0.1);
    orient(this.thighL, P.hips.p, P.kneeL.p, 0.14, 0.14);
    orient(this.thighR, P.hips.p, P.kneeR.p, 0.14, 0.14);
    orient(this.shinL, P.kneeL.p, P.footL.p, 0.12, 0.12);
    orient(this.shinR, P.kneeR.p, P.footR.p, 0.12, 0.12);
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose();
        o.material?.dispose?.();
      }
    });
    this.scene.remove(this.group);
  }
}
