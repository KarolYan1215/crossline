import { describe, expect, it } from "vitest";
import { TICK_HIT, TL, boxesOverlap, connectionsOf, edgeLabelSize, focusLabels, labelObstacles, labelWidth, layoutTimeline, markerBox, nodeLabelBox, placeEdgeLabels,
  riskGlyphsShown, tickStory, tickTargets, type TimelineNodeInput, type TimelineTickInput } from "./timeline-model";

const node = (id: string, line: string, day?: string, dependsOn: string[] = []): TimelineNodeInput =>
  ({ id, line, title: id, status: "approved", kind: "milestone", day, dependsOn });

describe("milestone timeline", () => {
  it("spreads ticks that fall on one day of one row, so each can be clicked", () => {
    const tick = (id: string) => ({ id, milestoneId: "a", line: "research", day: "2026-10-18", state: "planned" as const, plannedDay: null });
    const layout = layoutTimeline({ nodes: [node("a", "research", "2026-11-20")], ticks: [tick("t1"), tick("t2"), tick("t3")], relations: [],
      lineOrder: ["research"], today: "2026-10-18" });
    const xs = layout.ticks.map((item) => item.x).sort((a, b) => a - b);
    expect(xs[1]! - xs[0]!).toBeGreaterThanOrEqual(12);
    expect(xs[2]! - xs[1]!).toBeGreaterThanOrEqual(12);
  });

  it("draws a cross-line edge in the upstream line's colour, dashed while a candidate, and marks one whose time order no longer holds", () => {
    const layout = layoutTimeline({ nodes: [node("up", "research", "2026-10-31"), node("down", "media", "2026-11-01")], ticks: [],
      relations: [{ id: "artifact:x:up->down", from: "up", to: "down", pending: true, label: "复用", broken: true },
        { id: "ok", from: "down", to: "up", pending: false, label: "反馈回路" }], lineOrder: ["research", "media"], today: "2026-10-20" });
    const edge = (id: string) => layout.edges.find((item) => item.id === `relation:${id}`)!;
    expect(edge("artifact:x:up->down")).toMatchObject({ kind: "relation", line: "research", pending: true, broken: true, label: "复用" });
    expect(edge("ok").broken).toBeUndefined();
  });

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

  it("puts undated milestones after the last date, arcs each chain step from earlier to later and draws relations between rows", () => {
    const layout = layoutTimeline({ nodes: [node("a", "research", "2026-10-10"), node("b", "research", "2026-10-20", ["a"]), node("u", "media"), node("m", "media", "2026-10-15")],
      ticks: [{ id: "t", milestoneId: "b", line: "research", day: "2026-10-12", state: "done", plannedDay: "2026-10-12" },
        { id: "p", milestoneId: "b", line: "research", day: "2026-10-14", state: "postponed", plannedDay: "2026-10-09" }],
      relations: [{ id: "r", from: "b", to: "m", pending: true, label: "提供输入" }], lineOrder: ["research", "media"], today: "2026-10-08" });
    expect(layout.nodes.find((item) => item.id === "u")).toMatchObject({ undated: true });
    expect(layout.nodes.find((item) => item.id === "u")!.x).toBeGreaterThan(layout.datedEnd);
    const chain = layout.edges.find((edge) => edge.kind === "chain")!;
    expect(chain).toMatchObject({ from: "a", to: "b", line: "research" });
    // An arc above the axis, starting after the earlier marker and ending before the later one (where the arrow sits).
    const [, x0, y0, , cy, x1] = chain.path.match(/^M([\d.]+),([\d.]+) Q([\d.]+),([\d.]+) ([\d.]+),/)!.map(Number);
    const a = layout.nodes.find((item) => item.id === "a")!, b = layout.nodes.find((item) => item.id === "b")!;
    expect(x0).toBeGreaterThan(a.x); expect(x1).toBeLessThan(b.x); expect(cy).toBeLessThan(y0!); expect(y0! - (y0! - cy!) / 2).toBeGreaterThan(layout.rows[0]!.y);
    expect(layout.edges.find((edge) => edge.kind === "relation")).toMatchObject({ pending: true, from: "b", to: "m", line: "research", label: "提供输入" });
    const postponed = layout.ticks.find((tick) => tick.id === "p")!;
    expect(postponed.plannedX).not.toBeNull();
    expect(postponed.plannedX!).toBeLessThan(postponed.x);
  });

  it("draws a chain step only when no other path in the line implies it, and raises arcs that pass over more markers", () => {
    const layout = layoutTimeline({ nodes: [node("a", "research", "2026-10-10"), node("b", "research", "2026-10-20", ["a"]),
      node("c", "research", "2026-10-30", ["a", "b"]), node("d", "research", "2026-11-09", ["a"])],
      ticks: [], relations: [], lineOrder: ["research"], today: "2026-10-08" });
    expect(layout.edges.map((edge) => edge.id).sort()).toEqual(["chain:a>b", "chain:a>d", "chain:b>c"]);
    const peak = (id: string) => Number(layout.edges.find((edge) => edge.id === id)!.path.match(/Q[\d.]+,(-?[\d.]+)/)![1]);
    expect(peak("chain:a>d")).toBeLessThan(peak("chain:a>b"));
  });
  it("fits the whole span into the width it is given and marks every new year with a separator", () => {
    const layout = layoutTimeline({ nodes: [node("a", "research", "2026-11-20"), node("b", "media", "2027-08-01")], ticks: [], relations: [],
      lineOrder: ["research", "media"], today: "2026-10-15", width: 1100 });
    const b = layout.nodes.find((item) => item.id === "b")!;
    expect(layout.width).toBe(1100);
    expect(b.x).toBeLessThanOrEqual(1100 - TL.labelMin);
    expect(layout.years.map((year) => [year.label, year.boundary])).toEqual([["2026", false], ["2027", true]]);
    const jan = layout.years.find((year) => year.boundary)!;
    expect(layout.axis.find((mark) => mark.label === "1月")!.x).toBeCloseTo(jan.x, 5);
    // Ten months in about a thousand pixels: month marks, no weeks.
    expect(layout.axis.every((mark) => mark.kind === "month")).toBe(true);
    // A phone keeps a readable minimum and scrolls inside its frame.
    expect(layoutTimeline({ nodes: [node("a", "research", "2026-11-20")], ticks: [], relations: [], lineOrder: ["research"], today: "2026-10-15", width: 340 }).width)
      .toBe(TL.minWidth);
  });

  it("cuts a label short to make room for the next, and leaves one out rather than letting labels overlap", () => {
    const long = (id: string, day: string): TimelineNodeInput => ({ ...node(id, "research", day), title: "投出第一篇期刊论文并收到编辑部的回复" });
    const layout = layoutTimeline({ nodes: [long("a", "2026-10-20"), long("b", "2026-10-21"), long("c", "2026-10-22"), long("d", "2026-10-23")],
      ticks: [], relations: [], lineOrder: ["research"], today: "2026-10-15", width: 1100 });
    const shown = layout.nodes.filter((item) => item.labelW > 0);
    for (const one of shown) for (const two of shown) {
      if (one === two || one.labelY !== two.labelY) continue;
      expect(one.labelX + one.labelW <= two.labelX || two.labelX + two.labelW <= one.labelX).toBe(true);
    }
    expect(shown.every((item) => item.labelW >= TL.labelMin && item.labelW <= TL.labelMax)).toBe(true);
    expect(layout.rows[0]!.height).toBe(TL.axisTop + 8 + TL.maxLanes * TL.laneH + TL.rowPad);
  });

  it("places relation labels clear of markers, milestone labels, ticks and each other, and leaves out one that finds no room", () => {
    // Three lines, milestones close together, and relations crossing from each to the others: the crowded case the real board showed.
    const nodes = [node("r1", "research", "2026-10-12"), node("r2", "research", "2026-10-14", ["r1"]), node("r3", "research", "2026-10-16", ["r2"]),
      node("s1", "startup", "2026-10-13"), node("s2", "startup", "2026-11-30"), node("m1", "media", "2026-10-15"), node("m2", "media", "2026-11-28")];
    const relations = [["r1", "s1"], ["r2", "m1"], ["r3", "s2"], ["s1", "m1"], ["s2", "m2"], ["m1", "r3"], ["r2", "s2"]]
      .map(([from, to], index) => ({ id: `x${index}`, from: from!, to: to!, pending: index % 2 === 0, label: index % 3 ? "复用" : "提供输入", kind: "reuses" }));
    const layout = layoutTimeline({ nodes, ticks: [{ id: "t", milestoneId: "r2", line: "research", day: "2026-10-13", state: "planned", plannedDay: null }],
      relations, lineOrder: ["research", "startup", "media"], today: "2026-10-10", width: 1100 });
    const obstacles = labelObstacles(layout, riskGlyphsShown(layout, new Set(["r1", "r2"])));
    const requests = layout.edges.filter((edge) => edge.kind === "relation").map((edge) => ({ id: edge.id, ...edgeLabelSize(edge.label!, edge.id.endsWith("x2")) }));
    const placed = [...placeEdgeLabels(layout, requests, obstacles).values()];
    const shown = placed.filter((box): box is NonNullable<typeof box> => Boolean(box));
    expect(shown.length).toBeGreaterThan(0);
    for (const box of shown) {
      expect(obstacles.some((other) => boxesOverlap(box, other))).toBe(false);
      expect(shown.filter((other) => other !== box).some((other) => boxesOverlap(box, other))).toBe(false);
      expect(box.y).toBeGreaterThanOrEqual(TL.headH);
      expect(box.x + box.w).toBeLessThanOrEqual(layout.width);
    }
    // A relation keeps its kind for the dash pattern, and its curve.
    expect(layout.edges.find((edge) => edge.id === "relation:x0")).toMatchObject({ relationKind: "reuses" });
    expect(layout.edges.find((edge) => edge.id === "relation:x0")!.curve).toHaveLength(8);
    // With nowhere to go (every spot covered), a label is left out rather than drawn over something.
    const everywhere = [{ x: 0, y: 0, w: layout.width, h: layout.height }];
    expect(placeEdgeLabels(layout, requests.slice(0, 1), everywhere).get(requests[0]!.id)).toBeNull();
  });

  it("leaves out a risk glyph that would run into the next marker, and keeps one with room", () => {
    const layout = layoutTimeline({ nodes: [node("a", "research", "2026-10-12"), node("b", "research", "2026-10-13"), node("c", "research", "2026-12-20")],
      ticks: [], relations: [], lineOrder: ["research"], today: "2026-10-10", width: 1100 });
    const x = (id: string) => layout.nodes.find((item) => item.id === id)!.x;
    // One day apart is far closer than a glyph is wide.
    expect(x("b") - x("a")).toBeLessThan(30);
    expect([...riskGlyphsShown(layout, new Set(["a", "b", "c"]))].sort()).toEqual(["b", "c"]);
  });

  it("draws the chain steps of a crowded row faint, and leaves a sparse row's at full strength", () => {
    const chain = (line: string, count: number) => Array.from({ length: count }, (_, index) =>
      node(`${line}${index}`, line, `2026-10-${String(12 + index * 2).padStart(2, "0")}`, index ? [`${line}${index - 1}`] : []));
    const layout = layoutTimeline({ nodes: [...chain("research", TL.chainMax + 2), ...chain("media", 3)], ticks: [], relations: [],
      lineOrder: ["research", "media"], today: "2026-10-10", width: 1100 });
    const chains = (line: string) => layout.edges.filter((edge) => edge.kind === "chain" && edge.line === line);
    expect(chains("research").length).toBeGreaterThan(TL.chainMax);
    expect(chains("research").every((edge) => edge.faint)).toBe(true);
    expect(chains("media").some((edge) => edge.faint)).toBe(false);
  });
});

