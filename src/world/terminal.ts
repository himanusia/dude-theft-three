import * as THREE from 'three';
import { canvasTexture, mergeStaticChildren, rotatedFootprint } from '../core/utils';
import type { PosCtx } from './pospolisi';

/**
 * Terminal bus — the angkot/bus terminal, after reference/assets/terminal-ref-0.jpg
 * (*Jalur keberangkatan Terminal Senen, 2023* by Naufal P, Wikimedia Commons, CC BY-SA 4.0;
 * see CREDITS.md). What the photograph teaches, and what this models:
 *
 *  - a wide, bare concrete apron with expansion joints, tyre polish and patched slabs; the bays
 *    are held by the steel above them, not by paint on the ground
 *  - a long grey steel lattice gantry spanning every bay, on round columns, with the destination
 *    board hung from it — the terminal's only tall silhouette
 *  - a low raised boarding platform with a painted kerb face, not a metro-height deck
 *  - plastic water barriers standing between the bays, plus simple steel queue rails
 *  - a blue city bus and a white/blue angkot berthed nose-in, side by side
 *  - a small operator booth on the platform, a queue rail, benches under the canopy
 *
 * The terminal is a terminal, not a shed: bays are numbered on the apron, the canopy runs the
 * full length of the platform, and the gantry carries a bay plate over each stop.
 *
 * Every name here is a plesetan, like every other sign in this city. No real operator appears.
 *
 * Local frame: +Z is the apron and the street side, -Z is the platform and the canopy, so a
 * camera standing out on the apron reads the numerals upright.
 */

export const TERMINAL_DIMENSIONS = {
  width: 48,
  depth: 32,
  apron: 0.18,
  platform: 0.26,
  eave: 4.5,
  gantry: 9.0,
} as const;

/** painted bay numerals, 1-4, on one atlas so the four decals share a draw call */
function bayAtlas(): THREE.Texture {
  return canvasTexture(1024, 256, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < 4; i++) {
      const cx = (i + 0.5) * (w / 4);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#f4d64a';
      ctx.font = '800 150px Arial, sans-serif';
      ctx.fillText(String(i + 1), cx, h * 0.58);
      ctx.fillStyle = '#efe9d6';
      ctx.font = '800 34px Arial, sans-serif';
      ctx.fillText('BAY', cx, h * 0.12);
    }
  });
}

/** the gantry board: the terminal name over the departure line */
function signTex(name: string): THREE.Texture {
  return canvasTexture(1024, 256, (ctx, w, h) => {
    ctx.fillStyle = '#123a63';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#e8e3d2';
    ctx.lineWidth = 7;
    ctx.strokeRect(9, 9, w - 18, h - 18);
    ctx.fillStyle = '#f5f1e2';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 92px Arial, sans-serif';
    ctx.fillText(name, w / 2, h * 0.38);
    ctx.font = '600 38px Arial, sans-serif';
    ctx.fillStyle = '#cfe0f2';
    ctx.fillText('KEBERANGKATAN  ·  ANGKUTAN DALAM KOTA', w / 2, h * 0.76);
  });
}

/** the fascia band that runs along the canopy edge, so the name reads from the apron */
function fasciaTex(name: string): THREE.Texture {
  return canvasTexture(2048, 128, (ctx, w, h) => {
    ctx.fillStyle = '#17457c';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#e8e3d2';
    ctx.fillRect(0, 12, w, 4);
    ctx.fillRect(0, h - 16, w, 4);
    ctx.fillStyle = '#f5f1e2';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 62px Arial, sans-serif';
    ctx.fillText(name, w * 0.36, h / 2);
    ctx.font = '700 40px Arial, sans-serif';
    ctx.fillStyle = '#cfe0f2';
    ctx.fillText('TIKET DI LOKET', w * 0.79, h / 2);
  });
}

/** yellow/black hazard paint for the platform kerb — the stripe buses take at door height */
function hazardTex(): THREE.Texture {
  const tex = canvasTexture(256, 64, (ctx, w, h) => {
    ctx.fillStyle = '#efc21f';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#20211f';
    for (let x = -h; x < w + h; x += 64) {
      ctx.beginPath();
      ctx.moveTo(x, h);
      ctx.lineTo(x + 32, h);
      ctx.lineTo(x + 32 + h, 0);
      ctx.lineTo(x + h, 0);
      ctx.closePath();
      ctx.fill();
    }
  });
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.set(26, 1);
  return tex;
}

