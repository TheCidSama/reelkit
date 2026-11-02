---
name: reelkit
description: Make motion-graphics videos (mp4) from a single HTML file with the reelkit runtime and CLI. Use when the user asks for a promo video, product demo, launch or announcement video, animated explainer, stats/metrics recap, terminal or code demo, social clip (Reels/Shorts/TikTok 9:16), animated title card, or "turn this into a video".
---

# reelkit: motion graphics that don't look like AI slop

You write one `scene.html` that draws frames on a canvas with the reelkit runtime. reelkit renders it frame by frame in headless Chromium and encodes an H.264 mp4. Every frame is a pure function of time, so what you check in a still is exactly what ends up in the video.

Setup, once per project: `npm install github:thecidsama/reelkit`. The `reelkit` package on the npm registry is a different project, so install from GitHub before running `npx reelkit`.

## The loop (do not skip step 3)

1. **Scaffold**: `npx reelkit new my-video --template launch` (templates: `launch`, `stats`, `terminal`, `vertical`, `blank`). Start from the closest template, then rewrite its copy, palette and beats.
2. **Write the scene** (API below). Plan beats first: list each scene, its one message, and its duration.
3. **Look at it**: `npx reelkit frames my-video/scene.html --sheet -o my-video/sheet.png` gives one contact sheet of the whole video. Open the image and actually look. For details: `--at 2.5,stats,stats+1.2` (seconds, a scene's midpoint, or an offset into a scene), or `--scenes` for one settled still per scene.
4. **Fix** what you see: clipped or overlapping text, low contrast, empty frames, elements touching the edges, anything off-grid. Re-check those moments with `--at`.
5. **Render**: `npx reelkit render my-video/scene.html -o my-video/out.mp4` (`--audio music.m4a`, `--fps 30`, `--size 1280x720`, `--from 3 --to 6`). Report the output path, duration and size.

`npx reelkit preview scene.html` opens a live-reloading player with a scrubber for humans. `npx reelkit doctor` diagnoses browser/ffmpeg problems.

## Scene skeleton

```html
<!doctype html><html><head><meta charset="utf-8"></head><body>
<script type="module">
import { reel, rgba, ease, clamp, lerp } from '/reelkit/reel.js';
const BG = '#0b0b10', INK = '#f2f1f7', DIM = '#8b8a99', ACCENT = '#9b87ff';
reel({ width: 1920, height: 1080, fps: 60, background: BG, grain: 0.04, vignette: 0.35 })
  .scene('hook', 3, s => {
    s.bg({ radial: ['#17142b', BG] });
    s.words('Ship it *today.*', { x: s.cx, y: 560, size: 140, weight: 800, align: 'center', at: 0.3, accent: ACCENT, exit: 2.6 });
  })
  .scene('proof', 4, s => { /* ... */ }, { transition: 'whip' })
  .start();
</script></body></html>
```

`s.t` is seconds since the scene started, `s.dur` its length, `s.p` = t/dur, `s.w/s.h/s.cx/s.cy` the design size and centre. Text `y` is the baseline. Never use `Date.now()`, `Math.random()` or state that carries between frames: use `s.rng(seed)`, `s.wiggle()`, `s.tween()`.

## API cheat sheet

- Time: `s.tween(at, dur, ease)` -> 0..1 · `s.spring(at, 'snappy'|'gentle'|'bouncy'|{stiffness,damping})` · `s.keys([[t, value, ease], ...])` (numbers, `{x,y,zoom}` objects, colours) · `s.out(dur)` exit progress at scene end.
- Type: `s.text` · `s.words(str, {at, stagger, style: 'blur'|'rise'|'mask'|'pop', exit, marks:[{word, at}], maxWidth})` (`*accent*` spans, `\n`) · `s.chars` (per-letter spring) · `s.type(str, {at, cps, cursor})` · `s.odometer(value, {at, dur, decimals, prefix, suffix})` · `s.rotator([...words])` · `s.marker({x,y,w,h,at})`.
- Shapes: `s.card({x,y|cx,cy,w,h,r,fill,shadow:'soft'|'lift'})` · `s.pill(label, {...})` · `s.tilt({cx,cy,w,h,rx,ry}, (c,w,h) => ...)` 2.5D card · `s.glow` · `s.roundRect` + `s.ctx` for anything custom.
- Charts: `s.bars(values, {...})` · `s.lineChart(points, {...})` · `s.ring(0..1, {...})`.
- Space: `s.camera({x, y, zoom, rotate, shake}, () => ...)` · `s.layer({x, y, scale, rotate, alpha, blur, origin}, () => ...)`.
- Background: `s.bg(color | {from,to,angle} | {radial:[a,b]})` · `s.aurora({colors})` · `s.grid()` · `s.dust()` · `s.particles({at, shape:'spark'|'confetti'|'dot'})`.
- Transitions (on the incoming scene): `fade`, `whip` (motion-blurred; `direction`), `zoom`, `wipe` (`angle`), `iris` (`x`,`y`), `push`, `cut`. They overlap the scenes by their duration.
- Motion blur for fast scenes: `reel({ motionBlur: { samples: 6, shutter: 0.5 } })` or per scene `{ motionBlur: true }` (costs ~samples x render time).

## Taste: what separates designed motion from slop

**Timing**
- One idea per beat. A beat is 2.5–4 s. Hold every important line, still, for at least 1–1.5 s after it lands. If a viewer can't read it twice, it's too short.
- Overlap, don't queue: the next element starts while the previous one is still settling (stagger 40–90 ms for words, 100–180 ms for cards).
- Entrances are fast (0.4–0.8 s), exits faster (0.25–0.4 s). Leave each scene with an exit or a transition, never a hard stop mid-animation.
- Anticipate big moves: a short hold, then the move. Land on the beat of the music if there is audio.

**Easing**
- Entrances: `outExpo` / `outQuint` (fast start, long soft landing). Exits: `in` (accelerate away). Moves between two rests: `inOutQuint` / `inOutExpo`.
- Springs for things that "arrive" (cards, logos, badges): `snappy` for UI, `gentle` for large objects, `bouncy` only for one playful hero moment.
- Never `linear` for position. Linear is for progress bars and clocks only.

**Type**
- Two sizes per frame, max three. Headline 96–160 px at 1080p (more in 9:16), support 32–44 px, labels 20–26 px with tracking `0.08` in caps.
- Headlines heavy (700–850) with slight negative tracking (default). Support text weight 500 in a dimmer colour.
- Max ~8 words on screen at once. Emphasise one word (accent or marker), not three.

**Palette**
- One background, one ink, one dim ink, one accent. A second accent only for data (up/down, categories).
- Contrast: body text >= 4.5:1 against its background. Dim text is for secondary info, never for the message.
- Dark scenes: lift the background with a subtle radial gradient + grain; pure #000 flats look cheap. Light scenes: warm off-white (#f4f1ea), not #fff.

**Layout**
- Safe area: keep text 120 px from the edges at 1920x1080. For 9:16 (1080x1920) keep content between y=260 and y=1500 (platform UI covers the rest).
- Align to a grid: shared left edges or a single centred axis per scene. Don't mix both in one frame.
- Every scene needs one focal point. Use size, colour or motion to make it obvious, and keep everything else quieter.

**What looks cheap (avoid)**
- Everything fading in at once; everything moving at the same speed; bouncing everything.
- Text that slides in from far off-screen; spinning or rotating text; rainbow gradients; drop shadows on text over flat colour.
- Emoji as icons, stock-looking clip art, more than ~3 colours, crowded frames, centred paragraphs.
- Dead frames: nothing moving for > 2 s. Keep a slow camera push (`zoom` 1 -> 1.05) or ambient `aurora`/`dust` under holds.
- Camera moves without motion blur when they're fast: use `whip` or turn on `motionBlur` for that scene.

## Gotchas
- Import path is `/reelkit/reel.js` (served by the CLI). Open scenes through `reelkit preview`, not `file://`.
- Fonts: `sans` (Inter), `display` (Archivo), `mono` (JetBrains Mono) are bundled; pass `font: 'mono'` etc. Custom fonts: `reel({ fonts: { 'Brand': 'brand.woff2' } })`. Images: `reel({ images: { logo: 'logo.png' } })` then `s.image('logo', {...})`.
- Any page error fails the render loudly with the time it happened; read the message and fix the scene.
- Lay out relative to `s.w`, `s.h`, `s.cx`, `s.cy` so `--size` with another aspect still works.
