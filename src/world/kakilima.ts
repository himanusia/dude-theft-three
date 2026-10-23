import * as THREE from 'three';
import { canvasTexture } from '../core/utils';

/**
 * Street food and the two institutions a Jakarta street cannot be without.
 *
 * Everything here is built to the same contract as the rest of the world builders: the meshes
 * are added to `ctx.group`, a collider goes into `ctx.colliders`, and an entry goes into
 * `ctx.audit` so the floating-prop check can see it. All of it is procedural, and the signs use
 * plesetan names (the game never puts a real brand on a cart).
 */
export interface CartCtx {
  group: THREE.Group;
  colliders: { minX: number; maxX: number; minZ: number; maxZ: number; h: number }[];
  audit: { name: string; x: number; z: number; bottom: number }[];
}

const STEEL = 0xc9ced4;
const STEEL_DARK = 0x8b939c;
const STEEL_LIGHT = 0xe4e8ec;
const PANEL = 0xb5bcc4;
const HARDBOARD = 0xe0d6c2;
const WOOD = 0x8a5f3a;
const RED = 0xc0392b;
const YELLOW = 0xf2c14e;
/** wheels sit at this height off the ground; the body and the legs are measured from it */
const WHEEL_R = 0.24;
const WHEEL_X = 0.46;
const LEG_X = -0.62;

/** a sign plate with text, drawn on a canvas so no font file is needed */
function signPlate(text: string, w: number, h: number, bg: string, fg = '#ffffff'): THREE.Mesh {
  const tex = canvasTexture(512, 128, (ctx, cw, ch) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cw, ch);
    ctx.strokeStyle = 'rgba(0,0,0,.25)';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, cw - 6, ch - 6);
    let size = 74;
    ctx.font = `800 ${size}px system-ui, sans-serif`;
    while (ctx.measureText(text).width > cw - 40 && size > 26) {
      size -= 4;
      ctx.font = `800 ${size}px system-ui, sans-serif`;
    }
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cw / 2, ch / 2 + 4);
  });
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, metalness: 0.05 })
  );
  return mesh;
}

export type KakiLimaKind = 'bakso' | 'nasgor' | 'sate';

const NAMES: Record<KakiLimaKind, string> = {
  bakso: 'BAKSO MAS KUMIS',
  nasgor: 'NASGOR GILA',
  sate: 'SATE CAK RUDI',
};

/**
 * A gerobak: the stainless cart a warung pushes along the pavement. The three kinds differ in
 * what sits on top — a stockpot, a wok and gas bottle, a charcoal grill — because that silhouette
 * is what tells them apart from ten metres away.
 */
