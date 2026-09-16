import { expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { createFlywheelExpander } from "./flywheel";

const skillCalls: Array<Record<string, unknown>> = [];
vi.mock("@crossline/codex", () => ({
  runCodexSkill: async (_client: unknown, _input: unknown, options: Record<string, unknown>) => {
    skillCalls.push(options);
    const prepare = options.prepareInput as (input: unknown) => unknown;
    const validate = options.validateOutput as (output: unknown, prepared: unknown) => unknown;
    const output = validate((globalThis as { __flywheelOutput?: unknown }).__flywheelOutput, prepare(undefined));
    return { ok: true, output, audit: {} };
  }
}));

const seed = () => {
  const store = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "m1", ownerId: "local-owner", workspaceId: "w", identityId: "research",
    projectId: "p", title: "稳定推进实验", version: 1, status: "approved" });
  return store;
};

test("the expansion Skill is the only one granted web search, and findings are stored as evidence", async () => {
  const store = seed();
  try {
    (globalThis as { __flywheelOutput?: unknown }).__flywheelOutput = {
      findings: [{ milestoneId: "m1", summary: "更快的标定方法", sourceUrl: "https://example.org/p",
        sourceTitle: "Faster calibration", retrievedAt: "2026-09-20T03:00:00.000Z",
        staleWhen: "被后续工作证伪", helpsHow: "可用于第二条标准" }],
      blockers: []
    };
    const expand = createFlywheelExpander(store, "w", "C:\repo", () => ({}) as never);
    expect(await expand()).toBe(1);
    expect(skillCalls.at(-1)).toMatchObject({ allowWebSearch: true, skillName: "crossline:crossline-flywheel-scout" });

    const event = store.listEvents("w").at(-1)!;
    expect(event.type).toBe("flywheel.finding");
    expect(event.entityId).toBe("m1");
    expect(event.payload).toMatchObject({ sourceUrl: "https://example.org/p", staleWhen: "被后续工作证伪" });
  } finally { store.close(); }
});

test("a finding that cites no real source is rejected before it can be stored", async () => {
  const store = seed();
  try {
    (globalThis as { __flywheelOutput?: unknown }).__flywheelOutput = {
      findings: [{ milestoneId: "m1", summary: "听说有个方法", sourceUrl: "", sourceTitle: "",
        retrievedAt: "", staleWhen: "", helpsHow: "" }],
      blockers: []
    };
    const expand = createFlywheelExpander(store, "w", "C:\repo", () => ({}) as never);
    await expect(expand()).rejects.toThrow("FLYWHEEL_SOURCE_REQUIRED");
    expect(store.listEvents("w")).toEqual([]);
  } finally { store.close(); }
});

test("with no approved milestones there is nothing to expand, and nothing is spent", async () => {
  const store = new CrosslineStore(":memory:");
  try {
    const before = skillCalls.length;
    expect(await createFlywheelExpander(store, "w", "C:\repo", () => ({}) as never)()).toBe(0);
    expect(skillCalls.length).toBe(before);
  } finally { store.close(); }
});

test("without a runtime the expansion refuses rather than reporting an empty result", async () => {
  const store = seed();
  try {
    await expect(createFlywheelExpander(store, "w", "C:\repo", () => undefined)())
      .rejects.toThrow("CODEX_SUPERVISOR_UNAVAILABLE");
  } finally { store.close(); }
});

const seedPair = () => {
  const store = seed();
  store.saveMilestone({ id: "m2", ownerId: "local-owner", workspaceId: "w", identityId: "media",
    projectId: "p", title: "建立内容闭环", version: 1, status: "approved" });
  return store;
};
const proposal = {
  fromMilestoneId: "m1", toMilestoneId: "m2", kind: "reuses",
  explanation: "实验记录可以直接当作选题素材。", refutedWhen: "选题改为需要一手影像时不成立。",
  sourceUrl: "https://example.org/guide", sourceTitle: "Guide", retrievedAt: "2026-09-16"
};

test("proposed relations land as candidates carrying their claim, falsifier and source", async () => {
  const store = seedPair();
  try {
    (globalThis as { __flywheelOutput?: unknown }).__flywheelOutput = { findings: [], relations: [proposal], blockers: [] };
    expect(await createFlywheelExpander(store, "w", "C:\repo", () => ({}) as never)()).toBe(1);
    const stored = store.listMilestoneRelations("w");
    expect(stored).toHaveLength(1);
    // A candidate, never an approved one: the nightly job proposes, the weekly review decides.
    expect(stored[0]).toMatchObject({
      status: "candidate", kind: "reuses",
      explanation: "实验记录可以直接当作选题素材。",
      refutedWhen: "选题改为需要一手影像时不成立。",
      evidence: [{ uri: "https://example.org/guide", source: "Guide", observedAt: "2026-09-16" }]
    });
  } finally { store.close(); }
});

test("re-proposing the same relation updates one row instead of filling the pool with copies", async () => {
  const store = seedPair();
  try {
    (globalThis as { __flywheelOutput?: unknown }).__flywheelOutput = { findings: [], relations: [proposal], blockers: [] };
    const expand = createFlywheelExpander(store, "w", "C:\repo", () => ({}) as never);
    await expand();
    await expand();
    expect(store.listMilestoneRelations("w")).toHaveLength(1);
  } finally { store.close(); }
});

test("a nightly re-proposal never un-approves a decision or resurrects a refuted relation", async () => {
  const store = seedPair();
  try {
    const id = "flywheel:m1->m2:reuses";
    store.saveMilestoneRelation({ id, ownerId: "local-owner", workspaceId: "w",
      fromMilestoneId: "m1", toMilestoneId: "m2", kind: "reuses", status: "approved",
      evidence: [{ uri: "https://example.org/old", source: "Old", observedAt: "2026-09-01" }] });
    (globalThis as { __flywheelOutput?: unknown }).__flywheelOutput = { findings: [], relations: [proposal], blockers: [] };
    expect(await createFlywheelExpander(store, "w", "C:\repo", () => ({}) as never)()).toBe(0);
    // Silently downgrading it to `candidate` would quietly undo the user's approval every night.
    expect(store.listMilestoneRelations("w")[0]).toMatchObject({ status: "approved" });
    expect(store.listEvents("w").some((event) => event.type === "flywheel.relation_proposed")).toBe(false);
  } finally { store.close(); }
});

test("counterexamples recorded against a relation survive a re-proposal", async () => {
  const store = seedPair();
  try {
    const id = "flywheel:m1->m2:reuses";
    store.saveMilestoneRelation({ id, ownerId: "local-owner", workspaceId: "w",
      fromMilestoneId: "m1", toMilestoneId: "m2", kind: "reuses", status: "candidate",
      evidence: [{ uri: "https://example.org/old", source: "Old", observedAt: "2026-09-01" }],
      counterexample: [{ note: "上次复用失败", observedAt: "2026-09-10" }] });
    (globalThis as { __flywheelOutput?: unknown }).__flywheelOutput = { findings: [], relations: [proposal], blockers: [] };
    await createFlywheelExpander(store, "w", "C:\repo", () => ({}) as never)();
    // Counterexamples belong to the gate and the user; a fresh proposal must not wipe the record that
    // this relation has already failed once — that record is what sinks it in the ranking.
    expect(store.listMilestoneRelations("w")[0]?.counterexample).toEqual([{ note: "上次复用失败", observedAt: "2026-09-10" }]);
  } finally { store.close(); }
});
