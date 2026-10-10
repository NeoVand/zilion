/**
 * Serialises async sections on one object: buffers are reused between runs, so two runs in flight on the same
 * instance (e.g. Promise.all([z.run(a), z.run(b)]), which was safe in 0.2) must not interleave.
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
