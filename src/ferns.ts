/**
 * A row of Barnsley ferns growing along the bar: each one the classic
 * four-map IFS drawn by the chaos game, with its own height, lean, curl and
 * colour. They grow from the stem up (points above the current height are
 * not plotted yet) and fill in with density, as the flame does.
 */
import { Density } from './density.ts';
import { between, type Rng } from './rng.ts';

/** One fern: where it stands and how it is shaped. */
export interface Fern {
  /** Foot of the stem, in pixels. */
  x: number;
  /** Height in pixels. */
  size: number;
  /** Lean (radians, + to the right) and mirror (−1 or 1). */
  lean: number;
  mirror: number;
  /** How much the fronds curl: the main map's rotation. */
  curl: number;
  /** Colour coordinate (0–1) at the foot; it drifts along the height. */
  color: number;
  /** When it starts growing, as a share of the growing time (0–1). */
  start: number;
}

/** The fern's maps (Barnsley's), as a, b, c, d, e, f with x' = a x + b y + e, y' = c x + d y + f; and their weights. */
function maps(curl: number): { m: Float64Array; cum: Float64Array } {
  const m = new Float64Array([
    0, 0, 0, 0.16, 0, 0,
    0.85, curl, -curl, 0.85, 0, 1.6,
    0.2, -0.26, 0.23, 0.22, 0, 1.6,
    -0.15, 0.28, 0.26, 0.24, 0, 0.44,
  ]);
  const cum = new Float64Array([0.01, 0.86, 0.93, 1]);
  return { m, cum };
}

/** The fern's height in its own units (it spans y = 0…≈10). */
const FERN_HEIGHT = 10;

export function plantFerns(r: Rng, width: number, height: number): Fern[] {
  // About one fern per half a bar height: a wide bar is a row of them, the
  // fronds of neighbours overlapping a little.
  const n = Math.max(1, Math.round(width / (height * 0.55)));
  const ferns: Fern[] = [];
  const base = r();
  for (let k = 0; k < n; k++) {
    const slot = width / n;
    ferns.push({
      x: slot * (k + 0.5) + between(r, -0.25, 0.25) * slot,
      size: height * between(r, 0.78, 1.08),
      lean: between(r, -0.35, 0.35),
      mirror: r() < 0.5 ? -1 : 1,
      curl: between(r, 0.015, 0.07),
      color: ((base + k / n) % 1) * 0.8,
      start: between(r, 0, 0.45),
    });
  }
  return ferns;
}

/** The ferns' density picture and the chaos game that fills it. */
export class Ferns extends Density {
  readonly ferns: Fern[];
  /** Points computed so far. */
  steps = 0;
  private state: Float64Array;
  private s0: number; private s1: number; private s2: number; private s3: number;
  private shapes: { m: Float64Array; cum: Float64Array }[];

  constructor(ferns: Fern[], width: number, height: number, r: Rng) {
    super(width, height);
    this.ferns = ferns;
    this.shapes = ferns.map((f) => maps(f.curl));
    this.state = new Float64Array(ferns.length * 2);
    const seed = () => ((r() * 4294967296) | 0) || 1;
    this.s0 = seed(); this.s1 = seed(); this.s2 = seed(); this.s3 = seed();
  }

  /**
   * `n` more points, shared among the ferns that have started, each grown
   * to `grown(f)` of its height (0–1): points above that are skipped.
   */
  iterate(n: number, grown: (f: Fern) => number): void {
    const live = this.ferns.map((f, i) => [i, grown(f)] as const).filter(([, g]) => g > 0);
    if (!live.length) return;
    const per = Math.ceil(n / live.length);
    const { counts, colours, width: W, height: H } = this;
    let s0 = this.s0, s1 = this.s1, s2 = this.s2, s3 = this.s3;
    for (const [k, g] of live) {
      const f = this.ferns[k]!;
      const { m, cum } = this.shapes[k]!;
      const top = g * FERN_HEIGHT;
      const scale = f.size / FERN_HEIGHT;
      const ca = Math.cos(f.lean) * scale, sa = Math.sin(f.lean) * scale;
      const mx = f.mirror;
      let x = this.state[k * 2]!, y = this.state[k * 2 + 1]!;
      for (let i = 0; i < per; i++) {
        const t = s0 ^ (s0 << 11);
        s0 = s1; s1 = s2; s2 = s3;
        s3 = s3 ^ (s3 >>> 19) ^ t ^ (t >>> 8);
        const u = (s3 >>> 0) / 4294967296;
        const o = u < cum[0]! ? 0 : u < cum[1]! ? 6 : u < cum[2]! ? 12 : 18;
        const nx = m[o]! * x + m[o + 1]! * y + m[o + 4]!;
        y = m[o + 2]! * x + m[o + 3]! * y + m[o + 5]!;
        x = nx;
        if (y > top) continue;
        // Fern units → panel: mirrored, leaned about the foot, scaled; y up.
        const fx = x * mx;
        const px = (f.x + fx * ca + y * sa) | 0;
        const py = (H - 1 - (y * ca - fx * sa)) | 0;
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        const idx = py * W + px;
        counts[idx]!++;
        // The colour drifts a little from foot to tip.
        colours[idx]! += f.color + (y / FERN_HEIGHT) * 0.18;
      }
      this.state[k * 2] = x;
      this.state[k * 2 + 1] = y;
    }
    this.s0 = s0; this.s1 = s1; this.s2 = s2; this.s3 = s3;
    this.steps += per * live.length;
  }
}
