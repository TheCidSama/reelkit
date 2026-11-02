// A tiny static server: the scene's folder at /, the reelkit runtime at /reelkit/, the preview UI at /__reelkit/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RUNTIME_DIR = path.join(PKG, 'runtime');
export const PREVIEW_DIR = path.join(PKG, 'preview');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

function safeJoin(root, urlPath) {
  const p = path.normalize(path.join(root, decodeURIComponent(urlPath)));
  return p === root || p.startsWith(root + path.sep) ? p : null;
}

function sendFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end(`not found: ${file}`); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
}

/**
 * serve({ root, port }) -> { url, port, close(), broadcast(event, data) }.
 * extra(req, res, url) can handle a request first and return true.
 */
export function serve({ root, port = 0, host = '127.0.0.1', extra } = {}) {
  root = path.resolve(root);
  const clients = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (extra && extra(req, res, url)) return;
    if (url.pathname === '/__reelkit/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 500\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    let file;
    if (url.pathname.startsWith('/reelkit/')) file = safeJoin(RUNTIME_DIR, url.pathname.slice('/reelkit/'.length));
    else if (url.pathname.startsWith('/__reelkit/')) file = safeJoin(PREVIEW_DIR, url.pathname.slice('/__reelkit/'.length));
    else file = safeJoin(root, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file) { res.writeHead(403); res.end('forbidden'); return; }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    sendFile(res, file);
  });
  const ping = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 15000);
  ping.unref();
  return new Promise((resolve, reject) => {
    const tryListen = p => {
      server.once('error', e => {
        if (e.code === 'EADDRINUSE' && port && p < port + 20) tryListen(p + 1);
        else reject(e);
      });
      server.listen(p, host, () => {
        const actual = server.address().port;
        resolve({
          url: `http://${host}:${actual}`, port: actual, server,
          broadcast(event, data = '') { for (const c of clients) c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); },
          close() {
            clearInterval(ping);
            for (const c of clients) c.end();
            clients.clear();
            server.closeAllConnections?.();
            return new Promise(r => server.close(() => r()));
          },
        });
      });
    };
    tryListen(port);
  });
}
