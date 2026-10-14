import { LoginForm } from "./login-form";
import { headers } from "next/headers";
import { isChatgptSignInConfigured, isEmailAuthConfigured, isGoogleAuthConfigured } from "../../lib/auth";
import { isLocalInstall } from "../../lib/install-mode";
import { LocalLogin } from "./local-login";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ verified?: string; error?: string }> }) {
  const { verified, error } = await searchParams;
  // An installed copy signs in only through the machine's own Codex (docs/local-installer.md).
  if (isLocalInstall()) return <main className="offline-page"><div>
    <span className="brand-mark">C</span>
    <h1>登录 Crossline</h1>
    <LocalLogin />
  </div></main>;
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
