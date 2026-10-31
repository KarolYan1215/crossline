import { expect, test } from "vitest";
import { ONBOARDING_DIALOGUE_SCHEMA, ONBOARDING_EXTRACT_SCHEMA, onboardingDialogueSchema, onboardingExtractSchema, droppedOnboardingItems, keepOnboardingTurn, validateOnboardingTurn, type OnboardingTurn } from "./onboarding-turn-schema";

const known = {
  identities: ["research", "startup", "media", "investment"],
  projectIds: ["westlake"],
  replies: { "reply-1": "西湖那篇 10/31 前要投出，数据预计 10 月 8 日左右拿到。" },
  sources: { "src-1": "Week-8: 27th Oct.\nL15: Mid-term-1\nL16: BJT-3" }
};

const turn = (overrides: Partial<OnboardingTurn> = {}): OnboardingTurn => ({
  reply: "收到。我先确认几件事。",
  questions: [{ id: "q1", text: "项目 A 的图表清单在哪？", kind: "single", allowOther: true, identityId: "research", projectId: "westlake",
    options: [{ id: "a", label: "在师兄给的文档里", detail: "" }, { id: "b", label: "只在聊天记录里", detail: "" }] }],
  slotUpdates: [], projectsDetected: [], flywheelCandidates: [], coverage: [], nextAction: "ask", ...overrides
});

const update = (over: object) => ({ identityId: "research", projectId: "westlake", slot: "deadline", value: "10/31",
  status: "confirmed" as const, sourceRef: "reply-1", sourceQuote: "10/31 前要投出", ...over });

const expectRejected = (value: unknown, code: string) => {
  try { validateOnboardingTurn(value, known); } catch (error) {
    expect((error as Error).message).toBe(code);
    expect((error as Error & { detail?: string }).detail).toBeTruthy();
    return;
  }
  throw new Error(`expected ${code}`);
};

test("a turn with several well-formed questions and a grounded fact passes", () => {
  const ok = validateOnboardingTurn(turn({ slotUpdates: [update({})] }), known);
  expect(ok.slotUpdates).toHaveLength(1);
});

test("the schema is strict: every object lists all its properties and forbids extras", () => {
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const object = node as { type?: string; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean; items?: unknown; anyOf?: unknown[] };
    if (object.type === "object") {
      expect(object.additionalProperties).toBe(false);
      expect([...(object.required ?? [])].sort()).toEqual(Object.keys(object.properties ?? {}).sort());
      Object.values(object.properties ?? {}).forEach(walk);
    }
    walk(object.items);
    object.anyOf?.forEach(walk);
  };
  for (const schema of [ONBOARDING_DIALOGUE_SCHEMA, ONBOARDING_EXTRACT_SCHEMA, onboardingDialogueSchema({ lines: ["research"], projects: ["p1"] }),
    onboardingExtractSchema({ lines: ["research"] })]) walk(schema);
});

test("each layer has its own fields, and a turn's lines and projects are enums the model picks from", () => {
  expect(Object.keys(ONBOARDING_DIALOGUE_SCHEMA.properties)).toEqual(["reply", "questions", "coverage", "nextAction", "stage", "insight", "progress"]);
  expect(Object.keys(ONBOARDING_EXTRACT_SCHEMA.properties)).toEqual(["slotUpdates", "projectsDetected", "flywheelCandidates", "fileDates", "lineProfiles",
    "goalEdits", "availability", "settings", "profileSections"]);
  const question = (onboardingDialogueSchema({ lines: ["research", "media"], projects: ["ece555"] }).properties.questions as { items: { properties: Record<string, { enum?: string[] }> } }).items.properties;
  expect(question.identityId!.enum).toEqual(["", "person", "research", "media"]);
  expect(question.projectId!.enum).toEqual(["", "ece555"]);
  const extract = onboardingExtractSchema({ lines: ["research"] }).properties as Record<string, { items: { properties: Record<string, { enum?: string[] }> } }>;
  expect(extract.slotUpdates!.items.properties.identityId!.enum).toEqual(["research", "person"]);
  // A fact may name a project the same answer detects, so its project stays open text.
  expect(extract.slotUpdates!.items.properties.projectId!.enum).toBeUndefined();
  expect(extract.lineProfiles!.items.properties.lineId!.enum).toEqual(["research"]);
});

test("a quote must really be in the cited reply, and a made-up quote is refused", () => {
  expectRejected(turn({ slotUpdates: [update({ sourceQuote: "10/15 前要投出" })] }), "ONBOARDING_QUOTE_NOT_VERBATIM");
});

