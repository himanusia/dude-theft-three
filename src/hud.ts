import { clamp, formatMoney } from './utils';

export const WORLD_HALF_MAP = 3 * 52 + 19;

export class HUD {
  declare el: any;
  declare mapCtx: any;
  declare mapSize: any;
  declare lastCash: number;
  declare hitTimer: number;
  declare damageTimer: number;
  constructor() {
    this.el = {
      cash: document.getElementById('cash'),
      stars: document.getElementById('stars'),
      health: document.getElementById('health-fill'),
      healthNum: document.getElementById('health-num'),
      ammo: document.getElementById('ammo'),
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
    };
    this.mapCtx = this.el.minimap.getContext('2d');
    this.mapSize = this.el.minimap.width;
    this.lastCash = -1;
    this.hitTimer = 0;
    this.damageTimer = 0;
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
