/**
 * Generative fractals as interludes. The fractal flame develops while it
 * plays: each frame adds as many points as fit in a slice of the frame's
 * time, so `prepare` stays short and the picture comes up like a photo in
 * the developer, from faint dust to glowing filaments.
 */
import { defineInterlude, definePlugin, t, type Graphics, type InterludePlayer } from '@kiosko/sdk';
import type { Density } from './density.ts';
import { chooseGenome, Flame } from './flame.ts';
import { Coral } from './coral.ts';
import { Ferns, plantFerns, type Fern } from './ferns.ts';
import { Julia } from './julia.ts';
import { Mandelbrot } from './mandelbrot.ts';
import { themePalette, type Palette } from './palette.ts';
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

/**
 * Time since the first frame, by the wall clock: a screen that plays slower
 * than `FPS` still takes the time asked (to develop, to loop). Never less
 * than the frames shown at `FPS`, so frames drawn faster than that (a test,
 * a preview) still move it along.
 */
export class Clock {
  private t0 = -1;
  elapsed(i: number, at = now()): number {
    if (this.t0 < 0) this.t0 = at;
    return Math.max(at - this.t0, (i * 1000) / FPS);
  }
}

/** The budget for a `cpu` option (a share of a frame at `FPS`, in %). */
export const budgetFor = (cpu: number) => new Budget(((1000 / FPS) * Math.min(80, Math.max(5, cpu))) / 100);

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
  preview: { poster: 'docs/flame.jpg', video: 'docs/flame.webm' },
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
    ctx.log(`flame: ${genome.label} (chosen in ${Math.round(now() - t0)} ms)`);
    return developing({
      art,
      palette,
      budget: budgetFor(ctx.options.cpu),
      revealMs: Math.max(1000, ctx.options.revealMs),
      // Points per pixel past which more add nothing to see: then it only drifts.
      enough: () => art.plotted >= width * height * 600,
      add: () => art.iterate(8_000),
      log: (ms, slices) => ctx.log(`flame: developed, ${(art.steps / 1e6).toFixed(1)} M points, ${ms.toFixed(1)} ms a frame (painting in ${slices} slices)`),
    });
  },
});

/**
 * Plays a density picture that develops: each frame adds points (`add`,
 * repeatedly) for its share of the budget and paints the histogram.
 * Painting (tone-mapping every pixel) can cost as much as the budget on a
 * modest machine: then each frame paints only every `slices`-th row, in
 * turn, so the cost is spread evenly and the rest of each frame still goes
 * to adding points.
 */
export function developing(o: {
  art: Density;
  palette: Palette;
  budget: Budget;
  revealMs: number;
  enough: () => boolean;
  add: (t: number) => void;
  log: (msPerFrame: number, slices: number) => void;
}): InterludePlayer {
  const { art, palette, budget, revealMs } = o;
  const clock = new Clock();
  let image: ReturnType<Graphics['createImageData']> | null = null;
  let rowMs = 0;
  let slices = 1;
  let spent = 0;
  let developed = false;
  return {
    frames: MAX_FRAMES,
    draw(g, i) {
      const start = now();
      const ms = budget.next(start);
      const t = clock.elapsed(i, start);
      image ??= g.createImageData(art.width, art.height);
      if (!o.enough()) {
        const spend = Math.max(2, ms - rowMs / slices);
        do o.add(t);
        while (now() - start < spend);
      }
      const p0 = now();
      if (i < 8 || i % 6 === 0) art.measure(palette.light ? 0.985 : 0.96);
      paint(art, image.data as Uint8ClampedArray, palette, t / revealMs, (t - revealMs) / 1000, i % slices, slices);
      const cost = (now() - p0) * slices;
      rowMs = rowMs ? rowMs * 0.8 + cost * 0.2 : cost;
      // Painting at most half the budget per frame.
      slices = Math.min(4, Math.max(1, Math.ceil(rowMs / (ms * 0.5))));
      g.putImageData(image, 0, 0);
      spent += now() - start;
      if (!developed && t >= revealMs) {
        developed = true;
        o.log(spent / (i + 1), slices);
      }
    },
  };
}

/**
 * The developing at progress `p` (0–1, then it stays developed): exposure
 * rising like a print in the tray; `after` seconds past it, a slow colour drift.
 */