test("a quote may break across lines in the source, because documents wrap", () => {
  const ok = validateOnboardingTurn(turn({ slotUpdates: [update({ slot: "midterm", sourceRef: "src-1", sourceQuote: "27th Oct. L15: Mid-term-1" })] }), known);
  expect(ok.slotUpdates[0]?.sourceRef).toBe("src-1");
});

test("citing a reply or file that does not exist is refused, and so is a fact with no quote", () => {
  expectRejected(turn({ slotUpdates: [update({ sourceRef: "reply-99" })] }), "ONBOARDING_UNKNOWN_SOURCE_REF");
  expectRejected(turn({ slotUpdates: [update({ sourceQuote: "" })] }), "ONBOARDING_QUOTE_REQUIRED");
});

test("an inference needs no quote but can never be passed off as confirmed", () => {
  const inferred = update({ sourceRef: "inference", sourceQuote: "", status: "inferred" });
  expect(validateOnboardingTurn(turn({ slotUpdates: [inferred] }), known).slotUpdates).toHaveLength(1);
  expectRejected(turn({ slotUpdates: [{ ...inferred, status: "confirmed" }] }), "ONBOARDING_INFERENCE_NOT_CONFIRMED");
});

test("facts may only name known lines and projects, or a project detected in the same turn", () => {
  expectRejected(turn({ slotUpdates: [update({ identityId: "health" })] }), "ONBOARDING_IDENTITY_UNKNOWN");
  expectRejected(turn({ slotUpdates: [update({ projectId: "nope" })] }), "ONBOARDING_PROJECT_UNKNOWN");
  const withNew = turn({
    projectsDetected: [{ id: "replay", identityId: "research", name: "hippocampus sleep replay", summary: "" }],
    slotUpdates: [update({ projectId: "replay" })]
  });
  expect(validateOnboardingTurn(withNew, known).projectsDetected).toHaveLength(1);
});

test("a multiple-choice question with fewer than two options is refused, so hard-to-recall items get candidates", () => {
  const bad = turn({ questions: [{ id: "q", text: "各条主线之间有什么联系？", kind: "multi", allowOther: true, identityId: "", projectId: "",
    options: [{ id: "only", label: "科研 → 创业", detail: "" }] }] });
  expectRejected(bad, "ONBOARDING_OPTIONS_REQUIRED");
});

test("an unfinished interview must ask something, and a finished one may not", () => {
  expectRejected(turn({ questions: [] }), "ONBOARDING_QUESTION_REQUIRED");
  expect(validateOnboardingTurn(turn({ questions: [], nextAction: "ready_for_milestones" }), known).nextAction).toBe("ready_for_milestones");
});

test("flywheel candidates need two different known lines and real evidence references", () => {
  const candidate = { fromIdentityId: "research", toIdentityId: "media", kind: "informs" as const, explanation: "文献分享是自媒体的选题来源",
    evidenceRefs: ["reply-1"], status: "inferred" as const };
  expect(validateOnboardingTurn(turn({ flywheelCandidates: [candidate] }), known).flywheelCandidates).toHaveLength(1);
  expectRejected(turn({ flywheelCandidates: [{ ...candidate, toIdentityId: "research" }] }), "ONBOARDING_RELATION_SELF_LOOP");
  expectRejected(turn({ flywheelCandidates: [{ ...candidate, evidenceRefs: ["src-9"] }] }), "ONBOARDING_UNKNOWN_SOURCE_REF");
});

test("duplicate question or option ids are refused", () => {
  const q = turn().questions[0]!;
  expectRejected(turn({ questions: [q, q] }), "ONBOARDING_QUESTION_DUPLICATE");
  expectRejected(turn({ questions: [{ ...q, options: [q.options[0]!, q.options[0]!] }] }), "ONBOARDING_OPTION_DUPLICATE");
});

test("when repairs run out, a turn keeps everything but the facts and questions that are malformed", () => {
  const kept = keepOnboardingTurn(turn({ slotUpdates: [update({}), update({ slot: "指南针" }), update({ slot: "fake", sourceQuote: "从未说过" })],
    lineProfiles: [{ lineId: "research", description: "研究描述", attributeCandidates: [] }, { lineId: "ghost", description: "", attributeCandidates: [] }] }), known);
  expect(kept?.slotUpdates.map((fact) => fact.slot)).toEqual(["deadline"]);
  expect(kept?.lineProfiles?.map((line) => line.lineId)).toEqual(["research"]);
  // A turn that is wrong as a whole — an unfinished interview with no usable question — stays refused.
  expect(keepOnboardingTurn(turn({ questions: [{ ...turn().questions[0]!, identityId: "ghost" }] }), known)).toBeUndefined();
});

