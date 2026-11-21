/**
 * A Julia set whose parameter c walks just outside the main cardioid of the
 * Mandelbrot set, so the figure twists from spirals to sea horses to dust
 * and back, in a perfect loop; the view turns with it so its long axis lies
 * along the bar. Smooth (continuous) iteration count for the
 * colour. Computed at a fraction of the panel's resolution that fits the
 * frame's time budget, then scaled up.
 */
import type { CanvasApi, Graphics } from '@kiosko/sdk';
import { Raster } from './raster.ts';
import { SIZE, type Palette } from './palette.ts';
import { type Rng } from './rng.ts';

const MAX_ITER = 110;
const BAIL = 64;

export class Julia {
  /** The frame loop: resolution fitted to the budget. */
  readonly raster: Raster;
  /** Phase of the walk (0–1) where this piece starts, and its sense. */
  readonly phase: number;
  readonly sense: number;
  /** How far outside the cardioid the walk runs. */
  readonly reach: number;
  /** Colour cycles across the escape bands. */
  readonly bands: number;
  /** The view along the loop: angle and size of the set, sampled and smoothed. */
  private views: Float64Array;

  readonly width: number;
  readonly height: number;
  readonly palette: Palette;
  constructor(width: number, height: number, palette: Palette, r: Rng, canvas: CanvasApi) {
    this.width = width;
    this.height = height;
    this.palette = palette;
    this.raster = new Raster(width, height, canvas);
    this.phase = r();
    this.sense = r() < 0.5 ? 1 : -1;
    this.reach = 0.02 + r() * 0.025;
    this.bands = 0.03 + r() * 0.025;
    this.views = this.planViews();
  }

  describe(): string {
    const [x, y] = this.c(0);
    return `c = ${x.toFixed(3)} ${y < 0 ? '-' : '+'} ${Math.abs(y).toFixed(3)}i`;
  }

  /**
   * The parameter at loop position `t` (0–1): one turn around the main
   * cardioid, pushed a little outwards along its normal (more near the cusp,
   * where the sets would get too thin), breathing in and out.
   */
  c(t: number): [number, number] {
    // Hurry past the cusp (θ = 0), where the sets thin out to a sparse dust
    // around an empty middle, and linger where they curl into spirals.
    const u = (this.phase + this.sense * t) * Math.PI * 2;
    const th = u + 0.55 * Math.sin(u);
    const x = Math.cos(th) / 2 - Math.cos(2 * th) / 4;
    const y = Math.sin(th) / 2 - Math.sin(2 * th) / 4;
    // Outward normal: e^{iθ}/2 − e^{2iθ}/2, normalised; at the cusp, along +x.
    let nx = Math.cos(th) / 2 - Math.cos(2 * th) / 2;
    let ny = Math.sin(th) / 2 - Math.sin(2 * th) / 2;
    const n = Math.hypot(nx, ny);
    if (n < 1e-3) { nx = 1; ny = 0; } else { nx /= n; ny /= n; }
    const out = this.reach * (1 + 0.5 * Math.sin(th * 5)) + 0.015 * Math.pow((1 + Math.cos(th)) / 2, 8);
    return [x + nx * out, y + ny * out];
  }

