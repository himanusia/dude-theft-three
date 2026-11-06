/**
 * Touch controls: a phone/tablet layer that feeds the keyboard+mouse input
 * state in main.ts instead of forking the movement or camera logic.
 *
 * Rendered as DOM (not canvas) so the controls inherit the HUD's type, colour
 * and blur treatment. Nothing here touches the game state: the module exposes
 * an analog stick axis, accumulated look deltas and one-shot action hooks.
 *
 * Two tiers, so the thumb cluster stays six buttons: the actions a player uses
 * every second sit in `#touch-actions`, and the ones they reach for between
 * fights (weapon picker, reload, map, mute) sit in a half-size rail directly
 * above it. Only the weapon picker expands.
 */

export interface TouchState {
  /** true once a coarse pointer or the first real touch has been seen */
  active: boolean;
  /** -1 (left) .. 1 (right), dead zone removed */
  moveX: number;
  /** -1 (back) .. 1 (forward), dead zone removed */
  moveY: number;
  /** stick deflection after the dead zone, 0..1 */
  magnitude: number;
  sprint: boolean;
  jump: boolean;
  fire: boolean;
  /** audio mute, mirrored back from the game so the SND chip can show it */
  muted: boolean;
}

export interface TouchHooks {
  /** pointer delta in CSS pixels, already scaled for finger travel */
  look(dx: number, dy: number): void;
  pause(): void;
  vehicle(): void;
  interact(): void;
  punch(): void;
  /** one magazine goes back in the equipped weapon */
  reload(): void;
  /** full-screen city map */
  map(): void;
  /** returns the new muted state */
  mute(): boolean;
  /** slot 1..6, the same slots Digit1..Digit6 pick on a keyboard */
  weapon(slot: number): void;
  /** slot of the weapon the player holds right now */
  currentSlot(): number;
  /** fired once, when the controls first appear */
  activate(): void;
}

/** one entry of the weapon picker; main.ts builds these from WEAPONS */
export interface TouchSlot {
  id: string;
  slot: number;
  name: string;
  /** what the 49 px cell prints, so "Micro Uzi" does not overflow it */
  short: string;
  glyph: string;
}

type ActionId = 'vehicle' | 'interact' | 'sprint' | 'punch' | 'jump' | 'fire';
type ToolId = 'weapon' | 'reload' | 'map' | 'mute';

interface ButtonSpec {
  id: ActionId;
  label: string;
  key: string;
  className?: string;
}

interface ToolSpec {
  id: ToolId;
  label: string;
  aria: string;
}

/** 12% of the stick radius is ignored so a resting thumb never walks */
const DEAD_ZONE = 0.12;
/** finger travel is slower than a mouse, so deltas get a multiplier */
const LOOK_SCALE = 1.6;
/** two-finger tap window */
const TAP_MS = 320;
const TAP_SLOP = 14;
/** left/right split of the screen for stick vs look */
const LOOK_SPLIT = 0.45;
/** the stick band starts below this share of the screen height */
const STICK_TOP = 0.3;

const BUTTONS: ButtonSpec[] = [
  { id: 'vehicle', label: 'CAR', key: 'F' },
  { id: 'interact', label: 'USE', key: 'E' },
  { id: 'sprint', label: 'RUN', key: 'SHIFT' },
  { id: 'punch', label: 'PUNCH', key: 'Q' },
  { id: 'jump', label: 'JUMP', key: 'SPACE' },
  { id: 'fire', label: 'FIRE', key: 'HOLD', className: 't-btn-fire' },
];

/**
 * Secondary tier. The labels are the exact words the "?" sheet prints, so a
 * player reads one vocabulary: WPN opens the picker, RLD reloads, MAP opens the
 * city map, SND mutes. Each is one tap; none of them hides inside a menu.
 */
const TOOLS: ToolSpec[] = [
  { id: 'weapon', label: 'WPN', aria: 'Weapon select' },
  { id: 'reload', label: 'RLD', aria: 'Reload' },
  { id: 'map', label: 'MAP', aria: 'City map' },
  { id: 'mute', label: 'SND', aria: 'Mute audio' },
];

export class TouchControls {
  readonly state: TouchState = {
    active: false,
    moveX: 0,
    moveY: 0,
    magnitude: 0,
    sprint: false,
    jump: false,
    fire: false,
    muted: false,
  };

