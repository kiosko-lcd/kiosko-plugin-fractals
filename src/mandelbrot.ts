/**
 * A zoom into the Mandelbrot set, towards one of a few famous spots on its
 * edge (seahorse valley, a seahorse's spiral, a double spiral, a dendrite
 * arm), turning slowly.
 *
 * Deep down every pixel costs hundreds of iterations, more than a frame can
 * afford for all of them. So the picture is kept from frame to frame and
 * carried along the zoom (each pixel resampled from where it was in the
 * previous view), and each frame recomputes as many pixels as fit in its
 * budget, spread evenly over the picture; on a fast machine all of them,
 * on a slow one a share, the rest only slightly stale. It stays well above
 * the depth where double precision gives out.
 */
import type { Canvas, CanvasApi, Graphics } from '@kiosko/sdk';
import { SIZE, type Palette } from './palette.ts';
import { type Rng } from './rng.ts';

/** Places on the edge of the set worth zooming into: Misiurewicz points and valleys with structure all the way down. */
export const TARGETS: { name: string; x: number; y: number }[] = [
  { name: 'seahorse valley', x: -0.743643887037151, y: 0.13182590420533 },
  { name: 'seahorse spiral', x: -0.77568377, y: 0.13646737 },
  { name: 'double spiral', x: 0.001643721971153, y: -0.822467633298876 },
  { name: 'spiral arm', x: -0.10109636384562, y: 0.95628651080914 },
];

/** Width of the view at the start (the whole middle of the set across the bar) and at the deepest. */
const START_WIDTH = 3.2;
const END_WIDTH = 2e-6;
/** The fraction of the panel's resolution it computes at. */
const SCALE = 0.34;
const INSIDE = -1;

export interface View {
  cx: number;
  cy: number;
  /** Width of the view, in the complex plane. */
  span: number;
  angle: number;
}

export class Mandelbrot {
  readonly target: (typeof TARGETS)[number];
  /** Turning speed, radians per unit of zoom progress. */
  readonly spin: number;
  readonly bands: number;
  readonly w: number;
  readonly h: number;
  private nu: Float32Array;
  private prev: Float32Array;
  /** The order pixels are recomputed in: shuffled, so a partial pass is spread over the whole picture. */
  private order: Uint32Array;
  private cursor = 0;
  private last: View | null = null;
  private perPixel = 0.002;
  /** Time a frame spends besides computing pixels, smoothed. */
  private overhead = 0;
  private surface: Canvas;
  private image: ReturnType<Graphics['createImageData']>;
  /** The far field's count, smoothed over frames (colours are counted from it). */
  private lo = -1;
  /** Pixels recomputed in the last frame, for logs and tests. */
  recomputed = 0;
  readonly width: number;
  readonly height: number;
  readonly palette: Palette;

  constructor(width: number, height: number, palette: Palette, r: Rng, canvas: CanvasApi, scale = SCALE) {
    this.width = width;
    this.height = height;
    this.palette = palette;
    this.target = TARGETS[Math.floor(r() * TARGETS.length)]!;
    this.spin = (r() < 0.5 ? -1 : 1) * (0.6 + r() * 0.8);
    this.bands = 0.9 + r() * 0.6;
    this.w = Math.max(16, Math.round(width * scale));
    this.h = Math.max(4, Math.round(height * scale));
    this.nu = new Float32Array(this.w * this.h).fill(Number.NaN);
    this.prev = new Float32Array(this.w * this.h);
    this.order = shuffledOrder(this.w * this.h);
    this.surface = canvas.createCanvas(this.w, this.h);
    this.image = this.surface.getContext('2d').createImageData(this.w, this.h);
  }

  /** The view at zoom progress `p` (0–1): exponential zoom about the target, which drifts to the middle. */
  view(p: number): View {
    const q = Math.min(1, Math.max(0, p));
    const span = START_WIDTH * Math.pow(END_WIDTH / START_WIDTH, q);
    // Zooming about the target: it keeps its place on screen while
    // everything else grows away from it, then eases into the middle.
    const k = span / START_WIDTH;
    const pull = Math.min(1, q * 1.6);
    const ease = pull * pull * (3 - 2 * pull);
    const cx0 = -0.6, cy0 = 0;
    const cx = this.target.x + (cx0 - this.target.x) * k * (1 - ease);
    const cy = this.target.y + (cy0 - this.target.y) * k * (1 - ease);
    return { cx, cy, span, angle: this.spin * q };
  }

