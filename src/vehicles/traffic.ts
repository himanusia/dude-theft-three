import * as THREE from 'three';
import { Car, driverLook } from './car';
import { RoadNav } from '../core/pathfinding';
import { ARTERIALS, RING_ROAD } from '../world/jakartamap';
import { clamp, angleDelta, pick, rand } from '../core/utils';

// Ambient traffic that drives the road network the map defines. It used to follow a lattice of
// intersections, which stopped existing when the city moved to the Jakarta layout: cars drove
// straight through blocks. Each car now asks RoadNav for a route to a random point on the
// network and follows the waypoints, the same way a police cruiser does.
//
// Density is a budget, not a wish: the streets have to read as a city when the player stands at
// a junction, so the population is recycled into the ring of road around the player instead of
// being scattered over 2.4 km of map, and only the cars inside `LIVE_R` run physics and draw.
// A frozen car is also hidden, so 26 cars cost no more draw calls than the 8 did.

const ARRIVE = 7;
/** Cars further than this from the player are hidden and not stepped. */
const LIVE_R = 210;
/** Where a recycled car is put, measured from the player: near enough to be seen driving. */
const SPAWN_MIN = 40;
const SPAWN_MAX = 130;
/** A car this far away is not part of the local street any more: move it back. */
const RECYCLE_R = 320;

const ROADS = [...ARTERIALS.map((a) => ({ path: a.path, width: a.width })), { path: RING_ROAD, width: 20 }];

export class Traffic {
  declare scene: any;
  declare city: any;
  declare cars: any[];
  declare flowTimer: any;
  declare nav: any;
  /** candidate asphalt points, one every ~12 m of every road, in the right-hand lane */
  declare spots: { x: number; z: number }[];

  constructor(scene: THREE.Scene, city: any, count = 26) {
    this.scene = scene;
    this.city = city;
    this.nav = new RoadNav(city.colliders);
    this.cars = [];
    this.flowTimer = 0;
    this.spots = this.buildSpots();
    const home = city?.getSpawn ? city.getSpawn() : null;
    const types = ['sedan', 'sedan', 'taxi', 'muscle', 'van', 'angkot'];
    for (let n = 0; n < count; n++) {
      const start = this.randomRoadPoint(home);
      const car = new Car(scene, {
        type: pick(types),
        position: new THREE.Vector3(start.x, 0, start.z),
        yaw: 0,
        simple: true,
      });
      car.addDriver(...driverLook());
      const entry: any = { car, path: [], points: 0, idx: 0, retarget: 0 };
      this.cars.push(entry);
      this.retarget(entry);
      this.faceRoute(entry);
    }
  }

  /**
   * Point a car down its own first leg. A car spawned with a random heading that is more than
   * 40 degrees off its route cannot recover: the steering only turns the car while it is rolling,
   * and the steering error cuts the throttle below the speed at which the physics zeroes it. That
   * is what left most of the population standing at the kerb for the whole session.
   */
  faceRoute(entry: any) {
    const tx = entry.path[0];
    const tz = entry.path[1];
    if (tx === undefined) return;
    const yaw = Math.atan2(tx - entry.car.pos.x, tz - entry.car.pos.z);
    entry.car.yaw = yaw;
    entry.car.mesh.rotation.y = yaw;
  }

  /** Every ~12 m of every road, offset into the lane a car drives in. */
  buildSpots() {
    const spots: { x: number; z: number }[] = [];
    for (const road of ROADS) {
      const pts = road.path;
      const off = Math.max(1.5, road.width / 2 - 3.2);
      for (let i = 0; i < pts.length - 1; i++) {
        const [x1, z1] = pts[i];
        const [x2, z2] = pts[i + 1];
        const len = Math.hypot(x2 - x1, z2 - z1) || 1;
        const nx = -(z2 - z1) / len;
        const nz = (x2 - x1) / len;
        const steps = Math.max(1, Math.round(len / 12));
        for (let k = 0; k < steps; k++) {
          const t = (k + 0.5) / steps;
          spots.push({ x: x1 + (x2 - x1) * t + nx * off, z: z1 + (z2 - z1) * t + nz * off });
        }
      }
    }
    return spots;
  }

