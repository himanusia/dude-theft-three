// Audio: CC0 Kenney SFX (impact/digital/sci-fi packs) + CC-BY Kevin MacLeod BGM.
// Engine loop is a pitched CC0 sci-fi loop; siren is synthesized with WebAudio.

const SFX_FILES = {
  shot_pistol: 'audio/sfx/shot_pistol.ogg',
  shot_rifle: 'audio/sfx/shot_rifle.ogg',
  explosion: 'audio/sfx/explosion.ogg',
  crash: 'audio/sfx/crash.ogg',
  crash2: 'audio/sfx/crash2.ogg',
  metal: 'audio/sfx/metal.ogg',
  punch: 'audio/sfx/punch.ogg',
  bodyfall: 'audio/sfx/bodyfall.ogg',
  step0: 'audio/sfx/step0.ogg',
  step1: 'audio/sfx/step1.ogg',
  step2: 'audio/sfx/step2.ogg',
  step3: 'audio/sfx/step3.ogg',
  cash: 'audio/sfx/cash.ogg',
  click: 'audio/sfx/click.ogg',
  glass: 'audio/sfx/glass.ogg',
};

const BGM = {
  funk: 'audio/bgm/funk.mp3',
  chase: 'audio/bgm/chase.mp3',
  calm: 'audio/bgm/calm.mp3',
};

export class AudioSys {
  declare ctx: any;
  declare buffers: any;
  declare ready: boolean;
  declare muted: boolean;
  declare bgmEls: Record<string, HTMLAudioElement>;
  declare bgmMode: any;
  declare bgmVolume: number;
  declare engine: any;
  declare sirenNodes: any;
  declare master: any;
  declare sfx: any;
  // mixer levels, 0..1, driven by the persisted settings panel
  declare masterVol: number;
  declare sfxVol: number;
  declare bgmVol: number;
  constructor() {
    this.ctx = null;
    this.buffers = {};
    this.ready = false;
    this.muted = false;
    this.bgmEls = {} as Record<string, HTMLAudioElement>;
    this.bgmMode = null;
    this.bgmVolume = 0.28;
    this.engine = null;
    this.sirenNodes = null;
    this.masterVol = 0.9;
    this.sfxVol = 1;
    this.bgmVol = 1;
  }

  async init() {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.masterVol;
    this.master.connect(this.ctx.destination);
    // one bus for game SFX, so the settings slider scales every shot/impact
    // without touching the per-call volumes
    this.sfx = this.ctx.createGain();
    this.sfx.gain.value = this.muted ? 0 : this.sfxVol;
    this.sfx.connect(this.master);

    const load = async (url: string) => {
      const res = await fetch(url);
      const arr = await res.arrayBuffer();
      return this.ctx.decodeAudioData(arr);
    };
    const entries = Object.entries(SFX_FILES);
    const results = await Promise.all(
      entries.map(([, url]) => load(url).catch(() => null))
    );
    entries.forEach(([name], i) => {
      if (results[i]) this.buffers[name] = results[i];
    });

    for (const [k, url] of Object.entries(BGM)) {
      const el = new Audio(url);
      el.loop = true;
      el.volume = 0;
      el.preload = 'auto';
      this.bgmEls[k] = el;
    }
    this.ready = true;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  play(name: string, { vol = 1, rate = 1, pan = 0 } = {}) {
    if (!this.ready || this.muted) return;
    const buf = this.buffers[name];
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    let node = g;
    if (this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      node = p;
    }
    src.connect(g);
    node.connect(this.sfx ?? this.master);
    src.start();
  }

  step() {
    this.play('step' + Math.floor(Math.random() * 4), { vol: 0.22, rate: 0.9 + Math.random() * 0.2 });
  }

  startBgm(mode: string) {
    if (!this.ready || mode === this.bgmMode) return;
    const prev = this.bgmMode;
    this.bgmMode = mode;
    Object.entries(this.bgmEls).forEach(([k, el]) => {
      if (k === mode) {
        el.play?.().catch(() => {});
        this.fadeEl(el, this.bgmVolume, 1.2);
      } else if (k === prev) {
        this.fadeEl(el, 0, 1.2, () => el.pause());
      }
    });
  }

  fadeEl(el: HTMLAudioElement, target: number, seconds: number, done?: () => void) {
    const start = el.volume;
    const t0 = performance.now();
    const tick = () => {
      const t = Math.min(1, (performance.now() - t0) / (seconds * 1000));
      el.volume = start + (target - start) * t;
      if (t < 1) requestAnimationFrame(tick);
      else done?.();
    };
    tick();
  }

  engineStart() {
    if (!this.ready || this.engine) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.engine || null;
    if (!src.buffer) return;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 700;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfx ?? this.master);
    src.start();
    this.engine = { src, filter, gain };
  }

