import path from "node:path";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * How this worker shows a login and runs the readers of sites behind one (docs/skills-library.md 「托管版登录」, decided 2026-10-22).
 *
 * - `local`: the person's own computer. A login is a visible browser window on their desktop (`openWorkflowLogin`), and the readers
 *   open a visible window too.
 * - `remote`: a machine with no screen of its own — the hosted beta (`CROSSLINE_PUBLIC_BETA=1`), or Linux with no `DISPLAY` or
 *   `WAYLAND_DISPLAY`. A login is a headless browser on the server whose screen is streamed into a dialog on the Crossline page
 *   (`remote-browser.ts`); the readers run headless on the same profile.
 *
 * `CROSSLINE_LOGIN_MODE=remote|local` overrides both, for a Linux desktop or for trying the popup on Windows.
 */
export type LoginMode = "remote" | "local";
export function loginMode(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): LoginMode {
  const set = env.CROSSLINE_LOGIN_MODE?.trim().toLowerCase();
  if (set === "remote" || set === "local") return set;
  if (env.CROSSLINE_PUBLIC_BETA === "1") return "remote";
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return "remote";
  return "local";
}

/** The server browser's window: wide enough that sites show their desktop layout, small enough that a frame stays a few dozen kilobytes. */
export const REMOTE_VIEWPORT = { width: 1280, height: 800 } as const;
const FLAGS = ["--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-mode"];

/**
 * Launch options for a reader (`site_read`, the favourites job): a visible window on the person's computer, headless on a server. With no
 * executable named (a server with Playwright's own Chromium under `PLAYWRIGHT_BROWSERS_PATH`) Playwright picks its own. Nothing here
 * changes what the browser says it is: no user agent, no stealth flags (CLAUDE.md 「Social platforms」).
 */
export function readerLaunchOptions(executablePath: string, mode: LoginMode = loginMode()) {
  return { ...(executablePath ? { executablePath } : {}), headless: mode === "remote",
    viewport: mode === "remote" ? { ...REMOTE_VIEWPORT } : null, args: FLAGS };
}

/**
 * Cookies that live only while the browser runs (no expiry; many single sign-ons keep their session in one) are lost when the login
 * browser closes, so the next headless read would find itself logged out. They are written beside the profile when a login ends and put
 * back when a reader opens it: the person's own cookies, in the same profile, nothing made up.
 */
export const SESSION_COOKIES_FILE = "crossline-session-cookies.json";
type Cookie = { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: "Strict" | "Lax" | "None" };

export function saveSessionCookies(profileDir: string, cookies: Cookie[]): void {
  const file = path.join(profileDir, SESSION_COOKIES_FILE);
  writeFileSync(file, JSON.stringify(cookies.filter((cookie) => cookie.expires === -1)), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows keeps its own ACLs */ }
}

export async function restoreSessionCookies(context: { addCookies: (cookies: Cookie[]) => Promise<void> }, profileDir: string): Promise<void> {
  const file = path.join(profileDir, SESSION_COOKIES_FILE);
  if (!existsSync(file)) return;
  try {
    const cookies = JSON.parse(readFileSync(file, "utf8")) as Cookie[];
    if (Array.isArray(cookies) && cookies.length) await context.addCookies(cookies);
  } catch { /* a damaged file costs a login, never the read */ }
}
