import * as THREE from 'three';
import { Character } from './character';
import { clamp, rand, angleDelta } from '../core/utils';
import { PITCH, BLOCK, GRID } from '../world/city';

// ---------------------------------------------------------------- street metrics
// The city is a regular grid: blocks of BLOCK metres on a PITCH lattice, so the
// sidewalk loop, the kerb line and the crosswalk bands can all be derived from
// those two numbers instead of sampled from the mesh.
const ROAD = PITCH - BLOCK; // 14 m carriageway
const KERB = BLOCK / 2; // 19 m from a block centre to the kerb
const WALK_MIN = KERB - 2.8; // inner edge of the pedestrian lane band
const WALK_MAX = KERB - 1.6; // outer edge (still on the 0.26 m plate: ground drops at 18.4)
const HALF_ROAD = ROAD / 2; // 7 m from the intersection centre to the kerb
const STRIP_DEPTH = 3.4; // zebra band depth just outside the junction box
const RADIUS = 0.4; // pedestrian body radius
const FLEE_RADIUS = 18; // a gunshot scares everyone this close
const SPREAD_RADIUS = 12; // a fleeing pedestrian passes panic on
const AIM_RADIUS = 14; // someone pointing a gun at you is enough
const DETAIL_LOD = 30; // full character detail inside this range
const ANIM_LOD = 55; // stop animating limbs beyond this range
const HIDE_LOD = 110;
const CROSS_CHANCE = 0.45;
const CROSS_SPEED = 2.35; // brisk, but still a walk

// corner order around a block, clockwise: NW, NE, SE, SW
const CORNER_SX = [-1, 1, 1, -1];
const CORNER_SZ = [-1, -1, 1, 1];
// crossing options per corner: [dirX, dirZ, corner index on the block across the road]
const CROSS_OPTIONS: number[][][] = [
  [
    [-1, 0, 1],
    [0, -1, 3],
  ],
  [
    [1, 0, 0],
    [0, -1, 2],
  ],
  [
    [1, 0, 3],
    [0, 1, 1],
  ],
  [
    [-1, 0, 2],
    [0, 1, 0],
  ],
];

