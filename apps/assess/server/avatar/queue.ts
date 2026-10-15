/**
 * A small in-process job queue: at most `concurrency` jobs at once (SiliconFlow's lowest image tier allows 2 images a minute), and at most
 * `maxPending` waiting — past that a new job is refused, and its figure settles on the template rather than waiting minutes for a picture
 * nobody will still be looking at. Jobs are lost on restart; `avatarStatus` reports a figure stuck that way as its template.
 */
export type Queue = {
  /** False when the queue is full and the job was not taken. */
  push(job: () => Promise<void>): boolean;
  /** Jobs waiting plus jobs running. */
  size(): number;
  /** Resolves once nothing is waiting or running (for tests and shutdown). */
  idle(): Promise<void>;
};

export function createQueue(options: { concurrency: number; maxPending: number }): Queue {
  const waiting: Array<() => Promise<void>> = [];
  let running = 0;
  let idlers: Array<() => void> = [];

  const settle = () => {
    if (running === 0 && waiting.length === 0) {
      const done = idlers;
      idlers = [];
      for (const resolve of done) resolve();
    }
  };
  const pump = () => {
    while (running < options.concurrency && waiting.length) {
      const job = waiting.shift()!;
      running += 1;
      void job().catch(() => undefined).finally(() => {
        running -= 1;
        pump();
        settle();
      });
    }
  };

  return {
    push(job) {
      if (waiting.length >= options.maxPending) return false;
      waiting.push(job);
      pump();
      return true;
    },
    size: () => waiting.length + running,
    idle: () => new Promise<void>((resolve) => {
      idlers.push(resolve);
      settle();
    })
  };
}
