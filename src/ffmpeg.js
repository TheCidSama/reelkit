// ffmpeg discovery, the H.264 encoder process, and an ffprobe-free probe (parses `ffmpeg -i`).
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function ffmpegPath() {
  for (const env of ['REELKIT_FFMPEG', 'FFMPEG_PATH']) {
    if (process.env[env] && fs.existsSync(process.env[env])) return process.env[env];
  }
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch { /* not installed */ }
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim().split('\n')[0];
  const err = new Error('reelkit could not find ffmpeg. It ships via the ffmpeg-static dependency: run `npm rebuild ffmpeg-static` ' +
    '(npm may have skipped its install script), or set REELKIT_FFMPEG=/path/to/ffmpeg.');
  err.code = 'NO_FFMPEG';
  throw err;
}

export function ffmpegInfo() {
  const bin = ffmpegPath();
  const v = spawnSync(bin, ['-hide_banner', '-version'], { encoding: 'utf8' });
  const enc = spawnSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  return { bin, version: (v.stdout || '').split('\n')[0], x264: /libx264/.test(enc.stdout || '') };
}

/**
 * Starts ffmpeg reading JPEG/PNG frames from stdin. Returns { write(buf), end() -> Promise }.
 */
export function startEncoder({ out, fps, codec = 'mjpeg', crf = 20, preset = 'medium', audio = null, audioStart = 0, duration }) {
  const bin = ffmpegPath();
  const args = ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(fps), '-c:v', codec, '-i', '-'];
  if (audio) args.push('-ss', String(audioStart), '-i', audio);
  args.push('-map', '0:v:0');
  if (audio) args.push('-map', '1:a:0?', '-c:a', 'aac', '-b:a', '192k', '-t', String(duration));
  args.push('-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-movflags', '+faststart', '-r', String(fps), out);
  const proc = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', d => { stderr += d; });
  const exited = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}\n${stderr.trim()}`))));
  });
  exited.catch(() => {});
  return {
    write(buf) {
      if (proc.stdin.destroyed) return Promise.reject(new Error(`ffmpeg closed its input early\n${stderr.trim()}`));
      return proc.stdin.write(buf) ? Promise.resolve() : new Promise(r => proc.stdin.once('drain', r));
    },
    async end() { proc.stdin.end(); await exited; },
    kill() { try { proc.kill('SIGKILL'); } catch { /* gone */ } },
    exited,
  };
}

/** Video facts without ffprobe: duration, size, fps, codec, pixel format, audio, exact frame count. */
export function probe(file) {
  const bin = ffmpegPath();
  const r = spawnSync(bin, ['-hide_banner', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-'], { encoding: 'utf8' });
  const s = r.stderr || '';
  const dur = s.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const vid = s.match(/Stream #\S+.*?Video: (\w+).*?, (\w+)(?:\([^)]*\))?, (\d+)x(\d+)/);
  const fps = s.match(/([\d.]+) fps/);
  const frames = [...s.matchAll(/frame=\s*(\d+)/g)].pop();
  if (!dur || !vid) throw new Error(`could not probe ${file}:\n${s.trim().split('\n').slice(-5).join('\n')}`);
  return {
    duration: +dur[1] * 3600 + +dur[2] * 60 + +dur[3],
    codec: vid[1], pixFmt: vid[2], width: +vid[3], height: +vid[4],
    fps: fps ? +fps[1] : null, frames: frames ? +frames[1] : null,
    audio: /Stream #\S+.*?Audio:/.test(s),
  };
}
