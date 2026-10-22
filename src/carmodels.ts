import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Real car models: the Kenney Car Kit (CC0, kenney.nl). Each file carries a named `body`
 * and four `wheel-*` nodes, so the wheels can still steer and spin.
 *
 * The kit is loaded once at boot; anything that fails to load leaves the procedural car in
 * place, so the game never depends on a network round-trip to be playable.
 */
export type ModelId = 'sedan' | 'sports' | 'taxi' | 'police' | 'van' | 'suv';

const FILES: Record<ModelId, string> = {
  sedan: 'sedan',
  sports: 'sedan-sports',
  taxi: 'taxi',
  police: 'police',
  van: 'van',
  suv: 'suv',
};

/** game car type → model id (angkot is not in the kit; it keeps its reference-built body) */
export const TYPE_TO_MODEL: Record<string, ModelId> = {
  sedan: 'sedan',
  muscle: 'sports',
  taxi: 'taxi',
  police: 'police',
  van: 'van',
  suv: 'suv',
};

export const MODELS: Partial<Record<ModelId, any>> = {};

export async function loadCarModels(base = 'models/cars/'): Promise<void> {
  const loader = new GLTFLoader();
  const load = (id: ModelId) =>
    new Promise<void>((resolve) => {
      loader.load(
        `${base}${FILES[id]}.glb`,
        (gltf) => {
          MODELS[id] = gltf.scene;
          resolve();
        },
        undefined,
        () => resolve() // fall back to the procedural body for this type
      );
    });
  await Promise.all((Object.keys(FILES) as ModelId[]).map(load));
}

/**
 * Clone a model, scale it to the requested length and tint its paint. The kit paints from a
 * single colourmap, so a tint multiplies the whole atlas: keep it light so wheels and glass
 * stay readable.
 */
export function instantiateModel(id: ModelId, length: number, tint?: number, tintStrength = 0.55) {
  const template = MODELS[id];
  if (!template) return null;
  const root = template.clone(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const scale = length / Math.max(size.z, size.x);
  root.scale.setScalar(scale);
  root.updateMatrixWorld(true);

  const wheels: { pivot: any; wheel: any; front: boolean }[] = [];
  root.traverse((o: any) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const cloned = mats.map((m: any) => {
        const c = m.clone();
        if (tint !== undefined && tintStrength > 0) {
          c.color = new THREE.Color(tint).lerp(new THREE.Color(0xffffff), 1 - tintStrength);
        }
        return c;
      });
      o.material = Array.isArray(o.material) ? cloned : cloned[0];
    }
    const name = (o.name || '').toLowerCase();
    if (name.startsWith('wheel')) {
      wheels.push({ pivot: o, wheel: o, front: name.includes('front') });
    }
  });

  // sit the model on the road: the kit's origin is at the ground plane already
  root.updateMatrixWorld(true);
  const scaled = new THREE.Box3().setFromObject(root);
  return { root, wheels, size: size.clone().multiplyScalar(scale), minY: scaled.min.y };
}
