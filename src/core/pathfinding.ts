import { BLOCK, GRID, PITCH } from '../world/city';

// ---------------------------------------------------------------- road waypoint graph
//
// The city is a GRID x GRID block grid with a 14 m road between the blocks, so the
// drivable network is a lattice of road centre lines at (k + 0.5) * PITCH. Every
// crossing of that lattice is an intersection; a car enters and leaves an
// intersection through a "port" placed PORT metres before the centre on the
// right-hand lane (LANE metres off the centre line). Ports are the graph nodes, so
// a path never leaves the asphalt: straight legs run down a lane, turns happen
// inside the 14x14 m open square of the intersection.

const ROADS = GRID * 2;
/** Distance from an intersection centre to the lane port where a car enters it. */
const PORT = 6;
/** Lateral offset of the right-hand lane from the road centre line. */
export const LANE = 3;
/** Longest straight leg allowed from a lane port to the final target. */
const LINK_MAX = 70;
/** Colliders lower than this are ignored: a cruiser drives over kerbs and benches. */
const OBSTACLE_MIN_H = 2.5;
/** Clearance kept around buildings when planning a route down a lane. */
const CLEARANCE = 3;
/** Tighter clearance for the last few metres: the target may stand next to a wall. */
const CLOSE_PAD = 1.5;
const ROAD_HALF = (PITCH - BLOCK) / 2;
const WORLD_EDGE = GRID * PITCH + BLOCK / 2 - PORT;

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Axis-aligned footprint of a solid object (same shape city.colliders uses). */
export interface Box {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  h?: number;
}

export interface RoadSnap {
  x: number;
  z: number;
  /** 0 = the road runs north/south (constant x), 1 = it runs east/west (constant z). */
  axis: 0 | 1;
}

