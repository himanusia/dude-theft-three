import * as THREE from 'three';
import { AABB, canvasTexture, pick, rand, randInt, roundedBox } from '../core/utils';

/**
 * Reusable interior kit.
 *
 * One room shell + a per-kind layout, so minimarket / warteg / bengkel / kopi /
 * apotek / laundry / salon all share the same walls, floor, ceiling, lights and
 * collision plumbing. Interiors are built once per kind and teleported into — the
 * cheap "GTA interior" trick.
 *
 * All names are parodies (plesetan), no real Indonesian brands.
 */

export type InteriorKind = 'minimarket' | 'warteg' | 'bengkel' | 'kopi' | 'apotek' | 'laundry' | 'salon';

export interface Interior {
  kind: InteriorKind;
  name: string;
  group: THREE.Group;
  colliders: AABB[];
  spawn: THREE.Vector3;
  exit: THREE.Vector3;
  bounds: AABB;
}

/** An interior that has been placed in the world (rooms are built once per kind). */
export interface PlacedInterior extends Interior {
  origin: THREE.Vector3;
}

interface RoomSpec {
  w: number;
  d: number;
  h: number;
}

const ROOMS: Record<InteriorKind, RoomSpec> = {
  minimarket: { w: 11, d: 8, h: 3.4 },
  warteg: { w: 9, d: 7.5, h: 3.2 },
  bengkel: { w: 12, d: 9, h: 4.6 },
  kopi: { w: 8, d: 6.5, h: 3.2 },
  apotek: { w: 10.5, d: 8, h: 3.3 },
  laundry: { w: 9.5, d: 7.5, h: 3.2 },
  salon: { w: 9, d: 7, h: 3.1 },
};

export const INTERIOR_NAMES: Record<InteriorKind, string[]> = {
  minimarket: ['ALFAMURTI', 'INDOMERET', 'MARTABAK MART'],
  warteg: ['WARTEG BAHARI', 'WARTEG SIAP JIWO', 'WARUNG PRASMANAN'],
  bengkel: ['BENGKEL AHOS', 'MOTOR SEHAT', 'TAMBAL BAN PAK JITU'],
  kopi: ['KOPI TUBRUK', 'WARKOP MELAYU', 'KOPI LITERAN'],
  apotek: ['APOTEK SEHAT', 'APOTEK MURAH', 'APOTEK SINAR SEHAT'],
  laundry: ['LAUNDRY KILAT', 'LAUNDRY BERSIH', 'CUCI KILAT 6 JAM'],
  salon: ['PANGKAS RAMBUT', 'CUKUR RAMBUT 15K', 'SALON CANTIK'],
};

/** Per-kind colour scheme, so the seven rooms never look like the same shop. */
interface Palette {
  wall: number;
  trim: number;
  floor: string;
  grout: string;
  sign: string;
  light: number;
  /** height of the shop sign above the floor; raised where a layout needs the wall */
  signLift: number;
  checker?: boolean;
}

const PALETTES: Record<InteriorKind, Palette> = {
  minimarket: { wall: 0xefeae1, trim: 0x2f7d78, floor: '#d9d5cc', grout: 'rgba(120,116,110,0.35)', sign: '#c0392b', light: 0xffeccb, signLift: 1.0 },
  warteg: { wall: 0xefeae1, trim: 0x6b5b4a, floor: '#b9a98c', grout: 'rgba(120,110,95,0.35)', sign: '#2f5d3a', light: 0xffe6b8, signLift: 1.0 },
  bengkel: { wall: 0x8b8d90, trim: 0x6b5b4a, floor: '#6d6a63', grout: 'rgba(40,40,40,0.35)', sign: '#2f5d3a', light: 0xfff2d0, signLift: 1.0 },
  kopi: { wall: 0xefeae1, trim: 0x6b5b4a, floor: '#d9d5cc', grout: 'rgba(120,116,110,0.35)', sign: '#3f2a1d', light: 0xffdfae, signLift: 1.0 },
  apotek: { wall: 0xf2f8f4, trim: 0x2f8f6a, floor: '#e6efe9', grout: 'rgba(90,130,110,0.3)', sign: '#1f7a55', light: 0xeafff4, signLift: 1.0 },
  laundry: { wall: 0xe8eef6, trim: 0x2f6f9f, floor: '#dfe6ee', grout: 'rgba(80,110,140,0.3)', sign: '#2f6f9f', light: 0xe6f4ff, signLift: 1.0 },
  salon: { wall: 0xf7efec, trim: 0x8a4a5f, floor: '#ece0dc', grout: 'rgba(140,100,110,0.3)', sign: '#8a4a5f', light: 0xffe9f0, signLift: 0.7, checker: true },
};

function floorTexture(kind: InteriorKind): THREE.CanvasTexture {
  const p = PALETTES[kind];
  const tx = canvasTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = p.floor;
    ctx.fillRect(0, 0, w, h);
    if (p.checker) {
      // salon: warm checkerboard tiles
      for (let x = 0; x < w; x += 32) {
        for (let y = 0; y < h; y += 32) {
          if (((x + y) / 32) % 2 === 0) continue;
          ctx.fillStyle = 'rgba(150,105,118,0.28)';
          ctx.fillRect(x, y, 32, 32);
        }
      }
    }
    ctx.strokeStyle = p.grout;
    ctx.lineWidth = 2;
    for (let i = 0; i <= w; i += 32) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(w, i); ctx.stroke();
    }
    for (let i = 0; i < 120; i++) {
      ctx.fillStyle = `rgba(0,0,0,${rand(0.02, 0.06)})`;
      ctx.fillRect(rand(0, w), rand(0, h), rand(1, 4), rand(1, 4));
    }
  });
  tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
  tx.repeat.set(4, 4);
  return tx;
}

