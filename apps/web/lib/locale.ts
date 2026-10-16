import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import type { AccessContext } from "@crossline/core";
import { readLocale } from "@crossline/db";
import { getStore } from "./crossline";
import { asLocale, DEFAULT_LOCALE, LOCALE_COOKIE, tFor, type Locale, type Translate } from "./i18n";

/**
 * The language a page renders in (docs/i18n.md): the browser's cookie, else Chinese. Read once per request. Code with a signed-in
 * context should prefer `localeFor(ctx)` / `tOf(ctx)`, which also adopt the account's choice on a device that has no cookie yet.
 */
export const getLocale = cache(async (): Promise<Locale> => {
  try { return asLocale((await cookies()).get(LOCALE_COOKIE)?.value); } catch { return DEFAULT_LOCALE; }
});

/** The language for text built for this context: the request's, else (a job's context) the workspace's setting. */
export function localeFor(ctx: AccessContext): Locale {
  return ctx.locale ?? readLocale(getStore(), ctx.workspaceId);
}

/** `const t = tOf(ctx); t("待确认")` in server code. */
export const tOf = (ctx: AccessContext): Translate => tFor(localeFor(ctx));