const attribute = (text: string, kind: "domain" | "ability" | "state" = "domain", sourceRef = "reply-1") => ({ text, kind, sourceRef });
const SIX = [attribute("神经形态计算"), attribute("器件物理"), attribute("严谨", "ability"), attribute("独立", "ability"),
  attribute("持续产出", "state"), attribute("被同行认可", "state")];

test("a line's attribute candidates are 3–12 independent, cited attributes, or none at all", () => {
  const ok = validateOnboardingTurn(turn({ lineProfiles: [{ lineId: "research", description: "研究描述", attributeCandidates: SIX }] }), known);
  expect(ok.lineProfiles?.[0]?.attributeCandidates.map((item) => item.text)).toEqual(SIX.map((item) => item.text));
  // An empty list keeps the candidates on record (a line still thin, or a turn that only refines the description).
  expect(validateOnboardingTurn(turn({ lineProfiles: [{ lineId: "research", description: "", attributeCandidates: [] }] }), known).lineProfiles).toHaveLength(1);
  // Three is enough to compose a goal from (2026-10-19: asked for six, a real run left every line empty); two is not.
  expect(validateOnboardingTurn(turn({ lineProfiles: [{ lineId: "research", description: "", attributeCandidates: SIX.slice(0, 3) }] }), known).lineProfiles?.[0]?.attributeCandidates).toHaveLength(3);
  expectRejected(turn({ lineProfiles: [{ lineId: "research", description: "", attributeCandidates: SIX.slice(0, 2) }] }), "ONBOARDING_ATTRIBUTES_COUNT");
  expectRejected(turn({ lineProfiles: [{ lineId: "research", description: "", attributeCandidates: [...SIX, attribute("x", "domain", "reply-9")] }] }), "ONBOARDING_UNKNOWN_SOURCE_REF");
  expectRejected(turn({ lineProfiles: [{ lineId: "research", description: "", attributeCandidates: [...SIX, attribute("严谨、高产", "state")] }] }), "ONBOARDING_ATTRIBUTE_NOT_ATOMIC");
});

test("two attributes that say the same thing are refused, naming both: after removing 的 and punctuation one contains the other", () => {
  try {
    validateOnboardingTurn(turn({ lineProfiles: [{ lineId: "research", description: "", attributeCandidates: [...SIX, attribute("神经形态计算的")] }] }), known);
    throw new Error("expected a refusal");
  } catch (error) {
    expect((error as Error).message).toBe("ONBOARDING_ATTRIBUTE_DUPLICATE");
    expect((error as Error & { detail?: string }).detail).toContain("神经形态计算");
  }
  expectRejected(turn({ lineProfiles: [{ lineId: "research", description: "", attributeCandidates: [...SIX, attribute("类脑神经形态计算")] }] }), "ONBOARDING_ATTRIBUTE_DUPLICATE");
});

test("attributes come back cleaned, with their kind: no leading 成为, no trailing 的", () => {
  const ok = validateOnboardingTurn(turn({ lineProfiles: [{ lineId: "research", description: "", attributeCandidates: [{ ...SIX[0]!, text: "成为神经形态计算的" }, ...SIX.slice(1)] }] }), known);
  expect(ok.lineProfiles?.[0]?.attributeCandidates[0]).toEqual({ text: "神经形态计算", kind: "domain", sourceRef: "reply-1" });
});

test("a goal edit must cite the reply that asked for it, and is never a free-standing idea of the interview's", () => {
  const edit = { lineId: "research", parts: [{ text: "器件物理", kind: "domain" as const }, { text: "能独立立项", kind: "ability" as const }], sourceRef: "reply-1" };
  expect(validateOnboardingTurn(turn({ goalEdits: [edit] }), known).goalEdits?.[0]?.parts.map((part) => part.text)).toEqual(["器件物理", "能独立立项"]);
  expectRejected(turn({ goalEdits: [{ ...edit, sourceRef: "src-1" }] }), "ONBOARDING_GOAL_EDIT_UNASKED");
  expectRejected(turn({ goalEdits: [{ ...edit, sourceRef: "inference" }] }), "ONBOARDING_GOAL_EDIT_UNASKED");
  expectRejected(turn({ goalEdits: [{ ...edit, lineId: "ghost" }] }), "ONBOARDING_IDENTITY_UNKNOWN");
  expectRejected(turn({ goalEdits: [{ ...edit, parts: [{ text: "器件", kind: "domain" }, { text: "器件物理", kind: "domain" }] }] }), "ONBOARDING_ATTRIBUTE_DUPLICATE");
});

