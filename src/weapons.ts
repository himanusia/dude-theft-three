import * as THREE from 'three';
import { roundedBox } from './utils';

/**
 * San Andreas style weapon set.
 *
 * Everything here is data + procedural geometry: the table drives cadence,
 * damage, ammo and HUD, `buildWeaponModel` returns a low-poly group whose grip
 * sits at the origin, whose barrel points down local +z and whose sights face
 * local +y. main.ts mounts it in the right hand, so a model swap is just
 * toggling visibility and applying `heldPose`.
 */
export type WeaponId = 'fist' | 'knife' | 'pistol' | 'uzi' | 'shotgun' | 'ak';

export interface HeldPose {
  /** offset inside the right-arm group */
  position: [number, number, number];
  /** +PI/2 about x turns the model's +z barrel into the arm's forward axis */
  rotation: [number, number, number];
}

export interface WeaponSpec {
  id: WeaponId;
  /** display name used by the HUD and pickup toasts */
  name: string;
  /** 1..6, the key that equips it */
  slot: number;
  /** model id, one per procedural builder */
  model: string;
  melee: boolean;
  /** holding the trigger keeps firing (uzi/AK); pistol and shotgun need a new click */
  auto: boolean;
  /** damage per pellet for guns, per swing for melee. knife bleed is extra */
  damage: number;
  /** rounds (or swings) per minute */
  rpm: number;
  /** half-angle of the pellet cone in degrees */
  spread: number;
  pellets: number;
  /** metres */
  range: number;
  magSize: number;
  /** rounds handed out by a pickup together with a full magazine */
  reserve: number;
  /** seconds */
  reload: number;
  /** camera pitch kick in radians */
  recoil: number;
  /** screen shake amplitude in world units */
  shake: number;
  sound: string;
  soundRate: number;
  soundVol: number;
  /** single-character HUD icon */
  glyph: string;
  /** barrel tip (or blade tip) in model space */
  muzzle: [number, number, number];
  heldPose: HeldPose;
  /** muzzle flash sprite size */
  flashScale: number;
  /** knife-style damage over time, applied after the swing lands */
  bleed?: { ticks: number; damage: number; interval: number };
}

const GUN_POSE: HeldPose = { position: [0, -0.66, 0.03], rotation: [Math.PI / 2, 0, 0] };

export const WEAPONS: Record<WeaponId, WeaponSpec> = {
  fist: {
    id: 'fist',
    name: 'Fist',
    slot: 1,
    model: 'w_fist',
    melee: true,
    auto: false,
    damage: 10,
    rpm: 150,
    spread: 0,
    pellets: 1,
    range: 2.3,
    magSize: 0,
    reserve: 0,
    reload: 0,
    recoil: 0.01,
    shake: 0.02,
    sound: 'punch',
    soundRate: 1,
    soundVol: 0.4,
    glyph: 'F',
    muzzle: [0, -0.65, 0.1],
    heldPose: { position: [0, -0.65, 0.02], rotation: [Math.PI / 2, 0, 0] },
    flashScale: 0,
  },
  knife: {
    id: 'knife',
    name: 'Knife',
    slot: 2,
    model: 'w_knife',
    melee: true,
    auto: false,
    damage: 26,
    rpm: 210,
    spread: 0,
    pellets: 1,
    range: 2.6,
    magSize: 0,
    reserve: 0,
    reload: 0,
    recoil: 0.012,
    shake: 0.025,
    sound: 'punch',
    soundRate: 1.3,
    soundVol: 0.36,
    glyph: 'K',
    muzzle: [0, 0.01, 0.29],
    heldPose: { position: [0, -0.66, 0.03], rotation: [Math.PI / 2, 0, 0.35] },
    flashScale: 0,
    bleed: { ticks: 3, damage: 4, interval: 0.5 },
  },
  pistol: {
    id: 'pistol',
    name: '9mm',
    slot: 3,
    model: 'w_pistol',
    melee: false,
    auto: false,
    damage: 34,
    rpm: 300,
    spread: 1.2,
    pellets: 1,
    range: 55,
    magSize: 12,
    reserve: 96,
    reload: 1.35,
    recoil: 0.014,
    shake: 0.035,
    sound: 'shot_pistol',
    soundRate: 1,
    soundVol: 0.5,
    glyph: '9',
    muzzle: [0, 0.055, 0.215],
    heldPose: GUN_POSE,
    flashScale: 0.85,
  },
  uzi: {
    id: 'uzi',
    name: 'Micro Uzi',
    slot: 4,
    model: 'w_uzi',
    melee: false,
    auto: true,
    damage: 12,
    rpm: 900,
    spread: 5.5,
    pellets: 1,
    range: 34,
    magSize: 25,
    reserve: 150,
    reload: 1.5,
    recoil: 0.006,
    shake: 0.02,
    sound: 'shot_pistol',
    soundRate: 1.25,
    soundVol: 0.34,
    glyph: 'U',
    muzzle: [0, 0.05, 0.32],
    heldPose: GUN_POSE,
    flashScale: 0.7,
  },
  shotgun: {
    id: 'shotgun',
    name: 'Shotgun',
    slot: 5,
    model: 'w_shotgun',
    melee: false,
    auto: false,
    damage: 11,
    rpm: 75,
    spread: 8,
    pellets: 8,
    range: 22,
    magSize: 8,
    reserve: 32,
    reload: 2.1,
    recoil: 0.05,
    shake: 0.12,
    sound: 'shot_rifle',
    soundRate: 0.8,
    soundVol: 0.78,
    glyph: 'S',
    muzzle: [0, 0.07, 0.71],
    heldPose: GUN_POSE,
    flashScale: 1.25,
  },
  ak: {
    id: 'ak',
    name: 'AK-47',
    slot: 6,
    model: 'w_ak',
    melee: false,
    auto: true,
    damage: 55,
    rpm: 400,
    spread: 3.2,
    pellets: 1,
    range: 70,
    magSize: 30,
    reserve: 120,
    reload: 2,
    recoil: 0.03,
    shake: 0.07,
    sound: 'shot_rifle',
    soundRate: 1.05,
    soundVol: 0.6,
    glyph: 'A',
    muzzle: [0, 0.045, 0.61],
    heldPose: GUN_POSE,
    flashScale: 1,
  },
};

