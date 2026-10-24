import * as THREE from 'three';
import { Car } from '../vehicles/car';
import { LANE, RoadNav } from '../core/pathfinding';
import { clamp, angleDelta, rand, roundedBox } from '../core/utils';
import { Character } from '../actors/character';
import { plantOnGround } from '../actors/plant';

// A police officer is the same Character asset the player and the crowd are built from: navy
// shirt, navy trousers, the same head, hands and shoes. Only the colours and the peaked cap are
// the uniform. The old officer was four boxes (body, legs, head, cap) in one flat skin tone, so a
// cop read as a different species next to the player he was chasing.
const NAVY = 0x22304f;
const NAVY_DARK = 0x14161c;
const COP_SKIN = 0xd8a273;
// built once for the whole force: two cruisers per star, two officers per cruiser
const CAP_BAND_GEO = roundedBox(0.49, 0.14, 0.49, 0.03, 1);
const CAP_PEAK_GEO = roundedBox(0.42, 0.05, 0.17, 0.02, 1);
const CAP_BAND_MAT = new THREE.MeshStandardMaterial({ color: NAVY, roughness: 0.8, flatShading: true });
const CAP_PEAK_MAT = new THREE.MeshStandardMaterial({ color: NAVY_DARK, roughness: 0.55, flatShading: true });

/** A peaked cap that sits on the asset's own head, above the face, so the officer stays readable. */
function makeCap(): THREE.Group {
  const cap = new THREE.Group();
  // the skull is 0.22 m up the head joint and 0.22 m half-height, so the cap band rides at 0.45
  cap.position.set(0, 0.45, 0);
  const band = new THREE.Mesh(CAP_BAND_GEO, CAP_BAND_MAT);
  band.castShadow = true;
  cap.add(band);
  const peak = new THREE.Mesh(CAP_PEAK_GEO, CAP_PEAK_MAT);
  peak.position.set(0, -0.05, 0.31);
  peak.castShadow = true;
  cap.add(peak);
  return cap;
}

/**
 * Sit an officer so the lower sole touches the road.
 *
 * The same shared measure the player and the crowd use: the planted shoe's real lowest corner, not
 * the shoe centre minus half its height (see `src/actors/plant.ts`). The walk cycle lifts one foot, so
 * the height is measured off the shoes instead of a sine bob on the whole group.
 */

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
  /** the shared character asset this officer is built from (limbs, face, gun) */
  char: any;
  pos: THREE.Vector3;
  yaw: number;
  fireCd: number;
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

  /** Distance from the car to the last waypoint of its current route (Infinity without one). */
  private distToRouteEnd(entry: CopEntry, car: any): number {
    if (entry.points <= 0) return Infinity;
    const k = (entry.points - 1) * 2;
    return Math.hypot(car.pos.x - entry.path[k], car.pos.z - entry.path[k + 1]);
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

  /** Build one officer out of the city's own character asset: navy uniform, peaked cap, sidearm. */
  makeOfficer(x: number, z: number, yaw: number): Officer {
    const char = new Character({ skin: COP_SKIN, shirt: NAVY, pants: NAVY_DARK, hair: 'cap', face: 'calm' });
    char.setArmed(true);
    char.head.add(makeCap());
    // a random stride offset, so a squad does not march in lockstep
    char.phase = Math.random() * Math.PI * 2;
    const g = char.group;
    const y = this.city.groundHeightAt ? this.city.groundHeightAt(x, z) : 0;
    g.position.set(x, y, z);
    this.scene.add(g);
    const officer: Officer = {
      group: g,
      char,
      pos: new THREE.Vector3(x, y, z),
      yaw,
      fireCd: 1.2 + Math.random(),
      dead: false,
    };
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
      // The route now ends where the cruiser can legally stop, so "arrived at the end of the
      // route" is the signal to dismount and let the crew walk the last stretch behind the
      // building. Measure it against the geometry, not the index: a replan resets idx to 0 every
      // 0.7 s, and the endpoint of a route that cannot reach the player is a road point up to a
      // block away.
      const routeDone = entry.points > 0 && this.distToRouteEnd(entry, car) < 10;
      const canDeploy = this.wanted >= 2 && onFoot && stopped && !entry.crew && (dist < 28 || routeDone);
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

      // The last waypoint is not a point to swing past: it is where this cruiser parks. Without
      // this the pure-pursuit loop orbits the endpoint at its corner speed (measured: 7 m/s,
      // 88-108 m from the player, idx never advancing) and the crew can never dismount.
      const atRouteEnd = entry.points > 0 && entry.idx >= entry.points - 1;

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
      } else if (atRouteEnd) {
        // park at the end of the route: creep the last metres, then stand on the brake
        want = Math.min(want, Math.max(0, aimDist - 3));
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

    // officers leave the street when the heat dies, or when the chase has long moved on. The
    // radius is wider than the dismount range on purpose: a crew can get out at the end of a
    // route that stops short of the player (a block interior), and it has to be able to walk the
    // rest instead of being deleted the moment it appears.
    for (const o of [...this.officers]) {
      const far = Math.hypot(o.pos.x - playerPos.x, o.pos.z - playerPos.z);
      if (this.wanted === 0 || far > 120) this.killOfficer(o);
    }

    // officers on foot: close the gap, then shoot from cover distance
    for (const o of [...this.officers]) {
      if (o.dead) continue;
      const dx = playerPos.x - o.pos.x;
      const dz = playerPos.z - o.pos.z;
      const d = Math.hypot(dx, dz);
      o.yaw = Math.atan2(dx, dz);
      const walking = d > 11;
      if (walking) {
        const step = 3.6 * dt;
        o.pos.x += (dx / d) * step;
        o.pos.z += (dz / d) * step;
      }
      if (this.city.groundHeightAt) o.pos.y = this.city.groundHeightAt(o.pos.x, o.pos.z);
      o.group.position.copy(o.pos);
      o.group.rotation.y = o.yaw;
      // The officer now walks on the asset's own legs, so the body is posed by the shared walk
      // cycle - at the player's own cadence for 3.6 m/s - and stood on the road by its soles
      // instead of a sine bob on the whole group. The gun comes up when he has a clear line.
      const los = d < 26 && this.nav.clear(o.pos.x, o.pos.z, playerPos.x, playerPos.z, 0.6);
      // The stride offset is random so a squad does not march in lockstep, which means a stopped
      // officer would freeze mid-step: ease the cycle back to a neutral stance instead.
      if (!walking) {
        const neutral = Math.round(o.char.phase / Math.PI) * Math.PI;
        o.char.phase += (neutral - o.char.phase) * Math.min(1, dt * 7);
      }
      o.char.animate(dt, walking ? 0.5 : 0, { aiming: los });
      plantOnGround(o.char, o.pos.y);

      if (los) {
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
