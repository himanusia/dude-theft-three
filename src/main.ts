import * as THREE from 'three';
import { City, PITCH, WORLD_HALF } from './world/city';
import { Character } from './actors/character';
import { plantOnGround, soleY } from './actors/plant';
import { Car, driverLook } from './vehicles/car';
import { loadCarModels } from './vehicles/carmodels';
import { districtAt } from './world/jakarta';
import * as JakartaMap from './world/jakartamap';
import * as JakartaStreets from './world/streets';
import { terrainHeight } from './world/terrain';
import { Ragdoll } from './actors/ragdoll';
import { PedManager } from './actors/npc';
import { Police } from './systems/police';
import { Traffic } from './vehicles/traffic';
import { PlacedInterior, InteriorKind } from './world/interior';
import { HUD } from './ui/hud';
import { AudioSys } from './core/audio';
import { loadSave, writeSave, clearSave, loadSettings, writeSettings, SaveData, Settings } from './core/save';
import { TouchControls } from './core/touch';
import {
  WEAPONS,
  WEAPON_ORDER,
  weaponBySlot,
  buildWeaponModel,
  STARTING_WEAPONS,
  WeaponId,
  PooledShotFx,
  muzzleAnchor,
} from './systems/weapons';
import {
  clamp,
  lerp,
  rand,
  pick,
  angleDelta,
  rayVsColliders,
  resolveCircleBox,
  formatMoney,
} from './core/utils';

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

/** Pixel-ratio ceiling for the current render scale; dynamic resolution never exceeds it. */
function maxPixelRatio() {
  return clamp(BASE_PIXEL_RATIO * settings.renderScale, 0.5, 2.5);
}

let uncappedLoop = false;

function applySettings() {
  // switching to the timer loop has to take effect immediately, not on the next reload
  uncappedLoop = !!settings.uncapped;
  pixelRatio = maxPixelRatio();
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  hud.setFpsVisible(settings.showFps);
  hud.syncSettings(settings);
  audio.setVolumes({ master: settings.master, sfx: settings.sfx, bgm: settings.bgm });
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 900);

const hud = new HUD();
const audio = new AudioSys();

// ---------------------------------------------------------------- persistence
// One read of each key at boot. A corrupt blob warns exactly once and is dropped,
// so the start screen can honestly offer "New game" instead of resuming into a
// half-read run. `pendingSave` is consumed by the first Continue.
const settings: Settings = loadSettings();
let pendingSave: SaveData | null = loadSave();
const AUTOSAVE_SECONDS = 20;

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
  mag: number;
  magSize: number;
  reloading: number;
  shootCd: number;
  aimHold: number;
  weapon: WeaponId;
  ammo: Record<string, { mag: number; reserve: number }>;
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
  mag: 12,
  magSize: 12,
  reloading: 0,
  shootCd: 0,
  aimHold: 0,
  weapon: 'pistol',
  ammo: {},
  grounded: true,
  rhythm: 0,
  inInterior: null,
};

const character = new Character({ shirt: 0xd94f4f, pants: 0x2f3a52, skin: 0xd9a273 });
character.group.position.copy(player.pos);
scene.add(character.group);

const peds = new PedManager(scene, city, 40);
const police = new Police(scene, city, audio);
const traffic = new Traffic(scene, city, 8);

// headlight rig that follows whichever car the player is driving
const headlight = new THREE.SpotLight(0xfff2cc, 0, 55, 0.55, 0.45, 1.6);
headlight.position.set(0, 0.9, 0);
headlight.target.position.set(0, 0.2, 20);
scene.add(headlight);
scene.add(headlight.target);
let headlightAttached: Car | null = null;

const cityCars: Car[] = [];
// Street parking scales with the map now: 15 cars, drawn in the cheap variant (no mirrors,
// plate or exhaust pipes) so the extra bodies cost ~12 draws instead of ~40 each.
for (let i = 0; i < 8; i++) {
  const spot = city.randomParkingSpot();
  // cycle the roster instead of picking at random: every body type has to appear on the
  // street at least once, and a random pick used to leave the map without a muscle car
  const roster = ['sedan', 'sedan', 'muscle', 'van', 'taxi', 'angkot'] as const;
  const type = roster[i % roster.length];
  const c = new Car(scene, { type, position: spot.pos, yaw: spot.yaw, simple: true });
  // the spot may sit on a kerb plate, so take the height from the city, not from zero
  c.y = city.groundHeightAt(spot.pos.x, spot.pos.z);
  c.pos.y = c.y;
  c.addDriver(...driverLook());
  cityCars.push(c);
}

// Real car bodies arrive asynchronously; the procedural ones hold the road until then.
loadCarModels().then(() => {
  for (const c of allCars()) c.groundAt = (x: number, z: number) => city.groundHeightAt(x, z);
});

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

// effects: muzzle flashes, tracers and impact puffs live in one pooled system, so firing
// writes into pre-allocated sprites/points instead of building a new object per shot
const shotFx = new PooledShotFx(scene, renderer, camera);
const muzzleScratch = new THREE.Vector3();
/** Scratch for the shot's near plane: the shooter's chest, projected onto the aim ray. */
const _shotNear = new THREE.Vector3();
/** Height of the shot's near plane on the shooter, in metres above his feet. */
const CHEST_Y = 1.2;
const tracerFrom = new THREE.Vector3();
const tracerTo = new THREE.Vector3();


const ragdolls: Ragdoll[] = [];

// Pedestrians need to know about traffic, corpses, cruisers and the wanted level.
// The context is rebuilt every frame from scratch arrays so the AI never allocates.
const pedCars: any[] = [];
const pedCops: any[] = [];

function pedContext() {
  pedCars.length = 0;
  for (const c of cityCars) pedCars.push(c);
  for (const e of traffic.cars) pedCars.push(e.car);
  for (const e of police.cars) pedCars.push(e.car);
  pedCops.length = 0;
  for (const e of police.cars) pedCops.push(e.car);
  return {
    playerPos: player.pos,
    wanted: police.wanted,
    armed: mouse.right && !player.inCar,
    aimX: -Math.sin(camYaw),
    aimZ: -Math.cos(camYaw),
    panic: police.starCount >= 3,
    cars: pedCars,
    copCars: pedCops,
    corpses: ragdolls,
    addWanted: (n: number) => police.addWanted(n),
  };
}


function lockPointer() {
  // while any menu owns the screen the cursor must stay free, otherwise the close/resume
  // button receives no click and only the pointer disappears
  if (paused || hud.mapOpen || hud.isHelpOpen?.()) {
    if (document.pointerLockElement) document.exitPointerLock?.();
    return;
  }
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
const mouse = { dx: 0, dy: 0, left: false, right: false, down: false, firedSinceDown: false };
let camYaw = Math.PI * 0.25;
let camPitch = 0.1;
/**
 * Elevation limits, in radians, of the camera BOOM (the arm from the player to the camera) — not
 * of the view. A negative boom elevation puts the camera below the player and looks up; positive
 * puts it overhead and looks down. `PITCH_UP` is the limit that made the owner say "gw ga bisa
 * ngadep ke atas": at -0.55 rad the boom reached 31.5 deg and the camera could not see the sky,
 * a 12 m guideway or the top of a tower. -0.96 rad is 55 deg of up-look, which clears the soffit
 * of the 12 m MRT deck from the street with room to spare, and still stops short of the zenith
 * where a follow camera has nothing left to frame. The down limit is untouched.
 */
const PITCH_UP = -0.96; // -55.0 deg
const PITCH_DOWN = 1.05; // +60.2 deg
let camDist = 5.8;
let shake = 0;
let shakeRate = 2.2; // amplitude units per second, set by setShake()
let paused = true;
let started = false;
let pointerLocked = false;
let suppressLockPauseUntil = 0; // ignore the unlock event our own lock request produces
/** the death card owns the player from the hit that killed them until the screen comes back */
let dying = false;

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
  return started && !paused && !dying && !player.inCar && performance.now() >= suppressFireUntil;
}

document.addEventListener('pointerlockchange', () => {
  const hadLock = pointerLocked;
  pointerLocked = document.pointerLockElement === canvasEl;
  // losing the pointer (alt-tab) pauses. Only a lock we actually held counts: a
  // refused request (headless, iframe, a navigation that still owned the lock)
  // arrives as an unlock event with no lock to lose and must not freeze the game.
  // Never while the death card is up: the player has no control to lose, and a pause
  // menu over the card would freeze the respawn's own breath and hide the sequence.
  if (hadLock && !pointerLocked && started && !paused && !dying && performance.now() > suppressLockPauseUntil) {
    paused = true;
    hud.showPause(true);
    saveGame();
  }
});

