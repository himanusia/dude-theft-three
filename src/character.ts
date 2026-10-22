import * as THREE from 'three';
import { rand, pick, shadowBlob, roundedBox, canvasTexture } from './utils';

// Proportions measured off real Dude Theft Wars screenshots:
// 1.84 m tall, head 0.42 (≈4.4 heads), torso 0.54×0.58×0.31, arms 0.62, legs 0.72, no neck.
const SHIRTS = [0x3346a8, 0x5a2c8a, 0xd93b3b, 0x2f8f5b, 0xffd23f, 0xf2f2f6, 0x1c1c22, 0xe86a2b];
const PANTS = [0x1b1f2e, 0x2f3a52, 0x2b2b31, 0x3f4a63, 0x5a4632];
const SKINS = [0xe0b28d, 0xc98d63, 0x9b6136, 0x7a4a2e, 0x5a3520];
const HAIRS = [0x151515, 0x2c1d12, 0x4a3120, 0x6b4a2a];

// shared assets so 40+ pedestrians don't blow up memory / state changes
const GEO = {
  head: roundedBox(0.44, 0.44, 0.44, 0.035, 1),
  hair: roundedBox(0.47, 0.16, 0.47, 0.03, 1),
  torso: roundedBox(0.55, 0.58, 0.32, 0.04, 1),
  hips: roundedBox(0.51, 0.16, 0.31, 0.03, 1),
  arm: roundedBox(0.16, 0.62, 0.17, 0.03, 1),
  hand: roundedBox(0.175, 0.19, 0.18, 0.035, 1),
  leg: roundedBox(0.2, 0.72, 0.21, 0.035, 1),
  shoe: roundedBox(0.215, 0.15, 0.31, 0.035, 1),
  ear: roundedBox(0.045, 0.1, 0.08, 0.015, 1),
  hairBack: roundedBox(0.46, 0.26, 0.14, 0.03, 1),
  hairSide: roundedBox(0.06, 0.2, 0.4, 0.02, 1),
  collar: roundedBox(0.42, 0.08, 0.3, 0.02, 1),
  cuff: roundedBox(0.18, 0.12, 0.19, 0.02, 1),
  face: new THREE.PlaneGeometry(0.375, 0.35),
  grip: new THREE.BoxGeometry(0.075, 0.19, 0.1),
  slide: new THREE.BoxGeometry(0.08, 0.09, 0.33),
};

const MATS = new Map();
function mat(color: number, opts: any = {}) {
  const key = color + '|' + JSON.stringify(opts);
  if (!MATS.has(key)) {
    MATS.set(
      key,
      new THREE.MeshStandardMaterial({
        color,
        roughness: opts.roughness ?? 0.85,
        metalness: opts.metalness ?? 0.02,
        flatShading: opts.flat ?? true,
      })
    );
  }
  return MATS.get(key);
}
const SHOE_MAT = mat(0x14141a, { roughness: 0.8 });
const GUN_MAT = mat(0x2a2c31, { roughness: 0.4, metalness: 0.6, flat: false });

