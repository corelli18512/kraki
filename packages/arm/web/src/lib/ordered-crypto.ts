interface Entry {
  ready: boolean;
  value?: unknown;
  deliver?: (value: unknown) => void;
  cancel?: () => void;
}

/** Parallel crypto, admission-ordered completion per opaque transport domain.
 * Cancellation releases buffered results/callbacks immediately; WebCrypto itself
 * cannot be aborted. A late promise owns only its detached, emptied entry. */
export class OrderedCrypto {
  private domains = new Map<string, Entry[]>();

  run<T>(domain: string, work: () => Promise<T>, deliver: (value: T | null) => void, cancel?: () => void): void {
    const settle = this.admit(domain, deliver, cancel);
    // Both synchronous failure and rejected crypto advance the same admission slot.
    try { void work().then(settle, () => settle(null)); } catch { settle(null); }
  }

  admit<T>(domain: string, deliver: (value: T | null) => void, cancel?: () => void): (value: T | null) => void {
    let queue = this.domains.get(domain);
    if (!queue) this.domains.set(domain, queue = []);
    const entry: Entry = { ready: false, deliver: deliver as Entry['deliver'], cancel };
    queue.push(entry);
    const settle = (value: T | null) => {
      if (entry.ready || this.domains.get(domain) !== queue) return;
      entry.ready = true;
      entry.value = value;
      while (queue[0]?.ready) {
        const next = queue.shift()!;
        const { deliver, value } = next;
        next.deliver = next.cancel = next.value = undefined;
        // Consumer errors must not strand successors or reject an unobserved promise.
        try { deliver?.(value); } catch (error) { console.error('Ordered crypto delivery failed', error); }
      }
      if (queue.length === 0 && this.domains.get(domain) === queue) this.domains.delete(domain);
    };
    return settle;
  }

  clear(matches: (domain: string) => boolean = () => true): void {
    for (const [domain, queue] of [...this.domains]) {
      if (!matches(domain)) continue;
      this.domains.delete(domain);
      for (const entry of queue) {
        const cancel = entry.cancel;
        entry.deliver = entry.cancel = entry.value = undefined;
        try { cancel?.(); } catch (error) { console.error('Ordered crypto cancellation failed', error); }
      }
      queue.length = 0;
    }
  }
}
