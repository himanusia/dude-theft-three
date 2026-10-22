import * as THREE from 'three';
import { clamp, lerp, rand, pick, resolveCircleBox, shadowBlob, roundedBox, canvasTexture } from './utils';
import { MODELS, TYPE_TO_MODEL, instantiateModel } from './carmodels';

// saturated toy-car palette from the reference screenshots
const CAR_COLORS = [0xff3399, 0xd02b2b, 0x2f6fd0, 0xffce2e, 0x2fa89a, 0xf0f0f4, 0x24242c, 0xe86a2b, 0x39b54a];

const SPECS = {
  sedan: { maxSpeed: 30, accel: 12, brake: 22, turn: 1.5, mass: 1, grip: 7 },
  muscle: { maxSpeed: 38, accel: 16, brake: 20, turn: 1.35, mass: 1.1, grip: 6 },
  van: { maxSpeed: 23, accel: 9, brake: 18, turn: 1.2, mass: 1.4, grip: 8 },
  // angkot: a Colt L300 / Carry minibus — 4.2 m long, 1.7 m wide, 1.9 m tall, 2.6 m wheelbase
  angkot: { maxSpeed: 21, accel: 8, brake: 17, turn: 1.15, mass: 1.5, grip: 8.5 },
  police: { maxSpeed: 34, accel: 15, brake: 24, turn: 1.6, mass: 1.05, grip: 8 },
  taxi: { maxSpeed: 31, accel: 13, brake: 22, turn: 1.55, mass: 1, grip: 7.5 },
};

// coast-down drag: only applied with the throttle released (or above the spec
// top speed), so it never caps the engine's own acceleration curve
const COAST_DRAG = 0.55;
const WRECK_DRAG = 1.6;
// reverse tops out at 42 % of the forward spec, same as before the retune
const WHEELBASE = 2.6;
const REVERSE_CAP = 0.42;

export class Car {
  declare scene: any;
  declare type: any;
  declare color: any;
  declare isPolice: any;
  declare yaw: any;
  declare pos: any;
  declare speed: number;
  declare steer: number;
  declare y: number;
  declare vy: number;
  declare vx: number;
  declare vz: number;
  declare slip: number;
  declare driver: any;
  declare modelSize: any;
  declare driverAnchor: any;
  declare driverLook: [number, number, number] | null;
  declare roll: number;
  declare pitch: number;
  declare health: number;
  declare wrecked: boolean;
  declare honk: number;
  declare wheelRadius: any;
  declare length: any;
  declare width: any;
  declare radius: any;
  declare aiPaused: boolean;
  declare wheels: any[];
  declare headMat: any;
  declare tailMat: any;
  declare mesh: any;
  declare brakeLight: boolean;
  declare simple: boolean;
  declare lightRed: THREE.MeshStandardMaterial;
  declare lightBlue: THREE.MeshStandardMaterial;
  declare maxSpeed: number;
  declare accel: number;
  declare brake: number;
  declare turn: number;
  declare mass: number;
  declare grip: number;
  declare lastCollision: any;
  constructor(scene: THREE.Scene, opts: any = {}) {
    this.scene = scene;
    this.type = opts.type ?? 'sedan';
    const spec = (SPECS as Record<string, typeof SPECS.sedan>)[this.type] ?? SPECS.sedan;
    Object.assign(this, spec);
    this.color = opts.color ?? pick(CAR_COLORS);
    this.isPolice = opts.police ?? false;
    this.simple = opts.simple ?? false;
    this.yaw = opts.yaw ?? 0;
    this.pos = (opts.position ?? new THREE.Vector3()).clone();
    this.pos.y = 0;
    this.speed = 0;
    this.steer = 0;
    this.vx = 0;
    this.vz = 0;
    this.slip = 0;
    this.driver = null;
    this.modelSize = null;
    this.driverAnchor = null;
    this.driverLook = null;
    this.y = 0;
    this.vy = 0;
    this.roll = 0;
    this.pitch = 0;
    this.health = 100;
    this.wrecked = false;
    this.honk = 0;
    this.wheelRadius = this.type === 'van' ? 0.46 : this.type === 'angkot' ? 0.35 : 0.4;
    this.length = this.type === 'van' ? 5.4 : this.type === 'angkot' ? 4.2 : this.type === 'muscle' ? 4.7 : 4.6;
    this.width = this.type === 'van' ? 2.05 : this.type === 'angkot' ? 1.74 : 1.85;
    this.radius = Math.max(this.width, this.length) * 0.42;
    this.aiPaused = false;

    this.build();
  }