  /**
   * A point on the asphalt, in the right-hand lane. With an `origin` the point is drawn from the
   * ring around that origin, which is what keeps the streets the player is looking at busy.
   */
  randomRoadPoint(origin?: { x: number; z: number } | null) {
    if (origin && this.spots.length) {
      const near: { x: number; z: number }[] = [];
      for (const s of this.spots) {
        const d = Math.hypot(s.x - origin.x, s.z - origin.z);
        if (d >= SPAWN_MIN && d <= SPAWN_MAX) near.push(s);
      }
      if (near.length) {
        const s = near[Math.floor(rand(0, near.length - 1))];
        return { x: s.x + rand(-2, 2), z: s.z + rand(-2, 2) };
      }
    }
    const road = pick(ROADS);
    const pts = road.path;
    const i = Math.floor(rand(0, pts.length - 1));
    const [x1, z1] = pts[i];
    const [x2, z2] = pts[i + 1];
    const t = rand(0.2, 0.8);
    const bx = x1 + (x2 - x1) * t;
    const bz = z1 + (z2 - z1) * t;
    const len = Math.hypot(x2 - x1, z2 - z1) || 1;
    const nx = -(z2 - z1) / len;
    const nz = (x2 - x1) / len;
    const off = Math.max(1.5, road.width / 2 - 3.2);
    return { x: bx + nx * off, z: bz + nz * off };
  }

  retarget(entry: any, origin?: { x: number; z: number } | null) {
    let points = 0;
    // a path that is already over looks like a car that stops every few metres: ask again
    for (let attempt = 0; attempt < 3 && points < 3; attempt++) {
      const dest = this.randomRoadPoint(origin);
      points = this.nav.findPath(entry.car.pos.x, entry.car.pos.z, dest.x, dest.z, entry.path);
    }
    entry.points = points;
    entry.idx = 0;
    entry.retarget = rand(22, 34);
  }

  /** Move a car onto the road ring around `origin` and give it a fresh route. */
  recycle(entry: any, origin: { x: number; z: number } | null) {
    const car = entry.car;
    const spot = this.randomRoadPoint(origin);
    car.pos.set(spot.x, 0, spot.z);
    car.y = this.city?.groundHeightAt ? this.city.groundHeightAt(spot.x, spot.z) : 0;
    car.pos.y = car.y;
    car.speed = 6;
    car.wrecked = false;
    entry.stuck = 0;
    car.mesh.position.copy(car.pos);
    car.mesh.visible = true;
    this.retarget(entry, origin);
    this.faceRoute(entry);
  }

