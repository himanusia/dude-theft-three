/**
 * Versioned localStorage persistence: one key for the run (`dta.save.v1`) and
 * one for the options (`dta.settings.v1`), kept apart so wiping a game never
 * touches the player's controls and vice versa.
 *
 * Everything in this module is defensive on purpose. A browser profile can hold
 * a blob written by an older build, a half-written string, or something a person
 * edited by hand. A bad payload must never throw and never brick the boot: it
 * logs exactly one warning per key per page load, drops the key, and the caller
 * falls back to a fresh game.
 */

import { STARTING_WEAPONS, WEAPONS, type WeaponId } from '../systems/weapons';

export const SAVE_KEY = 'dta.save.v1';
export const SETTINGS_KEY = 'dta.settings.v1';
// 2: the world was rescaled from 380 m to 2.5 km, so a save made in the old city would drop
// the player into an empty field. Bumping the version discards the position (and only the
// position that matters: settings live under their own key).
// 3: `weapon` and `ownedWeapons` describe the real six-gun roster. A v2 writer typed `pistol`
// into both fields, so a v2 blob is migrated to the starting pouch instead of being trusted.
export const SAVE_VERSION = 3;
export const SETTINGS_VERSION = 1;

/** Objective progress, same shape as the `flags` record in main.ts. */
export interface Objectives {
  drove: boolean;
  chaos: boolean;
  stars: boolean;
  escape: boolean;
  chaosRewarded: boolean;
}

export interface SaveData {
  version: number;
  savedAt: number;
  player: { x: number; y: number; z: number; yaw: number; camYaw: number; camPitch: number };
  cash: number;
  hp: number;
  wanted: number;
  dayT: number;
  /** equipped weapon id from the `WEAPONS` table (`fist|knife|pistol|uzi|shotgun|ak`) */
  weapon: string;
  /** rounds in the magazine in hand; the magazine's size comes from `WEAPONS[weapon]` */
  ammo: number;
  /** the pouch: starting kit plus every gun picked up this run, in the order acquired */
  ownedWeapons: string[];
  objectives: Objectives;
}

export interface Settings {
  version: number;
  sensitivity: number;
  invertY: boolean;
  master: number;
  sfx: number;
  bgm: number;
  renderScale: number;
  showFps: boolean;
  /** drive the loop from a timer instead of requestAnimationFrame, past the refresh rate */
  uncapped: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  sensitivity: 1,
  invertY: false,
  master: 0.9,
  sfx: 1,
  bgm: 1,
  renderScale: 1,
  showFps: true,
  uncapped: false,
};

// one warning per key per page load: the start screen and the boot path both
// ask for the same payload, and a double warning reads like two broken saves
const warned = new Set<string>();

