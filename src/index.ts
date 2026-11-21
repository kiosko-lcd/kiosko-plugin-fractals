/**
 * Generative fractals as interludes. The fractal flame develops while it
 * plays: each frame adds as many points as fit in a slice of the frame's
 * time, so `prepare` stays short and the picture comes up like a photo in
 * the developer, from faint dust to glowing filaments.
 */
import { defineInterlude, definePlugin, t } from '@kiosko/sdk';
import { chooseGenome, Flame } from './flame.ts';
import { Julia, LEVELS } from './julia.ts';
import { themePalette } from './palette.ts';
import { hashSeed, rng } from './rng.ts';

/** Frames per second they are made for; a screen shows at most its own `maxFps`. */
export const FPS = 15;
/** The runtime cuts at the slot's `maxSeconds` (600 at most). */
const MAX_FRAMES = 600 * FPS;
const now = () => performance.now();

/**
 * How much of each frame goes to computing it: a share of the frame's time,
 * adjusted to the machine. The pace the screen plays at is learnt from the
 * shortest gap between frames (a panel may play slower than `FPS`); when
 * frames come later than that (a slow machine, a heavy JPEG to encode, other
 * screens playing) the share shrinks, and when they come on time it grows
 * back.
 */
export class Budget {
  ms: number;
  private last = 0;
  private pace = Infinity;
  readonly target: number;
  constructor(target: number) {
    this.target = target;
    this.ms = target;
  }
  /** Call at the start of each frame; gives the milliseconds to spend. */
  next(at = now()): number {
    if (this.last) {
      const gap = at - this.last;
      this.pace = Math.min(this.pace, Math.max(1000 / FPS, gap));
      const period = Math.min(this.pace, 200);
      if (gap > period * 1.08) this.ms = Math.max(3, this.ms * 0.9);
      else if (gap < period * 1.03) this.ms = Math.min(this.target, this.ms * 1.04 + 0.3);
    }
    this.last = at;
    return this.ms;
  }
}

const cpuOption = t.integer({
  default: 40,
  min: 5,
  max: 80,
  unit: '%',
  advanced: true,
  label: { en: 'Processor share', es: 'Parte del procesador', de: 'Prozessoranteil', 'zh-Hans': '处理器占用', 'zh-Hant': '處理器佔用' },
  help: {
    en: 'How much of each frame’s time goes to computing it. Less leaves more for the rest of the machine; it also lowers by itself when frames come late.',
    es: 'Cuánto del tiempo de cada fotograma se dedica a calcularlo. Menos deja más para el resto de la máquina; también baja solo si los fotogramas llegan tarde.',
    de: 'Wie viel der Zeit jedes Bildes in seine Berechnung geht. Weniger lässt dem Rest des Rechners mehr; es sinkt auch von selbst, wenn Bilder zu spät kommen.',
    'zh-Hans': '每帧时间中用于计算的比例。越低给机器其余部分留得越多；帧延迟时也会自动降低。',
    'zh-Hant': '每格時間中用於計算的比例。越低給機器其餘部分留得越多；畫格延遲時也會自動降低。',
  },
});

