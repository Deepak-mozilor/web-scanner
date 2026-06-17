/**
 * Runs `worker` over every item in `items` with at most `concurrency` workers
 * active at the same time. Uses a shared iterator so exactly N items are in
 * flight at all times (no chunking gap at the end of each batch).
 */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const iter = items[Symbol.iterator]();

  async function drain(): Promise<void> {
    while (true) {
      const { value, done } = iter.next();
      if (done) return;
      await worker(value);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => drain()),
  );
}
