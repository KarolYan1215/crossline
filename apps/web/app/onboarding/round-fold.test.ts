import { expect, test } from "vitest";
import { foldThread, roundSummary } from "./round-fold";
import type { Message } from "./onboarding-types";

const user = (seq: number, text: string): Message => ({ seq, role: "user", content: { text }, createdAt: "" });
const turn = (seq: number, reply: string, insight = false): Message => ({ seq, role: "assistant", createdAt: "",
  content: { reply, questions: [], nextAction: "ask", coverage: [], ...(insight ? { insight: { text: "两件事连在一起", refs: [] } } : {}) } });

test("a round's line is the reply's first sentence, cut to a line", () => {
  expect(roundSummary("先说说你的研究。具体做什么？")).toBe("先说说你的研究。");
  expect(roundSummary("  Hello there! Next.  ")).toBe("Hello there!");
  expect([...roundSummary("长".repeat(60))]).toHaveLength(40);
  expect(roundSummary("长".repeat(60)).endsWith("…")).toBe(true);
});

test("every round before the latest folds with the answers that followed it; the latest and a reply on its way stay open", () => {
  const messages = [user(1, "【我的主线】研究者"), turn(2, "第一轮的问题。还有别的"), user(3, "答一"), turn(4, "第二轮。"), user(5, "答二"), turn(6, "第三轮。"), user(7, "正在发送")];
  const items = foldThread(messages, () => false);
  expect(items.map((item) => item.kind === "fold" ? `fold ${item.round} ${item.summary} [${item.messages.map((m) => m.seq).join(",")}]` : `msg ${item.message.seq}`))
    .toEqual(["fold 0 【我的主线】研究者 [1]", "fold 1 第一轮的问题。 [2,3]", "fold 2 第二轮。 [4,5]", "msg 6", "msg 7"]);
});

test("nothing folds before there is a second round", () => {
  expect(foldThread([user(1, "开场"), turn(2, "第一轮。")], () => false).map((item) => item.kind)).toEqual(["fold", "message"]);
  expect(foldThread([turn(1, "第一轮。"), user(2, "答")], () => false).map((item) => item.kind)).toEqual(["message", "message"]);
  expect(foldThread([], () => false)).toEqual([]);
});

test("an observation on a past round stays out of the fold until it is rated", () => {
  const messages = [turn(1, "第一轮。", true), user(2, "答"), turn(3, "第二轮。")];
  const open = foldThread(messages, () => false)[0]!;
  expect(open.kind === "fold" && open.unratedInsight?.seq).toBe(1);
  const rated = foldThread(messages, (seq) => seq === 1)[0]!;
  expect(rated.kind === "fold" && rated.unratedInsight).toBeUndefined();
});
