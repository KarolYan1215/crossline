import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { SUBSCRIPTION_GUIDES } from "@crossline/core";
import { CalendarSetupStep } from "./calendar-setup-step";

test("the calendar step offers the providers first, can be skipped, and carries the ChatGPT Google calendar connector", () => {
  const html = renderToStaticMarkup(<CalendarSetupStep />);
  expect(html).toContain("日历（可跳过）");
  expect(html).toContain("跳过");
  // Provider first: each is a choice on the page, not a link that leaves it before the steps are read.
  for (const guide of SUBSCRIPTION_GUIDES) expect(html).toContain(`role="radio" aria-checked="false" class="ob-btn secondary-button">${guide.app}</button>`);
  expect(html).not.toContain("<details class=\"advanced setup-guide\"");
  expect(html).toContain("ChatGPT 日历连接器");
  expect(html).toContain("只写 Crossline 自己建的日程");
});

test("every provider says what goes wrong with it: Google's slow refresh, work and school accounts, and what to do after a leak", () => {
  const google = SUBSCRIPTION_GUIDES.find((guide) => guide.app === "Google 日历")!;
  expect(google.note).toContain("12–24 小时");
  expect(google.note).toContain("学校或公司");
  expect(google.note).toContain("重置");
  for (const guide of SUBSCRIPTION_GUIDES) expect(guide.note, guide.app).toMatch(/泄露/);
});
