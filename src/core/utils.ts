import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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

export interface FootprintOptions {
  /** rectangle centre in the object's own frame, metres (a shed's deck is not its group origin) */
  cx?: number;
  cz?: number;
  /** width of a strip across the long side, metres. Smaller is tighter and costs more boxes. */
  strip?: number;
}

/** A collider box with its height known, as every world builder registers one. */
export interface FootprintBox extends AABB {
  h: number;
}

/**
 * How a rotated rectangle is cut before its pieces get axis-aligned boxes.
 *
 * A box that is turned cannot be one AABB: sized to the body it leaves the corners outside the
 * collider (a body walks through them), sized to the turn it reserves the whole square around the
 * body and stops a player a metre and a half from the wall, which reads in game as "this asset
 * cannot be walked up to". So the rectangle is cut up and every piece gets its own AABB.
 *
 * A long body (a bus, a boarding platform) is cut into strips across its length: the pieces stay
 * long and thin, and a strip only bulges by half its *narrow* side. A roughly square footprint (a
 * 4.6 x 4.75 m guard post) is tiled both ways instead, because one wide strip of a square still
 * bulges by half its width when it is turned.
 */
function footprintTiles(halfX: number, halfZ: number, strip: number) {
  const nx = Math.max(1, Math.ceil((halfX * 2) / strip));
  const nz = Math.max(1, Math.ceil((halfZ * 2) / strip));
  const long = Math.max(halfX, halfZ);
  const short = Math.min(halfX, halfZ);
  // A footprint three times longer than it is deep (a bus, a boarding platform) is cut into strips
  // across its length: each strip only bulges by half its *short* side. A roughly square footprint
  // (a guard post) is tiled both ways, because one wide strip of a square still bulges by half its
  // width when it is turned. Either way the pieces stay under the box budget.
  if (long / short >= 2) {
    return nx >= nz ? { nx: Math.min(60, nx), nz: 1 } : { nx: 1, nz: Math.min(60, nz) };
  }
  const budget = 60;
  if (nx * nz <= budget) return { nx, nz };
  const k = Math.sqrt(budget / (nx * nz));
  return { nx: Math.max(1, Math.ceil(nx * k)), nz: Math.max(1, Math.ceil(nz * k)) };
}

/**
 * Cover a rotated rectangle with axis-aligned boxes, writing into `out` in place.
 *
 * The tile count depends only on the size, so `out` can be rewritten forever: that is how a
 * collider follows a moving vehicle without being re-registered in `city.colliders` every frame.
 */
export function writeRotatedFootprint(
  out: AABB[],
  x: number,
  z: number,
  yaw: number,
  halfX: number,
  halfZ: number,
  h: number,
  opts: FootprintOptions = {}
): AABB[] {
  const { nx, nz } = footprintTiles(halfX, halfZ, opts.strip ?? 1.0);
  const cx = opts.cx ?? 0;
  const cz = opts.cz ?? 0;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const shx = halfX / nx;
  const shz = halfZ / nz;
  // the widest a turned tile's own bounding box can be, on either axis
  const ex = Math.abs(cos) * shx + Math.abs(sin) * shz;
  const ez = Math.abs(sin) * shx + Math.abs(cos) * shz;
  let k = 0;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const lx = cx - halfX + (2 * i + 1) * shx;
      const lz = cz - halfZ + (2 * j + 1) * shz;
      const wx = x + lx * cos + lz * sin;
      const wz = z - lx * sin + lz * cos;
      const b = out[k] ?? { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
      b.minX = wx - ex;
      b.maxX = wx + ex;
      b.minZ = wz - ez;
      b.maxZ = wz + ez;
      b.h = h;
      out[k] = b;
      k++;
    }
  }
  return out;
}

/** Fresh boxes for a rotated footprint, ready to push into an existing collider array. */
export function rotatedFootprint(
  x: number,
  z: number,
  yaw: number,
  halfX: number,
  halfZ: number,
  h: number,
  opts: FootprintOptions = {}
): FootprintBox[] {
  const { nx, nz } = footprintTiles(halfX, halfZ, opts.strip ?? 1.0);
  const out: FootprintBox[] = [];
  for (let i = 0; i < nx * nz; i++) out.push({ minX: 0, maxX: 0, minZ: 0, maxZ: 0, h });
  return writeRotatedFootprint(out, x, z, yaw, halfX, halfZ, h, opts) as FootprintBox[];
}

// ray vs collider AABB (2.5D slabs, box from y=0 to y=h)
export interface RayHit {
  dist: number;
  collider: AABB;
  point: THREE.Vector3;
}

/**
 * Nearest collider face along a ray. `minDist` is the near end of the ray in metres: a box that
 * already contains the origin answers `tmin = 0`, which is right for a camera boom (it must not
 * travel through the wall it is buried in) and wrong for a shot (a camera pushed into a facade
 * would answer 0 and the round would be spent on nothing). `minDist` is also how a shot skips the
 * geometry behind the shooter.
 */
export function rayVsColliders(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  maxDist: number,
  colliders: AABB[],
  minDist = 0
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
      // y: a collider stands on the street and blocks from its base upward, so the slab is
      // open-ended BELOW street level. A closed [0, h] slab let a steeply descending camera boom
      // dive under the building it was about to enter: at 55 deg of up-look the boom is only
      // 0.75 m off the road by the time it reaches a wall 1.6 m behind the player, and the hit
      // was missed, which put the camera inside the facade.
      const top = b.h ?? 30;
      if (Math.abs(dir.y) < 1e-8) {
        if (origin.y > top) ok = false;
      } else {
        let t1 = (-Infinity - origin.y) / dir.y;
        let t2 = (top - origin.y) / dir.y;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) ok = false;
      }
    }
    if (ok && tmin >= minDist && (!best || tmin < best.dist)) {
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


/**
 * Collapse a group of static meshes into one mesh per material. A shopfront built out of forty
 * boxes is forty draw calls; merged, it is three. That is the difference between a mid-range
 * phone holding its frame rate and not, and none of these props ever animate.
 *
 * Geometries are grouped by material *and* by attribute set, because mergeGeometries refuses to
 * combine a geometry that carries a uv with one that does not.
 */
export function mergeStaticChildren(group: THREE.Group): THREE.Group {
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const buckets = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[] }>();
  const doomed: THREE.Mesh[] = [];

  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh) return;
    if (Array.isArray(m.material)) return;
    const geo = m.geometry.clone();
    geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    const sig = `${m.material.uuid}|${Object.keys(geo.attributes).sort().join(',')}`;
    const bucket = buckets.get(sig) ?? { mat: m.material as THREE.Material, geos: [] };
    bucket.geos.push(geo);
    buckets.set(sig, bucket);
    doomed.push(m);
  });

  for (const m of doomed) m.removeFromParent();

  for (const { mat, geos } of buckets.values()) {
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
