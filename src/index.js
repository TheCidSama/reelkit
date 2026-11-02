// Programmatic API: the same functions the CLI uses.
export { render, defaultWorkers } from './render.js';
export { frames } from './frames.js';
export { preview } from './preview.js';
export { doctor } from './doctor.js';
export { scaffold, TEMPLATES } from './scaffold.js';
export { openScene, resolveTimes, parseSize, SceneError } from './session.js';
export { probe, ffmpegPath } from './ffmpeg.js';
export { launchBrowser } from './browser.js';
export { serve } from './server.js';
