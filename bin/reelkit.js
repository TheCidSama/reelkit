#!/usr/bin/env node
// reelkit CLI: render | frames | preview | new | doctor
import { parseArgs } from 'node:util';
import { render, defaultWorkers } from '../src/render.js';
import { frames } from '../src/frames.js';
import { preview } from '../src/preview.js';
import { doctor } from '../src/doctor.js';
import { scaffold, TEMPLATES } from '../src/scaffold.js';
import { parseSize, SceneError } from '../src/session.js';

const HELP = `reelkit — write one HTML file, render a motion-graphics mp4.

Usage
  reelkit render  <scene.html> [-o out.mp4] [--fps 60] [--size 1920x1080] [--from s] [--to s]
                  [--workers N] [--audio file] [--crf 20] [--preset medium] [--png]
  reelkit frames  <scene.html> (--at 1.2,intro,stats+0.5 | --every 1 | --scenes | --sheet) [-o dir|sheet.png] [--jpg]
  reelkit preview <scene.html> [--port 4747] [--no-open]
  reelkit new     <name> [--template ${Object.keys(TEMPLATES).join('|')}] [--force]
  reelkit doctor

Agent loop: write scene.html -> reelkit frames scene.html --sheet -o sheet.png -> look -> fix -> reelkit render scene.html
`;

const OPTS = {
  out: { type: 'string', short: 'o' }, fps: { type: 'string' }, size: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
  workers: { type: 'string', short: 'w' }, audio: { type: 'string' }, crf: { type: 'string' }, preset: { type: 'string' }, png: { type: 'boolean' },
  quality: { type: 'string' }, at: { type: 'string' }, every: { type: 'string' }, scenes: { type: 'boolean' }, sheet: { type: 'boolean' },
  jpg: { type: 'boolean' }, cols: { type: 'string' }, count: { type: 'string' }, port: { type: 'string' }, 'no-open': { type: 'boolean' },
  template: { type: 'string', short: 't' }, force: { type: 'boolean' }, quiet: { type: 'boolean', short: 'q' }, help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

const num = (v, name) => {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new SceneError(`--${name} must be a number (got "${v}")`);
  return n;
};

async function main() {
  let parsed;
  try { parsed = parseArgs({ options: OPTS, allowPositionals: true }); } catch (e) { throw new SceneError(`${e.message}\n\n${HELP}`); }
  const { values: v, positionals: [cmd, arg] } = parsed;
  if (v.version) { const { createRequire } = await import('node:module'); console.log(createRequire(import.meta.url)('../package.json').version); return 0; }
  if (v.help || !cmd || cmd === 'help') { console.log(HELP); return 0; }
  const needScene = () => { if (!arg) throw new SceneError(`reelkit ${cmd}: missing <scene.html>\n\n${HELP}`); return arg; };
  switch (cmd) {
    case 'render':
      await render(needScene(), {
        out: v.out, fps: num(v.fps, 'fps'), size: parseSize(v.size), from: num(v.from, 'from') ?? 0, to: num(v.to, 'to'),
        workers: num(v.workers, 'workers') ?? defaultWorkers(), audio: v.audio, crf: num(v.crf, 'crf') ?? 20, preset: v.preset || 'medium',
        png: !!v.png, quality: num(v.quality, 'quality') ?? 0.95, quiet: !!v.quiet,
      });
      return 0;
    case 'frames':
    case 'still':
      await frames(needScene(), {
        at: v.at, every: num(v.every, 'every'), scenes: !!v.scenes, sheet: !!v.sheet, out: v.out || (v.sheet ? 'sheet.png' : 'frames'),
        fps: num(v.fps, 'fps'), size: parseSize(v.size), jpg: !!v.jpg, cols: num(v.cols, 'cols') ?? 4, count: num(v.count, 'count') ?? 12, quiet: !!v.quiet,
      });
      return 0;
    case 'preview': {
      const p = await preview(needScene(), { port: num(v.port, 'port') ?? 4747, open: !v['no-open'] });
      const stop = async () => { await p.close(); process.exit(0); };
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
      return null; // keep running
    }
    case 'new': {
      const file = scaffold(arg, { template: v.template || 'launch', force: !!v.force });
      console.log(`created ${file}\n\nnext:\n  reelkit preview ${file}\n  reelkit frames ${file} --sheet -o ${arg}/sheet.png\n  reelkit render ${file} -o ${arg}/${arg.split(/[\\/]/).pop()}.mp4`);
      return 0;
    }
    case 'doctor':
      return (await doctor()) ? 0 : 1;
    default:
      throw new SceneError(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

main().then(code => { if (code !== null) process.exitCode = code; }, e => {
  console.error(`\nreelkit: ${e instanceof SceneError || e.code ? e.message : e.stack || e}`);
  process.exitCode = 1;
});
