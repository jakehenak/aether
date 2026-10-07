import {
  MAX_MIDI,
  MIN_MIDI,
  RANGE,
  SCALE_STRIP_PX,
  describeX,
  isAccidental,
  noteName,
} from "@/lib/pitch";

export type TrailPoint = { x: number; y: number; life: number };

export type HandVisual = {
  x: number;
  y: number;
  vol: number;
  over: boolean;
  audible: boolean;
  trail: TrailPoint[];
};

export type FieldVisual = {
  hands: HandVisual[];
  /** Last pitch when every finger has lifted, so the scale keeps its mark. */
  focusX: number | null;
  muted: boolean;
  reduceMotion: boolean;
};

type Palette = {
  field: string;
  brass: string;
  ivory: string;
  muted: string;
  line: string;
};

function withAlpha(color: string, a: number): string {
  const c = color.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(c);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const pct = Math.round(Math.min(1, Math.max(0, a)) * 100);
  return `color-mix(in srgb, ${c} ${pct}%, transparent)`;
}

function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    field: pick("--color-field", "#100e0c"),
    brass: pick("--color-brass", "#e0a04a"),
    ivory: pick("--color-fg", "#f4efe6"),
    muted: pick("--color-muted", "#b7ad9f"),
    line: pick("--color-line", "#3d362c"),
  };
}

