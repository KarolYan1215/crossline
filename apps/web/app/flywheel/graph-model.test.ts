import { describe, expect, test } from "vitest";
import {
  anchorId, buildGraph, classifyEdge, createSimulation, edgeGeometry, fitTransform, graphLoops, hashOf, layoutGraph, loopCentre, milestoneRadius, neighbours,
  ringSlots, type FlywheelGraphData
} from "./graph-model";

const lines = [
  { id: "research", label: "研究者", goal: "成为神经形态计算方向能独立立项的研究者", openTasks: 5 },
  { id: "media", label: "创作者", goal: "成为把硬核研究讲清楚的创作者", openTasks: 2 },
  { id: "startup", label: "创业者", goal: "", openTasks: 0 }
];
const milestone = (id: string, line: string, over: Partial<FlywheelGraphData["milestones"][number]> = {}) =>
  ({ id, line, title: `里程碑 ${id}`, status: "approved" as const, openTasks: 2, dependsOn: [], ...over });
const data: FlywheelGraphData = {
  lines,
  milestones: [
    milestone("r1", "research"), milestone("r2", "research", { dependsOn: ["r1"] }), milestone("r3", "research", { dependsOn: ["r1", "r2"], status: "draft", openTasks: 9 }),
    milestone("m1", "media"), milestone("m2", "media", { dependsOn: ["m1"] }),
    milestone("h1", "health")
  ],
  relations: [
    { id: "x1", from: "r2", to: "m1", kind: "reuses", status: "approved", explanation: "论文图表复用为视频素材", lagDays: 3 },
    { id: "x2", from: "m2", to: "r3", kind: "recurring_feedback", status: "approved", explanation: "观众提问回流成研究问题", lagDays: 10 },
    { id: "x3", from: "r1", to: "m2", kind: "informs", status: "candidate", explanation: "文献综述给选题判断" },
    { id: "gone", from: "r1", to: "deleted", kind: "informs", status: "approved", explanation: "" }
  ]
};

describe("building the graph", () => {
  test("one anchor per line labelled with its long-term goal (the line's name when there is none); health and unknown ends are left out", () => {
    const graph = buildGraph(data);
    const anchors = graph.nodes.filter((node) => node.kind === "anchor");
    expect(anchors.map((node) => [node.id, node.label])).toEqual([
      ["line:research", "成为神经形态计算方向能独立立项的研究者"], ["line:media", "成为把硬核研究讲清楚的创作者"], ["line:startup", "创业者"]]);
    expect(graph.nodes.some((node) => node.id === "h1")).toBe(false);
    expect(graph.edges.some((edge) => edge.relationId === "gone")).toBe(false);
  });

  test("a dot grows with its unfinished tasks, within bounds", () => {
    expect(milestoneRadius(0)).toBe(6);
    expect(milestoneRadius(9)).toBe(15);
    expect(milestoneRadius(400)).toBe(20);
    expect(buildGraph(data).nodes.find((node) => node.id === "r3")?.radius).toBe(15);
  });

  test("edges are classed by their ends: member to the anchor, chain within a line, cross between lines; approved solid, candidate dashed", () => {
    expect(classifyEdge({ kind: "anchor", line: "a" }, { kind: "milestone", line: "a" })).toBe("member");
    expect(classifyEdge({ kind: "milestone", line: "a" }, { kind: "milestone", line: "a" })).toBe("chain");
    expect(classifyEdge({ kind: "milestone", line: "a" }, { kind: "milestone", line: "b" })).toBe("cross");
    const graph = buildGraph(data);
    const byId = new Map(graph.edges.map((edge) => [edge.id, edge]));
    expect(byId.get("relation:x1")).toMatchObject({ kind: "cross", line: "research", status: "approved", relationKind: "reuses" });
    expect(byId.get("relation:x3")).toMatchObject({ kind: "cross", status: "candidate" });
    expect(byId.get("chain:r1>r2")).toMatchObject({ kind: "chain", status: "approved" });
    // r3 depends on r1 and r2, and r2 already depends on r1: the implied r1 → r3 is not drawn. r3 is a draft, so its step is dashed.
    expect(byId.has("chain:r1>r3")).toBe(false);
    expect(byId.get("chain:r2>r3")).toMatchObject({ status: "candidate" });
    expect(byId.get("member:r1")).toMatchObject({ from: anchorId("research"), kind: "member" });
  });
});