export const flame = defineInterlude({
  id: 'flame',
  name: { en: 'Fractal flame', es: 'Llama fractal', de: 'Fraktale Flamme', 'zh-Hans': '分形火焰', 'zh-Hant': '碎形火焰' },
  description: {
    en: 'A fractal flame, as in Electric Sheep, that develops like a photo: from faint dust to glowing filaments, in the theme’s colours. A different piece each time.',
    es: 'Una llama fractal, como las de Electric Sheep, que se revela como una foto: de un polvo tenue a filamentos luminosos, con los colores del tema. Cada vez una obra distinta.',
    de: 'Eine fraktale Flamme wie bei Electric Sheep, die sich wie ein Foto entwickelt: von feinem Staub zu leuchtenden Fäden, in den Farben des Themas. Jedes Mal ein anderes Werk.',
    'zh-Hans': '一团分形火焰（如 Electric Sheep），像照片显影一样浮现：从淡淡的微尘到发光的细丝，使用主题的颜色。每次都是不同的作品。',
    'zh-Hant': '一團碎形火焰（如 Electric Sheep），像照片顯影一樣浮現：從淡淡的微塵到發光的細絲，使用主題的顏色。每次都是不同的作品。',
  },
  icon: 'flame',
  fps: FPS,
  options: t.object({
    revealMs: t.duration({
      default: 20_000,
      label: { en: 'Developing time', es: 'Tiempo de revelado', de: 'Entwicklungszeit', 'zh-Hans': '显影时间', 'zh-Hant': '顯影時間' },
      help: {
        en: 'How long it takes to come up fully. Then it keeps sharpening and its colours drift slowly until the interlude ends.',
        es: 'Cuánto tarda en aparecer del todo. Después sigue afinándose y sus colores derivan despacio hasta que acaba el interludio.',
        de: 'Wie lange es dauert, bis es ganz erscheint. Danach wird es weiter schärfer und seine Farben wandern langsam, bis das Zwischenspiel endet.',
        'zh-Hans': '完全浮现所需的时间。之后画面继续变清晰，颜色缓慢流动，直到插曲结束。',
        'zh-Hant': '完全浮現所需的時間。之後畫面繼續變清晰，顏色緩慢流動，直到插曲結束。',
      },
    }),
    cpu: cpuOption,
  }),
  async prepare(ctx) {
    const { width, height } = ctx;
    const seed = hashSeed(ctx.seed, 'flame');
    const t0 = now();
    const genome = chooseGenome(seed, width, height);
    const palette = themePalette(ctx.theme, rng(seed ^ 0x2545f491));
    const art = new Flame(genome, width, height, seed);
    const image = ctx.canvas.createCanvas(1, 1).getContext('2d').createImageData(width, height);
    ctx.log(`flame: ${genome.label} (chosen in ${Math.round(now() - t0)} ms)`);
    const reveal = Math.max(1, Math.round((Math.max(1000, ctx.options.revealMs) / 1000) * FPS));
    const budget = new Budget(((1000 / FPS) * Math.min(80, Math.max(5, ctx.options.cpu))) / 100);
    // Points per pixel past which more add nothing to see: then it only drifts.
    const enough = width * height * 600;
    // Painting the histogram (tone-mapping every pixel) can cost as much as
    // the budget on a modest machine: then each frame paints only every
    // `slices`-th row, in turn, so the cost is spread evenly and the rest of
    // each frame still goes to adding points.
    let rowMs = 0;
    let slices = 1;
    let spent = 0;
    return {
      frames: MAX_FRAMES,
      draw(g, i) {
        const start = now();
        const ms = budget.next(start);
        if (art.plotted < enough) {
          const spend = Math.max(2, ms - rowMs / slices);
          do art.iterate(8_000);
          while (now() - start < spend);
        }
        const p0 = now();
        if (i < 8 || i % 6 === 0) art.measure(palette.light ? 0.985 : 0.96);
        paint(art, image.data, palette, i, reveal, i % slices, slices);
        const cost = (now() - p0) * slices;
        rowMs = rowMs ? rowMs * 0.8 + cost * 0.2 : cost;
        // Painting at most half the budget per frame.
        slices = Math.min(4, Math.max(1, Math.ceil(rowMs / (ms * 0.5))));
        g.putImageData(image, 0, 0);
        spent += now() - start;
        if (i === reveal) ctx.log(`flame: developed, ${(art.steps / 1e6).toFixed(1)} M points, ${(spent / (i + 1)).toFixed(1)} ms a frame (painting ${rowMs.toFixed(0)} ms, in ${slices} slices)`);
      },
    };
  },
});

/** Frame `i` of the developing: exposure rising like a print in the tray, then a slow colour drift. */
export function paint(art: Flame, out: Uint8ClampedArray, palette: ReturnType<typeof themePalette>, i: number, reveal: number, slice = 0, slices = 1): void {
  const p = Math.min(1, i / reveal);
  const e = p * p * (3 - 2 * p);
  const exposure = Math.pow(10, -2.5 * (1 - e));
  const shift = i > reveal ? ((i - reveal) / (FPS * 240)) % 1 : 0;
  art.paint(out, palette, exposure, { shift, fade: 0.2 + 0.8 * e, slice, slices });
}

