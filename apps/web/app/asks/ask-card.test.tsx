import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { Ask } from "@crossline/core";
import { AskCard } from "./ask-card";
import { AskBoard } from "./ask-board";

const base: Ask = { id: "iq:goals", kind: "interview_question", entityId: "q", title: "研究主线的长期目标是哪些？", why: "访谈在「主线」阶段的问题。",
  urgency: "later", raisedAt: "", fingerprint: "f", line: "research", options: [
    { id: "a", label: "发表一篇会议论文", recommended: true }, { id: "b", label: "完成博士资格考试" }, { id: "c", label: "建立开源工具" }] };
const card = (ask: Ask, preview?: Parameters<typeof AskCard>[0]["preview"]) => renderToStaticMarkup(<AskCard ask={ask} preview={preview} onDone={() => undefined} />);

test("every card says what is asked, why, what an answer does and what silence does", () => {
  const html = card(base);
  expect(html).toContain("研究主线的长期目标是哪些？");
  expect(html).toMatch(/<dt>为何问<\/dt><dd>.*访谈在「主线」阶段的问题。/);
  expect(html).toContain("<dt>答后</dt><dd>本轮问题答完后一并交给访谈，进入下一轮。</dd>");
  expect(html).toContain("<dt>不答</dt><dd>访谈停在本轮，下一轮不会开始。</dd>");
  expect(html).toContain('href="/onboarding"');
});

test("a single-choice ask answers on one click; a multiple-choice ask is ticked and confirmed once", () => {
  const one = card(base);
  expect(one).toContain('role="group" aria-label="选一项"');
  expect(one).not.toContain('type="checkbox"');
  expect(one).not.toContain("确定");
  const many = card({ ...base, select: "many" });
  expect(many.match(/type="checkbox"/g)).toHaveLength(3);
  expect(many).toContain("可多选");
  expect(many).toMatch(/<button type="button" class="primary-button" disabled="">确定<\/button>/);
});

test("an ask that takes the person's own words has the input in place, its placeholder the recommended answer", () => {
  const html = card({ ...base, freeText: { placeholder: "例如：今年投出一篇 ISCA 论文" } });
  expect(html).toContain('<textarea rows="1" maxLength="4000" placeholder="例如：今年投出一篇 ISCA 论文" data-user-text="true"');
  expect(html).not.toContain("<dialog");
  expect(card(base)).not.toContain("<textarea");
});

test("an option with required follow-up fields opens them in the card, not in a dialog, and links stay links", () => {
  const html = card({ ...base, kind: "waiting_due", options: [{ id: "deferred", label: "还没，推迟", fields: [{ id: "date", label: "推迟到", kind: "date", required: true }] },
    { id: "look", label: "去看看", href: "/workbench/x" }] });
  expect(html).toContain('aria-pressed="false"><b>还没，推迟</b>');
  expect(html).toContain('<a class="ask-option ak-link" href="/workbench/x"><b>去看看 →</b>');
});

test("an ask about a thing previews it in place, folded until asked, with the link to open it", () => {
  const html = card({ ...base, kind: "interview_question", title: "「当前画像」写的是否符合本人？", preview: { kind: "portrait", href: "/portrait", label: "当前画像" } },
    { kind: "portrait", image: "/api/portrait/image/character?v=1", code: "GEMA", name: "改装师", tagline: "边做边改", keywords: ["跨界"] });
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("预览：当前画像");
  expect(html).toContain('href="/portrait"');
  expect(html).toMatch(/class="ak-preview" inert="" aria-hidden="true"/);
  expect(html).toContain("<b>GEMA</b> 改装师");
  expect(html).toContain('src="/api/portrait/image/character?v=1"');
  // Without the summary (Today does not load one), the card keeps the link only.
  const bare = card({ ...base, preview: { kind: "milestones", href: "/milestones", label: "研究主线的里程碑草稿" } });
  expect(bare).toContain("打开：研究主线的里程碑草稿");
  expect(bare).not.toContain("ak-preview\"");
});

test("a stopped assistant run shows what it finished, where it stopped, and what only the person can decide", () => {
  const html = card({ ...base, kind: "agent_blocked", title: "助手没做成「整理课程材料」", options: [{ id: "self", label: "本人处理", recommended: true }],
    freeText: { placeholder: "补充助手缺的信息" },
    progress: { summary: "正在汇编 ECE 548 讲义目录。", done: ["读取讲义清单", "建立目录骨架"], stuckAt: "课程网站需要登录", needs: ["是否用本人浏览器登录 Canvas"], external: true, retries: 2 } });
  expect(html).toContain('aria-label="已完成 2 步，停在第 3 步"');
  expect(html.match(/data-state="done"/g)).toHaveLength(4);
  expect(html).toContain("已完成 2 步 · 停在第 3 步 · 已自动重试 2 次");
  expect(html).toContain("课程网站需要登录");
  expect(html).toContain("需本人决定或提供");
  expect(html).toContain("涉及外部");
  expect(html).toContain('placeholder="补充助手缺的信息"');
});

test("待确认 lays the week's asks out in four quadrants, each a drawer with its top ask open", () => {
  const asks: Ask[] = [
    { ...base, id: "1", title: "紧急重要一", urgency: "now", important: true }, { ...base, id: "2", title: "紧急重要二", urgency: "now", important: true },
    { ...base, id: "3", title: "重要不紧急一", importance: 70 }, { ...base, id: "4", title: "以后的", entersOn: "2026-10-30" }];
  const html = renderToStaticMarkup(<AskBoard initial={asks} previews={{}} />);
  expect(html).toContain("待决事项 · 3");
  for (const label of ["紧急重要", "重要不紧急", "紧急不重要", "不重要不紧急"]) expect(html).toContain(`aria-label="${label}"`);
  expect(html).toContain('<h4 class="ak-title">紧急重要一</h4>');
  expect(html).toContain('data-depth="1" data-line="research">紧急重要二');
  expect(html).toContain('aria-label="紧急重要 2，重要不紧急 1，紧急不重要 0，不重要不紧急 0"');
  expect(html).toContain('href="#q-urgent_important"');
  expect(html).not.toContain("以后的");
  expect(html.match(/data-empty="true"/g)).toHaveLength(2);
  expect(renderToStaticMarkup(<AskBoard initial={[]} previews={{}} />)).toContain("本周暂无待决事项。");
});
