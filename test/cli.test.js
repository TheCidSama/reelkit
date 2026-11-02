// End-to-end: real headless browser + real ffmpeg.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openScene } from '../src/session.js';
import { probe } from '../src/ffmpeg.js';
import { serve } from '../src/server.js';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'reelkit.js');
const ONE = path.join(ROOT, 'test', 'fixtures', 'one.html');
const BROKEN = path.join(ROOT, 'test', 'fixtures', 'broken.html');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reelkit-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

test('render: 1-second scene -> H.264 mp4 with the right size, duration and frame count', async () => {
  const out = path.join(tmp, 'one.mp4');
  await run(process.execPath, [CLI, 'render', ONE, '-o', out, '--workers', '2', '--quiet'], { timeout: 120000 });
  const head = fs.readFileSync(out).subarray(0, 12);
  assert.equal(head.subarray(4, 8).toString(), 'ftyp');
  const info = probe(out);
  assert.equal(info.codec, 'h264');
  assert.equal(info.pixFmt, 'yuv420p');
  assert.equal(info.width, 640);
  assert.equal(info.height, 360);
  assert.equal(info.frames, 30);              // 1.0 s at 30 fps
  assert.ok(Math.abs(info.duration - 1) < 0.05, `duration ${info.duration}`);
});

test('render honours --fps, --size and --from/--to', async () => {
  const out = path.join(tmp, 'clip.mp4');
  await run(process.execPath, [CLI, 'render', ONE, '-o', out, '--fps', '24', '--size', '320x180', '--from', '0.25', '--to', '0.75', '--quiet'], { timeout: 120000 });
  const info = probe(out);
  assert.equal(info.width, 320);
  assert.equal(info.height, 180);
  assert.equal(info.frames, 12);
  assert.ok(Math.abs(info.duration - 0.5) < 0.05, `duration ${info.duration}`);
});

test('frames: --at writes PNG stills, scene names resolve', async () => {
  const dir = path.join(tmp, 'stills');
  await run(process.execPath, [CLI, 'frames', ONE, '--at', '0.3,b', '-o', dir, '--quiet'], { timeout: 120000 });
  const files = fs.readdirSync(dir).sort();
  assert.equal(files.length, 2);
  for (const f of files) {
    const b = fs.readFileSync(path.join(dir, f));
    assert.equal(b.subarray(1, 4).toString(), 'PNG');
    assert.equal(b.readUInt32BE(16), 640);    // IHDR width
  }
  assert.ok(files.some(f => f.startsWith('b_')));
});

test('frames: --sheet writes one contact sheet', async () => {
  const file = path.join(tmp, 'sheet.png');
  await run(process.execPath, [CLI, 'frames', ONE, '--sheet', '--count', '4', '-o', file, '--quiet'], { timeout: 120000 });
  assert.ok(fs.statSync(file).size > 1000);
});

test('determinism: the same t gives identical pixels across two separate browser sessions', async () => {
  const times = [0, 0.33, 0.62, 0.8, 0.95];   // includes motion blur and the whip transition
  const grab = async () => {
    const s = await openScene(ONE);
    try { return await Promise.all(times.map(async t => sha(await s.grab(0, t, { type: 'image/png' })))); } finally { await s.close(); }
  };
  const a = await grab();
  const b = await grab();
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, times.length, 'different times should differ');
});

test('determinism: rendering out of order gives the same frame', async () => {
  const s = await openScene(ONE);
  try {
    const first = sha(await s.grab(0, 0.5, { type: 'image/png' }));
    await s.grab(0, 0.9, { type: 'image/png' });
    await s.grab(0, 0.1, { type: 'image/png' });
    assert.equal(sha(await s.grab(0, 0.5, { type: 'image/png' })), first);
  } finally { await s.close(); }
});

test('render fails loudly when the scene throws', async () => {
  const out = path.join(tmp, 'broken.mp4');
  await assert.rejects(run(process.execPath, [CLI, 'render', BROKEN, '-o', out, '--quiet'], { timeout: 120000 }), e => {
    assert.match(e.stderr, /intentional failure/);
    return true;
  });
});

test('server refuses path traversal and serves the runtime', async () => {
  const srv = await serve({ root: path.join(ROOT, 'test', 'fixtures') });
  try {
    const r1 = await fetch(`${srv.url}/reelkit/reel.js`);
    assert.equal(r1.status, 200);
    const r2 = await fetch(`${srv.url}/..%2F..%2Fpackage.json`);
    assert.ok(r2.status === 403 || r2.status === 404);
  } finally { await srv.close(); }
});

test('new: scaffolds a template that renders a still', async () => {
  const dir = path.join(tmp, 'my-video');
  await run(process.execPath, [CLI, 'new', dir, '--template', 'blank']);
  assert.ok(fs.existsSync(path.join(dir, 'scene.html')));
  await run(process.execPath, [CLI, 'frames', path.join(dir, 'scene.html'), '--at', '1', '-o', path.join(dir, 'stills'), '--quiet'], { timeout: 120000 });
  assert.equal(fs.readdirSync(path.join(dir, 'stills')).length, 1);
});