export const julia = defineInterlude({
  id: 'julia',
  name: { en: 'Morphing Julia', es: 'Julia que se transforma', de: 'Verwandelnde Julia-Menge', 'zh-Hans': '变幻的朱利亚集', 'zh-Hant': '變幻的朱利亞集' },
  description: {
    en: 'A Julia set that twists and turns as its parameter walks along the edge of the Mandelbrot set, in a perfect loop, in the theme’s colours.',
    es: 'Un conjunto de Julia que se retuerce mientras su parámetro recorre el borde del conjunto de Mandelbrot, en un bucle perfecto, con los colores del tema.',
    de: 'Eine Julia-Menge, die sich windet, während ihr Parameter den Rand der Mandelbrot-Menge entlangwandert, in einer perfekten Schleife, in den Farben des Themas.',
    'zh-Hans': '朱利亚集随参数沿曼德博集合的边缘移动而扭转变形，完美循环，使用主题的颜色。',
    'zh-Hant': '朱利亞集隨參數沿曼德博集合的邊緣移動而扭轉變形，完美循環，使用主題的顏色。',
  },
  icon: 'infinity',
  fps: FPS,
  options: t.object({
    loopMs: t.duration({
      default: 30_000,
      label: { en: 'Loop length', es: 'Duración del bucle', de: 'Schleifendauer', 'zh-Hans': '循环时长', 'zh-Hant': '循環時長' },
      help: {
        en: 'How long one trip around the Mandelbrot set takes; then it starts again exactly where it began.',
        es: 'Cuánto dura una vuelta alrededor del conjunto de Mandelbrot; después empieza otra vez justo donde empezó.',
        de: 'Wie lange eine Runde um die Mandelbrot-Menge dauert; danach beginnt sie genau dort, wo sie begann.',
        'zh-Hans': '绕曼德博集合一圈所需的时间；之后从起点无缝重新开始。',
        'zh-Hant': '繞曼德博集合一圈所需的時間；之後從起點無縫重新開始。',
      },
    }),
    cpu: cpuOption,
  }),
  async prepare(ctx) {
    const { width, height } = ctx;
    const seed = hashSeed(ctx.seed, 'julia');
    const palette = themePalette(ctx.theme, rng(seed ^ 0x2545f491));
    const loop = Math.max(FPS * 2, Math.round((Math.max(2000, ctx.options.loopMs) / 1000) * FPS));
    const art = new Julia(width, height, palette, rng(seed), ctx.canvas);
    const budget = new Budget(((1000 / FPS) * Math.min(80, Math.max(5, ctx.options.cpu))) / 100);
    ctx.log(`julia: ${art.describe()}`);
    let spent = 0;
    return {
      frames: MAX_FRAMES,
      draw(g, i) {
        const start = now();
        art.draw(g, (i % loop) / loop, budget.next(start));
        spent += now() - start;
        if (i === FPS * 10) ctx.log(`julia: ${(spent / (i + 1)).toFixed(1)} ms a frame, at ${Math.round(LEVELS[art.level]!.f * 100)} % of the panel's resolution${LEVELS[art.level]!.k > 1 ? ', interlaced' : ''}`);
      },
    };
  },
});

export default definePlugin({
  id: 'fractals',
  name: { en: 'Fractals', es: 'Fractales', de: 'Fraktale', 'zh-Hans': '分形', 'zh-Hant': '碎形' },
  version: '0.1.0',
  description: {
    en: 'Generative fractal interludes: a fractal flame that develops like a photo, and a Julia set that morphs, in your theme’s colours.',
    es: 'Interludios de fractales generativos: una llama fractal que se revela como una foto y un conjunto de Julia que se transforma, con los colores de tu tema.',
    de: 'Generative Fraktal-Zwischenspiele: eine fraktale Flamme, die sich wie ein Foto entwickelt, und eine sich verwandelnde Julia-Menge, in den Farben deines Themas.',
    'zh-Hans': '生成式分形插曲：像照片显影一样浮现的分形火焰，以及不断变幻的朱利亚集，使用你的主题颜色。',
    'zh-Hant': '生成式碎形插曲：像照片顯影一樣浮現的碎形火焰，以及不斷變幻的朱利亞集，使用你的主題顏色。',
  },
  author: 'Loksly',
  license: 'MIT',
  homepage: 'https://github.com/kiosko-lcd/kiosko-plugin-fractals#readme',
  repository: 'https://github.com/kiosko-lcd/kiosko-plugin-fractals',
  sdk: '^0.2.0',
  languages: ['en', 'es', 'de', 'zh-Hant', 'zh-Hans'],
  permissions: {},
  interludes: [flame, julia],
});