const _footV = new THREE.Vector3();
const _scratch: any[] = [];

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
  declare char: any;
  declare pos: any;
  declare yaw: any;
  declare speed: any;
  declare state: string;
  declare dead: boolean;
  declare target: any;
  declare id: number;

  // navigation: the sidewalk ring of the block we are walking, plus the corner we head for
  declare bx: number;
  declare bz: number;
  declare ring: number;
  declare ci: number;
  declare step: number;
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
  declare destBx: number;
  declare destBz: number;
  declare destCi: number;
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
  declare stuckT: number;
  declare lastX: number;
  declare lastZ: number;
  declare detailOn: boolean;
  declare moved: number;
  declare partner: any;
  declare leader: any;
  declare talkPhase: number;

  constructor(scene: THREE.Scene, city: any, position: any, opts: any = {}) {
    this.scene = scene;
    this.city = city;
    this.id = opts.id ?? 0;
    this.char = new Character({ scale: rand(0.92, 1.05) });
    this.pos = position.clone();
    this.pos.y = city.groundHeightAt(this.pos.x, this.pos.z);
    this.yaw = rand(0, Math.PI * 2);
    this.walkSpeed = rand(1.25, 1.85);
    this.runSpeed = rand(4.4, 5.4);
    this.speed = this.walkSpeed;
    this.state = 'walk';
    this.dead = false;
    this.target = this.pos.clone();
    this.ring = rand(WALK_MIN, WALK_MAX);
    this.step = Math.random() < 0.5 ? 1 : -1;
    this.mode = 'walk';
    this.waiting = false;
    this.waitT = 0;
    this.lookT = 0;
    this.crossT = 0;
    this.crossLen = PITCH - this.ring * 2;
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
    this.idler = opts.idler ?? Math.random() < 0.08;
    this.idleKind = ['phone', 'smoke', 'look'][Math.floor(rand(0, 3))];
    this.idleTimer = this.idler ? rand(4, 9) : 0;
    this.idleCd = 0;
    this.stateT = 0;
    this.blocked = false;
    this.avoidT = 0;
    this.avoidSign = 1;
    this.stuckT = 0;
    this.lastX = this.pos.x;
    this.lastZ = this.pos.z;
    this.detailOn = true;
    this.moved = 0;
    this.partner = null;
    this.leader = null;
    this.talkPhase = rand(0, 10);

    this.repath();
    this.scene.add(this.char.group);
    this.char.group.position.copy(this.pos);
    this.char.group.rotation.y = this.yaw;
  }

  get radius() {
    return RADIUS;
  }

  headPos() {
    return new THREE.Vector3(this.pos.x, this.pos.y + 1.55, this.pos.z);
  }

  // ------------------------------------------------------------ sidewalk graph
  private cornerX(ci: number) {
    return this.bx + CORNER_SX[ci] * this.ring;
  }

  private cornerZ(ci: number) {
    return this.bz + CORNER_SZ[ci] * this.ring;
  }

  /** Re-anchor the ring walk to the block the pedestrian is standing on. */
  repath() {
    this.bx = Math.round(this.pos.x / PITCH) * PITCH;
    this.bz = Math.round(this.pos.z / PITCH) * PITCH;
    this.bx = clamp(this.bx, -GRID * PITCH, GRID * PITCH);
    this.bz = clamp(this.bz, -GRID * PITCH, GRID * PITCH);
    this.mode = 'walk';
    this.waiting = false;
    this.crossBack = false;
    this.spreadDepth = 0;
    this.spreadDone = false;
    // face the nearest corner and walk at it
    let best = 0;
    let bd = Infinity;
    for (let ci = 0; ci < 4; ci++) {
      const dx = this.cornerX(ci) - this.pos.x;
      const dz = this.cornerZ(ci) - this.pos.z;
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        best = ci;
      }
    }
    this.ci = best;
    this.setTarget(this.cornerX(best), this.cornerZ(best));
  }

  private setTarget(x: number, z: number) {
    this.tx = x;
    this.tz = z;
    this.target.set(x, this.pos.y, z);
  }

  private advanceCorner() {
    this.ci = (this.ci + this.step + 4) % 4;
    this.setTarget(this.cornerX(this.ci), this.cornerZ(this.ci));
  }

  /** True when the point is on the same block plate (no road in between). */
  private sameBlock(x: number, z: number) {
    return Math.abs(Math.round(x / PITCH) * PITCH - this.bx) < 1 && Math.abs(Math.round(z / PITCH) * PITCH - this.bz) < 1;
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
    this.state = 'flee';
    this.stateT = 0;
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
      if (Math.abs(along) > HALF_ROAD + 3) continue;
      if (Math.abs(across) > 11) continue; // 11 m of road either side of the crossing
      return true;
    }
    return false;
  }

  /** True when (x,z) is on the carriageway, not on a kerb lip. */
  private onCarriageway(x: number, z: number) {
    const fx = ((x / PITCH) % 1 + 1) % 1;
    const fz = ((z / PITCH) % 1 + 1) % 1;
    return Math.abs(fx - 0.5) * PITCH <= HALF_ROAD || Math.abs(fz - 0.5) * PITCH <= HALF_ROAD;
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

  /** Push the body out of building footprints; never let the centre enter one. */
  private pushOut(grid: ColliderGrid) {
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
      this.blocked = true;
    }
  }

  // ------------------------------------------------------------ state updates
  private updateWalk(dt: number, ctx: any, mgr: any) {
    if (this.speed < 0.05) return; // pinned by a test harness: stand still
    this.speed = this.walkSpeed;

    // pairs: the follower shadows the leader's corner while both are on the block
    const L = this.leader;
    if (L && !L.dead && L.state === 'walk' && L.mode === 'walk' && !L.waiting && this.sameBlock(L.tx, L.tz)) {
      this.tx = L.tx;
      this.tz = L.tz;
      this.target.set(this.tx, this.pos.y, this.tz);
      this.moveToward(this.tx, this.tz, this.speed, dt);
      return;
    }

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
        // nobody is letting me through; walk my block instead
        this.waiting = false;
        this.mode = 'walk';
        this.advanceCorner();
      }
      return;
    }

    if (this.mode === 'cross') {
      this.updateCrossing(dt, ctx, mgr);
      return;
    }

    const dx = this.tx - this.pos.x;
    const dz = this.tz - this.pos.z;
    if (dx * dx + dz * dz < 0.81) {
      this.arriveCorner(ctx, mgr);
      return;
    }
    this.moveToward(this.tx, this.tz, this.speed, dt);
  }

  private arriveCorner(ctx: any, mgr: any) {
    if (this.mode === 'cross') {
      this.finishCrossing(mgr);
      return;
    }
    // sometimes cross the road at the junction instead of turning the corner
    if (Math.random() < CROSS_CHANCE) {
      const options = CROSS_OPTIONS[this.ci];
      const opt = options[Math.random() < 0.5 ? 0 : 1];
      const nbx = clamp(this.bx + opt[0] * PITCH, -GRID * PITCH, GRID * PITCH);
      const nbz = clamp(this.bz + opt[1] * PITCH, -GRID * PITCH, GRID * PITCH);
      if (nbx !== this.bx || nbz !== this.bz) {
        this.crossFromX = this.cornerX(this.ci);
        this.crossFromZ = this.cornerZ(this.ci);
        this.crossDx = opt[0];
        this.crossDz = opt[1];
        this.mode = 'cross';
        this.waiting = true;
        this.waitT = 0;
        this.lookT = 0;
        this.crossBack = false;
        this.samples.length = 0;
        this.destBx = nbx;
        this.destBz = nbz;
        this.destCi = opt[2];
        this.setTarget(
          nbx + CORNER_SX[opt[2]] * this.ring,
          nbz + CORNER_SZ[opt[2]] * this.ring
        );
        return;
      }
    }
    this.advanceCorner();
  }

  private updateCrossing(dt: number, ctx: any, mgr: any) {
    const onRoad = this.onCarriageway(this.pos.x, this.pos.z);
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
      if (this.onCarriageway(this.pos.x, this.pos.z)) {
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
    }
  }

  private finishCrossing(mgr: any) {
    mgr.logCrossing(this);
    this.mode = 'walk';
    this.waiting = false;
    this.crossBack = false;
    this.bx = this.destBx;
    this.bz = this.destBz;
    this.ci = this.destCi;
    this.samples.length = 0;
    this.advanceCorner();
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

  // ------------------------------------------------------------ pose
  private pose(dt: number) {
    const ch = this.char;
    let headYaw = 0;
    let headPitch = 0;
    let armX: number | null = null;
    let armZ = 0;
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
      ch.armL.rotation.x = armX;
      ch.armR.rotation.x = armX;
      ch.armL.rotation.z = armZ;
      ch.armR.rotation.z = -armZ;
    }
    if (legX !== null) {
      ch.legL.rotation.x = legX;
      ch.legR.rotation.x = legX;
    }
    ch.head.rotation.y = headYaw;
    ch.head.rotation.x = headPitch;
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

    const next = this.fleeTimer > 0 ? 'flee' : this.witnessTimer > 0 ? 'witness' : this.cowerTimer > 0 ? 'cower' : this.idleTimer > 0 ? 'idle' : 'walk';
    if (next !== this.state) {
      this.state = next;
      this.stateT = 0;
      if (next !== 'walk') {
        this.waiting = false;
        this.mode = 'walk';
      }
    }

    const x0 = this.pos.x;
    const z0 = this.pos.z;
    if (this.state === 'flee') this.updateFlee(dt, ctx, mgr);
    else if (this.state === 'witness') this.updateWitness(dt, ctx, mgr);
    else if (this.state === 'cower') this.updateCower(dt);
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

    this.pos.x = clamp(this.pos.x, -220, 220);
    this.pos.z = clamp(this.pos.z, -220, 220);
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
export class PedManager {
  declare scene: any;
  declare city: any;
  declare peds: any[];
  declare count: any;
  declare respawnTimer: number;
  declare flowTimer: number;
  declare grid: ColliderGrid;
  declare strips: any[];
  declare stats: any;
  declare crossingLog: any[];
  declare ctx: any;
  declare simTime: number;
  declare spreadTimer: number;
  declare pairs: number;

  constructor(scene: THREE.Scene, city: any, count = 34) {
    this.scene = scene;
    this.city = city;
    this.count = count;
    this.peds = [];
    this.grid = new ColliderGrid(city.colliders || []);
    this.strips = this.buildCrosswalkStrips();
    this.stats = { fleeEvents: 0, fleeSpreads: 0, witnessEvents: 0, witnessWanted: 0, cowerEvents: 0, crossings: 0, crossingsOnStrip: 0, crossAborts: 0 };
    this.crossingLog = [];
    this.simTime = 0;
    this.spreadTimer = 0;
    this.pairs = 0;
    this.ctx = null;
    for (let i = 0; i < count; i++) {
      this.peds.push(new Ped(scene, city, city.randomSidewalkPointNear(110), { id: i, idler: i % 12 === 0 }));
    }
    // roughly a third of the crowd walks in pairs
    for (let i = 0; i + 1 < this.peds.length; i += 3) {
      const a = this.peds[i];
      const b = this.peds[i + 1];
      if (!a || !b) continue;
      a.partner = b;
      b.partner = a;
      b.leader = a;
      this.pairs += 1;
    }
    this.respawnTimer = 0;
    this.flowTimer = 0;
  }

  /** Zebra bands just outside every junction box, on the carriageway. */
  buildCrosswalkStrips() {
    const strips: any[] = [];
    for (let i = -GRID; i < GRID; i++) {
      for (let j = -GRID; j < GRID; j++) {
        const x0 = (i + 0.5) * PITCH;
        const z0 = (j + 0.5) * PITCH;
        // crossings of the north-south road (walk east-west) sit north and south of the box
        strips.push({ minX: x0 - HALF_ROAD, maxX: x0 + HALF_ROAD, minZ: z0 + HALF_ROAD, maxZ: z0 + HALF_ROAD + STRIP_DEPTH });
        strips.push({ minX: x0 - HALF_ROAD, maxX: x0 + HALF_ROAD, minZ: z0 - HALF_ROAD - STRIP_DEPTH, maxZ: z0 - HALF_ROAD });
        // crossings of the east-west road (walk north-south) sit east and west of the box
        strips.push({ minX: x0 + HALF_ROAD, maxX: x0 + HALF_ROAD + STRIP_DEPTH, minZ: z0 - HALF_ROAD, maxZ: z0 + HALF_ROAD });
        strips.push({ minX: x0 - HALF_ROAD - STRIP_DEPTH, maxX: x0 - HALF_ROAD, minZ: z0 - HALF_ROAD, maxZ: z0 + HALF_ROAD });
      }
    }
    return strips;
  }

  isOnCrosswalk(x: number, z: number) {
    for (let i = 0; i < this.strips.length; i++) {
      const s = this.strips[i];
      if (x >= s.minX && x <= s.maxX && z >= s.minZ && z <= s.maxZ) return true;
    }
    return false;
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

    // keep the crowd near the player: far pedestrians get re-placed around him
    this.flowTimer += dt;
    if (this.flowTimer > 2.2 && ctx.playerPos) {
      this.flowTimer = 0;
      for (let i = 0; i < this.peds.length; i++) {
        const p = this.peds[i];
        if (p.dead) continue;
        if (p.pos.distanceTo(ctx.playerPos) > 80) {
          const spot = this.city.randomSidewalkPointAround(ctx.playerPos, 14, 48);
          p.pos.copy(spot);
          p.pos.y = this.city.groundHeightAt(p.pos.x, p.pos.z);
          p.repath();
          p.char.group.position.copy(p.pos);
        }
      }
    }

    // recycle dead ones after a while so the street never empties
    this.respawnTimer += dt;
    if (this.respawnTimer > 4) {
      this.respawnTimer = 0;
      this.peds = this.peds.filter((p) => !p.dead);
      while (this.peds.length < this.count) {
        this.peds.push(new Ped(this.scene, this.city, this.city.randomSidewalkPointNear(110), { id: this.peds.length, idler: this.peds.length % 12 === 0 }));
      }
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
