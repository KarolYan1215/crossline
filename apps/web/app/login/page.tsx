import { LoginForm } from "./login-form";
import { headers } from "next/headers";
import { isChatgptSignInConfigured, isEmailAuthConfigured, isGoogleAuthConfigured } from "../../lib/auth";
import { isLocalInstall } from "../../lib/install-mode";
import { LocalLogin } from "./local-login";
import { AuthLayout } from "./auth-layout";
import { LOGIN_SERIF } from "../ui/serif-strings";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ verified?: string; error?: string }> }) {
  const { verified, error } = await searchParams;
  // An installed copy signs in only through the machine's own Codex (docs/local-installer.md); what the page looks like is
  // docs/onboarding-v3.md: the product drawn on the left, the one way in on the right.
  if (isLocalInstall()) return <AuthLayout title={LOGIN_SERIF.panel}><LocalLogin /></AuthLayout>;
  // OpenAI's open-source flow calls back only to 127.0.0.1, and the state cookie must be set on that same host: offered only there.
  const host = (await headers()).get("host") ?? "";
  const chatgpt = isChatgptSignInConfigured() && /^127\.0\.0\.1(:\d+)?$/.test(host);
  // The same picture as the installed copy, with the way in for a shared server (an invitee over the private network): the steps say what
  // comes after signing in, so nobody needs a separate guide to know that their own ChatGPT is connected once, inside, by a code.
  return <AuthLayout title={LOGIN_SERIF.panel}>
      <LoginForm googleEnabled={isGoogleAuthConfigured()} emailEnabled={isEmailAuthConfigured()} chatgptEnabled={chatgpt} verified={verified === "1"}
        {...(error ? { errorCode: error.slice(0, 60) } : {})} />
      <ol className="login-steps" aria-label="开始使用的步骤">{HOSTED_STEPS.map((step, index) =>
        <li key={step.title} data-state={index === 0 ? "current" : "next"}>
          <span className="login-step-mark" aria-hidden="true">{index + 1}</span>
          <span><b>{step.title}</b><small>{step.detail}</small></span>
        </li>)}</ol>
      <p className="login-privacy">{process.env.CROSSLINE_PUBLIC_BETA === "1"
        ? <span>每个账号的资料、ChatGPT 登录和模型 API key 各自隔离，不与其他账号共享；模型用本人的 ChatGPT 额度或本人的 API。退出登录即删除这台服务器上的 ChatGPT 登录。<a href="/privacy">隐私说明</a></span>
        : "资料和本人的 ChatGPT 登录都保存在运行这个 Crossline 的电脑上，只能通过私有网络访问；模型用本人的 ChatGPT 额度。"}</p>
      {process.env.ASSESS_BASE_URL?.startsWith("https://") && <p className="login-privacy">还没做过测评？<a href={process.env.ASSESS_BASE_URL}>先做约 5 分钟的思维模式测评 →</a>
        不做也能直接开始；用同一个邮箱登录，测评结果会带进访谈。</p>}
  </AuthLayout>;
}

const HOSTED_STEPS = [
  { title: "用邮箱验证码登录", detail: "第一次用这个邮箱登录即创建账号；登录后可以设一个密码，之后两种方式都能用" },
  { title: "连接模型", detail: "用能用 Codex 的 ChatGPT 账号（先在 ChatGPT 网页版 设置 → 安全 开启「设备代码登录」，进入后输入一次性代码，约 1 分钟），或者填自己的模型 API key：DeepSeek、Kimi、通义千问、智谱、OpenAI API 等" },
  { title: "和 AI 做一次深度访谈", detail: "约 30 分钟得到一份全面的 AI 时代超级个体跨人生主线报告和跨主线排程计划" }
] as const;
