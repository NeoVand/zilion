/**
 * Serialises async sections on one object. A Machine reuses its buffers between runs, so two of its runs in flight
 * (e.g. Promise.all([m.run(a), m.run(b)])) must not interleave; they queue instead.
 */
export class Lock {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
