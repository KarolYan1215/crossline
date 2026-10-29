/**
 * Fixed headings outside the portrait that are set in the poster's serif (`.pt-serif`, docs/onboarding-v3.md: the login and the
 * interview share the portrait's editorial style). Strings written in code only — the self-hosted subset is cut to exactly these
 * characters (`posterSerifText` → `scripts/poster-font-subset.ts`), so anything typed by a person or a model never uses it.
 */
export const LOGIN_SERIF = { brand: "Crossline", tagline: "几条人生主线，排进同一张日历", panel: "登录", signup: "注册", reset: "重置密码",
  newPassword: "设置新密码", setPassword: "设置登录密码" } as const;

export const INTERFACE_SERIF_STRINGS: readonly string[] = [...Object.values(LOGIN_SERIF)];

/**
 * The frame's display serif (`.ds-serif`, 2026-10-28 redesign of Today): the wordmark, the day's big date and clock, and the card titles.
 * Latin letters and digits come from the self-hosted Source Serif 4 Latin subset; the Chinese characters of these titles come from
 * `display-serif.woff2`, cut by `scripts/poster-font-subset.ts --display` to exactly `displaySerifText()`. A title added here needs the
 * subset rebuilt (`display-serif.test.ts` fails until it is). Strings written in code only, like the poster's.
 */
// i18n-ignore: the characters the font subset must hold, not text shown from here (the titles are translated where they are shown).
export const DISPLAY_SERIF = { energy: "今日精力", overview: "今日概览", needs: "件需要处理", calendar: "日历", input: "输入", flywheel: "飞轮图谱" } as const;

/** The Chinese characters the display subset must hold, sorted and unique. */
export function displaySerifText(): string {
  return [...new Set(Object.values(DISPLAY_SERIF).join(""))].filter((char) => /[^\x00-\xff]/.test(char)).sort().join("");
}
