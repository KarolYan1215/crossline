import { expect, test } from "vitest";
import { placeEdgeLabels } from "./line-network";

const overlap = (a: { x: number; y: number; width: number }, b: { x: number; y: number; width: number }) =>
  Math.abs(a.x - b.x) * 2 < a.width + b.width && Math.abs(a.y - b.y) < 18;

// W-9: 「促成」「反馈回路」「提供输入」 sat on top of each other where three lines fed each other.
test("edge labels never overlap each other or a node; one with no room is left out", () => {
  const nodes = [{ x: 180, y: 58 }, { x: 286, y: 241 }, { x: 74, y: 241 }];
  const curve = (id: string, text: string, a: { x: number; y: number }, b: { x: number; y: number }, bend: number) => {
    const mx = (a.x + b.x) / 2 + bend, my = (a.y + b.y) / 2 + bend;
    return { id, text, start: a, control: { x: mx, y: my }, end: b };
  };
  const edges = [curve("1", "促成", nodes[0]!, nodes[1]!, 10), curve("2", "反馈回路", nodes[1]!, nodes[0]!, -10), curve("3", "提供输入", nodes[0]!, nodes[1]!, 14),
    curve("4", "约束", nodes[2]!, nodes[0]!, 8), curve("5", "复用", nodes[0]!, nodes[2]!, -8)];
  const placed = placeEdgeLabels(edges, nodes);
  const boxes = [...placed.values()];
  expect(boxes.length).toBeGreaterThan(0);
  for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) expect(overlap(a, b)).toBe(false);
  for (const box of boxes) for (const node of nodes) expect(Math.hypot(box.x - node.x, box.y - node.y)).toBeGreaterThan(32);
  // A four-character kind gets a box wide enough for it.
  expect(placed.get("2")?.width ?? 58).toBeGreaterThanOrEqual(4 * 12);
});
