import * as THREE from 'three';
import { canvasTexture, mergeStaticChildren } from '../core/utils';
import type { PosCtx } from './pospolisi';

/**
 * Pos ronda — the neighbourhood guard post, after reference/assets/ronda-ref-0.jpg
 * (Pos Ronda Geneng, Jombang; Wikimedia, CC BY 4.0).
 *
 * The photo is a small open shelter and almost everything that makes it Indonesian is in the
 * details, not the box:
 *   - four steel posts painted dark maroon
 *   - a corrugated zinc roof with a dark red fascia board along the front edge
 *   - a raised concrete platform with two mossy steps
 *   - inside: a wooden bench with a coloured cloth, a bolster (bantal guling) and a folded mat
 *   - a yellow notice board at the back with RT / RW numbering
 *   - blue-and-white painted kerb blocks along the road in front
 */
function noticeTex(): THREE.Texture {
  return canvasTexture(384, 192, (ctx, w, h) => {
    ctx.fillStyle = '#e8c520';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#1d1d1d';
    ctx.lineWidth = 5;
    ctx.strokeRect(8, 8, w - 16, h - 16);
    ctx.fillStyle = '#1d1d1d';
    ctx.textAlign = 'center';
    ctx.font = '700 30px Arial, sans-serif';
    ctx.fillText('POS RONDA', w / 2, 60);
    ctx.font = '700 26px Arial, sans-serif';
    ctx.fillText('RT 02 / RW VII', w / 2, 100);
    ctx.font = '500 20px Arial, sans-serif';
    ctx.fillText('KAMPUNG SIAGA', w / 2, 140);
  });
}

export function buildRonda(ctx: PosCtx, x: number, z: number, yaw: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;

  const maroon = new THREE.MeshStandardMaterial({ color: 0x5e2a26, roughness: 0.8, metalness: 0.25 });
  const zinc = new THREE.MeshStandardMaterial({ color: 0x8d9296, roughness: 0.75, metalness: 0.35, emissive: 0x1a1d1f, emissiveIntensity: 0.4 });
  const concrete = new THREE.MeshStandardMaterial({ color: 0xa8a296, roughness: 1 });
  const wood = new THREE.MeshStandardMaterial({ color: 0xb98b52, roughness: 0.9 });
  const cloth = new THREE.MeshStandardMaterial({ color: 0xd9c58a, roughness: 0.95 });
  const bolster = new THREE.MeshStandardMaterial({ color: 0xc8a45c, roughness: 0.95 });
  const white = new THREE.MeshStandardMaterial({ color: 0xe9e7e0, roughness: 0.95 });
  const blue = new THREE.MeshStandardMaterial({ color: 0x2f6fa8, roughness: 0.95 });
  const notice = new THREE.MeshStandardMaterial({ map: noticeTex(), roughness: 0.9 });

  const W = 4.6, D = 3.2, PH = 2.55;
  const box = (m: THREE.Material, bw: number, bh: number, bd: number, px: number, py: number, pz: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), m);
    mesh.position.set(px, py, pz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
    return mesh;
  };

  // platform and its two steps
  box(concrete, W, 0.5, D, 0, 0.25, 0);
  box(concrete, W - 0.5, 0.28, 0.5, 0, 0.14, D / 2 + 0.25);
  box(concrete, W - 1.2, 0.14, 0.5, 0, 0.07, D / 2 + 0.75);

  // four posts
  for (const px of [-W / 2 + 0.2, W / 2 - 0.2]) {
    for (const pz of [-D / 2 + 0.2, D / 2 - 0.2]) box(maroon, 0.13, PH, 0.13, px, 0.5 + PH / 2, pz);
  }

  // zinc roof, tilted back, with the dark red fascia across the front
  const roof = new THREE.Mesh(new THREE.BoxGeometry(W + 0.9, 0.1, D + 1.2), zinc);
  roof.position.set(0, 0.5 + PH + 0.18, 0);
  roof.rotation.x = -0.07;
  roof.castShadow = true;
  g.add(roof);
  box(maroon, W + 0.9, 0.26, 0.1, 0, 0.5 + PH + 0.06, D / 2 + 0.55);

  // back panel: half-height corrugated sheet, which is what closes the shelter off
  box(zinc, W - 0.3, 1.25, 0.08, 0, 1.35, -D / 2 + 0.1);
  box(maroon, W - 0.2, 0.1, 0.1, 0, 1.98, -D / 2 + 0.1);

  // the bunk: plank, cloth, bolster, folded mat
  box(wood, W - 0.7, 0.12, 1.15, 0, 0.8, -D / 2 + 0.85);
  for (const px of [-W / 2 + 0.75, W / 2 - 0.75]) box(wood, 0.1, 0.55, 0.1, px, 0.55, -D / 2 + 0.85);
  box(cloth, W - 0.8, 0.06, 1.1, 0, 0.89, -D / 2 + 0.85);
  const bol = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, W - 1.2, 10), bolster);
  bol.rotation.z = Math.PI / 2;
  bol.position.set(0, 1.0, -D / 2 + 1.15);
  bol.castShadow = true;
  g.add(bol);
  box(cloth, 1.2, 0.18, 0.9, W / 2 - 1.3, 0.95, -D / 2 + 0.75);

  // the yellow notice, hung at the back
  const sign = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.8, 0.06), notice);
  sign.position.set(-0.3, 1.95, -D / 2 + 0.2);
  g.add(sign);

  // blue-and-white kerb blocks along the road in front
  for (let i = -2; i <= 2; i++) {
    box(i % 2 === 0 ? white : blue, 0.62, 0.22, 0.3, i * 0.64, 0.11, D / 2 + 1.4);
  }

  mergeStaticChildren(g);
  ctx.group.add(g);
  ctx.audit.push({ name: 'pos-ronda', x, z, bottom: 0 });
  const hx = Math.abs(Math.cos(yaw)) * (W / 2 + 0.6) + Math.abs(Math.sin(yaw)) * (D / 2 + 1.6);
  const hz = Math.abs(Math.sin(yaw)) * (W / 2 + 0.6) + Math.abs(Math.cos(yaw)) * (D / 2 + 1.6);
  ctx.colliders.push({ minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz, h: PH + 0.6 });
  return g;
}
