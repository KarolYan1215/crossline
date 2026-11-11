import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { CardView } from "./conversation";

const plain = { actions: [], items: [], clarify: { question: "", options: [] }, confidence: "high", heard: "这周最紧的截止是哪一个？" };

test("a plain answer has no card: nothing to carry out, ask or report draws nothing", () => {
  expect(renderToStaticMarkup(<CardView messageId="m" card={plain as never} onUpdate={() => undefined} choices={null} />)).toBe("");
});

test("a carried-out action says 「已执行」 once, not 「已执行 已完成」; a handler's own message still shows (W-148)", () => {
  const card = (message: string) => ({ ...plain, actions: [{ action: "energy.report", summary: "记录当前精力偏低", args: {} }],
    items: [{ state: "done", message }] });
  const generic = renderToStaticMarkup(<CardView messageId="m" card={card("已完成") as never} onUpdate={() => undefined} choices={null} />);
  expect(generic).toContain("已执行");
  expect(generic).not.toContain("已完成");
  const own = renderToStaticMarkup(<CardView messageId="m" card={card("10/29 周四 16:00–17:00 · 重排了 2 个冲突的任务块") as never} onUpdate={() => undefined} choices={null} />);
  expect(own).toContain("重排了 2 个冲突的任务块");
});

test("an answer that asks back still has its card", () => {
  const html = renderToStaticMarkup(<CardView messageId="m" card={{ ...plain, clarify: { question: "是哪门课？", options: [{ label: "ECE 548", actions: [] }] } } as never}
    onUpdate={() => undefined} choices={null} />);
  expect(html).toContain("conversation-card");
  expect(html).toContain("是哪门课？");
});

test("one-shot cards vanish once done or answered; a failure, an unanswered question, a card still checked or a 去设置 link stays", async () => {
  const { vanishes } = await import("./conversation");
  const action = (name: string) => ({ action: name, summary: "", args: {} });
  const card = (items: Array<{ state: string }>, extra: Record<string, unknown> = {}) =>
    ({ ...plain, actions: items.map(() => action("task.op")), items, ...extra }) as never;
  expect(vanishes(card([{ state: "done" }, { state: "dismissed" }]))).toBe(true);
  expect(vanishes(card([{ state: "done" }, { state: "pending" }]))).toBe(false);
  expect(vanishes(card([{ state: "failed" }]))).toBe(false);
  expect(vanishes(card([{ state: "done" }], { reviewing: true }))).toBe(false);
  expect(vanishes(card([{ state: "done" }], { error: "X" }))).toBe(false);
  expect(vanishes(plain as never)).toBe(false);
  // A nudge's question: stays until answered, then goes.
  const question = { question: "今天的计划可以吗？", options: [{ label: "好", actions: [], kind: "ack" }] };
  expect(vanishes({ ...plain, clarify: question } as never)).toBe(false);
  expect(vanishes({ ...plain, clarify: { ...question, chosen: 0 } } as never)).toBe(true);
  expect(vanishes({ ...plain, actions: [action("settings.open")], items: [{ state: "done", href: "/settings#model" }] } as never)).toBe(false);
});

test("the receipt says 已执行 with 撤销 when there is an operation to take back", async () => {
  const { Receipt } = await import("../ui/vanish");
  const html = renderToStaticMarkup(<Receipt opIds={["op-1"]} onGone={() => undefined} />);
  expect(html).toContain("已执行");
  expect(html).toContain("撤销");
  expect(renderToStaticMarkup(<Receipt opIds={[]} text="已处理" onGone={() => undefined} />)).not.toContain("撤销");
});
