import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { appPasswordPage } from "@crossline/core";
import { AppPasswordLink, MailAccounts, mailAccountStatus, type MailAccountView } from "./mail-accounts";

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

const account = (over: Partial<MailAccountView>): MailAccountView => ({ id: "m1", address: "me@gmail.com", label: "Gmail", host: "imap.gmail.com", port: 993,
  triage: true, addedAt: "2026-10-19T00:00:00Z", ...over });

test("each mailbox says when it was last read, why the last read failed, and how many new messages wait while sorting is off", () => {
  expect(mailAccountStatus(account({})).read).toBe("还没读过");
  expect(mailAccountStatus(account({ lastCheckedAt: new Date(Date.now() - 5 * 60_000).toISOString() })).read).toBe("5 分钟前读过");
  expect(mailAccountStatus(account({ lastError: { code: "MAIL_AUTH_FAILED", message: "授权码不对", at: "2026-10-20T00:00:00Z" } })).error).toBe("最近一次读取失败：授权码不对");
  expect(mailAccountStatus(account({ triage: false, unsorted: 7 })).waiting).toBe("自动整理已关闭：7 封新邮件未整理，打开后补上");
  expect(mailAccountStatus(account({ triage: true, unsorted: 2 })).waiting).toBe("2 封新邮件等待整理");
  expect(mailAccountStatus(account({ triage: false })).waiting).toBeUndefined();
});

test("the card says which signed-in account the mailboxes belong to, labels each field in full, and has its tutorial beside the button", () => {
  const html = renderToStaticMarkup(<MailAccounts accountEmail="owner@example.com" />);
  expect(html).toContain("当前登录账号 owner@example.com");
  // The hint is a visible line under the box, not a placeholder the box's width cuts off.
  expect(html).toContain("应用专用密码或授权码</span>");
  expect(html).toContain("在邮箱设置里开启 IMAP 后生成的授权码，不是登录密码");
  expect(html).toContain("接入教程：各家邮箱的授权码与服务器");
  for (const provider of ["Gmail", "QQ 邮箱 / Foxmail", "网易 163 / 126 / yeah", "iCloud", "企业与学校邮箱", "Outlook / Hotmail / 组织邮箱（不支持）"]) expect(html).toContain(provider);
});