import { describe, expect, test } from "vitest";
import { authErrorMessage } from "./auth-errors";

describe("authErrorMessage", () => {
  // Confirmed against a real sign-in/email 403 response while debugging why login silently failed:
  // Better Auth's client error carries a stable `code` alongside its own English `message`.
  test("translates a known Better Auth error code to Chinese", () => {
    expect(authErrorMessage({ code: "EMAIL_NOT_VERIFIED", message: "Email not verified" }, "登录失败"))
      .toBe("邮箱尚未验证，请查收验证邮件（包括垃圾邮件夹）并点击链接后再登录。");
    expect(authErrorMessage({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }, "登录失败"))
      .toBe("邮箱或密码不正确。用验证码注册的账号还没有密码：先用验证码登录后设置，或点「忘记密码」设一个。");
  });

  test("「Invalid origin」 (sent without a code, e.g. the page opened at localhost instead of 127.0.0.1) is shown in Chinese", () => {
    expect(authErrorMessage({ message: "Invalid origin" }, "注册失败")).toBe("当前网址不在允许登录的地址之内，请改用设置里给出的地址打开。");
  });

  test("falls back to the library's own message for an unmapped code, not a generic string", () => {
    expect(authErrorMessage({ code: "SOME_FUTURE_CODE", message: "A brand new error" }, "登录失败"))
      .toBe("A brand new error");
  });

  test("falls back to the caller's default when there is no error at all", () => {
    expect(authErrorMessage(undefined, "登录失败，请检查邮箱和密码")).toBe("登录失败，请检查邮箱和密码");
    expect(authErrorMessage(null, "登录失败，请检查邮箱和密码")).toBe("登录失败，请检查邮箱和密码");
  });
});