describe("what is in focus on the timeline", () => {
  const tick = (id: string, milestoneId: string, day: string, state: TimelineTickInput["state"] = "planned", plannedDay: string | null = day): TimelineTickInput =>
    ({ id, milestoneId, line: "research", day, state, plannedDay });
  // The real account's research row: a deadline with a dozen ticks packed before it, one postponed with its ghost among the others.
  const dense = () => layoutTimeline({ nodes: [node("ece", "research", "2026-11-20"), node("next", "research", "2027-01-15", ["ece"])],
    ticks: [...Array.from({ length: 12 }, (_, index) => tick(`t${index}`, "ece", `2026-11-${String(5 + index).padStart(2, "0")}`)),
      tick("late", "ece", "2026-11-16", "postponed", "2026-11-08")], relations: [], lineOrder: ["research"], today: "2026-10-21", width: 700 });

  it("gives every dot and the postponed tick's ghost its own target, none overlapping, clear of markers and the labels below the axis", () => {
    const layout = dense();
    const targets = tickTargets(layout);
    // Every tick is reachable, and the postponed one twice: at its dot and at its original day.
    expect(new Set(targets.flatMap((target) => target.ticks))).toEqual(new Set(layout.ticks.map((item) => item.id)));
    expect(targets.filter((target) => target.ticks.includes("late")).length).toBe(2);
    expect(targets.find((target) => target.ticks.includes("late") && target.ghostOnly)).toBeDefined();
    for (const [index, target] of targets.entries()) {
      expect(target.w).toBeGreaterThan(0);
      for (const other of targets.slice(index + 1)) if (!target.over && !other.over) expect(boxesOverlap(target, other)).toBe(false);
      for (const milestone of layout.nodes) if (!target.over) expect(boxesOverlap(target, markerBox(milestone))).toBe(false);
      for (const milestone of layout.nodes) { const label = nodeLabelBox(milestone); if (label) expect(boxesOverlap(target, label)).toBe(false); }
    }
    expect(targets[0]!.h).toBe(TICK_HIT.up + TICK_HIT.down);
  });

  it("lets a lone tick reach past its 12px dot", () => {
    const layout = layoutTimeline({ nodes: [node("m", "research", "2026-12-20")], ticks: [tick("one", "m", "2026-11-10")], relations: [], lineOrder: ["research"], today: "2026-10-21" });
    const [target] = tickTargets(layout);
    expect(target!.w).toBe(2 * TICK_HIT.reach);
    expect(target!.points).toEqual([{ id: "one", x: layout.ticks[0]!.x, ghost: false }]);
  });

  it("writes the full name of the milestone in focus over a label that was cut short, and of the ones joined to it, without overlaps", () => {
    const long = (id: string, day: string, dependsOn: string[] = []) => ({ ...node(id, "research", day, dependsOn), title: `ECE 548 期中考试 2 复习与模拟题 ${id}` });
    const layout = layoutTimeline({ nodes: [long("a", "2026-11-01"), long("b", "2026-11-04", ["a"]), long("c", "2026-11-07", ["b"]), node("m", "media", "2026-11-05")],
      ticks: [], relations: [{ id: "r", from: "b", to: "m", pending: false, label: "促成" }], lineOrder: ["research", "media"], today: "2026-10-21", width: 700 });
    const b = layout.nodes.find((item) => item.id === "b")!;
    expect(b.labelW).toBeLessThan(labelWidth(b.title));
    const full = focusLabels(layout, ["b", "a", "c", "m"]);
    // The one in focus keeps its own spot, at its full width.
    expect(full.get("b")).toMatchObject({ x: b.labelX, y: b.labelY, w: labelWidth(b.title) });
    const boxes = [...full.values()];
    boxes.forEach((box, index) => boxes.slice(index + 1).forEach((other) => expect(boxesOverlap(box, other)).toBe(false)));
    // No full name covers another milestone in focus.
    for (const [id, box] of full) for (const other of layout.nodes) if (other.id !== id && ["a", "b", "c", "m"].includes(other.id)) expect(boxesOverlap(box, markerBox(other))).toBe(false);
    for (const box of boxes) { expect(box.x).toBeGreaterThanOrEqual(TL.labelW); expect(box.x + box.w).toBeLessThanOrEqual(layout.width); }
  });

  it("never draws a full name over what is under the pointer", () => {
    const layout = dense();
    const under = tickTargets(layout).filter((target) => target.ticks.includes("t3"));
    const full = focusLabels(layout, ["ece"], under);
    for (const box of full.values()) for (const target of under) expect(boxesOverlap(box, target, 1)).toBe(false);
  });

  it("lists what a milestone is joined to: the chain before and after, and its relations with their kind", () => {
    const layout = layoutTimeline({ nodes: [node("a", "research", "2026-11-01"), node("b", "research", "2026-11-10", ["a"]), node("c", "research", "2026-11-20", ["b"]),
      node("m", "media", "2026-11-12")], ticks: [], relations: [{ id: "r", from: "b", to: "m", pending: true, label: "复用" }],
      lineOrder: ["research", "media"], today: "2026-10-21" });
    expect(connectionsOf(layout, "b")).toEqual({ before: ["a"], after: ["c"], relations: [{ other: "m", direction: "out", label: "复用", pending: true }] });
    expect(connectionsOf(layout, "m").relations).toEqual([{ other: "b", direction: "in", label: "复用", pending: true }]);
  });

  it("says why a postponed tick moved: the day it was due, the day it is on now, or that it has no new time yet", () => {
    expect(tickStory({ state: "postponed", day: "2026-10-24", plannedDay: "2026-10-12", scheduledDay: "2026-10-24" }))
      .toEqual({ status: "已顺延", when: "原定 10/12 → 现排 10/24", why: "原定 10/12 已过，这一步还没完成，排程把它挪到了 10/24 的时间块。" });
    expect(tickStory({ state: "postponed", day: "2026-10-21", plannedDay: "2026-10-12", scheduledDay: null }).when).toBe("原定 10/12 → 尚未重排");
    expect(tickStory({ state: "done", day: "2026-10-03", plannedDay: "2026-10-05", scheduledDay: null })).toEqual({ status: "已达成", when: "完成于 10/3" });
    expect(tickStory({ state: "planned", day: null, plannedDay: null, scheduledDay: null }).when).toBe("还没有排上日程");
  });
});
