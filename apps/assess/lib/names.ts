import type { Locale } from "./i18n";

/**
 * A nickname followed by Chinese text: 「小鹿的」, 「小鹿邀请你」 with no gap, but 「Leo 的」 with one, as Chinese typesetting puts a space
 * between Latin letters or digits and Chinese characters and none between two runs of Chinese. In English (`rest` already English,
 * "invites you to …") there is always a space.
 */
export const withName = (name: string, rest: string, locale?: Locale): string =>
  `${name}${locale === "en" || /[A-Za-z0-9]$/.test(name) ? " " : ""}${rest}`;