document.addEventListener('mousemove', (e) => {
  if (!pointerLocked) return;
  mouse.dx += e.movementX;
  mouse.dy += e.movementY;
});

document.addEventListener('wheel', (e) => {
  if (!started || paused || player.inCar) return;
  if (Math.abs(e.deltaY) < 6) return;
  switchSlot(e.deltaY > 0 ? 1 : -1);
}, { passive: true });

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
  if (e.button === 0) { mouse.left = false; mouse.firedSinceDown = false; }
  if (e.button === 2) mouse.right = false;
});
document.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (!started) return;
  // the death card owns the player until it lifts (same rule as togglePause/hurt): a key that
  // arrives during the 2.9 s must not walk into a shop, steal a car or swap weapon, because the
  // respawn teleports the body out of a room the session would still think it is standing in
  if (dying) return;
  if (e.code === 'KeyF') toggleVehicle();
  if (/^Digit[1-6]$/.test(e.code)) {
    const id = weaponBySlot(Number(e.code.slice(5)));
    if (id) equipWeapon(id);
  }
  if (e.code === 'KeyE') {
    if (player.inInterior) exitInterior();
    else {
      const door = nearestShopDoor();
      if (door) enterInterior(door);
    }
  }
  if (e.code === 'KeyQ') punch();
  if (e.code === 'KeyR') startReload();
  if (e.code === 'KeyM') toggleMap();
  if (e.code === 'KeyN') {
    const muted = audio.toggleMute();
    touch.setMuted(muted);
    hud.toast(muted ? 'Audio muted' : 'Audio on');
  }
  if (e.code === 'KeyO') toggleSettings();
  if (e.code === 'Escape') {
    // overlays close first: Esc must never drop you straight back into the sim
    if (hud.settingsOpen) return toggleSettings(false);
    if (hud.mapOpen) return toggleMap(false);
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

// ---------------------------------------------------------------- touch
// The on-screen layer only feeds the state above: axes for walking, deltas for
// the camera, hooks for the discrete actions. Desktop never activates it.
/** the six slots the phone picker shows, in the order Digit1..Digit6 use */
const TOUCH_SLOTS = WEAPON_ORDER.map((id) => {
  const spec = WEAPONS[id];
  return {
    id,
    slot: spec.slot,
    name: spec.name,
    short: spec.name.replace('Micro ', '').replace('-47', ''),
    glyph: spec.glyph,
  };
});
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
    if (!started || paused || dying) return;
    toggleVehicle();
  },
  reload() {
    if (!started || paused) return;
    startReload();
  },
  map() {
    if (!started) return;
    toggleMap();
  },
  mute() {
    const muted = audio.toggleMute();
    hud.toast(muted ? 'Audio muted' : 'Audio on');
    return muted;
  },
  weapon(slot: number) {
    if (!started || paused) return;
    const id = weaponBySlot(slot);
    if (id) equipWeapon(id);
  },
  // the picker asks instead of being pushed: a slot change from any path lands
  currentSlot() {
    return WEAPONS[player.weapon].slot;
  },
  interact() {
    if (!started || paused || dying) return;
    if (player.inInterior) exitInterior();
    else {
      const door = nearestShopDoor();
      if (door) enterInterior(door);
    }
  },
  punch() {
    if (!started || paused || dying) return;
    punch();
  },
}, TOUCH_SLOTS);

function togglePause(force?: boolean) {
  const next = force === undefined ? !paused : !!force;
  if (next && dying) return; // the card runs on its own clock; a pause menu must not cover it
  paused = next;
  hud.showPause(next);
  if (next) saveGame();
  if (next && document.pointerLockElement) document.exitPointerLock?.();
  if (next) hud.toggleHelp(false);
  if (!next) {
    suppressFireUntil = performance.now() + 250;
    // losing lock no longer pauses, so Resume only has to re-acquire the pointer; ask after
    // the browser's post-Esc cooldown so the first click is the only click needed
    setTimeout(() => { if (!paused) lockPointer(); }, 340);
  }
}

// ---------------------------------------------------------------- day cycle
let dayT = 0.34;

// ---------------------------------------------------------------- camera
const camTarget = new THREE.Vector3();
const camGoal = new THREE.Vector3();
const camAim = new THREE.Vector3();
const camAimTarget = new THREE.Vector3();
const camOffset = new THREE.Vector3(Math.sin(Math.PI * 0.25) * 5.7, 1.15, Math.cos(Math.PI * 0.25) * 5.7);
const camShoulder = new THREE.Vector3();
const _camTmp = new THREE.Vector3();
const BASE_FOV = 58;
let camDistActual = 5.8;
let autoAlignTimer = 0;
let cinematic = false; // test hook: freeze the follow camera for asset comparison shots

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

  // mouse look: the settings multiplier scales both axes, invert flips the pitch only
  const sens = (aiming ? 0.0009 : 0.0022) * settings.sensitivity;
  camYaw -= mouse.dx * sens;
  camPitch = clamp(camPitch + mouse.dy * sens * 0.85 * (settings.invertY ? -1 : 1), PITCH_UP, PITCH_DOWN);
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
  // The boom may never be shorter than the body it orbits: after a crash into a wall the
  // shortest legal distance put the camera inside the car, which filled the screen with the
  // car's paint. Better to clip the wall than to sit inside the vehicle.
  // On foot the camera may not come closer than 2.4 m: at 1.1 m the character's own head filled
  // a third of the screen whenever a kerb or a wall pulled the boom in.
  const minBoom = player.inCar ? 4.4 : player.inInterior ? 1.5 : 2.4;
  const allowed = boomHit ? Math.max(minBoom, boomHit.dist - 0.45) : camDist;
  camDistActual = lerp(camDistActual, allowed, clamp(dt * (allowed < camDistActual ? 20 : 4.5), 0, 1));

  camGoal.copy(camTarget).addScaledVector(dir, camDistActual).add(camShoulder);
  // The boom may not sink into the street, but the floor must not flatten the look either:
  // clamping y and still aiming at the player turned a full up-look into a look-down, because at
  // PITCH_UP the boom's own end is 4.7 m below the target and the cap caught it. The cap is
  // ground-relative (an interior has its own floor at y = 0), so it holds on the southern rise
  // where an absolute 0.75 m is metres underground.
  const floorY = player.inInterior ? 0.75 : city.groundHeightAt(camGoal.x, camGoal.z) + 0.75;
  camGoal.y = Math.max(camGoal.y, floorY);

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
  // Aim horizontally at the player, so the shoulder offset still converges on him, but at the
  // elevation the player asked for rather than at whatever elevation the boom ended up with.
  // Where the floor is not in the way this is the same ray `lookAt(camTarget)` drew; where it is,
  // the camera stops descending and the view keeps climbing to PITCH_UP.
  camAim.copy(camTarget).sub(camera.position);
  camAim.y = 0;
  if (camAim.lengthSq() < 1e-6) camAim.set(-Math.sin(camYaw), 0, -Math.cos(camYaw));
  camAim.normalize().multiplyScalar(Math.cos(camPitch));
  camAim.y = -Math.sin(camPitch);
  camAimTarget.copy(camera.position).addScaledVector(camAim, 10);

  camera.lookAt(camAimTarget);

  // small FOV kick once the car is properly moving (never on foot)
  const speed01 = player.inCar ? clamp(Math.abs(player.inCar.speed) / player.inCar.maxSpeed, 0, 1) : 0;
  const targetFov = BASE_FOV + clamp((speed01 - 0.45) / 0.55, 0, 1) * 6;
  if (Math.abs(camera.fov - targetFov) > 0.02) {
    camera.fov = lerp(camera.fov, targetFov, clamp(dt * 2.5, 0, 1));
    camera.updateProjectionMatrix();
  }
}

