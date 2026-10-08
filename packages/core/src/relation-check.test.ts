import { describe, expect, it } from "vitest";
import { relationWarnings, validateRelationsProposal, type RelationsContext } from "./milestone-gate-schema";

const context: RelationsContext = { version: "crossline.milestone-relations.v1", facts: [{ id: "research/p/goal", identityId: "research", projectId: "p", slot: "goal", value: "x", status: "confirmed" }],
  milestones: [
    { id: "r1", identityId: "research", projectId: "p", title: "图表脚本", stage: 1, deadline: "2026-12-20", target: "" },
    { id: "m1", identityId: "media", projectId: "", title: "首期发布", stage: 1, deadline: "2026-11-01", target: "" }
  ] };
const relation = (over: object = {}) => ({ fromId: "r1", toId: "m1", kind: "reuses", explanation: "研究线的图表脚本用于第 1 期配图",
  refutedWhen: "配图未使用该脚本", sourceFactIds: ["research/p/goal"], ...over });

describe("cross-line relation check", () => {
  it("keeps a weak relation and flags it rather than refusing the answer", () => {
    const checked = validateRelationsProposal({ relations: [relation({ explanation: "互相促进", refutedWhen: "", sourceFactIds: ["nope"] })], assumptions: [], blockers: [] }, context);
    expect(checked.relations).toHaveLength(1);
    expect(checked.relations[0]!.sourceFactIds).toEqual([]);
    expect(checked.warnings[0]!.warnings.map((item) => item.code)).toEqual(["RELATION_EXPLANATION_THIN", "RELATION_REFUTATION_THIN", "RELATION_SOURCE_MISSING", "RELATION_LATE_OUTPUT"]);
  });

  it("drops only what cannot be stored, and sends the answer back only when nothing is left", () => {
    const checked = validateRelationsProposal({ relations: [relation(), relation({ toId: "nowhere" }), relation()], assumptions: [], blockers: [] }, context);
    expect(checked.relations).toHaveLength(1);
    expect(checked.dropped).toHaveLength(2);
    expect(() => validateRelationsProposal({ relations: [relation({ toId: "nowhere" })], assumptions: [], blockers: [] }, context)).toThrow("RELATION_NONE_USABLE");
    expect(validateRelationsProposal({ relations: [], assumptions: [], blockers: [] }, context).relations).toEqual([]);
  });

  it("does not flag timing for a constraint, and flags a link inside one line", () => {
    expect(relationWarnings({ kind: "constrains", explanation: "占用同一周的晚间时段两次以上", refutedWhen: "两者没有排在同一周" },
      { identityId: "research", deadline: "2026-12-20" }, { identityId: "media", deadline: "2026-11-01" })).toEqual([]);
    expect(relationWarnings(relation(), { identityId: "media" }, { identityId: "media" }).map((item) => item.code)).toEqual(["RELATION_SAME_LINE"]);
  });
});
