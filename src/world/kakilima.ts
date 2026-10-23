import * as THREE from 'three';
import { canvasTexture, mergeStaticChildren, shadowBlob } from '../core/utils';

/**
 * Street food and the two institutions a Jakarta street cannot be without.
 *
 * Everything here is built to the same contract as the rest of the world builders: the meshes
 * are added to `ctx.group`, a collider goes into `ctx.colliders`, and an entry goes into
 * `ctx.audit` so the floating-prop check can see it. All of it is procedural, and the signs use
 * plesetan names (the game never puts a real brand on a cart).
 */
export interface CartCtx {
  group: THREE.Group;
  colliders: { minX: number; maxX: number; minZ: number; maxZ: number; h: number }[];
  audit: { name: string; x: number; z: number; bottom: number }[];
}

const STEEL = 0xc9ced4;
const STEEL_DARK = 0x8b939c;
const STEEL_LIGHT = 0xe4e8ec;
const WOOD = 0x8a5f3a;
const RED = 0xc0392b;
const YELLOW = 0xf2c14e;
const TYRE = 0x232629;
/**
 * Gerobak wheels are 26-inch bicycle wheels: 0.66 m across, so the axle sits 0.33 m up. They stand
 * outboard of the 0.78 m cabinet, proud of the panels, the way the reference photos show them.
 */
const WHEEL_R = 0.33;
const AXLE_X = 0.38;    // ~75% of the body length from the vendor's end
const WHEEL_Z = 0.50;

/** a sign plate with text, drawn on a canvas so no font file is needed */
function signPlate(text: string, w: number, h: number, bg: string, fg = '#ffffff'): THREE.Mesh {
  const tex = canvasTexture(512, 128, (ctx, cw, ch) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cw, ch);
    ctx.strokeStyle = 'rgba(0,0,0,.25)';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, cw - 6, ch - 6);
    let size = 74;
    ctx.font = `800 ${size}px system-ui, sans-serif`;
    while (ctx.measureText(text).width > cw - 40 && size > 26) {
      size -= 4;
      ctx.font = `800 ${size}px system-ui, sans-serif`;
    }
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cw / 2, ch / 2 + 4);
  });
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, metalness: 0.05 })
  );
  return mesh;
}

/** the painted chest panel: pale enamel, the kind's colour band, and pavement grime */
function cartSkin(accent: string): THREE.CanvasTexture {
  return canvasTexture(256, 128, (ctx, w, h) => {
    ctx.fillStyle = '#e6dfcd';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = accent;
    ctx.fillRect(0, h - 30, w, 30);
    // scuffs: a cart that has been pushed along a Jakarta kerb is never clean
    for (let i = 0; i < 90; i++) {
      ctx.fillStyle = `rgba(60,52,40,${0.03 + Math.random() * 0.07})`;
      ctx.fillRect(Math.random() * w, h - 10 - Math.random() * 54, 1 + Math.random() * 2, 4 + Math.random() * 22);
    }
    const grime = ctx.createLinearGradient(0, h - 70, 0, h);
    grime.addColorStop(0, 'rgba(48,42,34,0)');
    grime.addColorStop(1, 'rgba(48,42,34,0.3)');
    ctx.fillStyle = grime;
    ctx.fillRect(0, h - 70, w, 70);
    ctx.strokeStyle = 'rgba(30,34,38,0.35)';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, w - 4, h - 4);
  });
}

export type KakiLimaKind = 'bakso' | 'nasgor' | 'sate';

const NAMES: Record<KakiLimaKind, string> = {
  bakso: 'BAKSO MAS KUMIS',
  nasgor: 'NASGOR GILA',
  sate: 'SATE CAK RUDI',
};

