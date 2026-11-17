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
const EXTRACT_SKILL = `${SKILLS}/crossline-onboarding-extract/SKILL.md`;

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
  // Counted over rewordings; a third asking comes back to the model instead of being dropped (P2b-3a).
  { id: "IR-014", layer: "L0", verdict: "return", status: "active", rule: "同一件事最多问两次",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "MAX_ASKINGS", test: `${WORKER}/onboarding-cards.test.ts`, by: "rewordings are counted" } },
  // Typed words are written here only when they say a day or a time; the rest is the extraction's to read (2026-11-14 audit).
  { id: "IR-015", layer: "L0", verdict: "keep", status: "active", rule: "本人在 app 自己的问题卡上的点选，直接写成确认的事实",
    code: { file: `${CORE}/profile-gaps.ts`, symbol: "answeredGapFacts", test: `${CORE}/profile-gaps.test.ts` } },

  // 3.3 Structure and limits.
  { id: "IR-016", layer: "L0", verdict: "return", status: "active", rule: "问题卡的结构：id 和选项不重复，选择题至少两个选项",
    code: { file: `${CORE}/onboarding-turn-schema.ts`, symbol: "checkTurn", test: `${CORE}/onboarding-turn-schema.test.ts`, by: "duplicate question or option ids are refused" } },
  { id: "IR-017", layer: "L0", verdict: "delete", status: "retired", rule: "画像阶段一轮超过三个问题时截掉多的",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "paceDeepRound" },
    reason: "截掉的题本人看不到、模型也不知道；画像阶段三题是 Skill 的规则，一轮的上限由退回执行", replacedBy: "IR-051" },
  { id: "IR-051", layer: "L0", verdict: "return", status: "active", rule: "一轮最多五个问题（openItems 也算），多的退回模型放到下一轮",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "ROUND_QUESTIONS", test: `${WORKER}/onboarding-cards.test.ts` } },

  // 3.4 Meaning judgements: the model's.
  { id: "IR-018", layer: "L0", verdict: "model", status: "retired", rule: "题干像问日子的，改成不带选项的日期题",
    code: { file: `${CORE}/onboarding-turn-schema.ts`, symbol: "DATE_ASK" },
    reason: "从题干猜，9 个误报（「哪天状态最好」丢了选项）；题目自己用 date 标记", replacedBy: "IR-106" },
  { id: "IR-019", layer: "L0", verdict: "model", status: "retired", rule: "题干像问「哪些」或目标的，改成多选",
    code: { file: `${CORE}/onboarding-turn-schema.ts`, symbol: "MANY" },
    reason: "「最想先推进哪一个」被改成多选；题型由模型写", replacedBy: "IR-107" },
  { id: "IR-020", layer: "L0", verdict: "delete", status: "retired", rule: "删掉问目标、只问地点、日历可推、已知课表的问题",
    code: { file: `${CORE}/profile-gaps.ts`, symbol: "screenQuestions" },
    reason: "「你在哪里最容易进入专注状态？」被当成问地点删，「朋友会用哪些词形容你？」被当成目标题删；能推出的不问由 Skill 规定", replacedBy: "IR-105" },
  { id: "IR-021", layer: "L0", verdict: "return", status: "retired", rule: "和问过的题相似的问题被删掉或复用旧题",
    code: { file: `${WORKER}/question-ledger.ts`, symbol: "resolveRepeats" },
    reason: "按字面相似度删题，误删往深一层的追问（0.69）；改成退回模型并附本人的回答", replacedBy: "IR-047" },
  { id: "IR-047", layer: "L0", verdict: "return", status: "active", rule: "和答过的题像同一个问题时退回模型，附本人的回答；模型标 followUp 的追问照发",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "checkQuestions", test: `${WORKER}/onboarding-cards.test.ts` } },
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
  { id: "IR-038", layer: "L0", verdict: "delete", status: "retired", rule: "app 把开始标准缺的项作为自己的问题插进这一轮",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "withGapQuestions" },
    reason: "插进来的题不接上一句；app 的待问题改列在 openItems，模型决定什么时候问", replacedBy: "IR-048" },
  { id: "IR-048", layer: "L0", verdict: "return", status: "active", rule: "app 自己的待问题只在模型写进 openItems 时按 app 的写法发出；模型换说法问的退回",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "checkOpenItems", test: `${WORKER}/onboarding-cards.test.ts` } },
  { id: "IR-039", layer: "L0", verdict: "delete", status: "retired", rule: "一轮没有题时，app 补一道开放题",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "withSomethingToAnswer" },
    reason: "固定开放题像在填表，「哪条主线」连问九轮；还没问完的一轮没有题时退回模型", replacedBy: "IR-052" },
  { id: "IR-052", layer: "L0", verdict: "return", status: "active", rule: "还没问完的一轮必须有题（模型自己的或 openItems 里的）",
    code: { file: `${CORE}/onboarding-turn-schema.ts`, symbol: "ONBOARDING_QUESTION_REQUIRED", test: `${CORE}/onboarding-turn-schema.test.ts` } },
  { id: "IR-040", layer: "L0", verdict: "delete", status: "retired", rule: "对话开始前最多等整理 60 秒",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "START_WAIT_MS" },
    reason: "三处等待叠加，赞助模型一次整理要 4–15 分钟，多数等满也没等到；还没记下的回复由 startStandard.answered 告诉模型" },
  { id: "IR-041", layer: "L0", verdict: "delete", status: "retired", rule: "问题出来前最多等整理 30 秒",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "BLOCKING_WAIT_MS" },
    reason: "三处等待叠加，赞助模型一次整理要 4–15 分钟，多数等满也没等到；还没记下的回复由 startStandard.answered 告诉模型" },
  { id: "IR-042", layer: "L0", verdict: "delete", status: "retired", rule: "空轮最多等清单 300 秒",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "CHECKLIST_WAIT_MS" },
    reason: "三处等待叠加，赞助模型一次整理要 4–15 分钟，多数等满也没等到；还没记下的回复由 startStandard.answered 告诉模型" },
  { id: "IR-043", layer: "L0", verdict: "delete", status: "retired", rule: "本人更正过观察卡后，所有观察卡停一轮",
    code: { file: `${WORKER}/onboarding-extract.ts`, symbol: "cardsWait" },
    reason: "一次更正让所有卡停一轮，第十四次回放里停了十轮；更正改为放在卡旁边对照", replacedBy: "IR-111" },
  { id: "IR-044", layer: "L0", verdict: "delete", status: "retired", rule: "画像阶段先不出缺项题",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "holdGaps" },
    reason: "缺项题不再由 app 插入，什么时候问由模型在 openItems 里定", replacedBy: "IR-048" },
  { id: "IR-049", layer: "L0", verdict: "return", status: "active", rule: "观察卡不合格时连同原因退回模型（引文、披露、引用条数、假设日志、同一假设两次）",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "checkInsights", test: `${WORKER}/onboarding-cards.test.ts` } },
  { id: "IR-050", layer: "L0", verdict: "return", status: "active", rule: "调研已有线程或同时开着的太多时退回模型",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "checkResearch", test: `${WORKER}/onboarding-cards.test.ts` } },
  // P2b-3b: the same checks, run as each item is handed in through a tool; a failing call is the tool's error, in the same turn.
  { id: "IR-053", layer: "L0", verdict: "return", status: "active", rule: "出卡工具当场核对每一项，不合格作为工具的回答退回，不收下",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "cardTools", test: `${WORKER}/onboarding-cards.test.ts` } },
  // P3: a thread rebuilt from the ledger.
  { id: "IR-054", layer: "L0", verdict: "keep", status: "active", rule: "线程丢失重建时只按阅读预算发文件，其余不记为已展示，留给后面的轮次",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "withinBudget", test: `${WORKER}/onboarding-session.test.ts`, by: "a rebuilt thread is sent the files within the reading budget" } },
  { id: "IR-055", layer: "L0", verdict: "keep", status: "active", rule: "重建的对话历史带上每轮的选项和观察卡（连同假设 id）",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "conversationSoFar", test: `${WORKER}/onboarding-session.test.ts`, by: "【观察卡 h1】" } },
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
  { id: "IR-111", layer: "L2", verdict: "model", status: "active", rule: "本人刚更正过卡、假设日志还没重看时，出卡先对照更正，不再写被更正的前提",
    text: { file: INTERVIEW_SKILL, anchor: "**有 `cardsCheck` 时，出卡前先对照更正。**" } },
  { id: "IR-112", layer: "L2", verdict: "model", status: "active", rule: "app 自己的问题用 openItems 问，不换说法再问",
    text: { file: INTERVIEW_SKILL, anchor: "**应用自己的问题用 `openItems` 问，不要换说法再问**" } },
  { id: "IR-113", layer: "L2", verdict: "model", status: "active", rule: "往深一层的追问接住原回答并标 followUp",
    text: { file: INTERVIEW_SKILL, anchor: "并把这道题的 `followUp` 设为 `true`" } },
  { id: "IR-114", layer: "L2", verdict: "model", status: "active", rule: "app 只退回问题清单，不替模型改字、不悄悄删",
    text: { file: INTERVIEW_SKILL, anchor: "**应用核对后把问题退回给你。**" } },
  // The progress header (2026-11-15, after replay 15): the app counts, the model decides.
  { id: "IR-115", layer: "L0", verdict: "keep", status: "active", rule: "每轮输入最前面放进度头：轮数、阶段、开始标准从第几轮齐、ready 还差什么、最近三轮的题数和卡",
    code: { file: `${WORKER}/onboarding-standing.ts`, symbol: "standingLines", test: `${WORKER}/onboarding-standing.test.ts` } },
  { id: "IR-116", layer: "L2", verdict: "model", status: "active", rule: "进度头只是事实，不替模型判断",
    text: { file: INTERVIEW_SKILL, anchor: "**进度头只是事实。**" } },
  { id: "IR-117", layer: "L2", verdict: "model", status: "active", rule: "同一阶段多轮每轮只剩一题，就换阶段或说可以结束，不往下钻",
    text: { file: INTERVIEW_SKILL, anchor: "**同一阶段连着很多轮、每轮只剩一道题，这一阶段就问完了。**" } },
  { id: "IR-118", layer: "L2", verdict: "model", status: "retired", rule: "开始标准一齐，回复里说一次本人可以结束；ready 还差的问完再说一次",
    text: { file: INTERVIEW_SKILL, anchor: "**开始标准一齐，就说一次本人可以结束。**" },
    reason: "2026-11-15 本人定：结束提示只由页面依据账本说，模型不负责", replacedBy: "IR-142" },
  { id: "IR-119", layer: "L2", verdict: "model", status: "active", rule: "最近三轮的卡多被评部分对，这一轮先问再出卡",
    text: { file: INTERVIEW_SKILL, anchor: "**最近三轮的卡多被评「部分对」，这一轮先问再出卡。**" } },
  { id: "IR-120", layer: "L2", verdict: "model", status: "active", rule: "不把本人刚定的安排换说法写成卡",
    text: { file: INTERVIEW_SKILL, anchor: "**不把本人刚定的安排写成卡。**" } },
  // Disclosures (2026-11-15, after replay 15 retold one in a card): no model reads the words again, what points back at them is returned,
  // and what the hard time taught is talked about only after the person said yes to the app's own question.
  { id: "IR-121", layer: "L0", verdict: "keep", status: "active", rule: "披露所在的回复，在整理、画像、问题记录和重建的对话线程里都换成占位，模型读不到原文",
    code: { file: `${CORE}/onboarding-pace.ts`, symbol: "withoutDisclosures", test: `${CORE}/onboarding-pace.test.ts` } },
  { id: "IR-122", layer: "L0", verdict: "keep", status: "active", rule: "对话线程还留着披露原文时，答完它的下一轮重建线程",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "unredacted", test: `${WORKER}/onboarding-session.test.ts`, by: "a disclosure's words leave the dialogue's thread" } },
  { id: "IR-123", layer: "L0", verdict: "return", status: "active", rule: "回复、下一步、题目和卡用了自伤字眼或披露独有的四字原话，退回；修复用完后去掉那一句",
    code: { file: `${CORE}/onboarding-pace.ts`, symbol: "disclosureEchoes", test: `${CORE}/onboarding-pace.test.ts` } },
  { id: "IR-124", layer: "L0", verdict: "keep", status: "active", rule: "谈艰难时期学到什么，只由应用的固定题征得同意，整场一次，不答或「先不聊」就整场不提",
    code: { file: `${CORE}/onboarding-pace.ts`, symbol: "lessonAnswer", test: `${CORE}/onboarding-pace.test.ts` } },
  { id: "IR-125", layer: "L2", verdict: "model", status: "active", rule: "同意之后只谈先兆、帮到的人和事、怎么缓过来的，不问不复述经过",
    text: { file: INTERVIEW_SKILL, anchor: "**本人同意以后，只谈先兆、帮到的人和事、怎么缓过来的。**" } },
  // Days, cards and the scale (2026-11-15, after replay 15 asked one day six times, retold just-made plans on cards, said one tension in
  // the reply and the card, and quoted 「5/5」).
  { id: "IR-126", layer: "L0", verdict: "return", status: "active", rule: "日期题要写 about；同一件事的日子问过、或本人说了「还没定」，再问退回",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "sameAbout", test: `${WORKER}/onboarding-cards.test.ts`, by: "a subject answered is not asked again" } },
  { id: "IR-127", layer: "L0", verdict: "return", status: "active", rule: "两个以上选项是日子的题退回，改成不带选项的 free",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "dayOption", test: `${WORKER}/onboarding-cards.test.ts`, by: "options that are days come back" } },
  { id: "IR-128", layer: "L0", verdict: "keep", status: "active", rule: "本人说还没定的日子列在进度头里，沿用叫法",
    code: { file: `${WORKER}/onboarding-standing.ts`, symbol: "undecided", test: `${WORKER}/onboarding-standing.test.ts`, by: "days the person said are not set are listed" } },
  { id: "IR-129", layer: "L2", verdict: "model", status: "active", rule: "日期题的 about 写这个日子属于哪件事，用本人的叫法",
    text: { file: INTERVIEW_SKILL, anchor: "**日期题的 `about` 写这个日子属于哪件事**" } },
  { id: "IR-130", layer: "L0", verdict: "return", status: "active", rule: "卡的引文全在最近两条回答里，退回",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "recentReplies", test: `${WORKER}/onboarding-cards.test.ts`, by: "a card joins what was said at different times" } },
  { id: "IR-131", layer: "L0", verdict: "return", status: "active", rule: "同一阶段出过三张卡，再出的卡不写 why 退回",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "STAGE_CARDS", test: `${WORKER}/onboarding-cards.test.ts`, by: "a stage's fourth card says what it adds" } },
  { id: "IR-132", layer: "L2", verdict: "model", status: "active", rule: "卡至少引一条更早的回答，第四张起说它多说了什么",
    text: { file: INTERVIEW_SKILL, anchor: "**卡至少引一条更早的回答。**" } },
  { id: "IR-133", layer: "L0", verdict: "return", status: "active", rule: "回复和旁边的卡共有十五字以上的同一段话，退回",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "sharedRun", test: `${WORKER}/onboarding-session.test.ts`, by: "a reply saying what the card beside it says goes back once" } },
  { id: "IR-134", layer: "L2", verdict: "model", status: "active", rule: "回复说卡之外的东西，或直接问",
    text: { file: INTERVIEW_SKILL, anchor: "**`reply` 不说卡上已经说的。**" } },
  { id: "IR-135", layer: "L0", verdict: "keep", status: "active", rule: "对话读量表只读读数，点选的分数换成占位",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "withoutTaps", test: `${WORKER}/onboarding-session.test.ts`, by: "reads the scale as readings, never taps" } },
  { id: "IR-136", layer: "L0", verdict: "return", status: "active", rule: "回复、下一步和卡报量表分数或档位，退回",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "SCORE_TALK", test: `${WORKER}/onboarding-session.test.ts`, by: "a reply quoting scores goes back" } },
  { id: "IR-137", layer: "L2", verdict: "model", status: "active", rule: "说量表只说倾向在日子里怎么表现",
    text: { file: INTERVIEW_SKILL, anchor: "**说量表只说这个倾向在本人的日子里怎么表现，不写「n/5」「自评」「最重那一档」**" } },
  { id: "IR-138", layer: "L2", verdict: "model", status: "active", rule: "整理不把本人定下的安排写成假设",
    text: { file: EXTRACT_SKILL, anchor: "**安排不是假设。**" } },
  // Pacing (2026-11-15, the owner: no stage budget; the dialogue proposes a next step every round and is told whether it was taken).
  { id: "IR-139", layer: "L0", verdict: "return", status: "active", rule: "问话的一轮 next 为空，退回",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "next 是空的", test: `${WORKER}/onboarding-session.test.ts`, by: "a round that asks proposes its next step" } },
  { id: "IR-140", layer: "L0", verdict: "keep", status: "active", rule: "下一轮的进度头说上轮的下一步本人按了「好，往下」还是写了自己的话",
    code: { file: `${CORE}/onboarding-pace.ts`, symbol: "nextTaken", test: `${WORKER}/onboarding-session.test.ts`, by: "the next round is told whether the person took it" } },
  { id: "IR-141", layer: "L0", verdict: "keep", status: "active", rule: "进度头列最近几次整理记下的事实条数，连续为零时注明，只作事实",
    code: { file: `${WORKER}/onboarding-standing.ts`, symbol: "SATURATED_RUNS", test: `${WORKER}/onboarding-standing.test.ts`, by: "how much the latest extractions found" } },
  { id: "IR-142", layer: "L0", verdict: "keep", status: "active", rule: "开始标准齐了，页面在「结束并出报告」旁提示一次",
    code: { file: "apps/web/app/onboarding/finish-button.tsx", symbol: "shouldRemindStart", test: "apps/web/app/onboarding/interview-sidebar.test.tsx" } },
  { id: "IR-143", layer: "L2", verdict: "model", status: "active", rule: "next 提议下一个步骤，不是下一个阶段",
    text: { file: INTERVIEW_SKILL, anchor: "**是下一个步骤，不是下一个阶段。**" } },
  { id: "IR-144", layer: "L2", verdict: "model", status: "active", rule: "本人没按上轮的下一步，先接住本人的话，下一轮再提",
    text: { file: INTERVIEW_SKILL, anchor: "**上轮提议的下一步本人没按，先接住本人的话。**" } },
  { id: "IR-145", layer: "L2", verdict: "model", status: "active", rule: "说过的张力记进 progress.said，不再换说法再说",
    text: { file: INTERVIEW_SKILL, anchor: "`said`（已经对本人说过的张力和模式" } },
  // The Skill split (2026-11-15): a resident core of fifteen rules, and each stage's checklist sent by code with the stage.
  { id: "IR-146", layer: "L0", verdict: "keep", status: "active", rule: "当前阶段的清单（stages/<stage>.md）在阶段变了或线程重建时随这一轮发给对话",
    code: { file: `${WORKER}/onboarding-session.ts`, symbol: "stageGuide", test: `${WORKER}/onboarding-session.test.ts`, by: "each stage's checklist goes with the round that starts in it" } },
  // The right column's pictures (2026-11-15, step 5): each draws only what the record holds; the cards' readings come back in words.
  { id: "IR-147", layer: "L0", verdict: "keep", status: "active", rule: "量表读数在画像图上交还本人：每个计分维度一个偏高、中等或偏低，从不显示分数",
    code: { file: `${CORE}/profile-claims.ts`, symbol: "instrumentLevels", test: `${CORE}/profile-claims.test.ts`, by: "the person's page gets each scored dimension's level in words" } },
  { id: "IR-148", layer: "L0", verdict: "keep", status: "active", rule: "假设看板按证据把假设分成已支持、待定、已推翻三栏",
    code: { file: "apps/web/app/onboarding/story-views.tsx", symbol: "boardColumns", test: "apps/web/app/onboarding/story-views.test.tsx", by: "the board sorts the hypotheses by where the evidence left them" } },
  { id: "IR-149", layer: "L0", verdict: "keep", status: "active", rule: "D8 画成生命线：主题、按记录顺序的转折和本人说的下一章；没有内容时说会画什么",
    code: { file: "apps/web/app/onboarding/story-views.tsx", symbol: "LifelineView", test: "apps/web/app/onboarding/story-views.test.tsx", by: "the lifeline draws only what the record holds" } },
  { id: "IR-150", layer: "L0", verdict: "keep", status: "active", rule: "D9 维持循环画成一个圈：没被推翻的 D9 假设至少两条，最后一步回到第一步",
    code: { file: "apps/web/app/onboarding/story-views.tsx", symbol: "LoopView", test: "apps/web/app/onboarding/story-views.test.tsx", by: "the loop draws the unrefuted D9 steps round a circle" } },
  // Replay 16 (2026-11-16): IR-123 sent five of twelve rounds back for words that were not the disclosure.
  { id: "IR-151", layer: "L0", verdict: "keep", status: "active", rule: "披露原话只按本人自己打的字比：回复里有自伤的句子时只比那几句，安全回应之后那条回复只比自伤的句子；题面、选项和访谈者自己的话都算普通的话",
    code: { file: `${CORE}/onboarding-pace.ts`, symbol: "disclosureWords", test: `${CORE}/onboarding-pace.test.ts`, by: "a disclosure is compared by the person's own words where it is" } },
  // Replay 16's follow-ups (2026-11-16).
  { id: "IR-152", layer: "L2", verdict: "model", status: "active", rule: "next 只提对话做得到的事，不许诺把这一周排出来；本人要看一周，请本人看右栏的周草稿",
    text: { file: INTERVIEW_SKILL, anchor: "**`next` 只提对话做得到的事：聊什么、问什么、请本人看右栏的哪张图。**" } },
  { id: "IR-153", layer: "L2", verdict: "model", status: "active", rule: "观察卡说一个判断，不以「也可能只是……」收尾；另一种解释写进证伪条件，只有一条回复的直接问是哪一种",
    text: { file: INTERVIEW_SKILL, anchor: "**说一个判断，不两头下注：**" } },
  { id: "IR-154", layer: "L2", verdict: "model", status: "active", rule: "本人说想先开始用：没齐时第一句说还差哪几样、只问这几样、不出观察卡；齐了就说可以按结束",
    text: { file: INTERVIEW_SKILL, anchor: "**本人说想先开始用（进度头会写）：**" } },
  { id: "IR-155", layer: "L0", verdict: "keep", status: "active", rule: "本人这一轮用自己的话说想先开始用：这一轮不放量表卡，进度头写明；开始只差卡片题时照放（2026-11-17）",
    code: { file: "apps/worker/src/onboarding-session.ts", symbol: "holdCardsForStart", test: "apps/worker/src/onboarding-session.test.ts", by: "a person who says they want to start gets no rating card that round" } },
  { id: "IR-156", layer: "L0", verdict: "keep", status: "active", rule: "JSON 回答里没转义的引号按文字转义；解析不了时日志只记位置、长度和是否在打转，不记内容",
    code: { file: "packages/codex/src/json-repair.ts", symbol: "MAX_QUOTE_EDITS", test: "packages/codex/src/json-repair.test.ts", by: "a quote inside a text left unescaped is escaped" } },
  { id: "IR-157", layer: "L0", verdict: "keep", status: "active", rule: "画像三次都解析不了时换新线程重写一次，再失败才 blocked",
    code: { file: "apps/worker/src/portrait-writer.ts", symbol: "portrait.fresh_retry", test: "apps/worker/src/portrait-writer.test.ts", by: "written again once in a fresh thread" } },
  // 2026-11-17, the owner: where a rule held back the model's judgement, follow-up or synthesis, give it the information and the aim
  // instead. The deterministic checks (quotes, URLs, dates, approvals) stay.
  { id: "IR-158", layer: "L0", verdict: "model", status: "retired", rule: "假设日志还有候选时退回对话自己的新推断，新推断一轮最多一张",
    code: { file: `${WORKER}/onboarding-cards.ts`, symbol: "新推断等候选用完" },
    reason: "对话读得到整场回答，整理的候选只是其中一部分；挡掉它自己的推断等于限制综合。候选改为给对话的材料，日志有没有被问到由回放看", replacedBy: "IR-159" },
  { id: "IR-159", layer: "L2", verdict: "model", status: "active", rule: "cardFrom 是证据已齐的候选，对话自己的推断更站得住时照样出卡",
    text: { file: INTERVIEW_SKILL, anchor: "**自己的推断比剩下的候选更站得住时就出，不必等候选用完。**" } },
  { id: "IR-160", layer: "L2", verdict: "model", status: "active", rule: "动机和原因可以从话、行为和数据外推，写最有把握的那个、依据和把握；不否定本人说过的原因",
    text: { file: INTERVIEW_SKILL, anchor: "**推断是补充，不是替换；原因可以推，要写把握。**" } },
  { id: "IR-161", layer: "L2", verdict: "model", status: "active", rule: "一轮问几题由对话按本人的回答和状态判断，应用只管五题的上限",
    text: { file: INTERVIEW_SKILL, anchor: "**一轮问几题由你判断：**" } },
  // Replay 17 (2026-11-17): the cards held from a person who wanted to start were the only item the start lacked.
  { id: "IR-162", layer: "L2", verdict: "model", status: "active", rule: "本人想开始而开始只差卡片题：说答完右侧卡片就能开始，不另出题，不用自己的话复述卡片题",
    text: { file: INTERVIEW_SKILL, anchor: "**只差画像卡片题时**" } },
  // 2026-11-17, the owner: make the observation cards more accurate. Information and aims from replays 17–18, not a new gate.
  { id: "IR-163", layer: "L2", verdict: "model", status: "active", rule: "一张卡一个论断；出卡前拿整场记录核对反例和本人给过的原因；说行为的条件，不评人；结论的范围和证据一样大",
    text: { file: INTERVIEW_SKILL, anchor: "**「准」从哪来。**" } },
  { id: "IR-164", layer: "L4", verdict: "model", status: "active", rule: "假设只说依据盖得住的范围，一条一个论断；查反例，不写「一直」；本人给过的原因之外才写更深一层",
    text: { file: EXTRACT_SKILL, anchor: "**`statement` 只说 `basis` 盖得住的范围，一条一个论断。**" } },
];
/* i18n-ignore-end */
