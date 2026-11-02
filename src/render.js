// render: frames from N parallel pages -> in-order reorder buffer -> ffmpeg stdin -> mp4.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openScene, SceneError } from './session.js';
import { startEncoder, probe } from './ffmpeg.js';
import { Progress } from './progress.js';

export function defaultWorkers() {
  const cpus = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(8, Math.floor(cpus / 2)));
}

export async function render(scene, o = {}) {
  const { out, fps, size, from = 0, to, audio, crf = 20, preset = 'medium', quality = 0.95, png = false, quiet = false } = o;
  const workers = Math.max(1, o.workers ?? defaultWorkers());
  if (audio && !fs.existsSync(audio)) throw new SceneError(`--audio file not found: ${audio}`);
  const log = quiet ? () => {} : (...a) => console.error(...a);
  const t0 = Date.now();
  const sess = await openScene(scene, { workers, fps, size });
  let enc;
  try {
    const { meta } = sess;
    const end = Math.min(to ?? meta.duration, meta.duration);
    if (!(end > from)) throw new SceneError(`nothing to render: --from ${from} --to ${end}`);
    const first = Math.round(from * meta.fps), total = Math.max(1, Math.round((end - from) * meta.fps));
    const outFile = path.resolve(out || scene.replace(/\.html?$/i, '') + '.mp4');
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    log(`reelkit: ${path.basename(scene)} · ${meta.width}x${meta.height} @ ${meta.fps} fps · ${(total / meta.fps).toFixed(2)} s · ${total} frames · ${workers} worker${workers > 1 ? 's' : ''}`);
    enc = startEncoder({ out: outFile, fps: meta.fps, codec: png ? 'png' : 'mjpeg', crf, preset, audio, audioStart: from, duration: total / meta.fps });
    const type = png ? 'image/png' : 'image/jpeg';

    // reorder buffer: workers render frames i ≡ w (mod N); we write strictly in order.
    const ready = new Map();
    let next = 0, failed = null, wake = null;
    const bar = new Progress(total, { quiet });
    const flush = async () => {
      while (ready.has(next)) {
        const buf = ready.get(next); ready.delete(next);
        await enc.write(buf);
        next++; bar.tick(next);
      }
    };
    let writing = Promise.resolve();
    const maxAhead = workers * 6;
    await Promise.all(sess.pages.map(async (_, w) => {
      for (let i = w; i < total && !failed; i += workers) {
        while (i - next > maxAhead && !failed) await new Promise(r => { wake = r; setTimeout(r, 50); });
        try {
          const buf = await sess.grab(w, (first + i) / meta.fps, { type, quality });
          ready.set(i, buf);
          writing = writing.then(flush);
          writing.catch(e => { failed = failed || e; });
          if (wake) { const k = wake; wake = null; k(); }
        } catch (e) { failed = failed || e; }
      }
    }));
    await writing.catch(e => { failed = failed || e; });
    if (failed) throw failed;
    await enc.end();
    bar.done();
    const info = probe(outFile);
    const secs = (Date.now() - t0) / 1000;
    const mb = fs.statSync(outFile).size / 1e6;
    log(`reelkit: wrote ${outFile}\n         ${info.width}x${info.height} · ${info.frames ?? '?'} frames · ${info.duration.toFixed(2)} s · ${mb.toFixed(2)} MB${info.audio ? ' · audio' : ''} · rendered in ${secs.toFixed(1)} s (${(total / secs).toFixed(1)} fps)`);
    return { out: outFile, frames: total, seconds: secs, bytes: fs.statSync(outFile).size, info };
  } catch (e) {
    enc?.kill();
    throw e;
  } finally {
    await sess.close();
  }
}
