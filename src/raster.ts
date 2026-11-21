/**
 * The frame loop shared by the escape-time fractals (Julia, Mandelbrot):
 * each frame is computed at the fraction of the panel's resolution that fits
 * its time budget, learnt from what a pixel cost in the frames before, and
 * scaled up to the panel.
 */
import type { Canvas, CanvasApi, Graphics } from '@kiosko/sdk';

/**
 * How a frame can be computed, from cheapest to finest: at a fraction `f` of
 * the panel's resolution, and every row (`k` = 1) or every other row in
 * turn (`k` = 2, interlaced: the figure moves little from one frame to the
 * next, so the older rows hardly show).
 */
export const LEVELS: { f: number; k: number }[] = [
  { f: 0.25, k: 1 }, { f: 0.33, k: 1 }, { f: 0.4, k: 1 }, { f: 0.5, k: 2 }, { f: 0.5, k: 1 },
  { f: 0.66, k: 2 }, { f: 0.66, k: 1 }, { f: 0.8, k: 2 }, { f: 1, k: 2 }, { f: 1, k: 1 },
];

type Surface = { canvas: Canvas; image: ReturnType<Graphics['createImageData']>; w: number; h: number };

/** Computes rows `slice`, `slice + slices`… of a `w`×`h` picture into RGBA pixels. */
export type RenderRows = (out: Uint8ClampedArray, w: number, h: number, slice: number, slices: number) => void;

export class Raster {
  /** Index into LEVELS in use. */
  level: number;
  /** Frames drawn, for the interlacing. */
  private frame = 0;
  private surfaces = new Map<number, Surface>();
  /** Last frames' cost, per computed pixel, in ms. */
  private perPixel = 0;
  readonly width: number;
  readonly height: number;
  private canvas: CanvasApi;

  constructor(width: number, height: number, canvas: CanvasApi, level = 2) {
    this.width = width;
    this.height = height;
    this.canvas = canvas;
    this.level = level;
  }

  private surface(level: number): Surface {
    const had = this.surfaces.get(level);
    if (had) return had;
    const { f } = LEVELS[level]!;
    const w = Math.max(16, Math.round(this.width * f));
    const h = Math.max(4, Math.round(this.height * f));
    const canvas = this.canvas.createCanvas(w, h);
    const s: Surface = { canvas, image: canvas.getContext('2d').createImageData(w, h), w, h };
    this.surfaces.set(level, s);
    return s;
  }

  /** Paints a frame on the panel: `render` computes it, at the level that fits in `ms`. */
  draw(g: Graphics, ms: number, render: RenderRows): void {
    const cost = (l: number) => {
      const { f, k } = LEVELS[l]!;
      return (this.width * this.height * f * f * this.perPixel) / k;
    };
    const was = this.level;
    if (this.perPixel > 0) {
      if (cost(this.level) > ms && this.level > 0) this.level--;
      // Only step up with room to spare, so it doesn't flicker between two.
      else if (this.level < LEVELS.length - 1 && cost(this.level + 1) <= ms * 0.8) this.level++;
    }
    const s = this.surface(this.level);
    // A level just switched to has no older rows yet: compute it whole once.
    const k = this.level === was && this.frame > 0 ? LEVELS[this.level]!.k : 1;
    const start = performance.now();
    render(s.image.data as Uint8ClampedArray, s.w, s.h, this.frame % k, k);
    const per = ((performance.now() - start) * k) / (s.w * s.h);
    this.perPixel = this.perPixel ? this.perPixel * 0.6 + per * 0.4 : per;
    this.frame++;
    s.canvas.getContext('2d').putImageData(s.image, 0, 0);
    if (s.w === this.width && s.h === this.height) g.drawImage(s.canvas, 0, 0);
    else {
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(s.canvas, 0, 0, this.width, this.height);
    }
  }

  /** What it computes at now, for logs. */
  describe(): string {
    const { f, k } = LEVELS[this.level]!;
    return `${Math.round(f * 100)} % of the panel's resolution${k > 1 ? ', interlaced' : ''}`;
  }
}
