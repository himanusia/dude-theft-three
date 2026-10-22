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

export const SAVE_KEY = 'dta.save.v1';
export const SETTINGS_KEY = 'dta.settings.v1';
export const SAVE_VERSION = 1;
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
  /** equipped weapon id from the `WEAPONS` table, e.g. `uzi` */
  weapon: string;
  /** magazine of the equipped weapon */
  ammo: number;
  /** reserve rounds behind that magazine */
  reserve: number;
  magSize: number;
  /** per-weapon ammo so switching guns after a reload keeps every magazine honest */
  weapons: Record<string, { mag: number; reserve: number }>;
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

/** Per-weapon ammo is a plain map; unknown ids are ignored, numbers are bounded. */
function normalizeWeaponAmmo(src: any): Record<string, { mag: number; reserve: number }> {
  const out: Record<string, { mag: number; reserve: number }> = {};
  if (!src || typeof src !== 'object' || Array.isArray(src)) return out;
  for (const [id, st] of Object.entries(src as Record<string, any>)) {
    if (!st || typeof st !== 'object') continue;
    out[id] = {
      mag: Math.round(clampNum(st.mag, 0, 999, 0)),
      reserve: Math.round(clampNum(st.reserve, 0, 9999, 0)),
    };
  }
  return out;
}
const clampNum = (v: any, lo: number, hi: number, fallback: number) =>
  isNum(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/** Structural check: a save is either fully usable or rejected as a whole. */
function saveProblem(v: any): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'payload is not an object';
  if (v.version !== SAVE_VERSION) return `schema version ${String(v.version)} is not ${SAVE_VERSION}`;
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
  return {
    version: SAVE_VERSION,
    savedAt: isNum(v.savedAt) ? v.savedAt : Date.now(),
    player: {
      x: clampNum(p.x, -1000, 1000, 0),
      y: clampNum(p.y, -5, 200, 0),
      z: clampNum(p.z, -1000, 1000, 0),
      yaw: clampNum(p.yaw, -Math.PI * 2, Math.PI * 2, 0),
      camYaw: clampNum(p.camYaw, -Math.PI * 2, Math.PI * 2, 0),
      camPitch: clampNum(p.camPitch, -0.55, 1.05, 0.1),
    },
    cash: clampNum(v.cash, 0, 1e9, 250),
    hp: clampNum(v.hp, 1, 100, 100),
    wanted: clampNum(v.wanted, 0, 5, 0),
    dayT: clampNum(v.dayT, 0, 1, 0.34) % 1,
    weapon: typeof v.weapon === 'string' ? v.weapon : 'pistol',
    ammo: Math.round(clampNum(v.ammo, 0, 999, 12)),
    reserve: Math.round(clampNum(v.reserve, 0, 9999, 24)),
    magSize: Math.round(clampNum(v.magSize, 1, 999, 12)),
    weapons: normalizeWeaponAmmo(v.weapons),
    ownedWeapons: Array.isArray(v.ownedWeapons)
      ? v.ownedWeapons.filter((w: any) => typeof w === 'string')
      : Object.keys(normalizeWeaponAmmo(v.weapons)),
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
  const problem = saveProblem(parsed);
  if (problem) {
    warnOnce(SAVE_KEY, `ignoring unusable save at ${SAVE_KEY}: ${problem}`);
    dropRaw(SAVE_KEY);
    return null;
  }
  return normalizeSave(parsed);
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
  };
}

export function writeSettings(settings: Settings): void {
  writeRaw(SETTINGS_KEY, JSON.stringify({ ...settings, version: SETTINGS_VERSION }));
}
