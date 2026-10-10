/**
 * Better Auth's client returns a stable `code` alongside its own English `message` (confirmed against a
 * real `sign-in/email` 403 response: `{"message":"Email not verified","code":"EMAIL_NOT_VERIFIED"}`).
 * Every other error surface in this app is Chinese; login/signup/reset-password were the one place still
 * showing raw English strings straight from the library. Unmapped codes fall back to the library's own
 * message rather than a generic "出错了" — a specific English sentence is still more useful than nothing.
 */
const AUTH_ERROR_TEXT: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "邮箱或密码不正确。",
  EMAIL_NOT_VERIFIED: "邮箱尚未验证，请查收验证邮件（包括垃圾邮件夹）并点击链接后再登录。",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "这个邮箱已经注册过了，直接登录或用「忘记密码」找回。",
  USER_ALREADY_EXISTS: "这个邮箱已经注册过了，直接登录或用「忘记密码」找回。",
  PASSWORD_TOO_SHORT: "密码至少需要 8 位。",
  PASSWORD_TOO_LONG: "密码太长了。",
  INVALID_TOKEN: "链接无效或已过期，请重新申请。",
  EXPIRED_TOKEN: "链接已过期，请重新申请。",
  // The page was opened at an address the server does not accept sign-ins from (another host name or port than the configured one).
  INVALID_ORIGIN: "当前网址不在允许登录的地址之内，请改用设置里给出的地址打开。",
  MISSING_OR_NULL_ORIGIN: "当前网址不在允许登录的地址之内，请改用设置里给出的地址打开。",
  // The mail server refused or could not be reached; the account (if this was sign-up) exists, only the message did not go out.
  VERIFICATION_EMAIL_FAILED: "邮件没有发出去：这台服务器的发信服务拒绝了这个地址或暂时连不上。账号已保留，稍后在登录页点「重发验证邮件」，或改用其他登录方式。",
  INVALID_OTP: "验证码不正确。",
  OTP_EXPIRED: "验证码已过期，请重新获取。",
  TOO_MANY_ATTEMPTS: "尝试次数过多，请重新获取验证码。",
  CHATGPT_SIGNIN_LOCAL_ONLY: "ChatGPT 登录只能在本机用 127.0.0.1 打开时使用。",
  CHATGPT_STATE_MISSING: "登录已超时，请重新点「用 ChatGPT 账号登录」。",
  CHATGPT_STATE_MISMATCH: "登录请求不匹配，请重新点「用 ChatGPT 账号登录」。",
  CHATGPT_REGISTRATION_INCOMPLETE: "OpenAI 没有完成这台电脑的注册，请重试。",
  CHATGPT_CLIENT_INVALID: "这台电脑在 OpenAI 的注册已失效，请重试；仍不行时删除数据目录里的 chatgpt-signin.json 后重试。",
  CHATGPT_TOKEN_FAILED: "OpenAI 没有完成登录，请重试。",
  CHATGPT_EMAIL_MISSING: "这个 ChatGPT 账号没有提供邮箱，无法登录。",
  account_not_linked: "这个邮箱已经用其他方式注册过；请用原来的方式登录。"
};

export function authErrorMessage(error: { code?: string | undefined; message?: string | null | undefined } | null | undefined,
  fallback: string): string {
  if (!error) return fallback;
  // Better Auth sends 「Invalid origin」 without a code: matched on the message so it is not shown in English either.
  const code = error.code ?? (/invalid origin/i.test(error.message ?? "") ? "INVALID_ORIGIN" : "");
  return AUTH_ERROR_TEXT[code] ?? error.message ?? fallback;
}
