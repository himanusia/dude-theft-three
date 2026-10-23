import * as THREE from 'three';
import { canvasTexture, mergeStaticChildren } from '../core/utils';
import type { PosCtx } from './pospolisi';

/**
 * Pasar daerah — the traditional market hall, after reference/assets/pasar-ref-0.jpg
 * (Traditional market of Kalibaru Wetan, Banyuwangi; Wikimedia, CC BY-SA 4.0).
 *
 * The photo is taken inside the hall, so what it teaches is the interior vocabulary:
 *   - exposed timber roof trusses under a corrugated roof, light leaking between sheets
 *   - a big green directional board with cream stencilled lettering and red arrows
 *   - a yellow banner across the aisle
 *   - trestle tables with pale plywood tops on dark legs, goods stacked on them
 *   - red and blue plastic stools, coloured buckets and basins, stacked crates
 *   - green-painted stall frames, and a narrow concrete aisle between the rows
 *
 * The name is a plesetan, like every sign in this city.
 */
function boardTex(): THREE.Texture {
  return canvasTexture(512, 256, (ctx, w, h) => {
    ctx.fillStyle = '#9dbb3c';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#f2f0e4';
    ctx.lineWidth = 6;
    ctx.strokeRect(8, 8, w - 16, h - 16);
    ctx.fillStyle = '#1f2a17';
    ctx.textAlign = 'left';
    ctx.font = '700 34px Arial, sans-serif';
    ctx.fillText('3. AREA PERACANGAN', 28, 62);
    ctx.fillText('5. AREA SAYUR MAYUR', 28, 130);
    ctx.fillText('6. AREA IKAN & DAGING', 28, 198);
    // the red arrows the board uses instead of words
    for (let i = 0; i < 3; i++) {
      const y = 52 + i * 68;
      ctx.fillStyle = '#d33f2c';
      ctx.beginPath();
      ctx.moveTo(w - 120, y - 16);
      ctx.lineTo(w - 40, y + 2);
      ctx.lineTo(w - 120, y + 20);
      ctx.closePath();
      ctx.fill();
    }
  });
}

function bannerTex(name: string): THREE.Texture {
  return canvasTexture(512, 96, (ctx, w, h) => {
    ctx.fillStyle = '#f2c518';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#8a2b12';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 40px Arial, sans-serif';
    ctx.fillText(`I ♥ ${name}`, w / 2, h * 0.36);
    ctx.font = '600 24px Arial, sans-serif';
    ctx.fillText('BUKTIKAN CINTAMU', w / 2, h * 0.72);
  });
}

