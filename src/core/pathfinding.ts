import { ARTERIALS, RING_ROAD } from '../world/jakartamap';
import { LOCAL_STREETS } from '../world/streets';

/**
 * Waypoint navigation over the road network that the Jakarta map actually defines.
 *
 * The city used to be a lattice, so this module could describe the roads as "every
 * k-th line on a grid". The layout is generated now: the roads are the arterials and
 * the inner ring from src/world/jakartamap.ts. The graph is built by sampling those
 * polylines and linking the samples where two roads meet, so police routing stays on
 * asphalt no matter where the blocks ended up.
 */

/** Distance between graph nodes along a road. */
const SAMPLE = 10;
/** Two nodes from different roads closer than this are a junction link. */
const JOIN = 18;
/** Lateral offset of the right-hand lane from the centre line. */
export const LANE = 3;
/** Longest straight leg allowed from a node to the final target. */
const LINK_MAX = 80;
/**
 * Longest leg the returned polyline may contain. The graph samples a road every 10 m, so a
 * leg longer than this means smoothing threw the road shape away (or the route jumped off the
 * network): a driver handed such a leg guesses where the asphalt went. Both smoothing passes
 * refuse merges longer than this, and a clear final leg is subdivided to match.
 */
const MAX_LEG = 40;
/** Colliders lower than this are ignored: a cruiser drives over kerbs and benches. */
const OBSTACLE_MIN_H = 2.5;
/** Clearance kept around buildings when planning a route. */
const CLEARANCE = 3;
/** Tighter clearance for the last few metres: the target may stand next to a wall. */
const CLOSE_PAD = 1.5;
/** Half width of a cruiser: a road sample this close to a footprint is not drivable. */
const CAR_PAD = 2;

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

interface Road {
  pts: [number, number][];
  width: number;
}

const ROAD_NET: Road[] = [
  ...ARTERIALS.map((a) => ({ pts: a.path, width: a.width })),
  { pts: RING_ROAD, width: 20 },
  // the streets between the blocks: without them the nearest drivable point can be 50 m from
  // the player, which is why a police route used to end nowhere near them
  ...LOCAL_STREETS.map((st) => ({ pts: st.path, width: st.width })),
];

/**
 * Deterministic A* over the map's road network.
 *
 * The node layout only depends on the map data, and ties are broken by node id, so the
 * same start/target always yields the same path. Per-query scratch is preallocated.
 */
export class RoadNav {
  /** Solid obstacles used for line-of-sight tests (buildings and the like). */
  colliders: Box[];

  readonly nodeCount: number;
  private readonly px: Float64Array;
  private readonly pz: Float64Array;
  /** CSR adjacency: neighbours of n are adjTo[adjStart[n] .. adjStart[n + 1]) */
  private readonly adjStart: Int32Array;
  private readonly adjTo: Int32Array;
  private readonly adjCost: Float64Array;

  private readonly gScore: Float64Array;
  private readonly parent: Int32Array;
  private readonly closed: Uint8Array;
  private readonly heap: Int32Array;
  private readonly heapCost: Float64Array;
  private readonly stack: Int32Array;
  private heapSize = 0;
  /** diagnostics: nodes expanded and seeded by the last findPath call */
  lastStats = { expanded: 0, seeded: 0, goalLeg: 0, shortfall: 0 };
  private readonly raw: number[] = [];
  private readonly tmpPts: number[] = [];
  private readonly obstacles: Box[] = [];
  private obstacleSource = -1;

