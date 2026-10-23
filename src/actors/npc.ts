import { ARTERIALS, RING_ROAD } from '../world/jakartamap';
import { LOCAL_STREETS } from '../world/streets';
import * as THREE from 'three';
import { Character } from './character';
import { clamp, rand, angleDelta } from '../core/utils';

// ---------------------------------------------------------------- street metrics
// Pedestrians walk the *pavements of the streets the map actually draws*, not the old 380 m
// lattice. Those constants (PITCH/BLOCK/GRID at 52/38) no longer describe this world: the
// blocks moved onto a 112 m pitch inside district polygons, the map is 2.5 km across, and the
// nearest block to the player spawn is 128 m away - so a pedestrian anchored to a block corner
// is never on the street the player is standing on, and never reaches a crossing.
//
// A pavement lane runs parallel to every road at width/2 + PAVE (inside the kerb line), on both
// sides, split into legs between polyline points. A pedestrian walks one leg at a time and
// crosses another road only where a zebra band sits: the bands come from the junctions where
// two road polylines cross (PedManager.buildCrosswalkStrips), so every metre of asphalt a
// pedestrian walks is painted.
const PAVE = 1.5; // pavement lane offset from the kerb line
const STRIP_HALF = 1.7; // half the depth of a zebra band, along the road it crosses
const STRIP_PAD = 1.4; // the band overhangs the kerb a little, like the painted stripes do
const RADIUS = 0.4; // pedestrian body radius
const FLEE_RADIUS = 18; // a gunshot scares everyone this close
const SPREAD_RADIUS = 12; // a fleeing pedestrian passes panic on
const AIM_RADIUS = 14; // someone pointing a gun at you is enough
const DETAIL_LOD = 40; // nose/cuff/hand detail inside this range; face and hair never drop
const ANIM_LOD = 55; // stop animating limbs beyond this range
const HIDE_LOD = 110;
const CROSS_CHANCE = 0.45;
const CROSS_SPEED = 2.35; // brisk, but still a walk
const STREET_REACH = 10; // a car this close along the crossing line holds me at the kerb

// ---------------------------------------------------------------- vendors and customers
// A gerobak is nothing without the person behind it. One vendor per cart stands on the serving
// side, on the ground, facing the street; walkers on that pavement stop for 3-6 s beside it and
// walk on. The numbers are budgeted: two carts can serve a customer at once, and a pedestrian
// needs a cooldown before it queues again, so the crowd keeps moving.
const VENDOR_RINGS = [1.5, 1.7, 1.9, 2.1, 2.3, 2.5]; // distances off the cart centre to try
const VENDOR_ANGLES = 24; // spots sampled around each ring
const VENDOR_HOME = 0.45; // a vendor inside this radius of its post does not walk back
const VENDOR_RETURN_SNAP = 12; // further away than this and it is put back, not walked back
const CUSTOMER_RANGE = 3.2; // a walker this close to a staffed cart stops for food
const CUSTOMER_STOP_MIN = 3; // seconds at the counter
const CUSTOMER_STOP_MAX = 6;
const CUSTOMER_CAP = 2; // carts serving a customer at once: a queue, not a crowd
const CUSTOMER_COOLDOWN_MIN = 25; // seconds before the same pedestrian eats again
const CUSTOMER_COOLDOWN_MAX = 70;

const _footV = new THREE.Vector3();
const _scratch: any[] = [];

/** Where a cart's vendor stands: on the ground, beside the cart, facing the street. */
interface VendorPost {
  i: number;
  cart: string;
  cx: number;
  cz: number;
  x: number;
  z: number;
  yaw: number;
}

/**
 * Sit a pedestrian so its lowest sole touches `groundY` exactly. Same reason as
 * the player: footLift ignores the shoe's forward offset and tilt, so the
 * planted foot could dip a few millimetres under the pavement.
 */
function plantOnGround(ch: any, groundY: number) {
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

/** Drop points that sit on the straight line between their neighbours. */
function simplify(path: [number, number][]): [number, number][] {
  if (path.length < 3) return path.slice();
  const out: [number, number][] = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const a = out[out.length - 1];
    const b = path[i];
    const c = path[i + 1];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
    if (Math.abs(cross) / (ab + bc + 1e-6) < 0.05) continue; // < 3 degrees off the line
    out.push(b);
  }
  out.push(path[path.length - 1]);
  return out;
}

/** A straight run of pavement. `u` points from a to b, `len` is its length. */
interface Leg {
  i: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  len: number;
  ux: number;
  uz: number;
  road: number;
  side: number;
  prev: number;
  next: number;
  cross: number; // strip index of the zebra this leg walks over, -1 when it crosses nothing
  cf: number; // where the crossing starts, in metres along the leg
  ct: number; // and where the far kerb is
}

/** A painted zebra: a rectangle the length of a crossing, `hl` across and `hw` deep. */
interface Strip {
  cx: number;
  cz: number;
  ux: number; // travel direction (across the road being crossed)
  uz: number;
  hl: number; // half length along `u` (spans the carriageway)
  hw: number; // half depth, along the road being crossed
  len: number; // kerb to kerb
  road: number; // the road whose paint this is
}

// ---------------------------------------------------------------- collision index
// 34 pedestrians x ~200 colliders every frame is wasted work; the static city
// geometry is binned once and each pedestrian only tests its own 3x3 cells.
const CELL = 12;
const cellKey = (i: number, j: number) => (i + 512) * 1024 + (j + 512);

class ColliderGrid {
  declare cells: Map<number, any[]>;
  constructor(colliders: any[]) {
    this.cells = new Map();
    for (const c of colliders) {
      if ((c.h ?? 30) < 0.8) continue; // kerb-height clutter is stepped over, not avoided
      const i0 = Math.floor(c.minX / CELL);
      const i1 = Math.floor(c.maxX / CELL);
      const j0 = Math.floor(c.minZ / CELL);
      const j1 = Math.floor(c.maxZ / CELL);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const k = cellKey(i, j);
          let list = this.cells.get(k);
          if (!list) {
            list = [];
            this.cells.set(k, list);
          }
          list.push(c);
        }
      }
    }
  }

  near(x: number, z: number): any[] {
    _scratch.length = 0;
    const i = Math.floor(x / CELL);
    const j = Math.floor(z / CELL);
    for (let a = i - 1; a <= i + 1; a++) {
      for (let b = j - 1; b <= j + 1; b++) {
        const list = this.cells.get(cellKey(a, b));
        if (!list) continue;
        for (let n = 0; n < list.length; n++) {
          if (_scratch.indexOf(list[n]) < 0) _scratch.push(list[n]);
        }
      }
    }
    return _scratch;
  }
}

// ---------------------------------------------------------------- pedestrian
export class Ped {
  declare scene: any;
  declare city: any;
  declare mgr: any;
  declare char: any;
  declare pos: any;
  declare yaw: any;
  declare speed: any;
  declare state: string;
  declare dead: boolean;
  declare target: any;
  declare id: number;

  // navigation: which pavement leg we are walking and which way along it
  declare leg: number;
  declare dir: number;
  declare crossed: boolean;
  declare wpCross: boolean;
  declare wpEntryT: number;
  declare tx: number;
  declare tz: number;
  declare mode: string; // 'walk' | 'cross'
  declare waiting: boolean;
  declare waitT: number;
  declare lookT: number;
  declare crossFromX: number;
  declare crossFromZ: number;
  declare crossDx: number;
  declare crossDz: number;
  declare crossLen: number;
  declare crossStrip: number;
  declare crossT: number;
  declare crossSampleT: number;
  declare crossBack: boolean;
  declare samples: number[];

  // reactions
  declare fleeTimer: number;
  declare fleeX: number;
  declare fleeZ: number;
  declare spreadDepth: number;
  declare spreadDone: boolean;
  declare witnessTimer: number;
  declare witnessFired: boolean;
  declare wx: number;
  declare wz: number;
  declare cowerTimer: number;
  declare cowerCd: number;
  declare cowerX: number;
  declare cowerZ: number;
  declare idleTimer: number;
  declare idleCd: number;
  declare idleKind: string;
  declare idler: boolean;
  declare stateT: number;
  declare walkSpeed: number;
  declare runSpeed: number;
  declare blocked: boolean;
  declare avoidT: number;
  declare avoidSign: number;
  declare slideT: number;
  declare stuckT: number;
  declare lastX: number;
  declare lastZ: number;
  declare detailOn: boolean;
  declare moved: number;
  declare partner: any;
  declare leader: any;
  declare talkPhase: number;
  declare step: number;

  // a vendor belongs to a cart; a customer is a walker stopped at one
  declare vendor: boolean;
  declare postIndex: number;
  declare postX: number;
  declare postZ: number;
  declare postYaw: number;
  declare shopTimer: number;
  declare shopCd: number;
  declare shopPost: number;
  declare shopX: number;
  declare shopZ: number;

