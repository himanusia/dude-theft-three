import * as THREE from 'three';
import { Car } from '../vehicles/car';
import { LANE, RoadNav } from '../core/pathfinding';
import { clamp, angleDelta, rand } from '../core/utils';

// Cruisers navigate the road grid instead of aiming at the player through walls:
// RoadNav gives a lane-accurate waypoint list, this module drives the list with the
// ordinary throttle/steer physics and falls back to a straight chase when the target
// is visible or inside ramming range.
const REPLAN = 0.7; // seconds between path recomputes
const REPLAN_MOVE = 8; // metres the target may drift before the path is rebuilt
const DIRECT_NEAR = 8; // always drive straight at a target this close
const DIRECT_SIGHT = 26; // chase straight at a target we can see this close
const SIGHT_PAD = 2; // clearance used to decide whether the target is in plain sight
const ARRIVE = 5.5; // waypoint is considered reached inside this radius
const CRUISE = 24; // m/s target on a clear straight

interface CopEntry {
  car: any;
  stuck: number;
  reverse: number;
  far: number;
  /** flat (x, z) waypoint list owned by RoadNav */
  path: number[];
  points: number;
  idx: number;
  timer: number;
  goalX: number;
  goalZ: number;
  aimX: number;
  aimZ: number;
  lastBump?: number;
  /** true once this cruiser has dropped its two officers on foot */
  crew?: boolean;
  lastRam?: number;
}

export interface Officer {
  group: any;
  pos: THREE.Vector3;
  yaw: number;
  fireCd: number;
  phase: number;
  dead: boolean;
}

export class Police {
  declare scene: any;
  declare city: any;
  declare audio: any;
  declare cars: CopEntry[];
  declare wanted: number;
  declare crimeCooldown: number;
  declare shootTimer: number;
  declare arrestProgress: number;
  declare maxCars: number;
  declare nav: RoadNav;
  declare officers: Officer[];

  constructor(scene: THREE.Scene, city: any, audio: any) {
    this.scene = scene;
    this.city = city;
    this.audio = audio;
    this.cars = [];
    this.wanted = 0;
    this.crimeCooldown = 0;
    this.shootTimer = 0;
    this.arrestProgress = 0;
    this.maxCars = 5;
    this.nav = new RoadNav(city.colliders);
    this.officers = [];
  }

  get starCount() {
    return Math.floor(clamp(this.wanted, 0, 5));
  }

  addWanted(n: number) {
    const before = this.starCount;
    this.wanted = clamp(this.wanted + n, 0, 5);
    this.crimeCooldown = 26;
    return this.starCount > before;
  }

  clearWanted() {
    this.wanted = 0;
    this.crimeCooldown = 0;
    this.arrestProgress = 0;
    this.cars.forEach((c) => c.car.dispose());
    this.cars = [];
    this.audio.siren(false);
  }

  spawnCar(playerPos: any, camYaw = 0) {
    // Drop the cruiser on a road lane behind or beside the camera, never in shot: the first
    // candidate inside the 130-degree view cone is rejected, so a chase starts off-screen.
    let snap = null as any;
    let best = null as any;
    for (let attempt = 0; attempt < 14; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = rand(55, 95);
      const candidate = this.nav.snapToRoad(playerPos.x + Math.cos(angle) * radius, playerPos.z + Math.sin(angle) * radius);
      const toSpawn = Math.atan2(candidate.x - playerPos.x, candidate.z - playerPos.z);
      const behind = Math.abs(angleDelta(camYaw, toSpawn)) > (130 * Math.PI) / 360;
      best = candidate;
      if (behind) { snap = candidate; break; }
    }
    if (!snap) snap = best;
    if (!snap) return;
    const along = snap.axis === 0 ? (playerPos.z >= snap.z ? 1 : -1) : (playerPos.x >= snap.x ? 1 : -1);
    const dx = snap.axis === 0 ? 0 : along;
    const dz = snap.axis === 0 ? along : 0;

    const p = new THREE.Vector3(snap.x - dz * LANE, 0, snap.z + dx * LANE);
    const car = new Car(this.scene, { type: 'police', police: true, position: p, yaw: Math.atan2(dx, dz) });
    car.addDriver(0xd8a273, 0x1f3a6e);
    const entry: CopEntry = {
      car,
      stuck: 0,
      reverse: 0,
      far: 0,
      path: [],
      points: 0,
      idx: 0,
      timer: 0,
      goalX: p.x,
      goalZ: p.z,
      aimX: p.x,
      aimZ: p.z,
    };
    this.cars.push(entry);
    return entry;
  }

