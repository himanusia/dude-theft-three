import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export const TAU = Math.PI * 2;

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const damp = (a: number, b: number, lambda: number, dt: number): number => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const rand = (a = 0, b = 1): number => a + Math.random() * (b - a);
export const randInt = (a: number, b: number): number => Math.floor(rand(a, b + 1));
export const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
export const sign = (v: number): number => (v < 0 ? -1 : v > 0 ? 1 : 0);

// shortest angle difference, wrapped to [-PI, PI]
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export interface BoxOpts {
  roughness?: number;
  metalness?: number;
  emissive?: number;
  emissiveIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  flat?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

export function box(w: number, h: number, d: number, color: number, opts: BoxOpts = {}): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({
      color,
      roughness: opts.roughness ?? 0.75,
      metalness: opts.metalness ?? 0.05,
      emissive: opts.emissive ?? 0x000000,
      emissiveIntensity: opts.emissiveIntensity ?? 1,
      transparent: opts.transparent ?? false,
      opacity: opts.opacity ?? 1,
      flatShading: opts.flat ?? false,
    })
  );
  m.castShadow = opts.castShadow !== false;
  m.receiveShadow = opts.receiveShadow !== false;
  return m;
}

export type DrawFn = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

export function canvasTexture(w: number, h: number, draw: DrawFn): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// circle (x,z,r) vs axis aligned box -> pushes the circle out, returns hit flag
export interface AABB {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  h?: number;
}

export interface CirclePush {
  x: number;
  z: number;
  nx: number;
  nz: number;
}

export function resolveCircleBox(x: number, z: number, r: number, b: AABB): CirclePush | null {
  const cx = clamp(x, b.minX, b.maxX);
  const cz = clamp(z, b.minZ, b.maxZ);
  let dx = x - cx;
  let dz = z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 > r * r) return null;
  if (d2 > 1e-6) {
    const d = Math.sqrt(d2);
    const push = r - d;
    return { x: x + (dx / d) * push, z: z + (dz / d) * push, nx: dx / d, nz: dz / d };
  }
  // center inside box: push along smallest penetration axis
  const pl = x - b.minX;
  const pr = b.maxX - x;
  const pb = z - b.minZ;
  const pf = b.maxZ - z;
  const m = Math.min(pl, pr, pb, pf);
  if (m === pl) return { x: b.minX - r, z, nx: -1, nz: 0 };
  if (m === pr) return { x: b.maxX + r, z, nx: 1, nz: 0 };
  if (m === pb) return { x, z: b.minZ - r, nx: 0, nz: -1 };
  return { x, z: b.maxZ + r, nx: 0, nz: 1 };
}

// ray vs collider AABB (2.5D slabs, box from y=0 to y=h)
export interface RayHit {
  dist: number;
  collider: AABB;
  point: THREE.Vector3;
}

export function rayVsColliders(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  maxDist: number,
  colliders: AABB[]
): RayHit | null {
  let best: RayHit | null = null;
  for (let i = 0; i < colliders.length; i++) {
    const b = colliders[i];
    let tmin = 0;
    let tmax = maxDist;
    let ok = true;
    // x
    if (Math.abs(dir.x) < 1e-8) {
      if (origin.x < b.minX || origin.x > b.maxX) ok = false;
    } else {
      let t1 = (b.minX - origin.x) / dir.x;
      let t2 = (b.maxX - origin.x) / dir.x;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) ok = false;
    }
    if (ok) {
      // z
      if (Math.abs(dir.z) < 1e-8) {
        if (origin.z < b.minZ || origin.z > b.maxZ) ok = false;
      } else {
        let t1 = (b.minZ - origin.z) / dir.z;
        let t2 = (b.maxZ - origin.z) / dir.z;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) ok = false;
      }
    }
    if (ok) {
      // y
      const top = b.h ?? 30;
      if (Math.abs(dir.y) < 1e-8) {
        if (origin.y > top || origin.y < 0) ok = false;
      } else {
        let t1 = (0 - origin.y) / dir.y;
        let t2 = (top - origin.y) / dir.y;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) ok = false;
      }
    }
    if (ok && tmin >= 0 && (!best || tmin < best.dist)) {
      best = {
        dist: tmin,
        collider: b,
        point: new THREE.Vector3(
          origin.x + dir.x * tmin,
          origin.y + dir.y * tmin,
          origin.z + dir.z * tmin
        ),
      };
    }
  }
  return best;
}

export function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[];
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose?.();
    }
  });
  obj.parent?.remove(obj);
}

export function formatMoney(n: number): string {
  return '$' + Math.floor(n).toLocaleString('en-US');
}

let _blobTex: THREE.CanvasTexture | null = null;
export function shadowBlob(w = 1.2, h = 1.2, opacity = 0.42): THREE.Mesh {
  if (!_blobTex) {
    _blobTex = canvasTexture(128, 128, (ctx, cw, ch) => {
      const g = ctx.createRadialGradient(cw / 2, ch / 2, 2, cw / 2, ch / 2, cw / 2);
      g.addColorStop(0, 'rgba(0,0,0,0.85)');
      g.addColorStop(0.55, 'rgba(0,0,0,0.35)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, cw, ch);
    });
  }
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: _blobTex, transparent: true, opacity, depthWrite: false })
  );
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 2;
  return m;
}


// beveled box — the shape language used by the reference game (soft toy edges, still low-poly)
export function roundedBox(w: number, h: number, d: number, radius: number = 0.05, segments = 2): THREE.BufferGeometry {
  return new RoundedBoxGeometry(w, h, d, segments, Math.min(radius, Math.min(w, h, d) * 0.49));
}
