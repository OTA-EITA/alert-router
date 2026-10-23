/**
 * Remembers recently sent notifications so that Alertmanager's repeats and
 * retries (or two Alertmanager replicas sending the same group) do not post
 * the same alert again within the window. Firing and resolved are separate
 * keys, so a resolve is always delivered.
 */
export class Deduper {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 10_000,
  ) {}

  /** Returns true the first time a key is seen within the window, and records it. */
  firstSeen(key: string): boolean {
    const t = this.now();
    const last = this.seen.get(key);
    if (last !== undefined && t - last < this.windowMs) return false;
    // Re-insert so the Map's iteration order stays oldest first.
    this.seen.delete(key);
    this.seen.set(key, t);
    this.prune(t);
    return true;
  }

  /** Forgets a key, e.g. when sending failed and Alertmanager will retry. */
  forget(key: string): void {
    this.seen.delete(key);
  }

  get size(): number {
    return this.seen.size;
  }

  private prune(t: number): void {
    for (const [key, at] of this.seen) {
      if (t - at < this.windowMs && this.seen.size <= this.maxEntries) break;
      this.seen.delete(key);
    }
  }
}
