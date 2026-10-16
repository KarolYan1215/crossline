import { SignupForm } from "./signup-form";
import { isEmailAuthConfigured } from "../../lib/auth";
import { AuthLayout } from "../login/auth-layout";
import { LOGIN_SERIF } from "../ui/serif-strings";

// Whether mail is configured is read from the server's environment at request time; prerendered, the build machine's answer would stick.
export const dynamic = "force-dynamic";

export default function SignupPage() {
  // Without mail the email sign-up routes do not exist; the form used to be shown anyway and failed with a bare 404.
  return <AuthLayout title={LOGIN_SERIF.signup}>
    {isEmailAuthConfigured() ? <SignupForm />
      : <div className="auth-form"><p>这台服务器没有配置发信，不能用邮箱注册。请在<a href="/login">登录页</a>改用其他方式登录，首次登录即创建账号。</p></div>}
  </AuthLayout>;
}
