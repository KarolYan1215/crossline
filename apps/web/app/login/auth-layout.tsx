import type { ReactNode } from "react";
import { LoginPreview } from "./login-preview";
import { LOGIN_SERIF } from "../ui/serif-strings";
import "./login.css";

const LEDE = "研究、创业、创作、投资……每条主线有自己的长期目标与截止日。Crossline 从访谈和本人的材料里读出这些，把要做的事排进一周的日历，按完成情况随时重排。";

/**
 * The one frame of every way in — sign-in, sign-up, password reset and setting a password (2026-10-16: sign-up and reset were still
 * the old centred card): the product drawn on the left, the form on the right under a serif heading. `title` must be one of
 * `LOGIN_SERIF`'s strings, since the serif is a subset cut to exactly those characters.
 */
export function AuthLayout({ title, children }: { title: (typeof LOGIN_SERIF)[keyof typeof LOGIN_SERIF]; children: ReactNode }) {
  return <main className="login-split">
    <section className="login-hero" aria-labelledby="login-tagline">
      <span className="login-brand pt-serif">{LOGIN_SERIF.brand}</span>
      <h1 id="login-tagline" className="login-tagline pt-serif">{LOGIN_SERIF.tagline}</h1>
      <p className="login-lede">{LEDE}</p>
      <LoginPreview />
    </section>
    <section className="login-panel" aria-labelledby="login-panel-title">
      <h2 id="login-panel-title" className="pt-serif">{title}</h2>
      {children}
    </section>
  </main>;
}