  constructor(scene: THREE.Scene, city: any, position: any, opts: any = {}) {
    this.scene = scene;
    this.city = city;
    this.mgr = opts.mgr;
    this.id = opts.id ?? 0;
    // One body in this city: the crowd is the player's own character asset, at the player's own
    // height. The old rand(0.92, 1.05) scale made the pedestrians a family of differently-built
    // creatures standing next to him, and only skin/shirt/hair was ever meant to vary.
    this.char = new Character();
    this.pos = position.clone();
    this.pos.y = city.groundHeightAt(this.pos.x, this.pos.z);
    this.yaw = rand(0, Math.PI * 2);
    this.walkSpeed = rand(1.25, 1.85);
    this.runSpeed = rand(4.4, 5.4);
    this.speed = this.walkSpeed;
    this.state = 'walk';
    this.dead = false;
    this.target = this.pos.clone();
    this.leg = 0;
    this.dir = 1;
    this.crossed = false;
    this.wpCross = false;
    this.wpEntryT = 0;
    this.tx = this.pos.x;
    this.tz = this.pos.z;
    this.step = 1;
    this.mode = 'walk';
    this.waiting = false;
    this.waitT = 0;
    this.lookT = 0;
    this.crossT = 0;
    this.crossLen = 0;
    this.crossStrip = -1;
    this.crossSampleT = 0;
    this.crossBack = false;
    this.samples = [];
    this.fleeTimer = 0;
    this.fleeX = 0;
    this.fleeZ = 0;
    this.spreadDepth = 0;
    this.spreadDone = false;
    this.witnessTimer = 0;
    this.witnessFired = false;
    this.wx = 0;
    this.wz = 0;
    this.cowerTimer = 0;
    this.cowerCd = 0;
    this.cowerX = 0;
    this.cowerZ = 0;
    // ~8% of the crowd has a life of its own: phone, cigarette or just looking around
    this.idler = opts.idler ?? (!opts.vendor && Math.random() < 0.08);
    this.idleKind = ['phone', 'smoke', 'look'][Math.floor(rand(0, 3))];
    this.idleTimer = this.idler ? rand(4, 9) : 0;
    this.idleCd = 0;
    this.stateT = 0;
    this.blocked = false;
    this.avoidT = 0;
    this.avoidSign = 1;
    this.slideT = 0;
    this.stuckT = 0;
    this.lastX = this.pos.x;
    this.lastZ = this.pos.z;
    this.detailOn = true;
    this.moved = 0;
    this.partner = null;
    this.leader = null;
    this.talkPhase = rand(0, 10);

    // a vendor is placed by its cart and stays there: the post is the cart, not a pavement lane
    this.vendor = !!opts.vendor;
    this.postIndex = opts.vendor?.i ?? -1;
    this.postX = opts.vendor?.x ?? this.pos.x;
    this.postZ = opts.vendor?.z ?? this.pos.z;
    this.postYaw = opts.vendor?.yaw ?? this.yaw;
    this.shopTimer = 0;
    this.shopCd = 0;
    this.shopPost = -1;
    this.shopX = 0;
    this.shopZ = 0;
    if (this.vendor) {
      this.pos.set(this.postX, city.groundHeightAt(this.postX, this.postZ), this.postZ);
      this.yaw = this.postYaw;
      this.state = 'vendor';
      this.speed = 0;
    }

    this.repath();
    if (this.mgr) this.pushOut(this.mgr.grid);
    this.scene.add(this.char.group);
    this.char.group.position.copy(this.pos);
    this.char.group.rotation.y = this.yaw;
  }

  // kept for the harnesses that reset a crowd by hand
  get radius() {
    return RADIUS;
  }

  headPos() {
    return new THREE.Vector3(this.pos.x, this.pos.y + 1.55, this.pos.z);
  }

  // ------------------------------------------------------------ pavement graph
  private legT() {
    const L = this.mgr.legs[this.leg];
    return clamp((this.pos.x - L.ax) * L.ux + (this.pos.z - L.az) * L.uz, 0, L.len);
  }

  /** Re-anchor the walk to the pavement lane the pedestrian is standing on. */
  repath() {
    const near = this.mgr.nearestLeg(this.pos.x, this.pos.z);
    this.leg = near.leg;
    this.dir = this.mgr.legDirTowardCrossing(this.leg, near.t);
    this.crossed = false;
    this.mode = 'walk';
    this.waiting = false;
    this.waitT = 0;
    this.crossBack = false;
    this.crossT = 0;
    this.crossStrip = -1;
    this.samples.length = 0;
    this.spreadDepth = 0;
    this.spreadDone = false;
    this.plan();
  }

  /** Walk to the zebra at the end of this run of pavement, or turn the corner. */
  private plan() {
    const L = this.mgr.legs[this.leg];
    const t = this.legT();
    if (!this.crossed && L.cross >= 0) {
      const entry = this.dir > 0 ? L.cf : L.ct;
      const past = this.dir > 0 ? t > entry + 0.5 : t < entry - 0.5;
      const ahead = this.dir > 0 ? t < entry - 0.5 : t > entry + 0.5;
      if (past) {
        // already over this crossing on the way in: keep walking
        this.crossed = true;
      } else if (!ahead) {
        this.beginCrossing();
        return;
      } else {
        this.wpCross = true;
        this.wpEntryT = entry;
        this.setTarget(L.ax + L.ux * entry, L.az + L.uz * entry);
        return;
      }
    }
    this.wpCross = false;
    const endT = this.dir > 0 ? L.len : 0;
    this.setTarget(L.ax + L.ux * endT, L.az + L.uz * endT);
  }

  private setTarget(x: number, z: number) {
    this.tx = x;
    this.tz = z;
    this.target.set(x, this.pos.y, z);
  }

  /** The far kerb of a crossing: wait for a gap in the traffic, then walk the stripes. */
  private beginCrossing() {
    const L = this.mgr.legs[this.leg];
    const fromT = this.dir > 0 ? L.cf : L.ct;
    const toT = this.dir > 0 ? L.ct : L.cf;
    // cross from the body's own position, straight down the stripes: a shop row that pushed
    // the walker sideways must not make it walk back to a point it cannot stand on
    this.crossFromX = this.pos.x;
    this.crossFromZ = this.pos.z;
    this.crossDx = L.ux * this.dir;
    this.crossDz = L.uz * this.dir;
    this.crossLen = Math.abs(toT - fromT);
    this.crossStrip = L.cross;
    this.mode = 'cross';
    this.waiting = true;
    this.waitT = 0;
    this.lookT = 0;
    this.crossBack = false;
    this.crossT = 0;
    this.crossSampleT = 0;
    this.samples.length = 0;
    this.wpCross = false;
    this.setTarget(
      this.pos.x + this.crossDx * (this.crossLen + 1.2),
      this.pos.z + this.crossDz * (this.crossLen + 1.2)
    );
  }

  private arriveLegEnd() {
    const L = this.mgr.legs[this.leg];
    const next = this.dir > 0 ? L.next : L.prev;
    if (next >= 0) {
      this.leg = next;
      this.dir = this.mgr.legDirTowardCrossing(next, this.dir > 0 ? 0 : this.mgr.legs[next].len);
    } else {
      this.dir = -this.dir; // the end of the street: walk back down it
    }
    this.crossed = false;
    this.plan();
  }

  // ------------------------------------------------------------ reactions
  startFlee(x: number, z: number, seconds: number, mgr: any, depth = 0) {
    if (this.fleeTimer <= 0) {
      // a fresh scare: remember whether this ped may pass the panic on
      this.spreadDepth = depth;
      this.spreadDone = false;
    } else if (depth < this.spreadDepth) {
      this.spreadDepth = depth;
    }
    this.fleeTimer = Math.max(this.fleeTimer, seconds);
    this.fleeX = x;
    this.fleeZ = z;
    this.speed = this.runSpeed;
    this.waiting = false;
    this.mode = 'walk';
    this.crossBack = false;
    this.wpCross = false;
    this.state = 'flee';
    this.stateT = 0;
    this.shopTimer = 0; // nobody queues for bakso with a gun out
    this.shopPost = -1;
    void mgr;
  }

  startWitness(x: number, z: number, mgr: any) {
    // one call per murder seen: the witness runs for the cops and the call is logged.
    // A second murder while it is still running counts again, like a real bystander.
    this.witnessTimer = 9;
    this.fleeTimer = 0; // the witness runs for help, not for its life
    this.wx = x;
    this.wz = z;
    this.state = 'witness';
    this.stateT = 0;
    this.speed = this.runSpeed;
    this.shopTimer = 0;
    this.shopPost = -1;
    // seeing a murder is worth a star: the nearest bystander runs for the cops
    this.witnessFired = true;
    mgr.stats.witnessEvents += 1;
    if (mgr.ctx && typeof mgr.ctx.addWanted === 'function') {
      mgr.ctx.addWanted(1);
      mgr.stats.witnessWanted += 1;
    }
  }