  engineUpdate({ speed01 = 0, throttle = 0, on = false }) {
    if (!this.engine) {
      if (on) this.engineStart();
      if (!this.engine) return;
    }
    const e = this.engine;
    const target = on ? 0.22 + throttle * 0.16 : 0;
    e.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.08);
    e.src.playbackRate.setTargetAtTime(0.75 + speed01 * 1.5, this.ctx.currentTime, 0.1);
    e.filter.frequency.setTargetAtTime(400 + speed01 * 1400 + throttle * 300, this.ctx.currentTime, 0.1);
  }

  siren(on: boolean) {
    if (!this.ready) return;
    if (on && !this.sirenNodes) {
      const g = this.ctx.createGain();
      g.gain.value = 0.0;
      g.connect(this.sfx ?? this.master);
      const osc = this.ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = 720;
      const lfo = this.ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.45;
      const lfoGain = this.ctx.createGain();
      lfoGain.gain.value = 180;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      const filt = this.ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 1400;
      osc.connect(filt);
      filt.connect(g);
      osc.start();
      lfo.start();
      g.gain.setTargetAtTime(0.09, this.ctx.currentTime, 0.3);
      this.sirenNodes = { osc, lfo, g };
    } else if (!on && this.sirenNodes) {
      const { osc, lfo, g } = this.sirenNodes;
      g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
      setTimeout(() => {
        try {
          osc.stop();
          lfo.stop();
        } catch (e) {}
      }, 900);
      this.sirenNodes = null;
    }
  }

  tyreScreech(vol = 0.15) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const dur = 0.45;
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400;
    bp.Q.value = 7;
    const g = ctx.createGain();
    g.gain.value = vol;
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.sfx ?? this.master);
    src.start();
  }

  /**
   * Mixer levels, 0..1 each. Safe before init(): values are stored and applied
   * when the AudioContext exists, which is what lets a restored settings blob be
   * audible from the first sound instead of only after the player opens the panel.
   */
  setVolumes({ master, sfx, bgm }: { master?: number; sfx?: number; bgm?: number } = {}) {
    const unit = (v: number) => Math.min(1, Math.max(0, v));
    if (typeof master === 'number') this.masterVol = unit(master);
    if (typeof sfx === 'number') this.sfxVol = unit(sfx);
    if (typeof bgm === 'number') this.bgmVol = unit(bgm);
    if (this.master) this.master.gain.value = this.muted ? 0 : this.masterVol;
    if (this.sfx) this.sfx.gain.value = this.muted ? 0 : this.sfxVol;
    this.bgmVolume = 0.28 * this.bgmVol;
    if (this.bgmMode) {
      Object.entries(this.bgmEls).forEach(([k, el]) => {
        if (k === this.bgmMode) el.volume = this.bgmVolume;
      });
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : this.masterVol;
    if (this.sfx) this.sfx.gain.value = this.muted ? 0 : this.sfxVol;
    Object.values(this.bgmEls).forEach((el) => (el.muted = this.muted));
    return this.muted;
  }
}
