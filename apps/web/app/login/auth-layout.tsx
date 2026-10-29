import type { ReactNode } from "react";
import { LoginPreview } from "./login-preview";
import { LOGIN_SERIF } from "../ui/serif-strings";
import { LocaleSwitch } from "../locale-switch";
import { tFor, type Locale } from "../../lib/i18n";
import "./login.css";

const LEDE = "研究、创业、创作、投资……每条主线有自己的长期目标与截止日。Crossline 从访谈和本人的材料里读出这些，把要做的事排进一周的日历，按完成情况随时重排。";

/**
 * The one frame of every way in — sign-in, sign-up, password reset and setting a password (2026-10-16: sign-up and reset were still
 * the old centred card): the product drawn on the left, the form on the right under a serif heading. `title` must be one of
 * `LOGIN_SERIF`'s strings, since the serif is a subset cut to exactly those characters.
 *
 * Nobody is signed in here, so the page reads its language from the cookie (`tFor(await getLocale())`) and passes it in; the switch sits
 * top right (docs/i18n.md). The serif subset holds only the Chinese headings, so English headings are set in the display face instead.
 */
export function AuthLayout({ title, locale, children, hero }: { title: (typeof LOGIN_SERIF)[keyof typeof LOGIN_SERIF]; locale?: Locale; children: ReactNode;
  /** Shown under the drawing on the left (2026-10-28: the steps after signing in, as small cards). */
  hero?: ReactNode }) {
  const t = tFor(locale);
  const serif = locale === "en" ? "" : " pt-serif";
  return <main className="login-split">
    <div className="auth-locale"><LocaleSwitch /></div>
    <section className="login-hero" aria-labelledby="login-tagline">
      <span className="login-brand pt-serif">{LOGIN_SERIF.brand}</span>
      <h1 id="login-tagline" className={`login-tagline${serif}`}>{t(LOGIN_SERIF.tagline)}</h1>
      <p className="login-lede">{t(LEDE)}</p>
      <LoginPreview locale={locale} />
      {hero}
    </section>
    <section className="login-panel" aria-labelledby="login-panel-title">
      <h2 id="login-panel-title" className={serif.trim() || undefined}>{t(title)}</h2>
      {children}
    </section>
  </main>;
}
