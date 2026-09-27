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
  EXPIRED_TOKEN: "链接已过期，请重新申请。"
};

export function authErrorMessage(error: { code?: string | undefined; message?: string | null | undefined } | null | undefined,
  fallback: string): string {
  if (!error) return fallback;
  return AUTH_ERROR_TEXT[error.code ?? ""] ?? error.message ?? fallback;
}
