/**
 * A density picture: a histogram of where points landed and the average
 * colour coordinate of each pixel, shown with log-density and gamma (the
 * way fractal flames are). Shared by the flame and the ferns.
 */
import { SIZE, type Palette } from './palette.ts';

export class Density {
  readonly counts: Uint32Array;
  readonly colours: Float32Array;
  readonly width: number;
  readonly height: number;
  private ref = 1;
  private lut = new Float32Array(0);
  private inv = new Float32Array(0);
  private hist = new Uint32Array(40);

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.counts = new Uint32Array(width * height);
    this.colours = new Float32Array(width * height);
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