test("when repairs run out, bad attributes are dropped one by one; fewer than three left replace only a list no longer than them", () => {
  const kept = keepOnboardingTurn(turn({ lineProfiles: [{ lineId: "research", description: "d",
    attributeCandidates: [...SIX, attribute("神经形态计算的"), attribute("编造", "domain", "reply-7"), attribute("发表三篇顶会论文")] }],
    goalEdits: [{ lineId: "research", parts: [{ text: "器件物理", kind: "domain" }], sourceRef: "inference" }] }), known);
  expect(kept?.lineProfiles?.[0]?.attributeCandidates.map((item) => item.text)).toEqual(SIX.map((item) => item.text));
  expect(kept?.goalEdits).toEqual([]);
  const thin = turn({ lineProfiles: [{ lineId: "research", description: "d", attributeCandidates: [...SIX.slice(0, 2), attribute("x", "domain", "reply-9")] }] });
  // A line with nothing on record gets the two real ones (an empty list there kept the start standard from standing, W-71)…
  expect(keepOnboardingTurn(thin, known)?.lineProfiles?.[0]?.attributeCandidates.map((item) => item.text)).toEqual(["神经形态计算", "器件物理"]);
  // …a line with a fuller list keeps its own.
  expect(keepOnboardingTurn(thin, { ...known, attributesOnRecord: { research: 6 } })?.lineProfiles?.[0]?.attributeCandidates).toEqual([]);
});

test("a candidate that is an action, a count or an achievement is sent back naming every one, with how to write an attribute", () => {
  try {
    validateOnboardingTurn(turn({ lineProfiles: [{ lineId: "research", description: "", attributeCandidates: [...SIX.slice(0, 3),
      attribute("能独立立项", "ability"), attribute("发表三篇顶会论文", "state"), attribute("写公众号长文")] }] }), known);
    throw new Error("expected a refusal");
  } catch (error) {
    expect((error as Error).message).toBe("ONBOARDING_ATTRIBUTE_NOT_DESCRIPTIVE");
    const detail = (error as Error & { detail?: string }).detail ?? "";
    for (const text of ["能独立立项", "发表三篇顶会论文", "写公众号长文", "形容词", "少给几个也可以"]) expect(detail).toContain(text);
  }
  // Dropped when kept: the rest of the line stands, and a line left with only actions keeps nothing new (its record stays).
  const pruned = keepOnboardingTurn(turn({ lineProfiles: [{ lineId: "research", description: "d", attributeCandidates: [attribute("严谨", "ability"),
    attribute("能写基金申请", "ability"), attribute("拿到教职")] }, { lineId: "media", description: "m", attributeCandidates: [attribute("写公众号长文"), attribute("10w+ 粉丝")] }] }), known);
  expect(pruned?.lineProfiles?.map((line) => line.attributeCandidates.map((item) => item.text))).toEqual([["严谨"], []]);
  // What the person asked for in so many words is theirs: a goal edit keeps its wording even when it reads like an action.
  const edit = { lineId: "research", parts: [{ text: "器件物理", kind: "domain" as const }, { text: "能独立立项", kind: "ability" as const }], sourceRef: "reply-1" };
  expect(validateOnboardingTurn(turn({ goalEdits: [edit] }), known).goalEdits?.[0]?.parts.map((part) => part.text)).toEqual(["器件物理", "能独立立项"]);
});

test("droppedOnboardingItems counts what pruning left out across facts, questions and candidates", () => {
  const original = { slotUpdates: [1, 2, 3], questions: [1, 2], projectsDetected: [], flywheelCandidates: [1], goalEdits: [],
    lineProfiles: [{ attributeCandidates: [1, 2, 3] }], availability: { windows: [1, 2] } };
  const kept = { slotUpdates: [1, 2], questions: [1, 2], projectsDetected: [], flywheelCandidates: [], goalEdits: [],
    lineProfiles: [{ attributeCandidates: [1, 2] }], availability: { windows: [1, 2] } };
  expect(droppedOnboardingItems(original, kept as never)).toBe(3);
  expect(droppedOnboardingItems(original, original as never)).toBe(0);
});