  /** Iterations allowed at a zoom: deeper needs more. */
  static maxIter(span: number): number {
    return Math.min(1500, Math.round(120 + 90 * Math.log10(START_WIDTH / span)));
  }

  /** Smooth iteration count at c, or INSIDE. */
  static escape(cr: number, ci: number, max: number): number {
    // Inside the main cardioid or the period-2 bulb: no need to iterate.
    const xq = cr - 0.25;
    const q = xq * xq + ci * ci;
    if (q * (q + xq) <= 0.25 * ci * ci || (cr + 1) * (cr + 1) + ci * ci <= 0.0625) return INSIDE;
    let zr = 0, zi = 0, r2 = 0, n = 0;
    let sr = 0, si = 0, check = 8, k = 0;
    while (n < max) {
      const t = zr * zr - zi * zi + cr;
      zi = 2 * zr * zi + ci;
      zr = t;
      r2 = zr * zr + zi * zi;
      n++;
      if (r2 > 256) break;
      // An orbit back where it was has settled on a cycle: inside.
      if (zr === sr && zi === si) return INSIDE;
      if (++k === check) {
        k = 0;
        check *= 2;
        sr = zr;
        si = zi;
      }
    }
    if (n >= max) return INSIDE;
    return Math.max(0, n + 1 - Math.log2(Math.log(r2) / 2));
  }

  /** Carries the last picture over to view `v`: each pixel resampled (bilinearly) from where it was. */
  private reproject(v: View): void {
    const old = this.last;
    const { w, h } = this;
    const prev = this.prev;
    prev.set(this.nu);
    if (!old) return;
    const nu = this.nu;
    const k = v.span / w;
    const ca = Math.cos(v.angle) * k, sa = Math.sin(v.angle) * k;
    const ok = w / old.span;
    const oca = Math.cos(-old.angle) * ok, osa = Math.sin(-old.angle) * ok;
    for (let y = 0; y < h; y++) {
      const dy = y + 0.5 - h / 2;
      for (let x = 0; x < w; x++) {
        const dx = x + 0.5 - w / 2;
        // Pixel → plane in the new view → pixel in the old one.
        const px = v.cx + dx * ca - dy * sa - old.cx;
        const py = v.cy + dx * sa + dy * ca - old.cy;
        const ox = px * oca - py * osa + w / 2 - 0.5;
        const oy = px * osa + py * oca + h / 2 - 0.5;
        const i = y * w + x;
        if (!(ox >= 0 && oy >= 0 && ox < w - 1 && oy < h - 1)) {
          nu[i] = Number.NaN;
          continue;
        }
        const x0 = ox | 0, y0 = oy | 0, fx = ox - x0, fy = oy - y0;
        const j = y0 * w + x0;
        const a = prev[j]!, b = prev[j + 1]!, c = prev[j + w]!, d = prev[j + w + 1]!;
        if (a >= 0 && b >= 0 && c >= 0 && d >= 0) nu[i] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
        // Next to the inside (or to a hole), no blending: the nearest one.
        else nu[i] = prev[(fy < 0.5 ? j : j + w) + (fx < 0.5 ? 0 : 1)]!;
      }
    }
  }

  /** Recomputes one pixel for view `v`. */
  private compute(i: number, v: View, max: number, ca: number, sa: number): void {
    const { w, h } = this;
    const x = i % w, y = (i / w) | 0;
    const dx = x + 0.5 - w / 2, dy = y + 0.5 - h / 2;
    this.nu[i] = Mandelbrot.escape(v.cx + dx * ca - dy * sa, v.cy + dx * sa + dy * ca, max);
  }

