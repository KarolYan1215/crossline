import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { CalendarAppsView } from "./calendar-apps";

const render = (apps: Parameters<typeof CalendarAppsView>[0]["apps"], problem = "") =>
  renderToStaticMarkup(<CalendarAppsView apps={apps} problem={problem} busy={false} onRefresh={() => {}} />);

test("a connected calendar reads 已连接; an unconnected one is a link to ChatGPT's own page for it, plus 「已连接，刷新」", () => {
  const html = render([
    { app: "google_calendar", label: "Google 日历", connected: true, callable: true, installUrl: null },
    { app: "microsoft_outlook_calendar", label: "Outlook 日历", connected: false, callable: false,
      installUrl: "https://chatgpt.com/apps/microsoft-outlook-calendar/connector_e6a7394682e24467ac68c60696f275a4" }
  ]);
  expect(html).toContain("已连接");
  expect(html).toContain('href="https://chatgpt.com/apps/microsoft-outlook-calendar/connector_e6a7394682e24467ac68c60696f275a4"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain("连接Outlook 日历");
  expect(html).toContain("已连接，刷新");
});

test("everything connected: no refresh button; a runtime problem is said in words", () => {
  expect(render([{ app: "google_calendar", label: "Google 日历", connected: true, callable: true, installUrl: null }])).not.toContain("刷新");
  expect(render([], "尚未连接模型服务；连接后才能读取外部日历。")).toContain("尚未连接模型服务");
});
