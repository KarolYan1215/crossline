import { describe, expect, test } from "vitest";
import { AGENT_ITEMS, FOOT_ITEMS, NAV_ITEMS, PHONE_MORE, PHONE_TABS, RHYTHM_ITEMS, SIDE_ITEMS, WORK_ITEMS } from "./nav-items";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { RunningHead } from "./running-head";
import { PLAN_TABS } from "./plan-tabs";

describe("the navigation (2026-11-10 restructure)", () => {
  test("计划与复盘 is one entry whose page is one of its own tabs", () => {
    const entry = RHYTHM_ITEMS.find((item) => item.label === "计划与复盘")!;
    expect(PLAN_TABS.map((tab) => tab.label)).toEqual(["本周承诺", "计划", "收工", "周复盘"]);
    expect(PLAN_TABS.map((tab) => tab.href)).toContain(entry.href);
    expect(NAV_ITEMS.map((item) => item.href)).toContain(entry.href);
  });

  test("the side bar has 记账本 beside 主线, and the agent group with Agent 产出 and 自动化; 报告 is gone", () => {
    const work = WORK_ITEMS.map((item) => item.label);
    expect(work.indexOf("记账本")).toBe(work.indexOf("主线") + 1);
    expect(AGENT_ITEMS.map((item) => [item.label, item.href])).toEqual([["Agent 产出", "/outputs"], ["自动化", "/automation"]]);
    const everything = [...NAV_ITEMS, ...WORK_ITEMS, ...RHYTHM_ITEMS, ...AGENT_ITEMS, ...PHONE_TABS, ...PHONE_MORE];
    expect(everything.map((item) => item.href)).not.toContain("/reports");
    for (const old of ["/commit", "/wrap", "/review"]) expect(everything.map((item) => item.href)).not.toContain(old);
  });

  test("the phone keeps four tabs and 「更多」 reaches every other side-bar entry", () => {
    expect(PHONE_TABS).toHaveLength(4);
    const phone = new Set([...PHONE_TABS, ...PHONE_MORE].map((item) => item.href));
    for (const item of [...WORK_ITEMS, ...RHYTHM_ITEMS, ...AGENT_ITEMS]) expect(phone.has(item.href)).toBe(true);
  });

  test("without the side bar (under 1025px) the running head reaches every side-bar page: its row, 待确认/设置 and 「更多」", () => {
    const html = renderToStaticMarkup(createElement(RunningHead, { focus: false }));
    const reached = new Set([...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]));
    const menu = html.slice(html.indexOf('role="menu"'));
    for (const label of ["记账本", "Agent 产出", "自动化", "画像", "导入"]) expect(menu).toContain(label);
    for (const item of [...NAV_ITEMS, ...SIDE_ITEMS]) expect(reached.has(item.href)).toBe(true);
    expect([...WORK_ITEMS, ...RHYTHM_ITEMS, ...AGENT_ITEMS, ...FOOT_ITEMS].every((item) => reached.has(item.href) || menu.includes(item.label))).toBe(true);
  });
});