  /** Rebuild this cruiser's waypoint list (deterministic A* on the road grid). */
  private plan(entry: CopEntry, playerPos: any) {
    const car = entry.car;
    entry.points = this.nav.findPath(car.pos.x, car.pos.z, playerPos.x, playerPos.z, entry.path);
    entry.goalX = playerPos.x;
    entry.goalZ = playerPos.z;
    entry.idx = 0;
    entry.timer = REPLAN;
    if (entry.points === 0) {
      entry.aimX = playerPos.x;
      entry.aimZ = playerPos.z;
    }
  }

  /** Pure-pursuit lookahead: aim at a point ~8-22 m further along the polyline. */
  private aim(entry: CopEntry, car: any) {
    const path = entry.path;
    const n = entry.points;
    let i = entry.idx;
    const fwdX = Math.sin(car.yaw);
    const fwdZ = Math.cos(car.yaw);
    while (i < n - 1) {
      const dx = path[i * 2] - car.pos.x;
      const dz = path[i * 2 + 1] - car.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= ARRIVE * ARRIVE) {
        i++;
        continue;
      }
      // overshot a corner: the waypoint is behind us, give up on it
      if (d2 < 400 && dx * fwdX + dz * fwdZ < 0) {
        i++;
        continue;
      }
      break;
    }
    entry.idx = i;

