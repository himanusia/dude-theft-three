/**
 * The Jakarta street layer: where the city's licensed ambience actually comes from.
 *
 * `docs/audio-sourcing.md` landed eight ambience recordings and one menu cue. This module is the
 * director that decides, every frame, what the street should sound like:
 *
 *  - four looping beds that crossfade with the player's position: the city crowd along the
 *    arterials, the pasar inside a market's block, the warung when the player is at a kaki lima
 *    cart, and the tropical downpour while the weather is raining;
 *  - the one-shots, each fired by the thing that would make the sound: a car that has just come
 *    close honks, a moped pulling past rings the squeaker horn and delivers its pass-by, and a
 *    pedal vehicle (becak / gerobak) rings its bell when the player walks up to it.
 *
 * Weather is modelled here too, because rain is the one bed that must not play without a reason:
 * the sky runs a clear/rain cycle, the rain field draws the downpour, and the bed follows it.
 */

import * as THREE from 'three';
import { Ojek } from '../vehicles/ojek';
import { POIS } from '../world/jakartamap';
import { clamp, rand } from '../core/utils';

// ---------------------------------------------------------------- geometry helpers

interface Nearest {
  d: number;
  x: number;
  z: number;
  /** segment index and 0..1 position along it, for the tangent */
  i: number;
  t: number;
}

/** Closest point on a polyline, in world metres. */
export function nearestOnPath(path: [number, number][], x: number, z: number): Nearest {
  let best: Nearest = { d: Infinity, x: 0, z: 0, i: 0, t: 0 };
  for (let i = 0; i < path.length - 1; i++) {
    const [x1, z1] = path[i];
    const [x2, z2] = path[i + 1];
    const vx = x2 - x1;
    const vz = z2 - z1;
    const len2 = vx * vx + vz * vz || 1;
    const t = clamp(((x - x1) * vx + (z - z1) * vz) / len2, 0, 1);
    const px = x1 + vx * t;
    const pz = z1 + vz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best.d) best = { d, x: px, z: pz, i, t };
  }
  return best;
}

/** Pan for a sound at (x, z), read against the camera's yaw: -1 left, +1 right. */
export function panFor(x: number, z: number, from: THREE.Vector3, camYaw: number): number {
  const dx = x - from.x;
  const dz = z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  // camera forward is (-sin yaw, -cos yaw); screen right is (cos yaw, -sin yaw)
  return clamp((dx / len) * Math.cos(camYaw) + (dz / len) * -Math.sin(camYaw), -1, 1) * 0.8;
}

// ---------------------------------------------------------------- weather

export type WeatherState = 'clear' | 'rain';

/**
 * A tropical sky: mostly clear, then a downpour for the better part of a minute, then drying off.
 * The first rain lands 16-24 s into a run, so a new player hears the weather system while the
 * city is still new; after that the cycle is long enough to feel like weather, not a metronome.
 */
export class Weather {
  state: WeatherState = 'clear';
  rain01 = 0;
  forced: WeatherState | null = null;
  timer = 9 + Math.random() * 6;

  update(dt: number) {
    if (this.forced) {
      this.state = this.forced;
      // a forced sky holds until it is released; only the fade keeps moving
      this.rain01 += ((this.state === 'rain' ? 1 : 0) - this.rain01) * Math.min(1, dt * 1.6);
      return;
    }
    this.timer -= dt;
    if (this.timer <= 0) {
      if (this.state === 'clear') {
        this.state = 'rain';
        this.timer = 38 + Math.random() * 20;
      } else {
        this.state = 'clear';
        this.timer = 80 + Math.random() * 70;
      }
    }
    const target = this.state === 'rain' ? 1 : 0;
    this.rain01 += (target - this.rain01) * Math.min(1, dt * 0.9);
  }

