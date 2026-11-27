import { afterEach, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
const settings = new Map<string, string>();
vi.mock("./crossline", () => ({
  getStore: () => ({
    listWorkspaces: () => [{ id: "ws" }, { id: "other" }],
    getSetting: (ws: string, key: string) => settings.get(`${ws}:${key}`),
    setSetting: (ws: string, key: string, value: string) => settings.set(`${ws}:${key}`, value),
    deleteSetting: (ws: string, key: string) => settings.delete(`${ws}:${key}`)
  })
}));
vi.mock("@crossline/db", () => ({ readLocale: () => "zh" }));
const send = vi.fn(async (_mail: { to: string; subject: string; text: string }) => {});
vi.mock("./auth", () => ({ appMailSender: () => send }));
import type { PortraitReport } from "@crossline/core";
import { PORTRAIT_MAIL_SETTING, portraitMailPass, requestPortraitMail } from "./portrait-mail";

afterEach(() => { settings.clear(); send.mockReset(); });

const report = {
  cover: { portrait: "一个把猫画成九张的插画师。", coreConflict: "想接大单又怕被催", keywords: [], tagline: "慢热的插画师" },
  problem: { statement: "交稿总是拖到最后。", gravity: [], designable: [], reframes: [{ fallacy: "我拖延", reframe: "我在等反馈" }] },
  compass: { workView: "", lifeView: "", consistency: "", trueNorth: "画自己想画的" },
  energy: { summary: "和人一起赶稿时最有劲。", map: [], flow: [] },
  lines: { allocation: "", items: [] },
  gap: { says: "", does: "", reading: "说重视作品，时间却给了接单。", anchor: "", realWant: "", reframe: "" },
  insights: [{ insight: "反馈来得晚", advice: "每画完两张就发给对方", solves: "", priority: "high" }],
  careers: [{ role: "品牌插画", why: "已经接过三次", trial: { weeks: 2, task: "画一套节日海报", supportsIf: "", refutesIf: "" } }],
  sensitive: []
} as unknown as PortraitReport;

test("the report written after the press is mailed whole, once, to the address that pressed it", async () => {
  requestPortraitMail("ws", "Person@Example.com", new Date("2026-11-27T01:00:00Z"));
  // Not written yet: an older report (from before the press) is not the one asked for.
  settings.set("ws:portrait.report", JSON.stringify({ at: "2026-11-26T00:00:00Z", report }));
  expect(await portraitMailPass(new Date("2026-11-27T01:05:00Z"))).toEqual([]);
  expect(send).not.toHaveBeenCalled();
  settings.set("ws:portrait.report", JSON.stringify({ at: "2026-11-27T01:16:00Z", report }));
  expect(await portraitMailPass(new Date("2026-11-27T01:16:30Z"))).toEqual([{ workspaceId: "ws", state: "sent" }]);
  const mail = send.mock.calls[0]![0];
  expect(mail.to).toBe("person@example.com");
  expect(mail.subject).toBe("你的画像报告写好了");
  for (const words of ["慢热的插画师", "核心矛盾：想接大单又怕被催", "「我拖延」其实是：我在等反馈", "画自己想画的", "每画完两张就发给对方", "试做：画一套节日海报", "/portrait"])
    expect(mail.text).toContain(words);
  expect(settings.has(`ws:${PORTRAIT_MAIL_SETTING}`)).toBe(false);
  expect(await portraitMailPass(new Date("2026-11-27T01:17:30Z"))).toEqual([]);
  expect(send).toHaveBeenCalledTimes(1);
});

test("a failed send is tried again; a report never written is given up on after three hours", async () => {
  requestPortraitMail("ws", "a@b.co", new Date("2026-11-27T01:00:00Z"));
  settings.set("ws:portrait.report", JSON.stringify({ at: "2026-11-27T01:10:00Z", report }));
  send.mockRejectedValueOnce(new Error("550"));
  expect(await portraitMailPass(new Date("2026-11-27T01:11:00Z"))).toEqual([{ workspaceId: "ws", state: "failed" }]);
  expect(await portraitMailPass(new Date("2026-11-27T01:12:00Z"))).toEqual([{ workspaceId: "ws", state: "sent" }]);
  requestPortraitMail("other", "c@d.co", new Date("2026-11-27T01:00:00Z"));
  expect(await portraitMailPass(new Date("2026-11-27T03:59:00Z"))).toEqual([]);
  expect(await portraitMailPass(new Date("2026-11-27T04:01:00Z"))).toEqual([{ workspaceId: "other", state: "expired" }]);
  expect(settings.has(`other:${PORTRAIT_MAIL_SETTING}`)).toBe(false);
});
