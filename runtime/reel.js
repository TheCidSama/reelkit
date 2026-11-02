// reelkit runtime: a tiny, deterministic motion-graphics engine for <canvas>.
//
//   import { reel } from '/reelkit/reel.js';
//   reel({ width: 1920, height: 1080, fps: 60 })
//     .scene('hello', 3, s => { s.bg('#0b0b10'); s.words('Hello *world*', { x: s.cx, y: s.cy, size: 120, align: 'center' }); })
//     .start();
//
// Everything is a pure function of time: renderFrame(t) always draws the same pixels for the same t.
// No Date.now(), no Math.random() (use rng(seed)), no state carried between frames.
// Docs: docs/API.md. The math half of this file has no DOM dependency and runs in Node.

// ───────────────────────────── math ─────────────────────────────

export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, k) => a + (b - a) * k;
/** 0..1 position of v between a and b (unclamped). */
export const invlerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
/** Remap v from [a0,a1] to [b0,b1], clamped. */
export const remap = (v, a0, a1, b0, b1) => lerp(b0, b1, clamp(invlerp(a0, a1, v)));
export const smoothstep = (a, b, v) => { const k = clamp(invlerp(a, b, v)); return k * k * (3 - 2 * k); };

function bezier(x1, y1, x2, y2) {
  // CSS cubic-bezier, solved by Newton + bisection fallback.
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = u => ((ax * u + bx) * u + cx) * u, sy = u => ((ay * u + by) * u + cy) * u;
  const dx = u => (3 * ax * u + 2 * bx) * u + cx;
  return k => {
    if (k <= 0) return 0;
    if (k >= 1) return 1;
    let u = k;
    for (let i = 0; i < 8; i++) {
      const e = sx(u) - k, d = dx(u);
      if (Math.abs(e) < 1e-7) return sy(u);
      if (Math.abs(d) < 1e-6) break;
      u -= e / d;
    }
    let lo = 0, hi = 1; u = k;
    for (let i = 0; i < 40; i++) { const v = sx(u); if (Math.abs(v - k) < 1e-7) break; if (v < k) lo = u; else hi = u; u = (lo + hi) / 2; }
    return sy(u);
  };
}

/** Easing functions, all mapping 0..1 -> 0..1 (back/elastic overshoot). */
export const ease = {
  linear: k => k,
  in: k => k * k * k,
  out: k => 1 - (1 - k) ** 3,
  inOut: k => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2),
  inQuad: k => k * k,
  outQuad: k => 1 - (1 - k) * (1 - k),
  inQuint: k => k ** 5,
  outQuint: k => 1 - (1 - k) ** 5,
  inOutQuint: k => (k < 0.5 ? 16 * k ** 5 : 1 - (-2 * k + 2) ** 5 / 2),
  inExpo: k => (k <= 0 ? 0 : 2 ** (10 * k - 10)),
  outExpo: k => (k >= 1 ? 1 : 1 - 2 ** (-10 * k)),
  inOutExpo: k => (k <= 0 ? 0 : k >= 1 ? 1 : k < 0.5 ? 2 ** (20 * k - 10) / 2 : (2 - 2 ** (-20 * k + 10)) / 2),
  inOutSine: k => 0.5 - 0.5 * Math.cos(Math.PI * k),
  outBack: k => { const c = 1.70158; return 1 + (c + 1) * (k - 1) ** 3 + c * (k - 1) ** 2; },
  inBack: k => { const c = 1.70158; return (c + 1) * k ** 3 - c * k * k; },
  outElastic: k => (k <= 0 ? 0 : k >= 1 ? 1 : 2 ** (-10 * k) * Math.sin((k * 10 - 0.75) * (2 * Math.PI / 3)) + 1),
  /** Apple-ish "ease" curves. */
  smooth: bezier(0.4, 0, 0.2, 1),
  snap: bezier(0.2, 0.9, 0.1, 1),
  bezier,
};

/** Accepts an easing function or a name from `ease`. */
export function toEase(e) {
  if (typeof e === 'function') return e;
  if (e == null) return ease.out;
  const f = ease[e];
  if (!f || e === 'bezier') throw new Error(`reelkit: unknown easing "${e}". Try one of: ${Object.keys(ease).filter(n => n !== 'bezier').join(', ')}`);
  return f;
}

/** Eased 0..1 progress of a window that starts at `start` and lasts `dur`. */
export function tween(t, start, dur, easing = 'out') {
  if (dur <= 0) return t >= start ? 1 : 0;
  return toEase(easing)(clamp((t - start) / dur));
}

/** Named spring presets. stiffness/damping/mass like every physics spring you know. */
export const springs = {
  smooth: { stiffness: 170, damping: 26, mass: 1 },   // critically damped, no overshoot
  gentle: { stiffness: 120, damping: 14, mass: 1 },   // soft, a touch of overshoot
  snappy: { stiffness: 400, damping: 30, mass: 1 },   // quick, tiny overshoot: UI pops
  bouncy: { stiffness: 300, damping: 12, mass: 1 },   // playful, visible wobble
  wobbly: { stiffness: 180, damping: 8, mass: 1 },
};

/**
 * Damped harmonic oscillator, solved analytically (exact for any t, no simulation drift).
 * Returns the position at time t (seconds since release), travelling from `from` to `to`.
 */
export function spring(t, opts = {}) {
  const o = typeof opts === 'string' ? springs[opts] : { ...(springs[opts.preset] || springs.gentle), ...opts };
  if (!o) throw new Error(`reelkit: unknown spring preset "${opts}"`);
  const { stiffness: k = 170, damping: c = 26, mass: m = 1, from = 0, to = 1, velocity: v0 = 0 } = o;
  if (t <= 0) return from;
  const x0 = from - to, w0 = Math.sqrt(k / m), z = c / (2 * Math.sqrt(k * m));
  let x;
  if (z < 1) {
    const wd = w0 * Math.sqrt(1 - z * z);
    x = Math.exp(-z * w0 * t) * (x0 * Math.cos(wd * t) + ((v0 + z * w0 * x0) / wd) * Math.sin(wd * t));
  } else if (z === 1) {
    x = (x0 + (v0 + w0 * x0) * t) * Math.exp(-w0 * t);
  } else {
    const s = Math.sqrt(z * z - 1), r1 = -w0 * (z - s), r2 = -w0 * (z + s);
    const c2 = (v0 - r1 * x0) / (r2 - r1), c1 = x0 - c2;
    x = c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t);
  }
  return to + x;
}

/** Seconds until a spring stays within `eps` of its target (sampled at 1 ms). */
export function springDuration(opts = {}, eps = 0.001) {
  let last = 0;
  for (let i = 1; i <= 10000; i++) {
    const t = i / 1000;
    if (Math.abs(spring(t, { ...(typeof opts === 'string' ? springs[opts] : opts), from: 0, to: 1 }) - 1) > eps) last = t;
    else if (t - last > 0.25) break;
  }
  return last;
}

