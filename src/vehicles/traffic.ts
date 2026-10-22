import * as THREE from 'three';
import { Car, driverLook } from './car';
import { PITCH, GRID } from '../world/city';
import { clamp, angleDelta, pick, rand } from '../core/utils';

// Ambient traffic: each car follows intersection-to-intersection waypoints on the lane grid.
const LANE = 2.6;

function intersection(i: number, j: number) {
  return new THREE.Vector3((i + 0.5) * PITCH, 0, (j + 0.5) * PITCH);
}

export class Traffic {
  declare scene: any;
  declare city: any;
  declare cars: any[];
  declare flowTimer: any;
  constructor(scene: THREE.Scene, city: any, count = 7) {
    this.scene = scene;
    this.city = city;
    this.cars = [];
    const types = ['sedan', 'sedan', 'taxi', 'muscle', 'van', 'angkot'];
    for (let n: number = 0; n < count; n++) {
      const i = Math.floor(rand(-2, 3));
      const j = Math.floor(rand(-2, 3));
      const heading = pick([[1, 0], [-1, 0], [0, 1], [0, -1]]);
      const start = intersection(i, j);
      const car = new Car(scene, { type: pick(types), position: start, yaw: Math.atan2(heading[0], heading[1]), simple: true });
      car.addDriver(...driverLook());
      this.cars.push({
        car,
        cell: { i, j },
        heading,
        wait: 0,
        honked: 0,
      });
    }
  }

  laneTarget(cell: any, heading: any) {
    // point in the middle of the next intersection, offset into the right-hand lane
    const p = intersection(cell.i + heading[0], cell.j + heading[1]);
    const right = new THREE.Vector3(-heading[1], 0, heading[0]);
    p.addScaledVector(right, LANE);
    return p;
  }

  pickHeading(cell: any, heading: any, wanted: any) {
    const options = [
      heading,
      [heading[1], -heading[0]],
      [-heading[1], heading[0]],
    ].filter(([di, dj]) => {
      const ni = cell.i + di;
      const nj = cell.j + dj;
      return ni >= -GRID - 1 && ni <= GRID && nj >= -GRID - 1 && nj <= GRID;
    });
    // drivers avoid the player's wanted level: panic and scatter at 3+ stars
    if (wanted >= 3) return pick(options);
    return Math.random() < 0.55 ? heading : pick(options);
  }

  update(dt: number, ctx: any = {}) {
    const wanted = ctx.wanted ?? 0;
    const playerPos = ctx.playerPos;
    const playerCar = ctx.playerCar;
    this.flowTimer = (this.flowTimer ?? 0) + dt;

    for (const entry of this.cars) {
      const car = entry.car;
      if (car === playerCar) continue;

      // keep some traffic around the player instead of the whole map
      if (playerPos && this.flowTimer > 3) {
        const d = car.pos.distanceTo(playerPos);
        if (d > 140 && car.pos.distanceTo(playerPos) > 40) {
          const cell = { i: Math.round((playerPos.x + rand(-70, 70)) / PITCH - 0.5), j: Math.round((playerPos.z + rand(-70, 70)) / PITCH - 0.5) };
          const dir = pick([[1, 0], [-1, 0], [0, 1], [0, -1]]);
          const spawn = intersection(cell.i - dir[0], cell.j - dir[1]);
          car.pos.copy(spawn);
          car.yaw = Math.atan2(dir[0], dir[1]);
          car.speed = 6;
          car.mesh.position.copy(car.pos);
          car.mesh.rotation.y = car.yaw;
          entry.cell = cell;
          entry.heading = dir;
          entry.target = this.laneTarget(cell, dir);
          continue;
        }
      }
      if (car.wrecked) {
        car.update(dt, { throttle: 0, steer: 0, brake: true }, this.city.colliders, 220);
        continue;
      }

      if (!entry.target) {
        entry.target = this.laneTarget(entry.cell, entry.heading);
      }
      const dx = entry.target.x - car.pos.x;
      const dz = entry.target.z - car.pos.z;
      const dist = Math.hypot(dx, dz);

      if (dist < 5.5) {
        // arrive at the intersection, choose the next leg
        entry.cell = { i: entry.cell.i + entry.heading[0], j: entry.cell.j + entry.heading[1] };
        entry.heading = this.pickHeading(entry.cell, entry.heading, wanted);
        entry.target = this.laneTarget(entry.cell, entry.heading);
      }

      const desiredYaw = Math.atan2(dx, dz);
      const err = angleDelta(car.yaw, desiredYaw);
      const steer = clamp(err * 2.0, -1, 1);

      // don't rear-end the car in front
      let blocked = false;
      for (const other of this.cars) {
        if (other === entry) continue;
        const o = other.car;
        const ddx = o.pos.x - car.pos.x;
        const ddz = o.pos.z - car.pos.z;
        const d = Math.hypot(ddx, ddz);
        if (d < 7 && d > 0.1) {
          const fwd = car.forward;
          if ((ddx * fwd.x + ddz * fwd.z) / d > 0.75) blocked = true;
        }
      }
      if (playerPos && !playerCar) {
        const ddx = playerPos.x - car.pos.x;
        const ddz = playerPos.z - car.pos.z;
        const d = Math.hypot(ddx, ddz);
        if (d < 5.5) {
          const fwd = car.forward;
          if ((ddx * fwd.x + ddz * fwd.z) / d > 0.6) blocked = true;
        }
      }

      const slow = Math.abs(err) > 0.7 ? 0.25 : 1;
      const throttle = blocked ? 0 : 0.55 * slow;
      const brake = blocked && Math.abs(car.speed) > 6;

      car.update(
        dt,
        { throttle, steer, brake, handbrake: false },
        this.city.colliders,
        220
      );

      // shove pedestrians out of the way (no ragdoll from NPC traffic, just a scare)
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