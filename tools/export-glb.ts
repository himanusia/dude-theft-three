
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { Car } from '../src/car';
import { Character } from '../src/character';

// Dev-only helper: builds the procedural assets and hands back GLB as base64 so a
// headless browser can save them. Not part of the game bundle.
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.0));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(4, 8, 6);
scene.add(sun);

const exporter = new GLTFExporter();

function toBase64(obj: THREE.Object3D): Promise<string> {
  return new Promise((resolve, reject) => {
    exporter.parse(obj, (res) => {
      if (res instanceof ArrayBuffer) {
        const bytes = new Uint8Array(res);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        resolve(btoa(bin));
      } else {
        resolve(btoa(JSON.stringify(res)));
      }
    }, (err) => reject(err), { binary: true });
  });
}

(window as any).__exportAssets = async () => {
  const out: Record<string, string> = {};
  for (const type of ['sedan', 'muscle', 'police', 'van']) {
    const car = new Car(scene, { type, position: new THREE.Vector3(0, 0, 0), yaw: 0 });
    out[type] = await toBase64(car.mesh);
  }
  for (const seed of [1, 7]) {
    const ch = new Character({});
    out['dude' + seed] = await toBase64(ch.group);
  }
  return out;
};
