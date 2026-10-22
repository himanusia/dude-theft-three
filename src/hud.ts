import { clamp, formatMoney } from './utils';

export const WORLD_HALF_MAP = 3 * 52 + 19;
const MAP_BLOCK = 38; // city block plate size in metres (matches BLOCK in city.ts)

const HUD_BASE_MIN = 880;
const HUD_SCALE_MIN = 0.8;
const HUD_SCALE_MAX = 1.4;
/** below this width the corner stacks move: minimap under the cash chip */
const HUD_NARROW_WIDTH = 620;
/** below this height (landscape phones) the long hint chip is dropped */
const HUD_SHORT_HEIGHT = 520;

export type HudLayoutMode = 'regular' | 'narrow' | 'short';

export interface HudLayoutInfo {
  mode: HudLayoutMode;
  /** single scale factor for every panel, clamped 0.8 – 1.4 */
  scale: number;
  width: number;
  height: number;
  /** rendered minimap edge in CSS pixels */
  minimap: number;
}

export class HUD {
  declare el: any;
  declare mapCtx: any;
  declare mapSize: any;
  /** last result of layout(); also read by tests through window.__game.hud */
  declare layoutInfo: HudLayoutInfo;
  private layoutQueued = false;
  declare fullMapCtx: any;
  declare lastCash: number;
  declare hitTimer: number;
  declare damageTimer: number;
  declare mapOpen: boolean;
  declare settingsOpen: boolean;
  /** last projection used by drawFullMap, so a harness can sample the player marker */
  declare mapProjection: any;
  declare onSettings: ((s: any) => void) | null;
  constructor() {
    this.layoutInfo = { mode: 'regular', scale: 1, width: 0, height: 0, minimap: 196 };
    requestAnimationFrame(() => this.layout());
    this.el = {
      cash: document.getElementById('cash'),
      stars: document.getElementById('stars'),
      health: document.getElementById('health-fill'),
      healthNum: document.getElementById('health-num'),
      ammo: document.getElementById('ammo'),
      weaponLabel: document.querySelector('#ammo-wrap small'),
      prompt: document.getElementById('prompt'),
      toasts: document.getElementById('toasts'),
      objective: document.getElementById('objective'),
      speedo: document.getElementById('speedo'),
      speedVal: document.getElementById('speed-val'),
      minimap: document.getElementById('minimap'),
      crosshair: document.getElementById('crosshair'),
      hitmarker: document.getElementById('hitmarker'),
      damage: document.getElementById('damage-flash'),
      fps: document.getElementById('fps'),
      start: document.getElementById('start-screen'),
      startBtn: document.getElementById('start-btn'),
      pause: document.getElementById('pause-screen'),
      loading: document.getElementById('loading-text'),
      wantedLabel: document.getElementById('wanted-label'),
      hints: document.getElementById('hints'),
      helpBtn: document.getElementById('help-btn'),
      help: document.getElementById('help-sheet'),
      helpClose: document.getElementById('help-close'),
      bigmap: document.getElementById('bigmap') as HTMLCanvasElement,
      saveStatus: document.getElementById('save-status'),
      newGame: document.getElementById('new-game-btn'),
      pauseNewGame: document.getElementById('pause-new-game'),
      settingsBtn: document.getElementById('settings-btn'),
      pauseSettings: document.getElementById('pause-settings'),
      settings: document.getElementById('settings-sheet'),
      settingsClose: document.getElementById('settings-close'),
      setSens: document.getElementById('set-sens'),
      setInvert: document.getElementById('set-invert'),
      setMaster: document.getElementById('set-master'),
      setSfx: document.getElementById('set-sfx'),
      setBgm: document.getElementById('set-bgm'),
      setScale: document.getElementById('set-scale'),
      setFpsShow: document.getElementById('set-fps-show'),
      outSens: document.getElementById('out-sens'),
      outMaster: document.getElementById('out-master'),
      outSfx: document.getElementById('out-sfx'),
      outBgm: document.getElementById('out-bgm'),
      outScale: document.getElementById('out-scale'),
    };
    this.mapCtx = this.el.minimap.getContext('2d');
    this.mapSize = this.el.minimap.width;
    this.fullMapCtx = this.el.bigmap.getContext('2d');
    this.lastCash = -1;
    this.hitTimer = 0;
    this.damageTimer = 0;
    this.mapOpen = false;
    this.settingsOpen = false;
    this.mapProjection = null;
    this.onSettings = null;
    this.el.helpBtn?.addEventListener('click', () => this.toggleHelp());
    this.el.helpClose?.addEventListener('click', () => this.toggleHelp(false));
    this.el.help?.addEventListener('click', (e: Event) => {
      if (e.target === this.el.help) this.toggleHelp(false);
    });
  }