// simple painted faces (eyes + brows + mouth), one crisp canvas per expression
const FACE_TEX = new Map();
function faceTexture(kind = 'calm') {
  if (FACE_TEX.has(kind)) return FACE_TEX.get(kind);
  const tex = canvasTexture(256, 256, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const eyeY = h * 0.45;
    const eyeDX = w * 0.2;
    const eyeR = 20;

    if (kind === 'shades') {
      // framed sunglasses with bridge
      ctx.fillStyle = '#14100e';
      ctx.beginPath();
      ctx.roundRect(cx - eyeDX - 34, eyeY - 22, 68, 44, 10);
      ctx.roundRect(cx + eyeDX - 34, eyeY - 22, 68, 44, 10);
      ctx.fill();
      ctx.fillRect(cx - 12, eyeY - 8, 24, 8);
      ctx.fillStyle = 'rgba(150,220,255,0.5)';
      ctx.fillRect(cx - eyeDX - 28, eyeY - 16, 26, 20);
      ctx.fillRect(cx + eyeDX - 6, eyeY - 16, 26, 20);
    } else {
      for (const sx of [-1, 1]) {
        // sclera
        ctx.fillStyle = '#fbf7f2';
        ctx.beginPath();
        ctx.ellipse(cx + sx * eyeDX, eyeY, eyeR, eyeR * 0.86, 0, 0, Math.PI * 2);
        ctx.fill();
        // pupil
        ctx.fillStyle = '#17110d';
        ctx.beginPath();
        ctx.arc(cx + sx * eyeDX + sx * 3, eyeY + 2, eyeR * 0.52, 0, Math.PI * 2);
        ctx.fill();
        // catchlight
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.arc(cx + sx * eyeDX + sx * 3 + 5, eyeY - 4, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      // brows
      ctx.strokeStyle = '#231812';
      ctx.lineWidth = 11;
      ctx.lineCap = 'round';
      const tilt = kind === 'angry' ? 9 : kind === 'smirk' ? 5 : 0;
      for (const sx of [-1, 1]) {
        const asym = kind === 'smirk' && sx < 0 ? 6 : 0;
        ctx.beginPath();
        ctx.moveTo(cx + sx * (eyeDX + 20), eyeY - 40 + sx * tilt + asym);
        ctx.lineTo(cx + sx * (eyeDX - 20), eyeY - 34 - sx * tilt);
        ctx.stroke();
      }
    }

    // moustache for some dudes
    if (kind === 'stache') {
      ctx.fillStyle = '#241812';
      ctx.beginPath();
      ctx.ellipse(cx, h * 0.665, 46, 16, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // mouth
    ctx.strokeStyle = '#40231b';
    ctx.lineWidth = 12;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (kind === 'angry') {
      ctx.moveTo(cx - 32, h * 0.73);
      ctx.lineTo(cx + 32, h * 0.69);
    } else if (kind === 'smirk') {
      ctx.moveTo(cx - 30, h * 0.69);
      ctx.quadraticCurveTo(cx + 14, h * 0.76, cx + 34, h * 0.66);
    } else {
      ctx.arc(cx, h * 0.62, 38, 0.22 * Math.PI, 0.78 * Math.PI);
    }
    ctx.stroke();
  });
  FACE_TEX.set(kind, tex);
  return tex;
}

export class Character {
  declare skin: any;
  declare shirt: any;
  declare pants: any;
  declare scale: any;
  declare height: number;
  declare face: any;
  declare gun: any;
  declare group: any;
  declare torso: any;
  declare head: any;
  declare armL: any;
  declare armR: any;
  declare legL: any;
  declare legR: any;
  declare phase: number;
  declare detail: THREE.Object3D[];
  declare headMeshRef: THREE.Mesh;
  declare footLift: any;
  constructor(opts: any = {}) {
    this.skin = opts.skin ?? pick(SKINS);
    this.shirt = opts.shirt ?? pick(SHIRTS);
    this.pants = opts.pants ?? pick(PANTS);
    this.scale = opts.scale ?? 1;
    this.height = 1.84;

    const skinMat = mat(this.skin, { roughness: 0.88 });
    const shirtMat = mat(this.shirt, { roughness: 0.9 });
    const pantsMat = mat(this.pants, { roughness: 0.92 });
    const hairMat = mat(pick(HAIRS), { roughness: 0.95 });

    const root = new THREE.Group();
    root.scale.setScalar(this.scale);

    const make = (geo: any, material: any, x: number, y: number, z: number, parent: any, cast = true) => {
      const m = new THREE.Mesh(geo, material);
      m.position.set(x, y, z);
      m.castShadow = cast;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };

    // torso — head sits straight on the shoulders, no neck
    const torso = new THREE.Group();
    torso.position.y = 0.8;
    root.add(torso);
    make(GEO.torso, shirtMat, 0, 0.31, 0, torso);
    make(GEO.hips, pantsMat, 0, 0.03, 0, torso);

    const head = new THREE.Group();
    head.position.y = 0.62;
    torso.add(head);
    this.headMeshRef = make(GEO.head, skinMat, 0, 0.22, 0, head);
    make(GEO.hair, hairMat, 0, 0.45, 0, head, false);
    // hair silhouettes so the crowd is not one repeated model
    const hairStyle = opts.hair ?? pick(['cap', 'cap', 'back', 'beanie', 'bald', 'mohawk']);
    if (hairStyle === 'back' || hairStyle === 'beanie') {
      make(GEO.hairBack, hairMat, 0, 0.34, -0.13, head, false);
      for (const sx of [-1, 1]) make(GEO.hairSide, hairMat, sx * 0.235, 0.35, -0.02, head, false);
    }
    if (hairStyle === 'beanie') {
      const beanie = new THREE.Mesh(GEO.hair, mat(pick([0xd93b3b, 0x2f6fd0, 0x2f8f5b, 0xf2f2f6]), { roughness: 0.95 }));
      beanie.position.set(0, 0.47, 0);
      beanie.scale.set(1.02, 1.35, 1.02);
      head.add(beanie);
    }
    if (hairStyle === 'bald') {
      head.children[1].visible = false; // hide the hair slab
    }
    if (hairStyle === 'mohawk') {
      head.children[1].visible = false;
      for (let k = 0; k < 5; k++) {
        const tuft = new THREE.Mesh(roundedBox(0.1, 0.16, 0.09, 0.02, 1), hairMat);
        tuft.position.set(0, 0.46 + (k === 2 ? 0.06 : 0), -0.16 + k * 0.08);
        head.add(tuft);
      }
    }

    const faceKind = opts.face ?? pick(['calm', 'calm', 'angry', 'shades', 'smirk', 'stache']);
    const face = new THREE.Mesh(
      GEO.face,
      new THREE.MeshStandardMaterial({
        map: faceTexture(faceKind),
        transparent: true,
        roughness: 0.9,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      })
    );
    face.position.set(0, 0.21, 0.222);
    head.add(face);
    this.face = face;
    const nose = new THREE.Mesh(roundedBox(0.075, 0.09, 0.06, 0.02, 1), skinMat);
    nose.position.set(0, 0.18, 0.235);
    head.add(nose);

    // short sleeves on some dudes, like the reference crowd
    const shortSleeves = Math.random() < 0.45;
    const sleeveMat = shortSleeves ? skinMat : shirtMat;

    const armL = new THREE.Group();
    armL.position.set(-0.335, 0.52, 0);
    torso.add(armL);
    make(GEO.arm, sleeveMat, 0, -0.3, 0, armL);
    if (shortSleeves) make(GEO.cuff, shirtMat, 0, -0.05, 0, armL, false);
    make(GEO.hand, skinMat, 0, -0.65, 0, armL, false);

    const armR = new THREE.Group();
    armR.position.set(0.335, 0.52, 0);
    torso.add(armR);
    make(GEO.arm, sleeveMat, 0, -0.3, 0, armR);
    if (shortSleeves) make(GEO.cuff, shirtMat, 0, -0.05, 0, armR, false);
    make(GEO.hand, skinMat, 0, -0.65, 0, armR, false);

    const legL = new THREE.Group();
    legL.position.set(-0.14, 0.8, 0);
    root.add(legL);
    make(GEO.leg, pantsMat, 0, -0.36, 0, legL);
    make(GEO.shoe, SHOE_MAT, 0, -0.725, 0.03, legL);

    const legR = new THREE.Group();
    legR.position.set(0.14, 0.8, 0);
    root.add(legR);
    make(GEO.leg, pantsMat, 0, -0.36, 0, legR);
    make(GEO.shoe, SHOE_MAT, 0, -0.725, 0.03, legR);

    // pistol held in the right hand
    const gun = new THREE.Group();
    const grip = new THREE.Mesh(GEO.grip, GUN_MAT);
    grip.position.set(0, -0.02, 0.02);
    gun.add(grip);
    const slide = new THREE.Mesh(GEO.slide, GUN_MAT);
    slide.position.set(0, 0.08, 0.14);
    gun.add(slide);
    gun.position.set(0, -0.68, 0.08);
    gun.rotation.x = -0.15;
    armR.add(gun);
    this.gun = gun;
    gun.visible = false;

    const blob = shadowBlob(1.15, 1.15, 0.3);
    blob.position.y = 0.02;
    root.add(blob);

    this.group = root;
    this.torso = torso;
    this.head = head;
    this.armL = armL;
    this.armR = armR;
    this.legL = legL;
    this.legR = legR;
    this.phase = 0;
    // small parts that can be dropped at distance without changing the silhouette
    this.detail = [face, nose, this.armL.children[1], this.armR.children[1]];
    if (this.armL.children[2]) this.detail.push(this.armL.children[2]);
    if (this.armR.children[2]) this.detail.push(this.armR.children[2]);
    for (const child of head.children) {
      if (child !== this.headMeshRef) this.detail.push(child);
    }
  }

  setDetail(on: boolean) {
    for (const d of this.detail) d.visible = on;
    if (on) this.gun.visible = this.gun.userData.armed === true;
  }

  setArmed(on: boolean) {
    this.gun.visible = on;
  }

  setPos(x: number, y: number, z: number) {
    this.group.position.set(x, y, z);
  }

  setYaw(y: number) {
    this.group.rotation.y = y;
  }

  animate(dt: number, speed01: any, opts: any = {}) {
    this.phase += dt * (4.2 + speed01 * 7.4) * (speed01 > 0.02 ? 1 : 0);
    const amp = 0.3 + speed01 * 0.9;
    const sw = Math.sin(this.phase);

    if (opts.aiming) {
      this.armR.rotation.x = -Math.PI / 2 + 0.05;
      this.armL.rotation.x = -Math.PI / 2 + 0.28;
      this.armR.rotation.z = 0;
      this.armL.rotation.z = 0.28;
    } else {
      this.armR.rotation.x = -sw * amp * 0.8;
      this.armL.rotation.x = sw * amp * 0.8;
      this.armR.rotation.z = 0;
      this.armL.rotation.z = 0;
    }
    this.legL.rotation.x = sw * amp;
    this.legR.rotation.x = -sw * amp;
    // the pendulum swing lifts both feet; callers subtract this so the planted
    // foot always touches the ground (works for frozen LOD poses too)
    this.footLift = 0.725 * (1 - Math.cos(Math.abs(sw) * amp));
    this.torso.rotation.z = opts.tilt ?? 0;
    this.torso.rotation.x = speed01 * 0.1;
    this.torso.position.y = speed01 < 0.02 ? 0.8 + Math.sin(performance.now() * 0.002) * 0.008 : 0.8;

    if (opts.airborne) {
      this.legL.rotation.x = 0.55;
      this.legR.rotation.x = -0.4;
      this.armL.rotation.x = -1;
      this.armR.rotation.x = -1;
    }
  }
}