  private readonly hooks: TouchHooks;
  private readonly root: HTMLDivElement;
  private readonly stick: HTMLDivElement;
  private readonly knob: HTMLDivElement;
  private readonly buttons = new Map<ActionId, HTMLButtonElement>();
  private readonly tools = new Map<ToolId, HTMLButtonElement>();
  private readonly slotButtons = new Map<number, HTMLButtonElement>();
  private readonly tray: HTMLDivElement;
  private trayOpen = false;

  private stickId: number | null = null;
  private lookId: number | null = null;
  private stickOriginX = 0;
  private stickOriginY = 0;
  private stickRadius = 1;
  private lookX = 0;
  private lookY = 0;
  private readonly pointers = new Set<number>();
  private gesture: { t: number; x: number; y: number; moved: boolean } | null = null;

  constructor(hooks: TouchHooks, slots: TouchSlot[]) {
    this.hooks = hooks;

    this.root = document.createElement('div');
    this.root.id = 'touch-ui';
    this.root.setAttribute('aria-hidden', 'true');

    this.stick = document.createElement('div');
    this.stick.id = 'touch-stick';
    this.stick.innerHTML = '<div id="touch-stick-knob"></div>';
    this.root.appendChild(this.stick);
    this.knob = this.stick.firstElementChild as HTMLDivElement;

    // weapon picker: three slots per row, opening above the rail
    this.tray = document.createElement('div');
    this.tray.id = 'touch-weapons';
    this.tray.setAttribute('aria-hidden', 'true');
    for (const slot of slots) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 't-slot';
      btn.dataset.slot = String(slot.slot);
      btn.dataset.weapon = slot.id;
      btn.setAttribute('aria-label', `${slot.slot} ${slot.name}`);
      btn.innerHTML =
        `<span class="t-slot-num">${slot.slot}</span>` +
        `<span class="t-slot-name">${slot.short.toUpperCase()}</span>`;
      btn.addEventListener('pointerdown', this.onSlotDown);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
      this.slotButtons.set(slot.slot, btn);
      this.tray.appendChild(btn);
    }
    this.root.appendChild(this.tray);

    const rail = document.createElement('div');
    rail.id = 'touch-rail';
    for (const spec of TOOLS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 't-mini';
      btn.dataset.tool = spec.id;
      btn.setAttribute('aria-label', spec.aria);
      btn.setAttribute('aria-pressed', 'false');
      btn.innerHTML = `<span class="t-mini-label">${spec.label}</span><span class="t-mini-state"></span>`;
      btn.addEventListener('pointerdown', this.onToolDown);
      btn.addEventListener('pointerup', this.onButtonUp);
      btn.addEventListener('pointercancel', this.onButtonUp);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
      this.tools.set(spec.id, btn);
      rail.appendChild(btn);
    }
    this.root.appendChild(rail);

    const cluster = document.createElement('div');
    cluster.id = 'touch-actions';
    for (const spec of BUTTONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = spec.className ? `t-btn ${spec.className}` : 't-btn';
      btn.dataset.action = spec.id;
      btn.setAttribute('aria-label', spec.label);
      btn.innerHTML = `<span class="t-btn-label">${spec.label}</span><span class="t-btn-key">${spec.key}</span>`;
      btn.addEventListener('pointerdown', this.onButtonDown);
      btn.addEventListener('pointerup', this.onButtonUp);
      btn.addEventListener('pointercancel', this.onButtonUp);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
      this.buttons.set(spec.id, btn);
      cluster.appendChild(btn);
    }
    this.root.appendChild(cluster);
    document.body.appendChild(this.root);

    this.setWeaponSlot(hooks.currentSlot());
    this.setMuted(false);

    window.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    window.addEventListener('pointermove', this.onPointerMove, { passive: false });
    window.addEventListener('pointerup', this.onPointerUp, { passive: true });
    window.addEventListener('pointercancel', this.onPointerUp, { passive: true });
    window.addEventListener('touchstart', this.onFirstTouch, { once: true, passive: true });
    window.addEventListener('blur', this.resetAll);

