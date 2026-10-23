import * as THREE from 'three';
import { canvasTexture, mergeStaticChildren } from '../core/utils';
import type { PosCtx } from './pospolisi';

/**
 * Rumah makan Padang, after reference/assets/padang-ref-0.jpg
 * (Rumah Makan Padang Sederhana, panoramio, Wikimedia, CC BY 3.0).
 *
 * What the photo shows, and what this builds:
 *  - Minangkabau gonjong roof: two sweeping buffalo-horn gables over terracotta tile
 *  - a carved decorative panel band under the gables
 *  - a cream upper facade of gridded glass
 *  - a ground floor of glass, with the name spelled across the front in red
 *
 * The name is a plesetan, like every sign in this city.
 */
function carvedTexture(): THREE.Texture {
  return canvasTexture(256, 64, (ctx, w, h) => {
    ctx.fillStyle = '#7a3a24';
    ctx.fillRect(0, 0, w, h);
    for (let x = 8; x < w; x += 16) {
      ctx.fillStyle = '#c9a227';
      ctx.fillRect(x, 12, 8, 40);
      ctx.fillStyle = '#3d1b10';
      ctx.fillRect(x + 3, 18, 2, 28);
    }
  });
}

function glassGrid(): THREE.Texture {
  return canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#cfd8dc';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#8fa3ad';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#b9c9d1';
    for (let y = 4; y < h; y += 64) for (let x = 4; x < w; x += 64) ctx.fillRect(x, y, 56, 56);
    ctx.strokeStyle = '#5b6b73';
    ctx.lineWidth = 6;
    for (let y = 0; y <= h; y += 64) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    for (let x = 0; x <= w; x += 64) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
  });
}

function signTexture(name: string): THREE.Texture {
  return canvasTexture(512, 128, (ctx, w, h) => {
    ctx.fillStyle = '#f2efe6';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#c62828';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 62px Georgia, serif';
    ctx.fillText(name, w / 2, h * 0.40);
    ctx.fillStyle = '#1b1b1b';
    ctx.font = '700 24px system-ui, sans-serif';
    ctx.fillText('MASAKAN PADANG', w / 2, h * 0.78);
  });
}

export function buildRumahPadang(ctx: PosCtx, x: number, z: number, yaw: number, name = 'SADERHANA'): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;

  const cream = new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.95 });
  const tile = new THREE.MeshStandardMaterial({ color: 0x9c3b1f, roughness: 0.9 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.85 });
  const glass = new THREE.MeshStandardMaterial({ map: glassGrid(), roughness: 0.25, metalness: 0.25 });
  const plate = new THREE.MeshStandardMaterial({ map: signTexture(name), roughness: 0.8 });
  const carved = new THREE.MeshStandardMaterial({ map: carvedTexture(), roughness: 0.85 });

  const W = 15, D = 11;
  const box = (m: THREE.Material, w: number, h: number, d: number, px: number, py: number, pz: number, ry = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(px, py, pz);
    mesh.rotation.y = ry;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
    return mesh;
  };

  // body: cream upper storey on a glazed ground floor
  box(cream, W, 4.2, D, 0, 4.3, 0);
  box(glass, W - 4.6, 3.4, 0.25, 0, 4.4, D / 2 + 0.02);
  box(dark, W + 0.5, 0.5, D + 0.5, 0, 2.15, 0);          // floor band over the shopfront
  box(glass, W - 1.2, 2.6, 0.2, 0, 1.35, D / 2 + 0.05);  // ground-floor glazing
  box(plate, 7.2, 1.5, 0.16, 0, 1.55, D / 2 + 0.2);      // the name, across the front

  // the carved band under the gables
  box(carved, W - 1.0, 1.1, 0.35, 0, 6.9, D / 2 - 0.4);

  // terracotta roof slab, then the two gonjong horns
  const roofSlab = new THREE.Mesh(new THREE.BoxGeometry(W, 0.45, D), tile);
  roofSlab.position.set(0, 6.3, 0);
  roofSlab.castShadow = true;
  g.add(roofSlab);

  for (const side of [-1, 1]) {
    let px = side * (W / 2 - 1.1);
    let py = 6.6;
    let wSeg = 2.6;
    let ang = 0;
    for (let i = 0; i < 6; i++) {
      const seg = new THREE.Mesh(new THREE.BoxGeometry(wSeg, 0.3, 3.4), tile);
      seg.position.set(px + side * wSeg * 0.35, py, 0);
      seg.rotation.z = side * ang;
      seg.castShadow = true;
      g.add(seg);
      px += side * wSeg * 0.72;
      py += 1.05;
      ang += 0.14;
      wSeg *= 0.72;
    }
    // the finial at the tip of each horn
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.9, 6), dark);
    tip.position.set(px, py + 0.2, 0);
    g.add(tip);
  }

  // a low kerb step so the shop meets the pavement without a gap
  box(new THREE.MeshStandardMaterial({ color: 0x9d988c, roughness: 1 }), W, 0.3, D, 0, 0.15, 0);

  mergeStaticChildren(g);
  ctx.group.add(g);
  ctx.audit.push({ name: 'rumah-padang', x, z, bottom: 0 });
  const hx = Math.abs(Math.cos(yaw)) * (W / 2 + 0.4) + Math.abs(Math.sin(yaw)) * (D / 2 + 0.4);
  const hz = Math.abs(Math.sin(yaw)) * (W / 2 + 0.4) + Math.abs(Math.cos(yaw)) * (D / 2 + 0.4);
  ctx.colliders.push({ minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz, h: 8 });
  return g;
}
