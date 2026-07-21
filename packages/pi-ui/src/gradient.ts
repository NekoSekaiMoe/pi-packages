/** Truecolor helpers shared by the input frame and working shimmer. */

export type Rgb = readonly [number, number, number];

export const RESET_FG = "\x1b[39m";

/** Pink-to-cyan ramp used by the reference input frame. */
export const FRAME_STOPS: readonly Rgb[] = [
  [247, 182, 213],
  [207, 190, 235],
  [169, 220, 244],
];

/** Moving Codex-style shimmer: white -> cyan -> green -> white. */
export const WORKING_STOPS: readonly Rgb[] = [
  [248, 250, 252],
  [103, 232, 249],
  [34, 197, 94],
  [248, 250, 252],
];

export function fgRgb(text: string, [r, g, b]: Rgb): string {
  return `\x1b[38;2;${r};${g};${b}m${text}${RESET_FG}`;
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

export function sampleGradient(stops: readonly Rgb[], t: number): Rgb {
  if (stops.length === 0) return [0, 0, 0];
  if (stops.length === 1) return stops[0]!;

  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (stops.length - 1);
  const index = Math.min(Math.floor(scaled), stops.length - 2);
  const local = scaled - index;
  const [r1, g1, b1] = stops[index]!;
  const [r2, g2, b2] = stops[index + 1]!;
  return [lerp(r1, r2, local), lerp(g1, g2, local), lerp(b1, b2, local)];
}

/** Apply a per-character gradient. `phase` rotates an animated ramp. */
export function gradientText(text: string, stops: readonly Rgb[], phase = 0): string {
  const chars = [...text];
  const visibleCount = chars.filter((char) => char.trim().length > 0).length;
  if (visibleCount === 0) return text;

  const normalizedPhase = ((phase % 1) + 1) % 1;
  let visibleIndex = 0;
  let output = "";

  for (const char of chars) {
    if (char.trim().length === 0) {
      output += char;
      continue;
    }

    const position = visibleCount === 1 ? 0 : visibleIndex / (visibleCount - 1);
    const shifted = normalizedPhase === 0 ? position : (position + normalizedPhase) % 1;
    output += fgRgb(char, sampleGradient(stops, shifted));
    visibleIndex++;
  }

  return output;
}