    let ax = path[i * 2];
    let az = path[i * 2 + 1];
    let ahead = Math.hypot(ax - car.pos.x, az - car.pos.z);
    const look = clamp(7 + Math.abs(car.speed) * 0.5, 8, 20);
    while (i < n - 1 && ahead < look) {
      const nx = path[(i + 1) * 2];
      const nz = path[(i + 1) * 2 + 1];
      // stop at a corner instead of looking past it, or the car turns in early and
      // clips the kerb on the inside of the block
      const turn = Math.abs(angleDelta(Math.atan2(ax - car.pos.x, az - car.pos.z), Math.atan2(nx - ax, nz - az)));
      if (turn > 0.3) break;
      ahead += Math.hypot(nx - ax, nz - az);
      i++;
      ax = nx;
      az = nz;
    }
    entry.aimX = ax;
    entry.aimZ = az;
  }

  /**
   * Speed the car may still carry into the next corner of its path. The corner is
   * only as tight as the steering lock allows at that speed, so the cruiser brakes
   * before the turn instead of ploughing onto the kerb.
   */
  private cornerLimit(entry: CopEntry, car: any) {
    const path = entry.path;
    const n = entry.points;
    let travel = 0;
    let px = car.pos.x;
    let pz = car.pos.z;
    for (let k = entry.idx; k + 1 < n && travel < 60; k++) {
      const x1 = path[k * 2];
      const z1 = path[k * 2 + 1];
      travel += Math.hypot(x1 - px, z1 - pz);
      const x2 = path[(k + 1) * 2];
      const z2 = path[(k + 1) * 2 + 1];
      const turn = Math.abs(angleDelta(Math.atan2(x1 - px, z1 - pz), Math.atan2(x2 - x1, z2 - z1)));
      if (turn > 0.25) {
        // v^2 = 2 * a * s: cruise until the braking distance matches the corner speed
        const byDistance = Math.sqrt(2 * 10 * Math.max(0.5, travel - 2));
        const byTurn = 30 - Math.min(0.8, turn) * 26;
        return Math.min(CRUISE, Math.max(byTurn, byDistance));
      }
      px = x2;
      pz = z2;
    }
    return CRUISE;
  }

  /** Build one officer: navy shirt, cap, boots — four draws, cheap enough for a squad. */
  makeOfficer(x: number, z: number, yaw: number): Officer {
    const g = new THREE.Group();
    const navy = new THREE.MeshStandardMaterial({ color: 0x22304f, roughness: 0.85, flatShading: true });
    const skin = new THREE.MeshStandardMaterial({ color: 0xd8a273, roughness: 0.85, flatShading: true });
    const dark = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.9, flatShading: true });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.74, 0.28), navy);
    body.position.y = 1.03;
    body.castShadow = true;
    g.add(body);
    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.68, 0.26), dark);
    legs.position.y = 0.34;
    legs.castShadow = true;
    g.add(legs);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), skin);
    head.position.y = 1.55;
    head.castShadow = true;
    g.add(head);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.34), navy);
    cap.position.y = 1.73;
    g.add(cap);
    const y = this.city.groundHeightAt ? this.city.groundHeightAt(x, z) : 0;
    g.position.set(x, y, z);
    this.scene.add(g);
    const officer: Officer = { group: g, pos: new THREE.Vector3(x, y, z), yaw, fireCd: 1.2 + Math.random(), phase: Math.random() * 6, dead: false };
    this.officers.push(officer);
    return officer;
  }

  /** Nearest officer along a shot ray, so the player can actually hit them. */
  raycastOfficer(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): { officer: Officer; dist: number } | null {
    let best: { officer: Officer; dist: number } | null = null;
    for (const o of this.officers) {
      if (o.dead) continue;
      const cx = o.pos.x - origin.x;
      const cy = o.pos.y + 1.1 - origin.y;
      const cz = o.pos.z - origin.z;
      const t = cx * dir.x + cy * dir.y + cz * dir.z;
      if (t < 1.5 || t > maxDist) continue;
      const px = origin.x + dir.x * t - o.pos.x;
      const py = origin.y + dir.y * t - (o.pos.y + 1.1);
      const pz = origin.z + dir.z * t - o.pos.z;
      if (Math.hypot(px, py, pz) > 0.5) continue;
      if (!best || t < best.dist) best = { officer: o, dist: t };
    }
    return best;
  }

  killOfficer(o: Officer) {
    o.dead = true;
    this.scene.remove(o.group);
    const i = this.officers.indexOf(o);
    if (i >= 0) this.officers.splice(i, 1);
  }

  update(dt: number, ctx: any) {
    const { playerPos, onFoot, camYaw = 0 } = ctx;

    if (this.wanted > 0) {
      this.crimeCooldown -= dt;
      if (this.crimeCooldown <= 0 && this.wanted > 0) {
        this.wanted = Math.max(0, this.wanted - dt * 0.14);
      }
    }

    const targetCount = Math.min(this.maxCars, this.starCount);
    while (this.cars.length < targetCount) this.spawnCar(playerPos, camYaw);

    if (this.wanted > 0) this.audio.siren(true);
    else this.audio.siren(false);

    let nearestCop = null;
    let nearestDist = 1e9;

    for (const entry of this.cars) {
      const car = entry.car;
      const dx = playerPos.x - car.pos.x;
      const dz = playerPos.z - car.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestCop = car;
      }

      if (car.wrecked) {
        car.update(dt, { throttle: 0, steer: 0, brake: true }, this.city.colliders, this.city.bound);
        continue;
      }

      // Dismount: once the cruiser has stopped near a player on foot, two officers get out and
      // come for them, GTA-style, instead of the fight happening through the windscreen.
      const stopped = Math.abs(car.speed) < 3.5;
      const canDeploy = this.wanted >= 2 && onFoot && dist < 28 && stopped && !entry.crew;
      if (canDeploy) {
        entry.crew = true;
        const rx = Math.cos(car.yaw);
        const rz = -Math.sin(car.yaw);
        for (const side of [-1, 1]) {
          this.makeOfficer(car.pos.x + rx * side * 1.7, car.pos.z + rz * side * 1.7, car.yaw);
        }
      } else if (entry.crew && (!onFoot || dist > 80 || this.wanted === 0)) {
        // the chase moved on: officers jog back and the cruiser takes over again
        entry.crew = false;
        // only pull back the ones still standing beside this cruiser; anyone already running
        // at the player stays in the fight
        for (const o of [...this.officers]) {
          if (Math.hypot(o.pos.x - car.pos.x, o.pos.z - car.pos.z) < 4.5) this.killOfficer(o);
        }
      }

      // straight chase when the target is close or in plain sight, otherwise follow
      // the road path so the cruiser rounds the block instead of driving into it
      const visible = this.nav.clear(car.pos.x, car.pos.z, playerPos.x, playerPos.z, SIGHT_PAD);
      const direct = dist < DIRECT_NEAR || (visible && dist < DIRECT_SIGHT);
      entry.timer -= dt;
      if (direct) {
        entry.timer = 0;
        entry.aimX = playerPos.x;
        entry.aimZ = playerPos.z;
      } else {
        const drift = Math.hypot(playerPos.x - entry.goalX, playerPos.z - entry.goalZ);
        if (entry.timer <= 0 || drift > REPLAN_MOVE || entry.points === 0) this.plan(entry, playerPos);
        if (entry.points > 0) this.aim(entry, car);
        else {
          entry.aimX = playerPos.x;
          entry.aimZ = playerPos.z;
        }
      }

      const aimX = entry.aimX - car.pos.x;
      const aimZ = entry.aimZ - car.pos.z;
      const aimDist = Math.hypot(aimX, aimZ) || 1;
      const err = angleDelta(car.yaw, Math.atan2(aimX, aimZ));
      let steer = clamp(err * 2.2, -1, 1);

      // speed target: slow for steering error, for the coming corner, and for the target
      let want = CRUISE;
      const turn = Math.abs(err);
      if (turn > 0.4) want = 13;
      if (turn > 1.0) want = 7;
      if (!direct) want = Math.min(want, this.cornerLimit(entry, car));
      if (direct) {
        if (dist < 14) want = Math.min(want, 8);
        if (dist < 6.5) want = 0;
      } else if (aimDist < 9) {
        want = Math.min(want, 10);
      }

      let throttle = clamp((want - car.speed) / 5, 0.25, 1);
      let brake = false;
      if (want <= 0) {
        throttle = 0;
        brake = Math.abs(car.speed) > 2;
      } else if (car.speed > want + 2.5) {
        throttle = 0;
        brake = true;
      } else if (car.speed > want) {
        throttle = 0;
      }

      // reverse out when wedged against something we cannot steer around
      if (Math.abs(car.speed) < 1.2 && dist > 6 && want > 3) entry.stuck += dt;
      else entry.stuck = Math.max(0, entry.stuck - dt * 0.6);
      if (entry.stuck > 1.5) {
        entry.reverse = 1.1;
        entry.stuck = 0;
        entry.timer = 0;
      }
      if (entry.reverse > 0) {
        entry.reverse -= dt;
        car.update(dt, { throttle: -1, steer: -steer, brake: false }, this.city.colliders, this.city.bound);
        continue;
      }

      const hit = car.update(dt, { throttle, steer, brake }, this.city.colliders, this.city.bound);
      if (hit) {
        if (hit.impact > 8) {
          this.audio.play('crash', { vol: clamp(hit.impact / 40, 0.1, 0.7), pan: this.panFor(car.pos, playerPos) });
        }
        if (hit.impact > 4) entry.stuck += 0.35;
      }
    }

    // officers leave the street when the heat dies, or when the chase has long moved on
    for (const o of [...this.officers]) {
      const far = Math.hypot(o.pos.x - playerPos.x, o.pos.z - playerPos.z);
      if (this.wanted === 0 || far > 90) this.killOfficer(o);
    }

    // officers on foot: close the gap, then shoot from cover distance
    for (const o of [...this.officers]) {
      if (o.dead) continue;
      const dx = playerPos.x - o.pos.x;
      const dz = playerPos.z - o.pos.z;
      const d = Math.hypot(dx, dz);
      o.yaw = Math.atan2(dx, dz);
      if (d > 11) {
        const step = 3.6 * dt;
        o.pos.x += (dx / d) * step;
        o.pos.z += (dz / d) * step;
        o.phase += dt * 9;
      } else {
        o.phase += dt * 1.5;
      }
      if (this.city.groundHeightAt) o.pos.y = this.city.groundHeightAt(o.pos.x, o.pos.z);
      o.group.position.copy(o.pos);
      o.group.rotation.y = o.yaw;
      o.group.position.y += Math.abs(Math.sin(o.phase)) * 0.05;

      if (d < 26 && this.nav.clear(o.pos.x, o.pos.z, playerPos.x, playerPos.z, 0.6)) {
        o.fireCd -= dt;
        if (o.fireCd <= 0) {
          o.fireCd = clamp(1.9 - this.wanted * 0.15, 0.7, 1.9);
          const dmg = 3 + this.wanted * 0.8;
          ctx.onCopShoot?.(o.pos.clone(), dmg);
          ctx.onCopFire?.(o.pos.clone(), playerPos.clone());
        }
      }
    }

    // shooting: wanted >= 2, cop nearby, has line of sight-ish
    if (this.wanted >= 2 && nearestCop && nearestDist < 34) {
      this.shootTimer -= dt;
      if (this.shootTimer <= 0) {
        this.shootTimer = clamp(2.4 - this.wanted * 0.2, 0.9, 2.4);
        const dmg = 2 + this.wanted * 0.7;
        ctx.onCopShoot?.(nearestCop.pos.clone(), dmg);
      }
    }

    // arrest: cop car close & slow while player is on foot
    if (onFoot && nearestCop && nearestDist < 4.2 && Math.abs(nearestCop.speed) < 4) {
      this.arrestProgress += dt;
      if (this.arrestProgress > 2.8) {
        this.arrestProgress = 0;
        ctx.onArrest?.();
      }
    } else {
      this.arrestProgress = Math.max(0, this.arrestProgress - dt * 0.8);
    }

    // cruisers that get stranded too far away are recycled closer to the player
    this.cars = this.cars.filter((e) => {
      const d = Math.hypot(e.car.pos.x - playerPos.x, e.car.pos.z - playerPos.z);
      if (d > 130) {
        e.far = (e.far ?? 0) + dt;
        if (e.far > 4) {
          e.car.dispose();
          return false;
        }
      } else {
        e.far = 0;
      }
      return true;
    });
  }

  panFor(pos: any, listener: any) {
    const dx = pos.x - listener.x;
    const dz = pos.z - listener.z;
    const d = Math.hypot(dx, dz) || 1;
    return clamp(dx / d, -1, 1) * 0.6;
  }

  clearAll() {
    this.cars.forEach((e) => e.car.dispose());
    this.cars = [];
    this.audio.siren(false);
  }
}
