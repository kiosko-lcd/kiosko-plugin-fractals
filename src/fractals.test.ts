import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createBaseContext, themeById, validate, THEMES } from '@kiosko/sdk';
import { flame, julia } from './index.ts';
import { chooseGenome, Flame } from './flame.ts';
import { Julia } from './julia.ts';
import { parseHex, themePalette } from './palette.ts';
import { hashSeed, rng } from './rng.ts';

type Def = typeof flame | typeof julia;

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
