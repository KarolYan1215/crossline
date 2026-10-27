import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
vi.mock("next/navigation", async (original) => ({ ...await original<typeof import("next/navigation")>(), useRouter: () => ({ refresh: () => {} }) }));
import { FocusStrip } from "./milestone-timeline";
import { layoutTimeline } from "./timeline-model";
import type { BoardMilestone, BoardTick, MilestoneBoard } from "../../lib/milestone-board";

const tick: BoardTick = { id: "wo-1#v1s2", workOrderId: "wo-1", taskTitle: "ECE 548 期中复习", outcome: "做完 2023 年期中真题并对答案", day: "2026-10-24",
  state: "postponed", plannedDay: "2026-10-12", stepTitle: "限时做一套真题", scheduledDay: "2026-10-24" };
const milestone = (id: string, title: string, deadline: string, extra: Partial<BoardMilestone> = {}) => ({ id, identityId: "research", projectId: "ece548",
  title, status: "approved", deadline, daysLeft: 6, dependsOn: [], risks: [], ticks: [], relations: [], ...extra }) as unknown as BoardMilestone;
const board = {
  today: "2026-10-21", labels: { research: "研究者" }, lineOrder: ["research"], courses: [], stats: { ticksDone: 0, ticksPlanned: 0, reuse: 0 },
  milestones: [milestone("mid1", "ECE 548 期中考试 1 达到 85 分", "2026-10-15"),
    milestone("mid2", "ECE 548 期中考试 2 达到 85 分", "2026-10-27", { dependsOn: ["mid1"], ticks: [tick], risks: [{ level: "medium", kind: "time", note: "" }] })]
} as unknown as MilestoneBoard;
const layout = layoutTimeline({ nodes: board.milestones.map((item) => ({ id: item.id, line: item.identityId, title: item.title, status: item.status, kind: "milestone" as const,
  day: item.deadline, dependsOn: item.dependsOn })), ticks: [{ id: tick.id, milestoneId: "mid2", line: "research", day: tick.day, state: tick.state, plannedDay: tick.plannedDay }],
  relations: [], lineOrder: ["research"], today: board.today });
const strip = (props: { milestoneId?: string; ticks?: string[]; pinned?: boolean }) => renderToStaticMarkup(<FocusStrip layout={layout} board={board}
  milestoneId={props.milestoneId ?? null} ticks={props.ticks ?? null} pinned={props.pinned ?? false} onClose={() => {}} onOpen={() => {}} />);

test("the milestone in focus is named in full, with its deadline, state, risk and the milestones it is joined to", () => {
  const html = strip({ milestoneId: "mid2" });
  expect(html).toContain("ECE 548 期中考试 2 达到 85 分");
  expect(html).toContain("截止 10/27，还有 6 天");
  expect(html).toContain("已批准");
  expect(html).toContain("中风险");
  expect(html).toContain("前置 「ECE 548 期中考试 1 达到 85 分」");
  expect(html).toContain("刻度 0/1");
});

test("a picked postponed tick explains itself at once: what it is, when it was due and is now, why, its step, task and milestone", () => {
  const html = strip({ ticks: [tick.id], pinned: true });
  expect(html).toContain("已顺延刻度");
  expect(html).toContain("做完 2023 年期中真题并对答案");
  expect(html).toContain("原定 10/12 → 现排 10/24");
  expect(html).toContain("原定 10/12 已过，这一步还没完成");
  expect(html).toContain("限时做一套真题");
  expect(html).toContain("ECE 548 期中复习");
  expect(html).toContain('href="/workbench/wo-1"');
  expect(html).toContain("关闭刻度说明");
  // Hovered, not picked: no close button.
  expect(strip({ ticks: [tick.id] })).not.toContain("关闭刻度说明");
});

test("with nothing in focus the strip says how to use it", () => {
  expect(strip({})).toContain("指向或点选里程碑、刻度");
});
