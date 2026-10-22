import * as THREE from 'three';
import { Character } from './character.js';
import { clamp, rand, pick, angleDelta, resolveCircleBox } from './utils.js';

export class Ped {
  constructor(scene, city, position) {
    this.scene = scene;
    this.city = city;
    this.char = new Character({ scale: rand(0.92, 1.05) });
    this.pos = position.clone();
    this.yaw = rand(0, Math.PI * 2);
    this.speed = rand(1.2, 1.9);
    this.state = 'walk';
    this.dead = false;
    this.phase = 0;
    this.target = this.pickTarget();
    this.scene.add(this.char.group);
    this.char.group.position.copy(this.pos);
    this.char.group.rotation.y = this.yaw;
  }

  pickTarget() {
    return this.city.randomSidewalkPoint();
  }

  get radius() {
    return 0.4;
  }

  headPos() {
    return new THREE.Vector3(this.pos.x, this.pos.y + 1.55, this.pos.z);
  }

  update(dt, ctx) {
    if (this.dead) return;
    const playerDist = this.pos.distanceTo(ctx.playerPos);
    const scared = (ctx.wanted > 0 && playerDist < 26) || (ctx.armed && playerDist < 12) || ctx.panic;

    if (scared && this.state !== 'flee') {
      this.state = 'flee';
      this.speed = rand(4.2, 5.6);
      // run away from the player
      const dx = this.pos.x - ctx.playerPos.x;
      const dz = this.pos.z - ctx.playerPos.z;
      this.target = new THREE.Vector3(this.pos.x + dx * 3, 0, this.pos.z + dz * 3);
    } else if (!scared && this.state === 'flee' && playerDist > 40) {
      this.state = 'walk';
      this.speed = rand(1.2, 1.9);
      this.target = this.pickTarget();
    }

    if (!this.target) this.target = this.pickTarget();
    const dx = this.target.x - this.pos.x;
    const dz = this.target.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1.6) {
      this.target = this.city.randomSidewalkPoint();
    } else {
      const desired = Math.atan2(dx, dz);
      this.yaw += angleDelta(this.yaw, desired) * clamp(dt * 5, 0, 1);
      const step = this.speed * dt;
      this.pos.x += Math.sin(this.yaw) * step;
      this.pos.z += Math.cos(this.yaw) * step;
    }

    // keep out of buildings
    for (const b of this.city.colliders) {
      if (b.h < 1.2) continue;
      const res = resolveCircleBox(this.pos.x, this.pos.z, this.radius, b);
      if (res) {
        this.pos.x = res.x;
        this.pos.z = res.z;
        this.target = this.city.randomSidewalkPoint();
      }
    }

    this.pos.x = clamp(this.pos.x, -220, 220);
    this.pos.z = clamp(this.pos.z, -220, 220);

    // run away from an incoming car
    for (const c of ctx.cars || []) {
      const d = Math.hypot(c.pos.x - this.pos.x, c.pos.z - this.pos.z);
      if (d < 9 && Math.abs(c.speed) > 8) {
        const away = new THREE.Vector3(this.pos.x - c.pos.x, 0, this.pos.z - c.pos.z).normalize();
        this.pos.x += away.x * dt * 6;
        this.pos.z += away.z * dt * 6;
        this.yaw = Math.atan2(away.x, away.z);
        break;
      }
    }

    this.pos.y = this.city.groundHeightAt(this.pos.x, this.pos.z);
    this.char.group.visible = playerDist < 110;

    const moving = Math.min(1, this.speed / 5);
    this.char.group.position.set(this.pos.x, this.pos.y, this.pos.z);
    this.char.group.rotation.y = this.yaw;
    // animation LOD: full cycle up close, frozen pose further away
    if (playerDist < 55) this.char.animate(dt, moving);
    this.animPhase = (this.animPhase ?? 0) + dt;
  }

  kill(velocity, colliders) {
    this.dead = true;
    // geometries/materials are shared across characters — never dispose them here
    this.scene.remove(this.char.group);
    return { position: this.pos.clone(), yaw: this.yaw, skin: this.char.skin, shirt: this.char.shirt, pants: this.char.pants, velocity };
  }
}

export class PedManager {
  constructor(scene, city, count = 70) {
    this.scene = scene;
    this.city = city;
    this.peds = [];
    this.count = count;
    for (let i = 0; i < count; i++) {
      this.peds.push(new Ped(scene, city, city.randomSidewalkPointNear(110)));
    }
    this.respawnTimer = 0;
    this.flowTimer = 0;
  }

  update(dt, ctx) {
    for (const p of this.peds) p.update(dt, ctx);

    // keep the crowd near the player: far pedestrians get re-placed around him
    this.flowTimer += dt;
    if (this.flowTimer > 2.2 && ctx.playerPos) {
      this.flowTimer = 0;
      for (const p of this.peds) {
        if (p.dead) continue;
        const d = p.pos.distanceTo(ctx.playerPos);
        if (d > 80) {
          const spot = this.city.randomSidewalkPointAround(ctx.playerPos, 14, 48);
          p.pos.copy(spot);
          p.target = this.city.randomSidewalkPointAround(ctx.playerPos, 14, 48);
          p.char.group.position.copy(p.pos);
        }
      }
    }

    // recycle dead ones after a while so the street never empties
    this.respawnTimer += dt;
    if (this.respawnTimer > 4) {
      this.respawnTimer = 0;
      this.peds = this.peds.filter((p) => {
        if (!p.dead) return true;
        return false;
      });
      while (this.peds.length < this.count) {
        this.peds.push(new Ped(this.scene, this.city, this.city.randomSidewalkPoint()));
      }
    }
  }

  nearest(point, maxDist = 60) {
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