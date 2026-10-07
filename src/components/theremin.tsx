import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { drawField, type TrailPoint } from "@/components/draw-field";
import {
  clamp01,
  describeX,
  pointerToVol,
  tunePhrase,
} from "@/lib/pitch";
import { ThereminEngine, WAVE_NAMES, type WaveName } from "@/lib/theremin-audio";

const STORAGE_KEY = "aether-theremin";

const WAVE_LABEL: Record<WaveName, string> = {
  sine: "Sine",
  triangle: "Triangle",
  sawtooth: "Saw",
  square: "Square",
};

const WAVE_PATH: Record<WaveName, string> = {
  sine: "M2 12 C6 12 6 4 10 4 C14 4 14 20 18 20 C22 20 22 12 30 12",
  triangle: "M2 14 L8 6 L16 18 L24 6 L30 14",
  sawtooth: "M2 16 L12 6 L12 16 L22 6 L22 16 L30 8",
  square: "M2 16 V8 H12 V16 H22 V8 H30",
};

type PointerState = {
  x: number;
  y: number;
  vol: number;
  over: boolean;
  seen: boolean;
  touching: boolean;
  pointerType: string;
  slowX: number;
  vibrato: number;
  trail: TrailPoint[];
};

type Readout = {
  note: string;
  hz: string;
  tune: string;
  cents: number;
  inTune: boolean;
  volPct: number;
  status: string;
  live: boolean;
  seen: boolean;
};

type Settings = {
  wave: WaveName;
  reverb: number;
  muted: boolean;
  armed: boolean;
};

const IDLE: Readout = {
  note: "—",
  hz: "—",
  tune: "Move in the field",
  cents: 0,
  inTune: false,
  volPct: 0,
  status: "Tap to start",
  live: false,
  seen: false,
};

function isWave(value: unknown): value is WaveName {
  return typeof value === "string" && (WAVE_NAMES as readonly string[]).includes(value);
}