  constructor(colliders: Box[] = []) {
    this.colliders = colliders;

    // 1. sample every road
    const nodes: { x: number; z: number; road: number; kept: boolean }[] = [];
    const roadNodes: number[][] = [];
    for (let r = 0; r < ROAD_NET.length; r++) {
      const list: number[] = [];
      const pts = ROAD_NET[r].pts;
      for (let i = 0; i < pts.length - 1; i++) {
        const [x1, z1] = pts[i];
        const [x2, z2] = pts[i + 1];
        const len = Math.hypot(x2 - x1, z2 - z1);
        const steps = Math.max(1, Math.round(len / SAMPLE));
        for (let s = 0; s < steps; s++) {
          const t = s / steps;
          list.push(nodes.length);
          nodes.push({ x: x1 + (x2 - x1) * t, z: z1 + (z2 - z1) * t, road: r, kept: true });
        }
      }
      const [lx, lz] = pts[pts.length - 1];
      list.push(nodes.length);
      nodes.push({ x: lx, z: lz, road: r, kept: true });
      roadNodes.push(list);
    }

    // 2. drop the samples that stand inside a building. The polylines are the map's intent, not
    // the city as built: blocks are laid on their own pitch and a local street runs through some
    // of them (measured: 12% of the samples are under a footprint). Routing through a wall is not
    // routing, and the cruiser that received such a leg stopped against the wall and reversed
    // forever - which is what "the chase never closes" looked like on screen.
    const solid = colliders.filter((b) => (b.h ?? 0) >= OBSTACLE_MIN_H);
    if (solid.length) {
      for (const n of nodes) {
        for (const b of solid) {
          if (n.x > b.minX - CAR_PAD && n.x < b.maxX + CAR_PAD && n.z > b.minZ - CAR_PAD && n.z < b.maxZ + CAR_PAD) {
            n.kept = false;
            break;
          }
        }
      }
    }

    const n = nodes.length;
    const pxAll = new Float64Array(n);
    const pzAll = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      pxAll[i] = nodes[i].x;
      pzAll[i] = nodes[i].z;
    }

    // 3. adjacency: consecutive samples along a road (a dropped sample cuts the road, it does not
    // get bridged), plus links where two roads meet
    const kept: number[] = [];
    for (let i = 0; i < n; i++) kept.push(nodes[i].kept ? i : -1);
    const edges: { a: number; b: number; cost: number }[] = [];
    for (const list of roadNodes) {
      for (let i = 0; i < list.length - 1; i++) {
        const a = list[i];
        const b = list[i + 1];
        if (kept[a] === -1 || kept[b] === -1) continue;
        const cost = Math.hypot(pxAll[a] - pxAll[b], pzAll[a] - pzAll[b]);
        edges.push({ a, b, cost });
      }
    }
    for (let i = 0; i < n; i++) {
      if (kept[i] === -1) continue;
      for (let j = i + 1; j < n; j++) {
        if (kept[j] === -1) continue;
        if (nodes[i].road === nodes[j].road) continue;
        const d = Math.hypot(pxAll[i] - pxAll[j], pzAll[i] - pzAll[j]);
        if (d > JOIN) continue;
        edges.push({ a: i, b: j, cost: d });
      }
    }

    // 4. keep only nodes that still have an edge: a sample whose whole neighbourhood is covered by
    // a building is not a road point, and leaving it in gives findPath a stub to "reach".
    const degree = new Int32Array(n);
    for (const e of edges) {
      degree[e.a]++;
      degree[e.b]++;
    }
    const remap = new Int32Array(n).fill(-1);
    let live = 0;
    for (let i = 0; i < n; i++) if (degree[i] > 0) remap[i] = live++;
    const liveNodes = live;
    const px = new Float64Array(liveNodes);
    const pz = new Float64Array(liveNodes);
    for (let i = 0; i < n; i++) {
      const k = remap[i];
      if (k < 0) continue;
      px[k] = nodes[i].x;
      pz[k] = nodes[i].z;
    }

