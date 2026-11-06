/**
 * The ground contract, shared by the world that builds the surfaces and the actors that walk them.
 *
 * `City.groundHeightAt` is the one measure: it answers "how high is the thing that was actually
 * built under this point", and the player, every pedestrian, the vehicles and the prop seating all
 * read it. This module only holds the vocabulary, so `jakarta.ts` can register a landmark's paving
 * without importing the city class back.
 */

/** What kind of built surface a point stands on. */
export type GroundKind = 'terrain' | 'plate' | 'kerb' | 'lawn' | 'lot' | 'walk' | 'road' | 'ramp';

/**
 * One flat slab registered as it is built: a block plate, the kerb ring under it, a lawn, a
 * landmark square. `top` is absolute world height, `hx`/`hz` are half extents, and `round`
 * turns it into a disc (the Bundaran HI lawn) with that radius.
 */
export interface GroundPlate {
  x: number;
  z: number;
  hx: number;
  hz: number;
  top: number;
  kind: GroundKind;
  round?: number;
}
