# kiosko-plugin-fractals

Generative fractals as interludes, in your theme's colours: a **fractal
flame** that develops on the panel like a photo in the developer, from faint
dust to glowing filaments, and a **Julia set** that twists and turns as its
parameter walks around the Mandelbrot set. Each time slot paints a different
piece; the same slot always paints the same one.

A plugin for [Kiosko](https://github.com/kiosko-lcd/kiosko), the widget mosaic
for small USB LCD panels. **Optional:** Kiosko doesn't install it.

## Install

```sh
npm install --prefix ~/.config/kiosko/plugins kiosko-plugin-fractals
```

(macOS: `~/Library/Application Support/Kiosko/plugins`, Windows: `%APPDATA%\Kiosko\plugins`.)

Then add an interlude to a screen: **Screens → Interludes → Fractal flame**
(or **Morphing Julia**). Like any interlude it plays at its time slot (every
15 min = at :00, :15, :30, :45) for up to `maxSeconds`, or right away from the
editor or Home Assistant. 30 s suits both.

## What it does on your machine

Nothing beyond computing: no network, no files, no programs. Pure
TypeScript, drawn on the canvas Kiosko provides.

It takes a share of the processor while it plays (`cpu`, 40 % of each frame
by default), and less by itself when frames come late. Getting ready takes
about a third of a second for the flame (choosing a composition that fills
the bar), a few milliseconds for the Julia set. Memory: two histograms of the
panel's size for the flame (about 7 MB at 1920×462), a small canvas for the
Julia set.

## What it does

**The flame** is Scott Draves' algorithm, the one behind Apophysis and
Electric Sheep: the chaos game over two to four random affine maps, each bent
by a blend of nonlinear variations (sinusoidal, spherical, swirl, horseshoe,
polar, julia, spiral, disc…), sometimes with a mirror or a rotation for
symmetry. Of a couple of dozen candidates it keeps the one that best fills a
wide bar, and turns it so its long axis lies along the panel. The points are
gathered in a density histogram and shown with log-density and gamma, so
they come up like a print in the tray; the densest cores burn towards the
theme's ink (light on dark themes, dark on `paper`). The points are computed
while it plays, as many as fit in each frame's share, so the picture keeps
sharpening; once developed, its colours drift slowly.

**The Julia set** follows c just outside the main cardioid of the Mandelbrot
set, so it goes from sea horses to spirals to dust and back, and comes back
exactly where it started (a perfect loop). The view turns with the set so it
lies along the bar. Colour by continuous (smooth) iteration count; inside the
set, quiet ripples by an orbit trap. It is computed at the fraction of the
panel's resolution that fits the frame's time, then scaled up.

Colours come from the theme: its accent and a few of its other colours, in a
different selection and order for each slot.

## Interludes

### Fractal flame — `fractals/flame`

| Option | Type | Default | |
|---|---|---|---|
| `revealMs` | duration | `20000` | How long it takes to come up fully. Then it keeps sharpening and its colours drift slowly until the interlude ends. |
| `cpu` | integer, % (advanced) | `40` | How much of each frame's time goes to computing it. Lowers by itself when frames come late. |

### Morphing Julia — `fractals/julia`

| Option | Type | Default | |
|---|---|---|---|
| `loopMs` | duration | `30000` | How long one trip around the Mandelbrot set takes; then it starts again exactly where it began. |
| `cpu` | integer, % (advanced) | `40` | How much of each frame's time goes to computing it (and so the resolution). |

## Testing

`npm test`: the same slot gives the same piece, the flame comes up and fills
the bar without burning out in every theme, the Julia set loops exactly,
frames stay within their time budget.

## Licence

MIT.
