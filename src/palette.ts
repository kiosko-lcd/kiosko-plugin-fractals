/**
 * Colours from the panel's theme: a looping gradient through a few of the
 * theme's own colours (its accent always among them), the background the
 * fractal is developed on, and the ink it burns to where it is densest
 * (light on dark themes, dark on `paper`).
 */
import type { Theme } from '@kiosko/sdk';
import { type Rng } from './rng.ts';

export type Rgb = [number, number, number];

export function parseHex(hex: string): Rgb {
  const h = hex.trim().replace(/^#/, '');
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h.slice(0, 6);
  const n = Number.parseInt(full, 16);
  if (!Number.isFinite(n)) return [128, 128, 128];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const luma = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const distance = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export interface Palette {
  bg: Rgb;
  ink: Rgb;
  /** Light background (`paper`): the fractal is ink on it instead of light. */
  light: boolean;
  /** `SIZE` colours, r g b in 0–255, looping (the last runs into the first). */
  lut: Float32Array;
  /** The theme colours it runs through, for tests and logs. */
  stops: Rgb[];
}

export const SIZE = 1024;

/**
 * A different selection and order of the theme's colours for each seed. On a
 * light background colours are deepened a little so thin filaments still
 * read against it; on a dark one they are kept as they are.
 */
export function themePalette(theme: Theme, r: Rng, count = 3): Palette {
  const c = theme.colors;
  const bg = parseHex(c.bg);
  const ink = parseHex(c.ink);
  const light = luma(bg) > 128;
  const pool: Rgb[] = [];
  for (const hex of [c.info, c.ok, c.warn, c.alert, c.inkDim]) {
    const rgb = parseHex(hex);
    // Close to the background, or to one already taken: it adds nothing.
    if (distance(rgb, bg) < 60) continue;
    if (pool.some((p) => distance(p, rgb) < 40)) continue;
    pool.push(rgb);
  }
  const accent = parseHex(c.accent);
  const stops: Rgb[] = [accent];
  const rest = pool.filter((p) => distance(p, accent) >= 40);
  while (stops.length < count && rest.length) stops.push(rest.splice(Math.floor(r() * rest.length), 1)[0]!);
  while (stops.length < 2) stops.push(mix(accent, ink, 0.5));
  // A darker turn of the accent between the bright ones gives the flame depth.
  const deep = light ? mix(accent, ink, 0.45) : mix(accent, bg, 0.45);
  stops.splice(1 + Math.floor(r() * (stops.length - 1)), 0, deep);
  const tuned = light ? stops.map((s) => mix(s, [0, 0, 0], 0.12)) : stops;
  const lut = new Float32Array(SIZE * 3);
  for (let i = 0; i < SIZE; i++) {
    const t = (i / SIZE) * tuned.length;
    const k = Math.floor(t);
    const f = t - k;
    const s = f * f * (3 - 2 * f);
    const a = tuned[k % tuned.length]!;
    const b = tuned[(k + 1) % tuned.length]!;
    lut[i * 3] = a[0] + (b[0] - a[0]) * s;
    lut[i * 3 + 1] = a[1] + (b[1] - a[1]) * s;
    lut[i * 3 + 2] = a[2] + (b[2] - a[2]) * s;
  }
  return { bg, ink, light, lut, stops };
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
