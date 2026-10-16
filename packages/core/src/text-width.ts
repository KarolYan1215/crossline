/**
 * How long a piece of text the person reads is, against limits that were set for Chinese (docs/i18n.md). English says the same thing in
 * about 2.5 times as many characters, so a limit of 24 for a task name is 60 letters in English. Text with any Chinese in it is measured
 * as before, character for character, so nothing written in Chinese is judged differently than it was.
 */
const HAN = /[㐀-鿿豈-﫿]/;
export const LATIN_PER_HAN = 2.5;

export function textWidth(text: string): number {
  return HAN.test(text) ? text.length : text.length / LATIN_PER_HAN;
}

/** `text` cut to `max` (in `textWidth` units): Chinese by characters as before; other text at a word boundary when one is near. */
export function clipWidth(text: string, max: number): string {
  if (textWidth(text) <= max) return text;
  if (HAN.test(text)) return text.slice(0, max);
  const limit = Math.floor(max * LATIN_PER_HAN);
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return (space >= limit * 0.6 ? cut.slice(0, space) : cut).trimEnd();
}
