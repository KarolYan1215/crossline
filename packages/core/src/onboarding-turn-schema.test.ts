import { expect, test } from "vitest";
import { ONBOARDING_TURN_SCHEMA, keepOnboardingTurn, validateOnboardingTurn, type OnboardingTurn } from "./onboarding-turn-schema";

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
  walk(ONBOARDING_TURN_SCHEMA);
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
    lineProfiles: [{ lineId: "research", description: "研究描述", goalCandidates: ["成为能独立带项目的研究者"] }, { lineId: "ghost", description: "", goalCandidates: [] }] }), known);
  expect(kept?.slotUpdates.map((fact) => fact.slot)).toEqual(["deadline"]);
  expect(kept?.lineProfiles?.map((line) => line.lineId)).toEqual(["research"]);
  // A turn that is wrong as a whole — an unfinished interview with no usable question — stays refused.
  expect(keepOnboardingTurn(turn({ questions: [{ ...turn().questions[0]!, identityId: "ghost" }] }), known)).toBeUndefined();
});