function WaveIcon({ wave }: { wave: WaveName }) {
  return (
    <svg viewBox="0 0 32 24" className="h-4 w-8" aria-hidden="true">
      <path
        d={WAVE_PATH[wave]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Theremin() {
  const fieldRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<ThereminEngine | null>(null);
  const reduceMotion = useRef(false);
  const vibSent = useRef(0);
  const shown = useRef("");
  const skipSave = useRef(true);
  const blockMouseUntil = useRef(0);
  const pointer = useRef<PointerState>({
    x: 0.5,
    y: 0.45,
    vol: 0.5,
    over: false,
    seen: false,
    touching: false,
    pointerType: "mouse",
    slowX: 0.5,
    vibrato: 0,
    trail: [],
  });
  const settings = useRef<Settings>({
    wave: "sine",
    reverb: 0.36,
    muted: false,
    armed: false,
  });
  const pushRef = useRef<() => void>(() => {});

  const [wave, setWave] = useState<WaveName>("sine");
  const [reverb, setReverb] = useState(0.36);
  const [muted, setMuted] = useState(false);
  const [armed, setArmed] = useState(false);
  const [readout, setReadout] = useState<Readout>(IDLE);

  settings.current = { wave, reverb, muted, armed };

  pushRef.current = () => {
    const engine = engineRef.current;
    if (!engine) return;
    const p = pointer.current;
    const s = settings.current;
    const audible = isAudible(p, s);
    engine.setPerformance({
      freq: describeX(p.x).freq,
      volume: audible ? p.vol : 0,
      waveform: s.wave,
      reverb: s.reverb,
      muted: s.muted,
      vibratoCents: audible ? p.vibrato : 0,
    });
  };

  useEffect(() => {
    reduceMotion.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { wave?: unknown; reverb?: unknown };
        if (isWave(parsed.wave)) setWave(parsed.wave);
        if (typeof parsed.reverb === "number" && Number.isFinite(parsed.reverb)) {
          setReverb(clamp01(parsed.reverb));
        }
      }
    } catch {
      /* ignore broken storage */
    }
  }, []);

  useEffect(() => {
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ wave, reverb }));
  }, [wave, reverb]);

  useEffect(() => {
    pushRef.current();
  }, [wave, reverb, muted, armed]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "m" || event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      setMuted((value) => !value);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const p = pointer.current;
      const s = settings.current;
      const tracking = p.seen && p.over && (p.pointerType === "mouse" || p.touching);

      if (tracking) {
        const follow = 1 - Math.exp(-dt * 18);
        p.slowX += (p.x - p.slowX) * follow;
        const wobble = Math.abs(p.x - p.slowX) * 36;
        const target = Math.min(16, Math.max(0, (wobble - 0.02) * 58));
        p.vibrato += (target - p.vibrato) * (1 - Math.exp(-dt * 10));
      } else {
        p.vibrato *= Math.exp(-dt * 8);
      }

      if (Math.abs(p.vibrato - vibSent.current) > 0.55) {
        vibSent.current = p.vibrato;
        pushRef.current();
      }

      for (const point of p.trail) point.life *= Math.exp(-dt * 3.4);
      if (p.trail.length > 0 && p.trail.some((point) => point.life <= 0.05)) {
        p.trail = p.trail.filter((point) => point.life > 0.05);
      }

      const canvas = canvasRef.current;
      if (canvas) {
        const audible = isAudible(p, s);
        drawField(canvas, {
          x: p.x,
          y: p.y,
          vol: p.vol,
          over: p.over,
          seen: p.seen,
          audible,
          muted: s.muted,
          reduceMotion: reduceMotion.current,
          trail: p.trail,
        });
      }

      const next = snapshot(p, s);
      const key = `${next.note}|${next.hz}|${next.cents}|${next.volPct}|${next.status}|${next.live}|${next.seen}`;
      if (key !== shown.current) {
        shown.current = key;
        setReadout(next);
      }

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    const onVis = () => {
      if (document.visibilityState === "visible") engineRef.current?.ensure();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVis);
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  const ghostMouse = (event: { pointerType: string }) =>
    event.pointerType === "mouse" && performance.now() < blockMouseUntil.current;

  const applyEvent = (event: ReactPointerEvent<HTMLDivElement>, entered: boolean) => {
    if (ghostMouse(event)) return;
    if (event.pointerType !== "mouse") blockMouseUntil.current = performance.now() + 800;
    const rect = event.currentTarget.getBoundingClientRect();
    const inside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    const p = pointer.current;
    if (!inside) {
      p.over = false;
      pushRef.current();
      return;
    }
    const x = clamp01((event.clientX - rect.left) / rect.width);
    const y = clamp01((event.clientY - rect.top) / rect.height);
    if (!p.over || entered) {
      p.slowX = x;
      p.vibrato = 0;
    }
    p.over = true;
    p.seen = true;
    p.x = x;
    p.y = y;
    p.vol = pointerToVol(y, rect.height);
    p.pointerType = event.pointerType || p.pointerType;
    if (!reduceMotion.current) {
      const lastPoint = p.trail[p.trail.length - 1];
      if (!lastPoint || Math.hypot(lastPoint.x - x, lastPoint.y - y) > 0.006) {
        p.trail.push({ x, y, life: 1 });
        if (p.trail.length > 18) p.trail.shift();
      }
    }
    pushRef.current();
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (ghostMouse(event)) return;
    if (event.pointerType !== "mouse") {
      blockMouseUntil.current = performance.now() + 800;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    engineRef.current ??= new ThereminEngine();
    engineRef.current.ensure();
    pointer.current.touching = true;
    pointer.current.pointerType = event.pointerType;
    settings.current.armed = true;
    setArmed(true);
    applyEvent(event, true);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (ghostMouse(event)) return;
    pointer.current.touching = false;
    applyEvent(event, false);
  };

  const noteClass = !readout.seen ? "text-muted" : readout.live && readout.inTune ? "text-brass" : "text-fg";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl font-medium leading-none text-balance italic sm:text-5xl">Aether</h1>
          <p className="mt-2 max-w-md text-sm text-pretty text-muted">
            Drag across for pitch. Higher in the field is louder.
          </p>
        </div>
        <p className="shrink-0 text-xs uppercase tracking-widest text-brass">Theremin</p>
      </header>

      <section className="flex items-end justify-between gap-4">
        <div>
          <p className={`font-display text-5xl font-medium leading-none tabular-nums italic sm:text-7xl ${noteClass}`} aria-live="polite">{readout.note}</p>
          <p className="mt-2 text-sm tabular-nums text-muted">
            <span className={readout.seen ? "text-fg" : "text-muted"}>{readout.hz}</span>
            <span> Hz</span>
            <span className="px-2">·</span>
            <span className={readout.seen && readout.inTune ? "text-brass" : "text-muted"}>{readout.tune}</span>
          </p>
          <div className="relative mt-3 h-3 w-40" aria-hidden="true">
            <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line" />
            <div className="absolute top-1/2 left-1/2 h-2 w-px -translate-y-1/2 bg-muted" />
            <div
              className={`absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${readout.seen ? "bg-brass" : "bg-line"}`}
              style={{ left: `${readout.cents + 50}%` }}
            />
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 pb-1">
          <p className="flex items-center gap-2 text-sm">
            <span className={readout.live ? "live-dot size-2 rounded-full bg-brass" : "size-2 rounded-full bg-line"} />
            <span className={readout.live ? "text-brass" : "text-muted"}>{readout.status}</span>
          </p>
          <p className="text-xs text-muted">C3 – C6</p>
        </div>
      </section>

      <section className="flex min-h-64 flex-1 flex-col gap-2">
        <div className="flex min-h-64 flex-1 gap-3">
          <div className="flex w-14 shrink-0 flex-col items-center gap-2 py-1">
            <span className="text-xs text-muted">Loud</span>
            <div
              className={`relative w-2 flex-1 rounded-full bg-line ${muted ? "opacity-40" : ""}`}
              role="meter"
              aria-label="Volume"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={readout.volPct}
            >
              <div className="absolute inset-x-0 bottom-0 rounded-full bg-brass" style={{ height: `${readout.volPct}%` }} />
            </div>
            <span className="text-xs text-muted">Quiet</span>
          </div>

          <div
            ref={fieldRef}
            className="play-field relative min-w-0 flex-1 cursor-crosshair overflow-hidden rounded-2xl border border-line bg-field"
            role="application"
            aria-label="Theremin field. Horizontal position sets pitch from C3 to C6. Higher is louder. The note scale at the bottom is silent."
            onPointerDown={onPointerDown}
            onPointerMove={(event) => applyEvent(event, false)}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerEnter={(event) => {
              if (ghostMouse(event)) return;
              if (event.pointerType === "mouse") applyEvent(event, true);
            }}
            onPointerLeave={(event) => {
              if (ghostMouse(event)) return;
              if (pointer.current.touching && event.pointerType !== "mouse") return;
              pointer.current.over = false;
              pushRef.current();
            }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" aria-hidden="true" />
            {!armed && (
              <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-3">
                <p className="rounded-full border border-line bg-surface px-4 py-2 text-sm">Tap or click to start the sound</p>
              </div>
            )}
          </div>
        </div>
        <div className="flex gap-3 text-xs text-muted">
          <div className="w-14 shrink-0" />
          <div className="flex flex-1 justify-between">
            <span>Low pitch</span>
            <span>High pitch</span>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div role="radiogroup" aria-label="Waveform" className="grid grid-cols-4 gap-2 lg:min-w-80">
          {WAVE_NAMES.map((name) => {
            const selected = wave === name;
            return (
              <button
                key={name}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={WAVE_LABEL[name] === "Saw" ? "Sawtooth wave" : `${WAVE_LABEL[name]} wave`}
                onClick={() => setWave(name)}
                className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl border px-1 text-xs transition-colors ${
                  selected
                    ? "border-brass bg-brass text-ink"
                    : "border-line bg-surface text-muted hover:border-brass hover:text-fg"
                }`}
              >
                <WaveIcon wave={name} />
                <span>{WAVE_LABEL[name]}</span>
              </button>
            );
          })}
        </div>

        <label className="flex min-h-11 flex-1 items-center gap-3">
          <span className="w-16 shrink-0 text-sm text-muted">Reverb</span>
          <input
            className="reverb-slider"
            style={{ caretColor: "transparent" }}
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(reverb * 100)}
            aria-valuetext={`${Math.round(reverb * 100)} percent`}
            onChange={(event) => setReverb(clamp01(Number(event.target.value) / 100))}
          />
          <span className="w-12 text-right text-sm tabular-nums">{Math.round(reverb * 100)}%</span>
        </label>

        <button
          type="button"
          aria-pressed={muted}
          title="Mute (M)"
          onClick={() => setMuted((value) => !value)}
          className={`inline-flex min-h-14 items-center justify-center gap-2 rounded-full border px-5 text-sm transition-colors ${
            muted ? "border-brass bg-brass text-ink" : "border-line bg-surface text-fg hover:border-brass"
          }`}
        >
          {muted ? <VolumeX className="size-5" aria-hidden="true" /> : <Volume2 className="size-5" aria-hidden="true" />}
          <span>{muted ? "Muted" : "Mute"}</span>
          <span className="hidden text-xs opacity-70 sm:inline">M</span>
        </button>
      </section>
    </main>
  );
}

function isAudible(p: PointerState, s: Settings): boolean {
  return s.armed && p.over && !s.muted && p.vol > 0.004 && (p.pointerType === "mouse" || p.touching);
}

function snapshot(p: PointerState, s: Settings): Readout {
  if (!p.seen) return IDLE;
  const pitch = describeX(p.x);
  const audible = isAudible(p, s);
  const status = !s.armed ? "Tap to start" : s.muted ? "Muted" : audible ? "Live" : "Silent";
  return {
    note: pitch.name,
    hz: String(Math.round(pitch.freq)),
    tune: tunePhrase(pitch.cents),
    cents: pitch.cents,
    inTune: pitch.inTune,
    volPct: Math.round((p.over ? p.vol : 0) * 100),
    status,
    live: audible,
    seen: true,
  };
}
