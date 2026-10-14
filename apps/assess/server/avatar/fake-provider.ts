import type { EditInput, GenerateInput, ImageProvider } from "./provider";
import { ProviderError } from "./provider";

/** A 1×1 PNG: what the fake draws unless told otherwise. */
export const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

type Step = Buffer | ProviderError | Error | (() => Promise<Buffer>);

/**
 * A provider for tests: answers each call with the next scripted step (a buffer, an error to throw, or a function for slow answers),
 * then `TINY_PNG`; records every call so a test can read the prompt and seed it was given.
 */
export class FakeImageProvider implements ImageProvider {
  readonly edits: EditInput[] = [];
  readonly generations: GenerateInput[] = [];
  constructor(private readonly steps: Step[] = []) {}

  async edit(input: EditInput): Promise<Buffer> {
    this.edits.push(input);
    return this.#next();
  }

  async generate(input: GenerateInput): Promise<Buffer> {
    this.generations.push(input);
    return this.#next();
  }

  async #next(): Promise<Buffer> {
    const step = this.steps.shift();
    if (step === undefined) return TINY_PNG;
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step();
    return step;
  }
}
