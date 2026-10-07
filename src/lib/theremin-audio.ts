export const WAVE_NAMES = ["sine", "triangle", "sawtooth", "square"] as const;
export type WaveName = (typeof WAVE_NAMES)[number];

const WAVE_GAIN: Record<WaveName, number> = {
  sine: 0.9,
  triangle: 0.7,
  sawtooth: 0.4,
  square: 0.36,
};

const HARM_GAIN: Record<WaveName, number> = {
  sine: 0.2,
  triangle: 0.08,
  sawtooth: 0,
  square: 0,
};

/** Short quiet tone. Android WebViews stay silent until an <audio> element plays inside the tap. */
const UNLOCK_WAV =
  "data:audio/wav;base64,UklGRuQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YcADAAAAAAkAHgAzADwALQADAMj/jP9m/2f/mP/z/2IAxgAAAfgApwAdAHr/6/6b/qf+FP/N/6MAXwHIAbwBNQFQAEX/XP7X/eD9ff6N/8wA5AGIAoUC1AGbACr/4f0c/Rb92P03/9oAVAI8A1ADgAL9ACj/ff1v/Ez8Jv3K/s8ArALiAxcENwN0AUH/Mf3S+4f7a/xK/qoA7AJ2BNkE9AP9AXL//vxI+8r6q/u5/W0AEgP1BJEFtQSVArv/5PzT+hj66voa/RgAHgNeBTwGdgU6AxoA5fx2+nX5K/pw/K//EQOvBdcGMwboA40AAP0y+uP4cvm++zP/6gLnBV4H6AacBBEBM/0H+mX4wvgJ+6f+qwIFBtEHkgdRBaQBff32+f73H/hU+g/+VQIIBiwILQgFBkIC3f0A+q/3i/ej+Wz96wHyBW8Itwi0BugCUP4j+nn3C/f4+MT8cAHDBZgILglZB5ID1P5e+l73n/ZZ+Bn85QB8BaYIjgnyBz0EZf+w+lz3S/bH92/7TwAfBZsI1gl8COQEAAAX+3X3D/ZG98r6sP+uBHUIBQrzCIUFogCR+6f37vXZ9i76DP8tBDcIGQpVCRwGRwEa/PH35vWC9p35Z/6dA+EHFAqgCaYG6wGv/FL4+fVD9hz5xP0DA3YH9AnTCR4HiwJN/cb4JvYd9qz4KP1hAvkGugnsCYQHIwPx/Uz5bPYR9lH4lfy8AWsGaAnrCdQHsAOX/uH5yfYf9g34D/wWAdAFAAnQCQwILgQ7/4H6PPdI9uH3mft1ACwFgwiaCSwImwTa/yn7w/eK9s73Nvva/4IE9AdLCTEI9ARvANX7Wfjl9tb36PpL/9UDVgflCB0INgX4AIH8/vhX9/f3sfrJ/ikDrAZpCO4HYQVyASv9rPnd9zP4k/pY/oMC+gXZB6UHcwXZAc79Yfp1+Ij4jvr7/eQBRAU4B0QHagUsAmb+GPsd+fX4pPqz/VIBjASKBswGSAVnAvL+z/vR+Xf51PqE/c8A1gPRBUAGCwWLAmz/gvyO+g76Hftt/V0AJwMSBaAFtQSVAtT/Lf1Q+7X6fvtv/QAAggJOBPIESASGAiYAzP0T/Gv79/uM/bn/6gGMAzcExQNcAmEAXf7U/Cv8hfzC/Yr/YQHNAnIDLgMZAoQA3P6Q/fL8Jf0S/nT/7AAWAqkChQK9AY0AR/9C/r391P15/nj/iwBqAd0BzwFLAXwAnP/n/oj+kf72/pb/QgDMABMBDQHDAFEA2v99/1D/V/+I/83/EQA/AE8ARAApAA4A/v8=";

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor {
  const w = window as Window & { webkitAudioContext?: AudioContextCtor };
  return window.AudioContext ?? w.webkitAudioContext!;
}

function glide(param: AudioParam, value: number, time: number, smooth: boolean, seconds: number): void {
  if (!smooth) {
    param.cancelScheduledValues(time);
    param.value = value;
    return;
  }
  param.setTargetAtTime(value, time, seconds);
}

function makeImpulse(ctx: AudioContext): AudioBuffer {
  const seconds = 2.35;
  const rate = ctx.sampleRate || 44100;
  const length = Math.max(1, Math.floor(rate * seconds));
  const buffer = ctx.createBuffer(2, length, rate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let low = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      low += (white - low) * 0.16;
      const t = i / length;
      const fadeIn = Math.min(1, i / (rate * 0.012));
      data[i] = low * Math.pow(1 - t, 2.7) * fadeIn;
    }
  }
  return buffer;
}

export type FingerTone = {
  id: number;
  freq: number;
  volume: number;
  vibratoCents: number;
};

export type MixParams = {
  waveform: WaveName;
  reverb: number;
  muted: boolean;
};

/** One oscillator pair per finger. Shared reverb and compressor. */
export const MAX_VOICES = 10;

