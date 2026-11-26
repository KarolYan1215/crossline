import { expect, test } from "vitest";
import { autoApprovalEligible, taintedRisk } from "./auto-approval";
import { CONCIERGE_TOOL_SPECS } from "./concierge";
import { readProvenance, TOOL_SPEC, toolSpecOf, untrustedFile, withheldByRuleOfTwo } from "./tool-spec";

test("every 小帮手 lookup is in the table; a function missing from it reads as untrusted and outbound", () => {
  for (const spec of CONCIERGE_TOOL_SPECS) expect(Object.hasOwn(TOOL_SPEC, spec.name), spec.name).toBe(true);
  expect(toolSpecOf("send_mail")).toMatchObject({ reads: "untrusted", effect: "outbound" });
  expect(toolSpecOf("constructor")).toMatchObject({ reads: "untrusted", effect: "outbound" });
  for (const [name, spec] of Object.entries(TOOL_SPEC)) {
    expect(["untrusted", "private", "none"], name).toContain(spec.reads);
    expect(["none", "local_write", "ledger_write", "outbound"], name).toContain(spec.effect);
  }
});

test("the Rule of Two: private data and untrusted content together keep nothing outbound", () => {
  const offered = ["read_task", "add_to_inbox", "mail_read", "web_search", "connectors", "some_new_tool"];
  expect(withheldByRuleOfTwo(offered, { tainted: false })).toEqual([]);
  // An unlisted function counts as outbound, so it goes too.
  expect(withheldByRuleOfTwo(offered, { tainted: true })).toEqual(["web_search", "connectors", "some_new_tool"]);
  // Nothing private held: the web may stay (a run that only reads the web and writes its own files).
  expect(withheldByRuleOfTwo(["write_file", "web_search"], { tainted: true })).toEqual([]);
});

test("mail and saved pages and downloads are someone else's words; the person's own files are not", () => {
  expect(untrustedFile("C:\\Users\\a\\Downloads\\invoice.pdf")).toBe("download");
  expect(untrustedFile("/home/a/mail/offer.eml")).toBe("mail");
  expect(untrustedFile("D:\\notes\\saved.html")).toBe("page");
  expect(untrustedFile("D:\\courses\\ECE548\\syllabus.pdf")).toBeUndefined();
  expect(readProvenance({ run: "t", by: "assistant", tainted: true, sources: ["mail", "bogus"] })).toEqual({ run: "t", by: "assistant", tainted: true, sources: ["mail"] });
  expect(readProvenance({ run: "t" })).toBeUndefined();
});

const proposal = (intent: string, extra: Record<string, unknown> = {}) => ({ id: "cap-agent-x", state: "awaiting_plan_approval", riskTier: "routine", intent,
  payload: { title: intent, needsPerson: { kind: "none", quote: "" }, ...extra } });
const fromMail = { provenance: { run: "agent-1", by: "assistant", tainted: true, sources: ["mail"] } };

test("work written after reading mail: low-risk takes effect and says where it came from; high-risk waits for the person", () => {
  expect(autoApprovalEligible(proposal("整理 ECE 548 期中复习提纲", fromMail))).toEqual({ eligible: true, reason: "来自助手读邮件，低风险，默认生效" });
  const held = (intent: string, extra: Record<string, unknown> = {}) => autoApprovalEligible(proposal(intent, { ...fromMail, ...extra }));
  expect(held("把报告提交给导师")).toMatchObject({ eligible: false });
  expect(held("把报告提交给导师").reason).toContain("对外动作或承诺");
  // The model's `external` alone is enough.
  expect(held("整理会议材料", { external: true }).reason).toContain("对外动作或承诺");
  expect(held("缴纳 ¥300 报名费").reason).toContain("金额或付款");
  expect(held("打开 https://bit.ly/x 核对信息").reason).toContain("链接");
  expect(held("用学号和密码登录门户更新信息").reason).toContain("登录、账号或证件");
  expect(held("Verify your account password")).toMatchObject({ eligible: false });
  expect(taintedRisk({ intent: "Pay the $40 invoice at www.example.com", payload: {} })).toEqual(["external", "money", "link"]);
  // Any bare host, not a list of top-level domains (review of 2026-11-25); a file name is not a link.
  expect(taintedRisk({ intent: "按邮件要求访问 portal.example.ai 更新信息", payload: {} })).toContain("link");
  expect(taintedRisk({ intent: "Open update.uni-portal.de", payload: {} })).toContain("link");
  expect(taintedRisk({ intent: "整理 report.pdf 和 notes.md 里的 Node.js 笔记", payload: {} })).not.toContain("link");
  // The mail triage's own captures say so in their own words.
  expect(autoApprovalEligible(proposal("整理 HW4 题目", { provenance: { run: "mail-triage", by: "mail_triage", tainted: true, sources: ["mail"] } })).reason)
    .toBe("来自邮件分拣，低风险，默认生效");
});

test("work that read nothing untrusted is decided exactly as before", () => {
  expect(autoApprovalEligible(proposal("把报告提交给导师"))).toEqual(autoApprovalEligible(proposal("把报告提交给导师", { provenance: { run: "x", tainted: false, sources: [] } })));
  expect(autoApprovalEligible(proposal("缴纳 ¥300 报名费")).eligible).toBe(true);
  // Already held for another reason: that reason stands.
  expect(autoApprovalEligible(proposal("选定方案", { ...fromMail, needsPerson: { kind: "decision", quote: "选定方案" } })).reason).toContain("本人的选择或决定");
});
