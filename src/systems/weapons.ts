import * as THREE from 'three';
import { canvasTexture, rand, roundedBox } from '../core/utils';

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

// ---------------------------------------------------------------- muzzle anchor
/**
 * Where the barrel tip actually is in the player's own frame, once the arm is in its firing
 * pose: +x right, +y up from the feet, +z forward.
 *
 * main.ts hands the weapon model to `character.armR` (pivot 0.335 / 0.52 inside the torso, torso
 * lifted to 0.8) and `Character.animate` swings that arm to `-PI/2 + 0.05` while shooting, so the
 * anchor is exactly that chain applied to `spec.muzzle`. The old code placed the flash at a hand
 * tuned "0.75 m ahead of the shooter", which sat 0.5 m behind the AK's barrel and ignored the
 * weapon entirely: a flash at the player, not at the muzzle.
 */
export interface MuzzleAnchor {
  right: number;
  up: number;
  forward: number;
}

const ARM_PIVOT: [number, number, number] = [0.335, 0.52, 0];
const TORSO_LIFT = 0.8;
/** `Character.animate` fires with armR.rotation.x = -PI/2 + 0.05 */
const AIM_ARM_PITCH = -Math.PI / 2 + 0.05;

const muzzleAnchors = new Map<WeaponId, MuzzleAnchor>();

export function muzzleAnchor(id: WeaponId): MuzzleAnchor {
  const cached = muzzleAnchors.get(id);
  if (cached) return cached;
  const spec = WEAPONS[id];
  const tip = new THREE.Vector3(spec.muzzle[0], spec.muzzle[1], spec.muzzle[2]);
  const modelQ = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(spec.heldPose.rotation[0], spec.heldPose.rotation[1], spec.heldPose.rotation[2])
  );
  tip.applyQuaternion(modelQ);
  tip.x += spec.heldPose.position[0];
  tip.y += spec.heldPose.position[1];
  tip.z += spec.heldPose.position[2];
  tip.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(AIM_ARM_PITCH, 0, 0)));
  const anchor: MuzzleAnchor = {
    right: tip.x + ARM_PIVOT[0],
    up: tip.y + ARM_PIVOT[1] + TORSO_LIFT,
    forward: tip.z + ARM_PIVOT[2],
  };
  muzzleAnchors.set(id, anchor);
  return anchor;
}

// ---------------------------------------------------------------- impact looks
/** What the ray landed on: the puff is sized and coloured per surface. */
export type ImpactSurface = 'concrete' | 'metal' | 'flesh' | 'dirt';

export interface ImpactLook {
  /** fast, bright chips thrown back out of the surface */
  sparks: number;
  /** slow, expanding dust that stays readable at street distance */
  puffs: number;
  sparkSize: number;
  puffSize: number;
  speed: number;
  life: number;
  spark: number;
  puff: number;
}

/**
 * A chunk of concrete throws a wide pale dust cloud; sheet metal gives a tighter, hotter spray;
 * flesh almost nothing. Sizes are metres, so a shotgun blast on a wall reads wider than a 9 mm
 * hole in a car door.
 */
export const IMPACTS: Record<ImpactSurface, ImpactLook> = {
  concrete: { sparks: 8, puffs: 4, sparkSize: 0.06, puffSize: 0.28, speed: 4.2, life: 0.42, spark: 0xffd98a, puff: 0x9c9282 },
  metal: { sparks: 9, puffs: 2, sparkSize: 0.045, puffSize: 0.15, speed: 5.4, life: 0.3, spark: 0xffa733, puff: 0x87868f },
  flesh: { sparks: 5, puffs: 2, sparkSize: 0.05, puffSize: 0.16, speed: 2.6, life: 0.34, spark: 0xc9301f, puff: 0x7a2118 },
  dirt: { sparks: 6, puffs: 3, sparkSize: 0.055, puffSize: 0.2, speed: 3, life: 0.44, spark: 0xd8bb7a, puff: 0x8b7c5c },
};