export function paint(art: Density, out: Uint8ClampedArray, palette: Palette, p0: number, after: number, slice = 0, slices = 1): void {
  const p = Math.min(1, Math.max(0, p0));
  const e = p * p * (3 - 2 * p);
  const exposure = Math.pow(10, -2.5 * (1 - e));
  const shift = after > 0 ? (after / 240) % 1 : 0;
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
  preview: { poster: 'docs/julia.jpg', video: 'docs/julia.webm' },
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
    const loopMs = Math.max(2000, ctx.options.loopMs);
    const art = new Julia(width, height, palette, rng(seed), ctx.canvas);
    const budget = budgetFor(ctx.options.cpu);
    const clock = new Clock();
    ctx.log(`julia: ${art.describe()}`);
    let spent = 0;
    return {
      frames: MAX_FRAMES,
      draw(g, i) {
        const start = now();
        art.draw(g, (clock.elapsed(i, start) % loopMs) / loopMs, budget.next(start));
        spent += now() - start;
        if (i === FPS * 10) ctx.log(`julia: ${(spent / (i + 1)).toFixed(1)} ms a frame, at ${art.raster.describe()}`);
      },
    };
  },
});

const growLabel = { en: 'Growing time', es: 'Tiempo de crecimiento', de: 'Wachstumszeit', 'zh-Hans': '生长时间', 'zh-Hant': '生長時間' };

export const ferns = defineInterlude({
  id: 'ferns',
  name: { en: 'Fern meadow', es: 'Prado de helechos', de: 'Farnwiese', 'zh-Hans': '蕨类草地', 'zh-Hant': '蕨類草地' },
  description: {
    en: 'A row of Barnsley ferns growing along the bar, each with its own height, lean and curl, drawn point by point in the theme’s colours.',
    es: 'Una hilera de helechos de Barnsley que crecen a lo largo de la barra, cada uno con su altura, inclinación y rizo, dibujados punto a punto con los colores del tema.',
    de: 'Eine Reihe Barnsley-Farne, die entlang der Leiste wachsen, jeder mit eigener Höhe, Neigung und Krümmung, Punkt für Punkt in den Farben des Themas gezeichnet.',
    'zh-Hans': '一排巴恩斯利蕨沿着长条屏生长，每株高度、倾斜和卷曲各不相同，用主题颜色逐点绘出。',
    'zh-Hant': '一排巴恩斯利蕨沿著長條屏生長，每株高度、傾斜和捲曲各不相同，用主題顏色逐點繪出。',
  },
  icon: 'leaf',
  fps: FPS,
  preview: { poster: 'docs/ferns.jpg', video: 'docs/ferns.webm' },
  options: t.object({
    growMs: t.duration({
      default: 20_000,
      label: growLabel,
      help: {
        en: 'How long the ferns take to grow to their full height. Then they keep filling in until the interlude ends.',
        es: 'Cuánto tardan los helechos en alcanzar su altura. Después siguen rellenándose hasta que acaba el interludio.',
        de: 'Wie lange die Farne brauchen, um ihre volle Höhe zu erreichen. Danach werden sie weiter dichter, bis das Zwischenspiel endet.',
        'zh-Hans': '蕨类长到完整高度所需的时间。之后继续变得茂密，直到插曲结束。',
        'zh-Hant': '蕨類長到完整高度所需的時間。之後繼續變得茂密，直到插曲結束。',
      },
    }),
    cpu: cpuOption,
  }),
  async prepare(ctx) {
    const { width, height } = ctx;
    const seed = hashSeed(ctx.seed, 'ferns');
    const r = rng(seed);
    const palette = themePalette(ctx.theme, rng(seed ^ 0x2545f491));
    const art = new Ferns(plantFerns(r, width, height), width, height, r);
    const growMs = Math.max(1000, ctx.options.growMs);
    // Each fern grows over 55 % of the time, from its own start on.
    const grown = (at: number) => (f: Fern) => {
      const p = Math.min(1, Math.max(0, (at / growMs - f.start) / 0.55));
      return 1 - (1 - p) * (1 - p);
    };
    ctx.log(`ferns: ${art.ferns.length} ferns`);
    return developing({
      art,
      palette,
      budget: budgetFor(ctx.options.cpu),
      // Exposure comes up a little ahead of the growing, so new fronds show at once.
      revealMs: growMs * 0.6,
      enough: () => art.steps >= width * height * 300,
      add: (at) => art.iterate(8_000, grown(at)),
      log: (ms, slices) => ctx.log(`ferns: ${(art.steps / 1e6).toFixed(1)} M points, ${ms.toFixed(1)} ms a frame (painting in ${slices} slices)`),
    });
  },
});

