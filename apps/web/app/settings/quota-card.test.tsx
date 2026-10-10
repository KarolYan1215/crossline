import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { QuotaCard } from "./quota-card";

const now = new Date("2026-10-10T20:00:00Z");

test("both windows show what is left and when each resets, in the person's zone", () => {
  const html = renderToStaticMarkup(<QuotaCard now={now} timeZone="America/Chicago" signal={{ available: true, limitReached: false,
    short: { usedPercent: 40, windowDurationMins: 300, resetsAt: Date.parse("2026-10-10T22:00:00Z") / 1000 },
    long: { usedPercent: 88, windowDurationMins: 10080, resetsAt: Date.parse("2026-10-13T05:00:00Z") / 1000 } }} />);
  expect(html).toContain("5 小时窗口");
  expect(html).toContain("剩 60%");
  expect(html).toContain("每周窗口");
  expect(html).toContain("剩 12%");
  expect(html).toContain("约 2 小时后");
  expect(html).toContain("data-low");
});

test("an API key shows money against the cap, and an unreadable quota says why", () => {
  expect(renderToStaticMarkup(<QuotaCard now={now} timeZone="UTC" signal={{ available: true, limitReached: false, money: { spentUsd: 3.2, capUsd: 10 } }} />))
    .toContain("$3.20 / $10");
  expect(renderToStaticMarkup(<QuotaCard now={now} timeZone="UTC" signal={{ available: false, reason: "chatgpt authentication required" }} />))
    .toContain("还没有登录模型账号");
});