type Voice = {
  owner: number | null;
  osc: OscillatorNode;
  body: OscillatorNode;
  bodyGain: GainNode;
  filter: BiquadFilterNode;
  voice: GainNode;
  lfo: OscillatorNode;
  lfoGain: GainNode;
  primed: boolean;
  waveform: WaveName;
};

export class ThereminEngine {
  private ctx: AudioContext | null = null;
  private sum: GainNode | null = null;
  private dry: GainNode | null = null;
  private wet: GainNode | null = null;
  private master: GainNode | null = null;
  private voices: Voice[] = [];
  private queued: { fingers: FingerTone[]; mix: MixParams } | null = null;
  private pending = false;
  private didApply = false;
  private stopped = false;
  private media: HTMLAudioElement | null = null;
  private wetTimer = 0;
  private wetAttached = false;
  private watching = false;

  /**
   * Call synchronously from the gesture. Android starts every context suspended and
   * drops parameter writes made before the audio thread is running, so this only
   * resumes and unlocks — the note is applied once state is "running".
   */
  ensure(): void {
    if (this.stopped) return;
    const ctx = this.context();
    this.blip();
    if (ctx.state === "running") {
      this.flushPending();
      return;
    }
    void ctx.resume().then(
      () => this.flushPending(),
      () => {
        /* denied until a later touchend/click calls ensure again */
      },
    );
    this.watch();
  }

  private context(): AudioContext {
    if (this.ctx) return this.ctx;
    const Ctor = audioContextCtor();
    const ctx = new Ctor();
    this.ctx = ctx;
    ctx.addEventListener("statechange", () => this.flushPending());
    this.buildDry(ctx);
    return ctx;
  }

  /** WebView media playback stays blocked until a real media element plays in the tap. */
  private blip(): void {
    if (this.ctx?.state === "running") return;
    try {
      if (!this.media) {
        const audio = new Audio(UNLOCK_WAV);
        audio.preload = "auto";
        audio.setAttribute("playsinline", "");
        audio.setAttribute("webkit-playsinline", "");
        this.media = audio;
      }
      try {
        this.media.currentTime = 0;
      } catch {
        /* metadata not ready yet */
      }
      void this.media.play().catch(() => {});
    } catch {
      /* autoplay policy will reject until the gesture is one it counts */
    }
  }