export function buildKakiLima(ctx: CartCtx, kind: KakiLimaKind, x: number, z: number, yaw: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;

  const steel = new THREE.MeshStandardMaterial({ color: STEEL, metalness: 0.65, roughness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: STEEL_DARK, metalness: 0.4, roughness: 0.6 });
  const light = new THREE.MeshStandardMaterial({ color: STEEL_LIGHT, metalness: 0.55, roughness: 0.32 });
  const panel = new THREE.MeshStandardMaterial({ color: PANEL, metalness: 0.35, roughness: 0.55 });
  const wood = new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.9 });
  const tarp = new THREE.MeshStandardMaterial({ color: kind === 'bakso' ? RED : kind === 'nasgor' ? YELLOW : 0x2e7d32, roughness: 0.85 });

  const box = (mat: THREE.Material, w: number, h: number, d: number, px: number, py: number, pz: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(px, py, pz);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  /** a rod between two local points: handle bars, canopy ribs, axle stays */
  const rod = (mat: THREE.Material, a: [number, number, number], b: [number, number, number], r: number) => {
    const pa = new THREE.Vector3(...a);
    const pb = new THREE.Vector3(...b);
    const len = pa.distanceTo(pb);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8), mat);
    m.position.copy(pa).add(pb).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pb.clone().sub(pa).normalize());
    m.castShadow = true;
    g.add(m);
    return m;
  };

  // ---- body: a panelled stainless box, not one slab --------------------------------------
  // The tub is recessed 3 cm behind its own frame so the cart has a lit edge and a shadowed
  // panel from any angle; a single 1.5 m box read as a fridge on wheels.
  box(panel, 1.44, 0.66, 0.8, 0, 0.62, 0);            // inner tub
  for (const sx of [-1, 1]) box(steel, 0.05, 0.7, 0.86, sx * 0.735, 0.62, 0);   // end posts/sides
  for (const sz of [-1, 1]) box(steel, 1.5, 0.7, 0.04, 0, 0.62, sz * 0.43);    // long side skins
  box(dark, 1.54, 0.06, 0.9, 0, 1.0, 0);              // worktop
  box(light, 1.46, 0.03, 0.84, 0, 1.045, 0);          // worktop sheen
  box(dark, 1.5, 0.05, 0.88, 0, 0.31, 0);             // bottom rail
  // the four corner posts that make the frame read as a frame
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(dark, 0.055, 0.72, 0.055, sx * 0.735, 0.62, sz * 0.43);

  // ---- wheels: the axle runs ACROSS the cart --------------------------------------------
  // CylinderGeometry's axis is +Y. rotation.x = 90 deg turns it onto Z, which is the cart's
  // width axis, so the wheel stands upright and rolls along the cart's length. rotation.z put
  // the axis along X instead and every wheel faced the camera edge-on like a coin.
  for (const wz of [-0.42, 0.42]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.1, 14), dark);
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(WHEEL_X, WHEEL_R, wz);
    wheel.castShadow = true;
    g.add(wheel);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.108, 10), light);
    hub.rotation.x = Math.PI / 2;
    hub.position.set(WHEEL_X, WHEEL_R, wz);
    g.add(hub);
  }
  const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.92, 8), dark);
  axle.rotation.x = Math.PI / 2;
  axle.position.set(WHEEL_X, WHEEL_R, 0);
  g.add(axle);
  // axle stays back to the frame, so the wheels are attached to something
  for (const wz of [-1, 1]) rod(dark, [WHEEL_X, WHEEL_R, wz * 0.3], [WHEEL_X - 0.12, 0.34, wz * 0.3], 0.022);

  // ---- legs at the handle end: a gerobak stands on two wheels and two feet --------------
  for (const lz of [-0.3, 0.3]) {
    box(dark, 0.055, 0.3, 0.055, LEG_X, 0.15, lz);
    box(panel, 0.11, 0.035, 0.11, LEG_X, 0.017, lz);   // rubber foot, flat on the ground
  }

  // ---- push handle: two raked bars and a grip you could actually hold --------------------
  for (const hz of [-0.32, 0.32]) {
    rod(wood, [-0.7, 0.82, hz], [-1.12, 1.06, hz * 0.82], 0.028);   // starts inside the body skin
    rod(dark, [-0.7, 0.52, hz], [-0.98, 0.9, hz], 0.02);           // brace, so the bar is not floating
  }
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.62, 10), dark);
  grip.rotation.x = Math.PI / 2;
  grip.position.set(-1.12, 1.06, 0);
  grip.castShadow = true;
  g.add(grip);

  // what is cooking, per kind
  if (kind === 'bakso') {
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.28, 0.4, 14), steel);
    pot.position.set(0.22, 1.22, 0);
    pot.castShadow = true;
    g.add(pot);
    box(dark, 0.42, 0.05, 0.42, 0.22, 1.44, 0);      // pot lid
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.08, 0.1, 10), new THREE.MeshStandardMaterial({ color: 0xf5f2e8, roughness: 0.6 }));
    bowl.position.set(-0.4, 1.08, 0.22);
    g.add(bowl);
  } else if (kind === 'nasgor') {
    const wok = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), dark);
    wok.rotation.x = Math.PI;
    wok.position.set(0.2, 1.16, 0);
    wok.castShadow = true;
    g.add(wok);
    const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.5, 12), new THREE.MeshStandardMaterial({ color: 0xd94f2b, roughness: 0.5 }));
    bottle.position.set(-0.55, 0.3, 0.1);
    bottle.castShadow = true;
    g.add(bottle);
  } else {
    box(dark, 0.7, 0.16, 0.44, 0.2, 1.1, 0);          // grill tray
    const coals = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.05, 0.36), new THREE.MeshStandardMaterial({ color: 0x3a2b22, emissive: 0xff5a1f, emissiveIntensity: 0.55 }));
    coals.position.set(0.2, 1.19, 0);
    g.add(coals);
    for (let i = 0; i < 5; i++) {
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.44, 5), new THREE.MeshStandardMaterial({ color: 0xc9a06a }));
      stick.rotation.z = Math.PI / 2;
      stick.position.set(0.2, 1.24, -0.16 + i * 0.08);
      g.add(stick);
    }
  }

  // ---- umbrella: pole, four ribs under the canopy, and stays that tie it to the cart -----
  // The canopy used to be a cone on one pole with nothing under it, which reads as a hat
  // hovering over the cart. An umbrella has visible ribs from the pole hub out to the rim, and
  // the pole is strapped to the cart frame so it is not standing in the air.
  const poleX = -0.45;
  const poleZ = -0.5;
  // the cone's base sits at 2.03; ribs run just UNDER that edge so they are visible, not buried
  const rimY = 2.01;
  const hubY = 1.9;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 2.34, 8), dark);
  pole.position.set(poleX, 1.17, poleZ);
  pole.castShadow = true;
  g.add(pole);
  box(dark, 0.09, 0.16, 0.09, poleX, 1.02, poleZ);         // clamp where the pole meets the worktop
  const canopy = new THREE.Mesh(new THREE.ConeGeometry(1.15, 0.42, 8), tarp);
  canopy.position.set(poleX, 2.24, poleZ);
  canopy.castShadow = true;
  g.add(canopy);
  // rim: an octagonal band the ribs actually end on
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(1.13, 1.15, 0.05, 8, 1, true), tarp);
  rim.position.set(poleX, rimY, poleZ);
  g.add(rim);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    rod(dark, [poleX, hubY, poleZ], [poleX + Math.cos(a) * 1.1, rimY + 0.02, poleZ + Math.sin(a) * 1.1], 0.016);
  }
  // two stays down to the cart body: the canopy is carried by the cart, not by air
  rod(dark, [poleX, 1.5, poleZ], [poleX + 0.34, 1.02, poleZ + 0.34], 0.018);
  rod(dark, [poleX, 1.5, poleZ], [poleX + 0.34, 1.02, poleZ - 0.34], 0.018);

  // sign across the front of the cart
  const sign = signPlate(NAMES[kind], 1.25, 0.28, kind === 'bakso' ? '#a5281c' : kind === 'nasgor' ? '#b98513' : '#1f5d27');
  sign.position.set(0, 0.78, 0.46);
  g.add(sign);

  ctx.group.add(g);
  ctx.audit.push({ name: `kaki5-${kind}`, x, z, bottom: 0 });
  const halfX = Math.abs(Math.cos(yaw)) * 0.8 + Math.abs(Math.sin(yaw)) * 0.5;
  const halfZ = Math.abs(Math.sin(yaw)) * 0.8 + Math.abs(Math.cos(yaw)) * 0.5;
  ctx.colliders.push({ minX: x - halfX, maxX: x + halfX, minZ: z - halfZ, maxZ: z + halfZ, h: 2.3 });
  return g;
}

