// Finds and launches a headless Chromium: REELKIT_CHROME, then Playwright's cached browser, then installed Chrome.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);

export const CHROME_ARGS = [
  '--hide-scrollbars',
  '--mute-audio',
  '--font-render-hinting=none',          // same glyph rasterisation on every platform that honours it
  '--force-color-profile=srgb',
  '--disable-lcd-text',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

export function playwrightInfo() {
  const pkgFile = require.resolve('playwright-core/package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  const browsers = JSON.parse(fs.readFileSync(path.join(path.dirname(pkgFile), 'browsers.json'), 'utf8')).browsers;
  const rev = name => browsers.find(b => b.name === name)?.revision;
  let executable = null, exists = false;
  try { executable = chromium.executablePath(); exists = !!executable && fs.existsSync(executable); } catch { /* not resolvable */ }
  return { version: pkg.version, chromium: rev('chromium'), headlessShell: rev('chromium-headless-shell'), executable, exists };
}

/** Launch attempts in order; returns { browser, via }. Throws a friendly error if nothing works. */
export async function launchBrowser({ headless = true } = {}) {
  const attempts = [];
  if (process.env.REELKIT_CHROME) attempts.push(['REELKIT_CHROME', { executablePath: process.env.REELKIT_CHROME }]);
  attempts.push(['playwright chromium', {}]);
  attempts.push(['Google Chrome', { channel: 'chrome' }]);
  const errors = [];
  for (const [via, opts] of attempts) {
    try {
      const browser = await chromium.launch({ headless, args: CHROME_ARGS, ...opts });
      return { browser, via };
    } catch (e) {
      errors.push(`  - ${via}: ${String(e.message || e).split('\n')[0]}`);
    }
  }
  const info = playwrightInfo();
  const err = new Error(
    'reelkit could not start a headless browser.\n' + errors.join('\n') + '\n\n' +
    'Fix one of these:\n' +
    `  1. npx playwright-core install chromium-headless-shell   (playwright-core ${info.version} wants revision ${info.headlessShell})\n` +
    '  2. install Google Chrome (reelkit falls back to it automatically)\n' +
    '  3. export REELKIT_CHROME=/path/to/chrome-or-chromium\n' +
    'Then run: reelkit doctor');
  err.code = 'NO_BROWSER';
  throw err;
}