  /** Pin the sky for a capture; `null` returns to the cycle. */
  force(state: WeatherState | null) {
    this.forced = state;
    if (state === 'clear') this.timer = 70 + Math.random() * 40;
    if (state === 'rain') this.timer = 40 + Math.random() * 20;
  }
}
/**
 * The visible downpour: 900 short vertical segments in a box that follows the camera. One draw
 * call, no textures, and the audio bed is the same state, so rain cannot be heard on a clear sky.
 */
export class RainField {
  readonly group = new THREE.Group();
  private drops: { x: number; y: number; z: number; v: number }[] = [];
  private positions: Float32Array;
  private geo: THREE.BufferGeometry;
  private mat: THREE.LineBasicMaterial;
  private intensity = 0;

  constructor(scene: THREE.Scene) {
    const N = 900;
    this.positions = new Float32Array(N * 6);
    for (let i = 0; i < N; i++) {
      this.drops.push({
        x: rand(-38, 38),
        y: rand(0, 30),
        z: rand(-38, 38),
        v: rand(15, 23),
      });
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.mat = new THREE.LineBasicMaterial({ color: 0xb6cfdf, transparent: true, opacity: 0, depthWrite: false });
    const lines = new THREE.LineSegments(this.geo, this.mat);
    lines.frustumCulled = false;
    this.group.add(lines);
    this.group.visible = false;
    scene.add(this.group);
    this.write();
  }

  private write() {
    const p = this.positions;
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i];
      const o = i * 6;
      p[o] = d.x;
      p[o + 1] = d.y;
      p[o + 2] = d.z;
      p[o + 3] = d.x;
      p[o + 4] = d.y + 0.55;
      p[o + 5] = d.z;
    }
    this.geo.attributes.position.needsUpdate = true;
  }

  update(dt: number, camPos: THREE.Vector3, intensity: number) {
    this.intensity = intensity;
    const visible = intensity > 0.02;
    this.group.visible = visible;
    this.mat.opacity = 0.42 * intensity;
    if (!visible) return;
    this.group.position.set(camPos.x, 0, camPos.z);
    for (const d of this.drops) {
      d.y -= d.v * dt;
      if (d.y < 0) {
        d.y = 30;
        d.x = rand(-38, 38);
        d.z = rand(-38, 38);
      }
    }
    this.write();
  }

  state() {
    return { intensity: +this.intensity.toFixed(3), visible: this.group.visible, drops: this.drops.length };
  }
}

// ---------------------------------------------------------------- mopeds

interface MopedRig {
  ojek: Ojek;
  active: boolean;
  t: number;
  dur: number;
  x0: number;
  z0: number;
  tx: number;
  tz: number;
  wheel: number;
  passed: boolean;
  spawnIn: number;
}

/**
 * Two scooters that ride past the player on the nearest arterial. This is what makes the
 * moped-horn and moped-pass-by assets honestly sourced: without them the sound would have no
 * vehicle to come from. They are purely visual/trigger actors (not physics cars), recycled around
 * the player like the ambient traffic, and hidden whenever the player is nowhere near a road.
 */
export class MopedFlow {
  private rigs: MopedRig[] = [];
  private roads: { name: string; width: number; path: [number, number][] }[];
  private onPass: (dist: number, pan: number) => void;
  private city: any;

  constructor(
    scene: THREE.Scene,
    city: any,
    onPass: (dist: number, pan: number) => void,
    private camYaw: () => number
  ) {
    this.city = city;
    this.onPass = onPass;
    this.roads = (city.roads ?? []).filter((r: any) => !String(r.name).startsWith('Local Street'));
    for (let i = 0; i < 2; i++) {
      const ojek = new Ojek({ cargoBox: i === 0 });
      ojek.group.name = `moped-traffic-${i}`;
      ojek.group.visible = false;
      scene.add(ojek.group);
      this.rigs.push({ ojek, active: false, t: 0, dur: 1, x0: 0, z0: 0, tx: 0, tz: 1, wheel: 0, passed: false, spawnIn: 1 + i * 4 });
    }
  }

