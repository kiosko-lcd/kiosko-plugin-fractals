import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createBaseContext, themeById, validate, THEMES } from '@kiosko/sdk';
import { coral, ferns, flame, julia, mandelbrot } from './index.ts';
import { Coral } from './coral.ts';
import { plantFerns } from './ferns.ts';
import { Mandelbrot, TARGETS } from './mandelbrot.ts';
import { chooseGenome, Flame } from './flame.ts';
import { Julia } from './julia.ts';
import { parseHex, themePalette } from './palette.ts';
import { hashSeed, rng } from './rng.ts';

type Def = typeof flame | typeof julia | typeof ferns | typeof mandelbrot | typeof coral;

async function play(def: Def, { width = 640, height = 154, seed = 1, theme = 'midnight', frames = 30, options = {} as Record<string, unknown> } = {}) {
  const logs: string[] = [];
  const base = createBaseContext({ now: Date.now(), log: (m) => logs.push(m) });
  const player = await def.prepare({ ...base, options: validate(def.options!, options).value as never, width, height, seed, theme: themeById(theme), canvas: { createCanvas, loadImage } as never, sources: {} });
  assert.ok(player, logs.join('\n'));
  const canvas = createCanvas(width, height);
  const g = canvas.getContext('2d');
  const times: number[] = [];
  for (let i = 0; i < frames; i++) {
    const t0 = performance.now();
    await player.draw(g as never, i);
    times.push(performance.now() - t0);
  }
  return { g, times, player, logs, data: g.getImageData(0, 0, width, height).data };
}

/** Share of pixels that differ from the theme's background, and share that are pure white or black. */
function coverage(data: Uint8ClampedArray, bgHex: string) {
  const bg = parseHex(bgHex);
  let lit = 0, clipped = 0;
  const n = data.length / 4;
  for (let p = 0; p < data.length; p += 4) {
    const d = Math.abs(data[p]! - bg[0]) + Math.abs(data[p + 1]! - bg[1]) + Math.abs(data[p + 2]! - bg[2]);
    if (d > 24) lit++;
    if ((data[p]! > 250 && data[p + 1]! > 250 && data[p + 2]! > 250) || (data[p]! < 4 && data[p + 1]! < 4 && data[p + 2]! < 4)) clipped++;
  }
  return { lit: lit / n, clipped: clipped / n };
}

test('the same slot gives the same flame; another slot, another one', () => {
  const a = chooseGenome(hashSeed(7, 'flame'), 640, 154, 8, 4000);
  const b = chooseGenome(hashSeed(7, 'flame'), 640, 154, 8, 4000);
  const c = chooseGenome(hashSeed(8, 'flame'), 640, 154, 8, 4000);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  const f1 = new Flame(a, 640, 154, 7);
  const f2 = new Flame(b, 640, 154, 7);
  f1.iterate(50_000);
  f2.iterate(50_000);
  assert.deepEqual(f1.counts, f2.counts);
  assert.deepEqual(f1.colours, f2.colours);
  assert.ok(f1.plotted > 25_000, `most points land on the panel (${f1.plotted})`);
});

test('the palette comes from the theme: its accent first, and differs between slots', () => {
  for (const theme of THEMES) {
    const p = themePalette(theme, rng(1));
    assert.deepEqual(p.stops[0], parseHex(theme.colors.accent));
    assert.equal(p.light, theme.id === 'paper');
    assert.equal(p.lut.length, 1024 * 3);
  }
  const midnight = themeById('midnight');
  const seen = new Set(Array.from({ length: 8 }, (_, i) => JSON.stringify(themePalette(midnight, rng(i)).stops)));
  assert.ok(seen.size > 1);
});

