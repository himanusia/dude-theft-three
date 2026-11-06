import * as THREE from 'three';
import { Car, driverLook } from './car';
import { RoadNav } from '../core/pathfinding';
import { ARTERIALS, RING_ROAD } from '../world/jakartamap';
import { clamp, angleDelta, pick, rand } from '../core/utils';

// Ambient traffic that drives the road network the map defines. It used to follow a lattice of
// intersections, which stopped existing when the city moved to the Jakarta layout: cars drove
// straight through blocks. Each car now asks RoadNav for a route to a random point on the
// network and follows the waypoints, the same way a police cruiser does.

const ARRIVE = 7;

const ROADS = [...ARTERIALS.map((a) => ({ path: a.path, width: a.width })), { path: RING_ROAD, width: 20 }];

export class Traffic {
  declare scene: any;
  declare city: any;
  declare cars: any[];
  declare flowTimer: any;
  declare nav: any;

  constructor(scene: THREE.Scene, city: any, count = 7) {
    this.scene = scene;
    this.city = city;
    this.nav = new RoadNav(city.colliders);
    this.cars = [];
    this.flowTimer = 0;
    const types = ['sedan', 'sedan', 'taxi', 'muscle', 'van', 'angkot'];
    for (let n = 0; n < count; n++) {
      const start = this.randomRoadPoint();
      const car = new Car(scene, {
        type: pick(types),
        position: new THREE.Vector3(start.x, 0, start.z),
        yaw: rand(0, Math.PI * 2),
        simple: true,
      });
      car.addDriver(...driverLook());
      const entry: any = { car, path: [], points: 0, idx: 0, retarget: 0 };
      this.cars.push(entry);
      this.retarget(entry);
    }
  }

  /** A random point on the asphalt, in the right-hand lane. */
  randomRoadPoint() {
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

  retarget(entry: any) {
    let points = 0;
    // a path that is already over looks like a car that stops every few metres: ask again
    for (let attempt = 0; attempt < 3 && points < 3; attempt++) {
      const dest = this.randomRoadPoint();
      points = this.nav.findPath(entry.car.pos.x, entry.car.pos.z, dest.x, dest.z, entry.path);
    }
    entry.points = points;
    entry.idx = 0;
    entry.retarget = rand(22, 34);
  }

  update(dt: number, ctx: any = {}) {
    const playerPos = ctx.playerPos;
    const playerCar = ctx.playerCar;
    this.flowTimer = (this.flowTimer ?? 0) + dt;

    for (const entry of this.cars) {
      const car = entry.car;
      if (car === playerCar) continue;

      // keep the traffic around the player: a car that wandered far off is recycled
      if (playerPos && this.flowTimer > 3 && car.pos.distanceTo(playerPos) > 320) {
        const spot = this.randomRoadPoint();
        car.pos.set(spot.x, 0, spot.z);
        car.speed = 6;
        car.yaw = rand(0, Math.PI * 2);
        car.mesh.position.copy(car.pos);
        car.mesh.rotation.y = car.yaw;
        this.retarget(entry);
        continue;
      }
      if (car.wrecked) {
        car.update(dt, { throttle: 0, steer: 0, brake: true }, this.city.colliders, this.city.bound);
        continue;
      }

      entry.retarget -= dt;
      if (!entry.points || entry.idx >= entry.points || entry.retarget <= 0) this.retarget(entry);

      let tx = entry.path[entry.idx * 2];
      let tz = entry.path[entry.idx * 2 + 1];
      if (tx === undefined) {
        this.retarget(entry);
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

      // don't rear-end the car in front, and don't drive through the player
      let blocked = false;
      for (const other of this.cars) {
        if (other === entry) continue;
        const o = other.car;
        const ddx = o.pos.x - car.pos.x;
        const ddz = o.pos.z - car.pos.z;
        const d = Math.hypot(ddx, ddz);
        if (d < 8 && d > 0.1) {
          const fwd = car.forward;
          if ((ddx * fwd.x + ddz * fwd.z) / d > 0.75) blocked = true;
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

      const slow = Math.abs(err) > 0.7 ? 0.3 : 1;
      const throttle = blocked ? 0 : 0.55 * slow;
      const brake = blocked && Math.abs(car.speed) > 6;

      car.update(dt, { throttle, steer, brake, handbrake: false }, this.city.colliders, this.city.bound);

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