  /** Phones and tablets: keyboard hints give way to the "?" sheet, CSS re-lays the HUD. */
  setTouchMode(on: boolean) {
    document.body.classList.toggle('touch-mode', on);
    if (!on) this.toggleHelp(false);
  }

  toggleHelp(force?: boolean) {
    const open = force === undefined ? !this.el.help.classList.contains('show') : !!force;
    this.el.help.classList.toggle('show', open);
    this.el.helpBtn.setAttribute('aria-expanded', String(open));
  }

  setCash(n: number) {
    const v = Math.floor(n);
    if (v === this.lastCash) return;
    this.lastCash = v;
    this.el.cash.textContent = formatMoney(v);
  }

  setHealth(hp: any) {
    const pct = clamp(hp, 0, 100);
    this.el.health.style.width = pct + '%';
    this.el.health.style.background =
      pct > 55 ? 'linear-gradient(90deg,#4ade80,#22c55e)' : pct > 25 ? 'linear-gradient(90deg,#fbbf24,#f59e0b)' : 'linear-gradient(90deg,#f87171,#dc2626)';
    this.el.healthNum.textContent = Math.round(pct);
  }

  layout(): HudLayoutInfo {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const min = Math.min(width, height);
    const scale = clamp(min / HUD_BASE_MIN, HUD_SCALE_MIN, HUD_SCALE_MAX);
    const mode: HudLayoutMode = width < HUD_NARROW_WIDTH ? 'narrow' : height < HUD_SHORT_HEIGHT ? 'short' : 'regular';
    const minimap = Math.round(
      mode === 'narrow' ? clamp(min * 0.34, 96, 150) : mode === 'short' ? clamp(min * 0.26, 90, 140) : clamp(196 * scale, 150, 250),
    );

    // every token is published on <body> because the derived tokens live there
    const root = document.body;
    root.style.setProperty('--hud-scale', scale.toFixed(3));
    root.style.setProperty('--hud-map', `${minimap}px`);
    document.body.classList.toggle('hud-narrow', mode === 'narrow');
    document.body.classList.toggle('hud-short', mode === 'short');
    document.body.dataset.hudMode = mode;

    const box = (sel: string) => {
      const node = document.querySelector(sel) as HTMLElement | null;
      if (!node) return null;
      const cs = getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden') return null;
      const r = node.getBoundingClientRect();
      return r.width > 1 && r.height > 1 ? r : null;
    };

    // a taller cash/wanted stack moves everything the narrow layout anchors under it
    const topRight = box('#topright');
    root.style.setProperty('--hud-tr-h', `${Math.ceil(topRight ? topRight.height : 0)}px`);
    // short layouts put the hint chip directly under the objective column
    const topLeft = box('#tl');
    root.style.setProperty('--hud-tl-bottom', `${Math.ceil(topLeft ? topLeft.bottom : 0)}px`);
    const hintChip = box('#hints');
    root.style.setProperty('--hud-hints-h', `${Math.ceil(hintChip ? hintChip.height : 0)}px`);

    // the toast stack starts under every top-anchored box (the reads above force
    // a reflow, so these rects already reflect the variables just published)
    const mapStackIsUp = mode === 'narrow' || document.body.classList.contains('touch-mode');
    let lane = 0;
    for (const sel of ['#tl', '#topright', '#help-btn', ...(mapStackIsUp ? ['#br'] : [])]) {
      const r = box(sel);
      if (r && r.top < height * 0.6) lane = Math.max(lane, r.bottom);
    }
    root.style.setProperty('--hud-toast-top', `${Math.ceil(lane + 10 * scale)}px`);

    this.layoutInfo = { mode, scale: +scale.toFixed(3), width, height, minimap };
    return this.layoutInfo;
  }

  scheduleLayout() {
    if (this.layoutQueued) return;
    this.layoutQueued = true;
    requestAnimationFrame(() => {
      this.layoutQueued = false;
      this.layout();
    });
  }

  setWeapon(name: string, slot: number, reserve: number) {
    if (this.el.weaponLabel) this.el.weaponLabel.textContent = `${slot} · ${name.toUpperCase()}${reserve >= 0 ? '  +' + reserve : ''}`;
  }

