import { describe, expect, test } from "vitest";
import * as accountControl from "./codex-account-control";

type AccountState = {
  supervisor?: {
    login?: {
      state?: "pending" | "completed" | "failed" | "canceled";
      blocker?: { code: string; message: string };
    } | null;
  };
};

type AccountControlHelpers = {
  shouldPollCodexLogin?: (loginUrl: string | undefined, state: AccountState | undefined) => boolean;
  reconcileCodexLoginUrl?: (loginUrl: string | undefined, state: AccountState | undefined) => string | undefined;
  visibleCodexBlocker?: (state: AccountState | undefined) => { code: string; message: string } | undefined;
};

const helpers = accountControl as AccountControlHelpers;

describe("Codex account login observation", () => {
  test("starts polling as soon as a successful login POST provides an auth URL", () => {
    expect(helpers.shouldPollCodexLogin).toBeTypeOf("function");
    if (!helpers.shouldPollCodexLogin) return;
    expect(helpers.shouldPollCodexLogin("https://auth.example.test", undefined)).toBe(true);
  });

  test.each(["completed", "failed", "canceled"] as const)("clears the stale login URL when status becomes %s", (state) => {
    expect(helpers.reconcileCodexLoginUrl).toBeTypeOf("function");
    if (!helpers.reconcileCodexLoginUrl) return;
    expect(helpers.reconcileCodexLoginUrl("https://auth.example.test", {
      supervisor: { login: { state } }
    })).toBeUndefined();
  });

  test("surfaces the safe login failure blocker from supervisor status", () => {
    expect(helpers.visibleCodexBlocker).toBeTypeOf("function");
    if (!helpers.visibleCodexBlocker) return;
    expect(helpers.visibleCodexBlocker({
      supervisor: {
        login: {
          state: "failed",
          blocker: { code: "CODEX_LOGIN_FAILED", message: "ChatGPT 登录没有完成，请重新连接。" }
        }
      }
    })).toEqual({ code: "CODEX_LOGIN_FAILED", message: "ChatGPT 登录没有完成，请重新连接。" });
  });

  test("a worker that is down or not configured is said in words, not as the supervisor's own English", () => {
    expect(helpers.visibleCodexBlocker!({ blocker: { code: "CAPABILITY_SECRET_MISSING", message: "CROSSLINE_SUPERVISOR_CAPABILITY_SECRET is not configured" } } as never))
      .toEqual({ code: "CAPABILITY_SECRET_MISSING", message: "后台服务没有连上，稍后点「↻ 刷新状态」。" });
  });
});

// W-233: a completed sign-in whose account the runtime does not yet report kept 「未连接」 on the page until something else read again.
test("after a sign-in completes, reads go on until the account is readable, for at most CONFIRM_LOGIN_MS", () => {
  const signedInUnread = { login: { state: "completed" as const }, account: null };
  expect(accountControl.awaitingCodexAccount(signedInUnread)).toBe(true);
  expect(accountControl.shouldPollCodexLogin(undefined, signedInUnread, 10_000, 5_000)).toBe(true);
  expect(accountControl.shouldPollCodexLogin(undefined, signedInUnread, 10_000, 10_001)).toBe(false);
  // Without a sign-in that just completed (an old one left from before a sign-out), nothing is read on a timer.
  expect(accountControl.shouldPollCodexLogin(undefined, signedInUnread)).toBe(false);
  const read = { login: { state: "completed" as const }, account: { type: "chatgpt", email: "a@example.com" } };
  expect(accountControl.awaitingCodexAccount(read)).toBe(false);
  expect(accountControl.shouldPollCodexLogin(undefined, read, 10_000, 5_000)).toBe(false);
});

// 2026-11-06: the one-time code as numbered steps; the device-code switch is step 1 with a link to ChatGPT's security settings, and once a
// code is in hand the first two steps are done and the code with its copy button is the current step.
test("the one-time code is four steps that follow the sign-in, the switch first with its link", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const noop = () => undefined;
  const before = renderToStaticMarkup(<accountControl.DeviceCodeSteps userCode={undefined} loginUrl={undefined} busy={false} onStart={noop} onRenew={noop} onCopy={noop} />);
  expect(before.match(/<li /g)).toHaveLength(4);
  expect(before).toContain(`href="${accountControl.CHATGPT_SECURITY_URL}"`);
  expect(before).toMatch(/<li data-state="current" aria-current="step">.*?开启「设备代码登录」/);
  expect(before).toContain("用一次性代码连接");
  const after = renderToStaticMarkup(<accountControl.DeviceCodeSteps userCode="ABCD-1234" loginUrl="https://auth.openai.com/codex/device" busy={false} onStart={noop} onRenew={noop} onCopy={noop} />);
  expect(after.match(/data-state="done"/g)).toHaveLength(2);
  expect(after).toMatch(/<li data-state="current" aria-current="step">.*ABCD-1234.*复制代码并打开 OpenAI 页面/);
  expect(after).not.toContain(">用一次性代码连接<");
});
