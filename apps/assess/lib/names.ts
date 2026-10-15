/**
 * A nickname followed by Chinese text: 「小鹿的」, 「小鹿邀请你」 with no gap, but 「Leo 的」 with one, as Chinese typesetting puts a space
 * between Latin letters or digits and Chinese characters and none between two runs of Chinese.
 */
export const withName = (name: string, rest: string): string => `${name}${/[A-Za-z0-9]$/.test(name) ? " " : ""}${rest}`;