/** Fit a single line of text into `maxWidth` by shrinking the font, so long shop
 * names (APOTEK SINAR SEHAT, CUKUR RAMBUT 15K) never get clipped by the canvas. */
function fitFont(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, startSize: number): number {
  let size = startSize;
  ctx.font = `bold ${size}px ui-sans-serif, system-ui, sans-serif`;
  while (size > 12 && ctx.measureText(text).width > maxWidth) {
    size -= 2;
    ctx.font = `bold ${size}px ui-sans-serif, system-ui, sans-serif`;
  }
  return size;
}

function signTexture(text: string, bg: string, fg = '#ffffff'): THREE.CanvasTexture {
  return canvasTexture(512, 128, (ctx, w, h) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(0, h - 10, w, 10);
    ctx.fillStyle = fg;
    fitFont(ctx, text, w - 44, 62);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + 2);
  });
}

function posterTexture(lines: string[], bg: string, fg: string): THREE.CanvasTexture {
  return canvasTexture(256, 320, (ctx, w, h) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    lines.forEach((line, i) => {
      fitFont(ctx, line, w - 22, 34);
      ctx.fillText(line, w / 2, 70 + i * 46);
    });
  });
}

export function buildInterior(kind: InteriorKind): Interior {
  const spec = ROOMS[kind];
  const name = pick(INTERIOR_NAMES[kind]);
  const group = new THREE.Group();
  const colliders: AABB[] = [];
  const hw = spec.w / 2;
  const hd = spec.d / 2;

  const palette = PALETTES[kind];
  const wallMat = new THREE.MeshStandardMaterial({ color: palette.wall, roughness: 0.92 });
  const trimMat = new THREE.MeshStandardMaterial({ color: palette.trim, roughness: 0.8 });

  // ---- shell ----
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(spec.w, 0.1, spec.d),
    new THREE.MeshStandardMaterial({ map: floorTexture(kind), roughness: 0.9 })
  );
  floor.position.y = -0.05;
  floor.receiveShadow = true;
  group.add(floor);

  const ceiling = new THREE.Mesh(
    new THREE.BoxGeometry(spec.w, 0.12, spec.d),
    new THREE.MeshStandardMaterial({ color: 0xf2f0eb, roughness: 0.95 })
  );
  ceiling.position.y = spec.h;
  group.add(ceiling);

  // walls (thin boxes), back + two sides solid
  const wall = (w: number, d: number, x: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, spec.h, d), wallMat);
    m.position.set(x, spec.h / 2, z);
    m.castShadow = false;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };
  wall(spec.w, 0.2, 0, -hd); // back
  wall(0.2, spec.d, -hw, 0); // left
  wall(0.2, spec.d, hw, 0); // right
  // front wall with a 2.4 m doorway in the middle
  const doorW = 2.4;
  const side = (spec.w - doorW) / 2;
  wall(side, 0.2, -(doorW / 2 + side / 2), hd);
  wall(side, 0.2, doorW / 2 + side / 2, hd);

  // skirting in the kind's accent colour
  for (const [w, d, x, z] of [
    [spec.w, 0.08, 0, -hd + 0.12],
    [0.08, spec.d, -hw + 0.12, 0],
    [0.08, spec.d, hw - 0.12, 0],
  ] as [number, number, number, number][]) {
    const sk = new THREE.Mesh(new THREE.BoxGeometry(w, 0.16, d), trimMat);
    sk.position.set(x, 0.08, z);
    group.add(sk);
  }

  // ---- ceiling light panels + one real light ----
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 0.78, roughness: 0.4 });
  for (let i = 0; i < 3; i++) {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 0.7), lampMat);
    panel.position.set(-spec.w / 4 + (i * spec.w) / 4, spec.h - 0.16, 0);
    group.add(panel);
  }
  const light = new THREE.PointLight(palette.light, 26, 16, 2);
  light.position.set(0, spec.h - 0.5, 0);
  group.add(light);

  // ---- signage above the door (inside) ----
  const nameTex = signTexture(name, palette.sign);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(4.6, 1.15),
    new THREE.MeshStandardMaterial({
      map: nameTex,
      emissive: 0xffffff,
      emissiveMap: nameTex,
      emissiveIntensity: 0.35,
      roughness: 0.6,
    })
  );
  sign.position.set(0, spec.h - palette.signLift, -hd + 0.13);
  group.add(sign);

  // ---- shared prop helpers ----
  const addBox = (w: number, h: number, d: number, x: number, y: number, z: number, color: number, opts: any = {}) => {
    const m = new THREE.Mesh(roundedBox(w, h, d, opts.r ?? 0.03, 1), new THREE.MeshStandardMaterial({ color, roughness: opts.roughness ?? 0.75, metalness: opts.metalness ?? 0.05 }));
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };
  const addCollider = (x: number, z: number, w: number, d: number, h = 1.6) => {
    colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, h });
  };

  const shelfStock = (x: number, z: number, w: number, d: number, levels: number) => {
    const colors = [0xe74c3c, 0xf1c40f, 0x3498db, 0x2ecc71, 0x9b59b6, 0xe67e22, 0xf5f5f5, 0x1f8a70];
    // rows of products sitting on each shelf board
    for (let level = 0; level < levels; level++) {
      const rowY = 0.42 + level * 0.45;
      const count = Math.max(4, Math.floor(d / 0.42));
      for (let i = 0; i < count; i++) {
        const pz = z - d / 2 + 0.3 + (i * (d - 0.6)) / Math.max(1, count - 1);
        addBox(rand(0.22, 0.34), rand(0.24, 0.36), rand(0.2, 0.3), x + rand(-0.12, 0.12), rowY + 0.18, pz, pick(colors), { r: 0.02 });
      }
    }
  };

  // ---- per-kind layout ----
  if (kind === 'minimarket') {
    // three shelf rows
    for (let i = 0; i < 3; i++) {
      const sx = -3.2 + i * 3.2;
      addBox(0.9, 1.5, 4.6, sx, 0.75, -0.6, 0xd8d5cc);
      for (let l = 0; l < 3; l++) addBox(1.0, 0.06, 4.6, sx, 0.35 + l * 0.45, -0.6, 0xb9b5ab);
      shelfStock(sx, -0.6, 0.9, 4.6, 3);
      addCollider(sx, -0.6, 1.0, 4.7, 1.6);
    }
    // fridges along the back
    for (let i = 0; i < 3; i++) {
      const fx = -3 + i * 3;
      addBox(2.2, 2.2, 0.8, fx, 1.1, -hd + 0.55, 0xdadada);
      const glass = new THREE.Mesh(
        new THREE.BoxGeometry(2.0, 1.7, 0.06),
        new THREE.MeshStandardMaterial({ color: 0x9fd8e8, transparent: true, opacity: 0.45, roughness: 0.15, emissive: 0x67b7d1, emissiveIntensity: 0.35 })
      );
      glass.position.set(fx, 1.2, -hd + 0.95);
      group.add(glass);
      // drinks behind the glass + handle + brand strip
      for (let l = 0; l < 3; l++) {
        for (let k = 0; k < 6; k++) {
          addBox(0.16, 0.24, 0.16, fx - 0.85 + k * 0.34, 0.75 + l * 0.5, -hd + 0.7, pick([0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f]), { r: 0.02 });
        }
      }
      addBox(0.06, 0.5, 0.06, fx + 0.9, 1.25, -hd + 0.98, 0x9aa0a8, { metalness: 0.7, roughness: 0.3 });
      addCollider(fx, -hd + 0.55, 2.3, 0.9, 2.3);
    }
    // counter + cashier + register
    addBox(3.2, 1.05, 0.8, hw - 2.0, 0.52, hd - 1.6, 0x2f7d78);
    addBox(3.3, 0.08, 0.9, hw - 2.0, 1.08, hd - 1.6, 0xf2f2f2);
    addBox(0.5, 0.35, 0.4, hw - 2.0, 1.25, hd - 1.6, 0x2b2f36);
    addBox(0.6, 1.6, 0.6, hw - 0.9, 0.8, hd - 1.7, 0x8d6e63);
    addCollider(hw - 2.0, hd - 1.6, 3.3, 0.9, 1.2);
    // promo posters
    const promos: [string[], string, string][] = [
      [['PROMO', 'HEMAT', '20%'], '#f39c12', '#2b1a00'],
      [['BAYAR', 'DI KASIR', 'SAJA'], '#2f7d78', '#ffffff'],
      [['BUKA', '24 JAM', 'TIAP HARI'], '#c0392b', '#ffffff'],
    ];
    promos.forEach(([lines, bg, fg], i) => {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.5), new THREE.MeshStandardMaterial({ map: posterTexture(lines, bg, fg), roughness: 0.8 }));
      p.position.set(-hw + 0.15, 2.0, -2 + i * 2);
      p.rotation.y = Math.PI / 2;
      group.add(p);
    });
    addBox(0.9, 0.8, 0.9, -hw + 1.1, 0.4, hd - 1.2, 0x2f6fd0); // basket stack
    addCollider(-hw + 1.1, hd - 1.2, 1.0, 1.0, 0.9);
    addBox(1.2, 2.0, 0.7, hw - 0.9, 1.0, -1.4, 0x37474f); // ATM
    addCollider(hw - 0.9, -1.4, 1.3, 0.8, 2.0);
  }

  if (kind === 'warteg') {
    // glass display case
    addBox(4.2, 0.95, 0.9, -0.4, 0.5, -hd + 1.2, 0x8d6e63);
    addBox(4.2, 0.5, 0.9, -0.4, 1.2, -hd + 1.2, 0x8d6e63);
    const caseGlass = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.7, 0.06), new THREE.MeshStandardMaterial({ color: 0xbfe4f0, transparent: true, opacity: 0.4, roughness: 0.2 }));
    caseGlass.position.set(-0.4, 1.15, -hd + 1.64);
    group.add(caseGlass);
    for (let i = 0; i < 5; i++) addBox(0.5, 0.16, 0.45, -2.2 + i * 0.9, 1.12, -hd + 1.2, pick([0xe67e22, 0xc0392b, 0x27ae60, 0xf1c40f]));
    addCollider(-0.4, -hd + 1.2, 4.3, 1.0, 1.4);
    // menu board
    const menu = posterTexture(['NASI UDUK 12K', 'AYAM GORENG 15K', 'SAYUR 5K', 'ES TEH 4K'], '#2f2a24', '#ffd98a');
    const menuMesh = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.9), new THREE.MeshStandardMaterial({ map: menu, roughness: 0.85 }));
    menuMesh.position.set(hw - 0.12, 2.0, -1.2);
    menuMesh.rotation.y = -Math.PI / 2;
    group.add(menuMesh);
    // tables + stools
    for (let i = 0; i < 3; i++) {
      const tx = -2.6 + i * 2.6;
      const tz = 0.9;
      addBox(1.5, 0.08, 1.1, tx, 0.75, tz, 0x8d6e63);
      addBox(0.12, 0.75, 0.12, tx, 0.38, tz, 0x5d4037);
      for (const dz of [-0.9, 0.9]) addBox(0.42, 0.45, 0.42, tx, 0.22, tz + dz, 0xc0392b);
      addCollider(tx, tz, 1.6, 1.2, 0.8);
    }
  }

  if (kind === 'bengkel') {
    // car lift
    addBox(4.6, 0.12, 2.4, -1.4, 0.32, -0.6, 0x4a4f55);
    for (const dx of [-2.1, 2.1]) {
      addBox(0.16, 0.32, 2.2, -1.4 + dx, 0.16, -0.6, 0x9a9fa6);
    }
    // tool bench + toolbox
    addBox(3.4, 0.9, 0.8, 3.6, 0.45, -hd + 0.9, 0x6d4c41);
    addBox(1.0, 0.5, 0.6, 3.4, 1.15, -hd + 0.9, 0xc0392b);
    addCollider(3.6, -hd + 0.9, 3.5, 0.9, 1.2);
    // tyre stacks + drums
    for (let i = 0; i < 4; i++) {
      addBox(1.2, 0.3, 1.2, -hw + 1.0, 0.15 + i * 0.32, -2.6 + i * 0.02, 0x1c1c1f);
    }
    addCollider(-hw + 1.0, -2.6, 1.4, 1.4, 1.4);
    for (let i = 0; i < 3; i++) {
      addBox(0.7, 1.1, 0.7, -hw + 1.2 + i * 0.85, 0.55, 2.2, pick([0x2f6fd0, 0xc0392b, 0x27ae60]));
    }
    addCollider(-hw + 1.9, 2.2, 2.6, 0.9, 1.2);
    // hoist motor + poster
    addBox(0.8, 1.8, 0.6, hw - 0.8, 0.9, -2.8, 0x37474f);
    const promo = posterTexture(['SERVIS', 'RINGAN', 'MULAI 50K'], '#f39c12', '#231a00');
    const pm = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 2.0), new THREE.MeshStandardMaterial({ map: promo, roughness: 0.85 }));
    pm.position.set(-hw + 0.14, 2.4, 0.6);
    pm.rotation.y = Math.PI / 2;
    group.add(pm);
  }

  if (kind === 'kopi') {
    // bar counter
    addBox(5.4, 1.05, 0.9, 0, 0.52, -hd + 1.6, 0x5d4037);
    addBox(5.5, 0.1, 1.0, 0, 1.08, -hd + 1.6, 0x8d6e63);
    addCollider(0, -hd + 1.6, 5.6, 1.0, 1.2);
    // back shelf with cups/bottles
    addBox(5.0, 0.1, 0.4, 0, 1.5, -hd + 0.35, 0x6d4c41);
    addBox(5.0, 0.1, 0.4, 0, 1.95, -hd + 0.35, 0x6d4c41);
    for (let i = 0; i < 12; i++) {
      addBox(0.14, rand(0.2, 0.3), 0.14, -2.2 + i * 0.4, 1.68 + (i % 2) * 0.45, -hd + 0.35, pick([0xf5f5f5, 0xc98a3c, 0x2e7d32]));
    }
    // stools
    for (let i = 0; i < 4; i++) addBox(0.42, 0.55, 0.42, -1.8 + i * 1.2, 0.27, -hd + 2.6, 0xc0392b);
    // chalkboard menu
    const chalk = posterTexture(['KOPI HITAM 6K', 'KOPI SUSU 9K', 'INDOMIE 10K', 'GORENGAN 3K'], '#20241f', '#e8ffd6');
    const cb = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.7), new THREE.MeshStandardMaterial({ map: chalk, roughness: 0.95 }));
    cb.position.set(hw - 0.13, 1.9, -1.0);
    cb.rotation.y = -Math.PI / 2;
    group.add(cb);
    // packets hanging
    for (let i = 0; i < 6; i++) {
      addBox(0.14, 0.22, 0.03, -2.4 + i * 0.22, 2.5, hd - 1.2, pick([0xe74c3c, 0xf1c40f, 0x3498db]));
    }
  }

  if (kind === 'apotek') {
    // service counter with a pharmacist behind it
    addBox(4.6, 1.05, 0.85, 1.0, 0.52, -0.5, 0x2f8f6a);
    addBox(4.7, 0.09, 0.95, 1.0, 1.08, -0.5, 0xf7fbf9);
    addBox(0.6, 0.34, 0.42, 0.2, 1.29, -0.5, 0x2b2f36); // cash register
    addBox(0.5, 0.06, 0.3, 0.2, 1.1, -0.26, 0x1f242a, { r: 0.01 });
    addCollider(1.0, -0.5, 4.7, 0.95, 1.3);
    // pharmacist behind the counter: trousers, lab coat with collar, name tag, eyes
    addBox(0.58, 0.68, 0.34, 1.0, 0.34, -1.55, 0x2b3a52);
    for (const ax of [-0.16, 0.16]) addBox(0.2, 0.08, 0.34, 1.0 + ax, 0.04, -1.55, 0x1c1c22, { r: 0.02 });
    addBox(0.66, 0.8, 0.4, 1.0, 1.08, -1.55, 0xf8fbfa);
    addBox(0.2, 0.5, 0.06, 1.0, 1.1, -1.34, 0xe8f0ec, { r: 0.01 });
    addBox(0.3, 0.1, 0.32, 1.0, 1.5, -1.55, 0x2f8f6a);
    addBox(0.14, 0.14, 0.12, 0.76, 1.22, -1.34, 0x2f8f6a, { r: 0.02 }); // name tag
    for (const ax of [-0.4, 0.4]) {
      addBox(0.16, 0.56, 0.2, 1.0 + ax, 1.02, -1.5, 0xf8fbfa);
      addBox(0.15, 0.42, 0.17, 1.0 + ax * 1.02, 0.72, -1.42, 0xd9a273);
    }
    addBox(0.18, 0.12, 0.18, 1.0, 1.55, -1.55, 0xd9a273); // neck
    const phHead = new THREE.Mesh(
      new THREE.SphereGeometry(0.2, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0xd9a273, roughness: 0.88 })
    );
    phHead.position.set(1.0, 1.68, -1.55);
    phHead.castShadow = true;
    group.add(phHead);
    addBox(0.4, 0.1, 0.38, 1.0, 1.83, -1.56, 0x1c1c22, { r: 0.03 }); // hair cap
    for (const ex of [-0.07, 0.07]) addBox(0.05, 0.05, 0.03, 1.0 + ex, 1.69, -1.36, 0x22262c, { r: 0.01 });
    addCollider(1.0, -1.55, 0.9, 0.6, 1.9);
    // open medicine shelving flanking the counter (back panel + boards + boxes)
    for (const sx of [-3.5, 3.9]) {
      addBox(2.0, 1.72, 0.16, sx, 0.86, -hd + 0.12, 0xe6f0ea);
      for (const sideX of [-1, 1]) addBox(0.07, 1.72, 0.5, sx + sideX * 0.96, 0.86, -hd + 0.4, 0xdbe8e0);
      for (let l = 0; l < 3; l++) addBox(1.96, 0.05, 0.5, sx, 0.36 + l * 0.48, -hd + 0.4, 0xcbdcd3);
      for (let l = 0; l < 3; l++) {
        for (let i = 0; i < 6; i++) {
          addBox(
            rand(0.13, 0.2), rand(0.16, 0.24), rand(0.12, 0.18),
            sx - 0.78 + i * 0.31, 0.48 + l * 0.48, -hd + 0.52,
            pick([0xffffff, 0xe8f5ee, 0x2f8f6a, 0xf1c40f, 0x3498db, 0xc0392b]),
            { r: 0.01 }
          );
        }
      }
      addCollider(sx, -hd + 0.4, 2.1, 0.7, 1.8);
    }
    // green cross on the back wall, clear of the shop sign
    const crossMat = new THREE.MeshStandardMaterial({ color: 0x2fd07a, emissive: 0x1f9a58, emissiveIntensity: 0.8, roughness: 0.5 });
    const crossV = new THREE.Mesh(new THREE.BoxGeometry(0.32, 1.0, 0.08), crossMat);
    crossV.position.set(3.9, 2.6, -hd + 0.1);
    group.add(crossV);
    const crossH = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.32, 0.08), crossMat);
    crossH.position.set(3.9, 2.6, -hd + 0.1);
    group.add(crossH);
    // queue chairs against the left wall
    const chairX = -hw + 1.05;
    for (let i = 0; i < 3; i++) {
      const cz = -1.5 + i * 1.1;
      addBox(0.46, 0.09, 0.44, chairX, 0.45, cz, 0x2f8f6a);
      addBox(0.46, 0.5, 0.07, chairX, 0.7, cz - 0.19, 0x2f8f6a);
      for (const [lx, lz] of [[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]]) {
        addBox(0.05, 0.42, 0.05, chairX + lx, 0.21, cz + lz, 0x9aa0a8, { metalness: 0.5, roughness: 0.4 });
      }
    }
    addCollider(chairX, -0.4, 0.6, 3.2, 1.0);
    // BUKA 24 JAM + price list on the right wall
    const open24 = posterTexture(['BUKA', '24 JAM', 'TIAP HARI'], '#1f7a55', '#ffffff');
    const openMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1.25, 1.55),
      new THREE.MeshStandardMaterial({ map: open24, emissive: 0xffffff, emissiveMap: open24, emissiveIntensity: 0.25, roughness: 0.8 })
    );
    openMesh.position.set(hw - 0.11, 2.1, 1.1);
    openMesh.rotation.y = -Math.PI / 2;
    group.add(openMesh);
    const priceList = posterTexture(['PARASETAMOL 5K', 'OBAT BATUK 12K', 'VITAMIN 25K', 'MASKER 3K'], '#eaf6ef', '#1f5a3f');
    const priceMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.85), new THREE.MeshStandardMaterial({ map: priceList, roughness: 0.85 }));
    priceMesh.position.set(hw - 0.11, 1.9, -2.1);
    priceMesh.rotation.y = -Math.PI / 2;
    group.add(priceMesh);
    // oxygen tank by the counter
    addBox(0.34, 1.2, 0.34, 3.9, 0.6, 1.6, 0x2f6fd0, { metalness: 0.4, roughness: 0.5 });
    addBox(0.2, 0.16, 0.2, 3.9, 1.28, 1.6, 0x9aa0a8, { metalness: 0.7, roughness: 0.3 });
    addCollider(3.9, 1.6, 0.5, 0.5, 1.4);
  }

  if (kind === 'laundry') {
    // run of stacked front-loading machines along the back wall
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xdfe7ee, roughness: 0.6, metalness: 0.15 });
    const ringMat = new THREE.MeshStandardMaterial({ color: 0xb9c3cc, roughness: 0.35, metalness: 0.75 });
    const drumMat = new THREE.MeshStandardMaterial({ color: 0x25303a, roughness: 0.25, metalness: 0.4 });
    for (let i = 0; i < 3; i++) {
      const mx = -2.5 + i * 2.5;
      // plinth so the bottom machine sits on the floor instead of hovering on its feet
      addBox(1.62, 0.08, 0.96, mx, 0.04, -hd + 0.55, 0xb9c3cc, { metalness: 0.3, roughness: 0.6 });
      for (let lvl = 0; lvl < 2; lvl++) {
        const my = 0.5 + lvl * 0.98;
        const mz = -hd + 0.55;
        const body = new THREE.Mesh(roundedBox(1.5, 0.86, 0.9, 0.05, 2), bodyMat);
        body.position.set(mx, my, mz);
        body.castShadow = true;
        body.receiveShadow = true;
        group.add(body);
        const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.07, 18), ringMat);
        ring.rotation.x = Math.PI / 2;
        ring.position.set(mx, my, mz + 0.46);
        group.add(ring);
        const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.09, 18), drumMat);
        drum.rotation.x = Math.PI / 2;
        drum.position.set(mx, my, mz + 0.48);
        group.add(drum);
        addBox(0.5, 0.14, 0.06, mx + 0.45, my + 0.33, mz + 0.47, 0x2f6f9f); // control panel
        addBox(0.18, 0.08, 0.05, mx - 0.5, my + 0.36, mz + 0.48, 0x2b2f36); // detergent drawer
      }
    }
    addCollider(0, -hd + 0.55, 7.6, 1.0, 2.0);
    // folding table with piles of folded laundry
    addBox(2.8, 0.1, 1.2, 0.4, 0.86, 0.2, 0xf2f5f8);
    for (const [lx, lz] of [[-1.2, -0.4], [1.2, -0.4], [-1.2, 0.4], [1.2, 0.4]]) {
      addBox(0.08, 0.82, 0.08, 0.4 + lx, 0.41, 0.2 + lz, 0x9aa0a8, { metalness: 0.5, roughness: 0.4 });
    }
    addCollider(0.4, 0.2, 2.9, 1.3, 1.0);
    for (let i = 0; i < 4; i++) {
      addBox(rand(0.3, 0.5), rand(0.1, 0.18), rand(0.3, 0.4), -0.2 + i * 0.5, 0.95 + (i % 2) * 0.12, rand(-0.15, 0.3), pick([0xe8f3ff, 0xffd9e2, 0xfff3c4, 0xd6f5e3]), { r: 0.02 });
    }
    // plastic bag rack by the door (right side, so the left wall stays readable)
    addBox(0.06, 1.5, 0.06, hw - 2.1, 0.75, hd - 1.1, 0x9aa0a8, { metalness: 0.5, roughness: 0.4 });
    addBox(0.06, 1.5, 0.06, hw - 0.9, 0.75, hd - 1.1, 0x9aa0a8, { metalness: 0.5, roughness: 0.4 });
    addBox(1.32, 0.06, 0.06, hw - 1.5, 1.5, hd - 1.1, 0x9aa0a8, { metalness: 0.5, roughness: 0.4 });
    const bagMat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.72, roughness: 0.45 });
    for (let i = 0; i < 5; i++) {
      const bag = new THREE.Mesh(roundedBox(0.26, 0.42, 0.1, 0.03, 1), bagMat);
      bag.position.set(hw - 1.95 + i * 0.25, 1.24, hd - 1.1);
      group.add(bag);
    }
    addCollider(hw - 1.5, hd - 1.1, 1.5, 0.4, 1.6);
    // price board on the left wall
    const prices = posterTexture(['CUCI 6K / KG', 'SETRIKA 3K', 'EXPRESS 10K', 'ANTAR JEMPUT'], '#2f6f9f', '#ffffff');
    const priceMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 2.0), new THREE.MeshStandardMaterial({ map: prices, roughness: 0.85 }));
    priceMesh.position.set(-hw + 0.11, 1.9, -0.8);
    priceMesh.rotation.y = Math.PI / 2;
    group.add(priceMesh);
    // coin / detergent machine in the back-right corner
    addBox(0.9, 1.7, 0.6, hw - 0.9, 0.85, -hd + 1.9, 0xdfe7ee);
    addBox(0.5, 0.3, 0.06, hw - 0.9, 1.35, -hd + 2.18, 0x2f6f9f);
    addBox(0.18, 0.1, 0.05, hw - 0.75, 0.95, -hd + 2.19, 0x2b2f36);
    addCollider(hw - 0.9, -hd + 1.9, 1.0, 0.7, 1.8);
    // laundry basket trolley + a basket on the floor
    addBox(0.9, 0.5, 0.6, hw - 1.2, 0.55, 0.6, 0x9aa0a8, { metalness: 0.4, roughness: 0.5 });
    addBox(0.9, 0.06, 0.06, hw - 1.2, 0.85, 0.9, 0x9aa0a8);
    addBox(0.7, 0.14, 0.42, hw - 1.2, 0.42, 0.6, 0xf2f5f8);
    addCollider(hw - 1.2, 0.6, 1.0, 0.7, 1.0);
    addBox(0.72, 0.46, 0.56, -hw + 1.4, 0.23, 1.0, 0x2f6f9f);
    addBox(0.62, 0.16, 0.46, -hw + 1.4, 0.5, 1.0, 0xfff3c4, { r: 0.03 });
    addCollider(-hw + 1.4, 1.0, 0.8, 0.65, 0.7);
  }

  if (kind === 'salon') {
    const plum = 0x8a4a5f;
    const plumDark = 0x6b3648;
    const chrome = 0xb9c0c8;
    // two barber chairs facing the mirrors on the left wall
    for (let i = 0; i < 2; i++) {
      const cz = -1.5 + i * 2.7;
      const cx = -hw + 2.4; // stations along the left wall, facing the mirrors
      addBox(0.56, 0.1, 0.56, cx, 0.05, cz, plumDark); // base plate
      addBox(0.15, 0.42, 0.15, cx, 0.31, cz, chrome, { metalness: 0.65, roughness: 0.35 }); // pedestal
      addBox(0.66, 0.16, 0.64, cx, 0.6, cz, plum); // seat
      addBox(0.66, 0.62, 0.14, cx + 0.29, 0.96, cz, plum); // backrest
      addBox(0.14, 0.18, 0.5, cx + 0.3, 1.24, cz, plumDark); // headrest
      for (const az of [-1, 1]) addBox(0.42, 0.1, 0.1, cx + 0.02, 0.8, cz + az * 0.3, plumDark); // armrests
      addBox(0.1, 0.34, 0.1, cx - 0.5, 0.17, cz, chrome); // footrest pole
      addBox(0.34, 0.08, 0.34, cx - 0.5, 0.36, cz, plumDark); // footrest
      addCollider(cx, cz, 0.9, 0.9, 1.4);
      // mirror with a lit strip above it + shelf below
      const mirror = new THREE.Mesh(
        new THREE.PlaneGeometry(1.35, 1.45),
        new THREE.MeshStandardMaterial({
          color: 0xd6ecf4,
          metalness: 0.85,
          roughness: 0.08,
          emissive: 0x8fc6da,
          emissiveIntensity: 0.28,
        })
      );
      mirror.position.set(-hw + 0.12, 1.8, cz);
      mirror.rotation.y = Math.PI / 2;
      group.add(mirror);
      const housing = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, 0.05, 1.45),
        new THREE.MeshStandardMaterial({ color: 0x33262b, roughness: 0.7 })
      );
      housing.position.set(-hw + 0.16, 2.72, cz);
      group.add(housing);
      const glow = new THREE.Mesh(
        new THREE.BoxGeometry(0.11, 0.11, 1.42),
        new THREE.MeshStandardMaterial({ color: 0xfff0c8, emissive: 0xffc766, emissiveIntensity: 1.7, roughness: 0.3 })
      );
      glow.position.set(-hw + 0.2, 2.64, cz);
      group.add(glow);
      addBox(0.28, 0.05, 1.2, -hw + 0.32, 0.98, cz, 0xf3e6ea);
    }
    // shelf of bottles above the cabinet (the salon sign is lifted to clear it)
    for (const shelfY of [1.15, 1.55]) {
      addBox(2.4, 0.07, 0.4, 0.9, shelfY, -hd + 0.32, 0xe4c7cf);
      for (let i = 0; i < 6; i++) {
        addBox(
          0.1, rand(0.14, 0.2), 0.1,
          0.0 + i * 0.36, shelfY + 0.13, -hd + 0.32,
          pick([0x2f6fd0, 0xc0392b, 0xf1c40f, 0x2f8f6a, 0xffffff, 0xffd9e2, 0x8a4a5f]),
          { r: 0.02 }
        );
      }
    }
    // wall clock on the right wall
    const clock = new THREE.Mesh(
      new THREE.CylinderGeometry(0.32, 0.32, 0.08, 18),
      new THREE.MeshStandardMaterial({ color: 0xfdf8f4, roughness: 0.6 })
    );
    clock.rotation.z = Math.PI / 2;
    clock.position.set(hw - 0.14, 2.3, 0.9);
    group.add(clock);
    const hand = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.22, 0.02),
      new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.6 })
    );
    hand.position.set(hw - 0.19, 2.36, 0.9);
    group.add(hand);
    // low cabinet with folded towels on the back wall
    addBox(2.6, 0.9, 0.5, 0.9, 0.45, -hd + 0.3, 0xe8d6db);
    addBox(2.5, 0.06, 0.54, 0.9, 0.93, -hd + 0.3, 0xd8bfc7);
    for (let i = 0; i < 3; i++) {
      addBox(0.5, 0.12, 0.34, 0 + i * 0.8, 1.02, -hd + 0.3, pick([0xffffff, 0xfff3f6, 0xf6e8c8]), { r: 0.03 });
    }
    addCollider(0.9, -hd + 0.3, 2.7, 0.6, 1.1);
    // waiting bench near the door
    addBox(2.4, 0.16, 0.66, -2.7, 0.5, hd - 1.1, plumDark);
    addBox(2.4, 0.52, 0.14, -2.7, 0.86, hd - 1.38, plumDark);
    for (const [lx, lz] of [[-1.0, -0.24], [1.0, -0.24], [-1.0, 0.24], [1.0, 0.24]]) {
      addBox(0.08, 0.42, 0.08, -2.7 + lx, 0.21, hd - 1.1 + lz, chrome, { metalness: 0.5, roughness: 0.4 });
    }
    addCollider(-2.7, hd - 1.1, 2.5, 0.8, 1.0);
    // price board on the back wall, left of the shop sign
    const price = posterTexture(['CUKUR 15K', 'CUKUR + CREAM 25K', 'CATOK 20K', 'CUCI BLOW 30K'], '#2a2026', '#ffd9e2');
    const priceMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 1.8),
      new THREE.MeshStandardMaterial({ map: price, emissive: 0xffffff, emissiveMap: price, emissiveIntensity: 0.18, roughness: 0.85 })
    );
    priceMesh.position.set(-3.3, 1.95, -hd + 0.11);
    group.add(priceMesh);
    // potted plant by the door
    addBox(0.4, 0.42, 0.4, hw - 0.8, 0.21, hd - 1.3, 0xb0785a, { r: 0.03 });
    const leaf = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.42, 0),
      new THREE.MeshStandardMaterial({ color: 0x2bae4a, roughness: 1, flatShading: true })
    );
    leaf.position.set(hw - 0.8, 0.72, hd - 1.3);
    group.add(leaf);
  }

  // extra clutter so the room reads as a working shop (legacy rooms only, the new
  // layouts are already dressed and random boxes would intersect their furniture)
  const clutterColors = [0x8d6e63, 0xc0392b, 0x2f6fd0, 0xf1c40f];
  const legacy = kind === 'minimarket' || kind === 'warteg' || kind === 'bengkel' || kind === 'kopi';
  for (let i = 0; legacy && i < 6; i++) {
    addBox(rand(0.4, 0.7), rand(0.3, 0.55), rand(0.4, 0.6), rand(-hw + 1.2, hw - 1.2), 0.2, rand(-hd + 1.2, hd - 2.2), pick(clutterColors), { r: 0.02 });
  }
  const domeMat = new THREE.MeshStandardMaterial({ color: 0x1b1b1f, roughness: 0.4, metalness: 0.4 });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), domeMat);
  dome.position.set(hw - 0.9, spec.h - 0.35, hd - 0.9);
  dome.rotation.x = Math.PI;
  group.add(dome);
  const matMesh = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.03, 0.8), new THREE.MeshStandardMaterial({ color: 0x8d3b3b, roughness: 0.95 }));
  matMesh.position.set(0, 0.02, hd - 1.2);
  group.add(matMesh);

  // ---- door frame + exit marker ----
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x2b2b30, roughness: 0.7 });
  const frameTop = new THREE.Mesh(new THREE.BoxGeometry(doorW + 0.3, 0.16, 0.3), frameMat);
  frameTop.position.set(0, 2.5, hd);
  group.add(frameTop);
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.5, 0.3), frameMat);
    post.position.set(sx * (doorW / 2 + 0.08), 1.25, hd);
    group.add(post);
  }
  const exitMat = new THREE.MeshStandardMaterial({ color: 0x7fe08a, emissive: 0x2f8f4a, emissiveIntensity: 0.8 });
  const exitPad = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.04, 0.9), exitMat);
  exitPad.position.set(0, 0.03, hd - 0.6);
  group.add(exitPad);

  // a small piece of street in front of the door, so the doorway reads as a shopfront
  const pavement = new THREE.Mesh(
    new THREE.BoxGeometry(spec.w + 6, 0.22, 6),
    new THREE.MeshStandardMaterial({ color: 0xc8c8d0, roughness: 0.95 })
  );
  pavement.position.set(0, -0.11, hd + 3);
  pavement.receiveShadow = true;
  group.add(pavement);
  const farWall = new THREE.Mesh(
    new THREE.BoxGeometry(spec.w + 8, 6, 0.4),
    new THREE.MeshStandardMaterial({ color: 0x9aa0aa, roughness: 0.95 })
  );
  farWall.position.set(0, 3, hd + 7.2);
  group.add(farWall);
  for (const sx of [-1, 1]) {
    const planter = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.7, 0.9),
      new THREE.MeshStandardMaterial({ color: 0x8d6e63, roughness: 0.95 })
    );
    planter.position.set(sx * 3.2, 0.35, hd + 1.6);
    planter.castShadow = true;
    group.add(planter);
    const bush = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.55, 0),
      new THREE.MeshStandardMaterial({ color: 0x2bae4a, roughness: 1, flatShading: true })
    );
    bush.position.set(sx * 3.2, 1.05, hd + 1.6);
    group.add(bush);
  }

  const bounds: AABB = { minX: -hw, maxX: hw, minZ: -hd, maxZ: hd, h: spec.h };
  const spawn = new THREE.Vector3(0, 0, hd - 1.6);
  const exit = new THREE.Vector3(0, 0, hd - 0.4);

  return { kind, name, group, colliders, spawn, exit, bounds };
}