    const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    if (coarse) this.activate();
  }

  /** Show the layer. Desktop never reaches this: no coarse pointer, no touch. */
  activate() {
    if (this.state.active) return;
    this.state.active = true;
    this.hooks.activate();
  }

  /** the weapon picker covers the HUD while it is open; tests read this */
  get weaponPickerOpen() {
    return this.trayOpen;
  }

  /** the equipped slot, so the WPN chip and the picker agree with the game */
  setWeaponSlot(slot: number) {
    const chip = this.tools.get('weapon');
    if (chip) {
      const readout = chip.querySelector('.t-mini-state');
      if (readout) readout.textContent = String(slot);
    }
    for (const [n, btn] of this.slotButtons) btn.classList.toggle('on', n === slot);
  }

  setMuted(on: boolean) {
    this.state.muted = !!on;
    const chip = this.tools.get('mute');
    if (!chip) return;
    chip.classList.toggle('on', this.state.muted);
    chip.setAttribute('aria-pressed', String(this.state.muted));
    const readout = chip.querySelector('.t-mini-state');
    if (readout) readout.textContent = this.state.muted ? 'OFF' : '';
  }

  /** the map owns the screen, so its chip has to say so and stay pressable */
  setMapOpen(open: boolean) {
    const chip = this.tools.get('map');
    if (!chip) return;
    chip.classList.toggle('on', !!open);
    chip.setAttribute('aria-pressed', String(!!open));
    if (open) this.closePicker();
  }

  closePicker() {
    if (!this.trayOpen) return;
    this.trayOpen = false;
    this.tray.classList.remove('open');
    this.tray.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('touch-weapons');
    this.tools.get('weapon')?.classList.remove('on');
    this.tools.get('weapon')?.setAttribute('aria-pressed', 'false');
  }

  private openPicker() {
    this.trayOpen = true;
    // a keyboard slot change must not leave the picker pointing at the old gun
    this.setWeaponSlot(this.hooks.currentSlot());
    this.tray.classList.add('open');
    this.tray.setAttribute('aria-hidden', 'false');
    document.body.classList.add('touch-weapons');
    this.tools.get('weapon')?.classList.add('on');
    this.tools.get('weapon')?.setAttribute('aria-pressed', 'true');
  }

  private onFirstTouch = () => {
    this.activate();
  };

  private isUiTarget(target: EventTarget | null) {
    const el = target as Element | null;
    const closest =
      el && typeof el.closest === 'function'
        ? el.closest('#touch-actions, #touch-rail, #touch-weapons, #help-btn, #help-sheet, .overlay')
        : null;
    return !!closest;
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    if (!this.state.active) this.activate();
    if (this.isUiTarget(e.target)) return;

    this.pointers.add(e.pointerId);
    if (this.pointers.size === 2) {
      // a second finger means "tap to pause", never a drag
      this.gesture = { t: performance.now(), x: e.clientX, y: e.clientY, moved: false };
      this.releaseStick();
      this.lookId = null;
      return;
    }
    if (this.pointers.size > 2) return;

    if (e.clientX < window.innerWidth * LOOK_SPLIT && e.clientY > window.innerHeight * STICK_TOP) this.beginStick(e);
    else if (e.clientX >= window.innerWidth * LOOK_SPLIT) this.beginLook(e);
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.state.active || e.pointerType !== 'touch') return;
    if (this.gesture) {
      if (Math.hypot(e.clientX - this.gesture.x, e.clientY - this.gesture.y) > TAP_SLOP) this.gesture.moved = true;
      return;
    }
    if (e.pointerId === this.stickId) {
      if (e.cancelable) e.preventDefault();
      this.applyStick(e.clientX, e.clientY);
    } else if (e.pointerId === this.lookId) {
      if (e.cancelable) e.preventDefault();
      this.hooks.look((e.clientX - this.lookX) * LOOK_SCALE, (e.clientY - this.lookY) * LOOK_SCALE);
      this.lookX = e.clientX;
      this.lookY = e.clientY;
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    const known = this.pointers.delete(e.pointerId);
    if (e.pointerId === this.stickId) this.releaseStick();
    if (e.pointerId === this.lookId) this.lookId = null;
    // a finger that slid off a button must not leave it held down
    this.releaseButtons();
    if (this.gesture && this.pointers.size < 2) {
      const tap = known && !this.gesture.moved && performance.now() - this.gesture.t < TAP_MS;
      this.gesture = null;
      if (tap) {
        this.resetAll();
        this.hooks.pause();
      }
    }
  };

  private beginStick(e: PointerEvent) {
    const rect = this.stick.getBoundingClientRect();
    const size = rect.width || 120;
    this.stickRadius = size * 0.34;
    this.stickOriginX = e.clientX;
    this.stickOriginY = e.clientY;
    this.stick.style.left = `${e.clientX - size / 2}px`;
    this.stick.style.top = `${e.clientY - size / 2}px`;
    this.stick.style.bottom = 'auto';
    this.stick.classList.add('floating');
    this.knob.style.transform = 'translate(0px, 0px)';
    this.stickId = e.pointerId;
    this.state.moveX = 0;
    this.state.moveY = 0;
    this.state.magnitude = 0;
  }

  private applyStick(clientX: number, clientY: number) {
    const dx = clientX - this.stickOriginX;
    const dy = clientY - this.stickOriginY;
    const len = Math.hypot(dx, dy);
    const reach = Math.min(len, this.stickRadius);
    const nx = len > 0.0001 ? dx / len : 0;
    const ny = len > 0.0001 ? dy / len : 0;
    this.knob.style.transform = `translate(${(nx * reach).toFixed(1)}px, ${(ny * reach).toFixed(1)}px)`;

    const raw = reach / this.stickRadius;
    const mag = raw <= DEAD_ZONE ? 0 : (raw - DEAD_ZONE) / (1 - DEAD_ZONE);
    this.state.magnitude = mag;
    this.state.moveX = nx * mag;
    this.state.moveY = -ny * mag; // screen up = forward
    this.stick.classList.toggle('engaged', mag > 0);
  }

  private beginLook(e: PointerEvent) {
    this.lookId = e.pointerId;
    this.lookX = e.clientX;
    this.lookY = e.clientY;
  }

  private releaseStick() {
    this.stickId = null;
    this.state.moveX = 0;
    this.state.moveY = 0;
    this.state.magnitude = 0;
    this.knob.style.transform = 'translate(0px, 0px)';
    this.stick.classList.remove('floating', 'engaged');
    this.stick.style.left = '';
    this.stick.style.top = '';
    this.stick.style.bottom = '';
  }

  private onButtonDown = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!this.state.active) this.activate();
    const btn = e.currentTarget as HTMLButtonElement;
    const id = btn.dataset.action as ActionId | undefined;
    if (!id) return;
    btn.classList.add('active');
    switch (id) {
      case 'fire':
        this.state.fire = true;
        break;
      case 'jump':
        this.state.jump = true;
        break;
      case 'sprint':
        this.state.sprint = !this.state.sprint;
        btn.classList.toggle('on', this.state.sprint);
        break;
      case 'vehicle':
        this.hooks.vehicle();
        break;
      case 'interact':
        this.hooks.interact();
        break;
      case 'punch':
        this.hooks.punch();
        break;
    }
  };

  /** one-shot secondary controls: a tap does its job and lights up for 140 ms */
  private onToolDown = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!this.state.active) this.activate();
    const btn = e.currentTarget as HTMLButtonElement;
    const id = btn.dataset.tool as ToolId | undefined;
    if (!id) return;
    btn.classList.add('active');
    window.setTimeout(() => btn.classList.remove('active'), 140);
    switch (id) {
      case 'weapon':
        if (this.trayOpen) this.closePicker();
        else this.openPicker();
        break;
      case 'reload':
        this.hooks.reload();
        break;
      case 'map':
        this.hooks.map();
        break;
      case 'mute':
        this.setMuted(this.hooks.mute());
        break;
    }
  };

  private onSlotDown = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const btn = e.currentTarget as HTMLButtonElement;
    const slot = Number(btn.dataset.slot);
    if (!Number.isFinite(slot)) return;
    this.hooks.weapon(slot);
    this.setWeaponSlot(slot);
    // the picker is a chooser, not a HUD: it hands the screen back at once
    this.closePicker();
  };

  private onButtonUp = (e: PointerEvent) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.classList.remove('active');
    const id = btn.dataset.action as ActionId | undefined;
    if (id === 'fire') this.state.fire = false;
    if (id === 'jump') this.state.jump = false;
  };

  /** forget every held input (pause, app switch, two-finger tap) */
  private resetAll = () => {
    this.pointers.clear();
    this.gesture = null;
    this.lookId = null;
    this.state.fire = false;
    this.state.jump = false;
    this.closePicker();
    this.releaseStick();
    this.releaseButtons();
  };

  private releaseButtons() {
    this.state.fire = false;
    this.state.jump = false;
    for (const btn of this.buttons.values()) btn.classList.remove('active');
    for (const btn of this.tools.values()) btn.classList.remove('active');
  }
}
