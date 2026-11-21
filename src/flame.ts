/**
 * Fractal flames (Scott Draves' algorithm, the one behind Apophysis and
 * Electric Sheep): the chaos game over a few affine transforms, each bent by
 * a blend of nonlinear "variations", plotted into a density histogram and
 * shown with log-density and gamma. Every point also carries a colour
 * coordinate that drifts towards the colour of the transform it went
 * through, so each part of the flame takes the colour of the map that made it.
 */
import { between, rng, type Rng } from './rng.ts';
import { SIZE, type Palette } from './palette.ts';

export const VARIATIONS = ['linear', 'sinusoidal', 'spherical', 'swirl', 'horseshoe', 'polar', 'handkerchief', 'heart', 'disc', 'spiral', 'hyperbolic', 'julia', 'bent', 'fisheye', 'bubble', 'cylinder', 'diamond', 'ex'] as const;
export type Variation = (typeof VARIATIONS)[number];
const V = Object.fromEntries(VARIATIONS.map((v, i) => [v, i])) as Record<Variation, number>;

export interface Xform {
  /** Affine pre-transform: x' = a x + b y + c, y' = d x + e y + f. */
  a: number; b: number; c: number; d: number; e: number; f: number;
  /** Variation ids (indices into VARIATIONS) and their weights. */
  vars: number[];
  weights: number[];
  /** Colour coordinate 0–1 and how fast a point takes it (0: symmetry, keeps the point's colour). */
  color: number;
  speed: number;
  /** Chance of being chosen, relative to the others. */
  weight: number;
}

export interface Camera {
  cx: number;
  cy: number;
  /** Rotation, radians: the flame's long axis along the bar. */
  angle: number;
  /** Pixels per unit, across and down (a slight stretch to fill a wide bar). */
  sx: number;
  sy: number;
}

export interface Genome {
  xforms: Xform[];
  camera: Camera;
  /** What it is made of, for logs. */
  label: string;
}

// The variations the generator draws from, with how often: the swirly ones
// give the classic look, the blobby ones (bubble, cylinder) are seasoning.
const MENU: [Variation, number][] = [
  ['linear', 3], ['sinusoidal', 3], ['spherical', 4], ['swirl', 3], ['horseshoe', 2], ['polar', 2],
  ['handkerchief', 1], ['heart', 1], ['disc', 2], ['spiral', 2], ['hyperbolic', 2], ['julia', 4],
  ['bent', 1], ['fisheye', 1], ['bubble', 1], ['cylinder', 1], ['diamond', 1], ['ex', 1],
];
const PLAIN = new Set([V.linear, V.sinusoidal, V.cylinder, V.bent]);
const MENU_TOTAL = MENU.reduce((s, [, w]) => s + w, 0);
function drawVariation(r: Rng): number {
  let x = r() * MENU_TOTAL;
  for (const [v, w] of MENU) if ((x -= w) < 0) return V[v];
  return V.linear;
}

/** A random genome, before it is framed (see `chooseGenome`). */
export function randomGenome(r: Rng): Xform[] {
  const n = 2 + Math.floor(r() * 3);
  const xforms: Xform[] = [];
  for (let k = 0; k < n; k++) {
    // A random linear part, scaled so the map is contractive on average.
    const rot = r() * Math.PI * 2;
    const scale = between(r, 0.35, 0.95);
    const skew = between(r, -0.5, 0.5);
    const sq = between(r, 0.6, 1.25);
    const ca = Math.cos(rot) * scale;
    const sa = Math.sin(rot) * scale;
    const nv = r() < 0.45 ? 1 : r() < 0.8 ? 2 : 3;
    const vars: number[] = [];
    const weights: number[] = [];
    for (let j = 0; j < nv; j++) {
      const v = drawVariation(r);
      if (vars.includes(v)) continue;
      vars.push(v);
      weights.push(between(r, 0.3, 1));
    }
    // Plain maps alone fill flat boxes (sinusoidal is a square): give them a curvy partner.
    if (vars.every((v) => PLAIN.has(v))) {
      let v = drawVariation(r);
      while (PLAIN.has(v)) v = drawVariation(r);
      vars.push(v);
      weights.push(between(r, 0.5, 1));
    }
    const sum = weights.reduce((s, w) => s + w, 0);
    xforms.push({
      a: ca * sq, b: -sa + skew * ca, c: between(r, -1, 1),
      d: sa * sq, e: ca + skew * sa, f: between(r, -1, 1),
      vars, weights: weights.map((w) => (w / sum) * between(r, 0.85, 1.1)),
      color: k / Math.max(1, n - 1) * 0.85 + r() * 0.15,
      speed: between(r, 0.35, 0.7),
      weight: between(r, 0.25, 1),
    });
  }
  // Symmetry, as Apophysis does it: a mirror or a rotation that keeps the
  // point's colour. A mirror balances a wide composition.
  const s = r();
  const sym = (a: number, b: number, d: number, e: number): Xform => ({ a, b, c: 0, d, e, f: 0, vars: [V.linear], weights: [1], color: 0, speed: 0, weight: 0.5 + r() * 0.5 });
  if (s < 0.35) xforms.push(sym(-1, 0, 0, 1));
  else if (s < 0.55) xforms.push(sym(-1, 0, 0, -1));
  else if (s < 0.7) {
    const k = r() < 0.6 ? 3 : 4;
    const t = (Math.PI * 2) / k;
    for (let i = 1; i < k; i++) xforms.push(sym(Math.cos(t * i), -Math.sin(t * i), Math.sin(t * i), Math.cos(t * i)));
  }
  return xforms;
}

