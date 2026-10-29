import { Mail, MessageCircle, ShieldCheck, Sparkles, Target } from "lucide-react";
import { LoginForm } from "./login-form";
import { headers } from "next/headers";
import { isChatgptSignInConfigured, isEmailAuthConfigured, isGoogleAuthConfigured } from "../../lib/auth";
import { isLocalInstall } from "../../lib/install-mode";
import { LocalLogin } from "./local-login";
import { AuthLayout } from "./auth-layout";
import { LOGIN_SERIF } from "../ui/serif-strings";
import { tFor } from "../../lib/i18n";
import { getLocale } from "../../lib/locale";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ verified?: string; reset?: string; deleted?: string; error?: string }> }) {
  const { verified, reset, deleted, error } = await searchParams;
  // Nobody is signed in yet: the language is the browser's cookie (docs/i18n.md).
  const locale = await getLocale();
  const t = tFor(locale);
  // An installed copy signs in only through the machine's own Codex (docs/local-installer.md); what the page looks like is
  // docs/onboarding-v3.md: the product drawn on the left, the one way in on the right.
  if (isLocalInstall()) return <AuthLayout title={LOGIN_SERIF.panel} locale={locale}><LocalLogin /></AuthLayout>;
  // OpenAI's open-source flow calls back only to 127.0.0.1, and the state cookie must be set on that same host: offered only there.
  const host = (await headers()).get("host") ?? "";
  const chatgpt = isChatgptSignInConfigured() && /^127\.0\.0\.1(:\d+)?$/.test(host);
  // The same picture as the installed copy, with the way in for a shared server (an invitee over the private network): the steps say what
  // comes after signing in, so nobody needs a separate guide to know that their own ChatGPT is connected once, inside, by a code.
  // The three steps after signing in, as small cards under the drawing (2026-10-28 redesign); how to connect a model is explained on /connect.
  const steps = <ol className="login-step-cards" aria-label={t("开始使用的步骤")}>{HOSTED_STEPS.map((step, index) => { const Icon = step.icon;
    return <li key={step.title} data-state={index === 0 ? "current" : "next"}>
      <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
      <b>{t(step.title)}</b><small>{t(step.detail)}</small>
    </li>; })}</ol>;
  return <AuthLayout title={LOGIN_SERIF.panel} locale={locale} hero={steps}>
      <LoginForm googleEnabled={isGoogleAuthConfigured()} emailEnabled={isEmailAuthConfigured()} chatgptEnabled={chatgpt} verified={verified === "1"} reset={reset === "1"} deleted={deleted === "1"}
        {...(error ? { errorCode: error.slice(0, 60) } : {})} />
      <div className="login-foot">
        <p className="login-privacy"><ShieldCheck size={16} strokeWidth={1.75} aria-hidden="true" />{process.env.CROSSLINE_PUBLIC_BETA === "1"
          ? <span>{t("每个账号的资料、ChatGPT 登录和模型 API key 各自隔离，不与其他账号共享；模型用本人的 ChatGPT 额度或本人的 API。退出登录即删除这台服务器上的 ChatGPT 登录。")}{" "}<a href="/privacy">{t("隐私说明")}</a></span>
          : <span>{t("资料和本人的 ChatGPT 登录都保存在运行这个 Crossline 的电脑上，只能通过私有网络访问；模型用本人的 ChatGPT 额度。")}</span>}</p>
        {process.env.ASSESS_BASE_URL?.startsWith("https://") && <p className="login-privacy login-note"><Target size={16} strokeWidth={1.75} aria-hidden="true" /><span>{
          // One sentence with its link marked, so the link sits where each language puts it.
          t("还没做过测评？可以<a>先做约 5 分钟的 AI 时代超级个体测评 →</a>，不做也能直接开始；用同一个邮箱登录，测评结果会带进访谈。")
            .split(/<a>(.*?)<\/a>/).map((part, index) => index % 2 ? <a key={index} href={process.env.ASSESS_BASE_URL}>{part}</a> : part)}</span></p>}
      </div>
  </AuthLayout>;
}

const HOSTED_STEPS = [
  { icon: Mail, title: "用邮箱验证码登录", detail: "验证码 10 分钟内有效，之后也可以设密码" },
  { icon: Sparkles, title: "连接模型", detail: "本人的 ChatGPT 账号，或模型 API key" },
  { icon: MessageCircle, title: "和 AI 做一次深度访谈", detail: "约 30 分钟，得到画像报告与第一周计划" }
] as const;