  update(dt: number, ctx: any = {}) {
    const playerPos = ctx.playerPos;
    const playerCar = ctx.playerCar;
    this.flowTimer = (this.flowTimer ?? 0) + dt;
    const recycleNow = this.flowTimer > 3;

    for (const entry of this.cars) {
      const car = entry.car;
      if (car === playerCar) continue;

      const playerDist = playerPos ? car.pos.distanceTo(playerPos) : 0;
      // a car that wandered out of the local street is put back on it, not left to crawl away
      if (playerPos && recycleNow && playerDist > RECYCLE_R) {
        this.recycle(entry, playerPos);
        continue;
      }
      // beyond the live ring: hidden and not stepped, so the population costs nothing until the
      // player drives toward it (the recycle above is what brings cars back)
      const live = !playerPos || playerDist < LIVE_R;
      car.mesh.visible = live;
      if (!live) continue;

      if (car.wrecked) {
        car.update(dt, { throttle: 0, steer: 0, brake: true }, this.city.colliders, this.city.bound);
        continue;
      }

      entry.retarget -= dt;
      if (!entry.points || entry.idx >= entry.points || entry.retarget <= 0) this.retarget(entry, playerPos);

      let tx = entry.path[entry.idx * 2];
      let tz = entry.path[entry.idx * 2 + 1];
      if (tx === undefined) {
        this.retarget(entry, playerPos);
        continue;
      }
      let dx = tx - car.pos.x;
      let dz = tz - car.pos.z;
      let dist = Math.hypot(dx, dz);
      while (dist < ARRIVE && entry.idx < entry.points - 1) {
        entry.idx++;
        tx = entry.path[entry.idx * 2];
        tz = entry.path[entry.idx * 2 + 1];
        dx = tx - car.pos.x;
        dz = tz - car.pos.z;
        dist = Math.hypot(dx, dz);
      }

      const desiredYaw = Math.atan2(dx, dz);
      const err = angleDelta(car.yaw, desiredYaw);
      const steer = clamp(err * 2.0, -1, 1);

      // don't rear-end the car in front (same direction only: an oncoming car is not an
      // obstacle, it is the other lane), and don't drive through the player
      let blocked = false;
      for (const other of this.cars) {
        if (other === entry) continue;
        const o = other.car;
        const ddx = o.pos.x - car.pos.x;
        const ddz = o.pos.z - car.pos.z;
        const d = Math.hypot(ddx, ddz);
        // a stopped car ignores a stopped car: two queued cars that both wait on each other
        // never move again, and the steering cannot turn them out of it at zero speed
        const bothStopped = Math.abs(o.speed) < 0.5 && Math.abs(car.speed) < 0.5;
        if (d < 8 && d > 0.1 && !bothStopped) {
          const fwd = car.forward;
          const facing = (o.forward.x * fwd.x + o.forward.z * fwd.z);
          if (facing > 0.3 && (ddx * fwd.x + ddz * fwd.z) / d > 0.75) blocked = true;
        }
      }
      if (playerPos && !playerCar) {
        const ddx = playerPos.x - car.pos.x;
        const ddz = playerPos.z - car.pos.z;
        const d = Math.hypot(ddx, ddz);
        if (d < 6) {
          const fwd = car.forward;
          if ((ddx * fwd.x + ddz * fwd.z) / d > 0.6) blocked = true;
        }
      }

      // steering error only slows a car that is already rolling: from a standstill the full
      // throttle is what gets it moving at all (0.55 * 0.3 per frame never clears the physics
      // threshold that zeroes a creeping car)
      const slow = Math.abs(err) > 0.7 && Math.abs(car.speed) > 3 ? 0.3 : 1;
      const throttle = blocked ? 0 : 0.55 * slow;
      const brake = blocked && Math.abs(car.speed) > 6;

      car.update(dt, { throttle, steer, brake, handbrake: false }, this.city.colliders, this.city.bound);

      // A car that has been pinned against a kerb for seconds is not traffic, it is scenery:
      // put it back on the road with a fresh route instead of leaving a dead body in the lane.
      if (Math.abs(car.speed) < 0.4 && !blocked) entry.stuck = (entry.stuck ?? 0) + dt;
      else entry.stuck = 0;
      if (entry.stuck > 6) {
        this.recycle(entry, playerPos ?? null);
        continue;
      }

      // shove pedestrians out of the way (no ragdoll from ambient traffic, just a scare)
      if (Math.abs(car.speed) > 6 && ctx.peds) {
        for (const ped of ctx.peds.peds ?? []) {
          if (ped.dead) continue;
          const d = Math.hypot(ped.pos.x - car.pos.x, ped.pos.z - car.pos.z);
          if (d < 2.4) {
            const away = new THREE.Vector3(ped.pos.x - car.pos.x, 0, ped.pos.z - car.pos.z).normalize();
            ped.pos.addScaledVector(away, 1.2);
          }
        }
      }
    }
    if (this.flowTimer > 3) this.flowTimer = 0;
  }
}
