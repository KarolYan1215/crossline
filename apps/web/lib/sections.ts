/**
 * Where a page's server time goes, by named section, without copying anyone's data off the server (2026-10-16: pages took 1–5 s each on
 * the hosted beta while every loader took milliseconds on the example board). Each section adds its duration to a table on
 * `globalThis`, which `queue-server.mjs` logs once a minute as `web.sections` (count, p50, p95, total) and clears. Costs a clock read.
 */
type Table = Map<string, number[]>;
const table = (): Table => ((globalThis as { __crosslineSections?: Table }).__crosslineSections ??= new Map());

function note(name: string, started: number): void {
  const list = table().get(name) ?? [];
  // A bounded sample: a busy minute must not grow the table without end.
  if (list.length < 500) list.push(performance.now() - started);
  table().set(name, list);
}

export function timedSync<T>(name: string, run: () => T): T {
  const started = performance.now();
  try { return run(); } finally { note(name, started); }
}

export async function timed<T>(name: string, run: () => Promise<T> | T): Promise<T> {
  const started = performance.now();
  try { return await run(); } finally { note(name, started); }
}