  /**
   * How to frame the set along the loop: a coarse escape-time map of each
   * of a few dozen sets gives its long axis (from the spread of the points
   * that stay longest) and how far it reaches along it. The view turns that
   * axis along the bar and scales it to fill the width. The set is symmetric,
   * so the angle counts modulo π; samples are smoothed around the loop, so
   * the camera glides instead of jerking.
   */
  private planViews(): Float64Array {
    const N = 96;
    const G = 40;
    const ang = new Float64Array(N);
    const size = new Float64Array(N);
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < N; i++) {
      const [cr, ci] = this.c(i / N);
      xs.length = 0; ys.length = 0;
      for (let gy = 0; gy < G; gy++) {
        for (let gx = 0; gx < G; gx++) {
          let zr = ((gx + 0.5) / G) * 4 - 2, zi = ((gy + 0.5) / G) * 4 - 2;
          const x0 = zr, y0 = zi;
          let n = 0;
          while (n < 40 && zr * zr + zi * zi < 16) {
            const t2 = zr * zr - zi * zi + cr;
            zi = 2 * zr * zi + ci;
            zr = t2;
            n++;
          }
          if (n >= 12) { xs.push(x0); ys.push(y0); }
        }
      }
      let sxx = 0, syy = 0, sxy = 0;
      for (let k = 0; k < xs.length; k++) { sxx += xs[k]! * xs[k]!; syy += ys[k]! * ys[k]!; sxy += xs[k]! * ys[k]!; }
      // Doubled angle of the principal axis: a plain vector to average.
      const a2 = Math.atan2(2 * sxy, sxx - syy);
      const ca = Math.cos(a2 / 2), sa = Math.sin(a2 / 2);
      let reach = 0.5;
      for (let k = 0; k < xs.length; k++) reach = Math.max(reach, Math.abs(xs[k]! * ca + ys[k]! * sa));
      ang[i] = a2;
      size[i] = Math.min(2, reach + 2 / G);
    }
    const out = new Float64Array(N * 2);
    const win = 4;
    for (let i = 0; i < N; i++) {
      let sa = 0, ca = 0, ss = 0, ws = 0;
      for (let k = -win; k <= win; k++) {
        const j = (i + k + N) % N;
        const w = win + 1 - Math.abs(k);
        sa += Math.sin(ang[j]!) * w; ca += Math.cos(ang[j]!) * w; ss += size[j]! * w; ws += w;
      }
      out[i * 2] = Math.atan2(sa, ca) / 2;
      out[i * 2 + 1] = ss / ws;
    }
    return out;
  }

  /** The view at loop position `t`: rotation of the plane and its size (|β|), interpolated. */
  view(t: number): [number, number] {
    const N = this.views.length / 2;
    const x = (((t % 1) + 1) % 1) * N;
    const i = Math.floor(x) % N, j = (i + 1) % N, l = x - Math.floor(x), f = l * l * (3 - 2 * l);
    let a0 = this.views[i * 2]!, a1 = this.views[j * 2]!;
    while (a1 - a0 > Math.PI / 2) a1 -= Math.PI;
    while (a1 - a0 < -Math.PI / 2) a1 += Math.PI;
    return [a0 + (a1 - a0) * f, this.views[i * 2 + 1]! * (1 - f) + this.views[j * 2 + 1]! * f];
  }

  /** Computes loop position `t` into RGBA pixels of `w`×`h` (only rows `slice`, `slice + slices`… of each half). */
  render(out: Uint8ClampedArray, w: number, h: number, t: number, slice = 0, slices = 1): void {
    const [cr, ci] = this.c(t);
    const [angle, beta] = this.view(t); // beta: how far the set reaches along its axis
    // ±β a little inside the ends of the bar.
    const k = (2 * beta) / (w * 0.94);
    const ux = Math.cos(angle) * k, uy = Math.sin(angle) * k;
    const shift = t;
    const px32 = new Uint32Array(out.buffer, out.byteOffset, w * h);
    // The figure is symmetric about the origin: compute the top half, mirror it.
    const half = Math.ceil(h / 2);
    for (let py = slice; py < half; py += slices) {
      const v = py + 0.5 - h / 2;
      // Two pixels at a time: their orbits are independent chains of
      // multiplications, which the processor overlaps.
      for (let px = 0; px < w; px += 2) {
        const u = px + 0.5 - w / 2;
        let ar = u * ux - v * uy, ai = u * uy + v * ux;
        let br2 = 0;
        let bzr = (u + 1) * ux - v * uy, bzi = (u + 1) * uy + v * ux;
        let ar2 = ar * ar + ai * ai;
        br2 = bzr * bzr + bzi * bzi;
        let an = 0, bn = 0, at = ar2, bt = br2;
        let aLive = ar2 < BAIL, bLive = br2 < BAIL;
        while (aLive || bLive) {
          if (aLive) {
            const t2 = ar * ar - ai * ai + cr;
            ai = 2 * ar * ai + ci;
            ar = t2;
            ar2 = ar * ar + ai * ai;
            if (ar2 < at) at = ar2;
            aLive = ar2 < BAIL && ++an < MAX_ITER;
          }
          if (bLive) {
            const t2 = bzr * bzr - bzi * bzi + cr;
            bzi = 2 * bzr * bzi + ci;
            bzr = t2;
            br2 = bzr * bzr + bzi * bzi;
            if (br2 < bt) bt = br2;
            bLive = br2 < BAIL && ++bn < MAX_ITER;
          }
        }
        const ca = this.shade(an, ar2, at, shift);
        px32[py * w + px] = ca;
        px32[(h - 1 - py) * w + (w - 1 - px)] = ca;
        if (px + 1 < w) {
          const cb = this.shade(bn, br2, bt, shift);
          px32[py * w + px + 1] = cb;
          px32[(h - 1 - py) * w + (w - 2 - px)] = cb;
        }
      }
    }
  }

  /** The colour of a pixel whose orbit ran `n` steps, ended at |z|² = `r2` and came as close as `trap` to 0. */
  private shade(n: number, r2: number, trap: number, shift: number): number {
    const { bg, ink, lut, light } = this.palette;
    const br = bg[0], bgc = bg[1], bb = bg[2];
    let r: number, g: number, b: number;
    if (n >= MAX_ITER) {
      // Never escaped: inside the set. Quiet ripples of the palette, by how
      // close the orbit came to the origin (an orbit trap).
      const m = Math.sqrt(trap);
      const q = ((((m * 1.5 + shift) % 1) * (SIZE - 1)) | 0) * 3;
      const a = (light ? 0.16 : 0.12) + (light ? 0.22 : 0.3) * Math.min(1, m * 2.5);
      r = br + (lut[q]! - br) * a; g = bgc + (lut[q + 1]! - bgc) * a; b = bb + (lut[q + 2]! - bb) * a;
    } else {
      // Smooth (continuous) iteration count.
      const nu = Math.max(0, n + 1 - Math.log2(Math.log(r2) / 2));
      // A glow that rises sharply towards the set and leaves the far field bare.
      const s = Math.min(1, nu / 28);
      const a = s * s * (1.6 - 0.6 * s) * (light ? 0.75 : 1);
      const ix = ((((nu * this.bands + shift) % 1) + 1) % 1) * (SIZE - 1);
      const q = (ix | 0) * 3;
      r = br + (lut[q]! - br) * a; g = bgc + (lut[q + 1]! - bgc) * a; b = bb + (lut[q + 2]! - bb) * a;
      // The thinnest filaments, right at the edge, burn towards the ink.
      if (nu > 30) {
        const hh = Math.min(1, (nu - 30) / 50) * (light ? 0.35 : 0.6);
        r += (ink[0] - r) * hh; g += (ink[1] - g) * hh; b += (ink[2] - b) * hh;
      }
    }
    return (0xff000000 | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0)) >>> 0;
  }

  /** Paints loop position `t` on the panel, at the resolution that fits in `ms`. */
  draw(g: Graphics, t: number, ms: number): void {
    this.raster.draw(g, ms, (out, w, h, slice, slices) => this.render(out, w, h, t, slice, slices));
  }
}