const TABLE = 1024;

/** The chaos game over one genome: a point and its colour, iterated. */
export class Chaos {
  private table = new Uint8Array(TABLE);
  x = 0;
  y = 0;
  col = 0.5;
  readonly xforms: Xform[];
  // The genome flattened into typed arrays, and the random state in plain
  // fields (xorshift128): the hot loop then touches no objects nor closures.
  private coef: Float64Array;
  private ids: Int32Array;
  private ws: Float64Array;
  private s0: number; private s1: number; private s2: number; private s3: number;
  constructor(xforms: Xform[], r: Rng) {
    this.xforms = xforms;
    const n = xforms.length;
    this.coef = new Float64Array(n * 8);
    this.ids = new Int32Array(n * 4).fill(-1);
    this.ws = new Float64Array(n * 4);
    xforms.forEach((x, k) => {
      this.coef.set([x.a, x.b, x.c, x.d, x.e, x.f, x.color, x.speed], k * 8);
      x.vars.slice(0, 4).forEach((v, j) => {
        this.ids[k * 4 + j] = v;
        this.ws[k * 4 + j] = x.weights[j] ?? 0;
      });
    });
    const seed = () => ((r() * 4294967296) | 0) || 1;
    this.s0 = seed(); this.s1 = seed(); this.s2 = seed(); this.s3 = seed();
    const total = xforms.reduce((s, x) => s + x.weight, 0);
    let acc = 0;
    let k = 0;
    for (let i = 0; i < TABLE; i++) {
      while (k < n - 1 && (i + 0.5) / TABLE > (acc + xforms[k]!.weight) / total) acc += xforms[k++]!.weight;
      this.table[i] = k;
    }
    this.reset();
  }

  /** 32 random bits (xorshift128), as an unsigned integer. */
  next(): number {
    let t = this.s0 ^ (this.s0 << 11);
    this.s0 = this.s1; this.s1 = this.s2; this.s2 = this.s3;
    this.s3 = this.s3 ^ (this.s3 >>> 19) ^ t ^ (t >>> 8);
    return this.s3 >>> 0;
  }

  reset(): void {
    this.x = (this.next() / 4294967296) * 2 - 1;
    this.y = (this.next() / 4294967296) * 2 - 1;
    this.col = this.next() / 4294967296;
    this.run(20, NOWHERE, NO_TRACE, 0);
  }

  /** One step of the game; false if the point ran off (it is reset). */
  step(): boolean {
    return this.run(1, NOWHERE, NO_TRACE, 0) === 0;
  }

