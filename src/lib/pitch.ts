export const MIN_MIDI = 48; // C3
export const MAX_MIDI = 84; // C6
export const RANGE = MAX_MIDI - MIN_MIDI;
/** Quiet note scale along the bottom of the play field, in CSS pixels. */
export const SCALE_STRIP_PX = 64;

const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"] as const;
const SPOKEN = [
  "C",
  "C sharp",
  "D",
  "D sharp",
  "E",
  "F",
  "F sharp",
  "G",
  "G sharp",
  "A",
  "A sharp",
  "B",
] as const;

export function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function pointerToVol(y: number, height: number): number {
  const play = 1 - Math.min(0.5, SCALE_STRIP_PX / Math.max(1, height));
  if (y >= play) return 0;
  return clamp01(1 - y / Math.max(play, 0.0001));
}

export type PitchReadout = {
  name: string;
  spoken: string;
  freq: number;
  cents: number;
  midi: number;
  inTune: boolean;
};

export function describeX(x: number): PitchReadout {
  const midiFloat = MIN_MIDI + clamp01(x) * RANGE;
  const midi = Math.round(midiFloat);
  const cents = Math.round((midiFloat - midi) * 100);
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const freq = 440 * 2 ** ((midiFloat - 69) / 12);
  return {
    name: `${NAMES[pc]}${octave}`,
    spoken: `${SPOKEN[pc]} ${octave}`,
    freq,
    cents,
    midi,
    inTune: Math.abs(cents) <= 8,
  };
}

export function xToFreq(x: number): number {
  const midiFloat = MIN_MIDI + clamp01(x) * RANGE;
  return 440 * 2 ** ((midiFloat - 69) / 12);
}

export function tunePhrase(cents: number): string {
  const abs = Math.abs(cents);
  if (abs <= 8) return "in tune";
  return cents > 0 ? `${abs}¢ sharp` : `${abs}¢ flat`;
}

export function isAccidental(midi: number): boolean {
  const pc = ((midi % 12) + 12) % 12;
  return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
}

export function noteName(midi: number): string {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${NAMES[pc]}${octave}`;
}
