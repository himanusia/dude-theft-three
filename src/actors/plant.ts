import * as THREE from 'three';

/**
 * The one way an actor touches the ground.
 *
 * A shoe is a 0.215 x 0.15 x 0.31 m box hanging off the ankle, and the ankle swings with the stride,
 * so the point that touches the ground is the shoe's lowest ROTATED corner - not its centre minus
 * half its height. The old measure (`centre.y - 0.075 * scale`) is exact for a body standing still
 * and sinks the planted foot up to 9 cm on the pavement as soon as the leg swings, which is the
 * owner's "ketika di trotoar kaki gw tenggelam".
 *
 * `plantOnGround` sits the real sole on whatever `city.groundHeightAt` says is under the actor, so a
 * block plate, a kerb ramp and the asphalt are one contract for the player, the crowd and the officer.
 */

const _corner = new THREE.Vector3();

/** Lowest point of the character's shoes in world space, in metres. */
export function soleY(ch: any): number {
  if (!ch?.legL || !ch?.legR) return Infinity;
  let lowest = Infinity;
  for (const leg of [ch.legL, ch.legR]) {
    const shoe = leg.children?.[1];
    const geo = shoe?.geometry;
    if (!geo) continue;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const b = geo.boundingBox;
    if (!b) continue;
    // the group above the shoe was just moved, so refresh the chain before reading it
    shoe.updateWorldMatrix(true, false);
    for (let i = 0; i < 8; i++) {
      _corner.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
      _corner.applyMatrix4(shoe.matrixWorld);
      if (_corner.y < lowest) lowest = _corner.y;
    }
  }
  return lowest;
}

/** Sit a character so its lowest sole touches `groundY` exactly. */
export function plantOnGround(ch: any, groundY: number): void {
  if (!ch?.legL || !ch?.legR || !ch.group) return;
  ch.group.position.y = groundY;
  const lowest = soleY(ch);
  if (lowest === Infinity) return;
  ch.group.position.y = groundY + (groundY - lowest);
}
