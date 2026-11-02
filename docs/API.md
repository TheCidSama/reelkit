# reelkit API

A scene is an HTML file with one module script:

```js
import { reel } from '/reelkit/reel.js';
reel({ width: 1920, height: 1080, fps: 60 })
  .scene('name', seconds, s => { /* draw with s */ }, { transition })
  .overlay(s => { /* drawn above every scene, in global time */ })
  .start();
```

`/reelkit/reel.js` is served by `reelkit render | frames | preview`. The file lives at `runtime/reel.js` if you want to import it relatively.

## `reel(options)`

| option | default | |
|---|---|---|
| `width`, `height` | 1920, 1080 | design size in px. `--size` rescales the output; if the aspect differs, `s.w`/`s.h` grow along the extra axis |
| `fps` | 60 | overridden by `--fps` |
| `background` | `#000` | under every scene |
| `motionBlur` | `false` | `{ samples: 6, shutter: 0.5 }` supersamples every frame (shutter is a fraction of a frame interval: 0.5 = 180°). Per-scene override: `scene(..., { motionBlur: true \| false \| {...} })` |
| `grain` | 0 | film grain strength, ~0.03–0.06; changes every frame deterministically |
| `vignette` | 0 | edge darkening, ~0.3–0.5 |
| `fonts` | bundled | `false` to skip the bundled fonts, or `{ 'Family': 'file.woff2' }` / `{ 'Family': ['file.woff2', { weight: '400 700' }] }` to add your own |
| `images` | `{}` | `{ logo: 'logo.png' }`, loaded before the first frame; draw with `s.image('logo', ...)` |
| `duration` | sum of scenes | override the total length |

`.scene(name, duration, draw, opts)`: `opts.transition` is a name or `{ type, duration, ease, ...typeOptions }` and describes how this scene *enters*. The transition overlaps the previous scene by its duration (total = sum of durations − sum of transition durations). `opts.motionBlur` overrides the reel setting.

`.start()` loads fonts and images and exposes the render contract: `window.READY` (promise), `window.END` (seconds), `window.FPS`, `window.renderFrame(t)`, `window.__reel` (metadata incl. scene start/end times). Any page that exposes that contract and draws to `<canvas id="c">` can be rendered by the CLI, with or without this runtime.

URL flags: `?render` (CLI), `?preview` (preview UI), `?t=3.2` (freeze one moment when opened directly), `?fps=30`, `?size=1280x720`.

## The frame object `s`

