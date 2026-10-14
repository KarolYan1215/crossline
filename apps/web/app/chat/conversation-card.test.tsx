import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { CardView } from "./conversation";

const plain = { actions: [], items: [], clarify: { question: "", options: [] }, confidence: "high", heard: "这周最紧的截止是哪一个？" };

test("a plain answer has no card: nothing to carry out, ask or report draws nothing", () => {
  expect(renderToStaticMarkup(<CardView messageId="m" card={plain as never} onUpdate={() => undefined} choices={null} />)).toBe("");
});

test("an answer that asks back still has its card", () => {
  const html = renderToStaticMarkup(<CardView messageId="m" card={{ ...plain, clarify: { question: "是哪门课？", options: [{ label: "ECE 548", actions: [] }] } } as never}
    onUpdate={() => undefined} choices={null} />);
  expect(html).toContain("conversation-card");
  expect(html).toContain("是哪门课？");
});
