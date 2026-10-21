import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { FlywheelGraph } from "./flywheel-graph";
import type { FlywheelGraphData } from "./graph-model";

const data: FlywheelGraphData = {
  lines: [
    { id: "research", label: "研究者", goal: "成为神经形态计算方向能独立立项的研究者", openTasks: 17 },
    { id: "media", label: "创作者", goal: "成为把硬核研究讲清楚的创作者", openTasks: 3 }
  ],
  milestones: [
    { id: "r1", line: "research", title: "完成仿真对照实验", status: "approved", openTasks: 4, dependsOn: [] },
    { id: "r2", line: "research", title: "论文投稿", status: "draft", openTasks: 1, dependsOn: ["r1"] },
    { id: "m1", line: "media", title: "发布第一期讲解视频", status: "approved", openTasks: 2, dependsOn: [] }
  ],
  relations: [
    { id: "x1", from: "r1", to: "m1", kind: "reuses", status: "approved", explanation: "实验图表复用为视频素材" },
    { id: "x2", from: "m1", to: "r2", kind: "recurring_feedback", status: "approved", explanation: "观众提问回流成研究问题" },
    { id: "x3", from: "r2", to: "m1", kind: "informs", status: "candidate", explanation: "投稿结论给选题判断" }
  ]
};

describe("the flywheel graph", () => {
  const html = renderToStaticMarkup(<FlywheelGraph data={data} />);

  test("a dot per milestone and an anchor per line labelled with its long-term goal, sized by the drawing's own width", () => {
    expect(html.match(/class="fw-node" data-kind="milestone"/g)).toHaveLength(3);
    expect(html.match(/class="fw-node" data-kind="anchor"/g)).toHaveLength(2);
    // The goal takes two lines, broken after 「的」, instead of one cut at sixteen characters (2026-10-21); an anchor can be focused to
    // read it whole.
    expect(html).toContain('<tspan x="0" dy="0">成为神经形态计算方向能独立立项的</tspan><tspan x="0" dy="16">研究者</tspan>');
    expect(html).toContain('aria-label="研究者的长期目标：成为神经形态计算方向能独立立项的研究者"');
    expect(html).toContain('viewBox="0 0 720 446"');
    expect(html).toContain('aria-label="飞轮图谱：3 个里程碑，3 条飞轮关系"');
  });

  test("cross-line relations are arrowed in the source line's colour, candidates dashed and open to a decision", () => {
    expect(html).toMatch(/data-kind="cross" data-status="approved" data-line="research"[^>]*marker-end="url\(#fw-/);
    expect(html).toContain('data-kind="cross" data-status="candidate" data-line="research"');
    expect(html).toContain("投稿结论给选题判断");
    expect(html).toContain("待确认");
    expect(html).toContain('data-kind="chain" data-status="candidate"');
  });

  test("the loop closed by approved relations is marked R1; drafts are hollow; milestones open the 主线 page", () => {
    expect(html).toContain(">R1</text>");
    expect(html).toContain("飞轮回路：创作者 → 研究者 → 创作者");
    expect(html).toContain('data-status="draft"');
    expect(html).toContain('role="link"');
    expect(html).toContain("研究者 · 完成仿真对照实验，4 项未完成，打开主线页");
  });

  test("the legend keeps each line's tasks in progress and says health is not drawn", () => {
    expect(html).toContain("研究者</b></a> · <span class=\"mono\">17</span> 项进行中");
    expect(html).toContain("健康是容量约束，不画在图中");
  });

  test("with no live milestone it says what will appear, and still lists the lines", () => {
    const empty = renderToStaticMarkup(<FlywheelGraph data={{ ...data, milestones: [], relations: [] }} />);
    expect(empty).toContain("尚无进行中的里程碑");
    expect(empty).not.toContain("<svg");
    expect(empty).toContain("创作者");
  });
});
