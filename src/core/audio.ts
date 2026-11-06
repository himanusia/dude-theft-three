// Audio: CC0 Kenney SFX (impact/digital/sci-fi packs) + CC-BY Kevin MacLeod BGM.
// Engine loop is a pitched CC0 sci-fi loop; siren is synthesized with WebAudio.
//
// The Jakarta street layer (docs/audio-sourcing.md) lives here too: four looping ambience beds
// that stream as media elements and crossfade with where the player is standing, four one-shots
// that ride a car or a pedal vehicle passing close, and the gamelan menu loop.

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
  // the engine loop the repo already ships: 5.0 s, mono, 44.1 kHz Vorbis. It is a loop, not a
  // sting, so it is loaded once and retuned per frame instead of retriggered.
  engine: 'audio/sfx/engine.ogg',
  // one-shots from the Jakarta street kit: a horn belongs to a vehicle that just came close, so
  // it is a decoded buffer played once, never a loop
  angkot_horn: 'audio/ambience/angkot-horn.ogg',
  moped_horn: 'audio/ambience/moped-horn.ogg',
  moped_passby: 'audio/ambience/moped-passby.ogg',
  pedal_bell: 'audio/ambience/pedal-bell.ogg',
};

/**
 * The four ambience beds. These recordings run 45 s to 3 min, so they are streamed through a
 * media element into a gain node instead of decoding the whole thing into memory: at 44.1 kHz
 * float32, the pasar loop alone would be ~28 MB decoded. Each bed is silent at gain 0 until the
 * director in `systems/ambience.ts` fades it in; `BED_LEVEL` is the full-volume ceiling so four
 * overlapping beds never sum past a comfortable street murmur.
 */
const BEDS = {
  city_crowd: 'audio/ambience/city-crowd-ambience.ogg',
  pasar_market: 'audio/ambience/pasar-market-ambience.ogg',
  warung: 'audio/ambience/warung-ambience.ogg',
  tropical_rain: 'audio/ambience/tropical-rain.ogg',
};

const BED_LEVEL: Record<string, number> = {
  city_crowd: 0.3,
  pasar_market: 0.4,
  warung: 0.34,
  tropical_rain: 0.42,
};