  /**
   * `n` steps of the game. Each point lands in `plot`'s histogram (none
   * for `NOWHERE`) and, if `trace` has room, is written there as x, y,
   * colour from `at` on. Gives how many times the point ran off and was
   * reset. One loop with everything in locals: this is where nearly all the
   * time goes. Always the same argument types (never null), so the engine
   * keeps it optimised.
   */
  run(n: number, plot: Plot, trace: Float64Array, at: number): number {
    const C = this.coef, ids = this.ids, ws = this.ws, table = this.table;
    let x = this.x, y = this.y, col = this.col;
    let s0 = this.s0, s1 = this.s1, s2 = this.s2, s3 = this.s3;
    let lost = 0;
    let plotted = 0;
    const tracing = trace.length >= (at + n) * 3;
    for (let i = 0; i < n; i++) {
      // xorshift128
      const t = s0 ^ (s0 << 11);
      s0 = s1; s1 = s2; s2 = s3;
      s3 = s3 ^ (s3 >>> 19) ^ t ^ (t >>> 8);
      const rnd = s3;
      const o = table[rnd & (TABLE - 1)]! * 8;
      const tx = C[o]! * x + C[o + 1]! * y + C[o + 2]!;
      const ty = C[o + 3]! * x + C[o + 4]! * y + C[o + 5]!;
      let nx = 0;
      let ny = 0;
        const r2 = tx * tx + ty * ty + 1e-12;
        const r = Math.sqrt(r2);
        const sa = tx / r;
        const ca = ty / r;
        for (let j = o >> 1, end = j + 4; j < end; j++) {
          const v = ids[j]!;
          if (v < 0) break;
          const w = ws[j]!;
          switch (v) {
            case 0: nx += w * tx; ny += w * ty; break; // linear
            case 1: nx += w * Math.sin(tx); ny += w * Math.sin(ty); break; // sinusoidal
            case 2: nx += (w * tx) / r2; ny += (w * ty) / r2; break; // spherical
            case 3: { const s = Math.sin(r2); const c = Math.cos(r2); nx += w * (tx * s - ty * c); ny += w * (tx * c + ty * s); break; } // swirl
            case 4: nx += (w * (tx - ty) * (tx + ty)) / r; ny += (w * 2 * tx * ty) / r; break; // horseshoe
            case 5: nx += (w * Math.atan2(tx, ty)) / Math.PI; ny += w * (r - 1); break; // polar
            case 6: { // handkerchief: r (sin(θ + r), cos(θ − r))
              const sr = Math.sin(r), cr = Math.cos(r);
              nx += w * r * (sa * cr + ca * sr); ny += w * r * (ca * cr + sa * sr); break;
            }
            case 7: { const th = Math.atan2(tx, ty) * r; nx += w * r * Math.sin(th); ny -= w * r * Math.cos(th); break; } // heart
            case 8: { const pr = Math.PI * r; const th = Math.atan2(tx, ty) / Math.PI; nx += w * th * Math.sin(pr); ny += w * th * Math.cos(pr); break; } // disc
            case 9: nx += (w * (ca + Math.sin(r))) / r; ny += (w * (sa - Math.cos(r))) / r; break; // spiral
            case 10: nx += (w * sa) / r; ny += w * r * ca; break; // hyperbolic
            case 11: { // julia
              const rr = Math.sqrt(r) * (rnd & 0x40000000 ? w : -w);
              // cos and sin of θ/2 from those of θ (half-angle), sign from sin θ.
              const ch = Math.sqrt((1 + ca) / 2);
              const sh = (sa < 0 ? -1 : 1) * Math.sqrt(Math.max(0, (1 - ca) / 2));
              nx += rr * ch; ny += rr * sh; break;
            }
            case 12: nx += w * (tx < 0 ? tx * 2 : tx); ny += w * (ty < 0 ? ty / 2 : ty); break; // bent
            case 13: { const k = (2 * w) / (r + 1); nx += k * ty; ny += k * tx; break; } // fisheye
            case 14: { const k = (4 * w) / (r2 + 4); nx += k * tx; ny += k * ty; break; } // bubble
            case 15: nx += w * Math.sin(tx); ny += w * ty; break; // cylinder
            case 16: nx += w * sa * Math.cos(r); ny += w * ca * Math.sin(r); break; // diamond
            case 17: { // ex
              const sr = Math.sin(r), cr = Math.cos(r);
              const n0 = sa * cr + ca * sr; // sin(θ + r)
              const n1 = ca * cr + sa * sr; // cos(θ − r)
              const m0 = n0 * n0 * n0 * r; const m1 = n1 * n1 * n1 * r;
              nx += w * (m0 + m1); ny += w * (m0 - m1); break;
            }
          }
        }
      col += (C[o + 6]! - col) * C[o + 7]!;
      if (!(nx > -1e6 && nx < 1e6 && ny > -1e6 && ny < 1e6)) {
        // Ran off to infinity (or NaN): start again from a random point.
        lost++;
        nx = ((s1 >>> 0) / 4294967296) * 2 - 1;
        ny = ((s2 >>> 0) / 4294967296) * 2 - 1;
      }
      x = nx;
      y = ny;
      if (tracing) {
        const q = (at + i) * 3;
        trace[q] = x; trace[q + 1] = y; trace[q + 2] = col;
      }
      {
        const px = (plot.m00 * x + plot.m01 * y + plot.ox) | 0;
        const py = (plot.m10 * x + plot.m11 * y + plot.oy) | 0;
        if (px < 0 || py < 0 || px >= plot.width || py >= plot.height) continue;
        const k = py * plot.width + px;
        plot.counts[k]!++;
        plot.colours[k]! += col;
        plotted++;
      }
    }
    this.x = x; this.y = y; this.col = col;
    this.s0 = s0; this.s1 = s1; this.s2 = s2; this.s3 = s3;
    plot.plotted += plotted;
    return lost;
  }
}

