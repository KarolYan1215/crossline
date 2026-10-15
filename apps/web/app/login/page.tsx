import { LoginForm } from "./login-form";
import { headers } from "next/headers";
import { isChatgptSignInConfigured, isEmailAuthConfigured, isGoogleAuthConfigured } from "../../lib/auth";
import { isLocalInstall } from "../../lib/install-mode";
import { LocalLogin } from "./local-login";
import { LoginPreview } from "./login-preview";
import { LOGIN_SERIF } from "../ui/serif-strings";
import "./login.css";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ verified?: string; error?: string }> }) {
  const { verified, error } = await searchParams;
  // An installed copy signs in only through the machine's own Codex (docs/local-installer.md); what the page looks like is
  // docs/onboarding-v3.md: the product drawn on the left, the one way in on the right.
  if (isLocalInstall()) return <main className="login-split">
    <section className="login-hero" aria-labelledby="login-tagline">
      <span className="login-brand pt-serif">{LOGIN_SERIF.brand}</span>
      <h1 id="login-tagline" className="login-tagline pt-serif">{LOGIN_SERIF.tagline}</h1>
      <p className="login-lede">研究、创业、创作、投资……每条主线有自己的长期目标与截止日。Crossline 从访谈和本人的材料里读出这些，把要做的事排进一周的日历，按完成情况随时重排。</p>
      <LoginPreview />
    </section>
    <section className="login-panel" aria-labelledby="login-panel-title">
      <h2 id="login-panel-title" className="pt-serif">{LOGIN_SERIF.panel}</h2>
      <LocalLogin />
    </section>
  </main>;
  // OpenAI's open-source flow calls back only to 127.0.0.1, and the state cookie must be set on that same host: offered only there.
  const host = (await headers()).get("host") ?? "";
  const chatgpt = isChatgptSignInConfigured() && /^127\.0\.0\.1(:\d+)?$/.test(host);
  return <main className="offline-page"><div>
    <span className="brand-mark">C</span>
    <h1>登录 Crossline</h1>
    <LoginForm googleEnabled={isGoogleAuthConfigured()} emailEnabled={isEmailAuthConfigured()} chatgptEnabled={chatgpt} verified={verified === "1"}
      {...(error ? { errorCode: error.slice(0, 60) } : {})} />
  </div></main>;
}