  private checkHorror(ctx: any, mgr: any) {
    if (this.cowerTimer > 0 || this.cowerCd > 0) return;
    const corpses = ctx.corpses;
    if (corpses) {
      for (let i = 0; i < corpses.length; i++) {
        const c = corpses[i]?.center;
        if (!c) continue;
        const dx = c.x - this.pos.x;
        const dz = c.z - this.pos.z;
        if (dx * dx + dz * dz < 49) {
          this.cowerTimer = 4.5;
          this.cowerCd = 12;
          this.cowerX = c.x;
          this.cowerZ = c.z;
          this.speed = 0;
          mgr.stats.cowerEvents += 1;
          return;
        }
      }
    }
    const cars = ctx.cars;
    if (cars) {
      for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        if (!c || !c.wrecked) continue;
        const dx = c.pos.x - this.pos.x;
        const dz = c.pos.z - this.pos.z;
        if (dx * dx + dz * dz < 49) {
          this.cowerTimer = 4.5;
          this.cowerCd = 12;
          this.cowerX = c.pos.x;
          this.cowerZ = c.pos.z;
          this.speed = 0;
          mgr.stats.cowerEvents += 1;
          return;
        }
      }
    }
  }

  /** Is the player pointing a gun at me? */
  private aimedAt(ctx: any, dx: number, dz: number, dist: number) {
    if (!ctx.armed || dist > AIM_RADIUS) return false;
    const ax = ctx.aimX ?? 0;
    const az = ctx.aimZ ?? 0;
    if (ax === 0 && az === 0) return dist < 8;
    return (dx * ax + dz * az) / (dist || 1) > 0.55; // (dx,dz) points from the player to me
  }

  // ------------------------------------------------------------ traffic
  /** Would stepping off this kerb put me in front of a moving car? */
  private crossingBlocked(ctx: any) {
    const cars = ctx.cars;
    if (!cars || !cars.length) return false;
    const mx = this.crossFromX + this.crossDx * this.crossLen * 0.5;
    const mz = this.crossFromZ + this.crossDz * this.crossLen * 0.5;
    const px = -this.crossDz;
    const pz = this.crossDx;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (!c || c.dead) continue;
      if (Math.abs(c.speed) < 1.2) continue; // parked or stopped: not a threat
      const rx = c.pos.x - mx;
      const rz = c.pos.z - mz;
      const along = rx * this.crossDx + rz * this.crossDz;
      const across = rx * px + rz * pz;
      if (Math.abs(along) > STREET_REACH) continue;
      if (Math.abs(across) > 8) continue; // 8 m of road either side of the crossing
      return true;
    }
    return false;
  }

  /** A car that closed in while I am on the asphalt: get out of its lane. */
  private carOnTopOfMe(ctx: any) {
    const cars = ctx.cars;
    if (!cars || !cars.length) return false;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (!c || c.dead) continue;
      if (Math.abs(c.speed) < 1.5) continue;
      const dx = c.pos.x - this.pos.x;
      const dz = c.pos.z - this.pos.z;
      if (dx * dx + dz * dz < 12) return true; // within ~3.5 m
    }
    return false;
  }

  // ------------------------------------------------------------ movement
  private moveBy(dx: number, dz: number, speed: number, dt: number) {
    if (speed <= 0) return;
    const desired = Math.atan2(dx, dz);
    this.yaw += angleDelta(this.yaw, desired) * clamp(dt * 8, 0, 1);
    this.pos.x += Math.sin(this.yaw) * speed * dt;
    this.pos.z += Math.cos(this.yaw) * speed * dt;
  }

  private moveToward(tx: number, tz: number, speed: number, dt: number) {
    const dx = tx - this.pos.x;
    const dz = tz - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-4) return;
    this.moveBy(dx, dz, Math.min(speed, d / Math.max(dt, 1e-4)), dt);
  }

  /** Turn toward a point without moving. */
  private faceToward(x: number, z: number, dt: number) {
    const dx = x - this.pos.x;
    const dz = z - this.pos.z;
    if (dx * dx + dz * dz < 1e-4) return;
    const desired = Math.atan2(dx, dz);
    this.yaw += angleDelta(this.yaw, desired) * clamp(dt * 5, 0, 1);
  }

  /**
   * A walker passing a staffed cart stops for food for 3-6 s and then walks on. The stop never
   * moves the pedestrian: it stands where the pavement already put it, so queueing can never walk
   * a body into a wall. The manager caps how many carts serve at once, which is what keeps the
   * pavement flowing instead of turning every cart into a crowd.
   */
  private tryShop(ctx: any, mgr: any) {
    void ctx;
    const posts: VendorPost[] | undefined = mgr?.cartPosts;
    if (!posts || !posts.length) return;
    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      const dx = post.cx - this.pos.x;
      const dz = post.cz - this.pos.z;
      if (dx * dx + dz * dz > CUSTOMER_RANGE * CUSTOMER_RANGE) continue;
      if (!mgr.cartServed(post.i)) continue; // no vendor behind the counter, no customer
      // stand beside the vendor, not inside him: the serving spot is often the same pavement lane
      const vx = this.pos.x - post.x;
      const vz = this.pos.z - post.z;
      if (vx * vx + vz * vz < 1.1 * 1.1) continue;
      if (mgr.cartBusy(post.i)) continue; // one customer per cart
      if (mgr.shoppers() >= CUSTOMER_CAP) return; // the street keeps moving
      this.shopTimer = rand(CUSTOMER_STOP_MIN, CUSTOMER_STOP_MAX);
      this.shopPost = post.i;
      this.shopX = post.cx;
      this.shopZ = post.cz;
      this.speed = 0;
      this.stuckT = 0;
      mgr.stats.customers += 1;
      return;
    }
  }

  /** Push the body out of building footprints; never let the centre enter one. */
  private pushOut(grid: ColliderGrid) {
    // Shop rows are rotated boxes binned as axis-aligned ones, so their colliders overlap:
    // ejecting from one can land the body in the next. A few passes settle the pocket.
    for (let pass = 0; pass < 4; pass++) {
      let pushed = false;
      const list = grid.near(this.pos.x, this.pos.z);
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        const cx = clamp(this.pos.x, b.minX, b.maxX);
        const cz = clamp(this.pos.z, b.minZ, b.maxZ);
        const dx = this.pos.x - cx;
        const dz = this.pos.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 > RADIUS * RADIUS) continue;
        if (d2 > 1e-6) {
          const d = Math.sqrt(d2);
          const push = (RADIUS - d) / d;
          this.pos.x += dx * push;
          this.pos.z += dz * push;
        } else {
          // centre inside the box: eject through the shallowest face
          const pl = this.pos.x - b.minX;
          const pr = b.maxX - this.pos.x;
          const pb = this.pos.z - b.minZ;
          const pf = b.maxZ - this.pos.z;
          const m = Math.min(pl, pr, pb, pf);
          if (m === pl) this.pos.x = b.minX - RADIUS;
          else if (m === pr) this.pos.x = b.maxX + RADIUS;
          else if (m === pb) this.pos.z = b.minZ - RADIUS;
          else this.pos.z = b.maxZ + RADIUS;
        }
        pushed = true;
        this.blocked = true;
      }
      if (!pushed) return;
    }
  }

  /** Place the body at (x,z) on the pavement and re-plan from there. */
  placeAt(x: number, z: number) {
    this.pos.set(x, 0, z);
    this.pushOut(this.mgr.grid);
    this.pos.y = this.city.groundHeightAt(this.pos.x, this.pos.z);
    this.char.group.position.copy(this.pos);
    this.repath();
  }

  // ------------------------------------------------------------ state updates
  private updateWalk(dt: number, ctx: any, mgr: any) {
    // a customer at the counter: stand still beside the cart, facing it, then walk on. This runs
    // before the pinned-harness guard because a customer's own speed is zero while it shops.
    if (this.shopTimer > 0) {
      this.shopTimer = Math.max(0, this.shopTimer - dt);
      this.speed = 0;
      this.lookT += dt;
      this.faceToward(this.shopX, this.shopZ, dt);
      if (this.shopTimer === 0) {
        this.shopCd = rand(CUSTOMER_COOLDOWN_MIN, CUSTOMER_COOLDOWN_MAX);
        this.shopPost = -1;
        this.speed = this.walkSpeed; // the stop zeroed it; without this the walk never resumes
        this.plan(); // carry on from where the stop interrupted the walk
      }
      return;
    }
    if (this.speed < 0.05) return; // pinned by a test harness: stand still
    this.speed = this.walkSpeed;

    // pairs: the follower shadows the leader while both are on the same run of pavement
    const L = this.leader;
    if (L && !L.dead && L.state === 'walk' && L.mode === 'walk' && !L.waiting && this.leg === L.leg) {
      this.tx = L.tx;
      this.tz = L.tz;
      this.target.set(this.tx, this.pos.y, this.tz);
      this.moveToward(this.tx, this.tz, this.speed, dt);
      return;
    }

    if (this.mode === 'walk' && !this.waiting && this.shopCd <= 0) this.tryShop(ctx, mgr);

    if (this.waiting) {
      this.waitT += dt;
      this.lookT += dt;
      if (!this.crossingBlocked(ctx)) {
        // a gap in the traffic: step off the kerb
        this.waiting = false;
        this.mode = 'cross';
        this.crossT = 0;
        this.crossSampleT = 0;
        this.crossBack = false;
        this.samples.length = 0;
      } else if (this.waitT > 12) {
        // nobody is letting me through, and I have stood here long enough: cross anyway.
        // People step out and hurry; the car-on-top abort still pulls them back if one comes.
        this.waiting = false;
        this.mode = 'cross';
        this.crossT = 0;
        this.crossSampleT = 0;
        this.crossBack = false;
        this.samples.length = 0;
      }
      return;
    }

    if (this.mode === 'cross') {
      this.updateCrossing(dt, ctx, mgr);
      return;
    }

    const dx = this.tx - this.pos.x;
    const dz = this.tz - this.pos.z;
    // The kerb is a place, not a point: measure progress along the lane and how far the body
    // was pushed off it, so a shop row that overhangs the zebra cannot pin a pedestrian on its
    // way to the crossing (which left the crowd stuck at "walking to the zebra" forever).
    if (this.wpCross) {
      const leg = this.mgr.legs[this.leg];
      const lateral = (this.pos.x - leg.ax) * -leg.uz + (this.pos.z - leg.az) * leg.ux;
      if (Math.abs(this.legT() - this.wpEntryT) < 2.5 && Math.abs(lateral) < 1.6) {
        this.beginCrossing();
        return;
      }
    }
    if (dx * dx + dz * dz < 0.81) {
      if (this.wpCross) this.beginCrossing();
      else this.arriveLegEnd();
      return;
    }
    if (this.stuckT > 0.35) {
      // the lane runs into a wall (the shop rows overhang it): sidestep along the wall
      // instead of pushing straight in, which used to pin pedestrians in place
      this.slideT = 1.0;
      this.stuckT = 0;
      this.avoidSign = -this.avoidSign;
    }
    if (this.slideT > 0) {
      this.slideT -= dt;
      const d = Math.hypot(dx, dz) || 1;
      const nx = (-dz / d) * this.avoidSign;
      const nz = (dx / d) * this.avoidSign;
      this.moveBy(dx / d + nx * 1.8, dz / d + nz * 1.8, this.speed, dt);
      return;
    }
    this.moveToward(this.tx, this.tz, this.speed, dt);
  }

  private updateCrossing(dt: number, ctx: any, mgr: any) {
    const onRoad = mgr.onCarriageway(this.pos.x, this.pos.z);
    if (!this.crossBack && onRoad && this.carOnTopOfMe(ctx)) {
      // a car I did not expect: reverse out of its lane, do not stand in it
      this.crossBack = true;
      this.setTarget(this.crossFromX, this.crossFromZ);
      mgr.stats.crossAborts += 1;
    }
    this.speed = CROSS_SPEED;
    this.crossT += dt;
    this.moveToward(this.tx, this.tz, CROSS_SPEED, dt);

    // record where the body actually is on the asphalt for the crosswalk audit
    this.crossSampleT += dt;
    if (this.crossSampleT > 0.15) {
      this.crossSampleT = 0;
      if (onRoad) {
        const n = this.samples.length;
        if (n < 160) {
          this.samples.push(+this.pos.x.toFixed(2), +this.pos.z.toFixed(2));
        }
      }
    }

    const dx = this.tx - this.pos.x;
    const dz = this.tz - this.pos.z;
    if (dx * dx + dz * dz < 0.81) {
      if (this.crossBack) {
        this.mode = 'walk';
        this.crossBack = false;
        this.waiting = true;
        this.waitT = 0;
        return;
      }
      this.finishCrossing(mgr);
      return;
    }
    // something (a car, a body, a shop wall overhanging the far kerb) kept me off the exit
    // point: the crossing is over once I have walked it and then some
    if (this.crossT > Math.min(this.crossLen / CROSS_SPEED + 4, 14)) this.finishCrossing(mgr);
  }

  private finishCrossing(mgr: any) {
    mgr.logCrossing(this);
    this.mode = 'walk';
    this.waiting = false;
    this.crossBack = false;
    this.crossed = true;
    this.samples.length = 0;
    this.plan();
  }

  private updateFlee(dt: number, ctx: any, mgr: any) {
    const ax = this.pos.x - this.fleeX;
    const az = this.pos.z - this.fleeZ;
    const d = Math.hypot(ax, az) || 1e-4;
    let dirx = ax / d;
    let dirz = az / d;
    if (this.avoidT > 0) {
      // slide along the wall instead of grinding into it
      this.avoidT -= dt;
      const c = Math.cos(this.avoidSign * 1.2);
      const s = Math.sin(this.avoidSign * 1.2);
      const rx = dirx * c - dirz * s;
      const rz = dirx * s + dirz * c;
      dirx = rx;
      dirz = rz;
    }
    this.speed = this.runSpeed;
    this.moveBy(dirx, dirz, this.speed, dt);
    if (this.blocked && this.avoidT <= 0) {
      this.avoidT = 0.55;
      this.avoidSign = Math.random() < 0.5 ? -1 : 1;
    }
    if (this.fleeTimer <= 0) this.repath();
  }

  private updateWitness(dt: number, ctx: any, mgr: any) {
    // run toward the nearest cruiser, or away from the shooter if there is none
    let bestX = 0;
    let bestZ = 0;
    let bd = Infinity;
    const cops = ctx.copCars;
    if (cops && cops.length) {
      for (let i = 0; i < cops.length; i++) {
        const c = cops[i];
        const dx = c.pos.x - this.pos.x;
        const dz = c.pos.z - this.pos.z;
        const d = dx * dx + dz * dz;
        if (d < bd) {
          bd = d;
          bestX = c.pos.x;
          bestZ = c.pos.z;
        }
      }
    }
    this.speed = this.runSpeed;
    if (bd < 9) {
      // reached the cops: stand there waving
      this.blocked = false;
      return;
    }
    if (bestX !== 0 || bestZ !== 0) {
      this.moveToward(bestX, bestZ, this.runSpeed, dt);
    } else {
      const dx = this.pos.x - this.wx;
      const dz = this.pos.z - this.wz;
      this.moveBy(dx, dz, this.runSpeed, dt);
    }
    if (this.witnessTimer <= 0) this.repath();
  }

  private updateCower(dt: number) {
    const dx = this.cowerX - this.pos.x;
    const dz = this.cowerZ - this.pos.z;
    if (dx * dx + dz * dz > 1e-4) {
      const desired = Math.atan2(dx, dz);
      this.yaw += angleDelta(this.yaw, desired) * clamp(dt * 4, 0, 1);
    }
  }

  private updateIdle(dt: number) {
    if (this.idleTimer <= 0) {
      this.idleCd = rand(9, 18); // walk for a while before the next phone call
      return;
    }
    // look around while waiting
    this.lookT += dt;
  }

  /**
   * The vendor stays at its cart. It is not a walker with a target: the post is the cart, so the
   * only movement allowed is walking back after something shoved or teleported it. The height is
   * not decided here -- the caller sets pos.y from city.groundHeightAt every frame, which is what
   * keeps a vendor on the hilly side of the map standing on the slope instead of floating.
   */
  private updateVendor(dt: number, mgr: any) {
    void mgr;
    const dx = this.postX - this.pos.x;
    const dz = this.postZ - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > VENDOR_HOME) {
      // a restart or a test harness re-seeds the crowd somewhere else: put the vendor back at the
      // cart instead of letting it walk across half the map to get home
      if (d > VENDOR_RETURN_SNAP) {
        this.placeAt(this.postX, this.postZ);
        this.yaw = this.postYaw;
        this.speed = 0;
        return;
      }
      this.speed = Math.min(this.walkSpeed, d * 1.4);
      this.moveToward(this.postX, this.postZ, this.speed, dt);
      return;
    }
    this.speed = 0;
    this.lookT += dt;
    // face the street, with the small sway of someone watching the road for customers
    const desired = this.postYaw + Math.sin(this.lookT * 0.5) * 0.3;
    this.yaw += angleDelta(this.yaw, desired) * clamp(dt * 3, 0, 1);
  }

  // ------------------------------------------------------------ pose
  private pose(dt: number) {
    const ch = this.char;
    let headYaw = 0;
    let headPitch = 0;
    let armX: number | null = null;
    let armZ = 0;
    // per-side overrides: the vendor works with two different arms, not a mirrored pair
    let armLX: number | null = null;
    let armRX: number | null = null;
    let armZL: number | null = null;
    let armZR: number | null = null;
    let torsoPitch: number | null = null;
    let legX: number | null = null;
    let tilt = 0;

    if (this.state === 'flee') {
      armX = -2.55; // hands up
      armZ = 0.32;
      headPitch = -0.1;
      headYaw = Math.sin(this.stateT * 7) * 0.25;
      tilt = Math.sin(this.stateT * 9) * 0.05;
    } else if (this.state === 'witness') {
      armX = -2.35;
      armZ = 0.42;
      headYaw = Math.sin(this.stateT * 9) * 0.3;
    } else if (this.state === 'cower') {
      armX = -2.9;
      armZ = 0.5;
      legX = 0.85;
      headPitch = 0.42;
      tilt = Math.sin(this.stateT * 26) * 0.05;
    } else if (this.state === 'vendor') {
      // Working the cart: both arms down and forward over the counter, the right hand stirring.
      // The old pose was armX -1.15 with the arms splayed outwards (-0.26), which is 24 degrees off
      // horizontal — the T-pose in screenshots/proof/pedagang.png. The body also leans in now, so
      // the reach reads as someone tending a wok rather than a mannequin beside an umbrella.
      const stir = Math.sin(this.stateT * 2.1);
      armX = -0.66;
      armLX = -0.58 + stir * 0.08;
      armRX = -0.78 - stir * 0.06;
      armZL = 0.14;
      armZR = -0.10;
      torsoPitch = 0.15;
      headPitch = 0.3;
      headYaw = Math.sin(this.lookT * 0.8) * 0.16;
    } else if (this.shopTimer > 0) {
      // a customer ordering: half-raised hand, eyes on the menu board
      armX = -0.62;
      armZ = -0.14;
      headPitch = 0.06;
    } else if (this.state === 'idle') {
      if (this.idleKind === 'phone') {
        armX = -1.5;
        armZ = -0.42;
        headPitch = 0.3;
      } else if (this.idleKind === 'smoke') {
        armX = -2.4;
        armZ = -0.55;
        headPitch = 0.02;
      } else {
        headYaw = Math.sin(this.lookT * 1.3) * 0.75;
      }
    } else if (this.mode === 'cross' && this.waiting) {
      // look both ways at the kerb
      headYaw = Math.sin(this.lookT * 3.2) * 0.85;
    } else if (this.partner && !this.partner.dead) {
      const dx = this.partner.pos.x - this.pos.x;
      const dz = this.partner.pos.z - this.pos.z;
      if (dx * dx + dz * dz < 12) {
        // mid-conversation: turn the head toward the other half of the pair
        this.talkPhase += dt * 2.4;
        const target = angleDelta(this.yaw, Math.atan2(dx, dz));
        headYaw = clamp(target, -0.75, 0.75);
        headPitch = Math.sin(this.talkPhase * 1.7) * 0.06;
      }
    }

    if (armX !== null) {
      ch.armL.rotation.x = armLX ?? armX;
      ch.armR.rotation.x = armRX ?? armX;
      ch.armL.rotation.z = armZL ?? armZ;
      ch.armR.rotation.z = armZR ?? -armZ;
    }
    if (legX !== null) {
      ch.legL.rotation.x = legX;
      ch.legR.rotation.x = legX;
    }
    ch.head.rotation.y = headYaw;
    ch.head.rotation.x = headPitch;
    if (torsoPitch !== null) ch.torso.rotation.x = torsoPitch;
    if (tilt !== 0) ch.torso.rotation.z = tilt;
    void dt;
  }

  // ------------------------------------------------------------ frame
  update(dt: number, ctx: any, mgr: any) {
    if (this.dead) return;
    this.stateT += dt;
    this.moved = 0;
    this.blocked = false;

    const p = ctx.playerPos;
    const pdx = this.pos.x - p.x;
    const pdz = this.pos.z - p.z;
    const pdist = Math.hypot(pdx, pdz) || 1e-4;

    // timers
    if (this.fleeTimer > 0) this.fleeTimer = Math.max(0, this.fleeTimer - dt);
    if (this.witnessTimer > 0) {
      this.witnessTimer = Math.max(0, this.witnessTimer - dt);
      if (this.witnessTimer === 0) this.witnessFired = false;
    }
    if (this.cowerTimer > 0) this.cowerTimer = Math.max(0, this.cowerTimer - dt);
    if (this.cowerCd > 0) this.cowerCd = Math.max(0, this.cowerCd - dt);
    if (this.idleTimer > 0) this.idleTimer = Math.max(0, this.idleTimer - dt);
    if (this.shopCd > 0) this.shopCd = Math.max(0, this.shopCd - dt);
    if (this.idleCd > 0) this.idleCd = Math.max(0, this.idleCd - dt);
    else if (this.idler && this.idleTimer <= 0 && this.fleeTimer <= 0 && this.witnessTimer <= 0 && this.cowerTimer <= 0 && Math.random() < dt * 0.18) {
      this.idleTimer = rand(4, 9);
    }

    // a drawn gun pointed at me is as good as a shot
    if (this.aimedAt(ctx, pdx, pdz, pdist)) this.startFlee(p.x, p.z, 1.6, mgr);
    // the old crowd-wide panic (3 stars) still empties the street
    if (ctx.panic && pdist < 30 && this.fleeTimer <= 0 && Math.random() < dt * 2) {
      this.startFlee(p.x, p.z, 3, mgr);
    }
    if (this.fleeTimer <= 0 && this.witnessTimer <= 0) this.checkHorror(ctx, mgr);

    const next = this.fleeTimer > 0 ? 'flee' : this.witnessTimer > 0 ? 'witness' : this.cowerTimer > 0 ? 'cower' : this.vendor ? 'vendor' : this.idleTimer > 0 && this.shopTimer <= 0 ? 'idle' : 'walk';
    if (next !== this.state) {
      this.state = next;
      this.stateT = 0;
      if (next !== 'walk') {
        this.waiting = false;
        this.mode = 'walk';
      }
      if (next !== 'walk' && next !== 'vendor') this.shopTimer = 0;
    }

    const x0 = this.pos.x;
    const z0 = this.pos.z;
    if (this.state === 'flee') this.updateFlee(dt, ctx, mgr);
    else if (this.state === 'witness') this.updateWitness(dt, ctx, mgr);
    else if (this.state === 'cower') this.updateCower(dt);
    else if (this.state === 'vendor') this.updateVendor(dt, mgr);
    else if (this.state === 'idle') this.updateIdle(dt);
    else this.updateWalk(dt, ctx, mgr);

    // never leave the pavement inside a wall
    this.pushOut(mgr.grid);

    // if something pins us for two seconds, re-plan instead of grinding forever
    this.moved = Math.hypot(this.pos.x - x0, this.pos.z - z0);
    if (this.state === 'walk' && !this.waiting && this.moved < 0.004 && this.speed > 0.05) {
      this.stuckT += dt;
      if (this.stuckT > 2) {
        this.stuckT = 0;
        this.repath();
      }
    } else {
      this.stuckT = 0;
    }

    // the city is 2.5 km across now: clamping to the old 220 m box pinned pedestrians and
    // traffic to an invisible square
    const edge = this.city?.bound ?? 1260;
    this.pos.x = clamp(this.pos.x, -edge, edge);
    this.pos.z = clamp(this.pos.z, -edge, edge);
    this.pos.y = this.city.groundHeightAt(this.pos.x, this.pos.z);

    this.char.group.visible = pdist < HIDE_LOD;
    this.char.group.position.set(this.pos.x, this.pos.y, this.pos.z);
    this.char.group.rotation.y = this.yaw;
    const moving = clamp(this.moved / Math.max(dt, 1e-4) / 5, 0, 1);
    if (pdist < ANIM_LOD) {
      this.char.animate(dt, moving);
      this.pose(dt);
    }
    const detail = pdist < DETAIL_LOD;
    if (detail !== this.detailOn) {
      this.char.setDetail(detail);
      this.detailOn = detail;
    }
    plantOnGround(this.char, this.pos.y);
    this.lastX = this.pos.x;
    this.lastZ = this.pos.z;
  }

  kill(velocity: any, colliders: any) {
    this.dead = true;
    this.state = 'down';
    // geometries/materials are shared across characters — never dispose them here
    this.scene.remove(this.char.group);
    return { position: this.pos.clone(), yaw: this.yaw, skin: this.char.skin, shirt: this.char.shirt, pants: this.char.pants, velocity };
  }
}