/** Where the chaos game's points land: a histogram and the camera onto it. */
export interface Plot {
  width: number;
  height: number;
  m00: number; m01: number; m10: number; m11: number; ox: number; oy: number;
  counts: Uint32Array;
  colours: Float32Array;
  plotted: number;
}

/** A plot no point lands in (0×0), and no trace: for steps that only move the point. */
const nowhere = (): Plot => ({ width: 0, height: 0, m00: 0, m01: 0, m10: 0, m11: 0, ox: -1, oy: -1, counts: new Uint32Array(0), colours: new Float32Array(0), plotted: 0 });
const NOWHERE = nowhere();
const NO_TRACE = new Float64Array(0);

/** A quick look at a genome: where its points fall, for framing and judging it. */
function sample(xforms: Xform[], r: Rng, n: number): { xs: Float64Array; ys: Float64Array; cs: Float64Array; lost: number } {
  const chaos = new Chaos(xforms, r);
  const trace = new Float64Array(n * 3);
  const lost = chaos.run(n, NOWHERE, trace, 0);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const cs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = trace[i * 3]!;
    ys[i] = trace[i * 3 + 1]!;
    cs[i] = trace[i * 3 + 2]!;
  }
  return { xs, ys, cs, lost };
}

function quantile(sorted: Float64Array, q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]!;
}

/**
 * Frames a genome for a `width`×`height` panel: its long axis along the
 * panel's, then scaled to fill the width, cropping the tails rather than
 * leaving a small figure in the middle of a wide bar. Gives how well it
 * fills the frame (0 = useless, higher is better).
 */
export function frame(xforms: Xform[], width: number, height: number, r: Rng, n = 12_000): { camera: Camera; score: number } | null {
  const s = sample(xforms, r, n);
  if (s.lost > n * 0.05) return null;
  // Principal axis of the cloud, from its covariance, over the central points.
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += s.xs[i]!; my += s.ys[i]!; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = s.xs[i]! - mx, dy = s.ys[i]! - my;
    if (Math.abs(dx) > 50 || Math.abs(dy) > 50) continue;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const us = new Float64Array(n), vs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const dx = s.xs[i]!, dy = s.ys[i]!;
    us[i] = dx * ca + dy * sa;
    vs[i] = -dx * sa + dy * ca;
  }
  const su = us.slice().sort(), sv = vs.slice().sort();
  const u0 = quantile(su, 0.015), u1 = quantile(su, 0.985);
  const v0 = quantile(sv, 0.015), v1 = quantile(sv, 0.985);
  const w = u1 - u0, h = v1 - v0;
  if (!(w > 1e-3 && h > 1e-3) || w > 1e4 || h > 1e4) return null;
  // Fill the width; if that leaves it far taller than the bar, allow at most
  // a crop to 1/1.7 of its height, then a mild vertical stretch if short.
  let scale = width / w;
  if (h * scale > height * 1.7) scale = (height * 1.7) / h;
  const stretch = Math.min(1.5, Math.max(1, (height * 0.92) / (h * scale)));
  const camera: Camera = { cx: (u0 + u1) / 2, cy: (v0 + v1) / 2, angle, sx: scale, sy: scale * stretch };
  // Judge it on a coarse grid of the panel: how much of it is covered, and
  // whether the points gather into filaments rather than a uniform fog.
  const gw = 64, gh = Math.max(8, Math.round((64 * height) / width));
  const grid = new Uint32Array(gw * gh);
  let inside = 0;
  for (let i = 0; i < n; i++) {
    const gx = Math.floor((((us[i]! - camera.cx) * camera.sx + width / 2) / width) * gw);
    const gy = Math.floor((((vs[i]! - camera.cy) * camera.sy + height / 2) / height) * gh);
    if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
    grid[gy * gw + gx]!++;
    inside++;
  }
  let hit = 0;
  for (const g of grid) if (g > 1) hit++;
  const coverage = hit / grid.length;
  const counts = Array.from(grid).filter((g) => g > 0).sort((a, b) => b - a);
  // How few cells hold half the points: low means bright filaments.
  let acc = 0, half = 0;
  for (const c of counts) { acc += c; half++; if (acc >= inside / 2) break; }
  const concentration = 1 - half / Math.max(1, hit);
  // Colour variety: a flame all of one colour is a waste of the palette.
  let cm = 0, cv = 0;
  for (let i = 0; i < n; i++) cm += s.cs[i]!;
  cm /= n;
  for (let i = 0; i < n; i++) cv += (s.cs[i]! - cm) ** 2;
  const colourSpread = Math.sqrt(cv / n);
  const fill = coverage < 0.3 ? (coverage / 0.3) ** 2 : coverage > 0.85 ? Math.max(0, (1 - coverage) / 0.15) : 1;
  const score = fill * concentration ** 2 * (0.5 + Math.min(colourSpread, 0.25) * 2) * (inside / n);
  return { camera, score };
}

