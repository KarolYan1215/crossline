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
      <p className="login-lede">{LEDE}</p>
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
  // The same picture as the installed copy, with the way in for a shared server (an invitee over the private network): the steps say what
  // comes after signing in, so nobody needs a separate guide to know that their own ChatGPT is connected once, inside, by a code.
  return <main className="login-split">
    <section className="login-hero" aria-labelledby="login-tagline">
      <span className="login-brand pt-serif">{LOGIN_SERIF.brand}</span>
      <h1 id="login-tagline" className="login-tagline pt-serif">{LOGIN_SERIF.tagline}</h1>
      <p className="login-lede">{LEDE}</p>
      <LoginPreview />
    </section>
    <section className="login-panel" aria-labelledby="login-panel-title">
      <h2 id="login-panel-title" className="pt-serif">{LOGIN_SERIF.panel}</h2>
      <LoginForm googleEnabled={isGoogleAuthConfigured()} emailEnabled={isEmailAuthConfigured()} chatgptEnabled={chatgpt} verified={verified === "1"}
        {...(error ? { errorCode: error.slice(0, 60) } : {})} />
      <ol className="login-steps" aria-label="开始使用的步骤">{HOSTED_STEPS.map((step, index) =>
        <li key={step.title} data-state={index === 0 ? "current" : "next"}>
          <span className="login-step-mark" aria-hidden="true">{index + 1}</span>
          <span><b>{step.title}</b><small>{step.detail}</small></span>
        </li>)}</ol>
      <p className="login-privacy">{process.env.CROSSLINE_PUBLIC_BETA === "1"
        ? "内测期间，资料和本人的 ChatGPT 登录保存在开发者维护的服务器上，不与其他账号共享；模型用本人的 ChatGPT 额度。退出登录即删除这台服务器上的 ChatGPT 登录。"
        : "资料和本人的 ChatGPT 登录都保存在运行这个 Crossline 的电脑上，只能通过私有网络访问；模型用本人的 ChatGPT 额度。"}</p>
      {process.env.ASSESS_BASE_URL?.startsWith("https://") && <p className="login-privacy">还没做过测评？<a href={process.env.ASSESS_BASE_URL}>先做 4 分钟的思维模式测评 →</a>
        用同一个邮箱登录，测评结果会带进访谈。</p>}
    </section>
  </main>;
}

const LEDE = "研究、创业、创作、投资……每条主线有自己的长期目标与截止日。Crossline 从访谈和本人的材料里读出这些，把要做的事排进一周的日历，按完成情况随时重排。";

const HOSTED_STEPS = [
  { title: "用邮箱验证码登录", detail: "第一次用这个邮箱登录即创建账号，不用设密码" },
  { title: "连接本人的 ChatGPT", detail: "需要能用 Codex 的 ChatGPT 账号。先在 ChatGPT 网页版 设置 → 安全 开启「设备代码登录」（只需一次），进入后按页面提示输入一次性代码，约 1 分钟" },
  { title: "回答几轮问题", detail: "约 30 分钟得到第一版一周安排" }
] as const;
