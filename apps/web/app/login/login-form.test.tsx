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
});
