import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { drawField, type HandVisual, type TrailPoint } from "@/components/draw-field";
import {
  clamp01,
  describeX,
  pointerToVol,
  tunePhrase,
} from "@/lib/pitch";
import { MAX_VOICES, ThereminEngine, WAVE_NAMES, type WaveName } from "@/lib/theremin-audio";

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

type Finger = {
  id: number;
  x: number;
  y: number;
  vol: number;
  over: boolean;
  touching: boolean;
  pointerType: string;
  slowX: number;
  vibrato: number;
  trail: TrailPoint[];
  order: number;
  latched: boolean;
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
  fingers: number;
  notes: string[];
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
  fingers: 0,
  notes: [],
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
  const shown = useRef("");
  const skipSave = useRef(true);
  const blockMouseUntil = useRef(0);
  const orderRef = useRef(0);
  const leadId = useRef<number | null>(null);
  const focusX = useRef<number | null>(null);
  const fingers = useRef<Map<number, Finger>>(new Map());
  const firstGesture = useRef(true);
  const armReveal = useRef<number | null>(null);
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

  settings.current = { wave, reverb, muted, armed: armed || settings.current.armed };

  pushRef.current = () => {
    const engine = engineRef.current;
    if (!engine) return;
    const s = settings.current;
    engine.setFingers(
      [...fingers.current.values()].filter(occupiesSlot).map((finger) => {
        const audible = isAudible(finger, s);
        return {
          id: finger.id,
          freq: describeX(finger.x).freq,
          volume: audible ? finger.vol : 0,
          vibratoCents: audible ? finger.vibrato : 0,
        };
      }),
      { waveform: s.wave, reverb: s.reverb, muted: s.muted },
    );
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
      const s = settings.current;
      let audioDirty = false;

      for (const finger of fingers.current.values()) {
        const tracking = isPlaced(finger);
        const before = finger.vibrato;
        if (tracking) {
          const follow = 1 - Math.exp(-dt * 18);
          finger.slowX += (finger.x - finger.slowX) * follow;
          const wobble = Math.abs(finger.x - finger.slowX) * 36;
          const target = Math.min(16, Math.max(0, (wobble - 0.02) * 58));
          finger.vibrato += (target - finger.vibrato) * (1 - Math.exp(-dt * 10));
        } else {
          finger.vibrato *= Math.exp(-dt * 8);
        }
        if (Math.abs(finger.vibrato - before) > 0.55) audioDirty = true;

        for (const point of finger.trail) point.life *= Math.exp(-dt * 3.4);
        if (finger.trail.some((point) => point.life <= 0.05)) {
          finger.trail = finger.trail.filter((point) => point.life > 0.05);
        }
      }

      if (audioDirty) pushRef.current();

      const canvas = canvasRef.current;
      const placed = placedFingers(fingers.current);
      if (canvas) {
        const hands: HandVisual[] = placed.map((finger) => ({
          x: finger.x,
          y: finger.y,
          vol: finger.vol,
          over: true,
          audible: isAudible(finger, s),
          trail: finger.trail,
        }));
        const lead = pickLead(fingers.current, leadId.current);
        if (lead) {
          const index = placed.indexOf(lead);
          if (index > 0) {
            const [item] = hands.splice(index, 1);
            hands.push(item);
          }
        }
        drawField(canvas, {
          hands,
          focusX: focusX.current,
          muted: s.muted,
          reduceMotion: reduceMotion.current,
        });
      }

      const next = snapshot(fingers.current, leadId.current, focusX.current, s);
      const key = `${next.note}|${next.hz}|${next.cents}|${next.volPct}|${next.status}|${next.live}|${next.seen}|${next.fingers}|${next.notes.join(",")}`;
      if (key !== shown.current) {
        shown.current = key;
        setReadout(next);
      }

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    const field = fieldRef.current;
    const unlock = () => {
      engineRef.current ??= new ThereminEngine();
      engineRef.current.ensure();
    };
    const listen: AddEventListenerOptions = { capture: true, passive: true };
    field?.addEventListener("touchstart", unlock, listen);
    field?.addEventListener("touchend", unlock, listen);
    field?.addEventListener("click", unlock, listen);
    const onVis = () => {
      if (document.visibilityState === "visible") engineRef.current?.ensure();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelAnimationFrame(raf);
      if (armReveal.current != null) window.clearTimeout(armReveal.current);
      field?.removeEventListener("touchstart", unlock, listen);
      field?.removeEventListener("touchend", unlock, listen);
      field?.removeEventListener("click", unlock, listen);
      document.removeEventListener("visibilitychange", onVis);
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  const ghostMouse = (event: { pointerType: string }) =>
    event.pointerType === "mouse" && performance.now() < blockMouseUntil.current;

  const takeFinger = (event: { pointerId: number; pointerType: string }, allowCreate: boolean): Finger | null => {
    const existing = fingers.current.get(event.pointerId);
    if (existing) {
      existing.pointerType = event.pointerType || existing.pointerType;
      return existing;
    }
    if (!allowCreate) return null;
    let used = 0;
    for (const finger of fingers.current.values()) if (occupiesSlot(finger)) used += 1;
    if (used >= MAX_VOICES) return null;
    const finger: Finger = {
      id: event.pointerId,
      x: 0.5,
      y: 0.45,
      vol: 0,
      over: false,
      touching: false,
      pointerType: event.pointerType || "mouse",
      slowX: 0.5,
      vibrato: 0,
      trail: [],
      order: ++orderRef.current,
      latched: false,
    };
    fingers.current.set(finger.id, finger);
    return finger;
  };

  const applyEvent = (event: ReactPointerEvent<HTMLDivElement>, entered: boolean, allowCreate: boolean) => {
    if (ghostMouse(event)) return;
    if (event.pointerType !== "mouse") blockMouseUntil.current = performance.now() + 800;
    const finger = takeFinger(event, allowCreate);
    if (!finger) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const inside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    if (!inside) {
      finger.over = false;
      pushRef.current();
      return;
    }
    const x = clamp01((event.clientX - rect.left) / rect.width);
    const y = clamp01((event.clientY - rect.top) / rect.height);
    if (!finger.over || entered) {
      finger.slowX = x;
      finger.vibrato = 0;
    }
    finger.over = true;
    finger.x = x;
    finger.y = y;
    finger.vol = pointerToVol(y, rect.height);
    focusX.current = x;
    leadId.current = finger.id;
    if (!reduceMotion.current) {
      const lastPoint = finger.trail[finger.trail.length - 1];
      if (!lastPoint || Math.hypot(lastPoint.x - x, lastPoint.y - y) > 0.006) {
        finger.trail.push({ x, y, life: 1 });
        if (finger.trail.length > 14) finger.trail.shift();
      }
    }
    pushRef.current();
  };

  const revealArmed = () => {
    if (armReveal.current != null) {
      window.clearTimeout(armReveal.current);
      armReveal.current = null;
    }
    setArmed(true);
  };

  const queueReveal = () => {
    if (armReveal.current != null) return;
    armReveal.current = window.setTimeout(() => {
      armReveal.current = null;
      setArmed(true);
    }, 700);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (ghostMouse(event)) return;
    if (event.pointerType !== "mouse") {
      blockMouseUntil.current = performance.now() + 800;
      for (const existing of [...fingers.current.values()]) {
        if ((existing.latched || existing.id === -1) && !existing.touching) {
          fingers.current.delete(existing.id);
          if (leadId.current === existing.id) leadId.current = null;
        }
      }
    }
    engineRef.current ??= new ThereminEngine();
    engineRef.current.ensure();
    settings.current.armed = true;
    const finger = takeFinger(event, true);
    if (!finger) return;
    finger.touching = true;
    applyEvent(event, true, false);
    if (firstGesture.current && event.pointerType !== "mouse") {
      audibleEnough(finger, event.currentTarget.getBoundingClientRect().height);
      pushRef.current();
    }
    queueReveal();
  };

  const onClick = (event: React.MouseEvent) => {
    const opening = firstGesture.current;
    engineRef.current ??= new ThereminEngine();
    engineRef.current.ensure();
    settings.current.armed = true;
    revealArmed();
    if (!opening) return;
    firstGesture.current = false;
    if ([...fingers.current.values()].some(occupiesSlot)) return;
    const field = fieldRef.current;
    if (!field) return;
    const rect = field.getBoundingClientRect();
    const x = clamp01((event.clientX - rect.left) / Math.max(1, rect.width));
    const y = clamp01((event.clientY - rect.top) / Math.max(1, rect.height));
    const finger: Finger = {
      id: -1,
      x,
      y,
      vol: pointerToVol(y, rect.height),
      over: true,
      touching: false,
      pointerType: "mouse",
      slowX: x,
      vibrato: 0,
      trail: [],
      order: ++orderRef.current,
      latched: true,
    };
    audibleEnough(finger, rect.height);
    fingers.current.set(-1, finger);
    focusX.current = x;
    leadId.current = -1;
    pushRef.current();
  };

  const releaseFinger = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (ghostMouse(event)) return;
    const finger = fingers.current.get(event.pointerId);
    if (!finger) return;
    if (finger.latched) {
      finger.touching = false;
      revealArmed();
      engineRef.current?.ensure();
      pushRef.current();
      return;
    }
    const opening = firstGesture.current;
    if (event.pointerType === "mouse") {
      finger.touching = false;
      applyEvent(event, false, false);
      if (!opening) return;
      firstGesture.current = false;
      audibleEnough(finger, fieldRef.current?.getBoundingClientRect().height ?? 1);
      settings.current.armed = true;
      revealArmed();
      engineRef.current?.ensure();
      pushRef.current();
      return;
    }
    if (opening) {
      firstGesture.current = false;
      finger.latched = true;
      finger.touching = false;
      finger.over = true;
      audibleEnough(finger, fieldRef.current?.getBoundingClientRect().height ?? 1);
      focusX.current = finger.x;
      leadId.current = finger.id;
      settings.current.armed = true;
      revealArmed();
      engineRef.current?.ensure();
      pushRef.current();
      return;
    }
    focusX.current = finger.x;
    fingers.current.delete(event.pointerId);
    if (leadId.current === event.pointerId) leadId.current = null;
    pushRef.current();
  };

  const noteClass = !readout.seen ? "text-muted" : readout.live && readout.inTune ? "text-brass" : "text-fg";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl font-medium leading-none text-balance italic sm:text-5xl">Aether</h1>
          <p className="mt-2 max-w-md text-sm text-pretty text-muted">
            Drag across for pitch. Higher is louder. Ten fingers play at once.
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
          {readout.notes.length > 1 && (
            <p className="mt-2 flex max-w-md flex-wrap gap-x-2 gap-y-1 text-xs text-brass">
              {readout.notes.map((name, index) => (
                <span key={`${name}-${index}`}>{name}</span>
              ))}
            </p>
          )}
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
          <div className="flex gap-1 py-1" aria-hidden="true">
            {Array.from({ length: MAX_VOICES }, (_, index) => (
              <span
                key={index}
                className={`size-1.5 rounded-full ${index < readout.fingers ? "bg-brass" : "bg-line"}`}
              />
            ))}
          </div>
          <p className="text-xs text-muted">{readout.fingers > 0 ? `${readout.fingers} of ${MAX_VOICES}` : "C3 \u2013 C6"}</p>
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
            aria-label="Theremin field. Up to ten fingers. Horizontal position sets pitch from C3 to C6. Higher is louder. The note scale at the bottom is silent."
            onPointerDown={onPointerDown}
            onClick={onClick}
            onPointerMove={(event) => applyEvent(event, false, event.pointerType === "mouse")}
            onPointerUp={releaseFinger}
            onPointerCancel={releaseFinger}
            onPointerEnter={(event) => {
              if (ghostMouse(event)) return;
              if (event.pointerType === "mouse") applyEvent(event, true, true);
            }}
            onPointerLeave={(event) => {
              if (ghostMouse(event)) return;
              const finger = fingers.current.get(event.pointerId);
              if (!finger || finger.latched) return;
              if (finger.touching && event.pointerType !== "mouse") return;
              focusX.current = finger.x;
              fingers.current.delete(event.pointerId);
              if (leadId.current === event.pointerId) leadId.current = null;
              pushRef.current();
            }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" aria-hidden="true" />
            {!armed && (
              <button
                type="button"
                className="absolute inset-0 z-10 flex touch-none items-start justify-center bg-transparent pt-3"
                aria-label="Start the sound"
              >
                <span className="rounded-full border border-line bg-surface px-4 py-2 text-sm text-fg">
                  Tap or click to start the sound
                </span>
              </button>
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

function audibleEnough(finger: Finger, height: number): void {
  if (finger.vol > 0.004) return;
  finger.y = 0.42;
  finger.vol = pointerToVol(0.42, height);
}

function isPlaced(finger: Finger): boolean {
  return finger.over && (finger.pointerType === "mouse" || finger.touching || finger.latched);
}

function occupiesSlot(finger: Finger): boolean {
  return finger.touching || finger.latched || (finger.pointerType === "mouse" && finger.over);
}

function isAudible(finger: Finger, settings: Settings): boolean {
  return settings.armed && isPlaced(finger) && !settings.muted && finger.vol > 0.004;
}

function placedFingers(map: Map<number, Finger>): Finger[] {
  return [...map.values()].filter(isPlaced).sort((a, b) => a.order - b.order);
}

function pickLead(map: Map<number, Finger>, lead: number | null): Finger | null {
  const current = lead != null ? map.get(lead) : undefined;
  if (current && isPlaced(current)) return current;
  const placed = placedFingers(map);
  return placed.length > 0 ? placed[placed.length - 1] : null;
}

function snapshot(map: Map<number, Finger>, lead: number | null, focus: number | null, settings: Settings): Readout {
  const placed = placedFingers(map);
  const active = pickLead(map, lead);
  const x = active ? active.x : focus;
  if (x == null) return IDLE;
  const pitch = describeX(x);
  const audible = placed.filter((finger) => isAudible(finger, settings));
  const notes: string[] = [];
  for (const finger of [...audible].sort((a, b) => a.x - b.x)) {
    const name = describeX(finger.x).name;
    if (!notes.includes(name)) notes.push(name);
  }
  const count = placed.length;
  const status = !settings.armed ? "Tap to start" : settings.muted ? "Muted" : audible.length > 1 ? `${audible.length} fingers` : audible.length === 1 ? "Live" : "Silent";
  const vol = placed.reduce((max, finger) => Math.max(max, finger.vol), 0);
  return {
    note: pitch.name,
    hz: String(Math.round(pitch.freq)),
    tune: tunePhrase(pitch.cents),
    cents: pitch.cents,
    inTune: pitch.inTune,
    volPct: Math.round(vol * 100),
    status,
    live: audible.length > 0,
    seen: true,
    fingers: count,
    notes,
  };
}
