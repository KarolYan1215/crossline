/**
 * The interview's rule register (docs/onboarding-agent-session.md §4.2, docs/onboarding-validation-audit.md).
 *
 * Every rule the interview enforces is listed here once, with the layer that owns it:
 * - L0 code: a check the app runs. It names the source file and symbol, and a test file that exercises that symbol.
 * - L1 style block, L2 interview Skill, L3 tool descriptions, L4 sub-run Skills: text the model reads. It names the file and an
 *   anchor, a phrase that must appear in that file exactly once, so a rewrite that drops the rule fails the test.
 * A rule that is no longer enforced stays here as `retired`, with the reason (and the rule that took over its job, if one did), so a
 * migration can move a rule between layers or retire it, but never lose one silently.
 *
 * `verdict` is the 2026-11-14 audit's decision for the rule: keep it in code; keep it in code but hand a failure back to the model in
 * the same turn instead of rewriting silently ("return"); leave the judgement to the model ("model"); or delete it.
 *
 * Coverage is per symbol, not per test case: the covering test file must name the symbol or the test that exercises it.
 */
export type RuleLayer = "L0" | "L1" | "L2" | "L3" | "L4";
export type RuleVerdict = "keep" | "return" | "model" | "delete";

export type InterviewRule = {
  id: string;
  layer: RuleLayer;
  /** The rule in one sentence. */
  rule: string;
  verdict: RuleVerdict;
  status: "active" | "retired";
  /**
   * L0: where the check lives and which test file exercises it. `by` is a phrase of that test file that shows it (a test's name), for a
   * symbol the tests reach without naming it; it defaults to the symbol. A check with no test says so in `untested`.
   */
  code?: { file: string; symbol: string; test?: string; by?: string; untested?: string };
  /** L1–L4: the text file and a phrase that states the rule, found there exactly once. */
  text?: { file: string; anchor: string };
  /** Retired: why, and the id that does its job now, if any. */
  reason?: string;
  replacedBy?: string;
};

const CORE = "packages/core/src";
const WORKER = "apps/worker/src";
const SKILLS = "skills/marketplace/plugins/crossline/skills";
const INTERVIEW_SKILL = `${SKILLS}/crossline-onboarding/SKILL.md`;

