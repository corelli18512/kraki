/** Web equivalent of DiagRunLoop: completed foreground busy intervals only. */
export class BusyTracker {
  now: () => number = () => performance.now();
  onBusy?: (durationMs: number) => void;
  private observer: PerformanceObserver | null = null;
  private active = true;
  private activeSince = 0;

  start(enabled: () => boolean): void {
    if (this.observer || typeof PerformanceObserver === 'undefined'
      || !PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;
    const observer = new PerformanceObserver((list) => {
      if (!this.active || !enabled()) return;
      for (const entry of list.getEntries()) {
        if (entry.startTime >= this.activeSince && entry.duration >= 50) this.onBusy?.(entry.duration);
      }
    });
    try {
      observer.observe({ type: 'longtask' });
      this.observer = observer;
    } catch { observer.disconnect(); /* Unsupported outside Chromium: no diagnostics, not a startup failure. */ }
  }

  setActive(value: boolean): void {
    this.active = value;
    this.activeSince = this.now();
  }
}