  setAmmo(cur: any, max: any, reloading: any) {
    if (reloading) {
      this.el.ammo.textContent = 'RELOADING';
      this.el.ammo.style.opacity = 0.6;
    } else {
      this.el.ammo.textContent = `${cur} / ${max}`;
      this.el.ammo.style.opacity = 1;
    }
  }

  setStars(n: number) {
    let s = '';
    for (let i = 0; i < 5; i++) s += `<span class="${i < n ? 'on' : 'off'}">★</span>`;
    if (this.el.stars.dataset.n !== String(n)) {
      this.el.stars.dataset.n = String(n);
      this.el.stars.innerHTML = s;
      this.el.wantedLabel.textContent = n > 0 ? 'WANTED' : '';
    }
  }

  setPrompt(text: string) {
    if (this.el.prompt.dataset.t === (text ?? '')) return;
    this.el.prompt.dataset.t = text ?? '';
    this.el.prompt.textContent = text ?? '';
    this.el.prompt.classList.toggle('show', !!text);
  }

  setObjective(text: string) {
    if (this.el.objective.textContent !== text) this.el.objective.textContent = text;
  }

  setSpeed(kmh: any, show: any) {
    this.el.speedo.classList.toggle('show', show);
    if (show) this.el.speedVal.textContent = String(Math.round(Math.abs(kmh)));
  }

  setCrosshair(show: any) {
    this.el.crosshair.classList.toggle('show', show);
  }

  hitmarker() {
    this.el.hitmarker.classList.remove('pop');
    void this.el.hitmarker.offsetWidth;
    this.el.hitmarker.classList.add('pop');
  }

  damageFlash() {
    this.el.damage.classList.remove('flash');
    void this.el.damage.offsetWidth;
    this.el.damage.classList.add('flash');
  }

  toast(text: string, kind = 'info', ms = 2200) {
    const d = document.createElement('div');
    d.className = 'toast ' + kind;
    d.textContent = text;
    this.el.toasts.appendChild(d);
    setTimeout(() => {
      d.classList.add('out');
      setTimeout(() => d.remove(), 400);
    }, ms);
    while (this.el.toasts.children.length > 3) this.el.toasts.firstChild.remove();
  }

  setFps(v: number) {
    this.el.fps.textContent = String(v);
  }

  showStart(show: any) {
    this.el.start.classList.toggle('hidden', !show);
  }

  showPause(show: any) {
    this.el.pause.classList.toggle('hidden', !show);
  }

  setLoading(text: string) {
    this.el.loading.textContent = text;
  }

  /** The FPS readout is a debug aid, so the settings checkbox hides the chip instead of the loop. */
  setFpsVisible(on: boolean) {
    this.el.fps.style.display = on ? '' : 'none';
  }

  /** One line under the start button: "no save" / "saved 2 min ago". */
  setSaveStatus(text: string) {
    const el = this.el.saveStatus;
    if (!el) return;
    if (el.textContent !== text) el.textContent = text;
  }

  /**
   * Wire the options sheet to a live settings object. The sheet edits the object
   * in place, so the caller always sees the current values, then pushes the
   * change through `onChange` (apply + persist).
   */
  bindSettings(settings: any, onChange: (s: any) => void) {
    this.onSettings = onChange;
    const el = this.el;
    const push = () => {
      if (el.setSens) settings.sensitivity = Number(el.setSens.value);
      if (el.setInvert) settings.invertY = !!el.setInvert.checked;
      if (el.setMaster) settings.master = Number(el.setMaster.value);
      if (el.setSfx) settings.sfx = Number(el.setSfx.value);
      if (el.setBgm) settings.bgm = Number(el.setBgm.value);
      if (el.setScale) settings.renderScale = Number(el.setScale.value);
      if (el.setFpsShow) settings.showFps = !!el.setFpsShow.checked;
      this.syncSettingsLabels(settings);
      this.onSettings?.(settings);
    };
    for (const input of [el.setSens, el.setMaster, el.setSfx, el.setBgm, el.setScale]) {
      input?.addEventListener('input', push);
    }
    for (const box of [el.setInvert, el.setFpsShow]) {
      box?.addEventListener('change', push);
    }
    this.syncSettings(settings);
  }

  syncSettings(settings: any) {
    const el = this.el;
    if (el.setSens) el.setSens.value = String(settings.sensitivity);
    if (el.setInvert) el.setInvert.checked = !!settings.invertY;
    if (el.setMaster) el.setMaster.value = String(settings.master);
    if (el.setSfx) el.setSfx.value = String(settings.sfx);
    if (el.setBgm) el.setBgm.value = String(settings.bgm);
    if (el.setScale) el.setScale.value = String(settings.renderScale);
    if (el.setFpsShow) el.setFpsShow.checked = !!settings.showFps;
    this.syncSettingsLabels(settings);
  }

