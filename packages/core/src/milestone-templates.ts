import type { SuccessCriterion } from "./index";

/**
 * The cross-identity axis every concrete template below is tagged with. Pulled from comparing OKR/SMART/
 * GTD against how research/startup/media/investment milestones actually read in practice (see the plan
 * this shipped under): none of those three general frameworks supplies domain content — they are empty
 * structures someone still has to fill in — but their shared shape reduces to one of five kinds of
 * claim. `health` (the capacity pack) deliberately has no templates: it is a constraint on the other four
 * identities, not an identity with milestones of its own, the same reason it has no milestones today.
 */
export type MilestoneTemplateKind = "deliverable" | "threshold" | "validation" | "recurring_cadence" | "decision";

/**
 * One pre-generated evidence question, in the Codex-`ask` style the person answers by clicking a
 * checkbox option or typing free text — see `apps/worker/src/milestone-proposer.ts` and work block E for
 * where these get instantiated onto a specific `WorkOrder` as `evidenceChecklist`. `options` is required
 * exactly when `kind` is `"checkbox"` and forbidden otherwise, expressed as a union rather than an
 * optional field for the same strict-JSON-schema reason `materials-schema.ts`'s contract items are.
 */
export type EvidenceQuestionTemplate =
  | { id: string; prompt: string; kind: "checkbox"; options: string[]; required: boolean }
  | { id: string; prompt: string; kind: "text"; required: boolean };

/** Strict-mode JSON schema for one `EvidenceQuestionTemplate` — shared by `crossline-milestone-
 * architect`'s proposal output (`milestone-gate-schema.ts`) and `crossline-assistant`'s
 * `templateProposal` would use it too if it ever grew evidence questions of its own. A `anyOf` union,
 * not an optional `options`, for the same reason `materials-schema.ts`'s contract items need one in
 * strict mode: "required but only for one branch" cannot be expressed any other way. */
export const EVIDENCE_QUESTION_SCHEMA = {
  anyOf: [
    {
      type: "object", additionalProperties: false,
      required: ["id", "prompt", "kind", "options", "required"],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 200 },
        prompt: { type: "string", minLength: 1, maxLength: 400 },
        kind: { type: "string", enum: ["checkbox"] },
        options: { type: "array", minItems: 1, maxItems: 6, items: { type: "string", minLength: 1, maxLength: 100 } },
        required: { type: "boolean" }
      }
    },
    {
      type: "object", additionalProperties: false,
      required: ["id", "prompt", "kind", "required"],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 200 },
        prompt: { type: "string", minLength: 1, maxLength: 400 },
        kind: { type: "string", enum: ["text"] },
        required: { type: "boolean" }
      }
    }
  ]
};

/** Checks the same `anyOf` the schema enforces structurally — options present exactly for checkbox,
 * absent otherwise — plus id uniqueness within one bank, since the JSON schema alone cannot express a
 * cross-item constraint. */
export function validateEvidenceQuestionBank(questions: EvidenceQuestionTemplate[]): boolean {
  const ids = questions.map((question) => question.id);
  if (new Set(ids).size !== ids.length) return false;
  for (const question of questions) {
    if (question.kind === "checkbox" && question.options.length === 0) return false;
  }
  return true;
}

export type MilestoneTemplateSource = "builtin" | "user" | "assistant";

export type MilestoneTemplate = {
  id: string;
  kind: MilestoneTemplateKind;
  identityId: string;
  titleHint: string;
  successCriteriaDefaults: SuccessCriterion[];
  evidenceQuestionDefaults: EvidenceQuestionTemplate[];
  source: MilestoneTemplateSource;
};

function questionsFor(templateId: string, kind: MilestoneTemplateKind): EvidenceQuestionTemplate[] {
  switch (kind) {
    case "deliverable": return [
      { id: `${templateId}-q1`, prompt: "最终产出物是否已经存在（文件、链接或可访问的制品）？", kind: "checkbox", options: ["是", "否"], required: true },
      { id: `${templateId}-q2`, prompt: "产出物具体是什么、放在哪里？", kind: "text", required: true }
    ];
    case "threshold": return [
      { id: `${templateId}-q1`, prompt: "实际达到的数值是多少？", kind: "text", required: true },
      { id: `${templateId}-q2`, prompt: "是否达到预设阈值？", kind: "checkbox", options: ["已达到", "部分达到", "未达到"], required: true }
    ];
    case "validation": return [
      { id: `${templateId}-q1`, prompt: "是否获得了外部确认（导师、用户、平台或合作方等）？", kind: "checkbox", options: ["是", "否"], required: true },
      { id: `${templateId}-q2`, prompt: "是谁确认的？确认的具体内容是什么？", kind: "text", required: true }
    ];
    case "recurring_cadence": return [
      { id: `${templateId}-q1`, prompt: "本周期实际完成了几次？", kind: "text", required: true },
      { id: `${templateId}-q2`, prompt: "是否达到预定节奏？", kind: "checkbox", options: ["是", "否"], required: true }
    ];
    case "decision": return [
      { id: `${templateId}-q1`, prompt: "最终做出的决定是什么？", kind: "text", required: true },
      { id: `${templateId}-q2`, prompt: "是否已经按这个决定采取了行动？", kind: "checkbox", options: ["是", "否", "部分"], required: false }
    ];
  }
}