/** 60 ms, as the card asks: long enough to survive several frames, short enough not to smear. */
const FLASH_LIFE = 0.06;
const TRACER_LIFE = 0.07;

interface FlashSlot {
  sprite: THREE.Sprite;
  life: number;
  max: number;
  scale: number;
}

interface TracerSlot {
  line: THREE.Line;
  mat: THREE.LineBasicMaterial;
  life: number;
  max: number;
  attr: THREE.BufferAttribute;
}

export interface ShotFxStats {
  /** live flashes + tracers + particles: the number the "peak live" check watches */
  live: number;
  peakLive: number;
  /** objects built since the pools were warmed: must stay 0 while firing */
  allocations: number;
  pooled: number;
  capacity: { flashes: number; tracers: number; particles: number };
  liveFlashes: number;
  liveTracers: number;
  liveParticles: number;
}

const PARTICLE_VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // size is metres; uScale turns it into device pixels at that depth. The 2 px floor keeps a
  // spark on a wall 40 m away from slipping between samples.
  gl_PointSize = max(2.5, aSize * uScale / max(0.05, -mv.z));
}
`;


/** Sparks are light: additive, so a chip on a dark facade still reads. */
const SPARK_FRAG = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - vec2(0.5));
  if (d > 0.5) discard;
  float core = 1.0 - d * 2.0;
  float a = vAlpha * core * core;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor, a);
  #include <colorspace_fragment>
}
`;

/**
 * Dust is matter, not light: alpha-blended, or an additive puff just clips the wall to white and
 * the whole impact reads as one starburst instead of a puff with debris in it.
 */