function parseColor(c) {
  if (Array.isArray(c)) return c.length === 3 ? [...c, 1] : c;
  if (typeof c !== 'string') throw new Error(`reelkit: bad colour ${c}`);
  if (c[0] === '#') {
    let h = c.slice(1);
    if (h.length <= 4) h = [...h].map(x => x + x).join('');
    const n = parseInt(h.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1];
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
  throw new Error(`reelkit: can't parse colour "${c}" (use #hex or rgb())`);
}
/** Colour with alpha: rgba('#7c5cff', .4) -> 'rgba(124,92,255,0.4)'. */
export function rgba(c, a = 1) { const [r, g, b, a0] = parseColor(c); return `rgba(${r},${g},${b},${+(a0 * a).toFixed(4)})`; }
/** Mix two colours in sRGB. */
export function mix(a, b, k) {
  const A = parseColor(a), B = parseColor(b);
  const r = A.map((v, i) => lerp(v, B[i], clamp(k)));
  return `rgba(${Math.round(r[0])},${Math.round(r[1])},${Math.round(r[2])},${+r[3].toFixed(4)})`;
}

/**
 * Keyframes: keys(t, [[0, 0], [1, 100, 'outExpo'], [2, 40]]).
 * Values may be numbers, arrays, {objects} of numbers, or colours. The easing on a key shapes the segment arriving at it.
 */
export function keys(t, frames) {
  if (!frames.length) throw new Error('reelkit: keys() needs at least one keyframe');
  if (t <= frames[0][0]) return frames[0][1];
  for (let i = 1; i < frames.length; i++) {
    const [t1, v1, e = 'inOut'] = frames[i];
    if (t <= t1) {
      const [t0, v0] = frames[i - 1];
      return interp(v0, v1, toEase(e)(clamp(invlerp(t0, t1, t))));
    }
  }
  return frames[frames.length - 1][1];
}
function interp(a, b, k) {
  if (typeof a === 'number') return lerp(a, b, k);
  if (typeof a === 'string') return mix(a, b, k);
  if (Array.isArray(a)) return a.map((v, i) => interp(v, b[i], k));
  if (a && typeof a === 'object') { const o = {}; for (const key in a) o[key] = key in b ? interp(a[key], b[key], k) : a[key]; return o; }
  return k < 1 ? a : b;
}

/** Start time of item i in a stagger. */
export const stagger = (i, each = 0.06, start = 0) => start + i * each;

/** 32-bit integer hash -> [0, 1). */
export function hash(...n) {
  let h = 0x9e3779b9;
  for (const v of n) {
    h ^= Math.imul((v * 1000003) | 0, 0x85ebca6b) + 0x68e31da4;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h = Math.imul(h ^ (h >>> 12), 0x297a2d39); h ^= h >>> 15;
  }
  return (h >>> 0) / 4294967296;
}

/** Seeded PRNG (mulberry32). rng(7)() -> [0,1); also .range(a,b), .int(a,b), .pick(arr), .sign(). */
export function rng(seed = 1) {
  let s = (seed * 2654435761) >>> 0;
  const r = () => {
    s = (s + 0x6d2b79f5) >>> 0; let q = s;
    q = Math.imul(q ^ (q >>> 15), q | 1); q ^= q + Math.imul(q ^ (q >>> 7), q | 61);
    return ((q ^ (q >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (a, b) => lerp(a, b, r());
  r.int = (a, b) => Math.floor(lerp(a, b + 1, r()));
  r.pick = arr => arr[Math.floor(r() * arr.length)];
  r.sign = () => (r() < 0.5 ? -1 : 1);
  return r;
}

/** Smooth 1-D value noise in [-1, 1]. */
export function noise(x, seed = 0) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return lerp(hash(i, seed) * 2 - 1, hash(i + 1, seed) * 2 - 1, u);
}
/** Organic drift: a few octaves of noise. freq in Hz, result in [-amp, amp]. */
export function wiggle(t, freq = 1, amp = 1, seed = 0) {
  return amp * (noise(t * freq, seed) * 0.6 + noise(t * freq * 2.13, seed + 17) * 0.28 + noise(t * freq * 4.37, seed + 41) * 0.12);
}

// Natural typing rhythm: per-character offsets (seconds) for a string typed at ~cps chars/sec.
export function typingTimes(str, cps = 22, seed = 3) {
  const chars = [...str];
  let acc = 0;
  return chars.map((ch, i) => {
    let w = 0.65 + 0.7 * hash(i, seed);
    if (ch === ' ') w += 0.35;
    if (/[.,:;!?]/.test(ch)) w += 0.6;
    acc += w / cps;
    return acc;
  });
}

/** Timeline maths, shared with the CLI and tests. */
export function layoutScenes(list) {
  let start = 0;
  return list.map((sc, i) => {
    const tr = i > 0 ? sc.transition : null;
    if (tr && tr.duration > Math.min(sc.duration, list[i - 1].duration)) {
      throw new Error(`reelkit: transition into "${sc.name}" (${tr.duration}s) is longer than a neighbouring scene`);
    }
    if (i > 0) start -= tr ? tr.duration : 0;
    const out = { ...sc, start, end: start + sc.duration };
    start += sc.duration;
    return out;
  });
}

// ───────────────────────────── fonts ─────────────────────────────

const FONT_DIR = new URL('./fonts/', import.meta.url);
const BUILTIN_FONTS = [
  ['Inter', 'Inter.ttf', { weight: '100 900' }],
  ['Archivo', 'Archivo.ttf', { weight: '100 900', stretch: '62% 125%' }],
  ['JetBrains Mono', 'JetBrainsMono-400.woff2', { weight: '400' }],
  ['JetBrains Mono', 'JetBrainsMono-500.woff2', { weight: '500 600' }],
  ['JetBrains Mono', 'JetBrainsMono-700.woff2', { weight: '700 900' }],
];
export const fonts = {
  sans: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
  display: '"Archivo", "Inter", system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};
const familyOf = f => fonts[f] || (f ? (f.includes(',') || f.includes('"') ? f : `"${f}", ${fonts.sans}`) : fonts.sans);

// ───────────────────────────── transitions ─────────────────────────────
// Each transition draws scenes A (outgoing) and B (incoming) onto ctx for raw progress k in 0..1.
// `blur` > 0 means the runtime supersamples k across the shutter to get real motion blur.

export const transitions = {
  cut: { draw(c, A, B, k) { c.drawImage(k < 0.5 ? A : B, 0, 0); } },
  fade: {
    draw(c, A, B, k, o) {
      const e = toEase(o.ease || 'inOutSine')(k);
      c.globalCompositeOperation = 'lighter';           // premultiplied sum: exact crossfade, no dip
      c.globalAlpha = 1 - e; c.drawImage(A, 0, 0);
      c.globalAlpha = e; c.drawImage(B, 0, 0);
    },
  },
  whip: {
    blur: 1.6, ease: 'inOutQuint',
    draw(c, A, B, k, o) {
      const W = c.canvas.width, H = c.canvas.height, e = toEase(o.ease || 'inOutQuint')(k);
      const [dx, dy] = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[o.direction || 'left'];
      c.drawImage(A, dx * e * W, dy * e * H);
      c.drawImage(B, dx * (e - 1) * W, dy * (e - 1) * H);
    },
  },
  push: {
    draw(c, A, B, k, o) {
      const W = c.canvas.width, e = toEase(o.ease || 'inOutExpo')(k);
      c.globalAlpha = 1 - 0.6 * e; c.drawImage(A, -e * W * 0.35, 0);
      c.globalAlpha = 1;
      c.save(); c.shadowColor = 'rgba(0,0,0,.45)'; c.shadowBlur = 60; c.drawImage(B, (1 - e) * W, 0); c.restore();
    },
  },
  zoom: {
    blur: 1.4, ease: 'inOutExpo',
    draw(c, A, B, k, o) {
      const W = c.canvas.width, H = c.canvas.height, e = toEase(o.ease || 'inOutExpo')(k);
      const sA = 1 + 2.2 * e, sB = lerp(0.42, 1, e), x = B => smoothstep(0.38, 0.62, B);
      const put = (img, s, a) => { c.globalAlpha = a; c.setTransform(s, 0, 0, s, (W - W * s) / 2, (H - H * s) / 2); c.drawImage(img, 0, 0); };
      put(A, sA, 1 - x(k));
      put(B, sB, x(k));
      c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1;
    },
  },
  wipe: {
    draw(c, A, B, k, o, tmp) {
      const W = c.canvas.width, H = c.canvas.height, e = toEase(o.ease || 'inOutQuint')(k);
      const ang = ((o.angle ?? 20) * Math.PI) / 180, soft = (o.softness ?? 0.06) * W;
      const ux = Math.cos(ang), uy = Math.sin(ang), span = Math.abs(W * ux) + Math.abs(H * uy) + soft * 2;
      const cx = W / 2, cy = H / 2, d = lerp(-span / 2, span / 2, e);
      c.drawImage(A, 0, 0);
      const m = tmp.getContext('2d');
      m.setTransform(1, 0, 0, 1, 0, 0); m.globalCompositeOperation = 'source-over'; m.globalAlpha = 1;
      m.clearRect(0, 0, W, H); m.drawImage(B, 0, 0);
      const g = m.createLinearGradient(cx + ux * (d - soft), cy + uy * (d - soft), cx + ux * (d + soft), cy + uy * (d + soft));
      g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      m.globalCompositeOperation = 'destination-in'; m.fillStyle = g; m.fillRect(0, 0, W, H);
      m.globalCompositeOperation = 'source-over';
      c.drawImage(tmp, 0, 0);
      if (o.edge !== false && e > 0 && e < 1) {          // a thin light edge riding the wipe
        c.save(); c.globalCompositeOperation = 'lighter';
        const ex = cx + ux * d, ey = cy + uy * d, L = span;
        const lg = c.createLinearGradient(ex - ux * soft, ey - uy * soft, ex + ux * soft, ey + uy * soft);
        const col = o.color || '#ffffff';
        lg.addColorStop(0, rgba(col, 0)); lg.addColorStop(0.5, rgba(col, 0.22 * Math.sin(Math.PI * e))); lg.addColorStop(1, rgba(col, 0));
        c.fillStyle = lg; c.translate(ex, ey); c.rotate(ang);
        c.fillRect(-soft, -L, soft * 2, L * 2);
        c.restore();
      }
    },
  },
  iris: {
    draw(c, A, B, k, o, tmp) {
      const W = c.canvas.width, H = c.canvas.height, e = toEase(o.ease || 'inOutQuint')(k);
      const x = (o.x ?? 0.5) * W, y = (o.y ?? 0.5) * H, R = Math.hypot(Math.max(x, W - x), Math.max(y, H - y)) * 1.08;
      const r = e * R, soft = Math.max(2, (o.softness ?? 0.04) * W);
      const sA = 1 - 0.06 * e;
      c.globalAlpha = 1; c.setTransform(sA, 0, 0, sA, x - x * sA, y - y * sA); c.drawImage(A, 0, 0); c.setTransform(1, 0, 0, 1, 0, 0);
      c.fillStyle = `rgba(0,0,0,${0.35 * e})`; c.fillRect(0, 0, W, H);
      const m = tmp.getContext('2d');
      m.setTransform(1, 0, 0, 1, 0, 0); m.globalCompositeOperation = 'source-over'; m.globalAlpha = 1;
      m.clearRect(0, 0, W, H);
      const sB = lerp(1.12, 1, e);
      m.setTransform(sB, 0, 0, sB, x - x * sB, y - y * sB); m.drawImage(B, 0, 0); m.setTransform(1, 0, 0, 1, 0, 0);
      const g = m.createRadialGradient(x, y, Math.max(0, r - soft), x, y, r + 0.01);
      g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      m.globalCompositeOperation = 'destination-in'; m.fillStyle = g; m.fillRect(0, 0, W, H);
      m.globalCompositeOperation = 'source-over';
      c.drawImage(tmp, 0, 0);
    },
  },
};
transitions.crossfade = transitions.fade;

// ───────────────────────────── canvas helpers ─────────────────────────────

function mk(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h));
  return c;
}
function reset(c) {
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; c.filter = 'none';
  c.shadowColor = 'transparent'; c.shadowBlur = 0; c.shadowOffsetX = 0; c.shadowOffsetY = 0;
}
function roundRect(c, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  c.beginPath(); c.roundRect(x, y, w, h, r);
}
// Exponential-ish blur per sample, accumulated with running-average alpha (1/(i+1)).
function accumulate(dst, n, drawSample, scratch) {
  const d = dst.getContext('2d'), s = scratch.getContext('2d');
  reset(d); d.clearRect(0, 0, dst.width, dst.height);
  for (let i = 0; i < n; i++) {
    reset(s); s.clearRect(0, 0, scratch.width, scratch.height);
    drawSample(s, n === 1 ? 0.5 : i / (n - 1));
    reset(s);
    d.globalAlpha = 1 / (i + 1);
    d.drawImage(scratch, 0, 0);
  }
  d.globalAlpha = 1;
}

// ───────────────────────────── the per-frame drawing API ─────────────────────────────

/**
 * `s` inside a scene. Time is local to the scene (s.t = 0 when it starts). Coordinates are design
 * pixels (the width/height you passed to reel()); (0,0) is top-left, s.cx/s.cy the centre.
 */
class Frame {
  constructor(reel, ctx, scene, T) {
    this.reel = reel; this.ctx = ctx; this.scene = scene;
    this.T = T; this.t = T - scene.start; this.dur = scene.duration;
    this.p = clamp(this.t / this.dur);
    this.w = reel.w; this.h = reel.h; this.cx = reel.w / 2; this.cy = reel.h / 2;
    this.fps = reel.fps; this.name = scene.name;
    this.images = reel.images;
  }

  // ── time ──
  /** Eased 0..1 progress of [start, start+dur] in scene time. */
  tween(start, dur = 0.6, easing = 'out') { return tween(this.t, start, dur, easing); }
  /** Spring from 0 to 1 released at `start` (overshoots for bouncy presets). */
  spring(start = 0, opts = 'gentle') { return spring(this.t - start, opts); }
  /** Keyframes in scene time. */
  keys(frames) { return keys(this.t, frames); }
  /** Exit progress: 0 until `dur` before the scene ends, then eases to 1 at the end. */
  out(dur = 0.5, easing = 'in', pad = 0) { return tween(this.t, this.dur - dur - pad, dur, easing); }
  /** True while t is in [a, b). */
  between(a, b) { return this.t >= a && this.t < b; }
  wiggle(freq = 1, amp = 1, seed = 0) { return wiggle(this.T, freq, amp, seed); }
  rng(seed = 1) { return rng(seed); }

  // ── structure ──
  /** Group transform: translate/scale/rotate around `origin`, opacity, blur. */
  layer(o, fn) {
    const c = this.ctx;
    const { x = 0, y = 0, scale = 1, scaleX = scale, scaleY = scale, rotate = 0, alpha = 1, blur = 0, origin = [this.cx, this.cy] } = o;
    if (alpha <= 0.001) return;
    c.save();
    c.globalAlpha *= clamp(alpha);
    if (blur > 0.2) c.filter = `blur(${(blur * this.reel.scale).toFixed(2)}px)`;
    c.translate(origin[0] + x, origin[1] + y); c.rotate(rotate); c.scale(scaleX, scaleY); c.translate(-origin[0], -origin[1]);
    fn(c);
    c.restore();
  }
  /** Camera: puts world point (x, y) at the centre, zoomed and rotated, with optional handheld shake. */
  camera(o, fn) {
    const c = this.ctx;
    const { x = this.cx, y = this.cy, zoom = 1, rotate = 0, shake = 0, shakeSpeed = 1.6, seed = 5 } = o;
    const sx = shake ? wiggle(this.T, shakeSpeed, shake, seed) : 0, sy = shake ? wiggle(this.T, shakeSpeed, shake, seed + 99) : 0;
    const sr = shake ? wiggle(this.T, shakeSpeed * 0.8, shake * 0.0007, seed + 7) : 0;
    c.save();
    c.translate(this.cx, this.cy); c.scale(zoom, zoom); c.rotate(rotate + sr); c.translate(-x + sx, -y + sy);
    fn(c);
    c.restore();
  }

  // ── backgrounds ──
  /** Fill the frame: a colour, or { from, to, angle } linear gradient, or { radial: [inner, outer], x, y }. */
  bg(spec = '#0b0b10') {
    const c = this.ctx, W = this.w, H = this.h, M = Math.max(W, H);
    c.save(); c.setTransform(this.reel.scale, 0, 0, this.reel.scale, 0, 0);
    if (typeof spec === 'string') c.fillStyle = spec;
    else if (spec.radial) {
      const g = c.createRadialGradient((spec.x ?? 0.5) * W, (spec.y ?? 0.4) * H, 0, (spec.x ?? 0.5) * W, (spec.y ?? 0.4) * H, M * (spec.r ?? 0.8));
      spec.radial.forEach((col, i, a) => g.addColorStop(i / (a.length - 1), col));
      c.fillStyle = g;
    } else {
      const a = ((spec.angle ?? 90) * Math.PI) / 180, dx = Math.sin(a) * M / 2, dy = -Math.cos(a) * M / 2;
      const g = c.createLinearGradient(W / 2 - dx, H / 2 - dy, W / 2 + dx, H / 2 + dy);
      const stops = spec.stops || [spec.from, spec.to];
      stops.forEach((col, i) => g.addColorStop(i / (stops.length - 1), col));
      c.fillStyle = g;
    }
    c.fillRect(0, 0, W, H);
    c.restore();
  }
  /** Slowly drifting soft colour blobs ("aurora" / mesh gradient). */
  aurora({ colors = ['#5b3cff', '#00c2ff', '#ff4fa3'], intensity = 0.55, speed = 0.06, seed = 1, size = 0.65, blend = 'screen' } = {}) {
    const c = this.ctx, W = this.w, H = this.h;
    c.save(); c.globalCompositeOperation = blend;
    colors.forEach((col, i) => {
      const x = W * (0.5 + 0.42 * noise(this.T * speed + i * 3.1, seed + i)), y = H * (0.5 + 0.4 * noise(this.T * speed * 0.9 + i * 7.3, seed + 31 + i));
      const r = Math.max(W, H) * size * (0.85 + 0.15 * noise(this.T * speed * 1.3, seed + 70 + i));
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(col, intensity)); g.addColorStop(0.45, rgba(col, intensity * 0.35)); g.addColorStop(1, rgba(col, 0));
      c.fillStyle = g; c.fillRect(0, 0, W, H);
    });
    c.restore();
  }
  /** Dot or line grid; drawn in the current transform, so it moves with the camera. */
  grid({ spacing = 48, color = 'rgba(255,255,255,.07)', dot = 2, lines = false, x0 = -this.w, y0 = -this.h, x1 = this.w * 2, y1 = this.h * 2 } = {}) {
    const c = this.ctx;
    c.save(); c.fillStyle = color; c.strokeStyle = color; c.lineWidth = 1;
    const sx = Math.floor(x0 / spacing) * spacing, sy = Math.floor(y0 / spacing) * spacing;
    if (lines) {
      c.beginPath();
      for (let x = sx; x <= x1; x += spacing) { c.moveTo(x, y0); c.lineTo(x, y1); }
      for (let y = sy; y <= y1; y += spacing) { c.moveTo(x0, y); c.lineTo(x1, y); }
      c.stroke();
    } else {
      for (let x = sx; x <= x1; x += spacing) for (let y = sy; y <= y1; y += spacing) c.fillRect(x - dot / 2, y - dot / 2, dot, dot);
    }
    c.restore();
  }
  /** Soft radial glow. */
  glow(x, y, r, color = '#ffffff', alpha = 0.5) {
    if (alpha <= 0.002 || r <= 0) return;
    const c = this.ctx, g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(color, alpha)); g.addColorStop(0.3, rgba(color, alpha * 0.5)); g.addColorStop(0.65, rgba(color, alpha * 0.14)); g.addColorStop(1, rgba(color, 0));
    c.save(); c.fillStyle = g; c.fillRect(x - r, y - r, r * 2, r * 2); c.restore();
  }

  // ── type ──
  font({ size = 48, weight = 600, font = 'sans', tracking, stretch } = {}) {
    const c = this.ctx;
    c.font = `${weight} ${size}px ${familyOf(font)}`;
    c.letterSpacing = `${((tracking ?? (size >= 40 && font !== 'mono' ? -0.02 : 0)) * size).toFixed(2)}px`;
    c.fontStretch = stretch || 'normal';
    c.fontKerning = 'normal';
  }
  measure(str, o = {}) { this.ctx.save(); this.font(o); const w = this.ctx.measureText(str).width; this.ctx.restore(); return w; }
  /** Plain text. y is the baseline unless baseline: 'middle' | 'top'. Returns the width. */
  text(str, o = {}) {
    const { x = 0, y = 0, color = '#fff', align = 'left', baseline = 'alphabetic', alpha = 1, blur = 0, shadow, glow: gl } = o;
    if (alpha <= 0.001) return 0;
    const c = this.ctx;
    c.save(); this.font(o);
    c.textAlign = align; c.textBaseline = baseline; c.globalAlpha *= clamp(alpha);
    if (blur > 0.2) c.filter = `blur(${(blur * this.reel.scale).toFixed(2)}px)`;
    if (shadow || gl) { c.shadowColor = gl ? gl : shadow.color || 'rgba(0,0,0,.4)'; c.shadowBlur = (gl ? (o.size || 48) * 0.5 : shadow.blur ?? 20) * this.reel.scale; c.shadowOffsetY = gl ? 0 : (shadow.y ?? 6) * this.reel.scale; }
    c.fillStyle = color;
    c.fillText(str, x, y);
    const w = c.measureText(str).width;
    c.restore();
    return w;
  }

  /** Lays out words (supports *accent*, \n and maxWidth wrapping). Returns per-word boxes in design px. */
  layoutWords(str, o = {}) {
    const { x = 0, y = 0, size = 64, align = 'left', lineHeight = 1.12, maxWidth = Infinity } = o;
    const space = this.measure(' ', o) * (o.wordSpacing ?? 1);
    const lines = [[]];
    const tokens = str.split(/(\n)|\s+/).filter(v => v !== undefined && v !== '');
    let lineW = 0, idx = 0, inAccent = false;
    for (const tok of tokens) {
      if (tok === '\n') { lines.push([]); lineW = 0; continue; }
      // *accent* may span several words: "*write themselves.*"
      const opens = tok.startsWith('*'), closes = /\*[.,!?:;]*$/.test(tok) && (tok.length > 1 || !opens);
      const accent = inAccent || opens;
      if (opens) inAccent = true;
      if (closes) inAccent = false;
      const text = tok.replace(/^\*/, '').replace(/\*([.,!?:;]*)$/, '$1');
      const w = this.measure(text, o);
      const cur = lines[lines.length - 1];
      if (cur.length && lineW + space + w > maxWidth) { lines.push([]); lineW = 0; }
      const line = lines[lines.length - 1];
      lineW += (line.length ? space : 0) + w;
      line.push({ text, accent, w, i: idx++ });
    }
    const boxes = [];
    lines.forEach((line, li) => {
      const total = line.reduce((a, b) => a + b.w, 0) + space * Math.max(0, line.length - 1);
      let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
      for (const wd of line) {
        boxes.push({ ...wd, line: li, x: cx, y: y + li * size * lineHeight, h: size });
        cx += wd.w + space;
      }
    });
    const width = Math.max(0, ...lines.map(l => l.reduce((a, b) => a + b.w, 0) + space * Math.max(0, l.length - 1)));
    return { boxes, lines: lines.length, width, height: lines.length * size * lineHeight };
  }

  /**
   * Word-by-word entrance. style: 'blur' (blur + rise, default) | 'rise' | 'mask' (slides up from behind a line) | 'pop' (spring).
   * at: start time; stagger: seconds between words; exit: time to start leaving (optional).
   * *accent* words use `accent` colour. marks: [{ word: 'faster', at, color }] sweeps a highlighter behind a word.
   */
  words(str, o = {}) {
    const { size = 64, at = 0, stagger: st = 0.07, dur = 0.7, color = '#fff', accent = '#9b87ff', style = 'blur', exit, exitStagger = 0.03, exitDur = 0.35, alpha = 1 } = o;
    const L = this.layoutWords(str, o), c = this.ctx;
    for (const m of o.marks || []) {
      const b = L.boxes.filter(bx => bx.text.replace(/[.,!?:;]$/, '') === m.word || bx.i === m.word);
      for (const bx of b) this.marker({ x: bx.x - size * 0.08, y: bx.y - size * 0.8, w: bx.w + size * 0.16, h: size * 1.0, at: m.at ?? at + 0.4, dur: m.dur ?? 0.45, color: m.color || rgba(accent, 0.85), alpha });
    }
    for (const b of L.boxes) {
      const t0 = at + b.i * st;
      let k = clamp((this.t - t0) / dur);
      let kx = exit != null ? clamp((this.t - (exit + b.i * exitStagger)) / exitDur) : 0;
      if (k <= 0 || kx >= 1) continue;
      const e = style === 'pop' ? spring(this.t - t0, 'snappy') : ease.outExpo(k), ex = ease.in(kx);
      const col = b.accent ? accent : color;
      c.save();
      c.globalAlpha *= clamp(alpha);
      if (style === 'mask') {
        c.beginPath(); c.rect(b.x - size, b.y - size * 1.0, b.w + size * 2, size * 1.28); c.clip();
        this.text(b.text, { ...o, x: b.x, y: b.y + (1 - e) * size * 1.05 - ex * size * 1.05, color: col, align: 'left', alpha: 1, blur: 0 });
      } else if (style === 'pop') {
        const cx = b.x + b.w / 2, cy = b.y - size * 0.35;
        c.translate(cx, cy); c.scale(Math.max(0, e), Math.max(0, e)); c.translate(-cx, -cy);
        this.text(b.text, { ...o, x: b.x, y: b.y, color: col, align: 'left', alpha: clamp(k * 3) * (1 - ex), blur: ex * size * 0.15 });
      } else {
        const blur = style === 'blur' ? (1 - e) * size * 0.18 + ex * size * 0.15 : 0;
        const rise = (1 - e) * size * 0.32 - ex * size * 0.25;
        this.text(b.text, { ...o, x: b.x, y: b.y + rise, color: col, align: 'left', alpha: clamp(k * 1.8) * (1 - ex), blur });
      }
      c.restore();
    }
    return L;
  }

  /** Per-character spring pop (kinetic type). */
  chars(str, o = {}) {
    const { x = 0, y = 0, size = 96, at = 0, stagger: st = 0.035, align = 'left', color = '#fff', springPreset = 'bouncy', rise = 0.5, rotate = 0.25 } = o;
    const c = this.ctx, chars = [...str];
    c.save(); this.font(o);
    const total = c.measureText(str).width;
    const offs = chars.map((_, i) => c.measureText(chars.slice(0, i).join('')).width);
    const wid = chars.map(ch => c.measureText(ch).width);
    c.restore();
    const x0 = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
    chars.forEach((ch, i) => {
      if (ch === ' ') return;
      const tt = this.t - (at + i * st);
      if (tt <= 0) return;
      const s = spring(tt, springPreset), a = clamp(tt / 0.12);
      const cx = x0 + offs[i] + wid[i] / 2, cy = y - size * 0.35;
      c.save();
      c.translate(cx, cy + (1 - s) * size * rise); c.rotate((1 - s) * rotate * (i % 2 ? 1 : -1)); c.scale(Math.max(0, s), Math.max(0, s)); c.translate(-cx, -cy);
      this.text(ch, { ...o, x: x0 + offs[i], y, align: 'left', alpha: a, color, tracking: 0 });
      c.restore();
    });
    return total;
  }

  /** Typewriter with natural rhythm and a cursor. Returns { shown, done, width, end }. */
  type(str, o = {}) {
    const { x = 0, y = 0, size = 32, at = 0, cps = 24, cursor = true, color = '#e8e8f0', cursorColor = color, font = 'mono', seed = 3, hideCursorAfter = Infinity } = o;
    const times = typingTimes(str, cps, seed), chars = [...str];
    let n = 0;
    while (n < times.length && this.t >= at + times[n]) n++;
    const shown = chars.slice(0, n).join('');
    const w = this.text(shown, { ...o, font, x, y, color, align: 'left' });
    const end = at + (times[times.length - 1] || 0), done = n === chars.length;
    if (cursor && this.t >= at - 0.4 && this.t < hideCursorAfter) {
      const idle = this.t < at || done;
      const on = !idle || Math.floor((this.t - (done ? end : 0)) / 0.53) % 2 === 0;
      if (on) {
        const c = this.ctx;
        c.save(); c.fillStyle = cursorColor;
        const cw = cursor === 'bar' ? Math.max(2, size * 0.08) : size * 0.56;
        c.globalAlpha *= cursor === 'bar' ? 1 : 0.85;
        c.fillRect(x + w + size * 0.06, y - size * 0.78, cw, size * 0.98);
        c.restore();
      }
    }
    return { shown, n, done, width: w, end };
  }

  /**
   * Rolling-digit counter (a true odometer: higher digits roll only when lower ones carry).
   * value: target; from: start; at/dur/ease: the count; decimals; separator (',' or ''); prefix/suffix.
   */
  odometer(value, o = {}) {
    const { x = 0, y = 0, size = 120, at = 0, dur = 1.6, from = 0, decimals = 0, separator = ',', prefix = '', suffix = '', align = 'left', color = '#fff', easing = 'outExpo', blur = true, alpha = 1 } = o;
    const c = this.ctx, scaleK = 10 ** decimals;
    const val = tt => lerp(from, value, tween(tt, at, dur, easing)) * scaleK;
    const v = Math.max(0, val(this.t)), vel = Math.abs(val(this.t + 1 / 120) - val(this.t - 1 / 120)) * 60;
    const nd = Math.max(String(Math.round(Math.max(Math.abs(value), Math.abs(from)) * scaleK)).length, decimals + 1);
    c.save(); this.font({ ...o, size });
    const dw = c.measureText('0').width * 1.0, sepW = separator ? c.measureText(separator).width : 0, dotW = c.measureText('.').width;
    const preW = prefix ? c.measureText(prefix).width : 0, sufW = suffix ? c.measureText(suffix).width : 0;
    c.restore();
    // column positions (k = place, 0 = rightmost). pos is unwrapped: floor(v / 10^k) plus a carry roll that
    // happens while the column below goes from 9 to 10. Leading columns (pos < 1) are blank and grow in.
    const cols = [];
    for (let k = nd - 1; k >= 0; k--) {
      const p = 10 ** k, below = v - Math.floor(v / p) * p;
      const pos = Math.floor(v / p) + clamp(below - (p - 1));
      const vis = k <= decimals ? 1 : clamp(pos);
      cols.push({ k, pos, vis });
    }
    let total = preW + sufW;
    const items = [];
    cols.forEach(col => {
      const wv = dw * smoothstep(0, 1, col.vis);
      items.push({ type: 'd', ...col, w: wv });
      total += wv;
      if (col.k === decimals && decimals > 0) { items.push({ type: 's', ch: '.', w: dotW, vis: 1 }); total += dotW; }
      else if (separator && col.k > decimals && (col.k - decimals) % 3 === 0) {
        const sv = cols.find(cc => cc.k === col.k)?.vis ?? 1;
        items.push({ type: 's', ch: separator, w: sepW * smoothstep(0, 1, sv), vis: sv }); total += sepW * smoothstep(0, 1, sv);
      }
    });
    let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
    c.save(); c.globalAlpha *= clamp(alpha); this.font({ ...o, size }); c.fillStyle = color; c.textBaseline = 'alphabetic'; c.textAlign = 'center';
    if (prefix) { c.textAlign = 'left'; c.fillText(prefix, cx, y); c.textAlign = 'center'; cx += preW; }
    const lh = size * 1.1, top = y - size * 0.9, hgt = size * 1.16;
    for (const it of items) {
      if (it.type === 's') {
        if (it.vis > 0.01) { c.save(); c.globalAlpha *= it.vis; c.fillText(it.ch, cx + it.w / 2, y); c.restore(); }
        cx += it.w; continue;
      }
      if (it.vis > 0.01) {
        c.save();
        c.beginPath(); c.rect(cx - dw * 0.08, top, it.w + dw * 0.16, hgt); c.clip();
        c.globalAlpha *= clamp(it.vis * 1.5);
        const base = Math.floor(it.pos), f = it.pos - base;
        const speed = vel / 10 ** it.k;                       // digits per second for this column
        // vertical motion blur: the distance the strip travels during a half-frame shutter, capped
        const smear = blur ? Math.min(0.6, speed * 0.5 / this.fps) : 0;
        // enough sub-samples that consecutive copies are <= ~3 px apart, so the smear reads as a blur, not ghosts
        const n = smear > 0.04 ? Math.min(64, Math.ceil((smear * lh * this.reel.scale) / 3) + 2) : 1;
        if (n > 1) c.globalAlpha *= 1 - 0.4 * (smear / 0.6);   // a spinning wheel reads lighter
        const leading = it.k > decimals;                      // a 0 in a leading column is drawn blank
        for (let s = 0; s < n; s++) {
          const off = n === 1 ? 0 : (s / (n - 1) - 0.5) * smear;
          c.save(); if (n > 1) c.globalAlpha *= 1.15 / n;
          for (let d = -1; d <= 1; d++) {
            const u = base + d;                               // unwrapped digit; the next digit rolls up from below
            if (u < 0 || (leading && u === 0)) continue;
            const o = d - f - off, fade = clamp(1 - Math.abs(o) * 1.25);   // digits fade as they roll away
            if (fade <= 0.01) continue;
            c.globalAlpha *= fade;
            c.fillText(String(u % 10), cx + it.w / 2, y + o * lh);
            c.globalAlpha /= fade;
          }
          c.restore();
        }
        c.restore();
      }
      cx += it.w;
    }
    if (suffix) { c.textAlign = 'left'; c.fillText(suffix, cx, y); }
    c.restore();
    return { width: total, value: v / scaleK };
  }

  /** Highlighter sweep (drawn behind text: call it first). */
  marker({ x, y, w, h, at = 0, dur = 0.45, color = 'rgba(255,214,10,.85)', skew = -0.12, radius = 6, alpha = 1, easing = 'inOutQuint' }) {
    const k = this.tween(at, dur, easing);
    if (k <= 0) return;
    const c = this.ctx;
    c.save(); c.globalAlpha *= alpha; c.fillStyle = color;
    c.translate(x, y + h); c.transform(1, 0, skew, 1, 0, 0);
    roundRect(c, 0, -h, w * k, h, radius); c.fill();
    c.restore();
  }

  /** Rotating word (kinetic type): cycles through `items` every `every` seconds with a masked roll + blur. */
  rotator(items, o = {}) {
    const { x = 0, y = 0, size = 96, at = 0, every = 1.1, dur = 0.55, color = '#fff', align = 'left', loop = false } = o;
    const c = this.ctx, tt = this.t - at;
    if (tt < 0) return 0;
    let i = Math.floor(tt / every); if (!loop) i = Math.min(i, items.length - 1);
    const k = loop || i < items.length - 1 || tt < (items.length - 1) * every + dur ? ease.outExpo(clamp((tt - i * every) / dur)) : 1;
    const cur = items[i % items.length], prev = i > 0 ? items[(i - 1) % items.length] : null;
    const wCur = this.measure(cur, { ...o, size }), wPrev = prev ? this.measure(prev, { ...o, size }) : wCur, w = lerp(wPrev, wCur, prev ? k : 1);
    const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    c.save(); c.beginPath(); c.rect(x0 - size, y - size * 1.0, w + size * 2, size * 1.3); c.clip();
    if (prev && k < 1) this.text(prev, { ...o, size, x: x0, y: y - k * size * 1.1, align: 'left', color, blur: k * size * 0.12, alpha: 1 - k });
    this.text(cur, { ...o, size, x: x0, y: y + (prev ? (1 - k) * size * 1.1 : 0), align: 'left', color, blur: prev ? (1 - k) * size * 0.12 : 0 });
    c.restore();
    return w;
  }

  // ── shapes ──
  roundRect(x, y, w, h, r) { roundRect(this.ctx, x, y, w, h, r); }
  /**
   * Card with rounded corners, soft layered shadow, optional border, gradient and top highlight.
   * Position with x/y (top-left) or cx/cy (centre).
   */
  card(o = {}) {
    const { w = 400, h = 240, r = 28, fill = '#16161d', stroke = 'rgba(255,255,255,.08)', strokeWidth = 1.5, shadow = 'soft', alpha = 1, highlight = true } = o;
    const x = o.cx != null ? o.cx - w / 2 : o.x ?? 0, y = o.cy != null ? o.cy - h / 2 : o.y ?? 0;
    if (alpha <= 0.001) return { x, y, w, h };
    const c = this.ctx, S = this.reel.scale;
    c.save(); c.globalAlpha *= clamp(alpha);
    const shadows = shadow === false ? [] : shadow === 'soft' ? [[0, 2, 6, 0.25], [0, 18, 48, 0.32], [0, 40, 110, 0.28]] : shadow === 'lift' ? [[0, 4, 10, 0.3], [0, 30, 70, 0.4], [0, 70, 160, 0.35]] : Array.isArray(shadow) ? shadow : [[0, shadow.y ?? 20, shadow.blur ?? 60, shadow.alpha ?? 0.35]];
    const sc = o.shadowColor || '#000';
    for (const [sx, sy, sb, sa] of shadows) {
      c.save(); c.shadowColor = rgba(sc, sa); c.shadowBlur = sb * S; c.shadowOffsetX = sx * S; c.shadowOffsetY = sy * S;
      c.fillStyle = typeof fill === 'string' ? fill : '#000'; roundRect(c, x, y, w, h, r); c.fill(); c.restore();
    }
    if (typeof fill === 'object' && fill) {
      const g = c.createLinearGradient(x, y, x, y + h);
      (fill.stops || [fill.from, fill.to]).forEach((col, i, a) => g.addColorStop(i / (a.length - 1), col));
      c.fillStyle = g;
    } else c.fillStyle = fill;
    roundRect(c, x, y, w, h, r); c.fill();
    if (highlight) {
      const g = c.createLinearGradient(x, y, x, y + Math.min(h, 160));
      g.addColorStop(0, 'rgba(255,255,255,.07)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g; c.fill();
    }
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = strokeWidth; roundRect(c, x + strokeWidth / 2, y + strokeWidth / 2, w - strokeWidth, h - strokeWidth, r - strokeWidth / 2); c.stroke(); }
    c.restore();
    return { x, y, w, h };
  }
  /** A small rounded label ("NEW", "v2.0"). Returns its box. */
  pill(label, o = {}) {
    const { size = 24, fill = 'rgba(255,255,255,.08)', color = '#fff', stroke = 'rgba(255,255,255,.14)', padX = 0.75, padY = 0.45, weight = 600, dot, alpha = 1 } = o;
    const tw = this.measure(label, { ...o, size, weight }), dotW = dot ? size * 0.9 : 0;
    const w = tw + size * padX * 2 + dotW, h = size * (1 + padY * 2);
    const x = o.cx != null ? o.cx - w / 2 : o.x ?? 0, y = o.cy != null ? o.cy - h / 2 : o.y ?? 0;
    if (alpha <= 0.001) return { x, y, w, h };
    const c = this.ctx;
    c.save(); c.globalAlpha *= clamp(alpha);
    c.fillStyle = fill; roundRect(c, x, y, w, h, h / 2); c.fill();
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = 1.5; c.stroke(); }
    if (dot) { this.glow(x + size * padX + size * 0.3, y + h / 2, size * 0.9, dot, 0.5); c.fillStyle = dot; c.beginPath(); c.arc(x + size * padX + size * 0.3, y + h / 2, size * 0.22, 0, Math.PI * 2); c.fill(); }
    this.text(label, { ...o, size, weight, x: x + size * padX + dotW, y: y + h / 2 + size * 0.36, color, align: 'left', alpha: 1 });
    c.restore();
    return { x, y, w, h };
  }

  /**
   * 2.5D tilted card: draws `fn(ctx, w, h)` into an offscreen card, then projects it with real perspective.
   * rx/ry in radians (rx tips the top away, ry turns the right side away).
   */
  tilt(o, fn) {
    const { cx = this.cx, cy = this.cy, w = 800, h = 500, rx = 0, ry = 0, rz = 0, scale = 1, perspective = 1800, alpha = 1, shade = true, shadow = true } = o;
    if (alpha <= 0.001) return;
    const S = this.reel.scale * Math.max(1, scale), key = `${w}x${h}@${S}`;
    const cache = this.reel._tilt || (this.reel._tilt = {});
    const off = cache[key] || (cache[key] = mk(w * S, h * S));
    const oc = off.getContext('2d');
    reset(oc); oc.clearRect(0, 0, off.width, off.height); oc.setTransform(S, 0, 0, S, 0, 0);
    const prevCtx = this.ctx; this.ctx = oc;
    try { fn(oc, w, h); } finally { this.ctx = prevCtx; }
    const c = this.ctx;
    const cosx = Math.cos(rx), sinx = Math.sin(rx), cosy = Math.cos(ry), siny = Math.sin(ry), cosz = Math.cos(rz), sinz = Math.sin(rz);
    const proj = (px, py) => {
      let X = px * cosz - py * sinz, Y = px * sinz + py * cosz;
      let x1 = X * cosy, z1 = -X * siny;
      const y2 = Y * cosx - z1 * sinx, z2 = Y * sinx + z1 * cosx;
      const k = perspective / (perspective + z2);
      return [cx + x1 * k * scale, cy + y2 * k * scale];
    };
    c.save(); c.globalAlpha *= clamp(alpha);
    if (shadow) {   // only the shadow is drawn: the shape itself is pushed far off-canvas
      const corners = [proj(-w / 2, -h / 2), proj(w / 2, -h / 2), proj(w / 2, h / 2), proj(-w / 2, h / 2)];
      const m = c.getTransform(), far = 20000, dev = Math.hypot(m.a, m.b);
      c.save(); c.shadowColor = `rgba(0,0,0,${typeof shadow === 'number' ? shadow : 0.55})`; c.shadowBlur = 90 * dev; c.shadowOffsetX = far * dev; c.shadowOffsetY = 50 * dev;
      c.fillStyle = '#000'; c.beginPath(); corners.forEach(([a, b], i) => (i ? c.lineTo(a - far, b) : c.moveTo(a - far, b))); c.closePath(); c.fill(); c.restore();
    }
    const alongX = Math.abs(ry) >= Math.abs(rx), n = 64;
    for (let i = 0; i < n; i++) {
      if (alongX) {
        const u0 = (i / n) * w, u1 = ((i + 1) / n) * w;
        const p0 = proj(u0 - w / 2, -h / 2), p1 = proj(u1 - w / 2, -h / 2), p3 = proj(u0 - w / 2, h / 2);
        c.save(); c.transform((p1[0] - p0[0]) / (u1 - u0), (p1[1] - p0[1]) / (u1 - u0), (p3[0] - p0[0]) / h, (p3[1] - p0[1]) / h, p0[0], p0[1]);
        c.drawImage(off, u0 * S, 0, (u1 - u0) * S + 1.2, h * S, 0, 0, (u1 - u0) + 1.2 / S, h);
        c.restore();
      } else {
        const v0 = (i / n) * h, v1 = ((i + 1) / n) * h;
        const p0 = proj(-w / 2, v0 - h / 2), p1 = proj(w / 2, v0 - h / 2), p3 = proj(-w / 2, v1 - h / 2);
        c.save(); c.transform((p1[0] - p0[0]) / w, (p1[1] - p0[1]) / w, (p3[0] - p0[0]) / (v1 - v0), (p3[1] - p0[1]) / (v1 - v0), p0[0], p0[1]);
        c.drawImage(off, 0, v0 * S, w * S, (v1 - v0) * S + 1.2, 0, 0, w, (v1 - v0) + 1.2 / S);
        c.restore();
      }
    }
    if (shade && (rx || ry)) {   // a sheen that slides as the card turns
      const corners = [proj(-w / 2, -h / 2), proj(w / 2, -h / 2), proj(w / 2, h / 2), proj(-w / 2, h / 2)];
      const g = c.createLinearGradient(corners[0][0], corners[0][1], corners[2][0], corners[2][1]);
      const m = clamp(0.5 - ry * 0.8 - rx * 0.5, 0, 1);
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(m, `rgba(255,255,255,${0.06 + 0.1 * Math.abs(ry + rx)})`); g.addColorStop(1, 'rgba(255,255,255,0)');
      c.globalCompositeOperation = 'source-atop';
      c.fillStyle = g; c.beginPath(); corners.forEach(([a, b], i) => (i ? c.lineTo(a, b) : c.moveTo(a, b))); c.closePath(); c.fill();
    }
    c.restore();
  }

  /** Draw a preloaded image. fit: 'cover' | 'contain' | 'fill'. */
  image(name, o = {}) {
    const img = typeof name === 'string' ? this.images[name] : name;
    if (!img) throw new Error(`reelkit: image "${name}" was not preloaded; pass images: { ${name}: 'file.png' } to reel()`);
    const { w = img.width, h = img.height, r = 0, alpha = 1, fit = 'cover' } = o;
    const x = o.cx != null ? o.cx - w / 2 : o.x ?? 0, y = o.cy != null ? o.cy - h / 2 : o.y ?? 0;
    const c = this.ctx;
    c.save(); c.globalAlpha *= clamp(alpha);
    if (r) { roundRect(c, x, y, w, h, r); c.clip(); }
    if (fit === 'fill') c.drawImage(img, x, y, w, h);
    else {
      const s = (fit === 'cover' ? Math.max : Math.min)(w / img.width, h / img.height), iw = img.width * s, ih = img.height * s;
      c.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
    }
    c.restore();
  }

  // ── particles ──
  /** Deterministic burst: sparks / dots / confetti flying out from (x, y) at time `at`. */
  particles(o = {}) {
    const { x = this.cx, y = this.cy, at = 0, count = 40, speed = 700, life = 0.9, colors = ['#ffffff', '#ffd23f', '#9b87ff'], gravity = 900, drag = 2.2, spread = Math.PI * 2, angle = -Math.PI / 2, size = 4, seed = 1, shape = 'spark' } = o;
    const tt = this.t - at;
    if (tt < 0 || tt > life * 1.2) return;
    const r = rng(seed), c = this.ctx;
    c.save(); if (shape === 'spark') c.globalCompositeOperation = 'lighter';
    for (let i = 0; i < count; i++) {
      const a = angle + (r() - 0.5) * spread, sp = speed * (0.35 + 0.65 * r()), lf = life * (0.55 + 0.45 * r()), col = colors[i % colors.length];
      const sz = size * (0.6 + 0.8 * r()), spin = r.range(-12, 12), ph = r() * 6.28;
      if (tt > lf) continue;
      const k = tt / lf;
      // velocity decays with drag; gravity pulls down
      const d = (sp / drag) * (1 - Math.exp(-drag * tt));
      const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d + 0.5 * gravity * tt * tt * 0.35;
      const vx = Math.cos(a) * sp * Math.exp(-drag * tt), vy = Math.sin(a) * sp * Math.exp(-drag * tt) + gravity * tt * 0.35;
      const fade = 1 - ease.in(k);
      if (shape === 'spark') {
        const len = clamp(Math.hypot(vx, vy) * 0.03, 2, 60);
        const ang = Math.atan2(vy, vx);
        c.strokeStyle = rgba(col, fade); c.lineWidth = sz * (1 - k * 0.6); c.lineCap = 'round';
        c.beginPath(); c.moveTo(px, py); c.lineTo(px - Math.cos(ang) * len, py - Math.sin(ang) * len); c.stroke();
      } else if (shape === 'confetti') {
        c.save(); c.translate(px, py); c.rotate(ph + spin * tt); c.scale(1, Math.cos(ph + tt * 9));
        c.fillStyle = rgba(col, fade); c.fillRect(-sz, -sz * 0.5, sz * 2, sz); c.restore();
      } else {
        c.fillStyle = rgba(col, fade); c.beginPath(); c.arc(px, py, sz * (1 - k * 0.5), 0, Math.PI * 2); c.fill();
      }
    }
    c.restore();
  }
  /** Ambient floating motes, looping forever. */
  dust({ count = 60, color = '#ffffff', alpha = 0.35, size = 2, speed = 18, seed = 9, x0 = 0, y0 = 0, x1 = this.w, y1 = this.h } = {}) {
    const r = rng(seed), c = this.ctx, W = x1 - x0, H = y1 - y0;
    c.save(); c.fillStyle = color;
    for (let i = 0; i < count; i++) {
      const bx = r() * W, by = r() * H, sp = speed * (0.4 + r()), sz = size * (0.4 + r()), tw = r() * 6.28, z = 0.3 + 0.7 * r();
      const px = x0 + ((bx + wiggle(this.T, 0.1, 30, i)) % W + W) % W, py = y0 + (((by - this.T * sp * z) % H) + H) % H;
      c.globalAlpha = alpha * z * (0.5 + 0.5 * Math.sin(this.T * 1.3 + tw));
      c.beginPath(); c.arc(px, py, sz * z, 0, Math.PI * 2); c.fill();
    }
    c.restore();
  }

  // ── charts ──
  /** Bars that grow in with a stagger. values: numbers; labels optional. */
  bars(values, o = {}) {
    const { x = 0, y = 0, w = 800, h = 400, at = 0, stagger: st = 0.08, dur = 0.9, color = '#9b87ff', colors, gap = 0.28, r = 10, max = Math.max(...values), labels, labelColor = 'rgba(255,255,255,.55)', labelSize = 22, valueLabels = false, format = v => String(Math.round(v)), highlight = -1, highlightColor = '#ffd23f' } = o;
    const c = this.ctx, n = values.length, bw = w / (n + (n - 1) * gap) , step = bw * (1 + gap);
    values.forEach((v, i) => {
      const k = this.tween(at + i * st, dur, 'outExpo'), s = spring(this.t - (at + i * st), 'gentle');
      const bh = Math.max(0, (v / max) * h * (k * 0.6 + 0.4 * s) * (k > 0 ? 1 : 0));
      const bx = x + i * step, col = i === highlight ? highlightColor : colors ? colors[i % colors.length] : color;
      if (bh > 0.5) {
        const g = c.createLinearGradient(0, y + h - bh, 0, y + h);
        g.addColorStop(0, col); g.addColorStop(1, rgba(col, 0.35));
        c.save(); c.fillStyle = g; roundRect(c, bx, y + h - bh, bw, bh, Math.min(r, bh / 2)); c.fill(); c.restore();
        if (i === highlight) this.glow(bx + bw / 2, y + h - bh, bw * 1.2, col, 0.35 * k);
      }
      if (labels) this.text(labels[i], { x: bx + bw / 2, y: y + h + labelSize * 1.6, size: labelSize, weight: 500, color: labelColor, align: 'center', alpha: k });
      if (valueLabels && k > 0) this.text(format(v * k), { x: bx + bw / 2, y: y + h - bh - labelSize * 0.6, size: labelSize, weight: 600, color: '#fff', align: 'center', alpha: clamp(k * 2) });
    });
  }
  /** Line chart that draws itself, with an area fill and a glowing head. points: numbers (evenly spaced). */
  lineChart(points, o = {}) {
    const { x = 0, y = 0, w = 800, h = 400, at = 0, dur = 1.6, color = '#7cf6c8', width = 5, fill = true, min = Math.min(...points), max = Math.max(...points), easing = 'inOut', head = true, smooth = 0.35 } = o;
    const c = this.ctx, k = this.tween(at, dur, easing);
    if (k <= 0) return;
    const P = points.map((v, i) => [x + (i / (points.length - 1)) * w, y + h - ((v - min) / (max - min || 1)) * h]);
    const seg = i => {   // bezier control points for the segment P[i-1] -> P[i]
      const p0 = P[i - 2] || P[i - 1], p1 = P[i - 1], p2 = P[i], p3 = P[i + 1] || p2;
      return [p1, [p1[0] + (p2[0] - p0[0]) * smooth / 2, p1[1] + (p2[1] - p0[1]) * smooth / 2], [p2[0] - (p3[0] - p1[0]) * smooth / 2, p2[1] - (p3[1] - p1[1]) * smooth / 2], p2];
    };
    const path = () => {
      c.beginPath(); c.moveTo(...P[0]);
      for (let i = 1; i < P.length; i++) { const [, a, b, d] = seg(i); c.bezierCurveTo(a[0], a[1], b[0], b[1], d[0], d[1]); }
    };
    const fi = k * (P.length - 1), si = Math.min(P.length - 1, Math.floor(fi) + 1), u = fi - (si - 1);
    const [q0, q1, q2, q3] = seg(si), bz = j => (1 - u) ** 3 * q0[j] + 3 * (1 - u) ** 2 * u * q1[j] + 3 * (1 - u) * u * u * q2[j] + u ** 3 * q3[j];
    const hx = bz(0), hy = bz(1);
    c.save(); c.beginPath(); c.rect(x - width * 2, y - h, hx - x + width * 2, h * 3); c.clip();
    if (fill) {
      path(); c.lineTo(x + w, y + h); c.lineTo(x, y + h); c.closePath();
      const g = c.createLinearGradient(0, y, 0, y + h); g.addColorStop(0, rgba(color, 0.28)); g.addColorStop(1, rgba(color, 0));
      c.fillStyle = g; c.fill();
    }
    path(); c.strokeStyle = color; c.lineWidth = width; c.lineJoin = 'round'; c.lineCap = 'round';
    c.shadowColor = rgba(color, 0.6); c.shadowBlur = 18 * this.reel.scale; c.stroke();
    c.restore();
    if (head) {
      this.glow(hx, hy, 46, color, 0.55);
      c.save(); c.fillStyle = '#fff'; c.beginPath(); c.arc(hx, hy, width * 1.3, 0, Math.PI * 2); c.fill(); c.restore();
    }
  }
  /** Progress ring / donut: value 0..1. */
  ring(value, o = {}) {
    const { cx = this.cx, cy = this.cy, r = 120, width = 18, at = 0, dur = 1.2, color = '#9b87ff', track = 'rgba(255,255,255,.08)', easing = 'outExpo' } = o;
    const c = this.ctx, k = this.tween(at, dur, easing) * value;
    c.save(); c.lineWidth = width; c.lineCap = 'round';
    c.strokeStyle = track; c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
    if (k > 0.001) { c.strokeStyle = color; c.shadowColor = rgba(color, 0.6); c.shadowBlur = 20 * this.reel.scale; c.beginPath(); c.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2); c.stroke(); }
    c.restore();
    return k;
  }
}

