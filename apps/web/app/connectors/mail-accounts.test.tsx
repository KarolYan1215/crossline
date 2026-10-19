import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { appPasswordPage } from "@crossline/core";
import { AppPasswordLink } from "./mail-accounts";

test("a Gmail address leads to Google's app-password page for that account, in a new tab, with the way to turn on two-step verification", () => {
  const page = appPasswordPage(" Someone@Gmail.com ")!;
  expect(page.url).toBe("https://myaccount.google.com/apppasswords?authuser=someone%40gmail.com");
  expect(page.setupUrl).toBe("https://myaccount.google.com/signinoptions/twosv?authuser=someone%40gmail.com");
  const html = renderToStaticMarkup(<AppPasswordLink page={page} label="去 Google 生成应用专用密码" />);
  expect(html).toContain('href="https://myaccount.google.com/apppasswords?authuser=someone%40gmail.com"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain("还没开两步验证");
});

test("googlemail is Gmail too; a half-typed Gmail address still gets the page, without picking an account; other providers get none", () => {
  expect(appPasswordPage("a@googlemail.com")?.provider).toBe("Gmail");
  expect(appPasswordPage("@gmail.com")?.url).toBe("https://myaccount.google.com/apppasswords");
  expect(appPasswordPage("a@qq.com")).toBeUndefined();
  expect(appPasswordPage("a@gmail.com.evil.example")).toBeUndefined();
  expect(appPasswordPage("")).toBeUndefined();
});
