import { expect, test } from "vitest";
import { SUBSCRIPTION_GUIDES } from "./calendar-subscriptions";

test("every subscription guide opens the provider's own https page", () => {
  const hosts: Record<string, RegExp> = { "Google 日历": /^calendar\.google\.com$/, "Outlook（个人）": /^outlook\.live\.com$/,
    "Outlook（工作或学校）": /^outlook\.office\.com$/, "苹果 iCloud": /^www\.icloud\.com$/ };
  for (const guide of SUBSCRIPTION_GUIDES) {
    const url = new URL(guide.url);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toMatch(hosts[guide.app]!);
  }
});