  build() {
    // A real model from the Kenney kit, when that type has one (angkot does not: it keeps the
    // reference-built body). Falls through to the procedural body if the model did not load.
    const modelId = TYPE_TO_MODEL[this.type];
    if (modelId && MODELS[modelId]) {
      this.buildFromModel(modelId);
      return;
    }
    const g = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({
      color: this.isPolice ? 0x1b2436 : this.color,
      roughness: 0.36,
      metalness: 0.22,
      flatShading: true,
    });
    // glass is see-through: an opaque windscreen hides the driver and the car looks remote
    const glass = new THREE.MeshStandardMaterial({
      color: 0xcdeeff,
      roughness: 0.08,
      metalness: 0.2,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
    });
    const darkGlass = new THREE.MeshStandardMaterial({
      color: 0x33455c,
      roughness: 0.14,
      metalness: 0.3,
      transparent: true,
      opacity: 0.26,
      depthWrite: false,
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
    const wheelGeo = new THREE.CylinderGeometry(this.wheelRadius, this.wheelRadius, 0.34, 14);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x141419, roughness: 0.92, flatShading: true });
    const hubGeo = new THREE.CylinderGeometry(this.wheelRadius * 0.5, this.wheelRadius * 0.5, 0.36, 10);
    const hubMat = new THREE.MeshStandardMaterial({ color: 0xc9ccd2, roughness: 0.35, metalness: 0.75 });
    this.wheels = [];
    const wz = L * (this.type === 'angkot' ? 0.31 : 0.33);
    const wx = W * 0.5 + 0.05;
    const wheelOffsets: [number, number, boolean][] = [[-1, 1, true], [1, 1, true], [-1, -1, false], [1, -1, false]];
    for (const [sx, sz, front] of wheelOffsets) {
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

      // wheel well + chunky fender flare
      const liner = new THREE.Mesh(rb(0.1, 0.5, 0.9, 0.06, 1), new THREE.MeshStandardMaterial({ color: 0x14141a, roughness: 0.95 }));
      liner.position.set(sx * (W * 0.47), this.wheelRadius + 0.1, sz * wz);
      g.add(liner);
      const flare = new THREE.Mesh(rb(0.2, 0.18, 1.05, 0.06, 1), paint);
      flare.position.set(sx * (W * 0.49), this.wheelRadius + 0.33, sz * wz);
      g.add(flare);
    }

    if (this.type === 'angkot') {
      const angkotGlass = new THREE.MeshStandardMaterial({ color: 0x1b2430, roughness: 0.18, metalness: 0.35, transparent: true, opacity: 0.72 });
      const routeTex = canvasTexture(512, 96, (c, cw, ch) => {
        c.fillStyle = '#f7f4e8';
        c.fillRect(0, 0, cw, ch);
        c.fillStyle = '#1f3f7a';
        c.fillRect(0, ch - 14, cw, 14);
        c.fillStyle = '#1d2a3a';
        c.font = '700 44px system-ui, sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText('M26  KAMPUNG MELAYU', cw / 2, ch / 2 - 4);
      });
      const routeMat = new THREE.MeshStandardMaterial({ map: routeTex, roughness: 0.65 });
      // Angkot, matched to the reference photos of a Colt L300 / Carry minibus conversion:
      // a one-box body 4.2 m long, 1.74 m wide, 1.88 m tall on a 2.6 m wheelbase, short nose,
      // steep windscreen, a tall dark glass band of three windows a side and a sliding door.
      const bodyTop = 1.86;
      const shell = new THREE.Mesh(rb(W * 0.96, bodyTop - 0.42, L * 0.94, 0.08, 2), paint);
      shell.position.set(0, 0.42 + (bodyTop - 0.42) / 2, -L * 0.02);
      shell.castShadow = true;
      shell.receiveShadow = true;
      g.add(shell);

      // short bonnet and the steeply raked windscreen above it
      const nose = new THREE.Mesh(rb(W * 0.9, 0.42, L * 0.16, 0.08, 1), paint);
      nose.position.set(0, 0.78, L * 0.45);
      nose.castShadow = true;
      g.add(nose);
      const windshield = new THREE.Mesh(rb(W * 0.86, 0.78, 0.06, 0.02, 1), angkotGlass);
      windshield.position.set(0, 1.44, L * 0.41);
      windshield.rotation.x = -0.28;
      g.add(windshield);

      // roof, slightly crowned, with the route sign over the cab
      const roof = new THREE.Mesh(rb(W * 0.98, 0.09, L * 0.92, 0.04, 1), paint);
      roof.position.set(0, bodyTop + 0.03, -L * 0.02);
      roof.castShadow = true;
      g.add(roof);
      const signTex = canvasTexture(256, 96, (c, cw, ch) => {
        c.fillStyle = '#f6f4ea';
        c.fillRect(0, 0, cw, ch);
        c.fillStyle = '#1d2a3a';
        c.font = '700 42px system-ui, sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText('ANGKOT', cw / 2, ch / 2);
      });
      const sign = new THREE.Mesh(
        new THREE.BoxGeometry(0.72, 0.2, 0.26),
        new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.6, emissive: 0xffffff, emissiveMap: signTex, emissiveIntensity: 0.1 })
      );
      sign.position.set(0, bodyTop + 0.18, L * 0.22);
      g.add(sign);

