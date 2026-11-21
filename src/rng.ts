/**
 * A small seeded random generator (sfc32), so the same time slot paints the
 * same piece. `Math.random` is never used.
 */
export type Rng = () => number;

/** Mixes a slot seed and a name into 32 bits (so two interludes of one slot differ). */
export function hashSeed(seed: number, salt: string): number {
  let h = 0x811c9dc5 ^ (Math.floor(seed) | 0);
  h = Math.imul(h ^ Math.floor(seed / 2 ** 32), 0x01000193);
  for (let i = 0; i < salt.length; i++) h = Math.imul(h ^ salt.charCodeAt(i), 0x01000193);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

export function rng(seed: number): Rng {
  let a = seed >>> 0;
  let b = 0x9e3779b9;
  let c = 0x243f6a88;
  let d = 1;
  const next = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 15; i++) next();
  return next;
}

export const pick = <T>(r: Rng, items: readonly T[]): T => items[Math.floor(r() * items.length)]!;
export const between = (r: Rng, lo: number, hi: number) => lo + (hi - lo) * r();
