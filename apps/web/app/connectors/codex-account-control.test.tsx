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
          blocker: { code: "CODEX_LOGIN_FAILED", message: "Codex login failed" }
        }
      }
    })).toEqual({ code: "CODEX_LOGIN_FAILED", message: "Codex login failed" });
  });

  test("a worker that is down or not configured is said in words, not as the supervisor's own English", () => {
    expect(helpers.visibleCodexBlocker!({ blocker: { code: "CAPABILITY_SECRET_MISSING", message: "CROSSLINE_SUPERVISOR_CAPABILITY_SECRET is not configured" } } as never))
      .toEqual({ code: "CAPABILITY_SECRET_MISSING", message: "后台服务没有连上，稍后点 ↻ 刷新。" });
  });
});
