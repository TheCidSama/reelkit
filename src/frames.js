// frames: stills at chosen moments, or a contact sheet of the whole video in one image.
import fs from 'node:fs';
import path from 'node:path';
import { openScene, resolveTimes, SceneError } from './session.js';

export async function frames(scene, o = {}) {
  const { at, every, scenes: perScene = false, sheet = false, out = 'frames', fps, size, jpg = false, quiet = false, cols = 4, count = 12 } = o;
  const log = quiet ? () => {} : (...a) => console.error(...a);
  const sess = await openScene(scene, { workers: 1, fps, size });
  try {
    const { meta } = sess;
    let times;
    if (at) times = resolveTimes(at, meta);
    else if (every) {
      times = [];
      for (let t = 0; t < meta.duration - 1e-6; t += +every) times.push({ label: t.toFixed(2), t });
    } else if (perScene && meta.scenes.length) {
      // a settled moment per scene: 65% through, clear of transitions
      times = meta.scenes.map(s => ({ label: s.name, t: s.start + (s.end - s.start) * 0.65 }));
    } else if (sheet) {
      times = Array.from({ length: count }, (_, i) => ({ label: '', t: ((i + 0.5) / count) * meta.duration }));
    } else throw new SceneError('frames: pass --at 1.2,3.4 (numbers or scene names), --every 0.5, --scenes, or --sheet');

    if (sheet) {
      const file = path.resolve(/\.(png|jpe?g)$/i.test(out) ? out : path.join(out, 'sheet.png'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const page = sess.pages[0];
      const b64 = await page.evaluate(({ times, cols }) => {
        const src = document.getElementById('c') || document.querySelector('canvas');
        const tw = 480, th = Math.round((tw * src.height) / src.width), pad = 16, lab = 30;
        const rows = Math.ceil(times.length / cols);
        const sh = document.createElement('canvas');
        sh.width = cols * tw + (cols + 1) * pad; sh.height = rows * (th + lab) + (rows + 1) * pad;
        const c = sh.getContext('2d');
        c.fillStyle = '#111'; c.fillRect(0, 0, sh.width, sh.height);
        const scenes = (window.__reel && window.__reel.scenes) || [];
        times.forEach(({ t }, i) => {
          window.renderFrame(t);
          const x = pad + (i % cols) * (tw + pad), y = pad + Math.floor(i / cols) * (th + lab + pad);
          c.drawImage(src, x, y, tw, th);
          const sc = scenes.find(s => t >= s.start && t < s.end);
          c.fillStyle = '#aaa'; c.font = '600 18px ui-monospace, Menlo, monospace'; c.textBaseline = 'top';
          c.fillText(`${t.toFixed(2)}s${sc ? '  ' + sc.name : ''}`, x, y + th + 7);
        });
        return sh.toDataURL('image/png').split(',')[1];
      }, { times, cols });
      sess.check();
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      log(`reelkit: contact sheet of ${times.length} frames -> ${file}`);
      return [file];
    }

    fs.mkdirSync(out, { recursive: true });
    const written = [];
    for (const { label, t } of times) {
      const buf = await sess.grab(0, t, jpg ? { type: 'image/jpeg', quality: 0.92 } : { type: 'image/png' });
      const name = /^[\d.]+s?$/.test(label) || !label ? `t${t.toFixed(2).padStart(6, '0')}` : `${label.replace(/[^\w.+-]/g, '_')}_t${t.toFixed(2)}`;
      const file = path.resolve(out, `${name}.${jpg ? 'jpg' : 'png'}`);
      fs.writeFileSync(file, buf);
      written.push(file);
      log(`  ${t.toFixed(3).padStart(8)}s  ${file}`);
    }
    return written;
  } finally {
    await sess.close();
  }
}
