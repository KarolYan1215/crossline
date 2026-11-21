import { expect, test } from "vitest";
import { carryOverSteps, remapFrozenSteps } from "./step-carry";

test("a replaced step goes to the new step of the same or a containing title, else to the first person's step; kept ids are left alone", () => {
  const old = [{ id: "v1s1", title: "读题并列出已知量" }, { id: "v1s2", title: "解第 1–4 题" }, { id: "v1s3", title: "上传到 Gradescope" }, { id: "kept", title: "已做完" }];
  const next = [{ id: "kept", title: "已做完", executor: "human" }, { id: "v2s2", title: "整理题面约束", executor: "agent" },
    { id: "v2s3", title: "完成作业 4（解第 1–4 题并提交）", executor: "human" }];
  expect([...carryOverSteps(old, next)]).toEqual([["v1s1", "kept"], ["v1s2", "v2s3"], ["v1s3", "kept"]]);
  // With no person's step left, the first step of the plan takes them.
  expect([...carryOverSteps([{ id: "a", title: "x" }], [{ id: "b", title: "y", executor: "agent" }])]).toEqual([["a", "b"]]);
});

test("frozen blocks of the task follow their step to its new id, two landing on one step stay distinct, other tasks' blocks are untouched", () => {
  const block = (blockId: string) => ({ blockId, start: "2026-11-21T15:00:00Z", end: "2026-11-21T16:00:00Z", reason: "locked" as const });
  const list = [block("scheduled:wo:v1s1"), block("scheduled:wo:v1s2:2"), block("scheduled:other:v1s1"), block("scheduled:wo")];
  const moved = remapFrozenSteps(list, "wo", new Map([["v1s1", "v2s1"], ["v1s2", "v2s1"]]));
  expect(moved.map((item) => item.blockId)).toEqual(["scheduled:wo:v2s1", "scheduled:wo:v2s1:2", "scheduled:other:v1s1", "scheduled:wo"]);
  expect(moved[0]).toMatchObject({ reason: "locked", start: "2026-11-21T15:00:00Z" });
});