  private watch(): void {
    if (this.watching) return;
    this.watching = true;
    const started = performance.now();
    const tick = () => {
      if (this.stopped) return;
      if (this.ctx?.state === "running") {
        this.flushPending();
        this.watching = false;
        return;
      }
      if (performance.now() - started > 1800) {
        this.watching = false;
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private buildDry(ctx: AudioContext): void {
    const master = ctx.createGain();
    master.gain.value = 1;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.knee.value = 18;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.18;

    const sum = ctx.createGain();
    sum.gain.value = 1;

    const dry = ctx.createGain();
    dry.gain.value = 0.88;

    const wet = ctx.createGain();
    wet.gain.value = 0.3;

    sum.connect(dry);
    dry.connect(master);
    wet.connect(master);
    master.connect(compressor);
    compressor.connect(ctx.destination);

    this.master = master;
    this.sum = sum;
    this.dry = dry;
    this.wet = wet;
  }

  /** Impulse is large; build it after the dry note is already sounding. */
  private scheduleWet(): void {
    if (this.wetTimer || this.wetAttached || !this.ctx || !this.sum || !this.wet) return;
    this.wetTimer = window.setTimeout(() => {
      this.wetTimer = 0;
      this.attachWet();
    }, 40);
  }

  private attachWet(): void {
    const ctx = this.ctx;
    const sum = this.sum;
    const wet = this.wet;
    if (!ctx || !sum || !wet || this.stopped || this.wetAttached) return;
    try {
      const predelay = ctx.createDelay();
      predelay.delayTime.value = 0.026;
      const convolver = ctx.createConvolver();
      convolver.buffer = makeImpulse(ctx);
      const wetFilter = ctx.createBiquadFilter();
      wetFilter.type = "lowpass";
      wetFilter.frequency.value = 3400;
      sum.connect(predelay);
      predelay.connect(convolver);
      convolver.connect(wetFilter);
      wetFilter.connect(wet);
      this.wetAttached = true;
    } catch {
      /* dry path still plays */
    }
  }

  private makeVoice(ctx: AudioContext, sum: GainNode): Voice {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 440;

    const body = ctx.createOscillator();
    body.type = "sine";
    body.frequency.value = 880;

    const bodyGain = ctx.createGain();
    bodyGain.gain.value = 0;

    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 5.2;

    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.detune);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.55;
    filter.frequency.value = 1800;

    const voice = ctx.createGain();
    voice.gain.value = 0;

    osc.connect(filter);
    body.connect(bodyGain);
    bodyGain.connect(filter);
    filter.connect(voice);
    voice.connect(sum);

    const start = (node: OscillatorNode) => {
      try {
        node.start();
      } catch {
        /* already started, or the context was not ready */
      }
    };
    start(osc);
    start(body);
    start(lfo);

    return {
      owner: null,
      osc,
      body,
      bodyGain,
      filter,
      voice,
      lfo,
      lfoGain,
      primed: false,
      waveform: "sine",
    };
  }

  private acquire(id: number): Voice | null {
    const ctx = this.ctx;
    const sum = this.sum;
    if (!ctx || !sum || ctx.state !== "running") return null;
    const existing = this.voices.find((voice) => voice.owner === id);
    if (existing) return existing;
    let voice = this.voices.find((slot) => slot.owner == null);
    if (!voice) {
      if (this.voices.length >= MAX_VOICES) return null;
      voice = this.makeVoice(ctx, sum);
      this.voices.push(voice);
    }
    voice.owner = id;
    voice.primed = false;
    return voice;
  }

  setFingers(fingers: FingerTone[], mix: MixParams): void {
    this.queued = {
      fingers: fingers.map((finger) => ({ ...finger })),
      mix: { ...mix },
    };
    this.pending = true;
    if (this.ctx?.state === "running") this.flushPending();
  }

  private flushPending(): void {
    if (!this.queued || this.ctx?.state !== "running") return;
    if (!this.sum || !this.dry || !this.wet || !this.master) return;
    if (!this.pending && this.didApply) return;
    this.pending = false;
    this.renderMix(this.queued.fingers, this.queued.mix);
    this.scheduleWet();
    if (!this.didApply) {
      this.didApply = true;
      // Some phones drop the parameter write that happens in the same turn as resume().
      requestAnimationFrame(() => this.reapply());
    }
  }

  private reapply(): void {
    if (this.stopped || !this.queued || this.ctx?.state !== "running") return;
    for (const voice of this.voices) {
      if (voice.owner != null) voice.primed = false;
    }
    this.renderMix(this.queued.fingers, this.queued.mix);
  }

  private renderMix(fingers: FingerTone[], mix: MixParams): void {
    if (!this.ctx || !this.dry || !this.wet || !this.master) return;
    const t = this.ctx.currentTime;
    const live = new Set(fingers.map((finger) => finger.id));

    for (const voice of this.voices) {
      if (voice.owner != null && !live.has(voice.owner)) {
        voice.owner = null;
        voice.primed = false;
        glide(voice.voice.gain, 0, t, true, 0.085);
        glide(voice.lfoGain.gain, 0, t, true, 0.05);
      }
    }

    const sounding = fingers.reduce((count, finger) => count + (finger.volume > 0.004 ? 1 : 0), 0);
    const poly = sounding <= 1 ? 1 : 1 / Math.sqrt(sounding);

    for (const finger of fingers) {
      const voice = this.acquire(finger.id);
      if (!voice) continue;
      const freq = Math.min(4200, Math.max(48, finger.freq));
      const harmonic = Math.min(8400, freq * 2);
      const first = !voice.primed;
      if (first) {
        voice.primed = true;
        voice.osc.frequency.cancelScheduledValues(t);
        voice.osc.frequency.value = freq;
        voice.body.frequency.cancelScheduledValues(t);
        voice.body.frequency.value = harmonic;
      } else {
        voice.osc.frequency.setTargetAtTime(freq, t, 0.042);
        voice.body.frequency.setTargetAtTime(harmonic, t, 0.042);
      }

      if (mix.waveform !== voice.waveform) {
        voice.waveform = mix.waveform;
        voice.osc.type = mix.waveform;
      }

      const shaped = Math.pow(Math.min(1, Math.max(0, finger.volume)), 1.4);
      const amp = shaped * 0.3 * poly * WAVE_GAIN[mix.waveform];
      glide(voice.voice.gain, amp, t, !first, first ? 0 : amp === 0 ? 0.085 : 0.03);
      glide(voice.bodyGain.gain, shaped > 0 ? HARM_GAIN[mix.waveform] : 0, t, !first, 0.05);

      const cents = shaped > 0 ? Math.min(18, Math.max(0, finger.vibratoCents)) : 0;
      glide(voice.lfoGain.gain, cents, t, !first, 0.05);

      const brightMul = mix.waveform === "sine" ? 6.2 : mix.waveform === "triangle" ? 4.6 : 3;
      const cutoff = Math.min(9800, Math.max(360, freq * brightMul + shaped * 2000));
      glide(voice.filter.frequency, cutoff, t, !first, 0.06);
    }

    const wetAmt = Math.min(1, Math.max(0, mix.reverb));
    glide(this.wet.gain, wetAmt * 0.9, t, true, 0.08);
    glide(this.dry.gain, 1 - wetAmt * 0.32, t, true, 0.08);
    glide(this.master.gain, mix.muted ? 0 : 1, t, true, mix.muted ? 0.02 : 0.04);
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.wetTimer) window.clearTimeout(this.wetTimer);
    this.media?.pause();
    this.media = null;
    for (const voice of this.voices) {
      try {
        voice.osc.stop();
      } catch {
        /* already stopped */
      }
      try {
        voice.body.stop();
      } catch {
        /* already stopped */
      }
      try {
        voice.lfo.stop();
      } catch {
        /* already stopped */
      }
    }
    this.voices = [];
    void this.ctx?.close();
    this.ctx = null;
  }
}