    const start = new Int32Array(liveNodes + 1);
    for (const e of edges) {
      start[remap[e.a] + 1]++;
      start[remap[e.b] + 1]++;
    }
    for (let i = 0; i < liveNodes; i++) start[i + 1] += start[i];
    this.adjStart = start;
    this.adjTo = new Int32Array(edges.length * 2);
    this.adjCost = new Float64Array(edges.length * 2);
    const cursor = Int32Array.from(start.subarray(0, liveNodes));
    for (const e of edges) {
      const a = remap[e.a];
      const b = remap[e.b];
      this.adjTo[cursor[a]] = b;
      this.adjCost[cursor[a]++] = e.cost;
      this.adjTo[cursor[b]] = a;
      this.adjCost[cursor[b]++] = e.cost;
    }

    this.nodeCount = liveNodes;
    this.px = px;
    this.pz = pz;

    const slots = liveNodes + 1; // + the virtual target node
    this.gScore = new Float64Array(slots);
    this.parent = new Int32Array(slots);
    this.closed = new Uint8Array(slots);
    this.heap = new Int32Array(slots * 8);
    this.heapCost = new Float64Array(slots * 8);
    this.stack = new Int32Array(slots + 2);
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

  // ---------------------------------------------------------------- road geometry

  /** Nearest point on the road centre-line network, used to place spawns on asphalt. */
  snapToRoad(x: number, z: number): RoadSnap {
    let bestDist = Infinity;
    let bx = x;
    let bz = z;
    let axis: 0 | 1 = 0;
    for (const road of ROAD_NET) {
      const pts = road.pts;
      for (let i = 0; i < pts.length - 1; i++) {
        const [x1, z1] = pts[i];
        const [x2, z2] = pts[i + 1];
        const dx = x2 - x1;
        const dz = z2 - z1;
        const len2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / len2));
        const cx = x1 + dx * t;
        const cz = z1 + dz * t;
        const d = Math.hypot(x - cx, z - cz);
        if (d < bestDist) {
          bestDist = d;
          bx = cx;
          bz = cz;
          axis = Math.abs(dx) < Math.abs(dz) ? 0 : 1;
        }
      }
    }
    return { x: bx, z: bz, axis };
  }

  /** Distance from the point to the nearest road centre line. */
  roadOffset(x: number, z: number): number {
    let best = Infinity;
    for (const road of ROAD_NET) {
      const pts = road.pts;
      for (let i = 0; i < pts.length - 1; i++) {
        const [x1, z1] = pts[i];
        const [x2, z2] = pts[i + 1];
        const dx = x2 - x1;
        const dz = z2 - z1;
        const len2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / len2));
        const d = Math.hypot(x - (x1 + dx * t), z - (z1 + dz * t));
        if (d < best) best = d;
      }
    }
    return best;
  }

  /** Half width of the road nearest to the point. */
  private nearestHalfWidth(x: number, z: number): number {
    let best = Infinity;
    let half = 7;
    for (const road of ROAD_NET) {
      const pts = road.pts;
      for (let i = 0; i < pts.length - 1; i++) {
        const [x1, z1] = pts[i];
        const [x2, z2] = pts[i + 1];
        const dx = x2 - x1;
        const dz = z2 - z1;
        const len2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / len2));
        const d = Math.hypot(x - (x1 + dx * t), z - (z1 + dz * t));
        if (d < best) {
          best = d;
          half = road.width / 2;
        }
      }
    }
    return half;
  }

  /** True when the point is on asphalt. */
  onRoad(x: number, z: number): boolean {
    return this.roadOffset(x, z) <= this.nearestHalfWidth(x, z) - 0.5;
  }

  /** True when the whole segment stays on an asphalt corridor. */
  private onRoadCorridor(x1: number, z1: number, x2: number, z2: number): boolean {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const steps = Math.max(1, Math.ceil(len / 3));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = x1 + (x2 - x1) * t;
      const z = z1 + (z2 - z1) * t;
      if (this.roadOffset(x, z) > this.nearestHalfWidth(x, z) - 2) return false;
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

  private relax(from: number, to: number, edgeCost: number, gx: number, gz: number): void {
    const ng = this.gScore[from] + edgeCost;
    if (ng >= this.gScore[to]) return;
    this.gScore[to] = ng;
    this.parent[to] = from;
    // straight-line distance to the target: admissible on a geometric graph
    this.push(to, ng + Math.hypot(this.px[to] - gx, this.pz[to] - gz));
  }

  /**
   * A* start -> target over the road graph, then polyline + smoothing.
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

    // seed: every node the start can reach in a straight line
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
      // wedged in somewhere with no sight of a lane: drive at the closest node anyway
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

    this.lastStats = { expanded: 0, seeded, goalLeg: 0, shortfall: 0 };
    while (this.heapSize > 0) {
      const cur = this.pop();
      this.lastStats.expanded++;
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
          this.lastStats.goalLeg++;
          this.push(goal, ng);
        }
      }

      const from = this.adjStart[cur];
      const to = this.adjStart[cur + 1];
      for (let e = from; e < to; e++) {
        const nb = this.adjTo[e];
        if (closed[nb]) continue;
        this.relax(cur, nb, this.adjCost[e], gx, gz);
      }
    }

    // reconstruct
    const stack = this.stack;
    let node = goal;
    let cnt = 0;
    let reachGoal = true;
    if (parent[goal] === -1) {
      reachGoal = false;
      // Target unreachable through a clear final leg. Finish at the road point nearest to the
      // target that a route can actually reach, and report how far short that is.
      //
      // The comparison must be pure DISTANCE to the target. Ranking by cost-so-far plus that
      // distance (the previous version) is dominated by the length of the route: the closest
      // node to a target 700 m across the map carries a 750 m gScore, so the winner was a node
      // 85 m from the START - and the cruiser got a two-point stub that ended where it began.
      // Ties prefer a node with a parent chain, because a seed alone reconstructs to itself.
      let best = -1;
      let bestD = Infinity;
      for (let n = 0; n < N; n++) {
        if (!closed[n] || g[n] === Infinity) continue;
        const d = Math.hypot(this.px[n] - gx, this.pz[n] - gz);
        const better =
          best === -1 ||
          d < bestD - 0.01 ||
          (Math.abs(d - bestD) <= 0.01 && parent[n] !== -1 && parent[best] === -1);
        if (better) {
          bestD = d;
          best = n;
        }
      }
      if (best === -1) return 0;
      node = best;
      // A route that cannot legally reach the target must not pretend to: appending the goal
      // anyway made police drive into the wall behind which the player was standing, over and
      // over. The path ends at the last reachable point and the shortfall is reported so the
      // caller can decide to dismount and walk the rest.
      this.lastStats.shortfall = Math.hypot(this.px[best] - gx, this.pz[best] - gz);
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
    if (reachGoal) {
      // The final leg is the one stretch of the route that was never sampled by the graph: it is
      // a verified-clear straight line up to LINK_MAX long. Subdivide it so every leg the caller
      // receives fits MAX_LEG - the same promise the road legs make.
      const lx = raw.length >= 2 ? raw[raw.length - 2] : sx;
      const lz = raw.length >= 2 ? raw[raw.length - 1] : sz;
      const legLen = Math.hypot(gx - lx, gz - lz);
      const steps = Math.max(1, Math.ceil(legLen / MAX_LEG));
      for (let k = 1; k <= steps; k++) {
        raw.push(lx + ((gx - lx) * k) / steps, lz + ((gz - lz) * k) / steps);
      }
    }

    return this.smooth(raw, raw.length >> 1, out);
  }

  /**
   * Collapse redundant waypoints: drop points that sit on the line between their
   * neighbours, then shortcut when the chord stays on asphalt and clear of buildings.
   */
  private smooth(raw: number[], count: number, out: number[]): number {
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
        const span = Math.hypot(x - ax, z - az);
        if (dev < 0.6 && forward >= 0 && span <= MAX_LEG) {
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
        if (d > MAX_LEG) continue;
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
