import { describe, expect, it } from "vitest";
import { TL, layoutTimeline, type TimelineNodeInput } from "./timeline-model";

const node = (id: string, line: string, day?: string, dependsOn: string[] = []): TimelineNodeInput =>
  ({ id, line, title: id, status: "approved", kind: "milestone", day, dependsOn });

describe("milestone timeline", () => {
  it("places milestones by date, so ones due on different days are not stacked in one column", () => {
    const layout = layoutTimeline({ nodes: [node("a", "research", "2026-10-10"), node("b", "research", "2026-10-27"), node("c", "media", "2026-10-10")],
      ticks: [], relations: [], lineOrder: ["research", "media"], today: "2026-10-08" });
    const x = (id: string) => layout.nodes.find((item) => item.id === id)!.x;
    expect(x("b") - x("a")).toBeCloseTo(17 * layout.pxPerDay, 5);
    expect(x("a")).toBeCloseTo(x("c"), 5);
    expect(layout.todayX).toBeLessThan(x("a"));
  });

  it("labels the first of a month and drops a Monday label that would print on top of it", () => {
    const layout = layoutTimeline({ nodes: [node("a", "research", "2026-11-20")], ticks: [], relations: [], lineOrder: ["research"], today: "2026-10-28" });
    const labels = layout.axis.map((mark) => mark.label);
    expect(labels).toContain("11月");
    expect(labels).not.toContain("11/2");
    expect(labels).toContain("11/9");
  });

  it("drops a label into the next lane only when it would overlap, and grows the row to fit", () => {
    const layout = layoutTimeline({ nodes: [node("a", "research", "2026-10-10"), node("b", "research", "2026-10-11"), node("c", "research", "2026-12-20")],
      ticks: [], relations: [], lineOrder: ["research"], today: "2026-10-08" });
    const label = (id: string) => layout.nodes.find((item) => item.id === id)!.labelY;
    expect(label("b")).toBeGreaterThan(label("a"));
    expect(label("c")).toBe(label("a"));
    expect(layout.rows[0]!.height).toBeGreaterThanOrEqual(TL.axisTop + 2 * TL.laneH);
  });

  it("puts undated milestones after the last date, keeps chains on the axis and draws relations between rows", () => {
    const layout = layoutTimeline({ nodes: [node("a", "research", "2026-10-10"), node("b", "research", "2026-10-20", ["a"]), node("u", "media"), node("m", "media", "2026-10-15")],
      ticks: [{ id: "t", milestoneId: "b", line: "research", day: "2026-10-12", state: "done", plannedDay: "2026-10-12" },
        { id: "p", milestoneId: "b", line: "research", day: "2026-10-14", state: "postponed", plannedDay: "2026-10-09" }],
      relations: [{ id: "r", from: "b", to: "m", pending: true }], lineOrder: ["research", "media"], today: "2026-10-08" });
    expect(layout.nodes.find((item) => item.id === "u")).toMatchObject({ undated: true });
    expect(layout.nodes.find((item) => item.id === "u")!.x).toBeGreaterThan(layout.datedEnd);
    const chain = layout.edges.find((edge) => edge.kind === "chain")!;
    expect(chain.path).toMatch(/^M[\d.]+,[\d.]+ H[\d.]+$/);
    expect(layout.edges.find((edge) => edge.kind === "relation")).toMatchObject({ pending: true });
    const postponed = layout.ticks.find((tick) => tick.id === "p")!;
    expect(postponed.plannedX).not.toBeNull();
    expect(postponed.plannedX!).toBeLessThan(postponed.x);
  });
});
