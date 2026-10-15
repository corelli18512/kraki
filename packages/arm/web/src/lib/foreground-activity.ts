/** Account/day usage signal; never queued, no message contents or user ids. */
export class ForegroundActivity {
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = -Infinity;
  constructor(private send: () => void, private now = Date.now) {}

  private refresh = () => {
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const t = this.now();
    if (t - this.last < 60_000 && t >= this.last) return;
    this.send();
    this.last = t;
  };

  start(): void {
    this.stop();
    document.addEventListener('visibilitychange', this.refresh);
    window.addEventListener('focus', this.refresh);
    this.timer = setInterval(this.refresh, 60_000);
    this.refresh();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.last = -Infinity;
    document.removeEventListener('visibilitychange', this.refresh);
    window.removeEventListener('focus', this.refresh);
  }
}