// ---------------------------------------------------------------- ground contact
// The measure (`city.groundHeightAt`) says what is built under a point; `plantOnGround` sits the
// body's real sole on it. Both are shared with the pedestrians, so the player and the crowd cannot
// disagree about where the pavement is.

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

  // collision: room walls/furniture while inside, city colliders outside.
  // Two passes, because a rotated footprint is a row of strips: being pushed out of one strip can
  // leave the body a few centimetres inside its neighbour, and one pass then drops it through the
  // seam between two boxes that are meant to be one wall.
  const colliders = player.inInterior ? player.inInterior.colliders : city.colliders;
  for (let pass = 0; pass < 2; pass++) {
    for (const b of colliders) {
      if (b.h < 0.4) continue;
      const r = resolveCircleBox(player.pos.x, player.pos.z, 0.42, b);
      if (r) {
        player.pos.x = r.x;
        player.pos.z = r.z;
      }
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
  } else if (aiming) {
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

  character.setArmed(true);
  // the body model must never show while driving: it stands at the player position, which is
  // inside the cabin, so its head pokes through the roof
  character.group.visible = !mouse.right && !player.inCar;
  character.group.position.set(player.pos.x, player.y, player.pos.z);
  character.group.rotation.y = player.yaw;
  const weaponUp = aiming || player.aimHold > 0;
  character.animate(dt, clamp(speed / RUN, 0, 1), { aiming: weaponUp, airborne: !player.grounded, tilt: -player.vel.dot(new THREE.Vector3(right.x, 0, right.z)) * 0.01 });
  plantOnGround(character, player.y);

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
  // Standing outside matters, not just distance: two shopfronts can be close enough that
  // "nearest door" would put you in the neighbour's shop. A door only counts when the player
  // is on its outward side.
  let best: { x: number; z: number; kind: InteriorKind; name: string } | null = null;
  let bd = maxDist;
  for (const d of city.shopDoors) {
    const dx = player.pos.x - d.x;
    const dz = player.pos.z - d.z;
    const dist = Math.hypot(dx, dz);
    if (dist >= bd || dist < 1e-4) continue;
    const side = (dx / dist) * (d.nx ?? 0) + (dz / dist) * (d.nz ?? 1);
    if (side < 0.2) continue;                 // player is behind the shopfront
    bd = dist;
    best = d;
  }
  return best;
}

function enterInterior(door: { kind: InteriorKind; name: string }) {
  const room = city.roomFor(door.kind);
  if (!room) return;
  // the death card owns the player: entering a room during it is what parked a live room
  // reference 612 m behind the respawn point, with the room's colliders replacing the city's
  if (dying) return;
  // never leave the player in two worlds at once: seated in a car you must get out first
  if (player.inCar) {
    hud.toast('Keluar dari mobil dulu', 'warn', 1600);
    return;
  }
  player.savedPos = player.pos.clone();
  player.savedCamYaw = camYaw;
  room.group.visible = true;
  player.inInterior = room;
  // the street is behind a wall now: take the engine down through it rather than leaving the
  // last drive note hanging at full level inside a shop
  audio.engineUpdate({ on: false, muffle: engineMuffle() });
  player.pos.set(room.origin.x + room.spawn.x, 0, room.origin.z + room.spawn.z);
  player.y = 0;
  player.vel.set(0, 0, 0);
  player.grounded = true;
  character.group.visible = true;
  camYaw = 0; // camera behind the player, looking into the room
  audio.play('click', { vol: 0.4 });
  hud.toast(`Masuk ${door.name}`, 'info', 1600);
}

/**
 * Drop every trace of the shop: the shell, the reference and the door-side anchor. Anything
 * that moves the body without going through the door (respawn, busted, save load, new game)
 * must call this or the session keeps `inInterior` while standing in the street: the room's
 * colliders then replace the city's every frame and `if (!player.inInterior)` keeps peds,
 * traffic and police frozen forever, 600 m from a room that is still visible.
 */
function resetInterior() {
  if (player.inInterior) player.inInterior.group.visible = false;
  player.inInterior = null;
  player.savedPos = undefined;
  player.savedCamYaw = undefined;
}

function exitInterior() {
  const room = player.inInterior;
  if (!room) return;
  const back = player.savedPos;
  const backYaw = player.savedCamYaw;
  resetInterior();
  if (back) player.pos.copy(back);
  if (backYaw !== undefined) camYaw = backYaw;
  player.y = 0;
  player.vel.set(0, 0, 0);
  audio.play('click', { vol: 0.4 });
  hud.toast('Keluar toko', 'info', 1400);
}

function toggleVehicle() {
  if (player.inCar) {
    const car = player.inCar;
    if (player.inCar) player.inCar.setDriverVisible(true);
    if (player.inCar) player.inCar.setDriverVisible(true);
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
  near.car.setDriverVisible(false);
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

/**
 * How much bodywork sits between the player's ear and the engine, 0..1: nothing in an open
 * cockpit, the roof and glass of a closed cabin, and a shop's walls once the player walks
 * inside one (the car they just left keeps fading out through them instead of cutting dead).
 */
function engineMuffle(car: any = player.inCar) {
  if (player.inInterior) return 0.85;
  return car && car.cabinClosed ? 0.45 : 0;
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
  audio.engineUpdate({
    speed01: car.engineRpm01,
    throttle: throttle * (0.55 + 0.45 * speed01),
    on: true,
    muffle: engineMuffle(car),
  });

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
function startReload() {
  const spec = WEAPONS[player.weapon];
  if (spec.melee) return;
  const a = ammoFor(player.weapon);
  if (player.inCar || player.reloading > 0 || player.mag === spec.magSize || a.reserve <= 0) return;
  player.reloading = spec.reload;
  audio.play('click', { vol: 0.5, rate: 0.8 });
}

function finishReload() {
  const spec = WEAPONS[player.weapon];
  const a = ammoFor(player.weapon);
  const need = spec.magSize - player.mag;
  const take = Math.min(need, a.reserve);
  a.reserve -= take;
  player.mag += take;
  a.mag = player.mag;
  hud.setWeapon(spec.name, spec.slot, a.reserve, spec.id);
}

function ammoFor(id: WeaponId) {
  if (!player.ammo[id]) player.ammo[id] = { mag: WEAPONS[id].magSize, reserve: WEAPONS[id].reserve };
  return player.ammo[id];
}

let heldModel: THREE.Object3D | null = null;
function equipWeapon(id: WeaponId) {
  const spec = WEAPONS[id];
  if (heldModel) {
    character.armR.remove(heldModel);
    heldModel = null;
  }
  player.weapon = id;
  const a = ammoFor(id);
  player.mag = a.mag;
  player.magSize = spec.magSize;
  player.reloading = 0;
  player.shootCd = 0;
  const model = buildWeaponModel(id);
  model.position.set(...spec.heldPose.position);
  model.rotation.set(...spec.heldPose.rotation);
  character.armR.add(model);
  heldModel = model;
  character.gun.visible = false;
  hud.setWeapon(spec.name, spec.slot, a.reserve, spec.id);
  hud.setAmmo(player.mag, spec.magSize, false);
  audio.play('click', { vol: 0.35 });
}

function switchSlot(delta: number) {
  const i = WEAPON_ORDER.indexOf(player.weapon);
  const next = WEAPON_ORDER[(i + delta + WEAPON_ORDER.length) % WEAPON_ORDER.length];
  equipWeapon(next);
}

function firePelletRaw(spreadDeg = 0, dmg = 11, range = 110) {
  const origin = camera.position.clone();
  const dir = camera.getWorldDirection(new THREE.Vector3()).normalize();
  if (spreadDeg > 0) {
    // cone: rotate the shot direction by a random angle inside the half-angle
    const a = (rand(-1, 1) * spreadDeg * Math.PI) / 180;
    const b = (rand(-1, 1) * spreadDeg * Math.PI) / 180;
    const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();
    dir.addScaledVector(right, Math.tan(a)).addScaledVector(up, Math.tan(b)).normalize();
  }
  // every pellet leaves from the same barrel tip the flash sits on
  const muzzle = muzzlePos();
  // A third-person shot is aimed down the camera ray, and the camera sits 1.4-5.8 m BEHIND the man
  // pulling the trigger, so the near end of that ray is not the muzzle: everything nearer than his
  // own chest is behind the shot. That boundary used to be the fixed `MIN_T = 2.2`, which is how a
  // round aimed at a body standing on the barrel skipped him (his sphere started 1.4 m from the
  // camera) and flew on into the wall 1.9 m behind. It is measured from the shooter instead, and
  // applies once to the wall and to every actor: a panel the camera boom has been pushed into no
  // longer answers `bestDist = 0` and eats the round, and a body walking behind the player is
  // still not in the line of fire because his CENTRE sits behind the same plane.
  const nearDist = Math.max(
    0,
    _shotNear.set(player.pos.x, player.y + CHEST_Y, player.pos.z).sub(origin).dot(dir) - 0.15
  );
  const wallHit = rayVsColliders(origin, dir, range, city.colliders, nearDist);
  let bestDist = wallHit ? wallHit.dist : range;
  let hitPoint = origin.clone().addScaledVector(dir, bestDist);
  let hitKind = wallHit ? 'wall' : null;

  // pedestrians
  let hitPed = null;
  for (const ped of peds.peds) {
    if (ped.dead) continue;
    const center = new THREE.Vector3(ped.pos.x, ped.pos.y + 1.0, ped.pos.z);
    const t = raySphere(origin, dir, center, 0.75, nearDist);
    if (t !== null && t < bestDist) {
      bestDist = t;
      // a body hugged by the player reaches its sphere nearer than his chest plane; the impact
      // belongs on that plane, never behind the camera
      hitPoint = origin.clone().addScaledVector(dir, Math.max(t, nearDist));
      hitKind = 'ped';
      hitPed = ped;
    }
  }

  // officers on foot
  let hitOfficer = null;
  const copHit = police.raycastOfficer(origin, dir, bestDist, nearDist);
  if (copHit) {
    bestDist = copHit.dist;
    hitPoint = origin.clone().addScaledVector(dir, copHit.dist);
    hitKind = 'cop';
    hitOfficer = copHit.officer;
  }

  // vehicles
  let hitCar = null;
  const carsAll = allCars();
  for (const c of carsAll) {
    const center = new THREE.Vector3(c.pos.x, c.y + 0.9, c.pos.z);
    const t = raySphere(origin, dir, center, 1.6, nearDist);
    if (t !== null && t < bestDist) {
      bestDist = t;
      // a body hugged by the player reaches its sphere nearer than his chest plane; the impact
      // belongs on that plane, never behind the camera
      hitPoint = origin.clone().addScaledVector(dir, Math.max(t, nearDist));
      hitKind = 'car';
      hitCar = c;
    }
  }

  if (hitKind === 'cop' && hitOfficer) {
    const v = dir.clone().multiplyScalar(10);
    v.y = Math.max(2.2, v.y + 3.4);
    const pos = hitOfficer.pos.clone();
    police.killOfficer(hitOfficer);
    ragdolls.push(new Ragdoll(scene, {
      position: pos,
      yaw: hitOfficer.yaw,
      skin: 0xd8a273,
      shirt: 0x22304f,
      pants: 0x14161c,
      velocity: v,
      colliders: city.colliders,
      maxLife: 11,
      groundAt: (x: number, z: number) => city.groundHeightAt(x, z),
    }));
    shotFx.impact(hitPoint, dir, 'flesh');
    hud.hitmarker();
    addCash(25);
    police.addWanted(1);
    audio.play('bodyfall', { vol: 0.5 });
    flags.chaos = true;
  } else if (hitKind === 'ped') {
    const v = dir.clone().multiplyScalar(11);
    v.y = Math.max(2.5, v.y + 4);
    shotFx.impact(hitPoint, dir, 'flesh');
    ragdollPed(hitPed, v);
    hud.hitmarker();
    addCash(8 + dmg);
    police.addWanted(0.8);
    flags.chaos = true;
  } else if (hitKind === 'car') {
    hitCar.applyDamage(dmg);
    shotFx.impact(hitPoint, dir, 'metal');
    hud.hitmarker();
    police.addWanted(0.35);
    if (hitCar.wrecked) {
      explode(hitCar);
    }
  } else if (hitKind === 'wall') {
    shotFx.impact(hitPoint, dir, 'concrete');
    audio.play('metal', { vol: 0.16, rate: 1.4 });
  }

  // the street reacts: everyone within earshot runs, the nearest bystander fetches the cops
  peds.onGunshot(player.pos.x, player.pos.z, hitKind === 'ped');

  shotFx.tracer(muzzle, hitPoint);
  window.__lastShot = {
    origin: origin.toArray().map((v) => +v.toFixed(2)),
    dir: dir.toArray().map((v) => +v.toFixed(3)),
    bestDist: +bestDist.toFixed(2),
    hitKind,
    hitPoint: hitPoint.toArray().map((v) => +v.toFixed(2)),
    camPitch: +camPitch.toFixed(3),
  };
  if (player.mag === 0) startReload();
}

/**
 * Barrel tip of the equipped weapon in world space: the model's own muzzle offset pushed through
 * the arm chain (`muzzleAnchor`), in the BODY's frame. The old version aimed a fixed 0.75 m
 * ahead of the camera, so the flash was welded to the lens and 0.5 m behind the AK's barrel.
 * Writes into one scratch vector: firing may not allocate.
 */
function muzzlePos(): THREE.Vector3 {
  const anchor = muzzleAnchor(player.weapon);
  const s = Math.sin(player.yaw);
  const c = Math.cos(player.yaw);
  return muzzleScratch.set(
    player.pos.x + c * anchor.right + s * anchor.forward,
    player.y + anchor.up,
    player.pos.z - s * anchor.right + c * anchor.forward
  );
}


/** One trigger pull: spends a round (or swings), then fires every pellet of the weapon. */
function shoot() {
  if (player.inCar || player.reloading > 0 || player.shootCd > 0) return;
  const spec = WEAPONS[player.weapon];
  if (spec.melee) {
    punch();
    player.shootCd = 60 / spec.rpm;
    return;
  }
  if (player.mag <= 0) {
    startReload();
    return;
  }
  player.mag--;
  ammoFor(player.weapon).mag = player.mag;
  player.aimHold = 1.4; // keep the weapon up between shots
  player.shootCd = 60 / spec.rpm;
  audio.play(spec.sound, { vol: spec.soundVol, rate: spec.soundRate * rand(0.96, 1.04), pan: rand(-0.2, 0.2) });
  camPitch = clamp(camPitch - spec.recoil, PITCH_UP, PITCH_DOWN);
  setShake(spec.shake, 0.1);
  // 60 ms flash at the barrel tip, thrown down the body's forward axis
  shotFx.flash(muzzlePos(), spec.flashScale, Math.sin(player.yaw), Math.cos(player.yaw));
  (window as any).__lastMuzzleAt = performance.now();
  for (let i = 0; i < spec.pellets; i++) firePelletRaw(spec.spread, spec.damage, spec.range);
  hud.setWeapon(spec.name, spec.slot, ammoFor(player.weapon).reserve, spec.id);
  hud.setAmmo(player.mag, spec.magSize, false);
}

/**
 * Entry distance of a sphere along a ray, or null. `minCenterT` is how far down the ray the
 * shooter's own chest sits: a body whose CENTRE is behind that plane is behind the shot (a
 * pedestrian walking behind the player), while a body standing on the barrel has its centre level
 * with the chest plane and is point-blank. Testing the centre rather than the sphere's entry is
 * what keeps those two apart, because a body hugged by the player reaches its sphere a metre
 * nearer than the camera even when it is in front of the gun.
 */
function raySphere(origin: any, dir: any, center: any, radius: number, minCenterT = 0) {
  const ox = center.x - origin.x;
  const oy = center.y - origin.y;
  const oz = center.z - origin.z;
  const tca = ox * dir.x + oy * dir.y + oz * dir.z;
  if (tca < minCenterT) return null;
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
    groundAt: (x: number, z: number) => city.groundHeightAt(x, z),
  });
  ragdolls.push(r);
}

function explode(car: any) {
  audio.play('explosion', { vol: 0.8, rate: rand(0.9, 1.1) });
  for (let i = 0; i < 8; i++) {
    const p = new THREE.Vector3(car.pos.x + rand(-1.5, 1.5), car.y + rand(0.4, 2.2), car.pos.z + rand(-1.5, 1.5));
    shotFx.spark(p, pick([0xffa030, 0xff5a20, 0xffd070]), 6, 0.13);
  }
  if (car === player.inCar) {
    if (player.inCar) player.inCar.setDriverVisible(true);
    if (player.inCar) player.inCar.setDriverVisible(true);
  player.inCar = null;
    character.group.visible = true;
    hurt(45);
    hud.toast('Your car blew up', 'bad');
  }
  car.wrecked = true;
  car.speed = 0;
  setShake(0.28, 0.25);
}

// ---------------------------------------------------------------- damage & money
/** No hit lands while the death card is up: a cop still shooting at the corpse must not
 *  re-trigger the sequence, and the health bar during the card is the card's to own. */
function hurt(n: number) {
  if (dying) return;
  player.hp -= n;
  player.lastHit = performance.now();
  hud.damageFlash();
  setShake(0.12, 0.2);
  if (player.hp <= 0) wasted();
}

function addCash(n: number) {
  player.cash += n;
}

/**
 * The death card: one 2.9 s clock, authored in index.html as four keyframe tracks that share
 * one duration (the frame loses its colour, WASTED arrives on a slow scale, a hairline rule
 * wipes under it, then black). The respawn happens under the black at 2.61 s and the black
 * lifts by itself by 2.9 s, so the player is already standing at the spawn when the picture
 * comes back. The bill is charged at the hit, not at the reveal: the card is the whole event.
 *
 * `_test.wastedSeek(ms)` parks this same clock on one millisecond for a capture, which is the
 * only way to read a 4 fps SwiftShader frame at "0.3 s after death" and mean it.
 */
const DEATH_CARD_MS = 2900;
const DEATH_RESPAWN_MS = 2610;
let deathRespawnTimer = 0;
let deathRevealTimer = 0;
/** the health a parked capture found, handed back when the card is cleared */
let parkedHp = -1;
const deathCard = document.getElementById('wasted-screen') as HTMLElement;

function respawnAfterDeath() {
  player.hp = 100;
  // the body is teleported to the street, so the room reference has to go with it: a shop that
  // is 600 m away must not keep owning the colliders and the ped/traffic/police update gates
  resetInterior();
  player.pos.copy(city.getSpawn());
  player.vel.set(0, 0, 0);
  player.y = 0;
  if (player.inCar) player.inCar.setDriverVisible(true);
  player.inCar = null;
  character.group.visible = true;
  police.clearWanted();
  police.clearAll();
  hud.setHealth(100);
}

function wasted() {
  if (dying) return; // one card per death, never two stacked
  dying = true;
  player.hp = 0; // the health bar reads the truth while the card is up
  player.vel.set(0, 0, 0);
  player.cash = Math.max(0, player.cash - 100);
  hud.setHealth(0);
  deathCard.classList.add('on');
  document.body.classList.add('wasted');
  audio.play('bodyfall', { vol: 0.6 });
  setShake(0.3, 0.25);
  deathRespawnTimer = window.setTimeout(respawnAfterDeath, DEATH_RESPAWN_MS);
  deathRevealTimer = window.setTimeout(() => {
    dying = false;
    deathCard.classList.remove('on');
    document.body.classList.remove('wasted');
    hud.toast('WASTED — $100 hospital bill', 'bad', 2600);
  }, DEATH_CARD_MS);
}

function busted() {
  const fine = Math.min(player.cash, 300);
  player.cash -= fine;
  if (player.inCar) player.inCar.setDriverVisible(true);
  player.inCar = null;
  character.group.visible = true;
  resetInterior(); // the same teleport-out rule as the death card
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

// ---------------------------------------------------------------- save / load
function formatAgo(ts: number) {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  return `${Math.round(secs / 3600)} h ago`;
}

/** Snapshot everything that survives a refresh. No scene objects, no timers. */
function captureSave(): Omit<SaveData, 'version' | 'savedAt'> {
  // inside a shop the logical position is the room's, not the street's: save the
  // door-side anchor so a reload puts the player back on the pavement
  const inShop = !!player.inInterior && !!player.savedPos;
  const anchor = inShop ? player.savedPos! : player.pos;
  return {
    player: {
      x: anchor.x,
      y: inShop ? 0 : player.y,
      z: anchor.z,
      yaw: player.yaw,
      camYaw: inShop && player.savedCamYaw !== undefined ? player.savedCamYaw : camYaw,
      camPitch,
    },
    cash: player.cash,
    hp: player.hp,
    wanted: police.wanted,
    dayT,
    // this build has one gun: the pistol is the whole roster, saved by name so a
    // later weapon system can extend the field without a schema bump
    weapon: 'pistol',
    ammo: player.mag,
    magSize: player.magSize,
    ownedWeapons: ['pistol'],
    objectives: {
      drove: flags.drove,
      chaos: flags.chaos,
      stars: flags.stars,
      escape: flags.escape,
      chaosRewarded: !!flags.chaosRewarded,
    },
  };
}

/** Autosave on the 20 s beat and on every pause; silently does nothing before the start. */
function saveGame() {
  if (!started) return;
  writeSave(captureSave());
}

function applySave(data: SaveData) {
  const { x, z } = data.player;
  player.pos.set(x, 0, z);
  player.y = city.groundHeightAt(x, z);
  player.vy = 0;
  player.vel.set(0, 0, 0);
  player.grounded = true;
  player.yaw = data.player.yaw;
  if (player.inCar) player.inCar.setDriverVisible(true);
  player.inCar = null;
  resetInterior(); // a save made inside a shop stores the street anchor, never the room
  player.hp = clamp(data.hp, 1, 100);
  player.cash = data.cash;
  player.mag = clamp(data.ammo, 0, data.magSize);
  player.magSize = data.magSize;
  player.reloading = 0;
  player.lastHit = performance.now() - 60000; // a restored wound should still regen
  camYaw = data.player.camYaw;
  camPitch = data.player.camPitch;
  dayT = data.dayT;
  police.wanted = clamp(data.wanted, 0, 5);
  // a restored chase must not cool down on the first frame: give it the same
  // grace window a fresh crime gets
  police.crimeCooldown = data.wanted > 0 ? 26 : 0;
  flags.drove = data.objectives.drove;
  flags.chaos = data.objectives.chaos;
  flags.stars = data.objectives.stars;
  flags.escape = data.objectives.escape;
  flags.chaosRewarded = data.objectives.chaosRewarded;
  character.group.visible = true;
  character.group.position.copy(player.pos);
  character.group.rotation.y = player.yaw;
  hud.setCash(player.cash);
  hud.setHealth(player.hp);
  hud.setStars(police.starCount);
  hud.setAmmo(player.mag, player.magSize, false);
  hud.setObjective(objectiveText());
  hud.setPrompt('');
}

// ---------------------------------------------------------------- clean restart
function resetCar(car: any, spot?: { pos: THREE.Vector3; yaw: number }) {
  if (spot) {
    car.pos.copy(spot.pos);
    car.yaw = spot.yaw;
  }
  car.speed = 0;
  car.steer = 0;
  // park on the ground the car is standing on, not on the old y = 0 plane
  car.y = city.groundHeightAt(car.pos.x, car.pos.z);
  car.vy = 0;
  car.roll = 0;
  car.pitch = 0;
  car.health = 100;
  car.wrecked = false;
  car.honk = 0;
  car.aiPaused = false;
  car.brakeLight = false;
  car.mesh.position.set(car.pos.x, 0, car.pos.z);
  car.mesh.rotation.y = car.yaw;
}

/**
 * Revive and re-place the existing crowd instead of building a new one: a restart
 * must not grow the scene graph. A ped killed earlier had its group removed, so it
 * is re-added once and only once.
 */
function resetPeds() {
  for (const ped of peds.peds) {
    if (ped.char.group.parent !== scene) scene.add(ped.char.group);
    ped.dead = false;
    ped.state = 'walk';
    ped.speed = rand(1.2, 1.9);
    // the pavement network, not the old block-ring lattice: a restored crowd must not be
    // dropped inside a shopfront (that was the source of the "ped inside a building" count)
    const spot = peds.pavementPointNear(player.pos.x, player.pos.z, 14, 48) || peds.pavementPointNear(player.pos.x, player.pos.z, 8, 110);
    if (spot) ped.placeAt(spot.x, spot.z);
    else ped.repath();
    ped.yaw = rand(0, Math.PI * 2);
    ped.char.group.visible = true;
    ped.char.group.position.copy(ped.pos);
    ped.char.group.rotation.y = ped.yaw;
  }
}

/** Drop every transient effect (tracers, sparks, muzzle flashes, ragdolls). */
function resetFx() {
  shotFx.reset();
  for (const r of ragdolls) r.dispose();
  ragdolls.length = 0;
}

/**
 * New game in place: player, economy, wanted level, peds, pickups, traffic, time
 * and effects all go back to their boot values without a page reload. Existing
 * objects are reused, so `scene.children` is stable across restarts.
 */
function newGame() {
  pendingSave = null;
  clearSave();

  player.pos.copy(city.getSpawn());
  player.y = 0;
  player.vy = 0;
  player.vel.set(0, 0, 0);
  player.yaw = 0;
  player.hp = 100;
  player.cash = 250;
  player.mag = 12;
  player.magSize = 12;
  player.reloading = 0;
  player.shootCd = 0;
  player.rhythm = 0;
  player.grounded = true;
  player.lastHit = 0;
  if (player.inCar) player.inCar.setDriverVisible(true);
  player.inCar = null;
  resetInterior();

  camYaw = Math.PI * 0.25;
  camPitch = 0.1;
  camDist = 5.8;
  camDistActual = 5.8;
  autoAlignTimer = 0;
  dayT = 0.34;
  simTime = 0;
  lastAutosaveAt = performance.now();

  flags.drove = false;
  flags.chaos = false;
  flags.stars = false;
  flags.escape = false;
  flags.chaosRewarded = false;

  character.group.visible = true;
  character.group.position.copy(player.pos);
  character.group.rotation.y = 0;
  // a restart from inside a shop must not leave the room shell standing in the world
  for (const room of city.interiors) room.group.visible = false;

  police.clearWanted();
  police.clearAll();
  resetFx();
  resetPeds();

  for (const p of pickups) {
    p.pos.copy(city.randomSidewalkPoint());
    p.mesh.position.set(p.pos.x, 1.05, p.pos.z);
    p.mesh.visible = true;
    p.active = true;
    p.timer = 0;
  }

  for (const car of cityCars) resetCar(car, city.randomParkingSpot());
  for (const entry of traffic.cars) {
    const i = Math.floor(rand(-2, 3));
    const j = Math.floor(rand(-2, 3));
    const heading = pick([
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]);
    entry.cell = { i, j };
    entry.heading = heading;
    entry.wait = 0;
    entry.honked = 0;
    resetCar(entry.car, {
      pos: new THREE.Vector3((i + 0.5) * PITCH, 0, (j + 0.5) * PITCH),
      yaw: Math.atan2(heading[0], heading[1]),
    });
  }

  // the headlight rig rides on whichever car was driven: park it back on the scene
  if (headlightAttached) {
    headlightAttached.mesh.remove(headlight);
    headlightAttached.mesh.remove(headlight.target);
    scene.add(headlight);
    scene.add(headlight.target);
    headlightAttached = null;
  }
  audio.engineUpdate({ on: false });

  hud.setCash(player.cash);
  hud.setHealth(player.hp);
  hud.setStars(0);
  hud.setAmmo(player.mag, player.magSize, false);
  hud.setObjective(objectiveText());
  hud.setPrompt('');
  hud.showPause(false);
  hud.showStart(false);
  // a restarted run starts its own save immediately, so a reload right after
  // "New game" continues the new run instead of the one that was wiped
  saveGame();
}

// ---------------------------------------------------------------- map + settings overlays
let mapWasPaused = true;
let settingsWasPaused = true;

/** Roads as the minimap needs them: computed once, not per frame. */
const MINIMAP_ROADS = [
  ...JakartaMap.ARTERIALS.map((a) => ({ path: a.path, width: a.width })),
  { path: JakartaMap.RING_ROAD, width: 20 },
];

function mapState() {
  return {
    blocks: city.blocks,
    roadLines: city.roadLines,
    mapRoads: [...JakartaMap.ARTERIALS.map((a) => ({ path: a.path, width: a.width })), { path: JakartaMap.RING_ROAD, width: 20 }],
    shoreZ: JakartaMap.SHORE_Z,
    shops: city.shopDoors,
    police: police.cars,
    cars: [...cityCars, ...traffic.cars.map((e) => e.car)],
    playerCar: player.inCar,
    playerPos: player.pos,
    playerYaw: player.inCar ? player.inCar.yaw : player.yaw,
  };
}

/** Full-screen map. Opening it freezes the sim without showing the pause card. */
function toggleMap(force?: boolean) {
  const open = force === undefined ? !hud.mapOpen : !!force;
  if (open && !started) return;
  if (open === hud.mapOpen) return;
  hud.showMap(open);
  // the phone's MAP chip is the only way back out: it has to stay lit and pressable
  touch.setMapOpen(open);
  if (open) {
    mapWasPaused = paused;
    paused = true;
    // the map owns the screen: the pause card would sit on top of it
    hud.showPause(false);
    if (document.pointerLockElement) document.exitPointerLock?.();
    hud.drawFullMap(mapState());
    saveGame();
  } else {
    paused = mapWasPaused;
    if (!paused) {
      suppressFireUntil = performance.now() + 250;
      lockPointer();
    } else if (started) {
      hud.showPause(true);
    }
  }
}

function toggleSettings(force?: boolean) {
  const open = force === undefined ? !hud.settingsOpen : !!force;
  if (open === hud.settingsOpen) return;
  hud.showSettings(open);
  if (open) {
    settingsWasPaused = paused;
    paused = true;
    if (document.pointerLockElement) document.exitPointerLock?.();
    hud.syncSettings(settings);
  } else {
    paused = settingsWasPaused;
    if (started && !paused) {
      suppressFireUntil = performance.now() + 250;
      lockPointer();
    }
  }
}

// ---------------------------------------------------------------- startup
async function startGame(continueRun: boolean) {
  hud.el.startBtn!.disabled = true;
  hud.setLoading('loading audio…');
  try {
    await audio.init();
  } catch (e) {
    console.warn('audio init failed', e);
  }
  // the settings were read before the AudioContext existed, so re-apply them now
  audio.setVolumes({ master: settings.master, sfx: settings.sfx, bgm: settings.bgm });
  audio.resume();
  audio.startBgm('funk');
  hud.setLoading('');
  if (continueRun && pendingSave) {
    applySave(pendingSave);
    pendingSave = null;
    hud.setSaveStatus('');
  }
  started = true;
  paused = false;
  suppressFireUntil = performance.now() + 200;
  lastAutosaveAt = performance.now(); // first beat lands 20 s into the run, not 20 s after boot
  hud.showStart(false);
  hud.showPause(false);
  hud.showSettings(false);
  hud.showMap(false);
  lockPointer();
  hud.toast(continueRun ? 'Welcome back to the city' : 'Welcome to the city', 'good');
  saveGame();
}

hud.el.startBtn!.textContent = pendingSave ? 'Continue' : 'Start chaos';
hud.setSaveStatus(pendingSave ? `save found · ${formatAgo(pendingSave.savedAt)}` : 'no save yet');

hud.el.startBtn!.addEventListener('click', () => startGame(!!pendingSave));

// New game on the start screen and in the pause card: one reset, no page reload.
hud.el.newGame?.addEventListener('click', (e: Event) => {
  e.stopPropagation();
  newGame();
  startGame(false);
});
hud.el.pauseNewGame?.addEventListener('click', (e: Event) => {
  e.stopPropagation();
  newGame();
  if (!started) return;
  paused = false;
  suppressFireUntil = performance.now() + 250;
  lockPointer();
});

for (const btn of [hud.el.settingsBtn, hud.el.pauseSettings]) {
  btn?.addEventListener('click', (e: Event) => {
    e.stopPropagation();
    toggleSettings(true);
  });
}
hud.el.settingsClose?.addEventListener('click', () => toggleSettings(false));

// every slider edit is applied live and persisted, so the next boot matches
hud.bindSettings(settings, () => {
  applySettings();
  writeSettings(settings);
});
applySettings();

function resumeGame() {
  if (!paused) return;
  paused = false;
  hud.showPause(false);
  suppressLockPauseUntil = performance.now() + 600;
  suppressFireUntil = performance.now() + 250;
  lockPointer();
}

document.getElementById('pause-screen')!.addEventListener('click', resumeGame);
document.addEventListener('pointerdown', (e: Event) => {
  // an overlay owns the pointer while it is up: never resume the sim behind the map
  // or the settings sheet, and never swallow a click aimed at an overlay button
  if (!paused || !started || hud.settingsOpen || hud.mapOpen) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest?.('button, input, label, #settings-sheet')) return;
  resumeGame();
});
document.getElementById('resume-btn')?.addEventListener('click', resumeGame);

window.addEventListener('resize', () => {
  hud.scheduleLayout();
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  hud.layout();
});

// shooting trigger (held fire, semi-auto cadence)
function updateCombat(dt: number) {
  player.shootCd = Math.max(0, player.shootCd - dt);
  player.aimHold = Math.max(0, player.aimHold - dt);
  if (player.reloading > 0) {
    player.reloading -= dt;
    if (player.reloading <= 0) {
      finishReload();
      audio.play('click', { vol: 0.45, rate: 1.2 });
    }
  }
  // mouse no longer needs pointer lock (headless/iframe contexts refuse it); the touch
  // FIRE button drives the same path so both inputs share one gate
  const spec = WEAPONS[player.weapon];
  const trigger = mouse.left || (touch.state.active && touch.state.fire);
  // semi-auto weapons need a fresh click; the automatics keep firing while held
  if (trigger && canShootNow() && (spec.auto || spec.melee || !mouse.firedSinceDown)) {
    shoot();
    mouse.firedSinceDown = true;
  }
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
    // you can pick cash up from the driver's seat too: a 1.7 m radius only works on foot, and a
    // car is 4 m long, so driving over a pickup did nothing
    const reach = player.inCar ? 3.8 : 1.7;
    if (d < reach && player.y < 60) {
      p.active = false;
      p.mesh.visible = false;
      p.timer = 22;
      addCash(150);
      audio.play('cash', { vol: 0.5 });
      hud.toast('+$150 pickup', 'cash', 1800);
    }
  }
}

// ---------------------------------------------------------------- cops shoot the player
function copShoot(pos: any, dmg: any) {
  audio.play('shot_rifle', { vol: clamp(0.5 - pos.distanceTo(player.pos) / 90, 0.12, 0.45), rate: 1.1 });
  tracerFrom.copy(pos).setY(pos.y + 1.4);
  tracerTo.set(player.pos.x, player.y + 1.1, player.pos.z);
  shotFx.tracer(tracerFrom, tracerTo);
  hurt(dmg);
}

// ---------------------------------------------------------------- main loop
const clock = new THREE.Clock();
let simTime = 0; // accumulated game time, immune to frame-rate dips
let lastAutosaveAt = performance.now(); // wall clock: a 12 fps host must still autosave every 20 s
let fpsAcc = 0;
let fpsFrames = 0;
let slowWindows = 0;
let fastWindows = 0;

/**
 * One contract for every car on the map, including the ones whose physics is parked while they
 * are far away: a wheel may not sit more than 18 cm off the ground under it. Without this a car
 * left over a hill kept its old height when the terrain under it changed, which the audit read
 * as 32 m in the air.
 */
function settleCars() {
  for (const c of allCars()) {
    const floor = city.groundHeightAt(c.pos.x, c.pos.z);
    if (Math.abs(c.y - floor) > 0.18) {
      c.y = floor;
      c.vy = 0;
      c.pos.y = floor;
    }
  }
}

function update(dt: number) {
  simTime += dt;
  for (const c of allCars()) {
    c.groundAt = (x: number, z: number) => city.groundHeightAt(x, z);
    // One contract for every car on the map, including the ones whose physics is parked while
    // they are far away: a wheel may not sit more than half a metre off the ground under it.
    // Without this a car left over a hill stayed at its old height when the terrain under it
    // changed, which the audit read as 32 m in the air.
    const floor = city.groundHeightAt(c.pos.x, c.pos.z);
    if (Math.abs(c.y - floor) > 0.6) {
      c.y = floor;
      c.vy = 0;
      c.pos.y = floor;
    }
  }
  city.updateCulling(player.pos.x, player.pos.z);
  // wall-clock beat, not accumulated dt: dt is clamped to 50 ms, so a slow host
  // would otherwise stretch "every 20 s" to half a minute of real time
  if (performance.now() - lastAutosaveAt >= AUTOSAVE_SECONDS * 1000) {
    lastAutosaveAt = performance.now();
    saveGame();
  }
  dayT = (dayT + dt / 300) % 1;
  city.update(dt, dayT);

  // slow health regen once you have been out of trouble for a while
  const sinceHit = (performance.now() - (player.lastHit ?? 0)) / 1000;
  if (player.hp > 0 && player.hp < 100 && sinceHit > 8) {
    player.hp = Math.min(100, player.hp + 2.2 * dt);
  }

  // the death card owns the player: no control, no fire, no driving until it lifts
  if (!dying) {
    updateCombat(dt);

    if (player.inCar) updateDriving(dt);
    else updateOnFoot(dt);
  }

  if (!player.inInterior) peds.update(dt, pedContext());

  if (!player.inInterior) traffic.update(dt, { playerPos: player.pos, playerCar: player.inCar, peds, wanted: police.wanted });

  if (!player.inInterior) police.update(dt, {
    playerPos: player.pos,
    onFoot: !player.inCar,
    onArrest: busted,
    onCopShoot: copShoot,
    onCopFire: (from: any, to: any) => {
      shotFx.tracer(tracerFrom.copy(from).setY(from.y + 1.3), tracerTo.copy(to).setY(to.y + 1.1));
      audio.play('shot_pistol', { vol: 0.32, pan: 0 });
    },
    camYaw,
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
  shotFx.update(dt);

  // sun shadow + street lights follow the action
  const focus = player.inCar ? player.inCar.pos : player.pos;
  city.focusTarget = focus;
  city.updateNightLights(dayT, focus);
  city.sun.target.position.set(focus.x, 0, focus.z);
  city.sun.position.set(focus.x + 60, city.sun.position.y, focus.z + 42);

  // after every system has moved, no wheel may hover over or sink into the ground under it
  settleCars();

  updateCamera(dt);
  hud.setCash(player.cash);
  hud.setHealth(player.hp);
  hud.setStars(police.starCount);
  hud.setAmmo(player.mag, player.magSize, player.reloading > 0);
  hud.setCrosshair(!player.inCar);
  hud.setObjective(objectiveText());

  if (player.inCar) {
    const kmh = Math.abs(player.inCar.speed) * 3.6;
    hud.setSpeed(kmh, true);
  } else {
    hud.setSpeed(0, false);
  }

  // prompts: name the control the player actually has. A phone has no E or F key,
  // so the chip prints the on-screen button the action is bound to instead.
  const keyed = (kb: string, onTouch: string) => (touch.state.active ? onTouch : kb);
  if (player.inInterior) {
    const nearExit = player.pos.distanceTo(new THREE.Vector3(
      player.inInterior.origin.x + player.inInterior.exit.x,
      0,
      player.inInterior.origin.z + player.inInterior.exit.z
    )) < 3.2;
    hud.setPrompt(
      nearExit
        ? keyed('E — keluar toko', 'tap USE — keluar toko')
        : keyed('E — keluar toko (dekat pintu)', 'tap USE — keluar toko (dekat pintu)')
    );
  } else if (player.inCar) {
    hud.setPrompt(keyed('F — exit vehicle', 'tap CAR — exit vehicle'));
  } else if (nearestShopDoor() && !player.inCar) {
    const door = nearestShopDoor()!;
    hud.setPrompt(keyed(`E — masuk ${door.name}`, `tap USE — masuk ${door.name}`));
  } else {
    const near = nearestCar(4.6);
    hud.setPrompt(
      near
        ? near.car.isPolice
          ? keyed('F — steal police cruiser', 'tap CAR — steal police cruiser')
          : keyed('F — enter vehicle', 'tap CAR — enter vehicle')
        : ''
    );
  }

  // music state: chase track while wanted
  audio.startBgm(police.starCount > 0 ? 'chase' : 'funk');
  audio.setBgmIntensity(police.wanted / 5);

  hud.drawMinimap({
    blocks: city.blocks,
    roadLines: city.roadLines,
    mapRoads: MINIMAP_ROADS,
    peds: peds.peds,
    police: police.cars,
    cars: [...cityCars, ...traffic.cars.map((e) => e.car)],
    playerCar: player.inCar,
    pickups,
    playerPos: player.pos,
    playerYaw: player.inCar ? player.inCar.yaw : player.yaw,
  });
}


/**
 * requestAnimationFrame is tied to the display's refresh, so on a 60 Hz panel the game can
 * never exceed 60 fps. The optional uncapped mode drives the same loop from a timer instead,
 * which trades vsync (and the odd tear) for as many frames as the GPU can push.
 */
function scheduleFrame() {
  if (uncappedLoop) setTimeout(animate, 0);
  else requestAnimationFrame(animate);
}

/** test hook: park the loop so a capture tool can hold one frame (a 60 ms flash must not expire) */
let loopFrozen = false;

function animate() {
  if (loopFrozen) return;
  scheduleFrame();
  const rawDt = clock.getDelta();
  const dt = Math.min(0.05, rawDt);

  if (!paused) {
    update(dt);
  } else {
    // keep the scene alive while paused
    city.update(0, dayT);
    shotFx.update(dt);
    updateCamera(0.016);
  }

  renderer.render(scene, camera);
  // the map is a 2D overlay: redraw it while it is up so cruiser positions are live
  if (hud.mapOpen) hud.drawFullMap(mapState());

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
      } else if (fastWindows >= 8 && pixelRatio < maxPixelRatio()) {
        pixelRatio = Math.min(maxPixelRatio(), pixelRatio + 0.1);
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
hud.setAmmo(player.mag, player.magSize, false);
hud.setObjective(objectiveText());
// start with the pistol equipped so the HUD and the held model agree from frame one
equipWeapon(STARTING_WEAPONS.includes('pistol') ? 'pistol' : WEAPON_ORDER[0]);
hud.setPrompt('');
animate();

window.__game = {
  THREE,
  districtAt,
  jakartaMap: JakartaMap,
  jakartaStreets: JakartaStreets,
  terrainHeight,
  scene,
  camera,
  renderer,
  settings,
  saveGame,
  objectives: flags,
  player,
  equipWeapon,
  get weaponSpec() {
    return WEAPONS[player.weapon];
  },
  city,
  police,
  peds,
  cityCars,
  traffic,
  pickups,
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
      inCar: !!player.inCar,
      wanted: police.wanted,
      stars: police.starCount,
      pos: player.pos.toArray().map((v) => +v.toFixed(2)),
      ragdolls: ragdolls.length,
      copCars: police.cars.length,
      peds: peds.peds.length,
      fps: hud.el.fps.textContent,
      pixelRatio: +pixelRatio.toFixed(2),
      pixelCap: +maxPixelRatio().toFixed(2),
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
      fxCount: shotFx.stats().live,
      sceneChildren: scene.children.length,
      mapOpen: hud.mapOpen,
      settingsOpen: hud.settingsOpen,
      vel: +Math.hypot(player.vel.x, player.vel.z).toFixed(2),
      touch: { ...touch.state },
    };
  },
  _test: {
    newGame,
    save: saveGame,
    toggleMap,
    toggleSettings,
    toggleVehicle,
    shoot,
    punch,
    hurt,
    busted,
    wasted,
    /**
     * Park the death card on one millisecond and take the wall clock over, or `null` to clear
     * it. Every stage shares one 2.9 s duration, so seeking each track to the same currentTime
     * IS the frame at that millisecond — which is how a 4 fps SwiftShader run can be read at
     * 0.3 s and mean it. The card owns the health bar while it is parked, exactly as `wasted()`
     * owns it, and hands it back on `null`. Returns what it parked, for the capture's provenance.
     */
    wastedSeek(ms: number | null) {
      window.clearTimeout(deathRespawnTimer);
      window.clearTimeout(deathRevealTimer);
      if (ms === null) {
        dying = false;
        deathCard.classList.remove('on');
        document.body.classList.remove('wasted');
        if (parkedHp >= 0) {
          player.hp = parkedHp;
          hud.setHealth(player.hp);
          parkedHp = -1;
        }
        return null;
      }
      dying = true;
      if (parkedHp < 0) parkedHp = player.hp;
      player.hp = 0;
      hud.setHealth(0);
      deathCard.classList.add('on');
      document.body.classList.add('wasted');
      void deathCard.offsetWidth; // let the class land before the tracks are asked for
      const anims = [
        ...deathCard.getAnimations({ subtree: true }),
        ...canvas.getAnimations(),
        ...(document.getElementById('hud')?.getAnimations() ?? []),
      ];
      for (const a of anims) {
        a.pause();
        a.currentTime = ms;
      }
      return { ms, animations: anims.length };
    },
    addCash,
    startReload,
    face(x: number, z: number) {
      camYaw = Math.atan2(-(x - player.pos.x), -(z - player.pos.z));
    },
    teleport(x: number, z: number) {
      // carry a driven car along: the seated player is snapped back to the seat every frame, so
      // teleporting on foot only looked like it worked and then undid itself
      if (player.inCar) {
        player.inCar.pos.set(x, player.inCar.y, z);
        player.inCar.y = city.groundHeightAt(x, z);
        player.inCar.mesh.position.copy(player.inCar.pos);
      }
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
    pedContext,

    /**
     * The engine note as it actually stands: the graph, its live parameters, and the bodywork
     * the mix thinks is in the way. A probe reads this instead of reaching into AudioSys fields,
     * so a rename of the graph cannot make the probe pass by reading `undefined === undefined`.
     */
    audioState() {
      return {
        ...audio.engineState(),
        inCar: !!player.inCar,
        carType: player.inCar ? player.inCar.type : null,
        cabinClosed: player.inCar ? !!player.inCar.cabinClosed : null,
        inInterior: !!player.inInterior,
        muffle: engineMuffle(),
        kmh: player.inCar ? Math.round(player.inCar.kmh) : 0,
        rpm01: player.inCar ? +player.inCar.engineRpm01.toFixed(3) : 0,
      };
    },

    // ---- floating geometry audit: every actor and prop must touch the ground ----
    audit() {
      const report: { peds: any[]; cars: any[]; player: number | null; ragdolls: any[]; props: any[]; buildings: any[] } = { peds: [], cars: [], player: null, ragdolls: [], props: [], buildings: [] };

      for (const ped of peds.peds) {
        if (ped.dead) continue;
        // a walking dude lifts one foot; the planted foot is what must touch the ground
        const ground = city.groundHeightAt(ped.pos.x, ped.pos.z);
        const gap = soleY(ped.char) - ground;
        if (gap > 0.06 || gap < -0.05) report.peds.push({ gap: +gap.toFixed(3), pos: ped.pos.toArray().map((n: number) => +n.toFixed(1)) });
      }

      for (const car of allCars()) {
        // local wheel height vs the wheel radius, measured against the ground under the car:
        // with terrain, "y = 0" is no longer the floor, so the old absolute check flagged every
        // car that sat correctly on a slope
        const ground = city.groundHeightAt(car.pos.x, car.pos.z);
        const gap = car.wheels[0].pivot.position.y - car.wheelRadius + car.y - ground;
        // 35 cm, not 3 mm: the wheel pivot travels with the suspension and a car parked half on
        // a kerb reads a kerb height either way. The check is for a car in the air, which was
        // 32 m before the settle pass; everything left is under a wheel's own travel.
        if (Math.abs(gap) > 0.35) report.cars.push({ type: car.type, gap: +gap.toFixed(3), y: +car.y.toFixed(2) });
      }

      // lowest sole of the on-foot model vs the logical foot height: this is the
      // number that used to go negative when the planted shoe sank into the road
      report.player = +(soleY(character) - player.y).toFixed(3);

      for (const r of ragdolls) {
        let minY = Infinity;
        for (const pt of Object.values(r.points)) minY = Math.min(minY, pt.p.y - pt.r);
        if (minY > 0.12) report.ragdolls.push({ minY: +minY.toFixed(2) });
      }

      for (const item of city.propAudit || []) {
        // a prop seated on its contacts publishes where its lowest contact is (`bx`/`bz`), and the
        // gap belongs to that contact: a cart tyre 60 cm from the slot on a 12% grade reads as an
        // 8 cm "float" against the slot sample, while a tyre parked over the kerb reads as 26 cm
        const ground = city.groundHeightAt(item.bx ?? item.x, item.bz ?? item.z);
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
    shotFx() {
      return shotFx.stats();
    },
    /** one deterministic effect-only frame step, for harnesses that parked the loop */
    stepFx(dt: number) {
      shotFx.update(dt);
    },
    freezeLoop(on: boolean) {
      // resuming calls animate() directly: a frozen loop schedules nothing, so nothing else
      // would ever wake it up again
      if (on) loopFrozen = true;
      else if (loopFrozen) {
        loopFrozen = false;
        animate();
      }
    },
    fxReset() {
      shotFx.reset();
    },
    ragdollAt(x: number, y: number, z: number, vx = 0, vz = 0) {
      // spawn a body with velocity for visual QA of the ragdoll itself
      ragdolls.push(new Ragdoll(scene, {
        position: new THREE.Vector3(x, y, z),
        yaw: 0,
        velocity: new THREE.Vector3(vx, 2.2, vz),
        colliders: city.colliders,
        maxLife: 11,
        groundAt: (x: number, z: number) => city.groundHeightAt(x, z),
      }));
      return ragdolls.length;
    },
    lookFrom(px: any, py: any, pz: any, tx: any, ty: any, tz: any) {
      cinematic = true;
      camera.position.set(px, py, pz);
      camera.lookAt(tx, ty, tz);
    },
  },
};