/**
 * SPPG — the nutrition kitchen behind the free-meal programme. A walled shed with a serving
 * window, stainless prep benches and the programme board over the door.
 */
export function buildSppg(ctx: CartCtx, x: number, z: number, yaw: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;

  const wall = new THREE.MeshStandardMaterial({ color: 0xeae6dc, roughness: 0.95 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x2f6fb5, roughness: 0.8 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ab, roughness: 0.9 });

  const box = (mat: THREE.Material, w: number, h: number, d: number, px: number, py: number, pz: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(px, py, pz);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };

  box(wall, 7.2, 3.4, 4.6, 0, 1.7, 0);
  box(roofMat, 7.8, 0.16, 5.2, 0, 3.5, 0);
  box(trim, 7.3, 0.22, 4.7, 0, 3.32, 0);            // fascia band
  // serving window with a counter
  box(new THREE.MeshStandardMaterial({ color: 0x1c2228, roughness: 0.4, metalness: 0.2 }), 2.6, 1.0, 0.08, 0, 1.9, 2.32);
  box(new THREE.MeshStandardMaterial({ color: 0xb9c2ca, metalness: 0.6, roughness: 0.4 }), 2.8, 0.08, 0.5, 0, 1.36, 2.42);
  // door
  box(new THREE.MeshStandardMaterial({ color: 0x30506b, roughness: 0.7 }), 1.0, 2.1, 0.08, 2.4, 1.05, 2.32);

  const sign = signPlate('SPPG DAPUR GIZI', 4.6, 0.6, '#1f5aa8');
  sign.position.set(0, 2.86, 2.36);
  g.add(sign);

  ctx.group.add(g);
  ctx.audit.push({ name: 'sppg', x, z, bottom: 0 });
  const halfX = Math.abs(Math.cos(yaw)) * 3.7 + Math.abs(Math.sin(yaw)) * 2.5;
  const halfZ = Math.abs(Math.sin(yaw)) * 3.7 + Math.abs(Math.cos(yaw)) * 2.5;
  ctx.colliders.push({ minX: x - halfX, maxX: x + halfX, minZ: z - halfZ, maxZ: z + halfZ, h: 3.6 });
  return g;
}

