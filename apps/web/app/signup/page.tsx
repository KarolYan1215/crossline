import { SignupForm } from "./signup-form";
import { isEmailAuthConfigured } from "../../lib/auth";
import { AuthLayout } from "../login/auth-layout";
import { LOGIN_SERIF } from "../ui/serif-strings";
import { tFor } from "../../lib/i18n";
import { getLocale } from "../../lib/locale";

// Whether mail is configured is read from the server's environment at request time; prerendered, the build machine's answer would stick.
export const dynamic = "force-dynamic";

export default async function SignupPage() {
  const locale = await getLocale();
  const t = tFor(locale);
  // Without mail the email sign-up routes do not exist; the form used to be shown anyway and failed with a bare 404.
  return <AuthLayout title={LOGIN_SERIF.signup} locale={locale}>
    {isEmailAuthConfigured() ? <SignupForm />
      : <div className="auth-form"><p>{t("这台服务器没有配置发信，不能用邮箱注册。请在")}<a href="/login">{t("登录页")}</a>{t("改用其他方式登录，首次登录即创建账号。")}</p></div>}
  </AuthLayout>;
}