// ───────────────────────────── the reel ─────────────────────────────

class Reel {
  constructor(opts = {}) {
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
    this.opts = opts;
    this.dw = opts.width ?? 1920; this.dh = opts.height ?? 1080;
    this.fps = +(q.get('fps') || opts.fps || 60);
    const size = q.get('size');
    const [ow, oh] = size ? size.split('x').map(Number) : [this.dw, this.dh];
    this.W = ow; this.H = oh;
    this.scale = Math.min(ow / this.dw, oh / this.dh);
    this.w = ow / this.scale; this.h = oh / this.scale;   // logical size grows along the extra axis if aspect differs
    this.list = []; this.overlays = []; this.images = {};
    this.motionBlur = opts.motionBlur ?? false;
    this.mode = q.has('render') ? 'render' : q.has('preview') ? 'preview' : 'play';
  }
  /** Add a scene. opts.transition: 'fade' | 'whip' | 'zoom' | 'wipe' | 'iris' | 'push' | 'cut' | { type, duration, ...options }. */
  scene(name, duration, draw, opts = {}) {
    if (typeof name !== 'string') throw new Error('reelkit: scene(name, duration, draw) — name must be a string');
    if (!(duration > 0)) throw new Error(`reelkit: scene "${name}" needs a positive duration in seconds`);
    if (typeof draw !== 'function') throw new Error(`reelkit: scene "${name}" needs a draw function`);
    let tr = opts.transition ?? null;
    if (typeof tr === 'string') tr = { type: tr };
    if (tr) {
      tr = { duration: tr.type === 'cut' ? 0.0001 : { fade: 0.6, whip: 0.45, zoom: 0.7, wipe: 0.8, iris: 0.9, push: 0.7 }[tr.type] ?? 0.6, ...tr };
      if (!transitions[tr.type]) throw new Error(`reelkit: unknown transition "${tr.type}". Available: ${Object.keys(transitions).join(', ')}`);
    }
    this.list.push({ name, duration, draw, transition: tr, motionBlur: opts.motionBlur });
    return this;
  }
  /** Drawn above every scene in global time (logo bug, captions, progress bar). */
  overlay(draw) { this.overlays.push(draw); return this; }

