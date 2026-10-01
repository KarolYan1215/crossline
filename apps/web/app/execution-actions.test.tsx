import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ExecutionActions } from "./execution-actions";

const base = { workOrderId: "w1", intent: "写材料", state: "active", paused: false, ownerId: "o", workspaceId: "w" };

describe("execution actions — evidence checklist (工作块 E)", () => {
  test("renders a pre-generated checklist question when the order carries one", () => {
    const html = renderToStaticMarkup(<ExecutionActions {...base} evidenceChecklist={[
      { id: "q1", prompt: "初稿是否存在？", kind: "checkbox", options: ["是", "否"], required: true }
    ]} />);
    expect(html).toContain("初稿是否存在？");
    expect(html).toContain("是");
    expect(html).toContain("否");
  });

  test("renders a text-kind question as a free-text input, not checkbox options", () => {
    const html = renderToStaticMarkup(<ExecutionActions {...base} evidenceChecklist={[
      { id: "q1", prompt: "具体情况是什么？", kind: "text", required: true }
    ]} />);
    expect(html).toContain("具体情况是什么？");
    expect(html).toContain("输入具体情况");
  });

  test("no checklist section appears when the order has none — free-text/file evidence still does", () => {
    const html = renderToStaticMarkup(<ExecutionActions {...base} />);
    expect(html).not.toContain("evidence-checklist");
    expect(html).toContain("证据位置");
  });

  test("the file upload control is present on an active order", () => {
    const html = renderToStaticMarkup(<ExecutionActions {...base} />);
    expect(html).toContain("由 AI 审阅");
  });
});
