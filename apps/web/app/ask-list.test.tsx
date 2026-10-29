import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { Ask } from "@crossline/core";
import { AskList } from "./ask-list";
import { NeedsCard, TODAY_ASKS, needRows, openHref, quickOption } from "./today/needs-card";

const ask = (id: string, title: string): Ask => ({ id, kind: "backplan_input", entityId: "m", title, why: "自动倒推时发现缺数据。", urgency: "now",
  dueDay: "2026-10-09", raisedAt: "", fingerprint: "f", line: "research", options: [
    { id: "have", label: "我有，现在给你", fields: [{ id: "text", label: "内容或存放位置", kind: "longtext", required: true }] },
    { id: "ask_first", label: "还没要，就按第一步去要", recommended: true },
    { id: "look", label: "去看看", href: "/milestones" }] });

// Answering is 待确认's (scenarios.md §3.1); this pins what Today's entry to it shows.
test("Today's 「需要处理」 lists each urgent ask as a row with its line, a flag when due today, and three presses: the recommended answer, 明天再问, 打开", () => {
  const html = renderToStaticMarkup(<NeedsCard asks={[ask("a", "第一条"), { ...ask("b", "第二条"), urgency: "soon" }]}
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
  // 「打开」 is the card on 待确认, never a second copy here.
  expect(html).toContain('href="/approvals?ask=a#asks"');
  expect(html).not.toContain("自动倒推时发现缺数据。");
  expect(html).not.toContain("全部按推荐");
  // Reminders are rows that link to where they are dealt with.
  expect(html).toContain('href="/settings#mail"');
  // The link out names what it opens: all of 待确认, at the foot.
  expect(html).toMatch(/<p class="nd-foot"><a href="\/approvals#asks" class="pending-total-link"[^>]*>全部待确认 →<\/a>/);
});

test("the order: yesterday's blocks as one row, then today's questions, then the week's, at most four, then reminders", () => {
  const missed: Ask = { ...ask("missed:batch:x", "昨天排好的 2 项工作没开始"), kind: "missed_block", entityId: "batch",
    items: [{ id: "w1", title: "甲" }, { id: "w2", title: "乙" }], options: [{ id: "roll", label: "都顺延", recommended: true }, { id: "split", label: "逐个处理" }] };
  const rows = needRows({ asks: [{ ...ask("s", "这周"), urgency: "soon" }, ask("n", "今天"), { ...ask("l", "不急"), urgency: "later" }, missed,
    ...Array.from({ length: 5 }, (_, index) => ask(`x${index}`, "更多"))], reminders: [{ id: "r", text: "提醒", href: "/" }] });
  expect(rows.map((row) => row.key)).toEqual(["missed:missed:batch:x", "ask:n", "ask:x0", "ask:x1", "ask:x2", "reminder:r"]);
  expect(rows.filter((row) => row.kind === "ask")).toHaveLength(TODAY_ASKS);
  const first = rows[0]!;
  expect(first.kind === "missed" && first.count).toBe(2);
  // 「逐个处理」 opens yesterday's wrap-up.
  if (first.kind === "missed") expect(openHref(first, "2026-10-08")).toBe("/wrap?day=2026-10-07");
  expect(quickOption(ask("a", "x"))?.id).toBe("ask_first");
  expect(quickOption({ ...ask("a", "x"), select: "many" })).toBeUndefined();
  expect(quickOption({ ...ask("a", "x"), options: [{ id: "o", label: "写", recommended: true, needsNote: true }] })).toBeUndefined();
});

test("asks whose decision can wait stay out of this week's list and are listed apart with the day they come up", () => {
  const later = { ...ask("z", "下个月的事"), urgency: "later" as const, entersOn: "2026-10-20", importance: 80 };
  expect(renderToStaticMarkup(<NeedsCard asks={[ask("a", "第一条"), later]} reminders={[]} labels={{}} today="2026-10-08" />)).not.toContain("下个月的事");
  expect(renderToStaticMarkup(<AskList initial={[ask("a", "第一条"), later]} />)).not.toContain("下个月的事");
  const apart = renderToStaticMarkup(<AskList scope="later" heading="以后再定" initial={[ask("a", "第一条"), later]} />);
  expect(apart).toContain("以后再定 · 1");
  expect(apart).toContain("10-20 起列入本周");
  expect(apart).toContain("里程碑重要性 80");
  expect(apart).not.toContain("第一条");
});
