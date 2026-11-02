// preview: serves the scene folder + a player UI, and live-reloads when any file in the folder changes.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { serve } from './server.js';
import { SceneError } from './session.js';

export async function preview(scene, { port = 4747, open = true, quiet = false } = {}) {
  const abs = path.resolve(scene);
  if (!fs.existsSync(abs)) throw new SceneError(`scene not found: ${scene}`);
  const root = path.dirname(abs), rel = path.basename(abs);
  const srv = await serve({
    root, port,
    extra(req, res, url) {
      if (url.pathname === '/' || url.pathname === '/__reelkit/') {
        res.writeHead(302, { location: `/__reelkit/index.html?scene=${encodeURIComponent(rel)}` });
        res.end();
        return true;
      }
      return false;
    },
  });
  let timer = null;
  const watcher = fs.watch(root, { recursive: true }, (_ev, file) => {
    if (!file || /(^|[\\/])(\.|node_modules|out[\\/])/.test(file) || /\.(mp4|gif|png|jpe?g)$/i.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(() => srv.broadcast('reload', { file }), 120);
  });
  const url = `${srv.url}/__reelkit/index.html?scene=${encodeURIComponent(rel)}`;
  if (!quiet) console.error(`reelkit preview: ${url}\n  watching ${root} for changes · Ctrl+C to stop`);
  if (open) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no opener */ }
  }
  return { url, close: async () => { watcher.close(); clearTimeout(timer); await srv.close(); } };
}