describe("loops", () => {
  test("a loop closed by approved relations gets R1 and its summed lag; a candidate never closes one", () => {
    const loops = graphLoops(buildGraph(data));
    expect(loops).toEqual([{ id: "loop:media>research", label: "R1", lines: ["media", "research"], edgeIds: ["relation:x2", "relation:x1"], lagDays: 13 }]);
    const candidateOnly = graphLoops(buildGraph({ ...data, relations: data.relations.map((relation) => relation.id === "x2" ? { ...relation, status: "candidate" as const } : relation) }));
    expect(candidateOnly).toEqual([]);
  });

  test("the lag is left out when a hop does not state one, and a constraint never closes a loop", () => {
    const noLag = graphLoops(buildGraph({ ...data, relations: data.relations.map((relation) => relation.id === "x1" ? { id: "x1", from: "r2", to: "m1", kind: "reuses", status: "approved" as const, explanation: "" } : relation) }));
    expect(noLag[0]?.lagDays).toBeUndefined();
    const constraint = graphLoops(buildGraph({ ...data, relations: data.relations.map((relation) => relation.id === "x2" ? { ...relation, kind: "constrains" } : relation) }));
    expect(constraint).toEqual([]);
  });

  test("its R sits at the centre of the milestones its relations join", () => {
    const graph = buildGraph(data);
    const [loop] = graphLoops(graph);
    const at = (id: string) => ({ r2: { x: 0, y: 0 }, m1: { x: 10, y: 0 }, m2: { x: 10, y: 10 }, r3: { x: 0, y: 10 } } as Record<string, { x: number; y: number }>)[id];
    expect(loopCentre(loop!, graph, at)).toEqual({ x: 5, y: 5 });
  });
});

describe("layout", () => {
  test("the same ledger lays out the same shape on every load", () => {
    const first = layoutGraph(buildGraph(data)), second = layoutGraph(buildGraph(data));
    expect([...first]).toEqual([...second]);
    expect([...first.values()].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });

  test("anchors start on a ring in line order, and keep that order once settled", () => {
    const slots = ringSlots(["research", "media", "startup"]);
    expect(slots.get("research")!.y).toBeLessThan(0);
    const layout = layoutGraph(buildGraph(data));
    const angle = (line: string) => { const p = layout.get(anchorId(line))!; return (Math.atan2(p.y, p.x) + Math.PI * 2.5) % (Math.PI * 2); };
    expect(angle("research")).toBeLessThan(angle("media"));
    expect(angle("media")).toBeLessThan(angle("startup"));
  });

  test("a milestone settles nearer its own line's anchor than any other", () => {
    const layout = layoutGraph(buildGraph(data));
    const distance = (a: string, b: string) => Math.hypot(layout.get(a)!.x - layout.get(b)!.x, layout.get(a)!.y - layout.get(b)!.y);
    for (const id of ["r1", "r2", "m1", "m2"]) {
      const own = id.startsWith("r") ? "research" : "media";
      for (const other of lines.map((line) => line.id).filter((line) => line !== own)) expect(distance(id, anchorId(own))).toBeLessThan(distance(id, anchorId(other)));
    }
  });

  test("a dragged node stays where it was dropped while the rest relax around it", () => {
    const graph = buildGraph(data);
    const simulation = createSimulation(graph, layoutGraph(graph));
    simulation.positions.set("m1", { x: 300, y: 200 });
    simulation.fixed.add("m1");
    simulation.settle(80, 0.3);
    expect(simulation.positions.get("m1")).toEqual({ x: 300, y: 200 });
  });

  test("ids seed the layout, not the clock", () => {
    expect(hashOf("r1")).toBe(hashOf("r1"));
    expect(hashOf("r1")).not.toBe(hashOf("r2"));
  });
});

describe("drawing helpers", () => {
  test("the layout is fitted into the drawing and never blown up past 1.6×", () => {
    expect(fitTransform([{ x: -100, y: -50 }, { x: 100, y: 50 }], 400, 300, 0)).toEqual({ scale: 1.6, x: 200, y: 150 });
    const fit = fitTransform([{ x: -300, y: -100 }, { x: 300, y: 100 }], 343, 320, 24);
    expect(fit.scale).toBeCloseTo((343 - 48) / 600, 5);
  });

  test("an edge stops at the target's circle so the arrowhead shows, and bends when asked", () => {
    const straight = edgeGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 10);
    expect(straight.path).toBe("M0.0,0.0 L87.0,0.0");
    expect(edgeGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 20).path).toMatch(/^M0\.0,0\.0 Q50\.0,20\.0 /);
  });

  test("hovering a node lights it and everything one edge away", () => {
    const graph = buildGraph(data);
    expect([...neighbours(graph, "m1")].sort()).toEqual(["line:media", "m1", "m2", "r2"].sort());
  });
});