export const mandelbrot = defineInterlude({
  id: 'mandelbrot',
  name: { en: 'Mandelbrot dive', es: 'Inmersión en Mandelbrot', de: 'Mandelbrot-Tauchgang', 'zh-Hans': '曼德博深潜', 'zh-Hant': '曼德博深潛' },
  description: {
    en: 'A slow zoom into the Mandelbrot set, towards seahorse valley or another famous spot on its edge, turning as it goes, in the theme’s colours.',
    es: 'Un zoom lento en el conjunto de Mandelbrot, hacia el valle de los caballitos de mar u otro rincón famoso de su borde, girando mientras avanza, con los colores del tema.',
    de: 'Ein langsamer Zoom in die Mandelbrot-Menge, ins Seepferdchental oder an eine andere berühmte Stelle ihres Randes, sich dabei drehend, in den Farben des Themas.',
    'zh-Hans': '缓缓放大曼德博集合，驶向海马谷或其边缘的其他著名位置，边前进边旋转，使用主题的颜色。',
    'zh-Hant': '緩緩放大曼德博集合，駛向海馬谷或其邊緣的其他著名位置，邊前進邊旋轉，使用主題的顏色。',
  },
  icon: 'zoom-in',
  fps: FPS,
  preview: { poster: 'docs/mandelbrot.jpg', video: 'docs/mandelbrot.webm' },
  options: t.object({
    zoomMs: t.duration({
      default: 40_000,
      label: { en: 'Dive time', es: 'Duración de la inmersión', de: 'Tauchdauer', 'zh-Hans': '深潜时长', 'zh-Hant': '深潛時長' },
      help: {
        en: 'How long it takes to go from the whole set to the deepest point (about a million times closer). Then it stays there, its colours drifting.',
        es: 'Cuánto tarda en ir del conjunto entero al punto más hondo (como un millón de veces más cerca). Después se queda ahí, con los colores derivando.',
        de: 'Wie lange es von der ganzen Menge bis zum tiefsten Punkt dauert (etwa millionenfach näher). Danach bleibt es dort, die Farben wandern.',
        'zh-Hans': '从整个集合放大到最深处（约一百万倍）所需的时间。之后停在那里，颜色缓慢流动。',
        'zh-Hant': '從整個集合放大到最深處（約一百萬倍）所需的時間。之後停在那裡，顏色緩慢流動。',
      },
    }),
    cpu: cpuOption,
  }),
  async prepare(ctx) {
    const { width, height } = ctx;
    const seed = hashSeed(ctx.seed, 'mandelbrot');
    const palette = themePalette(ctx.theme, rng(seed ^ 0x2545f491));
    const art = new Mandelbrot(width, height, palette, rng(seed), ctx.canvas);
    const zoomMs = Math.max(2000, ctx.options.zoomMs);
    const budget = budgetFor(ctx.options.cpu);
    const clock = new Clock();
    ctx.log(`mandelbrot: towards ${art.target.name}`);
    let spent = 0;
    let shown = 0;
    return {
      frames: MAX_FRAMES,
      draw(g, i) {
        const start = now();
        const at = clock.elapsed(i, start);
        art.draw(g, at / zoomMs, budget.next(start), Math.max(0, at - zoomMs) / 240_000);
        spent += now() - start;
        shown += art.recomputed;
        if (i === FPS * 10) ctx.log(`mandelbrot: ${(spent / (i + 1)).toFixed(1)} ms a frame, ${Math.round((shown / (i + 1) / (art.w * art.h)) * 100)} % of its pixels recomputed each frame`);
      },
    };
  },
});

