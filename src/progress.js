// A one-line progress bar with fps and ETA (prints sparse lines when stderr is not a TTY, e.g. inside an agent).
export class Progress {
  constructor(total, { quiet = false } = {}) {
    this.total = total; this.quiet = quiet; this.t0 = Date.now(); this.lastPct = -1; this.tty = process.stderr.isTTY;
    this.lastDraw = 0;
  }
  tick(n) {
    if (this.quiet) return;
    const now = Date.now(), el = (now - this.t0) / 1000, fps = n / Math.max(el, 1e-3), eta = (this.total - n) / Math.max(fps, 1e-3);
    const pct = Math.floor((n / this.total) * 100);
    if (this.tty) {
      if (now - this.lastDraw < 80 && n < this.total) return;
      this.lastDraw = now;
      const W = 28, fill = Math.round((n / this.total) * W);
      process.stderr.write(`\r  ${'█'.repeat(fill)}${'░'.repeat(W - fill)} ${String(pct).padStart(3)}%  ${n}/${this.total} frames  ${fps.toFixed(1)} fps  ETA ${fmt(eta)}   `);
    } else if (pct >= this.lastPct + 10 || n === this.total) {
      this.lastPct = pct - (pct % 10);
      process.stderr.write(`  ${String(pct).padStart(3)}%  ${n}/${this.total} frames  ${fps.toFixed(1)} fps  ETA ${fmt(eta)}\n`);
    }
  }
  done() { if (!this.quiet && this.tty) process.stderr.write('\n'); }
}
function fmt(s) {
  if (!isFinite(s)) return '--';
  s = Math.max(0, Math.round(s));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}
