import type { ServerResponse } from 'http';

/**
 * HTTP requests still being answered, so shutdown can let them finish
 * (account API, voice settlement) before closing the database.
 */
export class InflightRequests {
  private open = 0;
  private waiters: Array<() => void> = [];

  get size(): number { return this.open; }

  track(res: ServerResponse): void {
    this.open++;
    res.once('close', () => {
      this.open--;
      if (this.open === 0) for (const wake of this.waiters.splice(0)) wake();
    });
  }

  /** Wait until none is open or `timeoutMs` passed; how many are still open. */
  async drain(timeoutMs: number): Promise<number> {
    if (this.open > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
    return this.open;
  }
}