/** the four bay plates on one atlas, so four hanging signs cost one draw call */
function plateAtlas(): THREE.Texture {
  return canvasTexture(1024, 256, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < 4; i++) {
      const x0 = i * (w / 4);
      ctx.fillStyle = '#f1eee2';
      ctx.fillRect(x0 + 6, 6, w / 4 - 12, h - 12);
      ctx.strokeStyle = '#17457c';
      ctx.lineWidth = 8;
      ctx.strokeRect(x0 + 6, 6, w / 4 - 12, h - 12);
      ctx.fillStyle = '#17457c';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '800 58px Arial, sans-serif';
      ctx.fillText('BAY', x0 + w / 8, h * 0.33);
      ctx.font = '800 82px Arial, sans-serif';
      ctx.fillText(String(i + 1), x0 + w / 8, h * 0.7);
    }
  });
}

/** the bus flank: white sweep plus the (plesetan) operator and the route it runs */
function busSideTex(): THREE.Texture {
  return canvasTexture(1024, 256, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(244,247,249,0.94)';
    ctx.beginPath();
    ctx.moveTo(0, h * 0.52);
    ctx.bezierCurveTo(w * 0.26, h * 0.12, w * 0.5, h * 0.88, w, h * 0.36);
    ctx.lineTo(w, h * 0.62);
    ctx.bezierCurveTo(w * 0.5, h * 1.1, w * 0.26, h * 0.36, 0, h * 0.76);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#123a63';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '800 70px Arial, sans-serif';
    ctx.fillText('MIRKOTRET', 64, h * 0.34);
    ctx.font = '700 38px Arial, sans-serif';
    ctx.fillStyle = '#1d4a78';
    ctx.fillText('BLOK N — KALIMATI', 68, h * 0.63);
  });
}

/** the departure board under the canopy: amber rows on black, the brightest thing at eye level */
function boardRowsTex(): THREE.Texture {
  return canvasTexture(512, 256, (ctx, w, h) => {
    ctx.fillStyle = '#101820';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#0b1116';
    ctx.fillRect(0, 0, w, 40);
    ctx.fillStyle = '#e8e3d2';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '700 22px Arial, sans-serif';
    ctx.fillText('KEBERANGKATAN', 16, 21);
    ctx.font = '600 17px Arial, sans-serif';
    ctx.fillText('JAM', w - 74, 21);
    const rows = [
      ['BLOK N · KALIMATI', '06.30'],
      ['BLOK N · TEBETAN', '06.45'],
      ['BLOK N · PONDOK ARTA', '07.00'],
      ['BLOK N · KALIMATI', '07.15'],
    ];
    rows.forEach(([route, time], i) => {
      const y = 62 + i * 46;
      ctx.fillStyle = i % 2 ? '#0d141a' : '#111b23';
      ctx.fillRect(8, y - 19, w - 16, 38);
      ctx.fillStyle = '#f0b429';
      ctx.font = '700 20px Arial, sans-serif';
      ctx.fillText(route, 18, y);
      ctx.fillStyle = '#e8e3d2';
      ctx.fillText(time, w - 74, y);
    });
  });
}

/** small plate for the angkot roof sign and the booth */
function smallPlateTex(label: string, bg = '#17457c', fg = '#f5f1e2'): THREE.Texture {
  return canvasTexture(256, 96, (ctx, w, h) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = fg;
    ctx.lineWidth = 6;
    ctx.strokeRect(5, 5, w - 10, h - 10);
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 44px Arial, sans-serif';
    ctx.fillText(label, w / 2, h / 2);
  });
}