  update(dt: number, playerPos: THREE.Vector3, hidden: boolean) {
    for (const rig of this.rigs) {
      if (hidden || !this.roads.length) {
        rig.active = false;
        rig.ojek.group.visible = false;
        continue;
      }
      if (!rig.active) {
        rig.spawnIn -= dt;
        if (rig.spawnIn <= 0) this.spawn(rig, playerPos);
        continue;
      }
      rig.t += dt;
      const travelled = (rig.t / rig.dur) * 120;
      if (rig.t >= rig.dur) {
        rig.active = false;
        rig.ojek.group.visible = false;
        rig.spawnIn = 2 + rand(0, 4);
        continue;
      }
      const x = rig.x0 + rig.tx * travelled;
      const z = rig.z0 + rig.tz * travelled;
      const y = this.city.groundHeightAt(x, z);
      rig.ojek.group.position.set(x, y, z);
      rig.ojek.group.rotation.y = Math.atan2(rig.tx, rig.tz);
      rig.wheel += (12 / 0.225) * dt;
      for (const w of rig.ojek.wheels) w.pivot.rotation.x = rig.wheel;
      const d = Math.hypot(x - playerPos.x, z - playerPos.z);
      if (!rig.passed && d < 18) {
        rig.passed = true;
        this.onPass(d, panFor(x, z, playerPos, this.camYaw()));
      }
    }
  }

  private spawn(rig: MopedRig, playerPos: THREE.Vector3) {
    let best: (Nearest & { road: any }) | null = null;
    for (const road of this.roads) {
      const n = nearestOnPath(road.path, playerPos.x, playerPos.z);
      if (!best || n.d < best.d) best = { ...n, road };
    }
    if (!best || best.d > 45) {
      // the player is in a block interior or on the beach: no road to pass on
      rig.spawnIn = 2;
      return;
    }
    const path = best.road.path;
    const [x1, z1] = path[best.i];
    const [x2, z2] = path[best.i + 1];
    let tx = x2 - x1;
    let tz = z2 - z1;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    if (Math.random() < 0.5) {
      tx = -tx;
      tz = -tz;
    }
    // right-hand lane, the way a scooter actually rides
    const nx = -tz;
    const nz = tx;
    const lane = 2.6;
    rig.x0 = best.x - tx * 55 + nx * lane;
    rig.z0 = best.z - tz * 55 + nz * lane;
    rig.tx = tx;
    rig.tz = tz;
    rig.t = 0;
    rig.dur = 120 / (9 + Math.random() * 4);
    rig.passed = false;
    rig.active = true;
    rig.ojek.group.visible = true;
  }

  state() {
    return this.rigs.map((r) => ({
      active: r.active,
      passed: r.passed,
      visible: r.ojek.group.visible,
      pos: [+r.ojek.group.position.x.toFixed(2), +r.ojek.group.position.z.toFixed(2)],
    }));
  }
}

// ---------------------------------------------------------------- director

export interface AmbienceContext {
  playerPos: THREE.Vector3;
  camPos: THREE.Vector3;
  camYaw: number;
  inCar: boolean;
  inInterior: boolean;
  traffic: any[];
}

const ARTERIAL_FULL = 14;
const ARTERIAL_EDGE = 58;
const PASAR_FULL = 30;
const PASAR_EDGE = 70;
const WARUNG_FULL = 8;
const WARUNG_EDGE = 24;

export class AmbienceDirector {
  readonly weather = new Weather();
  readonly rain: RainField;
  private mopeds: MopedFlow;
  private audio: any;
  private city: any;
  private honkCooldown = 0;
  private mopedHornCooldown = 0;
  private bellSpot: any = null;
  private lastMix = { city_crowd: 0, pasar_market: 0, warung: 0, tropical_rain: 0 };
  private lastEvent: { name: string; at: number; detail: any } | null = null;