const BGM = {
  funk: 'audio/bgm/funk.mp3',
  chase: 'audio/bgm/chase.mp3',
  calm: 'audio/bgm/calm.mp3',
  // the menu cue: a 1931 gamelan pelog recording, public domain (CREDITS.md)
  gamelan: 'audio/ambience/gamelan-menu-loop.ogg',
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
  /** bus for the streaming ambience beds; rides the SFX slider and the mute, like the SFX bus */
  declare ambienceBus: any;
  declare beds: Record<string, any>;
  declare initPromise: any;
  /** per one-shot name: how many times it has actually started, and when it first did */
  declare oneShotStats: Record<string, { plays: number; firstAt: number }>;
  /** per BGM mode: same accounting, so the menu cue can be proven to have played */
  declare bgmStats: Record<string, { plays: number; firstAt: number }>;
  // what the engine graph was last asked for, so a probe (and the mute path) can tell a live
  // engine from one that is only ramping towards a target
  declare engineSeq: number;
  declare engineMuffle: number;
  declare engineGainTarget: number;
  declare engineRateTarget: number;
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
    this.engineSeq = 0;
    this.engineMuffle = 0;
    this.engineGainTarget = 0;
    this.engineRateTarget = 0;
    this.sirenNodes = null;
    this.masterVol = 0.9;
    this.sfxVol = 1;
    this.bgmVol = 1;
  }

  /**
   * Build the context once. `init()` is called by the menu unlock and again by Start, and both
   * can be in flight at the same time (the click that unlocks the menu is often the click on
   * Start), so the work lives behind one promise instead of two half-built graphs.
   */
  async init() {
    if (this.ready) return;
    if (!this.initPromise) {
      // a failed build must not poison the mixer for the rest of the page: Start retries it
      this.initPromise = this.build().catch((e: any) => {
        this.initPromise = null;
        throw e;
      });
    }
    return this.initPromise;
  }

  private async build() {
    this.oneShotStats = {};
    this.bgmStats = {};
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
    // the street beds are world sound, not menu music: they ride the same slider as the SFX and
    // are silenced by the same mute, but they get their own bus so their sum stays bounded
    this.ambienceBus = this.ctx.createGain();
    this.ambienceBus.gain.value = this.muted ? 0 : this.sfxVol * 0.9;
    this.ambienceBus.connect(this.master);

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

    // beds: stream the file, take its output into the WebAudio graph, keep it silent at gain 0
    this.beds = {};
    for (const [name, url] of Object.entries(BEDS)) {
      const el = new Audio(url);
      el.loop = true;
      el.preload = 'auto';
      el.volume = 1;
      const source = this.ctx.createMediaElementSource(el);
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      source.connect(gain);
      gain.connect(this.ambienceBus);
      this.beds[name] = { el, gain, playing: false, starts: 0, firstAt: 0, target: 0, source };
    }

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

  /**
   * Fade one ambience bed towards `target` (0..1 of its own ceiling). The source keeps looping at
   * gain 0 when the player leaves the zone, so walking back in costs no restart and no gap; the
   * beds are loops, never stings. `fade` is seconds of linear ramp, which is what makes two zones
   * crossfade instead of one cutting out before the other comes up.
   */
  ambienceSet(name: string, target: number, fade = 1.6) {
    const bed = this.beds?.[name];
    if (!bed) return;
    const unit = Math.min(1, Math.max(0, Number.isFinite(target) ? target : 0));
    const want = unit * (BED_LEVEL[name] ?? 0.3);
    if (unit > 0.01 && !bed.playing) {
      bed.playing = true;
      bed.starts += 1;
      if (!bed.firstAt) bed.firstAt = performance.now();
      const p = bed.el.play?.();
      if (p && p.catch) p.catch(() => {});
    }
    // already heading there: do not re-arm the parameter every frame
    if (Math.abs(want - bed.target) < 0.004) return;
    bed.target = want;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const g = bed.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(want, t + Math.max(0.05, fade));
  }

  /** What every ambience asset is doing, for the headless probe. Reads the live graph, not flags. */
  ambienceState() {
    const assets: Record<string, any> = {};
    for (const [name, bed] of Object.entries(this.beds ?? {})) {
      assets[name] = {
        kind: 'bed',
        loaded: !!bed.el && !bed.el.error && bed.el.readyState >= 2,
        readyState: bed.el ? bed.el.readyState : 0,
        playing: !!bed.el && !bed.el.paused,
        plays: bed.starts,
        firstAt: bed.firstAt,
        gain: bed.gain ? +bed.gain.gain.value.toFixed(4) : 0,
        target: +bed.target.toFixed(4),
        loop: !!bed.el && bed.el.loop,
      };
    }
    for (const name of ['angkot_horn', 'moped_horn', 'moped_passby', 'pedal_bell']) {
      const s = this.oneShotStats?.[name] ?? { plays: 0, firstAt: 0 };
      assets[name] = {
        kind: 'one-shot',
        loaded: !!this.buffers?.[name],
        playing: false,
        plays: s.plays,
        firstAt: s.firstAt,
        loop: false,
      };
    }
    const gam = this.bgmEls?.gamelan;
    const gs = this.bgmStats?.gamelan ?? { plays: 0, firstAt: 0 };
    assets.gamelan = {
      kind: 'menu-loop',
      loaded: !!gam && !gam.error && gam.readyState >= 2,
      readyState: gam ? gam.readyState : 0,
      playing: !!gam && !gam.paused,
      plays: gs.plays,
      firstAt: gs.firstAt,
      volume: gam ? +gam.volume.toFixed(3) : 0,
      loop: !!gam && gam.loop,
    };
    return {
      ready: this.ready,
      ctxState: this.ctx ? this.ctx.state : null,
      muted: this.muted,
      volumes: { master: this.masterVol, sfx: this.sfxVol, bgm: this.bgmVol },
      ambienceGain: this.ambienceBus ? +this.ambienceBus.gain.value.toFixed(3) : 0,
      assets,
    };
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
    let stat = this.oneShotStats[name];
    if (!stat) stat = this.oneShotStats[name] = { plays: 0, firstAt: 0 };
    stat.plays += 1;
    if (!stat.firstAt) stat.firstAt = performance.now();
  }

  step() {
    this.play('step' + Math.floor(Math.random() * 4), { vol: 0.22, rate: 0.9 + Math.random() * 0.2 });
  }

  /** Nudge the chase track's tempo up with the wanted level: same cue, more urgency. */
  setBgmIntensity(intensity: number) {
    const el = this.bgmEls?.chase;
    if (!el) return;
    const rate = 1 + Math.max(0, Math.min(1, intensity)) * 0.07;
    if (Math.abs((el.playbackRate || 1) - rate) > 0.005) el.playbackRate = rate;
  }

  startBgm(mode: string) {
    if (!this.ready || mode === this.bgmMode) return;
    const prev = this.bgmMode;
    this.bgmMode = mode;
    Object.entries(this.bgmEls).forEach(([k, el]) => {
      if (k === mode) {
        el.play?.().catch(() => {});
        const stat = (this.bgmStats[k] ??= { plays: 0, firstAt: 0 });
        stat.plays += 1;
        if (!stat.firstAt) stat.firstAt = performance.now();
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

  /**
   * The player's own engine, one looping source per session: the player can only drive one
   * vehicle at a time, so everything that changes with the car (pitch, level, tone, how much
   * bodywork is in the way) is a parameter on this one graph rather than a new node per car.
   */
  engineStart() {
    if (!this.ready || this.engine) return;
    // no buffer is silence, not a half-built graph a probe could mistake for a running engine
    const buf = this.buffers.engine;
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = 0.75;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 320;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfx ?? this.master);
    src.start();
    this.engineSeq += 1;
    this.engine = { src, filter, gain, id: this.engineSeq };
  }

  /**
   * Drive the engine note from real vehicle state. Called every frame, so every parameter is
   * smoothed with `setTargetAtTime` instead of being stepped.
   *
   * @param speed01  gear-stepped rpm 0..1 (`Car#engineRpm01`): the pitch, so a shift drops the
   *                 note instead of one flat drone climbing to redline
   * @param throttle pedal 0..1, already scaled by road speed: the level
   * @param muffle   0..1 how much bodywork sits between the player's ear and the engine: a
   *                 closed cabin and a shop wall both cut the level and the top end first
   */
  engineUpdate(
    { speed01 = 0, throttle = 0, on = false, muffle = 0 }: { speed01?: number; throttle?: number; on?: boolean; muffle?: number } = {}
  ) {
    const unit = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
    const rpm = unit(speed01);
    const pedal = unit(throttle);
    const wall = unit(muffle);
    if (!this.engine) {
      if (!on) return;
      this.engineStart();
      if (!this.engine) return;
    }
    const e = this.engine;
    const t = this.ctx.currentTime;
    // idle, road speed and pedal all contribute, and the cabin eats a share of the total
    const gainTarget = on ? (0.16 + 0.13 * rpm + 0.12 * pedal) * (1 - 0.6 * wall) : 0;
    // the loop is a recording of one engine, so the note is the gear-stepped rpm: 0.75 at idle
    // up to 1.9 at the top of fifth
    const rateTarget = 0.75 + rpm * 1.15;
    // a lowpass that opens with load is what makes a small loop read as a big engine; a closed
    // cabin or a wall moves the cut-off down, which is the part you actually hear change
    const cutoffTarget = Math.max(160, (320 + rpm * 1500 + pedal * 420) * (1 - 0.62 * wall));
    this.engineMuffle = wall;
    this.engineGainTarget = gainTarget;
    this.engineRateTarget = rateTarget;
    e.gain.gain.setTargetAtTime(gainTarget, t, 0.09);
    e.src.playbackRate.setTargetAtTime(rateTarget, t, 0.12);
    e.filter.frequency.setTargetAtTime(cutoffTarget, t, 0.12);
  }

  /** What the engine graph is doing right now, for the headless probe and for debugging. */
  engineState() {
    const e = this.engine;
    return {
      ready: this.ready,
      hasBuffer: !!this.buffers.engine,
      node: !!e,
      nodeId: e ? e.id : 0,
      ctxState: this.ctx ? this.ctx.state : null,
      loop: e ? e.src.loop : false,
      gain: e ? +e.gain.gain.value.toFixed(4) : 0,
      gainTarget: +this.engineGainTarget.toFixed(4),
      rate: e ? +e.src.playbackRate.value.toFixed(3) : 0,
      rateTarget: +this.engineRateTarget.toFixed(3),
      cutoff: e ? Math.round(e.filter.frequency.value) : 0,
      muffle: this.engineMuffle,
    };
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
    if (this.ambienceBus) this.ambienceBus.gain.value = this.muted ? 0 : this.sfxVol * 0.9;
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
    if (this.ambienceBus) this.ambienceBus.gain.value = this.muted ? 0 : this.sfxVol * 0.9;
    Object.values(this.bgmEls).forEach((el) => (el.muted = this.muted));
    return this.muted;
  }
}
