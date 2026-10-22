import * as THREE from 'three';
import { City, PITCH, WORLD_HALF } from './city';
import { Character } from './character';
import { Car } from './car';
import { Ragdoll } from './ragdoll';
import { PedManager } from './npc';
import { Police } from './police';
import { Traffic } from './traffic';
import { PlacedInterior, InteriorKind } from './interior';
import { HUD } from './hud';
import { AudioSys } from './audio';
import { TouchControls } from './touch';
import { WEAPONS, WEAPON_ORDER, WeaponId, WeaponSpec, buildWeaponModel, weaponBySlot, STARTING_WEAPONS } from './weapons';
import {
  clamp,
  lerp,
  rand,
  pick,
  angleDelta,
  rayVsColliders,
  resolveCircleBox,
  formatMoney,
  canvasTexture,
} from './utils';

// ---------------------------------------------------------------- renderer
const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
const BASE_PIXEL_RATIO = Math.min(2, window.devicePixelRatio);
let pixelRatio = BASE_PIXEL_RATIO;
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// reference look is poster-flat: no filmic curve, saturated colors stay saturated
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 900);

const hud = new HUD();
const audio = new AudioSys();

const city = new City(scene);
city.addProps();

// ---------------------------------------------------------------- state
declare global {
  interface Window {
    __game: any;
    __lastShot: any;
    __viewer?: any;
  }
}

type ObjectiveId = 'drove' | 'chaos' | 'stars' | 'escape';

interface PlayerState {
  pos: THREE.Vector3;
  y: number;
  vy: number;
  yaw: number;
  vel: THREE.Vector3;
  hp: number;
  cash: number;
  inCar: Car | null;
  weapon: WeaponId;
  /** magazine of every owned weapon, so switching never loses rounds */
  ammoMag: Record<WeaponId, number>;
  ammoReserve: Record<WeaponId, number>;
  owned: Set<WeaponId>;
  /** current magazine of the equipped weapon (mirrored for the HUD/tests) */
  mag: number;
  magSize: number;
  reloading: number;
  reloadStartedAt: number;
  reloadMs: number;
  /** reload progress in simulated seconds, immune to headless frame-rate dips */
  reloadSim: number;
  reloadSimMs: number;
  shootCd: number;
  /** raised-arm timer after a shot, so the muzzle flash sits on the barrel */
  aimPose: number;
  /** melee swing timer */
  swing: number;
  grounded: boolean;
  rhythm: number;
  lastHit?: number;
  inInterior: PlacedInterior | null;
  savedPos?: THREE.Vector3;
  savedCamYaw?: number;
}

const player: PlayerState = {
  pos: city.getSpawn(),
  y: 0,
  vy: 0,
  yaw: 0,
  vel: new THREE.Vector3(),
  hp: 100,
  cash: 250,
  inCar: null,
  weapon: 'pistol',
  ammoMag: { fist: 0, knife: 0, pistol: 12, uzi: 0, shotgun: 0, ak: 0 },
  ammoReserve: { fist: 0, knife: 0, pistol: 96, uzi: 0, shotgun: 0, ak: 0 },
  owned: new Set<WeaponId>(STARTING_WEAPONS),
  mag: 12,
  magSize: 12,
  reloading: 0,
  reloadStartedAt: 0,
  reloadMs: 0,
  reloadSim: 0,
  reloadSimMs: 0,
  shootCd: 0,
  aimPose: 0,
  swing: 0,
  grounded: true,
  rhythm: 0,
  inInterior: null,
};

const character = new Character({ shirt: 0xd94f4f, pants: 0x2f3a52, skin: 0xd9a273 });
character.group.position.copy(player.pos);
scene.add(character.group);

// right-hand weapon mount: every model lives here, only the equipped one shows.
// heldPose is applied once, so switching is a visibility toggle.
const weaponMount = new THREE.Group();
character.armR.add(weaponMount);
const weaponModels = {} as Record<WeaponId, THREE.Group>;
for (const id of WEAPON_ORDER) {
  const model = buildWeaponModel(id);
  const pose = WEAPONS[id].heldPose;
  model.position.set(pose.position[0], pose.position[1], pose.position[2]);
  model.rotation.set(pose.rotation[0], pose.rotation[1], pose.rotation[2]);
  model.visible = false;
  weaponMount.add(model);
  weaponModels[id] = model;
}
weaponModels[player.weapon].visible = true;

const peds = new PedManager(scene, city, 34);
const police = new Police(scene, city, audio);
const traffic = new Traffic(scene, city, 12);

// headlight rig that follows whichever car the player is driving
const headlight = new THREE.SpotLight(0xfff2cc, 0, 55, 0.55, 0.45, 1.6);
headlight.position.set(0, 0.9, 0);
headlight.target.position.set(0, 0.2, 20);
scene.add(headlight);
scene.add(headlight.target);
let headlightAttached: Car | null = null;

const cityCars: Car[] = [];
for (let i = 0; i < 9; i++) {
  const spot = city.randomParkingSpot();
  const type = pick(['sedan', 'sedan', 'muscle', 'van', 'taxi']);
  const c = new Car(scene, { type, position: spot.pos, yaw: spot.yaw });
  cityCars.push(c);
}

function allCars() {
  return [...cityCars, ...traffic.cars.map((e) => e.car), ...police.cars.map((e) => e.car)];
}

// cash pickups
const pickups: { pos: THREE.Vector3; mesh: THREE.Mesh; active: boolean; timer: number }[] = [];
const pickupGeo = new THREE.TorusGeometry(0.42, 0.14, 8, 14);
const pickupMat = new THREE.MeshStandardMaterial({ color: 0xffcf3a, emissive: 0xffb300, emissiveIntensity: 0.55, metalness: 0.85, roughness: 0.25 });
for (let i = 0; i < 14; i++) {
  const mesh = new THREE.Mesh(pickupGeo, pickupMat);
  mesh.castShadow = true;
  scene.add(mesh);
  pickups.push({ pos: city.randomSidewalkPoint(), mesh, active: true, timer: 0 });
}

// weapon pickups: four fixed sidewalk spots plus drops from wrecked cruisers
interface WeaponPickup {
  id: WeaponId;
  pos: THREE.Vector3;
  group: THREE.Group;
  active: boolean;
  timer: number;
  permanent: boolean;
}
const weaponPickups: WeaponPickup[] = [];
const pickupRingGeo = new THREE.TorusGeometry(0.5, 0.05, 6, 18);
const pickupRingMat = new THREE.MeshBasicMaterial({ color: 0xffcc33, transparent: true, opacity: 0.8 });

function spawnWeaponPickup(id: WeaponId, x: number, z: number, permanent: boolean) {
  const group = new THREE.Group();
  const model = buildWeaponModel(id);
  model.scale.setScalar(1.35);
  model.position.y = 0.16;
  group.add(model);
  const ring = new THREE.Mesh(pickupRingGeo, pickupRingMat);
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);
  const ground = city.groundHeightAt(x, z);
  group.position.set(x, ground + 0.8, z);
  scene.add(group);
  weaponPickups.push({ id, pos: new THREE.Vector3(x, ground, z), group, active: true, timer: 0, permanent });
}

// sidewalks around the spawn block, one per direction so the pouch fills fast
const FIXED_WEAPON_PICKUPS: { id: WeaponId; x: number; z: number }[] = [
  { id: 'uzi', x: 26, z: 42.8 },
  { id: 'shotgun', x: 42.8, z: 26 },
  { id: 'ak', x: 26, z: 9.2 },
  { id: 'knife', x: -9.2, z: 26 },
];
for (const spot of FIXED_WEAPON_PICKUPS) spawnWeaponPickup(spot.id, spot.x, spot.z, true);

let copDropIndex = 0;
/** a wrecked cruiser leaves a gun behind, cycling uzi -> shotgun -> AK */
function dropCopWeapon(pos: THREE.Vector3) {
  const id = (['uzi', 'shotgun', 'ak'] as WeaponId[])[copDropIndex++ % 3];
  spawnWeaponPickup(id, pos.x + rand(-1.2, 1.2), pos.z + rand(-1.2, 1.2), false);
  hud.toast(`Cop dropped ${WEAPONS[id].name}`, 'good', 1800);
}