const DUST_FRAG = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - vec2(0.5));
  if (d > 0.5) discard;
  float a = vAlpha * 0.74 * smoothstep(0.5, 0.08, d);
  if (a < 0.012) discard;
  gl_FragColor = vec4(vColor, a);
  #include <colorspace_fragment>
}
`;

/**
 * A fixed-size pool of point particles renderered as one draw call. Two of these make up the
 * impact: bright chips (additive) and dust (alpha). Nothing here ever grows at runtime.
 */
class ParticleLayer {
  readonly points: THREE.Points;
  readonly capacity: number;
  private readonly geometry: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly baseSize: Float32Array;
  private readonly grow: Float32Array;
  private readonly gravity: Float32Array;
  private readonly drag: Float32Array;
  private readonly scratch = new THREE.Color();
  private cursor = 0;
  live = 0;

  constructor(
    scene: THREE.Scene,
    capacity: number,
    fragmentShader: string,
    blending: THREE.Blending,
    name: string,
    renderOrder: number,
    build: <T>(factory: () => T) => T
  ) {
    this.capacity = capacity;
    this.pos = build(() => new Float32Array(capacity * 3));
    this.col = build(() => new Float32Array(capacity * 3));
    this.size = build(() => new Float32Array(capacity));
    this.alpha = build(() => new Float32Array(capacity));
    this.vel = build(() => new Float32Array(capacity * 3));
    this.life = build(() => new Float32Array(capacity));
    this.maxLife = build(() => new Float32Array(capacity));
    this.baseSize = build(() => new Float32Array(capacity));
    this.grow = build(() => new Float32Array(capacity));
    this.gravity = build(() => new Float32Array(capacity));
    this.drag = build(() => new Float32Array(capacity));
    const geo = build(() => new THREE.BufferGeometry());
    geo.setAttribute('position', build(() => new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage)));
    geo.setAttribute('aColor', build(() => new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage)));
    geo.setAttribute('aSize', build(() => new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage)));
    geo.setAttribute('aAlpha', build(() => new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage)));
    this.geometry = geo;
    this.mat = build(
      () =>
        new THREE.ShaderMaterial({
          uniforms: { uScale: { value: 400 } },
          vertexShader: PARTICLE_VERT,
          fragmentShader,
          transparent: true,
          depthWrite: false,
          blending,
        })
    );
    this.points = build(() => new THREE.Points(geo, this.mat));
    this.points.frustumCulled = false;
    this.points.renderOrder = renderOrder;
    this.points.name = name;
    scene.add(this.points);
  }

  setScale(scale: number): void {
    this.mat.uniforms.uScale.value = scale;
  }

  spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    size: number,
    life: number,
    color: number,
    gravity: number,
    drag: number,
    grow: number
  ): void {
    // scan the fixed ring for a dead slot; a full pool overwrites its oldest particle, never grows
    let i = -1;
    for (let n = 0; n < this.capacity; n++) {
      const j = (this.cursor + n) % this.capacity;
      if (this.life[j] <= 0) {
        i = j;
        break;
      }
    }
    if (i < 0) {
      i = this.cursor;
    } else {
      this.live++;
    }
    this.cursor = (i + 1) % this.capacity;
    const p = i * 3;
    this.pos[p] = x;
    this.pos[p + 1] = y;
    this.pos[p + 2] = z;
    this.vel[p] = vx;
    this.vel[p + 1] = vy;
    this.vel[p + 2] = vz;
    this.scratch.setHex(color);
    this.col[p] = this.scratch.r;
    this.col[p + 1] = this.scratch.g;
    this.col[p + 2] = this.scratch.b;
    this.size[i] = size;
    this.baseSize[i] = size;
    this.alpha[i] = 1;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.gravity[i] = gravity;
    this.drag[i] = drag;
    this.grow[i] = grow;
    // the GPU has to see the write before the frame is drawn: `update()` flags the attributes too,
    // but a shot can land after the frame's update has already run
    this.markDirty();
  }

  private markDirty(): void {
    for (const key of ['position', 'aColor', 'aSize', 'aAlpha']) {
      (this.geometry.attributes[key] as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  update(d: number): void {
    if (this.live === 0) return;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= d;
      const p = i * 3;
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        this.size[i] = 0;
        this.live = Math.max(0, this.live - 1);
        continue;
      }
      const drag = Math.max(0, 1 - this.drag[i] * d);
      this.vel[p] *= drag;
      this.vel[p + 1] = this.vel[p + 1] * drag - this.gravity[i] * d;
      this.vel[p + 2] *= drag;
      this.pos[p] += this.vel[p] * d;
      this.pos[p + 1] += this.vel[p + 1] * d;
      this.pos[p + 2] += this.vel[p + 2] * d;
      const k = this.life[i] / this.maxLife[i];
      // dust keeps expanding while it fades; chips hold their size and just die
      this.size[i] = this.baseSize[i] * (1 + (1 - k) * this.grow[i]);
      this.alpha[i] = Math.min(1, k * 2.2) * k;
    }
    this.markDirty();
  }

  reset(): void {
    this.life.fill(0);
    this.alpha.fill(0);
    this.size.fill(0);
    this.live = 0;
    this.markDirty();
  }
}

export interface ShotFxStats {
  /** live flashes + tracers + particles: the number the "peak live" check watches */
  live: number;
  peakLive: number;
  /** objects built since the pools were warmed: must stay 0 while firing */
  allocations: number;
  pooled: number;
  capacity: { flashes: number; tracers: number; particles: number };
  liveFlashes: number;
  liveTracers: number;
  liveParticles: number;
}

/**
 * Every shot effect in the game, built once and reused forever.
 *
 * Two fixed point layers carry the impact (chips additive, dust alpha), a handful of sprites carry
 * the muzzle flashes and a handful of lines the tracers. Firing only writes into pre-allocated
 * arrays, and every construction inside this class goes through `mk()`, so a per-shot `new`
 * anywhere in the effect path shows up as a rising `allocations` count in the headless acceptance
 * run.
 */
export class PooledShotFx {
  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly flashes: FlashSlot[] = [];
  private readonly tracers: TracerSlot[] = [];
  private readonly sparks: ParticleLayer;
  private readonly dust: ParticleLayer;
  private readonly drawSize = new THREE.Vector2();
  private flashCursor = 0;
  private tracerCursor = 0;
  private peakLive = 0;
  private allocations = 0;
  private pooled = 0;

  constructor(
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    camera: THREE.PerspectiveCamera,
    opts: { flashes?: number; tracers?: number; particles?: number } = {}
  ) {
    this.scene = scene;
    this.renderer = renderer;
    this.camera = camera;
    const flashCount = opts.flashes ?? 4;
    const tracerCount = opts.tracers ?? 12;
    const particles = opts.particles ?? 240;
    // warm the per-weapon barrel anchors now: resolving one inside shoot() would allocate on the
    // first shot of every weapon
    for (const id of WEAPON_ORDER) muzzleAnchor(id);

    const tex = this.mk(() =>
      canvasTexture(128, 128, (ctx, w, h) => {
        const cx = w / 2;
        const cy = h / 2;
        // core + halo: a flash has to read as light, not as a painted disc
        const halo = ctx.createRadialGradient(cx, cy, 1, cx, cy, cx);
        halo.addColorStop(0, 'rgba(255,255,248,1)');
        halo.addColorStop(0.22, 'rgba(255,236,170,0.98)');
        halo.addColorStop(0.46, 'rgba(255,150,40,0.62)');
        halo.addColorStop(1, 'rgba(255,110,0,0)');
        ctx.fillStyle = halo;
        ctx.fillRect(0, 0, w, h);
        // six irregular spikes, so consecutive shots do not look stamped from one die
        ctx.strokeStyle = 'rgba(255,244,205,0.85)';
        ctx.lineCap = 'round';
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + 0.22;
          const len = i % 2 ? 0.44 : 0.3;
          ctx.lineWidth = i % 2 ? 4 : 6;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(a) * cx * len, cy + Math.sin(a) * cy * len);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(255,255,255,1)';
        ctx.beginPath();
        ctx.arc(cx, cy, w * 0.1, 0, Math.PI * 2);
        ctx.fill();
      })
    );

    for (let i = 0; i < flashCount; i++) {
      const material = this.mk(
        () =>
          new THREE.SpriteMaterial({
            map: tex,
            blending: THREE.AdditiveBlending,
            transparent: true,
            depthWrite: false,
            // a 60 ms flash may not be hidden by the shooter's own arm or a doorway frame
            depthTest: false,
            opacity: 0,
          })
      );
      const sprite = this.mk(() => new THREE.Sprite(material));
      sprite.visible = false;
      sprite.renderOrder = 10;
      sprite.name = 'muzzle-flash';
      this.scene.add(sprite);
      this.flashes.push({ sprite, life: 0, max: FLASH_LIFE, scale: 1 });
    }

    for (let i = 0; i < tracerCount; i++) {
      const attr = this.mk(() => {
        const a = new THREE.BufferAttribute(new Float32Array(6), 3);
        a.setUsage(THREE.DynamicDrawUsage);
        return a;
      });
      const geometry = this.mk(() => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', attr);
        return g;
      });
      const material = this.mk(
        () => new THREE.LineBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0, depthWrite: false })
      );
      const line = this.mk(() => new THREE.Line(geometry, material));
      line.visible = false;
      line.frustumCulled = false;
      line.name = 'shot-tracer';
      this.scene.add(line);
      this.tracers.push({ line, mat: material, life: 0, max: TRACER_LIFE, attr });
    }

    const build = <T>(factory: () => T): T => this.mk(factory);
    this.sparks = new ParticleLayer(
      scene,
      Math.round(particles * 0.7),
      SPARK_FRAG,
      THREE.AdditiveBlending,
      'shot-sparks',
      9,
      build
    );
    this.dust = new ParticleLayer(
      scene,
      particles - Math.round(particles * 0.7),
      DUST_FRAG,
      THREE.NormalBlending,
      'shot-dust',
      8,
      build
    );

    // what the pools cost at boot; from here on `allocations` must not move while firing
    this.pooled = this.allocations;
    this.allocations = 0;
  }

  /** Every construction in this class goes through here, so a stray per-shot `new` is visible. */
  private mk<T>(factory: () => T): T {
    this.allocations++;
    return factory();
  }

  /** One muzzle flash: sprite at the barrel plus the sparks it throws down the barrel line. */
  flash(pos: THREE.Vector3, scale: number, forwardX: number, forwardZ: number): void {
    const slot = this.flashes[this.flashCursor];
    this.flashCursor = (this.flashCursor + 1) % this.flashes.length;
    slot.life = FLASH_LIFE;
    slot.max = FLASH_LIFE;
    slot.scale = Math.max(0.25, scale);
    slot.sprite.position.copy(pos);
    slot.sprite.scale.setScalar(slot.scale);
    slot.sprite.material.opacity = 1;
    slot.sprite.material.rotation = rand(0, Math.PI * 2);
    slot.sprite.visible = true;
    for (let i = 0; i < 3; i++) {
      const spread = 0.55;
      this.sparks.spawn(
        pos.x,
        pos.y,
        pos.z,
        forwardX * rand(2.5, 6) + rand(-spread, spread),
        rand(0.4, 1.4),
        forwardZ * rand(2.5, 6) + rand(-spread, spread),
        rand(0.03, 0.055),
        rand(0.09, 0.16),
        0xffd98a,
        0,
        3.2,
        1.6
      );
    }
    this.bumpPeak();
  }

  /** Impact burst: chips plus dust, scaled and coloured by what the round hit. */
  impact(pos: THREE.Vector3, dir: THREE.Vector3, surface: ImpactSurface): void {
    const look = IMPACTS[surface];
    // a chip leaves the surface: spread its velocity over the hemisphere facing back along -dir
    const nx = -dir.x;
    const ny = -dir.y;
    const nz = -dir.z;
    for (let i = 0; i < look.sparks; i++) {
      const speed = look.speed * rand(0.45, 1.15);
      this.sparks.spawn(
        pos.x + rand(-0.03, 0.03),
        pos.y + rand(-0.03, 0.03),
        pos.z + rand(-0.03, 0.03),
        nx * speed + rand(-1.9, 1.9),
        ny * speed + rand(-0.4, 2.3),
        nz * speed + rand(-1.9, 1.9),
        look.sparkSize * rand(0.55, 1.3),
        look.life * rand(0.45, 1),
        look.spark,
        9.8,
        2.4,
        0.5
      );
    }
    // the pop: one short hot core on the surface. Chips alone are a few pixels at 10 m; this is
    // what makes a hit visible from the street, where the owner reported nothing. One, not a
    // stack: overlapping additive cores turn the whole impact into a white starburst.
    this.sparks.spawn(
      pos.x,
      pos.y,
      pos.z,
      nx * 0.6,
      ny * 0.6 + 0.3,
      nz * 0.6,
      look.puffSize * 0.3,
      rand(0.05, 0.08),
      0xffbf55,
      0,
      1,
      1.2
    );
    for (let i = 0; i < look.puffs; i++) {
      const speed = look.speed * rand(0.12, 0.4);
      this.dust.spawn(
        pos.x + rand(-0.05, 0.05),
        pos.y + rand(-0.05, 0.05),
        pos.z + rand(-0.05, 0.05),
        nx * speed + rand(-0.6, 0.6),
        ny * speed + rand(0.1, 0.8),
        nz * speed + rand(-0.6, 0.6),
        look.puffSize * rand(0.7, 1.3),
        look.life * rand(1.1, 1.7),
        look.puff,
        0.4,
        1.5,
        2.4
      );
    }
    this.bumpPeak();
  }

  /** Explosion / debris spark: the same pool, no dedicated object. */
  spark(pos: THREE.Vector3, color = 0xffd27a, count = 5, size = 0.09): void {
    for (let i = 0; i < count; i++) {
      this.sparks.spawn(
        pos.x,
        pos.y,
        pos.z,
        rand(-3, 3),
        rand(0.5, 4),
        rand(-3, 3),
        size * rand(0.6, 1.3),
        rand(0.25, 0.6),
        color,
        6.5,
        0.9,
        0.8
      );
    }
    this.bumpPeak();
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const slot = this.tracers[this.tracerCursor];
    this.tracerCursor = (this.tracerCursor + 1) % this.tracers.length;
    const a = slot.attr.array as Float32Array;
    a[0] = from.x;
    a[1] = from.y;
    a[2] = from.z;
    a[3] = to.x;
    a[4] = to.y;
    a[5] = to.z;
    slot.attr.needsUpdate = true;
    slot.life = TRACER_LIFE;
    slot.max = TRACER_LIFE;
    slot.mat.opacity = 0.95;
    slot.line.visible = true;
    this.bumpPeak();
  }

  private bumpPeak(): void {
    const live = this.liveParticles() + this.liveFlashes() + this.liveTracers();
    if (live > this.peakLive) this.peakLive = live;
  }

  private liveParticles(): number {
    return this.sparks.live + this.dust.live;
  }

  private liveFlashes(): number {
    let n = 0;
    for (const f of this.flashes) if (f.life > 0) n++;
    return n;
  }

  private liveTracers(): number {
    let n = 0;
    for (const t of this.tracers) if (t.life > 0) n++;
    return n;
  }

  update(dt: number): void {
    const d = Math.min(dt, 0.05);

    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= d;
      if (f.life <= 0) {
        f.sprite.visible = false;
        f.sprite.material.opacity = 0;
        continue;
      }
      const k = f.life / f.max;
      f.sprite.material.opacity = k * k;
      // a flash blooms outward as it dies instead of shrinking into a dot
      f.sprite.scale.setScalar(f.scale * (1.15 + (1 - k) * 0.45));
    }

    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= d;
      if (t.life <= 0) {
        t.line.visible = false;
        t.mat.opacity = 0;
        continue;
      }
      t.mat.opacity = 0.95 * (t.life / t.max);
    }

    this.sparks.update(d);
    this.dust.update(d);

    // metres -> device pixels at that depth: projectionMatrix[5] is 1/tan(fov/2)
    const p11 = this.camera.projectionMatrix.elements[5];
    this.renderer.getDrawingBufferSize(this.drawSize);
    const scale = p11 * this.drawSize.y * 0.5;
    this.sparks.setScale(scale);
    this.dust.setScale(scale);
    const live = this.liveParticles() + this.liveFlashes() + this.liveTracers();
    if (live > this.peakLive) this.peakLive = live;
  }

  /** Drop every live effect (restart / new game) without rebuilding anything. */
  reset(): void {
    for (const f of this.flashes) {
      f.life = 0;
      f.sprite.visible = false;
      f.sprite.material.opacity = 0;
    }
    for (const t of this.tracers) {
      t.life = 0;
      t.line.visible = false;
      t.mat.opacity = 0;
    }
    this.sparks.reset();
    this.dust.reset();
    this.peakLive = 0;
  }

  stats(): ShotFxStats {
    return {
      live: this.liveParticles() + this.liveFlashes() + this.liveTracers(),
      peakLive: this.peakLive,
      allocations: this.allocations,
      pooled: this.pooled,
      capacity: {
        flashes: this.flashes.length,
        tracers: this.tracers.length,
        particles: this.sparks.capacity + this.dust.capacity,
      },
      liveFlashes: this.liveFlashes(),
      liveTracers: this.liveTracers(),
      liveParticles: this.liveParticles(),
    };
  }
}
