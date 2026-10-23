import * as THREE from 'three';
import { canvasTexture, mergeStaticChildren } from '../core/utils';
import { buildLayang, type LayangCtx } from './layang';

/**
 * MRT — Jakarta's north-south elevated metro, as a silhouette rather than a timetable.
 *
 * The city already has a commuter viaduct and a toll deck, so the metro has to look like a third
 * thing entirely: a narrower guideway on slimmer piers, and stations that read as modern glass
 * boxes with a blue sign band instead of concrete.
 *
 * Station names are plesetan, like every sign in this city.
 */
function signTex(line: string, sub: string): THREE.Texture {
  return canvasTexture(512, 128, (ctx, w, h) => {
    ctx.fillStyle = '#123a6b';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '800 54px system-ui, sans-serif';
    ctx.fillText('M', 26, h * 0.5);
    // the roundel, so the band reads as a transit sign at a glance
    ctx.beginPath();
    ctx.arc(96, h * 0.5, 30, 0, Math.PI * 2);
    ctx.fillStyle = '#e8b91d';
    ctx.fill();
    ctx.fillStyle = '#123a6b';
    ctx.font = '800 34px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('M', 96, h * 0.5 + 2);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.font = '700 40px system-ui, sans-serif';
    ctx.fillText(line, 140, h * 0.42);
    ctx.font = '500 26px system-ui, sans-serif';
    ctx.fillStyle = '#b9cbe4';
    ctx.fillText(sub, 140, h * 0.74);
  });
}

export function buildMrtStation(ctx: LayangCtx, x: number, z: number, yaw: number, name = 'STASIUN BUNDER'): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;

  const steel = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.45, metalness: 0.55 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x9fc4d8, transparent: true, opacity: 0.34, roughness: 0.15, metalness: 0.3, depthWrite: false });
  const slab = new THREE.MeshStandardMaterial({ color: 0xd8d5cc, roughness: 0.9 });
  const roof = new THREE.MeshStandardMaterial({ color: 0xe9eaec, roughness: 0.7 });
  const blue = new THREE.MeshStandardMaterial({ color: 0x123a6b, roughness: 0.7 });
  const sign = new THREE.MeshStandardMaterial({ map: signTex(name, 'MRT · LINTAS UTARA-SELATAN'), roughness: 0.7 });

  const box = (m: THREE.Material, w: number, h: number, d: number, px: number, py: number, pz: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(px, py, pz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
    return mesh;
  };

  const DECK = 12.0;
  // platform slab on the guideway
  box(slab, 9.4, 0.5, 34, 0, DECK + 0.25, 0);
  box(new THREE.MeshStandardMaterial({ color: 0xf2c14e, roughness: 0.9 }), 9.0, 0.04, 0.3, 0, DECK + 0.52, 13);

  // the hall: a glazed box with a steel frame, sitting over the platform
  box(slab, 10.2, 0.35, 30, 0, DECK + 5.4, 0);            // roof slab
  for (const sx of [-4.9, 4.9]) {
    for (let i = -14; i <= 14; i += 4) box(steel, 0.22, 4.6, 0.22, sx, DECK + 3.1, i);
  }
  for (const sx of [-4.9, 4.9]) {
    const pane = new THREE.Mesh(new THREE.BoxGeometry(0.08, 4.4, 30), glass);
    pane.position.set(sx, DECK + 3.1, 0);
    g.add(pane);
  }
  // canopy edge in blue, and the sign band on both long faces
  box(blue, 10.4, 0.4, 0.3, 0, DECK + 5.62, 15);
  box(blue, 10.4, 0.4, 0.3, 0, DECK + 5.62, -15);
  const s1 = box(sign, 0.16, 1.5, 9.5, 5.16, DECK + 4.6, 4);
  s1.rotation.y = 0;
  const s2 = box(sign, 0.16, 1.5, 9.5, -5.16, DECK + 4.6, 4);
  s2.rotation.y = Math.PI;

  // stairs down to the pavement, with railings and a landing
  const stairZ = 18.5;
  const steps = 16;
  for (let i = 0; i < steps; i++) {
    // Solid treads, not floating planks: each step is a block from the ground up to its height,
    // otherwise the flight reads as a stack of slabs hovering in the air.
    const h = DECK - (i * DECK) / steps;
    box(slab, 3.0, h, 0.62, 0, h / 2, stairZ + i * 0.62);
  }
  for (const sx of [-1.6, 1.6]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, steps * 0.62 + 1.2), steel);
    rail.position.set(sx, DECK + 0.5, stairZ + (steps * 0.62) / 2);
    rail.rotation.x = Math.atan2(DECK, steps * 0.62);
    g.add(rail);
  }
  // the base of the stair, so nothing floats over the pavement
  box(slab, 3.4, 0.3, 1.6, 0, 0.15, stairZ + steps * 0.62 + 0.6);

  mergeStaticChildren(g);
  ctx.group.add(g);
  ctx.audit.push({ name: 'mrt-station', x, z, bottom: 0 });
  ctx.colliders.push({ minX: x - 6, maxX: x + 6, minZ: z - 17, maxZ: z + 20, h: 14 });
  return g;
}

/** The guideway itself: a narrow deck on slim piers, distinct from both other structures. */
export function buildMrtLine(ctx: LayangCtx, path: [number, number][]): void {
  buildLayang(ctx, path, { deckY: 12, width: 8.5, pierEvery: 32 });
}
