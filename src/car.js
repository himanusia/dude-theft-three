import * as THREE from 'three';
import { clamp, lerp, rand, pick, resolveCircleBox, shadowBlob, roundedBox, canvasTexture } from './utils.js';

// saturated toy-car palette from the reference screenshots
const CAR_COLORS = [0xff3399, 0xd02b2b, 0x2f6fd0, 0xffce2e, 0x2fa89a, 0xf0f0f4, 0x24242c, 0xe86a2b, 0x39b54a];

const SPECS = {
  sedan: { maxSpeed: 30, accel: 11, brake: 22, turn: 1.5, mass: 1, grip: 7 },
  muscle: { maxSpeed: 38, accel: 15, brake: 20, turn: 1.35, mass: 1.1, grip: 6 },
  van: { maxSpeed: 23, accel: 8, brake: 18, turn: 1.2, mass: 1.4, grip: 8 },
  police: { maxSpeed: 34, accel: 14, brake: 24, turn: 1.6, mass: 1.05, grip: 8 },
  taxi: { maxSpeed: 31, accel: 12, brake: 22, turn: 1.55, mass: 1, grip: 7.5 },
};

export class Car {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.type = opts.type ?? 'sedan';
    const spec = SPECS[this.type] ?? SPECS.sedan;
    Object.assign(this, spec);
    this.color = opts.color ?? pick(CAR_COLORS);
    this.isPolice = opts.police ?? false;
    this.yaw = opts.yaw ?? 0;
    this.pos = (opts.position ?? new THREE.Vector3()).clone();
    this.pos.y = 0;
    this.speed = 0;
    this.steer = 0;
    this.y = 0;
    this.vy = 0;
    this.roll = 0;
    this.pitch = 0;
    this.health = 100;
    this.wrecked = false;
    this.honk = 0;
    this.wheelRadius = this.type === 'van' ? 0.44 : 0.37;
    this.length = this.type === 'van' ? 5.4 : this.type === 'muscle' ? 4.7 : 4.6;
    this.width = this.type === 'van' ? 2.05 : 1.85;
    this.radius = Math.max(this.width, this.length) * 0.42;
    this.aiPaused = false;