| field | |
|---|---|
| `s.t` | seconds since this scene started (0..`dur`; a scene's duration includes its transition overlaps) |
| `s.T` | global time |
| `s.dur`, `s.p` | scene length, `t / dur` clamped |
| `s.w`, `s.h`, `s.cx`, `s.cy` | design size and centre |
| `s.ctx` | the CanvasRenderingContext2D (already scaled to design px) |
| `s.fps`, `s.name`, `s.images` | |

Text `y` is the alphabetic baseline unless you pass `baseline`. Colours are any CSS colour; helpers that compute alpha need `#hex` or `rgb()`.

### Time

- `s.tween(at, dur = 0.6, ease = 'out')` → eased 0..1.
- `s.spring(at, preset | { stiffness, damping, mass, velocity })` → 0..1 with physical overshoot. Presets: `smooth` (critical), `gentle`, `snappy`, `bouncy`, `wobbly`.
- `s.keys([[t, value, ease?], ...])` → keyframes in scene time. Values: number, array, object of numbers, or colour. The ease on a key shapes the segment that arrives at it (default `inOut`).
- `s.out(dur = 0.5, ease = 'in')` → 0 until `dur` before the end, then 0..1.
- `s.between(a, b)`, `s.wiggle(freq, amp, seed)` (smooth noise in global time), `s.rng(seed)`.

### Structure

- `s.layer({ x, y, scale, scaleX, scaleY, rotate, alpha, blur, origin: [x, y] }, () => ...)` group transform.
- `s.camera({ x, y, zoom, rotate, shake, shakeSpeed }, () => ...)`: puts world point (x, y) at the centre. `shake` is a handheld drift amplitude in px.

### Type

- `s.text(str, { x, y, size, weight, font: 'sans'|'display'|'mono'|family, color, align, baseline, alpha, blur, tracking (em), stretch, shadow: {blur,y,color}, glow: color })` → width.
- `s.measure(str, fontOpts)`, `s.font(fontOpts)`.
- `s.words(str, { x, y, size, at, stagger = 0.07, dur = 0.7, style = 'blur'|'rise'|'mask'|'pop', color, accent, align, maxWidth, lineHeight, exit, exitStagger, exitDur, marks: [{ word, at, dur, color }] })`. `*accent*` (may span words) uses `accent`; `\n` breaks lines; `marks` sweep a highlighter behind a word. Returns the layout (`boxes`, `width`, `height`).
- `s.layoutWords(str, opts)`: the same layout without drawing.
- `s.chars(str, { x, y, size, at, stagger = 0.035, springPreset = 'bouncy', rise, rotate })`: per-letter spring pop.
- `s.type(str, { x, y, size, at, cps = 24, cursor: true | 'bar', color, cursorColor, font = 'mono', hideCursorAfter, seed })` → `{ shown, n, done, width, end }`. Rhythm is human-ish and deterministic (`typingTimes(str, cps, seed)` gives the per-character times, e.g. for key-click sound effects).
- `s.odometer(value, { x, y, size, at, dur = 1.6, from = 0, decimals, separator = ',', prefix, suffix, align, easing = 'outExpo', blur = true })`: a true odometer (higher digits roll on carry), with vertical motion blur and leading digits that grow in. Non-negative values.
- `s.rotator(words, { x, y, size, at, every = 1.1, dur = 0.55, align, loop })`: kinetic word swap.
- `s.marker({ x, y, w, h, at, dur, color, skew, radius })`: highlighter sweep; draw before the text.

### Shapes and images

- `s.card({ x, y | cx, cy, w, h, r, fill (colour or {from,to}), stroke, strokeWidth, shadow: 'soft'|'lift'|false|[[x,y,blur,alpha],...], shadowColor, highlight, alpha })`.
- `s.pill(label, { x, y | cx, cy, size, fill, color, stroke, dot: colour, weight, font })` → box.
- `s.tilt({ cx, cy, w, h, rx, ry, rz, scale, perspective = 1800, shade, shadow }, (ctx, w, h) => ...)`: draws the callback into an offscreen card and projects it with perspective (2.5D). Inside the callback, `s.*` helpers draw onto the card.
- `s.image(name, { x, y | cx, cy, w, h, r, fit: 'cover'|'contain'|'fill', alpha })`.
- `s.glow(x, y, r, color, alpha)`, `s.roundRect(x, y, w, h, r)` (path only).

### Backgrounds and particles

- `s.bg('#hex' | { from, to, angle } | { stops: [...], angle } | { radial: [inner, ..., outer], x, y, r })` fills the frame (ignores camera).
- `s.aurora({ colors, intensity, speed, size, seed, blend })`: drifting soft colour fields.
- `s.grid({ spacing, color, dot, lines, x0, y0, x1, y1 })`.
- `s.dust({ count, color, alpha, size, speed, seed })`: ambient motes.
- `s.particles({ x, y, at, count, speed, life, colors, gravity, drag, spread, angle, size, seed, shape: 'spark'|'confetti'|'dot' })`: deterministic burst.

### Charts

- `s.bars(values, { x, y, w, h, at, stagger, dur, color, colors, gap, r, max, labels, labelColor, labelSize, valueLabels, format, highlight: index, highlightColor })`.
- `s.lineChart(points, { x, y, w, h, at, dur, color, width, fill, min, max, easing, head, smooth })`.
- `s.ring(value0to1, { cx, cy, r, width, at, dur, color, track, easing })`.

## Transitions

`fade` (exact premultiplied crossfade), `whip` (`direction: left|right|up|down`, motion-blurred), `push`, `zoom` (zoom-through, motion-blurred), `wipe` (`angle`, `softness`, `color` of the light edge, `edge: false`), `iris` (`x`, `y` in 0..1, `softness`), `cut`. Common options: `duration`, `ease`, `blur` (shutter in frames for the blurred ones), `samples`.

Custom: `transitions.myname = { blur: 0, draw(ctx, A, B, k, opts, scratch) { ... } }` where A/B are the outgoing/incoming scene canvases and `k` goes 0..1.

## Pure helpers (also importable in Node)

`clamp, lerp, invlerp, remap, smoothstep, ease, toEase, tween, spring, springs, springDuration, keys, stagger, hash, rng, noise, wiggle, rgba, mix, typingTimes, layoutScenes, fonts, transitions`.

Easings: `linear in out inOut inQuad outQuad inQuint outQuint inOutQuint inExpo outExpo inOutExpo inOutSine outBack inBack outElastic smooth snap`, plus `ease.bezier(x1, y1, x2, y2)`.

## Determinism

- Frames depend only on `t`: no wall clock, seeded randomness, no state between frames. Motion blur, transitions and grain are all derived from `t`.
- Fonts are bundled and loaded before `READY`, so text metrics don't depend on the machine's installed fonts (only glyphs outside the bundled Latin sets fall back to system fonts).
- Workers render interleaved frames in separate pages; because frames are pure, the result is identical to a single-worker render. The test suite checks that the same `t` hashes to the same pixels across browser sessions and when frames are rendered out of order.
- Across different machines/GPUs/Chromium versions, anti-aliasing can differ by a few pixel values; reelkit pins the Playwright Chromium revision to keep that stable.

## CLI

```
reelkit render  <scene.html> [-o out.mp4] [--fps 60] [--size 1920x1080] [--from s] [--to s]
                [--workers N] [--audio file] [--crf 20] [--preset medium] [--png] [--quality 0.95]
reelkit frames  <scene.html> (--at 1.2,intro,stats+0.5,end | --every 1 | --scenes | --sheet [--count 12 --cols 4]) [-o dir|sheet.png] [--jpg]
reelkit preview <scene.html> [--port 4747] [--no-open]
reelkit new     <name> [--template launch|stats|terminal|vertical|blank] [--force]
reelkit doctor
```

Environment: `REELKIT_CHROME` (browser executable), `REELKIT_FFMPEG` / `FFMPEG_PATH`.

Programmatic: `import { render, frames, preview, scaffold, doctor, probe } from 'reelkit'`.
