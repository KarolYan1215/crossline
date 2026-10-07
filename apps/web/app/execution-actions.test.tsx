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

describe("execution actions — showEnergyProbe (工作块 F)", () => {
  test("renders the before-task energy probe by default on an approved order", () => {
    const html = renderToStaticMarkup(<ExecutionActions {...base} state="approved" />);
    expect(html).toContain("开始前精力");
    expect(html).toContain("记录中精力");
  });

  test("showEnergyProbe=false suppresses the probe without hiding the start button — the homepage has its own energy section", () => {
    const html = renderToStaticMarkup(<ExecutionActions {...base} state="approved" showEnergyProbe={false} />);
    expect(html).not.toContain("开始前精力");
    expect(html).not.toContain("记录中精力");
    expect(html).toContain("开始执行");
  });

  test("showEnergyProbe=false also suppresses the after-task probe on an evidence_review order", () => {
    const html = renderToStaticMarkup(<ExecutionActions {...base} state="evidence_review" showEnergyProbe={false} />);
    expect(html).not.toContain("完成后精力与实际负荷");
  });
});

// 「实际花了多久」 in one tap: the choices come from the estimate, and the screen record's suggestion is offered first.
test("an active order offers one-tap durations from its estimate, with the screen record's suggestion when there is one", () => {
  const html = renderToStaticMarkup(<ExecutionActions workOrderId="w1" intent="写一段分析" state="active" paused={false}
    ownerId="o" workspaceId="w" estimateP50={60} suggestedMinutes={47} />);
  expect(html).toContain("实际花了多久");
  expect(html).toContain("屏幕记录约 47 分");
  expect(html).toContain("≈估时 60 分");
  expect(html).toContain("两倍 120 分");
});