// effects
const fx: { obj: any; life: number; max: number; kind: string }[] = [];
function addTracer(a: THREE.Vector3, b: THREE.Vector3) {
  const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
  const mat = new THREE.LineBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.95 });
  const line = new THREE.Line(geo, mat);
  scene.add(line);
  fx.push({ obj: line, life: 0.08, max: 0.08, kind: 'fade' });
}
function addSpark(pos: THREE.Vector3, color: number = 0xffd27a) {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 6, 5),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 })
  );
  m.position.copy(pos);
  scene.add(m);
  fx.push({ obj: m, life: 0.22, max: 0.22, kind: 'spark' });
}
// muzzle flash: additive sprite with soft falloff + spike so it reads as a
// flash, not a floating ball, and stays visible for a couple of frames
const muzzleTex = canvasTexture(64, 64, (ctx, w, h) => {
  const g = ctx.createRadialGradient(w / 2, h / 2, 1, w / 2, h / 2, w / 2);
  g.addColorStop(0, 'rgba(255,255,240,1)');
  g.addColorStop(0.3, 'rgba(255,224,140,0.95)');
  g.addColorStop(0.62, 'rgba(255,150,40,0.5)');
  g.addColorStop(1, 'rgba(255,110,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,248,210,0.9)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(w * 0.5, h * 0.06);
  ctx.lineTo(w * 0.5, h * 0.94);
  ctx.moveTo(w * 0.1, h * 0.5);
  ctx.lineTo(w * 0.9, h * 0.5);
  ctx.stroke();
});
function addMuzzle(pos: THREE.Vector3, scale = 0.85) {
  const mat = new THREE.SpriteMaterial({
    map: muzzleTex,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: false, // a 0.12 s flash may not be hidden by the shooter's own body
    opacity: 1,
  });
  const s = new THREE.Sprite(mat);
  s.position.copy(pos);
  s.userData.baseScale = scale;
  s.scale.setScalar(scale);
  s.renderOrder = 10;
  scene.add(s);
  fx.push({ obj: s, life: 0.12, max: 0.12, kind: 'flash' });
}
function updateFx(dt: number) {
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i];
    f.life -= dt;
    const k = clamp(f.life / f.max, 0, 1);
    f.obj.material.opacity = k;
    if (f.kind === 'spark') f.obj.scale.setScalar(0.4 + k * 0.9);
    if (f.kind === 'flash') f.obj.scale.setScalar((f.obj.userData.baseScale ?? 1) * (0.65 + (1 - k) * 0.45));
    if (f.life <= 0) {
      scene.remove(f.obj);
      f.obj.geometry?.dispose();
      f.obj.material?.dispose?.();
      fx.splice(i, 1);
    }
  }
}

const ragdolls: Ragdoll[] = [];
// a wreck only explodes (and drops loot) once, however many rounds hit it after
const explodedCars = new WeakSet<any>();
let testTarget: any = null; // _test.target() handle, pinned by _test.pinTarget()


function lockPointer() {
  suppressLockPauseUntil = performance.now() + 600;
  try {
    const p = canvasEl.requestPointerLock?.();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {
    /* pointer lock can be blocked (iframe / automated browser) — ignore */
  }
}

// ---------------------------------------------------------------- input
const keys = new Set();
const mouse = { dx: 0, dy: 0, left: false, right: false, down: false };
let camYaw = Math.PI * 0.25;
let camPitch = 0.1;
let camDist = 5.8;
let shake = 0;
let shakeRate = 2.2; // amplitude units per second, set by setShake()
let paused = true;
let started = false;
let pointerLocked = false;
let suppressLockPauseUntil = 0; // ignore the unlock event our own lock request produces

const canvasEl = canvas as HTMLCanvasElement;
canvasEl.addEventListener('click', () => {
  if (started && !pointerLocked) {
    lockPointer();
  }
});

// firing gate: started, not paused, on foot. Pointer lock is NOT part of it —
// the lock only captures the mouse for free look, and it is refused outright in
// headless runs, iframe embeds and some browsers, which used to make the gun dead.
let suppressFireUntil = 0; // swallows the click that resumes the game
function canShootNow() {
  return started && !paused && !player.inCar && performance.now() >= suppressFireUntil;
}

document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvasEl;
  // losing the pointer (alt-tab) pauses, but the transient unlock created by our own
  // requestPointerLock() must not re-pause the game right after the player hits Resume
  if (!pointerLocked && started && !paused && performance.now() > suppressLockPauseUntil) {
    paused = true;
    hud.showPause(true);
  }
});

document.addEventListener('mousemove', (e) => {
  if (!pointerLocked) return;
  mouse.dx += e.movementX;
  mouse.dy += e.movementY;
});

