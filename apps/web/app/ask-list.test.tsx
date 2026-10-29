import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { Ask } from "@crossline/core";
import { AskList } from "./ask-list";
import { NeedsCard, needRows, quickOption } from "./today/needs-card";

const ask = (id: string, title: string): Ask => ({ id, kind: "backplan_input", entityId: "m", title, why: "自动倒推时发现缺数据。", urgency: "now",
  dueDay: "2026-10-09", raisedAt: "", fingerprint: "f", line: "research", options: [
    { id: "have", label: "我有，现在给你", fields: [{ id: "text", label: "内容或存放位置", kind: "longtext", required: true }] },
    { id: "ask_first", label: "还没要，就按第一步去要", recommended: true },
    { id: "look", label: "去看看", href: "/milestones" }] });

// The interaction (opening a row, answering, the arrow keys) is driven in e2e; this pins what Today's list shows at rest.
test("Today's 「需要处理」 lists each ask as a row with its line, a flag when due today, the recommended answer as one press and 明天再问", () => {
  const html = renderToStaticMarkup(<NeedsCard asks={[ask("a", "第一条"), { ...ask("b", "第二条"), urgency: "soon" }]} tasks={[]}
    reminders={[{ id: "r", text: "三条邮件要在银行 App 里核对", href: "/settings#mail", line: "research" }]} labels={{ research: "科研" }} today="2026-10-08" />);
  expect(html).toContain("3 件需要处理");
  expect(html).toContain("第一条");
  expect(html).toContain("第二条");
  expect(html).toContain("科研");
  // Due today is a flag with its words for a screen reader; the week's other question has none.
  expect(html.match(/class="sr-only">今天要答/g)).toHaveLength(1);
  // The recommended option is one press; an option with required fields or a link is not.
  expect(html).toContain("还没要，就按第一步去要");
  expect(html).not.toContain("我有，现在给你");
  expect(html.match(/aria-label="明天再问"/g)).toHaveLength(2);
  expect(html.match(/aria-label="展开作答"/g)).toHaveLength(2);
  // Reminders are rows that link to where they are dealt with.
  expect(html).toContain('href="/settings#mail"');
  // The link out names what it opens: all of 待确认, not a second unexplained 「全部」.
  expect(html).toMatch(/<a href="\/approvals#asks" class="pending-total-link"[^>]*>全部待确认 →<\/a>/);
  // Closed rows do not render the full card.
  expect(html).not.toContain("自动倒推时发现缺数据。");
});

test("the order: questions due today, then the work put forward, then the week's other questions, then reminders", () => {
  const rows = needRows({ asks: [{ ...ask("s", "这周"), urgency: "soon" }, ask("n", "今天")], tasks: [],
    reminders: [{ id: "r", text: "提醒", href: "/" }] });
  expect(rows.map((row) => row.key)).toEqual(["ask:n", "ask:s", "reminder:r"]);
  expect(quickOption(ask("a", "x"))?.id).toBe("ask_first");
  expect(quickOption({ ...ask("a", "x"), select: "many" })).toBeUndefined();
  expect(quickOption({ ...ask("a", "x"), options: [{ id: "o", label: "写", recommended: true, needsNote: true }] })).toBeUndefined();
});

test("asks whose decision can wait stay out of this week's list and are listed apart with the day they come up", () => {
  const later = { ...ask("z", "下个月的事"), urgency: "later" as const, entersOn: "2026-10-20", importance: 80 };
  expect(renderToStaticMarkup(<NeedsCard asks={[ask("a", "第一条"), later]} tasks={[]} reminders={[]} labels={{}} today="2026-10-08" />)).not.toContain("下个月的事");
  expect(renderToStaticMarkup(<AskList initial={[ask("a", "第一条"), later]} />)).not.toContain("下个月的事");
  const apart = renderToStaticMarkup(<AskList scope="later" heading="以后再定" initial={[ask("a", "第一条"), later]} />);
  expect(apart).toContain("以后再定 · 1");
  expect(apart).toContain("10-20 起列入本周");
  expect(apart).toContain("里程碑重要性 80");
  expect(apart).not.toContain("第一条");
});