  /** Brings the picture to zoom progress `p`, spending about `ms` (all of it on the first frame). */
  update(p: number, ms: number): void {
    const v = this.view(p);
    const start = performance.now();
    this.reproject(v);
    const max = Mandelbrot.maxIter(v.span);
    const k = v.span / this.w;
    const ca = Math.cos(v.angle) * k, sa = Math.sin(v.angle) * k;
    const nu = this.nu;
    let done = 0;
    if (!this.last) {
      // The first frame: one pixel in 4×4 computed and spread over its block;
      // the passes that follow fill in the detail.
      const { w, h } = this;
      for (let y = 0; y < h; y += 4) {
        for (let x = 0; x < w; x += 4) {
          this.compute(y * w + x, v, max, ca, sa);
          const val = nu[y * w + x]!;
          for (let yy = y; yy < Math.min(h, y + 4); yy++) for (let xx = x; xx < Math.min(w, x + 4); xx++) nu[yy * w + xx] = val;
          done++;
        }
      }
    }
    // Holes first (the corners a turn brings in).
    for (let i = 0; i < nu.length; i++) if (Number.isNaN(nu[i]!)) { this.compute(i, v, max, ca, sa); done++; }
    // Then, in the spread order, as many as the budget allows.
    const t0 = performance.now();
    const left = ms - (t0 - start);
    let n = Math.min(nu.length, Math.max(64, Math.floor(left / this.perPixel)));
    const order = this.order;
    let c = this.cursor;
    for (let m = 0; m < n; m++) {
      this.compute(order[c]!, v, max, ca, sa);
      if (++c === order.length) c = 0;
      if ((m & 255) === 255 && performance.now() - start > ms * 1.2) n = m + 1;
    }
    const spent = performance.now() - t0;
    if (n > 256) this.perPixel = this.perPixel * 0.5 + (spent / n) * 0.5;
    this.cursor = c;
    this.recomputed = done + n;
    this.last = v;
  }

  /** Paints the picture into its pixels: colour bands by the log of the smooth count, fading out far from the edge. */
  shade(shift: number): Uint8ClampedArray {
    const out = this.image.data as Uint8ClampedArray;
    const px = new Uint32Array(out.buffer, out.byteOffset, this.w * this.h);
    const { bg, ink, lut, light } = this.palette;
    const nu = this.nu;
    // The lowest counts in view are the far field: colours count from there
    // (so the bands don't all merge as the counts grow with depth) and it
    // fades to the background. Smoothed, so the colours don't jump.
    let lo = Infinity;
    for (let i = 0; i < nu.length; i += 37) { const v = nu[i]!; if (v >= 0 && v < lo) lo = v; }
    if (Number.isFinite(lo)) this.lo = this.lo < 0 ? lo : this.lo * 0.85 + lo * 0.15;
    const base = Math.max(0, this.lo);
    const inside = light ? mixPack(bg, ink, 0.85) : mixPack(bg, ink, 0.04);
    const bands = this.bands;
    for (let i = 0; i < nu.length; i++) {
      const v = nu[i]!;
      if (!(v >= 0)) { px[i] = inside; continue; }
      const d = Math.max(0, v - base);
      const t = Math.log1p(d) * bands + shift;
      const q = (((t - Math.floor(t)) * (SIZE - 1)) | 0) * 3;
      const s = Math.min(1, d / 18 + 0.05);
      const a = s * s * (3 - 2 * s) * (light ? 0.9 : 1);
      const r = bg[0] + (lut[q]! - bg[0]) * a, g = bg[1] + (lut[q + 1]! - bg[1]) * a, b = bg[2] + (lut[q + 2]! - bg[2]) * a;
      px[i] = (0xff000000 | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0)) >>> 0;
    }
    return out;
  }

  /** Paints frame at zoom progress `p` on the panel. */
  draw(g: Graphics, p: number, ms: number, shift: number): void {
    // What is not computing (shading, scaling up) comes off the budget first.
    this.update(p, Math.max(2, ms - this.overhead));
    const t0 = performance.now();
    this.shade(shift);
    this.surface.getContext('2d').putImageData(this.image, 0, 0);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(this.surface, 0, 0, this.width, this.height);
    const spent = performance.now() - t0;
    this.overhead = this.overhead ? this.overhead * 0.8 + spent * 0.2 : spent;
  }

  /** The smooth counts, for tests. */
  get values(): Float32Array {
    return this.nu;
  }
}

function mixPack(a: [number, number, number], b: [number, number, number], t: number): number {
  const r = a[0] + (b[0] - a[0]) * t, g = a[1] + (b[1] - a[1]) * t, bl = a[2] + (b[2] - a[2]) * t;
  return (0xff000000 | ((bl | 0) << 16) | ((g | 0) << 8) | (r | 0)) >>> 0;
}

/**
 * Every pixel once, in a shuffled order: any run of the list covers the
 * picture evenly, and the pixels a partial pass leaves stale make a fine
 * grain rather than a pattern. Shuffled with a fixed seed: the same every time.
 */
export function shuffledOrder(n: number): Uint32Array {
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  let s = 0x9e3779b9;
  for (let i = n - 1; i > 0; i--) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    const j = (s >>> 0) % (i + 1);
    const t = order[i]!;
    order[i] = order[j]!;
    order[j] = t;
  }
  return order;
}