  constructor(audio: any, city: any, scene: THREE.Scene) {
    this.audio = audio;
    this.city = city;
    this.rain = new RainField(scene);
    this.mopeds = new MopedFlow(scene, city, (dist, pan) => this.mopedPass(dist, pan), () => this.camYawValue);
  }

  private camYawValue = 0;

  update(dt: number, ctx: AmbienceContext) {
    this.camYawValue = ctx.camYaw;
    this.weather.update(dt);
    this.rain.update(dt, ctx.camPos, this.weather.rain01);
    if (this.honkCooldown > 0) this.honkCooldown -= dt;
    if (this.mopedHornCooldown > 0) this.mopedHornCooldown -= dt;

    const pos = ctx.playerPos;
    const cityW = this.arterialWeight(pos.x, pos.z);
    const pasarW = this.poiWeight(pos.x, pos.z, 'pasar', PASAR_FULL, PASAR_EDGE);
    const warungW = this.cartWeight(pos.x, pos.z);
    const sum = cityW + pasarW + warungW;
    const norm = sum > 1 ? 1 / sum : 1;
    const rain = this.weather.rain01;
    // rain sits on top of the street, and takes the edge off the murmur it is falling on
    const duck = 1 - 0.3 * rain;
    const indoor = ctx.inInterior ? 0 : 1;
    const mix = {
      city_crowd: cityW * norm * duck * indoor,
      pasar_market: pasarW * norm * duck * indoor,
      warung: warungW * norm * duck * indoor,
      tropical_rain: rain * (ctx.inInterior ? 0.25 : 1),
    };
    this.lastMix = mix;
    this.audio.ambienceSet('city_crowd', mix.city_crowd, 1.8);
    this.audio.ambienceSet('pasar_market', mix.pasar_market, 1.8);
    this.audio.ambienceSet('warung', mix.warung, 1.4);
    this.audio.ambienceSet('tropical_rain', mix.tropical_rain, 3.5);

    this.carHorns(dt, ctx);
    this.pedalBell(ctx);
    this.mopeds.update(dt, pos, ctx.inInterior);
  }

  // ---- beds

  private arterialWeight(x: number, z: number): number {
    const roads = (this.city.roads ?? []).filter((r: any) => !String(r.name).startsWith('Local Street'));
    let best = Infinity;
    for (const road of roads) {
      const d = nearestOnPath(road.path, x, z).d;
      if (d < best) best = d;
    }
    if (!Number.isFinite(best)) return 0;
    return 1 - clamp((best - ARTERIAL_FULL) / (ARTERIAL_EDGE - ARTERIAL_FULL), 0, 1);
  }

  private poiWeight(x: number, z: number, kind: string, full: number, edge: number): number {
    let best = Infinity;
    for (const poi of POIS) {
      if (poi.kind !== kind) continue;
      const d = Math.hypot(poi.x - x, poi.z - z);
      if (d < best) best = d;
    }
    if (!Number.isFinite(best)) return 0;
    return 1 - clamp((best - full) / (edge - full), 0, 1);
  }

  private cartWeight(x: number, z: number): number {
    let best = Infinity;
    for (const spot of this.city.cartSpots ?? []) {
      const d = Math.hypot(spot.x - x, spot.z - z);
      if (d < best) best = d;
    }
    if (!Number.isFinite(best)) return 0;
    return 1 - clamp((best - WARUNG_FULL) / (WARUNG_EDGE - WARUNG_FULL), 0, 1);
  }

  // ---- one-shots