      // three windows a side: front door, sliding door, rear quarter
      for (const sx of [-1, 1]) {
        const win = (z: number, len: number, h = 0.6, y = 1.5) => {
          const m = new THREE.Mesh(rb(0.06, h, len, 0.015, 1), angkotGlass);
          m.position.set(sx * W * 0.49, y, z);
          g.add(m);
        };
        win(L * 0.27, L * 0.17);
        win(L * 0.02, L * 0.24);
        // door shut lines and the sliding-door rail
        const seam = (z: number) => {
          const m = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.3, 0.03), trim);
          m.position.set(sx * W * 0.495, 1.15, z);
          g.add(m);
        };
        seam(L * 0.37);
        seam(L * 0.14);
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, L * 0.4), trim);
        rail.position.set(sx * W * 0.497, 1.18, L * 0.06);
        g.add(rail);
        // handle + running step under the sliding door
        const handle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, 0.18), trim);
        handle.position.set(sx * W * 0.5, 1.16, L * 0.14);
        g.add(handle);
        const step = new THREE.Mesh(rb(0.16, 0.08, L * 0.3, 0.02, 1), trim);
        step.position.set(sx * W * 0.52, 0.44, L * 0.04);
        g.add(step);
        // mirror on a short stalk
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.04, 0.04), trim);
        arm.position.set(sx * W * 0.52, 1.4, L * 0.4);
        g.add(arm);
        const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.12), trim);
        mirror.position.set(sx * W * 0.55, 1.4, L * 0.4);
        g.add(mirror);
      }

      // rear: vertical hatch with glass and two tall tail lights
      const rearGlass = new THREE.Mesh(rb(W * 0.8, 0.5, 0.04, 0.02, 1), angkotGlass);
      rearGlass.position.set(0, 1.48, -L * 0.47);
      g.add(rearGlass);
      for (const sx of [-1, 1]) {
        const tail = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.42, 0.05), new THREE.MeshStandardMaterial({ color: 0xd0342c, emissive: 0x5a0f0a, emissiveIntensity: 0.35, roughness: 0.5 }));
        tail.position.set(sx * W * 0.38, 1.0, -L * 0.475);
        g.add(tail);
      }
      // route board and the painted band with the trayek name along both flanks
      for (const sx of [-1, 1]) {
        const board = new THREE.Mesh(new THREE.PlaneGeometry(L * 0.42, 0.24), routeMat);
        board.position.set(sx * W * 0.495, 1.1, -L * 0.05);
        board.rotation.y = (sx * Math.PI) / 2;
        g.add(board);
        const band = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.12, L * 0.9), new THREE.MeshStandardMaterial({ color: 0x1f3f7a, roughness: 0.7 }));
        band.position.set(sx * W * 0.49, 1.0, 0);
        g.add(band);
      }

      // front fascia: black grille, rectangular headlights, body-colour bumper
      const grille = new THREE.Mesh(new THREE.BoxGeometry(W * 0.5, 0.16, 0.06), trim);
      grille.position.set(0, 0.92, L * 0.475);
      g.add(grille);
      for (const sx of [-1, 1]) {
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, 0.06), new THREE.MeshStandardMaterial({ color: 0xf7f2d8, roughness: 0.35 }));
        lamp.position.set(sx * W * 0.31, 0.92, L * 0.472);
        g.add(lamp);
      }
      const bumper = new THREE.Mesh(rb(W * 0.96, 0.2, 0.14, 0.05, 1), paint);
      bumper.position.set(0, 0.62, L * 0.47);
      g.add(bumper);
    } else if (isVan) {
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
        windshield.rotation.x = -0.3;
        g.add(windshield);
        // A-pillars + header rail so the glass is not a floating pane
        const frameMat = new THREE.MeshStandardMaterial({ color: 0x1a1a20, roughness: 0.6 });
        for (const sx of [-1, 1]) {
          const apillar = new THREE.Mesh(rb(0.045, 0.54, 0.06, 0.015, 1), frameMat);
          apillar.position.set(sx * W * 0.43, 1.24, L * 0.13);
          apillar.rotation.x = -0.3;
          g.add(apillar);
        }
        const header = new THREE.Mesh(rb(W * 0.87, 0.05, 0.07, 0.015, 1), frameMat);
        header.position.set(0, 1.43, L * 0.1);
        g.add(header);
        const sill = new THREE.Mesh(rb(W * 0.87, 0.05, 0.07, 0.015, 1), frameMat);
        sill.position.set(0, 0.99, L * 0.19);
        g.add(sill);
        // cockpit tub, dash, steering wheel, console
        const tub = new THREE.Mesh(rb(W * 0.78, 0.22, L * 0.3, 0.04, 1), new THREE.MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.9 }));
        tub.position.set(0, 0.92, -0.18);
        g.add(tub);
        const dash = new THREE.Mesh(rb(W * 0.8, 0.24, 0.16, 0.03, 1), new THREE.MeshStandardMaterial({ color: 0x23232a, roughness: 0.85 }));
        dash.position.set(0, 1.02, L * 0.06);
        g.add(dash);
        const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.04, 6, 12), new THREE.MeshStandardMaterial({ color: 0x14141a, roughness: 0.8 }));
        wheel.position.set(-0.4, 1.16, 0.02);
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
        const stripeMat = new THREE.MeshStandardMaterial({ color: 0xf4f4ea, roughness: 0.5 });
        for (const sx of [-1, 1]) {
          const stripe = new THREE.Mesh(rb(0.16, 0.03, L * 0.29, 0.01, 1), stripeMat);
          stripe.position.set(sx * 0.13, 1.06, L * 0.3);
          g.add(stripe);
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
    const bumperSides: [number, boolean][] = [[1, true], [-1, false]];
    for (const [sz, isFront] of bumperSides) {
      const bumper = new THREE.Mesh(rb(W * 0.94, 0.16, 0.18, 0.05, 1), chrome);
      bumper.position.set(0, 0.52, sz * (L * 0.5 - 0.02));
      g.add(bumper);
      if (!this.simple) {
        const grille = new THREE.Mesh(rb(W * 0.46, 0.2, 0.07, 0.02, 1), trim);
        grille.position.set(0, 0.78, sz * (L * 0.49));
        g.add(grille);
      }
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
      bar.position.set(0, 1.52, -0.12);
      g.add(bar);
      this.lightRed = new THREE.MeshStandardMaterial({ color: 0xff2222, emissive: 0xff0000, emissiveIntensity: 1 });
      this.lightBlue = new THREE.MeshStandardMaterial({ color: 0x2244ff, emissive: 0x0033ff, emissiveIntensity: 1 });
      const lr = new THREE.Mesh(rb(0.34, 0.14, 0.3, 0.03, 1), this.lightRed);
      lr.position.set(-W * 0.22, 1.6, -0.12);
      g.add(lr);
      const lb = new THREE.Mesh(rb(0.34, 0.14, 0.3, 0.03, 1), this.lightBlue);
      lb.position.set(W * 0.22, 1.6, -0.12);
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

    // mirrors, plate, exhaust tips (skipped on ambient traffic to save draw calls)
    if (!this.simple) for (const sx of [-1, 1]) {
      // mirror on a stalk that actually reaches the door, instead of hovering beside it
      const stalk = new THREE.Mesh(rb(0.13, 0.035, 0.035, 0.01, 1), trim);
      stalk.position.set(sx * (W * 0.51), 1.02, L * 0.1);
      g.add(stalk);
      const mirror = new THREE.Mesh(rb(0.1, 0.09, 0.16, 0.02, 1), chrome);
      mirror.position.set(sx * (W * 0.535), 1.02, L * 0.1);
      g.add(mirror);
    }
    if (!this.simple) {
      const plate = new THREE.Mesh(rb(0.44, 0.14, 0.04, 0.01, 1), new THREE.MeshStandardMaterial({ color: 0xf4f4ea, roughness: 0.6 }));
      plate.position.set(0, 0.6, -L * 0.5 - 0.02);
      g.add(plate);
      for (const sx of [-1, 1]) {
        const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.18, 8), chrome);
        pipe.rotation.x = Math.PI / 2;
        pipe.position.set(sx * 0.28, 0.36, -L * 0.5 + 0.02);
        g.add(pipe);
      }
    }

    const blob = shadowBlob(W * 1.25, L * 1.05, 0.4);
    blob.position.y = 0.05;
    g.add(blob);

    this.mesh = g;
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = this.yaw;
    this.scene.add(g);
  }

  /** Body from a real car model, with its own wheel nodes wired to the steering and spin. */
  buildFromModel(modelId: any) {
    const g = new THREE.Group();
    const built = instantiateModel(modelId, this.length, this.color);
    if (!built) {
      this.build();
      return;
    }
    // the kit's origin is not the tyre contact patch: drop the body so the wheels sit on 0.
    // The offset has to come from a matrixWorld-updated box, otherwise it is measured unscaled.
    built.root.position.y -= built.minY;
    g.add(built.root);
    this.wheels = built.wheels;
    this.modelSize = built.size;
    // the model's wheel centres sit at its own ride height, so the radius has to come from the
    // geometry: the procedural spec would leave the audit thinking the car is sunk
    if (built.wheels.length) {
      this.wheelRadius = Math.max(...built.wheels.map((w: any) => w.pivot.position.y));
    }
    // the driver sits in the front-left seat of whatever body we got
    this.driverAnchor = new THREE.Vector3(
      -built.size.x * 0.22,
      built.size.y * 0.42,
      built.size.z * 0.06
    );
    const blob = shadowBlob(this.width * 1.25, this.length * 1.05, 0.4);
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

  /** absolute speed in km/h, the number the HUD and the harness read */
  get kmh() {
    return Math.abs(this.speed) * 3.6;
  }

  /**
   * 0..1 engine note across 5 gear steps: within a gear the value climbs, then
   * drops on the shift, so the audio follows road speed with a stepped curve
   * instead of one flat drone.
   */
  get engineRpm01() {
    const gears = 5;
    const v = clamp(Math.abs(this.speed) / Math.max(1, this.maxSpeed), 0, 0.999);
    const span = 1 / gears;
    const gear = Math.min(gears - 1, Math.floor(v / span));
    const inGear = clamp((v - gear * span) / span, 0, 1);
    return clamp((gear + inGear) / gears, 0, 1);
  }

  /** A driver you can see through the windscreen: head, shoulders, hair, hands on the wheel.
   *  Cheap on purpose — three boxes and two arms, not a full character rig. */
  addDriver(skin = 0xe0b28d, shirt = 0x3346a8, hair = 0x241a14) {
    this.driverLook = [skin, shirt, hair];
    if (this.driver) {
      this.driver.visible = true;
      return this.driver;
    }
    const g = new THREE.Group();
    const skinMat = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.85, flatShading: true });
    const shirtMat = new THREE.MeshStandardMaterial({ color: shirt, roughness: 0.9, flatShading: true });
    const hairMat = new THREE.MeshStandardMaterial({ color: hair, roughness: 0.95, flatShading: true });
    const bx = (mat: any, w: number, h: number, d: number, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      g.add(m);
      return m;
    };
    bx(shirtMat, 0.42, 0.52, 0.28, 0, 0.26, 0);   // torso and arms as one block
    bx(skinMat, 0.3, 0.3, 0.3, 0, 0.62, 0.02);     // head
    bx(hairMat, 0.32, 0.09, 0.31, 0, 0.78, 0.02);  // hair cap
    // left-hand drive, sitting where the steering wheel is; a modelled body knows its own size
    if (this.driverAnchor) g.position.copy(this.driverAnchor);
    else g.position.set(-0.4, 0.98, -0.22);
    this.mesh.add(g);
    this.driver = g;
    return g;
  }

  setDriverVisible(v: boolean) {
    if (this.driver) this.driver.visible = v;
  }

  applyDamage(n: number) {
    if (this.wrecked) return;
    this.health = clamp(this.health - n, 0, 100);
    if (this.health <= 0) {
      this.wrecked = true;
      this.health = 0;
    }
  }

  jump(power: number = 8.5) {
    if (this.y > 0.2) return;
    this.vy = power;
    this.y = 0.05;
  }

  update(dt: number, input: any = {}, colliders: any[] = [], worldHalf = 220) {
    const throttle = input.throttle ?? 0;
    const steerInput = input.steer ?? 0;
    const braking = input.brake ?? false;
    const handbrake = input.handbrake ?? false;

    const maxSpeed = this.wrecked ? 0 : this.maxSpeed;
    const accel = this.wrecked ? 0 : this.accel;

    // Engine curve: acceleration tapers quadratically as the car closes on its
    // spec top speed, so the gearbox pulls hard off the line and then eases
    // into maxSpeed instead of stalling against a linear drag wall
    // (the old `speed -= speed * 0.55 * dt` capped the sedan at 20 m/s).
    if (throttle > 0.05) {
      const r = clamp(this.speed / maxSpeed, 0, 1);
      this.speed += accel * throttle * (1 - r * r) * dt;
    } else if (throttle < -0.05) {
      const r = clamp(-this.speed / (maxSpeed * REVERSE_CAP), 0, 1);
      this.speed += accel * 0.7 * throttle * (1 - r * r) * dt;
    }

    if (braking && this.speed !== 0) {
      const drop = this.brake * dt;
      this.speed = Math.abs(this.speed) <= drop ? 0 : this.speed - Math.sign(this.speed) * drop;
    }
    if (handbrake && this.speed !== 0) {
      // a handbrake in an arcade racer is a drift trigger, not a brake pedal: it scrubs some
      // speed but must leave enough momentum to carry the slide
      const drop = 4 * dt;
      this.speed = Math.abs(this.speed) <= drop ? 0 : this.speed - Math.sign(this.speed) * drop;
    }

    // rolling resistance + aero drag, only when the engine is not pulling:
    // coasting, or over the spec speed after a ramp launch / collision kick
    const coasting = Math.abs(throttle) <= 0.05;
    const cap = maxSpeed * (this.speed < 0 ? REVERSE_CAP : 1);
    if (coasting || Math.abs(this.speed) > cap) {
      this.speed -= this.speed * (this.wrecked ? WRECK_DRAG : COAST_DRAG) * dt;
    }
    this.speed = clamp(this.speed, -maxSpeed * REVERSE_CAP, maxSpeed * 1.08);
    if (Math.abs(this.speed) < 0.12) this.speed = 0;

    // Steering grip falls as speed rises. The car is no longer kinematic: momentum is split
    // into a forward and a sideways component, so the body can rotate ahead of the direction
    // of travel and the tyres have something to slip against.
    const speedFactor = clamp(Math.abs(this.speed) / this.maxSpeed, 0, 1);
    const maxSteer = 0.62 - speedFactor * 0.3;
    this.steer = lerp(this.steer, steerInput * maxSteer, clamp(dt * 9, 0, 1));

    const fwd = this.forward;
    const rightX = fwd.z;
    const rightZ = -fwd.x;
    let vLat = this.vx * rightX + this.vz * rightZ;

    // Yaw the front wheels ask for, capped: the tail may outrun the nose, which is a drift
    const yawAsk = (this.speed / WHEELBASE) * Math.tan(this.steer);
    const yawCap = handbrake ? 2.2 : 1.75;
    const yawRate = clamp(yawAsk, -yawCap, yawCap);
    this.yaw += yawRate * dt;

    // Sideways grip: strong while rolling, nearly gone on the handbrake
    const gripRate = handbrake ? this.grip * 0.14 : this.grip * 1.5;
    vLat *= Math.exp(-gripRate * dt);
    // Rotating the body throws weight sideways: with the handbrake, that slide survives
    vLat -= yawRate * this.speed * dt * (handbrake ? 0.62 : 0.3);

    this.slip = Math.atan2(vLat, Math.abs(this.speed) + 0.001);
    this.vx = fwd.x * this.speed + rightX * vLat;
    this.vz = fwd.z * this.speed + rightZ * vLat;
    // total momentum still obeys the spec top speed, otherwise a long slide adds lateral
    // speed on top of forward speed and the car exceeds its own limit
    const total = Math.hypot(this.vx, this.vz);
    const topSpeed = this.maxSpeed * 1.08;
    if (total > topSpeed) {
      const k = topSpeed / total;
      this.vx *= k;
      this.vz *= k;
    }
    this.pos.x += this.vx * dt;
    this.pos.z += this.vz * dt;

    // collision with buildings / props
    let hit = null;
    for (const b of colliders) {
      if (b.h !== undefined && b.h < 0.6) continue;
      const res = resolveCircleBox(this.pos.x, this.pos.z, this.radius * 0.82, b);
      if (res) {
        const impact = Math.hypot(this.vx, this.vz);
        this.pos.x = res.x;
        this.pos.z = res.z;
        if (impact > 4) {
          this.applyDamage(impact * 0.9);
          hit = { impact, x: res.x, z: res.z };
        }
        this.lastCollision = { x: res.x, z: res.z, box: b };
        this.speed *= -0.28;
        // a wall kills the slide as well as the forward speed
        this.vx = 0;
        this.vz = 0;
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

    // brake light feedback
    const brakingNow = braking || handbrake;
    if (brakingNow !== this.brakeLight) {
      this.brakeLight = brakingNow;
      if (this.tailMat) this.tailMat.emissiveIntensity = brakingNow ? 2.2 : 0.6;
    }

    for (const w of this.wheels) {
      w.wheel.rotation.x -= (this.speed * dt) / this.wheelRadius;
      if (w.front) w.pivot.rotation.y = this.steer;
    }

    this.brakeLight = false;
    // police lightbar
    if (this.isPolice && this.lightRed && this.lightBlue) {
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

  /**
   * Swap the body in place, used when the real models finish loading after the game already
   * built its procedural cars: same physics state, new body.
   */
  rebuild() {
    const look = this.driverLook;
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.traverse((o: any) => {
        if (o.isMesh) {
          o.geometry?.dispose?.();
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m: any) => m?.dispose?.());
        }
      });
    }
    this.driver = null;
    this.wheels = [];
    this.build();
    if (look) this.addDriver(...look);
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = this.yaw;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.traverse((o: any) => {
      if (o.isMesh) {
        o.geometry?.dispose();
        o.material?.dispose?.();
      }
    });
  }
}

/** Random skin/shirt/hair triple for a visible driver. */
export function driverLook(): [number, number, number] {
  const skins = [0xe0b28d, 0xd8a273, 0xb97f52, 0x8d5a3b, 0xf0c9a6];
  const shirts = [0x3346a8, 0xb8443a, 0x2f7f5b, 0xd0d0d8, 0x3a3a44, 0x8a6a2f, 0xb0552f];
  const hairs = [0x241a14, 0x120f0d, 0x3a2a1c, 0x6b5540];
  const pickOne = (a: number[]) => a[Math.floor(Math.random() * a.length)];
  return [pickOne(skins), pickOne(shirts), pickOne(hairs)];
}
