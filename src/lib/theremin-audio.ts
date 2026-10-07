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

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor {
  const w = window as Window & { webkitAudioContext?: AudioContextCtor };
  return window.AudioContext ?? w.webkitAudioContext!;
}

function makeImpulse(ctx: AudioContext): AudioBuffer {
  const seconds = 2.35;
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * seconds);
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

export type PerformanceParams = {
  freq: number;
  volume: number;
  waveform: WaveName;
  reverb: number;
  muted: boolean;
  vibratoCents: number;
};

export class ThereminEngine {
  private ctx: AudioContext | null = null;
  private osc: OscillatorNode | null = null;
  private body: OscillatorNode | null = null;
  private bodyGain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private voice: GainNode | null = null;
  private dry: GainNode | null = null;
  private wet: GainNode | null = null;
  private master: GainNode | null = null;
  private lfo: OscillatorNode | null = null;
  private lfoGain: GainNode | null = null;
  private waveform: WaveName = "sine";
  private primed = false;
  private stopped = false;

  /** Call synchronously inside the first pointer/key gesture. */
  ensure(): void {
    if (this.stopped) return;
    if (!this.ctx) {
      this.ctx = new (audioContextCtor())({ latencyHint: "interactive" });
      this.build(this.ctx);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  private build(ctx: AudioContext): void {
    const master = ctx.createGain();
    master.gain.value = 1;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 16;
    compressor.ratio.value = 3.5;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.2;

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

    const dry = ctx.createGain();
    dry.gain.value = 0.88;

    const wet = ctx.createGain();
    wet.gain.value = 0.3;

    const predelay = ctx.createDelay();
    predelay.delayTime.value = 0.026;

    const convolver = ctx.createConvolver();
    convolver.buffer = makeImpulse(ctx);

    const wetFilter = ctx.createBiquadFilter();
    wetFilter.type = "lowpass";
    wetFilter.frequency.value = 3400;

    osc.connect(filter);
    body.connect(bodyGain);
    bodyGain.connect(filter);
    filter.connect(voice);
    voice.connect(dry);
    dry.connect(master);
    voice.connect(predelay);
    predelay.connect(convolver);
    convolver.connect(wetFilter);
    wetFilter.connect(wet);
    wet.connect(master);
    master.connect(compressor);
    compressor.connect(ctx.destination);

    osc.start();
    body.start();
    lfo.start();

    this.master = master;
    this.osc = osc;
    this.body = body;
    this.bodyGain = bodyGain;
    this.filter = filter;
    this.voice = voice;
    this.dry = dry;
    this.wet = wet;
    this.lfo = lfo;
    this.lfoGain = lfoGain;
  }

  setPerformance(opts: PerformanceParams): void {
    if (!this.ctx || !this.osc || !this.body || !this.bodyGain || !this.voice || !this.dry || !this.wet || !this.filter || !this.lfoGain || !this.master) {
      return;
    }
    const t = this.ctx.currentTime;
    const freq = Math.min(4200, Math.max(48, opts.freq));

    if (!this.primed) {
      this.primed = true;
      this.osc.frequency.setValueAtTime(freq, t);
      this.body.frequency.setValueAtTime(Math.min(8400, freq * 2), t);
    } else {
      this.osc.frequency.setTargetAtTime(freq, t, 0.042);
      this.body.frequency.setTargetAtTime(Math.min(8400, freq * 2), t, 0.042);
    }

    if (opts.waveform !== this.waveform) {
      this.waveform = opts.waveform;
      this.osc.type = opts.waveform;
    }

    const shaped = Math.pow(Math.min(1, Math.max(0, opts.volume)), 1.4);
    const amp = shaped * 0.3 * WAVE_GAIN[opts.waveform];
    this.voice.gain.setTargetAtTime(amp, t, amp === 0 ? 0.085 : 0.03);
    this.bodyGain.gain.setTargetAtTime(HARM_GAIN[opts.waveform], t, 0.05);

    const wetAmt = Math.min(1, Math.max(0, opts.reverb));
    this.wet.gain.setTargetAtTime(wetAmt * 0.9, t, 0.08);
    this.dry.gain.setTargetAtTime(1 - wetAmt * 0.32, t, 0.08);
    this.master.gain.setTargetAtTime(opts.muted ? 0 : 1, t, opts.muted ? 0.02 : 0.04);

    const cents = Math.min(18, Math.max(0, opts.vibratoCents));
    this.lfoGain.gain.setTargetAtTime(cents, t, 0.05);

    const brightMul = opts.waveform === "sine" ? 6.2 : opts.waveform === "triangle" ? 4.6 : 3;
    const cutoff = Math.min(9800, Math.max(360, freq * brightMul + shaped * 2000));
    this.filter.frequency.setTargetAtTime(cutoff, t, 0.06);
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.osc?.stop();
    } catch {
      /* already stopped */
    }
    try {
      this.body?.stop();
    } catch {
      /* already stopped */
    }
    try {
      this.lfo?.stop();
    } catch {
      /* already stopped */
    }
    void this.ctx?.close();
    this.ctx = null;
  }
}