export function buildPasar(ctx: PosCtx, x: number, z: number, yaw: number, name = 'PASAR DAERAH KALIMATI'): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;

  const W = 28, D = 20, EAVE = 5.2;
  const concrete = new THREE.MeshStandardMaterial({ color: 0x9a978d, roughness: 1 });
  const aisle = new THREE.MeshStandardMaterial({ color: 0x86837a, roughness: 1 });
  const timber = new THREE.MeshStandardMaterial({ color: 0x6b4a30, roughness: 0.95 });
  // The underside of a roof faces down, so it only receives bounce light. With metalness 0.45
  // and nothing to reflect it rendered as a black slab across the frame; this is what an
  // open market roof actually looks like from inside -- pale zinc, barely any specular.
  const zinc = new THREE.MeshStandardMaterial({ color: 0xb6bbbc, roughness: 0.9, metalness: 0.02, emissive: 0x22262a, emissiveIntensity: 0.5 });
  const greenFrame = new THREE.MeshStandardMaterial({ color: 0x2f6b4f, roughness: 0.85 });
  const ply = new THREE.MeshStandardMaterial({ color: 0xcfc0a0, roughness: 0.95 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x35322c, roughness: 0.9 });
  const board = new THREE.MeshStandardMaterial({ map: boardTex(), roughness: 0.85 });
  const banner = new THREE.MeshStandardMaterial({ map: bannerTex(name), roughness: 0.85 });

  const box = (m: THREE.Material, bw: number, bh: number, bd: number, px: number, py: number, pz: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), m);
    mesh.position.set(px, py, pz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
    return mesh;
  };

  // floor: a concrete apron with a darker aisle down the middle
  box(concrete, W, 0.24, D, 0, 0.12, 0);
  box(aisle, 4.4, 0.02, D - 1.0, 0, 0.25, 0);

  // columns and the truss the roof sits on
  const colX = [-W / 2 + 1.6, -4, 4, W / 2 - 1.6];
  for (const cx of colX) {
    for (const cz of [-D / 2 + 1.4, 0, D / 2 - 1.4]) {
      box(dark, 0.26, EAVE, 0.26, cx, EAVE / 2, cz);
    }
    box(timber, 0.2, 0.24, D, cx, EAVE + 0.1, 0);      // purlin along the hall
  }
  for (const cz of [-D / 2 + 1.4, 0, D / 2 - 1.4]) {
    box(timber, W, 0.26, 0.22, 0, EAVE + 0.32, cz);    // tie beam across
  }

  // the roof: two zinc slopes with a ridge gap, so light reads through
  for (const side of [-1, 1]) {
    const slope = new THREE.Mesh(new THREE.BoxGeometry(W + 1.6, 0.14, D / 2 + 1.4), zinc);
    slope.position.set(0, EAVE + 1.25, side * (D / 4 + 0.2));
    slope.rotation.x = side * -0.46;
    slope.castShadow = true;
    g.add(slope);
  }
  box(timber, W + 1.6, 0.2, 0.3, 0, EAVE + 2.5, 0);    // ridge

  // stall rows either side of the aisle: trestle table, back shelf, crates of goods
  const produce = [0xc0392b, 0x6aa84f, 0xe8c547, 0xb45f06, 0x2f6b4f];
  for (const side of [-1, 1]) {
    for (let i = -2; i <= 2; i++) {
      const px = side * (2.6 + 1.1);
      const pz = i * 3.4;
      // trestle table
      box(ply, 2.4, 0.12, 2.6, px, 0.92, pz);
      for (const lx of [-1.0, 1.0]) {
        for (const lz of [-1.1, 1.1]) box(dark, 0.08, 0.92, 0.08, px + lx, 0.46, pz + lz);
      }
      // goods: a couple of shallow crates in flat colour, and a woven basket
      for (let k = 0; k < 3; k++) {
        const mat = new THREE.MeshStandardMaterial({ color: produce[(i + k + 5) % produce.length], roughness: 0.9 });
        box(mat, 0.7, 0.16, 0.5, px - 0.75 + k * 0.75, 1.06, pz - 0.6);
      }
      box(ply, 1.0, 0.3, 0.7, px, 1.13, pz + 0.7);
      // back shelf with stock
      box(greenFrame, 0.1, 2.0, 2.6, px + side * 1.0, 1.0, pz);
      for (let k = 0; k < 3; k++) box(dark, 0.7, 0.2, 2.2, px + side * 1.0, 0.9 + k * 0.45, pz);
      // a plastic stool, because there is always one
      const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.42, 8), new THREE.MeshStandardMaterial({ color: i % 2 ? 0xc0392b : 0x2b6fa8, roughness: 0.8 }));
      stool.position.set(px - side * 1.1, 0.21, pz + 0.9);
      stool.castShadow = true;
      g.add(stool);
    }
  }

  // hanging signage: the green board near the entrance, the yellow banner further in
  const signBoard = new THREE.Mesh(new THREE.BoxGeometry(5.2, 2.4, 0.12), board);
  signBoard.position.set(-3.2, 4.2, D / 2 - 1.2);
  signBoard.castShadow = true;
  g.add(signBoard);

  const ban = new THREE.Mesh(new THREE.BoxGeometry(6.4, 1.0, 0.1), banner);
  ban.position.set(3.4, 4.4, -2.0);
  ban.castShadow = true;
  g.add(ban);

  mergeStaticChildren(g);
  ctx.group.add(g);
  ctx.audit.push({ name: 'pasar', x, z, bottom: 0 });
  const hx = Math.abs(Math.cos(yaw)) * (W / 2 + 1) + Math.abs(Math.sin(yaw)) * (D / 2 + 1);
  const hz = Math.abs(Math.sin(yaw)) * (W / 2 + 1) + Math.abs(Math.cos(yaw)) * (D / 2 + 1);
  ctx.colliders.push({ minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz, h: EAVE + 2.6 });
  return g;
}
