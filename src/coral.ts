/**
 * Coral growing up from the bottom of the bar (or, hanging from the top, a
 * lightning-like frost): diffusion-limited aggregation. Particles wander at
 * random until they touch the growth, and stick; branches that reach out
 * catch more of them, so the growth splits into fine fractal fingers, as
 * corals, frost and Lichtenberg figures do. Each particle is drawn as a
 * stroke to the one it stuck to, coloured by when it arrived.
 */
import type { Canvas, CanvasApi, Graphics } from '@kiosko/sdk';
import { SIZE, type Palette } from './palette.ts';
import { between, type Rng } from './rng.ts';

export class Coral {
  /** Grid cell in pixels, and the grid's size. */
  readonly cell: number;
  readonly gw: number;
  readonly gh: number;
  /** Hanging from the top instead of growing from the bottom. */
  readonly hanging: boolean;
  /** Particles there can be at most (a share of the grid). */
  readonly cap: number;
  /** About how many it takes to reach `limit`: what the growing time is paced by. */
  readonly expected: number;
  /** The row it stops at (from the root edge): once a branch gets there, it is grown. */
  readonly limit: number;
  /** Particle (index + 1) at each cell, 0 where empty. Rows count from the root edge. */
  private grid: Int32Array;
  private xs: Int16Array;
  private ys: Int16Array;
  private parent: Int32Array;
  /** Particles stuck so far; the first ones are the roots. */
  count = 0;
  /** Particles drawn so far. */
  private drawn = 0;
  /** Highest row reached (from the root edge). */
  private top = 0;
  /** Walker steps taken so far. */
  steps = 0;
  private s0: number; private s1: number; private s2: number; private s3: number;
  private canvas: Canvas;
  private roots: number;
  readonly width: number;
  readonly height: number;
  readonly palette: Palette;
  /** Where along the palette it starts, and how far along it the whole growth goes. */
  private hue: number;
  private sweep: number;

  constructor(width: number, height: number, palette: Palette, r: Rng, canvas: CanvasApi) {
    this.width = width;
    this.height = height;
    this.palette = palette;
    this.cell = Math.max(2, Math.round(height / 150));
    this.gw = Math.ceil(width / this.cell);
    this.gh = Math.ceil(height / this.cell);
    this.hanging = r() < 0.35;
    this.cap = Math.round(this.gw * this.gh * 0.2);
    this.expected = Math.round(this.gw * this.gh * 0.07);
    this.limit = Math.floor(this.gh * 0.9);
    this.grid = new Int32Array(this.gw * this.gh);
    this.xs = new Int16Array(this.cap);
    this.ys = new Int16Array(this.cap);
    this.parent = new Int32Array(this.cap).fill(-1);
    const seed = () => ((r() * 4294967296) | 0) || 1;
    this.s0 = seed(); this.s1 = seed(); this.s2 = seed(); this.s3 = seed();
    this.hue = r();
    this.sweep = between(r, 0.6, 1.2);
    // Roots: a few points along the edge, about one per bar height.
    const n = Math.max(2, Math.round(this.gw / this.gh) + 1);
    for (let k = 0; k < n; k++) {
      const x = Math.floor(((k + 0.5 + between(r, -0.3, 0.3)) / n) * this.gw);
      this.stick(Math.min(this.gw - 1, Math.max(0, x)), 0, -1);
    }
    this.roots = this.count;
    this.canvas = canvas.createCanvas(width, height);
    const g = this.canvas.getContext('2d');
    g.fillStyle = `rgb(${palette.bg.join(',')})`;
    g.fillRect(0, 0, width, height);
  }

  private stick(x: number, y: number, parent: number): void {
    const i = this.count++;
    this.xs[i] = x;
    this.ys[i] = y;
    this.parent[i] = parent;
    this.grid[y * this.gw + x] = i + 1;
    if (y > this.top) this.top = y;
  }