/**
 * Koperasi desa: the village cooperative shop. The name is a plesetan, like every other sign in
 * this city — MERAH PUTEH, not MERAH PUTIH.
 */
export function buildKoperasi(ctx: CartCtx, x: number, z: number, yaw: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;

  const wall = new THREE.MeshStandardMaterial({ color: 0xdfd8c6, roughness: 0.95 });
  const shutter = new THREE.MeshStandardMaterial({ color: 0x7d848c, metalness: 0.5, roughness: 0.5 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x8c4a3a, roughness: 0.9 });

  const box = (mat: THREE.Material, w: number, h: number, d: number, px: number, py: number, pz: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(px, py, pz);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };

  box(wall, 6.4, 3.1, 4.2, 0, 1.55, 0);
  box(roofMat, 7.0, 0.5, 4.8, 0, 3.35, 0);
  box(shutter, 3.0, 1.9, 0.1, -0.6, 1.0, 2.12);       // roller shutter, half open look
  box(new THREE.MeshStandardMaterial({ color: 0x2b3138, roughness: 0.6 }), 1.1, 2.0, 0.1, 1.9, 1.0, 2.12);
  // kerosene drums and sacks out front, the way a koperasi actually looks
  for (let i = 0; i < 3; i++) {
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.86, 12), new THREE.MeshStandardMaterial({ color: i % 2 ? 0x2f6fb5 : 0xb5432f, roughness: 0.7 }));
    drum.position.set(-2.0 + i * 0.62, 0.43, 2.5);
    drum.castShadow = true;
    g.add(drum);
  }

  const sign = signPlate('KOPERDES MERAH PUTEH', 5.0, 0.62, '#a5281c');
  sign.position.set(0, 2.62, 2.14);
  g.add(sign);

  ctx.group.add(g);
  ctx.audit.push({ name: 'koperasi', x, z, bottom: 0 });
  const halfX = Math.abs(Math.cos(yaw)) * 3.2 + Math.abs(Math.sin(yaw)) * 2.2;
  const halfZ = Math.abs(Math.sin(yaw)) * 3.2 + Math.abs(Math.cos(yaw)) * 2.2;
  ctx.colliders.push({ minX: x - halfX, maxX: x + halfX, minZ: z - halfZ, maxZ: z + halfZ, h: 3.4 });
  return g;
}
