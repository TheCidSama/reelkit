// Opens a scene in one or more headless pages and grabs frames from them. Any page error is fatal.
import fs from 'node:fs';
import path from 'node:path';
import { serve } from './server.js';
import { launchBrowser } from './browser.js';

export class SceneError extends Error {}

export function parseSize(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d+)x(\d+)$/);
  if (!m) throw new SceneError(`--size must look like 1920x1080 (got "${s}")`);
  const [w, h] = [+m[1], +m[2]];
  if (w % 2 || h % 2) throw new SceneError(`--size must be even in both dimensions for H.264 (got ${w}x${h})`);
  return { w, h };
}

/**
 * openScene(file, { workers, fps, size }) -> session with .meta, .grab(t, opts) per page, .close().
 */
export async function openScene(file, { workers = 1, fps, size, timeout = 60000 } = {}) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new SceneError(`scene not found: ${file}`);
  const root = path.dirname(abs), rel = path.basename(abs);
  const srv = await serve({ root });
  let browser;
  const errors = [];
  const close = async () => { await browser?.close().catch(() => {}); await srv.close(); };
  try {
    ({ browser } = await launchBrowser());
    const q = new URLSearchParams({ render: '' });
    if (fps) q.set('fps', String(fps));
    if (size) q.set('size', `${size.w}x${size.h}`);
    const url = `${srv.url}/${encodeURIComponent(rel)}?${q}`;

    const open = async i => {
      const ctx = await browser.newContext({ viewport: { width: Math.min(size?.w || 1920, 3840), height: Math.min(size?.h || 1080, 3840) }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      page.setDefaultTimeout(timeout);
      const tag = workers > 1 ? `[page ${i + 1}] ` : '';
      page.on('pageerror', e => errors.push(`${tag}page error: ${e.message}`));
      page.on('console', m => { if (m.type() === 'error') errors.push(`${tag}console.error: ${m.text()}`); });
      page.on('response', r => { if (r.status() >= 400) errors.push(`${tag}HTTP ${r.status()} for ${r.url().replace(srv.url, '')}`); });
      page.on('requestfailed', r => errors.push(`${tag}request failed: ${r.url().replace(srv.url, '')} (${r.failure()?.errorText})`));
      await page.goto(url, { waitUntil: 'load' });
      const ok = await page.evaluate(async () => {
        const t0 = performance.now();
        while (!('READY' in window) && performance.now() - t0 < 10000) await new Promise(r => setTimeout(r, 20));
        if (!('READY' in window)) return 'missing';
        try { await window.READY; return 'ok'; } catch (e) { return 'rejected: ' + (e && e.message || e); }
      });
      if (ok === 'missing') throw new SceneError(`${rel} never set window.READY. Did the runtime load? (import { reel } from '/reelkit/reel.js' and call .start())`);
      if (ok !== 'ok') throw new SceneError(`${rel}: window.READY ${ok}`);
      if (errors.length) throw new SceneError(errors.join('\n'));
      return page;
    };
    const first = await open(0);
    const meta = await first.evaluate(() => {
      const c = document.getElementById('c') || document.querySelector('canvas');
      const r = window.__reel || {};
      return {
        fps: window.FPS ?? r.fps, duration: window.END ?? r.duration,
        width: c ? c.width : r.width, height: c ? c.height : r.height,
        scenes: r.scenes || [], hasCanvas: !!c, hasRender: typeof window.renderFrame === 'function',
      };
    });
    if (!meta.hasCanvas) throw new SceneError(`${rel} has no <canvas> (the runtime creates #c; custom scenes need <canvas id="c">)`);
    if (!meta.hasRender) throw new SceneError(`${rel} does not define window.renderFrame(t)`);
    if (!(meta.duration > 0)) throw new SceneError(`${rel}: window.END (duration in seconds) is missing or not positive`);
    if (!(meta.fps > 0)) meta.fps = 60;
    if (fps) meta.fps = fps;
    const pages = [first, ...(await Promise.all(Array.from({ length: Math.max(0, workers - 1) }, (_, i) => open(i + 1))))];

    const check = () => { if (errors.length) throw new SceneError(errors.splice(0).join('\n')); };
    /** Renders t on page i and returns the encoded image as a Buffer. */
    const grab = async (i, t, { type = 'image/jpeg', quality = 0.95 } = {}) => {
      const b64 = await pages[i].evaluate(async ({ t, type, quality }) => {
        window.renderFrame(t);
        const c = document.getElementById('c') || document.querySelector('canvas');
        return c.toDataURL(type, quality).split(',')[1];
      }, { t, type, quality }).catch(e => { throw new SceneError(`renderFrame(${t.toFixed(3)}) threw: ${String(e.message).replace(/^page\.evaluate: /, '').split('\n')[0]}`); });
      check();
      return Buffer.from(b64, 'base64');
    };
    return { meta, pages, grab, check, close, url, server: srv, browser };
  } catch (e) {
    await close();
    throw e;
  }
}

/** Resolves "--at" tokens: 1.5 | intro (middle of scene) | intro+0.8 (offset into scene) | end. */
export function resolveTimes(spec, meta) {
  const out = [];
  for (const raw of String(spec).split(',').map(s => s.trim()).filter(Boolean)) {
    let t;
    if (/^-?[\d.]+s?$/.test(raw)) t = parseFloat(raw);
    else if (raw === 'end') t = meta.duration - 1 / meta.fps;
    else {
      const m = raw.match(/^(.+?)(?:([+-])([\d.]+))?$/);
      const sc = meta.scenes.find(s => s.name === m[1]);
      if (!sc) throw new SceneError(`--at: "${m[1]}" is not a number or a scene name (scenes: ${meta.scenes.map(s => s.name).join(', ') || 'none'})`);
      t = m[2] ? sc.start + (m[2] === '+' ? 1 : -1) * parseFloat(m[3]) : (sc.start + sc.end) / 2;
    }
    if (!(t >= 0 && t <= meta.duration)) throw new SceneError(`--at ${raw}: ${t}s is outside 0..${meta.duration}s`);
    out.push({ label: raw, t: Math.min(t, meta.duration - 1e-6) });
  }
  return out;
}