    this.build();
  }

  build() {
    const g = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({
      color: this.isPolice ? 0x1b2436 : this.color,
      roughness: 0.36,
      metalness: 0.22,
      flatShading: true,
    });
    const glass = new THREE.MeshStandardMaterial({
      color: 0xaee8ff,
      roughness: 0.12,
      metalness: 0.35,
      transparent: true,
      opacity: 0.72,
    });
    const darkGlass = new THREE.MeshStandardMaterial({
      color: 0x233040,
      roughness: 0.18,
      metalness: 0.4,
      transparent: true,
      opacity: 0.88,
    });
    const trim = new THREE.MeshStandardMaterial({ color: 0x1a1a20, roughness: 0.85, flatShading: true });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xc3c8d0, roughness: 0.28, metalness: 0.85 });
    const rb = roundedBox;

    const L = this.length;
    const W = this.width;
    const isVan = this.type === 'van';

    // main body — beveled, low and wide like the reference muscle car
    const bodyH = isVan ? 1.08 : 0.56;
    const body = new THREE.Mesh(rb(W * 0.92, bodyH, L * 0.98, isVan ? 0.1 : 0.16, 2), paint);
    body.position.y = isVan ? 0.92 : 0.64;
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    const skirt = new THREE.Mesh(rb(W * 0.88, 0.3, L * 0.96, 0.08, 1), trim);
    skirt.position.y = 0.4;
    g.add(skirt);

    // wheels first so arches can be placed around them
    const wheelGeo = new THREE.CylinderGeometry(this.wheelRadius, this.wheelRadius, 0.3, 14);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x141419, roughness: 0.92, flatShading: true });
    const hubGeo = new THREE.CylinderGeometry(this.wheelRadius * 0.5, this.wheelRadius * 0.5, 0.32, 10);
    const hubMat = new THREE.MeshStandardMaterial({ color: 0xc9ccd2, roughness: 0.35, metalness: 0.75 });
    this.wheels = [];
    const wz = L * 0.33;
    const wx = W * 0.5 + 0.02;
    for (const [sx, sz, front] of [[-1, 1, true], [1, 1, true], [-1, -1, false], [1, -1, false]]) {
      const pivot = new THREE.Group();
      pivot.position.set(sx * wx, this.wheelRadius, sz * wz);
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.castShadow = true;
      pivot.add(wheel);
      const hub = new THREE.Mesh(hubGeo, hubMat);
      hub.rotation.z = Math.PI / 2;
      pivot.add(hub);
      g.add(pivot);
      this.wheels.push({ pivot, wheel, front });

      // chunky fender flare over each wheel
      const flare = new THREE.Mesh(rb(0.16, 0.2, 1.0, 0.05, 1), paint);
      flare.position.set(sx * (W * 0.5 - 0.02), this.wheelRadius + 0.28, sz * wz);
      g.add(flare);
    }

    if (isVan) {
      const cabin = new THREE.Mesh(rb(W * 0.84, 0.78, L * 0.5, 0.1, 2), darkGlass);
      cabin.position.set(0, 1.55, L * 0.18);
      g.add(cabin);
      const roof = new THREE.Mesh(rb(W * 0.86, 0.18, L * 0.9, 0.07, 1), paint);
      roof.position.set(0, 1.98, 0);
      roof.castShadow = true;
      g.add(roof);
      for (const sx of [-1, 1]) {
        const sideGlass = new THREE.Mesh(rb(0.05, 0.55, L * 0.42, 0.02, 1), darkGlass);
        sideGlass.position.set(sx * W * 0.43, 1.6, -L * 0.06);
        g.add(sideGlass);
      }
    } else {
      // hood + trunk decks give the muscle-car silhouette
      const hood = new THREE.Mesh(rb(W * 0.84, 0.16, L * 0.3, 0.07, 1), paint);
      hood.position.set(0, 0.97, L * 0.3);
      hood.castShadow = true;
      g.add(hood);
      const trunk = new THREE.Mesh(rb(W * 0.82, 0.14, L * 0.2, 0.06, 1), paint);
      trunk.position.set(0, 0.96, -L * 0.37);
      g.add(trunk);

      if (this.type === 'muscle') {
        // open cockpit: windshield + two seats, no roof (like the pink convertible in the reference)
        const windshield = new THREE.Mesh(rb(W * 0.86, 0.52, 0.06, 0.02, 1), glass);
        windshield.position.set(0, 1.24, L * 0.13);
        windshield.rotation.x = -0.2;
        g.add(windshield);
        // A-pillars + header rail so the glass is not a floating pane
        const frameMat = new THREE.MeshStandardMaterial({ color: 0x1a1a20, roughness: 0.6 });
        for (const sx of [-1, 1]) {
          const apillar = new THREE.Mesh(rb(0.06, 0.56, 0.08, 0.02, 1), frameMat);
          apillar.position.set(sx * W * 0.43, 1.24, L * 0.13);
          apillar.rotation.x = -0.2;
          g.add(apillar);
        }
        const header = new THREE.Mesh(rb(W * 0.88, 0.07, 0.09, 0.02, 1), frameMat);
        header.position.set(0, 1.5, L * 0.08);
        g.add(header);
        // cockpit tub, dash, steering wheel, console
        const tub = new THREE.Mesh(rb(W * 0.78, 0.22, L * 0.3, 0.04, 1), new THREE.MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.9 }));
        tub.position.set(0, 0.92, -0.18);
        g.add(tub);
        const dash = new THREE.Mesh(rb(W * 0.8, 0.24, 0.16, 0.03, 1), new THREE.MeshStandardMaterial({ color: 0x23232a, roughness: 0.85 }));
        dash.position.set(0, 1.02, L * 0.06);
        g.add(dash);
        const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.035, 6, 12), new THREE.MeshStandardMaterial({ color: 0x14141a, roughness: 0.8 }));
        wheel.position.set(-0.4, 1.12, -0.02);
        wheel.rotation.x = -1.15;
        g.add(wheel);
        const column = new THREE.Mesh(rb(0.05, 0.05, 0.22, 0.01, 1), frameMat);
        column.position.set(-0.4, 1.07, L * 0.04);
        g.add(column);
        const seatMat = new THREE.MeshStandardMaterial({ color: 0x2b2b33, roughness: 0.9 });
        for (const sx of [-1, 1]) {
          const seat = new THREE.Mesh(rb(0.5, 0.42, 0.5, 0.08, 1), seatMat);
          seat.position.set(sx * 0.42, 1.12, -0.2);
          g.add(seat);
          const back = new THREE.Mesh(rb(0.5, 0.46, 0.14, 0.06, 1), seatMat);
          back.position.set(sx * 0.42, 1.3, -0.44);
          g.add(back);
        }
        const scoop = new THREE.Mesh(rb(0.66, 0.14, 0.72, 0.05, 1), trim);
        scoop.position.set(0, 1.08, L * 0.3);
        g.add(scoop);
        const wing = new THREE.Mesh(rb(W * 0.6, 0.06, 0.3, 0.025, 1), trim);
        wing.position.set(0, 1.12, -L * 0.45);
        g.add(wing);
        for (const sx of [-1, 1]) {
          const stalk = new THREE.Mesh(rb(0.07, 0.16, 0.1, 0.02, 1), trim);
          stalk.position.set(sx * W * 0.22, 1.06, -L * 0.45);
          g.add(stalk);
        }
      } else {
        const cabin = new THREE.Mesh(rb(W * 0.8, 0.44, L * 0.36, 0.1, 2), darkGlass);
        cabin.position.set(0, 1.16, -0.12);
        cabin.castShadow = true;
        g.add(cabin);
        const roof = new THREE.Mesh(rb(W * 0.74, 0.11, L * 0.3, 0.05, 1), paint);
        roof.position.set(0, 1.4, -0.12);
        g.add(roof);
        const pillars = new THREE.MeshStandardMaterial({ color: this.isPolice ? 0x1b2436 : this.color, roughness: 0.5 });
        for (const sx of [-1, 1]) {
          const pillar = new THREE.Mesh(rb(0.07, 0.44, 0.12, 0.02, 1), pillars);
          pillar.position.set(sx * W * 0.36, 1.16, L * 0.06);
          g.add(pillar);
        }
        if (this.type === 'taxi') {
          const sign = new THREE.Mesh(
            rb(0.86, 0.26, 0.4, 0.06, 1),
            new THREE.MeshStandardMaterial({ color: 0xffe27a, emissive: 0xffcf4a, emissiveIntensity: 0.6 })
          );
          sign.position.set(0, 1.56, -0.12);
          g.add(sign);
        }
      }
    }

    // chrome bumpers + grille
    for (const [sz, isFront] of [[1, true], [-1, false]]) {
      const bumper = new THREE.Mesh(rb(W * 0.94, 0.16, 0.18, 0.05, 1), chrome);
      bumper.position.set(0, 0.52, sz * (L * 0.5 - 0.02));
      g.add(bumper);
      const grille = new THREE.Mesh(rb(W * 0.46, 0.2, 0.07, 0.02, 1), isFront ? trim : trim);
      grille.position.set(0, 0.78, sz * (L * 0.49));
      g.add(grille);
    }

    // lights
    const headMat = new THREE.MeshStandardMaterial({ color: 0xfff8e0, emissive: 0xfff0b0, emissiveIntensity: 0.5 });
    const tailMat = new THREE.MeshStandardMaterial({ color: 0xff3322, emissive: 0xff1100, emissiveIntensity: 0.6 });
    this.headMat = headMat;
    this.tailMat = tailMat;
    for (const sx of [-1, 1]) {
      const hl = new THREE.Mesh(rb(0.38, 0.2, 0.09, 0.04, 1), headMat);
      hl.position.set(sx * (W * 0.3), 0.8, L * 0.495);
      g.add(hl);
      const tl = new THREE.Mesh(rb(0.32, 0.15, 0.07, 0.03, 1), tailMat);
      tl.position.set(sx * (W * 0.31), 0.8, -L * 0.49);
      g.add(tl);
    }

    // police livery
    if (this.isPolice) {
      const bar = new THREE.Mesh(rb(W * 0.62, 0.12, 0.36, 0.04, 1), trim);
      bar.position.set(0, 1.6, -0.12);
      g.add(bar);
      this.lightRed = new THREE.MeshStandardMaterial({ color: 0xff2222, emissive: 0xff0000, emissiveIntensity: 1 });
      this.lightBlue = new THREE.MeshStandardMaterial({ color: 0x2244ff, emissive: 0x0033ff, emissiveIntensity: 1 });
      const lr = new THREE.Mesh(rb(0.34, 0.14, 0.3, 0.03, 1), this.lightRed);
      lr.position.set(-W * 0.22, 1.69, -0.12);
      g.add(lr);
      const lb = new THREE.Mesh(rb(0.34, 0.14, 0.3, 0.03, 1), this.lightBlue);
      lb.position.set(W * 0.22, 1.69, -0.12);
      g.add(lb);

      const doorTex = canvasTexture(256, 96, (ctx, w, h) => {
        ctx.fillStyle = '#f2f4f8';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#12203a';
        ctx.font = 'bold 54px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('POLICE', w / 2, h / 2 + 2);
        ctx.fillStyle = '#2a4a8a';
        ctx.fillRect(0, 0, w, 6);
        ctx.fillRect(0, h - 6, w, 6);
      });
      const doorMat = new THREE.MeshStandardMaterial({ map: doorTex, roughness: 0.55 });
      for (const sx of [-1, 1]) {
        const door = new THREE.Mesh(new THREE.PlaneGeometry(L * 0.34, 0.42), doorMat);
        door.position.set(sx * (W * 0.462), 0.78, -0.05);
        door.rotation.y = sx * (Math.PI / 2);
        g.add(door);
      }
    }

    // mirrors, plate, exhaust tips
    for (const sx of [-1, 1]) {
      const mirror = new THREE.Mesh(rb(0.1, 0.09, 0.16, 0.02, 1), chrome);
      mirror.position.set(sx * (W * 0.56), 1.02, L * 0.1);
      g.add(mirror);
    }
    const plate = new THREE.Mesh(rb(0.44, 0.14, 0.04, 0.01, 1), new THREE.MeshStandardMaterial({ color: 0xf4f4ea, roughness: 0.6 }));
    plate.position.set(0, 0.6, -L * 0.5 - 0.02);
    g.add(plate);
    for (const sx of [-1, 1]) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.18, 8), chrome);
      pipe.rotation.x = Math.PI / 2;
      pipe.position.set(sx * 0.28, 0.36, -L * 0.5 + 0.02);
      g.add(pipe);
    }

    const blob = shadowBlob(W * 1.25, L * 1.05, 0.4);
    blob.position.y = 0.05;
    g.add(blob);

    this.mesh = g;
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = this.yaw;
    this.scene.add(g);
  }

  get forward() {
    return new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  applyDamage(n) {
    if (this.wrecked) return;
    this.health = clamp(this.health - n, 0, 100);
    if (this.health <= 0) {
      this.wrecked = true;
      this.health = 0;
    }
  }

  jump(power = 8.5) {
    if (this.y > 0.2) return;
    this.vy = power;
    this.y = 0.05;
  }

  update(dt, input = {}, colliders = [], worldHalf = 220) {
    const throttle = input.throttle ?? 0;
    const steerInput = input.steer ?? 0;
    const braking = input.brake ?? false;
    const handbrake = input.handbrake ?? false;

    const maxSpeed = this.wrecked ? 0 : this.maxSpeed;
    const accel = this.wrecked ? 0 : this.accel;

    if (throttle > 0.05) this.speed += accel * throttle * dt;
    else if (throttle < -0.05) this.speed += accel * 0.7 * throttle * dt;

    if (braking) this.speed -= Math.sign(this.speed) * this.brake * dt;
    if (handbrake) this.speed -= Math.sign(this.speed) * 10 * dt;

    // drag + rolling resistance
    this.speed -= this.speed * (this.wrecked ? 1.6 : 0.55) * dt;
    this.speed = clamp(this.speed, -maxSpeed * 0.42, maxSpeed * 1.08);
    if (Math.abs(this.speed) < 0.12) this.speed = 0;

    // steering: grip falls as speed rises
    const speedFactor = clamp(Math.abs(this.speed) / this.maxSpeed, 0, 1);
    const maxSteer = 0.62 - speedFactor * 0.3;
    this.steer = lerp(this.steer, steerInput * maxSteer, clamp(dt * 9, 0, 1));
    const gripDamp = handbrake ? 0.55 : 1;
    const yawRate = (this.speed / 2.6) * Math.tan(this.steer * gripDamp);
    this.yaw += yawRate * dt;

    // integrate position
    const fwd = this.forward;
    const nx = this.pos.x + fwd.x * this.speed * dt;
    const nz = this.pos.z + fwd.z * this.speed * dt;
    this.pos.x = nx;
    this.pos.z = nz;

    // collision with buildings / props
    let hit = null;
    for (const b of colliders) {
      if (b.h !== undefined && b.h < 0.6) continue;
      const res = resolveCircleBox(this.pos.x, this.pos.z, this.radius * 0.82, b);
      if (res) {
        const impact = Math.abs(this.speed);
        this.pos.x = res.x;
        this.pos.z = res.z;
        if (impact > 4) {
          this.applyDamage(impact * 0.9);
          hit = { impact, x: res.x, z: res.z };
        }
        this.lastCollision = { x: res.x, z: res.z, box: b };
        this.speed *= -0.28;
        if (Math.abs(this.speed) > 6) this.jump(1.6);
      }
    }

    // world bounds
    this.pos.x = clamp(this.pos.x, -worldHalf, worldHalf);
    this.pos.z = clamp(this.pos.z, -worldHalf, worldHalf);

    // airborne
    if (this.y > 0 || this.vy > 0) {
      this.vy -= 26 * dt;
      this.y += this.vy * dt;
      if (this.y <= 0) {
        const landImpact = Math.abs(this.vy);
        this.y = 0;
        this.vy = 0;
        if (landImpact > 6) {
          this.applyDamage(landImpact * 1.5);
          hit = { impact: landImpact, x: this.pos.x, z: this.pos.z, land: true };
        }
      }
    }

    // visuals
    this.mesh.position.set(this.pos.x, this.y, this.pos.z);
    this.mesh.rotation.y = this.yaw;
    const targetRoll = -this.steer * speedFactor * 0.28;
    this.roll = lerp(this.roll, targetRoll, clamp(dt * 6, 0, 1));
    const accelPitch = throttle * -0.035 + (braking ? 0.04 : 0);
    this.pitch = lerp(this.pitch, accelPitch, clamp(dt * 5, 0, 1));
    this.mesh.rotation.z = this.roll;
    this.mesh.rotation.x = this.pitch;

    for (const w of this.wheels) {
      w.wheel.rotation.x -= (this.speed * dt) / this.wheelRadius;
      if (w.front) w.pivot.rotation.y = this.steer;
    }

    // police lightbar
    if (this.isPolice) {
      const t = performance.now() * 0.006;
      const on = Math.sin(t) > 0;
      this.lightRed.emissiveIntensity = on ? 2.4 : 0.15;
      this.lightBlue.emissiveIntensity = on ? 0.15 : 2.4;
    }

    return hit;
  }

  frontPoint() {
    const f = this.forward;
    return new THREE.Vector3(
      this.pos.x + f.x * this.length * 0.5,
      this.y + 0.7,
      this.pos.z + f.z * this.length * 0.5
    );
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose();
        o.material?.dispose?.();
      }
    });
  }
}