export const WEAPON_ORDER: WeaponId[] = ['fist', 'knife', 'pistol', 'uzi', 'shotgun', 'ak'];

export function weaponBySlot(slot: number): WeaponId | null {
  for (const id of WEAPON_ORDER) if (WEAPONS[id].slot === slot) return id;
  return null;
}

/** starting pouch: only the fist and the 9mm are owned at spawn */
export const STARTING_WEAPONS: WeaponId[] = ['fist', 'pistol'];

// ---------------------------------------------------------------- materials
const matCache = new Map<string, THREE.MeshStandardMaterial>();
function mat(color: number, metalness = 0.15, roughness = 0.72): THREE.MeshStandardMaterial {
  const key = `${color}|${metalness}|${roughness}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, metalness, roughness, flatShading: true });
    matCache.set(key, m);
  }
  return m;
}

const STEEL = () => mat(0x3c4048, 0.55, 0.45);
const DARK_STEEL = () => mat(0x2a2d33, 0.6, 0.4);
const POLYMER = () => mat(0x1e2025, 0.05, 0.85);
const WOOD = () => mat(0x8b5a2b, 0.02, 0.9);
const BLADE = () => mat(0xd7dde6, 0.85, 0.22);

function addPart(
  parent: THREE.Group,
  geo: THREE.BufferGeometry,
  material: THREE.Material,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0
): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, rz);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function addCylinder(
  parent: THREE.Group,
  radius: number,
  length: number,
  material: THREE.Material,
  x: number,
  y: number,
  z: number
): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(radius, radius, length, 8, 1);
  return addPart(parent, geo, material, x, y, z, Math.PI / 2, 0, 0);
}

// ---------------------------------------------------------------- models
function buildPistol(): THREE.Group {
  const g = new THREE.Group();
  addPart(g, roundedBox(0.085, 0.2, 0.11, 0.02), POLYMER(), 0, -0.1, -0.03, -0.2);
  addPart(g, roundedBox(0.075, 0.07, 0.2, 0.014), DARK_STEEL(), 0, -0.005, 0.04);
  addPart(g, roundedBox(0.086, 0.09, 0.28, 0.014), STEEL(), 0, 0.06, 0.055);
  addPart(g, roundedBox(0.05, 0.014, 0.085, 0.008), DARK_STEEL(), 0, -0.05, 0.02);
  addCylinder(g, 0.02, 0.055, DARK_STEEL(), 0, 0.052, 0.2);
  addPart(g, new THREE.BoxGeometry(0.018, 0.022, 0.018), DARK_STEEL(), 0, 0.116, -0.06);
  return g;
}

function buildUzi(): THREE.Group {
  const g = new THREE.Group();
  addPart(g, roundedBox(0.1, 0.12, 0.3, 0.018), DARK_STEEL(), 0, 0.02, 0.02);
  addPart(g, roundedBox(0.075, 0.15, 0.1, 0.018), POLYMER(), 0, -0.1, -0.11, -0.18);
  addPart(g, roundedBox(0.065, 0.22, 0.095, 0.015), STEEL(), 0, -0.13, -0.02, 0.1);
  addPart(g, roundedBox(0.045, 0.06, 0.13, 0.015), DARK_STEEL(), 0, 0.04, -0.19);
  addCylinder(g, 0.018, 0.14, DARK_STEEL(), 0, 0.05, 0.24);
  addPart(g, new THREE.BoxGeometry(0.016, 0.03, 0.016), STEEL(), 0, 0.09, 0.11);
  return g;
}

function buildShotgun(): THREE.Group {
  const g = new THREE.Group();
  addPart(g, roundedBox(0.09, 0.14, 0.28, 0.02), DARK_STEEL(), 0, 0.01, 0);
  addCylinder(g, 0.034, 0.6, STEEL(), 0, 0.07, 0.4);
  addCylinder(g, 0.026, 0.5, DARK_STEEL(), 0, 0.0, 0.36);
  addPart(g, roundedBox(0.095, 0.095, 0.2, 0.02), WOOD(), 0, 0.0, 0.33);
  addPart(g, roundedBox(0.085, 0.15, 0.28, 0.02), WOOD(), 0, -0.07, -0.27, -0.16);
  addPart(g, roundedBox(0.07, 0.13, 0.09, 0.018), WOOD(), 0, -0.1, -0.09, -0.2);
  addPart(g, new THREE.BoxGeometry(0.016, 0.026, 0.016), STEEL(), 0, 0.112, 0.66);
  return g;
}

function buildAk(): THREE.Group {
  const g = new THREE.Group();
  addPart(g, roundedBox(0.085, 0.13, 0.32, 0.018), DARK_STEEL(), 0, 0.01, 0);
  addPart(g, roundedBox(0.08, 0.04, 0.3, 0.012), STEEL(), 0, 0.085, 0);
  addPart(g, roundedBox(0.085, 0.1, 0.2, 0.018), WOOD(), 0, 0.03, 0.25);
  addCylinder(g, 0.014, 0.34, DARK_STEEL(), 0, 0.085, 0.36);
  addCylinder(g, 0.02, 0.3, DARK_STEEL(), 0, 0.045, 0.45);
  addPart(g, new THREE.BoxGeometry(0.02, 0.055, 0.02), STEEL(), 0, 0.1, 0.6);
  // curved magazine: three slabs fanning forward like the real banana mag
  addPart(g, roundedBox(0.07, 0.11, 0.1, 0.014), STEEL(), 0, -0.11, -0.03, 0.18);
  addPart(g, roundedBox(0.07, 0.11, 0.1, 0.014), STEEL(), 0, -0.2, -0.005, 0.36);
  addPart(g, roundedBox(0.07, 0.11, 0.1, 0.014), STEEL(), 0, -0.28, 0.03, 0.55);
  addPart(g, roundedBox(0.075, 0.13, 0.26, 0.018), WOOD(), 0, -0.04, -0.29, -0.1);
  addPart(g, roundedBox(0.065, 0.15, 0.09, 0.018), POLYMER(), 0, -0.1, -0.12, -0.25);
  return g;
}

function buildKnife(): THREE.Group {
  const g = new THREE.Group();
  addPart(g, roundedBox(0.042, 0.05, 0.13, 0.014), POLYMER(), 0, 0, 0);
  addPart(g, new THREE.BoxGeometry(0.05, 0.05, 0.02), DARK_STEEL(), 0, 0, -0.07);
  addPart(g, new THREE.BoxGeometry(0.09, 0.018, 0.028), STEEL(), 0, 0, 0.075);
  addPart(g, roundedBox(0.024, 0.07, 0.19, 0.006), BLADE(), 0, 0.008, 0.17);
  addPart(g, new THREE.BoxGeometry(0.024, 0.05, 0.05), BLADE(), 0, 0.024, 0.268, Math.PI / 4);
  return g;
}

/** Procedural low-poly model, grip at the origin, barrel along +z. */
export function buildWeaponModel(id: WeaponId): THREE.Group {
  let g: THREE.Group;
  switch (id) {
    case 'pistol':
      g = buildPistol();
      break;
    case 'uzi':
      g = buildUzi();
      break;
    case 'shotgun':
      g = buildShotgun();
      break;
    case 'ak':
      g = buildAk();
      break;
    case 'knife':
      g = buildKnife();
      break;
    default:
      g = new THREE.Group();
  }
  g.name = WEAPONS[id].model;
  g.userData.weaponId = id;
  return g;
}
