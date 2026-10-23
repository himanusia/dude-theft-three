import * as THREE from 'three';
import { canvasTexture } from '../core/utils';

/**
 * Pos polisi — the neighbourhood traffic police post, after
 * reference/assets/pospolisi-ref-1.jpg (Pos Alun-alun Satlantas Polres Jombang, Wikimedia,
 * CC BY 4.0). What the photo shows and what this models:
 *
 *  - a tall blue sign panel on two posts, white lettering, logos at each end
 *  - a blue booth/barrier block below the sign
 *  - behind it a white building with a blue trim band and a terracotta tile roof
 *  - black-and-yellow bollards along the kerb
 *
 * The name on the board is a plesetan, like every sign in this city.
 */
export interface PosCtx {
  group: THREE.Group;
  colliders: { minX: number; maxX: number; minZ: number; maxZ: number; h: number }[];
  audit: { name: string; x: number; z: number; bottom: number }[];
}

function boardTex(line1: string, line2: string): THREE.Texture {
  return canvasTexture(512, 256, (ctx, w, h) => {
    ctx.fillStyle = '#1565c0';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#e8f1ff';
    ctx.lineWidth = 8;
    ctx.strokeRect(10, 10, w - 20, h - 20);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 46px system-ui, sans-serif';
    ctx.fillText(line1, w / 2, h * 0.32);
    ctx.font = '800 40px system-ui, sans-serif';
    ctx.fillText(line2, w / 2, h * 0.58);
    // two badge discs, as on the reference board
    for (const bx of [52, w - 52]) {
      ctx.beginPath();
      ctx.arc(bx, h / 2, 30, 0, Math.PI * 2);
      ctx.fillStyle = '#f7d13d';
      ctx.fill();
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#1b1b1b';
      ctx.stroke();
    }
  });
}

export function buildPosPolisi(ctx: PosCtx, x: number, z: number, yaw: number, line1 = 'POS LANTAS', line2 = 'POLSEK THAMRIN'): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;

  const white = new THREE.MeshStandardMaterial({ color: 0xf0eee8, roughness: 0.95 });
  const blue = new THREE.MeshStandardMaterial({ color: 0x1565c0, roughness: 0.8 });
  const tile = new THREE.MeshStandardMaterial({ color: 0xa04a33, roughness: 0.95 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x8f979e, metalness: 0.6, roughness: 0.45 });
  const black = new THREE.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.8 });
  const yellow = new THREE.MeshStandardMaterial({ color: 0xf2c14e, roughness: 0.8 });

  const box = (mat: THREE.Material, w: number, h: number, d: number, px: number, py: number, pz: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(px, py, pz);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };

  // the office behind: white walls, blue band, red tile roof
  box(white, 9, 3.6, 6, 0, 1.8, -4.2);
  box(blue, 9.1, 0.35, 6.1, 0, 3.1, -4.2);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(9.8, 0.5, 6.8), tile);
  roof.position.set(0, 3.85, -4.2);
  roof.castShadow = true;
  g.add(roof);
  // windows with blue frames
  for (const wx of [-3, -1, 1, 3]) {
    box(blue, 1.1, 1.2, 0.1, wx, 2.0, -1.2);
    box(new THREE.MeshStandardMaterial({ color: 0x2b3a44, roughness: 0.35, metalness: 0.2 }), 0.95, 1.05, 0.06, wx, 2.0, -1.15);
  }
  // door
  box(blue, 1.2, 2.2, 0.1, 0, 1.2, -1.2);

  // the sign: two posts and a blue panel above the booth
  for (const px of [-2.1, 2.1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 4.4, 8), steel);
    post.position.set(px, 2.2, 0.9);
    post.castShadow = true;
    g.add(post);
  }
  const panel = new THREE.Mesh(
    new THREE.BoxGeometry(5.2, 1.9, 0.14),
    new THREE.MeshStandardMaterial({ map: boardTex(line1, line2), roughness: 0.7 })
  );
  panel.position.set(0, 3.5, 0.9);
  panel.castShadow = true;
  g.add(panel);

  // booth / barrier block under the sign
  box(blue, 4.6, 1.15, 1.4, 0, 0.58, 1.0);
  box(white, 4.7, 0.12, 1.5, 0, 1.2, 1.0);

  // black-and-yellow bollards on the kerb
  for (const bx of [-3.2, -1.6, 0, 1.6, 3.2]) {
    box(black, 0.16, 0.9, 0.16, bx, 0.45, 2.6);
    box(yellow, 0.17, 0.18, 0.17, bx, 0.72, 2.6);
  }

  ctx.group.add(g);
  ctx.audit.push({ name: 'pos-polisi', x, z, bottom: 0 });
  const halfX = Math.abs(Math.cos(yaw)) * 4.9 + Math.abs(Math.sin(yaw)) * 3.4;
  const halfZ = Math.abs(Math.sin(yaw)) * 4.9 + Math.abs(Math.cos(yaw)) * 3.4;
  ctx.colliders.push({ minX: x - halfX, maxX: x + halfX, minZ: z - halfZ, maxZ: z + halfZ, h: 4 });
  return g;
}