  /** A traffic car that has just come close honks once, then has to leave before it honks again. */
  private carHorns(dt: number, ctx: AmbienceContext) {
    const pos = ctx.playerPos;
    let best: any = null;
    let bestD = 34;
    for (const entry of ctx.traffic ?? []) {
      const car = entry.car;
      if (!car || car.wrecked) continue;
      const d = Math.hypot(car.pos.x - pos.x, car.pos.z - pos.z);
      if (d > 38) {
        entry.honkArmed = false;
        continue;
      }
      if (d < bestD) {
        bestD = d;
        best = entry;
      }
    }
    if (!best || best.honkArmed || this.honkCooldown > 0) return;
    best.honkArmed = true;
    this.honkCooldown = 5;
    const pan = panFor(best.car.pos.x, best.car.pos.z, pos, ctx.camYaw);
    this.audio.play('angkot_horn', {
      // an angkot's horn is the signature one; every other body uses the same recording, because
      // that is what the licence-cleared asset is
      vol: clamp(0.5 - bestD / 110, 0.16, 0.5),
      rate: 0.96 + Math.random() * 0.08,
      pan,
    });
    this.lastEvent = { name: 'angkot_horn', at: performance.now(), detail: { dist: +bestD.toFixed(1), type: best.car.type } };
  }

  /**
   * A pedal vehicle rings when the player walks up to it. The world has no bicycle actor, but it
   * does have two becak (bicycle-wheeled pedicabs) and six gerobak carts with bicycle wheels; the
   * bell belongs to them, exactly as it does on the street.
   */
  private pedalBell(ctx: AmbienceContext) {
    if (ctx.inCar || ctx.inInterior) {
      this.bellSpot = null;
      return;
    }
    const pos = ctx.playerPos;
    let best: any = null;
    let bestD = 7;
    for (const spot of this.city.dressingSpots ?? []) {
      if (spot.type !== 'becak') continue;
      const d = Math.hypot(spot.x - pos.x, spot.z - pos.z);
      if (d < bestD) {
        bestD = d;
        best = spot;
      }
    }
    for (const spot of this.city.cartSpots ?? []) {
      const d = Math.hypot(spot.x - pos.x, spot.z - pos.z);
      if (d < bestD) {
        bestD = d;
        best = spot;
      }
    }
    if (bestD > 6 || !best) {
      this.bellSpot = null;
      return;
    }
    // one ring per vehicle the player walks up to, not one per frame
    if (this.bellSpot === best) return;
    this.bellSpot = best;
    this.audio.play('pedal_bell', {
      vol: 0.36,
      rate: 0.98 + Math.random() * 0.05,
      pan: panFor(best.x, best.z, pos, ctx.camYaw),
    });
    this.lastEvent = { name: 'pedal_bell', at: performance.now(), detail: { dist: +bestD.toFixed(1) } };
  }

  private mopedPass(dist: number, pan: number) {
    const vol = clamp(0.62 - dist / 55, 0.16, 0.58);
    this.audio.play('moped_passby', { vol, pan, rate: 0.97 + Math.random() * 0.06 });
    this.lastEvent = { name: 'moped_passby', at: performance.now(), detail: { dist: +dist.toFixed(1) } };
    if (this.mopedHornCooldown > 0) return;
    this.mopedHornCooldown = 12;
    this.audio.play('moped_horn', { vol: 0.3, pan, rate: 0.98 + Math.random() * 0.06 });
    this.lastEvent = { name: 'moped_horn', at: performance.now(), detail: { dist: +dist.toFixed(1) } };
  }

  // ---- diagnostics

  setWeather(state: WeatherState | null) {
    this.weather.force(state);
  }

  state() {
    return {
      weather: {
        state: this.weather.state,
        rain01: +this.weather.rain01.toFixed(3),
        forced: this.weather.forced,
        timer: +this.weather.timer.toFixed(1),
      },
      rain: this.rain.state(),
      mix: {
        city_crowd: +this.lastMix.city_crowd.toFixed(3),
        pasar_market: +this.lastMix.pasar_market.toFixed(3),
        warung: +this.lastMix.warung.toFixed(3),
        tropical_rain: +this.lastMix.tropical_rain.toFixed(3),
      },
      mopeds: this.mopeds.state(),
      lastEvent: this.lastEvent,
    };
  }
}