/**
 * Tries a few random genomes and keeps the one that fills the panel best.
 * Deterministic for a seed. `tries` × `n` steps of the chaos game in all.
 */
export function chooseGenome(seed: number, width: number, height: number, tries = 24, n = 16_000): Genome {
  const r = rng(seed);
  let best: Genome | null = null;
  let bestScore = -1;
  for (let t = 0; t < tries || !best; t++) {
    const xforms = randomGenome(r);
    const framed = frame(xforms, width, height, r, n);
    if (framed && framed.score > bestScore) {
      bestScore = framed.score;
      best = { xforms, camera: framed.camera, label: describe(xforms) };
    }
    if (t > tries * 4) break;
  }
  return best ?? { xforms: [{ a: 0.5, b: 0, c: 0, d: 0, e: 0.5, f: 0, vars: [V.sinusoidal], weights: [1], color: 0, speed: 0.5, weight: 1 }], camera: { cx: 0, cy: 0, angle: 0, sx: width / 2, sy: height / 2 }, label: 'fallback' };
}

export function describe(xforms: Xform[]): string {
  return xforms.filter((x) => x.speed > 0).map((x) => x.vars.map((v) => VARIATIONS[v]).join('+')).join(', ');
}

/** The developing picture: a density histogram the chaos game fills, shown on demand. */
export class Flame {
  readonly counts: Uint32Array;
  readonly colours: Float32Array;
  /** Steps of the chaos game so far. */
  steps = 0;
  private chaos: Chaos;
  private plot: Plot;
  private ref = 1;
  private lut = new Float32Array(0);
  private inv = new Float32Array(0);
  private hist = new Uint32Array(40);
  readonly genome: Genome;
  readonly width: number;
  readonly height: number;
  constructor(genome: Genome, width: number, height: number, seed: number) {
    this.genome = genome;
    this.width = width;
    this.height = height;
    this.counts = new Uint32Array(width * height);
    this.colours = new Float32Array(width * height);
    this.chaos = new Chaos(genome.xforms, rng(seed ^ 0x5bd1e995));
    const { angle, sx, sy, cx, cy } = genome.camera;
    // Rotate onto the long axis, scale; the centre is in the rotated frame.
    this.plot = {
      width, height,
      m00: Math.cos(angle) * sx, m01: Math.sin(angle) * sx,
      m10: -Math.sin(angle) * sy, m11: Math.cos(angle) * sy,
      ox: width / 2 - cx * sx, oy: height / 2 - cy * sy,
      counts: this.counts, colours: this.colours, plotted: 0,
    };
  }

  /** Points plotted so far (inside the panel). */
  get plotted(): number {
    return this.plot.plotted;
  }

  /** `n` more steps of the chaos game. */
  iterate(n: number): void {
    this.chaos.run(n, this.plot, NO_TRACE, 0);
    this.steps += n;
  }