// The register is read by its test and by people, never shown on a screen.
/* i18n-ignore-start */
export const INTERVIEW_RULES: readonly InterviewRule[] = [
  // 3.1 Evidence and facts: stay in code.
  { id: "IR-001", layer: "L0", verdict: "keep", status: "active", rule: "引文由句子编号从原文拷出，模型只给指针",
    code: { file: `${CORE}/onboarding-refs.ts`, symbol: "citedSpan", test: `${CORE}/onboarding-refs.test.ts` } },
  { id: "IR-002", layer: "L0", verdict: "keep", status: "active", rule: "卡片点选行（【题】点选：n/5）不作事实证据",
    code: { file: `${CORE}/onboarding-refs.ts`, symbol: "TAP_LINE", test: `${CORE}/onboarding-refs.test.ts`, by: "点选：4/5" } },
  { id: "IR-003", layer: "L0", verdict: "return", status: "active", rule: "观察卡的引文逐字出自本人回复，且至少来自两条回复（待核实卡一条）",
    code: { file: `${CORE}/onboarding-pace.ts`, symbol: "checkInsight", test: `${CORE}/onboarding-pace.test.ts` } },
  { id: "IR-004", layer: "L0", verdict: "keep", status: "active", rule: "粗略日期说法按今天换算成窗口",
    code: { file: `${CORE}/rough-dates.ts`, symbol: "roughWindow", test: `${CORE}/rough-dates.test.ts` } },
  { id: "IR-005", layer: "L0", verdict: "keep", status: "active", rule: "记下的日期必须落在原话说的窗口里",
    code: { file: `${CORE}/date-schema.ts`, symbol: "quoteSupportsDate", test: `${CORE}/date-schema.test.ts` } },
  // Sent back while repairs last; once they run out the sentence setting the date is left out (the one silent edit kept on the reply).
  { id: "IR-006", layer: "L0", verdict: "return", status: "active", rule: "回复里不出现本人和账本都没给过的日期",
    code: { file: `${CORE}/onboarding-reply.ts`, symbol: "inventedDates", test: `${CORE}/onboarding-reply.test.ts` } },
  { id: "IR-007", layer: "L0", verdict: "keep", status: "active", rule: "调研结论要有来源（最后一轮可以写查不到）",
    code: { file: `${CORE}/onboarding-research.ts`, symbol: "validateResearchTurn", test: `${CORE}/profile-hypotheses.test.ts` } },
  { id: "IR-008", layer: "L0", verdict: "keep", status: "active", rule: "画像结论的引文要能解析回本人回复",
    code: { file: `${CORE}/profile-claims.ts`, symbol: "resolveWrittenClaims", test: `${CORE}/profile-claims.test.ts` } },
  { id: "IR-009", layer: "L0", verdict: "keep", status: "active", rule: "要点合并：弱的不覆盖强的，丢弃的条数要报出",
    code: { file: `${CORE}/profile-points.ts`, symbol: "applyPointChanges", test: `${CORE}/profile-points.test.ts` } },

  // 3.2 Safety.
  { id: "IR-010", layer: "L0", verdict: "keep", status: "active", rule: "回应自伤披露的一轮只说热线、急诊和一个询问现状的问题",
    code: { file: `${CORE}/onboarding-reply.ts`, symbol: "safetyReplyOnly", test: `${CORE}/onboarding-reply.test.ts` } },
  { id: "IR-011", layer: "L0", verdict: "keep", status: "active", rule: "披露前后的回复不作观察卡引文，披露那一轮不出观察卡",
    code: { file: `${CORE}/onboarding-pace.ts`, symbol: "disclosureReplies", test: `${WORKER}/onboarding-session.test.ts`, by: "no observation card beside the safety check" } },
  { id: "IR-012", layer: "L0", verdict: "keep", status: "active", rule: "安全回合的识别：模型标了 safety，或回复里写了热线号码",
    code: { file: `${CORE}/onboarding-pace.ts`, symbol: "safetyRound", test: `${WORKER}/onboarding-session.test.ts` } },
  { id: "IR-046", layer: "L0", verdict: "return", status: "active", rule: "本人回复里有自伤字眼而这一轮不是安全回合时，退回模型确认一次",
    code: { file: `${CORE}/onboarding-pace.ts`, symbol: "mentionsSelfHarm", test: `${WORKER}/onboarding-session.test.ts` } },

  // Start standard and the person's own actions.
  { id: "IR-013", layer: "L0", verdict: "keep", status: "active", rule: "开始标准的各项都齐了才能开始（闸门、409）",
    code: { file: `${CORE}/interview-checklist.ts`, symbol: "readyToStart", test: `${CORE}/interview-checklist.test.ts` } },
  { id: "IR-014", layer: "L0", verdict: "keep", status: "active", rule: "同一件事最多问两次",
    code: { file: `${WORKER}/question-ledger.ts`, symbol: "MAX_ASKINGS", test: `${WORKER}/question-ledger.test.ts`, by: "may be asked once more, not twice" } },
  // Typed words are written here only when they say a day or a time; the rest is the extraction's to read (2026-11-14 audit).
  { id: "IR-015", layer: "L0", verdict: "keep", status: "active", rule: "本人在 app 自己的问题卡上的点选，直接写成确认的事实",
    code: { file: `${CORE}/profile-gaps.ts`, symbol: "answeredGapFacts", test: `${CORE}/profile-gaps.test.ts` } },

  // 3.3 Structure and limits.
  { id: "IR-016", layer: "L0", verdict: "return", status: "active", rule: "问题卡的结构：id 和选项不重复，选择题至少两个选项",
    code: { file: `${CORE}/onboarding-turn-schema.ts`, symbol: "checkTurn", test: `${CORE}/onboarding-turn-schema.test.ts`, by: "duplicate question or option ids are refused" } },
  { id: "IR-017", layer: "L0", verdict: "delete", status: "active", rule: "画像阶段一轮超过三个问题时截掉多的",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "paceDeepRound", test: `${WORKER}/onboarding-session.test.ts` } },

  // 3.4 Meaning judgements: the model's.
  { id: "IR-018", layer: "L0", verdict: "model", status: "retired", rule: "题干像问日子的，改成不带选项的日期题",
    code: { file: `${CORE}/onboarding-turn-schema.ts`, symbol: "DATE_ASK" },
    reason: "从题干猜，9 个误报（「哪天状态最好」丢了选项）；题目自己用 date 标记", replacedBy: "IR-106" },
  { id: "IR-019", layer: "L0", verdict: "model", status: "retired", rule: "题干像问「哪些」或目标的，改成多选",
    code: { file: `${CORE}/onboarding-turn-schema.ts`, symbol: "MANY" },
    reason: "「最想先推进哪一个」被改成多选；题型由模型写", replacedBy: "IR-107" },
  { id: "IR-020", layer: "L0", verdict: "delete", status: "active", rule: "删掉问目标、只问地点、日历可推、已知课表的问题",
    code: { file: `${CORE}/profile-gaps.ts`, symbol: "screenQuestions", test: `${CORE}/profile-gaps.test.ts` } },
  { id: "IR-021", layer: "L0", verdict: "return", status: "active", rule: "和问过的题相似的问题被删掉或复用旧题",
    code: { file: `${WORKER}/question-ledger.ts`, symbol: "resolveRepeats", test: `${WORKER}/question-ledger.test.ts` } },
  { id: "IR-022", layer: "L0", verdict: "delete", status: "active", rule: "从回答的文字判断本人是不知道还是没定",
    code: { file: `${CORE}/question-ledger.ts`, symbol: "unsureAnswer", test: `${CORE}/question-ledger.test.ts` } },
  { id: "IR-023", layer: "L0", verdict: "delete", status: "retired", rule: "模型自己问长期目标的题，答案直接写成这条线的目标",
    code: { file: `${CORE}/profile-gaps.ts`, symbol: "answeredGoalQuestions" },
    reason: "按题干猜「这是目标题」，把「最不想成为」的答案写成了目标；目标只从 app 自己的目标题和目标选择器写入", replacedBy: "IR-015" },
  { id: "IR-024", layer: "L0", verdict: "delete", status: "retired", rule: "网页端在发送前替本人采用对话里答出的目标",
    code: { file: "apps/web/app/onboarding/onboarding-workspace.tsx", symbol: "adoptGoalsFromRound" },
    reason: "同 IR-023 按题干猜目标题，还只存前三个词、丢掉本人写的那句", replacedBy: "IR-015" },
  { id: "IR-025", layer: "L0", verdict: "model", status: "active", rule: "模型提的定语候选要像一个原子的品质（措辞规则）",
    code: { file: `${CORE}/line-attributes.ts`, symbol: "attributeProblem", test: `${CORE}/line-attributes.test.ts` } },
  { id: "IR-026", layer: "L0", verdict: "keep", status: "active", rule: "本人选的定语只有字面相同时才报重复（「自由」和「财务自由」是两个选择）",
    code: { file: `${CORE}/line-attributes.ts`, symbol: "checkGoalParts", test: `${CORE}/line-attributes.test.ts` } },
  { id: "IR-027", layer: "L0", verdict: "keep", status: "active", rule: "定语去掉首尾标点、「成为」和末尾的「的」，属于词的符号（C++、C#）留着",
    code: { file: `${CORE}/line-attributes.ts`, symbol: "cleanAttribute", test: `${CORE}/line-attributes.test.ts` } },
  { id: "IR-028", layer: "L0", verdict: "model", status: "active", rule: "项目名像课程代码的，当课程问上课时间",
    code: { file: `${CORE}/profile-gaps.ts`, symbol: "isCourse", test: `${CORE}/profile-gaps.test.ts` } },
  { id: "IR-029", layer: "L0", verdict: "delete", status: "retired", rule: "再问最骄傲的事时，题前加「除了前面讲过的那件」",
    code: { file: `${CORE}/onboarding-reply.ts`, symbol: "withoutToldStory" },
    reason: "在模型的题前硬加半句，接不上上下文；规则只写在 Skill", replacedBy: "IR-108" },
  { id: "IR-030", layer: "L0", verdict: "delete", status: "retired", rule: "回复里复述观察卡的句子被删掉",
    code: { file: `${CORE}/onboarding-reply.ts`, symbol: "withoutCardEcho" },
    reason: "按字对重合删句，会删掉接住本人的话；规则只写在 Skill", replacedBy: "IR-109" },
  { id: "IR-031", layer: "L0", verdict: "delete", status: "retired", rule: "回复里说「还在记录」的句子被删掉",
    code: { file: `${CORE}/onboarding-reply.ts`, symbol: "withoutRecordingTalk" },
    reason: "状态里已列出本人答了、还没记下的项（startStandard.answered），模型不必再说；静默删句不再需要" },
  { id: "IR-032", layer: "L0", verdict: "delete", status: "retired", rule: "术语被替换成平实说法",
    code: { file: `${CORE}/onboarding-pace.ts`, symbol: "withPlainTerms" },
    reason: "本人自己用的「硬约束」也被替换；规则只写在 Skill", replacedBy: "IR-110" },
  { id: "IR-033", layer: "L0", verdict: "delete", status: "retired", rule: "本人说没什么要补充时，这一轮不再出新题",
    code: { file: `${CORE}/onboarding-reply.ts`, symbol: "saidNothingMore" },
    reason: "「没什么好说的，但我最近很焦虑」也算没话说了；是否结束由模型读本人的话判断" },
  { id: "IR-034", layer: "L0", verdict: "return", status: "active", rule: "回复不照抄调研结论里的数字",
    code: { file: `${CORE}/onboarding-reply.ts`, symbol: "researchCopied", test: `${CORE}/onboarding-reply.test.ts` } },
  // Sent back while repairs last (`endHinted`); past them the sentence is left out (`withoutEndHint`): the button would refuse.
  { id: "IR-035", layer: "L0", verdict: "return", status: "active", rule: "开始标准没齐时，回复不说可以开始，也不提结束按钮",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "endHinted", test: `${WORKER}/onboarding-session.test.ts`, by: "withoutEndHint" } },
  { id: "IR-036", layer: "L0", verdict: "keep", status: "active", rule: "画像的类型简介不把类型名当成本人的标签（「你是军师」），普通用法放过",
    code: { file: `${CORE}/portrait-type.ts`, symbol: "typeSummaryProblem", test: `${CORE}/portrait.test.ts` } },
  { id: "IR-037", layer: "L0", verdict: "keep", status: "active", rule: "画像里不在本场的主线那一项被剪掉，不让整份画像失败",
    code: { file: `${CORE}/portrait.ts`, symbol: "onRecord", test: `${CORE}/portrait.test.ts`, by: "A line not on record is left out" } },

  // 3.5 Questions and waits the app made: delete.
  { id: "IR-038", layer: "L0", verdict: "delete", status: "active", rule: "app 把开始标准缺的项作为自己的问题插进这一轮",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "withGapQuestions", test: `${WORKER}/onboarding-checklist.test.ts` } },
  { id: "IR-039", layer: "L0", verdict: "delete", status: "active", rule: "一轮没有题时，app 补一道开放题",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "withSomethingToAnswer", test: `${WORKER}/onboarding-checklist.test.ts` } },
  { id: "IR-040", layer: "L0", verdict: "delete", status: "active", rule: "对话开始前最多等整理 60 秒",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "START_WAIT_MS", untested: "等待时长没有测试：测试里的整理都立即返回" } },
  { id: "IR-041", layer: "L0", verdict: "delete", status: "active", rule: "问题出来前最多等整理 30 秒",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "BLOCKING_WAIT_MS", untested: "等待时长没有测试：测试里的整理都立即返回" } },
  { id: "IR-042", layer: "L0", verdict: "delete", status: "active", rule: "空轮最多等清单 300 秒",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "CHECKLIST_WAIT_MS", untested: "等待时长没有测试：测试里的整理都立即返回" } },
  { id: "IR-043", layer: "L0", verdict: "delete", status: "active", rule: "本人更正过观察卡后，所有观察卡停一轮",
    code: { file: `${WORKER}/onboarding-extract.ts`, symbol: "cardsWait", test: `${WORKER}/onboarding-session.test.ts` } },
  { id: "IR-044", layer: "L0", verdict: "delete", status: "active", rule: "画像阶段先不出缺项题",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "holdGaps", untested: "按阶段压住缺项题，只在一轮的组装里，没有单独的测试" } },
  { id: "IR-045", layer: "L0", verdict: "delete", status: "retired", rule: "事实合并（core 版）",
    code: { file: `${CORE}/profile-gaps.ts`, symbol: "mergeFacts" },
    reason: "没有生产调用者；「推断不覆盖已确认」由数据库的 upsert 规则保证" },

  // L2: rules the interview Skill states (the model's own judgement, per the audit).
  { id: "IR-100", layer: "L2", verdict: "model", status: "active", rule: "已经答过的不重问，答了一部分只问缺的",
    text: { file: INTERVIEW_SKILL, anchor: "**不要重复问本人已经说过的。**" } },
  { id: "IR-101", layer: "L2", verdict: "model", status: "active", rule: "本人说不确定、没定，就是答案，同一件事不再问日期",
    text: { file: INTERVIEW_SKILL, anchor: "**一件事一轮最多问一个日期，「还没定」就是答案。**" } },
  { id: "IR-102", layer: "L2", verdict: "model", status: "active", rule: "接着本人的话往深一层问",
    text: { file: INTERVIEW_SKILL, anchor: "**接着本人的话往下走一层。**" } },
  { id: "IR-103", layer: "L2", verdict: "model", status: "active", rule: "选项不编造本人或文件没给过的事实",
    text: { file: INTERVIEW_SKILL, anchor: "**选项不编造事实。**" } },
  { id: "IR-104", layer: "L2", verdict: "model", status: "active", rule: "本人拒绝的话题整场不再问",
    text: { file: INTERVIEW_SKILL, anchor: "**本人拒绝或说不需要的，永远不再问。**" } },
  { id: "IR-105", layer: "L2", verdict: "model", status: "active", rule: "不问琐碎钟点，能推出的不问",
    text: { file: INTERVIEW_SKILL, anchor: "**不问琐碎钟点。**" } },
  { id: "IR-106", layer: "L2", verdict: "model", status: "active", rule: "问日子用不带选项的 free，并标 date",
    text: { file: INTERVIEW_SKILL, anchor: "并把这道题的 `date` 设为 `true`" } },
  { id: "IR-107", layer: "L2", verdict: "model", status: "active", rule: "选项互斥用 single，可同时成立用 multi",
    text: { file: INTERVIEW_SKILL, anchor: "只问「最想先推进哪一个」时用 `single`" } },
  { id: "IR-108", layer: "L2", verdict: "model", status: "active", rule: "讲过的故事不换个问题再要一遍",
    text: { file: INTERVIEW_SKILL, anchor: "**讲过的故事不换个问题再要一遍。**" } },
  { id: "IR-109", layer: "L2", verdict: "model", status: "active", rule: "每次回应多出一层推断，不复述",
    text: { file: INTERVIEW_SKILL, anchor: "**每次回应都要多出一层推断，不复述。**" } },
  { id: "IR-110", layer: "L2", verdict: "model", status: "active", rule: "不用应用自己的术语",
    text: { file: INTERVIEW_SKILL, anchor: "也不用应用自己的术语：不说「硬约束」" } },
];
/* i18n-ignore-end */
