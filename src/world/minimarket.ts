import * as THREE from 'three';
import { canvasTexture, mergeStaticChildren } from '../core/utils';

/**
 * Minimarket, after the reference photo of an Indomaret on Panglima Polim
 * (reference/assets/minimarket-ref-0.jpg, CC BY 4.0).
 *
 * What the photo actually shows, and what this models:
 *  - a fascia of three horizontal bands, red over blue over a wide yellow, with a white oval
 *    badge carrying the name at the right end
 *  - a shopfront that is glass from the sill to the ceiling, dark mullions, shelves and posters
 *    visible behind it
 *  - a blue "GRATIS PARKIR" banner hung above the entrance
 *  - a small A-frame sign on the pavement
 *  - an AC condenser box on the wall above the glazing
 *  - the yellow-painted kerb strip in front
 *
 * Name is a plesetan, like every shop in this city.
 */
export interface ShopCtx {
  group: THREE.Group;
  colliders: { minX: number; maxX: number; minZ: number; maxZ: number; h: number }[];
  audit: { name: string; x: number; z: number; bottom: number }[];
}

function signTex(text: string, w = 512, h = 128, bg = '#1b3f8f', fg = '#ffffff', size = 58): THREE.Texture {
  return canvasTexture(w, h, (ctx, cw, ch) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cw, ch);
    let s = size;
    ctx.font = `800 ${s}px system-ui, sans-serif`;
    while (ctx.measureText(text).width > cw - 32 && s > 18) {
      s -= 3;
      ctx.font = `800 ${s}px system-ui, sans-serif`;
    }
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cw / 2, ch / 2 + 2);
  });
}

/** The shelving you see through the glass: warm lit rows with product blocks. */
function interiorTex(): THREE.Texture {
  return canvasTexture(256, 256, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#f4efe2');
    g.addColorStop(1, '#cfc6b2');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    for (let row = 0; row < 5; row++) {
      const y = 26 + row * 44;
      ctx.fillStyle = '#8a8578';
      ctx.fillRect(0, y + 26, w, 5);
      for (let x = 6; x < w - 6; x += 15) {
        ctx.fillStyle = ['#d94f4f', '#2f6fd0', '#f2b134', '#39b54a', '#e07b2a', '#8a3ad9'][(row * 7 + x) % 6];
        ctx.fillRect(x, y + 2, 11, 22);
      }
    }
  });
}

export function buildMinimarket(ctx: ShopCtx, x: number, z: number, yaw: number, name = 'INDOMERET'): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;

  const W = 13, H = 4.4, D = 9;
  const plaster = new THREE.MeshStandardMaterial({ color: 0xe8e3d6, roughness: 0.95 });
  const frame = new THREE.MeshStandardMaterial({ color: 0x2f3a44, metalness: 0.5, roughness: 0.5 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0xcfe6f2, transparent: true, opacity: 0.32, roughness: 0.08, metalness: 0.1,
    depthWrite: false,
  });

  const box = (mat: THREE.Material, w: number, h: number, d: number, px: number, py: number, pz: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(px, py, pz);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };

  // body: back and sides solid, the street face is glazing
  box(plaster, W, H, D, 0, H / 2, -D / 2);
  box(plaster, 0.4, H, D, -W / 2 + 0.2, H / 2, -D / 2);
  box(plaster, 0.4, H, D, W / 2 - 0.2, H / 2, -D / 2);

  // the lit interior behind the glass
  const inside = new THREE.Mesh(
    new THREE.PlaneGeometry(W - 1.4, H - 1.2),
    new THREE.MeshStandardMaterial({ map: interiorTex(), roughness: 0.9, emissive: 0xffffff, emissiveMap: interiorTex(), emissiveIntensity: 0.28 })
  );
  inside.position.set(0, (H - 1.2) / 2 + 0.6, -D + 0.6);
  g.add(inside);

  // glazing with dark mullions
  const glassFront = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.9, 2.9), glass);
  glassFront.position.set(0, 2.05, 0.02);
  g.add(glassFront);
  for (let i = 0; i <= 4; i++) {
    box(frame, 0.12, 3.3, 0.16, -W / 2 + 0.45 + i * ((W - 0.9) / 4), 1.95, 0.05);
  }
  box(frame, W - 0.6, 0.16, 0.2, 0, 3.6, 0.05);
  box(frame, W - 0.6, 0.2, 0.22, 0, 0.62, 0.05);   // sill

  // fascia: three bands and the badge, as in the reference
  const bandY = [3.95, 3.62, 3.24];
  const bandH = [0.3, 0.34, 0.5];
  const bandC = [0xc0392b, 0x2f6fd0, 0xf2c14e];
  for (let i = 0; i < 3; i++) {
    const tex = i === 2 ? signTex(name, 512, 96, '#f2c14e', '#1b3f8f', 54) : null;
    const mat = tex
      ? new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 })
      : new THREE.MeshStandardMaterial({ color: bandC[i], roughness: 0.7 });
    const band = new THREE.Mesh(new THREE.BoxGeometry(W, bandH[i], 0.22), mat);
    band.position.set(0, bandY[i], 0.06);
    g.add(band);
  }
  // badge: white oval in a red ring at the right end of the yellow band
  const badge = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 0.42, 0.06, 24),
    new THREE.MeshStandardMaterial({ color: 0xf6f3ea, roughness: 0.5 })
  );
  badge.rotation.x = Math.PI / 2;
  badge.position.set(W / 2 - 1.5, 3.24, 0.2);
  g.add(badge);

  // blue GRATIS PARKIR banner above the door
  const banner = new THREE.Mesh(
    new THREE.PlaneGeometry(5.2, 0.8),
    new THREE.MeshStandardMaterial({ map: signTex('GRATIS PARKIR', 512, 96, '#1f5aa8'), roughness: 0.85, side: THREE.DoubleSide })
  );
  banner.position.set(1.2, 4.5, 0.16);
  g.add(banner);

  // AC condenser above the glazing, left of centre, as in the photo
  box(new THREE.MeshStandardMaterial({ color: 0xd7d4c8, metalness: 0.4, roughness: 0.6 }), 1.1, 0.62, 0.42, -W / 2 + 2.2, 4.05, 0.3);

  // A-frame sign on the pavement
  const aframe = new THREE.Mesh(
    new THREE.PlaneGeometry(0.75, 0.95),
    new THREE.MeshStandardMaterial({ map: signTex('PARKIR', 256, 320, '#f1c40f', '#1b1b1b', 44), roughness: 0.9, side: THREE.DoubleSide })
  );
  aframe.position.set(-W / 2 + 1.4, 0.55, 1.7);
  aframe.rotation.y = 0.3;
  g.add(aframe);

  // yellow-kissed kerb strip in front of the shop
  box(new THREE.MeshStandardMaterial({ color: 0xd9b21c, roughness: 0.95 }), W - 1, 0.12, 1.0, 0, 0.06, 1.1);

  ctx.group.add(g);
  ctx.audit.push({ name: 'minimarket', x, z, bottom: 0 });
  const halfX = Math.abs(Math.cos(yaw)) * (W / 2) + Math.abs(Math.sin(yaw)) * (D / 2) + 1;
  const halfZ = Math.abs(Math.sin(yaw)) * (W / 2) + Math.abs(Math.cos(yaw)) * (D / 2) + 1;
  ctx.colliders.push({ minX: x - halfX, maxX: x + halfX, minZ: z - halfZ, maxZ: z + halfZ, h: H });
  mergeStaticChildren(g);
  return g;
}