export const coral = defineInterlude({
  id: 'coral',
  name: { en: 'Growing coral', es: 'Coral que crece', de: 'Wachsende Koralle', 'zh-Hans': '生长的珊瑚', 'zh-Hant': '生長的珊瑚' },
  description: {
    en: 'Coral branching up from the bottom of the bar, or frost hanging from the top, grown particle by particle (diffusion-limited aggregation), in the theme’s colours.',
    es: 'Coral que se ramifica desde el borde inferior de la barra, o escarcha que cuelga del superior, creciendo partícula a partícula (agregación limitada por difusión), con los colores del tema.',
    de: 'Koralle, die vom unteren Rand der Leiste aufwärts verzweigt, oder Raureif, der vom oberen herabhängt, Teilchen für Teilchen gewachsen (diffusionsbegrenzte Aggregation), in den Farben des Themas.',
    'zh-Hans': '珊瑚从长条屏底部向上分枝，或霜花从顶部垂下，逐粒生长（扩散限制凝聚），使用主题的颜色。',
    'zh-Hant': '珊瑚從長條屏底部向上分枝，或霜花從頂部垂下，逐粒生長（擴散限制凝聚），使用主題的顏色。',
  },
  icon: 'sprout',
  fps: FPS,
  preview: { poster: 'docs/coral.jpg', video: 'docs/coral.webm' },
  options: t.object({
    growMs: t.duration({
      default: 25_000,
      label: growLabel,
      help: {
        en: 'How long it takes to grow to its full size. On a slow machine it may grow slower than that.',
        es: 'Cuánto tarda en alcanzar su tamaño completo. En una máquina lenta puede crecer más despacio.',
        de: 'Wie lange es dauert, bis es seine volle Größe erreicht. Auf einem langsamen Rechner kann es langsamer wachsen.',
        'zh-Hans': '长到完整大小所需的时间。在较慢的机器上可能长得更慢。',
        'zh-Hant': '長到完整大小所需的時間。在較慢的機器上可能長得更慢。',
      },
    }),
    cpu: cpuOption,
  }),
  async prepare(ctx) {
    const { width, height } = ctx;
    const seed = hashSeed(ctx.seed, 'coral');
    const palette = themePalette(ctx.theme, rng(seed ^ 0x2545f491));
    const art = new Coral(width, height, palette, rng(seed), ctx.canvas);
    const growMs = Math.max(1000, ctx.options.growMs);
    const budget = budgetFor(ctx.options.cpu);
    const clock = new Clock();
    ctx.log(`coral: ${art.hanging ? 'hanging' : 'growing up'}`);
    let spent = 0;
    let full = false;
    return {
      frames: MAX_FRAMES,
      draw(g, i) {
        const start = now();
        const ms = budget.next(start);
        const p = Math.min(1, clock.elapsed(i, start) / growMs);
        // Paced by the particles it usually takes; if it needs more, it grows on.
        art.grow(p < 1 ? Math.ceil(art.expected * p) : art.cap, ms);
        art.draw(g);
        spent += now() - start;
        if (!full && art.grown) {
          full = true;
          ctx.log(`coral: grown, ${art.count} particles, ${(art.steps / 1e6).toFixed(1)} M steps, ${(spent / (i + 1)).toFixed(1)} ms a frame`);
        }
      },
    };
  },
});

export default definePlugin({
  id: 'fractals',
  name: { en: 'Fractals', es: 'Fractales', de: 'Fraktale', 'zh-Hans': '分形', 'zh-Hant': '碎形' },
  version: '0.2.1',
  description: {
    en: 'Generative fractal interludes in your theme’s colours: a fractal flame that develops like a photo, a morphing Julia set, a dive into the Mandelbrot set, a meadow of Barnsley ferns and growing coral.',
    es: 'Interludios de fractales generativos con los colores de tu tema: una llama fractal que se revela como una foto, un conjunto de Julia que se transforma, una inmersión en el conjunto de Mandelbrot, un prado de helechos de Barnsley y coral que crece.',
    de: 'Generative Fraktal-Zwischenspiele in den Farben deines Themas: eine fraktale Flamme, die sich wie ein Foto entwickelt, eine sich verwandelnde Julia-Menge, ein Tauchgang in die Mandelbrot-Menge, eine Wiese aus Barnsley-Farnen und wachsende Korallen.',
    'zh-Hans': '使用你的主题颜色的生成式分形插曲：像照片显影一样浮现的分形火焰、变幻的朱利亚集、深入曼德博集合的旅程、巴恩斯利蕨草地和生长的珊瑚。',
    'zh-Hant': '使用你的主題顏色的生成式碎形插曲：像照片顯影一樣浮現的碎形火焰、變幻的朱利亞集、深入曼德博集合的旅程、巴恩斯利蕨草地和生長的珊瑚。',
  },
  author: 'Loksly',
  license: 'MIT',
  homepage: 'https://github.com/kiosko-lcd/kiosko-plugin-fractals#readme',
  repository: 'https://github.com/kiosko-lcd/kiosko-plugin-fractals',
  sdk: '^0.2.0',
  languages: ['en', 'es', 'de', 'zh-Hant', 'zh-Hans'],
  permissions: {},
  icon: 'sparkles',
  category: 'scene',
  interludes: [flame, julia, mandelbrot, ferns, coral],
});