  /** 32 random bits (xorshift128). */
  private next(): number {
    const t = this.s0 ^ (this.s0 << 11);
    this.s0 = this.s1; this.s1 = this.s2; this.s2 = this.s3;
    this.s3 = this.s3 ^ (this.s3 >>> 19) ^ t ^ (t >>> 8);
    return this.s3 >>> 0;
  }

  /** The particle next to cell (x, y), if any (index + 1), looking at the 8 neighbours. */
  private touching(x: number, y: number): number {
    const { gw, gh, grid } = this;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= gh) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx;
        if (xx < 0 || xx >= gw) continue;
        const p = grid[yy * gw + xx]!;
        if (p) return p;
      }
    }
    return 0;
  }

  /**
   * Lets walkers wander until `target` particles have stuck, or `ms` have
   * passed. Walkers start a little above the growth and are dropped if they
   * stray too far from it.
   */
  grow(target: number, ms: number): void {
    const end = performance.now() + ms;
    const { gw, gh, grid } = this;
    const goal = Math.min(this.cap, target);
    let steps = 0;
    while (this.count < goal && !this.grown) {
      if (performance.now() > end) break;
      const launch = Math.min(gh - 1, this.top + 5);
      const ceiling = Math.min(gh - 1, this.top + 14);
      let x = this.next() % gw;
      let y = launch;
      // Walk this particle for a while; give up (a fresh one next) after many steps.
      for (let k = 0; k < 20_000; k++) {
        const r = this.next();
        const d = r & 3;
        if (d === 0) { if (x < gw - 1) x++; }
        else if (d === 1) { if (x > 0) x--; }
        else if (d === 2) { if (y < ceiling) y++; }
        else if (y > 0) y--;
        steps++;
        if (grid[y * gw + x]) continue;
        const p = this.touching(x, y);
        if (p) {
          this.stick(x, y, p - 1);
          break;
        }
      }
    }
    this.steps += steps;
  }

  /** A branch has reached the far side (or there are as many particles as there can be): it is done. */
  get grown(): boolean {
    return this.top >= this.limit || this.count >= this.cap;
  }

  /** Draws the particles stuck since the last call onto its own canvas, then the canvas on the panel. */
  draw(g: Graphics): void {
    const c = this.canvas.getContext('2d');
    const { cell, palette } = this;
    const lut = palette.lut;
    c.lineCap = 'round';
    c.lineWidth = Math.max(1.5, cell * 0.85);
    // One stroke per run of particles of about the same age (the same colour).
    const run = 24;
    for (let from = Math.max(this.drawn, this.roots); from < this.count; from += run) {
      const to = Math.min(this.count, from + run);
      const age = (from - this.roots) / Math.max(1, this.expected - this.roots);
      const q = ((((this.hue + age * this.sweep) % 1) * (SIZE - 1)) | 0) * 3;
      c.strokeStyle = `rgb(${lut[q]! | 0},${lut[q + 1]! | 0},${lut[q + 2]! | 0})`;
      c.beginPath();
      for (let i = from; i < to; i++) {
        const p = this.parent[i]!;
        if (p < 0) continue;
        const [x0, y0] = this.at(p), [x1, y1] = this.at(i);
        c.moveTo(x0, y0);
        c.lineTo(x1, y1);
      }
      c.stroke();
    }
    // The roots: a dot each.
    if (this.drawn === 0) {
      c.fillStyle = `rgb(${palette.ink.join(',')})`;
      for (let i = 0; i < this.roots; i++) {
        const [x, y] = this.at(i);
        c.beginPath();
        c.arc(x, y, cell * 0.9, 0, Math.PI * 2);
        c.fill();
      }
    }
    this.drawn = this.count;
    g.drawImage(this.canvas, 0, 0);
  }

  /** Centre of particle `i`'s cell on the panel. */
  private at(i: number): [number, number] {
    const x = (this.xs[i]! + 0.5) * this.cell;
    const y = (this.ys[i]! + 0.5) * this.cell;
    return [x, this.hanging ? y : this.height - y];
  }
}
