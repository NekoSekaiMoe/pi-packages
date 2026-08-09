/**
 * omp-style working shimmer: a cosine "classic" band sweeps left -> right at a
 * fixed velocity over theme colors (dim -> muted -> accent, bold at the crest).
 * Ported from ref/packages/coding-agent/src/modes/theme/shimmer.ts, trimmed to
 * the classic sweep and Pi's Theme API.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

/** Band travel speed in cells per second (fixed velocity, length-independent). */
const SHIMMER_SPEED_CELLS_PER_S = 30;
const CLASSIC_PADDING = 10;
const CLASSIC_BAND_HALF_WIDTH = 6;

const TIER_HIGH = 0.65;
const TIER_MID = 0.22;

const FG_RESET = "\x1b[39m";
const BOLD_OPEN = "\x1b[1m";
const BOLD_CLOSE = "\x1b[22m";

/** Three-tier color stack a character cycles through as the band sweeps. */
export interface ShimmerPalette {
  low: ThemeColor;
  mid: ThemeColor;
  high: ThemeColor;
  /** Bold the crest tier. */
  bold?: boolean;
}

/** One run of text sharing a palette inside a larger sweep. */
export interface ShimmerSegment {
  text: string;
  palette?: ShimmerPalette;
}

/** Working-message label: theme accent crest, bolded. */
export const MAIN_SHIMMER_PALETTE: ShimmerPalette = {
  low: "dim",
  mid: "muted",
  high: "accent",
  bold: true,
};

/** Trailing hint (elapsed · esc): quieter crest, no bold. */
export const HINT_SHIMMER_PALETTE: ShimmerPalette = {
  low: "dim",
  mid: "muted",
  high: "borderAccent",
};

type Tier = "low" | "mid" | "high";
type TierSeq = { open: string; close: string };
type CompiledPalette = Record<Tier, TierSeq>;

// Compiled ANSI pairs cached per palette, invalidated when the Theme instance
// changes (palettes are module constants, so a single-slot cache is enough).
const compiledCache = new WeakMap<ShimmerPalette, { theme: Theme; compiled: CompiledPalette }>();

function compile(theme: Theme, palette: ShimmerPalette): CompiledPalette {
  const cached = compiledCache.get(palette);
  if (cached && cached.theme === theme) return cached.compiled;
  const highColorOpen = theme.getFgAnsi(palette.high);
  const compiled: CompiledPalette = {
    low: { open: theme.getFgAnsi(palette.low), close: FG_RESET },
    mid: { open: theme.getFgAnsi(palette.mid), close: FG_RESET },
    high: palette.bold
      ? { open: `${BOLD_OPEN}${highColorOpen}`, close: `${BOLD_CLOSE}${FG_RESET}` }
      : { open: highColorOpen, close: FG_RESET },
  };
  compiledCache.set(palette, { theme, compiled });
  return compiled;
}

/** Smooth cosine bump sweeping left -> right with edge padding. */
function classicIntensity(time: number, index: number, length: number): number {
  const period = length + CLASSIC_PADDING * 2;
  const pos = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % period;
  const dist = Math.abs(index + CLASSIC_PADDING - pos);
  if (dist >= CLASSIC_BAND_HALF_WIDTH) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * dist) / CLASSIC_BAND_HALF_WIDTH));
}

function tierFor(intensity: number): Tier {
  if (intensity >= TIER_HIGH) return "high";
  if (intensity >= TIER_MID) return "mid";
  return "low";
}

function countCodePoints(text: string): number {
  let count = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < text.length ? 2 : 1;
    count++;
  }
  return count;
}

/**
 * Apply the shimmer sweep across one or more segments, treating them as a
 * single continuous string for band positioning. Same-tier runs are coalesced
 * so each frame emits a handful of escape sequences, not one per code point.
 */
export function shimmerSegments(segments: readonly ShimmerSegment[], theme: Theme): string {
  let total = 0;
  const perSeg: { text: string; palette: ShimmerPalette }[] = [];
  for (const seg of segments) {
    total += countCodePoints(seg.text);
    perSeg.push({ text: seg.text, palette: seg.palette ?? MAIN_SHIMMER_PALETTE });
  }
  if (total === 0) return "";

  const time = Date.now();

  // Fast-path window: outside [bandLo, bandHi] the intensity is guaranteed
  // zero (tier "low"), so the per-char intensity call is skipped there.
  const period = total + CLASSIC_PADDING * 2;
  const pos = ((time / 1000) * SHIMMER_SPEED_CELLS_PER_S) % period;
  const bandLo = pos - CLASSIC_PADDING - CLASSIC_BAND_HALF_WIDTH;
  const bandHi = pos - CLASSIC_PADDING + CLASSIC_BAND_HALF_WIDTH;

  let out = "";
  let index = 0;
  for (const { text, palette } of perSeg) {
    const compiled = compile(theme, palette);
    let runTier: Tier | null = null;
    let runStart = 0;
    let runEnd = 0;
    let i = 0;
    while (i < text.length) {
      // Keep surrogate pairs atomic; band position is measured in code points.
      const c = text.charCodeAt(i);
      const step = c >= 0xd800 && c <= 0xdbff && i + 1 < text.length ? 2 : 1;
      const tier: Tier = index < bandLo || index > bandHi ? "low" : tierFor(classicIntensity(time, index, total));
      if (tier !== runTier) {
        if (runTier !== null && runEnd > runStart) {
          const seq = compiled[runTier];
          out += `${seq.open}${text.slice(runStart, runEnd)}${seq.close}`;
        }
        runTier = tier;
        runStart = i;
      }
      runEnd = i + step;
      index++;
      i += step;
    }
    if (runTier !== null && runEnd > runStart) {
      const seq = compiled[runTier];
      out += `${seq.open}${text.slice(runStart, runEnd)}${seq.close}`;
    }
  }
  return out;
}

export function shimmerText(text: string, theme: Theme, palette?: ShimmerPalette): string {
  return shimmerSegments([{ text, palette }], theme);
}