test('the flame develops: faint at first, then it fills the bar without burning out, in every theme', async () => {
  for (const theme of THEMES) {
    const early = coverage((await play(flame, { theme: theme.id, frames: 2, options: { revealMs: 2000, cpu: 10 } })).data, theme.colors.bg);
    const { data } = await play(flame, { theme: theme.id, frames: 40, options: { revealMs: 2000, cpu: 10 } });
    const late = coverage(data, theme.colors.bg);
    assert.ok(early.lit < late.lit, `${theme.id}: it comes up (${early.lit.toFixed(3)} → ${late.lit.toFixed(3)})`);
    assert.ok(late.lit > 0.04, `${theme.id}: something to see (${late.lit.toFixed(3)})`);
    assert.ok(late.lit < 0.97, `${theme.id}: not a wash (${late.lit.toFixed(3)})`);
    assert.ok(late.clipped < 0.2, `${theme.id}: not burnt out (${late.clipped.toFixed(3)})`);
  }
});

test('a flame frame at panel size stays within its time budget', async () => {
  const { times } = await play(flame, { width: 1920, height: 462, frames: 24 });
  const steady = times.slice(2).sort((a, b) => a - b);
  const median = steady[Math.floor(steady.length / 2)]!;
  // The budget is 45 % of a 15 fps frame (30 ms) plus the painting, which it
  // spreads over two frames when it is slow; generous for a busy CI runner.
  assert.ok(median < 70, `median ${median.toFixed(1)} ms`);
  assert.ok(steady.at(-1)! < 250, `slowest ${steady.at(-1)!.toFixed(1)} ms`);
});

test('the Julia set loops perfectly, and is the same for the same slot', () => {
  const palette = themePalette(themeById('aurora'), rng(3));
  const a = new Julia(240, 58, palette, rng(hashSeed(5, 'julia')), { createCanvas, loadImage } as never);
  const b = new Julia(240, 58, palette, rng(hashSeed(5, 'julia')), { createCanvas, loadImage } as never);
  const img = (j: Julia, t: number) => {
    const out = new Uint8ClampedArray(240 * 58 * 4);
    j.render(out, 240, 58, t);
    return out;
  };
  assert.deepEqual(img(a, 0.3), img(b, 0.3));
  assert.deepEqual(img(a, 0), img(a, 1));
  assert.notDeepEqual(img(a, 0), img(a, 0.5));
  const [x0, y0] = a.c(0), [x1, y1] = a.c(1);
  assert.ok(Math.abs(x0 - x1) < 1e-12 && Math.abs(y0 - y1) < 1e-12);
});

test('the Julia set paints in every theme, neither empty nor burnt out, within its budget', async () => {
  for (const theme of THEMES) {
    const { data } = await play(julia, { theme: theme.id, frames: 6 });
    const c = coverage(data, theme.colors.bg);
    assert.ok(c.lit > 0.03 && c.clipped < 0.2, `${theme.id}: lit ${c.lit.toFixed(3)}, clipped ${c.clipped.toFixed(3)}`);
  }
  const { times } = await play(julia, { width: 1920, height: 462, frames: 20 });
  const steady = times.slice(3).sort((a, b) => a - b);
  assert.ok(steady[Math.floor(steady.length / 2)]! < 60, `median ${steady[Math.floor(steady.length / 2)]!.toFixed(1)} ms`);
});

test('the ferns stand along the whole bar, a different row each slot', () => {
  const a = plantFerns(rng(1), 1920, 462);
  assert.deepEqual(a, plantFerns(rng(1), 1920, 462));
  assert.notDeepEqual(a, plantFerns(rng(2), 1920, 462));
  assert.ok(a.length >= 5, `${a.length} ferns`);
  const xs = a.map((f) => f.x);
  assert.ok(Math.min(...xs) < 1920 * 0.15 && Math.max(...xs) > 1920 * 0.85, 'from one end to the other');
  for (const f of a) assert.ok(f.size > 462 * 0.7 && f.size < 462 * 1.1);
});