document.addEventListener('mousedown', (e) => {
  if (!started) return;
  if (e.button === 0) {
    mouse.left = true;
    if (!pointerLocked) lockPointer();
    // edge-triggered shot: a real click can land and lift between two frames,
    // so the trigger fires here as well as in the held-fire pump
    if (canShootNow()) shoot();
  }
  if (e.button === 2) mouse.right = true;
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) mouse.left = false;
  if (e.button === 2) mouse.right = false;
});
document.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (!started) return;
  const slotCode = e.code.startsWith('Digit') ? e.code.slice(5) : e.code.startsWith('Numpad') ? e.code.slice(6) : '';
  if (slotCode && !e.repeat) {
    const slot = Number(slotCode);
    if (slot >= 1 && slot <= 6) equipSlot(slot);
  }
  if (e.code === 'KeyF') toggleVehicle();
  if (e.code === 'KeyE') {
    if (player.inInterior) exitInterior();
    else {
      const door = nearestShopDoor();
      if (door) enterInterior(door);
    }
  }
  if (e.code === 'KeyQ') punch();
  if (e.code === 'KeyR') startReload();
  if (e.code === 'KeyM') {
    const muted = audio.toggleMute();
    hud.toast(muted ? 'Audio muted' : 'Audio on');
  }
  if (e.code === 'Escape') {
    togglePause();
    return;
  }
  if (e.code === 'KeyP' && !e.repeat) togglePause();
  if (e.code === 'KeyT') {
    dayT = (dayT + 0.12) % 1;
    hud.toast(dayT > 0.2 && dayT < 0.55 ? 'Morning' : dayT < 0.78 ? 'Afternoon' : 'Night');
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

// mouse wheel cycles the owned weapons; passive:false so the page never scrolls
document.addEventListener(
  'wheel',
  (e) => {
    if (!started || paused) return;
    e.preventDefault();
    cycleWeapon(e.deltaY > 0 ? 1 : -1);
  },
  { passive: false }
);

// ---------------------------------------------------------------- touch
// The on-screen layer only feeds the state above: axes for walking, deltas for
// the camera, hooks for the discrete actions. Desktop never activates it.
const touch = new TouchControls({
  activate() {
    hud.setTouchMode(true);
  },
  look(dx, dy) {
    if (!started || paused) return;
    mouse.dx += dx;
    mouse.dy += dy;
  },
  pause() {
    if (!started) return;
    togglePause();
  },
  vehicle() {
    if (!started || paused) return;
    toggleVehicle();
  },
  interact() {
    if (!started || paused) return;
    if (player.inInterior) exitInterior();
    else {
      const door = nearestShopDoor();
      if (door) enterInterior(door);
    }
  },
  punch() {
    if (!started || paused) return;
    punch();
  },
});

// touch parity for weapon switching: tap the ammo chip to cycle the pouch
hud.el.ammoWrap?.addEventListener('pointerdown', () => {
  if (!started || paused || !touch.state.active) return;
  cycleWeapon(1);
});

function togglePause(force?: boolean) {
  const next = force === undefined ? !paused : !!force;
  paused = next;
  hud.showPause(next);
  if (next && document.pointerLockElement) document.exitPointerLock?.();
  if (!next) {
    suppressFireUntil = performance.now() + 250;
    lockPointer();
  }
}

// ---------------------------------------------------------------- day cycle
let dayT = 0.34;

// ---------------------------------------------------------------- camera
const camTarget = new THREE.Vector3();
const camGoal = new THREE.Vector3();
const camOffset = new THREE.Vector3(Math.sin(Math.PI * 0.25) * 5.7, 1.15, Math.cos(Math.PI * 0.25) * 5.7);
const camShoulder = new THREE.Vector3();
const _camTmp = new THREE.Vector3();
const BASE_FOV = 58;
let camDistActual = 5.8;
let autoAlignTimer = 0;
let cinematic = false; // test hook: freeze the follow camera for asset comparison shots
let poseLock = false; // test hook: keep the on-foot model visible and weapon raised

/**
 * Screen shake: `amp` is a world-unit offset, `duration` is clamped to 0.25 s so
 * even a full-speed pile-up settles quickly. A stronger shake already playing
 * wins, smaller ones are ignored instead of restarting the timer.
 */
function setShake(amp: number, duration = 0.25) {
  if (amp <= 0 || amp < shake) return;
  shake = amp;
  shakeRate = amp / clamp(duration, 0.05, 0.25);
}

function updateCamera(dt: number) {
  if (cinematic) return;
  const aiming = mouse.right && !player.inCar;
  const wantDist = player.inInterior ? 3.2 : player.inCar ? 8.4 : aiming ? 1.35 : 5.8;
  camDist = lerp(camDist, wantDist, clamp(dt * 6, 0, 1));

  // mouse look
  const sens = aiming ? 0.0009 : 0.0022;
  camYaw -= mouse.dx * sens;
  camPitch = clamp(camPitch + mouse.dy * sens * 0.85, -0.55, 1.05);
  mouse.dx = 0;
  mouse.dy = 0;

  if (player.inCar) {
    const car = player.inCar;
    autoAlignTimer += dt;
    if (autoAlignTimer > 0.9) {
      const target = car.yaw + Math.PI;
      camYaw += angleDelta(camYaw, target) * clamp(dt * 1.6, 0, 1);
      camPitch = lerp(camPitch, 0.2, clamp(dt * 1.2, 0, 1));
    }
    camTarget.set(car.pos.x, car.y + 1.5, car.pos.z);
  } else {
    camTarget.set(player.pos.x, player.y + 1.55, player.pos.z);
  }

  const cp = Math.cos(camPitch);
  const dir = new THREE.Vector3(Math.sin(camYaw) * cp, Math.sin(camPitch), Math.cos(camYaw) * cp);

  // shoulder offset is built from camYaw alone, so strafing never drags it
  if (!player.inCar) {
    const right = new THREE.Vector3(-Math.cos(camYaw), 0, Math.sin(camYaw));
    const shoulder = aiming ? 0.45 : 0.55;
    camTarget.addScaledVector(right, shoulder * 0.9);
    camTarget.y += aiming ? 0.06 : 0.12;
    camShoulder.copy(right).multiplyScalar(shoulder);
  } else {
    camShoulder.set(0, 0, 0);
  }

  // boom collision: if a wall is between the target and the wanted camera
  // position, shorten the boom quickly, then ease back out — never snap
  const camColliders = player.inInterior ? player.inInterior.colliders : city.colliders;
  const boomHit = rayVsColliders(camTarget, dir, camDist + 0.6, camColliders);
  const allowed = boomHit ? Math.max(1.1, boomHit.dist - 0.45) : camDist;
  camDistActual = lerp(camDistActual, allowed, clamp(dt * (allowed < camDistActual ? 20 : 4.5), 0, 1));

  camGoal.copy(camTarget).addScaledVector(dir, camDistActual).add(camShoulder);
  camGoal.y = Math.max(camGoal.y, 0.75);

  // smooth the camera-local offset rather than the world position, so the
  // framing stays glued to the player while the boom settles
  _camTmp.copy(camGoal).sub(camTarget);
  camOffset.lerp(_camTmp, clamp(dt * 12, 0, 1));
  camera.position.copy(camTarget).add(camOffset);
  if (shake > 0.001) {
    camera.position.x += rand(-shake, shake);
    camera.position.y += rand(-shake, shake);
    camera.position.z += rand(-shake, shake);
    shake = Math.max(0, shake - dt * shakeRate);
  }
  camera.lookAt(camTarget);

  // small FOV kick once the car is properly moving (never on foot)
  const speed01 = player.inCar ? clamp(Math.abs(player.inCar.speed) / player.inCar.maxSpeed, 0, 1) : 0;
  const targetFov = BASE_FOV + clamp((speed01 - 0.45) / 0.55, 0, 1) * 6;
  if (Math.abs(camera.fov - targetFov) > 0.02) {
    camera.fov = lerp(camera.fov, targetFov, clamp(dt * 2.5, 0, 1));
    camera.updateProjectionMatrix();
  }
}

// ---------------------------------------------------------------- ground contact
const _footV = new THREE.Vector3();

/**
 * Sit a character so its lowest sole touches `groundY` exactly.
 * `character.footLift` approximates that shift but ignores the shoe's forward
 * offset and its own tilt, which let the planted foot sink a few millimetres
 * into the road. Measuring the real shoe transforms keeps the feet ground-exact
 * for every stride angle, including the frozen LOD poses.
 */
function plantFeet(ch: any, groundY: number) {
  if (!ch?.legL || !ch?.legR) return;
  const scale = ch.scale ?? 1;
  ch.group.position.y = groundY;
  let lowest = Infinity;
  for (const leg of [ch.legL, ch.legR]) {
    const shoe = leg.children?.[1];
    if (!shoe) continue;
    shoe.getWorldPosition(_footV);
    lowest = Math.min(lowest, _footV.y - 0.075 * scale);
  }
  if (lowest === Infinity) return;
  ch.group.position.y = groundY + (groundY - lowest);
}

// ---------------------------------------------------------------- player on foot
const WALK = 4.7;
const RUN = 7.6;

function updateOnFoot(dt: number) {
  const forward = new THREE.Vector3(-Math.sin(camYaw), 0, -Math.cos(camYaw));
  const right = new THREE.Vector3(-forward.z, 0, forward.x);
  const wish = new THREE.Vector3();
  if (keys.has('KeyW')) wish.add(forward);
  if (keys.has('KeyS')) wish.sub(forward);
  if (keys.has('KeyD')) wish.add(right);
  if (keys.has('KeyA')) wish.sub(right);
  if (touch.state.active) {
    wish.addScaledVector(forward, touch.state.moveY);
    wish.addScaledVector(right, touch.state.moveX);
  }
  const moving = wish.lengthSq() > 0.001;
  // the stick is analog: keyboard input is always full strength, a half-pushed
  // stick walks at half speed and still keeps its direction
  let analog = 1;
  if (moving) {
    analog = clamp(touch.state.active ? wish.length() : 1, 0, 1);
    wish.normalize();
  }

  const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight') || touch.state.sprint;
  const aiming = mouse.right;
  let targetSpeed = aiming ? 2.4 : sprint ? RUN : WALK;
  targetSpeed *= analog;
  targetSpeed *= player.hp > 30 ? 1 : 0.82;

  const targetVel = wish.multiplyScalar(moving ? targetSpeed : 0);
  player.vel.x = lerp(player.vel.x, targetVel.x, clamp(dt * 12, 0, 1));
  player.vel.z = lerp(player.vel.z, targetVel.z, clamp(dt * 12, 0, 1));

  player.pos.x += player.vel.x * dt;
  player.pos.z += player.vel.z * dt;

  // jump + sidewalk step-up
  const groundY = city.groundHeightAt(player.pos.x, player.pos.z);
  if ((keys.has('Space') || touch.state.jump) && player.grounded) {
    player.vy = 6.8;
    player.grounded = false;
  }
  if (!player.grounded) {
    player.vy -= 22 * dt;
    player.y += player.vy * dt;
    if (player.y <= groundY) {
      player.y = groundY;
      player.vy = 0;
      player.grounded = true;
    }
  } else {
    player.y = groundY;
  }
  // never rest below the surface, whatever the step-up/jump bookkeeping says
  player.y = Math.max(player.y, groundY);

  // collision: room walls/furniture while inside, city colliders outside
  const colliders = player.inInterior ? player.inInterior.colliders : city.colliders;
  for (const b of colliders) {
    if (b.h < 0.4) continue;
    const r = resolveCircleBox(player.pos.x, player.pos.z, 0.42, b);
    if (r) {
      player.pos.x = r.x;
      player.pos.z = r.z;
    }
  }
  if (!player.inInterior) {
    player.pos.x = clamp(player.pos.x, -WORLD_HALF, WORLD_HALF);
    player.pos.z = clamp(player.pos.z, -WORLD_HALF, WORLD_HALF);
  }

  // face movement direction, or camera direction while aiming
  const speed = Math.hypot(player.vel.x, player.vel.z);
  if (speed > 0.4) {
    const wantYaw = Math.atan2(player.vel.x, player.vel.z);
    player.yaw += angleDelta(player.yaw, wantYaw) * clamp(dt * 12, 0, 1);
  } else if (aiming || player.aimPose > 0) {
    const wantYaw = Math.atan2(-Math.sin(camYaw), -Math.cos(camYaw));
    player.yaw += angleDelta(player.yaw, wantYaw) * clamp(dt * 14, 0, 1);
  }

  // every vehicle body is solid: never let a cruiser park on top of the player
  for (const c of player.inInterior ? [] : allCars()) {
    const dx = player.pos.x - c.pos.x;
    const dz = player.pos.z - c.pos.z;
    const d = Math.hypot(dx, dz);
    const solid = c.radius * 0.62;
    if (d < solid && d > 0.0001) {
      const pushX = dx / d;
      const pushZ = dz / d;
      player.pos.x = c.pos.x + pushX * solid;
      player.pos.z = c.pos.z + pushZ * solid;
    }
  }

  character.group.visible = poseLock || !mouse.right;
  character.group.position.set(player.pos.x, player.y, player.pos.z);
  character.group.rotation.y = player.yaw;
  const weaponUp = aiming || player.aimPose > 0 || poseLock;
  character.animate(dt, clamp(speed / RUN, 0, 1), { aiming: weaponUp, airborne: !player.grounded, tilt: -player.vel.dot(new THREE.Vector3(right.x, 0, right.z)) * 0.01 });
  // melee swing: a short forward arc over the raised-arm pose
  if (player.swing > 0) {
    const k = 1 - player.swing / 0.28;
    const arc = Math.sin(clamp(k, 0, 1) * Math.PI);
    character.armR.rotation.x = -1.05 - arc * 1.75;
    character.armR.rotation.z = -arc * 0.35;
  }
  plantFeet(character, player.y);

  // footsteps
  if (speed > 1.2 && player.grounded) {
    player.rhythm += dt * (sprint ? 9 : 6);
    if (player.rhythm > 1) {
      player.rhythm = 0;
      audio.step();
    }
  }
}

// ---------------------------------------------------------------- vehicles
function nearestCar(maxDist = 4.6) {
  let best = null;
  let bd = maxDist;
  const all = allCars();
  for (const c of all) {
    const d = Math.hypot(c.pos.x - player.pos.x, c.pos.z - player.pos.z);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best ? { car: best, dist: bd } : null;
}

function nearestShopDoor(maxDist = 3.6) {
  let best: { x: number; z: number; kind: InteriorKind; name: string } | null = null;
  let bd = maxDist;
  for (const d of city.shopDoors) {
    const dist = Math.hypot(d.x - player.pos.x, d.z - player.pos.z);
    if (dist < bd) {
      bd = dist;
      best = d;
    }
  }
  return best;
}

function enterInterior(door: { kind: InteriorKind; name: string }) {
  const room = city.roomFor(door.kind);
  if (!room) return;
  player.savedPos = player.pos.clone();
  player.savedCamYaw = camYaw;
  room.group.visible = true;
  player.inInterior = room;
  player.pos.set(room.origin.x + room.spawn.x, 0, room.origin.z + room.spawn.z);
  player.y = 0;
  player.vel.set(0, 0, 0);
  player.grounded = true;
  character.group.visible = true;
  camYaw = 0; // camera behind the player, looking into the room
  audio.play('click', { vol: 0.4 });
  hud.toast(`Masuk ${door.name}`, 'info', 1600);
}

function exitInterior() {
  const room = player.inInterior;
  if (!room) return;
  room.group.visible = false;
  player.inInterior = null;
  if (player.savedPos) player.pos.copy(player.savedPos);
  if (player.savedCamYaw !== undefined) camYaw = player.savedCamYaw;
  player.y = 0;
  player.vel.set(0, 0, 0);
  audio.play('click', { vol: 0.4 });
  hud.toast('Keluar toko', 'info', 1400);
}

function toggleVehicle() {
  if (player.inCar) {
    const car = player.inCar;
    player.inCar = null;
    const side = new THREE.Vector3(Math.cos(car.yaw), 0, -Math.sin(car.yaw));
    player.pos.set(car.pos.x + side.x * 2.1, 0, car.pos.z + side.z * 2.1);
    for (const b of city.colliders) {
      const r = resolveCircleBox(player.pos.x, player.pos.z, 0.45, b);
      if (r) {
        player.pos.x = r.x;
        player.pos.z = r.z;
      }
    }
    player.y = 0;
    player.vel.set(0, 0, 0);
    character.group.visible = true;
    audio.engineUpdate({ on: false });
    hud.toast('On foot');
    return;
  }
  const near = nearestCar();
  if (!near) return;
  player.inCar = near.car;
  character.group.visible = false;
  camYaw = near.car.yaw + Math.PI;
  autoAlignTimer = 0;
  audio.play('click', { vol: 0.4 });
  hud.toast(near.car.isPolice ? 'Police cruiser stolen' : 'Vehicle entered', near.car.isPolice ? 'bad' : 'info');
  if (near.car.isPolice) police.addWanted(1);
  if (!flags.drove) {
    flags.drove = true;
    completeObjective('drove');
  }
}

let squealCd = 0;
function updateDriving(dt: number) {
  const car = player.inCar;
  if (!car) return;
  const touchY = touch.state.active ? touch.state.moveY : 0;
  const touchX = touch.state.active ? touch.state.moveX : 0;
  const throttle = (keys.has('KeyW') || touchY > 0.3) ? 1 : 0;
  const straightBack = keys.has('KeyS') || touchY < -0.3;
  const brake = straightBack && car.speed > 0.6;
  const reverse = straightBack && car.speed <= 0.6;
  const steer = (keys.has('KeyA') ? 1 : 0) - (keys.has('KeyD') ? 1 : 0) + (touchX > 0.25 ? -1 : touchX < -0.25 ? 1 : 0);
  const handbrake = keys.has('Space') || touch.state.jump;

  const hit = car.update(
    dt,
    { throttle: (throttle || reverse) ? (reverse ? -1 : 1) : 0, steer, brake, handbrake },
    city.colliders,
    WORLD_HALF
  );
  if (hit && hit.impact > 5) {
    audio.play(hit.impact > 16 ? 'crash2' : 'crash', { vol: clamp(hit.impact / 34, 0.15, 0.8) });
    // shake tracks the closing speed of the hit, capped at 0.25 s
    setShake(clamp(hit.impact / 70, 0.04, 0.22), clamp(hit.impact / 55, 0.1, 0.25));
    if (hit.impact > 14) {
      hud.toast('Crash!', 'bad', 1200);
      hurt(hit.impact * 0.55);
    }
  }
  // tyre squeal: a short burst when the handbrake bites at speed, repeated
  // while the car keeps sliding (no reliance on a per-frame random roll)
  squealCd = Math.max(0, squealCd - dt);
  const sliding = handbrake && Math.abs(car.speed) > 8 && car.y < 0.2;
  if (sliding && squealCd <= 0) {
    audio.tyreScreech(clamp(Math.abs(car.speed) / 30, 0.08, 0.2));
    squealCd = 0.5;
  }

  // ramp launch
  for (const pad of city.jumpPads) {
    const d = Math.hypot(car.pos.x - pad.pos.x, car.pos.z - pad.pos.z);
    if (d < pad.radius && Math.abs(car.speed) > 9 && car.y < 0.2) {
      const dirDot = car.forward.dot(pad.dir);
      if (dirDot > 0.4) {
        car.jump(9.5);
        audio.play('metal', { vol: 0.35 });
        hud.toast('Air time! +$50', 'good', 1500);
        addCash(50);
      }
    }
  }

  // enter / exit prompt handled in prompt logic
  // engine note: gear-stepped pitch from the real speed, volume swells with
  // both throttle and road speed instead of a flat idle drone
  const speed01 = clamp(Math.abs(car.speed) / car.maxSpeed, 0, 1);
  audio.engineUpdate({ speed01: car.engineRpm01, throttle: throttle * (0.55 + 0.45 * speed01), on: true });

  // headlights at night
  if (headlightAttached !== car) {
    car.mesh.add(headlight);
    car.mesh.add(headlight.target);
    headlightAttached = car;
  }
  headlight.position.set(0, 0.95, car.length * 0.45);
  headlight.target.position.set(0, 0.1, car.length * 0.45 + 22);
  const nightFactor = 1 - clamp((city.daylight - 0.05) / 0.4, 0, 1);
  headlight.intensity = nightFactor * 90;
  character.group.position.set(car.pos.x, car.y, car.pos.z);

  // keep the player's logical position on the car
  player.pos.set(car.pos.x, 0, car.pos.z);
  player.y = car.y;

  // car vs pedestrians
  const carSpeed = Math.abs(car.speed);
  if (carSpeed > 4) {
    for (const ped of peds.peds) {
      if (ped.dead) continue;
      const d = Math.hypot(ped.pos.x - car.pos.x, ped.pos.z - car.pos.z);
      if (d < 2.9 && Math.abs(ped.pos.z - car.pos.z) < 4 && Math.abs(ped.pos.x - car.pos.x) < 4) {
        const v = car.forward.multiplyScalar(carSpeed * 0.95);
        v.y = 6 + carSpeed * 0.22;
        ragdollPed(ped, v);
        audio.play('bodyfall', { vol: clamp(carSpeed / 26, 0.3, 0.9) });
        addCash(35);
        hud.toast('+$35 street bonus', 'cash', 1600);
        police.addWanted(1.1);
        flags.chaos = true;
        if (!flags.chaosRewarded) {
          flags.chaosRewarded = true;
          completeObjective('chaos');
        }
        car.speed *= 0.94;
        setShake(0.1, 0.16);
      }
    }
  }

  // cop cars ram the player
  for (const entry of police.cars) {
    const cop = entry.car;
    const d = Math.hypot(cop.pos.x - car.pos.x, cop.pos.z - car.pos.z);
    const now = performance.now();
    if (d < 3.4 && Math.abs(cop.speed) > 5 && now - (entry.lastRam ?? 0) > 700) {
      entry.lastRam = now;
      car.applyDamage(7);
      setShake(0.14, 0.2);
      audio.play('crash', { vol: 0.3 });
    }
  }
}

// ---------------------------------------------------------------- combat
const PED_HP = 100;
const pedHealth = new WeakMap<any, number>();
const pedBleed = new Map<any, { left: number; damage: number; interval: number; timer: number }>();

function currentSpec(): WeaponSpec {
  return WEAPONS[player.weapon];
}

function equipId(id: WeaponId) {
  if (!player.owned.has(id) || id === player.weapon) return;
  player.ammoMag[player.weapon] = player.mag;
  const spec = WEAPONS[id];
  player.reloading = 0;
  player.swing = 0;
  player.weapon = id;
  player.magSize = spec.magSize;
  player.mag = spec.melee ? 0 : player.ammoMag[id] ?? spec.magSize;
  player.shootCd = Math.max(player.shootCd, 0.18);
  for (const wid of WEAPON_ORDER) weaponModels[wid].visible = wid === id;
  audio.play('click', { vol: 0.35, rate: 1.15 });
}

function equipSlot(slot: number) {
  const id = weaponBySlot(slot);
  if (!id) return;
  if (!player.owned.has(id)) {
    hud.toast(`${WEAPONS[id].name} — find a pickup`, 'bad', 1300);
    return;
  }
  equipId(id);
}

function cycleWeapon(dir: number) {
  const owned = WEAPON_ORDER.filter((w) => player.owned.has(w));
  if (owned.length < 2) return;
  const i = owned.indexOf(player.weapon);
  equipId(owned[(i + dir + owned.length) % owned.length]);
}

function giveWeapon(id: WeaponId) {
  const spec = WEAPONS[id];
  player.owned.add(id);
  player.ammoMag[id] = spec.magSize;
  player.ammoReserve[id] = Math.min(999, (player.ammoReserve[id] ?? 0) + spec.reserve);
  if (player.weapon === id) {
    player.mag = spec.magSize;
    player.magSize = spec.magSize;
  } else {
    equipId(id);
  }
  hud.toast(`${spec.name} +${spec.reserve}`, 'good', 1600);
}

function startReload() {
  const spec = currentSpec();
  if (spec.melee || player.inCar || player.reloading > 0) return;
  if (player.mag >= spec.magSize) return;
  if ((player.ammoReserve[player.weapon] ?? 0) <= 0) {
    audio.play('click', { vol: 0.3, rate: 0.7 });
    return;
  }
  player.reloading = spec.reload;
  player.reloadSim = 0;
  player.reloadStartedAt = performance.now();
  audio.play('click', { vol: 0.5, rate: 0.8 });
}

function finishReload() {
  const spec = currentSpec();
  const need = spec.magSize - player.mag;
  const take = Math.min(need, player.ammoReserve[player.weapon] ?? 0);
  player.mag += take;
  player.ammoReserve[player.weapon] -= take;
  player.reloadMs = performance.now() - player.reloadStartedAt;
  player.reloadSimMs = player.reloadSim * 1000;
  audio.play('click', { vol: 0.45, rate: 1.2 });
}

/**
 * Start the next shot's cooldown. While the trigger stays held the leftover
 * phase is carried over (`cd + interval`), so a 900 rpm burst averages 900 rpm
 * on a 24 fps headless run instead of snapping to a whole frame per round.
 */
function fireCadence(spec: WeaponSpec) {
  const interval = 60 / spec.rpm;
  player.shootCd = Math.max(interval + Math.min(0, player.shootCd), interval * 0.15);
}

function pedAggro() {
  police.addWanted(0.8);
  flags.chaos = true;
  if (!flags.chaosRewarded) {
    flags.chaosRewarded = true;
    completeObjective('chaos');
  }
}

function killPed(ped: any, velocity: THREE.Vector3) {
  pedHealth.delete(ped);
  pedBleed.delete(ped);
  ragdollPed(ped, velocity);
  hud.hitmarker();
  addCash(15);
}

/** Every weapon's damage lands here, so ped HP is one consistent model. */
function damagePed(ped: any, damage: number, velocity: THREE.Vector3, bleed?: WeaponSpec['bleed']) {
  if (ped.dead) return;
  const hp = (pedHealth.get(ped) ?? PED_HP) - damage;
  pedHealth.set(ped, hp);
  addSpark(new THREE.Vector3(ped.pos.x, ped.pos.y + 1.15, ped.pos.z), 0xd94f4f);
  if (hp <= 0) {
    killPed(ped, velocity);
    return;
  }
  if (bleed) pedBleed.set(ped, { left: bleed.ticks, damage: bleed.damage, interval: bleed.interval, timer: bleed.interval });
  // a non-lethal hit still shoves the body; the ragdoll waits for HP to run out
  ped.pos.x += velocity.x * 0.02;
  ped.pos.z += velocity.z * 0.02;
}

function updateBleed(dt: number) {
  for (const [ped, bleed] of pedBleed) {
    if (ped.dead) {
      pedBleed.delete(ped);
      continue;
    }
    bleed.timer -= dt;
    if (bleed.timer > 0) continue;
    bleed.timer += bleed.interval;
    bleed.left--;
    damagePed(ped, bleed.damage, new THREE.Vector3(rand(-1, 1), 0, rand(-1, 1)));
    if (bleed.left <= 0 || ped.dead) pedBleed.delete(ped);
  }
}

/** place a test pedestrian on the live camera ray, `distance` m past the player */
function placeTarget(ped: any, distance: number) {
  const dir = camera.getWorldDirection(new THREE.Vector3()).normalize();
  const point = camTarget.clone().addScaledVector(dir, distance);
  ped.pos.set(point.x, city.groundHeightAt(point.x, point.z), point.z);
  ped.target = ped.pos.clone();
  ped.target.x += 0.001;
  ped.speed = 0.0001;
  ped.char.group.position.copy(ped.pos);
}

const _muzzleWorld = new THREE.Vector3();
/** barrel/blade tip in world space, sampled from the visible model */
function weaponMuzzleWorld(spec: WeaponSpec) {
  const model = weaponModels[spec.id];
  _muzzleWorld.set(spec.muzzle[0], spec.muzzle[1], spec.muzzle[2]);
  model.localToWorld(_muzzleWorld);
  return _muzzleWorld.clone();
}

function meleeAttack(spec: WeaponSpec) {
  if (player.swing > 0) return;
  player.swing = 0.28;
  fireCadence(spec);
  player.aimPose = 0.4;
  audio.play(spec.sound, { vol: spec.soundVol, rate: spec.soundRate * rand(0.95, 1.08) });
  const fwd = new THREE.Vector3(-Math.sin(camYaw), 0, -Math.cos(camYaw));
  let hits = 0;
  for (const ped of peds.peds) {
    if (ped.dead) continue;
    const to = new THREE.Vector3(ped.pos.x - player.pos.x, 0, ped.pos.z - player.pos.z);
    const dist = to.length();
    if (dist > spec.range || dist < 0.001) continue;
    if (to.normalize().dot(fwd) < 0.45) continue;
    const impulse = fwd.clone().multiplyScalar(spec.id === 'knife' ? 9 : 12);
    impulse.y = spec.id === 'knife' ? 2.5 : 5;
    damagePed(ped, spec.damage, impulse, spec.bleed);
    hits++;
  }
  if (hits) {
    pedAggro();
    hud.hitmarker();
    setShake(spec.shake, 0.12);
  } else {
    setShake(0.02, 0.08);
  }
  window.__lastShot = {
    weapon: spec.id,
    melee: true,
    simTime: +simTime.toFixed(3),
    hits,
    damage: spec.damage,
    pellets: 0,
    camPitch: +camPitch.toFixed(3),
  };
}

function shoot() {
  if (player.inCar || player.reloading > 0 || player.shootCd > 0) return;
  const spec = currentSpec();
  if (spec.melee) {
    meleeAttack(spec);
    return;
  }
  if (player.mag <= 0) {
    player.shootCd = 0.3;
    startReload();
    return;
  }
  player.mag--;
  fireCadence(spec);
  player.aimPose = 0.5;
  camPitch = clamp(camPitch - spec.recoil, -0.55, 1.05);
  setShake(spec.shake, spec.shake > 0.08 ? 0.2 : 0.1);
  audio.play(spec.sound, { vol: spec.soundVol, rate: spec.soundRate * rand(0.96, 1.04), pan: rand(-0.2, 0.2) });

  // raise the arm before sampling the muzzle so the flash sits on the barrel
  if (player.swing <= 0) {
    character.armR.rotation.x = -Math.PI / 2 + 0.05;
    character.armR.rotation.z = 0;
    character.group.updateWorldMatrix(true, true);
  }
  const muzzle = weaponMuzzleWorld(spec);
  addMuzzle(muzzle, spec.flashScale);

  const origin = camera.position.clone();
  const camDir = camera.getWorldDirection(new THREE.Vector3()).normalize();
  const camRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  const camUp = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  const cone = Math.tan(THREE.MathUtils.degToRad(spec.spread));

  const pedDamage = new Map<any, { amount: number; dir: THREE.Vector3; point: THREE.Vector3 }>();
  const carDamage = new Map<any, number>();
  let firstKind: string | null = null;
  let firstPoint: THREE.Vector3 | null = null;
  let firstDist = spec.range;

  for (let p = 0; p < spec.pellets; p++) {
    const dir = camDir.clone();
    if (spec.spread > 0) {
      const r = cone * Math.sqrt(Math.random());
      const a = Math.random() * Math.PI * 2;
      dir.applyAxisAngle(camUp, Math.cos(a) * r).applyAxisAngle(camRight, Math.sin(a) * r).normalize();
    }
    const wallHit = rayVsColliders(origin, dir, spec.range, city.colliders);
    let bestDist = wallHit ? wallHit.dist : spec.range;
    let hitPoint = origin.clone().addScaledVector(dir, bestDist);
    let hitKind: string | null = wallHit ? 'wall' : null;
    let hitPed: any = null;
    let hitCar: any = null;
    const MIN_T = 2.2;

    for (const ped of peds.peds) {
      if (ped.dead) continue;
      const center = new THREE.Vector3(ped.pos.x, ped.pos.y + 1.0, ped.pos.z);
      const t = raySphere(origin, dir, center, 0.75);
      if (t !== null && t > MIN_T && t < bestDist) {
        bestDist = t;
        hitPoint = origin.clone().addScaledVector(dir, t);
        hitKind = 'ped';
        hitPed = ped;
        hitCar = null;
      }
    }
    for (const c of allCars()) {
      const center = new THREE.Vector3(c.pos.x, c.y + 0.9, c.pos.z);
      const t = raySphere(origin, dir, center, 1.6);
      if (t !== null && t > MIN_T && t < bestDist) {
        bestDist = t;
        hitPoint = origin.clone().addScaledVector(dir, t);
        hitKind = 'car';
        hitCar = c;
        hitPed = null;
      }
    }

    if (hitPed) {
      const entry = pedDamage.get(hitPed) ?? { amount: 0, dir: dir.clone(), point: hitPoint };
      entry.amount += spec.damage;
      pedDamage.set(hitPed, entry);
    } else if (hitCar) {
      carDamage.set(hitCar, (carDamage.get(hitCar) ?? 0) + Math.max(2, Math.round(spec.damage * 0.34)));
    } else if (hitKind === 'wall') {
      addSpark(hitPoint, 0xd8d8d8);
      audio.play('metal', { vol: 0.14, rate: 1.4 });
    }

    if (p === 0) {
      firstKind = hitKind;
      firstPoint = hitPoint;
      firstDist = bestDist;
    }
  }

  for (const [ped, entry] of pedDamage) {
    const impulse = entry.dir.clone().multiplyScalar(spec.id === 'shotgun' ? 9 : 11);
    impulse.y = Math.max(2.5, impulse.y + 4);
    damagePed(ped, entry.amount, impulse);
  }
  if (pedDamage.size) pedAggro();

  for (const [car, amount] of carDamage) {
    car.applyDamage(amount);
    hud.hitmarker();
    police.addWanted(0.35);
    if (car.wrecked && !explodedCars.has(car)) {
      explodedCars.add(car);
      explode(car);
    }
  }

  const tracerEnd = firstPoint ?? origin.clone().addScaledVector(camDir, spec.range);
  addTracer(muzzle, tracerEnd);
  window.__lastShot = {
    weapon: spec.id,
    simTime: +simTime.toFixed(3),
    origin: origin.toArray().map((v) => +v.toFixed(2)),
    dir: camDir.toArray().map((v) => +v.toFixed(3)),
    bestDist: +firstDist.toFixed(2),
    hitKind: firstKind,
    hitPoint: tracerEnd.toArray().map((v) => +v.toFixed(2)),
    camPitch: +camPitch.toFixed(3),
    pellets: spec.pellets,
    damage: spec.damage,
    pedHits: pedDamage.size,
    carHits: carDamage.size,
    muzzle: muzzle.toArray().map((v) => +v.toFixed(3)),
    shotsLeft: player.mag,
  };
  if (player.mag === 0) startReload();
}

function raySphere(origin: any, dir: any, center: any, radius: number) {
  const ox = center.x - origin.x;
  const oy = center.y - origin.y;
  const oz = center.z - origin.z;
  const tca = ox * dir.x + oy * dir.y + oz * dir.z;
  if (tca < 0) return null;
  const d2 = ox * ox + oy * oy + oz * oz - tca * tca;
  const r2 = radius * radius;
  if (d2 > r2) return null;
  const thc = Math.sqrt(r2 - d2);
  const t = tca - thc;
  return t > 0 ? t : tca + thc > 0 ? tca + thc : null;
}

function punch() {
  if (player.inCar) return;
  audio.play('punch', { vol: 0.4, rate: rand(0.95, 1.1) });
  const fwd = new THREE.Vector3(-Math.sin(camYaw), 0, -Math.cos(camYaw));
  character.armR.rotation.x = -1.9;
  let hit = false;
  for (const ped of peds.peds) {
    if (ped.dead) continue;
    const to = new THREE.Vector3(ped.pos.x - player.pos.x, 0, ped.pos.z - player.pos.z);
    if (to.length() < 2.3 && to.normalize().dot(fwd) > 0.45) {
      const v = fwd.clone().multiplyScalar(13);
      v.y = 6;
      ragdollPed(ped, v);
      addCash(10);
      hit = true;
      hud.hitmarker();
      police.addWanted(0.6);
      flags.chaos = true;
      if (!flags.chaosRewarded) {
        flags.chaosRewarded = true;
        completeObjective('chaos');
      }
      flags.chaos = true;
    }
  }
  if (!hit) setShake(0.02, 0.08);
}

function ragdollPed(ped: any, velocity: any) {
  const info = ped.kill(velocity);
  const r = new Ragdoll(scene, {
    position: info.position,
    yaw: info.yaw,
    skin: info.skin,
    shirt: info.shirt,
    pants: info.pants,
    velocity: velocity.clone().setY(Math.max(velocity.y, 1.5)),
    colliders: city.colliders,
    maxLife: 11,
  });
  ragdolls.push(r);
}

function explode(car: any) {
  audio.play('explosion', { vol: 0.8, rate: rand(0.9, 1.1) });
  for (let i = 0; i < 8; i++) {
    const p = new THREE.Vector3(car.pos.x + rand(-1.5, 1.5), car.y + rand(0.4, 2.2), car.pos.z + rand(-1.5, 1.5));
    addSpark(p, pick([0xffa030, 0xff5a20, 0xffd070]));
  }
  if (car === player.inCar) {
    player.inCar = null;
    character.group.visible = true;
    hurt(45);
    hud.toast('Your car blew up', 'bad');
  }
  car.wrecked = true;
  car.speed = 0;
  setShake(0.28, 0.25);
  if (car.isPolice) dropCopWeapon(car.pos);
}

// ---------------------------------------------------------------- damage & money
function hurt(n: number) {
  player.hp -= n;
  player.lastHit = performance.now();
  hud.damageFlash();
  setShake(0.12, 0.2);
  if (player.hp <= 0) wasted();
}

function addCash(n: number) {
  player.cash += n;
}

function wasted() {
  player.hp = 100;
  player.cash = Math.max(0, player.cash - 100);
  player.pos.copy(city.getSpawn());
  player.vel.set(0, 0, 0);
  player.y = 0;
  player.inCar = null;
  character.group.visible = true;
  police.clearWanted();
  police.clearAll();
  hud.toast('WASTED — $100 hospital bill', 'bad', 3200);
  setShake(0.3, 0.25);
}

function busted() {
  const fine = Math.min(player.cash, 300);
  player.cash -= fine;
  player.inCar = null;
  character.group.visible = true;
  player.pos.copy(city.getSpawn());
  player.vel.set(0, 0, 0);
  player.y = 0;
  police.clearWanted();
  police.clearAll();
  hud.toast(`BUSTED — fine ${formatMoney(fine)}`, 'bad', 3200);
}

// ---------------------------------------------------------------- objectives
const flags: { drove: boolean; chaos: boolean; stars: boolean; escape: boolean; chaosRewarded?: boolean } = { drove: false, chaos: false, stars: false, escape: false };
const reward: Record<ObjectiveId, number> = { drove: 150, chaos: 300, stars: 800, escape: 1500 };

function completeObjective(id: ObjectiveId) {
  const r = reward[id] ?? 100;
  addCash(r);
  hud.toast(`Objective complete · +$${r}`, 'cash', 2600);
  audio.play('cash', { vol: 0.5 });
}

function objectiveText() {
  if (police.starCount >= 3) return 'Lose the cops — 3 stars and rising';
  if (police.starCount >= 1) return `Lose the cops — ${police.starCount} star${police.starCount > 1 ? 's' : ''} on you`;
  if (!flags.drove) return touch.state.active ? 'Steal a car — walk up to one and tap CAR' : 'Steal a car — walk up to one and press F';
  if (!flags.chaos) return 'Cause chaos — hit a pedestrian with a car or a fist';
  if (!flags.stars) return `Reach a 3-star wanted level (${police.starCount}/3)`;
  if (!flags.escape) return 'Lose the cops — get all stars to zero';
  return 'Free roam — the city is yours';
}

function updateObjectives() {
  if (flags.drove && flags.chaos && !flags.stars && police.starCount >= 3) {
    flags.stars = true;
    completeObjective('stars');
  }
  if (flags.stars && police.starCount === 0 && !flags.escape) {
    flags.escape = true;
    completeObjective('escape');
  }
  if (flags.drove && !flags.chaos && (police.wanted > 0.5 || player.cash > 400)) {
    // chaos is flagged where the ped is actually hit; this is a fallback for police aggro
  }
}

// ---------------------------------------------------------------- startup
hud.el.startBtn!.addEventListener('click', async () => {
  hud.el.startBtn!.disabled = true;
  hud.setLoading('loading audio…');
  try {
    await audio.init();
  } catch (e) {
    console.warn('audio init failed', e);
  }
  audio.resume();
  audio.startBgm('funk');
  hud.setLoading('');
  started = true;
  paused = false;
  suppressFireUntil = performance.now() + 200;
  hud.showStart(false);
  hud.showPause(false);
  lockPointer();
  hud.toast('Welcome to the city', 'good');
});

function resumeGame() {
  if (!paused) return;
  paused = false;
  hud.showPause(false);
  suppressLockPauseUntil = performance.now() + 600;
  suppressFireUntil = performance.now() + 250;
  lockPointer();
}

document.getElementById('pause-screen')!.addEventListener('click', resumeGame);
document.addEventListener('pointerdown', () => {
  if (paused) resumeGame();
});
document.getElementById('resume-btn')?.addEventListener('click', resumeGame);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// shooting trigger: full-auto weapons keep firing while held, semi-auto and melee
// need a fresh trigger edge. Both mouse and touch FIRE drive the same gate.
let triggerHeld = false;
function updateCombat(dt: number) {
  player.shootCd -= dt;
  player.aimPose = Math.max(0, player.aimPose - dt);
  player.swing = Math.max(0, player.swing - dt);
  if (player.reloading > 0) {
    player.reloading -= dt;
    player.reloadSim += dt;
    if (player.reloading <= 0) {
      player.reloading = 0;
      finishReload();
    }
  }
  updateBleed(dt);
  const trigger = mouse.left || (touch.state.active && touch.state.fire);
  if (trigger && canShootNow()) {
    const spec = currentSpec();
    if (spec.auto || !triggerHeld) shoot();
  }
  // between bursts the cooldown may not bank time, or the next tap could fire twice
  if (!trigger && player.shootCd < 0) player.shootCd = 0;
  triggerHeld = trigger;
}

// ---------------------------------------------------------------- pickups
function updatePickups(dt: number) {
  for (const p of pickups) {
    if (!p.active) {
      p.timer -= dt;
      if (p.timer <= 0) {
        p.pos.copy(city.randomSidewalkPoint());
        p.mesh.position.set(p.pos.x, 1.05, p.pos.z);
        p.mesh.visible = true;
        p.active = true;
      }
      continue;
    }
    p.mesh.rotation.y += dt * 2.2;
    p.mesh.position.y = 1.05 + Math.sin(performance.now() * 0.003 + p.pos.x) * 0.12;
    const d = Math.hypot(p.pos.x - player.pos.x, p.pos.z - player.pos.z);
    if (d < 1.7 && player.y < 2) {
      p.active = false;
      p.mesh.visible = false;
      p.timer = 22;
      addCash(150);
      audio.play('cash', { vol: 0.5 });
      hud.toast('+$150 pickup', 'cash', 1800);
    }
  }
}

// ---------------------------------------------------------------- weapon pickups
function updateWeaponPickups(dt: number) {
  for (let i = weaponPickups.length - 1; i >= 0; i--) {
    const p = weaponPickups[i];
    if (!p.active) {
      p.timer -= dt;
      if (p.timer > 0) continue;
      if (p.permanent) {
        p.active = true;
        p.group.visible = true;
      } else {
        p.group.traverse((o: any) => {
          if (o.isMesh) o.geometry?.dispose();
        });
        scene.remove(p.group);
        weaponPickups.splice(i, 1);
      }
      continue;
    }
    p.group.rotation.y += dt * 1.5;
    p.group.position.y = p.pos.y + 0.8 + Math.sin(performance.now() * 0.0022 + p.pos.x) * 0.08;
    if (player.inCar || player.y > 2) continue;
    if (Math.hypot(p.pos.x - player.pos.x, p.pos.z - player.pos.z) > 1.7) continue;
    giveWeapon(p.id);
    audio.play('metal', { vol: 0.28, rate: 1.5 });
    p.active = false;
    p.group.visible = false;
    p.timer = p.permanent ? 25 : 0;
  }
}

// ---------------------------------------------------------------- cops shoot the player
function copShoot(pos: any, dmg: any) {
  audio.play('shot_rifle', { vol: clamp(0.5 - pos.distanceTo(player.pos) / 90, 0.12, 0.45), rate: 1.1 });
  const from = pos.clone().setY(1.4);
  const to = new THREE.Vector3(player.pos.x, player.y + 1.1, player.pos.z);
  addTracer(from, to);
  hurt(dmg);
}

// ---------------------------------------------------------------- main loop
const clock = new THREE.Clock();
let simTime = 0; // accumulated game time, immune to frame-rate dips
let fpsAcc = 0;
let fpsFrames = 0;
let slowWindows = 0;
let fastWindows = 0;

function update(dt: number) {
  simTime += dt;
  dayT = (dayT + dt / 300) % 1;
  city.update(dt, dayT);

  // slow health regen once you have been out of trouble for a while
  const sinceHit = (performance.now() - (player.lastHit ?? 0)) / 1000;
  if (player.hp > 0 && player.hp < 100 && sinceHit > 8) {
    player.hp = Math.min(100, player.hp + 2.2 * dt);
  }

  updateCombat(dt);

  if (player.inCar) updateDriving(dt);
  else updateOnFoot(dt);

  if (!player.inInterior) peds.update(dt, {
    playerPos: player.pos,
    wanted: police.wanted,
    armed: mouse.right && !player.inCar,
    panic: police.starCount >= 3,
    cars: player.inCar ? [player.inCar] : [],
  });

  if (!player.inInterior) traffic.update(dt, { playerPos: player.pos, playerCar: player.inCar, peds, wanted: police.wanted });

  if (!player.inInterior) police.update(dt, {
    playerPos: player.pos,
    onFoot: !player.inCar,
    onArrest: busted,
    onCopShoot: copShoot,
  });
  updateObjectives();

  // cop cars damage the player on foot
  if (!player.inCar) {
    const now = performance.now();
    for (const entry of police.cars) {
      const c = entry.car;
      const d = Math.hypot(c.pos.x - player.pos.x, c.pos.z - player.pos.z);
      if (d < 2.4 && Math.abs(c.speed) > 3 && now - (entry.lastBump ?? 0) > 1200) {
        entry.lastBump = now;
        hurt(5);
        setShake(0.22, 0.25);
        audio.play('bodyfall', { vol: 0.5 });
      }
    }
  }

  // cheap one-pass separation: keeps cars from occupying the same space
  const carsNow = allCars();
  for (let i = 0; i < carsNow.length; i++) {
    const a = carsNow[i];
    for (let j = i + 1; j < carsNow.length; j++) {
      const b = carsNow[j];
      const dx = b.pos.x - a.pos.x;
      const dz = b.pos.z - a.pos.z;
      const min = (a.radius + b.radius) * 0.62;
      const d = Math.hypot(dx, dz);
      if (d < min && d > 0.01) {
        const push = (min - d) * 0.5;
        const nx = dx / d;
        const nz = dz / d;
        // never displace the car the player is driving — push the other one aside
        if (a === player.inCar) {
          b.pos.x += nx * push * 2; b.pos.z += nz * push * 2;
        } else if (b === player.inCar) {
          a.pos.x -= nx * push * 2; a.pos.z -= nz * push * 2;
        } else {
          a.pos.x -= nx * push; a.pos.z -= nz * push;
          b.pos.x += nx * push; b.pos.z += nz * push;
        }
      }
    }
  }

  for (let i = ragdolls.length - 1; i >= 0; i--) {
    if (!ragdolls[i].update(dt, city.colliders)) {
      ragdolls[i].dispose();
      ragdolls.splice(i, 1);
    }
  }

  updatePickups(dt);
  updateWeaponPickups(dt);
  updateFx(dt);

  // sun shadow + street lights follow the action
  const focus = player.inCar ? player.inCar.pos : player.pos;
  city.focusTarget = focus;
  city.updateNightLights(dayT, focus);
  city.sun.target.position.set(focus.x, 0, focus.z);
  city.sun.position.set(focus.x + 60, city.sun.position.y, focus.z + 42);

  updateCamera(dt);
  hud.setCash(player.cash);
  hud.setHealth(player.hp);
  hud.setStars(police.starCount);
  hud.setWeapon(player.weapon, player.mag, player.ammoReserve[player.weapon] ?? 0, player.reloading > 0, player.owned);
  hud.setCrosshair(!player.inCar);
  hud.setObjective(objectiveText());

  if (player.inCar) {
    const kmh = Math.abs(player.inCar.speed) * 3.6;
    hud.setSpeed(kmh, true);
  } else {
    hud.setSpeed(0, false);
  }

  // prompts
  if (player.inInterior) {
    const nearExit = player.pos.distanceTo(new THREE.Vector3(
      player.inInterior.origin.x + player.inInterior.exit.x,
      0,
      player.inInterior.origin.z + player.inInterior.exit.z
    )) < 3.2;
    hud.setPrompt(nearExit ? 'E — keluar toko' : 'E — keluar toko (dekat pintu)');
  } else if (player.inCar) {
    hud.setPrompt('F — exit vehicle');
  } else if (nearestShopDoor()) {
    const door = nearestShopDoor()!;
    hud.setPrompt(`E — masuk ${door.name}`);
  } else {
    const near = nearestCar(4.6);
    hud.setPrompt(near ? (near.car.isPolice ? 'F — steal police cruiser' : 'F — enter vehicle') : '');
  }

  // music state: chase track while wanted
  audio.startBgm(police.starCount > 0 ? 'chase' : 'funk');

  hud.drawMinimap({
    blocks: city.blocks,
    roadLines: city.roadLines,
    peds: peds.peds,
    police: police.cars,
    cars: [...cityCars, ...traffic.cars.map((e) => e.car)],
    playerCar: player.inCar,
    pickups,
    weaponPickups,
    playerPos: player.pos,
    playerYaw: player.inCar ? player.inCar.yaw : player.yaw,
  });
}

function animate() {
  requestAnimationFrame(animate);
  const rawDt = clock.getDelta();
  const dt = Math.min(0.05, rawDt);

  if (!paused) {
    update(dt);
  } else {
    // keep the scene alive while paused
    city.update(0, dayT);
    updateFx(dt);
    updateCamera(0.016);
  }

  renderer.render(scene, camera);

  fpsAcc += Math.min(0.5, rawDt);
  fpsFrames++;
  if (fpsAcc > 0.5) {
    const fps = fpsFrames / fpsAcc;
    hud.setFps(Math.round(fps));
    fpsAcc = 0;
    fpsFrames = 0;

    // dynamic resolution: keep the frame rate responsive instead of dropping frames
    if (!paused) {
      slowWindows = fps < 48 ? slowWindows + 1 : 0;
      fastWindows = fps > 57 ? fastWindows + 1 : 0;
      if (slowWindows >= 2 && pixelRatio > 0.75) {
        pixelRatio = Math.max(0.75, pixelRatio - 0.15);
        renderer.setPixelRatio(pixelRatio);
        slowWindows = 0;
      } else if (fastWindows >= 8 && pixelRatio < BASE_PIXEL_RATIO) {
        pixelRatio = Math.min(BASE_PIXEL_RATIO, pixelRatio + 0.1);
        renderer.setPixelRatio(pixelRatio);
        fastWindows = 0;
      }
    }
  }
}

// initial HUD paint
hud.setCash(player.cash);
hud.setHealth(player.hp);
hud.setStars(0);
hud.setWeapon(player.weapon, player.mag, player.ammoReserve[player.weapon] ?? 0, false, player.owned);
hud.setObjective(objectiveText());
hud.setPrompt('');
animate();

window.__game = {
  scene,
  camera,
  renderer,
  player,
  city,
  police,
  peds,
  cityCars,
  traffic,
  pickups,
  weaponPickups,
  weaponModels,
  weaponMount,
  weapons: WEAPONS,
  ragdolls,
  audio,
  hud,
  touch,
  get state() {
    return {
      paused,
      started,
      dayT,
      hp: player.hp,
      cash: player.cash,
      mag: player.mag,
      weapon: player.weapon,
      weaponName: WEAPONS[player.weapon].name,
      reserve: player.ammoReserve[player.weapon] ?? 0,
      reloading: +player.reloading.toFixed(2),
      reloadMs: Math.round(player.reloadMs),
      reloadSimMs: Math.round(player.reloadSimMs),
      owned: WEAPON_ORDER.filter((w) => player.owned.has(w)),
      weaponPickups: weaponPickups.filter((p) => p.active).length,
      inCar: !!player.inCar,
      wanted: police.wanted,
      stars: police.starCount,
      pos: player.pos.toArray().map((v) => +v.toFixed(2)),
      ragdolls: ragdolls.length,
      copCars: police.cars.length,
      peds: peds.peds.length,
      fps: hud.el.fps.textContent,
      pixelRatio: +pixelRatio.toFixed(2),
      pedsNear: peds.peds.filter((p) => !p.dead && p.pos.distanceTo(player.pos) < 70).length,
      carsNear: allCars().filter((c) => c.pos.distanceTo(player.pos) < 70).length,
      calls: renderer.info.render.calls,
      tris: renderer.info.render.triangles,
      objective: hud.el.objective.textContent,
      simTime: +simTime.toFixed(2),
      camYaw: +camYaw.toFixed(2),
      camPitch: +camPitch.toFixed(3),
      fov: +camera.fov.toFixed(2),
      speedKmh: player.inCar ? Math.round(player.inCar.kmh) : 0,
      shake: +shake.toFixed(3),
      fxCount: fx.length,
      vel: +Math.hypot(player.vel.x, player.vel.z).toFixed(2),
      touch: { ...touch.state },
    };
  },
  _test: {
    toggleVehicle,
    shoot,
    punch,
    hurt,
    busted,
    wasted,
    addCash,
    startReload,
    equip: equipId,
    equipSlot,
    cycleWeapon,
    giveWeapon,
    weaponPose(on = true) {
      poseLock = !!on;
      character.group.visible = poseLock;
      if (poseLock) {
        character.armR.rotation.x = -Math.PI / 2 + 0.05;
        character.armR.rotation.z = 0;
        character.group.updateWorldMatrix(true, true);
      }
    },
    muzzleWorld() {
      return weaponMuzzleWorld(currentSpec()).toArray().map((v) => +v.toFixed(3));
    },
    /** grip/hand point in screen space (where the model must sit) */
    handScreen() {
      // the model origin is the grip, so this is the point that must sit in the hand
      const p = weaponModels[player.weapon].getWorldPosition(new THREE.Vector3()).project(camera);
      return { x: Math.round((p.x * 0.5 + 0.5) * window.innerWidth), y: Math.round((-p.y * 0.5 + 0.5) * window.innerHeight) };
    },
    muzzleScreen() {
      const p = weaponMuzzleWorld(currentSpec()).project(camera);
      return { x: Math.round((p.x * 0.5 + 0.5) * window.innerWidth), y: Math.round((-p.y * 0.5 + 0.5) * window.innerHeight) };
    },
    weaponScreenBox() {
      // the fist has no mesh: fall back to the hand so its frame is still measurable
      let box = new THREE.Box3().setFromObject(weaponModels[player.weapon]);
      if (box.isEmpty()) {
        const hand = character.armR.children[character.armR.children.length - 1] ?? character.armR;
        box = new THREE.Box3().setFromObject(hand);
      }
      const v = new THREE.Vector3();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
        v.project(camera);
        const sx = (v.x * 0.5 + 0.5) * window.innerWidth;
        const sy = (-v.y * 0.5 + 0.5) * window.innerHeight;
        minX = Math.min(minX, sx);
        minY = Math.min(minY, sy);
        maxX = Math.max(maxX, sx);
        maxY = Math.max(maxY, sy);
      }
      return {
        x: Math.round(minX),
        y: Math.round(minY),
        w: Math.round(maxX - minX),
        h: Math.round(maxY - minY),
        worldSize: box.getSize(new THREE.Vector3()).toArray().map((n) => +n.toFixed(2)),
      };
    },
    /**
     * Put a live pedestrian on the camera's current shot ray, `distance` metres
     * past the player chest. Placing it on the player-forward line instead would
     * miss by the shoulder offset and make the hit tests flaky.
     */
    target(distance = 6) {
      const ped = peds.peds.find((p) => !p.dead);
      if (!ped) return null;
      testTarget = ped;
      pedHealth.delete(ped);
      pedBleed.delete(ped);
      ped.char.group.visible = true;
      placeTarget(ped, distance);
      return { pos: ped.pos.toArray().map((v: number) => +v.toFixed(2)), hp: PED_HP };
    },
    /** move peds and cars out of the firing line, keeping the test target */
    clearArea(radius = 25, exceptCar: any = null) {
      const ax = player.pos.x + 48;
      const az = player.pos.z + 18;
      for (const ped of peds.peds) {
        if (ped.dead || ped === testTarget) continue;
        if (Math.hypot(ped.pos.x - player.pos.x, ped.pos.z - player.pos.z) < radius) {
          ped.pos.set(ax + rand(-6, 6), city.groundHeightAt(ax, az), az + rand(-6, 6));
          ped.target = ped.pos.clone();
        }
      }
      for (const car of allCars()) {
        if (car === exceptCar) continue;
        if (Math.hypot(car.pos.x - player.pos.x, car.pos.z - player.pos.z) < radius) {
          car.pos.set(ax + rand(-6, 6), 0, az + rand(-6, 6));
          car.mesh.position.copy(car.pos);
        }
      }
    },
    /** re-centre the target (a wounded ped flees, so tests pin it before each shot) */
    pinTarget(distance = 6) {
      const ped = testTarget;
      if (!ped || ped.dead) return null;
      placeTarget(ped, distance);
      return { hp: pedHealth.get(ped) ?? PED_HP, dead: ped.dead, pos: ped.pos.toArray().map((v: number) => +v.toFixed(2)) };
    },
    pedHp(): number | null {
      const ped = testTarget;
      if (!ped) return null;
      if (ped.dead) return 0;
      return pedHealth.get(ped) ?? PED_HP;
    },
    face(x: number, z: number) {
      camYaw = Math.atan2(-(x - player.pos.x), -(z - player.pos.z));
    },
    teleport(x: number, z: number) {
      player.pos.set(x, 0, z);
      player.y = city.groundHeightAt(x, z);
      player.vel.set(0, 0, 0);
    },
    get camYaw() {
      return camYaw;
    },
    setTime(t: number) {
      dayT = t;
    },
    setCam(yaw: number, pitch: any) {
      if (yaw !== undefined) camYaw = yaw;
      if (pitch !== undefined) camPitch = pitch;
    },
    keys() {
      return [...keys];
    },

    // ---- floating geometry audit: every actor and prop must touch the ground ----
    audit() {
      const report: { peds: any[]; cars: any[]; player: number | null; ragdolls: any[]; props: any[]; buildings: any[] } = { peds: [], cars: [], player: null, ragdolls: [], props: [], buildings: [] };
      const v = new THREE.Vector3();

      for (const ped of peds.peds) {
        if (ped.dead) continue;
        // a walking dude lifts one foot; the planted foot is what must touch the ground
        const bottoms = [ped.char.legL.children[1], ped.char.legR.children[1]].map((shoe) => {
          shoe.getWorldPosition(v);
          return v.y - 0.075 * (ped.char.scale ?? 1);
        });
        const ground = city.groundHeightAt(ped.pos.x, ped.pos.z);
        const gap = Math.min(...bottoms) - ground;
        if (gap > 0.06 || gap < -0.05) report.peds.push({ gap: +gap.toFixed(3), pos: ped.pos.toArray().map((n: number) => +n.toFixed(1)) });
      }

      for (const car of allCars()) {
        // local wheel height vs the wheel radius (body roll/pitch is cosmetic)
        const gap = car.wheels[0].pivot.position.y - car.wheelRadius + car.y;
        if (Math.abs(gap) > 0.03) report.cars.push({ type: car.type, gap: +gap.toFixed(3), y: +car.y.toFixed(2) });
      }

      // lowest sole of the on-foot model vs the logical foot height: this is the
      // number that used to go negative when the planted shoe sank into the road
      let playerLowest = Infinity;
      for (const shoe of [character.legL.children[1], character.legR.children[1]]) {
        shoe.getWorldPosition(v);
        playerLowest = Math.min(playerLowest, v.y - 0.075 * (character.scale ?? 1));
      }
      report.player = +(playerLowest - player.y).toFixed(3);

      for (const r of ragdolls) {
        let minY = Infinity;
        for (const pt of Object.values(r.points)) minY = Math.min(minY, pt.p.y - pt.r);
        if (minY > 0.12) report.ragdolls.push({ minY: +minY.toFixed(2) });
      }

      for (const item of city.propAudit || []) {
        const ground = city.groundHeightAt(item.x, item.z);
        const gap = item.bottom - ground;
        // sprites and wall-mounted props legitimately float; only ground furniture is checked
        // seats, signal heads and lens boxes hang in the air on purpose
        if (['bench', 'traffic-arm', 'traffic-housing', 'traffic-lens'].includes(item.name)) continue;
        if (gap > 0.06 || gap < -0.06) {
          report.props.push({ name: item.name, gap: +gap.toFixed(3), at: [+item.x.toFixed(1), +item.z.toFixed(1)] });
        }
      }

      return report;
    },
    cinematic(on: boolean) {
      cinematic = !!on;
    },
    lookFrom(px: any, py: any, pz: any, tx: any, ty: any, tz: any) {
      cinematic = true;
      camera.position.set(px, py, pz);
      camera.lookAt(tx, ty, tz);
    },
  },
};