// ---------------------------------------------------------------- manager
export /** Where two road segments cross, or null. */
function segmentCross(p1: number[], p2: number[], p3: number[], p4: number[]): [number, number] | null {
  const d1x = p2[0] - p1[0];
  const d1z = p2[1] - p1[1];
  const d2x = p4[0] - p3[0];
  const d2z = p4[1] - p3[1];
  const den = d1x * d2z - d1z * d2x;
  if (Math.abs(den) < 1e-6) return null;
  const t = ((p3[0] - p1[0]) * d2z - (p3[1] - p1[1]) * d2x) / den;
  const u = ((p3[0] - p1[0]) * d1z - (p3[1] - p1[1]) * d1x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [p1[0] + d1x * t, p1[1] + d1z * t];
}

export class PedManager {
  declare scene: any;
  declare city: any;
  declare peds: any[];
  declare count: any;
  declare respawnTimer: number;
  declare flowTimer: number;
  declare grid: ColliderGrid;
  declare strips: Strip[];
  declare legs: Leg[];
  declare roads: { name: string; width: number; path: [number, number][] }[];
  declare stats: any;
  declare crossingLog: any[];
  declare ctx: any;
  declare simTime: number;
  declare spreadTimer: number;
  declare pairs: number;
  /** one post per food cart, in the order the city audited them */
  declare cartPosts: VendorPost[];

  constructor(scene: THREE.Scene, city: any, count = 34) {
    this.scene = scene;
    this.city = city;
    this.count = count;
    this.peds = [];
    // The road network is the map's own data: the arterials, the ring and the local streets
    // that were cut between the blocks. Simplified first, so a street sampled every 18 m for
    // clipping becomes one straight run instead of thirty.
    const source = city.roads && city.roads.length
      ? city.roads
      : [
          ...ARTERIALS.map((a) => ({ name: a.name, width: a.width, path: a.path as [number, number][] })),
          { name: 'Ring Road', width: 20, path: RING_ROAD as [number, number][] },
          ...LOCAL_STREETS.map((s, i) => ({ name: `Local Street ${i}`, width: s.width, path: s.path as [number, number][] })),
        ];
    this.roads = source.map((r: any) => ({ name: r.name, width: r.width, path: simplify(r.path) }));
    this.grid = new ColliderGrid(city.colliders || []);
    this.strips = this.buildCrosswalkStrips();
    this.legs = this.buildPavements();
    this.cartPosts = this.buildCartPosts();
    this.stats = { fleeEvents: 0, fleeSpreads: 0, witnessEvents: 0, witnessWanted: 0, cowerEvents: 0, crossings: 0, crossingsOnStrip: 0, crossAborts: 0, customers: 0, vendors: 0 };
    this.crossingLog = [];
    this.simTime = 0;
    this.spreadTimer = 0;
    this.pairs = 0;
    this.ctx = null;
    for (let i = 0; i < count; i++) {
      const spot = this.pavementPointNear(0, 0, 6, 110) || this.randomPavementPoint();
      this.peds.push(new Ped(scene, city, spot, { id: i, idler: i % 12 === 0, mgr: this }));
    }
    // roughly a third of the crowd walks in pairs (walkers only: the vendors are not added yet)
    for (let i = 0; i + 1 < this.peds.length; i += 3) {
      const a = this.peds[i];
      const b = this.peds[i + 1];
      if (!a || !b) continue;
      a.partner = b;
      b.partner = a;
      b.leader = a;
      this.pairs += 1;
    }
    // A vendor for every cart, on top of the walking crowd. The 46-pedestrian budget the world
    // gate enforces is the walking crowd plus these, so the street gets its shops without the
    // count check having to grow. Added after the pairing pass: a vendor is not one half of a
    // couple walking down the road.
    this.restaffVendors();
    this.respawnTimer = 0;
    this.flowTimer = 0;
  }

  /**
   * Zebra bands at every junction the street network actually has.
   *
   * A band is the painted crossing *across* one road, placed just outside the junction box of
   * the road it meets: its length spans that road's carriageway (`hl`, kerb to kerb) and its
   * depth runs along the met road (`hw`). A pedestrian walking one road's pavement meets the
   * band head on, which is the only place it may step onto the asphalt.
   */
  buildCrosswalkStrips() {
    const strips: Strip[] = [];
    const roads = this.roads;
    const segs: { r: number; p1: [number, number]; p2: [number, number]; minX: number; maxX: number; minZ: number; maxZ: number }[] = [];
    for (let r = 0; r < roads.length; r++) {
      const path = roads[r].path;
      for (let i = 0; i < path.length - 1; i++) {
        const p1 = path[i];
        const p2 = path[i + 1];
        segs.push({
          r,
          p1,
          p2,
          minX: Math.min(p1[0], p2[0]),
          maxX: Math.max(p1[0], p2[0]),
          minZ: Math.min(p1[1], p2[1]),
          maxZ: Math.max(p1[1], p2[1]),
        });
      }
    }
    for (let a = 0; a < segs.length; a++) {
      const A = segs[a];
      for (let b = a + 1; b < segs.length; b++) {
        const B = segs[b];
        if (A.r === B.r) continue;
        if (A.maxX < B.minX || A.minX > B.maxX || A.maxZ < B.minZ || A.minZ > B.maxZ) continue;
        const hit = segmentCross(A.p1, A.p2, B.p1, B.p2);
        if (!hit) continue;
        this.addStrips(strips, hit, A, B);
        this.addStrips(strips, hit, B, A);
      }
    }
    return strips;
  }

  /** Two bands (one either side of the junction) for crossing `cross` while walking `walk`. */
  private addStrips(strips: Strip[], hit: [number, number], walk: any, cross: any) {
    const wWalk = this.roads[walk.r].width;
    const wCross = this.roads[cross.r].width;
    const dx = walk.p2[0] - walk.p1[0];
    const dz = walk.p2[1] - walk.p1[1];
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    const cxr = cross.p2[0] - cross.p1[0];
    const czr = cross.p2[1] - cross.p1[1];
    const lenc = Math.hypot(cxr, czr) || 1;
    const nx = cxr / lenc;
    const nz = czr / lenc;
    const off = wWalk / 2 + PAVE;
    for (const side of [-1, 1]) {
      // offset sideways off the walked road (along the road being crossed), and the band runs
      // along the walker's direction so the stripes are walked end to end
      strips.push({
        cx: hit[0] + nx * off * side,
        cz: hit[1] + nz * off * side,
        ux,
        uz,
        hl: wCross / 2 + STRIP_PAD,
        hw: STRIP_HALF,
        len: wCross + 2 * STRIP_PAD,
        road: cross.r,
      });
    }
  }

  /**
   * Pavement legs: every road gets a lane on each side at width/2 + PAVE, split at the polyline
   * points and chained prev/next. A leg also records the zebra it walks over, and where along
   * the leg that carriageway starts and ends.
   */
  buildPavements() {
    const legs: Leg[] = [];
    for (let r = 0; r < this.roads.length; r++) {
      const path = this.roads[r].path;
      const off = this.roads[r].width / 2 + PAVE;
      for (const side of [-1, 1]) {
        const first = legs.length;
        for (let i = 0; i < path.length - 1; i++) {
          const na = this.normalAt(path, i);
          const nb = this.normalAt(path, i + 1);
          const ax = path[i][0] + na[0] * off * side;
          const az = path[i][1] + na[1] * off * side;
          const bx = path[i + 1][0] + nb[0] * off * side;
          const bz = path[i + 1][1] + nb[1] * off * side;
          const len = Math.hypot(bx - ax, bz - az);
          if (len < 0.5) continue;
          legs.push({
            i: legs.length,
            ax,
            az,
            bx,
            bz,
            len,
            ux: (bx - ax) / len,
            uz: (bz - az) / len,
            road: r,
            side,
            prev: -1,
            next: -1,
            cross: -1,
            cf: 0,
            ct: 0,
          });
        }
        for (let k = first + 1; k < legs.length; k++) {
          legs[k].prev = k - 1;
          legs[k - 1].next = k;
        }
      }
    }
    for (const leg of legs) this.findCrossing(leg);
    return legs;
  }

  /** Outward normal of the road at polyline vertex i, averaged across the joint. */
  private normalAt(path: [number, number][], i: number) {
    let nx = 0;
    let nz = 0;
    if (i > 0) {
      const dx = path[i][0] - path[i - 1][0];
      const dz = path[i][1] - path[i - 1][1];
      const l = Math.hypot(dx, dz) || 1;
      nx += -dz / l;
      nz += dx / l;
    }
    if (i < path.length - 1) {
      const dx = path[i + 1][0] - path[i][0];
      const dz = path[i + 1][1] - path[i][1];
      const l = Math.hypot(dx, dz) || 1;
      nx += -dz / l;
      nz += dx / l;
    }
    const l = Math.hypot(nx, nz) || 1;
    return [nx / l, nz / l];
  }

  /** Where this leg walks through another road's carriageway, and the zebra that covers it. */
  private findCrossing(leg: Leg) {
    const roads = this.roads;
    for (let r = 0; r < roads.length; r++) {
      if (r === leg.road) continue;
      const road = roads[r];
      const half = road.width / 2;
      // cheap reject: the road's own path must come near this leg at all
      let near = false;
      for (let i = 0; i < road.path.length && !near; i++) {
        const d = Math.hypot(road.path[i][0] - leg.ax, road.path[i][1] - leg.az);
        if (d < leg.len + half + 40) near = true;
      }
      if (!near) continue;
      let t0 = -1;
      let t1 = -1;
      for (let t = 0; t <= leg.len; t += 1) {
        const x = leg.ax + leg.ux * t;
        const z = leg.az + leg.uz * t;
        const inside = this.city.distToPath(x, z, road.path) < half - 0.2;
        if (inside) {
          if (t0 < 0) t0 = t;
          t1 = t;
        }
      }
      // a street crossing is a road width, not a lane that happens to run alongside another
      // road: an interval longer than the widest carriageway is not a zebra, it is a slip lane
      const span = t1 - t0;
      if (t0 < 0 || span < 2 || span > 40) continue;
      const midT = (t0 + t1) / 2;
      const strip = this.stripAt(leg.ax + leg.ux * midT, leg.az + leg.uz * midT, leg.ux, leg.uz);
      if (strip < 0) continue; // no paint here: the pedestrian has no business on that asphalt
      leg.cross = strip;
      leg.cf = t0;
      leg.ct = t1;
      return;
    }
  }

  /** Index of the zebra containing this point whose travel direction matches (ux,uz). */
  stripAt(x: number, z: number, ux: number, uz: number) {
    for (let i = 0; i < this.strips.length; i++) {
      const s = this.strips[i];
      if (Math.abs(s.ux * ux + s.uz * uz) < 0.7) continue;
      const px = x - s.cx;
      const pz = z - s.cz;
      if (Math.abs(px * s.ux + pz * s.uz) > s.hl) continue;
      if (Math.abs(px * -s.uz + pz * s.ux) > s.hw) continue;
      return i;
    }
    return -1;
  }

  isOnCrosswalk(x: number, z: number) {
    for (let i = 0; i < this.strips.length; i++) {
      const s = this.strips[i];
      const px = x - s.cx;
      const pz = z - s.cz;
      if (Math.abs(px * s.ux + pz * s.uz) > s.hl) continue;
      if (Math.abs(px * -s.uz + pz * s.ux) > s.hw) continue;
      return true;
    }
    return false;
  }

  /** True when (x,z) is on a road's asphalt, measured against the map's road polylines. */
  onCarriageway(x: number, z: number) {
    for (let r = 0; r < this.roads.length; r++) {
      const road = this.roads[r];
      if (this.city.distToPath(x, z, road.path) < road.width / 2) return true;
    }
    return false;
  }

  /** Which way to walk from `t` along this leg to reach its zebra: 1, -1, or the longer way. */
  legDirTowardCrossing(leg: number, t: number) {
    const L = this.legs[leg];
    if (L.cross >= 0) {
      if (t < L.cf) return 1;
      if (t > L.ct) return -1;
      return 1; // standing on the paint: finish the crossing
    }
    return t < L.len * 0.5 ? 1 : -1;
  }

  /** Nearest point on the pavement network, for re-anchoring a pedestrian. */
  nearestLeg(x: number, z: number) {
    let best = 0;
    let bd = Infinity;
    let bt = 0;
    for (let i = 0; i < this.legs.length; i++) {
      const L = this.legs[i];
      let t = (x - L.ax) * L.ux + (z - L.az) * L.uz;
      t = clamp(t, 0, L.len);
      const px = L.ax + L.ux * t;
      const pz = L.az + L.uz * t;
      const d = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d < bd) {
        bd = d;
        best = i;
        bt = t;
      }
    }
    return { leg: best, t: bt, d: Math.sqrt(bd) };
  }

  /** Is this point clear of buildings and props the body cannot stand in? */
  clearOfBuildings(x: number, z: number) {
    const list = this.grid.near(x, z);
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (x > b.minX - RADIUS - 0.2 && x < b.maxX + RADIUS + 0.2 && z > b.minZ - RADIUS - 0.2 && z < b.maxZ + RADIUS + 0.2) return false;
    }
    return true;
  }

  /** Is this point clear of every solid collider (kerb-height clutter is stepped over)? */
  private clearSpot(x: number, z: number) {
    const list = this.grid.near(x, z);
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const dx = Math.max(b.minX - x, 0, x - b.maxX);
      const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
      if (Math.hypot(dx, dz) < RADIUS + 0.05) return false;
    }
    return true;
  }

  /** One post per food cart the city audited (propAudit `kaki5-*`), in audit order. */
  buildCartPosts() {
    const audit = this.city.propAudit || [];
    const posts: VendorPost[] = [];
    for (let i = 0; i < audit.length; i++) {
      const a = audit[i];
      if (!a || typeof a.name !== 'string' || !a.name.startsWith('kaki5-')) continue;
      const spot = this.vendorSpot(a.x, a.z);
      if (!spot) continue;
      posts.push({ i: posts.length, cart: a.name, cx: a.x, cz: a.z, x: spot.x, z: spot.z, yaw: spot.yaw });
    }
    return posts;
  }

  /**
   * Where the vendor stands for the cart at (cx,cz). A ring of spots is sampled around the cart and
   * the one kept is on the ground, off the carriageway when the cart leaves any room, clear of
   * every solid collider, and as close to the pavement lane as the cart allows: that lane is the
   * serving side, where customers walk. The vendor faces the road they come in from.
   *
   * The search is geometric on purpose. The audit entry is a placement coordinate, not the cart's
   * yaw, so "the serve side" has to be measured against the pavement and the kerb rather than read
   * off a rotation the city never publishes.
   */
  vendorSpot(cx: number, cz: number) {
    let best: any = null;
    let fallback: any = null;
    for (let r = 0; r < VENDOR_RINGS.length; r++) {
      const R = VENDOR_RINGS[r];
      for (let i = 0; i < VENDOR_ANGLES; i++) {
        const a = (i / VENDOR_ANGLES) * Math.PI * 2;
        const x = cx + Math.sin(a) * R;
        const z = cz + Math.cos(a) * R;
        if (!this.clearSpot(x, z)) continue;
        const lane = this.nearestLeg(x, z).d;
        const road = this.onCarriageway(x, z);
        if (!road && (!best || lane < best.lane)) best = { x, z, lane };
        // a cart can be parked so tight against the kerb that every ring point is asphalt: the
        // vendor then stands in the parking lane rather than not existing at all
        if (!fallback || lane < fallback.lane) fallback = { x, z, lane };
      }
    }
    const pick = best || fallback;
    if (!pick) return null;
    // Face the cart, not the street. The person serving is turned into his own gerobak, working
    // over the pot; the previous yaw faced the lane he stands on, so the screenshots showed a man
    // staring at the road with the back of his head to the cart he is supposed to be serving from.
    return { x: pick.x, z: pick.z, yaw: Math.atan2(cx - pick.x, cz - pick.z) };
  }

  /** Is a live, calm vendor standing behind this cart's counter? */
  cartServed(i: number) {
    for (let k = 0; k < this.peds.length; k++) {
      const p = this.peds[k];
      if (p.dead || !p.vendor || p.postIndex !== i) continue;
      if (p.fleeTimer > 0 || p.witnessTimer > 0 || p.cowerTimer > 0) continue; // the counter is empty
      return true;
    }
    return false;
  }

  /**
   * Does this cart have a vendor at all? Restocking keys off this, not off `cartServed`: a vendor
   * that is running from a gunshot is still the cart's vendor, and hiring a second one while it
   * comes back would leave two people behind the counter.
   */
  cartStaffed(i: number) {
    for (let k = 0; k < this.peds.length; k++) {
      const p = this.peds[k];
      if (!p.dead && p.vendor && p.postIndex === i) return true;
    }
    return false;
  }

  /** Is somebody already being served there? One customer per cart, or the queue never ends. */
  cartBusy(i: number) {
    for (let k = 0; k < this.peds.length; k++) {
      const p = this.peds[k];
      if (!p.dead && p.shopTimer > 0 && p.shopPost === i) return true;
    }
    return false;
  }

  /** How many carts are serving a customer right now. */
  shoppers() {
    let n = 0;
    for (let k = 0; k < this.peds.length; k++) {
      const p = this.peds[k];
      if (!p.dead && p.shopTimer > 0) n++;
    }
    return n;
  }

  /** Put a vendor back on every post that has none (killed, or never staffed). */
  restaffVendors() {
    for (let i = 0; i < this.cartPosts.length; i++) {
      const post = this.cartPosts[i];
      if (this.cartStaffed(post.i)) continue;
      const y = this.city.groundHeightAt(post.x, post.z);
      const ped = new Ped(this.scene, this.city, new THREE.Vector3(post.x, y, post.z), {
        id: this.peds.length,
        idler: false,
        mgr: this,
        vendor: post,
      });
      this.peds.push(ped);
      this.stats.vendors += 1;
    }
  }

  /**
   * A spot on a pavement lane between minR and maxR from (cx,cz). This is how the crowd is
   * spawned and recycled: never a random block ring, so nobody is ever dropped inside a wall.
   */
  pavementPointNear(cx: number, cz: number, minR: number, maxR: number) {
    const all: number[] = [];
    const nearCrossing: number[] = [];
    for (let i = 0; i < this.legs.length; i++) {
      const L = this.legs[i];
      let t = (cx - L.ax) * L.ux + (cz - L.az) * L.uz;
      t = clamp(t, 0, L.len);
      const d = Math.hypot(L.ax + L.ux * t - cx, L.az + L.uz * t - cz);
      const da = Math.hypot(L.ax - cx, L.az - cz);
      const db = Math.hypot(L.bx - cx, L.bz - cz);
      if (d > maxR) continue;
      if (da < minR && db < minR) continue;
      all.push(i);
      // a lane that reaches a zebra soon: the crowd belongs at the corners, not on a
      // 300 m stretch of boulevard in the middle of nowhere
      if (L.cross >= 0 && Math.min(Math.abs(t - L.cf), Math.abs(t - L.ct)) <= 16) nearCrossing.push(i);
    }
    const pool = nearCrossing.length ? nearCrossing : all;
    if (!pool.length) return null;
    for (let attempt = 0; attempt < 24; attempt++) {
      const leg = this.legs[pool[Math.floor(rand(0, pool.length))]];
      const t = rand(0, leg.len);
      const x = leg.ax + leg.ux * t;
      const z = leg.az + leg.uz * t;
      const d = Math.hypot(x - cx, z - cz);
      if (d < minR || d > maxR) continue;
      // a spot the body can actually stand in: the shop rows overhang the pavement with
      // their axis-aligned colliders, and dropping a body inside one wedges it there
      if (!this.clearOfBuildings(x, z)) continue;
      return new THREE.Vector3(x, this.city.groundHeightAt(x, z), z);
    }
    return null;
  }

  randomPavementPoint() {
    const near = this.pavementPointNear(0, 0, 0, 110);
    if (near) return near;
    for (let attempt = 0; attempt < 200; attempt++) {
      const leg = this.legs[Math.floor(rand(0, this.legs.length))];
      const t = rand(0, leg.len);
      const x = leg.ax + leg.ux * t;
      const z = leg.az + leg.uz * t;
      if (!this.clearOfBuildings(x, z)) continue;
      return new THREE.Vector3(x, this.city.groundHeightAt(x, z), z);
    }
    const leg = this.legs[0];
    return new THREE.Vector3(leg.ax, this.city.groundHeightAt(leg.ax, leg.az), leg.az);
  }

  logCrossing(ped: any) {
    this.stats.crossings += 1;
    let on = 0;
    const total = ped.samples.length / 2;
    for (let i = 0; i < ped.samples.length; i += 2) {
      if (this.isOnCrosswalk(ped.samples[i], ped.samples[i + 1])) on++;
    }
    const clean = total > 0 && on / total >= 0.9;
    if (clean) this.stats.crossingsOnStrip += 1;
    if (this.crossingLog.length < 400) {
      this.crossingLog.push({
        t: +this.simTime.toFixed(2),
        from: [+ped.crossFromX.toFixed(2), +ped.crossFromZ.toFixed(2)],
        to: [+ped.tx.toFixed(2), +ped.tz.toFixed(2)],
        samples: total > 80 ? ped.samples.slice(0, 80) : ped.samples.slice(),
        onStrip: clean,
      });
    }
  }

  /** The street heard a shot: everyone close runs, the nearest bystander fetches the cops. */
  onGunshot(x: number, z: number, sawVictim: boolean) {
    let scared = 0;
    for (let i = 0; i < this.peds.length; i++) {
      const p = this.peds[i];
      if (p.dead) continue;
      const dx = p.pos.x - x;
      const dz = p.pos.z - z;
      if (dx * dx + dz * dz > FLEE_RADIUS * FLEE_RADIUS) continue;
      p.startFlee(x, z, 6.5, this);
      scared += 1;
    }
    this.stats.fleeEvents += scared;
    if (sawVictim) {
      let best: any = null;
      let bd = 22 * 22;
      for (let i = 0; i < this.peds.length; i++) {
        const p = this.peds[i];
        if (p.dead) continue;
        const dx = p.pos.x - x;
        const dz = p.pos.z - z;
        const d = dx * dx + dz * dz;
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      if (best) best.startWitness(x, z, this);
    }
    return scared;
  }

  update(dt: number, ctx: any) {
    this.ctx = ctx;
    this.simTime += dt;

    for (let i = 0; i < this.peds.length; i++) this.peds[i].update(dt, ctx, this);

    // panic is contagious: anything within 12 m of a runner starts running too
    this.spreadTimer += dt;
    if (this.spreadTimer > 0.25) {
      this.spreadTimer = 0;
      for (let i = 0; i < this.peds.length; i++) {
        const src = this.peds[i];
        // only people who were scared directly pass the panic on, and only once:
        // otherwise a single shot keeps the whole street running forever
        if (src.dead || src.fleeTimer <= 0 || src.spreadDepth !== 0 || src.spreadDone) continue;
        src.spreadDone = true;
        for (let j = 0; j < this.peds.length; j++) {
          if (i === j) continue;
          const p = this.peds[j];
          if (p.dead || p.fleeTimer > 0) continue;
          if (p.witnessTimer > 0) continue; // someone already running for the cops keeps doing it
          const dx = p.pos.x - src.pos.x;
          const dz = p.pos.z - src.pos.z;
          if (dx * dx + dz * dz > SPREAD_RADIUS * SPREAD_RADIUS) continue;
          p.startFlee(src.pos.x, src.pos.z, 3.5, this, 1);
          this.stats.fleeSpreads += 1;
        }
      }
    }

    // keep the crowd near the player: far pedestrians are re-placed on a pavement around him
    this.flowTimer += dt;
    if (this.flowTimer > 2.2 && ctx.playerPos) {
      this.flowTimer = 0;
      for (let i = 0; i < this.peds.length; i++) {
        const p = this.peds[i];
        if (p.dead) continue;
        // a vendor belongs to its cart, not to the player: recycling it would teleport the shop
        if (p.vendor) continue;
        // never yank a body off a crossing: a teleport on the zebra both loses the crossing
        // and looks broken. The lane walk is what gets recycled.
        if (p.mode === 'cross') continue;
        if (p.pos.distanceTo(ctx.playerPos) > 80) {
          const spot = this.pavementPointNear(ctx.playerPos.x, ctx.playerPos.z, 14, 48) ||
            this.pavementPointNear(ctx.playerPos.x, ctx.playerPos.z, 8, 120);
          // no pavement in reach: leave the body where it is rather than teleport it into a shop
          if (spot) p.placeAt(spot.x, spot.z);
        }
      }
    }

    // recycle dead ones after a while so the street never empties
    this.respawnTimer += dt;
    if (this.respawnTimer > 4) {
      this.respawnTimer = 0;
      this.peds = this.peds.filter((p) => !p.dead);
      // the walking crowd is topped up to `count`; vendors stand outside that budget, so adding
      // shopkeepers cannot quietly thin the pedestrians out
      let walkers = 0;
      for (let i = 0; i < this.peds.length; i++) if (!this.peds[i].vendor) walkers += 1;
      while (walkers < this.count) {
        const spot = this.pavementPointNear(ctx.playerPos?.x ?? 0, ctx.playerPos?.z ?? 0, 8, 110) || this.randomPavementPoint();
        this.peds.push(new Ped(this.scene, this.city, spot, { id: this.peds.length, idler: this.peds.length % 12 === 0, mgr: this }));
        walkers += 1;
      }
      this.restaffVendors();
    }
  }

  nearest(point: any, maxDist = 60) {
    let best = null;
    let bd = maxDist;
    for (const p of this.peds) {
      if (p.dead) continue;
      const d = p.pos.distanceTo(point);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best ? { ped: best, dist: bd } : null;
  }
}