/**
 * A gerobak: the two-wheeled stainless cabinet a warung pushes along the pavement. The three kinds
 * differ in what is cooking on the worktop, because that is what tells them apart from ten metres
 * away — a stockpot, a wok over a burner, a charcoal grill.
 *
 * The proportions come from the two reference photographs in `reference/assets`
 * (`kakilima-jakarta-01.jpg`, `bakso-vendor-01.jpg`): a ~1.5 m cabinet riding on two 0.66 m spoked
 * wheels that stand OUTBOARD of the body with the axle 0.33 m up, a tubular push handle at hip
 * height, a tarp awning carried on four struts, and two braced legs under the vendor's end. The
 * wheels are bicycle wheels — tyre, rim, hub and spokes — because a solid dark disc is what made
 * the old cart read as a coin propped against a fridge.
 */
export function buildKakiLima(ctx: CartCtx, kind: KakiLimaKind, x: number, z: number, yaw: number): THREE.Group {
  const g = new THREE.Group();
  g.name = `kaki5-${kind}`;
  g.position.set(x, 0, z);
  g.rotation.y = yaw;
  // everything is built into `c` and merged per material at the bottom: a gerobak is ~90 small
  // meshes and six of them kerbside would be 540 draw calls on a phone
  const c = new THREE.Group();

  const accentCss = kind === 'bakso' ? '#a5281c' : kind === 'nasgor' ? '#b98513' : '#1f5d27';
  const accent = kind === 'bakso' ? RED : kind === 'nasgor' ? YELLOW : 0x2e7d32;

  const steel = new THREE.MeshStandardMaterial({ color: STEEL, metalness: 0.65, roughness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: STEEL_DARK, metalness: 0.45, roughness: 0.55 });
  const light = new THREE.MeshStandardMaterial({ color: STEEL_LIGHT, metalness: 0.55, roughness: 0.32 });
  const skin = new THREE.MeshStandardMaterial({ map: cartSkin(accentCss), metalness: 0.12, roughness: 0.78 });
  const paint = new THREE.MeshStandardMaterial({ color: accent, metalness: 0.3, roughness: 0.5 });
  const wood = new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.9 });
  const rubber = new THREE.MeshStandardMaterial({ color: TYRE, roughness: 0.95, metalness: 0.02 });
  const tarp = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.82 });
  const tarpDark = new THREE.MeshStandardMaterial({ color: new THREE.Color(accent).multiplyScalar(0.72), roughness: 0.86 });
  const glass = new THREE.MeshStandardMaterial({ color: 0xcfe8f2, transparent: true, opacity: 0.24, roughness: 0.1, metalness: 0.15 });
  const crock = new THREE.MeshStandardMaterial({ color: 0xf2ecdc, roughness: 0.62 });
  const coal = new THREE.MeshStandardMaterial({ color: 0x4a352a, emissive: 0xff6a20, emissiveIntensity: 0.85 });
  const stickMat = new THREE.MeshStandardMaterial({ color: 0xc9a06a, roughness: 0.85 });

  const box = (mat: THREE.Material, w: number, h: number, d: number, px: number, py: number, pz: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(px, py, pz);
    m.castShadow = true;
    m.receiveShadow = true;
    c.add(m);
    return m;
  };
  /** a rod between two local points: handle bars, canopy struts, spokes, braces */
  const rod = (mat: THREE.Material, a: [number, number, number], b: [number, number, number], r: number) => {
    const pa = new THREE.Vector3(...a);
    const pb = new THREE.Vector3(...b);
    const len = pa.distanceTo(pb);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8), mat);
    m.position.copy(pa).add(pb).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pb.clone().sub(pa).normalize());
    m.castShadow = true;
    c.add(m);
    return m;
  };
  const cylinder = (mat: THREE.Material, rTop: number, rBot: number, h: number, seg: number, px: number, py: number, pz: number) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mat);
    m.position.set(px, py, pz);
    m.castShadow = true;
    c.add(m);
    return m;
  };

  // ---- chassis and chest ------------------------------------------------------------------
  // The cart is a cabinet, not a slab: a steel chassis rail at 0.42 carries a panelled chest with
  // corner posts, a painted kick band and a stainless worktop. Chest top at 1.0, worktop at 1.03.
  box(dark, 1.52, 0.05, 0.80, 0, 0.445, 0);                  // chassis the wheels hang off
  box(skin, 1.46, 0.56, 0.74, 0, 0.72, 0);                   // panelled chest
  box(paint, 1.47, 0.11, 0.755, 0, 0.505, 0);                // painted kick band
  box(dark, 1.53, 0.05, 0.81, 0, 1.005, 0);                  // top rail
  box(light, 1.56, 0.04, 0.84, 0, 1.03, 0);                  // stainless worktop
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(steel, 0.055, 0.62, 0.055, sx * 0.72, 0.73, sz * 0.37);
  // panel seams and a latch: at arm's length the chest is sheet steel, not one flat face
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(dark, 0.012, 0.40, 0.008, sx * 0.66, 0.64, sz * 0.372);
  box(steel, 0.09, 0.05, 0.014, -0.60, 0.62, 0.378);         // latch plate
  // a serving ledge on the customer side, the board the bowls actually go on
  box(light, 0.92, 0.03, 0.15, 0.10, 0.99, 0.455);
  for (const sx of [-1, 1]) box(dark, 0.03, 0.10, 0.03, 0.10 + sx * 0.38, 0.93, 0.445);

  // ---- display case: four posts, a roof, and glass on the serving side ----------------------
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(steel, 0.05, 0.44, 0.05, sx * 0.70, 1.27, sz * 0.34);
  box(dark, 1.46, 0.04, 0.74, 0, 1.49, 0);                   // case roof
  box(glass, 1.36, 0.42, 0.02, 0, 1.27, 0.355);              // serving-side glass
  // the vendor's end (-X) is left open: that is the side the cook stands at, and a pane there
  // hid the pot, the wok and the grill from every angle behind the cart
  box(glass, 0.02, 0.42, 0.62, 0.715, 1.27, 0);

  // ---- awning: a tarp on braced struts, with a hemmed valance and battens visible from below -
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    rod(steel, [sx * 0.66, 1.50, sz * 0.31], [sx * 0.77, 1.81, sz * 0.45], 0.019);   // corner strut
    rod(steel, [sx * 0.66, 1.50, sz * 0.31], [sx * 0.62, 1.84, sz * 0.34], 0.012);   // inner stay
  }
  rod(steel, [-0.62, 1.49, 0], [-0.62, 1.84, 0], 0.016);     // spine, so the tarp is not on air
  // Two pitched panels over a ridge pole, not one slab: a tarp is stretched, so its silhouette
  // breaks at the ridge and the two halves catch different values of the same sunlight.
  box(wood, 1.76, 0.035, 0.06, 0, 1.958, 0);                 // ridge pole
  for (const sx of [-1, 1]) {
    const panel = box(tarp, 0.91, 0.014, 1.06, sx * 0.445, 1.87, 0);
    panel.rotation.z = -sx * 0.19;                           // 11 deg of fall from the ridge
  }
  // the valance hangs from the eaves and hides the tarp's cut edge from the customer side
  box(tarpDark, 1.78, 0.20, 0.022, 0, 1.70, 0.53);
  for (const sx of [-1, 1]) box(tarpDark, 0.022, 0.20, 1.06, sx * 0.89, 1.70, 0);
  box(paint, 1.78, 0.018, 0.026, 0, 1.592, 0.53);            // hem strip along the valance
  for (const sx of [-1, 1]) box(paint, 0.026, 0.018, 1.06, sx * 0.89, 1.592, 0);

  // ---- wheels: 0.66 m bicycle wheels, axle ACROSS the cart --------------------------------
  // TorusGeometry lies in the XY plane with its hole down +Z, so an unrotated torus is already a
  // wheel rolling along X — the cart's length — with its disc facing sideways. The old build turned
  // a cylinder 90 deg about Z, which put the axle along the cart's LENGTH and stood each wheel up
  // like a coin beside the body.
  for (const wz of [-1, 1]) {
    const zz = wz * WHEEL_Z;
    const tyre = new THREE.Mesh(new THREE.TorusGeometry(WHEEL_R - 0.034, 0.034, 8, 26), rubber);
    // 5 mm of the tyre is under the ground: a tangent circle meets the pavement on a single
    // anti-aliased pixel, and that one pixel is what makes a correctly seated wheel look airborne
    tyre.position.set(AXLE_X, WHEEL_R - 0.005, zz);
    c.add(tyre);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(WHEEL_R - 0.088, 0.019, 6, 24), light);
    rim.position.set(AXLE_X, WHEEL_R, zz);
    c.add(rim);
    const hub = cylinder(dark, 0.05, 0.05, 0.07, 12, AXLE_X, WHEEL_R, zz);
    hub.rotation.x = Math.PI / 2;
    for (const fz of [-1, 1]) {
      // hub flanges: a bare cylinder reads as a dot at two metres
      const flange = cylinder(light, 0.072, 0.072, 0.012, 12, AXLE_X, WHEEL_R, zz + fz * 0.041);
      flange.rotation.x = Math.PI / 2;
    }
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const co = Math.cos(a);
      const si = Math.sin(a);
      // spokes run in the wheel's own plane, so they read at close range and hold the rim
      rod(light, [AXLE_X + co * 0.065, WHEEL_R + si * 0.065, zz], [AXLE_X + co * (WHEEL_R - 0.095), WHEEL_R + si * (WHEEL_R - 0.095), zz], 0.0085);
    }
  }
  rod(dark, [AXLE_X, WHEEL_R, -WHEEL_Z - 0.05], [AXLE_X, WHEEL_R, WHEEL_Z + 0.05], 0.024);   // through axle
  for (const wz of [-1, 1]) rod(dark, [AXLE_X, WHEEL_R, wz * 0.42], [AXLE_X - 0.18, 0.46, wz * 0.30], 0.02);

  // ---- legs under the vendor's end: the cart stands on two wheels and two braced feet ------
  for (const lz of [-1, 1]) {
    box(steel, 0.05, 0.44, 0.05, -0.60, 0.22, lz * 0.29);
    box(dark, 0.11, 0.03, 0.11, -0.60, 0.015, lz * 0.29);    // rubber foot, flat on the ground
  }
  box(dark, 0.045, 0.045, 0.58, -0.60, 0.15, 0);             // cross brace between the legs

  // ---- push handle: tubular, hip height, braced back to the chest, with a real grip ---------
  for (const hz of [-1, 1]) {
    rod(steel, [-0.74, 0.92, hz * 0.30], [-1.06, 0.965, hz * 0.34], 0.03);    // rail
    rod(steel, [-0.75, 0.56, hz * 0.30], [-1.01, 0.95, hz * 0.34], 0.018);    // brace
    rod(steel, [-0.99, 0.74, hz * 0.34], [-1.055, 0.955, hz * 0.34], 0.015);  // strut under the grip
  }
  const grip = cylinder(dark, 0.036, 0.036, 0.72, 12, -1.06, 0.965, 0);
  grip.rotation.x = Math.PI / 2;
  for (const hz of [-1, 1]) {
    const ferrule = cylinder(light, 0.038, 0.038, 0.02, 12, -1.06, 0.965, hz * 0.36);
    ferrule.rotation.x = Math.PI / 2;
  }

  // ---- what is cooking, per kind ----------------------------------------------------------
  if (kind === 'bakso') {
    cylinder(steel, 0.27, 0.25, 0.36, 16, 0.24, 1.24, 0);                       // stockpot
    const potRim = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.012, 6, 20), light);
    potRim.rotation.x = Math.PI / 2;
    potRim.position.set(0.24, 1.42, 0);
    c.add(potRim);
    box(light, 0.46, 0.025, 0.46, 0.24, 1.445, 0);                              // pot lid
    box(dark, 0.05, 0.05, 0.05, 0.24, 1.475, 0);                                // knob
    for (let i = 0; i < 3; i++) cylinder(crock, 0.085, 0.065, 0.075, 10, -0.34 + i * 0.02, 1.065 + i * 0.07, 0.16);
  } else if (kind === 'nasgor') {
    cylinder(dark, 0.19, 0.22, 0.16, 12, 0.22, 1.13, 0);                        // burner ring
    const wok = new THREE.Mesh(new THREE.SphereGeometry(0.30, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), light);
    wok.rotation.x = Math.PI;
    wok.scale.y = 0.55;
    wok.position.set(0.22, 1.21, 0);
    c.add(wok);
    rod(wood, [0.0, 1.22, 0], [-0.36, 1.30, 0], 0.022);                         // wok handle
    // the gas bottle stands on the ground behind the cart, hose running up to the burner
    cylinder(paint, 0.13, 0.13, 0.58, 12, -0.18, 0.29, -0.52);
    cylinder(dark, 0.035, 0.035, 0.06, 8, -0.18, 0.61, -0.52);
    rod(dark, [-0.18, 0.60, -0.52], [0.06, 1.06, -0.30], 0.014);
    for (let i = 0; i < 2; i++) cylinder(glass, 0.055, 0.05, 0.14, 8, -0.52 + i * 0.13, 1.1, 0.12);
  } else {
    box(light, 0.74, 0.26, 0.44, 0.18, 1.18, 0);                                // firebox
    box(dark, 0.78, 0.04, 0.48, 0.18, 1.31, 0);                                 // firebox rim
    box(coal, 0.64, 0.04, 0.38, 0.18, 1.325, 0);                                // coals
    for (let i = 0; i < 7; i++) {
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.5, 5), stickMat);
      stick.rotation.x = Math.PI / 2;
      stick.position.set(i * 0.055, 1.35, 0);
      c.add(stick);
    }
    for (let i = 0; i < 2; i++) cylinder(glass, 0.055, 0.05, 0.14, 8, -0.52 + i * 0.13, 1.1, 0.12);
  }

  // ---- the name, painted on both chest panels where a gerobak actually carries it -----------
  // Both long sides: a cart is lettered on the road side and on the pavement side, and it means the
  // cart is identifiable whichever way the randomiser yawed it into the kerb.
  for (const sz of [-1, 1]) {
    const sign = signPlate(NAMES[kind], 1.14, 0.24, accentCss);
    sign.position.set(0, 0.80, sz * 0.381);
    if (sz < 0) sign.rotation.y = Math.PI;
    c.add(sign);
  }

  g.add(mergeStaticChildren(c));
  // a glass pane should not throw a solid shadow
  for (const m of c.children) if ((m as THREE.Mesh).material === glass) m.castShadow = false;
  // contact patch: under a flat sun with no AO a cart reads as hovering even when its tyres are
  // exactly on the kerb, and the brief was that the wheels must visibly touch the ground
  const blob = shadowBlob(2.15, 1.28, 0.5);
  blob.position.set(0.05, 0.021, 0);
  g.add(blob);
  // and a darker patch right under each tyre, where the eye actually looks for contact
  for (const wz of [-1, 1]) {
    const patch = shadowBlob(0.62, 0.62, 0.55);
    patch.position.set(AXLE_X, 0.008, wz * WHEEL_Z);
    g.add(patch);
  }

  ctx.group.add(g);
  ctx.audit.push({ name: `kaki5-${kind}`, x, z, bottom: 0 });
  const halfX = Math.abs(Math.cos(yaw)) * 0.8 + Math.abs(Math.sin(yaw)) * 0.5;
  const halfZ = Math.abs(Math.sin(yaw)) * 0.8 + Math.abs(Math.cos(yaw)) * 0.5;
  ctx.colliders.push({ minX: x - halfX, maxX: x + halfX, minZ: z - halfZ, maxZ: z + halfZ, h: 2.0 });
  return g;
}

