/**
 * Touch controls: a phone/tablet layer that feeds the keyboard+mouse input
 * state in main.ts instead of forking the movement or camera logic.
 *
 * Rendered as DOM (not canvas) so the controls inherit the HUD's type, colour
 * and blur treatment. Nothing here touches the game state: the module exposes
 * an analog stick axis, accumulated look deltas and one-shot action hooks.
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
}

export interface TouchHooks {
  /** pointer delta in CSS pixels, already scaled for finger travel */
  look(dx: number, dy: number): void;
  pause(): void;
  vehicle(): void;
  interact(): void;
  punch(): void;
  /** fired once, when the controls first appear */
  activate(): void;
}

type ActionId = 'vehicle' | 'interact' | 'sprint' | 'punch' | 'jump' | 'fire';

interface ButtonSpec {
  id: ActionId;
  label: string;
  key: string;
  className?: string;
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

export class TouchControls {
  readonly state: TouchState = {
    active: false,
    moveX: 0,
    moveY: 0,
    magnitude: 0,
    sprint: false,
    jump: false,
    fire: false,
  };

  private readonly hooks: TouchHooks;
  private readonly root: HTMLDivElement;
  private readonly stick: HTMLDivElement;
  private readonly knob: HTMLDivElement;
  private readonly buttons = new Map<ActionId, HTMLButtonElement>();

  private stickId: number | null = null;
  private lookId: number | null = null;
  private stickOriginX = 0;
  private stickOriginY = 0;
  private stickRadius = 1;
  private lookX = 0;
  private lookY = 0;
  private readonly pointers = new Set<number>();
  private gesture: { t: number; x: number; y: number; moved: boolean } | null = null;

  constructor(hooks: TouchHooks) {
    this.hooks = hooks;

    this.root = document.createElement('div');
    this.root.id = 'touch-ui';
    this.root.setAttribute('aria-hidden', 'true');

    this.stick = document.createElement('div');
    this.stick.id = 'touch-stick';
    this.stick.innerHTML = '<div id="touch-stick-knob"></div>';
    this.root.appendChild(this.stick);
    this.knob = this.stick.firstElementChild as HTMLDivElement;

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

  private onFirstTouch = () => {
    this.activate();
  };

  private isUiTarget(target: EventTarget | null) {
    const el = target as Element | null;
    const closest = el && typeof el.closest === 'function' ? el.closest('#touch-actions, #help-btn, #help-sheet, .overlay') : null;
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
    this.releaseStick();
    this.releaseButtons();
  };

  private releaseButtons() {
    this.state.fire = false;
    this.state.jump = false;
    for (const btn of this.buttons.values()) btn.classList.remove('active');
  }
}
