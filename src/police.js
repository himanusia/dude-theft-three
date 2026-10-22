import * as THREE from 'three';
import { Car } from './car.js';
import { clamp, angleDelta, rand } from './utils.js';

export class Police {
  constructor(scene, city, audio) {
    this.scene = scene;
    this.city = city;
    this.audio = audio;
    this.cars = [];
    this.wanted = 0;
    this.crimeCooldown = 0;
    this.shootTimer = 0;
    this.arrestProgress = 0;
    this.maxCars = 5;
  }

  get starCount() {
    return Math.floor(clamp(this.wanted, 0, 5));
  }

  addWanted(n) {
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

  spawnCar(playerPos) {
    // spawn on the road nearest the player, driving straight at them
    const zLines = this.city.roadLines.filter((l) => l.axis === 'x').map((l) => l.coord);
    const xLines = this.city.roadLines.filter((l) => l.axis === 'z').map((l) => l.coord);
    const nearest = (arr, v) => arr.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), arr[0]);

    const travelX = Math.random() < 0.5;
    let p;
    let yaw;
    if (travelX) {
      const z = nearest(zLines, playerPos.z) + (Math.random() < 0.5 ? -3 : 3);
      const side = Math.random() < 0.5 ? -1 : 1;
      p = new THREE.Vector3(playerPos.x + side * rand(42, 68), 0, z);
      yaw = side < 0 ? Math.PI / 2 : -Math.PI / 2;
    } else {
      const x = nearest(xLines, playerPos.x) + (Math.random() < 0.5 ? -3 : 3);
      const side = Math.random() < 0.5 ? -1 : 1;
      p = new THREE.Vector3(x, 0, playerPos.z + side * rand(42, 68));
      yaw = side < 0 ? 0 : Math.PI;
    }
    const car = new Car(this.scene, { type: 'police', police: true, position: p, yaw });
    const entry = { car, stuck: 0, reverse: 0, far: 0 };
    this.cars.push(entry);
    return entry;
  }

  update(dt, ctx) {
    const { playerPos, onFoot } = ctx;

    if (this.wanted > 0) {
      this.crimeCooldown -= dt;
      if (this.crimeCooldown <= 0 && this.wanted > 0) {
        this.wanted = Math.max(0, this.wanted - dt * 0.14);
      }
    }

    const targetCount = Math.min(this.maxCars, this.starCount);
    while (this.cars.length < targetCount) this.spawnCar(playerPos);

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

      const desiredYaw = Math.atan2(dx, dz);
      let steer = clamp(angleDelta(car.yaw, desiredYaw) * 1.8, -1, 1);

      // reverse out when wedged
      if (Math.abs(car.speed) < 1.2 && dist > 6) entry.stuck += dt;
      else entry.stuck = Math.max(0, entry.stuck - dt * 0.5);
      if (entry.stuck > 1.4) {
        entry.reverse = 1.2;
        entry.stuck = 0;
      }
      if (entry.reverse > 0) {
        entry.reverse -= dt;
        steer = -steer;
        car.update(dt, { throttle: -1, steer, brake: false }, this.city.colliders, 220);
        continue;
      }

      const throttle = dist > 65 ? 1 : dist > 14 ? 0.85 : dist > 7 ? 0.4 : 0;
      const brake = dist < 6 && Math.abs(car.speed) > 6;
      const hit = car.update(dt, { throttle, steer, brake }, this.city.colliders, 220);
      if (hit && hit.impact > 8) {
        this.audio.play('crash', { vol: clamp(hit.impact / 40, 0.1, 0.7), pan: this.panFor(car.pos, playerPos) });
      }

      // ram damage to the player
      if (ctx.playerCarDist !== undefined) {
        // handled by main
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

  panFor(pos, listener) {
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