export function buildTerminal(ctx: PosCtx, x: number, z: number, yaw: number, name = 'TERMINAL BLOK N'): THREE.Group {
  const g = new THREE.Group();
  g.name = 'terminal';
  g.position.set(x, 0, z);
  g.rotation.y = yaw;

  const W = TERMINAL_DIMENSIONS.width;      // 48 across the bays
  const D = TERMINAL_DIMENSIONS.depth;      // 32 from the street edge to the canopy
  const Y0 = TERMINAL_DIMENSIONS.apron;     // top of the apron slab
  const PLAT = TERMINAL_DIMENSIONS.platform;
  const EAVE = TERMINAL_DIMENSIONS.eave;
  const GANTRY = TERMINAL_DIMENSIONS.gantry;
  const DECK = Y0 + PLAT;                   // walking height of the boarding platform
  // the canopy columns, and the half-widths of the two vehicles berthed in bays 1 and 4, shared
  // with the collider list at the end so a body is stopped by the thing it can see
  const COL_X = [-17, -11.33, -5.67, 0, 5.67, 11.33, 17];
  const BERTH_BUS_HALF = 1.25;
  const BERTH_ANGKOT_HALF = 0.89;

  const concrete = new THREE.MeshStandardMaterial({ color: 0x9d9a91, roughness: 1 });
  const concreteWorn = new THREE.MeshStandardMaterial({ color: 0x8c8880, roughness: 1 });
  const platformMat = new THREE.MeshStandardMaterial({ color: 0xb2ad9f, roughness: 1 });
  const mark = new THREE.MeshStandardMaterial({ color: 0xe7e1cd, roughness: 1, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  const stain = new THREE.MeshBasicMaterial({ color: 0x2b2a27, transparent: true, opacity: 0.13, depthWrite: false });
  const steel = new THREE.MeshStandardMaterial({ color: 0x939aa1, roughness: 0.5, metalness: 0.55 });
  const rail = new THREE.MeshStandardMaterial({ color: 0xc2c7cc, roughness: 0.32, metalness: 0.7 });
  // a roof seen from underneath only gets bounce light; without a little emissive it renders as a
  // black slab over the platform (the same trap the pasar roof hit).
  const zinc = new THREE.MeshStandardMaterial({ color: 0xb4b8b9, roughness: 0.9, metalness: 0.04, emissive: 0x24282b, emissiveIntensity: 0.42 });
  const blue = new THREE.MeshStandardMaterial({ color: 0x17457c, roughness: 0.85 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf1eee2, roughness: 0.92 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x33363a, roughness: 0.9 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x2b3a44, roughness: 0.28, metalness: 0.25 });
  const yellow = new THREE.MeshStandardMaterial({ color: 0xefc21f, roughness: 0.85 });
  const orange = new THREE.MeshStandardMaterial({ color: 0xdd6a2a, roughness: 0.85 });
  const lamp = new THREE.MeshStandardMaterial({ color: 0xf4efdc, emissive: 0xf2e6c2, emissiveIntensity: 0.7, roughness: 0.8 });
  const amber = new THREE.MeshStandardMaterial({ color: 0xd8a02a, emissive: 0xd88f18, emissiveIntensity: 0.85, roughness: 0.7 });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x1a1c1e, roughness: 0.95 });
  const busBlue = new THREE.MeshStandardMaterial({ color: 0x1f5c9e, roughness: 0.62, metalness: 0.12 });
  const busWhite = new THREE.MeshStandardMaterial({ color: 0xeef1f4, roughness: 0.7 });
  const signMat = new THREE.MeshStandardMaterial({ map: signTex(name), roughness: 0.72 });
  const fasciaMat = new THREE.MeshStandardMaterial({ map: fasciaTex(name), roughness: 0.8 });
  const hazardMat = new THREE.MeshStandardMaterial({ map: hazardTex(), roughness: 0.95 });
  const bayMat = new THREE.MeshStandardMaterial({
    map: bayAtlas(), transparent: true, roughness: 1, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const busSideMat = new THREE.MeshStandardMaterial({ map: busSideTex(), transparent: true, roughness: 0.7 });
  const plateMat = new THREE.MeshStandardMaterial({ map: plateAtlas(), transparent: true, roughness: 0.8 });
  const rowsMat = new THREE.MeshStandardMaterial({ map: boardRowsTex(), emissive: 0x2a1f06, emissiveIntensity: 0.5, roughness: 0.7 });

  const box = (m: THREE.Material, bw: number, bh: number, bd: number, px: number, py: number, pz: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), m);
    mesh.position.set(px, py, pz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
    return mesh;
  };
  /** a ground decal: a horizontal plane just above the apron, so it cannot z-fight with it */
  const flat = (m: THREE.Material, fw: number, fd: number, px: number, pz: number, py: number) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(fw, fd), m);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(px, py, pz);
    mesh.receiveShadow = true;
    g.add(mesh);
    return mesh;
  };
  const post = (r: number, h: number, px: number, py: number, pz: number, m: THREE.Material, seg = 10) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), m);
    mesh.position.set(px, py, pz);
    mesh.castShadow = true;
    g.add(mesh);
    return mesh;
  };

  // ---------------------------------------------------------------- apron
  box(concrete, W, Y0, D, 0, Y0 / 2, 0);
  // expansion joints and the two worn wheel tracks that every terminal apron has
  for (const jz of [-2.4, 5.2, 12.8]) box(concreteWorn, W, 0.012, 0.12, 0, Y0 + 0.004, jz);
  for (const jx of [-8, 8]) box(concreteWorn, 0.12, 0.012, D, jx, Y0 + 0.004, 0);
  for (const tx of [-15, -5, 5, 15]) {
    for (const ox of [-1.05, 1.05]) {
      for (const ox2 of [-0.32, 0.32]) flat(stain, 0.62, 19, tx + ox + ox2, 4.6, Y0 + 0.006);
    }
  }

  // ---------------------------------------------------------------- painted bays
  // four 10 m bays; the numerals sit at the mouth of the bay where a driver reads them coming in
  for (const bx of [-20, -10, 0, 10, 20]) flat(mark, 0.16, 21, bx, 4.5, Y0 + 0.016);
  flat(mark, 40, 0.3, 0, 14.6, Y0 + 0.016);              // front edge line
  for (let i = 0; i < 4; i++) {
    const cx = -15 + i * 10;
    const geo = new THREE.PlaneGeometry(4.6, 2.6);
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let k = 0; k < uv.count; k++) uv.setX(k, (uv.getX(k) + i) / 4);
    const decal = new THREE.Mesh(geo, bayMat);
    decal.rotation.x = -Math.PI / 2;
    decal.position.set(cx, Y0 + 0.02, 11.2);
    g.add(decal);
  }
  // the bay mouth stop line, so the nose-in position is readable
  flat(mark, 40, 0.26, 0, -5.2, Y0 + 0.016);

  // white/orange plastic water barriers along the street edge, as in the photograph
  for (let i = 0; i < 4; i++) {
    const bx = -17 + i * 9.4;
    box(orange, 2.0, 0.62, 0.42, bx, Y0 + 0.4, 15.1);
    box(white, 2.02, 0.16, 0.44, bx, Y0 + 0.72, 15.1);
    box(dark, 0.5, 0.16, 0.62, bx - 0.8, Y0 + 0.08, 15.1);
    box(dark, 0.5, 0.16, 0.62, bx + 0.8, Y0 + 0.08, 15.1);
  }

  // ---------------------------------------------------------------- boarding platform
  box(platformMat, 42, PLAT, 5.0, 0, Y0 + PLAT / 2, -11.9);
  // hazard-striped kerb face on the apron side
  box(hazardMat, 42, 0.17, 0.08, 0, Y0 + 0.09, -9.36);
  flat(yellow, 42, 0.34, 0, -9.72, DECK + 0.008);        // painted edge line on top of the kerb
  flat(concreteWorn, 41, 0.1, 0, -12.6, DECK + 0.006);   // panel joint down the deck

  // ---------------------------------------------------------------- canopy: long roof on steel columns
  for (const cx of COL_X) {
    for (const cz of [-14.1, -9.5]) post(0.15, EAVE - PLAT, cx, DECK + (EAVE - PLAT) / 2, cz, steel, 8);
    // cross-bracket at the top of each column pair
    box(steel, 0.14, 0.14, 4.9, cx, EAVE - 0.12, -11.8);
  }
  // purlins the roof sheets sit on
  for (const pz of [-14.3, -11.8, -9.3]) box(steel, 38.4, 0.12, 0.12, 0, EAVE - 0.02, pz);
  // the roof itself: one long sheet with a slight fall to the street side, overhanging the
  // platform edge so the shadow lands on the deck rather than on the buses
  const roof = new THREE.Mesh(new THREE.BoxGeometry(38.8, 0.22, 7.8), zinc);
  roof.position.set(0, EAVE + 0.16, -11.3);
  roof.rotation.x = 0.04;
  roof.castShadow = true;
  roof.receiveShadow = true;
  g.add(roof);
  // gutter along the front edge, which is what reads as the thickness of a canopy
  box(zinc, 38.9, 0.26, 0.32, 0, EAVE + 0.1, -7.42);
  // fascia band carrying the terminal name, facing the apron
  box(blue, 38.8, 0.66, 0.1, 0, EAVE - 0.18, -7.36);
  const fascia = new THREE.Mesh(new THREE.PlaneGeometry(38.4, 0.6), fasciaMat);
  fascia.position.set(0, EAVE - 0.18, -7.3);
  g.add(fascia);
  // the frame the roof sheets sit on: three shallow beams, a light trough, and the downpipes
  for (const pz of [-14.1, -11.8, -9.6]) box(steel, 38.2, 0.2, 0.16, 0, EAVE - 0.08, pz);
  for (const lx of [-13, -4.5, 4.5, 13]) box(lamp, 1.3, 0.1, 0.4, lx, EAVE - 0.44, -11.4);
  for (const sx of [-17, 17]) box(dark, 0.34, 0.3, 0.34, sx, EAVE - 0.52, -9.6);
  for (const px of [-17, -5.67, 5.67, 17]) {
    post(0.07, EAVE - DECK - 0.1, px, DECK + (EAVE - DECK) / 2, -9.42, steel, 6);   // rainwater pipe
  }

  // the departure board, hung where a queue looks while it waits
  {
    const bx = -7.5, by = DECK + 2.5;
    for (const px of [bx - 1.45, bx + 1.45]) box(steel, 0.05, 1.5, 0.05, px, by + 1.35, -9.6);
    box(dark, 3.4, 1.5, 0.12, bx, by, -9.65);
    const rows = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.32), rowsMat);
    rows.position.set(bx, by, -9.58);
    g.add(rows);
  }

  // benches against the back of the platform
  for (const bx of [-14, -8.5, 8.5, 14]) {
    box(dark, 2.8, 0.1, 0.5, bx, DECK + 0.44, -13.6);
    for (const lx of [-1.1, 1.1]) box(steel, 0.08, 0.44, 0.08, bx + lx, DECK + 0.22, -13.6);
    box(steel, 2.8, 0.42, 0.08, bx, DECK + 0.66, -13.85);   // back rest
  }

  // ---------------------------------------------------------------- queue railings
  // A queue in a Jakarta terminal stands along the platform edge, behind a rail, and the rail
  // opens for one bus-width at each stop so people can reach the door. Two tubes, posts every
  // 1.9 m, all in the same steel so the whole run merges into one draw call.
  const railRun = (x0: number, x1: number, rz: number) => {
    const len = Math.abs(x1 - x0);
    const mid = (x0 + x1) / 2;
    const bays = Math.max(1, Math.round(len / 1.9));
    for (let k = 0; k <= bays; k++) post(0.045, 1.0, x0 + ((x1 - x0) * k) / bays, DECK + 0.5, rz, rail, 6);
    for (const ry of [0.95, 0.55]) {
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, len, 6), rail);
      bar.rotation.z = Math.PI / 2;
      bar.position.set(mid, DECK + ry, rz);
      g.add(bar);
    }
  };
  // the platform edge, with a 3.4 m opening at the centre of each bay
  for (const [a, b] of [[-20.4, -16.7], [-13.3, -6.7], [-3.3, 3.3], [6.7, 13.3], [16.7, 20.4]]) railRun(a, b, -9.95);
  // the queue lane behind it: two runs and the return that closes the turn at the kerb
  for (const seg of [{ z: -11.6, x0: -20.2, x1: -14.0 }, { z: -13.0, x0: -14.0, x1: -20.2 }]) railRun(seg.x0, seg.x1, seg.z);
  for (const rx of [-14.0, -20.2]) {
    const ret = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.5, 6), rail);
    ret.rotation.x = Math.PI / 2;
    ret.position.set(rx, DECK + 0.95, -12.3);
    g.add(ret);
  }
  // bins at the ends of the platform, the one item every shelter has
  for (const bx of [-20.6, 20.6]) {
    box(dark, 0.5, 0.75, 0.5, bx, DECK + 0.38, -10.8);
    box(steel, 0.56, 0.06, 0.56, bx, DECK + 0.77, -10.8);
  }

  // ---------------------------------------------------------------- operator booth
  {
    const bx = 18.2, bz = -12.0;
    box(white, 4.2, 2.5, 2.8, bx, DECK + 1.25, bz);
    box(blue, 4.24, 0.34, 2.84, bx, DECK + 2.3, bz);          // top band
    box(blue, 4.24, 0.18, 2.84, bx, DECK + 0.12, bz);         // skirt
    box(glass, 2.6, 1.0, 0.08, bx, DECK + 1.65, bz + 1.42);   // ticket window
    box(white, 2.8, 0.12, 0.42, bx, DECK + 1.06, bz + 1.52);  // counter shelf
    box(blue, 4.5, 0.16, 3.1, bx, DECK + 2.56, bz);           // flat roof
    box(dark, 0.9, 1.9, 0.07, bx + 1.5, DECK + 0.95, bz + 1.42); // staff door
    const boothSign = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.5), new THREE.MeshStandardMaterial({ map: smallPlateTex('LOKET 1'), roughness: 0.85 }));
    boothSign.position.set(bx, DECK + 2.05, bz + 1.44);
    g.add(boothSign);
    // a raised board over the booth: from across the apron this is what says "tickets"
    for (const px of [bx - 1.2, bx + 1.2]) box(steel, 0.08, 1.0, 0.08, px, DECK + 3.05, bz);
    box(blue, 3.6, 0.92, 0.14, bx, DECK + 3.55, bz);
    const ticketBoard = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.78), new THREE.MeshStandardMaterial({ map: smallPlateTex('LOKET · TIKET 1'), roughness: 0.85 }));
    ticketBoard.position.set(bx, DECK + 3.55, bz + 0.09);
    g.add(ticketBoard);
  }

  // ---------------------------------------------------------------- gantry + overhead signage
  const GZ = -6.2;                                          // the gantry stands over the bay mouth
  const topChord = Y0 + GANTRY - 0.2;
  const botChord = Y0 + GANTRY - 2.6;
  for (const gx of [-22.8, 22.8]) {
    post(0.26, GANTRY, gx, Y0 + GANTRY / 2, GZ, steel, 10);
    box(steel, 0.8, 0.2, 0.8, gx, Y0 + 0.1, GZ);
  }
  box(steel, 46, 0.22, 0.22, 0, topChord, GZ);              // top chord
  box(steel, 46, 0.22, 0.22, 0, botChord, GZ);              // bottom chord
  for (let i = 0; i < 18; i++) {
    const px = -21.5 + i * 2.53;
    const brace = box(steel, 0.1, 0.1, 2.6, px, (topChord + botChord) / 2, GZ);
    brace.rotation.x = i % 2 ? 0.58 : -0.58;
  }
  // the board sits between the chords, well above the canopy, facing the apron
  const boardY = (topChord + botChord) / 2;
  box(dark, 15.4, 2.3, 0.16, 0, boardY, GZ + 0.08);
  const board = new THREE.Mesh(new THREE.PlaneGeometry(15, 2.06), signMat);
  board.position.set(0, boardY, GZ + 0.17);
  g.add(board);
  // a bay plate over each stop, hung under the bottom chord on a short rod
  for (let i = 0; i < 4; i++) {
    const px = -15 + i * 10;
    box(dark, 0.06, 0.5, 0.06, px, botChord - 0.25, GZ);
    const geo = new THREE.PlaneGeometry(1.9, 1.05);
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let k = 0; k < uv.count; k++) uv.setX(k, (uv.getX(k) + i) / 4);
    const plate = new THREE.Mesh(geo, plateMat);
    plate.position.set(px, botChord - 1.03, GZ + 0.06);
    g.add(plate);
  }

  // ---------------------------------------------------------------- the bus in bay 1
  {
    const bx = -15, bz = 0.6;            // body centre; nose at z = -4.6
    const L = 10.4, BODY = 2.5;
    box(busBlue, BODY, 2.0, L, bx, Y0 + 1.55, bz);
    box(busWhite, BODY + 0.02, 0.36, L, bx, Y0 + 2.72, bz);      // roof band
    box(busBlue, BODY + 0.02, 0.22, L - 0.1, bx, Y0 + 0.62, bz); // skirt lip
    box(glass, BODY + 0.06, 0.92, L - 1.4, bx, Y0 + 2.06, bz);   // window band
    box(glass, BODY - 0.3, 1.5, 0.1, bx, Y0 + 1.85, bz - L / 2 + 0.02); // windscreen
    box(busWhite, BODY - 0.2, 0.12, 0.12, bx, Y0 + 2.0, bz - L / 2 - 0.02);
    box(dark, BODY - 0.5, 0.5, 0.08, bx, Y0 + 0.9, bz - L / 2 - 0.01);  // bumper
    box(busWhite, 1.5, 0.3, 0.08, bx, Y0 + 1.4, bz - L / 2 - 0.03);     // front valance
    box(amber, 1.15, 0.26, 0.1, bx, Y0 + 3.0, bz - L / 2 + 0.04);       // destination blind
    for (const mx of [-1.05, 1.05]) {                                   // mirrors on their arms
      box(dark, 0.06, 0.06, 0.5, bx + mx, Y0 + 2.42, bz - L / 2 - 0.2);
      box(dark, 0.16, 0.42, 0.06, bx + mx * 1.12, Y0 + 2.3, bz - L / 2 - 0.44);
    }
    for (const wx of [-1.05, 1.05]) box(busWhite, 0.34, 0.2, 0.1, wx + bx, Y0 + 0.85, bz - L / 2 - 0.04);
    // flanks
    for (const side of [-1, 1]) {
      const flank = new THREE.Mesh(new THREE.PlaneGeometry(8.6, 1.3), busSideMat);
      flank.position.set(bx + side * (BODY / 2 + 0.03), Y0 + 1.2, bz + 0.1);
      flank.rotation.y = side * (Math.PI / 2);
      g.add(flank);
    }
    // window bays, so the glass band is not one long stripe
    for (const side of [-1, 1]) {
      for (let k = 0; k < 5; k++) {
        box(busWhite, 0.06, 0.94, 0.1, bx + side * (BODY / 2 + 0.04), Y0 + 2.06, bz - 3.3 + k * 1.65);
      }
    }
    // the door a passenger actually boards through
    box(glass, 0.08, 1.9, 1.1, bx + BODY / 2 - 0.02, Y0 + 1.5, bz - L / 2 + 1.6);
    box(busWhite, 0.1, 2.0, 0.08, bx + BODY / 2 + 0.02, Y0 + 1.5, bz - L / 2 + 1.05);
    box(busWhite, 0.1, 2.0, 0.08, bx + BODY / 2 + 0.02, Y0 + 1.5, bz - L / 2 + 2.15);
    box(dark, 0.9, 0.34, 0.1, bx, Y0 + 1.05, bz + L / 2 + 0.03);         // rear plate
    box(white, 0.02, 0.2, 0.34, bx, Y0 + 0.9, bz + L / 2 + 0.02);
    // wheels
    for (const wz of [bz - 3.2, bz + 3.0]) {
      for (const wx of [-1.16, 1.16]) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.3, 12), tyre);
        w.rotation.z = Math.PI / 2;
        w.position.set(bx + wx, Y0 + 0.52, wz);
        w.castShadow = true;
        g.add(w);
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.32, 10), steel);
        hub.rotation.z = Math.PI / 2;
        hub.position.set(bx + wx, Y0 + 0.52, wz);
        g.add(hub);
      }
    }
  }

  // ---------------------------------------------------------------- the angkot in bay 4
  // a one-box minibus with a short bonnet: that silhouette is what separates an angkot from the
  // generic van the city traffic uses
  {
    const ax = 15, az = -2.2;            // nose at z = -4.4, tail at z = 0
    const L = 4.2, BODY = 1.78;
    box(busBlue, BODY, 0.72, L, ax, Y0 + 0.72, az);               // painted lower body
    box(white, BODY, 0.98, L - 0.4, ax, Y0 + 1.58, az + 0.2);     // upper body
    box(glass, BODY + 0.03, 0.6, L - 1.3, ax, Y0 + 1.66, az + 0.35); // window band
    for (let k = 0; k < 3; k++) {
      box(white, BODY + 0.05, 0.62, 0.1, ax, Y0 + 1.66, az - 1.1 + k * 1.2);   // window pillars
    }
    box(white, BODY, 0.16, L - 0.3, ax, Y0 + 2.13, az + 0.2);     // roof
    box(white, BODY - 0.18, 0.42, 0.5, ax, Y0 + 0.92, az - L / 2 + 0.25);      // short bonnet
    box(busBlue, BODY - 0.1, 0.26, 0.16, ax, Y0 + 0.6, az - L / 2 - 0.02);     // front bumper
    // raked windscreen over the bonnet
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(BODY - 0.34, 0.78), glass);
    screen.position.set(ax, Y0 + 1.55, az - L / 2 + 0.05);
    screen.rotation.x = -0.32;
    g.add(screen);
    // sliding door line on the kerb side, and the roof route board every angkot carries
    box(glass, 0.05, 1.35, 0.9, ax + BODY / 2 + 0.02, Y0 + 1.2, az + 1.1);
    box(white, 0.06, 1.4, 0.08, ax + BODY / 2 + 0.03, Y0 + 1.2, az + 0.62);
    const angkotSign = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.36), new THREE.MeshStandardMaterial({ map: smallPlateTex('BLOK N'), roughness: 0.8 }));
    angkotSign.position.set(ax, Y0 + 2.28, az - L / 2 + 0.55);
    g.add(angkotSign);
    for (const wz of [az - 1.3, az + 1.3]) {
      for (const wx of [-0.84, 0.84]) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.24, 10), tyre);
        w.rotation.z = Math.PI / 2;
        w.position.set(ax + wx, Y0 + 0.33, wz);
        w.castShadow = true;
        g.add(w);
      }
    }
  }

  // ---------------------------------------------------------------- entrance sign on a pole
  {
    const px = -22.4, pz = 12.6;
    post(0.13, 3.4, px, Y0 + 1.7, pz, steel, 8);
    box(white, 0.12, 1.0, 2.8, px, Y0 + 3.1, pz);
    const board2 = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.86), signMat);
    board2.position.set(px + 0.07, Y0 + 3.1, pz);
    board2.rotation.y = Math.PI / 2;
    g.add(board2);
  }

  mergeStaticChildren(g);
  ctx.group.add(g);
  ctx.audit.push({ name: 'terminal', x, z, bottom: 0 });
  // The terminal is a lot you walk into, not a building: the apron is open parking and the only
  // things a body cannot pass are the boarding platform, the booth, the canopy columns, the gantry
  // legs, the water barriers and the two buses berthed in their bays. One collider for the whole
  // 48 x 32 m lot reserved the apron as well, so the player was stopped 24 m out on the street and
  // the terminal could not be walked up to at all. Everything here is registered at its own
  // footprint, as a tile grid, because the whole assembly stands at the road's yaw.
  const solids: { cx: number; cz: number; hx: number; hz: number; h: number }[] = [
    { cx: 0, cz: -11.9, hx: 21, hz: 2.5, h: DECK + 0.06 },                    // boarding platform + kerb
    { cx: 18.2, cz: -12.0, hx: 2.1, hz: 1.4, h: DECK + 2.62 },                 // operator booth
    { cx: -15, cz: 0.6, hx: BERTH_BUS_HALF, hz: 5.2, h: 3.2 },                   // the berthed bus in bay 1
    { cx: 15, cz: -2.2, hx: BERTH_ANGKOT_HALF, hz: 2.1, h: 2.4 },                // the angkot in bay 4
    { cx: -22.4, cz: 12.6, hx: 0.13, hz: 0.13, h: 3.4 },                       // entrance sign pole
  ];
  for (let i = 0; i < 4; i++) solids.push({ cx: -17 + i * 9.4, cz: 15.1, hx: 1.0, hz: 0.21, h: 0.8 }); // water barriers
  for (const cx of COL_X) for (const cz of [-14.1, -9.5]) solids.push({ cx, cz, hx: 0.15, hz: 0.15, h: EAVE });
  for (const gx of [-22.8, 22.8]) solids.push({ cx: gx, cz: -6.2, hx: 0.4, hz: 0.4, h: GANTRY });
  for (const s of solids) {
    for (const b of rotatedFootprint(x, z, yaw, s.hx, s.hz, s.h, { cx: s.cx, cz: s.cz })) ctx.colliders.push(b);
  }
  return g;
}
