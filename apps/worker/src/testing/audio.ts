/** Stand-in recordings for the transcription tests: room noise around −70 dBFS with a speech-loud tone over the given seconds. */
export const RATE = 16_000;
export function signal(seconds: number, speech: Array<[number, number]>): Float32Array {
  const out = new Float32Array(seconds * RATE);
  let seed = 7;
  for (let i = 0; i < out.length; i += 1) { seed = (seed * 1103515245 + 12345) % 2147483648; out[i] = (seed / 2147483648 - 0.5) * 0.0005; }
  for (const [from, to] of speech) for (let i = from * RATE; i < to * RATE; i += 1) out[i] = 0.3 * Math.sin(i / 8);
  return out;
}
