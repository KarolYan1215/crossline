import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { LocaleProvider } from "../locale-context";
import { LanguageCard } from "./language-card";
import { QuotaCard } from "./quota-card";
import { BackgroundModule } from "./background-module";
import { UsageCard } from "./usage-card";
import { CalendarAppsView } from "../connectors/calendar-apps";

/** Settings in English (docs/i18n.md): the same cards, read in the other language. */
vi.mock("server-only", () => ({}));
const EN_CTX = { principalId: "test-owner", workspaceId: "test-workspace", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "test-owner" },
  authMethod: "session" as const, requestId: "test-request", locale: "en" as const };
vi.mock("../../lib/access-guard", () => ({ requireSessionContext: async () => EN_CTX }));

const english = (node: ReactNode) => renderToStaticMarkup(<LocaleProvider locale="en">{node}</LocaleProvider>);

describe("settings in English", () => {
  test("the language choice names each language in itself and says what follows it", () => {
    const html = english(<LanguageCard />);
    expect(html).toContain("Language");
    expect(html).toContain("中文");
    expect(html).toContain("English");
    expect(html).toContain("Content already written stays in its original language");
    // The page's own language is the one selected.
    expect(html).toMatch(/aria-checked="true"[^>]*>English</);
  });

  test("in Chinese the same card reads as before", () => {
    const html = renderToStaticMarkup(<LocaleProvider locale="zh"><LanguageCard /></LocaleProvider>);
    expect(html).toContain("界面语言");
    expect(html).toContain("已经写好的内容保持原来的语言");
    expect(html).toMatch(/aria-checked="true"[^>]*>中文</);
  });

  test("the quota reads in English, with times in 24 hours", () => {
    const now = new Date("2026-10-10T20:00:00Z");
    const html = renderToStaticMarkup(<QuotaCard locale="en" now={now} timeZone="America/Chicago" signal={{ available: true, limitReached: false,
      short: { usedPercent: 40, windowDurationMins: 300, resetsAt: Date.parse("2026-10-10T22:00:00Z") / 1000 },
      long: { usedPercent: 88, windowDurationMins: 10080, resetsAt: Date.parse("2026-10-13T05:00:00Z") / 1000 } }} />);
    expect(html).toContain("5-hour window");
    expect(html).toContain("60% left");
    expect(html).toContain("Weekly window");
    expect(html).toContain("(in about 2 h)");
    expect(html).toContain("17:00");
    expect(html).not.toMatch(/[一-鿿]/);
    expect(renderToStaticMarkup(<QuotaCard locale="en" now={now} timeZone="UTC" signal={{ available: false, reason: "chatgpt authentication required" }} />))
      .toContain("No model account is signed in yet");
  });

  test("background work counts tokens the English way and says what runs now", () => {
    const html = english(<BackgroundModule overview={{ timeZone: "America/Chicago", saver: true,
      engagement: { tier: "cooling", lastActiveAt: "2026-10-10T07:49:00.000Z" },
      kinds: [{ kind: "tutorials", label: "任务教程", explained: "为 48 小时内要做的任务查资料、写教程", paused: false, lastRunAt: "2026-10-12T19:07:16.000Z",
        lastOk: false, weekRuns: 25, weekTokens: 7_140_000, weekCacheShare: null }], running: [] }} />);
    expect(html).toContain("Only capture analysis and calendar filing");
    expect(html).toContain("Your latest action 10/10 02:49");
    expect(html).toContain("Last run 10/12 14:07 (failed)");
    expect(html).toContain("25 runs and 7.1M tokens in the last 7 days");
    expect(html).toContain("Running");
    expect(html).toContain("No assistant task is running now.");
  });

  test("model usage names each function and counts runs with plurals", () => {
    const html = renderToStaticMarkup(<UsageCard locale="en" days={7} daily={[{ day: "2026-10-15", runs: 1, totalTokens: 15_000 }]}
      summary={[{ skill: "crossline:crossline-onboarding", runs: 1, failed: 0, repairs: 1, totalTokens: 15_000, averageSeconds: 420, longestSeconds: 420 }] as never} />);
    expect(html).toContain("Tokens, last 7 days");
    expect(html).toContain("Interview: 15k tokens · 1 run · average 420 s · longest 420 s · 1 retried");
    expect(html).toContain("10-15 · 1 run");
    expect(renderToStaticMarkup(<UsageCard locale="en" days={7} daily={[]} summary={[]} />)).toContain("No model calls in the last 7 days.");
  });

  test("the calendar connectors card reads in English", () => {
    const html = english(<CalendarAppsView busy={false} problem="" onRefresh={() => {}} apps={[
      { app: "google_calendar", label: "Google", connected: true, callable: false, installUrl: null },
      { app: "microsoft_outlook_calendar", label: "Outlook", connected: false, callable: false, installUrl: "https://chatgpt.com/apps/x/connector_1" }]} />);
    expect(html).toContain("ChatGPT calendar connectors");
    expect(html).toContain("Connected, not usable yet");
    expect(html).toContain("Connect Outlook");
    expect(html).toContain("Connected, refresh");
  });

  test("the whole settings page renders its frame and modules in English", async () => {
    globalThis.crosslineStore = new CrosslineStore(":memory:");
    const { default: SettingsPage } = await import("./page");
    const html = english(await SettingsPage());
    for (const section of ["General", "Time and reminders", "Automation and assistant", "Calendar and connections", "Privacy and screen activity", "Usage and health check"]) {
      expect(html).toContain(section);
    }
    expect(html).toContain("Language");
    expect(html).toContain("No model calls in the last 7 days.");
    expect(html).toContain("No timed task finished yet");
    expect(html).toContain("When on, the assistant&#x27;s finished results take effect");
    globalThis.crosslineStore.close();
    globalThis.crosslineStore = undefined;
  }, 20000);
});