function criterion(id: string, statement: string, required: boolean, evidenceOf: "output" | "outcome",
  measure: SuccessCriterion["measure"]): SuccessCriterion {
  return { id, statement, required, evidenceOf, measure };
}

function template(id: string, kind: MilestoneTemplateKind, identityId: string, titleHint: string,
  successCriteriaDefaults: SuccessCriterion[]): MilestoneTemplate {
  return { id, kind, identityId, titleHint, successCriteriaDefaults, evidenceQuestionDefaults: questionsFor(id, kind), source: "builtin" };
}

/**
 * The built-in template library — seeded into a new workspace's `milestone_templates` table once
 * (`source:"builtin"`), never overwritten after that so a user's own edits to a seeded row persist. Six
 * per identity, chosen to cover what recurred across the domain research (PhD progression checkpoints,
 * startup validation/PMF/growth stages, content-creator follower/monetization/cadence goals, personal
 * investing backtest/drawdown/review decisions) rather than attempting to enumerate every milestone a
 * person could ever write — the same "a new template is additive, not an exhaustive upfront list"
 * posture the rest of this codebase already takes with evidence contracts and material contracts.
 */
export function defaultMilestoneTemplates(): MilestoneTemplate[] {
  return [
    // research
    template("research-proposal-approved", "validation", "research", "开题评审通过", [
      criterion("c1", "导师或评审组确认开题的范围与方法可行", true, "outcome",
        { kind: "judgement", rubric: "评审反馈明确表示方法与范围可行，没有要求重大修改", failsWhen: "评审要求重新设计方法或范围" })
    ]),
    template("research-literature-review-done", "deliverable", "research", "文献综述完成", [
      criterion("c1", "综述文档存在，覆盖该方向的主要已发表工作", true, "output", { kind: "artifact", mustExist: "综述文档" })
    ]),
    template("research-experiment-milestone", "threshold", "research", "实验阶段达标", [
      criterion("c1", "完成预定数量的实验/数据采集轮次", true, "outcome", { kind: "threshold", unit: "轮", comparator: "gte", value: 1 })
    ]),
    template("research-manuscript-submitted", "deliverable", "research", "论文投稿", [
      criterion("c1", "投稿确认（submission id 或确认邮件）存在", true, "output", { kind: "artifact", mustExist: "投稿确认" })
    ]),
    template("research-revision-submitted", "deliverable", "research", "审稿意见修回", [
      criterion("c1", "针对每条审稿意见给出了回应并提交修改稿", true, "outcome",
        { kind: "judgement", rubric: "修回信逐条回应了审稿意见", failsWhen: "有审稿意见未被回应" })
    ]),
    template("research-analysis-done", "deliverable", "research", "数据分析完成", [
      criterion("c1", "分析结果（图表/统计量）存在且可复核", true, "output", { kind: "artifact", mustExist: "分析结果" })
    ]),

    // startup
    template("startup-mvp-launched", "deliverable", "startup", "MVP 上线", [
      criterion("c1", "MVP 已经可以被真实用户访问并使用核心功能", true, "outcome",
        { kind: "judgement", rubric: "至少一名非团队成员成功走完核心流程", failsWhen: "核心流程无法被外部用户走通" })
    ]),
    template("startup-first-paying-customers", "threshold", "startup", "首批付费用户", [
      criterion("c1", "累计付费用户数达到目标值", true, "outcome", { kind: "threshold", unit: "人", comparator: "gte", value: 1 })
    ]),
    template("startup-pmf-validated", "validation", "startup", "产品市场契合度验证", [
      criterion("c1", "通过用户访谈或留存数据确认产品解决了真实需求", true, "outcome",
        { kind: "judgement", rubric: "多数被访谈用户表示若产品消失会受到实质影响", failsWhen: "多数用户表示产品消失也无所谓" })
    ]),
    template("startup-funding-round-closed", "validation", "startup", "完成融资", [
      criterion("c1", "资金已经到账或签署了具有约束力的投资协议", true, "outcome", { kind: "artifact", mustExist: "投资协议或到账记录" })
    ]),
    template("startup-mrr-target", "threshold", "startup", "月度经常性收入达标", [
      criterion("c1", "月度经常性收入达到目标值", true, "outcome", { kind: "threshold", unit: "元", comparator: "gte", value: 1 })
    ]),
    template("startup-core-team-formed", "threshold", "startup", "核心团队到位", [
      criterion("c1", "核心岗位均有专人负责", true, "output", { kind: "count", unit: "人", atLeast: 1 })
    ]),

    // media (self-media)
    template("media-follower-target", "threshold", "media", "粉丝/订阅数达标", [
      criterion("c1", "粉丝或订阅数达到目标值", true, "outcome", { kind: "threshold", unit: "人", comparator: "gte", value: 1 })
    ]),
    template("media-revenue-target", "threshold", "media", "月收入达标", [
      criterion("c1", "月收入（广告/带货/打赏等合计）达到目标值", true, "outcome", { kind: "threshold", unit: "元", comparator: "gte", value: 1 })
    ]),
    template("media-cadence-held", "recurring_cadence", "media", "稳定更新节奏", [
      criterion("c1", "按预定频率持续更新", true, "outcome", { kind: "count", unit: "次/周期", atLeast: 1 })
    ]),
    template("media-breakout-content", "validation", "media", "内容破圈验证", [
      criterion("c1", "某条内容的互动或转发显著超过日常水平", true, "outcome",
        { kind: "judgement", rubric: "互动/转发数明显高于近期中位数", failsWhen: "数据与日常水平无明显差异" })
    ]),
    template("media-series-done", "deliverable", "media", "内容系列完成", [
      criterion("c1", "系列全部内容已发布", true, "output", { kind: "artifact", mustExist: "系列内容清单" })
    ]),
    template("media-brand-deal-closed", "validation", "media", "商业合作达成", [
      criterion("c1", "与品牌/平台签署或确认了合作", true, "output", { kind: "artifact", mustExist: "合作确认" })
    ]),

    // investment
    template("investment-backtest-done", "deliverable", "investment", "策略回测完成", [
      criterion("c1", "回测报告存在，包含收益与风险指标", true, "output", { kind: "artifact", mustExist: "回测报告" })
    ]),
    template("investment-drawdown-controlled", "threshold", "investment", "回撤控制在阈值内", [
      criterion("c1", "最大回撤不超过预设阈值", true, "outcome", { kind: "threshold", unit: "%", comparator: "lte", value: 100 })
    ]),
    template("investment-quarterly-review", "decision", "investment", "季度复盘决策", [
      criterion("c1", "完成季度复盘并做出明确的持仓/策略决定", true, "outcome",
        { kind: "judgement", rubric: "复盘产出了明确决定而非仅罗列数据", failsWhen: "复盘没有给出任何决定" })
    ]),
    template("investment-exit-decision", "decision", "investment", "仓位退出决策", [
      criterion("c1", "就该仓位是否退出做出了明确决定并执行", true, "outcome", { kind: "artifact", mustExist: "交易记录或决策记录" })
    ]),
    template("investment-return-target", "threshold", "investment", "组合收益率达标", [
      criterion("c1", "组合区间收益率达到目标值", true, "outcome", { kind: "threshold", unit: "%", comparator: "gte", value: 0 })
    ]),
    template("investment-research-report-done", "deliverable", "investment", "投研报告完成", [
      criterion("c1", "投研报告存在并包含明确结论", true, "output", { kind: "artifact", mustExist: "投研报告" })
    ])
  ];
}

export type MilestoneConfidence = "low" | "medium" | "high";

/**
 * Deterministic, not model-self-rated — `crossline-milestone-architect` is already told never to emit a
 * numeric score, and letting the model grade its own confidence has the same problem: it is marking its
 * own homework. `high` means the submitted criteria actually came from a known template unmodified,
 * `medium` means the template was used as a starting point but customized, and `low` is the same "free-
 * form, nothing to compare against" case every milestone has been stuck at before templates existed.
 */
export function computeMilestoneConfidence(successCriteria: SuccessCriterion[], template: MilestoneTemplate | undefined): MilestoneConfidence {
  if (!template) return "low";
  const defaults = template.successCriteriaDefaults;
  const sameShape = successCriteria.length === defaults.length
    && successCriteria.every((item, index) => item.measure.kind === defaults[index]?.measure.kind);
  return sameShape ? "high" : "medium";
}