/** Liang-Barsky segment vs inflated box test. */
function segmentHitsBox(x1: number, z1: number, x2: number, z2: number, b: Box, pad: number): boolean {
  const minX = b.minX - pad;
  const maxX = b.maxX + pad;
  const minZ = b.minZ - pad;
  const maxZ = b.maxZ + pad;
  if (Math.max(x1, x2) < minX || Math.min(x1, x2) > maxX) return false;
  if (Math.max(z1, z2) < minZ || Math.min(z1, z2) > maxZ) return false;

  const dx = x2 - x1;
  const dz = z2 - z1;
  let t0 = 0;
  let t1 = 1;

  if (Math.abs(dx) < 1e-9) {
    if (x1 < minX || x1 > maxX) return false;
  } else {
    let ta = (minX - x1) / dx;
    let tb = (maxX - x1) / dx;
    if (ta > tb) {
      const t = ta;
      ta = tb;
      tb = t;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }

  if (Math.abs(dz) < 1e-9) {
    if (z1 < minZ || z1 > maxZ) return false;
  } else {
    let ta = (minZ - z1) / dz;
    let tb = (maxZ - z1) / dz;
    if (ta > tb) {
      const t = ta;
      ta = tb;
      tb = t;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }

  return true;
}

/**
 * Waypoint navigation over the city road grid.
 *
 * Deterministic: the node layout only depends on the city constants, and A* breaks
 * ties by node id, so the same start/target always yields the same path. All the
 * per-query scratch space (cost arrays, heap, raw polyline) is preallocated.
 */
export class RoadNav {
  /** Solid obstacles used for line-of-sight tests (buildings and the like). */
  colliders: Box[];
  readonly nodeCount: number;
  readonly lines: Float64Array;
  private readonly px: Float64Array;
  private readonly pz: Float64Array;
  private readonly gScore: Float64Array;
  private readonly parent: Int32Array;
  private readonly closed: Uint8Array;
  private readonly heap: Int32Array;
  private readonly heapCost: Float64Array;
  private readonly stack: Int32Array;
  private heapSize = 0;
  private readonly raw: number[] = [];
  private readonly tmpPts: number[] = [];
  private readonly obstacles: Box[] = [];
  private obstacleSource = -1;

  constructor(colliders: Box[] = []) {
    this.colliders = colliders;
    this.lines = new Float64Array(ROADS);
    for (let k = 0; k < ROADS; k++) this.lines[k] = (k - GRID + 0.5) * PITCH;

    this.nodeCount = ROADS * ROADS * 4;
    const slots = this.nodeCount + 1; // + the virtual target node
    this.px = new Float64Array(slots);
    this.pz = new Float64Array(slots);
    this.gScore = new Float64Array(slots);
    this.parent = new Int32Array(slots);
    this.closed = new Uint8Array(slots);
    this.heap = new Int32Array(slots * 8);
    this.heapCost = new Float64Array(slots * 8);
    this.stack = new Int32Array(this.nodeCount + 2);

    for (let j = 0; j < ROADS; j++) {
      for (let i = 0; i < ROADS; i++) {
        const cx = this.lines[i];
        const cz = this.lines[j];
        for (let d = 0; d < 4; d++) {
          const [dx, dz] = DIRS[d];
          // right-hand side of the travel direction
          const n = ((j * ROADS + i) << 2) + d;
          this.px[n] = cx + dx * PORT - dz * LANE;
          this.pz[n] = cz + dz * PORT + dx * LANE;
        }
      }
    }
  }

  // ---------------------------------------------------------------- obstacles

  /** Late city colliders (interiors are appended in the constructor) stay visible. */
  private syncObstacles(): void {
    if (this.colliders.length === this.obstacleSource) return;
    this.obstacles.length = 0;
    for (const b of this.colliders) {
      if ((b.h ?? 0) >= OBSTACLE_MIN_H) this.obstacles.push(b);
    }
    this.obstacleSource = this.colliders.length;
  }

  /** True when the straight segment keeps `pad` metres off every building footprint. */
  clear(x1: number, z1: number, x2: number, z2: number, pad: number = CLEARANCE): boolean {
    this.syncObstacles();
    const boxes = this.obstacles;
    for (let i = 0; i < boxes.length; i++) {
      if (segmentHitsBox(x1, z1, x2, z2, boxes[i], pad)) return false;
    }
    return true;
  }

  /** True when the point sits inside a solid footprint (inflated by CLEARANCE). */
  blockedAt(x: number, z: number): boolean {
    this.syncObstacles();
    const boxes = this.obstacles;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (
        x > b.minX - CLEARANCE &&
        x < b.maxX + CLEARANCE &&
        z > b.minZ - CLEARANCE &&
        z < b.maxZ + CLEARANCE
      ) {
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- road snapping

  /** Nearest point on the road centre-line network, used to place spawns on asphalt. */
  snapToRoad(x: number, z: number): RoadSnap {
    let bestDist = Infinity;
    let bx = 0;
    let bz = 0;
    let axis: 0 | 1 = 0;
    const cz = Math.max(-WORLD_EDGE, Math.min(WORLD_EDGE, z));
    const cx = Math.max(-WORLD_EDGE, Math.min(WORLD_EDGE, x));

    for (let k = 0; k < ROADS; k++) {
      const line = this.lines[k];
      // road running north/south at x = line
      let d = Math.abs(x - line);
      if (d < bestDist) {
        bestDist = d;
        bx = line;
        bz = cz;
        axis = 0;
      }
      // road running east/west at z = line
      d = Math.abs(z - line);
      if (d < bestDist) {
        bestDist = d;
        bx = cx;
        bz = line;
        axis = 1;
      }
    }
    return { x: bx, z: bz, axis };
  }

  /** Distance from the point to the nearest road centre line. */
  roadOffset(x: number, z: number): number {
    let best = Infinity;
    for (let k = 0; k < ROADS; k++) {
      const dx = Math.abs(x - this.lines[k]);
      if (dx < best) best = dx;
      const dz = Math.abs(z - this.lines[k]);
      if (dz < best) best = dz;
    }
    return best;
  }

  /** True when the point is on the asphalt (roads are 14 m wide). */
  onRoad(x: number, z: number): boolean {
    return this.roadOffset(x, z) <= ROAD_HALF - 0.5;
  }

  /** True when the whole segment stays on the asphalt corridor. */
  private onRoadCorridor(x1: number, z1: number, x2: number, z2: number): boolean {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const steps = Math.max(1, Math.ceil(len / 3));
    const limit = ROAD_HALF - 2;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      if (this.roadOffset(x1 + (x2 - x1) * t, z1 + (z2 - z1) * t) > limit) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- A*

  private push(node: number, cost: number): void {
    if (this.heapSize >= this.heap.length) return;
    let i = this.heapSize++;
    const heap = this.heap;
    const costs = this.heapCost;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (costs[up] <= cost) break;
      heap[i] = heap[up];
      costs[i] = costs[up];
      i = up;
    }
    heap[i] = node;
    costs[i] = cost;
  }

  private pop(): number {
    const heap = this.heap;
    const costs = this.heapCost;
    const top = heap[0];
    const last = --this.heapSize;
    if (last > 0) {
      const c = costs[last];
      const node = heap[last];
      let i = 0;
      for (;;) {
        let down = (i << 1) + 1;
        if (down >= last) break;
        if (down + 1 < last && costs[down + 1] < costs[down]) down++;
        if (costs[down] >= c) break;
        heap[i] = heap[down];
        costs[i] = costs[down];
        i = down;
      }
      heap[i] = node;
      costs[i] = c;
    }
    return top;
  }

  private relax(from: number, to: number, gx: number, gz: number): void {
    const cost = Math.hypot(this.px[from] - this.px[to], this.pz[from] - this.pz[to]);
    const ng = this.gScore[from] + cost;
    if (ng >= this.gScore[to]) return;
    this.gScore[to] = ng;
    this.parent[to] = from;
    // euclidean distance is admissible and consistent on this lattice
    this.push(to, ng + Math.hypot(this.px[to] - gx, this.pz[to] - gz));
  }

  /**
   * A* start -> target, then lane-offset polyline + smoothing.
   *
   * Writes flat (x, z) pairs into `out` (cleared first, no per-call allocation of the
   * scratch structures) and returns the number of points. Returns 0 when no graph
   * node could be reached from the start.
   */
  findPath(sx: number, sz: number, gx: number, gz: number, out: number[]): number {
    out.length = 0;
    const N = this.nodeCount;
    const goal = N;
    const g = this.gScore;
    const parent = this.parent;
    const closed = this.closed;
    g.fill(Infinity);
    parent.fill(-1);
    closed.fill(0);
    this.heapSize = 0;
    this.stack.fill(-1);

    // seed: every port the start can reach in a straight line
    let seeded = 0;
    for (let n = 0; n < N; n++) {
      const d = Math.hypot(this.px[n] - sx, this.pz[n] - sz);
      if (d > LINK_MAX) continue;
      if (d > 2 && !this.clear(sx, sz, this.px[n], this.pz[n], CLOSE_PAD)) continue;
      g[n] = d;
      this.push(n, d + Math.hypot(this.px[n] - gx, this.pz[n] - gz));
      seeded++;
    }
    if (seeded === 0) {
      // wedged in somewhere with no sight of a lane: drive at the closest port anyway
      let best = 0;
      let bestD = Infinity;
      for (let n = 0; n < N; n++) {
        const d = Math.hypot(this.px[n] - sx, this.pz[n] - sz);
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      g[best] = bestD;
      this.push(best, bestD + Math.hypot(this.px[best] - gx, this.pz[best] - gz));
    }

    while (this.heapSize > 0) {
      const cur = this.pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (cur === goal) break;

      // final leg straight to the target
      const gd = Math.hypot(this.px[cur] - gx, this.pz[cur] - gz);
      if (gd <= LINK_MAX && (gd < 2 || this.clear(this.px[cur], this.pz[cur], gx, gz, CLOSE_PAD))) {
        const ng = g[cur] + gd;
        if (ng < g[goal]) {
          g[goal] = ng;
          parent[goal] = cur;
          this.push(goal, ng);
        }
      }

      const d = cur & 3;
      const base = (cur - d) >> 2;
      const i = base % ROADS;
      const j = (base - i) / ROADS;

      // turns inside the intersection (includes the U-turn)
      for (let d2 = 0; d2 < 4; d2++) {
        if (d2 === d) continue;
        const nb = (base << 2) + d2;
        if (!closed[nb]) this.relax(cur, nb, gx, gz);
      }

      // straight on to the next intersection down this road
      const i2 = i + DIRS[d][0];
      const j2 = j + DIRS[d][1];
      if (i2 >= 0 && i2 < ROADS && j2 >= 0 && j2 < ROADS) {
        const nb = ((j2 * ROADS + i2) << 2) + d;
        if (!closed[nb]) this.relax(cur, nb, gx, gz);
      }
    }

    // reconstruct
    const stack = this.stack;
    let node = goal;
    let cnt = 0;
    if (parent[goal] === -1) {
      // target unreachable through a clear final leg: finish at the closest node
      let best = -1;
      let bestCost = Infinity;
      for (let n = 0; n < N; n++) {
        if (!closed[n] || g[n] === Infinity) continue;
        const c = g[n] + Math.hypot(this.px[n] - gx, this.pz[n] - gz);
        if (c < bestCost) {
          bestCost = c;
          best = n;
        }
      }
      if (best === -1) return 0;
      node = best;
    }

    while (node !== -1 && cnt < stack.length) {
      stack[cnt++] = node;
      node = parent[node];
    }

    const raw = this.raw;
    raw.length = 0;
    // stack holds goal..start, so walk it backwards; the virtual goal has no position
    for (let k = cnt - 1; k >= 0; k--) {
      const n = stack[k];
      if (n === goal) continue;
      raw.push(this.px[n], this.pz[n]);
    }
    raw.push(gx, gz);

    return this.smooth(raw, raw.length >> 1, out);
  }

  /**
   * Collapse redundant waypoints. Two passes so the result stays glued to the
   * lane geometry: drop points that sit on the line between their neighbours, then
   * shortcut across at most two waypoints when the chord is clear of buildings.
   */
  private smooth(raw: number[], count: number, out: number[]): number {
    // pass 1: collinear cleanup
    let n = 0;
    for (let k = 0; k < count; k++) {
      const x = raw[k * 2];
      const z = raw[k * 2 + 1];
      if (n >= 2) {
        const ax = out[(n - 2) * 2];
        const az = out[(n - 2) * 2 + 1];
        const bx = out[(n - 1) * 2];
        const bz = out[(n - 1) * 2 + 1];
        const vx = bx - ax;
        const vz = bz - az;
        const len = Math.hypot(vx, vz) || 1;
        // perpendicular distance from the previous point to the line a -> new
        const dev = Math.abs((x - ax) * vz - (z - az) * vx) / len;
        const forward = (bx - ax) * (x - bx) + (bz - az) * (z - bz);
        if (dev < 0.6 && forward >= 0) {
          out[(n - 1) * 2] = x;
          out[(n - 1) * 2 + 1] = z;
          continue;
        }
      }
      out.push(x, z);
      n++;
    }

    // pass 2: clear shortcuts that keep the polyline close to the original
    if (n <= 2) return n;
    const pts = this.tmpPts;
    pts.length = 0;
    for (let k = 0; k < n * 2; k++) pts.push(out[k]);
    out.length = 0;
    let i = 0;
    out.push(pts[0], pts[1]);
    while (i < n - 1) {
      let next = i + 1;
      const limit = Math.min(i + 3, n - 1);
      for (let k = limit; k >= i + 2; k--) {
        const d = Math.hypot(pts[k * 2] - pts[i * 2], pts[k * 2 + 1] - pts[i * 2 + 1]);
        if (d > 34) continue;
        // never shortcut across a block: the chord has to stay on the asphalt
        if (!this.onRoadCorridor(pts[i * 2], pts[i * 2 + 1], pts[k * 2], pts[k * 2 + 1])) continue;
        if (!this.clear(pts[i * 2], pts[i * 2 + 1], pts[k * 2], pts[k * 2 + 1])) continue;
        next = k;
        break;
      }
      out.push(pts[next * 2], pts[next * 2 + 1]);
      i = next;
    }
    return out.length >> 1;
  }
}