function warnOnce(key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[dta] ${message}`);
}

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch (e) {
    // private mode / quota / disabled storage: the game keeps running in memory
    warnOnce('write:' + key, `could not persist ${key}: ${(e as Error)?.message ?? e}`);
  }
}

function dropRaw(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* nothing else to do */
  }
}

const isNum = (v: any): v is number => typeof v === 'number' && Number.isFinite(v);
const clampNum = (v: any, lo: number, hi: number, fallback: number) =>
  isNum(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

const isWeaponId = (v: unknown): v is WeaponId =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(WEAPONS, v);

/**
 * v2 could not describe the gun: its writer typed `weapon: 'pistol'` and `ownedWeapons: ['pistol']`
 * into every blob, whatever was in hand. The run's numbers are still good, so keep them and hand
 * the pouch the starting kit. Newer versions need no migration and are validated as they are.
 */
const MIGRATIONS: Record<number, (old: any) => any> = {
  2: (old) => ({ ...old, version: 3, weapon: 'pistol', ownedWeapons: [...STARTING_WEAPONS] }),
};

function migrate(parsed: any): any {
  let out = parsed;
  for (let guard = 0; guard < 8; guard++) {
    if (!out || typeof out !== 'object' || Array.isArray(out)) return out;
    const step = MIGRATIONS[out.version as number];
    if (!step) return out;
    out = step(out);
  }
  return out;
}

/** The pouch, de-duplicated and bounded to real weapon ids; an empty list means the starting kit. */
function normalizeOwned(src: any, equipped: WeaponId): WeaponId[] {
  const out: WeaponId[] = [];
  if (Array.isArray(src)) for (const w of src) if (isWeaponId(w) && !out.includes(w)) out.push(w);
  if (!out.length) out.push(...STARTING_WEAPONS);
  // the gun in hand is always part of the pouch, or equipping it after a load would invent one
  if (!out.includes(equipped)) out.push(equipped);
  return out;
}

/** Structural check: a save is either fully usable or rejected as a whole. */
function saveProblem(v: any): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'payload is not an object';
  if (v.version !== SAVE_VERSION) return `schema version ${String(v.version)} is not ${SAVE_VERSION} and has no migration`;
  const p = v.player;
  if (!p || typeof p !== 'object') return 'missing player block';
  for (const k of ['x', 'z']) if (!isNum(p[k])) return `player.${k} is not a number`;
  if (!isNum(v.cash) || !isNum(v.hp) || !isNum(v.dayT)) return 'missing cash/hp/dayT';
  if (!v.objectives || typeof v.objectives !== 'object') return 'missing objective progress';
  return null;
}

/** Rebuild a save from untrusted numbers, bounded so a hand-edited blob cannot poison the sim. */
function normalizeSave(v: any): SaveData {
  const p = v.player;
  const src = v.objectives ?? {};
  const weapon: WeaponId = isWeaponId(v.weapon) ? v.weapon : 'pistol';
  const spec = WEAPONS[weapon];
  return {
    version: SAVE_VERSION,
    savedAt: isNum(v.savedAt) ? v.savedAt : Date.now(),
    player: {
      x: clampNum(p.x, -1000, 1000, 0),
      y: clampNum(p.y, -5, 200, 0),
      z: clampNum(p.z, -1000, 1000, 0),
      yaw: clampNum(p.yaw, -Math.PI * 2, Math.PI * 2, 0),
      camYaw: clampNum(p.camYaw, -Math.PI * 2, Math.PI * 2, 0),
      // same range as the camera clamp in main.ts: a saved up-look may not be reset on load
      camPitch: clampNum(p.camPitch, -0.96, 1.05, 0.1),
    },
    cash: clampNum(v.cash, 0, 1e9, 250),
    hp: clampNum(v.hp, 1, 100, 100),
    wanted: clampNum(v.wanted, 0, 5, 0),
    dayT: clampNum(v.dayT, 0, 1, 0.34) % 1,
    weapon,
    // an absent magazine falls back to the equipped weapon's own spec, never to the pistol's 12,
    // and the magazine is capped by that same spec: the blob says which gun, the table says how big
    ammo: Math.round(clampNum(v.ammo, 0, spec.magSize, spec.magSize)),
    ownedWeapons: normalizeOwned(v.ownedWeapons, weapon),
    objectives: {
      drove: !!src.drove,
      chaos: !!src.chaos,
      stars: !!src.stars,
      escape: !!src.escape,
      chaosRewarded: !!src.chaosRewarded,
    },
  };
}

/** Read the stored run, or `null` for "start fresh". Never throws. */
export function loadSave(): SaveData | null {
  const raw = readRaw(SAVE_KEY);
  if (!raw) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnOnce(SAVE_KEY, `ignoring corrupt save at ${SAVE_KEY}: not valid JSON`);
    dropRaw(SAVE_KEY);
    return null;
  }
  const migrated = migrate(parsed);
  const problem = saveProblem(migrated);
  if (problem) {
    warnOnce(SAVE_KEY, `ignoring unusable save at ${SAVE_KEY}: ${problem}`);
    dropRaw(SAVE_KEY);
    return null;
  }
  return normalizeSave(migrated);
}

export function writeSave(data: Omit<SaveData, 'version' | 'savedAt'> & { savedAt?: number }): void {
  writeRaw(SAVE_KEY, JSON.stringify({ ...data, version: SAVE_VERSION, savedAt: Date.now() }));
}

export function clearSave(): void {
  dropRaw(SAVE_KEY);
}

export function hasSave(): boolean {
  return readRaw(SAVE_KEY) !== null;
}

/** Options are merged over the defaults so a build that adds a field keeps old blobs usable. */
export function loadSettings(): Settings {
  const raw = readRaw(SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnOnce(SETTINGS_KEY, `ignoring corrupt settings at ${SETTINGS_KEY}: not valid JSON`);
    dropRaw(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== SETTINGS_VERSION) {
    warnOnce(SETTINGS_KEY, `ignoring settings at ${SETTINGS_KEY}: schema version ${String(parsed?.version)} is not ${SETTINGS_VERSION}`);
    dropRaw(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS };
  }
  return {
    version: SETTINGS_VERSION,
    sensitivity: clampNum(parsed.sensitivity, 0.2, 3, DEFAULT_SETTINGS.sensitivity),
    invertY: parsed.invertY === true,
    master: clampNum(parsed.master, 0, 1, DEFAULT_SETTINGS.master),
    sfx: clampNum(parsed.sfx, 0, 1, DEFAULT_SETTINGS.sfx),
    bgm: clampNum(parsed.bgm, 0, 1, DEFAULT_SETTINGS.bgm),
    renderScale: clampNum(parsed.renderScale, 0.5, 1.5, DEFAULT_SETTINGS.renderScale),
    showFps: parsed.showFps !== false,
    uncapped: parsed.uncapped === true,
  };
}

export function writeSettings(settings: Settings): void {
  writeRaw(SETTINGS_KEY, JSON.stringify({ ...settings, version: SETTINGS_VERSION }));
}
