import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { Ask } from "@crossline/core";
import { AskList, AskStack } from "./ask-list";

const ask = (id: string, title: string): Ask => ({ id, kind: "backplan_input", entityId: "m", title, why: "自动倒推时发现缺数据。", urgency: "now",
  dueDay: "2026-10-09", raisedAt: "", fingerprint: "f", line: "research", options: [
    { id: "have", label: "我有，现在给你", fields: [{ id: "text", label: "内容或存放位置", kind: "longtext", required: true }] },
    { id: "ask_first", label: "还没要，就按第一步去要", recommended: true },
    { id: "look", label: "去看看", href: "/milestones" }] });

// The interaction (follow-up fields, the next one coming up, the arrow keys) is driven in e2e; this pins what is shown at rest.
test("Today's stack opens only the top ask, shows the next two as edges, and can be stepped through", () => {
  const html = renderToStaticMarkup(<AskStack initial={[ask("a", "第一条"), ask("b", "第二条"), ask("c", "第三条"), ask("d", "第四条")]} moreHref="/approvals#asks" />);
  expect(html).toContain("待决事项 · 4");
  expect(html).toContain("1 / 4");
  expect(html).toContain('aria-label="上一项"');
  expect(html).toContain('aria-label="下一项"');
  expect(html).toContain('class="ask-peek" data-depth="1" data-line="research">第二条');
  expect(html).toContain('data-depth="2" data-line="research">第三条');
  expect(html).not.toContain("第四条");
  expect(html).toContain("自动倒推时发现缺数据。");
  expect(html).toContain("今天要答");
  expect(html).toContain("关系到 10/9 的截止");
  expect(html.match(/· 推荐/g)).toHaveLength(1);
  expect(html).toContain('href="/milestones"');
  expect(html).toContain("明天再问");
  expect(renderToStaticMarkup(<AskStack initial={[]} />)).toBe("");
});

test("asks whose decision can wait stay out of this week's list and are listed apart with the day they come up", () => {
  const later = { ...ask("z", "下个月的事"), urgency: "later" as const, entersOn: "2026-10-20", importance: 80 };
  expect(renderToStaticMarkup(<AskStack initial={[ask("a", "第一条"), later]} />)).not.toContain("下个月的事");
  expect(renderToStaticMarkup(<AskList initial={[ask("a", "第一条"), later]} />)).not.toContain("下个月的事");
  const apart = renderToStaticMarkup(<AskList scope="later" heading="以后再定" initial={[ask("a", "第一条"), later]} />);
  expect(apart).toContain("以后再定 · 1");
  expect(apart).toContain("10-20 起列入本周");
  expect(apart).toContain("里程碑重要性 80");
  expect(apart).not.toContain("第一条");
});

