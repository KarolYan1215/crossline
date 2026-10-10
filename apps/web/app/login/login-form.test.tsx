import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { LoginForm } from "./login-form";

describe("login form", () => {
  // `.env.example` already promised "leaving Google client id/secret blank simply hides the button",
  // but the component never actually checked — clicking a Google login button with no provider
  // configured on the server just failed with nothing useful to say. Found by logging in with a real
  // account and the button being there anyway.
  test("hides the Google button when Google sign-in is not configured", () => {
    const html = renderToStaticMarkup(<LoginForm googleEnabled={false} />);
    expect(html).not.toContain("Google");
  });

  test("shows the Google button when Google sign-in is configured", () => {
    const html = renderToStaticMarkup(<LoginForm googleEnabled={true} />);
    expect(html).toContain("用 Google 账号登录");
  });

  test("offers a code by email where mail can be sent, and hides sign-up and reset where it cannot", () => {
    expect(renderToStaticMarkup(<LoginForm googleEnabled={false} emailEnabled />)).toContain("邮箱验证码");
    const noMail = renderToStaticMarkup(<LoginForm googleEnabled={true} emailEnabled={false} />);
    expect(noMail).not.toContain("邮箱验证码");
    expect(noMail).not.toContain("/signup");
    expect(noMail).not.toContain("忘记密码");
  });
});
