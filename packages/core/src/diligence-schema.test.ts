import { expect, test } from "vitest";
import { publicHttpsUrl, validateDiligence, type DiligenceContext, type DiligenceOutput } from "./diligence-schema";

const context = (identityId = "startup"): DiligenceContext => ({
  version: "crossline.diligence.v1", today: "2026-10-02", timeZone: "America/Chicago",
  identity: { id: identityId, label: identityId },
  topic: { kind: "opportunities", question: "有哪些适合学生身份的创业比赛和孵化器？" },
  projects: [], constraints: ["学生身份暂时无法全职创业"], alreadyDecided: [{ title: "已经拒绝过的建议", decision: "rejected" }],
  facts: [{ id: "startup/crossline/stage", projectId: "crossline", slot: "stage", value: "只有自己在用", status: "confirmed" }]
});
const output = (over: Partial<DiligenceOutput> = {}): DiligenceOutput => ({
  question: "有哪些适合学生身份的创业比赛和孵化器？",
  sources: [{ id: "s1", url: "https://example.edu/accelerator", title: "Student Accelerator", publisher: "Example University", accessedOn: "2026-10-02" }],
  findings: [{ id: "f1", claim: "该孵化器接受在读学生，申请截止 2026-11-15。", sourceIds: ["s1"], confidence: "high", staleWhen: "下一届申请开放时" }],
  proposals: [{ id: "p1", title: "11/15 前提交学生孵化器申请", why: "符合在读学生身份，且截止日期在 MVP 完成之前", kind: "milestone",
    dueDate: "2026-11-15", basedOnFacts: ["startup/crossline/stage"], findingIds: ["f1"] }],
  gaps: [], blockers: [], ...over
});
const refused = (value: unknown, code: string, ctx = context()) => {
  try { validateDiligence(value, ctx); } catch (error) { expect((error as Error).message).toBe(code); return; }
  throw new Error(`expected ${code}`);
};

test("a sourced finding and a proposal built on it are accepted", () => {
  expect(validateDiligence(output(), context()).proposals).toHaveLength(1);
});

test("only public https pages are accepted as sources", () => {
  expect(publicHttpsUrl("https://example.edu/a")).toBeDefined();
  for (const bad of ["http://example.edu", "https://127.0.0.1/a", "https://localhost/a", "https://192.168.1.5/a", "https://example.edu:8443/a",
    "https://user:pw@example.edu/a", "https://printer.local/a", "https://intranet/a", "file:///etc/passwd", "not a url"]) {
    expect(publicHttpsUrl(bad), bad).toBeUndefined();
  }
  const bad = output();
  bad.sources[0]!.url = "https://10.0.0.5/admin";
  refused(bad, "DILIGENCE_SOURCE_URL_INVALID");
});

test("a finding must cite a source that exists, and a proposal a finding that exists", () => {
  refused(output({ findings: [{ ...output().findings[0]!, sourceIds: ["s9"] }] }), "DILIGENCE_FINDING_UNSOURCED");
  refused(output({ proposals: [{ ...output().proposals[0]!, findingIds: ["f9"] }] }), "DILIGENCE_PROPOSAL_UNSOURCED");
  refused(output({ proposals: [{ ...output().proposals[0]!, basedOnFacts: ["startup/crossline/invented"] }] }), "DILIGENCE_FACT_UNKNOWN");
});

test("a source read long ago, or a due date in the past, is refused", () => {
  const stale = output();
  stale.sources[0]!.accessedOn = "2026-06-01";
  refused(stale, "DILIGENCE_SOURCE_DATE_INVALID");
  refused(output({ proposals: [{ ...output().proposals[0]!, dueDate: "2026-09-01" }] }), "DILIGENCE_DUE_DATE_INVALID");
});

test("the investment line never gets a trade call or a price target", () => {
  const advice = output({
    findings: [{ ...output().findings[0]!, claim: "分析师给出目标价 200 美元，建议逢低买入。" }]
  });
  refused(advice, "DILIGENCE_ADVICE_FORBIDDEN", context("investment"));
  const framework = output({ findings: [{ ...output().findings[0]!, claim: "收益率与最大回撤是个人账户最常用的两项追踪指标。" }],
    proposals: [{ ...output().proposals[0]!, title: "建立每周收益率与回撤追踪表", why: "用同一口径记录个人账户的收益率和风险" }] });
  expect(() => validateDiligence(framework, context("investment"))).not.toThrow();
});

test("an idea the person already answered is not offered again, and a blocker is reported", () => {
  refused(output({ proposals: [{ ...output().proposals[0]!, title: "已经拒绝过的建议" }] }), "DILIGENCE_PROPOSAL_REPEATED");
  refused(output({ blockers: [{ code: "NO_ACCESS", message: "无法联网" }] }), "DILIGENCE_BLOCKED");
});