export function drawField(canvas: HTMLCanvasElement, visual: FieldVisual): void {
  const parent = canvas.parentElement;
  if (!parent) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = parent.clientWidth;
  const h = parent.clientHeight;
  if (w < 2 || h < 2) return;

  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const palette = readPalette();
  const font = getComputedStyle(document.body).fontFamily || "Outfit, sans-serif";

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = palette.field;
  ctx.fillRect(0, 0, w, h);

  const strip = Math.min(SCALE_STRIP_PX, h * 0.34);
  const stripTop = h - strip;

  for (let midi = MIN_MIDI; midi < MAX_MIDI; midi += 12) {
    const band = (midi - MIN_MIDI) / 12;
    if (band % 2 !== 0) continue;
    const x0 = ((midi - MIN_MIDI) / RANGE) * w;
    const x1 = ((Math.min(MAX_MIDI, midi + 12) - MIN_MIDI) / RANGE) * w;
    ctx.fillStyle = withAlpha(palette.ivory, 0.028);
    ctx.fillRect(x0, 0, x1 - x0, stripTop);
  }

  const wash = ctx.createLinearGradient(0, 0, 0, stripTop);
  wash.addColorStop(0, withAlpha(palette.brass, 0.14));
  wash.addColorStop(0.45, withAlpha(palette.brass, 0.04));
  wash.addColorStop(1, withAlpha(palette.brass, 0));
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, w, stripTop);

  ctx.save();
  ctx.setLineDash([2, 8]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = withAlpha(palette.muted, 0.35);
  for (const frac of [0.28, 0.56, 0.82]) {
    const y = Math.round(stripTop * frac) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.restore();

  const overHands = visual.hands.filter((hand) => hand.over);
  const markXs = overHands.length > 0 ? overHands.map((hand) => hand.x) : visual.focusX == null ? [] : [visual.focusX];
  const markMidis = new Set(markXs.map((x) => describeX(x).midi));
  const colW = w / RANGE;

  for (let midi = MIN_MIDI; midi <= MAX_MIDI; midi++) {
    const x = Math.round(((midi - MIN_MIDI) / RANGE) * w) + 0.5;
    const accidental = isAccidental(midi);
    const isC = midi % 12 === 0;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, stripTop);
    ctx.strokeStyle = isC ? withAlpha(palette.ivory, 0.22) : withAlpha(palette.line, accidental ? 0.45 : 0.9);
    ctx.lineWidth = isC ? 1.25 : 1;
    ctx.stroke();
  }

  for (const midi of markMidis) {
    const colX = ((midi - MIN_MIDI) / RANGE) * w - colW / 2;
    const inTune = overHands.some((hand) => {
      const pitch = describeX(hand.x);
      return pitch.midi === midi && pitch.inTune && hand.audible;
    });
    ctx.fillStyle = withAlpha(palette.brass, inTune ? 0.18 : 0.09);
    ctx.fillRect(colX, 0, colW, h);
  }

  ctx.fillStyle = withAlpha(palette.ivory, 0.045);
  ctx.fillRect(0, stripTop, w, strip);

  ctx.strokeStyle = withAlpha(palette.brass, 0.7);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, stripTop + 0.5);
  ctx.lineTo(w, stripTop + 0.5);
  ctx.stroke();

  const wide = w >= 680;
  const fontSize = w < 480 ? 11 : 13;
  ctx.font = `500 ${fontSize}px ${font}`;
  ctx.textBaseline = "middle";

  for (let midi = MIN_MIDI; midi <= MAX_MIDI; midi++) {
    const accidental = isAccidental(midi);
    const isC = midi % 12 === 0;
    const x = ((midi - MIN_MIDI) / RANGE) * w;
    const active = markMidis.has(midi);
    const tickTop = accidental ? stripTop + 26 : isC ? stripTop - 12 : stripTop + 10;
    const tickBottom = stripTop + 34;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, tickTop);
    ctx.lineTo(Math.round(x) + 0.5, tickBottom);
    ctx.strokeStyle = active ? palette.brass : accidental ? withAlpha(palette.brass, 0.55) : withAlpha(palette.ivory, isC ? 0.8 : 0.45);
    ctx.lineWidth = active ? 2 : 1;
    ctx.stroke();

    const labelThis = isC || (wide && !accidental);
    if (!labelThis) continue;
    const label = isC || !wide ? noteName(midi) : noteName(midi).replace(/[0-9]/g, "");
    let tx = x;
    ctx.textAlign = "center";
    if (tx < 16) {
      ctx.textAlign = "left";
      tx = 8;
    } else if (tx > w - 16) {
      ctx.textAlign = "right";
      tx = w - 8;
    }
    ctx.fillStyle = active ? palette.brass : withAlpha(palette.ivory, isC ? 0.92 : 0.62);
    ctx.fillText(label, tx, h - 16);
  }

  if (overHands.length === 0) return;

  const crowd = Math.min(1, (overHands.length - 1) / 9);

  for (let index = 0; index < overHands.length; index++) {
    const hand = overHands[index];
    const lead = index === overHands.length - 1;
    const px = hand.x * w;
    const py = Math.min(hand.y * h, h - 8);

    if (!visual.reduceMotion) {
      for (const point of hand.trail) {
        ctx.fillStyle = withAlpha(palette.brass, 0.16 * point.life);
        ctx.beginPath();
        ctx.arc(point.x * w, Math.min(point.y * h, h - 8), 5 * point.life, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.strokeStyle = withAlpha(palette.brass, hand.audible ? (lead ? 0.45 : 0.28) : 0.18);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(px) + 0.5, 0);
    ctx.lineTo(Math.round(px) + 0.5, stripTop);
    ctx.stroke();

    if (lead && py < stripTop) {
      ctx.strokeStyle = withAlpha(palette.brass, 0.28);
      ctx.beginPath();
      ctx.moveTo(0, Math.round(py) + 0.5);
      ctx.lineTo(w, Math.round(py) + 0.5);
      ctx.stroke();
    }

    const glowR = (16 + hand.vol * 54) * (1 - crowd * 0.45);
    const glow = ctx.createRadialGradient(px, py, 0, px, py, glowR);
    const glowStrength = visual.muted ? 0.1 : hand.audible ? (lead ? 0.42 : 0.28) : 0.18;
    glow.addColorStop(0, withAlpha(palette.brass, glowStrength));
    glow.addColorStop(1, withAlpha(palette.brass, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(px, py, glowR, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = visual.muted ? withAlpha(palette.brass, 0.45) : palette.brass;
    ctx.beginPath();
    ctx.arc(px, py, lead ? 6 : 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = withAlpha(palette.ivory, lead ? 0.85 : 0.55);
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.arc(px, py, (lead ? 11 : 9) + hand.vol * (lead ? 6 : 4), 0, Math.PI * 2);
    ctx.stroke();
  }
}
