// new: copy a template into a fresh folder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SceneError } from './session.js';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATES = {
  launch: 'examples/launch.html',
  stats: 'examples/stats.html',
  terminal: 'examples/terminal.html',
  vertical: 'examples/vertical.html',
  blank: 'templates/blank.html',
};

export function scaffold(name, { template = 'launch', force = false } = {}) {
  if (!name) throw new SceneError('usage: reelkit new <name> [--template launch|stats|terminal|vertical|blank]');
  const src = TEMPLATES[template];
  if (!src) throw new SceneError(`unknown template "${template}". Available: ${Object.keys(TEMPLATES).join(', ')}`);
  const dir = path.resolve(name), file = path.join(dir, 'scene.html');
  if (fs.existsSync(file) && !force) throw new SceneError(`${file} already exists (use --force to overwrite)`);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(PKG, src), file);
  return file;
}
