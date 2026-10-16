/**
 * Fixed headings outside the portrait that are set in the poster's serif (`.pt-serif`, docs/onboarding-v3.md: the login and the
 * interview share the portrait's editorial style). Strings written in code only — the self-hosted subset is cut to exactly these
 * characters (`posterSerifText` → `scripts/poster-font-subset.ts`), so anything typed by a person or a model never uses it.
 */
export const LOGIN_SERIF = { brand: "Crossline", tagline: "几条人生主线，排进同一张日历", panel: "登录", signup: "注册", reset: "重置密码",
  newPassword: "设置新密码", setPassword: "设置登录密码" } as const;

export const INTERFACE_SERIF_STRINGS: readonly string[] = [...Object.values(LOGIN_SERIF)];