test('the Mandelbrot dive: the right counts, the right depth, and what it carries over matches what it computes', () => {
  assert.equal(Mandelbrot.escape(0, 0, 100), -1);
  assert.equal(Mandelbrot.escape(-1, 0, 100), -1);
  assert.equal(Mandelbrot.escape(-0.122, 0.745, 100), -1, 'inside the period-3 bulb');
  const out = Mandelbrot.escape(1, 1, 100);
  assert.ok(out > 0 && out < 4, `escapes at once (${out})`);
  const m = new Mandelbrot(320, 77, themePalette(themeById('midnight'), rng(1)), rng(4), { createCanvas, loadImage } as never, 1);
  assert.ok(TARGETS.includes(m.target));
  const start = m.view(0), end = m.view(1);
  assert.ok(start.span > 3 && end.span < 1e-5);
  assert.ok(Math.abs(end.cx - m.target.x) < 1e-12 && Math.abs(end.cy - m.target.y) < 1e-12, 'it ends at the target');
  // Well clear of double precision: a pixel is millions of ulps of the coordinates.
  assert.ok(end.span / 1920 > Math.abs(m.target.x) * 2 ** -52 * 1e5);
  // With all the time it wants, every frame is computed whole: the same as fresh.
  for (let i = 0; i <= 10; i++) m.update(i / 40, 1e9);
  const fresh = new Mandelbrot(320, 77, themePalette(themeById('midnight'), rng(1)), rng(4), { createCanvas, loadImage } as never, 1);
  fresh.update(10 / 40, 1e9);
  assert.deepEqual(m.values, fresh.values);
});

test('the coral grows from its roots, every particle touching the one it stuck to, the same for the same slot', () => {
  const grow = () => {
    const c = new Coral(640, 154, themePalette(themeById('paper'), rng(1)), rng(hashSeed(3, 'coral')), { createCanvas, loadImage } as never);
    c.grow(800, 1e9);
    return c;
  };
  const a = grow(), b = grow();
  assert.equal(a.count, 800);
  const pos = (c: Coral) => JSON.stringify([(c as never as { xs: Int16Array }).xs, (c as never as { ys: Int16Array }).ys]);
  assert.equal(pos(a), pos(b));
  const { xs, ys, parent } = a as never as { xs: Int16Array; ys: Int16Array; parent: Int32Array };
  for (let i = 0; i < a.count; i++) {
    const p = parent[i]!;
    if (p < 0) { assert.equal(ys[i], 0, 'roots on the edge'); continue; }
    assert.ok(Math.abs(xs[i]! - xs[p]!) <= 1 && Math.abs(ys[i]! - ys[p]!) <= 1, `particle ${i} touches its parent`);
  }
});

test('the new interludes paint in every theme, neither empty nor washed out', async () => {
  for (const [def, options] of [[ferns, { growMs: 1500, cpu: 10 }], [mandelbrot, { zoomMs: 4000, cpu: 20 }], [coral, { growMs: 1500, cpu: 20 }]] as const) {
    for (const theme of THEMES) {
      const { data } = await play(def, { theme: theme.id, frames: 30, options });
      const c = coverage(data, theme.colors.bg);
      // The dive fills the whole bar; the others leave background around them.
      const most = def === mandelbrot ? 1 : 0.95;
      assert.ok(c.lit > 0.02 && c.lit <= most && c.clipped < 0.3, `${def.id} in ${theme.id}: lit ${c.lit.toFixed(3)}, clipped ${c.clipped.toFixed(3)}`);
      const colours = new Set<number>();
      for (let p = 0; p < data.length; p += 4 * 7) colours.add((data[p]! << 16) | (data[p + 1]! << 8) | data[p + 2]!);
      assert.ok(colours.size > 40, `${def.id} in ${theme.id}: a picture, not a flat fill (${colours.size} colours)`);
    }
  }
});

test('the new interludes get ready quickly and keep their frames within budget at panel size', async () => {
  for (const def of [ferns, mandelbrot, coral]) {
    const t0 = performance.now();
    const { times } = await play(def, { width: 1920, height: 462, frames: 20 });
    const steady = times.slice(2).sort((a, b) => a - b);
    const median = steady[Math.floor(steady.length / 2)]!;
    assert.ok(median < 70, `${def.id}: median ${median.toFixed(1)} ms`);
    assert.ok(performance.now() - t0 < 20 * 250, `${def.id}: the whole run`);
  }
});