/**
 * SPPG — the nutrition kitchen behind the free-meal programme. A walled shed with a serving
 * window, stainless prep benches and the programme board over the door.
 */
export function buildSppg(ctx: CartCtx, x: number, z: number, yaw: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;

  const wall = new THREE.MeshStandardMaterial({ color: 0xeae6dc, roughness: 0.95 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x2f6fb5, roughness: 0.8 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ab, roughness: 0.9 });

  const box = (mat: THREE.Material, w: number, h: number, d: number, px: number, py: number, pz: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(px, py, pz);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };

  box(wall, 7.2, 3.4, 4.6, 0, 1.7, 0);
  box(roofMat, 7.8, 0.16, 5.2, 0, 3.5, 0);
  box(trim, 7.3, 0.22, 4.7, 0, 3.32, 0);            // fascia band
  // serving window with a counter
  box(new THREE.MeshStandardMaterial({ color: 0x1c2228, roughness: 0.4, metalness: 0.2 }), 2.6, 1.0, 0.08, 0, 1.9, 2.32);
  box(new THREE.MeshStandardMaterial({ color: 0xb9c2ca, metalness: 0.6, roughness: 0.4 }), 2.8, 0.08, 0.5, 0, 1.36, 2.42);
  // door
  box(new THREE.MeshStandardMaterial({ color: 0x30506b, roughness: 0.7 }), 1.0, 2.1, 0.08, 2.4, 1.05, 2.32);

  const sign = signPlate('SPPG DAPUR GIZI', 4.6, 0.6, '#1f5aa8');
  sign.position.set(0, 2.86, 2.36);
  g.add(sign);

  ctx.group.add(g);
  ctx.audit.push({ name: 'sppg', x, z, bottom: 0 });
  const halfX = Math.abs(Math.cos(yaw)) * 3.7 + Math.abs(Math.sin(yaw)) * 2.5;
  const halfZ = Math.abs(Math.sin(yaw)) * 3.7 + Math.abs(Math.cos(yaw)) * 2.5;
  ctx.colliders.push({ minX: x - halfX, maxX: x + halfX, minZ: z - halfZ, maxZ: z + halfZ, h: 3.6 });
  return g;
}