  async _load() {
    const jobs = [];
    if (this.opts.fonts !== false) {
      for (const [fam, file, desc] of BUILTIN_FONTS) jobs.push(new FontFace(fam, `url(${new URL(file, FONT_DIR)})`, desc).load().then(f => document.fonts.add(f)));
    }
    for (const [fam, src] of Object.entries(this.opts.fonts && typeof this.opts.fonts === 'object' ? this.opts.fonts : {})) {
      const [url, desc] = Array.isArray(src) ? src : [src, {}];
      jobs.push(new FontFace(fam, `url(${new URL(url, location.href)})`, desc).load().then(f => document.fonts.add(f)));
    }
    for (const [name, url] of Object.entries(this.opts.images || {})) {
      jobs.push(new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => { this.images[name] = img; res(); };
        img.onerror = () => rej(new Error(`reelkit: image "${name}" failed to load from ${url}`));
        img.src = url;
      }));
    }
    const results = await Promise.allSettled(jobs);
    const bad = results.filter(r => r.status === 'rejected');
    if (bad.length) throw new Error(bad.map(b => b.reason?.message || String(b.reason)).join('; '));
    await document.fonts.ready;
  }

  /** Finalises the timeline, loads fonts/images, exposes window.READY / END / FPS / renderFrame. */
  start() {
    if (this.started) return this;
    this.started = true;
    if (!this.list.length) throw new Error('reelkit: add at least one scene before start()');
    this.timeline = layoutScenes(this.list);
    this.duration = this.opts.duration ?? this.timeline[this.timeline.length - 1].end;
    document.documentElement.style.background = '#000';
    let cv = document.getElementById('c');
    if (!cv) { cv = document.createElement('canvas'); cv.id = 'c'; document.body.appendChild(cv); }
    cv.width = this.W; cv.height = this.H;
    if (this.mode !== 'render') {
      const st = document.createElement('style');
      st.textContent = 'html,body{margin:0;height:100%;background:#000;overflow:hidden}body{display:flex;align-items:center;justify-content:center}#c{max-width:100vw;max-height:100vh;display:block}';
      document.head.appendChild(st);
    } else document.body.style.margin = '0';
    this.canvas = cv; this.out = cv.getContext('2d');
    const mkb = () => mk(this.W, this.H);
    this.buf = { frame: mkb(), a: mkb(), b: mkb(), tr: mkb(), tr2: mkb(), tmp: mkb(), acc: mkb() };
    window.FPS = this.fps; window.END = this.duration;
    window.renderFrame = t => this.renderFrame(t);
    window.__reel = {
      width: this.W, height: this.H, designWidth: this.dw, designHeight: this.dh, fps: this.fps, duration: this.duration,
      scenes: this.timeline.map(s => ({ name: s.name, start: +s.start.toFixed(4), end: +s.end.toFixed(4), transition: s.transition?.type || null })),
    };
    window.READY = this._load().then(() => { this.renderFrame(0); return true; });
    window.READY.catch(e => console.error(e.message || e));
    if (this.mode === 'play') this._autoplay();
    return this;
  }

  _drawScene(sc, T, canvas) {
    const c = canvas.getContext('2d');
    reset(c); c.clearRect(0, 0, canvas.width, canvas.height);
    c.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    const f = new Frame(this, c, sc, T);
    sc.draw(f);
    reset(c);
  }

  /** Composites the full frame at global time T into `canvas`. */
  compose(T, canvas) {
    const c = canvas.getContext('2d'), TL = this.timeline;
    reset(c);
    c.fillStyle = this.opts.background || '#000'; c.fillRect(0, 0, this.W, this.H);
    T = clamp(T, 0, this.duration);
    let i = TL.findIndex(s => T < s.end);
    if (i < 0) i = TL.length - 1;
    const sc = TL[i], next = TL[i + 1];
    const inTr = next && next.transition && T >= next.start;
    if (!inTr) {
      this._drawScene(sc, T, this.buf.a);
      c.drawImage(this.buf.a, 0, 0);
    } else {
      const tr = next.transition, def = transitions[tr.type], k = clamp((T - next.start) / tr.duration);
      this._drawScene(sc, T, this.buf.a);
      this._drawScene(next, T, this.buf.b);
      // motion blur: supersample k across `blur` frame intervals; enough samples that steps stay < ~12px
      const shutter = (tr.blur ?? def.blur ?? 0) / this.fps / tr.duration;
      let n = 1;
      if (shutter > 0) {
        const e = toEase(tr.ease || def.ease || 'inOut'), travel = Math.abs(e(clamp(k + shutter / 2)) - e(clamp(k - shutter / 2))) * Math.max(this.W, this.H);
        n = tr.samples ?? clamp(Math.ceil(travel / 8), 1, 36);
      }
      accumulate(this.buf.tr, n, (ctx, u) => def.draw(ctx, this.buf.a, this.buf.b, clamp(k + (u - 0.5) * shutter), tr, this.buf.tmp), this.buf.tr2);
      c.drawImage(this.buf.tr, 0, 0);
    }
    if (this.overlays.length) {
      const pseudo = { name: '__overlay', start: 0, duration: this.duration };
      c.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      for (const ov of this.overlays) { c.save(); ov(new Frame(this, c, pseudo, T)); c.restore(); }
      reset(c);
    }
  }
  _blurFor(T) {
    const TL = this.timeline;
    // inside a transition that blurs itself, don't also supersample the whole frame
    if (TL.some(s => s.transition && T >= s.start && T < s.start + s.transition.duration && (s.transition.blur ?? transitions[s.transition.type].blur))) return null;
    const sc = TL.find(s => T >= s.start && T < s.end) || TL[TL.length - 1];
    const m = sc.motionBlur ?? this.motionBlur;
    if (!m) return null;
    return { samples: m.samples ?? (typeof this.motionBlur === 'object' ? this.motionBlur.samples : null) ?? 6, shutter: m.shutter ?? (typeof this.motionBlur === 'object' ? this.motionBlur.shutter : null) ?? 0.5 };
  }

  /** Draws the frame at time t (seconds) to the visible canvas. Pure in t. */
  renderFrame(t) {
    const mb = this._blurFor(t);
    const out = this.out;
    if (!mb || mb.samples <= 1) {
      this.compose(t, this.buf.frame);
    } else {
      const span = mb.shutter / this.fps;
      accumulate(this.buf.frame, mb.samples, (ctx, u) => this.compose(t + (u - 0.5) * span, ctx.canvas), this.buf.acc);
      // accumulate() draws into the scratch canvas and averages into buf.frame
    }
    reset(out);
    out.drawImage(this.buf.frame, 0, 0);
    this._finish(out, t);
  }

  _finish(c, t) {
    const { vignette = 0, grain = 0 } = this.opts;
    if (vignette > 0) {
      const W = this.W, H = this.H, g = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.6);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${vignette})`);
      c.fillStyle = g; c.fillRect(0, 0, W, H);
    }
    if (grain > 0) {
      if (!this._grain) {
        const n = mk(256, 256), x = n.getContext('2d'), d = x.createImageData(256, 256), r = rng(4242);
        for (let i = 0; i < d.data.length; i += 4) { const v = r() * 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
        x.putImageData(d, 0, 0); this._grain = n;
      }
      const f = Math.round(t * this.fps), ox = Math.floor(hash(f, 1) * 256), oy = Math.floor(hash(f, 2) * 256);
      c.save(); c.globalAlpha = grain; c.globalCompositeOperation = 'overlay';
      c.translate(-ox, -oy); c.fillStyle = c.createPattern(this._grain, 'repeat'); c.fillRect(0, 0, this.W + 256, this.H + 256);
      c.restore();
    }
  }

  _autoplay() {
    const q = new URLSearchParams(location.search);
    window.READY.then(() => {
      if (q.has('t')) { this.renderFrame(+q.get('t')); return; }
      let t0 = null;
      const tick = now => {
        if (t0 === null) t0 = now;
        const t = ((now - t0) / 1000) % this.duration;
        this.renderFrame(t);
        requestAnimationFrame(tick);
      };
      document.addEventListener('click', () => { t0 = null; });
      requestAnimationFrame(tick);
    });
  }
}

/** Create a reel. opts: width, height, fps, background, motionBlur ({samples, shutter} | false), grain, vignette, fonts, images, duration. */
export function reel(opts) { return new Reel(opts); }
export default reel;
