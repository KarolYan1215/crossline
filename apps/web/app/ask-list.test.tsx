import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { Ask } from "@crossline/core";
import { AskList } from "./ask-list";

const ask = (id: string, title: string): Ask => ({ id, kind: "backplan_input", entityId: "m", title, why: "自动倒推时发现缺数据。", urgency: "now",
  dueDay: "2026-10-09", raisedAt: "", fingerprint: "f", line: "research", options: [
    { id: "have", label: "我有，现在给你", fields: [{ id: "text", label: "内容或存放位置", kind: "longtext", required: true }] },
    { id: "ask_first", label: "还没要，就按第一步去要", recommended: true },
    { id: "look", label: "去看看", href: "/milestones" }] });

// The interaction (follow-up fields, the next one coming up) is driven in e2e; this pins what the list shows at rest.
test("shows the most urgent few with their reasons and written-out options, and links to the rest", () => {
  const html = renderToStaticMarkup(<AskList initial={[ask("a", "第一条"), ask("b", "第二条"), ask("c", "第三条"), ask("d", "第四条")]} visible={3} moreHref="/approvals#asks" />);
  expect(html).toContain("需要你一句话 · 4");
  expect(html).toContain("第三条");
  expect(html).not.toContain("第四条");
  expect(html).toContain("其余 1 条 →");
  expect(html).toContain("自动倒推时发现缺数据。");
  expect(html).toContain("今天要答");
  expect(html).toContain("关系到 10-09 的截止");
  expect(html.match(/· 推荐/g)).toHaveLength(3);
  expect(html).toContain('href="/milestones"');
  expect(html).toContain("明天再问");
  expect(renderToStaticMarkup(<AskList initial={[]} visible={3} />)).toBe("");
});