  /**
   * The density that shows as full colour: a high quantile of the lit
   * pixels, so a few hot spots don't darken the rest. Recomputed now and then.
   */
  measure(quantile = 0.985): number {
    const { counts, hist } = this;
    hist.fill(0);
    let lit = 0;
    for (let i = 0; i < counts.length; i += 7) {
      const c = counts[i]!;
      if (!c) continue;
      hist[Math.min(39, 31 - Math.clz32(c))]!++;
      lit++;
    }
    let acc = 0;
    let bin = 0;
    for (; bin < 40; bin++) {
      acc += hist[bin]!;
      if (acc >= lit * quantile) break;
    }
    this.ref = Math.max(1, 2 ** (bin + 0.5));
    return this.ref;
  }

  /**
   * Paints the histogram into RGBA pixels: alpha from log-density over the
   * reference, lifted by `gamma`, times `exposure` (0–1, the "developing");
   * colour from the palette, shifted by `shift` (0–1, the slow drift once it
   * is developed), all of it times `fade`; the densest cores burn towards
   * the theme's ink. With `slices` > 1 it paints only the rows `slice`,
   * `slice + slices`, … so the cost can be spread over several frames.
   */
  paint(out: Uint8ClampedArray, palette: Palette, exposure: number, o: { shift?: number; fade?: number; slice?: number; slices?: number } = {}): void {
    const { shift = 0, fade = 1, slice = 0, slices = 1 } = o;
    const gamma = 2.4;
    const contrast = 40;
    const { counts, colours } = this;
    const ref = this.ref;
    const max = Math.min(1 << 20, Math.max(16, Math.ceil(ref * 16)));
    if (this.lut.length < max + 1) {
      this.lut = new Float32Array(max + 1);
      this.inv = new Float32Array(max + 1);
      for (let d = 1; d <= max; d++) this.inv[d] = 1 / d;
    }
    const lut = this.lut;
    const inv = this.inv;
    const norm = 1 / Math.log1p(contrast);
    const ig = 1 / gamma;
    // Below a threshold the curve goes straight instead of being lifted by
    // the gamma (flam3's "gamma threshold"): stray single points stay faint
    // instead of covering the background in a grey haze.
    const thr = 0.04;
    const lift = Math.pow(thr, ig) / thr;
    for (let d = 1; d <= max; d++) {
      const v = Math.log1p(((exposure * d) / ref) * contrast) * norm;
      lut[d] = (v < thr ? v * lift : Math.pow(v, ig)) * fade;
    }
    const [br, bgc, bb] = palette.bg;
    const [ir, ig2, ib] = palette.ink;
    const pal = palette.lut;
    const off = Math.floor(shift * SIZE) % SIZE;
    const burn = palette.light ? 0.75 : 0.9;
    // One 32-bit write per pixel (RGBA in memory order: little-endian ABGR).
    const px = new Uint32Array(out.buffer, out.byteOffset, counts.length);
    const pack = (r: number, g: number, b: number) => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
    const bgPixel = pack(br, bgc, bb);
    const top = SIZE - 1;
    const W = this.width;
    for (let y = slice; y < this.height; y += slices) {
    for (let i = y * W, end = i + W; i < end; i++) {
      const d = counts[i]!;
      if (!d) {
        px[i] = bgPixel;
        continue;
      }
      let a: number, ci: number;
      if (d <= max) {
        a = lut[d]!;
        ci = ((colours[i]! * inv[d]! * top) | 0) + off;
      } else {
        a = lut[max]!;
        ci = (((colours[i]! / d) * top) | 0) + off;
      }
      if (ci >= SIZE) ci -= SIZE;
      const q = ci * 3;
      const pr = pal[q]!, pg = pal[q + 1]!, pb = pal[q + 2]!;
      let r: number, g: number, b: number;
      if (a <= 1) {
        r = br + (pr - br) * a; g = bgc + (pg - bgc) * a; b = bb + (pb - bb) * a;
      } else {
        // Overexposed: from the colour towards the ink, like a glowing core.
        const h = (a > 1.625 ? 1 : (a - 1) * 1.6) * burn;
        r = pr + (ir - pr) * h; g = pg + (ig2 - pg) * h; b = pb + (ib - pb) * h;
      }
      px[i] = (0xff000000 | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0)) >>> 0;
    }
    }
  }
}