/**
 * Koperasi desa: the village cooperative shop. The name is a plesetan, like every other sign in
 * this city — MERAH PUTEH, not MERAH PUTIH.
 */
export function buildKoperasi(ctx: CartCtx, x: number, z: number, yaw: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;

  const wall = new THREE.MeshStandardMaterial({ color: 0xdfd8c6, roughness: 0.95 });
  const shutter = new THREE.MeshStandardMaterial({ color: 0x7d848c, metalness: 0.5, roughness: 0.5 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x8c4a3a, roughness: 0.9 });

  const box = (mat: THREE.Material, w: number, h: number, d: number, px: number, py: number, pz: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(px, py, pz);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };

  box(wall, 6.4, 3.1, 4.2, 0, 1.55, 0);
  box(roofMat, 7.0, 0.5, 4.8, 0, 3.35, 0);
  box(shutter, 3.0, 1.9, 0.1, -0.6, 1.0, 2.12);       // roller shutter, half open look
  box(new THREE.MeshStandardMaterial({ color: 0x2b3138, roughness: 0.6 }), 1.1, 2.0, 0.1, 1.9, 1.0, 2.12);
  // kerosene drums and sacks out front, the way a koperasi actually looks
  for (let i = 0; i < 3; i++) {
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.86, 12), new THREE.MeshStandardMaterial({ color: i % 2 ? 0x2f6fb5 : 0xb5432f, roughness: 0.7 }));
    drum.position.set(-2.0 + i * 0.62, 0.43, 2.5);
    drum.castShadow = true;
    g.add(drum);
  }

  const sign = signPlate('KOPERDES MERAH PUTEH', 5.0, 0.62, '#a5281c');
  sign.position.set(0, 2.62, 2.14);
  g.add(sign);

  ctx.group.add(g);
  ctx.audit.push({ name: 'koperasi', x, z, bottom: 0 });
  const halfX = Math.abs(Math.cos(yaw)) * 3.2 + Math.abs(Math.sin(yaw)) * 2.2;
  const halfZ = Math.abs(Math.sin(yaw)) * 3.2 + Math.abs(Math.cos(yaw)) * 2.2;
  ctx.colliders.push({ minX: x - halfX, maxX: x + halfX, minZ: z - halfZ, maxZ: z + halfZ, h: 3.4 });
  return g;
}
