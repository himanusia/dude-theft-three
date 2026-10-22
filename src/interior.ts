import * as THREE from 'three';
import { AABB, canvasTexture, pick, rand, randInt, roundedBox } from './utils';

/**
 * Reusable interior kit.
 *
 * One room shell + a per-kind layout, so minimarket / warteg / bengkel / kopi all
 * share the same walls, floor, ceiling, lights and collision plumbing. Interiors are
 * built once per kind and teleported into — the cheap "GTA interior" trick.
 *
 * All names are parodies (plesetan), no real Indonesian brands.
 */

export type InteriorKind = 'minimarket' | 'warteg' | 'bengkel' | 'kopi';

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
};

export const INTERIOR_NAMES: Record<InteriorKind, string[]> = {
  minimarket: ['ALFAMURTI', 'INDOMERET', 'MARTABAK MART'],
  warteg: ['WARTEG BAHARI', 'WARTEG SIAP JIWO', 'WARUNG PRASMANAN'],
  bengkel: ['BENGKEL AHOS', 'MOTOR SEHAT', 'TAMBAL BAN PAK JITU'],
  kopi: ['KOPI TUBRUK', 'WARKOP MELAYU', 'KOPI LITERAN'],
};

function floorTexture(kind: InteriorKind): THREE.CanvasTexture {
  const tile = kind === 'bengkel' ? '#6d6a63' : kind === 'warteg' ? '#b9a98c' : '#d9d5cc';
  const line = kind === 'bengkel' ? 'rgba(40,40,40,0.35)' : 'rgba(120,116,110,0.35)';
  const tx = canvasTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = tile;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = line;
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

function signTexture(text: string, bg: string, fg = '#ffffff'): THREE.CanvasTexture {
  return canvasTexture(512, 128, (ctx, w, h) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(0, h - 10, w, 10);
    ctx.fillStyle = fg;
    ctx.font = 'bold 62px ui-sans-serif, system-ui, sans-serif';
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
    ctx.font = 'bold 34px ui-sans-serif, system-ui, sans-serif';
    lines.forEach((line, i) => ctx.fillText(line, w / 2, 70 + i * 46));
  });
}

export function buildInterior(kind: InteriorKind): Interior {
  const spec = ROOMS[kind];
  const name = pick(INTERIOR_NAMES[kind]);
  const group = new THREE.Group();
  const colliders: AABB[] = [];
  const hw = spec.w / 2;
  const hd = spec.d / 2;

  const wallMat = new THREE.MeshStandardMaterial({ color: kind === 'bengkel' ? 0x8b8d90 : 0xefeae1, roughness: 0.92 });
  const trimMat = new THREE.MeshStandardMaterial({ color: kind === 'minimarket' ? 0x2f7d78 : 0x6b5b4a, roughness: 0.8 });

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

  // skirting
  const skirtMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3e, roughness: 0.85 });
  for (const [w, d, x, z] of [
    [spec.w, 0.08, 0, -hd + 0.12],
    [0.08, spec.d, -hw + 0.12, 0],
    [0.08, spec.d, hw - 0.12, 0],
  ] as [number, number, number, number][]) {
    const sk = new THREE.Mesh(new THREE.BoxGeometry(w, 0.16, d), skirtMat);
    sk.position.set(x, 0.08, z);
    group.add(sk);
  }

  // ---- ceiling light panels + one real light ----
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 1.6, roughness: 0.4 });
  for (let i = 0; i < 3; i++) {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 0.7), lampMat);
    panel.position.set(-spec.w / 4 + (i * spec.w) / 4, spec.h - 0.08, 0);
    group.add(panel);
  }
  const light = new THREE.PointLight(0xffeccb, 40, 16, 2);
  light.position.set(0, spec.h - 0.5, 0);
  group.add(light);

  // ---- signage above the door (inside) ----
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(4.6, 1.15),
    new THREE.MeshStandardMaterial({
      map: signTexture(name, kind === 'minimarket' ? '#c0392b' : kind === 'kopi' ? '#3f2a1d' : '#2f5d3a'),
      emissive: 0xffffff,
      emissiveMap: signTexture(name, kind === 'minimarket' ? '#c0392b' : kind === 'kopi' ? '#3f2a1d' : '#2f5d3a'),
      emissiveIntensity: 0.35,
      roughness: 0.6,
    })
  );
  sign.position.set(0, spec.h - 1.0, -hd + 0.13);
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

  // extra clutter so the room reads as a working shop
  const clutterColors = [0x8d6e63, 0xc0392b, 0x2f6fd0, 0xf1c40f];
  for (let i = 0; i < 6; i++) {
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