  syncSettingsLabels(settings: any) {
    const el = this.el;
    if (el.outSens) el.outSens.textContent = Number(settings.sensitivity).toFixed(2) + '×';
    if (el.outMaster) el.outMaster.textContent = Math.round(settings.master * 100) + '%';
    if (el.outSfx) el.outSfx.textContent = Math.round(settings.sfx * 100) + '%';
    if (el.outBgm) el.outBgm.textContent = Math.round(settings.bgm * 100) + '%';
    if (el.outScale) el.outScale.textContent = Number(settings.renderScale).toFixed(2) + '×';
  }

  showSettings(open: boolean) {
    this.settingsOpen = !!open;
    this.el.settings?.classList.toggle('show', this.settingsOpen);
    document.body.classList.toggle('settings-open', this.settingsOpen);
  }

  showMap(open: boolean) {
    this.mapOpen = !!open;
    this.el.bigmap?.classList.toggle('show', this.mapOpen);
    document.body.classList.toggle('map-open', this.mapOpen);
  }

  /**
   * Full-screen city map: road bands, block plates, shop doors, cruisers and the
   * player arrow. Drawn on demand from the same state the minimap uses, at device
   * pixel ratio so the labels stay sharp on a retina screen.
   */
  drawFullMap(state: any) {
    const canvas = this.el.bigmap;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = this.fullMapCtx ?? (this.fullMapCtx = canvas.getContext('2d'));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#080a0d';
    ctx.fillRect(0, 0, w, h);

    const half = WORLD_HALF_MAP + 8;
    const size = Math.max(160, Math.min(w, h) - 96);
    const scale = size / (half * 2);
    const cx = w / 2;
    const cy = h / 2;
    const mx = (x: number) => cx + x * scale;
    const my = (z: number) => cy + z * scale;
    const blockSide = MAP_BLOCK * scale;

    // road bands first: the asphalt is what makes the street grid readable
    ctx.strokeStyle = '#161b22';
    ctx.lineWidth = 14 * scale;
    ctx.lineCap = 'butt';
    for (const line of state.roadLines || []) {
      const a = line.axis === 'x' ? [mx(line.coord), my(-half)] : [mx(-half), my(line.coord)];
      const b = line.axis === 'x' ? [mx(line.coord), my(half)] : [mx(half), my(line.coord)];
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
    // lane dashes, dim so they never compete with the markers
    ctx.strokeStyle = 'rgba(120,132,148,0.28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 8]);
    for (const line of state.roadLines || []) {
      const a = line.axis === 'x' ? [mx(line.coord), my(-half)] : [mx(-half), my(line.coord)];
      const b = line.axis === 'x' ? [mx(line.coord), my(half)] : [mx(half), my(line.coord)];
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // blocks
    for (const b of state.blocks || []) {
      ctx.fillStyle = b.type === 'park' ? '#274b31' : b.type === 'lot' ? '#1d2229' : '#333a45';
      ctx.fillRect(mx(b.x) - blockSide / 2, my(b.z) - blockSide / 2, blockSide, blockSide);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.strokeRect(mx(b.x) - blockSide / 2, my(b.z) - blockSide / 2, blockSide, blockSide);
    }

    // shop doors
    for (const d of state.shops || []) {
      ctx.fillStyle = '#ffcc33';
      ctx.fillRect(mx(d.x) - 2.5, my(d.z) - 2.5, 5, 5);
    }

    // ambient traffic, faint
    ctx.fillStyle = 'rgba(140,158,178,0.85)';
    for (const c of state.cars || []) {
      if (c === state.playerCar) continue;
      ctx.fillRect(mx(c.pos.x) - 2, my(c.pos.z) - 2, 4, 4);
    }

    // police cruisers: pulsing red/blue so they read at a glance
    const pulse = Math.sin(performance.now() * 0.006) > 0;
    for (const entry of state.police || []) {
      const car = entry.car ?? entry;
      const x = mx(car.pos.x);
      const y = my(car.pos.z);
      ctx.fillStyle = pulse ? '#ff3b30' : '#3b82f6';
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // player arrow
    const px = mx(state.playerPos.x);
    const pz = my(state.playerPos.z);
    const yaw = state.playerYaw ?? 0;
    this.mapProjection = { scale, cx, cy, size, player: [px, pz] };
    ctx.save();
    ctx.translate(px, pz);
    ctx.rotate(-yaw + Math.PI);
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(8, 9);
    ctx.lineTo(0, 5);
    ctx.lineTo(-8, 9);
    ctx.closePath();
    ctx.fillStyle = '#ffcc33';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // labels: title, legend, close hint
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '800 22px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('CITY MAP', 32, 52);
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('ESC OR M TO CLOSE', 32, 74);

    const legend: [string, string][] = [
      ['#ffcc33', 'SHOPS'],
      ['#ff3b30', 'POLICE'],
      ['#8c9eb2', 'TRAFFIC'],
    ];
    let ly = h - 34;
    ctx.textAlign = 'left';
    for (const [color, label] of legend.reverse()) {
      ctx.fillStyle = color;
      ctx.fillRect(32, ly - 9, 10, 10);
      ctx.fillStyle = 'rgba(255,255,255,0.62)';
      ctx.font = '700 11px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(label, 50, ly);
      ly -= 20;
    }
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '700 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(size)} px · ${state.blocks?.length ?? 0} blocks`, w - 32, h - 26);
  }

  drawMinimap(state: any) {
    const ctx = this.mapCtx;
    const S = this.mapSize;
    const half = WORLD_HALF_MAP * 1.12;
    const toMap = (x: number, z: number) => [((x / half) * 0.5 + 0.5) * S, ((z / half) * 0.5 + 0.5) * S];

    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(0, 0, S, S, 12) : ctx.rect(0, 0, S, S);
    ctx.clip();
    ctx.fillStyle = '#15181d';
    ctx.fillRect(0, 0, S, S);

    // blocks
    for (const b of state.blocks) {
      const [mx, mz] = toMap(b.x, b.z);
      const w = (38 / half) * 0.5 * S;
      ctx.fillStyle = b.type === 'park' ? '#2f5f36' : b.type === 'lot' ? '#23262c' : '#3a3f47';
      ctx.fillRect(mx - w / 2, mz - w / 2, w, w);
    }

    // road grid lines
    ctx.strokeStyle = '#0d0f12';
    ctx.lineWidth = 1;
    for (const line of state.roadLines) {
      const [ax, az] = line.axis === 'x' ? toMap(line.coord, -half) : toMap(-half, line.coord);
      const [bx, bz] = line.axis === 'x' ? toMap(line.coord, half) : toMap(half, line.coord);
      ctx.beginPath();
      ctx.moveTo(ax, az);
      ctx.lineTo(bx, bz);
      ctx.stroke();
    }

    // pickups
    for (const p of state.pickups || []) {
      if (!p.active) continue;
      const [px, pz] = toMap(p.pos.x, p.pos.z);
      ctx.fillStyle = '#f5c542';
      ctx.beginPath();
      ctx.arc(px, pz, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // peds
    ctx.fillStyle = '#8a8f99';
    for (const p of state.peds || []) {
      if (p.dead) continue;
      const [px, pz] = toMap(p.pos.x, p.pos.z);
      ctx.fillRect(px - 1, pz - 1, 2, 2);
    }

    // police
    for (const c of state.police || []) {
      const [px, pz] = toMap(c.car.pos.x, c.car.pos.z);
      ctx.fillStyle = Math.sin(performance.now() * 0.006) > 0 ? '#ff3b30' : '#3b82f6';
      ctx.beginPath();
      ctx.arc(px, pz, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // other cars
    ctx.fillStyle = '#9ad1ff';
    for (const c of state.cars || []) {
      if (c === state.playerCar) continue;
      const [px, pz] = toMap(c.pos.x, c.pos.z);
      ctx.fillRect(px - 2, pz - 2, 4, 4);
    }

    // player arrow
    const [px, pz] = toMap(state.playerPos.x, state.playerPos.z);
    const yaw = state.playerYaw;
    ctx.save();
    ctx.translate(px, pz);
    ctx.rotate(-yaw + Math.PI);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4.5, 5);
    ctx.lineTo(0, 2.5);
    ctx.lineTo(-4.5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // player field-of-view wedge
    ctx.save();
    ctx.translate(px, pz);
    ctx.rotate(-yaw + Math.PI);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 46, -Math.PI * 0.72, -Math.PI * 0.28);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // north marker
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = 'bold 10px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', S / 2, 14);
    ctx.restore();

    // frame
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(1, 1, S - 2, S - 2, 11) : ctx.rect(1, 1, S - 2, S - 2);
    ctx.stroke();
  }
}
