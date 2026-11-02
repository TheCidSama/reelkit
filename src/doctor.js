// doctor: can we launch a browser, draw with the bundled fonts, and encode H.264?
import { launchBrowser, playwrightInfo } from './browser.js';
import { ffmpegInfo } from './ffmpeg.js';

export async function doctor() {
  let ok = true;
  const line = (good, msg, hint) => { console.log(`${good ? '  ok ' : ' FAIL'}  ${msg}`); if (!good && hint) console.log(`        ${hint}`); if (!good) ok = false; };
  const [maj] = process.versions.node.split('.').map(Number);
  line(maj >= 20, `node ${process.versions.node}`, 'reelkit needs Node 20+');
  const pw = playwrightInfo();
  console.log(`  ..   playwright-core ${pw.version} (chromium r${pw.chromium}, headless shell r${pw.headlessShell})`);
  console.log(`  ..   cached browser: ${pw.exists ? pw.executable : 'not found' + (pw.executable ? ` (${pw.executable})` : '')}`);
  try {
    const { browser, via } = await launchBrowser();
    const page = await browser.newPage();
    const r = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 64;
      const x = c.getContext('2d'); x.filter = 'blur(2px)'; x.fillRect(10, 10, 20, 20);
      return { ua: navigator.userAgent.match(/(Headless)?Chrome\/[\d.]+/)?.[0], canvas: c.toDataURL().length > 100, letterSpacing: 'letterSpacing' in x, roundRect: typeof x.roundRect === 'function' };
    });
    await browser.close();
    line(true, `browser: ${r.ua} via ${via}`);
    line(r.canvas && r.roundRect && r.letterSpacing, 'canvas 2D: filters, roundRect, letterSpacing', 'browser is too old; Chrome 99+ needed');
  } catch (e) {
    line(false, 'browser', e.message.split('\n').join('\n        '));
  }
  try {
    const f = ffmpegInfo();
    line(true, `ffmpeg: ${f.bin}`);
    console.log(`  ..   ${f.version}`);
    line(f.x264, 'ffmpeg has libx264', 'this ffmpeg cannot encode H.264; set REELKIT_FFMPEG to one that can');
  } catch (e) {
    line(false, 'ffmpeg', e.message);
  }
  console.log(ok ? '\nreelkit is ready.' : '\nreelkit is not ready: fix the FAIL lines above.');
  return ok;
}
