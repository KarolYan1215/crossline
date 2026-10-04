import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { SuccessCriterion } from "@crossline/core";
import { TargetsPanel } from "./targets-panel";

const threshold = (value: number, bareLine?: number): SuccessCriterion => ({
  id: "c1", statement: "期末考试不低于 87 分", required: true, evidenceOf: "outcome",
  measure: { kind: "threshold", unit: "分", comparator: "gte", value, ...(bareLine === undefined ? {} : { bareLine }) }
});
const milestone = (value: number) => ({ id: "m1", identityId: "research", projectId: "ece555", title: "ECE 555 期末", status: "draft" as const, successCriteria: [threshold(value, 84)] });
const course = { projectId: "ece555", identityId: "research", name: "ECE 555", value: "总评 A−（≥ 90）", why: "读博方向，稳妥即可", proposed: true };

test("a proposed target shows its reason, can be accepted as it is, and can be changed to another from the list", () => {
  const html = renderToStaticMarkup(<TargetsPanel courses={[course]} milestones={[]} />);
  expect(html).toContain("总评 A−（≥ 90）");
  expect(html).toContain("理由：读博方向，稳妥即可");
  expect(html).toContain("就按这个");
  expect(html).toContain("总评 B+（≥ 87）");
  expect(html).toContain("改并重算本线草稿");
});

test("a target the person set is not offered for acceptance again", () => {
  const html = renderToStaticMarkup(<TargetsPanel courses={[{ ...course, proposed: false, why: "" }]} milestones={[]} />);
  expect(html).not.toContain("就按这个");
  expect(html).toContain("你定的");
});

test("every score line can be edited in place and shows the lowest line that still reaches the outcome", () => {
  const html = renderToStaticMarkup(<TargetsPanel courses={[]} milestones={[milestone(87)]} />);
  expect(html).toContain("刚好够到结果的最低线是 84");
  expect(html).not.toContain("没有留余量");
});

test("nothing to show renders nothing", () => {
  expect(renderToStaticMarkup(<TargetsPanel courses={[]} milestones={[]} />)).toBe("");
});
