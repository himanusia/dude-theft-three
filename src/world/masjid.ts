import * as THREE from 'three';
import { canvasTexture, mergeStaticChildren } from '../core/utils';
import type { PosCtx } from './pospolisi';

/**
 * Masjid kampung, after reference/assets/masjid-ref-0.jpg
 * (Masjid Al-Istiqomah, Kampung Melayu, Jakarta; panoramio/Wikimedia, CC BY 3.0).
 *
 * This is the Jakarta neighbourhood mosque, and it is emphatically not a dome on a square:
 * it is a two-storey shophouse with a prayer hall above, and what makes it read as a mosque
 * is a specific set of things the photo shows —
 *   - dark timber fascia bands running the full width at each floor and under the eaves
 *   - a white metal railing along the upper balcony, ornate pickets, not glass
 *   - tall dark glazing in white frames on both storeys
 *   - an ogee (bulbous) pointed arch over the entrance, ringed in dark voussoirs
 *   - a straight flight of dark stone steps with a chrome handrail
 *   - a green steel gate at the side
 *
 * The name on the board is a plesetan, like every sign in this city.
 */
function signTex(name: string): THREE.Texture {
  return canvasTexture(512, 96, (ctx, w, h) => {
    ctx.fillStyle = '#5a3a26';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#f4efe4';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 46px Georgia, serif';
    ctx.fillText(name, w / 2, h * 0.55);
  });
}

export function buildMasjid(ctx: PosCtx, x: number, z: number, yaw: number, name = 'MASJID AL-IKHLAS'): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;

  const cream = new THREE.MeshStandardMaterial({ color: 0xe6e0d2, roughness: 0.95 });
  const timber = new THREE.MeshStandardMaterial({ color: 0x5a3a26, roughness: 0.9 });
  const dado = new THREE.MeshStandardMaterial({ color: 0xc9b79a, roughness: 0.95 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1d2a35, roughness: 0.3, metalness: 0.35 });
  const frameW = new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.8 });
  const rail = new THREE.MeshStandardMaterial({ color: 0xeceff1, roughness: 0.4, metalness: 0.6 });
  const stone = new THREE.MeshStandardMaterial({ color: 0x4a4a4c, roughness: 0.95 });
  const green = new THREE.MeshStandardMaterial({ color: 0x2e7d5b, roughness: 0.7, metalness: 0.3 });
  const sign = new THREE.MeshStandardMaterial({ map: signTex(name), roughness: 0.85 });

  const W = 17, D = 13, H1 = 4.0, H2 = 3.8;
  const box = (m: THREE.Material, w: number, h: number, d: number, px: number, py: number, pz: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(px, py, pz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
    return mesh;
  };

  // body: two storeys of cream wall
  box(cream, W, H1 + H2, D, 0, (H1 + H2) / 2, 0);
  box(dado, W + 0.06, 1.5, D + 0.06, 0, 0.75, 0);              // tiled dado at street level

  // timber fascia at each floor line and under the eaves
  for (const y of [H1, H1 + H2, H1 + H2 + 0.1]) {
    box(timber, W + 0.5, y === H1 ? 0.42 : 0.5, D + 0.5, 0, y, 0);
  }

  // glazing: tall dark panes in white frames, four across per storey, front and back
  for (const side of [-1, 1]) {
    for (const level of [0, 1]) {
      const y = level === 0 ? 2.3 : 2.3 + H1;
      for (let i = -1.5; i <= 1.5; i++) {
        const px = i * 4.0;
        box(frameW, 3.0, level === 0 ? 2.2 : 2.6, 0.12, px, y, side * (D / 2 + 0.02));
        box(glass, 2.7, level === 0 ? 1.95 : 2.35, 0.08, px, y, side * (D / 2 + 0.09));
      }
    }
  }

  // upper balcony: slab, railing with pickets
  const balY = H1 + 0.35;
  box(cream, W + 0.8, 0.22, 1.5, 0, balY, D / 2 + 0.55);
  box(rail, W + 0.8, 0.1, 0.1, 0, balY + 1.05, D / 2 + 1.25);   // top rail
  box(rail, W + 0.8, 0.08, 0.08, 0, balY + 0.18, D / 2 + 1.25); // bottom rail
  for (let i = -8; i <= 8; i++) {
    box(rail, 0.07, 0.95, 0.07, i * 1.06, balY + 0.62, D / 2 + 1.25);
  }

  // the pointed arch: two quarter-ellipses meeting at an apex, drawn as voussoir blocks.
  // The first attempt pushed sin() around and produced two wedges hanging in mid-air over
  // the door -- a curve has to be sampled off a real parameterisation.
  const archZ = D / 2 + 0.22;
  const archW = 3.6, archH = 2.6, springY = 1.15;
  const pts: [number, number][] = [];
  for (const side of [-1, 1]) {
    for (let k = 0; k <= 8; k++) {
      const th = (k / 8) * (Math.PI / 2);
      pts.push([side * (archW / 2) * Math.cos(th), springY + archH * Math.sin(th)]);
    }
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const len = Math.hypot(x2 - x1, y2 - y1) * 1.15;
    if (len < 1e-3) continue;
    const seg = new THREE.Mesh(new THREE.BoxGeometry(len, 0.44, 0.36), timber);
    seg.position.set((x1 + x2) / 2, (y1 + y2) / 2, archZ);
    seg.rotation.z = Math.atan2(y2 - y1, x2 - x1);
    seg.castShadow = true;
    g.add(seg);
  }
  box(glass, archW - 0.5, 2.4, 0.12, 0, 1.35, archZ - 0.05);     // glazed doors inside the arch

  // steps and handrail up to the entrance
  for (let i = 0; i < 4; i++) {
    box(stone, 4.6 - i * 0.1, 0.22, 0.5, 0, 0.11 + i * 0.22, archZ + 1.6 - i * 0.5);
  }
  const hr = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 2.6), rail);
  hr.position.set(2.3, 1.25, archZ + 0.9);
  hr.rotation.x = 0.28;
  g.add(hr);

  // side gate and the signboard on the fascia
  box(green, 2.6, 2.1, 0.12, -W / 2 - 0.4, 1.05, D / 2 - 1.2);
  box(sign, 6.4, 1.1, 0.16, W / 2 - 4.2, H1 + H2 + 0.35, D / 2 + 0.3);

  // a low wall and planting, so the building does not sit in a vacuum
  box(cream, W + 3.0, 0.9, 0.3, 0, 0.45, D / 2 + 2.6);

  mergeStaticChildren(g);
  ctx.group.add(g);
  ctx.audit.push({ name: 'masjid', x, z, bottom: 0 });
  const hx = Math.abs(Math.cos(yaw)) * (W / 2 + 1.6) + Math.abs(Math.sin(yaw)) * (D / 2 + 2.8);
  const hz = Math.abs(Math.sin(yaw)) * (W / 2 + 1.6) + Math.abs(Math.cos(yaw)) * (D / 2 + 2.8);
  ctx.colliders.push({ minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz, h: H1 + H2 + 1 });
  return g;
}
