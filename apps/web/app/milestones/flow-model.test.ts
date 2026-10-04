import { expect, test } from "vitest";
import { NODE, assignStages, layoutFlow, type FlowMilestone } from "./flow-model";

const m = (id: string, identityId: string, stage?: number, over: Partial<FlowMilestone> = {}): FlowMilestone =>
  ({ id, identityId, title: id, status: "approved", ...(stage ? { stage } : {}), ...over });

test("columns are stages in order, rows are lines in the given order", () => {
  const layout = layoutFlow([m("b2", "startup", 2), m("a1", "research", 1), m("a2", "research", 2), m("b1", "startup", 1)], [], ["research", "startup"]);
  expect(layout.stages).toEqual([1, 2]);
  expect(layout.rows.map((row) => row.identityId)).toEqual(["research", "startup"]);
  const at = (id: string) => layout.nodes.find((node) => node.id === id)!;
  expect(at("a1").x).toBeLessThan(at("a2").x);
  expect(at("a1").y).toBeLessThan(at("b1").y);
  expect(at("a1").x).toBe(at("b1").x);
});

test("two milestones in the same line and stage stack vertically and make the row taller", () => {
  const layout = layoutFlow([m("a", "research", 1), m("b", "research", 1), m("c", "startup", 1)], [], ["research", "startup"]);
  const at = (id: string) => layout.nodes.find((node) => node.id === id)!;
  expect(at("b").y - at("a").y).toBe(NODE.h + NODE.gapY);
  expect(layout.rows[0]!.height).toBeGreaterThan(layout.rows[1]!.height);
  expect(at("c").y).toBeGreaterThanOrEqual(layout.rows[1]!.y);
});

test("a milestone with no stage takes the next free one in its line; archived ones are not drawn", () => {
  expect(assignStages([m("x", "research"), m("y", "research"), m("z", "media")]).map((node) => node.stage)).toEqual([1, 2, 1]);
  const layout = layoutFlow([m("a", "research", 1), m("gone", "research", 2, { status: "archived" })], [], ["research"]);
  expect(layout.nodes.map((node) => node.id)).toEqual(["a"]);
  expect(layout.stages).toEqual([1]);
});

test("a chain link runs right edge to left edge; a cross-line relation is its own dashed kind with a label", () => {
  const layout = layoutFlow(
    [m("a1", "research", 1), m("a2", "research", 2, { dependsOn: ["a1"] }), m("s2", "startup", 2)],
    [{ id: "r", source: "a2", target: "s2", kind: "informs", status: "candidate" }, { id: "gone", source: "a1", target: "ghost", kind: "enables", status: "approved" }],
    ["research", "startup"]);
  const chain = layout.edges.find((edge) => edge.kind === "chain")!;
  expect(chain.from).toBe("a1");
  expect(chain.path.startsWith(`M${NODE.labelW + NODE.w},`)).toBe(true);
  const relation = layout.edges.find((edge) => edge.kind === "relation")!;
  expect(relation).toMatchObject({ label: "启发", pending: true });
  // A relation to a milestone that is not drawn is dropped rather than drawn to nowhere.
  expect(layout.edges.filter((edge) => edge.kind === "relation")).toHaveLength(1);
});

test("a link that runs backwards is routed round the nodes instead of through them", () => {
  const layout = layoutFlow([m("a1", "research", 1), m("a2", "research", 2)], [{ id: "back", source: "a2", target: "a1", kind: "recurring_feedback", status: "approved" }], ["research"]);
  const back = layout.edges.find((edge) => edge.kind === "relation")!;
  expect(back.path).toContain("V");
  expect(back.path).toContain("H");
});
