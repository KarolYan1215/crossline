import { expect, test } from "vitest";
import { validateAssistantTurnProposal, type AssistantTurnContext } from "./assistant-schema";

const context: AssistantTurnContext = {
  version: "crossline.assistant.v1",
  history: [],
  message: "帮我写个统计单词频率的小脚本",
  attachments: [],
  workOrderId: "wo-1",
  identities: ["research", "startup"],
  snapshot: "现在：2026-10-06"
};

const output = (overrides: Partial<{
  reply: string; quickReplies: string[];
  materialDraft: { relativePath: string; content: string; mediaType: string; sourceRefs: string[] } | null;
  templateProposal: { identityId: string; kind: string; titleHint: string; successCriteriaDefaults: unknown[] } | null;
  blockers: Array<{ code: string; message: string }>;
}> = {}) => ({
  reply: "写好了，已经存成一个脚本，你可以直接跑。",
  quickReplies: [],
  materialDraft: null,
  templateProposal: null,
  blockers: [],
  ...overrides
});

test("a plain reply with no draft passes through", () => {
  const result = validateAssistantTurnProposal(output({ reply: "你好，有什么可以帮你？" }), context);
  expect(result.reply).toBe("你好，有什么可以帮你？");
  expect(result.materialDraft).toBeNull();
});

test("a well-formed material draft passes through when the turn is scoped to a work order", () => {
  const result = validateAssistantTurnProposal(output({
    materialDraft: { relativePath: "word-count.py", content: "print('hi')", mediaType: "text/plain", sourceRefs: [] }
  }), context);
  expect(result.materialDraft).toMatchObject({ relativePath: "word-count.py" });
});

test("a material draft is refused when the conversation has no work order to attach it to", () => {
  expect(() => validateAssistantTurnProposal(output({
    materialDraft: { relativePath: "x.md", content: "y", mediaType: "text/markdown", sourceRefs: [] }
  }), { ...context, workOrderId: null })).toThrow("ASSISTANT_MATERIAL_REQUIRES_WORK_ORDER");
});

test("a draft path that escapes the materials folder is refused", () => {
  expect(() => validateAssistantTurnProposal(output({
    materialDraft: { relativePath: "../../etc/passwd", content: "x", mediaType: "text/plain", sourceRefs: [] }
  }), context)).toThrow("ASSISTANT_MATERIAL_PATH_OUTSIDE_ROOT");
});

test("a draft path repeating the app-owned prefix is refused", () => {
  expect(() => validateAssistantTurnProposal(output({
    materialDraft: { relativePath: ".crossline-materials/wo-1/x.md", content: "x", mediaType: "text/markdown", sourceRefs: [] }
  }), context)).toThrow("ASSISTANT_MATERIAL_PATH_REPEATS_ROOT");
});

test("a non-text media type is refused", () => {
  expect(() => validateAssistantTurnProposal(output({
    materialDraft: { relativePath: "x.png", content: "binary-ish", mediaType: "image/png", sourceRefs: [] }
  }), context)).toThrow("ASSISTANT_MATERIAL_MEDIA_TYPE_UNSUPPORTED");
});

test("a blocker stops the turn and carries its own message as detail", () => {
  try {
    validateAssistantTurnProposal(output({ blockers: [{ code: "UNSAFE_REQUEST", message: "这个我不能帮忙。" }] }), context);
    throw new Error("expected a throw");
  } catch (error) {
    expect((error as Error).message).toBe("ASSISTANT_BLOCKED");
    expect((error as Error & { detail?: string }).detail).toBe("这个我不能帮忙。");
  }
});

test("malformed shape is refused before any business check runs", () => {
  expect(() => validateAssistantTurnProposal({ reply: 123, quickReplies: [], materialDraft: null, blockers: [] }, context))
    .toThrow("ASSISTANT_SCHEMA_INVALID");
});

const templateCriterion = { id: "c1", statement: "产出物存在", required: true, evidenceOf: "output",
  measure: { kind: "artifact", mustExist: "x" } };

test("a well-formed template proposal on a known identity passes through", () => {
  const result = validateAssistantTurnProposal(output({
    templateProposal: { identityId: "research", kind: "deliverable", titleHint: "新模板", successCriteriaDefaults: [templateCriterion] }
  }), context);
  expect(result.templateProposal).toMatchObject({ identityId: "research", titleHint: "新模板" });
});

test("a template proposal naming an identity the person does not have is refused", () => {
  expect(() => validateAssistantTurnProposal(output({
    templateProposal: { identityId: "woodwork", kind: "deliverable", titleHint: "新模板", successCriteriaDefaults: [templateCriterion] }
  }), context)).toThrow("ASSISTANT_TEMPLATE_IDENTITY_UNKNOWN");
});

test("a template proposal whose criteria fail the usual success-criteria rules is refused", () => {
  expect(() => validateAssistantTurnProposal(output({
    templateProposal: { identityId: "research", kind: "deliverable", titleHint: "新模板", successCriteriaDefaults: [] }
  }), context)).toThrow("MILESTONE_NEEDS_CRITERIA");
});

test("a capture card is passed through; a malformed one is refused so the turn is repaired", () => {
  const base = { reply: "可以先记下来", quickReplies: [], materialDraft: null, templateProposal: null, blockers: [] };
  expect(validateAssistantTurnProposal({ ...base, proposals: [{ kind: "capture", title: "10/8 拿到数据后跑仿真", context: "" }] }, context).proposals)
    .toEqual([{ kind: "capture", title: "10/8 拿到数据后跑仿真", context: "" }]);
  expect(() => validateAssistantTurnProposal({ ...base, proposals: [{ kind: "capture", title: "", context: "" }] }, context))
    .toThrow("ASSISTANT_PROPOSAL_INVALID");
  // An answer recorded before cards existed still reads.
  expect(validateAssistantTurnProposal(base, context).proposals).toEqual([]);
});
