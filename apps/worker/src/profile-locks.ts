import path from "node:path";

/**
 * Who has a site's browser profile open in this worker: a login (the popup's server browser, `remote-browser.ts`), a run's
 * `site_read` (`site-reader.ts`) or the favourites job (`favourites-reader.ts`). Chromium allows one process per profile folder, so a
 * second opener would only fail to start; each checks here first and says why it waits instead.
 */
export type ProfileHolder = "login" | "reader" | "collect";
const held = new Map<string, ProfileHolder>();
const key = (dir: string) => path.resolve(dir).toLowerCase();

export const profileHolder = (dir: string): ProfileHolder | undefined => held.get(key(dir));
/** Takes the profile for `holder`; false when someone else has it. Taking one already held by the same kind is allowed (one run reopening it). */
export function holdProfile(dir: string, holder: ProfileHolder): boolean {
  const now = held.get(key(dir));
  if (now && now !== holder) return false;
  held.set(key(dir), holder);
  return true;
}
export function releaseProfile(dir: string, holder: ProfileHolder): void {
  if (held.get(key(dir)) === holder) held.delete(key(dir));
}

export const HOLDER_WORDS: Record<ProfileHolder, string> = { login: "登录窗口还开着", reader: "助手正在读取这个网站", collect: "正在读取收藏" };
